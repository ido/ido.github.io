// Minimal WebM (Matroska) muxer for WebCodecs output: one video track
// (VP8/VP9) + one Opus audio track, with Duration and Cues so players can seek.
// Everything is known up front, so every element is written with an exact
// 8-byte size — no back-patching.

const enc = new TextEncoder();

function idBytes(id) {
  const out = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return new Uint8Array(out);
}
function size8(n) {
  const b = new Uint8Array(8);
  b[0] = 0x01;
  for (let i = 7, v = n; i >= 1; i--, v = Math.floor(v / 256)) b[i] = v % 256;
  return b;
}
function uint(n, bytes = 0) {
  const out = [];
  for (let v = n; v > 0 || out.length === 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  while (out.length < bytes) out.unshift(0);
  return new Uint8Array(out);
}
function f64(x) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, x); return b; }

// A node is { size, parts } so large payloads are never copied until the Blob.
function el(id, children) {
  const kids = children instanceof Uint8Array ? [{ size: children.length, parts: [children] }]
    : typeof children === 'string' ? [{ size: enc.encode(children).length, parts: [enc.encode(children)] }]
    : children;
  const size = kids.reduce((s, k) => s + k.size, 0);
  const head = idBytes(id), sz = size8(size);
  return { size: head.length + sz.length + size, parts: [head, sz, ...kids.flatMap(k => k.parts)] };
}

export function opusHead(channels, sampleRate, preSkip = 312) {
  const b = new Uint8Array(19), v = new DataView(b.buffer);
  b.set(enc.encode('OpusHead'));
  b[8] = 1; b[9] = channels;
  v.setUint16(10, preSkip, true); v.setUint32(12, sampleRate, true); v.setInt16(16, 0, true); b[18] = 0;
  return b;
}

/**
 * @param video {codecId:'V_VP9'|'V_VP8', width, height, fps, chunks:[{timestamp(µs), key, data:Uint8Array}]}
 * @param audio {codecPrivate:Uint8Array, sampleRate, channels, chunks:[...]} | null
 * @param durationSec total duration
 */
export function muxWebM({ video, audio, durationSec }) {
  const header = el(0x1A45DFA3, [
    el(0x4286, uint(1)), el(0x42F7, uint(1)), el(0x42F2, uint(4)), el(0x42F3, uint(8)),
    el(0x4282, 'webm'), el(0x4287, uint(4)), el(0x4285, uint(2)),
  ]);
  const info = el(0x1549A966, [
    el(0x2AD7B1, uint(1000000)),                     // TimecodeScale: 1 ms
    el(0x4D80, 'mv/webm.js'), el(0x5741, 'mv/webm.js'),
    el(0x4489, f64(durationSec * 1000)),
  ]);
  const tracks = [el(0xAE, [
    el(0xD7, uint(1)), el(0x73C5, uint(1)), el(0x83, uint(1)), el(0x86, video.codecId),
    el(0x23E383, uint(Math.round(1e9 / video.fps))),
    el(0xE0, [el(0xB0, uint(video.width)), el(0xBA, uint(video.height))]),
  ])];
  let preSkipNs = 0;
  if (audio) {
    preSkipNs = Math.round(new DataView(audio.codecPrivate.buffer, audio.codecPrivate.byteOffset).getUint16(10, true) / 48000 * 1e9);
    tracks.push(el(0xAE, [
      el(0xD7, uint(2)), el(0x73C5, uint(2)), el(0x83, uint(2)), el(0x86, 'A_OPUS'),
      el(0x63A2, audio.codecPrivate), el(0x56AA, uint(preSkipNs)), el(0x56BB, uint(80000000)),
      el(0xE1, [el(0xB5, f64(audio.sampleRate)), el(0x9F, uint(audio.channels))]),
    ]));
  }
  const tracksEl = el(0x1654AE6B, tracks);

  // Interleave by timestamp; a new cluster starts at every video keyframe.
  const blocks = [
    ...video.chunks.map(c => ({ ...c, track: 1 })),
    ...(audio ? audio.chunks.map(c => ({ ...c, track: 2, key: true })) : []),
  ].sort((a, b) => a.timestamp - b.timestamp || a.track - b.track);
  const clusters = [];
  let cur = null;
  for (const b of blocks) {
    const ms = Math.round(b.timestamp / 1000);
    if (!cur || (b.track === 1 && b.key) || ms - cur.ms > 30000) {
      cur = { ms, blocks: [], cue: b.track === 1 && b.key };
      clusters.push(cur);
    }
    const head = new Uint8Array(4);
    head[0] = 0x80 | b.track;
    new DataView(head.buffer).setInt16(1, ms - cur.ms);
    head[3] = b.key ? 0x80 : 0;
    cur.blocks.push(el(0xA3, [{ size: 4, parts: [head] }, { size: b.data.length, parts: [b.data] }]));
  }
  const clusterEls = clusters.map(c => el(0x1F43B675, [el(0xE7, uint(c.ms)), ...c.blocks]));

  // Cues sit before the clusters; fixed-width fields make their size
  // independent of the positions they contain.
  const cueFor = pos => el(0x1C53BB6B, clusters.flatMap((c, i) => c.cue ? [el(0xBB, [
    el(0xB3, uint(c.ms, 8)),
    el(0xB7, [el(0xF7, uint(1)), el(0xF1, uint(pos[i], 8))]),
  ])] : []));
  const cuesSize = cueFor(clusters.map(() => 0)).size;
  const positions = [];
  let off = info.size + tracksEl.size + cuesSize;
  for (const c of clusterEls) { positions.push(off); off += c.size; }
  const segment = el(0x18538067, [info, tracksEl, cueFor(positions), ...clusterEls]);
  return new Blob([...header.parts, ...segment.parts], { type: 'video/webm' });
}
