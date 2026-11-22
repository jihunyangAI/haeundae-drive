// Where people walk: the pavements beside the streets, the zebra crossings at junctions, the corners
// that join them and the footpaths of the map. Built from the lane network (lanes.js). No rendering.
//
// A node is a point { id, x, z, edges }; an edge joins two nodes along `pts` and has a `kind`:
// 'side' pavement, 'cross' a zebra crossing (with the junction `arm` it crosses), 'corner' the bit of
// paving between two of those, 'path' a footpath.

const KERBED = /^(trunk|primary|secondary|tertiary|residential|unclassified|living_street)$/;
const OUT = 1.6;            // how far outside the kerb people walk, metres
const lengthOf = pts => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);

// graph: from buildLaneGraph. map: the base map (for its footpaths).
// blocked(x, z, road): is this spot on a carriageway other than `road`? isLand(x, z).
export function buildWalks(graph, map, { blocked, isLand }) {
  const nodes = [], edges = [];
  const node = (x, z) => { const n = { id: nodes.length, x, z, edges: [] }; nodes.push(n); return n; };
  const join = (a, b, kind, extra = {}, pts = [[a.x, a.z], [b.x, b.z]]) => {
    const e = { id: edges.length, a, b, pts, len: lengthOf(pts), kind, people: 0, ...extra };
    if (e.len < 0.3) return null;
    edges.push(e);
    a.edges.push(e);
    b.edges.push(e);
    return e;
  };
  const beside = (f, right) => [f.x - f.uz * right, f.z + f.ux * right];
  // does the straight line from one point to another stay off every carriageway?
  const clear = (p, q) => [0.15, 0.3, 0.5, 0.7, 0.85].every(t => !blocked(p.x + (q.x - p.x) * t, p.z + (q.z - p.z) * t, null));

  // ---- pavements: either side of each stretch of street, wherever the ground beside it is clear
  for (const link of graph.links) {
    if (link.internal || !KERBED.test(link.road.k)) continue;
    link.walkEnds = [[null, null], [null, null]];          // [at the start, at the end] x [left, right] of the street's points
    const st = link.st, half = link.road.w / 2, n = Math.max(1, Math.round((link.s1 - link.s0) / 5));
    [-1, 1].forEach((side, k) => {
      let run = [];
      const close = last => {
        if (run.length >= 2 && lengthOf(run.map(r => r.p)) > 5) {
          const a = node(...run[0].p), b = node(...run.at(-1).p);
          join(a, b, 'side', { road: link.road }, run.map(r => r.p));
          if (run[0].i === 0) link.walkEnds[0][k] = a;
          if (last) link.walkEnds[1][k] = b;
        }
        run = [];
      };
      for (let i = 0; i <= n; i++) {
        const p = beside(st.at(link.s0 + (link.s1 - link.s0) * i / n), side * (half + OUT));
        if (isLand(p[0], p[1]) && !blocked(p[0], p[1], link.road)) run.push({ p, i }); else close(false);
      }
      close(true);
    });
  }

  // ---- junctions: a crossing over each arm that has a zebra, and the corners between neighbouring arms
  for (const j of graph.junctions) {
    if (j.arms.length < 2) continue;
    const corners = [];
    for (const arm of j.arms) {
      const link = arm.link;
      if (!link.walkEnds) continue;
      // left and right as seen driving into the junction
      const ends = link.walkEnds[arm.end], left = ends[arm.end ? 0 : 1], right = ends[arm.end ? 1 : 0];
      let pair = [left, right];
      if (arm.crossing) {
        const f = link.st.at(arm.s), into = arm.end ? 1 : -1, half = link.road.w / 2 + OUT;
        const mid = { x: f.x + f.ux * into * 2.6, z: f.z + f.uz * into * 2.6, ux: f.ux * into, uz: f.uz * into };
        const pl = beside(mid, -half), pr = beside(mid, half);
        // where another street joins at a narrow angle the kerb here is that street's carriageway: no crossing then
        if (!blocked(pl[0], pl[1], link.road) && !blocked(pr[0], pr[1], link.road)) {
          const cl = node(...pl), cr = node(...pr);
          arm.zebra = join(cl, cr, 'cross', { arm });
          if (left) join(left, cl, 'corner');
          if (right) join(right, cr, 'corner');
          pair = [cl, cr];
        }
      }
      corners.push({ arm, pair, angle: Math.atan2(arm.z - j.z, arm.x - j.x) });
    }
    // neighbours round the junction share a corner: join the two nearest points of each pair of neighbours
    corners.sort((a, b) => a.angle - b.angle);
    for (let i = 0; i < corners.length && corners.length > 1; i++) {
      const a = corners[i], b = corners[(i + 1) % corners.length];
      if (a === b || (corners.length === 2 && i === 1)) continue;
      const tries = [];
      for (const p of a.pair) for (const q of b.pair) if (p && q) tries.push([Math.hypot(p.x - q.x, p.z - q.z), p, q]);
      tries.sort((x, y) => x[0] - y[0]);
      const used = new Set();
      for (const [d, p, q] of tries.slice(0, corners.length === 2 ? 2 : 1)) {
        if (d > 32 || used.has(p) || used.has(q) || !clear(p, q)) continue;
        used.add(p);
        used.add(q);
        join(p, q, 'corner');
      }
    }
  }

  // ---- footpaths of the map: promenades, park paths, pedestrian streets
  const at = new Map();
  const shared = (x, z) => { const key = `${x},${z}`; if (!at.has(key)) at.set(key, node(x, z)); return at.get(key); };
  const walkable = nodes.slice(), loose = [];              // loose: ends of footpath pieces that are not points of the map
  for (const road of map.roads) {
    if (road.c !== 'walk' || road.k === 'steps' || road.br || road.len < 8) continue;
    // Followed a few metres at a time and kept only where it is clear of the carriageways: where a mapped
    // path crosses a street, people use the zebra crossings instead.
    const p = road.p, total = p.length / 2;
    let run = [];
    const close = () => {
      if (run.length >= 2 && lengthOf(run) > 6) {
        const first = run[0], last = run.at(-1);
        const end = q => { if (q.corner) return shared(q[0], q[1]); const n = node(q[0], q[1]); loose.push(n); return n; };
        join(end(first), end(last), 'path', { road }, run.map(q => [q[0], q[1]]));
      }
      run = [];
    };
    for (let i = 0; i < total; i++) {
      const ax = p[i * 2], az = p[i * 2 + 1], steps = i < total - 1 ? Math.max(1, Math.ceil(Math.hypot(p[i * 2 + 2] - ax, p[i * 2 + 3] - az) / 3)) : 1;
      for (let k = 0; k < steps; k++) {
        const x = i < total - 1 ? ax + (p[i * 2 + 2] - ax) * k / steps : ax, z = i < total - 1 ? az + (p[i * 2 + 3] - az) * k / steps : az;
        if (!isLand(x, z) || blocked(x, z, null)) { close(); continue; }
        const q = [x, z];
        q.corner = k === 0;                                // a point of the map's own line, where other paths may join
        run.push(q);
      }
    }
    close();
  }
  for (const n of [...at.values(), ...loose]) {           // where a path ends at a street, step onto the pavement
    if (n.edges.length !== 1) continue;
    let best = null, near = 9;
    for (const o of walkable) { const d = Math.hypot(o.x - n.x, o.z - n.z); if (d < near && clear(n, o)) { near = d; best = o; } }
    if (best) join(n, best, 'corner');
  }
  return { nodes, edges };
}
