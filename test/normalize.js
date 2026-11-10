// One loop form (src/normalize.js): a counted loop reaches every reader as
// `for (…; i < n; ++i)` however it was written, and each rewrite answers what
// the source does. The rewrites over prepared trees first, then programs on
// the edges of each rewrite against Node, at this leg's levels.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { levels } from './_matrix.js'
import { oracle, jz } from './util.js'
import { normalize, numberNames } from '../src/normalize.js'

const lit = (v) => [null, v]
const show = (n) => JSON.stringify(n, (k, v) => v === undefined ? null : v)
// A prepared function body: `let i = 0` and the loop, its names read by syntax.
const fn = (...stmts) => ['{}', [';', ['let', ['=', 'i', lit(0)]], ...stmts]]
const norm = (body, valueOf) => { const { isNumber, valueOf: own } = numberNames(body); return normalize(body, isNumber, x => own(x) ?? valueOf?.(x) ?? null) }
const loopOf = (body) => norm(body)[1][2]

test('normalize: a Number is one by syntax, never NaN', () => {
  const { isNumber, valueOf } = numberNames([';',
    ['let', ['=', 'i', lit(0)], ['=', 'one', lit(1)], ['=', 's', lit(0)], ['=', 't', ['str', 'a']], ['=', 'c', lit(0)]],
    ['let', 'v'],
    ['++', 'i'], ['=', 'i', ['+', lit(2), 'i']], ['+=', 'i', 'one'],
    ['=', 's', ['+', 's', 'x']], ['+=', 't', lit(1)], ['=', 'v', lit(1)],
    ['=>', 'y', ['{}', [';', ['++', 'c']]]]])
  ok(isNumber('i') && isNumber('one'), 'stepped by literals and constants from a literal')
  is(valueOf('one'), 1, 'a name never written is a constant')
  is(valueOf('i'), null, 'a counter is no constant')
  for (const x of ['s', 't', 'v', 'c', 'x']) ok(!isNumber(x), `${x}: a sum of another name, a string, a declaration without a value, a closure's write, a parameter`)
})

test('normalize: each step of a Number is its normal step, as a statement or a loop step', () => {
  const steps = [
    [['+=', 'i', lit(1)], ['++', 'i']], [['-=', 'i', lit(-1)], ['++', 'i']], [['=', 'i', ['+', 'i', lit(1)]], ['++', 'i']],
    [['=', 'i', ['+', lit(1), 'i']], ['++', 'i']], [['=', 'i', ['-', 'i', lit(-1)]], ['++', 'i']], [['-=', 'i', lit(1)], ['--', 'i']],
    [['=', 'i', ['+', 'i', lit(3)]], ['+=', 'i', lit(3)]], [['-=', 'i', lit(-3)], ['+=', 'i', lit(3)]], [['=', 'i', ['-', 'i', lit(2)]], ['-=', 'i', lit(2)]],
    [['+=', 'i', lit(-0.5)], ['-=', 'i', lit(0.5)]],
    // (a wrap is another step; a step of zero keeps its sign rule)
    [['=', 'i', ['|', ['+', 'i', lit(1)], lit(0)]], null], [['+=', 'i', lit(0)], null],
  ]
  for (const [s, want] of steps) {
    is(show(norm(fn(s))[1][2]), show(want ?? s), `${show(s)} as a statement`)
    is(show(loopOf(fn(['for', null, ['<', 'i', 'n'], s, [';']]))[3]), show(want ?? s), `${show(s)} as a step`)
  }
  is(show(loopOf(fn(['for', null, ['<', 'i', 'n'], [',', ['postfix', ['++', 'k']], ['=', 'i', ['+', 'i', lit(1)]]], [';']]))[3]),
    show([',', ['++', 'k'], ['++', 'i']]), 'each part of a comma step, a postfix its update')
  const str = ['{}', [';', ['let', ['=', 'i', ['str', '1']]], ['+=', 'i', lit(1)]]]
  is(show(norm(str)[1][2]), show(['+=', 'i', lit(1)]), 'a string concatenates: no step')
})

test('normalize: a test with the counter on the right is mirrored, where nothing else could be the counter', () => {
  const t = (c) => show(loopOf(fn(['for', null, c, ['++', 'i'], [';']]))[2])
  is(t(['>', 'n', 'i']), show(['<', 'i', 'n']), 'n > i')
  is(t(['>=', ['.', 'a', 'length'], 'i']), show(['<=', 'i', ['.', 'a', 'length']]), 'a.length >= i')
  is(t(['<', lit(9), 'i']), show(['>', 'i', lit(9)]), '9 < i')
  is(t(['&&', ['>', 'n', 'i'], 'ok']), show(['&&', ['<', 'i', 'n'], 'ok']), 'a conjunct')
  is(t(['>', ['=', 'i', lit(5)], 'i']), show(['>', ['=', 'i', lit(5)], 'i']), 'a left side that writes the counter: the reads would swap')
})

