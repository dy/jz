/**
 * The program summary: one kind per binding, per schema slot, per function
 * result, computed once over the prepared program by a fixpoint before any
 * per-function analysis runs. A kind is a set of tags
 *
 *   NUMBER STRING BOOL BIGINT NULLISH ABSENT TYPED(elem) ARRAY(cell)
 *   OBJECT(sid) CLOSURE(id) MAP SET DATE REGEX HASH BUFFER
 *
 * with one parameter when the set names one tag besides the nullish pair:
 * the typed array's element type, the array's element cell, the object's
 * schema, the closure's identity. NULLISH is a nullish value the program
 * holds (a literal, a missing argument, a bare return); ABSENT a nullish the
 * program does not mean to read (a binding before its assignment, an element
 * past the array's end), which the reps carry as presence (`mayBeUndefined`)
 * beside the kind rather than in place of it. NONE is the empty set, ANY
 * every tag. A join is the union; a parameter survives it when both sides
 * agree, and two arrays joined share one element cell from then on. Joins are
 * flow-insensitive: a binding's kind is the join of everything assigned to
 * it, a slot's kind the join of every construction and store, a parameter's
 * kind the join of every argument at every direct call, a result the join
 * of every return. A binding is keyed by the function that declares it (a
 * specialized variant declares its own), a module global by its name alone;
 * a reader names its scope by the function body (`at(body)`). What the
 * summary cannot see is ANY: an exported
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
  OBJECT: 8, CLOSURE: 9, MAP: 10, SET: 11, DATE: 12, REGEX: 13, HASH: 14, BUFFER: 15, ABSENT: 16, ANY: 17,
}
// A kind packs its tag set above its parameter: bit `PARAM_BITS + tag - 1`
// for each of the 16 tags (the top bit included: a kind is an int32), the
// parameter below. The parameter is UNKNOWN unless the set names one tag
// besides the nullish pair.
const PARAM_BITS = 16
/** The parameter of a kind whose parameter is not known (any schema, any element, any closure). */
export const UNKNOWN = (1 << PARAM_BITS) - 1
const bitOf = (tag) => 1 << (PARAM_BITS + tag - 1)
const TAGS = ~UNKNOWN, NULL_BITS = bitOf(K.NULLISH) | bitOf(K.ABSENT), TAGS_NOT_NULL = TAGS & ~NULL_BITS
export const kind = (tag, param = UNKNOWN) => tag === K.NONE ? 0 : tag === K.ANY ? TAGS | UNKNOWN : bitOf(tag) | (param & UNKNOWN)
/** The one tag of a kind: NONE for the empty set, NULLISH or ABSENT for a nullish set, ANY for two tags or more besides those. */
export const tagOf = (k) => { const m = k & TAGS_NOT_NULL; return m === 0 ? (k & bitOf(K.NULLISH) ? K.NULLISH : k & bitOf(K.ABSENT) ? K.ABSENT : K.NONE) : (m & (m - 1)) !== 0 ? K.ANY : 32 - Math.clz32(m) - PARAM_BITS }
export const paramOf = (k) => k & UNKNOWN
/** The kind holds a nullish beside one tag; ANY holds every tag and answers no. */
export const isNullable = (k) => (k & NULL_BITS) !== 0 && (k & TAGS_NOT_NULL) !== 0 && tagOf(k) !== K.ANY
/** The tags of a kind as a bit set (`hasTag`), the nullish pair among them. */
export const tagsOf = (k) => k & TAGS
export const hasTag = (k, tag) => (k & bitOf(tag)) !== 0
const ANY = kind(K.ANY), NUMBER = kind(K.NUMBER), STRING = kind(K.STRING), BOOL = kind(K.BOOL), BIGINT = kind(K.BIGINT), NULLISH = kind(K.NULLISH), ABSENT = kind(K.ABSENT)
/** The kind without its nullish tags. */
const core = (k) => k & ~NULL_BITS

/** The nullable form of a kind; ANY absorbs the bit, so the lattice has one top. */
export const orNull = (k) => withTag(k, K.NULLISH)
/** The kind with ABSENT beside it: a read the program does not mean to make may see undefined. */
const orAbsent = (k) => withTag(k, K.ABSENT)
const withTag = (k, tag) => tagOf(k) === K.ANY ? ANY : (k & TAGS_NOT_NULL) === 0 ? (k & TAGS) | bitOf(tag) | UNKNOWN : k | bitOf(tag)

/** The union of the tag sets; the parameter survives when the sides agree on it. */
export function join(a, b) {
  if (a === b) return a
  const m = (a | b) & TAGS, mn = m & ~NULL_BITS
  if (mn === 0) return m === 0 ? 0 : m | UNKNOWN
  if ((mn & (mn - 1)) !== 0) return m | UNKNOWN
  const pa = a & mn ? paramOf(a) : undefined, pb = b & mn ? paramOf(b) : undefined
  return m | (pa === undefined ? pb : pb === undefined || pa === pb ? pa : UNKNOWN)
}

// Builtins that read their arguments and never write a field of them; any
// other unresolved callee may store into an object it receives.
const PURE_BUILTINS = /^(Object\.(keys|values|entries|freeze|isFrozen|getOwnPropertyNames|getPrototypeOf|hasOwn|is)|JSON\.stringify|Array\.isArray|console\.\w+|Math\.\w+|Number(\.\w+)?|String(\.\w+)?|Boolean|BigInt|Symbol(\.\w+)?|isNaN|isFinite|parseInt|parseFloat|structuredClone)$/

/** The value kind (reps.js VAL) of a monomorphic, non-nullable kind; null otherwise. */
const VAL_OF = [null, VAL.NUMBER, VAL.STRING, VAL.BOOL, VAL.BIGINT, null, VAL.TYPED, VAL.ARRAY, VAL.OBJECT, VAL.CLOSURE, VAL.MAP, VAL.SET, VAL.DATE, VAL.REGEX, VAL.HASH, VAL.BUFFER, null, null]
export const valOf = (k) => isNullable(k) ? null : VAL_OF[tagOf(k)] ?? null
/** The kind of a value kind: the inverse of `valOf` for the kinds that have one; ANY for a kind the lattice has no tag for. */
export const kindOfVal = (v) => { const t = VAL_OF.indexOf(v); return v == null ? ANY : t < 0 ? ANY : kind(t) }
/** The value kinds (reps.js VAL) of every tag in the kind but NULLISH. */
export const valsOf = (k) => { const out = []; for (let t = K.NUMBER; t < K.ANY; t++) if (t !== K.NULLISH && t !== K.ABSENT && hasTag(k, t)) out.push(VAL_OF[t]); return out }
export { core }

