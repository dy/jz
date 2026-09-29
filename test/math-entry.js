// The scalar math kernels' constants and entries (module/math.js): every kernel reads its
// f64 literals from memory ($math.kc), 0, ±Infinity and NaN aside; $math.exp and
// $math.exp2 answer NaN, an overflow and an underflow behind one test and round
// k = round(64x/ln2) by adding 1.5·2^52; $math.log and $math.log10 answer their edges
// behind one test and centre the mantissa on √2 by a select. None of it changes a bit:
// each kernel still agrees with its constant-folder twin (src/prepare/math-kernel.js
// MATH_KERNEL), checked here at the edges those tests move, at every optimize level
// (level 3 lifts the loops to the two-lane kernels, bit-exact with the scalar ones), with
// the host within an ulp for exp and exp2 and within test/math-ulp.js's bounds for the
// logarithms.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { levels, belowOpt } from './_matrix.js'
import { oracle, ulpDiff, wat, funcWat } from './util.js'
import { MATH_KERNEL } from '../src/prepare/math-kernel.js'

const same = (a, b) => Object.is(a, b) || (a !== a && b !== b)
let seed = 0x2545f491
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296 }
const sgn = (x) => rnd() < 0.5 ? -x : x
const logU = (lo, hi) => (1 + rnd()) * 2 ** Math.floor(lo + rnd() * (hi - lo))
const EXTREME = [0, -0, NaN, Infinity, -Infinity, 5e-324, -5e-324, 2.2250738585072014e-308, 2.225073858507201e-308,
  1.7976931348623157e308, -1.7976931348623157e308, 1, -1, 0.5]
const CASES = {
  exp: { ref: Math.exp, bound: 1, args: [...EXTREME, 700, -700, 708, 708.3964185322641, -708.3964185322641, 708.5,
    708.9999999999999, 709, 709.0000000000001, -709, 709.7, 709.782712893384, 709.7827128933841, 709.79, -709.79,
    -745.1332191019411, -745.1332191019412, -745.1332191019413, -745.2, -740, 800, -800, 1e10, -1e10,
    ...Array.from({ length: 4000 }, () => sgn(rnd() * 745)), ...Array.from({ length: 2000 }, () => sgn(logU(-60, 3)))] },
  exp2: { ref: (y) => 2 ** y, bound: 1, expr: (a) => `2 ** ${a}`, args: [...EXTREME, 1021.5, 1022, 1023, 1023.9999999999999,
    1024, 1024.0000000000002, 1025, -1021.5, -1022, -1022.5, -1023, -1074, -1074.5, -1075, -1075.0000000000002, -1076,
    3000, -3000, ...Array.from({ length: 4000 }, () => sgn(rnd() * 1080))] },
  log: { ref: Math.log, bound: 6, args: [...EXTREME, Math.SQRT2, 1.414213562373095, 1.4142135623730954, 0.7071067811865476,
    0.7071067811865475, 1 + 2 ** -52, 1 - 2 ** -53, 2 ** -1022 * 1.5, 2 ** -1030, ...Array.from({ length: 4000 }, () => logU(-1074, 1024)),
    ...Array.from({ length: 2000 }, () => 1 + sgn(logU(-53, -1)))] },
  log10: { ref: Math.log10, bound: 3, args: [...EXTREME, 10, 1000, 1e22, 1e-300, Math.SQRT2, 0.7071067811865476, ...Array.from({ length: 3000 }, () => logU(-1074, 1024))] },
  log2: { ref: Math.log2, bound: 6, args: [...EXTREME, 8, 1024, Math.SQRT2, ...Array.from({ length: 3000 }, () => logU(-1074, 1024))] },
  log1p: { ref: Math.log1p, bound: 6, args: [...EXTREME, -1 + 2 ** -53, 2 ** -60, -(2 ** -60), 1e305, ...Array.from({ length: 3000 }, () => sgn(logU(-60, 3)))] },
}
const src = Object.entries(CASES).map(([n, c]) => `export let ${n} = (a, o, k) => { for (let i = 0; i < k; i++) o[i] = ${c.expr ? c.expr('a[i]') : `Math.${n}(a[i])`} }`).join('\n')

