// Guarded updates (optimize/guarded-update.js): the data-dependent last
// conjunct of a condition folds into the local update it guards; the bound
// before it stays the branch.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { levels } from './_matrix.js'
import { agree, funcWat, wat } from './util.js'

const body = src => { const text = wat(src, { optimize: 3 }); return funcWat(text, 'f') || funcWat(text, 'f$exp') }
const check = (src, args, name) => {
  for (const optimize of levels(0, 2, 3, 'size')) agree(src, 'f', args, { optimize }, `${name} at ${optimize}`)
}

// A heap sift over pseudo-random keys: the child pick is the guarded update.
const sift = pick => `const N = 257
export let f = (seed) => {
  const a = new Float64Array(N)
  let s = seed | 0
  for (let i = 0; i < N; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; a[i] = (s % 1000) - 500 }
  const n = N
  for (let root = (n >> 1) - 1; root >= 0; root--) {
    let i = root, child = 2 * i + 1
    while (child < n) {
      ${pick}
      if (a[i] >= a[child]) break
      const t = a[i]; a[i] = a[child]; a[child] = t
      i = child
      child = 2 * i + 1
    }
  }
  let h = 0
  for (let i = 0; i < N; i++) h = (h * 31 + a[i]) | 0
  return h
}`

test('guarded update: a loaded comparison under a bound becomes the increment', () => {
  const src = sift('if (child + 1 < n && a[child] < a[child + 1]) child++')
  ok(/\(i32\.add\s*\(local\.get \$\w+\)\s*\(f64\.lt/.test(body(src)), 'child + (a[child] < a[child + 1])')
  for (const seed of [0, 1, 12345, -7, 99991]) check(src, [seed], `sift(${seed})`)
})

test('guarded update: another assignment becomes a select under the bound', () => {
  const src = sift('if (child + 1 < n && a[child] < a[child + 1]) child = child + 1 + (i & 0)')
  ok(/\(select|\(i32\.add\s*\(local\.get \$\w+\)\s*\(f64\.lt/.test(body(src)), 'the update is a value')
  for (const seed of [0, 1, 12345, -7, 99991]) check(src, [seed], `select sift(${seed})`)
})

test('guarded update: NaN keys and signed zeros keep the comparison exact', () => {
  const src = `export let f = (k) => {
    const a = new Float64Array([0, -0, NaN, 1, -1, NaN, 0, 5])
    let c = k, n = 8
    if (c + 1 < n && a[c] < a[c + 1]) c++
    return c
  }`
  for (let k = -1; k < 9; k++) check(src, [k], `pick(${k})`)
})

test('guarded update: an update that reads memory, or a test that reads none, stays a branch', () => {
  const loads = `export let f = (n) => {
    const a = new Float64Array(16), b = new Int32Array(16)
    for (let i = 0; i < 16; i++) { a[i] = (i * 7) % 5; b[i] = i * 3 }
    let x = 0
    for (let i = 0; i < n; i++) if (i + 1 < n && a[i] < a[i + 1]) x = b[i]
    return x
  }`
  ok(!/\(select\s*\(i32\.load/.test(body(loads)), 'no load moves above its guard')
  for (const n of [0, 1, 5, 16]) check(loads, [n], `loads(${n})`)
  const registers = `export let f = (n, k) => {
    let x = 0
    for (let i = 0; i < n; i++) if (i + 1 < n && i * 3 < k) x++
    return x
  }`
  for (const n of [0, 1, 5, 16]) check(registers, [n, 20], `registers(${n})`)
})
