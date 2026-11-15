// A population of whiles that write their integers by other than literal steps, each answering
// what Node answers at levels 0 to 3, size and speed (the integrator's, written against the
// mechanism as read, not from the writer's tests): the box holds such names as words of a copy
// while [0, 2^k - 1] holds them, and a head test that fails writes them back and the loop as
// written resumes (src/compile/plan/integral-loops.js; .work/architecture.md, "Counter widths
// built" and "Counter widths landed"). rfft's first pass, a stride grown by a product and the
// counter written from it; what a held name enters with (a literal, a word, a Number, a
// fraction, -0, an element); where the bound comes from and lies; what a round is made of (a
// name leaving the box mid-round and read before the next head, a write that is -0, a uint32, a
// missed element, continue, break, return, a labelled jump, loops in loops, the state a copy
// hands the loop as written); loops down and below zero; the stage loops of rfft; the loop in a
// function called with other arguments. Each program is `f(n, s, t)`, every loop capped by its
// own count; an argument under a bit operation stays below 2^63 (README, "Bitwise operands under
// 2^63").
import test from 'tst'
import { population } from './_population.js'

const CONFIGS = [0, 1, 2, 3, 'size', 'speed']

const P = []
const RD = ix => `if (x[${ix}] === undefined) u++; else sum += x[${ix}]`
const ST = ix => `x[${ix}] = c`
const NX = ix => `x[${ix} + 1] = x[${ix}] + 1`
const RM = ix => `sum += x[${ix} % 8] * 3 + ${ix} % 7`
const BODIES = [RD, ST, NX, RM]
const E31 = 2 ** 31, E30 = 2 ** 30, E29 = 2 ** 29
const NS = [0, 1, 7, 8, 8.5, 40, 1000, 32767, 32768, 65536, 2 ** 28 - 1, 2 ** 28, E29 - 1, E29, E29 + 1, E30 - 1, E30, E30 + 1, 3 * E29 - 1,
  E31 - 2, E31 - 1, E31, E31 + 1, 2 ** 32 - 1, 2 ** 32, 2 ** 53, 1e12, Infinity, -1, -0, NaN, -Infinity, 0.5]
const SS = [0, 1, 2, 5, -1, -0, 3.5, 32767, 32768, E29 - 1, E29, E30 - 1, E30, E31 - 3, E31 - 1, E31, 2 ** 32 - 1, NaN]
const TS = [1, 2, 3, 0, -1, 0.5, 2 ** 14, 2 ** 28, E29, E30, E31 - 1, NaN]
const SS6 = [0, 1, 5, -1, E30 - 1, E31 - 1], TS6 = [1, 2, 0, -1, E29, 0.5]
const cross = (...lists) => lists.reduce((acc, l) => acc.flatMap(a => l.map(v => [...a, v])), [[]])
const ARGS = {
  n: cross(NS, [0], [1]),
  ns: cross(NS, SS, [1]),
  nt: cross(NS, [0], TS),
  nst: cross(NS, SS6, TS6).concat(cross([40, E30, E31, 2 ** 32], SS, TS)),
  // (`ix <= n` with no cap never ends at an infinite bound, in Node itself)
  nfinite: cross(NS.filter(n => n !== Infinity), [0], [1]),
}
// README, "Bitwise operands under 2^63": an operand of that size reads as -1. A program that puts an
// argument under a bit operation is not called with one.
const small = (args, which) => args.filter(a => [...which].every(ch => Math.abs(a['nst'.indexOf(ch)]) < 2 ** 63))
const SUMX = 'x[0] + 2 * x[1] + 3 * x[2] + 4 * x[3] + 5 * x[4] + 6 * x[5] + 7 * x[6] + 8 * x[7]'
// { name, decl, loop, names (returned after the loop), uses (which arguments vary), bits (arguments under a bit operation), pre (module prelude) }
const prog = ({ name, decl = '', loop, names = 'i', uses = 'nst', bits = '', pre = '', arr = 'new Float64Array(8)' }) => P.push({
  name, args: small(ARGS[uses], bits),
  src: `${pre}\nexport let f = (n, s, t) => {
  const x = ${arr}; for (let k = 0; k < 8; k++) x[k] = k + 1
  const u8 = new Uint8Array(8); for (let k = 0; k < 8; k++) u8[k] = k * 37 + 3
  const nx = new Int32Array(8); for (let k = 0; k < 8; k++) nx[k] = (k * 5 + 3) % 9 - 1
  let c = 0, u = 0, sum = 0
  ${decl}
  ${loop}
  return [c, u, sum, ${names}, ${SUMX}]
}`,
})
const cap = (k = 44) => `if (++c > ${k}) break`
let rot = 0
const body = (ix) => BODIES[rot++ % BODIES.length](ix)
const TESTS = ['ix < n', 'ix <= n', 'n > ix', 'n >= ix', 'ix !== n']

