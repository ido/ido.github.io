// Preview player. The audio clock is the only source of t during playback;
// the renderer never sees wall-clock time or frame deltas.

import { SONG } from './song.js';
import { synthesize, encodeWav } from './synth.js';
import { renderFrame, FONT_DISPLAY, FONT_MONO } from './render.js';
import { exportWebM, canExport } from './export.js';

const $ = s => document.querySelector(s);
const canvas = $('#stage'), ctx = canvas.getContext('2d');
const params = new URLSearchParams(location.search);
const RES = { 720: [1280, 720], 1080: [1920, 1080], 360: [640, 360] };

let audio = null;          // { sampleRate, left, right }
let ac = null, buffer = null, source = null;
let playing = false, startedAt = 0, offset = 0;   // song time = ac clock - startedAt + offset
let scrubT = parseFloat(params.get('t')) || 0;
let exporting = null;

function setResolution(key) {
  const [w, h] = RES[key] || RES[720];
  canvas.width = w; canvas.height = h;
  $('#res').value = String(h);
}

function now() {
  if (!playing) return scrubT;
  const latency = ac.outputLatency || ac.baseLatency || 0;   // show what is being heard
  return Math.max(0, ac.currentTime - latency - startedAt + offset);
}

function ensureAudioContext() {
  if (ac) return;
  ac = new AudioContext({ sampleRate: audio.sampleRate });
  buffer = ac.createBuffer(2, audio.left.length, audio.sampleRate);
  buffer.copyToChannel(audio.left, 0);
  buffer.copyToChannel(audio.right, 1);
}

function play(from = scrubT) {
  ensureAudioContext();
  ac.resume();
  stopSource();
  if (from >= SONG.duration - 0.05) from = 0;
  source = ac.createBufferSource();
  source.buffer = buffer;
  source.connect(ac.destination);
  startedAt = ac.currentTime + 0.03;
  offset = from;
  source.start(startedAt, from);
  playing = true;
  $('#play').textContent = 'Pause';
}

function stopSource() {
  if (source) { source.onended = null; try { source.stop(); } catch {} source.disconnect(); source = null; }
}

function pause() {
  scrubT = now();
  stopSource();
  playing = false;
  $('#play').textContent = 'Play';
}

function seek(t) {
  t = Math.min(Math.max(0, t), SONG.duration);
  if (playing) play(t); else scrubT = t;
}

function fmt(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

function tick() {
  if (!exporting) {
    let t = now();
    if (playing && t >= SONG.duration) { pause(); scrubT = t = SONG.duration; }
    renderFrame(ctx, t);
    if (document.activeElement !== $('#scrub') || playing) $('#scrub').value = t;
    $('#time').textContent = `${fmt(t)} / ${fmt(SONG.duration)}`;
  }
  requestAnimationFrame(tick);
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

async function runExport() {
  if (exporting) { exporting.abort(); return; }
  if (playing) pause();
  exporting = new AbortController();
  const fps = parseInt($('#fps').value, 10);
  $('#export').textContent = 'Cancel';
  document.body.classList.add('exporting');
  try {
    const blob = await exportWebM({
      canvas, audio, duration: SONG.duration, fps, signal: exporting.signal,
      onProgress: p => {
        const rate = p.frame / Math.max(0.001, p.elapsed);
        $('#status').textContent = `Exporting frame ${p.frame}/${p.frames} · ${rate.toFixed(1)} fps`;
        $('#progress').value = p.frame / p.frames;
        $('#scrub').value = p.t;
      },
    });
    $('#status').textContent = `Done: ${(blob.size / 1e6).toFixed(1)} MB WebM`;
    download(blob, `play-it-back-${canvas.height}p${fps}.webm`);
  } catch (e) {
    $('#status').textContent = e.name === 'AbortError' ? 'Export cancelled' : `Export failed: ${e.message}`;
    if (e.name !== 'AbortError') console.error(e);
  } finally {
    exporting = null;
    $('#export').textContent = 'Export WebM';
    document.body.classList.remove('exporting');
    $('#progress').value = 0;
  }
}

// FNV-1a over the canvas pixels — used by tools/verify.cjs.
function frameHash(t) {
  renderFrame(ctx, t);
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let h = 0x811c9dc5;
  for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

async function init() {
  setResolution(params.get('res') || '720');
  $('#status').textContent = 'Loading fonts…';
  await Promise.all([
    document.fonts.load(`700 64px ${FONT_DISPLAY}`),
    document.fonts.load(`500 16px ${FONT_MONO}`),
  ]);
  renderFrame(ctx, scrubT);
  $('#status').textContent = 'Synthesizing audio…';
  audio = await synthesize(SONG, p => { $('#progress').value = p; });
  $('#progress').value = 0;
  $('#scrub').max = SONG.duration;
  $('#status').textContent = canExport() ? 'Ready' : 'Ready (export needs WebCodecs: Chrome/Edge/Safari 17+)';
  $('#export').disabled = !canExport();
  for (const el of document.querySelectorAll('[data-needs-audio]')) el.disabled = false;

  $('#play').onclick = () => playing ? pause() : play();
  $('#scrub').oninput = e => seek(parseFloat(e.target.value));
  $('#res').onchange = e => { setResolution(e.target.value); };
  $('#export').onclick = runExport;
  $('#wav').onclick = () => download(encodeWav(audio), 'play-it-back.wav');
  $('#png').onclick = () => {
    const t = now();
    renderFrame(ctx, t);
    canvas.toBlob(b => download(b, `frame-${t.toFixed(3)}s.png`));
  };
  window.addEventListener('keydown', e => {
    if (exporting || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); playing ? pause() : play(); }
    if (e.code === 'ArrowLeft') seek(now() - (e.shiftKey ? 1 / 30 : 2));
    if (e.code === 'ArrowRight') seek(now() + (e.shiftKey ? 1 / 30 : 2));
  });
  requestAnimationFrame(tick);
}

// Hooks for the headless tools (tools/export.cjs, tools/verify.cjs).
window.MV = {
  SONG,
  ready: null,
  frameHash,
  setResolution,
  audioHash() {
    let h = 0x811c9dc5;
    for (const ch of [audio.left, audio.right]) {
      const b = new Uint8Array(ch.buffer);
      for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); }
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  },
  async exportWebM(opts = {}) {
    if (opts.res) setResolution(opts.res);
    return exportWebM({ canvas, audio, duration: opts.duration ?? SONG.duration, fps: opts.fps ?? 30,
                        onProgress: opts.onProgress });
  },
};
window.MV.ready = init();
