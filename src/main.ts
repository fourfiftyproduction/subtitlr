import './style.css';
import { exportMp4, webCodecsAvailable } from './export';
import { isMobileDevice, transcribe, transcriptionBackend } from './transcribe';
import { drawCaptions, ensureFontsLoaded, frameSettings, groupWords, renderers } from './captions';
import { downloadText, toSrt, toText, toVtt } from './subtitles';
import { DEFAULT_SETTINGS, type CaptionLine, type CaptionSettings, type StyleId, type Word } from './types';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const ui = {
  intro: $('#intro'), editor: $('#editor'), drop: $('#drop'), file: $<HTMLInputElement>('#file'),
  supportWarning: $('#support-warning'),
  phone: $('.phone'), video: $<HTMLVideoElement>('#video'), overlay: $<HTMLCanvasElement>('#overlay'), playpause: $('#playpause'),
  scrub: $<HTMLInputElement>('#scrub'), time: $('#time'), duration: $('#duration'),
  status: $('#status'), statusText: $('#status-text'), barFill: $('#bar-fill'),
  styles: $('#styles'), font: $<HTMLSelectElement>('#font'), wpl: $<HTMLInputElement>('#wpl'),
  size: $<HTMLInputElement>('#size'), pos: $<HTMLInputElement>('#pos'), cText: $<HTMLInputElement>('#c-text'),
  cHi: $<HTMLInputElement>('#c-hi'), cStroke: $<HTMLInputElement>('#c-stroke'), upper: $<HTMLInputElement>('#upper'),
  autoColor: $<HTMLInputElement>('#auto-color'),
  offset: $<HTMLInputElement>('#offset'), offsetVal: $('#offset-val'),
  lang: $('#lang'), words: $('#words'),
  language: $<HTMLSelectElement>('#language'), quality: $<HTMLSelectElement>('#quality'), qualityLabel: $('#quality-label'),
  retranscribe: $<HTMLButtonElement>('#retranscribe'), copy: $<HTMLButtonElement>('#copy'),
  export: $<HTMLButtonElement>('#export'), resolution: $<HTMLSelectElement>('#resolution'),
  srt: $<HTMLButtonElement>('#srt'), vtt: $<HTMLButtonElement>('#vtt'),
  download: $<HTMLAnchorElement>('#download'), reset: $('#reset'),
};

const ACCURATE_MODEL = 'onnx-community/whisper-small_timestamped';
const PREFS_KEY = 'subtitlr.prefs.v1';

interface Prefs {
  settings: CaptionSettings;
  offset: number;      // seconds added to caption timing (positive = captions later)
  maxHeight: number;   // export cap
  language: string;    // '' = auto
  quality: 'fast' | 'accurate';
}

const state = {
  file: null as File | null,
  words: [] as Word[],
  lines: [] as CaptionLine[],
  settings: { ...DEFAULT_SETTINGS } as CaptionSettings,
  offset: 0,
  maxHeight: 1920,
  language: '',
  quality: 'fast' as Prefs['quality'],
  busy: false,
  transcribed: false,
};

const STYLE_IDS = Object.keys(renderers) as StyleId[];
const SAMPLE: Word[] = [
  { text: 'this', start: 0, end: 0.25 }, { text: 'runs', start: 0.25, end: 0.5 },
  { text: 'in', start: 0.5, end: 0.6 }, { text: 'your', start: 0.6, end: 0.8 }, { text: 'browser', start: 0.8, end: 1.3 },
];

// ---------- helpers ----------
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const baseName = () => (state.file?.name.replace(/\.[^.]+$/, '') || 'video');

function setStatus(fraction: number | null, text: string) {
  ui.status.classList.toggle('active', fraction !== null);
  if (fraction !== null) ui.barFill.style.width = `${Math.round(fraction * 100)}%`;
  ui.statusText.textContent = text;
}

function showMessage(text: string) {
  setStatus(null, text);
  ui.status.classList.add('active');
}

function setBusy(busy: boolean) {
  state.busy = busy;
  const ready = !busy && state.transcribed;
  ui.export.disabled = busy;
  for (const b of [ui.srt, ui.vtt, ui.copy, ui.retranscribe]) b.disabled = !ready;
}

function regroup() {
  state.lines = groupWords(state.words, state.settings);
  drawPreview();
}

// ---------- prefs ----------
function savePrefs() {
  try {
    const p: Prefs = { settings: state.settings, offset: state.offset, maxHeight: state.maxHeight, language: state.language, quality: state.quality };
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch { /* private mode etc. */ }
}

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const p = JSON.parse(raw) as Partial<Prefs>;
    if (p.settings) {
      const s = { ...DEFAULT_SETTINGS, ...p.settings };
      if (!(s.style in renderers)) s.style = DEFAULT_SETTINGS.style;
      state.settings = s;
    }
    if (typeof p.offset === 'number') state.offset = clamp(p.offset, -0.5, 0.5);
    if (typeof p.maxHeight === 'number') state.maxHeight = p.maxHeight;
    if (typeof p.language === 'string') state.language = p.language;
    if (p.quality === 'fast' || p.quality === 'accurate') state.quality = p.quality;
  } catch { /* ignore corrupt prefs */ }
}

