#!/usr/bin/env node
'use strict';

/**
 * 抖音网页直播 弹幕/礼物/关注/点赞/进场 采集器
 * ------------------------------------------------------------------
 * 原理：用本机已安装的 Chrome / Edge（无头模式，临时 profile）通过 CDP 打开
 *       https://live.douyin.com/<房间号>，向页面注入 MutationObserver 脚本，
 *       把聊天区每条消息解析成规范化事件缓存到 window.__dyzbEvents，
 *       Node 侧定时 Runtime.evaluate 取走，打印 `EVENT <json>` 并 POST 到
 *       <ingest>/ingest（x-ingest-token），供 aizb 的 director 消费。
 *
 * 用法：
 *   node scripts/douyin-collector.js --room 123456789 --ingest http://127.0.0.1:17890
 *   node scripts/douyin-collector.js --room https://live.douyin.com/123456789 --probe --verbose
 *   node scripts/douyin-collector.js --room 123456789 --headless=false      # 可视化调试
 *   node scripts/douyin-collector.js --room 123456789 --dump-dom _analysis/douyin-real-dom.html
 *
 * 全部诊断日志走 stderr；stdout 只有 `EVENT {json}` / `STATUS {json}`，方便被父进程解析。
 * 不新增 npm 依赖：仅用 Node 内置 http/child_process/net/fs/os + 仓库已有的 ws。
 *
 * 平台改版后：只需要改 scripts/douyin-selectors.json（chatRoot/item/user/text/...数组），
 * 不用改本文件；拿真实页面 --dump-dom 出来的 HTML 片段对照新 class 名替换即可。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const PKG_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SELECTORS = path.join(__dirname, 'douyin-selectors.json');
const DEFAULT_INGEST = 'http://127.0.0.1:17890';
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 日志：stdout 只放 EVENT / STATUS；其余全部 stderr
// ---------------------------------------------------------------------------
let verbose = false;
function log(...args) {
  console.error('[douyin]', ...args);
}
function vlog(...args) {
  if (verbose) console.error('[douyin]', ...args);
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (typeof a !== 'string' || !a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    let key = a.slice(2);
    let val;
    const eq = key.indexOf('=');
    if (eq >= 0) {
      val = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else {
      const next = argv[i + 1];
      if (next === undefined || (typeof next === 'string' && next.startsWith('--'))) {
        val = true;
      } else {
        val = next;
        i += 1;
      }
    }
    out[key] = val;
  }
  return out;
}

function toBool(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v).toLowerCase();
  if (['1', 'true', 'yes', 'on', 'y'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(s)) return false;
  return fallback;
}

function toInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function printHelp() {
  console.log(
    [
      '抖音直播弹幕采集器（CDP 抓取 → POST /ingest）',
      '',
      '必填：',
      '  --room <房间号|URL>        抖音房间号（如 123456789）或完整 https://live.douyin.com/... URL',
      '',
      '可选：',
      '  --ingest <基础URL>         默认 http://127.0.0.1:17890（POST 到 <ingest>/ingest）',
      '  --token <x-ingest-token>   默认取 data/config.json 的 ingest.token，再退回 change-me',
      '  --headless=true|false      默认 true；false 会弹出可见浏览器窗口（调试用）',
      '  --selectors <path>         选择器配置，默认 scripts/douyin-selectors.json',
      '  --probe                    只打印 EVENT，不 POST（链路验证/干跑）',
      '  --verbose                  输出更多诊断到 stderr',
      '  --browser <path|chrome|edge> 指定浏览器可执行文件；默认自动探测 Chrome→Edge',
      '  --poll-ms <ms>             页面事件轮询间隔，默认 600',
      '  --status-ms <ms>           STATUS 打印间隔，默认 60000',
      '  --dedupe-ms <ms>           同 user+text 去重时间窗，默认 60000',
      '  --settle-ms <ms>           Page.load 之后等待 SPA 水合的额外时间，默认 3000',
      '  --duration <秒>            运行 N 秒后自动干净退出（测试用）',
      '  --max-reconnect <n>        浏览器/连接断开后的最大重连次数，默认 5；0 表示无限',
      '  --keep-alive-on-end        检测到下播后不退出（默认退出码 0）',
      '  --dump-dom <path>          注入脚本后 dump 页面 outerHTML（调试选择器用）',
      '  --screenshot <path>        注入脚本后截图（调试用）',
      '  --ua <UA|mobile>           覆盖 User-Agent；mobile 使用 iPhone UA（调试用）',
      '  --eval <js>                注入后执行一段 JS（可 async，结果打印到 stderr；调试用）',
      '  --eval-file <path>         从文件读 JS 执行（免命令行转义；调试用）',
      '  --eval-dump <path>         把 --eval 的结果写入文件（调试用）',
      '  --help                     显示本帮助',
      '',
      '输出契约：',
      '  EVENT {"type":"comment|gift|follow|like|enter","user":"...","text":"...","ts":123,...}',
      '  STATUS {"connected":true,"events":12,"room":"...",...}   （每 60s）',
    ].join('\n')
  );
}

// ---------------------------------------------------------------------------
// 浏览器探测（Windows Chrome/Edge 优先，兼容 macOS/Linux 便于仓库通用）
// ---------------------------------------------------------------------------
function browserCandidates() {
  const env = process.env;
  const pf = env.PROGRAMFILES || 'C:\\Program Files';
  const pf86 = env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const lad = env.LOCALAPPDATA || '';
  const list = [];
  // Chrome（Windows）
  list.push(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  list.push(path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  if (lad) list.push(path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  // Chrome（macOS / Linux）
  list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  list.push('/usr/bin/google-chrome');
  list.push('/usr/bin/chromium');
  list.push('/usr/bin/chromium-browser');
  // Edge（Windows）
  list.push(path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  list.push(path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  if (lad) list.push(path.join(lad, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  // Edge（macOS / Linux）
  list.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  list.push('/usr/bin/microsoft-edge');
  return list;
}

function findBrowser(hint) {
  const h = hint ? String(hint).trim() : '';
  if (h && (/[\\/]/.test(h) || /\.(exe|app|sh)$/i.test(h) || h.includes(' '))) {
    if (fs.existsSync(h)) return h;
    throw new Error(`--browser 指定的浏览器不存在: ${h}`);
  }
  let candidates = browserCandidates();
  if (h) {
    const kw = h.toLowerCase();
    const map = { chrome: 'chrome', edge: 'edge', msedge: 'edge', chromium: 'chromium' };
    const want = map[kw] || kw;
    const filtered = candidates.filter((p) => p.toLowerCase().includes(want));
    if (filtered.length) candidates = filtered;
    else throw new Error(`未找到名为 "${h}" 的浏览器，可用 --browser <exe 绝对路径> 指定`);
  }
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  throw new Error('未探测到 Chrome/Edge，请用 --browser <浏览器 exe 路径> 指定');
}

// ---------------------------------------------------------------------------
// 选择器配置
// ---------------------------------------------------------------------------
const FALLBACK_SELECTORS = {
  chatRoot: [
    'div[class*="webcast-chatroom___items"]',
    'div[class*="chatroom"]',
    '[data-e2e="chatroom"]',
  ],
  item: [
    'div[class*="webcast-chatroom___item"]',
    '[data-e2e="chat-item"]',
  ],
  user: ['[class*="user-name"]', '[class*="nickname"]', '[class*="author"]'],
  text: ['[class*="content-with-emoji"]', '[class*="chat-content"]'],
  giftItem: ['[class*="webcast-chatroom___gift"]', '[class*="gift-message"]'],
  giftName: ['[class*="gift-name"]', '[class*="giftName"]'],
  giftCount: ['[class*="gift-count"]', '[class*="giftCount"]'],
  followText: ['关注了主播', '关注了你'],
  likeText: ['点赞了主播', '点赞了'],
  enterText: ['来了', '进入直播间'],
  endedText: ['直播已结束', '直播结束', '暂未开播'],
  blockedText: ['请完成安全验证', '拖动滑块', '访问过于频繁'],
  giftValues: {},
  userAgent: DEFAULT_UA,
};

function asArray(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim()).map((s) => s.trim());
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

function mergeSelectors(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const key of Object.keys(FALLBACK_SELECTORS)) {
    if (key === 'giftValues' || key === 'userAgent') continue;
    const arr = asArray(src[key]);
    out[key] = arr.length ? arr : FALLBACK_SELECTORS[key].slice();
  }
  out.giftValues = {};
  if (src.giftValues && typeof src.giftValues === 'object' && !Array.isArray(src.giftValues)) {
    for (const [k, v] of Object.entries(src.giftValues)) {
      const n = Number(v);
      if (Number.isFinite(n)) out.giftValues[k] = n;
    }
  }
  out.userAgent = typeof src.userAgent === 'string' && src.userAgent.trim() ? src.userAgent.trim() : DEFAULT_UA;
  out.version = src.version || 0;
  out.updated = src.updated || '';
  return out;
}

function loadSelectors(file) {
  const p = path.resolve(file || DEFAULT_SELECTORS);
  if (!fs.existsSync(p)) {
    log(`选择器文件不存在，使用内置默认值: ${p}`);
    return { cfg: mergeSelectors({}), file: p, found: false };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { cfg: mergeSelectors(raw), file: p, found: true };
  } catch (e) {
    log(`选择器文件解析失败（使用内置默认值）: ${p} ${e.message}`);
    return { cfg: mergeSelectors({}), file: p, found: false };
  }
}

// ---------------------------------------------------------------------------
// HTTP 小工具（不引入新依赖）
// ---------------------------------------------------------------------------
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });

function request(urlStr, options = {}) {
  const { method = 'GET', headers = {}, body = null, timeoutMs = 8000 } = options;
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      reject(new Error(`非法 URL: ${urlStr}`));
      return;
    }
    const req = http.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method,
        headers,
        timeout: timeoutMs,
        agent: u.protocol === 'http:' ? httpAgent : undefined,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`请求超时(${timeoutMs}ms): ${urlStr}`)));
    req.on('error', (e) => reject(e));
    if (body) req.write(body);
    req.end();
  });
}

async function getJson(urlStr, timeoutMs = 3000) {
  const r = await request(urlStr, { timeoutMs });
  if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}: ${urlStr}`);
  return JSON.parse(r.text);
}

// ---------------------------------------------------------------------------
// CDP 客户端
// ---------------------------------------------------------------------------
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch (_) {
        return;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (p.timer) clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`CDP ${p.method} 失败: ${msg.error.message || JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) {
          try {
            fn(msg);
          } catch (_) {
            /* ignore listener errors */
          }
        }
      }
    });
    ws.on('close', () => {
      this.closed = true;
      for (const [, p] of this.pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new Error('CDP 连接已关闭'));
      }
      this.pending.clear();
    });
    ws.on('error', () => {});
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    return new Promise((resolve, reject) => {
      const id = (this.nextId += 1);
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  waitFor(method, sessionId, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error('CDP 连接已关闭'));
        return;
      }
      let done = false;
      const finish = (err, val) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off();
        if (err) reject(err);
        else resolve(val);
      };
      const timer = setTimeout(() => finish(new Error(`等待 CDP 事件 ${method} 超时(${timeoutMs}ms)`)), timeoutMs);
      const off = this.on((msg) => {
        if (msg.method !== method) return;
        if (sessionId && msg.sessionId && msg.sessionId !== sessionId) return;
        finish(null, msg.params);
      });
    });
  }

  close() {
    try {
      this.ws.close();
    } catch (_) {
      /* ignore */
    }
  }
}

