// Checks the lane network and signal programmes built from the map (src/map/lanes.js).
//   node tools/check-lanes.mjs
// Exits with an error if a rule is broken. Prints counts either way.
import { readFileSync } from 'node:fs';
import { analyseStreets } from '../src/map/network.js';
import { buildLaneGraph, signalState, mayGo, lampLit } from '../src/map/lanes.js';

const map = JSON.parse(readFileSync(new URL('../public/map/haeundae/base.json', import.meta.url)));
const [X0, Z0, X1, Z1] = map.meta.rect;
const t0 = performance.now();
const g = buildLaneGraph(map, analyseStreets(map));
const buildMs = Math.round(performance.now() - t0);
const errors = [], notes = [], clash = new Set();
const where = j => `junction ${j.id} at (${Math.round(j.x)}, ${Math.round(j.z)})`;
const atEdge = arm => { const p = arm.link.st.at(arm.end ? arm.link.st.len : 0); return p.x < X0 + 40 || p.x > X1 - 40 || p.z < Z0 + 40 || p.z > Z1 - 40; };

// 1. every lane leads somewhere and can be reached
let sinks = 0, sources = 0;
for (const lane of g.lanes) {
  if (!lane.to || !lane.from) { errors.push(`lane ${lane.id} is not attached to a junction at both ends`); continue; }
  if (!lane.out.length) sinks++;
  if (!lane.into.length) sources++;
}

// 2. movement paths are drivable
let tight = 0;
for (const m of g.moves) {
  // (the widest crossing on the map, where the eight-lane 동부산관광로 meets the coast road, has turns of about 115 m)
  // (a movement through a knot of slip roads follows the slip roads, and can be as long as they are)
  if (!(m.len < 180)) errors.push(`${where(m.junction)}: movement ${m.id} is ${Math.round(m.len)} m long`);
  for (let i = 2; i < m.pts.length; i++) {
    const a = m.pts[i - 2], b = m.pts[i - 1], c = m.pts[i];
    const turn = Math.abs(Math.atan2((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]), (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])));
    const step = Math.hypot(c[0] - b[0], c[1] - b[1]);
    if (m.turn !== 'U' && turn > 0.05 && step / turn < 3) { tight++; break; }
  }
}

// 3. signals: nothing that conflicts is given a plain green at the same time, everything gets a turn,
//    and nobody is sent across an arm while traffic is released from that arm
const signalled = g.junctions.filter(j => j.control === 'signal');
let withArrow = 0, split = 0, noWalk = 0;
for (const j of signalled) {
  if (j.arms.some(a => a.arrow)) withArrow++;
  if (j.signal.stages[0].split) split++;
  const served = new Set(), walked = new Set();
  for (let t = 0; t < j.signal.cycle; t += 0.5) {
    const state = signalState(j, t - j.signal.offset), going = j.moves.filter(m => mayGo(m, state) !== 'stop');
    for (const m of going) {
      served.add(m);
      for (const o of m.conflicts) {
        if (o.arm !== m.arm && going.includes(o) && mayGo(m, state) === 'go' && mayGo(o, state) === 'go' && m.id < o.id) {
          clash.add(`${where(j)}: ${m.turn} from arm ${m.arm.id} and ${o.turn} from arm ${o.arm.id} are both green`);
        }
      }
    }
    // every signal head shows exactly one of red, amber and green; an arrow only where the head has one
    for (const arm of j.arms.filter(a => a.entries.length)) {
      const s = state.arms[arm.id], on = ['red', 'amber', 'green'].filter(role => lampLit(role, s));
      if (on.length !== 1) clash.add(`${where(j)}: the head for arm ${arm.id} shows ${on.join('+') || 'nothing'} (through ${s.through}, left ${s.left})`);
      if (!arm.arrow && s.left === 'G' && s.through !== 'G') clash.add(`${where(j)}: arm ${arm.id} may turn left but its head has no arrow to say so`);
    }
    for (const arm of j.arms) {
      if (state.arms[arm.id].walk === 'stop') continue;
      walked.add(arm);
      if (going.some(m => m.arm === arm)) clash.add(`${where(j)}: people cross arm ${arm.id} while its traffic has green`);
      if (going.some(m => m.to.from === arm && (m.turn === 'S' || !state.step.stage.through.length))) clash.add(`${where(j)}: people cross arm ${arm.id} while traffic with right of way drives onto it`);
    }
  }
  for (const m of j.moves) if (!served.has(m)) errors.push(`${where(j)}: movement ${m.id} (${m.turn} from arm ${m.arm.id}) never gets green`);
  for (const arm of j.arms) if (!walked.has(arm)) { noWalk++; notes.push(`${where(j)}: no walk phase across arm ${arm.id} (${arm.road.k})`); }
}

