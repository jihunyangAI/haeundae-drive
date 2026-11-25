import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

const rad = THREE.MathUtils.degToRad;
// Unit vector for an elevation above the horizon and a bearing, both in degrees.
// Bearing 0 is south (+Z), 90 east (+X), 270 west.
const aim = (elevation, bearing) => new THREE.Vector3().setFromSphericalCoords(1, rad(90 - elevation), rad(bearing));
const hex = c => new THREE.Color(c);
const FLASH = new THREE.Color(0xdfe6ff);

// sun: where the sun is drawn in the sky. light: where the main light comes from (the moon at night).
// windows / lamps: how much of the city is lit up, 0..1.
export const TIMES = [
  {
    id: 'dawn', name: '새벽', sun: aim(3, 72), light: aim(10, 72), lightColor: hex(0xffc7a1), lightPower: 2.2,
    skyLight: hex(0x9fb2d8), groundLight: hex(0x44464f), ambient: 2.0, turbidity: 3, rayleigh: 2.4, mie: 0.004,
    haze: hex(0xa7b3c9), overcast: hex(0x6d7686), exposure: 0.95, windows: 0.45, lamps: 1, pools: 0.22, stars: 0.12, rainTint: 0.55,
  },
  {
    id: 'day', name: '낮', sun: aim(50, 335), light: aim(50, 335), lightColor: hex(0xfff2dc), lightPower: 4.2,
    skyLight: hex(0xd6e6ff), groundLight: hex(0x5c574e), ambient: 1.5, turbidity: 4, rayleigh: 1.3, mie: 0.005,
    haze: hex(0xc3d9ec), overcast: hex(0x9da6ae), exposure: 0.55, windows: 0, lamps: 0, pools: 0, stars: 0, rainTint: 0.85,
  },
  {
    id: 'sunset', name: '노을', sun: aim(4, 288), light: aim(9, 288), lightColor: hex(0xff9858), lightPower: 3.0,
    skyLight: hex(0xc7b0c6), groundLight: hex(0x4c3f38), ambient: 1.9, turbidity: 7, rayleigh: 3.2, mie: 0.007,
    haze: hex(0xd5a685), overcast: hex(0x736c70), exposure: 0.9, windows: 0.4, lamps: 1, pools: 0.22, stars: 0, rainTint: 0.6,
  },
  {
    id: 'night', name: '밤', sun: aim(-16, 300), light: aim(52, 150), lightColor: hex(0x8ea6ff), lightPower: 0.32,
    skyLight: hex(0x2c3d6e), groundLight: hex(0x10121a), ambient: 0.5, turbidity: 2, rayleigh: 0.5, mie: 0.003,
    haze: hex(0x0a0f1d), overcast: hex(0x1c2028), exposure: 0.7, windows: 1, lamps: 1, pools: 0.5, stars: 1, rainTint: 0.3,
  },
];

// cover: how much of the sky is closed in. sun / ambient scale the time-of-day light. fog: [near, far] metres.
// expose: the eye opens up under a dull sky. grip: tyre friction relative to dry tarmac. wet / snow: what lies on the road.
export const WEATHERS = [
  { id: 'clear', name: '맑음', cover: 0, clouds: 0.18, sun: 1, ambient: 1, expose: 1, fog: [400, 3200], rain: 0, snowfall: 0, wet: 0, snow: 0, grip: 1 },
  { id: 'cloudy', name: '흐림', cover: 0.8, clouds: 0.9, sun: 0.22, ambient: 1.5, expose: 1.35, fog: [300, 2400], rain: 0, snowfall: 0, wet: 0, snow: 0, grip: 1 },
  { id: 'rain', name: '비', cover: 1, clouds: 1, sun: 0.07, ambient: 1.15, expose: 1.45, fog: [80, 1000], rain: 1, snowfall: 0, wet: 1, snow: 0, grip: 0.7 },
  { id: 'fog', name: '안개', cover: 0.92, clouds: 1, sun: 0.16, ambient: 1.5, expose: 1.3, fog: [6, 190], rain: 0, snowfall: 0, wet: 0.3, snow: 0, grip: 0.9 },
  { id: 'snow', name: '눈', cover: 1, clouds: 1, sun: 0.1, ambient: 1.6, expose: 1.15, fog: [50, 650], rain: 0, snowfall: 1, wet: 0.15, snow: 1, grip: 0.4 },
];

