/**
 * Pure IR construction helpers for WAT-as-array output — barrel module.
 *
 * The implementation lives in src/ir/*.js, split by family (see
 * .work/ir-split.md for the full family map and dependency-order
 * rationale); this file re-exports the same public names every one of its
 * ~76 importers across src/, module/, and test/ already depends on, so no
 * call site needs to change.
 *
 * # Stage contract
 *   IN:  bare primitives (strings, numbers, AST nodes), ctx reads for locals/globals/schema
 *   OUT: tagged IR nodes (arrays with `.type` property)
 *   NO-EMIT: nothing here calls `emit()` — these are leaf constructors. Helpers that
 *        recurse into AST nodes (toBool, materializeMulti, emitDecl, buildArrayWithSpreads,
 *        emitTypeofCmp) live in emit.js because they invoke the dispatch table.
 *
 * # Families (src/ir/*.js)
 *   - tag.js       — result-type tagging (`typed`), the one universal primitive
 *   - locals.js    — temp-local factories + the block scaffolds built around them
 *   - pointers.js  — NaN-box pointer construction/extraction + pointer-tag dispatch
 *   - classify.js  — WASM-op constants + literal/purity classification of IR nodes
 *   - control.js   — whole-IR-tree structural utilities + control-flow/tail-call helpers
 *   - numeric.js   — f64/i32/i64 coercions + int-narrowing range analysis
 *   - bigint.js    — BigInt carrier box/unbox (the phase-C representation campaign's
 *                    pairing family — .work/phase-c-unification.md)
 *   - vars.js      — variable storage abstraction (boxed/global/local dispatch)
 *   - arrays.js    — array-layout IR (slot/elem loads, allocPtr, arrayLoop)
 *   - sentinels.js — NaN-boxed sentinels, boxed-boolean carriers, truthiness testing
 *   - coerce.js    — ToNumber/ToString/ToPrimitive coercion
 *
 * @module ir
 */

export { I32_MIN, I32_MAX, isI32, isLiteralStr, isFuncRef } from './ast.js'

export { typed } from './ir/tag.js'
export { freshId, temp, tempI32, tempI64, block64, blockTyped, withTemp } from './ir/locals.js'
export { mkPtrIR, ptrOffsetIR, valKindToPtr, ptrTypeIR, extractF64Bits, ptrTypeEq, dispatchByPtrType } from './ir/pointers.js'
export { MAX_CLOSURE_ARITY, MEM_OPS, WASM_OPS, SPREAD_MUTATORS, BOXED_MUTATORS, isLit, litVal, isNullLit, isUndefLit, isNullishLit, isPureIR, hasExpensiveOp, dataDependentFlag, isNumericIR, resolveValType, isPostfix, emitNum } from './ir/classify.js'
export { multiCount, loopTop, flat, findBodyStart, verifyFn, buildRefcount, nextLocalId, freshLoopPlanId, tcoTailRewrite, reconstructArgsWithSpreads } from './ir/control.js'
export { asF64, asI32, asI32Sat, asPtrOffset, asParamType, maskBound, f64Range, toI32, asI64, fromI64, f64rem } from './ir/numeric.js'
export { bigintStrict, bigintEraseErr, boxBigInt, unboxBigInt, applyBigintRepresentationAction, maybeUnboxBigInt, isSchemaSlotBigintPossible, isTernaryBoxedBigint, isPlanTaggedBigint, readI64 } from './ir/bigint.js'
export { usesDynProps, needsDynShadow, isBoundName, isGlobal, isConst, boxedAddr, dollar, dollarMap, setDollarMap, clearDollar, readVar, writeVar } from './ir/vars.js'
export { slotAddr, elemLoad, elemStore, arrayLoop, allocPtr } from './ir/arrays.js'
export { NULL_NAN, UNDEF_NAN, TOMB_NAN, BOOL_ATOM_BASE, FALSE_NAN, TRUE_NAN, NULL_WAT, UNDEF_WAT, NULL_IR, UNDEF_IR, FALSE_IR, TRUE_IR, nullExpr, undefExpr, boolBoxIR, carrierF64, carrierF64Narrow, unboxBoolIR, isNullish, isUndef, isNull, throwTypeErrorIR, isBoolAtom, truthyIR, toBoolFromEmitted } from './ir/sentinels.js'
export { sidecarOverride, cloneIR, coerceNullishToNum, coerceNullishToStr, toNumF64, toStrI64 } from './ir/coerce.js'
