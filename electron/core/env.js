'use strict';

/**
 * 零依赖 .env 加载器 / 密钥体系基础模块。
 *
 * 职责：
 *  1. 解析 .env 文本（KEY=VALUE、# 注释、引号、export 前缀、空行、行内注释）；
 *  2. 按优先级收集本应用支持的环境变量：
 *       进程环境变量  >  仓库根 .env  >  userData/.env
 *     （逐键判断，某一层为空字符串时视为「未设置」，继续回退下一层）
 *  3. 把环境变量映射成 config 的覆盖项（env.js 不直接 require config.js，避免循环依赖）。
 *
 * 设计约定：
 *  - 环境变量值只作用于「运行时内存配置」，绝不写回 data/config.json；
 *  - 支持的键见 ENV_SPEC；不在表里的环境变量一律忽略（避免误把系统变量注入配置）；
 *  - 本模块不修改 process.env，也不做 ${VAR} 变量展开（保持行为可预期）。
 */

const fs = require('fs');
const path = require('path');

const ENV_FILENAME = '.env';
const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TTS_PROVIDERS = ['edge', 'openai', 'none'];

/**
 * 环境变量 -> config 路径。
 * kind: string | number | integer；secret: 日志/回显打码。
 * 新增键时只需在这里加一行，config.js 会自动按路径覆盖与保存时剔除。
 */
const ENV_SPEC = [
  { key: 'LLM_API_KEY', path: ['llm', 'apiKey'], kind: 'string', secret: true },
  { key: 'LLM_BASE_URL', path: ['llm', 'baseURL'], kind: 'string' },
  { key: 'LLM_MODEL', path: ['llm', 'model'], kind: 'string' },
  { key: 'LLM_TEMPERATURE', path: ['llm', 'temperature'], kind: 'number' },
  { key: 'LLM_MAX_TOKENS', path: ['llm', 'maxTokens'], kind: 'integer' },
  { key: 'TTS_PROVIDER', path: ['tts', 'provider'], kind: 'string' },
  { key: 'TTS_VOICE', path: ['tts', 'voice'], kind: 'string' },
  { key: 'INGEST_TOKEN', path: ['ingest', 'token'], kind: 'string', secret: true },
  { key: 'SERVER_PORT', path: ['server', 'port'], kind: 'integer' },
];

const SUPPORTED_KEYS = ENV_SPEC.map((s) => s.key);
const SPEC_BY_KEY = new Map(ENV_SPEC.map((s) => [s.key, s]));

function specByKey(key) {
  return SPEC_BY_KEY.get(key) || null;
}

function unescapeDoubleQuoted(text) {
  const map = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\', $: '$' };
  return text.replace(/\\([nrt"\\$])/g, (_m, c) => map[c]);
}

/**
 * 解析 .env 文本。
 * @param {string} text
 * @returns {{values: Record<string,string>, warnings: string[]}}
 */
function parseEnv(text) {
  const values = Object.create(null);
  const warnings = [];
  if (text === undefined || text === null || text === '') return { values, warnings };

  // 去 BOM，兼容 CRLF / CR
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export')) {
      const rest = line.slice('export'.length);
      if (!rest || !/^\s/.test(rest)) { // "exportFOO" 不是 export 前缀
        warnings.push(`第 ${i + 1} 行不是合法的 export 写法`);
        continue;
      }
      line = rest.trim();
    }
    const eq = line.indexOf('=');
    if (eq < 1) {
      warnings.push(`第 ${i + 1} 行缺少 KEY= 结构，已忽略`);
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (!VALID_KEY.test(key)) {
      warnings.push(`第 ${i + 1} 行变量名不合法（${key}），已忽略`);
      continue;
    }
    const raw = line.slice(eq + 1).trim();
    if (raw.startsWith('"')) {
      const m = raw.match(/^"((?:[^"\\]|\\.)*)"/);
      if (!m) {
        warnings.push(`第 ${i + 1} 行双引号未闭合，已忽略`);
        continue;
      }
      values[key] = unescapeDoubleQuoted(m[1]);
      continue;
    }
    if (raw.startsWith("'")) {
      const m = raw.match(/^'([^']*)'/);
      if (!m) {
        warnings.push(`第 ${i + 1} 行单引号未闭合，已忽略`);
        continue;
      }
      values[key] = m[1];
      continue;
    }
    // 未加引号：去掉「空白 + #」开头的行内注释，再 trim
    values[key] = raw.replace(/\s+#.*$/, '').trim();
  }
  return { values, warnings };
}

/**
 * 读取单个 .env 文件；不存在不算错误。只读取不删除。
 * @returns {{file:string, exists:boolean, values:Record<string,string>, warnings:string[], error:string|null}}
 */
function readEnvFile(file) {
  const out = { file, exists: false, values: Object.create(null), warnings: [], error: null };
  if (!file) return out;
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return out;
    const text = fs.readFileSync(file, 'utf8');
    const parsed = parseEnv(text);
    out.exists = true;
    out.values = parsed.values;
    out.warnings = parsed.warnings;
  } catch (err) {
    out.error = err.message;
  }
  return out;
}

function normPathKey(file) {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * 候选 .env 文件（按优先级从高到低）：仓库根 .env -> userData/.env。
 * 同一路径只保留一次（dev 模式下 userData 可能等于仓库根）。
 * @returns {Array<{file:string, source:'root'|'userData'}>}
 */
function candidateFiles({ rootDir, userDataDir } = {}) {
  const list = [];
  const seen = new Set();
  const push = (file, source) => {
    if (!file) return;
    const resolved = path.resolve(file);
    const key = normPathKey(resolved);
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ file: resolved, source });
  };
  push(rootDir ? path.join(rootDir, ENV_FILENAME) : '', 'root');
  push(userDataDir ? path.join(userDataDir, ENV_FILENAME) : '', 'userData');
  return list;
}

