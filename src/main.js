import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CARS, COLORS } from './cars.js';
import { Vehicle } from './vehicle.js';
import { createWorld } from './world.js';
import { EngineSound } from './audio.js';
import { createAtmosphere, TIMES, WEATHERS } from './atmosphere.js';
import { Windshield } from './windshield.js';
import { Ambience } from './ambience.js';
import { createSpray } from './spray.js';
import { createGuide } from './guide.js';
import { createRoadReflection } from './reflection.js';
import { Radio } from './radio.js';
import { ENV } from './map/shared.js';
import { createTraffic } from './traffic.js';
import { createTrafficView } from './trafficview.js';
import { createPeople } from './people.js';
import { createPeopleView } from './peopleview.js';

const $ = sel => document.querySelector(sel);
const START_STREET = '마린시티2로';

// ---------- renderer and scene ----------
const renderer = new THREE.WebGLRenderer({ canvas: $('#scene'), antialias: true, powerPreference: 'high-performance' });
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.55;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.2, 13000);       // far enough for the hills and the bridge beyond the map

const BASE = import.meta.env.BASE_URL;      // the game may be served from a sub-folder
const world = await createWorld(`${BASE}map/haeundae/`);
scene.add(world.group);
const atmosphere = createAtmosphere({ renderer, scene, camera, world });

const reflection = createRoadReflection(renderer, scene);

// Glow around lamps, signs and lit windows. Only used when the scene has lights of its own showing.
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0, 0.4, 0.9);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(bloom);
composer.addPass(new OutputPass());
$('#attribution').textContent = world.map.meta.attribution;

