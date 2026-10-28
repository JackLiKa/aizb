'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.aac': 'audio/aac',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text) return {};
  try { return JSON.parse(text); } catch (_) { throw new Error('JSON 格式错误'); }
}

function sanitizeConfig(cfg) {
  const copy = JSON.parse(JSON.stringify(cfg));
  if (copy.llm?.apiKey) copy.llm.apiKey = '***';
  if (copy.tts?.openai?.apiKey) copy.tts.openai.apiKey = '***';
  return copy;
}

function stripMasked(patch) {
  const p = JSON.parse(JSON.stringify(patch || {}));
  if (p.llm?.apiKey === '***') delete p.llm.apiKey;
  if (p.tts?.openai?.apiKey === '***') delete p.tts.openai.apiKey;
  return p;
}

function serveFile(req, res, root, relPath) {
  let decoded;
  try { decoded = decodeURIComponent(relPath); } catch (_) { sendJson(res, 400, { error: 'bad path' }); return; }
  const rootAbs = path.resolve(root);
  let full = path.resolve(rootAbs, `.${path.posix.sep}${decoded.replace(/^\/+/, '')}`);
  if (full !== rootAbs && !full.startsWith(rootAbs + path.sep)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  try {
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) full = path.join(full, 'index.html');
    if (!fs.existsSync(full)) { sendJson(res, 404, { error: 'not found' }); return; }
    const stat = fs.statSync(full);
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
    };
    const range = req.headers.range;
    if (range && /^bytes=\d*-\d*$/.test(range)) {
      const [s, e] = range.replace('bytes=', '').split('-');
      const start = s ? Number(s) : 0;
      const end = e ? Math.min(Number(e), stat.size - 1) : stat.size - 1;
      if (start >= stat.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        res.end();
        return;
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      fs.createReadStream(full, { start, end }).pipe(res);
      return;
    }
    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    fs.createReadStream(full).pipe(res);
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

function createServer({
  config,
  configHandle,
  logger,
  metering,
  jukebox,
  voice,
  sources,
  watchdog,
  stageDir,
  adminDir,
  dataDir,
  getDirector,
  onRestartStage,
  onFocusStage,
}) {
  const stageClients = new Set();
  const api = () => getDirector();

  function broadcast(msg) {
    if (!stageClients.size) return;
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of stageClients) {
      try { res.write(data); } catch (_) { stageClients.delete(res); }
    }
  }

  function hasStage() {
    return stageClients.size > 0;
  }

  function stageReport(body) {
    if (!body || typeof body !== 'object') return;
    if (body.type === 'heartbeat') { watchdog.kick(); return; }
    if (body.type === 'renderer:error') {
      logger.error('舞台报错', { message: String(body.message || '').slice(0, 200) });
      watchdog.kick();
      return;
    }
    api()?.onStageMessage(body);
  }

  function checkIngestToken(req, body, url) {
    if (!config.ingest.enabled) return false;
    const token = req.headers['x-ingest-token'] || url.searchParams.get('token') || body?.__token;
    return Boolean(token) && token === config.ingest.token;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'content-type, x-ingest-token',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      });
      res.end();
      return;
    }

    try {
      if (pathname === '/health') {
        const d = api();
        sendJson(res, 200, {
          ok: true,
          uptimeSec: Math.floor(process.uptime()),
          stageClients: stageClients.size,
          queue: d?.queue.length ?? 0,
          state: d?.currentState || 'idle',
          watchdog: watchdog.status(),
        });
        return;
      }

      if (pathname === '/events') {
        const role = url.searchParams.get('role') || 'stage';
        if (role !== 'stage') { sendJson(res, 404, { error: 'unknown role' }); return; }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(': connected\n\n');
        stageClients.add(res);
        watchdog.kick();
        api()?.onStageMessage({ type: 'ready' });
        const ka = setInterval(() => {
          try { res.write(': ping\n\n'); } catch (_) { /* ignore */ }
        }, 15000);
        req.on('close', () => { clearInterval(ka); stageClients.delete(res); });
        return;
      }

      if (pathname === '/stage/report' && req.method === 'POST') {
        const body = await readJson(req);
        stageReport(body);
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
        res.end();
        return;
      }

      if (pathname === '/ingest' && req.method === 'POST') {
        const body = await readJson(req);
        if (!checkIngestToken(req, body, url)) {
          sendJson(res, 403, { ok: false, error: 'bad token' });
          return;
        }
        api()?.push(body);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === '/api/state' && req.method === 'GET') {
        const d = api();
        sendJson(res, 200, {
          ok: true,
          status: d?.getStatus() || null,
          metering: metering.snapshot(),
          jukebox: jukebox.snapshot(),
          songs: jukebox.list(300),
          logs: logger.recent(80),
          watchdog: watchdog.status(),
          stageClients: stageClients.size,
          source: sources.current,
          config: sanitizeConfig(config),
          now: Date.now(),
        });
        return;
      }

      if (pathname === '/api/logs' && req.method === 'GET') {
        const n = Math.min(500, Number(url.searchParams.get('n') || 120) || 120);
        sendJson(res, 200, { ok: true, logs: logger.recent(n) });
        return;
      }

      if (pathname === '/api/speak' && req.method === 'POST') {
        const body = await readJson(req);
        const text = String(body.text || '').trim();
        if (!text) { sendJson(res, 400, { ok: false, error: 'text 不能为空' }); return; }
        api()?.say(text, body.user || '房主');
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === '/api/event' && req.method === 'POST') {
        const body = await readJson(req);
        api()?.push(body);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === '/api/pause' && req.method === 'POST') {
        const body = await readJson(req);
        api()?.setPaused(Boolean(body.paused));
        sendJson(res, 200, { ok: true, paused: Boolean(body.paused) });
        return;
      }

      if (pathname === '/api/source' && req.method === 'POST') {
        const body = await readJson(req);
        const type = String(body.type || 'off');
        sources.setType(type);
        sendJson(res, 200, { ok: true, type });
        return;
      }

      if (pathname === '/api/config' && req.method === 'POST') {
        const patch = stripMasked(await readJson(req));
        const merged = configHandle.save(patch);
        Object.assign(config, merged);
        sendJson(res, 200, { ok: true, config: sanitizeConfig(config), note: '端口、窗口尺寸等设置需要重启应用生效' });
        return;
      }

      if (pathname === '/api/songs' && req.method === 'GET') {
        const q = url.searchParams.get('q');
        sendJson(res, 200, { ok: true, songs: q ? jukebox.search(q, 20) : jukebox.list(300) });
        return;
      }

      if (pathname === '/api/songs/queue' && req.method === 'POST') {
        const body = await readJson(req);
        const song = jukebox.index.find((s) => s.id === body.id);
        if (!song) { sendJson(res, 404, { ok: false, error: 'song not found' }); return; }
        const out = api()?.playSongNow(song, body.by || '房主');
        sendJson(res, out?.ok ? 200 : 409, out || { ok: false });
        return;
      }

      if (pathname === '/api/songs/skip' && req.method === 'POST') {
        api()?.skipMusic();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === '/api/restart-stage' && req.method === 'POST') {
        onRestartStage?.();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === '/api/focus-stage' && req.method === 'POST') {
        let focused = false;
        try { focused = Boolean(await onFocusStage?.()); } catch (_) { /* ignore */ }
        sendJson(res, 200, { ok: true, focused });
        return;
      }

      if (pathname.startsWith('/media/music/')) {
        serveFile(req, res, jukebox.dir, pathname.slice('/media/music/'.length));
        return;
      }
      if (pathname.startsWith('/media/tts/')) {
        serveFile(req, res, path.join(dataDir, 'tts-cache'), pathname.slice('/media/tts/'.length));
        return;
      }
      if (pathname.startsWith('/stage')) {
        serveFile(req, res, stageDir, pathname.replace(/^\/stage\/?/, '') || 'index.html');
        return;
      }
      if (pathname.startsWith('/admin')) {
        serveFile(req, res, adminDir, pathname.replace(/^\/admin\/?/, '') || 'index.html');
        return;
      }
      if (pathname === '/' || pathname === '') {
        res.writeHead(302, { Location: '/admin/' });
        res.end();
        return;
      }

      sendJson(res, 404, { error: 'not found', path: pathname });
    } catch (err) {
      logger.error(`HTTP 请求失败 ${pathname}`, { error: err.message });
      if (!res.headersSent) sendJson(res, 400, { ok: false, error: err.message });
      else res.end();
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/ingest') { socket.destroy(); return; }
    if (!checkIngestToken(req, null, url)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: 'hello', ok: true }));
      ws.on('message', (raw) => {
        try {
          const body = JSON.parse(String(raw));
          api()?.push(body);
        } catch (_) { /* ignore */ }
      });
    });
  });

  function close() {
    for (const res of stageClients) {
      try { res.end(); } catch (_) { /* ignore */ }
    }
    stageClients.clear();
    try { wss.close(); } catch (_) { /* ignore */ }
    return new Promise((resolve) => server.close(resolve));
  }

  return { server, broadcast, hasStage, close, stageClients };
}

module.exports = { createServer, serveFile, sendJson };
