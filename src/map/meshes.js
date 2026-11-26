import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { pointInPolygon, GROUND_CELL } from './data.js';
import { snowable, wetRoad } from './shared.js';

// The ground-level parts of one zone: terrain, road surfaces, footpaths and the waterfront.
// A zone is { x0, z0, x1, z1, owns(x, z), areas, lines }. Long things that run through several zones
// are built whole and then only the pieces a zone owns are kept, so neighbouring zones meet exactly.

const AREA_COLOR = { park: 0x86b56f, pitch: 0x9cc47f, wood: 0x4f7f4a, beach: 0xdccfa6, farm: 0xa8b56a };
const LAND = new THREE.Color(0xa9a69d), SHORE = new THREE.Color(0xcdc19c);
const cache = new Map();
const once = (key, make) => { if (!cache.has(key)) cache.set(key, make()); return cache.get(key); };

export function buildTerrain(zone, hAt) {
  const size = zone.x1 - zone.x0, seg = Math.round(size / GROUND_CELL);     // vertices sit on the ground grid
  const geo = new THREE.PlaneGeometry(size, size, seg, seg).rotateX(-Math.PI / 2).translate((zone.x0 + zone.x1) / 2, 0, (zone.z0 + zone.z1) / 2);
  const pos = geo.attributes.position, nor = geo.attributes.normal, colors = new Float32Array(pos.count * 3), c = new THREE.Color();
  const tinted = zone.areas.filter(a => AREA_COLOR[a.k]).map(a => ({ p: a.p, color: new THREE.Color(AREA_COLOR[a.k]) }));
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i), h = hAt(x, z);
    pos.setY(i, h);
    // slope straight from the height field, so the shading has no seam where two zones meet
    n.set(hAt(x - GROUND_CELL, z) - hAt(x + GROUND_CELL, z), 2 * GROUND_CELL, hAt(x, z - GROUND_CELL) - hAt(x, z + GROUND_CELL)).normalize();
    nor.setXYZ(i, n.x, n.y, n.z);
    c.copy(h < 1.5 ? SHORE : LAND);
    for (const a of tinted) if (pointInPolygon(x, z, a.p)) { c.copy(a.color); break; }
    c.toArray(colors, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(geo, once('terrain', () => snowable(new THREE.MeshLambertMaterial({ vertexColors: true }), 0.92)));
  mesh.receiveShadow = true;
  return mesh;
}

// The whole map's ground as one coarse sheet, for the distance: hills and shores beyond the zones that
// are built in detail. It is kept a little under the true ground everywhere, so that where a zone is
// built its own ground covers it.
export function buildFarTerrain(map, hAt) {
  const STEP = 40, nx = Math.round((map.x1 - map.x0) / STEP), nz = Math.round((map.z1 - map.z0) / STEP);
  const geo = new THREE.PlaneGeometry(map.x1 - map.x0, map.z1 - map.z0, nx, nz).rotateX(-Math.PI / 2).translate((map.x0 + map.x1) / 2, 0, (map.z0 + map.z1) / 2);
  const pos = geo.attributes.position, colors = new Float32Array(pos.count * 3), c = new THREE.Color(), WOOD = new THREE.Color(0x5d7f58);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    let low = Infinity;
    for (let dx = -20; dx <= 20; dx += 10) for (let dz = -20; dz <= 20; dz += 10) low = Math.min(low, hAt(x + dx, z + dz));
    pos.setY(i, low - 1.2);
    // the hills are wooded; the low ground is town
    c.copy(LAND).lerp(WOOD, Math.min(1, Math.max(0, (low - 35) / 60)));
    c.toArray(colors, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, once('farTerrain', () => snowable(new THREE.MeshLambertMaterial({ vertexColors: true }), 0.92)));
}

// Split a flat [x, z, ...] polyline so no segment is longer than `step` metres.
function resample(p, step) {
  const out = [[p[0], p[1]]];
  for (let i = 2; i < p.length; i += 2) {
    const ax = p[i - 2], az = p[i - 1], dx = p[i] - ax, dz = p[i + 1] - az;
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / step));
    for (let k = 1; k <= n; k++) out.push([ax + dx * k / n, az + dz * k / n]);
  }
  return out;
}

// Height of each ground layer above the terrain, metres. Layers also get a depth offset (see
// ribbonMesh) because at a distance these gaps are smaller than the depth buffer can resolve.
export const LAYER = { path: 0.04, minor: 0.05, major: 0.07, mark: 0.09, sidewalk: 0.2 };

// Append a flat strip following the polyline to the position / index arrays.
// `offset` shifts the strip sideways, positive to the right of the direction of travel.
// With `owns`, only the stretches whose middle it accepts are kept.
function ribbon(p, width, yOf, positions, indices, offset = 0, owns = null) {
  const pts = resample(p, 5), half = width / 2;
  const kept = i => !owns || owns((pts[i][0] + pts[i - 1][0]) / 2, (pts[i][1] + pts[i - 1][1]) / 2);   // the stretch ending at point i
  let prev = -1;                      // where the previous cross-section's two vertices are, if it was written
  pts.forEach(([px, pz], i) => {
    const before = i > 0 && kept(i), after = i < pts.length - 1 && kept(i + 1);
    if (!before && !after) { prev = -1; return; }
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const rx = -(b[1] - a[1]) / len, rz = (b[0] - a[0]) / len;
    const x = px + rx * offset, z = pz + rz * offset, nx = rx * half, nz = rz * half, k = positions.length / 3;
    positions.push(x + nx, yOf(x + nx, z + nz), z + nz, x - nx, yOf(x - nx, z - nz), z - nz);
    if (before && prev >= 0) indices.push(prev, prev + 1, k, prev + 1, k + 1, k);
    prev = k;
  });
}

