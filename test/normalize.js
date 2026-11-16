// One loop form (src/normalize.js): a counted loop reaches every reader as
// `for (…; i < n; ++i)` however it was written, and each rewrite answers what
// the source does. The rewrites over prepared trees first, then programs on
// the edges of each rewrite against Node, at this leg's levels.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { levels } from './_matrix.js'
import { oracle, jz, wat } from './util.js'
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

test('normalize: a leading break is the test; a negation goes where neither side can be NaN', () => {
  const brk = (c, valueOf) => norm(fn(['while', ['bool', 1], [';', ['if', c, ['break']], ['++', 'i']]]), valueOf)[1][2]
  is(show(brk(['>=', 'i', 'n'])), show(['while', ['!', ['>=', 'i', 'n']], [';', ['++', 'i']]]), 'a parameter bound may be NaN: the negation stays')
  is(show(brk(['>=', 'i', 'N'], x => x === 'N' ? 64 : null)), show(['while', ['<', 'i', 'N'], [';', ['++', 'i']]]), 'a constant bound')
  is(show(brk(['>=', 'i', lit(NaN)])[1]), show(['!', ['>=', 'i', lit(NaN)]]), 'a NaN literal')
  is(show(brk(['!', 'done'])[1]), show('done'), '`!!c` is c in a test')
  const labeled = norm(fn(['while', ['bool', 1], [';', ['if', 'c', ['break', 'out']], ['++', 'i']]]))[1][2]
  is(labeled[1][0], 'bool', 'a break of another loop is no test of this one')
  is(show(loopOf(fn(['for', null, null, ['++', 'i'], [';', ['if', ['>=', 'i', lit(8)], ['break']], 'x']]))),
    show(['for', null, ['<', 'i', lit(8)], ['++', 'i'], [';', 'x']]), 'for (;;)')
})

test('normalize: an integer counted up by one toward a constant tests `i < B`', () => {
  const t = (init, c, step = ['++', 'i'], body = [';', 'x'], valueOf = x => x === 'N' ? 8 : null) =>
    show(norm(['{}', [';', ['for', init, c, step, body]]], valueOf)[1][1][2])
  const from = (v) => ['let', ['=', 'i', lit(v)]]
  is(t(from(0), ['<=', 'i', ['-', 'N', lit(1)]]), show(['<', 'i', lit(8)]), 'i <= N - 1: an integer below the bound one up')
  is(t(from(0), ['<=', 'i', lit(2.5)]), show(['<', 'i', lit(3)]), 'i <= 2.5: below the next integer')
  is(t(from(-3), ['!==', 'i', 'N']), show(['<', 'i', 'N']), 'i !== N from below')
  for (const [why, init, c, step, body] of [
    ['a start past the bound never meets it', from(9), ['!==', 'i', 'N']],
    ['a fractional bound is never met', from(0), ['!==', 'i', lit(4.5)]],
    ['a fractional start', from(0.5), ['<=', 'i', 'N']],
    ['a step of two', from(0), ['!==', 'i', 'N'], ['+=', 'i', lit(2)]],
    ['a body that writes the counter', from(0), ['!==', 'i', 'N'], ['++', 'i'], [';', ['=', 'i', lit(3)]]],
    ['a bound no constant holds', from(0), ['<=', 'i', 'n']],
  ]) is(t(init, c, step, body), show(c), why)
})

