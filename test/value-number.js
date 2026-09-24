// Value numbering (watr's valueNumber, enabled by jz with its math runtime vouched
// pure: src/optimize/watr-tail.js): one computation per value, through locals. A
// helper inlined twice with one argument leaves two chains of differently named
// locals that hold the same values; CSE dedupes identical subtrees only, so the
// chains stayed two and the kernel ran twice. Every case is a differential against
// the same program with the pass off: the bits never change, the call count does.
// The pass's own unit cases live with it, in watr's test/value-number.js.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { funcWat as funcWatOf, run, wat } from './util.js'
import { buildPureFuncMap } from '../src/optimize/pure-funcs.js'
import { collectReachableMemoryWrites } from '../src/optimize/globals.js'

const ON = { optimize: 'speed' }
const OFF = { optimize: { level: 'speed', valueNumber: false } }
const calls = (text, name) => (text.match(new RegExp(`\\(call \\$${name.replace(/\./g, '\\.')}\\b`, 'g')) || []).length
/** The function's WAT, under its own name or its export wrapper's. */
const funcWat = (text, name) => funcWatOf(text, name) || funcWatOf(text, `${name}$exp`)

// A typed array crosses the boundary by copy, so every case reads its
// results back through a return value, never through the host's array.
const SPOW = `const spow = (a, e) => { const s = a < 0 ? -1 : 1, av = a < 0 ? -a : a; return s * av ** e }
export let f = (src, n, e) => { const dst = new Float64Array(n); for (let i = 0; i < n; i++) { const L = src[i] / 100; dst[i] = (1 + 2 * spow(L / 3, e)) / (1 + 3 * spow(L / 3, e)) } let s = 0; for (let i = 0; i < n; i++) s += dst[i] * (i + 1); return s }`

test('value numbering: a helper inlined twice with one argument runs once', () => {
  const on = funcWat(wat(SPOW, ON), 'f'), off = funcWat(wat(SPOW, OFF), 'f')
  is(calls(off, 'math.pow2'), 2, 'without the pass: two lane calls')
  is(calls(off, 'math.pow'), 4, 'without the pass: two scalar calls per scalar loop copy')
  is(calls(on, 'math.pow2'), 1, 'the lane loop calls the kernel once')
  is(calls(on, 'math.pow'), 2, 'each scalar loop copy calls the kernel once')
  const src = new Float64Array(37)
  for (let i = 0; i < src.length; i++) src[i] = (i - 18) * 7.3
  const want = run(SPOW, OFF).f(src, src.length, 0.16), got = run(SPOW, ON).f(src, src.length, 0.16)
  ok(Object.is(got, want), `${got} vs ${want}`)
})

test('value numbering: a reassigned operand keeps both calls', () => {
  const src = `export let g = (x) => { let a = Math.sin(x); x = x + 1; return a + Math.sin(x) }`
  is(calls(funcWat(wat(src, ON), 'g'), 'math.sin_core'), 2)
  is(run(src, ON).g(0.7), run(src, OFF).g(0.7))
})

test('value numbering: an if arm feeds neither the other arm nor what follows', () => {
  const src = `export let h = (x, c) => { let a = 0; if (c) a = Math.sin(x) * 2; else a = Math.sin(x) * 3; return a + Math.sin(x) }`
  is(calls(funcWat(wat(src, ON), 'h'), 'math.sin_core'), 3)
  for (const c of [0, 1]) is(run(src, ON).h(0.7, c), run(src, OFF).h(0.7, c))
})

test('value numbering: a loop body shares within an iteration, never across', () => {
  const src = `export let k = (n) => { let x = 0.5, s = 0; for (let i = 0; i < n; i++) { s += Math.sin(x); x = Math.sin(x) } return s }
export let k2 = (n) => { let x = 0.5, s = 0; for (let i = 0; i < n; i++) { s += Math.sin(x); x = x * 2; s += Math.sin(x) } return s }`
  const w = wat(src, ON)
  is(calls(funcWat(w, 'k'), 'math.sin_core'), 1, 'both reads of x precede its write: one call')
  is(calls(funcWat(w, 'k2'), 'math.sin_core'), 2, 'x changes between the calls: two')
  const on = run(src, ON), off = run(src, OFF)
  is(on.k(20), off.k(20))
  is(on.k2(20), off.k2(20))
})

test('value numbering: a store advances the memory clock', () => {
  const src = `export let m = (a, i) => { const u = a[i] * 2 + a[i]; a[i] = 7; return u + a[i] }`
  is(run(src, ON).m(new Float64Array([1, 2, 3]), 1), 2 * 2 + 2 + 7)
})

