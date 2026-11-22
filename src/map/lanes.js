// Lane-level street network: every lane of every street, how lanes connect across each junction, who
// has priority there, and the signal programme of the junctions that have lights. Traffic and
// pedestrians read this; the road paint and signal heads are drawn from it. No rendering in here, so
// tools/check-lanes.mjs can run it under Node.
//
// Frame: +x east, +z south. "Right" of a direction (ux, uz) is (-uz, ux).

// Lanes stop this far short of the crossing street's edge: room for a stop line and a zebra crossing
// where a through street is involved, less where two side streets meet.
const clearOf = junction => (junction.roads.some(r => SIGNALISED.test(r.k)) ? 6 : 3.5);
const MIN_STRETCH = 6;                 // a stretch between two junctions shorter than this is part of the junction
const MAX_ARMS = 6;                    // a knot of junctions with more arms than this is not treated as one junction
const SIGNALISED = /^(trunk|primary|secondary|tertiary)$/;
const RANK = { trunk: 6, primary: 5, secondary: 4, tertiary: 3, unclassified: 2, residential: 2, living_street: 1 };
const rankOf = road => (RANK[road.k.replace(/_link$/, '')] ?? 1) - (road.k.endsWith('_link') ? 0.5 : 0);
const deg = a => a * 180 / Math.PI;

// Signal timing, seconds.
const T = { left: 11, amber: 3, allRed: 1.5, major: 24, minor: 16, flash: 7 };

// Lanes per direction: [along the street's points, against them].
export function laneSplit(road) {
  if (road.ow) return [road.ln, 0];
  if (road.ln === 1) return [1, 1];              // one shared lane: the two directions squeeze past each other
  return [Math.ceil(road.ln / 2), Math.floor(road.ln / 2)];
}
// Sideways offset of a lane's middle from the street's centre line, positive to the right of its points.
// index 0 is the lane nearest the centre line (or the leftmost lane of a one-way street).
export function laneOffset(road, dir, index) {
  const [, back] = laneSplit(road), laneW = (road.w - 1) / road.ln;
  if (!road.ow && road.ln === 1) return dir * Math.min(1.15, road.w / 2 - 0.85);     // a little over the edge line: just room for two cars to squeeze past
  return (back + dir * (index + 0.5) - road.ln / 2) * laneW;
}

function offsetLine(p, o) {            // p: flat [x, z, ...]; returns [[x, z], ...] moved o metres to the right
  const n = p.length / 2, out = [];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    const dx = p[b * 2] - p[a * 2], dz = p[b * 2 + 1] - p[a * 2 + 1], len = Math.hypot(dx, dz) || 1;
    // at a bend the corner is pushed out further, so the line stays o metres from both stretches that meet there
    const ix = p[i * 2] - p[a * 2], iz = p[i * 2 + 1] - p[a * 2 + 1], il = Math.hypot(ix, iz);
    const mitre = il > 1e-6 ? Math.min(2, 1 / Math.max(0.5, Math.abs((ix * dx + iz * dz) / (il * len)))) : 1;
    out.push([p[i * 2] - dz / len * o * mitre, p[i * 2 + 1] + dx / len * o * mitre]);
  }
  return out;
}
const lengthOf = pts => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
const unit = (a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
// Do two paths come closer than `room` metres anywhere - so that cars on them could touch?
function tooClose(a, b, room) {
  if (crosses(a, b)) return true;
  const near = (p, q) => {
    for (const [px, pz] of p) {
      for (let j = 1; j < q.length; j++) {
        const [x1, z1] = q[j - 1], dx = q[j][0] - x1, dz = q[j][1] - z1, len2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((px - x1) * dx + (pz - z1) * dz) / len2));
        if (Math.hypot(px - x1 - dx * t, pz - z1 - dz * t) < room) return true;
      }
    }
    return false;
  };
  return near(a, b) || near(b, a);
}
function crosses(a, b) {               // do two polylines cross?
  for (let i = 1; i < a.length; i++) {
    for (let j = 1; j < b.length; j++) {
      const [x1, z1] = a[i - 1], [x2, z2] = a[i], [x3, z3] = b[j - 1], [x4, z4] = b[j];
      const d = (x2 - x1) * (z4 - z3) - (z2 - z1) * (x4 - x3);
      if (Math.abs(d) < 1e-9) continue;
      const t = ((x3 - x1) * (z4 - z3) - (z3 - z1) * (x4 - x3)) / d, u = ((x3 - x1) * (z2 - z1) - (z3 - z1) * (x2 - x1)) / d;
      if (t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98) return true;
    }
  }
  return false;
}

