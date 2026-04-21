/**
 * Schema subsystem — object property layout registration, lookup, boxing.
 *
 * Owns: register, find, isBoxed, emitInner on ctx.schema.
 * Used by: core.js (property dispatch), object.js (literals), prepare.js (tracking).
 *
 * @module schema
 */

import { emit, typed, asF64, VAL, lookupValType } from '../src/compile.js'
import { err, inc } from '../src/ctx.js'

/** Initialize schema helpers on ctx. Called once per compilation from core module. */
export function initSchema(ctx) {
  // key → schemaId for O(1) dedupe; prop → [{id, slot}] for O(matches) structural find.
  // \x01 delimiter avoids collision with any legal JS identifier character.
  const byKey = new Map()
  const byProp = new Map()
  ctx.schema._byKey = byKey
  ctx.schema._byProp = byProp

  ctx.schema.register = (props) => {
    const key = props.join('\x01')
    const existing = byKey.get(key)
    if (existing != null) return existing
    const id = ctx.schema.list.push(props) - 1
    byKey.set(key, id)
    for (let i = 0; i < props.length; i++) {
      const p = props[i]
      let bucket = byProp.get(p)
      if (!bucket) byProp.set(p, bucket = [])
      bucket.push({ id, slot: i })
    }
    return id
  }

  /** Resolve variable name to its schema props array, or null. */
  ctx.schema.resolve = (varName) => {
    const id = ctx.schema.vars.get(varName)
    return id != null ? ctx.schema.list[id] : null
  }

  /** Check if variable has a boxed schema (slot 0 = __inner__). */
  ctx.schema.isBoxed = (varName) => {
    const id = ctx.schema.vars.get(varName)
    return id != null && ctx.schema.list[id]?.[0] === '__inner__'
  }

  /** Emit code to load the inner value (slot 0) of a boxed variable. */
  ctx.schema.emitInner = (varName) => {
    inc('__ptr_offset')
    return typed(['f64.load', ['call', '$__ptr_offset', asF64(emit(varName))]], 'f64')
  }

  /** Find property index by variable schema or structural subtyping.
   *  Returns -1 to signal "use dynamic lookup" in three cases:
   *    1. Variable has precise schema but schema lacks the property
   *    2. Variable's valType is known and is not an object
   *    3. Structural search finds the property at inconsistent offsets across schemas
   *  Case 3 is a real ambiguity — the caller must route to runtime dispatch.
   *  `safe=true` disables structural subtyping when the variable's type is not
   *  known to be VAL.OBJECT. Use for writes: a wrong slot clobbers unrelated
   *  memory (e.g. arr.loc = ... corrupting arr[slot]). Reads only return wrong
   *  values, which callers can tolerate. */
  ctx.schema.find = (varName, prop, safe = false) => {
    // Precise: variable has known schema
    const id = ctx.schema.vars.get(varName)
    if (id != null) return ctx.schema.list[id]?.indexOf(prop) ?? -1
    // Known non-object pointer-backed values must use dynamic property lookup,
    // not structural object schemas registered elsewhere in the function.
    if (typeof varName === 'string') {
      const vt = lookupValType(varName)
      if (vt != null && vt !== VAL.OBJECT) return -1
      if (safe && vt !== VAL.OBJECT) return -1
    }
    // Structural subtyping: walk only schemas that contain this prop.
    // Consistent slot across all → return slot; any mismatch → -1 (dynamic lookup).
    const bucket = byProp.get(prop)
    if (!bucket) return -1
    const slot = bucket[0].slot
    for (let i = 1; i < bucket.length; i++) if (bucket[i].slot !== slot) return -1
    return slot
  }
}
