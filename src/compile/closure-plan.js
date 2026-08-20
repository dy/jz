import { extractParams, classifyParam, T } from '../ast.js'
import { findFreeVars } from './analyze.js'
import { ctx } from '../ctx.js'
import { repOf } from '../reps.js'

// ClosureEnvPlan (.work/closure-plan-design.md) — mirrors loop-model.js's
// astLoopPlan/mintLoopPlans idiom: a frozen, pre-emission fact keyed on AST
// node identity, computed once after this function's analysis has settled,
// read-only from emission on.
//
// Design invariants (see the design doc's own tail):
//   1. Keyed on the arrow's BODY node (the loopPlanLink precedent — the
//      identity that survives lowering; decl nodes die in prepare). WeakMap,
//      fail-open: a lookup miss falls through to ctx.closure.make's own
//      inline re-derivation, never a hard error.
//   2. There is no static-closure-env path to reconcile with: module/
//      function.js's `_nonEscaping`/`OPTF.staticClosureEnv` branch,
//      scanAndTagNonEscapingClosures, and the passes.js registry entry that
//      implemented it are all gone.
//   3. `callMultiplicity` is not part of the record: it was the retired
//      static-env concept's own need (bounding live activations sharing one
//      slot) and has no meaning without that path.
//
// Record shape: `{ id, storage, captures }`.
//   id       — ClosureId: a stable id minted once per plan, a monotonic
//              counter scoped to the compile session (ctx.transform.closureId,
//              src/ctx.js's reset()) — identifies a PLAN RECORD, never names
//              anything emitted (freshLoopPlanId's sibling, ir.js).
//   storage  — 'none' (envCaptures.length === 0 post-constant-fold — no
//              allocation, module/function.js's mkPtrIR env=0 tier) or 'heap'
//              (fresh $__alloc'd env array — every non-constant capture gets
//              a slot, boxed or not; module/function.js's per-capture store
//              loop already branches on a capture's OWN mode for each slot,
//              so 'heap' does not distinguish boxed from unboxed itself, that
//              lives per-capture below). The dead static path and the
//              not-yet-wired lambda-lift path (design §4 slice 3 — deferred,
//              bench payoff was near-nil against real call-site-rewrite
//              risk) are both OUT of this enum: 'none'/'heap' is the
//              complete, currently-reachable set.
//   captures — per-capture classification array, declaration order (the SAME
//              order the env slots get written in, and — for a lift day that
//              may come later — the order lifted params would take):
//                name       — the capture's (already BindingId-unique, see
//                             prepare/index.js's mintLocal) identifier string.
//                bindingId  — `name` again when it carries prepare's
//                             `<T>f<fnId>_<serial>` BindingId suffix (every
//                             function-local capture), `undefined` for a bare
//                             module-scope global capture (BindingId totality
//                             only renames function-locals — see prepare/
//                             index.js's own doc). "When-available", per the
//                             record's own spec, not a promise.
//                mode       — 'value' (plain f64 env slot), 'cell' (boxed
//                             heap-cell pointer stored raw — module/
//                             function.js's ctx.func.boxed path, a mutated-
//                             after-declaration capture; a DIFFERENT,
//                             unconditionally-preserved mechanism this plan
//                             only RECORDS, never alters), or 'constant' (the
//                             capture provably resolves to a fixed integer at
//                             mint time — ctx.scope.constInts / this
//                             function's own topLevelIntConsts — folded away
//                             entirely, no env slot at all).
//                constant   — present iff mode === 'constant': the folded
//                             integer value.
//
// The planner computes the FULL classification here (free vars, constant
// captures, boxed cells — what module/function.js used to independently
// re-derive at every closure literal); the emitter CONSUMES it as PRIMARY
// when a plan is present, and its own inline derivation becomes the
// JZ_DEBUG_INVARIANTS shadow-assert instead (module/function.js's own doc,
// where the plan is read).
//
// This plan store lives at `ctx.plans.closures` (.work/todo.md), a fresh
// WeakMap every reset()/beginSession() (src/ctx.js's reset(), the
// ctx.features/ctx.linkDemand subtree idiom). Session ownership matters
// because under self-compiling WeakMap lowers to a strong Map (no native GC) —
// a module-global map would let plans from a PRIOR compile() session survive
// into the next one, and arena-reset offset reuse can then pointer-collide a
// fresh AST node with a stale key, producing a stale-plan HIT where every
// reader here assumes a miss (fail-open, per invariant 1 above).
const freshClosureId = () => ctx.transform.closureId++

// Names a destructuring pattern binds (mirrors src/prepare/lift-iife.js's own
// private collectPatternNames — small enough, and layered differently enough
// (compile-phase vs. prepare-phase), that a local copy beats a cross-layer
// import for one 4-line pure recursor).
const collectPatternNames = (pat, out) => {
  if (typeof pat === 'string') { out.add(pat); return }
  if (!Array.isArray(pat)) return
  for (let i = 1; i < pat.length; i++) collectPatternNames(pat[i], out)
}

