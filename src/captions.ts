// Caption grouping + five pure canvas renderers. No DOM, no state between calls (except ensureFontsLoaded).
import type { CaptionLine, CaptionRenderer, CaptionSettings, StyleId, Word } from './types';

const PAUSE_BREAK = 0.6;   // s of silence that starts a new line
const HOLD = 0.8;          // s a line stays up into a pause (or until the next line starts) so it never just flashes
const MAX_WIDTH = 0.9;     // fraction of w a row may use
const POP_MS = 120;        // active-word ease duration

// ---------------------------------------------------------------- grouping

export function groupWords(words: Word[], settings: CaptionSettings): CaptionLine[] {
  const max = Math.max(1, Math.floor(settings.maxWordsPerLine || 1));
  const clean = words.filter((w) => w.text.trim().length > 0);
  const lines: CaptionLine[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length) lines.push({ words: cur, start: cur[0].start, end: Math.max(cur[0].start, cur[cur.length - 1].end) });
    cur = [];
  };
  for (const w of clean) {
    const last = cur[cur.length - 1];
    if (last && (cur.length >= max || w.start - last.end > PAUSE_BREAK || /[.!?…]["')\]]*$/.test(last.text))) flush();
    cur.push(w);
  }
  flush();
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1];
    lines[i].end = next ? Math.min(next.start, lines[i].end + HOLD) : lines[i].end + HOLD; // hold, never overlap
  }
  return lines;
}

// ---------------------------------------------------------------- fonts

const FONT_WEIGHTS: Record<string, number[]> = {
  Inter: [400, 600, 700, 800, 900],
  Montserrat: [400, 600, 700, 800, 900],
  Poppins: [400, 600, 700, 800, 900],
  'Bebas Neue': [400],
};
const loaded = new Set<string>();
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Loads Google Fonts for `families` and waits until the canvas can use them. Resolves anyway (fallback) offline. */
export async function ensureFontsLoaded(families: string[]): Promise<void> {
  if (typeof document === 'undefined') return;
  const todo = families.filter((f) => f && !loaded.has(f));
  if (!todo.length) return;
  const spec = todo.map((f) => {
    const ws = FONT_WEIGHTS[f] ?? [400, 700];
    return `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@${ws.join(';')}`;
  }).join('&');
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?${spec}&display=swap`;
  const linkDone = new Promise<void>((res) => {
    link.onload = () => res();
    link.onerror = () => res();
    setTimeout(res, 4000);
  });
  document.head.appendChild(link);
  await linkDone;
  const loads = todo.flatMap((f) => (FONT_WEIGHTS[f] ?? [400, 700]).map((wt) => document.fonts.load(`${wt} 32px "${f}"`).catch(() => [])));
  await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, 4000))]);
  todo.forEach((f) => loaded.add(f));
}

// ---------------------------------------------------------------- layout

interface Placed { word: Word; i: number; cx: number; cy: number; width: number; }
interface Layout {
  placed: Placed[];
  rows: { cx: number; cy: number; width: number; height: number }[];
  fontPx: number;
  rowH: number;
}

function weightFor(family: string, want: number): number {
  const ws = FONT_WEIGHTS[family];
  if (!ws) return want;
  return ws.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
}

function fontString(settings: CaptionSettings, weight: number, px: number): string {
  return `${weightFor(settings.fontFamily, weight)} ${px}px "${settings.fontFamily}", Inter, "Segoe UI", Roboto, sans-serif`;
}

function display(text: string, settings: CaptionSettings): string {
  const t = text.trim();
  return settings.uppercase ? t.toUpperCase() : t;
}

function applyText(ctx: Ctx2D, settings: CaptionSettings, weight: number, px: number): void {
  ctx.font = fontString(settings, weight, px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${(settings.uppercase ? 0.03 : 0) * px}px`;
}

