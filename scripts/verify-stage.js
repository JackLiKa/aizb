const fs = require('fs');

const [wsUrl, url, out] = process.argv.slice(2);
const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
const errors = [];

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

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text + ' ' + (res.exceptionDetails.exception?.description || ''));
  return res.result.value;
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
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    errors.push(d.exception?.description || d.text);
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    errors.push(m.params.entry.text);
  }
};

ws.onopen = async () => {
  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url });
    await sleep(3200);

    const setup = await evaluate(`(() => {
      const c = document.getElementById('stage-canvas');
      if (!c) return { error: 'no canvas' };
      const ctx = c.getContext('2d');
      const grab = (x, y, w, h) => Array.from(ctx.getImageData(x, y, w, h).data);
      const stats = (data) => {
        let sum = 0, uniq = new Set(), dark = 0;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i+1], b = data[i+2];
          sum += (r + g + b) / 3;
          uniq.add((r >> 3) + ',' + (g >> 3) + ',' + (b >> 3));
          if (r + g + b < 40) dark++;
        }
        return { mean: Math.round(sum / (data.length / 4)), colors: uniq.size, darkPct: Math.round(dark / (data.length / 4) * 100) };
      };
      const diff = (a, b) => {
        let n = 0;
        for (let i = 0; i < a.length; i += 4) {
          if (Math.abs(a[i]-b[i]) + Math.abs(a[i+1]-b[i+1]) + Math.abs(a[i+2]-b[i+2]) > 24) n++;
        }
        return n;
      };
      window.__probe = { grab, stats, diff };
      const cw = c.clientWidth, ch = c.clientHeight;
      const full = grab(0, 0, cw, ch);
      const mouth = grab(Math.round(cw/2 - 44), Math.round(ch/2 - 40), 88, 70);
      window.__fullA = full;
      window.__mouthA = mouth;
      return {
        canvas: [c.width, c.height, cw, ch],
        debugKeys: Object.keys(window.__stageDebug || {}),
        full: stats(full),
        mouth: stats(mouth),
        mode: window.__stageDebug?.avatar?.mode,
        palette: window.__stageDebug?.avatar?.palette,
      };
    })()`);

    await sleep(700);
    const idleDiff = await evaluate(`(() => {
      const c = document.getElementById('stage-canvas');
      const ctx = c.getContext('2d');
      const full = window.__probe.grab(0, 0, c.clientWidth, c.clientHeight);
      return { animPixels: window.__probe.diff(window.__fullA, full) };
    })()`);

    await evaluate(`(() => {
      const a = window.__stageDebug.avatar;
      a.setMode('speaking');
      a.setMouth(0);
    })()`);
    await sleep(500);
    const mouthClosed = await evaluate(`(() => {
      const c = document.getElementById('stage-canvas');
      const ctx = c.getContext('2d');
      window.__mouthClosed = window.__probe.grab(Math.round(c.clientWidth/2 - 44), Math.round(c.clientHeight/2 - 40), 88, 70);
      return window.__probe.stats(window.__mouthClosed);
    })()`);

    await evaluate(`window.__stageDebug.avatar.setMouth(0.95)`);
    await sleep(450);
    const mouthOpen = await evaluate(`(() => {
      const c = document.getElementById('stage-canvas');
      const ctx = c.getContext('2d');
      const open = window.__probe.grab(Math.round(c.clientWidth/2 - 44), Math.round(c.clientHeight/2 - 40), 88, 70);
      return {
        stats: window.__probe.stats(open),
        changedPixels: window.__probe.diff(window.__mouthClosed, open),
        mouthValue: window.__stageDebug.avatar.mouth,
        mode: window.__stageDebug.avatar.mode,
      };
    })()`);

    await evaluate(`(() => {
      const a = window.__stageDebug.avatar;
      a.setMode('idle');
      a.setMouth(0);
      a.celebrate();
    })()`);
    await sleep(600);
    const celebrate = await evaluate(`(() => {
      const c = document.getElementById('stage-canvas');
      const ctx = c.getContext('2d');
      const now = window.__probe.grab(0, 0, c.clientWidth, c.clientHeight);
      return { particles: window.__stageDebug.avatar.particles.length, changedPixels: window.__probe.diff(window.__fullA, now) };
    })()`);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (out) fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));

    console.log(JSON.stringify({ setup, idleDiff, mouthClosed, mouthOpen, celebrate, errors: errors.slice(0, 12), saved: out || null }, null, 2));
  } catch (err) {
    console.error('VERIFY FAILED:', err.message);
    console.log(JSON.stringify({ errors: errors.slice(0, 12) }, null, 2));
    process.exitCode = 1;
  }
  ws.close();
};
