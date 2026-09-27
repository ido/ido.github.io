// The score. Everything else — audio, visuals, karaoke timing — is derived
// from this file, so lyrics can never drift from the music: a syllable's
// on-screen wipe and its sung note come from the same token.
//
// Lyric token syntax:  text:beats@degree
//   text    syllable text; a trailing "-" joins it to the next syllable (same word)
//           a leading "*" marks an accent word (drawn huge behind the lyrics)
//   beats   duration in beats
//   degree  scale degree in D natural minor (0 = D4, 7 = D5, negative = below)
//   "_:beats" is a rest. A line is 2 bars (8 beats); any remainder is rest.

export const BPM = 100;
export const SPB = 60 / BPM;            // seconds per beat
export const BEATS_PER_BAR = 4;
export const TONIC_MIDI = 62;           // D4
const SCALE = [0, 2, 3, 5, 7, 8, 10];   // natural minor

// Chord roots as scale degrees: 0=Dm 2=F 3=Gm 5=Bb 6=C
const SECTIONS = [
  { name: 'intro',  bars: 4, chords: [0, 5, 2, 6], lines: [] },
  { name: 'verse',  bars: 8, chords: [0, 5, 2, 6, 0, 5, 2, 6], lines: [
    '_:.5 Ev-:.5@4 ery:.5@3 frame:1@4 is:.5@3 a:.5@2 func-:.5@3 tion:.5@2 of:.5@0 *time:2.5@2',
    '_:.5 Noth-:.5@4 ing:.5@3 ran-:1@4 dom,:.5@3 ev-:.5@2 ery:.5@3 shad-:.5@4 ow:.5@3 a-:.5@2 *ligned:2@0',
    '_:.5 Re-:.5@4 wind:1@5 the:.5@4 tape:1@3 and:.5@2 the:.5@3 stars:1@4 fall:.5@3 the:.5@2 *same:1.5@0',
    'Same:1@2 lit-:.5@3 tle:.5@2 spark:1@0 in:.5@-1 the:.5@0 same:1@2 lit-:.5@3 tle:.5@2 *flame:2@0',
  ] },
  { name: 'chorus', bars: 8, chords: [5, 2, 6, 0, 5, 2, 6, 0], lines: [
    '*Play:1@7 it:.5@6 back,:1.5@4 play:1@7 it:.5@6 back:2@4',
    '_:.5 I:.5@4 will:.5@5 glow:1@7 in:.5@6 the:.5@5 ver-:.5@4 y:.5@5 same:1@4 *place:2@2',
    '*Play:1@7 it:.5@6 back,:1.5@4 play:1@7 it:.5@8 back:2@9',
    '_:.5 Ev-:.5@7 ery:.5@6 word:1@5 finds:.5@4 its:.5@5 light:1@4 on:.5@2 your:.5@1 *face:2@0',
  ] },
  { name: 'verse',  bars: 8, chords: [0, 5, 2, 6, 0, 5, 2, 6], lines: [
    '_:.5 Seed:1@4 the:.5@3 noise:1@4 and:.5@3 the:.5@2 noise:1@3 stays:.5@2 *true:2.5@0',
    '_:.5 Ev-:.5@4 ery:.5@3 col-:1@4 or:.5@3 count-:.5@2 ed,:.5@3 ev-:.5@4 ery:.5@3 *hue:2.5@0',
    '_:.5 Scrub:1@5 the:.5@4 line:1@3 and:.5@2 I\'m:.5@3 back:1@4 in:.5@3 the:.5@2 *glow:1.5@0',
    'Frame:1@2 by:.5@3 frame:1@2 is:.5@0 the:.5@-1 on-:.5@0 ly:.5@2 way:1@3 I:.5@2 *know:2@0',
  ] },
  { name: 'chorus', bars: 8, chords: [5, 2, 6, 0, 5, 2, 6, 0], lines: 'chorus' },
  { name: 'bridge', bars: 4, chords: [3, 5, 6, 6], lines: [
    '_:1 No:1@5 *drift,:2@4 no:1@3 *chance:3@2',
    '_:1 Just:1@4 time:2@5 and:.5@4 the:.5@3 *dance:3@4',
  ] },
  { name: 'chorus', bars: 8, chords: [5, 2, 6, 0, 5, 2, 6, 0], lines: 'chorus' },
  { name: 'outro',  bars: 4, chords: [0, 5, 2, 0], lines: [
    '*Play:1@7 it:.5@6 back:4.5@4',
  ] },
];

export function degreeToMidi(d) {
  const oct = Math.floor(d / 7);
  return TONIC_MIDI + 12 * oct + SCALE[((d % 7) + 7) % 7];
}

function triad(root) {
  return [root, root + 2, root + 4].map(degreeToMidi);
}

