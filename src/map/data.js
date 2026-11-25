import { levelOf } from './network.js';

// Loads the map produced by tools/build-map.mjs: one base file for the whole area, and a file per
// zone fetched when the car comes near. Local frame: +X east, +Z south, +Y up, metres.

export const GROUND_CELL = 5;    // spacing of the ground grid, metres
const SEA_BED = -3, LAND_MIN = 1;

function gridSampler(grid, nx, nz, cell, x0, z0) {
  return (x, z) => {
    const fx = Math.min(nx - 1.001, Math.max(0, (x - x0) / cell));
    const fz = Math.min(nz - 1.001, Math.max(0, (z - z0) / cell));
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, k = j * nx + i;
    return grid[k] * (1 - u) * (1 - v) + grid[k + 1] * u * (1 - v)
      + grid[k + nx] * (1 - u) * v + grid[k + nx + 1] * u * v;
  };
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// dir: folder holding base.json and the zone files, with a trailing slash.
export async function loadMap(dir) {
  const map = await getJson(`${dir}base.json`);
  const [x0, z0, x1, z1] = map.meta.rect;
  Object.assign(map, { x0, z0, x1, z1 });

  // land or sea for each cell of the ground grid, unpacked from run lengths (the first run is sea)
  const { nx, nz, runs } = map.mask, land = new Uint8Array(nx * nz);
  for (let r = 0, at = 0; r < runs.length; at += runs[r++]) if (r % 2) land.fill(1, at, at + runs[r]);
  map.isLand = (x, z) => {
    const i = Math.round((x - x0) / GROUND_CELL), j = Math.round((z - z0) / GROUND_CELL);
    return i >= 0 && j >= 0 && i < nx && j < nz && land[j * nx + i] === 1;
  };

  // Ground height used for everything drawn and driven on. The elevation data reads about 0 over
  // open water and cannot place the shore, so the land mask decides what is sea.
  const h = map.height, hAt = gridSampler(h.smooth, h.nx, h.nz, h.cell, h.x0, h.z0), grid = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      grid[j * nx + i] = land[j * nx + i] ? Math.max(LAND_MIN, hAt(x0 + i * GROUND_CELL, z0 + j * GROUND_CELL)) : SEA_BED;
    }
  }
  const built = shapeRoads(map, grid, land, nx, nz), deckAt = deckFinder(built.decks);
  const terrain = map.ground = gridSampler(grid, nx, nz, GROUND_CELL, x0, z0);
  // Bridges and the lid over an underpass lie over the ground. top: the uppermost surface.
  // surfaceAt: the surface something at height y stands on - the deck if it is on it, the ground if it is underneath.
  Object.assign(map, { decks: built.decks, cuts: built.cuts, steepest: built.steepest, deckAt });
  // A bridge's deck and the ground at its two ends never agree to the centimetre: over the first and
  // last few metres the surface goes from the one to the other.
  const over = (x, z) => {
    const d = deckAt(x, z);
    if (d && d.deck.kind === 'lid') {
      // the lid meets the ground at its sides: over its outer EDGE metres it goes from its own height to the ground's
      // (at its two ends it stops at the portal: a wall, with a parapet on top)
      // Outside the portal's wall, in that outer strip, it comes down to the ground towards the ends as well.
      const out = d.d - (d.deck.half - EDGE), end = Math.min(d.s, d.deck.s.at(-1) - d.s);
      if (out > 0) d.h += (terrain(x, z) - d.h) * Math.min(1, Math.max(out / EDGE, 1 - (end - 0.3) / EDGE));
    } else if (d && d.deck.join) {
      const total = d.deck.s.at(-1), reach = Math.min(8, total / 2), first = d.s < total / 2, end = first ? d.s : total - d.s;
      if (end < reach) d.h += d.deck.join[first ? 0 : 1] * (1 - end / reach);
    }
    return d;
  };
  // how far the ground at each end of a bridge is off the deck (nothing, if the bridge ends in mid-air)
  for (const deck of built.decks) {
    if (deck.kind !== 'bridge') continue;
    deck.join = [0, deck.pts.length - 1].map(k => { const off = terrain(deck.pts[k][0], deck.pts[k][1]) - deck.h[k]; return Math.abs(off) < 2.2 ? off : 0; });
  }
  map.top = (x, z) => { const d = over(x, z); return d ? d.h : terrain(x, z); };
  map.surfaceAt = (x, z, y) => { const d = over(x, z); return d && !(y < d.h - 2.2) ? d.h : terrain(x, z); };
  // the height a road lies at: one that passes under a deck stays on the ground
  map.heightFor = road => (road && road.low ? terrain : map.top);
  // A footbridge runs straight from the height of one end to that of the other (the heights it would
  // need to clear a street are not in the data), and never below what it crosses.
  for (const road of map.roads) {
    if (road.c !== 'walk' || !road.br) continue;
    const p = road.p, ax = p[0], az = p[1], dx = p.at(-2) - ax, dz = p.at(-1) - az, len2 = dx * dx + dz * dz || 1, h0 = map.top(ax, az), h1 = map.top(p.at(-2), p.at(-1));
    road.lie = (x, z) => Math.max(map.top(x, z), h0 + (h1 - h0) * Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / len2)));
  }
  // which level something at height y is on: 1 on a bridge, -1 in an underpass, 0 otherwise
  map.levelAt = (x, z, y) => { const d = over(x, z); return !d ? 0 : d.deck.kind === 'bridge' ? (y < d.h - 2.2 ? 0 : 1) : y < d.h - 2.2 ? -1 : 0; };

  // { b: buildings, nb: outlines of neighbouring buildings, areas, lines } for zone column i, row j
  map.loadZone = (i, j) => getJson(`${dir}z_${i}_${j}.json`);
  return map;
}

