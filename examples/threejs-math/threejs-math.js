// A camera flies through a field of spheres, culling what's out of view — the same
// Matrix4/Frustum/Sphere calls test/three/kernels.js's cull() runs (gated against Node in
// npm run test:three), here drawn. three.js's own math classes, vendored unmodified from
// node_modules/three/src/math by ./build.mjs — this file is the only local source.
// Drag to steer; the auto-orbit never stops.
// resize(w,h) → Uint32Array; frame(t) steps + draws.
import { Vector3 } from './three/src/math/Vector3.js'
import { Matrix4 } from './three/src/math/Matrix4.js'
import { Frustum } from './three/src/math/Frustum.js'
import { Sphere } from './three/src/math/Sphere.js'

let W = 0, H = 0, px, ink
let lut = new Uint32Array(256)
// theme palette: [paperR,G,B, inkR,G,B] — harness-fed; default = dark theme (black space, light spheres)
let th = new Float64Array(6)
th[0] = 0.0; th[1] = 0.0; th[2] = 0.0; th[3] = 235.0; th[4] = 235.0; th[5] = 235.0

const N = 700                       // sphere count — allocated once in resize(), re-seeded in init()
let spheres = []
let proj = new Matrix4(), view = new Matrix4(), pv = new Matrix4()
let fr = new Frustum()
let eye = new Vector3(), target = new Vector3(0, 0, 0), up = new Vector3(0, 1, 0)
let hit = new Vector3()             // scratch: a sphere centre projected to clip space
let yaw = 0.0, pitch = 0.0          // pointer-drag offsets added to the auto orbit

// Math.random() is the host's own RNG — V8's stream and jz's wasm stream disagree, so the JS
// and jz engines would seed two different fields. A small deterministic LCG (the same one
// test/three/kernels.js seeds its own field with) draws the identical sequence either way.
let seed = 1
let rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296 }

export let resize = (w, h) => {
  W = w; H = h
  ink = new Uint8Array(W * H)
  px = new Uint32Array(W * H)
  // Allocate the field once, ever — a resize (or a theme flip re-triggering load()) only
  // resizes the canvas; init() below re-seeds these same instances in place.
  if (spheres.length === 0) {
    let i = 0
    while (i < N) { spheres.push(new Sphere(new Vector3(0, 0, 0), 1.0)); i++ }
  }
  return px
}

export let setTheme = (pr, pg, pb, ir, ig, ib) => { th[0] = pr; th[1] = pg; th[2] = pb; th[3] = ir; th[4] = ig; th[5] = ib }

// Pointer-drag delta (page pixels), added to the orbit angle / camera height.
export let look = (dx, dy) => {
  yaw += dx
  pitch += dy
  if (pitch > 24.0) pitch = 24.0
  if (pitch < -24.0) pitch = -24.0
}

export let init = () => {
  let i = 0
  while (i < N) {
    let x = (rnd() * 2.0 - 1.0) * 130.0
    let y = (rnd() * 2.0 - 1.0) * 70.0
    let z = (rnd() * 2.0 - 1.0) * 130.0
    let u = rnd()
    let r = 0.8 + u * u * 3.6          // skewed small, a handful of big ones
    let s = spheres[i]
    s.center.set(x, y, z)
    s.radius = r
    i++
  }
  // vertical FOV ≈ 62°, near = 1 — the perspective matrix test/three/kernels.js's cull() builds,
  // aspect folded in the same way three's PerspectiveCamera derives it from fov.
  let aspect = H > 0 ? W / H : 1.0
  let vtop = Math.tan(0.5 * 62.0 * Math.PI / 180.0)
  let vright = vtop * aspect
  proj.makePerspective(-vright, vright, vtop, -vtop, 1.0, 500.0)
  yaw = 0.0; pitch = 0.0
  let n = W * H, k = 0
  while (k < n) { ink[k] = 0; k++ }
}

export let randomize = () => { init() }

// additive, saturating splat of weight a at pixel (ix, iy)
let add = (ix, iy, a) => {
  if (ix >= 0 && ix < W && iy >= 0 && iy < H) {
    let p = iy * W + ix, v = ink[p] + a
    ink[p] = v > 255 ? 255 : v
  }
}

// a soft disc, brightest at the core — falls off as (1 − d/r)²
let glow = (fx, fy, rad, bright) => {
  let cxi = fx | 0, cyi = fy | 0, ri = (rad | 0) + 1
  let oy = -ri
  while (oy <= ri) {
    let ox = -ri
    while (ox <= ri) {
      let d = Math.sqrt(ox * ox + oy * oy) / rad
      if (d < 1.0) { let e = 1.0 - d; add(cxi + ox, cyi + oy, (e * e * bright) | 0) }
      ox++
    }
    oy++
  }
}

export let frame = (t) => {
  let ang = t * 0.18 + yaw
  let r = 60.0
  let height = 16.0 + 14.0 * Math.sin(t * 0.1) + pitch
  eye.set(Math.sin(ang) * r, height, Math.cos(ang) * r)
  view.lookAt(eye, target, up).setPosition(eye).invert()
  pv.multiplyMatrices(proj, view)
  fr.setFromProjectionMatrix(pv)

  // fade the ink for smooth trails
  let n = W * H, i = 0
  while (i < n) { ink[i] = (ink[i] * 246) >> 8; i++ }

  i = 0
  while (i < N) {
    let s = spheres[i]
    if (fr.intersectsSphere(s)) {
      let d = eye.distanceTo(s.center)
      hit.copy(s.center)
      hit.applyMatrix4(pv)
      if (hit.z > -1.0 && hit.z < 1.0 && d > 0.001) {
        let fx = (hit.x * 0.5 + 0.5) * W
        let fy = (1.0 - (hit.y * 0.5 + 0.5)) * H
        let scr = H / d
        let rad = s.radius * scr * 1.3
        if (rad < 0.6) rad = 0.6
        if (rad > 220.0) rad = 220.0
        let bright = 50.0 + 1400.0 / (d + 6.0)
        glow(fx, fy, rad, bright)
      }
    }
    i++
  }

  // composite through a 256-entry tone curve: lerp(paper, ink) keeps spheres in the page ink
  let pr = th[0], pg = th[1], pb = th[2], ir = th[3], ig = th[4], ib = th[5]
  i = 0
  while (i < 256) {
    let v = Math.pow(i / 255.0, 0.62)
    let cr = (pr + (ir - pr) * v) | 0
    let cg = (pg + (ig - pg) * v) | 0
    let cb = (pb + (ib - pb) * v) | 0
    lut[i] = (255 << 24) | (cb << 16) | (cg << 8) | cr
    i++
  }
  i = 0
  while (i < n) { px[i] = lut[ink[i]]; i++ }
}
