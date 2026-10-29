// 虚拟主播「肥鱼」的动作设计中枢。
//
// 这个模块只放**可复用的参数与物理曲线**，不接触 DOM / canvas / three.js，
// 让三层渲染器（分层 2D、程序化 3D、程序化 2D）共用同一套节奏，避免各画各的。
//
// 设计依据（详见 docs/动作设计.md）：
//   1. 呼吸节律：静息 12–16 次/分 → 周期 4.4s；吸气略快于呼气（0.42 : 0.58）。
//   2. 重心转移：骨盆先动 → 胸腔延迟反向代偿 → 头部再延迟，头部因此保持相对稳定。
//   3. 次级运动：尾巴/头发/头饰比躯干滞后 0.2–0.8rad，幅度按 0.3–0.6 衰减。
//   4. 动作语法：预备（anticipation）→ 主动作（ease in-out）→ 保持 → 回收（settle）。
//   5. 抗抖动：所有周期性连续量频率 ≤ 2Hz；眨眼是唯一的快速事件（闭合 ~60ms、张开 ~100ms）。
//
// 渲染器只允许读这里导出的常量与纯函数；不要在渲染器里再散落魔法数。

export const TAU = Math.PI * 2;

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const lerp = (a, b, t) => a + (b - a) * t;

// 0→1 的平滑过渡，两端一阶导为 0（无折角）
export const smoothstep = (x) => {
  const v = clamp(x, 0, 1);
  return v * v * (3 - 2 * v);
};

// 比 smoothstep 更「软」的一阶导为零过渡，用于大幅位移（张望、鞠躬下落）
export const smootherstep = (x) => {
  const v = clamp(x, 0, 1);
  return v * v * v * (v * (v * 6 - 15) + 10);
};

export const easeInOutSine = (x) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(x, 0, 1));

// 梯形包络：缓入 → 保持 → 缓出。两端速度为 0，用于待机小动作。
export function plateau(p, inFrac = 0.3, outFrac = 0.3) {
  if (p <= 0 || p >= 1) return 0;
  if (p < inFrac) return smootherstep(p / inFrac);
  if (p > 1 - outFrac) return smootherstep((1 - p) / outFrac);
  return 1;
}

// 0→1→0 的动作包络（缓入 / 保持 / 缓出），摇头、难过表情等使用
export function actionEnv(p, inFrac = 0.22, holdFrac = 0.58) {
  if (p <= 0 || p >= 1) return 0;
  if (p < inFrac) return smoothstep(p / inFrac);
  if (p < holdFrac) return 1;
  return smoothstep((1 - p) / (1 - holdFrac));
}

