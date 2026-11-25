import * as THREE from 'three';
import { limitOf, levelOf } from './network.js';
import { ribbonMesh, paintMesh, LAYER } from './meshes.js';
import { laneSplit } from './lanes.js';
import { PLACES } from './stops.js';
import { pointInPolygon, boundsOf } from './data.js';
import { QuadBatch, FONT, seeded } from './atlas.js';
import { snowable } from './shared.js';

const KERBED = /^(trunk|primary|secondary|tertiary|residential|unclassified|living_street)$/;
const SIDEWALK_W = 3;
export const LAMP_COLOURS = { red: 0xff2a1a, amber: 0xffb000, green: 0x18e07a, arrow: 0x18e07a, walkRed: 0xff2a1a, walkGreen: 0x18e07a, count: 0x18e07a };
const WIRED = /^(residential|living_street|unclassified)$/;     // streets with overhead lines and speed bumps

// Road arrows, in metres: x to the right of travel, y along it. Each is a few convex pieces.
const SHAFT = y1 => [[-0.08, 0], [0.08, 0], [0.08, y1], [-0.08, y1]];
const AHEAD = [SHAFT(2.7), [[-0.36, 2.7], [0.36, 2.7], [0, 4.2]]];
const BRANCH = (y, side) => [[[0, y - 0.08], [side * 0.95, y - 0.08], [side * 0.95, y + 0.08], [0, y + 0.08]], [[side * 0.95, y - 0.42], [side * 0.95, y + 0.42], [side * 1.85, y]]];
const ARROWS = {
  S: AHEAD, L: [SHAFT(2.3), ...BRANCH(2.22, -1)], R: [SHAFT(2.3), ...BRANCH(2.22, 1)],
  LS: [...AHEAD, ...BRANCH(1.4, -1)], RS: [...AHEAD, ...BRANCH(1.4, 1)],
  LR: [SHAFT(2.3), ...BRANCH(2.22, -1), ...BRANCH(2.22, 1)], LRS: [...AHEAD, ...BRANCH(1.4, -1), ...BRANCH(1.4, 1)],
};

