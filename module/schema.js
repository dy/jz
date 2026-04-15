/**
 * Schema subsystem — object property layout registration, lookup, boxing.
 *
 * Owns: register, find, isBoxed, emitInner on ctx.schema.
 * Used by: core.js (property dispatch), object.js (literals), prepare.js (tracking).
 *
 * @module schema
 */

import { emit, typed, asF64, VAL } from '../src/compile.js'
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

  /** Find property index by variable schema or structural subtyping.
   *  Returns -1 to signal "use dynamic lookup" in three cases:
   *    1. Variable has precise schema but schema lacks the property
   *    2. Variable's valType is known and is not an object
   *    3. Structural search finds the property at inconsistent offsets across schemas
   *  Case 3 is a real ambiguity — the caller must route to runtime dispatch. */
  ctx.schema.find = (varName, prop) => {
    // Precise: variable has known schema
    const id = ctx.schema.vars.get(varName)
    if (id != null) return ctx.schema.list[id]?.indexOf(prop) ?? -1
    // Known non-object pointer-backed values must use dynamic property lookup,
    // not structural object schemas registered elsewhere in the function.
    if (typeof varName === 'string') {
      const vt = ctx.func.valTypes?.get(varName) || ctx.scope.globalValTypes?.get(varName)
      if (vt != null && vt !== VAL.OBJECT) return -1
    }
    // Structural subtyping: scan all schemas, require consistent offset.
    // Only safe when all schemas that define the property agree on its slot.
    // Any disagreement → -1 (dynamic lookup); silent mismatched-offset reads are a latent bug.
    let result = -1
    for (const s of ctx.schema.list) {
      const idx = s.indexOf(prop)
      if (idx < 0) continue
      if (result >= 0 && result !== idx) return -1
      result = idx
    }
    return result
  }
}
