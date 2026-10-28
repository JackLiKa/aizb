'use strict';
const fs = require('fs');
const http = require('http');

const W = Number(process.env.W || 792);
const H = Number(process.env.H || 446);
const OUT = process.env.OUT || '.tmp/guest-layout.png';

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve(JSON.parse(buf)));
    }).on('error', reject);
  });
}

(async () => {
  const targets = await getJson('http://127.0.0.1:9333/json');
  const page = targets.find((t) => t.type === 'page' && t.url.includes('/stage/'));
  if (!page) throw new Error('stage page not found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (!m.id) return;
    const q = pending.get(m.id);
    if (!q) return;
    pending.delete(m.id);
    m.error ? q.reject(new Error(JSON.stringify(m.error))) : q.resolve(m.result);
  };
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.reload', { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 2500));
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };
  const rects = await evalJs(`(() => {
    const out = { viewport: [innerWidth, innerHeight], hud: null, items: [] };
    const hud = document.getElementById('hud');
    const cs = getComputedStyle(hud);
    out.hud = { transform: cs.transform, left: cs.left, top: cs.top, w: hud.offsetWidth, h: hud.offsetHeight };
    const sel = ['.top-left', '.token-panel', '.gift-panel', '.song-panel', '#danmakuLayer', '.subtitle', '.bottom-bar', '.live-pill', '.room-title'];
    for (const s of sel) {
      for (const el of document.querySelectorAll(s)) {
        const r = el.getBoundingClientRect();
        out.items.push({ sel: s, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], shown: getComputedStyle(el).display !== 'none' });
      }
    }
    return out;
  })()`);
  console.log(JSON.stringify(rects, null, 1));
  await new Promise((r) => setTimeout(r, 400));
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('screenshot', OUT);
  ws.close();
})().catch((e) => { console.error(e); process.exit(1); });
