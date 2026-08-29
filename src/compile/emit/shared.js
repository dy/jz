/**
 * Cross-family emitter helpers with ≥2 real consumers (verified by the property-level dependency scan in .work/emit-split.md, not proximity): stringOps/isI32Num/isNumArm (Arithmetic + Bitwise + Logical), CMP_SET/isCmp/BOOL_EXPR_OPS/isCanonicalBoolExpr (dispatch's toBool + Logical's &&/||), eagerSelectOK/selectCondOK/boolEagerBody (same dual use), REF_EQ_KINDS (Comparisons' emitLooseEq + Logical's ?:), isLit1/foldOperandPure (Arithmetic's % + Comparisons' emitTypeofCmp/effectFoldSeq).
 *
 * @module compile/emit/shared
 */

import { walkAst } from '../../ast.js'
import { ctx, getFactStore } from '../../ctx.js'
import { dataDependentFlag, hasExpensiveOp, isPureIR, resolveValType } from '../../ir.js'
import { valTypeOf } from '../../kind.js'
import { VAL, lookupValType, repOf } from '../../reps.js'


export const stringOps = (node) => {
  const rep = typeof node === 'string' ? repOf(node) : null
  return ctx.abi.resolve('string', rep)?.ops ?? ctx.abi.string.ops
}


// === Emitter state & operand classification ===

// Current emission "expect" mode ('void' or null); set by emit(), read by
// compound-assignment emitters (here and in emit-assign.js — shared via ctx so
// the module graph stays acyclic) to decide between value-returning and
// side-effect-only forms. Transient: meaningful only within one dispatch.

// A genuine i32 *number* — safe for the i32 fast path in arithmetic/bitwise
// operators. An unboxed pointer (object/array/string/closure local kept as a
// raw i32 handle) is *also* i32-typed but carries `.ptrKind`; treating it as a
// number would compute on raw pointer bits. A ptrKind-carrying operand must
// instead route through ToNumber (`toNumF64`), which performs ToPrimitive.
export const isI32Num = (v) => v.type === 'i32' && v.ptrKind == null

// Is an emitted arm `v` (AST `node`) a plain NUMBER? The predicate the two-arm merges
// (?:, ??) share to decide canon: an i32 number, NUMBER-tagged IR, or a NUMBER
// value-type qualifies; a pointer/opaque arm does not. `vt` is the node's resolved
// value-type — pass it when already computed to avoid the re-resolve.
export const isNumArm = (v, node, vt = resolveValType(node, valTypeOf, lookupValType)) =>
  isI32Num(v) || v.valKind === VAL.NUMBER || vt === VAL.NUMBER

export const CMP_SET = new Set(['>', '<', '>=', '<=', '==', '!=', '!'])
export const isCmp = n => Array.isArray(n) && CMP_SET.has(n[0])
const BOOL_EXPR_OPS = new Set(['>', '<', '>=', '<=', '==', '!=', '===', '!==', '!'])
export const isCanonicalBoolExpr = n => Array.isArray(n) &&
  (BOOL_EXPR_OPS.has(n[0]) ||
    ((n[0] === '&&' || n[0] === '||' || n[0] === '__eager&&' || n[0] === '__eager||') &&
      isCanonicalBoolExpr(n[1]) && isCanonicalBoolExpr(n[2])))
// Eager-select gate: pure (no trap/effect) AND cheap. isPureIR alone admits f64.div/
// f64.sqrt — correct for `select` (no trap), but eagerly computing a division/sqrt-
// bearing arm that a branch would have skipped can cost more than a mispredict. Every
// select-gate call site (below, and the post-watr if→select fold in optimize/index.js)
// uses this instead of a bare isPureIR check.
export const eagerSelectOK = (...ns) => ns.every(n => isPureIR(n) && !hasExpensiveOp(n))
// Separate cost axis from eagerSelectOK: that gate gauges the select's ARMS
// (vb/vc — the values chosen between); this gauges the select's CONDITION. A cond
// that lowers to a nested value-`if` over a memory load (dataDependentFlag, ir.js —
// the short-circuit `&&`/`||` shape) pays load latency unconditionally when fed
// eagerly into `select`, where the lazy if/else it came from would only pay it when
// the fast clause passed. Every `?:` select site below composes this with
// eagerSelectOK(arms) before choosing `select` over `if`.
export const selectCondOK = (cond) => !dataDependentFlag(cond)
// Eager boolean chains win in leaf numeric kernels but regress orchestration/
// compiler code whose first guard usually rejects before a costly RHS. Keep
// the latency trade in call-free bodies; nested closures are separate bodies.
// Memoised per body (AdHocMemo retirement — ctxfunc-survey.md §2/§5: WeakMap
// on body identity, getFactStore().boolEager, same idiom as type.js's
// inBoundsCharCodeAt). The cached value is a boolean, so the lookup uses
// `.has()`, not truthiness — `false` is a valid cached result. A non-array
// body can't be a WeakMap key; `walk` itself no-ops on one (never sets
// `calls`), so the vacuous answer is `true`, returned uncached.
export const boolEagerBody = () => {
  const body = ctx.func.body
  if (!Array.isArray(body)) return true
  const cache = getFactStore().boolEager
  if (cache.has(body)) return cache.get(body)
  let calls = false
  // body itself may be an arrow (curried fn value: `a => b => …`) — the root
  // is still probed for its own children; only a NESTED arrow is a boundary.
  walkAst(body, { enter: (n, parent) => {
    if (calls) return false
    if (parent !== null && n[0] === '=>') return false
    if (n[0] === '()' || n[0] === 'new') { calls = true; return false }
  } })
  const result = !calls
  cache.set(body, result)
  return result
}

// Pointer kinds for which JS `==` / `!=` is pure reference equality — i.e. i64 bit
// compare of the NaN-box is equivalent to __eq. Excludes STRING (content compare for
// heap strings) and BIGINT (content compare).
export const REF_EQ_KINDS = new Set([
  VAL.ARRAY, VAL.OBJECT, VAL.SET, VAL.MAP,
  VAL.BUFFER, VAL.TYPED, VAL.CLOSURE, VAL.REGEX, VAL.DATE,
])

export const isLit1 = (n) => Array.isArray(n) && n[0] == null && n[1] === 1

// Effect-preserving constant fold (re-audit P0): a statically-decided
// comparison still evaluates its operands exactly once, in source order —
// JS sequences operand evaluation before comparing, so a fold that skips
// an effectful operand erases `(n++, 0n)`-class effects and thrown
// exceptions. Pure operands — bare names and literal nodes (jz has no
// getters; locals and literals cannot observe evaluation) — keep the
// zero-cost direct constant.
export const foldOperandPure = (n) => typeof n === 'string' || !Array.isArray(n) ||
  n[0] == null || n[0] === 'str' || n[0] === 'bigint'
