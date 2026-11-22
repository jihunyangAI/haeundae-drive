// Runs people and traffic together (src/people.js, src/traffic.js) without the game.
//   node tools/check-people.mjs [minutes] [people] [cars]
// Exits with an error if a car and a person end up in the same place.
import { readFileSync } from 'node:fs';
import { analyseStreets } from '../src/map/network.js';
import { buildLaneGraph } from '../src/map/lanes.js';
import { buildWalks } from '../src/map/walks.js';
import { createTraffic } from '../src/traffic.js';
import { createPeople } from '../src/people.js';

const minutes = Number(process.argv[2]) || 20, wantPeople = Number(process.argv[3]) || 80, wantCars = Number(process.argv[4]) || 40;
const map = JSON.parse(readFileSync(new URL('../public/map/haeundae/base.json', import.meta.url)));
const [X0, Z0] = map.meta.rect, CELL = 40;

// which carriageways are near a point (the game has its own version of this in world.js)
const grid = new Map();
for (const road of map.roads) {
  if (road.c !== 'drive') continue;
  for (let i = 2; i < road.p.length; i += 2) {
    const seg = { road, ax: road.p[i - 2], az: road.p[i - 1], bx: road.p[i], bz: road.p[i + 1] };
    const reach = road.w / 2 + 2;
    for (let cx = Math.floor((Math.min(seg.ax, seg.bx) - reach - X0) / CELL); cx <= Math.floor((Math.max(seg.ax, seg.bx) + reach - X0) / CELL); cx++) {
      for (let cz = Math.floor((Math.min(seg.az, seg.bz) - reach - Z0) / CELL); cz <= Math.floor((Math.max(seg.az, seg.bz) + reach - Z0) / CELL); cz++) {
        const key = `${cx},${cz}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(seg);
      }
    }
  }
}
const blocked = (x, z, own) => (grid.get(`${Math.floor((x - X0) / CELL)},${Math.floor((z - Z0) / CELL)}`) || []).some(s => {
  if (s.road === own) return false;
  const dx = s.bx - s.ax, dz = s.bz - s.az, t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(x - s.ax - dx * t, z - s.az - dz * t) < s.road.w / 2 + 0.3;
});
const mask = map.mask, land = new Uint8Array(mask.nx * mask.nz);
for (let r = 0, at = 0; r < mask.runs.length; at += mask.runs[r++]) if (r % 2) land.fill(1, at, at + mask.runs[r]);
const isLand = (x, z) => { const i = Math.round((x - X0) / 5), j = Math.round((z - Z0) / 5); return i >= 0 && j >= 0 && i < mask.nx && j < mask.nz && land[j * mask.nx + i] === 1; };

let seed = 4321;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const failures = [];
let printed = false;
for (const [name, x, z] of [['마린시티', 0, 0], ['해운대 시내', 2000, -350], ['공원 산책로', -300, -600]]) {
  const graph = buildLaneGraph(map, analyseStreets(map)), walks = buildWalks(graph, map, { blocked, isLand });
  if (!printed) {
    printed = true;
    const kinds = {};
    for (const e of walks.edges) { kinds[e.kind] ||= { n: 0, km: 0 }; kinds[e.kind].n++; kinds[e.kind].km += e.len / 1000; }
    for (const k of Object.values(kinds)) k.km = +k.km.toFixed(1);
    console.log(JSON.stringify({ walkNodes: walks.nodes.length, edges: kinds, deadEnds: walks.nodes.filter(n => n.edges.length === 1).length, lonely: walks.nodes.filter(n => !n.edges.length).length, crossingsWithZebra: graph.junctions.flatMap(j => j.arms).filter(a => a.zebra).length }));
  }
  const traffic = createTraffic(graph, { rand }), people = createPeople(walks, { rand, signalOf: j => traffic.signalOf(j) });
  const focus = { x, z }, dt = 0.1, steps = minutes * 60 / dt;
  let hits = 0, walking = 0, samples = 0, onCrossing = 0, least = Infinity;
  const touching = new Set();
  for (let i = 0; i < steps; i++) {
    traffic.step(dt, { focus, want: wantCars, near: i < 300 ? 0 : 90, people: people.people });
    people.step(dt, { focus, want: wantPeople, cars: traffic.cars, near: 0 });
    for (const p of people.people) {
      samples++;
      if (p.moving) walking++;
      if (p.edge.kind === 'cross') onCrossing++;
      for (const c of traffic.cars) {
        const dx = p.x - c.x, dz = p.z - c.z;
        if (Math.abs(dx) > 8 || Math.abs(dz) > 8) continue;
        const along = dx * c.ux + dz * c.uz, side = dx * c.uz - dz * c.ux, key = `${p.id}-${c.id}`;
        const hit = Math.abs(along) < c.len / 2 + 0.1 && Math.abs(side) < c.kind.wid / 2 + 0.1;
        if (hit && !touching.has(key)) { hits++; if (hits <= 4) failures.push(`${name}: a ${c.kind.id} (v=${c.v.toFixed(1)}, ${c.path.turn ? `move ${c.path.turn} j${c.path.junction.id}` : `lane to j${c.path.to.junction.id}`}) and a person on a '${p.edge.kind}' edge meet at t=${Math.round(i * dt)}s; car s=${c.s.toFixed(1)}/${c.path.len.toFixed(1)} why=${c.why} wait=${c.wait.toFixed(1)}; person along=${along.toFixed(2)} side=${side.toFixed(2)} moving=${p.moving} dodge=${p.dodge > 0} s=${p.s.toFixed(1)}/${p.edge.len.toFixed(1)} arm=${p.edge.arm ? `j${p.edge.arm.junction.id}/${p.edge.arm.id}` : '-'} lat=${p.lat.toFixed(2)}`); }
        if (hit) touching.add(key); else touching.delete(key);
      }
    }
    if (i > 300) least = Math.min(least, people.people.length);
  }
  const s = people.stats, t = traffic.stats;
  console.log(JSON.stringify({ place: name, minutes, people: `${least}-${wantPeople}`, walkingShare: +(walking / samples).toFixed(2), onCrossingShare: +(onCrossing / samples).toFixed(3), crossingsMade: s.crossed, waitedOver90s: s.waitedLong, carAndPersonMeet: hits, cars: { crossed: t.crossed, stuck: t.stuck, why: t.why } }));
  if (hits) failures.push(`${name}: ${hits} times a car and a person were in the same place`);
  if (walking / samples < 0.5) failures.push(`${name}: people stand still most of the time`);
}
if (failures.length) { for (const f of failures) console.error('ERROR', f); process.exit(1); }
console.log('ok');
