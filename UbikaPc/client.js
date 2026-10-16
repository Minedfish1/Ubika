const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { io } = require('socket.io-client');

// Base de dados do daemon: UBIKA_BASE_DIR (launcher/exe) > pasta do script
const BASE_DIR = process.env.UBIKA_BASE_DIR || __dirname;

// Carrega .env ao lado do script (Node >=20.12); ignora se não existir
try { process.loadEnvFile(path.join(BASE_DIR, '.env')); } catch {}

const { loadLibrary, searchLibrary, syncSources, watchLibrary, DIR_LIBRARY } = require('./library');
const { DownloadManager, defaultDownloadDir } = require('./downloads');
const sunshine = require('./sunshine');

const ENV_PATH = path.join(BASE_DIR, '.env');
const envUserId = (process.env.UBIKA_USER_ID || '').trim();
// Sem usuário real (ou o id de teste) o daemon entra em modo de pareamento
const PAIRED = envUserId && envUserId !== 'utilizador_teste_123';
let USER_ID = PAIRED ? envUserId : '';
const DEVICE_ID = process.env.UBIKA_DEVICE_ID || `${os.hostname()}-${process.platform}`;
const SERVER_URL = process.env.UBIKA_SERVER || 'http://localhost:3000';
const SHARED_SECRET = process.env.UBIKA_SHARED_SECRET || '';
const LAN_IP = detectBestIp();
let PUBLIC_IP = process.env.UBIKA_STREAM_HOST || ''; // servidor também infere pelo handshake

// Descobre o IP público (o celular conecta direto — a VPS só apresenta uma vez)
function refreshPublicIp() {
  try {
    const https = require('https');
    const req = https.get('https://api.ipify.org', { timeout: 8000 }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        const ip = d.trim();
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && ip !== PUBLIC_IP) {
          PUBLIC_IP = ip;
          log(`[NET] IP público detectado: ${PUBLIC_IP}`);
        }
      });
    });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
  } catch {}
}
refreshPublicIp();
setInterval(refreshPublicIp, 10 * 60 * 1000); // revalida a cada 10 min (IP dinâmico)
const SYNC_INTERVAL_MS = Number.parseInt(process.env.UBIKA_SYNC_INTERVAL_MS || `${6 * 60 * 60 * 1000}`, 10); // 6h
const PAIR_CODE = PAIRED ? '' : String(crypto.randomInt(100000, 999999));

const log = (...args) => console.log(new Date().toISOString(), ...args);

function saveUserIdToEnv(userId) {
  try {
    let env = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    if (/^UBIKA_USER_ID=.*$/m.test(env)) env = env.replace(/^UBIKA_USER_ID=.*$/m, `UBIKA_USER_ID=${userId}`);
    else env += `\nUBIKA_USER_ID=${userId}`;
    fs.writeFileSync(ENV_PATH, env);
  } catch (err) {
    log(`[PAIR] não consegui gravar .env: ${err.message}`);
  }
}

/** Primeiro IPv4 privado (RFC1918); senão qualquer não-interno. lanIp só interessa na mesma rede. */
function detectBestIp() {
  let other = '';
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address)) return item.address;
      if (!other) other = item.address;
    }
  }
  return other;
}

// ---------- Estado do cliente (o PC guarda as infos e continua sozinho) ----------
const STATE_PATH = path.join(BASE_DIR, 'state.json');
let state = { clientRes: null, lastClientAt: 0 };
try { if (fs.existsSync(STATE_PATH)) state = { ...state, ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) }; } catch {}
function saveState() {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); } catch {}
}

const ATTACH_PS1 = path.join(BASE_DIR, 'stream', 'display-attach.ps1');
const DETACH_PS1 = path.join(BASE_DIR, 'stream', 'display-detach.ps1');

