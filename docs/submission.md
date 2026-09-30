# Build Games submission (draft)

Form: https://canivibecodeit.com/thebuildgames

- **Name / handle:** fourfifty
- **Demo URL:** https://fourfiftyproduction.github.io/subtitlr/
- **Repo:** https://github.com/fourfiftyproduction/subtitlr
- **Email:** fourfifty.production@gmail.com
- **Category:** Best Replacement
- **Description (≤ 200 chars):**

  > Animated captions for shorts, 100% in your browser: Whisper on WebGPU, word-accurate timing, 5 styles, inline editing, real MP4 export (H.264+AAC). Replaces Submagic/Captions ($16–39/mo). No upload.

  (196 chars)

- **Longer field, if there is one:**

  > Drop a vertical video. Whisper (transformers.js, WebGPU, WASM fallback) transcribes it on your device with word timestamps, which Subtitlr then aligns to the actual speech onsets in the audio so the highlight lands on the spoken word. Pick one of five caption styles, font, colours, position (drag in the preview), or let the text colour become the negative of the video frame by frame. Fix words inline, click a word to jump, nudge timing. Export a real MP4 (WebCodecs + mp4-muxer, H.264 + AAC, Opus fallback) with burned-in captions, or SRT/VTT. Static site, no backend, no account, no analytics, 0 € to run. Replaces the core job of Submagic / Captions.ai for $0.

## Pre-flight before submitting

- [x] Pages deploy green, demo URL loads in a fresh Chrome profile (2026-09-30, headless e2e against live URL)
- [x] "Try the demo clip" → transcript → export works on the live URL (12 s export, 7.4 MB)
- [x] `main` pushed, default branch main, Pages deploys via Actions workflow (2026-09-30)
- [x] Commits in window (first commit 2026-09-28), README explains build
- [x] No third-party names/logos used as our branding (only "alternative to …" comparisons)
