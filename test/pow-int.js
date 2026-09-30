// A negative integer exponent, |n| ≤ 16: the reciprocal of x^|n|, in $math.pow's ladder
// (a runtime exponent, and a constant base's integer one through $math.pow_b) and in the
// constant-exponent fold (module/math.js foldPow), which agree bit for bit. One rounding
// past the square-and-multiply, so it is the correctly rounded reciprocal wherever x^|n|
// is exact: 10 ** -2 is 0.01, 3 ** -5 is 1/243 as IEEE division gives it (the reference
// here, x^|n| exact below 2^53). Where x^|n| leaves the normal doubles it takes the
// reciprocal's square-and-multiply, as before: 5.67e102 ** -3 is 5.485937093757787e-309,
// where 1/x^3 overflowed to 0. Against the host (V8's Math.pow) within pow's bound in
// test/math-ulp.js, at levels 0, 2 and 3 (level 3 lifts the constant-exponent loops).
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { levels } from './_matrix.js'
import { oracle, ulpDiff } from './util.js'
import { powRuntime, powFold } from '../src/prepare/math-kernel.js'

const same = (a, b) => Object.is(a, b) || (a !== a && b !== b)
let seed = 0x6a09e667
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296 }
const sgn = (x) => rnd() < 0.5 ? -x : x
const logU = (lo, hi) => (1 + rnd()) * 2 ** Math.floor(lo + rnd() * (hi - lo))

const NS = [1, 2, 3, 5, 7, 16]
const src = NS.map(n => `export let c${n} = (a, o, k) => { for (let i = 0; i < k; i++) o[i] = a[i] ** -${n} }`).join('\n') +
  `\nexport let rt = (a, e, o, k) => { for (let i = 0; i < k; i++) o[i] = Math.pow(a[i], e[i]) }
export let ten = (e, o, k) => { for (let i = 0; i < k; i++) o[i] = 10 ** e[i] }`
const host = oracle(src)
const EDGE = [0, -0, Infinity, -Infinity, NaN, 1, -1, 2, -2, 10, 5e-324, -5e-324, 2.2250738585072014e-308, 1e-160, 1e-200,
  1.7976931348623157e308, 5.67e102, -5.67e102, 1e300, 2 ** 64, 2 ** -64, 0.9999999999999999, 1.0000000000000002]
const xs = Float64Array.from([...EDGE, ...Array.from({ length: 3000 }, () => sgn(logU(-60, 60))), ...Array.from({ length: 1000 }, () => sgn(logU(-1074, 1024)))])

test('x ** -n: the constant fold and the ladder bit for bit, the folder\'s bits, within pow\'s bound of the host', () => {
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(src, { optimize }).exports
    for (const n of NS) {
      const k = xs.length, got = new Float64Array(k), run = new Float64Array(k), want = new Float64Array(k)
      m[`c${n}`](xs, got, k); m.rt(xs, new Float64Array(k).fill(-n), run, k); host[`c${n}`](xs, want, k)
      let ladder = null, fold = null, worst = 0, at = null
      for (let i = 0; i < k; i++) {
        if (ladder == null && !same(got[i], run[i])) ladder = xs[i]
        if (fold == null && (!same(got[i], powFold(xs[i], -n)) || !same(got[i], powRuntime(xs[i], -n)))) fold = xs[i]
        const u = ulpDiff(got[i], want[i])
        if (u > worst) { worst = u; at = xs[i] }
      }
      is(ladder, null, `O${optimize} x ** -${n}: the ladder's bits`)
      is(fold, null, `O${optimize} x ** -${n}: the folder's bits`)
      ok(worst <= 12, `O${optimize} x ** -${n}: ${worst} ulp from the host at ${at}`)
    }
  }
})

test('x ** -n is the correctly rounded reciprocal where x^n is exact', () => {
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(src, { optimize }).exports
    const e = Float64Array.from({ length: 17 }, (_, k) => -k), o = new Float64Array(17)
    m.ten(e, o, 17)
    for (let k = 0; k <= 16; k++) is(o[k], 1 / 10 ** k, `O${optimize} 10 ** -${k}`)
    for (const n of NS) {
      const bases = Float64Array.from({ length: 30 }, (_, i) => i + 2).filter(b => b ** n < 2 ** 53), got = new Float64Array(bases.length)
      m[`c${n}`](bases, got, bases.length)
      bases.forEach((b, i) => is(got[i], 1 / b ** n, `O${optimize} ${b} ** -${n}`))
    }
  }
  const { f } = jz('export let f = (x, y) => Math.pow(x, y)').exports
  is(f(5.67e102, -3), 5.485937093757787e-309, 'x^3 overflows, x^-3 is a subnormal')
  ok(Object.is(f(-Infinity, -3), -0) && f(-0, -3) === -Infinity && f(0, -2) === Infinity && f(1e-200, -2) === Infinity)
})
