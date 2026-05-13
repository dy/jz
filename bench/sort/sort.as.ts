// sort.as.ts — AssemblyScript translation of bench/sort/sort.js (in-place heapsort).

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N: i32 = 8192
const N_ITERS: i32 = 24
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function fill(a: Float64Array): void {
  let s: u32 = 0x9e3779b9
  const n = a.length
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    unchecked(a[i] = <f64>s / 4294967296.0)
  }
}

function heapsort(a: Float64Array): void {
  const n = a.length
  for (let root = (n >> 1) - 1; root >= 0; root--) {
    let i = root
    let child = 2 * i + 1
    while (child < n) {
      if (child + 1 < n && unchecked(a[child]) < unchecked(a[child + 1])) child++
      if (unchecked(a[i]) >= unchecked(a[child])) break
      const t = unchecked(a[i]); unchecked(a[i] = a[child]); unchecked(a[child] = t)
      i = child
      child = 2 * i + 1
    }
  }
  for (let end = n - 1; end > 0; end--) {
    const t = unchecked(a[0]); unchecked(a[0] = a[end]); unchecked(a[end] = t)
    let i = 0
    let child = 1
    while (child < end) {
      if (child + 1 < end && unchecked(a[child]) < unchecked(a[child + 1])) child++
      if (unchecked(a[i]) >= unchecked(a[child])) break
      const u = unchecked(a[i]); unchecked(a[i] = a[child]); unchecked(a[child] = u)
      i = child
      child = 2 * i + 1
    }
  }
}

function checksumF64(out: Float64Array): u32 {
  // matches benchlib.checksumF64: hash every 256th u32 lane of the buffer.
  const u = Uint32Array.wrap(out.buffer, out.byteOffset, out.length * 2)
  let h: u32 = 0x811c9dc5
  const n = u.length
  for (let i = 0; i < n; i += 256) h = (h ^ <u32>unchecked(u[i])) * 0x01000193
  return h
}

function runKernel(a: Float64Array, src: Float64Array): void {
  const n = a.length
  for (let it = 0; it < N_ITERS; it++) {
    const f: f64 = <f64>it
    for (let i = 0; i < n; i++) unchecked(a[i] = src[i] + f)
    heapsort(a)
  }
}

export function main(): void {
  const src = new Float64Array(N)
  const a = new Float64Array(N)
  fill(src)
  for (let i = 0; i < N_WARMUP; i++) runKernel(a, src)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    runKernel(a, src)
    unchecked(samples[i] = perfNow() - t0)
  }

  const cs = checksumF64(a)
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
  logLine(<i32>(medianMs * 1000.0), cs, N * N_ITERS, 2, N_RUNS)
}
