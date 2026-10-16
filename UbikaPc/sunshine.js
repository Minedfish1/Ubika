const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const log = (...args) => console.log(new Date().toISOString(), ...args);
const STREAM_DIR = path.join(process.env.UBIKA_BASE_DIR || __dirname, 'stream');
const ATTACH_PS1 = path.join(STREAM_DIR, 'display-attach.ps1');
const DETACH_PS1 = path.join(STREAM_DIR, 'display-detach.ps1');

const SUNSHINE_CONF_CANDIDATES = [
  process.env.SUNSHINE_HOME ? path.join(process.env.SUNSHINE_HOME, 'config', 'sunshine.conf') : null,
  'C:\\Program Files\\Sunshine\\config\\sunshine.conf',
  'C:\\Program Files (x86)\\Sunshine\\config\\sunshine.conf',
].filter(Boolean);

function findSunshineConf() {
  for (const p of SUNSHINE_CONF_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

function sunshineRunning() {
  if (process.platform !== 'win32') return false;
  try {
    return /sunshine\.exe/i.test(execSync('tasklist /FI "IMAGENAME eq sunshine.exe"', { encoding: 'utf8', timeout: 10000 }));
  } catch { return false; }
}

function vddInstalled() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execSync('pnputil /enum-devices /class DISPLAY', { encoding: 'utf8', timeout: 15000 });
    return /VDD|Virtual Display|IddSample|MttVdd/i.test(out);
  } catch { return false; }
}

function buildPrepEntry() {
  const doCmd = `powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File \\"${ATTACH_PS1}\\" -Width \${SUNSHINE_CLIENT_WIDTH} -Height \${SUNSHINE_CLIENT_HEIGHT} -Fps \${SUNSHINE_CLIENT_FPS}`;
  const undoCmd = `powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File \\"${DETACH_PS1}\\"`;
  return { do: doCmd, undo: undoCmd, elevated: 'true' };
}

/**
 * Escreve global_prep_cmd e dd_resolution_option=auto no sunshine.conf.
 * Idempotente: não duplica entradas que já contenham display-attach.ps1.
 */
function installStreamSetup() {
  const confPath = findSunshineConf();
  const report = { ok: false, steps: [], sunshineConf: confPath, vddInstalled: vddInstalled(), sunshineRunning: sunshineRunning() };
  if (!confPath) {
    report.error = 'SUNSHINE_NOT_FOUND';
    report.steps.push('Instale o Sunshine (https://github.com/LizardByte/Sunshine/releases) e rode uma vez para gerar sunshine.conf');
    return report;
  }
  if (!fs.existsSync(ATTACH_PS1) || !fs.existsSync(DETACH_PS1)) {
    report.error = 'SCRIPTS_MISSING';
    return report;
  }

  let conf;
  try {
    conf = fs.readFileSync(confPath, 'utf8');
  } catch (err) {
    report.error = `CONF_READ_FAIL: ${err.message}`;
    return report;
  }

  // 1. global_prep_cmd
  const entry = buildPrepEntry();
  const m = conf.match(/^global_prep_cmd\s*=\s*(.+)$/m);
  if (m) {
    let arr;
    try { arr = JSON.parse(m[1]); } catch { arr = null; }
    if (Array.isArray(arr)) {
      if (arr.some(e => String(e?.do || '').includes('display-attach.ps1'))) {
        report.steps.push('global_prep_cmd já configurado');
      } else {
        arr.push(entry);
        conf = conf.replace(m[0], `global_prep_cmd = ${JSON.stringify(arr)}`);
        report.steps.push('global_prep_cmd: entry adicionada à lista existente');
      }
    } else {
      report.steps.push('global_prep_cmd existe mas não é JSON válido — verifique manualmente');
    }
  } else {
    conf += `\n# Ubika: anexa display virtual na resolução do cliente ao iniciar stream\nglobal_prep_cmd = ${JSON.stringify([entry])}\n`;
    report.steps.push('global_prep_cmd criado');
  }

  // 2. dd_resolution_option = auto (Sunshine ajusta a resolução do display para a do cliente)
  const dd = conf.match(/^dd_resolution_option\s*=\s*(\S+)/m);
  if (!dd) {
    conf += 'dd_resolution_option = auto\n';
    report.steps.push('dd_resolution_option=auto adicionado');
  } else if (dd[1] === 'disabled') {
    conf = conf.replace(dd[0], 'dd_resolution_option = auto');
    report.steps.push('dd_resolution_option alterado disabled->auto');
  }

  // 3. upnp = enabled — sem VPN: o Sunshine abre as portas do stream no roteador
  const upnp = conf.match(/^upnp\s*=\s*(\S+)/m);
  if (!upnp) {
    conf += 'upnp = enabled\n';
    report.steps.push('upnp=enabled adicionado (portas do stream abertas no roteador)');
  } else if (upnp[1] !== 'enabled') {
    conf = conf.replace(upnp[0], 'upnp = enabled');
    report.steps.push(`upnp alterado ${upnp[1]}->enabled`);
  }

  try {
    fs.writeFileSync(confPath, conf, 'utf8');
    report.steps.push('sunshine.conf salvo — reinicie o Sunshine para aplicar');
    report.ok = true;
  } catch (err) {
    report.error = `CONF_WRITE_FAIL: ${err.message} — rode o daemon como admin`;
    return report;
  }

  if (!report.vddInstalled) report.steps.push('VDD não detectado — instale Virtual Display Driver (github.com/VirtualDrivers/Virtual-Display-Driver)');
  return report;
}

function streamStatus() {
  const confPath = findSunshineConf();
  let prepConfigured = false;
  let ddAuto = null;
  let upnpOption = null;
  if (confPath) {
    try {
      const conf = fs.readFileSync(confPath, 'utf8');
      prepConfigured = /display-attach\.ps1/.test(conf);
      const dd = conf.match(/^dd_resolution_option\s*=\s*(\S+)/m);
      ddAuto = dd ? dd[1] : 'unset';
      const up = conf.match(/^upnp\s*=\s*(\S+)/m);
      upnpOption = up ? up[1] : 'unset';
    } catch {}
  }
  return {
    sunshineInstalled: Boolean(confPath),
    sunshineConf: confPath,
    sunshineRunning: sunshineRunning(),
    vddInstalled: vddInstalled(),
    prepConfigured,
    ddResolutionOption: ddAuto,
    upnp: upnpOption,
    attachScript: ATTACH_PS1,
    detachScript: DETACH_PS1,
  };
}

module.exports = { installStreamSetup, streamStatus, findSunshineConf, vddInstalled, sunshineRunning };
