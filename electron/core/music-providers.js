'use strict';

/**
 * 在线背景音乐源：Jamendo（需 client_id）+ Internet Archive（免 key）。
 * 只返回允许商业使用的曲目（CC BY / BY-SA / CC0 / 公版），用于直播 BGM。
 * 播放前由 Jukebox.ensureLocal 缓存到本机，舞台端仍走 /media/music-cache/ 静态服务。
 */

const DEFAULT_TIMEOUT_MS = 12000;
const SEARCH_CACHE_MS = 10 * 60 * 1000;
const UA = 'dyzb/0.1 (+https://github.com/JackLiKa/aizb)';

const SAFE_LICENSE_RE = [
  /creativecommons\.org\/publicdomain/i,
  /creativecommons\.org\/zero/i,
  /creativecommons\.org\/licenses\/(by|by-sa)\//i,
  /\/licenses\/(by|by-sa)\//i,
  /publicdomain\/mark/i,
];
const UNSAFE_LICENSE_RE = /(\/nc\/|\/nc-|\/nd\/|\/nd-|noncommercial|noderiv)/i;

function isCommercialLicense(url) {
  if (!url) return false;
  if (UNSAFE_LICENSE_RE.test(url)) return false;
  return SAFE_LICENSE_RE.some((re) => re.test(url));
}

