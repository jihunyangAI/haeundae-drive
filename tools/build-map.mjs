// Converts data/raw (see fetch-map.mjs) into what the game loads, in local metres (+X east, +Z south):
//   public/map/<region>/base.json     everything needed everywhere: roads, elevation, the land mask, the zone grid
//   public/map/<region>/z_<i>_<j>.json  one per zone: buildings, areas and lines that touch it
// Usage: node tools/build-map.mjs

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { REGION, projection, tileX, tileY } from './region.mjs';

const RAW = new URL('../data/raw/', import.meta.url);
const OUT = new URL(`../public/map/${REGION.id}/`, import.meta.url);
const { toLocal, mPerLat, mPerLon } = projection();
const { x0: X0, x1: X1, z0: Z0, z1: Z1, zone: ZONE } = REGION;
const r2 = v => Math.round(v * 100) / 100;

const osm = JSON.parse(await readFile(new URL('osm.json', RAW), 'utf8')).elements;
const tiles = JSON.parse(await readFile(new URL('tiles.json', RAW), 'utf8'));

// ---------- geometry helpers ----------
// open: keep the repeated last point of a closed way. Roads and lines need it (a roundabout must
// join up); outlines of buildings and areas are stored without it.
function ring(geometry, open = false) {
  const pts = geometry.map(g => toLocal(g.lat, g.lon));
  const [a, b] = [pts[0], pts[pts.length - 1]];
  const closed = pts.length > 3 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.01;
  if (closed && !open) pts.pop();
  return { pts, closed };
}
const flat = pts => pts.flatMap(p => [r2(p[0]), r2(p[1])]);
const inside = (x, z) => x >= X0 && x <= X1 && z >= Z0 && z <= Z1;
const inExtent = pts => pts.some(p => inside(p[0], p[1]));
// Cut a polyline to the map rectangle (Liang-Barsky per segment). Returns the pieces that lie inside.
function clipLine(pts) {
  const pieces = [];
  let cur = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], dx = b[0] - a[0], dz = b[1] - a[1];
    let t0 = 0, t1 = 1, visible = true;
    for (const [p, q] of [[-dx, a[0] - X0], [dx, X1 - a[0]], [-dz, a[1] - Z0], [dz, Z1 - a[1]]]) {
      if (p === 0) { if (q < 0) visible = false; }
      else if (p < 0) t0 = Math.max(t0, q / p);
      else t1 = Math.min(t1, q / p);
    }
    if (!visible || t0 > t1) { cur = null; continue; }
    if (!cur || t0 > 0) { cur = [[a[0] + dx * t0, a[1] + dz * t0]]; pieces.push(cur); }
    cur.push([a[0] + dx * t1, a[1] + dz * t1]);
    if (t1 < 1) cur = null;
  }
  return pieces.filter(p => p.length > 1);
}
const length = pts => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
const centroid = p => {
  let x = 0, z = 0;
  for (let i = 0; i < p.length; i += 2) { x += p[i]; z += p[i + 1]; }
  return [x / (p.length / 2), z / (p.length / 2)];
};
const boundsOf = p => {
  let ax = Infinity, az = Infinity, bx = -Infinity, bz = -Infinity;
  for (let i = 0; i < p.length; i += 2) { ax = Math.min(ax, p[i]); bx = Math.max(bx, p[i]); az = Math.min(az, p[i + 1]); bz = Math.max(bz, p[i + 1]); }
  return [ax, az, bx, bz];
};

// ---------- roads ----------
const DRIVE = {            // default lanes per direction, lane width (m)
  motorway: [3, 3.5], trunk: [3, 3.5], primary: [3, 3.25], secondary: [2, 3.25], tertiary: [1, 3.25],
  unclassified: [1, 3], residential: [1, 3], living_street: [1, 2.75], service: [1, 2.5], busway: [1, 3.5],
};
const WALK = { footway: 2.5, path: 2, pedestrian: 5, steps: 2.5, cycleway: 2.5 };

