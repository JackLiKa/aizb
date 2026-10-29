'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const { llmStatus: buildLlmStatus } = require('./config');
const { listManagedHits } = require('./env');

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
  dashboardDir,
  dataDir,
  getDirector,
  analytics,
  onRestartStage,
  onFocusStage,
  getDouyinStatus,
  getLlmMode,
}) {
  const stageClients = new Set();
  const api = () => getDirector();

  // 每 30s 把计量快照落盘（不占用 HTTP 线程、不阻止进程退出）。
  let meteringTimer = null;
  if (analytics && typeof analytics.recordMetering === 'function'
    && metering && typeof metering.snapshot === 'function') {
    meteringTimer = setInterval(() => {
      try {
        analytics.recordMetering(metering.snapshot());
      } catch (err) {
        try { logger.warn('analytics 计量快照写入失败', { error: err.message }); } catch (_) { /* ignore */ }
      }
    }, 30000);
    if (meteringTimer.unref) meteringTimer.unref();
  }

  // /api/state 的 LLM 状态：keySource 区分 env / config / none，apiKey 永不回传明文。
  function readLlmStatus() {
    let status;
    try { status = buildLlmStatus(config, configHandle && configHandle.env); }
    catch (_) { status = buildLlmStatus(config, null); }
    if (typeof getLlmMode === 'function') {
      try { status.mode = getLlmMode(); } catch (_) { /* 回退到按 config 推断的 mode */ }
    }
    return status;
  }

  // 抖音采集状态由调用方（main.js / dev-server.js）注入；未接线时不输出该键。
  function readDouyinStatus() {
    if (typeof getDouyinStatus !== 'function') return null;
    try {
      const snapshot = getDouyinStatus();
      return snapshot && typeof snapshot === 'object' ? snapshot : null;
    } catch (_) {
      return null;
    }
  }

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
        analytics?.recordEvent?.(body, { source: 'ingest', room: config.douyin?.roomId || '' });
        api()?.push(body);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === '/api/state' && req.method === 'GET') {
        const d = api();
        const douyin = readDouyinStatus();
        sendJson(res, 200, {
          ok: true,
          status: d?.getStatus() || null,
          metering: metering.snapshot(),
          jukebox: jukebox.snapshot(),
          songs: jukebox.list(300),
          music: jukebox.providers.status(),
          logs: logger.recent(80),
          watchdog: watchdog.status(),
          stageClients: stageClients.size,
          source: sources.current,
          llm: { status: readLlmStatus() },
          ...(douyin ? { douyin } : {}),
          config: sanitizeConfig(config),
          now: Date.now(),
        });
        return;
      }

      if (pathname === '/api/stats' && req.method === 'GET') {
        if (!analytics || typeof analytics.summary !== 'function') {
          sendJson(res, 200, { ok: false, error: 'analytics disabled' });
          return;
        }
        const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 7));
        let summary;
        try {
          summary = analytics.summary(days);
        } catch (err) {
          logger.warn('读取数据看板统计失败', { error: err.message });
          sendJson(res, 500, { ok: false, error: err.message });
          return;
        }
        let mode = null;
        if (typeof getLlmMode === 'function') {
          try { mode = getLlmMode(); } catch (_) { mode = null; }
        }
        if (!mode) mode = config.llm?.apiKey ? 'llm' : 'echo';
        sendJson(res, 200, {
          ok: true,
          ...summary,
          live: {
            source: sources.current,
            room: config.douyin?.roomId || '',
            stageClients: stageClients.size,
            mode,
          },
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
        // 人工确认模式：exact=true 时直接播 director 已生成好的草稿，不再走 say/LLM 重新生成。
        if (body.exact === true && typeof api()?.speakExact === 'function') {
          api().speakExact(text);
        } else {
          api()?.say(text, body.user || '房主');
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      // 丢弃人工确认模式下的 AI 草稿；director 不存在时也返回 ok:true，不报 500。
      if (pathname === '/api/draft/discard' && req.method === 'POST') {
        const body = await readJson(req);
        let discarded = false;
        if (typeof api()?.discardDraft === 'function') {
          try { discarded = Boolean(api().discardDraft(body.id)); } catch (_) { discarded = false; }
        }
        sendJson(res, 200, { ok: true, discarded });
        return;
      }

      if (pathname === '/api/event' && req.method === 'POST') {
        const body = await readJson(req);
        analytics?.recordEvent?.(body, { source: 'test', room: config.douyin?.roomId || '' });
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
        // 由 .env / 进程环境变量托管的字段：内存以 env 为准，也绝不写进 config.json
        const envHits = listManagedHits(patch, configHandle && configHandle.envOverrides);
        const merged = configHandle.save(patch);
        Object.assign(config, merged);
        const envNote = envHits.length
          ? `；${envHits.map((o) => o.key).join('、')} 由 .env 提供，本次修改未写入 config.json`
          : '';
        sendJson(res, 200, {
          ok: true,
          config: sanitizeConfig(config),
          llm: { status: readLlmStatus() },
          note: `端口、窗口尺寸等设置需要重启应用生效${envNote}`,
        });
        return;
      }

      if (pathname === '/api/songs' && req.method === 'GET') {
        const q = url.searchParams.get('q');
        const songs = q ? await jukebox.searchAll(q, 20) : await jukebox.browse(300);
        sendJson(res, 200, { ok: true, songs, music: jukebox.providers.status() });
        return;
      }

      if (pathname === '/api/songs/queue' && req.method === 'POST') {
        const body = await readJson(req);
        const song = jukebox.find(body.id);
        if (!song) { sendJson(res, 404, { ok: false, error: 'song not found' }); return; }
        const out = api()?.playSongNow(song, body.by || '房主');
        sendJson(res, out?.ok ? 200 : 409, out || { ok: false });
        return;
      }

      if (pathname === '/api/songs/move' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body?.id) { sendJson(res, 400, { ok: false, error: 'id required' }); return; }
        const out = jukebox.move(body.id, { index: body.index, to: body.to });
        if (!out.ok) { sendJson(res, 404, { ok: false, error: out.reason }); return; }
        api()?.refreshOverlay?.();
        sendJson(res, 200, { ok: true, index: out.index });
        return;
      }

      if (pathname === '/api/songs/remove' && req.method === 'POST') {
        const body = await readJson(req);
        const ok = body?.id ? jukebox.remove(body.id) : false;
        if (!ok) { sendJson(res, 404, { ok: false, error: 'not found' }); return; }
        api()?.refreshOverlay?.();
        sendJson(res, 200, { ok: true });
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
      if (pathname.startsWith('/media/music-cache/')) {
        serveFile(req, res, jukebox.cacheDir, pathname.slice('/media/music-cache/'.length));
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
      if (dashboardDir && (pathname === '/dashboard' || pathname.startsWith('/dashboard/'))) {
        serveFile(req, res, dashboardDir, pathname.replace(/^\/dashboard\/?/, '') || 'index.html');
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
          analytics?.recordEvent?.(body, { source: 'ingest', room: config.douyin?.roomId || '' });
          api()?.push(body);
        } catch (_) { /* ignore */ }
      });
    });
  });

  function close() {
    if (meteringTimer) {
      clearInterval(meteringTimer);
      meteringTimer = null;
    }
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
