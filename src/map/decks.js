import * as THREE from 'three';
import { snowable } from './shared.js';
import { EDGE } from './data.js';

// What is built around the decks of src/map/data.js: a bridge's slab, parapets and piers, and an
// underpass's roof, walls, portals and lamps. Also where those are solid (see solidsOf).
// A deck is { kind: 'bridge' | 'lid', road, pts: [[x, z]], h: [height], s: [distance along], half }.

const SLAB = 0.8, PARAPET = 0.95, RIM = 0.3;
const CONCRETE = new THREE.Color(0x9c9fa1), SOFFIT = new THREE.Color(0x6c7074), PAVED = new THREE.Color(0xa9a69d), TILE = new THREE.Color(0xb9bcb4);
let materials = null;
const kit = () => (materials ||= {
  concrete: snowable(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 0.7),
  lamp: new THREE.MeshBasicMaterial({ color: 0xffe9b8 }),
});

// The cross-sections of a deck: position, height, and the unit vector to the right of travel.
function frames(deck) {
  return deck.pts.map(([x, z], k) => {
    const a = deck.pts[Math.max(0, k - 1)], b = deck.pts[Math.min(deck.pts.length - 1, k + 1)], len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return { x, z, h: deck.h[k], s: deck.s[k], rx: -(b[1] - a[1]) / len, rz: (b[0] - a[0]) / len };
  });
}
// the inner faces of an underpass's walls are this far from its centre line
const wallAt = deck => deck.road.w / 2 + 1;

// zone: { owns(x, z) }. ground(x, z): the terrain. clearOf(x, z, road): no other road at that spot.
export function buildStructures(map, zone, clearOf) {
  const ground = map.ground, pos = [], col = [], lamps = [];
  const quad = (a, b, c, d, colour, into = pos) => {
    into.push(...a, ...b, ...c, ...a, ...c, ...d);
    if (into === pos) for (let i = 0; i < 6; i++) col.push(colour.r, colour.g, colour.b);
  };
  for (const deck of map.decks) {
    const mid = deck.pts[deck.pts.length >> 1];
    if (!zone.owns(mid[0], mid[1])) continue;
    const f = frames(deck), at = (q, off, y) => [q.x + q.rx * off, y, q.z + q.rz * off];
    if (deck.kind === 'bridge') {
      const half = deck.half;
      for (let k = 1; k < f.length; k++) {
        const a = f[k - 1], b = f[k];
        quad(at(a, -half, a.h - 0.02), at(b, -half, b.h - 0.02), at(b, half, b.h - 0.02), at(a, half, a.h - 0.02), PAVED);        // top, under the tarmac
        quad(at(a, -half, a.h - SLAB), at(a, half, a.h - SLAB), at(b, half, b.h - SLAB), at(b, -half, b.h - SLAB), SOFFIT);         // underside
        for (const side of [-1, 1]) {
          const out = side * half, inn = side * (half - RIM);
          quad(at(a, out, a.h - SLAB), at(b, out, b.h - SLAB), at(b, out, b.h + PARAPET), at(a, out, a.h + PARAPET), CONCRETE);    // outer face, slab and parapet in one
          quad(at(a, inn, a.h), at(b, inn, b.h), at(b, inn, b.h + PARAPET), at(a, inn, a.h + PARAPET), CONCRETE);
          quad(at(a, inn, a.h + PARAPET), at(b, inn, b.h + PARAPET), at(b, out, b.h + PARAPET), at(a, out, a.h + PARAPET), TILE);
        }
      }
      for (const end of [f[0], f.at(-1)]) quad(at(end, -half, end.h - SLAB), at(end, half, end.h - SLAB), at(end, half, end.h), at(end, -half, end.h), CONCRETE);
      // piers, where the deck is high enough off the ground and nothing runs underneath
      const span = deck.s.at(-1), n = Math.max(0, Math.round(span / 24) - 1);
      for (let i = 1; i <= n; i++) {
        const s = span * i / (n + 1), k = Math.max(1, deck.s.findIndex(v => v >= s)), q = f[k];
        const foot = ground(q.x, q.z), top = q.h - SLAB, w = deck.road.w * 0.3, t = 0.7;
        if (top - foot < 2.5 || !clearOf(q.x, q.z, deck.road)) continue;
        const ux = q.rz, uz = -q.rx;                    // along the deck
        const corner = (i, j, y) => [q.x + q.rx * w * i + ux * t * j, y, q.z + q.rz * w * i + uz * t * j];
        for (const [i0, j0, i1, j1] of [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]]) {
          quad(corner(i0, j0, foot - 1), corner(i1, j1, foot - 1), corner(i1, j1, top), corner(i0, j0, top), CONCRETE);
        }
      }
    } else {
      const half = deck.half, wall = wallAt(deck), roof = SLAB * 0.75;
      const floor = f.map(q => ground(q.x, q.z));
      for (let k = 1; k < f.length; k++) {
        const a = f[k - 1], b = f[k], fa = floor[k - 1] - 0.3, fb = floor[k] - 0.3;
        // the ground over it: level in the middle, and meeting the ground either side at its edges
        const flat = half - EDGE, rim = (q, off) => at(q, off, ground(q.x + q.rx * off, q.z + q.rz * off));
        quad(at(a, -flat, a.h), at(b, -flat, b.h), at(b, flat, b.h), at(a, flat, a.h), PAVED);
        for (const side of [-1, 1]) quad(at(a, side * flat, a.h), at(b, side * flat, b.h), rim(b, side * half), rim(a, side * half), PAVED);
        quad(at(a, -wall, a.h - roof), at(a, wall, a.h - roof), at(b, wall, b.h - roof), at(b, -wall, b.h - roof), SOFFIT);         // ceiling
        for (const side of [-1, 1]) {
          quad(at(a, side * wall, fa), at(b, side * wall, fb), at(b, side * wall, b.h - roof), at(a, side * wall, a.h - roof), TILE);
        }
        // a lamp on the ceiling every 7.5 m, on both sides
        if (k % 3 === 0) {
          const ux = a.rz, uz = -a.rx;
          for (const side of [-1, 1]) {
            const cx = a.x + a.rx * side * wall * 0.55, cz = a.z + a.rz * side * wall * 0.55, y = a.h - roof - 0.04;
            const p = (i, j) => [cx + a.rx * 0.22 * i + ux * 1.1 * j, y, cz + a.rz * 0.22 * i + uz * 1.1 * j];
            quad(p(-1, -1), p(1, -1), p(1, 1), p(-1, 1), null, lamps);
          }
        }
      }
      // the portals: a face either side of the opening, the edge of the roof over it, and a parapet on top
      f.forEach((end, k) => {
        if (k !== 0 && k !== f.length - 1) return;
        const base = floor[k] - 0.5;
        const flat = half - EDGE;                     // beyond this the roof slopes to the ground and needs no wall
        for (const side of [-1, 1]) quad(at(end, side * wall, base), at(end, side * flat, base), at(end, side * flat, end.h), at(end, side * wall, end.h), CONCRETE);
        quad(at(end, -wall, end.h - roof), at(end, wall, end.h - roof), at(end, wall, end.h + PARAPET), at(end, -wall, end.h + PARAPET), CONCRETE);
        for (const side of [-1, 1]) quad(at(end, side * wall, end.h), at(end, side * flat, end.h), at(end, side * flat, end.h + PARAPET), at(end, side * wall, end.h + PARAPET), CONCRETE);
      });
    }
  }
  const group = new THREE.Group();
  if (pos.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, kit().concrete);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (lamps.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(lamps, 3));
    const mesh = new THREE.Mesh(geo, kit().lamp);
    mesh.material.side = THREE.DoubleSide;
    group.add(mesh);
  }
  return group;
}

