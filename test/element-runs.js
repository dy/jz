// A run of straight-line statements reading or storing elements of one array at
// indexes held in bindings is written under one guard that every index is an integer
// inside the array's length (src/compile/plan/element-runs.js): the arm reads and
// stores in place, the statements as written run where the guard fails. A run stores:
// reads alone pay their own tests, which cost what a guard's do. Every program
// here answers what the host answers over indexes inside the length, at it, past it,
// negative, fractional, NaN, -0 and past 2^32, an array with holes, and the same array
// under two names; the runs the pass must leave are marked by the guards it made.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { ctx } from '../src/ctx.js'
import { belowOpt, levels, OPT_LEVEL } from './_matrix.js'
import { oracle, run, compileInProcess, funcWat, wat } from './util.js'

// (the indexes come from tables, so no call's constants reach them)
const HEAD = `const X = [0, 1, 5, 2, 7, -1, 1.5, -0, 4294967297, 3, 6, 9, 0]
const Y = [3, 1, 0, 6, 2, 4, 2, 4, 1, NaN, 6, 1, -0]
const side = (v) => v === undefined ? 0 : v
const digest = (a) => {
  let h = a.length
  for (let i = 0; i < a.length; i++) { const v = a[i]; h = (h * 31 + (v === undefined ? 7 : v !== v ? 13 : v)) | 0 }
  return h * 8 + side(a[1.5]) + side(a[-1]) * 2 + side(a[4294967297]) * 3
}
const fresh = () => [10, 20, 30, 40, 50, 60]
const holed = () => { const a = [1, 2, 3]; a[6] = 9; return a }
`
const OVER = (call) => `export const go = () => {
  let h = 0
  for (let p = 0; p < X.length; p++) { const a = fresh(), b = holed(); ${call}; h = (h * 17 + digest(a) + digest(b) * 3) | 0 }
  return h
}`
// Each keeps its run: [the program's functions, the calls a round makes]
const kept = {
  'a swap': [`const swap = (a, i, j) => { const t = a[i]; a[i] = a[j]; a[j] = t }`, `swap(a, X[p] * 1, Y[p] * 1); swap(b, Y[p] * 1, X[p] * 1)`],
  'a swap through a field': [`class Box { constructor(v) { this.v = v; this.n = 0 }
    swap(i, j) { const t = this.v[i]; this.v[i] = this.v[j]; this.v[j] = t; this.n += 1 } }`, `new Box(a).swap(X[p] * 1, Y[p] * 1); new Box(b).swap(Y[p] * 1, X[p] * 1)`],
  'a field that may be missing': [`class Late { constructor() { this.v = null }
    fill(v) { this.v = v }
    swap(i, j) { const t = this.v[i]; this.v[i] = this.v[j]; this.v[j] = t } }
    const late = (v, i, j) => { const o = new Late(); if (i !== 3) o.fill(v); try { o.swap(i, j) } catch (e) { v[0] = -5 } }`, `late(a, X[p] * 1, Y[p] * 1); late(b, Y[p] * 1, X[p] * 1)`],
  'a sum stored back': [`const add = (a, i, j) => { a[i] = a[i] + a[j] }`, `add(a, X[p] * 1, Y[p] * 1); add(b, Y[p] * 1, X[p] * 1)`],
  'a rotation of three': [`const rot = (a, i, j, k) => { const t = a[i]; a[i] = a[j]; a[j] = a[k]; a[k] = t }`, `rot(a, X[p] * 1, Y[p] * 1, X[(p + 3) % X.length] * 1); rot(b, Y[p] * 1, X[p] * 1, 2)`],
  'a member stored between': [`const via = (a, o, i, j) => { o.s = a[i]; a[i] = a[j]; a[j] = o.s }
    const hold = { s: 0 }`, `via(a, hold, X[p] * 1, Y[p] * 1); via(b, hold, Y[p] * 1, X[p] * 1)`],
  'a store through another name of the same array': [`const move = (a, c, i, j) => { c[j] = a[i]; a[i] = c[i]; a[j] = 77 }`, `move(a, a, X[p] * 1, Y[p] * 1); move(b, a, Y[p] * 1, X[p] * 1); move(a, b, 2, 9)`],
  'an index declared ahead of the run': [`const next = (a, i, j) => { const k = i + 1; const t = a[k]; a[k] = a[j]; a[j] = t }`, `next(a, X[p] * 1, Y[p] * 1); next(b, Y[p] * 1, X[p] * 1)`],
}
// Each stays as written: its statements shrink the array, bind a name again, run code, or the run's name is read after it.
const left = {
  'a call that shrinks between': [`const cut = (a, x) => { a.pop(); return x }
    const f = (a, i, j) => { const t = a[i]; a[i] = cut(a, a[j]); a[j] = t }`, `f(a, X[p] * 1, Y[p] * 1); f(b, Y[p] * 1, X[p] * 1)`],
  'an index assigned in the run': [`const f = (a, i, j, k) => { for (let r = 0; r < 2; r++) { const t = a[i]; i = k; a[i] = a[j]; a[j] = t } }`, `f(a, X[p] * 1, Y[p] * 1, 2); f(b, Y[p] * 1, X[p] * 1, 8)`],
  'an index declared in the run': [`const f = (a, i, j) => { const t = a[i]; const k = j + 4; a[k] = t; a[i] = k }`, `f(a, X[p] * 1, Y[p] * 1); f(b, Y[p] * 1, X[p] * 1)`],
  // (in a loop's body, where the binding is one across the rounds: a list of the function's own declares the new value a binding)
  'the array bound again': [`const f = (a, c, i, j) => { for (let r = 0; r < 2; r++) { const t = a[i]; a = c; a[j] = t; a[i] = 3 + r } }`, `f(a, b, X[p] * 1, Y[p] * 1); f(b, a, Y[p] * 1, X[p] * 1)`],
  'a length stored': [`const f = (a, i, j) => { const t = a[i]; a.length = 2; a[j] = t; a[i] = 4 }`, `f(a, X[p] * 1, Y[p] * 1); f(b, Y[p] * 1, X[p] * 1)`],
  'a length stored through another name': [`const f = (a, c, i, j) => { const t = a[i]; c.length = 2; a[j] = t; a[i] = 4 }`, `f(a, a, X[p] * 1, Y[p] * 1); f(b, a, Y[p] * 1, X[p] * 1)`],
  'the path\'s member stored': [`class Box { constructor(v) { this.v = v } }
    const one = new Box(null), two = new Box(null)
    const f = (o, c, i, j) => { const t = o.v[i]; o.v = c; o.v[j] = t; o.v[i] = 3 }`, `one.v = a; f(one, b, X[p] * 1, Y[p] * 1); two.v = b; f(two, a, Y[p] * 1, X[p] * 1)`],
  'a name of the run read after it': [`const f = (a, i, j) => { const t = a[i]; a[i] = a[j]; a[j] = t; return t }`, `a[0] = side(f(a, X[p] * 1, Y[p] * 1)); b[0] = side(f(b, Y[p] * 1, X[p] * 1))`],
  // (a BigInt names the element its digits do; a guard that asked `k | 0` of it would throw)
  'a key that may be a BigInt': [`const K = [1n, 2, 0n, 3]
    const f = (a, k, j) => { const t = a[k]; a[k] = a[j]; a[j] = t }`, `f(a, K[p % 4], Y[p] * 1); f(b, K[(p + 1) % 4], X[p] * 1)`],
  'a key that may be a string': [`const K = ['y', 1, 'x', 2]
    const f = (a, k, j) => { const t = a[k]; a[k] = a[j]; a[j] = t }`, `f(a, K[p % 4], Y[p] * 1); f(b, K[(p + 1) % 4], X[p] * 1); a[1] = side(a.x) + side(a.y) * 2; b[1] = side(b.x) + side(b.y) * 2`],
  'reads alone': [`const f = (a, o, i, j) => { o.s = a[i] + a[j] * 2 + a[i] * 4 }
    const tally = { s: 0 }`, `f(a, tally, X[p] * 1, Y[p] * 1); a[0] = tally.s; f(b, tally, Y[p] * 1, X[p] * 1); b[0] = tally.s`],
  'a run past the size a guard copies': [`const f = (a, i, j) => { ${Array.from({ length: 30 }, (_, k) => `a[i] = (a[i] + a[j] * ${k + 1}) % 997`).join('; ')} }`, `f(a, X[p] * 1, Y[p] * 1); f(b, Y[p] * 1, X[p] * 1)`],
  'a run a canonical loop holds inside the length': [`const f = (a, x) => { for (let i = 0; i < a.length; i++) { const t = a[i]; a[i] = t + x } }`, `f(a, X[p] * 1); f(b, Y[p] * 1)`],
  'an array of a length that never changes': [`const FIXED = [1, 2, 3, 4, 5, 6, 7, 8]
    const f = (o, i, j) => { const m = i & 7, n = j & 7; const t = FIXED[m]; FIXED[m] = FIXED[n]; FIXED[n] = t; o.s = FIXED[0] + FIXED[7] * 3 }
    const tally = { s: 0 }`, `f(tally, p, p * 3); a[0] = tally.s; f(tally, p + 2, 5); b[0] = tally.s`],
  'a typed array': [`const T = new Float64Array(6)
    const f = (a, i, j) => { const t = a[i]; a[i] = a[j]; a[j] = t }`, `T[1] = p; f(T, (X[p] * 1) & 7, (Y[p] * 1) & 7); a[0] = T[0] + T[2]; b[0] = T[1]`],
}
// (a path read ahead of the run throws where its object is missing, and so does the length of an array that is:
// a first access under a condition throws neither, and the member stored after it is stored before the run's
// store throws; `there` takes an object that is always there, its array not)
const conditional = `class Box { constructor(v) { this.v = v } }
  const f = (o, c, i, j) => c ? side(o.v[i]) + side(o.v[j]) * 2 + side(o.v[i]) * 4 : 0
  const g = (o, c, i, j) => { let r = 0; r = c ? side(o.v[i]) + side(o.v[j]) * 2 + side(o.v[i]) * 4 : 0; return r }
  const held = (o, q, c, i, j) => { const t = c ? o.v[i] : 7; q.s = t; o.v[j] = t; o.v[i] = 1 }
  const there = (o, q, c, i, j) => { const t = c ? o.v[i] : 7; q.s = t; o.v[j] = t; o.v[i] = 1 }
  const tally = { s: 0 }, none = new Box(null), some = new Box([4, 5, 6]), boxes = [none, some, null]
  export const go = () => { let h = 0
    for (let p = 0; p < 6; p++) { const o = p % 3 === 0 ? null : new Box(p % 3 === 1 ? null : [1, 2, 3]); try { h = h * 7 + f(o, p > 3, p % 3, 1) + g(o, p > 3, 1, p % 3) } catch (e) { h = h * 7 + 1000 } }
    // (the member is stored ahead of the store that throws: read after the throw, it says how far the run got)
    const seen = () => { const s = tally.s; tally.s = -1; return s === undefined ? 11 : s !== s ? 13 : s }
    for (let p = 0; p < 6; p++) { try { there(p % 2 === 0 ? none : some, tally, p > 2, p % 3, Y[p] * 1); h = (h * 7 + seen()) | 0 } catch (e) { h = (h * 7 + 2000 + seen()) | 0 } }
    for (let p = 0; p < 6; p++) { try { held(boxes[p % 3], tally, p > 2, p % 3, Y[p] * 1); h = (h * 7 + seen()) | 0 } catch (e) { h = (h * 7 + 3000 + seen()) | 0 } }
    return h }`

