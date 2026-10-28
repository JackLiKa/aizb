'use strict';

const ECHO_LINES = {
  comment: [
    '嘿嘿，{user} 来啦，今天也一起摸鱼吧。',
    '这条弹幕我看到了，{user} 说得对，鱼就是这么懒。',
    '唔……这个问题好难，让肥鱼先吐两个泡泡想想。',
    '{user} 你也在摸鱼吗？那我们是一条船上的鱼了。',
    '好呀好呀，肥鱼都听你的。',
    '别催别催，鱼游得慢是天生的嘛。',
    '今天的直播有点上头，我都有点晕水了。',
    '你这么一说，我肚子又饿了。',
  ],
  gift: [
    '哇，{user} 送的礼物好香，肥鱼尾巴都摇起来了。',
    '谢谢 {user}，这下肥鱼更有力气游泳了。',
    '{user} 太客气啦，肥鱼给你吐个爱心泡泡。',
    '收到收到，{user} 的心意肥鱼记在小本本上了。',
  ],
  follow: [
    '欢迎 {user} 上船，以后就是一条鱼塘里的了。',
    '新朋友 {user} 来啦，快找个舒服的位置躺好。',
  ],
  enter: [
    '欢迎 {user} 游进鱼塘，随便坐呀～',
    '{user} 来啦，快找个舒服的位置躺好。',
    '哟，{user} 也来摸鱼了，欢迎欢迎。',
    '欢迎 {user}，今天的鱼塘很热闹呢。',
  ],
  song: [
    '好嘞，这首《{title}》安排上，耳朵竖起来。',
    '《{title}》来咯，跟着肥鱼一起晃尾巴。',
    '收到点歌，{user} 点的《{title}》，马上开唱。',
  ],
  songMiss: [
    '《{query}》这条鱼还没学会，换个别的试试？',
    '曲库里没有找到《{query}》，肥鱼先去补课。',
  ],
  manual: ['{text}'],
};

function pick(list, seedBox) {
  if (!list.length) return '';
  let idx = Math.floor(Math.random() * list.length);
  if (list.length > 1 && idx === seedBox.last) idx = (idx + 1) % list.length;
  seedBox.last = idx;
  return list[idx];
}

function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / 4);
}

function pickEventPrompt(event) {
  const user = event.user || '观众';
  switch (event.type) {
    case 'gift':
      return `观众「${user}」送出了「${event.giftName || '礼物'}」×${event.count || 1}。用一句话开心地感谢，提到对方名字，不要提钱。`;
    case 'follow':
      return `观众「${user}」关注了你。用一句话欢迎他。`;
    case 'enter':
      return `观众「${user}」进入了你的直播间。用一句话热情地欢迎他，可以带点玩笑，不要提钱。`;
    case 'song':
      if (event.song) return `观众「${user}」点了《${event.song.title}》，现在开始放。用一句话俏皮地开场。`;
      return `观众「${user}」想听《${event.query || ''}》，但曲库里没有。用一句话抱歉地告诉他，并推荐随便点别的。`;
    case 'manual':
      return `${event.text}`;
    case 'comment':
    default:
      return `观众「${user}」说：${event.text}`;
  }
}

class Brain {
  constructor({ config, logger, metering }) {
    this.config = config;
    this.logger = logger;
    this.metering = metering;
    this.lastEcho = { last: -1 };
  }

  get live() {
    const { apiKey, baseURL } = this.config.llm;
    return Boolean(apiKey && baseURL);
  }

  get mode() {
    return this.live ? 'llm' : 'echo';
  }

  _systemPrompt(stateHint) {
    const now = new Date();
    const time = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
    const lines = [this.config.persona.system, '', `现在是 ${time}。`];
    if (stateHint) lines.push(stateHint);
    lines.push('只输出你要说的话本身，不要加引号、动作描写或解释。');
    return lines.join('\n');
  }

