// NaN canonicalization (optimize/nan-canon.js): where a canon is dropped, moved past
// its loop or kept.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { onKernel, levels } from './_matrix.js'
import parseWat from 'watr/parse'
import encodeWat from 'watr/compile'
import { stripDeadCanons } from '../src/optimize/nan-canon.js'
import { funcWat, run, oracle, jz, compile } from './util.js'
import { walk } from '../scripts/wat-probe.mjs'
import { findFunc } from './_optimizer.js'

const SIGN_SELECT_SRC = `const hs = new Int32Array(8), xs = new Float64Array(8)
  export let set = (i, h, x) => { hs[i] = h; xs[i] = x }
  const grad = (h, x, y) => { const u = (h & 1) === 0 ? x : -x; const v = (h & 2) === 0 ? y : -y; return u + v }
  export let sum = (n) => { let s = 0.0; for (let i = 0; i < n; i++) s = s + grad(hs[i], xs[i], xs[i] * 0.5); return s }`

test('nanCanon: a sign-select through a const local adds without its canon', () => {
  // The emitter folds a negation's NaN to the canonical pattern; through `u` the
  // sum cannot strip it at the consumer.
  const m = jz(SIGN_SELECT_SRC, { optimize: 'speed' }).exports
  const hs = [0, 1, 2, 3, 1, 2], xs = [1.5, -2, 3.25, NaN, 0.5, -0]
  for (let i = 0; i < hs.length; i++) m.set(i, hs[i], xs[i])
  const js = (n) => { let s = 0; for (let i = 0; i < n; i++) { const h = hs[i], x = xs[i], y = x * 0.5; s += ((h & 1) === 0 ? x : -x) + ((h & 2) === 0 ? y : -y) } return s }
  for (const n of [0, 3, 5, 6]) ok(Object.is(m.sum(n), js(n)), `${n}: ${m.sum(n)} vs ${js(n)}`)
  if (onKernel()) return
  // (a canon is read by its NaN literal, kept inline: the speed tier pools float literals otherwise)
  const canons = (opt) => (compile(SIGN_SELECT_SRC, { optimize: { poolFloats: false, ...opt }, wat: true }).match(/select\s*\(f64\.const nan/g) || []).length
  const on = canons({ level: 'speed' }), off = canons({ level: 'speed', nanCanon: false })
  ok(on <= off - 4, `the four negations' canons are gone (${on} canons, ${off} without the pass)`)
})

test('nanCanon: a negation whose value escapes keeps its canon', () => {
  // A result leaves the function: its consumer may compare bits (`typeof`, `===`
  // on a value of unknown kind), so a sign-flipped NaN must not reach it.
  const src = `export let neg = (x) => { const u = -x; return u }`
  const m = jz(src, { optimize: 'speed' }).exports
  for (const x of [1, -0, 0, NaN, Infinity]) ok(Object.is(m.neg(x), -x), `neg(${x})`)
  if (onKernel()) return
  const canons = (opt) => (compile(src, { optimize: { poolFloats: false, ...opt }, wat: true }).match(/select\s*\(f64\.const nan/g) || []).length
  is(canons({ level: 'speed' }), canons({ level: 'speed', nanCanon: false }), 'the canon stays')
  ok(canons({ level: 'speed' }) >= 1, 'and there is one')
})

// A canon in a loop whose local the loop reads only by arithmetic, read by a store or a
// return only after the loop, moves to those reads: the loop carries the raw sum.
const canonLoop = (before, inLoop = '') => `(module (memory (export "memory") 1)
  (func $f (export "f") (param $p i32) (param $n i32) (result f64)
    (local $x f64) (local $t f64) (local $i i32)
    ${before}
    (block $b (loop $l
      (local.set $x (block (result f64)
        (local.set $t (f64.add (local.get $x) (f64.load (local.get $p))))
        (select (f64.const nan) (local.get $t) (f64.ne (local.get $t) (local.get $t)))))
      ${inLoop}
      (br_if $l (i32.lt_s (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $n)))))
    (f64.store offset=8 (local.get $p) (local.get $x))
    (local.get $x)))`
const loopCanons = (fn) => { let n = 0; walk(fn, x => { if (x[0] === 'loop') walk(x, y => { if (y[0] === 'select' && y[1]?.[0] === 'f64.const' && y[1][1] === 'nan') n++ }) }); return n }
test('nanCanon: a loop\'s canon moves to the reads past the loop that need it, exact', () => {
  const src = canonLoop('(local.set $x (f64.const 0))')
  const tree = parseWat(src), fn = findFunc(tree, '$f')
  ok(stripDeadCanons(fn), 'the pass rewrites')
  is(loopCanons(fn), 0, 'the loop normalizes nothing')
  const inst = (t) => new WebAssembly.Instance(new WebAssembly.Module(encodeWat(t))).exports
  const before = inst(parseWat(src)), after = inst(tree)
  for (const [x, n] of [[1.5, 3], [NaN, 2], [-0, 1]]) {
    for (const i of [before, after]) new Float64Array(i.memory.buffer)[0] = x
    ok(Object.is(after.f(0, n), before.f(0, n)), `${x} × ${n}: the same result`)
  }
  // a payload NaN summed in is stored past the loop as the one NaN, as the canon left it
  const stored = (i) => { const w = new BigUint64Array(i.memory.buffer); w[0] = 0x7FF8000200000000n; i.f(0, 1); return w[1] }
  is(stored(after), stored(before), 'the stored bits are the canon\'s')
})
test('nanCanon: a loop\'s canon stays where its local may hold a box or a read in the loop needs it', () => {
  // a load before the loop may be a box (`let s = bag.sum`): normalizing reads would lose it
  for (const src of [canonLoop('(local.set $x (f64.load offset=16 (local.get $p)))'),
    canonLoop('(local.set $x (f64.const 0))', '(f64.store offset=24 (local.get $p) (local.get $x))')]) {
    const tree = parseWat(src), fn = findFunc(tree, '$f')
    stripDeadCanons(fn)
    is(loopCanons(fn), 1, 'the canon stays in the loop')
  }
  // the bag's sum, absent on the first call: its null test reads the box
  const bag = `const ma = (d, st) => { let s = st.sum; if (s == null) s = 0; for (let i = 0; i < d.length; i++) { s += d[i]; d[i] = s } st.sum = s; return d }
    export let f = (n) => { const st = {}, d = new Float64Array(n); for (let i = 0; i < n; i++) d[i] = i; ma(d, st); ma(d, st); return st.sum }`
  const js = oracle(bag).f
  for (const optimize of levels(1, 2, 'speed')) { const f = run(bag, { optimize }).f; for (const n of [0, 1, 7]) is(f(n), js(n), `O${optimize} n=${n}`) }
})

// A local that holds a field through a loop (plan/loop-fields.js): a box from ahead of the loop,
// which each pass writes over first, the read past the loop normalizing only what a pass left.
const heldLoop = (pass = '', after = '', entry = '(local.set $x (f64.load offset=16 (local.get $p)))') => `(module (memory (export "memory") 1)
  (func $f (export "f") (param $p i32) (param $n i32) (result f64)
    (local $x f64) (local $y f64) (local $t f64) (local $i i32)
    ${entry}
    (block $brk (loop $l
      (br_if $brk (i32.ge_s (local.get $i) (local.get $n)))
      ${pass || '(local.set $x (block (result f64) (local.set $t (f64.mul (f64.load (local.get $p)) (f64.const 2))) (select (f64.const nan) (local.get $t) (f64.ne (local.get $t) (local.get $t)))))'}
      (f64.store offset=32 (local.get $p) (f64.mul (local.get $x) (f64.const 3)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    ${after}
    (f64.store offset=24 (local.get $p) (local.get $x))
    (f64.load offset=24 (local.get $p))))`
const stripped = (src) => { const tree = parseWat(src), fn = findFunc(tree, '$f'); stripDeadCanons(fn); return { fn, tree } }
const held = (i, a, b, n) => { const w = new BigUint64Array(i.memory.buffer); w[0] = a; w[2] = b; i.f(0, n); return w[3] }
const UNDEF = 0x7FF8000200000000n, CANON = 0x7FF8000000000000n

test('nanCanon: a held field\'s canon waits past its loop, a box from ahead of it kept where no pass ran', () => {
  const src = heldLoop(), { fn, tree } = stripped(src)
  is(loopCanons(fn), 0, 'the loop normalizes nothing')
  const inst = (t) => new WebAssembly.Instance(new WebAssembly.Module(encodeWat(t))).exports
  const before = inst(parseWat(src)), after = inst(tree)
  for (const [a, b, n] of [[UNDEF, UNDEF, 0], [UNDEF, 0n, 0], [0x7FF8000100000000n, 0x7FF8000100000000n, 0],
    [0x7FF8000200000123n, UNDEF, 1], [0xFFF8000000000000n, UNDEF, 3], [0x4000000000000000n, UNDEF, 2], [CANON, 0n, 1]])
    is(held(after, a, b, n), held(before, a, b, n), `${a.toString(16)} / ${b.toString(16)} over ${n} passes: the same bits`)
  is(held(after, 0x7FF8000200000123n, UNDEF, 1), CANON, 'a payload a pass left is the one NaN')
  is(held(after, 0n, UNDEF, 0), UNDEF, 'and undefined where none ran')
})

test('nanCanon: a held field\'s flag falls for each entry to the loop', () => {
  // the loop around reads a new box each pass and the inner loop runs in the first alone
  const src = `(module (memory (export "memory") 1)
    (func $f (export "f") (param $p i32) (param $n i32) (result f64)
      (local $x f64) (local $t f64) (local $i i32) (local $k i32)
      (loop $o
        (local.set $x (f64.load offset=16 (local.get $p)))
        (local.set $i (i32.const 0))
        (block $brk (loop $l
          (br_if $brk (i32.ge_s (local.get $i) (local.get $n)))
          (local.set $x (block (result f64) (local.set $t (f64.mul (f64.load (local.get $p)) (f64.const 2))) (select (f64.const nan) (local.get $t) (f64.ne (local.get $t) (local.get $t)))))
          (f64.store offset=32 (local.get $p) (f64.mul (local.get $x) (f64.const 3)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $l)))
        (f64.store offset=24 (local.get $p) (local.get $x))
        (local.set $n (i32.const 0))
        (br_if $o (i32.lt_s (local.tee $k (i32.add (local.get $k) (i32.const 1))) (i32.const 2))))
      (f64.load offset=24 (local.get $p))))`
  const { fn, tree } = stripped(src)
  is(loopCanons(fn) <= 1, true, 'the inner loop normalizes nothing')
  const inst = (t) => new WebAssembly.Instance(new WebAssembly.Module(encodeWat(t))).exports
  is(held(inst(tree), 0x7FF8000200000123n, UNDEF, 1), UNDEF, 'the second pass, of no inner pass, keeps its box')
})

test('nanCanon: a box from the other version of the loop passes its read, the flag raised by any pass of this one', () => {
  const canon = '(local.set $x (block (result f64) (local.set $t (f64.mul (f64.load (local.get $p)) (f64.const 2))) (select (f64.const nan) (local.get $t) (f64.ne (local.get $t) (local.get $t)))))'
  const src = `(module (memory (export "memory") 1)
    (func $f (export "f") (param $p i32) (param $n i32) (param $c i32) (result f64)
      (local $x f64) (local $t f64) (local $i i32)
      (if (local.get $c)
        (then (block $brk (loop $l
          (br_if $brk (i32.ge_s (local.get $i) (local.get $n)))
          ${canon}
          (f64.store offset=32 (local.get $p) (f64.mul (local.get $x) (f64.const 3)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $l))))
        (else (local.set $x (f64.load offset=16 (local.get $p)))))
      (f64.store offset=24 (local.get $p) (local.get $x))
      (f64.load offset=24 (local.get $p))))`
  const tree = parseWat(src), fn = findFunc(tree, '$f')
  ok(stripDeadCanons(fn), 'the pass rewrites')
  is(loopCanons(fn), 0, 'the loop normalizes nothing')
  const inst = (t) => new WebAssembly.Instance(new WebAssembly.Module(encodeWat(t))).exports
  const before = inst(parseWat(src)), after = inst(tree)
  const bits = (i, a, b, n, c) => { const w = new BigUint64Array(i.memory.buffer); w[0] = a; w[2] = b; w[3] = 0n; i.f(0, n, c); return w[3] }
  for (const [a, b, n, c] of [[0x7FF8000200000123n, UNDEF, 2, 1], [0x7FF8000200000123n, UNDEF, 0, 1], [0x7FF8000200000123n, UNDEF, 2, 0],
    [0x4000000000000000n, 0x7FF8000100000000n, 1, 1], [0x4000000000000000n, 0x7FF8000100000000n, 1, 0]])
    is(bits(after, a, b, n, c), bits(before, a, b, n, c), `${a.toString(16)} ${b.toString(16)} ${n} passes, version ${c}: the same bits`)
})

test('nanCanon: a held field\'s canon stays where a pass may leave it unwritten or a box may follow the loop', () => {
  const canon = '(local.set $x (block (result f64) (local.set $t (f64.mul (f64.load (local.get $p)) (f64.const 2))) (select (f64.const nan) (local.get $t) (f64.ne (local.get $t) (local.get $t)))))'
  for (const src of [
    // a write in an arm: a pass may keep the box and raise no flag it could trust
    heldLoop(`(if (i32.gt_s (local.get $i) (i32.const 1)) (then ${canon}))`),
    // a read ahead of the write: the pass reads the box
    heldLoop(`(f64.store offset=40 (local.get $p) (f64.add (local.get $x) (f64.const 1))) ${canon}`),
    // a box written past the loop
    heldLoop('', '(local.set $x (f64.load offset=16 (local.get $p)))')]) {
    const { fn } = stripped(src)
    is(loopCanons(fn), 1, 'the canon stays in the loop')
  }
  // a way out of the pass between the writes of two held locals: the first is written, the flag down
  const two = `(module (memory (export "memory") 1)
    (func $f (export "f") (param $p i32) (param $n i32) (result f64)
      (local $x f64) (local $y f64) (local $t f64) (local $i i32)
      (local.set $x (f64.load offset=16 (local.get $p)))
      (local.set $y (f64.load offset=16 (local.get $p)))
      (block $brk (loop $l
        ${'(local.set $x (block (result f64) (local.set $t (f64.mul (f64.load (local.get $p)) (f64.const 2))) (select (f64.const nan) (local.get $t) (f64.ne (local.get $t) (local.get $t)))))'}
        (br_if $brk (i32.ge_s (local.get $i) (local.get $n)))
        ${'(local.set $y (block (result f64) (local.set $t (f64.mul (f64.load (local.get $p)) (f64.const 3))) (select (f64.const nan) (local.get $t) (f64.ne (local.get $t) (local.get $t)))))'}
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (f64.store offset=32 (local.get $p) (f64.mul (f64.add (local.get $x) (local.get $y)) (f64.const 3)))
        (br $l)))
      (f64.store offset=24 (local.get $p) (local.get $x))
      (f64.store offset=32 (local.get $p) (local.get $y))
      (f64.load offset=24 (local.get $p))))`
  const tree = parseWat(two), fn = findFunc(tree, '$f')
  stripDeadCanons(fn)
  is(loopCanons(fn) >= 1, true, 'a canon stays')
  const inst = (t) => new WebAssembly.Instance(new WebAssembly.Module(encodeWat(t))).exports
  is(held(inst(tree), 0x7FF8000200000123n, UNDEF, 0), held(inst(parseWat(two)), 0x7FF8000200000123n, UNDEF, 0), 'and the bits stand')
})

test('nanCanon: a store to single precision keeps its canon, a box\'s bits surviving the conversion', () => {
  // the undefined of a missing element demotes to a NaN whose payload promotes back to the undefined box
  const src = `export function f(which, n) {
    const a = which ? new Float32Array(4) : new Float64Array(4)
    const b = [1]
    let result = 0
    for (let i = 0; i < n; i++) result = (a[i] = b[i])
    return [result, a[0], a[1], Number.isNaN(a[1]), a[1] === undefined]
  }
  class V {
    constructor(x, y) { this.x = x; this.y = y }
    fromArray(a, k) { this.x = a[k]; this.y = a[k + 1]; return this }
    scale(s) { this.x *= s; this.y *= s; return this }
    toArray(a, k) { a[k] = this.x; a[k + 1] = this.y; return this }
  }
  const F = new Float32Array(32), W = new Uint32Array(F.buffer), v = new V(0, 0)
  export let floats = () => F
  export let words = () => W
  export let sweep = (s) => { for (let i = 0; i < 16; i++) v.fromArray(F, i * 2).scale(s).toArray(F, i * 2); return v.x }
  export let same = () => v.x === v.x
  export let missing = () => v.y === undefined`
  const host = oracle(src)
  const fill = (m, word) => { const f = m.floats(); for (let i = 0; i < 32; i++) f[i] = i - 7.5; m.words()[30] = word; m.words()[31] = word }
  for (const optimize of levels(2, 3, 'speed')) {
    const m = run(src, { optimize })
    for (const which of [false, true]) for (const n of [0, 1, 4, 5]) is(JSON.stringify(m.f(which, n)), JSON.stringify(host.f(which, n)), `f(${which}, ${n}) at ${optimize}`)
    for (const word of [0x3F800000, 0x7FC00000, 0xFFC00000, 0x7FC00010, 0x7FC12345]) {
      fill(m, word); fill(host, word)
      ok(Object.is(m.sweep(1.5), host.sweep(1.5)), `${word.toString(16)} at ${optimize}: the answer`)
      is(m.same(), host.same(), 'itself or a NaN')
      is(m.missing(), host.missing(), 'and no undefined')
      for (let i = 0; i < 30; i++) ok(Object.is(m.floats()[i], host.floats()[i]), `element ${i}`)
    }
  }
})

// An undefined test (ir/coerce.js missToNaN) whose value a comparison reads,
// through a sum and a local: stripped; a sum that leaves keeps it, the bits exact.
const missDist = (tail) => `(module (memory (export "memory") 1)
  (func $f (export "f") (param $p i32) (result f64)
    (local $t f64) (local $u f64) (local $d f64)
    (local.set $u (f64.load offset=8 (local.get $p)))
    (local.set $d (f64.add
      (f64.mul (block (result f64) (local.set $t (f64.load (local.get $p)))
        (select (f64.const nan) (local.get $t) (i64.eq (i64.reinterpret_f64 (local.get $t)) (i64.const 0x7FF8000200000000))))
        (f64.const 2))
      (if (result f64) (i64.eq (i64.reinterpret_f64 (local.get $u)) (i64.const 0x7FF8000200000000))
        (then (f64.const nan)) (else (local.get $u)))))
    ${tail}))`
test('nanCanon: an undefined test only a comparison reads is its value, one whose sum leaves stays', () => {
  const undefTests = (fn) => { let n = 0; walk(fn, x => { if (x[0] === 'i64.const' && x[1] === '0x7FF8000200000000') n++ }); return n }
  const inst = (t) => new WebAssembly.Instance(new WebAssembly.Module(encodeWat(t))).exports
  // (the result and the word the sum is stored to, for operands in memory: the undefined box, a Number)
  const out = (i, a, b) => { const w = new BigUint64Array(i.memory.buffer); w[0] = a; w[1] = b; w[2] = 0n; const r = i.f(0); return `${r} ${w[2].toString(16)}` }
  for (const [label, tail, left] of [
    ['compared', '(f64.convert_i32_s (f64.lt (local.get $d) (f64.const 0)))', 0],
    ['stored', '(f64.store offset=16 (local.get $p) (local.get $d)) (f64.const 0)', 2],
    ['returned', '(local.get $d)', 2],
  ]) {
    const src = missDist(tail), tree = parseWat(src), fn = findFunc(tree, '$f')
    stripDeadCanons(fn)
    is(undefTests(fn), left, `${label}: ${left} tests left`)
    const before = inst(parseWat(src)), after = inst(tree)
    for (const [a, b] of [[0x7FF8000200000000n, 0x3FF0000000000000n], [0x3FF0000000000000n, 0x7FF8000200000000n], [0xBFF0000000000000n, 0x3FF0000000000000n]])
      is(out(after, a, b), out(before, a, b), `${label}: ${a.toString(16)}, ${b.toString(16)}`)
  }
})

// Frustum culling (three.js Frustum.intersectsSphere over Plane.distanceToPoint):
// fields a typed read may leave undefined, a dot product compared with a radius.
const CULL_SRC = `class V3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z }
    fromArray(a, i) { this.x = a[i]; this.y = a[i + 1]; this.z = a[i + 2]; return this }
    dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z } }
  class Plane { constructor(n = new V3(1, 0, 0), d = 0) { this.normal = n; this.constant = d }
    distanceToPoint(p) { return this.normal.dot(p) + this.constant } }
  const buf = new Float64Array(12), planes = [new Plane(), new Plane(new V3(0, 1, 0), 2)], centers = []
  for (let i = 0; i < 4; i++) centers.push(new V3(i - 2, 1 - i, i))
  export let set = (k, v) => { buf[k] = v }
  export let load = (c, i) => { centers[c].fromArray(buf, i); planes[1].normal.fromArray(buf, i) }
  export let cull = (r) => { let seen = 0
    for (let s = 0; s < centers.length; s++) { let inside = true
      for (let i = 0; i < planes.length; i++) if (planes[i].distanceToPoint(centers[s]) < -r) { inside = false; break }
      if (inside) seen++ }
    return seen }
  export let dist = (s) => planes[1].distanceToPoint(centers[s])`
test('nanCanon: a culling test compares its fields\' dot product without their undefined tests', () => {
  for (const optimize of levels(false, 2, 'speed')) {
    const m = run(CULL_SRC, { optimize }), o = oracle(CULL_SRC)
    const both = (label, f) => is(f(m), f(o), `O${optimize} ${label}`)
    both('cull(0)', e => e.cull(0)); both('cull(3)', e => e.cull(3))
    for (const [k, v] of [[0, 1], [1, -2], [2, 0.5], [9, 3], [10, -1], [11, 2]]) { m.set(k, v); o.set(k, v) }
    both('loaded', e => { e.load(1, 0); return e.cull(1) }); both('dist(1)', e => e.dist(1))
    // (buf[12] misses: a z undefined, its distance NaN, no comparison true)
    both('missed', e => { e.load(2, 10); return e.cull(1) }); both('dist(2)', e => e.dist(2))
    both('missed twice', e => { e.load(0, 11); return e.cull(5) }); both('dist(0)', e => e.dist(0))
  }
  if (onKernel()) return
  const tests = (opt) => (funcWat(compile(CULL_SRC, { optimize: opt, wat: true }), 'cull').match(/i64\.const 0x7FF8000200000000/g) || []).length
  ok(tests({ level: 'speed', nanCanon: false }) > 0, 'the fields convert in the loop without the pass')
  is(tests({ level: 'speed' }), 0, 'and convert nothing with it')
})

test('stripCanon sees through a hoisted-call temp (hoistNestedCalls single-def binding)', () => {
  // SYNTH DISSECTED WITH MEASURED SHARES (2026-07-25): stripCanon (emit.js) recurses
  // structurally into `select`/`if` arms to drop a redundant NaN-canon guard (the guard is
  // dead when the consumer re-canons its own escape) — but a NESTED call inside a bigger
  // expression (`trig(ph) * env`, the synth's `sinTau(ph) * env` shape) gets rewritten by
  // hoistNestedCalls (plan/inline.js) to `const __tmp = trig(ph); … __tmp * env` at the
  // speed tier. Direct (non-hoisted) inlining already worked; this pins the
  // previously-broken call-inlined shape and checks it now matches (bit-exact, and — once
  // canon-free — cheap enough to become the branchless `select` LEVER 1 restores).
  const src = `
    const trig = (ph) => {
      const q = Math.sqrt(ph + 1)
      const r = ph | 0
      return r === 0 ? q : r === 1 ? -q : r === 2 ? q * 2 : -q
    }
    export const render = (env) => {
      let acc = 0
      for (let ph = 0; ph < 200; ph = ph + 1) {
        const s = trig(ph) * env
        acc = acc + s
      }
      return acc
    }`
  const jsTrig = (ph) => {
    const q = Math.sqrt(ph + 1)
    const r = ph | 0
    return r === 0 ? q : r === 1 ? -q : r === 2 ? q * 2 : -q
  }
  const jsRender = (env) => { let acc = 0; for (let ph = 0; ph < 200; ph++) acc += jsTrig(ph) * env; return acc }
  for (const optimize of levels(false, 2, 3, 'speed')) {
    const { render } = run(src, { optimize })
    is(render(2.5), jsRender(2.5), `O${JSON.stringify(optimize)}: hoisted-call-temp ternary exact`)
    is(render(-1.75), jsRender(-1.75), `O${JSON.stringify(optimize)}: hoisted-call-temp ternary exact (neg env)`)
  }
  // At the speed tier (hoistNestedCalls active), the negation arms must be canon-guard-free
  // (bare `f64.neg`, no `local.tee`-guarded NaN normalization) — the guard is dead because
  // the caller's own `*` re-canons on its escape were it ever to matter for `===`/typeof.
  const wat = compile(src, { wat: true, optimize: 'speed' })
  const fn = wat.split('(func ').find(c => c.startsWith('$render')) || ''
  ok(!/local\.tee[\s\S]{0,40}f64\.neg/.test(fn), 'no tee-guarded NaN-canon wrapper survives around f64.neg')
})
