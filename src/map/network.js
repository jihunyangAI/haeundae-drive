// Street network analysis: where streets meet, and the stretches between junctions.

// Korean urban defaults (km/h) where the map carries no limit: 50 on through streets, 30 on side streets
const LIMIT = { motorway: 80, trunk: 70, primary: 50, secondary: 50, tertiary: 50 };
export const limitOf = road => road.ms || LIMIT[road.k.replace(/_link$/, '')] || 30;

// Which level a road is on: 1 a bridge the game builds, -1 an underpass, 0 the ground.
export const levelOf = road => (road.dk ? 1 : road.tn && road.c === 'drive' && road.k !== 'service' && road.len > 40 ? -1 : 0);

// Streets are the drivable roads that get markings and kerbs; driveways and the elevated expressway are left out.
export function analyseStreets(map) {
  const uses = new Map();
  const streets = map.roads
    .filter(r => r.c === 'drive' && (!r.br || r.dk) && r.k !== 'service' && r.k !== 'busway')
    .map(road => {
      const p = road.p, cum = [0];
      for (let i = 2; i < p.length; i += 2) cum.push(cum.at(-1) + Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]));
      const st = { road, cum, len: cum.at(-1), cuts: [] };

      // position and unit direction at distance s along the street
      st.at = s => {
        s = Math.min(st.len, Math.max(0, s));
        let i = 1;
        while (i < cum.length - 1 && cum[i] < s) i++;
        const seg = cum[i] - cum[i - 1] || 1, t = (s - cum[i - 1]) / seg;
        const ax = p[i * 2 - 2], az = p[i * 2 - 1], dx = p[i * 2] - ax, dz = p[i * 2 + 1] - az;
        return { x: ax + dx * t, z: az + dz * t, ux: dx / seg, uz: dz / seg };
      };
      // flat [x, z, ...] polyline for the stretch s0..s1
      st.slice = (s0, s1) => {
        const a = st.at(s0), b = st.at(s1), out = [a.x, a.z];
        for (let i = 1; i < cum.length - 1; i++) if (cum[i] > s0 + 0.01 && cum[i] < s1 - 0.01) out.push(p[i * 2], p[i * 2 + 1]);
        out.push(b.x, b.z);
        return out;
      };
      // Stretches left after clearing pad(cut) metres either side of every junction.
      // startJ / endJ name the junction a stretch stops at (null at the end of the road).
      st.intervals = pad => {
        const cuts = st.cuts.map(c => [c.s - pad(c), c.s + pad(c), c]).sort((a, b) => a[0] - b[0]);
        const out = [];
        let s = 0, startJ = null;
        for (const [from, to, cut] of cuts) {
          if (from - s > 4) out.push({ s0: s, s1: from, startJ, endJ: cut });
          if (to > s) { s = to; startJ = cut; }
        }
        if (st.len - s > 4) out.push({ s0: s, s1: st.len, startJ, endJ: null });
        return out;
      };

      for (let v = 0; v < cum.length; v++) {
        const key = `${p[v * 2]},${p[v * 2 + 1]}`;
        if (!uses.has(key)) uses.set(key, []);
        uses.get(key).push({ st, v });
      }
      return st;
    });

  // A junction is a point where three or more street arms meet (two is just one street continuing).
  const junctions = [];
  for (const [key, arms] of uses) {
    const degree = arms.reduce((d, { st, v }) => d + (v > 0) + (v < st.cum.length - 1), 0);
    if (arms.length < 2 || degree < 3) continue;
    const [x, z] = key.split(',').map(Number);
    const junction = { x, z, roads: arms.map(a => a.st.road) };
    junctions.push(junction);
    for (const { st, v } of arms) {
      const others = arms.filter(a => a.st !== st);
      // half: half-width of the widest street crossing this one here
      st.cuts.push({ s: st.cum[v], half: Math.max(...(others.length ? others : arms).map(a => a.st.road.w / 2)), junction });
    }
  }
  return { streets, junctions };
}