// ---- A. rfft's first pass: a stride that grows by a product and the counter written from it
for (const mul of ['id *= 4', 'id *= 2', 'id = id * 8', 'id *= 3', 'id = id * 4 + 1', 'id += id', 'id = id * id', 'id = id * 1024'])
  for (const ixw of ['ix = 2 * (id - 1)', 'ix = id * 2 - 2', 'ix += id', 'ix = ix + id + 1', 'ix = id - 1']) {
    const k = rot
    const entry = ['let ix = 0, id = 4', 'let ix = s, id = 4', 'let ix = 0, id = s', 'let ix = s, id = t'][k % 4]
    const test = TESTS[k % TESTS.length]
    prog({ name: `A ${mul}; ${ixw}; ${entry}; while (${test})`, decl: entry, names: 'ix, id', uses: k % 4 === 3 ? 'nst' : k % 4 === 0 ? 'n' : 'ns',
      loop: `while (${test}) { ${cap()}; ${body('ix')}; ${k % 3 === 0 ? ST('id') + '; ' : ''}${ixw}; ${mul} }` })
    // the stride written first, the counter from the new stride
    prog({ name: `A stride first, ${mul}; ${ixw}; ${entry}; while (${test})`, decl: entry, names: 'ix, id', uses: k % 4 === 3 ? 'nst' : k % 4 === 0 ? 'n' : 'ns',
      loop: `while (${test}) { ${cap()}; ${mul}; ${body('ix')}; ${ixw} }` })
  }
// no cap: the growth alone ends the loop (an infinite bound ends it at an infinity)
for (const [mul, ixw] of [['id *= 4', 'ix = 2 * (id - 1)'], ['id *= 2', 'ix += id'], ['id = id * 3 + 1', 'ix = id - 1']])
  for (const test of ['ix < n', 'ix <= n'])
    prog({ name: `A no cap, ${mul}; ${ixw}; while (${test})`, decl: 'let ix = 0, id = 4', names: 'ix, id', uses: test === 'ix <= n' ? 'nfinite' : 'n',
      loop: `while (${test}) { c++; ${body('ix')}; ${ixw}; ${mul} }` })

// ---- B. what a held name enters with
const ENTRY = [['0'], ['1'], ['5'], ['1073741823'], ['1073741824'], ['2147483647'], ['2147483648'], ['-5'], ['-0'], ['0.5'], ['s'], ['s | 0', 's'], ['s >>> 0', 's'], ['s << 1', 's'],
  ['s >>> 1', 's'], ['s & 65535', 's'], ['s >> 2', 's'], ['s ^ 5', 's'], ['~s', 's'], ['s * 2'], ['s + 0.5'], ['Math.floor(s)'], ['x.length'], ['u8[s % 8]'], ['nx[s % 8]'], ['-s'], ['s - 1'], ['s * s'], ['s | t', 'st'], ['t << 3', 't']]
