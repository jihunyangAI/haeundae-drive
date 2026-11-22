// Development check, not part of the game: one picture of every weather at every time of day.
// Run from the browser console:  (await import('/src/dev/skysheet.js')).skySheet(window.__game, 'chase')
// Returns a JPEG data URL of a grid: rows are times, columns are weathers.
import { TIMES, WEATHERS } from '../atmosphere.js';

export async function skySheet(game, view = 'chase', only = null) {
  const frame = () => new Promise(r => requestAnimationFrame(r));
  const scene = document.querySelector('#scene'), glass = document.querySelector('#glass');
  const times = TIMES.filter(t => !only || only.includes(t.id)), weathers = WEATHERS.filter(w => !only || only.includes(w.id));
  const W = only ? 800 : 480, H = W * 9 / 16, sheet = document.createElement('canvas'), g = sheet.getContext('2d');
  sheet.width = W * weathers.length;
  sheet.height = H * times.length;
  game.setState('drive');
  game.setView(view);
  for (const [i, t] of times.entries()) {
    for (const [j, w] of weathers.entries()) {
      game.setSky({ time: t.id, weather: w.id, instant: true });
      for (let k = 0; k < 90; k++) await frame();      // long enough for the wipers and drops to show
      g.drawImage(scene, j * W, i * H, W, H);          // same frame as the render, so the picture is still there
      if (!glass.hidden) g.drawImage(glass, j * W, i * H, W, H);
    }
  }
  return sheet.toDataURL('image/jpeg', 0.85);
}
