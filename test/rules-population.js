// Populations of the classes whose local rewrites answered wrong, each answering what Node
// answers at levels 0 to 3, size and speed:
// - two shifts by constants, every pair of counts from a set with negatives and counts past the
//   width, for each operator pair, on Numbers (a count taken mod 32) and on BigInts (a count of
//   either sign and any size, the result wrapped to 64 bits: README, "BigInt is 64-bit").
import test from 'tst'
import { is } from 'tst/assert.js'
import { jz, oracle } from './util.js'

const CONFIGS = [0, 1, 2, 3, 'size', 'speed']
const same = (a, b) => Object.is(a, b) || (typeof a === 'bigint' && a === b)
// Every export of `src` called with every argument tuple, at every configuration: one assertion a differing call.
const population = (label, src, names, inputs) => {
  const want = oracle(src)
  for (const optimize of CONFIGS) {
    const got = jz(src, { optimize }).exports
    for (const name of names) for (const args of inputs) {
      const a = got[name](...args), b = want[name](...args)
      if (!same(a, b)) is(a, b, `${label}: ${name}(${args.map(String).join(', ')}) at ${JSON.stringify(optimize)}`)
    }
  }
  is(true, true, `${label}: ${names.length} programs, ${inputs.length} inputs, ${CONFIGS.length} configurations`)
}
const program = (fns) => fns.map((s, i) => `export let f${i} = ${s}`).join('\n')
const names = (fns) => fns.map((_, i) => `f${i}`)

const COUNTS = [-33, -32, -31, -1, 0, 1, 2, 15, 30, 31, 32, 33, 63, 64]
const WORDS = [[0], [1], [-1], [3], [0x7fffffff], [-0x80000000], [0x12345678], [2.5], [-0], [NaN]]
for (const a of ['<<', '>>', '>>>']) for (const b of ['<<', '>>', '>>>'])
  test(`rules population: (x ${a} K1) ${b} K2 over ${COUNTS.length}² counts`, () => {
    const fns = []
    for (const k1 of COUNTS) for (const k2 of COUNTS) fns.push(`(x) => (x ${a} ${k1}) ${b} ${k2}`)
    population(`(x ${a} K1) ${b} K2`, program(fns), names(fns), WORDS)
  })

const BIG_COUNTS = [-65, -64, -63, -33, -1, 0, 1, 2, 31, 32, 33, 63, 64, 65]
const BIGS = [[0n], [1n], [-1n], [0x123456789abcdefn], [-(2n ** 63n)], [2n ** 63n - 1n]]
for (const a of ['<<', '>>']) for (const b of ['<<', '>>'])
  test(`rules population: BigInt (x ${a} K1) ${b} K2 over ${BIG_COUNTS.length}² counts`, () => {
    const fns = []
    for (const k1 of BIG_COUNTS) for (const k2 of BIG_COUNTS) fns.push(`(x) => BigInt.asIntN(64, BigInt.asIntN(64, x ${a} ${k1}n) ${b} ${k2}n)`)
    population(`BigInt (x ${a} K1) ${b} K2`, program(fns), names(fns), BIGS)
  })
