// Development only: lets the car drive itself to a place, fast, and reports how it went.
//   const { autoRun } = await import('/src/dev/autotest.js');
//   autoRun(game, { from: 'marine', to: 'namcheon', limit: 1000, traffic: 'normal' })
// from: a place to start at (omit to start where the car is). to: a place id, or null to follow the road.
const describe = p => (p ? (p.turn ? `M${p.id}${p.turn}(${p.from.id}>${p.to.id})` : `L${p.id} ${p.road.n || p.road.k} lv${p.level}`) : null);

export function autoRun(g, { from, to = null, limit = 900, traffic = 'normal' } = {}) {
  const st = g.autodrive.state, place = id => g.guide.places.find(p => p.id === id), car = g.car;
  if (from) {
    // the nearest lane to the place from which there is a way to where it is to go
    const a = place(from), b = to && place(to), far = l => Math.hypot(l.pts[0][0] - a.x, l.pts[0][1] - a.z);
    const lane = g.world.lanes.lanes.filter(l => far(l) < 400 && l.len > 20 && !l.level).sort((p, q) => far(p) - far(q)).find(l => !b || g.autodrive.route(l, b.x, b.z));
    if (!lane) return { err: 'no lane at start' };
    // (set down part way along the lane, not in the mouth of the junction it starts at, where other cars turn in)
    const k = Math.max(0, Math.min(lane.pts.length - 2, Math.floor(lane.pts.length / 2) - 1)), p0 = lane.pts[k], p1 = lane.pts[k + 1];
    car.reset(p0[0], p0[1], Math.atan2(p1[0] - p0[0], p1[1] - p0[1]));
    car.y = g.world.surface(p0[0], p0[1]);
  }
  g.setState('drive');
  g.setTraffic(traffic);
  g.guide.set(to);
  const hits = [], says = [];
  let impacts = 0;
  const collide = car.collide.bind(car);
  car.collide = solids => {
    // what is touched: the fixed world, a car, a person
    const src = { w: 0, t: 0, p: 0 }, r = car.spec.W / 2, span = car.spec.L / 2 - r;
    for (const off of [car.vis.centerZ + span, car.vis.centerZ, car.vis.centerZ - span]) {
      const x = car.x + Math.sin(car.heading) * off, z = car.z + Math.cos(car.heading) * off;
      g.world.query(x, z, r, () => { src.w++; }, car.y);
      g.traffic.query(x, z, r, () => { src.t++; }, car.y);
      g.people.query(x, z, r, () => { src.p++; });
    }
    const kmh = Math.round(car.vf * 3.6), i = collide(solids);
    if (i > 1.5) {
      impacts++;
      if (hits.length < 8) hits.push(`${Math.round(car.x)},${Math.round(car.z)} ${describe(st.path)} s${Math.round(st.s)} off${st.off.toFixed(1)} ${kmh}kmh i${i.toFixed(1)} ${src.w ? 'world' : ''}${src.t ? 'car' : ''}${src.p ? 'person' : ''}`);
    }
    return i;
  };
  if (!g.autodrive.toggle(car)) { delete car.collide; return { err: 'would not engage', at: [Math.round(car.x), Math.round(car.z)] }; }
  const toast = document.querySelector('#toast');
  const waits = {};
  let maxOff = 0, offAt = null, stopped = 0, longest = 0, where = null, dist = 0, px = car.x, pz = car.z, maxKmh = 0, offSum = 0, n = 0, said = toast.textContent, moveOff = 0, moveOffAt = null;
  const seconds = g.simulateAll(limit, () => {
    maxKmh = Math.max(maxKmh, car.vf * 3.6);
    offSum += st.off;
    n++;
    if (st.off > maxOff) { maxOff = st.off; offAt = `${Math.round(car.x)},${Math.round(car.z)} ${describe(st.path)} ${Math.round(car.vf * 3.6)}kmh`; }
    if (st.path?.turn && st.path.turn !== 'U' && st.off > moveOff) { moveOff = st.off; moveOffAt = `${describe(st.path)} ${Math.round(car.vf * 3.6)}kmh`; }
    if (toast.textContent !== said) { said = toast.textContent; if (says.length < 8) says.push(`${Math.round(n / 60)}s ${said}`); }
    dist += Math.hypot(car.x - px, car.z - pz);
    px = car.x;
    pz = car.z;
    if (Math.abs(car.vf) < 0.2) {
      const why = st.view.stopIn < 4 ? st.view.reason || '?' : st.view.lead ? '앞차' : '(없음)';
      waits[why] = (waits[why] || 0) + 1 / 60;
      stopped += 1 / 60;
      if (stopped > longest) { longest = stopped; where = `${Math.round(car.x)},${Math.round(car.z)} ${st.view.status}`; }
    } else stopped = 0;
    return !g.autodrive.on;
  });
  delete car.collide;
  const b = to && place(to);
  const report = {
    to, seconds: Math.round(seconds), km: +(dist / 1000).toFixed(2), stillOn: g.autodrive.on, leftM: b ? Math.round(Math.hypot(b.x - car.x, b.z - car.z)) : null,
    impacts, hits, avgOffM: +(offSum / Math.max(1, n)).toFixed(2), maxOffM: +maxOff.toFixed(1), offAt, maxOffInTurnM: +moveOff.toFixed(1), moveOffAt,
    maxKmh: Math.round(maxKmh), longestStopS: Math.round(longest), where, says, waitedS: Object.fromEntries(Object.entries(waits).map(([k, v]) => [k, Math.round(v)])),
  };
  g.autodrive.off();
  return report;
}

