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
  const built = shapeRoads(map, grid, land, nx, nz), find = deckFinder(built.decks), found = find.found;
  const terrain = map.ground = gridSampler(grid, nx, nz, GROUND_CELL, x0, z0);
  Object.assign(map, { decks: built.decks, cuts: built.cuts, steepest: built.steepest });
  // how far the ground at each end of a bridge is off the deck (nothing, where it does not come down to the ground)
  for (const deck of built.decks) {
    if (deck.kind !== 'bridge') continue;
    deck.join = [0, deck.pts.length - 1].map((k, i) => { const off = terrain(deck.pts[k][0], deck.pts[k][1]) - deck.h[k]; return deck.landed[i] && Math.abs(off) < 2.2 ? off : 0; });
  }
  // The decks over (x, z), their heights made to meet the ground where they should: a bridge's deck and the
  // ground at its ends never agree to the centimetre, and the lid of an underpass meets the ground at its sides.
  const over = (x, z) => {
    const count = find(x, z);
    for (let i = 0; i < count; i++) {
      const d = found[i];
      if (d.deck.kind === 'lid') {
        // over its outer EDGE metres the lid goes from its own height to the ground's (at its two ends it
        // stops at the portal, a wall with a parapet on top; outside that wall it comes down likewise)
        const out = d.d - (d.deck.half - EDGE), end = Math.min(d.s, d.deck.s.at(-1) - d.s);
        if (out > 0) d.h += (terrain(x, z) - d.h) * Math.min(1, Math.max(out / EDGE, 1 - (end - 0.3) / EDGE));
      } else {
        const total = d.deck.s.at(-1), reach = Math.min(8, total / 2), first = d.s < total / 2, end = first ? d.s : total - d.s;
        if (end < reach) d.h += d.deck.join[first ? 0 : 1] * (1 - end / reach);
      }
    }
    return count;
  };
  // Bridges, the decks of the expressway and the lid over an underpass lie over the ground, sometimes one over another.
  // top: the uppermost surface.
  // the deck something at height y stands on: the highest one not above it (null: it is on the ground)
  let count = 0;
  const standing = (x, z, y) => {
    count = over(x, z);
    // Of the decks at about its own height, the one nearest it in height (so that what is on a deck stays
    // on it where another passes close over or under); failing that, the highest below it.
    let best = null, level = null;
    for (let i = 0; i < count; i++) {
      const d = found[i];
      if (y < d.h - 2.2) continue;
      if (!best || d.h > best.h) best = d;
      if (Math.abs(d.h - y) <= 2.2 && (!level || Math.abs(d.h - y) < Math.abs(level.h - y))) level = d;
    }
    return level || best;
  };
  // Where a ramp runs into a carriageway (see deck.mates) the two decks overlap, a little apart in height
  // until they have become one: near the place they join, the surface goes over from the one to the other
  // across the overlap. Only decks that do join, and none above whoever asks.
  const NEAR_JOIN = 90, MERGE = 1.3;
  const mate = (deck, other, x, z) => deck.mates.some(m => m.deck === other && Math.hypot(m.x - x, m.z - z) < NEAR_JOIN);
  const merged = (best, x, z, y) => {
    if (!best.deck.mates.length) return best.h;
    let sum = 0, weight = 0;
    for (let i = 0; i < count; i++) {
      const d = found[i], gap = Math.abs(d.h - best.h);
      if (d !== best && (gap > MERGE || y < d.h - 2.2 || !mate(best.deck, d.deck, x, z))) continue;
      // (the further apart in height, the less the other deck counts: by MERGE they are two surfaces)
      const w = Math.max(0.03, 1 - d.d / d.deck.half) * (1 - gap / MERGE);
      sum += d.h * w;
      weight += w;
    }
    return sum / weight;
  };
  map.top = (x, z) => { const d = standing(x, z, Infinity); return d ? (d.deck.kind === 'bridge' ? merged(d, x, z, Infinity) : d.h) : terrain(x, z); };
  // surfaceAt: the surface something at height y stands on - a deck if it is on one, else the ground.
  map.surfaceAt = (x, z, y) => { const d = standing(x, z, y); return d ? (d.deck.kind === 'bridge' ? merged(d, x, z, y) : d.h) : terrain(x, z); };
  // do these two decks run into each other near here?
  map.joined = (a, b, x, z) => mate(a, b, x, z);
  map.MERGE = MERGE;
  // (the deck itself, for those who need to know which)
  map.deckAt = (x, z, y = Infinity) => { const d = standing(x, z, y); return d ? d.deck : null; };
  // any deck here at all, at any height? and all of them, with their heights there: [{ deck, h }]
  map.covered = (x, z) => find(x, z) > 0;
  // (to be read at once: the entries are overwritten by the next question put to the map)
  map.decksAt = (x, z) => { const n = over(x, z); return found.slice(0, n); };
  // which level something at height y is on: that of the bridge it stands on (1, or higher on an
  // expressway's upper decks), -1 in an underpass, 0 otherwise
  map.levelAt = (x, z, y) => {
    const n = over(x, z);
    let best = null, roofed = false;
    for (let i = 0; i < n; i++) {
      const d = found[i];
      if (y < d.h - 2.2) { if (d.deck.kind === 'lid') roofed = true; continue; }
      if (!best || d.h > best.h) best = d;
    }
    return best && best.deck.kind === 'bridge' ? best.deck.level : !best && roofed ? -1 : 0;
  };
  // The height a road lies at. A bridge: its own deck (there may be others over or under it). A road that
  // passes under a deck: the ground. Any other: the ground, or the lid of an underpass where it crosses one.
  const onDeck = deck => (x, z) => {
    const n = over(x, z);
    for (let i = 0; i < n; i++) if (found[i].deck === deck) return found[i].h;
    // off it by a little (a sign post beside it, a point a hair past its end): as high as the nearest point of it
    let near = 0, far = Infinity;
    for (let k = 0; k < deck.pts.length; k++) { const q = Math.hypot(x - deck.pts[k][0], z - deck.pts[k][1]); if (q < far) { far = q; near = k; } }
    return deck.h[near] + (near === 0 ? deck.join[0] : near === deck.pts.length - 1 ? deck.join[1] : 0);
  };
  const onGround = (x, z) => { const n = over(x, z); for (let i = 0; i < n; i++) if (found[i].deck.kind === 'lid') return found[i].h; return terrain(x, z); };
  for (const deck of built.decks) if (deck.kind === 'bridge') deck.lie = onDeck(deck);
  map.heightFor = road => (road?.deck ? road.deck.lie : road?.low ? terrain : onGround);
  // A footbridge runs straight from the height of one end to that of the other (the heights it would
  // need to clear a street are not in the data), and never below what it crosses.
  for (const road of map.roads) {
    if (road.c !== 'walk' || !road.br) continue;
    const p = road.p, ax = p[0], az = p[1], dx = p.at(-2) - ax, dz = p.at(-1) - az, len2 = dx * dx + dz * dz || 1, under = map.heightFor(null), h0 = under(ax, az), h1 = under(p.at(-2), p.at(-1));
    road.lie = (x, z) => Math.max(under(x, z), h0 + (h1 - h0) * Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / len2)));
  }

  // { b: buildings, nb: outlines of neighbouring buildings, areas, lines } for zone column i, row j
  // (a zone with nothing in it but the ground has no file)
  const bare = new Set(map.meta.bare || []);
  map.isBare = (i, j) => bare.has(j * map.meta.cols + i);
  map.loadZone = (i, j) => (map.isBare(i, j) ? Promise.resolve({ b: [], nb: [], areas: [], lines: [] }) : getJson(`${dir}z_${i}_${j}.json`));
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
const RAMP = 0.07, LIFT = { 1: 12, 2: 21, 3: 30 };     // an expressway: its steepest, and how high its decks stand
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
  // An expressway on stilts (see express()): its decks are not straight spans from bank to bank but long
  // chains of them, so their heights are worked out point by point like a road's.
  const express = road => !!road.dk && /^(trunk|motorway)/.test(road.k);
  const grounded = new Uint8Array(nodeCount), spans = Array.from({ length: nodeCount }, () => null);
  for (const { road, pts, at } of lines) {
    const limit = road.k === 'service' ? 0.2 : express(road) ? RAMP : GRADE;
    for (let k = 0; k < pts.length; k++) if (!road.dk) grounded[nodeOf[at + k]] = 1;
    for (let k = 1; k < pts.length; k++) {
      const a = nodeOf[at + k - 1], b = nodeOf[at + k], far = distance(pts[k - 1], pts[k]), rise = limit * far;
      if (a === b) continue;
      edges[a].push(b, rise);
      edges[b].push(a, rise);
      if (express(road)) { (spans[a] ||= []).push(b, far); (spans[b] ||= []).push(a, far); }
    }
  }
  // Where two decks run into each other (a ramp joining a carriageway, a carriageway dividing) they lie
  // side by side, overlapping, for some way before they are one: there they must be at one height. Their
  // points that lie over each other near the place they join are tied together, a hand's breadth apart at most.
  {
    const meeting = new Map();
    for (const line of lines) {
      if (!line.road.dk) continue;
      const mine = new Set();
      for (let k = 0; k < line.pts.length; k++) {
        const n = nodeOf[line.at + k];
        if (mine.has(n)) continue;
        mine.add(n);
        if (!meeting.has(n)) meeting.set(n, []);
        meeting.get(n).push([line, k]);
      }
    }
    const REACH = 32;               // points either side of the join: 80 m
    for (const list of meeting.values()) {
      if (list.length < 2) continue;
      for (const [a, ka] of list) {
        for (const [b, kb] of list) {
          if (a.at >= b.at) continue;
          // each point of the one with the nearest point of the other, as long as the two decks overlap there
          const side = (a.road.w + b.road.w) / 2 + 1;
          for (let i = Math.max(0, ka - REACH); i <= Math.min(a.pts.length - 1, ka + REACH); i++) {
            let near = -1, far = side;
            for (let j = Math.max(0, kb - REACH); j <= Math.min(b.pts.length - 1, kb + REACH); j++) {
              const d = distance(a.pts[i], b.pts[j]);
              if (d < far) { far = d; near = j; }
            }
            if (near < 0) continue;
            const p = nodeOf[a.at + i], q = nodeOf[b.at + near];
            if (p === q) continue;
            edges[p].push(q, 0.2);
            edges[q].push(p, 0.2);
          }
        }
      }
    }
  }
  // The highest heights that are nowhere above `values` and nowhere steeper than the limit:
  // every node may be at most its neighbour's height plus the rise allowed between them.
  // (links: which graph to follow - the roads with the rise allowed along them, unless told otherwise)
  function under(values, links = edges) {
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
      const out2 = links[n] || [];
      for (let e = 0; e < out2.length; e += 2) {
        const m = out2[e], reach = v + out2[e + 1];
        if (reach < out[m]) { out[m] = reach; push(reach, m); }
      }
    }
    return out;
  }
  // how far each point of the expressway is, along it, from where it meets a road on the ground
  const toGround = under(Array.from(grounded, g => (g ? 0 : Infinity)), spans);
  // Start from the terrain under each road, evened out; a bridge starts as a straight line between its ends.
  const start = new Float32Array(nodeCount), members = new Float32Array(nodeCount);
  for (const { road, pts, at } of lines) {
    const raw = pts.map(([x, z]) => before(x, z));
    pts.forEach((_, k) => {
      let sum = 0, n = 0;
      for (let m = Math.max(0, k - WINDOW); m <= Math.min(pts.length - 1, k + WINDOW); m++) { sum += raw[m]; n++; }
      // an expressway stands as high over the ground (or the water) as its level asks, coming down to
      // the ground along its ramps: how high depends on how far along it the nearest ground is
      const node = nodeOf[at + k], lift = Math.min(LIFT[road.br] || LIFT[1], toGround[node] * RAMP * 0.8);
      start[node] += express(road) ? Math.max(0.5, sum / n) + lift : road.dk ? raw[0] + (raw.at(-1) - raw[0]) * k / Math.max(1, pts.length - 1) : sum / n;
      members[nodeOf[at + k]]++;
    });
  }
  for (let n = 0; n < nodeCount; n++) start[n] /= members[n];
  // Cutting the humps down gives one answer and filling the dips up another; half-way between them
  // is also within the limit, and moves the least earth.
  const cutDown = under(start), filled = under(start.map(v => -v)), natural = new Float32Array(nodeCount);
  for (let n = 0; n < nodeCount; n++) natural[n] = (cutDown[n] - filled[n]) / 2;
  // a bridge's deck: straight between the heights of its two ends (an expressway's: as worked out, point by point)
  const deckOf = (line, heights) => line.pts.map((_, k) => {
    if (express(line.road)) return heights[nodeOf[line.at + k]];
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
  const floors = new Float64Array(nodeCount).fill(-Infinity);
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
      decks.push({ kind: 'lid', road, level: 0, pts, h: lid, half, landed: [false, false], chained: [false, false], mates: [] });
    } else if (road.dk) {
      const deck = deckOf(line, natural);
      pts.forEach(([x, z], k) => around(x, z, road.w / 2 + 12, (other, m) => {
        if (other === line || !crossing(line, other)) return;
        if (Math.hypot(other.pts[m][0] - x, other.pts[m][1] - z) > road.w / 2 + other.road.w / 2 + 1.5) return;
        if (other.road.dk) {
          // one deck of the expressway over another: the upper one keeps clear of the lower
          if (express(road) && express(other.road) && (other.road.br || 1) < (road.br || 1)) floors[nodeOf[at + k]] = Math.max(floors[nodeOf[at + k]], natural[nodeOf[other.at + m]] + CLEAR + 1);
          return;
        }
        other.road.low = true;
        const n = nodeOf[other.at + m];
        // a bridge between two banks stays where it is and the road dips under it; an expressway is
        // carried up over the road instead
        if (express(road)) floors[nodeOf[at + k]] = Math.max(floors[nodeOf[at + k]], natural[n] + CLEAR);
        else caps[n] = Math.min(caps[n], deck[k] - CLEAR);
      }));
    }
  }
  // floors: the least height of some nodes. What is linked to them rises to meet them, as it sinks to meet the caps.
  const raised = under(floors.map(v => -v)), capped = under(caps), level = new Float32Array(nodeCount);
  for (let n = 0; n < nodeCount; n++) level[n] = Math.min(Math.max(natural[n], -raised[n]), capped[n]);
  const h = new Float32Array(count), unbuilt = new Float32Array(count);       // per sample: as built, and as it would lie with nothing built
  for (let i = 0; i < count; i++) { h[i] = rides[i] ? riding[i] : level[nodeOf[i]]; unbuilt[i] = natural[nodeOf[i]]; }
  // how many decks pass through each node
  const decked = new Uint8Array(nodeCount);
  for (const line of lines) {
    if (!line.road.dk) continue;
    const mine = new Set();
    for (let k = 0; k < line.pts.length; k++) mine.add(nodeOf[line.at + k]);
    for (const n of mine) decked[n]++;
  }
  for (const line of lines) {
    if (!line.road.dk) continue;
    const deck = deckOf(line, level);
    deck.forEach((v, k) => { h[line.at + k] = v; });
    // an end is on the ground where a road of the ground joins it; else it runs on into the next deck, or stops in mid-air
    const first = nodeOf[line.at], last = nodeOf[line.at + line.pts.length - 1];
    // (another deck meets it there - at that deck's end, or part-way along it where a ramp leaves or joins)
    const joined = n => decked[n] > 1;
    line.road.deck = { kind: 'bridge', road: line.road, level: line.road.br || 1, pts: line.pts, h: deck, half: line.road.w / 2 + 0.7,
      landed: [!!grounded[first], !!grounded[last]], chained: [!grounded[first] && joined(first), !grounded[last] && joined(last)] };
    decks.push(line.road.deck);
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
      // of a bridge only the first and last few metres are on the ground: its abutments (where it has any)
      if (road.dk && !((k <= 1 && road.deck.landed[0]) || (k >= pts.length - 2 && road.deck.landed[1]))) return;
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
  // Which decks run into each other, and where: there the two are one surface for a stretch.
  const through = new Map();
  for (const line of lines) {
    if (!line.road.dk) continue;
    const mine = new Set();
    for (let k = 0; k < line.pts.length; k++) {
      const n = nodeOf[line.at + k];
      if (decked[n] < 2 || mine.has(n)) continue;
      mine.add(n);
      if (!through.has(n)) through.set(n, []);
      through.get(n).push([line.road.deck, line.pts[k]]);
    }
  }
  for (const deck of decks) deck.mates = [];
  for (const list of through.values()) for (const [a, at] of list) for (const [b] of list) if (a !== b) a.mates.push({ deck: b, x: at[0], z: at[1] });
  // how far along each deck its points are
  for (const deck of decks) {
    deck.s = [0];
    for (let k = 1; k < deck.pts.length; k++) deck.s.push(deck.s[k - 1] + distance(deck.pts[k - 1], deck.pts[k]));
  }
  return { decks, cuts: cuts.filter(c => c.pts.length > 3), steepest };
}

