/** Read-only summary queries. This module has no access to solver transfers. */
import { ACCESSOR_GET, ACCESSOR_SET, CLASS_T, isBrand, schemaKey, isArrayIndexKey, spreadExclusions } from '../ast.js'
import { encodeTypedElemAux, ctorFromElemAux, TYPED_ELEM_VIEW_FLAG, TYPED_ELEM_ANY_VIEW_FLAG } from '../../layout.js'
import { ATOMICS_VALUE_OPS, builtinCalleeVal, methodValType } from '../kind-traits.js'
import { VAL } from '../reps.js'
import { typedElementKey } from '../typed-provenance.js'
import { NONE_CONTRACT, readContract } from './contract.js'
import { ITER_RECORD_KEYS } from '../std/iter-helpers.js'

import {
  K, kind, tagOf, paramOf, isNullable, hasTag, join, valOf, valBesidePresence, kindOfVal, core, UNKNOWN,
  ANY, NUMBER, STRING, BOOL, BIGINT, NULLISH, orAbsent, plus, arith, typedStore, typedAux, typedElemKind, typedMethodKind, logicalMask, selectKind,
  TYPED_CTOR, isCount, ARRAY_METHODS, OBJECT_PROTO_METHODS, objectProtoResult, NUMBER_OPS, BOOL_OPS, bitOf, TAGS, NULL_BITS, outsideKind } from './kind.js'
// Names every object has from its prototype: a read of one is never undefined.
const INHERITED = new Set(['constructor', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toString', 'toLocaleString', 'valueOf',
  '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', '__proto__', 'length'])

