const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('zh-CN');

const COMMENTS = ['肥鱼在吗', '今天好圆啊', '唱首歌呗', '晚上好', '你好可爱', '主播吃了吗', '摸鱼中', '来聊会儿天'];
const GIFTS = [
  { giftName: '小心心', count: 1, value: 0.1 },
  { giftName: '玫瑰', count: 1, value: 1 },
  { giftName: '666', count: 3, value: 2 },
  { giftName: '大啤酒', count: 1, value: 5 },
];
const USERS = ['测试观众', '小鱼干', '路过的风', '夜猫子', '柠檬精'];

let state = null;
let configDirty = false;
let lastLogTs = '';
let sourceInitialized = false;
let searchTimer = null;
let lastSongsQuery = '';
let onlineCache = { q: null, songs: [] };

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 2400);
}

function fmtUptime(sec) {
  const s = Math.max(0, sec | 0);
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${ss}`;
}

function setPill(el, text, cls = '') {
  el.textContent = text;
  el.className = `pill ${cls}`;
}

function render() {
  if (!state) return;
  const { status, metering, jukebox, songs, logs, watchdog, stageClients, source, config, douyin, llm } = state;

  if (status) {
    setPill($('pillState'), status.paused ? '已暂停' : ({ idle: '待机', thinking: '思考中', speaking: '说话中', singing: '唱歌中' }[status.state] || status.state), status.paused ? 'warn' : 'good');
    setPill($('pillMode'), status.mode === 'llm' ? 'LLM 模式' : 'Echo 模式（未配置 Key）', status.mode === 'llm' ? 'good' : 'warn');
    $('sUptime').textContent = fmtUptime(status.uptimeSec);
    $('sState').textContent = ({ idle: '待机', thinking: '思考中', speaking: '说话中', singing: '唱歌中' }[status.state] || status.state);
    $('sBeat').textContent = `${watchdog?.lastBeatAgoSec ?? '-'}s 前`;
    $('sRestarts').textContent = String(watchdog?.restartsLastHour ?? 0);
    $('sErrors').textContent = String(status.stats?.errors ?? 0);
    $('mHandled').textContent = nf.format(status.stats?.handled ?? 0);
    $('mQueue').textContent = `队列 ${status.queue ?? 0}`;
    $('btnPause').textContent = status.paused ? '恢复自动回复' : '暂停自动回复';
    $('btnPause').classList.toggle('warm', Boolean(status.paused));
  }

  setPill($('pillStage'), stageClients > 0 ? '舞台已连接' : '舞台未连接', stageClients > 0 ? 'good' : 'bad');
  setPill($('pillSource'), source === 'simulator' ? '模拟弹幕' : (source === 'ingest' ? '外部接入' : (source === 'douyin' ? '抖音直播' : '已关闭')), source === 'off' ? 'warn' : '');
  $('sSource').textContent = source;

  const keySrc = llm?.status?.keySource;
  $('sKey').textContent = keySrc === 'env' ? '.env（已读取）' : (keySrc === 'config' ? 'config.json（建议迁到 .env）' : '未配置');
  $('sRoom').textContent = douyin?.room || config?.douyin?.roomId || '-';

  // 人工确认模式：展示 AI 草稿，真人点发送才播报
  const draft = status?.draft;
  const draftCard = $('draftCard');
  if (draft) {
    draftCard.hidden = false;
    $('draftText').textContent = draft.text;
    const ev = draft.event || {};
    $('draftMeta').textContent = `${ev.type || ''} · ${ev.user || ''} · ${new Date(draft.ts || Date.now()).toLocaleTimeString('zh-CN')}`;
  } else {
    draftCard.hidden = true;
    $('draftText').textContent = '';
    $('draftMeta').textContent = '';
  }

  if (douyin) {
    $('dyEvents').textContent = nf.format(douyin.events || 0);
    $('dyAgo').textContent = douyin.lastEventAgoSec == null ? '-' : `${douyin.lastEventAgoSec}s 前`;
    const ok = douyin.connected;
    $('dyStatus').textContent = ok ? '已连接' : (douyin.error ? `未连接 · ${douyin.error}` : '未启动');
    $('dyStatus').style.color = ok ? '' : '#ffb45c';
  }
  if (config && document.activeElement !== $('douyinRoom')) {
    $('douyinRoom').value = config.douyin?.roomId || '';
  }

  if (!sourceInitialized && source) {
    $('sourceSelect').value = source;
    sourceInitialized = true;
  }

  if (metering) {
    const t = metering.today;
    $('mTokens').textContent = nf.format(t.displayTokens || t.tokens || 0);
    $('mTokensSub').textContent = `${nf.format(t.promptTokens)} 输入 / ${nf.format(t.completionTokens)} 输出`;
    $('mCost').textContent = `${metering.currency}${(t.cost || 0).toFixed(2)}`;
    $('mTts').textContent = `${nf.format(t.ttsChars)} 字语音 · ${t.calls} 次调用`;
    $('mGifts').textContent = nf.format(t.giftCount || 0);
    $('mGiftValue').textContent = `${metering.currency}${(t.giftValue || 0).toFixed(1)}`;
    $('meterNote').textContent = t.calls
      ? `今日说话 ${t.speaks} 次，放歌 ${t.songs} 首，礼物 ${t.giftCount} 个`
      : '尚未产生调用';
  }

  if (jukebox) {
    $('nowPlaying').textContent = jukebox.current
      ? `当前：${jukebox.current.title} · ${jukebox.current.by}`
      : '当前：无';
    renderQueue(jukebox);
  }

  if (logs) renderLogs(logs);

  if (config && !configDirty && document.activeElement !== $('configText')) {
    $('configText').value = JSON.stringify(config, null, 2);
  }

  if (config) {
    const origin = location.origin;
    $('ingestInfo').textContent = [
      `POST ${origin}/ingest`,
      `Header: x-ingest-token: ${config.ingest?.token || ''}`,
      '',
      '{"type":"comment","user":"张三","text":"你好呀"}',
      '{"type":"gift","user":"李四","giftName":"玫瑰","count":1,"value":1}',
      '{"type":"song","user":"王五","query":"晴天"}',
    ].join('\n');
  }

  renderSongs(songs || []);
}

function renderLogs(logs) {
  const newest = logs.length ? logs[logs.length - 1].ts : '';
  if (newest === lastLogTs) return;
  lastLogTs = newest;
  const box = $('logs');
  box.innerHTML = '';
  for (const l of logs.slice(-80)) {
    const div = document.createElement('div');
    div.className = `log-line ${l.level || ''}`;
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = `${String(l.ts || '').slice(11, 19)} `;
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = `[${l.tag}] `;
    div.append(t, tag, document.createTextNode(l.msg || ''));
    box.appendChild(div);
  }
  box.scrollTop = box.scrollHeight;
}

function renderSongs(songs) {
  const q = $('songQuery').value.trim().toLowerCase();
  if (q !== lastSongsQuery) return;
  const ul = $('songResults');
  ul.innerHTML = '';
  // 在线搜索结果已由服务端按关键词检索，标题/作者不一定含关键词，不能再二次过滤
  const serverSearched = Boolean(q) && onlineCache.q === q;
  const pool = serverSearched ? onlineCache.songs : songs;
  const items = (q && !serverSearched ? pool.filter((s) => `${s.title} ${s.artist}`.toLowerCase().includes(q)) : pool).slice(0, 30);
  if (!items.length) {
    const li = document.createElement('li');
    li.textContent = q ? '没有匹配的歌曲' : '曲库是空的；点「在线」可搜索 Jamendo / Internet Archive';
    ul.appendChild(li);
    return;
  }
  for (const song of items) {
    const li = document.createElement('li');
    const wrap = document.createElement('span');
    wrap.className = 'title';
    wrap.textContent = song.title;
    if (song.artist) {
      const a = document.createElement('span');
      a.className = 'artist';
      a.textContent = song.artist;
      wrap.appendChild(a);
    }
    let badge = null;
    if (song.source && song.source !== 'local') {
      badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = song.source === 'jamendo' ? 'Jamendo' : 'Archive';
      badge.title = song.license || '在线曲库';
    }
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = '入队';
    btn.addEventListener('click', async () => {
      try {
        await api('/api/songs/queue', { method: 'POST', body: JSON.stringify({ id: song.id }) });
        toast(`已加入队列：${song.title}`);
        refresh();
      } catch (err) { toast(err.message); }
    });
    li.append(wrap);
    if (badge) li.append(badge);
    li.append(btn);
    ul.appendChild(li);
  }
}

async function refresh() {
  try {
    state = await api('/api/state');
    render();
  } catch (err) {
    setPill($('pillStage'), '服务连接失败', 'bad');
  }
}

async function moveSong(id, target) {
  try {
    await api('/api/songs/move', { method: 'POST', body: JSON.stringify({ id, ...target }) });
    toast(target.to === 'top' ? '已置顶' : '已调整顺序');
    refresh();
  } catch (err) { toast(err.message); }
}

async function removeSong(id) {
  try {
    await api('/api/songs/remove', { method: 'POST', body: JSON.stringify({ id }) });
    toast('已移出队列');
    refresh();
  } catch (err) { toast(err.message); }
}

function renderQueue(jukebox) {
  const ul = $('queueList');
  const list = jukebox?.queue || [];
  $('queueCount').textContent = `${list.length} 首`;
  ul.innerHTML = '';
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = jukebox?.current ? '队列为空，正在播放当前曲目' : '队列为空';
    ul.appendChild(li);
    return;
  }
  list.forEach((item, i) => {
    const li = document.createElement('li');
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = `${i + 1}. ${item.title}`;
    if (item.artist) {
      const a = document.createElement('span');
      a.className = 'artist';
      a.textContent = item.artist;
      title.appendChild(a);
    }
    const by = document.createElement('span');
    by.className = 'artist';
    by.textContent = item.by || '';

    const btns = document.createElement('span');
    btns.className = 'qbtns';
    const mk = (label, hint, act, cls = '', disabled = false) => {
      const b = document.createElement('button');
      b.className = `btn ${cls}`.trim();
      b.textContent = label;
      b.title = hint;
      b.disabled = disabled;
      b.addEventListener('click', act);
      return b;
    };
    btns.append(
      mk('置顶', '移到队首', () => moveSong(item.id, { to: 'top' }), 'warm', i === 0),
      mk('↑', '上移一位', () => moveSong(item.id, { index: i - 1 }), '', i === 0),
      mk('↓', '下移一位', () => moveSong(item.id, { index: i + 1 }), '', i === list.length - 1),
      mk('×', '移出队列', () => removeSong(item.id), 'danger'),
    );
    li.append(title, by, btns);
    ul.appendChild(li);
  });
}

$('btnOpenStage').addEventListener('click', () => {
  window.open('/stage/', '_blank', 'width=1280,height=720');
});

$('btnPause').addEventListener('click', async () => {
  try {
    const paused = !state?.status?.paused;
    await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused }) });
    toast(paused ? '已暂停自动回复' : '已恢复自动回复');
    refresh();
  } catch (err) { toast(err.message); }
});

$('btnRestart').addEventListener('click', async () => {
  try {
    await api('/api/restart-stage', { method: 'POST', body: '{}' });
    toast('已发送重启指令');
  } catch (err) { toast(err.message); }
});

$('btnDraftSend').addEventListener('click', async () => {
  const draft = state?.status?.draft;
  if (!draft) { toast('当前没有待确认草稿'); return; }
  try {
    await api('/api/speak', { method: 'POST', body: JSON.stringify({ text: draft.text, exact: true, user: '房主（人工确认）' }) });
    toast('已发送（真人确认播报）');
    refresh();
  } catch (err) { toast(err.message); }
});

$('btnDraftDiscard').addEventListener('click', async () => {
  const draft = state?.status?.draft;
  if (!draft) return;
  try {
    await api('/api/draft/discard', { method: 'POST', body: JSON.stringify({ id: draft.id }) });
    toast('已丢弃草稿');
    refresh();
  } catch (err) { toast(err.message); }
});

$('btnSpeak').addEventListener('click', async () => {
  const text = $('speakText').value.trim();
  if (!text) { toast('先输入内容'); return; }
  try {
    await api('/api/speak', { method: 'POST', body: JSON.stringify({ text }) });
    $('speakText').value = '';
    toast('已插入播报队列');
  } catch (err) { toast(err.message); }
});

$('btnSource').addEventListener('click', async () => {
  const type = $('sourceSelect').value;
  if (type === 'douyin' && !state?.douyin?.room && !state?.config?.douyin?.roomId) {
    toast('先在「抖音真实直播」卡片里保存房间号');
    return;
  }
  try {
    await api('/api/source', { method: 'POST', body: JSON.stringify({ type }) });
    toast(`弹幕源已切换为 ${type}`);
    refresh();
  } catch (err) { toast(err.message); }
});

$('btnDouyin').addEventListener('click', async () => {
  const raw = $('douyinRoom').value.trim();
  if (!raw) { toast('先填直播间地址或房间号'); return; }
  const m = raw.match(/(\d{6,})/);
  if (!m) { toast('没识别出房间号，请粘贴完整直播间地址'); return; }
  try {
    await api('/api/config', { method: 'POST', body: JSON.stringify({ douyin: { enabled: true, roomId: m[1] } }) });
    await api('/api/source', { method: 'POST', body: JSON.stringify({ type: 'douyin' }) });
    $('douyinMsg').textContent = `已启动采集器：房间 ${m[1]}（首次启动需要几秒，无头浏览器会加载直播间）`;
    sourceInitialized = false;
    toast('已保存并连接抖音房间');
    refresh();
  } catch (err) {
    $('douyinMsg').textContent = `失败：${err.message}`;
    toast(err.message);
  }
});

document.querySelectorAll('[data-inject]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const kind = btn.dataset.inject;
    let payload;
    if (kind === 'comment') {
      payload = { type: 'comment', user: USERS[Math.floor(Math.random() * USERS.length)], text: COMMENTS[Math.floor(Math.random() * COMMENTS.length)] };
    } else if (kind === 'gift') {
      payload = { type: 'gift', user: USERS[Math.floor(Math.random() * USERS.length)], ...GIFTS[Math.floor(Math.random() * GIFTS.length)] };
    } else if (kind === 'follow') {
      payload = { type: 'follow', user: '新观众' + Math.floor(Math.random() * 100) };
    } else {
      payload = { type: 'song', user: '控制台', query: $('songQuery').value.trim() || '晴天' };
    }
    try {
      await api('/api/event', { method: 'POST', body: JSON.stringify(payload) });
      toast('事件已注入');
    } catch (err) { toast(err.message); }
  });
});

$('btnSkip').addEventListener('click', async () => {
  try {
    await api('/api/songs/skip', { method: 'POST', body: '{}' });
    toast('已切歌');
  } catch (err) { toast(err.message); }
});

$('songQuery').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    onlineCache = { q: null, songs: [] };
    lastSongsQuery = $('songQuery').value.trim().toLowerCase();
    if (state) renderSongs(state.songs || []);
  }, 200);
});

$('songQuery').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadOnlineSongs();
});

$('btnSongOnline').addEventListener('click', () => loadOnlineSongs());

async function loadOnlineSongs() {
  clearTimeout(searchTimer);
  const q = $('songQuery').value.trim();
  const btn = $('btnSongOnline');
  if (btn.disabled) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '搜索中…';
  try {
    const data = await api(`/api/songs?q=${encodeURIComponent(q)}`);
    if ($('songQuery').value.trim() !== q) return;
    if (state) state.songs = data.songs;
    lastSongsQuery = q.toLowerCase();
    onlineCache = { q: lastSongsQuery, songs: data.songs };
    renderSongs(data.songs);
    const online = data.songs.filter((s) => s.source && s.source !== 'local').length;
    toast(q ? `找到 ${data.songs.length} 首（在线 ${online}）` : `曲库 ${data.songs.length} 首（在线 ${online}）`);
  } catch (err) {
    toast(`在线搜索失败：${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

$('configText').addEventListener('input', () => { configDirty = true; $('configMsg').textContent = '有未保存的修改'; });

$('btnSaveConfig').addEventListener('click', async () => {
  let parsed;
  try {
    parsed = JSON.parse($('configText').value);
  } catch (err) {
    toast('JSON 格式错误');
    $('configMsg').textContent = `解析失败：${err.message}`;
    return;
  }
  try {
    const res = await api('/api/config', { method: 'POST', body: JSON.stringify(parsed) });
    configDirty = false;
    $('configMsg').textContent = '已保存';
    $('configText').value = JSON.stringify(res.config, null, 2);
    toast('配置已保存');
    refresh();
  } catch (err) {
    $('configMsg').textContent = `保存失败：${err.message}`;
    toast(err.message);
  }
});

$('btnReloadConfig').addEventListener('click', () => {
  configDirty = false;
  refresh();
  toast('已重新加载');
});

refresh();
setInterval(refresh, 2000);