// net: the result of analyseStreets(map). Adds `links` to every street and returns the graph.
export function buildLaneGraph(map, net) {
  // ---- points where stretches end: junctions, joints between two streets, dead ends
  const nodes = new Map();
  const nodeAt = (x, z) => {
    const key = `${x},${z}`;
    if (!nodes.has(key)) nodes.set(key, { id: nodes.size, x, z, ends: [], parent: null });
    return nodes.get(key);
  };
  const links = [];
  for (const st of net.streets) {
    const p = st.road.p, stops = [{ s: 0, node: nodeAt(p[0], p[1]), pad: 0, clear: 0 }];
    for (const c of [...st.cuts].sort((a, b) => a.s - b.s)) {
      const stop = { s: c.s, node: nodeAt(c.junction.x, c.junction.z), pad: c.half + clearOf(c.junction), clear: clearOf(c.junction) };
      if (c.s < 0.01) stops[0] = stop; else stops.push(stop);
    }
    const last = { s: st.len, node: nodeAt(p.at(-2), p.at(-1)), pad: 0, clear: 0 };
    if (st.len - stops.at(-1).s > 0.01) stops.push(last);
    st.links = [];
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1], b = stops[i], s0 = a.s + a.pad, s1 = b.s - b.pad;
      const link = { id: links.length, st, road: st.road, a: a.node, b: b.node, s0, s1, internal: s1 - s0 < MIN_STRETCH, short: false, sa: a.s, sb: b.s, lanes: [], ends: [null, null], pads: [a.pad, b.pad], clear: [a.clear, b.clear] };
      links.push(link);
      st.links.push(link);
      a.node.ends.push({ link, end: 0 });
      b.node.ends.push({ link, end: 1 });
    }
  }

  // Streets that leave a point at a narrow angle run side by side for a while; their lanes start only
  // where the two carriageways have come apart.
  const trim = l => { l.s0 = l.sa + l.pads[0]; l.s1 = l.sb - l.pads[1]; l.internal = l.s1 - l.s0 < MIN_STRETCH; };
  const outward = ({ link, end }) => {
    const here = link.st.at(end ? link.sb : link.sa), on = link.st.at(end ? link.sb - 8 : link.sa + 8), dx = on.x - here.x, dz = on.z - here.z, len = Math.hypot(dx, dz) || 1;
    return [dx / len, dz / len];
  };
  for (const node of nodes.values()) {
    if (node.ends.length < 2) continue;
    const dirs = node.ends.map(outward);
    if (node.ends.length === 2) {
      // one street running on into another round a corner: the lanes stop short of the corner and a bend joins them
      const [a, b] = node.ends;
      if (dirs[0][0] * dirs[1][0] + dirs[0][1] * dirs[1][1] > -0.86) {
        a.link.pads[a.end] = Math.max(a.link.pads[a.end], b.link.road.w / 2 + 1);
        b.link.pads[b.end] = Math.max(b.link.pads[b.end], a.link.road.w / 2 + 1);
      }
      continue;
    }
    node.ends.forEach((e, i) => {
      node.ends.forEach((o, k) => {
        const angle = Math.acos(Math.max(-1, Math.min(1, dirs[i][0] * dirs[k][0] + dirs[i][1] * dirs[k][1])));
        if (k !== i && angle < 1.3) e.link.pads[e.end] = Math.max(e.link.pads[e.end], Math.min(45, (e.link.road.w + o.link.road.w) / 4 / Math.sin(Math.max(angle, 0.1) / 2) + 1));
      });
    });
  }
  links.forEach(trim);

  // ---- junctions: nodes joined by stretches too short to drive on count as one
  const find = n => { while (n.parent) n = n.parent; return n; };
  const join = () => { for (const n of nodes.values()) n.parent = null; for (const l of links) if (l.internal && !l.short) { const a = find(l.a), b = find(l.b); if (a !== b) a.parent = b; } };
  join();
  // A street that simply ends at such a group of points ends at the junction too: its lanes stop short like the others'.
  {
    const arms = new Map(), pad = new Map();
    for (const l of links) {
      for (const [end, n] of [l.a, l.b].entries()) {
        const root = find(n);
        if (!l.internal) arms.set(root, (arms.get(root) || 0) + 1);
        pad.set(root, Math.max(pad.get(root) || 0, l.pads[end]));
      }
    }
    for (const l of links) {
      for (const [end, n] of [l.a, l.b].entries()) {
        const root = find(n);
        if (l.pads[end] === 0 && arms.get(root) >= 3) { l.pads[end] = pad.get(root) || 5; l.clear[end] = 3.5; }
      }
      trim(l);
    }
    join();
  }
  // Where many streets meet in a tangle the result would be one junction with a dozen arms. There the
  // short stretches are kept as (short) lanes instead, each meeting point a small junction of its own,
  // without signals or paint.
  const armCount = new Map();
  for (const l of links) if (!l.internal) for (const n of [l.a, l.b]) armCount.set(find(n), (armCount.get(find(n)) || 0) + 1);
  const knots = new Set([...armCount].filter(([, n]) => n > MAX_ARMS).map(([root]) => root));
  for (const l of links) {
    if (!l.internal || !knots.has(find(l.a)) || l.sb - l.sa < 4) continue;
    const inset = Math.min(3, (l.sb - l.sa) * 0.3);
    Object.assign(l, { short: true, s0: l.sa + inset, s1: l.sb - inset });
  }
  const knotted = new Set([...nodes.values()].filter(n => knots.has(find(n))));
  join();
  const byRoot = new Map(), junctions = [];
  for (const node of nodes.values()) {
    const root = find(node);
    if (!byRoot.has(root)) {
      const j = { id: junctions.length, nodes: [], arms: [], moves: [], x: 0, z: 0, control: 'none', signal: null, knot: knotted.has(node) };
      byRoot.set(root, j);
      junctions.push(j);
    }
    byRoot.get(root).nodes.push(node);
  }

  // ---- lanes
  const lanes = [];
  for (const link of links) {
    if (link.internal && !link.short) continue;
    const road = link.road, counts = laneSplit(road), line = link.st.slice(link.s0, link.s1);
    [1, -1].forEach((dir, d) => {
      for (let index = 0; index < counts[d]; index++) {
        const o = laneOffset(road, dir, index), pts = offsetLine(line, o);
        if (dir < 0) pts.reverse();
        const lane = { id: lanes.length, link, road, dir, index, count: counts[d], o, pts, len: lengthOf(pts), out: [], into: [], from: null, to: null };
        lanes.push(lane);
        link.lanes.push(lane);
      }
    });
  }
  // an arm is one street stretch arriving at a junction: the lanes coming in and the lanes going out
  for (const [root, j] of byRoot) {
    for (const node of j.nodes) {
      j.x += node.x / j.nodes.length;
      j.z += node.z / j.nodes.length;
      for (const { link, end } of node.ends) {
        if (link.internal && !link.short) continue;
        const towards = end === 1 ? 1 : -1;        // the lane direction that runs into this junction
        const arm = {
          id: j.arms.length, junction: j, link, end, road: link.road, rank: rankOf(link.road),
          entries: link.lanes.filter(l => l.dir === towards).sort((a, b) => a.index - b.index),
          exits: link.lanes.filter(l => l.dir === -towards).sort((a, b) => a.index - b.index),
          s: end === 1 ? link.s1 : link.s0, crossing: null, give: 'none', axis: 0,
        };
        const f = link.st.at(arm.s);
        arm.dir = [f.ux * towards, f.uz * towards];           // direction of travel into the junction
        arm.x = f.x;
        arm.z = f.z;
        for (const l of arm.entries) l.to = arm;
        for (const l of arm.exits) l.from = arm;
        link.ends[end] = arm;
        j.arms.push(arm);
      }
    }
    void root;
  }

  // ---- movements across each junction
  const moves = [];
  const curve = (p0, d0, p3, d3, bend) => {
    const d = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
    if (d < 0.5) return [p0, p3];
    const k = d * bend, out = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12, u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t;
      out.push([a * p0[0] + b * (p0[0] + d0[0] * k) + c * (p3[0] - d3[0] * k) + e * p3[0], a * p0[1] + b * (p0[1] + d0[1] * k) + c * (p3[1] - d3[1] * k) + e * p3[1]]);
    }
    return out;
  };
  const connect = (j, arm, from, to, turn) => {
    const p0 = from.pts.at(-1), p3 = to.pts[0], d0 = unit(from.pts.at(-2), p0), d3 = unit(p3, to.pts[1]);
    const pts = curve(p0, d0, p3, d3, turn === 'S' ? 0.33 : turn === 'U' ? 0.7 : 0.42);
    const move = { id: moves.length, junction: j, arm, from, to, turn, pts, len: lengthOf(pts), conflicts: [], wide: [], opposed: false, yields: false, priority: 3 };
    moves.push(move);
    j.moves.push(move);
    from.out.push(move);
    to.into.push(move);
  };
  for (const j of junctions) {
    for (const arm of j.arms) {
      if (!arm.entries.length) continue;
      const n = arm.entries.length;
      // where one can go from here, leftmost first
      const exits = j.arms.filter(b => b !== arm && b.exits.length).map(b => {
        const out = [-b.dir[0], -b.dir[1]], cross = arm.dir[0] * out[1] - arm.dir[1] * out[0], dot = arm.dir[0] * out[0] + arm.dir[1] * out[1];
        const angle = deg(Math.atan2(-cross, dot));         // positive: to the left
        // doubling back onto the other carriageway of the same divided road is not offered; a sharp turn into another street is
        const back = Math.abs(angle) > 155 && arm.road.ow && b.road.ow;
        return { arm: b, angle, turn: Math.abs(angle) < 40 ? 'S' : back ? 'U' : angle > 0 ? 'L' : 'R' };
      }).filter(e => e.turn !== 'U').sort((a, b) => b.angle - a.angle);
      arm.turns = exits.map(e => e.turn);
      if (!exits.length) {                                  // dead end: turn round, if the street is two-way
        if (arm.exits.length) for (const from of arm.entries) connect(j, arm, from, arm.exits[0], 'U');
        continue;
      }
      // Share the lanes out among the exits in order, straight on counting double: the left lane turns
      // left, the right lane turns right, and lanes in between (and beside them, if few) go straight.
      const weights = exits.map(e => (e.turn === 'S' ? 2 : 1)), total = weights.reduce((a, b) => a + b, 0);
      let w0 = 0;
      exits.forEach((e, k) => {
        const lo = w0 / total, hi = (w0 += weights[k]) / total;
        const users = arm.entries.filter((_, i) => i / n < hi - 1e-6 && (i + 1) / n > lo + 1e-6), m = e.arm.exits.length;
        users.forEach((from, rank) => {
          let target;
          if (e.turn === 'L') target = Math.min(rank, m - 1);
          else if (e.turn === 'R') target = m - 1 - Math.min(users.length - 1 - rank, m - 1);
          else target = Math.min(m - 1, Math.max(0, from.index - (n - m > 0 && users[0].index > 0 ? users[0].index : 0)));
          connect(j, arm, from, e.arm.exits[target], e.turn);
        });
      });
    }
    // which movements get in each other's way: they cross, or end in the same lane
    for (let a = 0; a < j.moves.length; a++) {
      for (let b = a + 1; b < j.moves.length; b++) {
        const m = j.moves[a], o = j.moves[b];
        if (m.from === o.from) continue;
        // side by side from one road into different lanes: in each other's way only if the two curves all but touch
        if (m.arm === o.arm && m.to !== o.to) { if (tooClose(m.pts, o.pts, 1.5)) { m.conflicts.push(o); o.conflicts.push(m); } continue; }
        if (m.to === o.to || tooClose(m.pts, o.pts, 1.5)) { m.conflicts.push(o); o.conflicts.push(m); }
        // a bus swings wide of its line: the movements it would brush as well
        if (m.to === o.to || tooClose(m.pts, o.pts, 3.2)) { m.wide.push(o); o.wide.push(m); }
      }
    }
  }

  // ---- who goes first
  for (const j of junctions) {
    const real = j.arms.length >= 3;
    for (const arm of j.arms) arm.crossing = real && !j.knot && !arm.link.short && arm.link.clear[arm.end] >= 3;      // is there a zebra crossing over this arm?
    if (!real) continue;
    // the two arms that make up the main road set the axes: 0 along it, 1 across it
    const main = [...j.arms].sort((a, b) => b.rank - a.rank || b.road.w - a.road.w)[0];
    for (const arm of j.arms) {
      const dot = Math.abs(arm.dir[0] * main.dir[0] + arm.dir[1] * main.dir[1]);
      arm.axis = dot > Math.SQRT1_2 ? 0 : 1;
    }
    const opposite = arm => j.arms.filter(o => o !== arm && o.axis === arm.axis && o.entries.length && o.dir[0] * arm.dir[0] + o.dir[1] * arm.dir[1] < -0.5);
    for (const m of j.moves) m.opposed = m.turn === 'L' && opposite(m.arm).some(o => o.turns.some(t => t !== 'L'));

    // Lights where through streets cross - but not where the plan comes out as a single stage (a road
    // dividing into two carriageways, say), which would only stop traffic for nothing.
    const plan = !j.knot && j.arms.filter(a => SIGNALISED.test(a.road.k)).length >= 3 && j.arms.filter(a => a.entries.length).length >= 2 ? programme(j) : null;
    if (plan && plan.stages.length >= 2) {
      j.control = 'signal';
      j.signal = plan;
      for (const arm of j.arms) if (arm.entries.length) arm.give = 'signal';
    } else {
      j.control = 'priority';
      for (const arm of j.arms) arm.arrow = false;
      const top = Math.max(...j.arms.map(a => a.rank)), mains = j.arms.filter(a => a.rank === top);
      const equal = mains.length === j.arms.length || mains.length > 2;       // no street outranks the others
      // Where a one-way street carries straight on (a roundabout ring, a slip road being joined), it goes first.
      const flows = equal ? j.arms.filter(a => a.road.ow && a.entries.some(l => l.out.some(m => m.turn === 'S' && m.to.road.ow))) : [];
      for (const arm of j.arms) arm.give = flows.length === 1 ? (arm === flows[0] ? 'none' : 'stop') : equal ? 'equal' : arm.rank === top ? 'none' : 'stop';
      for (const m of j.moves) m.priority = m.arm.give === 'stop' ? 1 : m.arm.give === 'equal' ? 1.5 : m.turn === 'L' ? 2 : 3;
    }
  }

  return { nodes: [...nodes.values()], links, lanes, junctions, moves };
}