function wsConnect(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: timeoutMs });
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch (_) {
        /* ignore */
      }
      reject(new Error(`连接 CDP WebSocket 超时: ${url}`));
    }, timeoutMs + 1000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// ---------------------------------------------------------------------------
// 浏览器启动（无头 Chrome/Edge + 随机调试端口 + 临时 profile）
// ---------------------------------------------------------------------------
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function waitDebugger(port, timeoutMs, getStderr) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    if (getStderr) {
      const er = getStderr();
      if (er !== null && er !== undefined) throw new Error(`浏览器进程提前退出: ${String(er).trim().slice(-800)}`);
    }
    try {
      const info = await getJson(`http://127.0.0.1:${port}/json/version`, 1500);
      if (info && info.webSocketDebuggerUrl) return info;
      lastErr = new Error('调试端口已响应但没有 webSocketDebuggerUrl');
    } catch (e) {
      lastErr = e;
    }
    await sleep(180);
  }
  throw new Error(`浏览器调试端口未就绪(port=${port}): ${lastErr ? lastErr.message : ''}`);
}

async function launchBrowser({ exe, headless, verbose: v }) {
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dyzb-douyin-'));
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=Translate,OptimizationHints,MediaRouter',
    '--mute-audio',
    '--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--window-size=1280,800',
    '--lang=zh-CN',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');
  vlog(`启动浏览器: ${exe} (headless=${headless}, port=${port}, profile=${profile})`);
  const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  let exited = false;
  child.stderr.on('data', (d) => {
    stderr = (stderr + String(d)).slice(-8000);
  });
  child.on('exit', () => {
    exited = true;
  });
  const getStderr = () => (exited ? stderr || '(无 stderr 输出)' : null);
  try {
    const info = await waitDebugger(port, 25000, getStderr);
    return { child, port, profile, info };
  } catch (e) {
    try {
      child.kill();
    } catch (_) {
      /* ignore */
    }
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 2 });
    } catch (_) {
      /* ignore */
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 注入到页面的采集脚本（String.raw 保留正则反斜杠；不要在此字符串里使用模板插值）
// ---------------------------------------------------------------------------
const PAGE_TEMPLATE = String.raw`(function () {
  if (window.__dyzbInstalled) {
    return { ok: true, reused: true, root: (window.__dyzbStatus || {}).root || null };
  }
  var CFG = __CFG__;
  window.__dyzbInstalled = true;
  if (!window.__dyzbEvents) window.__dyzbEvents = [];
  if (!window.__dyzbSeen) window.__dyzbSeen = new WeakSet();
  var S = {
    installed: true,
    root: null,
    rootKind: null,
    ended: false,
    blocked: false,
    items: 0,
    seen: 0,
    errors: 0,
    title: document.title || '',
    url: location.href,
    installedAt: Date.now(),
    lastMutationAt: Date.now(),
    reinjects: 0
  };
  window.__dyzbStatus = S;

  function txt(el) {
    if (!el) return '';
    var t = el.innerText || el.textContent || '';
    return String(t).replace(/\s+/g, ' ').trim();
  }
  function sel1(root, list) {
    if (!list) return null;
    if (typeof list === 'string') list = [list];
    for (var i = 0; i < list.length; i++) {
      var el = null;
      try { el = root.querySelector(list[i]); } catch (e) { el = null; }
      if (el) return el;
    }
    return null;
  }
  function selAll(root, list, cap) {
    var out = [];
    if (!list) return out;
    if (typeof list === 'string') list = [list];
    for (var i = 0; i < list.length; i++) {
      var ns = [];
      try { ns = root.querySelectorAll(list[i]); } catch (e) { ns = []; }
      for (var j = 0; j < ns.length; j++) {
        if (out.indexOf(ns[j]) < 0) out.push(ns[j]);
        if (cap && out.length >= cap) return out;
      }
    }
    return out;
  }
  function matchesAny(el, list) {
    if (!el || el.nodeType !== 1 || !list) return false;
    if (typeof list === 'string') list = [list];
    for (var i = 0; i < list.length; i++) {
      try { if (el.matches(list[i])) return true; } catch (e) { /* ignore */ }
    }
    return false;
  }
  function classOf(el) {
    if (!el) return '';
    var c = el.className;
    if (typeof c !== 'string') c = (el.getAttribute && el.getAttribute('class')) || '';
    var de = (el.getAttribute && (el.getAttribute('data-e2e') || '')) || '';
    return String(c) + ' ' + de;
  }
  function markOf(list, hay) {
    if (!list) return false;
    for (var i = 0; i < list.length; i++) {
      if (hay.indexOf(list[i]) >= 0) return true;
    }
    return false;
  }
  function markerUser(hay, list) {
    if (!list || !hay) return '';
    for (var i = 0; i < list.length; i++) {
      var mk = list[i];
      var idx = hay.lastIndexOf(mk);
      if (idx < 0) continue;
      var head = hay.slice(0, idx).replace(/[：:\s]+$/, '').trim();
      if (head && head.length <= 24) return head;
    }
    return '';
  }

  function findRoot() {
    var list = CFG.chatRoot;
    if (typeof list === 'string') list = [list];
    var best = null;
    var bestN = -1;
    var bestSel = '';
    for (var i = 0; i < list.length; i++) {
      var el = null;
      try { el = document.querySelector(list[i]); } catch (e) { el = null; }
      if (!el) continue;
      var n = selAll(el, CFG.item, 4).length;
      if (n > bestN) { bestN = n; best = el; bestSel = list[i]; }
    }
    if (best) return { el: best, kind: 'selector', sel: bestSel };
    // 兜底 1：按 class 关键字找聊天容器
    var cands = selAll(document, [
      'div[class*="chatroom"]',
      'div[class*="chat-room"]',
      'div[class*="chat_list"]',
      'div[class*="chat-list"]',
      'div[data-e2e*="chat"]',
      'ul[class*="chat"]'
    ], 40);
    var hbest = null;
    var hscore = 0;
    for (var k = 0; k < cands.length; k++) {
      var sc = selAll(cands[k], CFG.item, 30).length;
      if (!sc) sc = cands[k].querySelectorAll('[class*="item"]').length;
      if (sc > hscore) { hscore = sc; hbest = cands[k]; }
    }
    if (hbest && hscore > 0) return { el: hbest, kind: 'heuristic', sel: 'heuristic:' + hbest.childElementCount };
    // 兜底 2：body 全量观察（选择器全失效时仍可能捞到）
    return { el: document.body, kind: 'body', sel: 'body' };
  }

  // 抖音网页版昵称/正文都挂在 hash 过的 class 上（如 v8LY0gZF / cL385mHb），
  // 没法用固定选择器命中，所以额外按「叶子文本节点顺序」拆：第 1 段=昵称，其余=正文。
  function leafTexts(el) {
    var out = [];
    if (!el) return out;
    var all = el.querySelectorAll('span, a, p, div');
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      if (n.childElementCount !== 0) continue;
      if (n.querySelector && n.querySelector('img')) continue;
      var t = (n.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      out.push(t);
    }
    if (!out.length) {
      var whole = txt(el);
      if (whole) out.push(whole);
    }
    return out;
  }

  // 只有正文恰好等于系统文案（可带 xN 数量）才算 follow/like/enter，
  // 避免把「你来了」「我刚点赞了」这类普通弹幕误判。
  function exactMarker(text, list) {
    var t = String(text || '').trim();
    if (!t || !list) return '';
    for (var i = 0; i < list.length; i++) {
      var mk = list[i];
      if (t === mk) return mk;
      if (t.indexOf(mk) === 0) {
        var rest = t.slice(mk.length).trim();
        if (!rest || /^[×xX]?\s*\d{1,5}$/.test(rest)) return mk;
      }
    }
    return '';
  }

  function classify(el) {
    var full = txt(el);
    if (!full || full.length > 300) return null;
    var cls = classOf(el);
    var userEl = sel1(el, CFG.user);
    var textEl = sel1(el, CFG.text);
    var pieces = leafTexts(el);
    var user = userEl ? txt(userEl) : '';
    var content = textEl ? txt(textEl) : '';
    if (!user && pieces.length >= 2) user = pieces[0];
    if (!content && pieces.length >= 2) content = pieces.slice(1).join(' ');
    else if (!content && pieces.length === 1) content = pieces[0];
    user = String(user || '').replace(/[：:]\s*$/, '').trim();
    content = String(content || '').replace(/^[：:\s]+/, '').trim();
    if (!content) content = full;
    var hay = content || full;
    // 系统消息容器（进场/关注/点赞等），未知系统文案直接丢弃，别当弹幕喂给大脑
    var isRoomMsg = false;
    try { isRoomMsg = !!el.querySelector('.webcast-chatroom__room-message'); } catch (e) { isRoomMsg = false; }

    var giftNameEl = sel1(el, CFG.giftName);
    var giftCountEl = sel1(el, CFG.giftCount);
    var giftImg = el.querySelector ? el.querySelector('img[src*="gift"], img[src*="Gift"]') : null;
    var isGift = false;
    if (giftNameEl || (CFG.giftItem && matchesAny(el, CFG.giftItem))) isGift = true;
    else if (/gift|礼物|送出|赠送/i.test(cls)) isGift = true;
    else if (giftImg && /(送出|赠送|礼物)/.test(hay)) isGift = true;
    else if (/(送出|赠送)\s*[^\s，,。！!]{1,16}/.test(hay) && hay.length <= 60 && pieces.length <= 5) isGift = true;

    var kind = 'comment';
    var enterCount = 0;
    var agg = hay.match(/^等?\s*(\d{1,6})\s*人来了\s*$/);
    if (!agg) agg = hay.match(/^(\d{1,6})\s*人来了\s*$/);
    if (isGift) kind = 'gift';
    else if (agg) { kind = 'enter'; enterCount = parseInt(agg[1], 10) || 1; }
    else if (exactMarker(hay, CFG.followText)) kind = 'follow';
    else if (exactMarker(hay, CFG.likeText)) kind = 'like';
    else if (exactMarker(hay, CFG.enterText)) kind = 'enter';
    // 命中独立正文元素且正文不是整行 → 普通评论（防「来了」类误判）
    if (kind !== 'gift' && kind !== 'comment' && textEl && content && content !== full) kind = 'comment';
    if (isRoomMsg && kind === 'comment') return null;

    if (kind === 'gift') {
      var gname = giftNameEl ? txt(giftNameEl) : '';
      if (!gname) {
        var gm = hay.match(/(?:送出|赠送)\s*([^\s，,。！!×xX]{1,20})/);
        if (gm) gname = gm[1].trim();
      }
      if (!gname) {
        var gm2 = hay.match(/([^\s，,。！!×xX：:]{1,20})\s*[×xX]\s*\d{1,5}/);
        if (gm2) gname = gm2[1].trim();
      }
      if (!gname) {
        var rest = hay;
        if (user) rest = rest.split(user).join(' ');
        rest = rest.replace(/^[：:\s]+/, '').replace(/^(送出|赠送|送)\s*/, '');
        var tok = rest.split(/[\s×xX，,]+/)[0];
        if (tok && tok.length <= 20) gname = tok;
      }
      if (!gname) gname = '礼物';
      var cnt = 1;
      if (giftCountEl) {
        var cn = parseInt(String(txt(giftCountEl)).replace(/[^0-9]/g, ''), 10);
        if (cn > 0) cnt = cn;
      }
      if (cnt === 1) {
        var cm = hay.match(/[×xX]\s*(\d{1,5})/);
        if (cm) cnt = parseInt(cm[1], 10) || 1;
      }
      if (cnt === 1) {
        var cm2 = hay.match(/(\d{1,5})\s*(?:个|次)/);
        if (cm2) cnt = parseInt(cm2[1], 10) || 1;
      }
      var value = 0;
      try {
        if (CFG.giftValues && Object.prototype.hasOwnProperty.call(CFG.giftValues, gname)) value = CFG.giftValues[gname];
      } catch (e) { value = 0; }
      return {
        type: 'gift',
        user: user || '神秘人',
        giftName: gname,
        count: cnt,
        value: value,
        text: full.slice(0, 120),
        ts: Date.now()
      };
    }

    if (kind === 'like') {
      var lc = 1;
      var lm = hay.match(/(\d{1,6})\s*(?:个|次)?\s*(?:赞|点赞)/);
      if (lm) lc = parseInt(lm[1], 10) || 1;
      if (!user) user = '匿名观众';
      return { type: 'like', user: user, text: '', count: lc, ts: Date.now() };
    }
    if (kind === 'follow') {
      if (!user) user = '匿名观众';
      return { type: 'follow', user: user, text: '', ts: Date.now() };
    }
    if (kind === 'enter') {
      if (!user) user = '匿名观众';
      return { type: 'enter', user: user, text: '', count: enterCount || 1, ts: Date.now() };
    }

    // comment
    if (!user) {
      var um = full.match(/^(.{1,24}?)[：:]\s*(.+)$/);
      if (um) {
        user = um[1].trim();
        if (!content) content = um[2].trim();
      }
    }
    if (!content) {
      content = full;
      if (user && content.indexOf(user) === 0) content = content.slice(user.length).replace(/^[：:\s]+/, '');
    }
    if (!user) user = '匿名观众';
    if (!content) return null;
    return { type: 'comment', user: user, text: content.slice(0, 200), ts: Date.now() };
  }

  var rootEl = null;
  var observer = null;

  function attach() {
    var r = findRoot();
    rootEl = r.el || document.body;
    S.root = r.sel || r.kind;
    S.rootKind = r.kind;
    S.reinjects += 1;
    if (observer) {
      try { observer.disconnect(); } catch (e) { /* ignore */ }
    }
    observer = new MutationObserver(function (muts) {
      S.lastMutationAt = Date.now();
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type !== 'childList' || !m.addedNodes || !m.addedNodes.length) continue;
        for (var j = 0; j < m.addedNodes.length; j++) ingestNode(m.addedNodes[j]);
      }
    });
    // 同时观察聊天容器与整个 body：未登录时抖音网页版把「别人的弹幕」画在视频覆盖层里，
    // 可能不在右侧聊天面板容器内，只观察容器会漏；用 item 选择器过滤，不会误收其他 UI。
    try { observer.observe(rootEl, { childList: true, subtree: true }); } catch (e) { /* ignore */ }
    if (rootEl !== document.body && document.body) {
      try { observer.observe(document.body, { childList: true, subtree: true }); } catch (e) { /* ignore */ }
    }
    var existing = selAll(document, CFG.item, 300);
    for (var k = 0; k < existing.length; k++) processItem(existing[k]);
  }

  // 记录每种「消息元素 class 签名」的样本（含 outerHTML 片段），
  // 平台改版后从 --dump-dom 生成的 .diag.json 里就能看到新结构，照着改 selectors.json。
  function recordSample(el) {
    try {
      if (!window.__dyzbClassSigs) window.__dyzbClassSigs = {};
      var bag = window.__dyzbClassSigs;
      var kind = 'chat';
      try { if (el.querySelector('.webcast-chatroom__room-message')) kind = 'room'; } catch (e) { /* ignore */ }
      var sig = (String(classOf(el)).replace(/\s+/g, ' ').trim().slice(0, 180) || '(no-class)') + ' | ' + kind;
      if (bag[sig]) {
        bag[sig].n = (bag[sig].n || 1) + 1;
        return;
      }
      var keys = Object.keys(bag);
      if (keys.length >= 40) return;
      bag[sig] = {
        n: 1,
        text: txt(el).slice(0, 160),
        html: (el.outerHTML || '').slice(0, 1200)
      };
    } catch (e) { /* ignore */ }
  }

  function ingestNode(node) {
    if (!node || node.nodeType !== 1) return;
    if (matchesAny(node, CFG.item)) { processItem(node); return; }
    var kids = selAll(node, CFG.item, 100);
    if (kids.length) {
      for (var i = 0; i < kids.length; i++) processItem(kids[i]);
      return;
    }
    // 兜底只在确认了真实聊天容器时启用；root 退化为 body 时不能把任意直接子元素当弹幕
    if (S.rootKind !== 'body' && node.parentElement === rootEl && node.childElementCount >= 1) {
      var t = txt(node);
      if (t && t.length <= 300) processItem(node);
    }
  }

  function processItem(el) {
    if (!el || el.nodeType !== 1) return;
    // item-wrapper 是 item 的内层容器（class 同时命中 item 选择器），跳过避免重复解析
    try {
      if (/webcast-chatroom___item-wrapper/.test(classOf(el))) return;
    } catch (e) { /* ignore */ }
    // 列表容器（如 webcast-chatroom___items）的 class 也包含 "chatroom___item" 子串，跳过；
    // 含 2 条以上 item 的容器同理，避免把整片聊天记录误当成一条消息。
    try {
      if (/chatroom___items/.test(classOf(el))) return;
      if (selAll(el, CFG.item, 3).length >= 2) return;
    } catch (e) { /* ignore */ }
    try {
      if (window.__dyzbSeen.has(el)) return;
      window.__dyzbSeen.add(el);
    } catch (e) { return; }
    // 抖音同一条消息可能同时挂在两个虚拟列表里（data-id 相同），按 data-id 去重
    try {
      var did = el.getAttribute ? el.getAttribute('data-id') : '';
      if (did) {
        if (!window.__dyzbIds) window.__dyzbIds = Object.create(null);
        var ids = window.__dyzbIds;
        if (ids[did]) return;
        ids[did] = 1;
        if (Object.keys(ids).length > 3000) window.__dyzbIds = Object.create(null);
      }
    } catch (e) { /* ignore */ }
    try { el.setAttribute('data-dyzb-seen', '1'); } catch (e) { /* ignore */ }
    recordSample(el);
    var ev = null;
    try { ev = classify(el); } catch (e) { S.errors += 1; return; }
    if (!ev) return;
    S.seen += 1;
    S.items = S.seen;
    try {
      window.__dyzbEvents.push(ev);
      if (window.__dyzbEvents.length > 500) window.__dyzbEvents.splice(0, window.__dyzbEvents.length - 500);
    } catch (e) {
      S.errors += 1;
    }
  }

  attach();

  setInterval(function () {
    try {
      S.title = document.title || '';
      S.url = location.href;
      if (!rootEl || !rootEl.isConnected) {
        attach();
      } else if (S.rootKind === 'body') {
        // 注入时聊天区可能还没渲染，root 退化为 body；每 5s 尝试升级到真实容器
        if (Date.now() - (S.lastRootProbe || 0) > 5000) {
          S.lastRootProbe = Date.now();
          var probe0 = findRoot();
          if (probe0.el && probe0.kind !== 'body' && probe0.el !== rootEl) attach();
        }
      } else if (Date.now() - S.lastMutationAt > 10000) {
        var probe = findRoot();
        if (probe.el && probe.el !== rootEl) attach();
      }
      if (!S.ended && Date.now() - S.lastMutationAt > 5000 && document.body) {
        var b = document.body.innerText || '';
        if (b.length > 150000) b = b.slice(0, 150000);
        if (markOf(CFG.endedText, b)) S.ended = true;
        if (!S.blocked && markOf(CFG.blockedText, b)) S.blocked = true;
      }
    } catch (e) {
      S.errors += 1;
    }
  }, 4000);

  // 调试钩子：配合 --eval 可在真实页面里检查某节点的解析结果 / 当前 root
  window.__dyzbClassify = function (el) {
    try { return classify(el); } catch (e) { return { error: String((e && e.message) || e) }; }
  };
  window.__dyzbFindRoot = function () {
    try {
      var r = findRoot();
      return { kind: r.kind, sel: r.sel, text: txt(r.el).slice(0, 120) };
    } catch (e) { return { error: String((e && e.message) || e) }; }
  };

  return { ok: true, root: S.root, rootKind: S.rootKind, items: S.items };
})()`;

// 页面加载前注入：降低 headless/自动化特征（抖音对 webdriver 较敏感）
const STEALTH_SCRIPT = [
  'try { Object.defineProperty(navigator, "webdriver", { get: function () { return undefined; } }); } catch (e) {}',
  'try { Object.defineProperty(navigator, "platform", { get: function () { return "Win32"; } }); } catch (e) {}',
  'try { Object.defineProperty(navigator, "languages", { get: function () { return ["zh-CN", "zh"]; } }); } catch (e) {}',
  'try { Object.defineProperty(navigator, "hardwareConcurrency", { get: function () { return 8; } }); } catch (e) {}',
].join('\n');

function buildPageScript(cfg) {
  return PAGE_TEMPLATE.replace('__CFG__', () => JSON.stringify(cfg));
}

// ---------------------------------------------------------------------------
// 运行时状态
// ---------------------------------------------------------------------------
const state = {
  opts: {},
  room: '',
  roomUrl: '',
  ingestBase: DEFAULT_INGEST,
  token: '',
  probe: false,
  selectors: null,
  selectorsFile: '',
  browserExe: '',
  startedAt: Date.now(),
  statusTimer: null,
  durationTimer: null,
  sessions: 0,
  reconnects: 0,
  events: 0,
  posted: 0,
  failed: 0,
  lastEventAt: 0,
  connected: false,
  ended: false,
  root: null,
  pageUrl: '',
  stopping: false,
  finishing: false,
  dumped: false,
  shot: false,
  current: null,
  dedupe: new Map(),
  postChain: Promise.resolve(),
  diagnostics: {},
};

function loadDefaultToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'data', 'config.json'), 'utf8'));
    const t = cfg && cfg.ingest && cfg.ingest.token;
    return typeof t === 'string' && t ? t : 'change-me';
  } catch (_) {
    return 'change-me';
  }
}

