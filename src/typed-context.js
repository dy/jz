import { ctorFromElemAux } from '../layout.js'
import { VAL } from './reps.js'
import { typedStorageCtor, typedStorageFact } from './typed-provenance.js'

/**
 * Analysis-time adapter for typedStorageCtor.
 *
 * The expression grammar stays in typed-provenance.js. This adapter only
 * supplies compiler fact channels in one documented priority order. Callers
 * that run inside a fixpoint can prepend explicit maps and disable ambient
 * names; emitters consume TypedStoragePlan instead.
 */
export function typedStorageCtorFromContext(ctx, expr, options = {}) {
  const maps = options.nameMaps || []
  const ambientNames = options.ambientNames !== false
  const name = n => {
    if (options.resolveName) return options.resolveName(n) ?? null
    for (const map of maps) if (map?.has?.(n)) return map.get(n) ?? null
    if (!ambientNames) return null
    if (options.transientNames !== false && ctx.func?.localTypedElemsOverlay?.has?.(n))
      return ctx.func.localTypedElemsOverlay.get(n) ?? null
    if (ctx.func?.typedElem?.has?.(n)) return ctx.func.typedElem.get(n) ?? null
    const localRep = ctx.func?.localReps?.get?.(n)
    const isLocal = options.localNames?.has?.(n) || ctx.func?.locals?.has?.(n) || ctx.func?.current?.params?.some?.(p => p?.name === n)
    const global = !isLocal && !ctx.types?.dynWriteVars?.has?.(n)
      ? ctx.scope?.globalTypedElem?.get?.(n) ?? null : null
    if (localRep?.typedCtor) return localRep.typedCtor
    return global
  }

  const call = options.calls === false ? null : callee => {
    if (typeof callee !== 'string') return null
    const f = ctx.funcs?.map?.get?.(callee)
    return f?.sig?.ptrKind === VAL.TYPED && f.sig.ptrAux != null
      ? ctorFromElemAux(f.sig.ptrAux) : null
  }

  const field = options.fields === false ? null : (obj, prop) => {
    if (typeof obj !== 'string' || typeof prop !== 'string') return null
    const sid = options.fieldSids?.get?.(obj)
    if (sid != null && ctx.schema?.slotTypedCtorBySid)
      return ctx.schema.slotTypedCtorBySid(sid, prop) ?? null
    return ctx.schema?.slotTypedCtorAt?.(obj, prop) ?? null
  }

  const index = options.indices === false ? null : obj => {
    if (typeof obj !== 'string') return null
    for (const map of options.arrayElemMaps || [])
      if (map?.has?.(obj)) return map.get(obj) ?? null
    if (!ambientNames) return null
    const local = ctx.func?.localReps?.get?.(obj)
    if (local?.arrayElemTypedCtor) return local.arrayElemTypedCtor
    const isLocal = options.localNames?.has?.(obj) || ctx.func?.locals?.has?.(obj) || ctx.func?.current?.params?.some?.(p => p?.name === obj)
    if (!isLocal) return ctx.scope?.globalReps?.get?.(obj)?.arrayElemTypedCtor ?? null
    return null
  }

  const sources = { name, call, field, index }
  return options.detailed
    ? typedStorageFact(expr, sources)
    : typedStorageCtor(expr, sources)
}
