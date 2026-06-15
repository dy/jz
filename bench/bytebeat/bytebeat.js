// bytebeat.js — classic integer "bytebeat" synthesis, the canonical one-line-song
// idiom (viznut, 2011). A pure-i32 formula of the sample index `t` is evaluated
// per sample straight into an 8-bit PCM buffer — no floats, no transcendentals,
// so the output is bit-identical across every engine and native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Stays inside the lowest common subset:
//   - const/let + arrow functions only (no class, no async, no regex)
//   - Uint8Array output buffer (8-bit PCM)
//   - bitwise / shift / multiply on small (<2^21) values — i32-exact everywhere
//
// Voices (both are textbook bytebeats, summed the way the community layers them):
//   v1 = (t*5 & t>>7) | (t*3 & t>>10)              — viznut's original "42-melody"-class
//   v2 = t*(((t>>12)|(t>>8)) & (63 & (t>>4)))      — the famous "Crowd"
// sample(t) = (v1 + v2) & 255.
//
// Reports: median ms across N_RUNS, throughput in Msamp/s, FNV-1a checksum over
// the whole rendered buffer (so no render pass can be dead-eliminated).

import { checksumU8, medianUs, printResult } from '../_lib/benchlib.js'

const N = 1 << 21      // 2,097,152 samples (~262 s @ 8 kHz) — the whole song
const N_RUNS = 21
const N_WARMUP = 5

// One bytebeat sample: pure integer ops on the index. All intermediates stay
// below 2^31, so f64-evaluated JS and i32-evaluated wasm/native agree bit-for-bit.
const sample = (t) => {
  const v1 = (t * 5 & t >> 7) | (t * 3 & t >> 10)
  const v2 = t * (((t >> 12) | (t >> 8)) & (63 & (t >> 4)))
  return (v1 + v2) & 255
}

const render = (buf, n) => {
  for (let t = 0; t < n; t++) buf[t] = sample(t)
}

export let main = () => {
  const buf = new Uint8Array(N)
  for (let i = 0; i < N_WARMUP; i++) render(buf, N)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    render(buf, N)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumU8(buf), N, 1, N_RUNS)
}