test('normalize: a do-while is a while where its test holds on entry, else a flag loop', () => {
  const N = (v) => (x) => x === 'N' ? v : null, body = () => [';', 'x', ['++', 'i']]
  const guarded = norm(fn(['if', ['<', 'i', 'n'], ['do', body(), ['<', 'i', 'n']]]))
  is(show(guarded[1][2]), show(['while', ['<', 'i', 'n'], body()]), 'the whole of `if (c)`, the same test')
  const entry = norm(fn(['do', body(), ['<', 'i', 'N']]), N(4))
  is(show(entry[1][2]), show(['while', ['<', 'i', 'N'], body()]), 'true over the literal declared before it')
  const labeled = norm(fn(['label', 'L', ['do', body(), ['<', 'i', 'N']]]), N(4))
  is(show(labeled[1][2]), show(['label', 'L', ['while', ['<', 'i', 'N'], body()]]), 'under its label: a continue of it reaches the test of either')
  const later = norm(fn(['do', body(), ['<', 'i', 'N']]), N(0))[1][2], F = later[1]?.[1]?.[1]
  is(show(later), show([';', ['let', ['=', F, lit(true)]], ['while', ['||', F, ['<', 'i', 'N']], ['{}', [';', ['=', F, lit(false)], body()]]]]), 'false on entry: the body runs once, then the test')
  const other = norm(fn(['if', ['<', 'i', 'm'], ['do', 'x', ['<', 'i', 'n']]]))
  is(other[1][2][2][0], ';', 'another test: the guard stays')
  const written = norm(['{}', [';', ['let', ['=', 'i', lit(0)], ['=', 'j', [',', ['=', 'i', 'v'], lit(0)]]], ['do', body(), ['<', 'i', 'N']]]], N(4))
  is(written[1][2][0], ';', 'a declaration after the literal may write it: no value on entry')
})

test('normalize: once kinds are known, a counter declared from a parameter is in the one form too', () => {
  const src = (loop) => `const a = new Float64Array(64)\nexport let f = (k, n, d) => { let s = 0; ${loop} s += a[i]; return s }`
  for (const optimize of [2, 'speed']) for (const [canon, spellings] of [
    ['for (let i = k; i < n; ++i)', ['for (let i = k; n > i; i = 1 + i)', 'for (let i = k; i < n; i = i + 1)', 'for (let i = k; n > i; i -= -1)', 'for (let i = k; i < n; i = i - -1)']],
    ['for (let i = k; i < n; i += d)', ['for (let i = k; i < n; i = i + d)', 'for (let i = k; n > i; i = d + i)']],
  ]) {
    const want = wat(src(canon), { optimize })
    for (const s of spellings) ok(wat(src(s), { optimize }) === want, `${s} compiles as ${canon} at ${optimize}`)
  }
})