// Many short drives, to find where the car driving itself goes wrong.
//   autoSweep(game, { kind: 'narrow' | 'curvy' | 'any', count: 8, skip: 0, seconds: 300, traffic: 'normal' })
// Starts are spread over the map: one-lane two-way streets ('narrow'), lanes that wind ('curvy'), or any lane.
// Returns how each ended, and only the details of those that did not end well.
export function autoSweep(g, { kind = 'narrow', count = 8, skip = 0, seconds = 300, traffic = 'normal' } = {}) {
  const st = g.autodrive.state, car = g.car, places = g.guide.places;
  const winding = l => { let turned = 0; for (let i = 2; i < l.pts.length; i++) { const a = l.pts[i - 2], b = l.pts[i - 1], c = l.pts[i]; turned += Math.abs(Math.atan2((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]), (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]))); } return turned / l.len; };
  const pool = g.world.lanes.lanes.filter(l => !l.level && (kind === 'narrow' ? l.road.ln === 1 && !l.road.ow && l.len > 70 : kind === 'curvy' ? l.len > 110 && winding(l) > 0.012 : l.len > 60));
  const every = Math.max(1, Math.floor(pool.length / (count + skip))), runs = [], bad = [];
  for (let n = skip; n < skip + count && n * every < pool.length; n++) {
    const lane = pool[n * every];
    // somewhere to go: a place of the guide a fair way off that can be driven to
    let goal = null;
    for (let k = 0; k < places.length && !goal; k++) { const p = places[(n * 5 + k) % places.length]; if (Math.hypot(p.x - lane.pts[0][0], p.z - lane.pts[0][1]) > 500 && g.autodrive.route(lane, p.x, p.z)) goal = p; }
    const i = Math.max(0, Math.min(lane.pts.length - 2, Math.floor(lane.pts.length / 2) - 1)), p0 = lane.pts[i], p1 = lane.pts[i + 1];
    car.reset(p0[0], p0[1], Math.atan2(p1[0] - p0[0], p1[1] - p0[1]));
    car.y = g.world.surface(p0[0], p0[1]);
    g.setState('drive');
    g.setTraffic(traffic);
    g.guide.set(goal ? goal.id : null);
    const collide = car.collide.bind(car), hits = [];
    car.collide = solids => {
      const kmh = Math.round(car.vf * 3.6), impact = collide(solids);
      if (impact > 1.5 && hits.length < 3) hits.push(`${Math.round(car.x)},${Math.round(car.z)} ${describe(st.path)} off${st.off.toFixed(1)} ${kmh}kmh i${impact.toFixed(1)}`);
      return impact;
    };
    const run = { lane: lane.id, road: lane.road.n || lane.road.k, goal: goal?.id || null };
    if (!g.autodrive.toggle(car)) { delete car.collide; runs.push('would not engage'); bad.push({ ...run, end: 'would not engage' }); continue; }
    let still = 0, longest = 0, where = null, dist = 0, px = car.x, pz = car.z, maxOff = 0, offAt = null;
    const toast = document.querySelector('#toast');
    const t = g.simulateAll(seconds, () => {
      dist += Math.hypot(car.x - px, car.z - pz);
      px = car.x;
      pz = car.z;
      const limitOff = (st.keep || 0) + (st.path.count > 1 || st.path.to?.count > 1 ? 4.2 : 2.2);      // (a lane's width is allowed where lanes are changed)
      if (st.off > maxOff && st.off > limitOff && !(st.path.turn === 'U') && st.wide <= 0) { maxOff = st.off; offAt = `${Math.round(car.x)},${Math.round(car.z)} ${describe(st.path)} off${st.off.toFixed(1)}`; }
      still = Math.abs(car.vf) < 0.2 ? still + 1 / 60 : 0;
      if (still > longest) { longest = still; where = `${Math.round(car.x)},${Math.round(car.z)} ${g.world.roadAt(car.x, car.z, 14, car.y)?.name || ''} ${describe(st.path)} s${Math.round(st.s)}/${Math.round(st.path.len)} [${st.view.reason || (st.view.lead ? '앞차' : '-')}]`; }
      return !g.autodrive.on || still > 100;
    });
    delete car.collide;
    const said = toast.textContent, arrived = said.includes('도착');
    const end = arrived ? 'arrived' : !g.autodrive.on ? `off: ${said}` : still > 100 ? 'stuck' : 'driving';
    g.autodrive.off();
    runs.push(end.split(':')[0]);
    if (end !== 'arrived' && end !== 'driving' || hits.length || offAt || longest > 75) bad.push({ ...run, end, seconds: Math.round(t), metres: Math.round(dist), longestStop: Math.round(longest), where: longest > 45 || end === 'stuck' ? where : undefined, hits: hits.length ? hits : undefined, offAt: offAt || undefined });
  }
  const tally = {};
  for (const r of runs) tally[r] = (tally[r] || 0) + 1;
  return { kind, lanes: pool.length, tally, bad };
}

