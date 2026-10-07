const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { io } = require('socket.io-client');

const DIR_LIBRARY = path.join(__dirname, 'library');
const USER_ID = process.env.UBIKA_USER_ID || 'utilizador_teste_123';
const DEVICE_ID = process.env.UBIKA_DEVICE_ID || `${os.hostname()}-${process.platform}`;
const SERVER_URL = process.env.UBIKA_SERVER || 'http://18.223.108.137:3000';
const SHARED_SECRET = process.env.UBIKA_SHARED_SECRET || '';
const STREAM_HOST = process.env.UBIKA_STREAM_HOST || detectLanIp();
const PAGE_SIZE = 15;
const FALLBACK_COVER = 'https://i.imgur.com/vHq0rDk.png';

const log = (...args) => console.log(new Date().toISOString(), ...args);
let biblioteca = [];
let reloadTimer = null;

function detectLanIp() {
  const interfaces = os.networkInterfaces();
  for (const list of Object.values(interfaces)) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return '';
}

function normalizarTexto(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[._-]/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function ensureLibrary() {
  if (!fs.existsSync(DIR_LIBRARY)) fs.mkdirSync(DIR_LIBRARY, { recursive: true });
}

function loadLibrary() {
  ensureLibrary();
  const started = Date.now();
  const next = [];
  const files = fs.readdirSync(DIR_LIBRARY).filter(f => f.toLowerCase().endsWith('.json'));

  for (const file of files) {
    try {
      const full = path.join(DIR_LIBRARY, file);
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      const list = Array.isArray(data) ? data : Array.isArray(data?.games) ? data.games : Array.isArray(data?.downloads) ? data.downloads : null;
      if (!list) {
        log(`[LIB] ${file}: formato ignorado (esperado array/games/downloads)`);
        continue;
      }

      let valid = 0;
      for (const item of list) {
        const title = String(item?.title || item?.name || '').replace(/\./g, ' ').trim();
        if (!title) continue;
        next.push({
          id: String(item.id || `${file}:${valid}`),
          title,
          titleNorm: normalizarTexto(title),
          size: item.fileSize || item.size || 'Desconhecido',
          date: item.uploadDate || item.releaseDate || '',
          source: String(item.source || path.basename(file, '.json')),
          coverUrl: item.coverUrl || item.cover || item.image || null,
          description: item.description || null,
          installed: Boolean(item.installed),
          installId: item.installId || null,
          downloadAvailable: Boolean(item.downloadAvailable),
        });
        valid++;
      }
      log(`[LIB] ${file}: ${valid} itens válidos`);
    } catch (err) {
      log(`[LIB] ${file}: JSON inválido: ${err.message}`);
    }
  }

  next.sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.title.localeCompare(b.title));
  biblioteca = next;
  log(`[LIB] ${biblioteca.length} jogos em memória em ${Date.now() - started}ms`);
}

function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(loadLibrary, 300);
}

function searchLibrary(search, page) {
  if (!biblioteca.length) loadLibrary();
  const term = normalizarTexto(search);
  const filtered = term ? biblioteca.filter(g => g.titleNorm.includes(term)) : biblioteca;
  const start = (page - 1) * PAGE_SIZE;
  const end = page * PAGE_SIZE;
  const games = filtered.slice(start, end).map((g, i) => ({
    id: g.id || `${page}-${i}`,
    title: g.title,
    coverUrl: g.coverUrl || FALLBACK_COVER,
    description: g.description || 'Sem descrição disponível.',
    installed: g.installed,
    versions: [{
      source: g.source,
      size: g.size,
      installId: g.installId,
      downloadAvailable: g.downloadAvailable,
    }],
  }));
  return { games, isLastPage: end >= filtered.length, total: filtered.length };
}

function validateInstallPath(input) {
  const installId = String(input?.installId || '').trim();
  if (!installId) return null;
  // Procura apenas em manifestos locais aprovados pelo utilizador.
  const file = path.join(DIR_LIBRARY, 'installs.json');
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const item = Array.isArray(data) ? data.find(x => String(x.installId) === installId) : null;
    return item || null;
  } catch {
    return null;
  }
}

function executeCommand(payload, ack) {
  const action = String(payload?.action || '');
  log(`[CMD] action=${action}`);

  if (action === 'ping') {
    return ack({ ok: true, action: 'ping', now: new Date().toISOString() });
  }

  if (action === 'refresh_library') {
    loadLibrary();
    return ack({ ok: true, count: biblioteca.length });
  }

  if (action === 'launch_game') {
    const manifest = validateInstallPath(payload);
    if (!manifest?.executable) return ack({ ok: false, error: 'INSTALL_MANIFEST_NOT_FOUND' });

    // Somente executáveis explicitamente registrados no manifesto local do usuário.
    const cwd = manifest.workingDirectory || path.dirname(manifest.executable);
    const { spawn } = require('child_process');
    try {
      const child = spawn(manifest.executable, manifest.args || [], {
        cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      return ack({ ok: true, action: 'launch_game', pid: child.pid });
    } catch (err) {
      return ack({ ok: false, error: err.message });
    }
  }

  if (action === 'stop_game') {
    // Parada genérica por PID passado pelo próprio dispositivo/usuário.
    const pid = Number.parseInt(payload?.pid, 10);
    if (!Number.isInteger(pid) || pid <= 0) return ack({ ok: false, error: 'INVALID_PID' });
    try {
      process.kill(pid, 'SIGTERM');
      return ack({ ok: true });
    } catch (err) {
      return ack({ ok: false, error: err.message });
    }
  }

  return ack({ ok: false, error: 'UNKNOWN_ACTION' });
}

const socket = io(SERVER_URL, {
  auth: {
    token: SHARED_SECRET,
  },
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,
  timeout: 10000,
});

socket.on('connect', () => {
  log(`[SOCKET] conectado server=${SERVER_URL} socket=${socket.id}`);
  socket.emit('registrar_pc', {
    userId: USER_ID,
    deviceId: DEVICE_ID,
    streamHost: STREAM_HOST,
  }, (ack) => {
    log(`[REGISTRO] ${JSON.stringify(ack)}`);
  });
});

socket.on('connect_error', err => log(`[SOCKET] connect_error ${err.message}`));
socket.on('disconnect', reason => log(`[SOCKET] desconectado reason=${reason}`));

socket.on('pedir_pesquisa_jogos', (data, ack) => {
  const started = Date.now();
  const search = String(data?.search || '');
  const page = Math.max(1, Number.parseInt(data?.page, 10) || 1);
  log(`[SEARCH] requestId=${data?.requestId || '-'} search="${search}" page=${page}`);
  try {
    const result = searchLibrary(search, page);
    log(`[SEARCH] devolvendo ${result.games.length}/${result.total} em ${Date.now() - started}ms`);
    ack({ ok: true, ...result });
  } catch (err) {
    log(`[SEARCH] erro ${err.stack || err}`);
    ack({ ok: false, error: err.message, games: [], isLastPage: true, total: 0 });
  }
});

socket.on('executar_comando', (payload, ack) => executeCommand(payload, ack || (() => {})));

setInterval(() => {
  if (socket.connected) socket.emit('pc_heartbeat', { userId: USER_ID });
}, 5000);

ensureLibrary();
loadLibrary();
fs.watch(DIR_LIBRARY, scheduleReload);
log(`🟢 Ubika PC Daemon ativo user=${USER_ID} device=${DEVICE_ID} streamHost=${STREAM_HOST || 'n/a'}`);
