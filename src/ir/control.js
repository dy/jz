/**
 * Whole-IR-tree structural utilities (refcounting, next-free-local-id,
 * validity checks) + control-flow/tail-call helpers (multi-value calls,
 * loop-label lookup, tail-call rewriting, spread-argument reconstruction).
 * The one family with no numeric/pointer/bigint coupling — depends only on
 * ir/tag.js.
 *
 * @module ir/control
 */

import { ctx, err } from '../ctx.js'
import { walkAst } from '../ast.js'
import { typed } from './tag.js'

/** Whole-fn structural refcount: walks `fn`, counting how many times each
 *  array node is referenced. Used by optimizer passes to skip shared subtrees
 *  (watr CSE may leave them) — mutating a node with refcount > 1 would also
 *  affect references outside the current region. Single-pass O(N). */
export function buildRefcount(fn) {
  const refcount = new Map()
  const walk = (node) => {
    if (!Array.isArray(node)) return
    const n = (refcount.get(node) || 0) + 1
    refcount.set(node, n)
    if (n > 1) return  // already counted children below
    for (let i = 0; i < node.length; i++) walk(node[i])
  }
  walk(fn)
  return refcount
}

/** Pick the next free `$__<prefix><id>` local-name id by collecting all
 *  existing ids in a single walk. Replaces the per-pass
 *  `while (fn.some(... === $__prefixK)) k++` (O(K·N)) with one O(N) scan. */
export function nextLocalId(fn, prefix) {
  // HIGH-WATER mark (max existing + 1), NOT the first free id. Callers allocate sequentially
  // (id++), so a first-gap start would walk straight into an existing higher local once watr's
  // coalesce has left non-contiguous numbering (e.g. $__pe0,$__pe1,$__pe5 → start at 2, then
  // mint 3,4,5 and collide on $__pe5 = "Duplicate local"). High-water is always collision-free.
  const needle = `$__${prefix}`
  let id = 0
  const walk = (n) => {
    if (!Array.isArray(n)) return
    if (n[0] === 'local' && typeof n[1] === 'string' && n[1].startsWith(needle)) {
      const tail = n[1].slice(needle.length)
      if (/^\d+$/.test(tail)) { const k = +tail; if (k >= id) id = k + 1 }
    }
    for (let i = 0; i < n.length; i++) walk(n[i])
  }
  walk(fn)
  return id
}

/** Check if a call expression targets a multi-value function. Returns result count or 0. */
export function multiCount(callNode) {
  if (!Array.isArray(callNode) || callNode[0] !== '()') return 0
  const name = callNode[1]
  if (typeof name !== 'string') return 0
  const func = ctx.funcs.map?.get(name)
  return func?.sig.results.length > 1 ? func.sig.results.length : 0
}

/** Get current loop labels or throw. */
export function loopTop() {
  const top = ctx.func.stack.at(-1)
  if (!top) err('break/continue outside loop — move it inside a for/while/do loop')
  return top
}

// === Data shaping ===

/** Normalize emit result to instruction list. */
export const flat = ir => {
  if (ir == null) return []
  if (!Array.isArray(ir)) return [ir]  // bare 'drop', 'nop', etc.
  if (ir.length === 0) return []
  if (typeof ir[0] === 'string' || ir[0] == null) return [ir]  // single instruction: ['op', ...args] or [null, val]
  return ir  // multi-instruction: [instr1, instr2, ...]
}

/**
 * Reconstruct arguments with spreads inserted at correct positions.
 * Example: normal=[a, c], spreads=[{pos:1, expr:arr}] → [a, __spread(arr), c]
 */

/** Find the index of the first body-content child in a (func ...) WAT node.
 *  Skips $name, (export …), (import …), (type …), (param …), (result …), (local …).  */
export function findBodyStart(fn) {
  for (let i = 2; i < fn.length; i++) {
    const c = fn[i]
    if (!Array.isArray(c)) continue
    if (c[0] === 'export' || c[0] === 'import' || c[0] === 'type' ||
        c[0] === 'param' || c[0] === 'result' || c[0] === 'local') continue
    return i
  }
  return fn.length
}

