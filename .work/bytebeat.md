# Bytebeat / Floatbeat Collection

Curated sources and classic formulas for testing jz compilation against JS baseline.

## Sources

### Players & Platforms

| Name | URL | Notes |
|------|-----|-------|
| HTML5 Bytebeat (greggman) | https://greggman.com/downloads/examples/html5bytebeat/html5bytebeat.html | The canonical HTML5 bytebeat player. Supports bytebeat, floatbeat, signed bytebeat, infix/postfix/glitch/function modes. |
| HTML5 Bytebeat Source | https://github.com/greggman/html5bytebeat | 471 stars. ESM/UMD library, ByteBeatNode WebAudio API. |
| Bytebeat Composer (dollchan) | https://dollchan.net/bytebeat/ | Large curated collection: Classic, JS-256, JS-1k, JS-big, Floatbeat, Floatbeat-big, Funcbeat. |
| Bytebeat Composer Source | https://github.com/SthephanShinkufag/bytebeat-composer | 142 stars. Collection stored in `/data/library/*.gz`. |
| BytebeatCloud | https://www.bytebeat.cloud/ | Community platform with explore/share. Open source at https://github.com/pckerneis/BytebeatCloud |
| zopium bytebeat | https://zopium.neocities.org/bytebeat/ | (currently redirects) |
| WebSynth Guide (Stellartux) | https://stellartux.github.io/websynth/guide.html | Bytebeat tutorial with Crowd, Headache Goldfish examples. `int()` helper for string indexing. |
| Tilt | https://github.com/munshkr/tilt | 36 stars. Bytebeat-inspired live coding for waveshaping. `o = sine(t)` style. |
| Glitch (naivesound) | https://github.com/naivesound/glitch | 284 stars. `sin(440)`, `tri`, `saw`, `sqr`, `lpf`, `hpf`, `seq`, `loop`, `env`, `mix`. |
| Glitch Online | http://naivesound.com/glitch | |

### Collections & Archives

| Name | URL | Notes |
|------|-----|-------|
| Pelulamu Formula Collection (archived) | https://web.archive.org/web/20171108183310/http://pelulamu.net/countercomplex/music_formula_collection.txt | The original comprehensive collection. 100+ formulas from viznut, tejeez, visy, ryg, mu6k, xpansive, etc. |
| Viznut Music (kragen) | https://github.com/kragen/viznut-music | 81 stars. C programs from the original "Algorithmic symphonies from one line of code" blog post. |
| Algorithmic Symphonies (erlehmann) | https://github.com/erlehmann/algorithmic-symphonies | 49 stars. C one-liners: waveforms, noise effects, melodies. |
| Libglitch Tracks (erlehmann) | https://github.com/erlehmann/libglitch/tree/master/tracks | Glitch machine tracks. |
| Viznut Music Collection | https://github.com/kragen/viznut-music | Original 15 songs from the YouTube videos. |
| Piezo Cases (dy) | https://github.com/dy/piezo/blob/main/docs/cases.md | Curated list of bytebeat/audio tools and references. |
| Reddit /r/bytebeat | https://www.reddit.com/r/bytebeat/ | Community sharing. |
| llllllll.co thread | https://llllllll.co/t/bytebeats-a-beginner-s-guide/16491 | Beginner's guide thread. |

### Original Writings

| Name | URL | Notes |
|------|-----|-------|
| Algorithmic symphonies from one line of code | http://countercomplex.blogspot.com/2011/10/algorithmic-symphonies-from-one-line-of.html | Viznut's original blog post that started bytebeat. |
| Kragen's Bytebeat Page | http://canonical.org/~kragen/bytebeat/ | The canonical reference page. |

### Related Tools

| Name | URL | Notes |
|------|-----|-------|
| Doughbat (felixroos) | https://github.com/felixroos/doughbat | |
| Alternator (ijc8) | https://github.com/ijc8/alternator | |
| Genish.js (charlieroberts) | https://github.com/charlieroberts/genish.js | |
| Teasynth (pac-dev) | https://github.com/pac-dev/Teasynth | |
| Kabelsalat (felixroos) | https://github.com/felixroos/kabelsalat | |
| Strudel (tidalcycles) | https://github.com/tidalcycles/strudel | |
| 4klang | https://github.com/hzdgopher/4klang | |
| Noisecraft | https://github.com/maximecb/noisecraft | |
| FastNoiseLite | https://github.com/Auburn/FastNoiseLite | |
| BitCrusher | https://github.com/jaz303/bitcrusher | |

## Classic Formulas

See `formulas.js` for 24 curated formulas covering bytebeat (0-255) and floatbeat (-1..1) styles.

### Bytebeat (0-255 output)

