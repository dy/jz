// Float arithmetic written as `Math.fround` of an operator over `Math.fround`s
// runs in single precision (src/optimize/float32.js, pass `narrowFloat32`): the
// operator is the single one and the conversions around it are gone, a local
// that only ever holds a single is one. Rounding the double result of `+`, `-`,
// `*`, `/` or `sqrt` over two singles gives what the single operator gives
// (Figueroa, "When is double rounding innocuous?", SIGNUM Newsletter 30(3),
// 1995: the wide format holds 2p + 2 bits, 53 ≥ 2·24 + 2), so every form answers
// what the host answers, to the bit. The reference is the host itself: each
// kernel runs under Node over the same inputs.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, run, wat } from './util.js'

const HEAD = 'var f32 = Math.fround\n'
const kernels = {
  mul: 'export let f = (x, y) => f32(f32(x) * f32(y))',
  add: 'export let f = (x, y) => f32(f32(x) + f32(y))',
  sub: 'export let f = (x, y) => f32(f32(x) - f32(y))',
  div: 'export let f = (x, y) => f32(f32(x) / f32(y))',
  'a constant operand': 'export let f = (x, y) => f32(f32(1 / f32(x)) + f32(f32(y) * 0.5))',
  'a constant no single holds': 'export let f = (x, y) => f32(f32(x) * 0.1) + f32(f32(y) / 3)',
  sqrt: 'export let f = (x, y) => f32(Math.sqrt(f32(f32(x) + f32(y))))',
  'abs, neg, floor, ceil, trunc': 'export let f = (x, y) => f32(Math.abs(f32(x))) + f32(-f32(y)) * 2 + f32(Math.floor(f32(x))) * 4 + f32(Math.ceil(f32(y))) * 8 + f32(Math.trunc(f32(x)))',
  'min and max': 'export let f = (x, y) => f32(Math.min(f32(x), f32(y))) - f32(Math.max(f32(x), f32(y))) * 2',
  'locals that hold singles': 'export let f = (x, y) => { x = f32(x); y = f32(y); return f32(Math.sqrt(f32(f32(x * x) + f32(y * y)))) }',
  'a local read as a double too': 'export let f = (x, y) => { const a = f32(x), b = f32(y); const c = f32(a * b); return c > 1 ? f32(c - a) + a * 2 : f32(c + b) }',
  'a local defined in arms': 'export let f = (x, y) => { let a; if (x > y) a = f32(x); else a = f32(f32(y) * 2); return f32(a * a) + f32(a / 3) }',
  'a local carried by a loop': 'export let f = (x, y) => { let s = f32(0); const d = f32(y); for (let i = 0; i < 5; i++) s = f32(s * d + f32(x)); return s }',
  'a sum of doubles rounded once': 'export let f = (x, y) => f32(x * y + x)',
  'an operator over one single and one double': 'export let f = (x, y) => f32(f32(x) * y)',
}
const EDGES = [0, -0, 1, -1, 0.5, 3, 0.1, 1 / 3, NaN, Infinity, -Infinity,
  1.401298464324817e-45, 1.1754943508222875e-38, 3.4028234663852886e+38, 3.4028235677973366e+38, 1e39, -1e39, 1e-46,
  16777216, 16777217, 16777219, 1.0000001192092896, 1.00000017881393432617, 0.99999994039535522461, 123456.789, -7.25e-7, 2 ** 52 + 1, 5e-324]

test('float32: the single operator answers what the double one rounded answers', () => {
  for (const [name, body] of Object.entries(kernels)) {
    const src = HEAD + body, host = oracle(src)
    for (const optimize of levels(0, 2, 3)) {
      const m = run(src, { optimize })
      let bad = 0, first = ''
      for (const x of EDGES) for (const y of EDGES) {
        const want = host.f(x, y), got = m.f(x, y)
        if (!Object.is(got, want) && !(got !== got && want !== want)) { if (!bad++) first = `f(${x}, ${y}) = ${got}, the host answers ${want}` }
      }
      is(bad, 0, `${name} at ${optimize}${first && ': ' + first}`)
    }
  }
})

test('float32: the same over the numbers between', () => {
  // a multiplicative generator's numbers, spread over the singles' exponents
  let s = 0x2545f491
  const next = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296 }
  const xs = Array.from({ length: 400 }, () => (next() - 0.5) * 2 ** Math.floor((next() - 0.5) * 80))
  for (const [name, body] of Object.entries(kernels)) {
    const src = HEAD + body, host = oracle(src)
    for (const optimize of levels(2, 3)) {
      const m = run(src, { optimize })
      let bad = 0, first = ''
      for (let i = 0; i + 1 < xs.length; i++) {
        const want = host.f(xs[i], xs[i + 1]), got = m.f(xs[i], xs[i + 1])
        if (!Object.is(got, want) && !(got !== got && want !== want)) { if (!bad++) first = `f(${xs[i]}, ${xs[i + 1]}) = ${got}, the host answers ${want}` }
      }
      is(bad, 0, `${name} at ${optimize}${first && ': ' + first}`)
    }
  }
})

test('float32: the operator runs on singles', () => {
  if (belowOpt(2)) return
  const count = (s, re) => (s.match(re) || []).length
  const of = (body, opts) => funcWat(wat(HEAD + body, { optimize: 2, ...opts }), 'f')
  const mul = of(kernels.mul)
  is(count(mul, /f32\.mul/g), 1, 'a product of singles is a single product')
  is(count(mul, /f64\.mul/g), 0)
  is(count(mul, /f64\.promote_f32/g), 1, 'one widening, of the result')
  const hyp = of(kernels['locals that hold singles'])
  is(count(hyp, /f64\.(mul|add|sqrt)/g), 0, 'a local that holds a single is read as one')
  ok(count(hyp, /f32\.sqrt/g) === 1 && count(hyp, /f32\.mul/g) === 2 && count(hyp, /f32\.add/g) === 1, 'the root of a sum of squares, in singles')
  is(count(hyp, /f64\.promote_f32/g), 1)
  is(count(of(kernels['a constant operand']), /f64\.(mul|div|add)/g), 0, 'a constant a single holds is that single')
  ok(count(of(kernels['a constant no single holds']), /f64\.mul/g) === 1, 'a constant no single holds keeps its double product')
  is(count(of(kernels['a sum of doubles rounded once']), /f32\.(mul|add)/g), 0, 'an operator over doubles stays one')
  is(count(of(kernels['an operator over one single and one double']), /f32\.mul/g), 0, 'and over one double')
  is(count(of(kernels.mul, { optimize: { level: 2, narrowFloat32: false } }), /f32\.mul/g), 0, 'the pass is what does it')
})
