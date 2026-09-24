// An object literal's accessor lowers to the slots `x__get`/`x__set`
// (jzify/classes.js); every builtin that lists or copies properties, and a
// computed key, sees the one property `x` (src/ast.js layoutView), read
// through its getter. JSON.stringify calls a value's toJSON
// (src/compile/emit/to-json.js). Each program runs against the host, at every
// level, on fresh module state.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { levels } from './_matrix.js'
import { oracle } from './util.js'

const agree = (cases) => {
  for (const [name, src, args = []] of cases) for (const optimize of levels(0, 2, 3))
    is(jz(src, { optimize }).exports.run(...args), oracle(src).run(...args), `${name} O${optimize}`)
}
const O = `{ a: 1, get g() { return 7 }, set s(v) { this.a = v } }`

test('literal accessors: the builtins list and read them by name', () => agree([
  // each listed `g__get`/`s__set`, read the getter's closure, or dropped the key
  ['keys', `export const run = () => JSON.stringify(Object.keys(${O}))`],
  ['keys of a binding', `export const run = () => { const o = ${O}; return JSON.stringify(Object.keys(o)) }`],
  ['values', `export const run = () => { const o = ${O}; return JSON.stringify(Object.values(o)) }`],
  ['entries', `export const run = () => JSON.stringify(Object.entries(${O}))`],
  ['for-in', `export const run = () => { const o = ${O}; let s = ''; for (const k in o) s += k + '=' + o[k] + ';'; return s }`],
  ['JSON.stringify', `export const run = () => { const o = ${O}; return JSON.stringify(o) }`],
  ['Object.assign', `export const run = () => { const t = Object.assign({}, ${O}); return JSON.stringify([t, 's' in t]) }`],
  ['assign into a binding', `export const run = () => { const t = { a: 0, g: 0 }; Object.assign(t, ${O}); return JSON.stringify(t) }`],
  ['fromEntries', `export const run = () => JSON.stringify(Object.fromEntries(Object.entries(${O})))`],
  ['structuredClone', `export const run = () => JSON.stringify(structuredClone(${O}))`],
  ['hasOwnProperty', `export const run = () => [({ get g() { return 1 } }).hasOwnProperty('g'), ({ get g() { return 1 } }).hasOwnProperty('h')].join()`],
  // a receiver whose layout the compiler cannot name enumerates at runtime
  ['unknown receiver', `const pick = (k) => k > 0 ? { a: 1, get g() { return 7 } } : { a: 2 }
export const run = (k) => JSON.stringify([Object.keys(pick(k)), Object.values(pick(k)), Object.keys(pick(0))])`, [1]],
  ['parameter receiver', `const ks = (o) => Object.keys(o).join('|') + '/' + Object.values(o).join('|')
export const run = () => ks({ a: 1, get g() { return 7 } }) + ' ' + ks({ b: 2 })`],
]))

test('literal accessors: definition order, index keys first', () => agree([
  ['setter first', `export const run = () => JSON.stringify(Object.keys({ set x(v) {}, a: 1, get x() { return 2 } }))`],
  ['index key', `export const run = () => JSON.stringify(Object.keys({ b: 1, get 2() { return 5 }, a: 3 }))`],
  // a later definition replaces an earlier one in place
  ['data replaces a getter', `export const run = () => { const o = { get x() { return 1 }, y: 2, x: 3 }; return JSON.stringify([Object.keys(o), Object.values(o)]) }`],
  ['a setter replaces data', `export const run = () => { const o = { x: 3, set x(v) {} }; return JSON.stringify([Object.keys(o), Object.values(o)]) }`],
]))