/** Há stream ativo = conexão TCP estabelecida nas portas do Sunshine. */
function isStreamActive() {
  if (process.platform !== 'win32') return false;
  try {
    const out = require('child_process').execSync('netstat -an -p tcp', { encoding: 'utf8', timeout: 10000 });
    return out.split(/\r?\n/).some(l =>
      /ESTABLISHED/.test(l) && /:(47984|47989|47990|48010)\s/.test(l));
  } catch { return false; }
}

function runPs(script, args) {
  const { spawn } = require('child_process');
  const cmdArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, ...args];
  try {
    const child = spawn('powershell.exe', cmdArgs, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** App mandou a resolução do celular → prepara o display virtual já. */
function applyClientResolution(payload) {
  const w = Number.parseInt(payload?.width, 10), h = Number.parseInt(payload?.height, 10);
  const fps = Math.min(120, Math.max(24, Number.parseInt(payload?.fps, 10) || 60));
  if (!w || !h || w < 320 || h < 240 || w > 8192 || h > 8192) return { ok: false, error: 'RES_INVALIDA' };
  state.clientRes = { width: w, height: h, fps };
  state.lastClientAt = Date.now();
  saveState();
  log(`[CLIENTE] resolução ${w}x${h}@${fps} — anexando display virtual`);
  if (!sunshine.vddInstalled()) {
    log('[CLIENTE] VDD ausente — resolução guardada; Sunshine aplica no stream');
    return { ok: true, vddMissing: true, applied: state.clientRes };
  }
  const r = runPs(ATTACH_PS1, ['-Width', String(w), '-Height', String(h), '-Fps', String(fps)]);
  return { ok: r.ok, applied: state.clientRes, error: r.error };
}

/** App fechou (ou pediu) → volta ao normal, a não ser que haja stream rolando. */
function restoreDisplay(origem) {
  state.lastClientAt = Date.now();
  saveState();
  if (isStreamActive()) {
    log(`[CLIENTE] ${origem}: stream ativo — display segue até o fim do stream`);
    return { ok: true, skipped: 'STREAM_ACTIVE' };
  }
  log(`[CLIENTE] ${origem}: restaurando display original`);
  const r = runPs(DETACH_PS1, []);
  return { ok: r.ok, error: r.error };
}

// ---------- Downloads ----------
const downloadDir = defaultDownloadDir();
const downloads = new DownloadManager(downloadDir, (snap) => {
  if (socket.connected && USER_ID) socket.emit('download_progress', { userId: USER_ID, ...snap });
});
downloads.init().then(() => downloads.start());

// ---------- Comandos ----------
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

async function executeCommand(payload, ack) {
  const action = String(payload?.action || '');
  log(`[CMD] action=${action}`);

  try {
    switch (action) {
      case 'ping':
        return ack({ ok: true, action: 'ping', now: new Date().toISOString() });

      case 'status':
        return ack({
          ok: true,
          deviceId: DEVICE_ID,
          lanIp: LAN_IP,
          streamHost: PUBLIC_IP || LAN_IP,
          clientRes: state.clientRes,
          downloadDir,
          downloads: downloads.list(),
          engine: downloads.engineName,
          librarySize: searchLibrary('', 1).total,
        });

      case 'refresh_library':
        return ack({ ok: true, count: loadLibrary() });

      case 'sync_sources': {
        const r = await syncSources();
        return ack({ ok: true, ...r });
      }

      case 'iniciar_download': {
        const magnet = payload.magnetLink || payload.magnet || payload.uri;
        const result = downloads.add({ magnet, gameName: payload.gameName });
        return ack(result.ok
          ? { ok: true, download: result.download, already: !!result.already }
          : { ok: false, error: result.error });
      }

      case 'listar_downloads':
        return ack({ ok: true, downloads: downloads.list() });

      case 'pausar_download':
        return ack(downloads.pause(String(payload.id || '')));

      case 'retomar_download':
        return ack(downloads.resume(String(payload.id || '')));

      case 'remover_download':
        return ack(downloads.remove(String(payload.id || ''), Boolean(payload.deleteFiles)));

      case 'status_stream':
        return ack({ ok: true, stream: sunshine.streamStatus() });

      case 'instalar_stream_setup':
        return ack(sunshine.installStreamSetup());

      case 'preparar_stream':
        return ack(applyClientResolution(payload));

      case 'restaurar_display':
        return ack(restoreDisplay('app pediu'));

      case 'launch_game': {
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

      case 'stop_game': {
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

      default:
        return ack({ ok: false, error: 'UNKNOWN_ACTION' });
    }
  } catch (err) {
    log(`[CMD] erro em ${action}: ${err.stack || err}`);
    return ack({ ok: false, error: err.message });
  }
}

// ---------- Socket ----------
const socket = io(SERVER_URL, {
  auth: { token: SHARED_SECRET },
  query: PAIRED ? { device: 'pc', userId: USER_ID } : { device: 'pc' },
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,
  timeout: 10000,
});

socket.on('connect', () => {
  log(`[SOCKET] conectado server=${SERVER_URL} socket=${socket.id}`);
  if (PAIRED) {
    socket.emit('registrar_pc', {
      userId: USER_ID,
      deviceId: DEVICE_ID,
      lanIp: LAN_IP,
      streamHost: PUBLIC_IP || LAN_IP,
    }, (ack) => {
      log(`[REGISTRO] ${JSON.stringify(ack)}`);
    });
  } else {
    // Modo pareamento: registra com código e aguarda o app digitar
    socket.emit('registrar_pc', {
      pairCode: PAIR_CODE,
      deviceId: DEVICE_ID,
      lanIp: LAN_IP,
      streamHost: PUBLIC_IP || LAN_IP,
    }, (ack) => {
      log(`[PAIR] ${JSON.stringify(ack)}`);
    });
  }
});

// Servidor confirma o pareamento: grava o userId real e re-registra
socket.on('pareado', (data) => {
  const userId = String(data?.userId || '').trim();
  if (!userId) return;
  log(`[PAIR] pareado com user=${userId}`);
  saveUserIdToEnv(userId);
  process.env.UBIKA_USER_ID = userId;
  USER_ID = userId;
  socket.emit('registrar_pc', {
    userId,
    deviceId: DEVICE_ID,
    lanIp: LAN_IP,
    streamHost: PUBLIC_IP || LAN_IP,
  }, (ack) => log(`[REGISTRO] ${JSON.stringify(ack)}`));
});

// VPS avisa que o último app desse usuário saiu → restaura display se não há stream
socket.on('cliente_offline', () => restoreDisplay('app desconectou'));

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
  if (socket.connected && USER_ID) socket.emit('pc_heartbeat', { userId: USER_ID });
}, 5000);

// ---------- Boot ----------
loadLibrary();
watchLibrary();
syncSources().then(r => log(`[SYNC] inicial: ${JSON.stringify(r)}`));
if (SYNC_INTERVAL_MS > 0) {
  setInterval(() => syncSources().then(r => log(`[SYNC] periódico: ${JSON.stringify(r)}`)), SYNC_INTERVAL_MS);
}

if (!PAIRED) {
  // Código visível no console e num arquivo pra usuário digitar no app
  const banner = [
    '',
    '  ╔══════════════════════════════════════╗',
    '  ║   CÓDIGO DE PAREAMENTO UBIKA         ║',
    `  ║            ${PAIR_CODE}                  ║`,
    '  ║   Digite este código no app mobile   ║',
    '  ╚══════════════════════════════════════╝',
    '',
  ].join('\n');
  console.log(banner);
  try { fs.writeFileSync(path.join(BASE_DIR, 'PAREAR.txt'), `Código de pareamento Ubika: ${PAIR_CODE}\nVálido por 10 minutos. Digite no app mobile.\n`); } catch {}
}

log(`🟢 Ubika PC Daemon ativo user=${USER_ID || '(aguardando pareamento)'} device=${DEVICE_ID} lanIp=${LAN_IP || 'n/a'} engine=${downloads.engineName} dir=${downloadDir}`);
