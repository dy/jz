// slices.js — block processing over RUNTIME SUB-VIEWS of one arena: every audio engine's
// inner life (mix busses, voice blocks, delay taps) and every font table walk. Each block
// reads input at arena[inOff + i] and accumulates into a bus at arena[busOff + i], where
// both offsets are runtime values from a schedule — the compiler must hoist the bases out
// of the loop (LLVM does it without blinking). A compiler that re-derives base + i per
// access, or falls off its typed-address fast path because the base is a variable, loses
// this case by an order of magnitude. One-pole smoothing keeps a loop-carried scalar in
// flight so the loop is real DSP, not a memcpy.
//
// Single source compiled by all targets and run directly by the JS engines.
// Subset: const/let + arrows, typed arrays, no class/async/regex.
//
// Reports: median ms across N_RUNS, FNV-1a checksum over the bus (f64 bits).

import { medianUs, checksumF64, printResult } from '../_lib/benchlib.js'

const N = 1 << 18            // arena halves: input signal + mix bus
const NB = 4096              // scheduled blocks per pass
const N_ITERS = 3            // passes per kernel run
const N_RUNS = 21
const N_WARMUP = 5

// deterministic schedule + input (xorshift32, the suite's idiom)
const buildWorld = (input, bus, inOff, busOff, len) => {
  let s = 0x2f6e2b1 | 0
  const rnd = () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return s >>> 0
  }
  for (let i = 0; i < N; i++) input[i] = (rnd() / 4294967296.0) * 2.0 - 1.0
  for (let i = 0; i < N; i++) bus[i] = 0.0
  for (let b = 0; b < NB; b++) {
    const l = 64 + (rnd() % 257)           // 64..320 samples per block
    len[b] = l
    inOff[b] = rnd() % (N - l)
    busOff[b] = rnd() % (N - l)
  }
}

// one pass: every block smooths its input view and accumulates into its bus view
const runPass = (input, bus, inOff, busOff, len, gain) => {
  for (let b = 0; b < NB; b++) {
    const io = inOff[b]
    const bo = busOff[b]
    const l = len[b]
    let sm = 0.0
    for (let i = 0; i < l; i++) {
      sm = sm * 0.995 + input[io + i] * 0.005
      bus[bo + i] = bus[bo + i] + sm * gain
    }
  }
}

const runKernel = (input, bus, inOff, busOff, len) => {
  for (let it = 0; it < N_ITERS; it++) runPass(input, bus, inOff, busOff, len, 0.25 + it * 0.125)
}

export let main = () => {
  const input = new Float64Array(N)
  const bus = new Float64Array(N)
  const inOff = new Int32Array(NB)
  const busOff = new Int32Array(NB)
  const len = new Int32Array(NB)
  buildWorld(input, bus, inOff, busOff, len)

  for (let i = 0; i < N_WARMUP; i++) runKernel(input, bus, inOff, busOff, len)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    runKernel(input, bus, inOff, busOff, len)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumF64(bus), NB * N_ITERS, N_ITERS, N_RUNS)
}
