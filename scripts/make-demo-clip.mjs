// Builds public/demo.webm (vertical clip with public-domain speech) via headless Chrome + demo-clip.html.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const URL = process.env.SPIKE_URL ?? 'http://localhost:5173/demo-clip.html';
const AUDIO = 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav';
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9336;

const chrome = spawn(CHROME, [
  '--headless', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}/subtitlr-demo-profile`,
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--disable-extensions', 'about:blank',
], { stdio: 'ignore' });

let browser;
for (let i = 0; i < 40 && !browser; i++) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); }
  catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (!browser) { chrome.kill(); throw new Error('Could not attach to Chrome'); }
const page = await (browser.contexts()[0] ?? (await browser.newContext())).newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(URL);
const { size, b64 } = await page.evaluate((u) => window.makeDemoClip(u), AUDIO);
mkdirSync('public', { recursive: true });
writeFileSync('public/demo.webm', Buffer.from(b64, 'base64'));
console.log(`public/demo.webm written: ${(size / 1024).toFixed(0)} KB`);
await browser.close();
chrome.kill();
process.exit(0);
