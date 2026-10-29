'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { Logger } = require('../electron/core/logger');
const { DEFAULTS, deepMerge } = require('../electron/core/config');
const { Store } = require('../electron/core/store');
const { Metering } = require('../electron/core/metering');
const { Brain } = require('../electron/core/brain');
const { Voice } = require('../electron/core/voice');
const { Jukebox } = require('../electron/core/jukebox');
const { Director } = require('../electron/core/director');

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dyzb-smoke-'));
  fs.mkdirSync(path.join(dataDir, 'music'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'music', '测试歌曲.mp3'), Buffer.alloc(4096, 1));

  const config = deepMerge(DEFAULTS, {
    llm: { apiKey: '', echoDelayMs: 0 },
    tts: { provider: 'none' },
    behavior: { replyProbability: 1, userCooldownSec: 0, dedupeWindowSec: 0, minIntervalSec: 0, giftBatchWindowMs: 0 },
    night: { enabled: false },
    compliance: { humanInLoop: false },
    jukebox: { dir: 'music', perUserCooldownSec: 0, provider: 'local' },
  });

  const logger = new Logger({ dir: path.join(dataDir, 'logs'), level: 'warn' });
  const store = new Store(path.join(dataDir, 'state.json'), logger);
  const metering = new Metering({ store, config, logger });
  const brain = new Brain({ config, logger, metering });
  const voice = new Voice({ config, logger, dataDir });
  const jukebox = new Jukebox({ config, logger, dataDir });

  const messages = [];
  const director = new Director({
    config,
    logger,
    brain,
    voice,
    jukebox,
    metering,
    store,
    send: (m) => messages.push(m),
    hasStage: () => false,
  });
  director.start();

  director.push({ type: 'comment', user: '小鱼干', text: '肥鱼你好呀' });
  director.push({ type: 'gift', user: '夜猫子', giftName: '玫瑰', count: 2, value: 1 });
  director.push({ type: 'follow', user: '路过的风' });
  director.push({ type: 'song', user: '阿呆', query: '测试' });
  director.push({ type: 'comment', user: '柠檬精', text: '点歌 测试歌曲' });
  director.push({ type: 'comment', user: '找不到', text: '点歌 完全不存在的歌名' });

  const started = Date.now();
  while ((director.busy || director.queue.length) && Date.now() - started < 8000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 200));

  const types = messages.map((m) => m.type);
  assert(types.includes('feed'), '应广播弹幕 feed');
  assert(types.includes('say'), '应产生语音片段');
  assert(types.includes('say:done'), '应发送 say:done');
  assert(types.includes('overlay'), '应推送 overlay');
  assert(types.includes('music'), '点歌成功后应开始播放');
  assert(types.includes('emote'), '送礼物应触发表情');
  assert(messages.some((m) => m.type === 'emote' && m.name === 'gift'), '礼物应触发鞠躬表情');
  assert(
    messages.some((m) => m.type === 'emote' && m.name === 'sad' && m.event?.kind === 'song-not-found'),
    '点歌找不到时应触发无奈摇头表情',
  );

  const doneIds = messages.filter((m) => m.type === 'say:done').map((m) => m.utteranceId);
  assert(new Set(doneIds).size >= 3, `应至少完成 3 段播报，实际 ${doneIds.length}`);

  const snap = metering.snapshot();
  assert(snap.today.calls >= 3, `LLM 调用次数异常: ${snap.today.calls}`);
  assert(snap.today.giftCount === 2, `礼物数量异常: ${snap.today.giftCount}`);
  assert(snap.today.giftValue === 2, `礼物价值异常: ${snap.today.giftValue}`);
  assert(snap.today.tokens > 0, 'token 统计应大于 0');
  assert(snap.topGifts[0].name === '夜猫子', '礼物榜异常');
  assert(jukebox.queue.length + (jukebox.current ? 1 : 0) >= 1, '点歌应进入队列');

  const mvA = jukebox.enqueue({ id: 'mv-a', title: '甲', artist: '', source: 'local', url: '/a.mp3' }, '测试');
  const mvB = jukebox.enqueue({ id: 'mv-b', title: '乙', artist: '', source: 'local', url: '/b.mp3' }, '测试');
  assert(mvA.ok && mvB.ok, '队列应可加入测试曲目');
  const pinned = jukebox.move(mvB.item.id, { to: 'top' });
  assert(pinned.ok && jukebox.queue[0].id === mvB.item.id, '置顶应把曲目移到队首');
  const shifted = jukebox.move(mvB.item.id, { index: 1 });
  assert(shifted.ok && jukebox.queue[1].id === mvB.item.id, '按索引移动应改变顺序');
  assert(jukebox.remove(mvB.item.id) && jukebox.remove(mvA.item.id), '应可移出队列');

  const spoken = [];
  const fakeVoice = {
    synthesize: async (text) => {
      spoken.push(text);
      return { ok: true, chars: text.length, url: `fake/${spoken.length}.mp3` };
    },
  };
  const fakeBrain = {
    stream: () => (async function* () { yield '唔……这个问题好难，让肥鱼先吐两个泡泡想想。'; })(),
  };
  const probe = new Director({
    config, logger, brain: fakeBrain, voice: fakeVoice, jukebox, metering, store,
    send: () => {}, hasStage: () => false,
  });
  await probe._talk({ type: 'comment', user: '测试', text: '在吗' });
  assert(spoken.length >= 1, '省略号回复应仍能切出语音');
  assert(spoken.every((t) => /[\p{L}\p{N}]/u.test(t)), `不应把纯标点送去 TTS: ${JSON.stringify(spoken)}`);
  assert(spoken.join('').includes('这个问题'), `省略号后的正文不应被丢弃: ${JSON.stringify(spoken)}`);

  const status = director.getStatus();
  assert(status.stats.handled >= 4, `处理数异常: ${status.stats.handled}`);
  assert(status.stats.errors === 0, `不应有错误: ${status.stats.errors}`);

  console.log('--- 冒烟测试通过 ---');
  console.log(JSON.stringify({
    handled: status.stats.handled,
    speaks: status.stats.speaks,
    messages: messages.length,
    tokensToday: snap.today.tokens,
    costToday: Number(snap.today.cost.toFixed(4)),
    giftTop: snap.topGifts[0],
    musicQueue: jukebox.snapshot(),
  }, null, 2));

  director.stop();
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('冒烟测试失败:', err);
  process.exit(1);
});
