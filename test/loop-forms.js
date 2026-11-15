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
    const at = typeof optimize === 'object' ? JSON.stringify(optimize) : optimize
    ok(SIMD.test(fnOf(compile(src, { optimize, wat: true }), 'k')), `${name}: lifted at ${at}`)
    const want = oracle(src), got = jz(src, { optimize }).exports
    want.init(); got.init()
    is(got.k(), want.k(), `${name}: k at ${at}`)
    is(got.check(), want.check(), `${name}: memory at ${at}`)
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
  // (a float sum adds in lanes where the floats are relaxed: at 'speed', or by the option)
  lifts('Float64Array a sum down', prog('Float64Array', 'let s = 0; for (let i = n - 1; i >= 0; i--) s += a[i] * c[i]; return s'), levels({ level: 2, relaxedFloat: true }, 3))
  lifts('Int32Array a maximum down', prog('Int32Array', 'let m = -100; for (let i = n - 1; i >= 0; i--) m = a[i] > m ? a[i] : m; return m'))
})

test('loop forms: the strips of a loop counting down stop at its low end', () => {
  if (belowOpt(2)) return
  // A strip runs while its lane base, the lowest iteration it holds, is at the low end or above
  // it: to a constant end the test is against a constant, the base's interval known in the strip.
  for (const optimize of levels(2, 3)) {
    const w = fnOf(compile(prog('Float64Array', 'for (let i = n - 1; i >= 0; i--) b[i] = a[i] + 1; return 0'), { optimize, wat: true }), 'k')
    ok(/\(br_if \$__simd_brk\d+\s+\(i32\.le_s \(local\.get \$[^\s)]+\) \(i32\.const -1\)\)/.test(w), `the lane base against the end, at ${optimize}`)
  }
  // One lane base per strip W below the last: a low end within W of -2^31 would wrap the next
  // base past it, a counter within W - 1 of it has no base.
  const MIN = -(2 ** 31)
  const src = (T, body) => `const a = new ${T}(48), b = new ${T}(48)
export let f = (hiIn, loIn) => {
  const hi = hiIn | 0, lo = loIn | 0
  for (let k = 0; k < 48; k++) { a[k] = (k * 37 % 23) - 11; b[k] = k % 7 }
  let s = 0
  ${body}
  let h = 0; for (let k = 0; k < 48; k++) h = (h * 31 + a[k] * 3 + b[k]) % 1000003
  return h + s
}`
  for (const T of TYPES) for (const body of ['for (let i = hi; i > lo; i--) b[i - lo] = a[i - lo] * 2', 'for (let i = hi; i > lo; i--) b[i - lo] = a[i - lo + 1] - a[i - lo]']) {
    const p = src(T, body), want = oracle(p)
    for (const optimize of levels(2, 3)) {
      ok(SIMD.test(fnOf(compile(p, { optimize, wat: true }), 'f')), `${T} ${body}: lifted at ${optimize}`)
      const got = jz(p, { optimize }).exports
      for (const lo of [MIN, MIN + 1, MIN + 3, -2, 0]) for (const d of [-1, 0, 1, 2, 3, 4, 5, 15, 16, 17, 33])
        is(got.f(lo + d, lo), want.f(lo + d, lo), `${T} ${body}: ${lo + d} down to ${lo} at ${optimize}`)
    }
  }
})