// ---------- traffic ----------
const traffic = createTraffic(world.lanes, { signalOf: world.signalAt });
// a car in the traffic is as high as the road it is on: up on the bridge, or down on the road under it
// (crossing a junction it is on the road it comes from, or on the one it goes to if that is the one underneath)
const roadUnder = c => c.path.road || (c.path.to.road.low ? c.path.to.road : c.path.from.road);
const trafficView = createTrafficView(world.trafficKit, scene, (x, z, c) => world.heightFor(c ? roadUnder(c) : null)(x, z));
const people = createPeople(world.walks, { signalOf: world.signalAt });
const peopleView = createPeopleView(scene, (x, z, p) => world.heightFor(p?.edge?.road)(x, z), `${BASE}people/`);
let peopleFilled = false, brakeForPeople = 0;
const stopping = { show: 0, horn: 0, quiet: 0 };       // the warning while the car stops itself for someone: seconds left of each
const TRAFFIC = [['none', '없음', 0], ['light', '적음', 0.5], ['normal', '보통', 1]];
let trafficLevel = 'normal', trafficFilled = false;
const frustum = new THREE.Frustum(), viewMatrix = new THREE.Matrix4(), probe = new THREE.Sphere(new THREE.Vector3(), 7);
// cars appear and disappear where the camera is not looking
const outOfSight = (x, z) => !frustum.intersectsSphere(probe.set(probe.center.set(x, world.ground(x, z) + 1, z), 7));
function updateTraffic(dt) {
  const busy = { night: 0.45, dawn: 0.5 }[atmosphere.time.id] ?? 1;       // fewer cars about at night
  const level = TRAFFIC.find(t => t[0] === trafficLevel)[2], want = Math.round(quality.traffic * level * busy);
  // people stay in when it is dark or wet
  const out = ({ night: 0.35, dawn: 0.3 }[atmosphere.time.id] ?? 1) * ({ rain: 0.5, snow: 0.6, fog: 0.8 }[atmosphere.weather.id] ?? 1);
  const crowd = window.__game?.crowd ?? Math.round(quality.people * Math.min(1, level * 2) * out);
  frustum.setFromProjectionMatrix(viewMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const facing = car.reverse ? -1 : 1;
  const player = { x: car.x, z: car.z, y: car.y, vx: car.vx, vz: car.vz, fx: Math.sin(car.heading) * facing, fz: Math.cos(car.heading) * facing,
    ux: Math.sin(car.heading), uz: Math.cos(car.heading), len: car.spec.L, kind: { wid: car.spec.W },        // its body, for people to walk round... or wait for
  };
  for (const c of traffic.cars) c.y = world.heightFor(roadUnder(c))(c.x, c.z);       // so that what is on a bridge and what is under it leave each other alone
  brakeForPeople = people.step(Math.min(dt, 0.1), {
    // to begin with the streets are filled wherever there is room, in view or not; after that people only turn up unseen
    focus: car, want: crowd, cars: traffic.cars, player, hidden: peopleFilled ? outOfSight : () => true, near: peopleFilled ? 45 : 14, wet: Math.max(atmosphere.rain, atmosphere.snowfall), stops: world.stops,
  });
  if (people.people.length >= crowd * 0.8) peopleFilled = true;
  peopleView.sync(people.people, dt, camera);
  if (!want && !traffic.cars.length) { trafficView.sync([], { lights: false, time: 0 }); return; }
  // the streets start out populated: the first cars may appear closer than later ones
  traffic.step(Math.min(dt, 0.1), { focus: car, want, player, hidden: outOfSight, near: trafficFilled ? 90 : 35, people: people.people });
  if (traffic.cars.length >= want * 0.8) trafficFilled = true;
  for (const e of traffic.events.splice(0)) if (e.type === 'honk') sound.honk(Math.max(0, 1 - Math.hypot(e.x - car.x, e.z - car.z) / 60));
  trafficView.sync(traffic.cars, { lights: atmosphere.wantsLights, time: traffic.time });
}
// everything the player's car can run into: the fixed world and the other cars
// what the player's car can run into, at the height it is at
const solids = { query(x, z, r, cb) { world.query(x, z, r, cb, car.y); traffic.query(x, z, r, cb, car.y); people.query(x, z, r, cb); } };

// ---------- car ----------
// Settings kept in the browser from one visit to the next (nothing is sent anywhere).
const SAVE_KEY = 'haeundae-drive:1';
const saved = (() => { try { return JSON.parse(localStorage.getItem(SAVE_KEY)) || {}; } catch { return {}; } })();
const guide = createGuide(world.map);
let spawn = world.spawnOn(START_STREET);        // where R puts the car back
// (what is read back is checked: a damaged entry must not stop the game from starting)
const indexIn = (v, list, otherwise) => (Number.isInteger(v) && v >= 0 && v < list.length ? v : otherwise);
let carIndex = indexIn(saved.car, CARS, 1), colorIndex = indexIn(saved.color, COLORS, 0), car = null;

function selectCar(index) {
  const at = car ? { x: car.x, z: car.z, heading: car.heading } : spawn;
  if (car) {
    scene.remove(car.mesh);
    car.vis.interior.dispose();
    car.mesh.traverse(o => { o.geometry?.dispose(); for (const m of [o.material].flat()) { m?.map?.dispose(); m?.dispose(); } });
  }
  const signal = car?.signal;
  carIndex = index;
  car = new Vehicle(CARS[index], COLORS[colorIndex]);
  if (signal) car.signal = signal;
  car.reset(at.x, at.z, at.heading);
  car.y = world.surface(at.x, at.z);
  scene.add(car.mesh);
  mirrorsLive = null;
}
let mirrorsLive = null;                 // whether the car's mirrors currently show the live picture
selectCar(carIndex);

// ---------- input ----------
const keys = new Set();
// Looking around: dragging the mouse or the right stick turns the driver's head, or swings the chase camera.
const look = { yaw: 0, pitch: 0, drag: false, stickX: 0, stickY: 0 };
let padBefore = [];                     // which gamepad buttons were down last frame
function readInput() {
  const k = (...codes) => (codes.some(c => keys.has(c)) ? 1 : 0);
  const inp = {
    up: k('KeyW', 'ArrowUp'), down: k('KeyS', 'ArrowDown'),
    steer: k('KeyA', 'ArrowLeft') - k('KeyD', 'ArrowRight'), handbrake: keys.has('Space'),
  };
  const pad = navigator.getGamepads?.().find(p => p);
  if (pad) {
    const dead = v => (Math.abs(v) < 0.08 ? 0 : v);
    inp.up = Math.max(inp.up, pad.buttons[7]?.value || 0);
    inp.down = Math.max(inp.down, pad.buttons[6]?.value || 0);
    if (inp.steer === 0) inp.steer = -dead(pad.axes[0] || 0);
    inp.handbrake ||= !!pad.buttons[0]?.pressed;
    const down = pad.buttons.map(b => b.pressed), pressed = i => down[i] && !padBefore[i];
    if (pressed(4)) car.setSignal('left');           // shoulder buttons: turn signals; Y: hazard lights
    if (pressed(5)) car.setSignal('right');
    if (pressed(3)) car.setSignal('hazard');
    inp.horn = !!down[10];                           // press the left stick
    padBefore = down;
    look.stickX = pad.mapping === 'standard' ? pad.axes[2] || 0 : 0;      // right stick: look around
    look.stickY = pad.mapping === 'standard' ? pad.axes[3] || 0 : 0;
  } else look.stickX = look.stickY = 0;
  inp.horn ||= keys.has('KeyH');
  return inp;
}

// ---------- game state ----------
const sound = new EngineSound();
const radio = new Radio();
radio.onchange = () => {
  const s = radio.station;
  $('#radio-station').textContent = s ? `${s === radio.mine ? '' : 'FM '}${s.freq} · ${s.name}` : '라디오 꺼짐';
  $('#radio-track').textContent = s && radio.track ? `${radio.track.title} — ${radio.track.artist}` : '';
};
radio.load(`${BASE}radio/channels.json`).then(() => {
  $('#credits-music').innerHTML = radio.channels.flatMap(c => c.tracks).map(t =>
    `<li>"${t.title}" — ${t.artist} · <a href="${t.source}" target="_blank" rel="noopener">${new URL(t.source).host}</a> · <a href="${t.licenceUrl}" target="_blank" rel="noopener">${t.licence}</a></li>`).join('');
});
$('#credits-map').textContent = world.map.meta.attribution;
let tunnel = false;                      // radio reception drops while the car is in one
// ---------- graphics quality ----------
// Three levels. "auto" picks one from the graphics chip and steps down if the frame rate stays low.
const QUALITY = {
  // mirrors: width of the picture the car's mirrors show, and how many frames pass between redraws
  low: { name: '낮음', pixels: 1, shadows: 0, particles: 0.5, bloom: false, lampLights: 0, reflections: false, mirrors: null, traffic: 8, people: 25 },
  medium: { name: '보통', pixels: 1.5, shadows: 2048, particles: 0.75, bloom: true, lampLights: 4, reflections: false, mirrors: { width: 320, every: 4 }, traffic: 20, people: 110 },
  high: { name: '높음', pixels: 2, shadows: 4096, particles: 1, bloom: true, lampLights: 6, reflections: true, mirrors: { width: 640, every: 2 }, traffic: 40, people: 150 },
};
const ORDER = ['low', 'medium', 'high'];
function guessQuality() {
  const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
  const chip = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
  if (/swiftshader|llvmpipe|software/i.test(chip)) return 'low';
  // chips built into the processor, and phones: leave out the costliest effect
  return /intel|iris|uhd|mali|adreno|powervr|apple gpu/i.test(chip) || !chip ? 'medium' : 'high';
}
let qualityChoice = 'auto', quality = null, qualityLevel = '';
function setQuality(choice, level = choice === 'auto' ? guessQuality() : choice) {
  qualityChoice = choice;
  qualityLevel = level;
  quality = QUALITY[level];
  renderer.setPixelRatio(Math.min(devicePixelRatio, quality.pixels));
  atmosphere.setQuality(quality);
  world.setLampLights(quality.lampLights);
  if (!quality.reflections) reflection.clear();
  mirrorsLive = null;
  resize();
  $('#quality-list').innerHTML = [['auto', `자동 (${quality.name})`], ...ORDER.map(k => [k, QUALITY[k].name])].map(([k, label]) =>
    `<button class="${k === choice ? 'on' : ''}" data-quality="${k}">${choice !== 'auto' && k === 'auto' ? '자동' : label}</button>`).join('');
}
$('#quality-list').addEventListener('click', e => { if (e.target.dataset.quality) { setQuality(e.target.dataset.quality); save(); } });
// in "auto", a few seconds below this frame rate while driving drops one level
const SLOW_FPS = 27;
let slowFor = 0, fpsSmooth = 60;
function watchFrameRate(dt) {
  if (dt > 0.25) { slowFor = 0; return; }       // a stall (hidden tab, shaders compiling) says nothing about speed
  fpsSmooth += (1 / Math.max(dt, 1e-3) - fpsSmooth) * Math.min(1, dt * 2);
  slowFor = qualityChoice === 'auto' && state === 'drive' && fpsSmooth < SLOW_FPS ? slowFor + dt : 0;
  const at = ORDER.indexOf(qualityLevel);
  if (slowFor > 4 && at > 0) { slowFor = 0; setQuality('auto', ORDER[at - 1]); }
}

const glass = new Windshield($('#glass'));
// photo mode: the camera circles the car where the mouse puts it
const photo = { yaw: 0, pitch: 0.18, dist: 8, shoot: false };
const VIEWS = ['chase', 'cockpit', 'bonnet'];
let state = 'menu', view = 'chase', lights = false, camYaw = spawn.heading, orbit = 0.6, frames = 0;
let hudAlways = false;                  // show the on-screen instruments in the driver's seat too

// Change the weather and/or the time of day. Headlights follow what the new conditions call for.
function setSky(choice) {
  atmosphere.set(choice);
  lights = atmosphere.wantsLights;
  $('#sky-chip').textContent = `${atmosphere.weather.name} · ${atmosphere.time.name}`;
  renderMenu();
}
const cycle = (list, current) => list[(list.indexOf(current) + 1) % list.length].id;

// A shake of the gamepad, where it has motors. strength 0..1, for so many milliseconds.
let rumbleUntil = 0;
function rumble(strength, ms) {
  if (performance.now() < rumbleUntil) return;         // one shake at a time
  rumbleUntil = performance.now() + ms;
  const pad = navigator.getGamepads?.().find(p => p);
  pad?.vibrationActuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: strength, weakMagnitude: strength * 0.6 })?.catch?.(() => {});
}

