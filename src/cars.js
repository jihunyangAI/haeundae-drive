import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildShell } from './carbody.js';
import { buildInterior } from './interior.js';
import { ENV } from './map/shared.js';

// Dimensions in metres, mass in kg. All four are made-up cars.
// shape: `top` is the centre line of bonnet, glass, roof and boot seen from the side and `belt` the line
// under the windows, both as [z, height] from tail to nose with z measured from the middle of the body.
// `glass` gives the z range of each window, `pillars` and `doors` where the side is divided, and
// `nose` / `tail` how the ends are rounded off: depth d, and how square they are in plan (nx) and in
// side view (ny). Lamp and grille patches use fractions: x of the half width, y of the end's height.
export const FRONT = {
  head: { x: [0.5, 0.97], y: [0.62, 0.8], yOut: [0.66, 0.9] },
  drl: { x: [0.5, 0.95], y: [0.55, 0.59], yOut: [0.59, 0.63] },
  blink: { x: [0.72, 0.95], y: [0.44, 0.5], yOut: [0.47, 0.53] },
  grille: { x: [0, 0.4], y: [0.56, 0.78] },
  intake: { x: [0, 0.62], y: [0.07, 0.25] },
  plate: 0.4,
};
export const REAR = {
  tail: { x: [0.45, 0.97], y: [0.64, 0.8], yOut: [0.62, 0.86] },
  blink: { x: [0.64, 0.95], y: [0.56, 0.61], yOut: [0.54, 0.59] },
  reverse: { x: [0.45, 0.6], y: [0.56, 0.61] },
  plate: 0.42,
};

