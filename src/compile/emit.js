import { OPTF } from '../ctx.js'
/**
 * AST → WASM IR emission.
 *
 * # Stage contract
 *   IN:  prepared AST node + ctx state (func.locals/localReps/typedElem, etc.)
 *   OUT: IR node (array) with `.type` ('i32' | 'f64' | 'void'). For statements, a flat
 *        list of WASM instructions (no type tag).
 *   NO-MUTATE: emit does not rewrite the AST. Side effects go to ctx.runtime.*,
 *        ctx.core.includes (via inc()), ctx.func.uniq (local naming), and ctx.features.*.
 *
 * # Dispatch
 *   `emit(node, expect?)` handles literals inline and routes arrays to ctx.core.emit[op].
 *   `emitVoid(node)` emits + drops any value (statement context; routes block bodies to emitBlockBody).
 *   `emitBlockBody(node)` unwraps a `{}` block and concatenates flat statement IR.
 *
 * The emitter table (`emitter` export) is copied into ctx.core.emit by reset();
 * language modules add/override entries to extend dispatch.
 *
 * Low-level IR construction helpers live in `ir.js` and are imported below.
 *
 * @module emit
 */

// --- extracted family modules (src/compile/emit/) ---
import {
  CMP_SET, REF_EQ_KINDS, boolEagerBody, eagerSelectOK, foldOperandPure, isCanonicalBoolExpr, isCmp, isI32Num, isLit1, isNumArm, selectCondOK, stringOps,
} from './emit/shared.js'
import {
  addBoundedFaithful, addFitsI32, addLiteralFitsI32, addRangeFitsI32, i32Mag, loopGuardHi, mulBoundedFaithful, mulFitsI32, mulRangeFitsI32, subLiteralFitsI32, subRangeFitsI32,
} from './emit/i32-bounds.js'
import {
  FIRST_CLASS_BUILTIN_BODY, FIRST_CLASS_BUILTIN_NAMES, FIRST_CLASS_UNARY_MATH, builtinFunctionValue,
} from './emit/first-class.js'
export { FIRST_CLASS_BUILTIN_NAMES }
import {
  TYPED_HI_MASK, argIR, coerceArg, emit, emitBlockBody, emitBoolStr, emitCallArgs, emitDecl, emitIdentitySafe, emitIdentitySafeArms, emitIndex, emitVoid, rejectAmbiguousBoolIdentity, resolveClosureTableParamLattice, toBool, tryConcatChain,
} from './emit/dispatch.js'
export { emit, emitBlockBody, emitBoolStr, emitDecl, emitIdentitySafe, emitIndex, emitVoid, resolveClosureTableParamLattice, toBool }
import {
  I64_ARITH_OP, bigIntDomainsCanMix, bigIntJointDispatch, bigIntOperand, bigIntShiftIR, bigIntUnary, bigintMemberAssignTarget, bigintMixReject, computedBoxOf, numLiteralNode,
} from './emit/bigint.js'
import {
  attachSigMeta, buildArrayWithSpreads, emitMethodCallSpread, materializeMulti, parseCallArgs,
} from './emit/call-args.js'
export { buildArrayWithSpreads, materializeMulti }
import { emitMethodCall, storedValue } from './emit/method-dispatch.js'
import { callOps, tagFnArrayDispatch } from './emit/call.js'
import { emitInstanceof } from './emit/instanceof.js'
import { incdecOps } from './emit/incdec.js'
import { arithmeticOps } from './emit/arithmetic.js'
import {
  comparisonOps, emitTypeofCmp, isSideEffectFree, matchVoidLocalStore, numericVal,
} from './emit/comparisons.js'
export { emitTypeofCmp }
import { logicalOps } from './emit/logical.js'
// --- end extracted family modules ---

import {
  commaList, T, isBlockBody, isReassigned, mutatesArrayLength, isConstLiteral, constLiteralHoistable,
  hasOwnContinue, hasLabeledContinueTo, hasOwnBreakOrContinue, extractParams, classifyParam,
  PARAM_KIND, PARAM_NAME, PARAM_DEFAULT, PARAM_PATTERN, JZ_UNDEF, TYPEOF,
  ASSIGN_OPS, MUTATE_OPS, firstRefKind, isLeaf, walkAst, some,
} from '../ast.js'
import { ctx, err, inc, warnDeopt, PTR, ssoBitI64Hex, LAYOUT, DBG_INVARIANTS, emitArity, setLinkDemand, getFactStore } from '../ctx.js'
import {
  i64Hex, encodePtrHi, STR_HCACHE_BIT, typedElemAux, oobNanIR,
  OBJECT_SCHEMA_HI_MASK, objectSchemaGuardHex, TYPED_ELEM_NAMES, encodeTypedElemAux, TYPED_ELEM_VIEW_FLAG,
} from '../../layout.js'
import { ERR, ERR_CLASS_NAMES } from '../../err-codes.js'
import { bodyOnlyCharCodeAtCalls } from '../abi/string.js'
import { includeForStringOnly, includeForArrayLiteral, includeForRuntimeKeyIteration } from '../autoload.js'
import { nonNegIntLiteral, intLiteralValue, intExprRange, constIntExpr, staticPropertyKey, guardCounterName, forCounterRange } from '../static.js'
import { findFreeVars } from './analyze.js'
import {
  BINDING_USE_DECLS, BINDING_USE_USES, BINDING_USE_KIND, BINDING_USE_KEY,
  BINDING_USE_OPTIONAL, BINDING_USE_COMPUTED, BINDING_USE_OP, scanBindingUses, USE,
} from './analyze-scans.js'
import {
  containsNestedClosure, containsNestedLoop, nestedSmallLoopBudget,
  containsDeclOf, cloneWithSubst, containsKnownTypedArrayIndex,
  smallConstForTripCount, isTerminator, scanBoundedLoops, inBoundsCharCodeAt,
  exprType, MAX_SMALL_FOR_UNROLL, MAX_NESTED_FOR_UNROLL,
  inBoundsArrIdx, typedIdxProven, versionableTypedNest, idxKey, SLOT_OPS,
} from '../type.js'
import { BIGINT_JOINT_BINARY_OPS, valTypeOf, shapeOf, hasAmbiguousBoolMerge, censusMaybeUndefined, censusMaybeUndefinedKind, nullishArm } from '../kind.js'
import { VAL, lookupValType, repOf, updateRep, repOfGlobal } from '../reps.js'
import {
  typed, asF64, asI32, asI32Sat, asI64, asPtrOffset, asParamType, toI32, fromI64,
  NULL_IR, nullExpr, undefExpr, MAX_CLOSURE_ARITY, TRUE_NAN, FALSE_NAN, NULL_NAN,
  WASM_OPS, SPREAD_MUTATORS, BOXED_MUTATORS,
  mkPtrIR, ptrOffsetIR, ptrTypeIR, ptrTypeEq, dispatchByPtrType, sidecarOverride, valKindToPtr,
  isLit, litVal, isNullishLit, isPureIR, hasExpensiveOp, dataDependentFlag, emitNum, f64rem, toNumF64, toStrI64, maskBound,
  truthyIR, toBoolFromEmitted, isPostfix,
  isGlobal, isConst, usesDynProps, needsDynShadow,
  temp, tempI32, tempI64, allocPtr,
  block64, withTemp,
  boxedAddr, readVar, writeVar, isNullish, isNull, isUndef, isBoolAtom, throwTypeErrorIR,
  boolBoxIR, carrierF64, carrierF64Narrow, unboxBoolIR, boxBigInt, applyBigintRepresentationAction, maybeUnboxBigInt, isPlanTaggedBigint, readI64, bigintEraseErr, bigintStrict,
  isLiteralStr, resolveValType, isFuncRef,
  multiCount, loopTop, flat,
  reconstructArgsWithSpreads, tcoTailRewrite,
  extractF64Bits,
} from '../ir.js'
import { isBoundName, freshId } from '../ir.js'
import { extractRefinements, inferSchemaBranch, mergeRefinement, withRefinements } from './flow-types.js'
import { withArrayLiteralEscape, withControlFrame, withExpectedValue, withFinallyStack, withFunctionFields, withPendingLabel, withSchemaSpeculation, withTryState } from './flow-state.js'
import { emitElementAssign, emitPropertyAssign, persistBindingPtr } from './emit-assign.js'
import {
  JOIN_OPS, REP_EDGE_BOX, REP_EDGE_REJECT, REP_EDGE_UNBOX,
  recordClosureCallRepresentations, representationBindingWriteAction, representationCallArgAction, representationJoinArmAction, representationResultTagRequired, representationReturnAction,
  representationComputedExprAction, representationCompoundAssignAction, representationUnaryUpdateAction, representationStorageWriteAction, representationProgramHasBigint,
} from './representation-plan.js'
import { plannedTypedStorageCtor, plannedTypedStorageInfo } from './typed-storage-plan.js'

// Flow-sensitive type refinement moved to ./flow-types.js (extractRefinements,
// predicateRefinement, mergeRefinement, withRefinements). emit.js imports them
// from there — see the import block at the top of this file.

// Preserve the per-iteration SSA shape of block-scoped scalar scratch when a
// small loop is expanded. Reusing one wasm local for every unrolled `const x`
// makes it multi-def; LICM must then conservatively leave expressions such as
// `x*x + y*y` in an enclosing hot loop. Native optimizers retain one SSA value
// per source iteration and hoist each expression. Since closures are rejected
// by unrollSmallConstFor, a loop-body let/const binding has no observable
// identity across iterations and each emitted copy may use a fresh wasm local.
//
// Rename the already-emitted IR rather than the AST: analysis and all typed/
// schema proofs still run under the original binding, while the final scalar
// IR exposes independent defs to LICM. Pointer-shaped locals are excluded —
// their name can key side metadata (flat slots/schema/typed ctor); this pass is
// specifically for numeric/boolean scratch.
function freshenUnrolledScalarBindings(body, ir) {
  if (ctx.transform.optimize?.splitScratch !== true) return ir
  const names = new Set()
  const collect = n => {
    if (!Array.isArray(n) || n[0] === '=>') return
    if (n[0] === 'let' || n[0] === 'const') {
      for (let i = 1; i < n.length; i++) {
        const d = n[i]
        const name = Array.isArray(d) && d[0] === '=' ? d[1] : d
        if (typeof name === 'string') names.add(name)
      }
    }
    for (let i = 1; i < n.length; i++) collect(n[i])
  }
  collect(body)
  if (!names.size) return ir

  const rename = new Map()
  for (const name of names) {
    const type = ctx.func.locals.get(name)
    if (type !== 'i32' && type !== 'f64' && type !== 'i64' && type !== 'f32') continue
    if (ctx.func.boxed?.has(name) || ctx.func.flatObjects?.has(name) ||
        ctx.func.typedElem?.has(name)) continue
    const rep = ctx.func.localReps?.get(name)
    if (rep?.val != null && rep.val !== VAL.NUMBER && rep.val !== VAL.BOOL) continue
    const fresh = `${T}us${freshId(ctx)}_${name}`
    ctx.func.locals.set(fresh, type)
    rename.set(`$${name}`, `$${fresh}`)
  }
  if (!rename.size) return ir

  // HIR provenance link upkeep (.work/research.md §BodyModel slice 4 — found via its own
  // shadow-assert, vectorize.js's assertLoopPlanAgrees): this rename mutates local names IN
  // PLACE on the ALREADY-linked block node the nested loop's own 'for' emission minted a
  // LoopPlan for — the block's IDENTITY survives (same array), so loopPlanLink still resolves
  // it, but its `lowering.ivName`/`lowering.guardName` (captured pre-rename) would go STALE if a
  // renamed name was the loop's own induction/guard variable — exactly the small-const-unrolled-
  // outer-loop-with-nested-loop shape (`splitScratch`'s only use case). Keep the fact accurate
  // rather than evict it: a `block` descendant with a link gets its `lowering` name fields
  // carried through the SAME rename map — `plan` (the frozen HIR-side facts) is NEVER touched
  // (a rename is backend metadata, not a fact HIR proved). Metadata-only —
  // never touches `ir`'s own content, so this cannot affect emitted bytes.
  const rewrite = n => {
    if (!Array.isArray(n)) return
    if ((n[0] === 'local.get' || n[0] === 'local.set' || n[0] === 'local.tee') && rename.has(n[1]))
      n[1] = rename.get(n[1])
    else if (n[0] === 'block') {
      const link = ctx.plans.loweringLinks.get(n)
      if (link) {
        const { lowering } = link
        const ivKey = lowering.ivName != null ? `$${lowering.ivName}` : null
        if (ivKey && rename.has(ivKey)) lowering.ivName = rename.get(ivKey).slice(1)
        const gKey = lowering.guardName != null ? `$${lowering.guardName}` : null
        if (gKey && rename.has(gKey)) lowering.guardName = rename.get(gKey).slice(1)
      }
    }
    for (let i = 1; i < n.length; i++) rewrite(n[i])
  }
  for (const n of ir) rewrite(n)
  return ir
}