function isNonEmpty(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

/**
 * 按「进程环境变量 > 仓库根 .env > userData/.env」逐键解析出本应用支持的环境变量。
 * @param {{rootDir?:string, userDataDir?:string, env?:Record<string,string>}} options
 * @returns {{
 *   values: Record<string,string>,
 *   sources: Record<string,'process'|'root'|'userData'>,
 *   keys: string[],
 *   files: Array<{file:string, source:string, exists:boolean, error:string|null}>,
 *   warnings: string[],
 * }}
 */
function loadEnv(options = {}) {
  const env = options.env || process.env;
  const candidates = candidateFiles(options);
  const files = candidates.map(({ file, source }) => {
    const read = readEnvFile(file);
    return { ...read, source };
  });

  const values = Object.create(null);
  const sources = Object.create(null);
  const warnings = [];

  for (const spec of ENV_SPEC) {
    // 1) 进程环境变量优先
    const fromProcess = env ? env[spec.key] : undefined;
    if (isNonEmpty(fromProcess)) {
      values[spec.key] = String(fromProcess);
      sources[spec.key] = 'process';
      continue;
    }
    // 2) 仓库根 .env 3) userData/.env（candidateFiles 已按优先级排序）
    for (const f of files) {
      if (!f.exists) continue;
      const hit = f.values[spec.key];
      if (!isNonEmpty(hit)) continue;
      values[spec.key] = String(hit);
      sources[spec.key] = f.source;
      break;
    }
  }

  for (const f of files) {
    for (const w of f.warnings) warnings.push(`${f.file}: ${w}`);
    if (f.error) warnings.push(`${f.file}: 读取失败（${f.error}）`);
  }

  return {
    values,
    sources,
    keys: Object.keys(values),
    files: files.map(({ file, source, exists, error }) => ({ file, source, exists, error })),
    warnings,
  };
}

/** 把字符串强转为目标类型；不合法返回 null（表示忽略该键）。 */
function coerceValue(spec, raw) {
  const text = String(raw).trim();
  if (!text) return null;
  if (spec.kind === 'integer') {
    if (!/^-?\d+$/.test(text)) return null;
    const n = Number(text);
    if (!Number.isSafeInteger(n)) return null;
    if (spec.key === 'SERVER_PORT' && (n < 1 || n > 65535)) return null;
    if (spec.key === 'LLM_MAX_TOKENS' && n < 1) return null;
    return n;
  }
  if (spec.kind === 'number') {
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }
  if (spec.key === 'TTS_PROVIDER') {
    const provider = text.toLowerCase();
    return TTS_PROVIDERS.includes(provider) ? provider : null;
  }
  return text;
}

/**
 * 将环境变量解析为 config 覆盖项。
 * @returns {{overrides: Array<{key:string,path:string[],pathString:string,value:any,secret:boolean,source:string}>, warnings: Array<{key:string,message:string}>}}
 */
function resolveOverrides(envInfo) {
  const overrides = [];
  const warnings = [];
  if (!envInfo || !envInfo.values) return { overrides, warnings };
  for (const spec of ENV_SPEC) {
    if (!Object.prototype.hasOwnProperty.call(envInfo.values, spec.key)) continue;
    const value = coerceValue(spec, envInfo.values[spec.key]);
    if (value === null) {
      warnings.push({ key: spec.key, message: `值不合法，已忽略: ${envInfo.values[spec.key]}` });
      continue;
    }
    overrides.push({
      key: spec.key,
      path: spec.path,
      pathString: spec.path.join('.'),
      value,
      secret: Boolean(spec.secret),
      source: envInfo.sources[spec.key] || 'unknown',
    });
  }
  return { overrides, warnings };
}

function setPath(obj, keys, value) {
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}

function getPath(obj, keys) {
  let cur = obj;
  for (const k of keys) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

/** 删除 patch 里的某条路径；返回是否真的删掉了。 */
function deletePath(obj, keys) {
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    cur = cur === null || typeof cur !== 'object' ? undefined : cur[keys[i]];
  }
  const last = keys[keys.length - 1];
  if (cur && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, last)) {
    delete cur[last];
    return true;
  }
  return false;
}

/** 把 overrides 应用到 config（就地修改），返回 config。 */
function applyOverrides(config, overrides) {
  for (const o of overrides || []) setPath(config, o.path, o.value);
  return config;
}

/** patch 里哪些字段会被 env 托管（保存时应丢弃，避免 .env 值落进 config.json）。 */
function listManagedHits(patch, overrides) {
  return (overrides || []).filter((o) => getPath(patch, o.path) !== undefined);
}

/** 日志用：`LLM_API_KEY=*** (仓库根 .env)`。 */
function describeOverrides(overrides) {
  return (overrides || []).map((o) => {
    const where = o.source === 'process' ? '进程环境变量' : (o.source === 'root' ? '仓库根 .env' : 'userData/.env');
    return `${o.key}=${o.secret ? '***' : String(o.value)} (${where})`;
  });
}

/** 日志用：找到的 .env 文件列表（只列存在的）。 */
function describeEnvFiles(envInfo) {
  if (!envInfo || !envInfo.files) return [];
  return envInfo.files.filter((f) => f.exists).map((f) => `${f.file} [${f.source}]`);
}

module.exports = {
  ENV_FILENAME,
  ENV_SPEC,
  SUPPORTED_KEYS,
  VALID_KEY,
  parseEnv,
  readEnvFile,
  candidateFiles,
  loadEnv,
  resolveOverrides,
  applyOverrides,
  listManagedHits,
  describeOverrides,
  describeEnvFiles,
  specByKey,
  setPath,
  getPath,
  deletePath,
};
