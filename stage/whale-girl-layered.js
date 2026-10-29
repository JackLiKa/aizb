// 分层 2D 渲染器：用设定图拆出的头/身/眼/嘴图层驱动眨眼、口型、呼吸和摇摆。
// 与 whale-girl.js 的程序化画法不同，这里保留原画像素，只叠加局部动画。

const TAU = Math.PI * 2;
const ASSET = './assets/avatar/';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const smoothstep = (v) => {
  const x = clamp(v, 0, 1);
  return x * x * (3 - 2 * x);
};

function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function withAlpha(hex, a) {
  const rgb = parseHex(hex);
  if (!rgb) return `rgba(255, 255, 255, ${a})`;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
}

function heartPath(ctx, x, y, size, rot) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(size, size);
  ctx.beginPath();
  ctx.moveTo(0, 0.36);
  ctx.bezierCurveTo(-0.34, 0.1, -0.36, -0.24, -0.12, -0.3);
  ctx.bezierCurveTo(0.02, -0.34, 0.12, -0.24, 0.18, -0.18);
  ctx.bezierCurveTo(0.24, -0.24, 0.34, -0.34, 0.48, -0.3);
  ctx.bezierCurveTo(0.72, -0.24, 0.7, 0.1, 0.36, 0.36);
  ctx.closePath();
  ctx.restore();
}

export class LayeredGirlRenderer {
  static async create(canvas, opts = {}) {
    const renderer = new LayeredGirlRenderer(canvas, opts);
    await renderer.load();
    return renderer;
  }

  constructor(canvas, { fps = 30, palette = {} } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.fps = fps;
    this.frameMs = 1000 / fps;
    this.lastFrame = 0;
    this.t = 0;
    this.mode = 'idle';
    this.thinkEnv = 0;
    this.singEnv = 0;
    this.mouth = 0;
    this.mouthTarget = 0;
    this.blink = 0;
    this.blinkHold = null;
    this.blinkT = -1;
    this.nextBlink = 2.4;
    this.doubleBlink = false;
    this.idleAction = null;
    this.idleNext = 1.6 + Math.random() * 1.8;
    this.idle = { x: 0, y: 0, tilt: 0 };
    this.idleTarget = { x: 0, y: 0, tilt: 0 };
    this.idleMouth = 0;
    this.particles = [];
    this.notes = [];
    this.bubbles = [];
    this.happyUntil = 0;
    this.happyT0 = 0;
    this.bounceUntil = 0;
    this.bounceStart = 0;
    this.bounceDur = 1400;
    this.bounceAmp = 16;
    this.bowT0 = 0;
    this.bowDur = 2400;
    this.bowEnv = 0;
    this.bowHead = 0;
    this.sadT0 = 0;
    this.sadDur = 4200;
    this.sadEnv = 0;
    this.sadPhase = 0;
    this.sadShakeAmp = 0;
    this._lastNoteAt = 0;
    this.palette = { fin: palette.finColor || '#6f8fe0' };
    this.w = 1280;
    this.h = 720;
    this.dpr = 1;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this._seedBubbles();
  }

