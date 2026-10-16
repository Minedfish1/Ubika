require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const RAWG_API_KEY = process.env.RAWG_API_KEY || '';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID || 'utilizador_teste_123';
const UBIKA_SHARED_SECRET = process.env.UBIKA_SHARED_SECRET || '';
const PC_TIMEOUT_MS = Number.parseInt(process.env.PC_TIMEOUT_MS, 10) || 15000;
const PC_COMMAND_TIMEOUT = Number.parseInt(process.env.PC_COMMAND_TIMEOUT_MS, 10) || 30000;
const TRENDING_TTL_MS = Number.parseInt(process.env.TRENDING_TTL_MS, 10) || 10 * 60 * 1000;
const FALLBACK_COVER = process.env.FALLBACK_COVER || 'https://i.imgur.com/vHq0rDk.png';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 5 * 1024 * 1024,
});

const db = new sqlite3.Database(process.env.SQLITE_PATH || './ubika_cloud.db');
const pcSockets = new Map(); // userId -> { socketId, deviceId, streamHost, lastSeen }
const androidSockets = new Map(); // socketId -> userId
const rawgCache = new Map();
let trendingCache = { games: [], ts: 0 };

const log = (...args) => console.log(new Date().toISOString(), ...args);
const makeRequestId = () => crypto.randomUUID();

process.on('uncaughtException', (err) => log('FATAL uncaughtException', err?.stack || err));
process.on('unhandledRejection', (err) => log('FATAL unhandledRejection', err?.stack || err));

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => log(`[HTTP] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`));
  next();
});

function tokenOk(token) {
  return !UBIKA_SHARED_SECRET || token === UBIKA_SHARED_SECRET;
}

/** Aceita o segredo compartilhado (daemon/legado) OU sessão válida (app novo). */
async function authHttp(req, res, next) {
  if (tokenOk(req.header('x-ubika-token'))) return next();
  const sess = String(req.header('x-ubika-session') || req.query.session || req.body?.session || '');
  if (sess) {
    const s = await dbGet('SELECT userId FROM sessions WHERE token = ?', sess).catch(() => null);
    if (s) { req.ubikaUserId = s.userId; return next(); }
  }
  return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
}

function socketTokenOk(socket) {
  if (!UBIKA_SHARED_SECRET) return true;
  return socket.handshake.auth?.token === UBIKA_SHARED_SECRET;
}

function getPc(userId) {
  const entry = pcSockets.get(userId);
  if (!entry) return null;
  const socket = io.sockets.sockets.get(entry.socketId);
  if (!socket) {
    pcSockets.delete(userId);
    return null;
  }
  return { socket, ...entry };
}

function sanitizeGame(game, page, index) {
  return {
    id: String(game.id ?? `${page}-${index}`),
    title: String(game.title ?? 'Sem título'),
    coverUrl: game.coverUrl || FALLBACK_COVER,
    description: game.description || 'Sem descrição disponível.',
    versions: Array.isArray(game.versions) ? game.versions.map(v => ({
      source: v.source || 'local',
      size: v.size || 'Desconhecido',
      magnet: v.magnet || '',
      links: Array.isArray(v.links) ? v.links.filter(l => typeof l === 'string').slice(0, 8) : [],
      installId: v.installId || null,
      downloadAvailable: Boolean(v.downloadAvailable),
    })) : [],
    installed: Boolean(game.installed),
  };
}

/** Remove o lixo do nome do repack (versão, DLCs, MULTi) antes de buscar no RAWG. */
function cleanTitle(title) {
  let t = String(title || '');
  t = t.replace(/\([^)]*\)/g, ' ');
  t = t.replace(/\[[^\]]*\]/g, ' ');
  t = t.replace(/\s[–—-]\s*v?\d[\d.]*\b/gi, ' ');
  t = t.replace(/\+\s*\d+\s*DLCs?\*?/gi, ' ');
  t = t.replace(/\bMULTi\w*\b/gi, ' ');
  t = t.replace(/\bv?\d+\.\d+(\.\d+)*\b/gi, ' ');
  t = t.replace(/\bbuild\s*\d+\b/gi, ' ');
  t = t.replace(/[*©®™]/g, ' ');
  return t.replace(/\s{2,}/g, ' ').trim() || String(title || '');
}

