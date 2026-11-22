import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildShell, PAINT, GLASS, TRIM } from './carbody.js';
import { CARS, FRONT, REAR } from './cars.js';
import { KINDS } from './traffic.js';
import { LAYER } from './map/meshes.js';

// The cars of the traffic and the parked cars: the same bodies as the player's cars at lower detail,
// plus a taxi, a van, a small truck and a city bus. Each kind is drawn as a handful of instanced meshes.

const car = id => CARS.find(c => c.id === id);
const axlesOf = c => [0.03 - c.wheelbase / 2, 0.03 + c.wheelbase / 2];
// Bodies not among the player's cars. Same fields as CARS as far as the body goes (see cars.js).
const EXTRA = {
  van: {
    L: 5.2, W: 1.95, gc: 0.2, wheelR: 0.34, axles: [-1.5, 1.6], tyre: 0.23,
    shape: {
      top: [[-2.6, 1.7], [-2.46, 1.85], [-2.3, 1.93], [0.9, 1.95], [1.35, 1.9], [2.05, 1.2], [2.38, 1.02], [2.6, 1.0]],
      belt: [[-2.6, 1.15], [1.5, 1.12], [2.05, 1.08], [2.38, 0.95], [2.6, 0.95]],
      tumble: 0.16, nose: { d: 0.22, nx: 3, ny: 3.4 }, tail: { d: 0.14, nx: 4.5, ny: 5 },
      glass: { front: [1.37, 2.03], rear: [-2.45, -2.44], side: [-2.3, 1.9] }, pillars: [0.9, -0.4, -1.5],
      front: { grille: { x: [0, 0.4], y: [0.5, 0.68] } }, rear: { tail: { x: [0.72, 0.97], y: [0.45, 0.85] }, blink: { x: [0.72, 0.95], y: [0.36, 0.42] }, reverse: null },
    },
    windows: [['tail', { x: [0, 0.66], y: [0.56, 0.9] }]],
  },
  truck: {
    L: 5.1, W: 1.76, gc: 0.22, wheelR: 0.33, axles: [-1.35, 1.75], tyre: 0.2,
    shape: {
      top: [[-2.55, 0.95], [0.9, 0.95], [1.02, 1.9], [1.2, 1.97], [2.0, 1.95], [2.43, 1.86], [2.55, 1.8]],
      belt: [[-2.55, 0.93], [0.9, 0.93], [1.0, 1.15], [2.55, 1.12]],
      tumble: 0.1, nose: { d: 0.12, nx: 5, ny: 5 }, tail: { d: 0.1, nx: 5, ny: 5 },
      glass: { front: [9, 9.1], rear: [-9.1, -9], side: [1.12, 2.28] }, pillars: [],
      front: { head: { x: [0.55, 0.95], y: [0.24, 0.34] }, drl: null, blink: { x: [0.8, 0.95], y: [0.16, 0.21] }, grille: { x: [0, 0.5], y: [0.27, 0.36] }, intake: null },
      rear: { tail: { x: [0.7, 0.95], y: [0.3, 0.62] }, blink: { x: [0.7, 0.95], y: [0.7, 0.85] }, reverse: null },
    },
    windows: [['nose', { x: [0, 0.9], y: [0.5, 0.86] }]],
    // the load bed: side boards, tail board and a head board behind the cab
    boxes: [[0.05, 0.36, 3.3, 0.83, 1.12, -0.8], [0.05, 0.36, 3.3, -0.83, 1.12, -0.8], [1.7, 0.36, 0.05, 0, 1.12, -2.45], [1.7, 0.9, 0.06, 0, 1.4, 0.88]].map(b => [...b, 0x8d949b]),
  },
  bus: {
    L: 10.8, W: 2.48, gc: 0.33, wheelR: 0.48, axles: [-2.9, 3.0], tyre: 0.3,
    shape: {
      top: [[-5.4, 3.0], [-5.2, 3.08], [0, 3.1], [5.2, 3.08], [5.4, 3.0]], belt: [[-5.4, 1.75], [5.4, 1.75]],
      tumble: 0.04, nose: { d: 0.16, nx: 6, ny: 6 }, tail: { d: 0.14, nx: 6, ny: 6 },
      glass: { front: [19, 19.1], rear: [-19.1, -19], side: [-4.9, 4.85] }, pillars: [-4.2, -2.8, -1.4, 0, 1.4, 2.8, 4.2],
      front: { head: { x: [0.55, 0.95], y: [0.13, 0.2] }, drl: null, blink: { x: [0.8, 0.95], y: [0.07, 0.11] }, grille: null, intake: null },
      rear: { tail: { x: [0.72, 0.95], y: [0.12, 0.3] }, blink: { x: [0.72, 0.95], y: [0.33, 0.4] }, reverse: null },
    },
    windows: [['nose', { x: [0, 0.93], y: [0.42, 0.9] }], ['tail', { x: [0, 0.8], y: [0.6, 0.86] }]],
  },
};
const body = id => (EXTRA[id] ? EXTRA[id] : { ...car(id === 'taxi' ? 'sedan' : id), axles: axlesOf(car(id === 'taxi' ? 'sedan' : id)), tyre: car(id === 'taxi' ? 'sedan' : id).wheel.width });

