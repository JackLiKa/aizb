'use strict';

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

class SourceManager {
  constructor({ config, logger, onEvent }) {
    this.config = config;
    this.logger = logger;
    this.simulator = new Simulator({ config, logger, onEvent });
    this.current = config.source.type || 'simulator';
  }

  start() {
    if (this.current === 'simulator') this.simulator.start();
  }

  stop() {
    this.simulator.stop();
  }

  setType(type) {
    const next = ['simulator', 'ingest', 'off'].includes(type) ? type : 'off';
    this.simulator.stop();
    this.current = next;
    if (next === 'simulator') this.simulator.start();
    this.config.source.type = next;
    this.logger.info(`弹幕源切换为 ${next}`);
    return next;
  }
}

module.exports = { Simulator, SourceManager };
