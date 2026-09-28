/**
 * Cross-family emitter helpers with ≥2 real consumers (verified by the property-level dependency scan in .work/emit-split.md, not proximity): stringOps/isI32Num/isNumArm (Arithmetic + Bitwise + Logical), CMP_SET/isCmp/BOOL_EXPR_OPS/isCanonicalBoolExpr (dispatch's toBool + Logical's &&/||), eagerSelectOK/selectOK/boolEagerBody (same dual use), REF_EQ_KINDS (Comparisons' emitLooseEq + Logical's ?:), isLit1/foldOperandPure (Arithmetic's % + Comparisons' emitTypeofCmp/effectFoldSeq).
 *
 * @module compile/emit/shared
 */

import { MUTATE_OPS, REFS_THROUGH_ARROWS, some, walkAst } from '../../ast.js'
import { jsstring } from '../../abi/string.js'
import { ctx, getFactStore } from '../../ctx.js'
import { dataDependentFlag, hasExpensiveOp, isPureIR, resolveValType } from '../../ir.js'
import { valTypeOf } from '../../kind.js'
import { VAL, lookupValType, repOf } from '../../reps.js'
import { plannedTypedStorageCtor } from '../typed-storage-plan.js'

/** Captured receivers retain the facts their builtin emitter consumes. */
export function copyReceiverFacts(source, target) {
  const kind = valTypeOf(source), ctor = plannedTypedStorageCtor(ctx, source)
  if (kind) ctx.func.localValTypesOverlay.set(target, kind)
  ctx.func.taggedLocals ??= new Set()
  ctx.func.taggedLocals.add(target)
  if (ctor) (ctx.func.localTypedElemsOverlay ||= new Map()).set(target, ctor)
  const regex = typeof source === 'string' ? ctx.runtime.regex?.vars.get(source)
    : Array.isArray(source) && source[0] === '//' ? source : null
  if (regex) ctx.runtime.regex.vars.set(target, regex)
}

export const stringOps = (node) => {
  const rep = typeof node === 'string' ? repOf(node) : null
  return rep?.carrier === 'jsstring' ? jsstring.ops : ctx.abi.string.ops
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
// May two i32 operands share one i32 `if`/`select` join? Both plain (numbers,
// bools), or both one pointer kind and aux. A pointer beside a plain value, or
// two pointer kinds, must box each arm by its own kind instead: the single
// widening downstream of a joined i32 converts a pointer's offset numerically
// (`typeof` → "number", a store through it traps). Returns the tagger that
// carries the shared pointer kind onto the joined node, or null.
export const i32JoinRep = (a, b) => {
  const bothPlain = a.ptrKind == null && b.ptrKind == null
  const samePtr = a.type === 'i32' && b.type === 'i32' && a.ptrKind != null && a.ptrKind === b.ptrKind && (a.ptrAux ?? null) === (b.ptrAux ?? null)
  if (!bothPlain && !samePtr) return null
  return (n) => {
    if (samePtr) { n.ptrKind = a.ptrKind; if (a.ptrAux != null) n.ptrAux = a.ptrAux }
    return n
  }
}
// A `select` evaluates BOTH ARMS BEFORE its condition (wasm operand order), so a
// condition that writes what an arm reads would hand that arm the old value:
// `(t = h + n - 1) >= D ? t - D : t`. Arms admitted by eagerSelectOK read only
// locals and globals (no loads, no calls), so those writes are the ones that
// matter; a call in the condition may write any global.
export const condWritesArmReads = (cond, ...arms) => {
  const written = new Set()
  let calls = false
  some(cond, n => {
    const op = n[0]
    if (op === 'local.set' || op === 'local.tee' || op === 'global.set') written.add(n[1])
    else if (op === 'call' || op === 'call_indirect' || op === 'return_call') calls = true
    return false
  }, REFS_THROUGH_ARROWS)
  if (!written.size && !calls) return false
  return arms.some(arm => some(arm, n => (n[0] === 'local.get' && written.has(n[1]))
    || (n[0] === 'global.get' && (calls || written.has(n[1]))), REFS_THROUGH_ARROWS))
}
// May `cond ? b : c` be a `select`? Its arms must be eager-safe (eagerSelectOK),
// the condition must write nothing they read (above), and the condition is a cost
// axis of its own: one that lowers to a nested value-`if` over a memory load
// (dataDependentFlag, ir.js: the short-circuit `&&`/`||` shape) pays load latency
// unconditionally when fed eagerly into `select`, where the lazy if/else it came
// from would only pay it when the fast clause passed. Every `?:` select site
// goes through this gate before choosing `select` over `if`.
export const selectOK = (cond, ...arms) => eagerSelectOK(...arms) && !dataDependentFlag(cond) && !condWritesArmReads(cond, ...arms)
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

// No writes, calls, closures or explicit throw. Loads, member reads and arithmetic
// may still trap, so this does not prove an expression safe to speculate.
const SIDE_EFFECT_OPS = new Set([...MUTATE_OPS, '()', '=>', 'throw', 'new', 'await', 'yield'])
export const isSideEffectFree = (n) => {
  if (!Array.isArray(n)) return true
  if (typeof n[0] === 'string' && SIDE_EFFECT_OPS.has(n[0])) return false
  for (let i = 1; i < n.length; i++) if (!isSideEffectFree(n[i])) return false
  return true
}
