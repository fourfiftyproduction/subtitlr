// Subtitle file export (SRT / WebVTT) from caption lines, plus plain-text transcript.
import type { CaptionLine, Word } from './types';

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

function stamp(sec: number, msSep: ',' | '.'): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000), s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${msSep}${pad(ms % 1000, 3)}`;
}

function lineText(line: CaptionLine): string {
  return line.words.map((w) => w.text.trim()).filter(Boolean).join(' ');
}

/** offset: seconds added to every cue (same shift the on-screen captions use). */
export function toSrt(lines: CaptionLine[], offset = 0): string {
  return lines
    .map((l, i) => `${i + 1}\n${stamp(l.start + offset, ',')} --> ${stamp(l.end + offset, ',')}\n${lineText(l)}\n`)
    .join('\n');
}

export function toVtt(lines: CaptionLine[], offset = 0): string {
  return 'WEBVTT\n\n' + lines
    .map((l) => `${stamp(l.start + offset, '.')} --> ${stamp(l.end + offset, '.')}\n${lineText(l)}\n`)
    .join('\n');
}

/** Plain transcript: sentence-ish breaks after terminal punctuation. */
export function toText(words: Word[]): string {
  const parts = words.map((w) => w.text.trim()).filter(Boolean);
  return parts.join(' ').replace(/([.!?…]["')\]]*)\s+/g, '$1\n');
}

export function downloadText(name: string, content: string, type = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