// (the guards the pass made, each function compiled as written: a call spliced in would be no call)
const guards = (src) => {
  compileInProcess(src, { optimize: { level: OPT_LEVEL, sourceInline: false, inlineFns: false } })
  let n = 0
  const walk = (node) => { if (!Array.isArray(node)) return; if (node.elementRun) n++; for (const c of node) walk(c) }
  for (const f of ctx.funcs.list) if (!f.raw && f.body != null) walk(f.body)
  return n
}

test('element runs: a run under its guard answers as the host over every index', () => {
  for (const [name, [funcs, call]] of Object.entries(kept)) {
    const src = HEAD + funcs + '\n' + OVER(call), want = oracle(src).go()
    for (const optimize of levels(0, 2, 3, 'size', 'speed')) is(run(src, { optimize }).go(), want, `${name} at ${optimize}`)
    if (!belowOpt(2)) ok(guards(src) > 0, `${name}: the run is guarded`)
  }
})

// A store the guard holds inside the length grows nothing: it asks nothing of the heap after it
// (compile/analyze/frame-effects.js boundedElements), so the function's escape tests are its growth calls'.
// A loop another pass copied keeps its run as written in the copy that runs where that pass's own guard fails.
test('element runs: a guarded store asks nothing of the heap, and a cold loop keeps its run as written', () => {
  if (belowOpt(2)) return
  const swap = HEAD + kept['a swap'][0] + '\n' + OVER(kept['a swap'][1])
  const body = funcWat(wat(swap, { optimize: { level: OPT_LEVEL, sourceInline: false, inlineFns: false } }), 'swap')
  const count = (re) => (body.match(re) || []).length
  ok(count(/call \$__arr_set_/g) > 0, 'the statements as written keep their growth')
  is(count(/call \$__esc_elem/g), count(/call \$__arr_set_/g), 'an escape test for each growth call and no other')
  const looped = HEAD + `const f = (a, i, j, n) => { for (let r = 0; r < n; r++) { const k = i + r; const t = a[k]; a[k] = a[j]; a[j] = t } }\n` + OVER(`f(a, X[p] * 1, Y[p] * 1, Y[p] * 1 + 1); f(b, Y[p] * 1, X[p] * 1, 2)`)
  is(run(looped).go(), oracle(looped).go(), 'the loop answers')
  is(guards(looped), 1, 'one guard: the copy over integers, not the loop as written beside it')
})

test('element runs: a run that may shrink, bind again or run code stays as written', () => {
  for (const [name, [funcs, call]] of Object.entries(left)) {
    const src = HEAD + funcs + '\n' + OVER(call), want = oracle(src).go()
    for (const optimize of levels(0, 2, 3, 'size', 'speed')) is(run(src, { optimize }).go(), want, `${name} at ${optimize}`)
  }
  // (a run no guard pays for or holds: counted, where an earlier pass leaves the statements as they are)
  if (!belowOpt(2)) for (const name of ['a typed array', 'a key that may be a string', 'a length stored', 'a name of the run read after it', 'reads alone', 'a run past the size a guard copies',
    'a run a canonical loop holds inside the length', 'an array of a length that never changes'])
    is(guards(HEAD + left[name][0] + '\n' + OVER(left[name][1])), 0, `${name}: no guard`)
  const want = oracle(HEAD + conditional).go()
  for (const optimize of levels(0, 2, 3, 'size', 'speed')) is(run(HEAD + conditional, { optimize }).go(), want, `an access under a condition, its object missing, at ${optimize}`)
})
