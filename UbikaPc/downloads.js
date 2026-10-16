const path = require('path');
const fs = require('fs');
const os = require('os');

const log = (...args) => console.log(new Date().toISOString(), ...args);

/**
 * DownloadManager — motor de torrents do daemon.
 *
 * Backend atual: WebTorrent (BitTorrent nativo em Node — TCP/uTP + DHT).
 * A interface (add/list/pause/resume/remove + onUpdate) é a fronteira estável:
 * se for preciso trocar por libtorrent (daemon C++ local), basta outro backend
 * expor os mesmos métodos.
 */
class DownloadManager {
  constructor(savePath, onUpdate) {
    this.savePath = savePath;
    this.onUpdate = onUpdate || (() => {});
    this.downloads = new Map(); // id -> entry (webtorrent + http)
    this.client = null;         // webtorrent
    this.qb = null;             // qbittorrent backend (libtorrent real)
    this.engineName = 'none';
    this._tick = null;
    this._qbNames = new Map();  // hash -> gameName (qbit não guarda nosso nome)
  }

  /**
   * Backend: UBIKA_TORRENT_BACKEND=qbittorrent|webtorrent|auto (default auto).
   * auto → tenta qBittorrent WebUI; se não houver, cai no WebTorrent embutido.
   */
  async init() {
    const want = (process.env.UBIKA_TORRENT_BACKEND || 'auto').toLowerCase();
    if (want !== 'webtorrent') {
      try {
        const { QBittorrentBackend } = require('./qbittorrent');
        const qb = new QBittorrentBackend();
        if (await qb.probe()) {
          await qb.login();
          this.qb = qb;
          this.engineName = 'qbittorrent';
          log(`[DL] engine qbittorrent ativa (${qb.base}) — libtorrent completo (uTP/TCP/DHT)`);
          return;
        }
      } catch (err) {
        log(`[DL] qbittorrent falhou: ${err.message}`);
      }
      if (want === 'qbittorrent') {
        log('[DL] UBIKA_TORRENT_BACKEND=qbittorrent mas WebUI não responde — downloads desabilitados');
        return;
      }
    }

    // webtorrent 1.9.7 (CJS estável; 2.x quebra com parse-torrent >=11.0.24)
    try {
      const WebTorrent = require('webtorrent');
      this.client = new WebTorrent({ utp: true });
      this.engineName = 'webtorrent';
      this.client.on('error', err => log(`[DL] engine error: ${err.message}`));
      log('[DL] engine webtorrent ativa');
    } catch (err) {
      log(`[DL] webtorrent indisponível (${err.message}). Downloads desabilitados.`);
    }
  }

  start() {
    fs.mkdirSync(this.savePath, { recursive: true });
    // Snapshot de progresso a cada 2s para o app
    this._tick = setInterval(() => {
      for (const entry of this.downloads.values()) {
        if (entry.state === 'downloading' || entry.state === 'fetching-metadata') {
          this._emitUpdate(entry);
        }
      }
      if (this.qb) this._pollQb();
    }, 2000);
    if (this._tick.unref) this._tick.unref();
  }

  _snapshot(entry) {
    const t = entry.torrent;
    const h = entry._http || {};
    return {
      progress: t ? Math.round(t.progress * 1000) / 10 : (h.length ? Math.round(h.downloaded / h.length * 1000) / 10 : 0),
      downloaded: t ? t.downloaded : (h.downloaded || 0),
      length: t ? t.length : (h.length || 0),
      downSpeed: t ? t.downloadSpeed : 0,
      upSpeed: t ? t.uploadSpeed : 0,
      peers: t ? t.numPeers : 0,
      id: entry.id,
      gameName: entry.gameName,
      state: entry.state,
      savePath: entry.savePath,
      addedAt: entry.addedAt,
      finishedAt: entry.finishedAt || null,
      error: entry.error || null,
      engine: this.engineName,
    };
  }

  _emitUpdate(entry) {
    try { this.onUpdate(entry.kind === 'qb' ? this._snapshotQb(entry) : this._snapshot(entry)); } catch {}
  }

  _setState(entry, state, err) {
    entry.state = state;
    if (err) entry.error = String(err.message || err);
    this._emitUpdate(entry);
  }

