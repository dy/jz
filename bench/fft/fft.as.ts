// fft.as.ts — AssemblyScript translation of bench/fft/fft.js.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N: i32 = 1 << 16
const LOG2N: i32 = 16
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

// @ts-ignore: decorator
@inline
function sinPoly(x: f64): f64 {
  const x2 = x * x
  return x * (1.0 + x2 * (-0.16666666666666666 + x2 * (0.008333333333333333 + x2 * (-0.0001984126984126984 + x2 * (2.7557319223985893e-06 + x2 * -2.505210838544172e-08)))))
}
// @ts-ignore: decorator
@inline
function cosPoly(x: f64): f64 {
  const x2 = x * x
  return 1.0 + x2 * (-0.5 + x2 * (0.041666666666666664 + x2 * (-0.001388888888888889 + x2 * (2.48015873015873e-05 + x2 * -2.7557319223985894e-07))))
}

function buildTwiddles(wre: Float64Array, wim: Float64Array, n: i32): void {
  const dt = -6.283185307179586 / <f64>n
  const c1 = cosPoly(dt), s1 = sinPoly(dt)
  let cr = 1.0, ci = 0.0
  const half = n >> 1
  for (let k = 0; k < half; k++) {
    unchecked(wre[k] = cr)
    unchecked(wim[k] = ci)
    const nr = cr * c1 - ci * s1
    const ni = cr * s1 + ci * c1
    cr = nr
    ci = ni
  }
}

function fft(re: Float64Array, im: Float64Array, wre: Float64Array, wim: Float64Array, n: i32): void {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = unchecked(re[i]); unchecked(re[i] = re[j]); unchecked(re[j] = tr)
      const ti = unchecked(im[i]); unchecked(im[i] = im[j]); unchecked(im[j] = ti)
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const step = n / len
    for (let i = 0; i < n; i += len) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = unchecked(wre[k]), wi = unchecked(wim[k])
        const a = i + j, b = a + half
        const xr = unchecked(re[b]), xi = unchecked(im[b])
        const tr = wr * xr - wi * xi
        const ti = wr * xi + wi * xr
        unchecked(re[b] = re[a] - tr)
        unchecked(im[b] = im[a] - ti)
        unchecked(re[a] = re[a] + tr)
        unchecked(im[a] = im[a] + ti)
      }
    }
  }
}

function mkSignal(out: Float64Array, n: i32): void {
  let s: u32 = 0x1234abcd
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    unchecked(out[i] = (<f64>s / 4294967296.0) * 2.0 - 1.0)
  }
}

function checksumF64(out: Float64Array): u32 {
  let h: u32 = 0x811c9dc5
  const n = out.length
  for (let i = 0; i < n; i += 128) {
    const bits = reinterpret<u64>(unchecked(out[i]))
    h = (h ^ <u32>bits) * 0x01000193
  }
  return h
}

export function main(): void {
  const sig = new Float64Array(N)
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  const wre = new Float64Array(N >> 1)
  const wim = new Float64Array(N >> 1)
  mkSignal(sig, N)
  buildTwiddles(wre, wim, N)

  for (let w = 0; w < N_WARMUP; w++) {
    for (let i = 0; i < N; i++) { unchecked(re[i] = sig[i]); unchecked(im[i] = 0.0) }
    fft(re, im, wre, wim, N)
  }

  const samples = new Float64Array(N_RUNS)
  for (let r = 0; r < N_RUNS; r++) {
    for (let i = 0; i < N; i++) { unchecked(re[i] = sig[i]); unchecked(im[i] = 0.0) }
    const t0 = perfNow()
    fft(re, im, wre, wim, N)
    unchecked(samples[r] = perfNow() - t0)
  }

  const cs = checksumF64(re)
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
  logLine(<i32>(medianMs * 1000.0), cs, (N * LOG2N) >> 1, LOG2N, N_RUNS)
}
