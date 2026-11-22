// Development check, not part of the game: a simple automatic driver takes every car along a route of
// through streets, using the same simulation the player drives. The whole map must be loaded first,
// because the simulation runs without the frame loop that streams zones in:
//   await __game.world.loadAll()
//   (await import('/src/dev/laptest.js')).runLap(__game)                    loop round Marine City
//   (await import('/src/dev/laptest.js')).runLap(__game, { trip: true })    Marine City to the far end of Dalmaji-gil

const CITY = [-495, -495, 495, 495];      // the original 1 km square, for the loop

const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

function buildRoute(world, trip) {
  const m = world.map, box = trip ? [m.x0 + 20, m.z0 + 20, m.x1 - 20, m.z1 - 20] : CITY, nodes = new Map();
  const inside = (x, z) => x > box[0] && x < box[2] && z > box[1] && z < box[3];
  const node = (x, z) => {
    const k = `${x.toFixed(1)},${z.toFixed(1)}`;
    if (!nodes.has(k)) nodes.set(k, { x, z, adj: [], names: new Set() });
    return nodes.get(k);
  };
  for (const r of world.map.roads) {
    if (r.c !== 'drive' || r.br || r.k === 'service' || r.k === 'busway') continue;
    for (let i = 2; i < r.p.length; i += 2) {
      if (!inside(r.p[i - 2], r.p[i - 1]) || !inside(r.p[i], r.p[i + 1])) continue;
      const a = node(r.p[i - 2], r.p[i - 1]), b = node(r.p[i], r.p[i + 1]), d = Math.hypot(a.x - b.x, a.z - b.z);
      a.adj.push([b, d]);
      b.adj.push([a, d]);
      a.names.add(r.n);
      b.names.add(r.n);
    }
  }
  // keep the largest connected set of streets
  let main = [];
  const seen = new Set();
  for (const start of nodes.values()) {
    if (seen.has(start)) continue;
    const comp = [], stack = [start];
    seen.add(start);
    while (stack.length) {
      const u = stack.pop();
      comp.push(u);
      for (const [v] of u.adj) if (!seen.has(v)) { seen.add(v); stack.push(v); }
    }
    if (comp.length > main.length) main = comp;
  }
  const shortest = (a, b) => {
    const dist = new Map([[a, 0]]), prev = new Map(), open = new Set([a]);
    while (open.size) {
      let u = null;
      for (const n of open) if (!u || dist.get(n) < dist.get(u)) u = n;
      open.delete(u);
      if (u === b) break;
      for (const [v, d] of u.adj) {
        const nd = dist.get(u) + d;
        if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u); open.add(v); }
      }
    }
    const path = [b];
    while (path[0] !== a) path.unshift(prev.get(path[0]));
    return path;
  };
  const far = (score, from = main) => from.reduce((best, n) => (score(n) > score(best) ? n : best));
  const path = [];
  if (trip) {
    // from the start street in Marine City to the eastern end of Dalmaji-gil
    const start = far(n => -Math.hypot(n.x, n.z)), goal = far(n => n.x, main.filter(n => [...n.names].some(name => name.startsWith('달맞이길'))));
    path.push(...shortest(start, goal));
  } else {
    // loop through the four corners of the network
    const stops = [far(n => n.x + n.z), far(n => n.x - n.z), far(n => -n.x - n.z), far(n => n.z - n.x)];
    stops.forEach((stop, i) => path.push(...shortest(stop, stops[(i + 1) % stops.length]).slice(i ? 1 : 0)));
  }
  // drop out-and-back spurs (A, B, A) so the lap never asks for a U-turn
  for (let i = 1; i < path.length - 1;) {
    if (path[i - 1] === path[i + 1]) { path.splice(i, 2); i = Math.max(1, i - 1); } else i++;
  }
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z));
  const total = cum.at(-1);
  const at = s => {
    s = Math.min(total, Math.max(0, s));
    let i = 1;
    while (i < path.length - 1 && cum[i] < s) i++;
    const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return [path[i - 1].x + (path[i].x - path[i - 1].x) * t, path[i - 1].z + (path[i].z - path[i - 1].z) * t];
  };
  return { total, at };
}