function normalizeRoom(room) {
  const s = String(room || '').trim();
  if (!s) throw new Error('--room 不能为空');
  if (/^https?:\/\//i.test(s)) return { room: s, url: s };
  if (/^\d+$/.test(s)) return { room: s, url: `https://live.douyin.com/${s}` };
  return { room: s, url: `https://live.douyin.com/${s.replace(/^\/+/, '')}` };
}

function statusSnapshot(extra) {
  const now = Date.now();
  return Object.assign(
    {
      collector: 'douyin',
      room: state.room,
      connected: state.connected,
      mode: state.probe ? 'probe' : 'ingest',
      events: state.events,
      posted: state.posted,
      failed: state.failed,
      reconnects: state.reconnects,
      sessions: state.sessions,
      ended: state.ended,
      root: state.root,
      url: state.pageUrl || state.roomUrl,
      browser: state.browserExe ? path.basename(state.browserExe) : null,
      uptimeSec: Math.round((now - state.startedAt) / 1000),
      lastEventAgoSec: state.lastEventAt ? Math.round((now - state.lastEventAt) / 1000) : null,
    },
    extra || {}
  );
}

function printStatus(extra) {
  console.log(`STATUS ${JSON.stringify(statusSnapshot(extra))}`);
}

// ---------------------------------------------------------------------------
// 事件去重 + 输出 + POST /ingest
// ---------------------------------------------------------------------------
function makeDedupeKey(ev) {
  if (ev.type === 'comment') return `comment|${ev.user}|${ev.text}`;
  if (ev.type === 'gift') return `gift|${ev.user}|${ev.giftName}|${ev.count}`;
  if (ev.type === 'like') return `like|${ev.user}`;
  return `${ev.type}|${ev.user}`;
}

function pruneDedupe(now) {
  if (state.dedupe.size <= 1200) return;
  const win = state.opts.dedupeMs;
  for (const [k, t] of state.dedupe) {
    if (now - t > win) state.dedupe.delete(k);
  }
  if (state.dedupe.size > 3000) state.dedupe.clear();
}

function enqueuePost(out) {
  const body = JSON.stringify(out);
  const url = `${state.ingestBase.replace(/\/+$/, '')}/ingest`;
  state.postChain = state.postChain
    .then(async () => {
      try {
        const r = await request(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'x-ingest-token': state.token,
          },
          body,
          timeoutMs: 5000,
        });
        if (r.status >= 200 && r.status < 300) {
          state.posted += 1;
          vlog(`POST ok ${r.status} ${out.type} ${out.user}`);
        } else {
          state.failed += 1;
          log(`POST 失败 HTTP ${r.status} (${r.text.slice(0, 120)}) — 检查 --ingest / --token`);
        }
      } catch (e) {
        state.failed += 1;
        log(`POST 错误: ${e.message}`);
      }
    })
    .catch(() => {});
}

