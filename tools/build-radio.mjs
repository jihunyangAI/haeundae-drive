// Writes public/radio/channels.json: the built-in radio channels, their tracks, each track's length
// and where it came from. Every track's source and licence is recorded here (plan 7.3).
// Run with: npm run radio:build
import { readFileSync, writeFileSync, statSync } from 'node:fs';

const MACLEOD = {
  artist: 'Kevin MacLeod', licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
  source: 'https://incompetech.com',
};
const track = (file, title) => ({ file, title, ...MACLEOD });

const CHANNELS = [
  { id: 'jazz', name: '재즈 라운지', freq: '89.1', tracks: [
    track('jazz/lobby-time.mp3', 'Lobby Time'), track('jazz/bossa-antigua.mp3', 'Bossa Antigua'),
    track('jazz/local-forecast-elevator.mp3', 'Local Forecast - Elevator'),
  ] },
  { id: 'acoustic', name: '어쿠스틱', freq: '93.5', tracks: [
    track('acoustic/carefree.mp3', 'Carefree'), track('acoustic/easy-lemon.mp3', 'Easy Lemon'), track('acoustic/life-of-riley.mp3', 'Life of Riley'),
  ] },
  { id: 'groove', name: '시티 그루브', freq: '97.3', tracks: [
    track('groove/funkorama.mp3', 'Funkorama'), track('groove/groove-grove.mp3', 'Groove Grove'), track('groove/cool-vibes.mp3', 'Cool Vibes'),
  ] },
  { id: 'chill', name: '칠 로파이', freq: '101.9', tracks: [
    track('chill/dreamy-flashback.mp3', 'Dreamy Flashback'), track('chill/deep-haze.mp3', 'Deep Haze'), track('chill/chill-wave.mp3', 'Chill Wave'),
  ] },
];

const BITRATES = { 1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

// Length of an MP3 in seconds, by walking its frames (layer III only).
function mp3Seconds(path) {
  const b = readFileSync(path);
  let i = 0;
  if (b.toString('latin1', 0, 3) === 'ID3') i = 10 + ((b[6] & 127) << 21 | (b[7] & 127) << 14 | (b[8] & 127) << 7 | (b[9] & 127));
  let seconds = 0, frames = 0;
  while (i + 4 < b.length) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) { i++; continue; }
    const version = b[i + 1] >> 3 & 3, layer = b[i + 1] >> 1 & 3, bitrateIndex = b[i + 2] >> 4, rateIndex = b[i + 2] >> 2 & 3, padding = b[i + 2] >> 1 & 1;
    const rate = RATES[version]?.[rateIndex], kbps = BITRATES[version === 3 ? 1 : 2][bitrateIndex];
    if (layer !== 1 || !rate || !kbps) { i++; continue; }
    const samples = version === 3 ? 1152 : 576;
    i += Math.floor(samples / 8 * kbps * 1000 / rate) + padding;
    seconds += samples / rate;
    frames++;
  }
  if (frames < 100) throw new Error(`${path}: not an MP3`);
  return seconds;
}

let bytes = 0;
for (const c of CHANNELS) {
  for (const t of c.tracks) {
    const path = `public/radio/${t.file}`;
    t.seconds = +mp3Seconds(path).toFixed(1);
    bytes += statSync(path).size;
    console.log(`${c.name}  ${t.title}  ${Math.floor(t.seconds / 60)}:${String(Math.round(t.seconds % 60)).padStart(2, '0')}`);
  }
}
writeFileSync('public/radio/channels.json', JSON.stringify({ channels: CHANNELS }, null, 1));
console.log(`${CHANNELS.length} channels, ${(bytes / 1e6).toFixed(0)} MB`);
