'use strict';

// 直播间数据持久化 + 统计聚合（零第三方依赖，只用 fs/path）。
//
// 数据目录结构（${dataDir}/analytics/）：
//   events-YYYY-MM-DD.jsonl   每行一个事件，本地时区归日，只追加
//   metering-YYYY-MM-DD.json  计量快照，本地时区归日，原子覆盖写
//
// 设计要点：
//   1. recordEvent 只往当天的 WriteStream 里写一行，不阻塞 HTTP，失败只 logger.warn；
//   2. recordMetering 频率由外部控制（server.js 每 30s 一次），tmp + rename 原子写；
//   3. summary 用「按天增量扫描」缓存：每次只读文件新增的字节，dashboard 2s 轮询也便宜；
//      文件不存在/损坏时返回 0 值，不抛错。
//
// 事件行字段固定为：{ts, date, type, user, text, giftName, count, value, source, room}

const fs = require('fs');
const path = require('path');

const MAX_DAYS = 90;
const RECENT_MAX = 30;
const TOP_MAX = 10;
const TAIL_BYTES = 64 * 1024;

function pad2(n) {
  return String(n).padStart(2, '0');
}

// 本地时区日期（YYYY-MM-DD），与 logger.localDay / metering 归日口径一致。
function localDay(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// 从对象里按优先级取第一个非 undefined / non-null 的字段。
function pick(obj, keys, fallback = '') {
  if (!obj || typeof obj !== 'object') return fallback;
  for (const key of keys) {
    const v = obj[key];
    if (v !== undefined && v !== null) return v;
  }
  return fallback;
}

function round(n, digits = 6) {
  const base = 10 ** digits;
  return Math.round(toNum(n) * base) / base;
}

function clampDays(v) {
  const n = Math.floor(toNum(v));
  if (!Number.isFinite(n) || n <= 0) return 7;
  return Math.min(MAX_DAYS, Math.max(1, n));
}

// 最近 n 天的本地日期，按日期升序（最后一个是今天）。用中午 12 点构造，避开夏令时边界。
function recentDays(n, now = new Date()) {
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 12, 0, 0, 0);
    out.push(localDay(d));
  }
  return out;
}

function emptyAgg(day) {
  return {
    date: day,
    events: 0,
    comments: 0,
    gifts: 0,
    giftCount: 0,
    giftValue: 0,
    follows: 0,
    enters: 0,
    likes: 0,
    songs: 0,
    // 计量字段（来自 metering-*.json，扫描事件时先占位 0）
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    tokens: 0,
    ttsChars: 0,
    cost: 0,
    speaks: 0,
    // 内部聚合容器（不直接对外）
    _users: new Set(),
    _giftMap: new Map(),
    _userMap: new Map(),
  };
}

function addEvent(agg, ev) {
  if (!ev || typeof ev !== 'object') return;
  agg.events += 1;
  const type = String(ev.type || '');
  if (type === 'comment') agg.comments += 1;
  else if (type === 'gift') {
    agg.gifts += 1;
    const count = Math.max(1, toNum(ev.count) || 1);
    const value = toNum(ev.value);
    agg.giftCount += count;
    agg.giftValue += value * count;
    const name = String(ev.giftName || '').trim() || '未知礼物';
    const cur = agg._giftMap.get(name) || { giftName: name, count: 0, value: 0 };
    cur.count += count;
    cur.value += value * count;
    agg._giftMap.set(name, cur);
  } else if (type === 'follow') agg.follows += 1;
  else if (type === 'enter') agg.enters += 1;
  else if (type === 'like') agg.likes += 1;
  else if (type === 'song') agg.songs += 1;

  const user = String(ev.user || '').trim();
  if (user) {
    agg._users.add(user);
    agg._userMap.set(user, (agg._userMap.get(user) || 0) + 1);
  }
}

function topGiftsOf(agg, n = TOP_MAX) {
  return Array.from(agg._giftMap.values())
    .map((g) => ({ giftName: g.giftName, count: g.count, value: round(g.value, 6) }))
    .sort((a, b) => b.value - a.value || b.count - a.count || a.giftName.localeCompare(b.giftName))
    .slice(0, n);
}

function topUsersOf(agg, n = TOP_MAX) {
  return Array.from(agg._userMap.entries())
    .map(([user, count]) => ({ user, count }))
    .sort((a, b) => b.count - a.count || a.user.localeCompare(b.user))
    .slice(0, n);
}

function emptyTotals() {
  return {
    events: 0,
    comments: 0,
    gifts: 0,
    giftCount: 0,
    giftValue: 0,
    follows: 0,
    enters: 0,
    likes: 0,
    songs: 0,
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    tokens: 0,
    ttsChars: 0,
    cost: 0,
    speaks: 0,
    _users: new Set(),
    _giftMap: new Map(),
    _userMap: new Map(),
  };
}

