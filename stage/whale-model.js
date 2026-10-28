import * as THREE from 'three';

const TAU = Math.PI * 2;

function mixHex(a, b, t) {
  const pa = /^#?([0-9a-f]{6})$/i.exec(String(a || ''));
  const pb = /^#?([0-9a-f]{6})$/i.exec(String(b || ''));
  if (!pa || !pb) return a;
  const na = parseInt(pa[1], 16);
  const nb = parseInt(pb[1], 16);
  const ch = (n, s) => (n >> s) & 255;
  const out = [16, 8, 0].map((s) => Math.round(ch(na, s) + (ch(nb, s) - ch(na, s)) * t));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

export function buildPalette(input = {}) {
  const hair = input.hairColor || '#414d85';
  const fin = input.finColor || '#3a4a8c';
  const skin = input.skinColor || '#fdebdf';
  const cloth = input.clothColor || '#252738';
  return {
    hair,
    hairLight: input.hairLightColor || mixHex(hair, '#a9c4ff', 0.42),
    hairShade: input.hairShadeColor || mixHex(hair, '#2b3160', 0.65),
    hairDeep: input.hairDeepColor || mixHex(hair, '#1a2250', 0.72),
    skin,
    skinShade: input.skinShadeColor || mixHex(skin, '#f2ac9b', 0.3),
    fin,
    finDeep: input.finDeepColor || mixHex(fin, '#26305f', 0.5),
    finLight: mixHex(fin, '#ffffff', 0.4),
    blush: input.blushColor || '#fdc5bd',
    eye: input.eyeColor || '#3b5fc4',
    eyeDeep: '#1c2a6b',
    irisLight: '#7fa8f0',
    bow: '#8fb6ef',
    bowDeep: '#3f5aa8',
    gem: '#a8d8ff',
    cloth,
    clothShade: mixHex(cloth, '#0b1024', 0.3),
    clothLight: '#f7f9ff',
    lace: '#ffffff',
    gold: '#c8a35c',
    shoe: '#1e2342',
    pleat: '#e9e6f2',
    line: '#1a1b2e',
    mouth: '#8c5754',
    tongue: '#f2aeb2',
    white: '#fffdf9',
  };
}

function standard(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.68, metalness: 0, ...extra });
}

function makeMaterials(p) {
  return {
    hair: standard(p.hair, { roughness: 0.52 }),
    hairLight: standard(p.hairLight, { roughness: 0.38 }),
    hairShade: standard(p.hairShade, { roughness: 0.5 }),
    hairDeep: standard(p.hairDeep, { roughness: 0.55 }),
    skin: standard(p.skin, { roughness: 0.82, emissive: p.skin, emissiveIntensity: 0.3 }),
    skinShade: standard(p.skinShade, { roughness: 0.85 }),
    fin: standard(p.fin, { roughness: 0.42, side: THREE.DoubleSide }),
    finDeep: standard(p.finDeep, { roughness: 0.48 }),
    finLight: standard(p.finLight, { roughness: 0.4, side: THREE.DoubleSide }),
    cloth: standard(p.cloth, { roughness: 0.9 }),
    clothShade: standard(p.clothShade, { roughness: 0.92 }),
    clothLight: standard(p.clothLight, { roughness: 0.88 }),
    lace: standard(p.lace, { roughness: 0.85, side: THREE.DoubleSide }),
    laceDouble: standard(p.lace, { roughness: 0.85, side: THREE.DoubleSide }),
    gold: standard(p.gold, { roughness: 0.34, metalness: 0.55, side: THREE.DoubleSide }),
    shoe: standard(p.shoe, { roughness: 0.38, metalness: 0.08 }),
    pleat: standard(p.pleat, { roughness: 0.9 }),
    clothDouble: standard(p.cloth, { roughness: 0.9, side: THREE.DoubleSide }),
    bow: standard(p.bow, { roughness: 0.55 }),
    bowDeep: standard(p.bowDeep, { roughness: 0.55 }),
    gem: new THREE.MeshStandardMaterial({
      color: p.gem, roughness: 0.18, metalness: 0.15,
    }),
    blush: new THREE.MeshStandardMaterial({
      color: p.blush, transparent: true, opacity: 0.45, roughness: 0.9, depthWrite: false,
    }),
    blushHatch: new THREE.MeshStandardMaterial({
      color: '#f2a09a', transparent: true, opacity: 0.42, roughness: 0.9, depthWrite: false,
    }),
    eyeWhite: standard(p.white, { roughness: 0.32 }),
    iris: standard(p.eye, { roughness: 0.26 }),
    irisDeep: standard(p.eyeDeep, { roughness: 0.3 }),
    irisLight: standard(p.irisLight, { roughness: 0.3 }),
    pupil: new THREE.MeshBasicMaterial({ color: '#0d1030' }),
    eyeLight: new THREE.MeshBasicMaterial({ color: '#ffffff' }),
    line: standard(p.line, { roughness: 0.6 }),
    mouth: standard(p.mouth, { roughness: 0.55, emissive: p.mouth, emissiveIntensity: 0.3 }),
    tongue: standard(p.tongue, { roughness: 0.82 }),
  };
}

function ellipsoid(parent, radii, mat, pos, rot = null, name = '', seg = 24) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, seg, Math.max(12, Math.round(seg * 0.75))),
    mat,
  );
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.scale.set(radii[0], radii[1], radii[2]);
  if (rot) mesh.rotation.set(rot[0], rot[1], rot[2]);
  if (name) mesh.name = name;
  parent.add(mesh);
  return mesh;
}

function sphere(parent, radius, mat, pos, name = '', seg = 20) {
  return ellipsoid(parent, [radius, radius, radius], mat, pos, null, name, seg);
}

function heartShape(size = 1) {
  const s = new THREE.Shape();
  s.moveTo(0, 0.3 * size);
  s.bezierCurveTo(-0.55 * size, -0.12 * size, -0.45 * size, -0.75 * size, 0, -0.36 * size);
  s.bezierCurveTo(0.45 * size, -0.75 * size, 0.55 * size, -0.12 * size, 0, 0.3 * size);
  return s;
}

const FACE_R = [0.41, 0.53, 0.45];

function facePoint(x, y) {
  const z = Math.sqrt(Math.max(0, 1 - (x / FACE_R[0]) ** 2 - (y / FACE_R[1]) ** 2)) * FACE_R[2];
  return new THREE.Vector3(x, y, z);
}

