import { OPTF } from './ctx.js'
import { ERR } from '../err-codes.js'
/**
 * Pure IR construction helpers for WAT-as-array output.
 *
 * # Stage contract
 *   IN:  bare primitives (strings, numbers, AST nodes), ctx reads for locals/globals/schema
 *   OUT: tagged IR nodes (arrays with `.type` property)
 *   NO-EMIT: nothing here calls `emit()` — these are leaf constructors. Helpers that
 *        recurse into AST nodes (toBool, materializeMulti, emitDecl, buildArrayWithSpreads,
 *        emitTypeofCmp) live in emit.js because they invoke the dispatch table.
 *
 * # Layers
 *   - Type tagging (`typed`, coercions)
 *   - Nullish sentinels + NaN-boxed pointer construction
 *   - Literal / purity classifiers
 *   - Constant pools (WASM_OPS, MEM_OPS, mutator sets)
 *   - Temp-local factories (mutate `ctx.func.locals`)
 *   - Variable storage abstraction (boxed/global/local dispatch)
 *   - Array-layout IR (slot/elem loads, allocPtr, arrayLoop)
 *
 * @module ir
 */

import { ctx, err, inc, PTR, LAYOUT } from './ctx.js'
import { declareLocal, freshEmitId } from './compile/active-function.js'
import { BIGINT_REP_BOXED, BIGINT_REP_CLOSED, REP_EDGE_BOX, REP_EDGE_UNBOX, representationActiveMaterializedRep } from './compile/representation-plan.js'
import { ptrBoxPrefixBigInt, ptrBits, i64Hex, atomNanHex, nanPrefixHex, OBJECT_SCHEMA_HI_MASK, objectSchemaGuardHex } from '../layout.js'
import { ERR_CLASS_NAMES } from '../err-codes.js'
import { I32_MIN, I32_MAX, isI32, isLiteralStr, isFuncRef, isLeaf, walkAst, some, REFS_THROUGH_ARROWS } from './ast.js'
import { VAL, lookupValType, repOf, repOfGlobal } from './reps.js'
import { valTypeOf, censusMaybeUndefined, censusMaybeUndefinedKind, censusShapedNode } from './kind.js'
import { T } from './ast.js'
import { objLiteralSchemaId } from './static.js'

export { I32_MIN, I32_MAX, isI32, isLiteralStr, isFuncRef }

import { typed } from './ir/tag.js'
export { typed }

import { freshId, temp, tempI32, tempI64, block64, blockTyped, withTemp } from './ir/locals.js'
export { freshId, temp, tempI32, tempI64, block64, blockTyped, withTemp }

import { mkPtrIR, ptrOffsetIR, valKindToPtr, ptrTypeIR, extractF64Bits, ptrTypeEq, dispatchByPtrType, boxPtrIR } from './ir/pointers.js'
export { mkPtrIR, ptrOffsetIR, valKindToPtr, ptrTypeIR, extractF64Bits, ptrTypeEq, dispatchByPtrType }

import { MAX_CLOSURE_ARITY, MEM_OPS, WASM_OPS, SPREAD_MUTATORS, BOXED_MUTATORS, isLit, litVal, isNullLit, isUndefLit, isNullishLit, isPureIR, hasExpensiveOp, dataDependentFlag, isNumericIR, resolveValType, isPostfix, emitNum, PURE_F64_OPS } from './ir/classify.js'
export { MAX_CLOSURE_ARITY, MEM_OPS, WASM_OPS, SPREAD_MUTATORS, BOXED_MUTATORS, isLit, litVal, isNullLit, isUndefLit, isNullishLit, isPureIR, hasExpensiveOp, dataDependentFlag, isNumericIR, resolveValType, isPostfix, emitNum }

import { multiCount, loopTop, flat, findBodyStart, verifyFn, buildRefcount, nextLocalId, freshLoopPlanId, tcoTailRewrite, reconstructArgsWithSpreads } from './ir/control.js'
export { multiCount, loopTop, flat, findBodyStart, verifyFn, buildRefcount, nextLocalId, freshLoopPlanId, tcoTailRewrite, reconstructArgsWithSpreads }

import { asF64, asI32, asI32Sat, asPtrOffset, asParamType, maskBound, f64Range, toI32, asI64, fromI64, f64rem } from './ir/numeric.js'
export { asF64, asI32, asI32Sat, asPtrOffset, asParamType, maskBound, f64Range, toI32, asI64, fromI64, f64rem }

import { bigintStrict, bigintEraseErr, boxBigInt, unboxBigInt, applyBigintRepresentationAction, maybeUnboxBigInt, isSchemaSlotBigintPossible, isTernaryBoxedBigint, isPlanTaggedBigint, readI64 } from './ir/bigint.js'
export { bigintStrict, bigintEraseErr, boxBigInt, unboxBigInt, applyBigintRepresentationAction, maybeUnboxBigInt, isSchemaSlotBigintPossible, isTernaryBoxedBigint, isPlanTaggedBigint, readI64 }

import { usesDynProps, needsDynShadow, isBoundName, isGlobal, isConst, boxedAddr, dollar, dollarMap, setDollarMap, clearDollar, readVar, writeVar } from './ir/vars.js'
export { usesDynProps, needsDynShadow, isBoundName, isGlobal, isConst, boxedAddr, dollar, dollarMap, setDollarMap, clearDollar, readVar, writeVar }

import { slotAddr, elemLoad, elemStore, arrayLoop, allocPtr } from './ir/arrays.js'
export { slotAddr, elemLoad, elemStore, arrayLoop, allocPtr }

import { NULL_NAN, UNDEF_NAN, TOMB_NAN, BOOL_ATOM_BASE, FALSE_NAN, TRUE_NAN, NULL_WAT, UNDEF_WAT, NULL_IR, UNDEF_IR, FALSE_IR, TRUE_IR, nullExpr, undefExpr, boolBoxIR, carrierF64, carrierF64Narrow, unboxBoolIR, isNullish, isUndef, isNull, throwTypeErrorIR, isBoolAtom, truthyIR, toBoolFromEmitted } from './ir/sentinels.js'
export { NULL_NAN, UNDEF_NAN, TOMB_NAN, BOOL_ATOM_BASE, FALSE_NAN, TRUE_NAN, NULL_WAT, UNDEF_WAT, NULL_IR, UNDEF_IR, FALSE_IR, TRUE_IR, nullExpr, undefExpr, boolBoxIR, carrierF64, carrierF64Narrow, unboxBoolIR, isNullish, isUndef, isNull, throwTypeErrorIR, isBoolAtom, truthyIR, toBoolFromEmitted }

import { sidecarOverride, cloneIR, coerceNullishToNum, coerceNullishToStr, toNumF64, toStrI64 } from './ir/coerce.js'
export { sidecarOverride, cloneIR, coerceNullishToNum, coerceNullishToStr, toNumF64, toStrI64 }

