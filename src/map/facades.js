import * as THREE from 'three';
import { QuadBatch, FONT, seeded } from './atlas.js';
import { snowable, nightWindows } from './shared.js';

// One repeating facade tile per building style: tile size in metres and how to paint it.
const STYLES = {
  tower: {
    w: 3, h: 3.3, material: { roughness: 0.12, metalness: 0.7 },
    lit: 0.38,
    glass(g, S) { g.fillRect(6, 0, S / 2 - 9, S * 0.8); g.fillRect(S / 2 + 3, 0, S / 2 - 3, S * 0.8); },
    paint(g, S) {
      const sky = g.createLinearGradient(0, 0, 0, S);
      sky.addColorStop(0, '#7f9db8');
      sky.addColorStop(1, '#55718c');
      g.fillStyle = sky;
      g.fillRect(0, 0, S, S);
      g.fillStyle = '#3d5166';
      g.fillRect(0, S * 0.8, S, S * 0.2);                   // spandrel panel
      g.fillStyle = '#2a333c';
      g.fillRect(0, 0, 6, S);
      g.fillRect(S / 2 - 3, 0, 6, S * 0.8);
      g.fillRect(0, S - 6, S, 6);
    },
  },
  apartment: {
    w: 4, h: 2.9, material: { roughness: 0.85 },
    lit: 0.5,
    glass(g, S) { g.fillRect(S * 0.1 + 5, S * 0.2 + 5, S * 0.8 - 5, S * 0.62 - 5); },
    paint(g, S) {
      g.fillStyle = '#ebe6da';
      g.fillRect(0, 0, S, S);
      g.fillStyle = '#d3cdbf';
      g.fillRect(0, S * 0.84, S, S * 0.16);                 // balcony slab
      g.fillStyle = '#566b7c';
      g.fillRect(S * 0.1, S * 0.2, S * 0.8, S * 0.62);       // balcony glazing
      g.fillStyle = '#f4f1ea';
      for (const x of [0.1, 0.36, 0.62, 0.88]) g.fillRect(S * x, S * 0.2, 5, S * 0.62);
      g.fillRect(S * 0.1, S * 0.2, S * 0.8, 5);
    },
  },
  shop: {
    w: 4, h: 3.8, material: { roughness: 0.8 },
    lit: 0.62,
    glass(g, S) { g.fillRect(S * 0.05, S * 0.3, S * 0.9, S * 0.58); },
    paint(g, S) {
      g.fillStyle = '#c8c3ba';
      g.fillRect(0, 0, S, S);
      g.fillStyle = '#44535f';
      g.fillRect(S * 0.05, S * 0.3, S * 0.9, S * 0.58);
      g.fillStyle = '#aeb3b8';
      g.fillRect(S * 0.49, S * 0.3, 5, S * 0.58);
    },
  },
  office: {
    w: 3.2, h: 3.6, material: { roughness: 0.4, metalness: 0.3 },
    lit: 0.3,
    glass(g, S) { g.fillRect(S * 0.08, S * 0.18, S * 0.38, S * 0.6); g.fillRect(S * 0.54, S * 0.18, S * 0.38, S * 0.6); },
    paint(g, S) {
      g.fillStyle = '#b4b9bf';
      g.fillRect(0, 0, S, S);
      g.fillStyle = '#3f5468';
      g.fillRect(S * 0.08, S * 0.18, S * 0.38, S * 0.6);
      g.fillRect(S * 0.54, S * 0.18, S * 0.38, S * 0.6);
    },
  },
  civic: {
    w: 3.6, h: 3.5, material: { roughness: 0.9 },
    lit: 0.12,
    glass(g, S) { g.fillRect(S * 0.2, S * 0.22, S * 0.6, S * 0.5); },
    paint(g, S) {
      g.fillStyle = '#b58a6c';
      g.fillRect(0, 0, S, S);
      g.fillStyle = 'rgba(0,0,0,0.08)';
      for (let y = 0; y < S; y += 16) g.fillRect(0, y, S, 2);
      g.fillStyle = '#4c5f6e';
      g.fillRect(S * 0.2, S * 0.22, S * 0.6, S * 0.5);
      g.fillStyle = '#e8e2d6';
      g.fillRect(S * 0.49, S * 0.22, 5, S * 0.5);
    },
  },
};

function styleOf(b) {
  if (b.h >= 100) return 'tower';
  if (b.t === 'apartments' || b.t === 'residential') return 'apartment';
  if (['school', 'kindergarten', 'public', 'university', 'hospital'].includes(b.t)) return 'civic';
  if (b.h > 40 || b.t === 'office' || b.t === 'hotel') return 'office';
  return 'shop';
}

