// A number literal added to a value that may be a string (`x + 1`, `0.25 + x`)
// concatenates as its digits, taken at compile time: String(C) in the host is
// JS's Number::toString (-0 is "0", 1e21 "1e+21"), so no run-time formatting
// joins the module for it (src/compile/emit/arithmetic.js `+`, src/ir/coerce.js
// toStrI64). Beside a Number, a side no object or BigInt reaches adds as its
// number without ToPrimitive (module/core.js __add_atoms); one that may be an
// object keeps the run-time `+`, whose concatenation the digits then share.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { levels } from './_matrix.js'
import { oracle, wat, jz, compile } from './util.js'

const res = (f) => { try { return f() } catch (e) { return 'throws ' + e.constructor.name } }
// every export of `src`, called with `args`, answers what Node answers
const agrees = (src, args = []) => {
  for (const optimize of levels(0, 'size', 2, 3)) {
    const js = oracle(src), m = jz(src, { optimize }).exports
    for (const name of Object.keys(js)) {
      const a = res(() => js[name](...args)), b = res(() => m[name](...args))
      ok(Object.is(a, b), `${name}(${args.join(', ')}) at ${optimize}: ${b} for ${a}`)
    }
  }
}
const linked = (src, optimize, name) => new RegExp(`\\(func \\$${name}\\b`).test(wat(src, { optimize }))

// numbers, a string, a boolean, null, holes and a string past them; each slot read back at a fixed index
const MK = `const mk = () => { const a = [0, 1, 2, 3]; a[2] = 'payload'; a.push(true, null); a[8] = 'tail'; return a }`
const each = (expr, mk = MK) => mk + `
const run = () => { const a = mk(); for (let j = 0; j < a.length; j++) a[j] = ${expr}; return a }
${[0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => `export let at${i} = () => run()[${i}]`).join('\n')}`

test('literal digits: a number literal beside a value that may be a string formats nothing at run time', () => {
  for (const expr of ['a[j] + 1', 'a[j] + 1.5', '0.25 + a[j]', 'a[j] + 1e21', 'a[j] + 0.30000000000000004', 'a[j] + -0', 'a[j] + 5e-324']) {
    const src = each(expr)
    agrees(src)
    for (const optimize of levels('size', 2, 3)) {
      ok(!linked(src, optimize, '__to_str'), `${expr}: no Number::toString at ${optimize}`)
      ok(!linked(src, optimize, '__add_slow'), `${expr}: no run-time + at ${optimize}`)
    }
  }
})

test('literal digits: a string builder appends a fraction literal as its digits', () => {
  const src = `export let f = (n) => { let s = 'x'; for (let i = 0; i < n; i++) s = s + 1.5; return s }`
  agrees(src, [0])
  agrees(src, [3])
  for (const optimize of levels('size', 2, 3)) ok(!linked(src, optimize, '__to_str'), `no Number::toString at ${optimize}`)
})

test('literal digits: a value that may be an object keeps ToPrimitive', () => {
  const mk = `const mk = () => { const a = [0, 1, 2, 3]; a[1] = { v: 1 }; a[2] = 'payload'; return a }`
  const src = each('a[j] + 1', mk)
  agrees(src)
  // the run-time + reaches the general concatenation: the size tier links no
  // twin of it for the digits (src/wat/assemble/stdlib-pull.js collapseTwins),
  // so they cost what a Number that is no literal costs beside the value
  for (const optimize of levels('size')) {
    const digits = compile(src, { optimize }).length, number = compile(each('a[j] + a.length', mk), { optimize }).length
    ok(digits <= number + 16, `one concatenation body at ${optimize}: ${digits} B against ${number} B`)
  }
  agrees(each('0.5 + a[j]', `const mk = () => { const a = [0, 1, 2, 3]; a[1] = { valueOf() { return 41 } }; a[2] = 'payload'; a[3] = { toString() { return 'w' } }; return a }`))
})
