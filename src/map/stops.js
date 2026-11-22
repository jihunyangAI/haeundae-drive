// Bus stops. The map data has none, so they are set out by rule: on the kerb lane of the through
// streets, well clear of the junctions, a few hundred metres apart. No rendering in here.
//
// Each stop is { id, name, lane, s, x, z, ux, uz, kx, kz }: the point of the lane where a bus halts and
// its direction of travel there, and (kx, kz) the spot on the pavement where the shelter stands.

const SPACING = 260;          // no two stops on the same side closer than this, metres
export const PLACES = { 해운대해변로: '해운대해수욕장', 달맞이길: '달맞이길', 마린시티1로: '마린시티', 해운대로: '해운대로', 좌동순환로: '좌동', 청사포로: '청사포', 동백로: '동백섬', 우동1로: '우동' };

// usable(x, z): may a shelter stand here (dry land, clear of every carriageway)?
export function buildStops(graph, usable = () => true) {
  const stops = [], counts = {};
  for (const lane of graph.lanes) {
    const road = lane.road;
    if (lane.index !== lane.count - 1 || lane.link.short || !road.n || !/^(primary|secondary|tertiary)$/.test(road.k) || lane.len < 130) continue;
    // past the middle of the stretch, but not in the queue for the junction ahead
    let s = Math.min(lane.len - 55, Math.max(50, lane.len * 0.62)), i = 1, run = 0;
    for (; i < lane.pts.length - 1; i++) { const d = Math.hypot(lane.pts[i][0] - lane.pts[i - 1][0], lane.pts[i][1] - lane.pts[i - 1][1]); if (run + d >= s) break; run += d; }
    const a = lane.pts[i - 1], b = lane.pts[i], seg = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, t = Math.min(1, (s - run) / seg);
    const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t, ux = (b[0] - a[0]) / seg, uz = (b[1] - a[1]) / seg;
    if (stops.some(o => Math.hypot(o.x - x, o.z - z) < SPACING && o.ux * ux + o.uz * uz > 0)) continue;
    const out = road.w / 2 - Math.abs(lane.o) + 1.3;          // from the middle of the kerb lane to the shelter, which stands at the kerb
    if (!usable(x - uz * out, z + ux * out)) continue;
    const base = PLACES[road.n] || road.n, n = counts[base] = (counts[base] || 0) + 1;
    const stop = { id: stops.length, name: n > 1 ? `${base} ${n}` : base, lane, s, x, z, ux, uz, kx: x - uz * out, kz: z + ux * out, waiting: 0, shelter: false };
    lane.stop = stop;
    stops.push(stop);
  }
  return stops;
}