test('loop forms: a reduction carried in its order, the work of each element in lanes', () => {
  if (belowOpt(2)) return
  // No relaxed floats: each pass's two lanes are taken out and carried in the loop's order, so
  // the sum or product is the loop's bit for bit (test/spellings.js: every dot spelling at 2).
  const exact = levels(2, { level: 'speed', relaxedFloat: false })
  const F = (body) => prog('Float64Array', body)
  lifts('dot', F('let s = 0; for (let i = 0; i < n; i++) s += a[i] * b[i]; return s'), exact)
  lifts('dot counting down', F('let s = 0; for (let i = n - 1; i >= 0; i--) s += a[i] * b[i]; return s'), exact)
  lifts('dot through an index temp', F('let s = 0; for (let i = 0; i < n; i++) { const j = i; s += a[j] * b[j] } return s'), exact)
  lifts('two sums of one load', F('let s = 0, t = 0; for (let i = 0; i < n; i++) { s += a[i] * b[i]; t += a[i] * c[i] } return s - t'), exact)
  lifts('sum of absolute differences', F('let s = 0; for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[i]); return s'), exact)
  lifts('sum of minima', F('let s = 0; for (let i = 0; i < n; i++) s += Math.min(a[i], b[i]); return s'), exact)
  lifts('product of sums', F('let p = 1; for (let i = 0; i < n; i++) p *= (a[i] + c[i]) * 0.125 + 1; return p'), exact)
  lifts('product of sums counting down', F('let p = 1; for (let i = n - 1; i >= 0; i--) p *= (a[i] + c[i]) * 0.125 + 1; return p'), exact)
  // an integer or f32 element widened to the f64 the sum carries
  for (const T of ['Int32Array', 'Int16Array', 'Float32Array'])
    lifts(`${T} dot into an f64`, prog(T, 'let s = 0; for (let i = 0; i < n; i++) s += a[i] * c[i]; return s'), exact)
  // a math call whose mirror runs both lanes through the scalar kernel's own operations, one
  // evaluation for two: the answer is that kernel's, jz's math runtime (Node's own Math need
  // not match it to the last bit, so the reference is the build with no optimization)
  for (const [name, body] of [
    ['sum of logs', 'let s = 0; for (let i = 0; i < n; i++) s += Math.log(c[i] + 5); return s'],
    ['sum of exps', 'let s = 0; for (let i = 0; i < n; i++) s += Math.exp(a[i] * 0.25); return s'],
    ['sines times an element', 'let s = 0; for (let i = 0; i < n; i++) s += Math.sin(a[i]) * b[i]; return s'],
    ['sum of powers', 'let s = 0; for (let i = 0; i < n; i++) s += Math.pow(c[i] + 5, 1.5); return s'],
  ]) {
    const src = F(body), want = jz(src, { optimize: false }).exports
    want.init()
    for (const optimize of exact) {
      const at = JSON.stringify(optimize)
      ok(SIMD.test(fnOf(compile(src, { optimize, wat: true }), 'k')), `${name}: lifted at ${at}`)
      const got = jz(src, { optimize }).exports
      got.init()
      is(got.k(), want.k(), `${name}: k at ${at}`)
    }
  }
  // a plain sum has no work of an element to lift: the lanes would add a read of them and of the sum a pass to save a load
  for (const optimize of exact) {
    const src = F('let s = 0; for (let i = 0; i < n; i++) s += a[i]; return s')
    ok(!SIMD.test(fnOf(compile(src, { optimize, wat: true }), 'k')), `a plain sum stays scalar at ${JSON.stringify(optimize)}`)
  }
})

test('loop forms: a copy or a fill counting down moves its bytes at once', () => {
  if (belowOpt(2)) return
  // memory.copy is memmove, which a loop counting down is wherever its source does not start
  // inside its destination's window: the overlap test keeps the loop for that case
  for (const T of TYPES) for (const [name, body] of [
    ['copy', 'for (let i = n - 1; i >= 0; i--) b[i] = a[i]; return 0'],
    ['copy to a low end past 0', 'for (let i = n; i > 3; i--) b[i] = a[i]; return 0'],
    ['fill', 'for (let i = n - 1; i >= 2; i--) b[i] = 0; return 0'],
    ['copy, the counter read after', 'let i = n - 1; while (i >= 0) { b[i] = a[i]; i-- } return i'],
  ]) {
    const src = prog(T, body), want = oracle(src)
    for (const optimize of levels(2, 3)) {
      ok(/memory\.(copy|fill)/.test(fnOf(compile(src, { optimize, wat: true }), 'k')), `${T} ${name}: a bulk move at ${optimize}`)
      const got = jz(src, { optimize }).exports
      want.init(); got.init()
      is(got.k(), want.k(), `${T} ${name}: k at ${optimize}`)
      is(got.check(), want.check(), `${T} ${name}: memory at ${optimize}`)
    }
  }
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
