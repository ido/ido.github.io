// renderFrame(ctx, t) draws the video frame for song time t (seconds).
//
// Contract: the output depends only on (t, canvas size, SONG). There is no
// state carried between frames — no accumulation buffers, no particle
// integration, no Math.random, no wall clock. Motion that "looks" stateful
// (trails, warp streaks, expanding rings) is re-derived every frame from the
// score's event lists or from closed-form integrals. Consequently frames can
// be rendered in any order: scrubbing, realtime playback and the frame-stepped
// exporter all produce the same pixels for the same t.
//
// The only caches below memoize pure functions of their keys (text layout,
// a seeded grain tile, the speed integral) and are safe to drop at any time.

import { SONG, sectionAt } from './song.js';

const TAU = Math.PI * 2;
export const FONT_DISPLAY = '"Space Grotesk", system-ui, sans-serif';
export const FONT_MONO = '"JetBrains Mono", ui-monospace, monospace';

// ---------------------------------------------------------------- utilities
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, k) => a + (b - a) * k;
const smooth = (a, b, x) => { const k = clamp((x - a) / (b - a)); return k * k * (3 - 2 * k); };
const easeOut = k => 1 - Math.pow(1 - clamp(k), 3);
const frac = x => x - Math.floor(x);

function hash(i, s = 0) {           // integer hash → [0, 1)
  let x = Math.imul(i | 0, 374761393) + Math.imul(s | 0, 668265263) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

function lastAtOrBefore(arr, t) {    // index of last element <= t, or -1
  let lo = 0, hi = arr.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] <= t) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}
function decay(arr, t, k) {
  const i = lastAtOrBefore(arr, t);
  return i < 0 ? 0 : Math.exp(-(t - arr[i]) * k);
}

const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mix = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];

// ---------------------------------------------------------------- look per section
const LOOKS = {
  intro:  { bg0: [8, 6, 24],   bg1: [26, 12, 48],  accent: [150, 120, 255], accent2: [255, 120, 200], ink: [235, 230, 255], speed: 0.25, ribbons: 0.0, rays: 0.0, energy: 0.3 },
  verse:  { bg0: [4, 14, 26],  bg1: [8, 40, 56],   accent: [80, 230, 210],  accent2: [120, 160, 255], ink: [225, 245, 245], speed: 0.6,  ribbons: 0.8, rays: 0.0, energy: 0.6 },
  chorus: { bg0: [30, 4, 30],  bg1: [90, 16, 50],  accent: [255, 196, 70],  accent2: [255, 70, 140],  ink: [255, 240, 235], speed: 1.6,  ribbons: 1.0, rays: 1.0, energy: 1.0 },
  bridge: { bg0: [2, 3, 8],    bg1: [10, 16, 30],  accent: [170, 220, 255], accent2: [120, 140, 255], ink: [220, 235, 255], speed: 0.15, ribbons: 0.3, rays: 0.0, energy: 0.25 },
  outro:  { bg0: [8, 6, 24],   bg1: [22, 10, 40],  accent: [150, 120, 255], accent2: [255, 120, 200], ink: [235, 230, 255], speed: 0.3,  ribbons: 0.4, rays: 0.3, energy: 0.4 },
};
const LOOK_KEYS = ['speed', 'ribbons', 'rays', 'energy'];
const COLOR_KEYS = ['bg0', 'bg1', 'accent', 'accent2', 'ink'];

function lookAt(t) {
  const sec = sectionAt(t);
  const cur = LOOKS[sec.name];
  const prev = sec.index > 0 ? LOOKS[SONG.sections[sec.index - 1].name] : cur;
  const k = smooth(0, SONG.spb * 2, t - sec.t0);
  const out = { section: sec };
  for (const key of COLOR_KEYS) out[key] = mix(prev[key], cur[key], k);
  for (const key of LOOK_KEYS) out[key] = lerp(prev[key], cur[key], k);
  return out;
}

// Starfield travel = ∫ speed(t) dt. Speed is piecewise constant per section
// with a smoothstep blend, so integrate numerically on a fixed grid — a pure
// function of t, cached by grid cell.
const TRAVEL_DT = 1 / 120;
let travelTable = null;
function travel(t) {
  if (!travelTable) {
    const n = Math.ceil(SONG.duration / TRAVEL_DT) + 2;
    travelTable = new Float64Array(n);
    for (let i = 1; i < n; i++) travelTable[i] = travelTable[i - 1] + lookAt((i - 0.5) * TRAVEL_DT).speed * TRAVEL_DT;
  }
  const x = clamp(t, 0, SONG.duration) / TRAVEL_DT, i = Math.floor(x);
  const a = travelTable[i], b = travelTable[Math.min(i + 1, travelTable.length - 1)];
  return lerp(a, b, x - i) + Math.max(0, t - SONG.duration) * 0.3;
}