function handleEvent(raw) {
  if (!raw || typeof raw !== 'object' || !raw.type) return;
  const ev = {
    type: String(raw.type),
    user: String(raw.user || '匿名观众').slice(0, 24),
    text: typeof raw.text === 'string' ? raw.text.slice(0, 200) : '',
    ts: Number(raw.ts) || Date.now(),
  };
  if (ev.type === 'gift') {
    ev.giftName = String(raw.giftName || '礼物').slice(0, 32);
    ev.count = Math.max(1, Number(raw.count) || 1);
    ev.value = Math.max(0, Number(raw.value) || 0);
  } else if (ev.type === 'like' || ev.type === 'enter') {
    const n = Number(raw.count);
    if (n > 0) ev.count = Math.max(1, n);
  }
  const key = makeDedupeKey(ev);
  const now = Date.now();
  const last = state.dedupe.get(key);
  if (last && now - last < state.opts.dedupeMs) return;
  state.dedupe.set(key, now);

  state.events += 1;
  state.lastEventAt = now;
  const out = Object.assign({}, ev, { room: state.room });
  console.log(`EVENT ${JSON.stringify(out)}`);
  if (!state.probe) enqueuePost(out);
  pruneDedupe(now);
}

// ---------------------------------------------------------------------------
// 单次采集会话：启动浏览器 → 注入 → 轮询事件
// ---------------------------------------------------------------------------
async function evalValue(session, expression, timeoutMs = 15000) {
  const r = await session.cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: false },
    session.sid,
    timeoutMs
  );
  if (r.exceptionDetails) {
    const desc = (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '';
    throw new Error(`页面脚本异常: ${r.exceptionDetails.text || ''} ${desc}`.trim());
  }
  return r.result ? r.result.value : undefined;
}

