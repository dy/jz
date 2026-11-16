// A population of boxes beside the other forms a copy takes, each answering what Node answers at
// levels 0 to 3, size and speed (the integrator's, against src/compile/plan/integral-loops.js as
// read): a counted loop around the box entering from its counter, a product of it, where it was
// left, its stride or bound the counter's; a sum the copy tests and leaves at in the same round; a
// cursor stepped by literals, a ring with its reset; a walk over links; indices derived from the
// held name, past the word and below zero; receivers of every element width; the loop under an
// `if`, an `else`, a `switch` arm, a labelled block, in a function declaration and a closure; a
// regular array and a string indexed. Each program is `f(n, s, t)`, every loop capped by its own
// count (.work/architecture.md, "Counter widths built").
import test from 'tst'
import { population } from './_population.js'

const CONFIGS = [0, 1, 2, 3, 'size', 'speed']

const P = []
const E31 = 2 ** 31, E30 = 2 ** 30, E29 = 2 ** 29
const NS = [0, 1, 7, 8, 8.5, 40, 1000, 65536, 2 ** 28, E29 - 1, E29, E30 - 1, E30, E30 + 1, E31 - 1, E31, 2 ** 32, 1e12, -1, -0, NaN, 0.5]
const SS = [0, 1, 2, 5, 7, -1, -0, 3.5, E29, E30 - 1, E30, E31 - 1, E31, NaN]
const TS = [1, 2, 3, 0, -0, -1, 0.5, 2 ** 28, E29, E30, E31 - 1, NaN]
const cross = (...lists) => lists.reduce((acc, l) => acc.flatMap(a => l.map(v => [...a, v])), [[]])
const ARGS = cross(NS, SS, TS)
const SUMX = 'x[0] + 2 * x[1] + 3 * x[2] + 4 * x[3] + 5 * x[4] + 6 * x[5] + 7 * x[6] + 8 * x[7]'
const prog = (name, decl, loop, names = 'i', { pre = '', arr = 'new Float64Array(8)' } = {}) => P.push({ name, args: ARGS, src: `${pre}\nexport let f = (n, s, t) => {
  const x = ${arr}; for (let k = 0; k < 8; k++) x[k] = k + 1
  const big = new Int32Array(8); for (let k = 0; k < 8; k++) big[k] = k === 5 ? 2147483647 : k === 2 ? -2147483648 : k * 1000
  const nx = new Int32Array(8); for (let k = 0; k < 8; k++) nx[k] = (k * 5 + 3) % 9 - 1
  let c = 0, u = 0, sum = 0
  ${decl}
  ${loop}
  return [c, u, sum, ${names}, ${SUMX}]
}` })
const cap = (k = 44) => `if (++c > ${k}) break`
const R = 'i = i * 2 + t'

