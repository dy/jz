// Integers a loop writes itself, held as words of a copy while a box holds them
// (src/compile/plan/integral-loops.js): each program answers what Node answers at
// every level, at the inputs for which a word answers otherwise, and a loop shaped
// as rfft's butterflies keeps its index locals in integer registers. The inputs are
// rfft's (examples/rfft): `id *= 4` leaves the word for n >= 2^31 - 1, `i0 += id`
// for n >= 3 * 2^29 - 1, the stage loops' `ix = (id << 1) - n2` for n >= 2^29, a
// counter at 2^31; and the box's own edges, where the copy is left mid-loop.
// Each loop carries a cap on its trips where Node itself would not end.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { readFileSync } from 'node:fs'
import { run, oracle } from './util.js'
import { levels } from './_matrix.js'
import { parse, walk, has, head } from '../scripts/wat-probe.mjs'

const EDGES = [0, 1, 2, 7, 8, 8.5, -4, -0, NaN, 2 ** 26, 2 ** 28 - 1, 2 ** 28, 2 ** 29 - 1, 2 ** 29, 2 ** 29 + 1,
  805306368, 1073741823, 1073741824, 1610612734, 1610612735, 2 ** 31 - 2, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 2 ** 53, 1e12, Infinity]
// (each level against a fresh instance of Node's: the programs keep their arrays between calls)
const compare = (source, inputs, name = 'f') => {
  for (const optimize of levels(0, 1, 2, 3, 'size', 'speed')) {
    const actual = run(source, { optimize }), expected = oracle(source)
    for (const args of inputs) is(actual[name](...args), expected[name](...args), `${JSON.stringify(optimize)}: ${args.join(', ')}`)
  }
}

test('boxed counters: the first pass of rfft, a geometric stride and the counter it bounds', () => {
  // `geo`: id alone, its index a store past the end once it leaves the array
  compare(`const x = new Float64Array(8)
export let f = (n) => {
  let ix = 0, id = 4, outer = 0
  while (ix < n) { x[id] = x[ix] + 1; ix = 2 * (id - 1); id *= 4; if (++outer > 600) break }
  return [outer, ix, id]
}`, EDGES.map(n => [n]))
  // `first`: the nest, its inner loop capped once it has run 64 times in all
  compare(`const x = new Float64Array(8)
export let f = (n) => {
  let N = n
  let ix = 0, id = 4, outer = 0, inner = 0, last = 0
  while (ix < N) {
    let i0 = ix
    while (i0 < N) { inner++; last = i0; x[i0 + 1] = x[i0] + 1; i0 += id; if (inner > 64) break }
    ix = 2 * (id - 1)
    id *= 4
    if (++outer > 600) break
  }
  return [outer, inner, last, ix, id]
}`, EDGES.map(n => [n]))
})

test('boxed counters: the stage loops of rfft, a stride by shifts and an index a difference of two words', () => {
  // (Node runs on forever from n = 2^29, where `id << 1` wraps: the caps end it)
  compare(`const x = new Float64Array(8)
export let f = (n) => {
  let n2 = 2, nn = n >>> 1, stages = 0, last = 0, inner = 0, rounds = 0
  while ((nn = nn >>> 1)) {
    n2 = n2 << 1
    let ix = 0, id = n2 << 1
    while (ix < n) {
      let i0 = ix
      while (i0 < n) { inner++; last = i0; x[i0 + 1] = x[i0] + 1; i0 += id; if (inner > 64) break }
      ix = (id << 1) - n2
      id = id << 2
      if (++rounds > 2000) break
    }
    stages++
  }
  return [stages, n2, last, inner, rounds]
}`, EDGES.filter(n => !(Math.abs(n) >= 2 ** 63)).map(n => [n]))
})

test('boxed counters: a module bound, as rfft reads N', () => {
  const src = `let N = 0; const x = new Float64Array(64)
export let set = (n) => { N = n }
export let f = () => {
  let ix = 0, id = 4, inner = 0, rounds = 0
  while (ix < N) {
    let i0 = ix
    while (i0 < N) { x[i0 + 1] = x[i0] + 1; i0 += id; if (++inner > 64) break }
    ix = 2 * (id - 1); id *= 4
    if (++rounds > 600) break
  }
  return [ix, id, inner, rounds, x[1], x[5]]
}`
  for (const optimize of levels(0, 1, 2, 3, 'size', 'speed')) {
    const actual = run(src, { optimize }), expected = oracle(src)
    for (const n of EDGES) { actual.set(n); expected.set(n); is(actual.f(), expected.f(), `${JSON.stringify(optimize)}: N = ${n}`) }
  }
})