// ---------------------------------------------------------------- layers
function drawBackground(ctx, W, H, L, kick) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, rgb(L.bg0)); g.addColorStop(1, rgb(L.bg1));
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const r = ctx.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H * 0.45, H * 0.9);
  r.addColorStop(0, rgb(L.accent, 0.10 + 0.22 * kick * L.energy));
  r.addColorStop(1, rgb(L.accent, 0));
  ctx.fillStyle = r; ctx.fillRect(0, 0, W, H);
}

function drawRings(ctx, W, H, t, L) {
  const kicks = SONG.drums.kick, life = 2.2;
  const cx = W / 2 + Math.sin(t * 0.13) * W * 0.03, cy = H * 0.45 + Math.cos(t * 0.11) * H * 0.03;
  let i = lastAtOrBefore(kicks, t);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (; i >= 0 && t - kicks[i] < life; i--) {
    const age = t - kicks[i], k = age / life;
    const r = H * (0.05 + easeOut(k) * (0.55 + 0.45 * L.energy));
    ctx.strokeStyle = rgb(hash(i, 7) < 0.5 ? L.accent : L.accent2, Math.pow(1 - k, 2) * 0.45 * (0.4 + L.energy));
    ctx.lineWidth = H * (0.002 + 0.006 * (1 - k));
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke();
  }
  ctx.restore();
}

function drawStars(ctx, W, H, t, L, kick) {
  const N = 280, tr = travel(t), cx = W / 2, cy = H * 0.45, maxR = Math.hypot(W, H) * 0.6;
  const streak = 0.02 + 0.05 * L.speed;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (let i = 0; i < N; i++) {
    const ang = hash(i, 1) * TAU, z = 0.35 + 0.65 * hash(i, 2), u = hash(i, 3);
    const p1 = frac(u + tr * z * 0.12), p0 = p1 - streak * z;
    if (p0 < 0) continue;                    // just wrapped: skip one frame's streak
    const r1 = Math.pow(p1, 2.2) * maxR, r0 = Math.pow(p0, 2.2) * maxR;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const tw = 0.6 + 0.4 * Math.sin(t * (2 + 3 * hash(i, 4)) + hash(i, 5) * TAU);
    ctx.strokeStyle = rgb(hash(i, 6) < 0.7 ? L.ink : L.accent, clamp(p1 * 2.5) * tw * (0.55 + 0.45 * kick));
    ctx.lineWidth = H * 0.0035 * z * (0.6 + p1 * 1.6);
    ctx.beginPath(); ctx.moveTo(cx + ca * r0, cy + sa * r0); ctx.lineTo(cx + ca * r1, cy + sa * r1); ctx.stroke();
  }
  ctx.restore();
}

function drawRibbons(ctx, W, H, t, L) {
  if (L.ribbons < 0.01) return;
  const tail = 1.1, steps = 48;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (let k = 0; k < 5; k++) {
    const a = 0.31 + 0.13 * k, b = 0.47 - 0.05 * k, ph = k * 1.7;
    const P = u => [
      W / 2 + W * 0.42 * Math.sin(a * u + ph) * Math.cos(0.21 * u + k),
      H * 0.45 + H * 0.34 * Math.sin(b * u * 1.3 + ph * 0.5),
    ];
    let prev = P(t - tail);
    for (let s = 1; s <= steps; s++) {
      const q = s / steps, cur = P(t - tail + tail * q);
      ctx.strokeStyle = rgb(k % 2 ? L.accent : L.accent2, q * q * 0.35 * L.ribbons);
      ctx.lineWidth = H * 0.006 * q;
      ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(cur[0], cur[1]); ctx.stroke();
      prev = cur;
    }
  }
  ctx.restore();
}

