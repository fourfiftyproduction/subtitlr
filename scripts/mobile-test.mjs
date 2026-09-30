// Mobile emulation against the live site (or SPIKE_URL): phone viewport + UA, no GPU. Logs page errors,
// console errors and status changes; screenshots landing and editor. Does not export.
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const URL = process.env.SPIKE_URL ?? 'https://fourfiftyproduction.github.io/subtitlr/';
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9343;
const chrome = spawn(CHROME, [
  '--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}/subtitlr-mobile-profile`, '--no-first-run', '--disable-extensions', 'about:blank',
], { stdio: 'ignore' });
let browser;
for (let i = 0; i < 40 && !browser; i++) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); } catch { await new Promise((r) => setTimeout(r, 500)); }
}
const dev = devices['Pixel 7'];
const context = await browser.newContext({ ...dev });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}]`, m.text().slice(0, 300)); });
page.on('crash', () => console.log('[CRASH] page crashed'));
mkdirSync('tmp', { recursive: true });
const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(0)}s]`;

await page.goto(URL);
await page.screenshot({ path: 'tmp/mobile-1-landing.png' });
console.log(stamp(), 'landing ok, warning:', await page.textContent('#support-warning'));
console.log('caps:', await page.evaluate(() => ({ webgpu: !!navigator.gpu, videoEncoder: typeof VideoEncoder, deviceMemory: navigator.deviceMemory, ua: navigator.userAgent.slice(0, 60) })));
await page.click('#demo');
await page.waitForSelector('#editor:not([hidden])', { timeout: 20_000 });
let last = '';
const deadline = Date.now() + (Number(process.env.WAIT_S ?? 600) * 1000);
while (Date.now() < deadline) {
  const s = await page.textContent('#status-text').catch((e) => `[gone: ${e.message.slice(0, 80)}]`);
  if (s !== last) { console.log(stamp(), s); last = s; }
  if (!(await page.$eval('#export', (b) => b.disabled).catch(() => true))) break;
  await new Promise((r) => setTimeout(r, 3000));
}
await page.screenshot({ path: 'tmp/mobile-2-editor.png' }).catch((e) => console.log('screenshot failed', e.message));
console.log(stamp(), 'words:', await page.evaluate(() => window.subtitlr?.state.words.length).catch((e) => e.message));
await browser.close(); chrome.kill(); process.exit(0);
