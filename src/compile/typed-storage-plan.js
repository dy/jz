import { ctorFromElemAux, typedElemAux } from '../../layout.js'
import { VAL } from '../reps.js'
import { typedCtorName, typedStorageCtor } from '../typed-provenance.js'

/**
 * Frozen per-body typed-storage provenance.
 *
 * Analysis discovers constructors through bindings, function results, schema
 * fields, and arrays-of-typed-arrays. This plan captures those settled fact
 * views once before emission. Emitters ask this module for a constructor; they
 * do not repeat priority chains over mutable ambient ctx maps.
 *
 * The plan retains the analysis-owned MapOverlay views instead of cloning
 * them. They are detached with the analysis frame, never mutated after mint,
 * and sparse by construction. This avoids an O(functions × names) duplicate
 * index — important for the wasm32 self-compile ceiling.
 */

const dataOf = (ctx, handle) => handle && ctx.plans.typedStorageData.get(handle)

const nameCtor = (data, name) => {
  if (data.typedNames?.has(name)) return data.typedNames.get(name) ?? null
  const rep = data.localReps?.get(name)
  if (rep?.typedCtor) return rep.typedCtor
  return data.globalTyped?.get(name) ?? null
}

const arrayElemCtor = (data, name) => {
  const rep = data.localReps?.get(name)
  if (rep?.arrayElemTypedCtor) return rep.arrayElemTypedCtor
  const isLocal = data.locals?.has(name) || data.localReps?.has(name)
  return isLocal ? null : data.globalReps?.get(name)?.arrayElemTypedCtor ?? null
}

const planSources = data => ({
  name: name => nameCtor(data, name),
  call: callee => data.program.calls.get(callee) ?? null,
  field: (obj, prop) => typeof obj === 'string' && typeof prop === 'string'
    ? data.fieldKeys.get(obj + '\0' + prop) ?? null : null,
  index: obj => typeof obj === 'string' ? arrayElemCtor(data, obj) : null,
})

const ctorInfo = ctor => {
  const name = typedCtorName(ctor)
  if (!name) return null
  const aux = typedElemAux(ctor)
  if (aux == null) return null
  return Object.freeze({
    ctor,
    name,
    aux,
    isView: ctor.endsWith('.view'),
    isBigInt: name === 'BigInt64Array' || name === 'BigUint64Array',
    isF16: name === 'Float16Array',
    isClamped: name === 'Uint8ClampedArray',
    elem: aux & 7,
  })
}

const collectFieldKeys = (ctx, node, fieldKeys) => {
  if (!Array.isArray(node)) return
  // Nested closures have their own function/representation plan and scope.
  if (node[0] === '=>') return
  if ((node[0] === '.' || node[0] === '?.') && typeof node[1] === 'string' && typeof node[2] === 'string') {
    const key = node[1] + '\0' + node[2]
    const ctor = ctx.schema && ctx.schema.slotTypedCtorAt
      ? ctx.schema.slotTypedCtorAt(node[1], node[2]) ?? null : null
    if (!fieldKeys.has(key)) fieldKeys.set(key, ctor)
    else if (fieldKeys.get(key) !== ctor) fieldKeys.set(key, null)
  }
  for (let i = 1; i < node.length; i++) collectFieldKeys(ctx, node[i], fieldKeys)
}

const programFacts = ctx => {
  const program = ctx.plans.typedStorageProgram
  if (!program.initialized) {
    for (const func of ctx.funcs.list || []) {
      if (!func || !func.name) continue
      if (func.sig && func.sig.ptrKind === VAL.TYPED && func.sig.ptrAux != null)
        program.calls.set(func.name, ctorFromElemAux(func.sig.ptrAux))
    }
    program.hasTypedFields = ctx.schema?.hasTypedSlots === true
    program.initialized = true
  }
  return program
}

