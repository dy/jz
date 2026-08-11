import { extractParams, classifyParam, isReassigned, refsName, REFS_IN_EXPR } from '../ast.js'
import { findFreeVars } from './analyze.js'
import { ctx } from '../ctx.js'
import { isGlobal } from '../ir.js'

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
//                    disqualifier slice 2's lift-eligibility predicate
//                    (design §2.1 condition 3) rejects on, so recording it
//                    now costs nothing and pays for itself immediately.
// 'heap' and 'boxed-cell' emit through the IDENTICAL code path today (the
// per-capture store loop already branches on ctx.func.boxed?.has(name) for
// EACH slot) — the split is informational, not a new emission branch; slice
// 1 changes representation only, never behavior (byte-identity gate).
//
// 'lift-eligible' (slice 2, design §2.1) — a 'heap'-shaped closure (captured,
// zero boxed captures) that is ALSO bound to a stable name N whose every use
// is a direct call (never referenced as a value). UNWIRED: emission treats
// it exactly like 'heap' (ctx.closure.make's branch is binary — zero-capture
// vs. everything else — so a 3rd/4th storage label needs no new emission
// branch to stay behavior-neutral). Slice 3 is the first slice allowed to
// give it its own codegen.
// SESSION-OWNED (audit-#19 P0, folded into ctx.plans by architecture re-audit
// item 3, .work/todo.md): lives at `ctx.plans.closures`, a fresh WeakMap every
// reset()/beginSession() (src/ctx.js's reset(), the ctx.features/ctx.linkDemand
// subtree idiom — a plain object rebuilt directly inside reset(), no per-module
// resetX() hook indirection). Ownership matters because under self-hosting
// WeakMap lowers to a strong Map (no native GC) — a module-global map would let
// plans from a PRIOR compile() session survive into the next one, and
// arena-reset offset reuse can then pointer-collide a fresh AST node with a
// stale key, producing a stale-plan HIT where every reader here assumes a miss
// (fail-open, see the coordinator rulings above). Clearing per session bounds
// the map to one compile's worth of nodes, which is what makes keeping WeakMap
// (native-GC benefit when NOT self-hosted) sound again.

// Lift-eligibility (design §2.1, conditions 1-3 — condition 4, "no loop/
// reentrancy restriction", is satisfied by simply NOT checking it; this is
// the whole point of the redesign over the retired static-env predicate).
// Deliberately reuses onlyCalledNotReferenced verbatim from the now-deleted
// scanAndTagNonEscapingClosures (Slice R) — a pure AST predicate, unchanged
// by the static-path retirement, just relocated and never joined with the
// loop/onlyCallIsSelf restrictions that predicate ALSO used to require.
const onlyCalledNotReferenced = (node, name) => {
  if (typeof node === 'string') return node !== name
  if (!Array.isArray(node)) return true
  const op = node[0]
  if (op === 'str') return true
  if (op === '=>') return !refsName(node[1], name, REFS_IN_EXPR) && !refsName(node[2], name, REFS_IN_EXPR)
  if (op === '=' && node[1] === name) return onlyCalledNotReferenced(node[2], name)
  if (op === '()' && node[1] === name) {
    for (let i = 2; i < node.length; i++) if (!onlyCalledNotReferenced(node[i], name)) return false
    return true
  }
  if (op === '.' || op === '?.') return onlyCalledNotReferenced(node[1], name)
  if (op === ':') return onlyCalledNotReferenced(node[2], name)
  for (let i = 1; i < node.length; i++) if (!onlyCalledNotReferenced(node[i], name)) return false
  return true
}

// condition 2 ("N stable") — the SAME gate emit.js's direct-dispatch
// registration already uses (emitDecl, `!ctx.func.boxed.has(name) &&
// !isGlobal(name) && !isReassigned(ctx.func.body, name)`), so a lift
// candidate is always already a direct-dispatch candidate too (design §2.3:
// lifting is a strict subset of directClosures, not a competing mechanism).
const stableBinding = (enclosingBody, name) =>
  !ctx.func.boxed?.has(name) && !isGlobal(name) && !isReassigned(enclosingBody, name)

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
  // `name` is the closure's binding name (design §2.1's N) when this arrow is
  // the DIRECT init of a `let`/`const`/plain-assignment reached by `walk`
  // below — null for every other shape (inline/anonymous arrow), which can
  // never be lift-eligible (no name to call-dispatch through).
  const mintArrow = (arrowNode, name) => {
    const [, rawParams, arrowBody] = arrowNode
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
    for (const cname of captures) {
      const v = ctx.scope.constInts?.get(cname) ?? localIntConsts.get(cname)
      if (v != null && !ctx.func.boxed?.has(cname)) captureIntConsts.set(cname, v)
    }
    const envCaptures = captureIntConsts.size ? captures.filter(cname => !captureIntConsts.has(cname)) : captures
    const boxed = envCaptures.filter(cname => ctx.func.boxed?.has(cname))
    let storage = envCaptures.length === 0 ? 'zero-capture' : boxed.length ? 'boxed-cell' : 'heap'

    // Slice 2 (UNWIRED, design §2.1) — a 'heap'-shaped closure additionally
    // bound to a stable, only-called name is a lift candidate. Condition 3
    // ("every capture effectively-final") is exactly `storage === 'heap'`
    // (boxed captures already forced 'boxed-cell' above); condition 4 ("no
    // loop/reentrancy restriction") is satisfied by omission.
    if (storage === 'heap' && name != null && stableBinding(body, name) && onlyCalledNotReferenced(body, name))
      storage = 'lift-eligible'

    ctx.plans.closures.set(arrowBody, Object.freeze({ storage, captures: Object.freeze(envCaptures) }))
    // Do NOT recurse into arrowBody/rawParams: a closure nested inside this
    // one gets its OWN mint call from emitClosureBody's mintClosureEnvPlans
    // (cb.body) once THIS closure's own body is itself compiled — matching
    // mintLoopPlans's identical "separate function, separate mint call"
    // boundary discipline.
  }

  const walk = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === 'function') return   // separate function, separate mint call
    if (op === '=>') { mintArrow(node, null); return }
    if (op === 'let' || op === 'const') {
      for (const decl of node.slice(1)) {
        if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string' && Array.isArray(decl[2]) && decl[2][0] === '=>')
          mintArrow(decl[2], decl[1])
        else walk(decl)
      }
      return
    }
    if (op === '=' && typeof node[1] === 'string' && Array.isArray(node[2]) && node[2][0] === '=>') {
      mintArrow(node[2], node[1])
      return
    }
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(body)
}
