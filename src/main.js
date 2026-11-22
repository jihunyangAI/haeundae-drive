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
const camera = new THREE.PerspectiveCamera(60, 1, 0.2, 9000);

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
const trafficView = createTrafficView(world.trafficKit, scene, world.ground);
const people = createPeople(world.walks, { signalOf: world.signalAt });
const peopleView = createPeopleView(scene, world.ground);
let peopleFilled = false, brakeForPeople = 0;
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
  const crowd = Math.round(quality.people * Math.min(1, level * 2) * out);
  frustum.setFromProjectionMatrix(viewMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const player = { x: car.x, z: car.z, vx: car.vx, vz: car.vz };
  brakeForPeople = people.step(Math.min(dt, 0.1), {
    focus: car, want: crowd, cars: traffic.cars, player, hidden: outOfSight, near: peopleFilled ? 45 : 14, wet: Math.max(atmosphere.rain, atmosphere.snowfall), stops: world.stops,
  });
  if (people.people.length >= crowd * 0.8) peopleFilled = true;
  peopleView.sync(people.people);
  if (!want && !traffic.cars.length) { trafficView.sync([], { lights: false, time: 0 }); return; }
  // the streets start out populated: the first cars may appear closer than later ones
  traffic.step(Math.min(dt, 0.1), { focus: car, want, player, hidden: outOfSight, near: trafficFilled ? 90 : 35, people: people.people });
  if (traffic.cars.length >= want * 0.8) trafficFilled = true;
  for (const e of traffic.events.splice(0)) if (e.type === 'honk') sound.honk(Math.max(0, 1 - Math.hypot(e.x - car.x, e.z - car.z) / 60));
  trafficView.sync(traffic.cars, { lights: atmosphere.wantsLights, time: traffic.time });
}
// everything the player's car can run into: the fixed world and the other cars
const solids = { query(x, z, r, cb) { world.query(x, z, r, cb); traffic.query(x, z, r, cb); people.query(x, z, r, cb); } };

// ---------- car ----------
const spawn = world.spawnOn(START_STREET);
let carIndex = 1, colorIndex = 0, car = null;

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
  low: { name: '낮음', pixels: 1, shadows: 0, particles: 0.5, bloom: false, lampLights: 0, reflections: false, mirrors: null, traffic: 8, people: 0 },
  medium: { name: '보통', pixels: 1.5, shadows: 2048, particles: 0.75, bloom: true, lampLights: 4, reflections: false, mirrors: { width: 320, every: 4 }, traffic: 20, people: 30 },
  high: { name: '높음', pixels: 2, shadows: 4096, particles: 1, bloom: true, lampLights: 6, reflections: true, mirrors: { width: 640, every: 2 }, traffic: 40, people: 80 },
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
$('#quality-list').addEventListener('click', e => e.target.dataset.quality && setQuality(e.target.dataset.quality));
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

// One simulation step: controls, physics at 240 Hz, collisions, ground following.
function update(dt, inp) {
  const g = world.ground;
  car.gx = (g(car.x + 1, car.z) - g(car.x - 1, car.z)) / 2;
  car.gz = (g(car.x, car.z + 1) - g(car.x, car.z - 1)) / 2;
  car.control(dt, inp);
  // someone on foot right ahead: the car brakes by itself, whatever the driver is doing
  if (!car.reverse && (brakeForPeople === 2 || brakeForPeople === 1 && Math.abs(car.vf) > 4)) { car.throttle = 0; car.brake = 1; }
  sound.horn(!!inp.horn);
  const n = Math.max(1, Math.ceil(dt * 240));
  for (let i = 0; i < n; i++) car.step(dt / n, atmosphere.grip);
  car.collide(solids);
  car.y = world.surface(car.x, car.z);
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
  if (state === 'menu') {
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
  mini.setTransform(1, 0, 0, 1, MINI / 2, MINI / 2);
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
    const road = world.roadAt(car.x, car.z);
    tunnel = !!road?.road.tn;
    hud.limit.textContent = road ? road.limit : '–';
    hud.road.textContent = road?.name || (road ? '이름 없는 길' : '도로 밖');
    hud.limit.dataset.over = road && kmh > road.limit + 5 ? '1' : '';
  }
  drawMinimap();
}

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
$('#traffic-list').addEventListener('click', e => e.target.dataset.traffic && setTraffic(e.target.dataset.traffic));
$('#car-list').addEventListener('click', e => {
  const card = e.target.closest('[data-car]');
  if (!card) return;
  selectCar(Number(card.dataset.car));
  renderMenu();
});
$('#color-list').addEventListener('click', e => {
  if (e.target.dataset.color === undefined) return;
  colorIndex = Number(e.target.dataset.color);
  car.vis.setColour(COLORS[colorIndex]);
  renderMenu();
});