// Paint colours seen on Korean streets, the common ones several times over.
const PAINTS = [0xd9dbd6, 0xd9dbd6, 0xd9dbd6, 0xe9e9e6, 0xb3b8be, 0xb3b8be, 0x8a9097, 0x1b1d21, 0x1b1d21, 0x2b3038, 0x1d4e9e, 0x9a1c22, 0x5f7385, 0x6b5a45];
const FLEET = { taxi: [0xd9dbd6, 0xb3b8be, 0xe07b1a], bus: [0x1f5fa8, 0x2f8f4e, 0x1f5fa8], truck: [0xdfe2e4, 0x2459a6, 0xdfe2e4] };
export const paintOf = (kind, tint) => { const list = FLEET[kind] || PAINTS; return list[Math.floor(tint * list.length) % list.length]; };
const LAMP = { head: 0x9aa2aa, tail: 0x7a1014, left: 0x9a5f14, right: 0x9a5f14 };      // lens colours, unlit
const PARTS = ['other', 'paint', 'head', 'tail', 'left', 'right'];

function part(geo, group) {            // the triangles of one material group of a shell, as loose triangles
  const g = geo.groups[group], out = new THREE.BufferGeometry();
  out.setAttribute('position', geo.attributes.position);
  out.setAttribute('normal', geo.attributes.normal);
  out.setIndex(Array.from(geo.index.array.slice(g.start, g.start + g.count)));
  return out.toNonIndexed();
}
function tinted(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo, c = new THREE.Color(hex), n = g.attributes.position.count, colours = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.toArray(colours, i * 3);
  g.deleteAttribute('uv');
  g.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  return g;
}

// Two levels of detail: the moving cars, and the parked ones, which there are many more of.
const MOVING = { step: 0.3, arch: 5, sub: 2, cap: 5, patch: [6, 1], wheel: 12 };
const STANDING = { step: 0.6, arch: 3, sub: 1, cap: 3, patch: [3, 1], wheel: 8 };

function buildKind(id, detail) {
  const spec = body(id), s = spec.shape, R = spec.wheelR, W = spec.W;
  const shell = buildShell(spec, spec.axles.map(z => ({ z, y: R, r: R + 0.07 })), detail);
  const paint = part(shell.geometry, PAINT);
  const others = [tinted(part(shell.geometry, GLASS), 0x0d1319), tinted(part(shell.geometry, TRIM), 0x141618)];
  const box = (w, h, d, x, y, z, hex) => others.push(tinted(new THREE.BoxGeometry(w, h, d).translate(x, y, z), hex));
  box(W - 0.5, 0.4, spec.L - 0.7, 0, spec.gc + 0.22, 0, 0x101113);
  for (const z of spec.axles) {
    for (const side of [-1, 1]) {
      const x = side * (W / 2 - spec.tyre / 2 - 0.025);
      others.push(tinted(new THREE.CylinderGeometry(R, R, spec.tyre, detail.wheel).rotateZ(Math.PI / 2).translate(x, R, z), 0x0e0f11));
      others.push(tinted(new THREE.CircleGeometry(R * 0.6, detail.wheel).rotateY(side * Math.PI / 2).translate(x + side * (spec.tyre / 2 + 0.006), R, z), 0x9a9fa6));
    }
  }
  for (const b of spec.boxes || []) box(...b);
  if (id === 'taxi') box(0.34, 0.13, 0.16, 0, shell.top(-0.2) + 0.06, -0.2, 0xf2c230);
  // patches are part of the same mesh as the body, so they sit a little proud of it instead of relying on a depth offset
  const proud = (end, geo) => geo.translate(0, 0, end === 'nose' ? 0.02 : -0.02);
  for (const [end, area] of spec.windows || []) others.push(tinted(proud(end, shell.patch(end, area, 0)), 0x0d1319));
  const front = { ...FRONT, ...s.front }, rear = { ...REAR, ...s.rear };
  for (const [end, name] of [['nose', 'grille'], ['nose', 'intake'], ['tail', 'intake']]) {
    const area = (end === 'nose' ? front : rear)[name];
    if (area) others.push(tinted(proud(end, shell.patch(end, area, 0)), 0x0b0c0e));
  }
  const lay = (end, area, side) => (area ? [proud(end, shell.patch(end, area, side)).toNonIndexed()] : []);
  const lamps = {
    head: [1, -1].flatMap(side => lay('nose', front.head, side)),
    tail: rear.tail.bar ? lay('tail', rear.tail, 0) : [1, -1].flatMap(side => lay('tail', rear.tail, side)),
    left: [...lay('nose', front.blink, 1), ...lay('tail', rear.blink, 1)],
    right: [...lay('nose', front.blink, -1), ...lay('tail', rear.blink, -1)],
  };
  const geometry = { paint, other: mergeGeometries(others) };
  for (const [name, list] of Object.entries(lamps)) geometry[name] = mergeGeometries(list);
  // The whole car as one mesh for the moving traffic. `part` says what each corner belongs to: 0 fixed
  // colour, 1 paint, 2 headlamps, 3 tail lamps, 4 left and 5 right turn signals.
  const whole = mergeGeometries(PARTS.map((name, k) => {
    const g = name === 'other' ? geometry.other.clone() : tinted(geometry[name].clone(), name === 'paint' ? 0xffffff : LAMP[name]);
    g.setAttribute('part', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(k), 1));
    return g;
  }));
  return { id, geometry, whole };
}

