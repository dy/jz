// A population of counted loops whose counters, bounds, starts and steps sit at the word's edges
// and past them, each answering what Node answers at levels 0 to 3, size and speed (written by
// the integrator for the counter widths step without reading the writer's tests). Every program
// is `f(b, s, t)`, a bound, a start and a step: `for` and `while` up and down by literal steps
// and by a name, from 0, a literal near 2^31 and an argument, the bound a parameter, a word, a
// uint32, a module binding, a field and a derived Number; a counter no test names; names the loop
// writes (a step that grows, a counter recomputed, a jump out of the word and back); two
// counters, a counter of the module, a callee that moves the bound or the counter; counters past
// 2^52, where a Number's step rounds; labels, do-while, returns, switches, closures over each
// trip's counter. A capped program leaves by `if (++c > CAP) break` whatever its arguments; an
// uncapped one is called only with arguments that end it in a few trips. Observed: trips, a sum
// of the counter, reads through it (a missing element counted), the counter after the loop.
import test from 'tst'
import { population } from './_population.js'

const CONFIGS = [0, 1, 2, 3, 'size', 'speed']
const CAP = 44
const X8 = 'const x8 = new Float64Array(8); x8[0] = 1; x8[1] = 2; x8[2] = 3; x8[3] = 4; x8[4] = 5; x8[5] = 6; x8[6] = 7; x8[7] = 8'
const SUM8 = 'x8[0] + 2 * x8[1] + 3 * x8[2] + 4 * x8[3] + 5 * x8[4] + 6 * x8[5] + 7 * x8[6] + 8 * x8[7]'
// what a trip does with the counter `i` (and the bound's value `B`)
const BODY = {
  sum: i => `s += ${i}`,
  read: i => `if (x8[${i}] === undefined) u++; else s += x8[${i}]`,
  mask: i => `s += x8[${i} & 7] + (${i} % 7)`,
  derived: i => `if (x8[${i} + 1] === undefined) u++; else s += x8[${i} + 1]; if (x8[B - ${i}] === undefined) u++; else s += x8[B - ${i}]`,
  store: i => `x8[${i}] = c + 10; x8[B - ${i}] = c + 20; s += ${i} * 2`,
}
const BODIES = Object.keys(BODY)
// where the bound comes from: [module prelude, setup inside f, the expression the test reads]
const BOUND = {
  param: ['', 'const B = b', 'b'],
  word: ['', 'const B = b | 0', 'B'],
  uint: ['', 'const B = b >>> 0', 'B'],
  module: ['let N = 0\nexport let pre = (b, s, t) => { N = b }', 'const B = N', 'N'],
  field: ['const o = { n: 0 }\nexport let pre = (b, s, t) => { o.n = b }', 'const B = o.n', 'o.n'],
  derived: ['', 'const B = b * 2 - b', 'B'],
}
const BOUNDS = Object.keys(BOUND)
const P = []
// README, "Bitwise operands under 2^63": a bitwise operand of that size reads as -1, by the documented divergence
const noBig = (args) => args.filter(a => !(Math.abs(a[0]) >= 2 ** 63))
const bw = (bound, args) => bound === 'word' || bound === 'uint' ? noBig(args) : args
// An uncapped loop is called only with arguments that end it soon. A bound folded to a word or a
// uint is not the argument (`-1 >>> 0` is 2^32 - 1 trips from 0), so the trips are counted on the
// values the program computes, not on the arguments.
const boundVal = { param: b => b, word: b => b | 0, uint: b => b >>> 0, module: b => b, field: b => b, derived: b => b * 2 - b }
const short = (bound, start, step, op, down = false) => (args) => args.filter(([b, s, t]) => {
  const B = boundVal[bound](b), S = Function('s', `return ${start}`)(s), T = step === 't' ? t : +step
  const runs = op === '<' ? S < B : op === '<=' ? S <= B : op === '>' ? S > B : S >= B
  if (!runs) return true
  return T > 0 && Math.abs(B - S) / T <= 5000 && (down ? S - T : S + T) !== S
})
const prog = (name, prelude, body, args) => P.push({ name, src: `${prelude}\nexport let f = (b, s, t) => {\n  ${X8}\n  let c = 0, u = 0\n  let s0 = s\n  ${body}\n}`.replace(/\bs0\b/g, 's0'), args })