/** Publish after local/signature/schema facts settle and before body emission. */
export function mintTypedStoragePlan(ctx, identity, sig, body, localReps, options = {}) {
  const prior = ctx.plans.typedStorage.get(identity)
  if (prior && dataOf(ctx, prior))
    throw new Error(`TypedStoragePlan already published for ${identity?.name || '<anonymous>'}`)

  const program = programFacts(ctx)
  const fieldKeys = new Map()
  if (program.hasTypedFields) {
    collectFieldKeys(ctx, body, fieldKeys)
    for (const extra of options.extraBodies || []) collectFieldKeys(ctx, extra, fieldKeys)
  }
  if (identity?.name && sig?.ptrKind === VAL.TYPED && sig.ptrAux != null)
    program.calls.set(identity.name, ctorFromElemAux(sig.ptrAux))

  // Params whose ABI carries a concrete typed aux may not yet appear in the
  // body typed-name view (notably closure bodies). Record only those overrides.
  const paramCtors = new Map()
  for (const p of sig?.params || [])
    if (p && p.name != null && p.ptrKind === VAL.TYPED && p.ptrAux != null)
      paramCtors.set(p.name, ctorFromElemAux(p.ptrAux))

  const handle = Object.freeze({})
  const data = {
    kind: 'typed-storage', identity,
    typedNames: ctx.func.typedElem,
    localReps,
    locals: ctx.func.locals,
    globalTyped: ctx.scope.globalTypedElem,
    globalReps: ctx.scope.globalReps,
    paramCtors,
    fieldKeys,
    program,
  }
  // Parameter ABI overrides are the highest durable name tier.
  if (paramCtors.size) {
    const base = data.typedNames
    data.typedNames = {
      has: name => paramCtors.has(name) || base?.has(name),
      get: name => paramCtors.has(name) ? paramCtors.get(name) : base?.get(name),
    }
  }

  ctx.plans.typedStorageData.set(handle, data)
  ctx.plans.typedStorage.set(identity, handle)
  if (sig && typeof sig === 'object') {
    ctx.plans.typedStorage.set(sig, handle)
    if (sig.params) ctx.plans.typedStorage.set(sig.params, handle)
  }
  if (ctx.func.current && ctx.func.current !== sig) ctx.plans.typedStorage.set(ctx.func.current, handle)
  return handle
}

export function typedStoragePlanOf(ctx, identity = ctx.func.current) {
  const handle = identity && ctx.plans.typedStorage.get(identity)
  if (!dataOf(ctx, handle))
    throw new Error(`TypedStoragePlan missing for ${identity?.name || '<anonymous>'}`)
  return handle
}

const activeData = ctx => dataOf(ctx, typedStoragePlanOf(ctx))

const plannedCtor = (ctx, data, expr) => {
  // Explicit transient channel for compiler-generated hoist locals. This is
  // not analysis fallback: the emitter creating the local supplies its ctor.
  if (typeof expr === 'string' && ctx.func.localTypedElemsOverlay?.has(expr))
    return ctx.func.localTypedElemsOverlay.get(expr) ?? null
  const sources = planSources(data)
  // Method chains rooted at a transient temp need that overlay at the leaf.
  sources.name = name => ctx.func.localTypedElemsOverlay?.has(name)
    ? ctx.func.localTypedElemsOverlay.get(name) ?? null
    : nameCtor(data, name)
  return typedStorageCtor(expr, sources)
}

/** Constructor decision from the active frozen body plan. */
export function plannedTypedStorageCtor(ctx, expr) {
  return plannedCtor(ctx, activeData(ctx), expr)
}

export function plannedTypedStorageInfo(ctx, expr) {
  const data = activeData(ctx)
  const ctor = plannedCtor(ctx, data, expr)
  if (!ctor) return null
  const program = data.program
  let info = program.info.get(ctor)
  if (!info) { info = ctorInfo(ctor); if (info) program.info.set(ctor, info) }
  return info
}