/** Measures and places every word of `line`: 1 row, or 2 balanced rows if wider than MAX_WIDTH·w; shrinks if still too wide. */
function layout(ctx: CanvasRenderingContext2D, line: CaptionLine, settings: CaptionSettings, w: number, h: number, weight: number, gapFactor: number): Layout {
  let fontPx = Math.max(8, settings.fontSize * h);
  const measure = (px: number) => {
    applyText(ctx, settings, weight, px);
    return line.words.map((wd) => ctx.measureText(display(wd.text, settings)).width);
  };
  let widths = measure(fontPx);
  let gap = fontPx * gapFactor;
  const maxW = MAX_WIDTH * w;
  const rowWidth = (a: number, b: number) => widths.slice(a, b).reduce((s, x) => s + x, 0) + gap * Math.max(0, b - a - 1);

  let split = line.words.length; // index where row 2 starts
  if (rowWidth(0, split) > maxW && line.words.length > 1) {
    let best = Infinity;
    for (let k = 1; k < line.words.length; k++) {
      const m = Math.max(rowWidth(0, k), rowWidth(k, line.words.length));
      if (m < best) { best = m; split = k; }
    }
    if (best > maxW) { // shrink to fit
      const s = maxW / best;
      fontPx *= s; gap *= s;
      widths = measure(fontPx);
    }
  } else if (rowWidth(0, split) > maxW) {
    const s = maxW / rowWidth(0, split);
    fontPx *= s; gap *= s;
    widths = measure(fontPx);
  }

  const rowH = fontPx * 1.25;
  const rowsIdx = split < line.words.length ? [[0, split], [split, line.words.length]] : [[0, line.words.length]];
  const top = settings.position * h - (rowsIdx.length * rowH) / 2;
  const placed: Placed[] = [];
  const rows: Layout['rows'] = [];
  rowsIdx.forEach(([a, b], r) => {
    const width = rowWidth(a, b);
    const cy = top + rowH * (r + 0.5);
    let x = w / 2 - width / 2;
    for (let i = a; i < b; i++) {
      placed.push({ word: line.words[i], i, cx: x + widths[i] / 2, cy, width: widths[i] });
      x += widths[i] + gap;
    }
    rows.push({ cx: w / 2, cy, width, height: rowH });
  });
  return { placed, rows, fontPx, rowH };
}

function activeLine(lines: CaptionLine[], t: number): CaptionLine | undefined {
  return lines.find((l) => t >= l.start && t < l.end);
}

/** Index of the word being spoken at t (last word that has started), -1 before the first word. */
function activeIndex(line: CaptionLine, t: number): number {
  let idx = -1;
  for (let i = 0; i < line.words.length; i++) if (line.words[i].start <= t) idx = i;
  return idx;
}

function easeOut(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return 1 - Math.pow(1 - c, 3);
}

function popScale(word: Word, t: number, amount: number): number {
  return 1 + amount * easeOut(((t - word.start) * 1000) / POP_MS);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function strokeSetup(ctx: Ctx2D, color: string, width: number): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
}

