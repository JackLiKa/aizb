'use strict';

const { localDay } = require('./logger');

function emptyCounters() {
  return {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    ttsChars: 0,
    speaks: 0,
    songs: 0,
    giftCount: 0,
    giftValue: 0,
  };
}

class Metering {
  constructor({ store, config, logger }) {
    this.store = store;
    this.config = config;
    this.logger = logger;
    const saved = store.get('metering', null);
    this.state = saved && typeof saved === 'object' ? saved : { totals: emptyCounters(), daily: {}, gifts: {} };
    if (!this.state.totals) this.state.totals = emptyCounters();
    if (!this.state.daily) this.state.daily = {};
    if (!this.state.gifts) this.state.gifts = {};
    this._prune();
  }

  _today() {
    const day = localDay();
    if (!this.state.daily[day]) this.state.daily[day] = emptyCounters();
    return this.state.daily[day];
  }

  _prune() {
    const keep = this.config.metering?.dailyRetainDays || 30;
    const days = Object.keys(this.state.daily).sort();
    while (days.length > keep) delete this.state.daily[days.shift()];
  }

  _bump(fn) {
    fn(this.state.totals);
    fn(this._today());
    this.store.set('metering', this.state);
  }

  recordLLM({ promptTokens = 0, completionTokens = 0 }) {
    this._bump((c) => {
      c.calls += 1;
      c.promptTokens += promptTokens;
      c.completionTokens += completionTokens;
    });
  }

  recordTTS(chars = 0) {
    if (!chars) return;
    this._bump((c) => { c.ttsChars += chars; });
  }

  recordSpeak() {
    this._bump((c) => { c.speaks += 1; });
  }

  recordSong() {
    this._bump((c) => { c.songs += 1; });
  }

  recordGift(user, giftName, count = 1, value = 0) {
    const name = String(user || '匿名观众').slice(0, 24);
    const total = Number(count) || 1;
    const amount = Number(value) || 0;
    this._bump((c) => {
      c.giftCount += total;
      c.giftValue += amount * total;
    });
    const cur = this.state.gifts[name] || { name, count: 0, value: 0, lastGift: '' };
    cur.count += total;
    cur.value += amount * total;
    cur.lastGift = String(giftName || '').slice(0, 24);
    cur.updatedAt = Date.now();
    this.state.gifts[name] = cur;
    this.store.set('metering', this.state);
  }

  _cost(c) {
    const m = this.config.metering;
    return (c.promptTokens / 1e6) * m.inputPricePerM +
      (c.completionTokens / 1e6) * m.outputPricePerM +
      (c.ttsChars / 1000) * m.ttsPricePer1kChars;
  }

  topGifts(n = 5) {
    return Object.values(this.state.gifts)
      .sort((a, b) => b.value - a.value || b.count - a.count)
      .slice(0, n);
  }

  snapshot() {
    const today = this._today();
    const t = this.state.totals;
    const mult = this.config.metering.displayMultiplier || 1;
    const todayTokens = today.promptTokens + today.completionTokens;
    const totalTokens = t.promptTokens + t.completionTokens;
    return {
      currency: this.config.metering.currency || '¥',
      today: {
        ...today,
        tokens: todayTokens,
        displayTokens: Math.round(todayTokens * mult),
        cost: this._cost(today),
      },
      total: {
        ...t,
        tokens: totalTokens,
        displayTokens: Math.round(totalTokens * mult),
        cost: this._cost(t),
      },
      topGifts: this.topGifts(5),
    };
  }
}

module.exports = { Metering, emptyCounters };