const REC = ['i = i * 2 + t', 'i = i * 2 + 1', 'i = i + i + t', 'i = i * 3 - t', 'i = (i + t) * 2', 'i = i * t', 'i = i * t + 1', 'i = i + t * t']
ENTRY.forEach(([e, bits = ''], k) => {
  for (const r of [REC[k % REC.length], REC[(k + 3) % REC.length]]) {
    const test = TESTS[rot % TESTS.length].replace(/ix/g, 'i')
    prog({ name: `B enters as ${e}; ${r}; while (${test})`, decl: `let i = ${e}`, bits, loop: `while (${test}) { ${cap()}; ${body('i')}; ${r} }` })
  }
  // assigned, not declared, before the loop; and behind a statement that leaves it alone
  prog({ name: `B assigned ${e}`, decl: `let i = 0, z = 0\n  i = ${e}\n  z = t + 1`, bits, names: 'i, z', loop: `while (i < n) { ${cap()}; ${body('i')}; i = i * 2 + z }` })
})

// ---- C. the bound: where it comes from and where it lies
const BOUNDS = [
  { name: 'a parameter', test: 'i < n' },
  { name: 'n | 0', decl: 'const N = n | 0', test: 'i < N', bits: 'n' },
  { name: 'n >>> 0', decl: 'const N = n >>> 0', test: 'i < N', bits: 'n' },
  { name: 'n >>> 1', decl: 'const N = n >>> 1', test: 'i < N', bits: 'n' },
  { name: 'n << 1', decl: 'const N = n << 1', test: 'i <= N', bits: 'n' },
  { name: 'a module binding', pre: 'let M = 0\nexport let pre = (n, s, t) => { M = n }', test: 'i < M' },
  { name: 'a field', pre: 'const o = { n: 0 }\nexport let pre = (n, s, t) => { o.n = n }', decl: 'const N = o.n', test: 'i < N' },
  { name: 'n * 2', decl: 'const N = n * 2', test: 'i < N' },
  { name: 'n - 1', decl: 'const N = n - 1', test: 'i <= N' },
  { name: 'a let never written', decl: 'let N = n', test: 'i < N' },
  { name: 'a sum in the test', test: 'i < n + t' },
  { name: 'a difference in the test', test: 'i < n - t' },
  { name: 'a literal in the box', test: 'i < 1000000' },
  { name: 'the word\'s top', test: 'i < 2147483647' },
  { name: 'the word\'s top, inclusive', test: 'i <= 2147483647' },
  { name: 'past the word', test: 'i < 4294967296' },
  { name: 'far past the word', test: 'i < 1e12' },
  { name: '2^30', test: 'i < 1073741824' },
  { name: '2^30 - 1, inclusive', test: 'i <= 1073741823' },
  { name: 'two bounds', test: 'i < n && i < t * 1000' },
  { name: 'a bound and the stride', test: 'i < n && q < t', q: true },
  { name: 'either', test: 'i < n || c < 5' },
  { name: 'not', test: '!(i >= n)' },
  { name: 'a square', test: 'i * i < n' },
  { name: 'a sum of two held', test: 'i + q < n', q: true },
  { name: 'a difference from the bound', test: 'n - i > 0' },
  { name: 'not equal', test: 'i !== n' },
  { name: 'loose not equal', test: 'i != n' },
  { name: 'a word of the counter', test: '(i | 0) < n', cap: 14 },   // (the counter under a bit operation stays below 2^63)
  { name: 'the bound mirrored', test: 'n > i && n >= q', q: true },
]
for (const b of BOUNDS) for (const r of b.q ? ['i = i + q; q = q * 2', 'q = q * 2 + 1; i = q - 1'] : ['i = i * 2 + t', 'i = i * 4 + 1'])
  prog({ name: `C bound ${b.name}; ${r}`, pre: b.pre, decl: `${b.decl ? b.decl + '\n  ' : ''}let i = s${b.q ? ', q = 1' : ''}`, bits: b.bits, names: b.q ? 'i, q' : 'i',
    loop: `while (${b.test}) { ${cap(b.cap)}; ${body('i')}; ${r} }` })

