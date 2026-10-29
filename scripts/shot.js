'use strict';

// 用 CDP 给页面截图（舞台页有 SSE 长连接，chrome --screenshot 会一直不退出）。
// 用法: node scripts/shot.js <url> <out.png> [--wait 6000] [--inject http://127.0.0.1:17895] [--size 1280x720]

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const url = process.argv[2];
  const out = path.resolve(process.argv[3] || 'shot.png');
  const wait = Number(arg('wait', 6000));
  const injectBase = arg('inject', null);
  const [w, h] = String(arg('size', '1280x720')).split('x').map(Number);
  const port = 9333 + Math.floor(Math.random() * 300);
  const profile = fs.mkdtempSync('/tmp/dyzb-cdp-');
  const useGL = process.env.DYZB_SHOT_GL === '1';

  const chrome = spawn(CHROME, [
    '--headless=new',
    ...(useGL
      ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
      : ['--disable-gpu']),
    '--no-sandbox',
    '--hide-scrollbars',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${port}`,
    `--window-size=${w},${h}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    let info = null;
    for (let i = 0; i < 80; i += 1) {
      await sleep(150);
      try {
        info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        if (info.webSocketDebuggerUrl) break;
      } catch (_) { /* 还没起来 */ }
    }
    if (!info?.webSocketDebuggerUrl) throw new Error('Chrome 调试端口未就绪');

    const ws = new WebSocket(info.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

    let id = 0;
    const pending = new Map();
    const listeners = new Set();
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of listeners) fn(msg);
      }
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const msg = { id: ++id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      pending.set(msg.id, { resolve, reject });
      ws.send(JSON.stringify(msg));
    });

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 1, mobile: false,
    }, sessionId);

    const errors = [];
    listeners.add((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.exceptionThrown') {
        errors.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description || ''));
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        errors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
      }
    });
    await send('Page.navigate', { url }, sessionId);
    await sleep(Math.max(1500, wait - 3000));

    if (injectBase) {
      for (const ev of [
        { type: 'comment', user: '小鱼干', text: '肥鱼今晚也在呀' },
        { type: 'gift', user: '夜猫子', giftName: '火箭', count: 1, value: 100 },
        { type: 'comment', user: '阿呆', text: '点歌 晴天' },
      ]) {
        await fetch(`${injectBase}/api/event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ev),
        }).catch(() => {});
        await sleep(700);
      }
    }

    const speakText = arg('speak', null);
    if (speakText) {
      const apiBase = new URL('/', url).href;
      await fetch(`${apiBase}api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: String(speakText) }),
      }).catch(() => {});
      await sleep(3200);
    } else {
      await sleep(1000);
    }

    const evalJs = arg('eval', null);
    if (evalJs) {
      const r = await send('Runtime.evaluate', { expression: String(evalJs), returnByValue: true }, sessionId);
      if (r.exceptionDetails) console.log('eval error:', r.exceptionDetails.text);
      else if (r.result?.value !== undefined) console.log('eval ->', JSON.stringify(r.result.value));
      await sleep(Number(arg('evalWait', 900)));
    }
    await sleep(Number(arg('settle', 1200)));

    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));

    const metrics = await send('Runtime.evaluate', {
      expression: 'JSON.stringify({w:innerWidth,h:innerHeight,canvas:[document.querySelector("canvas")?.width,document.querySelector("canvas")?.height],title:document.title})',
      returnByValue: true,
    }, sessionId);

    console.log('saved', out, fs.statSync(out).size, 'bytes');
    console.log('page', metrics.result.value);
    if (errors.length) console.log('page errors:', errors.slice(0, 5));
    ws.close();
  } finally {
    chrome.kill('SIGKILL');
    await sleep(200);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('截图失败:', err.message);
  process.exit(1);
});