const roads = [];
for (const e of osm) {
  const t = e.tags || {};
  if (e.type !== 'way' || !t.highway) continue;
  const base = t.highway.replace(/_link$/, ''), link = t.highway.endsWith('_link');
  if (!DRIVE[base] && !WALK[base]) continue;
  // roads stop at the edge of the map
  for (const pts of clipLine(ring(e.geometry, true).pts)) {
    const road = { k: t.highway, n: t.name || '', p: flat(pts), len: r2(length(pts)) };
    if (t.bridge && t.bridge !== 'no') road.br = Number(t.layer) || 1;
    if (t.tunnel && t.tunnel !== 'no') road.tn = 1;
    if (DRIVE[base]) {
      const [perDir, laneW] = DRIVE[base];
      const oneway = t.oneway === 'yes' || t.junction === 'roundabout';
      const tagged = Number.parseInt(t.lanes, 10);
      const lanes = tagged > 0 ? tagged : link || base === 'service' || base === 'busway' ? 1 : oneway ? perDir : perDir * 2;
      Object.assign(road, {
        c: 'drive', ln: lanes, ls: tagged > 0 ? 'tag' : 'def', ow: oneway ? 1 : 0,
        w: r2(lanes * laneW + (base === 'service' ? 1.5 : 1)),
      });
      if (t.maxspeed) road.ms = Number.parseInt(t.maxspeed, 10);
    } else Object.assign(road, { c: 'walk', w: WALK[base] });
    roads.push(road);
  }
}

// ---------- buildings ----------
const LEVEL_H = { apartments: 2.9, residential: 2.9, house: 3, commercial: 3.8, office: 3.8, retail: 4, hotel: 3.4 };
const EST_H = { apartments: 45, commercial: 15, office: 30, retail: 8, school: 14, house: 6 };

const buildings = [];
function addBuilding(tags, geometry) {
  const { pts, closed } = ring(geometry);
  if (!closed || pts.length < 3) return;
  const p = flat(pts), [cx, cz] = centroid(p);
  if (!inside(cx, cz)) return;
  const type = tags.building && tags.building !== 'yes' ? tags.building : 'yes';
  const h = Number.parseFloat(tags.height), lv = Number.parseInt(tags['building:levels'], 10);
  const b = { t: type, n: tags.name || '', p };
  if (h > 0) Object.assign(b, { h: r2(h), hs: 'h' });
  else if (lv > 0) Object.assign(b, { h: r2(lv * (LEVEL_H[type] || 3.2) + 1), hs: 'lv' });
  else Object.assign(b, { h: EST_H[type] || 9, hs: 'est' });
  if (lv > 0) b.lv = lv;
  buildings.push(b);
}
for (const e of osm) {
  const t = e.tags || {};
  if (!t.building && !t['building:part']) continue;
  if (e.type === 'way') addBuilding(t, e.geometry);
  else for (const m of e.members) if (m.role === 'outer' && m.geometry) addBuilding(t, m.geometry);
}

// ---------- areas and lines ----------
const areas = [], lines = [];
for (const e of osm) {
  const t = e.tags || {};
  if (e.type !== 'way' || t.highway || t.building) continue;
  const kind = t.leisure === 'park' || t.leisure === 'garden' ? 'park'
    : t.leisure === 'pitch' ? 'pitch'
    : t.natural === 'wood' || t.landuse === 'forest' ? 'wood'
    : t.natural === 'beach' || t.natural === 'sand' ? 'beach'
    : t.natural === 'water' ? 'water'
    : t.natural === 'coastline' ? 'coast'
    : t.natural === 'tree_row' ? 'tree_row'
    : t.man_made === 'pier' ? 'pier'
    : t.waterway ? t.waterway : null;
  if (!kind) continue;
  const { pts, closed } = ring(e.geometry, true);
  if (!inExtent(pts)) continue;
  const isLine = !closed || ['coast', 'tree_row', 'river', 'stream'].includes(kind);
  (isLine ? lines : areas).push({ k: kind, p: flat(isLine ? pts : pts.slice(0, -1)) });
}