// 4. how much of the network traffic can circulate in (largest strongly connected set of lanes)
const next = lane => lane.out.map(m => m.to);
let index = 0, best = 0;
const idx = new Map(), low = new Map(), on = new Set(), stack = [];
for (const root of g.lanes) {
  if (idx.has(root)) continue;
  const work = [[root, 0]];
  while (work.length) {
    const top = work.at(-1), [v, i] = top;
    if (i === 0) { idx.set(v, index); low.set(v, index++); stack.push(v); on.add(v); }
    const ns = next(v);
    if (i < ns.length) {
      top[1]++;
      const w = ns[i];
      if (!idx.has(w)) work.push([w, 0]); else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    } else {
      work.pop();
      if (work.length) { const p = work.at(-1)[0]; low.set(p, Math.min(low.get(p), low.get(v))); }
      if (low.get(v) === idx.get(v)) { let size = 0, w; do { w = stack.pop(); on.delete(w); size++; } while (w !== v); best = Math.max(best, size); }
    }
  }
}

errors.push(...clash);
const real = g.junctions.filter(j => j.arms.length >= 3), km = g.lanes.reduce((s, l) => s + l.len, 0) / 1000;
const deadEnds = g.junctions.filter(j => j.arms.length === 1);
console.log(JSON.stringify({
  buildMs, streets: new Set(g.links.map(l => l.st)).size, stretches: g.links.filter(l => !l.internal).length, insideJunctions: g.links.filter(l => l.internal).length,
  lanes: g.lanes.length, laneKm: +km.toFixed(1), movements: g.moves.length,
  junctions: { crossings: real.length, signalled: signalled.length, withLeftArrow: withArrow, eachApproachInTurn: split, armsNobodyMayCross: noWalk, priority: real.filter(j => j.control === 'priority').length, joints: g.junctions.filter(j => j.arms.length === 2).length, deadEnds: deadEnds.length, deadEndsAtMapEdge: deadEnds.filter(j => atEdge(j.arms[0])).length, arms: Object.fromEntries(Array.from({ length: 30 }, (_, n) => [n, g.junctions.filter(j => j.arms.length === n).length]).filter(e => e[0] >= 3 && e[1])), insideKnots: g.junctions.filter(j => j.knot).length, widest: Math.round(Math.max(...g.junctions.map(j => Math.max(...j.nodes.map(a => Math.hypot(a.x - j.x, a.z - j.z)))))) },
  turns: Object.fromEntries(['S', 'L', 'R', 'U'].map(t => [t, g.moves.filter(m => m.turn === t).length])),
  lanesWithNoWayOn: sinks, lanesNothingLeadsTo: sources, tightTurns: tight,
  circulatingShare: +(best / g.lanes.length).toFixed(3),
  signalCycles: [...new Set(signalled.map(j => Math.round(j.signal.cycle)))].sort((a, b) => a - b),
}, null, 1));
for (const n of notes.slice(0, 8)) console.log('note:', n);
if (notes.length > 8) console.log(`note: ... and ${notes.length - 8} more`);
if (errors.length) {
  for (const e of errors.slice(0, 25)) console.error('ERROR', e);
  console.error(`${errors.length} errors`);
  process.exit(1);
}
console.log('ok');
