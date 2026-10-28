'use strict';

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function localDay(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

class Logger {
  constructor({ dir, maxFiles = 7, ringSize = 500, level = 'info' } = {}) {
    this.dir = dir;
    this.maxFiles = maxFiles;
    this.ringSize = ringSize;
    this.level = LEVELS[level] ? level : 'info';
    this.ring = [];
    this._day = null;
    this._stream = null;
    fs.mkdirSync(dir, { recursive: true });
    this._cleanup();
  }

  _cleanup() {
    try {
      const files = fs.readdirSync(this.dir)
        .filter((f) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(f))
        .sort();
      while (files.length > this.maxFiles) {
        fs.rmSync(path.join(this.dir, files.shift()), { force: true });
      }
    } catch (_) { /* ignore */ }
  }

  _streamForDay(day) {
    if (this._day === day && this._stream) return this._stream;
    if (this._stream) {
      try { this._stream.end(); } catch (_) { /* ignore */ }
    }
    this._day = day;
    this._stream = fs.createWriteStream(path.join(this.dir, `app-${day}.log`), { flags: 'a' });
    this._stream.on('error', () => { this._stream = null; });
    return this._stream;
  }

  _write(level, tag, msg, meta) {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const now = new Date();
    const entry = { ts: now.toISOString(), level, tag, msg };
    if (meta && typeof meta === 'object') {
      for (const [k, v] of Object.entries(meta)) {
        if (v instanceof Error) entry[k] = v.message;
        else if (v !== undefined) entry[k] = v;
      }
    }
    this.ring.push(entry);
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
    const line = `${entry.ts} ${level.toUpperCase().padEnd(5)} [${tag}] ${msg}` +
      (Object.keys(entry).length > 4 ? ` ${JSON.stringify(entry).slice(JSON.stringify(entry).indexOf('{') + 1, -1)}` : '');
    // eslint-disable-next-line no-console
    console.log(line);
    try {
      this._streamForDay(localDay(now)).write(`${JSON.stringify(entry)}\n`);
    } catch (_) { /* ignore */ }
  }

  debug(msg, meta) { this._write('debug', 'app', msg, meta); }

  info(msg, meta) { this._write('info', 'app', msg, meta); }

  warn(msg, meta) { this._write('warn', 'app', msg, meta); }

  error(msg, meta) { this._write('error', 'app', msg, meta); }

  child(tag) {
    return {
      debug: (msg, meta) => this._write('debug', tag, msg, meta),
      info: (msg, meta) => this._write('info', tag, msg, meta),
      warn: (msg, meta) => this._write('warn', tag, msg, meta),
      error: (msg, meta) => this._write('error', tag, msg, meta),
      child: (sub) => this.child(`${tag}:${sub}`),
      recent: (n) => this.recent(n),
    };
  }

  recent(n = 100) {
    return this.ring.slice(-n);
  }

  close() {
    if (this._stream) {
      try { this._stream.end(); } catch (_) { /* ignore */ }
      this._stream = null;
    }
  }
}

module.exports = { Logger, localDay };
