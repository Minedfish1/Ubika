const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn, exec } = require('child_process');

/**
 * Launcher de 1 clique do Ubika PC (entrypoint do UbikaPC.exe).
 *
 * - Resolve a pasta de dados (UbikaPc ao lado do exe, ou a pasta do exe)
 * - Carrega o .env
 * - Verifica/inicia Sunshine, VDD e Tailscale
 * - Aplica o setup de stream (display dinâmico) se o Sunshine existir
 * - Sobe o daemon (pareamento/downloads/comandos)
 */

const isSea = (() => { try { return require('node:sea').isSea(); } catch { return false; } })();
const isPackaged = isSea || !!process.pkg;
const EXE_DIR = isPackaged ? path.dirname(process.execPath) : __dirname;

// Preferência: <exe>/UbikaPc (exe na pasta Ubika) > <exe> (exe dentro de UbikaPc)
const BASE_DIR = isPackaged
  ? (fs.existsSync(path.join(EXE_DIR, 'UbikaPc', 'library')) ? path.join(EXE_DIR, 'UbikaPc') : EXE_DIR)
  : __dirname;
process.env.UBIKA_BASE_DIR = BASE_DIR;

// .env ao lado dos dados
try { process.loadEnvFile(path.join(BASE_DIR, '.env')); } catch {}

const log = (...a) => console.log(new Date().toISOString(), ...a);
const ok = (b) => (b ? 'OK ' : '…  ');

function banner() {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║            UBIKA PC — 1 CLIQUE               ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
}

function sunshineExePath() {
  const candidates = [
    'C:\\Program Files\\Sunshine\\sunshine.exe',
    'C:\\Program Files (x86)\\Sunshine\\sunshine.exe',
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

function isProcessRunning(name) {
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${name}" /NH`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return out.toLowerCase().includes(name.toLowerCase());
  } catch { return false; }
}

const TS_EXE = 'C:\\Program Files\\Tailscale\\tailscale.exe';
const HEADSCALE_URL = (process.env.UBIKA_HEADSCALE_URL || 'http://18.223.108.137:8080').replace(/\/+$/, '');
const HEADSCALE_KEY = process.env.UBIKA_HEADSCALE_KEY || '';
const OFFICIAL_CONTROL = 'controlplane.tailscale.com';

function tsRun(args) {
  try {
    return execSync(`"${TS_EXE}" ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { return ''; }
}

function tailscaleState() {
  if (!fs.existsSync(TS_EXE)) return { installed: false, control: '', ip: '' };
  let control = '';
  try { control = JSON.parse(tsRun('debug prefs') || '{}').ControlURL || ''; } catch {}
  const ip = tsRun('ip -4').split(/\r?\n/)[0] || '';
  return { installed: true, control, ip };
}

/** Garante que o cliente está na headscale da VPS; troca se houver key. */
function ensureHeadscale() {
  const st = tailscaleState();
  if (!st.installed) {
    console.log('  …   Tailscale  não instalado — instale tailscale.com/download');
    return '';
  }
  const onHeadscale = st.control.replace(/\/+$/, '') === HEADSCALE_URL;

  if (onHeadscale && st.ip) return st.ip;

  if (onHeadscale && !st.ip) {
    console.log('  …   Headscale  conectado mas sem IP — rode tailscale up');
    tsRun('up');
    return tailscaleState().ip;
  }

  // Está em outro servidor (oficial ou headscale antiga): troca se tiver key
  if (HEADSCALE_KEY) {
    console.log(`  …   Trocando para headscale ${HEADSCALE_URL}…`);
    tsRun('logout');
    const out = tsRun(`login --login-server ${HEADSCALE_URL} --authkey ${HEADSCALE_KEY}`);
    const ip = tailscaleState().ip;
    if (ip) return ip;
    console.log(`  !   Login falhou: ${out || 'sem resposta'}`);
    return '';
  }

  console.log(`  …   Tailscale  está em ${st.control || 'desconectado'} — não é a headscale da VPS`);
  console.log(`      → Rode:  "${TS_EXE}" login --login-server ${HEADSCALE_URL} --authkey <PREAUTHKEY>`);
  console.log('      → ou defina UBIKA_HEADSCALE_KEY no .env para eu fazer isso sozinho');
  return '';
}

function openUrl(url) {
  try { exec(`cmd /c start "" "${url}"`, { windowsHide: true }); } catch {}
}

banner();
log(`base=${BASE_DIR} sea=${isSea}`);

// ---------- Overlay (headscale na VPS) ----------
const tsIp = ensureHeadscale();
console.log(`  ${ok(!!tsIp)} Headscale  ${tsIp || 'sem overlay — stream externo não funciona'}`);
if (tsIp) process.env.UBIKA_STREAM_HOST = process.env.UBIKA_STREAM_HOST || tsIp;

// ---------- Sunshine / VDD ----------
const sunshine = require('./sunshine');
const st = sunshine.streamStatus();
const sunExe = sunshineExePath();

console.log(`  ${ok(st.sunshineInstalled)} Sunshine   ${st.sunshineInstalled ? 'instalado' : 'NÃO instalado'}`);
console.log(`  ${ok(st.vddInstalled)} VDD        ${st.vddInstalled ? 'instalado' : 'NÃO instalado'}`);
console.log(`  ${ok(st.prepConfigured)} Display    ${st.prepConfigured ? `dinâmico ativo (dd=${st.ddResolutionOption})` : 'setup pendente'}`);

if (st.sunshineInstalled && !st.prepConfigured) {
  const r = sunshine.installStreamSetup();
  if (r.ok) {
    console.log('  ✓   Setup de stream aplicado no sunshine.conf — reinicie o Sunshine para valer');
  } else {
    console.log('  !   Setup aplicado parcialmente:');
    (r.steps || []).forEach(s => console.log(`      • ${s}`));
  }
}

if (!st.sunshineInstalled) {
  console.log('      → Baixe o Sunshine: https://github.com/LizardByte/Sunshine/releases');
  openUrl('https://github.com/LizardByte/Sunshine/releases');
}
if (!st.vddInstalled) {
  console.log('      → Baixe o VDD: https://github.com/VirtualDrivers/Virtual-Display-Driver/releases');
  openUrl('https://github.com/VirtualDrivers/Virtual-Display-Driver/releases');
}

// Inicia o Sunshine se estiver instalado e não estiver rodando
if (sunExe && !isProcessRunning('sunshine.exe')) {
  try {
    const child = spawn(sunExe, [], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    console.log('  ✓   Sunshine iniciado em segundo plano');
  } catch (e) {
    console.log(`  !   Não consegui iniciar o Sunshine: ${e.message}`);
  }
} else if (sunExe) {
  console.log('  ✓   Sunshine já está rodando');
}

console.log('');
console.log('  ── Daemon ──────────────────────────────────');
console.log('');

// ---------- Daemon ----------
require('./client.js');
