import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// The cabin of a car: dashboard, instrument cluster, centre screen, steering wheel, seats, console and
// the mirrors. Built in the body's frame (see carbody.js): x to the left, y up, z towards the nose.
// The roof, pillars and door skins seen from inside are the body shell itself (see cars.js).

const CLUSTER = [512, 176], SCREEN = [400, 240];
const MIRROR_ASPECT = 4;          // the picture all three mirrors share: one wide view to the rear
// The part of that picture each mirror shows, as [left, right, bottom, top].
const VIEW = { room: [0.28, 0.72, 0.3, 0.77], left: [0.7, 0.98, 0.15, 0.81], right: [0.02, 0.3, 0.15, 0.81] };

function display([w, h]) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;      // redrawn many times a second
  texture.minFilter = THREE.LinearFilter;
  return { canvas, g: canvas.getContext('2d'), texture, material: new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }) };
}

// Show part of the mirror picture on a plane whose left edge is at u = 0, flipped the way a mirror flips.
function mirrorUv(geometry, [u0, u1, v0, v1]) {
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u1 + (u0 - u1) * uv.getX(i), v0 + (v1 - v0) * uv.getY(i));
  return geometry;
}

function drawDial(g, cx, cy, r, share, { max, step, label, redFrom = 2, colour }) {
  const A0 = Math.PI * 0.75, SWEEP = Math.PI * 1.5, at = v => A0 + SWEEP * v;
  g.lineCap = 'butt';
  g.strokeStyle = '#2a2f37';
  g.lineWidth = 5;
  g.beginPath();
  g.arc(cx, cy, r, A0, A0 + SWEEP);
  g.stroke();
  if (redFrom < 1) {
    g.strokeStyle = '#d5262d';
    g.beginPath();
    g.arc(cx, cy, r, at(redFrom), A0 + SWEEP);
    g.stroke();
  }
  g.fillStyle = '#c9d0d8';
  g.font = '600 13px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let v = 0; v <= max + 1e-6; v += step) {
    const a = at(v / max), c = Math.cos(a), s = Math.sin(a);
    g.strokeStyle = '#c9d0d8';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(cx + c * (r - 9), cy + s * (r - 9));
    g.lineTo(cx + c * (r - 1), cy + s * (r - 1));
    g.stroke();
    g.fillText(String(Math.round(v)), cx + c * (r - 21), cy + s * (r - 21));
  }
  g.fillStyle = '#7d8691';
  g.font = '11px sans-serif';
  g.fillText(label, cx, cy + r * 0.52);
  const a = at(Math.min(1, Math.max(0, share)));
  g.strokeStyle = colour;
  g.lineWidth = 4;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(cx - Math.cos(a) * 8, cy - Math.sin(a) * 8);
  g.lineTo(cx + Math.cos(a) * (r - 12), cy + Math.sin(a) * (r - 12));
  g.stroke();
  g.fillStyle = '#15181d';
  g.beginPath();
  g.arc(cx, cy, 9, 0, Math.PI * 2);
  g.fill();
}

