// Downloads the outlines, heights and uses of all buildings in the map area from V-World
// (국토교통부 GIS건물통합정보, layer LT_C_BLDGINFO) into data/raw/vworld-buildings.json.
// tools/build-map.mjs uses that file, when it is there, in place of the OpenStreetMap buildings.
//
//   VWORLD_KEY=<your key> node tools/fetch-buildings.mjs
//
// The key is personal: it comes from the environment and is never written to a file.
import { mkdir, writeFile } from 'node:fs/promises';
import { REGION, bbox } from './region.mjs';

const KEY = process.env.VWORLD_KEY;
if (!KEY) { console.error('Set VWORLD_KEY to a V-World API key (https://www.vworld.kr).'); process.exit(1); }
const RAW = new URL('../data/raw/', import.meta.url);
const [south, west, north, east] = bbox(REGION, 60);
const COLS = 8, ROWS = 4, SIZE = 1000;           // the area is asked for in pieces: one request returns at most 1000 buildings

async function page(box, n) {
  const url = `https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LT_C_BLDGINFO&key=${KEY}&domain=localhost`
    + `&geomFilter=BOX(${box.join(',')})&crs=EPSG:4326&size=${SIZE}&page=${n}&format=json&geometry=true&attribute=true`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url), body = (await res.json()).response;
      if (body.status === 'NOT_FOUND') return { features: [], pages: 0 };
      if (body.status !== 'OK') throw new Error(`${body.status} ${JSON.stringify(body.error || '')}`);
      return { features: body.result.featureCollection.features, pages: Number(body.page.total) };
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
}

const seen = new Map();
for (let j = 0; j < ROWS; j++) {
  for (let i = 0; i < COLS; i++) {
    const box = [west + (east - west) * i / COLS, south + (north - south) * j / ROWS, west + (east - west) * (i + 1) / COLS, south + (north - south) * (j + 1) / ROWS].map(v => v.toFixed(6));
    let count = 0;
    for (let n = 1, pages = 1; n <= pages; n++) {
      const got = await page(box, n);
      pages = got.pages;
      for (const f of got.features) {
        // a building on the edge of two pieces comes twice: its first corner tells them apart
        const first = f.geometry.coordinates[0][0][0], key = `${first[0].toFixed(7)},${first[1].toFixed(7)},${f.properties.archarea}`;
        if (!seen.has(key)) seen.set(key, { g: f.geometry.coordinates.map(poly => poly[0].map(([lon, lat]) => [+lon.toFixed(7), +lat.toFixed(7)])), p: f.properties });
        count++;
      }
    }
    process.stdout.write(`piece ${j * COLS + i + 1}/${COLS * ROWS}: ${count}\n`);
  }
}
await mkdir(RAW, { recursive: true });
await writeFile(new URL('vworld-buildings.json', RAW), JSON.stringify({ source: 'V-World LT_C_BLDGINFO (국토교통부 GIS건물통합정보)', fetched: new Date().toISOString().slice(0, 10), buildings: [...seen.values()] }));
console.log(`${seen.size} buildings saved`);