// arguments
const E31 = 2147483648, E32 = 4294967296
const edges = [E31 - 2, E31 - 1, E31, E31 + 1, E32 - 1, E32, E32 + 1, 1073741824, 1610612735, -E31, -E31 - 1, -E31 + 1, 536870912, 4503599627370496]
const small = [0, 1, 2, 5, 8, 8.5, 9, 40, -1, -0, NaN, -Infinity, -2147483649]
const wild = [Infinity, 1e300, 9007199254740992, 9007199254740994, 4294967295.5, 0.5, -0.5]
// uncapped, rising from 0 or a literal by a literal step: the bound alone decides the trips
const upFromZero = small.map(b => [b, 0, 1])
const upFromLit = (lit) => [-1, 0, 1, 2, 5, 11].map(k => [lit + k, 0, 1]).concat(small.map(b => [b, 0, 1]))
// uncapped, start and step given: a few trips up to each edge
const upNear = (steps) => {
  const out = []
  for (const B of [...edges, 0, 8, 8.5, 40]) for (const T of steps) for (const k of [0, 1, 4]) for (const r of [0, 1]) out.push([B, B - k * T - r, T])
  for (const B of [NaN, -Infinity, -1]) out.push([B, 0, steps[0]])
  return out
}
const downNear = (steps) => {
  const out = []
  for (const B of [...edges, 0, 8, 8.5, -40]) for (const T of steps) for (const k of [0, 1, 4]) for (const r of [0, 1]) out.push([B, B + k * T + r, T])
  for (const B of [NaN, Infinity, 1]) out.push([B, 0, steps[0]])
  return out
}
// capped: anything
const capped = []
{
  const Bs = [...small, ...edges, ...wild], Ss = [0, 7, 2147483640, 2147483647, 4294967290, -2147483650, -5, 0.5, NaN, 1073741820],
    Ts = [1, 2, 3, 1073741824, 0.5, -1, 0, NaN, 2147483647, 65536]
  let k = 0
  for (const B of Bs) for (const S of Ss) for (const T of Ts) if (k++ % 3 === 0 || B > 1e9 && S > 1e9) capped.push([B, S, T])
}

// A. `for`, the counter in the head
let n = 0
for (const cap of [false, true]) for (const op of ['<', '<=']) for (const step of ['1', '2', '3', 't'])
  for (const start of ['0', 's', '2147483640']) for (const bound of BOUNDS) {
    const body = BODIES[n++ % BODIES.length]
    const [pre, setup, B] = BOUND[bound]
    const stepS = step === '1' ? 'i++' : `i += ${step}`
    const args = cap ? capped : step === 't' ? (start === 's' ? upNear([1, 2, 3, 1073741824]) : null)
      : start === '0' ? upFromZero : start === 's' ? upNear([+step]) : upFromLit(2147483640)
    if (!args) continue // uncapped, a step of any Number from a fixed start: no safe argument list
    prog(`for ${op} step ${step} from ${start} bound ${bound} ${body}${cap ? ' capped' : ''}`, pre,
      `${setup}\n  let sum = 0\n  for (let i = ${start}; i ${op} ${B}; ${stepS}) { ${cap ? `if (++c > ${CAP}) break; ` : 'c++; '}${BODY[body]('i').replace(/\bs \+=/g, 'sum +=')} }\n  return [c, sum, u, ${SUM8}]`, cap ? bw(bound, args) : short(bound, start, step, op)(bw(bound, args)))
  }
