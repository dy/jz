/**
 * Object-literal and declaration schema tracking: bindSchema/
 * censusUnknownInitDecl/objLiteralSid — the "track
 * schemas" concern from the pass's own header contract.
 *
 * @module prepare/schema
 */

import { isBrand, spreadExclusions } from '../ast.js'
import { enumKeys } from '../../module/schema.js'
import { ctx } from '../ctx.js'
import { assignSid, declInitUnknown } from './state.js'

// One shape census for literal expressions, declarations and assignments.
// A spread contributes its known source keys; conditional/unknown sources
// cannot establish a fixed layout.
export function objLiteralSid(prhs) {
  if (!Array.isArray(prhs) || prhs[0] !== '{}') return null
  const raw = prhs.length === 2 && prhs[1]?.[0] === ',' ? prhs[1].slice(1) : prhs.slice(1)
  const names = []
  let brand = null
  const add = name => { if (!names.includes(name)) names.push(name) }
  for (const p of raw) {
    if (p?.[0] === ':' && typeof p[1] === 'string') {
      if (isBrand(p[1])) brand = p[1]; else add(p[1])
    } else if (p?.[0] === '...') {
      const sid = typeof p[1] === 'string' ? ctx.schema.idOf(p[1]) : objLiteralSid(p[1])
      const props = sid == null ? null : ctx.schema.list[sid]
      // an object rest skips its pattern's keys; a computed one is known at run time only
      const skip = spreadExclusions(p)
      if (!props || skip?.exprs.length) return null
      // a spread copies values: an accessor is the data key it defines (module/schema.js enumView)
      for (const name of enumKeys(props)) if (!skip?.names.includes(name)) add(name)
    } else return null
  }
  return names.length || brand ? ctx.schema.register(names, brand) : null
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