// items: [{ p, w, o }] - polyline, width, optional sideways offset. `depth` orders coplanar layers:
// higher draws on top. `snow` is how white the surface turns under snow; `glossy` gives the wet-road
// material. Materials are shared by every zone.
export function ribbonMesh(items, color, yOf, depth = 1, { snow = 0, glossy = false, owns = null } = {}) {
  const positions = [], indices = [];
  for (const it of items) ribbon(it.p, it.w, (x, z) => yOf(x, z, it), positions, indices, it.o, owns);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, ribbonMaterial(color, depth, snow, glossy));
  mesh.receiveShadow = true;
  mesh.visible = indices.length > 0;
  return mesh;
}

const ribbonMaterial = (color, depth, snow, glossy) => once(`ribbon:${color}:${depth}:${snow}:${glossy}`, () => {
  const options = { color, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 * depth, polygonOffsetUnits: -8 * depth };
  const m = glossy ? new THREE.MeshStandardMaterial({ ...options, roughness: 0.92 }) : new THREE.MeshLambertMaterial(options);
  if (glossy) m.userData.dry = m.color.clone();
  return glossy ? wetRoad(m, snow) : snow ? snowable(m, snow) : m;
});

// Flat painted shapes (arrows and the like) given as triangles, in the same paint as the ribbons.
export function paintMesh(positions, indices, color, depth = 1) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, ribbonMaterial(color, depth, 0, false));
  mesh.receiveShadow = true;
  mesh.visible = indices.length > 0;
  return mesh;
}

export const BRIDGE_LIFT = 7;   // placeholder height per bridge layer; real deck heights are not in the data

// The carriageway materials made so far, so the weather can wet them.
export const tarmacMaterials = () => [...cache.entries()].filter(([key]) => key.endsWith(':true')).map(([, m]) => m);

// roads: the roads that pass through or near the zone. A road lies on the uppermost surface (a bridge's
// deck, the lid of an underpass) unless it is one that passes underneath.
export function buildRoads(roads, map, owns) {
  const hAt = map.ground, lie = (x, z, r) => map.heightFor(r)(x, z);
  const major = k => /^(motorway|trunk|primary|secondary)/.test(k);
  const drive = roads.filter(r => r.c === 'drive' && (!r.br || r.dk));
  const group = new THREE.Group(), tarmac = { snow: 0.5, glossy: true, owns };
  group.add(
    ribbonMesh(drive.filter(r => !major(r.k)), 0x4a4d53, (x, z, r) => lie(x, z, r) + LAYER.minor, 2, tarmac),
    ribbonMesh(drive.filter(r => major(r.k)), 0x34373c, (x, z, r) => lie(x, z, r) + LAYER.major, 3, tarmac),
    ribbonMesh(roads.filter(r => r.c === 'drive' && r.br && !r.dk), 0x7c7f84, (x, z, r) => Math.max(0, hAt(x, z)) + r.br * BRIDGE_LIFT, 1, { owns }),
  );
  return group;
}

export function buildWalkways(roads, map, owns) {
  return ribbonMesh(roads.filter(r => r.c === 'walk'), 0xd9c9a3, (x, z, r) => (r.lie ? r.lie(x, z) : map.heightFor(null)(x, z)) + LAYER.path, 1, { snow: 0.85, owns });
}

// Coastline, waterways and the marina piers.
export function buildWaterfront(zone, hAt) {
  const group = new THREE.Group(), owns = zone.owns;
  const of = (kinds, w) => zone.lines.filter(l => kinds.includes(l.k)).map(l => ({ p: l.p, w }));
  group.add(
    ribbonMesh(of(['coast'], 2), 0xffffff, () => 0.7, 1, { owns }),
    ribbonMesh(of(['river'], 8).concat(of(['stream'], 3)), 0x4f86b0, (x, z) => hAt(x, z) + 0.2, 1, { owns }),
    ribbonMesh(of(['pier'], 3), 0x8d8a82, () => 1.2, 1, { owns }),
    ribbonMesh(of(['breakwater'], 9), 0x9a9890, () => 1.9, 1, { owns }),
  );
  // a pier is drawn by the zone that holds its middle
  const middle = p => { let x = 0, z = 0; for (let i = 0; i < p.length; i += 2) { x += p[i]; z += p[i + 1]; } return [x / (p.length / 2), z / (p.length / 2)]; };
  const piers = zone.areas.filter(a => (a.k === 'pier' || a.k === 'breakwater') && owns(...middle(a.p))).map(a => {
    const shape = new THREE.Shape();
    for (let i = 0; i < a.p.length; i += 2) {
      if (i === 0) shape.moveTo(a.p[0], -a.p[1]); else shape.lineTo(a.p[i], -a.p[i + 1]);
    }
    return new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(0, 1.2, 0);
  });
  if (piers.length) group.add(new THREE.Mesh(mergeGeometries(piers), once('pier', () => new THREE.MeshLambertMaterial({ color: 0x8d8a82, side: THREE.DoubleSide }))));
  return group;
}