// descending
for (const cap of [false, true]) for (const op of ['>', '>=']) for (const step of ['1', '3', 't'])
  for (const start of ['s', '-2147483640']) for (const bound of BOUNDS) {
    const body = BODIES[n++ % BODIES.length]
    const [pre, setup, B] = BOUND[bound]
    const stepS = step === '1' ? 'i--' : `i -= ${step}`
    const args = cap ? capped : step === 't' ? (start === 's' ? downNear([1, 2, 1073741824]) : null)
      : start === 's' ? downNear([+step]) : [-1, 0, 1, 2, 5, 11].map(k => [-2147483640 - k, 0, 1]).concat([[0, 0, 1], [NaN, 0, 1], [Infinity, 0, 1]])
    if (!args) continue
    prog(`for ${op} step -${step} from ${start} bound ${bound} ${body}${cap ? ' capped' : ''}`, pre,
      `${setup}\n  let sum = 0\n  for (let i = ${start}; i ${op} ${B}; ${stepS}) { ${cap ? `if (++c > ${CAP}) break; ` : 'c++; '}${BODY[body]('i').replace(/\bs \+=/g, 'sum +=')} }\n  return [c, sum, u, ${SUM8}]`, cap ? bw(bound, args) : short(bound, start, step, op, true)(bw(bound, args)))
  }

// B. `while`, the counter declared outside and read after
for (const cap of [false, true]) for (const op of ['<', '<=']) for (const step of ['1', '2', 't'])
  for (const start of ['s', 's + 2', '-s', 's | 0', 's * 1']) for (const bound of ['param', 'module', 'word']) {
    const body = BODIES[n++ % BODIES.length]
    const [pre, setup, B] = BOUND[bound]
    let args = cap ? capped : upNear(step === 't' ? [1, 3, 1073741824] : [+step])
    if (!cap && start === 's + 2') args = args.map(([b, s, t]) => [b, s - 2, t])
    if (!cap && start === '-s') args = args.map(([b, s, t]) => [b, -s, t])
    if (!cap && start === 's | 0') args = args.filter(([b, s]) => Math.abs(b) < 2147483600 && (s | 0) === s) // a start folded to a word may sit far from the bound
    prog(`while ${op} step ${step} from ${start} bound ${bound} ${body}${cap ? ' capped' : ''}`, pre,
      `${setup}\n  let sum = 0, i = ${start}\n  while (i ${op} ${B}) { ${cap ? `if (++c > ${CAP}) break; ` : 'c++; '}${BODY[body]('i').replace(/\bs \+=/g, 'sum +=')}; i += ${step} }\n  return [c, sum, u, i, ${SUM8}]`, cap ? bw(bound, args) : short(bound, start, step, op)(bw(bound, args)))
  }

// C. a counter no test names
const sideArgs = [0, 1, 2, 3, 8, 1024, 2147483647, 2147483648, 4294967295, 4294967296, 1e300, -1, NaN, 8.5, Infinity, -Infinity].map(b => [b, 0, 1])
prog('side: bits of a shifted word', '', `let v = b, bits = 0\n  while (v > 1) { v >>= 1; bits++ }\n  return [bits, v, x8[bits] === undefined ? -1 : x8[bits]]`, noBig(sideArgs))
prog('side: bits of an unsigned shift', '', `let v = b >>> 0, bits = 0\n  while (v) { v = v >>> 1; bits++ }\n  return [bits, v, x8[bits & 7]]`, noBig(sideArgs))
prog('side: halvings of a Number', '', `let v = b, k = 0\n  while (v > 1) { v = v / 2; k++; if (k > 2000) break }\n  return [k, x8[k] === undefined ? -1 : x8[k]]`, sideArgs)
prog('side: a count beside a word counter', '', `const B = b | 0; let k = s\n  for (let i = 0; i < (B & 63); i++) { if (i % 3) k++; else k += t }\n  return [k, x8[k] === undefined ? -1 : x8[k]]`, noBig(capped))
prog('side: a count that doubles', '', `const B = b | 0; let k = 1\n  for (let i = 0; i < (B & 63); i++) { k *= 2; c += x8[k] === undefined ? 1 : 0 }\n  return [k, c]`, noBig(sideArgs).concat([[40, 0, 1], [63, 0, 1], [31, 0, 1], [32, 0, 1], [30, 0, 1]]))
prog('side: a count stepped by the start', '', `const B = b | 0; let k = 0\n  for (let i = 0; i < (B & 15); i++) k += s\n  return [k, x8[k] === undefined ? -1 : x8[k]]`, noBig(capped))

