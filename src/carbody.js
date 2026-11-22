import * as THREE from 'three';

// The shell of a car: cross-sections placed along its length and joined into one surface, closed at
// each end by a rounded cap. Lengths in metres; z runs along the car from the middle of the body,
// positive towards the nose, x is positive to the left, y is height above the road.

const SPANS = 9;                   // control points per half section, minus one
const SIDE_GLASS = 6, TOP_GLASS = 8;   // the spans that hold the side windows and the windscreen
export const PAINT = 0, GLASS = 1, TRIM = 2;

const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// A smooth curve through [[z, value], ...] (sorted by z) that never overshoots its points.
export function curve(points) {
  const n = points.length, xs = points.map(p => p[0]), ys = points.map(p => p[1]), d = [], m = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  for (let i = 0; i < n; i++) {
    if (i === 0 || i === n - 1) m.push(d[Math.min(i, n - 2)]);
    else m.push(d[i - 1] * d[i] <= 0 ? 0 : 2 * d[i - 1] * d[i] / (d[i - 1] + d[i]));
  }
  return x => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return ys[i] * (2 * t3 - 3 * t2 + 1) + m[i] * h * (t3 - 2 * t2 + t) + ys[i + 1] * (3 * t2 - 2 * t3) + m[i + 1] * h * (t3 - t2);
  };
}

