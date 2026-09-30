// Aligns Whisper word timestamps to speech onsets measured from the audio envelope. Pure, no DOM.
//
// Whisper's cross-attention (DTW) timestamps run consistently late — ≈0.3–0.5 s in our measurements, the same
// for whisper-base and whisper-small, WebGPU and wasm. Words that follow a pause are snapped to the measured
// speech onset; the systematic lag found that way is subtracted from every other word.
import type { Word } from './types';

const HOP_MS = 10;
const MIN_GAP_MS = 120;     // quiet must last this long to count as a pause between words
const MIN_LOUD_MS = 50;     // shorter loud blips inside a pause are clicks / breaths
const LAG_CAP = 0.7;        // s; a larger shift is a wrong onset, not a systematic lag
const SNAP_BACK = 0.6;      // s; a word may start up to this long after the onset it is snapped to
const SNAP_FWD = 0.15;      // s; … or this long before it (Whisper is rarely early)

/** RMS level in dB per 10 ms frame. */
function envelopeDb(audio: Float32Array, sr: number): Float32Array {
  const hop = Math.round((sr * HOP_MS) / 1000);
  const n = Math.floor(audio.length / hop);
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * hop; j < (i + 1) * hop; j++) s += audio[j] * audio[j];
    env[i] = 10 * Math.log10(s / hop + 1e-10);
  }
  return env;
}

function percentile(a: Float32Array, p: number): number {
  const s = Float32Array.from(a).sort();
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

interface Analysis { floor: number; top: number; thr: number; onsets: number[]; offsets: number[]; env: Float32Array }

/** Speech onsets/offsets (s) from the envelope: loud runs after ≥ MIN_GAP_MS of quiet, blips removed. */
function analyze(audio: Float32Array, sr: number): Analysis | null {
  const env = envelopeDb(audio, sr);
  const floor = percentile(env, 0.1), top = percentile(env, 0.9);
  if (top - floor < 12) return null; // no dynamics to work with (music bed, constant noise)
  const thr = floor + 0.25 * (top - floor);
  const loud = Array.from(env, (v) => v > thr);
  const dropShortRuns = (val: boolean, maxLen: number) => {
    for (let i = 0; i < loud.length;) {
      if (loud[i] !== val) { i++; continue; }
      let j = i; while (j < loud.length && loud[j] === val) j++;
      if (j - i < maxLen) loud.fill(!val, i, j);
      i = j;
    }
  };
  dropShortRuns(true, MIN_LOUD_MS / HOP_MS);
  dropShortRuns(false, MIN_GAP_MS / HOP_MS);
  const onsets: number[] = [], offsets: number[] = [];
  for (let i = 0; i < loud.length; i++) {
    if (loud[i] && (i === 0 || !loud[i - 1])) onsets.push((i * HOP_MS) / 1000);
    if (!loud[i] && i > 0 && loud[i - 1]) offsets.push((i * HOP_MS) / 1000);
  }
  return { floor, top, thr, onsets, offsets, env };
}

/** Each onset claims the first word that starts within [onset − SNAP_FWD, onset + SNAP_BACK]; closer onset wins. */
function findAnchors(words: Word[], onsets: number[]): Map<number, number> {
  const anchor = new Map<number, number>();
  for (const o of onsets) {
    const i = words.findIndex((w) => w.start >= o - SNAP_FWD && w.start <= o + SNAP_BACK);
    if (i < 0) continue;
    const prev = anchor.get(i);
    if (prev === undefined || Math.abs(words[i].start - o) < Math.abs(words[i].start - prev)) anchor.set(i, o);
  }
  return anchor;
}

/** Median lag of the anchored words = the systematic error applied to the rest. */
function estimateLag(words: Word[], anchor: Map<number, number>): number {
  const lags = [...anchor].map(([i, t]) => words[i].start - t).sort((a, b) => a - b);
  if (!lags.length) return 0;
  return Math.max(0, Math.min(LAG_CAP, lags[Math.floor(lags.length / 2)]));
}

export function alignToOnsets(words: Word[], audio: Float32Array, sr: number): Word[] {
  if (words.length < 2 || audio.length < sr) return words;
  const a = analyze(audio, sr);
  if (!a || !a.onsets.length) return words;
  const anchor = findAnchors(words, a.onsets);
  if (anchor.size < 2) return words; // not enough pauses to measure anything; leave Whisper's timing alone
  const lag = estimateLag(words, anchor);

  // Shift everything, snap anchors, pull the previous word's end back to the speech offset before the pause.
  const out = words.map((w) => ({ ...w, start: Math.max(0, w.start - lag), end: Math.max(0, w.end - lag) }));
  for (const [i, t] of anchor) {
    out[i].start = t;
    if (i > 0) {
      const off = a.offsets.filter((o) => o > out[i - 1].start && o <= t).pop();
      out[i - 1].end = Math.min(out[i - 1].end, off ?? t);
    }
  }
  let prevStart = 0;
  for (let i = 0; i < out.length; i++) {
    const w = out[i];
    w.start = Math.max(w.start, prevStart);
    w.end = Math.max(w.end, w.start + 0.05);
    if (i + 1 < out.length && out[i + 1].start > w.start && w.end > out[i + 1].start) w.end = out[i + 1].start;
    prevStart = w.start; // words may touch, never run backwards
  }
  return out;
}

/** For scripts/align-test.mjs. */
export function debugOnsets(audio: Float32Array, sr: number, words: Word[] = []) {
  const a = analyze(audio, sr) ?? { floor: NaN, top: NaN, thr: NaN, onsets: [], offsets: [], env: new Float32Array() };
  const anchor = findAnchors(words, a.onsets);
  return { ...a, anchors: [...anchor].map(([i, t]) => `${words[i].text}@${t.toFixed(2)}`), lag: estimateLag(words, anchor), score: anchor.size };
}