const geoArgs = [0, 1, 5, 100, 2147483646, 2147483647, 2147483648, 4294967295, 4294967296, 1e12, 1e300, Infinity, NaN, -1, 8.5, 1610612734, 1610612735, 536870912, 268435456].map(b => [b, 0, 4])
prog('geo: id *= 4, ix recomputed', '', `let ix = 0, id = 4\n  while (ix < b) { if (++c > 80) break; if (x8[id] === undefined) u++; x8[c & 7] = c; ix = 2 * (id - 1); id *= 4 }\n  return [c, u, ix, id, ${SUM8}]`, geoArgs)
prog('geo: id <<= 2, ix a difference of words', '', `let n2 = 4, ix = 0, id = n2 << 1\n  while (ix < b) { if (++c > 80) break; if (x8[ix] === undefined) u++; ix = (id << 1) - n2; id = id << 2 }\n  return [c, u, ix, id]`, geoArgs)
prog('geo: the first pass, inner counter from the outer', '', `let ix = 0, id = 4, last = 0, k = 0\n  while (ix < b) {\n    let i0 = ix\n    while (i0 < b) { if (++c > 60) break; last = i0; if (x8[i0 + 1] === undefined) u++; else k += x8[i0 + 1]; i0 += id }\n    if (c > 60) break\n    ix = 2 * (id - 1); id *= 4\n  }\n  return [c, u, k, last, ix, id]`, geoArgs)
// the first pass started late, so the outer loop reaches the word's edge in a few trips
const lateArgs = []
for (const N of [1610612734, 1610612735, 2147483646, 2147483647, 2147483648, 3221225472, 4294967296, 8589934592, 536870912, 1073741824])
  for (const id of [67108864, 268435456, 1073741824]) lateArgs.push([N, 2 * (id / 4 - 1), id])
prog('geo: the first pass started late', '', `let ix = s, id = t, last = 0\n  while (ix < b) {\n    let i0 = ix\n    while (i0 < b) { if (++c > 400) break; last = i0; if (x8[i0 + 1] === undefined) u++; i0 += id }\n    if (c > 400) break\n    ix = 2 * (id - 1); id *= 4\n  }\n  return [c, u, last, ix, id]`, lateArgs)
prog('geo: the first pass started late, uncapped inner', '', `let ix = s, id = t, last = 0\n  while (ix < b) {\n    if (++c > 40) break\n    let i0 = ix\n    while (i0 < b) { u++; last = i0; i0 += id }\n    ix = 2 * (id - 1); id *= 4\n  }\n  return [c, u, last, ix, id]`, lateArgs)
prog('geo: a stage started late', '', `let n2 = t | 0, ix = 0, id = n2 << 1, last = 0\n  while (ix < b) {\n    let i0 = ix\n    while (i0 < b) { if (++c > 200) break; last = i0; if (x8[i0 + 1] === undefined) u++; i0 += id }\n    if (c > 200) break\n    ix = (id << 1) - n2; id = id << 2\n  }\n  return [c, u, last, ix, id]`, lateArgs.concat([[1000, 0, 16], [268435456, 0, 67108864], [536870912, 0, 134217728], [536870912, 0, 268435456], [2147483647, 0, 536870912]]))
prog('geo: eight indices off an inner counter', '', `const n4 = t | 0, j = s | 0; let ix = 0, id = n4 << 3, k = 0\n  while (ix < b) {\n    let i0 = ix\n    while (i0 < b) { if (++c > 120) break\n      let i1 = i0 + j + 1, i2 = i1 + n4, i3 = i2 + n4, i4 = i3 + n4, i5 = i0 + n4 - j - 1, i6 = i5 + n4, i7 = i6 + n4, i8 = i7 + n4\n      k += (x8[i1] === undefined ? 1 : 0) + (x8[i4] === undefined ? 2 : 0) + (x8[i5] === undefined ? 4 : 0) + (x8[i8] === undefined ? 8 : 0) + i8 % 1000\n      i0 += id }\n    if (c > 120) break\n    ix = (id << 1) - (n4 << 2); id = id << 2\n  }\n  return [c, k, ix, id]`,
  [[64, 0, 1], [64, 1, 2], [1000, 3, 8], [2147483647, 5, 268435456], [2147483647, 1073741823, 536870911], [4294967296, 0, 536870912], [1610612735, 7, 134217728], [8.5, 0, 1], [NaN, 0, 1], [1e300, 0, 1], [536870912, 2147483647, 1], [1073741824, -2147483648, 1073741823]])