// The signal programme of a junction: a list of stages, each naming the arms that get the green for
// going straight and right (`through`) and the arms that may turn left (`left`), and the arms people
// may walk across meanwhile. Every stage is followed by amber and a moment of red all round.
function programme(j) {
  const entering = j.arms.filter(a => a.entries.length), movesOf = arm => j.moves.filter(m => m.arm === arm);
  const goes = (m, stage) => stage[m.turn === 'L' ? 'left' : 'through'].includes(m.arm);
  // no two movements from different arms that get in each other's way, unless one of them gives way
  const safe = stage => j.moves.every(m => !goes(m, stage) || m.yields || m.conflicts.every(o => o.arm === m.arm || o.yields || !goes(o, stage)));
  const top = Math.max(...entering.map(a => a.rank));

  // The usual arrangement: the two directions of a street run together, the cross street after them.
  // A multi-lane approach that has to turn left across oncoming traffic gets an arrow first; on small
  // streets the left turn simply gives way.
  let stages = [];
  const axes = [0, 1].map(ax => entering.filter(a => a.axis === ax));
  if (axes.every(list => list.length <= 2)) {
    for (const list of axes) {
      if (!list.length) continue;
      const opposed = list.filter(a => movesOf(a).some(m => m.opposed)), lead = opposed.some(a => a.entries.length >= 2);
      if (lead) stages.push({ through: [], left: opposed, dur: T.left });
      else for (const a of opposed) for (const m of movesOf(a)) if (m.opposed) { m.yields = true; m.priority = 2; }
      stages.push({ through: list, left: lead ? list.filter(a => !opposed.includes(a)) : list, dur: list.some(a => a.rank === top) && top >= 3 ? T.major : T.minor });
    }
    if (!stages.every(safe)) stages = [];
  } else stages = [];
  // Odd-shaped junctions: each approach in turn, straight and left together.
  if (!stages.length) {
    for (const m of j.moves) { m.yields = false; m.priority = 3; }
    const each = entering.length > 4 ? T.minor - 4 : T.minor;       // keep the whole round from getting too long
    stages = entering.map(a => ({ through: [a], left: [a], dur: a.rank === top ? each + 2 : each - 2, split: true }));
  }

  const steps = [];
  let t = 0;
  for (const stage of stages) {
    // People may cross an arm while nothing is released from it and nothing runs straight onto it. Traffic
    // turning onto the arm has to give way to them - except during an arrow-only stage, which is the
    // drivers' turn.
    const arrowOnly = !stage.through.length;
    stage.walk = stage.dur < T.flash + 4 ? [] : j.arms.filter(arm => j.moves.every(m => !goes(m, stage)
      || m.arm !== arm && (m.to.from !== arm || m.turn === 'R' || m.turn === 'L' && !arrowOnly)));
    for (const [kind, dur] of [['green', stage.dur], ['amber', T.amber], ['allRed', T.allRed]]) { steps.push({ stage, kind, dur, at: t }); t += dur; }
  }
  // which approaches show a left-turn arrow
  for (const arm of entering) {
    arm.arrow = movesOf(arm).some(m => m.turn === 'L' && !m.yields) && stages.some(st => st.left.includes(arm) && (st.split || !st.through.includes(arm)));
  }
  const seed = Math.abs(Math.sin(j.x * 12.9898 + j.z * 78.233) * 43758.5453) % 1;
  return { stages, steps, cycle: t, offset: seed * t };
}

