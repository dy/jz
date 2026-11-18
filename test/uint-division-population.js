// A population of divisions and remainders where an operand is a uint32 (a Uint32Array element,
// `x >>> 0`, a local or an assignment holding one, a sum's `>>> 0`), each answering what Node
// answers at levels 0 to 3, size and speed. JS divides the Numbers (ECMA-262 13.7, Number::divide
// and Number::remainder, then ToInt32 for `| 0`); a signed i32 division of the word's bits reads
// a value past 2^31 as negative: `((x >>> 0) / 3) | 0` was -715827882 at x = 2^31 at levels 2 and
// over, and `u[1] % n` of a Uint32Array element took its widening at every level
// (compile/emit/bitwise.js tryIntDivTrunc; test/unsigned.js pins the first 21 of each operand's
// 27 at levels 0, 2 and size). Each by a literal of either sign and zero, by a uint32 local and
// element, by a word and an Int32Array element and they by it; a remainder; the quotient stored,
// read unsigned, floored, truncated; a product, a comparison and a shift beside them.
import test from 'tst'
import { population, sampled } from './_population.js'

const CONFIGS = [0, 1, 2, 3, 'size', 'speed']
const U = { 'element': ['const a = new Uint32Array(4); a[1] = x', 'a[1]'], 'shift': ['', '(x >>> 0)'], 'local': ['const u = x >>> 0', 'u'],
  'let': ['let u = 0; u = x >>> 0', 'u'], 'sum shift': ['', '((x + y) >>> 0)'] }
const S = { 'int': ['const s = y | 0', 's'], 'element i32': ['const c = new Int32Array(2); c[1] = y', 'c[1]'] }
const P = {}
for (const [un, [upre, u]] of Object.entries(U)) {
  for (const d of [1, 2, 3, 7, 16, 65536, 1000000007, -1, -2, -3, 0]) P[`${un} / ${d}`] = `${upre}; return (${u} / ${d}) | 0`
  P[`${un} / unsigned`] = `${upre}; const v = y >>> 0; return (${u} / v) | 0`
  P[`${un} / element`] = `${upre}; const b = new Uint32Array(2); b[1] = y; return (${u} / b[1]) | 0`
  for (const [sn, [spre, s]] of Object.entries(S)) {
    P[`${un} / ${sn}`] = `${upre}; ${spre}; return (${u} / ${s}) | 0`
    P[`${sn} / ${un}`] = `${upre}; ${spre}; return (${s} / ${u}) | 0`
  }
  P[`${un} % 7`] = `${upre}; return (${u} % 7) | 0`
  P[`${un} % y`] = `${upre}; const s = y | 0; return (${u} % s) | 0`
  P[`${un} / 3 stored`] = `${upre}; const o = new Uint32Array(2); o[0] = (${u} / 3) | 0; return o[0]`
  P[`${un} / 3 unsigned result`] = `${upre}; return (${u} / 3) >>> 0`
  P[`${un} / 3 floor`] = `${upre}; return Math.floor(${u} / 3)`
  P[`${un} / 3 trunc`] = `${upre}; return Math.trunc(${u} / 3)`
  P[`${un} * 3 | 0`] = `${upre}; return (${u} * 3) | 0`
  P[`${un} > y`] = `${upre}; const s = y | 0; return ${u} > s ? 1 : 2`
  P[`${un} >> 1`] = `${upre}; return ${u} >> 1`
  P[`${un} / 2 | 0 then + 1`] = `${upre}; return ((${u} / 2) | 0) + 1`
}
const X = [0, 1, 5, 2147483647, 2147483648, 3000000000, 4294967295, -1, -5], Y = [0, 1, 3, -3, 2147483648, 4294967295, -2147483648]
const ARGS = X.flatMap(x => Y.map(y => [x, y]))
const progs = Object.entries(P).map(([name, body]) => ({ name, src: `export let f = (x, y) => { ${body} }`, args: ARGS }))

test(sampled(`uint division population: ${progs.length} divisions and remainders of a uint32, ${ARGS.length} argument pairs, ${CONFIGS.length} configurations`), () =>
  population('uint division', progs, { configs: CONFIGS }))