function unrollSmallConstFor(init, cond, step, body) {
  // Keep the overwhelmingly-common `for(i=0;i<N;i++)` path allocation-free;
  // only strided/nonzero-start control loops pay for an explicit value list.
  const simpleEnd = smallConstForTripCount(init, cond, step)
  let name, values = null, tripCount
  if (simpleEnd != null) {
    name = init[1][1]
    tripCount = simpleEnd
  } else {
    if (!Array.isArray(init) || init[0] !== 'let' || init.length !== 2 ||
        !Array.isArray(init[1]) || init[1][0] !== '=' || typeof init[1][1] !== 'string') return null
    name = init[1][1]
    const start = constIntExpr(init[1][2])
    if (start == null || !Array.isArray(cond) || cond[0] !== '<' || cond[1] !== name) return null
    const end = constIntExpr(cond[2])
    let delta = null
    if (Array.isArray(step) && step[0] === '++' && step[1] === name) delta = 1
    else if (Array.isArray(step) && step[0] === '+=' && step[1] === name) delta = constIntExpr(step[2])
    if (end == null || delta == null || delta <= 0 || start < 0 || start >= end) return null
    values = []
    for (let v = start; v < end && values.length <= MAX_SMALL_FOR_UNROLL; v += delta) values.push(v)
    if (!values.length || values.length > MAX_SMALL_FOR_UNROLL) return null
    tripCount = values.length
  }
  if (containsNestedLoop(body)) {
    const nestedMode = ctx.transform.optimize?.nestedSmallConstForUnroll
    if (nestedMode !== true && (nestedMode !== 'auto' || !containsKnownTypedArrayIndex(body))) return null
    const budget = tripCount * nestedSmallLoopBudget(body)
    if (budget > MAX_NESTED_FOR_UNROLL) {
      // A tiny outer CONTROL loop can still profitably specialize a large
      // inner kernel when its induction value selects machine operations
      // (radix shifts, lane selectors). The inner loops remain loops; code
      // growth is bounded directly instead of multiplying their trip counts.
      const controlsOp = some(body, n => (n[0] === '>>>' || n[0] === '>>' || n[0] === '<<') && n[2] === name)
      if (!controlsOp || tripCount > 4 || tripCount * forInBodyCost(body) > 600) return null
    }
  }
  if (hasOwnBreakOrContinue(body) || containsNestedClosure(body) || containsDeclOf(body, name)) return null
  if (isReassigned(body, name)) return null

  const out = []
  const emitCopy = value => {
    const copy = cloneWithSubst(body, name, value)
    out.push(...freshenUnrolledScalarBindings(copy, emitVoid(copy)))
  }
  if (values) for (const value of values) emitCopy(value)
  else for (let i = 0; i < simpleEnd; i++) emitCopy(i)
  return out
}

// Max distinct keys a for-in unrolls over (bounds code size; larger key sets keep
// the pooled-keys loop, which is already allocation-free via __keys_ro).
const FORIN_UNROLL_MAX = 16
// Total-expansion ceiling: unroll emits one body copy per key, so the size cost is
// keys × body, not keys alone. A large body over many keys (e.g. watr's 15-key
// schema loop) blows up code size for no deopt win — the pooled fallback is already
// allocation-free. Cap keys × nodeSize(body); past it, keep the loop. (Tuned above
// every unroll the corpus actually wants — the 16-key cap test lands at 80.)
const FORIN_UNROLL_BUDGET = 128
const forInBodyCost = (node) => {
  if (!Array.isArray(node)) return 1
  let n = 1
  for (let i = 1; i < node.length; i++) n += forInBodyCost(node[i])
  return n
}

// Pull the for-in source out of prepare's keys expression: either a bare
// `__keys_ro(src)` call or the nullish-guarded `cond ? [] : __keys_ro(src)`.
function keysRoSrc(node) {
  if (!Array.isArray(node)) return null
  if (node[0] === '()' && node[1] === '__keys_ro') return node[2]
  if (node[0] === '?:' || node[0] === '?') {
    const last = node[node.length - 1]
    if (Array.isArray(last) && last[0] === '()' && last[1] === '__keys_ro') return last[2]
  }
  return null
}

// Unroll `for (k in o)` over a static schema. Prepare lowers for-in to a plain
// for-loop whose key array comes from the for-in-exclusive `__keys_ro` intrinsic,
// so a loop carrying it IS a for-in. When `o` is a bare OBJECT var with a complete
// static schema (no computed-key writes — same gate as __keys_ro pooling), replace
// the loop with one substituted copy of the body per key: the loop variable becomes
// a string literal, so `o[k]` folds to a static schema slot — no keys array, no
// per-element dynamic get. Falls back (returns null) to the pooled loop otherwise.
function unrollForIn(init, cond, step, body) {
  if (!Array.isArray(init) || init[0] !== 'let' || !Array.isArray(init[1]) || init[1][0] !== '=') return null
  const ksVar = init[1][1]
  const src = keysRoSrc(init[1][2])
  if (typeof src !== 'string') return null
  if (!Array.isArray(cond) || cond[0] !== '<') return null
  const ixVar = cond[1]
  if (!Array.isArray(step) || step[0] !== '++' || step[1] !== ixVar) return null
  // body = [';', ['let', ['=', target, ['[]', ksVar, ixVar]]], ...realBody]
  if (!Array.isArray(body) || body[0] !== ';') return null
  const bind = body[1]
  if (!Array.isArray(bind) || bind[0] !== 'let' || !Array.isArray(bind[1]) || bind[1][0] !== '=') return null
  const target = bind[1][1]
  const acc = bind[1][2]
  if (!Array.isArray(acc) || acc[0] !== '[]' || acc[1] !== ksVar || acc[2] !== ixVar) return null

  // Unroll only with PROOF the schema is complete: a computed-key write adds
  // enumerable keys, so bail if `src` takes one — or if the fact is unavailable
  // (no proof ⇒ no unroll; unrolling drops the dynamic path, so erring safe matters).
  if (!ctx.types.dynWriteVars || ctx.types.dynWriteVars.has(src)) return null
  if (lookupValType(src) !== VAL.OBJECT) return null
  const keys = ctx.schema.resolve(src)
  if (!keys || !keys.length || keys.length > FORIN_UNROLL_MAX) return null
  // A literal-key write OUTSIDE the schema also adds an enumerable key (it
  // lands in the dyn sidecar) — same proof obligation as computed writes.
  const lw = ctx.types.literalWriteKeys?.get(src)
  if (lw) for (const k of lw) if (!keys.includes(k)) return null

  const rest = body.slice(2)
  const realBody = rest.length === 1 ? rest[0] : [';', ...rest]
  // Keep the pooled loop when unrolling would multiply a heavy body across many keys.
  if (keys.length * forInBodyCost(realBody) > FORIN_UNROLL_BUDGET) return null
  // Substitution safety, mirroring unrollSmallConstFor: no reassignment/redeclare
  // of the loop var, no nested closure capturing it (cloneWithSubst skips `=>`),
  // and no break/continue targeting this loop.
  if (hasOwnBreakOrContinue(realBody) || containsNestedClosure(realBody) || containsDeclOf(realBody, target)) return null
  if (isReassigned(realBody, target)) return null

  const out = []
  for (const key of keys) out.push(...emitVoid(cloneWithSubst(realBody, new Map([[target, ['str', key]]]))))
  return out.length ? out : ['nop']
}

function canThrow(body, seen = new Set()) {
  if (!Array.isArray(body)) return false
  const op = body[0]
  if (op === 'throw') return true
  // Unresolved ordinary `.length` now performs a real property Get, including
  // the nullish TypeError. Keep a surrounding source try/catch live even when
  // there is no explicit `throw` node in the AST. Optional chaining does not
  // throw and stays excluded.
  if (op === '.' && body[2] === 'length' && valTypeOf(body[1]) == null) return true
  if (op === '[]' && staticPropertyKey(body[2]) === 'length' && valTypeOf(body[1]) == null) return true
  if (op === '=>') return false
  if (op === '()') {
    const callee = body[1]
    // A call can throw unless we can see the whole callee and prove it can't:
    // only direct calls into a resolvable, non-raw function body are traceable.
    // Indirect/method/builtin calls (callee not a plain name, or a name we can't
    // resolve) are conservatively throwing — a user `try` must wrap them.
    if (typeof callee !== 'string') return true
    const bodyName = ctx.func.directClosures?.get(callee)
    const f = ctx.funcs.map?.get(bodyName || callee)
    if (!f?.body || f.raw) return true
    if (!seen.has(f.name)) {
      seen.add(f.name)
      if (canThrow(f.body, seen)) return true
    }
  }
  for (let i = 1; i < body.length; i++) if (canThrow(body[i], seen)) return true
  return false
}

// Loop-bound hoisting (see the 'for' emitter): comparison ops whose invariant side
// is worth lifting, and the test for an immutable, loop-stable `arr.length`. A typed
// array's length is fixed, so it is loop-invariant whenever `arr` is not reassigned.
// A plain array's length CAN change (push/pop/index-grow/length=), so it is hoistable
// only when the loop body provably never mutates it — `mutatesArrayLength` decides that.
const HOIST_CMP = new Set(['<', '<=', '>', '>='])
const immutableLenBound = (node, body) => {
  // Unwrap the `| 0` i32 coercion jz wraps a loop bound in (`i < arr.length`
  // emits `i < (arr.length | 0)`).
  if (Array.isArray(node) && node[0] === '|' && Array.isArray(node[2]) && node[2][0] == null && node[2][1] === 0)
    node = node[1]
  if (!(Array.isArray(node) && node[0] === '.' && node[2] === 'length' && typeof node[1] === 'string')) return false
  const vt = lookupValType(node[1])
  if (vt === VAL.TYPED) return !isReassigned(body, node[1])
  if (vt === VAL.ARRAY) return !mutatesArrayLength(body, node[1])
  return false
}

// Pull `const x = <array/object literal>` decls out of a loop body when the literal is
// deeply constant and `x` is provably read-only + non-escaping in the loop (so a single
// shared allocation is sound) — otherwise the constant table is re-allocated every
// iteration. Returns { hoisted: [decl…], body: strippedBody } or null. Only top-level
// statements of the loop body are considered.
const extractHoistableLiterals = (body) => {
  let stmts, rebuild
  if (Array.isArray(body) && body[0] === '{}' && Array.isArray(body[1]) && body[1][0] === ';') {
    stmts = body[1].slice(1); rebuild = kept => ['{}', [';', ...kept]]
  } else if (Array.isArray(body) && body[0] === ';') {
    stmts = body.slice(1); rebuild = kept => kept.length === 1 ? kept[0] : [';', ...kept]
  } else return null
  const hoisted = [], kept = []
  for (const s of stmts) {
    const lit = Array.isArray(s) && (s[0] === 'const' || s[0] === 'let') && s.length === 2
      && Array.isArray(s[1]) && s[1][0] === '=' && typeof s[1][1] === 'string' ? s[1][2] : null
    if (lit && Array.isArray(lit) && lit[0] === '[' && isConstLiteral(lit) && constLiteralHoistable(body, s[1][1]))
      hoisted.push(s)
    else kept.push(s)
  }
  return hoisted.length ? { hoisted, body: rebuild(kept) } : null
}

/** Emit pending `finally` cleanups for an abrupt control-flow exit.
 *  Inner cleanups run before outer cleanups. While emitting each cleanup, remove
 *  it from the active stack so `return` inside `finally` does not re-enter it.
 *  `minDepth` scopes the exit: only trys ENTERED at control-frame depth >= minDepth
 *  are being exited by this branch. A `continue`/`break` targeting a loop that
 *  CONTAINS the try runs its finally (the branch leaves the try body); a try that
 *  contains the whole loop stays live (control never leaves it) and must not run —
 *  each entry records ctx.func.stack.length at try entry, so a frame at index i
 *  scopes to entries with depth > i. `return` exits every frame (minDepth 0). */
function emitFinalizers(minDepth = 0) {
  const stack = ctx.func.finallyStack || []
  if (stack.length === 0) return []
  const saved = stack.slice()
  const out = []
  for (let i = saved.length - 1; i >= 0 && saved[i].depth >= minDepth; i--)
    out.push(...withFinallyStack(saved.slice(0, i), () => emitVoid(saved[i].cleanup)))
  return out
}

// `(a / b) | 0` (the JS integer-division idiom) → i32.div_s. jz otherwise lowers `/`
// to f64.div + ToInt32, paying two i32→f64 converts and the trunc; i32.div_s is
// direct and lets the wasm backend magic-multiply a constant divisor. Bit-exact for
// all i32 a,b: |a|<2³³≪2⁵³ so the f64 quotient never rounds across the truncation
// boundary — EXCEPT b=0 (`(a/0)|0` is ToInt32(±Inf)=0, but i32.div_s traps) and
// INT_MIN/-1 (ToInt32 wraps to INT_MIN, i32.div_s traps); both guarded. A constant
// divisor folds the guards away. `exprType==='i32'` excludes unsigned operands
// (those return 'f64'), where div_s would misread the sign. Returns IR or null.
const INT_MIN_I32 = -2147483648
function tryIntDivTrunc(aNode, bNode) {
  const o = ctx.transform.optimize
  if (!o || o.intDivLower === false) return null
  const L = ctx.func.locals
  if (exprType(aNode, L) !== 'i32' || exprType(bNode, L) !== 'i32') return null
  const dv = intLiteralValue(bNode)
  if (dv != null) {                         // constant divisor — no runtime guard
    const va = asI32(emit(aNode))
    if (dv === 0) return typed(['block', ['result', 'i32'], ['drop', va], ['i32.const', 0]], 'i32')
    if (dv === -1) return typed(['i32.sub', ['i32.const', 0], va], 'i32')  // -a, wraps at INT_MIN
    // Power-of-two divisor with a PROVEN-non-negative dividend truncates the
    // same as a logical shift (`(dq/65536)|0` ≡ `dq >>> 16` for dq ≥ 0 — the
    // q16 fixed-point split). intExprRange supplies the proof through masked/
    // ternary/bounded-product decl chains; sdiv is ~13 cycles, shr is 1.
    if (dv > 0 && (dv & (dv - 1)) === 0) {
      const r = intExprRange(aNode)
      if (r && r[0] >= 0) return typed(['i32.shr_u', va, ['i32.const', 31 - Math.clz32(dv)]], 'i32')
    }
    return typed(['i32.div_s', va, ['i32.const', dv | 0]], 'i32')
  }
  // Runtime divisor needs a,b repeated across the guard; only intercept when both are
  // simple re-emittable operands (var / literal) so re-emit is pure and side-effect-free.
  const simple = (n) => typeof n === 'string' || intLiteralValue(n) != null
  if (!simple(aNode) || !simple(bNode)) return null
  const A = () => asI32(emit(aNode)), B = () => asI32(emit(bNode))
  return typed(['if', ['result', 'i32'], ['i32.eqz', B()],
    ['then', ['i32.const', 0]],
    ['else', ['if', ['result', 'i32'],
      ['i32.and', ['i32.eq', A(), ['i32.const', INT_MIN_I32]], ['i32.eq', B(), ['i32.const', -1]]],
      ['then', A()],
      ['else', ['i32.div_s', A(), B()]]]]], 'i32')
}

