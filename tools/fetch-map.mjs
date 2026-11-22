// Downloads the raw inputs for one region into data/raw/:
//   osm.json        OpenStreetMap features (Overpass API)
//   dem_*.png       elevation tiles (Terrarium encoding, public AWS open data)
// Usage: node tools/fetch-map.mjs

import { mkdir, writeFile } from 'node:fs/promises';
import { REGION, bbox, tileX, tileY } from './region.mjs';

const UA = 'map-validation-script/0.1';
const RAW = new URL('../data/raw/', import.meta.url);
const DEM_Z = 13;

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

async function fetchOsm() {
  const b = bbox(REGION, 30).join(',');
  const query = `[out:json][timeout:180];
(
  way["highway"](${b});
  way["building"](${b});
  relation["building"](${b});
  way["building:part"](${b});
  way["natural"](${b});
  relation["natural"="water"](${b});
  way["waterway"](${b});
  way["leisure"~"park|garden|pitch"](${b});
  way["landuse"](${b});
  way["man_made"~"pier|breakwater|bridge"](${b});
);
out geom;`;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      console.log(`osm: ${json.elements.length} elements from ${new URL(url).host}`);
      return json;
    } catch (err) {
      console.warn(`osm: ${new URL(url).host} failed (${err.message})`);
    }
  }
  throw new Error('all Overpass servers failed');
}

function tileRange(z, pad) {
  const [south, west, north, east] = bbox(REGION, pad);
  return {
    x0: Math.floor(tileX(west, z)), x1: Math.floor(tileX(east, z)),
    y0: Math.floor(tileY(north, z)), y1: Math.floor(tileY(south, z)),
  };
}

async function fetchTiles(z, pad, urlOf, dir, prefix) {
  const { x0, x1, y0, y1 } = tileRange(z, pad);
  let n = 0;
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const res = await fetch(urlOf(z, x, y), { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`${urlOf(z, x, y)} -> HTTP ${res.status}`);
      await writeFile(new URL(`${prefix}${z}_${x}_${y}.png`, dir), Buffer.from(await res.arrayBuffer()));
      n++;
    }
  }
  console.log(`${prefix || 'ref_'}tiles z${z}: ${n} files (x ${x0}-${x1}, y ${y0}-${y1})`);
  return { z, x0, x1, y0, y1 };
}

await mkdir(RAW, { recursive: true });

await writeFile(new URL('osm.json', RAW), JSON.stringify(await fetchOsm()));
const dem = await fetchTiles(DEM_Z, 250,
  (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`, RAW, 'dem_');
await writeFile(new URL('tiles.json', RAW), JSON.stringify({ dem }));
