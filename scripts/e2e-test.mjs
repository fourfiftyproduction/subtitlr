// End-to-end: open the real app headless, load the demo clip, wait for transcription, export, save frames.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const URL = process.env.SPIKE_URL ?? 'http://localhost:5173/';
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9337;

const chrome = spawn(CHROME, [
  '--headless', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}/subtitlr-e2e-profile`, // persistent: caches the Whisper model
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--disable-extensions',
  '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });

let browser;
for (let i = 0; i < 40 && !browser; i++) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); }
  catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (!browser) { chrome.kill(); throw new Error('Could not attach to Chrome'); }
const page = await (browser.contexts()[0] ?? (await browser.newContext())).newPage();
await page.setViewportSize({ width: 1280, height: 900 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
mkdirSync('tmp', { recursive: true });

const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(0)}s]`;
const status = () => page.textContent('#status-text').catch(() => '');

await page.goto(URL);
await page.screenshot({ path: 'tmp/e2e-1-landing.png' });
await page.click('#demo');
await page.waitForSelector('#editor:not([hidden])', { timeout: 20_000 });
console.log(stamp(), 'editor visible');

// transcription
let last = '';
while (true) {
  const s = await status();
  if (s !== last) { console.log(stamp(), s); last = s; }
  if (!(await page.$eval('#export', (b) => b.disabled))) break;
  if (Date.now() - t0 > 600_000) throw new Error('transcription timeout');
  await new Promise((r) => setTimeout(r, 2000));
}
const words = await page.evaluate(() => window.subtitlr.state.words);
console.log(stamp(), `${words.length} words:`, words.map((w) => w.text).join(' '));
if (words.length < 10) throw new Error('too few words');
await page.evaluate(() => { const v = document.querySelector('#video'); v.currentTime = 4.2; });
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: 'tmp/e2e-2-editor.png' });

// export
await page.click('#export');
last = '';
while (true) {
  const s = await status();
  if (s !== last && !/^Rendering/.test(s)) { console.log(stamp(), s); last = s; }
  if (/^(Done|Export failed)/.test(s)) break;
  if (Date.now() - t0 > 900_000) throw new Error('export timeout');
  await new Promise((r) => setTimeout(r, 2000));
}
if (/failed/.test(last)) throw new Error(last);

// grab a frame from the exported MP4 by playing it
const frame = await page.evaluate(async () => {
  const url = document.querySelector('#download').href;
  const v = document.createElement('video');
  v.muted = true; v.src = url; document.body.append(v);
  await new Promise((res) => v.addEventListener('loadedmetadata', res, { once: true }));
  v.currentTime = 4.0;
  await v.play();
  await new Promise((res) => v.requestVideoFrameCallback(() => setTimeout(res, 250)));
  await new Promise((res) => v.requestVideoFrameCallback(res));
  v.pause();
  const c = document.createElement('canvas');
  c.width = v.videoWidth / 3; c.height = v.videoHeight / 3;
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  return { t: v.currentTime, dur: v.duration, w: v.videoWidth, h: v.videoHeight, png: c.toDataURL('image/png').split(',')[1] };
});
writeFileSync('tmp/e2e-3-export-frame.png', Buffer.from(frame.png, 'base64'));
console.log(stamp(), `export ok: ${frame.w}x${frame.h}, ${frame.dur.toFixed(2)}s, frame @${frame.t.toFixed(2)}s -> tmp/e2e-3-export-frame.png`);

await browser.close();
chrome.kill();
process.exit(0);
