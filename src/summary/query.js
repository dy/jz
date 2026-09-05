/** Read-only summary queries. This module has no access to solver transfers. */
import { ACCESSOR_GET, CLASS_T, isBrand } from '../ast.js'
import { encodeTypedElemAux, ctorFromElemAux, TYPED_ELEM_BIGINT_FLAG } from '../../layout.js'
import { builtinCalleeVal, methodValType } from '../kind-traits.js'
import { VAL } from '../reps.js'

import {
  K, kind, tagOf, paramOf, isNullable, hasTag, join, valOf, kindOfVal, core, UNKNOWN,
  ANY, NUMBER, STRING, BOOL, BIGINT, NULLISH, orAbsent, plus, arith,
  TYPED_CTOR, NUMBER_METHODS, ARRAY_METHODS, NUMBER_OPS, BOOL_OPS,
} from './kind.js'

export function summaryQueries(facts) {
  const { kinds, incoming, fields, results, closures, declared, parent, nameScopes,
    scopeOfSig, scopeOfParams, cellUp, elems, cellProps, cellWild, closureSets,
    schemas, methods, sidByKey, funcNames, imports, numeric, dynamicProps, builtinOwnProps } = facts
  const keyIn = (scope, name) => scope === '' ? name : scope + '\0' + name
  // The solver owns union-find compression; querying a root never writes it.
  const cell = id => { while (cellUp[id] !== id) id = cellUp[id]; return id }
  const celled = k => (tagOf(k) === K.ARRAY || tagOf(k) === K.MAP) && paramOf(k) !== UNKNOWN
  const canon = k => celled(k) ? (k & ~UNKNOWN) | cell(paramOf(k)) : k
  const elemOf = k => celled(k) ? elems[cell(paramOf(k))] : ANY
  const slots = sid => fields.get(sid) ?? schemas[sid].map(() => K.NONE)
  const membersOf = id => id >= (1 << 15) ? closureSets[id - (1 << 15)] : [id]
  const closureResult = id => {
    let result = K.NONE
    for (const member of membersOf(id)) result = join(result, canon(results.get(member) ?? K.NONE))
    return result
  }
  const propOf = (arr, prop) => { const c = cell(paramOf(arr)); return join(cellProps.get(c)?.get(prop) ?? K.NONE, cellWild.get(c) ?? K.NONE) }
  const anyPropOf = arr => { const c = cell(paramOf(arr)); let k = cellWild.get(c) ?? K.NONE; for (const pk of cellProps.get(c)?.values() ?? []) k = join(k, pk); return k }
  const entryOf = (arr, ik) => { const t = tagOf(ik); return paramOf(arr) === UNKNOWN ? ANY : t === K.NUMBER ? elemOf(arr) : t === K.STRING ? anyPropOf(arr) : t === K.NONE ? K.NONE : join(elemOf(arr), anyPropOf(arr)) }
  const classMember = (recv, name) => tagOf(recv) === K.OBJECT && paramOf(recv) !== UNKNOWN ? methods.get(paramOf(recv))?.get(name) ?? null : null
  const memberMayBeOwn = prop => dynamicProps.has(prop)
  const builtinReceiverMayHaveOwn = (t, prop) => (t === K.ARRAY || t === K.TYPED || t === K.MAP || t === K.SET || t === K.REGEX || t === K.CLOSURE) && ((builtinOwnProps.get(prop) ?? 0) & (kind(t) & ~UNKNOWN)) !== 0
  const typedElemKind = recv => paramOf(recv) === UNKNOWN ? join(NUMBER, BIGINT) : paramOf(recv) & TYPED_ELEM_BIGINT_FLAG ? BIGINT : NUMBER
  const builtinMethodResult = (recv, name) => {
    const v = valOf(core(recv))
    return v == null || v === VAL.OBJECT || v === VAL.HASH || v === VAL.CLOSURE ? ANY : kindOfVal(methodValType(name, null, v, null))
  }
  const optionalResult = (op, recv, result) => op !== '?.' || !hasTag(recv, K.NULLISH) && !hasTag(recv, K.ABSENT) ? result : tagOf(core(recv)) === K.NONE ? NULLISH : join(result, NULLISH)
  const literalKind = v => v == null ? NULLISH : typeof v === 'number' ? NUMBER : typeof v === 'string' ? STRING : typeof v === 'boolean' ? BOOL : typeof v === 'bigint' ? BIGINT : ANY
  const args = a => a == null ? [] : Array.isArray(a) && a[0] === ',' ? a.slice(1) : [a]
  const builtinResult = name => {
    const m = TYPED_CTOR.exec(name)
    if (m) { const aux = encodeTypedElemAux(m[1], !!m[2]); return kind(K.TYPED, aux == null ? UNKNOWN : aux) }
    if (name === 'new.RegExp') return kind(K.REGEX)
    if (name === 'new.ArrayBuffer' || name === 'new.SharedArrayBuffer') return kind(K.BUFFER)
    if (name === 'Array' || name === '__keys_ro') return kind(K.ARRAY)
    if (name === '__iter_arr') return K.NONE
    const v = builtinCalleeVal(name)
    if (v != null && (v !== VAL.TYPED || name === 'new.DataView')) return kindOfVal(v)
    if (name === 'String' || name.startsWith('String.')) return STRING
    if (name === 'Number' || name.startsWith('Math.') || name.startsWith('Number.')) return NUMBER
    return ANY
  }
  const views = new Map()
  const view = scope => {
    let cached = views.get(scope)
    if (cached) return cached
    const keyOf = name => {
      for (let s = scope; ; s = parent.get(s) ?? '') {
        if (declared.get(s)?.has(name)) return keyIn(s, name)
        if (s === '') return null
      }
    }
    // Unscoped analysis joins a binding's source and specialized variants.
    const keyOfAnywhere = name => { const key = keyOf(name); if (key !== null || scope !== '') return key; const ns = nameScopes.get(name); return ns ? ns.map(s => keyIn(s, name)) : null }
    const readKind = name => { const key = keyOfAnywhere(name); if (key === null) return K.NONE; if (typeof key === 'string') return canon(kinds.get(key) ?? K.NONE); let k = K.NONE; for (const kk of key) k = join(k, canon(kinds.get(kk) ?? K.NONE)); return k }
    const kindOfExpr = n => {
      if (typeof n === 'string') { const key = keyOfAnywhere(n); return key === null ? (funcNames.has(n) ? kind(K.CLOSURE) : ANY) : readKind(n) }
      if (typeof n === 'number') return NUMBER
      if (!Array.isArray(n)) return ANY
      const op = n[0]
      if (op == null) return literalKind(n[1])
      if (op === 'str' || op === 'strcat' || op === '`') return STRING
      if (op === 'bool') return BOOL
      if (op === 'bigint') return BIGINT
      if (op === '//') return kind(K.REGEX)
      if (op === '=>') { const id = closures.get(n); return id === undefined || id >= UNKNOWN ? kind(K.CLOSURE) : kind(K.CLOSURE, id) }
      if (op === '{}' && n.length > 1 && n.slice(1).every(p => typeof p === 'string' || Array.isArray(p) && (p[0] === ':' || p[0] === '...'))) {
        const names = []
        let brand = null
        const add = name => { if (!names.includes(name)) names.push(name) }
        for (let i = 1; i < n.length; i++) {
          const p = n[i]
          if (typeof p === 'string') add(p)
          else if (Array.isArray(p) && p[0] === ':' && typeof p[1] === 'string') { if (isBrand(p[1])) brand = p[1]; else add(p[1]) }
          else if (Array.isArray(p) && p[0] === '...') {
            const source = kindOfExpr(p[1]), sid = tagOf(source) === K.OBJECT ? paramOf(source) : UNKNOWN
            if (sid === UNKNOWN || !schemas[sid]) return kind(K.HASH)
            for (const name of schemas[sid]) add(name)
          } else return kind(K.HASH)
        }
        const sid = sidByKey.get(names.length + '\x01' + names.join('\x01') + (brand ? '\x02' + brand : ''))
        return sid !== undefined ? kind(K.OBJECT, sid) : names.length === 0 ? kind(K.OBJECT) : kind(K.HASH)
      }
      if (op === '()' && n.length === 2) return kindOfExpr(n[1])
      if (op === '.' || op === '?.') {
        const r = kindOfExpr(n[1]), t = tagOf(r), done = result => optionalResult(op, r, result)
        if (op === '?.' && tagOf(core(r)) === K.NONE) return NULLISH
        if (typeof n[2] !== 'string') return done(ANY)
        if (t === K.OBJECT && paramOf(r) !== UNKNOWN) {
          const i = schemas[paramOf(r)].indexOf(n[2])
          if (i >= 0) return done(slots(paramOf(r))[i])
          const getter = classMember(r, n[2] + ACCESSOR_GET), fn = getter ?? (classMember(r, n[2]) ? classMember(r, n[2]) + CLASS_T + 'bind' : null)
          return done(fn && !memberMayBeOwn(n[2]) ? results.get(fn) ?? ANY : fn || memberMayBeOwn(n[2]) ? ANY : NULLISH)
        }
        if (NUMBER_METHODS.has(n[2]) && (t === K.ARRAY || t === K.TYPED || t === K.STRING || t === K.MAP || t === K.SET || t === K.BUFFER)) return done(NUMBER)
        if (t === K.ARRAY && paramOf(r) !== UNKNOWN && !ARRAY_METHODS.has(n[2])) return done(orAbsent(propOf(r, n[2])))
        return done(n[2] === 'buffer' && t === K.TYPED ? kind(K.BUFFER) : ANY)
      }
      if (op === '[]') {
        const r = kindOfExpr(n[1]), t = tagOf(r)
        if (Array.isArray(n[2]) && n[2][0] == null && typeof n[2][1] === 'string') return kindOfExpr(['.', n[1], n[2][1]])
        if (t === K.OBJECT && paramOf(r) !== UNKNOWN) { let k = K.NONE; for (const s of slots(paramOf(r))) k = join(k, s); return orAbsent(k) }
        return t === K.TYPED ? orAbsent(typedElemKind(r)) : t === K.ARRAY ? orAbsent(entryOf(r, kindOfExpr(n[2]))) : t === K.STRING ? STRING : ANY
      }
      if (op === '()' && typeof n[1] === 'string') {
        if (TYPED_CTOR.test(n[1])) return builtinResult(n[1])
        const key = keyOf(n[1])
        if (key === null && funcNames.has(n[1])) return results.get(n[1]) ?? ANY
        const k = key === null ? undefined : kinds.get(key)
        if (k !== undefined) {
          if (tagOf(k) !== K.CLOSURE || paramOf(k) === UNKNOWN) return ANY
          let r = K.NONE
          for (const id of membersOf(paramOf(k))) r = join(r, results.get(id) ?? ANY)
          return r
        }
        return imports.has(n[1]) ? kindOfVal(imports.get(n[1])) : builtinResult(n[1])
      }
      if (op === '()' && Array.isArray(n[1]) && (n[1][0] === '.' || n[1][0] === '?.') && typeof n[1][2] === 'string') {
        const r = kindOfExpr(n[1][1]), name = n[1][2], t = tagOf(r), fn = classMember(r, name)
        let result
        if (fn) result = !memberMayBeOwn(name) ? results.get(fn) ?? ANY : ANY
        else if (builtinReceiverMayHaveOwn(t, name)) result = ANY
        else if (t === K.OBJECT && paramOf(r) !== UNKNOWN) {
          const i = schemas[paramOf(r)].indexOf(name), fk = i < 0 ? K.NONE : slots(paramOf(r))[i]
          result = tagOf(fk) === K.CLOSURE && paramOf(fk) !== UNKNOWN ? closureResult(paramOf(fk)) : tagOf(fk) === K.NONE ? K.NONE : ANY
        }
        else if (t === K.MAP && name === 'get') result = orAbsent(elemOf(r))
        else if (t === K.TYPED && name === 'at') result = orAbsent(typedElemKind(r))
        else if (t === K.TYPED && name === 'reduce') {
          // The fixpoint has already solved callback recurrence. A query may
          // combine results, but must not bind even a hypothetical argument.
          const as = args(n[2]).map(kindOfExpr), cb = as[0]
          result = tagOf(cb) !== K.CLOSURE || paramOf(cb) === UNKNOWN ? ANY
            : join(as.length > 1 ? as[1] : typedElemKind(r), closureResult(paramOf(cb)))
        }
        else if (t === K.STRING && name === 'at') result = orAbsent(STRING)
        else if (t === K.STRING && name === 'codePointAt') result = orAbsent(NUMBER)
        else result = builtinMethodResult(r, name)
        return optionalResult(n[1][0], r, result)
      }
      if (op === '?' || op === '?:') return join(kindOfExpr(n[2]), kindOfExpr(n[3]))
      if (op === '&&' || op === '||' || op === '??') return join(kindOfExpr(n[1]), kindOfExpr(n[2]))
      if (op === ',') return kindOfExpr(n[n.length - 1])
      if (op === '+') return plus(kindOfExpr(n[1]), kindOfExpr(n[2]))
      if (NUMBER_OPS.has(op) || op === 'u-') { const ks = []; for (let i = 1; i < n.length; i++) ks.push(kindOfExpr(n[i])); return arith(op, ks) }
      if (op === '+1' || op === '-1') return arith(op, [kindOfExpr(n[1])])
      if (op === 'u+') return NUMBER
      if (BOOL_OPS.has(op)) return BOOL
      if (op === 'typeof') return STRING
      return ANY
    }
    cached = {
      kindOf: readKind, kindOfExpr,
      sidOf: name => { const k = readKind(name); return tagOf(k) === K.OBJECT && !isNullable(k) && paramOf(k) !== UNKNOWN ? paramOf(k) : null },
      // Payload queries preserve identity independently of nullish presence.
      objectSidOfExpr: e => { const k = kindOfExpr(e); return tagOf(core(k)) === K.OBJECT && paramOf(k) !== UNKNOWN ? paramOf(k) : null },
      typedCtorOf: name => { const k = readKind(name); return tagOf(k) === K.TYPED && paramOf(k) !== UNKNOWN && !isNullable(k) ? ctorFromElemAux(paramOf(k)) : null },
      arrayElemSidOf: name => { const k = readKind(name); if (tagOf(k) !== K.ARRAY || paramOf(k) === UNKNOWN) return null; const e = elemOf(k); return tagOf(e) === K.OBJECT && !isNullable(e) && paramOf(e) !== UNKNOWN ? paramOf(e) : null },
      numericDemand: name => { const key = keyOfAnywhere(name), isNumeric = k => numeric.get(k) === 2; return key !== null && (typeof key === 'string' ? isNumeric(key) : key.every(isNumeric)) },
      // Incoming arguments/defaults before any reassignment in the body.
      paramKindOf: name => { const key = keyOf(name); return key === null ? K.NONE : canon(incoming.get(key) ?? K.NONE) },
      elemKindOf: elemOf,
      valOf: name => valOf(readKind(name)),
      // valOf deliberately declines nullable kinds; payload queries do not.
      valOfExpr: e => valOf(kindOfExpr(e)),
      mayBeNullishExpr: e => isNullable(kindOfExpr(e)),
      typedCtorOfExpr: e => { const k = kindOfExpr(e); return tagOf(k) === K.TYPED && paramOf(k) !== UNKNOWN && !isNullable(k) ? ctorFromElemAux(paramOf(k)) : null },
      typedPayloadCtorOfExpr: e => { const k = kindOfExpr(e); return tagOf(core(k)) === K.TYPED && paramOf(k) !== UNKNOWN ? ctorFromElemAux(paramOf(k)) : null },
    }
    views.set(scope, cached)
    return cached
  }
  return {
    ...view(''),
    // Named function/signature, closure id/parameter identity, or module.
    at: x => view(typeof x === 'string' || typeof x === 'number' ? x : scopeOfSig.get(x) ?? scopeOfParams.get(x) ?? (x?.scope != null ? scopeOfParams.get(x.scope) : undefined) ?? ''),
    fieldKind: (sid, prop) => { const i = schemas[sid]?.indexOf(prop); return i == null || i < 0 ? K.NONE : fields.get(sid)?.[i] ?? K.NONE },
    fieldVal: (sid, prop) => { const i = schemas[sid]?.indexOf(prop); return i == null || i < 0 ? null : valOf(fields.get(sid)?.[i] ?? K.NONE) },
    fieldTypedCtor: (sid, prop) => { const i = schemas[sid]?.indexOf(prop), k = i == null || i < 0 ? K.NONE : fields.get(sid)?.[i] ?? K.NONE; return tagOf(k) === K.TYPED && paramOf(k) !== UNKNOWN && !isNullable(k) ? ctorFromElemAux(paramOf(k)) : null },
    resultOf: name => results.get(name) ?? K.NONE,
    resultVal: name => valOf(results.get(name) ?? K.NONE),
    memberMayBeOwn,
    memberMayBeOwnOn: (prop, valueKind) => builtinReceiverMayHaveOwn(tagOf(kindOfVal(valueKind)), prop),
    builtinMemberMayBeOwn: prop => builtinOwnProps.has(prop),
    hasTypedFields: [...fields.values()].some(a => a.some(k => tagOf(k) === K.TYPED && paramOf(k) !== UNKNOWN && !isNullable(k))),
    escaped: facts.escaped,
  }
}
