// Offline synthesizer: the whole song is computed sample-by-sample in plain JS
// from SONG. No Web Audio graph, no Math.random — the same score always yields
// the same Float32Arrays, which are both what the preview plays and what the
// exporter encodes.

export const SAMPLE_RATE = 48000;   // Opus in WebM wants 48 kHz

const TAU = Math.PI * 2;
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

function rng(seed) {                 // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

function onePoleCoef(fc) { return 1 - Math.exp(-TAU * fc / SAMPLE_RATE); }

function bandpass(fc, q) {           // RBJ, 0 dB peak gain
  const w = TAU * fc / SAMPLE_RATE, al = Math.sin(w) / (2 * q), a0 = 1 + al;
  return { b0: al / a0, b2: -al / a0, a1: -2 * Math.cos(w) / a0, a2: (1 - al) / a0 };
}

const VOWELS = {                     // rough formants (F1, F2)
  a: [800, 1200], e: [500, 1750], i: [320, 2300], o: [500, 900], u: [350, 800], y: [320, 2300],
};
function formantsFor(text) {
  const v = /[aeiouy]/i.exec(text);
  return VOWELS[v ? v[0].toLowerCase() : 'a'];
}

export async function synthesize(song, onProgress = () => {}) {
  const N = Math.ceil(song.duration * SAMPLE_RATE);
  const L = new Float32Array(N), R = new Float32Array(N);
  const bus = { drums: [new Float32Array(N), new Float32Array(N)],
                music: [new Float32Array(N), new Float32Array(N)],   // ducked by the kick
                lead:  [new Float32Array(N), new Float32Array(N)] };
  const idx = t => Math.round(t * SAMPLE_RATE);
  const yieldUI = () => new Promise(r => setTimeout(r, 0));
  const { drums, spb } = song;
  let seed = 1;

  // --- kick
  for (const t0 of drums.kick) {
    const s0 = idx(t0), n = Math.min(idx(0.5), N - s0);
    let ph = 0;
    const noise = rng(seed++);
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      ph += TAU * (44 + 90 * Math.exp(-t * 32)) / SAMPLE_RATE;
      const v = Math.sin(ph) * Math.exp(-t * 6.5) * 0.95 + noise() * Math.exp(-t * 350) * 0.25;
      bus.drums[0][s0 + i] += v; bus.drums[1][s0 + i] += v;
    }
  }
  // --- snare
  for (const t0 of drums.snare) {
    const s0 = idx(t0), n = Math.min(idx(0.3), N - s0);
    const noise = rng(seed++);
    let prev = 0, lp = 0;
    const c = onePoleCoef(6000);
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      const x = noise(), hp = x - prev; prev = x;
      lp += c * (hp - lp);
      const v = lp * Math.exp(-t * 16) * 0.5 + Math.sin(TAU * 185 * t) * Math.exp(-t * 28) * 0.35;
      bus.drums[0][s0 + i] += v * 0.95; bus.drums[1][s0 + i] += v;
    }
  }
  // --- hats (closed + open)
  const hat = (list, len, decay, gain) => {
    list.forEach((t0, k) => {
      const s0 = idx(t0), n = Math.min(idx(len), N - s0);
      const noise = rng(seed++);
      let p1 = 0, p2 = 0;
      const pan = k % 2 ? 0.35 : -0.35;
      for (let i = 0; i < n; i++) {
        const x = noise(), d1 = x - p1; p1 = x; const d2 = d1 - p2; p2 = d1;
        const v = d2 * Math.exp(-i / SAMPLE_RATE * decay) * gain;
        bus.drums[0][s0 + i] += v * (1 - pan); bus.drums[1][s0 + i] += v * (1 + pan);
      }
    });
  };
  hat(drums.hat, 0.08, 55, 0.06);
  hat(drums.openHat, 0.35, 11, 0.05);
  // --- crash
  for (const t0 of drums.crash) {
    const s0 = idx(t0), n = Math.min(idx(2.6), N - s0);
    const nl = rng(seed++), nr = rng(seed++);
    let pl = 0, pr = 0;
    for (let i = 0; i < n; i++) {
      const e = Math.exp(-i / SAMPLE_RATE * 2.2) * 0.09;
      const a = nl(), b = nr();
      bus.drums[0][s0 + i] += (a - pl) * e; bus.drums[1][s0 + i] += (b - pr) * e;
      pl = a; pr = b;
    }
  }
  onProgress(0.2); await yieldUI();

  // --- bass: 8ths on the chord root, whole notes in sparse sections
  for (const ch of song.chords) {
    const sparse = ch.section === 'intro' || ch.section === 'bridge';
    const step = sparse ? 4 : 0.5;
    const base = mtof(ch.midis[0] - 24);
    for (let b = 0; b < 4; b += step) {
      const octave = !sparse && ch.section === 'chorus' && (b * 2) % 4 === 3 ? 2 : 1;
      const f = base * octave;
      const s0 = idx(ch.t0 + b * spb), dur = step * spb, n = Math.min(idx(dur + 0.03), N - s0);
      let ph = 0, lp = 0, lp2 = 0;
      const c = onePoleCoef(sparse ? 260 : 520);
      for (let i = 0; i < n; i++) {
        const t = i / SAMPLE_RATE;
        ph += f / SAMPLE_RATE; ph -= Math.floor(ph);
        const saw = 2 * ph - 1;
        lp += c * (saw - lp); lp2 += c * (lp - lp2);
        const env = Math.min(1, t / 0.004) * (0.65 + 0.35 * Math.exp(-t * 9)) * Math.min(1, Math.max(0, (dur + 0.03 - t) / 0.03));
        const v = (lp2 * 0.55 + Math.sin(TAU * ph) * 0.35) * env * 0.42;
        bus.music[0][s0 + i] += v; bus.music[1][s0 + i] += v;
      }
    }
  }
  onProgress(0.35); await yieldUI();

  // --- pad: detuned saws per chord tone, stereo-spread
  const padCut = { intro: 700, verse: 1100, chorus: 2200, bridge: 600, outro: 800 };
  for (const [ci, ch] of song.chords.entries()) {
    const rel = 0.6, n0 = idx(ch.t0), n = Math.min(idx(ch.t1 - ch.t0 + rel), N - n0);
    const c = onePoleCoef(padCut[ch.section]);
    const len = ch.t1 - ch.t0;
    for (const [k, m] of [...ch.midis, ch.midis[0] + 12].entries()) {
      for (const [side, det] of [[0, -0.09], [1, 0.08]]) {
        const f = mtof(m + det);
        let ph = (ci * 0.37 + k * 0.21 + side * 0.5) % 1, a = 0, b = 0;
        const out = bus.music[side];
        for (let i = 0; i < n; i++) {
          const t = i / SAMPLE_RATE;
          ph += f / SAMPLE_RATE; ph -= Math.floor(ph);
          a += c * ((2 * ph - 1) - a); b += c * (a - b);
          const env = Math.min(1, t / 0.25) * (t > len ? Math.max(0, 1 - (t - len) / rel) : 1);
          out[n0 + i] += b * env * 0.055;
        }
      }
    }
    if (ci % 8 === 7) { onProgress(0.35 + 0.35 * ci / song.chords.length); await yieldUI(); }
  }

  // --- lead "voice": saw through two formant filters, with vibrato
  for (const [ni, note] of song.notes.entries()) {
    const dur = note.t1 - note.t0, rel = 0.08;
    const s0 = idx(note.t0), n = Math.min(idx(dur + rel), N - s0);
    const f0 = mtof(note.midi);
    const [F1, F2] = formantsFor(note.text);
    const bp1 = bandpass(F1, 6), bp2 = bandpass(F2, 9);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, z1 = 0, z2 = 0;
    let ph = 0;
    const noise = rng(1000 + ni);
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      const vib = 1 + 0.012 * Math.min(1, Math.max(0, (t - 0.18) / 0.25)) * Math.sin(TAU * 5.4 * t);
      ph += f0 * vib / SAMPLE_RATE; ph -= Math.floor(ph);
      const x = (2 * ph - 1) + noise() * 0.6 * Math.exp(-t * 90);   // breathy consonant onset
      const y = bp1.b0 * x + bp1.b2 * x2 - bp1.a1 * y1 - bp1.a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y;
      const z = bp2.b0 * x + bp2.b2 * u2 - bp2.a1 * z1 - bp2.a2 * z2; u2 = u1; u1 = x; z2 = z1; z1 = z;
      const env = Math.min(1, t / 0.02) * (t > dur ? Math.max(0, 1 - (t - dur) / rel) : 1);
      const v = (y * 0.9 + z * 0.55 + (2 * ph - 1) * 0.06) * env * 0.3;
      bus.lead[0][s0 + i] += v; bus.lead[1][s0 + i] += v;
    }
  }
  // ping-pong delay, dotted eighth
  {
    const d = idx(spb * 0.75), fb = 0.38, wet = 0.22;
    const [l, r] = bus.lead;
    const dl = new Float32Array(N), dr = new Float32Array(N);
    for (let i = d; i < N; i++) {
      dl[i] = (l[i - d] + r[i - d]) * 0.5 + dr[i - d] * fb;
      dr[i] = dl[i - d] * fb;
    }
    for (let i = 0; i < N; i++) { l[i] += dl[i] * wet; r[i] += dr[i] * wet; }
  }
  onProgress(0.85); await yieldUI();

  // --- mix: sidechain the music bus to the kick, soft-clip, normalize
  const kicks = drums.kick;
  let ki = -1;
  for (let i = 0; i < N; i++) {
    const t = i / SAMPLE_RATE;
    while (ki + 1 < kicks.length && kicks[ki + 1] <= t) ki++;
    const duck = ki < 0 ? 1 : 1 - 0.55 * Math.exp(-(t - kicks[ki]) * 9);
    for (let s = 0; s < 2; s++) {
      const v = bus.drums[s][i] + bus.music[s][i] * duck + bus.lead[s][i];
      (s ? R : L)[i] = Math.tanh(v * 1.1);
    }
  }
  let peak = 1e-9;
  for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const g = 0.89 / peak, fadeFrom = idx(song.duration - 1.5);
  for (let i = 0; i < N; i++) {
    const f = i < fadeFrom ? 1 : Math.max(0, 1 - (i - fadeFrom) / (N - fadeFrom));
    L[i] *= g * f; R[i] *= g * f;
  }
  onProgress(1);
  return { sampleRate: SAMPLE_RATE, left: L, right: R };
}

export function encodeWav({ sampleRate, left, right }) {
  const n = left.length, buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 4, true);
  v.setUint16(32, 4, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 4, true);
  for (let i = 0, o = 44; i < n; i++, o += 4) {
    v.setInt16(o, Math.max(-1, Math.min(1, left[i])) * 32767, true);
    v.setInt16(o + 2, Math.max(-1, Math.min(1, right[i])) * 32767, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