// One simulation step: controls, physics at 240 Hz, collisions, ground following.
function update(dt, inp) {
  const height = car.placed ? car.y : undefined;        // just put down: on the uppermost surface
  const g = (x, z) => world.surface(x, z, height);
  car.gx = (g(car.x + 1, car.z) - g(car.x - 1, car.z)) / 2;
  car.gz = (g(car.x, car.z + 1) - g(car.x, car.z - 1)) / 2;
  car.control(dt, inp);
  // Someone on foot right ahead: the car stops by itself, at once, whatever the driver is doing - and
  // says so, on the screen and with the horn. Someone close beside the way: it slows to a crawl.
  const speed = Math.hypot(car.vx, car.vz), halt = brakeForPeople === 2;
  if (halt || (brakeForPeople === 1 && speed > 4)) { car.throttle = 0; car.brake = 1; }
  if (halt && speed > 1.5 && stopping.quiet <= 0) { stopping.horn = 0.45; stopping.quiet = 3; }
  if (halt && (speed > 0.3 || inp.up || inp.down)) stopping.show = 0.9;
  for (const key of Object.keys(stopping)) stopping[key] = Math.max(0, stopping[key] - dt);
  $('#alert').classList.toggle('is-hidden', stopping.show <= 0);
  sound.horn(!!inp.horn || stopping.horn > 0);
  const n = Math.max(1, Math.ceil(dt * 240));
  for (let i = 0; i < n; i++) car.step(dt / n, atmosphere.grip);
  if (halt) {
    // harder than the brakes alone, on any road: the car is held, not merely slowed
    const now = Math.hypot(car.vx, car.vz), keep = now > 0 ? Math.max(0, now - 14 * dt) / now : 0;
    car.vx *= keep;
    car.vz *= keep;
    car.vf *= keep;
    car.vl *= keep;
  }
  const impact = car.collide(solids);
  if (impact > 1.5) rumble(Math.min(1, impact / 9), 160);
  if (halt && speed > 3) rumble(0.5, 120);
  car.y = world.surface(car.x, car.z, height);
  car.placed = true;
}

const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const eye = new THREE.Vector3(), quat = new THREE.Quaternion();
const faceForward = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
const glance = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0), RIGHT = new THREE.Vector3(1, 0, 0);

// The picture in the car's mirrors: the scene behind, drawn without the car itself.
function renderMirror() {
  const m = car.vis.interior.mirror, shadows = renderer.shadowMap.autoUpdate, before = renderer.getRenderTarget();
  if (m.target.width !== quality.mirrors.width) m.target.setSize(quality.mirrors.width, quality.mirrors.width / 4);
  const wet = ENV.wet.value;
  for (const part of car.vis.parts) part.visible = false;
  renderer.shadowMap.autoUpdate = false;        // the shadows drawn for the main view are still good
  ENV.wet.value = 0;                            // the road's reflection is worked out for the view ahead only
  try {
    renderer.setRenderTarget(m.target);
    renderer.clear();
    renderer.render(scene, m.camera);
  } finally {
    renderer.setRenderTarget(before);
    renderer.shadowMap.autoUpdate = shadows;
    ENV.wet.value = wet;
    for (const part of car.vis.parts) part.visible = true;
  }
}