// Programs on the edges, each against Node at every level.
const CASES = [
  // a NaN bound: `!(i >= n)` runs where `i < n` would not
  ['export let f = (n) => { let i = 0, s = 0; while (true) { if (i >= n) break; s += i; i++; if (i > 50) break } return s }', [10, NaN, 3.5, -1, undefined, '7']],
  // the test its one exit: a copy over the bound's word reads `i < n` (plan/integral-loops.js), the loop as written the rest
  ['export let f = (n) => { let i = 0, s = 0; while (true) { if (i >= n) break; s += i * 2; i++ } return s }', [10, 3.5, -1, 0, '7', 47.5]],
  ['export let f = (n) => { const a = new Float64Array(16); let i = 0; while (true) { if (i >= n) break; a[i] = i + 0.5; i++ } let s = 0; for (let k = 0; k < 16; k++) s += a[k]; return s }', [16, 3.5, -2, 0, '9']],
  // a flipped test over a string bound converts it, either way round
  ['export let f = (n) => { let s = 0; for (let i = 0; n > i; i -= -1) s += i; return s }', [5, '5', 2.5, NaN]],
  // a left side that calls: it reads after the counter now, and writes nothing the test reads
  ['export let f = (n) => { let s = 0, c = 0; const g = () => { c++; return n }; for (let i = 0; g() > i; i = i + 1) s += c; return s * 100 + c }', [4, 0]],
  ['export let f = (n) => { let s = 0, i = 0; do { s++; i++ } while (i < 3); i = 5; do { s += 10; i++ } while (i < 3); return s * 100 + i }', [0]],
  ['export let f = (n) => { let i = 0, s = 0; if (i < n) do { i++; if (i % 2) continue; s += i } while (i < n); return s }', [0, 7, 7.5, NaN]],
  // a flag loop the source wrote, its flag read after it
  ['export let f = (n) => { let i = 0; let go = true; while (go || i < 3) { go = false; i++ } return go ? -1 : i + n }', [0]],
  // the counter written between its literal and the loop
  ['export let f = (n) => { let s = 0; let i = 0, j = (i = n, 0); do { s += 1; i++ } while (i < 3); return s * 100 + i + j }', [9, 0]],
  ['export let f = (n) => { let s = 0, i = 0; L: do { i++; if (i % 3 === 0) continue L; s += i } while (i < 9); return s + n }', [0]],
  // a do-while its test may fail on entry: the body once, a continue to the test, a labeled one from a nested loop, a break and a return
  ['export let f = (n) => { let s = 0, i = n; L: do { i++; for (let j = 0; j < 3; j++) { if (j === i) continue L; s += j } if (i === 5) continue; if (s > 40) break; if (i === 7) return -s } while (i < 6); return s * 100 + i }', [0, 3, 9, NaN, 2.5]],
  ['let S = 0, I = 9\ndo { S += I; I++ } while (I < 4)\nexport let f = (n) => S * 100 + I + n', [0]],
  // a counter from a parameter, a Number of the summary's, of every value; and one a helper is handed a string and a number for
  ['export let f = (n) => { let s = 0; for (let i = n - 3; n > i; i = 1 + i) s += i; let j = n; while (j < n + 2) { s += j; j -= -1 } return s }', [5, 2.5, NaN, -0, 2 ** 52]],
  ['const count = (a, b) => { let r = 0; for (let i = a; b > i; i += 1) { r += 1; if (r > 40) break } return r }\nexport let f = (n) => count(String(n), 5) + count(n, 5) * 100', [0, 3, 2.5]],
  // a counter a closure steps is no Number by syntax
  ['export let f = (n) => { let i = 0, s = 0; const bump = () => { i += 2 }; for (; i < n; i += 1) { s++; if (s % 3 === 0) bump() } return s * 1000 + i }', [10, 11]],
  ['export let f = (n) => { let s = 0; for (let i = -0; i < 2; i -= -1) s += 1 / i; return s + n }', [0]],
  ['export let f = (n) => { let s = "1"; for (let i = 0; i < n; i++) s += 1; let t = 0; for (let k = "0"; k < n; k = k + 1) t++; return s + t }', [3]],
  ['const N = 6\nlet g = 0\nfor (let k = 0; N > k; k += 1) g += k\nexport let f = (n) => g + n', [1]],
  ['export let f = (n) => { let s = 0; out: for (let j = 0; j < 3; j++) { let i = 0; while (true) { if (i > n) break out; if (i >= 4) break; s += i * 10 + j; i = i + 1 } } return s }', [2, 9]],
  // an integer counter toward a constant: `<=` a step below it, `!==` met from below, and the edges no rewrite takes
  ['const N = 7\nexport let f = (n) => { let s = 0; for (let i = 0; i <= N - 1; i++) s += i; return s * 10 + n }', [0, 2]],
  ['export let f = (n) => { let s = 0; for (let i = -3; i <= 2.5; i++) s += i; return s + n }', [0]],
  ['export let f = (n) => { let s = 0; for (let i = -3; i !== 4; i = 1 + i) s += i * i; return s + n }', [0]],
  ['const N = 5\nexport let f = (n) => { let s = 0; for (let i = 7; i !== N; i++) { s++; if (s > 20) break } return s + n }', [0]],
  ['export let f = (n) => { let s = 0; for (let i = 0; i !== 4.5; i++) { s++; if (s > 9) break } return s + n }', [0]],
  ['export let f = (n) => { let s = 0; for (let i = 0; i !== 6; i++) { s += i; if (i === 2) i = 9; if (s > 40) break } return s + n }', [0]],
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
