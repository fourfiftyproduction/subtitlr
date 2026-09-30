// Fill and submit the Build Games entry form in a headed Chrome over CDP. Values come from env / defaults below.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const ENTRY = {
  name: process.env.ENTRY_NAME ?? 'Nils Schulte',
  handle: 'fourfifty',
  demo_url: 'https://fourfiftyproduction.github.io/subtitlr/',
  repo_url: 'https://github.com/fourfiftyproduction/subtitlr',
  blurb: 'Animated captions for shorts, 100% in the browser: Whisper on WebGPU, 5 styles, inline word editing, real MP4 export (H.264+AAC). Replaces Submagic/Captions ($16–39/mo). No upload, no server.',
  email: process.env.ENTRY_EMAIL ?? 'fourfifty.production@gmail.com',
};
const DRY = !!process.env.DRY;

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9344;
const chrome = spawn(CHROME, [
  '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${process.env.TEMP}/subtitlr-submit-profile`,
  '--no-first-run', '--disable-extensions', '--window-size=1100,1000', 'about:blank',
], { stdio: 'ignore' });
let browser;
for (let i = 0; i < 40 && !browser; i++) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); } catch { await new Promise((r) => setTimeout(r, 500)); }
}
const page = await (browser.contexts()[0] ?? (await browser.newContext())).newPage();
await page.setViewportSize({ width: 1100, height: 1000 });
mkdirSync('tmp', { recursive: true });
page.on('response', async (r) => {
  if (r.url().includes('/api/thebuildgames/enter')) console.log('[api]', r.status(), (await r.text().catch(() => '')).slice(0, 500));
});

await page.goto('https://canivibecodeit.com/thebuildgames', { waitUntil: 'domcontentloaded' });
const form = page.locator('form[data-entry-form]');
await form.scrollIntoViewIfNeeded();
for (const [k, v] of Object.entries(ENTRY)) await form.locator(`[name="${k}"]`).fill(v);
await form.locator('[name="newsletter_optin"]').check();
await form.locator('[name="accept_terms"]').check();
await page.screenshot({ path: 'tmp/submit-1-filled.png' });
console.log('filled:', await form.evaluate((f) => Object.fromEntries(new FormData(f))));

if (DRY) { console.log('DRY run, not submitting'); await browser.close(); chrome.kill(); process.exit(0); }

await form.locator('button[type=submit]').click();
await page.waitForTimeout(4000);
await page.screenshot({ path: 'tmp/submit-2-after.png' });
const err = await page.locator('[data-entry-err]').textContent().catch(() => '');
const region = await page.locator('.bg-enter-form, form[data-entry-form], [data-entry-form]').first().textContent().catch(() => '');
console.log('error field:', JSON.stringify(err));
console.log('form region now:', region?.replace(/\s+/g, ' ').slice(0, 400));
console.log('url now:', page.url());
await browser.close(); chrome.kill(); process.exit(0);