// The facade tile, or with `glass` its glazing as white on black (the part that lights up at night).
function tileTexture(style, glass = false) {
  const canvas = document.createElement('canvas'), g = canvas.getContext('2d');
  canvas.width = canvas.height = 256;
  if (glass) {
    g.fillStyle = '#000';
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#fff';
    style.glass(g, 256);
  } else style.paint(g, 256);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// Invented shop names: no real businesses or brands.
const NAME_A = ['해든', '바다', '동백', '마루', '새봄', '한빛', '달맞이', '미포', '청사포', '가온', '누리', '다온', '솔', '하늘', '은하', '파도', '등대', '갈매기'];
const NAME_B = ['약국', '치과', '부동산', '카페', '횟집', '김밥', '미용실', '학원', '편의점', '안경', '꽃집', '분식', '국밥', '노래방', '세탁', '한의원', '베이커리', '치킨', '내과', '필라테스'];
const SIGN_COLOURS = [['#ffffff', '#c8102e'], ['#c8102e', '#ffffff'], ['#1f4fa8', '#ffffff'], ['#ffffff', '#1f4fa8'], ['#1e7a46', '#ffffff'], ['#f2c41d', '#1b1b1b'], ['#1b1b1b', '#f2c41d'], ['#ffffff', '#1b1b1b']];

// Materials shared by the buildings of every zone.
// atlas: wide cells for horizontal signs; tallAtlas: narrow tall cells for hanging signs.
export function createFacadeKit(atlas, tallAtlas) {
  const walls = Object.fromEntries(Object.entries(STYLES).map(([key, style]) => [key, nightWindows(new THREE.MeshStandardMaterial({
    map: tileTexture(style), emissiveMap: tileTexture(style, true), emissive: 0xffffff, emissiveIntensity: 1.0,
    vertexColors: true, ...style.material,
  }), style.lit)]));
  const lit = texture => new THREE.MeshStandardMaterial({
    map: texture, alphaTest: 0.5, roughness: 0.6, emissiveMap: texture, emissive: 0xffffff, emissiveIntensity: 0.12,
  });
  return {
    atlas, tallAtlas, walls, signs: lit(atlas.texture), blades: lit(tallAtlas.texture),      // the signs glow after dark
    roof: snowable(new THREE.MeshStandardMaterial({ color: 0x8b8d8f, roughness: 0.95, side: THREE.DoubleSide }), 0.9),
  };
}

// Walls and roofs for a list of buildings with a facade per style, plus shop signs and apartment
// block numbers. `seed` varies the signs from one batch to the next.
export function buildFacades(buildings, ground, kit, seed = 0) {
  const { atlas, tallAtlas } = kit, rand = seeded(11 + seed);
  const walls = Object.fromEntries(Object.keys(STYLES).map(k => [k, { pos: [], nor: [], uv: [], col: [], idx: [] }]));
  const roof = { pos: [], idx: [] };
  const signs = new QuadBatch(atlas), blades = new QuadBatch(tallAtlas);

  // The atlases hold a fixed number of cells, so signs are drawn from a limited pool of designs.
  const pick = (pool, list) => list[Math.floor(seeded(pool)() * list.length)];
  const shopSign = () => {
    const design = Math.floor(rand() * 120);
    const name = pick(design, NAME_A) + pick(design + 1000, NAME_B);
    const [bg, fg] = pick(design + 2000, SIGN_COLOURS);
    return atlas.add(`shop:${name}:${bg}`, (g, w, h) => {
      g.fillStyle = bg;
      g.fillRect(0, 0, w, h);
      g.fillStyle = fg;
      g.font = `800 ${name.length > 5 ? 34 : 40}px ${FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(name, w / 2, h / 2 + 2);
    });
  };
  const bladeSign = () => {
    const design = Math.floor(rand() * 28);
    const name = pick(design + 3000, NAME_B);
    const [bg, fg] = pick(design + 4000, SIGN_COLOURS);
    return tallAtlas.add(`blade:${name}:${bg}`, (g, w, h) => {
      g.fillStyle = bg;
      g.fillRect(0, 0, w, h);
      g.fillStyle = fg;
      g.font = `800 44px ${FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const step = Math.min(56, (h - 20) / name.length);
      [...name].forEach((ch, i) => g.fillText(ch, w / 2, h / 2 + (i - (name.length - 1) / 2) * step));
    });
  };
  const blockNumber = text => atlas.add(`block:${text}`, (g, w, h) => {
    g.fillStyle = '#2c4a6e';
    g.font = `800 58px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2 + 3);
  });

  buildings.forEach((b, index) => {
    const key = styleOf(b), style = STYLES[key], out = walls[key], n = b.p.length / 2;
    let area = 0, lo = Infinity, sum = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, x = b.p[i * 2], z = b.p[i * 2 + 1], h = ground(x, z);
      area += x * b.p[j * 2 + 1] - b.p[j * 2] * z;
      lo = Math.min(lo, h);
      sum += h;
    }
    const sign = area > 0 ? 1 : -1;            // footprint winding decides which side is outside
    const street = sum / n, base = lo - 0.5, top = street + b.h;
    const floors = Math.max(1, Math.round(b.h / style.h)), floorH = b.h / floors;
    const shade = 0.9 + ((index + seed) * 37 % 17) / 17 * 0.14;
    const edges = [];

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, ax = b.p[i * 2], az = b.p[i * 2 + 1], bx = b.p[j * 2], bz = b.p[j * 2 + 1];
      const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      const nx = sign * dz / len, nz = -sign * dx / len, bays = Math.max(1, Math.round(len / style.w));
      const k = out.pos.length / 3, v0 = (base - street) / floorH;
      out.pos.push(ax, base, az, bx, base, bz, bx, top, bz, ax, top, az);
      out.uv.push(0, v0, bays, v0, bays, floors, 0, floors);
      for (let c = 0; c < 4; c++) { out.nor.push(nx, 0, nz); out.col.push(shade, shade, shade); }
      if (sign > 0) out.idx.push(k, k + 2, k + 1, k, k + 3, k + 2); else out.idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
      edges.push({ ax, az, dx: dx / len, dz: dz / len, len, nx, nz });
    }

    // roof
    const contour = [];
    for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(b.p[i * 2], b.p[i * 2 + 1]));
    const k = roof.pos.length / 3;
    for (const v of contour) roof.pos.push(v.x, top, v.y);
    for (const tri of THREE.ShapeUtils.triangulateShape(contour, [])) roof.idx.push(k + tri[0], k + tri[1], k + tri[2]);

    // A sign lying flat on a wall: `along` metres from the edge start, facing outwards.
    const onWall = (e, along, y, out2 = 0.12) => new THREE.Vector3(e.ax + e.dx * along + e.nx * out2, y, e.az + e.dz * along + e.nz * out2);
    const wallRight = e => new THREE.Vector3(e.nz, 0, -e.nx);

    if (key === 'shop' || key === 'office') {
      const levels = key === 'shop' ? Math.min(4, floors) : 1;
      for (const e of edges) {
        if (e.len < 6) continue;
        const count = Math.floor(e.len / 4.2), width = e.len / count;
        for (let level = 1; level <= levels; level++) {
          for (let c = 0; c < count; c++) {
            if (rand() < 0.2) continue;
            signs.add(onWall(e, (c + 0.5) * width, street + level * floorH - 0.5), wallRight(e), width - 0.3, 0.9, shopSign());
          }
        }
        if (key === 'shop' && floors >= 2) {
          for (let along = 4; along < e.len - 2; along += 9) {
            if (rand() < 0.4) continue;
            const c = onWall(e, along, street + Math.min(b.h - 2, 6.5), 0.6);
            blades.add(c, new THREE.Vector3(e.nx, 0, e.nz), 0.8, 3.2, bladeSign(), true);
          }
        }
      }
    }
    // Apartment blocks carry their number high on the end walls.
    const number = key === 'apartment' && /^(\d{2,4}|[A-Z])동?$/.exec(b.n);
    if (number) {
      const ends = edges.filter(e => e.len >= 7).sort((p, q) => p.len - q.len).slice(0, 2);
      for (const e of ends) {
        const width = Math.min(6, e.len * 0.6);
        signs.add(onWall(e, e.len / 2, top - 4.5, 0.08), wallRight(e), width, width / 4, blockNumber(number[1]));
      }
    }
  });

  const group = new THREE.Group();
  for (const [key, w] of Object.entries(walls)) {
    if (!w.idx.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(w.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(w.nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(w.uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(w.col, 3));
    geo.setIndex(w.idx);
    const mesh = new THREE.Mesh(geo, kit.walls[key]);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  const roofGeo = new THREE.BufferGeometry();
  roofGeo.setAttribute('position', new THREE.Float32BufferAttribute(roof.pos, 3));
  roofGeo.setIndex(roof.idx);
  roofGeo.computeVertexNormals();
  const roofMesh = new THREE.Mesh(roofGeo, kit.roof);
  roofMesh.castShadow = true;
  group.add(roofMesh, signs.build(kit.signs), blades.build(kit.blades));
  return group;
}
