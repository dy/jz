// A `+` over a value of string kind that may be missing: a hole of a string
// array, an index past its end or a string's, a Map's miss, a field a shape
// lacks. The element or slot kind names what was stored; the read may still
// answer undefined, which adds to anything but a string as NaN. The sum is a
// string only beside a string that is there (kind/val-type-of.js
// stringMayMiss), and every consumer of the sum reads it so: a concatenation
// chain around it, a template, String(), `.length`, `+=`, console.log.
// References: ECMA-262 13.15.3 ApplyStringOrNumericBinaryOperator (a string
// operand after ToPrimitive concatenates, else both convert ToNumeric),
// 7.1.4 ToNumber (undefined is NaN), 7.1.17 ToString (undefined is
// "undefined"). The expected values are Node's (util.js oracle).
import test from 'tst'
import { is } from 'tst/assert.js'
import { levels } from './_matrix.js'
import { run, oracle } from './util.js'

const show = v => typeof v === 'number' && isNaN(v) ? 'NaN' : typeof v + ':' + String(v)

// Where the value comes from: `v` may be missing (k = 1, or always), `w` is a present string.
const SRC = {
  hole: { pre: `const a = ['a', , 'c']`, v: 'a[1]', w: 'a[0]' },
  holeAt: { pre: `const a = ['a', , 'c']`, v: 'a[k]', w: 'a[0]' },
  pastEnd: { pre: `const a = ['a', 'b']`, v: 'a[k + 4]', w: 'a[0]' },
  newArray: { pre: `const a = new Array(3); a[0] = 'a'; a[2] = 'c'`, v: 'a[1]', w: 'a[0]' },
  grown: { pre: `const a = ['a']; a.length = 3`, v: 'a[2]', w: 'a[0]' },
  sparse: { pre: `const a = ['a']; a[3] = 'd'`, v: 'a[2]', w: 'a[0]' },
  split: { pre: `const parts = 'a,b'.split(',')`, v: 'parts[k + 4]', w: 'parts[0]' },
  json: { pre: `const a = JSON.parse('["a"]')`, v: 'a[3]', w: 'a[0]' },
  charPastEnd: { pre: `const str = 'ab'`, v: 'str[k + 4]', w: 'str[0]' },
  field: { pre: `const mk = (k) => k ? { t: 1 } : { s: 'a', t: 1 }`, v: 'mk(k).s', w: `'a'` },
  map: { pre: `const m = new Map([[0, 'a']])`, v: 'm.get(k)', w: 'm.get(0)' },
  numberHole: { pre: `const a = [1, , 3]`, v: 'a[1]', w: `'x'` },
}
// What each export makes of the sum.
const OPS = {
  twice: v => `${v} + ${v}`,
  left: v => `${v} + 'x'`,
  right: v => `'x' + ${v}`,
  number: v => `${v} + 1`,
  sumThenString: v => `(${v} + ${v}) + ''`,
  stringThenSum: v => `'' + (${v} + ${v})`,
  chain: v => `${v} + ${v} + 'z'`,
  numberChain: v => `${v} + 1 + 'z'`,
  presentFirst: (v, w) => `${w} + ${v} + ${v}`,
  template: v => '`<${' + v + ' + ' + v + '}>`',
  toString: v => `String(${v} + ${v})`,
  length: v => `{ const s = ${v} + ${v}; return s.length }`,
  type: v => `typeof (${v} + ${v})`,
  accumulate: v => `{ let s = ${v}; s += ${v}; s += ''; return s }`,
}
const program = (s) => `${s.pre}\n` + Object.entries(OPS).map(([name, op]) => `export let ${name} = (k) => ${op(s.v, s.w)}`).join('\n')

for (const optimize of levels(0, 1, 2, 3, 'size'))
  for (const [sn, s] of Object.entries(SRC))
    test(`missing plus: ${sn} adds as JavaScript does at ${optimize}`, () => {
      const src = program(s), want = oracle(src), got = run(src, { optimize })
      for (const name of Object.keys(OPS)) for (const k of [0, 1])
        is(show(got[name](k)), show(want[name](k)), `${sn} ${name}(${k}) at ${optimize}`)
    })

// A for-of visits a hole as undefined (23.1.5.1 CreateArrayIterator reads
// every index below the length), and a spread copies it so.
const ITERATE = `export let sum = () => { const a = ['a', , 'c']; let o = ''; for (const x of a) o += x + x; return o }
export let type = () => { const a = ['a', , 'c']; let o = ''; for (const x of a) o += typeof x; return o }
export let spread = () => { const a = ['a', , 'c']; return [...a].map(x => x + 1).join() }
export let numbers = () => { const a = [1, , 3]; let o = 0; for (const x of a) o += x; return o }`
for (const optimize of levels(0, 1, 2, 3, 'size'))
  test(`missing plus: a hole a for-of or a spread visits adds as undefined at ${optimize}`, () => {
    const want = oracle(ITERATE), got = run(ITERATE, { optimize })
    for (const name of Object.keys(want)) is(show(got[name]()), show(want[name]()), `${name} at ${optimize}`)
  })
