// Populations of the loops the bound tier admits (a counter an f64 for want of a range on its
// bound, or whose hull is a step or a sum past the word), each program answering what Node
// answers at levels 0 to 3, size and speed. The tier (238aedd6e) is not landed; the loops it was
// written for are, and three wrong answers were found in its work, each fixed on main
// (.work/architecture.md, "Counters by a bound test: two fixes landed, the tier not"): the
// extent guard reading an expression bound through ToInt32 (8b9c75438), `int32Held` reading any
// `.length` as a word (fe734da8c, a047f51d0 in the notes), and the range-check fusion reading a
// uint32 as a signed word (260de4584, ada395f86 in the notes).
// The bound a word, a uint32, a sum or a difference of words, another receiver's length, a module
// binding a step wrote; `for` and `while` up and down by literal steps from the word's edges;
// nests, exits, a bound the body moves, an inner function's integral parameter. Beside them a
// stable name of the box or a bound read from a `.length` the receiver may not make an integer,
// and a `for` counter entering from a name the planner reads as a word as written, under a
// fractional bound. Each scratch population is a block of its own below, its names its own.
import test from 'tst'
import { population } from './_population.js'

const CONFIGS = [0, 1, 2, 3, 'size', 'speed']

// ---- the loops the tier admits, at the word's edges (every program `f(b, s, t)`)
{
const CAP = 44
const X8 = 'const x8 = new Float64Array(8); for (let q = 0; q < 8; q++) x8[q] = q + 1'
const SUM8 = 'x8[0] + 2 * x8[1] + 3 * x8[2] + 4 * x8[3] + 5 * x8[4] + 6 * x8[5] + 7 * x8[6] + 8 * x8[7]'
const BODY = {
  sum: i => `sum += ${i}`,
  read: i => `if (x8[${i}] === undefined) u++; else sum += x8[${i}]`,
  mask: i => `sum += x8[${i} & 7] + (${i} % 7)`,
  store: i => `x8[${i}] = c + 10; sum += ${i} * 2`,
}
const BODIES = Object.keys(BODY)
// where the bound comes from: [module prelude, setup inside f, the test's bound]. Each is a form the tier admits: a word,
// a uint, a sum or a difference of words, another receiver's length, a module binding a step wrote, a parameter of an
// inner function every call passes an integer of none.
const BOUND = {
  word: ['', 'const B = b | 0', 'B'],
  uint: ['', 'const B = b >>> 0', 'B'],
  sum: ['', 'const B0 = b | 0, B1 = t | 0', 'B0 + B1'],
  diff: ['', 'const B0 = b | 0, B1 = t | 0', 'B0 - B1'],
  length: ['', 'const o = t !== 7 ? { length: b } : [1, 2, 3], B = o.length', 'B'],
  stepped: ['let N = 0\nexport let pre = (b, s, t) => { N = 0; const k = b | 0; if (k > 0 && k < 100) { for (let q = 0; q < k; q++) N++ } else N = k }', 'const B = N', 'N'],
  module: ['let N = 0\nexport let pre = (b, s, t) => { N = b | 0 }', '', 'N'],
}
const BOUNDS = Object.keys(BOUND)
const noBig = (args) => args.filter(a => !(Math.abs(a[0]) >= 2 ** 63) && !(Math.abs(a[2]) >= 2 ** 63))
const P = []
const prog = (name, prelude, body, args) => P.push({ name, src: `${prelude}\nexport let f = (b, s, t) => {\n  ${X8}\n  let c = 0, u = 0\n  ${body}\n}`, args })

const E31 = 2147483648, E32 = 4294967296
const edges = [E31 - 3, E31 - 2, E31 - 1, E31, E31 + 1, E32 - 1, E32, -E31, -E31 - 1, -E31 + 1, -E31 + 2, 1073741824, 2 ** 53]
const small = [0, 1, 2, 5, 8, 8.5, 9, 40, -1, -0, NaN, -Infinity, Infinity, 2.5, 7.25]
const capped = []
{
  const Bs = [...small, ...edges], Ss = [0, 7, 2147483640, 2147483645, 2147483647, -2147483648, -2147483646, -5, 0.5, NaN],
    Ts = [0, 1, 3, 7, -1, 2147483647, -2147483648, 1073741824, 0.5, -0]
  let k = 0
  for (const B of Bs) for (const S of Ss) for (const T of Ts) if (k++ % 3 === 0 || Math.abs(B) > 1e9 && Math.abs(S) > 1e9) capped.push([B, S, T])
}

// ---- A. `for`, the counter in the head, by steps of 1 to 4, up and down
let n = 0
for (const op of ['<', '<=']) for (const step of [1, 2, 4]) for (const start of ['0', 's', '2147483640', '-2147483648']) for (const bound of BOUNDS) {
  const body = BODIES[n++ % BODIES.length], [pre, setup, B] = BOUND[bound]
  prog(`for ${op} step ${step} from ${start} bound ${bound} ${body}`, pre,
    `${setup}\n  let sum = 0\n  for (let i = ${start}; i ${op} ${B}; ${step === 1 ? 'i++' : `i += ${step}`}) { if (++c > ${CAP}) break; ${BODY[body]('i')} }\n  return [c, sum, u, ${SUM8}]`, noBig(capped))
}
for (const op of ['>', '>=']) for (const step of [1, 3]) for (const start of ['s', '2147483647', '-2147483640']) for (const bound of BOUNDS) {
  const body = BODIES[n++ % BODIES.length], [pre, setup, B] = BOUND[bound]
  prog(`for ${op} step -${step} from ${start} bound ${bound} ${body}`, pre,
    `${setup}\n  let sum = 0\n  for (let i = ${start}; i ${op} ${B}; ${step === 1 ? 'i--' : `i -= ${step}`}) { if (++c > ${CAP}) break; ${BODY[body]('i')} }\n  return [c, sum, u, ${SUM8}]`, noBig(capped))
}
// ---- B. `while`, the counter declared outside and read after; up by literals, down by one
for (const op of ['<', '<=']) for (const step of [1, 2]) for (const start of ['0', 's | 0', '2147483640']) for (const bound of BOUNDS) {
  const body = BODIES[n++ % BODIES.length], [pre, setup, B] = BOUND[bound]
  prog(`while ${op} step ${step} from ${start} bound ${bound} ${body}`, pre,
    `${setup}\n  let sum = 0, i = ${start}\n  while (i ${op} ${B}) { if (++c > ${CAP}) break; ${BODY[body]('i')}; i += ${step} }\n  return [c, sum, u, i, ${SUM8}]`, noBig(capped))
}
for (const op of ['>', '>=']) for (const start of ['s | 0', '2147483647']) for (const bound of BOUNDS) {
  const body = BODIES[n++ % BODIES.length], [pre, setup, B] = BOUND[bound]
  prog(`while ${op} step -1 from ${start} bound ${bound} ${body}`, pre,
    `${setup}\n  let sum = 0, i = ${start}\n  while (i ${op} ${B}) { if (++c > ${CAP}) break; ${BODY[body]('i')}; i-- }\n  return [c, sum, u, i, ${SUM8}]`, noBig(capped))
}
// ---- C. uncapped: the bound alone decides the trips (only arguments that end in a few)
const near = []
for (const B of [E31 - 1, E31 - 2, E31 - 3, E31, E31 + 1, 1073741824, 0, 8, -1, NaN]) for (const k of [0, 1, 3, 6]) near.push([B, B - k, 0])
for (const op of ['<', '<=']) for (const step of [1, 2, 3]) for (const bound of ['word', 'uint', 'sum']) {
  const [pre, setup, B] = BOUND[bound]
  // (a uint bound of a negative or NaN argument is 2^32 - 1 or 0, far from the start: not an argument that ends soon)
  const args = noBig(near).filter(([b]) => bound !== 'uint' || b >= 0 && b < 4294967296)
  prog(`uncapped: for ${op} step ${step} from s bound ${bound}`, pre,
    `${setup}\n  let sum = 0, last = 0\n  for (let i = s; i ${op} ${B}; i += ${step}) { c++; last = i; sum += x8[i & 7] }\n  return [c, sum, last]`, args)
  prog(`uncapped: while ${op} step ${step} from s bound ${bound}`, pre,
    `${setup}\n  let sum = 0, i = s\n  while (i ${op} ${B}) { c++; sum += x8[i & 7]; i += ${step} }\n  return [c, sum, i]`, args)
}
// ---- D. nests: the tier's loop around a loop the planner copies with no tier (its other arm keeps that copy)
for (const bound of ['word', 'sum', 'length', 'module']) {
  const [pre, setup, B] = BOUND[bound]
  prog(`nest: for <= ${bound} around an inner copy`, pre,
    `${setup}\n  let sum = 0, w = s\n  for (let i = 0; i <= ${B}; i++) { if (++c > 12) break; for (let j = 0; j < w; j++) { if (j > 9) break; sum += x8[(i + j) & 7] * j } }\n  return [c, sum]`, noBig(capped))
  prog(`nest: while < ${bound} step 2 around an indexed inner loop`, pre,
    `${setup}\n  let sum = 0, i = 0, w = t\n  while (i < ${B}) { if (++c > 12) break; for (let j = s; j < w; j++) { if (j - s > 9) break; if (x8[j] === undefined) u++; else sum += x8[j] } i += 2 }\n  return [c, sum, u, i]`, noBig(capped))
}
// ---- E. exits and writes: break, continue, return, the counter read after, a bound the body moves
for (const bound of ['word', 'uint', 'sum', 'length']) {
  const [pre, setup, B] = BOUND[bound]
  prog(`exit: continue and break in a for <= ${bound}`, pre,
    `${setup}\n  let sum = 0\n  for (let i = s; i <= ${B}; i += 2) { if (++c > ${CAP}) break; if (i % 3 === 0) continue; sum += i; if (sum > 1e10) break }\n  return [c, sum]`, noBig(capped))
  prog(`exit: return from a while <= ${bound}`, pre,
    `${setup}\n  let sum = 0, i = s | 0\n  while (i <= ${B}) { if (++c > ${CAP}) return [c, sum, i, -1]; sum += i; i += 3 }\n  return [c, sum, i]`, noBig(capped))
}
prog('write: a word bound the body moves', '', `let B = b | 0, sum = 0\n  for (let i = s; i <= B; i++) { if (++c > ${CAP}) break; sum += i; if (c === 2) B = B + t }\n  return [c, sum, B]`, noBig(capped))
prog('write: a sum bound whose term the body moves', '', `let B0 = b | 0, B1 = t | 0, sum = 0\n  for (let i = s; i < B0 + B1; i += 2) { if (++c > ${CAP}) break; sum += i; if (c === 3) B1 = 2147483647 }\n  return [c, sum, B1]`, noBig(capped))
prog('write: a module bound a callee moves', 'let N = 0\nconst bump = (k) => { N = (N + k) | 0; return k }', `N = b | 0; let sum = 0\n  for (let i = s; i <= N; i += 2) { if (++c > ${CAP}) break; sum += i; if (c === 2) sum += bump(t) }\n  return [c, sum, N]`, noBig(capped))
// ---- F. an inner function's parameter every call passes an integer (int32 as written), `<=` and a step
prog('param: an inner function under <= its integral parameter', '', `const g = (n, st) => { let sum = 0, k = 0; for (let i = st; i <= n; i += 2) { if (++k > ${CAP}) break; sum += i + (x8[i & 7]) } return [k, sum] }\n  return [g(b | 0, s | 0), g(t | 0, 0), g(2147483647, 2147483640), g(-2147483648, -2147483648)]`, noBig(capped))
prog('param: an inner function under < a sum of its integral parameters', '', `const g = (n, m) => { let sum = 0, k = 0; for (let i = 0; i < n + m; i += 3) { if (++k > ${CAP}) break; sum += x8[i & 7] } return [k, sum] }\n  return [g(b | 0, t | 0), g(2147483647, 2147483647), g(-2147483648, 5)]`, noBig(capped))
test(`bound tier population: ${P.length} loops of an f64 counter for want of a bound's range, ${CONFIGS.length} configurations`, () =>
  population('bound tier', P, { configs: CONFIGS, own: ['N', 'bump'] }))
}

