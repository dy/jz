// What memory an access reaches (src/ir/mem-alias.js) and the passes that ask: a store
// forgets only what it may overwrite (src/optimize/forward-store.js, reuse-loads.js).
// The emitter marks an element access with its array's allocation cell and a field
// access with its slot and the receiver's layouts; arrays of two cells, an array and
// an object, and two fields at two slots or of two layouts never share bytes. Every
// kernel answers what the host answers; what may be one memory keeps the round trip.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { levels } from './_matrix.js'
import { agree } from './util.js'
import { mayAlias } from '../src/ir/mem-alias.js'
import { forwardStores } from '../src/optimize/forward-store.js'
import { reuseLoads } from '../src/optimize/reuse-loads.js'
import parseWat from 'watr/parse'
import { walk } from '../scripts/wat-probe.mjs'

const count = (n, re) => (JSON.stringify(n).match(re) || []).length
// The nodes of `ir` in source order whose op is `op`, to mark by position.
const nodes = (ir, op) => { const out = []; walk(ir, n => { if (n[0] === op) out.push(n) }); return out }

test('alias: the marks', () => {
  ok(!mayAlias('e1', 'e2'), 'arrays of two cells')
  ok(mayAlias('e1', 'e1'), 'one cell')
  ok(!mayAlias('e1', 'f0:3'), 'an array and an object')
  ok(!mayAlias('f0:3', 'f1:3'), 'two slots of one layout')
  ok(!mayAlias('f0:3', 'f0:4'), 'a slot of two layouts')
  ok(mayAlias('f0:3,4', 'f0:4,7'), 'a slot of a layout both may have')
  ok(mayAlias(undefined, 'e1') && mayAlias('f0:3', undefined), 'an unmarked access may reach anything')
})

// Methods that write an object's elements and read them back through other names.
const METHODS = `class M2 {
  constructor() { this.e = [1, 0, 0, 1] }
  rotate(c, s) { const t = this.e; t[0] = c; t[1] = s; t[2] = -s; t[3] = c; return this }
  mul(a, b) {
    const ae = a.e, be = b.e, t = this.e
    const a0 = ae[0], a1 = ae[1], a2 = ae[2], a3 = ae[3], b0 = be[0], b1 = be[1], b2 = be[2], b3 = be[3]
    t[0] = a0 * b0 + a2 * b1; t[1] = a1 * b0 + a3 * b1; t[2] = a0 * b2 + a2 * b3; t[3] = a1 * b2 + a3 * b3
    return this
  }
}
const N = 64, loc = [], wor = []
for (let i = 0; i < N; i++) { loc.push(new M2()); wor.push(new M2()) }
const root = new M2()`
// One object under two names, an array under two, a field of one object stored through
// another name: the stores may reach the loads, which read memory again.
const cases = [
  ['the same matrix as both factors, in place', METHODS + `
    export let f = (n) => { let s = 0; for (let i = 0; i < N; i++) { loc[i].rotate(i * 1e-2, n); loc[i].mul(loc[i], loc[i]); s += loc[i].e[0] + loc[i].e[2] } return s }`, [0.5]],
  ['one object in two arrays', METHODS + `
    for (let i = 0; i < N; i += 2) wor[i] = loc[i]
    export let f = (n) => { let s = 0; for (let i = 0; i < N; i++) { loc[i].rotate(i * 1e-2, n); wor[i].mul(root, root); s += loc[i].e[1] } return s }`, [0.25]],
  ['an array under two names', `const a = [1, 2, 3], b = [4, 5, 6]
    export let f = (c) => { const x = c > 0 ? a : b, y = a; x[0] = 7; y[0] = 9; return x[0] + y[0] + b[0] }`, [1]],
  ['a field stored through another name', `class P { constructor(x) { this.x = x; this.y = 0 } }
    const ps = [new P(1), new P(2)]
    export let f = (j) => { const p = ps[0], q = ps[j]; p.x = 3; q.x = 5; p.y = 1; return p.x + q.x + p.y }`, [0]],
  ['an array and an object it is the field of', `class H { constructor() { this.v = [0, 0]; this.n = 0 } }
    const hs = [new H(), new H()]
    export let f = (j) => { const h = hs[0], v = hs[j].v; h.v[0] = 2; v[0] = 4; h.n = h.v[0]; return h.n + v[0] }`, [0]],
]

