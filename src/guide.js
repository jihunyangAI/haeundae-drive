// Places to drive to or set off from, and the way there along the streets.
// The places are given by latitude and longitude and tied to the nearest street of the map.

const PLACES = [
  ['beach', '해운대해수욕장', 35.1594, 129.1603],
  ['dongbaek', '동백섬', 35.1545, 129.1525],
  ['marine', '마린시티', 35.1557, 129.1424],
  ['station', '해운대역', 35.1636, 129.1588],
  ['mipo', '미포', 35.1583, 129.1702],
  ['dalmaji', '달맞이길 전망대', 35.1568, 129.1788],
  ['cheongsapo', '청사포', 35.1612, 129.1905],
];

export function createGuide(map) {
  // the streets as a graph of their corners; one-way streets only lead one way
  const nodes = new Map(), list = [];
  const node = (x, z) => {
    const key = `${x},${z}`;
    if (!nodes.has(key)) { nodes.set(key, { x, z, out: [], id: list.length }); list.push(nodes.get(key)); }
    return nodes.get(key);
  };
  for (const road of map.roads) {
    if (road.c !== 'drive' || (road.br && !road.dk) || road.k === 'service' || road.k === 'busway') continue;
    // a little is added for side streets, so the way keeps to the main roads where it costs nothing much
    const slow = /^(residential|living_street|unclassified)$/.test(road.k) ? 1.5 : 1;
    for (let i = 2; i < road.p.length; i += 2) {
      const a = node(road.p[i - 2], road.p[i - 1]), b = node(road.p[i], road.p[i + 1]), cost = Math.hypot(a.x - b.x, a.z - b.z) * slow;
      a.out.push(b, cost, road);
      if (!road.ow) b.out.push(a, cost, road);
    }
  }
  const nearest = (x, z, reach = Infinity) => {
    let best = null, d = reach;
    for (const n of list) { const far = Math.hypot(n.x - x, n.z - z); if (far < d && n.out.length) { d = far; best = n; } }
    return best;
  };

  // latitude and longitude to the map's metres: its origin and the size of a degree there (as in tools/region.mjs)
  const LAT = 35.158, LON = 129.144, rad = LAT * Math.PI / 180;
  const mPerLat = 111132.92 - 559.82 * Math.cos(2 * rad) + 1.175 * Math.cos(4 * rad), mPerLon = 111412.84 * Math.cos(rad) - 93.5 * Math.cos(3 * rad) + 0.118 * Math.cos(5 * rad);
  const toLocal = (lat, lon) => [(lon - LON) * mPerLon, (LAT - lat) * mPerLat];
  const places = [];
  for (const [id, name, lat, lon] of PLACES) {
    const [x, z] = toLocal(lat, lon), at = nearest(x, z, 320);
    if (!at) continue;                                  // not on this map
    // where a car is put down there: on the street, facing along it, in the right-hand lane
    const next = at.out[0], road = at.out[2], len = Math.hypot(next.x - at.x, next.z - at.z) || 1, ux = (next.x - at.x) / len, uz = (next.z - at.z) / len;
    const off = road.ow ? 0 : road.w / 4, along = Math.min(6, len / 2);
    places.push({ id, name, x: at.x, z: at.z, node: at, start: { x: at.x + ux * along - uz * off, z: at.z + uz * along + ux * off, heading: Math.atan2(ux, uz) } });
  }

  // The shortest way from one node to another: [[x, z], ...], or null if there is none.
  function path(from, to) {
    const dist = new Float64Array(list.length).fill(Infinity), prev = new Int32Array(list.length).fill(-1), heap = [[0, from.id]];
    dist[from.id] = 0;
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
    while (heap.length) {
      const [d, id] = pop();
      if (d > dist[id]) continue;
      if (id === to.id) break;
      const n = list[id];
      for (let e = 0; e < n.out.length; e += 3) {
        const m = n.out[e], nd = d + n.out[e + 1];
        if (nd < dist[m.id]) { dist[m.id] = nd; prev[m.id] = id; push([nd, m.id]); }
      }
    }
    if (dist[to.id] === Infinity) return null;
    const out = [];
    for (let id = to.id; id >= 0; id = prev[id]) out.unshift([list[id].x, list[id].z]);
    return out;
  }

  let goal = null, route = null, left = 0, since = 0;
  const api = {
    places,
    get goal() { return goal; },
    get route() { return route; },          // [[x, z], ...] from about where the car is to the goal
    get left() { return left; },            // metres still to go along the route
    // id of a place, or null for none
    set(id) {
      goal = places.find(p => p.id === id) || null;
      route = null;
      since = Infinity;
    },
    // Call every frame. Returns the place just reached, once, when the car gets there.
    update(dt, car) {
      if (!goal) return null;
      since += dt;
      if (Math.hypot(goal.x - car.x, goal.z - car.z) < 45) {
        const reached = goal;
        api.set(null);
        return reached;
      }
      // where the car is along the route; if it has strayed, or now and then anyway, the way is found afresh
      let off = Infinity, at = 0;
      if (route) {
        for (let i = 1; i < route.length && i < 14; i++) {
          const [ax, az] = route[i - 1], [bx, bz] = route[i], dx = bx - ax, dz = bz - az;
          const t = Math.min(1, Math.max(0, ((car.x - ax) * dx + (car.z - az) * dz) / (dx * dx + dz * dz || 1)));
          const d = Math.hypot(car.x - ax - dx * t, car.z - az - dz * t);
          if (d < off) { off = d; at = i - 1 + t; }
        }
      }
      if ((!route && since > 1.5) || (route && off > 40 && since > 1.5) || since > 20) {
        since = 0;
        // set off from the corner ahead of the car rather than the one behind it
        const hx = Math.sin(car.heading), hz = Math.cos(car.heading);
        const from = nearest(car.x + hx * 12, car.z + hz * 12, 150) || nearest(car.x, car.z);
        route = from ? path(from, goal.node) : null;
        if (route) route.unshift([car.x, car.z]);
        at = 0;
      }
      if (!route) { left = Math.hypot(goal.x - car.x, goal.z - car.z); return null; }
      // drop what is behind, and measure what is ahead
      const whole = Math.floor(at);
      if (whole > 0) route.splice(0, whole);
      route[0] = [car.x, car.z];
      left = 0;
      for (let i = 1; i < route.length; i++) left += Math.hypot(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1]);
      return null;
    },
  };
  return api;
}
