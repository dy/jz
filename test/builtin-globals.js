// A builtin global jz resolves at compile time (a namespace such as Math, a
// constructor such as Map, a function such as parseInt) is a real binding
// whether or not jz holds a value for it. `typeof` of one used to fail
// ("'math' is not in scope") or answer 'undefined' (console, setTimeout);
// it answers what JS answers now (prepare/state.js GLOBAL_TYPEOF), for a
// namespace alias too. One used as a value is rejected naming it, and a
// binding that takes a builtin's name (`(Number) => Number + 1`) is the
// binding, never the builtin.
import test from 'tst'
import { is, throws } from 'tst/assert.js'
import jz from '../index.js'
import { levels } from './_matrix.js'
import { oracle } from './util.js'

const agree = (cases) => {
  for (const [name, src, ...args] of cases) for (const optimize of levels(0, 2, 3))
    is(jz(src, { optimize }).exports.f(...args), oracle(src).f(...args), `${name} O${optimize}`)
}

// Globals this host defines too, so Node answers for each.
const NAMES = ['Math', 'JSON', 'Atomics', 'console', 'crypto', 'navigator', 'performance',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Date', 'RegExp', 'Function',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
  'Error', 'TypeError', 'RangeError', 'Iterator', 'TextEncoder', 'TextDecoder', 'URLSearchParams',
  'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'atob', 'btoa', 'fetch', 'structuredClone', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'Float64Array', 'Event', 'WeakRef'].filter(n => typeof globalThis[n] !== 'undefined')

test('builtin globals: typeof answers what JS answers', () => agree(
  NAMES.flatMap(n => [
    [`typeof ${n}`, `export let f = () => typeof ${n}`],
    [`typeof ${n} compared`, `export let f = () => typeof ${n} === 'object'`],
  ])))

test('builtin globals: a namespace alias is the namespace', () => agree([
  ['module alias', `const M = Math\nexport let f = () => typeof M`],
  ['local alias', `export let f = () => { const M = Math; return typeof M }`],
  ['JSON alias', `export let f = () => { const J = JSON; return typeof J + J.stringify([1]) }`],
  ['constructor alias', `export let f = () => { const E = TypeError; return typeof E }`],
  ['module constructor alias', `const N = Number\nexport let f = () => typeof N + N.NEGATIVE_INFINITY`],
  ['module Array alias', `const A = Array\nexport let f = () => typeof A + A.isArray([1])`],
  ['feature detection', `export let f = () => typeof Math !== 'undefined' ? Math.sqrt(4) : 0`],
  ['timer detection', `export let f = () => typeof setTimeout === 'function'`],
]))

test('builtin globals: a binding that takes the name is the binding', () => agree([
  ['module value', `let Math = 5\nexport let f = () => typeof Math`],
  ['parameter', `let g = (console) => typeof console\nexport let f = () => g(1)`],
  ['block value', `export let f = () => { let JSON = 1; return typeof JSON }`],
  ['module function', `let Map = (x) => x\nexport let f = () => typeof Map`],
  ['parameter Number', `export let f = (Number) => Number + 1`, 2],
  ['local Number', `export let f = (x) => { let Number = x * 2; return Number + 1 }`, 2],
  ['local Boolean', `export let f = (x) => { let Boolean = x; return Boolean }`, 2],
  ['module Number', `let Number = 7\nexport let f = () => Number`],
  ['typeof a parameter Number', `export let f = (Number) => typeof Number`, 2],
  ['module function Boolean', `let Boolean = (x) => 'b'\nexport let f = () => [1].map(Boolean)`],
  ['module function parseInt', `let parseInt = (s) => 42\nexport let f = () => ['1'].map(parseInt)`],
  ['typeof a module function parseInt', `let parseInt = (s) => 42\nexport let f = () => typeof parseInt`],
]))

test('builtin globals: one used as a value is rejected naming it', () => {
  for (const [name, src] of [
    ['Math', `let g = (m) => m.sqrt(9)\nexport let f = () => g(Math)`],
    ['Math', `export let f = () => [Math].length`],
    ['Math', `export let f = () => { const M = Math; return [M].length }`],
    ['JSON', `export let f = () => JSON === JSON`],
    ['console', `export let f = () => [console].length`],
    ['Map', `let g = (c) => new c()\nexport let f = () => g(Map)`],
    ['parseInt', `export let f = () => ['1', '2'].map(parseInt)`],
    ['parseInt', `export let f = () => { const P = parseInt; return P('12') }`],
    ['isNaN', `export let f = () => [1].filter(isNaN)`],
    ['setTimeout', `export let f = () => [setTimeout].length`],
  ]) throws(() => jz(src), new RegExp(`'${name}' as a value is not supported`), `${name}: ${src.split('\n').pop()}`)
  // A name no builtin holds stays an unresolved reference.
  throws(() => jz(`export let f = () => [nothing].length`), /'nothing' is not in scope/)
})
