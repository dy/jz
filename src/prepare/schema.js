/**
 * Object-literal and declaration schema tracking: bindAssignSchema/bindDeclSchema/
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
  return props ? ctx.schema.register(props.names) : null
}

// Shape-consensus accounting for every `name = …` assignment. `sid` is the
// RHS literal's schema id (null for any non-literal source). A name's schema
// binds only while ALL its assignments agree on that one literal shape: the
// first literal binds; any disagreeing assignment — non-literal RHS or a
// different-shape literal — unbinds and poisons. Poisoned names never rebind,
// so compile-time fixed-slot reads can't be aimed at one shape while the
// variable holds another (the misread class: `.x` returning a foreign
// object's slot-0 value). Compile consumes the END state — order-insensitive.
export function bindAssignSchema(name, sid, bind = true) {
  // Consensus (poison) is tracked for EVERY assignment; only module-scope
  // names additionally BIND into ctx.schema.vars — that map is module-global,
  // and publishing a function local there both mis-keys it and costs real
  // codegen (a local in vars blocked scalar replacement: 5320 → 1310 B).
  // Function locals resolve through their per-function ValueReps instead;
  // their poison still has to be recorded, or a disagreeing literal would
  // serve a fixed slot to a value of another shape.
  // BindingId totality: same name ⇒ same binding, module-wide. The old
  // cross-binding containment (bindSites bar census, owner-scoped poison
  // reachability, assignBindOwners) is unrepresentable and deleted — a
  // binding with any unknown-source site simply has disagreeing sources.
  const had = assignSid.get(name)
  if (had != null) {
    if (had !== sid) { assignSid.delete(name); ctx.schema.vars.delete(name); ctx.schema.poisoned?.add(name) }
  } else if (sid != null) {
    if (declInitUnknown.has(name)) { ctx.schema.poisoned?.add(name); return }
    if (!ctx.schema.poisoned?.has(name)) {
      assignSid.set(name, sid)
      if (bind) ctx.schema.vars.set(name, sid)
    }
  } else ctx.schema.poisoned?.add(name)
}

// A BINDING whose value source the assignment consensus never sees — explicit
// non-literal decl initializer (`let o = mk()`, `= [...spread]`), params,
// catch params, destructure targets. Under BindingId totality this is a plain
// per-binding fact: sources disagree, so any literal-shape claim dies.
export function censusUnknownInitDecl(name) {
  if (typeof name !== 'string') return
  declInitUnknown.add(name)
  if (ctx.schema.vars.has(name)) { ctx.schema.vars.delete(name); ctx.schema.poisoned?.add(name) }
}
// Consensus setter for literal-shape BINDINGS (`const x = {…}` at any scope,
// object-literal param defaults) — the decl-initializer sibling of
// bindAssignSchema (which owns the `=`-assignment channel and its poison).
export function bindDeclSchema(name, sid) {
  if (typeof name !== 'string') return
  if (ctx.schema.poisoned?.has(name) || declInitUnknown.has(name)) return
  const had = ctx.schema.vars.get(name)
  if (had != null && had !== sid) { ctx.schema.vars.delete(name); ctx.schema.poisoned?.add(name); return }
  ctx.schema.vars.set(name, sid)
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

/** Merge source schemas into target via Object.assign for compile-time schema inference. */
export function inferAssignSchema(callNode) {
  // After prep, args may be comma-grouped: ['()', callee, [',', target, s1, s2]]
  let assignArgs = callNode.slice(2)
  if (assignArgs.length === 1 && Array.isArray(assignArgs[0]) && assignArgs[0][0] === ',')
    assignArgs = assignArgs[0].slice(1)
  const [target, ...sources] = assignArgs
  if (typeof target !== 'string') return
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