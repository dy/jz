// A population of loops over a typed array whose bound is an expression of words that leaves the
// word, each answering what Node answers at levels 0 to 3, size and speed: a sum, a product, a
// difference, a sum of three, a shift, a double, a successor and a sum's `>>> 0`, of two words
// `B0 = b | 0`, `B1 = t | 0` at the word's edges; tested by `<` and `<=`, stepped by one and two,
// from a start at either end of the array and before it; read with a presence test, read as a
// word, stored under a test of the length; a Uint8Array and a Float64Array. The extent guard
// computed such a bound through ToInt32: `i < B0 + B1` is 2^31 at B0 = B1 = 2^30, the guard read
// -2^31, under every length, and the arm with no bounds checks read past the array at levels 2
// and over (.work/architecture.md, "Counters by a bound test: two fixes landed, the tier not";
// 8b9c75438). Every loop leaves by its own count of 44.
import test from 'tst'
import { population, sampled } from './_population.js'

const CONFIGS = [0, 1, 2, 3, 'size', 'speed']
const E30 = 2 ** 30, E31 = 2 ** 31
// [the bound, the (b, t) pairs it is called with]
const BOUNDS = [
  ['B0 + B1', [[E30, E30], [E30 - 1, E30], [E30, E30 + 1], [E31 - 1, 1], [E31 - 1, E31 - 1], [5, 4], [-E31, -1], [-E30, -E30 - 1]]],
  ['B0 * B1', [[65536, 32768], [65536, 65536], [46341, 46341], [3, 3], [-65536, 65536], [E30, 2], [E30, 4]]],
  ['B0 - B1', [[E31 - 1, -1], [E30, -E30], [9, 2], [-E31, 1], [0, -E31]]],
  ['B0 + B1 + B0', [[E30, 1], [715827883, 715827883], [3, 2]]],
  ['B0 << B1', [[1, 31], [E30, 1], [3, 2], [1, 32]]],
  ['B0 * 2', [[E30, 0], [E30 - 1, 0], [4, 0]]],
  ['B0 + 1', [[E31 - 1, 0], [7, 0]]],
  ['(B0 + B1) >>> 0', [[E30, E30], [-1, 0], [4, 4]]],
]
const BODIES = [
  'if (x[i] === undefined) u++; else sum += x[i]',
  'sum += x[i] | 0',
  'if (i < x.length) x[i] = x[i] + 1; u += x[i] === undefined ? 1 : 0',
]
const progs = []
for (const [bound, pairs] of BOUNDS) for (const step of ['i++', 'i += 2']) for (const op of ['<', '<=']) for (const body of BODIES) for (const K of ['Uint8Array', 'Float64Array'])
  progs.push({
    name: `${K}, i ${op} ${bound}, ${step}, ${body}`,
    src: `export let f = (b, t, s) => { const x = new ${K}(16); for (let k = 0; k < 16; k++) x[k] = k + 1
  const B0 = b | 0, B1 = t | 0; let c = 0, u = 0, sum = 0
  for (let i = s; i ${op} ${bound}; ${step}) { if (++c > 44) break; ${body} }
  return c * 1000000 + u * 1000 + sum }`,
    args: pairs.flatMap(([b, t]) => [0, 3, -2, 14].map(s => [b, t, s])),
  })

test(sampled(`bound wrap population: ${progs.length} loops bounded by an expression of words past the word, ${CONFIGS.length} configurations`), () =>
  population('bound wrap', progs, { configs: CONFIGS }))