// What a signalised junction shows at `time` (seconds). Returns { step, remain, arms }, where arms[arm.id]
// is { through, left: 'G' | 'Y' | 'R', walk: 'walk' | 'flash' | 'stop' } - the lamp for going straight
// or right, the lamp for turning left, and the signal for people crossing that arm.
export function signalState(junction, time) {
  const sig = junction.signal, t = ((time + sig.offset) % sig.cycle + sig.cycle) % sig.cycle;
  const step = sig.steps.findLast(s => s.at <= t), remain = step.dur - (t - step.at), stage = step.stage;
  const lamp = on => (!on || step.kind === 'allRed' ? 'R' : step.kind === 'green' ? 'G' : 'Y');
  const arms = junction.arms.map(arm => ({
    through: lamp(stage.through.includes(arm)), left: lamp(stage.left.includes(arm)),
    walk: step.kind !== 'green' || !stage.walk.includes(arm) ? 'stop' : remain > T.flash ? 'walk' : 'flash',
  }));
  return { step, remain, arms };
}

// Is this lamp of a signal head lit? role: 'red' | 'amber' | 'arrow' | 'green'; s: the arm's entry in
// signalState().arms. While only the arrow runs, the red stays on beside it.
// The pedestrian head has 'walkRed' and 'walkGreen' (which flashes towards the end; `time` in seconds).
export const lampLit = (role, s, time = 0) => (role === 'green' ? s.through === 'G' : role === 'arrow' ? s.left === 'G'
  : role === 'amber' ? s.through === 'Y' || s.through === 'R' && s.left === 'Y'
    : role === 'walkRed' ? s.walk === 'stop' : role === 'walkGreen' ? s.walk === 'walk' || s.walk === 'flash' && time % 1 < 0.5
      : s.through === 'R' && s.left !== 'Y');

// May this movement go, given the junction's signal state?  'go' | 'yield' (go if the way is clear) | 'stop'
export function mayGo(move, state) {
  const lamp = state.arms[move.arm.id][move.turn === 'L' ? 'left' : 'through'];
  return lamp !== 'G' ? 'stop' : move.yields ? 'yield' : 'go';
}