async function rawgEnrich(game) {
  if (!RAWG_API_KEY || !game?.title) return game;
  // FALLBACK_COVER não conta como capa real — antes ela vencia a imagem do RAWG
  const hasCover = Boolean(game.coverUrl) && game.coverUrl !== FALLBACK_COVER;
  const hasDesc = Boolean(game.description) && game.description !== 'Sem descrição disponível.';
  if (hasCover && hasDesc) return game;

  const searchTitle = cleanTitle(game.title);
  const key = searchTitle.toLowerCase();
  if (rawgCache.size > 5000) rawgCache.clear(); // evita crescer sem limite
  if (!rawgCache.has(key)) {
    rawgCache.set(key, axios.get('https://api.rawg.io/api/games', {
      params: { key: RAWG_API_KEY, search: searchTitle, page_size: 1 },
      timeout: 5000,
    }).then(r => r.data?.results?.[0] || null).catch(err => {
      log(`[RAWG] ${game.title}: ${err.message}`);
      return null;
    }));
  }

  const r = await rawgCache.get(key);
  if (!r) return game;
  return {
    ...game,
    coverUrl: hasCover ? game.coverUrl : (r.background_image || FALLBACK_COVER),
    description: hasDesc ? game.description : (r.description_raw || 'Sem descrição disponível.'),
  };
}

function requestPc(userId, event, payload, timeoutMs = PC_TIMEOUT_MS) {
  const target = getPc(userId);
  if (!target) {
    const err = new Error(`PC_OFFLINE: ${userId}`);
    err.status = 503;
    return Promise.reject(err);
  }

  const requestId = makeRequestId();
  log(`[PC->REQ] user=${userId} event=${event} requestId=${requestId}`);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`PC_TIMEOUT: ${userId} não respondeu em ${timeoutMs}ms`);
      err.status = 504;
      log(`[PC->TIMEOUT] user=${userId} event=${event} requestId=${requestId}`);
      reject(err);
    }, timeoutMs);

    target.socket.emit(event, { ...payload, requestId }, (response) => {
      clearTimeout(timer);
      if (!response) {
        const err = new Error('PC_EMPTY_ACK');
        err.status = 502;
        reject(err);
        return;
      }
      log(`[PC->ACK] user=${userId} event=${event} requestId=${requestId} ok=${response.ok !== false}`);
      resolve(response);
    });
  });
}

function removePcBySocket(socketId) {
  for (const [userId, value] of pcSockets.entries()) {
    if (value.socketId === socketId) {
      pcSockets.delete(userId);
      log(`[PC] removido user=${userId} socket=${socketId}`);
      io.to(`user:${userId}`).emit('pc_status', { userId, online: false });
    }
  }
}

