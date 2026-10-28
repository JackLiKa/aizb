'use strict';

const fs = require('fs');
const path = require('path');

const {
  loadEnv,
  resolveOverrides,
  applyOverrides,
  deletePath,
  describeEnvFiles,
} = require('./env');

const ROOT_DIR = path.join(__dirname, '..', '..');

const DEFAULTS = {
  app: {
    autoStart: false,
    openAdmin: true,
    preventSleep: true,
  },
  server: {
    host: '127.0.0.1',
    port: 17890,
  },
  stage: {
    width: 1280,
    height: 720,
    fps: 30,
    kiosk: false,
  },
  avatar: {
    hairColor: '#414d85',
    hairShadeColor: '#333b6c',
    skinColor: '#fbe3dc',
    finColor: '#3a4a8c',
    blushColor: '#fdc5bd',
  },
  source: {
    type: 'simulator',
    simulator: {
      commentsPerMinute: 10,
      giftEverySec: 100,
      songRequestChance: 0.12,
    },
  },
  // 抖音真实弹幕采集（由 sources.js 托管 scripts/douyin-collector.js）
  douyin: {
    enabled: false,
    roomId: '',
    browserPath: '',
    headless: true,
    restartDelaySec: 5,
  },
  llm: {
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.95,
    maxTokens: 120,
    timeoutMs: 20000,
    stream: true,
    historyTurns: 8,
  },
  tts: {
    provider: 'edge',
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+8%',
    pitch: '+12Hz',
    volume: '+0%',
    cache: true,
    openai: {
      baseURL: '',
      apiKey: '',
      model: 'tts-1',
      voice: 'alloy',
    },
  },
  persona: {
    name: '肥鱼',
    system: [
      '你是「肥鱼」，一条住在直播间里的大肥鱼，圆滚滚、爱撒娇、嘴有点贫。',
      '你在做 24 小时陪伴直播，观众可以跟你聊天、点歌、送礼物。',
      '',
      '说话规则：',
      '1. 永远用口语，一次只说一到两句，总共不超过 60 个字。',
      '2. 不要用 Markdown、列表、括号旁白或颜文字，也不要唱歌词。',
      '3. 被叫到名字要回应，可以自嘲胖、爱吃、游得慢。',
      '4. 不要提到自己是 AI、模型或程序，你是一条鱼。',
      '5. 遇到不适合回答的话题就装傻带过，比如“这个鱼不懂啦”。',
      '6. 收到礼物要开心道谢，但不要提钱。',
      '7. 不要连续重复上一句说过的话。',
    ].join('\n'),
  },
  behavior: {
    replyProbability: 0.9,
    userCooldownSec: 8,
    minIntervalSec: 1,
    maxQueue: 24,
    maxSpeakChars: 70,
    dedupeWindowSec: 30,
    interruptOnGift: true,
    sentenceMaxChars: 40,
    welcomeEnabled: true,
    welcomeCooldownSec: 600,
  },
  night: {
    enabled: true,
    start: '02:00',
    end: '07:00',
    replyProbability: 0.08,
    maxTokens: 60,
  },
  metering: {
    inputPricePerM: 2,
    outputPricePerM: 8,
    ttsPricePer1kChars: 0,
    currency: '¥',
    displayMultiplier: 1,
    dailyRetainDays: 30,
  },
  ingest: {
    enabled: true,
    token: 'change-me',
  },
  jukebox: {
    enabled: true,
    dir: 'music',
    maxQueue: 10,
    perUserCooldownSec: 300,
    maxSongSec: 600,
  },
  admin: {
    enabled: true,
  },
  watchdog: {
    heartbeatTimeoutSec: 12,
    maxRestartsPerHour: 6,
  },
  // 合规：抖音要求虚拟人直播由真人驱动/值守，AI 生成内容需显著标识
  compliance: {
    humanInLoop: false,
    aiDisclosure: true,
  },
};

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepClone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [key, val] of Object.entries(patch || {})) {
    if (isPlainObject(val) && isPlainObject(out[key])) out[key] = deepMerge(out[key], val);
    else if (val !== undefined) out[key] = val;
  }
  return out;
}