function syncControls() {
  const s = state.settings;
  ui.font.value = s.fontFamily;
  ui.wpl.value = String(s.maxWordsPerLine);
  ui.size.value = String(s.fontSize);
  ui.pos.value = String(s.position);
  ui.cText.value = s.textColor;
  ui.cHi.value = s.highlightColor;
  ui.cStroke.value = s.strokeColor;
  ui.upper.checked = s.uppercase;
  ui.autoColor.checked = s.autoColor;
  ui.cText.disabled = s.autoColor;
  ui.offset.value = String(state.offset);
  ui.offsetVal.textContent = `${state.offset >= 0 ? '+' : ''}${state.offset.toFixed(2)} s`;
  ui.resolution.value = String(state.maxHeight);
  ui.language.value = state.language;
  ui.quality.value = state.quality;
}

function changed() {
  savePrefs();
  renderStyleCards();
  drawPreview();
}

// ---------- preview ----------
function drawPreview() {
  const { overlay, video } = ui;
  if (!overlay.width) return;
  const ctx = overlay.getContext('2d')!;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const s = frameSettings(video, video.videoWidth, video.videoHeight, state.settings);
  drawCaptions(ctx, video.currentTime - state.offset, overlay.width, overlay.height, state.lines, s);
}

let lastPreviewTime = -1;
let previewRunning = false;
function previewLoop() {
  drawPreview();
  const t = ui.video.currentTime;
  if (t !== lastPreviewTime) {
    lastPreviewTime = t;
    ui.scrub.value = String((t / ui.video.duration) * 1000 || 0);
    ui.time.textContent = fmt(t);
    highlightWord(t);
  }
  requestAnimationFrame(previewLoop);
}

function highlightWord(t: number) {
  const spans = ui.words.children;
  const tt = t - state.offset;
  for (let i = 0; i < spans.length; i++) {
    const w = state.words[i];
    spans[i].classList.toggle('active', !!w && tt >= w.start && tt < w.end);
  }
}

function seekTo(t: number) {
  ui.video.currentTime = clamp(t, 0, ui.video.duration || 0);
  drawPreview();
}

// ---------- style cards ----------
function renderStyleCards() {
  ui.styles.innerHTML = '';
  for (const id of STYLE_IDS) {
    const card = document.createElement('button');
    card.className = 'style-card' + (id === state.settings.style ? ' active' : '');
    card.type = 'button';
    const c = document.createElement('canvas');
    c.width = 270; c.height = 300;
    const ctx = c.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, 0, 300);
    g.addColorStop(0, '#2a2f4a'); g.addColorStop(1, '#0d0f1a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 270, 300);
    const lines = groupWords(SAMPLE, { ...state.settings, maxWordsPerLine: 3 });
    renderers[id](ctx, 0.3, 270, 300, lines, { ...state.settings, style: id, fontSize: 0.11, position: 0.5 });
    const label = document.createElement('span');
    label.textContent = id;
    card.append(c, label);
    card.onclick = () => { state.settings.style = id; changed(); };
    ui.styles.append(card);
  }
}

// ---------- transcript editor ----------
function renderWords() {
  ui.words.innerHTML = '';
  if (!state.words.length) {
    ui.words.innerHTML = '<span class="empty">No speech detected.</span>';
    return;
  }
  state.words.forEach((w, i) => {
    const span = document.createElement('span');
    span.className = 'w';
    span.contentEditable = 'true';
    span.spellcheck = false;
    span.textContent = w.text;
    span.onclick = () => seekTo(w.start + state.offset);
    span.oninput = () => { state.words[i].text = span.textContent?.trim() ?? ''; regroup(); };
    span.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); span.blur(); }
    };
    span.onblur = () => {
      if (!span.textContent?.trim()) { // cleared → delete the word
        state.words.splice(i, 1);
        renderWords();
        regroup();
      }
    };
    ui.words.append(span);
  });
}

