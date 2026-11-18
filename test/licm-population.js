// A population of loops that compute a pure subexpression of invariant operands at some position
// of a larger one (optimize/licm.js hoistInvariantLoop takes it out of the loop, out of an outermost
// loop as well as a nested one), each answering what Node answers bit for bit at levels 0, 2, 3,
// 'size' and the speed tier at JavaScript's float results: a product in the middle and at the end
// of a sum, integer products, shifts and conversions, a nested loop, a vector loop; and what a hoist
// must not do, each a wrong answer if it did: an operand the loop writes on some path or after its
// use, a division, a remainder, a call that counts or throws, a load a test in the loop guards, and
// a read of memory the loop stores to (through the same name or another), moved ahead of a loop
// that runs no round; a sum regrouped; -0, infinities, NaN, denormals and words past 2^31 as
// operands. `n` is the trip count, 0 among them. A NaN's payload is held apart, below: to jz with
// no hoist, since JavaScript leaves it to the engine.
import test from 'tst'
import { is } from 'tst/assert.js'
import { jz } from './util.js'
import { population, norm, sampled } from './_population.js'

const CONFIGS = [0, 2, 3, 'size', { level: 'speed', relaxedFloat: false }]

// (a, b, n) each
const KERN = {
  mid: 'let s = 0; for (let i = 0; i < n; i++) s = s * 0.5 + a * b + i; return s',
  tail: 'let s = 1; for (let i = 0; i < n; i++) s = (s + i) - a * b; return s',
  chain: 'let s = 0; for (let i = 0; i < n; i++) s = s + i * 0.25 + a * b * a + (a - b); return s',
  zero: 'let s = -0; for (let i = 0; i < n; i++) s = a * b + s * 0; return s',
  sqrt: 'let s = 0; for (let i = 0; i < n; i++) s = s * 0.5 + Math.sqrt(a * b) + Math.abs(a) + Math.max(a, b); return s',
  imul: 'let t = 0; for (let i = 0; i < n; i++) t = (t + Math.imul(a, b) + i) | 0; return t',
  shift: 'let t = 0; for (let i = 0; i < n; i++) t = (t ^ ((a << 3) + (b >>> 1) + i)) | 0; return t',
  words: 'let s = 0; for (let i = 0; i < n; i++) s = s * 0.5 + (a | 0) * (b | 0) + i; return s',
  nested: 'let s = 0; for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) s = s * 0.5 + a * b + i * j; return s',
  inner: 'let s = 0; for (let j = 0; j < n; j++) { const c = a * j; for (let i = 0; i < n; i++) s = s * 0.5 + c * b + i } return s',
  somePath: 'let s = 0; for (let i = 0; i < n; i++) { s = s * 0.5 + a * b + i; if (i === 1) a = s } return s',
  lateWrite: 'let s = 0; for (let i = 0; i < n; i++) { s = s * 0.5 + a * b; a = a + 1 } return s',
  div: 'let s = 0; for (let i = 0; i < n; i++) s = s * 0.5 + ((a / b) | 0) + i; return s',
  rem: 'let s = 0; for (let i = 0; i < n; i++) s = s * 0.5 + a % b + i; return s',
  intDiv: 'let t = 0; for (let i = 0; i < n; i++) t = (t + (((a | 0) / (b | 0)) | 0) + i) | 0; return t',
  intRem: 'let t = 0; for (let i = 0; i < n; i++) t = (t + ((a | 0) % (b | 0)) + i) | 0; return t',
  order: 'let s = a; for (let i = 0; i < n; i++) s = (s + b) + b; return s',
  orderMul: 'let s = 1; for (let i = 0; i < n; i++) s = s * a * b; return s',
  // An inner loop of a constant count is written out (splitLoopPrivateScratch takes each def of a
  // local on its own). The binding a copy declares gets a local per assignment before then; an
  // accumulator declared outside the inner loop keeps one local over the copies, its terms
  // invariant or not by the copy (`mixed*`, mat4's shape). Then an unrolled sum's invariant prefix,
  // a def after a varying one, a read between two defs, a def under a test or in an inner loop, a
  // binding read after the loop, the sum's `0 + x` of an x of -0. A def that must stay is read
  // twice, so no pass before the split forwards it into its one read.
  mixedTail: 'let o = 0; for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < 4; k++) { const t = k < 2 ? a * b + k : i * 0.5 + k; s = s + t } o = o * 0.5 + s - s * 0.25 } return o',
  mixedMid: 'let o = 0; for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < 4; k++) { const t = k === 1 ? i - k : a * b - k; s = s * 0.5 + t } o = o * 0.5 + s - s * 0.25 } return o',
  mixedHead: 'let o = 0; for (let i = 0; i < n; i++) { let s = a; for (let k = 0; k < 3; k++) { const t = k === 0 ? i * b : a * b + k; s = s + t } o = o * 0.5 + s - s * 0.25 } return o',
  prefix: 'let o = 0; for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < 3; k++) { const t = a * b + k; s = s + t } s = s + i; o = o * 0.5 + s - s * 0.25 } return o',
  invVarRead: 'let o = 0; for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { let t = a * b + k; t = t + i; o = o * 0.5 + t; o = o - t * 0.25 } return o',
  readBetween: 'let o = 0; for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { let t = a * b + k; o = o * 0.5 + t; o = o + t * 0.5; t = t * i; o = o + t; o = o - t * 0.125 } return o',
  invAfterVar: `let o = 0; for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { let t = i * 0.5 + k; o = o * 0.5 + t; o = o + t * 0.5
    t = a * b - k; o = o + t; o = o - t * 0.5; t = t * a; o = o - t; o = o + t * 0.5; t = t + i; o = o - t; o = o + t * 0.25
    let u = i + k; u = u - u + a * b; o = o + u; o = o - u * 0.5 } return o`,
  underIf: 'let o = 0; for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { let t = a * b + k; if (i & 1) t = t + 1; o = o * 0.5 + t } return o',
  innerLoop: 'let o = 0; for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { let t = a * b + k; for (let j = 0; j < i; j++) t = t + j; o = o * 0.5 + t } return o',
  readAfter: 'let o = 0, t = 0; for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { t = a * b + k; o = o * 0.5 + t * i } return o + t',
  zeroSum: 'let r = 7; for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < 2; k++) { const t = a * b; s = s + t } r = s } return r',
}
const prog = (kern) => `export const f = (a, b, n) => { ${kern} }`

