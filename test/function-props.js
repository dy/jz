// A function's properties are the function value's own: they live in the
// table its pointer keys (module/collection.js __dyn_set), so a function read
// as a value stays callable, `typeof` says 'function', and every name for it
// sees one set of properties. Where the function never escapes, the plan
// dissolves them into module globals (plan/scope.js flattenFuncNamespaces).
// A top-level function used to be boxed into an object like a number with
// properties: read as a value, it was the box, and a call through it trapped.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { levels, belowOpt, onWasi, onKernel } from './_matrix.js'
import { oracle } from './util.js'

const show = (v) => JSON.stringify(v, (k, x) => x === undefined ? '<undefined>' : x)
const agree = (cases) => {
  for (const [name, src, ...args] of cases) for (const optimize of levels(0, 2, 3))
    is(show(jz(src, { optimize }).exports.f(...args)), show(oracle(src).f(...args)), `${name} O${optimize}`)
}

test('function properties: a function with a property stays a function read as a value', () => agree([
  ['called through a binding', `function g(x) { return g.k * x }\nlet set = () => { g.k = 3 }\nexport let f = () => { set(); let v = g; return v(4) }`],
  ['a property set at the top', `function g(x) { return g.k * x }\ng.k = 3\nexport let f = () => { let v = g; return [typeof v, v.k, v(4)] }`],
  ['typeof by name', `function g(x) { return x * 2 }\ng.k = 3\nexport let f = () => [typeof g, g.k, g(4)]`],
  ['an arrow at the top', `let g = (x) => g.k * x\ng.k = 3\nexport let f = () => { let v = g; return v(4) }`],
  ['a callback', `function g(x) { return g.k * x }\ng.k = 3\nexport let f = () => [1, 2].map(g)`],
  ['in a literal', `function g(x) { return g.k * x }\ng.k = 3\nlet o = () => ({ g })\nexport let f = () => [o().g(4), o().g.k, typeof o().g]`],
  ['in an array', `function g(x) { return x }\ng.k = 3\nlet arr = [g]\nexport let f = () => [arr[0].k, arr[0](5), typeof arr[0]]`],
  ['stored through an alias', `function g(x) { return x }\ng.k = 3\nexport let f = () => { let h = g; h.k = 7; return [g.k, h.k] }`],
  ['a counter', `function g(x) { return x }\ng.count = 0\nlet inc = () => { g.count++ }\nexport let f = () => { inc(); inc(); let v = g; return [g.count, v.count] }`],
  ['a computed key', `function g(x) { return x }\ng.k = 3\nexport let f = (key) => [g[key], g.k, 'k' in g, 'z' in g]`, 'k'],
  ['an argument', `function g(x) { return x }\ng.k = 3\nlet h = (fn) => fn.k\nexport let f = () => h(g)`],
]))

test('function properties: a namespace written inside functions reads as module globals', () => {
  const src = `function g(x) { return g.k * x }\nlet set = () => { g.k = 3 }\nexport let f = () => { set(); return g(4) }`
  for (const optimize of levels(0, 2, 3)) is(jz(src, { optimize }).exports.f(), 12, `O${optimize}`)
  if (belowOpt(2)) return
  ok(!/\$__dyn_(get|set)/.test(compile(src, { wat: true })), 'no property table')
})

test('function properties: a function lists no properties to Object.keys, as a closure does not', () => {
  throws(() => compile(`function g(x) { return x }\ng.k = 3\nexport let f = () => Object.keys(g)`), /Object\.keys\/getOwnPropertyNames on a function value is not supported/)
})

test('function properties: a lazily imported module sets a property on its own function', async () => {
  if (onWasi() || onKernel()) return   // the promise crosses to the host
  const modules = { './m.js': `export function g(x) { return g.k * x }\ng.k = 3\nexport let set = () => { g.k = 5 }` }
  for (const optimize of levels(0, 2, 3)) {
    const { f } = jz(`export let f = async () => { const m = await import('./m.js'); const a = m.g(4) + m.g.k; m.set(); return [a, m.g(2)] }`, { modules, optimize }).exports
    is(await f(), [15, 10], `O${optimize}`)
  }
})