function updateCamera(dt) {
  const p = car.mesh.position, speed = Math.abs(car.vf);
  // the view returns to straight ahead when the mouse is released or the stick let go
  if (Math.hypot(look.stickX, look.stickY) > 0.15) {
    const k = Math.min(1, dt * 8);
    look.yaw += (-look.stickX * (view === 'chase' ? Math.PI : 1.9) - look.yaw) * k;
    look.pitch += (-look.stickY * 0.45 - look.pitch) * k;
  } else if (!look.drag) {
    look.yaw *= Math.exp(-dt * 5);
    look.pitch *= Math.exp(-dt * 5);
  }
  const wide = view === 'chase' ? Math.PI : 2.3;
  look.yaw = Math.max(-wide, Math.min(wide, look.yaw));
  look.pitch = Math.max(view === 'chase' ? -0.2 : -0.6, Math.min(view === 'chase' ? 0.9 : 0.6, look.pitch));
  let fov = 45;
  if (state === 'photo') {
    const flat = Math.cos(photo.pitch) * photo.dist, cx = p.x + Math.sin(photo.yaw) * flat, cz = p.z + Math.cos(photo.yaw) * flat;
    camera.position.set(cx, Math.max(p.y + 0.9 + Math.sin(photo.pitch) * photo.dist, world.surface(cx, cz, car.y) + 0.4), cz);
    camera.lookAt(p.x, p.y + 0.8, p.z);
    fov = 40;
  } else if (state === 'menu') {
    orbit += dt * 0.2;
    const pose = window.__game?.pose, angle = pose ? car.heading + pose.angle : orbit, dist = pose?.dist ?? 7.4;
    camera.position.set(p.x + Math.sin(angle) * dist, p.y + (pose?.height ?? 2.1), p.z + Math.cos(angle) * dist);
    camera.lookAt(p.x, p.y + 0.8, p.z);
    if (pose?.fov) fov = pose.fov;
  } else if (view === 'chase') {
    camYaw += angleDiff(car.heading, camYaw) * (1 - Math.exp(-dt * 5));
    const dist = 6.4 + speed * 0.035, around = camYaw + look.yaw, ahead = 3 * Math.max(0, Math.cos(look.yaw));
    const cx = p.x - Math.sin(around) * dist, cz = p.z - Math.cos(around) * dist;
    camera.position.set(cx, Math.max(p.y + 2.3 + speed * 0.01 + look.pitch * 5, world.ground(cx, cz) + 1.2), cz);
    camera.lookAt(p.x + Math.sin(car.heading) * ahead, p.y + 1, p.z + Math.cos(car.heading) * ahead);
    fov = 58 + Math.min(20, speed * 0.4);
  } else {
    const seated = view === 'cockpit';
    car.vis.chassis.updateWorldMatrix(true, false);
    camera.position.copy(car.vis.chassis.localToWorld(eye.copy(seated ? car.vis.eye : car.vis.bonnet)));
    car.vis.chassis.getWorldQuaternion(quat);
    camera.quaternion.copy(quat).multiply(faceForward).multiply(glance.setFromAxisAngle(UP, (seated ? car.steer * 0.5 : 0) + look.yaw))
      .multiply(glance.setFromAxisAngle(RIGHT, look.pitch));
    fov = seated ? 70 : 62;
  }
  if (Math.abs(camera.fov - fov) > 0.01) {
    camera.fov += (fov - camera.fov) * Math.min(1, dt * 4);
    camera.updateProjectionMatrix();
  }
}

// ---------- HUD ----------
const hud = { speed: $('#speed'), gear: $('#gear'), rpm: $('#rpm'), limit: $('#limit'), road: $('#road-name'), left: $('#blink-left'), right: $('#blink-right') };
const mini = $('#minimap').getContext('2d'), MINI = 180, MINI_SCALE = 0.42;   // px per metre
const paths = { minor: new Path2D(), major: new Path2D(), solid: new Path2D(), land: new Path2D() };
const trace = (path, p, close) => {
  path.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length; i += 2) path.lineTo(p[i], p[i + 1]);
  if (close) path.closePath();
};
for (const r of world.map.roads) {
  if (r.c === 'drive' && !r.br) trace(/^(trunk|primary|secondary)/.test(r.k) ? paths.major : paths.minor, r.p);
}
for (const l of world.map.land) trace(paths.land, l, true);
// buildings appear on the map as their zones are loaded
world.onZone = buildings => { for (const b of buildings) trace(paths.solid, b.p, true); };
await world.prepare(spawn.x, spawn.z);
$('#loading').remove();

function drawMinimap() {
  mini.setTransform(1, 0, 0, 1, 0, 0);
  mini.fillStyle = '#2f5f80';
  mini.fillRect(0, 0, MINI, MINI);
  // heading-up: the car's forward direction points to the top of the map
  mini.translate(MINI / 2, MINI / 2);
  mini.rotate(car.heading + Math.PI);
  mini.scale(MINI_SCALE, MINI_SCALE);
  mini.translate(-car.x, -car.z);
  mini.fillStyle = '#3d4248';
  mini.fill(paths.land);
  mini.fillStyle = '#6b727a';
  mini.fill(paths.solid);
  mini.lineCap = mini.lineJoin = 'round';
  mini.strokeStyle = '#9aa1a9';
  mini.lineWidth = 6;
  mini.stroke(paths.minor);
  mini.strokeStyle = '#e8eaed';
  mini.lineWidth = 11;
  mini.stroke(paths.major);
  if (guide.route) {
    const r = guide.route;
    mini.strokeStyle = '#3aa0ff';
    mini.lineWidth = 9;
    mini.beginPath();
    mini.moveTo(r[0][0], r[0][1]);
    for (let i = 1; i < r.length; i++) mini.lineTo(r[i][0], r[i][1]);
    mini.stroke();
  }
  mini.setTransform(1, 0, 0, 1, MINI / 2, MINI / 2);
  if (guide.goal) {
    // the goal as a pin: where it is, or on the rim of the map in its direction if it is off it
    const dx = guide.goal.x - car.x, dz = guide.goal.z - car.z, c = Math.cos(car.heading + Math.PI), s = Math.sin(car.heading + Math.PI);
    let px = (dx * c - dz * s) * MINI_SCALE, py = (dx * s + dz * c) * MINI_SCALE;
    const far = Math.hypot(px, py), rim = MINI / 2 - 10;
    if (far > rim) { px *= rim / far; py *= rim / far; }
    mini.fillStyle = '#3aa0ff';
    mini.strokeStyle = '#fff';
    mini.lineWidth = 2;
    mini.beginPath();
    mini.arc(px, py, 6, 0, Math.PI * 2);
    mini.fill();
    mini.stroke();
  }
  mini.fillStyle = '#ffb547';
  mini.beginPath();
  mini.moveTo(0, -9);
  mini.lineTo(6, 7);
  mini.lineTo(0, 3);
  mini.lineTo(-6, 7);
  mini.closePath();
  mini.fill();
}

