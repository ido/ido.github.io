# Play It Back

A generative, code-rendered music video with word-synced karaoke typography.
Open `index.html` over HTTP (e.g. `npx serve mv`), or visit `/mv/` on the site.

**Every frame is a function of song time.** `renderFrame(ctx, t)` has no state
between frames, uses no wall clock and no `Math.random`, so the live preview,
scrubbing and the offline export draw the same pixels for the same `t`.

## How it fits together

| file | role |
|---|---|
| `song.js` | The score: tempo, sections, chords, drum grid, lyrics as `syllable:beats@degree` tokens. Single source of truth. |
| `synth.js` | Renders the whole song to two `Float32Array`s in plain JS (seeded noise, no Web Audio graph). |
| `render.js` | `renderFrame(ctx, t)`: backgrounds, kick rings, warp stars, ribbons, karaoke wipe, titles. |
| `main.js` | Preview player. `t` comes from the `AudioContext` clock during playback, from the scrubber otherwise. |
| `export.js` | Steps `t = i / fps`, calls `renderFrame` on the same canvas, encodes VP9 + Opus with WebCodecs. |
| `webm.js` | Small WebM muxer (with Duration and Cues, so the file seeks). |

Lyrics can't drift from the music. Each lyric token is both the note the
synth sings and the time window the karaoke wipe sweeps. Visual accents such as
rings, flashes and the grain frame come from the score's event lists, not from
audio analysis.

Stateful-looking motion is re-derived from `t` on every frame. Star positions
come from a cached integral of section speed, trails come from sampling
parametric curves over `[t - tail, t]`, and rings come from the kicks in the
last 2.2 s.

## Export

- **In the browser:** pick a resolution and fps, then click *Export WebM*. This
  needs WebCodecs (Chrome, Edge, Safari 17+). Export is frame-stepped rather
  than screen-recorded, so it can't drop frames.
- **Headless:** `cd mv/tools && npm install && node export.cjs --res 1080 --fps 60`.
  This drives the same page in headless Chromium and writes the `.webm`.
  For reference, 720p30 runs at about 25 fps with software encoding.

## Verify

`cd mv/tools && node verify.cjs` checks three things:

1. Synthesizing the audio twice gives bit-identical samples.
2. 76 frames rendered in sequence and in shuffled order give identical pixel
   hashes, so there is no hidden state.
3. A 24 s export decodes, and each sampled decoded frame matches
   `renderFrame` at its own timestamp better than at either neighbour's
   (PSNR is about 40 dB).

## Scope of "identical"

Pixels are identical for the same browser, resolution and `t`: the preview
canvas *is* the export canvas. Different browsers or GPUs can anti-alias text
and paths slightly differently, and `Math.sin`/`Math.exp` aren't bit-specified
across JS engines. So cross-browser output matches visually, not
bit-for-bit. The fonts are self-hosted in `fonts/` (SIL OFL) so that font
loading can't make two runs differ.
