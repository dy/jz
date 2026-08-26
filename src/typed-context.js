import { ctorFromElemAux } from '../layout.js'
import { VAL } from './reps.js'
import {
  TYPED_SOURCE_NAME, TYPED_SOURCE_CALL, TYPED_SOURCE_FIELD, TYPED_SOURCE_INDEX,
  typedStorageCtor, typedStorageFact,
} from './typed-provenance.js'

/**
 * Analysis-time adapter for typedStorageCtor.
 *
 * The expression grammar stays in typed-provenance.js. This adapter only
 * supplies compiler fact channels in one documented priority order. Callers
 * that run inside a fixpoint can prepend explicit maps and disable ambient
 * names; emitters consume TypedStoragePlan instead.
 */
const EMPTY_OPTIONS = {}
const EMPTY_MAPS = []

export function typedStorageNameCtor(ctx, name, localNames) {
  if (ctx.func?.localTypedElemsOverlay?.has?.(name)) return ctx.func.localTypedElemsOverlay.get(name) ?? null
  if (ctx.func?.typedElem?.has?.(name)) return ctx.func.typedElem.get(name) ?? null
  const localRep = ctx.func?.localReps?.get?.(name)
  if (localRep?.typedCtor) return localRep.typedCtor
  const isLocal = localNames?.has?.(name) || ctx.func?.locals?.has?.(name) ||
    ctx.func?.current?.params?.some?.(p => p?.name === name)
  return !isLocal && !ctx.types?.dynWriteVars?.has?.(name)
    ? ctx.scope?.globalTypedElem?.get?.(name) ?? null : null
}

export function typedStorageFactFromName(ctx, expr, resolveName) {
  const resolve = (kind, a, b) => {
    if (kind === TYPED_SOURCE_NAME) return resolveName(a) ?? null
    if (kind === TYPED_SOURCE_CALL) {
      const f = typeof a === 'string' ? ctx.funcs?.map?.get?.(a) : null
      return f?.sig?.ptrKind === VAL.TYPED && f.sig.ptrAux != null
        ? ctorFromElemAux(f.sig.ptrAux) : null
    }
    if (kind === TYPED_SOURCE_FIELD && typeof a === 'string' && typeof b === 'string')
      return ctx.schema?.slotTypedCtorAt?.(a, b) ?? null
    if (kind === TYPED_SOURCE_INDEX && typeof a === 'string') {
      const local = ctx.func?.localReps?.get?.(a)
      if (local?.arrayElemTypedCtor) return local.arrayElemTypedCtor
      const isLocal = ctx.func?.locals?.has?.(a) || ctx.func?.current?.params?.some?.(p => p?.name === a)
      if (!isLocal) return ctx.scope?.globalReps?.get?.(a)?.arrayElemTypedCtor ?? null
    }
    return null
  }
  return typedStorageFact(expr, resolve)
}

export function typedStorageCtorFromMaps(ctx, expr, callerElems, paramFacts, fieldSids) {
  const resolve = (kind, a, b) => {
    if (kind === TYPED_SOURCE_NAME) {
      if (callerElems?.has(a)) return callerElems.get(a) ?? null
      if (paramFacts?.has(a)) return paramFacts.get(a) ?? null
      return null
    }
    if (kind === TYPED_SOURCE_CALL) {
      const f = typeof a === 'string' ? ctx.funcs?.map?.get?.(a) : null
      return f?.sig?.ptrKind === VAL.TYPED && f.sig.ptrAux != null
        ? ctorFromElemAux(f.sig.ptrAux) : null
    }
    if (kind === TYPED_SOURCE_FIELD && typeof a === 'string' && typeof b === 'string') {
      const sid = fieldSids?.get?.(a)
      if (sid != null && ctx.schema?.slotTypedCtorBySid)
        return ctx.schema.slotTypedCtorBySid(sid, b) ?? null
      return ctx.schema?.slotTypedCtorAt?.(a, b) ?? null
    }
    return null
  }
  return typedStorageCtor(expr, resolve)
}

export function typedStorageCtorFromContext(ctx, expr, options) {
  options ||= EMPTY_OPTIONS
  const maps = options.nameMaps || EMPTY_MAPS
  const ambientNames = options.ambientNames !== false

  // One source dispatcher, rather than four closures + a `{name,call,field,index}`
  // record per query. These queries are hot in self-hosted analysis and every
  // short-lived closure/record otherwise carries a HASH sidecar.
  const resolve = (kind, a, b) => {
    if (kind === TYPED_SOURCE_NAME) {
      if (options.resolveName) return options.resolveName(a) ?? null
      for (const map of maps) if (map?.has?.(a)) return map.get(a) ?? null
      if (!ambientNames) return null
      if (options.transientNames !== false && ctx.func?.localTypedElemsOverlay?.has?.(a))
        return ctx.func.localTypedElemsOverlay.get(a) ?? null
      if (ctx.func?.typedElem?.has?.(a)) return ctx.func.typedElem.get(a) ?? null
      const localRep = ctx.func?.localReps?.get?.(a)
      const isLocal = options.localNames?.has?.(a) || ctx.func?.locals?.has?.(a) ||
        ctx.func?.current?.params?.some?.(p => p?.name === a)
      const global = !isLocal && !ctx.types?.dynWriteVars?.has?.(a)
        ? ctx.scope?.globalTypedElem?.get?.(a) ?? null : null
      if (localRep?.typedCtor) return localRep.typedCtor
      return global
    }
    if (kind === TYPED_SOURCE_CALL) {
      if (options.calls === false || typeof a !== 'string') return null
      const f = ctx.funcs?.map?.get?.(a)
      return f?.sig?.ptrKind === VAL.TYPED && f.sig.ptrAux != null
        ? ctorFromElemAux(f.sig.ptrAux) : null
    }
    if (kind === TYPED_SOURCE_FIELD) {
      if (options.fields === false || typeof a !== 'string' || typeof b !== 'string') return null
      const sid = options.fieldSids?.get?.(a)
      if (sid != null && ctx.schema?.slotTypedCtorBySid)
        return ctx.schema.slotTypedCtorBySid(sid, b) ?? null
      return ctx.schema?.slotTypedCtorAt?.(a, b) ?? null
    }
    if (kind === TYPED_SOURCE_INDEX) {
      if (options.indices === false || typeof a !== 'string') return null
      for (const map of options.arrayElemMaps || EMPTY_MAPS)
        if (map?.has?.(a)) return map.get(a) ?? null
      if (!ambientNames) return null
      const local = ctx.func?.localReps?.get?.(a)
      if (local?.arrayElemTypedCtor) return local.arrayElemTypedCtor
      const isLocal = options.localNames?.has?.(a) || ctx.func?.locals?.has?.(a) ||
        ctx.func?.current?.params?.some?.(p => p?.name === a)
      if (!isLocal) return ctx.scope?.globalReps?.get?.(a)?.arrayElemTypedCtor ?? null
    }
    return null
  }

  return options.detailed
    ? typedStorageFact(expr, resolve)
    : typedStorageCtor(expr, resolve)
}
