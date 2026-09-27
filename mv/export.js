// Offline export: step song time t = i / fps, draw with the same renderFrame
// on the same canvas the preview uses, and encode with WebCodecs. No realtime
// clock is involved, so dropped frames are impossible and the result does not
// depend on how fast the machine is.

import { renderFrame } from './render.js';
import { muxWebM, opusHead } from './webm.js';

const VIDEO_CODECS = [
  { webcodecs: 'vp09.00.40.08', mkv: 'V_VP9' },
  { webcodecs: 'vp8', mkv: 'V_VP8' },
];

export function canExport() {
  return typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined';
}

async function pickVideoCodec(width, height, fps, bitrate) {
  for (const c of VIDEO_CODECS) {
    const config = { codec: c.webcodecs, width, height, bitrate, framerate: fps, latencyMode: 'quality' };
    try { if ((await VideoEncoder.isConfigSupported(config)).supported) return { ...c, config }; } catch {}
  }
  throw new Error('No supported VP9/VP8 encoder in this browser');
}

/**
 * @param canvas   the canvas to render into (its size is the video size)
 * @param audio    { sampleRate, left, right } from synthesize()
 * @param duration seconds
 */
export async function exportWebM({ canvas, audio, duration, fps = 30, bitrate,
                                   onProgress = () => {}, signal } = {}) {
  const { width, height } = canvas;
  const ctx = canvas.getContext('2d');
  bitrate ??= Math.round(width * height * fps * 0.15);   // ≈4 Mbps at 720p30
  const vc = await pickVideoCodec(width, height, fps, bitrate);

  // ---- audio first (fast), fed as planar f32 in 0.5 s slices
  const audioChunks = [];
  let audioDesc = null, audioErr = null;
  const aenc = new AudioEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
      audioChunks.push({ timestamp: chunk.timestamp, data });
      const d = meta?.decoderConfig?.description;
      if (d && !audioDesc) audioDesc = ArrayBuffer.isView(d)
        ? new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength))
        : new Uint8Array(d.slice(0));
    },
    error: e => { audioErr = e; },
  });
  aenc.configure({ codec: 'opus', sampleRate: audio.sampleRate, numberOfChannels: 2, bitrate: 192000 });
  const nAudio = Math.min(audio.left.length, Math.round(duration * audio.sampleRate));
  const slice = audio.sampleRate / 2;
  for (let i = 0; i < nAudio; i += slice) {
    const n = Math.min(slice, nAudio - i), buf = new Float32Array(n * 2);
    buf.set(audio.left.subarray(i, i + n), 0); buf.set(audio.right.subarray(i, i + n), n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: audio.sampleRate, numberOfFrames: n,
      numberOfChannels: 2, timestamp: Math.round(i / audio.sampleRate * 1e6), data: buf });
    aenc.encode(ad); ad.close();
  }
  await aenc.flush(); aenc.close();
  if (audioErr) throw audioErr;

  // ---- video: one renderFrame per output frame
  const videoChunks = [];
  let videoErr = null;
  const venc = new VideoEncoder({
    output: chunk => {
      const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
      videoChunks.push({ timestamp: chunk.timestamp, key: chunk.type === 'key', data });
    },
    error: e => { videoErr = e; },
  });
  venc.configure(vc.config);
  const frames = Math.round(duration * fps);
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    if (signal?.aborted) { venc.close(); throw new DOMException('Export cancelled', 'AbortError'); }
    if (videoErr) throw videoErr;
    const t = i / fps;
    renderFrame(ctx, t);
    const frame = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
    venc.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();
    while (venc.encodeQueueSize > 6) await new Promise(r => venc.addEventListener('dequeue', r, { once: true }));
    if (i % 10 === 0) {
      onProgress({ frame: i, frames, t, elapsed: (performance.now() - t0) / 1000 });
      await new Promise(r => setTimeout(r, 0));
    }
  }
  await venc.flush(); venc.close();
  if (videoErr) throw videoErr;
  onProgress({ frame: frames, frames, t: duration, elapsed: (performance.now() - t0) / 1000 });

  return muxWebM({
    video: { codecId: vc.mkv, width, height, fps, chunks: videoChunks },
    audio: { codecPrivate: audioDesc?.length >= 19 ? audioDesc : opusHead(2, audio.sampleRate),
             sampleRate: audio.sampleRate, channels: 2, chunks: audioChunks },
    durationSec: frames / fps,
  });
}
