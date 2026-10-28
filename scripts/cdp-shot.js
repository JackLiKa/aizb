const fs = require('fs');

const [wsUrl, out, waitMs = '1800'] = process.argv.slice(2);
const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(JSON.stringify(m.error)));
    else p.resolve(m.result);
  }
};

ws.onopen = async () => {
  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send('Runtime.evaluate', { expression: 'window.dispatchEvent(new Event("resize"))' });
    await new Promise((r) => setTimeout(r, Number(waitMs)));
    const ev = await send('Runtime.evaluate', {
      expression: `JSON.stringify({ keys: Object.keys(window.__stageDebug || {}), canvas: (() => { const c = document.getElementById('stage-canvas'); return c ? [c.width, c.height] : null; })() })`,
      returnByValue: true,
    });
    console.log(ev.result.value);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('saved', out);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
  ws.close();
};
