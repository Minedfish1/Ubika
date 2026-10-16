const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { io } = require('socket.io-client');

// Carrega .env ao lado do script (Node >=20.12); ignora se não existir
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

const { loadLibrary, searchLibrary, syncSources, watchLibrary, DIR_LIBRARY } = require('./library');
const { DownloadManager, defaultDownloadDir } = require('./downloads');
const sunshine = require('./sunshine');

const ENV_PATH = path.join(__dirname, '.env');
const envUserId = (process.env.UBIKA_USER_ID || '').trim();
// Sem usuário real (ou o id de teste) o daemon entra em modo de pareamento
const PAIRED = envUserId && envUserId !== 'utilizador_teste_123';
let USER_ID = PAIRED ? envUserId : '';
const DEVICE_ID = process.env.UBIKA_DEVICE_ID || `${os.hostname()}-${process.platform}`;
const SERVER_URL = process.env.UBIKA_SERVER || 'http://localhost:3000';
const SHARED_SECRET = process.env.UBIKA_SHARED_SECRET || '';
const STREAM_HOST = process.env.UBIKA_STREAM_HOST || detectBestIp();
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

/** Prefere o IP do overlay (Tailscale 100.64.0.0/10); senão, primeiro IPv4 de LAN. */
function detectBestIp() {
  let lan = '';
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      const parts = item.address.split('.').map(Number);
      if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return item.address; // CGNAT/Tailscale
      if (!lan) lan = item.address;
    }
  }
  return lan;
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
          streamHost: STREAM_HOST,
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
      streamHost: STREAM_HOST,
    }, (ack) => {
      log(`[REGISTRO] ${JSON.stringify(ack)}`);
    });
  } else {
    // Modo pareamento: registra com código e aguarda o app digitar
    socket.emit('registrar_pc', {
      pairCode: PAIR_CODE,
      deviceId: DEVICE_ID,
      streamHost: STREAM_HOST,
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
    streamHost: STREAM_HOST,
  }, (ack) => log(`[REGISTRO] ${JSON.stringify(ack)}`));
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
  try { fs.writeFileSync(path.join(__dirname, 'PAREAR.txt'), `Código de pareamento Ubika: ${PAIR_CODE}\nVálido por 10 minutos. Digite no app mobile.\n`); } catch {}
}

log(`🟢 Ubika PC Daemon ativo user=${USER_ID || '(aguardando pareamento)'} device=${DEVICE_ID} streamHost=${STREAM_HOST || 'n/a'} engine=${downloads.engineName} dir=${downloadDir}`);
