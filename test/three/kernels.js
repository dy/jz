// The CPU hot paths of a three.js frame, written against three's own math classes as a
// three.js program writes them. Each export takes a size and a repeat count and answers
// a checksum. Compiled by jz and run by Node from this same file (test/three.js).
import { Vector3 } from 'three/src/math/Vector3.js'
import { Matrix4 } from 'three/src/math/Matrix4.js'
import { Quaternion } from 'three/src/math/Quaternion.js'
import { Euler } from 'three/src/math/Euler.js'
import { Frustum } from 'three/src/math/Frustum.js'
import { Sphere } from 'three/src/math/Sphere.js'
import { Ray } from 'three/src/math/Ray.js'
import { Box3 } from 'three/src/math/Box3.js'

let seed = 1
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296 }

// Object3D.updateMatrixWorld over a scene of chains: compose TRS, multiply by parent
export const sceneUpdate = (n, frames) => {
  seed = 1
  const pos = [], quat = [], scl = [], local = [], world = []
  const e = new Euler()
  for (let i = 0; i < n; i++) {
    pos.push(new Vector3(rnd() * 100 - 50, rnd() * 100 - 50, rnd() * 100 - 50))
    quat.push(new Quaternion().setFromEuler(e.set(rnd() * 6, rnd() * 6, rnd() * 6)))
    scl.push(new Vector3(1 + rnd(), 1 + rnd(), 1 + rnd()))
    local.push(new Matrix4())
    world.push(new Matrix4())
  }
  const root = new Matrix4().makeRotationY(0.3)
  let sum = 0
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < n; i++) {
      pos[i].x += 0.01
      local[i].compose(pos[i], quat[i], scl[i])
      const parent = (i & 7) === 0 ? root : world[i - 1]
      world[i].multiplyMatrices(parent, local[i])
    }
    sum += world[n - 1].elements[12]
  }
  return sum
}

// BufferAttribute.applyMatrix4 over a position buffer
export const transformPositions = (n, iters) => {
  seed = 2
  const a = new Float32Array(n * 3)
  for (let i = 0; i < a.length; i++) a[i] = rnd() * 2 - 1
  const m = new Matrix4().makeRotationFromEuler(new Euler(0.1, 0.2, 0.3)).setPosition(0.01, 0.02, 0.03)
  const v = new Vector3()
  for (let k = 0; k < iters; k++)
    for (let i = 0; i < n; i++) v.fromArray(a, i * 3).applyMatrix4(m).toArray(a, i * 3)
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]
  return s
}

// WebGLRenderer.projectObject: frustum test of every object's bounding sphere
export const cull = (n, iters) => {
  seed = 3
  const spheres = []
  for (let i = 0; i < n; i++) spheres.push(new Sphere(new Vector3(rnd() * 200 - 100, rnd() * 200 - 100, rnd() * 200 - 100), rnd() * 5))
  const proj = new Matrix4().makePerspective(-1, 1, 1, -1, 1, 100)
  const view = new Matrix4(), pv = new Matrix4(), fr = new Frustum()
  const eye = new Vector3(), target = new Vector3(0, 0, 0), up = new Vector3(0, 1, 0)
  let visible = 0
  for (let k = 0; k < iters; k++) {
    eye.set(Math.sin(k * 0.01) * 50, 10, Math.cos(k * 0.01) * 50)
    view.lookAt(eye, target, up).setPosition(eye).invert()
    pv.multiplyMatrices(proj, view)
    fr.setFromProjectionMatrix(pv)
    for (let i = 0; i < n; i++) if (fr.intersectsSphere(spheres[i])) visible++
  }
  return visible
}

// Mesh.raycast: ray against every triangle of a position buffer
export const raycast = (n, iters) => {
  seed = 4
  const p = new Float32Array(n * 9)
  for (let i = 0; i < p.length; i++) p[i] = rnd() * 20 - 10
  const ray = new Ray(), a = new Vector3(), b = new Vector3(), c = new Vector3(), hit = new Vector3()
  let hits = 0, acc = 0
  for (let k = 0; k < iters; k++) {
    ray.origin.set(0, 0, -30)
    ray.direction.set(rnd() - 0.5, rnd() - 0.5, 1).normalize()
    for (let i = 0; i < n; i++) {
      a.fromArray(p, i * 9); b.fromArray(p, i * 9 + 3); c.fromArray(p, i * 9 + 6)
      if (ray.intersectTriangle(a, b, c, false, hit) !== null) { hits++; acc += hit.z }
    }
  }
  return hits + acc * 1e-3
}

// QuaternionLinearInterpolant: slerp of every animated bone
export const slerp = (n, iters) => {
  seed = 5
  const src0 = new Float32Array(n * 4), src1 = new Float32Array(n * 4), dst = new Float32Array(n * 4)
  const q = new Quaternion(), e = new Euler()
  for (let i = 0; i < n; i++) {
    q.setFromEuler(e.set(rnd() * 6, rnd() * 6, rnd() * 6)).toArray(src0, i * 4)
    q.setFromEuler(e.set(rnd() * 6, rnd() * 6, rnd() * 6)).toArray(src1, i * 4)
  }
  let s = 0
  for (let k = 0; k < iters; k++) {
    const t = (k % 100) / 100
    for (let i = 0; i < n; i++) Quaternion.slerpFlat(dst, i * 4, src0, i * 4, src1, i * 4, t)
    s += dst[(k * 4) % dst.length]
  }
  return s
}

// BufferGeometry.computeBoundingBox + computeBoundingSphere
export const bounds = (n, iters) => {
  seed = 6
  const a = new Float32Array(n * 3)
  for (let i = 0; i < a.length; i++) a[i] = rnd() * 2 - 1
  const box = new Box3(), sph = new Sphere(), v = new Vector3()
  let s = 0
  for (let k = 0; k < iters; k++) {
    box.setFromArray(a)
    box.getCenter(sph.center)
    let maxR = 0
    for (let i = 0; i < n; i++) maxR = Math.max(maxR, sph.center.distanceToSquared(v.fromArray(a, i * 3)))
    sph.radius = Math.sqrt(maxR)
    s += sph.radius + box.max.x
    a[k % a.length] += 0.001
  }
  return s
}

// BufferGeometry.computeVertexNormals (non-indexed) + normalizeNormals
export const normals = (n, iters) => {
  seed = 7
  const p = new Float32Array(n * 9), o = new Float32Array(n * 9)
  for (let i = 0; i < p.length; i++) p[i] = rnd() * 2 - 1
  const pA = new Vector3(), pB = new Vector3(), pC = new Vector3(), cb = new Vector3(), ab = new Vector3()
  let s = 0
  for (let k = 0; k < iters; k++) {
    for (let i = 0; i < n; i++) {
      pA.fromArray(p, i * 9); pB.fromArray(p, i * 9 + 3); pC.fromArray(p, i * 9 + 6)
      cb.subVectors(pC, pB); ab.subVectors(pA, pB); cb.cross(ab)
      cb.toArray(o, i * 9); cb.toArray(o, i * 9 + 3); cb.toArray(o, i * 9 + 6)
    }
    for (let i = 0; i < n * 3; i++) cb.fromArray(o, i * 3).normalize().toArray(o, i * 3)
    s += o[(k * 3) % o.length]
    p[k % p.length] += 0.001
  }
  return s
}
