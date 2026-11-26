import * as THREE from 'three';
import { snowable } from './shared.js';
import { EDGE } from './data.js';

// What is built around the decks of src/map/data.js: a bridge's slab, parapets and piers, and an
// underpass's roof, walls, portals and lamps. Also where those are solid (see solidsOf).
// A deck is { kind: 'bridge' | 'lid', road, pts: [[x, z]], h: [height], s: [distance along], half }.

const SLAB = 0.8, PARAPET = 0.95, RIM = 0.3;
const BARRIER = new THREE.Color(0xd9a520), CONCRETE = new THREE.Color(0x9c9fa1), SOFFIT = new THREE.Color(0x6c7074), PAVED = new THREE.Color(0xa9a69d), TILE = new THREE.Color(0xb9bcb4);
let materials = null;
const kit = () => (materials ||= {
  concrete: snowable(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 0.7),
  lamp: new THREE.MeshBasicMaterial({ color: 0xffe9b8 }),
  cable: new THREE.LineBasicMaterial({ color: 0x7f8891 }),
});

// The cross-sections of a deck: position, height, and the unit vector to the right of travel.
function frames(deck) {
  return deck.pts.map(([x, z], k) => {
    const a = deck.pts[Math.max(0, k - 1)], b = deck.pts[Math.min(deck.pts.length - 1, k + 1)], len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return { x, z, h: deck.h[k], s: deck.s[k], rx: -(b[1] - a[1]) / len, rz: (b[0] - a[0]) / len };
  });
}
// Is there another deck at about this height here? (Where a ramp runs into the carriageway, or two decks
// lie side by side, there is no parapet between them.)
const joins = (map, deck, x, z, h) => map.decksAt(x, z).some(e => e.deck !== deck && e.deck.kind === 'bridge' && Math.abs(e.h - h) < map.MERGE && map.joined(deck, e.deck, x, z));
// an end of a deck that neither comes down to the ground nor runs on into another deck: the road stops in the air
const cutOff = (deck, i) => !deck.landed[i] && !deck.chained[i];
// The suspended span of the Gwangan bridge: between these two points of the map the decks hang from two towers.
const SPAN = { from: [-1141, 1004], to: [-1705, 1716], tower: 118, towersAt: [0.22, 0.78] };

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
          const out = side * half, inn = side * (half - RIM), m = at({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, rx: a.rx, rz: a.rz }, side * (half + 0.4), 0);
          if (joins(map, deck, m[0], m[2], (a.h + b.h) / 2)) continue;         // open towards the deck alongside
          quad(at(a, out, a.h - SLAB), at(b, out, b.h - SLAB), at(b, out, b.h + PARAPET), at(a, out, a.h + PARAPET), CONCRETE);    // outer face, slab and parapet in one
          quad(at(a, inn, a.h), at(b, inn, b.h), at(b, inn, b.h + PARAPET), at(a, inn, a.h + PARAPET), CONCRETE);
          quad(at(a, inn, a.h + PARAPET), at(b, inn, b.h + PARAPET), at(b, out, b.h + PARAPET), at(a, out, a.h + PARAPET), TILE);
        }
      }
      [f[0], f.at(-1)].forEach((end, i) => {
        // the end of the slab; and where the road stops in the air (the edge of what is mapped), a wall across it
        quad(at(end, -half, end.h - SLAB), at(end, half, end.h - SLAB), at(end, half, end.h + (cutOff(deck, i) ? 1.6 : 0)), at(end, -half, end.h + (cutOff(deck, i) ? 1.6 : 0)), cutOff(deck, i) ? BARRIER : CONCRETE);
      });
      // piers, where the deck is high enough off the ground and nothing runs underneath
      const span = deck.s.at(-1), n = Math.max(0, Math.round(span / 24) - 1);
      for (let i = 1; i <= n; i++) {
        const s = span * i / (n + 1), k = Math.max(1, deck.s.findIndex(v => v >= s)), q = f[k];
        const foot = ground(q.x, q.z), others = map.decksAt(q.x, q.z).map(e => ({ deck: e.deck, h: e.h })), t = 0.7;
        // (where decks are stacked, the lowest one's piers carry them all: two legs outside its edges, up to the topmost)
        if (q.h - SLAB - foot < 2.5 || !clearOf(q.x, q.z, deck.road) || others.some(e => e.deck !== deck && e.h < q.h - 2)) continue;
        const stacked = others.some(e => e.deck !== deck && e.h > q.h + 2), top = Math.max(q.h, ...others.map(e => e.h)) - SLAB;
        const ux = q.rz, uz = -q.rx;                    // along the deck
        const legs = stacked ? [[-(half + 0.9), 0.8], [half + 0.9, 0.8]] : [[0, deck.road.w * 0.3]];
        for (const [off, w] of legs) {
          // (not up through another deck beside this one)
          const lx = q.x + q.rx * off, lz = q.z + q.rz * off;
          if (map.decksAt(lx, lz).some(e => e.deck !== deck && e.h > foot + 0.3 && e.h - SLAB < top - 0.3 && !(stacked && e.h > q.h + 2 && Math.abs(off) > half))) continue;
          const corner = (i, j, y) => [q.x + q.rx * (off + w * i) + ux * t * j, y, q.z + q.rz * (off + w * i) + uz * t * j];
          for (const [i0, j0, i1, j1] of [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]]) {
            quad(corner(i0, j0, foot - 1), corner(i1, j1, foot - 1), corner(i1, j1, top), corner(i0, j0, top), CONCRETE);
          }
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
  const group = new THREE.Group(), cables = [];
  {
    const [ax, az] = SPAN.from, [bx, bz] = SPAN.to, mx = (ax + bx) / 2, mz = (az + bz) / 2;
    if (zone.owns(mx, mz) && map.covered(mx, mz)) {
      const len = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / len, uz = (bz - az) / len, rx = -uz, rz = ux, wide = 16;
      const deckY = map.top(mx, mz), along = t => [ax + (bx - ax) * t, az + (bz - az) * t];
      const box = (x, z, w, d, y0, y1) => {
        const c = (i, j, y) => [x + rx * w * i + ux * d * j, y, z + rz * w * i + uz * d * j];
        for (const [i0, j0, i1, j1] of [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]]) quad(c(i0, j0, y0), c(i1, j1, y0), c(i1, j1, y1), c(i0, j0, y1), CONCRETE);
        quad(c(-1, -1, y1), c(1, -1, y1), c(1, 1, y1), c(-1, 1, y1), CONCRETE);
      };
      for (const t of SPAN.towersAt) {
        const [x, z] = along(t);
        for (const side of [-1, 1]) box(x + rx * side * wide, z + rz * side * wide, 2.2, 3, -4, SPAN.tower);
        for (const y of [deckY - 4.2, deckY + 34, SPAN.tower - 8]) box(x, z, wide, 2, y, y + 3.2);
      }
      // the main cables, either side: down from the tower tops to the deck at the ends, hanging low in the middle
      const [t0, t1] = SPAN.towersAt, hang = (ta, tb, ya, yb, sag) => {
        for (const side of [-1, 1]) {
          for (let k = 0; k < 20; k++) {
            for (const j of [k, k + 1]) { const u = j / 20, [x, z] = along(ta + (tb - ta) * u); cables.push(x + rx * side * wide, ya + (yb - ya) * u - sag * 4 * u * (1 - u), z + rz * side * wide); }
            // the hangers down to the deck
            if (k % 2 === 0 && k > 0) { const u = k / 20, [x, z] = along(ta + (tb - ta) * u), y = ya + (yb - ya) * u - sag * 4 * u * (1 - u); cables.push(x + rx * side * wide, y, z + rz * side * wide, x + rx * side * wide, deckY, z + rz * side * wide); }
          }
        }
      };
      hang(t0, t1, SPAN.tower, SPAN.tower, SPAN.tower - deckY - 8);
      hang(0, t0, deckY + 2, SPAN.tower, 6);
      hang(t1, 1, SPAN.tower, deckY + 2, 6);
    }
  }
  if (cables.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(cables, 3));
    group.add(new THREE.LineSegments(geo, kit().cable));
  }
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
      // (only for what is on this deck, not for a deck over it; and none where another deck lies alongside)
      for (let k = 1; k < f.length; k++) {
        const a = f[k - 1], b = f[k], lo = Math.min(a.h, b.h) - 2.2, hi = Math.max(a.h, b.h) + 4;
        for (const side of [-1, 1]) {
          const mx = (a.x + b.x) / 2 + a.rx * side * (deck.half + 0.4), mz = (a.z + b.z) / 2 + a.rz * side * (deck.half + 0.4);
          if (!joins(map, deck, mx, mz, (a.h + b.h) / 2)) strip(a, b, side * (deck.half - RIM), side * (deck.half + 0.2), lo, hi);
        }
      }
      // where the road stops in the air, the wall across it
      [f[0], f.at(-1)].forEach((end, i) => {
        if (!cutOff(deck, i)) return;
        const ux = end.rz, uz = -end.rx, back = { ...end, x: end.x + ux * 0.4, z: end.z + uz * 0.4 }, front = { ...end, x: end.x - ux * 0.4, z: end.z - uz * 0.4 };
        strip(back, front, -deck.half, deck.half, end.h - 2.2, end.h + 4);
      });
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
