// ZzFX — the Zuper Zmall Zound Zynth, by Frank Force (KilledByAPixel).
// https://github.com/KilledByAPixel/ZzFX  ·  MIT.
//
// This is `zzfxG` (the sample generator) ported so the *same source is valid JS
// and valid jz*: imported as an ES module it is the V8 baseline, compiled it is
// the wasm engine. Both return a Float64Array of samples in [-1, 1].
//
// Two faithful deviations from the original one-liner, forced by the compiler:
//   · the `Math.random()` frequency jitter is lifted out to a `rnd` argument the
//     host supplies (jz's PRNG is fixed-seed per compile) — so the two engines
//     are bit-comparable and each play can still vary;
//   · the `for(; i<len; b[i++]=s)` update-store and the assignment-in-expression
//     biquad are unrolled into plain statements (jz drops a for-update store).
// Everything else — the nested-ternary wave select, the 5-stage envelope, the
// delay tap, the Direct-Form-I filter — matches the original sample for sample.

export let zzfxG = (
  volume = 1, randomness = .05, frequency = 220, attack = 0, sustain = 0,
  release = .1, shape = 0, shapeCurve = 1, slide = 0, deltaSlide = 0,
  pitchJump = 0, pitchJumpTime = 0, repeatTime = 0, noise = 0, modulation = 0,
  bitCrush = 0, delay = 0, sustainVolume = 1, decay = 0, tremolo = 0, filter = 0,
  rnd = 0
) => {
  let sampleRate = 44100
  let PI2 = Math.PI * 2

  // frequency + slide → radians per sample; apply the host-supplied jitter
  slide = slide * 500 * PI2 / sampleRate / sampleRate
  let startSlide = slide
  frequency = frequency * (1 + randomness * (2 * rnd - 1)) * PI2 / sampleRate
  let startFrequency = frequency

  // seconds → samples
  attack = attack * sampleRate
  if (attack == 0) attack = 9                              // minimum attack avoids a click
  decay = decay * sampleRate
  sustain = sustain * sampleRate
  release = release * sampleRate
  delay = delay * sampleRate
  deltaSlide = deltaSlide * 500 * PI2 / (sampleRate * sampleRate * sampleRate)
  modulation = modulation * PI2 / sampleRate
  pitchJump = pitchJump * PI2 / sampleRate
  pitchJumpTime = pitchJumpTime * sampleRate
  repeatTime = repeatTime * sampleRate | 0
  let crushStep = bitCrush * 100 | 0                       // 0 ⇒ no bit-crush
  volume = volume * 0.3                                    // zzfxV master volume

  // biquad coefficients (Direct Form I) — filter > 0 high-pass, < 0 low-pass, 0 off
  let quality = 2
  let w = PI2 * Math.abs(filter) * 2 / sampleRate
  let fcos = Math.cos(w)
  let alpha = Math.sin(w) / 2 / quality
  let a0 = 1 + alpha
  let a1 = -2 * fcos / a0
  let a2 = (1 - alpha) / a0
  let fsign = filter < 0 ? -1 : 1
  let b0 = (1 + fsign * fcos) / 2 / a0
  let b1 = -(fsign + fcos) / a0
  let b2 = b0
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0

  let length = attack + decay + sustain + release + delay | 0
  let b = new Float64Array(length)

  let t = 0, i = 0, s = 0, f = 0
  let modOffset = 0, repeat = 0, crush = 0, jump = 1

  while (i < length) {
    crush = crush + 1
    // bit-crush gate: recompute the wave only on gated steps, hold it otherwise
    let gated = crushStep == 0 ? 1 : (crush % crushStep == 0 ? 1 : 0)
    if (gated != 0) {
      // wave shape: 0 sin · 1 triangle · 2 saw · 3 clipped-tan · 4 sin(t³) noise · 5 square
      if (shape == 0) s = Math.sin(t)
      else if (shape == 1) s = 1 - 4 * Math.abs(Math.round(t / PI2) - t / PI2)
      else if (shape == 2) s = 1 - (2 * t / PI2 % 2 + 2) % 2
      else if (shape == 3) s = Math.max(Math.min(Math.tan(t), 1), -1)
      else if (shape == 4) s = Math.sin(t ** 3)
      else s = t / PI2 % 1 < shapeCurve / 2 ? 1 : -1

      // tremolo · shape curve (square keeps its value) · 5-stage envelope
      let trem = repeatTime != 0 ? 1 - tremolo + tremolo * Math.sin(PI2 * i / repeatTime) : 1
      let curved = shape > 4 ? s : (s < 0 ? -1 : 1) * Math.abs(s) ** shapeCurve
      let env =
        i < attack ? i / attack :
        i < attack + decay ? 1 - ((i - attack) / decay) * (1 - sustainVolume) :
        i < attack + decay + sustain ? sustainVolume :
        i < length - delay ? (length - i - delay) / release * sustainVolume :
        0
      s = trem * curved * env

      // delay tap: 50/50 mix with the already-written delayed sample
      if (delay != 0) {
        let dsamp = 0
        if (i >= delay) {
          let dscale = i < length - delay ? 1 : (length - i) / delay
          dsamp = dscale * b[(i - delay) | 0] / 2 / volume
        }
        s = s / 2 + dsamp
      }

      // biquad: y = b0·x0 + b1·x1 + b2·x2 − a1·y1 − a2·y2, shift the delay lines
      if (filter != 0) {
        let x0 = s
        let out = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2 = x1; x1 = x0
        y2 = y1; y1 = out
        s = out
      }
    }

    // advance frequency / modulation / phase every sample
    slide = slide + deltaSlide
    frequency = frequency + slide
    f = frequency * Math.cos(modulation * modOffset)
    modOffset = modOffset + 1
    // The original noise hash is Math.sin(i**5) — at i in the thousands that argument
    // reaches ~1e20, which no engine reduces to matching bits. Use an integer xorshift
    // hash instead: pure i32 ops, so jz and JS produce identical white noise (no
    // transcendental drift), bounded to [-1, 1), and only evaluated when noise is on.
    t = t + f
    if (noise != 0) {
      let k = i | 0
      k = Math.imul(k ^ (k >>> 16), 0x45d9f3b)
      k = Math.imul(k ^ (k >>> 16), 0x45d9f3b)
      k = k ^ (k >>> 16)
      t = t + f * noise * ((k >>> 0) / 4294967296 * 2 - 1)
    }

    // one-shot pitch jump after pitchJumpTime samples
    if (jump != 0) {
      jump = jump + 1
      if (jump > pitchJumpTime) {
        frequency = frequency + pitchJump
        startFrequency = startFrequency + pitchJump
        jump = 0
      }
    }

    // periodic repeat: reset frequency / slide / pitch-jump timer
    if (repeatTime != 0) {
      repeat = repeat + 1
      if (repeat % repeatTime == 0) {
        frequency = startFrequency
        slide = startSlide
        if (jump == 0) jump = 1
      }
    }

    b[i] = s * volume
    i = i + 1
  }

  return b
}