let roadTimer = 0;
function updateHud(dt) {
  const s = car.spec, kmh = Math.round(Math.abs(car.vf) * 3.6);
  hud.speed.textContent = kmh;
  hud.gear.textContent = car.reverse ? 'R' : `D${car.gear + 1}`;
  hud.rpm.style.width = `${Math.min(100, car.rpm / s.redline * 100)}%`;
  hud.rpm.classList.toggle('hot', car.rpm > s.redline * 0.9);
  hud.left.classList.toggle('on', car.blinkOn && car.signal !== 'right');
  hud.right.classList.toggle('on', car.blinkOn && car.signal !== 'left');
  roadTimer -= dt;
  if (roadTimer <= 0) {
    roadTimer = 0.3;
    const road = world.roadAt(car.x, car.z, 14, car.y);
    tunnel = world.levelAt(car.x, car.z, car.y) < 0;
    hud.limit.textContent = road ? road.limit : '–';
    hud.road.textContent = road?.name || (road ? '이름 없는 길' : '도로 밖');
    hud.limit.dataset.over = road && kmh > road.limit + 5 ? '1' : '';
  }
  // the way to the place chosen
  const reached = guide.update(dt, car);
  if (reached) { toast(`${reached.name} 도착`); renderPlaces(); save(); }
  $('#guide-chip').classList.toggle('is-hidden', !guide.goal);
  if (guide.goal) $('#guide-chip').textContent = `→ ${guide.goal.name} ${guide.left >= 950 ? `${(guide.left / 1000).toFixed(1)}km` : `${Math.round(guide.left / 10) * 10}m`}`;
  drawMinimap();
}

// a line of text in the middle of the screen for a few seconds
let toastTimer = 0;
function toast(text) {
  $('#toast').textContent = text;
  $('#toast').classList.remove('is-hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.add('is-hidden'), 3200);
}

// ---------- places: where to set off from and where to go ----------
function renderPlaces() {
  $('#start-place').innerHTML = `<option value="">지금 있는 곳</option>${guide.places.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}`;
  $('#dest-place').innerHTML = `<option value="">없음</option>${guide.places.map(p => `<option value="${p.id}" ${guide.goal === p ? 'selected' : ''}>${p.name}</option>`).join('')}`;
}
function setGoal(id) {
  const place = guide.places.find(p => p.id === id);
  if (place && Math.hypot(place.x - car.x, place.z - car.z) < 60) { toast(`${place.name}: 이미 여기입니다`); id = null; }
  guide.set(id);
  renderPlaces();
  save();
}
$('#dest-place').addEventListener('change', e => setGoal(e.target.value || null));
$('#start-place').addEventListener('change', async e => {
  const place = guide.places.find(p => p.id === e.target.value);
  if (!place) return;
  spawn = place.start;
  await world.prepare(spawn.x, spawn.z);
  car.reset(spawn.x, spawn.z, spawn.heading);
  car.y = world.surface(spawn.x, spawn.z);
  camYaw = spawn.heading;
  trafficFilled = peopleFilled = false;
  save();
});

// ---------- keeping the settings ----------
function save() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      car: carIndex, color: colorIndex, quality: qualityChoice, traffic: trafficLevel, goal: guide.goal?.id || null,
      volumes: { engine: sound.volumes.engine, rain: sound.volumes.rain, street: ambience.volume, music: radio.volume },
      at: { x: Math.round(car.x * 10) / 10, z: Math.round(car.z * 10) / 10, y: Math.round(car.y * 10) / 10, heading: Math.round(car.heading * 100) / 100 },
    }));
  } catch { /* storage switched off or full: the game goes on without it */ }
}
addEventListener('pagehide', save);
document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
setInterval(() => { if (state === 'drive') save(); }, 5000);

// ---------- menu ----------
function renderMenu() {
  $('#car-list').innerHTML = CARS.map((c, i) => `
    <button class="car-card ${i === carIndex ? 'on' : ''}" data-car="${i}">
      <strong>${c.name}</strong><span>${c.tag}</span>
      <em>${Math.round(c.powerKW * 1.36)}마력 · ${c.mass.toLocaleString()}kg · ${c.drive}</em>
    </button>`).join('');
  $('#color-list').innerHTML = COLORS.map((c, i) =>
    `<button class="${i === colorIndex ? 'on' : ''}" data-color="${i}" style="background:#${c.hex.toString(16).padStart(6, '0')}" aria-label="색상 ${i + 1}"></button>`).join('');
  const choices = (list, current, key) => list.map(o =>
    `<button class="${o === current ? 'on' : ''}" data-${key}="${o.id}">${o.name}</button>`).join('');
  $('#time-list').innerHTML = choices(TIMES, atmosphere.time, 'time');
  $('#weather-list').innerHTML = choices(WEATHERS, atmosphere.weather, 'weather');
  $('#traffic-list').innerHTML = TRAFFIC.map(([id, name]) => `<button class="${id === trafficLevel ? 'on' : ''}" data-traffic="${id}">${name}</button>`).join('');
}
$('#time-list').addEventListener('click', e => e.target.dataset.time && setSky({ time: e.target.dataset.time }));
$('#weather-list').addEventListener('click', e => e.target.dataset.weather && setSky({ weather: e.target.dataset.weather }));
const setTraffic = level => { trafficLevel = level; if (level === 'none') { traffic.clear(); people.clear(); } trafficFilled = peopleFilled = false; renderMenu(); };
$('#traffic-list').addEventListener('click', e => { if (e.target.dataset.traffic) { setTraffic(e.target.dataset.traffic); save(); } });
$('#car-list').addEventListener('click', e => {
  const card = e.target.closest('[data-car]');
  if (!card) return;
  selectCar(Number(card.dataset.car));
  renderMenu();
  save();
});
$('#color-list').addEventListener('click', e => {
  if (e.target.dataset.color === undefined) return;
  colorIndex = Number(e.target.dataset.color);
  car.vis.setColour(COLORS[colorIndex]);
  renderMenu();
  save();
});

