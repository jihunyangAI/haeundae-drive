// The sounds around the car, all synthesised: tyres on the road, the traffic passing, the sea, birds,
// the beeping of a pedestrian crossing, thunder, the wipers. Where something is decides which ear it is in.
// start(sound) is called once the engine sound has an audio context (after the first click).

const VOICES = 4;         // how many passing cars can be heard at once

export class Ambience {
  constructor() {
    this.ctx = null;
    this.volume = 1;          // 0..1, from the sound panel
    this.birdWait = 3;
    this.beepWait = 0;
  }

  start(sound) {
    if (this.ctx || !sound.ctx) return;
    const ctx = this.ctx = sound.ctx;
    this.out = ctx.createGain();
    this.out.connect(sound.master);
    // one stretch of noise feeds everything that hisses or rumbles
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate), data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = this.noise = ctx.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;
    const chain = (type, frequency, q, pan = false) => {
      const filter = ctx.createBiquadFilter(), gain = ctx.createGain(), panner = pan ? ctx.createStereoPanner() : null;
      filter.type = type;
      filter.frequency.value = frequency;
      filter.Q.value = q;
      gain.gain.value = 0;
      noise.connect(filter).connect(gain);
      if (panner) gain.connect(panner).connect(this.out); else gain.connect(this.out);
      return { filter, gain, panner };
    };
    this.tyres = chain('bandpass', 900, 0.5);
    // the sea: a wash that swells and falls every few seconds
    this.sea = chain('lowpass', 520, 0.3, true);
    this.swell = ctx.createGain();
    this.swell.gain.value = 0;
    const tide = ctx.createOscillator(), depth = ctx.createGain();
    tide.frequency.value = 0.13;
    depth.gain.value = 0.45;
    this.sea.gain.disconnect();
    this.sea.gain.gain.value = 0.55;
    tide.connect(depth).connect(this.sea.gain.gain);
    this.sea.gain.connect(this.swell).connect(this.sea.panner).connect(this.out);
    tide.start();
    // passing cars: tyre hiss and a low engine note each
    this.voices = [];
    for (let i = 0; i < VOICES; i++) {
      const v = chain('bandpass', 650, 0.6, true), hum = ctx.createOscillator(), humGain = ctx.createGain(), tone = ctx.createBiquadFilter();
      hum.type = 'sawtooth';
      hum.frequency.value = 70;
      tone.type = 'lowpass';
      tone.frequency.value = 320;
      humGain.gain.value = 0.5;
      hum.connect(tone).connect(humGain).connect(v.gain);
      hum.start();
      this.voices.push({ ...v, hum });
    }
    noise.start();
  }

  // What can be heard now.
  //   speed: of the player's car, m/s. wet: 0..1 water on the road. inside: heard from the driver's seat.
  //   cars: [{ pan: -1..1, gain: 0..1, speed }] the nearest of the traffic, loudest first.
  //   sea: { gain, pan }. birds: 0..1 how many are singing. crossing: { gain, pan, hurry } or null.
  update(dt, { active, speed, wet, inside, cars, sea, birds, crossing }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, outside = inside ? 0.5 : 1;
    this.out.gain.setTargetAtTime(active ? this.volume : 0, t, 0.1);
    // tyres: a rumble that grows with speed, and a hiss on a wet road
    this.tyres.filter.frequency.setTargetAtTime(700 + speed * 22 + wet * 1900, t, 0.2);
    this.tyres.gain.gain.setTargetAtTime(Math.min(0.09, speed / 300) * (1 + wet * 0.5) * (inside ? 0.8 : 1), t, 0.15);
    this.voices.forEach((v, i) => {
      const c = cars[i];
      v.gain.gain.setTargetAtTime(c ? c.gain * 0.16 * outside : 0, t, 0.12);
      if (!c) return;
      v.panner.pan.setTargetAtTime(c.pan, t, 0.1);
      v.filter.frequency.setTargetAtTime(500 + c.speed * 30 + wet * 1200, t, 0.2);
      v.hum.frequency.setTargetAtTime(55 + c.speed * 4, t, 0.2);
    });
    this.swell.gain.setTargetAtTime(sea.gain * 0.3 * outside, t, 0.6);
    this.sea.panner.pan.setTargetAtTime(sea.pan * 0.7, t, 0.6);

    this.birdWait -= dt;
    if (active && birds > 0.05 && this.birdWait <= 0) {
      this.birdWait = Math.min(12, (2 + Math.random() * 7) / birds);
      this.chirp(0.035 * birds * outside);
    }
    this.beepWait -= dt;
    if (active && crossing && this.beepWait <= 0) {
      this.beepWait = crossing.hurry ? 0.28 : 0.9;
      this.beep(crossing.gain * 0.05 * outside, crossing.pan);
    }
  }

  // one enveloped tone, panned
  note(frequencies, at, length, volume, pan, type = 'sine') {
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain(), p = ctx.createStereoPanner();
    o.type = type;
    o.frequency.setValueAtTime(frequencies[0], at);
    frequencies.slice(1).forEach((f, i) => o.frequency.linearRampToValueAtTime(f, at + length * (i + 1) / (frequencies.length - 1)));
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(volume, at + Math.min(0.01, length / 3));
    g.gain.linearRampToValueAtTime(0, at + length);
    p.pan.value = pan;
    o.connect(g).connect(p).connect(this.out);
    o.start(at);
    o.stop(at + length + 0.02);
  }

  // a small bird: two to five quick falling notes
  chirp(volume) {
    const t = this.ctx.currentTime, pan = Math.random() * 1.6 - 0.8, base = 2600 + Math.random() * 1800, n = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) this.note([base * (1.15 + Math.random() * 0.1), base * 0.9], t + i * 0.11, 0.07, volume, pan);
  }

  // the crossing signal for people who cannot see it: a pair of pips
  beep(volume, pan) {
    if (volume < 0.002) return;
    const t = this.ctx.currentTime;
    this.note([1150, 1150], t, 0.07, volume, pan, 'square');
    this.note([880, 880], t + 0.11, 0.07, volume, pan, 'square');
  }

  // a burst of filtered noise: gain rises in `rise` seconds and dies away over `length`
  burst(frequency, q, volume, rise, length, sweepTo = frequency) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime, filter = ctx.createBiquadFilter(), g = ctx.createGain();
    filter.type = 'bandpass';
    filter.Q.value = q;
    filter.frequency.setValueAtTime(frequency, t);
    filter.frequency.linearRampToValueAtTime(sweepTo, t + length);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(volume, t + rise);
    g.gain.exponentialRampToValueAtTime(0.0008, t + length);
    this.noise.connect(filter).connect(g).connect(this.out);
    setTimeout(() => { this.noise.disconnect(filter); g.disconnect(); }, (length + 0.3) * 1000);
  }

  // near: 0..1 how close the lightning was. Close thunder cracks, far thunder only rolls.
  thunder(near) {
    if (near > 0.6) this.burst(900, 0.4, 0.5 * near, 0.02, 0.5, 200);
    this.burst(90, 0.5, 0.9 * (0.4 + near * 0.6), 0.15, 3.5 + Math.random() * 2, 50);
  }

  // one sweep of the wipers, heard from inside
  wipe() { this.burst(520, 1.2, 0.05, 0.08, 0.38, 900); }
}
