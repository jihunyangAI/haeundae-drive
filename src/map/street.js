import * as THREE from 'three';
import { limitOf } from './network.js';
import { ribbonMesh, LAYER } from './meshes.js';
import { pointInPolygon, boundsOf } from './data.js';
import { QuadBatch, FONT, seeded } from './atlas.js';
import { snowable } from './shared.js';

const SIGNALISED = /^(trunk|primary|secondary|tertiary)$/;
const KERBED = /^(trunk|primary|secondary|tertiary|residential|unclassified|living_street)$/;
const JUNCTION_CLEAR = 6;      // markings stop this far short of the crossing street's edge
const SIDEWALK_W = 3;
const CYCLE = 46, GREEN = 20, AMBER = 3;   // signal timing, seconds
const LAMP_COLOURS = { red: 0xff2a1a, amber: 0xffb000, green: 0x18e07a };

// Materials and shapes shared by the street furniture of every zone.
// update(time) runs the signals; lampGlow, pools, halos and signs are driven by the time of day.
export function createStreetKit(atlas) {
  const metal = new THREE.MeshStandardMaterial({ color: 0x5b6067, roughness: 0.6, metalness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c1e21, roughness: 0.7 });
  const lampGlow = new THREE.MeshStandardMaterial({ color: 0xdedede, emissive: 0xffe2b0, emissiveIntensity: 0 });
  const cylinder = new THREE.CylinderGeometry(1, 1, 1, 8), box = new THREE.BoxGeometry(1, 1, 1);
  const kinds = {
    pole: [cylinder, metal], box: [box, dark], lampHead: [box, lampGlow],
    trunk: [new THREE.CylinderGeometry(0.8, 1, 1, 6), new THREE.MeshStandardMaterial({ color: 0x4b3a2b, roughness: 0.9 })],
    crown: [new THREE.IcosahedronGeometry(1, 1), snowable(new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), 0.6)],
  };
  const lampMats = {}, disc = new THREE.CircleGeometry(1, 16);
  for (const colour of Object.keys(LAMP_COLOURS)) {
    for (const phase of [0, 1]) {
      lampMats[colour + phase] = new THREE.MeshStandardMaterial({ color: 0x151515, emissive: LAMP_COLOURS[colour], emissiveIntensity: 0 });
      kinds[colour + phase] = [disc, lampMats[colour + phase]];
    }
  }

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

  // Opposite phases for the two crossing directions: green, amber, then red while the other runs.
  function update(time) {
    for (const phase of [0, 1]) {
      const t = (time + phase * CYCLE / 2) % CYCLE;
      const on = t < GREEN ? 'green' : t < GREEN + AMBER ? 'amber' : 'red';
      for (const colour of Object.keys(LAMP_COLOURS)) lampMats[colour + phase].emissiveIntensity = colour === on ? 4 : 0.04;
    }
  }
  update(0);
  return { kinds, lampGlow, pools, halos, signs, poolShape: new THREE.CircleGeometry(17, 24).rotateX(-Math.PI / 2), update };
}