function drawRays(ctx, W, H, t, L, kick) {
  if (L.rays < 0.01) return;
  const n = 18, cx = W / 2, cy = H * 0.45, R = Math.hypot(W, H);
  const rot = t * 0.15;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = rgb(L.accent, 0.035 * L.rays * (0.5 + kick));
  for (let i = 0; i < n; i++) {
    const a = rot + i * TAU / n, w = 0.05;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a - w) * R, cy + Math.sin(a - w) * R);
    ctx.lineTo(cx + Math.cos(a + w) * R, cy + Math.sin(a + w) * R);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

// Big ghost of the current accent word, behind the lyrics.
function drawHeroWord(ctx, W, H, t, L) {
  for (const line of SONG.lines) {
    if (t < line.t0 - 1 || t > line.t1 + 2) continue;
    for (const w of line.words) {
      if (!w.accent || t < w.t0 || t > w.t1 + 1.2) continue;
      const k = (t - w.t0) / (w.t1 + 1.2 - w.t0);
      const a = smooth(0, 0.08, k) * (1 - smooth(0.55, 1, k));
      ctx.save();
      ctx.translate(W / 2, H * 0.47);
      ctx.scale(1 + k * 0.18, 1 + k * 0.18);
      ctx.font = `700 ${Math.round(H * 0.34)}px ${FONT_DISPLAY}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = H * 0.003;
      ctx.strokeStyle = rgb(L.accent, 0.35 * a);
      ctx.fillStyle = rgb(L.accent2, 0.06 * a);
      const txt = w.text.replace(/[^\w']/g, '').toUpperCase();
      ctx.fillText(txt, 0, 0);
      ctx.strokeText(txt, 0, 0);
      ctx.restore();
    }
  }
}

// ---------------------------------------------------------------- karaoke
const LEAD_IN = 0.9, HOLD = 0.35, LEAD_OUT = 0.6;
const layoutCache = new Map();

function fontSizeFor(line, H) {
  const name = SONG.sections[line.section].name;
  return Math.round(H * (name === 'chorus' ? 0.098 : name === 'bridge' ? 0.105 : 0.082));
}

// Word boxes for a line: rows centered at x=0, each syllable's x-span known so
// the wipe can advance syllable by syllable.
function layoutLine(ctx, line, W, H) {
  const key = `${line.index}|${W}x${H}`;
  let lay = layoutCache.get(key);
  if (lay) return lay;
  const fs = fontSizeFor(line, H);
  ctx.save();
  ctx.font = `700 ${fs}px ${FONT_DISPLAY}`;
  const space = ctx.measureText(' ').width;
  const words = line.words.map(w => {
    let acc = '';
    const edges = [0];
    for (const s of w.syl) { acc += s.text; edges.push(ctx.measureText(acc).width); }
    return { w, width: edges[edges.length - 1], edges };
  });
  ctx.restore();
  const total = ws => ws.reduce((s, x) => s + x.width, 0) + space * Math.max(0, ws.length - 1);
  let rows = [words];
  if (total(words) > W * 0.86) {               // balanced two-row split
    let best = 1, bestW = Infinity;
    for (let i = 1; i < words.length; i++) {
      const m = Math.max(total(words.slice(0, i)), total(words.slice(i)));
      if (m < bestW) { bestW = m; best = i; }
    }
    rows = [words.slice(0, best), words.slice(best)];
  }
  const lineH = fs * 1.12;
  const placed = [];
  rows.forEach((row, r) => {
    let x = -total(row) / 2;
    const y = (r - (rows.length - 1) / 2) * lineH;
    for (const it of row) { placed.push({ ...it, x, y }); x += it.width + space; }
  });
  lay = { fs, words: placed };
  layoutCache.set(key, lay);
  return lay;
}

function wipeX(item, t) {
  const { w, edges } = item;
  if (t <= w.t0) return 0;
  if (t >= w.t1) return item.width;
  for (let i = 0; i < w.syl.length; i++) {
    const s = w.syl[i];
    if (t < s.t1) return edges[i] + (edges[i + 1] - edges[i]) * clamp((t - s.t0) / (s.t1 - s.t0));
  }
  return item.width;
}

function drawLine(ctx, W, H, t, L, line, cy, alpha, rise) {
  const lay = layoutLine(ctx, line, W, H);
  const { fs } = lay;
  ctx.save();
  ctx.font = `700 ${fs}px ${FONT_DISPLAY}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  lay.words.forEach((it, i) => {
    const { w } = it;
    const enter = easeOut((t - (line.t0 - LEAD_IN) - i * 0.035) / 0.45);
    const a = alpha * enter;
    if (a <= 0.001) return;
    const pop = t >= w.t0 ? Math.exp(-(t - w.t0) * 7) : 0;
    const active = t >= w.t0 && t < w.t1 + 0.05;
    const s = 1 + 0.13 * pop;
    const x = it.x + it.width / 2, y = cy + it.y + (1 - enter) * fs * 0.5 - rise - pop * fs * 0.1;
    ctx.save();
    ctx.translate(W / 2 + x, y);
    ctx.scale(s, s);
    ctx.translate(-it.width / 2, 0);
    ctx.globalAlpha = a;
    // unsung
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, fs * 0.022);
    ctx.strokeStyle = rgb(L.ink, 0.5);
    ctx.fillStyle = rgb(L.ink, 0.16);
    ctx.fillText(w.text, 0, 0);
    ctx.strokeText(w.text, 0, 0);
    // sung: clip to the wipe
    const wx = wipeX(it, t);
    if (wx > 0) {
      ctx.save();
      ctx.beginPath(); ctx.rect(-fs * 0.1, -fs, wx + fs * 0.1, fs * 2); ctx.clip();
      // gradient spans the frame, expressed in this word's local coordinates
      const left = W / 2 + it.x;
      const grad = ctx.createLinearGradient(W * 0.1 - left, 0, W * 0.9 - left, 0);
      grad.addColorStop(0, rgb(L.accent)); grad.addColorStop(1, rgb(L.accent2));
      if (active || w.accent) { ctx.shadowColor = rgb(L.accent2, 0.9); ctx.shadowBlur = fs * (0.25 + 0.35 * pop); }
      ctx.fillStyle = grad;
      ctx.fillText(w.text, 0, 0);
      ctx.shadowBlur = 0;
      ctx.fillStyle = rgb([255, 255, 255], 0.55 * pop);
      ctx.fillText(w.text, 0, 0);
      ctx.restore();
      // wipe cursor
      if (active && wx < it.width) {
        ctx.fillStyle = rgb([255, 255, 255], 0.9);
        ctx.fillRect(wx - fs * 0.012, -fs * 0.42, fs * 0.024, fs * 0.84);
      }
    }
    ctx.restore();
  });
  ctx.restore();
}

function drawKaraoke(ctx, W, H, t, L) {
  const lines = SONG.lines;
  const cy = H * 0.5;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const tIn = line.t0 - LEAD_IN, tOut = line.t1 + HOLD;
    if (t < tIn - 3 || t > tOut + LEAD_OUT) continue;
    const next = lines[i + 1];
    // exit early if the next line is entering sooner than our own hold ends
    const exitAt = next ? Math.min(tOut, next.t0 - LEAD_IN) : tOut;
    if (t >= tIn && t <= exitAt + LEAD_OUT) {
      const out = easeOut((t - exitAt) / LEAD_OUT);
      drawLine(ctx, W, H, t, L, line, cy, 1 - out, out * H * 0.09);
    }
    // preview of the upcoming line, fading out as it enters for real
    if (t < tIn && t >= tIn - 3 && (i === 0 || t > lines[i - 1].t0)) {
      const a = smooth(tIn - 3, tIn - 2.2, t) * (1 - smooth(tIn - 0.5, tIn, t)) * 0.4;
      if (a > 0.001) {
        const lay = layoutLine(ctx, line, W, H);
        ctx.save();
        ctx.font = `700 ${Math.round(lay.fs * 0.42)}px ${FONT_DISPLAY}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = rgb(L.ink, a);
        ctx.fillText(line.words.map(w => w.text).join(' '), W / 2, H * 0.8);
        ctx.restore();
      }
    }
  }
}

// ---------------------------------------------------------------- titles & HUD
function drawTitle(ctx, W, H, t, L) {
  const intro = SONG.sections[0];
  if (t > intro.t1 + 0.5) return;
  const title = SONG.title.toUpperCase();
  const fs = Math.round(H * 0.13);
  ctx.save();
  ctx.font = `700 ${fs}px ${FONT_DISPLAY}`;
  ctx.textBaseline = 'middle';
  const fadeOut = 1 - smooth(intro.t1 - 1.2, intro.t1, t);
  // letters land on successive eighth notes from beat 2
  const widths = [...title].map(c => ctx.measureText(c).width);
  let x = W / 2 - widths.reduce((a, b) => a + b, 0) / 2;
  [...title].forEach((c, i) => {
    const land = SONG.spb * (2 + i * 0.5);
    const k = easeOut((t - land) / 0.35);
    if (k > 0) {
      ctx.fillStyle = rgb(i % 2 ? L.accent2 : L.ink, k * fadeOut);
      ctx.fillText(c, x, H * 0.45 - (1 - k) * H * 0.12);
    }
    x += widths[i];
  });
  ctx.font = `500 ${Math.round(H * 0.026)}px ${FONT_MONO}`;
  ctx.textAlign = 'center';
  ctx.fillStyle = rgb(L.ink, 0.7 * smooth(SONG.spb * 9, SONG.spb * 11, t) * fadeOut);
  ctx.fillText('every frame is f(t)', W / 2, H * 0.58);
  ctx.restore();
}

function drawOutro(ctx, W, H, t, L) {
  const tEnd = SONG.lines[SONG.lines.length - 1].t1 + 1;
  if (t < tEnd) return;
  const a = smooth(tEnd, tEnd + 1.2, t);
  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `500 ${Math.round(H * 0.026)}px ${FONT_MONO}`;
  ctx.fillStyle = rgb(L.ink, 0.75 * a);
  ctx.fillText('rendered, not recorded', W / 2, H * 0.52);
  ctx.restore();
}

function drawHUD(ctx, W, H, t, L) {
  const beat = Math.max(0, t) / SONG.spb;
  const bar = Math.floor(beat / 4) + 1, bb = Math.floor(beat % 4) + 1;
  ctx.save();
  ctx.font = `500 ${Math.round(H * 0.018)}px ${FONT_MONO}`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = rgb(L.ink, 0.45);
  const pad = H * 0.035;
  ctx.fillText(`t=${t.toFixed(3)}s`, pad, pad);
  ctx.textAlign = 'right';
  ctx.fillText(`${L.section.name.toUpperCase()}  ${String(bar).padStart(2, '0')}.${bb}`, W - pad, pad);
  ctx.restore();
}

// Film grain: one seeded noise tile, offset by a hash of the 24 fps grain frame.
const grainCache = new WeakMap();
function grainPattern(ctx) {
  let p = grainCache.get(ctx);
  if (p) return p;
  const S = 256, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d'), img = g.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const v = hash(i, 99) * 255 | 0;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  p = ctx.createPattern(c, 'repeat');
  grainCache.set(ctx, p);
  return p;
}

function drawFinish(ctx, W, H, t, L) {
  // snare / crash flashes
  const flash = 0.05 * decay(SONG.drums.snare, t, 14) * L.energy + 0.22 * decay(SONG.drums.crash, t, 3.5);
  if (flash > 0.002) { ctx.fillStyle = rgb([255, 255, 255], flash); ctx.fillRect(0, 0, W, H); }
  // vignette
  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.6);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
  // grain
  const gf = Math.floor(t * 24);
  ctx.save();
  ctx.globalAlpha = 0.045;
  ctx.globalCompositeOperation = 'overlay';
  ctx.translate(-hash(gf, 11) * 256, -hash(gf, 12) * 256);
  ctx.fillStyle = grainPattern(ctx);
  ctx.fillRect(0, 0, W + 256, H + 256);
  ctx.restore();
  // fade in / out
  const fade = Math.max(1 - smooth(0, 0.8, t), smooth(SONG.duration - 2, SONG.duration - 0.2, t));
  if (fade > 0) { ctx.fillStyle = `rgba(0,0,0,${fade})`; ctx.fillRect(0, 0, W, H); }
}

// ---------------------------------------------------------------- entry point
export function renderFrame(ctx, t) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const L = lookAt(t);
  const kick = decay(SONG.drums.kick, t, 7);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.shadowBlur = 0;
  drawBackground(ctx, W, H, L, kick);
  drawRays(ctx, W, H, t, L, kick);
  drawRings(ctx, W, H, t, L);
  drawStars(ctx, W, H, t, L, kick);
  drawRibbons(ctx, W, H, t, L);
  drawHeroWord(ctx, W, H, t, L);
  drawTitle(ctx, W, H, t, L);
  drawKaraoke(ctx, W, H, t, L);
  drawOutro(ctx, W, H, t, L);
  drawHUD(ctx, W, H, t, L);
  drawFinish(ctx, W, H, t, L);
  ctx.restore();
}
