// Array element reads: a present element needs no nullish guard, a constant array
// reads without the hop, a grown array is rebound where it is held, a hole is tested
// once, and an untyped receiver reads inline at speed.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { onKernel, levels } from './_matrix.js'
import parseWat from 'watr/parse'
import { funcWat, run, oracle, jz, compile } from './util.js'
import { parse, loopCount, count, walk } from '../scripts/wat-probe.mjs'
import { findFunc, preWatr, exactToInt32 } from './_optimizer.js'

// `const p = ps[i]` under `i < ps.length` over a hole-free array reads a present
// element: the pointer stays raw and its field reads need no nullish guard.
test('an in-bounds element of a hole-free array is present: no nullish guards on its fields', () => {
  const src = `const mk = (n) => { const ps = []; for (let i = 0; i < n; i++) ps.push({ x: 0, vx: 1 }); return ps }
const step = (ps) => { for (let i = 0; i < ps.length; i++) { const p = ps[i]; p.x = p.x + p.vx } }
const run2 = (ps) => { for (let f = 0; f < 4; f++) step(ps) }
export let main = () => { const ps = mk(100); run2(ps); return ps[0].x }`
  const w = compile(src, { optimize: { level: 'size' }, wat: true })
  const main = findFunc(parseWat(w), '$main')
  is(loopCount(main, n => n[0] === 'call' && n[1] === '$__throw_property_nullish'), 0, 'loop element field reads need no nullish guard')
  ok(loopCount(main, n => n[0] === 'f64.load') >= 2, 'the hot loop still reads both object fields directly')
  ok(loopCount(main, n => n[0] === 'f64.store') > 0, 'the hot loop updates the object field directly')
  is(run(src).main(), 4)
})

test('array element presence: empty, hole, null, shrink and terminal reads keep their semantics', () => {
  const src = `export function f(n, mode) {
    const ps = []
    for (let i = 0; i < n; i++) ps.push({x:i+1, vx:2})
    if (mode === 1 && n) ps[0] = null
    if (mode === 2 && n) delete ps[mode-2]
    let visited = 0, total = 0
    try {
      for (let i = 0; i < ps.length; i++) {
        if (mode === 3) ps.length = 0
        const p = ps[i]
        total += p.x
        p.x += p.vx
        visited++
      }
      if (mode === 4) return ps[ps.length].x
      return [visited, total, n ? ps[0].x : 0, '']
    } catch(e) { return [visited, total, ps.length, e.name] }
  }`
  const expected = oracle(src)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const actual = run(src, {optimize})
    for (const [n, mode] of [[1,0], [1,0], [4,0], [1,0], [0,0], [0,3], [1,1], [4,2], [4,3], [0,4], [1,4], [1,0]])
      is(actual.f(n,mode), expected.f(n,mode), `O${optimize}: n=${n}, mode=${mode}`)
  }
})

