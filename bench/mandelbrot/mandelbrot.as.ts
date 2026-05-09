// mandelbrot.as.ts — AssemblyScript translation of bench/mandelbrot/mandelbrot.js.
//
// Inner loop is a hot scalar f64 kernel; AS compiles to monomorphic wasm
// directly without runtime type narrowing.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const W: i32 = 256
const H: i32 = 256
const MAX_ITER: i32 = 256
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5
const X0: f64 = -2.0
const X1: f64 = 0.5
const Y0: f64 = -1.25
const Y1: f64 = 1.25

function checksumU32(xs: Uint32Array): u32 {
  let h: u32 = 0x811c9dc5
  const n = xs.length
  for (let i = 0; i < n; i += 128) h = (h ^ unchecked(xs[i])) * 0x01000193
  return h
}

function render(out: Uint32Array): void {
  const dx: f64 = (X1 - X0) / <f64>W
  const dy: f64 = (Y1 - Y0) / <f64>H
  for (let py = 0; py < H; py++) {
    const cy = Y0 + <f64>py * dy
    for (let px = 0; px < W; px++) {
      const cx = X0 + <f64>px * dx
      let zx: f64 = 0
      let zy: f64 = 0
      let i: i32 = 0
      while (i < MAX_ITER) {
        const x2 = zx * zx
        const y2 = zy * zy
        if (x2 + y2 > 4.0) break
        zy = 2.0 * zx * zy + cy
        zx = x2 - y2 + cx
        i++
      }
      unchecked(out[py * W + px] = <u32>i)
    }
  }
}

export function main(): void {
  const out = new Uint32Array(W * H)

  for (let i = 0; i < N_WARMUP; i++) render(out)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    render(out)
    unchecked(samples[i] = perfNow() - t0)
  }

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
  logLine(<i32>(medianMs * 1000.0), checksumU32(out), W * H, MAX_ITER, N_RUNS)
}
