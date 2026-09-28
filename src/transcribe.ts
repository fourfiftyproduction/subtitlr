// Speech-to-text with word timestamps, fully in-browser: Whisper via transformers.js on WebGPU, wasm fallback.
// Nothing is uploaded; the model (~100–200 MB) is fetched once and cached by the browser.
import { pipeline, Tensor, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import type { Transcript, TranscribeOptions, Word } from './types';

// Word timestamps need an export with cross-attention outputs; plain whisper-base lacks them.
export const DEFAULT_MODEL = 'onnx-community/whisper-base_timestamped';
const SAMPLE_RATE = 16000;

type Backend = 'webgpu' | 'wasm' | 'unknown';
type Device = Exclude<Backend, 'unknown'>;
type Progress = (fraction: number, stage: string) => void;

// Known-good combos for whisper-*: q4 decoder on WebGPU (fp32 encoder avoids fp16 bugs on some GPUs), q8 on wasm.
const DTYPES = {
  webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
  wasm: 'q8',
} as const;

let backend: Backend = 'unknown';
let webgpuOk: boolean | null = null; // decided once per page
const pipelines = new Map<string, Promise<AutomaticSpeechRecognitionPipeline>>();

export function transcriptionBackend(): Backend {
  return backend;
}

async function webgpuUsable(): Promise<boolean> {
  try {
    const adapter = await (navigator as any).gpu?.requestAdapter();
    return !!adapter && !adapter.isFallbackAdapter && !adapter.info?.isFallbackAdapter;
  } catch {
    return false;
  }
}

function loadPipeline(model: string, device: Device, onProgress?: Progress) {
  const key = `${model}@${device}`;
  let p = pipelines.get(key);
  if (!p) {
    p = pipeline('automatic-speech-recognition', model, {
      device,
      dtype: DTYPES[device],
      progress_callback: (info) => {
        if (info.status === 'progress_total') onProgress?.(info.progress / 100, `Loading model (${device})`);
      },
    });
    pipelines.set(key, p);
    p.catch(() => pipelines.delete(key));
  }
  return p;
}

async function getPipeline(model: string, onProgress?: Progress): Promise<AutomaticSpeechRecognitionPipeline> {
  webgpuOk ??= await webgpuUsable();
  if (webgpuOk) {
    try {
      const p = await loadPipeline(model, 'webgpu', onProgress);
      backend = 'webgpu';
      return p;
    } catch (e) {
      console.warn('[transcribe] WebGPU load failed, falling back to wasm', e);
      webgpuOk = false;
    }
  }
  const p = await loadPipeline(model, 'wasm', onProgress);
  backend = 'wasm';
  return p;
}

/** Optional warm-up so the model download happens before the user hits "transcribe". */
export async function preloadModel(opts: TranscribeOptions = {}): Promise<void> {
  await getPipeline(opts.model ?? DEFAULT_MODEL, opts.onProgress);
}

/** Video/audio Blob → 16 kHz mono samples. decodeAudioData resamples to the context rate. */
async function decodeAudio(file: Blob): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  const buf = await ctx.decodeAudioData(await file.arrayBuffer());
  const mono = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / buf.numberOfChannels;
  }
  return mono;
}

/** transformers.js 4.x has no built-in Whisper language detection: run one decoder step and pick the best language token. */
async function detectLanguage(asr: AutomaticSpeechRecognitionPipeline, audio: Float32Array): Promise<string | undefined> {
  const model = asr.model as any;
  const gc = model.generation_config;
  const langs = Object.entries<number>(gc?.lang_to_id ?? {});
  if (!langs.length) return undefined; // English-only model
  const { input_features } = await asr.processor(audio.subarray(0, 30 * SAMPLE_RATE));
  const decoder_input_ids = new Tensor('int64', [BigInt(gc.decoder_start_token_id)], [1, 1]);
  const { logits } = await model({ input_features, decoder_input_ids });
  const scores = logits.data as ArrayLike<number>;
  let best = langs[0];
  for (const l of langs) if (scores[l[1]] > scores[best[1]]) best = l;
  return best[0].slice(2, -2); // "<|de|>" → "de"
}

/** Trim, drop empties, glue stray punctuation / apostrophe pieces ("J" + "'adore") to the previous word,
 *  make timings monotonic within [0, duration]. */
function cleanWords(chunks: { text: string; timestamp: [number | null, number | null] }[], duration: number): Word[] {
  const words: Word[] = [];
  for (const c of chunks) {
    const text = c.text.trim();
    if (!text) continue;
    const prev = words.at(-1);
    if (prev && (!/[\p{L}\p{N}]/u.test(text) || /^['’]/.test(text))) {
      prev.text += text;
      if (c.timestamp[1] != null) prev.end = Math.max(prev.end, c.timestamp[1]);
      continue;
    }
    words.push({ text, start: c.timestamp[0] ?? prev?.end ?? 0, end: c.timestamp[1] ?? NaN });
  }
  let t = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    w.start = Math.min(Math.max(w.start, t), duration);
    if (!Number.isFinite(w.end)) w.end = words[i + 1]?.start ?? w.start + 0.3;
    w.end = Math.max(Math.min(w.end, duration), w.start + 0.05);
    t = w.end;
  }
  return words;
}

export async function transcribe(file: Blob, opts: TranscribeOptions = {}): Promise<Transcript> {
  const report: Progress = (f, s) => opts.onProgress?.(Math.min(1, Math.max(0, f)), s);

  report(0, 'Loading model');
  const asr = await getPipeline(opts.model ?? DEFAULT_MODEL, (f, s) => report(f * 0.5, s));

  report(0.5, 'Decoding audio');
  const audio = await decodeAudio(file);
  const duration = audio.length / SAMPLE_RATE;

  try {
    report(0.55, 'Detecting language');
    const language = opts.language ?? (await detectLanguage(asr, audio));

    report(0.6, 'Transcribing');
    // Whisper emits roughly 3 tokens per second of speech; good enough for a progress estimate.
    const expectedTokens = Math.max(20, duration * 3);
    let seen = 0;
    const streamer = {
      put: (tokens: bigint[][]) => { seen += tokens[0].length; report(0.6 + 0.38 * Math.min(1, seen / expectedTokens), 'Transcribing'); },
      end: () => {},
    };
    const out = await asr(audio, {
      return_timestamps: 'word',
      chunk_length_s: 30,
      stride_length_s: 5,
      ...(language ? { language } : {}),
      streamer,
    } as any);

    report(1, 'Done');
    return { words: cleanWords((out.chunks ?? []) as any, duration), language };
  } catch (e) {
    if (backend !== 'webgpu') throw e;
    console.warn('[transcribe] WebGPU inference failed, retrying on wasm', e);
    webgpuOk = false;
    return transcribe(file, opts);
  }
}