function noShadow(ctx: CanvasRenderingContext2D): void {
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

function shadow(ctx: CanvasRenderingContext2D, px: number, alpha = 0.6): void {
  ctx.shadowColor = `rgba(0,0,0,${alpha})`;
  ctx.shadowBlur = px * 0.18;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = px * 0.05;
}

/** Wraps a renderer body: finds the active line, lays it out, and isolates canvas state. */
function withLine(weight: number, gapFactor: number, body: (ctx: CanvasRenderingContext2D, L: Layout, active: number, t: number, s: CaptionSettings, w: number, h: number) => void): CaptionRenderer {
  return (ctx, t, w, h, lines, settings) => {
    const line = activeLine(lines, t);
    if (!line) return;
    ctx.save();
    try {
      const L = layout(ctx, line, settings, w, h, weight, gapFactor);
      body(ctx, L, activeIndex(line, t), t, settings, w, h);
    } finally {
      ctx.restore();
    }
  };
}

/** Runs `draw` in a coordinate system centred on the word and scaled by `scale`. */
function drawWordScaled(ctx: CanvasRenderingContext2D, p: Placed, scale: number, draw: () => void): void {
  ctx.save();
  ctx.translate(p.cx, p.cy);
  if (scale !== 1) ctx.scale(scale, scale);
  draw();
  ctx.restore();
}

// ---------------------------------------------------------------- renderers

/** TikTok / Hormozi: heavy uppercase, thick dark stroke, active word pops up in highlightColor. */
const pop: CaptionRenderer = withLine(900, 0.38, (ctx, L, active, t, s) => {
  const { fontPx } = L;
  const sw = fontPx * 0.12;
  // pass 1: strokes (with shadow) so no fill is covered by a neighbour's stroke
  shadow(ctx, fontPx, 0.55);
  strokeSetup(ctx, s.strokeColor, sw);
  for (const p of L.placed) {
    const text = display(p.word.text, s);
    const sc = p.i === active ? popScale(p.word, t, 0.15) : 1;
    drawWordScaled(ctx, p, sc, () => ctx.strokeText(text, 0, 0));
  }
  // pass 2: fills
  noShadow(ctx);
  for (const p of L.placed) {
    const text = display(p.word.text, s);
    const isActive = p.i === active;
    const sc = isActive ? popScale(p.word, t, 0.15) : 1;
    ctx.fillStyle = isActive ? s.highlightColor : s.textColor;
    drawWordScaled(ctx, p, sc, () => ctx.fillText(text, 0, 0));
  }
});

/** Whole line in textColor; spoken words fill with highlightColor, the current one sweeps left→right. */
const karaoke: CaptionRenderer = withLine(800, 0.3, (ctx, L, active, t, s) => {
  const { fontPx } = L;
  shadow(ctx, fontPx, 0.5);
  strokeSetup(ctx, s.strokeColor, fontPx * 0.09);
  for (const p of L.placed) ctx.strokeText(display(p.word.text, s), p.cx, p.cy);
  noShadow(ctx);
  ctx.fillStyle = s.textColor;
  for (const p of L.placed) ctx.fillText(display(p.word.text, s), p.cx, p.cy);
  ctx.fillStyle = s.highlightColor;
  for (const p of L.placed) {
    if (p.i > active) break;
    const text = display(p.word.text, s);
    if (p.i < active) { ctx.fillText(text, p.cx, p.cy); continue; }
    const dur = Math.max(0.05, p.word.end - p.word.start);
    const frac = Math.min(1, Math.max(0, (t - p.word.start) / dur));
    const pad = fontPx * 0.15;
    ctx.save();
    ctx.beginPath();
    ctx.rect(p.cx - p.width / 2 - pad, p.cy - fontPx, (p.width + pad * 2) * frac, fontPx * 2);
    ctx.clip();
    ctx.fillText(text, p.cx, p.cy);
    ctx.restore();
  }
});

/** Active word sits on a rounded highlightColor pill; other words white with a soft shadow. */
const boxed: CaptionRenderer = withLine(800, 0.48, (ctx, L, active, t, s) => {
  const { fontPx } = L;
  const padX = fontPx * 0.28, padY = fontPx * 0.12;
  const act = L.placed.find((p) => p.i === active);
  if (act) {
    const sc = popScale(act.word, t, 0.08);
    const bw = (act.width + padX * 2) * sc, bh = (fontPx * 1.1 + padY * 2) * sc;
    shadow(ctx, fontPx, 0.35);
    ctx.fillStyle = s.highlightColor;
    roundRect(ctx, act.cx - bw / 2, act.cy - bh / 2, bw, bh, fontPx * 0.22 * sc);
    ctx.fill();
  }
  shadow(ctx, fontPx, 0.7);
  ctx.fillStyle = s.textColor;
  for (const p of L.placed) {
    if (p.i === active) continue;
    ctx.fillText(display(p.word.text, s), p.cx, p.cy);
  }
  if (act) {
    noShadow(ctx);
    ctx.fillStyle = s.strokeColor;
    const sc = popScale(act.word, t, 0.08);
    const text = display(act.word.text, s);
    drawWordScaled(ctx, act, sc, () => ctx.fillText(text, 0, 0));
  }
});

/** Minimal: no stroke, translucent rounded plate behind the whole line, active word brighter and bolder. */
const clean: CaptionRenderer = withLine(600, 0.3, (ctx, L, active, _t, s) => {
  const { fontPx } = L;
  const padX = fontPx * 0.6, padY = fontPx * 0.25;
  const width = Math.max(...L.rows.map((r) => r.width)) + padX * 2;
  const top = L.rows[0].cy - L.rowH / 2 - padY;
  const height = L.rowH * L.rows.length + padY * 2;
  noShadow(ctx);
  ctx.fillStyle = s.backgroundColor;
  roundRect(ctx, L.rows[0].cx - width / 2, top, width, height, fontPx * 0.35);
  ctx.fill();
  for (const p of L.placed) {
    const text = display(p.word.text, s);
    if (p.i === active) {
      applyText(ctx, s, 700, fontPx);
      ctx.fillStyle = s.textColor;
    } else {
      applyText(ctx, s, 600, fontPx);
      ctx.fillStyle = s.textColor;
      ctx.globalAlpha = 0.72;
    }
    ctx.fillText(text, p.cx, p.cy);
    ctx.globalAlpha = 1;
  }
});

// Scratch layer for hollow text. Variable fonts (Inter, Montserrat) have overlapping contours, so a plain
// strokeText shows inner lines; instead stroke thick, then punch the glyph body out with destination-out.
let scratch: OffscreenCanvas | null = null;
function hollowLayer(w: number, h: number): OffscreenCanvasRenderingContext2D {
  if (!scratch || scratch.width !== w || scratch.height !== h) scratch = new OffscreenCanvas(w, h);
  const c = scratch.getContext('2d')!;
  c.reset();
  return c;
}

/** Hollow outlined words; the spoken one is solid highlightColor. */
const outline: CaptionRenderer = withLine(900, 0.34, (ctx, L, active, t, s, w, h) => {
  const { fontPx } = L;
  const sw = fontPx * 0.045;
  const layer = hollowLayer(w, h);
  applyText(layer, s, 900, fontPx);
  strokeSetup(layer, s.textColor, sw * 2);
  for (const p of L.placed) if (p.i !== active) layer.strokeText(display(p.word.text, s), p.cx, p.cy);
  layer.globalCompositeOperation = 'destination-out';
  layer.fillStyle = '#000';
  for (const p of L.placed) if (p.i !== active) layer.fillText(display(p.word.text, s), p.cx, p.cy);
  shadow(ctx, fontPx, 0.6);
  ctx.drawImage(scratch!, 0, 0);
  const act = L.placed.find((p) => p.i === active);
  if (act) {
    const text = display(act.word.text, s);
    const sc = popScale(act.word, t, 0.1);
    strokeSetup(ctx, s.strokeColor, fontPx * 0.1);
    drawWordScaled(ctx, act, sc, () => ctx.strokeText(text, 0, 0));
    noShadow(ctx);
    ctx.fillStyle = s.highlightColor;
    drawWordScaled(ctx, act, sc, () => ctx.fillText(text, 0, 0));
  }
});

export const renderers: Record<StyleId, CaptionRenderer> = { pop, karaoke, boxed, clean, outline };

// ---------------------------------------------------------------- auto colour

let probe: OffscreenCanvas | null = null;
const PROBE_W = 24, PROBE_H = 6;

/** Average colour of the band the captions sit on, sampled from `src` (a video or a canvas already holding the frame). */
export function bandColor(src: CanvasImageSource, srcW: number, srcH: number, settings: CaptionSettings): [number, number, number] | null {
  try {
    probe ??= new OffscreenCanvas(PROBE_W, PROBE_H);
    const c = probe.getContext('2d', { willReadFrequently: true })!;
    const bandH = Math.max(1, settings.fontSize * srcH * 3);
    const y = Math.max(0, Math.min(srcH - bandH, settings.position * srcH - bandH / 2));
    c.drawImage(src, 0, y, srcW, bandH, 0, 0, PROBE_W, PROBE_H);
    const d = c.getImageData(0, 0, PROBE_W, PROBE_H).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4;
    return [r / n, g / n, b / n];
  } catch {
    return null; // tainted canvas, no frame yet, …
  }
}

const luma = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const hex = ([r, g, b]: [number, number, number]) => '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

/** Negative of the band colour, pushed towards white/black when the negative would sit too close to the band's brightness. */
export function negativeTextColor(band: [number, number, number]): string {
  const neg: [number, number, number] = [255 - band[0], 255 - band[1], 255 - band[2]];
  const lb = luma(band), ln = luma(neg);
  if (Math.abs(lb - ln) >= 70) return hex(neg);
  // Mid-tone scene: keep the hue but take it to a clearly lighter or darker tint.
  const target = lb > 128 ? 30 : 235;
  const k = ln === 0 ? 1 : target / ln;
  return hex([neg[0] * k, neg[1] * k, neg[2] * k]);
}

/** Settings for this frame: with autoColor, the text colour is the negative of the video behind the captions. */
export function frameSettings(src: CanvasImageSource, srcW: number, srcH: number, settings: CaptionSettings): CaptionSettings {
  if (!settings.autoColor) return settings;
  const band = bandColor(src, srcW, srcH, settings);
  if (!band) return settings;
  const textColor = negativeTextColor(band);
  // Outline flips too so it keeps contrasting with the text.
  const strokeColor = luma(band) > 128 ? '#ffffff' : '#000000';
  return { ...settings, textColor, strokeColor };
}

/** Dispatches to `renderers[settings.style]`. */
export function drawCaptions(
  ctx: CanvasRenderingContext2D, timeSec: number, w: number, h: number, lines: CaptionLine[], settings: CaptionSettings,
): void {
  (renderers[settings.style] ?? pop)(ctx, timeSec, w, h, lines, settings);
}