  async load() {
    const meta = await (await fetch(`${ASSET}layers.json`)).json();
    const load = (file) => new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`无法加载图层 ${file}`));
      img.src = ASSET + file;
    });
    const [body, head, mouthOpen, mouthClosed, eyeLeft, eyeRight] = await Promise.all([
      load(meta.body.file),
      load(meta.head.file),
      load(meta.mouth.open),
      load(meta.mouth.closed),
      load(meta.eyes.left.file),
      load(meta.eyes.right.file),
    ]);
    this.meta = meta;
    this.bodyImg = body;
    this.headImg = head;
    this.mouthOpenImg = mouthOpen;
    this.mouthClosedImg = mouthClosed;
    this.eyeImgs = { left: eyeLeft, right: eyeRight };
    this.sw = meta.sprite.w;
    this.sh = meta.sprite.h;
    this.pivot = meta.head.pivot;
    this.mouthBox = meta.mouth.box;
    this.mouthPad = meta.mouth.pad;
    this.mouthStretch = meta.mouth.stretch;
    this.mouthInner = meta.mouth.inner;
    this.tailY = meta.tail?.y ?? 0;
    this.tailAmp = meta.tail?.amp ?? 0;
    this.tailPivot = meta.tail?.pivot ?? 180;
    this.ready = true;
  }

  setPalette(p) {
    if (p?.finColor) this.palette.fin = p.finColor;
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  start() {
    const loop = (now) => {
      requestAnimationFrame(loop);
      if (now - this.lastFrame < this.frameMs) return;
      const dt = clamp((now - this.lastFrame) / 1000, 0.001, 0.1);
      this.lastFrame = now;
      this.t += dt;
      this.update(dt, now);
      this.draw(now);
    };
    requestAnimationFrame(loop);
  }

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    if (mode === 'speaking') this.mouthTarget = Math.max(this.mouthTarget, 0.25);
  }

  setMouth(v) {
    this.mouthTarget = clamp(v, 0, 1);
  }

  setBlink(v) {
    this.blinkHold = v == null ? null : clamp(v, 0, 1);
  }

  celebrate() {
    const now = performance.now();
    this.bowT0 = 0;
    this.bowHead = 0;
    this.sadT0 = 0;
    this.sadPhase = 0;
    this.sadShakeAmp = 0;
    this.happyT0 = now;
    this.happyUntil = now + 2600;
    this.bounceStart = now;
    this.bounceDur = 1400;
    this.bounceAmp = 16;
    this.bounceUntil = now + this.bounceDur;
    this._spawnBurst(36);
  }

  // 礼物：低头鞠躬，持续约 2.4s（预备 → 下压 → 停顿 → 回弹起身）
  bow() {
    const now = performance.now();
    this.bowT0 = now;
    this.bowDur = 2400;
    this.sadT0 = 0;
    this.sadPhase = 0;
    this.sadShakeAmp = 0;
    this.happyT0 = now;
    this.happyUntil = Math.max(this.happyUntil, now + 1400);
    this.bounceStart = 0;
    this.bounceUntil = 0;
    this._spawnBurst(18);
  }

  // 点歌未找到：无奈脸 + 摇头
  shakeHead() {
    const now = performance.now();
    this.sadT0 = now;
    this.sadDur = 4200;
    this.sadPhase = 0;
    this.sadShakeAmp = 0;
    this.bowT0 = 0;
    this.bowHead = 0;
    this.happyUntil = 0;
    this.bounceStart = 0;
    this.bounceUntil = 0;
  }

  // 0→1→0 的动作包络：进出一律 smoothstep，避免线性折角造成的顿挫
  _actionEnv(now, t0, dur, inFrac = 0.22, holdFrac = 0.58) {
    if (!t0) return 0;
    const p = (now - t0) / dur;
    if (p <= 0 || p >= 1) return 0;
    if (p < inFrac) return smoothstep(p / inFrac);
    if (p < holdFrac) return 1;
    return smoothstep((1 - p) / (1 - holdFrac));
  }

  // 鞠躬曲线：先轻微起身作预备，再下沉、停顿微松，起身带一点回弹
  _bowCurve(now) {
    if (!this.bowT0) return 0;
    const p = (now - this.bowT0) / this.bowDur;
    if (p <= 0 || p >= 1) return 0;
    const inEnd = 0.24;
    const holdEnd = 0.56;
    if (p < inEnd) {
      const x = p / inEnd;
      if (x < 0.28) return -0.06 * smoothstep(x / 0.28);
      return -0.06 + 1.06 * smoothstep((x - 0.28) / 0.72);
    }
    if (p < holdEnd) {
      const x = (p - inEnd) / (holdEnd - inEnd);
      return 1 + 0.012 * Math.sin(x * Math.PI * 3) * (1 - x);
    }
    const x = (p - holdEnd) / (1 - holdEnd);
    return 1 - smoothstep(x) + 0.045 * Math.sin(Math.PI * x) * (1 - x);
  }

  _hop(now) {
    if (!this.bounceStart || now >= this.bounceUntil) return 0;
    const p = clamp((now - this.bounceStart) / this.bounceDur, 0, 1);
    return Math.sin(p * Math.PI) * this.bounceAmp;
  }

  _seedBubbles() {
    this.bubbles = Array.from({ length: 22 }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: 2 + Math.random() * 7,
      speed: 0.012 + Math.random() * 0.03,
      sway: Math.random() * TAU,
      alpha: 0.08 + Math.random() * 0.16,
    }));
  }

  _spawnBurst(n) {
    const colors = ['#ff7a9c', '#ffd166', '#6fd6ff', '#ffffff', '#9fe0ff'];
    for (let i = 0; i < n; i += 1) {
      const type = Math.random() < 0.6 ? 'heart' : 'bubble';
      this.particles.push({
        x: (Math.random() - 0.5) * 200,
        y: (Math.random() - 0.5) * 40,
        vx: (Math.random() - 0.5) * 140,
        vy: -50 - Math.random() * 120,
        life: 0,
        maxLife: 1.4 + Math.random() * 1.1,
        size: type === 'heart' ? 9 + Math.random() * 9 : 2 + Math.random() * 3,
        rot: (Math.random() - 0.5) * 0.6,
        vr: (Math.random() - 0.5) * 1.6,
        color: colors[Math.floor(Math.random() * colors.length)],
        type,
      });
    }
    if (this.particles.length > 120) this.particles.splice(0, this.particles.length - 120);
  }

  update(dt, now) {
    this.bowEnv = this._bowCurve(now);
    this.sadEnv = this._actionEnv(now, this.sadT0, this.sadDur, 0.12, 0.66);

    // 头部比身体晚一点跟上、晚一点收回，形成跟随感而不是整体硬切
    const bowTarget = Math.max(0, this.bowEnv);
    this.bowHead += (bowTarget - this.bowHead) * Math.min(1, dt * 9);
    if (this.sadEnv > 0.001) {
      // 真人的“不行”是两下就停，不是连续摆满 4 秒
      this.sadPhase += dt * TAU * 1.7;
      this.sadShakeAmp += (1 - this.sadShakeAmp) * Math.min(1, dt * 6);
    } else {
      this.sadPhase = 0;
      this.sadShakeAmp += (0 - this.sadShakeAmp) * Math.min(1, dt * 4.5);
    }

    this.mouth += (this.mouthTarget - this.mouth) * Math.min(1, dt * 16);
    if (this.mode !== 'speaking') this.mouthTarget *= Math.pow(0.002, dt);
    if (this.mode !== 'speaking' && this.mouth < 0.01) this.mouth = 0;

    if (this.blinkHold != null) {
      this.blink = this.blinkHold;
    } else if (this.blinkT >= 0) {
      this.blinkT += dt;
      const p = this.blinkT / 0.17;
      this.blink = p >= 1 ? 0 : Math.sin(Math.PI * clamp(p, 0, 1));
      if (p >= 1) {
        this.blinkT = -1;
        if (this.doubleBlink) {
          this.doubleBlink = false;
          this.nextBlink = this.t + 0.26;
        } else {
          this.nextBlink = this.t + 2.2 + Math.random() * 3.4;
        }
      }
    } else if (this.t > this.nextBlink) {
      this.blinkT = 0;
    }

    this._updateIdle(dt, now);
    this.thinkEnv += (((this.mode === 'thinking') ? 1 : 0) - this.thinkEnv) * Math.min(1, dt * 4);
    this.singEnv += (((this.mode === 'singing') ? 1 : 0) - this.singEnv) * Math.min(1, dt * 3);

    for (const b of this.bubbles) {
      b.y -= b.speed * dt;
      if (b.y < -0.05) {
        b.y = 1.05;
        b.x = Math.random();
      }
    }

    for (const p of this.particles) {
      p.life += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy -= 14 * dt;
      p.vx *= 0.995;
      p.rot += p.vr * dt;
    }
    this.particles = this.particles.filter((p) => p.life < p.maxLife);

    for (const n of this.notes) {
      n.life += dt;
      n.x += Math.sin(n.life * 2 + n.seed) * 12 * dt;
      n.y -= 46 * dt;
    }
    this.notes = this.notes.filter((n) => n.life < n.maxLife);

    if (this.mode === 'singing' && now - this._lastNoteAt > 620) {
      this._lastNoteAt = now;
      this.notes.push({
        x: (Math.random() - 0.5) * 90,
        y: 0,
        life: 0,
        maxLife: 2.6,
        size: 14 + Math.random() * 8,
        seed: Math.random() * TAU,
      });
    }
  }

  // 待机时每隔几秒挑一个随机小动作，让形象自己「活」起来：
  // 张望、歪头、点头、哼歌动嘴、轻颤、连眨。说话/唱歌/思考时自动让位。
  _startIdleAction(now) {
    const pool = ['glance', 'glance', 'glance', 'tilt', 'nod', 'hum', 'sway', 'blink2'];
    const kind = pool[Math.floor(Math.random() * pool.length)];
    const dur = { glance: 1.8, tilt: 2.2, nod: 1.4, hum: 1.3, sway: 2.6, blink2: 0.45 }[kind];
    this.idleAction = {
      kind,
      t0: this.t,
      dur,
      dir: Math.random() < 0.5 ? -1 : 1,
      seed: Math.random() * TAU,
    };
    if (kind === 'blink2') {
      this.blinkT = 0;
      this.doubleBlink = true;
    }
  }

  _updateIdle(dt, now) {
    const target = this.idleTarget;
    const acting = this.bowEnv > 0.01 || this.sadEnv > 0.01;
    if (this.mode !== 'idle' || acting) {
      this.idleAction = null;
      this.doubleBlink = false;
      target.x = 0;
      target.y = 0;
      target.tilt = 0;
      this.idleNext = this.t + 1.4;
    } else {
      const a = this.idleAction;
      if (!a) {
        target.x = 0;
        target.y = 0;
        target.tilt = 0;
        if (this.t >= this.idleNext) this._startIdleAction(now);
      } else {
        const p = clamp((this.t - a.t0) / a.dur, 0, 1);
        const env = Math.sin(Math.PI * p);
        if (a.kind === 'glance') {
          target.x = a.dir * 3.8 * env;
          target.y = -1.1 * env;
          target.tilt = a.dir * 0.038 * env;
        } else if (a.kind === 'tilt') {
          target.x = a.dir * 1.5 * env;
          target.y = 0.8 * env;
          target.tilt = a.dir * 0.055 * env;
        } else if (a.kind === 'nod') {
          target.y = Math.sin(p * Math.PI * 4) * 3.0 * (1 - p);
          target.x = 0;
          target.tilt = Math.sin(p * Math.PI * 2) * 0.010 * (1 - p);
        } else if (a.kind === 'sway') {
          target.x = Math.sin(p * Math.PI * 2) * a.dir * 1.8 * env;
          target.y = 0.4 * env;
          target.tilt = Math.sin(p * Math.PI * 2) * a.dir * 0.014 * env;
        } else {
          target.x = 0;
          target.y = 0;
          target.tilt = 0;
        }
        this.idleMouth = a.kind === 'hum'
          ? 0.10 + 0.11 * env * (0.5 + 0.5 * Math.sin(this.t * 15 + a.seed))
          : 0;
        if (p >= 1) {
          this.idleAction = null;
          this.idleMouth = 0;
          this.idleNext = this.t + 2.2 + Math.random() * 3.8;
        }
      }
    }
    const k = 1 - Math.pow(0.0008, dt);
    this.idle.x += (target.x - this.idle.x) * k;
    this.idle.y += (target.y - this.idle.y) * k;
    this.idle.tilt += (target.tilt - this.idle.tilt) * k;
    if (this.mode !== 'idle') this.idleMouth *= Math.pow(0.002, dt);
  }

  // 尾摆与上身反作用共用一份相位，避免身体和尾巴各摆各的
  _tailSwing() {
    const liven = 1 + 0.55 * Math.min(1, Math.abs(this.idle.x) / 2.4 + Math.abs(this.idle.tilt) / 0.06);
    const ph = this.t * 1.15 * liven + 0.9;
    // 尾鳍外摆（源像素）：760 行以下只剩垂下的鲸尾与尾鳍，尾根是铰链
    const fin = this.tailAmp * Math.sin(ph);
    // 上身反作用：绕髋部倾斜，尾鳍往右甩时上半身往左让，略滞后于鳍
    const lean = -0.5 * this.tailAmp * Math.sin(ph - 0.22);
    const hipY = 600;
    // 剪切系数：x' = x + k*(hipY - y)，等价于绕髋的微小旋转
    const k = lean / Math.max(1, hipY - this.pivot[1]);
    return { fin, lean, hipY, k };
  }

  // 整张身体图都绕髋做剪切：髋部以上越往上位移越大、尾根以下继续外摆。
  // 尾摆位移在尾根处恰为 0，和剪切在同一条曲线上，所以没有横向接缝。
  _drawBody(ctx, swing) {
    const img = this.bodyImg;
    const H = img.height;
    const sw = this.sw;
    const t0 = Math.min(this.tailY || H, H);
    const { fin, hipY, k } = swing;
    const shear = (y) => k * (hipY - y);

    if (t0 > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, sw, t0);
      ctx.clip();
      ctx.transform(1, 0, -k, 1, k * hipY, 0);
      ctx.drawImage(img, 0, 0, sw, t0, 0, 0, sw, t0);
      ctx.restore();
    }

    const span = H - t0;
    if (span <= 0) return;
    // 尾段：剪切位移（尾根处接上上身）+ 尾根 0 起坡、尾尖最大的摆幅
    const bands = 48;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, t0, sw, span);
    ctx.clip();
    for (let i = 0; i < bands; i += 1) {
      const y0 = t0 + Math.round((span * i) / bands);
      const y1 = t0 + Math.round((span * (i + 1)) / bands);
      if (y1 <= y0) continue;
      const kk = (y0 + y1) * 0.5 - t0;
      const dx = shear(t0) + fin * (kk / span) * (kk / span);
      ctx.drawImage(img, 0, y0, sw, y1 - y0, dx, y0, sw, y1 - y0);
    }
    ctx.restore();
  }

  draw(now) {
    const { ctx, w, h } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    this._drawBackground(ctx, w, h);
    this._drawBubbles(ctx, w, h);

    // 弹跳必须是有界的地面起跳：旧公式 sin(x)*x*16 会冲到 ±100px，
    // 把整只角色顶出画面（看起来像动作穿模/瞬移）
    const bounce = this._hop(now);
    const s = Math.min((h * 0.92) / this.sh, (w * 0.52) / this.sw);
    const cw = this.sw * s;
    const ch = this.sh * s;
    const cx = w * 0.5;
    const baseY = h * 0.99 - bounce;

    this._drawGlow(ctx, cx, baseY - ch * 0.55, Math.max(cw, ch * 0.4));

    const breath = Math.sin(this.t * 1.45);
    const breathX = 1 + 0.0025 * breath;
    const breathY = 1 + 0.004 * breath;
    // 摇头：先大后小地衰减，身体反向轻带一点，脖子才不会像被甩脱
    const sadP = this.sadDur ? clamp((now - this.sadT0) / this.sadDur, 0, 1) : 1;
    // 摇头只占前 1.15s：正弦包络快速起、末尾归零，之后停在无奈表情上
    const shakeP = this.sadT0 ? clamp((now - this.sadT0) / 1150, 0, 1) : 1;
    const shakeGate = this.sadT0
      ? Math.pow(Math.sin(Math.PI * shakeP), 0.65) * (1 - 0.45 * shakeP)
      : 0;
    const sadWave = Math.sin(this.sadPhase) * this.sadEnv * this.sadShakeAmp * (1 - 0.5 * sadP) * shakeGate;
    const sway = Math.sin(this.t * 0.62) * 0.010 + Math.sin(this.t * 0.23 + 1.1) * 0.004
      - sadWave * 0.004;
    // 起跳时轻微拉伸、落地回弹，让弹跳有重量感
    const hopE = this.bounceAmp ? clamp(bounce / this.bounceAmp, 0, 1) : 0;
    const hopStretch = 1 + 0.035 * hopE;

    ctx.save();
    ctx.translate(cx, baseY);
    ctx.rotate(sway);
    ctx.scale(breathX * (1 - 0.025 * hopE), breathY * hopStretch);
    if (this.bowEnv > 0.001 || this.bowEnv < -0.001) {
      ctx.translate(0, this.bowEnv * 10);
      ctx.scale(1 + this.bowEnv * 0.010, 1 - this.bowEnv * 0.035);
    }
    ctx.translate(-cw / 2, -ch);
    ctx.scale(s, s);

    const swing = this._tailSwing();
    this._drawBody(ctx, swing);

    const [px, py] = this.pivot;
    let tilt = (Math.sin(this.t * 0.82 + 0.6) * 0.020 + this.idle.tilt) * (1 - 0.85 * this.sadEnv);
    if (this.thinkEnv > 0.001) tilt -= 0.052 * this.thinkEnv;
    if (this.singEnv > 0.001) tilt += Math.sin(this.t * 2.1) * 0.014 * this.singEnv;
    if (now < this.happyUntil && this.happyT0) {
      const hp = (now - this.happyT0) / 1000;
      const fade = clamp((this.happyUntil - now) / 1200, 0, 1);
      tilt += Math.sin(hp * TAU * 1.7) * 0.018 * fade;
    }
    const sadShake = Math.sin(this.sadPhase) * 0.036 * this.sadEnv * this.sadShakeAmp * (1 - 0.5 * sadP) * shakeGate;
    if (this.sadEnv > 0.001) tilt += sadShake + 0.012 * this.sadEnv;
    if (this.bowHead > 0.001) tilt += this.bowHead * 0.052;
    // 脖子跟一点上身的倾斜，但幅度只有一半，头仍然是「稳」的
    tilt += swing.k * 0.5;
    // 头绕颈根旋转，限幅避免发梢/下巴把脖子或衣服撕开
    tilt = clamp(tilt, -0.095, 0.095);
    const headBob = Math.sin(this.t * 1.45 + 0.9) * 1.6 + this.idle.y
      + this.bowHead * 40 + this.sadEnv * 1.4;
    const headPan = this.idle.x + sadWave * 0.8;
    // 难过时让原嘴淡出、只留画在干净皮肤上的小撇嘴，避免叠出“补丁嘴”
    const sadMouth = clamp((this.sadEnv - 0.3) / 0.4, 0, 1);

    ctx.save();
    // 头部只做刚体变换（绕颈根旋转 + 平移）：剪切会把脸拉斜，近看像橡皮
    // 上身倾了多少，颈根就平移多少，头跟着走才不会从脖子上脱落
    ctx.translate(px + headPan + swing.lean, py + headBob);
    ctx.rotate(tilt);
    ctx.translate(-px, -py);
    ctx.drawImage(this.headImg, 0, 0);

    // 闭眼贴片整像素、不透明地盖上去（半透明会透出虹膜，看着像穿模）
    if (this.blink > 0.5 || sadMouth > 0.5) {
      for (const side of ['left', 'right']) {
        const b = this.meta.eyes[side].box;
        ctx.drawImage(this.eyeImgs[side], b[0], b[1], b[2] - b[0], b[3] - b[1]);
      }
    }

    const [mx0, my0, mx1, my1] = this.mouthBox;
    const mw = mx1 - mx0 + this.mouthPad * 2;
    const mh = my1 - my0 + this.mouthPad * 2;
    const bx = mx0 - this.mouthPad;
    const by = my0 - this.mouthPad;
    ctx.globalAlpha = 1 - sadMouth;
    ctx.drawImage(this.mouthClosedImg, bx, by, mw, mh);
    ctx.globalAlpha = 1;
    // 底图自带张嘴，闭嘴贴片是它的遮罩；难过时不淡出（会露出底图），而是把贴片上下翻转 → 同画风的撇嘴
    if (sadMouth > 0.001) {
      ctx.save();
      ctx.translate(bx, by + mh);
      ctx.scale(1, -1);
      ctx.globalAlpha = sadMouth;
      ctx.drawImage(this.mouthClosedImg, 0, 0, mw, mh);
      ctx.restore();
    }
    const mouthOpen = Math.max(this.mouth, this.idleMouth);
    if (mouthOpen > 0.03 && sadMouth < 0.5) {
      const [ix0, iy0, ix1, iy1] = this.mouthInner;
      const midX = (ix0 + ix1) / 2;
      // drop the jaw from the upper lip; the extra skin below the lip is
      // cropped off so a full stretch never reaches the collar bow
      const srcH = Math.min(mh, iy1 + 2);
      const scaleY = 0.82 + this.mouthStretch * mouthOpen;
      const k = mouthOpen * mouthOpen * (3 - 2 * mouthOpen);
      const dw = mw * (1 + 0.06 * mouthOpen);
      const dx = bx - (dw - mw) / 2;
      const dy = by + iy0 * (1 - scaleY);
      // 裁剪到嘴部补丁内：张嘴再大也不会压到下巴/领结
      ctx.save();
      ctx.beginPath();
      ctx.rect(bx, by, mw, mh);
      ctx.clip();
      ctx.globalAlpha = k;
      ctx.drawImage(this.mouthOpenImg, 0, 0, mw, srcH, dx, dy, dw, srcH * scaleY);
      ctx.restore();
    }
    if (this.sadEnv > 0.02) this._drawSadFace(ctx, this.sadEnv, now, mouthOpen > 0.05);
    ctx.restore();
    ctx.restore();

    this._drawNotes(ctx, cx, baseY - ch * 0.86);
    this._drawParticles(ctx, cx, baseY - ch * 0.55);
    if (this.mode === 'thinking') this._drawThinking(ctx, cx + cw * 0.34, baseY - ch * 0.93);
  }

  // 无奈表情：闭眼（由 draw 里的闭眼贴片负责）+ 嘴角下压 + 太阳穴汗滴
  _drawSadFace(ctx, k, now, talking) {
    const t = (now - this.sadT0) / 1000;

    if (!talking) {
      const [mx0, my0, mx1, my1] = this.mouthBox;
      const cx = (mx0 + mx1) / 2;
      const cy = (my0 + my1) / 2 + 1;
      ctx.save();
      ctx.globalAlpha = Math.min(1, k * 0.55);
      ctx.strokeStyle = 'rgba(146, 78, 92, 0.75)';
      ctx.lineWidth = 1.3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx - 4.2, cy + 1.4);
      ctx.quadraticCurveTo(cx, cy - 1.4, cx + 4.2, cy + 2.2);
      ctx.stroke();
      ctx.restore();
    }

    const dx = this.mouthBox[2] + 40;
    const dy = 140 + Math.min(7, t * 3.2) + Math.sin(t * 4) * 0.8;
    ctx.save();
    ctx.globalAlpha = Math.min(1, k * 1.05);
    const g = ctx.createLinearGradient(dx, dy - 8, dx, dy + 7);
    g.addColorStop(0, 'rgba(225, 246, 255, 0.95)');
    g.addColorStop(0.55, 'rgba(150, 212, 255, 0.9)');
    g.addColorStop(1, 'rgba(96, 168, 235, 0.85)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(dx, dy - 8);
    ctx.bezierCurveTo(dx + 5.5, dy - 1.5, dx + 5, dy + 5.5, dx, dy + 6.5);
    ctx.bezierCurveTo(dx - 5, dy + 5.5, dx - 5.5, dy - 1.5, dx, dy - 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.ellipse(dx - 1.6, dy + 1.5, 1.5, 2.4, -0.4, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  _drawBackground(ctx, w, h) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#0a3b57');
    g.addColorStop(0.45, '#062336');
    g.addColorStop(1, '#020a12');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    const glow = ctx.createRadialGradient(w / 2, h * 0.52, 40, w / 2, h * 0.52, Math.max(w, h) * 0.55);
    glow.addColorStop(0, withAlpha(this.palette.fin, 0.16));
    glow.addColorStop(0.45, withAlpha(this.palette.fin, 0.06));
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 3; i += 1) {
      const x = w * (0.16 + i * 0.34) + Math.sin(this.t * 0.25 + i) * 40;
      const width = 90 + i * 30;
      const grad = ctx.createLinearGradient(x, 0, x + 120, h * 0.85);
      grad.addColorStop(0, withAlpha(this.palette.fin, 0.1));
      grad.addColorStop(1, withAlpha(this.palette.fin, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + width, 0);
      ctx.lineTo(x + width * 2.1, h * 0.85);
      ctx.lineTo(x + width * 1.2, h * 0.85);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    const vignette = ctx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, Math.max(w, h) * 0.78);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);
  }

  _drawBubbles(ctx, w, h) {
    ctx.save();
    for (const b of this.bubbles) {
      const x = b.x * w + Math.sin(this.t * 0.7 + b.sway) * 14;
      const y = b.y * h;
      ctx.beginPath();
      ctx.arc(x, y, b.r, 0, TAU);
      ctx.strokeStyle = `rgba(160, 225, 255, ${b.alpha})`;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x - b.r * 0.3, y - b.r * 0.3, b.r * 0.22, 0, TAU);
      ctx.fillStyle = `rgba(220, 245, 255, ${b.alpha * 1.5})`;
      ctx.fill();
    }
    ctx.restore();
  }

  _drawGlow(ctx, cx, cy, r) {
    const g = ctx.createRadialGradient(cx, cy, 10, cx, cy, r * 0.9);
    g.addColorStop(0, withAlpha(this.palette.fin, 0.18));
    g.addColorStop(0.6, withAlpha(this.palette.fin, 0.05));
    g.addColorStop(1, withAlpha(this.palette.fin, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.9, 0, TAU);
    ctx.fill();
  }

  _drawNotes(ctx, cx, cy) {
    if (!this.notes.length) return;
    ctx.save();
    ctx.textAlign = 'center';
    for (const n of this.notes) {
      const k = 1 - n.life / n.maxLife;
      ctx.globalAlpha = clamp(k * 1.4, 0, 0.9);
      ctx.fillStyle = '#bfe8ff';
      ctx.font = `${n.size}px "Helvetica Neue", sans-serif`;
      ctx.fillText('♪', cx + n.x, cy + n.y);
    }
    ctx.restore();
  }

  _drawParticles(ctx, cx, cy) {
    if (!this.particles.length) return;
    ctx.save();
    for (const p of this.particles) {
      const k = 1 - p.life / p.maxLife;
      ctx.globalAlpha = clamp(k * 1.2, 0, 1);
      const x = cx + p.x;
      const y = cy + p.y;
      if (p.type === 'heart') {
        heartPath(ctx, x, y, p.size / 12, p.rot);
        ctx.fillStyle = p.color;
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, p.size, 0, TAU);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  _drawThinking(ctx, x, y) {
    ctx.save();
    ctx.fillStyle = 'rgba(235, 248, 255, 0.9)';
    for (let i = 0; i < 3; i += 1) {
      const a = 0.35 + 0.55 * (0.5 + 0.5 * Math.sin(this.t * 3.2 - i * 0.7));
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.arc(x + i * 13, y - (i === 2 ? 4 : 0), 3.2, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }
}
