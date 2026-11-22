// Loads the map produced by tools/build-map.mjs: one base file for the whole area, and a file per
// zone fetched when the car comes near. Local frame: +X east, +Z south, +Y up, metres.

export const GROUND_CELL = 5;    // spacing of the ground grid, metres
const SEA_BED = -3, LAND_MIN = 1;

function gridSampler(grid, nx, nz, cell, x0, z0) {
  return (x, z) => {
    const fx = Math.min(nx - 1.001, Math.max(0, (x - x0) / cell));
    const fz = Math.min(nz - 1.001, Math.max(0, (z - z0) / cell));
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, k = j * nx + i;
    return grid[k] * (1 - u) * (1 - v) + grid[k + 1] * u * (1 - v)
      + grid[k + nx] * (1 - u) * v + grid[k + nx + 1] * u * v;
  };
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// dir: folder holding base.json and the zone files, with a trailing slash.
export async function loadMap(dir) {
  const map = await getJson(`${dir}base.json`);
  const [x0, z0, x1, z1] = map.meta.rect;
  Object.assign(map, { x0, z0, x1, z1 });

  // land or sea for each cell of the ground grid, unpacked from run lengths (the first run is sea)
  const { nx, nz, runs } = map.mask, land = new Uint8Array(nx * nz);
  for (let r = 0, at = 0; r < runs.length; at += runs[r++]) if (r % 2) land.fill(1, at, at + runs[r]);
  map.isLand = (x, z) => {
    const i = Math.round((x - x0) / GROUND_CELL), j = Math.round((z - z0) / GROUND_CELL);
    return i >= 0 && j >= 0 && i < nx && j < nz && land[j * nx + i] === 1;
  };

  // Ground height used for everything drawn and driven on. The elevation data reads about 0 over
  // open water and cannot place the shore, so the land mask decides what is sea.
  const h = map.height, hAt = gridSampler(h.smooth, h.nx, h.nz, h.cell, h.x0, h.z0), grid = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      grid[j * nx + i] = land[j * nx + i] ? Math.max(LAND_MIN, hAt(x0 + i * GROUND_CELL, z0 + j * GROUND_CELL)) : SEA_BED;
    }
  }
  levelRoads(map, grid, land, nx, nz);
  map.ground = gridSampler(grid, nx, nz, GROUND_CELL, x0, z0);

  // { b: buildings, nb: outlines of neighbouring buildings, areas, lines } for zone column i, row j
  map.loadZone = (i, j) => getJson(`${dir}z_${i}_${j}.json`);
  return map;
}

// Cut every carriageway into the ground: level across its width, and along its length an evened-out
// version of the terrain under its centre line. Without this a road across a hillside tilts sideways
// and follows every bump in the elevation data. The ground eases back to the terrain over a few metres.
function levelRoads(map, grid, land, nx, nz) {
  const before = gridSampler(grid.slice(), nx, nz, GROUND_CELL, map.x0, map.z0);
  const sum = new Float32Array(grid.length), weight = new Float32Array(grid.length), most = new Float32Array(grid.length);
  const STEP = 2.5, SHOULDER = 1.5, EASE = 7, WINDOW = 16;     // WINDOW samples either side: 40 m
  for (const road of map.roads) {
    if (road.c !== 'drive' || road.br) continue;
    const pts = [], p = road.p;
    for (let i = 2; i < p.length; i += 2) {
      const ax = p[i - 2], az = p[i - 1], dx = p[i] - ax, dz = p[i + 1] - az, n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / STEP));
      for (let k = i === 2 ? 0 : 1; k <= n; k++) pts.push([ax + dx * k / n, az + dz * k / n]);
    }
    const raw = pts.map(([x, z]) => before(x, z)), flat = road.w / 2 + SHOULDER, reach = flat + EASE, rank = road.k === 'service' ? 0.02 : 1;
    pts.forEach(([x, z], k) => {
      let h = 0, count = 0;
      for (let m = Math.max(0, k - WINDOW); m <= Math.min(pts.length - 1, k + WINDOW); m++) { h += raw[m]; count++; }
      h /= count;
      const i0 = Math.max(0, Math.ceil((x - reach - map.x0) / GROUND_CELL)), i1 = Math.min(nx - 1, Math.floor((x + reach - map.x0) / GROUND_CELL));
      const j0 = Math.max(0, Math.ceil((z - reach - map.z0) / GROUND_CELL)), j1 = Math.min(nz - 1, Math.floor((z + reach - map.z0) / GROUND_CELL));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const d = Math.hypot(map.x0 + i * GROUND_CELL - x, map.z0 + j * GROUND_CELL - z);
          if (d >= reach) continue;
          const w = d <= flat ? 1 : 1 - (d - flat) / EASE, c = j * nx + i;
          const share = w ** 6 * rank;      // where two roads are close, the nearer one decides, and a street beats a driveway
          sum[c] += share * h;
          weight[c] += share;
          most[c] = Math.max(most[c], w);
        }
      }
    });
  }
  for (let c = 0; c < grid.length; c++) {
    if (land[c] && weight[c] > 0) grid[c] += (Math.max(LAND_MIN, sum[c] / weight[c]) - grid[c]) * most[c];
  }
}

export function pointInPolygon(x, z, p) {
  let inside = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    if ((p[i + 1] > z) !== (p[j + 1] > z) && x < (p[j] - p[i]) * (z - p[i + 1]) / (p[j + 1] - p[i + 1]) + p[i]) inside = !inside;
  }
  return inside;
}

export function boundsOf(p) {
  let ax = Infinity, az = Infinity, bx = -Infinity, bz = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    ax = Math.min(ax, p[i]); bx = Math.max(bx, p[i]);
    az = Math.min(az, p[i + 1]); bz = Math.max(bz, p[i + 1]);
  }
  return [ax, az, bx, bz];
}