// a step the body grows
for (const [nm, grow] of [['doubles', 'st *= 2'], ['times 65536', 'st *= 65536'], ['shifts', 'st = st << 3'], ['adds itself', 'st += st + 1']])
  prog(`grow: a step that ${nm}`, '', `const B = b; let st = t, i = s, sum = 0\n  while (i < B) { if (++c > 60) break; sum += i; if (x8[i] === undefined) u++; i += st; ${grow} }\n  return [c, sum, u, i, st]`,
    [[100, 0, 1], [1e9, 0, 1], [2147483647, 0, 1], [2147483648, 0, 1], [4294967296, 0, 1], [1e15, 0, 1], [1e300, 0, 1], [Infinity, 0, 1], [1e300, 0, 3], [4294967296, 2147483000, 7], [1e15, -5, 2], [NaN, 0, 1], [1e12, 0.5, 1], [1e12, 0, 0.5]])
// a counter that jumps out of the word in the middle of the loop, and one that jumps back
prog('jump: out of the word mid-loop', '', `let sum = 0\n  for (let i = s; i < b; i++) { c++; sum += i; if (x8[i] === undefined) u++; if (c === 3) i += t; if (c > 60) break }\n  return [c, sum, u]`,
  [[E32 + 12, 0, E32], [E31 + 9, 0, E31], [E31 + 9, 2, E31 - 4], [20, 0, 5], [E32 * 4 + 10, 1, E32 * 4], [2 ** 53 + 20, 0, 2 ** 53], [12, 0, 0.5], [E31 + 3, E31 - 6, 0]])
prog('jump: out of the word and back', '', `let sum = 0\n  for (let i = s; i < b; i++) { c++; sum += i; if (x8[i] === undefined) u++; if (c === 3) i += t; if (c === 6) i -= t; if (c > 60) break }\n  return [c, sum, u]`,
  [[12, 0, E32], [12, 0, E31], [12, 2, E31 - 4], [20, 0, 5], [12, 1, E32 * 4], [12, 0, 2 ** 53], [12, 0, 0.5]])