// ---- a stable name of the box, or a bound, read from a `.length` the receiver may not make an integer
{
const args = [[40.5, 1, 1], [40, 1, 1], [33.25, 2, 1], [10, 1, 0], [7.5, 3, 0], [1e10 + 0.5, 1, 1], [2147483648.5, 1, 1]]
const P = []
for (const [nm, mk] of [
  ['object or typed', 'const o = t ? { length: b } : new Float64Array(10)'],
  ['object or array', 'const o = t ? { length: b } : [1, 2, 3, 4, 5]'],
  ['object or string', "const o = t ? { length: b } : 'abcdefghij'"],
]) {
  P.push({ name: `box: ix = n - k over ${nm}`, src: `export let f = (b, d, t) => {
  ${mk}
  const n = o.length
  const x = new Float64Array(64)
  for (let q = 0; q < 64; q++) x[q] = q + 1
  let ix = 0, k = d, s = 0, c = 0
  while (ix < n) {
    if (++c > 40) break
    s += x[ix] === undefined ? 1000 : x[ix]
    k *= 2
    ix = n - k
  }
  return [s, c, ix]
}`, args })
  P.push({ name: `bound: for i <= n over ${nm}`, src: `export let f = (b, d, t) => {
  ${mk}
  const n = o.length
  const x = new Float64Array(64)
  for (let q = 0; q < 64; q++) x[q] = q + 1
  let s = 0, c = 0
  for (let i = 0; i <= n; i++) { if (++c > 50) break; s += x[i] === undefined ? 1000 : x[i] }
  return [s, c]
}`, args })
  P.push({ name: `bound: while i < n step 2 over ${nm}`, src: `export let f = (b, d, t) => {
  ${mk}
  const n = o.length
  const x = new Float64Array(64)
  for (let q = 0; q < 64; q++) x[q] = q + 1
  let s = 0, c = 0, i = 0
  while (i < n) { if (++c > 50) break; s += x[i] === undefined ? 1000 : x[i]; i += 2 }
  return [s, c, i]
}`, args })
  P.push({ name: `entry: for j from a length to a Number over ${nm}`, src: `export let f = (b, d, t) => {
  ${mk}
  const lim = o.length, num = d * 4.2
  const x = new Float64Array(64)
  for (let q = 0; q < 64; q++) x[q] = q + 1
  let s = 0, c = 0
  for (let j = lim; j < num; j++) { if (++c > 50) break; s += x[j] === undefined ? 1000 + j : x[j] }
  return [s, c]
}`, args: args.concat([[2.5, 1, 1], [2.5, 2, 1], [3.5, 3, 1], [0.5, 10, 1]]) })
}
test(`bound tier population: ${P.length} lengths of a receiver of several kinds, ${CONFIGS.length} configurations`, () =>
  population('bound length', P, { configs: CONFIGS }))
}