// programs with bindings of their own
const OWN = {
  call: `let cnt = 0
const twice = (x) => { cnt++; return x * 2 }
export const f = (a, b, n) => { cnt = 0; let s = 0; for (let i = 0; i < n; i++) s = s * 0.5 + twice(a) * b + i; return s + cnt * 1000 }`,
  throws: `const big = (x) => { if (x > 100) throw new RangeError('big'); return x * 3 }
export const f = (a, b, n) => { let s = 0; for (let i = 0; i < n; i++) s = s * 0.5 + big(a * b) + i; return s }`,
  guarded: `const tbl = new Float64Array(4)
export const f = (a, b, n) => { for (let i = 0; i < 4; i++) tbl[i] = i * 0.75 - 1; const k = b | 0; let s = 0
  for (let i = 0; i < n; i++) { if (k >= 0 && k < 4) s = s * 0.5 + tbl[k] * a; s = s + i } return s }`,
  plainRead: `const lst = [1.5, -2, 3.25]
export const f = (a, b, n) => { const k = b | 0; let s = 0; for (let i = 0; i < n; i++) s = s * 0.5 + (lst[k] ?? 7) * a + i; return s }`,
  stored: `const cell = new Float64Array(4)
export const f = (a, b, n) => { cell.fill(b); let s = 0; for (let i = 0; i < n; i++) { s = s * 0.5 + cell[0] * a + i; cell[0] = s } return s + cell[0] }`,
  alias: `const one = new Float64Array(4)
export const f = (a, b, n) => { one.fill(1); const two = one; let s = 0; for (let i = 0; i < n; i++) { s = s * 0.5 + one[1] * a + i; two[1] = s + b } return s + one[1] }`,
  vec: `const src = new Float64Array(8), dst = new Float64Array(8)
export const f = (a, b, n) => { for (let i = 0; i < 8; i++) { src[i] = i * 0.75 - 2; dst[i] = 0 } for (let i = 0; i < n; i++) dst[i] = src[i] * (a * b) + a; return [...dst] }`,
}

// (a, b): signed zeros, infinities, NaN, a denormal, an overflow, words past 2^31, a zero divisor, INT_MIN / -1
const AB = [[1.5, 2.5], [-0, 3], [0, -3], [Infinity, 0], [-Infinity, -2], [NaN, 2], [5e-324, 0.5], [1e308, 10],
  [-2147483648, -1], [2147483648, 2], [7, 0], [1e16, 1], [150, 1], [-7, 3]]
// A finite operand of a bitwise operation past 2^63 reads as -1 (README, "Bitwise operands under
// 2^63"): those rows take the operands below it, one just below it among them.
const BITWISE = new Set(['imul', 'shift', 'words', 'div', 'intDiv', 'intRem'])
const AB_WORDS = [...AB.filter(([a]) => a !== 1e308), [9007199254740993 * 512, 3]]
const NS = [0, 1, 3, 8]
const grid = (ab) => ab.flatMap(([a, b]) => NS.map(n => [a, b, n]))
const args = grid(AB), wordArgs = grid(AB_WORDS)

const progs = [
  ...Object.entries(KERN).map(([name, k]) => ({ name, src: prog(k), args: BITWISE.has(name) ? wordArgs : args })),
  ...Object.entries(OWN).map(([name, src]) => ({ name, src, args })),
]

test(sampled(`licm population: ${progs.length} loops with invariant subexpressions, ${args.length} operand sets and trip counts, ${CONFIGS.length} configurations`), () =>
  population('licm', progs, { configs: CONFIGS, own: ['cnt', 'twice', 'big', 'tbl', 'lst', 'cell', 'one', 'src', 'dst'] }))

// The bits of a NaN a product carries are the engine's own in JavaScript: Node 24 on x64 answers
// the canonical NaN for this program where Node 25 on arm64 answers the operand's payload (the
// hosted leg of CI met it). So the row is held to jz itself: every configuration that hoists
// `q * a` answers what the level with no hoist answers.
const PAYLOAD = `const word = new Uint32Array(2), bits = new Float64Array(word.buffer), outs = new Float64Array(2)
export const f = (a, b, n) => { word[0] = 0x12345; word[1] = 0x7ff80000; const q = bits[0]; outs[0] = 0; outs[1] = 0
  for (let i = 0; i < n; i++) outs[i & 1] = q * a + b; bits[0] = outs[0]; return [word[0], word[1]] }`
test(`licm population: a hoisted product keeps a NaN operand's payload as the level off computes it, ${args.length} operand sets`, () => {
  const plain = jz(PAYLOAD, { optimize: 0 }).exports
  const want = args.map(a => norm(plain.f(...a)))
  for (const optimize of CONFIGS.slice(1)) {
    const got = jz(PAYLOAD, { optimize }).exports
    args.forEach((a, i) => is(norm(got.f(...a)), want[i], `payload (${a.map(norm).join(', ')}) at ${JSON.stringify(optimize)}`))
  }
})
