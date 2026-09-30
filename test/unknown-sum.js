// A sum with a side the program cannot type (a host object's field, an
// element of a host array, a method's result) may be a string, and the `+`
// emitter concatenates it at run time. Its type used to be the optimistic
// NUMBER all the same, so the next `+` or `*` ran f64 arithmetic on the
// string's box: `o.name + 1 + 2` gave 'x1', `(o.name + 1) * 1` gave 'x1'
// instead of NaN. Such a sum is a number only where the program cannot
// concatenate (kind/val-type-of.js addsAsNumber); a numeric export parameter
// keeps its contract.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { levels, belowOpt, onWasi } from './_matrix.js'
import { oracle } from './util.js'

const show = (v) => JSON.stringify(v, (k, x) => x === undefined ? '<undefined>' : x)
const hostObject = (v) => v !== null && typeof v === 'object'
const agree = (cases) => {
  for (const [name, src, ...args] of cases) for (const optimize of levels(0, 2, 3)) {
    if (onWasi() && args.some(hostObject)) continue   // the hostless WASI boundary passes no object in
    is(show(jz(src, { optimize }).exports.f(...args)), show(oracle(src).f(...args)), `${name} O${optimize}`)
  }
}

test('unknown sum: a sum that may be a string stays one', () => agree([
  ['a host field', `export let f = (o) => o.name + 1 + 2`, { name: 'x' }],
  ['a product after it', `export let f = (o) => (o.name + 1) * 1`, { name: 'x' }],
  ['through a binding', `export let f = (o) => { let s = o.name + 1; return s + 2 }`, { name: 'x' }],
  ['a number field', `export let f = (o) => o.n + 1 + 2`, { n: 5 }],
  ['a dictionary', `export let f = (k) => { let r = {}; r[k] = 1; r.a = 1; r.c = 3; return Object.keys(r).join() + r.a + r.c }`, 'b'],
  ['a join', `export let f = (a) => a.join() + 1 + 2`, [1, 2]],
  ['a join through a binding', `export let f = (a) => { let x = a.join(); return x + 1 + 2 }`, [1, 2]],
  ['module values', `let g = (o) => o.name + 1 + 2\nexport let f = (c) => g(c ? { name: 'x' } : { name: 3 })`, 1],
  ['module values, a number', `let g = (o) => o.name + 1 + 2\nexport let f = (c) => g(c ? { name: 'x' } : { name: 3 })`, 0],
]))

test('unknown sum: a numeric export parameter still adds as a number', () => {
  const src = `export let f = (x) => x + 1 + 2`
  for (const optimize of levels(0, 2, 3)) is(jz(src, { optimize }).exports.f(5), 8, `O${optimize}`)
  if (belowOpt(2)) return
  ok(!/\$__is_str_key/.test(compile(src, { wat: true })), 'no run-time string test')
})
