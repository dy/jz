// Regression tests for jz blockers surfaced while compiling subscript/jessie.
// Each block maps to a numbered finding in .work/jessie-wasm.md; failures here
// mean a previously-fixed gap has reopened.
//
//   #1  spread in optional call `fn?.(...args)`
//   #2  built-in Error subclasses (SyntaxError, TypeError, …)
//   #5  bare side-effect imports `import './x.js'`
//   #6  `new RegExp(literal)` and clean error for dynamic
//   #7  `Object.create` includes the `array` stdlib module
//   #8  computed object keys `{[k]: v}` — see test262-regressions.js
//        (test262-shaped repro lives there; this file only tracks the jessie path)
//   error-wrap  watr's "Unknown ..." identifier errors translated to jz wording

import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { run } from './util.js'

// ── #1  spread in optional call ─────────────────────────────────────────────

test('#1 ?.(): spread args on non-null callable', () => {
  const { f } = jz(`export let f = () => {
    let add = (a, b, c) => a + b + c
    let args = [10, 20, 30]
    return add?.(...args)
  }`).exports
  is(f(), 60)
})

test('#1 ?.(): spread args on null short-circuits', () => {
  const { f } = jz(`export let f = (n) => {
    let add = (a, b, c) => a + b + c
    let fn = n > 0 ? add : null
    let args = [1, 2, 3]
    return fn?.(...args)
  }`).exports
  is(f(1), 6)
  is(f(0), undefined)
})

test('#1 ?.(): mixed positional + spread args', () => {
  const { f } = jz(`export let f = () => {
    let sum4 = (a, b, c, d) => a + b + c + d
    let tail = [3, 4]
    return sum4?.(1, 2, ...tail)
  }`).exports
  is(f(), 10)
})

// ── #2  built-in Error subclasses ───────────────────────────────────────────

for (const cls of ['SyntaxError', 'TypeError', 'RangeError', 'ReferenceError', 'URIError', 'EvalError']) {
  test(`#2 ${cls}(): throw new ${cls} surfaces message`, () => {
    let error
    try { jz(`export let f = () => { throw new ${cls}("bad ${cls}") }`).exports.f() }
    catch (caught) { error = caught }
    ok(error instanceof Error)
    is(error.message, `bad ${cls}`)
  })

  test(`#2 ${cls}(): throw ${cls}() (no new) surfaces message`, () => {
    let error
    try { jz(`export let f = () => { throw ${cls}("bare ${cls}") }`).exports.f() }
    catch (caught) { error = caught }
    ok(error instanceof Error)
    is(error.message, `bare ${cls}`)
  })
}

test('#2 Error subclasses: try/catch with throw new TypeError', () => {
  is(run(`export let f = (x) => {
    try { if (x < 0) throw new TypeError("neg"); return x }
    catch (e) { return -1 }
  }`).f(-5), -1)
})

// ── #5  bare side-effect imports ────────────────────────────────────────────

test('#5 import: bare side-effect (no `from`) compiles', () => {
  const { exports } = jz(
    `import './sub.js'; export let f = () => 1`,
    { modules: { './sub.js': 'export const x = 1' } }
  )
  is(exports.f(), 1)
})

test('#5 import: bare side-effect runs module init', () => {
  const { exports } = jz(
    `import './counter.js'; import { count } from './counter.js'; export let f = () => count`,
    { modules: { './counter.js': 'export let count = 0; count = 42' } }
  )
  is(exports.f(), 42)
})

// ── #6  new RegExp(literal) ─────────────────────────────────────────────────

test('#6 regex: new RegExp() with literal pattern', () => {
  const r = jz(`export let f = (s) => { let re = new RegExp("[a-z]+"); return re.test(s) }`)
  const m = r.memory
  is(r.exports.f(m.String('abc')), 1)
  is(r.exports.f(m.String('123')), 0)
})

test('#6 regex: new RegExp() with literal flags', () => {
  const r = jz(`export let f = (s) => { let re = new RegExp("foo", "i"); return re.test(s) }`)
  const m = r.memory
  is(r.exports.f(m.String('FOO')), 1)
  is(r.exports.f(m.String('BAR')), 0)
})

test('#6 regex: new RegExp(dynamic) errors clearly', () => {
  throws(
    () => jz(`export let f = (s) => { let re = new RegExp(s); return re.test("abc") }`),
    /string-literal pattern|dynamic regex/i
  )
})

// ── #7  Object.create pulls in array stdlib ─────────────────────────────────

test('#7 Object.create(null) compiles', () => {
  const { f } = run(`export let f = () => { let o = Object.create(null); return 42 }`)
  is(f(), 42)
})

test('#7 Object.create with schema-typed proto copies properties', () => {
  const { f } = run(`export let f = () => {
    let proto = { x: 1, y: 2 }
    let o = Object.create(proto)
    return o.x + o.y
  }`)
  is(f(), 3)
})

test('#7 Object.create with array proto clones data', () => {
  // watr pattern: ctx.local = Object.create(param)
  const { f } = run(`export let f = () => {
    let arr = [10, 20, 30]
    let copy = Object.create(arr)
    return copy[0] + copy[1] + copy[2]
  }`)
  is(f(), 60)
})

// ── error-wrap  watr "Unknown ..." errors translated to jz wording ──────────

test('error-wrap: unknown global references surface as a clean jz error, not watr "Unknown ..."', () => {
  let err
  try { compile(`export let f = () => SomethingUndefined()`) }
  catch (e) { err = e }
  ok(err, 'compile should fail')
  ok(!/Unknown (local|func|global)/.test(err.message),
    `watr-shaped error leaked: ${err.message.slice(0, 120)}`)
})
