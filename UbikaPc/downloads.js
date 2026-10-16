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
    this.downloads = new Map(); // id -> entry
    this.client = null;
    this.engineName = 'none';
    this._tick = null;
  }

  // webtorrent 1.9.7 (CJS estável; 2.x quebra com parse-torrent >=11.0.24)
  async init() {
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
    }, 2000);
    if (this._tick.unref) this._tick.unref();
  }

  _snapshot(entry) {
    const t = entry.torrent;
    return {
      id: entry.id,
      gameName: entry.gameName,
      state: entry.state,
      progress: t ? Math.round(t.progress * 1000) / 10 : 0, // %
      downloaded: t ? t.downloaded : 0,
      length: t ? t.length : 0,
      downSpeed: t ? t.downloadSpeed : 0,
      upSpeed: t ? t.uploadSpeed : 0,
      peers: t ? t.numPeers : 0,
      savePath: entry.savePath,
      addedAt: entry.addedAt,
      finishedAt: entry.finishedAt || null,
      error: entry.error || null,
      engine: this.engineName,
    };
  }

  _emitUpdate(entry) {
    try { this.onUpdate(this._snapshot(entry)); } catch {}
  }

  _setState(entry, state, err) {
    entry.state = state;
    if (err) entry.error = String(err.message || err);
    this._emitUpdate(entry);
  }

  add({ magnet, gameName }) {
    if (!this.client) return { ok: false, error: 'ENGINE_UNAVAILABLE' };
    magnet = String(magnet || '').trim();
    if (!magnet.startsWith('magnet:')) return { ok: false, error: 'INVALID_MAGNET' };

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
      savePath: this.savePath,
      addedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    };

    let torrent;
    try {
      torrent = this.client.add(magnet, { path: this.savePath });
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
      this._setState(entry, 'finished');
    });
    torrent.on('error', err => {
      log(`[DL] erro em ${entry.gameName}: ${err.message}`);
      this._setState(entry, 'error', err);
    });
    torrent.on('warning', err => log(`[DL] warning ${entry.gameName}: ${err.message}`));

    log(`[DL] adicionado: ${entry.gameName} id=${entry.id}`);
    return { ok: true, download: this._snapshot(entry) };
  }

  list() {
    return [...this.downloads.values()].map(e => this._snapshot(e));
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
    if (typeof e.torrent.pause === 'function') e.torrent.pause();
    this._setState(e, 'paused');
    return { ok: true, download: this._snapshot(e) };
  }

  resume(id) {
    const e = this._find(id);
    if (!e) return { ok: false, error: 'NOT_FOUND' };
    if (typeof e.torrent.resume === 'function') e.torrent.resume();
    this._setState(e, 'downloading');
    return { ok: true, download: this._snapshot(e) };
  }

  remove(id, deleteFiles = false) {
    const e = this._find(id);
    if (!e) return { ok: false, error: 'NOT_FOUND' };
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
      ? 'C:\\UbikaGames\\Downloads'
      : path.join(os.homedir(), 'UbikaGames', 'Downloads'));
}

module.exports = { DownloadManager, defaultDownloadDir };