test('value numbering: a pure user function called twice with one argument runs once', () => {
  // `poly` inlines into `spoly`; `spoly` stays a call (too large to inline), pure: no store, no call.
  let poly = 'x'
  for (let k = 1; k <= 30; k++) poly = `(${poly} * x + ${k}.5)`
  const src = `const poly = (x) => ${poly}
const spoly = (a) => { const s = a < 0 ? -1 : 1, av = a < 0 ? -a : a; return s * poly(av) }
export let q = (x) => (1 + 2 * spoly(x / 3)) / (1 + 3 * spoly(x / 3))`
  // One evaluation of the polynomial: a single call, or a single inlined copy once watr sees one caller.
  const evaluations = (w) => calls(w, 'spoly') + (w.match(/f64\.const 30\.5\b/g) || []).length
  const on = funcWat(wat(src, ON), 'q'), off = funcWat(wat(src, OFF), 'q')
  ok(evaluations(off) >= 1 && evaluations(off) <= 2, `off ${evaluations(off)}`)
  is(evaluations(on), 1)
  for (const x of [-4.5, 0.25, 9]) ok(Object.is(run(src, ON).q(x), run(src, OFF).q(x)), `q(${x})`)
})

test('value numbering: a value held inside a conditional arm does not reach past it', () => {
  // The arm's holder is assigned on its path only: the read after the conditional computes again.
  const src = `export let f = (x, c) => { const v = c ? Math.sin(x) * 2 : 0; return v + Math.sin(x) }
export let g = (a, i, c) => { const v = c ? a[i] * 2 : 0; return v + a[i] }`
  const on = run(src, ON), off = run(src, OFF)
  for (const c of [0, 1]) {
    is(on.f(0.7, c), off.f(0.7, c), `f c=${c}`)
    is(on.g(new Float64Array([5, 7, 9]), 1, c), off.g(new Float64Array([5, 7, 9]), 1, c), `g c=${c}`)
  }
})

test('value numbering: a tail call carries its callee\'s effects', () => {
  // The iterator step is a tail call to the pull that advances the cursor: two steps are two values.
  const src = `export let f = () => { const m = new Map(); m.set(1, 2); m.set(3, 4); let s = ''; for (const [a, b] of m) s += a + ':' + b + ';'; return s }`
  is(run(src, ON).f(), '1:2;3:4;')
  is(run(src, { optimize: 2 }).f(), '1:2;3:4;')
})

test('value numbering: a holder assigned inside a try body does not reach past a throw', () => {
  // The catch clause targets the block around the try body: what the body assigned is unknown after it.
  const src = `export let f = (x, t) => { let a = 0; try { if (t) throw new Error('boom'); a = Math.sin(x) * 2 } catch (e) { a = -1 } return a + Math.sin(x) }`
  for (const t of [0, 1]) is(run(src, ON).f(0.7, t), run(src, OFF).f(0.7, t), `t=${t}`)
})

test('value numbering: a holder assigned inside a switch arm does not reach past the switch', () => {
  // A case arm is a br_table target's block: what it assigned is unknown after the switch.
  const src = `export let f = (x, k) => { let a = 0; switch (k) { case 1: a = Math.sin(x) * 2; break; case 2: a = 5; break; default: a = -1 } return a + Math.sin(x) }`
  for (const k of [0, 1, 2, 3]) is(run(src, ON).f(0.7, k), run(src, OFF).f(0.7, k), `k=${k}`)
})

test('value numbering: floating constants preserve the sign of zero', () => {
  const src = 'export let f = () => { let a = +0, b = -0; return 1 / a === 1 / b }'
  for (const optimize of [2, 'speed', 'size']) is(run(src, { optimize }).f(), false, String(optimize))
})

test('value numbering: a shared assignment stays after sibling reads', () => {
  for (const [op, same, ascending] of [
    ['<', false, true], ['<=', true, true], ['>', false, false], ['>=', true, false],
    ['==', true, false], ['!=', false, true], ['===', true, false], ['!==', false, true],
  ]) {
    const src = `export let f = () => {
      var x = 1; if (((x = 0) ${op} x) !== ${same}) return 1;
      var x = 0; if ((x ${op} (x = 1)) !== ${ascending}) return 2;
      return 0
    }`
    for (const optimize of [2, 'speed', 'size']) is(run(src, { optimize }).f(), 0, `${op}, ${optimize}`)
  }
})

test('purity: every store width and SIMD lane store is effectful', () => {
  for (const op of ['i32.store', 'i32.store8', 'i32.store16', 'i64.store', 'i64.store8', 'i64.store16', 'i64.store32', 'f32.store', 'f64.store', 'v128.store', 'v128.store8_lane', 'v128.store16_lane', 'v128.store32_lane', 'v128.store64_lane']) {
    const fn = ['func', '$write', ['param', '$x', 'f64'], [op, ['i32.const', 0], ['local.get', '$x']]]
    ok(!buildPureFuncMap([fn]).has('$write'), `${op} is not lane-inline pure`)
    ok(collectReachableMemoryWrites([fn]).get('$write').has('*'), `${op} invalidates memory hoists`)
  }
})

test('purity: random calls and atomic writes stay effectful', () => {
  const random = ['func', '$random', ['result', 'f64'], ['call', '$math.random']]
  ok(!buildPureFuncMap([random]).has('$random'))
  const writer = ['func', '$write', ['drop', ['i32.atomic.rmw8.add_u', ['i32.const', 0], ['i32.const', 1]]]]
  ok(!buildPureFuncMap([writer]).has('$write'))
  ok(collectReachableMemoryWrites([writer]).get('$write').has('*'))
})