// Road paint, kerbs, signals, lamps, signs and trees for one zone.
// ctx: { map, ground, atlas, kit, nearRoad } - nearRoad(x, z, margin, kind, except) tells whether a
// road of that kind ('drive' or 'any') lies within `margin` metres of its edge.
// zone: { owns, streets, outlines, areas, lines, seed, x0, z0, x1, z1 }.
// Streets are worked out whole and each zone keeps what falls inside it, so zones agree at their edges.
// Returns { group, posts, lamps, decals } - posts are the solid poles and trunks.
export function buildStreets(ctx, zone) {
  const { map, ground, atlas, kit, nearRoad } = ctx, { owns } = zone, rand = seeded(7 + zone.seed);
  const white = [], yellow = [], sidewalks = [], posts = [], lamps = [];
  const signs = new QuadBatch(atlas);
  const inst = {};
  const dummy = new THREE.Object3D();
  const put = (name, x, y, z, heading, sx, sy, sz, color) => {
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, heading, 0);
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();
    (inst[name] ||= []).push({ m: dummy.matrix.clone(), color });
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
  function signal(f, half, armLen, ahead) {
    const heading = Math.atan2(f.ux, f.uz), phase = Math.abs(Math.round(heading / (Math.PI / 2))) % 2;
    const base = beside(f, half + 0.9, ahead), y = base.y;
    if (!owns(base.x, base.z) || blocked(base, f.road) || inBuilding(base.x, base.z)) return;
    put('pole', base.x, y + 3.2, base.z, 0, 0.1, 6.4, 0.1);
    posts.push({ x: base.x, z: base.z, r: 0.2 });
    const arm = beside(f, half + 0.9 - armLen / 2, ahead), head = beside(f, half + 0.9 - armLen + 0.9, ahead);
    put('box', arm.x, y + 6.2, arm.z, heading, armLen, 0.12, 0.12);
    put('box', head.x, y + 6.15, head.z, heading, 1.5, 0.46, 0.26);
    // seen by the driver, left to right: red, amber, green
    [['red', -0.47], ['amber', 0], ['green', 0.47]].forEach(([colour, shift]) => {
      const lamp = beside(f, half + 0.9 - armLen + 0.9 + shift, ahead - 0.14);
      put(`${colour}${phase}`, lamp.x, y + 6.15, lamp.z, heading + Math.PI, 0.16, 0.16, 1);
    });
  }

  // does the stretch s0..s1 of a street come within `reach` metres of this zone?
  const touches = (st, s0, s1, reach) => {
    const [ax, az, bx, bz] = boundsOf(st.slice(s0, s1));
    return bx > zone.x0 - reach && ax < zone.x1 + reach && bz > zone.z0 - reach && az < zone.z1 + reach;
  };
  const ownsAt = f => owns(f.x, f.z);

  for (const st of zone.streets) {
    const r = st.road, ln = r.ln, half = r.w / 2, laneW = (r.w - 1) / ln, twoWay = !r.ow;
    const reverse = f => ({ x: f.x, z: f.z, ux: -f.ux, uz: -f.uz });

    // ---------- paint ----------
    for (const iv of st.intervals(c => c.half + JUNCTION_CLEAR)) {
      if (!touches(st, iv.s0, iv.s1, half + 60)) continue;
      const p = st.slice(iv.s0, iv.s1);
      white.push({ p, w: 0.15, o: half - 0.35 }, { p, w: 0.15, o: -(half - 0.35) });
      for (let k = 1; k < ln; k++) {
        const o = (k - ln / 2) * laneW;
        if (twoWay && k === ln / 2) {
          if (ln >= 4) yellow.push({ p, w: 0.15, o: -0.17 }, { p, w: 0.15, o: 0.17 });
          else yellow.push({ p, w: 0.15, o: 0 });
        } else {
          for (let s = iv.s0 + 1; s + 3 <= iv.s1; s += 8) if (ownsAt(st.at(s + 1.5))) white.push({ p: st.slice(s, s + 3), w: 0.15, o, whole: true });
        }
      }
      // stop line and zebra crossing where the stretch meets a junction
      // dir: +1 when the junction lies ahead of s, -1 behind. stop: the lanes that have to wait here.
      const approach = (s, dir, stop) => {
        if (!ownsAt(st.at(s))) return;
        if (stop) white.push({ p: st.slice(Math.min(s, s - dir * 0.45), Math.max(s, s - dir * 0.45)), ...stop, whole: true });
        for (let x = -half + 0.7; x <= half - 0.7; x += 1) {
          white.push({ p: st.slice(Math.min(s + dir, s + dir * 4.5), Math.max(s + dir, s + dir * 4.5)), w: 0.5, o: x, whole: true });
        }
      };
      if (iv.endJ) approach(iv.s1, 1, twoWay ? { o: half / 2, w: half - 0.5 } : { o: 0, w: r.w - 1 });
      if (iv.startJ) approach(iv.s0, -1, twoWay ? { o: -half / 2, w: half - 0.5 } : null);

      // signals where two through streets meet
      const lit = cut => cut && SIGNALISED.test(r.k) && cut.junction.roads.filter(o => SIGNALISED.test(o.k)).length >= 2
        && cut.junction.roads.some(o => o.n !== r.n);
      const across = cut => 2 * (cut.half + JUNCTION_CLEAR) - 1.5;
      if (lit(iv.endJ)) signal({ ...st.at(iv.s1), road: r }, half, twoWay ? half * 0.9 : r.w * 0.8, across(iv.endJ));
      if (twoWay && lit(iv.startJ)) signal({ ...reverse(st.at(iv.s0)), road: r }, half, half * 0.9, across(iv.startJ));

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
      if (r.n && iv.startJ) {
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
  group.add(walk, ...split(white, 0xe8e8e2), ...split(yellow, 0xe0b62e));

  for (const [name, list] of Object.entries(inst)) {
    const [geo, mat] = kit.kinds[name], mesh = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((it, i) => {
      mesh.setMatrixAt(i, it.m);
      if (it.color) mesh.setColorAt(i, it.color);
    });
    mesh.castShadow = name === 'crown' || name === 'trunk' || name === 'pole';
    mesh.receiveShadow = name === 'crown';
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
  return { group, posts, lamps, decals };
}
