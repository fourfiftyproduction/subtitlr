// Where does export time go? Times 60 frame seeks vs 60 encoder submissions, in a headed Chrome.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const URL = process.env.SPIKE_URL ?? 'http://localhost:5173/';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9342;
const chrome = spawn(CHROME, [
  '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${process.env.TEMP}/subtitlr-headed-profile`,
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--disable-extensions', '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });
let browser;
for (let i = 0; i < 40 && !browser; i++) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); } catch { await new Promise((r) => setTimeout(r, 500)); }
}
const page = await (browser.contexts()[0] ?? (await browser.newContext())).newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(URL);
const res = await page.evaluate(async () => {
  const out = {};
  const blob = await (await fetch('./demo.webm')).blob();
  const v = document.createElement('video'); v.muted = true; v.src = URL.createObjectURL(blob); v.preload = 'auto';
  await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
  const seek = (t) => new Promise((r) => { v.addEventListener('seeked', r, { once: true }); v.currentTime = t; });
  const N = 60;
  let t0 = performance.now();
  for (let i = 0; i < N; i++) await seek(1 + i / 30);
  out.seekMsPerFrame = (performance.now() - t0) / N;

  const w = 1080, h = 1920, c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { alpha: false });
  t0 = performance.now();
  for (let i = 0; i < N; i++) ctx.drawImage(v, 0, 0, w, h);
  out.drawMsPerFrame = (performance.now() - t0) / N;

  for (const [label, cfg] of [
    ['quality', { latencyMode: 'quality' }],
    ['realtime', { latencyMode: 'realtime' }],
    ['quality-hw', { latencyMode: 'quality', hardwareAcceleration: 'prefer-hardware' }],
    ['quality-sw', { latencyMode: 'quality', hardwareAcceleration: 'prefer-software' }],
  ]) {
    const config = { codec: 'avc1.64002A', width: w, height: h, framerate: 30, bitrate: 7_500_000, avc: { format: 'avc' }, ...cfg };
    const sup = await VideoEncoder.isConfigSupported(config);
    if (!sup.supported) { out['enc_' + label] = 'unsupported'; continue; }
    let n = 0;
    const enc = new VideoEncoder({ output: () => n++, error: (e) => { out['encErr_' + label] = String(e); } });
    enc.configure(config);
    t0 = performance.now();
    for (let i = 0; i < N; i++) {
      const f = new VideoFrame(c, { timestamp: i * 33333, duration: 33333 });
      enc.encode(f, { keyFrame: i === 0 }); f.close();
      while (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 2));
    }
    await enc.flush(); enc.close();
    out['enc_' + label] = { msPerFrame: (performance.now() - t0) / N, chunks: n };
  }
  out.rvfc = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  return out;
});
console.log(JSON.stringify(res, null, 2));
await browser.close(); chrome.kill(); process.exit(0);
