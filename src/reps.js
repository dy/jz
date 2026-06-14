/**
 * ValueRep storage + VAL lattice lookups (ctx-backed, cycle-free).
 *
 * Thin accessors shared by ir, emit, stdlib, and analyze. Keeps heavy AST
 * walkers in analyze.js without pulling them into ir.js.
 *
 * ## Lookup priority (lookupValType / lookupNotString)
 *
 * A single binding can carry several pieces of type knowledge, set at different
 * lifecycle phases. Accessors resolve them in this fixed order — first hit wins:
 *
 *   1. `ctx.func.refinements`           flow-sensitive (typeof/instanceof guard)
 *   2. `ctx.func.localValTypesOverlay`  call-site / loop-iter overlay (transient)
 *   3. `ctx.func.localReps`             per-function plan/analyze fact (durable)
 *   4. `ctx.scope.globalValTypes`       module-level binding (durable)
 *
 * Writes go through `updateRep` (#3 mutator) / `updateGlobalRep` (#4 mutator).
 * Refinements (#1) are managed by `withRefinements` in emit; overlay (#2) is
 * scoped by call/loop-emit code and torn down when the scope exits.
 *
 * Mutation sites by phase:
 *   plan.js          — initial reps from prepare-pass typing
 *   analyze.js       — boxing decisions, schema bindings, sched facts
 *   compile/index.js — closure-arg upgrades, propagation across calls
 *   emit.js          — withRefinements / overlay, transient narrowing only
 *
 * @module reps
 */

import { ctx } from './ctx.js'

/** Value kinds — method dispatch, schema, carrier selection. */
export const VAL = {
  NUMBER: 'number', ARRAY: 'array', STRING: 'string',
  OBJECT: 'object', HASH: 'hash', SET: 'set', MAP: 'map',
  CLOSURE: 'closure', TYPED: 'typed', REGEX: 'regex',
  BIGINT: 'bigint', BUFFER: 'buffer', DATE: 'date',
  BOOL: 'boolean',
}

/**
 * A binding's inferred representation. Every field optional; absence = "unknown".
 * Written only through updateRep / updateGlobalRep, plus a few direct r.wasm /
 * r.typedCtor mutations in narrow.js's signature fixpoint. This is the *closed*
 * shape: REP_FIELDS is the single source of truth — it gates updateRep in debug
 * mode and drives repView, so a typo'd key surfaces loudly instead of silently
 * vanishing into the open `{...prev, ...fields}` spread.
 *
 * @typedef {Object} ValueRep
 * @property {string}  [val]              VAL.* kind (number/array/string/…).
 * @property {number}  [ptrKind]          PTR.* pointer class for NaN-box rebox.
 * @property {number}  [ptrAux]           aux bits in the NaN-box (schema id / elem type).
 * @property {number}  [schemaId]         object-shape id (OBJECT kind).
 * @property {number}  [intConst]         proven constant integer value.
 * @property {boolean} [intCertain]       integer-valued on every path.
 * @property {boolean} [notString]        proven not a string (skips string-path guards).
 * @property {number}  [arrayElemSchema]  element object-schema id for arrays.
 * @property {string}  [arrayElemValType] element VAL.* kind for arrays.
 * @property {string}  [carrier]          abi carrier id override (e.g. 'jsstring').
 * @property {boolean} [unsigned]         i32 carries an unsigned value (`>>>` result).
 * @property {*}       [jsonShape]        inferred shape for the JSON.stringify fast path.
 * @property {string}  [typedCtor]        TypedArray ctor name (TYPED kind); null = bimorphic.
 * @property {string}  [wasm]             wasm storage type 'i32'|'f64' (narrow.js fixpoint).
 * @property {boolean} [nullable]         binding can hold null/undefined on some path
 *   (init or an assignment was a nullish literal) — suppresses the `=== null` /
 *   `=== undefined` constant-fold even when `val` is a definite non-null kind.
 */
export const REP_FIELDS = new Set([
  'val', 'ptrKind', 'ptrAux', 'schemaId', 'intConst', 'intCertain', 'notString',
  'arrayElemSchema', 'arrayElemValType', 'carrier', 'unsigned', 'jsonShape',
  'typedCtor', 'wasm', 'nullable', 'neverGrown',
])

const DBG_REPS = typeof process !== 'undefined' && process.env?.JZ_DEBUG_INVARIANTS === '1'
const assertRepFields = (name, fields) => {
  for (const k in fields)
    if (!REP_FIELDS.has(k))
      throw new Error(`updateRep('${name}', {${k}}): unknown ValueRep field — typo, or add it to REP_FIELDS in reps.js`)
}

/** @returns {ValueRep|undefined} */
export const repOf = name => ctx.func.localReps?.get(name)

export const updateRep = (name, fields) => {
  if (DBG_REPS) assertRepFields(name, fields)
  const m = ctx.func.localReps ||= new Map()
  const prev = m.get(name) || {}
  const next = { ...prev, ...fields }
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
  if (Object.keys(next).length === 0) m.delete(name)
  else m.set(name, next)
}

export const repOfGlobal = name => ctx.scope.globalReps?.get(name)

export const updateGlobalRep = (name, fields) => {
  if (DBG_REPS) assertRepFields(name, fields)
  const m = ctx.scope.globalReps ||= new Map()
  const prev = m.get(name)
  m.set(name, prev ? { ...prev, ...fields } : { ...fields })
}

export const lookupValType = name => {
  const r = ctx.func.refinements
  if (r?.size) { const v = r.get(name)?.val; if (v) return v }
  const ov = ctx.func.localValTypesOverlay
  if (ov) { const v = ov.get(name); if (v) return v }
  return ctx.func.localReps?.get(name)?.val || ctx.scope.globalValTypes?.get(name) || null
}

export const lookupNotString = name => {
  const r = ctx.func.refinements
  if (r?.size && r.get(name)?.notString) return true
  return ctx.func.localReps?.get(name)?.notString === true
}