// ---------- land ----------
// Coastlines are drawn with land on their left. Clip them to the map rectangle and close each piece
// along the rectangle's edge to get land polygons. Works in [u, v] centred on the rectangle with v
// pointing north, so "left" means what it says.
const CX = (X0 + X1) / 2, CZ = (Z0 + Z1) / 2, A = (X1 - X0) / 2, B = (Z1 - Z0) / 2;
function buildLand() {
  const P = 4 * A + 4 * B, EPS = 1e-6;
  const same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.02;
  const chains = lines.filter(l => l.k === 'coast').map(l => {
    const pts = [];
    for (let i = 0; i < l.p.length; i += 2) pts.push([l.p[i] - CX, -(l.p[i + 1] - CZ)]);
    return pts;
  });
  for (let merged = true; merged;) {
    merged = false;
    outer: for (const a of chains) {
      for (const b of chains) {
        if (a !== b && same(a.at(-1), b[0])) {
          a.push(...b.slice(1));
          chains.splice(chains.indexOf(b), 1);
          merged = true;
          break outer;
        }
      }
    }
  }

  const onEdge = p => Math.abs(Math.abs(p[0]) - A) < EPS || Math.abs(Math.abs(p[1]) - B) < EPS;
  const pieces = [];
  for (const chain of chains) {
    const own = [];
    let cur = null;
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1], b = chain[i], dx = b[0] - a[0], dy = b[1] - a[1];
      let t0 = 0, t1 = 1, visible = true;            // Liang-Barsky
      for (const [p, q] of [[-dx, a[0] + A], [dx, A - a[0]], [-dy, a[1] + B], [dy, B - a[1]]]) {
        if (p === 0) { if (q < 0) visible = false; }
        else if (p < 0) t0 = Math.max(t0, q / p);
        else t1 = Math.min(t1, q / p);
      }
      if (!visible || t0 > t1) { cur = null; continue; }
      if (!cur || t0 > 0) { cur = [[a[0] + dx * t0, a[1] + dy * t0]]; own.push(cur); }
      cur.push([a[0] + dx * t1, a[1] + dy * t1]);
      if (t1 < 1) cur = null;
    }
    // a closed chain that starts inside the rectangle comes out split at its first point
    if (own.length > 1 && same(chain[0], chain.at(-1)) && !onEdge(own[0][0]) && !onEdge(own.at(-1).at(-1))) {
      own[0] = own.pop().concat(own[0].slice(1));
    }
    pieces.push(...own);
  }

  const area = poly => poly.reduce((s, p, i) => {
    const q = poly[(i + 1) % poly.length];
    return s + p[0] * q[1] - q[0] * p[1];
  }, 0) / 2;
  const polys = pieces.filter(p => same(p[0], p.at(-1)) && area(p) > 0);      // islands
  const crossers = pieces.filter(p => onEdge(p[0]) && onEdge(p.at(-1)) && !same(p[0], p.at(-1)));
  const dropped = pieces.length - polys.length - crossers.length;
  if (dropped) console.warn(`land: ${dropped} coastline piece(s) end inside the map and were ignored`);

  // position along the rectangle's edge, counter-clockwise from the south-west corner
  const sOf = ([x, y]) => Math.abs(y + B) < EPS ? x + A : Math.abs(x - A) < EPS ? 2 * A + y + B
    : Math.abs(y - B) < EPS ? 2 * A + 2 * B + A - x : 4 * A + 2 * B + B - y;
  const corners = [[0, [-A, -B]], [2 * A, [A, -B]], [2 * A + 2 * B, [A, B]], [4 * A + 2 * B, [-A, B]]];
  const ahead = (from, to) => ((to - from) % P + P) % P;
  const used = new Set();
  for (const start of crossers) {
    if (used.has(start)) continue;
    const poly = [];
    for (let cur = start; cur && !used.has(cur);) {
      used.add(cur);
      poly.push(...cur);
      const exit = sOf(cur.at(-1));
      const next = crossers.reduce((best, c) => (!best || ahead(exit, sOf(c[0])) < ahead(exit, sOf(best[0])) ? c : best), null);
      const gap = ahead(exit, sOf(next[0]));
      corners.map(([s, pt]) => [ahead(exit, s), pt]).filter(([d]) => d > 0 && d < gap)
        .sort((a, b) => a[0] - b[0]).forEach(([, pt]) => poly.push(pt));
      cur = next === start ? null : next;
    }
    polys.push(poly);
  }
  return polys.map(poly => poly.flatMap(([x, y]) => [r2(x + CX), r2(CZ - y)]));
}
const land = buildLand();

