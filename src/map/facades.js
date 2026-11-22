import * as THREE from 'three';
import { QuadBatch, FONT, seeded } from './atlas.js';
import { snowable, nightWindows } from './shared.js';
import { pointInPolygon } from './data.js';

// Buildings: walls tiled with a facade picture per style, a ground floor of its own (shop fronts, lobby
// or plinth), roofs with parapets and plant, balconies, awnings, signs. Each style comes in a couple of
// variants, and every building varies them a little in tint, bay width and storey height.
//
// A style: tile size w x h in metres, `ground` the height of the ground floor and `front` what it is
// ('store' for shop windows, or a colour for a plain band), `lit` the share of windows lit at night.
const STYLES = {
  tower0: {
    w: 3, h: 3.3, ground: 6, front: 0x2b3540, material: { roughness: 0.12, metalness: 0.7 }, lit: 0.38,
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
  tower1: {                                                 // darker glass in narrow vertical strips
    w: 2.4, h: 3.4, ground: 6, front: 0x23272c, material: { roughness: 0.1, metalness: 0.8 }, lit: 0.34,
    glass(g, S) { g.fillRect(8, 0, S - 16, S * 0.86); },
    paint(g, S) {
      const sky = g.createLinearGradient(0, 0, 0, S);
      sky.addColorStop(0, '#5c7084');
      sky.addColorStop(1, '#3b4b5c');
      g.fillStyle = sky;
      g.fillRect(0, 0, S, S);
      g.fillStyle = '#2c3640';
      g.fillRect(0, S * 0.86, S, S * 0.14);
      g.fillStyle = '#c9ced3';
      g.fillRect(0, 0, 8, S);
    },
  },
  apartment0: {
    w: 4, h: 2.9, ground: 3, front: 0xbdb7aa, balcony: true, material: { roughness: 0.85 }, lit: 0.5,
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
  apartment1: {                                             // the side with the stairs and small windows
    w: 3.6, h: 2.9, ground: 3, front: 0xb3ad9f, material: { roughness: 0.9 }, lit: 0.34,
    glass(g, S) { g.fillRect(S * 0.14, S * 0.3, S * 0.28, S * 0.4); g.fillRect(S * 0.6, S * 0.3, S * 0.2, S * 0.4); },
    paint(g, S) {
      g.fillStyle = '#e3ded2';
      g.fillRect(0, 0, S, S);
      g.fillStyle = '#cfc9bb';
      g.fillRect(0, S - 8, S, 8);
      g.fillStyle = '#5b6c79';
      g.fillRect(S * 0.14, S * 0.3, S * 0.28, S * 0.4);
      g.fillRect(S * 0.6, S * 0.3, S * 0.2, S * 0.4);
      g.fillStyle = '#f2efe8';
      g.fillRect(S * 0.27, S * 0.3, 4, S * 0.4);
      g.fillStyle = '#b9b3a6';
      g.fillRect(S * 0.12, S * 0.7, S * 0.32, 6);
      g.fillRect(S * 0.58, S * 0.7, S * 0.24, 6);
    },
  },
  shop0: {
    w: 4, h: 3.6, ground: 4, front: 'store', material: { roughness: 0.8 }, lit: 0.62,
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
  shop1: {                                                  // rendered wall with separate windows
    w: 3.4, h: 3.3, ground: 4, front: 'store', material: { roughness: 0.92 }, lit: 0.48,
    glass(g, S) { g.fillRect(S * 0.12, S * 0.26, S * 0.3, S * 0.48); g.fillRect(S * 0.58, S * 0.26, S * 0.3, S * 0.48); },
    paint(g, S) {
      g.fillStyle = '#d9d2c4';
      g.fillRect(0, 0, S, S);
      g.fillStyle = 'rgba(0,0,0,0.05)';
      g.fillRect(0, S - 10, S, 10);
      for (const x of [0.12, 0.58]) {
        g.fillStyle = '#f3efe6';
        g.fillRect(S * x - 5, S * 0.26 - 5, S * 0.3 + 10, S * 0.48 + 10);
        g.fillStyle = '#4b5a66';
        g.fillRect(S * x, S * 0.26, S * 0.3, S * 0.48);
        g.fillStyle = '#f3efe6';
        g.fillRect(S * (x + 0.15) - 2, S * 0.26, 4, S * 0.48);
        g.fillStyle = '#a9a294';
        g.fillRect(S * x - 8, S * 0.74 + 5, S * 0.3 + 16, 7);  // sill
      }
    },
  },
  shop2: {                                                  // tiled panels, the look of many small office blocks
    w: 3.8, h: 3.5, ground: 4, front: 'store', material: { roughness: 0.6, metalness: 0.1 }, lit: 0.55,
    glass(g, S) { g.fillRect(S * 0.08, S * 0.24, S * 0.84, S * 0.5); },
    paint(g, S) {
      g.fillStyle = '#9aa1a6';
      g.fillRect(0, 0, S, S);
      g.strokeStyle = 'rgba(255,255,255,0.18)';
      g.lineWidth = 2;
      for (let x = 0; x <= S; x += S / 4) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, S); g.stroke(); }
      g.beginPath(); g.moveTo(0, S * 0.86); g.lineTo(S, S * 0.86); g.stroke();
      g.fillStyle = '#3c4b57';
      g.fillRect(S * 0.08, S * 0.24, S * 0.84, S * 0.5);
      g.fillStyle = '#c3c8cc';
      for (const x of [0.36, 0.64]) g.fillRect(S * x - 2, S * 0.24, 4, S * 0.5);
    },
  },
  office0: {
    w: 3.2, h: 3.6, ground: 4.5, front: 'store', material: { roughness: 0.4, metalness: 0.3 }, lit: 0.3,
    glass(g, S) { g.fillRect(S * 0.08, S * 0.18, S * 0.38, S * 0.6); g.fillRect(S * 0.54, S * 0.18, S * 0.38, S * 0.6); },
    paint(g, S) {
      g.fillStyle = '#b4b9bf';
      g.fillRect(0, 0, S, S);
      g.fillStyle = '#3f5468';
      g.fillRect(S * 0.08, S * 0.18, S * 0.38, S * 0.6);
      g.fillRect(S * 0.54, S * 0.18, S * 0.38, S * 0.6);
    },
  },
  office1: {                                                // ribbon windows between bands of stone
    w: 4.2, h: 3.7, ground: 4.5, front: 'store', material: { roughness: 0.5, metalness: 0.2 }, lit: 0.36,
    glass(g, S) { g.fillRect(0, S * 0.22, S, S * 0.46); },
    paint(g, S) {
      g.fillStyle = '#cfc8ba';
      g.fillRect(0, 0, S, S);
      g.fillStyle = '#394b5c';
      g.fillRect(0, S * 0.22, S, S * 0.46);
      g.fillStyle = '#8e969d';
      for (const x of [0, 0.5]) g.fillRect(S * x, S * 0.22, 4, S * 0.46);
      g.fillStyle = 'rgba(0,0,0,0.07)';
      g.fillRect(0, S * 0.68, S, 6);
    },
  },
  civic0: {
    w: 3.6, h: 3.5, ground: 0, front: null, material: { roughness: 0.9 }, lit: 0.12,
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
  // the ground floor of shops and offices: two bays, one a shop window and one with the door
  store: {
    w: 8, h: 4, material: { roughness: 0.35, metalness: 0.2 }, lit: 0.6,
    glass(g, S) { g.fillRect(S * 0.03, S * 0.26, S * 0.44, S * 0.62); g.fillRect(S * 0.53, S * 0.26, S * 0.44, S * 0.62); },
    paint(g, S) {
      g.fillStyle = '#8c9197';
      g.fillRect(0, 0, S, S);
      g.fillStyle = '#6f757b';
      g.fillRect(0, 0, S, S * 0.22);                         // fascia, where the shop sign hangs
      g.fillStyle = '#3a4854';
      g.fillRect(S * 0.03, S * 0.26, S * 0.44, S * 0.62);     // shop window
      g.fillRect(S * 0.53, S * 0.26, S * 0.44, S * 0.62);
      g.fillStyle = '#c9cdd1';
      g.fillRect(S * 0.25 - 2, S * 0.26, 4, S * 0.62);
      g.fillRect(S * 0.67, S * 0.26, 4, S * 0.74);            // door frame
      g.fillRect(S * 0.83, S * 0.26, 4, S * 0.74);
      g.fillRect(S * 0.67, S * 0.4, S * 0.16, 4);
      g.fillStyle = '#2f3b46';
      g.fillRect(S * 0.67 + 4, S * 0.4 + 4, S * 0.16 - 4, S * 0.6 - 4);   // the door, down to the pavement
      g.fillStyle = '#5c6268';
      g.fillRect(0, S * 0.88, S * 0.67, S * 0.12);            // plinth
      g.fillRect(S * 0.83 + 4, S * 0.88, S * 0.17, S * 0.12);
    },
  },
};
const VARIANTS = { tower: 2, apartment: 2, shop: 3, office: 2, civic: 1 };
// what the paint of one building does to its wall picture: mostly near white, sometimes warm or cool
const TINTS = [[1, 1, 1], [1, 1, 1], [1.0, 0.97, 0.91], [0.93, 0.96, 1.0], [0.97, 0.93, 0.87], [0.88, 0.9, 0.92], [1.0, 0.95, 0.95], [0.94, 0.98, 0.93]];
const AWNINGS = [0x9c2b2b, 0x1f5a3c, 0x23395b, 0xc9a227, 0x6b6f75, 0x7a4a2a, 0xd9d4c8];

function styleOf(b, pick) {
  const kind = b.h >= 100 ? 'tower' : b.t === 'apartments' || b.t === 'residential' ? 'apartment'
    : ['school', 'kindergarten', 'public', 'university', 'hospital'].includes(b.t) ? 'civic' : b.h > 40 || b.t === 'office' || b.t === 'hotel' ? 'office' : 'shop';
  return kind + Math.floor(pick * VARIANTS[kind]) % VARIANTS[kind];
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
    // everything without a picture on it: parapets, balconies, awnings, roof plant, plinths
    plain: snowable(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide }), 0.5),
  };
}