const NUMBERS = ['pools', 'lightPower', 'ambient', 'turbidity', 'rayleigh', 'mie', 'exposure', 'windows', 'lamps', 'stars',
  'cover', 'clouds', 'fogNear', 'fogFar', 'rain', 'snowfall', 'wet', 'snow', 'grip', 'rainTint'];
const VECTORS = ['sun', 'light', 'lightColor', 'skyLight', 'groundLight', 'haze', 'overcast'];

function blend(time, weather) {
  const s = {};
  for (const k of VECTORS) s[k] = time[k].clone();
  Object.assign(s, {
    lightPower: time.lightPower * weather.sun, ambient: time.ambient * weather.ambient,
    turbidity: time.turbidity, rayleigh: time.rayleigh, mie: time.mie, exposure: time.exposure * weather.expose,
    // on a dark, wet or foggy day the lamps come on and people switch their lights on early
    windows: Math.max(time.windows, weather.cover > 0.9 ? 0.25 : 0), lamps: Math.max(time.lamps, weather.cover > 0.9 ? 1 : 0),
    pools: Math.max(time.pools, weather.cover > 0.9 ? 0.1 : 0),
    stars: time.stars * (1 - weather.cover), cover: weather.cover, clouds: weather.clouds,
    fogNear: weather.fog[0], fogFar: weather.fog[1], rain: weather.rain, snowfall: weather.snowfall,
    wet: weather.wet, snow: weather.snow, grip: weather.grip, rainTint: time.rainTint,
  });
  s.skyLight.lerp(time.overcast, weather.cover * 0.7);
  s.haze.lerp(time.overcast, weather.cover);
  return s;
}

// ---------- falling rain and snow ----------
// Particles live in a box that follows the camera; positions wrap, so the same few thousand are reused.
const WRAP = `
  vec3 wrap(vec3 p) { return mod(p - uEye + uBox * 0.5, uBox) - uBox * 0.5 + uEye; }
  float near(float depth, vec3 p) {
    return smoothstep(uNear, uNear + 1.2, depth) * (1.0 - smoothstep(uBox.x * 0.36, uBox.x * 0.5, distance(p, uEye)));
  }`;

function scatter(count, box, copies) {
  const data = new Float32Array(count * copies * 3);
  for (let i = 0; i < count; i++) {
    const x = Math.random() * box.x, y = Math.random() * box.y, z = Math.random() * box.z;
    for (let c = 0; c < copies; c++) data.set([x, y, z], (i * copies + c) * 3);
  }
  return new THREE.BufferAttribute(data, 3);
}

function makeRain() {
  const box = new THREE.Vector3(44, 26, 44), count = 7000;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', scatter(count, box, 2));
  const tail = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) tail[i * 2 + 1] = 1;
  geo.setAttribute('tail', new THREE.BufferAttribute(tail, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: {
      uEye: { value: new THREE.Vector3() }, uBox: { value: box }, uFall: { value: new THREE.Vector3(1.5, -15, 0.6) },
      uStreak: { value: new THREE.Vector3() }, uShift: { value: new THREE.Vector3() }, uNear: { value: 0 }, uAmount: { value: 0 }, uTint: { value: 1 },
    },
    vertexShader: `
      uniform vec3 uEye, uBox, uShift, uStreak;
      uniform float uNear;
      attribute float tail;
      varying float vAlpha;
      ${WRAP}
      void main() {
        vec3 p = wrap(position + uShift) + uStreak * tail;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        vAlpha = (1.0 - tail * 0.8) * near(-mv.z, p);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float uAmount, uTint;
      varying float vAlpha;
      void main() { gl_FragColor = vec4(vec3(0.8, 0.86, 0.95) * uTint, vAlpha * uAmount * 0.5); }`,
  });
  const mesh = new THREE.LineSegments(geo, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  return mesh;
}