// ---- D. what a round is made of
const D = [
  ['a write in each arm', 'if (c & 1) i = i * 2 + t; else i = i + t'],
  ['a write in one arm', 'if (c & 1) i = i * 2 + t'],
  ['two writes, the first past the box, read between', `i = i * 4; ${RD('i')}; i = i - t`],
  ['two writes, back inside', `i = i * 8; ${ST('i % 8')}; i = i % 1000003`],
  ['through another held name', `q = i * 2; ${ST('q')}; i = q + t`, 'i, q', 'let i = s, q = 0'],
  ['a pair swapped', `q = i + q; i = q - i; ${RD('q')}`, 'i, q', 'let i = s, q = t'],
  ['continue before the write', `if (c % 3 === 0) { i = i + 1; continue }; ${ST('i')}; i = i * 2 + t`],
  ['continue after the write', `i = i * 2 + t; if (c % 3 === 0) continue; ${ST('i')}`],
  ['break after the write', `i = i * 2 + t; if (i > n / 2) break; ${ST('i')}`],
  ['break before the write', `if (x[i % 8] > 6) break; ${ST('i')}; i = i * 2 + t`],
  ['return from inside', `if (i > 1000) return [c, u, sum, i, -1]; ${ST('i')}; i = i * 2 + t`],
  ['return after the write', `i = i * 2 + t; if (i > 100000) return [c, u, sum, i, -2]; ${ST('i')}`],
  ['a conditional write', `${RD('i')}; i = i > t ? i * 2 : i + t + 1`],
  ['two steps', `${RD('i')}; i *= 2; i += t`],
  ['a step back then a product', `${RD('i')}; i -= t; i *= 3`],
  ['a shift', `${RD('i')}; i <<= 1; i += t`],
  ['a shift of a sum', `${RD('i')}; i = (i + t) << 1`],
  ['a uint32 of a product', `${RD('i')}; i = (i * 2 + t) >>> 0`],
  ['a uint32 of a difference', `${RD('i')}; i = (i - t) >>> 0`],
  ['a word of a product', `${RD('i')}; i = (i * 2 + t) | 0`],
  ['a remainder', `${RD('i')}; i = i * 2 % 1000003 + t`],
  ['an exact quotient', `${RD('i')}; i = (i - i % 3) / 3 * 7 + t`],
  ['a floor of a quotient', `${RD('i')}; i = Math.floor(i / 2) * 5 + t`],
  ['a truncated quotient', `${RD('i')}; i = ((i / 2) | 0) * 5 + t`],
  ['a minimum', `${RD('i')}; i = Math.min(i * 2 + t, 1048576)`],
  ['a maximum', `${RD('i')}; i = Math.max(i * 2 - t * 3, -9)`],
  ['an absolute value', `${RD('i')}; i = Math.abs(i - t) * 2`],
  ['an imul', `${RD('i')}; i = Math.imul(i, 3) + t`],
  ['a negation', `${RD('i')}; i = -i + t`],
  ['a mirror', `${RD('i')}; i = t - i`],
  ['a product that may be -0', `${RD('i')}; i = (i - t) * (c & 1)`],
  ['a product by the stride', `${RD('i')}; i = i * t`],
  ['a negative zero entered and kept', `${RD('i')}; i = i * 2`],
  ['a counter beside it', `${RD('i')}; i = i * 2 + t; j++`, 'i, j', 'let i = s, j = 0'],
  ['a float beside it', `${RD('i')}; i = i * 2 + t; w = w * 1.5 + i`, 'i, w', 'let i = s, w = 0.25'],
  ['the stride written', `${RD('i')}; i = i + q; if (c % 4 === 0) q = q * 3`, 'i, q', 'let i = s, q = t'],
  ['the bound written', `${RD('i')}; i = i * 2 + t; if (c === 6) m = m - 3`, 'i, m', 'let i = s, m = n', 'i < m'],
  ['the bound grown', `${RD('i')}; i = i * 2 + t; m = m * 2`, 'i, m', 'let i = s, m = n', 'i < m'],
  ['an element fed in, present', `${RD('i')}; i = i + u8[i % 8] * t + 1`],
  ['an element fed in, missed past eight', `${RD('i')}; i = i + u8[c] + 1`],
  ['an element fed in at the name', `${RD('i')}; i = i * 2 + u8[i]`],
  ['a link', `${RD('i')}; i = nx[i]`],
  ['a link doubled', `${RD('i')}; i = nx[i % 8] * 2 + t`],
  ['a float element truncated', `${RD('i')}; i = i * 2 + (x[c % 8] | 0)`],
  ['a float element', `${RD('i')}; i = i * 2 + x[c % 8]`],
  ['a switch', `switch (c & 3) { case 0: i = i * 2; break; case 1: i = i + t; break; default: i = i * 3 + 1 }; ${ST('i')}`],
  ['a do while inside', `let k = 0; do { ${ST('i + k')}; k++ } while (k < 3); i = i * 2 + t`],
  ['a for inside over the name', `for (let j = i, k = 0; j < n && k < 4; j += t, k++) { ${ST('j')} }; i = i * 2 + t`],
  ['a for inside stepped by a held stride', `for (let j = i, k = 0; j < n && k < 4; j += q, k++) { ${ST('j')} }; i = i + q; q = q * 2`, 'i, q', 'let i = s, q = t'],
  ['a while inside, rfft\'s', `let i0 = i; while (i0 < n) { ${cap(60)}; ${NX('i0')}; i0 += q }; i = 2 * (q - 1); q *= 4`, 'i, q', 'let i = s, q = 4'],
  ['a while inside with a stride of its own', `let i0 = i, d = 1; while (i0 < n) { ${cap(60)}; ${ST('i0')}; i0 += d; d = d * 2 }; i = i * 2 + t`],
  ['a while inside that writes the outer stride', `let i0 = i; while (i0 < n) { ${cap(60)}; ${ST('i0')}; i0 += q; q = q + 1 }; i = i * 2 + q`, 'i, q', 'let i = s, q = t'],
  ['a comma of writes', `${RD('i')}; i = i * 2, q = q + i`, 'i, q', 'let i = s, q = t'],
  ['a write inside an index', `x[(i = i * 2 + t) % 8] = c`],
  ['a write inside a test', `if ((i = i * 2 + t) > 100) sum += 1; ${ST('i')}`],
  ['a chained write', `${RD('i')}; i = q = i * 2 + t`, 'i, q', 'let i = s, q = 0'],
]
for (const [name, round, names = 'i', decl = 'let i = s', test = 'i < n'] of D) {
  prog({ name: `D ${name}`, decl, names, loop: `while (${test}) { ${cap()}; ${round} }` })
  prog({ name: `D ${name}, the test inclusive and mirrored`, decl, names, loop: `while (${test.replace(/(\w+) < (\w+)/, '$2 >= $1')}) { ${cap()}; ${round} }` })
}
// a labelled jump out of the loop, to a loop around it
for (const jump of ['continue outer', 'break outer', 'break'])
  prog({ name: `D labelled ${jump}`, decl: 'let i = s, k = 0', names: 'i, k',
    loop: `outer: for (k = 0; k < 3; k++) { while (i < n) { ${cap()}; ${ST('i')}; i = i * 2 + t; if (i % 5 === 0) ${jump} }; i = i + 1 }` })
