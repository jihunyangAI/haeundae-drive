import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// The small things that make a body read as a car: the gaps round the bonnet and the boot, the strip
// under the windows, the bars of the grille, the eyes of the headlamps, badges, the high brake light,
// a glass roof. Everything of one material is joined into one mesh, so the lot costs a handful of draws.
//
// shell: from buildShell (carbody.js). front, rear: the lamp and grille patches of this car (cars.js).
// mats: { paint, dark, chrome, grille, lamps, decal(options) }. rz: the rear axle, in the body's z.
const lerp = (a, b, t) => a + (b - a) * t;
const BELT = 6, SHOULDER = 7, RAIL = 8, CROWN = 9;          // points of a cross-section (see carbody.js)

export function addDetails({ spec, shell, body, front, rear, mats, rz }) {
  const s = spec.shape, hl = spec.L / 2, W = spec.W, zF = hl - s.nose.d, zR = -hl + s.tail.d;
  const cowl = s.glass.front[1], [rearLow, rearHigh] = s.glass.rear;
  const { paint, dark, chrome, grille, lamps, decal } = mats;
  const darkChrome = decal({ color: 0x4a4e54, metalness: 0.95, roughness: 0.28 });
  const reflector = decal({ color: 0x8e1016, roughness: 0.35, metalness: 0.2 });
  const badgeMat = decal({ color: 0xd8dce1, metalness: 1, roughness: 0.16 });
  const roofGlass = decal({ color: 0x07090c, metalness: 0.75, roughness: 0.05 });
  const skid = decal({ color: 0x9aa0a6, metalness: 0.8, roughness: 0.45 });

  // ---- collecting
  const buckets = new Map(), segments = [];
  const put = (mat, geo, x = 0, y = 0, z = 0, turn = 0) => {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (turn) g.rotateY(turn);
    g.translate(x, y, z);
    if (!buckets.has(mat)) buckets.set(mat, []);
    buckets.get(mat).push(g);
  };
  const line = (points, closed = false) => {
    for (let i = 1; i < points.length; i++) segments.push(points[i - 1], points[i]);
    if (closed && points.length > 2) segments.push(points.at(-1), points[0]);
  };
  const point = (z, side, span) => shell.seam(z, side, span, span)[0];
  const run = (from, to, step, each) => { const n = Math.max(1, Math.round(Math.abs(to - from) / step)); return Array.from({ length: n + 1 }, (unused, i) => each(lerp(from, to, i / n))); };

  // ---- measurements of the two ends
  const ends = {};
  for (const end of ['nose', 'tail']) {
    const cap = shell.caps[end];
    ends[end] = { cap, hw: cap.base.reduce((m, p) => Math.max(m, p[0]), 0), yb: cap.base[0][1], yt: cap.base[cap.base.length / 2][1] };
  }
  // a place on the nose or tail (x and y as fractions, like the patches) and which way the surface faces there
  const frame = (end, fx, fy, out = 0.012) => {
    const e = ends[end], x = fx * e.hw, y = lerp(e.yb, e.yt, fy), p = shell.onCap(end, x, y);
    const a = shell.onCap(end, x - 0.03, y), b = shell.onCap(end, x + 0.03, y);
    let nx = -(b[2] - a[2]), nz = b[0] - a[0];
    const len = Math.hypot(nx, nz) || 1;
    nx = nx / len * e.cap.dir;
    nz = nz / len * e.cap.dir;
    return { x: p[0] + nx * out, y: p[1], z: p[2] + nz * out, turn: Math.atan2(nx, nz) };
  };
  const patch = (end, mat, part, side, lift = 0.004) => put(mat, shell.patch(end, part, side), 0, 0, ends[end].cap.dir * lift);
  const disc = (end, mat, fx, fy, r, inner = 0, out = 0.012) => {
    const f = frame(end, fx, fy, out);
    put(mat, inner ? new THREE.RingGeometry(inner, r, 20) : new THREE.CircleGeometry(r, 20), f.x, f.y, f.z, f.turn);
  };

  // ---- the gaps between the panels
  // bonnet: across just behind the nose, and back along each wing to the screen
  const zb = zF - 0.03;
  for (const side of [1, -1]) {
    line(shell.seam(zb, side, BELT, CROWN));
    line(run(zb, cowl + 0.02, 0.12, z => point(z, side, SHOULDER)));
  }
  if (rearLow + hl > 0.45) {
    // a boot lid: across under the rear glass and down each side of the deck
    const zl = rearLow - 0.05;
    for (const side of [1, -1]) {
      line(shell.seam(zl, side, BELT, CROWN));
      line(run(zl, zR + 0.03, 0.12, z => point(z, side, SHOULDER)));
    }
  } else {
    // a tailgate: the gap runs round the back of the car
    for (const side of [1, -1]) line(shell.seam(zR + 0.07, side, 3, CROWN));
  }
  // the filler flap, over the rear wheel on the left
  {
    const m = shell.at(rz), lo = m.belt - 0.21, hi = m.belt - 0.08, corners = [];
    for (const z of [rz - 0.1, rz + 0.1]) {
      const side = shell.seam(z, 1, 4, BELT).filter(p => p.y >= lo && p.y <= hi);
      if (side.length >= 2) corners.push(z < rz ? [side[0], side.at(-1)] : [side.at(-1), side[0]]);
    }
    if (corners.length === 2) line(corners.flat(), true);
  }

  // ---- the strip under the side windows
  {
    const [g0, g1] = s.glass.side, mat = spec.cabin.sport ? dark : chrome, tall = 0.016;
    for (const side of [1, -1]) {
      const pts = run(g0 + 0.04, g1 - 0.04, 0.1, z => point(z, side, BELT)), pos = [];
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], ax = a.x + side * 0.004, bx = b.x + side * 0.004;
        const quad = [[ax, a.y - 0.004, a.z], [bx, b.y - 0.004, b.z], [bx, b.y - 0.004 + tall, b.z], [ax, a.y - 0.004 + tall, a.z]];
        for (const k of side > 0 ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]) pos.push(...quad[k]);          // (wound to face out from the car)
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      put(mat, geo);
    }
  }

  // ---- the nose
  if (front.grille) {
    const g = front.grille, bars = 4;
    for (let i = 0; i < bars; i++) {
      const y = lerp(g.y[0], g.y[1], (i + 0.5) / bars);
      patch('nose', darkChrome, { x: [g.x[0], g.x[1] * 0.97], y: [y - 0.009, y + 0.009] }, 0);
    }
    disc('nose', badgeMat, 0, (g.y[0] + g.y[1]) / 2, 0.05, 0, 0.02);
    disc('nose', grille, 0, (g.y[0] + g.y[1]) / 2, 0.036, 0.028, 0.022);
  } else disc('nose', badgeMat, 0, lerp(front.plate, 1, 0.55), 0.036, 0, 0.014);
  if (front.intake) {
    const g = front.intake;
    for (const t of [0.36, 0.68]) { const y = lerp(g.y[0], g.y[1], t); patch('nose', darkChrome, { x: [g.x[0], g.x[1] * 0.94], y: [y - 0.006, y + 0.006] }, 0); }
    // the openings at the corners, each with a small lamp in it
    for (const side of [1, -1]) {
      patch('nose', grille, { x: [Math.min(0.9, g.x[1] + 0.1), 0.94], y: [g.y[0] + 0.02, g.y[1] - 0.01], yOut: [g.y[0] + 0.05, g.y[1] + 0.02] }, side, 0);
      disc('nose', lamps.drl, side * 0.84, (g.y[0] + g.y[1]) / 2 + 0.03, 0.026);
    }
  }
  // the eyes of the headlamps: two bezels in each
  {
    const h = front.head, e = ends.nose, tall = (h.y[1] - h.y[0]) * (e.yt - e.yb);
    for (const side of [1, -1]) {
      for (const t of [0.26, 0.66]) {
        const fx = lerp(h.x[0], h.x[1], t), yOut = h.yOut || h.y, fy = (lerp(h.y[0], yOut[0], t) + lerp(h.y[1], yOut[1], t)) / 2, r = Math.min(0.055, tall * 0.4);
        disc('nose', darkChrome, side * fx, fy, r, r * 0.72);
        disc('nose', chrome, side * fx, fy, r * 0.3, 0, 0.013);
      }
    }
  }
  if (s.cladding) patch('nose', skid, { x: [0, 0.42], y: [0.01, 0.1] }, 0);

  // ---- the tail
  if (!rear.tail.bar) {
    // a dark line through each lamp, dividing it in two
    const t = rear.tail, yOut = t.yOut || t.y, mid = (t.y[0] + t.y[1]) / 2, midOut = (yOut[0] + yOut[1]) / 2;
    for (const side of [1, -1]) patch('tail', grille, { x: [t.x[0] + 0.02, t.x[1] - 0.03], y: [mid - 0.006, mid + 0.006], yOut: [midOut - 0.006, midOut + 0.006] }, side);
  }
  if (!rear.intake) patch('tail', grille, { x: [0, 0.72], y: [0.03, 0.13] }, 0, 0);
  for (const side of [1, -1]) patch('tail', reflector, { x: [0.6, 0.86], y: [0.15, 0.19], yOut: [0.17, 0.21] }, side);
  if (s.cladding) patch('tail', skid, { x: [0, 0.4], y: [0.01, 0.09] }, 0);
  disc('tail', badgeMat, 0, Math.min(0.9, rear.plate + 0.2), 0.034, 0, 0.014);
  // the dark inside of each exhaust pipe
  for (const x of spec.exhaust) {
    const p = shell.onCap('tail', x * W / 2, ends.tail.yb + 0.07);
    put(dark, new THREE.CircleGeometry(0.034, 14), p[0], p[1], p[2] - 0.03, Math.PI);
  }
  // the high brake light, along the top of the rear glass
  put(lamps.tail, new THREE.BoxGeometry(0.32, 0.012, 0.03), 0, shell.top(rearHigh - 0.04) + 0.004, rearHigh - 0.04);

  // ---- roof and mirrors
  if (s.sunroof) {
    const [z0, z1] = s.sunroof, N = 8, pos = [];
    const grid = [];
    for (let i = 0; i <= N; i++) {
      const z = lerp(z0, z1, i / N), half = shell.seam(z, 1, RAIL, CROWN), wide = shell.at(z).roofX * 0.62, row = [];
      for (let j = 0; j <= N; j++) {
        const x = lerp(-wide, wide, j / N), ax = Math.abs(x);
        // the height of the roof at this distance from the middle (the points run from the rail in to the centre)
        let y = half.at(-1).y;
        for (let k = 1; k < half.length; k++) if (ax <= half[k - 1].x && ax >= half[k].x) { y = lerp(half[k - 1].y, half[k].y, (half[k - 1].x - ax) / Math.max(1e-6, half[k - 1].x - half[k].x)); break; }
        row.push([x, y + 0.005, z]);
      }
      grid.push(row);
    }
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) for (const [a, b] of [[i, j], [i, j + 1], [i + 1, j + 1], [i, j], [i + 1, j + 1], [i + 1, j]]) pos.push(...grid[a][b]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    put(roofGlass, geo);
  }
  {
    // a turn signal under each door mirror
    const mz = cowl - 0.2, m = shell.at(mz);
    for (const side of [1, -1]) put(side > 0 ? lamps.left : lamps.right, new THREE.BoxGeometry(0.07, 0.012, 0.014), side * (m.beltX + 0.12), m.belt + 0.045, mz + 0.05);
  }
  // a lip on the boot of the fast one, a spoiler over the rear glass of the hatchback
  if (spec.cabin.sport) put(paint, new THREE.BoxGeometry(W * 0.7, 0.02, 0.1), 0, shell.top(zR + 0.04) + 0.012, zR + 0.04);
  else if (rearLow + hl <= 0.45 && !s.cladding) put(paint, new THREE.BoxGeometry(W * 0.66, 0.024, 0.2), 0, shell.top(rearHigh) - 0.004, rearHigh - 0.09);

  // ---- one mesh of each material, and all the gaps as one set of lines
  for (const [mat, list] of buckets) {
    const mesh = new THREE.Mesh(mergeGeometries(list), mat);
    mesh.castShadow = false;
    body.add(mesh);
  }
  if (segments.length) body.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(segments), new THREE.LineBasicMaterial({ color: 0x050607, transparent: true, opacity: 0.6 })));
}
