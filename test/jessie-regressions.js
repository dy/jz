// Regression tests for jz blockers surfaced while compiling subscript/jessie.
// Each block maps to a numbered finding in .work/jessie-wasm.md; failures here
// mean a previously-fixed gap has reopened.
//
//   #1  spread in optional call `fn?.(...args)`
//   #2  built-in Error subclasses (SyntaxError, TypeError, …)
//   #4  `delete obj[k]` on computed keys (runtime shadow-store + schema clear)
//   #5  bare side-effect imports `import './x.js'` + nested-module prefix
//        stacking (parent re-mangling a sub-module's prefixed func to
//        `parent$sub$name`)
//   #6  `new RegExp(literal)` and clean error for dynamic
//   #7  `Object.create` includes the `array` stdlib module
//   #8  computed object keys `{[k]: v}` — see test262-regressions.js
//        (test262-shaped repro lives there; this file only tracks the jessie path)
//   #A  IIFE arrow whose body produces a sparse-array literal
//   #B  `throw` inside an unused/uncalled function declaration
//   #C  plan.js inliner discarding an expression-bodied arrow's value when the
//        whole body is a single candidate call (`() => candidate()`)
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

// Nested imports must not stack prefixes. When module A imports module B and
// both have specifiers without `__`, the older "sub-import" heuristic
// (`func.name.includes('__') && includes('$')`) misclassified B's already-
// prefixed funcs as A-owned and re-mangled them to `A$B$name`. Resulting WAT
// referenced names that didn't exist. Funcs are now tagged with their owning
// module's prefix instead.
test('#5 nested module imports do not stack prefixes', () => {
  const { exports } = jz(
    `import './a.js'; import { f } from './a.js'; export let g = () => f()`,
    { modules: {
      './a.js': `import { x } from './b.js'; export let f = () => x()`,
      './b.js': `export let x = () => 42`,
    } }
  )
  is(exports.g(), 42)
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

// ── #A  sparse-array literal inside IIFE arrow ──────────────────────────────
// `(p => [, ''])([1])`  — subscript/jessie emits the JZ_NULL Symbol sentinel
// for the leading hole. When the IIFE callee is an arrow expression, callee
// dispatch indexed `ctx.core.emit[callee]` which stringified the array node and
// hit the sentinel: "Cannot convert a Symbol value to a string". The callee
// lookup now requires `typeof callee === 'string'` before indexing.

test('#A IIFE arrow returning sparse array literal compiles and materializes holes as null', () => {
  const { f } = run(`export let f = () => (p => [, ''])([1])`)
  const r = f()
  is(r.length, 2)
  is(r[0], null)
  is(r[1], '')
})

// ── #B  throw inside an unused arrow leaves dangling __jz_last_err_bits ─────
// `ensureThrowRuntime` declares the global and pushes its export into
// `sec.tags`. Treeshake's dead-global pass walked `sec.start/elem/customs/...`
// but not `sec.tags`, so when the function carrying the throw was itself dead
// the only `global.set` was pruned and the global got eliminated — while its
// export tag still referenced it. Now treeshake sees `sec.tags`.

test('#B throw inside an unused arrow does not break codegen', () => {
  const wasm = compile(`const err = () => { throw 1 }; export let f = () => 1`)
  ok(wasm instanceof Uint8Array)
})

test('#B throw declares + exports __jz_last_err_bits even when carrier is dead', () => {
  const wat = compile(`const err = () => { throw 1 }; export let f = () => 1`, { wat: true })
  ok(wat.includes('(global $__jz_last_err_bits'), 'last-err global declared')
  ok(wat.includes('(export "__jz_last_err_bits"'), 'last-err global exported')
})

// ── #4  delete obj[k] on computed key ───────────────────────────────────────
// jessie's `delete ctx[k]` pattern. Static `delete obj.x` / `delete obj["x"]`
// remains rejected (would change a fixed-shape slot's structural type). Only
// computed-key deletes lower to runtime `__dyn_del`, which removes from the
// per-object shadow property store AND clears a matching schema slot to
// UNDEF_NAN so subsequent reads see "absent".

test('#4 delete: computed key removes a dynamically-added property', () => {
  const { f } = run(`export let f = () => {
    let ctx = {a: 1}
    ctx['c'] = 99
    delete ctx['c']
    return ctx['c']
  }`)
  is(f(), undefined)
})

test('#4 delete: computed key clears a matching schema slot', () => {
  const { f } = run(`export let f = (k) => {
    let ctx = {a: 1, b: 2}
    delete ctx[k]
    return ctx[k]
  }`)
  is(f('a'), undefined)
})

test('#4 delete: leaves other keys intact', () => {
  const { f } = run(`export let f = (k) => {
    let ctx = {a: 1, b: 2}
    delete ctx[k]
    return ctx['b']
  }`)
  is(f('a'), 2)
})

test('#4 delete: literal-key form still rejected (fixed schema)', () => {
  let err
  try { compile(`export let f = () => { let o = {x: 1}; delete o.x; return o.x }`) }
  catch (e) { err = e }
  ok(err && /object shape is fixed/.test(err.message),
    `static delete should remain prohibited; got: ${err?.message?.slice(0, 80)}`)
})

// ── #C  inliner on expression-bodied arrow ─────────────────────────────────
// plan.js's `inlineHotInternalCalls` walks every non-exported function body
// and passes it to `inlineInStmt`. For a block-bodied function that's right
// — statement-position calls discard their return value. For an *expression*-
// bodied arrow (`func.body = ['()', 'candidate']`, no `{}` block), the same
// path silently dropped the value: the body became `['{}', [';']]` (empty
// block), and any caller relying on the result observed `0`/`undefined`. The
// jessie tokenizer surfaces this through closure-factory wrappers like
// `let mk = () => makeToken(...)` that the wider parser then invokes.
//
// Fix: dispatch on body shape — if `func.body[0] !== '{}'`, route through
// `inlineInExpr` so the inlined value replaces the call expression.
// Repro must keep the candidate non-exported and the wrapper non-exported, so
// the inliner's `func.exported` skip doesn't mask the bug.

test('#C inliner preserves return value of an expr-bodied arrow whose entire body is a candidate call', () => {
  const { entry } = jz(`
    let leaf = () => 42
    let mid = () => leaf()
    export let entry = () => mid()
  `).exports
  is(entry(), 42)
})

test('#C inliner: expr-bodied arrow with arg-forwarding candidate', () => {
  const { entry } = jz(`
    let twice = (n) => n * 2
    let wrap = (n) => twice(n)
    export let entry = (n) => wrap(n)
  `).exports
  is(entry(21), 42)
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
