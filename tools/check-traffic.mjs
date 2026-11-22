// Runs the traffic simulation (src/traffic.js) without the game and reports how it behaves.
//   node tools/check-traffic.mjs [minutes] [cars]
// Exits with an error if cars cross on red, the traffic seizes up, or cars touch more than once in a
// quarter of an hour (a turning car now and then clips one waiting beside its path; see the stage notes).
import { readFileSync } from 'node:fs';
import { analyseStreets } from '../src/map/network.js';
import { buildLaneGraph } from '../src/map/lanes.js';
import { createTraffic } from '../src/traffic.js';
import { buildStops } from '../src/map/stops.js';

const minutes = Number(process.argv[2]) || 30, want = Number(process.argv[3]) || 40;
const map = JSON.parse(readFileSync(new URL('../public/map/haeundae/base.json', import.meta.url)));
const PLACES = [['마린시티', 0, 0], ['해운대 시내', 2000, -350], ['달맞이길 입구', 3300, -500], ['센텀 쪽', 600, -700]];
let seed = 12345;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const failures = [], touches = [];

for (const [name, x, z] of PLACES) {
  const graph = buildLaneGraph(map, analyseStreets(map)), stops = buildStops(graph);
  if (name === PLACES[0][0]) console.log(JSON.stringify({ busStops: stops.length, names: [...new Set(stops.map(s => s.name.replace(/ [0-9]+$/, '')))].join(', ') }));
  const traffic = createTraffic(graph, { rand });
  const focus = { x, z }, dt = 0.1, steps = minutes * 60 / dt;
  let overlaps = 0, speedSum = 0, samples = 0, moving = 0, least = Infinity, most = 0, worstJam = 0;
  const touching = new Set();
  for (let i = 0; i < steps; i++) {
    traffic.step(dt, { focus, want, near: i < 300 ? 0 : 90 });
    const cars = traffic.cars;
    if (i % 5 === 0) {
      for (let a = 0; a < cars.length; a++) {
        for (let b = a + 1; b < cars.length; b++) {
          const p = cars[a], q = cars[b];
          if (Math.abs(p.x - q.x) > 12 || Math.abs(p.z - q.z) > 12) continue;
          // bodies as rows of circles; a little overlap of the rounded corners is let pass
          let hit = false;
          for (const u of [-1, 0, 1]) for (const w of [-1, 0, 1]) {
            const ax = p.x + p.ux * u * (p.len / 2 - 0.9), az = p.z + p.uz * u * (p.len / 2 - 0.9), bx = q.x + q.ux * w * (q.len / 2 - 0.9), bz = q.z + q.uz * w * (q.len / 2 - 0.9);
            if (Math.hypot(ax - bx, az - bz) < 1.5) hit = true;
          }
          const key = `${p.id}-${q.id}`;
          if (hit && !touching.has(key)) { overlaps++; if (overlaps <= 5) touches.push(`${name}: ${p.kind.id} on ${describe(p)} and ${q.kind.id} on ${describe(q)} touch at t=${Math.round(i * dt)}s`); }
          if (hit) touching.add(key); else touching.delete(key);
        }
      }
    }
    if (i > 600) {
      for (const c of cars) { speedSum += c.v; samples++; if (c.v > 0.5) moving++; worstJam = Math.max(worstJam, c.jam); }
      least = Math.min(least, cars.length);
      most = Math.max(most, cars.length);
    }
  }
  const s = traffic.stats, share = moving / samples;
  console.log(JSON.stringify({ place: name, minutes, cars: `${least}-${most}`, meanKmh: +(speedSum / samples * 3.6).toFixed(1), movingShare: +share.toFixed(2), junctionsCrossed: s.crossed, busStopsServed: s.busStops, leftAtMapEdge: s.left, removedAsStuck: s.stuck, stuckBecause: s.why, where: s.where.slice(0, 12), longestJamS: Math.round(worstJam), overlaps, crossedOnRed: s.ranRed }));
  if (overlaps > minutes / 15) failures.push(`${name}: ${overlaps} overlaps`);
  if (s.ranRed) failures.push(`${name}: ${s.ranRed} cars crossed on red`);
  if (share < 0.35) failures.push(`${name}: only ${Math.round(share * 100)}% of cars moving`);
  if (s.stuck > minutes) failures.push(`${name}: ${s.stuck} cars removed as stuck`);
}
function describe(c) { const p = c.path; return p.turn ? `move ${p.id} (${p.turn}, junction ${p.junction.id})` : `lane ${p.id} of ${p.road.n || p.road.k}`; }
for (const t of touches) console.log('note:', t);
if (failures.length) { for (const f of failures) console.error('ERROR', f); process.exit(1); }
console.log('ok');
