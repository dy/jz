import { checksumF64Near, medianUs, printResult } from '../_lib/benchlib.js'
import { Quaternion } from '../../node_modules/three/src/math/Quaternion.js'
import { Euler } from '../../node_modules/three/src/math/Euler.js'

// QuaternionLinearInterpolant (three.js's math classes, unmodified): every
// frame the rotation of each animated bone interpolated between two
// keyframes with `Quaternion.slerpFlat`, a static method over flat
// Float32Array buffers at an offset: the animation-mixer kernel. Each slerp
// takes an acos and three sines, so the checksum is taken at single
// precision (engines' libm differ in the last bits).
const N = 10000
const ITERS = 40
const N_RUNS = 21
const N_WARMUP = 5

let seed = 5
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296 }

const src0 = new Float32Array(N * 4), src1 = new Float32Array(N * 4), dst = new Float32Array(N * 4)
const q = new Quaternion(), e = new Euler()
for (let i = 0; i < N; i++) {
  q.setFromEuler(e.set(rnd() * 6, rnd() * 6, rnd() * 6)).toArray(src0, i * 4)
  q.setFromEuler(e.set(rnd() * 6, rnd() * 6, rnd() * 6)).toArray(src1, i * 4)
}

const run = (out) => {
  let s = 0
  for (let k = 0; k < ITERS; k++) {
    const t = (k % 100) / 100
    for (let i = 0; i < N; i++) Quaternion.slerpFlat(dst, i * 4, src0, i * 4, src1, i * 4, t)
    s += dst[(k * 4) % dst.length]
  }
  out[0] = s
  for (let k = 0; k < 8; k++) out[k + 1] = dst[k * 4099 % dst.length]
}

export let main = () => {
  const out = new Float64Array(9)
  for (let i = 0; i < N_WARMUP; i++) run(out)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    run(out)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumF64Near(out), N * ITERS, 1, N_RUNS)
}