// Where the structures are solid: [{ p: flat outline, lo, hi }] - in the way of anything whose height is between lo and hi.
export function solidsOf(map) {
  const out = [];
  for (const deck of map.decks) {
    const f = frames(deck);
    const strip = (a, b, from, to, lo, hi) => out.push({
      p: [a.x + a.rx * from, a.z + a.rz * from, b.x + b.rx * from, b.z + b.rz * from, b.x + b.rx * to, b.z + b.rz * to, a.x + a.rx * to, a.z + a.rz * to], lo, hi,
    });
    if (deck.kind === 'bridge') {
      // the parapets, for what is on the deck
      for (let k = 1; k < f.length; k++) {
        const a = f[k - 1], b = f[k], lo = Math.min(a.h, b.h) - 2.2;
        for (const side of [-1, 1]) strip(a, b, side * (deck.half - RIM), side * (deck.half + 0.2), lo, Infinity);
      }
    } else {
      // the walls, for what is in the underpass; and the parapets over the portals, for what is on top
      const wall = wallAt(deck);
      for (let k = 1; k < f.length; k++) {
        const a = f[k - 1], b = f[k], hi = Math.min(a.h, b.h) - 2.2;
        for (const side of [-1, 1]) strip(a, b, side * wall, side * (wall + 0.7), -Infinity, hi);
      }
      for (const end of [f[0], f.at(-1)]) {
        const ux = end.rz, uz = -end.rx, back = { ...end, x: end.x + ux * 0.5, z: end.z + uz * 0.5 }, front = { ...end, x: end.x - ux * 0.5, z: end.z - uz * 0.5 };
        strip(back, front, -(deck.half - EDGE), deck.half - EDGE, end.h - 2.2, Infinity);
      }
    }
  }
  return out;
}