function makeSnow() {
  const box = new THREE.Vector3(36, 22, 36);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', scatter(6000, box, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: {
      uEye: { value: new THREE.Vector3() }, uBox: { value: box }, uFall: { value: new THREE.Vector3(0.5, -1.7, 0.2) }, uShift: { value: new THREE.Vector3() },
      uTime: { value: 0 }, uNear: { value: 0 }, uAmount: { value: 0 }, uTint: { value: 1 }, uScale: { value: 600 },
    },
    vertexShader: `
      uniform vec3 uEye, uBox, uShift;
      uniform float uTime, uNear, uScale;
      varying float vAlpha;
      ${WRAP}
      void main() {
        vec3 drift = vec3(sin(uTime * 0.9 + position.y * 2.3), 0.0, cos(uTime * 0.7 + position.x * 1.9)) * 0.35;
        vec3 p = wrap(position + uShift + drift);
        vec4 mv = viewMatrix * vec4(p, 1.0);
        vAlpha = near(-mv.z, p);
        gl_PointSize = clamp(0.055 * uScale / -mv.z, 1.0, 14.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float uAmount, uTint;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        gl_FragColor = vec4(vec3(uTint), smoothstep(0.5, 0.15, d) * vAlpha * uAmount * 0.9);
      }`,
  });
  const mesh = new THREE.Points(geo, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  return mesh;
}

