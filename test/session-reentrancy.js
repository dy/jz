/**
 * Reentrancy probe (session survey audit-#13 slice a — the COORDINATOR RULING's
 * gate for the unified reset choreography). Not another "compile twice in one
 * process" determinism check (test/determinism.js already has that) — this
 * compares a WARM in-process compile against a compile of the SAME program in a
 * BRAND-NEW node process, so a bug that corrupts BOTH the warm and a same-process
 * "fresh" compile identically (e.g. a wrong default baked in at module load)
 * can't hide.
 *
 * Two pairs, each picked to bleed through exactly the state this slice folded
 * into ONE reset choreography (src/ctx.js's RESET_HOOKS / src/session.js's
 * SESSION_RESET_HOOKS):
 *   - regex-heavy → regex-free: exercises module/regex.js's parser globals
 *     (src/idx/groupNum/groupNames).
 *   - prepare-state-heavy → minimal: exercises prepare/index.js's 14-let
 *     working set (scopes, static-const tracking, rename/owner stacks, …).
 *
 * For each pair: compile A then B sequentially in THIS process (the ordering the
 * ruling calls out — "two sequential compiles in one process with DIFFERENT
 * programs"), and separately compile A alone and B alone in fresh child
 * processes. Assert the warm B equals the fresh B (and warm A equals fresh A,
 * for good measure — same probe, no extra cost).
 */
import test from 'tst'
import { ok } from 'tst/assert.js'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { compile } from '../index.js'
import * as ctxModule from '../src/ctx.js'
import { ctx } from '../src/ctx.js'
import { enterActiveFunction, isInactiveFunction, restoreActiveFunction } from '../src/compile/active-function.js'
import { createFunctionPlan, installFunctionPlan } from '../src/compile/function-plan.js'
import { withFunctionField } from '../src/compile/flow-state.js'
import { onKernel } from './_matrix.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORKER = join(ROOT, 'test', '_fresh-compile-worker.mjs')