// 一阶平滑（稳定、无过冲）。rate 越大跟随越快，单位 1/s。
export function damp(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

// ── 全局限幅：头部倾斜是硬约束（发梢/下巴会撕开脖子）────────────────────
export const HEAD_TILT_LIMIT = 0.095;

export const clampTilt = (v) => clamp(v, -HEAD_TILT_LIMIT, HEAD_TILT_LIMIT);

// ── 参数总表 ──────────────────────────────────────────────────────────────
// 所有幅度单位：2D 分层渲染器里除注明外均为「源图 sprite 像素」（sprite 1034 高）。
export const MOTION = {
  breath: {
    period: 4.4,        // 秒；≈13.6 次/分
    inhaleFrac: 0.42,   // 吸气占周期比例（吸气稍快、呼气稍慢，更接近真人）
    chestX: 0.0022,     // 胸腔横向缩放增量（±）
    chestY: 0.0042,     // 胸腔纵向缩放增量（±）
    lift: 1.1,          // 呼吸带动整体上浮（sprite px，±）
    headLag: 0.55,      // 头部呼吸幅度（sprite px，±）
  },

  weight: {
    period: 9.6,        // 重心左右转移周期（≈0.104Hz），比呼吸慢一倍
    secondaryPeriod: 15.3, // 第二个更慢的分量，避免完全周期化
    pelvis: 2.4,        // 骨盆侧移（sprite px，±）
    chestGain: -0.42,   // 胸腔反向代偿（负号：骨盆往右，胸腔往左）
    headGain: 0.16,     // 头部残余位移（接近静止，符合「头稳」的人体工学）
    chestLag: 0.42,     // 胸腔滞后（rad 等价时移）
    headLag: 0.78,      // 头部再滞后
    headRoll: 0.0035,   // 头部随重心轻微滚转（rad）
  },

  blink: {
    duration: 0.16,     // 单次眨眼时长（秒）
    closeFrac: 0.4,     // 闭合占 40%（~64ms），张开 60%（~96ms）
    minGap: 2.2,        // 两次眨眼最小间隔（秒）
    maxGap: 6.8,        // 最大间隔；再配合随机早/晚，形成「不规律但自然」的节律
    earlyChance: 0.12,  // 偶尔提前眨（×0.55）
    longChance: 0.08,   // 偶尔走神晚眨（×1.45）
    doubleChance: 0.1,  // 连眨概率
    doubleGap: 0.24,    // 连眨第二下间隔
  },

  idle: {
    gapMin: 2.2,        // 两个待机小动作之间的间隔（秒）
    gapMax: 5.0,
    actions: {
      // 张望：带上身/头部反向预备（anticip），避免线性摆头
      glance: { dur: 2.0, x: 3.6, y: -1.0, tilt: 0.034, in: 0.3, out: 0.34, anticip: 0.18 },
      // 歪头：慢速、幅度稍大
      tilt: { dur: 2.4, x: 1.4, y: 0.7, tilt: 0.052, in: 0.32, out: 0.36 },
      // 点头：两次递减的小幅点头，最后收住
      nod: { dur: 1.6, x: 0.3, y: 2.8, tilt: 0.009, cycles: 2 },
      // 哼歌：只动嘴，幅度很小
      hum: { dur: 1.5, mouth: 0.11, freq: 8.5 },
      // 轻晃：比张望更慢更小
      sway: { dur: 2.8, x: 1.6, y: 0.4, tilt: 0.012 },
      blink2: { dur: 0.5 },
    },
  },

  head: {
    bobGain: 1.6,       // 头部呼吸 bob（sprite px）
    neckFollow: 0.5,    // 脖子跟随上身剪切的比例
    swayFreq: 0.82,     // 头部基础微晃频率（rad/s）
    swayAmp: 0.020,
  },

  posture2d: {
    hipY: 600,          // 绕髋剪切的铰链高度（sprite px，与 layers.json 的尾根一致）
    swayFreq: 0.62,     // 整体极慢摇摆
    swayAmp: 0.010,
    swayFreq2: 0.23,
    swayAmp2: 0.004,
    tailFreq: 1.15,     // 尾摆基频（rad/s ≈ 0.18Hz）
    tailLag: 0.22,      // 上身反作用滞后尾尖（rad）
    tailGain: -0.5,     // 上身反向位移 = gain × 尾尖位移
  },

  bow: {
    dur: 2400,          // 全长（ms）
    inEnd: 0.32,        // 下落结束
    holdEnd: 0.58,      // 保持结束
    anticipationFrac: 0.12, // 预备占下落段比例
    anticipation: 0.07, // 预备轻微起身（归一化幅度）
    overshoot: 0.03,    // 回收时的二次下沉（不是过冲，避免「砸下去」）
    sinkPx: 10,         // 整体下沉（canvas px）
    squash: 0.035,      // 竖向压缩上限（3.5%）
    stretchX: 0.010,    // 横向补偿（体积守恒的近似）
    headNod: 0.052,     // 头部额外前倾（rad）
    headBob: 40,        // 头部跟随下沉（sprite px，乘以 bowHead 0..1）
    headOmega: 11,      // 头部弹簧带宽（1/s）
    headZeta: 0.78,     // 头部弹簧阻尼比：轻微过冲后收住
    arm: 0.10,          // 3D 手臂跟随
    body3d: 0.12,       // 3D 上身前倾（rad）
    rootSink3d: 0.035,  // 3D 整体下沉（模型单位）
    tail: 0.30,         // 尾巴反向轻摆系数（× 尾尖摆幅）
  },

  shake: {
    dur: 4200,          // 难过表情总时长（ms）
    waveDur: 1150,      // 摇头只占前 1.15s（两下就停）
    freq: 1.7,          // 摇头频率（Hz）
    amp2d: 0.036,       // 2D 头部刚体滚转（rad，限幅内）
    pan2d: 0.8,         // 2D 头部平移（sprite px）
    body2d: 0.004,      // 躯干反向轻带（rad）
    headYaw3d: 0.24,    // 3D 头部 yaw（rad）
    headRoll3d: 0.012,  // 3D 头部 roll（rad）
    body3d: 0.03,       // 3D 上身反向（rad）
    breathDamp: 0.85,   // 摇头期间待机倾斜/摆动的衰减
  },

  hop: {
    dur: 1400,          // 弹跳全长（ms）
    crouchFrac: 0.16,   // 起跳下蹲
    airEnd: 0.78,       // 落地时刻
    amp2d: 16,          // 2D 分层：canvas px
    amp2dCanvas: 18,    // 程序化 2D：逻辑 px（其内部 scale 更大）
    amp3d: 0.14,        // 3D：模型单位
    stretch: 0.035,     // 速度拉伸
    landing: 0.05,      // 落地压缩
  },

  mouth: {
    omega: 16,          // 口型开合平滑带宽（1/s）
  },

  // 3D 渲染器的映射增益：把 2D 的 sprite 像素量换算成模型弧度/单位
  gains3d: {
    idleYaw: 0.013,     // idle.x(px) → head yaw(rad)
    idleBob: 0.0022,    // idle.y(px) → head y（模型单位）
    weightX: 0.0022,    // 骨盆 px → root.x
    weightRoll: 0.0024, // 胸腔 px → body.rotation.z
    headRoll: 0.0020,   // 头部 px → head.rotation.z
    breathY: 0.012,     // 呼吸 signed(-1..1) → body.scale.y 增量
    breathXZ: 0.005,
    baseBob: 0.014,     // 基础呼吸 bob（root.y）
  },
};

// ── 弹簧 / 阻尼跟随 ──────────────────────────────────────────────────────
// 解析解积分，任意 dt 都稳定（不会因掉帧炸开），用于头部跟随、动作回收。
export function springStep(state, target, omega, zeta, dt) {
  if (dt <= 0) return state;
  const w = Math.max(0.001, omega);
  const z = clamp(zeta, 0.0001, 0.9999);
  const e = state.x - target;

  if (z >= 0.999) {
    // 临界阻尼闭式解
    const decay = Math.exp(-w * dt);
    const c = state.v + w * e;
    state.x = target + (e + c * dt) * decay;
    state.v = (state.v - c * w * dt) * decay;
    return state;
  }

  const wd = w * Math.sqrt(1 - z * z);
  const decay = Math.exp(-z * w * dt);
  const cos = Math.cos(wd * dt);
  const sin = Math.sin(wd * dt);
  const a = e;
  const b = (state.v + z * w * e) / wd;
  state.x = target + decay * (a * cos + b * sin);
  state.v = decay * (-z * w * (a * cos + b * sin) + wd * (-a * sin + b * cos));
  return state;
}

// 一阶跟随器（延迟通道用；无过冲，适合胸腔/头部「延迟跟随」）
export class DampedFollower {
  constructor(omega = 6, value = 0) {
    this.omega = omega;
    this.x = value;
    this.v = 0;
  }

  step(target, dt) {
    if (dt <= 0) return this.x;
    const w = Math.max(0.001, this.omega);
    const e = this.x - target;
    const decay = Math.exp(-w * dt);
    const c = this.v + w * e;
    this.x = target + (e + c * dt) * decay;
    this.v = (this.v - c * w * dt) * decay;
    return this.x;
  }

  reset(value = 0) {
    this.x = value;
    this.v = 0;
    return this;
  }
}

// ── 呼吸 ─────────────────────────────────────────────────────────────────
// 输出 amount 0..1（0=呼气末，1=吸气末）与 signed -1..1。所有输出都已乘好幅度。
export function breathAt(t, out = {}) {
  const B = MOTION.breath;
  const span = B.period;
  const p = (((t % span) + span) % span) / span;
  const amount = p < B.inhaleFrac
    ? easeInOutSine(p / B.inhaleFrac)
    : easeInOutSine((1 - p) / (1 - B.inhaleFrac));
  const signed = amount * 2 - 1;
  out.amount = amount;
  out.signed = signed;
  out.chestX = B.chestX * signed;
  out.chestY = B.chestY * signed;
  out.lift = B.lift * signed;
  out.head = B.headLag * signed;
  return out;
}

// ── 重心转移 ─────────────────────────────────────────────────────────────
// 骨盆、胸腔、头部是「同一激励的不同延迟/增益」：胸腔反向代偿，头部位移最小。
export function weightAt(t, out = {}) {
  const W = MOTION.weight;
  const w1 = TAU / W.period;
  const w2 = TAU / W.secondaryPeriod;
  const a1 = Math.sin(w1 * t);
  const a2 = Math.sin(w2 * t + 1.2);
  out.pelvis = W.pelvis * (0.82 * a1 + 0.18 * a2);
  out.chest = W.pelvis * (0.82 * W.chestGain * Math.sin(w1 * t - W.chestLag)
    + 0.18 * W.chestGain * Math.sin(w2 * t + 1.2 - W.chestLag));
  out.head = W.pelvis * (0.82 * W.headGain * Math.sin(w1 * t - W.headLag)
    + 0.18 * W.headGain * Math.sin(w2 * t + 1.2 - W.headLag));
  out.roll = W.headRoll * Math.sin(w1 * t - W.headLag);
  return out;
}

// ── 眨眼 ─────────────────────────────────────────────────────────────────
// 闭合快、张开慢；0=睁开，1=完全闭合。
export function blinkCurve(p) {
  const x = clamp(p, 0, 1);
  const c = MOTION.blink.closeFrac;
  if (x < c) return smoothstep(x / c);
  return 1 - smoothstep((x - c) / (1 - c));
}

// 不规律但自然的眨眼节律：基础间隔偏斜分布 + 偶尔提前/走神 + 偶尔连眨。
export class BlinkScheduler {
  constructor(rng = Math.random) {
    this.rng = rng;
    this.closure = 0;
    this.phase = -1;
    this.timer = this._gap();
    this.doubleNext = false;
    this.enabled = true;
  }

  _gap() {
    const B = MOTION.blink;
    let gap = B.minGap + Math.pow(this.rng(), 0.85) * (B.maxGap - B.minGap);
    if (this.rng() < B.earlyChance) gap *= 0.55;
    else if (this.rng() < B.longChance) gap *= 1.45;
    return gap;
  }

  // 返回本次 update 后的闭眼程度 0..1
  update(dt) {
    if (!this.enabled) {
      this.closure = 0;
      this.phase = -1;
      return 0;
    }
    if (this.phase < 0) {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.phase = 0;
        this.doubleNext = this.rng() < MOTION.blink.doubleChance;
      }
    }
    if (this.phase >= 0) {
      this.phase += dt / MOTION.blink.duration;
      if (this.phase >= 1) {
        this.phase = -1;
        this.timer = this.doubleNext ? MOTION.blink.doubleGap : this._gap();
        this.doubleNext = false;
        this.closure = 0;
      } else {
        this.closure = blinkCurve(this.phase);
      }
    }
    return this.closure;
  }

  // 待机动作「连眨」：立即眨一下，结束后紧接第二下
  triggerDouble() {
    if (this.phase < 0) {
      this.phase = 0;
      this.doubleNext = true;
    }
  }
}

