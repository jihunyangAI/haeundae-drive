import * as THREE from 'three';
import { limitOf } from './network.js';
import { ribbonMesh, paintMesh, LAYER } from './meshes.js';
import { laneSplit } from './lanes.js';
import { pointInPolygon, boundsOf } from './data.js';
import { QuadBatch, FONT, seeded } from './atlas.js';
import { snowable } from './shared.js';

const KERBED = /^(trunk|primary|secondary|tertiary|residential|unclassified|living_street)$/;
const SIDEWALK_W = 3;
export const LAMP_COLOURS = { red: 0xff2a1a, amber: 0xffb000, green: 0x18e07a, arrow: 0x18e07a };

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
  kinds.lamp = [new THREE.CircleGeometry(1, 16), signalLamp];
  kinds.arrowLamp = [new THREE.ShapeGeometry(arrow), signalLamp];

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
// ctx: { map, ground, atlas, kit, nearRoad } - nearRoad(x, z, margin, kind, except) tells whether a
// road of that kind ('drive' or 'any') lies within `margin` metres of its edge.
// zone: { owns, streets, outlines, areas, lines, seed, x0, z0, x1, z1 }.
// Streets are worked out whole and each zone keeps what falls inside it, so zones agree at their edges.
// Returns { group, posts, lamps, decals, signals } - posts are the solid poles and trunks; signals are
// the lamps of the signal heads, { mesh, i, arm, role }, for the world to switch on and off.
export function buildStreets(ctx, zone) {
  const { map, ground, atlas, kit, nearRoad } = ctx, { owns } = zone, rand = seeded(7 + zone.seed);
  const white = [], yellow = [], sidewalks = [], posts = [], lamps = [];
  const signs = new QuadBatch(atlas);
  const inst = {};
  const dummy = new THREE.Object3D();
  const put = (name, x, y, z, heading, sx, sy, sz, color, lamp) => {
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, heading, 0);
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
  const tree = (x, z, own) => {
    if (!owns(x, z) || inBuilding(x, z) || !map.isLand(x, z) || nearRoad(x, z, 0.8, 'drive', own)) return;
    const y = ground(x, z), rw = 1.5 + rand() * 0.9, rh = 1.8 + rand() * 1.0, turn = rand() * 6.28;
    put('trunk', x, y + 1.6, z, 0, 0.16, 3.2, 0.16);
    put('crown', x, y + 2.9 + rh * 0.6, z, turn, rw, rh, rw, new THREE.Color().setHSL(0.24 + rand() * 0.1, 0.42, 0.2 + rand() * 0.1));
    posts.push({ x, z, r: 0.25 });
  };

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
  function signal(f, half, armLen, ahead, arm) {
    const heading = Math.atan2(f.ux, f.uz);
    const base = beside(f, half + 0.9, ahead), y = base.y;
    if (!owns(base.x, base.z) || blocked(base, f.road) || inBuilding(base.x, base.z)) return;
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

  // does the stretch s0..s1 of a street come within `reach` metres of this zone?
  const touches = (st, s0, s1, reach) => {
    const [ax, az, bx, bz] = boundsOf(st.slice(s0, s1));
    return bx > zone.x0 - reach && ax < zone.x1 + reach && bz > zone.z0 - reach && az < zone.z1 + reach;
  };
  const ownsAt = f => owns(f.x, f.z);

  for (const st of zone.streets) {
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
    if (!KERBED.test(r.k)) continue;
    for (const iv of st.intervals(c => c.half + SIDEWALK_W + 0.5)) {
      if (!touches(st, iv.s0, iv.s1, half + 20)) continue;
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
      for (let s = iv.s0 + 5; s < iv.s1 - 3; s += 13) {
        if (Math.abs((s - iv.s0 - 18) % 36) < 3) continue;     // keep clear of the lamps
        const f = st.at(s);
        for (const sd of [-1, 1]) { const at = beside(f, sd * (half + 2.1)); tree(at.x, at.z, r); }
      }
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
  const paintY = (x, z) => ground(x, z) + LAYER.mark;
  // long lines are cut where the zone ends; short pieces (dashes, crossings) were already chosen whole
  const split = (items, color) => [
    ribbonMesh(items.filter(i => !i.whole), color, paintY, 5, { owns }), ribbonMesh(items.filter(i => i.whole), color, paintY, 5),
  ];
  const walk = ribbonMesh(sidewalks, 0xb9b6ae, (x, z) => ground(x, z) + LAYER.sidewalk, 4, { snow: 0.85, owns });
  group.add(walk, ...split(white, 0xe8e8e2), ...split(yellow, 0xe0b62e), paintMesh(arrowPos, arrowIdx, 0xe8e8e2, 5));

  for (const [name, list] of Object.entries(inst)) {
    const [geo, mat] = kit.kinds[name], mesh = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((it, i) => {
      mesh.setMatrixAt(i, it.m);
      if (it.color) mesh.setColorAt(i, it.color);
    });
    mesh.castShadow = name === 'crown' || name === 'trunk' || name === 'pole';
    mesh.receiveShadow = name === 'crown';
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
  return { group, posts, lamps, decals, signals };
}