function faceNormal(p) {
  return new THREE.Vector3(
    p.x / FACE_R[0] ** 2,
    p.y / FACE_R[1] ** 2,
    p.z / FACE_R[2] ** 2,
  ).normalize();
}

function faceDecal(parent, mat, opts) {
  const { x, y, rx, ry, rot = 0, rings = 8, sectors = 40, lift = 0.003 } = opts;
  const P = facePoint(x, y);
  const n = faceNormal(P);
  const t1 = new THREE.Vector3(0, 1, 0).cross(n).normalize();
  const t2 = n.clone().cross(t1).normalize();
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  const a1 = t1.clone().multiplyScalar(cs).addScaledVector(t2, sn);
  const a2 = t2.clone().multiplyScalar(cs).addScaledVector(t1, -sn);
  const c0 = P.clone().addScaledVector(n, lift);
  const verts = [c0.x - P.x, c0.y - P.y, c0.z - P.z];
  const uvs = [0.5, 0.5];
  for (let i = 1; i <= rings; i += 1) {
    const rr = i / rings;
    for (let j = 0; j < sectors; j += 1) {
      const th = (j / sectors) * TAU;
      const q = P.clone()
        .addScaledVector(a1, Math.cos(th) * rx * rr)
        .addScaledVector(a2, Math.sin(th) * ry * rr);
      const u = new THREE.Vector3(q.x / FACE_R[0], q.y / FACE_R[1], q.z / FACE_R[2]).normalize();
      const s = new THREE.Vector3(u.x * FACE_R[0], u.y * FACE_R[1], u.z * FACE_R[2]);
      s.addScaledVector(n, lift);
      verts.push(s.x - P.x, s.y - P.y, s.z - P.z);
      uvs.push(0.5 + 0.5 * Math.cos(th) * rr, 0.5 + 0.5 * Math.sin(th) * rr);
    }
  }
  const idx = [];
  for (let j = 0; j < sectors; j += 1) {
    idx.push(0, 1 + j, 1 + ((j + 1) % sectors));
  }
  for (let i = 1; i < rings; i += 1) {
    const base = 1 + (i - 1) * sectors;
    const next = base + sectors;
    for (let j = 0; j < sectors; j += 1) {
      const j1 = (j + 1) % sectors;
      idx.push(base + j, next + j, next + j1);
      idx.push(base + j, next + j1, base + j1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat);
  parent.add(mesh);
  return { mesh, center: P };
}

function eyeTexture(palette, side) {
  const S = 192;
  const data = new Uint8Array(S * S * 4);
  const c = (S - 1) / 2;
  const RX = S * 0.47;
  const RY = S * 0.47;
  const rgb = (hex) => {
    const v = parseInt(String(hex).replace('#', ''), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  };
  const top = rgb(palette.eyeDeep);
  const mid = rgb(palette.eye);
  const low = rgb(palette.irisLight);
  const pupil = rgb('#080c24');
  const lash = rgb('#161c40');
  const lashEdge = rgb('#2b3468');
  const sclera = [253, 251, 252];
  const scleraShade = [201, 213, 236];
  const lidLine = rgb('#5c6288');
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const outer = (u) => clamp(u * side);

  for (let y = 0; y < S; y += 1) {
    for (let x = 0; x < S; x += 1) {
      const u = (x - c) / RX;
      const v = (y - c) / RY;
      const i = (y * S + x) * 4;
      const vup = 0.97 - 0.34 * u * u + 0.12 * outer(u);
      const vlo = -0.90 + 0.30 * u * u + 0.04 * outer(u);
      const dUp = vup - v;
      const dLo = v - vlo;
      if (Math.abs(u) > 1 || dUp < 0 || dLo < 0) {
        data[i + 3] = 0;
        continue;
      }
      const edge = Math.min(dUp, dLo, (1 - Math.abs(u)) * 0.9) * RY;
      let col = mix([255, 255, 255], scleraShade, clamp(0.26 - v * 0.24));

      const ix = u / 0.58;
      const iy = (v + 0.02) / 0.78;
      const ir = ix * ix + iy * iy;
      if (ir < 1.02) {
        const g = clamp(0.5 - iy * 0.5);
        let ic = g > 0.58 ? mix(mid, top, (g - 0.58) * 2.3) : mix(mid, low, (0.58 - g) * 1.15);
        if (ir > 0.72) ic = mix(ic, mix(top, pupil, 0.3), clamp((ir - 0.72) / 0.28) * 0.6);
        const pu = (u / 0.3) ** 2 + ((v + 0.015) / 0.46) ** 2;
        if (pu < 1) ic = mix(ic, pupil, clamp(0.72 + (1 - pu) * 2.2));
        const h1 = ((u + 0.17) / 0.105) ** 2 + ((v - 0.32) / 0.125) ** 2;
        if (h1 < 1) ic = mix(ic, [255, 255, 255], clamp((1 - h1) * 5));
        const h2 = ((u - 0.14) / 0.045) ** 2 + ((v + 0.28) / 0.05) ** 2;
        if (h2 < 1) ic = mix(ic, [235, 245, 255], clamp((1 - h2) * 5));
        col = mix(col, ic, clamp((1.02 - ir) * 14));
      }

      const lashT = 0.1 + 0.26 * outer(u) + 0.045 * clamp(-u * side);
      if (dUp < lashT) col = mix(lash, lashEdge, clamp(dUp / lashT));
      if (dLo < 0.035) col = mix(col, lidLine, clamp((0.035 - dLo) / 0.035) * 0.85);

      data[i] = Math.round(col[0]);
      data[i + 1] = Math.round(col[1]);
      data[i + 2] = Math.round(col[2]);
      data[i + 3] = Math.round(clamp(edge * 1.6) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

function buildEye(parent, mats, side, palette) {
  const eye = new THREE.Group();
  eye.name = side < 0 ? 'EyeL' : 'EyeR';
  const mat = new THREE.MeshBasicMaterial({
    map: eyeTexture(palette, side),
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const { mesh, center } = faceDecal(eye, mat, {
    x: 0.147 * side, y: -0.17, rx: 0.127, ry: 0.106,
  });
  mesh.name = 'Iris';
  mesh.renderOrder = 2;
  eye.position.copy(center);
  eye.userData.side = side;
  parent.add(eye);
  return eye;
}

export function refreshEyeTextures(nodes, palette) {
  for (const eye of [nodes.eyeL, nodes.eyeR]) {
    if (!eye) continue;
    const mesh = eye.getObjectByName('Iris');
    if (!mesh) continue;
    if (mesh.material.map) mesh.material.map.dispose();
    mesh.material.map = eyeTexture(palette, eye.userData.side || 1);
    mesh.material.needsUpdate = true;
  }
}

function buildMouth(parent, mats) {
  const mouth = new THREE.Group();
  mouth.name = 'Mouth';
  mouth.position.set(0, -0.427, 0.298);
  mouth.rotation.x = -0.02;

  const open = new THREE.Group();
  open.name = 'MouthOpen';
  open.scale.y = 0.84;
  mouth.add(open);

  ellipsoid(open, [0.077, 0.064, 0.03], mats.mouth, [0, 0, 0], null, 'MouthCavity', 20);
  ellipsoid(open, [0.061, 0.042, 0.02], mats.eyeWhite, [0, 0.007, 0.024], null, 'MouthInner', 18);
  ellipsoid(open, [0.041, 0.02, 0.015], mats.tongue, [0, -0.029, 0.029], null, '', 14);

  parent.add(mouth);
  return { mouth, open };
}

function curvedLock(mats, side, opts) {
  const { x, y, z, top, bottom, len, name, bend = 0, curve = 0, wave = 0, flatten = 1 } = opts;
  const group = new THREE.Group();
  group.name = name;
  group.position.set(x * side, y, z);
  if (flatten !== 1) group.scale.z = flatten;

  const geo = new THREE.CylinderGeometry(top, bottom, len, 16, 20, false);
  geo.translate(0, -len / 2, 0);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i += 1) {
    const t = -pos.getY(i) / len;
    const wobble = Math.sin(t * Math.PI * 1.7) * wave * side;
    pos.setX(i, pos.getX(i) + bend * side * t * t + wobble);
    pos.setZ(i, pos.getZ(i) + curve * t * t);
  }
  geo.computeVertexNormals();

  const lock = new THREE.Mesh(geo, mats.hair);
  group.add(lock);

  const crown = new THREE.Mesh(new THREE.SphereGeometry(top * 1.01, 14, 10), mats.hair);
  crown.scale.set(1, 0.55, 0.9);
  group.add(crown);

  const tip = new THREE.Mesh(new THREE.ConeGeometry(bottom * 1.7, 0.18, 10), mats.hairShade);
  tip.rotation.x = Math.PI;
  tip.position.set(
    bend * side + Math.sin(Math.PI * 1.7) * wave * side,
    -len - 0.075,
    curve,
  );
  group.add(tip);

  return group;
}

function bangStrand(parent, mat, opts) {
  const { x, y, z, len, width, tilt = 0, lean = 0, sweep = 0, forward = 0, name = 'Bang' } = opts;
  const group = new THREE.Group();
  group.name = name;
  group.position.set(x, y, z);
  group.rotation.set(lean, 0, tilt);

  const geo = new THREE.CylinderGeometry(width, width * 0.46, len, 12, 10, false);
  geo.translate(0, -len / 2, 0);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i += 1) {
    const t = -pos.getY(i) / len;
    pos.setX(i, pos.getX(i) + sweep * t * t);
    pos.setZ(i, pos.getZ(i) * (1 - 0.3 * t) + forward * t * t);
  }
  geo.computeVertexNormals();

  const strand = new THREE.Mesh(geo, mat);
  strand.scale.z = 0.42;
  group.add(strand);

  const tip = new THREE.Mesh(new THREE.ConeGeometry(width * 0.46, 0.1, 8), mat);
  tip.rotation.x = Math.PI;
  tip.scale.z = 0.42;
  tip.position.set(sweep, -len - 0.038, forward);
  group.add(tip);

  parent.add(group);
  return group;
}

export function buildWhaleGirl(input = {}) {
  const palette = buildPalette(input);
  const mats = makeMaterials(palette);
  const root = new THREE.Group();
  root.name = 'WhaleGirl';
  const nodes = {};

  const HEAD_Y = 2.152;
  const HEAD_SCALE = 0.44;

  // ---------------- body ----------------
  const body = new THREE.Group();
  body.name = 'Body';
  root.add(body);
  nodes.body = body;

  const neck = new THREE.Mesh(new THREE.CapsuleGeometry(0.044, 0.12, 6, 14), mats.skin);
  neck.position.set(0, 1.888, 0);
  neck.name = 'Neck';
  body.add(neck);

  ellipsoid(body, [0.152, 0.19, 0.1], mats.clothLight, [0, 1.702, 0.006], null, 'Blouse', 32);
  ellipsoid(body, [0.056, 0.05, 0.038], mats.clothLight, [-0.052, 1.7, 0.08], null, 'BustL', 20);
  ellipsoid(body, [0.056, 0.05, 0.038], mats.clothLight, [0.052, 1.7, 0.08], null, 'BustR', 20);
  ellipsoid(body, [0.107, 0.115, 0.084], mats.clothLight, [0, 1.53, 0.004], null, 'Waist', 24);
  ellipsoid(body, [0.15, 0.13, 0.108], mats.cloth, [0, 1.4, 0], null, 'Hips', 24);

  for (let i = -3; i <= 3; i += 1) {
    const pleat = new THREE.Mesh(new THREE.CapsuleGeometry(0.0042, 0.2, 3, 6), mats.pleat);
    pleat.position.set(i * 0.025, 1.645, 0.089 - Math.abs(i) * 0.0025);
    pleat.name = 'Pleat';
    body.add(pleat);
  }
  for (let i = 0; i < 5; i += 1) {
    sphere(body, 0.0085, mats.clothShade, [0, 1.6 + i * 0.042, 0.093 - i * 0.001], 'Button', 10);
  }

  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.058, 0.014, 8, 28), mats.cloth);
  collar.position.set(0, 1.862, 0);
  collar.rotation.x = Math.PI / 2;
  collar.name = 'Collar';
  body.add(collar);
  const collarLace = new THREE.Mesh(new THREE.TorusGeometry(0.066, 0.009, 8, 28), mats.lace);
  collarLace.position.set(0, 1.845, 0);
  collarLace.rotation.x = Math.PI / 2;
  collarLace.name = 'CollarLace';
  body.add(collarLace);

  for (const s of [-1, 1]) {
    ellipsoid(body, [0.056, 0.04, 0.018], mats.bowDeep, [0.05 * s, 1.838, 0.072], [0, 0.28 * s, 0.42 * s], 'CollarWing', 16);
    ellipsoid(body, [0.02, 0.05, 0.014], mats.bowDeep, [0.034 * s, 1.79, 0.079], [0, 0.2 * s, -0.32 * s], 'CollarTail', 14);
  }
  sphere(body, 0.021, mats.gem, [0, 1.834, 0.086], 'ChestGem', 18);
  const gemRim = new THREE.Mesh(new THREE.TorusGeometry(0.023, 0.004, 6, 24), mats.gold);
  gemRim.position.set(0, 1.834, 0.086);
  gemRim.name = 'GemRim';
  body.add(gemRim);

  for (const s of [-1, 1]) {
    for (let i = 0; i < 4; i += 1) {
      const phi = (-0.55 + i * 0.22) * s;
      const frill = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 10), mats.lace);
      frill.scale.set(0.03, 0.019, 0.016);
      frill.position.set((0.115 + Math.cos(phi) * 0.018) * s, 1.795 + Math.sin(Math.abs(phi)) * 0.02, 0.055 + Math.cos(phi) * 0.02);
      frill.rotation.set(0, phi, 0.4 * s);
      frill.name = 'ShoulderFrill';
      body.add(frill);
    }
  }

  const corset = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.115, 0.11, 36), mats.cloth);
  corset.position.y = 1.505;
  corset.name = 'Corset';
  body.add(corset);
  for (let r = 0; r < 3; r += 1) {
    for (const s of [-1, 1]) {
      sphere(body, 0.008, mats.gold, [0.042 * s, 1.468 + r * 0.036, 0.112 - r * 0.002], 'GoldButton', 10);
    }
  }

  const skirtPts = [
    [0.112, 0], [0.15, -0.07], [0.2, -0.22], [0.255, -0.42], [0.295, -0.6], [0.305, -0.68],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const skirt = new THREE.Mesh(new THREE.LatheGeometry(skirtPts, 48), mats.clothDouble);
  skirt.position.y = 1.5;
  skirt.name = 'Skirt';
  body.add(skirt);

  const skirtTrim = new THREE.Mesh(new THREE.TorusGeometry(0.296, 0.0045, 6, 64), mats.gold);
  skirtTrim.position.set(0, 0.915, 0);
  skirtTrim.rotation.x = Math.PI / 2;
  skirtTrim.name = 'SkirtTrim';
  body.add(skirtTrim);
  for (let i = 0; i < 22; i += 1) {
    const a = (i / 22) * TAU;
    const yy = 0.94 + Math.sin(a * 3) * 0.035;
    const r = 0.296 - Math.abs(Math.sin(a)) * 0.002;
    sphere(body, 0.0055, mats.gold, [Math.sin(a) * r, yy, Math.cos(a) * r], 'Star', 8);
  }

  const petticoat = new THREE.Mesh(new THREE.CylinderGeometry(0.302, 0.328, 0.1, 40, 1, true), mats.laceDouble);
  petticoat.position.y = 0.852;
  petticoat.name = 'Petticoat';
  body.add(petticoat);
  for (let i = 0; i < 30; i += 1) {
    const a = (i / 30) * TAU;
    const ruffle = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 9), mats.lace);
    ruffle.scale.set(0.026, 0.018, 0.018);
    ruffle.position.set(Math.sin(a) * 0.322, 0.803, Math.cos(a) * 0.322);
    ruffle.rotation.set(0, a, 0);
    ruffle.name = 'HemRuffle';
    body.add(ruffle);
  }

  const apron = new THREE.Mesh(
    new THREE.CylinderGeometry(0.162, 0.318, 0.62, 36, 1, true, -0.46, 0.92),
    mats.laceDouble,
  );
  apron.position.y = 1.16;
  apron.name = 'Apron';
  body.add(apron);
  const apronHem = new THREE.Mesh(new THREE.TorusGeometry(0.315, 0.012, 6, 40, 0.92), mats.lace);
  apronHem.position.set(0, 0.845, 0);
  apronHem.rotation.set(Math.PI / 2, 0, 0);
  apronHem.rotation.y = -0.46;
  apronHem.name = 'ApronHem';
  body.add(apronHem);
  for (let i = 0; i < 15; i += 1) {
    const a = -0.44 + (i / 14) * 0.88;
    const ruffle = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 9), mats.lace);
    ruffle.scale.set(0.022, 0.014, 0.014);
    ruffle.position.set(Math.sin(a) * 0.328, 0.846, Math.cos(a) * 0.328);
    ruffle.rotation.set(0, a, 0);
    ruffle.name = 'ApronRuffle';
    body.add(ruffle);
  }

  const motif = new THREE.Group();
  motif.name = 'ApronWhale';
  motif.position.set(0.085, 1.02, 0.268);
  motif.rotation.set(-0.12, 0.2, 0.1);
  ellipsoid(motif, [0.032, 0.02, 0.007], mats.bow, [0, 0, 0], null, 'WhaleBody', 14);
  const motifTail = new THREE.Mesh(new THREE.ConeGeometry(0.016, 0.026, 3), mats.bow);
  motifTail.position.set(0.034, 0.008, 0);
  motifTail.rotation.z = -1.0;
  motif.add(motifTail);
  body.add(motif);

  const backBow = new THREE.Group();
  backBow.name = 'BackBow';
  backBow.position.set(0, 1.43, -0.17);
  ellipsoid(backBow, [0.105, 0.058, 0.026], mats.lace, [-0.09, 0.02, 0], [0, -0.35, 0.5], 'BowWingL', 18);
  ellipsoid(backBow, [0.105, 0.058, 0.026], mats.lace, [0.09, 0.02, 0], [0, 0.35, -0.5], 'BowWingR', 18);
  sphere(backBow, 0.032, mats.lace, [0, 0, 0.012], 'BowKnot', 16);
  const ribbonL = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.36, 0.012), mats.lace);
  ribbonL.position.set(-0.055, -0.19, -0.014);
  ribbonL.rotation.z = 0.16;
  ribbonL.name = 'RibbonL';
  backBow.add(ribbonL);
  const ribbonR = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.32, 0.012), mats.lace);
  ribbonR.position.set(0.05, -0.17, -0.012);
  ribbonR.rotation.z = -0.2;
  ribbonR.name = 'RibbonR';
  backBow.add(ribbonR);
  body.add(backBow);

  // ---------------- arms ----------------
  const arms = {};
  for (const s of [-1, 1]) {
    const arm = new THREE.Group();
    arm.name = s < 0 ? 'ArmL' : 'ArmR';
    arm.position.set(0.168 * s, 1.8, 0.005);
    arm.rotation.set(0.12, 0, -0.16 * s);

    ellipsoid(arm, [0.078, 0.105, 0.078], mats.cloth, [0.008 * s, -0.06, 0], [0, 0, -0.1 * s], 'Sleeve', 22);
    const sleeveFrill = new THREE.Mesh(new THREE.TorusGeometry(0.062, 0.013, 6, 22), mats.lace);
    sleeveFrill.position.set(0, -0.163, 0);
    sleeveFrill.rotation.x = Math.PI / 2;
    sleeveFrill.name = 'SleeveFrill';
    arm.add(sleeveFrill);

    const fore = new THREE.Group();
    fore.name = 'Forearm';
    fore.position.set(0, -0.185, 0);
    fore.rotation.set(0.78, 0, -0.24 * s);
    const forearm = new THREE.Mesh(new THREE.CapsuleGeometry(0.038, 0.135, 5, 12), mats.skin);
    forearm.position.set(0, -0.12, 0.004);
    forearm.name = 'ForearmMesh';
    fore.add(forearm);
    const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.043, 0.012, 6, 20), mats.lace);
    cuff.position.set(0, -0.232, 0.004);
    cuff.rotation.x = Math.PI / 2;
    cuff.name = 'WristCuff';
    fore.add(cuff);
    ellipsoid(fore, [0.041, 0.052, 0.03], mats.skin, [0, -0.292, 0.008], [0.2, 0, 0], 'Hand', 16);
    arm.add(fore);

    body.add(arm);
    arms[s < 0 ? 'L' : 'R'] = arm;
    nodes[s < 0 ? 'foreL' : 'foreR'] = fore;
  }
  nodes.armL = arms.L;
  nodes.armR = arms.R;

  // ---------------- legs ----------------
  for (const s of [-1, 1]) {
    const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.062, 0.42, 6, 12), mats.skin);
    thigh.position.set(0.078 * s, 1.12, 0);
    thigh.name = 'Thigh';
    body.add(thigh);

    const sock = new THREE.Mesh(new THREE.CapsuleGeometry(0.052, 0.6, 6, 14), mats.lace);
    sock.position.set(0.078 * s, 0.5, 0.002);
    sock.name = 'Sock';
    body.add(sock);
    const sockTop = new THREE.Mesh(new THREE.TorusGeometry(0.054, 0.011, 6, 22), mats.lace);
    sockTop.position.set(0.078 * s, 0.812, 0.002);
    sockTop.rotation.x = Math.PI / 2;
    sockTop.name = 'SockLace';
    body.add(sockTop);
    ellipsoid(body, [0.03, 0.014, 0.014], mats.bowDeep, [0.078 * s, 0.806, 0.056], [0, 0, 0], 'SockBow', 12);

    ellipsoid(body, [0.06, 0.046, 0.11], mats.shoe, [0.086 * s, 0.098, 0.032], [0, -0.22 * s, 0], 'Shoe', 20);
    const heel = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.05, 0.045), mats.shoe);
    heel.position.set(0.084 * s, 0.032, -0.048);
    heel.name = 'Heel';
    body.add(heel);
    const strap = new THREE.Mesh(new THREE.CapsuleGeometry(0.009, 0.07, 4, 8), mats.shoe);
    strap.position.set(0.084 * s, 0.122, 0.048);
    strap.rotation.z = Math.PI / 2;
    strap.name = 'ShoeStrap';
    body.add(strap);
    ellipsoid(body, [0.014, 0.012, 0.006], mats.gold, [0.084 * s, 0.124, 0.084], null, 'ShoeBuckle', 10);
  }

  // ---------------- head ----------------
  const head = new THREE.Group();
  head.name = 'Head';
  head.position.set(0, HEAD_Y, 0);
  head.scale.setScalar(HEAD_SCALE);
  root.add(head);
  nodes.head = head;

  const face = ellipsoid(head, FACE_R, mats.skin, [0, 0, 0], null, 'Face', 56);
  const fpos = face.geometry.attributes.position;
  for (let i = 0; i < fpos.count; i += 1) {
    const y = fpos.getY(i);
    if (y < 0) {
      const k = 1.55 * y * y;
      fpos.setX(i, fpos.getX(i) * (1 - k));
      fpos.setZ(i, fpos.getZ(i) * (1 - k * 0.55));
    }
  }
  face.geometry.computeVertexNormals();

  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(0.432, 40, 22, 0, TAU, 0, Math.PI * 0.265),
    mats.hair,
  );
  cap.position.set(0, 0.025, -0.01);
  cap.scale.set(1.07, 0.99, 1.02);
  cap.name = 'HairCap';
  head.add(cap);

  const backCap = new THREE.Mesh(
    new THREE.SphereGeometry(0.44, 36, 22, Math.PI, Math.PI, Math.PI * 0.24, Math.PI * 0.66),
    mats.hair,
  );
  backCap.position.copy(cap.position);
  backCap.scale.copy(cap.scale);
  backCap.name = 'HairBackCap';
  head.add(backCap);

  ellipsoid(head, [0.36, 0.38, 0.26], mats.hair, [0, -0.07, -0.16], null, 'BackHair', 30);

  const bangSpecs = [
    [-0.03, 0.4, 0.42, 0.33, 0.1, -0.42, -0.16, -0.025, 0.05],
    [-0.13, 0.38, 0.42, 0.3, 0.094, -0.36, -0.18, -0.02, 0.05],
    [0.06, 0.41, 0.42, 0.28, 0.09, -0.38, -0.14, -0.015, 0.05],
    [-0.22, 0.34, 0.41, 0.29, 0.084, -0.24, -0.2, -0.018, 0.05],
    [0.15, 0.39, 0.42, 0.29, 0.08, -0.28, -0.16, -0.01, 0.05],
    [0.25, 0.32, 0.39, 0.22, 0.072, -0.12, -0.18, 0.008, 0.05],
    [0.2, 0.37, 0.41, 0.18, 0.066, -0.2, -0.2, 0.008, 0.05],
  ];
  {
    const R = 0.438;
    const geo = new THREE.SphereGeometry(R, 56, 30, 0, Math.PI, 0.30, 1.12);
    const pos = geo.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i += 1) {
      v.fromBufferAttribute(pos, i).normalize();
      const theta = Math.acos(THREE.MathUtils.clamp(v.y, -1, 1));
      const phi = Math.atan2(v.z, -v.x);
      const wave = 0.028 + 0.05 * Math.sin(phi * 5 + 0.6) + 0.02 * Math.sin(phi * 9 + 2.1);
      const k = THREE.MathUtils.clamp((theta - 0.95) / 0.55, 0, 1);
      const front = Math.pow(Math.sin(phi), 1.5);
      const nt = theta + wave * k * k - (1 - front) * 0.42 * k - 0.075 * Math.cos(phi) * k;
      const st = Math.sin(nt);
      pos.setXYZ(i, -Math.cos(phi) * st * R, Math.cos(nt) * R, Math.sin(phi) * st * R);
    }
    geo.computeVertexNormals();
    const fringe = new THREE.Mesh(geo, mats.hair);
    fringe.name = 'Fringe';
    fringe.position.set(0, 0.025, -0.01);
    fringe.scale.set(1.07, 0.99, 1.02);
    head.add(fringe);
  }
  ellipsoid(head, [0.28, 0.095, 0.085], mats.hairShade, [-0.04, 0.35, 0.3], [0.42, 0, 0.22], 'FringeSweep', 28);
  for (const [x, y, z, len, width, tilt, lean, sweep, forward] of bangSpecs) {
    bangStrand(head, mats.hair, { x, y, z, len, width, tilt, lean, sweep, forward });
  }

  const lockFrontL = curvedLock(mats, -1, {
    x: 0.4, y: 0.26, z: 0.145, top: 0.098, bottom: 0.022, len: 0.92, name: 'SideLockFrontL', bend: -0.05, curve: 0.06, wave: 0.022,
  });
  const lockFrontR = curvedLock(mats, 1, {
    x: 0.4, y: 0.26, z: 0.145, top: 0.098, bottom: 0.022, len: 0.92, name: 'SideLockFrontR', bend: -0.05, curve: 0.06, wave: 0.022,
  });
  lockFrontL.children[0].material = mats.hairShade;
  lockFrontR.children[0].material = mats.hairShade;
  head.add(lockFrontL, lockFrontR);

  const lockOuterL = curvedLock(mats, -1, {
    x: 0.432, y: 0.22, z: -0.01, top: 0.092, bottom: 0.024, len: 1.0, name: 'SideLockL', bend: 0.04, curve: 0.06, wave: 0.03,
  });
  const lockOuterR = curvedLock(mats, 1, {
    x: 0.432, y: 0.22, z: -0.01, top: 0.092, bottom: 0.024, len: 1.0, name: 'SideLockR', bend: 0.04, curve: 0.06, wave: 0.03,
  });
  head.add(lockOuterL, lockOuterR);
  nodes.sideLockL = lockOuterL;
  nodes.sideLockR = lockOuterR;

  // long hair (world units)
  const hairRoot = new THREE.Group();
  hairRoot.name = 'HairLong';
  hairRoot.position.set(0, 2.03, -0.05);
  root.add(hairRoot);
  nodes.hairBack = hairRoot;

  ellipsoid(hairRoot, [0.225, 0.48, 0.12], mats.hair, [0, -0.48, -0.04], null, 'HairMass', 30);
  ellipsoid(hairRoot, [0.115, 0.4, 0.092], mats.hairShade, [-0.215, -0.5, -0.01], [0, 0, 0.1], 'HairMassL', 24);
  ellipsoid(hairRoot, [0.115, 0.4, 0.092], mats.hairShade, [0.215, -0.5, -0.01], [0, 0, -0.1], 'HairMassR', 24);
  ellipsoid(hairRoot, [0.31, 0.46, 0.085], mats.hairShade, [0, -0.52, -0.15], null, 'HairFill', 26);

  const backLockSpecs = [
    [0, 0.06, -0.05, 0.115, 0.034, 0.92, 0.02, 0.03, 0.02, 0.55],
    [-0.13, 0.05, -0.04, 0.108, 0.031, 0.9, 0.05, 0.02, 0.025, 0.5],
    [0.13, 0.05, -0.04, 0.108, 0.031, 0.9, 0.05, 0.02, 0.025, 0.5],
    [-0.235, 0.02, -0.02, 0.098, 0.029, 0.86, 0.09, 0.03, 0.03, 0.45],
    [0.235, 0.02, -0.02, 0.098, 0.029, 0.86, 0.09, 0.03, 0.03, 0.45],
    [-0.315, -0.02, 0.0, 0.085, 0.025, 0.78, 0.1, 0.04, 0.032, 0.42],
    [0.315, -0.02, 0.0, 0.085, 0.025, 0.78, 0.1, 0.04, 0.032, 0.42],
  ];
  for (let i = 0; i < backLockSpecs.length; i += 1) {
    const [x, y, z, top, bottom, len, bend, curve, wave, flatten] = backLockSpecs[i];
    const lock = curvedLock(mats, 1, {
      x, y, z, top, bottom, len, bend, curve, wave, flatten,
      name: 'HairLock' + i,
    });
    lock.children[0].material = i % 2 ? mats.hair : mats.hairLight;
    hairRoot.add(lock);
  }

  const sideLongs = [
    [-0.22, -0.01, 0.1, 0.085, 0.028, 0.72, 0.06, 0.03, 0.02],
    [0.22, -0.01, 0.1, 0.085, 0.028, 0.72, 0.06, 0.03, 0.02],
    [-0.28, -0.04, 0.04, 0.08, 0.025, 0.66, 0.08, 0.04, 0.026],
    [0.28, -0.04, 0.04, 0.08, 0.025, 0.66, 0.08, 0.04, 0.026],
  ];
  for (let i = 0; i < sideLongs.length; i += 1) {
    const [x, y, z, top, bottom, len, bend, curve, wave] = sideLongs[i];
    const lock = curvedLock(mats, 1, {
      x, y, z, top, bottom, len, bend, curve, wave, flatten: 0.5,
      name: 'HairSideLong' + i,
    });
    lock.children[0].material = mats.hairShade;
    hairRoot.add(lock);
  }

  for (const [x, y] of [[-0.32, 1.0], [0.32, 1.0], [-0.14, 0.98], [0.14, 0.98]]) {
    const curl = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.036, 10, 22, Math.PI * 1.45), mats.hairLight);
    curl.position.set(x, y, -0.02);
    curl.rotation.set(0.4, 0.2, Math.PI * 0.2);
    curl.name = 'HairCurl';
    root.add(curl);
  }

  const braid = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.032, 8, 40), mats.hairLight);
  braid.position.set(0, 0.16, -0.1);
  braid.rotation.x = Math.PI / 2;
  braid.name = 'Braid';
  head.add(braid);
  for (let i = 0; i < 20; i += 1) {
    const a = (i / 20) * TAU;
    const bead = new THREE.Mesh(new THREE.SphereGeometry(0.042, 10, 8), mats.hairLight);
    bead.position.set(Math.cos(a) * 0.34, 0.16 + Math.sin(a * 2) * 0.012, -0.1 + Math.sin(a) * 0.34);
    bead.name = 'BraidBead';
    head.add(bead);
  }

  // fin ears
  const makeFin = (side) => {
    const g = new THREE.Group();
    g.name = side < 0 ? 'EarL' : 'EarR';
    const sh = new THREE.Shape();
    sh.moveTo(0, 0.035);
    sh.bezierCurveTo(0.12, 0.17, 0.3, 0.16, 0.44, 0.03);
    sh.bezierCurveTo(0.32, -0.02, 0.14, -0.1, 0.01, -0.085);
    sh.closePath();
    const fin = new THREE.Mesh(
      new THREE.ExtrudeGeometry(sh, {
        depth: 0.035, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.012, bevelSegments: 2, curveSegments: 10,
      }),
      mats.finDeep,
    );
    fin.name = 'FinBlade';
    g.add(fin);
    const frill = new THREE.Mesh(
      new THREE.ExtrudeGeometry(sh, { depth: 0.008, bevelEnabled: false, curveSegments: 10 }),
      mats.lace,
    );
    frill.scale.set(0.86, 0.8, 1);
    frill.position.set(0.045, -0.012, 0.032);
    frill.name = 'FinFrill';
    g.add(frill);
    for (let i = 0; i < 3; i += 1) {
      const ridge = new THREE.Mesh(new THREE.CapsuleGeometry(0.008, 0.16, 3, 6), mats.fin);
      ridge.position.set(0.1 + i * 0.1, 0.05 - i * 0.018, 0.018);
      ridge.rotation.z = 1.28 - i * 0.1;
      ridge.name = 'FinRidge';
      g.add(ridge);
    }
    g.position.set(0.4 * side, -0.07, 0.09);
    g.scale.x = side;
    g.rotation.set(0.05, 0.78, -0.14);
    head.add(g);
    return g;
  };
  nodes.finL = makeFin(-1);
  nodes.finR = makeFin(1);

  // whale tail
  const tail = new THREE.Group();
  tail.name = 'Tail';
  tail.position.set(0, 1.45, -0.12);
  const tailCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0.02, -0.14, -0.14),
    new THREE.Vector3(0.045, -0.3, -0.21),
    new THREE.Vector3(0.06, -0.44, -0.24),
    new THREE.Vector3(0.065, -0.55, -0.21),
  ]);
  const tailMesh = new THREE.Mesh(new THREE.TubeGeometry(tailCurve, 40, 0.045, 12, false), mats.finDeep);
  tailMesh.name = 'TailStalk';
  tail.add(tailMesh);
  const tailTip = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), mats.finDeep);
  tailTip.position.copy(tailCurve.getPoint(1));
  tail.add(tailTip);
  for (const s of [-1, 1]) {
    const fluke = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), mats.finDeep);
    fluke.scale.set(0.1, 0.028, 0.17);
    fluke.position.set(0.065 + 0.105 * s, -0.55, -0.28);
    fluke.rotation.set(0.32, s * 0.28, 0);
    fluke.name = 'TailFluke';
    tail.add(fluke);
    const fringe = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), mats.finLight);
    fringe.scale.set(0.06, 0.02, 0.14);
    fringe.position.set(0.065 + 0.15 * s, -0.56, -0.29);
    fringe.rotation.copy(fluke.rotation);
    fringe.name = 'TailFringe';
    tail.add(fringe);
  }
  root.add(tail);
  nodes.tail = tail;

  // face features
  nodes.eyeL = buildEye(head, mats, -1, palette);
  nodes.eyeR = buildEye(head, mats, 1, palette);

  for (const s of [-1, 1]) {
    const brow = new THREE.Mesh(new THREE.CapsuleGeometry(0.009, 0.105, 4, 8), mats.hairDeep);
    brow.position.set(0.155 * s, 0.012, 0.392);
    brow.rotation.set(0.2, 0.3 * s, Math.PI / 2 + 0.09 * s);
    brow.name = 'Brow';
    head.add(brow);
  }

  ellipsoid(head, [0.011, 0.008, 0.008], mats.skinShade, [0, -0.318, 0.378], null, 'Nose', 12);

  ellipsoid(head, [0.1, 0.03, 0.011], mats.blush, [-0.245, -0.275, 0.278], [-0.02, -0.62, 0.08], 'BlushL', 20);
  ellipsoid(head, [0.1, 0.03, 0.011], mats.blush, [0.245, -0.275, 0.278], [-0.02, 0.62, -0.08], 'BlushR', 20);
  for (const s of [-1, 1]) {
    for (let i = 0; i < 3; i += 1) {
      const hatch = new THREE.Mesh(new THREE.CapsuleGeometry(0.0035, 0.032, 3, 6), mats.blushHatch);
      hatch.position.set((0.205 + i * 0.026) * s, -0.228 + i * 0.009, 0.302);
      hatch.rotation.set(0, 0.62 * s, Math.PI / 2 - 0.42 * s);
      head.add(hatch);
    }
  }

  const mouthParts = buildMouth(head, mats);
  nodes.mouth = mouthParts.mouth;
  nodes.mouthOpen = mouthParts.open;

  // white lace headdress across the crown
  const laceGeo = new THREE.SphereGeometry(1, 14, 12);
  for (let i = 0; i < 15; i += 1) {
    const phi = (i / 14 - 0.5) * 2.0;
    const theta = 0.72;
    const R = 0.442;
    const ruffle = new THREE.Mesh(laceGeo, mats.lace);
    ruffle.scale.set(0.042, 0.03, 0.024);
    ruffle.position.set(R * Math.sin(theta) * Math.sin(phi), R * Math.cos(theta) + 0.02, R * Math.sin(theta) * Math.cos(phi) - 0.01);
    ruffle.rotation.set(-0.4, phi, 0);
    ruffle.name = 'Lace';
    head.add(ruffle);
  }
  for (let i = 0; i < 14; i += 1) {
    const phi = ((i + 0.5) / 14 - 0.5) * 2.0;
    const theta = 0.6;
    const R = 0.446;
    const ruffle = new THREE.Mesh(laceGeo, mats.lace);
    ruffle.scale.set(0.034, 0.024, 0.02);
    ruffle.position.set(R * Math.sin(theta) * Math.sin(phi), R * Math.cos(theta) + 0.02, R * Math.sin(theta) * Math.cos(phi) - 0.01);
    ruffle.rotation.set(-0.28, phi, 0);
    ruffle.name = 'Lace';
    head.add(ruffle);
  }

  const ahoge = new THREE.Group();
  ahoge.name = 'Ahoge';
  ahoge.position.set(0, 0.56, 0.01);
  const ahogeCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(-0.015, 0.1, 0.004),
    new THREE.Vector3(0.07, 0.19, -0.004),
    new THREE.Vector3(0.16, 0.17, -0.012),
    new THREE.Vector3(0.19, 0.08, -0.016),
    new THREE.Vector3(0.12, 0.03, -0.014),
  ]);
  const ahogeMesh = new THREE.Mesh(new THREE.TubeGeometry(ahogeCurve, 28, 0.032, 9, false), mats.hairShade);
  ahoge.add(ahogeMesh);
  const ahogeTip = new THREE.Mesh(new THREE.SphereGeometry(0.034, 12, 9), mats.hairShade);
  ahogeTip.position.copy(ahogeCurve.getPoint(1));
  ahoge.add(ahogeTip);
  head.add(ahoge);
  nodes.ahoge = ahoge;

  const headdress = new THREE.Group();
  headdress.name = 'Headdress';
  headdress.position.set(0.33, 0.36, 0.17);
  headdress.rotation.set(0.15, 0.8, 0.2);
  ellipsoid(headdress, [0.085, 0.05, 0.02], mats.bow, [-0.058, 0.012, 0], [0, 0, 0.5], 'BowWingL', 18);
  ellipsoid(headdress, [0.085, 0.05, 0.02], mats.bow, [0.058, 0.012, 0], [0, 0, -0.5], 'BowWingR', 18);
  sphere(headdress, 0.026, mats.bowDeep, [0, 0, 0.014], 'BowKnot', 14);
  ellipsoid(headdress, [0.027, 0.068, 0.013], mats.bowDeep, [0.026, -0.072, 0], [0, 0, -0.3], 'BowTailR', 14);
  ellipsoid(headdress, [0.021, 0.056, 0.013], mats.bowDeep, [-0.028, -0.066, 0], [0, 0, 0.36], 'BowTailL', 14);
  head.add(headdress);
  nodes.headdress = headdress;

  const backBow2 = new THREE.Group();
  backBow2.name = 'HairBow';
  backBow2.position.set(0, 0.16, -0.44);
  ellipsoid(backBow2, [0.075, 0.045, 0.018], mats.bow, [-0.05, 0.01, 0], [0, 0, 0.5], 'BowWingL', 16);
  ellipsoid(backBow2, [0.075, 0.045, 0.018], mats.bow, [0.05, 0.01, 0], [0, 0, -0.5], 'BowWingR', 16);
  sphere(backBow2, 0.023, mats.bowDeep, [0, 0, 0.012], 'BowKnot', 12);
  head.add(backBow2);

  for (const node of [
    head, ahoge, lockOuterL, lockOuterR, arms.L, arms.R, mouthParts.open,
    hairRoot, tail, nodes.finL, nodes.finR,
  ]) {
    node.userData.rest = {
      rot: node.rotation.clone(),
      pos: node.position.clone(),
    };
  }

  return { root, nodes, mats, palette };
}