// Drum grid per section, in beats within a bar.
const DRUMS = {
  intro:  { kick: [0], snare: [], hat: [1, 2, 3], openHat: [] },
  verse:  { kick: [0, 1.5, 2.5], snare: [1, 3], hat: [0, .5, 1, 1.5, 2, 2.5, 3, 3.5], openHat: [] },
  chorus: { kick: [0, 1, 2, 3], snare: [1, 3], hat: [0, 1, 2, 3], openHat: [.5, 1.5, 2.5, 3.5] },
  bridge: { kick: [0], snare: [], hat: [], openHat: [] },
  outro:  { kick: [0, 2], snare: [], hat: [0, 1, 2, 3], openHat: [] },
};

function parseLine(src, startBeat) {
  const words = [];
  let beat = startBeat;
  let cur = null;
  for (const tok of src.trim().split(/\s+/)) {
    const m = /^(.+):([\d.]+)(?:@(-?\d+))?$/.exec(tok);
    if (!m) throw new Error(`bad lyric token "${tok}"`);
    const beats = parseFloat(m[2]);
    if (m[1] === '_') { beat += beats; continue; }
    let text = m[1];
    const accent = text.startsWith('*');
    if (accent) text = text.slice(1);
    const joins = text.endsWith('-');
    if (joins) text = text.slice(0, -1);
    const syl = {
      text, b0: beat, b1: beat + beats,
      t0: beat * SPB, t1: (beat + beats) * SPB,
      midi: degreeToMidi(parseInt(m[3], 10)),
    };
    if (!cur) { cur = { text: '', syl: [], accent: false }; words.push(cur); }
    cur.syl.push(syl);
    cur.text += text;
    cur.accent ||= accent;
    if (!joins) cur = null;
    beat += beats;
  }
  if (beat - startBeat > 8 + 1e-9) throw new Error(`line overflows 2 bars: "${src}"`);
  for (const w of words) { w.t0 = w.syl[0].t0; w.t1 = w.syl[w.syl.length - 1].t1; }
  return { words, t0: words[0].t0, t1: words[words.length - 1].t1 };
}

function build() {
  const sections = [], lines = [], chords = [], notes = [];
  const drums = { kick: [], snare: [], hat: [], openHat: [], crash: [] };
  let chorusLines = null;
  let bar = 0;
  for (const s of SECTIONS) {
    const b0 = bar * BEATS_PER_BAR, b1 = (bar + s.bars) * BEATS_PER_BAR;
    const sec = { name: s.name, index: sections.length, b0, b1, t0: b0 * SPB, t1: b1 * SPB };
    sections.push(sec);
    if (s.name === 'chorus' && !chorusLines) chorusLines = s.lines;
    const srcLines = s.lines === 'chorus' ? chorusLines : s.lines;
    srcLines.forEach((src, i) => {
      const line = parseLine(src, b0 + i * 8);
      line.section = sec.index;
      line.index = lines.length;
      lines.push(line);
      for (const w of line.words) for (const syl of w.syl) notes.push(syl);
    });
    s.chords.forEach((root, i) => {
      const cb0 = b0 + i * BEATS_PER_BAR;
      chords.push({ root, midis: triad(root), t0: cb0 * SPB, t1: (cb0 + BEATS_PER_BAR) * SPB, section: s.name });
    });
    const pat = DRUMS[s.name];
    for (let k = 0; k < s.bars; k++) {
      const bb = b0 + k * BEATS_PER_BAR;
      // outro: last bar is a single final hit
      if (s.name === 'outro' && k === s.bars - 1) { drums.kick.push(bb * SPB); drums.crash.push(bb * SPB); break; }
      // intro: hats enter on bar 3
      for (const x of pat.kick) drums.kick.push((bb + x) * SPB);
      for (const x of pat.snare) drums.snare.push((bb + x) * SPB);
      if (!(s.name === 'intro' && k < 2)) for (const x of pat.hat) drums.hat.push((bb + x) * SPB);
      for (const x of pat.openHat) drums.openHat.push((bb + x) * SPB);
    }
    // snare pickup fill into every chorus
    if (sections.length > 1 && s.name !== 'intro') {
      const prevEnd = b0 * SPB;
      if (s.name === 'chorus') for (const x of [-1, -.75, -.5, -.25]) drums.snare.push(prevEnd + x * SPB);
    }
    if (s.name === 'chorus' || s.name === 'verse' && sec.index > 1) drums.crash.push(sec.t0);
    bar += s.bars;
  }
  for (const k of Object.keys(drums)) drums[k] = [...new Set(drums[k].map(x => +x.toFixed(6)))].sort((a, b) => a - b);
  const totalBeats = bar * BEATS_PER_BAR;
  return {
    title: 'Play It Back',
    bpm: BPM, spb: SPB,
    duration: totalBeats * SPB + 2.4,   // tail for the last ring-out
    musicEnd: totalBeats * SPB,
    sections, lines, chords, notes, drums,
  };
}

export const SONG = build();

export function sectionAt(t) {
  const S = SONG.sections;
  for (let i = S.length - 1; i >= 0; i--) if (t >= S[i].t0) return S[i];
  return S[0];
}