// a counted loop around the box
for (const [name, head] of [['a literal count', 'for (let k = 0; k < 5; k++)'], ['a count by the parameter', 'for (let k = 0; k < (s & 7); k++)'], ['a count by a Number', 'for (let k = 0; k < t; k++)'],
  ['a count down', 'for (let k = 4; k >= 0; k--)'], ['a while around', 'let k = 0; while (k++ < 4)']]) {
  prog(`around: ${name}, entering from the counter`, 'let last = 0', `${head} { ${cap(60)}; let i = k; while (i < n) { ${cap(60)}; x[i] = c; ${R} }; last += i }`, 'last')
  prog(`around: ${name}, entering from a product of it`, 'let last = 0', `${head} { ${cap(60)}; let i = k * s; while (i < n) { ${cap(60)}; x[i] = c; ${R} }; last += i }`, 'last')
  prog(`around: ${name}, entering as it was left`, 'let i = s', `${head} { ${cap(60)}; while (i < n + k) { ${cap(60)}; x[i] = c; ${R} } }`)
  prog(`around: ${name}, the stride the counter's`, 'let last = 0', `${head} { ${cap(60)}; let i = s; while (i < n) { ${cap(60)}; x[i] = c; i = i * 2 + k }; last += i }`, 'last')
  prog(`around: ${name}, the bound the counter's`, 'let last = 0', `${head} { ${cap(60)}; let i = s; while (i < k * 1000) { ${cap(60)}; x[i] = c; ${R} }; last += i }`, 'last')
}
// a sum the copy tests and leaves at, in the same round
for (const [name, round, names = 'i, m'] of [
  ['before the held write', `const up = big[c & 7]; m = up + 1; sum += m; x[i] = c; ${R}`],
  ['after the held write', `${R}; const up = big[c & 7]; m = up + 1; sum += m; x[i % 8] = c`],
  ['a difference', `const up = big[c & 7]; m = up - 1; sum += m; x[i] = c; ${R}`],
  ['of the held name', `const up = big[c & 7]; m = up + i; sum += m; x[i] = c; ${R}`],
  ['into the held name', `const up = big[c & 7]; i = up + 1 + i; x[i] = c`],
  ['two sums', `const up = big[c & 7], dn = big[(c + 3) & 7]; m = up + 1; i = i * 2 + t; sum += dn - 1 + m`],
]) {
  prog(`sum ${name}`, 'let i = s, m = 0', `while (i < n) { ${cap()}; ${round} }`, names)
  prog(`sum ${name}, the bound literal`, 'let i = s, m = 0', `while (i < 100000) { ${cap()}; ${round} }`, names)
}
// a cursor stepped by literals, a ring, in the same round
for (const [name, decl, round, names] of [
  ['a cursor by two', 'let i = s, p = 0', `x[p & 7] = i % 5; p += 2; ${R}`, 'i, p'],
  ['a cursor entering from the parameter', 'let i = s, p = t', `x[p] = c; p += 3; ${R}`, 'i, p'],
  ['a ring with its reset', 'let i = s, p = 0', `x[p] = i % 5; p++; if (p >= 8) p = 0; ${R}`, 'i, p'],
  ['a ring by remainder', 'let i = s, p = 0', `x[p] = i % 5; p = (p + 1) % 8; ${R}`, 'i, p'],
  ['a cursor down', 'let i = s, p = 7', `x[p] = c; p--; ${R}`, 'i, p'],
  ['a cursor the held write reads', 'let i = s, p = 0', `x[i] = c; p += 2; i = i * 2 + p`, 'i, p'],
  ['a cursor stepped by the held name', 'let i = s, p = 0', `x[p] = c; p += i; ${R}`, 'i, p'],
  ['a cursor reset to the held name', 'let i = s, p = 0', `x[p] = c; p++; if (p > 5) p = i; ${R}`, 'i, p'],
]) prog(`cursor: ${name}`, decl, `while (i < n) { ${cap()}; ${round} }`, names)
// a walk over links in the same round
prog('links: a walk beside a held name', 'let i = s, j = 3', `while (i < n && j >= 0) { ${cap()}; x[j] = c; j = nx[j]; ${R} }`, 'i, j')
prog('links: a walk fed to the held name', 'let i = s, j = 3', `while (i < n) { ${cap()}; if (j >= 0) j = nx[j]; x[i] = c; i = i * 2 + (j > 0 ? j : 1) }`, 'i, j')
// derived indices of the held name
for (const [name, round, names = 'i', decl = 'let i = s'] of [
  ['a row base', `const b = i * 3 + 1; x[b] = c; x[b + 1] = c; ${R}`],
  ['a row base in a loop', `const b = i * 2; for (let k = 0; k < 3; k++) x[b + k] += k; ${R}`],
  ['a product with the stride', `x[i * t] = c; ${R}`],
  ['a difference from the bound', `x[n - i] = c; ${R}`],
  ['a difference from the bound, less one', `x[n - i - 1] = c; ${R}`],
  ['a shifted index', `x[i >> 1] = c; x[i << 1] = c + 1; ${R}`],
  ['a masked index', `x[i & 7] = c; ${R}`],
  ['a remainder index', `x[i % 8] = c; ${R}`],
  ['a doubled index read', `sum += x[i * 2] === undefined ? -1 : x[i * 2]; ${R}`],
  ['a sum of two held names', `x[i + q] = c; q = q * 2 + 1; ${R}`, 'i, q', 'let i = s, q = 0'],
  ['an index past the word', `x[i * 4] = c; x[i * 1024] = c; x[i + 2147483647] = c; ${R}`],
  ['an index below zero', `x[i - 1] = c; x[i - t] = c; ${R}`],
]) prog(`index: ${name}`, decl, `while (i < n) { ${cap()}; ${round} }`, names)
// receivers of every width, stores of the held name itself
for (const ctor of ['Uint8Array', 'Int8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array']) {
  prog(`receiver ${ctor}: a store of the held name`, 'let i = s', `while (i < n) { ${cap()}; x[c & 7] = i; ${R} }`, 'i', { arr: `new ${ctor}(8)` })
  prog(`receiver ${ctor}: a store at the held name`, 'let i = s', `while (i < n) { ${cap()}; x[i] = c + i; ${R} }`, 'i', { arr: `new ${ctor}(8)` })
  prog(`receiver ${ctor}: a read fed back`, 'let i = s', `while (i < n) { ${cap()}; i = i * 2 + x[i & 7] + t }`, 'i', { arr: `new ${ctor}(8)` })
}
// where the loop stands
prog('under an if', 'let i = s', `if (s !== 3) { while (i < n) { ${cap()}; x[i] = c; ${R} } } else { i = 1 }`)
prog('under an else', 'let i = s', `if (s === 3) i = 9; else while (i < n) { ${cap()}; x[i] = c; ${R} }`)
prog('under an if, no braces', 'let i = s', `if (s !== 3) while (i < n) { ${cap()}; x[i] = c; ${R} }`)
prog('in a block', 'let i = s', `{ let z = t + 1; while (i < n) { ${cap()}; x[i] = c; i = i * 2 + z } }`)
prog('in a switch arm', 'let i = s', `switch (s & 3) { case 1: while (i < n) { ${cap()}; x[i] = c; ${R} } break; default: i = i + 1 }`)
prog('in a labelled block', 'let i = s', `done: { if (t > 100) break done; while (i < n) { ${cap()}; x[i] = c; ${R} } }`)
prog('twice, the same loop', 'let i = s, j = s', `while (i < n) { ${cap(20)}; x[i] = c; ${R} }\n  while (j < n) { ${cap(44)}; x[j] = c; j = j * 2 + t }`, 'i, j')
prog('in a function declaration', 'let i = 0', `i = go(x, n, s, t)`, 'i', { pre: `function go(x, n, s, t) { let i = s, c = 0; while (i < n) { if (++c > 30) break; x[i] = c; i = i * 2 + t } return i }` })
prog('in a closure', 'let i = s', `const go = () => { while (i < n) { ${cap()}; x[i] = c; ${R} } }\n  go()`)
prog('in a closure of its own names', 'let r = 0', `const go = (a) => { let i = a; while (i < n) { ${cap()}; x[i] = c; ${R} }; return i }\n  r = go(s) + go(t)`, 'r')
prog('a regular array indexed', 'let i = s\n  const a = [3, 1, 4, 1, 5, 9, 2, 6]', `while (i < n) { ${cap()}; sum += a[i] === undefined ? -1 : a[i]; ${R} }`)
prog('a regular array stored', 'let i = s\n  const a = [3, 1, 4, 1, 5, 9, 2, 6]', `while (i < n) { ${cap()}; a[i & 7] = i; sum += a[c & 7]; ${R} }`)
prog('a string indexed', 'let i = s\n  const str = "abcdefgh"', `while (i < n) { ${cap()}; if (str[i] === undefined) u++; else sum += 1; ${R} }`)

test(`box forms population: ${P.length} boxes beside the copy's other forms, ${CONFIGS.length} configurations`, () =>
  population('box forms', P, { configs: CONFIGS, own: ['go'] }))