// the loop run again by a loop around it, entering as the round before left it or afresh
prog({ name: 'D run again from where it stopped', decl: 'let i = s', loop: `for (let k = 0; k < 4; k++) { while (i < n * (k + 1)) { ${cap()}; ${ST('i')}; i = i * 2 + t } }` })
prog({ name: 'D run again afresh', decl: 'let last = 0', names: 'last', loop: `for (let k = 0; k < 4; k++) { let i = s * k; while (i < n) { ${cap()}; ${ST('i')}; i = i * 2 + t }; last += i }` })
prog({ name: 'D run again from a counter', decl: 'let last = 0', names: 'last', loop: `for (let k = 0; k < 6; k++) { let i = k; while (i < n) { ${cap()}; ${ST('i')}; i = i * 2 + t }; last += i }` })
prog({ name: 'D two loops, the second from the first', decl: 'let i = s, q = 1', names: 'i, q',
  loop: `while (i < n) { ${cap(20)}; ${ST('i')}; i = i * 2 + t }\n  while (q < i) { ${cap(44)}; ${RD('q')}; q = q * 3 + 1 }` })
prog({ name: 'D a held name captured after', decl: 'let i = s', names: 'i, g()', loop: `while (i < n) { ${cap()}; ${ST('i')}; i = i * 2 + t }\n  const g = () => i + 1` })
prog({ name: 'D a box in a box', decl: 'let i = s, q = 1', names: 'i, q',
  loop: `while (i < n) { ${cap()}; let j = q; while (j < i) { ${cap(60)}; ${ST('j')}; j = j * 2 + 1 }; i = i * 2 + t; q = q * 3 }` })