// ---------- load + transcribe ----------
async function runTranscription() {
  if (!state.file) return;
  setBusy(true);
  setStatus(0, 'Preparing…');
  try {
    const t = await transcribe(state.file, {
      language: state.language || undefined,
      model: state.quality === 'accurate' && !isMobileDevice() ? ACCURATE_MODEL : undefined,
      onProgress: (f, stage) => setStatus(f, stage),
    });
    state.words = t.words;
    state.transcribed = true;
    ui.lang.textContent = t.language ? `· ${t.language}` : '';
    renderWords();
    regroup();
    setStatus(null, '');
    if (transcriptionBackend() === 'wasm') showMessage('Transcribed on CPU (no WebGPU in this browser).');
  } catch (err) {
    console.error(err);
    const msg = (err as Error).message ?? String(err);
    showMessage(/decode ?audio/i.test(msg) ? 'No audio could be read from this file (silent video or unsupported audio codec).' : 'Transcription failed: ' + msg);
  } finally {
    setBusy(false);
  }
}

async function loadFile(file: File) {
  state.file = file;
  state.words = [];
  state.lines = [];
  state.transcribed = false;
  ui.intro.hidden = true;
  ui.editor.hidden = false;
  ui.download.hidden = true;
  ui.video.src = URL.createObjectURL(file);
  const playable = await new Promise<boolean>((res) => {
    ui.video.addEventListener('loadedmetadata', () => res(true), { once: true });
    ui.video.addEventListener('error', () => res(false), { once: true });
  });
  if (!playable || !ui.video.videoWidth) {
    showMessage(playable
      ? 'This file has no video track.'
      : 'This browser cannot play this video (unsupported codec, e.g. HEVC/H.265 from an iPhone). Please convert it to H.264 MP4 first.');
    return;
  }
  // Recordings (MediaRecorder WebM) report Infinity until seeked to the end.
  if (!Number.isFinite(ui.video.duration)) {
    await new Promise<void>((res) => {
      ui.video.addEventListener('durationchange', () => { if (Number.isFinite(ui.video.duration)) res(); });
      ui.video.currentTime = 1e9;
      setTimeout(res, 3000);
    });
    ui.video.currentTime = 0;
  }
  const scale = Math.min(1, 720 / ui.video.videoWidth);
  ui.overlay.width = Math.round(ui.video.videoWidth * scale);
  ui.overlay.height = Math.round(ui.video.videoHeight * scale);
  ui.duration.textContent = fmt(ui.video.duration);
  renderStyleCards();
  if (!previewRunning) { previewRunning = true; requestAnimationFrame(previewLoop); }
  await runTranscription();
}

// ---------- export ----------
async function doExport() {
  if (!state.file || state.busy) return;
  setBusy(true);
  ui.video.pause();
  try {
    await ensureFontsLoaded([state.settings.fontFamily]);
    const t0 = performance.now();
    const { blob, audio } = await exportMp4({
      file: state.file,
      fps: 30,
      maxHeight: state.maxHeight,
      onProgress: (f, stage) => {
        // Estimate remaining time once enough frames are in to make it meaningful.
        const elapsed = (performance.now() - t0) / 1000;
        const eta = f > 0.1 && f < 0.96 ? ` · ~${Math.max(1, Math.round((elapsed / f) * (1 - f)))} s left` : '';
        setStatus(f, stage + eta);
      },
      drawOverlay: (ctx, t, w, h) => drawCaptions(ctx, t - state.offset, w, h, state.lines, frameSettings(ctx.canvas, w, h, state.settings)),
    });
    const url = URL.createObjectURL(blob);
    const name = baseName() + '-captioned.mp4';
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    ui.download.href = url; ui.download.download = name; ui.download.hidden = false;
    const audioNote = audio === 'opus' ? ' · audio as Opus (this browser has no AAC encoder)' : audio === 'none' ? ' · no audio track' : '';
    showMessage(`Done in ${((performance.now() - t0) / 1000).toFixed(0)} s · ${(blob.size / 1e6).toFixed(1)} MB${audioNote}`);
  } catch (err) {
    console.error(err);
    showMessage('Export failed: ' + (err as Error).message);
  } finally {
    setBusy(false);
  }
}

// ---------- wiring ----------
loadPrefs();
syncControls();

if (!webCodecsAvailable()) {
  ui.supportWarning.hidden = false;
  ui.supportWarning.textContent = 'This browser lacks WebCodecs, which the MP4 export needs. Please use Chrome or Edge on a desktop.';
} else if (isMobileDevice()) {
  ui.supportWarning.hidden = false;
  ui.supportWarning.textContent = 'On a phone, Subtitlr runs a smaller Whisper model on the CPU, so expect a slower, rougher transcript. For the full experience open this page in Chrome or Edge on a laptop or desktop.';
}
if (isMobileDevice()) ui.qualityLabel.hidden = true;

