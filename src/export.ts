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

const VIDEO_CODECS = ['avc1.64002A', 'avc1.4D402A', 'avc1.42E02A', 'avc1.42001F'];

async function pickVideoCodec(width: number, height: number, fps: number): Promise<string> {
  for (const codec of VIDEO_CODECS) {
    const { supported } = await VideoEncoder.isConfigSupported({ codec, width, height, framerate: fps, bitrate: 8_000_000 });
    if (supported) return codec;
  }
  throw new Error('No supported H.264 encoder configuration found');
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

export async function exportMp4(opts: ExportOptions): Promise<Blob> {
  const { file, drawOverlay, onProgress } = opts;
  const fps = opts.fps ?? 30;
  const maxHeight = opts.maxHeight ?? 1920;
  const report = (f: number, s: string) => onProgress?.(Math.min(1, Math.max(0, f)), s);

  report(0, 'Loading video');
  const video = await loadVideo(file);
  const duration = await resolveDuration(video);
  const scale = Math.min(1, maxHeight / video.videoHeight);
  const width = evenDim(video.videoWidth * scale);
  const height = evenDim(video.videoHeight * scale);

  // --- audio: decode with WebAudio, re-encode as AAC ---
  report(0.02, 'Decoding audio');
  const audioCtx = new AudioContext();
  let audioBuffer: AudioBuffer | null = null;
  try {
    audioBuffer = await audioCtx.decodeAudioData(await file.arrayBuffer());
  } catch {
    audioBuffer = null; // silent video
  }
  await audioCtx.close();

  const hasAudio = !!audioBuffer && audioBuffer.length > 0;
  const sampleRate = hasAudio ? audioBuffer!.sampleRate : 48000;
  const channels = hasAudio ? Math.min(2, audioBuffer!.numberOfChannels) : 1;

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width, height, frameRate: fps },
    audio: hasAudio ? { codec: 'aac', sampleRate, numberOfChannels: channels } : undefined,
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
    audioEncoder.configure({ codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, bitrate: 128_000 });

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

  // --- video: seek frame by frame, composite, encode ---
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const totalFrames = Math.max(1, Math.round(duration * fps));
  const frameUs = Math.round(1_000_000 / fps);

  for (let i = 0; i < totalFrames; i++) {
    if (encodeError) throw encodeError;
    const t = i / fps;
    await seekTo(video, Math.min(t, Math.max(0, duration - 1e-3)));
    ctx.drawImage(video, 0, 0, width, height);
    drawOverlay(ctx, t, width, height);

    const frame = new VideoFrame(canvas, { timestamp: i * frameUs, duration: frameUs });
    videoEncoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();

    while (videoEncoder.encodeQueueSize > 8) {
      await new Promise((r) => setTimeout(r, 4));
    }
    if (i % 5 === 0) report(0.05 + 0.9 * (i / totalFrames), `Rendering frame ${i + 1}/${totalFrames}`);
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

  report(1, 'Done');
  return new Blob([target.buffer], { type: 'video/mp4' });
}
