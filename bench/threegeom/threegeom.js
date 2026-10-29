import { checksumF64Near, medianUs, printResult } from '../_lib/benchlib.js'
import { Vector3 } from '../../node_modules/three/src/math/Vector3.js'
import { Matrix4 } from '../../node_modules/three/src/math/Matrix4.js'
import { Euler } from '../../node_modules/three/src/math/Euler.js'
import { Sphere } from '../../node_modules/three/src/math/Sphere.js'
import { Box3 } from '../../node_modules/three/src/math/Box3.js'

// The geometry passes over position buffers (three.js's math classes,
// unmodified): BufferAttribute.applyMatrix4 (each vertex read into a Vector3,
// transformed, written back), BufferGeometry.computeBoundingBox and
// computeBoundingSphere, and computeVertexNormals with normalizeNormals on a
// non-indexed mesh. Float32Array buffers walked through Vector3 scratch
// objects and their chained methods: the buffer-geometry kernel. The
// transform's rotation comes from Euler angles through sin and cos, so the
// checksum is taken at single precision.
const VERTS = 100000
const TRIS = 30000
const PASSES = 4
const N_RUNS = 21
const N_WARMUP = 5

let seed = 2
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296 }

const tp = new Float32Array(VERTS * 3)
for (let i = 0; i < tp.length; i++) tp[i] = rnd() * 2 - 1
const m = new Matrix4().makeRotationFromEuler(new Euler(0.1, 0.2, 0.3)).setPosition(0.01, 0.02, 0.03)
const v = new Vector3()

seed = 6
const bp = new Float32Array(VERTS * 3)
for (let i = 0; i < bp.length; i++) bp[i] = rnd() * 2 - 1
const box = new Box3(), sph = new Sphere(), w = new Vector3()

seed = 7
const np = new Float32Array(TRIS * 9), no = new Float32Array(TRIS * 9)
for (let i = 0; i < np.length; i++) np[i] = rnd() * 2 - 1
const pA = new Vector3(), pB = new Vector3(), pC = new Vector3(), cb = new Vector3(), ab = new Vector3()

// BufferAttribute.applyMatrix4
const transformPositions = () => {
  for (let k = 0; k < PASSES; k++)
    for (let i = 0; i < VERTS; i++) v.fromArray(tp, i * 3).applyMatrix4(m).toArray(tp, i * 3)
  let s = 0
  for (let i = 0; i < tp.length; i++) s += tp[i]
  return s
}

// BufferGeometry.computeBoundingBox + computeBoundingSphere
const bounds = () => {
  let s = 0
  for (let k = 0; k < PASSES; k++) {
    box.setFromArray(bp)
    box.getCenter(sph.center)
    let maxR = 0
    for (let i = 0; i < VERTS; i++) maxR = Math.max(maxR, sph.center.distanceToSquared(w.fromArray(bp, i * 3)))
    sph.radius = Math.sqrt(maxR)
    s += sph.radius + box.max.x
    bp[k % bp.length] += 0.001
  }
  return s
}

// BufferGeometry.computeVertexNormals (non-indexed) + normalizeNormals
const normals = () => {
  let s = 0
  for (let k = 0; k < PASSES; k++) {
    for (let i = 0; i < TRIS; i++) {
      pA.fromArray(np, i * 9); pB.fromArray(np, i * 9 + 3); pC.fromArray(np, i * 9 + 6)
      cb.subVectors(pC, pB); ab.subVectors(pA, pB); cb.cross(ab)
      cb.toArray(no, i * 9); cb.toArray(no, i * 9 + 3); cb.toArray(no, i * 9 + 6)
    }
    for (let i = 0; i < TRIS * 3; i++) cb.fromArray(no, i * 3).normalize().toArray(no, i * 3)
    s += no[(k * 3) % no.length]
    np[k % np.length] += 0.001
  }
  return s
}

const run = (out) => {
  out[0] = transformPositions()
  out[1] = bounds()
  out[2] = normals()
}

export let main = () => {
  const out = new Float64Array(3)
  for (let i = 0; i < N_WARMUP; i++) run(out)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    run(out)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumF64Near(out), (VERTS * 2 + TRIS * 4) * PASSES, 3, N_RUNS)
}
