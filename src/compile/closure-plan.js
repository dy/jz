import { extractParams, classifyParam, T } from '../ast.js'
import { findFreeVars } from './analyze.js'
import { ctx } from '../ctx.js'

// ClosureEnvPlan (.work/closure-plan-design.md, audit-#18 item 1; record shape
// per architecture re-audit item 4, .work/todo.md) — mirrors loop-model.js's
// astLoopPlan/mintLoopPlans idiom: a frozen, pre-emission fact keyed on AST
// node identity, computed once after this function's analysis has settled,
// read-only from emission on.
//
// COORDINATOR RULINGS (2026-08-10, binding — see the design doc's own tail):
//   1. Keyed on the arrow's BODY node (the loopPlanLink precedent — the
//      identity that survives lowering; decl nodes die in prepare). WeakMap,
//      fail-open: a lookup miss falls through to ctx.closure.make's own
//      inline re-derivation, never a hard error.
//   2. Static-path retired FIRST (module/function.js's `_nonEscaping`/
//      `OPTF.staticClosureEnv` branch, scanAndTagNonEscapingClosures, the
//      passes.js registry entry — all gone before this module existed).
//   3. `callMultiplicity` DROPPED — it was the retired static-env concept's
//      own need (bounding live activations sharing one slot); irrelevant once
//      that path is gone.
//
// Record shape (item 4): `{ id, storage, captures }`.
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
//              lives per-capture below). The now-provably-dead static path
//              and the never-wired lambda-lift path (design §4 slice 3,
//              COORDINATOR RULING: DEFERRED — census showed near-nil bench
//              payoff against a real call-site-rewrite risk, .work/todo.md's
//              own AS-LANDED account) are both OUT of this enum: 'none'/
//              'heap' is the complete, currently-reachable set.
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
// SESSION-OWNED (audit-#19 P0, folded into ctx.plans by architecture re-audit
// item 3, .work/todo.md): lives at `ctx.plans.closures`, a fresh WeakMap every
// reset()/beginSession() (src/ctx.js's reset(), the ctx.features/ctx.linkDemand
// subtree idiom). Ownership matters because under self-hosting WeakMap lowers
// to a strong Map (no native GC) — a module-global map would let plans from a
// PRIOR compile() session survive into the next one, and arena-reset offset
// reuse can then pointer-collide a fresh AST node with a stale key, producing
// a stale-plan HIT where every reader here assumes a miss (fail-open, per the
// coordinator rulings above).
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

    // Plan key: the arrow's BODY node (coordinator ruling 1) for the common
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
    // that has nothing to do with this plan, which the byte-identity gate
    // this item ships under forbids).
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
    const localIntConsts = ctx.func.body ? ctx.closure.topLevelIntConsts?.(ctx.func.body) ?? new Map() : new Map()
    const captureIntConsts = new Map()
    for (const cname of captures) {
      const v = ctx.scope.constInts?.get(cname) ?? localIntConsts.get(cname)
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