// spec: the car (see cars.js). arches: [{ z, y, r }] wheel openings.
// detail: how finely the surface is divided - coarser for the cars of the traffic and coarser still for
// parked cars. step: metres between cross-sections; arch: cross-sections round each wheel opening;
// sub: rows between two control points of a cross-section; cap: rings in each end cap; patch: [across, up]
// divisions of a lamp patch.
export const FINE = { step: 0.07, arch: 12, sub: 3, cap: 10, patch: [14, 4] };
export function buildShell(spec, arches, detail = FINE) {
  const SUB = detail.sub, HALF = SPANS * SUB;      // HALF: rows from the bottom centre line up to the roof centre line
  const s = spec.shape, hl = spec.L / 2, W = spec.W;
  const top = curve(s.top), belt = curve(s.belt);
  const zF = hl - s.nose.d, zR = -hl + s.tail.d;        // where the caps start
  const plan = z => 1 - 0.07 * Math.max(0, (Math.abs(z) - (hl - 0.9)) / 0.9) ** 2;
  const floor = z => spec.gc + 0.04 * smooth(zF - 0.45, zF, z) + 0.09 * smooth(zR + 0.45, zR, z);

  // Half of the cross-section at z, from the bottom centre line round the left side to the roof centre line.
  function section(z) {
    const hw = W / 2 * plan(z), yb = floor(z), yt = top(z), ys = Math.min(belt(z), yt - 0.04), h = yt - ys;
    const cabin = smooth(0.06, 0.22, h);                 // 0 over the bonnet and boot, 1 where there are windows
    const y7 = yt - lerp(0.4 * h, 0.07, cabin), x7 = hw - 0.035 - s.tumble * (y7 - ys) - 0.05 * (1 - cabin);
    const p = [
      [0, yb], [hw * 0.72, yb], [hw - 0.07, yb + 0.03], [hw - 0.015, yb + 0.14], [hw, yb + 0.45 * (ys - yb)],
      [hw - 0.004, ys - 0.13], [hw - 0.045, ys], [x7, y7], [x7 - lerp(0.16, 0.1, cabin), yt - lerp(0.08 * h, 0.012, cabin)], [0, yt],
    ];
    const at = i => (i < 0 ? [-p[1][0], p[1][1]] : i > SPANS ? [-p[SPANS - 1][0], p[SPANS - 1][1]] : p[i]);
    const out = [];
    for (let i = 0; i < SPANS; i++) {
      const a = at(i - 1), b = at(i), c = at(i + 1), d = at(i + 2);
      for (let k = 0; k < SUB; k++) {
        const t = k / SUB, t2 = t * t, t3 = t2 * t;
        out.push([0, 1].map(q => 0.5 * (2 * b[q] + (c[q] - a[q]) * t + (2 * a[q] - 5 * b[q] + 4 * c[q] - d[q]) * t2 + (3 * b[q] - a[q] - 3 * c[q] + d[q]) * t3)));
      }
    }
    out.push(p[SPANS]);
    out[0][0] = 0;
    return out;
  }

  // ---- stations along the body: evenly spaced, plus the places where something starts or ends
  const marks = [zR, zF, ...s.glass.front, ...s.glass.rear, ...s.glass.side, ...s.pillars.flatMap(z => [z - 0.04, z + 0.04])];
  for (const a of arches) for (let k = 0; k <= detail.arch; k++) marks.push(a.z + a.r * Math.cos(k * Math.PI / detail.arch));
  let stations = marks.filter(z => z >= zR && z <= zF).sort((a, b) => a - b).filter((z, i, list) => i === 0 || z - list[i - 1] > 0.004);
  for (let z = zR + detail.step; z < zF; z += detail.step) if (stations.every(m => Math.abs(m - z) > detail.step * 0.45)) stations.push(z);
  stations.sort((a, b) => a - b);

  const ringOf = half => {                  // both sides: up the left, down the right
    const ring = half.map(p => [p[0], p[1]]);
    for (let j = HALF - 1; j >= 1; j--) ring.push([-half[j][0], half[j][1]]);
    return ring;
  };
  const RING = 2 * HALF, rings = [];        // { z, pts: [[x, y]], cap }
  const caps = {};
  for (const [end, zBase, dir] of [['tail', zR, -1], ['nose', zF, 1]]) {
    const base = ringOf(section(zBase)), cap = s[end], yb = base[0][1], yt = base[HALF][1], yc = yb + 0.45 * (yt - yb);
    caps[end] = { base, yc, zBase, dir, ...cap };
    const list = [];
    for (let k = 1; k <= detail.cap; k++) {
      const a = k * Math.PI / (2 * detail.cap), u = Math.sin(a) ** (2 / cap.nx), sx = Math.cos(a) ** (2 / cap.nx), sy = (1 - u ** cap.ny) ** (1 / cap.ny);
      list.push({ z: zBase + dir * cap.d * u, pts: base.map(([x, y]) => [x * sx, yc + (y - yc) * sy]), cap: true });
    }
    if (dir < 0) rings.push(...list.reverse());
    else caps.noseRings = list;
    if (dir < 0) {
      for (const z of stations) {
        const pts = ringOf(section(z)), lifted = pts.map(() => false);
        pts.forEach((p, k) => {
          for (const a of arches) {                          // lift whatever lies inside a wheel opening up to its edge
            const dz = z - a.z, edge = Math.abs(dz) < a.r ? a.y + Math.sqrt(a.r * a.r - dz * dz) : 0;
            if (p[1] < edge) { p[1] = edge; lifted[k] = true; }
          }
        });
        rings.push({ z, pts, lifted });
      }
    }
  }
  rings.push(...caps.noseRings);

  // ---- surface
  const positions = [], index = [[], [], []];
  for (const r of rings) for (const [x, y] of r.pts) positions.push(x, y, r.z);
  const between = (z, [a, b]) => z > a && z < b;
  for (let i = 0; i < rings.length - 1; i++) {
    const a = rings[i], b = rings[i + 1], z = (a.z + b.z) / 2, capped = a.cap || b.cap;
    for (let k = 0; k < RING; k++) {
      const span = Math.floor((k < HALF ? k : RING - 1 - k) / SUB);
      const k1 = (k + 1) % RING, well = !capped && a.lifted[k] && a.lifted[k1] && b.lifted[k] && b.lifted[k1];   // roof of a wheel opening
      let material = PAINT;
      if (span <= (s.cladding ? 2 : 1) || well) material = TRIM;
      else if (!capped && span === SIDE_GLASS && between(z, s.glass.side) && top(z) - belt(z) > 0.1) {
        material = s.pillars.some(p => Math.abs(z - p) < 0.04) ? TRIM : GLASS;
      } else if (!capped && span === TOP_GLASS && (between(z, s.glass.front) || between(z, s.glass.rear))) material = GLASS;
      const v = i * RING + k, v1 = i * RING + (k + 1) % RING, w = v + RING, w1 = v1 + RING;
      index[material].push(v, v1, w, w, v1, w1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index.flat());
  let start = 0;
  index.forEach((list, material) => { geometry.addGroup(start, list.length, material); start += list.length; });
  geometry.computeVertexNormals();

  // ---- things laid on the surface
  // How far (x, y) is from the middle of an end section: 1 on its outline.
  function gauge(cap, x, y) {
    const px = x, py = y - cap.yc, len = Math.hypot(px, py);
    if (len < 1e-6) return 0;
    for (let k = 0; k < RING; k++) {
      const a = cap.base[k], b = cap.base[(k + 1) % RING], ax = a[0], ay = a[1] - cap.yc, ex = b[0] - ax, ey = b[1] - cap.yc - ay;
      const den = px * ey - py * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = (ax * ey - ay * ex) / den, q = (ax * py - ay * px) / den;
      if (t > 0 && q >= -1e-6 && q <= 1 + 1e-6) return 1 / t;
    }
    return 2;
  }
  // The point of the nose or tail surface in front of (x, y). `edge` keeps it away from the rim of the cap.
  function onCap(end, x, y, edge = 0.97) {
    const cap = caps[end], g = gauge(cap, x, y);
    if (g > edge) { x *= edge / g; y = cap.yc + (y - cap.yc) * edge / g; }
    let lo = 0, hi = 1;
    for (let n = 0; n < 24; n++) {
      const u = (lo + hi) / 2, sx = (1 - u ** cap.nx) ** (1 / cap.nx), sy = (1 - u ** cap.ny) ** (1 / cap.ny);
      if (gauge(cap, x / sx, cap.yc + (y - cap.yc) / sy) < 1) lo = u; else hi = u;
    }
    return [x, y, cap.zBase + cap.dir * cap.d * lo];
  }

  // A patch lying on the nose or tail. x: [inner, outer] and y ranges are fractions: x of the half width,
  // y of the height of the end section. yOut gives a different height at the outer end.
  // side: 1 left, -1 right, 0 one patch across the middle (x from -outer to outer).
  function patch(end, { x, y, yOut = y, edge = 0.95 }, side) {
    const cap = caps[end], hw = cap.base.reduce((m, p) => Math.max(m, p[0]), 0), yb = cap.base[0][1], yt = cap.base[HALF][1];
    const NX = Math.round(detail.patch[0] * (side ? 1 : 1.7)), NY = detail.patch[1], pos = [], idx = [];
    for (let i = 0; i <= NX; i++) {
      let t = i / NX;
      if (side) t = 1 - (1 - t) ** 1.7;                  // closer together where the surface turns the corner
      else t = 0.5 + 0.5 * Math.sign(t - 0.5) * (1 - (1 - Math.abs(2 * t - 1)) ** 1.7);
      const fx = side ? lerp(x[0], x[1], t) * side : lerp(-x[1], x[1], t), bend = side ? t : Math.abs(2 * t - 1);
      for (let j = 0; j <= NY; j++) {
        const fy = lerp(lerp(y[0], yOut[0], bend), lerp(y[1], yOut[1], bend), j / NY);
        const p = onCap(end, fx * hw, lerp(yb, yt, fy), edge);
        pos.push(p[0], p[1], p[2] + cap.dir * 0.006);
      }
    }
    for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) {
      const a = i * (NY + 1) + j, b = a + NY + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  // The points of the body side at z between two heights of the section, pushed just clear of the surface.
  function seam(z, side, fromSpan = 2, toSpan = SIDE_GLASS) {
    return section(z).slice(fromSpan * SUB, toSpan * SUB + 1).map(([x, y]) => new THREE.Vector3((x + 0.004) * side, y, z));
  }

  // Measurements of the section at z.
  const at = z => {
    const half = section(z), sill = half[SIDE_GLASS * SUB], rail = half[TOP_GLASS * SUB];
    return { hw: half[4 * SUB][0], belt: sill[1], beltX: sill[0], roofX: rail[0], roofY: rail[1], top: top(z), floor: floor(z) };
  };
  return { geometry, patch, onCap, seam, at, top, caps };
}
