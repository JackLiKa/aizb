'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { MusicProviders } = require('./music-providers');

const EXTS = new Set(['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac']);

function normalize(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[《》「」"']/g, '');
}

class Jukebox {
  constructor({ config, logger, dataDir }) {
    this.config = config;
    this.logger = logger;
    this.dir = path.isAbsolute(config.jukebox.dir) ? config.jukebox.dir : path.join(dataDir, config.jukebox.dir);
    fs.mkdirSync(this.dir, { recursive: true });
    this.cacheDir = path.isAbsolute(config.jukebox.cacheDir || 'music-cache')
      ? config.jukebox.cacheDir
      : path.join(dataDir, config.jukebox.cacheDir || 'music-cache');
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this.providers = new MusicProviders({ config, logger });
    this.remote = new Map();
    this.index = [];
    this.indexedAt = 0;
    this.queue = [];
    this.current = null;
    this.scan();
  }

  scan() {
    const out = [];
    const walk = (dir, depth = 0) => {
      if (depth > 2) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) { walk(full, depth + 1); continue; }
        const ext = path.extname(ent.name).toLowerCase();
        if (!EXTS.has(ext)) continue;
        const rel = path.relative(this.dir, full).split(path.sep).join('/');
        const base = ent.name.slice(0, -ext.length);
        const m = base.match(/^(.+?)\s*[-–—]\s*(.+)$/);
        out.push({
          id: crypto.createHash('sha1').update(rel).digest('hex').slice(0, 12),
          title: (m ? m[2] : base).trim(),
          artist: m ? m[1].trim() : '',
          file: full,
          rel,
          url: `/media/music/${rel.split('/').map(encodeURIComponent).join('/')}`,
        });
      }
    };
    walk(this.dir);
    this.index = out;
    this.indexedAt = Date.now();
    this.logger?.info(`曲库索引完成：${out.length} 首`, { dir: this.dir });
    return out;
  }

  reloadIfStale() {
    if (Date.now() - this.indexedAt > 30000) this.scan();
  }

  search(query, limit = 5) {
    this.reloadIfStale();
    const q = normalize(query);
    if (!q) return [];
    const scored = [];
    for (const song of this.index) {
      const t = normalize(song.title);
      const a = normalize(song.artist);
      let score = 0;
      if (t === q) score = 100;
      else if (t.startsWith(q)) score = 85;
      else if (t.includes(q)) score = 70;
      else if (q.includes(t) && t.length >= 2) score = 60;
      else if (a && (a.includes(q) || q.includes(a))) score = 45;
      else {
        let hit = 0;
        for (const ch of new Set(q)) if (t.includes(ch)) hit += 1;
        if (hit / new Set(q).size >= 0.8) score = 20;
      }
      if (score > 0) scored.push({ song, score });
    }
    scored.sort((x, y) => y.score - x.score);
    return scored.slice(0, limit).map((x) => x.song);
  }

  best(query) {
    return this.search(query, 1)[0] || null;
  }

  // 在「已记住的曲目」（后台搜索/点过的在线歌、队列里的歌）里按标题/歌手模糊匹配，
  // 让观众弹幕点歌也能点到后台手工指定的歌。
  searchRemembered(query, limit = 1) {
    const q = normalize(query);
    if (!q) return [];
    const scored = [];
    for (const song of this.remote.values()) {
      const t = normalize(song.title);
      const a = normalize(song.artist);
      let score = 0;
      if (t === q) score = 100;
      else if (t.startsWith(q)) score = 85;
      else if (t.includes(q)) score = 70;
      else if (q.includes(t) && t.length >= 2) score = 60;
      else if (a && (a.includes(q) || q.includes(a))) score = 45;
      if (score > 0) scored.push({ song, score });
    }
    scored.sort((x, y) => y.score - x.score);
    return scored.slice(0, limit).map((x) => x.song);
  }

  find(id) {
    return this.index.find((s) => s.id === id) || this.remote.get(id) || null;
  }

  remember(song) {
    if (!song || !song.remote) return song;
    this.remote.set(song.id, song);
    if (this.remote.size > 200) this.remote.delete(this.remote.keys().next().value);
    return song;
  }

  async searchOnline(query, limit = 10) {
    const songs = await this.providers.search(query, { limit });
    for (const song of songs) this.remember(song);
    return songs;
  }

  async searchAll(query, limit = 20) {
    const local = this.search(query, limit).map((s) => ({ id: s.id, title: s.title, artist: s.artist, source: 'local' }));
    let online = [];
    try {
      online = await this.searchOnline(query, Math.max(4, limit - local.length));
    } catch (err) {
      this.logger?.warn?.('在线曲库搜索失败，仅返回本地曲目', { error: err.message });
    }
    const seen = new Set(local.map((s) => `${normalize(s.title)}|${normalize(s.artist)}`));
    for (const song of online) {
      const key = `${normalize(song.title)}|${normalize(song.artist)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      local.push(song);
    }
    return local.slice(0, limit);
  }

  async browse(limit = 300) {
    const out = this.list(limit).map((s) => ({ ...s, source: 'local' }));
    if (this.providers.mode === 'local') return out;
    try {
      for (const song of await this.searchOnline('', 20)) {
        if (out.some((s) => s.id === song.id)) continue;
        out.push(song);
      }
    } catch (err) {
      this.logger?.warn?.('在线曲库推荐失败，仅返回本地曲目', { error: err.message });
    }
    return out.slice(0, limit);
  }

  async bestAsync(query) {
    const local = this.best(query);
    if (local) return local;
    // 粉丝点后台已搜索/指定过的歌：先从已记住曲目里找
    const remembered = this.searchRemembered(query, 1)[0];
    if (remembered) return remembered;
    try {
      return (await this.searchOnline(query, 1))[0] || null;
    } catch (err) {
      this.logger?.warn?.('在线点歌搜索失败', { error: err.message });
      return null;
    }
  }

  /** 在线曲目先缓存到本机，舞台端仍按静态文件播放（Range / 闪避 / 口型不变）。 */
  async ensureLocal(song) {
    if (!song || !song.remote) return song;
    const name = crypto.createHash('sha1').update(song.id).digest('hex').slice(0, 16) + '.mp3';
    const dest = path.join(this.cacheDir, name);
    try {
      if (fs.statSync(dest).size > 1024) {
        return { ...song, file: dest, url: `/media/music-cache/${name}` };
      }
    } catch (_) { /* 未缓存 */ }
    if (!song.streamUrl) throw new Error('缺少音轨地址');
    // 单曲常有十几 MB，慢网下 30s 会误杀；给足 2 分钟，失败再重试一次
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120000);
      try {
        const res = await fetch(song.streamUrl, { signal: ctrl.signal, headers: { 'user-agent': 'dyzb/0.1' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 1024) throw new Error('音轨内容为空');
        const tmp = `${dest}.part`;
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, dest);
        this.pruneCache();
        this.logger?.info?.(`在线曲目已缓存：${song.title}`, { bytes: buf.length });
        return { ...song, file: dest, url: `/media/music-cache/${name}` };
      } catch (err) {
        lastErr = err;
      } finally {
        clearTimeout(timer);
        try { fs.unlinkSync(`${dest}.part`); } catch (_) { /* 未写入 */ }
      }
      await new Promise((r) => setTimeout(r, 600));
    }
    throw lastErr;
  }

  pruneCache() {
    const maxBytes = (this.config.jukebox.maxCacheMb || 512) * 1024 * 1024;
    let entries = [];
    try {
      entries = fs.readdirSync(this.cacheDir)
        .filter((n) => n.endsWith('.mp3'))
        .map((n) => {
          const file = path.join(this.cacheDir, n);
          const st = fs.statSync(file);
          return { file, size: st.size, mtime: st.mtimeMs };
        });
    } catch (_) {
      return;
    }
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    entries.sort((a, b) => a.mtime - b.mtime);
    for (const entry of entries) {
      if (total <= maxBytes) break;
      try { fs.unlinkSync(entry.file); total -= entry.size; } catch (_) { /* ignore */ }
    }
  }

  enqueue(song, by) {
    const max = this.config.jukebox.maxQueue || 10;
    if (!song) return { ok: false, reason: 'not-found' };
    if (this.queue.length >= max) return { ok: false, reason: 'full' };
    const item = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, song, by: by || '观众', ts: Date.now() };
    this.queue.push(item);
    return { ok: true, item, position: this.queue.length };
  }

  next() {
    const item = this.queue.shift() || null;
    this.current = item;
    return item;
  }

  finishCurrent() {
    this.current = null;
  }

  remove(id) {
    const idx = this.queue.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    this.queue.splice(idx, 1);
    return true;
  }

  // 手动调整队列顺序：{ index } 或 { to: 'top' | 'bottom' }
  move(id, { index, to } = {}) {
    const from = this.queue.findIndex((x) => x.id === id);
    if (from < 0) return { ok: false, reason: 'not-found' };
    let target = Number.isFinite(index) ? Math.trunc(index) : NaN;
    if (to === 'top') target = 0;
    else if (to === 'bottom') target = this.queue.length - 1;
    if (!Number.isFinite(target)) return { ok: false, reason: 'bad-target' };
    target = Math.max(0, Math.min(this.queue.length - 1, target));
    if (target === from) return { ok: true, index: from };
    const [item] = this.queue.splice(from, 1);
    this.queue.splice(target, 0, item);
    return { ok: true, index: target };
  }

  clear() {
    this.queue = [];
  }

  snapshot() {
    return {
      total: this.index.length,
      current: this.current ? { id: this.current.id, title: this.current.song.title, artist: this.current.song.artist, by: this.current.by } : null,
      queue: this.queue.map((x) => ({ id: x.id, title: x.song.title, artist: x.song.artist, by: x.by })),
    };
  }

  list(limit = 200) {
    this.reloadIfStale();
    return this.index.slice(0, limit).map((s) => ({ id: s.id, title: s.title, artist: s.artist }));
  }
}

module.exports = { Jukebox };