export const CARS = [
  {
    id: 'hatch', name: '시티 해치백', tag: '가볍고 다루기 쉬운 전륜구동',
    mass: 1150, powerKW: 85, drive: 'FWD', frontWeight: 0.61,
    L: 3.95, W: 1.74, H: 1.5, wheelbase: 2.55, wheelR: 0.31, gc: 0.2, cgH: 0.54,
    stiff: 11, rollK: 0.011, pitchK: 0.009,
    redline: 6500, gears: [3.6, 2.05, 1.37, 1.03, 0.82], final: 4.1, cd: 0.32, area: 2.1,
    shape: {
      top: [[-1.975, 0.98], [-1.815, 1.02], [-1.72, 1.12], [-1.42, 1.46], [-0.7, 1.5], [0.22, 1.465], [0.95, 0.99], [1.35, 0.93], [1.735, 0.85], [1.975, 0.83]],
      belt: [[-1.975, 1.0], [-1.0, 1.01], [0.95, 0.95], [1.735, 0.81], [1.975, 0.81]],
      tumble: 0.3, nose: { d: 0.24, nx: 2.6, ny: 3.2 }, tail: { d: 0.16, nx: 3.4, ny: 4.5 },
      glass: { front: [0.24, 0.93], rear: [-1.7, -1.44], side: [-1.62, 0.86] }, pillars: [-0.38, -1.08], doors: [0.82, -0.38, -0.85],
      front: { grille: { x: [0, 0.34], y: [0.6, 0.76] } },
      rear: { tail: { x: [0.55, 0.97], y: [0.6, 0.84], yOut: [0.6, 0.9] }, reverse: { x: [0.55, 0.68], y: [0.52, 0.57] }, blink: { x: [0.7, 0.95], y: [0.52, 0.57] }, plate: 0.46 },
    },
    cabin: { upper: 0x30343a, lower: 0x34383e, seat: 0x3b4048, accent: 0x9aa1a9, dial: '#6fd0ff', top: 200 },
    wheel: { width: 0.2, spokes: 5, thick: 0.075, rim: 0xc3c7cc }, exhaust: [-0.5], plateText: '27나 4815',
  },
  {
    id: 'sedan', name: '비즈니스 세단', tag: '안정적이고 균형 잡힌 주행',
    mass: 1480, powerKW: 140, drive: 'FWD', frontWeight: 0.58,
    L: 4.7, W: 1.84, H: 1.45, wheelbase: 2.8, wheelR: 0.33, gc: 0.2, cgH: 0.55,
    stiff: 12, rollK: 0.009, pitchK: 0.008,
    redline: 6500, gears: [3.5, 2.1, 1.45, 1.1, 0.88, 0.72], final: 3.7, cd: 0.28, area: 2.2,
    shape: {
      top: [[-2.35, 0.95], [-2.15, 0.99], [-1.62, 1.04], [-0.95, 1.4], [-0.3, 1.45], [0.28, 1.42], [1.0, 0.98], [1.5, 0.92], [2.09, 0.81], [2.35, 0.79]],
      belt: [[-2.35, 0.97], [-1.62, 1.01], [1.0, 0.95], [2.09, 0.77], [2.35, 0.77]],
      tumble: 0.32, nose: { d: 0.26, nx: 2.6, ny: 3.2 }, tail: { d: 0.2, nx: 3.2, ny: 3.6 },
      glass: { front: [0.3, 0.98], rear: [-1.6, -0.97], side: [-1.38, 0.9] }, pillars: [-0.35], doors: [0.88, -0.35, -0.95],
      front: {}, rear: {},
    },
    cabin: { upper: 0x2c2f34, lower: 0x4a4238, seat: 0x6e5f4c, accent: 0xb89b6a, dial: '#ffffff', top: 240 },
    wheel: { width: 0.22, spokes: 10, thick: 0.04, rim: 0xb9bec4 }, exhaust: [-0.55, 0.55], plateText: '153가 2046',
  },
  {
    id: 'sport', name: '스포츠 쿠페', tag: '강력한 후륜구동, 섬세한 조작 필요',
    mass: 1450, powerKW: 260, drive: 'RWD', frontWeight: 0.5,
    L: 4.45, W: 1.9, H: 1.27, wheelbase: 2.6, wheelR: 0.34, gc: 0.16, cgH: 0.46,
    stiff: 14, rollK: 0.005, pitchK: 0.005,
    redline: 7500, gears: [3.2, 2.1, 1.5, 1.15, 0.92, 0.75], final: 3.6, cd: 0.3, area: 2.0,
    shape: {
      top: [[-2.225, 0.88], [-2.025, 0.9], [-1.75, 0.93], [-0.9, 1.23], [-0.35, 1.27], [0.05, 1.245], [0.72, 0.9], [1.3, 0.82], [1.925, 0.64], [2.225, 0.62]],
      belt: [[-2.225, 0.88], [-1.2, 0.9], [0.72, 0.86], [1.925, 0.6], [2.225, 0.6]],
      tumble: 0.42, nose: { d: 0.3, nx: 2.4, ny: 2.8 }, tail: { d: 0.2, nx: 3.2, ny: 3.4 },
      glass: { front: [0.07, 0.7], rear: [-1.72, -0.92], side: [-1.1, 0.62] }, pillars: [], doors: [0.6, -0.55],
      front: {
        head: { x: [0.52, 0.97], y: [0.68, 0.78], yOut: [0.74, 0.9] }, drl: { x: [0.52, 0.95], y: [0.62, 0.65], yOut: [0.68, 0.71] },
        blink: { x: [0.78, 0.95], y: [0.42, 0.48], yOut: [0.46, 0.52] }, grille: null, intake: { x: [0, 0.7], y: [0.08, 0.36] }, plate: 0.22,
      },
      rear: { tail: { x: [0, 0.95], y: [0.7, 0.78], bar: true }, blink: { x: [0.7, 0.95], y: [0.6, 0.65] }, reverse: { x: [0.5, 0.64], y: [0.6, 0.65] }, intake: { x: [0, 0.5], y: [0.08, 0.2] }, plate: 0.44 },
    },
    cabin: { upper: 0x232528, lower: 0x1e1f22, seat: 0x262223, accent: 0xc8102e, dial: '#ff4d3d', top: 300, sport: true },
    wheel: { width: 0.26, spokes: 5, twin: true, thick: 0.035, rim: 0x2b2e33, caliper: 0xc8102e }, exhaust: [-0.42, -0.3, 0.3, 0.42], plateText: '08라 7193',
  },
  {
    id: 'suv', name: '패밀리 SUV', tag: '높은 시야, 묵직한 사륜구동',
    mass: 2000, powerKW: 185, drive: 'AWD', frontWeight: 0.55,
    L: 4.75, W: 1.93, H: 1.72, wheelbase: 2.85, wheelR: 0.37, gc: 0.27, cgH: 0.68,
    stiff: 10, rollK: 0.016, pitchK: 0.012,
    redline: 6000, gears: [3.8, 2.2, 1.5, 1.12, 0.9, 0.74], final: 3.9, cd: 0.36, area: 2.7,
    shape: {
      top: [[-2.375, 1.14], [-2.215, 1.18], [-2.14, 1.26], [-1.9, 1.68], [-0.8, 1.72], [0.38, 1.69], [1.05, 1.2], [1.6, 1.12], [2.135, 0.98], [2.375, 0.96]],
      belt: [[-2.375, 1.18], [-1, 1.19], [1.05, 1.15], [2.135, 0.94], [2.375, 0.94]],
      tumble: 0.26, nose: { d: 0.24, nx: 3.2, ny: 3.8 }, tail: { d: 0.16, nx: 3.6, ny: 4.5 },
      glass: { front: [0.4, 1.03], rear: [-2.12, -1.92], side: [-2.0, 0.95] }, pillars: [-0.3, -1.25], doors: [0.92, -0.3, -0.935],
      cladding: true, rails: [-1.75, 0.2],
      front: {
        grille: { x: [0, 0.46], y: [0.52, 0.82] }, head: { x: [0.54, 0.97], y: [0.66, 0.8], yOut: [0.68, 0.86] },
        drl: { x: [0.54, 0.95], y: [0.59, 0.63], yOut: [0.61, 0.65] }, intake: { x: [0, 0.6], y: [0.14, 0.3] }, plate: 0.42,
      },
      rear: { tail: { x: [0.6, 0.97], y: [0.56, 0.86], yOut: [0.56, 0.92] }, reverse: { x: [0.6, 0.72], y: [0.48, 0.53] }, blink: { x: [0.74, 0.95], y: [0.48, 0.53] }, plate: 0.5 },
    },
    cabin: { upper: 0x33302c, lower: 0x3f3830, seat: 0x4f3d2e, accent: 0x8b9096, dial: '#ffb547', top: 220 },
    wheel: { width: 0.25, spokes: 6, thick: 0.085, rim: 0x8b9096 }, exhaust: [], plateText: '342다 5860',
  },
];