// Materials and shapes shared by the street furniture of every zone.
// update(time) runs the signals; lampGlow, pools, halos and signs are driven by the time of day.
export function createStreetKit(atlas) {
  const metal = new THREE.MeshStandardMaterial({ color: 0x5b6067, roughness: 0.6, metalness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c1e21, roughness: 0.7 });
  const lampGlow = new THREE.MeshStandardMaterial({ color: 0xdedede, emissive: 0xffe2b0, emissiveIntensity: 0 });
  // signal lamps: each one's colour is set as its junction's programme runs (see world.js)
  const signalLamp = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const arrow = new THREE.Shape([[0.9, -0.22], [0.9, 0.22], [-0.1, 0.22], [-0.1, 0.62], [-1, 0], [-0.1, -0.62], [-0.1, -0.22]].map(p => new THREE.Vector2(...p)));
  const cylinder = new THREE.CylinderGeometry(1, 1, 1, 8), box = new THREE.BoxGeometry(1, 1, 1);
  const kinds = {
    pole: [cylinder, metal], box: [box, dark], lampHead: [box, lampGlow],
    trunk: [new THREE.CylinderGeometry(0.8, 1, 1, 6), new THREE.MeshStandardMaterial({ color: 0x4b3a2b, roughness: 0.9 })],
    crown: [new THREE.IcosahedronGeometry(1, 1), snowable(new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), 0.6)],
  };
  kinds.cover = [new THREE.CylinderGeometry(1, 1, 1, 14), new THREE.MeshStandardMaterial({ color: 0x2c2e31, roughness: 0.55, metalness: 0.6 })];      // manhole covers
  kinds.lamp = [new THREE.CircleGeometry(1, 16), signalLamp];
  kinds.arrowLamp = [new THREE.ShapeGeometry(arrow), signalLamp];
  kinds.barLamp = [new THREE.PlaneGeometry(1, 1), signalLamp];
  kinds.cone = [new THREE.ConeGeometry(1, 1, 7), kinds.crown[1]];                 // pine trees
  kinds.concrete = [cylinder, new THREE.MeshStandardMaterial({ color: 0x8e8d87, roughness: 0.9 })];       // utility poles
  kinds.panel = [box, new THREE.MeshStandardMaterial({ color: 0xaebdca, roughness: 0.25, metalness: 0.3, transparent: true, opacity: 0.55 })];   // shelter glass

  // Pool of light on the ground under each lamp: a glowing disc laid along the slope. Cheaper than a
  // real light per lamp, and enough to read as a lit street.
  const glow = document.createElement('canvas');
  glow.width = glow.height = 128;
  const gg = glow.getContext('2d'), fade = gg.createRadialGradient(64, 64, 0, 64, 64, 64);
  fade.addColorStop(0, 'rgba(255,255,255,1)');
  fade.addColorStop(0.2, 'rgba(255,255,255,0.6)');
  fade.addColorStop(0.5, 'rgba(255,255,255,0.2)');
  fade.addColorStop(0.8, 'rgba(255,255,255,0.04)');
  fade.addColorStop(1, 'rgba(255,255,255,0)');
  gg.fillStyle = fade;
  gg.fillRect(0, 0, 128, 128);
  const pools = new THREE.MeshBasicMaterial({
    map: new THREE.CanvasTexture(glow), color: 0xffcf94, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -14, polygonOffsetUnits: -56,
  });
  // and a soft halo round each lamp head
  const halos = new THREE.PointsMaterial({
    map: pools.map, color: 0xffd9a8, size: 3.2, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const signs = new THREE.MeshStandardMaterial({
    map: atlas.texture, alphaTest: 0.5, roughness: 0.6, emissiveMap: atlas.texture, emissive: 0xffffff, emissiveIntensity: 0,
  });

  return { kinds, lampGlow, pools, halos, signs, poolShape: new THREE.CircleGeometry(17, 24).rotateX(-Math.PI / 2) };
}

// The point `back` metres before the end of a lane, and the direction of travel there.
function pointBack(pts, back) {
  for (let i = pts.length - 1; i > 0; i--) {
    const dx = pts[i][0] - pts[i - 1][0], dz = pts[i][1] - pts[i - 1][1], len = Math.hypot(dx, dz) || 1;
    if (back <= len || i === 1) return [[pts[i][0] - dx / len * back, pts[i][1] - dz / len * back], [dx / len, dz / len]];
    back -= len;
  }
  return [pts[0], [0, 1]];
}

// Road paint, kerbs, signals, lamps, signs and trees for one zone.
// ctx: { map, ground, atlas, kit, nearRoad, stops } - nearRoad(x, z, margin, kind, except) tells whether a
// road of that kind ('drive' or 'any') lies within `margin` metres of its edge.
// zone: { owns, streets, outlines, areas, lines, seed, x0, z0, x1, z1 }.
// Streets are worked out whole and each zone keeps what falls inside it, so zones agree at their edges.
// Returns { group, posts, lamps, decals, signals, parked } - posts are the solid poles and trunks; parked
// are the cars standing beside the access roads, { x, z, heading, kind, tint }; signals are
// the lamps of the signal heads, { mesh, i, arm, role }, for the world to switch on and off.
export function buildStreets(ctx, zone) {
  const { map, atlas, kit, nearRoad, stops } = ctx, { owns } = zone, rand = seeded(7 + zone.seed);
  const white = [], yellow = [], sidewalks = [], posts = [], lamps = [], grit = seeded(91 + zone.seed);
  // Things lie on the uppermost surface, except those of a street that passes under a deck.
  let low = false;
  const ground = (x, z) => (low ? ctx.ground(x, z) : ctx.top(x, z)), strips = [white, yellow, sidewalks], done = [0, 0, 0];
  // the strips laid since the last call belong to the street being worked on then
  const turnTo = street => {
    strips.forEach((list, i) => { for (let k = done[i]; k < list.length; k++) list[k].low = low; done[i] = list.length; });
    low = !!street?.road.low;
  };
  const signs = new QuadBatch(atlas);
  const inst = {};
  const dummy = new THREE.Object3D();
  dummy.rotation.order = 'YXZ';
  const put = (name, x, y, z, heading, sx, sy, sz, color, lamp, pitch = 0) => {
    dummy.position.set(x, y, z);
    dummy.rotation.set(pitch, heading, 0);
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();
    (inst[name] ||= []).push({ m: dummy.matrix.clone(), color, lamp });
  };
  const arrowPos = [], arrowIdx = [], signals = [], dim = new THREE.Color(0x0a0a0a);
  // paint an arrow on the road at frame f for the turns a lane allows, e.g. 'LS'
  const roadArrow = (f, turns) => {
    for (const piece of ARROWS[turns] || ARROWS.S) {
      const base = arrowPos.length / 3;
      for (const [px, py] of piece) {
        const x = f.x - f.uz * px + f.ux * py, z = f.z + f.ux * px + f.uz * py;
        arrowPos.push(x, ground(x, z) + LAYER.mark, z);
      }
      for (let k = 2; k < piece.length; k++) arrowIdx.push(base, base + k - 1, base + k);
    }
  };
  // A spot beside the street: `right` metres to the right of travel and `ahead` metres along it.
  const beside = (f, right, ahead = 0) => {
    const x = f.x - f.uz * right + f.ux * ahead, z = f.z + f.ux * right + f.uz * ahead;
    return { x, z, y: ground(x, z) };
  };
  const outlines = zone.outlines.map(p => ({ p, box: boundsOf(p) }));
  const inBuilding = (x, z) => outlines.some(o => x >= o.box[0] && x <= o.box[2] && z >= o.box[1] && z <= o.box[3] && pointInPolygon(x, z, o.p));
  // Kerbside things must not land on another carriageway (driveways, the other half of a divided road).
  const blocked = (at, own) => nearRoad(at.x, at.z, 0.4, 'drive', own);
  // kind: 'ginkgo' (the usual street tree), 'pine' along the sea front, 'cherry' on Dalmaji-gil
  const tree = (x, z, own, kind = 'ginkgo') => {
    if (!owns(x, z) || inBuilding(x, z) || !map.isLand(x, z) || nearRoad(x, z, 0.8, 'drive', own)) return;
    if (stops.some(s => Math.abs(s.kx - x) < 4.5 && Math.abs(s.kz - z) < 4.5)) return;       // not in a bus shelter
    const y = ground(x, z), turn = rand() * 6.28;
    if (kind === 'pine') {
      const h = 5.5 + rand() * 2, w = 1.5 + rand() * 0.5, green = new THREE.Color().setHSL(0.36 + rand() * 0.04, 0.42, 0.13 + rand() * 0.05);
      put('trunk', x, y + h * 0.4, z, 0, 0.13, h * 0.8, 0.13);
      put('cone', x, y + h * 0.72, z, turn, w * 1.25, h * 0.36, w * 1.25, green);
      put('cone', x, y + h * 0.95, z, turn + 1, w * 0.85, h * 0.34, w * 0.85, green);
    } else {
      const cherry = kind === 'cherry', rw = (cherry ? 2.0 : 1.5) + rand() * 0.9, rh = (cherry ? 1.5 : 1.8) + rand() * 1.0;
      const colour = cherry ? new THREE.Color().setHSL(0.93 + rand() * 0.04, 0.6, 0.78 + rand() * 0.08) : new THREE.Color().setHSL(0.24 + rand() * 0.1, 0.42, 0.2 + rand() * 0.1);
      put('trunk', x, y + 1.6, z, 0, 0.16, 3.2, 0.16);
      put('crown', x, y + 2.9 + rh * 0.6, z, turn, rw, rh, rw, colour);
    }
    posts.push({ x, z, r: 0.25 });
  };
  const speciesOf = road => (/해변/.test(road.n) ? 'pine' : /달맞이/.test(road.n) ? 'cherry' : 'ginkgo');
  // a cell of the sign atlas, or null when the atlas has no room left
  const cell = (key, draw, width) => { try { return atlas.add(key, draw, width); } catch { return null; } };
  const text = (g, font, colour = '#fff') => { g.fillStyle = colour; g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle'; };

  const nameRect = name => atlas.add(`road:${name}`, (g, w, h) => {
    g.fillStyle = '#1d4f9e';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#fff';
    g.lineWidth = 3;
    g.strokeRect(4, 4, w - 8, h - 8);
    g.fillStyle = '#fff';
    g.font = `700 ${name.length > 7 ? 26 : 34}px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(name, w / 2, h / 2 + 2);
  });
  const limitRect = limit => atlas.add(`limit:${limit}`, (g, w, h) => {
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(h / 2, h / 2, h / 2 - 1, 0, 7);
    g.fill();
    g.strokeStyle = '#d62828';
    g.lineWidth = 8;
    g.beginPath();
    g.arc(h / 2, h / 2, h / 2 - 6, 0, 7);
    g.stroke();
    g.fillStyle = '#111';
    g.font = `800 30px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(limit, h / 2, h / 2 + 2);
  }, atlas.cellH);

  // Signal head on a mast arm for the lanes that approach along frame f (taken at the stop line).
  // It stands `ahead` metres on, across the junction, where a waiting driver can see it.
  // arm: the approach it controls (see lanes.js); a fourth lamp shows the left-turn arrow if it has one.
  function signal(f, half, armLen, far, arm) {
    const heading = Math.atan2(f.ux, f.uz);
    // Across a bent or wide junction the spot straight ahead can land on a carriageway - even the
    // street's own. Then it stands nearer; if no spot is free the approach goes without a head.
    const spot = [far, far - 5, far * 0.7, far * 0.5].map(d => ({ d, at: beside(f, half + 0.9, d) })).find(c => map.isLand(c.at.x, c.at.z) && !blocked(c.at));
    if (!spot || !owns(spot.at.x, spot.at.z)) return;
    const base = spot.at, y = base.y, ahead = spot.d;
    put('pole', base.x, y + 3.2, base.z, 0, 0.1, 6.4, 0.1);
    posts.push({ x: base.x, z: base.z, r: 0.2 });
    const boom = beside(f, half + 0.9 - armLen / 2, ahead), head = beside(f, half + 0.9 - armLen + 0.9, ahead);
    put('box', boom.x, y + 6.2, boom.z, heading, armLen, 0.12, 0.12);
    // seen by the driver, left to right: red, amber, (left arrow,) green
    const roles = arm.arrow ? ['red', 'amber', 'arrow', 'green'] : ['red', 'amber', 'green'], width = roles.length * 0.47 + 0.1;
    put('box', head.x, y + 6.15, head.z, heading, width, 0.46, 0.26);
    roles.forEach((role, k) => {
      const lamp = beside(f, half + 0.9 - armLen + 0.9 + (k - (roles.length - 1) / 2) * 0.47, ahead - 0.14);
      put(role === 'arrow' ? 'arrowLamp' : 'lamp', lamp.x, y + 6.15, lamp.z, heading + Math.PI, 0.16, 0.16, 1, dim, { arm, role });
    });
  }

  // The pedestrian signal at each end of a zebra crossing: a red and a green figure lamp and, beside
  // them, bars that count the green time down. Each faces the people waiting on the other side.
  function walkSignals(arm) {
    const { a, b } = arm.zebra;
    for (const [here, there] of [[a, b], [b, a]]) {
      const dx = there.x - here.x, dz = there.z - here.z, len = Math.hypot(dx, dz) || 1, ux = dx / len, uz = dz / len;
      const x = here.x - ux * 0.7, z = here.z - uz * 0.7;
      if (!owns(x, z) || blocked({ x, z })) continue;
      const y = ground(x, z) + LAYER.sidewalk, heading = Math.atan2(ux, uz), fx = x + ux * 0.13, fz = z + uz * 0.13;
      put('pole', x, y + 1.3, z, 0, 0.06, 2.6, 0.06);
      put('box', x, y + 2.75, z, heading, 0.62, 0.74, 0.22);
      posts.push({ x, z, r: 0.1 });
      const side = (d, up, role, kind, sx, sy, bar) => put(kind, fx - uz * d, y + 2.75 + up, fz + ux * d, heading, sx, sy, 1, dim, { arm, role, bar });
      side(-0.13, 0.17, 'walkRed', 'lamp', 0.12, 0.12);
      side(-0.13, -0.17, 'walkGreen', 'lamp', 0.12, 0.12);
      for (let k = 0; k < 6; k++) side(0.17, -0.27 + k * 0.108, 'count', 'barLamp', 0.2, 0.07, k);
    }
  }

  // The green direction sign before a big junction: which way each street or place lies.
  function directions(arm, laneW) {
    const lane = arm.entries.at(-1);
    if (lane.len < 85) return;
    const [at, dir] = pointBack(lane.pts, 45), f = { x: at[0], z: at[1], ux: dir[0], uz: dir[1] }, foot = beside(f, laneW / 2 + 1.5);
    if (!owns(foot.x, foot.z) || blocked(foot, arm.road)) return;
    const ways = [['L', '←'], ['S', '↑'], ['R', '→']].map(([turn, mark]) => {
      const move = arm.entries.flatMap(l => l.out).find(m => m.turn === turn), name = move && move.to.road.n;
      return name ? [mark, PLACES[name] || name] : null;
    }).filter(Boolean);
    if (!ways.length) return;
    const rect = cell(`way:${ways.flat().join('')}`, (g, w, h) => {
      g.fillStyle = '#0d6b3f';
      g.fillRect(0, 0, w, h);
      g.strokeStyle = '#fff';
      g.lineWidth = 2;
      g.strokeRect(3, 3, w - 6, h - 6);
      ways.forEach(([mark, name], i) => {
        const x = w * (i + 0.5) / ways.length;
        text(g, `800 22px ${FONT}`);
        g.fillText(mark, x, 19);
        text(g, `700 ${name.length > 6 ? 13 : 16}px ${FONT}`);
        g.fillText(name, x, 44, w / ways.length - 8);
      });
    });
    if (!rect) return;
    const y = foot.y + LAYER.sidewalk, heading = Math.atan2(f.ux, f.uz), over = beside(f, laneW / 2 + 1.5 - 2.9);
    put('pole', foot.x, y + 3.1, foot.z, 0, 0.09, 6.2, 0.09);
    put('box', (foot.x + over.x) / 2, y + 5.3, (foot.z + over.z) / 2, heading, 3.0, 0.1, 0.1);
    signs.add(new THREE.Vector3(over.x, y + 5.3, over.z), new THREE.Vector3(-f.uz, 0, f.ux), 5.2, 1.3, rect);
    posts.push({ x: foot.x, z: foot.z, r: 0.18 });
  }

  // "One way" where a one-way street starts, "no entry" where it ends. w: the direction a driver
  // reading the sign is travelling in.
  function oneWay(arm, s, into, half, st) {
    const leaving = !arm.entries.length, f0 = st.at(s), w = { x: f0.x, z: f0.z, ux: -f0.ux * into, uz: -f0.uz * into };
    const at = beside(w, half + 1.0, leaving ? 5 : 1.5);
    if (!owns(at.x, at.z) || blocked(at, arm.road)) return;
    const rect = leaving ? cell('sign:oneway', (g, _, h) => {
      g.fillStyle = '#1d4f9e';
      g.fillRect(0, 0, h, h);
      text(g, `800 38px ${FONT}`);
      g.fillText('↑', h / 2, 24);
      text(g, `700 13px ${FONT}`);
      g.fillText('일방통행', h / 2, 51);
    }, atlas.cellH) : cell('sign:noentry', (g, _, h) => {
      g.fillStyle = '#d62828';
      g.beginPath();
      g.arc(h / 2, h / 2, h / 2 - 1, 0, 7);
      g.fill();
      g.fillStyle = '#fff';
      g.fillRect(10, h / 2 - 6, h - 20, 12);
    }, atlas.cellH);
    if (!rect) return;
    put('pole', at.x, at.y + 1.4, at.z, 0, 0.05, 2.8, 0.05);
    signs.add(new THREE.Vector3(at.x, at.y + 2.5, at.z), new THREE.Vector3(-w.uz, 0, w.ux), 0.7, 0.7, rect);
    posts.push({ x: at.x, z: at.z, r: 0.12 });
  }

  // does the stretch s0..s1 of a street come within `reach` metres of this zone?
  const touches = (st, s0, s1, reach) => {
    const [ax, az, bx, bz] = boundsOf(st.slice(s0, s1));
    return bx > zone.x0 - reach && ax < zone.x1 + reach && bz > zone.z0 - reach && az < zone.z1 + reach;
  };
  const ownsAt = f => owns(f.x, f.z);

  for (const st of zone.streets) {
    turnTo(st);
    const r = st.road, ln = r.ln, half = r.w / 2, laneW = (r.w - 1) / ln, twoWay = !r.ow, centre = laneSplit(r)[1];
    const reverse = f => ({ x: f.x, z: f.z, ux: -f.ux, uz: -f.uz });

    // ---------- paint ----------
    for (const iv of st.links) {
      if (iv.internal || !touches(st, iv.s0, iv.s1, half + 60)) continue;
      const [startArm, endArm] = iv.ends, atJunction = arm => arm.junction.arms.length >= 3;
      const p = st.slice(iv.s0, iv.s1);
      white.push({ p, w: 0.15, o: half - 0.35 }, { p, w: 0.15, o: -(half - 0.35) });
      for (let k = 1; k < ln; k++) {
        const o = (k - ln / 2) * laneW;
        if (twoWay && ln > 1 && k === centre) {
          if (ln >= 4) yellow.push({ p, w: 0.15, o: o - 0.17 }, { p, w: 0.15, o: o + 0.17 });
          else yellow.push({ p, w: 0.15, o });
        } else {
          for (let s = iv.s0 + 1; s + 3 <= iv.s1; s += 8) if (ownsAt(st.at(s + 1.5))) white.push({ p: st.slice(s, s + 3), w: 0.15, o, whole: true });
        }
      }
      // stop line and zebra crossing where the stretch meets a junction
      // dir: +1 when the junction lies ahead of s, -1 behind. stop: the lanes that have to wait here.
      // deep: how far the zebra crossing reaches towards the junction
      const approach = (s, dir, stop, deep) => {
        if (!ownsAt(st.at(s))) return;
        if (stop) white.push({ p: st.slice(Math.min(s, s - dir * 0.45), Math.max(s, s - dir * 0.45)), ...stop, whole: true });
        for (let x = -half + 0.7; x <= half - 0.7; x += 1) {
          white.push({ p: st.slice(Math.min(s + dir, s + dir * deep), Math.max(s + dir, s + dir * deep)), w: 0.5, o: x, whole: true });
        }
      };
      // a stop line only where the approach has to wait: at signals, and where it meets a bigger street
      const waits = arm => arm.entries.length && (arm.give === 'signal' || arm.give === 'stop');
      // the stop line spans the lanes of its own direction, from the centre line to the kerb
      const divide = twoWay && ln > 1 ? (centre - ln / 2) * laneW : 0;
      const line = dir => (!twoWay ? (dir > 0 ? { o: 0, w: r.w - 1 } : null) : ln === 1 ? { o: dir * half / 2, w: half - 0.5 }
        : { o: (divide + dir * half) / 2, w: half - dir * divide - 0.5 });
      for (const [arm, s, dir] of [[endArm, iv.s1, 1], [startArm, iv.s0, -1]]) {
        if (!atJunction(arm)) continue;
        if (arm.crossing) approach(s, dir, waits(arm) ? line(dir) : null, Math.min(4.5, iv.clear[dir > 0 ? 1 : 0] - 0.5));
        else if (waits(arm) && line(dir) && ownsAt(st.at(s))) white.push({ p: st.slice(Math.min(s, s - dir * 0.45), Math.max(s, s - dir * 0.45)), ...line(dir), whole: true });
      }

      for (const [arm, s, dir] of [[endArm, iv.s1, 1], [startArm, iv.s0, -1]]) {
        if (arm.zebra && arm.junction.control === 'signal') walkSignals(arm);
        if (r.ow && atJunction(arm) && arm.entries.length !== arm.exits.length) oneWay(arm, s, dir, half, st);
        if (arm.give === 'signal' && arm.rank >= 3 && arm.entries.length >= 2) directions(arm, laneW);
        // short posts either side of a zebra crossing keep cars off the corner
        if (arm.zebra) {
          for (const [here, there] of [[arm.zebra.a, arm.zebra.b], [arm.zebra.b, arm.zebra.a]]) {
            const dx = there.x - here.x, dz = there.z - here.z, len = Math.hypot(dx, dz) || 1;
            for (const along of [-1.9, 1.9]) {
              const x = here.x + dx / len * 0.9 - dz / len * along, z = here.z + dz / len * 0.9 + dx / len * along;
              if (!owns(x, z) || blocked({ x, z })) continue;
              put('box', x, ground(x, z) + LAYER.sidewalk + 0.45, z, 0, 0.14, 0.9, 0.14);
              posts.push({ x, z, r: 0.1 });
            }
          }
        }
      }
      // a speed bump half way along a side street
      if (WIRED.test(r.k) && iv.s1 - iv.s0 > 110) {
        const mid = (iv.s0 + iv.s1) / 2;
        if (ownsAt(st.at(mid))) for (let k = 0; k < 3; k++) yellow.push({ p: st.slice(mid + k * 0.9, mid + k * 0.9 + 0.45), w: r.w - 0.8, o: 0, whole: true });
      }

      // signal heads, on the far side of the junction
      for (const [arm, s, dir] of [[endArm, iv.s1, 1], [startArm, iv.s0, -1]]) {
        if (arm.give !== 'signal') continue;
        const f = dir > 0 ? st.at(s) : reverse(st.at(s)), on = arm.entries[0].out.find(m => m.turn === 'S') || arm.entries.at(-1).out[0];
        const far = on ? Math.hypot(on.pts.at(-1)[0] - f.x, on.pts.at(-1)[1] - f.z) : 2 * iv.pads[dir > 0 ? 1 : 0];
        signal({ ...f, road: r }, half, twoWay ? half * 0.9 : r.w * 0.8, Math.max(8, far - 1.5), arm);
      }

      // arrows before the junction, lane by lane, where there is a choice of lanes or a signal
      for (const arm of [endArm, startArm]) {
        if (!atJunction(arm) || !(arm.entries.length >= 2 || arm.give === 'signal')) continue;
        for (const lane of arm.entries) {
          const turns = [...new Set(lane.out.map(m => m.turn))].sort().join('');
          for (const back of lane.len > 70 ? [9, 34] : lane.len > 26 ? [9] : []) {
            const [a, b] = pointBack(lane.pts, back);
            if (owns(a[0], a[1])) roadArrow({ x: a[0], z: a[1], ux: b[0], uz: b[1] }, turns);
          }
        }
      }

      // speed limit signs facing each direction of travel
      if (iv.s1 - iv.s0 >= 70) {
        const facing = [st.at(iv.s0 + 18)].concat(twoWay ? [reverse(st.at(iv.s1 - 18))] : []);
        for (const f of facing) {
          const at = beside(f, half + 1.1);
          if (!owns(at.x, at.z) || blocked(at, r)) continue;
          put('pole', at.x, at.y + 1.5, at.z, 0, 0.05, 3, 0.05);
          signs.add(new THREE.Vector3(at.x, at.y + 2.7, at.z), new THREE.Vector3(-f.uz, 0, f.ux), 0.7, 0.7, limitRect(limitOf(r)));
          posts.push({ x: at.x, z: at.z, r: 0.12 });
        }
      }
      // street name plate at the start of each stretch
      if (r.n && atJunction(startArm)) {
        const f = st.at(iv.s0 + 3), at = beside(f, half + 1.3);
        if (owns(at.x, at.z) && !blocked(at, r)) {
          put('pole', at.x, at.y + 1.8, at.z, 0, 0.05, 3.6, 0.05);
          signs.add(new THREE.Vector3(at.x, at.y + 3.4, at.z), new THREE.Vector3(f.ux, 0, f.uz), 1.5, 0.375, nameRect(r.n), true);
          posts.push({ x: at.x, z: at.z, r: 0.12 });
        }
      }
    }

    // ---------- kerbs, lamps, trees ----------
    if (!KERBED.test(r.k) || levelOf(r) !== 0) continue;       // a bridge has its parapets and an underpass its walls
    for (const iv of st.intervals(c => c.half + SIDEWALK_W + 0.5)) {
      if (!touches(st, iv.s0, iv.s1, half + 20)) continue;
      // drain grates by the kerb, and manhole covers in the lanes
      for (let s = iv.s0 + 5 + grit() * 12; s < iv.s1 - 4; s += 20 + grit() * 16) {
        const f = st.at(s), heading = Math.atan2(f.ux, f.uz), drain = beside(f, (grit() < 0.5 ? -1 : 1) * (half - 0.42));
        if (owns(drain.x, drain.z)) put('box', drain.x, drain.y + LAYER.mark, drain.z, heading, 0.4, 0.02, 0.75);
        const g = st.at(Math.min(iv.s1 - 2, s + 7 + grit() * 6)), cover = beside(g, (grit() - 0.5) * Math.max(0, r.w - 2.6));
        if (grit() < 0.6 && owns(cover.x, cover.z)) put('cover', cover.x, cover.y + LAYER.mark, cover.z, 0, 0.36, 0.02, 0.36);
      }
      // lay each side's kerb only along the runs that are clear of other carriageways
      for (const sd of [-1, 1]) {
        let from = null;
        for (let s = iv.s0; ; s += 3) {
          const end = s >= iv.s1, clear = !end && !blocked(beside(st.at(s), sd * (half + SIDEWALK_W / 2)), r);
          if (clear && from === null) from = s;
          if (!clear && from !== null) {
            if (s - 3 - from > 2) sidewalks.push({ p: st.slice(from, s - 3), w: SIDEWALK_W, o: sd * (half + SIDEWALK_W / 2) });
            from = null;
          }
          if (end) break;
        }
      }
      let side = 1;
      for (let s = iv.s0 + 18; s < iv.s1 - 6; s += 36, side = -side) {
        const f = st.at(s), heading = Math.atan2(f.ux, f.uz);
        const foot = beside(f, side * (half + 0.8)), arm = beside(f, side * (half - 0.3)), head = beside(f, side * (half - 1.4));
        if (!owns(foot.x, foot.z) || blocked(foot, r)) continue;
        put('pole', foot.x, foot.y + 4, foot.z, 0, 0.08, 8, 0.08);
        put('box', arm.x, foot.y + 8, arm.z, heading, 2.2, 0.08, 0.08);
        put('lampHead', head.x, foot.y + 7.95, head.z, heading, 0.75, 0.12, 0.3);
        posts.push({ x: foot.x, z: foot.z, r: 0.18 });
        lamps.push(head);
      }
      const species = speciesOf(r);
      for (let s = iv.s0 + 5; s < iv.s1 - 3; s += 13) {
        if (Math.abs((s - iv.s0 - 18) % 36) < 3) continue;     // keep clear of the lamps
        const f = st.at(s);
        for (const sd of [-1, 1]) { const at = beside(f, sd * (half + 2.1)); tree(at.x, at.z, r, species); }
      }
      // overhead lines down one side of the back streets: a concrete pole every 38 m and two wires between
      if (WIRED.test(r.k)) {
        let before = null;
        for (let s0 = iv.s0 + 9; s0 < iv.s1 - 4; s0 += 38) {
          // not right beside a street lamp (those stand on this side every 72 m)
          const beat = ((s0 - iv.s0 - 54) % 72 + 72) % 72, s = beat < 3 || beat > 69 ? s0 + 5 : s0;
          const f = st.at(s), at = beside(f, -(half + 0.55));
          if (blocked(at, r) || !map.isLand(at.x, at.z)) { before = null; continue; }
          const top = at.y + LAYER.sidewalk + 8.6, heading = Math.atan2(f.ux, f.uz);
          if (owns(at.x, at.z)) {
            put('concrete', at.x, at.y + 4.5, at.z, 0, 0.15, 9, 0.15);
            put('box', at.x, top - 0.1, at.z, heading + Math.PI / 2, 0.08, 0.08, 1.5);
            posts.push({ x: at.x, z: at.z, r: 0.2 });
          }
          if (before && owns((before.x + at.x) / 2, (before.z + at.z) / 2)) {
            const dx = at.x - before.x, dz = at.z - before.z, flat = Math.hypot(dx, dz), rise = top - before.top, turn = Math.atan2(dx, dz);
            for (const off of [-0.6, 0.6]) {
              put('box', (before.x + at.x) / 2 - Math.cos(turn) * off, (before.top + top) / 2, (before.z + at.z) / 2 + Math.sin(turn) * off, turn, 0.025, 0.025, Math.hypot(flat, rise), undefined, undefined, -Math.atan2(rise, flat));
            }
          }
          before = { x: at.x, z: at.z, top };
        }
      }
    }
  }

  turnTo(null);

  // ---------- pavement round the corners of junctions ----------
  // The pavements stop short of a junction. Where people walk round the corner (see walks.js) the
  // gap is paved: a curve from the end of one pavement to the end of the next, or straight on to a crossing.
  const corners = [];
  for (const e of ctx.walks.edges) {
    if (e.kind !== 'corner' || !owns((e.a.x + e.b.x) / 2, (e.a.z + e.b.z) / 2)) continue;
    const A = e.a, B = e.b, span = Math.hypot(B.x - A.x, B.z - A.z);
    if (span < 0.5) continue;
    const towards = arm => { const f = arm.link.st.at(arm.s), into = arm.end ? 1 : -1; return { x: f.x, z: f.z, ux: f.ux * into, uz: f.uz * into }; };
    const p = [];
    let centre;                                             // the carriageway side: the paving is shifted that way, up to the kerb
    if (e.round) {
      const da = towards(e.round[0]), db = towards(e.round[1]), cross = da.ux * db.uz - da.uz * db.ux;
      const t = ((B.x - A.x) * db.uz - (B.z - A.z) * db.ux) / (cross || 1), u = ((B.x - A.x) * da.uz - (B.z - A.z) * da.ux) / (cross || 1);
      const bent = Math.abs(cross) > 0.25 && t > 0 && t < 30 && u > 0 && u < 30;
      const cx = bent ? A.x + da.ux * t : (A.x + B.x) / 2, cz = bent ? A.z + da.uz * t : (A.z + B.z) / 2;
      for (let k = 0; k <= 8; k++) {
        const s = k / 8;
        p.push((1 - s) * (1 - s) * A.x + 2 * s * (1 - s) * cx + s * s * B.x, (1 - s) * (1 - s) * A.z + 2 * s * (1 - s) * cz + s * s * B.z);
      }
      centre = e.round[0].junction;
    } else if (e.along) {
      p.push(A.x, A.z, B.x, B.z);
      centre = towards(e.along);
    } else continue;
    const side = Math.sign(-(B.z - A.z) * (centre.x - A.x) + (B.x - A.x) * (centre.z - A.z)) || 1;
    corners.push({ p, w: SIDEWALK_W + 0.5, o: side * 1.1 });
  }

  // ---------- bus stops ----------
  for (const stop of stops) {
    if (!owns(stop.kx, stop.kz) || !map.isLand(stop.kx, stop.kz) || blocked({ x: stop.kx, z: stop.kz }) || inBuilding(stop.kx, stop.kz)) continue;
    stop.shelter = true;                                   // people only wait where there is one
    const y = ground(stop.kx, stop.kz) + LAYER.sidewalk, heading = Math.atan2(stop.ux, stop.uz), rx = -stop.uz, rz = stop.ux;
    const spot = (along, out) => [stop.kx + stop.ux * along + rx * out, stop.kz + stop.uz * along + rz * out];
    put('box', ...[spot(0, 0.2)[0], y + 2.5, spot(0, 0.2)[1]], heading, 1.3, 0.08, 3.8);             // roof
    put('panel', ...[spot(0, 0.78)[0], y + 1.3, spot(0, 0.78)[1]], heading, 0.05, 2.3, 3.6);         // glass back
    put('box', ...[spot(0, 0.52)[0], y + 0.45, spot(0, 0.52)[1]], heading, 0.36, 0.07, 2.2);         // bench
    for (const along of [-1.8, 1.8]) {
      const [x, z] = spot(along, -0.3);
      put('pole', x, y + 1.25, z, 0, 0.04, 2.5, 0.04);
      posts.push({ x, z, r: 0.1 });
    }
    const [sx, sz] = spot(2.8, -0.2), rect = cell(`stop:${stop.name}`, (g, w, h) => {
      g.fillStyle = '#f4f4f1';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#1d4f9e';
      g.fillRect(0, 0, 56, h);
      text(g, `800 17px ${FONT}`);
      g.fillText('버스', 28, h / 2 + 1);
      text(g, `700 ${stop.name.length > 7 ? 19 : 25}px ${FONT}`, '#15171a');
      g.fillText(stop.name, 56 + (w - 56) / 2, h / 2 + 2, w - 64);
    });
    put('pole', sx, y + 1.5, sz, 0, 0.045, 3, 0.045);
    posts.push({ x: sx, z: sz, r: 0.1 });
    if (rect) signs.add(new THREE.Vector3(sx, y + 2.75, sz), new THREE.Vector3(-stop.uz, 0, stop.ux), 1.4, 0.35, rect, true);
  }

  // ---------- parked cars ----------
  // Beside the access roads and car park aisles, clear of buildings and of every other carriageway.
  const parked = [], PARKED = ['sedan', 'hatch', 'suv', 'sedan', 'hatch', 'suv', 'van'];
  for (const road of zone.roads) {
    if (road.c !== 'drive' || road.k !== 'service' || road.br || road.tn || road.len < 14) continue;
    const p = road.p;
    let carry = 5;                                         // distance to the next parking space
    for (let i = 2; i < p.length && parked.length < 14; i += 2) {
      const ax = p[i - 2], az = p[i - 1], dx = p[i] - ax, dz = p[i + 1] - az, len = Math.hypot(dx, dz) || 1, ux = dx / len, uz = dz / len;
      for (; carry < len; carry += 6.3) {
        for (const side of [1, -1]) {
          if (rand() > 0.3 || parked.length >= 14) continue;
          const at = beside({ x: ax + ux * carry, z: az + uz * carry, ux, uz }, side * (road.w / 2 + 1.25));
          const ends = [-1.9, 0, 1.9].map(d => [at.x + ux * d, at.z + uz * d]);
          if (!owns(at.x, at.z) || ends.some(([x, z]) => !map.isLand(x, z) || inBuilding(x, z) || nearRoad(x, z, 1.2, 'drive', road))) continue;
          parked.push({ x: at.x, z: at.z, heading: Math.atan2(ux, uz) + (rand() < 0.5 ? Math.PI : 0), kind: PARKED[Math.floor(rand() * PARKED.length)], tint: rand() });
          for (const [x, z] of ends) posts.push({ x, z, r: 0.95 });
        }
      }
      carry -= len;
    }
  }

  // ---------- trees away from the streets ----------
  for (const row of zone.lines.filter(l => l.k === 'tree_row')) {
    for (let i = 2; i < row.p.length; i += 2) {
      const ax = row.p[i - 2], az = row.p[i - 1], dx = row.p[i] - ax, dz = row.p[i + 1] - az, n = Math.max(1, Math.round(Math.hypot(dx, dz) / 8));
      for (let k = 0; k < n; k++) tree(ax + dx * k / n, az + dz * k / n);
    }
  }
  // parks and woods: scattered over the part of each that lies in this zone
  for (const a of zone.areas.filter(a => a.k === 'park' || a.k === 'wood')) {
    const [ax, az, bx, bz] = boundsOf(a.p);
    const x0 = Math.max(ax, zone.x0), x1 = Math.min(bx, zone.x1), z0 = Math.max(az, zone.z0), z1 = Math.min(bz, zone.z1);
    if (x1 <= x0 || z1 <= z0) continue;
    const tries = Math.min(260, (x1 - x0) * (z1 - z0) / (a.k === 'wood' ? 110 : 140));
    for (let i = 0; i < tries; i++) {
      const x = x0 + rand() * (x1 - x0), z = z0 + rand() * (z1 - z0);
      if (pointInPolygon(x, z, a.p) && !nearRoad(x, z, 2.5, 'any')) tree(x, z);
    }
  }

  // ---------- meshes ----------
  const group = new THREE.Group();
  const lie = (x, z, it) => (it.low ? ctx.ground(x, z) : ctx.top(x, z));
  const paintY = (x, z, it) => lie(x, z, it) + LAYER.mark;
  // long lines are cut where the zone ends; short pieces (dashes, crossings) were already chosen whole
  const split = (items, color) => [
    ribbonMesh(items.filter(i => !i.whole), color, paintY, 5, { owns }), ribbonMesh(items.filter(i => i.whole), color, paintY, 5),
  ];
  const walk = ribbonMesh(sidewalks, 0xb9b6ae, (x, z, it) => lie(x, z, it) + LAYER.sidewalk, 4, { snow: 0.85, owns });
  group.add(walk, ribbonMesh(corners, 0xb9b6ae, (x, z) => ctx.top(x, z) + LAYER.sidewalk, 4, { snow: 0.85 }), ...split(white, 0xe8e8e2), ...split(yellow, 0xe0b62e), paintMesh(arrowPos, arrowIdx, 0xe8e8e2, 5));

  for (const [name, list] of Object.entries(inst)) {
    const [geo, mat] = kit.kinds[name], mesh = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((it, i) => {
      mesh.setMatrixAt(i, it.m);
      if (it.color) mesh.setColorAt(i, it.color);
    });
    mesh.castShadow = name === 'crown' || name === 'cone' || name === 'trunk' || name === 'pole' || name === 'concrete';
    mesh.receiveShadow = name === 'crown' || name === 'cone';
    list.forEach((it, i) => { if (it.lamp) signals.push({ mesh, i, ...it.lamp }); });
    group.add(mesh);
  }
  group.add(signs.build(kit.signs));

  const decals = [];
  if (lamps.length) {
    const poolMesh = new THREE.InstancedMesh(kit.poolShape, kit.pools, lamps.length);
    const up = new THREE.Vector3(0, 1, 0), normal = new THREE.Vector3();
    lamps.forEach((l, i) => {
      normal.set(ground(l.x - 2, l.z) - ground(l.x + 2, l.z), 4, ground(l.x, l.z - 2) - ground(l.x, l.z + 2)).normalize();
      dummy.position.set(l.x, ground(l.x, l.z) + LAYER.sidewalk + 0.03, l.z);
      dummy.quaternion.setFromUnitVectors(up, normal);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      poolMesh.setMatrixAt(i, dummy.matrix);
    });
    poolMesh.renderOrder = 1;
    const haloGeo = new THREE.BufferGeometry();
    haloGeo.setAttribute('position', new THREE.Float32BufferAttribute(lamps.flatMap(l => [l.x, l.y + 7.85, l.z]), 3));
    const haloMesh = new THREE.Points(haloGeo, kit.halos);
    haloMesh.renderOrder = 2;
    group.add(poolMesh, haloMesh);
    decals.push(poolMesh);
  }
  return { group, posts, lamps, decals, signals, parked };
}