  _messages(event, history, stateHint) {
    const msgs = [{ role: 'system', content: this._systemPrompt(stateHint) }];
    const keep = Math.max(0, (this.config.llm.historyTurns || 8) * 2);
    for (const m of history.slice(-keep)) msgs.push({ role: m.role, content: m.content });
    msgs.push({ role: 'user', content: pickEventPrompt(event) });
    return msgs;
  }

  async *stream({ event, history = [], signal, maxTokens, stateHint, onUsage }) {
    const messages = this._messages(event, history, stateHint);
    const limit = maxTokens || this.config.llm.maxTokens;
    if (!this.live) {
      yield* this._echo(event, signal, onUsage, messages);
      return;
    }
    if (this.config.llm.stream === false) {
      yield* this._once(messages, limit, signal, onUsage);
      return;
    }
    yield* this._sse(messages, limit, signal, onUsage);
  }

  async *_echo(event, signal, onUsage, messages) {
    let text = '';
    if (event.type === 'comment') text = pick(ECHO_LINES.comment, this.lastEcho);
    else if (event.type === 'gift') text = pick(ECHO_LINES.gift, this.lastEcho);
    else if (event.type === 'follow') text = pick(ECHO_LINES.follow, this.lastEcho);
    else if (event.type === 'enter') text = pick(ECHO_LINES.enter, this.lastEcho);
    else if (event.type === 'song') {
      text = event.song
        ? pick(ECHO_LINES.song, this.lastEcho)
        : pick(ECHO_LINES.songMiss, this.lastEcho);
    } else text = pick(ECHO_LINES.manual, this.lastEcho);

    text = text
      .replace(/\{user\}/g, event.user || '朋友')
      .replace(/\{title\}/g, event.song?.title || '')
      .replace(/\{query\}/g, event.query || '')
      .replace(/\{text\}/g, event.text || '');

    const delay = Number(this.config.llm.echoDelayMs ?? 12);
    for (let i = 0; i < text.length; i += 2) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      yield text.slice(i, i + 2);
    }
    onUsage?.({
      promptTokens: estimateTokens(messages.map((m) => m.content).join('')),
      completionTokens: estimateTokens(text),
      estimated: true,
    });
  }

  async *_once(messages, maxTokens, signal, onUsage) {
    const body = { model: this.config.llm.model, messages, temperature: this.config.llm.temperature, max_tokens: maxTokens, stream: false };
    const res = await this._request(body, signal);
    const json = await res.json();
    const text = json.choices?.[0]?.message?.content || '';
    const usage = json.usage || {};
    onUsage?.({
      promptTokens: usage.prompt_tokens ?? estimateTokens(messages.map((m) => m.content).join('')),
      completionTokens: usage.completion_tokens ?? estimateTokens(text),
    });
    yield text;
  }

  async *_sse(messages, maxTokens, signal, onUsage) {
    const body = {
      model: this.config.llm.model,
      messages,
      temperature: this.config.llm.temperature,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    let res = await this._request(body, signal);
    if (res.status === 400) {
      // 部分兼容接口不认 stream_options，去掉重试一次
      const errText = await res.text().catch(() => '');
      delete body.stream_options;
      this.logger?.warn('LLM 拒绝 stream_options，已降级重试', { detail: errText.slice(0, 120) });
      res = await this._request(body, signal);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`LLM ${res.status}: ${detail.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let usage = null;
    let finished = false;

    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') { finished = true; break; }
        try {
          const json = JSON.parse(data);
          if (json.usage) usage = json.usage;
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            text += delta;
            yield delta;
          }
        } catch (_) { /* 忽略心跳/坏行 */ }
      }
    }

    onUsage?.({
      promptTokens: usage?.prompt_tokens ?? estimateTokens(messages.map((m) => m.content).join('')),
      completionTokens: usage?.completion_tokens ?? estimateTokens(text),
    });
  }

  _request(body, signal) {
    const base = String(this.config.llm.baseURL || '').replace(/\/+$/, '');
    const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
    const timeout = this.config.llm.timeoutMs || 20000;
    const timeoutSignal = AbortSignal.timeout(timeout);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.llm.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: combined,
    });
  }
}

module.exports = { Brain, estimateTokens };