// Land or sea for every cell of the 5 m ground grid, filled a row at a time. With no coastline in
// the data the whole map is land. Stored as run lengths, starting with sea.
const FINE = 5, MX = Math.round((X1 - X0) / FINE) + 1, MZ = Math.round((Z1 - Z0) / FINE) + 1;
const mask = new Uint8Array(MX * MZ).fill(land.length ? 0 : 1);
for (let j = 0; j < MZ; j++) {
  const z = Math.min(Z1 - 0.001, Z0 + j * FINE + 0.001);      // just inside the map, also on the last row
  for (const p of land) {
    const xs = [];
    for (let i = 0, k = p.length - 2; i < p.length; k = i, i += 2) {
      if ((p[i + 1] > z) !== (p[k + 1] > z)) xs.push((p[k] - p[i]) * (z - p[i + 1]) / (p[k + 1] - p[i + 1]) + p[i]);
    }
    xs.sort((a, b) => a - b);
    for (let n = 0; n + 1 < xs.length; n += 2) {
      for (let i = Math.max(0, Math.ceil((xs[n] - X0) / FINE)); i <= Math.min(MX - 1, Math.floor((xs[n + 1] - X0) / FINE)); i++) mask[j * MX + i] = 1;
    }
  }
}
const runs = [];
for (let i = 0, value = 0, count = 0; i <= mask.length; i++) {
  if (i < mask.length && mask[i] === value) { count++; continue; }
  runs.push(count);
  value ^= 1;
  count = 1;
}
const onLand = (x, z) => {
  const i = Math.round((x - X0) / FINE), j = Math.round((z - Z0) / FINE);
  return i >= 0 && j >= 0 && i < MX && j < MZ && mask[j * MX + i] === 1;
};

// ---------- elevation ----------
const dem = new Map();
for (let x = tiles.dem.x0; x <= tiles.dem.x1; x++) {
  for (let y = tiles.dem.y0; y <= tiles.dem.y1; y++) {
    dem.set(`${x},${y}`, PNG.sync.read(await readFile(new URL(`dem_${tiles.dem.z}_${x}_${y}.png`, RAW))));
  }
}
function demPixel(px, py) {            // global pixel coordinates at the DEM zoom
  const tx = Math.floor(px / 256), ty = Math.floor(py / 256), png = dem.get(`${tx},${ty}`);
  if (!png) throw new Error(`DEM tile ${tx},${ty} missing - refetch with a larger pad`);
  const i = ((py - ty * 256) * 256 + (px - tx * 256)) * 4;
  return png.data[i] * 256 + png.data[i + 1] + png.data[i + 2] / 256 - 32768;
}
function elevation(lat, lon) {         // bilinear, pixel centres at +0.5
  const fx = tileX(lon, tiles.dem.z) * 256 - 0.5, fy = tileY(lat, tiles.dem.z) * 256 - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), u = fx - x0, v = fy - y0;
  return demPixel(x0, y0) * (1 - u) * (1 - v) + demPixel(x0 + 1, y0) * u * (1 - v)
    + demPixel(x0, y0 + 1) * (1 - u) * v + demPixel(x0 + 1, y0 + 1) * u * v;
}
const CELL = 20, NX = Math.round((X1 - X0) / CELL) + 1, NZ = Math.round((Z1 - Z0) / CELL) + 1;
const heights = [];
for (let j = 0; j < NZ; j++) {
  for (let i = 0; i < NX; i++) {
    const x = X0 + i * CELL, z = Z0 + j * CELL;
    heights.push(Math.round(elevation(REGION.lat - z / mPerLat, REGION.lon + x / mPerLon) * 10) / 10);
  }
}

