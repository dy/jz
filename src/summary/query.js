/** Read-only summary queries. This module has no access to solver transfers. */
import { ACCESSOR_GET, CLASS_T, isBrand, schemaKey, isArrayIndexKey } from '../ast.js'
import { encodeTypedElemAux, ctorFromElemAux, TYPED_ELEM_BIGINT_FLAG } from '../../layout.js'
import { builtinCalleeVal, methodValType } from '../kind-traits.js'
import { VAL } from '../reps.js'
import { NONE_CONTRACT, readContract } from './contract.js'

import {
  K, kind, tagOf, paramOf, isNullable, hasTag, join, valOf, kindOfVal, core, UNKNOWN,
  ANY, NUMBER, STRING, BOOL, BIGINT, NULLISH, orAbsent, plus, arith, typedStore, isPostfixRecovery, logicalMask, selectKind,
  TYPED_CTOR, isCount, ARRAY_METHODS, NUMBER_OPS, BOOL_OPS, bitOf, TAGS, NULL_BITS } from './kind.js'

export function summaryQueries(facts, internal = false) {
  const { kinds, incoming, fields, results, closures, closuresByBody, declared, parent, nameKeys,
    scopeOfSig, scopeOfBody, scopeOfParams, cellUp, elems, tuples, cellProps, cellWild, closureSets, closureSetIds, cells, jsonKinds, unions, shapeUnions,
    schemas, layouts, sitesByLayout, objectKinds, methods, sidByKey, funcNames, imports, numeric, dynamicProps, builtinOwnProps, typedReadPresent, openSchemas,
    sideProps, sideWild, wildProps, wildValues, pendingAll, keyedCells, cellShapes, cellLostObject } = facts
  // The solver owns union-find compression; querying a root never writes it.
  const cell = id => { while (cellUp[id] !== id) id = cellUp[id]; return id }
  const MIXABLE_TAGS = bitOf(K.HASH) | bitOf(K.OBJECT) | bitOf(K.NUMBER) | bitOf(K.STRING) | bitOf(K.BOOL) | bitOf(K.BIGINT)
  const dictOrObject = k => paramOf(k) !== UNKNOWN && hasTag(k, K.HASH) && tagOf(k) === K.ANY && (k & TAGS & ~NULL_BITS & ~MIXABLE_TAGS) === 0
  const celled = k => (tagOf(k) === K.ARRAY || tagOf(k) === K.MAP || tagOf(k) === K.HASH || tagOf(k) === K.SET || dictOrObject(k)) && paramOf(k) !== UNKNOWN
  const canon = k => celled(k) ? (k & ~UNKNOWN) | cell(paramOf(k)) : k
  const elemOf = k => celled(k) ? elems[cell(paramOf(k))] : ANY
  const NO_SLOTS = []
  const slots = sid => fields[sid] ?? NO_SLOTS   // a schema never stored to has every slot at NONE
  const slotKind = (sid, i) => fields[sid]?.[i] ?? K.NONE
  const SET_BASE = 1 << 15
  const membersOf = id => id >= SET_BASE ? closureSets[id - SET_BASE] : [id]
  // A shape set (index.js unionShapes) shares the closure sets' records.
  const shapesOf = membersOf
  /** The one shape of an object kind, or UNKNOWN for a set or an unknown shape. */
  const sidOf = k => tagOf(k) === K.OBJECT && paramOf(k) < SET_BASE ? paramOf(k) : UNKNOWN
  /** Project construction identities to a layout; sets retain a layout only when all agree. */
  const layoutOf = k => {
    if (tagOf(k) !== K.OBJECT || paramOf(k) === UNKNOWN) return UNKNOWN
    if (paramOf(k) < SET_BASE) return layouts[paramOf(k)]
    let layout = UNKNOWN
    for (const sid of shapesOf(paramOf(k))) {
      if (layout !== UNKNOWN && layout !== layouts[sid]) return UNKNOWN
      layout = layouts[sid]
    }
    return layout
  }
  const pub = k => internal ? k : tagOf(k) === K.OBJECT ? (k & ~UNKNOWN) | layoutOf(k) : k
  const publicSid = k => internal ? sidOf(k) : layoutOf(k)
  // Two closures (or two shapes) joined are the set the solver interned for
  // the pair (index.js unionClosures/unionShapes): a query joins the same pair
  // through that record, never minting one. A pair the solver never joined is unknown.
  const merge = (a, b) => {
    a = canon(a); b = canon(b)
    if ((tagOf(a) === K.CLOSURE || tagOf(a) === K.OBJECT) && tagOf(a) === tagOf(b) && paramOf(a) !== UNKNOWN && paramOf(b) !== UNKNOWN && paramOf(a) !== paramOf(b)) {
      const id = (tagOf(a) === K.CLOSURE ? unions : shapeUnions).get(paramOf(a) * 65536 + paramOf(b))
      if (id !== undefined && id !== UNKNOWN) { a = (a & ~UNKNOWN) | id; b = (b & ~UNKNOWN) | id }
    }
    return join(a, b)
  }
  const closureResult = id => {
    let result = K.NONE
    for (const member of membersOf(id)) result = join(result, canon(results.get(member) ?? K.NONE))
    return result
  }
  const propOf = (arr, prop) => { const c = cell(paramOf(arr)); return join(isArrayIndexKey(prop) ? elemOf(arr) : cellProps.get(c)?.get(prop) ?? K.NONE, cellWild.get(c) ?? K.NONE) }
  const anyPropOf = arr => { const c = cell(paramOf(arr)); let k = join(elemOf(arr), cellWild.get(c) ?? K.NONE); for (const pk of cellProps.get(c)?.values() ?? []) k = join(k, pk); return k }
  // A keyed dictionary's entry by name: the solver's hashPropOf.
  const hashPropOf = (h, prop) => { const c = cell(paramOf(h)); if (!keyedCells.has(c)) return elemOf(h); return join(cellProps.get(c)?.get(prop) ?? K.NONE, cellWild.get(c) ?? K.NONE) }
  const entryOf = (arr, ik) => { const t = tagOf(ik); return paramOf(arr) === UNKNOWN ? ANY : t === K.NUMBER ? elemOf(arr) : t === K.STRING ? anyPropOf(arr) : t === K.NONE ? K.NONE : join(elemOf(arr), anyPropOf(arr)) }
  const classMember = (recv, name) => { const sid = layoutOf(recv); return sid !== UNKNOWN ? methods.get(sid)?.get(name) ?? null : null }
  // A property's accessor and binder names, built once per property.
  const getterNames = new Map(), binderNames = new Map()
  const named = (m, name, suffix) => { let s = m.get(name); if (s === undefined) m.set(name, s = name + suffix); return s }
  const getterOf = prop => named(getterNames, prop, ACCESSOR_GET), binderOf = fn => named(binderNames, fn, CLASS_T + 'bind')
  const memberMayBeOwn = prop => dynamicProps.has(prop)
  const lostSchema = sid => facts.opaqueSchemas.has(sid) || facts.hostSchemas.has(sid)
  // Names stored beside a shape's slots: the solver's sideOf/anySideOf.
  const sideOf = (sid, prop) => merge(sideProps.get(sid)?.get(prop) ?? K.NONE, sideWild.get(sid) ?? K.NONE)
  const anySideOf = sid => { let k = sideWild.get(sid) ?? K.NONE; for (const pk of sideProps.get(sid)?.values() ?? []) k = merge(k, pk); return k }
  const builtinReceiverMayHaveOwn = (t, prop) => (t === K.ARRAY || t === K.TYPED || t === K.MAP || t === K.SET || t === K.REGEX || t === K.CLOSURE) && ((builtinOwnProps.get(prop) ?? 0) & (kind(t) & ~UNKNOWN)) !== 0
  const typedElemKind = recv => paramOf(recv) === UNKNOWN ? join(NUMBER, BIGINT) : paramOf(recv) & TYPED_ELEM_BIGINT_FLAG ? BIGINT : NUMBER
  const builtinMethodResult = (recv, name) => {
    const v = valOf(core(recv))
    return v == null || v === VAL.OBJECT || v === VAL.HASH || v === VAL.CLOSURE ? ANY : kindOfVal(methodValType(name, null, v, null))
  }
  const ARRAY_CALLBACK_RESULT = new Map([
    ['map', (r, id) => id === undefined ? kind(K.ARRAY) : canon(kind(K.ARRAY, id))],
    ['flatMap', (r, id) => id === undefined ? kind(K.ARRAY) : canon(kind(K.ARRAY, id))],
    ['filter', r => r], ['find', r => orAbsent(elemOf(r))], ['findLast', r => orAbsent(elemOf(r))],
    ['findIndex', () => NUMBER], ['findLastIndex', () => NUMBER], ['forEach', () => NULLISH],
    ['some', () => BOOL], ['every', () => BOOL],
  ])
  const optionalResult = (op, recv, result) => op !== '?.' || !hasTag(recv, K.NULLISH) && !hasTag(recv, K.ABSENT) ? result : tagOf(core(recv)) === K.NONE ? NULLISH : join(result, NULLISH)
  const literalKind = v => v == null ? NULLISH : typeof v === 'number' ? NUMBER : typeof v === 'string' ? STRING : typeof v === 'boolean' ? BOOL : typeof v === 'bigint' ? BIGINT : ANY
  const args = a => a == null ? [] : Array.isArray(a) && a[0] === ',' ? a.slice(1) : [a]
  const builtinResult = name => {
    if (name.startsWith('new.')) {
      const m = TYPED_CTOR.exec(name)
      if (m) { const aux = encodeTypedElemAux(m[1], !!m[2]); return kind(K.TYPED, aux == null ? UNKNOWN : aux) }
      if (name === 'new.RegExp') return kind(K.REGEX)
      if (name === 'new.ArrayBuffer' || name === 'new.SharedArrayBuffer') return kind(K.BUFFER)
    }
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
    // A name's key in this scope, resolved once: the demand pass and the
    // emitters ask at every read.
    const keys = new Map()   // name → key, or null for a name from outside the program
    const keyOf = name => {
      let key = keys.get(name)
      if (key !== undefined) return key
      key = null
      for (let s = scope; ; s = parent.get(s) ?? '') {
        const found = declared.get(s)?.get(name)
        if (found !== undefined) { key = found; break }
        if (s === '') break
      }
      keys.set(name, key)
      return key
    }
    // Unscoped analysis joins a binding's source and specialized variants.
    const keyOfAnywhere = name => {
      const key = keyOf(name)
      if (key !== null || scope !== '') return key
      return nameKeys.get(name) ?? null
    }
    const readKey = key => { if (key === null) return K.NONE; if (typeof key === 'number') return canon(kinds[key] ?? K.NONE); let k = K.NONE; for (const kk of key) k = join(k, canon(kinds[kk] ?? K.NONE)); return k }
    const readKind = name => readKey(keyOfAnywhere(name))
    const kindOfExpr = n => selectedExpr(n, 7)
    const selectedExpr = (n, mask) => {
      const logical = Array.isArray(n) ? logicalMask(n[0]) : 0
      if (mask !== 7 && !logical) return selectKind(kindOfExpr(n), mask)
      if (typeof n === 'string') { const key = keyOfAnywhere(n); return key === null ? (funcNames.has(n) ? kind(K.CLOSURE, closureSetIds.get(n) ?? UNKNOWN) : ANY) : readKey(key) }
      if (typeof n === 'number') return NUMBER
      if (!Array.isArray(n)) return ANY
      const op = n[0]
      if (op == null) return literalKind(n[1])
      if (op === 'str' || op === 'strcat' || op === '`') return STRING
      if (op === 'bool') return BOOL
      if (op === 'bigint') return BIGINT
      if (op === '//') return kind(K.REGEX)
      if (op === '{}' && n.length === 2 && n[1]?.[0] === '...') {
        const source = kindOfExpr(n[1][1]), t = tagOf(source)
        if (t === K.NONE) return K.NONE
        if (!isNullable(source) && (t === K.OBJECT || t === K.HASH)) return source
      }
      // A construction site owns its cell (the solver's cellOf): an array literal, a `new Map`, an
      // array constructor, `JSON.parse`, and the array methods that build a fresh array.
      if (op === '[' || (op === '()' || op === '{}') && cells.has(n)) { const c = cells.get(n), t = op === '{}' ? K.HASH : n[1] === 'new.Map' ? K.MAP : n[1] === 'new.Set' ? K.SET : K.ARRAY; return c === undefined || c >= UNKNOWN ? kind(t) : canon(kind(t, c)) }
      if (op === '{}' && objectKinds.has(n)) return objectKinds.get(n)
      if (op === '()' && n[1] === 'JSON.parse' && jsonKinds.has(n)) return canon(jsonKinds.get(n))
      if (op === '=>') { const id = closures.get(n) ?? closuresByBody.get(n[2]); return id === undefined || id >= UNKNOWN ? kind(K.CLOSURE) : kind(K.CLOSURE, id) }
      if (op === '{}' && n.length > 1 && n.slice(1).every(p => typeof p === 'string' || Array.isArray(p) && (p[0] === ':' || p[0] === '...'))) {
        const names = []
        let brand = null
        const add = name => { if (!names.includes(name)) names.push(name) }
        for (let i = 1; i < n.length; i++) {
          const p = n[i]
          if (typeof p === 'string') add(p)
          else if (Array.isArray(p) && p[0] === ':' && typeof p[1] === 'string') { if (isBrand(p[1])) brand = p[1]; else add(p[1]) }
          else if (Array.isArray(p) && p[0] === '...') {
            const source = kindOfExpr(p[1]), sid = layoutOf(source)
            if (p[1]?.[0] === '&&' || isNullable(source) || sid === UNKNOWN || shapesOf(paramOf(source)).some(site => openSchemas.has(site)) || !schemas[sid]) return kind(K.HASH)
            for (const name of schemas[sid]) add(name)
          } else return kind(K.HASH)
        }
        const sid = sidByKey.get(schemaKey(names, brand))
        if (sid === undefined) return names.length === 0 ? kind(K.OBJECT) : kind(K.HASH)
        let k = K.NONE
        for (const site of sitesByLayout.get(sid) ?? []) k = merge(k, kind(K.OBJECT, site))
        return k === K.NONE ? kind(K.OBJECT) : k
      }
      if (op === '()' && n.length === 2) return kindOfExpr(n[1])
      if (op === '.' || op === '?.') {
        const r = kindOfExpr(n[1])
        if (op === '?.' && tagOf(core(r)) === K.NONE) return NULLISH
        if (typeof n[2] !== 'string') return optionalResult(op, r, ANY)
        return optionalResult(op, r, memberOf(r, n[2]))
      }
      if (op === '[]') {
        const r = kindOfExpr(n[1]), t = tagOf(r)
        if (Array.isArray(n[2]) && n[2][0] == null && typeof n[2][1] === 'string') return kindOfExpr(['.', n[1], n[2][1]])
        // `o[1]` on an object is the property "1"
        if (t === K.OBJECT && (typeof n[2] === 'number' || Array.isArray(n[2]) && n[2][0] == null && typeof n[2][1] === 'number'))
          return kindOfExpr(['.', n[1], String(typeof n[2] === 'number' ? n[2] : n[2][1])])
        if (t === K.ARRAY && paramOf(r) !== UNKNOWN) {
          const row = tuples.get(cell(paramOf(r))), idx = n[2]
          const i = typeof idx === 'number' ? idx : Array.isArray(idx) && idx[0] == null ? idx[1] : null
          if (row && Number.isInteger(i) && i >= 0) return row[i] ?? kind(K.ABSENT)
        }
        if (t === K.OBJECT && paramOf(r) !== UNKNOWN) { let k = K.NONE; for (const sid of shapesOf(paramOf(r))) { for (const s of slots(sid)) k = merge(k, s); k = merge(k, anySideOf(sid)) } return orAbsent(k) }
        return t === K.TYPED ? typedReadPresent(scope, n) ? typedElemKind(r) : orAbsent(typedElemKind(r)) : t === K.HASH ? orAbsent(elemOf(r)) : t === K.ARRAY ? orAbsent(entryOf(r, kindOfExpr(n[2]))) : t === K.STRING ? STRING : ANY
      }
      if (op === '()' && typeof n[1] === 'string') {
        if (n[1].startsWith('new.') && TYPED_CTOR.test(n[1])) return builtinResult(n[1])
        const key = keyOf(n[1])
        if (key === null && funcNames.has(n[1])) return results.get(n[1]) ?? ANY
        const k = key === null ? undefined : kinds[key]
        if (k !== undefined) {
          if (tagOf(k) !== K.CLOSURE || paramOf(k) === UNKNOWN) return ANY
          let r = K.NONE
          for (const id of membersOf(paramOf(k))) r = join(r, results.get(id) ?? ANY)
          return r
        }
        if (n[1] === 'Object.assign') { const t = kindOfExpr(args(n[2])[0]); if ((tagOf(t) === K.ARRAY || tagOf(t) === K.HASH) && paramOf(t) !== UNKNOWN) return t }   // the solver's rule: the array target
        return imports.has(n[1]) ? kindOfVal(imports.get(n[1])) : builtinResult(n[1])
      }
      if (op === '()' && Array.isArray(n[1]) && (n[1][0] === '.' || n[1][0] === '?.') && typeof n[1][2] === 'string') {
        const r = kindOfExpr(n[1][1])
        return optionalResult(n[1][0], r, methodResult(r, n[1][2], n))
      }
      // A call through any other callee expression (`TABLE[k](…)`, a call's
      // result called): the join of the closure set's results (the solver's call).
      if (op === '()' && n.length === 3) {
        const ck = kindOfExpr(n[1])
        return tagOf(ck) === K.NONE ? K.NONE : tagOf(ck) === K.CLOSURE && paramOf(ck) !== UNKNOWN ? closureResult(paramOf(ck)) : ANY
      }
      // An assignment's value is its right side, less what a typed element's conversion rejects (the solver's assign).
      if (op === '=') {
        const v = kindOfExpr(n[2]), t = n[1]
        if (!Array.isArray(t) || t[0] !== '[]' || Array.isArray(t[2]) && t[2][0] == null && typeof t[2][1] === 'string') return v
        const r = kindOfExpr(t[1])
        return tagOf(r) === K.TYPED ? typedStore(typedElemKind(r), v) : v
      }
      if (op === '?' || op === '?:') return merge(kindOfExpr(n[2]), kindOfExpr(n[3]))
      if (logical) return merge(selectedExpr(n[1], mask & logical), selectedExpr(n[2], mask))
      if (op === ',') return kindOfExpr(n[n.length - 1])
      if (isPostfixRecovery(op, n[1], n[2])) return kindOfExpr(n[1])
      if (op === '+') return plus(kindOfExpr(n[1]), kindOfExpr(n[2]))
      if (NUMBER_OPS.has(op) || op === 'u-') { let k = n.length > 2 ? kindOfExpr(n[1]) : arith(op, kindOfExpr(n[1])); for (let i = 2; i < n.length; i++) k = arith(op, k, kindOfExpr(n[i])); return k }
      if (op === '+1' || op === '-1') return arith(op, kindOfExpr(n[1]))
      if (op === 'u+') return NUMBER
      if (BOOL_OPS.has(op)) return BOOL
      if (op === 'typeof') return STRING
      return ANY
    }
    /** A field read through a receiver of kind `r`: the solver's `member`. */
    const memberOf = (r, prop) => {
      const t = tagOf(r)
      if (t === K.NONE) return K.NONE
      if (t === K.OBJECT && paramOf(r) !== UNKNOWN) {
        if (paramOf(r) >= SET_BASE) { let k = K.NONE; for (const sid of shapesOf(paramOf(r))) k = merge(k, memberOf(kind(K.OBJECT, sid), prop)); return k }
        const i = schemas[paramOf(r)].indexOf(prop)
        if (i >= 0) return slotKind(paramOf(r), i)
        const getter = classMember(r, getterOf(prop)), fn = getter ?? (classMember(r, prop) ? binderOf(classMember(r, prop)) : null)
        if (fn) return memberMayBeOwn(prop) ? ANY : results.get(fn) ?? ANY
        if (!lostSchema(paramOf(r))) return merge(NULLISH, sideOf(paramOf(r), prop))
        return memberMayBeOwn(prop) ? ANY : NULLISH
      }
      if (t === K.HASH) return orAbsent(hashPropOf(r, prop))
      if (dictOrObject(r)) {
        const c = cell(paramOf(r))
        if (cellLostObject.has(c)) return ANY
        let k = orAbsent(hashPropOf(r, prop))
        for (const sid of cellShapes.get(c) ?? []) k = merge(k, memberOf(kind(K.OBJECT, sid), prop))
        for (const tag of [K.NUMBER, K.STRING, K.BOOL, K.BIGINT]) if (hasTag(r, tag)) k = merge(k, ANY)
        return k
      }
      if (isCount(prop, r)) return NUMBER
      if (t === K.ARRAY && paramOf(r) !== UNKNOWN && !ARRAY_METHODS.has(prop)) return orAbsent(propOf(r, prop))
      return prop === 'buffer' && t === K.TYPED ? kind(K.BUFFER) : ANY
    }
    /** A method call's result on a receiver of kind `r`: the solver's `method`. */
    const methodResult = (r, name, n) => {
      const t = tagOf(r)
      if (t === K.NONE) return K.NONE
      if (t === K.OBJECT && paramOf(r) !== UNKNOWN && paramOf(r) >= SET_BASE) { let k = K.NONE; for (const sid of shapesOf(paramOf(r))) k = merge(k, methodResult(kind(K.OBJECT, sid), name, n)); return k }
      const fn = classMember(r, name)
      let result
      {
        if (fn) result = !memberMayBeOwn(name) ? results.get(fn) ?? ANY : ANY
        else if (builtinReceiverMayHaveOwn(t, name)) result = ANY
        else if (t === K.OBJECT && paramOf(r) !== UNKNOWN) {
          const i = schemas[paramOf(r)].indexOf(name), fk = i < 0 ? K.NONE : slotKind(paramOf(r), i)
          result = tagOf(fk) === K.CLOSURE && paramOf(fk) !== UNKNOWN ? closureResult(paramOf(fk)) : tagOf(fk) === K.NONE ? K.NONE : ANY
        }
        else if (t === K.MAP && name === 'get') result = orAbsent(elemOf(r))
        else if (t === K.TYPED && name === 'at') result = orAbsent(typedElemKind(r))
        else if ((t === K.TYPED || t === K.ARRAY) && (name === 'reduce' || name === 'reduceRight')) {
          // The fixpoint has already solved callback recurrence. A query may
          // combine results, but must not bind even a hypothetical argument.
          const as = args(n[2]).map(kindOfExpr), cb = as[0]
          result = tagOf(cb) !== K.CLOSURE || paramOf(cb) === UNKNOWN ? ANY
            : join(as.length > 1 ? as[1] : t === K.TYPED ? typedElemKind(r) : elemOf(r), closureResult(paramOf(cb)))
        }
        // The solver bound the callback and, for `map`/`flatMap`, filled the call's own cell.
        else if (t === K.ARRAY && paramOf(r) !== UNKNOWN && ARRAY_CALLBACK_RESULT.has(name)) result = ARRAY_CALLBACK_RESULT.get(name)(r, cells.get(n))
        else if (t === K.STRING && name === 'at') result = orAbsent(STRING)
        else if (t === K.STRING && name === 'codePointAt') result = orAbsent(NUMBER)
        else result = builtinMethodResult(r, name)
      }
      return result
    }
    /** The callable a call reaches: a function name, a closure or closure-set
     *  id, or null for a builtin, an import, an own-member shadow or a callee
     *  the summary cannot name. The same resolution `kindOfExpr` reads a call by. */
    const calleeOf = n => {
      if (!Array.isArray(n) || n[0] !== '()' || n.length !== 3) return null
      const callee = n[1]
      let ck
      if (typeof callee === 'string') {
        const key = keyOf(callee)
        if (key === null) return funcNames.has(callee) ? callee : null
        ck = kinds[key] ?? K.NONE
      } else if (Array.isArray(callee) && (callee[0] === '.' || callee[0] === '?.') && typeof callee[2] === 'string') {
        const r = kindOfExpr(callee[1]), name = callee[2], fn = classMember(r, name)
        if (fn) return memberMayBeOwn(name) ? null : fn
        if (builtinReceiverMayHaveOwn(tagOf(r), name) || tagOf(r) !== K.OBJECT || paramOf(r) === UNKNOWN) return null
        ck = K.NONE
        for (const sid of shapesOf(paramOf(r))) { const i = schemas[sid].indexOf(name); ck = merge(ck, i < 0 ? K.NONE : slotKind(sid, i)) }
      } else ck = kindOfExpr(callee)
      return tagOf(ck) === K.CLOSURE && paramOf(ck) !== UNKNOWN ? paramOf(ck) : null
    }
    cached = {
      kindOf: name => pub(readKind(name)), kindOfExpr: e => pub(kindOfExpr(e)), calleeOf, keyOfName: keyOf,
      // The result contract of the callable a call reaches, or null (contract.js).
      calleeContract: n => { const c = calleeOf(n); return c === null ? null : resultContract(c) },
      sidOf: name => { const k = readKind(name); return tagOf(k) === K.OBJECT && !isNullable(k) && publicSid(k) !== UNKNOWN ? publicSid(k) : null },
      spreadSidOfExpr: e => { const k = kindOfExpr(e), sid = publicSid(k); return tagOf(k) === K.OBJECT && !isNullable(k) && sid !== UNKNOWN && !shapesOf(paramOf(k)).some(site => openSchemas.has(site)) ? sid : null },
      // The member shapes of an object expression, a set's or the one shape, for a
      // guarded slot access; null when the shape is unknown or not an object.
      shapesOfExpr: e => { const k = kindOfExpr(e); return tagOf(core(k)) === K.OBJECT && paramOf(k) !== UNKNOWN ? [...new Set(shapesOf(paramOf(k)).map(sid => layouts[sid]))] : null },
      // Payload queries preserve identity independently of nullish presence.
      objectSidOfExpr: e => { const k = kindOfExpr(e); return tagOf(core(k)) === K.OBJECT && publicSid(k) !== UNKNOWN ? publicSid(k) : null },
      typedCtorOf: name => { const k = readKind(name); return tagOf(k) === K.TYPED && paramOf(k) !== UNKNOWN && !isNullable(k) ? ctorFromElemAux(paramOf(k)) : null },
      // The element cell's own kind: presence included, no absent member for a read past the end.
      elemKindOf: name => { const k = readKind(name); return celled(k) ? pub(elemOf(k)) : null },
      arrayElemSidOf: name => { const k = readKind(name); if (tagOf(k) !== K.ARRAY || paramOf(k) === UNKNOWN) return null; const e = elemOf(k); return tagOf(e) === K.OBJECT && !isNullable(e) && publicSid(e) !== UNKNOWN ? publicSid(e) : null },
      numericDemand: name => { const key = keyOfAnywhere(name), isNumeric = k => numeric.get(k) === 2; return key !== null && (typeof key === 'number' ? isNumeric(key) : key.every(isNumeric)) },
      numericStorage: name => { const key = keyOf(name), k = readKind(name); return key !== null && numeric.get(key) === 2 && tagOf(core(k)) === K.NUMBER && hasTag(k, K.ABSENT) && !hasTag(k, K.NULLISH) },
      // The demand pass denied the binding a number: a read of it neither converts nor is compatible (a container store, a return), so its value keeps JS semantics for every kind the host may pass.
      numericDenied: name => { const key = keyOfAnywhere(name), denied = k => numeric.get(k) === false; return key !== null && (typeof key === 'number' ? denied(key) : key.some(denied)) },
      // Incoming arguments/defaults before any reassignment in the body.
      paramKindOf: name => { const key = keyOf(name); return key === null ? K.NONE : pub(canon(incoming[key] ?? K.NONE)) },
      elemOfKind: k => pub(elemOf(k)),
      valOf: name => valOf(readKind(name)),
      // One non-nullish class receiver, with no possible own-member shadow.
      classCallee: (recv, name) => { const r = kindOfExpr(recv); if (tagOf(r) !== K.OBJECT || paramOf(r) === UNKNOWN || isNullable(r)) return null; const fn = classMember(r, name); return fn && !memberMayBeOwn(name) ? fn : null },
      // valOf deliberately declines nullable kinds; payload queries do not.
      valOfExpr: e => valOf(kindOfExpr(e)),
      mayBeNullishExpr: e => { const k = kindOfExpr(e); return hasTag(k, K.NULLISH) || hasTag(k, K.ABSENT) },
      typedCtorOfExpr: e => { const k = kindOfExpr(e); return tagOf(k) === K.TYPED && paramOf(k) !== UNKNOWN && !isNullable(k) ? ctorFromElemAux(paramOf(k)) : null },
      typedPayloadCtorOfExpr: e => { const k = kindOfExpr(e); return tagOf(core(k)) === K.TYPED && paramOf(k) !== UNKNOWN ? ctorFromElemAux(paramOf(k)) : null },
    }
    views.set(scope, cached)
    return cached
  }
  // A callable identity: a function name or signature, a closure id or its
  // parameter node (its stable identity through emission), a frame carrying
  // the parameter node as `scope`; null for none.
  const identityOf = x => typeof x === 'string' || typeof x === 'number' ? x
    : x == null ? null : scopeOfParams.get(x) ?? scopeOfSig.get(x) ?? (x.scope != null ? scopeOfParams.get(x.scope) : undefined) ?? null
  // The frozen result contract of a callable (contract.js); an unknown one never completes.
  const resultContract = x => { const f = facts.contracts?.get(identityOf(x)); return f ? readContract(f) : NONE_CONTRACT }
  // Storage is shared by layout. Project once at publication, not at every
  // emitter lookup; analysis reads continue to use each construction's slots.
  const storage = internal ? fields : []
  if (!internal) for (let sid = 0; sid < fields.length; sid++) {
    const values = fields[sid]
    if (!values) continue
    const layout = layouts[sid]
    const row = storage[layout] ??= new Array(values.length).fill(K.NONE)
    for (let i = 0; i < values.length; i++) row[i] = join(row[i], pub(values[i]))
  }
  const fieldKind = (sid, prop) => storage[sid]?.[schemas[sid]?.indexOf(prop)] ?? K.NONE
  let deletableLayouts = null
  const hostLayouts = new Set([...facts.hostSchemas].map(sid => layouts[sid]))
  const opaqueLayouts = new Set([...facts.opaqueSchemas].map(sid => layouts[sid]))
  // Joined receivers can reach generic reads, so their BigInt slots stay tagged.
  for (const id of shapeUnions.values()) if (id !== UNKNOWN)
    for (const sid of shapesOf(id)) opaqueLayouts.add(layouts[sid])
  // A value stored beside a shape's slots is read generically too.
  const sideShapes = k => { if (tagOf(k) === K.OBJECT && paramOf(k) !== UNKNOWN) for (const sid of shapesOf(paramOf(k))) opaqueLayouts.add(layouts[sid]) }
  for (const m of sideProps.values()) for (const k of m.values()) sideShapes(k)
  for (const k of sideWild.values()) sideShapes(k)
  for (const s of cellShapes.values()) for (const sid of s) opaqueLayouts.add(layouts[sid])
  return {
    ...view(''),
    // Named function/signature, closure id/parameter identity, a function's or
    // closure's block body, or module. A one-parameter arrow's parameter
    // identity is its name (`v => …`): the closure's scope, not a function's.
    at: x => view(scopeOfParams.has(x) ? scopeOfParams.get(x) : typeof x === 'string' || typeof x === 'number' ? x
      : scopeOfSig.get(x) ?? scopeOfBody.get(x) ?? closuresByBody.get(x) ?? (x?.scope != null ? scopeOfParams.get(x.scope) : undefined) ?? ''),
    resultContract,
    valOfKind: valOf,
    fieldKind,
    hostSchema: sid => hostLayouts.has(sid),
    opaqueSchema: sid => opaqueLayouts.has(sid),
    // A layout a `delete` can reach: a deleted receiver's, or any lost layout
    // once a delete went through a receiver of unknown shape.
    deletableSchema: sid => { deletableLayouts ??= new Set([...facts.deletable ?? []].map(s => layouts[s])); return deletableLayouts.has(sid) || (facts.deleteReach?.unknown === true && (opaqueLayouts.has(sid) || hostLayouts.has(sid))) },
    fieldVal: (sid, prop) => valOf(fieldKind(sid, prop)),
    fieldTypedCtor: (sid, prop) => { const k = fieldKind(sid, prop); return tagOf(k) === K.TYPED && paramOf(k) !== UNKNOWN && !isNullable(k) ? ctorFromElemAux(paramOf(k)) : null },
    fieldSid: (sid, prop) => { const k = fieldKind(sid, prop); return tagOf(k) === K.OBJECT && paramOf(k) !== UNKNOWN && !isNullable(k) ? paramOf(k) : null },
    resultOf: name => pub(results.get(name) ?? K.NONE),
    resultVal: name => valOf(results.get(name) ?? K.NONE),
    memberMayBeOwn,
    memberMayBeOwnOn: (prop, valueKind) => builtinReceiverMayHaveOwn(tagOf(kindOfVal(valueKind)), prop),
    builtinMemberMayBeOwn: prop => builtinOwnProps.has(prop),
    hasTypedFields: fields.some(a => a?.some(k => tagOf(k) === K.TYPED && paramOf(k) !== UNKNOWN && !isNullable(k))),
    escaped: facts.escaped,
  }
}
