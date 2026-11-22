import * as THREE from 'three';

// Dimensions in metres, mass in kg. `shape` is the side profile, measured along
// the car's length from the body centre (+ is towards the nose).
export const CARS = [
  {
    id: 'hatch', name: '시티 해치백', tag: '가볍고 다루기 쉬운 전륜구동',
    mass: 1150, powerKW: 85, drive: 'FWD', frontWeight: 0.61,
    L: 3.95, W: 1.74, H: 1.5, wheelbase: 2.55, wheelR: 0.31, gc: 0.2, cgH: 0.54,
    stiff: 11, rollK: 0.011, pitchK: 0.009,
    redline: 6500, gears: [3.6, 2.05, 1.37, 1.03, 0.82], final: 4.1, cd: 0.32, area: 2.1,
    shape: { noseH: 0.66, belt: 0.98, deckH: 0.96, aFront: 0.78, roofFront: 0.12, roofRear: -1.4, aRear: -1.82 },
  },
  {
    id: 'sedan', name: '비즈니스 세단', tag: '안정적이고 균형 잡힌 주행',
    mass: 1480, powerKW: 140, drive: 'FWD', frontWeight: 0.58,
    L: 4.7, W: 1.84, H: 1.45, wheelbase: 2.8, wheelR: 0.33, gc: 0.2, cgH: 0.55,
    stiff: 12, rollK: 0.009, pitchK: 0.008,
    redline: 6500, gears: [3.5, 2.1, 1.45, 1.1, 0.88, 0.72], final: 3.7, cd: 0.28, area: 2.2,
    shape: { noseH: 0.66, belt: 1.0, deckH: 0.98, aFront: 0.95, roofFront: 0.22, roofRear: -0.95, aRear: -1.62 },
  },
  {
    id: 'sport', name: '스포츠 쿠페', tag: '강력한 후륜구동, 섬세한 조작 필요',
    mass: 1450, powerKW: 260, drive: 'RWD', frontWeight: 0.5,
    L: 4.45, W: 1.9, H: 1.27, wheelbase: 2.6, wheelR: 0.34, gc: 0.16, cgH: 0.46,
    stiff: 14, rollK: 0.005, pitchK: 0.005,
    redline: 7500, gears: [3.2, 2.1, 1.5, 1.15, 0.92, 0.75], final: 3.6, cd: 0.3, area: 2.0,
    shape: { noseH: 0.58, belt: 0.86, deckH: 0.84, aFront: 0.5, roofFront: -0.2, roofRear: -0.85, aRear: -1.75 },
  },
  {
    id: 'suv', name: '패밀리 SUV', tag: '높은 시야, 묵직한 사륜구동',
    mass: 2000, powerKW: 185, drive: 'AWD', frontWeight: 0.55,
    L: 4.75, W: 1.93, H: 1.72, wheelbase: 2.85, wheelR: 0.37, gc: 0.27, cgH: 0.68,
    stiff: 10, rollK: 0.016, pitchK: 0.012,
    redline: 6000, gears: [3.8, 2.2, 1.5, 1.12, 0.9, 0.74], final: 3.9, cd: 0.36, area: 2.7,
    shape: { noseH: 0.88, belt: 1.18, deckH: 1.14, aFront: 1.0, roofFront: 0.42, roofRear: -1.85, aRear: -2.2 },
  },
];

export const COLORS = [0xc8102e, 0xf2f2f2, 0x1b1d21, 0x1f4fa8, 0x8a9199, 0xe8a317, 0x1e5c3a];

// Extrude a side profile across the car's width, centred, with length along +Z.
function extrude(shape, width, bevel) {
  const depth = width - 2 * bevel;
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: 0.05, bevelOffset: -0.05,
    bevelSegments: 3, curveSegments: 14,
  });
  geo.translate(0, 0, -depth / 2);
  geo.rotateY(-Math.PI / 2);
  return geo;
}

