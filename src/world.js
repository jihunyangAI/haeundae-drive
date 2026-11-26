import * as THREE from 'three';
import { loadMap, pointInPolygon, boundsOf } from './map/data.js';
import { buildTerrain, buildFarTerrain, buildRoads, buildWalkways, buildWaterfront, tarmacMaterials, LAYER } from './map/meshes.js';
import { createStreetKit, buildStreets } from './map/street.js';
import { createFacadeKit, buildFacades } from './map/facades.js';
import { buildStructures, solidsOf } from './map/decks.js';
import { buildBackdrop } from './map/backdrop.js';
import { analyseStreets, limitOf, levelOf } from './map/network.js';
import { buildLaneGraph, signalState, lampLit } from './map/lanes.js';
import { LAMP_COLOURS } from './map/street.js';
import { createTrafficKit } from './trafficview.js';
import { buildWalks } from './map/walks.js';
import { buildStops } from './map/stops.js';
import { Atlas } from './map/atlas.js';
import { ENV } from './map/shared.js';

const CELL = 60;          // collision and road lookup grid, metres
const EDGE_MARGIN = 6;    // invisible wall this far inside the edge of the map data
const TALL = 30;          // buildings at least this high are drawn from far away
const NEAR = 620;         // a zone gets its full detail when the car is this close (metres to its nearest edge)
const LOW = 430;          // low buildings are shown only this close: further off, the ones in front hide them
const KEEP = 500;         // a zone is let go when it is this much further off than where it would be built
const FAR = 1900;         // and its ground, roads and tall buildings from this far

