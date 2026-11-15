// Populations of the classes whose local rewrites answered wrong, each answering what Node
// answers at levels 0 to 3, size and speed:
// - two shifts by constants, every pair of counts from a set with negatives and counts past the
//   width, for each operator pair, on Numbers (a count taken mod 32) and on BigInts (a count of
//   either sign and any size, the result wrapped to 64 bits: README, "BigInt is 64-bit");
// - a Boolean as an addend or a subtrahend of a Number, written as a comparison, a ternary of
//   1 and 0 and a local every write of which is a comparison (the speed tier's select), the
//   Number -0, +0, NaN, an infinity or a fraction;
// - a ternary of a Boolean and a value of another kind under a condition the emitter reads as a
//   constant (`(1 % 4294967296)`, a counter of an unrolled loop), compared strictly and loosely
//   with 1, true, 0, false and 0.5, beside the same forms under a condition it does not;
// - reads and writes of arrays at indexes computed past either end, the invariant the memarg
//   fold, the low word of a slot's load and merged byte stores hold to (an access addresses
//   its object inside memory, so its address sum does not wrap and it does not trap): typed
//   arrays of each width and plain arrays, indexes a sum, a product and a word of an input that
//   is negative, past 2^31, past 2^32, a fraction or NaN, and in a loop.
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

test('rules population: a Boolean as an addend of a Number', () => {
  const tests = ['a < b', 'a >= b', 'a === b', 'x < a']
  const fns = []
  for (const t of tests) fns.push(
    `(x, a, b) => { a = a | 0; b = b | 0; return x + (${t}) }`,
    `(x, a, b) => { a = a | 0; b = b | 0; return (${t}) + x }`,
    `(x, a, b) => { a = a | 0; b = b | 0; return x - (${t}) }`,
    `(x, a, b) => { a = a | 0; b = b | 0; return x + (${t} ? 1 : 0) }`,
    `(x, a, b) => { a = a | 0; b = b | 0; return x - (${t} ? 1 : 0) }`,
    `(x, a, b) => { a = a | 0; b = b | 0; let on = ${t} ? 1 : 0; return x + on }`,
    `(x, a, b) => { a = a | 0; b = b | 0; let on = ${t} ? 1 : 0; return x - on }`,
    // (a recurrence: the select the speed tier makes is read again each round)
    `(x, a, b) => { a = a | 0; b = b | 0; let acc = x; for (let i = 0; i < 3; i++) { let on = acc >= a ? 1 : 0; acc = acc + on * 0 + (${t}) } return acc }`)
  const xs = [-0, 0, NaN, Infinity, -Infinity, 1.5, -1]
  const inputs = []
  for (const x of xs) for (const [a, b] of [[1, 0], [0, 1], [2, 2], [-1, 0]]) inputs.push([x, a, b])
  population('Boolean addend', program(fns), names(fns), inputs)
})

test('rules population: a ternary of a Boolean and another kind, its condition a constant', () => {
  const conds = ['(1 % 4294967296)', '(0 % 7)', '(3 > 2)', '(2 - 2)', '!0', 'k']
  const arms = [['(c !== k)', '0.5'], ['0.5', '(c < k)'], ['(c !== k)', 'c'], ['(c === 2)', '1'], ['"s"', '(c > 1)']]
  const cmps = ['=== 1', '!== 1', '=== true', '== 1', '== true', '!== 0', '== 0', '=== false', '!== 0.5']
  const fns = []
  for (const cond of conds) for (const [p, q] of arms) for (const cmp of cmps)
    fns.push(`(c, k) => (${cond} ? ${p} : ${q}) ${cmp}`)
  // (the defect's own form: an unrolled loop's counter makes the condition a literal)
  for (const cmp of cmps) fns.push(`(c, k) => { let r = 0; for (let i = 0; i < 3; i++) { r += ((i % 4294967296) ? (c !== i) : 0.5) ${cmp} } return r }`)
  const inputs = [[1, 1], [2, 0], [0, 2], [NaN, 1], [1, 0], [-0, 0]]
  population('constant ternary of mixed kinds', program(fns), names(fns), inputs)
})

// The phase 8 scout's three reaches as it wrote them (the forms above hold each class): two shifts
// with a count outside 0..31, -0 plus a false comparison, a comparison of a mixed ternary whose
// condition an unrolled counter makes a literal.
test('rules population: the phase 8 scout\'s reaches', () => {
  const REACHES = [
    ['shift by a count outside 0..31, twice', `export let f = (x) => { x = x | 0; return ((x << -1) << 1) | 0 }`, [[1], [3], [-1]]],
    ['shift twice, the other order', `export let f = (x) => { x = x | 0; return ((x << 1) << -1) | 0 }`, [[1], [3]]],
    ['shift by 33 then 1', `export let f = (x) => { x = x | 0; return ((x << 33) << 1) | 0 }`, [[1], [5]]],
    ['-0 plus a false comparison', `export let f = (x, a, b) => { a = a | 0; b = b | 0; return x + (a < b) }`, [[-0, 1, 0], [-0, 0, 1], [2, 1, 0]]],
    ['a comparison of a mixed ternary', `export let f = (c) => { let r = 0; for (let i = 0; i < 3; i++) { r += (((i % 4294967296) ? (c !== i) : 0.5) !== 1) } return r }`, [[1], [0]]],
  ]
  for (const [label, src, inputs] of REACHES) population(label, src, ['f'], inputs)
})

test('rules population: reads and writes of arrays past either end', () => {
  const kinds = ['Int32Array', 'Float64Array', 'Uint8Array', 'Uint16Array', 'Int8Array', 'Float32Array']
  const at = ['i + 1', 'i - 1', 'i * 4 + 3', '(i + 4) | 0', 'i - 536870912 + 1', '(i << 2) + 8', 'i + 2147483647']
  const fns = []
  for (const k of kinds) for (const ix of at) fns.push(
    `(i, v) => { const a = new ${k}(16); a[3] = 7; a[15] = 9; return a[${ix}] }`,
    `(i, v) => { const a = new ${k}(16); a[${ix}] = v; let s = 0; for (let j = 0; j < 16; j++) s += a[j]; return s }`)
  for (const ix of at) fns.push(`(i, v) => { const a = [1, 2, 3, 4]; return a[${ix}] }`)
  // (a loop of reads around an index: the walk's sums and the lift's offsets)
  for (const k of kinds) fns.push(`(i, v) => { const a = new ${k}(16); a[2] = 5; let s = 0; for (let j = 0; j < 4; j++) s += a[i + j + 2] | 0; return s }`,
    `(i, v) => { const a = new ${k}(32); for (let j = 0; j < 32; j++) a[j] = j; let s = 0; for (let j = 0; j < 8; j++) s += a[(i & 7) + j * 2 + 1]; return s }`)
  const inputs = []
  for (const i of [0, 1, -1, 2, 3, 15, 16, 100, 2147483647, -2147483648, 1073741823, -1073741824, 536870911, 536870912, 4294967295, 4294967296, 1e9, -1e9, 12345678901, 2.5, NaN])
    inputs.push([i, 3])
  population('accesses past either end', program(fns), names(fns), inputs)
})