// Walks `body` (a function's, or a closure's OWN body — mirrors mintLoopPlans:
// never descends into a nested `=>`/`function`, which gets its own separate
// mint call when ITS OWN analyzeFuncForEmit/emitClosureBody pass runs) for
// arrow-literal `=>` nodes, minting one frozen plan per closure reached.
export function mintClosureEnvPlans(body) {
  const mintArrow = (arrowNode) => {
    const [, rawParams, arrowBody] = arrowNode
    const raw = extractParams(rawParams)
    const paramSet = new Set()
    const defaultVals = []
    let destructured = false
    for (const r of raw) {
      const c = classifyParam(r)
      if (c.kind === 'destruct' || c.kind === 'destruct-default') destructured = true
      if (typeof c.name === 'string') paramSet.add(c.name)
      else if (c.pattern) collectPatternNames(c.pattern, paramSet)
      if (c.kind === 'default' || c.kind === 'destruct-default') defaultVals.push(c.defValue)
    }

    // Plan key: the arrow's BODY node (see invariant 1 above) for the common
    // case — but emit.js's own '=>' handler reconstructs a FRESH body array
    // to prepend the destructuring `let`s for ANY destructured param (that
    // handler's own doc), so a body-keyed plan for such a closure could never
    // be looked up again post-rewrite. `rawParams` is untouched by that
    // rewrite (only `body` is reassigned there) and is guaranteed to be a
    // non-primitive AST node whenever a destructure pattern is present (the
    // pattern itself is one) — a stable identity from mint time through to
    // ctx.closure.make's lookup. module/function.js tries the body key
    // first, then this one, so destructured-param closures get plans too
    // without moving WHEN the destructuring rewrite itself happens (it stays
    // at emission time, in emit.js — moving it earlier would reorder
    // ctx.func.uniq's temp-name allocation against every OTHER uniq
    // consumer in the function and change emitted WAT text for a program
    // that has nothing to do with this plan; emitted WAT must stay
    // byte-identical for programs the plan doesn't touch).
    const key = destructured ? rawParams : arrowBody
    if (key == null || typeof key !== 'object') return   // WeakMap keys must be objects

    const captures = []
    findFreeVars(arrowBody, paramSet, captures)
    for (const def of defaultVals) findFreeVars(def, paramSet, captures)

    // Same int-const fold module/function.js's ctx.closure.make applies (shares
    // topLevelIntConsts — a pure function of ctx.func.body, republished on
    // ctx.closure to avoid a module→ctx→src import cycle with this file — and
    // ctx.scope.constInts, a whole-module fact settled before any function's
    // analysis begins, so both are safely re-derivable here, pre-emission).
    //
    // A THIRD source, `repOf(cname)?.intConst`, closes a depth≥2 capture-chain
    // gap the two above cannot: `topLevelIntConsts(ctx.func.body)` only sees a
    // `const` declared directly at the CURRENT (innermost enclosing) function's
    // own top level. When this arrow sits inside ANOTHER closure that itself
    // merely captures (doesn't declare) the constant — e.g. `function F() {
    // const S = -2; const mid = () => { const inner = () => S; ... } }` — S is
    // declared in F's body, not mid's, so minting mid's plan (ctx.func.body ===
    // F's body, correct) folds S away for mid (mode 'constant', no env slot),
    // but minting inner's plan happens later while mid's OWN body is the active
    // frame (ctx.func.body === mid's body) — S isn't declared there either, so
    // the first two sources both miss and inner's plan falls to mode 'value',
    // expecting a real env slot mid never carries (mid folded S away — nothing
    // to store into that slot at closure-construction time): a reference with
    // no backing declaration. `repOf(cname)?.intConst` is the fix: by the time
    // inner's plan mints, mid's OWN frame has already run seedClosureFrame on
    // mid's `cb.intConsts` (module/function.js) — which republishes exactly
    // this same fold via `updateRep` — so `repOf` sees it regardless of which
    // ancestor originally declared the constant, chaining correctly through
    // any nesting depth (each level's seedClosureFrame relays what it inherited
    // to the next), the same source `readVar`/`emit` (src/ir.js, src/compile/
    // emit.js) already trust to decide whether a name needs a real slot at all.
    const localIntConsts = ctx.func.body ? ctx.closure.topLevelIntConsts?.(ctx.func.body) ?? new Map() : new Map()
    const captureIntConsts = new Map()
    for (const cname of captures) {
      const v = ctx.scope.constInts?.get(cname) ?? localIntConsts.get(cname) ?? repOf(cname)?.intConst
      if (v != null && !ctx.func.boxed?.has(cname)) captureIntConsts.set(cname, v)
    }

    const captureRecords = captures.map(cname => {
      const constant = captureIntConsts.get(cname)
      const mode = constant !== undefined ? 'constant' : ctx.func.boxed?.has(cname) ? 'cell' : 'value'
      const bindingId = cname.includes(T) ? cname : undefined
      return Object.freeze(mode === 'constant' ? { name: cname, bindingId, mode, constant } : { name: cname, bindingId, mode })
    })
    const storage = captureRecords.some(c => c.mode !== 'constant') ? 'heap' : 'none'

    ctx.plans.closures.set(key, Object.freeze({ id: freshClosureId(), storage, captures: Object.freeze(captureRecords) }))
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
    if (op === '=>') { mintArrow(node); return }
    if (op === 'let' || op === 'const') {
      for (const decl of node.slice(1)) {
        if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string' && Array.isArray(decl[2]) && decl[2][0] === '=>')
          mintArrow(decl[2])
        else walk(decl)
      }
      return
    }
    if (op === '=' && typeof node[1] === 'string' && Array.isArray(node[2]) && node[2][0] === '=>') {
      mintArrow(node[2])
      return
    }
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(body)
}