async function pollEvents(session) {
  const expr =
    'JSON.stringify({ e: (window.__dyzbEvents || []).splice(0, 200), s: window.__dyzbStatus || null })';
  const value = await evalValue(session, expr, 10000);
  if (!value) return { e: [], s: null };
  let data;
  try {
    data = JSON.parse(value);
  } catch (_) {
    return { e: [], s: null };
  }
  return data && typeof data === 'object' ? data : { e: [], s: null };
}

async function pollWithRetry(session) {
  let lastErr = null;
  for (let i = 0; i < 3; i += 1) {
    if (state.stopping) throw new Error('正在退出');
    try {
      return await pollEvents(session);
    } catch (e) {
      lastErr = e;
      await sleep(400);
      if (session.cdp && session.cdp.closed) throw new Error('CDP 连接断开');
      // 尝试确认页面上下文是否还在
      try {
        await evalValue(session, '1+1', 5000);
        return { e: [], s: null };
      } catch (_) {
        /* 继续重试 */
      }
    }
  }
  throw lastErr || new Error('页面轮询失败');
}

const DIAG_EXPR =
  'JSON.stringify({ts:Date.now(),title:document.title,url:location.href,bodyText:(document.body?document.body.innerText:"").slice(0,1200),' +
  'itemNodes:(function(){var out={};try{var ns=document.querySelectorAll(\'div[class*=chatroom___item],div[class*=chat-item],[data-e2e="chat-item"],[class*=danmaku],[class*=Danmaku]\');out.n=ns.length;for(var i=0;i<ns.length&&i<8;i++){out["i"+i]={cls:String(ns[i].className).slice(0,180),text:(ns[i].innerText||"").slice(0,120)}}}catch(e){out.err=String(e)}return out})(),' +
  'canvases:(function(){var out=[];try{var cs=document.querySelectorAll("canvas");for(var i=0;i<cs.length&&i<10;i++){out.push({cls:String(cs[i].className).slice(0,80),w:cs[i].width,h:cs[i].height})}}catch(e){}return out})(),' +
  'status:window.__dyzbStatus||null,samples:window.__dyzbClassSigs||null})';

