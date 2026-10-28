'use strict';

const PRIORITY = { gift: 100, manual: 95, song: 70, follow: 55, comment: 30, enter: 18, like: 10 };

const SONG_RE = /(?:点歌|来一首|来首|唱一?首|放一?首|放个|想听)\s*[:：]?\s*(.{1,24})$/;

function abortError() {
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

function cutIndex(text) {
  const m = text.match(/[。！？!?；;\n]/);
  return m ? m.index : -1;
}

class Director {
  constructor({ config, logger, brain, voice, jukebox, metering, store, send, hasStage }) {
    this.config = config;
    this.logger = logger;
    this.brain = brain;
    this.voice = voice;
    this.jukebox = jukebox;
    this.metering = metering;
    this.store = store;
    this.send = send || (() => {});
    this.hasStage = hasStage || (() => false);

    this.queue = [];
    this.busy = false;
    this.paused = false;
    this.history = [];
    this.userCooldown = new Map();
    this.enterCooldown = new Map();
    this.songCooldown = new Map();
    this.recentTexts = new Map();
    this.pendingUtterances = new Map();
    this.current = null;
    this.currentState = 'idle';
    this.utteranceSeq = 0;
    this.taskSeq = 0;
    this.draft = null;
    this.draftSeq = 0;
    this.startedAt = Date.now();
    this.stats = { handled: 0, speaks: 0, welcomes: 0, errors: 0, dropped: 0, interrupted: 0 };
    this._timer = null;
    this._overlayTimer = null;
  }

  start() {
    this._overlayTimer = setInterval(() => this._broadcastOverlay(), 5000);
    if (this._overlayTimer.unref) this._overlayTimer.unref();
  }

  stop() {
    clearInterval(this._overlayTimer);
    clearTimeout(this._timer);
    this.interrupt('shutdown');
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
    this.logger.info(`自动回复已${this.paused ? '暂停' : '恢复'}`);
  }

  // ---------- 事件入口 ----------

  push(raw) {
    const ev = this._normalize(raw);
    if (!ev) return;
    if (ev.type !== 'manual') this.send({ type: 'feed', event: this._publicEvent(ev) });

    if (ev.type === 'like') return;
    if (ev.type === 'enter' && this.config.behavior?.welcomeEnabled === false) return;
    if (!this._accept(ev)) return;

    const task = { ev, priority: PRIORITY[ev.type] || 20, seq: ++this.taskSeq };
    let idx = this.queue.findIndex((x) => x.priority < task.priority);
    if (idx < 0) this.queue.push(task);
    else this.queue.splice(idx, 0, task);

    if (this.queue.length > (this.config.behavior.maxQueue || 24)) {
      for (let i = this.queue.length - 1; i >= 0; i -= 1) {
        if (this.queue[i].priority <= 30) { this.queue.splice(i, 1); this.stats.dropped += 1; break; }
      }
      if (this.queue.length > (this.config.behavior.maxQueue || 24)) this.queue.pop();
    }

    if (ev.type === 'gift' && this.config.behavior.interruptOnGift && this.busy) {
      this.stats.interrupted += 1;
      this.interrupt('gift');
    }
    this._schedule(60);
  }

  say(text, user = '房主') {
    this.push({ type: 'manual', user, text: String(text || '').slice(0, 120) });
  }

  _normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const type = ['comment', 'gift', 'like', 'follow', 'enter', 'song', 'manual'].includes(raw.type) ? raw.type : 'comment';
    const ev = {
      id: raw.id || `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      type,
      user: String(raw.user || raw.nickname || raw.uname || '匿名观众').slice(0, 24),
      text: String(raw.text || raw.content || raw.msg || '').slice(0, 200).trim(),
      giftName: raw.giftName || raw.gift || raw.gift_name || '',
      count: Math.max(1, Number(raw.count || raw.num || raw.repeat_count) || 1),
      value: Number(raw.value || raw.price || 0) || 0,
      query: raw.query ? String(raw.query).slice(0, 24) : '',
      song: raw.song || null,
      ts: Number(raw.ts) || Date.now(),
    };
    if (ev.type === 'comment') {
      const m = ev.text.match(SONG_RE);
      if (m && m[1].trim()) {
        ev.type = 'song';
        ev.query = m[1].trim();
      }
    }
    if (ev.type === 'song' && !ev.query && ev.text) ev.query = ev.text;
    return ev;
  }

  _publicEvent(ev) {
    return {
      id: ev.id,
      type: ev.type,
      user: ev.user,
      text: ev.text,
      giftName: ev.giftName,
      count: ev.count,
      value: ev.value,
      query: ev.query,
      ts: ev.ts,
    };
  }

  _accept(ev) {
    const now = Date.now();
    if (this.paused && ev.type !== 'manual' && ev.type !== 'gift') return false;

    // 进场欢迎：每个观众默认 10 分钟内只欢迎一次，避免刷屏
    if (ev.type === 'enter') {
      if (this.config.behavior?.welcomeEnabled === false) return false;
      const lastEnter = this.enterCooldown.get(ev.user) || 0;
      if (now - lastEnter < (this.config.behavior.welcomeCooldownSec || 600) * 1000) return false;
      this.enterCooldown.set(ev.user, now);
      if (this.enterCooldown.size > 500) {
        for (const [k, t] of this.enterCooldown) if (now - t > 3600000) this.enterCooldown.delete(k);
      }
      return true;
    }

    if (ev.type === 'comment' || ev.type === 'follow') {
      const last = this.userCooldown.get(ev.user) || 0;
      if (now - last < (this.config.behavior.userCooldownSec || 25) * 1000) return false;

      if (ev.type === 'comment') {
        if (ev.text.length < 1) return false;
        const key = `${ev.user}|${ev.text}`;
        const seen = this.recentTexts.get(key) || 0;
        if (now - seen < (this.config.behavior.dedupeWindowSec || 60) * 1000) return false;
        this.recentTexts.set(key, now);
        if (this.recentTexts.size > 500) {
          for (const [k, t] of this.recentTexts) if (now - t > 300000) this.recentTexts.delete(k);
        }
        const night = this._isNight();
        const ask = /[?？]|吗|怎么|为什么|啥|什么|能不能|可不可以|在不在/.test(ev.text);
        const p = ask ? 1 : (night ? (this.config.night.replyProbability ?? 0.08) : (this.config.behavior.replyProbability ?? 0.5));
        if (Math.random() > p) return false;
      } else if (Math.random() > 0.6) {
        return false;
      }
      this.userCooldown.set(ev.user, now);
      return true;
    }

    if (ev.type === 'song') {
      const last = this.songCooldown.get(ev.user) || 0;
      if (now - last < (this.config.jukebox.perUserCooldownSec || 300) * 1000) return false;
      this.songCooldown.set(ev.user, now);
      return true;
    }

    return true;
  }

  // ---------- 队列 ----------

  _schedule(delay) {
    if (this.busy || this._timer || !this.queue.length) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._loop();
    }, delay || 50);
  }

  async _loop() {
    if (this.busy) return;
    const task = this.queue.shift();
    if (!task) {
      this._setState(this.jukebox.current ? 'singing' : 'idle');
      return;
    }
    this.busy = true;
    try {
      await this._handle(task.ev);
      this.stats.handled += 1;
    } catch (err) {
      if (err.name !== 'AbortError') {
        this.stats.errors += 1;
        this.logger.error(`处理事件失败: ${err.message}`, { type: task.ev.type });
      }
    } finally {
      this.busy = false;
      this.current = null;
      this._setState(this.jukebox.current ? 'singing' : 'idle');
      this._broadcastOverlay();
      if (this.queue.length) {
        this._schedule(Math.max(80, (this.config.behavior.minIntervalSec || 0) * 1000));
      }
    }
  }

  // ---------- 处理 ----------

  async _handle(ev) {
    if (ev.type === 'enter') {
      this.stats.welcomes += 1;
      this.send({ type: 'emote', name: 'happy' });
      await this._talk(ev, { maxTokens: 60 });
      return;
    }
    if (ev.type === 'gift') {
      this.metering.recordGift(ev.user, ev.giftName || '礼物', ev.count, ev.value);
      this._broadcastOverlay();
      this.send({ type: 'emote', name: 'gift', event: this._publicEvent(ev) });
      await this._talk(ev, { maxTokens: 60 });
      return;
    }
    if (ev.type === 'follow') {
      this.send({ type: 'emote', name: 'happy' });
      await this._talk(ev);
      return;
    }
    if (ev.type === 'song') {
      await this._handleSong(ev);
      return;
    }
    await this._talk(ev);
  }

  async _handleSong(ev) {
    const cfg = this.config.jukebox;
    ev.song = ev.song || (cfg.enabled ? this.jukebox.best(ev.query) : null);
    if (!cfg.enabled) {
      ev.song = null;
      await this._talk(ev);
      return;
    }
    if (!ev.song) {
      await this._talk(ev);
      return;
    }
    const res = this.jukebox.enqueue(ev.song, ev.user);
    if (!res.ok) {
      ev.song = null;
      await this._talk(ev);
      return;
    }
    this.metering.recordSong();
    this.logger.info(`${ev.user} 点歌《${ev.song.title}》`, { position: res.position });
    this._broadcastOverlay();
    await this._talk(ev);
    if (!this.jukebox.current) this._startNextSong();
  }

  async _talk(ev, opts = {}) {
    const controller = new AbortController();
    this.current = { controller };
    const night = this._isNight();
    const maxTokens = night
      ? Math.min(this.config.night.maxTokens || 60, this.config.llm.maxTokens || 120)
      : (opts.maxTokens || this.config.llm.maxTokens || 120);

    let reply = '';
    const gen = this.brain.stream({
      event: ev,
      history: this.history,
      signal: controller.signal,
      maxTokens,
      stateHint: this._stateHint(),
      onUsage: (u) => {
        this.metering.recordLLM(u);
        this._broadcastOverlay();
      },
    });

    // 人工确认模式（合规：真人驱动/值守）：只生成草稿，等真人在控制台点「发送」才播报
    if (this.config.compliance?.humanInLoop) {
      let text = '';
      for await (const delta of gen) {
        if (controller.signal.aborted) throw abortError();
        text += delta;
      }
      text = text.trim();
      if (text) {
        this.draftSeq += 1;
        this.draft = { id: `d${this.draftSeq}`, text, event: this._publicEvent(ev), ts: Date.now() };
        reply = text;
        this.logger.info(`AI 草稿待人工确认：${text.slice(0, 40)}`);
        this._broadcastOverlay();
      }
    } else {
      const full = await this._speak(gen, controller.signal);
      if (full) reply = full;
    }
    this.history.push({ role: 'user', content: this._historyLine(ev) });
    this.history.push({ role: 'assistant', content: reply || '……' });
    const keep = Math.max(2, (this.config.llm.historyTurns || 8) * 2);
    if (this.history.length > keep) this.history.splice(0, this.history.length - keep);
  }

  // ---------- 人工确认（合规） ----------

  // 真人点「发送」：把 AI 草稿原样播报出来（不再调用 LLM）
  async speakExact(text) {
    const clean = String(text || '').trim().slice(0, 200);
    if (!clean) return { ok: false, error: 'empty' };
    if (this.busy) return { ok: false, error: 'busy' };
    this.draft = null;
    const controller = new AbortController();
    this.current = { controller };
    this.busy = true;
    try {
      const gen = (async function* once() { yield clean; })();
      await this._speak(gen, controller.signal);
      this.history.push({ role: 'assistant', content: clean });
      const keep = Math.max(2, (this.config.llm.historyTurns || 8) * 2);
      if (this.history.length > keep) this.history.splice(0, this.history.length - keep);
    } catch (err) {
      if (err.name !== 'AbortError') this.logger.error(`播报草稿失败: ${err.message}`);
      return { ok: false, error: err.message };
    } finally {
      this.busy = false;
      this.current = null;
      this._setState(this.jukebox.current ? 'singing' : 'idle');
      this._broadcastOverlay();
    }
    return { ok: true };
  }

  discardDraft(id) {
    if (!this.draft) return false;
    if (id && this.draft.id !== id) return false;
    this.draft = null;
    this._broadcastOverlay();
    return true;
  }

  _historyLine(ev) {
    if (ev.type === 'gift') return `观众${ev.user}送了${ev.giftName}×${ev.count}`;
    if (ev.type === 'enter') return `观众${ev.user}进入了直播间`;
    if (ev.type === 'song') return ev.song ? `观众${ev.user}点了《${ev.song.title}》` : `观众${ev.user}想点《${ev.query}》，没有找到`;
    if (ev.type === 'follow') return `观众${ev.user}关注了直播间`;
    if (ev.type === 'manual') return `（房主指示）${ev.text}`;
    return `观众${ev.user}说：${ev.text}`;
  }

  async _speak(gen, signal) {
    const utteranceId = `u${++this.utteranceSeq}`;
    const maxChars = this.config.behavior.sentenceMaxChars || 40;
    let buf = '';
    let full = '';
    let seq = 0;
    const pending = [];

    const sendClip = (clip) => {
      if (signal.aborted) throw abortError();
      this._setState('speaking');
      this.send({ type: 'say', utteranceId, seq: clip.seq, text: clip.text, url: clip.url });
    };

    const queueSentence = (text) => {
      const t = text.trim();
      if (!t || !/[\p{L}\p{N}]/u.test(t)) return;
      seq += 1;
      const mySeq = seq;
      pending.push((async () => {
        const res = await this.voice.synthesize(t);
        if (res.ok) this.metering.recordTTS(res.chars);
        return { seq: mySeq, text: t, url: res.ok ? res.url : null };
      })());
    };

    for await (const delta of gen) {
      if (signal.aborted) throw abortError();
      full += delta;
      buf += delta;
      let idx;
      while ((idx = cutIndex(buf)) >= 0) {
        queueSentence(buf.slice(0, idx + 1));
        buf = buf.slice(idx + 1);
      }
      while (buf.length >= maxChars) {
        queueSentence(buf.slice(0, maxChars));
        buf = buf.slice(maxChars);
      }
      while (pending.length > 2) sendClip(await pending.shift());
    }

    if (buf.trim()) queueSentence(buf);
    while (pending.length) sendClip(await pending.shift());

    if (seq === 0) return '';

    this.send({ type: 'say:done', utteranceId, total: seq });
    this.metering.recordSpeak();
    this.stats.speaks += 1;

    if (this.hasStage()) {
      await this._waitUtterance(utteranceId, Math.max(5000, full.length * 220 + 4000));
    }
    return full;
  }

  _waitUtterance(id, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingUtterances.delete(id);
        resolve('timeout');
      }, timeoutMs);
      this.pendingUtterances.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          this.pendingUtterances.delete(id);
          resolve(v);
        },
      });
    });
  }

  interrupt(reason = 'user') {
    if (!this.current) return false;
    try { this.current.controller.abort(); } catch (_) { /* ignore */ }
    this.current = null;
    this.send({ type: 'interrupt' });
    for (const [, p] of this.pendingUtterances) p.resolve('interrupted');
    this.pendingUtterances.clear();
    this.logger.info(`打断当前播报（${reason}）`);
    return true;
  }

  // ---------- 音乐 ----------

  _startNextSong() {
    const item = this.jukebox.next();
    if (!item) {
      this.jukebox.finishCurrent();
      this._setState('idle');
      this.send({ type: 'music:stop' });
      return;
    }
    this.send({
      type: 'music',
      url: item.song.url,
      title: item.song.title,
      artist: item.song.artist,
      by: item.by,
      songId: item.id,
    });
    this._setState('singing');
    this._broadcastOverlay();
  }

  onMusicEnded() {
    this.jukebox.finishCurrent();
    if (this.jukebox.queue.length) this._startNextSong();
    else {
      this._setState(this.busy ? 'speaking' : 'idle');
      this.send({ type: 'music:stop' });
      this._broadcastOverlay();
    }
  }

  stopMusic() {
    this.jukebox.finishCurrent();
    this.jukebox.clear();
    this.send({ type: 'music:stop' });
    this._setState('idle');
    this._broadcastOverlay();
  }

  skipMusic() {
    this.send({ type: 'music:stop' });
    this.onMusicEnded();
  }

  playSongNow(song, by = '房主') {
    const res = this.jukebox.enqueue(song, by);
    if (!res.ok) return res;
    if (!this.jukebox.current) this._startNextSong();
    this._broadcastOverlay();
    return res;
  }

  // ---------- 舞台回调 ----------

  onStageMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'utterance:finished') {
      const p = this.pendingUtterances.get(msg.utteranceId);
      if (p) p.resolve('finished');
    } else if (msg.type === 'music:ended') {
      this.onMusicEnded();
    } else if (msg.type === 'ready') {
      this._broadcastOverlay();
      this.send({ type: 'state', state: this.currentState });
    }
  }

  _isNight() {
    const n = this.config.night;
    if (!n?.enabled) return false;
    const [sh, sm] = String(n.start || '02:00').split(':').map(Number);
    const [eh, em] = String(n.end || '07:00').split(':').map(Number);
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    const s = sh * 60 + sm;
    const e = eh * 60 + em;
    if (s === e) return false;
    return s < e ? cur >= s && cur < e : cur >= s || cur < e;
  }

  _stateHint() {
    const parts = [];
    if (this.jukebox.current) {
      const c = this.jukebox.current.song;
      parts.push(`正在放《${c.title}》`);
    }
    const top = this.metering.topGifts(1)[0];
    if (top) parts.push(`最近送礼最多的是 ${top.name}`);
    if (this._isNight()) parts.push('现在是深夜，说话可以更轻一点');
    return parts.join('；');
  }

  _setState(state) {
    if (this.currentState === state) return;
    this.currentState = state;
    this.send({ type: 'state', state });
  }

  _broadcastOverlay() {
    const data = {
      metering: this.metering.snapshot(),
      jukebox: this.jukebox.snapshot(),
      status: this.getStatus(),
    };
    this.send({ type: 'overlay', data });
  }

  getStatus() {
    const m = this.metering.snapshot();
    return {
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      busy: this.busy,
      paused: this.paused,
      queue: this.queue.length,
      state: this.currentState,
      mode: this.brain.mode,
      tts: this.voice.provider,
      music: this.jukebox.snapshot().current,
      night: this._isNight(),
      draft: this.draft,
      stats: { ...this.stats },
      tokensToday: m.today.tokens,
      costToday: m.today.cost,
      giftToday: m.today.giftCount,
    };
  }
}

module.exports = { Director };
