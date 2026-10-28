'use strict';

// 不启动 Electron，只跑本地服务 + 模拟弹幕，方便在浏览器里调舞台页。
// 用法: node scripts/dev-server.js [--port 17890] [--seed]

const path = require('path');

const { Logger } = require('../electron/core/logger');
const { loadConfig, llmStatus } = require('../electron/core/config');
const { describeOverrides, describeEnvFiles } = require('../electron/core/env');
const { Store } = require('../electron/core/store');
const { Metering } = require('../electron/core/metering');
const { Analytics } = require('../electron/core/analytics');
const { Brain } = require('../electron/core/brain');
const { Voice } = require('../electron/core/voice');
const { Jukebox } = require('../electron/core/jukebox');
const { Director } = require('../electron/core/director');
const { SourceManager } = require('../electron/core/sources');
const { Watchdog } = require('../electron/core/watchdog');
const { createServer } = require('../electron/core/server');

const ROOT = path.join(__dirname, '..');

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) return fallback;
  const v = process.argv[idx + 1];
  return v && !v.startsWith('--') ? v : true;
}

async function main() {
  const dataDir = path.join(ROOT, 'data');
  // 纯 Node 调试：无 Electron userData，故 userData/.env 回退到 dataDir 的父目录（= 仓库根，自动去重）
  const configHandle = loadConfig(dataDir, { rootDir: ROOT });
  const config = configHandle.config;
  if (arg('port')) {
    config.server.port = Number(arg('port'));
  }
  if (arg('seed')) {
    config.source.type = 'simulator';
    config.source.simulator.commentsPerMinute = 40;
    config.source.simulator.giftEverySec = 12;
  }
  if (arg('nosim')) config.source.type = 'off';

  const logger = new Logger({ dir: path.join(dataDir, 'logs'), level: 'debug' });
  const envFiles = describeEnvFiles(configHandle.env);
  if (envFiles.length) logger.info(`.env: ${envFiles.join(' | ')}`);
  if (configHandle.envOverrides.length) {
    logger.info(`.env 已生效: ${describeOverrides(configHandle.envOverrides).join(' | ')}`);
  }
  for (const w of configHandle.envWarnings || []) logger.warn(w);
  logger.info(`LLM Key 来源: ${llmStatus(config, configHandle.env).keySource}`);
  const store = new Store(path.join(dataDir, 'state.json'), logger.child('store'));
  const metering = new Metering({ store, config, logger: logger.child('metering') });
  const analytics = new Analytics({
    dataDir,
    logger: logger.child('analytics'),
    config,
    getMetering: () => metering,
  });
  const brain = new Brain({ config, logger: logger.child('brain'), metering });
  const voice = new Voice({ config, logger: logger.child('voice'), dataDir });
  const jukebox = new Jukebox({ config, logger: logger.child('jukebox'), dataDir });

  let director = null;
  const sources = new SourceManager({
    config,
    logger: logger.child('source'),
    onEvent: (ev) => director?.push(ev),
  });
  const watchdog = new Watchdog({
    config,
    logger: logger.child('watchdog'),
    hasStage: () => ctl.hasStage(),
    onStuck: () => logger.warn('（dev-server）舞台心跳超时，真实应用会在这里重载渲染进程'),
  });

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
    dashboardDir: path.join(ROOT, 'dashboard'),
    dataDir,
    getDirector: () => director,
    analytics,
    getDouyinStatus: () => sources.snapshot(),
    getLlmMode: () => brain.mode,
    onRestartStage: () => logger.info('（dev-server）重启舞台请求'),
    onFocusStage: () => false,
  });

  director = new Director({
    config,
    logger: logger.child('director'),
    brain,
    voice,
    jukebox,
    metering,
    store,
    send: (msg) => ctl.broadcast(msg),
    hasStage: () => ctl.hasStage(),
  });
  director.start();

  const { host, port } = config.server;
  await new Promise((resolve, reject) => {
    ctl.server.once('error', reject);
    ctl.server.listen(port, host, resolve);
  });

  sources.start();
  watchdog.start();

  const base = `http://${host}:${port}`;
  logger.info(`舞台: ${base}/stage/`);
  logger.info(`控制台: ${base}/admin/`);
  logger.info(`数据看板: ${base}/dashboard/`);
  logger.info(`AI: ${brain.mode} | TTS: ${voice.provider} | 曲库: ${jukebox.index.length} 首`);

  const shutdown = async () => {
    logger.info('dev-server 退出');
    try { sources.stop(); } catch (_) { /* ignore */ }
    try { director.stop(); } catch (_) { /* ignore */ }
    try { watchdog.stop(); } catch (_) { /* ignore */ }
    try { await analytics.flush(); } catch (_) { /* ignore */ }
    store.close();
    try { await ctl.close(); } catch (_) { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
