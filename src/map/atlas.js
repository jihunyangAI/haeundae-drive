import * as THREE from 'three';

export const FONT = '"Malgun Gothic", "Noto Sans KR", system-ui, sans-serif';

// A canvas divided into equal cells for small drawn textures (signs, plates, painted numbers).
export class Atlas {
  constructor(cellW, cellH, cols, rows) {
    Object.assign(this, { cellW, cellH, cols, rows, count: 0, cache: new Map() });
    this.canvas = document.createElement('canvas');
    this.canvas.width = cellW * cols;
    this.canvas.height = cellH * rows;
    this.g = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
  }

  // draw(g, w, h) paints one cell; `key` reuses an earlier identical cell. `width` (px) narrows the
  // returned rectangle to the left part of the cell. Returns [u0, v0, u1, v1].
  add(key, draw, width = this.cellW) {
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.count >= this.cols * this.rows) throw new Error('atlas full');
    const col = this.count % this.cols, row = Math.floor(this.count / this.cols);
    this.count++;
    const g = this.g, x = col * this.cellW, y = row * this.cellH;
    g.save();
    g.translate(x, y);
    g.beginPath();
    g.rect(0, 0, this.cellW, this.cellH);
    g.clip();
    draw(g, this.cellW, this.cellH);
    g.restore();
    this.texture.needsUpdate = true;
    const W = this.canvas.width, H = this.canvas.height, inset = 0.5;
    const rect = [(x + inset) / W, 1 - (y + this.cellH - inset) / H, (x + width - inset) / W, 1 - (y + inset) / H];
    this.cache.set(key, rect);
    return rect;
  }
}

// Collects flat rectangles textured from one atlas into a single mesh.
export class QuadBatch {
  constructor(atlas) {
    this.atlas = atlas;
    this.positions = [];
    this.uvs = [];
    this.normals = [];
    this.indices = [];
  }

  // centre: Vector3; right: unit Vector3 along the rectangle's width. It faces right x up.
  add(centre, right, width, height, rect, doubleSided = false) {
    const k = this.positions.length / 3, hw = width / 2, hh = height / 2;
    const corner = (sx, sy) => this.positions.push(centre.x + right.x * hw * sx, centre.y + hh * sy, centre.z + right.z * hw * sx);
    corner(-1, -1); corner(1, -1); corner(1, 1); corner(-1, 1);
    this.uvs.push(rect[0], rect[1], rect[2], rect[1], rect[2], rect[3], rect[0], rect[3]);
    for (let i = 0; i < 4; i++) this.normals.push(-right.z, 0, right.x);
    this.indices.push(k, k + 1, k + 2, k, k + 2, k + 3);
    if (doubleSided) this.add(centre, right.clone().negate(), width, height, rect);
  }

  // material: one to share between batches, or extra options for a new one
  build(material = {}) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    geo.setIndex(this.indices);
    const mesh = new THREE.Mesh(geo, material.isMaterial ? material
      : new THREE.MeshStandardMaterial({ map: this.atlas.texture, alphaTest: 0.5, roughness: 0.6, ...material }));
    mesh.visible = this.indices.length > 0;
    return mesh;
  }
}

// Deterministic random numbers so the city looks the same on every visit.
export function seeded(seed) {
  return () => {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