test('literal accessors: a getter runs where JS reads the property, once', () => agree([
  ['in order', `export const run = () => { let log = ''; const o = { get p() { log += 'p'; return 1 }, q: 2, get r() { log += 'r'; return 3 } }; const v = Object.values(o); return log + JSON.stringify(v) }`],
  ['with this', `export const run = () => JSON.stringify(Object.entries({ a: 4, get dbl() { return this.a * 2 } }))`],
  // spread copied the getter itself, which then ran on every later read
  ['spread copies the value', `export const run = () => { let c = 0; const src = { get g() { c++; return 7 } }; const o = { ...src }; const v1 = o.g, v2 = o.g; return [c, v1, v2, Object.keys(o).join()].join() }`],
  ['an unused spread still reads', `export const run = () => { let c = 0; const src = { get g() { c++; return 1 } }; const o = { ...src }; return c }`],
  ['spread of an unknown layout', `const mk = (k) => k ? { a: 1, get g() { return 7 } } : { b: 2 }
export const run = (k) => { const o = { ...mk(k) }; return JSON.stringify([o, Object.keys(o)]) }`, [1]],
  ['keys and in run no getter', `export const run = () => { let c = 0; const o = { get g() { c++; return 1 } }; const k = Object.keys(o); return [c, 'g' in o, c].join() }`],
  ['a clone keeps the cycle', `export const run = () => { const o = { a: 1, get self() { return o } }; const c = structuredClone(o); return [c.self === c, c.a, Object.keys(c).join()].join() }`],
  ['a clone is deep', `export const run = () => { const o = { a: 1, get g() { return { deep: [1, 2] } } }; const c = structuredClone(o); c.g.deep.push(3); return JSON.stringify([c, o.g]) }`],
]))

test('literal accessors: a computed key reaches them', () => agree([
  // `o[k]` read undefined and `o[k] = v` stored beside the setter
  ['read', `export const run = (k) => { const o = { a: 1, get g() { return 7 } }; return String(o[k]) }`, ['g']],
  ['read in a loop', `export const run = () => { const o = { a: 1, get g() { return 7 } }; return ['a', 'g'].map(k => o[k]).join() }`],
  ['store', `export const run = (k) => { const o = { a: 1, set s(v) { this.a = v } }; o[k] = 5; return o.a }`, ['s']],
  ['in', `export const run = (k) => { const o = { a: 1, get g() { return 7 } }; return [k in o, 'a' in o, (k + 'x') in o, 'g' in o].join() }`, ['g']],
  // the slots that carry an accessor list no names of their own
  ['no slot names', `export const run = (k) => { const o = { a: 1, get g() { return 7 } }; return JSON.stringify([Object.getOwnPropertyNames(o), Object.entries(o), k in o]) }`, ['g']],
]))

test('literal accessors: an object returned to the host lists them by name, read once', () => {
  // the host decoded the slots: `g__get` holding the getter, no `g` (interop.js through __view_data)
  const host = (r) => JSON.stringify([Object.keys(r), Object.values(r)])
  for (const [name, src, args = []] of [
    ['a getter', `export const run = () => ({ a: 1, get g() { return 7 } })`],
    ['nested', `export const run = () => ({ inner: { get g() { return 7 } } })`],
    ['with this', `export const run = (n) => ({ n, get dbl() { return this.n * 2 } })`, [4]],
    ['a setter alone', `export const run = () => ({ a: 1, set s(v) {} })`],
    ['in an array', `export const run = () => [{ get g() { return 1 } }, { get g() { return 2 } }]`],
  ]) for (const optimize of levels(0, 2, 3))
    is(host(jz(src, { optimize }).exports.run(...args)), host(oracle(src).run(...args)), `${name} O${optimize}`)
})

test('JSON.stringify calls toJSON with the key', () => agree([
  ['class', `class P { toJSON() { return { v: 1 } } }
export const run = () => JSON.stringify(new P())`],
  ['nested and in arrays', `class P { toJSON(k) { return 'k=' + k } }
export const run = () => JSON.stringify({ a: new P(), list: [new P(), new P()] }) + JSON.stringify(new P())`],
  ['with fields', `class P { constructor(x) { this.x = x } toJSON() { return { double: this.x * 2 } } }
export const run = () => JSON.stringify([new P(1), new P(5)])`],
  ['undefined omits the key', `class P { toJSON() { return undefined } }
export const run = () => JSON.stringify({ a: 1, b: new P(), c: [new P()] }) + '|' + String(JSON.stringify(new P()))`],
  ['inherited', `class A { toJSON() { return 'A' } } class B extends A { }
export const run = () => JSON.stringify([new A(), new B()])`],
  ['overridden', `class A { toJSON() { return 'A' } } class B extends A { toJSON() { return 'B' } }
export const run = () => JSON.stringify([new A(), new B()])`],
  // was rejected at compile time
  ['a literal\'s own', `export const run = () => JSON.stringify({ a: 1, toJSON() { return 'lit' } })`],
  ['a literal\'s own, keyed', `export const run = () => JSON.stringify({ outer: { toJSON(k) { return k.toUpperCase() } } })`],
  ['with this', `export const run = () => { const o = { n: 3, toJSON() { return this.n + 1 } }; return JSON.stringify([o, { o }]) }`],
  ['not a function', `export const run = () => JSON.stringify({ toJSON: 5, a: 1 })`],
  ['through a getter', `export const run = () => JSON.stringify({ get g() { return { toJSON() { return 'g!' } } } })`],
  ['a Date', `export const run = () => JSON.stringify({ d: new Date(0) })`],
]))

