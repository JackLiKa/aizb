// 分层 2D 渲染器：用设定图拆出的头/身/眼/嘴图层驱动眨眼、口型、呼吸和摇摆。
// 与 whale-girl.js 的程序化画法不同，这里保留原画像素，只叠加局部动画。

const TAU = Math.PI * 2;
const ASSET = './assets/avatar/';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

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
    this.bounceUntil = 0;
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
    this.happyUntil = performance.now() + 2600;
    this.bounceUntil = performance.now() + 1400;
    this._spawnBurst(36);
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
    const pool = ['glance', 'glance', 'glance', 'tilt', 'nod', 'hum', 'shiver', 'blink2'];
    const kind = pool[Math.floor(Math.random() * pool.length)];
    const dur = { glance: 1.6, tilt: 2.0, nod: 1.1, hum: 1.2, shiver: 0.8, blink2: 0.45 }[kind];
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
    if (kind === 'shiver') this.bounceUntil = Math.max(this.bounceUntil, now + 620);
  }

  _updateIdle(dt, now) {
    const target = this.idleTarget;
    if (this.mode !== 'idle') {
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
          target.x = a.dir * 2.4 * env;
          target.y = -0.8 * env;
          target.tilt = a.dir * 0.030 * env;
        } else if (a.kind === 'tilt') {
          target.x = a.dir * 1.0 * env;
          target.y = 0.6 * env;
          target.tilt = a.dir * 0.062 * env;
        } else if (a.kind === 'nod') {
          target.y = Math.sin(p * Math.PI * 4) * 3.2 * (1 - p);
          target.x = 0;
          target.tilt = Math.sin(p * Math.PI * 2) * 0.012 * (1 - p);
        } else if (a.kind === 'shiver') {
          target.x = Math.sin(this.t * 36) * 1.8 * (1 - p);
          target.y = 0;
          target.tilt = Math.sin(this.t * 29 + a.seed) * 0.014 * (1 - p);
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

  // 尾巴和裙摆烘焙在同一张身体图里，没法单独成层：尾根以下整段绕尾根
  // 做一次旋转，尾鳍横移量最大约 tailAmp 像素，接缝处位移为 0。
  _drawBody(ctx) {
    const img = this.bodyImg;
    const H = img.height;
    const t0 = this.tailAmp && this.tailY > 0 ? Math.min(this.tailY, H) : H;
    // 先按原样画整块身体：旋转后的尾巴在接缝附近有 2~3px 覆盖不到，
    // 由这层兜住，避免背景从缝里透出来
    ctx.drawImage(img, 0, 0);
    if (t0 >= H) return;
    const span = H - t0;
    const liven = 1 + 0.55 * Math.min(1, Math.abs(this.idle.x) / 2.4 + Math.abs(this.idle.tilt) / 0.06);
    const ang = (this.tailAmp / span) * Math.sin(this.t * 1.15 * liven + 0.9);
    ctx.save();
    // 整段旋转时尾巴左上角会翘到接缝之上，用水平裁剪把接缝焊死
    ctx.beginPath();
    ctx.rect(0, t0, this.sw, span);
    ctx.clip();
    ctx.translate(this.tailPivot, t0);
    ctx.rotate(ang);
    ctx.drawImage(img, 0, t0, this.sw, span, -this.tailPivot, 0, this.sw, span);
    ctx.restore();
  }

  draw(now) {
    const { ctx, w, h } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    this._drawBackground(ctx, w, h);
    this._drawBubbles(ctx, w, h);

    const bounce = now < this.bounceUntil
      ? Math.sin((this.bounceUntil - now) / 130) * ((this.bounceUntil - now) / 130) * 16
      : 0;
    const s = Math.min((h * 0.92) / this.sh, (w * 0.52) / this.sw);
    const cw = this.sw * s;
    const ch = this.sh * s;
    const cx = w * 0.5;
    const baseY = h * 0.99 - bounce;

    this._drawGlow(ctx, cx, baseY - ch * 0.55, Math.max(cw, ch * 0.4));

    const breath = Math.sin(this.t * 1.45);
    const breathX = 1 + 0.0025 * breath;
    const breathY = 1 + 0.004 * breath;
    const sway = Math.sin(this.t * 0.62) * 0.010 + Math.sin(this.t * 0.23 + 1.1) * 0.004;

    ctx.save();
    ctx.translate(cx, baseY);
    ctx.rotate(sway);
    ctx.scale(breathX, breathY);
    ctx.translate(-cw / 2, -ch);
    ctx.scale(s, s);

    this._drawBody(ctx);

    const [px, py] = this.pivot;
    let tilt = Math.sin(this.t * 0.82 + 0.6) * 0.020 + this.idle.tilt;
    if (this.mode === 'thinking') tilt -= 0.052;
    if (this.mode === 'singing') tilt += Math.sin(this.t * 2.1) * 0.014;
    if (now < this.happyUntil) tilt += Math.sin((this.happyUntil - now) / 110) * 0.02;
    const headBob = Math.sin(this.t * 1.45 + 0.9) * 1.6 + this.idle.y;
    const headPan = this.idle.x;

    ctx.save();
    ctx.translate(px + headPan, py + headBob);
    ctx.rotate(tilt);
    ctx.translate(-px, -py);
    ctx.drawImage(this.headImg, 0, 0);

    if (this.blink > 0.01) {
      ctx.globalAlpha = this.blink;
      for (const side of ['left', 'right']) {
        const b = this.meta.eyes[side].box;
        ctx.drawImage(this.eyeImgs[side], b[0], b[1], b[2] - b[0], b[3] - b[1]);
      }
      ctx.globalAlpha = 1;
    }

    const [mx0, my0, mx1, my1] = this.mouthBox;
    const mw = mx1 - mx0 + this.mouthPad * 2;
    const mh = my1 - my0 + this.mouthPad * 2;
    const bx = mx0 - this.mouthPad;
    const by = my0 - this.mouthPad;
    ctx.drawImage(this.mouthClosedImg, bx, by, mw, mh);
    const mouthOpen = Math.max(this.mouth, this.idleMouth);
    if (mouthOpen > 0.03) {
      const [ix0, iy0, ix1, iy1] = this.mouthInner;
      const midX = (ix0 + ix1) / 2;
      // drop the jaw from the upper lip; the extra skin below the lip is
      // cropped off so a full stretch never reaches the collar bow
      const srcH = Math.min(mh, iy1 + 2);
      const scaleY = 0.82 + this.mouthStretch * mouthOpen;
      const k = mouthOpen * mouthOpen * (3 - 2 * mouthOpen);
      const dw = mw * (1 + 0.10 * mouthOpen);
      const dx = bx + midX - (midX * dw) / mw;
      const dy = by + iy0 * (1 - scaleY);
      ctx.globalAlpha = k;
      ctx.drawImage(this.mouthOpenImg, 0, 0, mw, srcH, dx, dy, dw, srcH * scaleY);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    ctx.restore();

    this._drawNotes(ctx, cx, baseY - ch * 0.86);
    this._drawParticles(ctx, cx, baseY - ch * 0.55);
    if (this.mode === 'thinking') this._drawThinking(ctx, cx + cw * 0.34, baseY - ch * 0.93);
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
