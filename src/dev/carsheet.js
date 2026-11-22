// Development check, not part of the game: pictures of the cars from several sides.
// Run from the browser console:  (await import('/src/dev/carsheet.js')).carSheet(window.__game)
// Returns a JPEG data URL of a grid: one row per car, one column per view.
const VIEWS = [
  { angle: 0.65, dist: 6.4, height: 1.5 },     // front three-quarter
  { angle: Math.PI / 2, dist: 7, height: 1.0 }, // side
  { angle: Math.PI - 0.6, dist: 6.4, height: 1.6 },   // rear three-quarter
  { angle: 0, dist: 5.6, height: 0.9 },         // front
  { angle: Math.PI, dist: 5.6, height: 1.0 },   // rear
  { angle: 0.9, dist: 5.5, height: 4.6 },       // from above
];

export async function carSheet(game, { cars = [0, 1, 2, 3], views = VIEWS, width = 480 } = {}) {
  const frame = () => new Promise(r => requestAnimationFrame(r));
  const scene = document.querySelector('#scene'), W = width, H = W * 9 / 16, sheet = document.createElement('canvas'), g = sheet.getContext('2d');
  sheet.width = W * views.length;
  sheet.height = H * cars.length;
  document.querySelector('#menu').style.visibility = 'hidden';
  game.setState('menu');
  for (const [i, car] of cars.entries()) {
    game.selectCar(car);
    for (const [j, view] of views.entries()) {
      game.pose = { fov: 40, ...view };
      for (let k = 0; k < 40; k++) await frame();
      g.drawImage(scene, j * W, i * H, W, H);
    }
  }
  game.pose = null;
  document.querySelector('#menu').style.visibility = '';
  return sheet.toDataURL('image/jpeg', 0.88);
}