// ---- E. downwards and below zero
for (const [name, decl, test, round, names = 'i'] of [
  ['a stride that grows, down', 'let i = s, q = 1', 'i > n', `${RD('i')}; i = i - q; q = q * 2`, 'i, q'],
  ['a halving by a product', 'let i = s', 'i > n', `${RD('i')}; i = (i - i % 2) / 2 - t`],
  ['down to zero', 'let i = s', 'i > 0', `${RD('i')}; i = i - (t + i % 3)`],
  ['down through zero', 'let i = s', 'i >= n', `${RD('i')}; i = i - t * 2 - 1`],
  ['down, the mirror index', 'let i = s', 'i > n', `${RD('s - i')}; i = i * 2 - s - t`],
  ['a sign that flips', 'let i = s', 'i < n', `${RD('i')}; i = t - i * 2`],
  ['negative and growing', 'let i = -s', 'i > -n', `${RD('-i')}; i = i * 2 - t`],
]) for (const k of [0, 1]) prog({ name: `E ${name}${k ? ', inclusive' : ''}`, decl, names, loop: `while (${k ? test.replace('>', '>=').replace('<', '<=').replace('>==', '>=') : test}) { ${cap()}; ${round} }` })

// ---- F. the stage loops of rfft: a stride by shifts, a counter a difference of two words (caps keep every operand under 2^63)
for (const [name, ixw, idw] of [['shifts', 'ix = (id << 1) - n2', 'id = id << 2'], ['products', 'ix = id * 2 - n2', 'id = id * 4'], ['mixed', 'ix = (id << 1) - n2', 'id *= 4']])
  for (const inner of ['while (i0 < n) { ' + cap(64) + '; ' + NX('i0') + '; i0 += id }', 'for (; i0 < n; i0 += id) { ' + cap(64) + '; ' + ST('i0') + ' }'])
    prog({ name: `F stages by ${name}, inner ${inner.slice(0, 5)}`, decl: 'let n2 = 2, nn = n >>> 1, stages = 0', names: 'stages, n2', uses: 'n', bits: 'n',
      loop: `while ((nn = nn >>> 1)) { n2 = n2 << 1; let ix = 0, id = n2 << 1; while (ix < n) { let i0 = ix; ${inner}; ${ixw}; ${idw}; if (c > 64) break }; stages++; if (stages > 40) break }` })

// ---- G. the loop in a function called with different arguments, in a loop and beside one
for (const [name, call] of [['called twice', 'sum = run(x, n, s, t) + run(x, n, t, s)'], ['called in a loop', 'for (let k = 0; k < 3; k++) sum += run(x, n, s + k, t)'], ['called from a counter', 'for (let k = 0; k < 5; k++) sum += run(x, n, k, k + 1)']])
  prog({ name: `G ${name}`, pre: `const run = (x, n, s, t) => { let i = s, c = 0; while (i < n) { if (++c > 30) break; x[i] = c; i = i * 2 + t }; return i }`, names: 'c', loop: call })

test(`box population: ${P.length} whiles holding their integers in a box, ${CONFIGS.length} configurations`, () =>
  population('box', P, { configs: CONFIGS, own: ['M', 'o', 'run'] }))