// Geometry and materials shared by the moving traffic and the parked cars.
export function createTrafficKit() {
  const kinds = Object.fromEntries(KINDS.map(k => [k.id, buildKind(k.id, MOVING)]));
  const standing = {};                 // built when first needed: only some kinds are ever parked
  const materials = {
    parked: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.4 }),
  };
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1), at = new THREE.Vector3();

  // One mesh holding all the parked cars of a zone. list: [{ x, z, heading, kind, tint }].
  function parkedMesh(list, ground) {
    const parts = [];
    for (const p of list) {
      const g = (standing[p.kind] ||= buildKind(p.kind, STANDING)).geometry;
      m.compose(at.set(p.x, ground(p.x, p.z) + LAYER.sidewalk * 0.3, p.z), q.setFromAxisAngle(UP, p.heading), one);
      parts.push(tinted(g.paint.clone(), paintOf(p.kind, p.tint)).applyMatrix4(m), g.other.clone().applyMatrix4(m));
      for (const name of ['head', 'tail', 'left', 'right']) parts.push(tinted(g[name].clone(), name === 'head' ? 0x8e979f : name === 'tail' ? 0x5c0d10 : 0x8a5a1c).applyMatrix4(m));
    }
    const mesh = new THREE.Mesh(mergeGeometries(parts), materials.parked);
    mesh.castShadow = mesh.receiveShadow = true;
    return mesh;
  }
  return { kinds, materials, parkedMesh };
}

// The material of one moving car: its paint colour and how brightly each group of lamps glows are
// set per car, the rest comes from the colours stored in the mesh.
function carMaterial() {
  const uniforms = { uPaint: { value: new THREE.Color() }, uLamps: { value: new THREE.Vector4() } };
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.4, roughness: 0.36, side: THREE.DoubleSide });
  m.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = `attribute float part;
uniform vec3 uPaint;
uniform vec4 uLamps;
varying float vGlow;
${shader.vertexShader}`.replace(
      '#include <color_vertex>',
      `#include <color_vertex>
  vGlow = 0.0;
  if (part > 0.5 && part < 1.5) vColor.rgb = uPaint;
  else if (part > 1.5) vGlow = part < 2.5 ? uLamps.x : part < 3.5 ? uLamps.y : part < 4.5 ? uLamps.z : uLamps.w;`,
    );
    shader.fragmentShader = `varying float vGlow;
${shader.fragmentShader}`.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
  totalEmissiveRadiance += diffuseColor.rgb * vGlow;`,
    );
  };
  m.customProgramCacheKey = () => 'trafficcar';
  m.userData.uniforms = uniforms;
  return m;
}

// Draws the cars of a traffic simulation: one mesh per car, taken from a pool. (Instancing was tried
// first; rewriting the instance buffers every frame stalled the graphics card for several milliseconds.)
// ground(x, z): height of the road.
export function createTrafficView(kit, scene, ground) {
  const group = new THREE.Group(), pools = Object.fromEntries(Object.keys(kit.kinds).map(id => [id, []]));
  scene.add(group);
  const take = (id, i) => {
    const pool = pools[id];
    if (!pool[i]) {
      const mesh = pool[i] = new THREE.Mesh(kit.kinds[id].whole, carMaterial());
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.rotation.order = 'YXZ';
      group.add(mesh);
    }
    return pool[i];
  };

  return {
    group,
    // lights: the cars have their lamps on; time: seconds, for the blinkers
    sync(cars, { lights, time }) {
      const used = {}, blink = time % 0.72 < 0.36;
      for (const c of cars) {
        const i = used[c.kind.id] || 0, mesh = take(c.kind.id, i), u = mesh.material.userData.uniforms;
        used[c.kind.id] = i + 1;
        const half = c.len * 0.35, front = ground(c.x + c.ux * half, c.z + c.uz * half), back = ground(c.x - c.ux * half, c.z - c.uz * half);
        mesh.position.set(c.x, (front + back) / 2 + LAYER.major, c.z);
        mesh.rotation.set(-Math.atan2(front - back, 2 * half), Math.atan2(c.ux, c.uz), 0);
        mesh.visible = true;
        u.uPaint.value.setHex(paintOf(c.kind.id, c.tint));
        u.uLamps.value.set(lights ? 5 : 0, c.braking ? 12 : lights ? 3 : 0, blink && c.signal === 'L' ? 12 : 0, blink && c.signal === 'R' ? 12 : 0);
      }
      for (const [id, pool] of Object.entries(pools)) for (let i = used[id] || 0; i < pool.length; i++) pool[i].visible = false;
    },
  };
}