test('normalize: a leading break is the test', () => {
  const brk = (c) => norm(fn(['while', ['bool', 1], [';', ['if', c, ['break']], ['++', 'i']]]))[1][2]
  is(show(brk(['>=', 'i', 'n'])), show(['while', ['!', ['>=', 'i', 'n']], [';', ['++', 'i']]]), 'while (true)')
  is(show(brk(['!', 'done'])[1]), show('done'), '`!!c` is c in a test')
  const labeled = norm(fn(['while', ['bool', 1], [';', ['if', 'c', ['break', 'out']], ['++', 'i']]]))[1][2]
  is(labeled[1][0], 'bool', 'a break of another loop is no test of this one')
  is(show(loopOf(fn(['for', null, null, ['++', 'i'], [';', ['if', ['>=', 'i', lit(8)], ['break']], 'x']]))),
    show(['for', null, ['!', ['>=', 'i', lit(8)]], ['++', 'i'], [';', 'x']]), 'for (;;)')
})

test('normalize: a do-while whose test holds on entry is a while', () => {
  const lowered = (c, body) => [['let', ['=', 'F', lit(true)]], ['while', ['||', 'F', c], ['{}', [';', ['=', 'F', lit(false)], body]]]]
  const guarded = norm(fn(['if', ['<', 'i', 'n'], [';', ...lowered(['<', 'i', 'n'], [';', 'x', ['++', 'i']])]]))
  is(show(guarded[1][2]), show(['while', ['<', 'i', 'n'], [';', 'x', ['++', 'i']]]), 'the whole of `if (c)`, the same test')
  const entry = norm(fn(...lowered(['<', 'i', 'N'], [';', 'x', ['++', 'i']])), x => x === 'N' ? 4 : null)
  is(show(entry[1][2]), show(['while', ['<', 'i', 'N'], [';', 'x', ['++', 'i']]]), 'true over the literal declared before it')
  const nested = norm(fn([';', ...lowered(['<', 'i', 'N'], [';', 'x', ['++', 'i']])]), x => x === 'N' ? 4 : null)
  is(show(nested[1][2]), show(['while', ['<', 'i', 'N'], [';', 'x', ['++', 'i']]]), 'a statement of the two, as strict prepare writes it')
  const later = norm(fn(...lowered(['<', 'i', 'N'], [';', 'x', ['++', 'i']])), x => x === 'N' ? 0 : null)
  is(later[1][2][0], 'let', 'false on entry: the body runs once, as written')
  const other = norm(fn(['if', ['<', 'i', 'm'], [';', ...lowered(['<', 'i', 'n'], 'x')]]))
  is(other[1][2][0], 'if', 'another test')
})

// Programs on the edges, each against Node at every level.
const CASES = [
  // a NaN bound: `!(i >= n)` runs where `i < n` would not
  ['export let f = (n) => { let i = 0, s = 0; while (true) { if (i >= n) break; s += i; i++; if (i > 50) break } return s }', [10, NaN, 3.5, -1, undefined, '7']],
  // a flipped test over a string bound converts it, either way round
  ['export let f = (n) => { let s = 0; for (let i = 0; n > i; i -= -1) s += i; return s }', [5, '5', 2.5, NaN]],
  // a left side that calls: it reads after the counter now, and writes nothing the test reads
  ['export let f = (n) => { let s = 0, c = 0; const g = () => { c++; return n }; for (let i = 0; g() > i; i = i + 1) s += c; return s * 100 + c }', [4, 0]],
  ['export let f = (n) => { let s = 0, i = 0; do { s++; i++ } while (i < 3); i = 5; do { s += 10; i++ } while (i < 3); return s * 100 + i }', [0]],
  ['export let f = (n) => { let i = 0, s = 0; if (i < n) do { i++; if (i % 2) continue; s += i } while (i < n); return s }', [0, 7, 7.5, NaN]],
  ['export let f = (n) => { let s = 0, i = 0; L: do { i++; if (i % 3 === 0) continue L; s += i } while (i < 9); return s + n }', [0]],
  // a counter a closure steps is no Number by syntax
  ['export let f = (n) => { let i = 0, s = 0; const bump = () => { i += 2 }; for (; i < n; i += 1) { s++; if (s % 3 === 0) bump() } return s * 1000 + i }', [10, 11]],
  ['export let f = (n) => { let s = 0; for (let i = -0; i < 2; i -= -1) s += 1 / i; return s + n }', [0]],
  ['export let f = (n) => { let s = "1"; for (let i = 0; i < n; i++) s += 1; let t = 0; for (let k = "0"; k < n; k = k + 1) t++; return s + t }', [3]],
  ['const N = 6\nlet g = 0\nfor (let k = 0; N > k; k += 1) g += k\nexport let f = (n) => g + n', [1]],
  ['export let f = (n) => { let s = 0; out: for (let j = 0; j < 3; j++) { let i = 0; while (true) { if (i > n) break out; if (i >= 4) break; s += i * 10 + j; i = i + 1 } } return s }', [2, 9]],
]

test('normalize: each rewrite answers what Node does', () => {
  for (const [src, args] of CASES) {
    const host = oracle(src).f
    for (const optimize of levels(0, 2, 'speed')) {
      const f = jz(src, { optimize }).exports.f
      for (const n of args) ok(Object.is(f(n), host(n)), `${src}\n  f(${n}) at ${optimize}: ${f(n)}, node ${host(n)}`)
    }
  }
})