test('alias: what may be one memory keeps the round trip', () => {
  for (const [name, src, args] of cases)
    for (const optimize of levels(0, 2, 3)) agree(src, 'f', args, { optimize }, `${name} at ${optimize}`)
  for (const [name, src] of cases.slice(2, 5)) for (const j of [0, 1]) agree(src, 'f', [j], { optimize: 3 }, `${name} (${j})`)
})

// The passes on IR whose accesses carry the marks the emitter leaves.
const FN = (body) => parseWat(`(func $f (param $a i32) (param $b i32) (result f64) (local $x f64) (local $y f64) ${body})`)

test('alias: forwarding keeps a load across a store the marks keep apart, and forgets it across one they do not', () => {
  const body = `(local.set $x (f64.load (local.get $a))) (f64.store (local.get $b) (f64.const 1)) (local.set $y (f64.load (local.get $a))) (f64.add (local.get $x) (local.get $y))`
  for (const [store, kept] of [['e2', true], ['f0:3', true], ['e1', false], [undefined, false]]) {
    const fn = FN(body), [l1, l2] = nodes(fn, 'f64.load'), [st] = nodes(fn, 'f64.store')
    l1.mem = l2.mem = 'e1'
    if (store) st.mem = store
    forwardStores(fn)
    is(count(fn, /"f64\.load"/g), kept ? 1 : 2, `a store marked ${store ?? 'nothing'} ${kept ? 'keeps' : 'forgets'} the load`)
  }
})

test('alias: forwarding reads through a local one write copies from another', () => {
  // LICM snaps one base into a local per access; both are the address the loop stores to and reads
  const fn = parseWat(`(func $f (param $p i32) (result f64) (local $s i32) (local $u i32) (local $v i32) (local $r f64)
    (local.set $s (local.get $p)) (local.set $u (local.get $s)) (local.set $v (local.get $s))
    (loop $l (f64.store (local.get $u) (f64.const 2)) (local.set $r (f64.load (local.get $v))) (br_if $l (f64.lt (local.get $r) (f64.const 1))))
    (local.get $r))`)
  forwardStores(fn)
  is(count(fn, /"f64\.load"/g), 0, 'the load reads the stored value')
  const branch = parseWat(`(func $f (param $p i32) (param $c i32) (result f64) (local $s i32) (local $u i32) (local $v i32) (local $r f64)
    (local.set $s (local.get $p)) (local.set $u (local.get $s))
    (if (local.get $c) (then (local.set $v (local.get $s))))
    (loop $l (f64.store (local.get $u) (f64.const 2)) (local.set $r (f64.load (local.get $v))) (br_if $l (f64.lt (local.get $r) (f64.const 1))))
    (local.get $r))`)
  forwardStores(branch)
  is(count(branch, /"f64\.load"/g), 1, 'a copy made in an arm is no copy where the arm did not run')
})

test('alias: a load is reused across a store the marks keep apart', () => {
  const body = `(local.set $x (f64.load (local.get $a))) (f64.store (local.get $b) (f64.const 1)) (local.set $y (f64.load (local.get $a))) (f64.add (local.get $x) (local.get $y))`
  for (const [store, reused] of [['e2', true], ['f0:4', true], ['f1:4', false], [undefined, false]]) {
    const fn = FN(body), [l1, l2] = nodes(fn, 'f64.load'), [st] = nodes(fn, 'f64.store')
    l1.mem = l2.mem = 'f1:4'
    if (store) st.mem = store
    reuseLoads(fn)
    is(count(fn, /"f64\.load"/g), reused ? 1 : 2, `a store marked ${store ?? 'nothing'} ${reused ? 'keeps' : 'forgets'} the load`)
  }
})
