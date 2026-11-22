// People on foot: they walk the pavements and footpaths of src/map/walks.js, wait at the kerb and cross
// on the zebra crossings when the signal or the traffic lets them, and get out of the way of the
// player's car. No rendering in here (see peopleview.js), so tools/check-people.mjs can run it under Node.
import { signalState } from './map/lanes.js';

const REACH = 125, GONE = 150;        // people are kept within sight of the player: further off they would be dots
const BODY = 0.3;                       // radius of a person, metres

function measure(edge) {
  const cum = [0];
  for (let i = 1; i < edge.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(edge.pts[i][0] - edge.pts[i - 1][0], edge.pts[i][1] - edge.pts[i - 1][1]));
  edge.cum = cum;
}
function poseAt(edge, s, out) {
  const cum = edge.cum, pts = edge.pts;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const seg = cum[i] - cum[i - 1] || 1, t = Math.min(1, Math.max(0, (s - cum[i - 1]) / seg)), a = pts[i - 1], b = pts[i];
  out.x = a[0] + (b[0] - a[0]) * t;
  out.z = a[1] + (b[1] - a[1]) * t;
  out.ux = (b[0] - a[0]) / seg;
  out.uz = (b[1] - a[1]) / seg;
}

// walks: from buildWalks. options: rand (0..1 generator), signalOf(junction) -> signal state.
export function createPeople(walks, options = {}) {
  const rand = options.rand || Math.random;
  let time = 0;
  const signalOf = options.signalOf || (j => signalState(j, time));
  for (const e of walks.edges) {
    measure(e);
    // more people along the sea front and the footpaths than in the back streets
    e.pull = e.len * (e.kind === 'path' ? (e.road.k === 'pedestrian' ? 4 : 2.2) : e.kind === 'side' ? (/^(secondary|tertiary|primary)/.test(e.road.k) ? 1.6 : 0.7) : 0);
  }
  const people = [], stats = { spawned: 0, crossed: 0, dodged: 0, waitedLong: 0 };
  let nextId = 1, nearby = [], nearbyAt = -9, nearbyFor = [0, 0];
  const pose = { x: 0, z: 0, ux: 0, uz: 1 };

  // the movements of traffic that pass over the crossing of an arm: out of the arm, and into it
  const over = arm => (arm.over ||= arm.junction.moves.filter(m => m.arm === arm || m.to.from === arm));

  // May someone step onto this crossing now? cars: the traffic; player: the player's car or null.
  function mayCross(p, edge, cars, player) {
    const arm = edge.arm, j = arm.junction, mx = (edge.a.x + edge.b.x) / 2, mz = (edge.a.z + edge.b.z) / 2;
    if (j.control === 'signal' && signalOf(j).arms[arm.id].walk !== 'walk') return false;
    for (const m of over(arm)) if (m.held > 0 || m.cars?.length) return false;          // a car is on its way across
    if (player && Math.hypot(player.x - mx, player.z - mz) < 18 && Math.hypot(player.vx, player.vz) > 2) return false;
    if (j.control !== 'signal') {
      // no lights: wait for a gap. Someone who has waited a long time steps out once nothing is close.
      const patient = p.wait < 18;
      for (const c of cars) {
        const d = Math.hypot(c.x - mx, c.z - mz);
        if (d < (patient ? 24 : 9) && c.v > 1.5 && (mx - c.x) * c.ux + (mz - c.z) * c.uz > 0) return false;
      }
    }
    return true;
  }

  function enter(p, edge, from) {
    if (p.edge?.kind === 'cross') { p.edge.arm.walkers--; stats.crossed++; }
    p.edge = edge;
    p.dir = edge.a === from ? 1 : -1;
    p.s = 0;
    p.next = null;
    if (edge.kind === 'cross') edge.arm.walkers = (edge.arm.walkers || 0) + 1;
  }
  // a crossing whose signal never shows "walk" is not used at all
  const usable = arm => (arm.usable ??= !arm.junction.signal || arm.junction.signal.stages.some(st => st.walk.includes(arm)));
  const liking = e => (e.kind !== 'cross' ? 1 : usable(e.arm) ? 0.5 : 0);
  // which way on from the node just reached: mostly straight on, sometimes over the road, rarely back
  function choose(p, node) {
    const others = node.edges.filter(e => e !== p.edge);
    if (!others.length) return p.edge;
    const usableOnes = others.filter(e => liking(e) > 0);
    if (!usableOnes.length) return p.edge;                 // nowhere to go but back
    let roll = rand() * usableOnes.reduce((s, e) => s + liking(e), 0);
    for (const e of usableOnes) { roll -= liking(e); if (roll <= 0) return e; }
    return usableOnes.at(-1);
  }
  function remove(p) {
    if (p.stand) p.stand.waiting--;
    if (p.edge.kind === 'cross') p.edge.arm.walkers--;
    people.splice(people.indexOf(p), 1);
  }

  // Is the body of a car a step ahead of this person (and not already all round them)?
  function carAhead(p, cars) {
    const within = (c, x, z, grow) => {
      const dx = x - c.x, dz = z - c.z;
      return Math.abs(dx * c.ux + dz * c.uz) < c.len / 2 + grow && Math.abs(dx * c.uz - dz * c.ux) < c.kind.wid / 2 + grow;
    };
    for (const c of cars) {
      if (Math.abs(c.x - p.x) > 8 || Math.abs(c.z - p.z) > 8) continue;
      if (within(c, p.x + p.ux * 0.9, p.z + p.uz * 0.9, 0.45) && !within(c, p.x, p.z, 0.2)) return true;
    }
    return false;
  }

  function walk(p, dt, cars, player) {
    const edge = p.edge;
    p.moving = false;
    // getting out of the way of the player's car comes before everything else
    if (player) {
      const speed = Math.hypot(player.vx, player.vz);
      if (speed > 0.8) {
        const dx = p.x - player.x, dz = p.z - player.z, ux = player.vx / speed, uz = player.vz / speed;
        const along = dx * ux + dz * uz, side = dx * uz - dz * ux;
        if (along > -1.5 && along < 6 + speed * 1.5 && Math.abs(side) < 1.9) {
          if (p.dodge <= 0) stats.dodged++;
          p.dodge = 0.7;
          p.away = side >= 0 ? 1 : -1;
          p.awayX = uz * p.away;
          p.awayZ = -ux * p.away;
        }
      }
    }
    if (p.dodge > 0) {
      p.dodge -= dt;
      p.ox += p.awayX * 3.2 * dt;
      p.oz += p.awayZ * 3.2 * dt;
      p.moving = true;
    } else if (p.stand) {                                   // waiting for a bus: stays put, facing the road
      const k = Math.min(1, dt * 1.2);
      p.ox -= p.ox * k;
      p.oz -= p.oz * k;
    } else {
      // step back onto the line being walked
      const k = Math.min(1, dt * 1.2);
      p.ox -= p.ox * k;
      p.oz -= p.oz * k;
      const end = p.s >= edge.len;
      if (end && !p.next) p.next = choose(p, p.dir > 0 ? edge.b : edge.a);
      if (end && p.next.kind === 'cross' && p.next !== edge && !mayCross(p, p.next, cars, player)) {
        p.wait += dt;                                       // standing at the kerb
        if (p.wait > 90 && !p.counted) { p.counted = true; stats.waitedLong++; }
      } else if (end) {
        const node = p.dir > 0 ? edge.b : edge.a, to = p.next;
        if (to === edge) { p.dir = -p.dir; p.s = 0; p.next = null; } else enter(p, to, node);
        p.wait = 0;
        p.counted = false;
      } else if (!carAhead(p, cars)) {                      // nobody walks into the side of a car
        p.s = Math.min(edge.len, p.s + p.pace * (edge.kind === 'cross' ? 1.2 : 1) * dt);
        p.moving = true;
      }
    }
    if (p.stand) {
      p.x = p.bx + p.ox;
      p.z = p.bz + p.oz;
      const face = p.dodge > 0 ? [p.awayX, p.awayZ] : [p.stand.uz, -p.stand.ux], k = Math.min(1, dt * 6);
      p.ux += (face[0] - p.ux) * k;
      p.uz += (face[1] - p.uz) * k;
      if (p.moving) p.stride += dt * 11;
      return;
    }
    const on = p.edge;
    poseAt(on, p.dir > 0 ? p.s : on.len - p.s, pose);
    const ux = pose.ux * p.dir, uz = pose.uz * p.dir;
    // keep to one side of the pavement, so people going opposite ways pass each other
    const lat = on.kind === 'cross' ? p.lat * 1.4 : p.lat;
    p.x = pose.x - uz * lat + p.ox;
    p.z = pose.z + ux * lat + p.oz;
    const face = p.dodge > 0 ? [p.awayX, p.awayZ] : [ux, uz], k = Math.min(1, dt * 6);
    p.ux += (face[0] - p.ux) * k;
    p.uz += (face[1] - p.uz) * k;
    if (p.moving) p.stride += dt * (p.dodge > 0 ? 11 : p.pace * 4.6);
  }

  // someone waiting at a bus stop
  const AT_STOP = { kind: 'side' };
  function wait(stop, focus, near, hidden) {
    const along = (rand() - 0.5) * 3.4, back = -0.1 + rand() * 0.4,       // under the roof, in front of the bench
       x = stop.kx + stop.ux * along - stop.uz * back, z = stop.kz + stop.uz * along + stop.ux * back;
    const d = Math.hypot(x - focus.x, z - focus.z);
    if (d < near || d > REACH || (d < 90 && !hidden(x, z))) return false;
    stop.waiting++;
    people.push({
      id: nextId++, edge: AT_STOP, stand: stop, bx: x, bz: z, dir: 1, s: 0, next: null, pace: 1.2, lat: 0, wait: 0, counted: false,
      dodge: 0, away: 1, awayX: 0, awayZ: 0, ox: 0, oz: 0, moving: false, stride: 0, x, z, ux: stop.uz, uz: -stop.ux,
      look: [rand(), rand(), rand()], height: 0.9 + rand() * 0.2, carries: rand() < 0.85, umbrella: false,
    });
    stats.spawned++;
    return true;
  }

  function spawn(focus, near, hidden, wet) {
    if (!nearby.length) return false;
    let roll = rand() * nearby.total, edge = nearby[0];
    for (const e of nearby) { roll -= e.pull; if (roll <= 0) { edge = e; break; } }
    const s = rand() * edge.len;
    poseAt(edge, s, pose);
    const d = Math.hypot(pose.x - focus.x, pose.z - focus.z);
    if (d < near || d > REACH || (d < 90 && !hidden(pose.x, pose.z))) return false;
    const dir = rand() < 0.5 ? 1 : -1;
    const p = {
      id: nextId++, edge, dir, s: dir > 0 ? s : edge.len - s, next: null, pace: 1.05 + rand() * 0.5, lat: 0.02 + rand() * 0.22,
      wait: 0, counted: false, dodge: 0, away: 1, awayX: 0, awayZ: 0, ox: 0, oz: 0, moving: true, stride: rand() * 6,
      x: pose.x, z: pose.z, ux: pose.ux * dir, uz: pose.uz * dir,
      // what they look like: three numbers 0..1 for the view to pick colours and build from, and whether they carry an umbrella
      look: [rand(), rand(), rand()], height: 0.9 + rand() * 0.2, carries: rand() < 0.85, umbrella: false,
    };
    people.push(p);
    stats.spawned++;
    return true;
  }

  return {
    people, stats,
    // focus: where the player is; want: how many people to keep around; cars: the traffic (see traffic.js);
    // player: the player's car { x, z, vx, vz } or null; hidden(x, z): true where someone may appear unseen;
    // wet: 0..1 how hard it rains or snows. Returns what the player's car must do for the people ahead:
    // 0 nothing, 1 slow to walking pace, 2 stop.
    // stops: the bus stops (see map/stops.js), where a couple of people stand waiting.
    step(dt, { focus, want, cars = [], player = null, hidden = () => true, near = 30, wet = 0, stops = [] }) {
      time += dt;
      if (time - nearbyAt > 2 || Math.hypot(focus.x - nearbyFor[0], focus.z - nearbyFor[1]) > 40) {
        nearbyAt = time;
        nearbyFor = [focus.x, focus.z];
        nearby = walks.edges.filter(e => e.pull > 0 && Math.hypot((e.a.x + e.b.x) / 2 - focus.x, (e.a.z + e.b.z) / 2 - focus.z) < REACH);
        nearby.total = nearby.reduce((s, e) => s + e.pull, 0);
      }
      let brake = 0;
      for (let i = people.length - 1; i >= 0; i--) {
        const p = people[i], far = Math.hypot(p.x - focus.x, p.z - focus.z);
        if (far > GONE) { remove(p); continue; }
        walk(p, dt, cars, player);
        p.umbrella = p.carries && wet > 0.25;               // up when it rains or snows
        if (player) {
          const speed = Math.hypot(player.vx, player.vz);
          if (speed > 1) {
            const dx = p.x - player.x, dz = p.z - player.z, along = (dx * player.vx + dz * player.vz) / speed, side = Math.abs(dx * player.vz - dz * player.vx) / speed;
            // right in the way: stop. Close beside the way: slow to a crawl while passing.
            if (along > 0 && along < 4 + speed * speed / 12) brake = Math.max(brake, side < 1.35 ? 2 : side < 2.3 ? 1 : 0);
          }
        }
      }
      let standing = 0;
      for (const p of people) if (p.stand) standing++;
      // People keep a little apart: two who come too close step aside from each other.
      const cells = new Map();
      for (const p of people) {
        const key = `${Math.floor(p.x / 1.2)},${Math.floor(p.z / 1.2)}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(p);
      }
      for (const p of people) {
        const cx = Math.floor(p.x / 1.2), cz = Math.floor(p.z / 1.2);
        for (let i = cx - 1; i <= cx + 1; i++) for (let j = cz - 1; j <= cz + 1; j++) {
          for (const q of cells.get(`${i},${j}`) || []) {
            if (q.id <= p.id) continue;
            const dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz);
            if (d >= 0.62 || d < 1e-4) continue;
            // each steps to the side of their own way, never backwards, and only gradually
            const amount = Math.min(0.5, (0.62 - d) * 4) * dt;
            for (const [a, away] of [[p, -1], [q, 1]]) {
              const sx = -a.uz, sz = a.ux, side = (dx * sx + dz * sz) * away >= 0 ? 1 : -1;
              a.ox += sx * side * amount;
              a.oz += sz * side * amount;
            }
          }
        }
      }
      for (const stop of stops) {
        if (stop.shelter && standing < want * 0.25 && people.length < want && stop.waiting < 2 && Math.abs(stop.kx - focus.x) < REACH && Math.abs(stop.kz - focus.z) < REACH && wait(stop, focus, near, hidden)) standing++;
      }
      for (let tries = 0; tries < 3 && people.length < want; tries++) spawn(focus, near, hidden, wet);
      if (people.length > want) {
        const far = p => Math.hypot(p.x - focus.x, p.z - focus.z) > 50 && hidden(p.x, p.z);
        const spare = people.find(p => p.stand && far(p) && standing > want * 0.25) || people.find(p => p.edge.kind !== 'cross' && !p.stand && Math.hypot(p.x - focus.x, p.z - focus.z) > 50 && hidden(p.x, p.z));
        if (spare) remove(spare);
      }
      return brake;
    },
    // People near (x, z) as circles, for the player's car to be stopped by: cb(nx, nz, penetration).
    query(x, z, r, cb) {
      for (const p of people) {
        const dx = x - p.x, dz = z - p.z;
        if (Math.abs(dx) > 3 || Math.abs(dz) > 3) continue;
        const d = Math.hypot(dx, dz);
        if (d < r + BODY && d > 1e-6) cb(dx / d, dz / d, r + BODY - d);
      }
    },
    clear() { while (people.length) remove(people[0]); },
  };
}