// Walls and roofs for a list of buildings, plus their signs. `seed` varies them from one batch to the next.
export function buildFacades(buildings, ground, kit, seed = 0) {
  const { atlas, tallAtlas } = kit, rand = seeded(11 + seed);
  const walls = Object.fromEntries(Object.keys(STYLES).map(k => [k, { pos: [], nor: [], uv: [], col: [], idx: [] }]));
  const roof = { pos: [], idx: [] }, plain = { pos: [], col: [] }, tone = new THREE.Color();
  const signs = new QuadBatch(atlas), blades = new QuadBatch(tallAtlas);

  // a flat four-cornered piece of the plain mesh, corners given in order round it
  const quad = (a, b, c, d, hex, shade = 1) => {
    tone.setHex(hex).multiplyScalar(shade);
    for (const p of [a, b, c, a, c, d]) { plain.pos.push(p[0], p[1], p[2]); plain.col.push(tone.r, tone.g, tone.b); }
  };
  // a box standing on (x, y, z), turned by `yaw`
  const block = (x, y, z, w, h, d, yaw, hex) => {
    const c = Math.cos(yaw), s = Math.sin(yaw), at = (px, pz, py) => [x + px * c + pz * s, y + py, z - px * s + pz * c];
    const corners = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
    corners.forEach((p, i) => { const q = corners[(i + 1) % 4]; quad(at(p[0], p[1], 0), at(q[0], q[1], 0), at(q[0], q[1], h), at(p[0], p[1], h), hex, i % 2 ? 0.86 : 1); });
    quad(...corners.map(p => at(p[0], p[1], h)), hex, 1.08);
  };

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

  // One wall of tiles between two heights. u1, v0, v1: how many tiles along and where up the picture.
  const wall = (key, e, y0, y1, u1, v0, v1, colour, sign) => {
    const out = walls[key], k = out.pos.length / 3;
    out.pos.push(e.ax, y0, e.az, e.bx, y0, e.bz, e.bx, y1, e.bz, e.ax, y1, e.az);
    out.uv.push(0, v0, u1, v0, u1, v1, 0, v1);
    for (let c = 0; c < 4; c++) { out.nor.push(e.nx, 0, e.nz); out.col.push(...colour); }
    if (sign > 0) out.idx.push(k, k + 2, k + 1, k, k + 3, k + 2); else out.idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
  };
  const edgesOf = (p, sign) => {
    const n = p.length / 2, edges = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, ax = p[i * 2], az = p[i * 2 + 1], bx = p[j * 2], bz = p[j * 2 + 1], dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
      if (len >= 0.05) edges.push({ ax, az, bx, bz, dx: dx / len, dz: dz / len, len, nx: sign * dz / len, nz: -sign * dx / len });
    }
    return edges;
  };
  const roofOver = (p, y) => {
    const contour = [];
    for (let i = 0; i < p.length; i += 2) contour.push(new THREE.Vector2(p[i], p[i + 1]));
    const k = roof.pos.length / 3;
    for (const v of contour) roof.pos.push(v.x, y, v.y);
    for (const tri of THREE.ShapeUtils.triangulateShape(contour, [])) roof.idx.push(k + tri[0], k + tri[1], k + tri[2]);
  };

  buildings.forEach((b, index) => {
    // each building's looks come from its own place on the map, so they do not change with what else is in the list
    const own = seeded(Math.round(b.p[0] * 131 + b.p[1] * 977) + seed), key = styleOf(b, own()), style = STYLES[key], n = b.p.length / 2;
    let area = 0, lo = Infinity, sum = 0, cx = 0, cz = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, x = b.p[i * 2], z = b.p[i * 2 + 1], h = ground(x, z);
      area += x * b.p[j * 2 + 1] - b.p[j * 2] * z;
      lo = Math.min(lo, h);
      sum += h;
      cx += x / n;
      cz += z / n;
    }
    const sign = area > 0 ? 1 : -1;            // footprint winding decides which side is outside
    const street = sum / n, base = lo - 0.5, top = street + b.h, size = Math.abs(area) / 2;
    const shade = 0.9 + own() * 0.14, tint = TINTS[Math.floor(own() * TINTS.length)], colour = tint.map(t => t * shade);
    // a low building is all ground floor; a tall one has its top storeys set back
    let gh = style.front ? Math.min(style.ground, b.h) : 0;
    if (b.h - gh < style.h * 0.6) gh = style.front ? b.h : 0;      // too little above the ground floor for a storey: the ground floor takes it all
    const upper = b.h - gh;
    let crown = b.h >= 120 ? top - Math.max(9, b.h * 0.07) : top;
    const floors = Math.max(1, Math.round(upper / (style.h * (0.94 + own() * 0.14)))), floorH = upper / floors, bayW = style.w * (0.9 + own() * 0.25);
    const edges = edgesOf(b.p, sign);
    if (!edges.length) return;
    const inside = pointInPolygon(cx, cz, b.p);

    if (!inside) crown = top;                               // an L- or U-shaped tower: no narrower top, it would hang over the gap
    for (const e of edges) {
      const bays = Math.max(1, Math.round(e.len / bayW));
      if (upper > 0.5) wall(key, e, street + gh, crown, bays, 0, (crown - street - gh) / floorH, colour, sign);
      if (gh > 0 && style.front === 'store') {
        wall('store', e, street, street + gh, Math.max(0.5, Math.round(e.len / 4) / 2), 0, 1, [shade, shade, shade], sign);
        quad([e.ax, base, e.az], [e.bx, base, e.bz], [e.bx, street, e.bz], [e.ax, street, e.az], 0x5c6268, shade);     // down to the lowest ground
      }
      else if (gh > 0) quad([e.ax, base, e.az], [e.bx, base, e.bz], [e.bx, street + gh, e.bz], [e.ax, street + gh, e.az], style.front, shade);
      else if (upper <= 0.5) wall(key, e, base, top, bays, (base - street) / floorH, floors, colour, sign);
      // a low wall round the roof
      if (b.h > 7 && crown === top) quad([e.ax, top, e.az], [e.bx, top, e.bz], [e.bx, top + 0.7, e.bz], [e.ax, top + 0.7, e.az], 0xb9b5ab, shade);
      // balcony slabs along the long sides of an apartment block
      if (style.balcony && e.len >= 12 && floors >= 3) {
        const o = 0.55;
        for (let f = 2; f <= Math.min(floors, 40); f++) {
          const y = street + gh + (f - 1) * floorH;
          quad([e.ax, y, e.az], [e.bx, y, e.bz], [e.bx + e.nx * o, y, e.bz + e.nz * o], [e.ax + e.nx * o, y, e.az + e.nz * o], 0xd8d2c4, shade);
          quad([e.ax + e.nx * o, y, e.az + e.nz * o], [e.bx + e.nx * o, y, e.bz + e.nz * o], [e.bx + e.nx * o, y + 0.9, e.bz + e.nz * o], [e.ax + e.nx * o, y + 0.9, e.az + e.nz * o], 0xcfc9bb, shade * 0.95);
        }
      }
    }
    if (gh === 0 && upper > 0.5) for (const e of edges) wall(key, e, base, street, Math.max(1, Math.round(e.len / bayW)), (base - street) / floorH, 0, colour, sign);

    // roof, and on a tall tower a narrower top with a mast
    roofOver(b.p, crown);
    if (crown < top) {
      const inner = [];
      for (let i = 0; i < n; i++) inner.push(cx + (b.p[i * 2] - cx) * 0.8, cz + (b.p[i * 2 + 1] - cz) * 0.8);
      for (const e of edgesOf(inner, sign)) wall(key, e, crown, top, Math.max(1, Math.round(e.len / bayW)), 0, (top - crown) / floorH, colour.map(c => c * 0.92), sign);
      roofOver(inner, top);
      if (b.h > 220) block(cx, top, cz, 1.2, b.h * 0.08, 1.2, 0, 0x8d949b);
    } else if (size > 60 && b.h > 5) {
      // roof plant: a stair head, and water tanks or air conditioning units, wherever they fit
      // a spot whose surroundings, as far as the largest box reaches, are all on the roof
      const spot = () => {
        const x = cx + (own() - 0.5) * Math.sqrt(size) * 0.7, z = cz + (own() - 0.5) * Math.sqrt(size) * 0.7;
        return [[0, 0], [2.6, 0], [-2.6, 0], [0, 2.6], [0, -2.6], [1.9, 1.9], [-1.9, 1.9], [1.9, -1.9], [-1.9, -1.9]].every(([dx, dz]) => pointInPolygon(x + dx, z + dz, b.p)) ? [x, z] : null;
      };
      const yaw = Math.atan2(edges[0].dx, edges[0].dz), stair = spot();
      if (stair && b.h > 9) block(stair[0], top, stair[1], 3.2, 2.6, 3.6, yaw, 0xaaa69c);
      for (let k = 0; k < Math.min(4, Math.floor(size / 90)); k++) {
        const at = spot();
        if (!at) continue;
        if (style.balcony || own() < 0.4) block(at[0], top, at[1], 1.9, 1.7, 1.9, yaw, own() < 0.5 ? 0xd8b52e : 0x3f78b5);     // water tank
        else block(at[0], top, at[1], 1.1, 0.8, 0.8, yaw, 0xc9cdd1);                                                            // air conditioning
      }
    }

    // A sign lying flat on a wall: `along` metres from the edge start, facing outwards.
    const onWall = (e, along, y, out2 = 0.12) => new THREE.Vector3(e.ax + e.dx * along + e.nx * out2, y, e.az + e.dz * along + e.nz * out2);
    const wallRight = e => new THREE.Vector3(e.nz, 0, -e.nx);
    const kind = key.slice(0, -1);

    if (kind === 'shop' || kind === 'office') {
      const levels = kind === 'shop' && upper > 0.5 ? Math.min(4, floors + 1) : 1;
      for (const e of edges) {
        if (e.len < 6) continue;
        const count = Math.floor(e.len / 4.2), width = e.len / count;
        for (let level = 1; level <= levels; level++) {
          const y = street + gh + (level - 1) * floorH - 0.5;
          if (y > top - 0.3) break;
          for (let c = 0; c < count; c++) {
            if (rand() < 0.2) continue;
            signs.add(onWall(e, (c + 0.5) * width, y), wallRight(e), width - 0.3, 0.9, shopSign());
          }
        }
        // awnings over some of the shop windows
        if (kind === 'shop' && gh >= 3.2) {
          for (let c = 0; c < count; c++) {
            if (rand() > 0.3) continue;
            const a0 = c * width + 0.3, a1 = (c + 1) * width - 0.3, y = street + gh - 1.05, hex = AWNINGS[Math.floor(rand() * AWNINGS.length)];
            const p = (along, outward, dy) => [e.ax + e.dx * along + e.nx * outward, y + dy, e.az + e.dz * along + e.nz * outward];
            quad(p(a0, 0.05, 0), p(a1, 0.05, 0), p(a1, 1.15, -0.45), p(a0, 1.15, -0.45), hex);
            quad(p(a0, 1.15, -0.45), p(a1, 1.15, -0.45), p(a1, 1.15, -0.7), p(a0, 1.15, -0.7), hex, 0.85);
          }
        }
        if (kind === 'shop' && b.h > 6) {
          for (let along = 4; along < e.len - 2; along += 9) {
            if (rand() < 0.4) continue;
            const c = onWall(e, along, street + Math.min(b.h - 2, 6.5), 0.6);
            blades.add(c, new THREE.Vector3(e.nx, 0, e.nz), 0.8, 3.2, bladeSign(), true);
          }
        }
      }
      // a big sign on the roof of some of the taller ones
      const front = edges.reduce((best, e) => (e.len > best.len ? e : best), edges[0]);
      if (b.h > 14 && crown === top && front.len > 9 && own() < 0.3) {
        const width = Math.min(8, front.len * 0.6);
        signs.add(onWall(front, front.len / 2, top + 0.7 + width / 8, -0.3), wallRight(front), width, width / 4, shopSign(), true);
      }
    }
    // Apartment blocks carry their number high on the end walls.
    const number = kind === 'apartment' && /^(\d{2,4}|[A-Z])동?$/.exec(b.n);
    if (number) {
      const ends = edges.filter(e => e.len >= 7).sort((p, q) => p.len - q.len).slice(0, 2);
      for (const e of ends) {
        const width = Math.min(6, e.len * 0.6);
        signs.add(onWall(e, e.len / 2, Math.max(street + gh + 1, crown - 4.5), 0.08), wallRight(e), width, width / 4, blockNumber(number[1]));
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
  if (plain.pos.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(plain.pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(plain.col, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, kit.plain);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
