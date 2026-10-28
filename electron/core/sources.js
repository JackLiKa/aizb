'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const COLLECTOR_CANDIDATES = [
  path.join(ROOT, 'scripts', 'douyin-collector.js'),                        // dev：仓库根
  path.join(ROOT, '..', 'app.asar.unpacked', 'scripts', 'douyin-collector.js'), // packaged：asar 解包目录
  path.join(ROOT, 'app.asar.unpacked', 'scripts', 'douyin-collector.js'),
];

function resolveCollector() {
  for (const p of COLLECTOR_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
  }
  return COLLECTOR_CANDIDATES[0];
}

const USERS = ['小鱼干', '摸鱼达人', '深海不睡觉', '阿呆', '一勺糖', '夜猫子', '不吃香菜', '风吹麦浪',
  '柠檬精', '会飞的猪', '半杯可乐', '猫头鹰', '早八人', '咸鱼翻身', '云朵', '北岛', '小满', '七七',
  '路过的风', '爱吃桃'];

const COMMENTS = [
  '肥鱼今天怎么这么圆',
  '在吗在吗',
  '主播吃了吗',
  '能唱首歌吗',
  '哈哈哈哈哈',
  '这条鱼好可爱',
  '今天心情不太好',
  '摸鱼中',
  '肥鱼你几岁了',
  '来点好听的',
  '晚上好呀',
  '第一次来，关注了',
  '你会游泳吗',
  '为什么叫肥鱼',
  '我下班啦',
  '困死了，陪我聊会儿',
  '肥鱼推荐个夜宵',
  '你是不是胖了',
  '声音好好听',
  '这个直播间好安静',
  '点歌 晴天',
  '来一首稻香',
  '想听好听的老歌',
  '唱首歌吧',
  '点歌 起风了',
  '你最喜欢吃什么',
  '海水咸吗',
  '今天加班到现在',
  '肥鱼晚安',
  '刚刚那个表情好搞笑',
];

const GIFTS = [
  { name: '小心心', value: 0.1 },
  { name: '玫瑰', value: 1 },
  { name: '666', value: 2 },
  { name: '大啤酒', value: 5 },
  { name: '棒棒糖', value: 0.5 },
  { name: '为你点赞', value: 3 },
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

class Simulator {
  constructor({ config, logger, onEvent }) {
    this.config = config;
    this.logger = logger;
    this.onEvent = onEvent;
    this.timers = new Set();
    this.running = false;
    this.paused = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.logger.info('模拟弹幕源已启动（无需真实直播间即可演示）');
    this._commentLoop();
    this._giftLoop();
    this._followLoop();
    this._likeLoop();
  }

  stop() {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  setPaused(p) {
    this.paused = p;
  }

  _later(fn, ms) {
    if (!this.running) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.running && !this.paused) fn();
    }, ms);
    this.timers.add(t);
  }

  _commentLoop() {
    const perMinute = Math.max(1, this.config.source.simulator.commentsPerMinute || 10);
    const ms = rand(60000 / perMinute * 0.6, 60000 / perMinute * 1.6);
    this._later(() => {
      const chance = this.config.source.simulator.songRequestChance ?? 0.12;
      const isSong = Math.random() < chance;
      const text = isSong ? pick(COMMENTS.filter((c) => /点歌|来一首|想听/.test(c))) : pick(COMMENTS);
      this.onEvent({ type: 'comment', user: pick(USERS), text });
      this._commentLoop();
    }, ms);
  }

  _giftLoop() {
    const base = Math.max(10, this.config.source.simulator.giftEverySec || 100);
    this._later(() => {
      const gift = pick(GIFTS);
      this.onEvent({
        type: 'gift',
        user: pick(USERS),
        giftName: gift.name,
        count: Math.random() < 0.2 ? Math.ceil(rand(2, 5)) : 1,
        value: gift.value,
      });
      this._giftLoop();
    }, rand(base * 0.5, base * 1.6) * 1000);
  }

  _followLoop() {
    this._later(() => {
      this.onEvent({ type: 'follow', user: pick(USERS) });
      this._followLoop();
    }, rand(90000, 240000));
  }

  _likeLoop() {
    this._later(() => {
      this.onEvent({ type: 'like', user: pick(USERS), count: Math.ceil(rand(3, 30)) });
      this._likeLoop();
    }, rand(12000, 40000));
  }
}

