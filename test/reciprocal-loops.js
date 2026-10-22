// A loop dividing by a name it never writes runs a copy multiplying by the
// divisor's reciprocal where the divisor is a positive int32 power of two
// (plan/reciprocal-loops.js). `a * 2^-k` rounds the real number `a / 2^k`
// once, as the division does, so the copy answers as the loop does for every
// dividend: signed zeros, infinities, NaNs and subnormals included. Every
// other divisor runs the loop as written.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { levels, onKernel } from './_matrix.js'
import { funcWat, oracle, run, wat } from './util.js'

const src = `export let scale = (data, w) => {
  const out = new Float64Array(data.length)
  for (let i = 0; i < data.length; i++) out[i] = data[i] / w
  return out
}
export let avg = (data, m) => {
  let sum = 0
  for (let i = 0; i < data.length; i++) { sum += data[i]; data[i] = sum / m }
  return sum
}
export let norm = (data, w) => {
  let s = 0
  for (let i = 0; i < data.length; i++) { let x = data[i]; x /= w; s += x }
  return s
}`

const DIVISORS = [1, 2, 4, 16, 1024, 2 ** 30, 3, 10, 0, -0, -2, -16, 0.5, 0.25, 2.5, NaN, Infinity, -Infinity, 2 ** 31, 2 ** 32, 5e-324]
const DATA = [0, -0, 1, -1, 3, 0.1, -7.5, 1e308, -1e308, 5e-324, -5e-324, 2.2250738585072014e-308, Infinity, -Infinity, NaN, 123456789.125]
const show = (xs) => Array.from(xs, x => Object.is(x, -0) ? '-0' : String(x)).join()

test('reciprocal loops: a power-of-two divisor answers as the division does, every dividend', () => {
  const host = oracle(src)
  for (const optimize of levels(0, 2, 3, 'speed')) {
    const m = run(src, { optimize })
    for (const w of DIVISORS) {
      is(show(m.scale(new Float64Array(DATA), w)), show(host.scale(new Float64Array(DATA), w)), `scale by ${w} at ${optimize}`)
      const a = new Float64Array(DATA), b = new Float64Array(DATA)
      is(show([m.avg(a, w)]), show([host.avg(b, w)]), `avg by ${w} at ${optimize}`)
      is(show(a), show(b), `avg's samples by ${w} at ${optimize}`)
      is(show([m.norm(new Float64Array(DATA), w)]), show([host.norm(new Float64Array(DATA), w)]), `norm by ${w} at ${optimize}`)
    }
  }
})

// The loops of a function, each with its divisions and products.
const loops = (text, name) => {
  const f = funcWat(text, name), out = []
  for (let at = f.indexOf('(loop'); at >= 0; at = f.indexOf('(loop', at + 1)) {
    let depth = 0, end = at
    do { const c = f[end++]; if (c === '(') depth++; else if (c === ')') depth-- } while (depth && end < f.length)
    const body = f.slice(at, end)
    out.push({ div: (body.match(/f64(x2)?\.div/g) || []).length, mul: (body.match(/f64(x2)?\.mul/g) || []).length })
  }
  return out
}

test('reciprocal loops: the copy multiplies, the loop as written divides', () => {
  if (onKernel()) return
  const on = loops(wat(src, { optimize: 'speed' }), 'avg'), off = loops(wat(src, { optimize: { level: 'speed', reciprocalDivisors: false } }), 'avg')
  ok(on.some(l => l.div === 0 && l.mul > 0), 'a loop of the copy multiplies by the reciprocal and divides nowhere')
  ok(on.some(l => l.div > 0), 'the loop as written still divides, for the other divisors')
  ok(off.length > 0 && off.every(l => l.div > 0), 'disabled, every loop divides')
})

test('reciprocal loops: an integer quotient, a written divisor and a loop that calls keep the loop as written', () => {
  if (onKernel()) return
  for (const s of [
    // `(i / w) | 0` is an integer division of words, or loop-divmod's counters
    `export let f = (a, w) => { let s = 0; for (let i = 0; i < a.length; i++) s = (s + a[(i / w) | 0]) | 0; return s }`,
    `export let f = (a, w) => { let s = 0; for (let i = 0; i < a.length; i++) { s += a[i] / w; if (i === 3) w = w * 2 } return s }`,
    // (a recursive callee stays a call)
    `const g = (x) => x > 8 ? g(x - 8) : x
export let f = (a, w) => { let s = 0; for (let i = 0; i < a.length; i++) s += g(a[i]) / w; return s }`,
  ]) is(wat(s, { optimize: 'speed' }), wat(s, { optimize: { level: 'speed', reciprocalDivisors: false } }), s)
})
