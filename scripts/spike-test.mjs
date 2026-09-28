// Headless end-to-end check of the export pipeline against the running dev server.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

import { spawn } from 'node:child_process';

const URL = process.env.SPIKE_URL ?? 'http://localhost:5173/';
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;

// Playwright's own launcher exits immediately with this Chrome build; launch manually and attach over CDP.
const chrome = spawn(CHROME, [
  '--headless', '--no-sandbox', '--disable-gpu-sandbox',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}/subtitlr-spike-profile`,
  '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream',
  '--no-first-run', '--disable-extensions',
  'about:blank',
], { stdio: 'ignore' });

let browser;
for (let i = 0; i < 40 && !browser; i++) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); }
  catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (!browser) { chrome.kill(); throw new Error('Could not attach to Chrome'); }
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = await context.newPage();
process.on('exit', () => chrome.kill());
page.on('console', (m) => console.log('[page]', m.type(), m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(URL);
console.log('support:', await page.textContent('#support'));

await page.click('#gen');
await page.waitForFunction(() => document.querySelector('#status')?.textContent?.startsWith('Test clip ready'), null, { timeout: 30_000 });
console.log(await page.textContent('#status'));

const t0 = Date.now();
await page.click('#export');
const watchdog = setInterval(async () => {
  try { console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, await page.textContent('#status')); } catch {}
}, 3000);
process.on('exit', () => clearInterval(watchdog));
await page.waitForFunction(
  () => /^(Export done|Export FAILED)/.test(document.querySelector('#status')?.textContent ?? ''),
  null,
  { timeout: 180_000 },
);
const status = await page.textContent('#status');
console.log(status, `(${((Date.now() - t0) / 1000).toFixed(1)}s wall)`);

if (status.startsWith('Export done')) {
  const b64 = await page.evaluate(async () => {
    const v = document.querySelector('#out');
    const blob = await (await fetch(v.src)).blob();
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  });
  mkdirSync('tmp', { recursive: true });
  writeFileSync('tmp/spike-out.mp4', Buffer.from(b64, 'base64'));
  const meta = await page.evaluate(() => new Promise((res) => {
    const v = document.querySelector('#out');
    const done = () => res({ duration: v.duration, w: v.videoWidth, h: v.videoHeight });
    if (v.readyState >= 1) done(); else v.addEventListener('loadedmetadata', done, { once: true });
  }));
  console.log('output meta:', JSON.stringify(meta), '-> tmp/spike-out.mp4');

  // Composited SOURCE frame (what went into the encoder) near t=2.5s.
  const src = await page.evaluate(() => window.__debugFrame?.split(',')[1] ?? null);
  if (src) { writeFileSync('tmp/spike-src-frame.png', Buffer.from(src, 'base64')); console.log('src frame -> tmp/spike-src-frame.png'); }
  else console.log('src frame: NOT captured');

  // OUTPUT frame: play the result for real (seek+drawImage is unreliable headless), then grab.
  const png = await page.evaluate(async () => {
    const v = document.querySelector('#out');
    v.muted = true;
    v.currentTime = 2.3;
    await v.play();
    await new Promise((res) => v.requestVideoFrameCallback(() => setTimeout(res, 250)));
    await new Promise((res) => v.requestVideoFrameCallback(res));
    v.pause();
    const c = document.createElement('canvas');
    c.width = v.videoWidth / 4; c.height = v.videoHeight / 4;
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return { t: v.currentTime, png: c.toDataURL('image/png').split(',')[1] };
  });
  writeFileSync('tmp/spike-frame.png', Buffer.from(png.png, 'base64'));
  console.log(`output frame @${png.t.toFixed(2)}s -> tmp/spike-frame.png`);
}
await browser.close();
chrome.kill();
process.exit(0);
