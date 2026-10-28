const fs = require('fs');

const [wsUrl, url, out] = process.argv.slice(2);
const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
const failed = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(JSON.stringify(m.error)));
    else p.resolve(m.result);
    return;
  }
  if (m.method === 'Network.loadingFailed') failed.push(m.params.errorText);
  if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
    failed.push(`${m.params.response.status} ${m.params.response.url}`);
  }
};

ws.onopen = async () => {
  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url });
    await sleep(3400);
    await send('Runtime.evaluate', {
      expression: `(() => {
        const a = window.__stageDebug.avatar;
        a.setMode('idle'); a.mouth = 0; a.mouthTarget = 0;
        a.particles = []; a.notes = []; a.happyUntil = 0; a.bounceUntil = 0;
        a.blinkStart = -1; a.nextBlink = 999;
        window.dispatchEvent(new Event('resize'));
      })()`,
    });
    await sleep(900);
    const stats = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const a = window.__stageDebug.avatar, c = a.canvas, ctx = a.ctx;
        const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3);
        const eyeBox = (cx) => {
          const d = ctx.getImageData(cx - 40, 245, 80, 80).data;
          let dark = 0;
          for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 330) dark++;
          return dark;
        };
        return {
          canvas: [c.width, c.height],
          mode: a.mode,
          mouth: a.mouth,
          eyeLeftDark: eyeBox(563),
          eyeRightDark: eyeBox(717),
          hairTop: px(640, 110),
          forehead: px(640, 235),
          cheek: px(700, 300),
          blush: px(550, 330),
          blushRight: px(730, 330),
          nose: px(640, 314),
          mouth: px(640, 347),
          finTail: px(900, 555),
          bgTop: px(40, 40),
          bgBottom: px(40, 690),
        };
      })()`,
    });
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log(JSON.stringify({ stats: stats.result.value, failed: [...new Set(failed)].slice(0, 10), saved: out }, null, 2));
  } catch (err) {
    console.error('SHOT FAILED:', err.message);
    process.exitCode = 1;
  }
  ws.close();
};
