# Subtitlr

Animated captions for short videos — transcribed, styled and exported to MP4 **entirely in your browser**.
No upload, no server, no subscription. Your video never leaves your device.

Built in a few days for [The Build Games](https://canivibecodeit.com/thebuildgames) as a working replacement
for caption subscriptions like Submagic or Captions ($16–39/month).

**Live demo:** https://fourfiftyproduction.github.io/subtitlr/

## What it does

1. Drop a vertical video (MP4/MOV/WebM, up to a few minutes).
2. Whisper runs on your GPU via WebGPU (CPU fallback) and returns word-level timestamps.
3. Pick one of five caption styles (pop, karaoke, boxed, clean, outline), font, size, position, colors.
4. Fix any word inline; click a word to jump there.
5. Export a real MP4 (H.264 + AAC) with the captions burned in.

## How it works

| Step | Tech | Where it runs |
|---|---|---|
| Transcription | [transformers.js](https://github.com/huggingface/transformers.js) + Whisper (`onnx-community/whisper-base_timestamped`, word-level timestamps via cross-attention) | your browser, WebGPU or WASM |
| Rendering | Canvas 2D, pure functions per frame | your browser |
| Encoding | WebCodecs `VideoEncoder`/`AudioEncoder` + [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) | your browser |
| Hosting | static files on GitHub Pages | nothing runs server-side |

The whole product is a static site. There is no backend, no account, no analytics, no API key.

## Run locally

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # static output in dist/
```

Requires a browser with WebCodecs (Chrome or Edge on desktop). WebGPU makes transcription ~10× faster but is optional.

## Limitations

- Desktop Chrome/Edge only for export (Safari and Firefox lack the needed WebCodecs pieces).
- First run downloads the Whisper model (~100 MB), cached by the browser afterwards.
- Export renders frame by frame through the browser's decoder: a few times real time on a laptop, slower without hardware video decoding.
- Whisper `base` is small on purpose (fast on a laptop GPU). Fix the occasional misheard word inline before exporting.

## Testing

Headless checks run against the dev server (`npm run dev` first), driving a real Chrome over CDP:

```sh
node scripts/captions-test.mjs     # renders every style to tmp/*.png
node scripts/transcribe-test.mjs   # Whisper on a public-domain clip, asserts words + timings
node scripts/e2e-test.mjs          # full flow: demo clip → transcript → MP4 export
```

## License

MIT
