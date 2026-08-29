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
import { bitwiseOps } from './emit/bitwise.js'
import { emitFinalizers, spreadOp, statementOps } from './emit/statements.js'
import { controlFlowOps, emitLoopFreshBoxed } from './emit/control-flow.js'
export { emitLoopFreshBoxed }
import { assignmentOps } from './emit/assignment.js'
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

// === Core emitter dispatch table ===
// ctx.core.emit is seeded with a flat copy of this object on reset;
// language modules add or override ops on ctx.core.emit directly.

/**
 * Core emitter table. Maps AST ops to WASM IR generators.
 * @type {Record<string, (...args: any[]) => Array>}
 */
export const emitter = {
  ...spreadOp,
  ...statementOps,
  ...assignmentOps,
  ...incdecOps,
  ...arithmeticOps,
  ...comparisonOps,
  ...logicalOps,
  ...bitwiseOps,
  ...controlFlowOps,
  ...callOps,
}
