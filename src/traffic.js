// Other cars: they follow the lanes of src/map/lanes.js, keep their distance, obey signals and the
// priority rules at junctions, and give way to the player's car. No rendering in here (see
// trafficview.js), so tools/check-traffic.mjs can run it under Node.
import { signalState } from './map/lanes.js';
import { limitOf } from './map/network.js';

// What drives around. len, wid in metres; weight: how common; major: only on through streets.
export const KINDS = [
  { id: 'sedan', len: 4.7, wid: 1.84, weight: 30 }, { id: 'hatch', len: 3.95, wid: 1.74, weight: 22 },
  { id: 'suv', len: 4.75, wid: 1.93, weight: 22 }, { id: 'taxi', len: 4.7, wid: 1.84, weight: 9 },
  { id: 'van', len: 5.2, wid: 1.95, weight: 6 }, { id: 'truck', len: 5.1, wid: 1.76, weight: 6 },
  { id: 'bus', len: 10.8, wid: 2.48, weight: 4, major: true }, { id: 'sport', len: 4.45, wid: 1.9, weight: 1 },
];

const ACCEL = 1.7, BRAKE = 2.4, HARD = 3.2;    // m/s²: pulling away, easy braking, the most a driver brakes for amber
const STANDSTILL = 2.2, HEADWAY = 1.3;         // gap kept to the car in front: metres at rest, plus seconds of travel
const REACH = 340, SPAWN_FAR = 330, GONE = 400;
const PICK = { S: 4, R: 1.5, L: 1.2, U: 0.3 }; // how likely each turn is chosen

function measure(path) {
  const cum = [0];
  for (let i = 1; i < path.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(path.pts[i][0] - path.pts[i - 1][0], path.pts[i][1] - path.pts[i - 1][1]));
  path.cum = cum;
  path.len = cum.at(-1);
}
// position and direction at distance s along a lane or a movement
function poseAt(path, s, out) {
  const cum = path.cum, pts = path.pts;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const seg = cum[i] - cum[i - 1] || 1, t = Math.min(1, Math.max(0, (s - cum[i - 1]) / seg));
  const a = pts[i - 1], b = pts[i];
  out.x = a[0] + (b[0] - a[0]) * t;
  out.z = a[1] + (b[1] - a[1]) * t;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);          // a path of no length has no direction: ux = uz = 0
  out.ux = len > 1e-6 ? (b[0] - a[0]) / len : 0;
  out.uz = len > 1e-6 ? (b[1] - a[1]) / len : 0;
}
// how fast a movement can be driven: gentle sideways force round its bend
function turnSpeed(move) {
  let turned = 0;
  for (let i = 2; i < move.pts.length; i++) {
    const a = move.pts[i - 2], b = move.pts[i - 1], c = move.pts[i];
    turned += Math.abs(Math.atan2((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]), (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])));
  }
  return turned < 0.25 ? 30 : Math.min(14, Math.max(2.5, Math.sqrt(1.8 * move.len / turned)));
}