test('boxed counters: a held integer left at a head, the loop as written resuming', () => {
  // the box's edge inside the loop: `q` doubles past 2^k - 1 while the loop's test, on `i`,
  // still holds, so the copy leaves at that head and the loop as written runs on from the
  // state it wrote back (`i` steps by a name: no counter copy takes the loop first)
  compare(`const a = new Float64Array(16)
export let f = (s, st, n) => {
  let i = 0, q = s, t = 0
  while (i < n) { a[q] += 1; t = t + a[1]; q = q * 2 + 1; i = i + st }
  return [i, q, t, a[1], a[3], a[15]]
}`, [[0, 1, 10], [0, 1, 40], [0, 1, 64], [5, 1, 31], [5, 2, 61], [2 ** 29, 1, 3], [2 ** 30 - 1, 1, 2], [2 ** 30, 1, 2], [-3, 1, 5], [0.5, 1, 4],
    [NaN, 1, 3], [0, 1, NaN], [-0, 1, 6], [0, 1, 0.5], [0, 1, -1], [0, 0.5, 3], [0, 2 ** 29, 2 ** 30]])
  // a stride by a name the loop does not write, of any sign; a start of any size
  compare(`const a = new Float64Array(16)
export let f = (s, st, n) => {
  let i = s, c = 0, last = 0
  while (i < n) { a[i] = c; last = i; i += st; if (++c > 50) break }
  return [i, last, c, a[0], a[3]]
}`, [[0, 1, 10], [0, 3, 2 ** 31], [2 ** 31 - 3, 1, 2 ** 31 + 3], [2 ** 31 - 3, 2, 2 ** 31 - 1], [0, 2 ** 30, 2 ** 32], [0, 2 ** 29, 2 ** 31 - 1],
    [0, -1, 5], [0, 0, 5], [-(2 ** 31), 1, -(2 ** 31) + 4], [0, 0.5, 4], [0, NaN, 4], [3.5, 1, 9], [0, 2 ** 31, 2 ** 33], [-0, 1, 3]])
})

test('boxed counters: the bound or the stride written in the body, a continue, a break', () => {
  compare(`const a = new Int32Array(32)
export let f = (s, st, n) => {
  let i = s, m = n, c = 0, skipped = 0
  while (i < m) {
    if (++c > 60) break
    if ((c & 3) === 0) { i += st; skipped++; continue }
    a[i] = c
    if (i > 2147483000) { m = m - st }
    i = i + st
    if (st > 1000) st = st * 2
  }
  return [i, m, c, skipped, a[0], a[7]]
}`, [[0, 1, 40], [2147482990, 3, 2147483660], [0, 1001, 2 ** 31], [0, 2 ** 28, 2 ** 31 + 1], [5, 7, 4], [0, -1, 3], [0, 0, 9]])
})

test('boxed counters: rfft answers what Node answers, its index locals words of the copy', () => {
  const src = readFileSync(new URL('../examples/rfft/rfft.js', import.meta.url), 'utf8')
  for (const optimize of levels(2, 'speed')) {
    const actual = run(src, { optimize }), expected = oracle(src)
    for (const n of [8, 64, 2048]) {
      const fill = (v) => { for (let i = 0; i < v.length; i++) v[i] = Math.sin(i * 0.37) + 0.25 * Math.cos(i * 1.9) }
      fill(actual.init(n)); fill(expected.init(n))
      actual.rfft(); expected.rfft()
      const a = actual.spectrum(), b = expected.spectrum()
      let worst = 0
      for (let i = 0; i < b.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]))
      ok(worst < 1e-9, `${JSON.stringify(optimize)}: the spectrum of ${n} points within 1e-9 (${worst})`)
    }
  }
  // the butterflies of every stage compare and index in integer registers: loops that store
  // elements with no floating comparison and no conversion of a counter
  const tree = parse(src, 'speed')
  let words = 0
  walk(tree, n => { if (n[0] === 'loop' && has(n, head(/^f64\.store$/)) && has(n, head(/^i32\.(lt|ge)_s$/)) && !has(n, head(/^f64\.(lt|le|gt|ge)$|^f64\.convert_i32|trunc_sat_f64/))) words++ })
  // (4 of 39 before the box, the bit reversal's and init's; 24 of 61 with it, its copies' butterflies)
  ok(words >= 16, `butterfly loops in words: ${words}`)
})