const BIND = CLASS_T + 'bind'
const TYPED_CTOR = /^new\.(\w+Array)(\.view)?$/
const NUMBER_METHODS = new Set(['length', 'size', 'byteLength', 'byteOffset'])
// Array.prototype's members: a `.name` past these on an array is a dictionary entry the program stored.
const ARRAY_METHODS = new Set(['push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'map', 'filter', 'reduce', 'reduceRight', 'forEach', 'indexOf', 'lastIndexOf', 'includes', 'join', 'concat', 'sort', 'reverse', 'find', 'findIndex', 'findLast', 'findLastIndex', 'some', 'every', 'fill', 'flat', 'flatMap', 'at', 'entries', 'keys', 'values', 'copyWithin', 'toString', 'toSorted', 'toReversed', 'with'])
const TYPED_SAME = new Set(['subarray', 'slice', 'map', 'filter', 'fill', 'reverse', 'sort', 'copyWithin', 'set'])
const STRING_METHODS = new Set(['slice', 'substring', 'substr', 'trim', 'trimStart', 'trimEnd', 'toUpperCase', 'toLowerCase', 'padStart', 'padEnd', 'repeat', 'replace', 'replaceAll', 'concat', 'normalize', 'at', 'charAt'])
const STRING_NUMBER_METHODS = new Set(['charCodeAt', 'codePointAt', 'indexOf', 'lastIndexOf', 'search', 'localeCompare'])
const NUMBER_OPS = new Set(['-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>', '~', '++', '--'])
const BOOL_OPS = new Set(['<', '<=', '>', '>=', '==', '!=', '===', '!==', '!', 'in', 'instanceof'])

/** Summarize the prepared program: `ast` the entry module's statements and `inits` the bundled
 *  modules' (run first), `funcs` the function records, `schemas` the schema prop lists, `imports`
 *  the host imports by alias with the result kind each declares (reps.js VAL, or null),
 *  `hostGlobals` the module globals the host reads. An exported global keeps its kind: the host
 *  can store only a number through its f64 export, which a number global takes and no other
 *  kind could take; a closure the host can reach through it may be called with anything. */
export function summarize(ast, { inits = [], funcs, schemas, brandOf, classes, exported, imports, hostGlobals = [] }) {
  const tops = [...inits, ast]
  const kinds = new Map()            // binding key (keyOf) → kind
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
  // Two closures joined are a closure set (a dispatch table's members, an
  // array of handlers): a call through the join calls each member. The
  // set's id is interned above SET_BASE; `membersOf` reads either form. A
  // set past SET_MAX members escapes them all instead.
  const SET_BASE = 1 << 15, SET_MAX = 32
  const closureSets = [], closureSetIds = new Map()
  const membersOf = (id) => id >= SET_BASE ? closureSets[id - SET_BASE] : [id]
  const closureSet = (ids) => {
    const key = ids.join(',')
    let id = closureSetIds.get(key)
    if (id === undefined) { id = SET_BASE + closureSets.length; closureSets.push(ids); closureSetIds.set(key, id) }
    return id
  }
  const unionClosures = (a, b) => {
    const ids = [...new Set([...membersOf(a), ...membersOf(b)])].sort((x, y) => x - y)
    if (ids.length > SET_MAX || SET_BASE + closureSets.length >= UNKNOWN) { for (const id of ids) escapeId(id); return UNKNOWN }
    return closureSet(ids)
  }
  // A join that loses a parameter loses what it named: a closure joined with
  // another kind is called through the join, which binds nothing, so it is
  // called from where the summary cannot see; an array joined with another
  // kind is stored to through the join. Two arrays joined share one cell
  // from then on (`unify`), so a store through either reaches both.
  const merge = (a, b) => {
    a = canon(a); b = canon(b)
    if (tagOf(a) === tagOf(b) && paramOf(a) !== UNKNOWN && paramOf(b) !== UNKNOWN && paramOf(a) !== paramOf(b) && (tagOf(a) === K.ARRAY || tagOf(a) === K.CLOSURE)) {
      const shared = tagOf(a) === K.ARRAY ? unify(paramOf(a), paramOf(b)) : unionClosures(paramOf(a), paramOf(b))
      if (shared !== UNKNOWN) { a = (a & ~UNKNOWN) | shared; b = (b & ~UNKNOWN) | shared }
    }
    const j = join(a, b)
    if (paramOf(j) === UNKNOWN) { lose(a); lose(b) }
    return j
  }
  const lose = (k) => { if (paramOf(k) !== UNKNOWN) escape(k) }
  const slots = (sid) => { let a = fields.get(sid); if (!a) fields.set(sid, a = new Array(schemas[sid].length).fill(K.NONE)); return a }
  const raise = (map, key, k) => { const old = map.get(key) ?? K.NONE; const nk = merge(old, k); if (nk !== old) { map.set(key, nk); changed = true } }
  const raiseSlot = (sid, i, k) => { const a = slots(sid); const nk = merge(a[i], k); if (nk !== a[i]) { a[i] = nk; changed = true } }
  const poisonProp = (prop) => { for (const [sid, i] of byProp.get(prop) ?? []) raiseSlot(sid, i, ANY) }
  const poisonSchema = (sid) => { const a = slots(sid); for (let i = 0; i < a.length; i++) raiseSlot(sid, i, ANY) }
  // A closure's parameter names, a default's among them (`(a, b = 1) =>`); a pattern is unnamed.
  const paramNames = (params) => extractParams(params).map(p => typeof p === 'string' ? p : Array.isArray(p) && p[0] === '=' && typeof p[1] === 'string' ? p[1] : null)
  const defaultsOf = (params) => { let d = null; for (const p of extractParams(params)) if (Array.isArray(p) && p[0] === '=' && typeof p[1] === 'string') (d ??= {})[p[1]] = p[2]; return d }
  const closureDefaults = []         // closure id → { name: default expression } or null
  const closureId = (node) => {
    let id = closures.get(node)
    if (id === undefined) { id = closureParams.length; closures.set(node, id); closureParams.push(paramNames(node[1])); closureDefaults.push(defaultsOf(node[1])); closureBodies.push(node[2]) }
    return id
  }
  // An array's element kind lives in a cell its construction site owns; every
  // store and push joins into it, so a read sees every element the program
  // can put there. Cells joined are one cell (a union-find over ids); a kind
  // names a cell by any id in it, `canon` by the root.
  const elems = []               // cell root → element kind
  const cellUp = []              // cell id → its parent; a root is its own
  const arrayCells = new Map()   // array literal node → cell id
  const cell = (id) => { while (cellUp[id] !== id) id = cellUp[id] = cellUp[cellUp[id]]; return id }
  const canon = (k) => tagOf(k) === K.ARRAY && paramOf(k) !== UNKNOWN ? (k & ~UNKNOWN) | cell(paramOf(k)) : k
  const elemOf = (k) => tagOf(k) === K.ARRAY && paramOf(k) !== UNKNOWN ? elems[cell(paramOf(k))] : ANY
  // A cell, closure or schema past the parameter's range is one the kind cannot name: it escapes.
  const arrayOf = (node, elem) => { let id = arrayCells.get(node); if (id === undefined) { id = elems.length; elems.push(elem); cellUp.push(id); arrayCells.set(node, id) } if (id >= UNKNOWN) { escape(elem); return kind(K.ARRAY) } return kind(K.ARRAY, id) }
  const raiseElem = (arr, k) => { if (tagOf(arr) !== K.ARRAY || paramOf(arr) === UNKNOWN) return; const id = cell(paramOf(arr)), nk = merge(elems[id], k); if (nk !== elems[id]) { elems[id] = nk; changed = true } }
  const unify = (a, b) => {
    a = cell(a); b = cell(b)
    if (a === b) return a
    cellUp[b] = a; changed = true
    raiseElem(kind(K.ARRAY, a), elems[b])
    const pb = cellProps.get(b); if (pb) for (const [prop, k] of pb) raiseProp(kind(K.ARRAY, a), prop, k)
    if (cellWild.has(b)) raiseWild(kind(K.ARRAY, a), cellWild.get(b))
    return a
  }
  // An array used as a dictionary (`const ctx = []; for (k in SECTION) ctx[k] = []`;
  // `ctx.type`): its string-keyed entries live beside the elements, one kind per
  // literal name and one for every computed string key (`cellWild`), which any
  // name may read. A computed key of unknown kind reaches the elements too.
  const cellProps = new Map()   // cell root → Map(name → kind)
  const cellWild = new Map()    // cell root → kind stored under a computed string key
  const propOf = (arr, prop) => { const c = cell(paramOf(arr)); return join(cellProps.get(c)?.get(prop) ?? K.NONE, cellWild.get(c) ?? K.NONE) }
  const anyPropOf = (arr) => { const c = cell(paramOf(arr)); let k = cellWild.get(c) ?? K.NONE; for (const pk of cellProps.get(c)?.values() ?? []) k = join(k, pk); return k }
  const raiseProp = (arr, prop, k) => { if (tagOf(arr) !== K.ARRAY || paramOf(arr) === UNKNOWN) return; const c = cell(paramOf(arr)); let m = cellProps.get(c); if (!m) cellProps.set(c, m = new Map()); const old = m.get(prop) ?? K.NONE, nk = merge(old, k); if (nk !== old) { m.set(prop, nk); changed = true } }
  const raiseWild = (arr, k) => { if (tagOf(arr) !== K.ARRAY || paramOf(arr) === UNKNOWN) return; const c = cell(paramOf(arr)); const old = cellWild.get(c) ?? K.NONE, nk = merge(old, k); if (nk !== old) { cellWild.set(c, nk); changed = true } }
  /** An array's entry under a key of kind `ik`: elements by a number, dictionary entries by a string, everything by an unknown key. */
  const entryOf = (arr, ik) => { const t = tagOf(ik); if (paramOf(arr) === UNKNOWN) return ANY; return t === K.NUMBER ? elemOf(arr) : t === K.STRING ? anyPropOf(arr) : t === K.NONE ? K.NONE : join(elemOf(arr), anyPropOf(arr)) }
  const raiseEntry = (arr, ik, k) => { const t = tagOf(ik); if (t === K.NUMBER) raiseElem(arr, k); else if (t === K.STRING) raiseWild(arr, k); else if (t !== K.NONE) { raiseElem(arr, k); raiseWild(arr, k) } }
  /** A value the summary no longer follows: a closure's callers become unknown, an array's elements too. */
  const escape = (k) => {
    if (tagOf(k) === K.CLOSURE && paramOf(k) !== UNKNOWN) for (const id of membersOf(paramOf(k))) escapeId(id)
    // The cell goes to ANY before its elements escape: an array of itself ends there.
    if (tagOf(k) === K.ARRAY && paramOf(k) !== UNKNOWN) { const id = cell(paramOf(k)), e = elems[id]; if (e !== ANY) { elems[id] = ANY; changed = true; escape(e) } }
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
  /** A value the host holds (an export's result, an exported global, an import's argument): every closure it reaches may be called with anything. */
  const escapeToHost = (k, seen = new Set()) => {
    const t = tagOf(k), p = paramOf(k)
    if (p === UNKNOWN) return
    if (t === K.CLOSURE) for (const id of membersOf(p)) escapeId(id)
    else if (t === K.ARRAY) { const c = cell(p); if (!seen.has(-1 - c)) { seen.add(-1 - c); escapeToHost(elems[c], seen); escapeToHost(anyPropOf(k), seen) } }
    else if (t === K.OBJECT) { if (!seen.has(p)) { seen.add(p); for (const s of slots(p)) escapeToHost(s, seen) } }
  }
  // A parameter's incoming kind, the join of its arguments alone: a read of
  // the parameter before any reassignment can run sees only this; `kinds`
  // holds the join with the reassignments too.
  const incoming = new Map()
  const bindParam = (key, k) => { raise(incoming, key, k); raise(kinds, key, k) }
  /** Bind a callee's parameters (`scope`: its name or closure id) to the argument kinds: a
   *  missing argument is nullish, or nothing when the parameter has a default (bound by the walk). */
  const bind = (scope, names, ks, defaults) => {
    for (let i = 0; i < names.length; i++) { if (names[i] != null && (i < ks.length || !defaults?.[names[i]])) bindParam(keyIn(scope, names[i]), i < ks.length ? ks[i] : NULLISH); }
    for (let i = names.length; i < ks.length; i++) escape(ks[i])
  }
  const call = (callee, argKinds) => {
    if (typeof callee === 'string') {
      const m = TYPED_CTOR.exec(callee)
      if (m) { const aux = encodeTypedElemAux(m[1], !!m[2]); return kind(K.TYPED, aux == null ? UNKNOWN : aux) }
      if (callee === 'new.RegExp') return kind(K.REGEX)
      if (callee === 'new.ArrayBuffer' || callee === 'new.SharedArrayBuffer') return kind(K.BUFFER)
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
        if (!escaped.has(callee)) bind(callee, f.sig.params.map(p => p.rest ? null : p.name), argKinds, f.defaults)
        return results.get(callee) ?? K.NONE
      }
      const key = keyOf(callee), k = kinds.get(key)
      if (k !== undefined && tagOf(k) === K.CLOSURE && paramOf(k) !== UNKNOWN) return callClosure(paramOf(k), argKinds)
      if (k === undefined && key !== null) return K.NONE  // a local callee not known yet
      // A host import returns the kind it declares; a builtin the kind its trait says (kind-traits.js).
      if (imports.has(callee)) { for (const k of argKinds) { escape(k); escapeToHost(k) } return kindOfVal(imports.get(callee)) }
      // A builtin: the kind its trait names (kind-traits.js). A `new.X` past
      // the typed constructors above is a DataView (a typed view) or unknown.
      let builtin = builtinCalleeVal(callee)
      if (builtin === VAL.TYPED && callee !== 'new.DataView') builtin = null
      if (builtin != null || PURE_BUILTINS.test(callee)) { for (const k of argKinds) escape(k); return kindOfVal(builtin) }
    }
    for (const k of argKinds) escapeObject(k)
    return ANY
  }
  /** Call a closure or each member of a closure set; the result is the join of theirs. */
  const callClosure = (param, argKinds) => {
    let r = K.NONE
    for (const id of membersOf(param)) {
      if (!escaped.has(id)) bind(id, closureParams[id], argKinds, closureDefaults[id])
      r = merge(r, results.get(id) ?? K.NONE)
    }
    return r
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
    if (t === K.TYPED) { if (TYPED_SAME.has(name)) return name === 'set' ? NULLISH : kind(K.TYPED, paramOf(recv)); if (name === 'indexOf' || name === 'lastIndexOf' || name === 'at' || name === 'reduce') return name === 'at' ? orAbsent(NUMBER) : NUMBER }
    if (t === K.STRING) { if (STRING_METHODS.has(name)) return STRING; if (STRING_NUMBER_METHODS.has(name)) return NUMBER; if (name === 'split') return kind(K.ARRAY) }
    if (t === K.BUFFER && name === 'slice') return kind(K.BUFFER)
    if (t === K.ARRAY) {
      if (name === 'push' || name === 'unshift') { for (const k of argKinds) raiseElem(recv, k); return NUMBER }
      if (name === 'indexOf' || name === 'lastIndexOf' || name === 'findIndex') { for (const k of argKinds) escape(k); return NUMBER }
      if (name === 'pop' || name === 'shift' || name === 'at' || name === 'find') { for (const k of argKinds) escape(k); return orAbsent(elemOf(recv)) }
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
  const receiver = (n) => typeof n === 'string' && funcByName.has(n) && keyOf(n) === null ? kind(K.CLOSURE) : expr(n)

  /** The kind of an expression, with its effects: calls bind parameters, stores raise slots. */
  const expr = (n) => {
    if (n == null) return NULLISH
    if (typeof n === 'number') return NUMBER
    if (typeof n === 'string') {
      const key = keyOf(n)
      if (key === null) { if (funcByName.has(n)) { escapeId(n); return kind(K.CLOSURE) } return ANY }  // a name from outside the program
      // A binding this walk models is bottom until the fixpoint reaches its assignments.
      const k = (post.has(n) ? post.get(n) : pre.has(n) ? incoming.get(key) : kinds.get(key)) ?? K.NONE
      return nonNull.has(n) ? core(k) : k
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
    if (op === '=>') { loopAssigns(n); const id = closureId(n); if (id >= UNKNOWN) { escapeId(id); return kind(K.CLOSURE) } return kind(K.CLOSURE, id) }  // a closure assigning a parameter may run any time after this
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
      if (sid >= UNKNOWN) { poisonSchema(sid); return kind(K.OBJECT) }
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
      if (NUMBER_METHODS.has(prop) && (t === K.ARRAY || t === K.TYPED || t === K.STRING || t === K.MAP || t === K.SET || t === K.BUFFER)) return NUMBER
      if (prop === 'buffer' && t === K.TYPED) return kind(K.BUFFER)
      if (t === K.ARRAY && paramOf(recv) !== UNKNOWN && !ARRAY_METHODS.has(prop)) return orAbsent(propOf(recv, prop))
      return ANY
    }
    if (op === '[]') {
      const recv = receiver(n[1]), idx = n[2], t = tagOf(recv)
      if (Array.isArray(idx) && idx[0] == null && typeof idx[1] === 'string') return expr(['.', n[1], idx[1]])
      const ik = expr(idx)
      if (t === K.NONE) return K.NONE
      if (t === K.TYPED) return paramOf(recv) !== UNKNOWN && (paramOf(recv) & 16) ? BIGINT : NUMBER
      if (t === K.ARRAY) return orAbsent(entryOf(recv, ik))
      if (t === K.STRING) return STRING
      // A computed key on a known shape reads one of its slots (a dispatch table's member), or misses.
      if (t === K.OBJECT && paramOf(recv) !== UNKNOWN) { let k = K.NONE; for (const s of slots(paramOf(recv))) k = merge(k, s); return orAbsent(k) }
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
    if (op === '&&' || op === '||' || op === '??') { const a = expr(n[1]); return merge(a, onPath(() => narrowed(proves(n[1], op === '&&'), () => expr(n[2])))) }
    if (op === '?' || op === '?:') { expr(n[1]); return onPath(() => merge(narrowed(proves(n[1], true), () => expr(n[2])), narrowed(proves(n[1], false), () => expr(n[3])))) }
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
    if (typeof target === 'string') {
      pre.delete(target); nonNull.delete(target)
      // A straight-line assignment is the value the reads after it see; one on a path is not.
      if (branch === 0 && current !== null && keyOf(target) !== null) post.set(target, v); else post.delete(target)
      const key = keyOf(target); if (key !== null) raise(kinds, key, v); return v
    }
    if (Array.isArray(target) && (target[0] === '.' || target[0] === '?.')) {
      const recv = receiver(target[1]), prop = target[2], t = tagOf(recv)
      if (t === K.NONE) return v
      if (typeof prop !== 'string') { poisonAll(recv, expr(prop)); escape(v); return v }
      if (t === K.OBJECT && paramOf(recv) !== UNKNOWN) {
        const i = schemas[paramOf(recv)].indexOf(prop), setter = i < 0 ? classMember(recv, prop + ACCESSOR_SET) : null
        if (i >= 0) raiseSlot(paramOf(recv), i, v); else if (setter) call(setter, [core(recv), v]); else { poisonSchema(paramOf(recv)); dynamicProps.add(prop) }
      }
      else if (t === K.ARRAY) { if (paramOf(recv) !== UNKNOWN) raiseProp(recv, prop, v); else escape(v) }
      else if (t !== K.TYPED && t !== K.STRING && t !== K.MAP && t !== K.SET) { callCandidates(recv, prop + ACCESSOR_SET, [v]); poisonProp(prop); dynamicProps.add(prop); escape(v) }
      return v
    }
    if (Array.isArray(target) && target[0] === '[]') {
      const recv = receiver(target[1]), idx = target[2], t = tagOf(recv)
      if (Array.isArray(idx) && idx[0] == null && typeof idx[1] === 'string') return assign(op, ['.', target[1], idx[1]], value)
      const ik = expr(idx)
      if (t === K.ARRAY) { if (paramOf(recv) !== UNKNOWN) raiseEntry(recv, ik, v); else escape(v) }
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

  const declare = (name, k) => { const key = keyOf(name); if (key !== null) raise(kinds, key, k) }
  // A declaration without a value is absent until assigned (`let buf; export
  // const setup = () => buf = new Float64Array(n)`: a read before `setup` is one
  // the program does not mean to make).
  const decl = (n) => { for (let i = 1; i < n.length; i++) { const d = n[i]; if (typeof d === 'string') declare(d, ABSENT); else if (Array.isArray(d) && d[0] === '=') { if (typeof d[1] === 'string') declare(d[1], expr(d[2])); else { escape(expr(d[2])); pattern(d[1]) } } } }
  const pattern = (p) => { if (typeof p === 'string') declare(p, ANY); else if (Array.isArray(p)) for (let i = 1; i < p.length; i++) pattern(Array.isArray(p[i]) && p[i][0] === ':' ? p[i][2] : Array.isArray(p[i]) && p[i][0] === '=' ? p[i][1] : p[i]) }

  // Scopes: a function (its name), a closure (its id) or the module (null).
  // A scope declares its parameters, its `let`/`const`/`var` names, loop
  // variables and catch parameters; a closure's parent is the scope its
  // literal sits in. A binding's key is its scope and name; a name no scope
  // in the chain declares is the module's, and one the module does not
  // declare either is from outside the program (null).
  const declared = new Map()         // scope → Set of names
  const parent = new Map()           // closure id → scope
  const scopeOfSig = new Map(funcs.map(f => [f.sig, f.name]))   // a function's signature record → its scope, for readers
  const scopeOfParams = new Map()    // a closure's parameter node (its stable identity through emission) → its id
  const MODULE = ''
  const nameScopes = new Map()       // name → the scopes declaring it (one, or a function and its specialized variants)
  const declareIn = (scope, name) => { let d = declared.get(scope); if (!d) declared.set(scope, d = new Set()); if (!d.has(name)) { d.add(name); let ns = nameScopes.get(name); if (!ns) nameScopes.set(name, ns = []); ns.push(scope) } }
  const collect = (n, scope) => {
    if (!Array.isArray(n)) return
    const op = n[0]
    if (op === 'let' || op === 'const' || op === 'var') for (let i = 1; i < n.length; i++) { const d = n[i]; if (typeof d === 'string') declareIn(scope, d); else if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') declareIn(scope, d[1]) }
    else if (op === '=>') {
      const id = closureId(n)
      parent.set(id, scope); scopeOfParams.set(n[1], id)
      for (const p of paramNames(n[1])) if (p != null) declareIn(id, p)
      collect(n[2], id)
      return
    }
    else if (op === 'for-of' || op === 'for-in' || op === 'for-await') { const t = Array.isArray(n[1]) && (n[1][0] === 'let' || n[1][0] === 'const' || n[1][0] === 'var') ? n[1][1] : n[1]; if (typeof t === 'string') declareIn(scope, t) }
    else if (op === 'catch' && typeof n[1] === 'string') declareIn(scope, n[1])
    for (let i = 1; i < n.length; i++) collect(n[i], scope)
  }
  for (const f of funcs) { for (const p of f.sig.params) declareIn(f.name, p.name); if (f.rest) declareIn(f.name, f.rest); collect(f.body, f.name) }
  for (const top of tops) collect(top, MODULE)
  const keyIn = (scope, name) => scope === MODULE ? name : scope + '\0' + name
  /** The key of `name` read in `current`'s scope chain, or null for a name from outside the program. */
  const keyOf = (name) => {
    for (let s = current ?? MODULE; ; s = parent.get(s) ?? MODULE) {
      if (declared.get(s)?.has(name)) return keyIn(s, name)
      if (s === MODULE) return null
    }
  }

  let current = null  // the scope (and result key) of the function being walked; null at module scope
  const stmt = (n) => {
    if (n == null) return
    if (typeof n === 'string') { expr(n); return }
    if (!Array.isArray(n)) return
    const op = n[0]
    if (op === 'let' || op === 'const' || op === 'var') return decl(n)
    if (op === 'return') { if (current != null) raise(results, current, n.length > 1 ? expr(n[1]) : NULLISH); return }
    if (op === ';' || op === '{}') {
      // A guard that leaves (`if (x == null) return`) proves its names for the statements after it.
      const added = []
      for (let i = 1; i < n.length; i++) {
        noteDefinite(n, i); stmt(n[i])
        const st = n[i]
        if (Array.isArray(st) && st[0] === 'if' && st[3] == null && exits(st[2])) for (const name of proves(st[1], false)) if (!nonNull.has(name)) { nonNull.add(name); added.push(name) }
      }
      for (const name of added) nonNull.delete(name)
      return
    }
    if (op === 'for') { loopAssigns(n); stmt(n[1]); onPath(() => { expr(n[2]); expr(n[3]); stmt(n[4]) }); return }
    if (op === 'for-of' || op === 'for-in' || op === 'for-await') {
      loopAssigns(n)
      const it = expr(n[2]), target = Array.isArray(n[1]) && (n[1][0] === 'let' || n[1][0] === 'const' || n[1][0] === 'var') ? n[1][1] : n[1]
      if (typeof target === 'string') declare(target, op === 'for-in' ? STRING : tagOf(it) === K.ARRAY ? elemOf(it) : tagOf(it) === K.TYPED ? NUMBER : tagOf(it) === K.STRING ? STRING : ANY)
      else pattern(target)
      onPath(() => stmt(n[3])); return
    }
    if (op === 'if') { expr(n[1]); onPath(() => { narrowed(proves(n[1], true), () => stmt(n[2])); narrowed(proves(n[1], false), () => stmt(n[3])) }); return }
    if (op === 'while' || op === 'do') { loopAssigns(n); onPath(() => { expr(n[1]); stmt(n[2]) }); return }
    if (op === 'try') { onPath(() => { for (let i = 1; i < n.length; i++) stmt(Array.isArray(n[i]) && n[i][0] === 'catch' ? (typeof n[i][1] === 'string' && declare(n[i][1], ANY), n[i][2]) : n[i]) }); return }
    if (op === 'throw') { escapeObject(expr(n[1])); return }
    if (op === 'delete') {
      // Prepared as `['delete', receiver, key]`. A static key on a fixed shape
      // is rejected downstream; a computed key may remove any slot.
      const r = expr(n[1]), k = expr(n[2])
      if (tagOf(r) === K.OBJECT || tagOf(r) === K.ANY) poisonAll(r, k)
      return
    }
    if (op === 'switch') { expr(n[1]); onPath(() => { for (let i = 2; i < n.length; i++) stmt(n[i]) }); return }
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
  // The bindings a straight-line assignment of the function's own body gave a
  // value (`x = +x` at entry; `s = String(s)`): the reads after it see that
  // kind alone. An assignment on a path (a branch, a loop body, an arm) ends
  // the region, as does a loop that assigns the name, at its head.
  let post = new Map()
  let branch = 0            // the depth of paths (branches, loop bodies, arms) the walk is in
  const onPath = (fn) => { branch++; try { return fn() } finally { branch-- } }
  const assignsIn = (n, names, out) => {
    if (!Array.isArray(n)) return
    if (MUTATE_OPS.has(n[0]) && typeof n[1] === 'string' && names.has(n[1])) out.add(n[1])
    for (let i = 1; i < n.length; i++) assignsIn(n[i], names, out)
  }
  const loopAssigns = (n) => { for (const set of [pre, nonNull, post]) if (set.size) { const out = new Set(); assignsIn(n, set, out); for (const name of out) set.delete(name) } }
  // Nullish narrowing: the names a path proves non-nullish. A condition proves
  // them when true (`x`, `x != null`, `x !== undefined`, an `&&` of these) or
  // when false (`!x`, `x == null`, an `||` of those); the walk of a branch, an
  // arm or the statements after a guard that leaves reads them as their kind
  // without its nullish tags. An assignment ends the proof; a loop that
  // assigns the name ends it at its head; a closure's body starts without any.
  let nonNull = new Set()
  const isNullishRef = (v) => isNullishLit(v) || v === 'undefined' || v === 'null'
  const proves = (c, when, out = []) => {
    if (typeof c === 'string') { if (when) out.push(c); return out }
    if (!Array.isArray(c)) return out
    const op = c[0]
    if (op === '!') return proves(c[1], !when, out)
    if (op === '()' && c.length === 2) return proves(c[1], when, out)
    if ((op === '&&' && when) || (op === '||' && !when)) { proves(c[1], when, out); proves(c[2], when, out) }
    else if ((op === '!=' || op === '!==') && typeof c[1] === 'string' && isNullishRef(c[2])) { if (when) out.push(c[1]) }
    else if ((op === '==' || op === '===') && typeof c[1] === 'string' && isNullishRef(c[2])) { if (!when) out.push(c[1]) }
    return out
  }
  const narrowed = (names, fn) => {
    const added = []
    for (const name of names) if (!nonNull.has(name)) { nonNull.add(name); added.push(name) }
    try { return fn() } finally { for (const name of added) nonNull.delete(name) }
  }
  /** The statement leaves its list: a return, throw, break or continue, or a block ending in one. */
  const exits = (st) => {
    if (!Array.isArray(st)) return false
    const op = st[0]
    if (op === 'return' || op === 'throw' || op === 'break' || op === 'continue') return true
    if (op === '{}' && isBlock(st)) { const list = Array.isArray(st[1]) && st[1][0] === ';' ? st[1] : st; return exits(list[list.length - 1]) }
    if (op === ';') return exits(st[st.length - 1])
    return false
  }
  const walkFunction = (key, body, params, defaults) => {
    const outer = current, outerPre = pre, outerNonNull = nonNull, outerPost = post, outerBranch = branch
    current = key
    pre = new Set(); nonNull = new Set(); post = new Map(); branch = 0
    if (defaults) for (const p in defaults) bindParam(keyIn(key, p), expr(defaults[p]))
    if (params) { const own = new Set(params.filter(p => p != null)); assignsIn(body, own, pre) }
    if (isBlock(body)) {
      stmt(body)
      const last = body.length > 1 && Array.isArray(body[1]) && body[1][0] === ';' ? body[1][body[1].length - 1] : body[1]
      if (!(Array.isArray(last) && last[0] === 'return')) raise(results, key, NULLISH)
    } else raise(results, key, expr(body))
    current = outer
    pre = outerPre; nonNull = outerNonNull; post = outerPost; branch = outerBranch
  }

  // A reader that names no scope (a body analyzed with no function entered)
  // reads a binding through the scopes declaring its name: one function's, or
  // the join over a function and its specialized variants.
  const keyOfAnywhere = (name) => { const key = keyOf(name); if (key !== null || current !== null) return key; const ns = nameScopes.get(name); return ns ? ns.map(s => keyIn(s, name)) : null }
  const readKind = (name) => { const key = keyOfAnywhere(name); if (key === null) return K.NONE; if (typeof key === 'string') return canon(kinds.get(key) ?? K.NONE); let k = K.NONE; for (const kk of key) k = join(k, canon(kinds.get(kk) ?? K.NONE)); return k }
  /** The kind of an expression, read from the settled summary: a name, a
   *  property chain, an element read, a literal or a call to a known
   *  function; anything else is ANY. No effects. */
  const kindOfExpr = (n) => {
    if (typeof n === 'string') { const key = keyOfAnywhere(n); return key === null ? (funcByName.has(n) ? kind(K.CLOSURE) : ANY) : readKind(n) }
    if (typeof n === 'number') return NUMBER
    if (!Array.isArray(n)) return ANY
    const op = n[0]
    if (op == null) return literalKind(n[1])
    if (op === 'str' || op === 'strcat' || op === '`') return STRING
    if (op === 'bool') return BOOL
    if (op === 'bigint') return BIGINT
    if (op === '//') return kind(K.REGEX)
    if (op === '=>') { const id = closures.get(n); return id === undefined || id >= UNKNOWN ? kind(K.CLOSURE) : kind(K.CLOSURE, id) }
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
      if (NUMBER_METHODS.has(n[2]) && (t === K.ARRAY || t === K.TYPED || t === K.STRING || t === K.MAP || t === K.SET || t === K.BUFFER)) return NUMBER
      if (t === K.ARRAY && paramOf(r) !== UNKNOWN && !ARRAY_METHODS.has(n[2])) return orAbsent(propOf(r, n[2]))
      return n[2] === 'buffer' && t === K.TYPED ? kind(K.BUFFER) : ANY
    }
    if (op === '[]') {
      const r = kindOfExpr(n[1]), t = tagOf(r)
      if (Array.isArray(n[2]) && n[2][0] == null && typeof n[2][1] === 'string') return kindOfExpr(['.', n[1], n[2][1]])
      if (t === K.OBJECT && paramOf(r) !== UNKNOWN) { let k = K.NONE; for (const s of slots(paramOf(r))) k = join(k, s); return orAbsent(k) }
      return t === K.TYPED ? NUMBER : t === K.ARRAY ? orAbsent(entryOf(r, kindOfExpr(n[2]))) : t === K.STRING ? STRING : ANY
    }
    if (op === '()' && typeof n[1] === 'string') {
      const key = keyOf(n[1])
      if (key === null && funcByName.has(n[1])) return results.get(n[1]) ?? ANY
      const k = key === null ? undefined : kinds.get(key)
      if (k !== undefined) { if (tagOf(k) !== K.CLOSURE || paramOf(k) === UNKNOWN) return ANY; let r = K.NONE; for (const id of membersOf(paramOf(k))) r = join(r, results.get(id) ?? ANY); return r }
      return imports.has(n[1]) ? kindOfVal(imports.get(n[1])) : call(n[1], [])  // a constructor or builtin: no effect on no arguments
    }
    if (op === '()' && Array.isArray(n[1]) && (n[1][0] === '.' || n[1][0] === '?.') && typeof n[1][2] === 'string') {
      const r = kindOfExpr(n[1][1]), fn = classMember(r, n[1][2])
      return fn && !memberMayBeOwn(n[1][2]) ? results.get(fn) ?? ANY : ANY
    }
    if (op === '?' || op === '?:') return join(kindOfExpr(n[2]), kindOfExpr(n[3]))
    if (op === '&&' || op === '||' || op === '??') return join(kindOfExpr(n[1]), kindOfExpr(n[2]))
    if (op === ',') return kindOfExpr(n[n.length - 1])
    if (op === '+') return plus(kindOfExpr(n[1]), kindOfExpr(n[2]))
    if (NUMBER_OPS.has(op) || op === 'u-') { let big = n.length > 1; for (let i = 1; i < n.length; i++) if (tagOf(kindOfExpr(n[i])) !== K.BIGINT) big = false; return big ? BIGINT : NUMBER }
    if (op === 'u+') return NUMBER
    if (BOOL_OPS.has(op)) return BOOL
    if (op === 'typeof') return STRING
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
    if (into === null) return false
    if (typeof into === 'string') return numeric.get(into)
    let level = NUM
    for (const k of into) { const v = numeric.get(k); if (v === false) return false; if (v === undefined) return undefined; if (v < level) level = v }
    return level
  }
  /** The context `cx` (FLOW resolved through `into`), no stronger than `level`. */
  const atMost = (level, cx, into) => { const l = cx === FLOW ? demandOf(into) : cx; return l === undefined || l === false ? l : Math.min(l, level) }
  const useOf = (n, cx, into) => {
    // `n` is read in context `cx`; `into` names the key(s) it flows into under FLOW.
    const keys = typeof n === 'string' ? (keyOf(n) === null ? [] : [keyOf(n)]) : Array.isArray(n) && (n[0] === '.' || n[0] === '?.') && typeof n[2] === 'string' ? slotKeysOf(n[1], n[2]) : null
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
    if (op === 'let' || op === 'const' || op === 'var') { for (let i = 1; i < n.length; i++) { const d = n[i]; if (Array.isArray(d) && d[0] === '=') { if (typeof d[1] === 'string') useOf(d[2], FLOW, keyOf(d[1])); else demand(d[2]) } } return }
    if (op === '=') {
      const t = n[1]
      if (typeof t === 'string') { useOf(n[2], FLOW, keyOf(t)); return }
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
        if (f && !escaped.has(callee)) { as.forEach((a, i) => { const p = f.sig.params[i]; if (p && !p.rest) useOf(a, FLOW, keyIn(callee, p.name)); else demand(a) }); return }
        const ckey = keyOf(callee), ck = ckey === null ? undefined : kinds.get(ckey)
        if (ck !== undefined && tagOf(ck) === K.CLOSURE && paramOf(ck) !== UNKNOWN) {
          // Each member's parameter is a flow target; a member that escaped, or a position it lacks, is a plain read.
          const ids = membersOf(paramOf(ck)).filter(id => !escaped.has(id))
          for (let i = 0; i < as.length; i++) {
            const keys = ids.map(id => closureParams[id][i] != null ? keyIn(id, closureParams[id][i]) : null)
            if (ids.length && keys.every(k => k !== null)) useOf(as[i], FLOW, keys); else demand(as[i])
          }
          return
        }
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
  const seedable = new Set()   // exported parameters (keys) the demand may seed NUMBER
  for (const f of funcs) if (exported(f)) for (const p of f.sig.params) if (!p.rest && !f.defaults?.[p.name]) seedable.add(keyIn(f.name, p.name))

  // Each round walks the whole program; a round without a change is the
  // fixpoint. Every key rises through a lattice of finite height, so the
  // rounds are bounded; a bound this far above any program is a bug.
  const rounds = (step) => { for (let round = 0; ; round++) { if (round === 10000) throw new Error('summary: no fixpoint'); if (!step()) return } }
  const fixpoint = () => rounds(() => {
    changed = false
    for (const f of funcs) {
      if (f.rest) raise(kinds, keyIn(f.name, f.rest), kind(K.ARRAY))
      if (escaped.has(f.name)) for (const p of f.sig.params) bindParam(keyIn(f.name, p.name), ANY)
      walkFunction(f.name, f.body, f.sig.params.map(p => p.rest ? null : p.name), f.defaults)
      if (exported(f)) escapeToHost(results.get(f.name) ?? K.NONE)
    }
    for (let id = 0; id < closureBodies.length; id++) {
      if (escaped.has(id)) for (const p of closureParams[id]) if (p != null) bindParam(keyIn(id, p), ANY)
      walkFunction(id, closureBodies[id], closureParams[id], closureDefaults[id])
    }
    current = null
    for (const top of tops) stmt(top)
    for (const name of hostGlobals) if (declared.get(MODULE)?.has(name)) escapeToHost(kinds.get(name) ?? K.NONE)
    return changed
  })
  // What the host may pass: an exported function's parameters; one the export
  // contract normalizes at entry (`boundaryTyped`, narrow/param-abi.js) arrives as that typed array.
  const seed = (numeric) => {
    for (const f of funcs) if (exported(f)) for (const p of f.sig.params) { const key = keyIn(f.name, p.name); bindParam(key, p.boundaryTyped ? kind(K.TYPED, encodeTypedElemAux('Float64Array', false)) : numeric.includes(key) ? NUMBER : ANY) }
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
    for (const f of funcs) { current = f.name; demand(f.body) }
    for (let id = 0; id < closureBodies.length; id++) { current = id; demand(closureBodies[id]) }
    current = null
    for (const top of tops) demand(top)
    return demandChanged
  })
  const seeded = [...seedable].filter(p => isCompatible(p) && tagOf(kinds.get(p) ?? K.NONE) === K.ANY)
  if (seeded.length) {
    kinds.clear(); incoming.clear(); fields.clear(); results.clear(); escaped.clear(); for (let i = 0; i < elems.length; i++) { elems[i] = K.NONE; cellUp[i] = i }
    seed(seeded)
    fixpoint()
  }

  /** The readers of one scope: `scope` is a function name, a closure id or MODULE. */
  const view = (scope) => {
    const inScope = (fn) => (...a) => { const outer = current; current = scope === MODULE ? null : scope; try { return fn(...a) } finally { current = outer } }
    const kindOf = readKind
    return {
      kindOf: inScope(kindOf),
      kindOfExpr: inScope(kindOfExpr),
      sidOf: inScope((name) => { const k = kindOf(name); return tagOf(k) === K.OBJECT && !isNullable(k) && paramOf(k) !== UNKNOWN ? paramOf(k) : null }),
      /** The typed-array constructor a binding holds under every assignment, or null. */
      typedCtorOf: inScope((name) => { const k = kindOf(name); return tagOf(k) === K.TYPED && paramOf(k) !== UNKNOWN && !isNullable(k) ? ctorFromElemAux(paramOf(k)) : null }),
      /** The one schema every element of the binding's array has, or null. */
      arrayElemSidOf: inScope((name) => { const k = kindOf(name); if (tagOf(k) !== K.ARRAY || paramOf(k) === UNKNOWN) return null; const e = elemOf(k); return tagOf(e) === K.OBJECT && !isNullable(e) && paramOf(e) !== UNKNOWN ? paramOf(e) : null }),
      /** The binding has a ToNumber read or a flow into a demanded key, and no other read. */
      numericDemand: inScope((name) => { const key = keyOfAnywhere(name); return key !== null && (typeof key === 'string' ? isNumeric(key) : key.every(isNumeric)) }),
      /** A parameter's kind at entry: the join of its arguments and its default, before any reassignment. */
      paramKindOf: inScope((name) => { const key = keyOf(name); return key === null ? K.NONE : canon(incoming.get(key) ?? K.NONE) }),
      /** The element kind of an array kind: every element the program can put in its cell. */
      elemKindOf: (k) => elemOf(k),
      /** The value kind (reps.js VAL) of an expression's kind when it is one non-nullable kind, else null. */
      valOfExpr: inScope((e) => valOf(kindOfExpr(e))),
      /** The typed-array constructor an expression holds under every assignment, or null. */
      typedCtorOfExpr: inScope((e) => { const k = kindOfExpr(e); return tagOf(k) === K.TYPED && paramOf(k) !== UNKNOWN && !isNullable(k) ? ctorFromElemAux(paramOf(k)) : null }),
    }
  }
  const views = new Map()
  return {
    ...view(MODULE),
    /** The readers of one scope: a function's name or signature record, a closure's id or
     *  parameter node (`sig.scope` on an emitted closure's frame); unknown reads as the module. */
    at: (x) => {
      const scope = typeof x === 'string' || typeof x === 'number' ? x : scopeOfSig.get(x) ?? scopeOfParams.get(x) ?? (x?.scope != null ? scopeOfParams.get(x.scope) : undefined) ?? MODULE
      let v = views.get(scope); if (!v) views.set(scope, v = view(scope)); return v
    },
    fieldKind: (sid, prop) => { const i = schemas[sid]?.indexOf(prop); return i == null || i < 0 ? K.NONE : fields.get(sid)?.[i] ?? K.NONE },
    /** The slot's value kind (reps.js VAL) when one kind holds under every construction and store, else null. */
    fieldVal: (sid, prop) => { const i = schemas[sid]?.indexOf(prop); return i == null || i < 0 ? null : valOf(fields.get(sid)?.[i] ?? K.NONE) },
    /** The typed-array constructor a slot holds under every construction and store, or null. */
    fieldTypedCtor: (sid, prop) => { const i = schemas[sid]?.indexOf(prop); const k = i == null || i < 0 ? K.NONE : fields.get(sid)?.[i] ?? K.NONE; return tagOf(k) === K.TYPED && paramOf(k) !== UNKNOWN && !isNullable(k) ? ctorFromElemAux(paramOf(k)) : null },
    resultOf: (name) => results.get(name) ?? K.NONE,
    /** The result's value kind (reps.js VAL) when its returns join to one non-nullable kind, else null. */
    resultVal: (name) => valOf(results.get(name) ?? K.NONE),
    /** Some object may carry an own property `prop` stored under that literal name, shadowing a class member. */
    memberMayBeOwn: (prop) => dynamicProps.has(prop),
    /** Some slot holds a typed array under every construction and store. */
    hasTypedFields: [...fields.values()].some(a => a.some(k => tagOf(k) === K.TYPED && paramOf(k) !== UNKNOWN && !isNullable(k))),
    escaped,
  }
}
