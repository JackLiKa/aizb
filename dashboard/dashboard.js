'use strict';

// 直播数据看板（零框架 / 无外部 CDN）
// 数据源：GET /api/stats?days=7，2 秒轮询；所有用户内容用 textContent 渲染，避免注入。

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('zh-CN');
const DAYS = 7;

const SOURCE_LABEL = {
  simulator: '模拟弹幕',
  ingest: '外部接入',
  douyin: '抖音直播',
  off: '已关闭',
};

const TYPE_LABEL = {
  comment: '弹幕',
  gift: '礼物',
  follow: '关注',
  enter: '进场',
  like: '点赞',
  song: '点歌',
  manual: '房主',
};

const WEEK = '日一二三四五六';

let loading = false;
let failCount = 0;
let lastTodayDate = '';
let currency = '¥';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fmtInt(v) {
  return nf.format(Math.round(num(v)));
}

function withCurrency(v, cur) {
  return `${cur || '¥'}${num(v).toFixed(2)}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// 本地时间 HH:MM:SS（事件 ts 是 UTC ISO，交给 Date 转本地）
function fmtClock(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function dateParts(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

function m2(n) {
  return String(n).padStart(2, '0');
}

function fmtDateShort(dateStr) {
  const p = dateParts(dateStr);
  if (!p) return String(dateStr || '-');
  const dt = new Date(p.y, p.m - 1, p.d);
  return `${m2(p.m)}-${m2(p.d)} 周${WEEK[dt.getDay()]}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function setPill(node, text, cls) {
  node.textContent = text;
  node.className = `pill ${cls || ''}`.trim();
}

function showBanner(text) {
  const banner = $('errorBanner');
  if (!text) {
    banner.hidden = true;
    banner.textContent = '';
    return;
  }
  banner.hidden = false;
  banner.textContent = text;
}

// ---------------- 渲染 ----------------

function renderLive(live) {
  const src = live && live.source ? String(live.source) : '';
  const room = live && live.room ? String(live.room) : '';
  const clients = num(live && live.stageClients);
  const isLlm = live && live.mode === 'llm';

  setPill($('pillSource'), `弹幕源 ${SOURCE_LABEL[src] || src || '-'}`, src === 'off' ? 'warn' : (src === 'douyin' ? 'good' : ''));
  setPill($('pillRoom'), `房间 ${room || '-'}`, room ? '' : 'warn');
  setPill($('pillStage'), `舞台在线 ${fmtInt(clients)}`, clients > 0 ? 'good' : 'bad');
  setPill($('pillMode'), isLlm ? 'LLM 模式' : 'Echo 模式', isLlm ? 'good' : 'warn');

  $('mStage').textContent = fmtInt(clients);
  $('mMode').textContent = isLlm ? 'LLM' : 'Echo';
  $('mModeSub').textContent = `房间 ${room || '-'}`;
}

function renderToday(today) {
  const t = today || {};
  $('todayDate').textContent = t.date ? fmtDateShort(t.date) : '-';
  lastTodayDate = t.date || '';

  $('mEvents').textContent = fmtInt(t.events);
  $('mComments').textContent = fmtInt(t.comments);
  $('mGifts').textContent = fmtInt(t.gifts);
  $('mGiftsSub').textContent = `共 ${fmtInt(t.giftCount)} 个`;
  $('mGiftValue').textContent = withCurrency(t.giftValue, currency);

  $('mTokens').textContent = fmtInt(t.tokens);
  $('mTokensSub').textContent = `${fmtInt(t.promptTokens)} 输入 / ${fmtInt(t.completionTokens)} 输出`;
  $('mCost').textContent = withCurrency(t.cost, currency);
  $('mCostSub').textContent = `语音 ${fmtInt(t.ttsChars)} 字`;
  $('mCalls').textContent = fmtInt(t.calls);
  $('mCallsSub').textContent = `说话 ${fmtInt(t.speaks)} 次`;
  $('mTts').textContent = fmtInt(t.ttsChars);
  $('mTtsSub').textContent = `放歌 ${fmtInt(t.songs)} 首`;
}

function renderChart(days) {
  const box = $('dayChart');
  box.textContent = '';
  const list = Array.isArray(days) ? days : [];
  if (!list.length) {
    box.appendChild(el('div', 'empty', '暂无数据'));
    return;
  }
  const max = Math.max(1, ...list.map((d) => num(d.events)));
  for (const day of list) {
    const isToday = day.date === lastTodayDate;
    const events = num(day.events);
    const pct = events > 0 ? Math.max(4, Math.round((events / max) * 100)) : 0;
    const p = dateParts(day.date);
    const label = isToday ? '今天' : (p ? `${m2(p.m)}-${m2(p.d)}` : day.date);

    const col = el('div', `bar-col${isToday ? ' today' : ''}`);
    const track = el('div', 'bar-track');
    const fill = el('div', 'bar-fill');
    fill.style.height = `${pct}%`;
    track.appendChild(fill);
    col.append(el('div', 'bar-value', fmtInt(events)), track, el('div', 'bar-label', label));
    col.title = `${day.date}：事件 ${fmtInt(day.events)} · 弹幕 ${fmtInt(day.comments)} · 礼物 ${fmtInt(day.gifts)} · 礼物价值 ${withCurrency(day.giftValue, currency)}`;
    box.appendChild(col);
  }
}

function renderTable(days) {
  const body = $('dayTableBody');
  body.textContent = '';
  const list = Array.isArray(days) ? days : [];
  if (!list.length) {
    const tr = document.createElement('tr');
    const td = el('td', 'empty', '暂无数据');
    td.colSpan = 8;
    tr.appendChild(td);
    body.appendChild(tr);
    $('daysRange').textContent = '-';
    return;
  }
  $('daysRange').textContent = `${list[0].date} ~ ${list[list.length - 1].date}`;
  for (const day of list) {
    const tr = document.createElement('tr');
    if (day.date === lastTodayDate) tr.className = 'today';
    const cells = [
      fmtDateShort(day.date),
      fmtInt(day.events),
      fmtInt(day.comments),
      fmtInt(day.gifts),
      withCurrency(day.giftValue, currency),
      fmtInt(day.uniqueUsers),
      fmtInt(day.tokens),
      withCurrency(day.cost, currency),
    ];
    for (const c of cells) tr.appendChild(el('td', '', c));
    body.appendChild(tr);
  }
}

function renderTopGifts(items) {
  const list = $('topGifts');
  list.textContent = '';
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) {
    list.appendChild(el('li', 'empty-item', '暂无礼物'));
    return;
  }
  rows.forEach((g, i) => {
    const li = document.createElement('li');
    const main = el('div', 'rank-main');
    main.appendChild(el('div', 'rank-name', g.giftName || '未知礼物'));
    main.appendChild(el('div', 'rank-meta', `${fmtInt(g.count)} 个`));
    li.append(el('span', 'rank-no', String(i + 1)), main, el('span', 'rank-value', withCurrency(g.value, currency)));
    list.appendChild(li);
  });
}

