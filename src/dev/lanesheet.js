// Development check, not part of the game: plans of junctions with their lanes, the movements across
// them and what the signals allow at one moment.
// Run from the browser console:  (await import('/src/dev/lanesheet.js')).laneSheet(window.__game.world, { ids: [3, 14], time: 12 })
// Green: may go. Amber: may go but gives way. Red: must wait. Blue bars: people may cross that arm.
import { signalState, mayGo } from '../map/lanes.js';

export function laneSheet(world, { ids, time = 0, size = 420, span = 55, cols = 3 } = {}) {
  const g = world.lanes, list = ids.map(id => g.junctions[id]), rows = Math.ceil(list.length / cols);
  const sheet = document.createElement('canvas'), c = sheet.getContext('2d');
  sheet.width = size * Math.min(cols, list.length);
  sheet.height = size * rows;
  c.fillStyle = '#20242a';
  c.fillRect(0, 0, sheet.width, sheet.height);
  list.forEach((j, n) => {
    const ox = (n % cols) * size, oy = Math.floor(n / cols) * size, k = size / (2 * span);
    const X = x => ox + (x - j.x + span) * k, Y = z => oy + (z - j.z + span) * k;
    const line = (pts, colour, width) => { c.strokeStyle = colour; c.lineWidth = width; c.beginPath(); pts.forEach((p, i) => (i ? c.lineTo(X(p[0]), Y(p[1])) : c.moveTo(X(p[0]), Y(p[1])))); c.stroke(); };
    c.save();
    c.beginPath();
    c.rect(ox, oy, size, size);
    c.clip();
    for (const r of world.map.roads) {
      if (r.c !== 'drive') continue;
      const pts = [];
      for (let i = 0; i < r.p.length; i += 2) pts.push([r.p[i], r.p[i + 1]]);
      line(pts, r.br ? '#3b3f47' : '#343941', r.w * k);
    }
    const state = j.signal ? signalState(j, time) : null;
    for (const lane of g.lanes) if (Math.hypot(lane.pts[0][0] - j.x, lane.pts[0][1] - j.z) < span * 2.5 || Math.hypot(lane.pts.at(-1)[0] - j.x, lane.pts.at(-1)[1] - j.z) < span * 2.5) line(lane.pts, '#8b93a0', 1);
    for (const m of j.moves) {
      const go = state ? mayGo(m, state) : m.arm.give === 'stop' ? 'yield' : 'go';
      line(m.pts, go === 'go' ? '#2fd45f' : go === 'yield' ? '#f0b429' : 'rgba(230,60,60,0.5)', go === 'stop' ? 1 : 2.2);
    }
    for (const arm of j.arms) {
      const walk = state?.arms[arm.id].walk ?? 'stop', px = -arm.dir[1], pz = arm.dir[0], h = arm.road.w / 2, bx = arm.x + arm.dir[0] * 3, bz = arm.z + arm.dir[1] * 3;
      if (walk !== 'stop') line([[bx - px * h, bz - pz * h], [bx + px * h, bz + pz * h]], walk === 'walk' ? '#4aa3ff' : '#a9d2ff', 5);
      if (arm.give === 'stop' || arm.give === 'signal') line([[arm.x, arm.z], [arm.x - px * h, arm.z - pz * h]], '#ffffff', 2);
      c.fillStyle = '#fff';
      c.font = '12px sans-serif';
      c.fillText(`${arm.id}${arm.arrow ? '←' : ''}`, X(arm.x - arm.dir[0] * 9) - 4, Y(arm.z - arm.dir[1] * 9) + 4);
    }
    c.fillStyle = '#fff';
    c.font = '13px sans-serif';
    const what = j.signal ? `${j.signal.stages[0].split ? 'one approach at a time' : 'paired'}, ${Math.round(j.signal.cycle)}s, ${state.step.kind}` : j.control;
    c.fillText(`#${j.id}  ${j.arms.length} arms  ${what}`, ox + 8, oy + 18);
    c.restore();
    c.strokeStyle = '#000';
    c.strokeRect(ox, oy, size, size);
  });
  return sheet.toDataURL('image/jpeg', 0.9);
}
