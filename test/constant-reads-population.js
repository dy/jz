// A population of programs that hold a constant in a local and read it after (optimize/numbering.js
// CONSTANT, the step `propagateConstants`), each answering what Node answers bit for bit at levels
// 0, 2, 3, 'size' and the speed tier at JavaScript's float results: compose's 0 and 1 stored into a
// matrix and multiplied, a constant written twice, a copy of one, a constant on both ways into a
// join; and what must read as no constant, each a wrong answer if it did: a constant written on one
// way only, 0 on one way and -0 on the other, a store whose value is the constant under a test, a
// read in a round before the round's write, a break out of a block between two writes, a fall
// through `switch`, a catch after a write the throw skipped. The operands take -0, infinities, NaN
// and the payload of a NaN read from memory, multiplied by 1 and added to 0 and -0: `x * 1` and
// `x + 0` are not `x` for every x. `n` is the trip count, 0 among them.
import test from 'tst'
import { population } from './_population.js'

const CONFIGS = [0, 2, 3, 'size', { level: 'speed', relaxedFloat: false }]

// (a, b, n) each
const KERN = {
  twice: 'let z = 0.5; let s = a * z; z = 3; s = s + b * z; return s',
  copy: 'const k = 0; let z = k; let s = 0; for (let i = 0; i < n; i++) s = s + a * z + i; return s',
  bothArms: 'let z = 2; if (a > b) z = 0; else z = 0; return a * z + b * z',
  onePath: 'let z = b; if (a > 0) z = 0; return a * z + 1 / z',
  signedZero: 'let z = 0; if (a > b) z = 0; else z = -0; return 1 / z + a * z',
  beforeWrite: 'let z = 5, s = 0; for (let i = 0; i < n; i++) { s = s * 0.5 + a * z; z = 0 } return s + z',
  kept: 'const z = 0.25; let s = 0; for (let i = 0; i < n; i++) s = s + a * z; return s + z',
  breakOut: 'let z = 1; for (;;) { z = 0; if (a > b) break; z = 2; break } return a * z + z',
  fallThrough: 'let z = 1; switch (n) { case 0: z = 0; case 1: z = z + 1; break; case 3: z = -0; break; default: z = 4 } return 1 / z + a * z',
  identities: 'const one = 1, zero = 0, nzero = -0; return [a * one, a + zero, a + nzero, zero + a, a - zero, b * one]',
}
const prog = (kern) => `export const f = (a, b, n) => { ${kern} }`

// programs with bindings of their own
const OWN = {
  // three.js's Matrix4.compose and multiply, the shape of threescene's loop
  compose: `const te = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], pe = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], oe = new Float64Array(16)
export const f = (a, b, n) => {
  for (let k = 0; k < 16; k++) pe[k] = (k + 1) * 0.25 - b
  let s = 0
  for (let i = 0; i < n + 1; i++) {
    te[0] = a; te[1] = 0; te[2] = 0; te[3] = 0
    te[4] = 0; te[5] = b; te[6] = 0; te[7] = 0
    te[8] = 0; te[9] = 0; te[10] = a * b; te[11] = 0
    te[12] = i; te[13] = a; te[14] = b; te[15] = 1
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 4; c++)
        oe[r + c * 4] = pe[r] * te[c * 4] + pe[r + 4] * te[c * 4 + 1] + pe[r + 8] * te[c * 4 + 2] + pe[r + 12] * te[c * 4 + 3]
    s = s * 0.5 + oe[3] + oe[15] - oe[12]
  }
  return [s, ...oe]
}`,
  storeUnderIf: `const cell = [1, 2, 3]
export const f = (a, b, n) => { cell[1] = 2; let z = b; if (a > 0) cell[1] = z = 0; return cell[1] * a + z + 1 / z }`,
  caught: `const boom = (x) => { if (x > 1) throw new RangeError('big'); return x }
export const f = (a, b, n) => { let z = 1; try { z = 0; boom(a); z = 2 } catch (e) { return 1 / z + b * z } return 1 / z + b * z }`,
  // (quiet NaNs: a signaling one times a literal 1 keeps its bits at every level, where Node quiets
  // it, a fold of the source's `x * 1` older than this step)
  payload: `const word = new Uint32Array(8), bits = new Float64Array(word.buffer)
export const f = (a, b, n) => { word[0] = 0x12345; word[1] = 0x7ff80000; word[2] = 0xabc; word[3] = 0xfff80000; word[4] = 7; word[5] = 0x7ff80001
  const one = 1, zero = 0
  for (let k = 0; k < 3; k++) { const q = bits[k]; bits[k] = n & 1 ? q * one : q + zero }
  bits[3] = a * one
  return [...word] }`,
}

// (a, b): signed zeros, infinities, NaN, a denormal, an overflow, words past 2^31
const AB = [[1.5, 2.5], [-0, 3], [0, -0], [-0, -0], [Infinity, 0], [-Infinity, -2], [NaN, 2], [5e-324, 0.5], [1e308, 10],
  [-2147483648, -1], [2147483648, 2], [7, 0], [-7, 3]]
const NS = [0, 1, 3, 8]
const args = AB.flatMap(([a, b]) => NS.map(n => [a, b, n]))

const progs = [
  ...Object.entries(KERN).map(([name, k]) => ({ name, src: prog(k), args })),
  ...Object.entries(OWN).map(([name, src]) => ({ name, src, args })),
]

test(`constant reads population: ${progs.length} programs that hold a constant in a local, ${args.length} operand sets and trip counts, ${CONFIGS.length} configurations`, () =>
  population('constant reads', progs, { configs: CONFIGS, own: ['te', 'pe', 'oe', 'cell', 'boom', 'word', 'bits'] }))