// ── 待机小动作 ───────────────────────────────────────────────────────────
export const IDLE_POOL = ['glance', 'glance', 'glance', 'tilt', 'nod', 'hum', 'sway', 'blink2'];

export function pickIdleAction(rng = Math.random) {
  return IDLE_POOL[Math.floor(rng() * IDLE_POOL.length)];
}

export function idleGap(rng = Math.random) {
  const I = MOTION.idle;
  return I.gapMin + rng() * (I.gapMax - I.gapMin);
}

// 返回待机动作的叠加量（全部为 0 附近的小量，直接加到 idle 目标上）
export function idlePose(kind, p, dir, t, seed, out = {}) {
  out.x = 0;
  out.y = 0;
  out.tilt = 0;
  out.mouth = 0;
  out.doubleBlink = false;
  if (!kind || p <= 0 || p >= 1) return out;
  const A = MOTION.idle.actions[kind];
  if (!A) return out;

  switch (kind) {
    case 'glance': {
      // 先向反方向「预备」一点，再缓入保持、缓出回正
      const anti = p < A.anticip ? Math.sin(Math.PI * (p / A.anticip)) : 0;
      const env = plateau(p, A.in, A.out);
      out.x = dir * A.x * (env - 0.16 * anti);
      out.y = A.y * env;
      out.tilt = dir * A.tilt * env;
      break;
    }
    case 'tilt': {
      const env = plateau(p, A.in, A.out);
      out.x = dir * A.x * env;
      out.y = A.y * env;
      out.tilt = dir * A.tilt * env;
      break;
    }
    case 'nod': {
      const cycles = A.cycles || 2;
      const decay = 1 - p;
      out.y = A.y * Math.sin(p * Math.PI * 2 * cycles) * decay;
      out.x = A.x * Math.sin(p * Math.PI * 2 * cycles + 0.6) * decay;
      out.tilt = A.tilt * Math.sin(p * Math.PI * 2 * cycles) * decay;
      break;
    }
    case 'hum': {
      const env = plateau(p, 0.22, 0.3);
      out.mouth = A.mouth * env * (0.5 + 0.5 * Math.sin(t * A.freq + seed));
      break;
    }
    case 'sway': {
      const env = plateau(p, 0.28, 0.32);
      const wave = Math.sin(p * TAU);
      out.x = dir * A.x * wave * env;
      out.y = A.y * env;
      out.tilt = dir * A.tilt * wave * env;
      break;
    }
    case 'blink2': {
      out.doubleBlink = true;
      break;
    }
    default:
      break;
  }
  return out;
}

