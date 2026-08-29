/**
 * Signature narrowing — fixpoint analysis that mutates each user func's `sig`
 * based on call-site observations. Barrel module: the implementation lives in
 * src/compile/narrow/*.js, split by family (see .work/narrow-split.md for the
 * full family map and dependency-order rationale); this file re-exports the
 * same public names every one of its 3 importers already depends on, so no
 * call site needs to change.
 *
 * # Families (src/compile/narrow/*.js)
 *   - caller-ctx.js       — shared per-caller context builders + tiny shared data
 *   - param-abi.js        — wasm-type / pointer-ABI param specialization
 *   - results.js          — numeric/VAL-kind/pointer/bool result narrowing +
 *                            return-path array-elem propagation
 *   - summaries.js        — whole-program interprocedural analyses feeding
 *                            narrowSignatures
 *   - index.js            — narrowSignatures, the fixpoint driver (default export)
 *   - jsstring-carrier.js — externref string-param boundary opt-in
 *   - strict-boundary.js  — `strict: true` boundary type-conflict rejection
 *   - specialize.js       — call-site specialization/cloning via materializeVariant
 *   - dyn-keys.js         — dynamic-key refinement, standalone late pass
 *
 * @module compile/narrow
 */

export { default as default } from './narrow/index.js'
export { applyJsstringBoundaryCarrierStandalone, adviseJsstringCarrier } from './narrow/jsstring-carrier.js'
export { narrowBoolResults } from './narrow/results.js'
export { strictBoundaryTypeCheck } from './narrow/strict-boundary.js'
export { specializeBimorphicTyped, specializeValKindDichotomy, specializeUnionCursorParams, speculateTypedParams } from './narrow/specialize.js'
export { refineDynKeys } from './narrow/dyn-keys.js'
