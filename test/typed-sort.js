// %TypedArray%.prototype.sort without a comparator: numeric, stable, NaN last,
// -0 before +0, BigInt by value. A short array sorts by insertion; a longer one
// by a byte-wise radix over a key that orders the raw bits as the values
// (module/typedarray.js __typed_sort), in every element kind.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { levels } from './_matrix.js'
import { oracle, run } from './util.js'

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

// xorshift32: the same elements on every run.
const rng = (seed) => () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296 }
const SIZES = [0, 1, 2, 3, 7, 23, 24, 25, 26, 31, 32, 33, 63, 64, 100, 1000, 5000]
const CTORS = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array }
const fill = (C, n, r, floats) => {
  const a = new C(n)
  for (let i = 0; i < n; i++) {
    const u = r()
    a[i] = floats && u < 0.06 ? NaN : floats && u < 0.1 ? -0 : floats && u < 0.14 ? 0 : floats && u < 0.16 ? Infinity : floats && u < 0.18 ? -Infinity
      : u < 0.4 ? Math.floor(r() * 9) - 4          // many duplicates
      : (r() - 0.5) * (floats ? 1e6 : 2 ** 33)      // wraps an integer element to its width
  }
  return a
}
const bytes = (a) => [...new Uint8Array(a.buffer, a.byteOffset, a.byteLength)]

// The elements cross as numbers and are stored, sorted and read back as the
// kind under test: a clamped array has no host form at an untyped boundary.
const SORT = (name) => `export let f = (a) => { const b = new ${name}(a); b.sort(); return new Float64Array(b) }`
const same = (got, want, label) => { is(got.length, want.length, label); for (let i = 0; i < want.length; i++) if (!Object.is(got[i], want[i])) return is(got[i], want[i], `${label} at ${i}`); ok(true, label) }

for (const [name, C] of Object.entries(CTORS)) test(`typed sort: ${name}`, () => {
  const { f } = run(SORT(name)), floats = name.startsWith('Float')
  const r = rng(0x9e3779b9 ^ name.length * 2654435761)
  for (const n of SIZES) {
    const src = Float64Array.from(fill(floats ? C : Float64Array, n, r, floats))
    same(f(src), new Float64Array(new C(src).sort()), `${name} n=${n}`)
  }
})

test('typed sort: sorted, reversed and constant inputs', () => {
  const { f } = run(SORT('Int32Array'))
  for (const n of [24, 25, 300]) {
    const up = Int32Array.from({ length: n }, (_, i) => i - 7), down = up.slice().reverse(), flat = new Int32Array(n).fill(5)
    for (const a of [up, down, flat]) same(f(a), new Float64Array(a.slice().sort()), `n=${n}`)
  }
})

test('typed sort: a view sorts its own elements', () => {
  const src = `export let f = (a, from, to) => { const b = new Float64Array(a); b.subarray(from, to).sort(); return b }`
  const { f } = run(src), r = rng(12345)
  for (const [n, from, to] of [[10, 2, 7], [200, 50, 150], [200, 0, 200], [40, 39, 40], [40, 5, 5]]) {
    const a = fill(Float64Array, n, r, true), want = a.slice()
    want.subarray(from, to).sort()
    is(bytes(Float64Array.from(f(a, from, to))), bytes(want), `[${from}, ${to}) of ${n}`)
  }
})

test('typed sort: NaNs keep their order past the numbers', () => {
  // Payloads tell the NaNs apart. The reference is a stable sort of the
  // indices by the specification's order, which is what it requires.
  const src = `export let f = (hi, lo) => {
    const a = new Float64Array(hi.length), bits = new Uint32Array(a.buffer)
    for (let i = 0; i < hi.length; i++) { bits[2 * i] = lo[i]; bits[2 * i + 1] = hi[i] }
    a.sort()
    const out = new Uint32Array(2 * hi.length)
    for (let i = 0; i < out.length; i++) out[i] = bits[i]
    return out }`
  const { f } = run(src), r = rng(777)
  const order = (x, y) => Number.isNaN(x) ? (Number.isNaN(y) ? 0 : 1) : Number.isNaN(y) ? -1 : x < y ? -1 : x > y ? 1 : Object.is(x, y) ? 0 : Object.is(x, -0) ? -1 : 1
  for (const n of [5, 31, 32, 33, 400]) {
    const a = new Float64Array(n), bits = new Uint32Array(a.buffer)
    for (let i = 0; i < n; i++) {
      if (r() < 0.3) { bits[2 * i] = i + 1; bits[2 * i + 1] = (r() < 0.5 ? 0x7ff80000 : 0xfff80000) | (i & 0xffff) }  // a NaN of its own payload and sign
      else a[i] = Math.floor(r() * 20) - 10
    }
    const idx = Array.from({ length: n }, (_, i) => i).sort((i, j) => order(a[i], a[j]))   // Array sort is stable (ES2019)
    const want = new Uint32Array(2 * n)
    idx.forEach((k, i) => { want[2 * i] = bits[2 * k]; want[2 * i + 1] = bits[2 * k + 1] })
    const hi = new Uint32Array(n), lo = new Uint32Array(n)
    for (let i = 0; i < n; i++) { lo[i] = bits[2 * i]; hi[i] = bits[2 * i + 1] }
    is([...f(hi, lo)], [...want], `n=${n}`)
  }
})

