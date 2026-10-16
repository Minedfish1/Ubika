const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DIR_LIBRARY = path.join(__dirname, 'library');
const FILE_SOURCES = path.join(__dirname, 'sources.json');
const PAGE_SIZE = 15;
const FALLBACK_COVER = 'https://i.imgur.com/vHq0rDk.png';

const log = (...args) => console.log(new Date().toISOString(), ...args);

let biblioteca = [];
let reloadTimer = null;

function normalizarTexto(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[._-]/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function ensureLibrary() {
  if (!fs.existsSync(DIR_LIBRARY)) fs.mkdirSync(DIR_LIBRARY, { recursive: true });
}

function extrairLista(data) {
  if (Array.isArray(data)) return data;
  for (const key of ['games', 'downloads', 'repacks', 'items']) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return null;
}

function loadLibrary() {
  ensureLibrary();
  const started = Date.now();
  const next = [];
  const files = fs.readdirSync(DIR_LIBRARY).filter(f => f.toLowerCase().endsWith('.json'));

  for (const file of files) {
    if (file === 'installs.json') continue;
    try {
      const full = path.join(DIR_LIBRARY, file);
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      const list = extrairLista(data);
      if (!list) {
        log(`[LIB] ${file}: formato ignorado (esperado array/games/downloads)`);
        continue;
      }

      let valid = 0;
      for (const item of list) {
        const title = String(item?.title || item?.name || '').replace(/\./g, ' ').trim();
        if (!title) continue;

        // Hydra: "uris": ["magnet:...", "magnet:..."] — primeira URI é o magnet principal
        const uris = Array.isArray(item.uris) ? item.uris : item.uri ? [item.uri] : [];
        const magnet = uris.find(u => String(u).startsWith('magnet:')) || null;

        next.push({
          id: String(item.id || `${file}:${valid}`),
          title,
          titleNorm: normalizarTexto(title),
          size: String(item.fileSize || item.size || 'Desconhecido').trim(),
          date: item.uploadDate || item.releaseDate || '',
          source: String(item.source || path.basename(file, '.json')),
          coverUrl: item.coverUrl || item.cover || item.image || null,
          description: item.description || null,
          installed: Boolean(item.installed),
          installId: item.installId || null,
          downloadAvailable: Boolean(item.downloadAvailable ?? magnet),
          magnet,
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
  return biblioteca.length;
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
      magnet: g.magnet,
      installId: g.installId,
      downloadAvailable: g.downloadAvailable,
    }],
  }));
  return { games, isLastPage: end >= filtered.length, total: filtered.length };
}

/**
 * Baixa os catálogos remotos listados em sources.json para library/.
 * Escrita atômica (tmp + rename) para não corromper JSONs em uso.
 */
async function syncSources() {
  if (!fs.existsSync(FILE_SOURCES)) {
    log('[SYNC] sources.json não encontrado, pulando sincronização');
    return { ok: 0, fail: 0 };
  }
  let urls;
  try {
    urls = JSON.parse(fs.readFileSync(FILE_SOURCES, 'utf8'))?.sources || [];
  } catch (err) {
    log(`[SYNC] sources.json inválido: ${err.message}`);
    return { ok: 0, fail: 0 };
  }

  ensureLibrary();
  let ok = 0, fail = 0;
  for (const url of urls) {
    const name = path.basename(new URL(url).pathname);
    if (!name.toLowerCase().endsWith('.json')) { fail++; continue; }
    try {
      const resp = await axios.get(url, { timeout: 60000, responseType: 'text', maxContentLength: 64 * 1024 * 1024 });
      JSON.parse(resp.data); // valida antes de gravar
      const dest = path.join(DIR_LIBRARY, name);
      const tmp = dest + '.tmp';
      fs.writeFileSync(tmp, resp.data, 'utf8');
      fs.renameSync(tmp, dest);
      ok++;
      log(`[SYNC] ${name} atualizado (${(resp.data.length / 1024 / 1024).toFixed(1)} MB)`);
    } catch (err) {
      fail++;
      log(`[SYNC] ${name} falhou: ${err.message}`);
    }
  }
  if (ok > 0) loadLibrary();
  return { ok, fail };
}

function watchLibrary() {
  ensureLibrary();
  try {
    fs.watch(DIR_LIBRARY, scheduleReload);
  } catch (err) {
    log(`[LIB] fs.watch indisponível: ${err.message} — usando polling 30s`);
    setInterval(loadLibrary, 30000);
  }
}

module.exports = { DIR_LIBRARY, loadLibrary, scheduleReload, searchLibrary, syncSources, watchLibrary };
