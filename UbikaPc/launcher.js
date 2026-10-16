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

/** Pede UAC e instala o VDD vendored em UbikaPc\driver. Retorna true se o prompt foi lançado. */
function installVddElevated() {
  const ps1 = path.join(BASE_DIR, 'stream', 'install-vdd.ps1');
  const driverDir = path.join(BASE_DIR, 'driver');
  if (!fs.existsSync(ps1) || !fs.existsSync(path.join(driverDir, 'MttVDD.inf'))) return false;
  try {
    // ArgumentList como array de strings single-quoted — paths com espaço funcionam
    const args = `'-NoProfile','-ExecutionPolicy','Bypass','-File','${ps1}','-Source','${driverDir}'`;
    execSync(`powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList ${args}"`, { stdio: 'ignore', timeout: 180000 });
    return true;
  } catch { return false; }
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

if (!st.sunshineInstalled) {
  console.log('      → Baixe o Sunshine: https://github.com/LizardByte/Sunshine/releases');
  openUrl('https://github.com/LizardByte/Sunshine/releases');
}
if (!st.vddInstalled) {
  console.log('      → Tentando instalar o VDD embutido (aceite o prompt UAC)…');
  if (installVddElevated()) {
    const again = sunshine.streamStatus();
    console.log(`  ${ok(again.vddInstalled)} VDD        ${again.vddInstalled ? 'instalado agora' : 'não instalou — veja %ProgramData%\\Ubika\\install-vdd.log'}`);
  } else {
    console.log('      → Instalação automática indisponível — rode como admin:');
    console.log(`        powershell -File "${path.join(BASE_DIR, 'stream', 'install-vdd.ps1')}"`);
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

// ---------- Daemon ----------
require('./client.js');
