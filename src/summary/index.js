/**
 * The program summary: one kind per binding, per schema slot, per function
 * result, computed once over the prepared program by a fixpoint before any
 * per-function analysis runs. A kind is one lattice element:
 *
 *   NONE < NUMBER STRING BOOL BIGINT NULLISH TYPED(elem) ARRAY(elem)
 *          OBJECT(sid) CLOSURE(id) MAP SET DATE REGEX HASH < ANY
 *
 * with a nullable bit (NULLISH joins into any kind as that bit). Joins are
 * flow-insensitive: a binding's kind is the join of everything assigned to
 * it, a slot's kind the join of every construction and store, a parameter's
 * kind the join of every argument at every direct call, a result the join
 * of every return. What the summary cannot see is ANY: an exported
 * function's parameters (the host calls it), a function used as a value
 * (whoever holds it calls it), a store through a receiver of unknown shape
 * (it poisons that property in every schema that has it), a computed key.
 *
 * A read then has the kind its source has: `o.buf` with `o: OBJECT(sid)`
 * has the kind of that slot, and a loop over it lowers to typed storage.
 * The per-function families read the summary through `ctx.summary` and
 * are retired as it takes over their censuses (PLAN.md, step 3).
 *
 * The host boundary is a contract, not a poison: an object that reaches the
 * host (returned, or passed to an import) keeps its field kinds, and a host
 * store through `mem.write` must respect them, as it does a typed array's
 * element type. An unresolved callee inside the program (`Object.assign`, a
 * builtin not known to be pure) may store into an object it receives, so
 * that object's schema goes to ANY.
 *
 * @module summary
 */
import { MUTATE_OPS, extractParams, isBrand, ACCESSOR_GET, ACCESSOR_SET, CLASS_T } from '../ast.js'
import { encodeTypedElemAux, ctorFromElemAux } from '../../layout.js'
import { VAL } from '../reps.js'
import { builtinCalleeVal } from '../kind-traits.js'

export const K = {
  NONE: 0, NUMBER: 1, STRING: 2, BOOL: 3, BIGINT: 4, NULLISH: 5, TYPED: 6, ARRAY: 7,
  OBJECT: 8, CLOSURE: 9, MAP: 10, SET: 11, DATE: 12, REGEX: 13, HASH: 14, ANY: 15,
}
const PARAM_BITS = 20, NULLABLE = 1 << 30
/** The parameter of a kind whose parameter is not known (any schema, any element, any closure). */
export const UNKNOWN = (1 << PARAM_BITS) - 1
export const kind = (tag, param = UNKNOWN) => (tag << PARAM_BITS) | (param & UNKNOWN)
export const tagOf = (k) => (k >>> PARAM_BITS) & 0x3FF
export const paramOf = (k) => k & UNKNOWN
export const isNullable = (k) => (k & NULLABLE) !== 0
const core = (k) => k & ~NULLABLE
const ANY = kind(K.ANY), NUMBER = kind(K.NUMBER), STRING = kind(K.STRING), BOOL = kind(K.BOOL), BIGINT = kind(K.BIGINT), NULLISH = kind(K.NULLISH)

/** The nullable form of a kind; ANY absorbs the bit, so the lattice has one top. */
export const orNull = (k) => tagOf(k) === K.ANY ? ANY : k | NULLABLE

export function join(a, b) {
  if (a === b) return a
  const n = (a | b) & NULLABLE
  a = core(a); b = core(b)
  if (a === ANY || b === ANY) return ANY
  if (a === K.NONE) return b | n
  if (b === K.NONE || a === b) return a | n
  const ta = tagOf(a), tb = tagOf(b)
  if (ta === K.NULLISH) return b | NULLABLE
  if (tb === K.NULLISH) return a | NULLABLE
  if (ta !== tb) return ANY
  return kind(ta) | n  // same tag, different parameter: the tag alone
}

// Builtins that read their arguments and never write a field of them; any
// other unresolved callee may store into an object it receives.
const PURE_BUILTINS = /^(Object\.(keys|values|entries|freeze|isFrozen|getOwnPropertyNames|getPrototypeOf|hasOwn|is)|JSON\.stringify|Array\.isArray|console\.\w+|Math\.\w+|Number(\.\w+)?|String(\.\w+)?|Boolean|BigInt|Symbol(\.\w+)?|isNaN|isFinite|parseInt|parseFloat|structuredClone)$/

/** The value kind (reps.js VAL) of a monomorphic, non-nullable kind; null otherwise. */
const VAL_OF = [null, VAL.NUMBER, VAL.STRING, VAL.BOOL, VAL.BIGINT, null, VAL.TYPED, VAL.ARRAY, VAL.OBJECT, VAL.CLOSURE, VAL.MAP, VAL.SET, VAL.DATE, VAL.REGEX, VAL.HASH, null]
export const valOf = (k) => isNullable(k) ? null : VAL_OF[tagOf(k)] ?? null
/** The kind of a value kind: the inverse of `valOf` for the kinds that have one; ANY for a kind the lattice has no tag for. */
export const kindOfVal = (v) => { const t = VAL_OF.indexOf(v); return v == null ? ANY : t < 0 ? ANY : kind(t) }
export { core }

const BIND = CLASS_T + 'bind'
const TYPED_CTOR = /^new\.(\w+Array)(\.view)?$/
const NUMBER_METHODS = new Set(['length', 'size', 'byteLength', 'byteOffset'])
const TYPED_SAME = new Set(['subarray', 'slice', 'map', 'filter', 'fill', 'reverse', 'sort', 'copyWithin', 'set'])
const STRING_METHODS = new Set(['slice', 'substring', 'substr', 'trim', 'trimStart', 'trimEnd', 'toUpperCase', 'toLowerCase', 'padStart', 'padEnd', 'repeat', 'replace', 'replaceAll', 'concat', 'normalize', 'at', 'charAt'])
const STRING_NUMBER_METHODS = new Set(['charCodeAt', 'codePointAt', 'indexOf', 'lastIndexOf', 'search', 'localeCompare'])
const NUMBER_OPS = new Set(['-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>', '~', '++', '--'])
const BOOL_OPS = new Set(['<', '<=', '>', '>=', '==', '!=', '===', '!==', '!', 'in', 'instanceof'])

/** Summarize the prepared program: `funcs` are the function records, `schemas` the schema prop
 *  lists, `imports` the host imports by alias with the result kind each declares (reps.js VAL, or
 *  null). An exported global keeps its kind: the host reads it, and can store only a number
 *  through its f64 export, which a number global takes and no other kind could take. */