// ---- a `for` counter entering from a name read as a word as written, under a fractional bound
{
const P = []
const args = [[2.5, 4.2, 1], [2.5, 4, 1], [3.5, 9.9, 1], [0.5, 3.7, 1], [2, 4.2, 1], [7, 4.2, 0], [1.25, 6.5, 1], [-1.5, 2.2, 1]]
for (const [nm, mk] of [
  ['object or typed', 'const o = t ? { length: b } : new Float64Array(3)'],
  ['object or array', 'const o = t ? { length: b } : [1, 2, 3]'],
  ['object or string', "const o = t ? { length: b } : 'abc'"],
]) {
  P.push({ name: `entry: for j from a length below an exported parameter, over ${nm}`, src: `export let f = (b, num, t) => {
  ${mk}
  const lim = o.length
  const x = new Float64Array(64)
  for (let q = 0; q < 64; q++) x[q] = q + 1
  let s = 0, c = 0
  for (let j = lim; j < num; j++) { if (++c > 50) break; s += x[j] === undefined ? 1000 + j : x[j] }
  return [s, c]
}`, args })
  P.push({ name: `entry: for j from a length down to an exported parameter, over ${nm}`, src: `export let f = (b, num, t) => {
  ${mk}
  const lim = o.length
  const x = new Float64Array(64)
  for (let q = 0; q < 64; q++) x[q] = q + 1
  let s = 0, c = 0
  for (let j = lim; j > num - 4; j--) { if (++c > 50) break; s += x[j] === undefined ? 1000 + j : x[j] }
  return [s, c]
}`, args })
}
// a name stepped from a literal is no word as written
P.push({ name: 'entry: for j from a count a loop stepped', src: `export let f = (b, num, t) => {
  let n = 0
  while (n < b) n++
  const x = new Float64Array(64)
  for (let q = 0; q < 64; q++) x[q] = q + 1
  let s = 0, c = 0
  for (let j = n; j < num; j++) { if (++c > 50) break; s += x[j] === undefined ? 1000 + j : x[j] }
  return [s, c, n]
}`, args: [[3, 7.5, 0], [2147483647, 2147483650.5, 0], [2147483648, 2147483651.2, 0], [5, 2.5, 0]] })
test(`bound tier population: ${P.length} counters entering from a length or a count, ${CONFIGS.length} configurations`, () =>
  population('bound entry', P, { configs: CONFIGS }))
}
