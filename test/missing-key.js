// A key that may be missing: `a[k]` where `k` is a Number or undefined, as the
// element of an index array is wherever the summary cannot hold its read
// inside the length or the array free of holes (`a[idx[i]]` under a count the
// compiler does not tie to `idx`, or with `idx` made by `new Array(n)`). Such
// a key names an element, or the property "undefined" or "null": a stored
// entry, never the length nor a method. So
//   - the read's kind is the elements' beside "missing", in the summary's
//     query as in its solver (summary/query.js entryOf restated the rule
//     without that case and answered a Number or a function besides, so `s +=
//     a[idx[i]]` tested its operand for a string at every element); a key that
//     is only missing in the round that walks it joins the same.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { ctx } from '../src/ctx.js'
import { K, hasTag } from '../src/summary/index.js'
import { levels } from './_matrix.js'
import { oracle, run, compileInProcess as compile } from './util.js'

// How the index array and the values are made.
const FORMS = {
  push: (x, v, n) => `const ${x} = []; for (let i = 0; i < ${n}; i++) ${x}.push(${v})`,
  index: (x, v, n) => `const ${x} = []; for (let i = 0; i < ${n}; i++) ${x}[i] = ${v}`,
  counted: (x, v, n) => `const ${x} = new Array(${n}); for (let i = 0; i < ${n}; i++) ${x}[i] = ${v}`,
  ownLength: (x, v, n) => `const ${x} = new Array(${n}); for (let i = 0; i < ${x}.length; i++) ${x}[i] = ${v}`,
  fill: (x, v, n) => `const ${x} = new Array(${n}).fill(0); for (let i = 0; i < ${n}; i++) ${x}[i] = ${v}`,
  from: (x, v, n) => `const ${x} = Array.from({ length: ${n} }, (_, i) => ${v})`,
  map: (x, v, n) => `const ${x} = new Array(${n}).fill(0).map((_, i) => ${v})`,
  spread: (x, v, n) => `const ${x}0 = []; for (let i = 0; i < ${n}; i++) ${x}0.push(${v}); const ${x} = [...${x}0]`,
}
// The gather, a second reader (a helper with one site is spliced whatever it is), a read past the
// count, and the two properties a missing key names. (The count is no bare key: an exported
// function's parameter that reaches one is of no known kind, and `new Array(n)` of it holds anything.)
const READERS = (count) => `export let gather = () => { let s = 0; for (let i = 0; i < ${count}; i++) s += a[idx[i]]; return s }
export let back = () => { let s = 0; for (let i = 0; i < ${count}; i++) s += a[idx[${count} - 1 - i]] * 2; return s }
export let past = (m) => { let s = 0, u = 0; for (let i = 0; i < m; i++) { const v = a[idx[i]]; if (v === undefined) u++; else s += v } return s * 100 + u }
export let named = () => { const b = a.slice(); b[undefined] = 7; b[null] = 9; return [b[idx[${count} + 1]], b[null], b[idx[0]], b.length].join() }`
// Arrays a function builds to a count the caller gives, held in the module's bindings.
const built = (form) => `const make = (n) => { ${FORMS[form]('idx', '(i * 37 + 11) % n', 'n')}; return idx }
const vals = (n) => { ${FORMS[form]('a', 'i * 0.5', 'n')}; return a }
let idx = make(4), a = vals(4), count = 4
export let init = (n) => { count = n; idx = make(n); a = vals(n); return 0 }
${READERS('count')}`
// The module's own, built to a count a name holds.
const own = (form) => `const N = 64
${FORMS[form]('idx', '(i * 37 + 11) % N', 'N')}
${FORMS[form]('a', 'i * 0.5', 'N')}
export let init = (n) => 0
${READERS('N')}`
const HOLDERS = { built, own }

test('missing key: the gather through every form of index array answers as Node', () => {
  for (const [holder, program] of Object.entries(HOLDERS)) for (const form of Object.keys(FORMS)) {
    const src = program(form), want = oracle(src)
    const calls = (m) => [m.init(64), m.gather(), m.back(), m.past(70), m.past(0), m.named(), m.init(16), m.gather(), m.past(20)].map(String).join(' ')
    const expected = calls(want)
    for (const optimize of levels(0, 2, 3, 'speed', 'size')) is(calls(run(src, { optimize })), expected, `${form}, ${holder}, at ${optimize}`)
  }
})

// The read's kind, and the sum's it is added to (a method or a string joined in a round stays in the sum).
const kinds = (src, optimize) => {
  compile(src, { optimize })
  const fn = ctx.funcs.list.find(f => f.name === 'gather'), view = ctx.summary.at(fn.body), out = { reads: [], sums: [] }
  const walk = (n) => {
    if (!Array.isArray(n)) return
    if (n[0] === '[]' && n.length === 3 && typeof n[1] === 'string' && typeof n[2] !== 'string') out.reads.push(view.kindOfExpr(n))
    if (n[0] === 'return') out.sums.push(view.kindOfExpr(n[1]))
    for (let i = 1; i < n.length; i++) walk(n[i])
  }
  walk(fn.body)
  return out
}
const numberOrNothing = (k) => hasTag(k, K.NUMBER) && !hasTag(k, K.CLOSURE) && !hasTag(k, K.STRING)
test('missing key: the read answers the elements\' kind, never a method or the length', () => {
  for (const [holder, program] of Object.entries(HOLDERS)) for (const form of Object.keys(FORMS)) for (const optimize of [0, 2]) {
    const { reads, sums } = kinds(program(form), optimize)
    ok(reads.length >= 1 && reads.every(numberOrNothing), `${form}, ${holder}, at ${optimize}: a Number or nothing`)
    ok(sums.length >= 1 && sums.every(k => numberOrNothing(k) && !hasTag(k, K.ABSENT)), `${form}, ${holder}, at ${optimize}: the sum a Number`)
  }
  // a key that is only missing
  const { reads } = kinds(`const t = [1.5, 2.5, 3.5]\nexport let gather = () => { let u; const v = t[(u, u)]; return v === undefined ? 1 : 0 }`, 0)
  ok(reads.length === 1 && !hasTag(reads[0], K.CLOSURE), 'a key only missing names no method')
})
