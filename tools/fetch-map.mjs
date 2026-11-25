// Downloads the raw inputs for one region into data/raw/:
//   osm.json        OpenStreetMap features (Overpass API)
//   dem_*.png       elevation tiles (Terrarium encoding, public AWS open data)
// Usage: node tools/fetch-map.mjs

import { mkdir, writeFile } from 'node:fs/promises';
import { REGION, bbox, boxes, tileX, tileY } from './region.mjs';

const UA = 'map-validation-script/0.1';
const RAW = new URL('../data/raw/', import.meta.url);
const DEM_Z = 13;

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// One Overpass query, tried on each server in turn and then again after a pause.
async function ask(query, what) {
  for (let round = 0; round < 4; round++) {
    for (const url of OVERPASS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (json.remark) throw new Error(json.remark);          // answered, but it ran out of time or memory part-way
        console.log(`osm ${what}: ${json.elements.length} elements from ${new URL(url).host}`);
        return json.elements;
      } catch (err) {
        console.warn(`osm ${what}: ${new URL(url).host} failed (${err.message})`);
      }
    }
    await new Promise(r => setTimeout(r, 15000 * (round + 1)));
  }
  throw new Error(`all Overpass servers failed for ${what}`);
}

// (Buildings are not asked for: they come from the building register, see fetch-buildings.mjs.)
// Streets and what stands along them: only where the map has them (the town and the coast road), a
// box at a time. The shore, woods and fields: over the whole rectangle, since the ground is drawn all over it.
async function fetchOsm() {
  const seen = new Map(), add = list => { for (const e of list) seen.set(`${e.type}${e.id}`, e); };
  const parts = boxes(REGION, 60);
  for (let i = 0; i < parts.length; i++) {
    const b = parts[i].join(',');
    add(await ask(`[out:json][timeout:180];
(
  way["highway"](${b});
  way["natural"](${b});
  relation["natural"="water"](${b});
  way["waterway"](${b});
  way["leisure"~"park|garden|pitch"](${b});
  way["landuse"](${b});
  way["man_made"~"pier|breakwater|bridge"](${b});
);
out geom;`, `part ${i + 1}/${parts.length}`));
  }
  const whole = bbox(REGION, 30).join(',');
  add(await ask(`[out:json][timeout:180];
(
  way["natural"~"coastline|wood|beach|sand|water"](${whole});
  way["landuse"~"forest|farmland|orchard|meadow"](${whole});
);
out geom;`, 'shore and woods'));
  return { elements: [...seen.values()] };
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