// graph: from buildLaneGraph. options: rand (0..1 generator), signalOf(junction) -> signal state.
export function createTraffic(graph, options = {}) {
  const rand = options.rand || Math.random;
  let time = 0;
  const signalOf = options.signalOf || (j => signalState(j, time));
  for (const lane of graph.lanes) { measure(lane); lane.cars = []; lane.limit = limitOf(lane.road) / 3.6; }
  for (const move of graph.moves) { measure(move); move.cars = []; move.held = 0; move.speed = turnSpeed(move); }
  const cars = [], events = [], stats = { spawned: 0, left: 0, stuck: 0, ranRed: 0, crossed: 0, bumped: 0, busStops: 0, why: {}, where: [] };
  let nextId = 1, nearby = [], nearbyAt = -9, nearbyFor = [0, 0];
  const totalWeight = list => list.reduce((s, k) => s + k.weight, 0);

  const chooseNext = (car, lane) => {
    const list = lane.out;
    if (!list.length) return null;
    // a bus keeps straight on where it can: its route follows the main road, and it is too long for the tight corners
    const straight = car.kind.major && list.some(m => m.turn === 'S'), liking = m => (straight && m.turn !== 'S' ? 0 : PICK[m.turn]);
    let roll = rand() * list.reduce((s, m) => s + liking(m), 0);
    for (const m of list) { if (!liking(m)) continue; roll -= liking(m); if (roll <= 0) return m; }
    return list.at(-1);
  };

  // The way on from a lane: the next movement and, where that leads into the short lanes of a knot of
  // junctions, the movements after it until a proper lane is reached. A car crosses such a knot in one
  // go or not at all, so the short lanes never fill up and lock.
  // a lane the car cannot wait in: part of a knot, or simply shorter than the car
  const passing = (car, lane) => lane.link.short || lane.len < car.len + 4;
  const plan = (car, lane) => {
    car.next = chooseNext(car, lane);
    car.beyond = [];
    for (let m = car.next, n = 0; m && passing(car, m.to) && n < 8; n++) {
      m = chooseNext(car, m.to);
      if (m && m.junction.control === 'signal') break;      // the lights ahead are obeyed when it gets there, not booked in advance
      if (m) car.beyond.push(m);
    }
  };
  // Taking and giving back leave to cross. A long vehicle also keeps others off the movements beside its own.
  const long = car => car.len > 7;
  // Are two things on different levels - one on a bridge, the other on the road under it? By their heights
  // where the game gives them (car.y), else by the level of the lanes they are on.
  const apart = (a, b) => (a.y !== undefined && b.y !== undefined ? Math.abs(a.y - b.y) > 3 : (a.path?.level | 0) !== (b.path?.level | 0));
  const hold = (car, move) => { car.held.push(move); move.held++; };
  const release = (car, move) => {
    const at = car.held.indexOf(move);
    if (at < 0) return;
    car.held.splice(at, 1);
    move.held--;
  };

  function remove(car) {
    const at = car.path.cars.indexOf(car);
    if (at >= 0) car.path.cars.splice(at, 1);
    for (const m of [...car.held]) release(car, m);
    cars.splice(cars.indexOf(car), 1);
  }

  // May this car start across the junction now? Through a knot, every movement on the way must be free.
  function clear(car, move, toLine) {
    if (!free(car, move, toLine, false, car.beyond.length > 0)) return false;
    for (const m of car.beyond) {
      if (m.from.cars.length || m.from.into.some(i => i.held > 0)) { car.why = 'full'; return false; }
    }
    for (let i = 0; i < car.beyond.length; i++) if (!free(car, car.beyond[i], Infinity, true, i < car.beyond.length - 1)) return false;
    return true;
  }
  // onward: the car has leave planned beyond the lane this movement ends in, so it need not fit there
  function free(car, move, toLine, later = false, onward = false) {
    const j = move.junction, arm = move.arm, signalled = j.control === 'signal';
    const lampOf = m => signalOf(j).arms[m.arm.id][m.turn === 'L' ? 'left' : 'through'];
    if (signalled) {
      const lamp = lampOf(move);
      if (lamp === 'R') { car.why = 'signal'; return false; }
      if (lamp === 'Y' && car.v * car.v / (2 * HARD) < toLine) { car.why = 'signal'; return false; }
    } else if (!later && arm.give === 'stop' && !car.halted) { car.why = 'stopline'; return false; }
    // people on the zebra crossing ahead of the stop line, or on the one it will leave the junction over
    if (move.arm.walkers > 0 || move.to.from.walkers > 0) { car.why = 'people'; return false; }
    // room to clear the junction on the far side
    const to = move.to;
    let room = to.len, tail = null;
    for (const c of to.cars) if (c.s - c.len / 2 < room) { room = c.s - c.len / 2; tail = c; }
    for (const m of to.into) room -= m.held * (car.len + STANDSTILL);
    // a lane too short for the car is entered only when it is empty
    if (room < Math.min(car.len + 1.5, to.len - 0.01) && !(onward && passing(car, to))) { car.why = tail && tail.v < 0.3 && tail.why || 'full'; return false; }
    // a bus is swinging past on a movement beside this one (one standing in a queue is no danger)
    if (!long(car) && move.wide.some(o => o.cars.some(c => long(c) && c.v > 0.3))) { car.why = 'crossing'; return false; }
    for (const o of long(car) ? move.wide : move.conflicts) {
      if (o.held > 0) { car.why = 'crossing'; return false; }
      if (!move.conflicts.includes(o)) continue;
      // give way to traffic that comes first and is about to arrive
      const first = signalled ? move.yields && !o.yields && lampOf(o) === 'G' : o.priority > move.priority;
      if (!first) continue;
      for (const c of o.from.cars) {
        if (c.next === o && (o.from.len - c.s) / Math.max(c.v, 2) < 4.5 && !(c.v < 0.3 && c.wait > 4)) { car.why = 'giveway'; return false; }
      }
    }
    return true;
  }

  const pose = { x: 0, z: 0, ux: 0, uz: 1 };
  function drive(car, dt, player, people) {
    const path = car.path, onMove = !!path.turn;
    let gap = Infinity, lead = 0;
    // what is in the way, and (for a car) what is holding that one up in turn
    const see = (g, v, what, other) => { if (g < gap) { gap = g; lead = v; seen = other && other.v < 0.3 && other.why || what || ''; } };
    let seen = '';
    for (const c of path.cars) if (c !== car && c.s > car.s) see(c.s - car.s - (c.len + car.len) / 2, c.v, 'queue', c);
    let v0 = onMove ? Math.min(path.speed, path.to.limit) : path.limit * car.pace;
    const before = car.why;
    car.why = '';
    car.signal = '';

    const rest = path.len - car.s;
    if (onMove) {
      for (const c of path.to.cars) see(rest + c.s - (c.len + car.len) / 2, c.v, 'queue', c);
      if (path.turn === 'L' || path.turn === 'R') car.signal = path.turn;
    }
    // a bus pulls up at each stop on its lane and waits there a little while
    if (!onMove && path.stop && car.kind.id === 'bus' && car.served !== path.stop) {
      const to = path.stop.s - car.s;
      if (to > -0.5) {
        see(Math.max(0, to) + STANDSTILL - 0.2, 0, 'stop');
        if (to < 1.5 && car.v < 0.2) { car.dwell += dt; car.why = 'stop'; if (car.dwell > 9) { car.served = path.stop; car.dwell = 0; stats.busStops++; } }
      } else car.served = path.stop;
    }
    if (onMove) {
      // nothing more to decide until the junction is behind
    } else if (car.next) {
      const move = car.next, toLine = rest - car.len / 2;
      if (toLine < 35 && (move.turn === 'L' || move.turn === 'R')) car.signal = move.turn;
      v0 = Math.min(v0, Math.sqrt(move.speed * move.speed + 2 * 1.4 * Math.max(0, toLine)));          // slow for the bend ahead
      if (move.arm.give === 'equal' && toLine < 14) v0 = Math.min(v0, 4);
      if (move.arm.give === 'stop' && toLine < 1.5 && car.v < 0.3) car.halted = true;
      // leave to cross lapses if the lights have gone red since and there is still room to stop
      if (car.holds && move.junction.control === 'signal' && car.v * car.v / (2 * HARD) < toLine - 0.5
        && signalOf(move.junction).arms[move.arm.id][move.turn === 'L' ? 'left' : 'through'] === 'R') {
        for (const m of [...car.held]) release(car, m);
        car.holds = null;
      }
      // (where lanes close in on each other, whoever must wait does so a car's length back, clear of the one going through)
      const back = move.squeeze ? 7 : 0;
      if (!car.holds && toLine < car.v * car.v / (2 * BRAKE) + 6 + back) {
        if (clear(car, move, toLine)) {
          for (const m of [move, ...car.beyond]) hold(car, m);
          car.holds = move;
          car.heldAt = time;
        } else see(toLine - 0.4 + STANDSTILL - back, 0);
      }
      // the cars ahead across the junction: matters once it has leave to cross, and where the junction is
      // no more than a joint between two streets
      for (const c of move.cars) see(rest + c.s - (c.len + car.len) / 2, c.v, 'queue', c);
      for (const c of move.to.cars) see(rest + move.len + c.s - (c.len + car.len) / 2, c.v, 'queue', c);
    } else see(rest + STANDSTILL + 4, path.limit);       // the lane runs out (edge of the map): drive off the end

    // Whatever else is in the way: where lanes run into each other the paths alone do not tell.
    // A few points on the way ahead are tested against the bodies of the cars around.
    // The player's car is tested the same way, so a car turning a corner sees it and one on a bend is
    // not fooled by the lane beside it.
    let others = null;
    for (const c of cars) {
      // (a car on a bridge and one on the road under it have nothing to do with each other)
      if (c !== car && c.path !== path && !apart(c, car) && Math.abs(c.x - car.x) < 24 && Math.abs(c.z - car.z) < 24) (others ||= []).push(c);
    }
    car.blocked = false;
    const mind = player && !(Math.abs(player.y - car.y) > 3) && Math.abs(player.x - car.x) < 40 && Math.abs(player.z - car.z) < 40 ? player : null;
    let walkers = null;                                    // people close enough to be stepped in front of
    for (const p of people) if (Math.abs(p.x - car.x) < 22 && Math.abs(p.z - car.z) < 22) (walkers ||= []).push(p);
    if (others || mind || walkers) {
      const far = car.len / 2 + 5 + car.v * 2.6;
      for (let d = car.len / 2 + 0.8; d < far; d += 2.4) {
        let on = path, s = car.s + d;
        if (s > on.len) {                                  // carry on into the junction and beyond, if that is where it is going
          const then = onMove ? on.to : car.holds;
          if (!then) break;
          s -= on.len;
          on = then;
          if (s > on.len) { if (!on.to?.cum) break; s -= on.len; on = on.to; if (s > on.len) break; }
        }
        poseAt(on, s, pose);
        if (mind && Math.hypot(mind.x - pose.x, mind.z - pose.z) < car.kind.wid / 2 + 1.5) {
          const g = d - car.len / 2 - 2.2;
          if (g < gap) { see(g, Math.max(0, mind.vx * car.ux + mind.vz * car.uz), 'player'); car.blocked = true; car.why = 'player'; }
        }
        for (const p of walkers || []) {
          if (Math.hypot(p.x - pose.x, p.z - pose.z) < car.kind.wid / 2 + 0.55) { see(d - car.len / 2 - 1.2, 0, 'people'); break; }
        }
        for (const c of others || []) {
          if (c.path === on) continue;
          // a long vehicle swings wide of its line in a bend, so it keeps further from what stands beside it
          // turning, a car's tail cuts inside its line and a long vehicle's more so: it keeps further from what stands beside it
          const turning = onMove && path.turn !== 'S';
          const reach = (c.kind.wid + car.kind.wid) / 2 * 0.8 + (car.len > 7 && turning ? 0.7 : 0), span = c.len / 2 - c.kind.wid / 2;
          for (const k of [-1, 0, 1]) {
            if (Math.hypot(c.x + c.ux * span * k - pose.x, c.z + c.uz * span * k - pose.z) < reach) {
              see(d - car.len / 2 - 0.9, Math.max(0, c.v * (c.ux * car.ux + c.uz * car.uz)), 'insight', c);
              break;
            }
          }
        }
      }
    }


    let acc;
    if (car.bumped > 0) { car.bumped -= dt; car.v = 0; acc = 0; } else {
      const want = STANDSTILL + Math.max(0, car.v * HEADWAY + car.v * (car.v - lead) / (2 * Math.sqrt(ACCEL * BRAKE)));
      acc = ACCEL * (1 - (car.v / Math.max(v0, 0.1)) ** 4 - (gap < Infinity ? (want / Math.max(gap, 0.1)) ** 2 : 0));
      acc = Math.max(-7.5, acc);
      car.v = Math.max(0, car.v + acc * dt);
      if (gap < 0.25) car.v = 0;
    }
    car.braking = acc < -0.6 || car.v < 0.3;
    car.s += car.v * dt;

    // never over the line without leave to go
    if (!onMove && car.next && !car.holds && car.s > path.len - car.len / 2) { car.s = path.len - car.len / 2; car.v = 0; }
    if (car.s >= path.len) {
      if (onMove) {
        path.cars.splice(path.cars.indexOf(car), 1);
        release(car, path);
        car.holds = null;
        car.s -= path.len;
        car.path = path.to;
        car.path.cars.push(car);
        car.halted = false;
        car.served = null;
        if (car.beyond.length) { car.next = car.beyond.shift(); car.holds = car.held.includes(car.next) ? car.next : null; } else plan(car, car.path);
        stats.crossed++;
      } else if (car.next && car.holds) {
        if (path.cars.includes(car)) path.cars.splice(path.cars.indexOf(car), 1);
        // crossing on red is only all right for a car that was already committed when the lights changed
        if (car.next.junction.control === 'signal' && time - car.heldAt > 6 && signalOf(car.next.junction).arms[car.next.arm.id][car.next.turn === 'L' ? 'left' : 'through'] === 'R') stats.ranRed++;
        car.s -= path.len;
        car.path = car.next;
        car.path.cars.push(car);
        car.next = null;
      } else { stats.left++; return false; }
    }

    if (car.v < 0.2) {
      if (!car.why) car.why = seen;
      // a car that got leave to cross but has been held up short of the line gives the junction back
      if (!onMove && car.holds && time - car.heldAt > 3 && car.s <= path.len - car.len / 2 && !passing(car, path)) {
        for (const m of [...car.held]) release(car, m);
        car.holds = null;
      }
      car.wait += dt;
      if (car.why !== 'signal' && car.why !== 'stop') car.jam += dt;
      if (car.blocked && car.wait > 5 && time - car.honked > 7) { car.honked = time; events.push({ type: 'honk', x: car.x, z: car.z }); }
    } else car.wait = car.jam = 0;
    poseAt(car.path, car.s, pose);
    car.x = pose.x;
    car.z = pose.z;
    // the body swings round gradually rather than snapping from one stretch of the path to the next
    // The body lies along the line from where its rear axle is on the path to where its front axle is,
    // so it follows a bend the way a car does instead of swinging its nose wide.
    const reach = car.len * 0.3, on = car.path;
    poseAt(on, Math.max(0, car.s - reach), pose);
    const rx = pose.x, rz = pose.z;
    poseAt(on, Math.min(on.len, car.s + reach), pose);
    const fx = pose.x - rx, fz = pose.z - rz, span = Math.hypot(fx, fz);
    if (span > 0.2) {
      const k = Math.min(1, dt * 10), ux = car.ux + (fx / span - car.ux) * k, uz = car.uz + (fz / span - car.uz) * k, l = Math.hypot(ux, uz);
      if (l > 1e-6) { car.ux = ux / l; car.uz = uz / l; }
    }
    return true;
  }

  // Put a car on a lane near `focus`, out of the player's sight. near: the closest it may appear.
  function spawn(focus, near, hidden) {
    if (!nearby.length) return false;
    let roll = rand() * nearby.total, lane = nearby[0];
    for (const l of nearby) { roll -= l.pull; if (roll <= 0) { lane = l; break; } }
    const s = 6 + rand() * (lane.len - 12);
    poseAt(lane, s, pose);
    const d = Math.hypot(pose.x - focus.x, pose.z - focus.z);
    if (d < near || d > SPAWN_FAR || !lane.out.length || (d < 270 && !hidden(pose.x, pose.z))) return false;
    // clear of every other car, whatever lane it is on: a car arriving at speed needs room to stop
    if (cars.some(c => Math.hypot(c.x - pose.x, c.z - pose.z) < 24)) return false;
    const major = lane.to.rank >= 3, kinds = KINDS.filter(k => !k.major || major && lane.len > 30);
    let pick = rand() * totalWeight(kinds), kind = kinds[0];
    for (const k of kinds) { pick -= k.weight; if (pick <= 0) { kind = k; break; } }
    const car = {
      id: nextId++, kind, len: kind.len, path: lane, s, v: lane.limit * 0.6, pace: 0.82 + rand() * 0.16, next: null, beyond: [], held: [], holds: null, halted: false,
      wait: 0, jam: 0, bumped: 0, dwell: 0, served: null, honked: -99, blocked: false, braking: false, signal: '', why: '', tint: rand(),
      x: pose.x, z: pose.z, ux: pose.ux, uz: pose.uz,
    };
    plan(car, lane);
    lane.cars.push(car);
    cars.push(car);
    stats.spawned++;
    return true;
  }

  return {
    cars, events, stats, signalOf,
    get time() { return time; },
    // focus: { x, z } where the player is; want: how many cars to keep around; player: the player's car as
    // { x, z, vx, vz } or null; hidden(x, z): true where a car may appear unseen; near: closest spawn distance.
    // people: those on foot nearby (see people.js), whom the cars stop for.
    step(dt, { focus, want, player = null, hidden = () => true, near = 90, people = [] }) {
      time += dt;
      if (time - nearbyAt > 1.5 || Math.hypot(focus.x - nearbyFor[0], focus.z - nearbyFor[1]) > 60) {
        nearbyAt = time;
        nearbyFor = [focus.x, focus.z];
        nearby = graph.lanes.filter(l => !l.link.short && l.len > 16 && Math.hypot((l.pts[0][0] + l.pts.at(-1)[0]) / 2 - focus.x, (l.pts[0][1] + l.pts.at(-1)[1]) / 2 - focus.z) < REACH);
        for (const l of nearby) l.pull = l.len * (l.to.rank >= 3 ? 3 : 1);
        nearby.total = nearby.reduce((s, l) => s + l.pull, 0);
      }
      for (let i = cars.length - 1; i >= 0; i--) {
        const car = cars[i], far = Math.hypot(car.x - focus.x, car.z - focus.z);
        const alive = far < GONE && drive(car, dt, player, people);
        // a car that has sat in a jam for a long time is taken away, out of sight if possible
        const jammed = car.jam > 50 && (far > 70 && hidden(car.x, car.z) || car.jam > 120);
        if (jammed) {
          options.onStuck?.(car);
          stats.stuck++;
          const key = `${car.why || 'other'}${car.path.turn ? ' in junction' : ''}`;
          stats.why[key] = (stats.why[key] || 0) + 1;
          if (car.why !== 'queue' && stats.where.length < 40) stats.where.push(`${car.why} ${car.path.turn ? `move ${car.path.turn} j${car.path.junction.id}` : `lane->j${car.path.to.junction.id} ${car.next ? car.next.turn : '-'}`}`);
        }
        if (!alive || jammed) remove(car);
      }
      for (let tries = 0; tries < 4 && cars.length < want; tries++) spawn(focus, near, hidden);
      // too many for the hour or the setting: one that nobody is looking at goes
      if (cars.length > want) {
        const spare = cars.find(c => Math.hypot(c.x - focus.x, c.z - focus.z) > 60 && hidden(c.x, c.z));
        if (spare) remove(spare);
      }
    },
    // Circles of the cars near (x, z), for the player's car to collide with: cb(nx, nz, penetration).
    // y: the height of the asker; cars more than 3 m above or below it are not in its way
    query(x, z, r, cb, y) {
      for (const car of cars) {
        if (Math.abs(car.x - x) > 9 || Math.abs(car.z - z) > 9 || Math.abs(car.y - y) > 3) continue;
        const span = car.len / 2 - car.kind.wid / 2, n = car.len > 7 ? 5 : 3;
        for (let i = 0; i < n; i++) {
          const off = span * (2 * i / (n - 1) - 1), cx = car.x + car.ux * off, cz = car.z + car.uz * off;
          const dx = x - cx, dz = z - cz, d = Math.hypot(dx, dz), reach = r + car.kind.wid / 2;
          if (d >= reach || d < 1e-6) continue;
          if (car.bumped <= 0) stats.bumped++;
          car.bumped = 1.5;
          car.v = 0;
          cb(dx / d, dz / d, reach - d);
        }
      }
    },
    clear() { while (cars.length) remove(cars[0]); },
  };
}
