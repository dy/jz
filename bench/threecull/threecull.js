import { checksumF64Near, medianUs, printResult } from '../_lib/benchlib.js'
import { Vector3 } from '../../node_modules/three/src/math/Vector3.js'
import { Matrix4 } from '../../node_modules/three/src/math/Matrix4.js'
import { Frustum } from '../../node_modules/three/src/math/Frustum.js'
import { Sphere } from '../../node_modules/three/src/math/Sphere.js'
import { Ray } from '../../node_modules/three/src/math/Ray.js'

// The visibility queries of a frame (three.js's math classes, unmodified):
// WebGLRenderer.projectObject's frustum test of every object's bounding
// sphere as a camera orbits (lookAt, invert, the frustum's planes from the
// view-projection matrix), and Mesh.raycast's ray against every triangle of
// a position buffer. Ten thousand spheres held in an array, twenty thousand
// triangles read through Vector3 scratch: the culling and picking kernel.
const SPHERES = 10000
const ORBIT = 40
const TRIANGLES = 20000
const RAYS = 10
const N_RUNS = 21
const N_WARMUP = 5

let seed = 3
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296 }

const spheres = []
for (let i = 0; i < SPHERES; i++) spheres.push(new Sphere(new Vector3(rnd() * 200 - 100, rnd() * 200 - 100, rnd() * 200 - 100), rnd() * 5))
const proj = new Matrix4().makePerspective(-1, 1, 1, -1, 1, 100)
const view = new Matrix4(), pv = new Matrix4(), fr = new Frustum()
const eye = new Vector3(), target = new Vector3(0, 0, 0), up = new Vector3(0, 1, 0)

seed = 4
const p = new Float32Array(TRIANGLES * 9)
for (let i = 0; i < p.length; i++) p[i] = rnd() * 20 - 10
const ray = new Ray(), a = new Vector3(), b = new Vector3(), c = new Vector3(), hit = new Vector3()

// WebGLRenderer.projectObject
const cull = () => {
  let visible = 0
  for (let k = 0; k < ORBIT; k++) {
    eye.set(Math.sin(k * 0.01) * 50, 10, Math.cos(k * 0.01) * 50)
    view.lookAt(eye, target, up).setPosition(eye).invert()
    pv.multiplyMatrices(proj, view)
    fr.setFromProjectionMatrix(pv)
    for (let i = 0; i < SPHERES; i++) if (fr.intersectsSphere(spheres[i])) visible++
  }
  return visible
}

// Mesh.raycast
const raycast = (out) => {
  seed = 5
  let hits = 0, acc = 0
  for (let k = 0; k < RAYS; k++) {
    ray.origin.set(0, 0, -30)
    ray.direction.set(rnd() - 0.5, rnd() - 0.5, 1).normalize()
    for (let i = 0; i < TRIANGLES; i++) {
      a.fromArray(p, i * 9); b.fromArray(p, i * 9 + 3); c.fromArray(p, i * 9 + 6)
      if (ray.intersectTriangle(a, b, c, false, hit) !== null) { hits++; acc += hit.z }
    }
  }
  out[1] = hits
  out[2] = acc
}

const run = (out) => {
  out[0] = cull()
  raycast(out)
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
  printResult(medianUs(samples), checksumF64Near(out), SPHERES * ORBIT + TRIANGLES * RAYS, 2, N_RUNS)
}