// Returns a car whose root origin is the centre of gravity projected on the
// ground, facing +Z, with +X to the driver's left.
export function buildCarMesh(spec, color) {
  const s = spec.shape, hl = spec.L / 2, R = spec.wheelR, gc = spec.gc, W = spec.W, H = spec.H;
  const a = spec.wheelbase * (1 - spec.frontWeight), b = spec.wheelbase * spec.frontWeight;
  const AX = 0.03, fz = AX + spec.wheelbase / 2, rz = AX - spec.wheelbase / 2, ra = R + 0.07;
  const centerZ = (a - b) / 2 - AX;

  const paint = new THREE.MeshPhysicalMaterial({ color, metalness: 0.55, roughness: 0.38, clearcoat: 1, clearcoatRoughness: 0.08 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0b1016, metalness: 0.5, roughness: 0.08 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.85 });
  const tire = new THREE.MeshStandardMaterial({ color: 0x101113, roughness: 0.9 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xb9bec4, metalness: 0.9, roughness: 0.3 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff1d6, emissiveIntensity: 0.3 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x5a0a0a, emissive: 0xff1a10, emissiveIntensity: 0.4 });

  const root = new THREE.Group();
  const chassis = new THREE.Group();
  const body = new THREE.Group();
  body.position.z = centerZ;
  chassis.add(body);
  root.add(chassis);

  const add = (geo, mat, x, y, z, parent = body) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  };

  // lower body with wheel arches
  const sh = new THREE.Shape();
  sh.moveTo(-hl, gc + 0.18);
  sh.lineTo(-hl + 0.12, gc);
  for (const cz of [rz, fz]) {
    sh.lineTo(cz - ra, gc);
    sh.lineTo(cz - ra, R);
    sh.absarc(cz, R, ra, Math.PI, 0, true);
    sh.lineTo(cz + ra, gc);
  }
  sh.lineTo(hl - 0.12, gc);
  sh.lineTo(hl, gc + 0.18);
  sh.lineTo(hl, s.noseH);
  sh.lineTo(hl - 0.22, s.noseH + 0.14);
  sh.lineTo(s.aFront, s.belt);
  sh.lineTo(s.aRear, s.belt);
  sh.lineTo(-hl + 0.1, s.deckH);
  sh.lineTo(-hl, s.deckH - 0.1);
  sh.closePath();
  add(extrude(sh, W, 0.07), paint, 0, 0, 0);

  // greenhouse
  const Wc = W - 0.22;
  const cab = new THREE.Shape();
  cab.moveTo(s.aRear, s.belt - 0.03);
  cab.lineTo(s.aFront, s.belt - 0.03);
  cab.lineTo(s.roofFront, H);
  cab.lineTo(s.roofRear, H);
  cab.closePath();
  add(extrude(cab, Wc, 0.06), glass, 0, 0, 0);

  const roofLen = s.roofFront - s.roofRear, roofMid = (s.roofFront + s.roofRear) / 2;
  add(new THREE.BoxGeometry(Wc - 0.08, 0.05, roofLen + 0.1), paint, 0, H + 0.005, roofMid);
  for (const side of [-1, 1]) {
    add(new THREE.BoxGeometry(0.05, H - s.belt, 0.1), paint, side * (Wc / 2 - 0.015), (H + s.belt) / 2, roofMid);
  }

  // underbody (also hides the far-side wheel arches) and interior
  add(new THREE.BoxGeometry(W - 0.5, 0.42, spec.L - 0.5), dark, 0, gc + 0.23, 0);
  add(new THREE.BoxGeometry(Wc - 0.05, 0.02, s.aFront - s.aRear - 0.1), dark, 0, s.belt, (s.aFront + s.aRear) / 2);
  add(new THREE.BoxGeometry(Wc - 0.05, 0.14, 0.6), dark, 0, s.belt - 0.03, s.aFront - 0.3);
  const column = new THREE.Group();
  column.position.set(0.36, s.belt - 0.03, s.aFront - 0.6);
  column.rotation.x = -0.35;
  body.add(column);
  const steeringWheel = new THREE.Group();
  column.add(steeringWheel);
  add(new THREE.TorusGeometry(0.17, 0.018, 8, 24), dark, 0, 0, 0, steeringWheel);
  add(new THREE.BoxGeometry(0.33, 0.03, 0.02), dark, 0, 0, 0, steeringWheel);

  // lights and grille
  const lx = W / 2 - 0.32;
  for (const side of [-1, 1]) {
    add(new THREE.BoxGeometry(0.34, 0.11, 0.05), headMat, side * lx, s.noseH - 0.1, hl + 0.01);
    add(new THREE.BoxGeometry(0.36, 0.1, 0.05), tailMat, side * lx, s.deckH - 0.24, -hl - 0.01);
  }
  add(new THREE.BoxGeometry(W * 0.45, 0.14, 0.04), dark, 0, gc + 0.3, hl + 0.005);

  const spots = [];
  for (const side of [-1, 1]) {
    const spot = new THREE.SpotLight(0xfff1d6, 0, 110, 0.55, 0.7, 1.6);
    spot.position.set(side * lx, s.noseH - 0.1, hl - 0.1);
    spot.target.position.set(side * lx * 0.5, -0.5, hl + 30);
    body.add(spot, spot.target);
    spots.push(spot);
  }

  // The light the headlamps throw on the road: a glowing patch laid on the ground ahead. The spot
  // lights above reach walls and trees, but at such a shallow angle they barely show on tarmac.
  const beamCanvas = document.createElement('canvas');
  beamCanvas.width = 128;
  beamCanvas.height = 256;
  const bg = beamCanvas.getContext('2d');
  for (let row = 0; row < 256; row++) {      // the car is at the bottom of the picture
    const t = 1 - row / 255;                 // 0 at the bumper, 1 at the far end
    const strength = Math.min(1, t / 0.05) * (1 - t) ** 1.7, spread = 0.16 + 0.34 * t;
    const across = bg.createLinearGradient(0, 0, 128, 0);
    across.addColorStop(Math.max(0, 0.5 - spread), 'rgba(255,255,255,0)');
    across.addColorStop(0.5 - spread * 0.45, `rgba(255,255,255,${strength * 0.75})`);
    across.addColorStop(0.5, `rgba(255,255,255,${strength})`);
    across.addColorStop(0.5 + spread * 0.45, `rgba(255,255,255,${strength * 0.75})`);
    across.addColorStop(Math.min(1, 0.5 + spread), 'rgba(255,255,255,0)');
    bg.fillStyle = across;
    bg.fillRect(0, row, 128, 1);
  }
  const beamMat = new THREE.MeshBasicMaterial({
    map: new THREE.CanvasTexture(beamCanvas), color: 0xfff0d2, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -16, polygonOffsetUnits: -64,
  });
  const beam = new THREE.Mesh(new THREE.PlaneGeometry(18, 46).rotateX(-Math.PI / 2).rotateY(Math.PI), beamMat);
  beam.position.set(0, 0.26, centerZ + hl + 22.6);
  beam.renderOrder = 2;
  root.add(beam);

  // wheels sit on the root so they stay planted while the chassis rolls
  const wheels = [];
  const tireGeo = new THREE.CylinderGeometry(R, R, 0.22, 24).rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(R * 0.62, R * 0.62, 0.226, 16).rotateZ(Math.PI / 2);
  const spokeGeo = new THREE.BoxGeometry(0.232, R * 1.15, 0.06);
  for (const [z, front] of [[a, true], [-b, false]]) {
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * (W / 2 - 0.13), R, z);
      const spin = new THREE.Group();
      pivot.add(spin);
      add(tireGeo, tire, 0, 0, 0, spin);
      add(rimGeo, rimMat, 0, 0, 0, spin);
      add(spokeGeo, dark, 0, 0, 0, spin);
      add(spokeGeo, dark, 0, 0, 0, spin).rotation.x = Math.PI / 2;
      root.add(pivot);
      wheels.push({ pivot, spin, front });
    }
  }

  const eye = new THREE.Vector3(0.36, s.belt + 0.27, centerZ + s.roofFront - 0.45);
  // top and bottom edge of the windscreen in front of the driver, in chassis space
  const screen = [new THREE.Vector3(0.36, H, centerZ + s.roofFront), new THREE.Vector3(0.36, s.belt + 0.05, centerZ + s.aFront)];
  return { root, chassis, wheels, paint, headMat, tailMat, beamMat, beam, spots, steeringWheel, eye, screen, centerZ };
}