function setState(next) {
  state = next;
  $('#menu').classList.toggle('is-hidden', next !== 'menu');
  $('#hud').classList.toggle('is-hidden', next !== 'drive');
  $('#photo').classList.toggle('is-hidden', next !== 'photo');
  if (next === 'photo') Object.assign(photo, { yaw: car.heading + Math.PI * 0.8, pitch: 0.18, dist: 8, shoot: false });
  if (next === 'menu') renderPlaces();
  if (next !== 'drive') { sound.horn(false); stopping.show = stopping.horn = stopping.quiet = 0; $('#alert').classList.add('is-hidden'); }
  look.drag = false;
  if (next === 'drive') {
    camYaw = car.heading;
    sound.start();
    radio.start(sound.ctx);
    ambience.start(sound);
    document.activeElement?.blur();
  }
  keys.clear();
}
$('#start').addEventListener('click', () => setState('drive'));

// ---------- sound panel, own music, credits ----------
$('#vol-engine').addEventListener('input', e => { sound.volumes.engine = e.target.value / 100; });
$('#vol-rain').addEventListener('input', e => { sound.volumes.rain = e.target.value / 100; });
$('#vol-street').addEventListener('input', e => { ambience.volume = e.target.value / 100; });
$('#vol-music').addEventListener('input', e => { radio.volume = e.target.value / 100; });
for (const id of ['engine', 'rain', 'street', 'music']) $(`#vol-${id}`).addEventListener('change', save);
$('#keys-open').addEventListener('click', () => $('#keys').classList.remove('is-hidden'));
$('#keys-close').addEventListener('click', () => $('#keys').classList.add('is-hidden'));
$('#my-music').addEventListener('click', () => $('#my-files').click());
$('#my-files').addEventListener('change', e => { radio.addFiles(e.target.files); e.target.value = ''; });
$('#credits-open').addEventListener('click', () => $('#credits').classList.remove('is-hidden'));
$('#credits-close').addEventListener('click', () => $('#credits').classList.add('is-hidden'));
// music files can be dropped anywhere on the page
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); $('#drop-hint').classList.remove('is-hidden'); } });
addEventListener('dragleave', e => { if (!e.relatedTarget) $('#drop-hint').classList.add('is-hidden'); });
addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  $('#drop-hint').classList.add('is-hidden');
  radio.addFiles(e.dataTransfer.files);
});

addEventListener('keydown', e => {
  const typing = /^(SELECT|INPUT|BUTTON|A)$/.test(e.target?.tagName || '');           // a control of the menu has the keyboard
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code) && !(state === 'menu' && typing)) e.preventDefault();
  if (e.repeat) return;
  // Esc first closes whatever is open on top
  const open = [...document.querySelectorAll('.credits')].find(el => !el.classList.contains('is-hidden'));
  if (open && e.code === 'Escape') { open.classList.add('is-hidden'); return; }
  if (e.code === 'F1' || e.key === '?' || (e.code === 'Slash' && e.shiftKey)) { e.preventDefault(); $('#keys').classList.toggle('is-hidden'); return; }
  if (state === 'menu') {
    if (e.code === 'Enter' && !/^(SELECT|INPUT)$/.test(e.target?.tagName || '') && !open) setState('drive');
    return;
  }
  if (state === 'photo') {
    if (e.code === 'KeyP' || e.code === 'Escape') setState('drive');
    else if (e.code === 'Enter') photo.shoot = true;
    else if (e.code === 'KeyT') setSky({ time: cycle(TIMES, atmosphere.time) });
    else if (e.code === 'KeyY') setSky({ weather: cycle(WEATHERS, atmosphere.weather) });
    return;
  }
  keys.add(e.code);
  if (e.code === 'KeyC') { view = VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length]; look.yaw = look.pitch = 0; }
  else if (e.code === 'KeyU') hudAlways = !hudAlways;
  else if (e.code === 'KeyL') lights = !lights;
  else if (e.code === 'KeyQ') car.setSignal('left');
  else if (e.code === 'KeyE') car.setSignal('right');
  else if (e.code === 'KeyF') car.setSignal('hazard');
  else if (e.code === 'KeyT') setSky({ time: cycle(TIMES, atmosphere.time) });
  else if (e.code === 'KeyY') setSky({ weather: cycle(WEATHERS, atmosphere.weather) });
  else if (e.code === 'KeyM') radio.muted = sound.toggleMute();
  else if (e.code === 'Period') radio.turn(1);
  else if (e.code === 'Comma') radio.turn(-1);
  else if (e.code === 'Minus' || e.code === 'Equal') {
    radio.volume = Math.max(0, Math.min(1, radio.volume + (e.code === 'Equal' ? 0.1 : -0.1)));
    $('#vol-music').value = Math.round(radio.volume * 100);
  }
  else if (e.code === 'KeyR') { car.reset(spawn.x, spawn.z, spawn.heading); car.y = world.surface(spawn.x, spawn.z); camYaw = spawn.heading; }
  else if (e.code === 'KeyP') setState('photo');
  else if (e.code === 'KeyN') {
    // the next place in the list, then none
    const at = guide.places.indexOf(guide.goal), next = guide.places[at + 1];
    if (next) toast(`목적지: ${next.name}`); else toast('길 안내 끝');
    setGoal(next ? next.id : null);
  }
  else if (e.code === 'Escape') setState('menu');
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('mousedown', e => { if ((state === 'drive' || state === 'photo') && e.button === 0 && !e.target.closest?.('button, a, input, .credits')) look.drag = true; });
addEventListener('mouseup', () => { look.drag = false; });
addEventListener('mousemove', e => {
  if (!(e.buttons & 1)) look.drag = false;      // the button was let go somewhere the page could not see
  if (!look.drag) return;
  if (state === 'photo') {
    photo.yaw -= e.movementX * 0.006;
    photo.pitch = Math.max(-0.05, Math.min(1.3, photo.pitch + e.movementY * 0.004));
    return;
  }
  look.yaw -= e.movementX * 0.004;
  look.pitch -= e.movementY * 0.003;
});
addEventListener('wheel', e => { if (state === 'photo' && !e.ctrlKey) photo.dist = Math.max(3.5, Math.min(60, photo.dist * Math.exp(Math.max(-120, Math.min(120, e.deltaY)) * 0.0012))); }, { passive: true });
$('#photo-save').addEventListener('click', () => { photo.shoot = true; });
$('#photo-close').addEventListener('click', () => setState('drive'));
addEventListener('blur', () => { keys.clear(); sound.horn(false); look.drag = false; });
// with the page out of sight nothing is updated, so the sound is stopped rather than left hanging on its last note
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { sound.horn(false); sound.ctx?.suspend(); } else if (state === 'drive') sound.ctx?.resume();
});

