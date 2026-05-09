import { checksumF64, medianUs, printResult } from '../_lib/benchlib.js'

const N_ITERS = 200000
const N_RUNS = 21
const N_WARMUP = 5

const init = (a, b) => {
  for (let i = 0; i < 16; i++) {
    a[i] = (i + 1) * 0.125
    b[i] = (16 - i) * 0.0625
  }
}

const multiplyMany = (a, b, out, iters) => {
  for (let n = 0; n < iters; n++) {
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        let s = 0
        for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c]
        out[r * 4 + c] = s + n * 0.0000001
      }
    }
    const t = a[0]
    a[0] = out[15]
    a[5] = t + out[10] * 0.000001
    b[0] += out[0] * 0.00000000001
    b[5] -= out[5] * 0.00000000001
  }
}

export let main = () => {
  const a = new Float64Array(16)
  const b = new Float64Array(16)
  const out = new Float64Array(16)
  init(a, b)
  for (let i = 0; i < N_WARMUP; i++) multiplyMany(a, b, out, N_ITERS)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    init(a, b)
    const t0 = performance.now()
    multiplyMany(a, b, out, N_ITERS)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumF64(out), N_ITERS * 16, 4, N_RUNS)
}