export function runLap(game, { trip = false, limitSeconds = 1500 } = {}) {
  const { world } = game, { total, at } = buildRoute(world, trip);
  const streets = new Set();
  for (let s = 0; s < total; s += 20) {
    const name = world.roadAt(...at(s), 6)?.name;
    if (name) streets.add(name);
  }
  const report = { lapKm: +(total / 1000).toFixed(2), streets: [...streets], cars: {} };
  game.setState('drive');

  for (let index = 0; index < 4; index++) {
    game.selectCar(index);
    const car = game.car, [x0, z0] = at(0), [x1, z1] = at(5);
    car.reset(x0, z0, Math.atan2(x1 - x0, z1 - z0));
    const m = { prog: 0, maxOff: 0, offSum: 0, n: 0, maxKmh: 0, time: 0, impacts: 0, recoveries: 0, yMin: Infinity, yMax: -Infinity, hits: [] };
    let done = false, stuck = 0, recover = 0;
    const collide = car.collide.bind(car);
    car.collide = w => {
      const v = collide(w);
      if (v > 1) {
        m.impacts++;
        // what was hit: the nearest pole or trunk, and how far the car was from the route
        const post = world.posts.reduce((b, q) => (Math.hypot(q.x - car.x, q.z - car.z) < Math.hypot(b.x - car.x, b.z - car.z) ? q : b));
        m.hits.push({ km: +(m.prog / 1000).toFixed(2), x: Math.round(car.x), z: Math.round(car.z), kmh: Math.round(car.vf * 3.6), postM: +Math.hypot(post.x - car.x, post.z - car.z).toFixed(1), postR: post.r, road: world.roadAt(car.x, car.z)?.name ?? null });
      }
      return v;
    };

    game.simulate(limitSeconds, (t, c) => {
      if (done) return { up: 0, down: 1, steer: 0, handbrake: false };
      let off = Infinity, best = m.prog;
      for (let s = m.prog; s < m.prog + 25; s += 0.5) {
        const [px, pz] = at(s), d = Math.hypot(px - c.x, pz - c.z);
        if (d < off) { off = d; best = s; }
      }
      Object.assign(m, {
        prog: best, maxOff: Math.max(m.maxOff, off), offSum: m.offSum + off, n: m.n + 1, time: t,
        maxKmh: Math.max(m.maxKmh, c.vf * 3.6), yMin: Math.min(m.yMin, c.y), yMax: Math.max(m.yMax, c.y),
      });
      if (m.prog >= total - 3) done = true;

      // back up for a moment if the car has stopped against something
      stuck = Math.abs(c.vf) < 0.3 && t > 3 ? stuck + 1 / 60 : 0;
      if (stuck > 1.5 && recover <= 0) { recover = 2.5; m.recoveries++; }
      if (recover > 0) {
        recover -= 1 / 60;
        return { up: 0, down: recover < 2.3 ? 1 : 0, steer: 0, handbrake: false };
      }

      const look = 4 + Math.abs(c.vf) * 0.5;
      const bearing = s => { const [x, z] = at(s); return wrap(Math.atan2(x - c.x, z - c.z) - c.heading); };
      const err = bearing(m.prog + look), bend = Math.abs(bearing(m.prog + look * 3));
      // slow right down for sharp corners, and drive to the grip the weather leaves
      const target = (bend > 0.9 ? 10 : bend > 0.5 ? 18 : bend > 0.2 ? 30 : 50) / 3.6 * Math.sqrt(game.atmosphere?.grip ?? 1);
      return {
        up: c.vf < target ? 0.7 : 0, down: c.vf > target + 2 ? 0.6 : 0,
        steer: Math.max(-1, Math.min(1, err * 2.5)), handbrake: false,
      };
    });

    report.cars[car.spec.id] = {
      finished: done, progressKm: +(m.prog / 1000).toFixed(2), seconds: Math.round(m.time),
      avgOffPathM: +(m.offSum / m.n).toFixed(1), maxOffPathM: +m.maxOff.toFixed(1), maxKmh: Math.round(m.maxKmh),
      impacts: m.impacts, recoveries: m.recoveries, hits: m.hits.slice(0, 6), heightRange: [+m.yMin.toFixed(1), +m.yMax.toFixed(1)],
      finite: [car.x, car.z, car.heading, car.vx].every(Number.isFinite),
    };
  }
  return report;
}
