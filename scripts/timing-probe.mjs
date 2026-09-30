// Dumps the word timestamps the app produces for the demo clip (or CLIP=path) to tmp/words.json,
// so they can be compared with audio onsets (ffmpeg silencedetect). MODEL=… picks the Whisper model.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';

const URL = process.env.SPIKE_URL ?? 'http://localhost:5173/';
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9341;
const chrome = spawn(CHROME, [
  '--headless', '--no-sandbox', ...(process.env.WASM ? ['--disable-gpu'] : []), `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}/subtitlr-e2e-profile`, '--no-first-run', '--disable-extensions', 'about:blank',
], { stdio: 'ignore' });
let browser;
for (let i = 0; i < 40 && !browser; i++) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); } catch { await new Promise((r) => setTimeout(r, 500)); }
}
const page = await (browser.contexts()[0] ?? (await browser.newContext())).newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.log(`[${m.type()}]`, m.text().slice(0, 900)); });
await page.goto(URL);
if (process.env.MODEL) await page.evaluate((m) => { window.subtitlr.state.quality = m; }, process.env.MODEL);
if (process.env.CLIP) {
  const buf = readFileSync(process.env.CLIP);
  await page.evaluate(async ([b64, name]) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    window.subtitlr.loadFile(new File([bin], name, { type: 'video/mp4' }));
  }, [buf.toString('base64'), process.env.CLIP.split(/[\\/]/).pop()]);
} else {
  await page.click('#demo');
}
await page.waitForSelector('#editor:not([hidden])', { timeout: 20_000 });
while (await page.$eval('#export', (b) => b.disabled)) await new Promise((r) => setTimeout(r, 1000));
const words = await page.evaluate(() => window.subtitlr.state.words);
mkdirSync('tmp', { recursive: true });
writeFileSync('tmp/words.json', JSON.stringify(words, null, 1));
for (const w of words) console.log(w.start.toFixed(2), w.end.toFixed(2), w.text);
await browser.close(); chrome.kill(); process.exit(0);
