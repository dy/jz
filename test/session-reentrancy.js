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
// folded into ONE `ctx.plans = {closures, loops, loweringLinks}` subtree,
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

test('session-reentrancy: closure/loop-plan A then structurally-similar B — warm matches fresh-process (audit-#19 stale-plan probe)', () => {
  if (onKernel()) return
  const warmA = compile(CLOSURE_LOOP_A)
  const warmB = compile(CLOSURE_LOOP_B)
  const freshA = compileFresh(CLOSURE_LOOP_A)
  const freshB = compileFresh(CLOSURE_LOOP_B)
  ok(eq(warmA, freshA), 'closure/loop-plan A differs between warm (first in process) and fresh-process compile')
  ok(eq(warmB, freshB), 'closure/loop-plan B differs after structurally-similar A vs. fresh-process — a stale ctx.plans.{closures,loops,loweringLinks} entry bled through')
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
