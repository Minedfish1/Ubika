const fs = require('fs');
const path = require('path');
const axios = require('axios');

const BASE_DIR = process.env.UBIKA_BASE_DIR || __dirname;
const DIR_LIBRARY = path.join(BASE_DIR, 'library');
const FILE_SOURCES = path.join(BASE_DIR, 'sources.json');
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
    // Alguns dumps vêm como objeto { "Titulo": {uris:[...]} } em vez de array
    if (data?.[key] && typeof data[key] === 'object') {
      return Object.entries(data[key]).map(([k, v]) => ({ title: v?.title || k, ...v }));
    }
  }
  return null;
}

/** Alguns catálogos trazem HTML-entities nas URIs (&#038; &amp; ...) — decodifica. */
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#0*38;|&amp;/g, '&')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** Nome do jogo via dn= do magnet quando o item não traz title. */
function titleFromMagnet(magnet) {
  const m = /[?&]dn=([^&]*)/i.exec(String(magnet || ''));
  if (!m) return '';
  try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch { return m[1]; }
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
        // Hydra: "uris": ["magnet:...", "magnet:..."] — steamgg e afins mandam links HTTP diretos
        const uris = (Array.isArray(item.uris) ? item.uris : item.uri ? [item.uri] : []).map(decodeEntities);
        const magnet = uris.find(u => String(u).startsWith('magnet:')) || null;
        const directLinks = uris.filter(u => /^https?:\/\//i.test(String(u)));

        // Fallback: sem title explícito, extrai o nome do parâmetro dn= do magnet
        let title = String(item?.title || item?.name || '').replace(/\./g, ' ').trim();
        if (!title) title = titleFromMagnet(magnet).trim();
        if (!title) continue;

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
          downloadAvailable: Boolean(item.downloadAvailable ?? (magnet || directLinks.length)),
          magnet,
          directLinks,
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

/** Chave de agrupamento: título limpo de versão/DLCs — junta a mesma obra de várias fontes. */
function groupKey(titleNorm) {
  const base = String(titleNorm || '')
    .replace(/\bfree\s*download\b/g, ' ')
    .replace(/\b(build|dlc|dlcs|multi\d*|repack|deluxe|complete|edition|enhanced|update|hotfix|release|goty|definitive|collection|remastered|bonus|ost|co op|coop)\b/g, ' ')
    .replace(/\ba\b/g, ' '); // mojibake "â€"" vira "a" solto — nunca é parte real do título
  // Corta no primeiro token de versão: "v1", "v 1 4 5", "1.4.5", sequência de
  // números "1 4 5 3"/"5 00b" (o normalize já tirou os pontos) ou ano (19xx/20xx).
  // Números soltos curtos ficam (senão "Fallout 3" e "Fallout 4" virariam o mesmo jogo).
  const m = /(?:^|\s)(v\s*\d|\d+\s*\.\s*\d|\d+(?:\s+\d+\w*)+|(?:19|20)\d{2}|\d{5,})\b/.exec(base);
  return (m ? base.slice(0, m.index) : base).replace(/\s{2,}/g, ' ').trim();
}

/** Match tolerante: todos os tokens da busca presentes no título (qualquer ordem) OU substring contígua. */
function matches(g, term) {
  if (!term) return true;
  if (g.titleNorm.includes(term)) return true;
  const qt = term.split(' ').filter(Boolean);
  if (qt.length < 2) return false;
  const tt = g.titleNorm.split(' ');
  return qt.every(q => tt.some(t => t.includes(q)));
}

function searchLibrary(search, page) {
  if (!biblioteca.length) loadLibrary();
  const term = normalizarTexto(search);
  const filtered = term ? biblioteca.filter(g => matches(g, term)) : biblioteca;

  // Agrupa por obra: um jogo presente em várias fontes vira um card com várias versões
  const groups = new Map();
  for (const g of filtered) {
    const key = groupKey(g.titleNorm) || g.titleNorm;
    let grp = groups.get(key);
    if (!grp) { grp = { rep: g, versions: [] }; groups.set(key, grp); }
    grp.versions.push({
      source: g.source,
      size: g.size,
      magnet: g.magnet,
      links: g.directLinks,
      installId: g.installId,
      downloadAvailable: g.downloadAvailable,
    });
    // representante = entrada mais recente do grupo
    if (String(g.date) > String(grp.rep.date)) grp.rep = g;
  }
  const ordered = [...groups.values()].sort((a, b) =>
    String(b.rep.date).localeCompare(String(a.rep.date)) || a.rep.title.localeCompare(b.rep.title));

  const start = (page - 1) * PAGE_SIZE;
  const end = page * PAGE_SIZE;
  const games = ordered.slice(start, end).map(({ rep: g, versions }, i) => ({
    id: g.id || `${page}-${i}`,
    title: g.title,
    coverUrl: g.coverUrl || FALLBACK_COVER,
    description: g.description || 'Sem descrição disponível.',
    installed: g.installed,
    versions,
  }));
  return { games, isLastPage: end >= ordered.length, total: ordered.length };
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
      const resp = await axios.get(url, {
        timeout: 60000,
        responseType: 'text',
        maxContentLength: 64 * 1024 * 1024,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      });
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