// The source elevation is a surface model: towers show up as bumps on what is really flat ground.
// `smooth` knocks those out with a minimum filter followed by a blur.
function filter(src, radius, reduce) {
  return src.map((_, idx) => {
    const i0 = idx % NX, j0 = (idx - i0) / NX, vals = [];
    for (let j = Math.max(0, j0 - radius); j <= Math.min(NZ - 1, j0 + radius); j++) {
      for (let i = Math.max(0, i0 - radius); i <= Math.min(NX - 1, i0 + radius); i++) vals.push(src[j * NX + i]);
    }
    return reduce(vals);
  });
}
const mean = vals => vals.reduce((s, v) => s + v, 0) / vals.length;
const smooth = filter(filter(filter(heights, 2, vals => Math.min(...vals)), 2, mean), 2, mean)
  .map(h => Math.round(h * 10) / 10);

function sampler(data) {
  return (x, z) => {
    const fx = Math.min(NX - 1.001, Math.max(0, (x - X0) / CELL)), fz = Math.min(NZ - 1.001, Math.max(0, (z - Z0) / CELL));
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, k = j * NX + i;
    return data[k] * (1 - u) * (1 - v) + data[k + 1] * u * (1 - v) + data[k + NX] * (1 - u) * v + data[k + NX + 1] * u * v;
  };
}
// gradient (%) along drivable roads, sampled each 10 m; `only` narrows it to some roads
function roadGrades(data, only = () => true) {
  const hAt = sampler(data), grades = [];
  for (const r of roads) {
    if (r.c !== 'drive' || r.br || !only(r)) continue;
    for (let i = 2; i < r.p.length; i += 2) {
      const ax = r.p[i - 2], az = r.p[i - 1], d = Math.hypot(r.p[i] - ax, r.p[i + 1] - az);
      for (let s = 0; s + 10 <= d; s += 10) {
        const p = t => hAt(ax + (r.p[i] - ax) * t / d, az + (r.p[i + 1] - az) * t / d);
        grades.push(Math.abs(p(s + 10) - p(s)) * 10);
      }
    }
  }
  if (!grades.length) return null;
  grades.sort((a, b) => a - b);
  const q = f => r2(grades[Math.floor((grades.length - 1) * f)]);
  return { median: q(0.5), p95: q(0.95), max: q(1) };
}