// What the car driving itself is doing and what is round it, in a few lines (for looking into a place where it stops).
export function autoDump(g) {
  const st = g.autodrive.state, car = g.car, hs = Math.sin(car.heading), hc = Math.cos(car.heading), p = st.path;
  const rel = (x, z) => { const dx = x - car.x, dz = z - car.z; return [+(dx * hs + dz * hc).toFixed(1), +(dx * hc - dz * hs).toFixed(1)]; };
  const wall = [];
  for (const off of [3.6, 2.8, 2, 1.2, 0, -1.4, -2.8]) for (const side of [0, 0.5, -0.5]) g.world.query(car.x + hs * off + hc * side, car.z + hc * off - hs * side, car.spec.W / 2, (nx, nz, pen) => { if (wall.length < 6) wall.push([off, side, +pen.toFixed(2)]); }, car.y);
  const move = p.turn ? p : p.out[0], num = v => (v === Infinity ? null : +v.toFixed(1));
  return {
    at: [Math.round(car.x), Math.round(car.z)], path: describe(p), s: num(st.s), len: num(p.len), lanes: p.turn ? null : `${p.road.ln}${p.road.ow ? ' one-way' : ''} w${p.road.w}`,
    reason: st.view.reason, stopIn: num(st.view.stopIn), set: num(st.view.set), lead: !!st.view.lead, halted: st.halted, hold: !!st.hold, give: move?.arm.give, control: move?.junction.control,
    v: num(car.vf), throttle: num(car.throttle), brake: num(car.brake), handbrake: car.handbrake, reverse: car.reverse,
    off: num(st.off), aside: num(st.aside), keep: st.keep, nudge: num(st.nudge), shift: st.shift, tight: st.tight, blockIn: num(st.blockIn), hook: num(st.hook), idle: num(st.idle), back: num(st.back), backs: st.backs, fails: st.fails,
    people: g.people.people.map(q => [...rel(q.x, q.z), q.moving ? 'walking' : 'standing']).filter(q => q[0] > -3 && q[0] < 10 && Math.abs(q[1]) < 3.5),
    cars: g.traffic.cars.map(c => [...rel(c.x, c.z), +c.v.toFixed(1), c.why || '', c.kind.id]).filter(c => Math.abs(c[0]) < 14 && Math.abs(c[1]) < 5),
    wall, toast: document.querySelector('#toast').textContent,
  };
}
// Drive from the middle of a lane until the car has stood still for `still` seconds (or the time is up), then dump.
export function autoStall(g, laneId, goal, { seconds = 200, still = 30, traffic = 'normal' } = {}) {
  const car = g.car, lane = g.world.lanes.lanes[laneId], i = Math.max(0, Math.floor(lane.pts.length / 2) - 1), p0 = lane.pts[i], p1 = lane.pts[i + 1];
  car.reset(p0[0], p0[1], Math.atan2(p1[0] - p0[0], p1[1] - p0[1]));
  car.y = g.world.surface(p0[0], p0[1]);
  g.setState('drive');
  g.setTraffic(traffic);
  g.guide.set(goal);
  if (!g.autodrive.toggle(car)) return { err: 'would not engage' };
  let stood = 0, dump = null;
  const t = g.simulateAll(seconds, () => {
    stood = Math.abs(car.vf) < 0.2 ? stood + 1 / 60 : 0;
    if (stood > still || !g.autodrive.on) { dump = autoDump(g); return true; }
    return false;
  });
  g.autodrive.off();
  return dump ? { seconds: Math.round(t), ...dump } : { fine: Math.round(t) };
}