test('typed sort: BigInt64Array and toSorted', () => {
  const big = `export let f = (n) => { const a = new BigInt64Array(n); for (let i = 0; i < n; i++) a[i] = BigInt((i * 7919) % 101 - 50) * 1000000007n; a.sort(); let s = 0n; for (let i = 0; i < n; i++) s = (s * 3n + a[i]) % 1000003n; return Number(s) }`
  for (const n of [0, 5, 24, 25, 200]) is(run(big).f(n), new Function(big.replace('export let f =', 'return'))()(n), `BigInt64Array n=${n}`)
  const ts = `export let f = (a) => { const b = new Int16Array(a), c = b.toSorted(); return b[0] * 100000 + c[0] * 100 + c[c.length - 1] }`
  const a = Int16Array.from({ length: 50 }, (_, i) => (i * 37) % 23 - 11)
  is(run(ts).f(a), new Function(ts.replace('export let f =', 'return'))()(a))
})

test('typed sort: a kind the receiver does not name', () => {
  const src = `export let f = (a) => { if (!(a instanceof Float32Array)) return -1; a.sort(); return a }`
  const r = rng(99)
  for (const n of [3, 30, 300]) { const a = fill(Float32Array, n, r, true); is(bytes(Float32Array.from(run(src).f(a))), bytes(a.slice().sort())) }
})

test('typed sort: the size tier and the reference tier agree', () => {
  const r = rng(4242)
  for (const name of ['Int32Array', 'Float64Array', 'Uint8Array']) {
    const a = fill(CTORS[name], 300, r, name.startsWith('Float')), want = bytes(a.slice().sort())
    for (const optimize of ['size', 0, 'speed']) is(bytes(CTORS[name].from(run(SORT(name), { optimize }).f(Float64Array.from(a)))), want, `${name} at ${optimize}`)
  }
})

test('typed sort: a long array sorts in n log n', () => {
  const src = `export let f = (n) => { const a = new Float64Array(n); let s = 1; for (let i = 0; i < n; i++) { s = (Math.imul(s, 1103515245) + 12345) | 0; a[i] = s } a.sort(); let ok = 1; for (let i = 1; i < n; i++) if (a[i - 1] > a[i]) ok = 0; return ok }`
  const { f } = run(src), t0 = performance.now()
  is(f(200000), 1)
  ok(performance.now() - t0 < 3000, 'an insertion sort takes 10^10 steps here')
})

test('typed sort: a range sorted through a view nobody reads', () => {
  const src = `export function f(n) {
  const m = (n & 15) + 12
  const a = new Int32Array(m), f = new Float32Array(m)
  for (let i = 0; i < m; i++) { a[i] = (i * 7919 + n) % 31 - 9; f[i] = ((i * 31 + 7) % 13) / 4 - 1 }
  a.subarray(2, m - 3).sort()
  f.subarray(n & 3).sort()
  a.subarray(0, 0).sort()
  a.subarray(m - 2, 1).sort()
  a.subarray(-4, -1).sort()
  const v = a.subarray(1, 5).sort()
  let s = v[0] + v.length * 1000
  for (let i = 0; i < m; i++) s = s * 3 + a[i] + f[i]
  return s
}`
  const host = new Function(src.replace('export function f', 'return function f'))()
  for (const n of [0, 1, 2, 3, 7, 15, 100]) is(run(src).f(n), host(n), `n=${n}`)
  // the views made only to be sorted are not allocated: one view is read, one is made
  const views = text => (text.match(/\(call \$__alloc \(i32\.const 16\)\)/g) || []).length
  ok(views(jz.compile(src, { wat: true })) <= 1, 'one view is made')
})