/** Debug-mode structural check of a `(func …)` IR node. Catches the bug classes
 *  that otherwise surface as OPAQUE watr errors several phases later — `Duplicate
 *  local $x`, `Unknown local $x` — but here pinned to the exact name (and, via the
 *  caller, the phase + function) that produced them, so a codegen/optimizer bug is
 *  localized at its source instead of at watr. Self-contained: validates every
 *  `local.{get,set,tee}` against the function header's param/local declarations,
 *  and rejects a duplicate declaration. Returns an error string, or null if clean.
 *  (Call-target and type-tag validation need the module symbol table + a type pass;
 *  deferred — locals are the common codegen-bug class and need nothing external.) */
export function verifyFn(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return null
  const bodyStart = findBodyStart(fn)
  const declared = new Set()
  for (let i = 2; i < bodyStart; i++) {
    const c = fn[i]
    if (!Array.isArray(c) || (c[0] !== 'param' && c[0] !== 'local') || typeof c[1] !== 'string') continue
    if (declared.has(c[1])) return `duplicate local/param ${c[1]}`
    declared.add(c[1])
  }
  let bad = null
  const enter = n => {
    if (bad) return false
    const op = n[0]
    if ((op === 'local.get' || op === 'local.set' || op === 'local.tee') && typeof n[1] === 'string' && !declared.has(n[1])) {
      bad = `${op} of undeclared local ${n[1]}`; return false
    }
  }
  for (let i = bodyStart; i < fn.length; i++) walkAst(fn[i], { enter })
  return bad
}

// === HIR provenance link (.work/research.md §BodyModel slice 4) ===
//
// Connects a WAT-level loop block node (the vectorizer's own scaffold — matchBlockLoop's
// `blockNode`, src/optimize/vectorize.js) back to the facts proved about it at HIR-lowering time
// (src/compile/emit.js's `'for'` handler, the sole writer) — its induction-variable/guard names
// and the counter/guard hull `forCounterRange` proves (src/static.js) — so BodyModel can
// eventually consult these instead of re-deriving them from the lowered WAT. Landed as the link +
// a DBG shadow-assert only (vectorize.js's assertLoopPlanAgrees) — no consumer yet.
//
// Lives here, not in compile/loop-model.js (AST-level loop primitives, pre-emission) or
// optimize/vectorize.js (the sole reader): this module is the neutral WAT-IR-node seam already
// imported by both without a layering violation, and the link's key is a WAT node.
//
// Keyed by WAT block-node IDENTITY via a WeakMap, not a stamped property, per the design's
// BINDING pre-trio spec (1): a rewrite that mints a fresh block array (any AST-to-WAT pass
// running between emission and the vectorizer walk that reads it) naturally drops out of the map.
// A miss is the CORRECT "decline, don't guess" answer for a rewritten loop (spec 2: fail-open),
// never an error — every reader must treat `loopPlanLink.get(node) === undefined` as "no HIR
// facts available", not as a negative fact about the loop.
//
// Each entry is `{ plan, lowering }`, NOT one flat record:
//   `plan`     — the immutable HIR-side facts (id, hull, boundConst). Frozen: renaming a WAT
//                local downstream must never look like it changed what HIR proved.
//   `lowering` — the WAT-side name map (ivName, guardName). Mutable, owned by the backend: a pass
//                that renames a linked loop's own IV/guard local in place (emit.js's
//                freshenUnrolledScalarBindings, the one instance found so far — see its own doc)
//                updates ONLY this half, keeping the fact synchronized without mutating an HIR
//                fact after the fact.
// SESSION-OWNED — folded into ctx.plans (.work/todo.md — see
// src/compile/closure-plan.js's sibling doc comment for the full
// stale-plan-HIT hazard under self-hosting). Lives at
// `ctx.plans.loweringLinks`, a fresh WeakMap every reset() (src/ctx.js).
// Readers: `ctx.plans.loweringLinks.get(node) === undefined` is the CORRECT
// "decline, don't guess" answer for a rewritten loop (spec 2: fail-open),
// never an error.

// Separate id space from compile/loop-model.js's freshLoopId: a LoopPlan id identifies a HIR loop
// RECORD, never used to name anything emitted, so it must not share a counter with generated-
// local suffixes.
export const freshLoopPlanId = () => ctx.transform.loopPlanId++