ui.file.onchange = () => { const f = ui.file.files?.[0]; if (f) loadFile(f); };
$('#demo').onclick = async () => {
  const blob = await (await fetch('./demo.webm')).blob();
  loadFile(new File([blob], 'demo.webm', { type: 'video/webm' }));
};
for (const ev of ['dragenter', 'dragover'] as const) ui.drop.addEventListener(ev, (e) => { e.preventDefault(); ui.drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop'] as const) ui.drop.addEventListener(ev, (e) => { e.preventDefault(); ui.drop.classList.remove('over'); });
ui.drop.addEventListener('drop', (e) => { const f = e.dataTransfer?.files?.[0]; if (f) loadFile(f); });

const togglePlay = () => { ui.video.paused ? ui.video.play() : ui.video.pause(); };
ui.playpause.onclick = togglePlay;
ui.video.onplay = () => { ui.playpause.textContent = '❚❚'; ui.playpause.className = 'play playing'; };
ui.video.onpause = () => { ui.playpause.textContent = '▶'; ui.playpause.className = 'play paused'; };
ui.scrub.oninput = () => seekTo((Number(ui.scrub.value) / 1000) * ui.video.duration);

// Drag vertically on the preview to move the captions; a plain click toggles playback.
{
  let startY = 0, startPos = 0, dragging = false, pointerId = -1;
  ui.phone.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('.play')) return;
    pointerId = e.pointerId; startY = e.clientY; startPos = state.settings.position; dragging = false;
    ui.phone.setPointerCapture(e.pointerId);
  });
  ui.phone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId) return;
    const rect = ui.phone.getBoundingClientRect();
    const dy = e.clientY - startY;
    if (!dragging && Math.abs(dy) < 4) return;
    dragging = true;
    ui.phone.classList.add('dragging');
    state.settings.position = clamp(startPos + dy / rect.height, 0.1, 0.92);
    ui.pos.value = String(state.settings.position);
    drawPreview();
  });
  const end = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    pointerId = -1;
    ui.phone.classList.remove('dragging');
    if (dragging) savePrefs();
    else if (e.type === 'pointerup') togglePlay(); // a cancelled gesture (scroll, second finger) is not a tap
  };
  ui.phone.addEventListener('pointerup', end);
  ui.phone.addEventListener('pointercancel', end);
}

// Keyboard: space = play/pause, arrows = seek (shift = 5 s). Ignored while typing in a field.
document.addEventListener('keydown', (e) => {
  if (ui.editor.hidden || state.busy) return;
  const el = e.target as HTMLElement;
  if (el.isContentEditable || /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(el.tagName)) return;
  const step = e.shiftKey ? 5 : 1;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); seekTo(ui.video.currentTime - step); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); seekTo(ui.video.currentTime + step); }
});

ui.font.onchange = async () => { state.settings.fontFamily = ui.font.value; await ensureFontsLoaded([ui.font.value]); changed(); };
ui.wpl.oninput = () => { state.settings.maxWordsPerLine = Number(ui.wpl.value); savePrefs(); regroup(); };
ui.size.oninput = () => { state.settings.fontSize = Number(ui.size.value); savePrefs(); drawPreview(); };
ui.pos.oninput = () => { state.settings.position = Number(ui.pos.value); savePrefs(); drawPreview(); };
ui.cText.oninput = () => { state.settings.textColor = ui.cText.value; changed(); };
ui.cHi.oninput = () => { state.settings.highlightColor = ui.cHi.value; changed(); };
ui.cStroke.oninput = () => { state.settings.strokeColor = ui.cStroke.value; changed(); };
ui.upper.onchange = () => { state.settings.uppercase = ui.upper.checked; changed(); };
ui.autoColor.onchange = () => { state.settings.autoColor = ui.autoColor.checked; ui.cText.disabled = ui.autoColor.checked; savePrefs(); drawPreview(); };
ui.offset.oninput = () => {
  state.offset = Number(ui.offset.value);
  ui.offsetVal.textContent = `${state.offset >= 0 ? '+' : ''}${state.offset.toFixed(2)} s`;
  savePrefs(); drawPreview(); highlightWord(ui.video.currentTime);
};
ui.resolution.onchange = () => { state.maxHeight = Number(ui.resolution.value); savePrefs(); };
ui.language.onchange = () => { state.language = ui.language.value; savePrefs(); };
ui.quality.onchange = () => { state.quality = ui.quality.value as Prefs['quality']; savePrefs(); };
ui.retranscribe.onclick = () => { if (!state.busy) runTranscription(); };

ui.copy.onclick = async () => {
  try {
    await navigator.clipboard.writeText(toText(state.words));
    showMessage('Transcript copied.');
  } catch { showMessage('Clipboard blocked by the browser.'); }
};
ui.srt.onclick = () => downloadText(baseName() + '.srt', toSrt(state.lines, state.offset), 'application/x-subrip');
ui.vtt.onclick = () => downloadText(baseName() + '.vtt', toVtt(state.lines, state.offset), 'text/vtt');

ui.export.onclick = doExport;
ui.reset.onclick = () => location.reload();

// expose for headless tests
(window as any).subtitlr = { state, loadFile, doExport, toSrt, toVtt };