// 抖音真实弹幕源：托管 scripts/douyin-collector.js 子进程（CDP 观察直播页 DOM → POST /ingest）
class DouyinSource {
  constructor({ config, logger, onEvent }) {
    this.config = config;
    this.logger = logger;
    this.onEvent = onEvent;
    this.child = null;
    this.stopping = false;
    this.restartTimer = null;
    this.restarts = 0;
    this.events = 0;
    this.lastEventAt = 0;
    this.lastError = '';
    this.status = { connected: false, events: 0, room: '' };
    this._outBuf = '';
    this._errLines = 0;
  }

  get roomId() {
    const raw = String(this.config.douyin?.roomId || '').trim();
    const m = raw.match(/live\.douyin\.com\/(\d+)/) || raw.match(/^(\d{6,})$/);
    return m ? m[1] : '';
  }

  start() {
    if (this.child || this.restartTimer) return;
    this.stopping = false;
    if (!this.config.douyin?.enabled) {
      this.lastError = 'douyin.enabled=false';
      this.logger.warn('抖音采集未启用：请在配置里把 douyin.enabled 设为 true');
      return;
    }
    if (!this.roomId) {
      this.lastError = '未配置抖音房间号';
      this.logger.warn('抖音采集未启动：缺少 douyin.roomId（直播间地址里的数字 ID）');
      return;
    }
    const collector = resolveCollector();
    if (!fs.existsSync(collector)) {
      this.lastError = `找不到采集器 ${collector}`;
      this.logger.error(this.lastError);
      return;
    }
    const selectors = fs.existsSync(path.join(ROOT, 'scripts', 'douyin-selectors.json'))
      ? path.join(ROOT, 'scripts', 'douyin-selectors.json')
      : path.join(path.dirname(collector), 'douyin-selectors.json');
    const host = this.config.server?.host === '127.0.0.1' ? '127.0.0.1' : (this.config.server?.host || '127.0.0.1');
    const ingest = `http://${host}:${this.config.server?.port || 17890}`;
    const token = String(this.config.ingest?.token || '');
    const args = [
      collector,
      '--room', this.roomId,
      '--ingest', ingest,
      '--token', token,
      `--headless=${this.config.douyin.headless === false ? 'false' : 'true'}`,
      '--selectors', selectors,
    ];
    if (this.config.douyin.browserPath) args.push('--browser', String(this.config.douyin.browserPath));
    this.logger.info(`启动抖音采集器：房间 ${this.roomId}，上报 ${ingest}/ingest`);
    this.child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this._outBuf = '';

    this.child.stdout.on('data', (buf) => {
      this._outBuf += buf.toString('utf8');
      let idx;
      while ((idx = this._outBuf.indexOf('\n')) >= 0) {
        const line = this._outBuf.slice(0, idx).trim();
        this._outBuf = this._outBuf.slice(idx + 1);
        if (line) this._onLine(line);
      }
    });
    this.child.stderr.on('data', (buf) => {
      const text = buf.toString('utf8').trim();
      if (!text) return;
      this._errLines += 1;
      this.logger.warn(`[douyin] ${text.slice(0, 180)}`);
    });
    this.child.on('error', (err) => {
      this.lastError = err.message;
      this.logger.error(`抖音采集器启动失败：${err.message}`);
    });
    this.child.on('exit', (code, signal) => {
      this.child = null;
      this.status.connected = false;
      this.logger.warn(`抖音采集器退出 code=${code} signal=${signal || '-'}`);
      if (!this.stopping) {
        const delay = Math.min(60, Math.max(3, Number(this.config.douyin?.restartDelaySec) || 5));
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          this.restarts += 1;
          this.logger.info(`重连抖音采集器（第 ${this.restarts} 次）`);
          this.start();
        }, delay * 1000);
      }
    });
  }

  _onLine(line) {
    if (line.startsWith('EVENT ')) {
      try {
        const ev = this._normalize(this._parse(line.slice(6)));
        if (!ev) return;
        this.events += 1;
        this.lastEventAt = Date.now();
        this.status.events = this.events;
        this.onEvent(ev);
      } catch (_) { /* ignore bad json */ }
      return;
    }
    if (line.startsWith('STATUS ')) {
      try {
        const st = JSON.parse(line.slice(7));
        this.status = { ...this.status, ...st };
      } catch (_) { /* ignore */ }
      return;
    }
    if (line.startsWith('ERROR ')) {
      this.lastError = line.slice(6);
      this.logger.error(`[douyin] ${this.lastError}`);
    }
  }

  _parse(raw) {
    return JSON.parse(raw);
  }

  // 平台系统提示（「N 人来了」「欢迎 xx 进入直播间」）会被采集器当成 comment，
  // 这里统一降级成 enter：只上弹幕墙、不触发回复；纯符号噪声直接丢弃。
  _normalize(ev) {
    if (!ev || !ev.type) return null;
    const text = String(ev.text || '').trim();
    if (ev.type === 'comment') {
      if (!text) return null;
      if (/^\d+\s*人?来了$/.test(text) || /^\d+\s*人?进入(了)?直播间$/.test(text)) {
        return { ...ev, type: 'enter', text: '' };
      }
      if (/^(欢迎.{0,30}(进入|来到)(了)?直播间|.{0,30}加入了?直播间)$/.test(text)) {
        return { ...ev, type: 'enter', text: '' };
      }
      // 兜底：真实礼物的 DOM 结构可能与选择器不匹配，被当成 comment 上报时按文案还原
      const giftHit = text.match(/(?:送出|赠送|送给主播)\s*了?\s*([^\sx×*]{1,12})(?:\s*[x×*]\s*(\d{1,3}))?/);
      if (giftHit) {
        return {
          ...ev,
          type: 'gift',
          giftName: giftHit[1],
          count: Math.max(1, Number(giftHit[2]) || 1),
          value: Number(ev.value) || 0,
          text: '',
        };
      }
      if (!/[\p{L}\p{N}]/u.test(text)) return null;
    }
    if (ev.type === 'gift' && !String(ev.giftName || '').trim()) return null;
    return ev;
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.status.connected = false;
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
    setTimeout(() => {
      if (child.exitCode !== null || child.killed) return;
      try {
        if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {});
        else child.kill('SIGKILL');
      } catch (_) { /* ignore */ }
    }, 3000).unref?.();
  }

  snapshot() {
    return {
      type: 'douyin',
      room: this.roomId,
      connected: Boolean(this.status.connected),
      events: this.events,
      lastEventAgoSec: this.lastEventAt ? Math.round((Date.now() - this.lastEventAt) / 1000) : null,
      restarts: this.restarts,
      error: this.lastError,
    };
  }
}

class SourceManager {
  constructor({ config, logger, onEvent }) {
    this.config = config;
    this.logger = logger;
    this.simulator = new Simulator({ config, logger, onEvent });
    this.douyin = new DouyinSource({ config, logger, onEvent });
    this.current = config.source.type || 'simulator';
    if (!['simulator', 'ingest', 'off', 'douyin'].includes(this.current)) this.current = 'off';
  }

  start() {
    if (this.current === 'simulator') this.simulator.start();
    if (this.current === 'douyin') this.douyin.start();
  }

  stop() {
    this.simulator.stop();
    this.douyin.stop();
  }

  setType(type) {
    const next = ['simulator', 'ingest', 'off', 'douyin'].includes(type) ? type : 'off';
    this.simulator.stop();
    this.douyin.stop();
    this.current = next;
    if (next === 'simulator') this.simulator.start();
    if (next === 'douyin') this.douyin.start();
    this.config.source.type = next;
    this.logger.info(`弹幕源切换为 ${next}`);
    return next;
  }

  snapshot() {
    return this.douyin.snapshot();
  }
}

module.exports = { Simulator, SourceManager, DouyinSource };
