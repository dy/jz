// slices.as.ts — AssemblyScript translation of bench/slices/slices.js.
//
// block processing over RUNTIME SUB-VIEWS of one arena: every audio engine's
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

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N: i32 = 1 << 18       // arena halves: input signal + mix bus
const NB: i32 = 4096         // scheduled blocks per pass
const N_ITERS: i32 = 3       // passes per kernel run
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

// deterministic schedule + input (xorshift32, the suite's idiom)
function buildWorld(input: Float64Array, bus: Float64Array, inOff: Int32Array, busOff: Int32Array, len: Int32Array): void {
  let s: u32 = 0x2f6e2b1
  for (let i = 0; i < N; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    unchecked(input[i] = (<f64>s / 4294967296.0) * 2.0 - 1.0)
  }
  for (let i = 0; i < N; i++) unchecked(bus[i] = 0.0)
  for (let b = 0; b < NB; b++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    const l: i32 = 64 + <i32>(s % 257)           // 64..320 samples per block
    unchecked(len[b] = l)
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    unchecked(inOff[b] = <i32>(s % <u32>(N - l)))
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    unchecked(busOff[b] = <i32>(s % <u32>(N - l)))
  }
}

// one pass: every block smooths its input view and accumulates into its bus view
function runPass(input: Float64Array, bus: Float64Array, inOff: Int32Array, busOff: Int32Array, len: Int32Array, gain: f64): void {
  for (let b = 0; b < NB; b++) {
    const io = unchecked(inOff[b])
    const bo = unchecked(busOff[b])
    const l = unchecked(len[b])
    let sm: f64 = 0.0
    for (let i = 0; i < l; i++) {
      sm = sm * 0.995 + unchecked(input[io + i]) * 0.005
      unchecked(bus[bo + i] = bus[bo + i] + sm * gain)
    }
  }
}

function runKernel(input: Float64Array, bus: Float64Array, inOff: Int32Array, busOff: Int32Array, len: Int32Array): void {
  for (let it = 0; it < N_ITERS; it++) runPass(input, bus, inOff, busOff, len, 0.25 + <f64>it * 0.125)
}

function checksumF64(out: Float64Array): u32 {
  let h: u32 = 0x811c9dc5
  const stride: i32 = 256
  const total: i32 = out.length * 2
  const base: usize = changetype<usize>(out.buffer)
  for (let i = 0; i < total; i += stride) {
    const w = load<u32>(base + (<usize>i << 2))
    h = (h ^ w) * 0x01000193
  }
  return h
}

export function main(): void {
  const input = new Float64Array(N)
  const bus = new Float64Array(N)
  const inOff = new Int32Array(NB)
  const busOff = new Int32Array(NB)
  const len = new Int32Array(NB)
  buildWorld(input, bus, inOff, busOff, len)

  for (let i = 0; i < N_WARMUP; i++) runKernel(input, bus, inOff, busOff, len)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    runKernel(input, bus, inOff, busOff, len)
    unchecked(samples[i] = perfNow() - t0)
  }

  const cs = checksumF64(bus)

  const sorted = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) unchecked(sorted[i] = samples[i])
  for (let i = 1; i < N_RUNS; i++) {
    const v = unchecked(sorted[i])
    let j = i - 1
    while (j >= 0 && unchecked(sorted[j]) > v) {
      unchecked(sorted[j + 1] = sorted[j])
      j--
    }
    unchecked(sorted[j + 1] = v)
  }
  const medianMs = unchecked(sorted[(N_RUNS - 1) >> 1])
  logLine(<i32>(medianMs * 1000.0), cs, NB * N_ITERS, N_ITERS, N_RUNS)
}