function mergeInto(totals, agg) {
  totals.events += agg.events;
  totals.comments += agg.comments;
  totals.gifts += agg.gifts;
  totals.giftCount += agg.giftCount;
  totals.giftValue += agg.giftValue;
  totals.follows += agg.follows;
  totals.enters += agg.enters;
  totals.likes += agg.likes;
  totals.songs += agg.songs;
  totals.calls += agg.calls;
  totals.promptTokens += agg.promptTokens;
  totals.completionTokens += agg.completionTokens;
  totals.tokens += agg.tokens;
  totals.ttsChars += agg.ttsChars;
  totals.cost += agg.cost;
  totals.speaks += agg.speaks;
  for (const u of agg._users) totals._users.add(u);
  for (const g of agg._giftMap.values()) {
    const cur = totals._giftMap.get(g.giftName) || { giftName: g.giftName, count: 0, value: 0 };
    cur.count += g.count;
    cur.value += g.value;
    totals._giftMap.set(g.giftName, cur);
  }
  for (const [u, c] of agg._userMap) totals._userMap.set(u, (totals._userMap.get(u) || 0) + c);
}

// 把内部聚合 + 当天计量快照转成对外的日行。
function publicDay(agg, meter, day) {
  const row = {
    date: day,
    events: agg.events,
    comments: agg.comments,
    gifts: agg.gifts,
    giftCount: agg.giftCount,
    giftValue: round(agg.giftValue, 6),
    follows: agg.follows,
    enters: agg.enters,
    likes: agg.likes,
    songs: agg.songs,
    uniqueUsers: agg._users.size,
    calls: agg.calls,
    promptTokens: agg.promptTokens,
    completionTokens: agg.completionTokens,
    tokens: agg.tokens,
    ttsChars: agg.ttsChars,
    cost: round(agg.cost, 6),
    speaks: agg.speaks,
    topGifts: topGiftsOf(agg),
    topUsers: topUsersOf(agg),
  };
  if (meter) {
    row.calls = toNum(meter.calls);
    row.promptTokens = toNum(meter.promptTokens);
    row.completionTokens = toNum(meter.completionTokens);
    row.tokens = meter.tokens !== undefined
      ? toNum(meter.tokens)
      : row.promptTokens + row.completionTokens;
    row.ttsChars = toNum(meter.ttsChars);
    row.cost = round(meter.cost, 6);
    row.speaks = toNum(meter.speaks);
    if (meter.songs !== undefined) row.songs = toNum(meter.songs);
  }
  return row;
}

function publicTotals(totals) {
  return {
    events: totals.events,
    comments: totals.comments,
    gifts: totals.gifts,
    giftCount: totals.giftCount,
    giftValue: round(totals.giftValue, 6),
    follows: totals.follows,
    enters: totals.enters,
    likes: totals.likes,
    songs: totals.songs,
    calls: totals.calls,
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    tokens: totals.tokens,
    ttsChars: totals.ttsChars,
    cost: round(totals.cost, 6),
    speaks: totals.speaks,
    uniqueUsers: totals._users.size,
    topGifts: topGiftsOf(totals),
    topUsers: topUsersOf(totals),
  };
}

class Analytics {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir 数据根目录（会创建 ${dataDir}/analytics/）
   * @param {object} [opts.logger] Logger 或 child（需有 warn 方法）
   * @param {object} [opts.config] 运行时配置（读 metering.currency 等）
   * @param {() => object} [opts.getMetering] 返回 Metering 实例或 snapshot（可选）
   * @param {() => object} [opts.getLive] 返回直播状态（可选，server 自行组装 live 字段）
   */
  constructor({ dataDir, logger, config, getMetering, getLive } = {}) {
    this.rootDir = dataDir || path.join(process.cwd(), 'data');
    this.dataDir = path.join(this.rootDir, 'analytics');
    this.logger = logger || null;
    this.config = config || {};
    this.getMetering = typeof getMetering === 'function' ? getMetering : null;
    this.getLive = typeof getLive === 'function' ? getLive : null;

    this._stream = null;
    this._streamDay = null;
    this._daysCache = new Map();

    this._ensureDir();
  }

  _warn(msg, err) {
    try {
      if (this.logger && typeof this.logger.warn === 'function') {
        this.logger.warn(`[analytics] ${msg}`, err ? { error: err.message || String(err) } : undefined);
      }
    } catch (_) { /* ignore */ }
  }

