import { checksumF64, medianUs, printResult } from '../_lib/benchlib.js'
import * as fabrik3 from '../_lib/pmath/ik/fabrik3.js'

// FABRIK inverse kinematics on a ten-bone chain (pmndrs/math): forward and
// backward passes over an array of bone objects, each holding `start`/`end`
// arrays and a `joint` record, directions normalized into module scratch
// arrays, the best solution saved and restored. The object-graph kernel:
// fields of fields, arrays inside objects, a constraint switch per bone.
// Unconstrained joints keep the kernel to square roots, so every target
// answers the same bits.
const BONES = 10
const K = 60
const N_RUNS = 21
const N_WARMUP = 5

const chain = fabrik3.createChain3()
fabrik3.addBone(chain, [0, 0, 0], [0, 1, 0])
for (let i = 1; i < BONES; i++) fabrik3.addConsecutiveBone(chain, [0, 1, 0], 1)

const target = [0, 0, 0]
let step = 0
// A target wandering the reach: a quadratic pseudo-orbit, no transcendentals.
const advance = () => {
  step = (step + 1) % 1000
  const t = step * 0.001, u = 1 - t
  target[0] = (t * t - u * u) * BONES * 0.6
  target[1] = (2 * t * u - 0.3) * BONES * 0.6
  target[2] = (t - 0.5) * BONES * 0.3
  return target
}

const run = (out) => {
  let acc = 0
  for (let i = 0; i < K; i++) acc += fabrik3.solve(chain, advance())
  const effector = chain.bones[BONES - 1].end
  out[0] = acc
  out[1] = effector[0]
  out[2] = effector[1]
  out[3] = effector[2]
}

export let main = () => {
  const out = new Float64Array(4)
  for (let i = 0; i < N_WARMUP; i++) run(out)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    run(out)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumF64(out), K, 1, N_RUNS)
}
