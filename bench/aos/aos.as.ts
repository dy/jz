// aos.as.ts — AssemblyScript translation of bench/aos/aos.js.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N: i32 = 16384
const N_ITERS: i32 = 64
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

class Row {
  constructor(public x: f64, public y: f64, public z: f64) {}
}

function initRows(): Array<Row> {
  const rows = new Array<Row>(N)
  for (let i = 0; i < N; i++) {
    unchecked(rows[i] = new Row(<f64>i * 0.5, <f64>(i + 1), <f64>((i & 7) - 3)))
  }
  return rows
}

function runKernel(rows: Array<Row>, xs: Float64Array, ys: Float64Array, zs: Float64Array): void {
  const n = rows.length
  for (let r = 0; r < N_ITERS; r++) {
    const rf: f64 = <f64>r
    for (let i = 0; i < n; i++) {
      const p = unchecked(rows[i])
      unchecked(xs[i] = p.x + p.y * 0.25 + rf)
      unchecked(ys[i] = p.y - p.z * 0.5)
      unchecked(zs[i] = p.z + p.x * 0.125)
    }
  }
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
  const rows = initRows()
  const xs = new Float64Array(N)
  const ys = new Float64Array(N)
  const zs = new Float64Array(N)
  for (let i = 0; i < N_WARMUP; i++) runKernel(rows, xs, ys, zs)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    runKernel(rows, xs, ys, zs)
    unchecked(samples[i] = perfNow() - t0)
  }

  const cs: u32 = (checksumF64(xs) ^ checksumF64(ys) ^ checksumF64(zs))
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
  logLine(<i32>(medianMs * 1000.0), cs, N * N_ITERS, 3, N_RUNS)
}