async function writeDiag(session) {
  if (!state.opts.dumpDom) return;
  const out = path.resolve(String(state.opts.dumpDom));
  try {
    const diag = await evalValue(session, DIAG_EXPR, 15000);
    fs.writeFileSync(`${out}.diag.json`, String(diag || '{}'), 'utf8');
    vlog(`已更新诊断: ${out}.diag.json`);
  } catch (e) {
    log(`写诊断失败: ${e.message}`);
  }
}

async function maybeDump(session) {
  const opts = state.opts;
  if (opts.dumpDom && !state.dumped) {
    state.dumped = true;
    try {
      const html = await evalValue(session, 'document.documentElement.outerHTML', 30000);
      const out = path.resolve(String(opts.dumpDom));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, String(html || ''), 'utf8');
      log(`已 dump DOM: ${out} (${String(html || '').length} bytes)`);
      await writeDiag(session);
      log(`已写诊断: ${out}.diag.json`);
    } catch (e) {
      log(`dump DOM 失败: ${e.message}`);
    }
  }
  if (opts.evalJs && !state.evalRan) {
    state.evalRan = true;
    try {
      const r = await session.cdp.send(
        'Runtime.evaluate',
        { expression: String(opts.evalJs), returnByValue: true, awaitPromise: true },
        session.sid,
        120000
      );
      if (r.exceptionDetails) {
        log(`--eval 异常: ${r.exceptionDetails.text || ''}`);
      } else {
        const val = r.result && r.result.value;
        const text = typeof val === 'string' ? val : JSON.stringify(val);
        if (opts.evalDump) {
          const out = path.resolve(String(opts.evalDump));
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, String(text || ''), 'utf8');
          log(`--eval 结果已写入: ${out} (${String(text || '').length} bytes)`);
        } else {
          log(`EVAL ${String(text || '').slice(0, 4000)}`);
        }
      }
    } catch (e) {
      log(`--eval 失败: ${e.message}`);
    }
  }
  if (opts.screenshot && !state.shot) {
    state.shot = true;
    try {
      const shot = await session.cdp.send(
        'Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: false },
        session.sid,
        30000
      );
      const out = path.resolve(String(opts.screenshot));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
      log(`已截图: ${out}`);
    } catch (e) {
      log(`截图失败: ${e.message}`);
    }
  }
}

