// Car radio: built-in channels of freely licensed music plus the player's own files.
// Channels behave like broadcasts: tuning in lands somewhere in the middle of whatever is "on air".
const STATIC_TIME = 0.45;      // seconds of hiss when changing channel

export class Radio {
  constructor() {
    this.channels = [];
    this.mine = { id: 'mine', name: '내 음악', freq: '내 파일', tracks: [] };
    this.index = 0;            // position in `stations`; -1 is off
    this.track = null;
    this.volume = 0.6;
    this.inside = false;
    this.signal = 1;
    this.muted = false;
    this.onchange = () => {};
  }

  async load(url) {
    try {
      const data = await (await fetch(url)).json();
      this.base = url.slice(0, url.lastIndexOf('/') + 1);
      this.channels = data.channels;
      if (!this.ctx && this.station) this.track = this.onAir(this.station)[0];
    } catch (e) {
      console.warn('radio channels unavailable', e);
      this.index = -1;
    }
    this.onchange();
  }

  // the stations the dial stops at; "my music" only once files have been added
  get stations() { return this.mine.tracks.length ? [...this.channels, this.mine] : this.channels; }
  get station() { return this.stations[this.index] || null; }

  // Needs a running AudioContext, so this is called from the first click or key press.
  start(ctx) {
    if (this.ctx) return;
    this.ctx = ctx;
    this.audio = new Audio();
    this.audio.crossOrigin = 'anonymous';
    this.audio.preload = 'auto';
    this.audio.addEventListener('ended', () => this.advance());
    this.audio.addEventListener('error', () => { if (this.track) console.warn('radio: cannot play', this.track.title); });
    this.tone = ctx.createBiquadFilter();        // open in the cabin, muffled from outside the car
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 18000;
    this.music = ctx.createGain();
    this.music.gain.value = 0;
    ctx.createMediaElementSource(this.audio).connect(this.tone).connect(this.music).connect(ctx.destination);

    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource(), band = ctx.createBiquadFilter();
    noise.buffer = buffer;
    noise.loop = true;
    band.type = 'bandpass';
    band.frequency.value = 2400;
    band.Q.value = 0.5;
    this.hiss = ctx.createGain();
    this.hiss.gain.value = 0;
    noise.connect(band).connect(this.hiss).connect(ctx.destination);
    noise.start();
    this.tune(this.index, false);
  }

  // Where a channel's broadcast is right now: [track, seconds into it].
  onAir(station) {
    const total = station.tracks.reduce((sum, t) => sum + t.seconds, 0);
    let seed = 0;
    for (const ch of station.id) seed = seed * 31 + ch.charCodeAt(0) & 0xffff;     // channels are out of step with each other
    let at = (Date.now() / 1000 + seed * 7) % total;
    for (const t of station.tracks) {
      if (at < t.seconds - 2) return [t, at];
      at -= t.seconds;
    }
    return [station.tracks[0], 0];
  }

  tune(index, withStatic = true) {
    const count = this.stations.length;
    this.index = count ? Math.max(-1, Math.min(count - 1, index)) : -1;
    const station = this.station;
    if (!station) this.track = null;
    else if (station === this.mine) this.track = this.mine.tracks[0];
    if (!this.ctx) {
      if (station && station !== this.mine) this.track = this.onAir(station)[0];
      this.onchange();
      return;
    }
    const t = this.ctx.currentTime;
    if (withStatic) {
      this.hiss.gain.cancelScheduledValues(t);
      this.hiss.gain.setValueAtTime(this.muted ? 0 : 0.5 * this.volume, t);
      this.hiss.gain.linearRampToValueAtTime(0, t + STATIC_TIME);
    }
    this.music.gain.cancelScheduledValues(t);
    this.music.gain.setValueAtTime(0, t);
    this.fadeUntil = t + STATIC_TIME + 0.3;
    if (!station) {
      this.audio.pause();
    } else if (station === this.mine) {
      this.play(this.track, 0);
    } else {
      const [track, at] = this.onAir(station);
      this.play(track, at);
    }
    this.onchange();
  }

  play(track, at) {
    this.track = track;
    const audio = this.audio;
    audio.src = track.url || this.base + track.file;
    const begin = () => {
      if (at > 0 && Number.isFinite(audio.duration)) audio.currentTime = Math.min(at, Math.max(0, audio.duration - 2));
      audio.play().catch(() => {});
    };
    if (at > 0) audio.addEventListener('loadedmetadata', begin, { once: true }); else begin();
  }

  // next track when one ends
  advance() {
    const station = this.station;
    if (!station) return;
    const tracks = station.tracks;
    this.play(tracks[(tracks.indexOf(this.track) + 1) % tracks.length], 0);
    this.onchange();
  }

  // step: +1 / -1 round the dial, with "off" between the last station and the first
  turn(step) {
    const count = this.stations.length + 1;
    this.tune(((this.index + 1 + step) % count + count) % count - 1);
  }

  // The player's own files. They are played from the browser's memory and never uploaded.
  addFiles(files) {
    const added = [...files].filter(f => f.type.startsWith('audio/') || /\.(mp3|m4a|ogg|wav|flac|opus)$/i.test(f.name));
    for (const f of added) this.mine.tracks.push({ title: f.name.replace(/\.[^.]+$/, ''), artist: '내 파일', url: URL.createObjectURL(f), seconds: 0 });
    if (added.length) this.tune(this.stations.indexOf(this.mine));
    return added.length;
  }

  // Called every frame. inside: driver's view. signal: 0..1 reception (weak in a tunnel).
  update(inside, signal, active) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone.frequency.setTargetAtTime(inside ? 18000 : 1500, t, 0.15);
    if (t < (this.fadeUntil || 0) - 0.3) return;                          // still in the hiss between channels
    const level = !this.station || this.muted || !active ? 0 : this.volume * (inside ? 1 : 0.55) * (0.2 + 0.8 * signal);
    this.music.gain.setTargetAtTime(level, t, 0.12);
    if (t > (this.fadeUntil || 0)) this.hiss.gain.setTargetAtTime(this.station && !this.muted && active ? (1 - signal) * 0.25 * this.volume : 0, t, 0.2);
  }
}
