// MP4 export: source video → canvas (video + caption overlay) → WebCodecs → mp4-muxer.
// Everything runs in the browser; nothing is uploaded.
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

export type DrawOverlay = (ctx: CanvasRenderingContext2D, timeSec: number, w: number, h: number) => void;

export interface ExportOptions {
  file: File | Blob;
  fps?: number;
  drawOverlay: DrawOverlay;
  onProgress?: (fraction: number, stage: string) => void;
  /** Cap output height (keeps aspect). Default 1920. */
  maxHeight?: number;
}

const VIDEO_CODECS = ['avc1.64002A', 'avc1.4D402A', 'avc1.42E02A', 'avc1.42001F', 'avc1.640033', 'avc1.4D4033'];

async function pickVideoCodec(width: number, height: number, fps: number): Promise<string> {
  for (const codec of VIDEO_CODECS) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported({ codec, width, height, framerate: fps, bitrate: 8_000_000 });
      if (supported) return codec;
    } catch { /* invalid config for this browser, try the next */ }
  }
  throw new Error('No supported H.264 encoder configuration found');
}

export type AudioCodecId = 'aac' | 'opus';
const AUDIO_CODECS: { codec: string; id: AudioCodecId }[] = [
  { codec: 'mp4a.40.2', id: 'aac' },
  { codec: 'opus', id: 'opus' }, // Chrome on Linux has no AAC encoder; Opus-in-MP4 plays in Chrome, VLC, ffmpeg
];

async function pickAudioCodec(sampleRate: number, channels: number): Promise<{ codec: string; id: AudioCodecId } | null> {
  for (const c of AUDIO_CODECS) {
    try {
      const { supported } = await AudioEncoder.isConfigSupported({ codec: c.codec, sampleRate, numberOfChannels: channels, bitrate: 128_000 });
      if (supported) return c;
    } catch { /* try the next */ }
  }
  return null;
}

export interface ExportResult {
  blob: Blob;
  /** Which audio codec ended up in the file; 'none' when the source is silent or no encoder was available. */
  audio: AudioCodecId | 'none';
}

export function webCodecsAvailable(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

function loadVideo(file: Blob): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = URL.createObjectURL(file);
    // requestVideoFrameCallback only fires for videos the compositor presents, so keep it in the DOM (invisible).
    video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none';
    document.body.append(video);
    video.addEventListener('loadedmetadata', () => resolve(video), { once: true });
    video.addEventListener('error', () => reject(new Error('Could not load video')), { once: true });
  });
}

function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 1e-4) return resolve();
    video.addEventListener('seeked', () => resolve(), { once: true });
    video.currentTime = t;
  });
}

/** Some containers report Infinity duration until seeked to the end. */
async function resolveDuration(video: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  await new Promise<void>((resolve) => {
    video.addEventListener('durationchange', () => Number.isFinite(video.duration) && resolve(), { once: false });
    video.currentTime = 1e9;
  });
  video.currentTime = 0;
  return video.duration;
}