async function runSession() {
  const opts = state.opts;
  const session = { cdp: null, child: null, profile: null, port: null, sid: null, closed: false, cleaned: false };
  state.current = session;
  try {
    state.browserExe = findBrowser(opts.browser);
    const launched = await launchBrowser({ exe: state.browserExe, headless: opts.headless, verbose });
    session.child = launched.child;
    session.profile = launched.profile;
    session.port = launched.port;

    const ws = await wsConnect(launched.info.webSocketDebuggerUrl, 15000);
    session.cdp = new Cdp(ws);

    const { targetId } = await session.cdp.send('Target.createTarget', { url: 'about:blank' }, undefined, 15000);
    const attached = await session.cdp.send('Target.attachToTarget', { targetId, flatten: true }, undefined, 15000);
    session.sid = attached.sessionId;
    await session.cdp.send('Page.enable', {}, session.sid, 15000);
    await session.cdp.send('Runtime.enable', {}, session.sid, 15000);
    try {
      await session.cdp.send(
        'Emulation.setUserAgentOverride',
        {
          userAgent: state.opts.ua || state.selectors.userAgent,
          acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.6',
          platform: state.opts.ua && state.opts.ua !== state.selectors.userAgent ? 'iPhone' : 'Win32',
        },
        session.sid,
        8000
      );
    } catch (_) {
      /* 老版本浏览器可能不支持，忽略 */
    }
    try {
      await session.cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      }, session.sid, 8000);
    } catch (_) {
      /* ignore */
    }
    await session.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_SCRIPT }, session.sid, 8000);

    log(`打开房间页: ${state.roomUrl}`);
    const loaded = session.cdp
      .waitFor('Page.loadEventFired', session.sid, 45000)
      .then(() => true)
      .catch(() => false);
    const nav = await session.cdp.send('Page.navigate', { url: state.roomUrl }, session.sid, 45000);
    if (nav && nav.errorText) throw new Error(`导航失败: ${nav.errorText}`);
    // 抖音直播页是重 SPA，loadEventFired 偶尔很晚甚至不触发；最多等 12s 就继续注入
    const loadOk = await Promise.race([loaded, sleep(12000).then(() => false)]);
    vlog(`页面 load 事件: ${loadOk ? '已触发' : '12s 内未触发，继续'}`);
    // 等待 SPA 水合 / 聊天区渲染
    await sleep(opts.settleMs);
    try {
      const pageProbe = await evalValue(
        session,
        'JSON.stringify({ready:document.readyState,title:document.title,url:location.href,htmlLen:(document.body?document.body.innerHTML.length:0)})',
        10000
      );
      vlog(`页面状态: ${pageProbe}`);
    } catch (e) {
      vlog(`页面状态读取失败: ${e.message}`);
    }

    const inject = await evalValue(session, buildPageScript(state.selectors), 20000);
    if (!inject || !inject.ok) throw new Error(`采集脚本注入失败: ${JSON.stringify(inject)}`);
    state.connected = true;
    state.sessions += 1;
    state.root = inject.root;
    log(`已注入采集脚本 root=${inject.root} kind=${inject.rootKind} preExisting=${inject.items} items`);

    await maybeDump(session);

    let endedReported = false;
    let blockedWarned = false;
    let lastDiagAt = Date.now();

    while (!state.stopping && !session.closed) {
      const data = await pollWithRetry(session);
      const s = data.s;
      if (s) {
        state.root = s.root || state.root;
        state.pageUrl = s.url || state.pageUrl;
        if (s.installed === false) {
          // 页面刷新/跳转导致注入丢失 → 重新注入
          vlog('检测到页面上下文重置，重新注入');
          const again = await evalValue(session, buildPageScript(state.selectors), 20000);
          if (again && again.ok) state.root = again.root;
        }
        if (s.blocked && !blockedWarned) {
          blockedWarned = true;
          log('⚠ 页面出现安全验证/登录拦截文案（blockedText 命中），弹幕可能抓不到。可尝试 --headless=false 手动过验证，或检查网络/频率。');
          state.diagnostics.blocked = true;
        }
      }
      const evs = Array.isArray(data.e) ? data.e : [];
      for (const ev of evs) handleEvent(ev);

      // 调试：--dump-dom 时每 10s 刷新一次诊断（含消息 class 样本），便于改版后适配选择器
      if (opts.dumpDom && Date.now() - lastDiagAt > 10000) {
        lastDiagAt = Date.now();
        await writeDiag(session);
      }

      if (s && s.ended && !endedReported) {
        endedReported = true;
        state.ended = true;
        state.connected = false;
        log('检测到直播结束/下播文案');
        printStatus({ reason: 'stream_ended' });
        if (!opts.keepAliveOnEnd) return { ended: true };
      }
      if (session.cdp && session.cdp.closed) throw new Error('CDP 连接断开');
      await sleep(opts.pollMs);
    }
    return {};
  } finally {
    await cleanupSession(session);
    if (state.current === session) state.current = null;
  }
}

