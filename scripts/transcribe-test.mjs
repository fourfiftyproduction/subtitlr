// Headless end-to-end check of src/transcribe.ts against the running dev server (see spike-test.mjs for the CDP pattern).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PAGE = process.env.SPIKE_URL ?? 'http://localhost:5173/transcribe-spike.html';
const CLIP = process.env.CLIP_URL ?? 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav';
const EXPECT = process.env.EXPECT ?? 'country'; // word the transcript must contain
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9334;
const TIMEOUT_MS = 15 * 60_000; // first run downloads the model and runs single-threaded wasm

// Playwright's own launcher exits immediately with this Chrome build; launch manually and attach over CDP.
// Persistent profile so the model stays in the browser cache between runs. WASM=1 hides the GPU to force the wasm path.
const chrome = spawn(CHROME, [
  '--headless', '--no-sandbox', '--disable-gpu-sandbox',
  ...(process.env.WASM ? ['--disable-gpu'] : []),
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}/subtitlr-transcribe-profile`,
  '--no-first-run', '--disable-extensions',
  'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => chrome.kill());

let browser;
for (let i = 0; i < 40 && !browser; i++) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); }
  catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (!browser) throw new Error('Could not attach to Chrome');
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = await context.newPage();
page.on('console', (m) => { if (m.type() !== 'log' || m.text().startsWith('[spike]')) console.log('[page]', m.type(), m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(PAGE);
await page.waitForFunction(() => typeof window.runTranscribe === 'function', null, { timeout: 60_000 });
// Vite may reload the page once while it pre-bundles a dependency seen for the first time.
await page.waitForTimeout(1500);
await page.waitForFunction(() => typeof window.runTranscribe === 'function', null, { timeout: 60_000 });

const t0 = Date.now();
const watchdog = setInterval(async () => {
  try { console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, await page.textContent('#status')); } catch {}
}, 5000);
process.on('exit', () => clearInterval(watchdog));

const run = () => page.evaluate((url) => window.runTranscribe(url), CLIP);
let json;
try { json = await Promise.race([run(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS))]); }
catch (e) {
  if (!/Execution context was destroyed/.test(String(e))) throw e;
  console.log('page reloaded, retrying once');
  await page.waitForFunction(() => typeof window.runTranscribe === 'function', null, { timeout: 60_000 });
  json = await Promise.race([run(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS))]);
}
clearInterval(watchdog);

const { words, language, backend, elapsedMs } = JSON.parse(json);
for (const w of words) console.log(`${w.start.toFixed(2).padStart(6)} – ${w.end.toFixed(2).padStart(6)}  ${w.text}`);
const text = words.map((w) => w.text).join(' ');
console.log(`\ntext: ${text}`);
console.log(`words: ${words.length}  language: ${language}  backend: ${backend}  elapsed: ${(elapsedMs / 1000).toFixed(1)}s (${((Date.now() - t0) / 1000).toFixed(1)}s wall)`);

const failures = [];
if (words.length < 10) failures.push(`expected >= 10 words, got ${words.length}`);
if (!text.toLowerCase().includes(EXPECT.toLowerCase())) failures.push(`text does not contain "${EXPECT}"`);
let t = 0;
for (const w of words) {
  if (!(w.start >= t && w.end >= w.start)) failures.push(`non-monotonic timing at "${w.text}" (${w.start}–${w.end}, prev end ${t})`);
  if (w.start < 0 || w.end > 12) failures.push(`timing out of [0, 12] at "${w.text}" (${w.start}–${w.end})`);
  t = w.end;
}

await browser.close();
chrome.kill();
if (failures.length) { console.log('\nFAIL\n- ' + failures.join('\n- ')); process.exit(1); }
console.log('\nPASS');
process.exit(0);
