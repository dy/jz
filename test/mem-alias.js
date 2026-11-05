// What memory an access reaches (src/ir/mem-alias.js) and the passes that ask: a store
// forgets only what it may overwrite (src/optimize/forward-store.js, reuse-loads.js).
// The emitter marks an element access with its array's allocation cell and a field
// access with its slot and the receiver's layouts; arrays of two cells, an array and
// an object, and two fields at two slots or of two layouts never share bytes. Every
// kernel answers what the host answers; what may be one memory keeps the round trip.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { agree, funcWat, oracle, run, wat } from './util.js'
import { mayAlias } from '../src/ir/mem-alias.js'
import { forwardStores } from '../src/optimize/forward-store.js'
import { reuseLoads } from '../src/optimize/reuse-loads.js'
import { hoistInvariantLoop } from '../src/optimize/licm.js'
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

// A method writes an object's elements, the next one reads them back through another
// name for the same object: three's `local.compose(…)` then `world.multiplyMatrices(parent,
// local)`. Its receivers are elements of arrays, which may be missing: each call tests
// its receiver (`__present`) and splices.
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
const CHAIN = METHODS + `
export let f = (n) => {
  let s = 0
  for (let k = 0; k < n; k++) for (let i = 0; i < N; i++) {
    loc[i].rotate(1 - (i + k) * 1e-3, (i - k) * 1e-3)
    wor[i].mul(i === 0 ? root : wor[i - 1], loc[i])
    s += wor[i].e[1]
  }
  return s
}`

// The angle's sine and cosine between the reads: the math runtime touches no memory.
const TRIG = CHAIN.replace('loc[i].rotate(1 - (i + k) * 1e-3, (i - k) * 1e-3)', 'loc[i].rotate(Math.cos(i + k), Math.sin(i - k))')

test('alias: a method reads back what the method before it stored, through another name', () => {
  for (const [name, src] of [['the chain', CHAIN], ['the chain through sine and cosine', TRIG]]) {
    // (the runtime's sine and cosine may differ from the host's in the last bits)
    for (const optimize of levels(0, 2, 3)) for (const n of [0, 1, 3]) {
      if (src === CHAIN) { agree(src, 'f', [n], { optimize }, `${name} of ${n} at ${optimize}`); continue }
      const want = oracle(src).f(n), got = run(src, { optimize }).f(n)
      ok(Math.abs(got - want) <= 1e-12 * Math.max(1, Math.abs(want)), `${name} of ${n} at ${optimize}: ${got} for ${want}`)
    }
    if (belowOpt(2)) continue
    const body = funcWat(wat(src, { optimize: 3 }), 'f'), loads = (t) => (t.match(/f64\.load/g) || []).length
    ok(!/call \$[^\s)]*(rotate|mul)/.test(body), `${name}: both methods splice into the loop`)
    // the loop reads the local's four elements from the values the rotation stored, and
    // the local and its elements once: six loads fewer than the round trip
    const without = loads(funcWat(wat(src, { optimize: { level: 3, forwardStores: false } }), 'f'))
    ok(loads(body) <= without - 6, `${name}: the local matrix's elements come from the values stored (${loads(body)} loads, ${without} without forwarding)`)
  }
})

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

test('alias: a method of a receiver that may be missing tests it before its arguments run', () => {
  const src = `class P { constructor(x) { this.x = x } sum(k) { return this.x + k } }
    const ps = [new P(1), new P(2)]
    let side = 0
    const f1 = () => { side++; return 1 }
    export let f = (n) => { side = 0; let s = 0; try { for (let i = 0; i < n; i++) s += ps[i].sum(f1()) } catch (e) { return (e instanceof TypeError ? 1000 : 0) + side * 10 + s } return s }`
  for (const optimize of levels(0, 2, 3)) for (const n of [1, 2, 3]) agree(src, 'f', [n], { optimize }, `${n} calls at ${optimize}`)
  if (belowOpt(2)) return
  ok(!/call \$[^\s)]*sum/.test(funcWat(wat(src, { optimize: 3 }), 'f')), 'the method splices into the loop')
})

// three's Matrix4.multiplyMatrices, sixteen products of four: a body too large to splice
// at two sites. A loop calls it directly; another calls it on an element of an array.
const MUL4 = (() => {
  const at = (p, r, c) => `${p}${r}${c}`, rows = [0, 1, 2, 3]
  const reads = (p, arr) => `const ${rows.flatMap(r => rows.map(c => `${at(p, r, c)} = ${arr}[${c * 4 + r}]`)).join(', ')}`
  const out = rows.flatMap(r => rows.map(c => `t[${c * 4 + r}] = ${rows.map(k => `${at('a', r, k)} * ${at('b', k, c)}`).join(' + ')}`))
  return `mul(a, b) { const ae = a.e, be = b.e, t = this.e; ${reads('a', 'ae')}; ${reads('b', 'be')}; ${out.join('; ')}; return this }`
})()
const HOT = `class M {
  constructor() { this.e = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }
  at(x, y) { const t = this.e; if (typeof x === 'object') { t[12] = x.e[0]; t[13] = x.e[1] } else { t[12] = x; t[13] = y } return this }
  ${MUL4}
}
const N = 16, loc = [], wor = []
for (let i = 0; i < N; i++) { loc.push(new M()); wor.push(new M()) }
export let view = (n) => { const proj = new M(), v = new M(), pv = new M(), eye = new M(); let s = 0
  for (let k = 0; k < n; k++) { eye.e[0] = k; v.at(eye); pv.mul(proj, v); s += pv.e[12] } return s }
export let chain = (n) => { let s = 0
  for (let k = 0; k < n; k++) for (let i = 0; i < N; i++) { wor[i].mul(i === 0 ? loc[0] : wor[i - 1], loc[i]); s += wor[i].e[1] } return s }`

test('alias: a loop that calls a method directly keeps its splice beside a receiver that may be missing', () => {
  for (const optimize of levels(0, 2, 3)) for (const f of ['view', 'chain']) agree(HOT, f, [3], { optimize }, `${f} at ${optimize}`)
  if (belowOpt(2)) return
  // the element's call stays a member call: a second direct call would leave the
  // method whole for both, its parameters the kinds of both sites
  ok(!/call \$[^\s)]*mul/.test(funcWat(wat(HOT, { optimize: 3 }), 'view')), 'the direct call splices into its loop')
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

test('alias: a tree of constants stays where it folds, out of a loop\'s hoists', () => {
  const fn = parseWat(`(func $f (param $p i32) (result f64) (local $i i32) (local $j i32) (local $s f64)
    (loop $o (local.set $j (i32.const 0))
      (loop $n (local.set $s (f64.add (local.get $s) (f64.load (i32.add (local.get $p) (i32.shl (i32.const 8) (i32.const 3))))))
        (br_if $n (i32.lt_s (local.tee $j (i32.add (local.get $j) (i32.const 1))) (i32.const 4))))
      (br_if $o (i32.lt_s (local.tee $i (i32.add (local.get $i) (i32.const 1))) (i32.const 4))))
    (local.get $s))`)
  hoistInvariantLoop(fn)
  ok(!JSON.stringify(fn).includes('"i32.shl",["i32.const","8"]') || !/"local\.set","\$__li\d+",\["i32\.shl"/.test(JSON.stringify(fn)), 'no local holds the constant index')
  ok(!/"local\.set","\$__li\d+",\["i32\.(shl|const)"/.test(JSON.stringify(fn)), 'the constant stays in the address')
})

