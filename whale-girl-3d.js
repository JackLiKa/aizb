import * as THREE from 'three';
import { buildPalette, buildWhaleGirl, heartShape, refreshEyeTextures } from './whale-model.js';

const TAU = Math.PI * 2;

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function smoothstep(v) {
  const x = clamp(v, 0, 1);
  return x * x * (3 - 2 * x);
}

function radialTexture(inner, outer) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.55, outer);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeShadowTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(0.6, 'rgba(0,0,0,0.22)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

export class WhaleGirlRenderer3D {
  constructor(canvas, { fps = 30, palette = {} } = {}) {
    this.canvas = canvas;
    this.fps = fps;
    this.frameMs = 1000 / fps;
    this.lastFrame = 0;
    this.t = 0;
    this.mode = 'idle';
    this.thinkEnv = 0;
    this.singEnv = 0;
    this.speakEnv = 0;
    this.mouth = 0;
    this.mouthTarget = 0;
    this.happyUntil = 0;
    this.happyT0 = 0;
    this.happyEnv = 0;
    this.bounceUntil = 0;
    this.bounceStart = 0;
    this.bounceDur = 1400;
    this.bowT0 = 0;
    this.bowDur = 2400;
    this.bowEnv = 0;
    this.bowHead = 0;
    this.sadT0 = 0;
    this.sadDur = 4200;
    this.sadEnv = 0;
    this.sadPhase = 0;
    this.sadShakeAmp = 0;
    this.nextBlink = 2 + Math.random() * 3;
    this.blinkStart = -1;
    this.viewYaw = 0;
    this.running = false;
    this.raf = 0;
    this.hearts = [];
    this.paletteInput = palette;
    this.palette = buildPalette(palette);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 40);

    const built = buildWhaleGirl(palette);
    this.root = built.root;
    this.nodes = built.nodes;
    this.headY0 = this.nodes.head.position.y;
    this.headZ0 = this.nodes.head.position.z;
    this.mats = built.mats;
    this.scene.add(this.root);

    { // 无奈时太阳穴的汗滴，挂在头部节点里跟随头转动
      const dropMat = new THREE.MeshStandardMaterial({
        color: 0x9ad9ff,
        roughness: 0.15,
        metalness: 0.05,
        transparent: true,
        opacity: 0.9,
      });
      this.sadDrop = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 12), dropMat);
      this.sadDrop.scale.set(0.6, 1.35, 0.6);
      this.sadDrop.position.set(0.33, 0.18, 0.29);
      this.sadDrop.visible = false;
      this.nodes.head.add(this.sadDrop);
    }

    this._setupLights();
    this._setupBackdrop();
    this._setupShadow();
    this._setupBubbles();
    this._setupThoughts();

    this._heartGeo = new THREE.ExtrudeGeometry(heartShape(1), {
      depth: 0.16,
      bevelEnabled: true,
      bevelSize: 0.05,
      bevelThickness: 0.05,
      bevelSegments: 1,
      curveSegments: 10,
      steps: 1,
    });
    this._heartGeo.center();

    this.resize();
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this._onLost = (e) => {
      e.preventDefault();
      console.warn('[stage] WebGL 上下文丢失');
    };
    this.canvas.addEventListener('webglcontextlost', this._onLost, false);
  }

  _setupLights() {
    this.lights = {};
    const hemi = new THREE.HemisphereLight(0xfff4ec, 0xe9d4c9, 2.75);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(2.4, 3.6, 4.2);
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0xd8e6f7, 0.42);
    rim.position.set(-2.8, 2.4, -3.4);
    this.scene.add(rim);

    const fill = new THREE.DirectionalLight(0xffe6ee, 1.25);
    fill.position.set(-3.2, 1.4, 2.4);
    this.scene.add(fill);

    Object.assign(this.lights, { hemi, key, rim, fill });
  }

  _setupBackdrop() {
    const tex = radialTexture('rgba(255,255,255,0.85)', 'rgba(255,255,255,0.16)');
    this.backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 5.6),
      new THREE.MeshBasicMaterial({
        map: tex,
        color: this.palette.fin,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.backdrop.position.set(0, 1.5, -2.6);
    this.scene.add(this.backdrop);
  }

  _setupShadow() {
    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.7, 0.9),
      new THREE.MeshBasicMaterial({
        map: makeShadowTexture(),
        transparent: true,
        opacity: 0.62,
        depthWrite: false,
      }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.set(0, 0.002, 0.06);
    this.scene.add(this.shadow);
  }

  _setupBubbles() {
    const geo = new THREE.SphereGeometry(1, 12, 9);
    const mat = new THREE.MeshBasicMaterial({
      color: this.palette.finLight,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.bubbles = [];
    for (let i = 0; i < 16; i += 1) {
      const mesh = new THREE.Mesh(geo, mat);
      const r = 0.014 + Math.random() * 0.04;
      mesh.scale.setScalar(r);
      mesh.position.set(
        (Math.random() - 0.5) * 3.4,
        Math.random() * 2.4,
        -1.5 + Math.random() * 1.8,
      );
      this.scene.add(mesh);
      this.bubbles.push({
        mesh,
        r,
        speed: 0.045 + Math.random() * 0.09,
        phase: Math.random() * TAU,
      });
    }
    this._bubbleGeo = geo;
    this._bubbleMat = mat;
  }

  _setupThoughts() {
    this.thoughts = [];
    const specs = [
      [0.3, 2.22, 0.14, 0.032],
      [0.4, 2.34, 0.09, 0.045],
      [0.5, 2.44, 0.03, 0.06],
    ];
    for (const [x, y, z, r] of specs) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 9), mat);
      mesh.position.set(x, y, z);
      mesh.visible = false;
      this.root.add(mesh);
      this.thoughts.push({ mesh, mat, baseY: y, phase: Math.random() * TAU });
    }
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    const aspect = w / Math.max(1, h);
    this.camera.aspect = aspect;
    const dist = Math.max(5.0, 4.8 / Math.max(aspect, 0.55));
    this.camera.position.set(0, 1.34, dist);
    this.camera.lookAt(0, 1.16, 0);
    this.camera.updateProjectionMatrix();
  }

  setPalette(p) {
    if (!p) return;
    this.paletteInput = { ...this.paletteInput, ...p };
    const next = buildPalette(this.paletteInput);
    this.palette = next;
    const m = this.mats;
    m.hair.color.set(next.hair);
    m.hairShade.color.set(next.hairShade);
    m.hairDeep.color.set(next.hairDeep);
    m.skin.color.set(next.skin);
    m.skinShade.color.set(next.skinShade);
    m.fin.color.set(next.fin);
    m.finDeep.color.set(next.finDeep);
    m.finLight.color.set(next.finLight);
    m.cloth.color.set(next.cloth);
    m.clothShade.color.set(next.clothShade);
    m.blush.color.set(next.blush);
    m.iris.color.set(next.eye);
    m.irisDeep.color.set(next.eyeDeep);
    m.mouth.color.set(next.mouth);
    m.tongue.color.set(next.tongue);
    m.eyeWhite.color.set(next.white);
    if (this.backdrop) this.backdrop.material.color.set(next.fin);
    refreshEyeTextures(this.nodes, next);
    if (this._bubbleMat) this._bubbleMat.color.set(next.finLight);
  }

  setView(yaw) {
    this.viewYaw = yaw;
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
    this.bowHead = 0;
    this.sadT0 = 0;
    this.sadPhase = 0;
    this.sadShakeAmp = 0;
    this.happyT0 = now;
    this.happyUntil = now + 2600;
    this.bounceStart = now;
    this.bounceDur = 1400;
    this.bounceUntil = now + this.bounceDur;
    this._spawnHearts(14);
  }

  // 礼物：鞠躬（预备 → 低头 + 上身前倾 → 回弹，约 2.4s）
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
    this._spawnHearts(8);
  }

  // 点歌未找到：无奈闭眼 + 摇头
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

  _actionEnv(now, t0, dur, inFrac = 0.22, holdFrac = 0.58) {
    if (!t0) return 0;
    const p = (now - t0) / dur;
    if (p <= 0 || p >= 1) return 0;
    if (p < inFrac) return smoothstep(p / inFrac);
    if (p < holdFrac) return 1;
    return smoothstep((1 - p) / (1 - holdFrac));
  }

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

  _spawnHearts(count) {
    const colors = [0xff7a9c, 0xffd166, 0x6fd6ff, 0xffffff, 0x9fe0ff];
    for (let i = 0; i < count; i += 1) {
      const mat = new THREE.MeshBasicMaterial({
        color: colors[i % colors.length],
        transparent: true,
        opacity: 1,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(this._heartGeo, mat);
      mesh.scale.setScalar(0.06 + Math.random() * 0.07);
      mesh.position.set((Math.random() - 0.5) * 0.7, 1.75 + Math.random() * 0.5, 0.32 + Math.random() * 0.3);
      mesh.rotation.set(Math.random() * 0.5, Math.random() * TAU, Math.random() * 0.5);
      this.root.add(mesh);
      this.hearts.push({
        mesh,
        mat,
        vx: (Math.random() - 0.5) * 0.55,
        vy: 0.55 + Math.random() * 0.6,
        vz: (Math.random() - 0.5) * 0.25,
        spin: (Math.random() - 0.5) * 3.4,
        life: 0,
        maxLife: 1.5 + Math.random() * 0.8,
      });
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      if (now - this.lastFrame < this.frameMs) return;
      const dt = clamp((now - this.lastFrame) / 1000, 0.001, 0.1);
      this.lastFrame = now;
      this.t += dt;
      this.update(dt, now);
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  update(dt, now) {
    const t = this.t;
    const { nodes } = this;
    const happy = now < this.happyUntil;
    const singing = this.mode === 'singing';
    const thinking = this.mode === 'thinking';
    const speaking = this.mode === 'speaking';

    this.bowEnv = this._bowCurve(now);
    this.sadEnv = this._actionEnv(now, this.sadT0, this.sadDur, 0.12, 0.66);

    // 头部比身体晚半步跟上/收回；待机和笑眼同样做阻尼，避免整块硬切
    const bowTarget = Math.max(0, this.bowEnv);
    this.bowHead += (bowTarget - this.bowHead) * Math.min(1, dt * 9);
    this.happyEnv += ((happy ? 1 : 0) - this.happyEnv) * Math.min(1, dt * 5);
    this.thinkEnv += ((thinking ? 1 : 0) - this.thinkEnv) * Math.min(1, dt * 4);
    this.singEnv += ((singing ? 1 : 0) - this.singEnv) * Math.min(1, dt * 3);
    this.speakEnv += ((speaking ? 1 : 0) - this.speakEnv) * Math.min(1, dt * 6);
    if (this.sadEnv > 0.001) {
      this.sadPhase += dt * TAU * 2.15;
      this.sadShakeAmp += (1 - this.sadShakeAmp) * Math.min(1, dt * 3.2);
    } else {
      this.sadPhase = 0;
      this.sadShakeAmp += (0 - this.sadShakeAmp) * Math.min(1, dt * 4.5);
    }

    const k = 1 - Math.exp(-dt * 18);
    this.mouth += (this.mouthTarget - this.mouth) * k;
    nodes.mouthOpen.scale.y = clamp(0.38 + this.mouth * 0.62, 0.38, 1.02) * (1 - this.sadEnv * 0.3);
    nodes.mouthOpen.scale.x = 1 + this.mouth * 0.06 + this.sadEnv * 0.08;

    if (this.blinkStart < 0 && t > this.nextBlink) {
      this.blinkStart = t;
    }
    let blink = 1;
    if (this.blinkStart >= 0) {
      const p = (t - this.blinkStart) / 0.13;
      if (p >= 1) {
        this.blinkStart = -1;
        this.nextBlink = t + 2.4 + Math.random() * 4;
      } else {
        blink = Math.max(0.06, Math.abs(Math.cos(p * Math.PI)));
      }
    }
    if (happy) blink = Math.min(blink, 1 - this.happyEnv * 0.88);
    if (this.sadEnv > 0.05) blink = Math.min(blink, 0.2);
    nodes.eyeL.scale.y = blink;
    nodes.eyeR.scale.y = blink;

    nodes.body.scale.set(
      1 + Math.sin(t * 1.35) * 0.005,
      1 + Math.sin(t * 1.35) * 0.012,
      1 + Math.sin(t * 1.35) * 0.005,
    );

    let jump = 0;
    if (this.bounceStart && now < this.bounceUntil) {
      const p = clamp((now - this.bounceStart) / this.bounceDur, 0, 1);
      jump = Math.sin(p * Math.PI) * 0.14;
    }
    this.root.position.y = Math.sin(t * 1.2) * 0.014 + jump - this.bowEnv * 0.035;
    this.root.rotation.y = this.viewYaw + Math.sin(t * 0.4) * 0.03;
    if (nodes.body) nodes.body.rotation.x = this.bowEnv * 0.12 - this.sadEnv * 0.03;

    // 摇头只在前 1.15s：包络快起慢收，之后保持无奈表情而不是一直摆
    const shakeP = this.sadT0 ? clamp((now - this.sadT0) / 1150, 0, 1) : 1;
    const shakeGate = this.sadT0 ? Math.pow(Math.sin(Math.PI * shakeP), 0.65) * (1 - 0.45 * shakeP) : 0;
    const sadK = this.sadEnv * this.sadShakeAmp * shakeGate;
    const sadShakeY = Math.sin(this.sadPhase) * 0.24 * sadK;
    nodes.head.rotation.x = Math.sin(t * 0.9) * 0.02 - 0.07 * this.thinkEnv + Math.sin(t * 3) * 0.008 * this.mouth
      + this.bowHead * 0.34 + (Math.sin(this.sadPhase - 0.5) * 0.022 + 0.02) * sadK;
    nodes.head.rotation.y = Math.sin(t * 0.55) * 0.04 + 0.09 * this.thinkEnv + sadShakeY;
    nodes.head.rotation.z = Math.sin(t * 0.7) * 0.015 + 0.1 * this.thinkEnv
      - this.sadEnv * 0.03 + Math.sin(this.sadPhase - 0.3) * 0.012 * sadK;
    nodes.head.position.y = this.headY0 - this.bowHead * 0.02;
    nodes.head.position.z = this.headZ0 + this.bowHead * 0.26;

    if (this.sadDrop) {
      const tSad = Math.max(0, (now - this.sadT0) / 1000);
      const dropAlpha = 0.9 * Math.min(1, this.sadEnv * 1.4);
      this.sadDrop.material.opacity = dropAlpha;
      this.sadDrop.visible = dropAlpha > 0.01;
      this.sadDrop.position.y = 0.18 - Math.min(0.07, tSad * 0.035) + Math.sin(tSad * 5) * 0.004;
    }

    nodes.sideLockL.rotation.z = nodes.sideLockL.userData.rest.rot.z + Math.sin(t * 1.1) * 0.035;
    nodes.sideLockL.rotation.x = nodes.sideLockL.userData.rest.rot.x + Math.sin(t * 0.9) * 0.03;
    nodes.sideLockR.rotation.z = nodes.sideLockR.userData.rest.rot.z + Math.sin(t * 1.1 + 0.4) * 0.035;
    nodes.sideLockR.rotation.x = nodes.sideLockR.userData.rest.rot.x + Math.sin(t * 0.9 + 0.4) * 0.03;

    nodes.ahoge.rotation.z = nodes.ahoge.userData.rest.rot.z + Math.sin(t * 2.1) * 0.12;
    nodes.ahoge.rotation.x = nodes.ahoge.userData.rest.rot.x + Math.sin(t * 1.7) * 0.06;

    if (nodes.tail) {
      nodes.tail.rotation.z = nodes.tail.userData.rest.rot.z + Math.sin(t * 0.8) * 0.05;
      nodes.tail.rotation.y = Math.sin(t * 0.62) * 0.09;
    }
    if (nodes.finL && nodes.finR) {
      const twitch = Math.sin(t * 2.4) * 0.045 + this.speakEnv * Math.sin(t * 5.4) * 0.02;
      nodes.finL.rotation.z = nodes.finL.userData.rest.rot.z + twitch;
      nodes.finR.rotation.z = nodes.finR.userData.rest.rot.z - twitch;
    }
    if (nodes.hairBack) {
      nodes.hairBack.rotation.z = Math.sin(t * 0.75) * 0.012;
      nodes.hairBack.rotation.x = Math.sin(t * 0.55) * 0.008;
    }

    const lift = this.singEnv * 0.55 + this.happyEnv * 0.95;
    nodes.armL.rotation.z = nodes.armL.userData.rest.rot.z + Math.sin(t * 1.2) * 0.04 - lift;
    nodes.armR.rotation.z = nodes.armR.userData.rest.rot.z - Math.sin(t * 1.2) * 0.04 + lift;
    nodes.armL.rotation.x = Math.sin(t * 1.05) * 0.04 + this.bowEnv * 0.10;
    nodes.armR.rotation.x = -Math.sin(t * 1.05) * 0.04 + this.bowEnv * 0.10;

    for (const item of this.thoughts) {
      const target = thinking ? 0.7 : 0;
      item.mat.opacity += (target - item.mat.opacity) * Math.min(1, dt * 6);
      item.mesh.visible = item.mat.opacity > 0.01;
      item.mesh.position.y = item.baseY + Math.sin(t * 2 + item.phase) * 0.025;
    }

    for (const b of this.bubbles) {
      b.mesh.position.y += b.speed * dt;
      b.mesh.position.x += Math.sin(t * 0.7 + b.phase) * 0.0009;
      if (b.mesh.position.y > 2.95) {
        b.mesh.position.y = -0.15;
        b.mesh.position.x = (Math.random() - 0.5) * 3.4;
        b.mesh.position.z = -1.5 + Math.random() * 1.8;
      }
    }

    for (let i = this.hearts.length - 1; i >= 0; i -= 1) {
      const h = this.hearts[i];
      h.life += dt;
      h.mesh.position.x += h.vx * dt;
      h.mesh.position.y += h.vy * dt;
      h.mesh.position.z += h.vz * dt;
      h.mesh.rotation.y += h.spin * dt;
      h.mat.opacity = clamp(1 - h.life / h.maxLife, 0, 1);
      h.mesh.scale.multiplyScalar(1 + dt * 0.35);
      if (h.life >= h.maxLife) {
        this.root.remove(h.mesh);
        h.mat.dispose();
        this.hearts.splice(i, 1);
      }
    }
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    this.canvas.removeEventListener('webglcontextlost', this._onLost);
    for (const h of this.hearts) {
      this.root.remove(h.mesh);
      h.mat.dispose();
    }
    this.hearts = [];
    this._heartGeo.dispose();
    this._bubbleGeo.dispose();
    this._bubbleMat.dispose();
    this.scene.traverse((obj) => {
      if (obj.isMesh) {
        obj.geometry?.dispose();
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material?.dispose();
      }
    });
    this.renderer.dispose();
  }
}