// Everything the game needs from the map: the scene content, ground height, collisions and road lookup.
// The map is cut into zones. Each zone's file is fetched and its scenery built as the car approaches:
// first the far level (ground, road surfaces, tall buildings), then the near level (everything else).
export async function createWorld(dir) {
  const map = await loadMap(dir);
  const ground = map.ground, { zone: SIZE, cols, rows } = map.meta;
  const group = new THREE.Group();
  const atlas = new Atlas(256, 64, 8, 64), tallAtlas = new Atlas(64, 256, 16, 2);
  const streetKit = createStreetKit(atlas), facadeKit = createFacadeKit(atlas, tallAtlas);
  const trafficKit = createTrafficKit();          // car bodies, for the traffic and for parked cars
  const sea = new THREE.Mesh(
    new THREE.PlaneGeometry(20000, 20000).rotateX(-Math.PI / 2).translate((map.x0 + map.x1) / 2, 0, (map.z0 + map.z1) / 2),
    new THREE.MeshStandardMaterial({ color: 0x2f6f96, roughness: 0.25, metalness: 0.1 }),
  );
  sea.receiveShadow = true;
  // Waves: the surface stays flat, but the way it catches the light moves - a few trains of ripples
  // crossing each other, worked out from where each point of the water is.
  const seaTime = { value: 0 };
  sea.material.onBeforeCompile = shader => {
    shader.uniforms.uSeaTime = seaTime;
    shader.vertexShader = `varying vec3 vSeaAt;\n${shader.vertexShader}`.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vSeaAt = (modelMatrix * vec4(position, 1.0)).xyz;');
    shader.fragmentShader = `uniform float uSeaTime;\nvarying vec3 vSeaAt;\n${shader.fragmentShader}`.replace(
      '#include <normal_fragment_begin>',
      `#include <normal_fragment_begin>
  {
    vec2 q = vSeaAt.xz, slope = vec2(0.0);
    float swell = 0.0;
    slope += vec2(0.92, 0.39) * cos(dot(q, vec2(0.92, 0.39)) * 0.21 + uSeaTime * 0.9) * 0.10;
    slope += vec2(-0.45, 0.89) * cos(dot(q, vec2(-0.45, 0.89)) * 0.37 + uSeaTime * 1.3) * 0.08;
    slope += vec2(0.31, -0.95) * cos(dot(q, vec2(0.31, -0.95)) * 0.83 + uSeaTime * 2.1) * 0.07;
    slope += vec2(0.71, 0.71) * cos(dot(q, vec2(0.71, 0.71)) * 1.9 + uSeaTime * 3.2) * 0.05;
    swell = sin(dot(q, vec2(0.92, 0.39)) * 0.21 + uSeaTime * 0.9) + sin(dot(q, vec2(-0.45, 0.89)) * 0.37 + uSeaTime * 1.3);
    // ripples flatten out with distance, where they would only flicker
    float calm = 1.0 / (1.0 + length(vViewPosition) * 0.004);
    normal = normalize((viewMatrix * vec4(normalize(vec3(-slope.x * calm, 1.0, -slope.y * calm)), 0.0)).xyz);
    diffuseColor.rgb *= 1.0 + 0.06 * swell * calm;
  }`,
    );
  };
  group.add(sea);
  const backdrop = buildBackdrop(), seasonal = [];        // seasonal: what is only out on a fine day (parasols)
  group.add(backdrop.group, buildFarTerrain(map, ground));
  let fine = true;

  const cellOf = v => Math.floor(v / CELL);
  const bucket = (grid, i, j) => {
    const key = `${i},${j}`;
    if (!grid.has(key)) grid.set(key, []);
    return grid.get(key);
  };

  // ---------- roads ----------
  // every road segment, in a grid, for "what road is here" and "is a road in the way"
  const segments = new Map();
  for (const road of map.roads) {
    const p = road.p;
    for (let k = 2; k < p.length; k += 2) {
      const seg = { road, ax: p[k - 2], az: p[k - 1], dx: p[k] - p[k - 2], dz: p[k + 1] - p[k - 1] };
      seg.len2 = seg.dx * seg.dx + seg.dz * seg.dz || 1;
      const pad = road.w / 2 + 4;
      for (let i = cellOf(Math.min(p[k - 2], p[k]) - pad); i <= cellOf(Math.max(p[k - 2], p[k]) + pad); i++) {
        for (let j = cellOf(Math.min(p[k - 1], p[k + 1]) - pad); j <= cellOf(Math.max(p[k - 1], p[k + 1]) + pad); j++) bucket(segments, i, j).push(seg);
      }
    }
  }
  const distanceTo = (s, x, z) => {
    const t = Math.min(1, Math.max(0, ((x - s.ax) * s.dx + (z - s.az) * s.dz) / s.len2));
    return Math.hypot(x - s.ax - s.dx * t, z - s.az - s.dz * t);
  };
  const drivable = r => r.c === 'drive' && (!r.br || r.dk);
  // Is a road within `margin` metres of its own edge at (x, z)? kind: 'drive' for carriageways only.
  function nearRoad(x, z, margin, kind, except) {
    for (const s of segments.get(`${cellOf(x)},${cellOf(z)}`) || []) {
      if (s.road === except || (kind === 'drive' && !drivable(s.road)) || (kind === 'ground' && (!drivable(s.road) || s.road.dk))) continue;
      if (distanceTo(s, x, z) < s.road.w / 2 + margin) return true;
    }
    return false;
  }
  // Nearest drivable road within `reach` metres, or null. y: the height of whoever asks, which tells
  // the bridge from the road under it.
  function roadAt(x, z, reach = 14, y) {
    let best = reach, found = null;
    const level = y === undefined ? null : map.levelAt(x, z, y - LAYER.major), covered = level === 0 && map.covered(x, z);
    for (let i = cellOf(x - reach); i <= cellOf(x + reach); i++) {
      for (let j = cellOf(z - reach); j <= cellOf(z + reach); j++) {
        for (const s of segments.get(`${i},${j}`) || []) {
          if (!drivable(s.road)) continue;
          if (level !== null && (level !== 0 || covered) && levelOf(s.road) !== level) continue;
          const d = distanceTo(s, x, z);
          if (d < best) { best = d; found = s.road; }
        }
      }
    }
    return found && { name: found.n, limit: limitOf(found), road: found };
  }
  // Start in the right-hand lane halfway along the longest stretch of the named street.
  function spawnOn(name) {
    const all = map.roads.filter(drivable);
    const r = all.filter(d => d.n === name).sort((a, b) => b.len - a.len)[0] || all[0];
    const i = Math.max(2, Math.floor(r.p.length / 4) * 2);
    const dx = r.p[i] - r.p[i - 2], dz = r.p[i + 1] - r.p[i - 1], len = Math.hypot(dx, dz);
    const off = r.ow ? 0 : r.w / 4;     // right of travel is (-dz, dx) / len
    return { x: r.p[i - 2] + dx / 2 - dz / len * off, z: r.p[i - 1] + dz / 2 + dx / len * off, heading: Math.atan2(dx, dz) };
  }

  // ---------- zones ----------
  const net = analyseStreets(map);
  const lanes = buildLaneGraph(map, net);       // lanes, junction movements and signal programmes
  const stops = buildStops(lanes, (x, z) => map.isLand(x, z) && !nearRoad(x, z, 0.4, 'drive'));
  // pavements, crossings and footpaths for people on foot (the street builder reads the crossings too)
  const walks = buildWalks(lanes, map, { blocked: (x, z, road) => nearRoad(x, z, 0.3, 'drive', road), isLand: map.isLand });
  const zones = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x0 = map.x0 + i * SIZE, z0 = map.z0 + j * SIZE, x1 = x0 + SIZE, z1 = z0 + SIZE;
      zones.push({
        i, j, x0, z0, x1, z1, seed: j * cols + i, roads: [], streets: [], data: null, fetching: null, level: 0,
        owns: (x, z) => x >= x0 && x < x1 && z >= z0 && z < z1,
      });
    }
  }
  // the roads and streets each zone has to look at: those passing through or just outside it
  const nearZones = ([ax, az, bx, bz], pad, visit) => {
    for (let j = Math.max(0, Math.floor((az - pad - map.z0) / SIZE)); j <= Math.min(rows - 1, Math.floor((bz + pad - map.z0) / SIZE)); j++) {
      for (let i = Math.max(0, Math.floor((ax - pad - map.x0) / SIZE)); i <= Math.min(cols - 1, Math.floor((bx + pad - map.x0) / SIZE)); i++) visit(zones[j * cols + i]);
    }
  };
  for (const road of map.roads) nearZones(boundsOf(road.p), road.w, z => z.roads.push(road));
  for (const zone of zones) zone.empty = !zone.roads.length && map.isBare(zone.i, zone.j);
  for (const st of net.streets) nearZones(boundsOf(st.road.p), 70, z => z.streets.push(st));

  // ---------- collisions ----------
  const cells = new Map(), posts = [], lamps = [], unmirrored = [];
  // ---------- signals ----------
  // The lamps of every signal head built so far, zone by zone. Their colours follow each junction's
  // programme; nothing changes faster than a few times a second, so that is how often they are redrawn.
  const signalHeads = [], lampOn = {}, lampOff = {};
  for (const [role, hex] of Object.entries(LAMP_COLOURS)) {
    lampOn[role] = new THREE.Color(hex).multiplyScalar(3.2);
    lampOff[role] = new THREE.Color(hex).multiplyScalar(0.035);
  }
  let signalStep = -1, signalTime = 0;
  function updateSignals(time) {
    seaTime.value = time % 3600;
    const step = Math.floor(time * 4);
    if (step === signalStep) return;
    signalStep = step;
    signalTime = time = step / 4;         // what the lamps show and what signalAt() answers stay in step
    const states = new Map();
    for (const zoneLamps of signalHeads) {
      for (const { mesh, i, arm, role, bar } of zoneLamps) {
        const j = arm.junction;
        if (!states.has(j)) states.set(j, signalState(j, time));
        const state = states.get(j), s = state.arms[arm.id];
        // the bars beside the walking figure count the time left down
        const on = role === 'count' ? s.walk !== 'stop' && bar < Math.ceil(6 * state.remain / state.step.dur) : lampLit(role, s, time);
        mesh.setColorAt(i, on ? lampOn[role] : lampOff[role]);
      }
      for (const mesh of new Set(zoneLamps.map(l => l.mesh))) mesh.instanceColor.needsUpdate = true;
    }
  }
  let stamp = 0;
  // lo, hi: solid only for what is between these heights (a parapet up on a bridge, a wall down in an underpass)
  function addSolid(p, lo = -Infinity, hi = Infinity) {
    const [x0, z0, x1, z1] = boundsOf(p), solid = { p, x0, x1, z0, z1, lo, hi, seen: 0 };
    for (let i = cellOf(x0); i <= cellOf(x1); i++) for (let j = cellOf(z0); j <= cellOf(z1); j++) bucket(cells, i, j).push(solid);
  }

  for (const s of solidsOf(map)) addSolid(s.p, s.lo, s.hi);

  // Calls hit(nx, nz, depth) for everything a circle overlaps; (nx, nz) points the way out.
  // py: the height of the thing asking; without it everything counts.
  function query(px, pz, r, hit, py) {
    stamp++;
    for (let i = cellOf(px - r); i <= cellOf(px + r); i++) {
      for (let j = cellOf(pz - r); j <= cellOf(pz + r); j++) {
        for (const s of cells.get(`${i},${j}`) || []) {
          if (s.seen === stamp) continue;
          s.seen = stamp;
          if (s.r) {
            const d = Math.hypot(px - s.x, pz - s.z);
            if (d < r + s.r && d > 1e-6) hit((px - s.x) / d, (pz - s.z) / d, r + s.r - d);
            continue;
          }
          if (px < s.x0 - r || px > s.x1 + r || pz < s.z0 - r || pz > s.z1 + r || py < s.lo || py > s.hi) continue;
          let best = Infinity, qx = 0, qz = 0;
          const p = s.p;
          for (let a = 0, b = p.length - 2; a < p.length; b = a, a += 2) {
            const dx = p[a] - p[b], dz = p[a + 1] - p[b + 1];
            const t = Math.min(1, Math.max(0, ((px - p[b]) * dx + (pz - p[b + 1]) * dz) / (dx * dx + dz * dz || 1)));
            const cx = p[b] + dx * t, cz = p[b + 1] + dz * t, d = Math.hypot(px - cx, pz - cz);
            if (d < best) { best = d; qx = cx; qz = cz; }
          }
          if (pointInPolygon(px, pz, p)) {
            if (best > 1e-6) hit((qx - px) / best, (qz - pz) / best, best + r);
          } else if (best < r && best > 1e-6) {
            hit((px - qx) / best, (pz - qz) / best, r - best);
          }
        }
      }
    }
    // the shore acts as a sea wall: push back up the slope
    const h = py === undefined ? map.top(px, pz) : map.surfaceAt(px, pz, py);
    if (h < 0.2) {
      const gx = ground(px + 1, pz) - ground(px - 1, pz), gz = ground(px, pz + 1) - ground(px, pz - 1), g = Math.hypot(gx, gz);
      if (g > 1e-3) hit(gx / g, gz / g, Math.min(1, (0.2 - h) / (g / 2)));
    }
    if (px > map.x1 - EDGE_MARGIN) hit(-1, 0, px - map.x1 + EDGE_MARGIN);
    if (px < map.x0 + EDGE_MARGIN) hit(1, 0, map.x0 + EDGE_MARGIN - px);
    if (pz > map.z1 - EDGE_MARGIN) hit(0, -1, pz - map.z1 + EDGE_MARGIN);
    if (pz < map.z0 + EDGE_MARGIN) hit(0, 1, map.z0 + EDGE_MARGIN - pz);
  }

  // ---------- building zones ----------
  const ctx = { map, ground, top: map.top, atlas, kit: streetKit, nearRoad, stops, walks };
  const api = { onZone: null, timings: { far: [], near: [] }, released: 0 };   // onZone(buildings): a zone's buildings became solid. timings: ms per build

  function buildFar(zone) {
    const began = performance.now();
    const d = zone.data, roads = buildRoads(zone.roads, map, zone.owns);
    Object.assign(zone, { areas: d.areas, lines: d.lines });
    zone.far = new THREE.Group();
    zone.far.add(
      buildTerrain(zone, ground), roads, buildWalkways(zone.roads, map, zone.owns), buildWaterfront(zone, ground),
      buildStructures(map, zone, (x, z, road) => !nearRoad(x, z, 2, 'ground', road)),         // (a pier may stand wherever no road runs on the ground)
      buildFacades(d.b.filter(b => b.h >= TALL), ground, facadeKit, zone.seed),
    );
    group.add(zone.far);
    zone.mirrorless = [roads];
    unmirrored.push(roads);
    zone.level = 1;
    if (conditions) setConditions(conditions);        // a road material made just now starts out dry
    api.timings.far.push(Math.round(performance.now() - began));
  }
  function buildNear(zone) {
    const began = performance.now();
    const d = zone.data;
    zone.outlines = d.b.map(b => b.p).concat(d.nb);
    const streets = buildStreets(ctx, zone);
    if (streets.parked.length) streets.group.add(trafficKit.parkedMesh(streets.parked, ground));
    zone.low = buildFacades(d.b.filter(b => b.h < TALL), ground, facadeKit, zone.seed + 1000);
    zone.near = new THREE.Group();
    zone.near.add(streets.group, zone.low);
    group.add(zone.near);
    // What is solid, and where the lamps stand, is kept for good once a zone has been built: it is small,
    // and the same when the zone is built again after having been let go (see release()).
    if (!zone.known) {
      zone.known = true;
      for (const b of d.b) addSolid(b.p);
      // poles and tree trunks: circles, kept in the same grid
      for (const post of streets.posts) bucket(cells, cellOf(post.x), cellOf(post.z)).push({ ...post, seen: 0 });
      posts.push(...streets.posts);
      lamps.push(...streets.lamps);
      api.onZone?.(d.b);
    }
    zone.mirrorless.push(...streets.decals);
    unmirrored.push(...streets.decals);
    zone.seasonal = streets.seasonal;
    for (const mesh of streets.seasonal) { mesh.visible = fine; seasonal.push(mesh); }
    zone.signals = streets.signals.length ? streets.signals : null;
    if (zone.signals) signalHeads.push(zone.signals);
    signalStep = -1;
    zone.level = 2;
    zone.data = zone.areas = zone.lines = zone.outlines = null;       // everything is in the scene now
    api.timings.near.push(Math.round(performance.now() - began));
  }
  // A zone that fails to download is asked for again a few seconds later.
  const fetchZone = zone => zone.fetching ||= map.loadZone(zone.i, zone.j).then(data => { zone.data = data; }, error => {
    console.warn(`zone ${zone.i},${zone.j} did not load, will retry`, error);
    setTimeout(() => { zone.fetching = null; }, 4000);
  });
  const gap = (zone, x, z) => Math.hypot(Math.max(zone.x0 - x, 0, x - zone.x1), Math.max(zone.z0 - z, 0, z - zone.z1));
  // Let go of a zone left far behind: its meshes come off the scene and out of the graphics memory.
  // Shapes shared by every zone (the instanced street furniture) and all materials are kept.
  const remove = (list, items) => { for (const it of items || []) { const at = list.indexOf(it); if (at >= 0) list.splice(at, 1); } };
  function release(zone) {
    for (const part of [zone.far, zone.near]) {
      if (!part) continue;
      group.remove(part);
      part.traverse(o => {
        if (o.isInstancedMesh) o.dispose();
        else if (o.geometry) o.geometry.dispose();      // (everything a zone shares with others is instanced, so this is its own)
      });
    }
    remove(unmirrored, zone.mirrorless);
    remove(seasonal, zone.seasonal);
    if (zone.signals) remove(signalHeads, [zone.signals]);
    Object.assign(zone, { far: null, near: null, low: null, mirrorless: null, seasonal: null, signals: null, level: 0, data: null, fetching: null, areas: null, lines: null, outlines: null });
    api.released++;
  }

  // Called every frame with the car's position. Fetches what is coming into range and builds at most
  // one zone level per call, nearest first, so a frame never has to build a whole neighbourhood.
  let pending = 0, holdAll = false;
  function stream(x, z) {
    let job = null, best = Infinity;
    pending = 0;
    for (const zone of zones) {
      // open country with no road through it is only built close by: further off the coarse ground does
      const d = gap(zone, x, z), want = d < NEAR ? 2 : d < FAR && !zone.empty ? 1 : 0;
      if (zone.low) zone.low.visible = d < LOW;
      if (zone.level > 0 && d > (zone.empty ? NEAR : FAR) + KEEP && !holdAll) { release(zone); continue; }
      if (zone.level >= want) continue;
      pending++;
      fetchZone(zone);
      const score = d + (zone.level === 0 ? 0 : 150);         // ground first, then detail
      if (zone.data && score < best) { best = score; job = zone; }
    }
    if (!job) return;
    if (job.level === 0) buildFar(job); else buildNear(job);
  }
  // Fetch and build everything wanted around (x, z) before returning: used before the first frame.
  async function prepare(x, z, reach = NEAR) {
    if (reach === Infinity) holdAll = true;          // everything was asked for (the tests): nothing is let go again
    // (asked for everything, open country with nothing on it is left out)
    const wanted = zones.filter(zone => gap(zone, x, z) < reach && !(reach === Infinity && zone.empty));
    await Promise.all(wanted.map(fetchZone));
    for (const zone of wanted) {
      if (!zone.data && zone.level < 2) continue;         // failed to download: stream() picks it up when it arrives
      if (zone.level < 1) buildFar(zone);
      if (zone.level < 2) buildNear(zone);
    }
  }

  // ---------- lamps that really light things ----------
  // Every lamp throws a painted pool of light (see street.js); the few nearest the car also get a real
  // light, so the car, the kerb and the walls beside it are lit as it passes.
  const LAMP_REACH = 80;
  let lampSlots = [], lampPower = 0;
  function setLampLights(count) {
    for (const slot of lampSlots) group.remove(slot.light);
    lampSlots = Array.from({ length: count }, () => {
      const light = new THREE.PointLight(0xffcf9a, 0, 34, 1.6);
      light.visible = false;
      group.add(light);
      return { light, lamp: null, level: 0 };
    });
  }
  setLampLights(6);
  function lightLamps(x, z, dt) {
    const on = lampPower > 0.01;
    for (const slot of lampSlots) slot.light.visible = on;
    if (!on || !lampSlots.length) return;
    const ranked = [];
    for (const l of lamps) {
      const d = Math.hypot(l.x - x, l.z - z);
      if (d < LAMP_REACH) ranked.push({ l, d });
    }
    ranked.sort((p, q) => p.d - q.d);
    // lamps fade out as they near the edge of reach, or the rank at which they lose their light to a nearer one
    const near = ranked.slice(0, lampSlots.length), edge = ranked[lampSlots.length]?.d ?? LAMP_REACH;
    // A light never jumps: it dims to nothing on its lamp before it is moved to another one.
    const step = Math.min(1, dt * 2.5);
    for (const slot of lampSlots) {
      const n = slot.lamp && near.find(m => m.l === slot.lamp);
      const wanted = n ? Math.max(0, Math.min(1, (edge - n.d) / 20)) : 0;
      slot.level += Math.max(-step, Math.min(step, wanted - slot.level));
      if (!n && slot.level < 0.01) slot.lamp = null;
    }
    for (const n of near) {
      if (lampSlots.some(s => s.lamp === n.l)) continue;
      const free = lampSlots.find(s => !s.lamp);
      if (!free) break;
      free.lamp = n.l;
      free.level = 0;
      free.light.position.set(n.l.x, n.l.y + 7.4, n.l.z);
    }
    for (const slot of lampSlots) slot.light.intensity = slot.lamp ? 130 * lampPower * slot.level : 0;
  }

  // How the city answers the sky, all 0..1. windows: lit windows; lamps: street lamps and glowing signs;
  // pools: light the lamps throw on the ground; wet: rain on the carriageway; snow: snow lying on the ground and roofs.
  let conditions = null;
  function setConditions(now) {
    const { windows, lamps: lit, pools, wet, snow } = conditions = now;
    if (now.haze) backdrop.tint(now.haze, now.far, lit);
    fine = windows < 0.3 && wet < 0.15 && snow < 0.1 && !(now.far < 2800);        // a bright dry day (not an overcast one)
    for (const mesh of seasonal) mesh.visible = fine;
    ENV.night.value = windows;
    ENV.snow.value = snow;
    ENV.wet.value = wet;
    streetKit.lampGlow.emissiveIntensity = 4 * lit;
    streetKit.pools.opacity = pools * (1 + 0.4 * wet);
    streetKit.halos.opacity = lit;
    streetKit.signs.emissiveIntensity = 0.05 + 0.3 * lit;
    facadeKit.signs.emissiveIntensity = facadeKit.blades.emissiveIntensity = 0.12 + 0.8 * lit;
    lampPower = lit * Math.min(1, pools / 0.5 + 0.3);     // weaker at dusk, when there is still daylight
    for (const material of tarmacMaterials()) {
      material.roughness = 0.92 - 0.5 * wet;      // not mirror-smooth: the lamps overhead would glare
      material.color.copy(material.userData.dry).multiplyScalar(1 - 0.4 * wet);
    }
    sea.material.roughness = 0.25 + 0.3 * wet;
  }

  // The surface the car's wheels rest on. y: how high the car is now, which decides between a deck and the ground under it.
  const surface = (x, z, y) => map.surfaceAt(x, z, y === undefined ? Infinity : y - LAYER.major) + LAYER.major;
  return Object.assign(api, {
    map, group, ground, top: map.top, heightFor: map.heightFor, levelAt: (x, z, y) => map.levelAt(x, z, y - LAYER.major), surface, query, roadAt, spawnOn, posts, update: updateSignals, lanes, stops, trafficKit, atlas,
    walks, signalAt: junction => signalState(junction, signalTime), setConditions, lightLamps, setLampLights,
    stream, prepare, loadAll: () => prepare(0, 0, Infinity),
    get pending() { return pending; },
    // left out of the picture mirrored in a wet road: the road itself and the light painted on it
    unmirrored,
  });
}
