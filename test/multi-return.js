// Phase 2: Multi-value return tests
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { run, wat, funcWat, oracle } from './util.js'
import { levels } from './_matrix.js'
import parseWat from 'watr/parse'


// Multi-value just works — no profile needed

test('multi-return: just works', () => {
  const { f } = run('export let f = (a, b) => [a, b]')
  ok(f)
})

// === Expression body multi-return ===

test('multi: 2-value return', () => {
  const { f } = run('export let f = (a, b) => [a + 1, b * 2]')
  const [x, y] = f(3, 5)
  is(x, 4)
  is(y, 10)
})

test('multi: 3-value return', () => {
  const { f } = run('export let f = (a, b, c) => [a * 2, b * 3, c * 4]')
  const [x, y, z] = f(1, 2, 3)
  is(x, 2)
  is(y, 6)
  is(z, 12)
})

test('multi: identity', () => {
  const { f } = run('export let f = (a, b) => [a, b]')
  const [x, y] = f(42, 99)
  is(x, 42)
  is(y, 99)
})

// === Block body multi-return ===

test('multi: block body return', () => {
  const { f } = run(`export let f = (x) => {
    let y = x * 2
    return [x, y]
  }`)
  const [a, b] = f(5)
  is(a, 5)
  is(b, 10)
})

test('multi: block body with if', () => {
  const { f } = run(`export let f = (x) => {
    if (x > 0) return [x, 1]
    return [-x, -1]
  }`)
  const [a, b] = f(5)
  is(a, 5)
  is(b, 1)
  const [c, d] = f(-3)
  is(c, 3)
  is(d, -1)
})

// === Color-space pattern ===

test('multi: rgb2xyz pattern', () => {
  const { rgb2xyz } = run(`export let rgb2xyz = (r, g, b) => [
    r * 0.4124 + g * 0.3576 + b * 0.1805,
    r * 0.2126 + g * 0.7152 + b * 0.0722,
    r * 0.0193 + g * 0.1192 + b * 0.9505
  ]`)
  const [x, y, z] = rgb2xyz(1, 1, 1)
  // Sum of coefficients for each row
  ok(Math.abs(x - 0.9505) < 0.001)
  ok(Math.abs(y - 1.0) < 0.001)
  ok(Math.abs(z - 1.089) < 0.001)
})

// === Single-value still works in multi profile ===

test('multi profile: single return still works', () => {
  const { f } = run('export let f = (a, b) => a + b')
  is(f(2, 3), 5)
})

test('multi profile: block single return', () => {
  const { f } = run(`export let f = (x) => {
    let y = x * 2
    return y
  }`)
  is(f(5), 10)
})


test('multi: conditional tuple arms share the existing multiple-result ABI', () => {
  const src = `export const pair = n => n > 0 ? [n, 1] : n < 0 ? [-n, -1] : [0, 0]
    export function mixed(n) { return n ? [false, 7n, 'yes', -0] : [true, -9n, 'no', undefined] }
    export const limit = n => n ? [1,2,3,4,5,6,7,8] : [8,7,6,5,4,3,2,1]
    export function indirect(n) { const f = pair; return f.call(null, n) }
    export function retained(n) { const a = pair(n), b = pair(n); a[0] = 99; return [a[0], b[0], a !== b] }
    export function consumed(n) { const [a, b] = pair(n); return a * 10 + b }`
  const host = oracle(src)
  const body = funcWat(wat(src, { optimize: { level: 2, watr: false } }), 'pair')
  is(parseWat(body).filter(n => n[0] === 'result').length, 2, 'two result lanes')
  ok(!/__alloc_hdr|__arr_new/.test(body), 'the tuple producer allocates no array')
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const ex = run(src, { optimize })
    for (const n of [0, 0, 1, -2, 0]) for (const name of ['pair', 'mixed', 'limit', 'indirect', 'retained', 'consumed'])
      is(ex[name](n), host[name](n), `${name}(${n}) O${optimize}`)
    ok(Object.is(ex.mixed(1)[3], -0), 'negative zero survives the element carrier')
  }
})

test('multi: conditional tuples preserve selected evaluation and finalizers', () => {
  const src = `let trace = 0
    function mark(n) { trace = trace * 10 + n; return n }
    function pair(n) {
      try { if (n >= 0) return mark(n) === 1 ? [mark(2), mark(3)] : [mark(4), mark(5)] }
      finally { mark(6) }
      return [mark(7), mark(8)]
    }
    export function run(n) { trace = 0; const [a, b] = pair(n); return [a, b, trace] }
    export function override(n) { try { return n ? [1, 2] : [3, 4] } finally { return [7, 8] } }
    function fail() { throw new Error('selected') }
    export function selected(n) { return n ? [1, 2] : [fail(), 3] }`
  const host = oracle(src)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const ex = run(src, { optimize })
    for (const n of [1, 1, 0, -1, 2, 1]) {
      is(ex.run(n), host.run(n), `selected effects and finally, O${optimize}`)
      is(ex.override(n), [7, 8], 'finally overrides the tuple return')
    }
    is(ex.selected(1), [1, 2], 'the other arm does not throw')
    throws(() => ex.selected(0), /selected/)
    is(ex.selected(1), [1, 2], 'a subsequent call still returns both lanes')
  }
})

test('multi: incompatible conditional arrays retain array results', () => {
  const src = `export function fallthrough(n) { if (n) return n > 0 ? [1, 2] : [3, 4] }
    export function literalFallthrough(n) { if (n) return [1, 2] }
    export function bare(n) { if (!n) return; return n > 0 ? [1, 2] : [3, 4] }
    export const empty = n => n ? [] : [1, 2]
    export const single = n => n ? [1] : [2]
    export const uneven = n => n ? [1, 2] : [3, 4, 5]
    export const wide = n => n ? [1,2,3,4,5,6,7,8,9] : [9,8,7,6,5,4,3,2,1]
    export const spread = (n, a) => n ? [1, ...a] : [2, 3]`
  const host = oracle(src)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const ex = run(src, { optimize })
    for (const name of Object.keys(host)) for (const n of [0, 1, 0])
      is(ex[name](n, [6, 7]), host[name](n, [6, 7]), `${name}(${n}) O${optimize}`)
  }
})
