import './style.css';
import { exportMp4, webCodecsAvailable } from './export';
import { isMobileDevice, transcribe, transcriptionBackend } from './transcribe';
import { drawCaptions, ensureFontsLoaded, groupWords, renderers } from './captions';
import { DEFAULT_SETTINGS, type CaptionLine, type CaptionSettings, type StyleId, type Word } from './types';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const ui = {
  intro: $('#intro'), editor: $('#editor'), drop: $('#drop'), file: $<HTMLInputElement>('#file'),
  supportWarning: $('#support-warning'),
  video: $<HTMLVideoElement>('#video'), overlay: $<HTMLCanvasElement>('#overlay'), playpause: $('#playpause'),
  scrub: $<HTMLInputElement>('#scrub'), time: $('#time'), duration: $('#duration'),
  status: $('#status'), statusText: $('#status-text'), barFill: $('#bar-fill'),
  styles: $('#styles'), font: $<HTMLSelectElement>('#font'), wpl: $<HTMLInputElement>('#wpl'),
  size: $<HTMLInputElement>('#size'), pos: $<HTMLInputElement>('#pos'), cText: $<HTMLInputElement>('#c-text'),
  cHi: $<HTMLInputElement>('#c-hi'), upper: $<HTMLInputElement>('#upper'),
  lang: $('#lang'), words: $('#words'),
  export: $<HTMLButtonElement>('#export'), download: $<HTMLAnchorElement>('#download'), reset: $('#reset'),
};

const state = {
  file: null as File | null,
  words: [] as Word[],
  lines: [] as CaptionLine[],
  settings: { ...DEFAULT_SETTINGS } as CaptionSettings,
  busy: false,
};

const STYLE_IDS = Object.keys(renderers) as StyleId[];
const SAMPLE: Word[] = [
  { text: 'this', start: 0, end: 0.25 }, { text: 'runs', start: 0.25, end: 0.5 },
  { text: 'in', start: 0.5, end: 0.6 }, { text: 'your', start: 0.6, end: 0.8 }, { text: 'browser', start: 0.8, end: 1.3 },
];

// ---------- helpers ----------
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function setStatus(fraction: number | null, text: string) {
  ui.status.classList.toggle('active', fraction !== null);
  if (fraction !== null) ui.barFill.style.width = `${Math.round(fraction * 100)}%`;
  ui.statusText.textContent = text;
}

function regroup() {
  state.lines = groupWords(state.words, state.settings);
  drawPreview();
}

// ---------- preview ----------
function drawPreview() {
  const { overlay, video } = ui;
  if (!overlay.width) return;
  const ctx = overlay.getContext('2d')!;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  drawCaptions(ctx, video.currentTime, overlay.width, overlay.height, state.lines, state.settings);
}

let lastPreviewTime = -1;
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
  for (let i = 0; i < spans.length; i++) {
    const w = state.words[i];
    spans[i].classList.toggle('active', !!w && t >= w.start && t < w.end);
  }
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
    card.onclick = () => { state.settings.style = id; renderStyleCards(); drawPreview(); };
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
    span.onclick = () => { ui.video.currentTime = w.start; drawPreview(); };
    span.oninput = () => { state.words[i].text = span.textContent?.trim() ?? ''; regroup(); };
    span.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); span.blur(); } };
    ui.words.append(span);
  });
}

// ---------- load + transcribe ----------
async function loadFile(file: File) {
  state.file = file;
  ui.intro.hidden = true;
  ui.editor.hidden = false;
  ui.video.src = URL.createObjectURL(file);
  await new Promise<void>((res) => ui.video.addEventListener('loadedmetadata', () => res(), { once: true }));
  const scale = Math.min(1, 720 / ui.video.videoWidth);
  ui.overlay.width = Math.round(ui.video.videoWidth * scale);
  ui.overlay.height = Math.round(ui.video.videoHeight * scale);
  ui.duration.textContent = fmt(ui.video.duration);
  renderStyleCards();
  requestAnimationFrame(previewLoop);

  state.busy = true;
  ui.export.disabled = true;
  setStatus(0, 'Preparing…');
  try {
    const t = await transcribe(file, {
      onProgress: (f, stage) => setStatus(f, stage),
    });
    state.words = t.words;
    ui.lang.textContent = t.language ? `· ${t.language}` : '';
    renderWords();
    regroup();
    setStatus(null, '');
    const backend = transcriptionBackend();
    ui.statusText.textContent = backend === 'wasm' ? 'Transcribed on CPU (no WebGPU in this browser).' : '';
  } catch (err) {
    console.error(err);
    setStatus(null, 'Transcription failed: ' + (err as Error).message);
    ui.status.classList.add('active');
  } finally {
    state.busy = false;
    ui.export.disabled = false;
  }
}

