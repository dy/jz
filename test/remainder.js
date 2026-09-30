// `%` of a runtime divisor (module/core.js `__rem`): the dividend below the
// divisor is itself, below twice the divisor one exact subtraction, integers
// with the dividend below 2^53 the quotient's truncation, anything else the
// long division of `__rem_div`. The first two are the whole of
// `__rem`, small enough for the engine to inline at a ring buffer's wrap
// (`(p + 1) % n`, `(x % n + n) % n`). Every sign, zero, infinity and NaN
// agrees with the host.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, run, wat } from './util.js'

const VALUES = [0, -0, 1, -1, 2.5, -2.5, 3, -3, 5, 6, 7, 10, 0.1, 0.3, 4.999999999999999, 9.999999999999998, 2 ** 31, -(2 ** 31), 2 ** 53, 1e300, -1e300,
  5e-324, Number.MAX_VALUE, -Number.MAX_VALUE, Infinity, -Infinity, NaN]
const src = `export let rem = (a, b) => a % b
export let wrap = (x, n) => (x % n + n) % n
export let ring = (n, len, steps) => { let buf = new Float64Array(len), p = 0, s = 0
  for (let i = 0; i < steps; i++) { buf[p] = i; s += buf[(p + len - 1) % len]; p = (p + 1) % n } return s + p }`

test('remainder: every pair of operands agrees with the host', () => {
  for (const optimize of levels(0, 2, 3)) {
    const host = oracle(src), m = run(src, { optimize })
    let bad = 0
    for (const a of VALUES) for (const b of VALUES) {
      if (!Object.is(m.rem(a, b), host.rem(a, b)) || !Object.is(m.wrap(a, b), host.wrap(a, b))) { bad++; is(m.rem(a, b), host.rem(a, b), `${a} % ${b} at ${optimize}`); is(m.wrap(a, b), host.wrap(a, b), `wrap(${a}, ${b}) at ${optimize}`) }
    }
    is(bad, 0, `no pair disagrees at ${optimize}`)
    for (const [n, len, steps] of [[7, 7, 30], [5, 8, 30], [1, 3, 10], [0, 4, 6], [2.5, 4, 9]])
      ok(Object.is(m.ring(n, len, steps), host.ring(n, len, steps)), `ring(${n}, ${len}, ${steps}) at ${optimize}`)
  }
})

test('remainder: the wrap runs without the division loop', () => {
  if (belowOpt(2)) return
  const text = wat(src, { optimize: 2 })
  const rem = funcWat(text, '__rem')
  ok(rem.length > 0, '__rem is linked')
  ok(!/\(loop/.test(rem), '__rem itself has no loop')
  ok(/call \$__rem_div/.test(rem), 'it leaves the division to __rem_div')
})

// Integers below 2^53 take x − trunc(x/y)·y: exact, since the quotient's rounding
// error (below 1/y) never reaches an integer the true quotient is not. Pairs from
// every magnitude to 2^53, both signs, and the neighbours of 2^53 either side.
test('remainder: integer operands agree with the host at every magnitude', () => {
  const m = run(src, { optimize: 2 })
  let r = 12345, bad = 0
  const rnd = () => (r = (Math.imul(r, 1664525) + 1013904223) >>> 0) / 4294967296
  for (let i = 0; i < 20000; i++) {
    const a = Math.floor(rnd() * 2 ** Math.floor(rnd() * 54)) * (rnd() < 0.5 ? -1 : 1)
    const b = Math.max(1, Math.floor(rnd() * 2 ** Math.floor(rnd() * 40))) * (rnd() < 0.3 ? -1 : 1)
    for (const [x, y] of [[a, b], [a, 3 * b], [-0, b], [2 ** 53 - 1 - i, b], [2 ** 53 + 2 * i, b], [a + 0.5, b]])
      if (!Object.is(m.rem(x, y), x % y) && bad++ < 5) is(m.rem(x, y), x % y, `${x} % ${y}`)
  }
  is(bad, 0, 'no integer pair disagrees')
})
