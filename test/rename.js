// A name renamed through a tree (jzify/rename.js): every identifier of it, in every scope
// alike, and nothing that only spells it (a property, a key, a label, an accessor's or a
// field's name, a literal, a regex); a shorthand property is its key and a reference.
// `free` asks whether a tree reads a binding of the name from outside it; `occurs` counts
// the identifiers.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { levels } from './_matrix.js'
import { parse } from '../src/parse.js'
import { rename, free, occurs, spells } from '../jzify/rename.js'
import { oracle } from './util.js'
import { compileInternal } from '../src/compiler.js'
import jzify from '../jzify/index.js'
import { instantiate } from '../index.js'

const tree = (src) => parse(src, 'module', 0, false)
const text = (n) => JSON.stringify(n, (k, v) => v === undefined ? null : v)
// each source with `a` renamed `q` by hand
const RENAMED = [
  ['x = a + a.a', 'x = q + q.a'],
  ['x = o.a?.a[a]', 'x = o.a?.a[q]'],
  ['x = { a: a, b: 1 }', 'x = { a: q, b: 1 }'],
  ['x = { a }', 'x = { a: q }'],
  ['x = { a, b }', 'x = { a: q, b }'],
  ['x = { [a]: 1, ...a }', 'x = { [q]: 1, ...q }'],
  ['x = { a() { return a }, get a() { return a }, set a(v) { a = v } }', 'x = { a() { return q }, get a() { return q }, set a(v) { q = v } }'],
  ['({ a } = o)', '({ a: q } = o)'],
  ['({ a = 1, b: a2 } = o)', '({ a: q = 1, b: a2 } = o)'],
  ['let { a, b: [a3] } = o', 'let { a: q, b: [a3] } = o'],
  ['f = (a, { b = a }) => a + b', 'f = (q, { b = q }) => q + b'],
  ['f = ({ a }) => ({ a })', 'f = ({ a: q }) => ({ a: q })'],
  ['function a(a) { return a }', 'function q(q) { return q }'],
  ['class a extends a { a = a; static a = a; a() { return a } static { a = 1 } #a = 2; get a() { return a } }', 'class q extends q { a = q; static a = q; a() { return q } static { q = 1 } #a = 2; get a() { return q } }'],
  ['x = class { a; static a; [a]() {} }', 'x = class { a; static a; [q]() {} }'],
  ['a: for (;;) { break a; continue a }', 'a: for (;;) { break a; continue a }'],
  ['a: { a = 1 }', 'a: { q = 1 }'],
  ['{ a }', '{ q }'],
  ['if (a) { a } else { a }', 'if (q) { q } else { q }'],
  ['x = () => { a }', 'x = () => { q }'],
  ['x = () => ({ a })', 'x = () => ({ a: q })'],
  ['for (let a = 0; a < 2; a++) { a }', 'for (let q = 0; q < 2; q++) { q }'],
  ['for (const { a } of xs) a', 'for (const { a: q } of xs) q'],
  ['try { a } catch (a) { a } finally { a }', 'try { q } catch (q) { q } finally { q }'],
  ['try { a } catch { a }', 'try { q } catch { q }'],
  ['switch (a) { case a: a; break; default: a }', 'switch (q) { case q: q; break; default: q }'],
  ['do { a } while (a)', 'do { q } while (q)'],
  ['x = `a${a}a`', 'x = `a${q}a`'],
  ['x = /a/.test("a") ? \'a\' : a', 'x = /a/.test("a") ? \'a\' : q'],
  ['x = a ? a : a', 'x = q ? q : q'],
  ['x = new a(a).a(a)', 'x = new q(q).a(q)'],
  ['x = async (a) => { await a }', 'x = async (q) => { await q }'],
  ['function* g(a) { yield a; yield* a }', 'function* g(q) { yield q; yield* q }'],
  ['x = typeof a === "a" && a instanceof a', 'x = typeof q === "a" && q instanceof q'],
  ['var a = 1, b = a; let c = a', 'var q = 1, b = q; let c = q'],
]

