// Floatbeat jukebox — an endless procedural jazz tune. `seed` reshapes tempo, the
// root's walk around the circle of fifths, the chord colours and the timbre, so the
// loop never sounds the same twice. The synth layers a plucked walking bass, an
// FM-bell arpeggio over seventh-chord voicings, and a soft pad. Per sample it's a
// handful of independent oscillators + envelopes — jz's audio sweet spot (same source
// is the V8 baseline and the compiled wasm).
//
// `off` is the absolute sample index of the first sample, so the host streams the
// tune in gapless chunks — chunk k+1 picks up exactly where chunk k left off and the
// melody never loops. fill() returns the synthesized buffer (a view over wasm memory
// for jz); the host copies it out and rewinds the bump allocator.
let PI2 = 6.283185307179586

export let fill = (len, sr, seed, off) => {
  let b = new Float64Array(len)
  let invSr = 1.0 / sr

  // equal-tempered ratios 2^(s/12), s = 0..36 — built once so the hot loop has no pow
  let ratio = new Float64Array(37)
  let s = 0
  while (s < 37) { ratio[s] = Math.pow(2.0, s / 12.0); s++ }

  let bpm = 78 + (seed % 6) * 9                     // 78..123 BPM
  let invSpb = bpm / 60.0                            // beats per second (= 1/secPerBeat)
  let sec16 = 15.0 / bpm                             // seconds per sixteenth (= spb/4)
  let rootSel = (seed * 5) % 12                      // starting key

  let i = 0
  while (i < len) {
    let t = (off + i) * invSr
    let beat = t * invSpb
    let bar = (beat * 0.25) | 0

    // root walks the circle of fifths every two bars
    let step = (rootSel + (bar >> 1) * 7) % 12
    let rootHz = 55.0 * ratio[step]                  // ~55–104 Hz

    // arpeggio over a seventh chord (maj7 / min7 alternating per bar)
    let s16 = (beat * 4.0) | 0
    let frac = beat * 4.0 - s16                       // position within the sixteenth
    let third = (bar % 2) === 0 ? 4 : 3               // major / minor third
    let tone = s16 % 4
    let semi = tone === 0 ? 0 : tone === 1 ? third : tone === 2 ? 7 : (third === 4 ? 11 : 10)
    let noteHz = rootHz * ratio[semi + 12]            // up an octave for the bells

    // FM bell with a quick exponential pluck
    let ts = frac * sec16
    let env = Math.exp(-ts * 7.0)
    let mod = Math.sin(PI2 * noteHz * 2.0 * t) * 1.6
    let bell = Math.sin(PI2 * noteHz * t + mod) * env * 0.28

    // plucked walking bass on the beat
    let bf = beat - (beat | 0)
    let bass = Math.sin(PI2 * rootHz * 0.5 * t) * Math.exp(-bf * 5.0) * 0.22

    // soft root+fifth pad
    let pad = (Math.sin(PI2 * rootHz * t) + Math.sin(PI2 * rootHz * 1.5 * t)) * 0.05

    b[i] = bell + bass + pad
    i++
  }
  return b
}