// ---------- filler buildings ----------
// The source has building outlines for only part of the area. Where a street has nothing mapped
// beside it, plain blocks are put along the kerb so the town does not read as empty land. They are
// marked `f` so they can be told from mapped buildings.
function addFillers() {
  const G = 40, grid = new Map(), cellsOf = ([ax, az, bx, bz]) => {
    const out = [];
    for (let j = Math.floor(az / G); j <= Math.floor(bz / G); j++) for (let i = Math.floor(ax / G); i <= Math.floor(bx / G); i++) out.push(`${i},${j}`);
    return out;
  };
  const put = (box, item) => { for (const k of cellsOf(box)) { if (!grid.has(k)) grid.set(k, []); grid.get(k).push(item); } };
  for (const b of buildings) put(boundsOf(b.p), { box: boundsOf(b.p) });
  for (const r of roads) {
    for (let i = 2; i < r.p.length; i += 2) {
      const seg = [r.p[i - 2], r.p[i - 1], r.p[i], r.p[i + 1]], half = r.w / 2 + 2.5;
      put([Math.min(seg[0], seg[2]) - half, Math.min(seg[1], seg[3]) - half, Math.max(seg[0], seg[2]) + half, Math.max(seg[1], seg[3]) + half], { seg, half, road: r });
    }
  }
  const open = areas.filter(a => ['park', 'wood', 'beach', 'pitch', 'water'].includes(a.k)).map(a => ({ p: a.p, box: boundsOf(a.p) }));
  const inPoly = (x, z, p) => {
    let hit = false;
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      if ((p[i + 1] > z) !== (p[j + 1] > z) && x < (p[j] - p[i]) * (z - p[i + 1]) / (p[j + 1] - p[i + 1]) + p[i]) hit = !hit;
    }
    return hit;
  };
  const free = corners => {
    const box = boundsOf(corners.flat());
    if (box[0] < X0 + 5 || box[2] > X1 - 5 || box[1] < Z0 + 5 || box[3] > Z1 - 5) return false;
    for (const [x, z] of corners) {
      if (!onLand(x, z)) return false;
      if (open.some(a => x >= a.box[0] && x <= a.box[2] && z >= a.box[1] && z <= a.box[3] && inPoly(x, z, a.p))) return false;
    }
    const pts = corners.concat([[(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]]);
    for (const k of cellsOf(box)) {
      for (const it of grid.get(k) || []) {
        if (it.box) {
          if (box[0] < it.box[2] + 3 && box[2] > it.box[0] - 3 && box[1] < it.box[3] + 3 && box[3] > it.box[1] - 3) return false;
        } else {
          const [ax, az, bx, bz] = it.seg, dx = bx - ax, dz = bz - az;
          for (const [x, z] of pts) {
            const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
            if (Math.hypot(x - ax - dx * t, z - az - dz * t) < it.half) return false;
          }
        }
      }
    }
    return true;
  };
  let seed = 20261122;
  const rand = () => { seed = seed * 1664525 + 1013904223 >>> 0; return seed / 4294967296; };
  const KIND = {       // floors [min, max], and what the block is
    secondary: [4, 12, 'yes'], tertiary: [3, 8, 'yes'], residential: [2, 5, 'yes'], unclassified: [2, 4, 'yes'], living_street: [2, 4, 'residential'],
  };
  let count = 0;
  for (const r of roads) {
    const kind = KIND[r.k];
    if (r.c !== 'drive' || r.br || r.tn || !kind) continue;
    let along = 4 + rand() * 6;
    for (let i = 2; i < r.p.length; i += 2) {
      const ax = r.p[i - 2], az = r.p[i - 1], d = Math.hypot(r.p[i] - ax, r.p[i + 1] - az);
      if (d < 0.01) continue;
      const ux = (r.p[i] - ax) / d, uz = (r.p[i + 1] - az) / d;
      for (; along < d; along += 15 + rand() * 6) {
        for (const side of [-1, 1]) {
          const w = 10 + rand() * 4, depth = 8 + rand() * 4, back = r.w / 2 + 5.5;
          // corners: two on the building line, two behind it
          const at = (a, o) => [ax + ux * a - uz * side * o, az + uz * a + ux * side * o];
          const corners = [at(along - w / 2, back), at(along + w / 2, back), at(along + w / 2, back + depth), at(along - w / 2, back + depth)];
          if (!free(corners)) continue;
          const floors = kind[0] + Math.floor(rand() * (kind[1] - kind[0] + 1));
          const b = { t: kind[2], n: '', p: flat(side > 0 ? corners : corners.reverse()), h: r2(floors * 3.3 + 1), hs: 'est', f: 1 };
          buildings.push(b);
          put(boundsOf(b.p), { box: boundsOf(b.p) });
          count++;
        }
      }
      along -= d;
    }
  }
  return count;
}
const mapped = buildings.length, fillers = addFillers();

// ---------- zones ----------
// A zone file lists everything that touches the zone, whole. What each zone draws is decided in the
// game by where a thing (or a piece of it) lies, so neighbours agree without the data being cut.
const COLS = Math.round((X1 - X0) / ZONE), ROWS = Math.round((Z1 - Z0) / ZONE), NEAR = 10;
const zones = [];
for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) zones.push({ i, j, b: [], nb: [], areas: [], lines: [] });
const touching = ([ax, az, bx, bz], pad, visit) => {
  for (let j = Math.max(0, Math.floor((az - pad - Z0) / ZONE)); j <= Math.min(ROWS - 1, Math.floor((bz + pad - Z0) / ZONE)); j++) {
    for (let i = Math.max(0, Math.floor((ax - pad - X0) / ZONE)); i <= Math.min(COLS - 1, Math.floor((bx + pad - X0) / ZONE)); i++) visit(zones[j * COLS + i]);
  }
};
for (const b of buildings) {
  const [cx, cz] = centroid(b.p);
  const home = zones[Math.min(ROWS - 1, Math.floor((cz - Z0) / ZONE)) * COLS + Math.min(COLS - 1, Math.floor((cx - X0) / ZONE))];
  home.b.push(b);
  // neighbours only need the outline, to keep trees and poles out of it
  touching(boundsOf(b.p), NEAR, z => { if (z !== home) z.nb.push(b.p); });
}
for (const a of areas) touching(boundsOf(a.p), 0, z => z.areas.push(a));
for (const l of lines) touching(boundsOf(l.p), 12, z => z.lines.push(l));