/**
 * Fresh per-iteration heap cells for boxed (closure-captured) locals declared
 * in a loop body. ECMAScript establishes the per-iteration environment at the
 * START of each iteration, so the cell must exist before ANY body statement —
 * including a closure declared *before* the binding (mutual recursion, or a
 * `function` decl jzify hoists above its captures). Allocating at the decl point
 * instead would let an earlier closure capture the previous iteration's (stale)
 * cell while the binding reads/writes the freshly-allocated one. `emitDecl` then
 * stores the initializer into this cell rather than re-allocating (see
 * `frame.loopFresh`). Returns the alloc IR to splice at loop-body entry.
 */
export function emitLoopFreshBoxed(body, frame) {
  if (!ctx.func.boxed?.size) return []
  const names = new Set()
  ;(function scan(node) {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=>' || op === 'for' || op === 'for-of' || op === 'for-in' || op === 'while' || op === 'do') return
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        const nm = Array.isArray(d) && d[0] === '=' ? d[1] : d
        if (typeof nm === 'string' && ctx.func.boxed.has(nm)) names.add(nm)
      }
    }
    for (let i = 1; i < node.length; i++) scan(node[i])
  })(body)
  if (!names.size) return []
  frame.loopFresh = names
  const inits = []
  for (const name of names) {
    const cell = ctx.func.boxed.get(name)
    ctx.func.locals.set(cell, 'i32')
    inits.push(
      ['local.set', `$${cell}`, ['call', '$__alloc', ['i32.const', 8]]],
      ['f64.store', ['local.get', `$${cell}`], undefExpr()])
  }
  return inits
}

/** Compound assignment: read → op → write back (via readVar/writeVar).
 *  `arithOp` (one of '+' '-' '*' '/' '%') is the base symbol for BigInt routing;
 *  omit it for ops that only exist elsewhere for BigInt (this fn is never called
 *  for '&='/etc — those have their own i64 gate right below in the dispatch table). */
function compoundAssign(name, val, f64op, i32op, arithOp) {
  if (typeof name === 'string' && isConst(name)) err(`Assignment to const '${name}' — const bindings can't be reassigned after initialization; declare it with let instead`)
  const void_ = ctx.func._expect === 'void'
  // BigInt target/operand: route through the SAME i64 arithmetic the spelled-out
  // binary form uses (asI64 both sides, i64.<op>, fromI64) — see e.g. binary '+'
  // below (asI64(emit(a)), i64.add, fromI64). The f64 path further down silently
  // rounds away magnitude ≥ 2^53 for a proven-BIGINT accumulator: `n += 1n` on a
  // large n was a no-op (f64.add(n, 1) == n once n exceeds f64's integer precision).
  // bigintMixReject keeps the same TypeError-on-provable-mix contract the binary
  // op enforces (`n += 1` on a BigInt n throws in JS, not silently masks to 0).
  if (arithOp && (valTypeOf(name) === VAL.BIGINT || valTypeOf(val) === VAL.BIGINT)) {
    bigintMixReject(`${arithOp}=`, name, val)
    // `name` is always a bare identifier here — censusMaybeUndefined never fires
    // true for it (that predicate only matches `.`/`[]`/`.get()` AST shapes), so
    // readVar(name) stays the plain raw path; only `val` (the RHS, which CAN be a
    // dict/Map maybeUndefined read) needs bigIntOperand's runtime guard.
    const rawBits = [`i64.${I64_ARITH_OP[arithOp]}`, readI64(name, readVar(name)), bigIntOperand(val)]
    // Shape #6 emission companion: this op always computes a FRESH raw i64
    // result (readI64 unboxed the input, i64.<op> ran) — when `name` is
    // plan-materialized BOXED, that raw result must be boxed before it lands
    // back in name's storage slot, or the next plan-aware read (readI64's
    // own isPlanTaggedBigint arm) misreads its raw i64 bits as a box
    // pointer. representationBindingWriteAction can't be reused here: it
    // keys off the AST node collectDefs recorded as this def's rhs (the
    // whole compound node), which this handler never receives — only
    // `name`/`val`. representationCompoundAssignAction is the name-keyed
    // twin (source is always RAW_BIGINT here, by construction — so the
    // action is only ever KEEP/BOX/REJECT, never UNBOX; applied directly
    // rather than through applyBigintRepresentationAction's valTypeOf(node)
    // gate, which would wrongly veto on a proven-bigint LITERAL operand
    // paired with a not-yet-proven `name`, per bigintMixReject's own
    // asymmetric OR guard just above).
    return writeVar(name,
      representationCompoundAssignAction(ctx, name) === REP_EDGE_BOX ? boxBigInt(rawBits) : fromI64(rawBits),
      void_)
  }
  const va = readVar(name), vb = emit(val)
  // Peel f64.convert_i32_s/u when va is i32 — typed-array integer reads wrap their
  // i32.load in convert_i32_* by default, but the i32 arithmetic path can use the
  // raw i32 directly (eliminates per-iter widen + saturating-trunc roundtrip on
  // hot accumulator loops like `let s = 0; for (...) s += i32arr[i]`).
  let vbi = vb
  if (i32op && va.type === 'i32' && vb.type !== 'i32' &&
      Array.isArray(vb) && (vb[0] === 'f64.convert_i32_s' || vb[0] === 'f64.convert_i32_u')) {
    const inner = vb[1]
    vbi = Array.isArray(inner) ? typed(inner, 'i32') : inner
  }
  // INVARIANT: this admission needs the magnitude gate —
  // worse than the old (already-unsound) mulFitsI32, which needed at least one
  // bound. `name op= val` desugars to the exact binary-op arithmetic below, so
  // it must pass the SAME bilateral-bound proof the binary `+`/`-`/`*` operators
  // now require (addFitsI32/mulFitsI32 + their typed-magnitude/AST-range twins,
  // reused verbatim — no second bound tracker). Matters when this compound-
  // assign's OWN result crosses to a DIFFERENT (non-i32) consumer as a VALUE
  // (`y = (x *= huge)` with y f64-typed) — an unfaithfully-wrapped i32 result
  // would be trusted at THAT boundary the same way a bare `return` trusts one
  // (fixed alongside this at narrowI32Results, narrow.js). Value-neutral for
  // the common "write straight back into x's own i32 storage" case either way
  // (ir.js `writeVar` now coerces via `toI32`, which recovers the identical
  // wrapped result through narrowI32 when this gate falls to the f64 arm).
  // `%`/bitwise compounds reach here with no arithOp or an inherently-sound
  // op, so they stay ungated.
  const compoundFitsI32 = arithOp === '*' ? (mulFitsI32(va, vbi) || mulBoundedFaithful(va, vbi) || mulRangeFitsI32(name, val))
    : arithOp === '+' ? (addFitsI32(va, vbi) || addBoundedFaithful(va, vbi) || addRangeFitsI32(name, val))
    : arithOp === '-' ? (addFitsI32(va, vbi) || addBoundedFaithful(va, vbi) || subRangeFitsI32(name, val))
    : true
  if (i32op && va.type === 'i32' && vbi.type === 'i32' && compoundFitsI32)
    return writeVar(name, i32op(va, vbi), void_)
  // Both operands coerce like '+' operands: toNumF64 folds a checked read's
  // UNDEF miss arm to canonical NaN and ToNumber-coerces non-numeric carriers,
  // while proven-NUMBER values pass through unchanged (asF64 identity — hot
  // accumulators pay nothing). A bare asF64 carries a sentinel payload through
  // f64 arithmetic to the boundary (decoded back as `undefined`; JS: NaN) —
  // `s += a[i]` and `let u; s += u` are accumulator shapes the binary '+'
  // emitter never sees.
  return writeVar(name, f64op(asF64(toNumF64(name, va)), asF64(toNumF64(val, vb))), void_)
}

// === Core emitter dispatch table ===
// ctx.core.emit is seeded with a flat copy of this object on reset;
// language modules add or override ops on ctx.core.emit directly.

/**
 * Core emitter table. Maps AST ops to WASM IR generators.
 * @type {Record<string, (...args: any[]) => Array>}
 */
