// The car drives itself: it keeps its lane and its distance, obeys the lights, gives way, changes lane,
// turns at junctions and follows the route to the place chosen in the guide (or, with nowhere to go,
// simply carries on along the road). It works the same pedals and wheel a driver does - it returns the
// input for Vehicle.control() - so the car still behaves like the car it is, grip and weight and all.
//
// It reads the same lane graph the traffic drives on (src/map/lanes.js): lanes and the movements that
// join them across junctions, both called "paths" here: { pts, cum, len }.

const G = 9.81, COMFORT = 2.0, FIRM = 4.5;          // braking: what it plans with, and what it will use if it must
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

// where along a path the point nearest (x, z) is: { s, d } - distance along, and off to the side
function project(path, x, z, from = 0, to = Infinity) {
  const pts = path.pts, cum = path.cum;
  let best = Infinity, s = 0;
  for (let i = 1; i < pts.length; i++) {
    if (cum[i] < from || cum[i - 1] > to) continue;
    const ax = pts[i - 1][0], az = pts[i - 1][1], dx = pts[i][0] - ax, dz = pts[i][1] - az, l2 = dx * dx + dz * dz || 1;
    const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2)), d = Math.hypot(x - ax - dx * t, z - az - dz * t);
    if (d < best) { best = d; s = cum[i - 1] + (cum[i] - cum[i - 1]) * t; }
  }
  return { s, d: best };
}
function pointAt(path, s, out) {
  const cum = path.cum, pts = path.pts;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const seg = cum[i] - cum[i - 1] || 1, t = Math.min(1, Math.max(0, (s - cum[i - 1]) / seg));
  out[0] = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t;
  out[1] = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t;
  return out;
}