// ------------------------- DB -------------------------
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    email TEXT,
    plan TEXT DEFAULT 'Free',
    balance REAL DEFAULT 0.0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER,
    amount REAL,
    method TEXT,
    status TEXT,
    date TEXT
  )`);
  // Auth real: userId público (uuid) usado nas salas/registros de PC
  db.run(`CREATE TABLE IF NOT EXISTS accounts (
    userId TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    passHash TEXT NOT NULL,
    salt TEXT NOT NULL,
    plan TEXT DEFAULT 'trial',
    trialEndsAt INTEGER,
    createdAt INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  )`);
  // Renovação de plano: timestamp até quando o PRO vale (null no pro = vitalício/admin)
  db.run(`ALTER TABLE accounts ADD COLUMN planExpiresAt INTEGER`, () => {});
  // Checkout web externo: o app abre /checkout/<sid> no navegador
  db.run(`CREATE TABLE IF NOT EXISTS checkouts (
    sid TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    plan TEXT NOT NULL,
    amountCents INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    createdAt INTEGER NOT NULL,
    paidAt INTEGER
  )`);
});

// PCs aguardando pareamento: code -> { socketId, deviceId, streamHost, expiresAt }
const pendingPcs = new Map();
const PAIR_TTL_MS = 10 * 60 * 1000;

const dbGet = (sql, ...args) => new Promise((res, rej) => db.get(sql, args, (e, r) => e ? rej(e) : res(r)));
const dbRun = (sql, ...args) => new Promise((res, rej) => db.run(sql, args, function (e) { return e ? rej(e) : res(this); }));

// Rate limit simples em memória: 15 req por 5min por IP nas rotas sensíveis
const rateBuckets = new Map();
function rateLimit(max = 15, windowMs = 5 * 60 * 1000) {
  return (req, res, next) => {
    const key = `${req.ip}|${req.path}`;
    const now = Date.now();
    const arr = (rateBuckets.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ ok: false, error: 'MUITAS_TENTATIVAS' });
    arr.push(now); rateBuckets.set(key, arr);
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, a] of rateBuckets) { const f = a.filter(t => now - t < 600000); if (!f.length) rateBuckets.delete(k); else rateBuckets.set(k, f); } }, 60000).unref?.();

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await dbRun('INSERT INTO sessions (token, userId, createdAt) VALUES (?,?,?)', token, userId, Date.now());
  return token;
}

/**
 * userId do request: sessão válida manda; sem sessão só aceita userId legado se o
 * chamador tem o segredo compartilhado (daemon/legado). Senão → null (401).
 */
async function resolveUserId(req) {
  if (req.ubikaUserId) return req.ubikaUserId;
  const token = String(req.header('x-ubika-session') || req.query.session || req.body?.session || '');
  if (token) {
    const s = await dbGet('SELECT userId FROM sessions WHERE token = ?', token).catch(() => null);
    return s ? s.userId : null;
  }
  if (tokenOk(req.header('x-ubika-token'))) {
    const legacy = String(req.query.userId || req.body?.userId || '').trim();
    return legacy || DEFAULT_USER_ID;
  }
  return null;
}

/** IP público de quem conectou — é o endereço que o celular usa para o stream direto. */
function clientIp(socket) {
  const raw = String(socket.handshake.address || socket.request?.connection?.remoteAddress || '');
  return raw.replace(/^::ffff:/, '').trim();
}

function registerPc(userId, socket, data) {
  removePcBySocket(socket.id);
  const old = pcSockets.get(userId);
  if (old && old.socketId !== socket.id) {
    io.sockets.sockets.get(old.socketId)?.disconnect(true);
  }
  const deviceId = String(data?.deviceId || socket.id);
  // streamHost = IP público do PC visto pela VPS; lanHost = IP de LAN p/ uso na mesma rede
  const streamHost = clientIp(socket) || process.env.DEFAULT_STREAM_HOST || '';
  const lanHost = String(data?.lanIp || '').trim();
  pcSockets.set(userId, { socketId: socket.id, deviceId, streamHost, lanHost, lastSeen: Date.now() });
  socket.data.role = 'pc';
  socket.data.userId = userId;
  socket.join(`user:${userId}`);
  log(`[PC] registrado user=${userId} socket=${socket.id} device=${deviceId} publicIp=${streamHost} lan=${lanHost || 'n/a'}`);
  io.to(`user:${userId}`).emit('pc_status', { userId, online: true, streamHost, lanHost });
  return { deviceId, streamHost };
}

// ------------------------- Socket.io -------------------------
// Handshake: segredo compartilhado (daemon PC/legado) OU token de sessão (app).
io.use(async (socket, next) => {
  if (socketTokenOk(socket)) return next();
  const sess = String(socket.handshake.auth?.session || socket.handshake.auth?.token || '');
  if (!sess) return next(new Error('UNAUTHORIZED'));
  const s = await dbGet('SELECT userId FROM sessions WHERE token = ?', sess).catch(() => null);
  if (!s) return next(new Error('UNAUTHORIZED'));
  socket.data.sessionUserId = s.userId;
  next();
});

io.on('connection', (socket) => {
  log(`[SOCKET] connect id=${socket.id} ip=${socket.handshake.address}`);

  // Sessão autenticada manda no userId — cliente não pode se passar por outro.
  const sessionUserId = socket.data.sessionUserId;
  const queryUserId = String(socket.handshake.query?.userId || '').trim();
  const effectiveUserId = sessionUserId || (socketTokenOk(socket) ? queryUserId : '');
  if (effectiveUserId) {
    socket.data.userId = effectiveUserId;
    socket.data.role = sessionUserId ? 'android' : (socket.handshake.query.device === 'pc' ? 'pc' : 'android');
    socket.join(`user:${effectiveUserId}`);
    if (socket.data.role !== 'pc') androidSockets.set(socket.id, effectiveUserId);
  }

  socket.on('registrar_pc', (data, ack) => {
    // Sessão autenticada só registra PC na própria conta — o daemon (segredo
    // compartilhado) segue podendo informar o userId pareado no .env.
    const userId = String(socket.data.sessionUserId || data?.userId || '').trim();
    const pairCode = String(data?.pairCode || '').trim();

    // Código sempre ativo: o PC rotaciona (~9min) e re-registra — parear funciona
    // mesmo já pareado (novo aparelho/troca de conta) e sobrevive a restart da VPS.
    if (pairCode) {
      pendingPcs.set(pairCode, {
        socketId: socket.id,
        deviceId: String(data?.deviceId || socket.id),
        lanIp: String(data?.lanIp || '').trim(),
        expiresAt: Date.now() + PAIR_TTL_MS,
      });
      if (!userId) {
        socket.data.role = 'pc_pending';
        log(`[PC] aguardando pareamento code=${pairCode} socket=${socket.id}`);
        return ack?.({ ok: true, pending: true, pairCode, ttlMs: PAIR_TTL_MS });
      }
    }

    if (!userId) {
      const response = { ok: false, error: 'USER_ID_REQUIRED' };
      ack?.(response);
      return;
    }

    const { deviceId, streamHost } = registerPc(userId, socket, data);
    ack?.({ ok: true, userId, socketId: socket.id, streamHost, deviceId });
  });

  socket.on('registrar_android', (data, ack) => {
    const userId = String(socket.data.userId || data?.userId || '').trim();
    if (!userId) return ack?.({ ok: false, error: 'USER_ID_REQUIRED' });
    androidSockets.set(socket.id, userId);
    socket.data.role = 'android';
    socket.data.userId = userId;
    socket.join(`user:${userId}`);
    log(`[ANDROID] registrado user=${userId} socket=${socket.id}`);
    ack?.({ ok: true, userId, pcOnline: Boolean(getPc(userId)) });
  });

  socket.on('pc_heartbeat', (data) => {
    const userId = socket.data.userId || data?.userId;
    if (!userId) return;
    const pc = pcSockets.get(userId);
    if (pc?.socketId === socket.id) pc.lastSeen = Date.now();
  });

  socket.on('progresso_download', (data) => {
    const userId = socket.data.userId || data?.userId;
    if (!userId) return;
    log(`[PROGRESS] user=${userId} game=${data?.gameName || '-'} progress=${data?.progress ?? '-'}%`);
    socket.to(`user:${userId}`).emit('download_progress', { ...data, userId });
  });

  // Daemon Node emite com este nome; mesma retransmissão para a sala do usuário
  socket.on('download_progress', (data) => {
    const userId = socket.data.userId || data?.userId;
    if (!userId) return;
    socket.to(`user:${userId}`).emit('download_progress', { ...data, userId });
  });

  // App -> VPS -> PC : encaminha comando e devolve o ack do PC ao app
  socket.on('send_to_pc', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    // userId do socket (autenticado) tem prioridade — impede comandar PC de outro usuário
    const userId = String(socket.data.userId || data?.userId || '');
    const payload = data?.payload || {};
    if (!userId) return reply({ ok: false, error: 'MISSING_USER_ID' });

    const target = getPc(userId);
    if (!target) {
      log(`[CMD] user=${userId} action=${payload?.action} -> PC_OFFLINE`);
      return reply({ ok: false, error: 'PC_OFFLINE' });
    }
    target.socket.timeout(PC_COMMAND_TIMEOUT).emit('executar_comando', payload, (err, resp) => {
      if (err) {
        log(`[CMD] timeout user=${userId} action=${payload?.action}`);
        return reply({ ok: false, error: 'PC_TIMEOUT' });
      }
      reply(resp || { ok: false, error: 'EMPTY_ACK' });
    });
  });

  socket.on('disconnect', (reason) => {
    const wasAndroid = androidSockets.get(socket.id);
    androidSockets.delete(socket.id);
    // Último app do usuário saiu → avisa o PC para restaurar o display
    if (wasAndroid && ![...androidSockets.values()].includes(wasAndroid)) {
      const pc = getPc(wasAndroid);
      if (pc) {
        pc.socket.emit('cliente_offline', { userId: wasAndroid });
        log(`[ANDROID] último app saiu user=${wasAndroid} → cliente_offline ao PC`);
      }
    }
    removePcBySocket(socket.id);
    for (const [c, p] of pendingPcs) if (p.socketId === socket.id) pendingPcs.delete(c);
    log(`[SOCKET] disconnect id=${socket.id} reason=${reason}`);
  });
});

// ------------------------- HTTP -------------------------
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    // Só quantidade — userIds/streamHosts não são dados públicos
    pcsOnline: pcSockets.size,
    pendingPair: pendingPcs.size,
    rawgConfigured: Boolean(RAWG_API_KEY),
    authEnabled: Boolean(UBIKA_SHARED_SECRET),
  });
});

// ------------------------- Auth -------------------------
app.post('/api/auth/register', rateLimit(10), async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ ok: false, error: 'EMAIL_INVALIDO' });
  if (password.length < 6) return res.status(400).json({ ok: false, error: 'SENHA_CURTA_MIN_6' });

  try {
    const exists = await dbGet('SELECT userId FROM accounts WHERE email = ?', email);
    if (exists) return res.status(409).json({ ok: false, error: 'EMAIL_JA_CADASTRADO' });

    const userId = crypto.randomUUID();
    const salt = crypto.randomBytes(16).toString('hex');
    const passHash = hashPassword(password, salt);
    const trialEndsAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 dias
    await dbRun(
      'INSERT INTO accounts (userId, email, passHash, salt, plan, trialEndsAt, createdAt) VALUES (?,?,?,?,?,?,?)',
      userId, email, passHash, salt, 'trial', trialEndsAt, Date.now()
    );
    const token = await createSession(userId);
    log(`[AUTH] registrado user=${userId} email=${email}`);
    res.json({ ok: true, token, userId, email, plan: 'trial', trialEndsAt });
  } catch (err) {
    log(`[AUTH] register erro: ${err.message}`);
    res.status(500).json({ ok: false, error: 'REGISTER_FAILED' });
  }
});

app.post('/api/auth/login', rateLimit(15), async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  try {
    const acc = await dbGet('SELECT * FROM accounts WHERE email = ?', email);
    if (!acc || hashPassword(password, acc.salt) !== acc.passHash) {
      return res.status(401).json({ ok: false, error: 'CREDENCIAIS_INVALIDAS' });
    }
    const token = await createSession(acc.userId);
    log(`[AUTH] login user=${acc.userId}`);
    res.json({ ok: true, token, userId: acc.userId, email: acc.email, plan: acc.plan, trialEndsAt: acc.trialEndsAt });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'LOGIN_FAILED' });
  }
});

app.get('/api/auth/me', authHttp, async (req, res) => {
  const token = String(req.header('x-ubika-session') || req.query.session || '');
  const s = token ? await dbGet('SELECT userId FROM sessions WHERE token = ?', token).catch(() => null) : null;
  if (!s) return res.status(401).json({ ok: false, error: 'SESSAO_INVALIDA' });
  const acc = await dbGet('SELECT userId, email, plan, trialEndsAt, planExpiresAt FROM accounts WHERE userId = ?', s.userId).catch(() => null);
  res.json({ ok: true, userId: s.userId, email: acc?.email, plan: acc?.plan, trialEndsAt: acc?.trialEndsAt,
    planExpiresAt: acc?.planExpiresAt ?? null, effectivePlan: effectivePlan(acc) });
});

/** Plano efetivo: pro se pago e dentro da validade (null = vitalício); trial se dentro do prazo; senão expirado. */
function effectivePlan(acc) {
  const now = Date.now();
  if (acc?.plan === 'pro' && (acc.planExpiresAt == null || acc.planExpiresAt > now)) return 'pro';
  if (acc?.trialEndsAt && acc.trialEndsAt > now) return 'trial';
  if (acc?.plan === 'pro' && acc.planExpiresAt != null && acc.planExpiresAt <= now) return 'expired';
  return acc?.plan === 'trial' && acc.trialEndsAt && acc.trialEndsAt <= now ? 'expired' : (acc?.plan || 'trial');
}

/** Pareamento: o app envia o código exibido no PC; o PC sai da fila e vira o PC do usuário. */
app.post('/api/pair', authHttp, rateLimit(15), async (req, res) => {
  const userId = await resolveUserId(req);
  if (!userId || userId === DEFAULT_USER_ID) return res.status(401).json({ ok: false, error: 'LOGIN_NECESSARIO' });
  const code = String(req.body?.code || '').trim();

  // Limpa expirados
  for (const [c, p] of pendingPcs) if (p.expiresAt < Date.now()) pendingPcs.delete(c);

  const pending = pendingPcs.get(code);
  if (!pending) return res.status(404).json({ ok: false, error: 'CODIGO_INVALIDO_OU_EXPIRADO' });
  const socket = io.sockets.sockets.get(pending.socketId);
  if (!socket) { pendingPcs.delete(code); return res.status(410).json({ ok: false, error: 'PC_DESCONECTOU' }); }

  pendingPcs.delete(code);
  const { streamHost } = registerPc(userId, socket, pending);
  socket.emit('pareado', { userId, deviceId: pending.deviceId });
  log(`[PAIR] user=${userId} code=${code} device=${pending.deviceId}`);
  res.json({ ok: true, userId, deviceId: pending.deviceId, streamHost });
});

app.get('/api/pc/status', authHttp, async (req, res) => {
  const userId = await resolveUserId(req);
  const pc = getPc(userId);
  res.json({ ok: true, userId, online: Boolean(pc), streamHost: pc?.streamHost || '', lanHost: pc?.lanHost || '' });
});

app.get('/api/debug/pcs', authHttp, async (req, res) => {
  // Só contas admin enxergam o mapa de PCs de todos os usuários
  const userId = await resolveUserId(req);
  const admins = (process.env.ADMIN_EMAILS || 'admin@gmail.com').split(',').map(s => s.trim().toLowerCase());
  const acc = userId ? await dbGet('SELECT email FROM accounts WHERE userId = ?', userId).catch(() => null) : null;
  if (!acc || !admins.includes(String(acc.email).toLowerCase())) {
    return res.status(403).json({ ok: false, error: 'ADMIN_ONLY' });
  }
  res.json({ ok: true, pcs: Object.fromEntries(pcSockets) });
});

app.get('/api/trending', authHttp, async (req, res) => {
  if (trendingCache.games.length && Date.now() - trendingCache.ts < TRENDING_TTL_MS) {
    return res.json({ ok: true, games: trendingCache.games, source: 'cache' });
  }

  if (!RAWG_API_KEY) {
    return res.json({ ok: true, games: [], source: 'disabled', error: 'RAWG_NOT_CONFIGURED' });
  }

  try {
    const now = new Date();
    const past = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const fmt = d => d.toISOString().slice(0, 10);
    const result = await axios.get('https://api.rawg.io/api/games', {
      params: { key: RAWG_API_KEY, ordering: '-added', dates: `${fmt(past)},${fmt(now)}`, page_size: 10 },
      timeout: 8000,
    });

    const games = (result.data?.results || []).map((g) => sanitizeGame({
      id: g.id,
      title: g.name,
      coverUrl: g.background_image,
      description: g.description_raw || 'Destaque popular.',
      versions: [],
      installed: false,
    }, 1, 0));

    trendingCache = { games, ts: Date.now() };
    log(`[TRENDING] ${games.length} jogos RAWG`);
    return res.json({ ok: true, games, source: 'rawg' });
  } catch (err) {
    log(`[TRENDING] erro ${err.message}`);
    if (trendingCache.games.length) return res.json({ ok: true, games: trendingCache.games, source: 'stale-cache' });
    return res.status(502).json({ ok: false, error: 'TRENDING_UNAVAILABLE', games: [] });
  }
});

app.get('/api/games', authHttp, async (req, res) => {
  const userId = await resolveUserId(req);
  const search = String(req.query.search || '').slice(0, 100);
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);

  log(`[CATALOG] user=${userId} search="${search}" page=${page}`);
  try {
    const response = await requestPc(userId, 'pedir_pesquisa_jogos', { search, page });
    if (response.ok === false) return res.status(502).json({ ok: false, error: response.error, games: [] });

    const rawGames = Array.isArray(response.games) ? response.games : [];
    const games = await Promise.all(rawGames.map((game, index) => rawgEnrich(sanitizeGame(game, page, index))));
    return res.json({ ok: true, games, isLastPage: Boolean(response.isLastPage), total: Number(response.total || 0) });
  } catch (err) {
    log(`[CATALOG] falha user=${userId}: ${err.message}`);
    return res.status(err.status || 500).json({ ok: false, error: err.message, games: [], isLastPage: true });
  }
});

app.post('/api/pc/command', authHttp, async (req, res) => {
  const userId = await resolveUserId(req);
  const action = String(req.body?.action || '').trim();
  const payload = req.body?.payload && typeof req.body.payload === 'object' ? req.body.payload : {};
  const allowed = new Set([
    'launch_game', 'stop_game', 'refresh_library', 'ping', 'status',
    'iniciar_download', 'listar_downloads', 'pausar_download',
    'retomar_download', 'remover_download', 'sync_sources',
    'status_stream', 'instalar_stream_setup',
    'preparar_stream', 'restaurar_display',
  ]);

  if (!allowed.has(action)) {
    return res.status(400).json({ ok: false, error: 'ACTION_NOT_ALLOWED', allowed: [...allowed] });
  }

  try {
    const response = await requestPc(userId, 'executar_comando', { action, ...payload });
    return res.json({ ok: response.ok !== false, ...response });
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.get('/api/stream', authHttp, async (req, res) => {
  const userId = await resolveUserId(req);
  const pc = getPc(userId);
  if (!pc) return res.status(503).json({ ok: false, error: 'PC_OFFLINE' });
  res.json({
    ok: true,
    userId,
    host: pc.streamHost,
    lanHost: pc.lanHost || '',
    instructions: 'Use Moonlight para emparelhar com o Sunshine nesse host. A VPS não transporta o vídeo — o stream é direto.',
  });
});

// ------------------------- Checkout web externo -------------------------
const PLANOS = { pro: { nome: 'UBIKA PRO', amountCents: 1990, descricao: 'Assinatura mensal' } };
const CHECKOUT_GATEWAY_URL = process.env.CHECKOUT_GATEWAY_URL || ''; // ex.: init_point do Mercado Pago
const DEV_CONFIRM = process.env.CHECKOUT_DEV_CONFIRM === '1';

/** App pede um link de pagamento → abre no navegador. */
app.post('/api/checkout', authHttp, rateLimit(10), async (req, res) => {
  const userId = await resolveUserId(req);
  if (!userId || userId === DEFAULT_USER_ID) return res.status(401).json({ ok: false, error: 'LOGIN_NECESSARIO' });
  const plano = PLANOS[String(req.body?.plan || 'pro')] || PLANOS.pro;
  const sid = crypto.randomBytes(16).toString('hex');
  try {
    await dbRun('INSERT INTO checkouts (sid, userId, plan, amountCents, createdAt) VALUES (?,?,?,?,?)',
      sid, userId, 'pro', plano.amountCents, Date.now());
    const host = `${req.protocol}://${req.get('host')}`;
    log(`[CHECKOUT] criado sid=${sid} user=${userId} plan=pro`);
    res.json({ ok: true, sid, url: `${host}/checkout/${sid}` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

async function markCheckoutPaid(sid, origem) {
  const c = await dbGet('SELECT * FROM checkouts WHERE sid = ?', sid);
  if (!c) return null;
  if (c.status !== 'paid') {
    // Renovação soma 30 dias a partir de agora ou do fim do plano atual (o que for maior)
    const acc = await dbGet('SELECT planExpiresAt FROM accounts WHERE userId = ?', c.userId).catch(() => null);
    const base = Math.max(Date.now(), acc?.planExpiresAt || 0);
    await dbRun("UPDATE checkouts SET status='paid', paidAt=? WHERE sid=?", Date.now(), sid);
    await dbRun("UPDATE accounts SET plan='pro', planExpiresAt=? WHERE userId=?", base + 30 * 24 * 60 * 60 * 1000, c.userId);
    log(`[CHECKOUT] pago sid=${sid} user=${c.userId} via ${origem} → +30d`);
  }
  return c;
}

/** Confirmação de DEV (env CHECKOUT_DEV_CONFIRM=1) — até o gateway real entrar. */
app.post('/api/checkout/:sid/confirm', async (req, res) => {
  if (!DEV_CONFIRM) return res.status(403).json({ ok: false, error: 'DEV_CONFIRM_DESLIGADO' });
  const c = await markCheckoutPaid(req.params.sid, 'dev_confirm');
  if (!c) return res.status(404).json({ ok: false, error: 'SID_INVALIDO' });
  res.json({ ok: true, status: 'paid' });
});

/** Webhook do gateway real (Mercado Pago/Stripe): validar e marcar pago. */
app.post('/api/pay/webhook', async (req, res) => {
  const secret = process.env.PAY_WEBHOOK_SECRET || '';
  if (secret && req.header('x-webhook-secret') !== secret) {
    return res.status(401).json({ ok: false });
  }
  const sid = String(req.body?.sid || req.body?.external_reference || '');
  if (!sid) return res.status(400).json({ ok: false, error: 'SID_AUSENTE' });
  const c = await markCheckoutPaid(sid, 'webhook');
  res.json({ ok: Boolean(c) });
});

/** App/página faz polling — o sid (16 bytes) já é o segredo; sem authHttp. */
app.get('/api/checkout/:sid/status', async (req, res) => {
  const c = await dbGet('SELECT status, plan FROM checkouts WHERE sid = ?', req.params.sid).catch(() => null);
  if (!c) return res.status(404).json({ ok: false, error: 'SID_INVALIDO' });
  res.json({ ok: true, status: c.status, plan: c.plan });
});

/** Página pública de pagamento — o sid na URL é o segredo. */
app.get('/checkout/:sid', async (req, res) => {
  const c = await dbGet('SELECT * FROM checkouts WHERE sid = ?', req.params.sid).catch(() => null);
  res.type('html');
  if (!c) return res.status(404).send('<h2>Sessão inválida ou expirada.</h2>');
  const plano = PLANOS[c.plan] || PLANOS.pro;
  const preco = (c.amountCents / 100).toFixed(2).replace('.', ',');
  const pago = c.status === 'paid';
  const payBtn = CHECKOUT_GATEWAY_URL
    ? `<a class="btn" href="${CHECKOUT_GATEWAY_URL.replace(/"/g, '&quot;')}">PAGAR R$ ${preco}</a>
       <p class="hint">Você será levado ao checkout seguro do parceiro de pagamento.</p>`
    : DEV_CONFIRM
      ? `<button class="btn" onclick="fetch('/api/checkout/${c.sid}/confirm',{method:'POST'}).then(r=>r.json()).then(d=>{if(d.ok)location.reload()})">PAGAR R$ ${preco} (modo teste)</button>
         <p class="hint">Gateway ainda não configurado — confirmação de teste.</p>`
      : `<p class="hint">Gateway de pagamento ainda não configurado. Fale com o suporte.</p>`;
  res.send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ubika — Checkout</title>
<style>
  body{margin:0;background:#0d0418;color:#fff;font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh}
  .card{background:#140822;border:1px solid #673AB7;border-radius:16px;padding:32px;max-width:380px;text-align:center}
  h1{color:#B39DDB;font-size:20px;letter-spacing:2px;margin:0 0 4px}
  .price{font-size:34px;font-weight:800;margin:14px 0}
  .btn{display:inline-block;background:#673AB7;color:#fff;border:0;border-radius:10px;padding:14px 28px;font-size:16px;font-weight:700;cursor:pointer;text-decoration:none;margin-top:8px}
  .hint{color:#8a7fa8;font-size:12px;margin-top:14px}
  .ok{color:#66BB6A;font-size:22px;font-weight:800}
</style></head><body><div class="card">
<h1>UBIKA</h1>
${pago
  ? '<p class="ok">✓ Pagamento confirmado!</p><p>Seu plano PRO está ativo.<br>Volte ao app.</p>'
  : `<p style="color:#8a7fa8">${plano.descricao}</p>
     <p style="font-size:18px;font-weight:700">${plano.nome}</p>
     <p class="price">R$ ${preco}<span style="font-size:14px;color:#8a7fa8">/mês</span></p>
     ${payBtn}
     <script>setInterval(()=>fetch('/api/checkout/${c.sid}/status').then(r=>r.json()).then(d=>{if(d.status==='paid')location.reload()}),4000)</script>`}
</div></body></html>`);
});

app.post('/api/pay', authHttp, (req, res) => {
  const { userId, amount, method } = req.body || {};
  if (userId === undefined || amount === undefined || !method) {
    return res.status(400).json({ ok: false, error: 'userId, amount e method são obrigatórios' });
  }
  const date = new Date().toISOString();
  db.run(
    `INSERT INTO payments (userId, amount, method, status, date) VALUES (?, ?, ?, ?, ?)`,
    [userId, amount, method, 'Aprovado', date],
    function (err) {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      db.run(`UPDATE users SET plan = 'PRO' WHERE id = ?`, [userId]);
      return res.json({ ok: true, paymentId: this.lastID });
    }
  );
});

server.listen(PORT, '0.0.0.0', () => {
  log(`🚀 Ubika Cloud em 0.0.0.0:${PORT}`);
  log(`🔐 autenticação=${Boolean(UBIKA_SHARED_SECRET)} RAWG=${Boolean(RAWG_API_KEY)}`);
});