// ---------- loop ----------
function resize() {
  if (quality) renderer.setPixelRatio(Math.min(devicePixelRatio, quality.pixels));    // the window may have moved to another screen
  renderer.setSize(innerWidth, innerHeight);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(innerWidth, innerHeight);
  reflection.resize(innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio());
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
setQuality(['auto', ...ORDER].includes(saved.quality) ? saved.quality : 'auto');
setSky({ instant: true });

// ---------- the sounds of the street, and what the weather does around the car ----------
const ambience = new Ambience(), spray = createSpray(scene);
const heard = { cars: [], sea: { gain: 0, pan: 0 }, crossing: null, wait: 0, storm: 8, wiping: true, stroke: 0 };
// pan: which ear something at (x, z) is in, from the driver's seat. Right of the heading (hx, hz) is (-hz, hx).
const panOf = (x, z) => {
  const dx = x - car.x, dz = z - car.z, d = Math.hypot(dx, dz) || 1, hx = Math.sin(car.heading), hz = Math.cos(car.heading);
  return (dx * -hz + dz * hx) / d;
};
function updateAmbience(dt, inside) {
  const driving = state === 'drive';
  // the traffic nearby, loudest first
  heard.cars.length = 0;
  for (const c of traffic.cars) {
    const d = Math.hypot(c.x - car.x, c.z - car.z);
    if (d > 55 || Math.abs((c.y ?? car.y) - car.y) > 4) continue;
    heard.cars.push({ gain: (1 - d / 55) ** 2 * Math.min(1, 0.25 + c.v / 12), pan: panOf(c.x, c.z), speed: c.v });
  }
  heard.cars.sort((a, b) => b.gain - a.gain);
  heard.wait -= dt;
  if (heard.wait <= 0) {
    heard.wait = 0.4;
    // how near the sea is, and which way: rings of points round the car, the nearest one in the water
    // (beyond the edge of the map there is no telling land from sea: those points do not count)
    let near = Infinity, sx = 0, sz = 0;
    const m = world.map;
    for (const r of [30, 60, 100, 150, 220]) {
      for (let k = 0; k < 12; k++) {
        const ux = Math.sin(k * Math.PI / 6), uz = Math.cos(k * Math.PI / 6), x = car.x + ux * r, z = car.z + uz * r;
        if (x < m.x0 || x > m.x1 || z < m.z0 || z > m.z1 || m.isLand(x, z)) continue;
        near = r;
        sx += ux;                   // the water lies the way most of the wet points do
        sz += uz;
      }
      if (near < Infinity) break;
    }
    heard.sea = near < Infinity ? { gain: (1 - near / 260) ** 2 * (tunnel ? 0.2 : 1), pan: Math.hypot(sx, sz) > 0.01 ? panOf(car.x + sx, car.z + sz) : 0 } : { gain: 0, pan: 0 };
    // the nearest crossing where people have the green
    heard.crossing = null;
    let best = 45;
    for (const j of world.lanes.junctions) {
      if (j.control !== 'signal' || Math.abs(j.x - car.x) > best || Math.abs(j.z - car.z) > best) continue;
      const d = Math.hypot(j.x - car.x, j.z - car.z), walks = world.signalAt(j).arms.map(a => a.walk);
      if (d >= best || !walks.some(w => w !== 'stop')) continue;
      best = d;
      heard.crossing = { gain: (1 - d / 45) ** 1.5, pan: panOf(j.x, j.z), hurry: !walks.includes('walk') };
    }
  }
  const dry = atmosphere.rain < 0.1 && atmosphere.snowfall < 0.1, light = { day: 1, dawn: 0.8, sunset: 0.4, night: 0 }[atmosphere.time.id];
  ambience.update(dt, {
    active: driving, speed: Math.abs(car.vf), wet: atmosphere.wet, inside, cars: heard.cars, sea: heard.sea,
    birds: dry && !tunnel ? light * (atmosphere.weather.id === 'fog' ? 0.4 : 1) : 0, crossing: tunnel ? null : heard.crossing,
  });
  // the wipers: one swish each way
  if (inside && driving) {
    if (heard.wiping && !glass.resting) ambience.wipe();
    if (heard.stroke < 0.5 && glass.phase >= 0.5) ambience.wipe();
  }
  heard.wiping = glass.resting;
  heard.stroke = glass.phase;
  // a storm: now and then lightning, and the thunder after it
  if (atmosphere.weather.id === 'rain' && atmosphere.rain > 0.8 && !tunnel) {
    heard.storm -= dt;
    if (heard.storm <= 0) {
      heard.storm = 14 + Math.random() * 30;
      const near = Math.random();
      atmosphere.lightning();
      if (driving) setTimeout(() => ambience.thunder(near), 300 + (1 - near) * 3500);
    }
  } else heard.storm = 6 + Math.random() * 10;
  spray.update(dt, car, driving ? atmosphere.wet : 0, {
    halfTrack: car.spec.W / 2 - 0.15, rear: car.spec.wheelbase / 2, tint: 0.25 + 0.75 * (1 - atmosphere.glow),
    scale: renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)),
  });
}

