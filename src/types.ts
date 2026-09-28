// Shared contracts between transcription, caption rendering, editor and export.

/** One spoken word with absolute timing in seconds. */
export interface Word {
  text: string;
  start: number;
  end: number;
}

export interface Transcript {
  words: Word[];
  /** ISO 639-1 code detected or chosen, e.g. "en", "de". */
  language?: string;
}

/** A group of words shown together on screen (one caption "page"). */
export interface CaptionLine {
  words: Word[];
  start: number;
  end: number;
}

export type StyleId = 'pop' | 'karaoke' | 'boxed' | 'clean' | 'outline';

export interface CaptionSettings {
  style: StyleId;
  fontFamily: string;
  /** Font size as a fraction of video height, e.g. 0.055. */
  fontSize: number;
  /** Vertical anchor of the caption block, 0 = top, 1 = bottom. */
  position: number;
  textColor: string;
  highlightColor: string;
  strokeColor: string;
  backgroundColor: string;
  maxWordsPerLine: number;
  uppercase: boolean;
}

export const DEFAULT_SETTINGS: CaptionSettings = {
  style: 'pop',
  fontFamily: 'Inter',
  fontSize: 0.055,
  position: 0.72,
  textColor: '#ffffff',
  highlightColor: '#ffe600',
  strokeColor: '#000000',
  backgroundColor: 'rgba(0,0,0,0.65)',
  maxWordsPerLine: 4,
  uppercase: true,
};

/** Draws the caption(s) active at `timeSec` onto a canvas of size w×h. Pure: no state between calls. */
export type CaptionRenderer = (
  ctx: CanvasRenderingContext2D,
  timeSec: number,
  w: number,
  h: number,
  lines: CaptionLine[],
  settings: CaptionSettings,
) => void;

export interface TranscribeOptions {
  /** Force a language; undefined = auto-detect. */
  language?: string;
  onProgress?: (fraction: number, stage: string) => void;
  /** Hugging Face model id; default picked by the module. */
  model?: string;
}
