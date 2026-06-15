// Compile-time advisories (opts.warnings / ctx.warn). See .work/todo.md.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, onWasi } from './_matrix.js'
import jz, { compile } from '../index.js'

function warningsFor(code, opts = {}) {
  const warnings = { entries: [] }
  compile(code, { ...opts, warnings })
  return warnings.entries
}

test('warnings: no sink → no advisories emitted', () => {
  is(warningsFor('export let f = () => [1, 2, 3]').length, 0)
})

test('warnings: heap-return on exported pointer result', () => {
  const ws = warningsFor('export let f = () => { let a = [1, 2, 3]; return a }')
  is(ws.length, 1)
  is(ws[0].code, 'heap-return')
  ok(/memory\.reset\(\)/.test(ws[0].message))
})

test('warnings: small inline array return is scalarized — no heap advisory', () => {
  is(warningsFor('export let f = () => [1, 2, 3]').length, 0)
})

test('warnings: heap-loop when a loop body allocates', () => {
  const ws = warningsFor(`
    export let f = (n) => {
      let xs = []
      for (let i = 0; i < n; i++) xs.push(i)
      return xs.length
    }
  `)
  is(ws.length, 1)
  is(ws[0].code, 'heap-loop')
})

test('warnings: arena-rewind-skipped on parametric export that allocates', () => {
  const ws = warningsFor('export let f = (n) => { let xs = []; xs.push(n); return xs.length }')
  is(ws.length, 1)
  is(ws[0].code, 'arena-rewind-skipped')
})

test('warnings: arena-rewindable zero-arg scalar export stays quiet', () => {
  const ws = warningsFor('export let f = () => { let a = [1, 2, 3]; return a.length }')
  is(ws.length, 0)
})

test('warnings: pure scalar module stays quiet', () => {
  is(warningsFor('export let add = (a, b) => a + b').length, 0)
})

test('warnings: deopt-generic when an unresolved global is indexed in a loop', () => {
  // `g` assigned from an opaque param never resolves to a container → every `g[i]`
  // is runtime dynamic dispatch (the waves-class cliff). The advisory surfaces it.
  const ws = warningsFor(`
    let g
    export let init = (x) => { g = x }
    export let f = (w) => { let s = 0.0, i = 0; while (i < w) { s = s + g[i]; i++ } return s }
  `)
  is(ws.filter(e => e.code === 'deopt-generic').length, 1)
})

test('warnings: deopt-generic stays quiet when the global resolves to a typed array', () => {
  // The fix for the waves swap means a typed global (even ping-ponged) is proven —
  // no dynamic dispatch, no advisory. Pins the no-false-positive boundary.
  const typed = warningsFor(`
    let a, b
    export let init = (n) => { a = new Float64Array(n); b = new Float64Array(n) }
    export let f = (w) => { let s = 0.0, i = 0; while (i < w) { s = s + a[i] + b[i]; i++ } let t = a; a = b; b = t; return s }
  `)
  is(typed.filter(e => e.code === 'deopt-generic').length, 0)
})

test('warnings: deopt-generic suppressed when the global is instanceof-guarded', () => {
  // The user did the recommended fix — `g instanceof Float64Array` narrows the read
  // to a typed load (lowered to `__is_typed(g)` by jzify). Flagging it would be noise.
  const ws = warningsFor(`
    let g
    export let init = (x) => { g = x }
    export let f = (w) => {
      if (g instanceof Float64Array) { let s = 0.0, i = 0; while (i < w) { s = s + g[i]; i++ } return s }
      return 0.0
    }
  `)
  is(ws.filter(e => e.code === 'deopt-generic').length, 0)
})

test('warnings: strict mode errors on a generic-dispatch deopt', () => {
  // Strict already rejects dynamic features; a hot-loop generic index is one.
  let threw = false
  try {
    compile(`let g; export let init = (x) => { g = x }; export let f = (w) => { let s = 0.0, i = 0; while (i < w) { s = s + g[i]; i++ } return s }`,
      { strict: true })
  } catch (e) { threw = /strict mode:.*dynamic dispatch/.test(e.message) }
  ok(threw, 'strict mode must error on a loop-hot generic index')
})