// Cut every carriageway into the ground: level across its width, and along its length an evened-out
// version of the terrain under its centre line. Without this a road across a hillside tilts sideways
// and follows every bump in the elevation data. The ground eases back to the terrain over a few metres.
//
// The heights along all roads are worked out together (as a graph of points every 2.5 m), so that
//  - no road is steeper than GRADE (the elevation data has buildings in it and makes cliffs of them),
//  - roads that meet agree on the height where they meet,
//  - an underpass goes DEPTH below the ground, with the roads leading to it sloping down, and
//  - a road under a bridge leaves CLEAR metres to the deck.
// Returns the structures that follow from it: decks (bridges, and the lid over an underpass) and cuts
// (stretches of road that ended up below the ground beside them; nothing is built along those yet -
// the ground simply slopes down to them).
export const EDGE = 3;
const GRADE = 0.12, DEPTH = 5.4, CLEAR = 5.6, STEP = 2.5, LID = 9.5;     // LID: how far the lid of an underpass reaches beyond the carriageway
function shapeRoads(map, grid, land, nx, nz) {
  const before = gridSampler(grid.slice(), nx, nz, GROUND_CELL, map.x0, map.z0);
  const SHOULDER = 1.5, EASE = 7, WINDOW = 16;     // WINDOW samples either side: 40 m
  const lines = [], nodes = new Map();
  let count = 0;
  for (const road of map.roads) {
    if (road.c !== 'drive' || (road.br && !road.dk) || road.p.length < 4) continue;
    const pts = [], p = road.p, line = { road, pts, at: count, underpass: levelOf(road) < 0 };
    for (let i = 2; i < p.length; i += 2) {
      const ax = p[i - 2], az = p[i - 1], dx = p[i] - ax, dz = p[i + 1] - az, n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / STEP));
      for (let k = i === 2 ? 0 : 1; k <= n; k++) {
        pts.push([ax + dx * k / n, az + dz * k / n]);
        if (k === 0 || k === n) {             // a corner of the road as mapped: where other roads can join it
          const key = k === 0 ? `${ax},${az}` : `${p[i]},${p[i + 1]}`;
          if (!nodes.has(key)) nodes.set(key, []);
          nodes.get(key).push(count + pts.length - 1);
        }
      }
    }
    count += pts.length;
    lines.push(line);
  }
  // The samples as a graph: neighbours along each road, and samples at a shared corner are one node.
  const nodeOf = new Int32Array(count).fill(-1);
  let nodeCount = 0;
  for (const list of nodes.values()) { const id = nodeCount++; for (const i of list) nodeOf[i] = id; }
  for (let i = 0; i < count; i++) if (nodeOf[i] < 0) nodeOf[i] = nodeCount++;
  const edges = Array.from({ length: nodeCount }, () => []);
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  for (const { road, pts, at } of lines) {
    const limit = road.k === 'service' ? 0.2 : GRADE;
    for (let k = 1; k < pts.length; k++) {
      const a = nodeOf[at + k - 1], b = nodeOf[at + k], rise = limit * distance(pts[k - 1], pts[k]);
      if (a === b) continue;
      edges[a].push(b, rise);
      edges[b].push(a, rise);
    }
  }
  // The highest heights that are nowhere above `values` and nowhere steeper than the limit:
  // every node may be at most its neighbour's height plus the rise allowed between them.
  function under(values) {
    const out = Float64Array.from(values), heap = [], done = new Uint8Array(nodeCount);
    const push = (v, n) => {
      let i = heap.length;
      heap.push([v, n]);
      while (i > 0) { const up = (i - 1) >> 1; if (heap[up][0] <= v) break; [heap[up], heap[i]] = [heap[i], heap[up]]; i = up; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        for (let i = 0; ;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    for (let n = 0; n < nodeCount; n++) if (out[n] < Infinity) push(out[n], n);
    while (heap.length) {
      const [v, n] = pop();
      if (done[n] || v > out[n]) continue;
      done[n] = 1;
      for (let e = 0; e < edges[n].length; e += 2) {
        const m = edges[n][e], reach = v + edges[n][e + 1];
        if (reach < out[m]) { out[m] = reach; push(reach, m); }
      }
    }
    return out;
  }
  // Start from the terrain under each road, evened out; a bridge starts as a straight line between its ends.
  const start = new Float32Array(nodeCount), members = new Float32Array(nodeCount);
  for (const { road, pts, at } of lines) {
    const raw = pts.map(([x, z]) => before(x, z));
    pts.forEach((_, k) => {
      let sum = 0, n = 0;
      for (let m = Math.max(0, k - WINDOW); m <= Math.min(pts.length - 1, k + WINDOW); m++) { sum += raw[m]; n++; }
      start[nodeOf[at + k]] += road.dk ? raw[0] + (raw.at(-1) - raw[0]) * k / Math.max(1, pts.length - 1) : sum / n;
      members[nodeOf[at + k]]++;
    });
  }
  for (let n = 0; n < nodeCount; n++) start[n] /= members[n];
  // Cutting the humps down gives one answer and filling the dips up another; half-way between them
  // is also within the limit, and moves the least earth.
  const cutDown = under(start), filled = under(start.map(v => -v)), natural = new Float32Array(nodeCount);
  for (let n = 0; n < nodeCount; n++) natural[n] = (cutDown[n] - filled[n]) / 2;
  // a bridge's deck: straight between the heights of its two ends
  const deckOf = (line, heights) => line.pts.map((_, k) => {
    const a = heights[nodeOf[line.at]], b = heights[nodeOf[line.at + line.pts.length - 1]];
    return a + (b - a) * k / Math.max(1, line.pts.length - 1);
  });

  // ---------- underpasses and the roads that cross bridges ----------
  const cellOf = v => Math.floor(v / 40), near = new Map();
  lines.forEach(line => line.pts.forEach(([x, z], k) => {
    const key = cellOf(x) * 8192 + cellOf(z);
    if (!near.has(key)) near.set(key, []);
    near.get(key).push([line, k]);
  }));
  const around = (x, z, reach, visit) => {
    for (let i = cellOf(x - reach); i <= cellOf(x + reach); i++) {
      for (let j = cellOf(z - reach); j <= cellOf(z + reach); j++) {
        for (const [line, k] of near.get(i * 8192 + j) || []) if (Math.hypot(line.pts[k][0] - x, line.pts[k][1] - z) < reach) visit(line, k);
      }
    }
  };
  // do two roads share a corner (they join), and do their centre lines cross (one passes over the other)?
  const corners = road => { const set = new Set(); for (let i = 0; i < road.p.length; i += 2) set.add(`${road.p[i]},${road.p[i + 1]}`); return set; };
  const touching = (a, b) => { const mine = corners(a); for (let i = 0; i < b.p.length; i += 2) if (mine.has(`${b.p[i]},${b.p[i + 1]}`)) return true; return false; };
  const side = (ax, az, bx, bz, x, z) => (bx - ax) * (z - az) - (bz - az) * (x - ax);
  const known = new Map();
  const crossing = (a, b) => {
    const key = a.at * count + b.at;
    if (known.has(key)) return known.get(key);
    let found = false;
    const p = a.road.p, q = b.road.p;
    if (!touching(a.road, b.road)) {
      for (let i = 2; i < p.length && !found; i += 2) {
        for (let j = 2; j < q.length && !found; j += 2) {
          found = side(p[i - 2], p[i - 1], p[i], p[i + 1], q[j - 2], q[j - 1]) * side(p[i - 2], p[i - 1], p[i], p[i + 1], q[j], q[j + 1]) < 0
            && side(q[j - 2], q[j - 1], q[j], q[j + 1], p[i - 2], p[i - 1]) * side(q[j - 2], q[j - 1], q[j], q[j + 1], p[i], p[i + 1]) < 0;
        }
      }
    }
    known.set(key, found);
    return found;
  };
  // caps: heights some nodes may not rise above. The roads near them slope down to meet them.
  const caps = new Float32Array(nodeCount).fill(Infinity), rides = new Uint8Array(count), riding = new Float32Array(count), nearest = new Float32Array(count).fill(Infinity), decks = [];
  for (const line of lines) {
    const { road, pts, at } = line;
    if (line.underpass) {
      const half = road.w / 2 + LID, lid = pts.map((_, k) => natural[nodeOf[at + k]]), last = pts.length - 1;
      // within the two ends of the underpass, by more than a pace
      const inward = (q, e, inner) => ((q[0] - e[0]) * (inner[0] - e[0]) + (q[1] - e[1]) * (inner[1] - e[1])) / Math.hypot(inner[0] - e[0], inner[1] - e[1]);
      const between = q => inward(q, pts[0], pts[1]) > 0.5 && inward(q, pts[last], pts[last - 1]) > 0.5;
      road.low = true;
      pts.forEach(([x, z], k) => {
        caps[nodeOf[at + k]] = Math.min(caps[nodeOf[at + k]], lid[k] - DEPTH);
        // what crosses over it rides on the lid, level with the ground either side
        // (whether it crosses or only runs along the edge; the roads that lead into the underpass are beyond its ends)
        around(x, z, half + 3, (other, m) => {
          if (other === line || other.underpass || !between(other.pts[m])) return;
          // 1: on the lid; 2: just off it, where the ground is brought level with the lid
          const far = Math.hypot(other.pts[m][0] - x, other.pts[m][1] - z), i = other.at + m;
          if (far <= half) rides[i] = 1; else if (!rides[i]) rides[i] = 2;
          if (far < nearest[i]) { nearest[i] = far; riding[i] = lid[k]; }       // the height of the lid where it is closest
        });
      });
      decks.push({ kind: 'lid', road, pts, h: lid, half });
    } else if (road.dk) {
      const deck = deckOf(line, natural);
      pts.forEach(([x, z], k) => around(x, z, road.w / 2 + 12, (other, m) => {
        if (other === line || other.road.dk || !crossing(line, other)) return;
        if (Math.hypot(other.pts[m][0] - x, other.pts[m][1] - z) > road.w / 2 + other.road.w / 2 + 1.5) return;
        other.road.low = true;
        const n = nodeOf[other.at + m];
        caps[n] = Math.min(caps[n], deck[k] - CLEAR);
      }));
    }
  }
  const capped = under(caps), level = new Float32Array(nodeCount);
  for (let n = 0; n < nodeCount; n++) level[n] = Math.min(natural[n], capped[n]);
  const h = new Float32Array(count), unbuilt = new Float32Array(count);       // per sample: as built, and as it would lie with nothing built
  for (let i = 0; i < count; i++) { h[i] = rides[i] ? riding[i] : level[nodeOf[i]]; unbuilt[i] = natural[nodeOf[i]]; }
  for (const line of lines) {
    if (!line.road.dk) continue;
    const deck = deckOf(line, level);
    deck.forEach((v, k) => { h[line.at + k] = v; });
    decks.push({ kind: 'bridge', road: line.road, pts: line.pts, h: deck, half: line.road.w / 2 + 0.7 });
  }
  let steepest = 0;
  for (const { road, pts, at } of lines) {
    if (road.k === 'service') continue;
    for (let k = 1; k < pts.length; k++) if (!rides[at + k] && !rides[at + k - 1]) steepest = Math.max(steepest, Math.abs(h[at + k] - h[at + k - 1]) / (distance(pts[k - 1], pts[k]) || 1));
  }

  // ---------- the ground under the roads ----------
  const sum = new Float32Array(grid.length), weight = new Float32Array(grid.length), most = new Float32Array(grid.length);
  const cuts = [];
  for (const { road, pts, at } of lines) {
    const flat = road.w / 2 + SHOULDER, rank = road.k === 'service' ? 0.02 : 1;
    let run = null;
    pts.forEach(([x, z], k) => {
      // of a bridge only the first and last few metres are on the ground: its abutments
      if (road.dk && k > 1 && k < pts.length - 2) return;
      const height = h[at + k], drop = rides[at + k] || road.dk ? 0 : unbuilt[at + k] - height;
      if (rides[at + k] === 1) { run = null; return; }
      // sunk by an underpass or to pass under a bridge: the ground steps down at the edge of the road
      if (drop > 0.6) {
        if (!run) cuts.push(run = { road, pts: [], h: [], top: [] });
        run.pts.push(pts[k]); run.h.push(height); run.top.push(unbuilt[at + k]);
      } else run = null;
      // (an underpass's cut is narrow, so that the ground at the edge of its lid is not pulled down with it)
      const ease = levelOf(road) < 0 ? 3 : drop > 0.6 ? 5 : EASE, reach = flat + ease, boost = drop > 0.6 ? 50 : 1;
      const i0 = Math.max(0, Math.ceil((x - reach - map.x0) / GROUND_CELL)), i1 = Math.min(nx - 1, Math.floor((x + reach - map.x0) / GROUND_CELL));
      const j0 = Math.max(0, Math.ceil((z - reach - map.z0) / GROUND_CELL)), j1 = Math.min(nz - 1, Math.floor((z + reach - map.z0) / GROUND_CELL));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const d = Math.hypot(map.x0 + i * GROUND_CELL - x, map.z0 + j * GROUND_CELL - z);
          if (d >= reach) continue;
          const w = d <= flat ? 1 : 1 - (d - flat) / ease, c = j * nx + i;
          if (road.dk && d <= flat) land[c] = 1;            // an abutment stands on made ground, even at the water's edge
          const share = w ** 6 * rank * boost;      // where two roads are close, the nearer one decides, and a street beats a driveway
          sum[c] += share * height;
          weight[c] += share;
          most[c] = Math.max(most[c], w);
        }
      }
    });
  }
  for (let c = 0; c < grid.length; c++) {
    if (land[c] && weight[c] > 0) grid[c] += (Math.max(LAND_MIN, sum[c] / weight[c]) - grid[c]) * most[c];
  }
  // how far along each deck its points are
  for (const deck of decks) {
    deck.s = [0];
    for (let k = 1; k < deck.pts.length; k++) deck.s.push(deck.s[k - 1] + distance(deck.pts[k - 1], deck.pts[k]));
  }
  return { decks, cuts: cuts.filter(c => c.pts.length > 3), steepest };
}

