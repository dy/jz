/**
 * Expression value KIND inference (STRING, ARRAY, …) + JSON shape propagation.
 *
 * Cycle-free w.r.t. analyze.js body walkers — reads ctx + reps only.
 *
 * Barrel re-export only (pipeline-minimality slice, .work/archive/kind-split.md) —
 * every name below is defined in one of the family modules under `kind/`:
 *   kind/lattice.js      — literal-lattice helpers + the nullish-arm join predicate
 *   kind/dict-census.js  — whole-program dict/Map value-kind census
 *   kind/shape.js        — JSON shape propagation + object-spread schema
 *   kind/val-type-of.js  — the VT dispatch table, valTypeOf/valTypeOfWithLocals,
 *                           hasAmbiguousBoolMerge, shapeOfObjectLiteralAst
 *
 * @module kind
 */

export { nullishArm } from './kind/lattice.js'
export {
  dictValueKindOf, mapValueKindOf, censusKindsOf, censusShapedNode,
  censusMaybeUndefinedKind, BIGINT_JOINT_BINARY_OPS, censusBigintResultShape,
  nameMayBeUndefinedInBody, exprMayBeUndefinedIn, exprMapGetShapedIn,
  censusMaybeUndefined, namePresentValInBody, exprPresentValIn, localMapGetMayCarryBigint,
} from './kind/dict-census.js'
export { shapeOf, jsonConstString } from './kind/shape.js'
export {
  hasAmbiguousBoolMerge, valTypeOf, valTypeOfWithLocals, shapeOfObjectLiteralAst,
} from './kind/val-type-of.js'
