// Counted loops in the forms the canonical scaffold refuses, lifted through the one description
// of a loop (src/optimize/vectorize/scaffold.js describeLoop, stripScaffold) and the one
// legality: a test shifted by a constant (`i + 1 < n`), an inclusive test (`i <= n`), a loop
// counting down (`i >= 0`, `i > lo`), a lane local every pass writes, read after the loop, and
// two counters at 'speed'. Each lifts at the levels this leg owns and answers what Node
// answers, in its result and in the arrays it writes; the forms the scout's census found
// refused (.work/maps/loop-refused.md) are named by their row. Beside them, a true dependence
// that no lift may take.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { compile, jz, oracle } from './util.js'

const fnOf = (w, name) => { const i = w.indexOf(`(func $${name}`), j = w.indexOf('\n  (func ', i + 8); return w.slice(i, j < 0 ? undefined : j) }
const SIMD = /v128|[if](?:8x16|16x8|32x4|64x2)\./
// One program over three arrays of a type, its kernel `k` taking the bound from the array (the
// census's setting B: an integer the emitter knows, so the counter is a word).
const prog = (T, body) => `const a = new ${T}(64), b = new ${T}(64), c = new ${T}(64)
export let init = () => { for (let i = 0; i < 64; i++) { a[i] = (i * 37 % 23) - 11; b[i] = i % 7; c[i] = (i * 5 % 9) - 4 } }
export let k = () => { const n = a.length - 3; ${body} }
export let check = () => { let h = 0; for (let i = 0; i < 64; i++) h = (h * 31 + a[i] * 3 + b[i]) % 1000003; return h }`
const lifts = (name, src, at = levels(2, 3)) => {
  for (const optimize of at) {
    ok(SIMD.test(fnOf(compile(src, { optimize, wat: true }), 'k')), `${name}: lifted at ${optimize}`)
    const want = oracle(src), got = jz(src, { optimize }).exports
    want.init(); got.init()
    is(got.k(), want.k(), `${name}: k at ${optimize}`)
    is(got.check(), want.check(), `${name}: memory at ${optimize}`)
  }
}
const stays = (name, src) => {
  for (const optimize of levels(2, 3)) {
    ok(!SIMD.test(fnOf(compile(src, { optimize, wat: true }), 'k')), `${name}: scalar at ${optimize}`)
    const want = oracle(src), got = jz(src, { optimize }).exports
    want.init(); got.init()
    is(got.k(), want.k(), `${name}: k at ${optimize}`)
    is(got.check(), want.check(), `${name}: memory at ${optimize}`)
  }
}
const TYPES = ['Float64Array', 'Int32Array', 'Uint8Array']

test('loop forms: a test shifted by a constant (rows 1, 2)', () => {
  if (belowOpt(2)) return
  for (const T of TYPES) {
    lifts(`${T} i + 1 < n`, prog(T, 'for (let i = 0; i + 1 < n; i++) b[i] = a[i + 1] + a[i]; return 0'))
    lifts(`${T} stencil, i + 1 < n`, prog(T, 'for (let i = 1; i + 1 < n; i++) b[i] = a[i - 1] + a[i] * 2 + a[i + 1]; return 0'))
    lifts(`${T} in place, i + 2 < n`, prog(T, 'for (let i = 0; i + 2 < n; i++) a[i] = a[i + 2] - a[i]; return 0'))
  }
})

test('loop forms: an inclusive test (row 11a)', () => {
  if (belowOpt(2)) return
  for (const T of TYPES) {
    lifts(`${T} i <= n`, prog(T, 'for (let i = 0; i <= n; i++) b[i] = a[i] + 1; return 0'))
    lifts(`${T} in place, i <= n`, prog(T, 'for (let i = 0; i <= n; i++) a[i] = a[i + 1] * 2; return 0'))
  }
})

test('loop forms: a loop counting down (row 3)', () => {
  if (belowOpt(2)) return
  for (const T of TYPES) {
    lifts(`${T} i >= 0`, prog(T, 'for (let i = n - 1; i >= 0; i--) b[i] = a[i] + 1; return 0'))
    lifts(`${T} i > lo`, prog(T, 'for (let i = n; i > 5; i--) b[i] = a[i] + 3; return 0'))
    lifts(`${T} b[i] = a[i + 1] - a[i] down`, prog(T, 'for (let i = n - 1; i >= 0; i--) b[i] = a[i + 1] - a[i]; return 0'))
  }
  // a recurrence in place, the value read stored a strip or more before (two lanes of f64,
  // four of i32), and one a strip of four lanes would read before its store: scalar
  lifts('Float64Array a[i] = a[i + 2] * 2 down', prog('Float64Array', 'for (let i = n - 3; i >= 0; i--) a[i] = a[i + 2] * 2; return 0'))
  lifts('Int32Array a[i] = a[i + 4] * 2 down', prog('Int32Array', 'for (let i = n - 5; i >= 0; i--) a[i] = a[i + 4] * 2; return 0'))
  stays('Int32Array a[i] = a[i + 2] * 2 down', prog('Int32Array', 'for (let i = n - 3; i >= 0; i--) a[i] = a[i + 2] * 2; return 0'))
  lifts('Float64Array a sum down', prog('Float64Array', 'let s = 0; for (let i = n - 1; i >= 0; i--) s += a[i] * c[i]; return s'))
  lifts('Int32Array a maximum down', prog('Int32Array', 'let m = -100; for (let i = n - 1; i >= 0; i--) m = a[i] > m ? a[i] : m; return m'))
})

test('loop forms: a lane local every pass writes, read after the loop (row 6)', () => {
  if (belowOpt(2)) return
  lifts('t read after', prog('Float64Array', 'let t = 0; for (let i = 0; i < n; i++) { t = a[i] * 2; b[i] = t + 1 } return t'))
  lifts('t read after, counting down', prog('Float64Array', 'let t = 0; for (let i = n - 1; i >= 0; i--) { t = a[i] * 2; b[i] = t + 1 } return t'))
  lifts('t read after, i <= n', prog('Float64Array', 'let t = 0; for (let i = 0; i <= n; i++) { t = a[i] - 1; b[i] = t } return t + n'))
})

test('loop forms: two counters at speed (row 12)', () => {
  if (belowOpt(3)) return
  lifts('i++, k++', prog('Float64Array', 'let s = 0; for (let i = 0, k = 0; i < n; i++, k++) s += a[i] * c[k]; return s'), levels(3))
})

test('loop forms: a true dependence stays scalar (row 7b)', () => {
  if (belowOpt(2)) return
  // iteration 0 stores b[0]; every later one reads the new b[0]
  for (const T of TYPES) stays(`${T} b[i] = a[i] * b[0]`, prog(T, 'for (let i = 0; i < n; i++) b[i] = a[i] * b[0]; return 0'))
})
