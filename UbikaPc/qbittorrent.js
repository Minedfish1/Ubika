const axios = require('axios');

const log = (...args) => console.log(new Date().toISOString(), ...args);

/**
 * Backend qBittorrent (WebUI API v2) para o DownloadManager.
 * O qBittorrent usa o libtorrent de verdade (uTP/TCP/DHT completos) —
 * resolve o "uTP not supported" do WebTorrent em magnets com poucos peers TCP.
 *
 * Config (.env):
 *   UBIKA_QB_URL   (default http://127.0.0.1:8080)
 *   UBIKA_QB_USER  (default admin)
 *   UBIKA_QB_PASS  (default adminadmin — troque na WebUI do qBittorrent)
 */
class QBittorrentBackend {
  constructor() {
    this.base = (process.env.UBIKA_QB_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
    this.user = process.env.UBIKA_QB_USER || 'admin';
    this.pass = process.env.UBIKA_QB_PASS || 'adminadmin';
    this.cookie = '';
    this.api = axios.create({ baseURL: this.base, timeout: 15000 });
    // Cookie de sessão do WebUI
    this.api.interceptors.request.use(cfg => {
      if (this.cookie) cfg.headers.Cookie = this.cookie;
      return cfg;
    });
    this.api.interceptors.response.use(res => {
      const sc = res.headers['set-cookie'];
      if (sc?.[0]) this.cookie = sc[0].split(';')[0];
      return res;
    });
  }

  /** Testa se há um qBittorrent WebUI respondendo (probe rápido, sem login). */
  async probe() {
    try {
      const r = await this.api.get('/api/v2/app/webapiVersion', { timeout: 3000 });
      return typeof r.data === 'string' && r.data.trim().length > 0;
    } catch { return false; }
  }

  async login() {
    const body = `username=${encodeURIComponent(this.user)}&password=${encodeURIComponent(this.pass)}`;
    const r = await this.api.post('/api/v2/auth/login', body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (String(r.data).trim() !== 'Ok.') throw new Error('QB_LOGIN_FAILED (confira UBIKA_QB_USER/UBIKA_QB_PASS)');
  }

  async addMagnet(magnet, savePath) {
    const body = `urls=${encodeURIComponent(magnet)}&savepath=${encodeURIComponent(savePath)}&paused=false`;
    await this.api.post('/api/v2/torrents/add', body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  async list() {
    const r = await this.api.get('/api/v2/torrents/info');
    return r.data || [];
  }

  async action(action, hash, extra = {}) {
    // qBittorrent 5.x renomeou pause/resume → stop/start — tenta os dois
    const pairs = action === 'pause' ? ['pause', 'stop']
      : action === 'resume' ? ['resume', 'start']
      : [action];
    let lastErr = null;
    for (const ep of pairs) {
      try {
        const qs = new URLSearchParams({ hashes: hash, ...extra }).toString();
        await this.api.post(`/api/v2/torrents/${ep}?${qs}`);
        return;
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  async remove(hash, deleteFiles) {
    const qs = new URLSearchParams({ hashes: hash, deleteFiles: String(Boolean(deleteFiles)) }).toString();
    await this.api.post(`/api/v2/torrents/delete?${qs}`);
  }
}

/** Mapeia estado do qBit para o estado interno do manager. */
function qbState(t) {
  if (t.progress >= 1 || ['uploading', 'stalledUP', 'queuedUP', 'checkingUP', 'forcedUP'].includes(t.state)) {
    return t.progress >= 1 ? 'done' : 'downloading';
  }
  if (['pausedDL', 'stoppedDL'].includes(t.state)) return 'paused';
  if (['error', 'missingFiles'].includes(t.state)) return 'error';
  if (t.state === 'metaDL') return 'fetching-metadata';
  return 'downloading';
}

module.exports = { QBittorrentBackend, qbState };