// ── 鞠躬 ─────────────────────────────────────────────────────────────────
// 归一化曲线：预备(-) → 下落 → 保持（带微呼吸）→ 回收（先松一下再起身）。
export function bowCurve(p) {
  if (p <= 0 || p >= 1) return 0;
  const B = MOTION.bow;
  if (p < B.inEnd) {
    const x = p / B.inEnd;
    if (x < B.anticipationFrac) return -B.anticipation * smootherstep(x / B.anticipationFrac);
    const u = (x - B.anticipationFrac) / (1 - B.anticipationFrac);
    return -B.anticipation + (1 + B.anticipation) * smootherstep(u);
  }
  if (p < B.holdEnd) {
    const x = (p - B.inEnd) / (B.holdEnd - B.inEnd);
    // 保持段也有极小的呼吸起伏，两端为 0
    return 1 + 0.012 * Math.sin(x * TAU) * x * (1 - x) * 4;
  }
  const x = (p - B.holdEnd) / (1 - B.holdEnd);
  // 回弹前先「沉一点」再起身（真人收势），最后平滑归零
  return 1 - smoothstep(x) + B.overshoot * Math.sin(Math.PI * x) * (1 - x);
}

// 鞠躬派生量：下沉、体积补偿、头部额外前倾、尾巴反向轻摆、3D 手臂/上身角度
export function bowPose(p, out = {}) {
  const B = MOTION.bow;
  const bend = bowCurve(p);
  const down = Math.max(0, bend);
  out.bend = bend;
  out.sink = bend * B.sinkPx;
  out.scaleY = 1 - B.squash * down;
  out.scaleX = 1 + B.stretchX * down;
  out.headNod = bend * B.headNod;
  out.headBob = Math.max(0, bend) * B.headBob;
  out.tail = -B.tail * down;
  out.arm = bend * B.arm;
  out.body = bend * B.body3d;
  return out;
}

