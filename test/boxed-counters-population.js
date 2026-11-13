// A population of loops over integers they write themselves (src/compile/plan/integral-loops.js,
// a box's words), each answering what Node answers at levels 0 to 3, size and speed: a stride by
// a name, a recurrence, rfft's geometric pair and its stage loops' shifts and difference; tested
// by `<`, `<=`, `>`, `>=` and `!==`, up and down; the bound or the stride written in the body, a
// `continue`, a `break`, an inner loop over the held name; every value read after the loop. Starts,
// bounds and strides at the word's edges and past them, a fraction, NaN, -0, an infinity, a
// negative. Every loop stops after 40 rounds, where Node itself may not: an operand of a bit
// operation stays below 2^63 (README, "Bitwise operands under 2^63").
import test from 'tst'
import { is } from 'tst/assert.js'
import { jz, oracle } from './util.js'

const CONFIGS = [0, 1, 2, 3, 'size', 'speed']
const W = 2 ** 31
const STARTS = [0, 1, -1, -0, 3.5, W - 3, W - 1, W, 2 ** 29 - 1, NaN, 2 ** 53]
const STRIDES = [1, 2, 3, 0, -1, 0.5, 2 ** 28, 2 ** 29, W - 1, NaN]
const BOUNDS = [0, 5, 64, W - 2, W - 1, W, 2 ** 32 - 1, 2 ** 32, 2 ** 53, -1, 0.5, NaN, Infinity, -Infinity, 2 ** 29 - 1, 3 * 2 ** 29 - 1]

// [name, the declarations, a round's work and step, the names it returns]
const UP = [
  ['stride', '', 'a[i] = c; i += st', 'i'],
  ['recurrence', '', 'a[i] = c; i = i * 2 + st', 'i'],
  ['geometric', 'let q = st', 'a[q] = c; i = 2 * (q - 1); q *= 4', 'i, q'],
  ['shifts', 'let q = st << 1', 'a[i] = c; i = (q << 1) - st; q = q << 2', 'i, q'],
]
const DOWN = [
  ['stride down', '', 'a[i] = c; i -= st', 'i'],
  ['halving', '', 'a[i] = c; i = i - (st + i % 3)', 'i'],
]
const TESTS_UP = ['i < n', 'i <= n', 'n > i', 'n >= i', 'i !== n']
const TESTS_DOWN = ['i > n', 'i >= n']
// what a round does besides its work: [name, before the work, after it]
const MODS = [
  ['', '', ''],
  ['continue', 'if (c % 4 === 2) { i += 1; continue }', ''],
  ['bound written', '', 'if (c === 7) n = n - 3'],
  ['stride written', '', 'if (c === 5) st = st + 1'],
  ['break', 'if (a[1] === 3) break', ''],
  ['nest', '', 'let j = i, k = 0; while (j < n && k < 3) { a[j] += 1; j += st; k++ } t += j'],
]

const loops = []
for (const [dir, shapes, tests] of [['up', UP, TESTS_UP], ['down', DOWN, TESTS_DOWN]])
  for (const [shape, decl, work, names] of shapes) for (const t of tests) for (const [mod, before, after] of MODS)
    loops.push({ name: `${shape} while (${t})${mod ? ', ' + mod : ''}`, src: `(s, st, n) => {
  let i = s, c = 0, t = 0; ${decl}
  while (${t}) { if (++c > 40) break; ${before}; ${work}; ${after} }
  return [${names}, c, t, a[0], a[1], a[5]]
}` })

const program = loops.map((l, k) => `export let f${k} = ${l.src}`).join('\n')
const SRC = `const a = new Float64Array(8)\n${program}`

test(`boxed counters population: ${loops.length} loops over integers they write, ${CONFIGS.length} configurations`, () => {
  for (const optimize of CONFIGS) {
    const got = jz(SRC, { optimize }).exports, want = oracle(SRC)
    loops.forEach(({ name }, k) => {
      for (const s of STARTS) for (const st of STRIDES) for (const n of BOUNDS) {
        const a = got[`f${k}`](s, st, n), b = want[`f${k}`](s, st, n)
        // (one assertion per differing call: the population is large; -0 and NaN told apart)
        if (a.length !== b.length || a.some((x, i) => !Object.is(x, b[i]))) is(a, b, `${name} (s = ${s}, st = ${st}, n = ${n}) at ${JSON.stringify(optimize)}`)
      }
    })
    is(true, true, `${loops.length} loops at ${JSON.stringify(optimize)}`)
  }
})
