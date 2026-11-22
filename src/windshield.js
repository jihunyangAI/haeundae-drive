// Drops on the windscreen and the wipers that clear them, drawn over the picture in the driver's view.
// Everything is in fractions of the screen so it survives a resize.
const PIVOTS = [0.3, 0.72];             // where the two wiper arms are hinged, across the screen
const REST = 0.05, FAR = 1.95;          // blade angles in radians, measured from pointing right, anticlockwise
const ARM = 0.4;                        // blade length, as a fraction of the screen width
const SWEEP = 1.25;                     // seconds for one stroke out and back

export class Windshield {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.drops = [];
    this.phase = 0;          // 0..1 through one wiper stroke
    this.resting = true;
    this.wait = 0;
  }

  // amount: 0..1 precipitation. snow: flakes instead of drops. speed in m/s.
  // top, bottom: the edges of the glass as fractions of the screen height.
  update(dt, { visible, amount, snow, speed, top = 0.25, bottom = 0.65 }) {
    const c = this.canvas, g = this.g;
    if (!visible || (amount < 0.02 && !this.drops.length && this.resting)) {
      if (!c.hidden) { c.hidden = true; this.drops.length = 0; }
      return;
    }
    if (c.hidden) c.hidden = false;
    if (c.width !== c.clientWidth || c.height !== c.clientHeight) { c.width = c.clientWidth; c.height = c.clientHeight; }
    const W = c.width, H = c.height;

    // new drops: more of them the faster the car runs into the rain
    const rate = amount * (60 + speed * 4);
    for (let n = rate * dt + Math.random(); n >= 1 && this.drops.length < 420; n--) {
      this.drops.push({ x: Math.random(), y: top + Math.random() * (bottom - top), r: 2.5 + Math.random() * Math.random() * 8, snow });
    }
    // airflow pushes drops up the glass at speed; at rest they creep down
    const slide = (0.012 - Math.min(0.05, speed * 0.0022)) * dt;
    const dry = amount < 0.05 ? dt * 2.5 : 0;      // once it stops, what is left on the glass dries off
    for (const d of this.drops) { d.y += slide * d.r; d.r -= dry; }
    this.drops = this.drops.filter(d => d.y > top && d.y < bottom && d.r > 0.6);

    // wipers run while anything is falling, then finish their stroke and park
    const before = this.angle();
    if (this.resting) {
      this.wait -= dt;
      if (amount > 0.05 && this.wait <= 0) this.resting = false;
    } else {
      this.phase += dt / SWEEP;
      if (this.phase >= 1) { this.phase = 0; this.resting = true; this.wait = amount > 0.6 ? 0.15 : 1.2; }
    }
    const after = this.angle(), lo = Math.min(before, after) - 0.02, hi = Math.max(before, after) + 0.02;
    if (after !== before) {
      const aspect = H / W;
      this.drops = this.drops.filter(d => !PIVOTS.some(px => {
        const dx = d.x - px, dy = (bottom + 0.02 - d.y) * aspect, dist = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
        return dist > ARM * 0.18 && dist < ARM && a > lo && a < hi;
      }));
    }

    g.clearRect(0, 0, W, H);
    g.save();
    g.beginPath();
    g.rect(0, top * H, W, (bottom - top) * H);
    g.clip();
    for (const d of this.drops) {
      const x = d.x * W, y = d.y * H;
      g.fillStyle = d.snow ? 'rgba(240,244,250,0.55)' : 'rgba(200,218,240,0.26)';
      g.beginPath();
      g.arc(x, y, d.r, 0, 7);
      g.fill();
      if (!d.snow) {
        g.fillStyle = 'rgba(255,255,255,0.4)';
        g.beginPath();
        g.arc(x - d.r * 0.3, y - d.r * 0.3, d.r * 0.28, 0, 7);
        g.fill();
      }
    }
    g.strokeStyle = '#08090b';
    g.lineCap = 'round';
    for (const px of PIVOTS) {
      const x = px * W, y = (bottom + 0.02) * H, ex = x + Math.cos(after) * ARM * W, ey = y - Math.sin(after) * ARM * W;
      g.lineWidth = Math.max(4, W * 0.005);
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(ex, ey);
      g.stroke();
    }
    g.restore();
  }

  angle() {
    return REST + (FAR - REST) * (0.5 - 0.5 * Math.cos(this.phase * Math.PI * 2));
  }
}