// Sky, light, fog and precipitation for a weather and a time of day. Changes ease in over a few seconds.
export function createAtmosphere({ renderer, scene, camera, world }) {
  scene.fog = new THREE.Fog(0xc3d9ec, 400, 3200);

  const sky = new Sky();
  sky.scale.setScalar(100000);
  const U = sky.material.uniforms;
  U.cloudDensity.value = 0.5;
  scene.add(sky);

  // closed-in sky for overcast weather: a tinted dome in front of the clear-sky shader
  const domeGeo = new THREE.SphereGeometry(1, 24, 12), shade = [];
  for (let i = 0; i < domeGeo.attributes.position.count; i++) {
    const v = 1 - 0.28 * Math.max(0, domeGeo.attributes.position.getY(i));   // darker overhead
    shade.push(v, v, v);
  }
  domeGeo.setAttribute('color', new THREE.Float32BufferAttribute(shade, 3));
  const domeMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, transparent: true, opacity: 0, fog: false, depthWrite: false });
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.scale.setScalar(8000);
  dome.renderOrder = -1;
  dome.frustumCulled = false;

  const starPos = [];
  for (let i = 0; i < 1400; i++) {
    const v = new THREE.Vector3().randomDirection();
    v.y = Math.abs(v.y) * 0.95 + 0.05;
    v.normalize().multiplyScalar(7500);
    starPos.push(v.x, v.y, v.z);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
  const starMat = new THREE.PointsMaterial({ color: 0xdfe8ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false });
  const stars = new THREE.Points(starGeo, starMat);
  stars.renderOrder = -2;
  stars.frustumCulled = false;

  const hemi = new THREE.HemisphereLight(0xd6e6ff, 0x5c574e, 1.5);
  const sun = new THREE.DirectionalLight(0xfff2dc, 4.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -160, right: 160, top: 160, bottom: -160, near: 10, far: 1400 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.06;

  const rain = makeRain(), snow = makeSnow();
  scene.add(dome, stars, hemi, sun, sun.target, rain, snow);

  // Reflections come from the sky itself, re-captured whenever it changes.
  const pmrem = new THREE.PMREMGenerator(renderer), envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(sky.geometry, sky.material), envDome = new THREE.Mesh(domeGeo, domeMat);
  envSky.scale.setScalar(100000);
  envDome.scale.setScalar(60);
  envScene.add(envSky, envDome);
  let envTarget = null, envAge = 0;
  function captureEnvironment() {
    U.showSunDisc.value = 0;                     // the sun is already a light; its disc would only add glare
    const next = pmrem.fromScene(envScene, 0, 0.1, 200);
    U.showSunDisc.value = 1;
    scene.environment = next.texture;
    envTarget?.dispose();
    envTarget = next;
    envAge = 0;
  }

  let timeIndex = 1, weatherIndex = 0;
  let goal = blend(TIMES[timeIndex], WEATHERS[weatherIndex]);
  const now = blend(TIMES[timeIndex], WEATHERS[weatherIndex]);
  let clock = 0, moving = true, skyMoving = true, ground = { wet: 0, snow: 0 }, flash = 0, flashed = false;

  function apply() {
    U.sunPosition.value.copy(now.sun);
    U.turbidity.value = now.turbidity;
    U.rayleigh.value = now.rayleigh;
    U.mieCoefficient.value = now.mie;
    U.cloudCoverage.value = now.clouds * 0.75;
    domeMat.color.copy(now.overcast);
    domeMat.opacity = now.cover;
    starMat.opacity = now.stars;
    stars.visible = now.stars > 0.01;
    dome.visible = now.cover > 0.01;
    sun.color.copy(now.lightColor);
    sun.intensity = now.lightPower;
    hemi.color.copy(now.skyLight);
    hemi.groundColor.copy(now.groundLight);
    hemi.intensity = now.ambient;
    scene.fog.color.copy(now.haze);
    scene.fog.near = now.fogNear;
    scene.fog.far = now.fogFar;
    scene.environmentIntensity = 0.06;      // the sky shader works in far larger numbers than the lights
    renderer.toneMappingExposure = now.exposure;
    rain.visible = now.rain > 0.01;
    snow.visible = now.snowfall > 0.01;
    rain.material.uniforms.uAmount.value = now.rain;
    rain.material.uniforms.uTint.value = now.rainTint;
    snow.material.uniforms.uAmount.value = now.snowfall;
    snow.material.uniforms.uTint.value = 0.35 + 0.65 * now.rainTint;
    world.setConditions({
      windows: now.windows, lamps: THREE.MathUtils.smoothstep(now.lamps, 0.25, 0.6), pools: now.pools, wet: ground.wet, snow: ground.snow,
      haze: now.haze, far: now.fogFar,
    });
  }

  function ease(k, kGround) {
    let gap = 0;
    for (const key of NUMBERS) {
      gap = Math.max(gap, Math.abs(goal[key] - now[key]) / (Math.abs(goal[key]) + 1));
      now[key] += (goal[key] - now[key]) * k;
    }
    for (const key of VECTORS) {
      if (now[key].isColor) now[key].lerp(goal[key], k); else now[key].lerp(goal[key], k).normalize();
    }
    // rain soaks in and snow settles more slowly than the sky changes
    const groundGap = Math.max(Math.abs(goal.wet - ground.wet), Math.abs(goal.snow - ground.snow));
    ground.wet += (goal.wet - ground.wet) * kGround;
    ground.snow += (goal.snow - ground.snow) * kGround;
    return [gap, groundGap];
  }

  const api = {
    sky, sun,
    get time() { return TIMES[timeIndex]; },
    get weather() { return WEATHERS[weatherIndex]; },
    get grip() { return now.grip; },
    get rain() { return now.rain; },
    get snowfall() { return now.snowfall; },
    get wet() { return ground.wet; },
    particles: [rain, snow],
    // Lightning: the whole sky lights up for a moment, twice in quick succession.
    lightning() { flash = 0.5; },
    // shadows: side of the shadow map in pixels, 0 for none. particles: share of the rain and snow drawn, 0..1.
    setQuality({ shadows, particles }) {
      sun.castShadow = shadows > 0;
      if (shadows > 0 && sun.shadow.mapSize.x !== shadows) {
        sun.shadow.mapSize.set(shadows, shadows);
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
      }
      rain.geometry.setDrawRange(0, Math.round(rain.geometry.attributes.position.count / 2 * particles) * 2);
      snow.geometry.setDrawRange(0, Math.round(snow.geometry.attributes.position.count * particles));
    },
    get glow() { return Math.max(now.windows, now.lamps * 0.6); },     // how much the scene relies on its own lights
    // headlights are needed in the dark and in anything that cuts visibility
    get wantsLights() { const t = TIMES[timeIndex], w = WEATHERS[weatherIndex]; return t.lamps > 0 || w.cover > 0.9; },

    // Pick a weather and/or time by id. `instant` skips the transition.
    set({ weather, time, instant = false } = {}) {
      if (time !== undefined) timeIndex = Math.max(0, TIMES.findIndex(t => t.id === time));
      if (weather !== undefined) weatherIndex = Math.max(0, WEATHERS.findIndex(w => w.id === weather));
      goal = blend(TIMES[timeIndex], WEATHERS[weatherIndex]);
      moving = skyMoving = true;
      if (instant) {
        ease(1, 1);
        apply();
        captureEnvironment();
        moving = skyMoving = false;
      }
    },

    // focus: the point the shadows follow. velocity: camera motion, so rain streaks lean with speed.
    update(dt, focus, velocity, inside) {
      clock += dt;
      if (moving) {
        const [skyGap, groundGap] = ease(1 - Math.exp(-dt * 1.6), 1 - Math.exp(-dt * 0.5));
        apply();
        // reflections only need re-capturing while the sky itself is still changing
        if (skyMoving) {
          envAge += dt;
          if (skyGap < 0.004) skyMoving = false;
          if (!skyMoving || envAge > 0.25) captureEnvironment();
        }
        if (!skyMoving && groundGap < 0.004) {
          ease(1, 1);
          apply();
          moving = false;
        }
      }
      if (flash > 0) {
        flash -= dt;
        // two flickers: a bright one and a weaker echo
        const k = Math.max(0, flash > 0.3 ? (flash - 0.3) / 0.2 : flash > 0.18 ? 0 : flash / 0.18 * 0.6);
        hemi.intensity = now.ambient + k * 9;
        domeMat.color.copy(now.overcast).lerp(FLASH, k * 0.8);
        scene.fog.color.copy(now.haze).lerp(FLASH, k * 0.5);
        flashed = true;
      } else if (flashed) {
        flashed = false;
        apply();
      }
      U.time.value = clock * 40;
      dome.position.copy(camera.position);
      stars.position.copy(camera.position);
      sun.target.position.copy(focus);
      sun.position.copy(focus).addScaledVector(now.light, 600);

      for (const fall of [rain, snow]) {
        if (!fall.visible) continue;
        const u = fall.material.uniforms;
        u.uEye.value.copy(camera.position);
        // how far everything has fallen, kept inside one box so the numbers stay small however long the drive
        const f = u.uFall.value, b = u.uBox.value;
        u.uShift.value.set((f.x * clock) % b.x, (f.y * clock) % b.y, (f.z * clock) % b.z);
        if (u.uTime) u.uTime.value = clock % 3600;
        u.uNear.value = inside ? 2.6 : 0;      // keep it out of the cabin
      }
      // a streak is the drop's path during one exposure, as seen from the moving camera
      rain.material.uniforms.uStreak.value.copy(rain.material.uniforms.uFall.value).sub(velocity).multiplyScalar(-0.035);
      snow.material.uniforms.uScale.value = renderer.domElement.height / (2 * Math.tan(rad(camera.fov) / 2));
    },
  };
  ease(1, 1);
  apply();
  captureEnvironment();
  moving = false;
  return api;
}
