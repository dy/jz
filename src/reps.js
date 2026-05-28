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

/** Per-function ValueRep record. See lookupValType for resolution priority. */
export const repOf = name => ctx.func.localReps?.get(name)

export const updateRep = (name, fields) => {
  const m = ctx.func.localReps ||= new Map()
  const prev = m.get(name) || {}
  const next = { ...prev, ...fields }
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
  if (Object.keys(next).length === 0) m.delete(name)
  else m.set(name, next)
}

export const repOfGlobal = name => ctx.scope.globalReps?.get(name)

export const updateGlobalRep = (name, fields) => {
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