// Which deck, if any, is over (x, z), and how high it is there. The answer is one object, reused.
function deckFinder(decks) {
  const CELL = 24, cells = new Map(), cellOf = v => Math.floor(v / CELL), found = { deck: null, h: 0, s: 0, d: 0 };
  for (const deck of decks) {
    const n = deck.pts.length;
    // the directions the deck leaves its two ends in: a point behind either end is not on it
    deck.ends = [[deck.pts[0], deck.pts[1]], [deck.pts[n - 1], deck.pts[n - 2]]].map(([e, inner]) => { const l = Math.hypot(inner[0] - e[0], inner[1] - e[1]) || 1; return { x: e[0], z: e[1], ux: (inner[0] - e[0]) / l, uz: (inner[1] - e[1]) / l }; });
    for (let k = 1; k < deck.pts.length; k++) {
      const [ax, az] = deck.pts[k - 1], [bx, bz] = deck.pts[k], pad = deck.half + 0.5;
      for (let i = cellOf(Math.min(ax, bx) - pad); i <= cellOf(Math.max(ax, bx) + pad); i++) {
        for (let j = cellOf(Math.min(az, bz) - pad); j <= cellOf(Math.max(az, bz) + pad); j++) {
          const key = i * 8192 + j;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push([deck, k]);
        }
      }
    }
  }
  return (x, z) => {
    const list = cells.get(cellOf(x) * 8192 + cellOf(z));
    if (!list) return null;
    let best = Infinity;
    for (const [deck, k] of list) {
      const [ax, az] = deck.pts[k - 1], [bx, bz] = deck.pts[k], dx = bx - ax, dz = bz - az;
      const raw = ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1);
      // beyond the ends of the deck there is no deck
      if (deck.ends.some(e => (x - e.x) * e.ux + (z - e.z) * e.uz < 0.3)) continue;
      const t = Math.min(1, Math.max(0, raw)), d = Math.hypot(x - ax - dx * t, z - az - dz * t);
      if (d > deck.half || d >= best) continue;
      best = d;
      found.deck = deck;
      found.d = d;
      found.h = deck.h[k - 1] + (deck.h[k] - deck.h[k - 1]) * t;
      found.s = deck.s[k - 1] + (deck.s[k] - deck.s[k - 1]) * t;
    }
    return best < Infinity ? found : null;
  };
}

export function pointInPolygon(x, z, p) {
  let inside = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    if ((p[i + 1] > z) !== (p[j + 1] > z) && x < (p[j] - p[i]) * (z - p[i + 1]) / (p[j + 1] - p[i + 1]) + p[i]) inside = !inside;
  }
  return inside;
}

export function boundsOf(p) {
  let ax = Infinity, az = Infinity, bx = -Infinity, bz = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    ax = Math.min(ax, p[i]); bx = Math.max(bx, p[i]);
    az = Math.min(az, p[i + 1]); bz = Math.max(bz, p[i + 1]);
  }
  return [ax, az, bx, bz];
}