// A constant array literal indexed in place (prepare hoists it to a static const)
// reads without the forwarding hop, the length load or the bounds test when the
// index's integer hull stays under the literal's length; a named static const
// is an array of fixed length (the summary's `lens`) and reads the same way.
test('static const array reads fold: inline literal under a mask is one load, a named const drops the hop', () => {
  const src = `const T = [2, 4, 2, 9]
export let f = (k) => T[k & 3]
export let g = (k) => [2, 4, 2, 9][k & 3]
export let h = (k) => [1, 2, 3][k & 3]`
  const w = compile(src, { optimize: exactToInt32('speed'), wat: true })
  const gw = funcWat(w, 'g'), fw = funcWat(w, 'f'), hw = funcWat(w, 'h')
  ok(!/__ptr_offset_fwd|i32\.lt_u|\(if/.test(gw) && (gw.match(/f64\.load/g) ?? []).length === 1, 'inline literal: the load alone')
  ok(!/__ptr_offset_fwd|i32\.lt_u|\(if/.test(fw) && (fw.match(/f64\.load/g) ?? []).length === 1, 'named const: the load alone as well')
  ok(/i32\.lt_u/.test(hw), 'a hull past the length keeps the test')
  const { f, g, h } = run(src), ref = oracle(src)
  for (const k of [0, 1, 2, 3, 5, -1, 4294967295]) { is(f(k), ref.f(k)); is(g(k), ref.g(k)); is(h(k), ref.h(k)) }
})

// An element read on a receiver the summary cannot type reads the array arm
// inline at the speed tier (tag, one forwarding hop, bounds, load) and calls
// the helper at the size tier, whose bytes the size gate reads.
test('unknown-receiver element reads: inline array arm at speed, the helper at size', () => {
  const src = `export let at = (node, i) => node[i | 0]`
  // Pin JZ's array-arm choice before watr can inline unrelated dictionary arms.
  const speed = funcWat(compile(src, { optimize: preWatr('speed'), wat: true }), 'at')
  const size = funcWat(compile(src, { optimize: preWatr('size'), wat: true }), 'at')
  // (the slot read as bits: the hole test compares them, so the load may be i64)
  ok(/__ptr_offset_fwd/.test(speed) && /[fi]64\.load/.test(speed) && /i32\.lt_u/.test(speed) && !/call \$__arr_value/.test(speed), 'speed: the array arm inline')
  ok(!/f64\.load/.test(size) && !/i32\.lt_u/.test(size) && /call \$__typed_idx/.test(size), 'size: the helper alone')
  is(run(src).at([5, 6, 7], 1), 6)
  is(run(src, { optimize: 'size' }).at([5, 6, 7], 2), 7)
})

test('a grown array read from a slot is rebound there', () => {
  // `o.xs.push(v)` that outgrows its storage moves the array; the field is
  // rebound to the moved header, as a named receiver is, so its reads skip the
  // forwarding chase.
  if (onKernel()) return
  const srcs = {
    field: `const o = { xs: [], n: 0 }
export let fill = (k) => { for (let i = 0; i < k; i++) o.xs.push(i) }
export let at = (i) => o.xs[i] + o.xs.length`,
    cached: `const o = { xs: [], n: 0 }
export let fill = (k) => { for (let i = 0; i < k; i++) { if (o.xs.length === 0) o.n = 1; o.xs.push(i) } }
export let at = (i) => o.xs[i] + o.xs.length`,
    element: `const rows = [[], [], []]
export let fill = (k) => { for (let i = 0; i < k; i++) for (let j = 0; j < 3; j++) rows[j].push(i) }
export let at = (i) => rows[1][i] + rows[1].length`,
  }
  // (a push stored in place grows through `__arr_room`, module/array.js)
  const grow = m => m[0] === 'call' && /^\$__arr_(?:grow|room)/.test(m[1])
  const has = (n, pred) => { let f = false; walk(n, m => { if (pred(m)) f = true }); return f }
  for (const [name, src] of Object.entries(srcs)) {
    // a void export's body inlines into its boundary entry
    const tree = parse(src, { level: 'speed' }), fn = findFunc(tree, '$fill') ?? findFunc(tree, '$fill$exp')
    // the innermost arms that grow: each stores the moved pointer back
    const arms = []
    walk(fn, n => { if (n[0] === 'then' && has(n, grow) && !n.slice(1).some(c => Array.isArray(c) && has(c, m => m[0] === 'then' && has(m, grow)))) arms.push(n) })
    ok(arms.length > 0, `${name}: the push grows in an arm of its own`)
    ok(arms.every(a => has(a, m => m[0] === 'f64.store' || m[0] === 'i64.store')), `${name}: the grow rebinds its slot`)
    for (const level of [0, 2, 'speed']) {
      const e = jz(src, { optimize: { level } }).exports
      e.fill(100)
      is(e.at(57), 157, `${name} O${level}`)
    }
  }
})

test('a holey cell read as a number is tested once', () => {
  // A hole reads undefined and undefined converts to NaN: both are NaNs, so a
  // numeric read keeps the cell as stored and tests it once for NaN, hit arm
  // of a bounds check included; what it yields is NaN, never the box.
  if (onKernel()) return
  const src = `const o = { s: [0, 1, 2, 3, 4, 5] }
export let grow = (m) => { o.s.length = m }
export let f = (n) => { const s = o.s; let t = 0; for (let k = 0; k < n; k++) t += s[1] * s[2] - s[k]; return t }
export let g = (k) => { const s = o.s; return s[k] * 2 }`
  const tomb = n => n[0] === 'i64.const' && /^0x7FF87FFFFFFFFFFF$/i.test(String(n[1]))
  is(count(findFunc(parse(src, { level: 'speed' }), '$f'), tomb), 0, 'no hole test before the number test')
  // a typed array has no holes: its reads keep the undefined test the optimizer clears (heapsort's sift)
  const typed = `const sift = (a, n) => {
  let i = 0, child = 1, c = 0
  while (child < n) {
    if (child + 1 < n && a[child] < a[child + 1]) child++
    if (a[i] >= a[child]) break
    const t = a[i]; a[i] = a[child]; a[child] = t
    i = child; child = 2 * i + 1; c++
  }
  return c
}
export let h = (n) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = (i * 7919) % 13; return sift(a, a.length) }`
  const nanTest = n => n[0] === 'select' && Array.isArray(n[2]) && n[2][0] === 'f64.const' && n[2][1] === 'nan'
  is(count(parse(typed, { level: 'speed' }), nanTest), 0, 'a typed read takes no hole-fused test')
  is(jz(typed, { optimize: { level: 'speed' } }).exports.h(64), (() => { const a = new Float64Array(64); for (let i = 0; i < 64; i++) a[i] = (i * 7919) % 13; let i = 0, child = 1, c = 0; while (child < 64) { if (child + 1 < 64 && a[child] < a[child + 1]) child++; if (a[i] >= a[child]) break; const t = a[i]; a[i] = a[child]; a[child] = t; i = child; child = 2 * i + 1; c++ } return c })(), 'sift')
  for (const level of [0, 2, 'speed']) {
    const e = jz(src, { optimize: { level } }).exports
    e.grow(10)
    is(e.f(3), 3, `in bounds O${level}`)
    ok(Number.isNaN(e.f(8)), `a hole reads NaN O${level}`)
    ok(Number.isNaN(e.g(7)), `a hole doubles to NaN O${level}`)
    ok(Number.isNaN(e.g(20)), `past the end O${level}`)
  }
})