function setState(next) {
  state = next;
  $('#menu').classList.toggle('is-hidden', next !== 'menu');
  $('#hud').classList.toggle('is-hidden', next !== 'drive');
  if (next !== 'drive') sound.horn(false);
  look.drag = false;
  if (next === 'drive') {
    camYaw = car.heading;
    sound.start();
    radio.start(sound.ctx);
    document.activeElement?.blur();
  }
  keys.clear();
}
$('#start').addEventListener('click', () => setState('drive'));

// ---------- sound panel, own music, credits ----------
$('#vol-engine').addEventListener('input', e => { sound.volumes.engine = e.target.value / 100; });
$('#vol-rain').addEventListener('input', e => { sound.volumes.rain = e.target.value / 100; });
$('#vol-music').addEventListener('input', e => { radio.volume = e.target.value / 100; });
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
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  if (state === 'menu') {
    if (e.code === 'Enter') setState('drive');
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
  else if (e.code === 'KeyR') { car.reset(spawn.x, spawn.z, spawn.heading); camYaw = spawn.heading; }
  else if (e.code === 'Escape') setState('menu');
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('mousedown', e => { if (state === 'drive' && e.button === 0 && !e.target.closest?.('button, a, input, .credits')) look.drag = true; });
addEventListener('mouseup', () => { look.drag = false; });
addEventListener('mousemove', e => {
  if (!(e.buttons & 1)) look.drag = false;      // the button was let go somewhere the page could not see
  if (!look.drag) return;
  look.yaw -= e.movementX * 0.004;
  look.pitch -= e.movementY * 0.003;
});
addEventListener('blur', () => { keys.clear(); sound.horn(false); look.drag = false; });
document.addEventListener('visibilitychange', () => { if (document.hidden) sound.horn(false); });

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
setQuality('auto');
setSky({ instant: true });

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
  updateTraffic(dt);
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
  radio.update(inside, tunnel ? 0.15 : 1, true);
  world.lightLamps(car.x, car.z, dt);
  if (quality.reflections && atmosphere.wet > 0.02) reflection.render(camera, car.y + 0.03, [...world.unmirrored, ...atmosphere.particles, car.vis.beam]);
  bloom.strength = quality.bloom ? 0.28 * atmosphere.glow : 0;
  if (bloom.strength > 0.02) composer.render(); else renderer.render(scene, camera);
});

// Handle for automated checks: runs the simulation without rendering. input(t) returns the controls at time t.
window.__game = {
  pose: null,                                 // { angle, dist, height, fov }: holds the menu camera still, for pictures of the car
  readyMs: Math.round(performance.now()),     // time from opening the page to being playable
  world, scene, camera, renderer, setState, setQuality, get quality() { return `${qualityChoice}:${qualityLevel}`; }, selectCar, setSky, atmosphere, radio, sound,
  get car() { return car; },
  setView(next) { view = next; },
  traffic, trafficView, setTraffic, people, peopleView,
  simulate(seconds, input, dt = 1 / 60) {
    brakeForPeople = 0;               // people are not stepped here, so there is nobody to brake for
    for (let t = 0; t < seconds; t += dt) update(dt, input(t, car));
  },
};
