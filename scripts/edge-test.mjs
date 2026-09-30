// Edge cases against the dev server: a file the browser cannot play, and an export where AAC is unavailable
// (Chrome on Linux) so the Opus fallback must kick in. Runs headless Chrome over CDP like e2e-test.mjs.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const URL = process.env.SPIKE_URL ?? 'http://localhost:5173/';
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9339;
const chrome = spawn(CHROME, [
  '--headless', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}/subtitlr-e2e-profile`,
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--disable-extensions', '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });
let browser;
for (let i = 0; i < 40 && !browser; i++) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); } catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (!browser) { chrome.kill(); throw new Error('Could not attach to Chrome'); }
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const status = (page) => page.textContent('#status-text').catch(() => '');
const waitFor = async (page, re, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await status(page);
    if (re.test(s)) return s;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for ${re}, last status: "${await status(page)}"`);
};
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failed++; };

// 1. garbage file → clear message, no hang
{
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(URL);
  await page.evaluate(() => window.subtitlr.loadFile(new File([new Uint8Array(4096)], 'broken.mp4', { type: 'video/mp4' })));
  const s = await waitFor(page, /cannot play|no video track/i, 8000).catch((e) => e.message);
  check('unplayable file shows a message', /cannot play/i.test(s), s.slice(0, 80));
  await page.close();
}

// 2. AAC unavailable → Opus in MP4, export still succeeds and plays
{
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.addInitScript(() => {
    const orig = AudioEncoder.isConfigSupported.bind(AudioEncoder);
    AudioEncoder.isConfigSupported = (cfg) => (cfg.codec.startsWith('mp4a') ? Promise.resolve({ supported: false, config: cfg }) : orig(cfg));
  });
  await page.goto(URL);
  await page.click('#demo');
  await page.waitForSelector('#editor:not([hidden])', { timeout: 20_000 });
  while (await page.$eval('#export', (b) => b.disabled)) await new Promise((r) => setTimeout(r, 1000));
  await page.click('#export');
  const s = await waitFor(page, /^(Done|Export failed)/, 180_000);
  check('export with Opus fallback', /^Done/.test(s) && /Opus/.test(s), s);
  const meta = await page.evaluate(async () => {
    const v = document.createElement('video'); v.muted = true; v.src = document.querySelector('#download').href; document.body.append(v);
    await new Promise((res, rej) => { v.addEventListener('loadedmetadata', res, { once: true }); v.addEventListener('error', () => rej(new Error('cannot play export')), { once: true }); });
    return { duration: v.duration, audio: v.mozHasAudio ?? v.webkitAudioDecodedByteCount !== undefined };
  }).catch((e) => ({ error: e.message }));
  check('opus export loads in <video>', !meta.error && meta.duration > 10, JSON.stringify(meta));
  await page.close();
}

await browser.close(); chrome.kill();
process.exit(failed ? 1 : 0);