// ---------- export ----------
async function doExport() {
  if (!state.file || state.busy) return;
  state.busy = true;
  ui.export.disabled = true;
  ui.video.pause();
  try {
    await ensureFontsLoaded([state.settings.fontFamily]);
    const t0 = performance.now();
    const blob = await exportMp4({
      file: state.file,
      fps: 30,
      onProgress: (f, stage) => {
        // Estimate remaining time once enough frames are in to make it meaningful.
        const elapsed = (performance.now() - t0) / 1000;
        const eta = f > 0.1 && f < 0.96 ? ` · ~${Math.max(1, Math.round((elapsed / f) * (1 - f)))} s left` : '';
        setStatus(f, stage + eta);
      },
      drawOverlay: (ctx, t, w, h) => drawCaptions(ctx, t, w, h, state.lines, state.settings),
    });
    const url = URL.createObjectURL(blob);
    const name = (state.file.name.replace(/\.[^.]+$/, '') || 'video') + '-captioned.mp4';
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    ui.download.href = url; ui.download.download = name; ui.download.hidden = false;
    setStatus(null, `Done in ${((performance.now() - t0) / 1000).toFixed(0)} s · ${(blob.size / 1e6).toFixed(1)} MB`);
    ui.status.classList.add('active');
  } catch (err) {
    console.error(err);
    setStatus(null, 'Export failed: ' + (err as Error).message);
    ui.status.classList.add('active');
  } finally {
    state.busy = false;
    ui.export.disabled = false;
  }
}

// ---------- wiring ----------
if (!webCodecsAvailable()) {
  ui.supportWarning.hidden = false;
  ui.supportWarning.textContent = 'This browser lacks WebCodecs, which the MP4 export needs. Please use Chrome or Edge on a desktop.';
} else if (isMobileDevice()) {
  ui.supportWarning.hidden = false;
  ui.supportWarning.textContent = 'On a phone, Subtitlr runs a smaller Whisper model on the CPU, so expect a slower, rougher transcript. For the full experience open this page in Chrome or Edge on a laptop or desktop.';
}

ui.file.onchange = () => { const f = ui.file.files?.[0]; if (f) loadFile(f); };
$('#demo').onclick = async () => {
  const blob = await (await fetch('./demo.webm')).blob();
  loadFile(new File([blob], 'demo.webm', { type: 'video/webm' }));
};
for (const ev of ['dragenter', 'dragover'] as const) ui.drop.addEventListener(ev, (e) => { e.preventDefault(); ui.drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop'] as const) ui.drop.addEventListener(ev, (e) => { e.preventDefault(); ui.drop.classList.remove('over'); });
ui.drop.addEventListener('drop', (e) => { const f = e.dataTransfer?.files?.[0]; if (f) loadFile(f); });

ui.playpause.onclick = () => { ui.video.paused ? ui.video.play() : ui.video.pause(); };
ui.video.onclick = ui.playpause.onclick;
ui.video.onplay = () => { ui.playpause.textContent = '❚❚'; ui.playpause.className = 'play playing'; };
ui.video.onpause = () => { ui.playpause.textContent = '▶'; ui.playpause.className = 'play paused'; };
ui.scrub.oninput = () => {
  ui.video.currentTime = (Number(ui.scrub.value) / 1000) * ui.video.duration;
  ui.time.textContent = fmt(ui.video.currentTime);
  drawPreview();
};

ui.font.onchange = async () => { state.settings.fontFamily = ui.font.value; await ensureFontsLoaded([ui.font.value]); renderStyleCards(); drawPreview(); };
ui.wpl.oninput = () => { state.settings.maxWordsPerLine = Number(ui.wpl.value); regroup(); };
ui.size.oninput = () => { state.settings.fontSize = Number(ui.size.value); drawPreview(); };
ui.pos.oninput = () => { state.settings.position = Number(ui.pos.value); drawPreview(); };
ui.cText.oninput = () => { state.settings.textColor = ui.cText.value; renderStyleCards(); drawPreview(); };
ui.cHi.oninput = () => { state.settings.highlightColor = ui.cHi.value; renderStyleCards(); drawPreview(); };
ui.upper.onchange = () => { state.settings.uppercase = ui.upper.checked; renderStyleCards(); drawPreview(); };

ui.export.onclick = doExport;
ui.reset.onclick = () => location.reload();

// expose for headless tests
(window as any).subtitlr = { state, loadFile, doExport };
