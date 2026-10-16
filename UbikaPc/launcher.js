const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn, exec } = require('child_process');

/**
 * Launcher de 1 clique do Ubika PC (entrypoint do UbikaPC.exe).
 *
 * - Resolve a pasta de dados (UbikaPc ao lado do exe, ou a pasta do exe)
 * - Carrega o .env
 * - Verifica/inicia Sunshine e instala o VDD se faltar
 * - Aplica o setup de stream (display dinâmico) se o Sunshine existir
 * - Sobe o daemon (pareamento/downloads/comandos)
 */

const isSea = (() => { try { return require('node:sea').isSea(); } catch { return false; } })();
const isPackaged = isSea || !!process.pkg;
const EXE_DIR = isPackaged ? path.dirname(process.execPath) : __dirname;

// SEA standalone: dados extraem-se para %LOCALAPPDATA%\Ubika (exe único de verdade).
// Junto do repo (modo dev): <exe>/UbikaPc se existir, senão <exe>.
const STANDALONE_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Ubika');
const BASE_DIR = isPackaged
  ? (fs.existsSync(path.join(EXE_DIR, 'UbikaPc', 'library')) ? path.join(EXE_DIR, 'UbikaPc') : STANDALONE_DIR)
  : __dirname;
process.env.UBIKA_BASE_DIR = BASE_DIR;

// Assets embutidos no SEA → extraídos na primeira execução (só os que faltam)
const SEA_ASSETS = [
  'sources.json',
  'default.env',
  'stream/display-attach.ps1', 'stream/display-detach.ps1', 'stream/install-vdd.ps1', 'stream/setup-all.ps1',
  'driver/MttVDD.dll', 'driver/MttVDD.inf', 'driver/Virtual_Display_Driver.cer', 'driver/mttvdd.cat', 'driver/vdd_settings.xml',
  'library/dodi.json', 'library/empress.json', 'library/fitgirl.json', 'library/gog.json',
  'library/onlinefix.json', 'library/steamgg.json', 'library/xatab.json',
];

function extractSeaAssets() {
  if (!isSea) return;
  let sea;
  try { sea = require('node:sea'); } catch { return; }
  fs.mkdirSync(BASE_DIR, { recursive: true });
  for (const rel of SEA_ASSETS) {
    const dest = rel === 'default.env' ? path.join(BASE_DIR, '.env') : path.join(BASE_DIR, rel);
    if (fs.existsSync(dest)) continue; // nunca sobrescreve dados do usuário
    try {
      const buf = Buffer.from(sea.getAsset(rel));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
    } catch (err) { /* asset ausente neste build — ok */ }
  }
}
extractSeaAssets();

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

function openUrl(url) {
  try { exec(`cmd /c start "" "${url}"`, { windowsHide: true }); } catch {}
}

function lanIp() {
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

/** Um prompt UAC só: instala Sunshine (winget/GitHub) + VDD + inicia o Sunshine. */
function runSetupAllElevated() {
  const ps1 = path.join(BASE_DIR, 'stream', 'setup-all.ps1');
  const driverDir = path.join(BASE_DIR, 'driver');
  if (!fs.existsSync(ps1)) return false;
  try {
    const args = `'-NoProfile','-ExecutionPolicy','Bypass','-File','${ps1}','-DriverSource','${driverDir}'`;
    execSync(`powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList ${args}"`, { stdio: 'ignore', timeout: 900000 });
    return true;
  } catch { return false; }
}

/** Abre a GUI local como janela-app (Edge/Chrome --app) ou navegador padrão. */
function openGui(url) {
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const browser = [edge, chrome].find(p => fs.existsSync(p));
  try {
    if (browser) exec(`"${browser}" --app=${url}`, { windowsHide: true });
    else exec(`cmd /c start "" "${url}"`, { windowsHide: true });
  } catch {}
}

banner();
log(`base=${BASE_DIR} sea=${isSea}`);

// ---------- Rede: conexão direta (VPS só apresenta o PC ao celular) ----------
const lan = lanIp();
console.log(`  ${ok(!!lan)} Rede      LAN ${lan || '?'} — IP público informado pela VPS`);
console.log('         Stream direto PC↔celular; UPnP do Sunshine abre as portas no roteador');

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

if (!st.sunshineInstalled || !st.vddInstalled) {
  console.log('      → Rodando setup completo (aceite o prompt UAC)…');
  if (runSetupAllElevated()) {
    const again = sunshine.streamStatus();
    console.log(`  ${ok(again.sunshineInstalled)} Sunshine   ${again.sunshineInstalled ? 'instalado' : 'não instalou — veja %ProgramData%\\Ubika\\setup-all.log'}`);
    console.log(`  ${ok(again.vddInstalled)} VDD        ${again.vddInstalled ? 'instalado agora' : 'não instalou — veja %ProgramData%\\Ubika\\install-vdd.log'}`);
  } else {
    console.log('      → Setup automático indisponível — rode como admin:');
    console.log(`        powershell -File "${path.join(BASE_DIR, 'stream', 'setup-all.ps1')}"`);
  }
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

// ---------- GUI local (código de pareamento em janela) ----------
const GUI_PORT = 47890;
const guiUrl = `http://127.0.0.1:${GUI_PORT}`;

// ---------- Daemon ----------
require('./client.js');

// Sobe depois do daemon para a página já responder de cara
setTimeout(() => {
  console.log(`  → Painel: ${guiUrl}  (abre sozinho)`);
  openGui(guiUrl);
}, 1500);
