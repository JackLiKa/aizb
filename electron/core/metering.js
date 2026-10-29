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
    if (!Array.isArray(this.state.giftLog)) this.state.giftLog = [];
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
    const cutoff = Date.now() - 24 * 3600e3;
    this.state.giftLog = (this.state.giftLog || []).filter((g) => g && g.ts >= cutoff);
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
    // 24 小时滚动明细：用于贡献榜（按用户聚合）
    this.state.giftLog.push({ user: name, giftName: cur.lastGift, count: total, value: amount * total, ts: Date.now() });
    this._prune();
    this.store.set('metering', this.state);
  }

  // 最近 24h 贡献榜（按价值排序，返回前 n 名）
  giftRank24h(n = 5) {
    const cutoff = Date.now() - 24 * 3600e3;
    const byUser = new Map();
    for (const g of this.state.giftLog) {
      if (!g || g.ts < cutoff) continue;
      const cur = byUser.get(g.user) || { name: g.user, count: 0, value: 0, lastGift: '', updatedAt: 0 };
      cur.count += g.count || 0;
      cur.value += g.value || 0;
      cur.lastGift = g.giftName || cur.lastGift;
      cur.updatedAt = Math.max(cur.updatedAt, g.ts || 0);
      byUser.set(g.user, cur);
    }
    return [...byUser.values()].sort((a, b) => b.value - a.value || b.count - a.count).slice(0, n);
  }

  giftTotals24h() {
    const cutoff = Date.now() - 24 * 3600e3;
    let count = 0;
    let value = 0;
    for (const g of this.state.giftLog) {
      if (!g || g.ts < cutoff) continue;
      count += g.count || 0;
      value += g.value || 0;
    }
    return { count, value };
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
      gifts24h: this.giftRank24h(5),
      gift24h: this.giftTotals24h(),
    };
  }
}

module.exports = { Metering, emptyCounters };