/**
 * Tail-call rewrite: walks tail positions of an emitted IR tree and replaces
 * direct `(call $name args...)` ops with `(return_call $name args...)`.
 *
 * Tail positions, recursively from the IR root:
 *   - the root itself (function's terminal value-producing expression, or the
 *     emitted value of an explicit `return X`)
 *   - both arms of `(if (result T) cond (then ...) (else ...))`
 *   - last instruction of `(block (result T) ...)`
 *
 * Only fires when caller and callee result types match — if they didn't match,
 * `asParamType`/`asPtrOffset` would have wrapped the call in a conversion op,
 * pushing the `call` away from the tail position. We don't recurse into
 * arithmetic / select / loop ops: their results aren't standalone-tail control
 * transfers.
 *
 * Two callers:
 *   - `compile.js` runs it on the function's final value-producing IR to TCO
 *     expression-bodied arrows like `(n, acc) => n <= 0 ? acc : sum(n-1, acc+n)`
 *     where the AST has no `return` keyword.
 *   - `emit.js` `'return'` op handler runs it on the emitted return expression
 *     so explicit `return cond ? f(x) : g(x)` also gets deep tail rewriting.
 *
 * Returns the input unchanged when no transform applies.
 */
export const tcoTailRewrite = (ir, resultType) => {
  // TargetProfile's own noTailCall (session.js — on for host:'native',
  // the wasm2c-lowering lane with a known return_call+multi-value codegen bug)
  // is the NAMED-POLICY source; opts.noTailCall stays a separate, additive
  // explicit override usable under ANY host (e.g. a plain js/wasi target that
  // wants ordinary call frames for a reason unrelated to wasm2c — cli.js's
  // `--no-tail-call` flag doesn't require `--host native`).
  if (ctx.transform.targetProfile.noTailCall || ctx.transform.noTailCall || ctx.func.inTry) return ir
  if (!Array.isArray(ir)) return ir
  const op = ir[0]
  if (op === 'call' && typeof ir[1] === 'string') {
    // IR call name is `$name`; func.map keys are bare `name`.
    const calleeName = ir[1].startsWith('$') ? ir[1].slice(1) : ir[1]
    const callee = ctx.funcs.map.get(calleeName)
    // If this is a known user func, verify result-type match. Otherwise
    // (closures, imports, runtime helpers — not in `ctx.funcs.map`) trust the
    // tail-position invariant: emit.js' asParamType/asPtrOffset already wrapped
    // any mismatched call in a conversion op, so a bare `(call $X …)` at the
    // tail of the function/if/block has by construction the same result type
    // as the caller.
    if (callee) {
      if (callee.raw) return ir
      const calleeRT = callee.sig?.results?.[0] ?? 'f64'
      if (calleeRT !== resultType) return ir
    }
    const rc = typed(['return_call', ...ir.slice(1)], resultType)
    // Carry `.schemaSid` forward (ctx.js's ctx.schema doc): a single-expression
    // arrow whose whole body is `new TypeError(x)`-shaped (mkPtrIR's `call
    // $__mkptr` at the function's tail) lands exactly here — `ir`, the node
    // src/compile/index.js's post-treeshake collector would have found the tag
    // on, is being replaced wholesale, never visited again.
    if (ir.schemaSid != null) rc.schemaSid = ir.schemaSid
    return rc
  }
  if (op === 'if' && Array.isArray(ir[1]) && ir[1][0] === 'result') {
    let changed = false
    const newIr = ir.slice()
    for (let i = 3; i < newIr.length; i++) {
      const arm = newIr[i]
      if (Array.isArray(arm) && (arm[0] === 'then' || arm[0] === 'else') && arm.length > 1) {
        const last = arm[arm.length - 1]
        const rewritten = tcoTailRewrite(last, resultType)
        if (rewritten !== last) {
          newIr[i] = [...arm.slice(0, -1), rewritten]
          changed = true
        }
      }
    }
    return changed ? typed(newIr, ir.type) : ir
  }
  if (op === 'block' && ir.length > 1) {
    const last = ir[ir.length - 1]
    const rewritten = tcoTailRewrite(last, resultType)
    if (rewritten !== last) return typed([...ir.slice(0, -1), rewritten], ir.type)
  }
  return ir
}

export function reconstructArgsWithSpreads(normal, spreads) {
  const combined = []
  let normalIdx = 0
  for (let targetPos = 0; targetPos <= normal.length; targetPos++) {
    for (const spread of spreads) {
      if (spread.pos === targetPos) {
        combined.push(['__spread', spread.expr])
      }
    }
    if (normalIdx < normal.length) {
      combined.push(normal[normalIdx++])
    }
  }
  return combined
}
