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
    const p0 = lane.pts[0], p1 = lane.pts[1];
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