test('The exponential and logarithm kernels: their folder twins\' bits at the edges of their entry tests, the host within bounds', () => {
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(src, { optimize }).exports
    for (const [n, { ref, bound, args }] of Object.entries(CASES)) {
      const a = Float64Array.from(args), o = new Float64Array(a.length), twin = MATH_KERNEL['math.' + n]
      m[n](a, o, a.length)
      let diff = null, worst = 0, at = null
      for (let i = 0; i < a.length; i++) {
        if (diff == null && !same(o[i], twin(a[i]))) diff = a[i]
        const u = ulpDiff(o[i], ref(a[i]))
        if (u > worst) { worst = u; at = a[i] }
      }
      is(diff, null, `O${optimize} ${n}: the folder twin's bits`)
      ok(worst <= bound, `O${optimize} ${n}: ${worst} ulp from the host at ${at}`)
    }
  }
})

test('Every scalar math kernel reads its f64 literals from memory', () => {
  if (belowOpt(2)) return
  const fns = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'exp', 'expm1',
    'log', 'log1p', 'log2', 'log10', 'cbrt']
  const w = wat(fns.map(n => `export let ${n} = (x) => Math.${n}(x)`).join('\n') + `
export let atan2 = (y, x) => Math.atan2(y, x)
export let hypot = (x, y) => Math.hypot(x, y)
export let pow = (x, y) => Math.pow(x, y)
export let exp2 = (y) => 2 ** y`)
  for (const n of [...fns, 'atan2', 'hypot', 'pow', 'exp2']) {
    const k = funcWat(w, 'math.' + n)
    ok(k.length > 0, `$math.${n} is in the module`)
    const lits = (k.match(/f64\.const [^)\s]+/g) || []).filter(c => !/ (0|0\.0|-0|inf|-inf|nan|nan:0x[0-9a-f]+)$/.test(c))
    is(lits.length, 0, `$math.${n}: every literal but 0, ±Infinity and NaN from $math.kc (${lits.slice(0, 3).join(', ')})`)
  }
})

test('exp and exp2 round k without a float-to-integer conversion', () => {
  if (belowOpt(2)) return
  for (const [fn, expr] of [['math.exp', 'Math.exp(x)'], ['math.exp2', '2 ** x']]) {
    const k = funcWat(wat(`export let f = (x) => ${expr}`), fn)
    ok(k.length > 0 && !/i32\.trunc_f64_s/.test(k) && !/f64\.nearest/.test(k), `${fn}: k from the magic addition`)
  }
})

test('The kernels\' tables load where the memory is shared or imported, the program holding no other data', () => {
  // the start copies the static region into __alloc'd space there: the tables are that region
  const src = `export let f = (x) => [Math.exp(x), Math.log(x + 2), Math.sin(x), Math.atan(x), Math.tanh(x), Math.pow(x + 3, 1.7), 10 ** x, 2 ** x]`
  const want = oracle(src).f
  for (const optimize of levels(0, 2, 3))
    for (const opts of [{ sharedMemory: true, memory: new WebAssembly.Memory({ initial: 16, maximum: 64, shared: true }) }, { importMemory: true, memory: new WebAssembly.Memory({ initial: 16 }) }]) {
      const { f } = jz(src, { ...opts, optimize }).exports
      for (const x of [0.3, -1.25, 7]) {
        const got = f(x), exp = want(x)
        ok(got.length === exp.length && got.every((v, i) => ulpDiff(v, exp[i]) <= 48), `O${optimize} ${Object.keys(opts)[0]} x = ${x}: ${got}`)
      }
    }
})

test('A program carries the constants of its own kernels only', () => {
  // the data section's size: the table $math.kc is all of it for Math.atan alone
  const dataBytes = (bin) => {
    let at = 8, total = 0
    const leb = () => { let v = 0, s = 0, b; do { b = bin[at++]; v |= (b & 127) << s; s += 7 } while (b & 128); return v }
    while (at < bin.length) { const id = bin[at++], size = leb(); if (id === 11) total += size; at += size }
    return total
  }
  const atan = dataBytes(compile('export let f = (x) => Math.atan(x)'))
  const all = dataBytes(compile('export let f = (x) => Math.atan(x) + Math.log(x) + Math.sin(x) + Math.cbrt(x) + Math.expm1(x) + Math.asin(x)'))
  ok(atan > 0 && atan < 200, `Math.atan's constants alone (${atan} B)`)
  ok(all > atan, `more kernels, more constants (${all} B)`)
})