prog('jump: the bound moved mid-loop', '', `let B = b, sum = 0\n  for (let i = s; i < B; i++) { c++; sum += i; if (c === 2) B += t; if (c > 30) break }\n  return [c, sum, B]`, capped)
prog('jump: the bound halved mid-loop', '', `let B = b, sum = 0, i = s\n  while (i < B) { if (++c > 50) break; sum += i; i += t; B = B / 2 }\n  return [c, sum, B, i]`, capped)
prog('jump: the counter written twice a trip', '', `let sum = 0, i = s\n  while (i < b) { if (++c > 40) break; sum += i; i += t; if (i % 2 === 0) i += 1073741824 }\n  return [c, sum, i]`, capped)
// an inner value that leaves the word inside one outer trip
prog('inner: a product grown inside one trip', '', `let sum = 0\n  for (let i = 0; i < (b & 7); i++) { let k = i + s; for (let q = 0; q < 12; q++) k *= t; sum += k; if (x8[k] === undefined) u++ }\n  return [sum, u]`,
  [[7, 1, 3], [7, 1, 65536], [7, 0, 2], [7, 2, 7], [5, 1, 1], [7, -1, 9], [7, 1, 0.5], [3, 1, 1e30]])
prog('inner: a sum grown inside one trip', '', `let sum = 0\n  for (let i = 0; i < (b & 7); i++) { let k = s; for (let q = 0; q < 6; q++) { k += t; if (x8[k] === undefined) u++; else sum += x8[k] } sum += k }\n  return [sum, u]`,
  [[7, 0, 1], [7, 2147483640, 3], [7, 0, 1073741824], [7, -2147483645, -2], [7, 0, 0.5], [7, 4294967290, 2], [7, 0, 1e15]])

// E. two counters; a counter of the module; continue
prog('two counters meeting', '', `let sum = 0\n  for (let i = s, j = b; i < j; i++, j--) { if (++c > ${CAP}) break; sum += i - j; if (x8[j - i] === undefined) u++ }\n  return [c, sum, u]`, capped)
prog('two counters, one by a name', '', `let sum = 0, j = 0\n  for (let i = s; i < b; i++) { if (++c > ${CAP}) break; j += t; sum += j; if (x8[j] === undefined) u++ }\n  return [c, sum, u, j]`, capped)
P.push({ name: 'module counter', src: `let idx = 0\nexport let f = (b, s, t) => { let c = 0, sum = 0\n  for (idx = s; idx < b; idx += t) { if (++c > ${CAP}) break; sum += idx }\n  return [c, sum, idx] }\nexport let g = (b, s, t) => idx`, args: capped })
P.push({ name: 'module counter, unit step, uncapped', src: `let idx = 0\nexport let f = (b, s, t) => { let sum = 0\n  for (idx = s; idx < b; idx++) sum += idx\n  return [sum, idx] }\nexport let g = (b, s, t) => idx + 1`, args: upNear([1]) })
prog('continue past a third', '', `let sum = 0\n  for (let i = s; i < b; i += t) { if (++c > ${CAP}) break; if (i % 3 === 0) continue; sum += i; if (x8[i] === undefined) u++ }\n  return [c, sum, u]`, capped)
prog('continue in a while', '', `let sum = 0, i = s\n  while (i < b) { if (++c > ${CAP}) break; i += t; if (i % 2) continue; sum += i }\n  return [c, sum, i]`, capped)
prog('!== a bound it meets', '', `let sum = 0\n  for (let i = s; i !== b; i++) { if (++c > ${CAP}) break; sum += i; if (x8[i] === undefined) u++ }\n  return [c, sum, u]`, capped)
prog('a test with an effect', '', `let v = b >>> 0, sum = 0, k = s\n  while ((v = v >>> 1)) { if (++c > ${CAP}) break; k += t; sum += k; if (x8[k] === undefined) u++ }\n  return [c, sum, u, v, k]`, noBig(capped))
prog('a test with an effect on the counter', '', `let i = s, sum = 0\n  while (i++ < b) { if (++c > ${CAP}) break; sum += i; if (x8[i] === undefined) u++ }\n  return [c, sum, u, i]`, capped)
prog('a countdown by --', '', `let k = s, sum = 0\n  while (--k) { if (++c > ${CAP}) break; sum += k; if (x8[k] === undefined) u++ }\n  return [c, sum, u, k]`, capped)
prog('a loop in a loop, the inner bound the outer counter', '', `let sum = 0\n  for (let i = s; i < b; i += t) { if (++c > 12) break; for (let j = i - 3; j < i; j++) { sum += j; if (x8[j] === undefined) u++ } }\n  return [c, sum, u]`, capped)
prog('a loop in a loop, the inner step the outer counter', '', `let sum = 0\n  for (let i = s; i < b; i += t) { if (++c > 12) break; let k = 0; for (let j = 0; j < 4; j++) { k += i; sum += k; if (x8[k] === undefined) u++ } }\n  return [c, sum, u]`, capped)

