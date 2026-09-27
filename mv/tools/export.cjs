#!/usr/bin/env node
// Headless export: runs the browser's own exporter (same renderFrame, same
// canvas path, same WebCodecs encode) and writes the WebM to disk.
//   node tools/export.cjs [--res 720|1080] [--fps 30] [--duration secs] [--out file.webm]
const fs = require('fs');
const { openPlayer } = require('./harness.cjs');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) =>
  x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a, []));
const res = args.res || '720', fps = parseInt(args.fps || '30', 10);
const out = args.out || `play-it-back-${res}p${fps}.webm`;

(async () => {
  const { page, close } = await openPlayer();
  await page.exposeFunction('reportProgress', p => process.stdout.write(`\rframe ${p.frame}/${p.frames}  ${(p.frame / Math.max(p.elapsed, 1e-3)).toFixed(1)} fps   `));
  await page.evaluate(async ({ res, fps, duration }) => {
    const blob = await window.MV.exportWebM({ res, fps, duration, onProgress: p => window.reportProgress(p) });
    window.__out = new Uint8Array(await blob.arrayBuffer());
  }, { res, fps, duration: args.duration ? parseFloat(args.duration) : undefined });
  const size = await page.evaluate(() => window.__out.length);
  const fd = fs.openSync(out, 'w');
  const CH = 8 << 20;
  for (let o = 0; o < size; o += CH) {
    const b64 = await page.evaluate(([o, n]) => {
      const s = window.__out.subarray(o, o + n);
      let bin = '';
      for (let i = 0; i < s.length; i += 0x8000) bin += String.fromCharCode.apply(null, s.subarray(i, i + 0x8000));
      return btoa(bin);
    }, [o, CH]);
    fs.writeSync(fd, Buffer.from(b64, 'base64'));
  }
  fs.closeSync(fd);
  console.log(`\nwrote ${out} (${(size / 1e6).toFixed(1)} MB)`);
  await close();
})().catch(e => { console.error(e); process.exit(1); });