export const emitter = {
  // === Spread operator ===
  // Note: spread is handled specially in call contexts; this catches stray uses
  '...': () => err('Spread (...) can only be used in function/method calls or array literals'),

  // === Statements ===

  ';': (...args) => {
    const out = []
    for (const a of args) {
      out.push(...emitVoid(a))
      // Same dead-tail truncation as emitBlockBody's own statement loop (see
      // that function's comment for the full rationale) — needed HERE too,
      // separately: a `;`-list can arrive at emit already NESTED one level
      // inside a `{}`-block's own list (e.g. jzify's `do…while` desugaring —
      // transform.js `'do'` — wraps the loop body as `[';', flagReset,
      // userBody]`, so a user body of `break; FOR1;` lands as ONE list item,
      // `[';', ['break'], 'FOR1']`, from emitBlockBody's OUTER loop — that
      // loop's own isTerminator check sees only the LAST inner statement
      // (FOR1, not a terminator) and never looks inside). Without this, a
      // bare `break`/`continue`/`return`/`throw` mid-list here left its
      // FOLLOWING dead siblings walked anyway, wrongly hitting the bare-
      // identifier-fallback reject (src/compile/emit.js) for code real JS
      // never evaluates (confirmed live via test262 statements/break+continue/
      // line-terminators.js's ASI-split shape, a do…while body).
      if (isTerminator(a)) break
    }
    return out
  },
  '{': (...args) => args.map(emit).filter(x => x != null),
  ',': (...args) => {
    const results = args.map(emit).filter(x => x != null)
    if (results.length === 0) return null
    if (results.length === 1) return results[0]
    const last = results[results.length - 1]
    // Flatten: multi-instruction arrays (from ';') need spreading, typed nodes need drop
    const spread = r => Array.isArray(r) && Array.isArray(r[0]) ? r : [r]
    const dropSpread = r => r.type ? [['drop', r]] : spread(r)
    // If last expression is void (store, etc.), add explicit return value
    if (!last.type) {
      return block64(
        ...results.flatMap(dropSpread),
        ['f64.const', 0])
    }
    const seq = typed(['block', ['result', last.type],
      ...results.slice(0, -1).flatMap(dropSpread), last], last.type)
    // The sequence's VALUE is `last` — carry its value metadata, or downstream
    // coercions misread the carrier: an i32 OBJECT/CLOSURE pointer without its
    // ptrKind gets f64.convert_i32_s'd (`return (fn.a = 1, fn)` returned the raw
    // heap offset as a number). Same bug-class as the ternary's tagPtr (below).
    if (last.ptrKind != null) { seq.ptrKind = last.ptrKind; if (last.ptrAux != null) seq.ptrAux = last.ptrAux }
    if (last.unsigned) seq.unsigned = last.unsigned
    return seq
  },
  'let': emitDecl,
  'const': emitDecl,
  'export': () => null,
  // 'block' can appear from jzify transforming labeled blocks or as WASM block IR
  'block': (...args) => {
    // WASM block IR: first arg is ['result', type] → pass through, preserve type
    if (Array.isArray(args[0]) && args[0][0] === 'result')
      return typed(['block', ...args], args[0][1])
    const inner = args.length === 1 ? args[0] : [';', ...args]
    return emitVoid(['{}', inner])
  },

  'throw': expr => {
    ctx.runtime.throws = ctx.runtime.userThrows = true
    const thrown = temp()
    // The exception payload is an untyped ANY slot — exactly the boxed-value
    // contract storedValue exists for (container stores, collection keys/
    // values, generic call args; see its own doc comment above). A plain
    // `asF64(emit(expr))` was the 18th unnamed site of the MECHANISM A gap
    // bridge.js's storedValue doc comment describes: a bare Boolean thrown
    // value (`throw true`) emits as a raw i32 0/1 then f64-converts to a
    // plain 0.0/1.0 float — bit-identical to a genuinely thrown 0/1 number —
    // so `catch (e) { e === true }` reads false and `typeof e` reads
    // 'number', both wrong per ES 12.13 (audit-#12, BOOL_CARRIER family).
    // storedValue also correctly boxes an AMBIGUOUS BOOL∪NUMBER throw
    // (`throw cond && 1`) via emitIdentitySafe, and leaves every other kind
    // (number/string/object/BigInt) byte-identical to the old asF64(emit()).
    return typed(['block',
      ['local.set', `$${thrown}`, storedValue(expr)],
      ['global.set', '$__jz_last_err_bits', ['i64.reinterpret_f64', ['local.get', `$${thrown}`]]],
      ['throw', '$__jz_err', ['local.get', `$${thrown}`]]], 'void')
  },

  'catch': (body, errName, handler) => {
    if (!canThrow(body)) return emitVoid(body)

    ctx.runtime.throws = ctx.runtime.userThrows = true
    const id = freshId(ctx)
    ctx.func.locals.set(errName, 'f64')
    const bodyIR = withTryState(true, () => emitVoid(body))
    const handlerIR = emitVoid(handler)
    return typed(['block', `$outer${id}`, ['result', 'f64'],
      ['block', `$catch${id}`, ['result', 'f64'],
        ['try_table', ['catch', '$__jz_err', `$catch${id}`],
          ...bodyIR],
        ['f64.const', 0],
        ['br', `$outer${id}`]],
      ['local.set', `$${errName}`],
      // This catch fully HANDLES the error — nothing downstream
      // rethrows it — so $__jz_last_err_bits must not keep pointing at it. Left
      // set, a LATER genuine trap (OOB, stack overflow, …) unrelated to this
      // catch would read this stale marker at the host boundary and misdecode
      // as the already-handled error instead of a RuntimeError (interop.js's
      // decodeThrown only resets the marker on a decode that reaches the host —
      // an error fully handled in-wasm never does). Zeroed here, BEFORE the
      // handler runs, mirroring decodeThrown's own "consume on every decode"
      // reset — a `throw` inside the handler (rethrow or a new error) sets the
      // marker again via the 'throw' emitter above, so escaping-throw decode is
      // unaffected.
      ['global.set', '$__jz_last_err_bits', ['i64.const', 0]],
      ...handlerIR,
      ['f64.const', 0]], 'f64')
  },

  'finally': (body, cleanup) => {
    if (!canThrow(body)) {
      const parentStack = ctx.func.finallyStack || []
      const activeStack = parentStack.concat([{ cleanup, depth: ctx.func.stack.length }])
      const bodyIR = withFinallyStack(activeStack, () => emitVoid(body))
      const cleanupIR = isTerminator(body) ? [] : withFinallyStack(parentStack, () => emitVoid(cleanup))
      return [...bodyIR, ...cleanupIR]
    }

    ctx.runtime.throws = ctx.runtime.userThrows = true
    const id = freshId(ctx)
    const errLocal = temp('err')
    const parentStack = ctx.func.finallyStack || []
    const activeStack = parentStack.concat([{ cleanup, depth: ctx.func.stack.length }])

    const bodyIR = withTryState(true, () => withFinallyStack(activeStack, () => emitVoid(body)))
    const normalCleanup = withFinallyStack(parentStack, () => emitVoid(cleanup))
    const throwCleanup = withFinallyStack(parentStack, () => emitVoid(cleanup))

    return ['block', `$fin_done${id}`,
      ['block', `$fin_catch${id}`, ['result', 'f64'],
        ['try_table', ['catch', '$__jz_err', `$fin_catch${id}`],
          ...bodyIR],
        ...normalCleanup,
        ['br', `$fin_done${id}`]],
      ['local.set', `$${errLocal}`],
      // Mirrors 'catch' above: zero BEFORE throwCleanup runs, not
      // after. Two outcomes, both correct: (1) throwCleanup falls through
      // normally → the rethrow below unconditionally re-sets the marker to
      // errLocal's real bits before throwing, so escaping-throw decode is
      // unaffected. (2) throwCleanup itself terminates early (a `return`/`break`
      // in the `finally` block, which per spec SWALLOWS the pending exception —
      // the rethrow below is then dead code, never reached) → the marker stays
      // zeroed instead of dangling at the now-suppressed error's stale value,
      // so a later genuine trap in this instance decodes as RuntimeError, not
      // the swallowed error.
      ['global.set', '$__jz_last_err_bits', ['i64.const', 0]],
      ...throwCleanup,
      ['global.set', '$__jz_last_err_bits', ['i64.reinterpret_f64', ['local.get', `$${errLocal}`]]],
      ['throw', '$__jz_err', ['local.get', `$${errLocal}`]]]
  },

  'return': expr => {
    const finalizers = emitFinalizers()
    const finalizerBlock = () => [['block', ...finalizers]]
    if (ctx.func.current?.results.length > 1 && Array.isArray(expr) && expr[0] === '[') {
      const vals = expr.slice(1).map(e => asF64(emit(e)))
      if (finalizers.length === 0) return typed(['return', ...vals], 'void')
      const names = vals.map(() => temp('ret'))
      return [
        ...vals.map((v, i) => ['local.set', `$${names[i]}`, v]),
        ...finalizerBlock(),
        typed(['return', ...names.map(n => ['local.get', `$${n}`])], 'void'),
      ]
    }
    // A value-less `return;` yields `undefined` per spec (not null). The function
    // result is never i32-narrowed when a bare return is present (see hasBareReturn
    // guard in narrowI32Results), so the f64 UNDEF carrier is type-compatible.
    if (expr == null) return [...finalizers, typed(['return', undefExpr()], 'void')]
    const rt = ctx.func.current?.results[0] || 'f64'
    const pk = ctx.func.current?.ptrKind
    // Emit ONCE, before branching on pk — self-compile miscompile: the equivalent inline
    // form `pk != null ? asPtrOffset(emit(expr), pk) : asParamType(emit(expr), rt)`
    // (emit(expr) repeated once per ternary arm, only one ever executing) is behaviorally
    // identical in JS but the self-compiled kernel drops the f64.convert_i32_s/u rebox on
    // the taken arm's result — an i32-typed return tail comes back bare (unconverted) in
    // a non-narrowed (f64-result) function, so the wasm validator sees "expected f64, got
    // i32" at every return site shaped like `return (expr)|0` inside a function whose
    // result the narrower left at f64 (e.g. blocked by an unrelated same-name shadow
    // elsewhere — narrowI32Results itself is unaffected either way). compile/index.js's
    // sibling call site (`const ir = emit(body); … ptrKind != null ? asPtrOffset(ir, …) :
    // asParamType(ir, …)`) already used this materialize-then-branch shape and was never
    // affected — mirroring it here is both the fix and the more idiomatic form (DRY: one
    // emit call instead of a copy per arm). Root cause not fully localized beyond "the
    // self-compiled kernel, at every optimize level 0-2, treats a value produced by a call
    // repeated textually across both arms of a ternary differently from one materialized
    // to a local first" — pinned in test/parser-bugs.js rather than chased further into
    // the kernel's own call/branch codegen. See .work/todo.md (groundtruth archive).
    // Closure-convention bodies return into a boxed-value position (the ftN f64
    // slot): a BOOL value must cross as its true/false atom — the result-side
    // mirror of closure.call's carrierF64 args. Raw funcs keep the plain 0/1
    // ONLY when the function's return kind is proven uniformly BOOL, OR when
    // there's just one return statement at all (see ctx.func.mixedAtomReturn,
    // set in index.js emitFunc — its comment has the full "why >=2 returns"
    // rationale, including the Set/Map single-return regression a coarser
    // `valResult !== VAL.BOOL` gate caused; also documents the ADDITIVE
    // single-return admission when the lone return is an ambiguous BOOL-merge).
    // A genuinely mixed func (>= 2 return statements, not provably uniform
    // BOOL, or a single ambiguous-merge return) must box a statically-BOOL
    // return tail here: an unproven-kind call result is exactly the
    // "dynamic/unknown" operand the rest of the compiler already assumes
    // carries booleans as their atom (emitStrictEq's BOOL-vs-unknown branch,
    // '+'​'s atom-aware numSide, __to_num) — leaving it raw silently crossed
    // `return false` as the plain float 0, indistinguishable from a real 0 at
    // the call site (audit #5 item 2, ledger "KERNEL LEG ZERO FAILS" —
    // boolconst). carrierF64 is a no-op (byte-identical to asParamType/asF64)
    // whenever this return's own static valType isn't BOOL, so uniform-NUMBER
    // (or any non-bool-mixed) funcs are untouched.
    //
    // An ambiguous BOOL-merge return (`s => cond ? 1 : false`,
    // .work/todo.md §deletion-sweep) needs the SAME box but carrierF64
    // is post-hoc powerless for it: `expr`'s own valTypeOf collapses to NUMBER
    // (the merge's benign coercion), so carrierF64 never recognizes it as
    // BOOL-carrying — by the time `emitted` exists, the coerced false and a
    // genuine 0 are already the same bits. emitIdentitySafe re-emits the merge
    // with its own BOOL arm boxed to its atom BEFORE that collapse, so it must
    // replace `emit(expr)` itself here (not wrap its result) — single emission
    // preserved (still exactly one of emit/emitIdentitySafe runs).
    const boxes = pk == null && rt === 'f64' && (ctx.func.boxedResult || ctx.func.mixedAtomReturn)
    const resultBool = pk == null && rt === 'i32' && ctx.func.valResult === VAL.BOOL
    const ambiguous = boxes && hasAmbiguousBoolMerge(expr)
    // A proven boolean i32 result needs truthiness conversion. ToInt32 on an
    // opaque f64 boolean carrier turns every NaN-boxed true/false atom into 0.
    // Select the boolean emitter up front so expr is still evaluated once.
    let emitted = resultBool ? toBool(expr) : ambiguous ? emitIdentitySafe(expr) : emit(expr)
    if (!resultBool)
      emitted = applyBigintRepresentationAction(emitted, expr, representationReturnAction(ctx, expr))
    // Slice 2 (CARRIER PROGRAM, .work/carrier-representation-design.md §7)
    // return def-side wiring — carrierF64Narrow (ir.js), NOT the plain
    // carrierF64 `boxes` used pre-Slice-2: see its own doc comment for why an
    // unconditional inline-BIGINT box is wrong at ANY return position (a
    // uniform function OR a closure/mixed-atom-return one) — it only fires
    // for a bare name independently proven boxed by some OTHER sink in this
    // same body (a dict store earlier, a closure capture, …), the one case
    // where re-using the decision here introduces no NEW ambiguity a caller
    // wasn't already going to see. `ctx.func.boxedResult`/`mixedAtomReturn`
    // (`boxes`) keep their PRE-Slice-2 BOOL-atom-boxing behavior verbatim —
    // carrierF64Narrow's BOOL branch is carrierF64's, untouched.
    //
    // `!ctx.func.exported` gates only the plain (non-`boxes`) path: even the
    // bare-name-proven case must skip a proven-BIGINT export's own
    // unambiguous i64 ABI (Bug 1, synthesizeBoundaryWrappers — see below).
    // Not needed on the `boxes` path: `ctx.func.boxedResult` never applies to
    // a top-level export (closures aren't exports), and `mixedAtomReturn` on
    // an exported function means the export's OWN return type isn't a proven
    // uniform BIGINT (mixedAtomReturn's condition is `valResult !== VAL.BOOL`
    // regardless of what it IS, but a proven-uniform-BIGINT export would take
    // the OTHER, `needsBox`-shaped ABI instead) — so its wrapper already takes
    // the dynamic/tagged result ABI a box is correct for.
    const ir = resultBool ? emitted
      : pk != null ? asPtrOffset(emitted, pk)
      : boxes ? (ambiguous ? emitted : carrierF64Narrow(expr, emitted, 'return'))
      : asParamType(emitted, rt)
    const ty = pk != null ? 'i32' : rt
    const tcoed = tcoTailRewrite(ir, ty)
    if (Array.isArray(tcoed) && tcoed[0] === 'return_call' && finalizers.length === 0) {
      return typed(tcoed, 'void')
    }
    if (finalizers.length > 0) {
      const name = ty === 'i32' ? tempI32('ret') : ty === 'i64' ? tempI64('ret') : temp('ret')
      return [
        ['local.set', `$${name}`, tcoed],
        ...finalizerBlock(),
        typed(['return', ['local.get', `$${name}`]], 'void'),
      ]
    }
    return typed(['return', tcoed], 'void')
  },

  // === Assignment ===

  '=': (name, val) => {
    if (typeof name === 'string' && isConst(name)) err(`Assignment to const '${name}' — const bindings can't be reassigned after initialization; declare it with let instead`)
    if (Array.isArray(name) && name[0] === '[]') return emitElementAssign(name[1], name[2], val)
    if (Array.isArray(name) && name[0] === '.')  return emitPropertyAssign(name[1], name[2], val)
    if (typeof name !== 'string') err(`Assignment to non-variable: ${JSON.stringify(name)} — jz assigns to a plain variable, obj.prop, or arr[i] only`)
    // Plain reassignment (`x = …`, `name` already bound) reaches a DIFFERENT
    // emitter than a decl-with-init (emitDecl above) — the ambiguous-identity
    // REJECT lived only on the decl path, so `let x; x = false ?? 1` (and any
    // later `typeof x`/`x === false`) skipped it entirely and silently kept
    // the collapsed raw-NUMBER carrier (audit-#12 BOOL_CARRIER family). Same
    // helper, same contract: rejects only when SOME use of `name` actually
    // observes its identity — a truthiness-only reassignment still compiles.
    rejectAmbiguousBoolIdentity(name, val)
    if (isNullishLit(val)) ctx.func.maybeNullish?.add(name)   // null-flow: later arithmetic on this var coerces
    const void_ = ctx.func._expect === 'void'
    if (Array.isArray(val) && val[0] === 'u+' && val[1] === name) {
      inc('__to_num')
      return writeVar(name, typed(['call', '$__to_num', asI64(emit(name))], 'f64'), void_)
    }
    // Self-accumulation `x = x + …` (incl. desugared `x += …`): the new value REPLACES x, so x's
    // old buffer is dead — the one context where a string concat may bump-EXTEND it in place. The
    // `+` handler reads this flag for its immediate concat; nested operands clear it (not the target).
    const selfAccum = Array.isArray(val) && val[0] === '+' && val[1] === name
    // Compiler-synthesized decl-destructure array-literal temp (prepare/index.js
    // prepDecl, ctx.schema.arrayVars — kind.js's own doc comment on that map:
    // "tmp is a compiler-synthesized, single-write, non-escaping carrier that
    // only this destructure's own generated reads ever touch"). `tmp = […]`'s
    // own elements never cross the host boundary and are never read via a
    // registry-aware dynamic dispatch — module/array.js's array-literal
    // emitter reads this flag to admit storedValueNarrow unconditionally
    // (dropping its default per-element-uniformity gate, which a mixed-type
    // destructure source like `let [a, b] = [1, BigInt(v)]` fails even though
    // no reader here is ever dynamic). See carrierF64Narrow's own doc comment
    // (ir.js) for the established pattern this mirrors.
    const neverEscapes = Array.isArray(val) && val[0] === '[' && ctx.schema.arrayVars?.has(name)
      ? true : ctx.func._arrayLiteralNeverEscapes
    let ev = withFunctionFields({
      _selfAccumConcat: selfAccum ? name : null,
      _arrayLiteralNeverEscapes: neverEscapes,
    }, () => emit(val))
    const repAction = representationBindingWriteAction(ctx, name, val)
    ev = applyBigintRepresentationAction(ev, val, repAction)
    return writeVar(name, ev, void_)
  },

  // Compound assignments: read-modify-write with type coercion
  '+=': (name, val) => {
    // Complex LHS (obj.prop, arr[i]) → desugar to side-effect-safe `name = name + val`
    if (typeof name !== 'string') return emit(['=', name, ['+', name, val]])
    // String concatenation: desugar to name = name + val (+ handler knows about strings).
    // Also desugar when either side has unknown type — the `+` operator picks runtime
    // string/numeric dispatch (`__is_str_key`); compoundAssign would force f64.add and
    // silently corrupt string concatenations through unknown-typed values.
    const vt = typeof name === 'string' ? valTypeOf(name) : null
    const vtB = valTypeOf(val)
    if (vt === VAL.STRING || vtB === VAL.STRING) return emit(['=', name, ['+', name, val]])
    if ((vt == null || vtB == null) && ctx.core.stdlib['__str_concat']) return emit(['=', name, ['+', name, val]])
    return compoundAssign(name, val, (a, b) => typed(['f64.add', a, b], 'f64'), (a, b) => typed(['i32.add', a, b], 'i32'), '+')
  },
  ...Object.fromEntries([
    ['-=', 'sub'], ['*=', 'mul'], ['/=', 'div'],
  ].map(([op, fn]) => [op, (name, val) => {
    const sym = op.slice(0, -1)
    if (typeof name !== 'string') return emit(['=', name, [sym, name, val]])
    return compoundAssign(name, val,
      (a, b) => typed([`f64.${fn}`, a, b], 'f64'),
      fn === 'div' ? null : (a, b) => typed([`i32.${fn}`, a, b], 'i32'),
      sym
    )
  }])),
  '%=': (name, val) => {
    if (typeof name !== 'string') return emit(['=', name, ['%', name, val]])
    return compoundAssign(name, val, f64rem, (a, b) => typed(['i32.rem_s', a, b], 'i32'), '%')
  },
  // `**` is always f64 (and has its own const-exponent lowering) — full desugar.
  '**=': (name, val) => emit(['=', name, ['**', name, val]]),

  // Bitwise compound assignments: i32 normally, i64 when either operand is BigInt
  ...Object.fromEntries([
    ['&=', 'and'], ['|=', 'or'], ['^=', 'xor'],
    ['>>=', 'shr_s'], ['<<=', 'shl'], ['>>>=', 'shr_u'],
  ].map(([op, fn]) => [op, (name, val) => {
    const sym = op.slice(0, -1)
    if (typeof name !== 'string') return emit(['=', name, [sym, name, val]])
    if (valTypeOf(name) === VAL.BIGINT || valTypeOf(val) === VAL.BIGINT) {
      // `>>>=` has no BigInt arm at all (see the binary '>>>' handler above) —
      // unlike the other bitwise compounds, which fall to i64.<op>, this one
      // must throw unconditionally rather than take fn='shr_u' on i64 bits.
      if (fn === 'shr_u') err('BigInt has no unsigned right shift (>>>) — TypeError in JS; convert with Number(x) first if you need an unsigned shift')
      bigintMixReject(sym, name, val)
      const void_ = ctx.func._expect === 'void'
      // See compoundAssign's identical comment: `name` is always a bare identifier,
      // so only `val` can be a maybeUndefined dict/Map read. `<<=`/`>>=` share the
      // binary `<<`/`>>` handler's sign-aware direction flip — see bigIntShiftIR.
      const rawBits = (sym === '<<' || sym === '>>')
        ? bigIntShiftIR(sym, readI64(name, readVar(name)), bigIntOperand(val))
        : [`i64.${fn}`, readI64(name, readVar(name)), bigIntOperand(val)]
      // Shape #6 emission companion — see compoundAssign's identical comment
      // just above (this dispatch's bigint arm has the exact same
      // fresh-raw-i64-result / box-before-write-back gap).
      return writeVar(name,
        representationCompoundAssignAction(ctx, name) === REP_EDGE_BOX ? boxBigInt(rawBits) : fromI64(rawBits),
        void_)
    }
    return compoundAssign(name, val,
      (a, b) => asF64(typed([`i32.${fn}`, toI32(a), toI32(b)], 'i32')),
      (a, b) => typed([`i32.${fn}`, a, b], 'i32')
    )
  }])),

  // Logical compound assignments: a ||= b → a = a || b, a &&= b → a = a && b
  // Logical/nullish compound assignments: read → check → conditionally write
  // For complex LHS (obj.prop, arr[i]): emit as check(read(lhs)) ? write(lhs, val) : read(lhs)
  ...Object.fromEntries(['||=', '&&=', '??='].map(op => [op, (name, val) => {
    // Complex LHS → desugar (side-effect-safe since obj/arr/idx are locals)
    if (typeof name !== 'string') {
      const baseOp = op.slice(0, -1) // '||', '&&', '??'
      return emit([baseOp, name, ['=', name, val]])
    }
    if (isConst(name)) err(`Assignment to const '${name}' — const bindings can't be reassigned after initialization; declare it with let instead`)
    const void_ = ctx.func._expect === 'void'
    const t = temp()
    const va = readVar(name)
    // Condition: ||= → truthy check, &&= → truthy check, ??= → nullish check
    const lhs = typed(['local.tee', `$${t}`, asF64(va)], 'f64')
    const cond = op === '??=' ? isNullish(lhs) : truthyIR(lhs)
    // &&= and ??= assign when cond is true (truthy / nullish); ||= assigns when cond is false
    const repAction = representationBindingWriteAction(ctx, name, val)
    const assigned = asF64(applyBigintRepresentationAction(emit(val), val, repAction))
    const [thenExpr, elseExpr] = op === '||='
      ? [['local.get', `$${t}`], assigned]
      : [assigned, ['local.get', `$${t}`]]
    const result = typed(['if', ['result', 'f64'], cond, ['then', thenExpr], ['else', elseExpr]], 'f64')
    // Write back — writeVar owns the cell/global/local discipline INCLUDING the
    // i32-narrowed-cell width (a direct f64.store here desynced narrowed cells).
    return writeVar(name, result, void_)
  }])),

  ...incdecOps,
  ...arithmeticOps,
  ...comparisonOps,
  ...logicalOps,
  // === Bitwise (i32 for numbers, i64 for BigInt) ===

  // Per ECMAScript ToInt32, bitwise ops first ToNumber-coerce non-numeric operands.
  // i32 / lit values are already numeric — the toNumF64 wrap is skipped to keep
  // the numeric fast path at one wasm instruction. Non-numeric (NaN-boxed string,
  // unknown type) routes through __to_num so "2026" | 0 === 2026.
  // `~~x` is the idiomatic int32 truncation: the two xor-with-(-1) cancel, leaving
  // a single toI32 (whose NaN/Infinity guard runs once, unchanged). Fold it here so
  // DSP/bytebeat `~~` doesn't emit a dead double-xor watr won't remove.
  '~':   (a, self) => {
    if (Array.isArray(a) && a[0] === '~') {
      const inner = a[1]
      // ~~x === x for BigInt; the int32-truncation fold below is number-only.
      if (valTypeOf(inner) === VAL.BIGINT) return emit(inner)
      const iv = emit(inner)
      return isLit(iv) ? emitNum(~~litVal(iv)) : typed(toI32(isI32Num(iv) ? iv : toNumF64(inner, iv)), 'i32')
    }
    // BigInt complement is the i64 `x ^ -1` (all bits flipped), like emitNeg's i64.sub.
    // bigIntUnary: a maybeUndefined-BIGINT operand's real
    // JS value is ToInt32(NaN)'s complement, NUMBER -1 — not `x ^ -1` on the raw
    // UNDEF_NAN sentinel bits (see emitNeg's identical substitution above).
    // `|| censusMaybeUndefinedKind(a) === VAL.BIGINT` — see emitNeg's identical
    // OR-arm comment (§6/§12 Slice 5): keeps this gate VT-Slice-4-independent.
    if (valTypeOf(a) === VAL.BIGINT || censusMaybeUndefinedKind(a) === VAL.BIGINT)
      return bigIntUnary(a, i64v => ['i64.xor', i64v, ['i64.const', -1]], ['f64.const', -1], computedBoxOf(self))
    const v = emit(a); return isLit(v) ? emitNum(~litVal(v)) : typed(['i32.xor', toI32(isI32Num(v) ? v : toNumF64(a, v)), typed(['i32.const', -1], 'i32')], 'i32')
  },
  ...Object.fromEntries([
    ['&', 'and'], ['|', 'or'], ['^', 'xor'], ['<<', 'shl'], ['>>', 'shr_s'],
  ].map(([op, fn]) => [op, (a, b, self) => {
    // §14 point 4: joint runtime-domain dispatch — see '-'s identical comment
    // above. Number-domain branch mirrors the generic i32 fast path below
    // (`toI32`/`i32.${fn}`) exactly, widened back to f64 via `asF64`.
    if (bigIntDomainsCanMix(a, b, true)) {
      bigintMixReject(op, a, b)
      return bigIntJointDispatch(a, b,
        op === '<<' || op === '>>' ? (ia, ib) => bigIntShiftIR(op, ia, ib) : (ia, ib) => [`i64.${fn}`, ia, ib],
        (fa, fb) => asF64(typed([`i32.${fn}`, toI32(fa), toI32(fb)], 'i32')), computedBoxOf(self))
    }
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT) {
      bigintMixReject(op, a, b)
      // `<<`/`>>` need the sign-aware direction flip (bigIntShiftIR) — see its
      // own doc comment. `&`/`|`/`^` have no such hazard (bitwise ops are
      // direction-symmetric; only a shift COUNT's sign is meaningful).
      if (op === '<<' || op === '>>') return fromI64(bigIntShiftIR(op, bigIntOperand(a), bigIntOperand(b)))
      return fromI64([`i64.${fn}`, bigIntOperand(a), bigIntOperand(b)])
    }
    if (op === '|') {  // `(x / y) | 0` integer-division idiom → i32.div_s
      const divN = intLiteralValue(b) === 0 ? a : intLiteralValue(a) === 0 ? b : null
      if (Array.isArray(divN) && divN[0] === '/') { const r = tryIntDivTrunc(divN[1], divN[2]); if (r) return r }
    }
    const va = emit(a), vb = emit(b)
    if (isLit(va) && isLit(vb)) {
      const la = litVal(va), lb = litVal(vb)
      if (op === '&') return emitNum(la & lb); if (op === '|') return emitNum(la | lb)
      if (op === '^') return emitNum(la ^ lb); if (op === '<<') return emitNum(la << lb)
      if (op === '>>') return emitNum(la >> lb)
    }
    const ca = isI32Num(va) || isLit(va) ? va : toNumF64(a, va)
    const cb = isI32Num(vb) || isLit(vb) ? vb : toNumF64(b, vb)
    return typed([`i32.${fn}`, toI32(ca), toI32(cb)], 'i32')
  }])),
  '>>>': (a, b) => {
    // BigInt has no unsigned right shift — ES2020 §6.1.6.2.11 defines no
    // BigInt::unsignedRightShift; `>>>`'s abstract operation for a BigInt
    // operand throws TypeError unconditionally (unlike the signed bitwise
    // ops above, which fall to i64.shr_s/etc — `>>>` has no i64 arm at all
    // to fall to). Checked before either side emits, so no side effect runs
    // ahead of the throw.
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT)
      err('BigInt has no unsigned right shift (>>>) — TypeError in JS; convert with Number(x) first if you need an unsigned shift')
    const va = emit(a), vb = emit(b)
    if (isLit(va) && isLit(vb)) {
      const r = litVal(va) >>> litVal(vb) // JS uint32 result ∈ [0, 2^32)
      // ≥ 2^31 doesn't fit signed i32: materialize the wrapped bits as an i32 const
      // tagged `.unsigned` so `asF64` lifts via `convert_i32_u`. Emitting `f64.const r`
      // here (the old foldConst path) would `trunc_sat_f64_s`-saturate to INT32_MAX
      // when the enclosing function narrows to an i32 result. Values < 2^31 fold to a
      // plain i32 const (signed == unsigned, stays foldable downstream).
      if (r >= 0x80000000) { const node = typed(['i32.const', r | 0], 'i32'); node.unsigned = true; return node }
      return emitNum(r)
    }
    // F: Mark unsigned so `asF64` lifts via `f64.convert_i32_u` (preserving the
    // [0, 2^32) value range). Without this, `(s >>> 0) / 4294967296` would convert
    // signed for negative-high-bit s values, flipping sign and breaking the
    // canonical "uint32 → f64" idiom used in PRNGs and bit-manipulation code.
    const ca = isI32Num(va) || isLit(va) ? va : toNumF64(a, va)
    const cb = isI32Num(vb) || isLit(vb) ? vb : toNumF64(b, vb)
    const node = typed(['i32.shr_u', toI32(ca), toI32(cb)], 'i32')
    node.unsigned = true
    return node
  },

  // === Control flow ===

  'if': (cond, then, els) => {
    // Dead branch elimination: constant condition → emit only the live branch
    const ce = emit(cond)
    if (isLit(ce)) {
      const v = litVal(ce), truthy = v !== 0 && v === v
      if (truthy) return emitVoid(then)
      if (els != null) return emitVoid(els)
      return null
    }
    // If-conversion (speed tier): `if (cond) x = <cheap pure value>` (no else) → `x = cond ? value
    // : x`, which lowers to a branchless `select`. Removes the data-dependent branch (and its
    // misprediction) from min/max/clamp reductions — e.g. levenshtein's `if (ins < m) m = ins`,
    // ~27% faster — and from heapsort's child pick `if (a[c] < a[c+1]) c++`, the canonical
    // unpredictable compare that costs jz on x86 (Cranelift/V8-x64 keep the branch; Binaryen, which
    // AS uses, selects it). The condition is evaluated exactly once whether we branch or select, so
    // it need only be SIDE-EFFECT-FREE (loads allowed — sort's `a[c] < a[c+1]`); only the assigned
    // VALUE is evaluated unconditionally, hence must be a cheap, trap-free pure expr. `x++`/`x--`
    // are admitted as `x = x ± 1`. The already-emitted condition `ce` is reused (`__emitted`), so a
    // load-bearing condition is not emitted twice.
    if (els == null && ctx.transform.optimize?.boolConvertToSelect && isSideEffectFree(cond)) {
      const asg = Array.isArray(then) && then[0] === ';' && then.length === 2 ? then[1] : then
      const sel = matchVoidLocalStore(asg)
      if (sel) return emitVoid(['=', sel.lhs, ['?:', ['__emitted', ce], sel.val, sel.lhs]])
    }
    const c = ce.type === 'i32' ? ce : toBoolFromEmitted(ce)
    // Flow-sensitive type refinement: narrow types within each branch based on the guard.
    const thenRefs = extractRefinements(cond, new Map(), true)
    const elseRefs = extractRefinements(cond, new Map(), false)

    // Tagged-union branch versioning: several fields read from one unresolved
    // receiver can identify a single compile-time schema. Guard that schema ONCE
    // and emit fixed-slot accesses in the hot arm; every other value executes the
    // original dynamic body. This is the AOT analogue of a polymorphic inline
    // cache and removes one schema dispatch per field from record visitors.
    const emitBranch = (branch, refs) => {
      // An `else if` node is a dispatcher, not one variant body. Speculating
      // the whole remaining chain clones every suffix at every nesting level
      // (quadratic/exponential code growth and tiering pressure). Let its own
      // emitter recurse and speculate only the eventual leaf bodies.
      let spec = ctx.transform.optimize?.speculateSchemaBranches !== false &&
        !(Array.isArray(branch) && branch[0] === 'if')
        ? inferSchemaBranch(branch) : null
      // A sanctioned union CURSOR (analyzeUnionInline) already reads through
      // the packed carrier under discriminant-refinement PROOFS — the union's
      // closure is the guard. Speculating here clones the body into two
      // identical packed arms behind a redundant runtime tag check.
      if (spec && ctx.schema.inlineUnionCursors?.get(ctx.func.current)?.has(spec.name)) spec = null
      if (!spec) return withRefinements(refs, branch, () => emitVoid(branch))
      // A constant tag census predicts one schema, but cannot prove that host
      // or dynamically-constructed objects never carry the same tag. Narrow
      // the version guard to that sid while retaining the dynamic miss arm.
      const hint = refs.get(spec.name)?.schemaHint
      if (hint != null) {
        const schema = ctx.schema.list[hint]
        const slots = new Map()
        let valid = !!schema
        for (const prop of spec.schemaSlots.keys()) {
          const slot = schema?.indexOf(prop) ?? -1
          if (slot < 0) { valid = false; break }
          slots.set(prop, slot)
        }
        if (valid) spec = { ...spec, schemaIds: [hint], schemaId: hint, schemaSlots: slots }
      }

      const fastRefs = new Map(refs)
      mergeRefinement(fastRefs, spec.name, {
        val: VAL.OBJECT, schemaId: spec.schemaId,
        schemaIds: spec.schemaIds, schemaSlots: spec.schemaSlots,
      })
      const fast = withRefinements(fastRefs, branch, () => emitVoid(branch))

      // The fallback is already dominated by `sid !== spec.schemaId`; do not
      // rebuild per-read schema guards/devirt tables inside this cold arm.
      const slow = withSchemaSpeculation(true,
        () => withRefinements(refs, branch, () => emitVoid(branch)))

      const raw = readVar(spec.name)
      // An unresolved schema-bearing value uses the boxed f64 carrier. A raw
      // pointer would already carry ptrAux/schemaId and never reach this pass.
      if (raw.type !== 'f64') return slow
      let schemaGuard = null
      for (const sid of spec.schemaIds) {
        const eq = ['i64.eq',
          ['i64.and', ['i64.reinterpret_f64', readVar(spec.name)], ['i64.const', '0xFFFFFFFF00000000']],
          ['i64.const', i64Hex(BigInt(encodePtrHi(PTR.OBJECT, sid)) << 32n)]]
        schemaGuard = schemaGuard == null ? eq : ['i32.or', schemaGuard, eq]
      }
      return [['if', schemaGuard, ['then', ...fast], ['else', ...slow]]]
    }

    const thenBody = emitBranch(then, thenRefs)
    if (els != null) {
      const elseBody = emitBranch(els, elseRefs)
      return ['if', c, ['then', ...thenBody], ['else', ...elseBody]]
    }
    return ['if', c, ['then', ...thenBody]]
  },

  'for': (init, cond, step, body) => {
    if (body === undefined) return err('for-in/for-of not supported')
    // An enclosing labeled statement (`outer: for …`) hands its label down so `continue outer`
    // can target this loop's continue point. The immediately-enclosed loop consumes it.
    const myLabel = ctx.func.pendingLabel; ctx.func.pendingLabel = null
    const bodyNode0 = body   // identity for assumption owners — survives the hoist rebind below
    const labeledContinue = myLabel != null && hasLabeledContinueTo(body, myLabel)
    // Don't unroll a loop that is the target of a `continue <label>` — unrolling would lose the
    // continue edge. (Plain loops with no labeled-continue still unroll.)
    if (!labeledContinue && (!ctx.transform.optimize || ctx.transform.optimize.smallConstForUnroll !== false)) {
      const unrolled = unrollSmallConstFor(init, cond, step, body)
      if (unrolled) return unrolled
    }
    // for-in over a static schema → unroll with key-literal substitution (folds
    // o[k] to schema slots). Recognized via the for-in-exclusive __keys_ro intrinsic.
    if (!labeledContinue && (!ctx.transform.optimize || ctx.transform.optimize.forInUnroll !== false)) {
      const fu = unrollForIn(init, cond, step, body)
      if (fu) return fu
    }
    // Typed-bounds loop VERSIONING (Root F): a countable loop whose body indexes typed
    // receivers with iv-affine indices no static class proves gets a ONCE-per-entry
    // runtime extent guard. The fast arm re-emits with those (recv, idx) pairs assumed
    // in-bounds — bare loads/stores, i.e. the vectorizer's shapes — while the else arm
    // keeps the checked forms verbatim (also the correct semantics for a failing guard:
    // OOB reads yield undefined, OOB writes are ignored). Guard arithmetic runs in i64:
    // a*(B-1)+b overflows i32 near the edge, and a wrapped guard that passes is heap
    // corruption. `_tbVersioned` brakes the arms' re-entry into this same intercept —
    // keyed by ctx.func identity so a REUSED AST (same source compiled twice, the
    // self-compile warm path) versions afresh in the next compile instead of silently
    // skipping.
    if (!labeledContinue && body._tbVersioned !== ctx.func
        && (!ctx.transform.optimize || ctx.transform.optimize.versionTypedBounds !== false)) {
      const levels = versionableTypedNest(init, cond, step, body, ctx.func.locals)
      if (levels) {
        body._tbVersioned = ctx.func
        // every LIFTED level is proven by THIS guard — brake their own intercepts
        // (re-versioning per level compounds 2^depth checked twins)
        for (const vs of levels) if (vs.bodyNode && !vs.partial) vs.bodyNode._tbVersioned = ctx.func
        // Loop-counter RANGE-PROOF lever (c8700daa), rescued from this guard's OWN
        // re-emission: both arms below re-emit the loop via `emitter['for'](null,
        // cond, step, body)` — init nulled because the REAL init already ran once,
        // just above — and forCounterRange(null, …) can prove nothing from a null
        // init, so the counter's own body-internal arithmetic (e.g. a comma-step
        // dual-IV header's dropped post-increment value) falls to the f64
        // round-trip in BOTH arms. The fact is provable exactly once, from the
        // REAL init still in scope here — unlike the bound-name magnitude lever
        // below (sound only conditional on the guard passing), the counter's own
        // [lo, hi] hull holds unconditionally for either arm: same init/cond/step,
        // only the body's access forms differ.
        const topCounterName = guardCounterName(cond)
        const topCounterRange = topCounterName ? forCounterRange(init, cond, step, topCounterName) : null
        const topCounterRefs = topCounterRange
          ? new Map([[topCounterName, { rlo: topCounterRange[0], rhi: topCounterRange[1] }]]) : null
        const result = []
        if (init != null) result.push(...emitVoid(init))
        const i64c = (n) => ['i64.const', n]
        const ext = (ir) => ['i64.extend_i32_s', ir]
        const conjs = []
        // one evaluation per symbolic-offset slot (a stable name or an invariant pure
        // expr like `y*w`); an 'f64' slot adds `v integral ∧ |v| ≤ 2^31` conjuncts —
        // the int model of `a*iv + v` is exact only for integral v (trunc does NOT
        // distribute over f64 sums)
        const slotKey = (s) => typeof s === 'string' ? s : JSON.stringify(s)
        const slots = new Map()
        const slotI64 = (slot, kind) => {
          const key = slotKey(slot)
          let s = slots.get(key)
          if (s) return s
          if (kind === 'i32') {
            const nT = tempI64('tvm')
            result.push(['local.set', `$${nT}`, ext(asI32(emit(slot)))])
            s = ['local.get', `$${nT}`]
          } else {
            const nF = temp('tvn')
            result.push(['local.set', `$${nF}`, asF64(emit(slot))])
            conjs.push(['f64.eq', ['local.get', `$${nF}`], ['f64.floor', ['local.get', `$${nF}`]]])
            conjs.push(['f64.le', ['f64.abs', ['local.get', `$${nF}`]], ['f64.const', 2147483648]])
            const nT = tempI64('tvm')
            result.push(['local.set', `$${nT}`, ['i64.trunc_sat_f64_s', ['local.get', `$${nF}`]]])
            s = ['local.get', `$${nT}`]
          }
          slots.set(key, s)
          return s
        }
        const slotSum = (base, list, lo = false) => {
          let r = base
          for (const t of list) {
            // a WRAP atom (toroidal iv ternary ∈ [0, B-1]) is one-sided: B-1 into
            // the hi extent, nothing into the lo
            if (t.wrap) {
              if (!lo) r = ['i64.add', r,
                ['i64.mul', i64c(t.k), ['i64.sub', slotI64(t.e, t.kind), i64c(1)]]]
              continue
            }
            const s = slotI64(t.e, t.kind)
            r = ['i64.add', r, t.k === 1 ? s : ['i64.mul', i64c(t.k), s]]
          }
          return r
        }
        // len as ONE inline header load for a RESOLVED elem type (owned byteLen at
        // base-8, view at descriptor[0]; elemCount = byteLen >> shift) — a call in
        // the guard costs per LOOP ENTRY on re-entered inner nests (fft measured
        // 1.35x with calls, parity without); unresolved receivers keep $__len.
        const len64Of = (recv) => {
          const aux = plannedTypedStorageInfo(ctx, recv)?.aux
          if (aux == null) {
            inc('__len')
            return ['i64.extend_i32_u', ['call', '$__len', ['i64.reinterpret_f64', asF64(emit(recv))]]]
          }
          const et = aux & 7, isView = (aux & 8) !== 0
          const shift = (aux & 16) ? 3 : et <= 1 ? 0 : et <= 3 ? 1 : et <= 6 ? 2 : 3
          // A ptr-NARROWED receiver (typed param/local carried as a raw i32
          // offset) IS the base — asF64 on it would coerce the offset
          // NUMERICALLY (f64.convert_i32_s) and the box-decode below would
          // extract garbage bits from a plain number (module-global typed
          // array passed as param → versioning guard read a wild length →
          // OOB on a perfectly bounded loop).
          const recvIR = emit(recv)
          // Narrowed signal: an i32-typed emission of a TYPED binding IS the raw
          // data offset (reps carry val=TYPED; ptrKind rides sig narrowing).
          const rr = typeof recv === 'string' ? repOf(recv) : null
          const narrowed = recvIR.type === 'i32' && (rr?.ptrKind === VAL.TYPED || rr?.val === VAL.TYPED)
          const base = narrowed
            ? recvIR
            : ['i32.wrap_i64', ['i64.and', ['i64.reinterpret_f64', asF64(recvIR)], ['i64.const', LAYOUT.OFFSET_MASK]]]
          return ['i64.extend_i32_u', ['i32.shr_u',
            ['i32.load', isView ? base : ['i32.sub', base, ['i32.const', 8]]], ['i32.const', shift]]]
        }
        // one guard covers the whole NEST — each level contributes its own max-iv
        // and extent conjuncts (nested recognizers need the BARE nest in the fast
        // arm, and one guard per nest beats one per row)
        const levelInfo = new Map()
        // Bound-name MAGNITUDE lever: a level's
        // `f64`-kind bound is commonly an invariant EXPRESSION over a free name this
        // guard never separately proves (`w - 1` — the 1px-border stencil interior;
        // `w`/`h` trace to a resize(w,h) runtime param, genuinely unbounded
        // statically — versionableTypedFor's own doc, type.js). The existing
        // `|bound value| ≤ 2^31` conjunct below bounds the COMPOSED expression, not
        // the free name alone, so it can't license i32 arithmetic on `w` itself
        // (subRangeFitsI32/addRangeFitsI32, emit.js, read intExprRange(name) — null
        // today). A dedicated per-name conjunct — same idiom as the SLOT
        // integrality check just below (`f64.eq(v, f64.floor(v))` + a magnitude
        // cap) — proves a REAL, closed hull for the name, fed through
        // withRefinements (flow-types.js) for exactly the fast arm's own
        // re-emission: the SAME channel forCounterRange (this file's loop-counter
        // lever) uses for a proven counter range. `tryStencil`'s `boundPureInv`
        // (src/optimize/vectorize.js) wants a raw i32.sub bound chain — this is
        // what supplies it. ±2^30 (not the full i32 range) leaves headroom for a
        // small-literal adjustment on EITHER side (`w-1` and `w+1` alike) while
        // still being a genuine runtime-checked magnitude, not an assumption.
        const BOUND_NAME_MAG = 1 << 30
        const freeRefs = new Map()
        // Mirrors invariantIdxExpr's OWN grammar (type.js) exactly — the grammar
        // that already gated `bKind` onto this bound in the first place — rather
        // than a generic "every string leaf" walk: `vs.bound` is a SOURCE AST
        // node, and a naive walk would misread a property-key string (`.length`'s
        // `'length'`, a `typed receiver .length` bound already routes to bKind
        // 'i32' via a DIFFERENT branch and needs no help here) as a free
        // variable name — `emit('length')` then throws "not in scope" (FFT kernel
        // regression, caught by test/simd.js's dedupe-lane-locals case). Only a
        // SLOT_OPS binary/unary node recurses; a bare string is a name; literals
        // and anything else (member access, calls) contribute no names — safe by
        // construction, matching invariantIdxExpr's own accepted shapes 1:1.
        const boundFreeNames = (e, out) => {
          if (typeof e === 'string') { out.add(e); return out }
          if (Array.isArray(e) && SLOT_OPS.has(e[0]) && e.length <= 3)
            for (let i = 1; i < e.length; i++) boundFreeNames(e[i], out)
          return out
        }
        for (const vs of levels) {
          // max iv as i64. An 'f64' bound (untyped param, unknown box) converts via
          // ceil (`<`: the max int iv under B) / floor (`<=`) + trunc_sat — never
          // traps — with a `|B| ≤ 2^31` conjunct making the conversion exact: NaN and
          // box bit patterns fail the abs-compare and fall to the checked arm;
          // saturated garbage past the limit is conjunct-dead. i64 extents then never
          // overflow (|terms| ≤ 2^31, a is an i32 literal → |hi| < 2^63).
          // a RANGE-ONLY level guards hull conjuncts alone — no iv, no max-iv
          if (vs.rangeOnly) {
            for (const c of vs.cands) {
              if (c.range.hiName != null) {
                const cS = slotI64(c.range.hiName, exprType(c.range.hiName, ctx.func.locals) === 'i32' ? 'i32' : 'f64')
                conjs.push(['i64.ge_s', cS, i64c(c.range.entryHi + 1)])
                conjs.push(['i64.lt_s', ['i64.add', cS, i64c(c.range.hiBias)], len64Of(c.recv)])
              } else conjs.push(['i64.lt_s', i64c(c.range[1]), len64Of(c.recv)])
            }
            continue
          }
          // maxIv = the TRUE max iv value at PRE-increment access sites:
          // bound−1 (strict) / bound (inclusive). A body-advanced iv (bump>0)
          // exceeds this only AFTER its write — those accesses carry cand.post
          // and their group widens by a·bump in the extent constants below.
          // (The old unconditional widening made `maxIv < len` fail exactly
          // when len == bound — every symmetric half-spectrum loop.)
          const maxIv = tempI64('tvq')
          if (vs.bKind === 'f64') {
            const bF = temp('tvf')
            result.push(['local.set', `$${bF}`, asF64(emit(vs.bound))])
            conjs.push(['f64.le', ['f64.abs', ['local.get', `$${bF}`]], ['f64.const', 2147483648]])
            result.push(['local.set', `$${maxIv}`,
              ['i64.trunc_sat_f64_s', [vs.incl ? 'f64.floor' : 'f64.ceil', ['local.get', `$${bF}`]]]])
            if (!vs.incl) result.push(['local.set', `$${maxIv}`,
              ['i64.add', ['local.get', `$${maxIv}`], i64c(-1)]])
          } else {
            const adj = vs.incl ? 0 : -1
            result.push(['local.set', `$${maxIv}`,
              adj ? ['i64.add', ext(asI32(emit(vs.bound))), i64c(adj)] : ext(asI32(emit(vs.bound)))])
          }
          // Bound-name magnitude lever (see doc above levelInfo): every free NAME
          // this bound reads that lacks a magnitude proof ALREADY gets its own
          // integral+magnitude conjunct and a durable [lo,hi] refinement — for
          // EITHER bKind: exprType's own (type.js) magnitude check can already
          // classify a bound like `w-1` as 'i32' (bKind, driving the i64-extend
          // branch above) while the CODEGEN path for that same expression
          // (emit.js's `-` operator, `subRangeFitsI32`) independently declines —
          // exprType and the runtime arithmetic fits-gate are two different
          // consumers of intExprRange, and only the SECOND is what the fast arm's
          // own re-emission of `cond`/`body` (below) actually calls. Gated on
          // intExprRange (not exprType/storage type): `w`/`h` here are typically
          // ALREADY i32-STORED via the separate, deliberately-scoped
          // "comparison-governed, sound for n≤2^31" storage-typing tolerance
          // (collectBareEscapes/widenLocalTypes) — real for bit-storage (the cell
          // re-truncates every write) but NOT a magnitude proof (c8700daa's own
          // explicit rejection of reusing it as one) — so intExprRange(name) is
          // still null regardless of bKind, and the fits-gate still declines
          // `w-1` without this. A BARE-NAME bound (`vs.bound` itself a string —
          // `i < N`) needs none of this: a comparison between two i32-typed
          // operands is unconditionally safe (no addFitsI32-style overflow to
          // prove), so the conjunct would be pure overhead — skip it (confirmed
          // by test/perf.js's own "no per-iteration i32→f64 widening" pin, which
          // an unconditional walk broke by adding an unused guard-setup convert).
          if (typeof vs.bound !== 'string') for (const nm of boundFreeNames(vs.bound, new Set())) {
            if (freeRefs.has(nm) || intExprRange(nm) != null) continue
            const nF = temp('tvw')
            result.push(['local.set', `$${nF}`, asF64(emit(nm))])
            conjs.push(['f64.eq', ['local.get', `$${nF}`], ['f64.floor', ['local.get', `$${nF}`]]])
            conjs.push(['f64.le', ['f64.abs', ['local.get', `$${nF}`]], ['f64.const', BOUND_NAME_MAG]])
            freeRefs.set(nm, { rlo: -BOUND_NAME_MAG, rhi: BOUND_NAME_MAG })
          }
          levelInfo.set(vs, { maxIv, entryIR: () => vs.startC != null ? i64c(vs.startC) : slotI64(vs.iv, vs.ivKind) })
          // non-unit monotone stride: positivity is the soundness condition
          if (vs.stepBy?.name != null)
            conjs.push(['i64.ge_s', slotI64(vs.stepBy.name, vs.stepBy.kind), i64c(1)])
          // one extent conjunct pair per (recv, a, slots) group: hi = a*maxIv+Σkᵢ·slotᵢ
          // +maxC < len, plus lo = a*entry+Σkᵢ·slotᵢ+minC ≥ 0 — folded when the static
          // start proves it, read from the live iv local otherwise (top level only)
          const groups = new Map(), indGroups = new Map()
          for (const c of vs.cands) {
            if (c.range != null) {
              // interval-hulled idx against a dynamic length (the affine fallback).
              // Numeric hull: one `hi < len` conjunct. Symbolic hull (wrap cursor vs
              // a MUTABLE bound C): cursor ∈ [0, C-1] relative to C's runtime value —
              // `C ≥ entryHi+1` (the entry fits) ∧ `C+bias < len` close it.
              if (c.range.hiName != null) {
                const cS = slotI64(c.range.hiName, exprType(c.range.hiName, ctx.func.locals) === 'i32' ? 'i32' : 'f64')
                conjs.push(['i64.ge_s', cS, i64c(c.range.entryHi + 1)])
                conjs.push(['i64.lt_s', ['i64.add', cS, i64c(c.range.hiBias)], len64Of(c.recv)])
              } else conjs.push(['i64.lt_s', i64c(c.range[1]), len64Of(c.recv)])
              continue
            }
            if (c.ind != null) {
              const gk = c.recv + '\x00' + c.ind
              if (!indGroups.has(gk)) indGroups.set(gk, c)
              continue
            }
            if (c.cursor != null) {
              // MONOTONE CURSOR (glyfparse's `stream[r]`/`stream[r++]`): entryR (read
              // once, at loop entry — same spot every other entry slot is read) plus
              // K·trips plus the access's own K0 offset must clear len. trips reuses
              // the level's own maxIv/entry (type.js's cursorIvOk admits only a
              // unit-per-iteration iv, so trips is exactly the iteration count — no
              // separate trips≥0 conjunct needed: a negative trips means the loop
              // itself never runs, so no access happens regardless of the guard).
              const eT = slotI64(c.cursor, 'i32')
              conjs.push(['i64.ge_s', eT, i64c(0)])
              const info = levelInfo.get(vs)
              const trips = ['i64.add', ['i64.sub', ['local.get', `$${info.maxIv}`], info.entryIR()], i64c(1)]
              let hi = ['i64.add', eT, ['i64.mul', i64c(c.K), trips]]
              if (c.cConst) hi = ['i64.add', hi, i64c(c.cConst)]
              conjs.push(['i64.lt_s', hi, len64Of(c.recv)])
              continue
            }
            const gk = c.recv + '\x00' + c.a + '\x00' + c.slots.map(t => t.k + '*' + slotKey(t.e)).join('+')
            const g = groups.get(gk)
            if (!g) groups.set(gk, { recv: c.recv, a: c.a, slots: c.slots, maxC: c.bConst, minC: c.bConst, anyPost: !!c.post })
            else { g.maxC = Math.max(g.maxC, c.bConst); g.minC = Math.min(g.minC, c.bConst); if (c.post) g.anyPost = true }
          }
          for (const g of groups.values()) {
            // extremes follow the SIGN of a: a·iv is maximal at maxIv for a ≥ 0
            // but at ENTRY for a < 0 (mirror index `N−k` of symmetric fills),
            // and minimal at the other end. post-increment groups see iv up to
            // maxIv+bump — widen through the extent CONSTANT (a·bump).
            const postW = g.anyPost ? g.a * vs.bump : 0
            const hiC = g.maxC + (g.a >= 0 ? postW : 0)
            const loC = g.minC + (g.a < 0 ? postW : 0)
            const entryIR = () => vs.startC != null ? i64c(vs.startC) : slotI64(vs.iv, vs.ivKind)
            let hi = slotSum(['i64.mul', i64c(g.a), g.a >= 0 ? ['local.get', `$${maxIv}`] : entryIR()], g.slots)
            if (hiC) hi = ['i64.add', hi, i64c(hiC)]
            conjs.push(['i64.lt_s', hi, len64Of(g.recv)])
            // a ≥ 0 with a STATIC start: lo = a·startC+minC was validated
            // non-negative at candidate time (slotless), nothing to emit.
            if (g.a >= 0 && vs.startC != null && !g.slots.length) continue
            let lo = slotSum(g.a >= 0 && vs.startC != null ? i64c(g.a * vs.startC)
              : ['i64.mul', i64c(g.a), g.a >= 0 ? slotI64(vs.iv, vs.ivKind) : ['local.get', `$${maxIv}`]], g.slots, true)
            if (loC) lo = ['i64.add', lo, i64c(loC)]
            conjs.push(['i64.ge_s', lo, i64c(0)])
          }
          // induction cursors (`k += step` in a comma step): value at iteration t is
          // entry + slope*t, t ∈ [0, maxIv - ivEntry] — monotone either direction, so
          // BOTH endpoints guard in [0, len) and every intermediate value is covered
          for (const c of indGroups.values()) {
            const kE = c.entryC != null ? i64c(c.entryC)
              : slotI64(c.ind, exprType(c.ind, ctx.func.locals) === 'i32' ? 'i32' : 'f64')
            const slopeLit = intLiteralValue(c.slope)
            const slope64 = slopeLit != null ? i64c(slopeLit)
              : slotI64(c.slope, exprType(c.slope, ctx.func.locals) === 'i32' ? 'i32' : 'f64')
            const ivE = vs.startC != null ? i64c(vs.startC) : slotI64(vs.iv, vs.ivKind)
            const endT = tempI64('tvi')
            result.push(['local.set', `$${endT}`, ['i64.add', kE,
              ['i64.mul', slope64, ['i64.sub', ['local.get', `$${maxIv}`], ivE]]]])
            const len64 = len64Of(c.recv)
            conjs.push(['i64.ge_s', kE, i64c(0)])
            conjs.push(['i64.lt_s', kE, len64])
            conjs.push(['i64.ge_s', ['local.get', `$${endT}`], i64c(0)])
            conjs.push(['i64.lt_s', ['local.get', `$${endT}`], len64Of(c.recv)])
          }
        }
        // FLAT-CURSOR endpoint guards: `j++` once per pixel across the nest —
        // value spans [j0, j0 + slope·(Π trips − (pre ? 1 : 0))]; the steps cap
        // keeps the slope product overflow-free, a negative trip (empty level)
        // fails its conjunct into the checked arm
        for (const cur of levels.cursors ?? []) {
          const j0 = slotI64(cur.name, cur.kind)
          let steps = null
          for (const L of cur.chain) {
            const info = levelInfo.get(L)
            if (!info) { steps = null; break }
            const trip = tempI64('tvt')
            result.push(['local.set', `$${trip}`,
              ['i64.add', ['i64.sub', ['local.get', `$${info.maxIv}`], info.entryIR()], i64c(1)]])
            conjs.push(['i64.ge_s', ['local.get', `$${trip}`], i64c(0)])
            steps = steps ? ['i64.mul', steps, ['local.get', `$${trip}`]] : ['local.get', `$${trip}`]
          }
          if (!steps) { cur.dead = true; continue }
          const stepsT = tempI64('tvs')
          result.push(['local.set', `$${stepsT}`, steps])
          conjs.push(['i64.le_s', ['local.get', `$${stepsT}`], i64c(2147483648)])
          const seen = new Set()
          for (const c of cur.cands) {
            const gk = c.recv + '\x00' + c.post
            if (seen.has(gk)) continue
            seen.add(gk)
            const endT = tempI64('tvz')
            result.push(['local.set', `$${endT}`, ['i64.add', j0,
              ['i64.mul', i64c(cur.slope), c.post ? ['local.get', `$${stepsT}`]
                : ['i64.sub', ['local.get', `$${stepsT}`], i64c(1)]]]])
            conjs.push(['i64.ge_s', j0, i64c(0)])
            conjs.push(['i64.lt_s', ['local.get', `$${endT}`], len64Of(c.recv)])
          }
        }
        let guard = conjs[0]
        for (let k = 1; k < conjs.length; k++) guard = ['i32.and', guard, conjs[k]]
        // arm-scoped assumption MAP key → OWNING loop body: an assumption is honored
        // only while its loop's frame is on the emission stack (typedIdxProven checks
        // frame.bodyNode) — a textual twin of an inner access OUTSIDE that loop (the
        // cursor past its bound) must NOT inherit the proof. Snapshot/RESTORE (not
        // add/delete): unrolls inside the fast arm stamp clone keys that must not
        // survive into the checked arm, which runs exactly when the guard failed.
        const saved = ctx.types.assumedBounds
        const savedHull = ctx.types.assumedConstHull
        ctx.types.assumedBounds = new Map(saved ?? [])
        // Per-receiver guarded CONST hull (typedIdxProven class 4b): every a=0
        // pure-const candidate's extent is guard-checked against recv.length, so
        // the fast arm may assume ANY const index ≤ the receiver's max guarded
        // extent — value-keyed, immune to the clone/rename layers that break the
        // per-node assumption keys (plan unroll + per-arm emit unroll re-mint
        // ids every emission; the biquad cascade lost all 40 coefficient/state
        // assumptions that way and re-emitted the checked forms inside the
        // guarded arm).
        ctx.types.assumedConstHull = new Map(savedHull ?? [])
        for (const vs of levels)
          for (const c of vs.cands) {
            if (c.range == null && c.ind == null && c.a === 0 && (!c.slots || !c.slots.length) && c.bConst >= 0) {
              const h = ctx.types.assumedConstHull.get(c.recv)
              if (!h || c.bConst > h.max) ctx.types.assumedConstHull.set(c.recv, { max: c.bConst, owner: body })
            }
            // TOP-owned, every kind: each kept level is LIFTED — its extents are
            // proven by the top guard reading the inner bound at top entry — so
            // the proof holds anywhere inside the top body. Level-owned scoping
            // (the old form for affine cands) broke exactly when the inner loop
            // UNROLLED in the fast arm: an unrolled loop pushes no frame, so its
            // level-owned assumptions could never validate and the guarded arm
            // re-emitted every checked form (biquad's 40 coefficient reads at
            // 5.6% vs zig-wasm; 1.7% after this fix). Index names are the
            // level's own body-lets/iv (unreachable outside it) or invariant
            // slots — a textual twin outside the level cannot exist with the
            // same key, so top-ownership loses no safety.
            ctx.types.assumedBounds.set(idxKey(c.recv, c.idx), body)
          }
        // cursor claims hold across the WHOLE nest (entry → end) — owned by the top
        for (const cur of levels.cursors ?? [])
          if (!cur.dead) for (const c of cur.cands) ctx.types.assumedBounds.set(idxKey(c.recv, c.idx), body)
        // Bound-name refinements apply ONLY to the fast arm's own re-emission — the
        // checked arm runs exactly when the guard's conjuncts (including the new
        // per-name integral+magnitude ones) DIDN'T all hold, so it must stay
        // unrefined. withRefinements (flow-types.js) itself re-checks isReassigned
        // against `body` as a second, independent safety net.
        const emitArm = () => emitter['for'](null, cond, step, body)
        // topCounterRefs (the counter's own [lo, hi], unconditional) wraps BOTH
        // arms; freeRefs (bound-name magnitude, sound only once the guard has
        // passed) wraps the fast arm alone — see comments above each.
        const fast = withRefinements(topCounterRefs, body,
          () => freeRefs.size ? withRefinements(freeRefs, body, emitArm) : emitArm())
        ctx.types.assumedBounds = saved
        ctx.types.assumedConstHull = savedHull
        const checked = withRefinements(topCounterRefs, body, emitArm)
        const stmts = (r) => Array.isArray(r[0]) ? r : [r]
        result.push(['if', typed(guard, 'i32'),
          ['then', ...stmts(fast)],
          ['else', ...stmts(checked)]])
        return result
      }
    }
    // Lift constant array/object literals out of the loop (allocate once, not per
    // iteration) when they are read-only + non-escaping inside it. Strip them from the
    // body up front so freshBoxed / continue analysis see the reduced body.
    let preLoopLits = []
    if (!ctx.transform.optimize || ctx.transform.optimize.hoistConstLit !== false) {
      const ex = extractHoistableLiterals(body)
      if (ex) { preLoopLits = ex.hoisted; body = ex.body }
    }
    const id = freshId(ctx)
    const brk = `$brk${id}`, loop = `$loop${id}`
    // The cont wrapper is only needed if the body has a `continue` AND there is a step
    // expression — `continue` must jump to before the step. Without a step, `continue`
    // can target the loop label directly, saving a redundant `block`.
    const needsCont = step && (hasOwnContinue(body) || labeledContinue)
    const cont = needsCont ? `$cont${id}` : loop
    const control = { brk, loop: cont, bodyNode: bodyNode0 }
    return withControlFrame(control, frame => {
    if (myLabel != null) frame.contLabel = myLabel   // so `continue <myLabel>` targets this loop's step/test
    // Per-iteration fresh cells for boxed locals declared in the body — allocated
    // at body entry so a closure declared before its binding captures the right
    // cell (sets frame.loopFresh; emitDecl then stores rather than re-allocates).
    const freshBoxed = emitLoopFreshBoxed(body, frame)
    const result = []
    if (init != null) result.push(...emitVoid(init))
    for (const lit of preLoopLits) result.push(...emitVoid(lit))   // allocate hoisted literals once
    // Hoist a loop-invariant immutable-length bound out of the condition. A typed
    // array's `.length` is fixed, so `i < arr.length` otherwise reloads the header
    // (`i32.load (base-8) >> 2`) every iteration for nothing (V8's JIT hoists it).
    // Compute it once into a temp when `arr` is a typed-array var not reassigned in
    // the body. Only the simple top-level comparison forms — anything fancier just
    // keeps the per-iteration eval (correct, only misses the speedup).
    let condForLoop = cond
    if (cond && Array.isArray(cond) && HOIST_CMP.has(cond[0])) {
      const side = immutableLenBound(cond[2], body) ? 2 : immutableLenBound(cond[1], body) ? 1 : 0
      if (side) {
        const lt = tempI32('len')
        result.push(['local.set', `$${lt}`, asI32(emit(cond[side]))])
        condForLoop = cond.slice(); condForLoop[side] = lt
      }
    }
    // Loop-counter RANGE-PROOF lever: `for (let i = C; i < B; i++)` proves a real
    // [lo, hi] hull for `i` — see forCounterRange's own doc. Scoped to exactly
    // this body via withRefinements (flow-types.js), same machinery an `if
    // (x >= 0 && x < W)` branch guard already uses for its own int-range
    // refinement — so intExprRange(i) (and every addFitsI32/mulFitsI32 caller
    // that routes through it) sees the fact for the duration of this emit only.
    const counterName = guardCounterName(cond)
    const counterRange = counterName ? forCounterRange(init, cond, step, counterName) : null
    const counterRefs = counterRange ? new Map([[counterName, { rlo: counterRange[0], rhi: counterRange[1] }]]) : null
    // Loop-guard hull channel (addLiteralFitsI32's doc, above near
    // addRangeFitsI32): `while(name < bound)` / `for(…; name < bound; …)`
    // proves an upper bound for `name` — sound WITHOUT forCounterRange's
    // monotone-step induction (works for a reassigned, non-counter guard
    // variable like heapify's `child`), because it's an emission-position
    // fact torn down at the FIRST write to `name` (writeVar, ir.js), not a
    // whole-body induction hull. `bound`'s own intExprRange needs BOTH sides
    // (gap-(a)'s typed-`.length` fact supplies that for a typed receiver);
    // only the resulting UPPER half is installed here.
    const guardName = Array.isArray(cond) && (cond[0] === '<' || cond[0] === '<=') && typeof cond[1] === 'string' ? cond[1] : null
    const guardBoundRange = guardName ? intExprRange(cond[2]) : null
    // HIR provenance link fact (.work/research.md §BodyModel slice 4): the guard's RHS is a
    // provable COMPILE-TIME CONSTANT exactly when its proven range collapses to a single point —
    // the WAT-level bound the vectorizer later sees must be that SAME i32.const when so (see
    // ir.js's loopPlanLink doc + vectorize.js's assertLoopPlanAgrees). No new semantics:
    // reuses guardBoundRange, above.
    const boundConst = guardBoundRange && guardBoundRange[0] === guardBoundRange[1] ? guardBoundRange[0] : null
    let guardHadPrev = false, guardPrev
    if (guardBoundRange) {
      const map = loopGuardHi()
      guardHadPrev = map.has(guardName)
      guardPrev = map.get(guardName)
      const hi = cond[0] === '<' ? guardBoundRange[1] - 1 : guardBoundRange[1]
      map.set(guardName, guardHadPrev ? Math.min(guardPrev, hi) : hi)
    }
    const emitLoopBody = () => withRefinements(counterRefs, body, () => emitVoid(body))
    const loopBody = []
    if (condForLoop) loopBody.push(['br_if', brk, ['i32.eqz', toBool(condForLoop)]])
    loopBody.push(...freshBoxed)
    if (needsCont) loopBody.push(['block', cont, ...emitLoopBody()])
    else loopBody.push(...emitLoopBody())
    if (guardBoundRange) {
      const map = loopGuardHi()
      if (guardHadPrev) map.set(guardName, guardPrev); else map.delete(guardName)
    }
    if (step) loopBody.push(...emitVoid(step))
    loopBody.push(['br', loop])
    const loopBlockNode = ['block', brk, ['loop', loop, ...loopBody]]
    // HIR provenance link (.work/research.md §BodyModel slice 4; pre-
    // emission move): stamp this WAT loop's originating HIR facts so the vectorizer's
    // dispatch can shadow-assert against them — see ir.js's loopPlanLink doc for the
    // {plan, lowering} split and the identity/fail-open contract. `plan` (id/hull/
    // boundConst) is no longer built HERE — it's minted pre-emission, once per AST
    // loop, by loop-model.js's mintLoopPlans (called from analyzeFuncForEmit /
    // emitClosureBody, before any function's body is emitted), keyed by `bodyNode0`
    // (this loop's OWN body identity — survives both the hoist rebind above and the
    // typed-bounds guard's fast/checked-arm double-emission of this same AST loop,
    // see mintLoopPlans' own doc). A miss (pre-trio spec 2: fail-open) means no HIR
    // facts were minted for this loop — skip the link entirely rather than fabricate
    // one; `lowering` (the WAT-side name map) stays mutable, kept in sync by
    // freshenUnrolledScalarBindings.
    const plan = ctx.plans.loops.get(bodyNode0)
    if (plan) ctx.plans.loweringLinks.set(loopBlockNode, { plan, lowering: { ivName: counterName, guardName } })
    result.push(loopBlockNode)
    return result.length === 1 ? result[0] : result
    })
  },

  'switch': (discriminant, ...cases) => {
    const disc = `${T}disc${freshId(ctx)}`
    ctx.func.locals.set(disc, 'f64')

    const result = [['local.set', `$${disc}`, asF64(emit(discriminant))]]

    for (const c of cases) {
      if (c[0] === 'case') {
        const [, test, body] = c
        const skip = `$skip${freshId(ctx)}`
        // Block: skip if discriminant != test, otherwise execute body
        result.push(['block', skip,
          ['br_if', skip, typed(['f64.ne', typed(['local.get', `$${disc}`], 'f64'), asF64(emit(test))], 'i32')],
          ...emitVoid(body)])
      } else if (c[0] === 'default') {
        result.push(...emitVoid(c[1]))
      }
    }

    return result
  },

  'while': (cond, body) => emitter['for'](null, cond, null, body),
  'label': (name, body) => {
    const brk = `$label${freshId(ctx)}`
    return withControlFrame({ label: name, brk }, () =>
      // Hand the label to the immediately-enclosed loop. A loop consumes the
      // value; the field scope clears it on every exit when no loop does.
      withPendingLabel(name, () => ['block', brk, ...emitVoid(body)]))
  },
  'break': (label) => {
    const idx = label == null
      ? ctx.func.stack.length - 1
      : ctx.func.stack.findLastIndex(frame => frame.label === label)
    if (label != null && idx < 0) err(`break label '${label}' is not in scope — check the spelling, or add a matching \`${label}:\` around an enclosing loop/block`)
    const target = (idx >= 0 ? ctx.func.stack[idx] : loopTop()).brk
    if (!target) err(`break label '${label}' is not in scope`)
    return [...emitFinalizers(idx + 1), ['br', target]]
  },
  'continue': (label) => {
    if (label == null) return [...emitFinalizers(ctx.func.stack.length), ['br', loopTop().loop]]
    // Labeled continue: target the continue point of the loop that adopted this label.
    const idx = ctx.func.stack.findLastIndex(f => f.contLabel === label)
    if (idx < 0) err(`continue label '${label}' is not in scope — check the spelling, or add a matching \`${label}:\` around an enclosing loop`)
    return [...emitFinalizers(idx + 1), ['br', ctx.func.stack[idx].loop]]
  },

  ...callOps,
}