// ── 摇头（难过）──────────────────────────────────────────────────────────
// 只在前 1.15s 摆两下（正弦包络起、末尾归零），之后停在无奈表情上。
export function shakeGate(p) {
  if (p <= 0 || p >= 1) return 0;
  return Math.pow(Math.sin(Math.PI * p), 0.65) * (1 - 0.45 * p);
}

export function shakeEnvelope(p) {
  return actionEnv(p, 0.12, 0.66);
}

// ── 弹跳（庆祝）──────────────────────────────────────────────────────────
// 下蹲预备 → 抛物线腾空（重力正确、顶点最高）→ 落地压缩 → 阻尼收住。
export function hopPose(p, out = {}) {
  out.y = 0;
  out.scaleY = 1;
  out.scaleX = 1;
  if (p <= 0 || p >= 1) return out;
  const H = MOTION.hop;
  if (p < H.crouchFrac) {
    const e = smoothstep(p / H.crouchFrac);
    out.y = -0.08 * e;
    out.scaleY = 1 - 0.025 * e;
    out.scaleX = 1 + 0.015 * e;
    return out;
  }
  if (p < H.airEnd) {
    const u = (p - H.crouchFrac) / (H.airEnd - H.crouchFrac);
    out.y = 4 * u * (1 - u);
    const speed = Math.abs(1 - 2 * u);
    out.scaleY = 1 + H.stretch * speed;
    out.scaleX = 1 - 0.6 * H.stretch * speed;
    return out;
  }
  const u = (p - H.airEnd) / (1 - H.airEnd);
  const decay = Math.exp(-5 * u);
  const osc = Math.cos(u * Math.PI * 3);
  out.scaleY = 1 - H.landing * decay * osc;
  out.scaleX = 1 + 0.5 * H.landing * decay * osc;
  return out;
}

// 动作是否还在「进行中」（用于让待机小动作让位）
export function bowActive(p) {
  return p > 0 && p < 1;
}