// Paint choices. metal: how metallic the finish is (0 solid colour, 1 full metallic flake).
export const COLORS = [
  { hex: 0xb5121b, metal: 0.35 }, { hex: 0xd6d7d3, metal: 0.1 }, { hex: 0x16181c, metal: 0.6 }, { hex: 0x1d4e9e, metal: 0.7 },
  { hex: 0x9aa1a9, metal: 0.85 }, { hex: 0xe2a012, metal: 0.2 }, { hex: 0x1f5a3c, metal: 0.6 }, { hex: 0x5f7385, metal: 0.7 },
  { hex: 0xd2581a, metal: 0.4 }, { hex: 0xb7a98c, metal: 0.75 },
];

// Body paint: snow settles on the surfaces that face the sky.
function paintMaterial() {
  const m = new THREE.MeshPhysicalMaterial({ clearcoat: 1, clearcoatRoughness: 0.06 });
  m.onBeforeCompile = shader => {
    shader.uniforms.uSnow = ENV.snow;
    shader.fragmentShader = `uniform float uSnow;\n${shader.fragmentShader}`.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
  float skyward = dot(normalize(vNormal), normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.89, 0.93), uSnow * 0.85 * smoothstep(0.72, 0.93, skyward));`,
    );
  };
  m.customProgramCacheKey = () => 'carpaint';
  return m;
}

function plateTexture(text) {
  const c = document.createElement('canvas');
  c.width = 260;
  c.height = 56;
  const g = c.getContext('2d');
  g.fillStyle = '#f4f4f1';
  g.fillRect(0, 0, 260, 56);
  g.strokeStyle = '#15171a';
  g.lineWidth = 3;
  g.strokeRect(2.5, 2.5, 255, 51);
  g.fillStyle = '#15171a';
  g.font = '700 38px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 130, 30);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// The parts of one wheel, with its outer face towards +x.
function wheelGeometry(R, w) {
  const hw = w.width / 2, rr = R * 0.66;
  const lathe = pts => new THREE.LatheGeometry(pts.map(([r, x]) => new THREE.Vector2(r, x)), 28).rotateZ(-Math.PI / 2);
  const tyre = lathe([[rr, -hw], [R - 0.04, -hw], [R - 0.008, -hw + 0.022], [R, -hw + 0.05], [R, hw - 0.05], [R - 0.008, hw - 0.022], [R - 0.04, hw], [rr, hw]]);
  const parts = [lathe([[rr - 0.02, -hw + 0.02], [rr, -hw + 0.02], [rr, hw - 0.012], [rr - 0.022, hw - 0.012], [rr - 0.03, hw - 0.035]])];
  const spoke = new THREE.BoxGeometry(0.03, rr - 0.05, w.thick).translate(hw - 0.045, (rr + 0.01) / 2, 0);
  for (let i = 0; i < w.spokes; i++) {
    const a = i / w.spokes * Math.PI * 2;
    for (const off of w.twin ? [-0.13, 0.13] : [0]) parts.push(spoke.clone().rotateX(a + off));
  }
  parts.push(new THREE.CylinderGeometry(0.075, 0.085, 0.05, 16).rotateZ(Math.PI / 2).translate(hw - 0.04, 0, 0));
  const disc = new THREE.CylinderGeometry(rr * 0.8, rr * 0.8, 0.025, 24).rotateZ(Math.PI / 2).translate(hw - 0.1, 0, 0);
  return { tyre, rim: mergeGeometries(parts.map(g => g.toNonIndexed())), disc };
}

// Returns a car whose root origin is the centre of gravity projected on the ground, facing +Z, with
// +X to the driver's left. colour: one of COLORS.
export function buildCarMesh(spec, colour) {
  const s = spec.shape, hl = spec.L / 2, R = spec.wheelR, gc = spec.gc, W = spec.W;
  const a = spec.wheelbase * (1 - spec.frontWeight), b = spec.wheelbase * spec.frontWeight;
  const AX = 0.03, fz = AX + spec.wheelbase / 2, rz = AX - spec.wheelbase / 2, ra = R + 0.07;
  const centerZ = (a - b) / 2 - AX;
  const shell = buildShell(spec, [{ z: rz, y: R, r: ra }, { z: fz, y: R, r: ra }]);
  const [header, cowl] = s.glass.front;

  const paint = paintMaterial();
  const std = options => new THREE.MeshStandardMaterial(options);
  const glass = std({ color: 0x0c1218, metalness: 0.6, roughness: 0.06, transparent: true, opacity: 0.62 });
  const dark = std({ color: 0x131518, roughness: 0.85 });
  const lining = std({ color: spec.cabin.upper, roughness: 0.95, side: THREE.BackSide });
  const tyreMat = std({ color: 0x0e0f11, roughness: 0.92 });
  const rimMat = std({ color: spec.wheel.rim, metalness: 0.85, roughness: 0.32 });
  const discMat = std({ color: 0x55585d, metalness: 0.8, roughness: 0.45 });
  const chrome = std({ color: 0xcfd3d8, metalness: 1, roughness: 0.2 });
  const decal = options => std({ side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6, ...options });
  const lamps = {
    head: decal({ color: 0x525a62, emissive: 0xfff1d6, roughness: 0.12, metalness: 0.9 }),
    drl: decal({ color: 0xf4f6f8, emissive: 0xeaf2ff, roughness: 0.2 }),
    tail: decal({ color: 0xa3121a, emissive: 0xff1a10, roughness: 0.18, metalness: 0.3 }),
    reverse: decal({ color: 0xdfe3e7, emissive: 0xffffff, roughness: 0.25 }),
    left: decal({ color: 0xc9781c, emissive: 0xff8a12, roughness: 0.25 }),
    right: decal({ color: 0xc9781c, emissive: 0xff8a12, roughness: 0.25 }),
  };
  const grilleMat = decal({ color: 0x0b0c0e, roughness: 0.6, metalness: 0.3 });

  const root = new THREE.Group();
  const chassis = new THREE.Group();
  const body = new THREE.Group();
  body.position.z = centerZ;
  chassis.add(body);
  root.add(chassis);

  const add = (geo, mat, x, y, z, parent = body, shadow = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = shadow;
    parent.add(m);
    return m;
  };

  // shell, and the same surface seen from inside as the cabin lining
  add(shell.geometry, [paint, glass, dark], 0, 0, 0);
  add(shell.geometry, [lining, new THREE.MeshBasicMaterial({ visible: false }), lining], 0, 0, 0, body, false);

  // ---- nose and tail
  const front = { ...FRONT, ...s.front }, rear = { ...REAR, ...s.rear };
  const lay = (end, part, mat, side) => { if (part) add(shell.patch(end, part, side), mat, 0, 0, 0, body, false); };
  for (const side of [1, -1]) {
    const blink = side > 0 ? lamps.left : lamps.right;
    lay('nose', front.head, lamps.head, side);
    lay('nose', front.drl, lamps.drl, side);
    lay('nose', front.blink, blink, side);
    if (!rear.tail.bar) lay('tail', rear.tail, lamps.tail, side);
    lay('tail', rear.blink, blink, side);
    lay('tail', rear.reverse, lamps.reverse, side);
  }
  if (rear.tail.bar) lay('tail', rear.tail, lamps.tail, 0);
  lay('nose', front.grille, grilleMat, 0);
  lay('nose', front.intake, grilleMat, 0);
  lay('tail', rear.intake, grilleMat, 0);
  const plateMat = std({ map: plateTexture(spec.plateText), roughness: 0.5 });
  for (const [end, part, turn] of [['nose', front, 0], ['tail', rear, Math.PI]]) {
    const cap = shell.caps[end], yb = cap.base[0][1], yt = cap.base[cap.base.length / 2][1];
    const p = shell.onCap(end, 0, yb + (yt - yb) * part.plate);
    add(new THREE.PlaneGeometry(0.52, 0.112), plateMat, 0, p[1], p[2] + cap.dir * 0.014, body, false).rotation.y = turn;
  }
  for (const x of spec.exhaust) {
    const p = shell.onCap('tail', x * W / 2, shell.caps.tail.base[0][1] + 0.07);
    add(new THREE.CylinderGeometry(0.04, 0.04, 0.12, 14, 1, true).rotateX(Math.PI / 2), chrome, p[0], p[1], p[2] + 0.01);
  }

  // ---- sides: door seams, handles, mirrors
  const seamMat = new THREE.LineBasicMaterial({ color: 0x050607, transparent: true, opacity: 0.55 });
  s.doors.forEach((z, i) => {
    for (const side of [1, -1]) {
      body.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(shell.seam(z, side)), seamMat));
      if (i === 0) continue;
      const m = shell.at(z + 0.13);
      add(new THREE.BoxGeometry(0.02, 0.026, 0.15), chrome, side * (m.hw - 0.012), m.belt - 0.085, z + 0.13);
    }
  });
  const mz = cowl - 0.2, mAt = shell.at(mz), mirrorPanes = [];       // the glass of the door mirrors, left then right
  for (const side of [1, -1]) {
    const mx = side * (mAt.beltX + 0.1);
    add(new THREE.SphereGeometry(1, 14, 10).scale(0.105, 0.07, 0.055), paint, mx, mAt.belt + 0.075, mz);
    add(new THREE.BoxGeometry(0.1, 0.022, 0.05), dark, side * (mAt.beltX + 0.03), mAt.belt + 0.03, mz);
    mirrorPanes.push(add(new THREE.PlaneGeometry(0.17, 0.1).rotateY(Math.PI), dark, mx, mAt.belt + 0.075, mz - 0.04, body, false));
  }
  // wipers, aerial, roof rails
  for (const x of [0.32, -0.22]) add(new THREE.BoxGeometry(0.5, 0.012, 0.022), dark, x, shell.top(cowl - 0.05) + 0.012, cowl - 0.05, body, false);
  const finZ = s.glass.rear[1] + 0.14;
  add(new THREE.ConeGeometry(0.03, 0.2, 4).rotateX(-Math.PI / 2.4).scale(0.6, 1, 1), dark, 0, shell.top(finZ) + 0.03, finZ);
  if (s.rails) {
    const [r0, r1] = s.rails, m = shell.at((r0 + r1) / 2);
    for (const side of [1, -1]) add(new THREE.BoxGeometry(0.035, 0.035, r1 - r0), chrome, side * (m.roofX - 0.04), m.roofY + 0.035, (r0 + r1) / 2);
  }

  // ---- underbody and cabin
  add(new THREE.BoxGeometry(W - 0.5, 0.42, spec.L - 0.6), dark, 0, gc + 0.23, 0);
  const interior = buildInterior(spec, shell, body, mirrorPanes, lining);
  const { eyeY, eyeZ, steeringWheel } = interior;

  // ---- headlamp beams
  // The lamps hang on their own frame, so the car can be hidden (see renderMirror) without changing the lights in the scene.
  const rig = new THREE.Group();
  rig.position.z = centerZ;
  root.add(rig);
  const lampAt = shell.onCap('nose', 0.72 * W / 2, shell.caps.nose.base[0][1] + 0.3), spots = [];
  for (const side of [-1, 1]) {
    const spot = new THREE.SpotLight(0xfff1d6, 0, 110, 0.55, 0.7, 1.6);
    spot.position.set(side * lampAt[0], lampAt[1], lampAt[2] - 0.1);
    spot.target.position.set(side * lampAt[0] * 0.5, -0.5, hl + 30);
    rig.add(spot, spot.target);
    spots.push(spot);
  }
  // The light the headlamps throw on the road: a glowing patch laid on the ground ahead. The spot
  // lights above reach walls and trees, but at such a shallow angle they barely show on tarmac.
  const beamCanvas = document.createElement('canvas');
  beamCanvas.width = 128;
  beamCanvas.height = 256;
  const bg = beamCanvas.getContext('2d');
  for (let row = 0; row < 256; row++) {      // the car is at the bottom of the picture
    const t = 1 - row / 255;                 // 0 at the bumper, 1 at the far end
    const strength = Math.min(1, t / 0.05) * (1 - t) ** 1.7, spread = 0.16 + 0.34 * t;
    const across = bg.createLinearGradient(0, 0, 128, 0);
    across.addColorStop(Math.max(0, 0.5 - spread), 'rgba(255,255,255,0)');
    across.addColorStop(0.5 - spread * 0.45, `rgba(255,255,255,${strength * 0.75})`);
    across.addColorStop(0.5, `rgba(255,255,255,${strength})`);
    across.addColorStop(0.5 + spread * 0.45, `rgba(255,255,255,${strength * 0.75})`);
    across.addColorStop(Math.min(1, 0.5 + spread), 'rgba(255,255,255,0)');
    bg.fillStyle = across;
    bg.fillRect(0, row, 128, 1);
  }
  const beamMat = new THREE.MeshBasicMaterial({
    map: new THREE.CanvasTexture(beamCanvas), color: 0xfff0d2, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -16, polygonOffsetUnits: -64,
  });
  const beam = new THREE.Mesh(new THREE.PlaneGeometry(18, 46).rotateX(-Math.PI / 2).rotateY(Math.PI), beamMat);
  beam.position.set(0, 0.26, centerZ + hl + 22.6);
  beam.renderOrder = 2;
  root.add(beam);

  // ---- wheels sit on the root so they stay planted while the chassis rolls
  const wheels = [], wg = wheelGeometry(R, spec.wheel);
  const caliperMat = std({ color: spec.wheel.caliper ?? 0x3a3d42, roughness: 0.5, metalness: 0.4 });
  const caliperGeo = new THREE.BoxGeometry(0.05, R * 0.3, R * 0.52);
  for (const [z, isFront] of [[a, true], [-b, false]]) {
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * (W / 2 - spec.wheel.width / 2 - 0.025), R, z);
      const spin = new THREE.Group(), face = new THREE.Group();
      face.rotation.y = side > 0 ? 0 : Math.PI;       // outer face away from the car
      spin.add(face);
      pivot.add(spin);
      add(wg.tyre, tyreMat, 0, 0, 0, face);
      add(wg.rim, rimMat, 0, 0, 0, face);
      add(wg.disc, discMat, 0, 0, 0, face, false);
      add(caliperGeo, caliperMat, side * (spec.wheel.width / 2 - 0.1), R * 0.2, -R * 0.36, pivot, false);
      root.add(pivot);
      wheels.push({ pivot, spin, front: isFront });
    }
  }

  const setColour = c => {
    paint.color.set(c.hex);
    paint.metalness = c.metal;
    paint.userData.rough = 0.42 - 0.2 * c.metal;
    paint.roughness = paint.userData.rough;
  };
  setColour(colour);

  const eye = new THREE.Vector3(0.36, eyeY, centerZ + eyeZ);
  // top and bottom edge of the windscreen in front of the driver, in chassis space
  const screen = [new THREE.Vector3(0.36, shell.top(header), centerZ + header), new THREE.Vector3(0.36, shell.at(cowl).belt + 0.05, centerZ + cowl)];
  const bonnet = new THREE.Vector3(0, shell.top(cowl) + 0.3, centerZ + cowl - 0.1);      // where the bonnet camera sits
  return { root, chassis, wheels, paint, lamps, beamMat, beam, spots, steeringWheel, eye, bonnet, screen, centerZ, setColour, interior, parts: [chassis, beam, ...wheels.map(w => w.pivot)] };
}