test('literal accessors: delete through a computed key removes them', () => agree([
  // returned false and kept the accessor; a static read then called its cleared slot
  ['delete', `export const run = (k) => { const o = { a: 1, get g() { return 7 } }; const r = delete o[k]; return JSON.stringify([r, Object.keys(o), k in o, String(o[k])]) }`, ['g']],
  ['a getter and setter', `export const run = (k) => { const o = { a: 1, get g() { return 7 }, set g(v) {} }; delete o[k]; return JSON.stringify([Object.keys(o), Object.values(o), JSON.stringify(o)]) }`, ['g']],
  ['a static read after', `export const run = (k) => { const o = { a: 1, get g() { return 7 } }; delete o[k]; return String(o.g) }`, ['g']],
  ['a store re-adds data', `export const run = (k) => { const o = { a: 1, get g() { return 7 } }; delete o[k]; o[k] = 5; return JSON.stringify([Object.keys(o), o[k], o.g, JSON.stringify(o)]) }`, ['g']],
  ['a static store after', `export const run = (k) => { let seen = 0; const o = { a: 1, set s(v) { seen = v } }; delete o[k]; o.s = 5; return JSON.stringify([seen, o.s, Object.keys(o)]) }`, ['s']],
  ['another key leaves them', `export const run = (k) => { const o = { a: 1, get g() { return 7 } }; delete o[k]; return JSON.stringify([Object.keys(o), o.g * 2]) }`, ['a']],
]))

// Views run only where code the program lowers builds such a literal
// (module/schema.js viewsOn), and toJSON only where it names JSON: an accessor in
// a function nothing calls put the view row beside every enumerated key, and a
// class's toJSON was lowered for a walker that never runs.
test('literal accessors and toJSON cost nothing where no code reaches them', () => {
  const src = (expr, tail = '') => `const pick = (k) => k ? { a: 1 } : { b: 2 }
class P { constructor(x) { this.x = x } get() { return this.x } toJSON() { return { v: this.x } } }
export const run = (k) => { const o = pick(k); let s = ''; for (const key in o) s += key + o[key]; return s + new P(k).get()${expr} }
${tail}`
  const wat = (s) => compile(s, { wat: true, optimize: 0 })
  const lowersToJSON = (s) => Object.keys(compile(s, { inspect: true, optimize: 0 }).inspect.functions).some(f => f.includes('toJSON'))
  const dead = src('', 'const unused = () => ({ get g() { return 7 } })')
  ok(!wat(dead).includes('__schema_view'), 'an unreached accessor literal reads no view')
  ok(wat(src(' + (k > 5 ? ({ get g() { return 7 } }).g : 0)')).includes('__schema_view'), 'a reached one does')
  ok(!lowersToJSON(dead), 'a program that never names JSON lowers no toJSON')
  ok(lowersToJSON(src(' + JSON.stringify(new P(k))')), 'one that stringifies does')
  agree([['reached', src(' + (k > 5 ? ({ get g() { return 7 } }).g : 0) + JSON.stringify(new P(k))'), [7]]])
})

// a shorthand property beside a method that reads `this` was rejected (jzify/classes.js lowerObjectLiteralThis)
test('a literal\'s method reads this beside a shorthand property', () => agree([
  ['method', `export const run = (n) => ({ n, m() { return this.n * 2 } }).m()`, [4]],
  ['getter', `export const run = (n) => ({ n, get dbl() { return this.n * 2 } }).dbl`, [4]],
]))