function renderTopUsers(items) {
  const list = $('topUsers');
  list.textContent = '';
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) {
    list.appendChild(el('li', 'empty-item', '暂无观众'));
    return;
  }
  rows.forEach((u, i) => {
    const li = document.createElement('li');
    const main = el('div', 'rank-main');
    main.appendChild(el('div', 'rank-name', u.user || '匿名观众'));
    main.appendChild(el('div', 'rank-meta', `互动 ${fmtInt(u.count)} 次`));
    li.append(el('span', 'rank-no', String(i + 1)), main, el('span', 'rank-value', fmtInt(u.count)));
    list.appendChild(li);
  });
}

function describeEvent(ev) {
  const type = String(ev.type || '');
  const text = String(ev.text || '').trim();
  if (type === 'gift') {
    const count = Math.max(1, Math.round(num(ev.count)));
    const value = num(ev.value) * count;
    return `${ev.giftName || '礼物'} ×${count}${value > 0 ? ` · ${withCurrency(value, currency)}` : ''}`;
  }
  if (type === 'enter') return '进入了直播间';
  if (type === 'like') return '点了赞';
  if (type === 'follow') return '关注了主播';
  if (type === 'song') return `点歌${text ? `：${text}` : ''}`;
  if (type === 'manual') return `房主：${text || '（手动说话）'}`;
  return text || '（空内容）';
}

function renderRecent(recent) {
  const box = $('recentEvents');
  box.textContent = '';
  const rows = Array.isArray(recent) ? recent : [];
  $('recentCount').textContent = `最近 ${rows.length} 条`;
  if (!rows.length) {
    box.appendChild(el('div', 'empty', '今天还没有事件'));
    return;
  }
  for (const ev of rows) {
    const type = String(ev.type || '');
    const row = el('div', 'event');
    row.append(
      el('span', 'event-time', fmtClock(ev.ts)),
      el('span', `event-type ${type}`, TYPE_LABEL[type] || type || '事件'),
      el('span', 'event-user', ev.user || '匿名观众'),
      el('span', 'event-text', describeEvent(ev)),
      el('span', 'event-source', SOURCE_LABEL[ev.source] || ''),
    );
    row.title = `${ev.date || ''} ${fmtClock(ev.ts)} · ${ev.type || ''}`;
    box.appendChild(row);
  }
}

function renderAll(data) {
  const live = data.live || {};
  currency = data.currency || '¥';
  const days = Array.isArray(data.days) ? data.days : [];
  const totals = data.totals || {};

  renderLive(live);
  renderToday(data.today || {});
  renderChart(days);
  renderTable(days);
  renderTopGifts(totals.topGifts);
  renderTopUsers(totals.topUsers);
  renderRecent(data.recent);

  const now = new Date();
  $('updatedAt').textContent = `更新于 ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  showBanner('');
}

// ---------------- 轮询 ----------------

async function refresh() {
  if (loading || document.hidden) return;
  loading = true;
  try {
    const res = await fetch(`/api/stats?days=${DAYS}`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    failCount = 0;
    renderAll(data);
  } catch (err) {
    failCount += 1;
    $('updatedAt').textContent = '连接中…';
    showBanner(`数据读取失败：${err.message}（每 2 秒自动重试）`);
  } finally {
    loading = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});

refresh();
setInterval(refresh, 2000);
