'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  async run(fn) {
    if (this.active >= this.limit) {
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}

class Voice {
  constructor({ config, logger, dataDir, mediaPrefix = '/media/tts' }) {
    this.config = config;
    this.logger = logger;
    this.dir = path.join(dataDir, 'tts-cache');
    this.mediaPrefix = mediaPrefix;
    fs.mkdirSync(this.dir, { recursive: true });
    this.sem = new Semaphore(3);
    this._edge = null;
    this._edgeVoice = null;
    this._cleanup();
  }

  _cleanup() {
    try {
      const now = Date.now();
      const files = fs.readdirSync(this.dir)
        .filter((f) => f.endsWith('.mp3'))
        .map((f) => ({ f, p: path.join(this.dir, f), t: fs.statSync(path.join(this.dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      files.forEach((item, i) => {
        if (i > 400 || now - item.t > 7 * 86400e3) fs.rmSync(item.p, { force: true });
      });
    } catch (_) { /* ignore */ }
  }

  get provider() {
    return String(this.config.tts.provider || 'none').toLowerCase();
  }

  _cacheKey(text) {
    const t = this.config.tts;
    const raw = [this.provider, t.voice, t.rate, t.pitch, t.volume, t.openai?.model, t.openai?.voice, text].join('|');
    return crypto.createHash('sha1').update(raw).digest('hex');
  }

  async synthesize(text) {
    const clean = String(text || '').trim();
    const chars = clean.length;
    if (!clean) return { ok: false, chars: 0, reason: 'empty' };
    if (this.provider === 'none') return { ok: false, chars, reason: 'disabled' };

    const key = this._cacheKey(clean);
    const file = path.join(this.dir, `${key}.mp3`);
    const url = `${this.mediaPrefix}/${key}.mp3`;
    if (this.config.tts.cache !== false && fs.existsSync(file) && fs.statSync(file).size > 200) {
      return { ok: true, url, chars, cached: true };
    }

    try {
      const buf = await this.sem.run(() => this._synth(clean));
      if (!buf || buf.length < 200) throw new Error('音频数据为空');
      fs.writeFileSync(file, buf);
      return { ok: true, url, chars, cached: false };
    } catch (err) {
      this.logger?.error(`TTS 合成失败: ${err.message}`, { text: clean.slice(0, 40) });
      return { ok: false, chars, reason: err.message };
    }
  }

  async _synth(text) {
    if (this.provider === 'openai') return this._synthOpenAI(text);
    return this._synthEdge(text);
  }

  async _synthEdge(text) {
    const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
    const voice = this.config.tts.voice || 'zh-CN-XiaoxiaoNeural';
    if (!this._edge || this._edgeVoice !== voice) {
      if (this._edge) {
        try { this._edge.close(); } catch (_) { /* ignore */ }
      }
      this._edge = new MsEdgeTTS({ connectionTimeoutMs: 10000, synthesisTimeoutMs: 30000 });
      await this._edge.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      this._edgeVoice = voice;
    }
    const { audioStream } = this._edge.toStream(escapeXml(text), {
      rate: this.config.tts.rate || '+0%',
      pitch: this.config.tts.pitch || '+0Hz',
      volume: this.config.tts.volume || '+0%',
    });
    const chunks = [];
    for await (const chunk of audioStream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  async _synthOpenAI(text) {
    const o = this.config.tts.openai || {};
    if (!o.baseURL || !o.apiKey) throw new Error('tts.openai 未配置 baseURL/apiKey');
    const base = String(o.baseURL).replace(/\/+$/, '');
    const url = base.endsWith('/audio/speech') ? base : `${base}/audio/speech`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.apiKey}` },
      body: JSON.stringify({ model: o.model || 'tts-1', voice: o.voice || 'alloy', input: text, response_format: 'mp3' }),
    });
    if (!res.ok) throw new Error(`OpenAI TTS ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

module.exports = { Voice };
