import { checksumF64, medianUs, printResult } from '../_lib/benchlib.js'
import * as worley2d from '../_lib/pmath/noise/worley2d.js'
import * as worley3d from '../_lib/pmath/noise/worley3d.js'

// Worley (cellular) noise over a grid (pmndrs/math): a permutation table read
// through `{ perm }` at indices `Math.floor(x) + g & 255`, nine (2-D) and
// twenty-seven (3-D) feature-point distances per sample. The hash-noise
// kernel: ToInt32 of floored floats, byte-table gathers, a running minimum.
const SIDE = 96
const N_RUNS = 21
const N_WARMUP = 5

const w2 = worley2d.create(42)
const w3 = worley3d.create(42)

const run = (out) => {
  let k = 0
  for (let y = 0; y < SIDE; y++) {
    for (let x = 0; x < SIDE; x++) {
      const fx = x * 0.11, fy = y * 0.13
      out[k++] = worley2d.sample(w2, fx, fy) + worley3d.sample(w3, fx, fy, (x + y) * 0.07)
    }
  }
}

export let main = () => {
  const out = new Float64Array(SIDE * SIDE)
  for (let i = 0; i < N_WARMUP; i++) run(out)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    run(out)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumF64(out), SIDE * SIDE, 2, N_RUNS)
}