// world: { lanes (the graph), signalAt(junction), levelAt(x, z, y), heightFor(road) }. traffic: { cars }.
// people: { people }. guide: { goal }. say(text): tell the driver something.
export function createAutodrive({ world, traffic, people, guide, say = () => {}, arrived = () => {} }) {
  const graph = world.lanes;
  // every lane, findable by where it is
  const CELL = 30, cells = new Map(), cellOf = v => Math.floor(v / CELL);
  for (const lane of graph.lanes) {
    const seen = new Set();
    for (let s = 0; s <= lane.len; s += 10) {
      const [x, z] = pointAt(lane, s, []), key = cellOf(x) * 8192 + cellOf(z);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(lane);
    }
  }
  const lanesNear = (x, z, reach, visit) => {
    const done = new Set();
    for (let i = cellOf(x - reach); i <= cellOf(x + reach); i++) {
      for (let j = cellOf(z - reach); j <= cellOf(z + reach); j++) {
        for (const lane of cells.get(i * 8192 + j) || []) if (!done.has(lane)) { done.add(lane); visit(lane); }
      }
    }
  };
  // the lane a car at (x, z) facing `heading` on level `level` is in, or null
  function laneAt(x, z, heading, level, reach = 7) {
    let best = null, score = Infinity;
    lanesNear(x, z, reach + 5, lane => {
      if ((lane.level | 0) !== level) return;
      const { s, d } = project(lane, x, z);
      if (d > reach) return;
      const a = pointAt(lane, Math.max(0, s - 1), []), b = pointAt(lane, Math.min(lane.len, s + 1), []);
      const along = Math.cos(wrap(Math.atan2(b[0] - a[0], b[1] - a[1]) - heading));
      if (along < 0.3) return;                           // going the other way
      const sc = d + (1 - along) * 8;
      if (sc < score) { score = sc; best = lane; }
    });
    return best;
  }
  const beside = lane => lane.link.lanes.filter(o => o !== lane && o.dir === lane.dir && Math.abs(o.index - lane.index) === 1);

  // ---------- the way to the goal ----------
  // From a lane to any lane near (gx, gz): the lanes to pass through in order, each with how it is
  // reached from the one before ('change' for a lane change, else the movement across the junction).
  // (The lanes right by the place may be ones that cannot be got to - the far side of a divided road
  // that comes in from beyond the map - so the search widens until some lane near it can be reached.)
  function route(start, gx, gz) {
    for (const within of [40, 90, 160]) {
      const steps = routeWithin(start, gx, gz, within);
      if (steps) return steps;
    }
    return null;
  }
  function routeWithin(start, gx, gz, within) {
    const goals = new Set();
    lanesNear(gx, gz, within + 15, lane => { if (project(lane, gx, gz).d < within) goals.add(lane); });
    if (!goals.size) return null;
    const dist = new Map([[start, 0]]), prev = new Map(), heap = [[0, start]];
    const push = item => {
      let i = heap.length;
      heap.push(item);
      while (i > 0) { const up = (i - 1) >> 1; if (heap[up][0] <= item[0]) break; [heap[up], heap[i]] = [heap[i], heap[up]]; i = up; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        for (let i = 0; ;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    let end = null;
    while (heap.length) {
      const [d, lane] = pop();
      if (d > dist.get(lane)) continue;
      if (goals.has(lane)) { end = lane; break; }
      const reach = (next, cost, via) => {
        const nd = d + cost;
        if (nd < (dist.get(next) ?? Infinity)) { dist.set(next, nd); prev.set(next, [lane, via]); push([nd, next]); }
      };
      // (turning round is a last resort, and on a road with one lane each way the car cannot do it in one sweep)
      for (const move of lane.out) if (!blocked.has(move) && !blocked.has(move.to) && !(blocked.has(lane) && lane === start) && !(move.turn === 'U' && move.to.count < 2)) reach(move.to, lane.len + move.len + (move.turn === 'L' ? 12 : move.turn === 'U' ? (move.to.count >= 2 ? 250 : 4000) : 0), move);
      // changing lane costs a little, and needs room to do it in
      if (lane.len > 45) for (const other of beside(lane)) if (!blocked.has(other)) reach(other, 30, 'change');
    }
    if (!end) return null;
    const steps = [];
    for (let lane = end; lane !== start;) { const [from, via] = prev.get(lane); steps.unshift({ lane, via }); lane = from; }
    return steps;
  }

  // ---------- state ----------
  const st = {
    on: false, path: null, s: 0, plan: [], goal: null, planned: 0, hold: null, halted: false, arriving: false, from: [0, 0], waited: 0, last: null, lastS: 0, lost: false, heldStill: 0, signalled: false, keep: 0, askew: 0, hookFor: 0, turn: null, hook: 0, backs: 0, fails: 0, back: 0, idle: 0, forPeople: 0, noHold: null, noHoldFor: 0, wide: 0, off: 0, shift: 0, nudge: 0, aside: 0, blockIn: Infinity, blockOn: null, scan: 0, stuck: 0, pastFor: 0, tight: false,
    // what it is doing and seeing, for the display: status text, the speed it is keeping (m/s), the path ahead,
    // the car it is following, the light ahead
    view: { status: '', reason: '', set: 0, ahead: [], lead: null, lamp: null, stopIn: Infinity, cars: [], people: [] },
  };
  // Lanes and movements found to have something solid standing in them (a bridge's abutment, a wall where
  // two decks meet): the way is planned round them from then on.
  const blocked = new Set(), tried = new Set();
  // Fixed things in the way ahead. The line is tried as it is and shifted a little to either side; the
  // least shift that is clear is what the car steers for. If none is, it stops short of the thing.
  const SHIFTS = [0, 0.6, -0.6, 1.2, -1.2, 1.8, -1.8];
  function sense(car, v) {
    const reach = Math.max(10, v * v / (2 * COMFORT) + 9);
    let r = car.spec.W / 2 + 0.4;
    // (in the middle of a narrow street there is little room to the left: the line is not shifted far that way)
    const most = st.keep > 0.3 ? 0.7 : 1.9;
    if (st.shift > most) st.shift = 0;
    const clearAt = shift => {
      if (shift > most) return ahead[0] || [0, 0, 0, st.path];
      for (let i = 1; i < ahead.length; i++) {
        const p = ahead[i];
        if (p[2] < 0.5) continue;
        if (p[2] > reach) break;
        const q = ahead[i - 1], dx = p[0] - q[0], dz = p[1] - q[1], l = Math.hypot(dx, dz);
        if (l < 0.01) continue;
        let hit = false;
        // (measured from where the car means to run, which on a narrow street is its middle, not the lane's line)
        const seen = (nx, nz, pen) => { if (pen > 0.12) hit = true; }, ox = dz / l * (shift + st.keep), oz = -dx / l * (shift + st.keep);
        world.query(p[0] + ox, p[1] + oz, r, seen, car.y);
        if (l > 1.4) world.query((p[0] + q[0]) / 2 + ox, (p[1] + q[1]) / 2 + oz, r, seen, car.y);        // (and half way from the point before: a post is thin)
        if (hit) return p;
      }
      return null;
    };
    const first = clearAt(0);
    st.blockIn = Infinity;
    st.blockOn = null;
    // (the shift is kept until the car's whole length is past the thing)
    if (!first) { st.pastFor += 0.12; if (st.pastFor > (car.spec.L + 3) / Math.max(v, 1.5)) st.shift = 0; return; }
    st.pastFor = 0;
    st.tight = false;
    // (a shifted line is followed less exactly than the lane's own: more room is asked for)
    for (const room of [0.95, 0.65]) {
      r = car.spec.W / 2 + room;
      for (const shift of [st.shift, ...SHIFTS]) if (shift && !clearAt(shift)) { st.shift = shift; return; }
    }
    // no room to pass it comfortably: is there room to pass it at all, at a crawl?
    r = car.spec.W / 2 + 0.1;
    for (const shift of [st.shift, ...SHIFTS]) if (!clearAt(shift)) { st.shift = shift; st.tight = true; return; }
    st.blockIn = first[2];
    st.blockOn = first[3];
  }
  const release = () => { if (st.hold) { st.hold.held = Math.max(0, st.hold.held - 1); st.hold = null; } st.heldStill = 0; };
  const lampOf = move => world.signalAt(move.junction).arms[move.arm.id][move.turn === 'L' ? 'left' : 'through'];

  // the movement to take at the end of `lane`: the planned one, else straight on (or whatever there is)
  // The lanes from which one can drive on and on: all those that lead, sooner or later, to the busiest
  // knot of streets. The rest run out at the edge of the map; with no way planned, the car does not turn into them.
  let through = null;
  const leadsOn = lane => {
    if (!through) {
      // the middle of the town: the lane nearest the first place of the guide
      const hub = guide.places?.[0] || { x: 0, z: 0 };
      let seed = null, best = Infinity;
      for (const l of graph.lanes) { const d = Math.hypot(l.pts[0][0] - hub.x, l.pts[0][1] - hub.z); if (d < best && !l.level && l.out.length && l.into.length) { best = d; seed = l; } }
      through = new Set(seed ? [seed] : []);
      for (const queue = seed ? [seed] : []; queue.length;) {
        const l = queue.pop();
        for (const m of l.into) if (!through.has(m.from)) { through.add(m.from); queue.push(m.from); }
        for (const o of beside(l)) if (!through.has(o)) { through.add(o); queue.push(o); }
      }
    }
    return through.has(lane);
  };
  const nextMove = lane => {
    const step = st.plan.find(p => p.via !== 'change' && p.via.from === lane);
    if (step) return step.via;
    let out = lane.out.filter(m => !blocked.has(m) && !blocked.has(m.to) && m.to !== lane);      // (not round a loop back into the same lane)
    out = out.filter(m => m.turn !== 'U' || m.to.count >= 2);                                    // (nor turning round where there is not the room)
    const on = out.filter(m => leadsOn(m.to));
    if (on.length) out = on;
    return out.find(m => m.turn === 'S') || out.find(m => m.turn === 'R') || out.find(m => m.turn === 'L') || out[0] || null;
  };

  function replan(car) {
    st.planned = 0;
    st.goal = guide.goal;
    const lane = st.path.turn ? st.path.to : st.path;
    const found = st.goal ? route(lane, st.goal.x, st.goal.z) : null;
    st.plan = found || [];
    // the lane the way ends on, and how far along it the place is
    st.last = found ? (found.length ? found.at(-1).lane : lane) : null;
    st.lastS = st.last ? project(st.last, st.goal.x, st.goal.z).s : 0;
    if (st.goal && !found && !st.lost) say('목적지까지 가는 길을 찾지 못했습니다. 길을 따라 달립니다');
    st.lost = !!st.goal && !found;
  }

  function engage(car) {
    const lane = laneAt(car.x, car.z, car.heading, world.levelAt(car.x, car.z, car.y));
    if (car.reverse && Math.abs(car.vf) > 0.3) { say('후진 중에는 자율주행을 켤 수 없습니다'); return false; }
    if (!lane) { say('차로를 찾지 못해 자율주행을 켤 수 없습니다'); return false; }
    st.car = car;
    st.turn = null;
    st.forPeople = st.noHoldFor = st.aside = st.back = st.idle = st.fails = st.backs = st.hook = st.askew = st.hookFor = 0;
    Object.assign(st, { on: true, path: lane, s: project(lane, car.x, car.z).s, hold: null, halted: false, arriving: false, waited: 0, lost: false, shift: 0, nudge: 0, blockIn: Infinity, blockOn: null, scan: 0, stuck: 0 });
    replan(car);
    say(st.goal ? `자율주행 켜짐 · ${st.goal.name}까지` : '자율주행 켜짐 · 길을 따라 달립니다');
    return true;
  }
  function disengage(why, car = st.car) {
    if (!st.on) return;
    st.on = false;
    release();
    st.view.status = '';
    // an indicator the car put on itself is put out again
    if (st.signalled && car && (car.signal === 'left' || car.signal === 'right')) car.setSignal(car.signal);
    st.signalled = false;
    if (why) say(why);
  }

  // The path ahead of the car as points with the distance to each: [[x, z, d]], and what comes up on it.
  const ahead = [], tmp = [];
  function lookAhead(car, reach) {
    ahead.length = 0;
    let path = st.path, s = st.s, d = 0, lane = path.turn ? null : path;
    const events = { move: null, moveAt: Infinity, end: Infinity };
    for (let guard = 0; guard < 12 && d < reach; guard++) {
      // (no two points in the same place - where one path ends the next begins - for a direction is taken from each pair)
      const add = dist => {
        const last = ahead[ahead.length - 1];
        // (nor two a hand's breadth apart: where a lane starts round a corner its first step can be a stub
        // pointing anywhere, and the car would try to follow it)
        if (!last || Math.hypot(last[0] - tmp[0], last[1] - tmp[1]) > 1) ahead.push([tmp[0], tmp[1], dist, path]);
      };
      for (let q = s; q < path.len; q += 2.5) { pointAt(path, q, tmp); add(d + q - s); }
      d += path.len - s;
      pointAt(path, path.len, tmp);
      add(d);
      if (path.turn) { path = path.to; lane = path; } else {
        const move = nextMove(path);
        if (!move) { events.end = d; break; }
        if (!events.move) { events.move = move; events.moveAt = d; }
        path = move;
      }
      s = 0;
    }
    return events;
  }

  // ---------- one step: the input for the car ----------
  // inp: what the driver is doing ({ up, down, steer, handbrake }). grip: 0..1.
  function drive(dt, car, inp, grip = 1) {
    if (!st.on) return inp;
    // the driver takes over by steering or braking
    if (Math.abs(inp.steer) > 0.25 || inp.down > 0.2 || inp.handbrake) { disengage('자율주행 꺼짐 · 직접 운전합니다'); return inp; }
    // turning round in a dead end: forward on full lock one way, back on full lock the other, until it faces out
    if (st.turn) {
      const tn = st.turn, a = tn.to.pts[0], b = tn.to.pts[1] || a, want = Math.atan2(b[0] - a[0], b[1] - a[1]), err = wrap(want - car.heading);
      const hold = { up: 0, down: 0, steer: 0, handbrake: true, horn: inp.horn }, sn = Math.sin(car.heading), cs = Math.cos(car.heading);
      if (Math.abs(err) < 0.3 && Math.abs(car.vf) < 0.6) {
        // facing the way out: on to the lane that leads back
        st.turn = null;
        st.path = tn.to;
        st.s = project(tn.to, car.x, car.z).s;
        st.wide = 6;
        replan(car);
        return hold;
      }
      if (tn.wait > 0) { tn.wait -= dt; return hold; }
      // still rolling from the last stroke (if it will not come to rest - a slope - the turn is given up)
      if (Math.abs(car.vf) > 0.15 && tn.t === 0) { if ((tn.rolling = (tn.rolling || 0) + dt) > 4) { st.turn = null; disengage('돌릴 자리가 없어 자율주행을 끕니다 · 직접 운전해 주세요'); } return hold; }
      tn.rolling = 0;
      const forward = tn.phase % 2 === 0, reach = car.spec.L / 2 + 0.9;
      let solid = false;
      world.query(car.x + sn * reach * (forward ? 1 : -1), car.z + cs * reach * (forward ? 1 : -1), car.spec.W / 2 + 0.1, (nx, nz, pen) => { if (pen > 0.05) solid = true; }, car.y);
      tn.t += dt;
      tn.moved = (tn.moved || 0) + Math.abs(car.vf) * dt;
      // (a stroke is a couple of metres at most: beyond the end of the road there may be nothing to stop it)
      if (solid || tn.t > 3.2 || tn.moved > 2.6) {
        tn.moved = 0;
        tn.phase++;
        tn.t = 0;
        tn.wait = 0.5;
        if (++tn.n > 14) { st.turn = null; disengage('돌릴 자리가 없어 자율주행을 끕니다 · 직접 운전해 주세요'); }
        return hold;
      }
      const push = Math.abs(car.vf) < 1.2 ? 0.4 : 0, lock = Math.sign(err || 1);
      return forward ? { up: push, down: 0, steer: lock, handbrake: false, horn: inp.horn } : { up: 0, down: push, steer: -lock, handbrake: false, horn: inp.horn };
    }
    // backing off a little (see below): reverse for a moment, then stand, then carry on
    if (st.back > 0) {
      st.back -= dt;
      // (gently, no faster than a walk, and not into anything standing behind)
      const bs = Math.sin(car.heading), bc = Math.cos(car.heading), reach = car.spec.L / 2 + 1.2;
      let solid = false;
      world.query(car.x - bs * reach, car.z - bc * reach, car.spec.W / 2, (nx, nz, pen) => { if (pen > 0.05) solid = true; }, car.y);
      // (having backed off, it stands a few seconds: those it was in the way of get past)
      if (solid) st.back = Math.min(st.back, 5);
      return st.back > 5 ? { up: 0, down: car.vf > -1.1 ? 0.3 : 0, steer: 0, handbrake: false, horn: inp.horn } : { up: 0, down: 0, steer: 0, handbrake: true, horn: inp.horn };
    }
    const speed = Math.hypot(car.vx, car.vz), v = Math.max(0, car.vf), spec = car.spec, front = spec.L / 2 + 0.6;

    // --- where the car is on its path
    let at = project(st.path, car.x, car.z, st.s - 6, st.s + 12 + v);
    st.off = at.d;
    st.wide = Math.max(0, st.wide - dt);                       // turning round, the car swings wider than the line drawn for it
    if (at.d > (st.wide > 0 ? 18 : 9)) {                                            // well off it (a skid, a shove): find the lane again
      const lane = laneAt(car.x, car.z, car.heading, world.levelAt(car.x, car.z, car.y), 9);
      if (!lane) { disengage('자율주행 꺼짐 · 차로를 벗어났습니다'); return inp; }
      release();
      st.path = lane;
      at = project(lane, car.x, car.z);
      replan(car);
    }
    st.s = at.s;
    for (let n = 0; n < 8 && st.s >= st.path.len - 0.3; n++) {       // on to the next path
      if (st.path.turn) {
        if (st.hold === st.path) release();
        const to = st.path.to;
        while (st.plan.length && st.plan[0].lane !== to) st.plan.shift();
        if (st.plan.length) st.plan.shift();
        st.path = to;
        st.halted = false;
      } else {
        const move = nextMove(st.path);
        if (!move) break;
        st.path = move;
        if (move.turn === 'U') st.wide = 12;
      }
      st.s = project(st.path, car.x, car.z, 0, 15).s;
    }
    // a new place chosen (or reached): the way is worked out afresh, and now and then anyway
    st.planned += dt;
    if (guide.goal !== st.goal) {
      if (guide.goal) st.arriving = false;                     // somewhere new to go: no pulling up after all
      replan(car);
    } else if (st.planned > 20 && !st.path.turn) replan(car);
    // the place is passed on the last lane without coming close enough for the guide to call it reached
    // (it lies off the road, or on the other carriageway): that is arriving all the same
    if (st.goal && !st.arriving && st.path === st.last && st.s >= st.lastS - 6) {
      const reached = st.goal;
      guide.set(null);
      st.goal = null;
      st.plan = [];
      st.arriving = true;
      st.from = [car.x, car.z];
      arrived(reached);
    }

    // --- a lane change the plan asks for, when the lane beside is clear
    let changing = 0;
    if (!st.path.turn && st.plan.length && st.plan[0].via === 'change' && st.path.len - st.s > 30) {
      const target = st.plan[0].lane, here = project(target, car.x, car.z), side = target.index > st.path.index ? -1 : 1;     // lanes count from the centre line outward: a higher number is further right
      changing = side;
      const clear = !traffic.cars.some(c => c.path === target && c.s > here.s - 14 - c.v * 1.2 && c.s < here.s + 12 + v * 0.8);
      if (clear) { st.path = target; st.s = here.s; st.plan.shift(); }
    }

    // --- what lies ahead
    const reach = Math.max(45, v * v / (2 * COMFORT) + 30), ev = lookAhead(car, reach), view = st.view;
    let limit = (st.path.turn ? Math.min(st.path.speed, st.path.to.limit) : st.path.limit) * Math.min(1, 0.55 + 0.45 * grip);
    let stopIn = Infinity, why = '';
    const stopAt = (d, reason) => { if (d < stopIn) { stopIn = d; why = reason; } };
    // bends: no faster than the grip allows, braking for them in good time
    // (through a tight corner a car is driven more gently than round a wide bend)
    const lateral = radius => (1.2 + Math.min(1.1, radius / 30)) * grip;
    for (let i = 4; i < ahead.length; i += 2) {
      const a = ahead[i - 4], b = ahead[i - 2], c = ahead[i];
      const turn = Math.abs(wrap(Math.atan2(c[0] - b[0], c[1] - b[1]) - Math.atan2(b[0] - a[0], b[1] - a[1]))), run = (c[2] - a[2]) / 2 || 1;
      if (turn < 0.02 || run < 1) continue;                  // (points almost on top of each other say nothing of the bend)
      const radius = run / turn, through = Math.max(1.8, Math.sqrt(lateral(radius) * radius)), d = Math.max(0, b[2] - front);
      limit = Math.min(limit, Math.sqrt(through * through + 2 * COMFORT * 0.8 * d));
    }
    // the junction ahead
    view.lamp = null;
    const move = st.path.turn ? null : ev.move;
    // Leave to cross that was taken is given back: when the way now leads through another turning, when
    // the lights go red while the car can still stop, and when the car has stood short of the line for a while.
    if (st.hold && !st.path.turn) {
      const toLine = ev.moveAt - front, red = st.hold.junction.control === 'signal' && lampOf(st.hold) === 'R' && v * v / (2 * FIRM) < toLine - 0.5;
      st.heldStill = v < 0.3 && toLine > 1 ? st.heldStill + dt : 0;
      // (given back for standing, it is not taken again at once: those waiting to cross get their turn)
      if (st.heldStill > 3) { st.noHold = st.hold; st.noHoldFor = 4; }
      if (st.hold !== ev.move || red || st.heldStill > 3) release();
    }
    st.noHoldFor = Math.max(0, st.noHoldFor - dt);
    {
    }
    if (move && move !== st.hold) {
      const toLine = ev.moveAt - front, j = move.junction, signalled = j.control === 'signal';
      let go = true, reason = '';
      if (signalled) {
        const lamp = lampOf(move);
        view.lamp = { colour: lamp, d: Math.max(0, toLine) };
        if (lamp === 'R' || (lamp === 'Y' && v * v / (2 * FIRM) < toLine)) { go = false; reason = '신호 대기'; }
      } else if (move.arm.give === 'stop' && !st.halted) {
        go = false;
        reason = '일시 정지';
        if (toLine < 3.2 && v < 0.3) st.halted = true;
      }
      if (go && (move.arm.walkers > 0 || move.to.from?.walkers > 0)) { go = false; reason = '보행자 대기'; }
      // Giving way, by the rules the traffic keeps: to whatever is on a path that crosses this one; and to
      // one that has leave to cross and is on its way, only where it comes first - at lights, when this is
      // a turn across the oncoming stream and that stream has green; elsewhere, when its road ranks no lower.
      const before = o => (signalled ? move.yields && !o.yields && lampOf(o) === 'G' : o.priority >= move.priority);
      if (go && move.conflicts.some(o => o.cars.length > 0 || o.held > 0 && before(o))) { go = false; reason = '양보'; }
      // room on the far side
      if (go && move.to.cars.some(c => c.s < spec.L + 3 && c.v < 1)) { go = false; reason = '앞이 막힘'; }
      if (go && toLine < v * v / (2 * COMFORT) + 10 && !(st.noHoldFor > 0 && st.noHold === move)) { release(); move.held++; st.hold = move; } else if (!go) stopAt(Math.max(0, toLine), reason);
      // a long wait at a junction without lights: creep out, as a driver would
      st.waited = !go && v < 0.3 && !signalled ? st.waited + dt : 0;
      // (and sooner when those it gives way to are all standing still: in a narrow mouth they are waiting for
      // this car to be out of their way, and somebody has to move)
      // (not when one that has leave to cross is still on its way there)
      const standing = move.conflicts.every(o => o.held <= o.cars.length && o.cars.every(c => c.v < 0.1));
      if (reason === '양보' && (st.waited > 12 && !move.conflicts.some(o => o.cars.length > 0) || st.waited > 6 && standing)) { release(); move.held++; st.hold = move; st.waited = 0; stopIn = Infinity; }
      if (toLine < 45 && (move.turn === 'L' || move.turn === 'R')) changing = move.turn === 'L' ? 1 : -1;
    }
    if (ev.end < Infinity) {
      stopAt(Math.max(0, ev.end - front - 1), '길 끝');
      // at the end of the road (the edge of the map), stopped: nothing more for it to do
      if (ev.end - front < 3 && v < 0.2) {
        // a dead end: the car turns round where it stands, to and fro, and goes back the way it came
        const back = !st.path.turn && (st.path.link.lanes.find(l => l.dir !== st.path.dir) || st.path.out.find(m => m.turn === 'U')?.to);
        if (back) { release(); st.turn = { to: back, phase: 0, t: 0, wait: 0, n: 0 }; say('막다른 길 · 돌려 나갑니다'); return { up: 0, down: 0, steer: 0, handbrake: true, horn: inp.horn }; }
        disengage('길이 끝나 자율주행을 끕니다 · 직접 돌려 나가 주세요');
        return { up: 0, down: 0, steer: 0, handbrake: true, horn: inp.horn };
      }
    }
    // fixed things standing in the way
    st.scan -= dt;
    if (st.scan <= 0) { st.scan = 0.12; sense(car, v); } else if (st.blockIn < Infinity) st.blockIn = Math.max(0, st.blockIn - v * dt);
    st.nudge += Math.max(-1.2 * dt, Math.min(1.2 * dt, st.shift - st.nudge));
    if (st.shift) limit = Math.min(limit, st.tight ? 2.5 : 5);                 // past something close: gently
    if (st.blockIn < Infinity) {
      // it stands in a lane or turning the car has not started on yet: another way is looked for at once
      // (and if there is none, this one is kept and the car goes up to the thing)
      if (st.blockOn !== st.path && !blocked.has(st.blockOn) && !tried.has(st.blockOn)) {
        tried.add(st.blockOn);
        blocked.add(st.blockOn);
        const lane = st.path.turn ? st.path.to : st.path;
        if (st.goal ? route(lane, st.goal.x, st.goal.z) : nextMove(lane)) replan(car); else blocked.delete(st.blockOn);
      }
      stopAt(Math.max(0, st.blockIn - front - 1.5), '장애물');
      // stopped by it: that lane or turning is given up, and another way looked for
      st.stuck = v < 0.3 && why === '장애물' ? st.stuck + dt : 0;
      if (st.stuck > 2.5) {
        st.stuck = 0;
        blocked.add(st.blockOn);
        release();
        const lane = st.path.turn ? st.path.to : st.path;
        const way = st.goal ? route(lane, st.goal.x, st.goal.z) : null;
        if (st.goal ? !way : !(st.path.turn ? false : nextMove(st.path) || beside(st.path).some(o => !blocked.has(o)))) {
          // no other way: it is not given up at once - the car backs off and comes at it again (it may have
          // been standing askew, or over to one side for someone); the third time it hands back
          blocked.delete(st.blockOn);
          if (++st.fails >= 3) { disengage('길이 막혀 자율주행을 끕니다 · 직접 운전해 주세요'); return inp; }
          st.back = 7.2;
          st.shift = st.nudge = 0;
          return { up: 0, down: 0, steer: 0, handbrake: true, horn: inp.horn };
        }
        replan(car);
        if (!st.goal && !st.path.turn) { const other = beside(st.path).find(o => !blocked.has(o)); if (other && blocked.has(st.path)) st.plan = [{ lane: other, via: 'change' }]; }
      }
    } else { st.stuck = 0; if (v > 4) st.fails = 0; }
    if (v > 4) st.backs = 0;
    if (st.arriving) stopAt(Math.max(0, 18 - Math.hypot(car.x - st.from[0], car.z - st.from[1])), '도착');

    // cars and people on the way
    let gap = Infinity, leadV = 0, lead = null, squeeze = false, meet = Infinity;
    const onNarrow = !st.path.turn && st.path.road.ln === 1 && !st.path.road.ow;
    const hs = Math.sin(car.heading), hc = Math.cos(car.heading);
    view.cars.length = 0;
    view.people.length = 0;
    let onFoot = false, dodge = 0;
    const along = (x, z, half) => {                       // distance along the way ahead to something at (x, z), if it is in the way
      let best = Infinity;
      for (const p of ahead) { const d = Math.hypot(p[0] - x, p[1] - z); if (d < half && p[2] < best) best = p[2]; }
      return best;
    };
    for (const c of traffic.cars) {
      const dx = c.x - car.x, dz = c.z - car.z;
      if (Math.abs(dx) > 70 || Math.abs(dz) > 70 || Math.abs((c.y ?? car.y) - car.y) > 3) continue;
      view.cars.push(c);
      // how it lies to the car: across the way it takes up its length, along it its width
      const across = Math.abs(c.ux * hc - c.uz * hs), reachF = c.len / 2 * (1 - across) + c.kind.wid / 2 * across, reachL = c.kind.wid / 2 * (1 - across) + c.len / 2 * across;
      // (one coming the other way in the lane alongside is not in the way, however narrow the street)
      const oncoming = c.ux * hs + c.uz * hc < -0.5;
      // one coming close by on a narrow street: keep to the right and go by slowly
      if (oncoming && dx * hs + dz * hc > -4 && dx * hs + dz * hc < 45 && Math.abs(dx * hc - dz * hs) < 3.6) squeeze = true;
      // (round a bend it is not straight ahead: it is looked for along the way the car will take, too)
      if (onNarrow && (oncoming || c.ux * hs + c.uz * hc < 0.2)) { const near = along(c.x, c.z, 3.4); if (near < 50) { squeeze = true; meet = Math.min(meet, near); } }
      let d = along(c.x, c.z, spec.W / 2 + reachL + (oncoming ? -0.35 : 0.25));
      // and whatever is right in front of the bonnet counts, on the line or not
      const fwd = dx * hs + dz * hc, left = dx * hc - dz * hs;
      // (one coming the other way is only stopped for when it is nearly touching: the car has to keep
      // rolling to pull over to its own side, and both standing still would wait for each other for ever)
      if (fwd > 0 && fwd < (oncoming ? 3.2 + reachF : 9 + v) && Math.abs(left) < spec.W / 2 + reachL + (oncoming ? -0.35 : 0.2)) d = Math.min(d, fwd);
      if (d === Infinity) continue;
      const g = d - front - reachF;
      if (g < gap) { gap = g; lead = c; leadV = Math.max(0, c.v * (c.ux * hs + c.uz * hc)); }
    }
    for (const p of people.people) {
      if (Math.abs(p.x - car.x) > 45 || Math.abs(p.z - car.z) > 45) continue;
      view.people.push(p);
      // someone standing counts when in the car's way; someone walking, also where they will be in a moment
      // (those waiting at the kerb beside the lane are left alone)
      if (p.moving) {
        const d = Math.min(along(p.x, p.z, spec.W / 2 + 0.45), along(p.x + p.ux * 1.6, p.z + p.uz * 1.6, spec.W / 2 + 0.6));
        if (d < Infinity) { stopAt(Math.max(0, d - front - 2.5), '보행자'); onFoot = true; }
        continue;
      }
      // Someone standing (waiting to cross, waiting for a bus) close beside the way or in it: the car goes
      // round, slowly, far enough out that its own stop for people (main.js) does not hold it there. Only
      // someone standing in the very middle of its way stops it, and after a while it goes round them too.
      const pdx = p.x - car.x, pdz = p.z - car.z, fwd = pdx * hs + pdz * hc, left = pdx * hc - pdz * hs;
      if (fwd < -1 || fwd > 16 || Math.abs(left) > 1.75) continue;
      const need = 1.8 - Math.abs(left);
      if (need > 1.05 && st.forPeople < 6) { stopAt(Math.max(0, fwd - front - 2.5), '보행자'); onFoot = true; continue; }
      const to = -Math.sign(left || 1) * Math.min(1.05, need);
      if (Math.abs(to) > Math.abs(dodge)) dodge = to;
    }
    st.forPeople = onFoot && v < 0.6 ? st.forPeople + dt : onFoot ? st.forPeople : 0;
    view.lead = lead;
    // A street with one lane for both ways has its lanes drawn out by the kerbs, just far enough apart for
    // two cars to squeeze by. With nothing coming a driver keeps to the middle of such a street, and so does
    // the car: it moves over to its own side only while something comes the other way.
    const narrow = p => (p && !p.turn && p.road.ln === 1 && !p.road.ow ? Math.abs(p.o) : 0);
    const middle = st.path.turn ? Math.min(narrow(st.path.from), narrow(st.path.to)) : narrow(st.path);
    const keep = dodge ? Math.max(-1.1, Math.min(Math.max(middle + 0.5, 1.05), st.aside + dodge)) : squeeze ? (middle ? 0 : -0.25) : middle;
    st.keep = keep;
    st.aside += Math.max(-1.1 * dt, Math.min(1.1 * dt, keep - st.aside));
    // (slowly; and at a crawl if it is nearly here and the car is not yet over on its own side)
    if (middle && squeeze) limit = Math.min(limit, meet < 16 && st.aside > 0.35 ? 1.2 : 4);
    if (dodge) limit = Math.min(limit, 3);
    if (squeeze) limit = Math.min(limit, 6);

    // --- the speed to keep, and the pedals
    const v0 = Math.max(0.1, limit);
    let acc = 1.6 * (1 - (v / v0) ** 4);
    if (gap < Infinity) {
      const want = 2.5 + v * 1.4 + v * (v - leadV) / (2 * Math.sqrt(1.6 * COMFORT));
      acc -= 1.6 * (Math.max(0, want) / Math.max(gap, 0.3)) ** 2;
    }
    if (stopIn < Infinity) {
      // brake so as to stop at the mark; close to it and slow, hold still
      const need = stopIn > 0.4 ? v * v / (2 * stopIn) : FIRM;
      if (need > COMFORT * 0.5 || stopIn < 6) acc = Math.min(acc, stopIn < 0.6 ? -FIRM : -need * 1.1 + (stopIn > 3 && v < 1.5 ? 0.9 : 0));
    }
    // something solid right in front of the bonnet, off the line or not (the car has run wide): crawl
    {
      let close = false;
      for (const reach of [front + 0.8, front + 2.5, front + 2.5 + v * 0.7]) world.query(car.x + hs * reach, car.z + hc * reach, spec.W / 2, (nx, nz, pen) => { if (pen > 0.1) close = true; }, car.y);
      if (close && v > 1.2) acc = Math.min(acc, -3);
    }
    if (st.hook > 1.3 && v > 1.7) acc = Math.min(acc, -1.5);          // (and takes it at a walk)
    // Pointing well away from the way it should be going, or still wide of the line after a tight corner:
    // no speeding up until it is straight again (the next stretch may be a fast one, and the car is not on it yet).
    st.hookFor = Math.max(0, st.hookFor - dt);
    if ((st.askew > 0.45 || st.hookFor > 0 && st.off - Math.abs(st.aside) > 1.3) && v > 2.2) acc = Math.min(acc, -1);
    acc = Math.max(-7, Math.min(1.8, acc));
    const still = v < 0.25 && (stopIn < 2.5 || gap < 3);
    const out = { up: 0, down: 0, steer: 0, handbrake: false, horn: inp.horn };
    if (still) out.handbrake = true;                           // (a fresh press of the brake at rest would select reverse)
    else if (acc >= 0) out.up = Math.min(1, acc / 1.8 * 0.85 + (v < 1 ? 0.12 : 0));
    else if (v > 0.6) out.down = Math.min(1, -acc / 6.5);          // (slower than this the handbrake does it: a press of the brake near rest selects reverse)
    else out.handbrake = true;

    // --- the wheel. The front wheels are steered to run along the line: turned by as much as the line's
    // direction a little way ahead differs from the car's, and further towards the line by how far the
    // front axle is off to its side. (Aiming at a point ahead instead would cut every corner.)
    const lock = Math.min(0.6, 0.65 * Math.atan(spec.wheelbase * G / Math.max(speed * speed, 1)));
    if (ahead.length > 1) {
      const fx = car.x + hs * spec.wheelbase / 2, fz = car.z + hc * spec.wheelbase / 2;
      let side = 0, best = Infinity;
      for (let i = 1; i < Math.min(ahead.length, 10); i++) {
        const p = ahead[i - 1], q = ahead[i], dx = q[0] - p[0], dz = q[1] - p[1], l2 = dx * dx + dz * dz;
        if (l2 < 1e-6) continue;
        const t = Math.min(1, Math.max(0, ((fx - p[0]) * dx + (fz - p[1]) * dz) / l2)), ox = fx - p[0] - dx * t, oz = fz - p[1] - dz * t, d = ox * ox + oz * oz;
        if (d < best) { best = d; side = (ox * dz - oz * dx) / Math.sqrt(l2) - st.nudge - st.aside; }      // how far the axle is to the left of the line (the line shifted round what stands in it)
      }
      // Round a tight corner the back wheels run well inside the front ones: the front is taken wide by
      // about half of that, as a driver swings out, so that the car's middle follows the line.
      let bend = 0;
      for (let i = 2; i < Math.min(ahead.length, 5); i++) {
        const a = ahead[i - 2], b = ahead[i - 1], c = ahead[i], run = (c[2] - a[2]) / 2;
        if (run > 0.3) bend += wrap(Math.atan2(c[0] - b[0], c[1] - b[1]) - Math.atan2(b[0] - a[0], b[1] - a[1])) / run / 3;       // curvature, to the left positive
      }
      if (Math.abs(bend) > 0.07) side += Math.max(-0.7, Math.min(0.7, bend * spec.wheelbase * spec.wheelbase * 0.3));       // (tighter than about 14 m)
      // A corner too tight to be driven as drawn (the line doubles back within a few metres): the car turns
      // in early and cuts it, as a driver would, instead of running wide of it.
      let hook = 0, before = 0;
      for (let i = 2; i < ahead.length && ahead[i][2] < 9; i++) {
        const a = ahead[i - 2], b = ahead[i - 1], c = ahead[i];
        const turn = Math.abs(wrap(Math.atan2(c[0] - b[0], c[1] - b[1]) - Math.atan2(b[0] - a[0], b[1] - a[1])));
        hook = Math.max(hook, turn + before);          // the turning at two points running: some five metres of the way
        before = turn;
      }
      st.hook = hook;
      if (hook > 1.3) st.hookFor = 5;                             // (for a few seconds after, the car may still be wide of the line)
      const preview = spec.wheelbase / 2 + Math.max(0, (v - 4) * 0.3) + (hook > 1.3 ? 2.4 : 0);
      let k = 1;
      while (k < ahead.length - 1 && ahead[k][2] < preview) k++;
      const towards = Math.atan2(ahead[k][0] - ahead[k - 1][0], ahead[k][1] - ahead[k - 1][1]);
      st.askew = Math.abs(wrap(towards - car.heading));
      const most = Math.max(0.12, Math.min(0.6, 2.5 / (v + 1)));
      const pull = Math.max(-most, Math.min(most, Math.atan(1.6 * side / (v + 2))));
      out.steer = Math.max(-1, Math.min(1, (wrap(towards - car.heading) - pull) / lock));
    }

    // The car means to go and does not move: it is held (its own stop for people holds it while someone
    // stands at its bumper, and they in turn wait for it to be out of their way), or it is against a kerb.
    // After a few seconds it backs off a couple of metres, if nothing is close behind, and tries again.
    // (the same when it stands nose to nose with a car coming the other way in a narrow street: each waits for the
    // other; backing off lets the car come on again from its own side of the street)
    const facing = lead && gap < 4 && stopIn > 6 && lead.ux * hs + lead.uz * hc < -0.5;      // (not while it waits at a light or for people crossing)
    st.idle = (out.up > 0 || facing) && Math.abs(car.vf) < 0.2 ? st.idle + dt : 0;
    if (st.idle > 6) {
      st.idle = 0;
      const behind = traffic.cars.some(c => { const dx = c.x - car.x, dz = c.z - car.z, f = dx * hs + dz * hc; return f < 0 && f > -spec.L / 2 - c.len / 2 - 4 && Math.abs(dx * hc - dz * hs) < 2; });
      // (a few times; if it still cannot get on, it says so and hands back)
      if (++st.backs > 6) { disengage('움직일 수 없어 자율주행을 끕니다 · 직접 운전해 주세요'); return { up: 0, down: 0, steer: 0, handbrake: true, horn: inp.horn }; }
      if (!behind) { release(); st.back = 7.2; st.stuck = 0; st.shift = st.nudge = 0; }
    }
    // indicators: before a turn and while changing lane
    if (changing && car.signal !== 'hazard') { const want = changing > 0 ? 'left' : 'right'; if (car.signal !== want) { car.setSignal(want); st.signalled = true; } }

    // arrived and stopped: hand back
    if (st.arriving && v < 0.3) { disengage('도착 · 자율주행을 마칩니다'); return { up: 0, down: 0, steer: 0, handbrake: true }; }

    view.set = limit;
    view.stopIn = stopIn;
    view.reason = why;
    view.status = why || (lead && gap < 40 ? '앞차 따라가는 중' : st.goal ? `${st.goal.name}으로` : '차로 유지');
    view.ahead = ahead;
    return out;
  }

  // ---------- the display: what the car sees, drawn on a small canvas ----------
  function draw(canvas, car) {
    const g = canvas.getContext('2d'), w = canvas.width, h = canvas.height, k = 4.2, view = st.view;
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(16, 20, 26, 0.86)';
    g.fillRect(0, 0, w, h);
    // car frame: forward up the picture, the car near the bottom. Left of the heading is +x in the car's frame.
    const sin = Math.sin(car.heading), cos = Math.cos(car.heading), ox = w / 2, oz = h - 26;
    const to = (x, z) => { const dx = x - car.x, dz = z - car.z, fwd = dx * sin + dz * cos, left = dx * cos - dz * sin; return [ox - left * k, oz - fwd * k]; };
    // the lanes round about, on the car's own level
    g.lineJoin = g.lineCap = 'round';
    g.strokeStyle = '#2b323b';
    g.lineWidth = 2.9 * k;
    const level = st.path ? (st.path.turn ? st.path.to.level : st.path.level) | 0 : 0;
    lanesNear(car.x, car.z, 55, lane => {
      if ((lane.level | 0) !== level) return;
      g.beginPath();
      lane.pts.forEach((p, i) => { const [x, y] = to(p[0], p[1]); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      g.stroke();
    });
    // the lane ahead, as a band, and the line the car means to follow
    if (view.ahead.length > 1) {
      g.strokeStyle = 'rgba(58, 160, 255, 0.28)';
      g.lineWidth = 3.4 * k;
      g.beginPath();
      view.ahead.forEach((p, i) => { const [x, y] = to(p[0], p[1]); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      g.stroke();
      g.strokeStyle = '#3aa0ff';
      g.lineWidth = 2;
      g.stroke();
    }
    const box = (x, z, ux, uz, len, wid, colour) => {
      const [cx, cy] = to(x, z), fwd = ux * sin + uz * cos, left = ux * cos - uz * sin, a = Math.atan2(-left, fwd);
      g.save();
      g.translate(cx, cy);
      g.rotate(a);
      g.fillStyle = colour;
      g.fillRect(-wid * k / 2, -len * k / 2, wid * k, len * k);
      g.restore();
    };
    for (const c of view.cars) box(c.x, c.z, c.ux, c.uz, c.len, c.kind.wid, c === view.lead ? '#ffb547' : '#aeb6bf');
    g.fillStyle = '#ff6b5a';
    for (const p of view.people) { const [x, y] = to(p.x, p.z); g.beginPath(); g.arc(x, y, 2.6, 0, 6.3); g.fill(); }
    box(car.x, car.z, sin, cos, car.spec.L, car.spec.W, '#ffffff');
    // the light ahead, or where it will stop
    if (view.lamp) {
      g.fillStyle = { R: '#ff4d3d', Y: '#ffc533', G: '#39d353' }[view.lamp.colour] || '#39d353';
      g.beginPath();
      g.arc(w - 18, 18, 8, 0, 6.3);
      g.fill();
    }
    g.fillStyle = '#e8eaed';
    g.font = '600 12px system-ui, "Malgun Gothic", sans-serif';
    g.textBaseline = 'middle';
    g.fillText(view.status, 8, h - 10);
    g.textAlign = 'right';
    g.fillText(`${Math.round(view.set * 3.6)} km/h`, w - 8, h - 10);
    g.textAlign = 'left';
  }

  return {
    get on() { return st.on; },
    get state() { return st; },
    toggle(car) { if (st.on) disengage('자율주행 꺼짐'); else engage(car); return st.on; },
    off: () => disengage(),
    // the guide says the place has been reached: pull up within a few car lengths and hand back
    reached(car) { if (st.on) { st.arriving = true; st.from = [car.x, car.z]; } },
    drive, draw, laneAt, route,
  };
}