// ---------- stats ----------
const sum = (arr, f) => arr.reduce((s, v) => s + f(v), 0);
const tally = (arr, f) => arr.reduce((m, v) => { const k = f(v); m[k] = (m[k] || 0) + 1; return m; }, {});
const drive = roads.filter(r => r.c === 'drive');
let roadPts = 0, roadPtsDry = 0;
for (const r of drive) {
  if (r.br) continue;
  for (let i = 0; i < r.p.length; i += 2) {
    roadPts++;
    if (onLand(r.p[i], r.p[i + 1])) roadPtsDry++;
  }
}
const stats = {
  size: { widthM: X1 - X0, depthM: Z1 - Z0, zones: zones.length, landShare: r2(mask.reduce((s, v) => s + v, 0) / mask.length) },
  land: {
    polygons: land.length,
    buildingsOnLand: `${buildings.filter(b => onLand(...centroid(b.p))).length} / ${buildings.length}`,
    roadPointsOnLand: `${roadPtsDry} / ${roadPts}`,
  },
  roads: {
    driveCount: drive.length, walkCount: roads.length - drive.length,
    driveKm: r2(sum(drive, r => r.len) / 1000), walkKm: r2(sum(roads.filter(r => r.c === 'walk'), r => r.len) / 1000),
    kmByKind: Object.fromEntries(Object.entries(drive.reduce((m, r) => { m[r.k] = (m[r.k] || 0) + r.len; return m; }, {}))
      .map(([k, v]) => [k, r2(v / 1000)])),
    bridges: roads.filter(r => r.br).length, tunnels: roads.filter(r => r.tn).length,
    names: new Set(drive.map(r => r.n).filter(Boolean)).size,
  },
  buildings: {
    mapped, fillers, heightSource: tally(buildings.filter(b => !b.f), b => b.hs),
    perZone: zones.map(z => z.b.length).join(' '),
    zonesWithNone: zones.filter(z => !z.b.length).length,
    tallest: [...buildings].sort((a, b) => b.h - a.h).slice(0, 6).map(b => ({ n: b.n, h: b.h })),
  },
  elevation: {
    min: Math.min(...heights), max: Math.max(...heights), smoothMax: Math.max(...smooth),
    roadGradePct: { raw: roadGrades(heights), smooth: roadGrades(smooth), dalmaji: roadGrades(smooth, r => r.n.startsWith('달맞이')) },
  },
};

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const base = {
  meta: {
    id: REGION.id, name: REGION.name, center: { lat: REGION.lat, lon: REGION.lon }, mPerLat, mPerLon,
    rect: [X0, Z0, X1, Z1], zone: ZONE, cols: COLS, rows: ROWS,
    attribution: '지도 데이터 © OpenStreetMap 기여자 (ODbL) · 고도 데이터: Mapzen Terrain Tiles',
  },
  height: { nx: NX, nz: NZ, cell: CELL, x0: X0, z0: Z0, smooth },
  mask: { nx: MX, nz: MZ, cell: FINE, runs },
  roads, land, stats,
};
let bytes = 0;
const save = async (name, data) => { const json = JSON.stringify(data); bytes += json.length; await writeFile(new URL(name, OUT), json); return json.length; };
const baseSize = await save('base.json', base);
for (const z of zones) await save(`z_${z.i}_${z.j}.json`, { b: z.b, nb: z.nb, areas: z.areas, lines: z.lines });
console.log(`wrote public/map/${REGION.id}/: base ${(baseSize / 1024).toFixed(0)} KB, ${zones.length} zones, ${(bytes / 1024).toFixed(0)} KB in all`);
console.log(JSON.stringify(stats, null, 1));
