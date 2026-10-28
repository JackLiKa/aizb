'use strict';

// 用无头 Chrome 运行舞台页同源的 3D 模型，导出 GLB 并校验结构。
// 用法: node scripts/export-glb.js [stageBase=http://127.0.0.1:17890]

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT_DIR = path.join(__dirname, '..', 'stage', 'assets');
const OUT_FILE = path.join(OUT_DIR, 'whale-girl.glb');
const BASE = process.argv[2] || 'http://127.0.0.1:17890';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const port = 9735;
  const profile = fs.mkdtempSync('/tmp/dyzb-glb-');
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--hide-scrollbars',
    '--mute-audio',
    `--remote-debugging-port=${port}`,
    '--window-size=960,540',
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    let info = null;
    for (let i = 0; i < 100; i += 1) {
      await sleep(150);
      try {
        info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        if (info.webSocketDebuggerUrl) break;
      } catch (_) { /* 尚未就绪 */ }
    }
    if (!info?.webSocketDebuggerUrl) throw new Error('Chrome 调试端口未就绪');

    const ws = new WebSocket(info.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

    let id = 0;
    const pending = new Map();
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (!msg.id || !pending.has(msg.id)) return;
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
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
    await send('Page.navigate', { url: `${BASE}/stage/model-preview.html?export=1` }, sessionId);

    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result?.value;
    };

    let meta = null;
    for (let i = 0; i < 80; i += 1) {
      await sleep(300);
      const err = await evaluate('window.__glbError || ""').catch(() => '');
      if (err) throw new Error(`导出失败: ${err}`);
      const ready = await evaluate('window.__glbReady === true').catch(() => false);
      if (ready) {
        meta = JSON.parse(await evaluate('JSON.stringify(window.__glbMeta)'));
        break;
      }
    }
    if (!meta) throw new Error('等待 GLB 导出超时');

    const base64 = await evaluate('window.__glbBase64');
    if (!base64) throw new Error('未取到 GLB 数据');
    const buf = Buffer.from(base64, 'base64');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, buf);

    const magic = buf.readUInt32LE(0);
    const version = buf.readUInt32LE(4);
    const length = buf.readUInt32LE(8);
    const jsonLen = buf.readUInt32LE(12);
    const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
    const names = (gltf.nodes || []).map((n) => n.name).filter(Boolean);

    console.log('saved', OUT_FILE, buf.length, 'bytes');
    console.log('glb', { magic: magic.toString(16), version, length, declaredBytes: meta.bytes });
    console.log('structure', {
      nodes: (gltf.nodes || []).length,
      meshes: (gltf.meshes || []).length,
      materials: (gltf.materials || []).length,
      animations: (gltf.animations || []).length,
      named: names.length,
    });
    console.log('key nodes', names.filter((n) => /^(WhaleGirl|Head|Body|Tail|Mouth|Eye|Iris|Arm|Ear|Fin|Ahoge|SideLock|Hair|Skirt|Apron|Blouse|Corset|Shoe|Sock|Headdress|Bow|Face)/.test(n)).slice(0, 20));
    ws.close();
  } finally {
    chrome.kill('SIGKILL');
    await sleep(200);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('导出 GLB 失败:', err.message);
  process.exit(1);
});
