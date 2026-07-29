/**
 * Boxed-bigint erasure diagnostic (round-3/4, design .work/bigint-round3-design.md
 * §2/§4.2). JZ_DBG_BIGINT_ERASURE=1-gated, zero cost otherwise.
 *
 * Empirical, read-only: walks each function's body (during analyzeFuncs, right
 * after analyzeFuncForEmit settles its reps — ctx.func is that function) and
 * records every point a statically VAL.BIGINT-kinded expression flows into a
 * kind-erasing W-sink per the design's §2 inventory:
 *   call-arg    — bigint value passed as a call argument (proof not re-verified
 *                 here; this is the raw inventory narrow.js's fixpoint consumes).
 *   return      — bigint value returned from a function.
 *   collection  — dyn-prop/array-element store (`o.k=v`/`o[k]=v`), or a
 *                 Set.add/Map.set/Map.get key argument.
 *   dataview    — DataView.setBig(U)Int64/getBig(U)Int64 receiver+value.
 *   ternary-nullish — a `?:` whose result kind is BIGINT via the nullish-arm
 *                 carry rule (kind.js VT['?:'], "the one kind with no runtime
 *                 tag" — risk 5 in the design).
 *   closure-capture — a bigint-kinded outer name referenced inside a `=>` body
 *                 (analyze.js's hard closure boundary at op === '=>').
 *
 * This module is the seed the real solver fact (analyze.js intra-body sink
 * walk, §3.2) and the real erasure-graph assert (§4.2) both grow from — same
 * sink taxonomy, first just observing, later gating box-emission and then
 * proving it happened.
 */
import { ctx } from '../ctx.js'
import { VAL } from '../reps.js'
import { valTypeOf } from '../kind.js'
import { commaList, collectParamNames, extractParams, isBlockBody } from '../ast.js'

export const DBG_BIGINT_ERASURE = typeof process !== 'undefined' && process.env?.JZ_DBG_BIGINT_ERASURE === '1'

// const + in-place truncation (never reassigned): a destructured
// `const { erasureHits } = await import(...)` snapshots the array reference
// once — reassigning this binding (`erasureHits = []`) would silently orphan
// that snapshot from every later push. Truncating keeps one object identity
// across resets, so both destructured and namespace-property access see the
// same live contents.
export const erasureHits = []
export const resetErasureHits = () => { erasureHits.length = 0 }

const shortNode = (n) => {
  try { return JSON.stringify(n).slice(0, 120) }
  catch { return String(n) }
}

const recordErasureHit = (sink, node, funcName) => {
  erasureHits.push({ sink, func: funcName ?? ctx.func.current?.name ?? '(top)', node: shortNode(node) })
}

// AST nullish literal — same shape kind.js's local `nullishArm` checks.
const isNullishLit = (n) => n === 'undefined' ||
  (Array.isArray(n) && ((n.length === 2 && n[0] == null && n[1] == null) || n.length === 0))

const DATAVIEW_BIG_RE = /^(get|set)Big(Int|Uint)64$/

/** Free names referenced inside `node` that are NOT bound by `boundNames` — used
 *  to find bigint-kinded outer captures crossing a `=>` boundary. Best-effort:
 *  doesn't distinguish shadowing declarations inside the body, matching
 *  analyze.js's own closure-boundary discipline (it doesn't walk inside either). */
const freeNamesBigint = (body, boundNames, funcName, arrowNode) => {
  const seen = new Set()
  const walk = (n) => {
    if (typeof n === 'string') {
      if (!boundNames.has(n) && !seen.has(n) && valTypeOf(n) === VAL.BIGINT) {
        seen.add(n)
        recordErasureHit('closure-capture', arrowNode, funcName)
      }
      return
    }
    if (!Array.isArray(n)) return
    // Skip string-literal leaves (`['str', "..."]`) and property-name leaves.
    if (n[0] === 'str') return
    for (let i = 1; i < n.length; i++) walk(n[i])
  }
  walk(body)
}

/** Walk one function body recording every W-sink flow of a BIGINT-kinded value.
 *  Call right after analyzeFuncForEmit(func, programFacts) while ctx.func is
 *  still that function (valTypeOf needs its settled localReps/refinements). */
export function scanErasureSinks(func) {
  if (!DBG_BIGINT_ERASURE) return
  if (!func || func.raw) return
  const funcName = func.name

  // Expression-body arrow (`(v) => BigInt(v) * 2n`): func.body IS the return
  // value, never wrapped in an explicit 'return' node.
  if (!isBlockBody(func.body) && valTypeOf(func.body) === VAL.BIGINT)
    recordErasureHit('return', func.body, funcName)

  const walk = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]

    if (op === '=>') {
      // Closure boundary: params never count as captures; anything else
      // referenced from the enclosing scope that's proven BIGINT is a sink.
      const bound = collectParamNames(extractParams(node[1]))
      freeNamesBigint(node[2], bound, funcName, node)
      return  // don't walk inside — separate function context, matches analyze.js
    }

    if (op === 'return') {
      if (node[1] != null && valTypeOf(node[1]) === VAL.BIGINT) recordErasureHit('return', node, funcName)
    }

    if (op === '?:') {
      const [, cond, a, b] = node
      if (valTypeOf(node) === VAL.BIGINT && (isNullishLit(a) || isNullishLit(b)))
        recordErasureHit('ternary-nullish', node, funcName)
    }

    if (op === '()') {
      const callee = node[1]
      const args = commaList(node[2])
      const isMethod = Array.isArray(callee) && (callee[0] === '.' || callee[0] === '?.')
      const method = isMethod && typeof callee[2] === 'string' ? callee[2] : null

      if (method && DATAVIEW_BIG_RE.test(method)) {
        recordErasureHit('dataview', node, funcName)
      } else if (method === 'add' || method === 'set') {
        // Set.add(v) / Map.set(k,v) / Map.get(k) key-or-value bigint content.
        for (const a of args) {
          const arg = Array.isArray(a) && a[0] === '...' ? a[1] : a
          if (valTypeOf(arg) === VAL.BIGINT) { recordErasureHit('collection', node, funcName); break }
        }
      } else {
        for (const a of args) {
          const arg = Array.isArray(a) && a[0] === '...' ? a[1] : a
          if (valTypeOf(arg) === VAL.BIGINT) recordErasureHit('call-arg', node, funcName)
        }
      }
    }

    if (op === '=' || (typeof op === 'string' && op.length > 1 && op.endsWith('=') && op !== '==' && op !== '!=' && op !== '>=' && op !== '<=' && op !== '===' && op !== '!==')) {
      const lhs = node[1], rhs = node[2]
      if (Array.isArray(lhs) && (lhs[0] === '.' || lhs[0] === '[]' || lhs[0] === '?.')) {
        // Property/element store — dyn-prop or array-elem sink (collection.js
        // __dyn_set / __arr_set_idx_ptr per design §2 W-sinks 1-2).
        if (valTypeOf(rhs) === VAL.BIGINT) recordErasureHit('collection', node, funcName)
      }
    }

    for (let i = 1; i < node.length; i++) walk(node[i])
  }

  walk(func.body)
}