// The decks over (x, z): fills `found` with { deck, h, s, d } for each (height there, distance along it and
// from its centre line) and returns how many. The entries are reused from call to call.
function deckFinder(decks) {
  const CELL = 24, cells = new Map(), cellOf = v => Math.floor(v / CELL), found = [];
  for (const deck of decks) {
    const n = deck.pts.length;
    // The directions the deck leaves its two ends in: a point behind either end is not on it. An end
    // that runs on into another deck reaches a little past, so that there is no gap between the two.
    deck.ends = [[deck.pts[0], deck.pts[1]], [deck.pts[n - 1], deck.pts[n - 2]]].map(([e, inner], i) => {
      const l = Math.hypot(inner[0] - e[0], inner[1] - e[1]) || 1;
      return { x: e[0], z: e[1], ux: (inner[0] - e[0]) / l, uz: (inner[1] - e[1]) / l, inset: deck.chained[i] ? -1.5 : 0.3 };
    });
    for (let k = 1; k < deck.pts.length; k++) {
      const [ax, az] = deck.pts[k - 1], [bx, bz] = deck.pts[k], pad = deck.half + 2;
      for (let i = cellOf(Math.min(ax, bx) - pad); i <= cellOf(Math.max(ax, bx) + pad); i++) {
        for (let j = cellOf(Math.min(az, bz) - pad); j <= cellOf(Math.max(az, bz) + pad); j++) {
          const key = i * 8192 + j;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push([deck, k]);
        }
      }
    }
  }
  const finder = (x, z) => {
    const list = cells.get(cellOf(x) * 8192 + cellOf(z));
    if (!list) return 0;
    let count = 0;
    for (const [deck, k] of list) {
      const [ax, az] = deck.pts[k - 1], [bx, bz] = deck.pts[k], dx = bx - ax, dz = bz - az;
      // beyond the ends of the deck there is no deck
      if (deck.ends.some(e => (x - e.x) * e.ux + (z - e.z) * e.uz < e.inset)) continue;
      const raw = ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1);
      // (past a chained end the last stretch carries on straight)
      const reach = 1.6 / (Math.hypot(dx, dz) || 1);
      const t = Math.min(k === deck.pts.length - 1 ? 1 + reach : 1, Math.max(k === 1 ? -reach : 0, raw)), d = Math.hypot(x - ax - dx * t, z - az - dz * t);
      if (d > deck.half) continue;
      let entry = null;
      for (let i = 0; i < count; i++) if (found[i].deck === deck) entry = found[i];
      if (entry && entry.d <= d) continue;
      if (!entry) entry = found[count] ||= { deck: null, h: 0, s: 0, d: 0 }, count++;
      const u = Math.min(1, Math.max(0, t));
      entry.deck = deck;
      entry.d = d;
      entry.h = deck.h[k - 1] + (deck.h[k] - deck.h[k - 1]) * u;
      entry.s = deck.s[k - 1] + (deck.s[k] - deck.s[k - 1]) * u;
    }
    return count;
  };
  finder.found = found;
  return finder;
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
