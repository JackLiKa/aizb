'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

  clear() {
    this.queue = [];
  }

  snapshot() {
    return {
      total: this.index.length,
      current: this.current ? { id: this.current.id, title: this.current.song.title, artist: this.current.song.artist, by: this.current.by } : null,
      queue: this.queue.slice(0, 8).map((x) => ({ id: x.id, title: x.song.title, artist: x.song.artist, by: x.by })),
    };
  }

  list(limit = 200) {
    this.reloadIfStale();
    return this.index.slice(0, limit).map((s) => ({ id: s.id, title: s.title, artist: s.artist }));
  }
}

module.exports = { Jukebox };
