import { checksumF64Near, medianUs, printResult } from '../_lib/benchlib.js'
import { Vector3 } from '../../node_modules/three/src/math/Vector3.js'
import { Matrix4 } from '../../node_modules/three/src/math/Matrix4.js'
import { Quaternion } from '../../node_modules/three/src/math/Quaternion.js'
import { Euler } from '../../node_modules/three/src/math/Euler.js'

// Object3D.updateMatrixWorld over a scene of chains (three.js's math classes,
// unmodified): every frame each node composes its local matrix from its
// position, quaternion and scale, then multiplies it by its parent's world
// matrix. The scene is ten thousand class instances of each kind held in
// arrays, the matrices `elements` arrays of sixteen: the scene-graph kernel.
// The rotations come from Euler angles through sin and cos, so the checksum
// is taken at single precision (engines' libm differ in the last bits).
const N = 10000
const FRAMES = 20
const N_RUNS = 21
const N_WARMUP = 5

let seed = 1
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296 }

const pos = [], quat = [], scl = [], local = [], world = []
const e = new Euler()
for (let i = 0; i < N; i++) {
  pos.push(new Vector3(rnd() * 100 - 50, rnd() * 100 - 50, rnd() * 100 - 50))
  quat.push(new Quaternion().setFromEuler(e.set(rnd() * 6, rnd() * 6, rnd() * 6)))
  scl.push(new Vector3(1 + rnd(), 1 + rnd(), 1 + rnd()))
  local.push(new Matrix4())
  world.push(new Matrix4())
}
const root = new Matrix4().makeRotationY(0.3)

const run = (out) => {
  let sum = 0
  for (let f = 0; f < FRAMES; f++) {
    for (let i = 0; i < N; i++) {
      pos[i].x += 0.01
      local[i].compose(pos[i], quat[i], scl[i])
      const parent = (i & 7) === 0 ? root : world[i - 1]
      world[i].multiplyMatrices(parent, local[i])
    }
    sum += world[N - 1].elements[12]
  }
  const m = world[N - 1].elements
  for (let k = 0; k < 16; k++) out[k] = m[k]
  out[16] = sum
}

export let main = () => {
  const out = new Float64Array(17)
  for (let i = 0; i < N_WARMUP; i++) run(out)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    run(out)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumF64Near(out), N * FRAMES, 2, N_RUNS)
}
