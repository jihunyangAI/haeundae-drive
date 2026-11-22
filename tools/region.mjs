// Shared definition of the map area and the lat/lon <-> local metre projection.
// Local frame: origin at Marine City (the original 1 km square), +X east, +Z south, +Y up.

export const REGION = {
  id: 'haeundae',
  name: '부산 해운대 · 달맞이길',
  lat: 35.158,
  lon: 129.144,
  // The mapped rectangle in local metres: Marine City in the west, Haeundae beach, Dalmaji hill in the east.
  x0: -700, x1: 4500, z0: -1100, z1: 900,
  zone: 400,     // the map is cut into square zones this size, loaded as the car comes near
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
