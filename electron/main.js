'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, powerSaveBlocker, shell, screen } = require('electron');

const { Logger } = require('./core/logger');
const { loadConfig } = require('./core/config');
const { Store } = require('./core/store');
const { Metering } = require('./core/metering');
const { Brain } = require('./core/brain');
const { Voice } = require('./core/voice');
const { Jukebox } = require('./core/jukebox');
const { Director } = require('./core/director');
const { SourceManager } = require('./core/sources');
const { Watchdog } = require('./core/watchdog');
const { createServer } = require('./core/server');

const isDev = !app.isPackaged;
const ROOT = path.join(__dirname, '..');
const STAGE_DIR = path.join(ROOT, 'stage');
const ADMIN_DIR = path.join(ROOT, 'admin');
const ICON = path.join(ROOT, 'build', 'icon.png');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.setAppUserModelId('com.dyzb.fish');

let mainWindow = null;
let adminWindow = null;
let tray = null;
let quitting = false;
let psb = null;

const ctx = {};
let logger = null;
let store = null;
let config = null;
let configHandle = null;
let serverCtl = null;
let director = null;
let sources = null;
let watchdog = null;
let metering = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
  app.whenReady().then(bootstrap).catch((err) => {
    console.error(err);
    dialog.showErrorBox('启动失败', String(err && err.stack ? err.stack : err));
    app.quit();
  });
}

async function bootstrap() {
  const dataDir = isDev ? path.join(ROOT, 'data') : path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });

  configHandle = loadConfig(dataDir);
  config = configHandle.config;

  logger = new Logger({ dir: path.join(dataDir, 'logs'), maxFiles: 7 });
  logger.info('应用启动', { version: app.getVersion(), dataDir, packaged: app.isPackaged });

  store = new Store(path.join(dataDir, 'state.json'), logger);
  metering = new Metering({ store, config, logger });
  const brain = new Brain({ config, logger, metering });
  const voice = new Voice({ config, logger, dataDir });
  const jukebox = new Jukebox({ config, logger, dataDir });

  watchdog = new Watchdog({
    config,
    logger,
    hasStage: () => Boolean(ctx.hasStage && ctx.hasStage()),
    onStuck: () => {
      if (!mainWindow) return;
      logger.warn('重启舞台渲染进程');
      mainWindow.webContents.reloadIgnoringCache();
    },
  });

  sources = new SourceManager({
    config,
    logger,
    onEvent: (ev) => director?.push(ev),
  });

  serverCtl = createServer({
    config,
    configHandle,
    logger,
    metering,
    jukebox,
    voice,
    sources,
    watchdog,
    stageDir: STAGE_DIR,
    adminDir: ADMIN_DIR,
    dataDir,
    getDirector: () => director,
    onRestartStage: () => {
      if (mainWindow) mainWindow.webContents.reloadIgnoringCache();
    },
    onFocusStage: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      return true;
    },
  });

  director = new Director({
    config,
    logger,
    brain,
    voice,
    jukebox,
    metering,
    store,
    send: (msg) => serverCtl.broadcast(msg),
    hasStage: () => serverCtl.hasStage(),
  });
  director.start();

  ctx.director = director;
  ctx.hasStage = () => serverCtl.hasStage();

  const { host, port } = config.server;
  await new Promise((resolve, reject) => {
    serverCtl.server.once('error', reject);
    serverCtl.server.listen(port, host, resolve);
  }).catch((err) => {
    const msg = err.code === 'EADDRINUSE'
      ? `端口 ${port} 已被占用，请修改 data/config.json 里的 server.port`
      : String(err.message);
    logger.error('本地服务启动失败', { error: msg });
    dialog.showErrorBox('无法启动本地服务', msg);
    throw err;
  });

  const base = `http://${host}:${port}`;
  logger.info(`本地服务已就绪: ${base}`);
  logger.info(`AI 模式: ${brain.mode} | TTS: ${voice.provider} | 曲库: ${jukebox.index.length} 首`);

  sources.start();
  watchdog.start();

  createStageWindow(base);
  const area = screen.getPrimaryDisplay().workAreaSize;
  if (config.app.openAdmin && area.width >= 1000 && area.height >= 700) {
    createAdminWindow(base);
  } else if (config.app.openAdmin) {
    logger.info(`屏幕 ${area.width}x${area.height} 较小，跳过自动打开控制台（可从托盘菜单打开）`);
  }
  createTray(base);

  if (config.app.preventSleep) {
    psb = powerSaveBlocker.start('prevent-app-suspension');
  }
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: Boolean(config.app.autoStart) });
  }

  app.on('activate', () => {
    if (mainWindow) mainWindow.show();
  });
}