function eulerQuat(x, y, z) {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z)).toArray();
}

function restQuat(node, dx = 0, dy = 0, dz = 0) {
  const r = node.userData.rest?.rot || node.rotation;
  return eulerQuat(r.x + dx, r.y + dy, r.z + dz);
}

export function buildWhaleGirlClips(nodes) {
  const times = [0, 1, 2, 3, 4];
  const idleTracks = [
    new THREE.VectorKeyframeTrack('WhaleGirl.position', times, [
      0, 0, 0, 0, 0.014, 0, 0, 0, 0, 0, -0.008, 0, 0, 0, 0,
    ]),
    new THREE.QuaternionKeyframeTrack('Head.quaternion', times, [
      ...eulerQuat(0.01, 0.05, 0.015),
      ...eulerQuat(0.0, 0.0, 0.0),
      ...eulerQuat(-0.02, -0.05, -0.015),
      ...eulerQuat(0.0, 0.0, 0.0),
      ...eulerQuat(0.01, 0.05, 0.015),
    ]),
    new THREE.QuaternionKeyframeTrack('Ahoge.quaternion', times, [
      ...eulerQuat(0.04, 0, 0.1),
      ...eulerQuat(-0.04, 0, -0.04),
      ...eulerQuat(0.03, 0, -0.1),
      ...eulerQuat(-0.02, 0, 0.04),
      ...eulerQuat(0.04, 0, 0.1),
    ]),
    new THREE.QuaternionKeyframeTrack('ArmL.quaternion', times, [
      ...restQuat(nodes.armL, 0, 0, 0.03),
      ...restQuat(nodes.armL, 0, 0, -0.02),
      ...restQuat(nodes.armL, 0, 0, 0.03),
      ...restQuat(nodes.armL, 0, 0, -0.02),
      ...restQuat(nodes.armL, 0, 0, 0.03),
    ]),
    new THREE.QuaternionKeyframeTrack('ArmR.quaternion', times, [
      ...restQuat(nodes.armR, 0, 0, 0.03),
      ...restQuat(nodes.armR, 0, 0, -0.02),
      ...restQuat(nodes.armR, 0, 0, 0.03),
      ...restQuat(nodes.armR, 0, 0, -0.02),
      ...restQuat(nodes.armR, 0, 0, 0.03),
    ]),
    new THREE.VectorKeyframeTrack('EyeL.scale', [0, 2.94, 3.02, 3.12, 4], [
      1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.08, 1, 1, 1, 1,
    ]),
    new THREE.VectorKeyframeTrack('EyeR.scale', [0, 2.94, 3.02, 3.12, 4], [
      1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.08, 1, 1, 1, 1,
    ]),
  ];

  const talkTracks = [
    new THREE.VectorKeyframeTrack('MouthOpen.scale', [0, 0.12, 0.24, 0.36, 0.48, 0.6], [
      1, 0.18, 1,
      1, 0.55, 1,
      1, 1.0, 1,
      1, 0.3, 1,
      1, 0.85, 1,
      1, 0.18, 1,
    ]),
  ];

  return [
    new THREE.AnimationClip('Idle', 4, idleTracks),
    new THREE.AnimationClip('Talk', 0.6, talkTracks),
  ];
}

export { heartShape };
