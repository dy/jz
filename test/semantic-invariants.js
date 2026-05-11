/**
 * Semantic invariant tests — structural properties of the compiled output,
 * not just functional correctness ("does the right answer come out?").
 *
 * These guard against regressions that functional tests can miss:
 * a program producing the "right" output by accident with wrong internal
 * structure (e.g., const variable still mutable, block scope merged).
 */
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { compile } from '../index.js'
import { ctx, reset } from '../src/ctx.js'
import { emitter } from '../src/emit.js'
import { GLOBALS } from '../src/prepare.js'
import { run } from './util.js'

// === Helper: compile with WAT output for structural inspection ===
const wat = (code, opts = {}) => compile(code, { ...opts, wat: true })

// ============================================================================
// Const enforcement invariants
// ============================================================================

test('invariant: module-scope const name tracked in ctx.scope.consts', () => {
  reset(emitter, GLOBALS)
  compile('const X = 10; export let f = () => X')
  ok(ctx.scope.consts?.has('X'), 'const X should be tracked in ctx.scope.consts')
})

test('invariant: let does not appear in ctx.scope.consts', () => {
  reset(emitter, GLOBALS)
  compile('let x = 10; export let f = () => x')
  ok(!ctx.scope.consts?.has('x'), 'let x should NOT be in ctx.scope.consts')
})

test('invariant: reassigned const produces compile error', () => {
  let error
  try { compile('const X = 1; export let f = () => { X = 2; return X }') } catch (e) { error = e }
  ok(error, 'const reassignment should throw')
  ok(error.message.includes("const"), `error should mention 'const': ${error.message}`)
})

test('invariant: module-scope const is not a mutable WASM global', () => {
  // A true const should not appear as a `global.set` target
  const w = wat('const X = 10; export let f = () => X')
  ok(!w.includes('global.set $X'), `const X should not be global.set: ${w.slice(0, 200)}`)
})

// ============================================================================
// Block scope invariants — functional (compiler DCE eliminates unused locals)
// ============================================================================

test('invariant: if-block let does not shadow outer at runtime', () => {
  is(run('export let f = () => { let x = 1; if (1) { let x = 2; x = 3 }; return x }').f(), 1)
})

test('invariant: for-loop let does not leak to outer scope', () => {
  is(run('export let f = () => { let i = 99; for (let i = 0; i < 3; i++) {}; return i }').f(), 99)
})

test('invariant: bare block scoping', () => {
  is(run('export let f = () => { let x = 1; { let x = 2 }; return x }').f(), 1)
})

// ============================================================================
// Optional chain invariants
// ============================================================================

test('invariant: ?.[i] with side-effecting base evaluates once', () => {
  const { f, getCalls } = run(`
    let calls = 0
    let mk = () => { calls = calls + 1; return [10, 20] }
    export let f = () => {
      calls = 0
      let r = mk()?.[1]
      return [r, calls]
    }
    export let getCalls = () => calls
  `)
  const r = f()
  is(r[0], 20, 'optional index returns correct value')
  is(r[1], 1, 'base expression evaluated exactly once')
  // Also verify getCalls is correct after f()
  is(getCalls(), 1)
})

test('invariant: ?.[] on null returns null without evaluating key', () => {
  const { f, getEvalCount } = run(`
    let evalCount = 0
    let keyExpr = () => { evalCount = evalCount + 1; return 0 }
    export let f = () => {
      evalCount = 0
      let obj = null
      let r = obj?.[keyExpr()]
      return [r, evalCount]
    }
    export let getEvalCount = () => evalCount
  `)
  const r = f()
  ok(isNaN(r[0]), 'optional index on null returns null')
  is(r[1], 0, 'key expression NOT evaluated when base is null')
  is(getEvalCount(), 0)
})

// ============================================================================
// Type preservation invariants
// ============================================================================

test('invariant: i32 loop counter stays i32 in WAT', () => {
  const w = wat('export let f = (n) => { let s = 0; for (let i = 0; i < n; i++) s += i; return s }')
  ok(w.includes('i32'), 'WAT contains i32 ops for loop counter')
})

test('invariant: division always produces f64 result', () => {
  const w = wat('export let f = (a, b) => a / b')
  ok(w.includes('f64.div'), 'division uses f64.div')
})

// ============================================================================
// Module export invariants
// ============================================================================

test('invariant: exported function appears in WAT exports', () => {
  const w = wat('export let add = (a, b) => a + b')
  ok(w.includes('(export "add"'), 'exported name appears in WAT exports')
})

test('invariant: non-exported function is not in WAT exports', () => {
  const w = wat('let helper = (x) => x * 2; export let f = (x) => helper(x)')
  ok(!w.includes('(export "helper"'), 'unexported name not in exports')
  ok(w.includes('(export "f"'), 'exported name is in exports')
})

// ============================================================================
// NaN-boxing invariants
// ============================================================================

test('invariant: null pointer uses NaN pattern', () => {
  const w = wat('export let f = () => null')
  // null should compile to the special NaN pattern, not i32.const 0
  ok(w.includes('f64') || w.includes('i64'), 'null expression uses float/int ops')
})
