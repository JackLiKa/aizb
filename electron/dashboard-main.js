'use strict';

// 后台窗口：只做「看板/控制台」的独立客户端，数据仍由主程序在 17890 端口提供。

const path = require('path');
const fs = require('fs');
const http = require('http');
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');

const ICON = path.join(__dirname, '..', 'build', 'icon.png');
const WAIT_PAGE = path.join(__dirname, 'dashboard-wait.html');
const DEFAULT_BASE = 'http://127.0.0.1:17890';
const PAGES = { dashboard: '/dashboard/', admin: '/admin/' };

let win = null;
let base = DEFAULT_BASE;
let page = 'dashboard';
let retryTimer = null;
let connecting = false;

app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.setAppUserModelId('com.dyzb.fish.dashboard');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });
  app.whenReady().then(() => {
    base = resolveBase();
    createWindow();
  }).catch((err) => {
    dialog.showErrorBox('启动失败', String(err && err.stack ? err.stack : err));
    app.quit();
  });
}

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

// 优先 --url，其次读主程序的 config.json，最后回落到默认端口
function resolveBase() {
  const fromArg = argValue('url').trim().replace(/\/+$/, '');
  if (fromArg) return fromArg;
  try {
    const cfgPath = path.join(app.getPath('appData'), '大肥鱼直播', 'data', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const host = String(cfg?.server?.host || '127.0.0.1');
    const port = Number(cfg?.server?.port) || 17890;
    return `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  } catch (_) {
    return DEFAULT_BASE;
  }
}

function targetUrl() {
  return `${base}${PAGES[page]}`;
}

function probe(url) {
  return new Promise((resolve) => {
    const req = http.get(`${url}/health`, { timeout: 1200 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function clearRetry() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
}

function showWait() {
  if (!win || win.isDestroyed()) return;
  win.loadFile(WAIT_PAGE, { query: { base, page } });
}

function scheduleRetry() {
  clearRetry();
  retryTimer = setTimeout(async () => {
    if (!win || win.isDestroyed()) return;
    if (await probe(base)) {
      clearRetry();
      win.loadURL(targetUrl());
      win.setTitle(`大肥鱼直播 · ${page === 'admin' ? '控制台' : '数据看板'}`);
    } else {
      scheduleRetry();
    }
  }, 2000);
}

async function connect() {
  if (!win || win.isDestroyed() || connecting) return;
  connecting = true;
  clearRetry();
  const ok = await probe(base);
  connecting = false;
  if (!win || win.isDestroyed()) return;
  if (ok) {
    win.loadURL(targetUrl());
    win.setTitle(`大肥鱼直播 · ${page === 'admin' ? '控制台' : '数据看板'}`);
  } else {
    showWait();
    scheduleRetry();
  }
}

function openPage(next) {
  page = next;
  connect();
}

function createWindow() {
  const area = require('electron').screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1280, area.width),
    height: Math.min(900, area.height),
    minWidth: Math.min(960, area.width),
    minHeight: Math.min(640, area.height),
    title: '大肥鱼直播 · 数据看板',
    backgroundColor: '#0b1220',
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 主程序中途退出/端口不通时退回等待页，避免一直白屏
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || url.startsWith('file:')) return;
    showWait();
    scheduleRetry();
  });

  win.on('closed', () => { win = null; });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '页面',
      submenu: [
        { label: '数据看板', accelerator: 'CmdOrCtrl+1', click: () => openPage('dashboard') },
        { label: '控制台', accelerator: 'CmdOrCtrl+2', click: () => openPage('admin') },
        { type: 'separator' },
        { label: '刷新', accelerator: 'CmdOrCtrl+R', click: () => win && win.reload() },
      ],
    },
    {
      label: '连接',
      submenu: [
        { label: `重新连接（${base}）`, click: () => connect() },
        { label: '在浏览器中打开', click: () => shell.openExternal(targetUrl()) },
      ],
    },
  ]));

  connect();
}
