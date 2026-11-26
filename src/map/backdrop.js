import * as THREE from 'three';

// What stands beyond the edge of the map, as shapes against the sky: Jangsan to the north and the
// Gwangan bridge across the bay to the south-west. Nothing here can be reached, and the hills are
// placed so that even their spreading feet stay outside the map. They are too far for
// the fog of the scene to be worked out per pixel, so their colour is set whole (see `tint`).

const BRIDGE = { from: [-1500, 600], to: [-5300, 2750], deck: 32, tower: 112, towersAt: [0.4, 0.5], pierEvery: 220 };

function mountain(cx, cz, radius, height, seed) {
  const geo = new THREE.ConeGeometry(radius, height, 18, 5, true), pos = geo.attributes.position;
  let s = seed;
  const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  // The cone comes as rings of AROUND + 1 points, the first and last of a ring being the same place
  // (and the whole top ring being the summit): what is done to one must be done to its twin.
  const AROUND = 18, shifts = new Map();
  const shift = (row, col) => {
    const key = row * 100 + (row === 0 ? 0 : col % AROUND);
    if (!shifts.has(key)) shifts.set(key, [rand(), rand()]);
    return shifts.get(key);
  };
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) + height / 2, k = 1 - y / height;                   // k: 0 at the top, 1 at the foot
    const [a, b] = shift(Math.floor(i / (AROUND + 1)), i % (AROUND + 1));
    const push = 1 + (a - 0.5) * 0.5 * k + 0.35 * k * k;                       // spreading, uneven slopes
    pos.setXYZ(i, pos.getX(i) * push, y * (0.8 + b * 0.25 * (1 - k * 0.5)), pos.getZ(i) * push);
  }
  geo.computeVertexNormals();
  return geo.translate(cx, -4, cz);
}

export function buildBackdrop() {
  const group = new THREE.Group();
  // (not tone-mapped: their colour is matched to the fog, which is mixed in after tone mapping)
  const land = new THREE.MeshBasicMaterial({ color: 0x4f6a52, fog: false, toneMapped: false }), steel = new THREE.MeshBasicMaterial({ color: 0x8b949c, fog: false, toneMapped: false });
  // (the hills north of the town, Jangsan among them, are in the map itself now: only what lies past its
  // northern and western edges is made up here)
  const hills = new THREE.Group();
  for (const [x, z, r, h, seed] of [[-7200, -6500, 2000, 420, 23], [2500, -12500, 2400, 520, 7], [7500, -12800, 2300, 450, 41], [-7400, 1200, 2100, 400, 57]]) {
    hills.add(new THREE.Mesh(mountain(x, z, r, h, seed), land));
  }

  // the bridge: a deck on piers, two towers and the cables hung between them
  const bridge = new THREE.Group(), [ax, az] = BRIDGE.from, [bx, bz] = BRIDGE.to, len = Math.hypot(bx - ax, bz - az);
  const ux = (bx - ax) / len, uz = (bz - az) / len, heading = Math.atan2(ux, uz), at = t => [ax + (bx - ax) * t, az + (bz - az) * t];
  const box = (w, h, d, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), steel); m.position.set(x, y, z); m.rotation.y = heading; bridge.add(m); };
  box(22, 9, len, ...[(ax + bx) / 2, BRIDGE.deck, (az + bz) / 2]);
  for (let s = BRIDGE.pierEvery / 2; s < len; s += BRIDGE.pierEvery) { const [x, z] = at(s / len); box(8, BRIDGE.deck, 6, x, BRIDGE.deck / 2, z); }
  const lights = [];
  const [t0, t1] = BRIDGE.towersAt, span = t1 - t0;
  for (const t of BRIDGE.towersAt) {
    const [x, z] = at(t);
    for (const side of [-1, 1]) box(4, BRIDGE.tower, 5, x - uz * side * 11, BRIDGE.tower / 2, z + ux * side * 11);
    box(26, 5, 4, x, BRIDGE.tower - 6, z);
    lights.push(x, BRIDGE.tower + 2, z);
  }
  // cables: from each tower top down to the deck on both sides, sagging between the towers
  const cable = [];
  const hang = (ta, tb, ya, yb, sag) => {
    for (const side of [-1, 1]) {
      for (let k = 0; k < 16; k++) {
        for (const j of [k, k + 1]) {
          const s = j / 16, [x, z] = at(ta + (tb - ta) * s), y = ya + (yb - ya) * s - sag * 4 * s * (1 - s);
          cable.push(x - uz * side * 11, y, z + ux * side * 11);
          if (j === k && k % 2 === 0) lights.push(x - uz * side * 11, y, z + ux * side * 11);
        }
      }
    }
  };
  hang(t0, t1, BRIDGE.tower, BRIDGE.tower, BRIDGE.tower - BRIDGE.deck - 14);
  hang(t0 - span * 0.45, t0, BRIDGE.deck + 4, BRIDGE.tower, 10);
  hang(t1, t1 + span * 0.45, BRIDGE.tower, BRIDGE.deck + 4, 10);
  const cableGeo = new THREE.BufferGeometry();
  cableGeo.setAttribute('position', new THREE.Float32BufferAttribute(cable, 3));
  bridge.add(new THREE.LineSegments(cableGeo, new THREE.LineBasicMaterial({ color: 0x8b949c, fog: false, toneMapped: false })));
  // lamps along the deck, lit at night
  for (let s = 40; s < len; s += 55) { const [x, z] = at(s / len); lights.push(x, BRIDGE.deck + 8, z); }
  const lightGeo = new THREE.BufferGeometry();
  lightGeo.setAttribute('position', new THREE.Float32BufferAttribute(lights, 3));
  const lamps = new THREE.Points(lightGeo, new THREE.PointsMaterial({ color: 0xffd9a0, size: 3, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false, toneMapped: false }));
  bridge.add(lamps);
  // (the Gwangan bridge is part of the map now and is built there, see decks.js: this stand-in is left out)
  group.add(hills);

  const cableMat = bridge.children.find(c => c.isLineSegments).material, landBase = new THREE.Color(0x4f6a52), steelBase = new THREE.Color(0x8b949c);
  return {
    group,
    // haze: the colour of the air at the horizon. far: how far one can see, metres. lit: 0..1 how much the lamps are on.
    tint(haze, far, lit) {
      group.visible = far > 1100;                       // lost in rain, snow and fog
      // how much of the air's colour they take: all of it by the time they are lost
      const air = far > 1900 ? THREE.MathUtils.clamp(1 - (far - 1500) / 2600, 0.45, 0.85) : THREE.MathUtils.clamp(0.85 + (1900 - far) / 800 * 0.15, 0.85, 1);
      const whole = far > 1900 ? 1 : air;                // as they vanish they become the air exactly
      land.color.copy(landBase).multiplyScalar(0.25 + 0.75 * (1 - lit)).lerp(haze, air).multiplyScalar(0.9 + 0.1 * (whole === 1 ? 0 : (whole - 0.85) / 0.15));
      steel.color.copy(steelBase).multiplyScalar(0.2 + 0.8 * (1 - lit)).lerp(haze, whole === 1 ? air * 0.85 : air).multiplyScalar(0.95 + 0.05 * (whole === 1 ? 0 : (whole - 0.85) / 0.15));
      cableMat.color.copy(steel.color);
      lamps.material.opacity = lit * (far > 1900 ? 1 : Math.max(0, (far - 1100) / 800));
      lamps.visible = lit > 0.05;
    },
  };
}