function licenseLabel(url) {
  if (!url) return '未标注许可';
  if (/publicdomain|zero/i.test(url)) return '公版/CC0';
  if (/\/by-sa\//i.test(url)) return 'CC BY-SA';
  if (/\/by\//i.test(url)) return 'CC BY';
  return 'CC';
}

async function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

class JamendoProvider {
  constructor({ clientId, logger }) {
    this.clientId = String(clientId || '').trim();
    this.logger = logger;
  }

  get configured() {
    return Boolean(this.clientId);
  }

  async search(query, { limit = 12, commercialOnly = true } = {}) {
    if (!this.configured) return [];
    const params = new URLSearchParams({
      client_id: this.clientId,
      format: 'json',
      limit: String(Math.min(50, Math.max(limit * 2, 12))),
      include: 'licenses',
      audioformat: 'mp32',
      order: query ? 'relevance' : 'popularity_month',
    });
    if (query) params.set('search', query);
    const data = await fetchJson(`https://api.jamendo.com/v3.0/tracks/?${params}`);
    const tracks = Array.isArray(data.results) ? data.results : [];
    return tracks
      .filter((t) => t && t.audio && (!commercialOnly || isCommercialLicense(t.license_ccurl)))
      .slice(0, limit)
      .map((t) => ({
        id: `jamendo:${t.id}`,
        title: String(t.name || '').trim() || '未命名',
        artist: String(t.artist_name || '').trim(),
        remote: true,
        source: 'jamendo',
        durationSec: Number(t.duration) || 0,
        streamUrl: t.audio,
        pageUrl: t.shareurl || '',
        license: licenseLabel(t.license_ccurl),
        licenseUrl: t.license_ccurl || '',
      }));
  }
}

class ArchiveProvider {
  constructor({ logger }) {
    this.logger = logger;
  }

  get configured() {
    return true;
  }

  async search(query, { limit = 8, commercialOnly = true } = {}) {
    const rows = Math.min(100, Math.max(limit * 8, 40));
    const q = query
      ? `(${query}) AND mediatype:(audio) AND collection:(audio_music)`
      : 'collection:(audio_music) AND mediatype:(audio)';
    const params = new URLSearchParams({
      q,
      rows: String(rows),
      page: '1',
      output: 'json',
    });
    if (!query) params.set('sort[]', 'downloads desc');
    for (const field of ['identifier', 'title', 'creator', 'licenseurl', 'downloads']) {
      params.append('fl[]', field);
    }
    const data = await fetchJson(`https://archive.org/advancedsearch.php?${params}`);
    const docs = (data.response && data.response.docs) || [];
    const candidates = docs
      .filter((d) => d && d.identifier && !/deleted/i.test(String(d.title || '')))
      .filter((d) => !commercialOnly || isCommercialLicense(d.licenseurl))
      .slice(0, Math.min(limit * 2, 12));

    const out = [];
    await Promise.all(candidates.map(async (doc) => {
      try {
        const meta = await fetchJson(`https://archive.org/metadata/${encodeURIComponent(doc.identifier)}`);
        const licenseUrl = (meta.metadata && meta.metadata.licenseurl) || doc.licenseurl || '';
        if (commercialOnly && !isCommercialLicense(licenseUrl)) return;
        const files = (meta.files || [])
          .filter((f) => /\.mp3$/i.test(f.name || '') && Number(f.size || 0) > 0 && Number(f.size) < 40 * 1024 * 1024)
          .sort((a, b) => String(a.name).localeCompare(String(b.name)));
        if (!files.length) return;
        const file = files[0];
        const artist = Array.isArray(doc.creator) ? doc.creator.join(' / ') : String(doc.creator || '');
        out.push({
          id: `archive:${doc.identifier}:${file.name}`,
          title: String(file.title || (Array.isArray(doc.title) ? doc.title[0] : doc.title) || file.name).replace(/\.mp3$/i, ''),
          artist,
          remote: true,
          source: 'archive',
          durationSec: parseLength(file.length),
          streamUrl: `https://archive.org/download/${encodeURIComponent(doc.identifier)}/${encodeURIComponent(file.name)}`,
          pageUrl: `https://archive.org/details/${encodeURIComponent(doc.identifier)}`,
          license: licenseLabel(licenseUrl),
          licenseUrl,
        });
      } catch (err) {
        this.logger?.warn?.(`Archive 曲目解析失败：${doc.identifier}`, { error: err.message });
      }
    }));
    return out.slice(0, limit);
  }
}

function parseLength(value) {
  if (!value) return 0;
  const parts = String(value).split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

class MusicProviders {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.jamendo = new JamendoProvider({ clientId: config.jukebox.jamendoClientId, logger });
    this.archive = new ArchiveProvider({ logger });
    this.cache = new Map();
  }

  get mode() {
    const configured = String(this.config.jukebox.provider || 'auto').toLowerCase();
    if (configured === 'local') return 'local';
    if (configured === 'jamendo') return this.jamendo.configured ? 'jamendo' : 'local';
    if (configured === 'archive') return 'archive';
    return this.jamendo.configured ? 'jamendo+archive' : 'archive';
  }

  status() {
    return {
      mode: this.mode,
      jamendo: this.jamendo.configured,
      archive: true,
      commercialOnly: this.config.jukebox.commercialOnly !== false,
    };
  }

  async search(query, { limit = 10 } = {}) {
    const mode = this.mode;
    if (mode === 'local') return [];
    const commercialOnly = this.config.jukebox.commercialOnly !== false;
    const key = `${mode}|${commercialOnly ? 1 : 0}|${String(query || '').trim().toLowerCase()}|${limit}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < SEARCH_CACHE_MS) return hit.songs;

    let songs = [];
    if (mode === 'archive') {
      songs = await this.archive.search(query, { limit, commercialOnly });
    } else {
      const half = mode === 'jamendo' ? limit : Math.ceil(limit / 2);
      const [jam, arc] = await Promise.allSettled([
        this.jamendo.search(query, { limit: half, commercialOnly }),
        mode === 'jamendo' ? Promise.resolve([]) : this.archive.search(query, { limit: limit - half, commercialOnly }),
      ]);
      if (jam.status === 'rejected') this.logger?.warn?.('Jamendo 搜索失败', { error: jam.reason?.message });
      if (arc.status === 'rejected') this.logger?.warn?.('Archive 搜索失败', { error: arc.reason?.message });
      songs = [...(jam.status === 'fulfilled' ? jam.value : []), ...(arc.status === 'fulfilled' ? arc.value : [])];
    }
    this.cache.set(key, { at: Date.now(), songs });
    if (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value);
    return songs;
  }
}

module.exports = { MusicProviders, isCommercialLicense, licenseLabel };
