import { WhaleGirlRenderer } from './whale-girl.js';
import { AudioEngine } from './audio.js';

const $ = (id) => document.getElementById(id);

const nf = new Intl.NumberFormat('zh-CN');
const STATE_TEXT = { idle: '待机', thinking: '思考中', speaking: '说话中', singing: '唱歌中' };

let avatarPalette = {};
let currentState = 'idle';
let musicPlaying = false;
let uptimeBase = { sec: 0, at: Date.now() };
let subtitleTimer = null;
let bannerTimer = null;

const avatar = await createAvatar();
avatar.start();

function hasWebGL2() {
  try {
    const probe = document.createElement('canvas');
    return !!(window.WebGL2RenderingContext && probe.getContext('webgl2'));
  } catch (_) {
    return false;
  }
}

async function createAvatar() {
  const canvas = $('stage-canvas');
  const mode = new URLSearchParams(location.search).get('avatar') || '2d';
  if (mode === '3d' && hasWebGL2()) {
    try {
      const { WhaleGirlRenderer3D } = await import('./whale-girl-3d.js');
      const renderer3d = new WhaleGirlRenderer3D(canvas, { fps: 30, palette: {} });
      document.documentElement.dataset.avatar = '3d';
      return renderer3d;
    } catch (err) {
      console.warn('[stage] 3D 渲染不可用，回退 2D：', err);
      const replacement = canvas.cloneNode(false);
      canvas.replaceWith(replacement);
    }
  }
  if (mode !== 'canvas') {
    try {
      const { LayeredGirlRenderer } = await import('./whale-girl-layered.js');
      const layered = await LayeredGirlRenderer.create($('stage-canvas'), { fps: 30 });
      document.documentElement.dataset.avatar = '2d';
      return layered;
    } catch (err) {
      console.warn('[stage] 分层 2D 不可用，回退程序化 2D：', err);
    }
  }
  document.documentElement.dataset.avatar = '2d-canvas';
  return new WhaleGirlRenderer($('stage-canvas'), { fps: 30, palette: {} });
}

const audio = new AudioEngine({
  onClipStart: (text) => {
    if (text) {
      showSubtitle(text);
      avatar.setMode('speaking');
    } else {
      hideSubtitle();
    }
  },
  onUtteranceFinished: (id) => {
    post('utterance:finished', { utteranceId: id });
    if (!musicPlaying) avatar.setMode('idle');
    clearTimeout(subtitleTimer);
    subtitleTimer = setTimeout(hideSubtitle, 1600);
  },
  onMusicEnded: () => {
    musicPlaying = false;
    post('music:ended');
    setNowPlaying(null);
    if (!subtitleVisible()) avatar.setMode('idle');
  },
  onMouth: (v) => avatar.setMouth(v),
});
audio.init();

function post(type, extra = {}) {
  fetch('/stage/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, ...extra }),
  }).catch(() => {});
}

function showSubtitle(text) {
  const el = $('subtitle');
  el.textContent = text;
  el.classList.add('show');
}

function hideSubtitle() {
  $('subtitle').classList.remove('show');
}

function subtitleVisible() {
  return $('subtitle').classList.contains('show');
}

function setStateDot(state) {
  const dot = $('stateDot');
  dot.className = `state-dot ${state}`;
  $('stateText').textContent = STATE_TEXT[state] || state;
}

function applyState(state) {
  currentState = state;
  setStateDot(state);
  if (state === 'singing') avatar.setMode('singing');
  else if (state === 'thinking') avatar.setMode('thinking');
  else if (state === 'idle') avatar.setMode(musicPlaying ? 'singing' : 'idle');
}

function addDanmaku(ev) {
  if (!ev || ev.type === 'like' || ev.type === 'enter') return;
  const layer = $('danmakuLayer');
  if (layer.childElementCount > 38) layer.firstElementChild?.remove();

  let text = ev.text || '';
  if (ev.type === 'gift') text = `送出 ${ev.giftName} ×${ev.count || 1}`;
  if (ev.type === 'song') text = ev.query ? `点歌《${ev.query}》` : '点歌';
  if (ev.type === 'follow') text = '关注了主播';

  const el = document.createElement('div');
  el.className = `dm ${ev.type}`;
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = ev.user || '观众';
  el.appendChild(who);
  el.appendChild(document.createTextNode(text));
  el.style.top = `${Math.random() * 88}%`;
  el.style.animationDuration = `${9 + Math.random() * 5}s`;
  el.addEventListener('animationend', () => el.remove());
  layer.appendChild(el);
}

function showGiftBanner(ev) {
  if (!ev) return;
  const banner = $('giftBanner');
  banner.innerHTML = '';
  const name = document.createElement('span');
  name.className = 'g-name';
  name.textContent = ev.user || '观众';
  const gift = document.createElement('span');
  gift.className = 'g-gift';
  gift.textContent = `送出 ${ev.giftName || '礼物'}`;
  const count = document.createElement('span');
  count.className = 'g-count';
  count.textContent = `×${ev.count || 1}`;
  banner.append(name, gift, count);
  banner.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => banner.classList.remove('show'), 3200);
}

