// Synthesised engine, wind and rain noise. Browsers only allow audio after a user gesture, so start() is
// called from the "start driving" button.
export class EngineSound {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.volumes = { engine: 1, rain: 1 };   // each 0..1, set from the sound panel
  }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const ctx = this.ctx = new AudioContext();
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(ctx.destination);

    this.saw = ctx.createOscillator();
    this.saw.type = 'sawtooth';
    this.sub = ctx.createOscillator();
    this.sub.type = 'square';
    const subGain = ctx.createGain();
    subGain.gain.value = 0.5;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.engine = ctx.createGain();
    this.engine.gain.value = 0;
    this.saw.connect(this.filter);
    this.sub.connect(subGain).connect(this.filter);
    this.filter.connect(this.engine).connect(this.master);
    this.saw.start();
    this.sub.start();

    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 700;
    band.Q.value = 0.6;
    this.wind = ctx.createGain();
    this.wind.gain.value = 0;
    src.connect(band).connect(this.wind).connect(this.master);
    // rain: the same noise, bright in the open and a dull drumming on the roof from inside
    this.rainTone = ctx.createBiquadFilter();
    this.rainTone.type = 'bandpass';
    this.rainTone.frequency.value = 3200;
    this.rainTone.Q.value = 0.4;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    src.connect(this.rainTone).connect(this.rainGain).connect(this.master);
    src.start();
  }

  // active: false silences the car (menu)
  update(rpm, throttle, speed, active) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, firing = rpm / 60 * 2;      // four-cylinder firing frequency
    this.saw.frequency.setTargetAtTime(firing, t, 0.03);
    this.sub.frequency.setTargetAtTime(firing / 2, t, 0.03);
    this.filter.frequency.setTargetAtTime(250 + rpm * 0.18 + throttle * 900, t, 0.05);
    this.engine.gain.setTargetAtTime(active ? (0.05 + throttle * 0.09 + rpm / 60000) * this.volumes.engine : 0, t, 0.08);
    this.wind.gain.setTargetAtTime(active ? Math.min(0.25, speed * speed / 9000) * this.volumes.engine : 0, t, 0.2);
  }

  // The horn sounds for as long as it is held.
  horn(on) {
    if (!this.ctx || (!on && !this.hornGain)) return;
    if (!this.hornGain) {
      this.hornGain = this.ctx.createGain();
      this.hornGain.gain.value = 0;
      const tone = this.ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = 2400;
      for (const f of [415, 520]) {
        const o = this.ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.connect(tone);
        o.start();
      }
      tone.connect(this.hornGain).connect(this.master);
    }
    this.hornGain.gain.setTargetAtTime(on ? 0.22 * this.volumes.engine : 0, this.ctx.currentTime, 0.012);
  }

  // Another driver's horn, somewhere near: a short double note. volume 0..1.
  honk(volume) {
    if (!this.ctx || volume <= 0.01) return;
    const t = this.ctx.currentTime, g = this.ctx.createGain(), tone = this.ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 1800;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16 * volume * this.volumes.engine, t + 0.02);
    g.gain.setValueAtTime(0.16 * volume * this.volumes.engine, t + 0.42);
    g.gain.linearRampToValueAtTime(0, t + 0.5);
    for (const f of [440, 554]) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(tone);
      o.start(t);
      o.stop(t + 0.55);
    }
    tone.connect(g).connect(this.master);
  }

  // The click of the turn signal relay; `high` for the on half of the blink.
  tick(high) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'square';
    o.frequency.value = high ? 1900 : 1500;
    g.gain.setValueAtTime(0.05 * this.volumes.engine, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.03);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.04);
  }

  // amount 0..1; inside: heard from the driver's seat
  setRain(amount, inside) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.rainTone.frequency.setTargetAtTime(inside ? 650 : 3200, t, 0.15);
    this.rainGain.gain.setTargetAtTime(amount * (inside ? 0.55 : 0.3) * this.volumes.rain, t, 0.3);
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.5, this.ctx.currentTime, 0.05);
    return this.muted;
  }
}
