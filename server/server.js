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

function authHttp(req, res, next) {
  if (tokenOk(req.header('x-ubika-token'))) return next();
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
      magnet: v.magnet || null,
      installId: v.installId || null,
      downloadAvailable: Boolean(v.downloadAvailable),
    })) : [],
    installed: Boolean(game.installed),
  };
}

async function rawgEnrich(game) {
  if (!RAWG_API_KEY || !game?.title) return game;
  if (game.coverUrl && game.description && game.description !== 'Sem descrição disponível.') return game;

  const key = game.title.toLowerCase().trim();
  if (!rawgCache.has(key)) {
    rawgCache.set(key, axios.get('https://api.rawg.io/api/games', {
      params: { key: RAWG_API_KEY, search: game.title, page_size: 1 },
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
    coverUrl: game.coverUrl || r.background_image || FALLBACK_COVER,
    description: game.description && game.description !== 'Sem descrição disponível.'
      ? game.description
      : (r.description_raw || 'Sem descrição disponível.'),
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
});

// ------------------------- Socket.io -------------------------
io.on('connection', (socket) => {
  log(`[SOCKET] connect id=${socket.id} ip=${socket.handshake.address}`);

  if (!socketTokenOk(socket)) {
    log(`[SOCKET] token inválido id=${socket.id}`);
    socket.emit('server_error', { error: 'UNAUTHORIZED' });
    socket.disconnect(true);
    return;
  }

  // Mobiles/PCs que já trazem userId na query entram direto na sala do usuário.
  // (o app Android nunca chama registrar_android explicitamente — só seta a query)
  const queryUserId = String(socket.handshake.query?.userId || '').trim();
  if (queryUserId) {
    socket.data.userId = queryUserId;
    socket.data.role = socket.handshake.query.device === 'pc' ? 'pc' : 'android';
    socket.join(`user:${queryUserId}`);
    if (socket.data.role !== 'pc') androidSockets.set(socket.id, queryUserId);
  }

  socket.on('registrar_pc', (data, ack) => {
    const userId = String(data?.userId || '').trim();
    if (!userId) {
      const response = { ok: false, error: 'USER_ID_REQUIRED' };
      ack?.(response);
      return;
    }

    removePcBySocket(socket.id);
    const old = pcSockets.get(userId);
    if (old && old.socketId !== socket.id) {
      io.sockets.sockets.get(old.socketId)?.disconnect(true);
    }

    const deviceId = String(data?.deviceId || socket.id);
    const streamHost = String(data?.streamHost || process.env.DEFAULT_STREAM_HOST || '').trim();
    pcSockets.set(userId, { socketId: socket.id, deviceId, streamHost, lastSeen: Date.now() });
    socket.data.role = 'pc';
    socket.data.userId = userId;

    log(`[PC] registrado user=${userId} socket=${socket.id} device=${deviceId} streamHost=${streamHost || 'n/a'}`);
    socket.join(`user:${userId}`);
    ack?.({ ok: true, userId, socketId: socket.id, streamHost });
    io.to(`user:${userId}`).emit('pc_status', { userId, online: true, streamHost });
  });

  socket.on('registrar_android', (data, ack) => {
    const userId = String(data?.userId || '').trim();
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
    const userId = String(data?.userId || socket.data.userId || '');
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
    androidSockets.delete(socket.id);
    removePcBySocket(socket.id);
    log(`[SOCKET] disconnect id=${socket.id} reason=${reason}`);
  });
});

// ------------------------- HTTP -------------------------
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    pcsOnline: [...pcSockets.entries()].map(([userId, pc]) => ({ userId, ...pc })),
    rawgConfigured: Boolean(RAWG_API_KEY),
    authEnabled: Boolean(UBIKA_SHARED_SECRET),
  });
});

app.get('/api/pc/status', authHttp, (req, res) => {
  const userId = String(req.query.userId || DEFAULT_USER_ID);
  const pc = getPc(userId);
  res.json({ ok: true, userId, online: Boolean(pc), streamHost: pc?.streamHost || '' });
});

app.get('/api/debug/pcs', authHttp, (req, res) => {
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
    const past = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
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
  const userId = String(req.query.userId || DEFAULT_USER_ID).trim();
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
  const userId = String(req.body?.userId || DEFAULT_USER_ID).trim();
  const action = String(req.body?.action || '').trim();
  const payload = req.body?.payload && typeof req.body.payload === 'object' ? req.body.payload : {};
  const allowed = new Set([
    'launch_game', 'stop_game', 'refresh_library', 'ping', 'status',
    'iniciar_download', 'listar_downloads', 'pausar_download',
    'retomar_download', 'remover_download', 'sync_sources',
    'status_stream', 'instalar_stream_setup',
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

app.get('/api/stream', authHttp, (req, res) => {
  const userId = String(req.query.userId || DEFAULT_USER_ID).trim();
  const pc = getPc(userId);
  if (!pc) return res.status(503).json({ ok: false, error: 'PC_OFFLINE' });
  res.json({
    ok: true,
    userId,
    host: pc.streamHost,
    instructions: 'Use Moonlight para emparelhar com o Sunshine nesse host. A AWS não transporta o vídeo.',
  });
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
