// Math.pow and ** with a constant base, and pow's kernel in $math.pow's own frame.
//
// A constant base c > 0 (other than 2, which is $math.exp2) lowers to $math.pow_b
// (module/math.js emitPow): the compiler takes log(c) with the pow kernel's own operations
// (src/prepare/math-kernel.js powLog) and the kernel runs the exponential part, so
// Math.pow(c, y) is bit for bit what the general kernel gives a runtime base equal to c
// and what the constant folder gives (powRuntime). Checked over random and edge exponents
// for bases across the doubles, at every optimize level (level 3 lifts the loop to
// $math.pow_b_v, two lanes wide), against the host (V8's Math.pow) within pow's bound in
// test/math-ulp.js and exactly where the result is a double (10 ** 2 === 100).
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { levels, belowOpt } from './_matrix.js'
import { oracle, ulpDiff, wat, funcWat } from './util.js'
import { powRuntime } from '../src/prepare/math-kernel.js'

const same = (a, b) => Object.is(a, b) || (a !== a && b !== b)
let seed = 0x9e3779b9
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296 }
const sgn = (x) => rnd() < 0.5 ? -x : x
const logU = (lo, hi) => (1 + rnd()) * 2 ** Math.floor(lo + rnd() * (hi - lo))

const BASES = [10, 0.5, Math.E, 3, 7.25, 1 + 2 ** -52, 1 - 2 ** -53, 1, 1e22, 1e-300,
  2.2250738585072014e-308, 5e-324, 1.7976931348623157e308]
const EDGE_Y = [0, -0, 0.5, -0.5, 1, -1, 2, -2, 3, 16, -16, 17, -17, 22, 23, -22, 2 ** -65, -(2 ** -65), 2 ** -66,
  -(2 ** -66), 2 ** 63, -(2 ** 63), 2 ** 53, 2 ** 53 + 2, 1e-300, 300, 308.25, 309, -323.3, -324, -330, 1e300,
  NaN, Infinity, -Infinity, 0.1, -0.1, 1 / 3, 2.5, -2.5, 1e-10, 1.5e-17]
const ys = (c) => {
  const out = [...EDGE_Y]
  // the thresholds where c^y leaves the normal doubles and the doubles
  const l2 = Math.log2(c)
  if (l2 !== 0) for (const e of [1024, -1022, -1074, -1075, 512, -512]) for (const d of [-1e-9, 0, 1e-9, -0.5, 0.5]) out.push(e / l2 + d)
  for (let i = 0; i < 1500; i++) out.push(sgn(rnd() * 40), sgn(logU(-60, 10)), Math.round(sgn(rnd() * 40)))
  return Float64Array.from(out)
}
const src = BASES.map((c, i) => `export let b${i} = (ys, o, n) => { for (let i = 0; i < n; i++) o[i] = Math.pow(${c}, ys[i]) }
export let s${i} = (ys, o, n) => { for (let i = 0; i < n; i++) o[i] = ${c} ** ys[i] }`).join('\n') +
  `\nexport let rt = (xs, ys, o, n) => { for (let i = 0; i < n; i++) o[i] = Math.pow(xs[i], ys[i]) }`
const host = oracle(src)

test('Math.pow(c, y) and c ** y with a constant c: the kernel\'s bits for a runtime c, the folder\'s, within pow\'s bound of the host', () => {
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(src, { optimize }).exports
    BASES.forEach((c, bi) => {
      const y = ys(c), n = y.length, got = new Float64Array(n), star = new Float64Array(n), gen = new Float64Array(n), want = new Float64Array(n)
      m[`b${bi}`](y, got, n); m[`s${bi}`](y, star, n); m.rt(new Float64Array(n).fill(c), y, gen, n); host[`b${bi}`](y, want, n)
      let kernel = null, fold = null, starDiff = null, worst = 0, at = null
      for (let i = 0; i < n; i++) {
        if (kernel == null && !same(got[i], gen[i])) kernel = y[i]
        if (fold == null && !same(got[i], powRuntime(c, y[i]))) fold = y[i]
        if (starDiff == null && !same(got[i], star[i])) starDiff = y[i]
        const u = ulpDiff(got[i], want[i])
        if (u > worst) { worst = u; at = y[i] }
      }
      is(kernel, null, `O${optimize} ${c} ** y: the general kernel's bits for a runtime base ${c}`)
      is(fold, null, `O${optimize} ${c} ** y: the constant folder's bits`)
      is(starDiff, null, `O${optimize} ${c} ** y and Math.pow(${c}, y) agree`)
      ok(worst <= 24, `O${optimize} ${c} ** y: ${worst} ulp from the host at y = ${at}`)
    })
  }
})

test('A constant base keeps the exact answers: an integer exponent squares and multiplies', () => {
  const { p, s } = jz(`export let p = (y) => Math.pow(10, y)
export let s = (y) => 10 ** (y / 20)`).exports
  for (let k = 0; k <= 22; k++) is(p(k), 10 ** k, `10 ** ${k}`)
  is(p(2), 100)
  is(s(40), 100, '10 ** (40 / 20)')
  is(s(-20), 0.1, '10 ** (-20 / 20)')
  is(p(0.5), Math.sqrt(10), 'y = 0.5 is the correctly rounded root')
  ok(Object.is(p(-Infinity), 0) && p(Infinity) === Infinity && Number.isNaN(p(NaN)) && p(0) === 1 && p(-0) === 1)
})

test('A constant positive base lowers to $math.pow_b: the log is the compiler\'s', () => {
  if (belowOpt(2)) return
  for (const [label, expr] of [['Math.pow', 'Math.pow(10, y / 20)'], ['**', '10 ** (y / 20)'], ['e', 'Math.E ** y']]) {
    const f = funcWat(wat(`export let f = (y) => ${expr}`), 'f')
    ok(/call \$math\.pow_b\b/.test(f), `${label}: calls $math.pow_b`)
    ok(!/call \$math\.pow\s/.test(f), `${label}: not the general $math.pow`)
  }
  // a runtime base, a negative one and base 2 keep their lowerings
  ok(/call \$math\.pow\s/.test(funcWat(wat('export let f = (x, y) => Math.pow(x, y)'), 'f')))
  ok(/call \$math\.pow\s/.test(funcWat(wat('export let f = (y) => Math.pow(-10, y)'), 'f')))
  ok(/call \$math\.exp2\b/.test(funcWat(wat('export let f = (y) => 2 ** y'), 'f')))
})

test('$math.pow runs its kernel in its own frame: the ladder does not call a second function', () => {
  if (belowOpt(2)) return
  const k = funcWat(wat('export let f = (x, y) => Math.pow(x, y)'), 'math.pow')
  ok(k.length > 0 && !/call \$math\.pow_core/.test(k), 'no $math.pow_core call')
})
