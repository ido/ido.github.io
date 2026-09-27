#!/usr/bin/env node
// Determinism checks:
//   1. audio: synthesizing twice gives bit-identical samples
//   2. frames: rendering a set of times in order and in shuffled order gives
//      identical pixel hashes (i.e. renderFrame carries no hidden state)
//   3. export: decode a short exported WebM and confirm each decoded frame best
//      matches renderFrame at its own timestamp, not a neighbour's
const { openPlayer } = require('./harness.cjs');

(async () => {
  const { page, close } = await openPlayer({ query: '?res=360' });
  let failed = false;
  const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); failed ||= !ok; };

  // 1. audio
  const [a1, a2] = await page.evaluate(async () => {
    const { synthesize } = await import('./synth.js');
    const again = await synthesize(window.MV.SONG);
    const h = x => { let h = 0x811c9dc5; for (const ch of [x.left, x.right]) { const b = new Uint8Array(ch.buffer); for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); } } return (h >>> 0).toString(16); };
    return [window.MV.audioHash(), h(again).padStart(8, '0')];
  });
  check(a1 === a2, `audio synthesis is bit-identical (${a1})`);

  // 2. frames, in order vs shuffled
  const { inOrder, shuffled, times } = await page.evaluate(() => {
    const S = window.MV.SONG, times = [];
    for (const s of S.sections) times.push(s.t0, s.t0 + 0.017, (s.t0 + s.t1) / 2);
    for (const l of S.lines.slice(0, 12)) times.push(l.t0 - 0.5, l.t0 + 0.2, l.t1);
    for (let i = 0; i < 16; i++) times.push((i * 7.919) % S.duration);
    const inOrder = times.map(t => window.MV.frameHash(t));
    const order = times.map((_, i) => i).sort((a, b) => ((a * 2654435761) % 97) - ((b * 2654435761) % 97));
    const shuffled = new Array(times.length);
    for (const i of order) shuffled[i] = window.MV.frameHash(times[i]);
    return { inOrder, shuffled, times };
  });
  const mism = times.filter((_, i) => inOrder[i] !== shuffled[i]);
  check(mism.length === 0, `${times.length} frames identical in sequential vs shuffled order${mism.length ? ` (mismatch at ${mism.join(', ')})` : ''}`);
  check(new Set(inOrder).size > times.length * 0.9, `frames actually differ over time (${new Set(inOrder).size} distinct)`);

  // 3. export → decode → compare
  const res = await page.evaluate(async () => {
    const fps = 30, dur = 24;
    const blob = await window.MV.exportWebM({ res: '360', fps, duration: dur });
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.muted = true; v.src = url;
    await new Promise((r, j) => { v.onloadedmetadata = r; v.onerror = () => j(new Error('video failed to load')); });
    const W = 640, H = 360;
    const dec = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true });
    const ref = document.getElementById('stage').getContext('2d');
    const px = (c) => c.getImageData(0, 0, W, H).data;
    const mse = (a, b) => { let s = 0; for (let i = 0; i < a.length; i += 4) for (let k = 0; k < 3; k++) { const d = a[i + k] - b[i + k]; s += d * d; } return s / (a.length / 4 * 3); };
    const results = [];
    for (const i of [15, 100, 247, 400, 555, 690]) {
      v.currentTime = (i + 0.5) / fps;
      await new Promise(r => v.addEventListener('seeked', r, { once: true }));
      dec.drawImage(v, 0, 0, W, H);
      const got = px(dec);
      const errs = [-1, 0, 1].map(o => { window.MV.frameHash((i + o) / fps); return mse(got, px(ref)); });
      results.push({ i, errs });
    }
    return { size: blob.size, duration: v.duration, results };
  });
  check(Math.abs(res.duration - 24) < 0.1, `exported WebM loads, duration ${res.duration.toFixed(3)} s, ${(res.size / 1e6).toFixed(2)} MB`);
  for (const r of res.results) {
    const psnr = 10 * Math.log10(255 * 255 / r.errs[1]);
    check(r.errs[1] <= r.errs[0] && r.errs[1] <= r.errs[2] && psnr > 28,
      `decoded frame ${r.i} matches renderFrame(${r.i}/30): PSNR ${psnr.toFixed(1)} dB (MSE prev/self/next ${r.errs.map(e => e.toFixed(1)).join(' / ')})`);
  }
  await close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
