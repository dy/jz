// A shared body that reads a property or element of a parameter of several kinds is the
// dispatch over those kinds wherever it is copied, unless the site gives the parameter one
// kind (src/compile/plan/inline.js keepsDispatch). A site whose argument is of several kinds
// keeps the call; a site of one kind still splices, where the copy resolves.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { agree, wat } from './util.js'
import { belowOpt } from './_matrix.js'

const calls = (src, callee) => (wat(src, { optimize: 'speed' }).match(new RegExp(`call \\$${callee}\\b`, 'g')) || []).length

// a parser's work stack: tokens (strings) and nested lists (arrays) through the same helpers
const mixed = `const isId = n => n?.[0] === '$'
const top = (stk, back = 0) => stk[stk.length - 1 - back]
export let f = (toks) => {
  const stk = toks.slice().reverse()
  let ids = 0, other = 0
  while (stk.length) {
    const t = stk.pop()
    if (isId(t)) ids++
    else if (Array.isArray(t)) { for (let j = t.length - 1; j >= 0; j--) stk.push(t[j]); if (isId(top(stk))) ids += 10 }
    else if (isId(top(stk, 0))) ids += 100
    else other++
  }
  return ids * 1000 + other
}`

test('inline dispatch: a site passing several kinds keeps the call', () => {
  if (!belowOpt(2)) {
    ok(calls(mixed, 'isId') >= 3, 'isId stays a function its sites call')
    ok(calls(mixed, 'top') >= 2, 'top stays a function its sites call')
  }
  agree(mixed, 'f', [[]])
  agree(mixed, 'f', [['$a', 'b', ['$c', ['d', '$e'], 'f'], 'g', '$h']])
  agree(mixed, 'f', [[['$x'], [['$y', 'z']], 'w']])
})

test('inline dispatch: sites of one kind each still splice', () => {
  const src = `const first = n => n[0] === '$'
export let f = (n) => {
  const a = ['$a', 'b'], s = '$s'
  let k = 0
  for (let i = 0; i < n; i++) { if (first(a)) k++; if (first(s)) k += 2 }
  return k
}`
  if (!belowOpt(2)) is(calls(src, 'first'), 0, 'first splices at both sites')
  for (const n of [0, 1, 5]) agree(src, 'f', [n])
})
