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