// ---------- what was saved last time ----------
if (TRAFFIC.some(t => t[0] === saved.traffic)) trafficLevel = saved.traffic;
for (const [id, set] of [['engine', v => { sound.volumes.engine = v; }], ['rain', v => { sound.volumes.rain = v; }], ['street', v => { ambience.volume = v; }], ['music', v => { radio.volume = v; }]]) {
  const v = saved.volumes?.[id];
  if (typeof v === 'number' && v >= 0 && v <= 1) { set(v); $(`#vol-${id}`).value = Math.round(v * 100); }
}
if (saved.goal) guide.set(saved.goal);
{
  // back where the car was left, if that is still a place on a road of this map
  const at = saved.at, m = world.map;
  // (its height tells the underpass from the street over it; without one it is put on top)
  const y = at && Number.isFinite(at.y) ? at.y : undefined;
  if (at && [at.x, at.z, at.heading].every(Number.isFinite) && at.x > m.x0 + 10 && at.x < m.x1 - 10 && at.z > m.z0 + 10 && at.z < m.z1 - 10 && world.roadAt(at.x, at.z, 12, y)) {
    try {
      await world.prepare(at.x, at.z);
      const heading = Math.atan2(Math.sin(at.heading), Math.cos(at.heading));
      car.reset(at.x, at.z, heading);
      car.y = world.surface(at.x, at.z, y);
      car.placed = y !== undefined;
      camYaw = heading;
    } catch (error) { console.warn('could not go back to the saved place', error); }
  }
}
renderMenu();
renderPlaces();

const camVelocity = new THREE.Vector3(), camBefore = new THREE.Vector3();
let last = performance.now();
renderer.setAnimationLoop(now => {
  watchFrameRate((now - last) / 1000);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (state === 'drive') update(dt, readInput());
  const blinking = car.blinkOn;
  car.sync(dt, lights, atmosphere.glow, atmosphere.wet);
  if (car.blinkOn !== blinking && state === 'drive') sound.tick(car.blinkOn);
  world.update(now / 1000);
  if (state !== 'photo') updateTraffic(dt);         // a photograph is of a moment: the street holds still
  world.stream(car.x, car.z);
  camBefore.copy(camera.position);
  updateCamera(dt);
  camVelocity.copy(camera.position).sub(camBefore).divideScalar(Math.max(dt, 1e-3)).clampLength(0, 80);
  const inside = state === 'drive' && view === 'cockpit', falling = Math.max(atmosphere.rain, atmosphere.snowfall);
  atmosphere.update(dt, car.mesh.position, camVelocity, inside);
  const [top, bottom] = inside ? car.vis.screen.map(p => (1 - car.vis.chassis.localToWorld(eye.copy(p)).project(camera).y) / 2) : [0, 0];
  glass.update(dt, {
    visible: inside, amount: falling, snow: atmosphere.snowfall > atmosphere.rain, speed: Math.abs(car.vf),
    top: Math.max(0, top), bottom: Math.min(1, bottom),
  });
  if (state === 'drive') updateHud(dt);
  $('#hud').classList.toggle('in-car', inside && !hudAlways);
  const mirrors = inside && !!quality.mirrors;
  if (mirrors !== mirrorsLive) { car.vis.interior.setMirrors(mirrorsLive = mirrors); frames = 0; }
  {
    const time = new Date();
    car.vis.interior.update({
      inside,
      kmh: Math.round(Math.abs(car.vf) * 3.6), rpm: car.rpm, gear: car.reverse ? 'R' : `D${car.gear + 1}`,
      clock: `${time.getHours()}:${String(time.getMinutes()).padStart(2, '0')}`,
      blinkLeft: car.blinkOn && car.signal !== 'right', blinkRight: car.blinkOn && car.signal !== 'left', signal: car.signal,
      lights, wiping: falling > 0.05, dark: atmosphere.glow, sky: $('#sky-chip').textContent,
      station: $('#radio-station').textContent, track: $('#radio-track').textContent,
      road: hud.road.textContent, limit: hud.limit.textContent, minimap: $('#minimap'),
    });
    if (mirrors && frames++ % quality.mirrors.every === 0) renderMirror();
  }
  sound.update(car.rpm, car.throttle, Math.abs(car.vf), state === 'drive');
  sound.setRain(state === 'drive' ? atmosphere.rain : atmosphere.rain * 0.4, inside);
  updateAmbience(dt, inside);
  radio.update(inside, tunnel ? 0.15 : 1, true);
  world.lightLamps(car.x, car.z, dt);
  if (quality.reflections && atmosphere.wet > 0.02) reflection.render(camera, car.y + 0.03, [...world.unmirrored, ...atmosphere.particles, car.vis.beam]);
  bloom.strength = quality.bloom ? 0.28 * atmosphere.glow : 0;
  if (bloom.strength > 0.02) composer.render(); else renderer.render(scene, camera);
  if (photo.shoot && state === 'photo') {
    // the picture just drawn, saved as a file (it has to be taken before the browser shows the frame)
    photo.shoot = false;
    renderer.domElement.toBlob(blob => {
      if (!blob) return;
      const link = document.createElement('a'), t = new Date(), two = n => String(n).padStart(2, '0');
      link.href = URL.createObjectURL(blob);
      link.download = `haeundae-drive-${t.getFullYear()}${two(t.getMonth() + 1)}${two(t.getDate())}-${two(t.getHours())}${two(t.getMinutes())}${two(t.getSeconds())}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10000);
      toast('사진을 저장했습니다');
    }, 'image/png');
  }
});

// Handle for automated checks: runs the simulation without rendering. input(t) returns the controls at time t.
window.__game = {
  crowd: null,                                // a number here overrides how many people are about, for measuring
  pose: null,                                 // { angle, dist, height, fov }: holds the menu camera still, for pictures of the car
  readyMs: Math.round(performance.now()),     // time from opening the page to being playable
  world, scene, camera, renderer, setState, setQuality, get quality() { return `${qualityChoice}:${qualityLevel}`; }, selectCar, setSky, atmosphere, radio, sound, ambience, spray, heard, guide, photo, save, get state() { return state; },
  get car() { return car; },
  setView(next) { view = next; },
  traffic, trafficView, setTraffic, people, peopleView,
  simulate(seconds, input, dt = 1 / 60) {
    brakeForPeople = 0;               // people are not stepped here, so there is nobody to brake for
    for (let t = 0; t < seconds; t += dt) update(dt, input(t, car));
  },
};
