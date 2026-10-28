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
  const { status, metering, jukebox, songs, logs, watchdog, stageClients, source, config } = state;

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
  setPill($('pillSource'), source === 'simulator' ? '模拟弹幕' : (source === 'ingest' ? '外部接入' : '已关闭'), source === 'off' ? 'warn' : '');
  $('sSource').textContent = source;

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
  const items = (q ? songs.filter((s) => `${s.title} ${s.artist}`.toLowerCase().includes(q)) : songs).slice(0, 30);
  if (!items.length) {
    const li = document.createElement('li');
    li.textContent = q ? '没有匹配的歌曲' : '曲库是空的，把 mp3 放进 data/music 目录';
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
    li.append(wrap, btn);
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
  try {
    await api('/api/source', { method: 'POST', body: JSON.stringify({ type }) });
    toast(`弹幕源已切换为 ${type}`);
    refresh();
  } catch (err) { toast(err.message); }
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
    lastSongsQuery = $('songQuery').value.trim().toLowerCase();
    if (state) renderSongs(state.songs || []);
  }, 200);
});

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
