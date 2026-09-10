/**
 * Object-literal and declaration schema tracking: bindSchema/
 * censusUnknownInitDecl/conditionalSpreadGroupPrepare/inferAssignSchema — the "track
 * schemas" concern from the pass's own header contract.
 *
 * @module prepare/schema
 */

import { staticObjectProps } from '../static.js'
import { ctx } from '../ctx.js'
import { assignSid, declInitUnknown } from './state.js'

// Schema id when prhs is a bare object literal with static keys, else null.
export function objLiteralSid(prhs) {
  if (!Array.isArray(prhs) || prhs[0] !== '{}') return null
  const props = staticObjectProps(prhs.slice(1))
  return props ? ctx.schema.register(props.names, props.brand) : null
}

// Declarations and assignments share one consensus over source shapes. A
// replacement with a different shape must not inherit the earlier layout.
// The binding's planned layout may later grow through property writes, so
// compare source ids here, not the potentially merged schema.vars entry.
export function bindSchema(name, sid, bind = true) {
  if (ctx.schema.poisoned?.has(name)) return
  const had = assignSid.get(name)
  // Even equal source shapes are distinct allocations. Extending one through
  // Object.assign/property writes cannot extend every replacement's layout.
  if (had != null) ctx.schema.unknownInit?.add(name)
  const layout = ctx.schema.vars.get(name)
  if (sid == null || declInitUnknown.has(name) || (had != null && (had !== sid || layout != null && layout !== sid))) {
    assignSid.delete(name)
    ctx.schema.vars.delete(name)
    ctx.schema.poisoned?.add(name)
    return
  }
  assignSid.set(name, sid)
  // Assignment-only local facts stay in ValueReps. Declarations and module
  // assignments also publish the layout used by prepare's object operations.
  if (bind && !ctx.schema.vars.has(name)) ctx.schema.vars.set(name, sid)
}

// A BINDING whose value source the assignment consensus never sees — explicit
// non-literal decl initializer (`let o = mk()`, `= [...spread]`), params,
// catch params, destructure targets. Under BindingId totality this is a plain
// per-binding fact: sources disagree, so any literal-shape claim dies. Such a
// name's objects are minted elsewhere (ctx.schema.unknownInit: no plan step
// gives it a merged or boxed layout), except an empty `{}` initializer
// (`ownLiteral`), whose construction adopts the layout the plan decides.
export function censusUnknownInitDecl(name, ownLiteral = false) {
  if (typeof name !== 'string') return
  declInitUnknown.add(name)
  if (!ownLiteral) ctx.schema.unknownInit?.add(name)
  if (ctx.schema.vars.has(name)) { ctx.schema.vars.delete(name); ctx.schema.poisoned?.add(name) }
}
// Recognizes `cond && {k: v, …}` — decl-schema-binding's own hand-synced copy
// of module/object.js's conditionalSpreadGroup / src/kind.js's identical
// mirror (see the decl-tracking call site below for why prepare needs its
// own). Returns the inner literal's key list (order preserved) or null.
export function conditionalSpreadGroupPrepare(node) {
  if (!Array.isArray(node) || node[0] !== '&&' || node.length !== 3) return null
  let inner = node[2]
  while (Array.isArray(inner) && inner[0] === '&&' && inner.length === 3) inner = inner[2]
  if (!Array.isArray(inner) || inner[0] !== '{}') return null
  const props = inner.length === 2 && Array.isArray(inner[1]) && inner[1][0] === ','
    ? inner[1].slice(1) : inner.slice(1)
  if (!props.length || !props.every(p => Array.isArray(p) && p[0] === ':')) return null
  return props.map(p => p[1])
}

/** Merge source schemas into target via Object.assign for compile-time schema
 *  inference. The merged schema is the layout the target's own literal adopts
 *  at construction (module/object.js honors it), so only a binding minted by
 *  its own literal can take it: a parameter, a call result or a destructure
 *  target (ctx.schema.unknownInit) holds objects minted elsewhere, and a slot
 *  copy by a schema they do not carry lands past their fields. Such a target
 *  keeps no schema and the assign takes the dynamic path. */
export function inferAssignSchema(callNode) {
  // After prep, args may be comma-grouped: ['()', callee, [',', target, s1, s2]]
  let assignArgs = callNode.slice(2)
  if (assignArgs.length === 1 && Array.isArray(assignArgs[0]) && assignArgs[0][0] === ',')
    assignArgs = assignArgs[0].slice(1)
  const [target, ...sources] = assignArgs
  if (typeof target !== 'string' || ctx.schema.unknownInit?.has(target)) return
  const existingId = ctx.schema.vars.get(target)
  const merged = existingId != null ? [...ctx.schema.list[existingId]] : []
  for (const src of sources) {
    let srcProps
    if (Array.isArray(src) && src[0] === '{}')
      srcProps = src.slice(1).filter(p => Array.isArray(p) && p[0] === ':').map(p => p[1])
    else if (typeof src === 'string') {
      const srcId = ctx.schema.vars.get(src)
      if (srcId != null) srcProps = ctx.schema.list[srcId]
    }
    if (srcProps) for (const p of srcProps) if (!merged.includes(p)) merged.push(p)
  }
  // Poisoned names stay out of the shared channel.
  if (merged.length && !ctx.schema.poisoned?.has(target))
    ctx.schema.vars.set(target, ctx.schema.register(merged))
}