test('warnings: alloc:false modules stay quiet', () => {
  const ws = warningsFor('export let f = () => [1, 2, 3]', { alloc: false })
  is(ws.length, 0)
})

test('warnings: jz() surfaces advisories on the runtime result', () => {
  const warnings = { entries: [] }
  const { warnings: surfaced } = jz('export let f = () => { let a = [1]; return a }', { warnings })
  is(surfaced.length, 1)
  is(surfaced[0].code, 'heap-return')
})

test('warnings: untagged instanceof on Error types (jzify)', () => {
  const ws = warningsFor('export let f = (e) => e instanceof TypeError', { jzify: true })
  is(ws.length, 1)
  is(ws[0].code, 'untagged-instanceof')
})

test('warnings: set-map-order on JSON.stringify(map)', () => {
  const ws = warningsFor('export let f = () => JSON.stringify(new Map())')
  is(ws.length, 1)
  is(ws[0].code, 'set-map-order')
})

test('warnings: jsstring-declined when concat blocks externref carrier', () => {
  if (onWasi()) return  // wasi: jsstring externref interop
  if (belowOpt(2)) return  // jsstring ABI (and its decline advisory) is engaged at optimize >= 2
  const ws = warningsFor(`export let f = (s = '') => s + '!'`)
  is(ws.length, 1)
  is(ws[0].code, 'jsstring-declined')
  ok(/concatenation/.test(ws[0].message))
})

test('warnings: jsstring-declined when param is reassigned', () => {
  if (onWasi()) return  // wasi: jsstring externref interop
  if (belowOpt(2)) return  // jsstring ABI (and its decline advisory) is engaged at optimize >= 2
  const ws = warningsFor(`export let f = (s = '') => { s = s; return s.length }`)
  is(ws.length, 1)
  is(ws[0].code, 'jsstring-declined')
  ok(/reassign/.test(ws[0].message))
})

test('warnings: simd-loop-carried on reduction-style loop', () => {
  if (belowOpt(2)) return  // advisory only emitted when vectorizeLaneLocal runs (optimize >= 2)
  const ws = warningsFor(`
    export let f = (xs) => {
      let s = 0
      for (let i = 0; i < xs.length; i++) s ^= xs[i]
      return s
    }
  `)
  ok(ws.some(w => w.code === 'simd-loop-carried'))
})

test('warnings: simd-aos-stride on interleaved index', () => {
  if (belowOpt(2)) return  // advisory only emitted when vectorizeLaneLocal runs (optimize >= 2)
  const ws = warningsFor(`
    export let f = (a) => {
      for (let i = 0; i < 10; i++) a[i * 3] = 1
      return 0
    }
  `)
  ok(ws.some(w => w.code === 'simd-aos-stride'))
})

test('warnings: int-global-truncation when a scalar global is i32-narrowed from a param', () => {
  // jz infers integer module globals to i32 (the size/index/stride perf win). A
  // scalar global fed from a parameter may hold a fractional Number (DSP state) that
  // the i32 carrier truncates — surfaced as an opt-in advisory (not demoted: the
  // integer default is load-bearing; structurally identical to the rfft `N = n` win).
  const ws = warningsFor(`let x1 = 0, y1 = 0
    export let process = (inp, b0) => { let out = b0 * inp + x1; x1 = inp; y1 = out; return out }`)
  const trunc = ws.filter(w => w.code === 'int-global-truncation')
  ok(trunc.length >= 1, 'fires for a param-fed i32-narrowed global')
  ok(/Float64Array/.test(trunc[0].message), 'points to Float64Array for fractional state')
})

test('warnings: no int-global-truncation for a self-contained integer counter', () => {
  // `n = n + 1` references no parameter → no advisory (avoids false alarms on pure counters).
  const ws = warningsFor('let n = 0; export let next = () => { n = n + 1; return n }')
  is(ws.filter(w => w.code === 'int-global-truncation').length, 0)
})
