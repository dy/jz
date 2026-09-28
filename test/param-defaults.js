// Parameter defaults run in their function's frame before the body
// (src/function.js frameRoots): every scan of what a function reads, writes,
// captures or reassigns walks them too. Each program below was miscompiled by
// a scan that read only the body; each runs against the host, at every level,
// on fresh module state.
import test from 'tst'
import { is } from 'tst/assert.js'
import jz from '../index.js'
import { levels } from './_matrix.js'
import { oracle } from './util.js'

const agree = (cases) => {
  for (const [name, src, args] of cases) for (const optimize of levels(0, 2, 3)) {
    const want = oracle(src).run(...args), got = jz(src, { optimize }).exports.run(...args)
    is(Number.isNaN(got) && Number.isNaN(want) ? 'NaN' : got, Number.isNaN(want) ? 'NaN' : want, `${name} O${optimize}`)
  }
}

test('param defaults: a default\'s use of a parameter keeps it from the numeric boundary', () => agree([
  // the summary's numeric demand read only bodies (the host coerced 'abc' to NaN)
  ['member use', `export const run = (a, b = a.length) => (a > 0 ? 1 : 2) + b`, ['abc']],
  ['index use', `export const run = (a, i = 1, b = a[i]) => (a > 0 ? 1 : 2) + b`, [[5, 6, 7]]],
  ['concatenation', `export const run = (a, b = a + '!') => (a > 0 ? 1 : 2) + b.length`, ['xy']],
  ['string method', `export const run = (s, n = s.length) => s + n`, ['hey']],
  ['closure', `export const run = (s) => { const f = (a, b = a.length) => (a > 0 ? 1 : 2) + b; return f(s) }`, ['abcd']],
  ['internal', `const f = (a, b = a.length) => (a > 0 ? 1 : 2) + b\nexport const run = (s, t) => f(s) + f(t) * 10`, ['ab', 'cde']],
  // a default runs before an explicit `a = +a` prologue: it reads the host's value
  ['before the prologue', `export const run = (a, n = a.length) => { a = +a; return a + n }`, ['12']],
]))

test('param defaults: a parameter a default reassigns keeps no caller facts', () => agree([
  // the summary took the default's write for straight-line code, or ignored it
  ['kind change', `const f = (a, b = (a = 'x' + a)) => a\nexport const run = (n) => f(n) + '/' + f(n, 0)`, [3]],
  ['exported kind change', `export const run = (a, b = (a = a + 'q')) => a + b.length`, [5]],
  ['closure kind change', `export const run = (n) => { const f = (a, b = (a = [a, a])) => a.length; return f(n) + f(n, 1) }`, [2]],
  // call-site constants and typed lengths described the argument, not the reassigned parameter
  ['constant argument', `const f = (k, b = (k = k + 5)) => k * 2\nexport const run = (n) => f(3) + f(3, 0) * 100 + n`, [0]],
  ['constant loop bound', `const f = (k, b = (k = 7)) => { let s = 0; for (let i = 0; i < k; i++) s += i; return s }\nexport const run = (n) => f(2) + f(2, 1) * 100 + n`, [0]],
  ['typed length', `const f = (a, b = (a = new Float64Array(5))) => a.length\nexport const run = (n) => f(new Float64Array(2)) + f(new Float64Array(2), 0) * 10 + n`, [0]],
  ['typed loop length', `const f = (a, b = (a = new Int8Array(9))) => { let s = 0; for (let i = 0; i < a.length; i++) s += 1; return s }\nexport const run = (n) => f(new Int8Array(3)) + f(new Int8Array(3), 0) * 100 + n`, [0]],
]))

test('param defaults: a default\'s growth, slot writes and captures count', () => agree([
  // an array a default grows kept its call-site length (13013 for 27027)
  ['growth', `const f = (a, n = a.push(7)) => a.length * 10 + a[a.length - 1]\nexport const run = (k) => { const x = [k]; return f(x) + f(x, 0) * 1000 }`, [3]],
  ['growth read in a loop', `const f = (a, n = a.push(5, 6, 7, 8, 9, 10, 11, 12)) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s }\nexport const run = (k) => { const x = [k]; return f(x) + x.length }`, [1]],
  // a slot a default writes was taken for an integer constant
  ['slot write', `const o = { v: 1 }\nconst f = (x = (o.v = 2.5)) => x\nexport const run = (n) => { const a = o.v; f(); return a * 10 + o.v + n }`, [0]],
  ['slot accumulation', `const o = { c: 0 }\nconst f = (x = (o.c = o.c + 0.5)) => x\nexport const run = (n) => { for (let i = 0; i < n; i++) f(); return o.c }`, [3]],
  // a closure a default makes captures the parameter's binding, not its value
  ['captured binding', `export const run = (n) => { const f = (a, g = () => a * 2) => { a = a + 1; return g() }; return f(n) }`, [5]],
]))