test('rename: every identifier of a name, and nothing that only spells it', () => {
  const map = new Map([['a', 'q']])
  for (const [from, to] of RENAMED) is(text(rename(tree(from), map, true)), text(tree(to)), from)
  throws(() => rename(tree('export { a }'), map, true), /module/, 'a module\'s export form is refused, not guessed')
  throws(() => rename(tree('import { a } from "./x.js"'), map, true), /module/, 'and its import form')
})

test('rename: free, occurs, spells', () => {
  const FREE = [['x = (a) => { g(a) }', false], ['x = (b = a) => b', true], ['x = (b, { a }) => a', false], ['x = ([a]) => a', false], ['x = (...a) => a', false],
    ['f(a)', true], ['{ let a = 1; g(a) }', false], ['for (let a of xs) g(a)', false], ['for (let a = 0; a < 2; a++) g(a)', false], ['for (a of xs) g(a)', true],
    ['try { b } catch (a) { g(a) }', false], ['function a() { return a }', false], ['x = { a: 1 }.a', false], ['x = { a }', true], ['x = () => { const { a } = o; return a }', false],
    ['x = function () { return a }', true], ['x = function a() { return a }', false], ['class a { m() { return a } }', false], ['x = class { m() { return a } }', true],
    ['x = () => { g(a); let a }', false], ['x = y.a + z[a]', true], ['x = () => { { let a } return a }', true], ['a: for (;;) break a', false]]
  for (const [src, want] of FREE) is(free(tree(src), 'a'), want, src)
  is(occurs(tree('x = { a, b: a }.a + a; a: { break a }'), 'a'), 3, 'occurs: a shorthand once, a pair\'s value, a read')
  ok(spells(tree('x = o.a'), 'a') && !spells(tree('x = o.b'), 'a'), 'spells: any text of a node')
})

// Renamed so, a program is the program: each name a module declares at its top takes
// another, in programs that use it every way, and each answers as before.
const PROGRAMS = [
  `let n = 3\nconst add = (a, b) => a + b + n\nclass P { constructor(n) { this.n = n } get() { return add(this.n, n) } static of(v) { return new P(v) } }\nexport let t = (x) => { const o = { n, add, P }; let s = 0; for (const n of [1, 2]) s += o.add(n, x); L: for (;;) { s += P.of(x).get(); break L } return s + o.n }`,
  `const pick = ({ a, b = a }) => a + b\nconst a = 5\nfunction b(a) { return a * 2 }\nexport let t = (x) => { const { a: c } = { a }; try { throw b(c) } catch (a) { return pick({ a }) + pick({ a: x, b: a }) + b(a) } }`,
  `const table = [1, 2, 3]\nconst total = (table) => table.reduce((s, v) => s + v, 0)\nconst label = \`n\${table.length}\`\nexport let t = (x) => total(table) + total([x]) + label.length + (/table/.test('table') ? 1 : 0)`,
]
test('rename: a program with its names renamed answers as it did', () => {
  // the compile's own tree, renamed before anything lowers it
  let count = 0
  const renamed = (ast) => {
    const stmts = ast[0] === ';' ? ast.slice(1) : [ast], names = new Map()
    for (const s of stmts) {
      if (s[0] === 'let' || s[0] === 'const') for (const d of s.slice(1)) names.set(typeof d === 'string' ? d : d[1], '')
      else if ((s[0] === 'function' || s[0] === 'class') && typeof s[1] === 'string') names.set(s[1], '')
    }
    for (const n of names.keys()) names.set(n, n + '_renamed')
    count = names.size
    return [';', ...stmts.map(s => s[0] === 'export' ? ['export', rename(s[1], names, true)] : rename(s, names, true))]
  }
  for (const src of PROGRAMS) {
    const want = oracle(src).t(3)
    for (const optimize of levels(0, 2)) {
      is(instantiate(compileInternal(src, { optimize }, (ast, o) => jzify(renamed(ast), o))).exports.t(3), want, `renamed @${optimize}`)
      ok(count >= 3, `${count} names renamed`)
    }
  }
})