const farArgs = []
for (const S of [2 ** 52 - 20, 2 ** 52 - 3, 2 ** 53 - 20, 2 ** 53 - 3, 2 ** 53, -(2 ** 53) + 3, 2 ** 62, 1e17, 2 ** 31 - 3, 2 ** 32 - 3])
  for (const T of [1, 2, 3, 7, 1024, 0.5]) farArgs.push([S + 50 * T, S, T], [S + 5 * T + 1, S, T], [S, S + 30 * T, T])
const FAR = 60
prog('far: for <, sum of the counter', '', `let sum = 0\n  for (let i = s; i < b; i += t) { if (++c > ${FAR}) break; sum += i; if (x8[c & 7] === undefined) u++ }\n  return [c, sum, u]`, farArgs)
prog('far: for <=, unit step', '', `let sum = 0\n  for (let i = s; i <= b; i++) { if (++c > ${FAR}) break; sum += i }\n  return [c, sum]`, farArgs)
prog('far: while, the counter read after', '', `let sum = 0, i = s\n  while (i < b) { if (++c > ${FAR}) break; sum += i; i += t }\n  return [c, sum, i]`, farArgs)
prog('far: while, i = i + t', '', `let sum = 0, i = s\n  while (i < b) { if (++c > ${FAR}) break; sum = sum + i * 2 - 1; i = i + t }\n  return [c, sum, i]`, farArgs)
prog('far: counting down', '', `let sum = 0, i = s\n  while (i > b) { if (++c > ${FAR}) break; sum += i; i -= t }\n  return [c, sum, i]`, farArgs)
prog('far: a side counter from the start', '', `let k = s, sum = 0\n  for (let i = 0; i < 40; i++) { k++; sum += k }\n  return [k, sum]`, farArgs)
prog('far: a side counter stepped by a name', '', `let k = s, sum = 0\n  for (let i = 0; i < 40; i++) { k += t; sum += k; if (x8[k] === undefined) u++ }\n  return [k, sum, u]`, farArgs)
prog('far: a product counter', '', `let k = 1, sum = 0\n  for (let i = 0; i < 70; i++) { k *= 3; sum += k % 1000 }\n  return [k, sum]`, [[0, 0, 1]])
prog('far: an integer sum past 2^53', '', `let sum = s\n  for (let i = 0; i < 50; i++) sum += i * t + 1\n  return [sum, sum % 1024]`, farArgs)