const compileFresh = (src, opts = {}) => {
  const arg = Buffer.from(JSON.stringify({ src, opts })).toString('base64')
  const r = spawnSync(process.execPath, [WORKER, arg], { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`fresh compile failed (exit ${r.status}): ${r.stderr}`)
  return Buffer.from(r.stdout.trim(), 'base64')
}

const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

// Regex-heavy: many literals (alternation, quantifiers, char classes, named
// groups, backreferences, flags) across module scope and inside a function —
// several sequential parseRegex() calls within ONE compile, then a second
// program that never touches module/regex.js at all.
const REGEX_HEAVY = `
  const WORD = /^(?<head>\\w+)[-_](?<tail>\\w+)$/
  const LOOSE = /a(b)?c+|d*e/gi
  export let scan = (s) => {
    let m = s.match(WORD)
    let n = s.match(/(\\d{2,4})-(\\d{2})-(\\d{2})/)
    let hit = LOOSE.test(s)
    let back = /(foo)\\1/.test(s)
    return (m ? 1 : 0) + (n ? 1 : 0) + (hit ? 1 : 0) + (back ? 1 : 0)
  }`
const REGEX_FREE = `
  export let add = (a, b) => a + b
  export let mix = (n) => { let s = 0; for (let i = 0; i < n; i++) s += i * i; return s }`

// Prepare-state-heavy: deep arrow nesting, sibling-block name shadowing (forces
// funcLocalNames rename), static-const string/array tracking, a loop-captured
// let, a reassigned top-level binding, catch, destructuring — exercises most of
// prepare/index.js's 14-let working set in one compile.
const PREPARE_HEAVY = `
  let counter = 0
  export let reassignMe = () => { counter += 1; return counter }
  const STR = "abc"
  const ARR = [1, 2, 3]
  export let deep = (n) => {
    const outer = (x) => {
      if (x > 0) { let y = x + 1; return y * 2 }
      else { let y = x - 1; return y * 3 }
    }
    let fns = []
    for (let i = 0; i < 3; i++) {
      let captured = i
      fns.push(() => captured * 2)
    }
    let total = 0
    for (const f of fns) total += f()
    let [a, b, ...rest] = ARR
    let result
    try {
      if (n < 0) throw n
      result = outer(n) + total + a + b + rest.length + STR.length
    } catch (e) {
      result = -e
    }
    return result
  }`
const MINIMAL = `export let f = () => 1`

// Closure/loop-plan pair (audit-#19 P0 probe): compile/closure-plan.js's
// closure plans, compile/loop-model.js's loop plans, and ir.js's
// loopPlanLink used to be module-global WeakMaps — under self-hosting
// WeakMap lowers to a strong Map (no native GC), so entries from a PRIOR
// compile() survive into the next one, and the kernel's arena-reset offset
// reuse can pointer-collide a fresh AST node with a stale key, producing a
// stale-plan HIT exactly where every reader here fails open on a miss. The
// fix made all three session-owned (fresh WeakMap per reset()/beginSession());
// folded into the session-owned `ctx.plans` subtree,
// rebuilt directly by reset(), by architecture re-audit item 3 (.work/todo.md).
// CLOSURE_LOOP_A/B are STRUCTURALLY parallel —
// same shape/position for a zero-capture closure, a heap-capture closure, a
// boxed-cell closure (a reassigned-inside-closure counter), and two loops
// (one with a typed hull, one plain) — but with different literal bounds, so
// a stale plan leaking from A into B's same-shaped nodes would read the
// WRONG hull/boundConst/storage and miscompile, not merely no-op.
const CLOSURE_LOOP_A = `
  export let mk = (n) => {
    let zero = () => 42
    let base = n
    let heapFn = () => base + 1
    let counter = 0
    let inc = () => { counter += 1; return counter }
    let total = 0
    for (let i = 0; i < n; i++) { if (i < 100) total += i * 2 }
    let acc = 0
    for (let j = 0; j < 50; j++) acc += heapFn() + zero()
    counter = inc() + inc()
    return total + acc + counter
  }`
const CLOSURE_LOOP_B = `
  export let mk = (n) => {
    let zero = () => 7
    let base = n * 2
    let heapFn = () => base - 3
    let counter = 100
    let inc = () => { counter -= 1; return counter }
    let total = 0
    for (let i = 0; i < n; i++) { if (i < 10) total += i }
    let acc = 0
    for (let j = 0; j < 5; j++) acc += heapFn() - zero()
    counter = inc() - inc()
    return total + acc + counter
  }`

test('prepare naming is compile-owned and distinct from EmitFrame names', () => {
  if (onKernel()) return
  compile('export let f = ({ x }, ...ys) => { let [a, b] = ys; return x + a + b }')
  const firstPrepareCount = ctx.names.prepare
  ok(firstPrepareCount > 0 && ctx.func.uniq === 0,
    'prepare consumed its own counter while the restored inactive EmitFrame stayed untouched')
  compile('export let g = ({ y }) => y')
  ok(ctx.names.prepare > 0 && ctx.names.prepare <= firstPrepareCount && ctx.func.uniq === 0,
    'the prepare counter resets per compile independently of function temp names')
})

test('ProgramFunctions authority is distinct from the active function frame', () => {
  if (onKernel()) return
  compile(MINIMAL)
  ok(ctx.funcs && ctx.funcs !== ctx.func, 'program registry and active frame must be separate records')
  ok(Array.isArray(ctx.funcs.list) && ctx.funcs.list.length > 0, 'program registry owns the prepared function list')
  ok(ctx.funcs.names instanceof Set && ctx.funcs.map instanceof Map, 'program registry owns its derived indexes')
  ok(!('list' in ctx.func) && !('names' in ctx.func) && !('map' in ctx.func) && !('exports' in ctx.func),
    'active frame retains no compatibility mirror of ProgramFunctions fields')
})

test('ProgramFunctions resets between sequential compiles', () => {
  if (onKernel()) return
  compile('export let first = () => 1')
  ok(ctx.funcs.names.has('first'), 'first compile registered its function')
  compile('export let second = () => 2')
  ok(!ctx.funcs.names.has('first') && ctx.funcs.names.has('second'),
    'second compile receives a fresh program registry, not the prior session catalog')
})

test('function-entry state pins: P1 predictions and diagnostic identity are frame-local', () => {
  if (onKernel()) return
  compile('export let a = () => { let xs = [1, 2]; return xs[0] }')
  const firstPredicted = ctx.func.p1Predicted
  ok(firstPredicted instanceof Set, 'function entry seeds p1Predicted explicitly')
  compile('export let b = () => { let o = { x: 1 }; return o.x }')
  ok(ctx.func.p1Predicted instanceof Set && ctx.func.p1Predicted !== firstPredicted,
    'a later function/session cannot inherit the prior frame prediction set')
  ok(!('name' in ctx.func), 'dead ctx.func.name authority was not introduced; diagnostics use current?.name')
})

test('ActiveFunction swaps and restores record identity, not selected fields', () => {
  if (onKernel()) return
  compile('export let f = x => x + 1')
  const outer = ctx.func
  const displaced = enterActiveFunction(ctx, {
    sig: { name: 'probe', params: [], results: [] },
    body: ['{}'],
    uniq: 17,
  })
  ok(displaced === outer && ctx.func !== outer, 'entry displaces the whole prior record')
  ok(ctx.func.p1Predicted instanceof Set && ctx.func.hoistTempDefs === null && ctx.func.uniq === 17,
    'the complete constructor owns prediction, hoist-temp, and temp-name state')
  outer.typedElem = new Map([['outer', 'Float64Array']])
  outer.typedLen = new Map([['outer', 4]])
  ok(ctx.func.typedElem === null && ctx.func.typedLen === null,
    'entered record starts with its own clean typed facts')
  ctx.func.localValTypesOverlay.set('inner-only', 1)
  ctx.func.typedElem = new Map([['inner', 'Int32Array']])
  restoreActiveFunction(ctx, displaced)
  ok(ctx.func === outer && !ctx.func.localValTypesOverlay.has('inner-only'),
    'restore reinstates prior identity; inner overlays cannot leak')
  ok(ctx.func.typedElem.has('outer') && ctx.func.typedLen.get('outer') === 4,
    'typed facts return with the displaced record, not a parallel ambient store')
  outer.typedElem = null
  outer.typedLen = null
})

test('FlowState scopes restore the owning frame even when nested work throws', () => {
  if (onKernel()) return
  compile('export let f = x => x')
  const frame = ctx.func
  const outer = frame._expect
  let threw = false
  try {
    withFunctionField('_expect', 'void', () => {
      ok(ctx.func === frame && ctx.func._expect === 'void', 'scope mutates the active record, not a detached facade')
      withFunctionField('_expect', 'inner', () => { throw new Error('probe') })
    })
  } catch { threw = true }
  ok(threw && ctx.func === frame && ctx.func._expect === outer,
    'nested throw restored both scopes and preserved active-record identity')
})

test('FunctionPlan is session-owned, opaque, and detached from emission state', () => {
  if (onKernel()) return
  compile('export let planned = n => { let xs = [n, n + 1]; return xs[0] }')
  const func = ctx.funcs.map.get('planned')
  const plan = ctx.plans.functions.get(func)
  ok(plan && Object.keys(plan).length === 0,
    'function identity resolves to an opaque plan handle with no mutable facts exposed')
  const displaced = enterActiveFunction(ctx, { sig: func.sig, body: func.body })
  const first = installFunctionPlan(ctx, plan)
  const plannedLocals = first.locals.size
  ctx.func.locals.set('emit-only', 'i32')
  ctx.func.localReps.set('emit-only', { val: 1 })
  const second = installFunctionPlan(ctx, plan)
  ok(second.locals.size === plannedLocals && !second.locals.has('emit-only') && !second.localReps.has('emit-only'),
    'a later install is detached from prior emission writes')
  ok(first.locals !== second.locals && first.localReps !== second.localReps,
    'repeated installs never share mutable working collections')
  restoreActiveFunction(ctx, displaced)
})

test('FunctionPlan detaches nested maps, sets, arrays, reps, and typed views', () => {
  if (onKernel()) return
  const flatObjects = new Map([['o', { names: ['x'], values: [[null, 1]], written: new Set(['x']) }]])
  const leanHashDomains = new Map([['d', ['a', 'b']]])
  const localReps = new Map([['x', { val: 1, range: [0, 1], dictValueValType: new Set([1]) }]])
  const typedElem = new Map([['buf', 'Float64Array']])
  const typedLen = new Map([['buf', 4]])
  const plan = createFunctionPlan(ctx, {
    locals: new Map([['x', 'f64']]), flatObjects, leanHashDomains, localReps, typedElem, typedLen,
  })
  ok(Object.keys(plan).length === 0, 'canonical facts are private, not shallow-frozen public fields')
  // Publication owns an independent snapshot too; mutating the analysis result
  // after handoff cannot alter the canonical plan.
  flatObjects.get('o').names.push('source-evil')
  localReps.get('x').range[0] = -7
  typedElem.set('source-evil', 'Int32Array')
  const displaced = enterActiveFunction(ctx)
  const first = installFunctionPlan(ctx, plan)
  ok(first.flatObjects.get('o').names.length === 1 && first.localReps.get('x').range[0] === 0 &&
      !first.typedElem.has('source-evil'), 'publication detaches the analysis result before it becomes canonical')
  first.flatObjects.get('o').names.push('evil')
  first.flatObjects.get('o').written.add('evil')
  first.leanHashDomains.get('d').push('evil')
  first.localReps.get('x').range[0] = -99
  first.localReps.get('x').dictValueValType.add(9)
  first.typedElem.set('evil', 'Int32Array')
  first.typedLen.set('evil', 9)
  const second = installFunctionPlan(ctx, plan)
  ok(second.flatObjects.get('o').names.length === 1 && !second.flatObjects.get('o').written.has('evil'),
    'nested object/array/Set facts are detached')
  ok(second.leanHashDomains.get('d').length === 2 && second.localReps.get('x').range[0] === 0 &&
      !second.localReps.get('x').dictValueValType.has(9),
    'domain and ValueRep substructure is detached')
  ok(!second.typedElem.has('evil') && !second.typedLen.has('evil') &&
      first.typedElem !== second.typedElem && first.typedLen !== second.typedLen,
    'typed views fork per install without exposing canonical storage')
  restoreActiveFunction(ctx, displaced)
})

// typedElem/typedLen are owned by ActiveFunction itself. A closure with a
// static typed array must restore the complete displaced record, leaving no
// parallel authority on ctx.types and no facts on the inactive session frame.
test('typedElem/typedLen active state does not leak past a nested-closure compile', () => {
  if (onKernel()) return  // white-box probe of ctx.types internals — no in-kernel host ctx to inspect
  compile(`
    export let mk = (n) => {
      let zero = () => 42
      let base = n
      let heapFn = () => base + 1
      let f = () => { let buf = new Float64Array(3); return buf[0] + buf.length }
      return zero() + heapFn() + f()
    }
  `)
  ok(ctx.func.current === null, 'session frame restored')
  ok(ctx.func.typedElem === null && ctx.func.typedLen === null,
    'inactive ActiveFunction has no closure-local typed facts')
  ok(!('typedElem' in ctx.types) && !('typedLen' in ctx.types),
    'ctx.types no longer duplicates function-local typed authority')
})

test('active frame restores as one record after functions, late closures, and __start', () => {
  if (onKernel()) return
  compile(`
    let base = 3
    let make = n => x => x + n + base
    let add = make(4)
    export let run = x => add(x)
  `)
  ok(isInactiveFunction(ctx),
    'compile restored the inactive session frame instead of leaving function/start/expression fields')
  ok(ctx.func.atModuleScope === false && ctx.func.stack.length === 0 && ctx.func.uniq === 0,
    'synthetic __start and late-closure emission restored the displaced frame by identity')
  ok(ctx.func._expect === null && ctx.func._selfAccumConcat === null && ctx.func._schemaSpecSlow === false,
    'expression-emission scopes cannot leak out of the active record')
})

test('session-reentrancy: closure/loop-plan A then structurally-similar B — warm matches fresh-process (audit-#19 stale-plan probe)', () => {
  if (onKernel()) return
  const warmA = compile(CLOSURE_LOOP_A)
  const warmB = compile(CLOSURE_LOOP_B)
  const freshA = compileFresh(CLOSURE_LOOP_A)
  const freshB = compileFresh(CLOSURE_LOOP_B)
  ok(eq(warmA, freshA), 'closure/loop-plan A differs between warm (first in process) and fresh-process compile')
  ok(eq(warmB, freshB), 'closure/loop-plan B differs after structurally-similar A vs. fresh-process — a stale ctx.plans entry bled through')
})

test('session-reentrancy: closure/loop-plan order-reversed — B then A — warm matches fresh-process', () => {
  if (onKernel()) return
  const warmB = compile(CLOSURE_LOOP_B)
  const warmA = compile(CLOSURE_LOOP_A)
  ok(eq(warmB, compileFresh(CLOSURE_LOOP_B)), 'closure/loop-plan B (compiled first) differs from fresh-process compile')
  ok(eq(warmA, compileFresh(CLOSURE_LOOP_A)), 'closure/loop-plan A (compiled second, after structurally-similar B) differs from fresh-process — a stale plan entry bled through')
})

test('session-reentrancy: regex-heavy then regex-free — warm matches fresh-process', () => {
  if (onKernel()) return  // native reset-choreography probe; the wasm kernel owns its own internal reset, unrelated to src/ctx.js's RESET_HOOKS
  const warmA = compile(REGEX_HEAVY)
  const warmB = compile(REGEX_FREE)
  const freshA = compileFresh(REGEX_HEAVY)
  const freshB = compileFresh(REGEX_FREE)
  ok(eq(warmA, freshA), 'regex-heavy program differs between warm (after itself, first in process) and fresh-process compile')
  ok(eq(warmB, freshB), 'regex-free program differs after a regex-heavy predecessor vs. a fresh process — module/regex.js parser state bled through')
})

test('session-reentrancy: prepare-state-heavy then minimal — warm matches fresh-process', () => {
  if (onKernel()) return
  const warmA = compile(PREPARE_HEAVY)
  const warmB = compile(MINIMAL)
  const freshA = compileFresh(PREPARE_HEAVY)
  const freshB = compileFresh(MINIMAL)
  ok(eq(warmA, freshA), 'prepare-state-heavy program differs between warm and fresh-process compile')
  ok(eq(warmB, freshB), 'minimal program differs after a prepare-state-heavy predecessor vs. a fresh process — prepare/index.js working-set state bled through')
})

// Reverse order too: the leak, if any, could run either direction (a "small"
// program leaving state a "big" one reads, not just the other way round).
test('session-reentrancy: order-reversed — minimal then prepare-heavy, regex-free then regex-heavy', () => {
  if (onKernel()) return
  const warmMinimal = compile(MINIMAL)
  const warmPrepHeavy = compile(PREPARE_HEAVY)
  ok(eq(warmMinimal, compileFresh(MINIMAL)), 'minimal (compiled first) differs from fresh-process compile')
  ok(eq(warmPrepHeavy, compileFresh(PREPARE_HEAVY)), 'prepare-heavy (compiled second) differs from fresh-process compile')

  const warmRegexFree = compile(REGEX_FREE)
  const warmRegexHeavy = compile(REGEX_HEAVY)
  ok(eq(warmRegexFree, compileFresh(REGEX_FREE)), 'regex-free (compiled first) differs from fresh-process compile')
  ok(eq(warmRegexHeavy, compileFresh(REGEX_HEAVY)), 'regex-heavy (compiled second) differs from fresh-process compile')
})

// CompileSession-as-value (Slice B, .work/compile-session-design.md §2.3 row
// 1/3) reassigned `ctx` by identity every reset() instead of mutating fields
// in place, so a caller holding a `ctx` reference from before a later
// compile() would keep observing that older compile's own coherent
// snapshot. SWAP-REVERTED (stack-test-2026-08-15, .work/research.md
// b8f802b8's half-bisection: the const→let identity-swap conversion was
// isolated as the SOLE guilty mechanism for a deterministic region-live
// kernel-oracle regression, `facts` absorption proven innocent) — `ctx` is
// back to `const`, mutated field-by-field in place, so a held reference is
// NO LONGER a stable snapshot: it observes every later reset() through the
// same object identity. This test now documents that known limitation
// directly (a regression guard against silently reintroducing partial-
// mutation visibility, not a reentrancy-safety claim) rather than asserting
// the now-false identity-swap behavior. Reentrancy is a named future slice,
// deferred pending the write-site forensic (b8f802b8's own "concrete next
// step") rather than re-landed blind.
test('session-reentrancy: swap-reverted — a ctx reference held across a later reset() is NOT a stable snapshot (known limitation, deferred)', () => {
  if (onKernel()) return  // white-box probe of ctx.js's own module-binding identity
  compile(PREPARE_HEAVY)
  const held = ctx
  ok(held.funcs.names.has('reassignMe') && held.funcs.names.has('deep'),
    'held reference reflects PREPARE_HEAVY\'s own function registry immediately after compile')
  compile(MINIMAL)
  ok(ctx === held, 'reset() mutates the ctx binding in place (const ctx, swap-reverted) — same object identity, not a fresh one')
  ok(ctxModule.ctx === ctx, 'the live import binding still tracks the current session')
  ok(held.funcs.names.has('f') && !held.funcs.names.has('reassignMe'),
    'the previously-held reference now reports MINIMAL\'s registry — mutated underfoot, not a coherent snapshot of PREPARE_HEAVY')
})