export function summarize(ast, { funcs, schemas, brandOf, classes, exported, imports }) {
  const kinds = new Map()            // binding name → kind
  const fields = new Map()           // sid → kind[]
  const results = new Map()          // function name or closure id → kind
  const closures = new Map()         // `=>` node → closure id
  const closureParams = []           // closure id → param names
  const closureBodies = []           // closure id → body
  const escaped = new Set()          // closure ids and function names whose callers are unknown
  // The registry's key (module/schema.js): the props, and a class's brand as the salt.
  const schemaKey = (props, brand) => props.length + '\x01' + props.join('\x01') + (brand ? '\x02' + brand : '')
  const sidByKey = new Map(schemas.map((props, sid) => [schemaKey(props, brandOf(sid)), sid]))
  /** A literal's static keys and its brand: `{ props, brand }`, or null when a key is computed or spread. */
  const literalShape = (n) => {
    const props = []
    let brand = null
    for (let i = 1; i < n.length; i++) {
      const p = n[i]
      const key = typeof p === 'string' ? p : Array.isArray(p) && p[0] === ':' && typeof p[1] === 'string' ? p[1] : null
      if (key === null) return null
      if (isBrand(key)) brand = key; else props.push(key)
    }
    return { props, brand }
  }
  const byProp = new Map()
  schemas.forEach((props, sid) => props.forEach((p, i) => { let b = byProp.get(p); if (!b) byProp.set(p, b = []); b.push([sid, i]) }))
  const funcByName = new Map(funcs.map(f => [f.name, f]))
  let changed = false

  const escapeId = (id) => { if (!escaped.has(id)) { escaped.add(id); changed = true } }
  // Two closures joined lose their identities: whoever holds the join calls
  // either, and a call through it binds neither's parameters, so both are
  // called from where the summary cannot see.
  const merge = (a, b) => {
    if (tagOf(a) === K.CLOSURE && tagOf(b) === K.CLOSURE && paramOf(a) !== paramOf(b)) { if (paramOf(a) !== UNKNOWN) escapeId(paramOf(a)); if (paramOf(b) !== UNKNOWN) escapeId(paramOf(b)) }
    return join(a, b)
  }
  const slots = (sid) => { let a = fields.get(sid); if (!a) fields.set(sid, a = new Array(schemas[sid].length).fill(K.NONE)); return a }
  const raise = (map, key, k) => { const old = map.get(key) ?? K.NONE; const nk = merge(old, k); if (nk !== old) { map.set(key, nk); changed = true } }
  const raiseSlot = (sid, i, k) => { const a = slots(sid); const nk = merge(a[i], k); if (nk !== a[i]) { a[i] = nk; changed = true } }
  const poisonProp = (prop) => { for (const [sid, i] of byProp.get(prop) ?? []) raiseSlot(sid, i, ANY) }
  const poisonSchema = (sid) => { const a = slots(sid); for (let i = 0; i < a.length; i++) raiseSlot(sid, i, ANY) }
  const paramNames = (params) => extractParams(params).map(p => typeof p === 'string' ? p : null)
  const closureId = (node) => {
    let id = closures.get(node)
    if (id === undefined) { id = closureParams.length; closures.set(node, id); closureParams.push(paramNames(node[1])); closureBodies.push(node[2]) }
    return id
  }
  // An array's element kind lives in a cell its construction site owns; every
  // store and push joins into it, so a read sees every element the program
  // can put there. Two arrays with different cells join to an array of
  // unknown elements.
  const elems = []               // cell id → element kind
  const arrayCells = new Map()   // array literal node → cell id
  const elemOf = (k) => tagOf(k) === K.ARRAY && paramOf(k) !== UNKNOWN ? elems[paramOf(k)] : ANY
  const arrayOf = (node, elem) => { let id = arrayCells.get(node); if (id === undefined) { id = elems.length; elems.push(elem); arrayCells.set(node, id) } return kind(K.ARRAY, id) }
  const raiseElem = (arr, k) => { if (tagOf(arr) !== K.ARRAY || paramOf(arr) === UNKNOWN) return; const id = paramOf(arr), nk = merge(elems[id], k); if (nk !== elems[id]) { elems[id] = nk; changed = true } }
  /** A value the summary no longer follows: a closure's callers become unknown, an array's elements too. */
  const escape = (k) => {
    if (tagOf(k) === K.CLOSURE && paramOf(k) !== UNKNOWN) escapeId(paramOf(k))
    if (tagOf(k) === K.ARRAY) { escape(elemOf(k)); raiseElem(k, ANY) }
  }
  /** An object handed to code the summary cannot see: its fields may be stored to. */
  // An own property stored under a class member's name shadows the member
  // (jzify/classes.js): a store of a non-field property on an instance, or
  // through a receiver of unknown shape. The name must be literal: a
  // computed-key store, or a store by code the summary cannot see, does not
  // reach a class member (the class contract, jzify/classes.js).
  const dynamicProps = new Set()
  const escapeObject = (k) => { if (tagOf(k) === K.OBJECT && paramOf(k) !== UNKNOWN) poisonSchema(paramOf(k)); escape(k) }
  const args = (a) => a == null ? [] : Array.isArray(a) && a[0] === ',' ? a.slice(1) : [a]
  // A parameter's incoming kind, the join of its arguments alone: a read of
  // the parameter before any reassignment can run sees only this; `kinds`
  // holds the join with the reassignments too.
  const incoming = new Map()
  const bindParam = (name, k) => { raise(incoming, name, k); raise(kinds, name, k) }
  const bind = (names, ks) => {
    for (let i = 0; i < names.length; i++) { if (names[i] != null) bindParam(names[i], i < ks.length ? ks[i] : NULLISH); }
    for (let i = names.length; i < ks.length; i++) escape(ks[i])
  }
  const call = (callee, argKinds) => {
    if (typeof callee === 'string') {
      const m = TYPED_CTOR.exec(callee)
      if (m) { const aux = encodeTypedElemAux(m[1], !!m[2]); return kind(K.TYPED, aux == null ? UNKNOWN : aux) }
      if (callee === 'new.RegExp') return kind(K.REGEX)
      if (callee === 'Array') return kind(K.ARRAY)
      if (callee === 'String' || callee.startsWith('String.')) return STRING
      if (callee === 'Number' || callee.startsWith('Math.') || callee.startsWith('Number.')) return NUMBER
      // jzify's `for…of` lowering iterates `__iter_arr(v)` by index: an array,
      // typed array or string iterates as itself, anything else as an array
      // of unknown elements; `__keys_ro` is `for…in`'s key list.
      if (callee === '__iter_arr') { const t = argKinds.length ? tagOf(argKinds[0]) : K.NONE; return t === K.ARRAY || t === K.TYPED || t === K.STRING ? argKinds[0] : t === K.NONE ? K.NONE : kind(K.ARRAY) }
      if (callee === '__keys_ro') return kind(K.ARRAY)
      const f = funcByName.get(callee)
      if (f) {
        if (!escaped.has(callee)) bind(f.sig.params.map(p => p.rest ? null : p.name), argKinds)
        return results.get(callee) ?? K.NONE
      }
      const k = kinds.get(callee)
      if (k !== undefined && tagOf(k) === K.CLOSURE && paramOf(k) !== UNKNOWN) return callClosure(paramOf(k), argKinds)
      if (k === undefined && modelled.has(callee)) return K.NONE  // a local callee not known yet
      // A host import returns the kind it declares; a builtin the kind its trait says (kind-traits.js).
      if (imports.has(callee)) { for (const k of argKinds) escape(k); return kindOfVal(imports.get(callee)) }
      // A builtin: the kind its trait names (kind-traits.js). A `new.X` past
      // the typed constructors above is a DataView (a typed view) or unknown.
      let builtin = builtinCalleeVal(callee)
      if (builtin === VAL.TYPED && callee !== 'new.DataView') builtin = null
      if (builtin != null || PURE_BUILTINS.test(callee)) { for (const k of argKinds) escape(k); return kindOfVal(builtin) }
    }
    for (const k of argKinds) escapeObject(k)
    return ANY
  }
  const callClosure = (id, argKinds) => {
    if (!escaped.has(id)) bind(closureParams[id], argKinds)
    return results.get(id) ?? K.NONE
  }
  // A class (jzify/classes.js): its members are functions of the receiver.
  // A receiver of one class calls its function; a receiver the summary
  // cannot name may be any class with the member, so each is called.
  const classOfSid = (sid) => { const b = brandOf(sid); return b ? classes?.get(b) ?? null : null }
  const classMember = (recv, name) => tagOf(recv) === K.OBJECT && paramOf(recv) !== UNKNOWN ? classOfSid(paramOf(recv))?.methods.get(name) ?? null : null
  const memberMayBeOwn = (prop) => dynamicProps.has(prop)
  /** The class member's result, or ANY when an own property may shadow it. */
  const memberResult = (recv, name, r) => memberMayBeOwn(name) ? ANY : r
  const unknownReceiver = (recv) => { const t = tagOf(recv); return t === K.ANY || (t === K.OBJECT && paramOf(recv) === UNKNOWN) }
  const callCandidates = (recv, name, argKinds) => {
    if (!classes || !unknownReceiver(recv)) return
    for (const e of classes.values()) { const fn = e.methods.get(name); if (fn) call(fn, [recv, ...argKinds]) }
  }
  const method = (recv, name, argKinds) => {
    const t = tagOf(recv)
    if (t === K.NONE) return K.NONE  // the receiver is not known yet; a later round sees it
    // A member access on a nullish receiver throws before the call: the
    // function's receiver is the class alone.
    const classFn = classMember(recv, name)
    if (classFn) { const r = call(classFn, [core(recv), ...argKinds]); if (memberMayBeOwn(name)) for (const k of argKinds) escape(k); return memberResult(recv, name, r) }
    callCandidates(recv, name, argKinds)
    if (t === K.OBJECT && paramOf(recv) !== UNKNOWN) {
      const sid = paramOf(recv), i = schemas[sid].indexOf(name)
      if (i >= 0) {
        const fk = slots(sid)[i]
        if (tagOf(fk) === K.CLOSURE && paramOf(fk) !== UNKNOWN) return callClosure(paramOf(fk), argKinds)
        if (tagOf(fk) !== K.NONE) { for (const k of argKinds) escape(k); return ANY }
        return K.NONE
      }
    }
    if (t === K.TYPED) { if (TYPED_SAME.has(name)) return name === 'set' ? NULLISH : kind(K.TYPED, paramOf(recv)); if (name === 'indexOf' || name === 'lastIndexOf' || name === 'at' || name === 'reduce') return name === 'at' ? NUMBER | NULLABLE : NUMBER }
    if (t === K.STRING) { if (STRING_METHODS.has(name)) return STRING; if (STRING_NUMBER_METHODS.has(name)) return NUMBER; if (name === 'split') return kind(K.ARRAY) }
    if (t === K.ARRAY) {
      if (name === 'push' || name === 'unshift') { for (const k of argKinds) raiseElem(recv, k); return NUMBER }
      if (name === 'indexOf' || name === 'lastIndexOf' || name === 'findIndex') { for (const k of argKinds) escape(k); return NUMBER }
      if (name === 'pop' || name === 'shift' || name === 'at' || name === 'find') { for (const k of argKinds) escape(k); return orNull(elemOf(recv)) }
      if (name === 'slice' || name === 'reverse' || name === 'sort') { for (const k of argKinds) escape(k); return recv }
      if (name === 'fill') { for (const k of argKinds) raiseElem(recv, k); return recv }
      if (name === 'join') return STRING
      if (name === 'includes' || name === 'some' || name === 'every') { for (const k of argKinds) escape(k); return BOOL }
    }
    if (t === K.MAP && (name === 'set' || name === 'has' || name === 'delete' || name === 'clear')) { for (const k of argKinds) escapeObject(k); return name === 'set' ? recv : name === 'clear' ? NULLISH : BOOL }
    if (t === K.SET && (name === 'add' || name === 'has' || name === 'delete')) { for (const k of argKinds) escapeObject(k); return name === 'add' ? recv : BOOL }
    for (const k of argKinds) escapeObject(k)
    if (t === K.OBJECT || t === K.HASH || t === K.ANY || t === K.ARRAY) escapeObject(recv)
    return ANY
  }
  const literalKind = (v) => v == null ? NULLISH : typeof v === 'number' ? NUMBER : typeof v === 'string' ? STRING : typeof v === 'boolean' ? BOOL : typeof v === 'bigint' ? BIGINT : ANY
  // The receiver of a member access: a function's property (`parse.enter`, a
  // namespace) reads or stores on the function object and calls nothing, so
  // the function does not escape by it.
  const receiver = (n) => typeof n === 'string' && funcByName.has(n) && !kinds.has(n) ? kind(K.CLOSURE) : expr(n)

  /** The kind of an expression, with its effects: calls bind parameters, stores raise slots. */
  const expr = (n) => {
    if (n == null) return NULLISH
    if (typeof n === 'number') return NUMBER
    if (typeof n === 'string') {
      const k = pre.has(n) ? incoming.get(n) ?? K.NONE : kinds.get(n)
      if (k !== undefined) return k
      if (funcByName.has(n)) { escapeId(n); return kind(K.CLOSURE) }
      // A binding whose assignments this walk models is bottom until the
      // fixpoint reaches them; any other name, a binding bound some way the
      // walk does not follow or a name from outside the program, is ANY.
      return modelled.has(n) ? K.NONE : ANY
    }
    if (!Array.isArray(n)) return ANY
    const op = n[0]
    if (op == null) return literalKind(n[1])
    if (op === 'str') return STRING
    if (op === 'bool') return BOOL
    if (op === 'nan') return NUMBER
    if (op === 'bigint') return BIGINT
    if (op === '//') return kind(K.REGEX)
    if (op === '`' || op === 'strcat') { for (let i = 1; i < n.length; i++) expr(n[i]); return STRING }
    if (op === '=>') { loopAssigns(n); const id = closureId(n); return kind(K.CLOSURE, id) }  // a closure assigning a parameter may run any time after this
    if (op === '{}') {
      const vals = [], init = definite.get(n), shape = literalShape(n)
      for (let i = 1; i < n.length; i++) {
        const p = n[i]
        if (Array.isArray(p) && p[0] === ':' && typeof p[1] === 'string') { if (!isBrand(p[1])) vals.push(init?.has(p[1]) && isNullishLit(p[2]) ? K.NONE : expr(p[2])) }
        else if (typeof p === 'string') vals.push(expr(p))
        else { if (Array.isArray(p)) for (let j = 1; j < p.length; j++) escape(expr(p[j])); return kind(K.HASH) }
      }
      const sid = shape ? sidByKey.get(schemaKey(shape.props, shape.brand)) : undefined
      if (sid === undefined) { for (const v of vals) escape(v); return kind(K.HASH) }
      for (let i = 0; i < vals.length; i++) raiseSlot(sid, i, vals[i])
      return kind(K.OBJECT, sid)
    }
    if (op === '[') {
      let elem = K.NONE
      for (let i = 1; i < n.length; i++) elem = merge(elem, expr(n[i]))
      const arr = arrayOf(n, K.NONE)
      raiseElem(arr, elem)
      return arr
    }
    if (op === '.' || op === '?.') {
      const recv = receiver(n[1]), prop = n[2], t = tagOf(recv)
      if (typeof prop !== 'string') { expr(prop); return t === K.NONE ? K.NONE : ANY }
      if (t === K.NONE) return K.NONE
      if (t === K.OBJECT && paramOf(recv) !== UNKNOWN) {
        const i = schemas[paramOf(recv)].indexOf(prop)
        if (i >= 0) return slots(paramOf(recv))[i]
        // a class's getter, or a method read as a value: bound by its binder
        const getter = classMember(recv, prop + ACCESSOR_GET)
        if (getter) return memberResult(recv, prop, call(getter, [core(recv)]))
        const fn = classMember(recv, prop)
        if (fn) return memberResult(recv, prop, call(fn + BIND, [core(recv)]))
        return memberMayBeOwn(prop) ? ANY : NULLISH
      }
      callCandidates(recv, prop + ACCESSOR_GET, [])
      if (classes && unknownReceiver(recv) && !prop.endsWith(ACCESSOR_GET) && !prop.endsWith(ACCESSOR_SET)) for (const e of classes.values()) { const fn = e.methods.get(prop); if (fn) call(fn + BIND, [recv]) }
      if (NUMBER_METHODS.has(prop) && (t === K.ARRAY || t === K.TYPED || t === K.STRING || t === K.MAP || t === K.SET)) return NUMBER
      return ANY
    }
    if (op === '[]') {
      const recv = receiver(n[1]), idx = n[2], t = tagOf(recv)
      if (Array.isArray(idx) && idx[0] == null && typeof idx[1] === 'string') return expr(['.', n[1], idx[1]])
      expr(idx)
      if (t === K.NONE) return K.NONE
      if (t === K.TYPED) return paramOf(recv) !== UNKNOWN && (paramOf(recv) & 16) ? BIGINT : NUMBER
      if (t === K.ARRAY) return orNull(elemOf(recv))
      if (t === K.STRING) return STRING
      return ANY
    }
    if (op === '()') {
      if (n.length === 2) return expr(n[1])  // a grouping `(e)`: a call always carries its argument slot
      const callee = n[1], as = args(n[2]).map(expr)
      if (Array.isArray(callee) && (callee[0] === '.' || callee[0] === '?.') && typeof callee[2] === 'string') {
        const recv = receiver(callee[1])
        return method(recv, callee[2], as)
      }
      if (typeof callee === 'string') return call(callee, as)
      const ck = expr(callee)
      if (tagOf(ck) === K.NONE) return K.NONE
      if (tagOf(ck) === K.CLOSURE && paramOf(ck) !== UNKNOWN) return callClosure(paramOf(ck), as)
      for (const k of as) escapeObject(k)
      return ANY
    }
    if (MUTATE_OPS.has(op)) return assign(op, n[1], n[2])
    if (op === '+') return plus(expr(n[1]), expr(n[2]))
    if (NUMBER_OPS.has(op) || op === 'u-') { let big = true; for (let i = 1; i < n.length; i++) if (tagOf(expr(n[i])) !== K.BIGINT) big = false; return big && n.length > 1 ? BIGINT : NUMBER }
    if (op === 'u+') { expr(n[1]); return NUMBER }
    if (BOOL_OPS.has(op)) { for (let i = 1; i < n.length; i++) expr(n[i]); return BOOL }
    if (op === '&&' || op === '||' || op === '??') return merge(expr(n[1]), expr(n[2]))
    if (op === '?' || op === '?:') { expr(n[1]); return merge(expr(n[2]), expr(n[3])) }
    if (op === ',') { let k = NULLISH; for (let i = 1; i < n.length; i++) k = expr(n[i]); return k }
    if (op === 'typeof') { expr(n[1]); return STRING }
    if (op === 'delete') { stmt(n); return BOOL }
    if (op === 'void') { expr(n[1]); return NULLISH }
    if (op === 'await') return expr(n[1]) === K.NONE ? K.NONE : ANY
    if (op === '...' ) { escape(expr(n[1])); return ANY }
    for (let i = 1; i < n.length; i++) stmt(n[i])
    return ANY
  }

  /** `a + b`: a string concatenates, numbers and bigints add, anything else may do either. */
  const plus = (a, b) => { const ta = tagOf(a), tb = tagOf(b); return ta === K.STRING || tb === K.STRING ? STRING : ta === K.NONE || tb === K.NONE ? K.NONE : ta === K.NUMBER && tb === K.NUMBER ? NUMBER : ta === K.BIGINT && tb === K.BIGINT ? BIGINT : ANY }
  /** `target op= value`: the stored kind reaches the binding or the slot; returns the expression's kind. */
  const assign = (op, target, value) => {
    let v = op === '=' ? expr(value) : op === '++' || op === '--' ? NUMBER : op === '+=' ? plus(expr(target), expr(value)) : merge(expr(target), value == null ? NUMBER : expr(value))
    if (op !== '=' && op !== '+=' && op !== '||=' && op !== '&&=' && op !== '??=') v = tagOf(v) === K.BIGINT ? BIGINT : NUMBER
    if (typeof target === 'string') { pre.delete(target); raise(kinds, target, v); return v }
    if (Array.isArray(target) && (target[0] === '.' || target[0] === '?.')) {
      const recv = receiver(target[1]), prop = target[2], t = tagOf(recv)
      if (t === K.NONE) return v
      if (typeof prop !== 'string') { poisonAll(recv, expr(prop)); escape(v); return v }
      if (t === K.OBJECT && paramOf(recv) !== UNKNOWN) {
        const i = schemas[paramOf(recv)].indexOf(prop), setter = i < 0 ? classMember(recv, prop + ACCESSOR_SET) : null
        if (i >= 0) raiseSlot(paramOf(recv), i, v); else if (setter) call(setter, [core(recv), v]); else { poisonSchema(paramOf(recv)); dynamicProps.add(prop) }
      }
      else if (t !== K.ARRAY && t !== K.TYPED && t !== K.STRING && t !== K.MAP && t !== K.SET) { callCandidates(recv, prop + ACCESSOR_SET, [v]); poisonProp(prop); dynamicProps.add(prop); escape(v) }
      return v
    }
    if (Array.isArray(target) && target[0] === '[]') {
      const recv = receiver(target[1]), idx = target[2], t = tagOf(recv)
      if (Array.isArray(idx) && idx[0] == null && typeof idx[1] === 'string') return assign(op, ['.', target[1], idx[1]], value)
      const ik = expr(idx)
      if (t === K.ARRAY) raiseElem(recv, v)
      else if (t !== K.NONE && t !== K.TYPED && t !== K.STRING) { poisonAll(recv, ik); escapeObject(v) }
      return v
    }
    escape(v)
    return v
  }
  // A computed-key store may reach any slot; one with a number key only a
  // slot named like an index. A key of bottom kind is not known yet: a
  // later round decides.
  const poisonAll = (recv, key = ANY) => {
    if (tagOf(key) === K.NONE) return
    const numeric = tagOf(key) === K.NUMBER
    const hit = (sid) => { if (!numeric) poisonSchema(sid); else schemas[sid].forEach((p, i) => { if (/^\d+$/.test(p)) raiseSlot(sid, i, ANY) }) }
    if (tagOf(recv) === K.OBJECT && paramOf(recv) !== UNKNOWN) hit(paramOf(recv)); else for (let sid = 0; sid < schemas.length; sid++) hit(sid)
  }

  // Definite initialization: `let self = { f: undefined, … }` followed, in the
  // same statement list and before `self` is used any other way, by
  // `self.f = v` for the field. The literal's `undefined` is then no value the
  // slot ever holds (a class constructor's fields, declared in the shape).
  const definite = new Map()   // object-literal node → Set of props assigned before use
  const isNullishLit = (v) => Array.isArray(v) && v[0] == null && v[1] == null
  const mentions = (v, name, assigned) => {
    if (v === name) return true
    if (!Array.isArray(v)) return false
    if (v[0] === '.' && v[1] === name && typeof v[2] === 'string') return !assigned.has(v[2])
    for (let i = 1; i < v.length; i++) if (mentions(v[i], name, assigned)) return true
    return false
  }
  // The fields `name` is definitely assigned by the statements from `from`
  // on: a store `name.f = v` whose value does not read the object, or a call
  // `F(name, …)` to a function that so assigns its first parameter (a class
  // initializer, jzify/classes.js), until a statement uses `name` otherwise.
  const definiteStores = (list, from, name, assigned, seen) => {
    for (let i = from; i < list.length; i++) {
      const st = list[i]
      if (!Array.isArray(st)) return
      if (st[0] === '=' && Array.isArray(st[1]) && st[1][0] === '.' && st[1][1] === name && typeof st[1][2] === 'string') {
        if (mentions(st[2], name, assigned) || isNullishLit(st[2])) return
        assigned.add(st[1][2])
        continue
      }
      const f = st[0] === '()' && typeof st[1] === 'string' ? funcByName.get(st[1]) : undefined
      const as = f ? args(st[2]) : null
      if (!f || as[0] !== name || seen.has(f) || as.slice(1).some(a => mentions(a, name, assigned))) return
      const p0 = f.sig.params[0]
      if (!p0 || p0.rest) return
      seen.add(f)
      const body = f.body, stmts = isBlock(body) ? (Array.isArray(body[1]) && body[1][0] === ';' ? body[1].slice(1) : [body[1]]) : []
      definiteStores(stmts, 0, p0.name, assigned, seen)
    }
  }
  const noteDefinite = (list, from) => {
    const d = list[from]
    if (!Array.isArray(d) || (d[0] !== 'let' && d[0] !== 'const') || d.length !== 2 || !Array.isArray(d[1]) || d[1][0] !== '=' || typeof d[1][1] !== 'string') return
    const name = d[1][1], lit = d[1][2]
    if (!Array.isArray(lit) || lit[0] !== '{}' || lit.length < 2 || !lit.slice(1).every(p => Array.isArray(p) && p[0] === ':' && typeof p[1] === 'string')) return
    if (!lit.slice(1).some(p => isNullishLit(p[2]))) return
    const assigned = new Set()
    definiteStores(list, from + 1, name, assigned, new Set())
    if (assigned.size) definite.set(lit, assigned)
  }

  const decl = (n) => { for (let i = 1; i < n.length; i++) { const d = n[i]; if (typeof d === 'string') raise(kinds, d, NULLISH); else if (Array.isArray(d) && d[0] === '=') { if (typeof d[1] === 'string') raise(kinds, d[1], expr(d[2])); else { escape(expr(d[2])); pattern(d[1]) } } } }
  const pattern = (p) => { if (typeof p === 'string') raise(kinds, p, ANY); else if (Array.isArray(p)) for (let i = 1; i < p.length; i++) pattern(Array.isArray(p[i]) && p[i][0] === ':' ? p[i][2] : Array.isArray(p[i]) && p[i][0] === '=' ? p[i][1] : p[i]) }

  // The bindings this walk assigns: parameters, declared names, loop
  // variables, catch parameters. Every other name is ANY from the start.
  const modelled = new Set()
  const collect = (n) => {
    if (!Array.isArray(n)) return
    const op = n[0]
    if (op === 'let' || op === 'const' || op === 'var') for (let i = 1; i < n.length; i++) { const d = n[i]; if (typeof d === 'string') modelled.add(d); else if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') modelled.add(d[1]) }
    else if (op === '=>') for (const p of paramNames(n[1])) if (p != null) modelled.add(p)
    else if (op === 'for-of' || op === 'for-in' || op === 'for-await') { const t = Array.isArray(n[1]) && (n[1][0] === 'let' || n[1][0] === 'const' || n[1][0] === 'var') ? n[1][1] : n[1]; if (typeof t === 'string') modelled.add(t) }
    else if (op === 'catch' && typeof n[1] === 'string') modelled.add(n[1])
    for (let i = 1; i < n.length; i++) collect(n[i])
  }
  for (const f of funcs) { for (const p of f.sig.params) modelled.add(p.name); if (f.rest) modelled.add(f.rest); collect(f.body) }
  collect(ast)

  let current = null  // the result key of the function being walked
  const stmt = (n) => {
    if (n == null) return
    if (typeof n === 'string') { expr(n); return }
    if (!Array.isArray(n)) return
    const op = n[0]
    if (op === 'let' || op === 'const' || op === 'var') return decl(n)
    if (op === 'return') { if (current != null) raise(results, current, n.length > 1 ? expr(n[1]) : NULLISH); return }
    if (op === ';' || op === '{}') { for (let i = 1; i < n.length; i++) { noteDefinite(n, i); stmt(n[i]) } return }
    if (op === 'for') { loopAssigns(n); stmt(n[1]); expr(n[2]); expr(n[3]); stmt(n[4]); return }
    if (op === 'for-of' || op === 'for-in' || op === 'for-await') {
      loopAssigns(n)
      const it = expr(n[2]), target = Array.isArray(n[1]) && (n[1][0] === 'let' || n[1][0] === 'const' || n[1][0] === 'var') ? n[1][1] : n[1]
      if (typeof target === 'string') raise(kinds, target, op === 'for-in' ? STRING : tagOf(it) === K.ARRAY ? elemOf(it) : tagOf(it) === K.TYPED ? NUMBER : tagOf(it) === K.STRING ? STRING : ANY)
      else pattern(target)
      stmt(n[3]); return
    }
    if (op === 'if') { expr(n[1]); stmt(n[2]); stmt(n[3]); return }
    if (op === 'while' || op === 'do') { loopAssigns(n); expr(n[1]); stmt(n[2]); return }
    if (op === 'try') { for (let i = 1; i < n.length; i++) stmt(Array.isArray(n[i]) && n[i][0] === 'catch' ? (typeof n[i][1] === 'string' && raise(kinds, n[i][1], ANY), n[i][2]) : n[i]); return }
    if (op === 'throw') { escapeObject(expr(n[1])); return }
    if (op === 'delete') {
      // Prepared as `['delete', receiver, key]`. A static key on a fixed shape
      // is rejected downstream; a computed key may remove any slot.
      const r = expr(n[1]), k = expr(n[2])
      if (tagOf(r) === K.OBJECT || tagOf(r) === K.ANY) poisonAll(r, k)
      return
    }
    if (op === 'switch') { expr(n[1]); for (let i = 2; i < n.length; i++) stmt(n[i]); return }
    if (op === 'case') { expr(n[1]); for (let i = 2; i < n.length; i++) stmt(n[i]); return }
    if (op === 'label') { stmt(n[2]); return }
    if (op === 'break' || op === 'continue' || op === 'default') return
    if (op === 'export') { for (let i = 1; i < n.length; i++) stmt(n[i]); return }
    expr(n)
  }
  // `['{}', …]` is an object literal when every child is a property (`[':', k, v]`,
  // a shorthand name, a spread); a block holds statements.
  const isLiteral = (n) => n.length > 1 && n.slice(1).every(p => typeof p === 'string' || (Array.isArray(p) && (p[0] === ':' || p[0] === '...')))
  const isBlock = (body) => Array.isArray(body) && body[0] === '{}' && !isLiteral(body)
  // The parameters whose reads, so far in the walk, precede every reassignment
  // of them: a straight-line read sees the incoming kind. A loop that assigns a
  // parameter ends the region at its head (a read may follow the previous
  // iteration's store); a closure's body sees the join (it runs whenever).
  let pre = new Set()
  const assignsIn = (n, names, out) => {
    if (!Array.isArray(n)) return
    if (MUTATE_OPS.has(n[0]) && typeof n[1] === 'string' && names.has(n[1])) out.add(n[1])
    for (let i = 1; i < n.length; i++) assignsIn(n[i], names, out)
  }
  const loopAssigns = (n) => { if (pre.size) { const out = new Set(); assignsIn(n, pre, out); for (const name of out) pre.delete(name) } }
  const walkFunction = (key, body, params) => {
    const outer = current, outerPre = pre
    current = key
    pre = new Set()
    if (params) { const own = new Set(params.filter(p => p != null)); assignsIn(body, own, pre) }
    if (isBlock(body)) {
      stmt(body)
      const last = body.length > 1 && Array.isArray(body[1]) && body[1][0] === ';' ? body[1][body[1].length - 1] : body[1]
      if (!(Array.isArray(last) && last[0] === 'return')) raise(results, key, NULLISH)
    } else raise(results, key, expr(body))
    current = outer
    pre = outerPre
  }

  /** The kind of an expression, read from the settled summary: a name, a
   *  property chain, an element read, a literal or a call to a known
   *  function; anything else is ANY. No effects. */
  const kindOfExpr = (n) => {
    if (typeof n === 'string') return kinds.get(n) ?? (funcByName.has(n) ? kind(K.CLOSURE) : modelled.has(n) ? K.NONE : ANY)
    if (typeof n === 'number') return NUMBER
    if (!Array.isArray(n)) return ANY
    const op = n[0]
    if (op == null) return literalKind(n[1])
    if (op === 'str' || op === 'strcat' || op === '`') return STRING
    if (op === 'bool') return BOOL
    if (op === 'bigint') return BIGINT
    if (op === '//') return kind(K.REGEX)
    if (op === '=>') { const id = closures.get(n); return id === undefined ? kind(K.CLOSURE) : kind(K.CLOSURE, id) }
    if (op === '()' && n.length === 2) return kindOfExpr(n[1])
    if (op === '.' || op === '?.') {
      const r = kindOfExpr(n[1]), t = tagOf(r)
      if (typeof n[2] !== 'string') return ANY
      if (t === K.OBJECT && paramOf(r) !== UNKNOWN) {
        const i = schemas[paramOf(r)].indexOf(n[2])
        if (i >= 0) return slots(paramOf(r))[i]
        const getter = classMember(r, n[2] + ACCESSOR_GET), fn = getter ?? (classMember(r, n[2]) ? classMember(r, n[2]) + BIND : null)
        return fn && !memberMayBeOwn(n[2]) ? results.get(fn) ?? ANY : fn || memberMayBeOwn(n[2]) ? ANY : NULLISH
      }
      return NUMBER_METHODS.has(n[2]) && (t === K.ARRAY || t === K.TYPED || t === K.STRING || t === K.MAP || t === K.SET) ? NUMBER : ANY
    }
    if (op === '[]') {
      const r = kindOfExpr(n[1]), t = tagOf(r)
      if (Array.isArray(n[2]) && n[2][0] == null && typeof n[2][1] === 'string') return kindOfExpr(['.', n[1], n[2][1]])
      return t === K.TYPED ? NUMBER : t === K.ARRAY ? orNull(elemOf(r)) : t === K.STRING ? STRING : ANY
    }
    if (op === '()' && typeof n[1] === 'string') {
      if (funcByName.has(n[1])) return results.get(n[1]) ?? ANY
      const k = kinds.get(n[1])
      if (k !== undefined) return tagOf(k) === K.CLOSURE && paramOf(k) !== UNKNOWN ? results.get(paramOf(k)) ?? ANY : ANY
      return imports.has(n[1]) ? kindOfVal(imports.get(n[1])) : call(n[1], [])  // a constructor or builtin: no effect on no arguments
    }
    if (op === '()' && Array.isArray(n[1]) && (n[1][0] === '.' || n[1][0] === '?.') && typeof n[1][2] === 'string') {
      const r = kindOfExpr(n[1][1]), fn = classMember(r, n[1][2])
      return fn && !memberMayBeOwn(n[1][2]) ? results.get(fn) ?? ANY : ANY
    }
    return ANY
  }

  // Numeric demand: a binding or slot is numeric-demanded when every read
  // of it converts: a ToNumber read (an arithmetic or bitwise operand, a
  // compound assignment other than `+=`, a relational compare against a
  // number, a `Math` argument, a typed-array store) or a flow into a demanded
  // binding or slot (an argument, a store, a copy). It is numeric-compatible
  // when its other reads are those of a number that JS would not convert
  // another kind at: a `+` operand (a string concatenates), a relational
  // compare against an unknown (two strings compare as strings), an equality
  // against a number, the tested arm of `??`. An index is neither: `a[k]`
  // converts `k` to a property key, and `a['1.0']` is no element; nor is a
  // typed-array constructor's argument, which copies an array. A demanded or
  // compatible parameter of an exported function arrives as f64 (spec/
  // boundary.md): for a demanded one the host's ToNumber is the coercion the
  // program would have applied at each use; for a compatible one it is the
  // guarded ABI's numeric contract, the one divergence the tier report names
  // per function. A parameter with no read at all stays ANY, its value
  // resting where the host may read it back. A slot read through a receiver
  // of unknown shape may be any slot of that name.
  const numeric = new Map()   // binding name or `sid\0prop` → NUM: every read converts; COMPAT: or is a `+` operand; false: one read is neither
  const OTHER = 0, COMPAT = 1, NUM = 2, FLOW = 3, NEUTRAL = 4   // NEUTRAL: a read that is no evidence
  const isNumeric = (key) => numeric.get(key) === NUM
  const isCompatible = (key) => numeric.get(key) >= COMPAT
  const slotKey = (sid, prop) => sid + '\0' + prop
  const slotKeysOf = (recv, prop) => {
    const r = kindOfExpr(recv), t = tagOf(r)
    if (t === K.OBJECT && paramOf(r) !== UNKNOWN) return schemas[paramOf(r)].indexOf(prop) >= 0 ? [slotKey(paramOf(r), prop)] : []
    return (byProp.get(prop) ?? []).map(([sid]) => slotKey(sid, prop))
  }
  let demandChanged = false
  const deny = (key) => { if (numeric.get(key) !== false) { numeric.set(key, false); demandChanged = true } }
  /** A read at `level` (NUM or COMPAT): the key holds the weakest level of its reads. */
  const mark = (key, level) => { const cur = numeric.get(key); if (cur === false) return; const next = cur === undefined ? level : Math.min(cur, level); if (next !== cur) { numeric.set(key, next); demandChanged = true } }
  /** What a flow into `into` (a key, or every key of a list) demands: false once any is denied, the weakest level when all are marked. */
  const demandOf = (into) => {
    if (typeof into === 'string') return numeric.get(into)
    let level = NUM
    for (const k of into) { const v = numeric.get(k); if (v === false) return false; if (v === undefined) return undefined; if (v < level) level = v }
    return level
  }
  /** The context `cx` (FLOW resolved through `into`), no stronger than `level`. */
  const atMost = (level, cx, into) => { const l = cx === FLOW ? demandOf(into) : cx; return l === undefined || l === false ? l : Math.min(l, level) }
  const useOf = (n, cx, into) => {
    // `n` is read in context `cx`; `into` names the key(s) it flows into under FLOW.
    const keys = typeof n === 'string' ? (modelled.has(n) ? [n] : []) : Array.isArray(n) && (n[0] === '.' || n[0] === '?.') && typeof n[2] === 'string' ? slotKeysOf(n[1], n[2]) : null
    if (keys === null) { demand(n, cx, into); return }
    if (Array.isArray(n)) demand(n[1], OTHER)
    const level = cx === FLOW ? demandOf(into) : cx
    if (level === NEUTRAL) return
    for (const key of keys) if (level === OTHER || level === false) deny(key); else if (level !== undefined) mark(key, level)
  }
  const isStringExpr = (e) => tagOf(kindOfExpr(e)) === K.STRING
  const isNumberExpr = (e) => typeof e === 'number' || (Array.isArray(e) && ((e[0] == null && typeof e[1] === 'number') || NUMBER_OPS.has(e[0]) || e[0] === 'u-' || e[0] === 'u+' || (e[0] === '.' && e[2] === 'length'))) || tagOf(kindOfExpr(e)) === K.NUMBER
  const demand = (n, cx = OTHER, into = null) => {
    if (n == null || typeof n === 'number') return
    if (typeof n === 'string') { useOf(n, cx, into); return }
    if (!Array.isArray(n)) return
    const op = n[0]
    if (op == null || op === 'str' || op === 'bool' || op === 'nan') return
    if (op === '=>') { demand(n[2]); return }
    if (op === '.' || op === '?.') { if (typeof n[2] === 'string') useOf(n, cx, into); else { demand(n[1]); demand(n[2]) } return }
    if (op === '{}' && isLiteral(n)) {
      // A literal's value flows into its slot; a shorthand `{ g }` reads `g`.
      const shape = literalShape(n)
      const sid = shape ? sidByKey.get(schemaKey(shape.props, shape.brand)) : undefined
      for (let i = 1; i < n.length; i++) {
        const p = n[i], key = typeof p === 'string' ? p : p[0] === ':' ? p[1] : null, value = typeof p === 'string' ? p : p[0] === ':' ? p[2] : p[1]
        if (sid !== undefined && typeof key === 'string' && !isBrand(key)) useOf(value, FLOW, slotKey(sid, key)); else demand(value)
      }
      return
    }
    if (op === 'let' || op === 'const' || op === 'var') { for (let i = 1; i < n.length; i++) { const d = n[i]; if (Array.isArray(d) && d[0] === '=') { if (typeof d[1] === 'string') useOf(d[2], FLOW, d[1]); else demand(d[2]) } } return }
    if (op === '=') {
      const t = n[1]
      if (typeof t === 'string') { useOf(n[2], FLOW, t); return }
      if (Array.isArray(t) && t[0] === '.' && typeof t[2] === 'string') { demand(t[1]); const keys = slotKeysOf(t[1], t[2]); if (keys.length) useOf(n[2], FLOW, keys); else demand(n[2]); return }
      if (Array.isArray(t) && t[0] === '[]') { const r = kindOfExpr(t[1]); demand(t[1]); demand(t[2]); demand(n[2], tagOf(r) === K.TYPED && !(paramOf(r) & 16) ? NUM : OTHER); return }
      demand(t); demand(n[2]); return
    }
    // `+` and `+=` convert a number, a boolean or a nullish operand and concatenate a string; against a string operand the other is a string.
    if (op === '+=') { const str = isStringExpr(n[1]) || isStringExpr(n[2]); useOf(n[1], str ? OTHER : COMPAT); useOf(n[2], str ? OTHER : COMPAT); return }
    if (MUTATE_OPS.has(op)) { useOf(n[1], NUM); if (n[2] !== undefined) useOf(n[2], NUM); return }
    if (NUMBER_OPS.has(op) || op === 'u-' || op === 'u+') { for (let i = 1; i < n.length; i++) useOf(n[i], NUM); return }
    if (op === '+') { useOf(n[1], isStringExpr(n[2]) ? OTHER : COMPAT); useOf(n[2], isStringExpr(n[1]) ? OTHER : COMPAT); return }
    // A relational compare converts against a number; two strings compare as strings, so an unknown pair is compatible.
    if (op === '<' || op === '<=' || op === '>' || op === '>=') { const cxOf = (o) => isStringExpr(o) ? OTHER : isNumberExpr(o) ? NUM : COMPAT; useOf(n[1], cxOf(n[2])); useOf(n[2], cxOf(n[1])); return }
    if (op === '[]') { useOf(n[1], OTHER); demand(n[2]); return }
    // A value-carrying operator reads its arms in the context of its own read;
    // `??` tests its left arm for nullish, which ToNumber would make NaN.
    if (op === '?' || op === '?:') { demand(n[1]); useOf(n[2], cx, into); useOf(n[3], cx, into); return }
    if (op === '&&' || op === '||') { useOf(n[1], cx, into); useOf(n[2], cx, into); return }
    if (op === '??') { useOf(n[1], atMost(COMPAT, cx, into)); useOf(n[2], cx, into); return }
    // Equality against a number converts nothing: a compatible read, the number the host must pass.
    if (op === '==' || op === '!=' || op === '===' || op === '!==') { useOf(n[1], isNumberExpr(n[2]) ? COMPAT : OTHER); useOf(n[2], isNumberExpr(n[1]) ? COMPAT : OTHER); return }
    if (op === ',') { for (let i = 1; i < n.length - 1; i++) demand(n[i]); useOf(n[n.length - 1], cx, into); return }
    if (op === '()' && n.length === 2) { useOf(n[1], cx, into); return }
    if (op === '()') {
      const callee = n[1], as = args(n[2])
      if (typeof callee === 'string') {
        // Math takes numbers, except sumPrecise, which takes an iterable.
        if ((callee.startsWith('Math.') || callee.startsWith('math.')) && !callee.endsWith('.sumPrecise')) { for (const a of as) useOf(a, NUM); return }
        const f = funcByName.get(callee)
        if (f && !escaped.has(callee)) { as.forEach((a, i) => { const p = f.sig.params[i]; if (p && !p.rest) useOf(a, FLOW, p.name); else demand(a) }); return }
        const ck = kinds.get(callee)
        if (ck !== undefined && tagOf(ck) === K.CLOSURE && paramOf(ck) !== UNKNOWN && !escaped.has(paramOf(ck))) { as.forEach((a, i) => { const p = closureParams[paramOf(ck)][i]; if (p != null) useOf(a, FLOW, p); else demand(a) }); return }
        // `new Float64Array(x)` sizes by a number and copies an array: the
        // argument is no evidence either way (a parameter read only there
        // stays ANY, the host's array copies); a view's offset and length are
        // numbers.
        if (TYPED_CTOR.test(callee) || callee === 'new.ArrayBuffer') { as.forEach((a, i) => useOf(a, i === 0 ? NEUTRAL : NUM)); return }
      } else demand(callee)
      for (const a of as) demand(a)
      return
    }
    for (let i = 1; i < n.length; i++) demand(n[i])
  }
  const seedable = new Set()   // exported parameters the demand may seed NUMBER
  for (const f of funcs) if (exported(f)) for (const p of f.sig.params) if (!p.rest && !f.defaults?.[p.name]) seedable.add(p.name)

  // Each round walks the whole program; a round without a change is the
  // fixpoint. Every key rises through a lattice of finite height, so the
  // rounds are bounded; a bound this far above any program is a bug.
  const rounds = (step) => { for (let round = 0; ; round++) { if (round === 10000) throw new Error('summary: no fixpoint'); if (!step()) return } }
  const fixpoint = () => rounds(() => {
    changed = false
    for (const f of funcs) {
      if (f.rest) raise(kinds, f.rest, kind(K.ARRAY))
      if (f.defaults) for (const p in f.defaults) bindParam(p, expr(f.defaults[p]))
      if (escaped.has(f.name)) for (const p of f.sig.params) bindParam(p.name, ANY)
      walkFunction(f.name, f.body, f.sig.params.map(p => p.rest ? null : p.name))
    }
    for (let id = 0; id < closureBodies.length; id++) {
      if (escaped.has(id)) for (const p of closureParams[id]) if (p != null) bindParam(p, ANY)
      walkFunction(id, closureBodies[id], closureParams[id])
    }
    current = null
    stmt(ast)
    return changed
  })
  // What the host may pass: an exported function's parameters.
  const seed = (numeric) => {
    for (const f of funcs) if (exported(f)) for (const p of f.sig.params) bindParam(p.name, numeric.includes(p.name) ? NUMBER : ANY)
  }
  seed([])
  fixpoint()
  // The demand pass, then the kinds again with the demanded and compatible
  // exported parameters NUMBER. A numeric-demanded parameter is read only
  // where a string would be converted anyway, so the f64 boundary is the
  // program's own coercion; a compatible one is also a `+` operand, and the
  // wrapper rejects the string or object JS would have concatenated; a
  // parameter that also flows to the host stays ANY.
  rounds(() => {
    demandChanged = false
    for (const f of funcs) demand(f.body)
    for (const b of closureBodies) demand(b)
    demand(ast)
    return demandChanged
  })
  const seeded = [...seedable].filter(p => isCompatible(p) && tagOf(kinds.get(p) ?? K.NONE) === K.ANY)
  if (seeded.length) {
    kinds.clear(); incoming.clear(); fields.clear(); results.clear(); escaped.clear(); for (let i = 0; i < elems.length; i++) elems[i] = K.NONE
    seed(seeded)
    fixpoint()
  }

  return {
    kindOf: (name) => kinds.get(name) ?? K.NONE,
    kindOfExpr,
    sidOf: (name) => { const k = kinds.get(name); return k !== undefined && tagOf(k) === K.OBJECT && !isNullable(k) && paramOf(k) !== UNKNOWN ? paramOf(k) : null },
    fieldKind: (sid, prop) => { const i = schemas[sid]?.indexOf(prop); return i == null || i < 0 ? K.NONE : fields.get(sid)?.[i] ?? K.NONE },
    /** The slot's value kind (reps.js VAL) when one kind holds under every construction and store, else null. */
    fieldVal: (sid, prop) => { const i = schemas[sid]?.indexOf(prop); return i == null || i < 0 ? null : valOf(fields.get(sid)?.[i] ?? K.NONE) },
    /** The typed-array constructor a binding holds under every assignment, or null. */
    typedCtorOf: (name) => { const k = kinds.get(name) ?? K.NONE; return tagOf(k) === K.TYPED && paramOf(k) !== UNKNOWN && !isNullable(k) ? ctorFromElemAux(paramOf(k)) : null },
    /** The typed-array constructor a slot holds under every construction and store, or null. */
    fieldTypedCtor: (sid, prop) => { const i = schemas[sid]?.indexOf(prop); const k = i == null || i < 0 ? K.NONE : fields.get(sid)?.[i] ?? K.NONE; return tagOf(k) === K.TYPED && paramOf(k) !== UNKNOWN && !isNullable(k) ? ctorFromElemAux(paramOf(k)) : null },
    resultOf: (name) => results.get(name) ?? K.NONE,
    /** The result's value kind (reps.js VAL) when its returns join to one non-nullable kind, else null. */
    resultVal: (name) => valOf(results.get(name) ?? K.NONE),
    /** The one schema every element of the binding's array has, or null. */
    arrayElemSidOf: (name) => { const k = kinds.get(name); if (k === undefined || tagOf(k) !== K.ARRAY || paramOf(k) === UNKNOWN) return null; const e = elems[paramOf(k)]; return tagOf(e) === K.OBJECT && !isNullable(e) && paramOf(e) !== UNKNOWN ? paramOf(e) : null },
    /** The binding has a ToNumber read or a flow into a demanded key, and no other read. */
    numericDemand: (name) => modelled.has(name) && isNumeric(name),
    /** Some object may carry an own property `prop` stored under that literal name, shadowing a class member. */
    memberMayBeOwn: (prop) => dynamicProps.has(prop),
    /** Some slot holds a typed array under every construction and store. */
    hasTypedFields: [...fields.values()].some(a => a.some(k => tagOf(k) === K.TYPED && paramOf(k) !== UNKNOWN && !isNullable(k))),
    escaped,
  }
}
