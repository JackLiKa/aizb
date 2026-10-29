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
const { createServer } = require('../electron/core/server');

const ROOT = path.join(__dirname, '..');

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dyzb-http-'));
  fs.mkdirSync(path.join(dataDir, 'music'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'music', 'Artist - Song.mp3'), Buffer.alloc(2048, 2));

  const config = deepMerge(DEFAULTS, {
    llm: { apiKey: '', echoDelayMs: 0 },
    tts: { provider: 'none' },
    behavior: { replyProbability: 1, userCooldownSec: 0, dedupeWindowSec: 0, minIntervalSec: 0 },
    night: { enabled: false },
    compliance: { humanInLoop: false },
    jukebox: { dir: 'music', perUserCooldownSec: 0, provider: 'local' },
  });
  const configHandle = { config, save: (patch) => Object.assign(config, deepMerge(config, patch)) };

  const logger = new Logger({ dir: path.join(dataDir, 'logs'), level: 'error' });
  const store = new Store(path.join(dataDir, 'state.json'), logger.child('store'));
  const metering = new Metering({ store, config, logger: logger.child('metering') });
  const brain = new Brain({ config, logger: logger.child('brain'), metering });
  const voice = new Voice({ config, logger: logger.child('voice'), dataDir });
  const jukebox = new Jukebox({ config, logger: logger.child('jukebox'), dataDir });

  let source = 'simulator';
  const sources = { get current() { return source; }, setType: (t) => { source = t; } };
  const beat = { count: 0 };
  const watchdog = { kick: () => { beat.count += 1; }, status: () => ({ lastBeatAgoSec: 0, restartsLastHour: 0 }) };

  let director = null;
  const ctl = createServer({
    config,
    configHandle,
    logger,
    metering,
    jukebox,
    voice,
    sources,
    watchdog,
    stageDir: path.join(ROOT, 'stage'),
    adminDir: path.join(ROOT, 'admin'),
    dataDir,
    getDirector: () => director,
    onRestartStage: () => {},
  });

  director = new Director({
    config,
    logger: logger.child('director'),
    brain,
    voice,
    jukebox,
    metering,
    store,
    send: (m) => ctl.broadcast(m),
    hasStage: () => ctl.hasStage(),
  });
  director.start();

  await new Promise((r) => ctl.server.listen(0, '127.0.0.1', r));
  const port = ctl.server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const health = await (await fetch(`${base}/health`)).json();
  assert(health.ok === true, '/health 应返回 ok');

  for (const [p, needle] of [
    ['/stage/', 'stage-canvas'],
    ['/admin/', '大肥鱼直播'],
    ['/stage/stage.js', 'AudioEngine'],
    ['/stage/styles.css', '--panel-bg'],
    ['/stage/whale-girl.js', 'WhaleGirlRenderer'],
    ['/stage/whale-model.js', 'buildWhaleGirl'],
    ['/stage/whale-girl-3d.js', 'WhaleGirlRenderer3D'],
    ['/stage/model-preview.html', 'importmap'],
    ['/stage/vendor/three.module.min.js', 'REVISION'],
    ['/admin/admin.js', '/api/state'],
  ]) {
    const res = await fetch(base + p);
    const text = await res.text();
    assert(res.status === 200, `${p} 状态码 ${res.status}`);
    assert(text.includes(needle), `${p} 内容缺失 ${needle}`);
  }

  const glb = await fetch(`${base}/stage/assets/whale-girl.glb`);
  assert(glb.status === 200, `GLB 状态码 ${glb.status}`);
  assert(
    glb.headers.get('content-type') === 'model/gltf-binary',
    `GLB MIME 应为 model/gltf-binary，实际 ${glb.headers.get('content-type')}`,
  );
  const glbBuf = Buffer.from(await glb.arrayBuffer());
  assert(glbBuf.readUInt32LE(0) === 0x46546c67, 'GLB magic 不正确');
  assert(glbBuf.readUInt32LE(4) === 2, 'GLB 版本应为 2');
  assert(glbBuf.length === glbBuf.readUInt32LE(8), 'GLB 长度字段与实际不符');

  const traversal = await fetch(`${base}/stage/..%2f..%2fpackage.json`);
  assert(traversal.status === 403, `目录穿越应被拒绝，实际 ${traversal.status}`);

  const sse = await fetch(`${base}/events?role=stage`);
  assert(sse.status === 200, 'SSE 连接失败');
  const reader = sse.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  const readUntil = async (type, timeoutMs = 5000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (events.some((e) => e.type === type)) return events.find((e) => e.type === type);
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE 提前结束');
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
        }
      }
    }
    throw new Error(`等待 SSE 事件 ${type} 超时，已收到: ${events.map((e) => e.type).join(',')}`);
  };

  await readUntil('overlay');
  assert(ctl.hasStage(), 'SSE 连接后 hasStage 应为 true');

  const sayPromise = readUntil('say');
  await fetch(`${base}/api/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'comment', user: 'HTTP测试', text: '你好呀肥鱼' }),
  });
  const say = await sayPromise;
  assert(say.utteranceId && say.text, 'say 事件应带 utteranceId/text');

  await readUntil('say:done');
  await fetch(`${base}/stage/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'utterance:finished', utteranceId: say.utteranceId }),
  });

  const waited = Date.now();
  while (director.busy && Date.now() - waited < 3000) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert(!director.busy, '收到 utterance:finished 后应释放导演队列');

  const giftP = readUntil('emote');
  await fetch(`${base}/api/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'gift', user: '送礼人', giftName: '火箭', count: 1, value: 100 }),
  });
  await giftP;
  const say2 = await readUntil('say');
  await fetch(`${base}/stage/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'utterance:finished', utteranceId: say2.utteranceId }),
  });
  await new Promise((r) => setTimeout(r, 100));
  const say2done = events.find((e) => e.type === 'say:done' && e.utteranceId === say2.utteranceId);
  if (say2done) {
    await fetch(`${base}/stage/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'utterance:finished', utteranceId: say2.utteranceId }),
    });
  }

  const state = await (await fetch(`${base}/api/state`)).json();
  assert(state.ok, '/api/state 应成功');
  assert(state.config.llm.apiKey !== undefined, '配置应回传');
  assert(state.stageClients === 1, `stageClients 应为 1，实际 ${state.stageClients}`);
  assert(state.metering.today.giftCount >= 1, '礼物统计应更新');
  assert(state.metering.topGifts[0].name === '送礼人', '礼物榜应包含送礼人');
  assert(state.songs.length === 1, '曲库应索引到 1 首');

  const songs = await (await fetch(`${base}/api/songs?q=song`)).json();
  assert(songs.songs.length === 1, '搜索应命中');
  const songId = songs.songs[0].id;

  const qp = readUntil('music');
  const queued = await fetch(`${base}/api/songs/queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: songId }),
  });
  assert(queued.status === 200, `点歌接口状态 ${queued.status}`);
  const music = await qp;
  assert(music.title === 'Song', `曲名解析异常: ${music.title}`);

  await fetch(`${base}/stage/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'music:ended' }),
  });
  const stop = await readUntil('music:stop');
  assert(stop, 'music:ended 后应收到 music:stop');

  const media = await fetch(`${base}/media/music/${encodeURIComponent('Artist - Song.mp3')}`, {
    headers: { Range: 'bytes=0-99' },
  });
  assert(media.status === 206, `Range 请求应返回 206，实际 ${media.status}`);
  assert(media.headers.get('content-range') === 'bytes 0-99/2048', 'Content-Range 异常');

  const badIngest = await fetch(`${base}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'comment', user: 'x', text: 'y' }),
  });
  assert(badIngest.status === 403, '无 token 的 ingest 应被拒绝');

  const goodIngest = await fetch(`${base}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ingest-token': config.ingest.token },
    body: JSON.stringify({ type: 'comment', user: '接入端', text: '来自外部的弹幕' }),
  });
  assert(goodIngest.status === 200, '带 token 的 ingest 应成功');

  await readUntil('say');
  await new Promise((r) => setTimeout(r, 50));

  const cfgRes = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ llm: { apiKey: '***', model: 'test-model' } }),
  });
  const cfgJson = await cfgRes.json();
  assert(cfgJson.ok && cfgJson.config.llm.model === 'test-model', '配置保存失败');
  assert(config.llm.apiKey === '', '星号 apiKey 不应覆盖原值');

  console.log('--- HTTP 联调测试通过 ---');
  console.log(JSON.stringify({
    port,
    sayEvents: events.filter((e) => e.type === 'say').length,
    overlayEvents: events.filter((e) => e.type === 'overlay').length,
    speaks: director.getStatus().stats.speaks,
    handled: director.getStatus().stats.handled,
    errors: director.getStatus().stats.errors,
    heartbeatKicks: beat.count,
    giftTop: state.metering.topGifts[0],
  }, null, 2));

  director.stop();
  await ctl.close();
  store.close();
  logger.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('HTTP 联调测试失败:', err);
  process.exit(1);
});
