const TAU = Math.PI * 2;

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function smoothstep(v) {
  const x = clamp(v, 0, 1);
  return x * x * (3 - 2 * x);
}

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

function mix(a, b, t) {
  const A = parseHex(a);
  const B = parseHex(b);
  if (!A || !B) return a;
  const c = A.map((v, i) => Math.round(v + (B[i] - v) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function heartPath(ctx, x, y, size, rot) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(size, size);
  ctx.beginPath();
  ctx.moveTo(0, 0.36);
  ctx.bezierCurveTo(-0.62, -0.08, -0.56, -0.78, 0, -0.4);
  ctx.bezierCurveTo(0.56, -0.78, 0.62, -0.08, 0, 0.36);
  ctx.closePath();
  ctx.restore();
}

export class WhaleGirlRenderer {
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
    this.happyUntil = 0;
    this.happyT0 = 0;
    this.bounceUntil = 0;
    this.bounceStart = 0;
    this.bounceDur = 1400;
    this.bounceAmp = 18;
    this.bowT0 = 0;
    this.bowDur = 2400;
    this.bowEnv = 0;
    this.sadT0 = 0;
    this.sadDur = 4200;
    this.sadEnv = 0;
    this.sadPhase = 0;
    this.sadShakeAmp = 0;
    this.nextBlink = 2 + Math.random() * 3;
    this.blinkStart = -1;
    this.particles = [];
    this.bubbles = [];
    this.notes = [];
    this._lastParticleAt = 0;
    this.palette = this._buildPalette(palette);
    this.w = 1280;
    this.h = 720;
    this.dpr = 1;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this._seedBubbles();
  }

  _buildPalette(p) {
    const hair = p.hairColor || '#4f65ba';
    const fin = p.finColor || '#6f8fe0';
    const skin = p.skinColor || '#fdebdf';
    return {
      hair,
      hairShade: p.hairShadeColor || mix(hair, '#3a4a9b', 0.62),
      hairDeep: p.hairDeepColor || mix(hair, '#1a2250', 0.72),
      skin,
      skinShade: p.skinShadeColor || mix(skin, '#f2ac9b', 0.42),
      fin,
      finDeep: p.finDeepColor || mix(fin, '#26305f', 0.5),
      blush: p.blushColor || '#fdc5bd',
      eye: p.eyeColor || '#232c6f',
      cloth: p.clothColor || '#ffffff',
    };
  }

  setPalette(p) {
    if (!p) return;
    this.palette = this._buildPalette(p);
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
    if (mode === 'speaking') this.mouthTarget = 0.3;
  }

  setMouth(v) {
    this.mouthTarget = clamp(v, 0, 1);
  }

  celebrate() {
    const now = performance.now();
    this.bowT0 = 0;
    this.sadT0 = 0;
    this.sadPhase = 0;
    this.sadShakeAmp = 0;
    this.happyT0 = now;
    this.happyUntil = now + 2600;
    this.bounceStart = now;
    this.bounceDur = 1400;
    this.bounceAmp = 18;
    this.bounceUntil = now + this.bounceDur;
    this._spawnBurst(38);
  }

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

  shakeHead() {
    const now = performance.now();
    this.sadT0 = now;
    this.sadDur = 4200;
    this.sadPhase = 0;
    this.sadShakeAmp = 0;
    this.bowT0 = 0;
    this.happyUntil = 0;
    this.bounceStart = 0;
    this.bounceUntil = 0;
  }

  // 0→1→0 包络进出都用 smoothstep，避免线性折角
  _actionEnv(now, t0, dur, inFrac = 0.22, holdFrac = 0.58) {
    if (!t0) return 0;
    const p = (now - t0) / dur;
    if (p <= 0 || p >= 1) return 0;
    if (p < inFrac) return smoothstep(p / inFrac);
    if (p < holdFrac) return 1;
    return smoothstep((1 - p) / (1 - holdFrac));
  }

  // 鞠躬：预备 → 下压 → 停顿 → 回弹起身
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
      const type = Math.random() < 0.55 ? 'heart' : (Math.random() < 0.5 ? 'spark' : 'bubble');
      this.particles.push({
        x: (Math.random() - 0.5) * 260,
        y: (Math.random() - 0.5) * 60,
        vx: (Math.random() - 0.5) * 130,
        vy: -40 - Math.random() * 130,
        life: 0,
        maxLife: 1.3 + Math.random() * 1.1,
        size: type === 'heart' ? 10 + Math.random() * 10 : 2 + Math.random() * 3,
        rot: (Math.random() - 0.5) * 0.8,
        vr: (Math.random() - 0.5) * 2,
        color: colors[Math.floor(Math.random() * colors.length)],
        type,
      });
    }
    if (this.particles.length > 140) this.particles.splice(0, this.particles.length - 140);
  }

  update(dt, now) {
    this.bowEnv = this._bowCurve(now);
    this.sadEnv = this._actionEnv(now, this.sadT0, this.sadDur, 0.12, 0.66);
    if (this.sadEnv > 0.001) {
      this.sadPhase += dt * TAU * 2.1;
      this.sadShakeAmp += (1 - this.sadShakeAmp) * Math.min(1, dt * 3.2);
    } else {
      this.sadPhase = 0;
      this.sadShakeAmp += (0 - this.sadShakeAmp) * Math.min(1, dt * 4.5);
    }

    this.mouth += (this.mouthTarget - this.mouth) * Math.min(1, dt * 18);
    if (this.mode !== 'speaking') this.mouthTarget *= Math.pow(0.001, dt);

    for (const b of this.bubbles) {
      b.y -= b.speed * dt;
      if (b.y < -0.05) { b.y = 1.05; b.x = Math.random(); }
    }

    for (const p of this.particles) {
      p.life += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy -= 16 * dt;
      p.vx *= 0.995;
      p.rot += p.vr * dt;
    }
    this.particles = this.particles.filter((p) => p.life < p.maxLife);

    if (this.mode === 'singing') {
      if (now - this._lastParticleAt > 480) {
        this._lastParticleAt = now;
        this.notes.push({
          x: (Math.random() - 0.5) * 200,
          y: 0,
          life: 0,
          maxLife: 2.4,
          size: 12 + Math.random() * 10,
          rot: (Math.random() - 0.5) * 0.6,
        });
      }
    }
    for (const n of this.notes) { n.life += dt; n.y -= 46 * dt; n.rot += dt * 0.6; }
    this.notes = this.notes.filter((n) => n.life < n.maxLife);

    if (this.t > this.nextBlink && this.blinkStart < 0) {
      this.blinkStart = this.t;
    }
    if (this.blinkStart >= 0 && this.t - this.blinkStart > 0.13) {
      this.blinkStart = -1;
      this.nextBlink = this.t + 2.4 + Math.random() * 4;
    }
  }

  draw(now) {
    const { ctx, w, h } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    this._drawBackground(ctx, w, h);
    this._drawBubbles(ctx, w, h);

    const happy = now < this.happyUntil;
    const bounce = this._hop(now);

    const cx = w / 2;
    const cy = h * 0.5 - bounce;
    const scale = Math.min(w / 1280, h / 720) * 1.28;

    this._drawGlow(ctx, cx, cy, scale);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    const tilt = Math.sin(this.t * 0.8) * 0.014;
    const sadShake = Math.sin(this.sadPhase) * 0.07 * this.sadEnv * this.sadShakeAmp;
    const bob = Math.sin(this.t * 1.15) * 5 - bounce * 0.15 + this.bowEnv * 10 + this.sadEnv * 2;
    const hopE = this.bounceAmp ? clamp(bounce / this.bounceAmp, 0, 1) : 0;
    ctx.translate(0, bob);
    ctx.rotate(tilt + sadShake + this.bowEnv * 0.05);
    ctx.scale(1 - 0.02 * hopE + this.bowEnv * 0.012, (1 + 0.03 * hopE) * (1 - this.bowEnv * 0.055));
    this._drawTail(ctx);
    this._drawBackHair(ctx);
    this._drawBody(ctx);
    this._drawHead(ctx);
    this._drawEars(ctx);
    this._drawFace(ctx, happy, this.sadEnv);
    this._drawSideLocks(ctx);
    this._drawBangs(ctx);
    this._drawAhoge(ctx);
    ctx.restore();

    this._drawNotes(ctx, cx, cy, scale);
    this._drawParticles(ctx, cx, cy, scale);
  }

  _drawBackground(ctx, w, h) {
    const pal = this.palette;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#0a3b57');
    g.addColorStop(0.45, '#062336');
    g.addColorStop(1, '#020a12');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    const glow = ctx.createRadialGradient(w / 2, h * 0.52, 40, w / 2, h * 0.52, Math.max(w, h) * 0.55);
    glow.addColorStop(0, withAlpha(pal.fin, 0.16));
    glow.addColorStop(0.45, withAlpha(pal.fin, 0.06));
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 3; i += 1) {
      const x = w * (0.16 + i * 0.34) + Math.sin(this.t * 0.25 + i) * 40;
      const width = 90 + i * 30;
      const grad = ctx.createLinearGradient(x, 0, x + 120, h * 0.85);
      grad.addColorStop(0, withAlpha(pal.fin, 0.1));
      grad.addColorStop(1, withAlpha(pal.fin, 0));
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

  _drawGlow(ctx, cx, cy, scale) {
    const r = 320 * scale;
    const g = ctx.createRadialGradient(cx, cy - 40 * scale, 20, cx, cy, r);
    g.addColorStop(0, withAlpha(this.palette.fin, 0.15));
    g.addColorStop(0.6, withAlpha(this.palette.fin, 0.05));
    g.addColorStop(1, withAlpha(this.palette.fin, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fill();
  }

  _flukePath(ctx, size) {
    ctx.beginPath();
    ctx.moveTo(0, size * 0.34);
    ctx.bezierCurveTo(-size * 0.28, size * 0.06, -size * 0.62, -size * 0.16, -size * 0.86, -size * 0.04);
    ctx.bezierCurveTo(-size * 0.62, size * 0.22, -size * 0.26, size * 0.38, 0, size * 0.34);
    ctx.bezierCurveTo(size * 0.26, size * 0.38, size * 0.62, size * 0.22, size * 0.86, -size * 0.04);
    ctx.bezierCurveTo(size * 0.62, -size * 0.16, size * 0.28, size * 0.06, 0, size * 0.34);
    ctx.closePath();
  }

  _drawTail(ctx) {
    const pal = this.palette;
    const wag = Math.sin(this.t * 1.6) * 0.09 + (this.mode === 'singing' ? Math.sin(this.t * 3) * 0.05 : 0);
    ctx.save();
    ctx.translate(118, 238);
    ctx.rotate(-0.42 + wag);
    const g = ctx.createLinearGradient(0, 40, 0, -110);
    g.addColorStop(0, pal.finDeep);
    g.addColorStop(0.6, pal.fin);
    g.addColorStop(1, mix(pal.fin, '#ffffff', 0.4));
    ctx.beginPath();
    ctx.moveTo(-20, 34);
    ctx.bezierCurveTo(2, 6, 42, -44, 84, -88);
    ctx.quadraticCurveTo(98, -102, 92, -82);
    ctx.bezierCurveTo(64, -44, 34, 2, 20, 34);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.save();
    ctx.translate(88, -86);
    ctx.rotate(-0.7);
    this._flukePath(ctx, 42);
    ctx.fillStyle = mix(pal.fin, '#ffffff', 0.25);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();

    ctx.restore();
  }

  _drawBackHair(ctx) {
    const pal = this.palette;
    ctx.save();
    ctx.translate(0, -40);
    ctx.rotate(Math.sin(this.t * 0.9) * 0.012);
    const g = ctx.createLinearGradient(0, -220, 0, 250);
    g.addColorStop(0, pal.hair);
    g.addColorStop(0.45, pal.hairShade);
    g.addColorStop(1, pal.hairDeep);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, -212);
    ctx.bezierCurveTo(85, -212, 160, -160, 172, -70);
    ctx.bezierCurveTo(186, 20, 196, 110, 182, 178);
    ctx.bezierCurveTo(172, 226, 120, 252, 62, 255);
    ctx.quadraticCurveTo(0, 258, -62, 255);
    ctx.bezierCurveTo(-120, 252, -172, 226, -182, 178);
    ctx.bezierCurveTo(-196, 110, -186, 20, -172, -70);
    ctx.bezierCurveTo(-160, -160, -85, -212, 0, -212);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = withAlpha(pal.hairDeep, 0.3);
    ctx.lineWidth = 2;
    for (let i = 0; i < 3; i += 1) {
      ctx.beginPath();
      ctx.moveTo(-118 + i * 72, -168 + i * 8);
      ctx.bezierCurveTo(-138 + i * 72, 30, -148 + i * 82, 140, -112 + i * 86, 232);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawBody(ctx) {
    const pal = this.palette;

    ctx.beginPath();
    ctx.ellipse(0, 128, 128, 62, 0, 0, TAU);
    ctx.fillStyle = withAlpha(pal.fin, 0.35);
    ctx.fill();
    ctx.strokeStyle = withAlpha(pal.finDeep, 0.45);
    ctx.lineWidth = 2;
    ctx.stroke();

    const bodyGrad = ctx.createLinearGradient(0, 110, 0, 330);
    bodyGrad.addColorStop(0, '#ffffff');
    bodyGrad.addColorStop(0.55, pal.cloth);
    bodyGrad.addColorStop(1, mix(pal.cloth, pal.fin, 0.28));
    ctx.beginPath();
    ctx.moveTo(-198, 336);
    ctx.bezierCurveTo(-192, 220, -152, 148, -66, 124);
    ctx.quadraticCurveTo(0, 107, 66, 124);
    ctx.bezierCurveTo(152, 148, 192, 220, 198, 336);
    ctx.closePath();
    ctx.fillStyle = bodyGrad;
    ctx.fill();
    ctx.strokeStyle = withAlpha(pal.finDeep, 0.3);
    ctx.lineWidth = 2.5;
    ctx.stroke();

    for (const s of [-1, 1]) {
      ctx.save();
      ctx.scale(s, 1);
      ctx.beginPath();
      ctx.moveTo(-176, 158);
      ctx.bezierCurveTo(-212, 188, -208, 240, -172, 262);
      ctx.bezierCurveTo(-146, 278, -108, 276, -88, 258);
      ctx.bezierCurveTo(-108, 232, -118, 198, -118, 166);
      ctx.closePath();
      ctx.fillStyle = pal.cloth;
      ctx.fill();
      ctx.strokeStyle = withAlpha(pal.finDeep, 0.24);
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(-88, 258);
      ctx.bezierCurveTo(-104, 250, -112, 240, -114, 228);
      ctx.strokeStyle = withAlpha(pal.fin, 0.8);
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.restore();
    }

    for (const s of [-1, 1]) {
      ctx.save();
      ctx.scale(s, 1);
      ctx.beginPath();
      ctx.moveTo(-80, 116);
      ctx.quadraticCurveTo(-44, 150, 0, 180);
      ctx.lineTo(-102, 172);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = withAlpha(pal.fin, 0.9);
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
    }

    ctx.strokeStyle = withAlpha(pal.finDeep, 0.65);
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-6, 182);
    ctx.quadraticCurveTo(-12, 205, -8, 222);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(6, 182);
    ctx.quadraticCurveTo(12, 205, 8, 222);
    ctx.stroke();
    ctx.fillStyle = pal.fin;
    for (const x of [-8, 8]) {
      ctx.beginPath();
      ctx.arc(x, 226, 4, 0, TAU);
      ctx.fill();
    }

    ctx.save();
    ctx.translate(0, 214);
    ctx.rotate(0.1);
    this._flukePath(ctx, 22);
    ctx.fillStyle = withAlpha(pal.fin, 0.9);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    for (const [hx, rot] of [[-24, -0.16], [24, 0.16]]) {
      ctx.save();
      ctx.translate(hx, 258);
      ctx.rotate(rot);
      ctx.beginPath();
      ctx.ellipse(0, 0, 31, 25, 0, 0, TAU);
      ctx.fillStyle = pal.skin;
      ctx.fill();
      ctx.strokeStyle = withAlpha(pal.skinShade, 0.5);
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }
  }

  _drawHead(ctx) {
    const pal = this.palette;

    ctx.fillStyle = pal.skinShade;
    ctx.beginPath();
    ctx.moveTo(-30, 60);
    ctx.quadraticCurveTo(-34, 110, -24, 128);
    ctx.lineTo(24, 128);
    ctx.quadraticCurveTo(34, 110, 30, 60);
    ctx.closePath();
    ctx.fill();

    const face = ctx.createRadialGradient(-30, -110, 20, 0, -50, 175);
    face.addColorStop(0, '#fff7f0');
    face.addColorStop(0.55, pal.skin);
    face.addColorStop(1, mix(pal.skin, '#e6a288', 0.4));
    ctx.beginPath();
    ctx.ellipse(0, -55, 132, 140, 0, 0, TAU);
    ctx.fillStyle = face;
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, -55, 132, 140, 0, 0, TAU);
    ctx.clip();
    const chin = ctx.createLinearGradient(0, 40, 0, 90);
    chin.addColorStop(0, withAlpha(pal.skinShade, 0));
    chin.addColorStop(1, withAlpha(pal.skinShade, 0.5));
    ctx.fillStyle = chin;
    ctx.fillRect(-140, 30, 280, 110);
    ctx.restore();
  }

  _drawEars(ctx) {
    const pal = this.palette;
    for (const s of [-1, 1]) {
      ctx.save();
      ctx.translate(132 * s, -48);
      ctx.scale(-s, 1);
      ctx.rotate(-0.4 + Math.sin(this.t * 1.2) * 0.04);
      const g = ctx.createLinearGradient(0, 0, -90, -30);
      g.addColorStop(0, pal.fin);
      g.addColorStop(1, pal.finDeep);
      ctx.beginPath();
      ctx.moveTo(0, 6);
      ctx.bezierCurveTo(-16, -32, -58, -52, -86, -34);
      ctx.bezierCurveTo(-64, -8, -30, 8, 0, 6);
      ctx.closePath();
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 2;
      for (let i = 1; i <= 2; i += 1) {
        ctx.beginPath();
        ctx.moveTo(-6, -2);
        ctx.quadraticCurveTo(-40 + i * 8, -22 + i * 4, -70 + i * 10, -30 + i * 8);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  _drawFace(ctx, happy, sad = 0) {
    const pal = this.palette;

    for (const s of [-1, 1]) {
      const bx = 70 * s;
      const g = ctx.createRadialGradient(bx, -28, 2, bx, -28, 30);
      g.addColorStop(0, withAlpha(pal.blush, 0.55));
      g.addColorStop(1, withAlpha(pal.blush, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(bx, -28, 32, 18, 0, 0, TAU);
      ctx.fill();
    }

    ctx.strokeStyle = withAlpha(pal.hairDeep, 0.65);
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(60 * s, -100, 26, Math.PI * 1.12, Math.PI * 1.88);
      ctx.stroke();
    }

    this._drawEye(ctx, -60, happy, sad);
    this._drawEye(ctx, 60, happy, sad);

    ctx.strokeStyle = withAlpha(pal.skinShade, 0.85);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, -40, 4, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();

    this._drawMouth(ctx, sad);
    if (sad > 0.05) this._drawSadDrop(ctx, sad);
    if (this.mode === 'thinking') this._drawThinking(ctx);
  }

  _drawEye(ctx, x, happy, sad = 0) {
    const pal = this.palette;
    if (happy || sad > 0.05) {
      ctx.strokeStyle = '#2b3a52';
      ctx.lineWidth = sad > 0.05 ? 6 : 7;
      ctx.lineCap = 'round';
      ctx.beginPath();
      if (sad > 0.05) {
        // 无奈：眼皮下垂的闭眼弧，比开心时的弧更平、更低
        ctx.arc(x, -53, 20, Math.PI * 1.18, Math.PI * 1.82);
      } else {
        ctx.arc(x, -58, 22, Math.PI * 1.12, Math.PI * 1.88);
      }
      ctx.stroke();
      return;
    }

    const blink = this.blinkStart >= 0
      ? Math.max(0.06, Math.abs(Math.cos(((this.t - this.blinkStart) / 0.13) * Math.PI)))
      : 1;

    ctx.save();
    ctx.translate(x, -62);
    ctx.scale(1, blink);

    ctx.beginPath();
    ctx.ellipse(0, 0, 30, 33, 0, 0, TAU);
    ctx.fillStyle = '#fffdf9';
    ctx.fill();
    ctx.strokeStyle = withAlpha(pal.hairDeep, 0.25);
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, 0, 30, 33, 0, 0, TAU);
    ctx.clip();

    const lookX = this.mode === 'thinking' ? 5 : 0;
    const lookY = this.mode === 'thinking' ? -6 : 1;
    const iris = ctx.createRadialGradient(lookX - 6, lookY - 8, 2, lookX, lookY + 2, 26);
    iris.addColorStop(0, '#3a4382');
    iris.addColorStop(0.45, pal.eye);
    iris.addColorStop(1, '#141a4a');
    ctx.beginPath();
    ctx.arc(lookX, lookY, 22, 0, TAU);
    ctx.fillStyle = iris;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(lookX, lookY + 2, 10, 0, TAU);
    ctx.fillStyle = '#0d1030';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(lookX - 7, lookY - 9, 7, 0, TAU);
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(lookX + 8, lookY + 7, 3, 0, TAU);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(0, 0, 31, Math.PI * 1.02, Math.PI * 1.98);
    ctx.strokeStyle = '#1a1b2e';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.stroke();

    const s = Math.sign(x) || 1;
    for (let i = 0; i < 2; i += 1) {
      ctx.beginPath();
      ctx.moveTo(s * (24 + i * 5), -18 + i * 5);
      ctx.lineTo(s * (36 + i * 3), -26 + i * 6);
      ctx.strokeStyle = '#1a1b2e';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawSadDrop(ctx, k) {
    const x = 104;
    const y = -76 + Math.sin(this.t * 2.2) * 2;
    ctx.save();
    ctx.globalAlpha = Math.min(1, k * 1.2);
    const g = ctx.createLinearGradient(x, y - 8, x, y + 8);
    g.addColorStop(0, 'rgba(228, 247, 255, 0.95)');
    g.addColorStop(1, 'rgba(110, 185, 245, 0.85)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x, y - 8);
    ctx.bezierCurveTo(x + 6, y - 1, x + 5, y + 6, x, y + 7);
    ctx.bezierCurveTo(x - 5, y + 6, x - 6, y - 1, x, y - 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(x - 1.8, y + 1.5, 1.6, 2.6, -0.4, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  _drawMouth(ctx, sad = 0) {
    const open = this.mouth;
    ctx.save();
    ctx.translate(0, -14);

    if (open < 0.07) {
      const k = Math.min(1, sad);
      ctx.beginPath();
      ctx.moveTo(-11, -2);
      // k 越大嘴角越往下：开心弧 → 直线 → 下垂弧
      ctx.quadraticCurveTo(0, 10 * (1 - k) - 7 * k, 11, -2);
      ctx.strokeStyle = 'rgba(140, 87, 84, 0.95)';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.stroke();
    } else {
      const w = 10 + open * 9;
      const h = 3 + open * 19;
      ctx.beginPath();
      ctx.moveTo(-w, 0);
      ctx.quadraticCurveTo(-w, h, 0, h);
      ctx.quadraticCurveTo(w, h, w, 0);
      ctx.quadraticCurveTo(0, -4, -w, 0);
      ctx.closePath();
      ctx.fillStyle = '#8c5754';
      ctx.fill();
      ctx.strokeStyle = 'rgba(92, 52, 54, 0.7)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(-w, 0);
      ctx.quadraticCurveTo(-w, h, 0, h);
      ctx.quadraticCurveTo(w, h, w, 0);
      ctx.quadraticCurveTo(0, -4, -w, 0);
      ctx.closePath();
      ctx.clip();
      ctx.beginPath();
      ctx.ellipse(0, h * 0.75, w * 0.7, h * 0.5, 0, 0, TAU);
      ctx.fillStyle = 'rgba(242, 174, 178, 0.9)';
      ctx.fill();
      ctx.restore();
    }

    if (this.mode === 'speaking' && open > 0.35 && Math.random() < 0.14) {
      this.particles.push({
        x: (Math.random() - 0.5) * 20,
        y: -6,
        vx: (Math.random() - 0.5) * 18,
        vy: -18 - Math.random() * 18,
        life: 0,
        maxLife: 1.1,
        size: 1.6 + Math.random() * 2.4,
        rot: 0,
        vr: 0,
        color: withAlpha(this.palette.fin, 0.7),
        type: 'bubble',
      });
    }
    ctx.restore();
  }

  _drawSideLocks(ctx) {
    const pal = this.palette;
    for (const s of [-1, 1]) {
      ctx.save();
      ctx.translate(126 * s, -150);
      ctx.scale(s, 1);
      ctx.rotate(0.01 + Math.sin(this.t * 1.1 + s) * 0.02);
      const g = ctx.createLinearGradient(0, 0, 0, 340);
      g.addColorStop(0, pal.hair);
      g.addColorStop(0.6, pal.hairShade);
      g.addColorStop(1, pal.hair);
      ctx.beginPath();
      ctx.moveTo(-14, 0);
      ctx.bezierCurveTo(-38, 80, -46, 200, -34, 300);
      ctx.quadraticCurveTo(-32, 344, -8, 332);
      ctx.bezierCurveTo(2, 250, 10, 120, 20, 0);
      ctx.closePath();
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = withAlpha(pal.hairDeep, 0.35);
      ctx.lineWidth = 2.5;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(-26, 30);
      ctx.bezierCurveTo(-40, 110, -42, 210, -28, 292);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.restore();
    }
  }

  _drawBangs(ctx) {
    const pal = this.palette;
    const g = ctx.createLinearGradient(0, -220, 0, -90);
    g.addColorStop(0, pal.hair);
    g.addColorStop(0.7, mix(pal.hair, pal.hairShade, 0.7));
    g.addColorStop(1, pal.hairShade);
    ctx.beginPath();
    ctx.moveTo(-142, -94);
    ctx.bezierCurveTo(-148, -180, -92, -218, -16, -220);
    ctx.bezierCurveTo(66, -222, 126, -186, 142, -96);
    ctx.quadraticCurveTo(126, -114, 108, -120);
    ctx.bezierCurveTo(88, -150, 66, -152, 44, -126);
    ctx.quadraticCurveTo(28, -106, 8, -116);
    ctx.bezierCurveTo(-12, -148, -42, -150, -66, -122);
    ctx.quadraticCurveTo(-88, -102, -110, -118);
    ctx.quadraticCurveTo(-128, -124, -142, -94);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = withAlpha(pal.hairDeep, 0.28);
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.strokeStyle = withAlpha(pal.hairDeep, 0.22);
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(-70, -200);
    ctx.bezierCurveTo(-86, -166, -96, -140, -104, -120);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(10, -212);
    ctx.bezierCurveTo(6, -176, -2, -146, -8, -116);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(74, -196);
    ctx.bezierCurveTo(86, -166, 96, -140, 104, -122);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(-96, -170);
    ctx.bezierCurveTo(-64, -196, -24, -204, 16, -200);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.save();
    ctx.translate(104, -160);
    ctx.rotate(0.5);
    this._flukePath(ctx, 13);
    ctx.fillStyle = pal.fin;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  _drawAhoge(ctx) {
    const pal = this.palette;
    ctx.save();
    ctx.translate(8, -212);
    ctx.rotate(Math.sin(this.t * 2.1) * 0.05);
    ctx.beginPath();
    ctx.moveTo(-8, 6);
    ctx.bezierCurveTo(2, -22, 28, -44, 48, -34);
    ctx.bezierCurveTo(34, -40, 18, -22, 12, 6);
    ctx.closePath();
    ctx.fillStyle = mix(pal.hair, pal.hairShade, 0.5);
    ctx.fill();
    ctx.strokeStyle = withAlpha(pal.hairDeep, 0.3);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  _drawThinking(ctx) {
    const t = this.t * 2.4;
    for (let i = 0; i < 3; i += 1) {
      const a = 0.25 + 0.4 * (0.5 + 0.5 * Math.sin(t - i * 0.6));
      ctx.beginPath();
      ctx.arc(96 + i * 22, -226 - i * 14 + Math.sin(t + i) * 4, 5 + i * 2, 0, TAU);
      ctx.fillStyle = withAlpha(this.palette.fin, a);
      ctx.fill();
    }
  }

  _drawNotes(ctx, cx, cy, scale) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    for (const n of this.notes) {
      const p = n.life / n.maxLife;
      ctx.save();
      ctx.translate(140 + n.x, -110 + n.y);
      ctx.rotate(n.rot);
      ctx.globalAlpha = Math.max(0, 1 - p);
      ctx.fillStyle = '#bfe9ff';
      ctx.beginPath();
      ctx.ellipse(0, 0, n.size * 0.6, n.size * 0.42, -0.4, 0, TAU);
      ctx.fill();
      ctx.fillRect(n.size * 0.42, -n.size * 1.4, 2.4, n.size * 1.4);
      ctx.restore();
    }
    ctx.restore();
  }

  _drawParticles(ctx, cx, cy, scale) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    for (const p of this.particles) {
      const lifeP = p.life / p.maxLife;
      ctx.globalAlpha = clamp(1 - lifeP, 0, 1);
      if (p.type === 'heart') {
        heartPath(ctx, p.x, p.y, p.size / 12, p.rot);
        ctx.fillStyle = p.color;
        ctx.fill();
      } else if (p.type === 'spark') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 3);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, TAU);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}
