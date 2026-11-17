// A statement that reads an element or a member, on every path through it,
// through a receiver the summary holds only undefined or null always throws:
// what follows it in its list never runs (summary/index.js missingReads, ast.js
// onEveryPath). The summary walks none of it and the emitter ends the list with
// a trap after the statement (compile/emit/dispatch.js emitBlockBody), so the
// bindings the rest declares, which no value reaches, compile to nothing.
// Each row answers what Node answers, the effects before the read included;
// the optional forms, a read under a condition, a `try` whose catch runs what
// follows, a `finally`, a receiver missing on one path only all run on.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { levels } from './_matrix.js'
import { oracle, run, wat } from './util.js'

const rows = {
  read: `(a, i) => { let s = 0; if (a == null) { note('a'); s = a[i]; note('b'); s = s + 'x' } else s = a[i]; return s }`,
  member: `(a, i) => { let s = 0; if (a == null) { note('a'); s = a.length; note('b'); s = s + 'x' } else s = a.length + i; return s }`,
  optional: `(a, i) => { let s = 0; if (a == null) { s = a?.[i]; note('a'); s = (a ?? [7, 8])[i]; note('b') } return s }`,
  guarded: `(a, i) => { let s = 0; if (a == null) { if (i > 5) s = a[i]; note('a'); i > 6 && (s = a[i]); note('b') } return s }`,
  caught: `(a, i) => { let s = 0; if (a == null) { try { s = a[i]; note('a') } catch (e) { note('b') } note('c') } return s }`,
  onePath: `(a, i) => { const b = i > 0 ? a : [5, 6]; const s = b[0]; note('a'); return s }`,
  callFirst: `(a, i) => { let s = 0; if (a == null) { s = note('a') + a[i]; note('b') } return s }`,
  fin: `(a, i) => { let s = 0; if (a == null) { try { s = a[i]; note('a') } finally { note('b') } note('c') } return s }`,
  early: `(a, i) => { if (a != null) return a[i] * 2; note('a'); const s = a[i]; note('b'); return s + 1 }`,
  loop: `(a, i) => { let y = i; if (a != null) { for (let j = 0; j < 3; j++) y = y * 0.5 + a[j] } else { for (let j = 0; j < i; j++) { const v = a[j]; note('a'); y = y * 0.5 + v } note('b') } return y }`,
}
const src = `let log = ''
const note = (c) => { log += c; return 1 }
const hold = (k) => k > 0 ? [k, k + 1, k + 2] : k < 0 ? undefined : null
${Object.entries(rows).map(([name, f]) => `const ${name}_ = ${f}
export let ${name} = (k, i) => { log = ''; let r; try { r = String(${name}_(hold(k), i)) } catch (e) { r = e instanceof TypeError ? 'TypeError' : 'other' } return r + '|' + log }`).join('\n')}`

test('throwing read: a statement that reads through a receiver only missing ends its list, as Node', () => {
  const host = oracle(src)
  for (const optimize of levels(0, 2, 3, 'size')) {
    const m = run(src, { optimize })
    for (const name of Object.keys(rows)) for (const k of [1, 0, -1]) for (const i of [0, 1, 7])
      is(m[name](k, i), host[name](k, i), `${name}(${k}, ${i}) at ${optimize}`)
  }
})

// The rest of the list after the read declares a binding no value reaches:
// compiled, its `+` and its element read were the generic forms (the runtime's
// `__add_slow`, a string concatenation, a dynamic read), linked for code that
// never runs.
const tail = `const pick = (state, j, x) => {
  if (state != null) { const s = state[j]; return x * 0.5 + s[0] }
  const s = state[j]
  return x * 0.5 + s[0]
}
export let f = (k, j, x) => pick(k > 0 ? [[1], [2], [3], [4]] : null, j | 0, +x)`

test('throwing read: what follows the read is not compiled', () => {
  const host = oracle(tail)
  for (const optimize of levels(0, 2, 3, 'size')) {
    const m = run(tail, { optimize })
    for (const [k, j] of [[1, 2], [0, 1], [1, 9]]) is((() => { try { return m.f(k, j, 3) } catch (e) { return e.constructor.name } })(),
      (() => { try { return host.f(k, j, 3) } catch (e) { return e.constructor.name } })(), `f(${k}, ${j}) at ${optimize}`)
    const text = wat(tail, { optimize })
    ok(!/\(func \$__(add_slow|str_concat_fresh|dyn_get)/.test(text), `at ${optimize}: no generic + or dynamic read linked`)
  }
})
