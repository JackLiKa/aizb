'use strict';

const fs = require('fs');
const path = require('path');

class Store {
  constructor(file, logger) {
    this.file = file;
    this.logger = logger;
    this.data = {};
    this._timer = null;
    this._dirty = false;
    this.load();
  }

  load() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (fs.existsSync(this.file)) {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      }
    } catch (err) {
      const backup = `${this.file}.broken-${Date.now()}`;
      try { fs.renameSync(this.file, backup); } catch (_) { /* ignore */ }
      this.logger?.warn(`state.json 损坏，已备份到 ${backup}`, { error: err.message });
      this.data = {};
    }
  }

  get(key, fallback) {
    const v = this.data[key];
    return v === undefined ? fallback : v;
  }

  set(key, value) {
    this.data[key] = value;
    this.saveSoon();
  }

  saveSoon() {
    if (this._closed) return;
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, 800);
    if (this._timer.unref) this._timer.unref();
  }

  close() {
    this._closed = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this.flush();
  }

  flush() {
    if (!this._dirty) return;
    this._dirty = false;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.logger?.error('保存 state.json 失败', { error: err.message });
    }
  }
}

module.exports = { Store };
