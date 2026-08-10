import { extractParams, classifyParam } from '../ast.js'
import { findFreeVars } from './analyze.js'
import { ctx } from '../ctx.js'

// ClosureEnvPlan (.work/closure-plan-design.md, audit-#18 item 1) — mirrors
// loop-model.js's astLoopPlan/mintLoopPlans idiom exactly: a frozen,
// pre-emission fact keyed on AST node identity, computed once after this
// function's analysis has settled, read-only from emission on.
//
// COORDINATOR RULINGS (2026-08-10, binding — see the design doc's own tail):
//   1. Keyed on the arrow's BODY node (the loopPlanLink precedent — the
//      identity that survives lowering; decl nodes die in prepare).
//      WeakMap, fail-open: a lookup miss (a closure whose body identity
//      changed before reaching ctx.closure.make — see below) falls through
//      to today's inline re-derivation, never a hard error.
//   2. Static-path retired FIRST, its own slice (module/function.js's
//      `_nonEscaping`/`OPTF.staticClosureEnv` branch, scanAndTagNonEscaping
//      Closures, and the passes.js registry entry — all gone before this
//      module existed).
//   3. `callMultiplicity` DROPPED — it was the static-env concept's own
//      need (bounding live activations sharing one slot); lambda-lifting
//      (slice 2/3) has no shared storage, so multiplicity is irrelevant.
//      Record stays minimal: `{ storage, captures }`.
//
// storage values (slice 1 — reflects TODAY's ctx.closure.make decision tree,
// post static-path retirement):
//   'zero-capture' — envCaptures.length === 0 (module/function.js's existing
//                    §1.1 "none" tier — no allocation, mkPtrIR env=0).
//   'heap'         — fresh $__alloc'd env array, every capture unboxed.
//   'boxed-cell'   — fresh $__alloc'd env array where >=1 capture is a boxed
//                    heap-cell pointer (module/function.js's `ctx.func.boxed`
//                    path, §1.3 of the design) — a real per-slot distinction
//                    (a boxed capture's slot holds a raw i32 CELL pointer,
//                    not an f64 value) that ALSO happens to be exactly the
//                    disqualifier a future lift-eligibility predicate (design
//                    §2.1 condition 3) would reject on, so recording it now
//                    costs nothing and pays for itself immediately.
// 'heap' and 'boxed-cell' emit through the IDENTICAL code path today (the
// per-capture store loop already branches on ctx.func.boxed?.has(name) for
// EACH slot) — the split is informational, not a new emission branch; this
// slice changes representation only, never behavior (byte-identity gate).
//
// A future slice adds a 'lift-eligible' value as UNWIRED plan data — emission
// ignores it until the (separately coordinator-reviewed) slice that wires
// lambda lifting into codegen.
export const astClosurePlan = new WeakMap()

// Walks `body` (a function's, or a closure's OWN body — mirrors mintLoopPlans:
// never descends into a nested `=>`/`function`, which gets its own separate
// mint call when ITS OWN analyzeFuncForEmit/emitClosureBody pass runs) for
// arrow-literal `=>` nodes, minting one frozen plan per closure reached.
//
// A closure whose params include ANY destructuring pattern is skipped
// entirely (not merely best-effort): emit.js's own '=>' handler rewrites
// such a closure's body into a FRESH node (prepending the destructuring
// `let` — `body = ['{}', [';', ...bodyPrefix, ...]]`, a NEW array, before
// `ctx.closure.make` ever sees it) — the body identity this mint would key
// on does not yet exist at mint time, so any plan minted against the
// ORIGINAL body could never be looked up again. Skipping is not a
// correctness shortcut; it is a no-op (the WeakMap-identity mismatch would
// produce the exact same fail-open miss on its own, this just avoids the
// wasted computation).
export function mintClosureEnvPlans(body) {
  const walk = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === 'function') return   // separate function, separate mint call
    if (op !== '=>') { for (let i = 1; i < node.length; i++) walk(node[i]); return }

    const [, rawParams, arrowBody] = node
    if (!Array.isArray(arrowBody)) return   // WeakMap keys must be objects (`x => x`, `() => 5`, …)

    const raw = extractParams(rawParams)
    const paramSet = new Set()
    const defaults = []
    let destructured = false
    for (const r of raw) {
      const c = classifyParam(r)
      if (c.kind === 'destruct' || c.kind === 'destruct-default') { destructured = true; break }
      paramSet.add(c.name)
      if (c.kind === 'default') defaults.push(c.defValue)
    }
    if (destructured) return   // body identity changes before ctx.closure.make sees it — see doc above

    // Same call shape as emit.js's own '=>' handler (findFreeVars(body, paramSet,
    // captures) + one findFreeVars per default-value expression) — the RAW
    // capture list ctx.closure.make itself receives, before int-const folding.
    const captures = []
    findFreeVars(arrowBody, paramSet, captures)
    for (const def of defaults) findFreeVars(def, paramSet, captures)

    // Same int-const fold module/function.js's ctx.closure.make applies (shares
    // topLevelIntConsts — a pure function of ctx.func.body, republished on
    // ctx.closure to avoid a module→ctx→src import cycle with this file — and
    // ctx.scope.constInts, a whole-module fact settled before any function's
    // analysis begins, so both are safely re-derivable here, pre-emission).
    const localIntConsts = ctx.func.body ? ctx.closure.topLevelIntConsts?.(ctx.func.body) ?? new Map() : new Map()
    const captureIntConsts = new Map()
    for (const name of captures) {
      const v = ctx.scope.constInts?.get(name) ?? localIntConsts.get(name)
      if (v != null && !ctx.func.boxed?.has(name)) captureIntConsts.set(name, v)
    }
    const envCaptures = captureIntConsts.size ? captures.filter(name => !captureIntConsts.has(name)) : captures
    const boxed = envCaptures.filter(name => ctx.func.boxed?.has(name))
    const storage = envCaptures.length === 0 ? 'zero-capture' : boxed.length ? 'boxed-cell' : 'heap'

    astClosurePlan.set(arrowBody, Object.freeze({ storage, captures: Object.freeze(envCaptures) }))
    // Do NOT recurse into arrowBody/rawParams: a closure nested inside this
    // one gets its OWN mint call from emitClosureBody's mintClosureEnvPlans
    // (cb.body) once THIS closure's own body is itself compiled — matching
    // mintLoopPlans's identical "separate function, separate mint call"
    // boundary discipline.
  }
  walk(body)
}