  /** Cada jogo baixa na própria pasta: C:\UbikaGames\<Nome do Jogo>\... */
  _gameDir(gameName) {
    const clean = String(gameName || 'download')
      .replace(/[\\/:*?"<>|]/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 80)
      || 'download';
    return path.join(this.savePath, clean);
  }

  add({ magnet, link, gameName }) {
    magnet = String(magnet || '').trim();
    link = String(link || '').trim();
    if (magnet.startsWith('magnet:')) magnet = withOpenTrackers(magnet);
    const targetDir = this._gameDir(gameName);
    fs.mkdirSync(targetDir, { recursive: true });

    // Fonte sem magnet (steamgg & cia) → download HTTP direto para o disco
    if (!magnet.startsWith('magnet:') && /^https?:\/\//i.test(link)) {
      return this._addHttp(link, String(gameName || 'download'), targetDir);
    }
    if (!magnet.startsWith('magnet:')) return { ok: false, error: 'INVALID_MAGNET' };

    // qBittorrent (libtorrent real) tem prioridade quando disponível
    if (this.qb) return this._addQb(magnet, String(gameName || 'download'), targetDir);

    if (!this.client) return { ok: false, error: 'ENGINE_UNAVAILABLE' };

    // Dedup por infoHash do xt (client.get() virou async no webtorrent v2)
    const hash = extractInfoHash(magnet);
    if (hash) {
      for (const e of this.downloads.values()) {
        if (e.infoHash === hash) {
          return { ok: true, already: true, download: this._snapshot(e) };
        }
      }
    }

    const entry = {
      id: null,
      infoHash: hash,
      gameName: String(gameName || 'download'),
      state: 'fetching-metadata',
      torrent: null,
      savePath: targetDir,
      addedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    };

    let torrent;
    try {
      torrent = this.client.add(magnet, { path: targetDir });
    } catch (err) {
      return { ok: false, error: err.message };
    }

    entry.id = torrent.infoHash || hash || `pending-${Date.now()}`;
    entry.torrent = torrent;
    this.downloads.set(entry.id, entry);

    torrent.on('infoHash', () => {
      entry.infoHash = torrent.infoHash;
      if (entry.id !== torrent.infoHash) {
        this.downloads.delete(entry.id);
        entry.id = torrent.infoHash;
        this.downloads.set(entry.id, entry);
      }
    });
    torrent.on('metadata', () => {
      log(`[DL] metadata ok: ${torrent.name} (${(torrent.length / 1e9).toFixed(2)} GB)`);
      this._setState(entry, 'downloading');
    });
    torrent.on('done', () => {
      log(`[DL] concluído: ${torrent.name}`);
      entry.finishedAt = new Date().toISOString();
      this._setState(entry, 'done'); // o app filtra instalados por state==='done'
    });
    torrent.on('error', err => {
      log(`[DL] erro em ${entry.gameName}: ${err.message}`);
      this._setState(entry, 'error', err);
    });
    torrent.on('warning', err => log(`[DL] warning ${entry.gameName}: ${err.message}`));

    log(`[DL] adicionado: ${entry.gameName} id=${entry.id}`);
    return { ok: true, download: this._snapshot(entry) };
  }

  // ---------- qBittorrent ----------

  _addQb(magnet, gameName, targetDir = this.savePath) {
    const hash = extractInfoHash(magnet);
    const entry = {
      id: hash || `qb-${Date.now()}`,
      infoHash: hash,
      gameName,
      state: 'fetching-metadata',
      torrent: null,
      kind: 'qb',
      savePath: targetDir,
      addedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      _qb: { progress: 0, downloaded: 0, length: 0, downSpeed: 0, upSpeed: 0, peers: 0 },
    };
    this.downloads.set(entry.id, entry);
    this._qbNames.set(hash, gameName);
    this.qb.addMagnet(magnet, targetDir)
      .then(() => { this._setState(entry, 'downloading'); this._pollQb(); })
      .catch(err => { this.downloads.delete(entry.id); this._setState(entry, 'error', err); });
    log(`[DL] qb adicionado: ${gameName} hash=${hash}`);
    return { ok: true, download: this._snapshot(entry) };
  }

  async _pollQb() {
    if (!this.qb) return;
    try {
      const { qbState } = require('./qbittorrent');
      const list = await this.qb.list();
      for (const t of list) {
        const hash = String(t.hash || '').toLowerCase();
        let entry = this.downloads.get(hash);
        if (!entry) {
          // Torrent que já estava no qBit (ou veio de outra sessão) → reflete no app
          entry = {
            id: hash, infoHash: hash,
            gameName: this._qbNames.get(hash) || t.name || 'download',
            state: 'downloading', torrent: null, kind: 'qb',
            savePath: t.save_path || this.savePath,
            addedAt: t.added_on ? new Date(t.added_on * 1000).toISOString() : new Date().toISOString(),
            finishedAt: null, error: null, _qb: {},
          };
          this.downloads.set(hash, entry);
        }
        entry._qb = {
          progress: t.progress, downloaded: t.downloaded, length: t.size,
          downSpeed: t.dlspeed, upSpeed: t.upspeed, peers: t.num_seeds + t.num_leechs,
        };
        const st = qbState(t);
        if (st === 'done' && !entry.finishedAt) {
          entry.finishedAt = t.completion_on > 0 ? new Date(t.completion_on * 1000).toISOString() : new Date().toISOString();
          log(`[DL] concluído (qb): ${entry.gameName}`);
        }
        if (entry.state !== st) this._setState(entry, st);
      }
    } catch (err) {
      // token expirado → re-login transparente
      try { await this.qb.login(); } catch { log(`[DL] qb poll: ${err.message}`); }
    }
  }

  // ---------- Download HTTP direto (fontes sem magnet: steamgg, datanodes...) ----------

  _addHttp(link, gameName, targetDir = this.savePath) {
    const id = `http-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fname = decodeURIComponent(path.basename(new URL(link).pathname) || `${gameName}.bin`)
      .replace(/[\\/:*?"<>|]/g, '_');
    const dest = path.join(targetDir, fname);
    const entry = {
      id, gameName, state: 'downloading', torrent: null, kind: 'http',
      savePath: dest, addedAt: new Date().toISOString(), finishedAt: null, error: null,
      _link: link,
      _http: { downloaded: 0, length: 0, ctrl: new AbortController() },
    };
    this.downloads.set(id, entry);
    this._runHttp(entry, link).catch(err => {
      if (entry.state !== 'paused') this._setState(entry, 'error', err);
    });
    log(`[DL] http adicionado: ${gameName} → ${fname}`);
    return { ok: true, download: this._snapshot(entry) };
  }

  async _runHttp(entry, link) {
    const axios = require('axios');
    const resp = await axios.get(link, {
      responseType: 'stream', timeout: 30000, signal: entry._http.ctrl.signal,
      maxRedirects: 5, headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const total = Number(resp.headers['content-length'] || 0);
    if (total) entry._http.length = total;
    const ws = fs.createWriteStream(entry.savePath);
    resp.data.on('data', chunk => {
      entry._http.downloaded += chunk.length;
    });
    await new Promise((resolve, reject) => {
      resp.data.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
      resp.data.on('error', reject);
    });
    entry.finishedAt = new Date().toISOString();
    log(`[DL] http concluído: ${entry.gameName} (${(entry._http.downloaded / 1e9).toFixed(2)} GB)`);
    this._setState(entry, 'done');
  }

  list() {
    return [...this.downloads.values()].map(e => e.kind === 'qb' ? this._snapshotQb(e) : this._snapshot(e));
  }

  _snapshotQb(entry) {
    const q = entry._qb || {};
    return {
      id: entry.id,
      gameName: entry.gameName,
      state: entry.state,
      progress: Math.round((q.progress || 0) * 1000) / 10,
      downloaded: q.downloaded || 0,
      length: q.length || 0,
      downSpeed: q.downSpeed || 0,
      upSpeed: q.upSpeed || 0,
      peers: q.peers || 0,
      savePath: entry.savePath,
      addedAt: entry.addedAt,
      finishedAt: entry.finishedAt,
      error: entry.error,
      engine: this.engineName,
    };
  }

  _find(id) {
    if (this.downloads.has(id)) return this.downloads.get(id);
    for (const e of this.downloads.values()) {
      if (e.torrent && e.torrent.infoHash === id) return e;
    }
    return null;
  }

  pause(id) {
    const e = this._find(id);
    if (!e) return { ok: false, error: 'NOT_FOUND' };
    if (e.kind === 'qb') {
      this.qb.action('pause', e.infoHash || e.id).catch(() => {});
      this._setState(e, 'paused');
      return { ok: true, download: this._snapshotQb(e) };
    }
    if (e.kind === 'http') {
      e._http.ctrl.abort();
      this._setState(e, 'paused'); // HTTP não retoma do ponto — resume reinicia
      return { ok: true, download: this._snapshot(e) };
    }
    if (typeof e.torrent.pause === 'function') e.torrent.pause();
    this._setState(e, 'paused');
    return { ok: true, download: this._snapshot(e) };
  }

  resume(id) {
    const e = this._find(id);
    if (!e) return { ok: false, error: 'NOT_FOUND' };
    if (e.kind === 'qb') {
      this.qb.action('resume', e.infoHash || e.id).catch(() => {});
      this._setState(e, 'downloading');
      return { ok: true, download: this._snapshotQb(e) };
    }
    if (e.kind === 'http') {
      e._http.ctrl = new AbortController();
      e._http.downloaded = 0;
      this._setState(e, 'downloading');
      this._runHttp(e, e._link || '').catch(err => this._setState(e, 'error', err));
      return { ok: true, download: this._snapshot(e) };
    }
    if (typeof e.torrent.resume === 'function') e.torrent.resume();
    this._setState(e, 'downloading');
    return { ok: true, download: this._snapshot(e) };
  }

  remove(id, deleteFiles = false) {
    const e = this._find(id);
    if (!e) return { ok: false, error: 'NOT_FOUND' };
    if (e.kind === 'qb') {
      this.downloads.delete(e.id);
      this._qbNames.delete(e.infoHash);
      this.qb.remove(e.infoHash || e.id, deleteFiles).catch(() => {});
      e.state = 'removed';
      this._emitUpdate(e);
      return { ok: true };
    }
    if (e.kind === 'http') {
      e._http.ctrl.abort();
      this.downloads.delete(e.id);
      if (deleteFiles) { try { fs.unlinkSync(e.savePath); } catch {} }
      e.state = 'removed';
      this._emitUpdate(e);
      return { ok: true };
    }
    const t = e.torrent;
    this.downloads.delete(e.id);
    try {
      this.client.remove(t, { destroyStore: deleteFiles }, () => {});
    } catch (err) {
      return { ok: false, error: err.message };
    }
    e.state = 'removed';
    e.torrent = null;
    this._emitUpdate(e);
    return { ok: true };
  }
}

const B32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

// Trackers públicos abertos — as fontes do catálogo às vezes trazem trackers
// privados que respondem "torrent not registered" e o download morre sem peer.
// Anexar trackers abertos + DHT faz o magnet achar peers mesmo assim.
const OPEN_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.daemon.org:6969/announce',
  'udp://opentracker.i2p.rocks:6969/announce',
  'udp://explodie.org:6969/announce',
];

function withOpenTrackers(magnet) {
  if (!magnet.startsWith('magnet:')) return magnet;
  const lower = magnet.toLowerCase();
  const add = OPEN_TRACKERS.filter(t => !lower.includes(encodeURIComponent(t)))
    .map(t => `tr=${encodeURIComponent(t)}`);
  return add.length ? `${magnet}&${add.join('&')}` : magnet;
}

function extractInfoHash(magnet) {
  const m = /xt=urn:btih:([a-zA-Z0-9]+)/i.exec(magnet);
  if (!m) return null;
  const v = m[1].toLowerCase();
  if (/^[a-f0-9]{40}$/.test(v) || /^[a-f0-9]{64}$/.test(v)) return v;
  // base32 -> hex
  try {
    let bits = 0, acc = 0, hex = '';
    for (const ch of v) {
      const idx = B32_ALPHABET.indexOf(ch);
      if (idx < 0) return null;
      acc = (acc << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        hex += ((acc >>> bits) & 0xff).toString(16).padStart(2, '0');
      }
    }
    return hex || null;
  } catch {
    return null;
  }
}

function defaultDownloadDir() {
  return process.env.UBIKA_DOWNLOAD_DIR
    || (process.platform === 'win32'
      ? 'C:\\UbikaGames'
      : path.join(os.homedir(), 'UbikaGames'));
}

module.exports = { DownloadManager, defaultDownloadDir };