function evenDim(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

const AUDIO_RATE = 48000; // AAC and Opus encoders both accept 48 kHz; decodeAudioData resamples to it

export async function exportMp4(opts: ExportOptions): Promise<ExportResult> {
  const { file, drawOverlay, onProgress } = opts;
  const fps = opts.fps ?? 30;
  const maxHeight = opts.maxHeight ?? 1920;
  const report = (f: number, s: string) => onProgress?.(Math.min(1, Math.max(0, f)), s);

  report(0, 'Loading video');
  const video = await loadVideo(file);
  const duration = await resolveDuration(video);
  if (!video.videoWidth || !video.videoHeight) throw new Error('The file has no video track');
  const scale = Math.min(1, maxHeight / video.videoHeight);
  const width = evenDim(video.videoWidth * scale);
  const height = evenDim(video.videoHeight * scale);

  // --- audio: decode with WebAudio, re-encode as AAC (or Opus where the browser has no AAC encoder) ---
  report(0.02, 'Decoding audio');
  let audioBuffer: AudioBuffer | null = null;
  try {
    const audioCtx = new OfflineAudioContext(2, 1, AUDIO_RATE);
    audioBuffer = await audioCtx.decodeAudioData(await file.arrayBuffer());
  } catch {
    audioBuffer = null; // silent video
  }

  const sampleRate = AUDIO_RATE;
  const channels = audioBuffer ? Math.min(2, audioBuffer.numberOfChannels) : 1;
  const audioCodec = audioBuffer && audioBuffer.length > 0 ? await pickAudioCodec(sampleRate, channels) : null;
  if (audioBuffer && !audioCodec) console.warn('[export] no AAC/Opus encoder in this browser, exporting without audio');
  const hasAudio = !!audioCodec;

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width, height, frameRate: fps },
    audio: hasAudio ? { codec: audioCodec!.id, sampleRate, numberOfChannels: channels } : undefined,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  let encodeError: Error | null = null;

  const videoCodec = await pickVideoCodec(width, height, fps);
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encodeError = e; },
  });
  videoEncoder.configure({
    codec: videoCodec,
    width,
    height,
    framerate: fps,
    bitrate: Math.round(width * height * fps * 0.12), // ~7.5 Mbit/s at 1080x1920@30
    latencyMode: 'quality',
    avc: { format: 'avc' },
  });

  let audioEncoder: AudioEncoder | null = null;
  if (hasAudio) {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => { encodeError = e; },
    });
    audioEncoder.configure({ codec: audioCodec!.codec, sampleRate, numberOfChannels: channels, bitrate: 128_000 });

    // Feed audio in ~1s planar chunks.
    const buf = audioBuffer!;
    const chunkFrames = sampleRate;
    for (let offset = 0; offset < buf.length; offset += chunkFrames) {
      const frames = Math.min(chunkFrames, buf.length - offset);
      const data = new Float32Array(frames * channels);
      for (let c = 0; c < channels; c++) {
        buf.copyFromChannel(data.subarray(c * frames, (c + 1) * frames), c, offset);
      }
      const audioData = new AudioData({
        format: 'f32-planar',
        sampleRate,
        numberOfFrames: frames,
        numberOfChannels: channels,
        timestamp: Math.round((offset / sampleRate) * 1_000_000),
        data,
      });
      audioEncoder.encode(audioData);
      audioData.close();
    }
  }

  // --- video: composite each decoded frame, encode ---
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const frameUs = Math.round(1_000_000 / fps);
  const KEYFRAME_US = 2_000_000;
  let lastKeyUs = -Infinity;

  const encodeFrame = (t: number, tsUs: number) => {
    ctx.drawImage(video, 0, 0, width, height);
    drawOverlay(ctx, t, width, height);
    const frame = new VideoFrame(canvas, { timestamp: tsUs, duration: frameUs });
    const keyFrame = tsUs - lastKeyUs >= KEYFRAME_US;
    if (keyFrame) lastKeyUs = tsUs;
    videoEncoder.encode(frame, { keyFrame });
    frame.close();
  };
  const drained = async () => { while (videoEncoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 4)); };

  if ('requestVideoFrameCallback' in video) {
    // Fast path (~1× real time): play the video and grab every presented frame. Seeking costs ~300 ms/frame,
    // playback decodes at native speed. Encoder backpressure pauses playback so no frame is dropped.
    await new Promise<void>((resolve, reject) => {
      let lastT = -1;
      let pausedForDrain = false;
      let done = false;
      const onFrame: VideoFrameRequestCallback = (_now, meta) => {
        if (done) return;
        if (encodeError) return reject(encodeError);
        const t = meta.mediaTime;
        if (t > lastT) {
          lastT = t;
          encodeFrame(t, Math.round(t * 1_000_000));
          report(0.05 + 0.9 * (t / duration), `Rendering ${t.toFixed(1)} s / ${duration.toFixed(1)} s`);
          if (videoEncoder.encodeQueueSize > 8 && !pausedForDrain) {
            pausedForDrain = true;
            video.pause();
            drained().then(() => { pausedForDrain = false; return video.play(); }).catch(reject);
          }
        }
        if (!video.ended) video.requestVideoFrameCallback(onFrame);
      };
      // Let a callback for the final frame land before we stop accepting frames.
      video.addEventListener('ended', () => requestAnimationFrame(() => { done = true; resolve(); }), { once: true });
      video.addEventListener('error', () => reject(new Error('Playback failed during export')), { once: true });
      video.requestVideoFrameCallback(onFrame);
      video.currentTime = 0;
      video.play().catch(reject);
    });
  } else {
    // Fallback: seek frame by frame at a fixed rate.
    const totalFrames = Math.max(1, Math.round(duration * fps));
    for (let i = 0; i < totalFrames; i++) {
      if (encodeError) throw encodeError;
      const t = i / fps;
      await seekTo(video, Math.min(t, Math.max(0, duration - 1e-3)));
      encodeFrame(t, i * frameUs);
      await drained();
      if (i % 5 === 0) report(0.05 + 0.9 * (i / totalFrames), `Rendering frame ${i + 1}/${totalFrames}`);
    }
  }

  report(0.96, 'Finalizing');
  await videoEncoder.flush();
  videoEncoder.close();
  if (audioEncoder) {
    await audioEncoder.flush();
    audioEncoder.close();
  }
  if (encodeError) throw encodeError;
  muxer.finalize();
  URL.revokeObjectURL(video.src);
  video.remove();

  report(1, 'Done');
  return { blob: new Blob([target.buffer], { type: 'video/mp4' }), audio: audioCodec?.id ?? 'none' };
}
