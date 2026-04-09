/**
 * Schema subsystem — object property layout registration, lookup, boxing.
 *
 * Owns: register, find, isBoxed, emitInner on ctx.schema.
 * Used by: core.js (property dispatch), object.js (literals), prepare.js (tracking).
 *
 * @module schema
 */

import { emit, typed, asF64 } from '../src/compile.js'
import { ctx, err } from '../src/ctx.js'

/** Initialize schema helpers on ctx. Called once per compilation from core module. */
export function initSchema() {
  /** Register a property layout. Returns existing id if identical, else new id. */
  ctx.schema.register = (props) => {
    const key = props.join(',')
    const existing = ctx.schema.list.findIndex(s => s.join(',') === key)
    if (existing >= 0) return existing
    return ctx.schema.list.push(props) - 1
  }

  /** Check if variable has a boxed schema (slot 0 = __inner__). */
  ctx.schema.isBoxed = (varName) => {
    const id = ctx.schema.vars.get(varName)
    return id != null && ctx.schema.list[id]?.[0] === '__inner__'
  }

  /** Emit code to load the inner value (slot 0) of a boxed variable. */
  ctx.schema.emitInner = (varName) => {
    return typed(['f64.load', ['call', '$__ptr_offset', asF64(emit(varName))]], 'f64')
  }

  /** Find property index by variable schema or structural subtyping. */
  ctx.schema.find = (varName, prop) => {
    // Precise: variable has known schema
    const id = ctx.schema.vars.get(varName)
    if (id != null) return ctx.schema.list[id]?.indexOf(prop) ?? -1
    // Structural subtyping: scan all schemas, require consistent offset.
    // This is the mechanism for schema objects passed through function parameters.
    // Falls through to HASH when no schema has the property.
    let result = -1
    for (const s of ctx.schema.list) {
      const idx = s.indexOf(prop)
      if (idx < 0) continue
      if (result >= 0 && result !== idx) return -1  // ambiguous → fall through to HASH runtime lookup
      result = idx
    }
    return result
  }
}
