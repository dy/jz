// A shift binds tighter than a comparison: `a < b >> c` is `a < (b >> c)`.
// subscript tries the operators of a first character newest-first and commits
// to the first whose text matches, so `>`, registered after `>>`, took the
// first character of a shift standing right of a comparison, and the loop
// bound `k < n >> 1` never held. The parser entry orders every character's
// operators longest first (src/parse.js).
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { parse } from '../src/parse.js'
import { levels } from './_matrix.js'
import { oracle } from './util.js'

test('shift precedence: the parse tree', () => {
  const tree = (src) => JSON.stringify(parse(src))
  is(tree('a < b >> c'), '["<","a",[">>","b","c"]]')
  is(tree('a > b << c'), '[">","a",["<<","b","c"]]')
  is(tree('a <= b >>> c'), '["<=","a",[">>>","b","c"]]')
  is(tree('a >= b << c'), '[">=","a",["<<","b","c"]]')
  is(tree('a << b < c'), '["<",["<<","a","b"],"c"]')
  is(tree('a + b << c > d'), '[">",["<<",["+","a","b"],"c"],"d"]')
  is(tree('a == b >> c'), '["==","a",[">>","b","c"]]')
  is(tree('a < b > c'), '[">",["<","a","b"],"c"]')
})

test('shift precedence: every operator keeps its longest spelling', () => {
  const tree = (src) => JSON.stringify(parse(src))
  is(tree('a >>= b'), '[">>=","a","b"]')
  is(tree('a >>>= b'), '[">>>=","a","b"]')
  is(tree('a <<= b'), '["<<=","a","b"]')
  is(tree('a ?? b'), '["??","a","b"]')
  is(tree('a ??= b'), '["??=","a","b"]')
  is(tree('a ? b : c'), '["?","a","b","c"]')
  is(tree('a => b'), '["=>","a","b"]')
  is(tree('a === b'), '["===","a","b"]')
  is(tree('a !== b'), '["!==","a","b"]')
  is(tree('a ** b'), '["**","a","b"]')
  is(tree('a && b || c'), '["||",["&&","a","b"],"c"]')
})

test('shift precedence: programs agree with the host', () => {
  const src = `export let a = (n) => n < 8 >> 1 ? 1 : 0
export let b = (n) => n > 1 << 2 ? 1 : 0
export let c = (n) => n <= 8 >>> 1 ? 1 : 0
export let d = (n) => n >= 1 << 3 ? 1 : 0
export let e = (n) => (n << 2 < 40 ? 1 : 0) + (n >> 1 > 1 ? 10 : 0)
export let f = (n) => { let x = n; x <<= 2; x >>= 1; x >>>= 1; return x }
export let g = (n) => n == 4 >> 1 ? 1 : n != 8 >> 1 ? 2 : 3
export let h = (n) => (n & 1 << 2) + (n | 1 << 3) + (n ^ 5 >> 1)
export let i = (n) => n + 1 << 2 > 20 ? 1 : 0
export let bound = (n) => { let c = 0; for (let k = 0; k < n >> 1; k++) c++; for (let k = n << 1; k > n >> 1; k--) c += 10; return c }
export let fill = (n) => { const N = 8, w = new Float64Array(N >> 1); for (let k = 0; k < N >> 1; k++) w[k] = 1 - k * 0.25; return w[0] * 1000 + w[1] * 100 + w[2] * 10 + w[3] + n }`
  const host = oracle(src)
  for (const optimize of levels(0, 2, 3, 'size')) {
    const mod = jz(src, { optimize }).exports
    for (const name of Object.keys(host)) for (const n of [2, 3, 4, 9]) {
      const want = host[name](n), got = mod[name](n)
      ok(Object.is(want, got), `${name}(${n}) at ${optimize}: ${String(got)} for ${String(want)}`)
    }
  }
})
