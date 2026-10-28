'use strict';

const fs = require('fs');
const path = require('path');

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
    replyProbability: 0.5,
    userCooldownSec: 25,
    minIntervalSec: 2,
    maxQueue: 24,
    maxSpeakChars: 70,
    dedupeWindowSec: 60,
    interruptOnGift: true,
    sentenceMaxChars: 40,
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
    ttsPricePer1kChars: 0.15,
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
};

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
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

function loadConfig(dataDir) {
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
  const config = deepMerge(DEFAULTS, user);
  if (!existed) writeConfigFile(file, config);
  return {
    config,
    file,
    save(next) {
      const merged = deepMerge(config, next || {});
      for (const key of Object.keys(config)) {
        if (!(key in merged)) delete config[key];
      }
      Object.assign(config, merged);
      writeConfigFile(file, config);
      return config;
    },
  };
}

module.exports = { DEFAULTS, deepMerge, loadConfig, writeConfigFile };