// ---------------------------------------------------------------------------
// 清理
// ---------------------------------------------------------------------------
// 返回同一个 promise：finish() 与 runSession 的 finally 可能并发调用，
// 若第二次调用提前返回，process.exit 会在清理完成前发生，留下临时 profile。
function cleanupSession(session) {
  if (!session) return Promise.resolve();
  if (session._cleanupPromise) return session._cleanupPromise;
  session._cleanupPromise = (async () => {
    session.cleaned = true;
    session.closed = true;
    try {
      if (session.cdp) session.cdp.close();
    } catch (_) {
      /* ignore */
    }
    try {
      if (session.child && session.child.exitCode === null) {
        session.child.kill();
        if (process.platform === 'win32' && session.child.pid) {
          spawnSync('taskkill', ['/pid', String(session.child.pid), '/T', '/F'], { stdio: 'ignore' });
        }
        // 等浏览器进程真正退出，避免临时 profile 文件仍被占用
        await new Promise((resolve) => {
          if (!session.child || session.child.exitCode !== null) return resolve();
          const done = () => resolve();
          session.child.once('exit', done);
          setTimeout(done, 2500);
        });
      }
    } catch (_) {
      /* ignore */
    }
    await sleep(180);
    try {
      if (session.profile) await removeDirWithRetry(session.profile);
    } catch (_) {
      /* 临时目录清理失败无所谓 */
    }
    vlog('会话已清理');
  })();
  return session._cleanupPromise;
}

async function removeDirWithRetry(dir, attempts = 6) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
    } catch (_) {
      /* 继续重试 */
    }
    if (!fs.existsSync(dir)) return true;
    await sleep(400);
  }
  return !fs.existsSync(dir);
}

function cleanupCurrentSync() {
  const s = state.current;
  if (!s) return;
  try {
    if (s.cdp) s.cdp.close();
  } catch (_) {
    /* ignore */
  }
  try {
    if (s.child && s.child.exitCode === null && s.child.pid) {
      s.child.kill();
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(s.child.pid), '/T', '/F'], { stdio: 'ignore' });
      }
    }
  } catch (_) {
    /* ignore */
  }
  try {
    if (s.profile) fs.rmSync(s.profile, { recursive: true, force: true, maxRetries: 1 });
  } catch (_) {
    /* ignore */
  }
}

function finish(code, reason) {
  if (state.finishing) return;
  state.finishing = true;
  state.stopping = true;
  if (state.statusTimer) clearInterval(state.statusTimer);
  if (state.durationTimer) clearTimeout(state.durationTimer);
  printStatus({ stopped: reason });
  const cur = state.current;
  Promise.resolve(cur ? cleanupSession(cur) : undefined)
    .catch(() => {})
    .finally(() => process.exit(code));
  setTimeout(() => process.exit(code), 3000).unref();
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }
  verbose = toBool(opts.verbose, false);
  const roomArg = opts.room || opts.r || opts._[0];
  if (!roomArg) {
    printHelp();
    throw new Error('缺少 --room <房间号|URL>');
  }
  const room = normalizeRoom(roomArg);
  state.room = room.room;
  state.roomUrl = room.url;
  state.probe = toBool(opts.probe, false);

  const sel = loadSelectors(opts.selectors || DEFAULT_SELECTORS);
  state.selectors = sel.cfg;
  state.selectorsFile = sel.file;

  state.ingestBase = String(opts.ingest || DEFAULT_INGEST).replace(/\/+$/, '');
  try {
    const u = new URL(state.ingestBase);
    if (!/^https?:$/.test(u.protocol)) throw new Error('协议必须是 http/https');
  } catch (e) {
    throw new Error(`--ingest 不是合法 URL: ${opts.ingest} (${e.message})`);
  }
  state.token = String(opts.token || process.env.DOUYIN_INGEST_TOKEN || loadDefaultToken());
  state.opts = {
    room: room.room,
    headless: toBool(opts.headless, true),
    browser: opts.browser || process.env.DOUYIN_BROWSER || '',
    pollMs: Math.max(150, toInt(opts['poll-ms'], 600)),
    statusMs: Math.max(1000, toInt(opts['status-ms'], 60000)),
    dedupeMs: Math.max(0, toInt(opts['dedupe-ms'], 60000)),
    settleMs: Math.max(500, toInt(opts['settle-ms'], 3000)),
    duration: Math.max(0, toInt(opts.duration, 0)),
    maxReconnect: Math.max(0, toInt(opts['max-reconnect'], 5)),
    keepAliveOnEnd: toBool(opts['keep-alive-on-end'], false),
    dumpDom: opts['dump-dom'] || '',
    screenshot: opts.screenshot || '',
    ua: (() => {
      const v = opts.ua;
      if (!v || v === true) return '';
      const s = String(v);
      if (s.toLowerCase() === 'mobile') return MOBILE_UA;
      return s;
    })(),
    evalJs: (() => {
      if (opts['eval-file']) {
        try {
          return String(fs.readFileSync(path.resolve(String(opts['eval-file'])), 'utf8'));
        } catch (e) {
          log(`--eval-file 读取失败: ${e.message}`);
          return '';
        }
      }
      return typeof opts.eval === 'string' ? opts.eval : '';
    })(),
    evalDump: opts['eval-dump'] || '',
  };

  log(
    `配置: room=${state.room} url=${state.roomUrl} mode=${state.probe ? 'probe' : 'ingest'} ` +
      `ingest=${state.probe ? '(不POST)' : state.ingestBase} headless=${state.opts.headless} ` +
      `selectors=${path.basename(state.selectorsFile)}${sel.found ? '' : '(缺失,用内置默认)'}`
  );
  if (!state.probe) log(`ingest token: ${state.token ? state.token.slice(0, 3) + '***' : '(空)'}`);

  process.on('SIGINT', () => {
    log('收到 SIGINT，正在清理浏览器与临时 profile…');
    finish(130, 'sigint');
  });
  process.on('SIGTERM', () => {
    log('收到 SIGTERM，正在清理…');
    finish(143, 'sigterm');
  });
  process.on('exit', () => {
    cleanupCurrentSync();
  });

  printStatus({ started: true });
  state.statusTimer = setInterval(() => printStatus(), state.opts.statusMs);
  if (state.opts.duration > 0) {
    state.durationTimer = setTimeout(() => {
      log(`已达到 --duration ${state.opts.duration}s，退出`);
      finish(0, 'duration');
    }, state.opts.duration * 1000);
  }

  let attempt = 0;
  while (!state.stopping && !state.finishing) {
    try {
      const r = await runSession();
      if (state.stopping || state.finishing) break;
      if (r && r.ended) {
        finish(0, 'stream_ended');
        return;
      }
      throw new Error('采集会话意外结束');
    } catch (e) {
      if (state.stopping || state.finishing) break;
      state.connected = false;
      state.reconnects += 1;
      attempt += 1;
      log(`采集会话失败(${attempt}): ${e.message}`);
      printStatus({ error: e.message, attempt });
      if (state.opts.maxReconnect > 0 && attempt >= state.opts.maxReconnect) {
        log(`达到最大重连次数 ${state.opts.maxReconnect}，退出`);
        finish(3, 'max_reconnect');
        return;
      }
      const waitMs = Math.min(30000, 1000 * Math.pow(2, Math.min(attempt, 5)));
      log(`${Math.round(waitMs / 1000)}s 后重连…`);
      await sleep(waitMs);
    }
  }
  finish(0, 'exit');
}

main().catch((err) => {
  log('启动失败:', err.message);
  try {
    cleanupCurrentSync();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
