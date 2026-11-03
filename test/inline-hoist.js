// A call to a block-bodied function inside an expression moves to a
// declaration of its own just before its statement, and splices there; a
// conditional holding one (`p && f(n)`, `p || f(n)`, `p ? f(n) : 9`) moves as
// an `if` (src/compile/plan/inline.js hoistNestedCalls). Several declarators
// are as many declarations in order: a later one may read an earlier one's
// name, so what it hoists goes just before it, not ahead of the statement
// (the speed tier read `p` before `const p = ...` had set it). Every value is
// a differential against the host.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { levels } from './_matrix.js'
import { run, oracle, wat } from './util.js'

const F = `const f = (n) => { if (n > 2) return 0; return n * 3 }\n`
const CASES = {
  and: `export let run = (n) => { const p = n > 0 ? 7 : 0, e = p && f(n); return e }`,
  or: `export let run = (n) => { const p = n > 1 ? 0 : 5, e = p || f(n); return e }`,
  tern: `export let run = (n) => { const p = n > 0 ? 1 : 0, e = p ? f(n) : 9; return e }`,
  arg: `export let run = (n) => { const p = n * 2, e = 1 + f(p); return e }`,
  let: `export let run = (n) => { let p = n - 1, e = 2 * f(p); return e }`,
  three: `export let run = (n) => { const a = n + 1, b = a * 2, c = 1 + f(b - a); return c }`,
  object: `const parts = (n) => n > 0 ? { k: n } : null
export let run = (n) => { const p = parts(n), e = p && f(n); return String(e) }`,
  module: `const p = 2, e = 1 + f(p)\nexport let run = (n) => e + n`,
}

for (const optimize of levels(0, 1, 2, 3, 'size'))
  test(`inline hoist: a later declarator reads an earlier one at ${optimize}`, () => {
    for (const [name, body] of Object.entries(CASES)) {
      const src = F + body, want = oracle(src).run, got = run(src, { optimize }).run
      for (const n of [0, 1, 2, 3]) is(got(n), want(n), `${name} run(${n}) at ${optimize}`)
    }
  })

test('inline hoist: a call in a later declarator still splices at speed', () => {
  for (const name of ['and', 'arg', 'module'])
    ok(!/call \$f\b/.test(wat(F + CASES[name], { optimize: 'speed' })), `${name}: no call to f`)
})