export function summaryQueries(facts, internal = false) {
  const { kinds, incoming, fields, results, receivers, closures, closuresByBody, declared, parent, nameKeys, forwards, siteResults,
    scopeOfSig, scopeOfBody, scopeOfParams, cellUp, elems, tuples, lens, stores, built, grown, unknown, presentReads, spreadSources, paramRangesOf, cellProps, cellWild, cellNumeric, hostArrays, retainedArrays, closureSets, closureSetIds, cells, jsonKinds, unions, shapeUnions,
    schemas, layouts, sitesByLayout, foldedLayouts, objectKinds, methods, sidByKey, funcNames, imports, numeric, strung, dynamicProps, builtinOwnProps, typedReadPresent, typedProps, typedPropsByAux, openSchemas, indexedSchemas,
    sideProps, sideWild, wildProps, wildValues, pendingAll, keyedCells, cellShapes, cellLostObject, closureProps, escaped, iterSites, reached, defaultRuns, boolKeys, storeBits, paramKeys } = facts
  // The solver owns union-find compression; querying a root never writes it.
  const cell = id => { while (cellUp[id] !== id) id = cellUp[id]; return id }
  const MIXABLE_TAGS = bitOf(K.HASH) | bitOf(K.OBJECT) | bitOf(K.NUMBER) | bitOf(K.STRING) | bitOf(K.BOOL) | bitOf(K.BIGINT)
  const dictOrObject = k => paramOf(k) !== UNKNOWN && hasTag(k, K.HASH) && tagOf(k) === K.ANY && (k & TAGS & ~NULL_BITS & ~MIXABLE_TAGS) === 0
  const FUNCTION_PROTO = new Set(['call', 'apply', 'bind', 'toString', 'length', 'name', 'prototype', 'constructor'])
  const celled = k => (tagOf(k) === K.ARRAY || tagOf(k) === K.MAP || tagOf(k) === K.HASH || tagOf(k) === K.SET || dictOrObject(k)) && paramOf(k) !== UNKNOWN
  const canon = k => celled(k) ? (k & ~UNKNOWN) | cell(paramOf(k)) : k
  const elemOf = k => celled(k) ? elems[cell(paramOf(k))] : ANY
  // The length of the array a value holds, where no array it can be changes
  // length (index.js `lens`): the literals' count, every stored index under it.
  const fixedLen = k => {
    if (tagOf(core(k)) !== K.ARRAY || paramOf(k) === UNKNOWN) return null
    const c = cell(paramOf(k)), n = lens.get(c)
    return n >= 0 && !(stores.get(c) >= n) ? n : null
  }
  const NO_SLOTS = []
  const slots = sid => fields[sid] ?? NO_SLOTS   // a schema never stored to has every slot at NONE
  const slotKind = (sid, i) => fields[sid]?.[i] ?? K.NONE
  const SET_BASE = 1 << 15
  const singles = []   // the same immutable one-member lists used throughout this query view
  const membersOf = id => id >= SET_BASE ? closureSets[id - SET_BASE] : singles[id] ?? (singles[id] = [id])
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
  const pub = k => internal ? k : tagOf(k) === K.OBJECT ? (k & ~UNKNOWN) | layoutOf(k) : tagOf(k) === K.TYPED ? (k & ~UNKNOWN) | typedAux(k) : k
  // An iterator record the solver minted (index.js iterSite): its site, or its layout once folded.
  const iterRecord = sid => iterSites?.has(sid) || iterSites?.has(layouts[sid])
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
  // A callable's result away from a call site: a forwarded argument's result is unknown here.
  const resultOfId = (id) => join(results.get(id) ?? K.NONE, forwards.get(id)?.size ? ANY : K.NONE)
  const closureResult = id => {
    let result = K.NONE
    for (const member of membersOf(id)) result = merge(result, canon(resultOfId(member)))
    return result
  }
  const propOf = (arr, prop) => { const c = cell(paramOf(arr)); return merge(merge(isArrayIndexKey(prop) ? elemOf(arr) : cellProps.get(c)?.get(prop) ?? K.NONE, String(+prop) === prop ? cellNumeric.get(c) ?? K.NONE : K.NONE), cellWild.get(c) ?? K.NONE) }
  const numericPropsOf = arr => { const c = cell(paramOf(arr)); if (hostArrays.has(c) && retainedArrays.has(c)) return ANY; let k = merge(cellNumeric.get(c) ?? K.NONE, cellWild.get(c) ?? K.NONE); for (const [name, pk] of cellProps.get(c) ?? []) if (String(+name) === name) k = merge(k, pk); return k }
  const anyPropOf = arr => { const c = cell(paramOf(arr)); let k = merge(merge(elemOf(arr), cellNumeric.get(c) ?? K.NONE), cellWild.get(c) ?? K.NONE); for (const pk of cellProps.get(c)?.values() ?? []) k = merge(k, pk); return k }
  // A keyed dictionary's entry by name: the solver's hashPropOf.
  const hashPropOf = (h, prop) => { const c = cell(paramOf(h)); if (!keyedCells.has(c)) return elemOf(h); return join(cellProps.get(c)?.get(prop) ?? K.NONE, cellWild.get(c) ?? K.NONE) }
  // Solver bottom means an index has no evidence, not that an emitted read is
  // absent. Unlike the solver's pending transfer, a query must retain entries.
  const entryOf = (arr, ik) => {
    if (paramOf(arr) === UNKNOWN) return ANY
    if (ik === NUMBER) return merge(elemOf(arr), numericPropsOf(arr))
    return merge(anyPropOf(arr), merge(NUMBER, kind(K.CLOSURE)))
  }
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
  // The named properties a typed receiver may carry: its element type's cell
  // and the cell of receivers of unknown type; an unknown type joins every cell.
  const typedPropsOf = recv => {
    let out = elems[typedProps]
    if (typedAux(recv) === UNKNOWN) { for (const c of typedPropsByAux.values()) out = join(out, elems[c]) }
    else { const c = typedPropsByAux.get(typedAux(recv) & ~(TYPED_ELEM_VIEW_FLAG | TYPED_ELEM_ANY_VIEW_FLAG)); if (c !== undefined) out = join(out, elems[c]) }
    return out
  }
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
    if (name === 'Array' || name === '__keys_ro' || name === '__keys_dyn') return kind(K.ARRAY)
    if (name === '__iter_arr') return K.NONE
    const v = builtinCalleeVal(name)
    if (v != null && (v !== VAL.TYPED || name === 'new.DataView')) return kindOfVal(v)
    if (name === 'String' || name.startsWith('String.')) return STRING
    if (name === 'Number' || name.startsWith('Math.') || name.startsWith('Number.')) return NUMBER
    return ANY
  }
  // The union of every named kind: the unknown kind names nothing.
  const ALL_TAGS = TAGS & ~NULL_BITS
  let kindUnion = 0
  for (const k of kinds) if (k != null && (k & ALL_TAGS) !== ALL_TAGS) kindUnion |= k
  const views = new Map()
  const view = scope => {
    let cached = views.get(scope)
    if (!cached) { cached = createView(scope); views.set(scope, cached) }
    return cached
  }
  // A cache hit needs no closure environment. Keep the closures in a separate
  // factory so repeated queries do not allocate its captured locals at entry.
  const createView = scope => {
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
    // An emission temp standing for the present value of an expression (an
    // optional chain's guarded head): its kind is the expression's, without
    // the nullishness the guard excluded.
    const aliases = new Map()   // an emission temp → { e, present }: the expression it holds, present or as it is
    // Names a guard proved present on the path being emitted (flow-types.js
    // withRefinements): their kind reads without its nullish part.
    const present = new Set()
    const aliasKind = a => a.present ? core(kindOfExpr(a.e)) : kindOfExpr(a.e)
    const readKind = name => aliases.has(name) ? aliasKind(aliases.get(name)) : present.has(name) ? core(readKey(keyOfAnywhere(name))) : readKey(keyOfAnywhere(name))
    const kindOfExpr = n => selectedExpr(n, 7)
    const spreadSourceKind = (e, site) => canon(spreadSources.get(site) ?? kindOfExpr(e))
    // Only an unseen object literal needs a captured name builder. Keeping it
    // here avoids a closure environment on every ordinary expression query.
    const literalKindOf = n => {
      const names = []
      let brand = null
      const add = name => { if (!names.includes(name)) names.push(name) }
      for (let i = 1; i < n.length; i++) {
        const p = n[i]
        if (typeof p === 'string') add(p)
        else if (Array.isArray(p) && p[0] === ':' && typeof p[1] === 'string') { if (isBrand(p[1])) brand = p[1]; else add(p[1]) }
        else if (Array.isArray(p) && p[0] === '...') {
          const source = spreadSourceKind(p[1], p), sid = layoutOf(source), skip = spreadExclusions(p)
          if (p[1]?.[0] === '&&' || isNullable(source) || sid === UNKNOWN || shapesOf(paramOf(source)).some(site => openSchemas.has(site)) || !schemas[sid] || skip?.exprs.length) return kind(K.HASH)
          for (const name of schemas[sid]) if (!skip?.names.includes(name)) add(name)
        } else return kind(K.HASH)
      }
      const sid = sidByKey.get(schemaKey(names, brand))
      if (sid === undefined) return names.length === 0 ? kind(K.OBJECT) : kind(K.HASH)
      let k = K.NONE
      for (const site of sitesByLayout.get(sid) ?? []) k = merge(k, kind(K.OBJECT, site))
      return k === K.NONE ? kind(K.OBJECT) : k
    }
    const selectedExpr = (n, mask) => {
      const logical = Array.isArray(n) ? logicalMask(n[0]) : 0
      if (mask !== 7 && !logical) return selectKind(kindOfExpr(n), mask)
      if (typeof n === 'string') {
        if (aliases.has(n)) return aliasKind(aliases.get(n))
        const key = keyOfAnywhere(n)
        if (key === null) return funcNames.has(n) ? kind(K.CLOSURE, closureSetIds.get(n) ?? UNKNOWN) : outsideKind(n)
        const k = present.has(n) ? core(readKey(key)) : readKey(key)
        // a top-level `let f = (…) => …` is the function `f` (the walker's rule)
        return funcNames.has(n) && (tagOf(k) === K.NONE || (tagOf(k) === K.CLOSURE && paramOf(k) === UNKNOWN)) ? kind(K.CLOSURE, closureSetIds.get(n) ?? UNKNOWN) : k
      }
      if (typeof n === 'number') return NUMBER
      if (!Array.isArray(n)) return ANY
      const op = n[0]
      if (op == null) return literalKind(n[1])
      if (op === 'str' || op === 'strcat' || op === '`') return STRING
      if (op === 'this') return escaped.has(scope) ? ANY : receivers.get(scope) ?? K.NONE
      if (op === 'bool') return BOOL
      if (op === 'bigint') return BIGINT
      if (op === '//') return kind(K.REGEX)
      if (op === '{}' && n.length === 2 && n[1]?.[0] === '...' && !spreadExclusions(n[1])) {
        const source = spreadSourceKind(n[1][1], n[1]), t = tagOf(source)
        if (t === K.NONE) return K.NONE
        if (!isNullable(source) && (t === K.OBJECT || t === K.HASH)) return source
      }
      // A construction site owns its cell (the solver's cellOf): an array literal, a `new Map`, an
      // array constructor, `JSON.parse`, and the array methods that build a fresh array.
      if (op === '[' || (op === '()' || op === '{}') && cells.has(n)) { const c = cells.get(n), t = op === '{}' ? K.HASH : n[1] === 'new.Map' ? K.MAP : n[1] === 'new.Set' ? K.SET : K.ARRAY; return c === undefined || c >= UNKNOWN ? kind(t) : canon(kind(t, c)) }
      if (op === '{}' && objectKinds.has(n)) return objectKinds.get(n)
      if (op === '()' && n[1] === 'JSON.parse' && jsonKinds.has(n)) return canon(jsonKinds.get(n))
      if (op === '=>') { const id = closures.get(n) ?? closuresByBody.get(n[2]); return id === undefined || id >= UNKNOWN ? kind(K.CLOSURE) : kind(K.CLOSURE, id) }
      if (op === '{}' && n.length > 1 && n.slice(1).every(p => typeof p === 'string' || Array.isArray(p) && (p[0] === ':' || p[0] === '...'))) return literalKindOf(n)
      if (op === '(' || op === '()' && n.length === 2) return kindOfExpr(n[1])
      if (op === '.' || op === '?.') {
        const r = kindOfExpr(n[1])
        if (op === '?.' && tagOf(core(r)) === K.NONE) return NULLISH
        if (typeof n[2] !== 'string') return optionalResult(op, r, ANY)
        return optionalResult(op, r, memberOf(r, n[2]))
      }
      if (op === '[]') {
        const r = kindOfExpr(n[1]), t = tagOf(r)
        if (Array.isArray(n[2]) && (n[2][0] == null || n[2][0] === 'str') && typeof n[2][1] === 'string') return kindOfExpr(['.', n[1], n[2][1]])
        // `o[1]` on an object is the property "1"
        if (t === K.OBJECT && (typeof n[2] === 'number' || Array.isArray(n[2]) && n[2][0] == null && typeof n[2][1] === 'number'))
          return kindOfExpr(['.', n[1], String(typeof n[2] === 'number' ? n[2] : n[2][1])])
        if (t === K.ARRAY && paramOf(r) !== UNKNOWN) {
          const row = tuples.get(cell(paramOf(r))), idx = n[2]
          const i = typeof idx === 'number' ? idx : Array.isArray(idx) && idx[0] == null ? idx[1] : null
          if (row && Number.isInteger(i) && i >= 0) return row[i] ?? kind(K.ABSENT)
          // An index the fixed length holds reads an element, never past the end:
          // a literal under it, or a read the solver's walk found inside it.
          if ((Number.isInteger(i) && i >= 0 && i < fixedLen(r)) || presentReads.has(n)) return elemOf(r)
        }
        if (t === K.OBJECT && paramOf(r) !== UNKNOWN) { let k = K.NONE; for (const sid of shapesOf(paramOf(r))) { for (const s of slots(sid)) k = merge(k, s); k = merge(k, anySideOf(sid)) } return orAbsent(k) }
        if (t === K.TYPED) return !typedElementKey(n[2], kindOfExpr(n[2]) === NUMBER) ? core(kindOfExpr(n[2])) === NUMBER ? orAbsent(merge(typedElemKind(r), typedPropsOf(r))) : ANY
          : typedReadPresent(scope, n) || presentReads.has(n) ? typedElemKind(r) : orAbsent(typedElemKind(r))
        return t === K.HASH ? orAbsent(elemOf(r)) : t === K.ARRAY ? orAbsent(entryOf(r, kindOfExpr(n[2]))) : t === K.STRING ? orAbsent(STRING) : ANY
      }
      if (op === '()' && typeof n[1] === 'string') {
        if (n[1].startsWith('new.') && TYPED_CTOR.test(n[1])) return builtinResult(n[1])
        const key = keyOf(n[1])
        if (key === null && funcNames.has(n[1])) return siteResults.get(n) ?? (results.has(n[1]) ? resultOfId(n[1]) : ANY)
        const k = key === null ? undefined : kinds[key]
        if (k !== undefined) {
          if (tagOf(k) !== K.CLOSURE || paramOf(k) === UNKNOWN) return ANY
          const at = siteResults.get(n)
          if (at !== undefined) return at
          let r = K.NONE
          for (const id of membersOf(paramOf(k))) r = merge(r, results.has(id) ? resultOfId(id) : ANY)
          return r
        }
        if (n[1] === 'Object.assign') { const t = kindOfExpr(args(n[2])[0]); if ((tagOf(t) === K.ARRAY || tagOf(t) === K.HASH || tagOf(t) === K.OBJECT) && paramOf(t) !== UNKNOWN) return t }   // the solver's rule: the target
        if (ATOMICS_VALUE_OPS.has(n[1])) {
          const recv = kindOfExpr(args(n[2])[0])
          return tagOf(recv) === K.NONE ? K.NONE : tagOf(recv) === K.TYPED ? typedElemKind(recv) : join(NUMBER, BIGINT)
        }
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
        return tagOf(r) === K.TYPED && typedElementKey(t[2], kindOfExpr(t[2]) === NUMBER) ? typedStore(typedElemKind(r), v) : v
      }
      if (op === '?' || op === '?:') return merge(kindOfExpr(n[2]), kindOfExpr(n[3]))
      if (logical) return merge(selectedExpr(n[1], mask & logical), selectedExpr(n[2], mask))
      if (op === ',') return kindOfExpr(n[n.length - 1])
      if (op === 'postfix') return kindOfExpr(n[1])
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
        if (iterRecord(paramOf(r))) return ITER_RECORD_KEYS.includes(prop) ? kind(K.CLOSURE) : NULLISH
        const i = schemas[paramOf(r)].indexOf(prop)
        if (i >= 0) return slotKind(paramOf(r), i)
        const gi = schemas[paramOf(r)].indexOf(getterOf(prop))
        if (gi >= 0) {
          if (facts.deletable?.has(paramOf(r))) return ANY
          const g = slotKind(paramOf(r), gi)
          return tagOf(g) === K.CLOSURE && paramOf(g) !== UNKNOWN ? closureResult(paramOf(g)) : tagOf(g) === K.NONE ? K.NONE : ANY
        }
        const getter = classMember(r, getterOf(prop)), fn = getter ?? (classMember(r, prop) ? binderOf(classMember(r, prop)) : null)
        if (fn) return memberMayBeOwn(prop) ? ANY : results.has(fn) ? resultOfId(fn) : ANY
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
      // A closure's own property (the solver's closureProps): the join over the
      // set's members, undefined where none stored it; an escaped member or a
      // Function.prototype name reads as anything.
      if (t === K.CLOSURE && paramOf(r) !== UNKNOWN && !FUNCTION_PROTO.has(prop) && !membersOf(paramOf(r)).some(id => escaped.has(id))) {
        let k = K.NONE
        for (const id of membersOf(paramOf(r))) k = merge(k, closureProps.get(id)?.get(prop) ?? K.NONE)
        return orAbsent(k)
      }
      return prop === 'buffer' && t === K.TYPED ? kind(K.BUFFER) : ANY
    }
    /** A method call's result on a receiver of kind `r`: the solver's `method`. */
    const methodResult = (r, name, n) => {
      const t = tagOf(r)
      if (t === K.NONE) return K.NONE
      if ((t === K.HASH || dictOrObject(r) || (t === K.OBJECT && paramOf(r) === UNKNOWN)) && OBJECT_PROTO_METHODS.has(name) && !memberMayBeOwn(name))
        return objectProtoResult(r, name)
      if (t === K.OBJECT && paramOf(r) !== UNKNOWN && paramOf(r) >= SET_BASE) { let k = K.NONE; for (const sid of shapesOf(paramOf(r))) k = merge(k, methodResult(kind(K.OBJECT, sid), name, n)); return k }
      if (t === K.OBJECT && paramOf(r) !== UNKNOWN && iterRecord(paramOf(r))) return siteResults.get(n) ?? ANY
      const fn = classMember(r, name)
      let result
      {
        if (fn) result = !memberMayBeOwn(name) ? results.has(fn) ? resultOfId(fn) : ANY : ANY
        else if (builtinReceiverMayHaveOwn(t, name)) result = ANY
        else if (t === K.OBJECT && paramOf(r) !== UNKNOWN) {
          const i = schemas[paramOf(r)].indexOf(name), getter = schemas[paramOf(r)].includes(getterOf(name))
          const fk = i >= 0 ? slotKind(paramOf(r), i) : getter ? memberOf(r, name) : K.NONE
          result = i < 0 && !getter && !memberMayBeOwn(name) && OBJECT_PROTO_METHODS.has(name)
            ? objectProtoResult(r, name)
            : tagOf(fk) === K.CLOSURE && paramOf(fk) !== UNKNOWN ? closureResult(paramOf(fk)) : tagOf(fk) === K.NONE ? K.NONE : ANY
          if (facts.deletable?.has(paramOf(r)) && OBJECT_PROTO_METHODS.has(name)) result = merge(result, objectProtoResult(r, name))
        }
        else if (t === K.MAP && name === 'get') result = orAbsent(elemOf(r))
        else if (t === K.TYPED && typedMethodKind(name, r) !== null) result = typedMethodKind(name, r)
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
    // Solver readers keep construction identities and use only these queries.
    // Public emission helpers close over this scope too; create them only for
    // published readers, after the solver has settled the facts.
    if (internal) return { kindOfExpr, calleeOf, keyOfName: keyOf }
    return {
      kindOf: name => pub(readKind(name)), kindOfExpr: e => pub(kindOfExpr(e)), calleeOf, keyOfName: keyOf,
      // An emission temp holding the value of `e` (see `aliases`), present
      // (an optional chain's head past its guard) or as `e` reads (a
      // callback's element parameter), for the span of its continuation: temp
      // names recur across the closure bodies this scope covers, so an alias
      // never outlives its use.
      alias: (name, e, present = true) => { aliases.set(name, { e, present }) },
      unalias: (name) => { aliases.delete(name) },
      /** The name is present on the path being emitted (a guard proved it): its reads drop the nullish part. */
      present: (name) => { present.add(name) },
      unpresent: (name) => { present.delete(name) },
      isPresent: (name) => present.has(name),
      // The result contract of the callable a call reaches, or null (contract.js).
      calleeContract: n => { const c = calleeOf(n); return c === null ? null : resultContract(c) },
      sidOf: name => { const k = readKind(name); return tagOf(k) === K.OBJECT && !isNullable(k) && publicSid(k) !== UNKNOWN ? publicSid(k) : null },
      // The one layout an object expression's value has when it is not missing; null when unknown or open.
      targetSidOfExpr: e => { const k = core(kindOfExpr(e)), sid = publicSid(k); return tagOf(k) === K.OBJECT && sid !== UNKNOWN && !shapesOf(paramOf(k)).some(site => openSchemas.has(site)) ? sid : null },
      spreadValOfExpr: (e, site) => valOf(spreadSourceKind(e, site)),
      spreadSidOfExpr: (e, site) => { const k = spreadSourceKind(e, site), sid = publicSid(k); return tagOf(k) === K.OBJECT && !isNullable(k) && sid !== UNKNOWN && !shapesOf(paramOf(k)).some(site => openSchemas.has(site)) ? sid : null },
      // The member shapes of an object expression, a set's or the one shape, for a
      // guarded slot access; null when the shape is unknown or not an object.
      /** A function or closure a walk reached: the program runs it; the rest keep no kind. */
      reaches: id => reached?.has(id) === true,
      shapesOfExpr: e => { const k = kindOfExpr(e); return tagOf(core(k)) === K.OBJECT && paramOf(k) !== UNKNOWN ? [...new Set(shapesOf(paramOf(k)).map(sid => layouts[sid]))] : null },
      // Construction identities stay private to the summary. Distinct layouts
      // are not needed: two literals with the same fields can be disjoint.
      objectsDisjoint: (a, b) => {
        const ak = core(kindOfExpr(a)), bk = core(kindOfExpr(b))
        if (tagOf(ak) !== K.OBJECT || tagOf(bk) !== K.OBJECT || paramOf(ak) === UNKNOWN || paramOf(bk) === UNKNOWN) return false
        const as = shapesOf(paramOf(ak)), bs = shapesOf(paramOf(bk))
        if (as.some(lostSchema) || bs.some(lostSchema)) return false
        return as.every(x => bs.every(y => x !== y &&
          (layouts[x] !== layouts[y] || !foldedLayouts.has(layouts[x]))))
      },
      // The construction sites an object expression's value comes from; null when unknown. Two values of disjoint sites are two objects.
      sitesOfExpr: e => { const k = kindOfExpr(e); return tagOf(core(k)) === K.OBJECT && paramOf(k) !== UNKNOWN ? shapesOf(paramOf(k)) : null },
      // Payload queries preserve identity independently of nullish presence.
      objectSidOfExpr: e => { const k = kindOfExpr(e); return tagOf(core(k)) === K.OBJECT && publicSid(k) !== UNKNOWN ? publicSid(k) : null },
      // The object's layout is known and NOT certified closed: a store outside it
      // that only the summary sees (a flattened namespace's property, a bundled
      // initializer, an alias), or a nullable receiver. A static enumeration
      // from a per-name census stands down there — presence is a runtime fact.
      // The names a layout's objects gain after their literal, every one a
      // literal key of some store, over the receiver's construction sites (a
      // layout's facts are per site: two literals of one layout keep their own);
      // null when a store under a computed or a number key reaches a site (its
      // keys are then runtime facts).
      sideKeysOfExpr: e => {
        const k = kindOfExpr(e)
        if (tagOf(core(k)) !== K.OBJECT || paramOf(k) === UNKNOWN) return null
        const keys = new Set()
        for (const site of shapesOf(paramOf(k))) {
          if (indexedSchemas?.has(site) || (sideWild.get(site) ?? K.NONE) !== K.NONE) return null
          for (const key of sideProps.get(site)?.keys() ?? []) keys.add(key)
        }
        return [...keys]
      },
      // A member no object the receiver may be ever holds: every construction
      // site is a plain literal (no class, no accessor, no iterator record) the
      // summary keeps whole, whose layout lacks the name and which no store
      // under it, under a computed name or from code the summary cannot see
      // reaches, and the name is none an object inherits. The read is undefined.
      absentMember: (e, prop) => {
        if (typeof prop !== 'string' || INHERITED.has(prop) || memberMayBeOwn(prop)) return false
        const k = kindOfExpr(e)
        if (tagOf(k) !== K.OBJECT || paramOf(k) === UNKNOWN || isNullable(k)) return false
        return shapesOf(paramOf(k)).every(site => !schemas[site].includes(prop) && !schemas[site].includes(getterOf(prop)) &&
          !methods.get(site)?.size && !methods.get(layouts[site])?.size && !iterRecord(site) && !lostSchema(site) &&
          !indexedSchemas?.has(site) && !openSchemas.has(site) && tagOf(sideOf(site, prop)) === K.NONE && !facts.foldedLayouts.has(layouts[site]))
      },
      openSidOfExpr: e => { const k = kindOfExpr(e), sid = publicSid(k); return tagOf(core(k)) === K.OBJECT && sid !== UNKNOWN && (isNullable(k) || shapesOf(paramOf(k)).some(site => openSchemas.has(site))) ? sid : null },
      typedCtorOf: name => { const k = readKind(name); return tagOf(k) === K.TYPED && typedAux(k) !== UNKNOWN && !isNullable(k) ? ctorFromElemAux(typedAux(k)) : null },
      // The fixed length of the array a name or an expression holds; null when it may change or differ.
      fixedLenOf: name => fixedLen(readKind(name)),
      fixedLenOfExpr: e => fixedLen(kindOfExpr(e)),
      // Distinct array cells cannot hold the same allocation. Assignment,
      // arguments and container stores unify aliases in the solver; an open
      // receiver keeps UNKNOWN and proves nothing. Typed views do not use cells.
      arrayCellOf: e => { const k = kindOfExpr(e); return tagOf(k) === K.ARRAY && paramOf(k) !== UNKNOWN ? cell(paramOf(k)) : null },
      // The length a module binding's array has after module init and keeps
      // (index.js `built`, `grown`, `unknown`): what it was built with plus the
      // elements the top level pushed through this very name in counted loops;
      // null when anything else resized it, or the pushes went through another name.
      frozenLenOf: name => {
        const k = readKind(name)
        if (tagOf(core(k)) !== K.ARRAY || paramOf(k) === UNKNOWN) return null
        const c = cell(paramOf(k)), n = built.get(c), g = grown.get(c)
        if (!(n >= 0) || unknown.has(c) || (g && g.name !== name)) return null
        const len = n + (g?.n ?? 0)
        return stores.get(c) >= len ? null : len
      },
      // The finite interval each parameter of a function receives over every
      // call the walk binds (index.js `argRanges`), null per position a call
      // leaves unbounded; null for a function the host or a dispatcher may call.
      paramRangesOf,
      // A typed element read the summary holds inside the array's count: its
      // index needs no bounds test and its value is never the undefined of a miss.
      presentTypedRead: n => Array.isArray(n) && n[0] === '[]' && tagOf(kindOfExpr(n[1])) === K.TYPED && typedElementKey(n[2], kindOfExpr(n[2]) === NUMBER) && (typedReadPresent(scope, n) || presentReads.has(n)),
      // The element cell's own kind: presence included, no absent member for a read past the end.
      elemKindOf: name => { const k = readKind(name); return celled(k) ? pub(elemOf(k)) : null },
      arrayDenseOfExpr: node => {
        const k = kindOfExpr(node), e = elemOf(k)
        return tagOf(k) === K.ARRAY && e !== K.NONE && !hasTag(e, K.ABSENT)
      },
      arrayElemSidOf: name => { const k = readKind(name); if (tagOf(k) !== K.ARRAY || paramOf(k) === UNKNOWN) return null; const e = elemOf(k); return tagOf(e) === K.OBJECT && !isNullable(e) && publicSid(e) !== UNKNOWN ? publicSid(e) : null },
      /** The name's value is read as a string somewhere it flows: through a copy, a call, a sum. */
      stringDemand: name => { const key = keyOfAnywhere(name); return key !== null && (typeof key === 'number' ? strung.has(key) : key.some(k => strung.has(k))) },
      numericDemand: name => { const key = keyOfAnywhere(name), isNumeric = k => numeric.get(k) === 2; return key !== null && (typeof key === 'number' ? isNumeric(key) : key.every(isNumeric)) },
      numericStorage: name => { const key = keyOf(name), k = readKind(name); return key !== null && numeric.get(key) === 2 && tagOf(core(k)) === K.NUMBER && hasTag(k, K.ABSENT) && !hasTag(k, K.NULLISH) },
      // The binding's own kind, on every path: no guard's presence, no alias.
      bindingKindOf: name => pub(readKey(keyOfAnywhere(name))),
      // A Boolean reaches the binding (a store, a definition or an argument of
      // a kind naming BOOL, or one Boolean by its syntax): bit 1; one of its
      // stores may be another value by its syntax: bit 2.
      boolStores: name => {
        const key = keyOfAnywhere(name), bits = k => (boolKeys?.has(k) ? 1 : 0) | (storeBits?.get(k) ?? 0)
        if (key === null) return 0
        if (typeof key === 'number') return bits(key)
        let b = 0
        for (const k of key) b |= bits(k)
        return b
      },
      isParam: name => { const key = keyOfAnywhere(name); return key !== null && (typeof key === 'number' ? paramKeys?.has(key) : key.some(k => paramKeys?.has(k))) === true },
      // The demand pass denied the binding a number: a read of it neither converts nor is compatible (a container store, a return), so its value keeps JS semantics for every kind the host may pass.
      numericDenied: name => { const key = keyOfAnywhere(name), denied = k => numeric.get(k) === false; return key !== null && (typeof key === 'number' ? denied(key) : key.some(denied)) },
      // Incoming arguments/defaults before any reassignment in the body.
      paramKindOf: name => { const key = keyOf(name); return key === null ? K.NONE : pub(canon(incoming[key] ?? K.NONE)) },
      // Whether some call lets the parameter's default run (a missing or possibly undefined argument, an unseen caller).
      defaultMayRun: name => { const key = keyOf(name); return key === null || !defaultRuns || defaultRuns.has(key) },
      // Named storage supplies producer provenance, not the complete read
      // kind: an unknown key can also select a builtin or be absent.
      elemOfKind: (k, properties = false) => {
        if (properties) {
          if (tagOf(k) === K.TYPED) return pub(merge(typedElemKind(k), typedPropsOf(k)))
          if (tagOf(k) === K.ARRAY && paramOf(k) !== UNKNOWN) return pub(anyPropOf(k))
        }
        return pub(elemOf(k))
      },
      valOf: name => valOf(readKind(name)),
      // A layout's class member by slot name (`x`, `x__get`, `x__set`); null when its class has none or it is no class's.
      layoutMember: (sid, name) => methods.get(sid)?.get(name) ?? null,
      // Whether the layout's schema declares the slot (an object literal's accessor closure lives in one).
      layoutSlot: (sid, name) => schemas[sid]?.includes(name) === true,
      // Whether a name may be stored beside the layout's slots at any of its construction sites (a dynamic property).
      layoutSide: (sid, name) => (sitesByLayout.get(sid) ?? [sid]).some(site => tagOf(sideOf(site, name)) !== K.NONE),
      // One non-nullish class receiver, with no possible own-member shadow: a
      // getter's is a property of its name, stored where the class has no setter to take the store.
      classCallee: (recv, name) => {
        const r = kindOfExpr(recv)
        if (tagOf(r) !== K.OBJECT || paramOf(r) === UNKNOWN || isNullable(r)) return null
        const fn = classMember(r, name)
        if (!fn || memberMayBeOwn(name)) return null
        const prop = name.endsWith(ACCESSOR_GET) ? name.slice(0, -ACCESSOR_GET.length) : null
        return prop !== null && memberMayBeOwn(prop) && !classMember(r, prop + ACCESSOR_SET) ? null : fn
      },
      // valOf deliberately declines nullable kinds; payload queries do not.
      valOfExpr: e => valOf(kindOfExpr(e)),
      arrayNumericPropertiesAbsent: e => { const k = core(kindOfExpr(e)); return tagOf(k) === K.ARRAY && paramOf(k) !== UNKNOWN && numericPropsOf(k) === K.NONE },
      mayBeNullishExpr: e => { const k = kindOfExpr(e); return hasTag(k, K.NULLISH) || hasTag(k, K.ABSENT) },
      typedCtorOfExpr: e => { const k = kindOfExpr(e); return tagOf(k) === K.TYPED && typedAux(k) !== UNKNOWN && !isNullable(k) ? ctorFromElemAux(typedAux(k)) : null },
      typedPayloadCtorOfExpr: e => { const k = kindOfExpr(e); return tagOf(core(k)) === K.TYPED && typedAux(k) !== UNKNOWN ? ctorFromElemAux(typedAux(k)) : null },
      // A call of a name that holds one of several functions (`colors[c](n)`): the
      // typed array constructor each of them returns, null for one that returns another kind.
      callResultCtors: e => {
        if (!Array.isArray(e) || e[0] !== '()') return null
        const k = kindOfExpr(e[1])
        if (tagOf(k) !== K.CLOSURE || paramOf(k) === UNKNOWN) return null
        return membersOf(paramOf(k)).map(id => { const r = resultOfId(id); return tagOf(core(r)) === K.TYPED && typedAux(r) !== UNKNOWN ? ctorFromElemAux(typedAux(r)) : null })
      },
    }
  }
  // A callable identity: a function name or signature, a closure id or its
  // parameter node (its stable identity through emission), a frame carrying
  // the parameter node as `scope`; null for none.
  const identityOf = x => typeof x === 'string' || typeof x === 'number' ? x
    : x == null ? null : scopeOfParams.get(x) ?? scopeOfSig.get(x) ?? (x.scope != null ? scopeOfParams.get(x.scope) : undefined) ?? null
  // The frozen result contract of a callable (contract.js); an unknown one never completes.
  const resultContract = x => { const f = facts.contracts?.get(identityOf(x)); if (!f) return NONE_CONTRACT; const c = readContract(f); if (!internal && tagOf(c.kind) === K.TYPED) c.kind = pub(c.kind); return c }
  // Storage is shared by layout. Project once at publication, not at every
  // emitter lookup; analysis reads continue to use each construction's slots.
  const storage = internal ? fields : []
  if (!internal) for (let sid = 0; sid < fields.length; sid++) {
    const values = fields[sid]
    if (!values) continue
    const layout = layouts[sid]
    const row = storage[layout] ??= new Array(values.length).fill(K.NONE)
    for (let i = 0; i < values.length; i++) row[i] = pub(join(row[i], pub(values[i])))
  }
  const fieldKind = (sid, prop) => storage[sid]?.[schemas[sid]?.indexOf(prop)] ?? K.NONE
  let arrowOfClosure = null
  const arrowsById = () => { const a = []; for (const [node, id] of closures) a[id] = node; return a }
  let deletableLayouts = null
  const hostLayouts = new Set([...facts.hostSchemas].map(sid => layouts[sid]))
  const opaqueLayouts = new Set([...facts.opaqueSchemas].map(sid => layouts[sid]))
  // A bulk field copy keeps the shape, but the copied payload must stand on
  // its own in an array, dictionary or another layout. Source and destination
  // layouts therefore agree on tagged BigInt slots before either is emitted.
  const copiedLayouts = new Set([...facts.copiedSchemas].map(sid => layouts[sid]))
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
    valBesidePresence,
    /** The value type of a kind without its nullish part (a guard proved presence). */
    coreValOfKind: k => valOf(core(k)),
    fieldKind,
    hostSchema: sid => hostLayouts.has(sid),
    // Whether any binding of the program holds a value of this tag: a
    // runtime arm for a kind no binding can hold is dead weight.
    holdsKind: tag => hasTag(kindUnion, tag),
    // The names that hold one number for good: name → the number.
    held: facts.held,
    // The names a builtin stores into its target object (`Object.assign`).
    assignedProps: facts.assignedProps,
    opaqueSchema: sid => opaqueLayouts.has(sid),
    copiedSchema: sid => copiedLayouts.has(sid),
    // Whether an object of the layout may gain a property beyond its slots: a
    // key stored beside them, a computed store, or a hand-off to code the
    // summary cannot see (a lost shape).
    grownSchema: sid => (sitesByLayout.get(sid) ?? [sid]).some(site => (sideProps.get(site)?.size ?? 0) > 0 ||
      (sideWild.get(site) ?? K.NONE) !== K.NONE || openSchemas.has(site) || facts.opaqueSchemas.has(site)),
    // A layout a `delete` can reach: a deleted receiver's, or any lost layout
    // once a delete went through a receiver of unknown shape.
    deletableSchema: sid => { deletableLayouts ??= new Set([...facts.deletable ?? []].map(s => layouts[s])); return deletableLayouts.has(sid) || (facts.deleteReach?.unknown === true && (opaqueLayouts.has(sid) || hostLayouts.has(sid))) },
    // Construction sites (plan/declare-unseen-keys.js): the ones a literal
    // node makes, whether an object of one can hold a key before its first
    // store unseen (every holder is one the summary names, nothing asks it
    // for its keys or deletes one, no store under a computed name reaches it),
    // the names stored beside its layout in the order the walk met them, and
    // the sets of sites values join (a shape set, a cell's shapes).
    literalSites: node => { const k = objectKinds.get(node); return k !== undefined && tagOf(core(k)) === K.OBJECT && paramOf(k) !== UNKNOWN ? shapesOf(paramOf(k)) : [] },
    keysUnseen: sid => !facts.keysSeen.has(sid) && !facts.opaqueSchemas.has(sid) && !facts.hostSchemas.has(sid) && !facts.deletable.has(sid) &&
      !indexedSchemas.has(sid) && (sideWild.get(sid) ?? K.NONE) === K.NONE && !facts.foldedLayouts.has(layouts[sid]),
    sideKeys: sid => [...(sideProps.get(sid)?.keys() ?? [])],
    siteLayout: sid => layouts[sid],
    joinedSites: () => {
      const out = []
      for (const id of shapeUnions.values()) if (id >= SET_BASE && id !== UNKNOWN) out.push(shapesOf(id))
      for (const s of cellShapes.values()) out.push([...s])
      return out
    },
    fieldVal: (sid, prop) => valOf(fieldKind(sid, prop)),
    fieldTypedCtor: (sid, prop) => { const k = fieldKind(sid, prop); return tagOf(k) === K.TYPED && typedAux(k) !== UNKNOWN && !isNullable(k) ? ctorFromElemAux(typedAux(k)) : null },
    fieldSid: (sid, prop) => { const k = fieldKind(sid, prop); return tagOf(k) === K.OBJECT && paramOf(k) !== UNKNOWN && !isNullable(k) ? paramOf(k) : null },
    resultOf: name => pub(resultOfId(name)),
    resultVal: name => valOf(resultOfId(name)),
    // The closures a closure or closure-set id (calleeOf) names, and a
    // closure's arrow: what a call through a resolved binding runs.
    closureMembers: id => membersOf(id),
    closureIdOfBody: body => closuresByBody.get(body),
    closureArrow: id => (arrowOfClosure ??= arrowsById())[id] ?? null,
    memberMayBeOwn,
    memberMayBeOwnOn: (prop, valueKind) => builtinReceiverMayHaveOwn(tagOf(kindOfVal(valueKind)), prop),
    builtinMemberMayBeOwn: prop => builtinOwnProps.has(prop),
    typedPropertiesAbsent: () => elems[typedProps] === K.NONE && [...typedPropsByAux.values()].every(c => elems[c] === K.NONE),
    hasTypedFields: fields.some(a => a?.some(k => tagOf(k) === K.TYPED && typedAux(k) !== UNKNOWN && !isNullable(k))),
    escaped: facts.escaped,
    /** The truth an `if` or `?:` test has on every run, or null. */
    decisionOf: n => facts.decisions?.get(n) ?? null,
  }
}
