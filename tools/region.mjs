// Shared definition of the map area and the lat/lon <-> local metre projection.
// Local frame: origin at Marine City (the original 1 km square), +X east, +Z south, +Y up.

export const REGION = {
  id: 'haeundae',
  name: '부산 해운대 · 달맞이길 · 송정 · 기장 해안',
  lat: 35.158,
  lon: 129.144,
  // The rectangle the map covers, in local metres. The ground is known all over it; streets and buildings
  // are only mapped in the parts below.
  x0: -700, x1: 8900, z0: -8300, z1: 900,
  zone: 400,     // the map is cut into square zones this size, loaded as the car comes near
  // The town: Marine City in the west, Haeundae beach, Dalmaji hill in the east.
  core: { x0: -700, x1: 4500, z0: -1100, z1: 900 },
  // The coast road north-east from Dalmaji: Songjeong, Gongsu, Yonggungsa, Orangdae, Yeonhwa-ri, Daebyeon harbour.
  // [latitude, longitude] along it, and how far either side of that line is mapped (metres).
  coast: [[35.1640, 129.1930], [35.1730, 129.1975], [35.1790, 129.2000], [35.1850, 129.2060], [35.1855, 129.2150],
    [35.1900, 129.2225], [35.1990, 129.2270], [35.2140, 129.2265], [35.2240, 129.2290]],
  coastHalf: 800,
};

const rad = d => d * Math.PI / 180;

export function projection(region = REGION) {
  const p = rad(region.lat);
  const mPerLat = 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p);
  const mPerLon = 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p);
  return {
    mPerLat, mPerLon,
    toLocal: (lat, lon) => [(lon - region.lon) * mPerLon, (region.lat - lat) * mPerLat],
    toGeo: (x, z) => [region.lat - z / mPerLat, region.lon + x / mPerLon],
  };
}

// [south, west, north, east] covering the rectangle plus `pad` metres
export function bbox(region = REGION, pad = 0) {
  const { toGeo } = projection(region);
  const [north, west] = toGeo(region.x0 - pad, region.z0 - pad), [south, east] = toGeo(region.x1 + pad, region.z1 + pad);
  return [south, west, north, east];
}

// Web-mercator tile maths (fractional tile coordinates)
export const tileX = (lon, z) => (lon + 180) / 360 * 2 ** z;
export const tileY = (lat, z) => (1 - Math.asinh(Math.tan(rad(lat))) / Math.PI) / 2 * 2 ** z;

// Is the point (local metres) in a part of the map that has streets and buildings?
export function mapped(x, z, region = REGION, pad = 0) {
  const c = region.core;
  if (x >= c.x0 - pad && x <= c.x1 + pad && z >= c.z0 - pad && z <= c.z1 + pad) return true;
  const { toLocal } = projection(region), line = region.coast.map(([lat, lon]) => toLocal(lat, lon));
  for (let i = 1; i < line.length; i++) {
    const [ax, az] = line[i - 1], dx = line[i][0] - ax, dz = line[i][1] - az;
    const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    if (Math.hypot(x - ax - dx * t, z - az - dz * t) <= region.coastHalf + pad) return true;
  }
  return false;
}

// The mapped parts as [south, west, north, east] boxes with `pad` metres round them: the town, and one
// for each stretch of the coast road.
export function boxes(region = REGION, pad = 0) {
  const { toGeo, toLocal } = projection(region), out = [], c = region.core;
  const box = (x0, z0, x1, z1) => { const [north, west] = toGeo(x0 - pad, z0 - pad), [south, east] = toGeo(x1 + pad, z1 + pad); out.push([south, west, north, east]); };
  box(c.x0, c.z0, c.x1, c.z1);
  const line = region.coast.map(([lat, lon]) => toLocal(lat, lon)), h = region.coastHalf;
  for (let i = 1; i < line.length; i++) {
    box(Math.min(line[i - 1][0], line[i][0]) - h, Math.min(line[i - 1][1], line[i][1]) - h, Math.max(line[i - 1][0], line[i][0]) + h, Math.max(line[i - 1][1], line[i][1]) + h);
  }
  return out;
}
