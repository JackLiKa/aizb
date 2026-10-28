function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

export class AudioEngine {
  constructor({ onClipStart, onUtteranceFinished, onMusicEnded, onMouth } = {}) {
    this.onClipStart = onClipStart;
    this.onUtteranceFinished = onUtteranceFinished;
    this.onMusicEnded = onMusicEnded;
    this.onMouth = onMouth;

    this.ctx = null;
    this.queue = [];
    this.pending = new Map();
    this.playing = false;
    this.currentEl = null;
    this.currentClip = null;
    this._currentFinish = null;
    this.playToken = 0;
    this.silentUntil = 0;
    this.smoothMouth = 0;
    this.musicEl = null;
    this.musicInfo = null;
    this._musicMuted = false;
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.ctx.destination);

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.55;
    this.voiceBus = this.ctx.createGain();
    this.voiceBus.gain.value = 1;
    this.voiceBus.connect(this.analyser);
    this.analyser.connect(this.master);

    this.bgmGain = this.ctx.createGain();
    this.bgmGain.gain.value = 0.24;
    this.bgmGain.connect(this.master);

    this._mouthBuf = new Uint8Array(this.analyser.fftSize);
    this._loopMouth();

    const resume = () => {
      if (this.ctx.state === 'suspended') this.ctx.resume();
    };
    document.addEventListener('pointerdown', resume, { passive: true });
    document.addEventListener('keydown', resume, { passive: true });
    resume();
  }

  _loopMouth() {
    const tick = () => {
      requestAnimationFrame(tick);
      let level = 0;
      if (this.playing) {
        if (this.currentEl && this.analyser) {
          this.analyser.getByteTimeDomainData(this._mouthBuf);
          let sum = 0;
          for (let i = 0; i < this._mouthBuf.length; i += 1) {
            const v = (this._mouthBuf[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / this._mouthBuf.length);
          level = clamp(rms * 4.2, 0, 1);
        } else if (performance.now() < this.silentUntil) {
          const t = performance.now() / 1000;
          level = clamp(0.22 + 0.16 * Math.sin(t * 12.5) + 0.1 * Math.sin(t * 21.7), 0, 0.7);
        }
      }
      this.smoothMouth += (level - this.smoothMouth) * 0.35;
      this.onMouth?.(this.smoothMouth);
    };
    requestAnimationFrame(tick);
  }

  enqueue(clip) {
    const id = clip.utteranceId;
    let entry = this.pending.get(id);
    if (!entry) {
      entry = { remaining: 0, done: false };
      this.pending.set(id, entry);
    }
    entry.remaining += 1;
    this.queue.push(clip);
    this._pump();
  }

  markDone(utteranceId) {
    const entry = this.pending.get(utteranceId);
    if (!entry) return;
    entry.done = true;
    this._finishIfReady(utteranceId);
  }

  _finishIfReady(id) {
    const entry = this.pending.get(id);
    if (!entry) return;
    if (entry.done && entry.remaining <= 0) {
      this.pending.delete(id);
      this.onUtteranceFinished?.(id);
    }
  }

  async _pump() {
    if (this.playing) return;
    const clip = this.queue.shift();
    if (!clip) return;
    this.playing = true;
    this._duck(true);
    const token = this.playToken;
    try {
      await this._playClip(clip, token);
    } catch (_) {
      /* ignore */
    }
    if (token === this.playToken) {
      const entry = this.pending.get(clip.utteranceId);
      if (entry) entry.remaining -= 1;
      this._finishIfReady(clip.utteranceId);
    }
    this.playing = false;
    this.currentClip = null;
    this.currentEl = null;
    if (this.queue.length) {
      this._pump();
    } else {
      this._duck(false);
      this.silentUntil = 0;
    }
  }

  _playClip(clip, token) {
    this.currentClip = clip;
    this.onClipStart?.(clip.text);
    if (clip.url) {
      return new Promise((resolve) => {
        const el = new Audio(clip.url);
        el.preload = 'auto';
        let src = null;
        try {
          src = this.ctx.createMediaElementSource(el);
          src.connect(this.voiceBus);
        } catch (_) { /* 忽略重复 source */ }

        const finish = () => {
          if (el._finished) return;
          el._finished = true;
          el.onended = null;
          el.onerror = null;
          try { el.pause(); } catch (_) { /* ignore */ }
          try { if (src) src.disconnect(); } catch (_) { /* ignore */ }
          if (this._currentFinish === finish) this._currentFinish = null;
          resolve();
        };
        this._currentFinish = finish;
        el.onended = finish;
        el.onerror = () => setTimeout(finish, 400);
        this.currentEl = el;
        this.ctx.resume().catch(() => {});
        el.play().catch(() => setTimeout(finish, 600));
        setTimeout(finish, Math.max(10000, clip.text.length * 400 + 8000));
        if (token !== this.playToken) finish();
      });
    }
    this.silentUntil = performance.now() + Math.max(1200, Math.min(12000, clip.text.length * 165));
    return new Promise((resolve) => {
      let done = false;
      const ms = Math.max(1200, Math.min(12000, clip.text.length * 165));
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this._currentFinish === finish) this._currentFinish = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this._currentFinish = finish;
      if (token !== this.playToken) finish();
    });
  }

  interrupt() {
    this.playToken += 1;
    this.queue = [];
    this.pending.clear();
    this.silentUntil = 0;
    if (this._currentFinish) {
      const fn = this._currentFinish;
      this._currentFinish = null;
      try { fn(); } catch (_) { /* ignore */ }
    }
    if (this.currentEl) {
      try { this.currentEl.pause(); } catch (_) { /* ignore */ }
      this.currentEl = null;
    }
    this.playing = false;
    this.currentClip = null;
    this._duck(false);
    this.onClipStart?.('');
  }

  _duck(on) {
    if (!this.bgmGain) return;
    const now = this.ctx.currentTime;
    const target = on ? 0.05 : 0.24;
    try {
      this.bgmGain.gain.cancelScheduledValues(now);
      this.bgmGain.gain.setTargetAtTime(target, now, 0.12);
    } catch (_) { /* ignore */ }
  }

  playMusic(info) {
    this.stopMusic(true);
    if (!info || !info.url) return;
    const el = new Audio(info.url);
    el.preload = 'auto';
    let src = null;
    try {
      src = this.ctx.createMediaElementSource(el);
      src.connect(this.bgmGain);
    } catch (_) { /* ignore */ }
    this.musicEl = el;
    this.musicInfo = info;
    el.onended = () => {
      if (this.musicEl !== el) return;
      this.musicEl = null;
      this.musicInfo = null;
      this.onMusicEnded?.();
    };
    el.onerror = () => {
      if (this.musicEl !== el) return;
      this.musicEl = null;
      this.musicInfo = null;
      this.onMusicEnded?.();
    };
    this.ctx.resume().catch(() => {});
    el.play().catch(() => {
      if (this.musicEl !== el) return;
      this.musicEl = null;
      this.musicInfo = null;
      this.onMusicEnded?.();
    });
  }

  stopMusic() {
    const el = this.musicEl;
    if (el) {
      el.onended = null;
      el.onerror = null;
      try { el.pause(); } catch (_) { /* ignore */ }
      try { el.src = ''; } catch (_) { /* ignore */ }
    }
    this.musicEl = null;
    this.musicInfo = null;
  }
}
