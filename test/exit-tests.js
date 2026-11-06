// A loop of a few passes leaving at its first hit is written out, its tests
// joined, where no pass's work has an effect or can throw
// (src/compile/plan/exit-tests.js); the loop around it, writing nothing, reads
// what the passes read once (src/optimize/still-loads.js), and the joined tests
// of one shape run two to a vector (src/optimize/pair-tests.js).
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { onKernel, levels } from './_matrix.js'
import { oracle, jz, compile, funcWat } from './util.js'

// Frustum.intersectsSphere over a scene's spheres (three.js's shape, written plainly): the
// plane a sphere leaves by is the data's, NaN radii and centers included.
const CULL = `
class Vec { constructor(x, y, z) { this.x = x; this.y = y; this.z = z } }
class Plane {
  constructor(n, c) { this.normal = n; this.constant = c }
  distanceToPoint(p) { return this.normal.x * p.x + this.normal.y * p.y + this.normal.z * p.z + this.constant }
}
class Sphere { constructor(c, r) { this.center = c; this.radius = r } }
class Frustum {
  constructor() { this.planes = [new Plane(new Vec(0, 0, 0), 0), new Plane(new Vec(0, 0, 0), 0), new Plane(new Vec(0, 0, 0), 0), new Plane(new Vec(0, 0, 0), 0), new Plane(new Vec(0, 0, 0), 0), new Plane(new Vec(0, 0, 0), 0)] }
  set(s) { for (let k = 0; k < 6; k++) { const p = this.planes[k]; p.normal.x = Math.sin(s + k); p.normal.y = Math.cos(s * k); p.normal.z = k % 2 ? 0.5 : -0.5; p.constant = (k - 2.5) * s } }
  intersectsSphere(sphere) {
    const planes = this.planes, center = sphere.center, negRadius = -sphere.radius
    for (let i = 0; i < 6; i++) if (planes[i].distanceToPoint(center) < negRadius) return false
    return true
  }
}
const fr = new Frustum(), spheres = []
let seed = 11
const rnd = () => { seed = (seed * 1103515245 + 12345) | 0; return ((seed >>> 8) % 2000) / 100 - 10 }
for (let i = 0; i < 300; i++) spheres.push(new Sphere(new Vec(rnd(), i % 37 === 1 ? NaN : rnd(), rnd()), i % 41 === 4 ? NaN : Math.abs(rnd()) / 4))
export let cull = (s) => {
  fr.set(s)
  let visible = 0
  for (let i = 0; i < spheres.length; i++) if (fr.intersectsSphere(spheres[i])) visible++
  return visible
}
// a search that always hits by its second pass, a third would read no element and throw: its loop stays
const short = [new Vec(1, 2, 3), new Vec(1e9, 5, 6)]
export let first = (t) => {
  let n = 0
  for (let i = 0; i < 40; i++) { let hit = false; for (let j = 0; j < 4; j++) if (short[j].x > t + i) { hit = true; break } if (hit) n++ }
  return n
}`

test('joinExitTests: frustum tests agree with the host with and without the written-out passes', () => {
  const host = oracle(CULL)
  const off = { level: 'speed', joinExitTests: false, stillLoads: false, pairTests: false }
  for (const optimize of [...levels(0, 2, 3, 'size'), off, { level: 'speed', pairTests: false }]) {
    const wasm = jz(CULL, { optimize }).exports
    for (const s of [0, 0.3, 1.7, -2.5, 4]) is(wasm.cull(s), host.cull(s), `${JSON.stringify(optimize)}: s ${s}`)
    for (const t of [-100, 0, 0.5, 3.5, 100]) is(wasm.first(t), host.first(t), `${JSON.stringify(optimize)}: a short array searched past its end, t ${t}`)
  }
})

test('joinExitTests: the speed build tests a sphere\'s six planes at once, two to a vector', () => {
  if (onKernel()) return
  const wat = funcWat(compile(CULL, { optimize: 'speed', wat: true }), 'cull')
  ok(wat.includes('v128.any_true'), 'the plane tests join into one vector test')
  is((wat.match(/f64x2\.lt/g) || []).length % 3, 0, 'three pairs of tests each copy')
  ok(!/\(br_if \$\S+\s+\(i32\.lt_s\s+\(local\.tee \$\S+\s+\(i32\.add \(local\.get \$\S+\) \(i32\.const 1\)\)\s*\)\s*\(i32\.const 6\)/.test(wat), 'no loop counts the planes')
  // the short array's search keeps its loop: a pass past the end reads no element
  const first = funcWat(compile(CULL, { optimize: 'speed', wat: true }), 'first')
  ok(!first.includes('v128.any_true'), 'a search that would read past its array keeps its exits')
})
