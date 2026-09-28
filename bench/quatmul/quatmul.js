import { checksumF64, medianUs, printResult } from '../_lib/benchlib.js'
import * as quat from '../_lib/pmath/core/quat.js'
import * as mulberry32 from '../_lib/pmath/random/mulberry32.js'

// Quaternion products, inverses and normalizations over arrays of quaternions
// (pmndrs/math): each quaternion a four-element plain array, read by index
// from an array of them, written into one out-parameter. The fixed-size
// linear-algebra kernel with pointer chasing between the elements; square
// roots and divisions only, so every target answers the same bits.
const N = 4096
const N_RUNS = 21
const N_WARMUP = 5

const makeQuats = (seed) => {
  const rand = mulberry32.create(seed)
  const quats = []
  for (let i = 0; i < N; i++) {
    const q = [mulberry32.sample(rand) - 0.5, mulberry32.sample(rand) - 0.5, mulberry32.sample(rand) - 0.5, mulberry32.sample(rand) + 0.5]
    quats.push(quat.normalize(q, q))
  }
  return quats
}

const a = makeQuats(1)
const b = makeQuats(2)
const out = quat.create()
const inv = quat.create()

const run = (acc) => {
  let sm = 0, si = 0
  for (let i = 0; i < N; i++) {
    quat.multiply(out, a[i], b[i])
    quat.normalize(out, out)
    sm += out[0] + out[3]
    quat.invert(inv, a[i])
    quat.multiply(out, inv, b[i])
    si += out[1] + out[2]
  }
  acc[0] = sm
  acc[1] = si
  acc[2] = out[0]
  acc[3] = out[1]
  acc[4] = out[2]
  acc[5] = out[3]
}

export let main = () => {
  const acc = new Float64Array(6)
  for (let i = 0; i < N_WARMUP; i++) run(acc)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    run(acc)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumF64(acc), N * 2, 2, N_RUNS)
}