// A default's kind joins its parameter only where some call lets the default
// run (summary/index.js `defaultRuns`: a missing or possibly undefined
// argument, a spread, a caller the summary cannot see), and the emitter drops
// a default no call lets run. `toArray(array = [], offset = 0)` handed a typed
// array by every caller then stores as into a typed array, not through the
// polymorphic array store the `[]` default used to force.
test('param defaults: a default runs where a call lets it, and only there', () => {
  agree([
    ['every call passes it', `const f = (a, o = 0) => a[o] + 1\nexport const run = () => f(new Float32Array([5, 6]), 1) + f(new Float32Array([7]), 0)`, []],
    ['a call omits it', `const f = (a, o = 1) => a[o] + 1\nexport const run = () => f(new Float32Array([5, 6])) + f(new Float32Array([7, 8]), 0)`, []],
    ['undefined passed', `const f = (a, o = 1) => a[o] + 1\nexport const run = () => f(new Float32Array([5, 6]), undefined) + f(new Float32Array([7, 8]), 0)`, []],
    ['a possibly undefined local passed', `const f = (a, o = 1) => a[o] + 1\nexport const run = (k) => { let i; if (k > 5) i = 0; return f(new Float32Array([5, 6]), i) }`, [1]],
    ['forwarded through a wrapper', `const f = (a, o = 1) => a[o] + 1\nconst g = (a, o) => f(a, o)\nexport const run = () => g(new Float32Array([5, 6])) + g(new Float32Array([7, 8]), 0)`, []],
    ['the host omits it', `export const run = (a = 5, b = 7) => a * 10 + b`, []],
    ['a spread call', `const f = (a, o = 1) => a[o] + 1\nexport const run = () => { const args = [new Float32Array([5, 6])]; return f(...args) }`, []],
    ['a default of another kind, one caller', `class V { constructor() { this.x = 1; this.y = 2 } toArray(array = [], offset = 0) { array[offset] = this.x; array[offset + 1] = this.y; return array } }\nexport const run = () => { const a = new Float32Array(4); new V().toArray(a, 2); return a[2] * 10 + a[3] }`, []],
    ['a default of another kind, both ways', `class V { constructor() { this.x = 1; this.y = 2 } toArray(array = [], offset = 0) { array[offset] = this.x; array[offset + 1] = this.y; return array } }\nexport const run = () => { const a = new Float32Array(4); new V().toArray(a, 2); const b = new V().toArray(); return a[2] * 10 + a[3] + b.length * 100 + b[1] * 1000 }`, []],
    ['a callee only the default reaches', `const mk = () => 9\nconst f = (a, o = mk()) => a + o\nexport const run = () => f(1, 2) * 10 + f(1)`, []],
    ['a factory forwarding undefined to the initializer', `class V { constructor(x = 3, y = x * 2) { this.x = x; this.y = y } }\nexport const run = () => { const a = new V(), b = new V(1); return a.x + a.y * 10 + b.x * 100 + b.y * 1000 }`, []],
    ['a specialized variant keeps the default that reassigns', `const f = (a, b = (a = new Int8Array(9))) => { let s = 0; for (let i = 0; i < a.length; i++) s += 1; return s }\nexport const run = (n) => f(new Int8Array(3)) + f(new Int8Array(3), 0) * 100 + n`, [0]],
  ])
  const w = jz.compile(`class V { constructor() { this.x = 1; this.y = 2 } toArray(array = [], offset = 0) { array[offset] = this.x; array[offset + 1] = this.y; return array } }\nexport const run = () => { const a = new Float32Array(4); new V().toArray(a, 2); return a[2] * 10 + a[3] }`, { wat: true, optimize: 'speed' })
  is((w.match(/__arr_set_idx_ptr/g) || []).length, 0, 'a typed array every caller passes is stored as a typed array')
})

// A class factory takes its initializer's defaults (jzify/classes.js
// lowerStruct): an argument `new C()` or `new this.constructor()` leaves out
// arrives as the default's value, never as an undefined the initializer's
// own default would replace in a kind that keeps it. The fields then hold
// the default's kind alone, with no nullish value to test for.
test('param defaults: a constructor argument left out arrives as the default, not as undefined', () => {
  const src = `class V { constructor(x = 0) { this.x = x } }
    class B { constructor(min = new V(3), max = new V(4)) { this.min = min; this.max = max } clone() { return new this.constructor() } sum() { return this.min.x + this.max.x } }
    export const run = () => { const c = new B().clone(); return c.sum() * 10 + new B(new V(1)).sum() }`
  agree([['left out', src, []]])
  const w = jz.compile(src, { wat: true, optimize: 2 })
  is((w.match(/__throw_property_nullish/g) || []).length, 0, 'the fields are read as objects, never tested for a nullish value')
})