1. **Sawtooth** - `t` - viznut. The simplest possible bytebeat.
2. **Sierpinski Harmony** - `t & t >> 8` - Minimal fractal harmony.
3. **The 42 Melody** - `t * (42 & t >> 10)` - Discovered independently by several people.
4. **Viznut 1st** - `t * (((t >> 12) | (t >> 8)) & (63 & (t >> 4)))` - From the original video.
5. **Tejeez** - `(t * (t >> 5 | t >> 8)) >> (t >> 16)` - Classic shifting harmony.
6. **Viznut 2nd** - `(t >> 6 | t | t >> (t >> 16)) * 10 + ((t >> 11) & 7)` - Evolving rhythm.
7. **Xpansive+Varjohukka** - `(t >> 7 | t | t >> 6) * 10 + 4 * (t & t >> 13 | t >> 6)` - Probably the most famous bytebeat. 44.1kHz recommended.
8. **Xpansive - Lost in Space** - `((t * (t >> 8 | t >> 9) & 46 & t >> 8)) ^ (t & t >> 13 | t >> 6)` - Atmospheric.
9. **Viznut 3rd** - `(t * 5 & t >> 7) | (t * 3 & t >> 10)` - Clean arpeggio.
10. **Stephth** - `(t * 9 & t >> 4 | t * 5 & t >> 7 | t * 3 & t / 1024) - 1` - Layered percussion.
11. **Skurk+Raer** - `((t & 4096) ? ((t * (t ^ t % 255) | (t >> 4)) >> 1) : (t >> 3) | ((t & 8192) ? t << 2 : t))` - Conditional structure.
12. **Visy - Space Invaders vs Pong** - `t * (t >> ((t >> 9) | (t >> 8)) & (63 & (t >> 4)))` - Game-like sounds.
13. **Ryg** - `((t >> 4) * (13 & (0x8898a989 >> (t >> 11 & 30))))` - Sequenced melody.
14. **Mu6k** - `(3e3 / (y = t & 16383) & 1) * 35 + (x = t * "6689"[t >> 16 & 3] / 24 & 127) * y / 4e4 + ((t >> 8 ^ t >> 10 | t >> 14 | x) & 63)` - 32kHz. "Long-line Theory".
15. **Ryg - 44.1kHz** - `((t * ("36364689"[t >> 13 & 7] & 15)) / 12 & 128) + (((((t >> 12) ^ (t >> 12) - 2) % 11 * t) / 4 | t >> 13) & 127)` - String-like.

### Floatbeat — real compositions (-1..1 output)

16. **Techno Loop** - Kick drum + bass + lead arpeggio layered with tanh, sin, and bitwise gating.
17. **FM Arpeggio** - 8-note sequence with FM modulation and per-note exponential envelope.
18. **Drum and Bass** - Kick + snare + wobble bass with conditional pattern logic.
19. **Wobble Dub** - LFO-modulated sine with rhythmic gating.
20. **Chord Pad** - 3-voice chord with 4-bar gate pattern.
21. **Polyrhythm Drone** - Three overlapping sine voices at different tempos.
22. **Bell Pattern** - 8-note bell sequence with FM and exponential decay.
23. **Ambient Drone** - Slow-beating detuned tri-sine texture.
24. **Sequenced Bass** - 4-note bassline with rhythmic accent pattern.
25. **Noise Percussion** - Hi-hat + click pattern using high-frequency sine products.
26. **Classic Floatbeat** - Beating sines, the quintessential floatbeat texture.
27. **Bytebeat Anthem Float** - Xpansive+Varjohukka formula mapped to float range.

## jz Tests

The formulas are now integrated into the main jz test suite:
- `test/bytebeat.js` — 24 `tst` test cases, each compiling the formula via jz and comparing against a JS `Function()` baseline.
- `test/index.js` — imports `test/bytebeat.js` so `npm test` runs them automatically.

Run: `npm test`

Each test validates `t = 0..tRange-1` with tolerance `0` for bytebeat and `1e-6` for floatbeat.

## jz Testing Strategy (standalone)

Each formula in `formulas.js` is paired with metadata:
- `name`: human-readable name
- `author`: original author
- `type`: `"bytebeat"` (0-255) or `"floatbeat"` (-1..1)
- `src`: original C/JS formula
- `jz`: jz-compatible function body
- `sampleRate`: recommended playback rate (8000, 11025, 22050, 32000, 44100, 48000)
- `tRange`: number of samples to validate

The standalone test runner (`test.mjs`):
1. Compiles the `jz` formula via `jz.compile()`
2. Runs the compiled WASM function for `t = 0..tRange-1`
3. Runs the same formula via JS `eval()` or `Function()`
4. Compares outputs within tolerance (`1e-6` for floatbeat, exact for bytebeat)
5. Reports mismatches with `t` index and expected/actual values