  _ensureDir() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      return true;
    } catch (err) {
      this._warn(`创建目录失败 ${this.dataDir}`, err);
      return false;
    }
  }

  eventFile(day) {
    return path.join(this.dataDir, `events-${day}.jsonl`);
  }

  meteringFile(day) {
    return path.join(this.dataDir, `metering-${day}.json`);
  }

  _appendStream(day) {
    if (this._stream && this._streamDay === day) return this._stream;
    if (this._stream) {
      try { this._stream.end(); } catch (_) { /* ignore */ }
      this._stream = null;
      this._streamDay = null;
    }
    if (!this._ensureDir()) throw new Error(`analytics 目录不可用: ${this.dataDir}`);
    const stream = fs.createWriteStream(this.eventFile(day), { flags: 'a' });
    stream.on('error', (err) => {
      this._warn(`写入事件文件失败 ${day}`, err);
      if (this._stream === stream) {
        this._stream = null;
        this._streamDay = null;
      }
    });
    this._stream = stream;
    this._streamDay = day;
    return stream;
  }

  /**
   * 追加一条事件（异步、低成本，绝不阻塞调用方 HTTP 处理）。
   * @param {object} ev 原始事件（director 的 push body 即可）
   * @param {{source?:string, room?:string}} [meta] 来源标记（ingest / test / douyin …）
   */
  recordEvent(ev, meta) {
    try {
      if (!ev || typeof ev !== 'object') return;
      const now = new Date();
      const day = localDay(now);
      const m = meta && typeof meta === 'object' ? meta : {};
      const record = {
        ts: now.toISOString(),
        date: day,
        type: String(pick(ev, ['type'], 'comment') || 'comment').slice(0, 24),
        user: String(pick(ev, ['user', 'nickname', 'uname'], '匿名观众')).slice(0, 24),
        // query 兜底：采集器/导演的点歌事件常常只有 query 没有 text
        text: String(pick(ev, ['text', 'content', 'msg', 'query'], '')).slice(0, 200),
        giftName: String(pick(ev, ['giftName', 'gift', 'gift_name'], '')).slice(0, 24),
        count: Math.max(1, toNum(pick(ev, ['count', 'num', 'repeat_count'])) || 1),
        value: toNum(pick(ev, ['value', 'price'], 0)),
        source: String(pick(m, ['source'], '') || pick(ev, ['source'], '') || 'ingest').slice(0, 24),
        room: String(m.room !== undefined && m.room !== null ? m.room : pick(ev, ['room'], '')).slice(0, 40),
      };
      this._appendStream(day).write(`${JSON.stringify(record)}\n`);
    } catch (err) {
      this._warn('记录事件失败', err);
    }
  }

  /**
   * 覆盖写入当天计量快照（tmp + rename 原子写）。由外部每 30s 调用一次。
   * @param {object} [snapshot] metering.snapshot() 的返回值；省略时尝试用 getMetering 取。
   */
  recordMetering(snapshot) {
    try {
      let snap = snapshot;
      if ((!snap || typeof snap !== 'object') && this.getMetering) {
        const got = this.getMetering();
        snap = got && typeof got.snapshot === 'function' ? got.snapshot() : got;
      }
      if (!snap || typeof snap !== 'object') return;
      const now = new Date();
      const day = localDay(now);
      if (!this._ensureDir()) return;
      const today = snap.today && typeof snap.today === 'object' ? snap.today : snap;
      const promptTokens = toNum(today.promptTokens);
      const completionTokens = toNum(today.completionTokens);
      const data = {
        date: day,
        ts: now.toISOString(),
        currency: String(snap.currency || (this.config.metering && this.config.metering.currency) || '¥'),
        calls: toNum(today.calls),
        promptTokens,
        completionTokens,
        tokens: today.tokens !== undefined ? toNum(today.tokens) : promptTokens + completionTokens,
        ttsChars: toNum(today.ttsChars),
        cost: round(today.cost, 6),
        speaks: toNum(today.speaks),
        songs: toNum(today.songs),
        giftCount: toNum(today.giftCount),
        giftValue: round(today.giftValue, 6),
        displayTokens: today.displayTokens !== undefined ? toNum(today.displayTokens) : promptTokens + completionTokens,
        topGifts: Array.isArray(snap.topGifts) ? snap.topGifts.slice(0, 10) : [],
      };
      const file = this.meteringFile(day);
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`, 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      this._warn('写入计量快照失败', err);
    }
  }

  // 增量扫描一天的事件文件：只读上次 offset 之后的新字节，只消费完整行。
  _scanEvents(day) {
    const file = this.eventFile(day);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (_) {
      this._daysCache.delete(day);
      return emptyAgg(day);
    }
    let cache = this._daysCache.get(day);
    if (!cache || stat.size < cache.offset) {
      cache = { offset: 0, agg: emptyAgg(day) };
      this._daysCache.set(day, cache);
    }
    if (stat.size <= cache.offset) return cache.agg;

    const len = stat.size - cache.offset;
    const buf = Buffer.alloc(len);
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
      fs.readSync(fd, buf, 0, len, cache.offset);
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
    }
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) return cache.agg; // 还没写完整行，等下一次
    const complete = text.slice(0, lastNl + 1);
    for (const line of complete.split('\n')) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        // 看板只聚合真实观众事件（ingest/douyin），排除控制台测试注入
        if (ev && ev.source !== 'test') addEvent(cache.agg, ev);
      } catch (_) { /* 跳过坏行 */ }
    }
    cache.offset += Buffer.byteLength(complete, 'utf8');
    return cache.agg;
  }

  _readMetering(day) {
    try {
      const raw = fs.readFileSync(this.meteringFile(day), 'utf8');
      const obj = JSON.parse(raw);
      return obj && typeof obj === 'object' ? obj : null;
    } catch (err) {
      if (err && err.code !== 'ENOENT') this._warn(`读取计量文件失败 ${day}`, err);
      return null;
    }
  }

  // 读当天事件文件尾部 → 最近 N 条事件（新的在前）。大文件只读尾部 64KB。
  _recentEvents(day, n = RECENT_MAX) {
    const file = this.eventFile(day);
    let stat;
    try { stat = fs.statSync(file); } catch (_) { return []; }
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const len = stat.size - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
      fs.readSync(fd, buf, 0, len, start);
    } catch (_) {
      return [];
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
    }
    let text = buf.toString('utf8');
    if (start > 0) {
      const firstNl = text.indexOf('\n');
      text = firstNl >= 0 ? text.slice(firstNl + 1) : '';
    }
    const lines = text.split('\n').filter((l) => l.trim());
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < n; i -= 1) {
      try {
        const ev = JSON.parse(lines[i]);
        // 看板只统计真实观众事件，排除控制台「事件注入」测试数据
        if (ev && ev.source !== 'test') out.push(ev);
      } catch (_) { /* 跳过坏行 */ }
    }
    return out;
  }

  _currency(meters) {
    const fromConfig = this.config && this.config.metering && this.config.metering.currency;
    if (fromConfig) return String(fromConfig);
    for (let i = meters.length - 1; i >= 0; i -= 1) {
      const m = meters[i];
      if (m && m.currency) return String(m.currency);
    }
    return '¥';
  }

  /**
   * 最近 N 天汇总。
   * @param {number} [days=7] 天数（1..90）
   * @returns {{days:Array, today:object, totals:object, recent:Array, currency:string, generatedAt:string}}
   */
  summary(days = 7) {
    const n = clampDays(days);
    const now = new Date();
    const dates = recentDays(n, now);
    const rows = [];
    const meters = [];
    const totals = emptyTotals();

    for (const date of dates) {
      const agg = this._scanEvents(date);
      const meter = this._readMetering(date);
      const row = publicDay(agg, meter, date);
      meters.push(meter);
      mergeInto(totals, agg); // 事件聚合（计量字段这里恒为 0，下面用天行重算）
      rows.push(row);
    }

    const outTotals = publicTotals(totals);
    // 计量字段以每天 publicDay（metering-*.json 优先）为准；songs 也以天行口径重算。
    outTotals.calls = 0;
    outTotals.promptTokens = 0;
    outTotals.completionTokens = 0;
    outTotals.tokens = 0;
    outTotals.ttsChars = 0;
    outTotals.cost = 0;
    outTotals.speaks = 0;
    outTotals.songs = 0;
    for (const row of rows) {
      outTotals.calls += row.calls;
      outTotals.promptTokens += row.promptTokens;
      outTotals.completionTokens += row.completionTokens;
      outTotals.tokens += row.tokens;
      outTotals.ttsChars += row.ttsChars;
      outTotals.cost = round(outTotals.cost + row.cost, 6);
      outTotals.speaks += row.speaks;
      outTotals.songs += row.songs;
    }

    const today = rows.length ? { ...rows[rows.length - 1] } : publicDay(emptyAgg(localDay(now)), null, localDay(now));

    return {
      days: rows,
      today,
      totals: outTotals,
      recent: this._recentEvents(localDay(now)),
      currency: this._currency(meters),
      generatedAt: now.toISOString(),
    };
  }

  /** 结束当天事件流（不丢已写入数据）。退出前调用。 */
  flush() {
    const stream = this._stream;
    this._stream = null;
    this._streamDay = null;
    if (!stream) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        stream.end(resolve);
      } catch (_) {
        resolve();
      }
    });
  }
}

module.exports = { Analytics, localDay, recentDays };