function createStageWindow(base) {
  const { width, height, kiosk } = config.stage;
  // 小屏 / 虚拟机里 800x600 放不下 1280x720，等比缩小到可用区域
  const area = screen.getPrimaryDisplay().workAreaSize;
  const scale = Math.min(1, (area.width - 8) / width, (area.height - 8) / height);
  const winW = Math.round(width * scale);
  const winH = Math.round(height * scale);
  if (scale < 1) {
    logger.warn(`屏幕可用区域 ${area.width}x${area.height} 小于舞台 ${width}x${height}，按 ${winW}x${winH} 显示`);
  }
  mainWindow = new BrowserWindow({
    width: winW,
    height: winH,
    useContentSize: true,
    frame: false,
    resizable: false,
    movable: true,
    show: false,
    backgroundColor: '#07111c',
    title: '大肥鱼直播',
    autoHideMenuBar: true,
    webPreferences: {
      backgroundThrottling: false,
      spellcheck: false,
      devTools: isDev,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenu(null);
  mainWindow.loadURL(`${base}/stage/`);
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (kiosk) mainWindow.setKiosk(true);
    logger.info('舞台窗口已显示');
  });
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.show();
      logger.warn('舞台窗口关闭被拦截（关闭应用请用托盘菜单）');
    }
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logger.error('舞台渲染进程退出', { reason: details.reason });
    setTimeout(() => {
      if (mainWindow && !quitting) {
        try { mainWindow.reload(); } catch (_) { /* ignore */ }
      }
    }, 2000);
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.on('unresponsive', () => logger.warn('舞台窗口无响应'));
}

function createAdminWindow(base) {
  if (adminWindow && !adminWindow.isDestroyed()) {
    adminWindow.show();
    adminWindow.focus();
    return;
  }
  const area = screen.getPrimaryDisplay().workAreaSize;
  adminWindow = new BrowserWindow({
    width: Math.min(1180, area.width),
    height: Math.min(820, area.height),
    minWidth: Math.min(900, area.width),
    minHeight: Math.min(600, area.height),
    title: '大肥鱼直播 · 控制台',
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  adminWindow.setMenu(null);
  adminWindow.loadURL(`${base}/admin/`);
  adminWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      adminWindow.hide();
    }
  });
}

function createTray(base) {
  try {
    if (!fs.existsSync(ICON)) {
      logger.warn('未找到托盘图标，跳过托盘');
      return;
    }
    const img = nativeImage.createFromPath(ICON);
    tray = new Tray(img.resize({ width: 16, height: 16 }));
    const menu = Menu.buildFromTemplate([
      { label: '显示舞台', click: () => mainWindow?.show() },
      { label: '打开控制台', click: () => createAdminWindow(base) },
      {
        label: '暂停自动回复',
        type: 'checkbox',
        checked: false,
        click: (item) => director?.setPaused(item.checked),
      },
      { label: '重启舞台渲染', click: () => mainWindow?.webContents.reloadIgnoringCache() },
      { type: 'separator' },
      { label: '打开数据目录', click: () => shell.openPath(path.join(isDev ? ROOT : app.getPath('userData'), 'data')) },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]);
    tray.setToolTip('大肥鱼直播');
    tray.setContextMenu(menu);
    tray.on('double-click', () => mainWindow?.show());
  } catch (err) {
    logger.warn(`托盘创建失败: ${err.message}`);
  }
}

app.on('before-quit', () => {
  quitting = true;
  try { sources?.stop(); } catch (_) { /* ignore */ }
  try { director?.stop(); } catch (_) { /* ignore */ }
  try { watchdog?.stop(); } catch (_) { /* ignore */ }
  try { store?.close(); } catch (_) { /* ignore */ }
  try { serverCtl?.close(); } catch (_) { /* ignore */ }
  try { if (psb !== null) powerSaveBlocker.stop(psb); } catch (_) { /* ignore */ }
  try { logger?.info('应用退出'); logger?.close(); } catch (_) { /* ignore */ }
});

app.on('window-all-closed', () => {
  // 24 小时直播：窗口全关也不退出，交给托盘 / 退出菜单
});

process.on('uncaughtException', (err) => {
  try { logger?.error(`未捕获异常: ${err.message}`, { stack: String(err.stack || '').slice(0, 400) }); } catch (_) { /* ignore */ }
});

process.on('unhandledRejection', (err) => {
  try { logger?.error(`未处理 Promise 拒绝: ${err && err.message}`); } catch (_) { /* ignore */ }
});
