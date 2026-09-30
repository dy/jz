// %TypedArray%.prototype.sort without a comparator: numeric, stable, NaN last,
// -0 before +0, BigInt by value. A short array sorts by insertion; a longer one
// by a byte-wise radix over a key that orders the raw bits as the values
// (module/typedarray.js __typed_sort), in every element kind.
import test from 'tst'
import { ok } from 'tst/assert.js'
import jz from '../index.js'
import { levels } from './_matrix.js'
import { oracle } from './util.js'

const KINDS = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float16Array', 'Float32Array', 'Float64Array', 'BigInt64Array']
const value = (K) => K.startsWith('Big') ? 'BigInt(r < 3 ? -(s % 1000) : s % 5000) - 2000n'
  : 'r === 0 ? NaN : r === 1 ? -0 : r === 2 ? 0 : r === 3 ? Infinity : r === 4 ? -Infinity : r === 5 ? 5e-324 : (s / 4294967296 - 0.5) * 70000'

for (const K of KINDS) test(`typed sort: ${K} agrees with JS, special values and every length`, () => {
  const src = `export let f = (n, seed, copy) => { const a = new ${K}(n); let s = seed
    for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; const r = s % 16; a[i] = ${value(K)} }
    return copy ? a.toSorted() : a.sort() }`
  const want = oracle(src).f
  for (const optimize of levels(0, 2)) {
    const { f } = jz(src, { optimize }).exports
    for (const n of [0, 1, 5, 32, 33, 100, 1000]) for (const seed of [1, 7]) for (const copy of [false, true]) {
      const a = want(n, seed, copy), b = f(n, seed, copy)
      ok(a.length === b.length && [...a].every((v, i) => Object.is(v, b[i])), `${K} n=${n} seed=${seed}${copy ? ' toSorted' : ''} at ${optimize}`)
    }
  }
})

test('typed sort: a comparator orders stably, BigInt elements compared as BigInts', () => {
  const lcg = 's = (Math.imul(s, 1664525) + 1013904223) >>> 0'
  const srcs = [
    `export let f = (n, s) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) { ${lcg}; a[i] = s % 400 - 200 } a.sort((x, y) => y - x); return [...a] }`,
    `export let f = (n, s) => { const a = new BigInt64Array(n); for (let i = 0; i < n; i++) { ${lcg}; a[i] = BigInt(s % 400) - 200n } a.sort((x, y) => (y > x ? 1 : y < x ? -1 : 0)); return [...a].map(Number) }`,
    `export let f = (n, s) => { const a = new Int16Array(n); for (let i = 0; i < n; i++) { ${lcg}; a[i] = s % 400 - 200 } const b = a.toSorted((x, y) => x - y); return [...b, a[0]] }`,
  ]
  for (const src of srcs) {
    const want = oracle(src).f
    for (const optimize of levels(0, 2)) {
      const { f } = jz(src, { optimize }).exports
      for (const n of [0, 1, 2, 17, 257]) for (const s of [1, 9]) ok(JSON.stringify(f(n, s)) === JSON.stringify(want(n, s)), `n=${n} s=${s} at ${optimize}: ${src.slice(40, 90)}`)
    }
  }
})
