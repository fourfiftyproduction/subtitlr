// Headless render check of src/captions.ts via captions-spike.html on the running dev server.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';

const URL = process.env.SPIKE_URL ?? 'http://localhost:5173/captions-spike.html';
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9335;
const STYLES = ['pop', 'karaoke', 'boxed', 'clean', 'outline'];
// extra variants: [suffix, style, settings override]
const VARIANTS = [
  ['pop-montserrat', 'pop', { fontFamily: 'Montserrat' }],
  ['pop-bebas', 'pop', { fontFamily: 'Bebas Neue', fontSize: 0.07 }],
  ['clean-lower', 'clean', { uppercase: false, fontFamily: 'Poppins' }],
  ['boxed-6words', 'boxed', { maxWordsPerLine: 6 }],
];

const chrome = spawn(CHROME, [
  '--headless', '--no-sandbox', '--disable-gpu-sandbox',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}/subtitlr-captions-profile`,
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
page.on('console', (m) => console.log('[page]', m.type(), m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(URL);
await page.waitForFunction(() => window.fontsReady === true, null, { timeout: 30_000 });
console.log('fonts:', await page.evaluate(() => ['Inter', 'Montserrat', 'Bebas Neue', 'Poppins'].map((f) => `${f}=${document.fonts.check(`800 32px "${f}"`)}`).join(' ')));

// --- grouping ---
const words = await page.evaluate(() => window.sampleWords);
const lines = JSON.parse(await page.evaluate(() => window.groupSample()));
console.log(`\n${words.length} words -> ${lines.length} lines:`);
for (const l of lines) console.log(`  ${l.start.toFixed(2)}-${l.end.toFixed(2)}  ${l.words.map((w) => w.text).join(' ')}`);

let fail = 0;
const assert = (ok, msg) => { if (!ok) { fail++; console.log('  FAIL:', msg); } };
const flat = lines.flatMap((l) => l.words.map((w) => w.text));
assert(flat.length === words.length && flat.every((t, i) => t === words[i].text), 'lines must cover all words in order');
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  assert(l.words.length <= 4, `line ${i} exceeds maxWordsPerLine`);
  assert(l.start <= l.words[0].start && l.end >= l.words[l.words.length - 1].end, `line ${i} does not span its words`);
  if (i > 0) assert(lines[i - 1].end <= l.start, `line ${i - 1} overlaps line ${i}`);
  if (i > 0) assert(l.start - lines[i - 1].end === 0 || l.start - lines[i - 1].end >= 0.25, `gap before line ${i} should be bridged`);
}
const six = JSON.parse(await page.evaluate(() => window.groupSample({ maxWordsPerLine: 6 })));
assert(six.every((l) => l.words.length <= 6), 'maxWordsPerLine=6 respected');
assert(six.every((l) => !l.words.slice(0, -1).some((w) => /[.!?]$/.test(w.text))), 'sentence end must end a line');
console.log(fail ? `\n${fail} grouping assertion(s) FAILED` : '\ngrouping OK');

// --- renders: pick a time where a middle word of line 2 is active, ~80 ms in (mid pop) ---
mkdirSync('tmp', { recursive: true });
const pickTime = (li) => { const l = lines[Math.min(li, lines.length - 1)]; const w = l.words[Math.min(2, l.words.length - 1)]; return w.start + 0.08; };
const t2 = pickTime(1);
const save = async (name, style, t, w, h, override) => {
  const url = await page.evaluate(([s, t, w, h, o]) => window.renderFrame(s, t, w, h, o), [style, t, w, h, override ?? {}]);
  writeFileSync(`tmp/caption-${name}.png`, Buffer.from(url.split(',')[1], 'base64'));
  console.log(`tmp/caption-${name}.png  (${style} @${t.toFixed(2)}s ${w}x${h})`);
};
for (const s of STYLES) await save(s, s, t2, 1080, 1920);
for (const [name, s, o] of VARIANTS) await save(name, s, t2, 1080, 1920, o);
await save('pop-preview', 'pop', t2, 540, 960);
await save('karaoke-late', 'karaoke', pickTime(0) + 0.35, 1080, 1920);
// an empty gap (before first word) must draw nothing
const blank = await page.evaluate((t) => { const a = window.renderFrame('pop', 0.05); const b = window.renderFrame('__none__', 0.05); return a === b; }, 0);
assert(blank, 'no caption before first word');

await browser.close();
chrome.kill();
process.exit(fail ? 1 : 0);