function writeConfigFile(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 加载配置：config.json 为持久层，.env / 进程环境变量为运行时覆盖层。
 *
 * 两层结构（env 值永不落盘）：
 *   diskConfig = DEFAULTS < config.json
 *   config     = diskConfig < env 覆盖（进程环境变量 > 仓库根 .env > userData/.env）
 *
 * save(next)：
 *   1. patch 中被 env 托管的路径直接丢弃（内存以 env 为准，也不写盘）；
 *   2. 其余字段合并进 diskConfig 并写盘；
 *   3. 若 apiKey 来自 env，配置文件中 llm.apiKey 恒为空字符串（绝不回写明文）；
 *   4. 内存 config = 新 diskConfig + env 覆盖（保存后内存里仍是 env 值）。
 *
 * @param {string} dataDir 数据目录（dev: 仓库 data/；打包: userData/data）
 * @param {{rootDir?:string,userDataDir?:string,env?:Record<string,string>}} [options]
 * @returns {{config:object,file:string,env:object,envOverrides:Array,envWarnings:string[],save:(next:object)=>object}}
 */
function loadConfig(dataDir, options = {}) {
  const opts = options || {};
  const file = path.join(dataDir, 'config.json');
  fs.mkdirSync(dataDir, { recursive: true });

  let user = {};
  let existed = false;
  if (fs.existsSync(file)) {
    existed = true;
    try {
      user = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`config.json 解析失败: ${err.message}`);
    }
  }

  const rootDir = opts.rootDir || ROOT_DIR;
  // 默认 userDataDir = dataDir 的父目录（打包时即 app.getPath('userData')）。
  const userDataDir = opts.userDataDir !== undefined ? opts.userDataDir : path.dirname(dataDir);
  const env = opts.env === undefined ? process.env : opts.env;
  const envInfo = loadEnv({ rootDir, userDataDir, env });
  const resolved = resolveOverrides(envInfo);

  const envWarnings = resolved.warnings.map((w) => `环境变量 ${w.key}: ${w.message}`).concat(envInfo.warnings || []);
  const envOverrides = resolved.overrides;

  // 持久层（磁盘内容；绝不含 env 值）
  const diskConfig = deepMerge(DEFAULTS, user);
  // 运行时有效配置
  const config = applyOverrides(deepClone(diskConfig), envOverrides);

  if (!existed) writeConfigFile(file, diskConfig);

  const handle = {
    config,
    file,
    env: envInfo,
    envOverrides,
    envWarnings,
    envFiles: describeEnvFiles(envInfo),
    save(next) {
      const patch = deepClone(next || {});
      // 1) env 托管字段不允许经由保存接口修改/写盘
      for (const item of envOverrides) deletePath(patch, item.path);
      // 2) 合并进持久层
      const mergedDisk = deepMerge(diskConfig, patch);
      // 3) apiKey 来自 env：磁盘保持空值，绝不回写明文
      if (envInfo.sources && envInfo.sources.LLM_API_KEY) {
        if (!isPlainObject(mergedDisk.llm)) mergedDisk.llm = {};
        mergedDisk.llm.apiKey = '';
      }
      for (const key of Object.keys(diskConfig)) {
        if (!(key in mergedDisk)) delete diskConfig[key];
      }
      Object.assign(diskConfig, mergedDisk);
      writeConfigFile(file, diskConfig);
      // 4) 内存层重新叠加 env 覆盖，保证「保存后内存里仍是 env 值」
      const effective = applyOverrides(deepClone(diskConfig), envOverrides);
      for (const key of Object.keys(config)) {
        if (!(key in effective)) delete config[key];
      }
      Object.assign(config, effective);
      return config;
    },
  };
  return handle;
}

/**
 * /api/state 用的 LLM 状态快照。
 * keySource：env（.env/进程环境变量提供）> config（config.json 提供）> none。
 * mode 与 brain.mode 同口径：apiKey 与 baseURL 都有才算 llm 模式。
 */
function llmStatus(config, envInfo) {
  const llm = (config && config.llm) || {};
  const apiKey = String(llm.apiKey || '').trim();
  const baseURL = String(llm.baseURL || '').trim();
  const model = String(llm.model || '').trim();
  const envKey = Boolean(envInfo && envInfo.values && String(envInfo.values.LLM_API_KEY || '').trim());
  let keySource = 'none';
  if (envKey) keySource = 'env';
  else if (apiKey) keySource = 'config';
  return {
    mode: apiKey && baseURL ? 'llm' : 'echo',
    keySource,
    configured: Boolean(apiKey),
    baseURL,
    model,
  };
}

module.exports = { DEFAULTS, deepMerge, deepClone, loadConfig, writeConfigFile, llmStatus };
