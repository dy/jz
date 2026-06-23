// radixsort.as.ts — AssemblyScript translation of bench/radixsort/radixsort.js.
//
// LSD radix sort (4 × 8-bit counting passes) over a u32 key array.
// Histogram → prefix-sum → scatter, ping-ponging between two buffers.
// Pure 32-bit integer throughout — sorted output is bit-identical across targets.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N: i32 = 1 << 14       // 16384 keys
const RADIX: i32 = 256       // 8-bit digit
const PASSES: i32 = 4        // 32-bit keys / 8-bit digits
const N_ITERS: i32 = 40      // sorts per kernel run
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

// Deterministic u32 keys — XorShift32, identical per target.
function fill(out: Uint32Array): void {
  let s: u32 = 0x1234abcd
  for (let i = 0; i < N; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    unchecked(out[i] = s)
  }
}

// LSD radix sort: 4 stable counting-sort passes over 8-bit digits, ping-ponging
// a → b. PASSES is even, so the sorted result lands back in `a`.
function radixSort(src: Uint32Array, tmp: Uint32Array, count: Int32Array): void {
  let a = src, b = tmp
  for (let shift: u32 = 0; shift < 32; shift += 8) {
    for (let i = 0; i < RADIX; i++) unchecked(count[i] = 0)
    for (let i = 0; i < N; i++) unchecked(count[<i32>((a[i] >>> shift) & 0xff)]++)
    let sum: i32 = 0
    for (let i = 0; i < RADIX; i++) {
      const c = unchecked(count[i])
      unchecked(count[i] = sum)
      sum += c
    }
    for (let i = 0; i < N; i++) {
      const val = unchecked(a[i])
      const d = <i32>((val >>> shift) & 0xff)
      unchecked(b[count[d]] = val)
      unchecked(count[d]++)
    }
    const t = a; a = b; b = t
  }
}

function runKernel(a: Uint32Array, base: Uint32Array, tmp: Uint32Array, count: Int32Array): void {
  for (let it: u32 = 0; it < <u32>N_ITERS; it++) {
    for (let i = 0; i < N; i++) unchecked(a[i] = base[i] + it)
    radixSort(a, tmp, count)
  }
}

function checksumU32(out: Uint32Array): u32 {
  let h: u32 = 0x811c9dc5
  const n = out.length
  const stride: i32 = 128
  for (let i = 0; i < n; i += stride) h = (h ^ unchecked(out[i])) * 0x01000193
  return h
}

export function main(): void {
  const base = new Uint32Array(N)
  const a = new Uint32Array(N)
  const tmp = new Uint32Array(N)
  const count = new Int32Array(RADIX)
  fill(base)
  for (let i = 0; i < N_WARMUP; i++) runKernel(a, base, tmp, count)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    runKernel(a, base, tmp, count)
    unchecked(samples[i] = perfNow() - t0)
  }

  const cs = checksumU32(a)
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
  logLine(<i32>(medianMs * 1000.0), cs, N * N_ITERS, PASSES, N_RUNS)
}
