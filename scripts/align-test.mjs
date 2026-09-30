// Offline check of src/align.ts: raw Whisper words for the demo clip (as the app produced them before alignment)
// against tmp/demo-audio.wav (16 kHz mono, `ffmpeg -i public/demo.webm -vn -ac 1 -ar 16000 tmp/demo-audio.wav`).
// Reference onsets read off the RMS envelope: speech starts 0.33, "ask" 3.29, "not" 4.01, "what" 5.42.
import { readFileSync } from 'node:fs';
import { alignToOnsets, debugOnsets } from '../src/align.ts';

const wav = readFileSync(process.env.WAV ?? 'tmp/demo-audio.wav');
const dataOff = wav.indexOf('data') + 8;
const pcm = new Int16Array(wav.buffer, wav.byteOffset + dataOff, (wav.length - dataOff) >> 1);
const audio = Float32Array.from(pcm, (v) => v / 32768);

const raw = [[0.52,0.86,'And'],[0.86,1.2,'so'],[1.2,1.54,'my'],[1.54,2.1,'fellow'],[2.1,3.74,'Americans'],[3.74,4.24,'ask'],[4.24,5.52,'not'],
  [5.52,5.76,'what'],[5.76,6.2,'your'],[6.2,6.6,'country'],[6.6,6.84,'can'],[6.84,7.08,'do'],[7.08,7.32,'for'],[7.32,8.0,'you,'],
  [8.48,8.74,'ask'],[8.74,9.02,'what'],[9.02,9.34,'you'],[9.34,9.56,'can'],[9.56,9.78,'do'],[9.78,9.96,'for'],[9.96,10.34,'your'],[10.34,10.84,'country.']]
  .map(([start, end, text]) => ({ start, end, text }));

const d = debugOnsets(audio, 16000, raw);
console.log('thr', d.thr.toFixed(1), 'floor', d.floor.toFixed(1), 'top', d.top.toFixed(1));
console.log('onsets ', d.onsets.map((t) => t.toFixed(2)).join(' '));
console.log('offsets', d.offsets.map((t) => t.toFixed(2)).join(' '));
console.log('anchors', d.anchors.join(' '));
console.log('lag', d.lag, 'score', d.score);
const out = alignToOnsets(raw, audio, 16000);
for (let i = 0; i < out.length; i++) console.log(out[i].start.toFixed(2), out[i].end.toFixed(2), out[i].text.padEnd(10), `(raw ${raw[i].start.toFixed(2)})`);
const expect = { And: 0.33, ask: 3.29, not: 4.01, what: 5.42 };
for (const [k, v] of Object.entries(expect)) {
  const w = out.find((x) => x.text === k);
  console.log(`${Math.abs(w.start - v) <= 0.08 ? 'PASS' : 'FAIL'} ${k}: ${w.start.toFixed(2)} vs ${v}`);
}
const dump = (a, b) => { let line = `env ${a}-${b}s (dB/50ms): `; for (let t = a; t < b; t += 0.05) { let m = -99; for (let k = 0; k < 5; k++) m = Math.max(m, d.env[Math.round(t * 100) + k] ?? -99); line += Math.round(m) + ' '; } console.log(line); };
dump(1.9, 2.8); dump(4.2, 5.6);