// spec.cabin: { upper, lower, seat, accent: colours; dial: needle colour; top: highest speed on the dial;
// sport: deep seats }. sideGlass: the glass of the two door mirrors, [left, right].
// lining: the material of the shell's inside face, lit along with the rest of the cabin.
export function buildInterior(spec, shell, body, sideGlass, lining) {
  const s = spec.shape, c = spec.cabin, [header, cowl] = s.glass.front;
  const eyeZ = header - 0.38, cab = shell.at(eyeZ), belt = cab.belt, eyeY = Math.min(belt + 0.27, shell.top(eyeZ) - 0.2), seatY = eyeY - 0.72;
  const half = Math.min(cab.beltX, shell.at(cowl - 0.25).beltX) - 0.05, DX = 0.36;      // DX: the driver sits this far left of centre
  const std = options => new THREE.MeshStandardMaterial(options);
  const upper = std({ color: c.upper, roughness: 0.9 }), lower = std({ color: c.lower, roughness: 0.85 });
  const seatMat = std({ color: c.seat, roughness: 0.8 }), accent = std({ color: c.accent, roughness: 0.4, metalness: 0.6 });
  const black = std({ color: 0x1c1e22, roughness: 0.6 });
  // No light is worked out inside the cabin, so its surfaces carry a little of their own: daylight coming in.
  const lit = [upper, lower, seatMat, accent, black, lining];
  const daylight = amount => { for (const m of lit) { m.emissive.copy(m.color); m.emissiveIntensity = amount; } };
  daylight(0.45);
  const add = (geo, mat, x, y, z, parent = body) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };
  const box = (w, h, d, r = 0.02) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2.01, h / 2.01, d / 2.01));

  // ---- floor and dashboard
  const rearZ = Math.max(s.glass.side[0] + 0.35, eyeZ - 0.85), hasRear = rearZ < eyeZ - 0.6, backZ = hasRear ? rearZ - 0.45 : eyeZ - 0.55;
  add(new THREE.BoxGeometry(half * 2, 0.04, cowl - backZ), lower, 0, seatY - 0.2, (cowl + backZ) / 2);
  const edge = eyeZ + 0.7;                                  // the edge of the dashboard nearest the driver
  const profile = new THREE.Shape();
  profile.moveTo(cowl + 0.06, belt - 0.03);
  profile.lineTo(edge + 0.1, belt + 0.035);
  profile.quadraticCurveTo(edge, belt + 0.035, edge - 0.01, belt - 0.03);
  profile.lineTo(edge - 0.03, belt - 0.2);
  profile.lineTo(edge + 0.12, belt - 0.42);
  profile.lineTo(cowl + 0.06, belt - 0.42);
  profile.closePath();
  const dash = new THREE.ExtrudeGeometry(profile, { depth: half * 2, bevelEnabled: false, curveSegments: 8 }).rotateY(-Math.PI / 2).translate(half, 0, 0);
  add(dash, upper, 0, 0, 0);
  add(new THREE.BoxGeometry(half * 2 - 0.04, 0.035, 0.012), accent, 0, belt - 0.085, edge - 0.024);      // trim strip across the fascia
  add(new THREE.BoxGeometry(half * 2 - 0.02, 0.2, 0.3), lower, 0, belt - 0.33, edge + 0.13);
  for (const x of [-half + 0.14, -0.13, 0.13, half - 0.14].filter(x => Math.abs(x - DX) > 0.2)) add(new THREE.BoxGeometry(0.15, 0.045, 0.012), black, x, belt - 0.03, edge - 0.018);

  // ---- instruments: a hooded cluster behind the wheel and a screen on the middle of the dashboard
  const cluster = display(CLUSTER), screen = display(SCREEN);
  add(box(0.4, 0.05, 0.24, 0.025), upper, DX, belt + 0.125, edge + 0.07);
  for (const side of [-1, 1]) add(new THREE.BoxGeometry(0.02, 0.11, 0.2), upper, DX + side * 0.19, belt + 0.06, edge + 0.07);
  add(new THREE.PlaneGeometry(0.36, 0.36 * CLUSTER[1] / CLUSTER[0]).rotateY(Math.PI).rotateX(0.3), cluster.material, DX, belt + 0.04, edge + 0.045);
  const tablet = new THREE.Group();
  tablet.position.set(-0.02, belt + 0.085, edge + 0.01);
  tablet.rotation.set(0.12, -0.28, 0, 'YXZ');               // turned towards the driver
  body.add(tablet);
  add(box(0.285, 0.172, 0.016, 0.008), black, 0, 0, 0.009, tablet);
  add(new THREE.PlaneGeometry(0.27, 0.27 * SCREEN[1] / SCREEN[0]).rotateY(Math.PI), screen.material, 0, 0, 0, tablet);

  // ---- steering wheel, column and stalks
  const column = new THREE.Group();
  column.position.set(DX, belt - 0.09, eyeZ + 0.5);
  column.rotation.x = -0.35;
  body.add(column);
  add(new THREE.CylinderGeometry(0.05, 0.06, 0.3, 14).rotateX(Math.PI / 2), black, 0, 0, 0.17, column);
  const stalks = [1, -1].map(side => {                       // left: turn signals, right: wipers
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.05, 0, 0.07);
    add(new THREE.BoxGeometry(0.15, 0.018, 0.022), black, side * 0.075, 0, 0, pivot);
    column.add(pivot);
    return pivot;
  });
  const steeringWheel = new THREE.Group();
  column.add(steeringWheel);
  add(new THREE.TorusGeometry(0.18, 0.019, 10, 36), seatMat, 0, 0, 0, steeringWheel);
  add(new THREE.CylinderGeometry(0.058, 0.058, 0.045, 20).rotateX(Math.PI / 2), black, 0, 0, 0.012, steeringWheel);
  for (const [x, y, w, h] of [[-0.11, 0, 0.13, 0.034], [0.11, 0, 0.13, 0.034], [0, -0.11, 0.04, 0.13]]) add(box(w, h, 0.02, 0.008), black, x, y, 0.008, steeringWheel);
  add(new THREE.TorusGeometry(0.058, 0.004, 6, 24), accent, 0, 0, -0.012, steeringWheel);

  // ---- seats, console, door armrests, sun visors
  const seat = (x, z, width) => {
    add(box(width, 0.14, 0.5, 0.05), seatMat, x, seatY, z + 0.12);
    add(box(width, 0.64, 0.13, 0.05), seatMat, x, seatY + 0.35, z - 0.2).rotation.x = -0.2;
    const wide = width > 1;
    if (!wide) {
      for (const side of [-1, 1]) {
        add(box(0.07, c.sport ? 0.2 : 0.16, 0.46, 0.03), seatMat, x + side * (width / 2 - 0.02), seatY + 0.04, z + 0.12);
        if (c.sport) add(box(0.08, 0.5, 0.16, 0.035), seatMat, x + side * (width / 2 - 0.02), seatY + 0.32, z - 0.17).rotation.x = -0.2;
      }
    }
    for (const hx of wide ? [-0.36, 0.36] : [0]) add(box(0.25, 0.18, 0.1, 0.04), seatMat, x + hx, seatY + 0.74, z - 0.29);
  };
  seat(DX, eyeZ, 0.5);
  seat(-DX, eyeZ, 0.5);
  if (hasRear) seat(0, rearZ, half * 2 - 0.1);
  add(box(0.2, 0.2, edge - eyeZ + 0.5, 0.03), lower, 0, seatY + 0.02, (edge + eyeZ - 0.5) / 2 + 0.06);
  add(box(0.17, 0.05, 0.32, 0.02), seatMat, 0, seatY + 0.14, eyeZ - 0.12);
  add(new THREE.CylinderGeometry(0.012, 0.016, 0.1, 8), accent, 0, seatY + 0.17, eyeZ + 0.26);
  add(new THREE.SphereGeometry(0.03, 12, 8), black, 0, seatY + 0.23, eyeZ + 0.26);
  for (const side of [-1, 1]) add(box(0.07, 0.05, 0.62, 0.02), seatMat, side * (half + 0.005), belt - 0.2, eyeZ + 0.2);
  const roof = shell.at(header - 0.14);
  for (const x of [DX, -DX]) add(box(0.34, 0.012, 0.14, 0.005), upper, x, roof.top - 0.03, header - 0.14).rotation.x = 0.06;

  // ---- mirrors: one wide view to the rear, shared by the room mirror and the two door mirrors
  const target = new THREE.WebGLRenderTarget(4, 1, { type: THREE.HalfFloatType });
  const camera = new THREE.PerspectiveCamera(2 * Math.atan(Math.tan(55 * Math.PI / 180) / MIRROR_ASPECT) * 180 / Math.PI, MIRROR_ASPECT, 0.3, 260);
  camera.position.set(0, belt + 0.22, -spec.L / 2 + 0.1);   // at the back of the car, looking along -z
  body.add(camera);
  const live = new THREE.MeshBasicMaterial({ map: target.texture, color: 0xd0d6dc });
  const still = std({ color: 0x9fb2c2, metalness: 1, roughness: 0.08 });
  const room = new THREE.Group();
  room.position.set(0, shell.top(header) - 0.115, header + 0.04);
  room.rotation.y = -0.3;                                  // turned towards the driver
  body.add(room);
  add(box(0.26, 0.08, 0.025, 0.012), black, 0, 0, 0.014, room);
  add(new THREE.BoxGeometry(0.02, 0.07, 0.02), black, 0, 0.06, 0.03, room);
  const glasses = [add(mirrorUv(new THREE.PlaneGeometry(0.24, 0.065).rotateY(Math.PI), VIEW.room), still, 0, 0, 0, room)];
  sideGlass.forEach((mesh, i) => { mirrorUv(mesh.geometry, i ? VIEW.right : VIEW.left); mesh.material = still; glasses.push(mesh); });

  // ---- what the instruments show
  let tick = 0;
  function drawCluster(d) {
    const g = cluster.g, [W, H] = CLUSTER;
    g.fillStyle = '#07080a';
    g.fillRect(0, 0, W, H);
    drawDial(g, 96, 92, 76, d.rpm / (spec.redline * 1.08), { max: Math.ceil(spec.redline * 1.08 / 1000), step: 1, label: '×1000 rpm', redFrom: 1 / 1.08, colour: c.dial });
    drawDial(g, W - 96, 92, 76, d.kmh / c.top, { max: c.top, step: c.top > 220 ? 40 : 20, label: 'km/h', colour: c.dial });
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#f2f4f7';
    g.font = '700 54px sans-serif';
    g.fillText(String(d.kmh), W / 2, 92);
    g.fillStyle = '#7d8691';
    g.font = '13px sans-serif';
    g.fillText('km/h', W / 2, 110);
    g.fillStyle = c.dial;
    g.font = '700 24px sans-serif';
    g.fillText(d.gear, W / 2, 142);
    g.fillStyle = '#7d8691';
    g.font = '13px sans-serif';
    g.fillText(d.clock, W / 2, 164);
    g.font = '700 26px sans-serif';
    g.fillStyle = d.blinkLeft ? '#39d353' : '#1c2026';
    g.fillText('◀', W / 2 - 62, 40);
    g.fillStyle = d.blinkRight ? '#39d353' : '#1c2026';
    g.fillText('▶', W / 2 + 62, 40);
    g.font = '600 12px sans-serif';
    g.fillStyle = d.lights ? '#39d353' : '#1c2026';
    g.fillText('LIGHT', W / 2, 30);
    cluster.texture.needsUpdate = true;
  }
  function drawScreen(d) {
    const g = screen.g, [W, H] = SCREEN;
    g.fillStyle = '#0b0e13';
    g.fillRect(0, 0, W, H);
    if (d.minimap) g.drawImage(d.minimap, W - 198, 42, 190, 190);
    g.fillStyle = '#151a22';
    g.fillRect(0, 0, W, 36);
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillStyle = '#f2f4f7';
    g.font = '600 17px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
    g.fillText(d.clock, 12, 19);
    g.textAlign = 'right';
    g.fillStyle = '#9aa3ad';
    g.font = '14px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
    g.fillText(d.sky, W - 12, 19);
    g.textAlign = 'left';
    g.fillStyle = c.dial;
    g.font = '600 13px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
    g.fillText('라디오', 12, 60);
    g.fillStyle = '#f2f4f7';
    g.font = '600 17px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
    g.fillText(d.station, 12, 84, 180);
    g.fillStyle = '#9aa3ad';
    g.font = '13px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
    g.fillText(d.track, 12, 106, 180);
    g.fillStyle = c.dial;
    g.font = '600 13px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
    g.fillText('현재 도로', 12, 152);
    g.fillStyle = '#f2f4f7';
    g.font = '600 17px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
    g.fillText(d.road, 12, 176, 180);
    g.fillStyle = '#9aa3ad';
    g.font = '13px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
    g.fillText(`제한 ${d.limit} km/h`, 12, 198, 180);
    screen.texture.needsUpdate = true;
  }

  return {
    eyeY, eyeZ, steeringWheel,
    mirror: { camera, target },
    // Switch the mirrors between the live picture and plain reflective glass.
    setMirrors(on) { for (const m of glasses) m.material = on ? live : still; },
    // d: { kmh, rpm, gear, clock, blinkLeft, blinkRight, lights, signal, wiping, station, track, road, limit, sky, minimap, dark }
    // `d.inside`: the driver's view is in use, so the displays are worth redrawing.
    update(d) {
      if (d.inside || tick === 0) {
        if (tick % 3 === 0) drawCluster(d);                // 20 times a second is plenty for a needle
        if (tick++ % 30 === 0) drawScreen(d);
      }
      daylight(0.45 * (1 - 0.9 * d.dark));
      const dim = 1 - 0.45 * d.dark;                       // the displays turn themselves down at night
      cluster.material.color.setScalar(dim);
      screen.material.color.setScalar(dim);
      stalks[0].rotation.z = d.signal === 'left' ? -0.16 : d.signal === 'right' ? 0.16 : 0;
      stalks[1].rotation.z = d.wiping ? -0.14 : 0;
    },
    dispose() { target.dispose(); live.dispose(); still.dispose(); },
  };
}