function showToast(text) {
  if (!text) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('toastLayer').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function setNowPlaying(info) {
  const el = $('nowPlaying');
  if (info && info.title) {
    musicPlaying = true;
    el.textContent = `♪ ${info.title}${info.artist ? ` - ${info.artist}` : ''}`;
    el.classList.add('active');
  } else {
    musicPlaying = false;
    el.textContent = '还没有人点歌';
    el.classList.remove('active');
  }
}

function updateOverlay(data) {
  if (!data) return;
  const { metering, jukebox, status } = data;

  if (metering?.today) {
    $('tokenValue').textContent = nf.format(metering.today.displayTokens || metering.today.tokens || 0);
    const cur = metering.currency || '¥';
    const cost = metering.today.cost || 0;
    $('tokenCost').textContent = `${cur} ${cost >= 100 ? cost.toFixed(0) : cost.toFixed(2)}`;
    $('tokenCalls').textContent = `${metering.today.calls} 次调用 · ${nf.format(metering.today.ttsChars)} 字语音`;
  }

  if (metering?.topGifts) {
    const list = $('giftList');
    list.innerHTML = '';
    if (!metering.topGifts.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '还没有礼物';
      list.appendChild(li);
    } else {
      metering.topGifts.slice(0, 5).forEach((g, i) => {
        const li = document.createElement('li');
        const left = document.createElement('span');
        left.className = 'name';
        const idx = document.createElement('span');
        idx.className = 'rank-index';
        idx.textContent = String(i + 1);
        left.append(idx, document.createTextNode(g.name));
        const val = document.createElement('span');
        val.className = 'val';
        val.textContent = `${metering.currency || '¥'}${(g.value || 0).toFixed(1)}`;
        li.append(left, val);
        list.appendChild(li);
      });
    }
  }

  if (jukebox) {
    const ul = $('songQueue');
    ul.innerHTML = '';
    for (const item of jukebox.queue || []) {
      const li = document.createElement('li');
      li.textContent = `${item.title} · ${item.by}`;
      ul.appendChild(li);
    }
    if (jukebox.current) setNowPlaying(jukebox.current);
    else if (!audio.musicEl) setNowPlaying(null);
  }

  if (status) {
    if (typeof status.uptimeSec === 'number') uptimeBase = { sec: status.uptimeSec, at: Date.now() };
    if (status.state) applyState(status.state);
  }
}

function handle(msg) {
  switch (msg.type) {
    case 'say':
      audio.enqueue(msg);
      break;
    case 'say:done':
      audio.markDone(msg.utteranceId);
      break;
    case 'interrupt':
      audio.interrupt();
      hideSubtitle();
      if (!musicPlaying) avatar.setMode('idle');
      break;
    case 'state':
      applyState(msg.state);
      break;
    case 'emote':
      avatar.celebrate();
      if (msg.event) showGiftBanner(msg.event);
      break;
    case 'music':
      audio.playMusic(msg);
      setNowPlaying({ title: msg.title, artist: msg.artist });
      avatar.setMode('singing');
      break;
    case 'music:stop':
      audio.stopMusic();
      setNowPlaying(null);
      if (currentState !== 'speaking') avatar.setMode('idle');
      break;
    case 'feed':
      addDanmaku(msg.event);
      break;
    case 'overlay':
      updateOverlay(msg.data);
      break;
    case 'toast':
      showToast(msg.text);
      break;
    default:
      break;
  }
}

function connect() {
  const es = new EventSource('/events?role=stage');
  es.onopen = () => {
    $('connBadge').className = 'conn ok';
    $('connBadge').textContent = '已连接';
    post('ready');
  };
  es.onerror = () => {
    $('connBadge').className = 'conn bad';
    $('connBadge').textContent = '重连中…';
  };
  es.onmessage = (e) => {
    try { handle(JSON.parse(e.data)); } catch (_) { /* ignore */ }
  };
}

function tickClock() {
  const total = uptimeBase.sec + Math.floor((Date.now() - uptimeBase.at) / 1000);
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  $('uptime').textContent = `${h}:${m}:${s}`;
}

async function bootstrap() {
  try {
    const res = await fetch('/api/state');
    const data = await res.json();
    if (data.config?.avatar) {
      const a = data.config.avatar;
      avatarPalette = {
        hairColor: a.hairColor,
        hairShadeColor: a.hairShadeColor,
        skinColor: a.skinColor,
        finColor: a.finColor,
        blushColor: a.blushColor,
      };
      avatar.setPalette(avatarPalette);
    }
    if (data.config?.persona?.name) {
      $('roomTitle').textContent = `${data.config.persona.name}的鱼塘`;
    }
    if (data.metering) {
      updateOverlay({
        metering: data.metering,
        jukebox: data.jukebox,
        status: data.status,
      });
    }
  } catch (_) { /* 服务还没起来时忽略 */ }
}

function layoutHud() {
  const hud = $('hud');
  const k = Math.min(window.innerWidth / 1280, window.innerHeight / 720);
  hud.style.transform = `scale(${k})`;
  hud.style.left = `${(window.innerWidth - 1280 * k) / 2}px`;
  hud.style.top = `${(window.innerHeight - 720 * k) / 2}px`;
}

layoutHud();
window.addEventListener('resize', layoutHud);

setInterval(() => post('heartbeat'), 2000);
setInterval(tickClock, 1000);
tickClock();

window.addEventListener('error', (e) => {
  post('renderer:error', { message: String(e.message || 'unknown') });
});

bootstrap().finally(connect);

window.__stageDebug = { avatar, audio, layoutHud };