// G. the ways out of a loop and around it
prog('label: continue an outer loop from an inner', '', `let sum = 0\n  outer: for (let i = s; i < b; i += t) { if (++c > 12) break; for (let j = i; j < i + 6; j++) { if (j % 4 === 3) continue outer; sum += j; if (x8[j] === undefined) u++ } sum += 1000 }\n  return [c, sum, u]`, capped)
prog('label: break an outer loop from an inner', '', `let sum = 0\n  outer: for (let i = s; i < b; i += t) { if (++c > 12) break; for (let j = i; j < i + 6; j++) { if (j % 5 === 4 && c > 3) break outer; sum += j } sum += 1000 }\n  return [c, sum]`, capped)
prog('do while', '', `let i = s, sum = 0\n  do { if (++c > ${CAP}) break; sum += i; if (x8[i] === undefined) u++; i += t } while (i < b)\n  return [c, sum, u, i]`, capped)
prog('return from inside', '', `let sum = 0\n  for (let i = s; i < b; i += t) { if (++c > ${CAP}) return [c, sum, i]; sum += i; if (sum > 1e10) return [c, sum, -1] }\n  return [c, sum, -2]`, capped)
prog('a counter the body also steps back', '', `let sum = 0, i = s\n  while (i < b) { if (++c > ${CAP}) break; sum += i; i += t; if (c % 3 === 0) i -= 2 }\n  return [c, sum, i]`, capped)
prog('no test in the head, a break on the bound', '', `let sum = 0\n  for (let i = s; ; i += t) { if (!(i < b)) break; if (++c > ${CAP}) break; sum += i; if (x8[i] === undefined) u++ }\n  return [c, sum, u]`, capped)
prog('a test of two conjuncts', '', `let sum = 0, i = s\n  while (i < b && sum < 1e11) { if (++c > ${CAP}) break; sum += i; i += t }\n  return [c, sum, i]`, capped)
prog('a test of two disjuncts', '', `let sum = 0, i = s\n  while (i < b || c < 3) { if (++c > ${CAP}) break; sum += i; i += t }\n  return [c, sum, i]`, capped)
prog('a test on the square of the counter', '', `let sum = 0\n  for (let i = s; i * i < b; i++) { if (++c > ${CAP}) break; sum += i }\n  return [c, sum]`, capped)
prog('a counter that doubles itself', '', `let sum = 0\n  for (let i = s; i < b; i = i * 2 + 1) { if (++c > 70) break; sum += i % 1000; if (x8[i] === undefined) u++ }\n  return [c, sum, u]`, capped)
prog('a counter wrapped to a uint each trip', '', `let sum = 0\n  for (let i = s >>> 0; i < b; i = (i + t) >>> 0) { if (++c > ${CAP}) break; sum += i; if (x8[i] === undefined) u++ }\n  return [c, sum, u]`, capped)
prog('a counter wrapped to a word each trip', '', `let sum = 0\n  for (let i = s | 0; i < b; i = (i + t) | 0) { if (++c > ${CAP}) break; sum += i; if (x8[i] === undefined) u++ }\n  return [c, sum, u]`, capped)
prog('a counter shifted left', '', `let sum = 0\n  for (let i = s | 0; i < b; i <<= 1) { if (++c > ${CAP}) break; sum += i }\n  return [c, sum]`, capped)
prog('a switch in the body', '', `let sum = 0\n  for (let i = s; i < b; i += t) { if (++c > ${CAP}) break; switch (c % 3) { case 0: sum += i; break; case 1: sum -= 1; break; default: sum += x8[c & 7] } }\n  return [c, sum]`, capped)
P.push({ name: 'a callee moves the bound', src: `let N = 0\nlet bump = (k) => { N += k; return k }\nexport let f = (b, s, t) => { N = b; let c = 0, sum = 0\n  for (let i = s; i < N; i += t) { if (++c > ${CAP}) break; sum += i; if (c === 2) bump(1073741824) }\n  return [c, sum, N] }`, args: capped })
P.push({ name: 'a callee moves the counter', src: `let idx = 0\nlet jump = (k) => { idx += k }\nexport let f = (b, s, t) => { let c = 0, sum = 0\n  for (idx = s; idx < b; idx += t) { if (++c > ${CAP}) break; sum += idx; if (c === 3) jump(2147483648) }\n  return [c, sum, idx] }`, args: capped })
prog('closures over each trip\'s counter', '', `const fs = []; let sum = 0\n  for (let i = s; i < b; i += t) { if (++c > 6) break; fs.push(() => i) }\n  for (let k = 0; k < fs.length; k++) sum += fs[k]() * (k + 1)\n  return [c, sum]`, capped)

test(`counter widths population: ${P.length} loops at the word's edges, ${CONFIGS.length} configurations`, () =>
  population('counter widths', P, { configs: CONFIGS, own: ['N', 'o', 'idx', 'bump', 'jump'] }))
