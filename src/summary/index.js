/**
 * The program summary: one kind per binding, per schema slot, per function
 * result, computed once over the prepared program by a fixpoint before any
 * per-function analysis runs. A kind is a set of tags
 *
 *   NUMBER STRING BOOL BIGINT NULLISH ABSENT TYPED(elem) ARRAY(cell)
 *   OBJECT(sid) CLOSURE(id | set) MAP(cell) SET DATE REGEX HASH BUFFER
 *
 * with one parameter when the set names one tag besides the nullish pair:
 * the typed array's element type, the array's or map's value cell, the
 * object's schema, the closure's identity or the set of closures a join
 * made (a dispatch table's members: a call through the join calls each).
 * NULLISH is a nullish value the program holds (a literal, a missing
 * argument, a bare return); ABSENT a nullish the program does not mean to
 * read (a binding before its assignment, an element past the array's end, a
 * map's miss), which the reps carry as presence (`mayBeUndefined`) beside
 * the kind rather than in place of it. NONE is the empty set, ANY every tag.
 * A join is the union; a parameter survives it when both sides agree, and
 * two arrays (or maps) joined share one cell from then on. An array used as
 * a dictionary keeps one kind per literal name beside its elements.
 *
 * Joins are flow-insensitive: a binding's kind is the join of everything
 * assigned to it, a slot's kind the join of every construction and store, a
 * parameter's kind the join of every argument at every direct call, a result
 * the join of every return; three regions of a function body read finer: a
 * parameter before its first reassignment (its arguments alone), a binding
 * after a straight-line assignment (that value alone), a path a condition
 * guards (`if (x)`, `x != null`, `typeof x === 't'`, an early return: the
 * kind masked to what the condition proves). A binding is keyed by the
 * function that declares it (a specialized variant declares its own), a
 * module global by its name alone; a reader names its scope by the function
 * body (`at(body)`). What the summary cannot see is ANY: an exported
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
import { MUTATE_OPS, extractParams, isBrand, returnExprs, ACCESSOR_GET, ACCESSOR_SET, CLASS_T, TYPEOF, typeofPredicate } from '../ast.js'
import { encodeTypedElemAux, TYPED_ELEM_BIGINT_FLAG, TYPED_ELEM_VIEW_FLAG } from '../../layout.js'
import { VAL } from '../reps.js'
import { builtinCalleeVal, methodValType } from '../kind-traits.js'
import { summaryQueries } from './query.js'
import { buildResultContracts, unbounded } from './contract.js'
export { CARRIER, PRESENCE, contractVal, unbounded } from './contract.js'

import {
  K, UNKNOWN, bitOf, TAGS, NULL_BITS, kind, tagOf, paramOf, hasTag, isNullable,
  ANY, NUMBER, STRING, BOOL, BIGINT, NULLISH, ABSENT, core, orAbsent, join,
  valOf, kindOfVal, TYPED_CTOR, isCount, ARRAY_METHODS, NUMBER_OPS, BOOL_OPS,
  plus, arith, typedStore, isPostfixRecovery, logicalMask, selectKind,
} from './kind.js'
export { K, UNKNOWN, kind, tagOf, paramOf, isNullable, tagsOf, hasTag, orNull, join, valOf, kindOfVal, valsOf, core } from './kind.js'

// Builtins that read their arguments and never write a field of them; any
// other unresolved callee may store into an object it receives.
const PURE_BUILTINS = /^(Object\.(keys|values|entries|freeze|isFrozen|getOwnPropertyNames|getPrototypeOf|hasOwn|is)|JSON\.stringify|Array\.isArray|console\.\w+|Math\.\w+|Number(\.\w+)?|String(\.\w+)?|Boolean|BigInt|Symbol(\.\w+)?|isNaN|isFinite|parseInt|parseFloat|structuredClone)$/

const BIND = CLASS_T + 'bind'
const TYPED_SAME = new Set(['subarray', 'slice', 'map', 'filter', 'fill', 'reverse', 'sort', 'copyWithin', 'set'])
// A method's typed result keeps the receiver's element kind; `subarray` views
// its buffer, a copy (`slice`, `map`, `filter`) owns a fresh one, a mutator
// returns the receiver (typed-provenance.js's own three families).
const TYPED_FRESH = new Set(['slice', 'map', 'filter'])
const typedSame = (name, aux) => aux === UNKNOWN ? aux
  : name === 'subarray' ? aux | TYPED_ELEM_VIEW_FLAG : TYPED_FRESH.has(name) ? aux & ~TYPED_ELEM_VIEW_FLAG : aux
const STRING_METHODS = new Set(['slice', 'substring', 'substr', 'trim', 'trimStart', 'trimEnd', 'toUpperCase', 'toLowerCase', 'padStart', 'padEnd', 'repeat', 'replace', 'replaceAll', 'concat', 'normalize', 'at', 'charAt'])
const STRING_NUMBER_METHODS = new Set(['charCodeAt', 'codePointAt', 'indexOf', 'lastIndexOf', 'search', 'localeCompare'])
const STRING_BOOL_METHODS = new Set(['includes', 'startsWith', 'endsWith'])

/** Summarize the prepared program: `ast` the entry module's statements and `inits` the bundled
 *  modules' (run first), `funcs` the function records, `schemas` the schema prop lists, `imports`
 *  the host imports by alias with the result kind each declares (reps.js VAL, or null),
 *  `hostGlobals` the module globals the host reads, `constString` a module const's folded
 *  string (`JSON.parse(SRC)` parses it). An exported global keeps its kind: the host
 *  can store only a number through its f64 export, which a number global takes and no other
 *  kind could take; a closure the host can reach through it may be called with anything. */
export function summarize(ast, { inits = [], funcs, schemas, brandOf, boundSchema = () => undefined, classes, exported, imports, hostGlobals = [], constString = () => null, constStrings = () => null }) {
  const tops = [...inits, ast]
  const kinds = []                   // binding id (keyOf) → kind
  const opaqueSchemas = new Set() // schemas whose identity is lost at a value join
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
  // Members use existing scope keys: names for declared functions, numeric
  // IDs for anonymous closures. Taking a function's address preserves its
  // identity; only an unknown use opens its parameters.
  // Two closures joined are a closure set (a dispatch table's members, an
  // array of handlers): a call through the join calls each member. The
  // set's id is interned above SET_BASE; `membersOf` reads either form. A
  // set past SET_MAX members escapes them all instead.
  const SET_BASE = 1 << 15, SET_MAX = 32
  const closureSets = [], closureSetIds = new Map()
  const singles = []             // closure id → [id], the one-member list, allocated once
  const membersOf = (id) => id >= SET_BASE ? closureSets[id - SET_BASE] : singles[id] ?? (singles[id] = [id])
  const closureSet = (ids) => {
    const key = ids.length === 1 && typeof ids[0] === 'string' ? ids[0] : JSON.stringify(ids)
    let id = closureSetIds.get(key)
    if (id === undefined) {
      if (SET_BASE + closureSets.length >= UNKNOWN) { for (const member of ids) escapeId(member); return UNKNOWN }
      id = SET_BASE + closureSets.length; closureSets.push(ids); closureSetIds.set(key, id)
    }
    return id
  }
  const unions = new Map()       // `a * 65536 + b` → the union's id, computed once per pair
  const unionClosures = (a, b) => {
    const pair = a * 65536 + b
    let id = unions.get(pair)
    if (id !== undefined) return id
    const ids = [...new Set([...membersOf(a), ...membersOf(b)])].sort((x, y) => typeof x === typeof y ? (x < y ? -1 : x > y ? 1 : 0) : typeof x === 'number' ? -1 : 1)
    if (ids.length > SET_MAX || SET_BASE + closureSets.length >= UNKNOWN) { for (const id of ids) escapeId(id); id = UNKNOWN }
    else id = closureSet(ids)
    unions.set(pair, id); unions.set(b * 65536 + a, id)
    return id
  }
  // A join that loses a parameter loses what it named: a closure joined with
  // another kind is called through the join, which binds nothing, so it is
  // called from where the summary cannot see; an array joined with another
  // kind is stored to through the join. Two arrays joined share one cell
  // from then on (`unify`), so a store through either reaches both.
  const merge = (a, b) => {
    a = canon(a); b = canon(b)
    if (tagOf(a) === tagOf(b) && paramOf(a) !== UNKNOWN && paramOf(b) !== UNKNOWN && paramOf(a) !== paramOf(b) && (celled(a) || tagOf(a) === K.CLOSURE)) {
      const shared = celled(a) ? unify(paramOf(a), paramOf(b)) : unionClosures(paramOf(a), paramOf(b))
      if (shared !== UNKNOWN) { a = (a & ~UNKNOWN) | shared; b = (b & ~UNKNOWN) | shared }
    }
    const j = join(a, b)
    if (paramOf(j) === UNKNOWN) { lose(a); lose(b) }
    return j
  }
  const lose = (k) => { if (paramOf(k) !== UNKNOWN) escape(k) }
  const slots = (sid) => { let a = fields.get(sid); if (!a) fields.set(sid, a = new Array(schemas[sid].length).fill(K.NONE)); return a }
  // A binding some definition of which names BigInt among a bounded set: the
  // member the join to ANY erases (`n = BigInt(n)` on one path of a parameter
  // of every kind), kept for the result contract's certain-return walk.
  const certainKeys = new Set()
  const raise = (values, key, k) => {
    const old = values[key] ?? K.NONE; const nk = merge(old, k)
    if (nk !== old) { values[key] = nk; changed = true }
    if (values === kinds && hasTag(k, K.BIGINT) && !unbounded(k)) certainKeys.add(key)
  }
  const raiseResult = (key, k) => {
    const old = results.get(key) ?? K.NONE, nk = merge(old, k)
    if (nk !== old) { results.set(key, nk); changed = true }
  }
  const raiseSlot = (sid, i, k) => { if (hostSchemas.has(sid)) { retain(k); escapeToHost(k) } const a = slots(sid); const nk = merge(a[i], k); if (nk !== a[i]) { a[i] = nk; changed = true } }
  const NO_SLOTS = []
  const openSchemas = new Set()
  const openSchema = sid => { if (!openSchemas.has(sid)) { openSchemas.add(sid); changed = true } }
  const poisonProp = (prop) => { for (const [sid, i] of byProp.get(prop) ?? NO_SLOTS) raiseSlot(sid, i, ANY) }
  const poisonSchema = (sid) => { openSchema(sid); const a = slots(sid); for (let i = 0; i < a.length; i++) raiseSlot(sid, i, ANY) }
  // A closure's parameter names, a default's among them (`(a, b = 1) =>`); a pattern is unnamed.
  // A rest parameter (jzify desugars every pattern parameter into one) is
  // null in the list, its position in `.rest`: it collects the arguments
  // from there on.
  const withRest = (names) => { const i = names.indexOf(null); if (i >= 0) names.rest = i; return names }
  const paramNames = (params) => withRest(extractParams(params).map(p => typeof p === 'string' ? p : Array.isArray(p) && p[0] === '=' && typeof p[1] === 'string' ? p[1] : null))
  const defaultsOf = (params) => { let d = null; for (const p of extractParams(params)) if (Array.isArray(p) && p[0] === '=' && typeof p[1] === 'string') (d ??= {})[p[1]] = p[2]; return d }
  const closureDefaults = []         // closure id → { name: default expression } or null
  // A closure is keyed by its `=>` node, and by its body: emission may hand
  // the query a rebuilt `=>` wrapper around the same body (a call rebuilt by
  // an optional chain, a method's staged receiver).
  const closuresByBody = new Map()   // body node → closure id
  const closureId = (node) => {
    let id = closures.get(node)
    if (id === undefined) { id = closureParams.length; closures.set(node, id); closuresByBody.set(node[2], id); closureParams.push(paramNames(node[1])); closureDefaults.push(defaultsOf(node[1])); closureBodies.push(node[2]) }
    return id
  }
  // An array's element kind, and a map's value kind, lives in a cell its
  // construction site owns; every store and push joins into it, so a read sees
  // every element the program can put there. Cells joined are one cell (a
  // union-find over ids); a kind names a cell by any id in it, `canon` by the root.
  const celled = (k) => (tagOf(k) === K.ARRAY || tagOf(k) === K.MAP || tagOf(k) === K.HASH) && paramOf(k) !== UNKNOWN
  const elems = []               // cell root → element kind
  const hostSchemas = new Set() // host-visible objects store tagged fields
  const hostArrays = new Set()   // arrays exposed to host writes
  const retainedArrays = new Set() // arrays reachable across calls, through globals or captures
  const hostClosures = new Set() // callable results the host can receive
  const tuples = new Map()       // cell root → immutable literal positions; null after mutation or union
  const cellUp = []              // cell id → its parent; a root is its own
  const cells = new Map()        // construction node (an array literal, a `new Map`) → cell id
  const cell = (id) => { while (cellUp[id] !== id) id = cellUp[id] = cellUp[cellUp[id]]; return id }
  const canon = (k) => celled(k) ? (k & ~UNKNOWN) | cell(paramOf(k)) : k
  const elemOf = (k) => celled(k) ? elems[cell(paramOf(k))] : ANY
  // A cell, closure or schema past the parameter's range is one the kind cannot name: it escapes.
  const cellOf = (node, tag, elem) => {
    let id = cells.get(node)
    if (id === undefined) { id = elems.length; elems.push(elem); cellUp.push(id); cells.set(node, id) }
    if (id >= UNKNOWN) { escape(elem); return kind(tag) }
    const k = kind(tag, id)
    // Cell identities survive numeric reseeding; constructor facts must be
    // restored each round along with the stores that feed the cell.
    raiseElem(k, elem, true)
    return k
  }
  const arrayOf = (node, elem) => cellOf(node, K.ARRAY, elem)
  const mapOf = (node, base, count) => {
    let value = K.NONE
    if (count) {
      const source = ks[base], t = tagOf(source)
      if (t === K.MAP) value = elemOf(source)
      else if (t === K.ARRAY) {
        const entry = elemOf(source)
        const row = tagOf(entry) === K.ARRAY && paramOf(entry) !== UNKNOWN ? tuples.get(cell(paramOf(entry))) : null
        value = row ? row[1] ?? NULLISH : tagOf(entry) === K.NONE ? K.NONE : tagOf(entry) === K.ARRAY ? elemOf(entry) : ANY
      } else if (t !== K.NONE && t !== K.NULLISH && t !== K.ABSENT) value = ANY
    }
    return cellOf(node, K.MAP, value)
  }
  const invalidateTuple = arr => {
    if (!celled(arr)) return
    const id = cell(paramOf(arr))
    if (tuples.get(id) !== null) { tuples.set(id, null); changed = true }
  }
  const raiseElem = (arr, k, literal = false) => {
    if (!celled(arr)) return
    const id = cell(paramOf(arr))
    if (hostArrays.has(id) && retainedArrays.has(id)) { retain(k); escapeToHost(k); k = ANY; literal = false }
    if (!literal) invalidateTuple(arr)
    const nk = merge(elems[id], k)
    if (nk !== elems[id]) { elems[id] = nk; changed = true }
  }

  const unify = (a, b) => {
    a = cell(a); b = cell(b)
    if (a === b) return a
    invalidateTuple(kind(K.ARRAY, a)); invalidateTuple(kind(K.ARRAY, b))
    cellUp[b] = a; changed = true
    if (hostArrays.has(b)) hostArrays.add(a)
    if (retainedArrays.has(b)) retainedArrays.add(a)
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
  const raiseProp = (arr, prop, k) => { if (tagOf(arr) !== K.ARRAY || paramOf(arr) === UNKNOWN) return; if (/^\d+$/.test(prop)) invalidateTuple(arr); const c = cell(paramOf(arr)); let m = cellProps.get(c); if (!m) cellProps.set(c, m = new Map()); const old = m.get(prop) ?? K.NONE, nk = merge(old, k); if (nk !== old) { m.set(prop, nk); changed = true } }
  const raiseWild = (arr, k) => { if (tagOf(arr) !== K.ARRAY || paramOf(arr) === UNKNOWN) return; invalidateTuple(arr); const c = cell(paramOf(arr)); const old = cellWild.get(c) ?? K.NONE, nk = merge(old, k); if (nk !== old) { cellWild.set(c, nk); changed = true } }
  /** An array's entry under a key of kind `ik`: elements by a number, dictionary entries by a string, everything by an unknown key. */
  const entryOf = (arr, ik) => { const t = tagOf(ik); if (paramOf(arr) === UNKNOWN) return ANY; return t === K.NUMBER ? elemOf(arr) : t === K.STRING ? anyPropOf(arr) : t === K.NONE ? K.NONE : join(elemOf(arr), anyPropOf(arr)) }
  const raiseEntry = (arr, ik, k) => { const t = tagOf(ik); if (t === K.NUMBER) raiseElem(arr, k); else if (t === K.STRING) raiseWild(arr, k); else if (t !== K.NONE) { raiseElem(arr, k); raiseWild(arr, k) } }
  /** A value the summary no longer follows: a closure's callers become unknown, an array's elements too. */
  const escape = (k) => {
    if (tagOf(k) === K.OBJECT && paramOf(k) !== UNKNOWN && !opaqueSchemas.has(paramOf(k))) {
      opaqueSchemas.add(paramOf(k)); changed = true
    }
    if (tagOf(k) === K.CLOSURE && paramOf(k) !== UNKNOWN) for (const id of membersOf(paramOf(k))) escapeId(id)
    // The cell goes to ANY before its elements escape: an array of itself ends there.
    if (celled(k)) { invalidateTuple(k); const id = cell(paramOf(k)), e = elems[id]; if (e !== ANY) { elems[id] = ANY; changed = true; escape(e) } }
  }
  /** An object handed to code the summary cannot see: its fields may be stored to. */
  // An own property stored under a class member's name shadows the member
  // (jzify/classes.js): a store of a non-field property on an instance, or
  // through a receiver of unknown shape. The name must be literal: a
  // computed-key store, or a store by code the summary cannot see, does not
  // reach a class member (the class contract, jzify/classes.js).
  const dynamicProps = new Set()
  // Own properties on builtin receiver families are tracked by family, not as
  // one global name set: `{push: fn}` must not pessimize every real Array#push.
  const builtinOwnProps = new Map()
  const escapeObject = (k) => { if (tagOf(k) === K.OBJECT && paramOf(k) !== UNKNOWN) poisonSchema(paramOf(k)); escape(k) }
  const args = (a) => a == null ? [] : Array.isArray(a) && a[0] === ',' ? a.slice(1) : [a]
  /** A value the host holds (an export's result, an exported global, an import's argument): every closure it reaches may be called with anything. */
  const escapeToHost = (k, seen = new Set()) => {
    const t = tagOf(k), p = paramOf(k)
    if (p === UNKNOWN) return
    if (t === K.CLOSURE) { retain(k); for (const id of membersOf(p)) { if (!hostClosures.has(id)) { hostClosures.add(id); changed = true } escapeId(id) } }
    else if (t === K.ARRAY || t === K.MAP || t === K.HASH) { const c = cell(p); if (!seen.has(-1 - c)) { seen.add(-1 - c); escapeToHost(elems[c], seen); if (t === K.ARRAY) { escapeToHost(anyPropOf(k), seen); hostArrays.add(c); if (retainedArrays.has(c)) raiseElem(k, ANY) } } }
    else if (t === K.OBJECT && !seen.has(p) && !hostSchemas.has(p)) {
      seen.add(p); hostSchemas.add(p); changed = true
      const row = slots(p)
      for (let i = 0; i < row.length; i++) { retain(row[i]); escapeToHost(row[i], seen) }
    }
  }
  // Returning a fresh local array cannot change its earlier reads. Only a
  // retained alias (or an import, which may mutate during the call) opens its
  // element proof. Walk aggregate edges too; arrays have no host element ABI.
  const retain = (k, seen = new Set()) => {
    const t = tagOf(k), p = paramOf(k)
    if (p === UNKNOWN) return
    if (t === K.CLOSURE) {
      for (const id of membersOf(p)) {
        const body = typeof id === 'string' ? funcByName.get(id).body : closureBodies[id]
        if (seen.has(body)) continue
        seen.add(body)
        for (const key of captures.get(id) ?? []) retain(kinds[key] ?? K.NONE, seen)
      }
    } else if (celled(k)) {
      const c = cell(p)
      if (seen.has(-1 - c)) return
      seen.add(-1 - c)
      retain(elems[c], seen); retain(anyPropOf(k), seen)
      retainedArrays.add(c)
      if (hostArrays.has(c)) raiseElem(k, ANY)
    } else if (t === K.OBJECT && !seen.has(p)) {
      seen.add(p)
      for (const s of slots(p)) retain(s, seen)
    }
  }
  // A parameter's incoming kind, the join of its arguments alone: a read of
  // the parameter before any reassignment can run sees only this; `kinds`
  // holds the join with the reassignments too.
  const incoming = []
  const bindParam = (key, k) => { raise(incoming, key, k); raise(kinds, key, k) }
  // A call's argument kinds live on one stack, a frame per call: `base` is
  // the frame's first slot and `n` its count. A frame is pushed above the
  // caller's (an argument's own calls come and go while it is built) and
  // popped by the site that pushed it, so a round allocates no array per
  // call. A frame's kinds are plain numbers: nothing here retains them.
  const ks = []
  // A spread argument (`f(...xs)`, `a.push(...xs)`) is one slot holding the
  // source's element kind; the slots from it on have no position of their own.
  const kspread = []
  let sp = 0
  const pushK = (k, spread = false) => { ks[sp] = k; kspread[sp] = spread; sp++ }
  const isSpread = (a) => Array.isArray(a) && a[0] === '...'
  /** The kinds of a call's arguments (`a`: the argument node, a `,` list or none): the frame's base. */
  const pushArgs = (a) => {
    const base = sp
    if (a == null) return base
    if (Array.isArray(a) && a[0] === ',') for (let i = 1; i < a.length; i++) { const k = expr(a[i]); pushK(k, isSpread(a[i])) }
    else { const k = expr(a); pushK(k, isSpread(a)) }
    return base
  }
  /** The frame's first spread slot, or `n`. */
  const spreadAt = (base, n) => { for (let i = 0; i < n; i++) if (kspread[base + i]) return i; return n }
  const escapeArgs = (base, n) => { for (let i = 0; i < n; i++) escape(ks[base + i]) }
  const escapeObjectArgs = (base, n) => { for (let i = 0; i < n; i++) escapeObject(ks[base + i]) }
  /** `callee(k0, …frame)`: the frame's kinds behind a receiver, in a frame of their own. */
  const callWith = (callee, k0, base = 0, n = 0) => {
    const b = sp
    pushK(k0)
    for (let i = 0; i < n; i++) pushK(ks[base + i], kspread[base + i])
    const r = call(callee, b, n + 1)
    sp = b
    return r
  }
  const funcParamNames = new Map()   // function record → its parameter names, a rest parameter as null
  const paramNamesOf = (f) => { let names = funcParamNames.get(f); if (!names) funcParamNames.set(f, names = withRest(f.sig.params.map(p => p.rest ? null : p.name))); return names }
  /** Bind a callee's parameters (`scope`: its name or closure id) to the argument kinds: a
   *  missing argument is nullish, or nothing when the parameter has a default (bound by the walk).
   *  From a spread argument on, a parameter takes any of the spread's elements, a
   *  later argument or nothing (a default replaces the nothing). The arguments
   *  a rest parameter collects escape; a surplus argument past the declared
   *  parameters is one the callee never observes. */
  const bind = (scope, names, base, n, defaults) => {
    const s = spreadAt(base, n)
    let tail = NULLISH
    for (let i = s; i < n; i++) tail = merge(tail, ks[base + i])
    for (let i = 0; i < names.length; i++) {
      if (names[i] == null) continue
      if (i < s) bindParam(keyIn(scope, names[i]), ks[base + i])
      else if (s < n) bindParam(keyIn(scope, names[i]), defaults?.[names[i]] ? core(tail) : tail)
      else if (!defaults?.[names[i]]) bindParam(keyIn(scope, names[i]), NULLISH)
    }
    if (names.rest != null) for (let i = names.rest; i < n; i++) escape(ks[base + i])
  }
  const call = (callee, base, n) => {
    if (typeof callee === 'string') {
      if (callee.startsWith('new.')) {
        const m = TYPED_CTOR.exec(callee)
        if (m) {
          // The three-argument constructor stores a descriptor, not element
          // bytes. Preserve that representation through calls and closures.
          const aux = encodeTypedElemAux(m[1], !!m[2] || n >= 3)
          return kind(K.TYPED, aux == null ? UNKNOWN : aux)
        }
        if (callee === 'new.RegExp') return kind(K.REGEX)
        if (callee === 'new.ArrayBuffer' || callee === 'new.SharedArrayBuffer') return kind(K.BUFFER)
      }
      // The builtin's trait first (kind-traits.js: `Number.isNaN` is a boolean), then the family.
      const traitVal = builtinCalleeVal(callee)
      if (traitVal != null && traitVal !== VAL.TYPED) return kindOfVal(traitVal)
      if (callee === 'String' || callee.startsWith('String.')) return STRING
      if (callee === 'Number' || callee.startsWith('Math.') || callee.startsWith('Number.')) return NUMBER
      // jzify's `for…of` lowering iterates `__iter_arr(v)` by index (module/collection.js):
      // an array, a typed array, a string or a buffer iterates as itself, a Set or a Map as
      // an array it materializes, an iterable of unknown kind as the runtime resolves it;
      // `__keys_ro` is `for…in`'s key list.
      if (callee === '__iter_arr') { const t = n ? tagOf(ks[base]) : K.NONE; return t === K.ARRAY || t === K.TYPED || t === K.BUFFER ? ks[base] : t === K.MAP || t === K.SET || t === K.STRING ? kind(K.ARRAY) : t === K.NONE ? K.NONE : ANY }
      if (callee === '__keys_ro') return kind(K.ARRAY)
      const f = funcByName.get(callee)
      if (f) {
        if (!escaped.has(callee)) bind(callee, paramNamesOf(f), base, n, f.defaults)
        return results.get(callee) ?? K.NONE
      }
      const key = keyOf(callee), k = key === null ? undefined : kinds[key]
      if (k !== undefined && tagOf(k) === K.CLOSURE && paramOf(k) !== UNKNOWN) return callClosure(paramOf(k), base, n)
      if (k === undefined && key !== null) return K.NONE  // a local callee not known yet
      // A host import returns the kind it declares; a builtin the kind its trait says (kind-traits.js).
      if (imports.has(callee)) { for (let i = 0; i < n; i++) { retain(ks[base + i]); escapeToHost(ks[base + i]); escape(ks[base + i]) } return kindOfVal(imports.get(callee)) }
      // `Object.assign` onto an array: a source of known shape stores its slots
      // as the array's properties (an index-named one as an element); any
      // other source may store anything.
      if (callee === 'Object.assign' && n > 0 && (tagOf(ks[base]) === K.ARRAY || tagOf(ks[base]) === K.HASH) && paramOf(ks[base]) !== UNKNOWN) {
        const target = ks[base]
        for (let i = 1; i < n; i++) {
          const s = ks[base + i]
          if (tagOf(s) === K.OBJECT && paramOf(s) !== UNKNOWN && !kspread[base + i]) { const sid = paramOf(s), sl = slots(sid); schemas[sid].forEach((p, j) => { if (tagOf(target) === K.HASH || /^\d+$/.test(p)) raiseElem(target, sl[j]); else raiseProp(target, p, sl[j]) }) }
          else if (tagOf(target) === K.HASH && tagOf(s) === K.HASH && !kspread[base + i]) raiseElem(target, elemOf(s))
          else { escape(target); escapeObject(s) }
        }
        return target
      }
      // A builtin: the kind its trait names (kind-traits.js). A `new.X` past
      // the typed constructors above is a DataView (a typed view) or unknown.
      let builtin = builtinCalleeVal(callee)
      if (builtin === VAL.TYPED && callee !== 'new.DataView') builtin = null
      if (builtin != null || PURE_BUILTINS.test(callee)) { escapeArgs(base, n); return kindOfVal(builtin) }
    }
    escapeObjectArgs(base, n)
    return ANY
  }
  const callableParams = id => typeof id === 'string' ? paramNamesOf(funcByName.get(id)) : closureParams[id]
  /** Call a closure or each member of a closure set; the result is the join of theirs. */
  const callClosure = (param, base, n) => {
    let r = K.NONE
    for (const id of membersOf(param)) {
      if (!escaped.has(id)) bind(id, callableParams(id), base, n, typeof id === 'string' ? funcByName.get(id).defaults : closureDefaults[id])
      r = merge(r, results.get(id) ?? K.NONE)
    }
    return r
  }
  const closureResult = param => {
    let r = K.NONE
    for (const id of membersOf(param)) r = merge(r, results.get(id) ?? K.NONE)
    return r
  }
  // A class (jzify/classes.js): its members are functions of the receiver.
  // A receiver of one class calls its function; a receiver the summary
  // cannot name may be any class with the member, so each is called.
  const classOfSid = (sid) => { const b = brandOf(sid); return b ? classes?.get(b) ?? null : null }
  const classMember = (recv, name) => tagOf(recv) === K.OBJECT && paramOf(recv) !== UNKNOWN ? classOfSid(paramOf(recv))?.methods.get(name) ?? null : null
  // A property's accessor and binder names, built once per property.
  const getterNames = new Map(), setterNames = new Map(), binderNames = new Map()
  const named = (m, name, suffix) => { let s = m.get(name); if (s === undefined) m.set(name, s = name + suffix); return s }
  const getterOf = (prop) => named(getterNames, prop, ACCESSOR_GET), setterOf = (prop) => named(setterNames, prop, ACCESSOR_SET), binderOf = (fn) => named(binderNames, fn, BIND)
  const memberMayBeOwn = (prop) => dynamicProps.has(prop)
  const builtinReceiverTag = t => t === K.ARRAY || t === K.TYPED ||
    t === K.MAP || t === K.SET || t === K.REGEX || t === K.CLOSURE
  const markBuiltinOwn = (t, prop) => {
    if (builtinReceiverTag(t)) builtinOwnProps.set(prop, (builtinOwnProps.get(prop) ?? 0) | bitOf(t))
  }
  const builtinReceiverMayHaveOwn = (t, prop) =>
    builtinReceiverTag(t) && ((builtinOwnProps.get(prop) ?? 0) & bitOf(t)) !== 0
  /** The class member's result, or ANY when an own property may shadow it. */
  const memberResult = (recv, name, r) => memberMayBeOwn(name) ? ANY : r
  const unknownReceiver = (recv) => { const t = tagOf(recv); return t === K.ANY || (t === K.OBJECT && paramOf(recv) === UNKNOWN) }
  // The class members by name (a receiver the summary cannot name calls each class's).
  const membersByName = new Map()   // member name → the class functions bearing it
  if (classes) for (const e of classes.values()) for (const [name, fn] of e.methods) { let l = membersByName.get(name); if (!l) membersByName.set(name, l = []); l.push(fn) }
  const NO_MEMBERS = []
  const callCandidates = (recv, name, base, n) => {
    if (!unknownReceiver(recv)) return
    for (const fn of membersByName.get(name) ?? NO_MEMBERS) callWith(fn, recv, base, n)
  }
  const typedElemKind = (recv) => paramOf(recv) === UNKNOWN
    ? join(NUMBER, BIGINT)
    : (paramOf(recv) & TYPED_ELEM_BIGINT_FLAG) !== 0 ? BIGINT : NUMBER
  // methodValType's name-only traits are useful once the receiver is a known
  // builtin family. They are not facts about an unknown/dictionary receiver:
  // `o['includes'] = () => 7` is still an ordinary own method.
  const builtinMethodResult = (recv, name) => {
    const v = valOf(core(recv))
    return v == null || v === VAL.OBJECT || v === VAL.HASH || v === VAL.CLOSURE
      ? ANY : kindOfVal(methodValType(name, null, v, null))
  }
  const optionalResult = (op, recv, result) => {
    if (op !== '?.' || !hasTag(recv, K.NULLISH) && !hasTag(recv, K.ABSENT)) return result
    return tagOf(core(recv)) === K.NONE ? NULLISH : join(result, NULLISH)
  }
  /** `callee(k0, k1, k2, k3)` in a frame of its own. */
  const call4 = (param, k0, k1, k2, k3) => {
    const b = sp
    pushK(k0); pushK(k1); pushK(k2); pushK(k3)
    const r = callClosure(param, b, 4)
    sp = b
    return r
  }
  // A reduce accumulator starts with the explicit initial value, or an
  // element. Later iterations feed the callback's own result back into its
  // first parameter; joining the prior-round result makes that recurrence a
  // monotone part of the surrounding summary fixpoint.
  const reduceResult = (recv, base, n) => {
    const elem = tagOf(recv) === K.TYPED ? typedElemKind(recv) : elemOf(recv)
    const initial = n > 1 ? ks[base + 1] : elem
    const cb = n > 0 ? ks[base] : K.NONE
    if (tagOf(cb) !== K.CLOSURE || paramOf(cb) === UNKNOWN) {
      escapeArgs(base, n)
      return ANY
    }
    const prior = closureResult(paramOf(cb))
    const out = call4(paramOf(cb), merge(initial, prior), elem, NUMBER, recv)
    // The input is observable for a zero/one-element array; the callback
    // result for every iteration that actually invokes it.
    return merge(initial, out)
  }
  // An array's callback method binds the callback to (element, index, array):
  // `map` collects the callback's results in the call's own cell, the
  // predicates keep the elements, `reduce` recurs through its accumulator.
  const ARRAY_CALLBACKS = new Set(['map', 'filter', 'forEach', 'find', 'findLast', 'findIndex', 'findLastIndex', 'some', 'every', 'flatMap'])
  const arrayCallback = (node, recv, name, base, n) => {
    const cb = n > 0 ? ks[base] : K.NONE
    if (tagOf(cb) !== K.CLOSURE || paramOf(cb) === UNKNOWN) { escapeArgs(base, n); return ANY }
    for (let i = 1; i < n; i++) escape(ks[base + i])
    const elem = elemOf(recv)
    const b = sp
    pushK(elem); pushK(NUMBER); pushK(recv)
    const r = callClosure(paramOf(cb), b, 3)
    sp = b
    if (name === 'map') { const out = arrayOf(node, r); raiseElem(out, r); return out }
    if (name === 'flatMap') { const out = arrayOf(node, K.NONE); raiseElem(out, tagOf(r) === K.ARRAY ? elemOf(r) : r); return out }
    if (name === 'filter') return recv
    if (name === 'find' || name === 'findLast') return orAbsent(elem)
    if (name === 'findIndex' || name === 'findLastIndex') return NUMBER
    if (name === 'forEach') return NULLISH
    return BOOL
  }
  /** `callee(k0, k1)` in a frame of its own. */
  const call2 = (param, k0, k1) => {
    const b = sp
    pushK(k0); pushK(k1)
    const r = callClosure(param, b, 2)
    sp = b
    return r
  }
  // The array constructors own a cell each, like a literal: `Array(n)` is n
  // holes (its elements absent until stored), `Array()` empty, `Array(x)` of
  // another kind and `Array(a, b)` hold their arguments; `Array.of` its
  // arguments; `Array.from(src)` the source's elements (an array's, a typed
  // array's, a string's characters, else unknown) or, with a callback, what
  // the callback makes of each element and its index.
  const arrayCtor = (node, base, n) => {
    const arr = arrayOf(node, K.NONE)
    if (n === 1) {
      const k = ks[base]
      if (hasTag(k, K.NUMBER)) raiseElem(arr, ABSENT)
      if ((k & TAGS & ~bitOf(K.NUMBER)) !== 0 || kspread[base]) raiseElem(arr, kspread[base] ? k : k & ~bitOf(K.NUMBER))
    } else for (let i = 0; i < n; i++) raiseElem(arr, ks[base + i])
    return arr
  }
  const arrayOfArgs = (node, base, n) => { const arr = arrayOf(node, K.NONE); for (let i = 0; i < n; i++) raiseElem(arr, ks[base + i]); return arr }
  const arrayFrom = (node, base, n) => {
    const arr = arrayOf(node, K.NONE)
    const src = n > 0 ? ks[base] : K.NONE, t = tagOf(src)
    const elem = t === K.NONE ? K.NONE : t === K.ARRAY ? elemOf(src) : t === K.TYPED ? typedElemKind(src) : t === K.STRING ? STRING : ANY
    if (n < 2) { raiseElem(arr, elem); return arr }
    const cb = ks[base + 1]
    if (tagOf(cb) === K.NONE) return arr
    if (tagOf(cb) !== K.CLOSURE || paramOf(cb) === UNKNOWN) { escapeArgs(base, n); raiseElem(arr, ANY); return arr }
    for (let i = 2; i < n; i++) escape(ks[base + i])
    raiseElem(arr, call2(paramOf(cb), elem, NUMBER))
    return arr
  }
  // `JSON.parse` of a string the program holds (a literal, a module const):
  // the parsed value, once per call node; each array in it owns a cell, an
  // object has the registry's shape or none. A reviver rebuilds every value.
  const NO_JSON = {}
  const jsonParsed = new Map()   // `JSON.parse` node → the parsed value, or NO_JSON
  const jsonValueOf = (node) => {
    let v = jsonParsed.get(node)
    if (v === undefined) {
      const a = node[2], s = Array.isArray(a) && a[0] === 'str' ? a[1] : typeof a === 'string' ? constString(a) : null
      const sources = typeof s === 'string' ? [s] : constStrings(a)
      try { v = sources?.length ? sources.map(s => JSON.parse(s)) : NO_JSON } catch { v = NO_JSON }
      jsonParsed.set(node, v)
    }
    return v
  }
  const jsonKind = (v) => {
    if (v === null) return NULLISH
    if (typeof v === 'number') return NUMBER
    if (typeof v === 'string') return STRING
    if (typeof v === 'boolean') return BOOL
    if (Array.isArray(v)) { const arr = arrayOf(v, K.NONE); for (const x of v) raiseElem(arr, jsonKind(x)); return arr }
    const names = Object.keys(v), sid = sidByKey.get(schemaKey(names, null))
    if (sid === undefined) { for (const name of names) escape(jsonKind(v[name])); return kind(K.OBJECT) }
    for (const name of names) raiseSlot(sid, schemas[sid].indexOf(name), jsonKind(v[name]))
    if (sid >= UNKNOWN) { poisonSchema(sid); return kind(K.OBJECT) }
    return kind(K.OBJECT, sid)
  }
  const jsonKinds = new Map()    // `JSON.parse` node → its value's kind, for readers
  const jsonParse = (node, base, n) => {
    if (n !== 1) { escapeArgs(base, n); return ANY }
    const values = jsonValueOf(node)
    let k = values === NO_JSON ? ANY : K.NONE
    if (values !== NO_JSON) for (const v of values) k = merge(k, jsonKind(v))
    jsonKinds.set(node, k)
    return k
  }
  const method = (recv, name, base, n, node = null) => {
    const t = tagOf(recv)
    if (t === K.NONE) return K.NONE  // the receiver is not known yet; a later round sees it
    // A member access on a nullish receiver throws before the call: the
    // function's receiver is the class alone.
    const classFn = classMember(recv, name)
    if (classFn) { const r = callWith(classFn, core(recv), base, n); if (memberMayBeOwn(name)) escapeArgs(base, n); return memberResult(recv, name, r) }
    callCandidates(recv, name, base, n)
    // A proven builtin receiver still permits an own data property to shadow
    // its prototype method. The packed summary does not retain per-instance
    // sidecar values, so decline to ANY rather than assert the builtin result.
    if (builtinReceiverMayHaveOwn(t, name)) {
      escapeArgs(base, n)
      return ANY
    }
    if (t === K.OBJECT && paramOf(recv) !== UNKNOWN) {
      const sid = paramOf(recv), i = schemas[sid].indexOf(name)
      if (i >= 0) {
        const fk = slots(sid)[i]
        if (tagOf(fk) === K.CLOSURE && paramOf(fk) !== UNKNOWN) return callClosure(paramOf(fk), base, n)
        if (tagOf(fk) !== K.NONE) { escapeArgs(base, n); return ANY }
        return K.NONE
      }
    }
    if (t === K.TYPED) {
      if (TYPED_SAME.has(name)) { if (name === 'map' || name === 'filter' || name === 'sort') escapeArgs(base, n); return name === 'set' ? NULLISH : kind(K.TYPED, typedSame(name, paramOf(recv))) }
      if (name === 'at') return orAbsent(typedElemKind(recv))
      if (name === 'indexOf' || name === 'lastIndexOf') return NUMBER
      if (name === 'reduce') return reduceResult(recv, base, n)
    }
    if (t === K.STRING) {
      // `replace`/`replaceAll` call a function argument the summary does not model.
      escapeArgs(base, n)
      if (name === 'at') return orAbsent(STRING)
      if (name === 'codePointAt') return orAbsent(NUMBER)
      if (STRING_METHODS.has(name)) return STRING
      if (STRING_NUMBER_METHODS.has(name)) return NUMBER
      if (STRING_BOOL_METHODS.has(name)) return BOOL
      if (name === 'split' && node) { const out = arrayOf(node, K.NONE); raiseElem(out, STRING); return out }
    }
    if (t === K.BUFFER && name === 'slice') return kind(K.BUFFER)
    if (t === K.ARRAY) {
      if (name === 'pop' || name === 'shift' || name === 'sort' || name === 'reverse' || name === 'splice' || name === 'copyWithin') invalidateTuple(recv)
      if (node && ARRAY_CALLBACKS.has(name)) return arrayCallback(node, recv, name, base, n)
      if (name === 'push' || name === 'unshift') { for (let i = 0; i < n; i++) raiseElem(recv, ks[base + i]); return NUMBER }
      if (name === 'indexOf' || name === 'lastIndexOf' || name === 'findIndex') { escapeArgs(base, n); return NUMBER }
      if (name === 'pop' || name === 'shift' || name === 'at' || name === 'find') { escapeArgs(base, n); return orAbsent(elemOf(recv)) }
      if (name === 'slice' || name === 'reverse' || name === 'sort') { escapeArgs(base, n); return recv }
      if (name === 'fill') { for (let i = 0; i < n; i++) raiseElem(recv, ks[base + i]); return recv }
      if (name === 'reduce' || name === 'reduceRight') return reduceResult(recv, base, n)
      // A copy of the receiver's elements and the arguments' (an array argument spreads its elements).
      if (name === 'concat' && node) {
        const out = arrayOf(node, K.NONE)
        raiseElem(out, elemOf(recv))
        for (let i = 0; i < n; i++) { const a = ks[base + i]; raiseElem(out, tagOf(a) === K.ARRAY ? elemOf(a) : a) }
        return out
      }
      // `splice(start, count, ...items)` stores the items (any argument from a
      // spread on may be one) and removes elements into a fresh array;
      // `toSpliced` copies instead. `with(i, v)` copies with v; `toSorted`,
      // `toReversed` and `flat` copy the elements (a flattened element's own);
      // `copyWithin` moves elements within the receiver.
      if ((name === 'splice' || name === 'toSpliced') && node) {
        const out = arrayOf(node, K.NONE)
        raiseElem(out, elemOf(recv))
        for (let i = Math.min(2, spreadAt(base, n)); i < n; i++) raiseElem(name === 'splice' ? recv : out, ks[base + i])
        return out
      }
      if (name === 'with' && node) { const out = arrayOf(node, K.NONE); raiseElem(out, elemOf(recv)); if (n > 1) raiseElem(out, ks[base + 1]); return out }
      if ((name === 'toSorted' || name === 'toReversed' || name === 'flat') && node) {
        escapeArgs(base, n)
        const out = arrayOf(node, K.NONE), e = elemOf(recv)
        raiseElem(out, name === 'flat' && tagOf(e) === K.ARRAY ? elemOf(e) : e)
        return out
      }
      if (name === 'copyWithin') return recv
      if (name === 'join') return STRING
      if (name === 'includes' || name === 'some' || name === 'every') { escapeArgs(base, n); return BOOL }
    }
    if (t === K.MAP) {
      if (name === 'set') { escapeObject(n > 0 ? ks[base] : K.NONE); if (n > 1) raiseElem(recv, ks[base + 1]); return recv }
      if (name === 'get') { escapeObjectArgs(base, n); return orAbsent(elemOf(recv)) }
      if (name === 'has' || name === 'delete' || name === 'clear') { escapeObjectArgs(base, n); return name === 'clear' ? NULLISH : BOOL }
    }
    if (t === K.SET && (name === 'add' || name === 'has' || name === 'delete')) { escapeObjectArgs(base, n); return name === 'add' ? recv : BOOL }
    escapeObjectArgs(base, n)
    if (t === K.OBJECT || t === K.HASH || t === K.ANY || t === K.ARRAY) escapeObject(recv)
    return builtinMethodResult(recv, name)
  }
  const literalKind = (v) => v == null ? NULLISH : typeof v === 'number' ? NUMBER : typeof v === 'string' ? STRING : typeof v === 'boolean' ? BOOL : typeof v === 'bigint' ? BIGINT : ANY
  // The receiver of a member access: a function's property (`parse.enter`, a
  // namespace) reads or stores on the function object and calls nothing, so
  // the function does not escape by it.
  const receiver = (n) => typeof n === 'string' && funcByName.has(n) && keyOf(n) === null ? kind(K.CLOSURE) : expr(n)

  // A static object literal's shape is structural: its schema (or the
  // registry's silence) is looked up once per node. A literal with a spread
  // or a computed key is shaped by its sources, each round.
  const NO_SID = -1, DYNAMIC_LITERAL = -2
  const literalSids = new Map()   // `{}` node → sid, NO_SID (its own shape, unregistered) or DYNAMIC_LITERAL
  const literalSid = (n) => {
    let sid = literalSids.get(n)
    if (sid === undefined) {
      const names = []
      let brand = null
      sid = NO_SID
      for (let i = 1; i < n.length; i++) {
        const p = n[i]
        const key = typeof p === 'string' ? p : Array.isArray(p) && p[0] === ':' && typeof p[1] === 'string' ? p[1] : null
        if (key === null) { sid = DYNAMIC_LITERAL; break }
        if (isBrand(key)) brand = key; else if (!names.includes(key)) names.push(key)
      }
      if (sid === NO_SID) sid = sidByKey.get(schemaKey(names, brand)) ?? NO_SID
      literalSids.set(n, sid)
    }
    return sid
  }
  /** A literal with a spread or a computed key, walked by its sources. */
  const dynamicLiteral = (n) => {
    // The single-source lowering clones its runtime representation. A clone
    // may share conservative content facts without sharing runtime storage.
    if (n.length === 2 && n[1]?.[0] === '...') {
      const source = expr(n[1][1]), t = tagOf(source)
      if (t === K.NONE) return K.NONE
      return !isNullable(source) && (t === K.OBJECT || t === K.HASH) ? source : cellOf(n, K.HASH, ANY)
    }
    const writes = [], names = [], init = definite.get(n)
    let brand = null, dynamic = false
    const add = (name, value) => { if (!names.includes(name)) names.push(name); writes.push([name, value]) }
    for (let i = 1; i < n.length; i++) {
      const p = n[i]
      if (Array.isArray(p) && p[0] === ':' && typeof p[1] === 'string') {
        if (isBrand(p[1])) brand = p[1]
        else add(p[1], init?.has(p[1]) && isNullishLit(p[2]) ? K.NONE : expr(p[2]))
      } else if (typeof p === 'string') add(p, expr(p))
      else if (Array.isArray(p) && p[0] === '...') {
        const source = expr(p[1]), sourceSid = tagOf(source) === K.OBJECT ? paramOf(source) : UNKNOWN
        // Conditional insertion uses a dictionary even when every present
        // source has one schema: an absent key differs from an undefined slot.
        if (p[1]?.[0] === '&&' || isNullable(source) || sourceSid === UNKNOWN || openSchemas.has(sourceSid) || !schemas[sourceSid]) {
          escape(source)
          dynamic = true
          continue
        }
        const sourceSlots = slots(sourceSid)
        for (let j = 0; j < schemas[sourceSid].length; j++) add(schemas[sourceSid][j], sourceSlots[j])
      } else {
        if (Array.isArray(p)) for (let j = 1; j < p.length; j++) escape(expr(p[j]))
        dynamic = true
      }
    }
    // An unresolved key/spread changes storage, not evaluation: later
    // initializers still run, and their callbacks can escape through the dict.
    if (dynamic) {
      for (const [, v] of writes) escape(v)
      return cellOf(n, K.HASH, ANY)
    }
    const sid = sidByKey.get(schemaKey(names, brand))
    if (sid === undefined) {
      for (const [, v] of writes) escape(v)
      // A spread's representation still depends on its sources.
      return kind(K.OBJECT) | bitOf(K.HASH)
    }
    for (const [name, value] of writes) raiseSlot(sid, schemas[sid].indexOf(name), value)
    if (sid >= UNKNOWN) { poisonSchema(sid); return kind(K.OBJECT) }
    return kind(K.OBJECT, sid)
  }
  /** A static literal: each value into its slot, or escaped when the registry has not named the shape. */
  const staticLiteral = (n, sid) => {
    const init = definite.get(n)
    for (let i = 1; i < n.length; i++) {
      const p = n[i]
      let name, value
      if (typeof p === 'string') { name = p; value = expr(p) }
      else { if (isBrand(p[1])) continue; name = p[1]; value = init?.has(p[1]) && isNullishLit(p[2]) ? K.NONE : expr(p[2]) }
      if (sid === NO_SID) escape(value); else raiseSlot(sid, schemas[sid].indexOf(name), value)
    }
    // A static literal has its own shape even when the registry has not named it.
    if (sid === NO_SID) return kind(K.OBJECT)
    if (sid >= UNKNOWN) { poisonSchema(sid); return kind(K.OBJECT) }
    return kind(K.OBJECT, sid)
  }
  /** A member read `recv.prop` (`op`: `.` or `?.`). */
  const member = (op, recv, prop) => {
    const t = tagOf(recv)
    if (t === K.NONE) return optionalResult(op, recv, K.NONE)
    if (t === K.OBJECT && paramOf(recv) !== UNKNOWN) {
      const i = schemas[paramOf(recv)].indexOf(prop)
      if (i >= 0) return optionalResult(op, recv, slots(paramOf(recv))[i])
      // a class's getter, or a method read as a value: bound by its binder
      const getter = classMember(recv, getterOf(prop))
      if (getter) return optionalResult(op, recv, memberResult(recv, prop, callWith(getter, core(recv))))
      const fn = classMember(recv, prop)
      if (fn) return optionalResult(op, recv, memberResult(recv, prop, callWith(binderOf(fn), core(recv))))
      return optionalResult(op, recv, memberMayBeOwn(prop) ? ANY : NULLISH)
    }
    if (unknownReceiver(recv)) {
      callCandidates(recv, getterOf(prop), 0, 0)
      if (!prop.endsWith(ACCESSOR_GET) && !prop.endsWith(ACCESSOR_SET)) for (const fn of membersByName.get(prop) ?? NO_MEMBERS) callWith(binderOf(fn), recv)
    }
    if (t === K.HASH) return optionalResult(op, recv, orAbsent(elemOf(recv)))
    if (isCount(prop, recv)) return optionalResult(op, recv, NUMBER)
    if (prop === 'buffer' && t === K.TYPED) return optionalResult(op, recv, kind(K.BUFFER))
    if (t === K.ARRAY && paramOf(recv) !== UNKNOWN && !ARRAY_METHODS.has(prop)) return optionalResult(op, recv, orAbsent(propOf(recv, prop)))
    return optionalResult(op, recv, ANY)
  }
  /** The kind of an expression, with its effects: calls bind parameters, stores raise slots. */
  const expr = n => selectedExpr(n, 7)
  const selectedExpr = (n, mask) => {
    const logical = Array.isArray(n) ? logicalMask(n[0]) : 0
    if (mask !== 7 && !logical) return selectKind(expr(n), mask)
    if (n == null) return NULLISH
    if (typeof n === 'number') return NUMBER
    if (typeof n === 'string') {
      const key = keyOf(n)
      if (key === null) return funcByName.has(n) ? kind(K.CLOSURE, closureSet([n])) : ANY  // a name from outside the program
      if (bindingScope[key] !== (current ?? MODULE)) {
        let keys = captures.get(current)
        if (!keys) captures.set(current, keys = new Set())
        if (!keys.has(key)) { keys.add(key); changed = true }
      }
      // A binding this walk models is bottom until the fixpoint reaches its assignments.
      const k = (post.get(key) ?? (pre.has(key) ? incoming[key] : kinds[key])) ?? K.NONE
      const mask = refined.get(key)
      return mask === undefined ? k : refine(k, mask)
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
    if (op === '{}') { const sid = literalSid(n); return sid === DYNAMIC_LITERAL ? dynamicLiteral(n) : staticLiteral(n, sid) }
    if (op === '[') {
      const arr = arrayOf(n, K.NONE), id = paramOf(arr)
      if (id !== UNKNOWN && !tuples.has(cell(id))) tuples.set(cell(id), [])
      let elem = K.NONE
      for (let i = 1; i < n.length; i++) {
        const k = expr(n[i]), row = id === UNKNOWN ? null : tuples.get(cell(id))
        if (Array.isArray(n[i]) && n[i][0] === '...') invalidateTuple(arr)
        else if (row) { const next = merge(row[i - 1] ?? K.NONE, k); if (next !== row[i - 1]) { row[i - 1] = next; changed = true } }
        elem = merge(elem, k)
      }
      raiseElem(arr, elem, true)
      return arr
    }
    if (op === '.' || op === '?.') {
      const recv = receiver(n[1]), prop = n[2]
      if (op === '?.' && tagOf(core(recv)) === K.NONE) return NULLISH
      if (typeof prop !== 'string') { expr(prop); return optionalResult(op, recv, tagOf(recv) === K.NONE ? K.NONE : ANY) }
      return member(op, recv, prop)
    }
    if (op === '[]') {
      const recv = receiver(n[1]), idx = n[2], t = tagOf(recv)
      if (Array.isArray(idx) && idx[0] == null && typeof idx[1] === 'string') return member('.', recv, idx[1])
      const ik = expr(idx)
      if (t === K.NONE) return K.NONE
      if (t === K.TYPED) return typedReadPresent(current ?? MODULE, n) ? typedElemKind(recv) : orAbsent(typedElemKind(recv))
      if (t === K.HASH) return orAbsent(elemOf(recv))
      if (t === K.ARRAY) {
        const row = paramOf(recv) === UNKNOWN ? null : tuples.get(cell(paramOf(recv)))
        const i = typeof idx === 'number' ? idx : Array.isArray(idx) && idx[0] == null ? idx[1] : null
        if (row && Number.isInteger(i) && i >= 0) return row[i] ?? ABSENT
        return orAbsent(entryOf(recv, ik))
      }
      if (t === K.STRING) return STRING
      // A computed key on a known shape reads one of its slots (a dispatch table's member), or misses.
      if (t === K.OBJECT && paramOf(recv) !== UNKNOWN) { let k = K.NONE; for (const s of slots(paramOf(recv))) k = merge(k, s); return orAbsent(k) }
      return ANY
    }
    if (op === '()') {
      if (n.length === 2) return expr(n[1])  // a grouping `(e)`: a call always carries its argument slot
      const callee = n[1], base = pushArgs(n[2]), count = sp - base
      let r
      if (Array.isArray(callee) && (callee[0] === '.' || callee[0] === '?.') && typeof callee[2] === 'string') {
        const recv = receiver(callee[1])
        r = optionalResult(callee[0], recv, method(recv, callee[2], base, count, n))
      }
      else if (callee === 'new.Map') r = mapOf(n, base, count)
      else if (callee === 'Object.keys' || callee === 'Object.values') {
        const source = count ? ks[base] : ANY, t = tagOf(source)
        let value = callee === 'Object.keys' ? STRING : ANY
        if (callee === 'Object.values') {
          if (t === K.NONE) value = K.NONE
          else if (t === K.OBJECT && paramOf(source) !== UNKNOWN && !openSchemas.has(paramOf(source))) {
            value = K.NONE
            for (const slot of slots(paramOf(source))) value = merge(value, slot)
          } else if (t === K.HASH) value = elemOf(source)
          else if (t === K.ARRAY) value = merge(elemOf(source), anyPropOf(source))
        }
        r = arrayOf(n, value)
      }
      else if (callee === 'new.Array' || callee === 'Array') r = arrayCtor(n, base, count)
      else if (callee === 'Array.of') r = arrayOfArgs(n, base, count)
      else if (callee === 'Array.from') r = arrayFrom(n, base, count)
      else if (callee === 'JSON.parse') r = jsonParse(n, base, count)
      else if (typeof callee === 'string') r = call(callee, base, count)
      else {
        const ck = expr(callee)
        if (tagOf(ck) === K.NONE) r = K.NONE
        else if (tagOf(ck) === K.CLOSURE && paramOf(ck) !== UNKNOWN) r = callClosure(paramOf(ck), base, count)
        else { escapeObjectArgs(base, count); r = ANY }
      }
      sp = base
      return r
    }
    if (MUTATE_OPS.has(op)) return assign(op, n[1], n[2])
    if (isPostfixRecovery(op, n[1], n[2])) return expr(n[1])
    if (op === '+') return plus(expr(n[1]), expr(n[2]))
    if (NUMBER_OPS.has(op) || op === 'u-') { let k = n.length > 2 ? expr(n[1]) : arith(op, expr(n[1])); for (let i = 2; i < n.length; i++) k = arith(op, k, expr(n[i])); return k }
    if (op === '+1' || op === '-1') return arith(op, expr(n[1]))  // a member's ++/-- (prepare)
    if (op === 'u+') { expr(n[1]); return NUMBER }
    if (BOOL_OPS.has(op)) { for (let i = 1; i < n.length; i++) expr(n[i]); return BOOL }
    if (logical) {
      const a = selectedExpr(n[1], mask & logical)
      branch++
      const mark = rtop
      proves(n[1], op === '&&')
      const b = selectedExpr(n[2], mask)
      unwind(mark)
      branch--
      return merge(a, b)
    }
    if (op === '?' || op === '?:') {
      expr(n[1])
      branch++
      const mark = rtop
      proves(n[1], true)
      const a = expr(n[2])
      unwind(mark)
      proves(n[1], false)
      const b = expr(n[3])
      unwind(mark)
      branch--
      return merge(a, b)
    }
    if (op === ',') { let k = NULLISH; for (let i = 1; i < n.length; i++) k = expr(n[i]); return k }
    if (op === 'typeof') { expr(n[1]); return STRING }
    if (op === 'delete') { stmt(n); return BOOL }
    if (op === 'void') { expr(n[1]); return NULLISH }
    if (op === 'await') return expr(n[1]) === K.NONE ? K.NONE : ANY
    // A spread reads its source's elements (an array's, a typed array's, a
    // string's characters); a source of another kind is iterated by code the summary does not model.
    if (op === '...') { const k = expr(n[1]), t = tagOf(k); if (t === K.ARRAY && celled(k)) return elemOf(k); if (t === K.TYPED) return typedElemKind(k); if (t === K.STRING) return STRING; if (t === K.NONE) return K.NONE; escape(k); return ANY }
    for (let i = 1; i < n.length; i++) stmt(n[i])
    return ANY
  }

  /** `target op= value`: the stored kind reaches the binding or the slot; returns the expression's kind. */
  const assign = (op, target, value) => {
    const logical = op === '||=' || op === '&&=' || op === '??='
    let v
    if (op === '=') v = expr(value)
    else if (op === '+=') v = plus(expr(target), expr(value))
    else if (logical) v = merge(expr(target), expr(value))
    else { const a = expr(target); v = value == null ? arith(op, a) : arith(op, a, expr(value)) }
    if (typeof target === 'string') {
      const key = keyOf(target)
      if (key !== null) {
        pre.delete(key); refined.delete(key)
        // A straight-line assignment is the value the reads after it see; one on a path is not.
        if (branch === 0 && current !== null) post.set(key, v); else post.delete(key)
        raise(kinds, key, v)
      }
      return v
    }
    if (Array.isArray(target) && (target[0] === '.' || target[0] === '?.')) {
      const recv = receiver(target[1]), prop = target[2], t = tagOf(recv)
      if (t === K.NONE) return v
      if (typeof prop !== 'string') { poisonAll(recv, expr(prop)); escape(v); return v }
      markBuiltinOwn(t, prop)
      if (t === K.OBJECT && paramOf(recv) !== UNKNOWN) {
        const i = schemas[paramOf(recv)].indexOf(prop), setter = i < 0 ? classMember(recv, setterOf(prop)) : null
        if (i >= 0) raiseSlot(paramOf(recv), i, v); else if (setter) { const b = sp; pushK(core(recv)); pushK(v); call(setter, b, 2); sp = b } else { poisonSchema(paramOf(recv)); dynamicProps.add(prop) }
      }
      // A length store extends an array with holes (`a.length = n`: the new slots read undefined).
      else if (t === K.ARRAY) { if (prop === 'length') raiseElem(recv, ABSENT); else if (paramOf(recv) !== UNKNOWN) raiseProp(recv, prop, v); else escape(v) }
      else if (t === K.HASH) { if (paramOf(recv) !== UNKNOWN) raiseElem(recv, v); else escape(v) }
      else if (builtinReceiverTag(t)) escape(v)
      else if (t !== K.STRING) { if (unknownReceiver(recv)) { const b = sp; pushK(v); callCandidates(recv, setterOf(prop), b, 1); sp = b } poisonProp(prop); dynamicProps.add(prop); escape(v) }
      return v
    }
    if (Array.isArray(target) && target[0] === '[]') {
      const recv = receiver(target[1]), idx = target[2], t = tagOf(recv)
      if (Array.isArray(idx) && idx[0] == null && typeof idx[1] === 'string') return assign(op, ['.', target[1], idx[1]], value)
      const ik = expr(idx)
      if (t === K.ARRAY) { if (paramOf(recv) !== UNKNOWN) raiseEntry(recv, ik, v); else escape(v) }
      else if (t === K.HASH) { if (paramOf(recv) !== UNKNOWN) raiseElem(recv, v); else escape(v) }
      else if (t === K.TYPED) return typedStore(typedElemKind(recv), v)
      else if (t !== K.NONE && t !== K.STRING) { poisonAll(recv, ik); escapeObject(v) }
      return v
    }
    escape(v)
    return v
  }
  // A computed-key store may reach any slot; one with a number key only a
  // slot named like an index. A key of bottom kind is not known yet: a
  // later round decides. A dictionary has no slots. Poisoning is monotone:
  // a store through an unknown receiver reaches every schema once, and a
  // later one only the schemas registered since (`poisonedAll`,
  // `poisonedIndexed` count them; the seeded rerun clears the slots and them).
  const indexSlots = []   // sid → the indices of its index-like props
  const indexSlotsOf = (sid) => { let l = indexSlots[sid]; if (l === undefined) { l = []; schemas[sid].forEach((p, i) => { if (/^\d+$/.test(p)) l.push(i) }); indexSlots[sid] = l } return l }
  const poisonIndexed = (sid) => { openSchema(sid); for (const i of indexSlotsOf(sid)) raiseSlot(sid, i, ANY) }
  let poisonedAll = 0, poisonedIndexed = 0
  const poisonAll = (recv, key = ANY) => {
    if (tagOf(key) === K.NONE || tagOf(recv) === K.HASH) return
    const numeric = tagOf(key) === K.NUMBER
    if (tagOf(recv) === K.OBJECT && paramOf(recv) !== UNKNOWN) { if (numeric) poisonIndexed(paramOf(recv)); else poisonSchema(paramOf(recv)); return }
    if (numeric) { for (let sid = poisonedIndexed; sid < schemas.length; sid++) poisonIndexed(sid); poisonedIndexed = schemas.length }
    else { for (let sid = poisonedAll; sid < schemas.length; sid++) poisonSchema(sid); poisonedAll = schemas.length }
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
  // Definite initialization is structural: a literal is examined once.
  const definiteSeen = new Set()
  const noteDefinite = (list, from) => {
    const d = list[from]
    if (!Array.isArray(d) || (d[0] !== 'let' && d[0] !== 'const') || d.length !== 2 || !Array.isArray(d[1]) || d[1][0] !== '=' || typeof d[1][1] !== 'string') return
    const name = d[1][1], lit = d[1][2]
    if (!Array.isArray(lit) || lit[0] !== '{}' || lit.length < 2 || definiteSeen.has(lit)) return
    definiteSeen.add(lit)
    let nullish = false
    for (let i = 1; i < lit.length; i++) { const p = lit[i]; if (!Array.isArray(p) || p[0] !== ':' || typeof p[1] !== 'string') return; if (isNullishLit(p[2])) nullish = true }
    if (!nullish) return
    const assigned = new Set()
    definiteStores(list, from + 1, name, assigned, new Set())
    if (assigned.size) definite.set(lit, assigned)
  }

  const declare = (name, k) => { const key = keyOf(name); if (key !== null) raise(kinds, key, k) }
  // A declaration without a value is absent until assigned (`let buf; export
  // const setup = () => buf = new Float64Array(n)`: a read before `setup` is one
  // the program does not mean to make).
  const decl = (n) => { for (let i = 1; i < n.length; i++) { const d = n[i]; if (typeof d === 'string') declare(d, ABSENT); else if (Array.isArray(d) && d[0] === '=') { if (typeof d[1] === 'string') declare(d[1], literalInto(d[1], d[2])); else { escape(expr(d[2])); pattern(d[1]) } } } }
  // A `{}` declared into a name is allocated as the runtime allocates it
  // (module/object.js's `{}`): with the binding's schema when that holds every
  // literal key (`let o = {}` then `o.a = 1` merges `a` into it), an empty one
  // into a computed-key binding with no schema as a HASH, else as its own shape.
  const literalShapes = new Map()   // `{}` node → its static shape, or null, read once
  const literalShapeOf = (n) => { let shape = literalShapes.get(n); if (shape === undefined) literalShapes.set(n, shape = literalShape(n)); return shape }
  const coversShape = (props, shape) => { for (const p of shape.props) if (!props.includes(p)) return false; return true }
  const literalInto = (name, value) => {
    const shape = Array.isArray(value) && value[0] === '{}' ? literalShapeOf(value) : null
    if (!shape) return expr(value)
    const bound = boundSchema(name), props = bound == null ? null : schemas[bound]
    if (value.length === 1 && !props?.length && dictKeys.has(keyOf(name))) return cellOf(value, K.HASH, K.NONE)
    if (props && coversShape(props, shape)) {
      // Each value into the binding's slot, in key order; a definite initialization's `undefined` is no value.
      const init = definite.get(value)
      for (let i = 1; i < value.length; i++) { const p = value[i]; if (typeof p === 'string') raiseSlot(bound, props.indexOf(p), expr(p)); else if (!isBrand(p[1])) raiseSlot(bound, props.indexOf(p[1]), init?.has(p[1]) && isNullishLit(p[2]) ? K.NONE : expr(p[2])) }
      return kind(K.OBJECT, bound)
    }
    return expr(value)
  }
  const pattern = (p) => { if (typeof p === 'string') declare(p, ANY); else if (Array.isArray(p)) for (let i = 1; i < p.length; i++) pattern(Array.isArray(p[i]) && p[i][0] === ':' ? p[i][2] : Array.isArray(p[i]) && p[i][0] === '=' ? p[i][1] : p[i]) }

  // Scopes: a function (its name), a closure (its id) or the module (null).
  // A scope declares its parameters, its `let`/`const`/`var` names, loop
  // variables and catch parameters; a closure's parent is the scope its
  // literal sits in. Each declaration owns one numeric binding id; a name no scope
  // in the chain declares is the module's, and one the module does not
  // declare either is from outside the program (null).
  const declared = new Map()         // scope → Map(name → binding id)
  let nextBinding = 0
  const bindingScope = [], captures = new Map()
  const parent = new Map()           // closure id → scope
  const scopeOfSig = new Map(funcs.map(f => [f.sig, f.name]))   // a function's signature record → its scope, for readers
  const scopeOfBody = new Map(funcs.filter(f => f.body !== null && typeof f.body === 'object').map(f => [f.body, f.name]))   // a function's block body → its scope; a closure's is in closuresByBody
  const scopeOfParams = new Map()    // a closure's parameter node (its stable identity through emission) → its id
  const MODULE = ''
  const nameKeys = new Map()         // name → binding ids (one, or a function and its specialized variants)
  const writes = []                 // collected beside declarations; one initializer proves a fixed extent
  const declareIn = (scope, name) => {
    let d = declared.get(scope)
    if (!d) declared.set(scope, d = new Map())
    if (d.has(name)) return
    const key = nextBinding++
    bindingScope[key] = scope
    d.set(name, key)
    let keys = nameKeys.get(name)
    if (!keys) nameKeys.set(name, keys = [])
    keys.push(key)
  }
  const collect = (n, scope) => {
    if (!Array.isArray(n)) return
    const op = n[0]
    if (op === 'let' || op === 'const' || op === 'var') {
      for (let i = 1; i < n.length; i++) {
        const d = n[i], name = typeof d === 'string' ? d : d?.[0] === '=' ? d[1] : null
        if (typeof name === 'string') { declareIn(scope, name); writes.push([scope, name, typeof d === 'string' ? null : d[2]]) }
        if (Array.isArray(d)) collect(d[2], scope)
      }
      return
    }
    else if (op === '=>') {
      const id = closureId(n)
      parent.set(id, scope); scopeOfParams.set(n[1], id)
      for (const p of paramNames(n[1])) if (p != null) declareIn(id, p)
      const defaults = closureDefaults[id]
      if (defaults) for (const name in defaults) collect(defaults[name], id)
      collect(n[2], id)
      return
    }
    else if (op === 'for-of' || op === 'for-in' || op === 'for-await') { const t = Array.isArray(n[1]) && (n[1][0] === 'let' || n[1][0] === 'const' || n[1][0] === 'var') ? n[1][1] : n[1]; if (typeof t === 'string') declareIn(scope, t) }
    else if (op === 'catch' && typeof n[2] === 'string') declareIn(scope, n[2])
    if (MUTATE_OPS.has(op) && typeof n[1] === 'string') writes.push([scope, n[1], null])
    // Writes make an empty literal a dictionary unless it has a materialized schema.
    if (MUTATE_OPS.has(op) && Array.isArray(n[1]) && (n[1][0] === '[]' || n[1][0] === '.')) { let root = n[1][1]; while (Array.isArray(root) && root[0] === '[]') root = root[1]; if (typeof root === 'string') dictUses.push([scope, root]) }
    if (op === '()' && n[1] === 'Object.assign') { const t = args(n[2])[0]; if (typeof t === 'string') dictUses.push([scope, t]) }
    for (let i = 1; i < n.length; i++) collect(n[i], scope)
  }
  const dictUses = [], dictKeys = new Set()   // computed-write roots, then their resolved binding keys
  for (const f of funcs) {
    for (const p of f.sig.params) declareIn(f.name, p.name)
    if (f.rest) declareIn(f.name, f.rest)
    if (f.defaults) for (const name in f.defaults) collect(f.defaults[name], f.name)
    collect(f.body, f.name)
  }
  for (const top of tops) collect(top, MODULE)
  // Declarations own identity. Solver and queries reuse the same id instead
  // of probing a second table or constructing/hashing scoped strings.
  const keyIn = (scope, name) => declared.get(scope)?.get(name)
  /** The key of `name` read in `current`'s scope chain, or null for a name from outside the program. */
  const keyOf = (name, scope = current ?? MODULE) => {
    for (let s = scope; ; s = parent.get(s) ?? MODULE) {
      const key = keyIn(s, name)
      if (key !== undefined) return key
      if (s === MODULE) return null
    }
  }

  let current = null  // the scope (and result key) of the function being walked; null at module scope
  for (const [scope, name] of dictUses) { current = scope === MODULE ? null : scope; const key = keyOf(name); if (key !== null) dictKeys.add(key) }
  current = null
  const definitions = new Map()
  for (const [scope, name, value] of writes) {
    const key = keyOf(name, scope)
    if (key !== null) definitions.set(key, definitions.has(key) || value == null ? null : [scope, value])
  }
  const staticValue = (scope, node, seen = new Set()) => {
    if (typeof node === 'string') {
      const key = keyOf(node, scope), def = definitions.get(key)
      if (!def || seen.has(key)) return null
      seen.add(key)
      return staticValue(def[0], def[1], seen)
    }
    return Array.isArray(node) && node[0] == null ? node[1] : typeof node === 'number' ? node : null
  }
  const typedReadPresent = (scope, node) => {
    if (typeof node[1] !== 'string') return false
    const def = definitions.get(keyOf(node[1], scope))
    if (!def) return false
    const init = def[1]
    if (!Array.isArray(init) || init[0] !== '()' || typeof init[1] !== 'string' || !init[1].startsWith('new.') || !TYPED_CTOR.test(init[1])) return false
    const len = staticValue(def[0], init[2]), i = staticValue(scope, node[2])
    return Number.isInteger(len) && Number.isInteger(i) && i >= 0 && i < len
  }
  const stmt = (n) => {
    if (n == null) return
    if (typeof n === 'string') { expr(n); return }
    if (!Array.isArray(n)) return
    const op = n[0]
    if (op === 'let' || op === 'const' || op === 'var') return decl(n)
    if (op === 'return') { if (current != null) raiseResult(current, n.length > 1 ? expr(n[1]) : NULLISH); return }
    if (op === ';' || op === '{}') {
      // A guard that leaves (`if (x == null) return`) proves its names for the statements after it.
      const mark = rtop
      for (let i = 1; i < n.length; i++) {
        noteDefinite(n, i); stmt(n[i])
        const st = n[i]
        if (Array.isArray(st) && st[0] === 'if' && st[3] == null && exits(st[2])) proves(st[1], false)
      }
      unwind(mark)
      return
    }
    if (op === 'for') { loopAssigns(n); stmt(n[1]); branch++; expr(n[2]); expr(n[3]); stmt(n[4]); branch--; return }
    if (op === 'for-of' || op === 'for-in' || op === 'for-await') {
      loopAssigns(n)
      const it = expr(n[2]), target = Array.isArray(n[1]) && (n[1][0] === 'let' || n[1][0] === 'const' || n[1][0] === 'var') ? n[1][1] : n[1]
      if (typeof target === 'string') declare(target, op === 'for-in' ? STRING : tagOf(it) === K.ARRAY ? elemOf(it) : tagOf(it) === K.TYPED ? typedElemKind(it) : tagOf(it) === K.STRING ? STRING : ANY)
      else pattern(target)
      branch++; stmt(n[3]); branch--
      return
    }
    if (op === 'if') {
      expr(n[1])
      branch++
      const mark = rtop
      proves(n[1], true); stmt(n[2]); unwind(mark)
      proves(n[1], false); stmt(n[3]); unwind(mark)
      branch--
      return
    }
    if (op === 'while' || op === 'do') { loopAssigns(n); branch++; expr(n[1]); stmt(n[2]); branch--; return }
    // Prepared try statements: `['catch', tryBody, param?, handler]`, `['finally', inner, cleanup]`.
    if (op === 'catch') { branch++; stmt(n[1]); if (typeof n[2] === 'string') declare(n[2], ANY); stmt(n[3]); branch--; return }
    if (op === 'finally') { branch++; stmt(n[1]); stmt(n[2]); branch--; return }
    if (op === 'throw') { escapeObject(expr(n[1])); return }
    if (op === 'delete') {
      // Prepared as `['delete', receiver, key]`. A static key on a fixed shape
      // is rejected downstream; a computed key may remove any slot.
      const r = expr(n[1]), k = expr(n[2])
      if (tagOf(r) === K.ARRAY) invalidateTuple(r)
      if (tagOf(r) === K.OBJECT || tagOf(r) === K.ANY) poisonAll(r, k)
      return
    }
    if (op === 'switch') { expr(n[1]); branch++; for (let i = 2; i < n.length; i++) stmt(n[i]); branch--; return }
    if (op === 'case') { expr(n[1]); for (let i = 2; i < n.length; i++) stmt(n[i]); return }
    if (op === 'label') { stmt(n[2]); return }
    if (op === 'break' || op === 'continue' || op === 'default') return
    if (op === 'export') { for (let i = 1; i < n.length; i++) stmt(n[i]); return }
    expr(n)
  }
  // `['{}', …]` is an object literal when every child is a property (`[':', k, v]`,
  // a shorthand name, a spread); a block holds statements.
  const isLiteral = (n) => {
    if (n.length < 2) return false
    for (let i = 1; i < n.length; i++) { const p = n[i]; if (typeof p !== 'string' && !(Array.isArray(p) && (p[0] === ':' || p[0] === '...'))) return false }
    return true
  }
  const isBlock = (body) => Array.isArray(body) && body[0] === '{}' && !isLiteral(body)
  // The walk's flow-sensitive state, one function at a time (the fixpoint
  // walks each function and closure body on its own, then the module).
  // The parameters whose reads, so far in the walk, precede every reassignment
  // of them: a straight-line read sees the incoming kind. A loop that assigns a
  // parameter ends the region at its head (a read may follow the previous
  // iteration's store); a closure's body sees the join (it runs whenever).
  const pre = new Set()     // binding ids before their first reassignment
  // The bindings a straight-line assignment of the function's own body gave a
  // value (`x = +x` at entry; `s = String(s)`): the reads after it see that
  // kind alone. An assignment on a path (a branch, a loop body, an arm) ends
  // the region, as does a loop that assigns the name, at its head.
  const post = new Map()    // binding id → straight-line assigned kind
  let branch = 0            // the depth of paths (branches, loop bodies, arms) the walk is in
  // The names a subtree assigns (`x = …`, `x += …`, a `let x = …`): structural, listed once per node.
  const assignsIn = (n, out) => {
    if (!Array.isArray(n)) return
    if (MUTATE_OPS.has(n[0]) && typeof n[1] === 'string') out.add(n[1])
    for (let i = 1; i < n.length; i++) assignsIn(n[i], out)
  }
  const assigned = new Map()   // loop or closure node → the names it assigns
  const assignedIn = (n) => { let l = assigned.get(n); if (!l) { const out = new Set(); assignsIn(n, out); assigned.set(n, l = [...out]) } return l }
  const loopAssigns = (n) => {
    for (const name of assignedIn(n)) {
      const key = keyOf(name)
      if (key !== null) { pre.delete(key); refined.delete(key); post.delete(key) }
    }
  }
  // Refinement: the tags a path proves a name's kind within. A condition proves
  // them when true (`x`, `x != null` and `x !== undefined`: no nullish tag;
  // `typeof x === 'bigint'`: that tag; an `&&` of these) or when false (`!x`,
  // `x == null`, `typeof x !== 't'`, an `||` of those); the walk of a branch,
  // an arm or the statements after a guard that leaves reads the name's kind
  // masked to them. An assignment ends the proof; a loop that assigns the name
  // ends it at its head; a closure's body starts without any. A proof is
  // pushed on one stack and unwound to the mark taken before it, restoring
  // the prior masks in reverse.
  const refined = new Map() // binding id → the tag bits its kind is read within
  const rKeys = [], rPriors = []
  let rtop = 0
  const refineName = (name, mask) => {
    const key = keyOf(name)
    if (key === null) return
    const prior = refined.get(key)
    if (rtop === rKeys.length) { rKeys.push(key); rPriors.push(prior) } else { rKeys[rtop] = key; rPriors[rtop] = prior }
    rtop++
    refined.set(key, (prior ?? TAGS) & mask)
  }
  const unwind = (mark) => { while (rtop > mark) { rtop--; const key = rKeys[rtop], prior = rPriors[rtop]; if (prior === undefined) refined.delete(key); else refined.set(key, prior) } }
  const refine = (k, mask) => { const r = k & (mask | UNKNOWN); return (r & TAGS) === 0 ? 0 : r }
  const NOT_NULLISH = TAGS & ~NULL_BITS
  const TYPEOF_TAGS = {
    number: bitOf(K.NUMBER), string: bitOf(K.STRING), boolean: bitOf(K.BOOL), bigint: bitOf(K.BIGINT), function: bitOf(K.CLOSURE),
    object: TAGS & ~(bitOf(K.NUMBER) | bitOf(K.STRING) | bitOf(K.BOOL) | bitOf(K.BIGINT) | bitOf(K.CLOSURE) | bitOf(K.ABSENT)),
    undefined: NULL_BITS,
  }
  const TYPEOF_NAME = Object.fromEntries(Object.entries(TYPEOF).map(([name, code]) => [code, name]))
  const isNullishRef = (v) => isNullishLit(v) || v === 'undefined' || v === 'null'
  const typeofPredicates = new Map()   // condition node → its typeof predicate, or null, read once
  const typeofPredicateOf = (c) => { let tp = typeofPredicates.get(c); if (tp === undefined) typeofPredicates.set(c, tp = typeofPredicate(c)); return tp }
  /** Push what the condition `c` proves when it is `when`. */
  const proves = (c, when) => {
    if (typeof c === 'string') { if (when) refineName(c, NOT_NULLISH); return }
    if (!Array.isArray(c)) return
    const op = c[0]
    if (op === '!') { proves(c[1], !when); return }
    if (op === '()' && c.length === 2) { proves(c[1], when); return }
    if ((op === '&&' && when) || (op === '||' && !when)) { proves(c[1], when); proves(c[2], when); return }
    const tp = typeofPredicateOf(c)
    if (tp) {
      const bits = TYPEOF_TAGS[typeof tp.code === 'string' ? tp.code : TYPEOF_NAME[tp.code]]
      if (bits !== undefined) {
        // NULLISH conflates null (`typeof` object) and undefined. A negative
        // test against either category cannot remove that shared tag: one of
        // its runtime members still takes the branch.
        const inverse = (TAGS & ~bits) | (bits & bitOf(K.NULLISH))
        refineName(tp.name, tp.eq === when ? bits : inverse)
      }
      return
    }
    if (typeof c[1] !== 'string' || !isNullishRef(c[2])) return
    // A strict comparison excludes only one sentinel. NULLISH includes both,
    // so its other member must survive (as with the typeof inverse above).
    if (op === '!=' && when || op === '==' && !when) refineName(c[1], NOT_NULLISH)
  }
  /** The statement leaves its list: a return, throw, break or continue; a block ending in one; an
   *  `if` both of whose branches do; a `try` whose block and every catch do (or whose finally does). */
  const exits = (st) => {
    if (!Array.isArray(st)) return false
    const op = st[0]
    if (op === 'return' || op === 'throw' || op === 'break' || op === 'continue') return true
    if (op === '{}' && isBlock(st)) { const list = Array.isArray(st[1]) && st[1][0] === ';' ? st[1] : st; return exits(list[list.length - 1]) }
    if (op === ';') return exits(st[st.length - 1])
    if (op === 'if') return st[3] != null && exits(st[2]) && exits(st[3])
    if (op === 'catch') return exits(st[1]) && exits(st[3])
    if (op === 'finally') return exits(st[2]) || exits(st[1])
    return false
  }
  // The parameters a body reassigns somewhere: structural, listed once per body.
  const reassigned = new Map()   // body → the parameter names assigned in it
  const reassignedIn = (body, params) => {
    let l = reassigned.get(body)
    if (!l) {
      const out = new Set()
      assignsIn(body, out)
      l = []
      for (const p of params) if (p != null && out.has(p)) l.push(p)
      reassigned.set(body, l)
    }
    return l
  }
  const defaultNames = new Map()   // a defaults record → its parameter names, listed once
  const defaultNamesOf = (defaults) => { let l = defaultNames.get(defaults); if (!l) defaultNames.set(defaults, l = Object.keys(defaults)); return l }
  const reset = () => { pre.clear(); refined.clear(); post.clear(); branch = 0; rtop = 0 }
  const walkFunction = (key, body, params, defaults) => {
    current = key
    reset()
    if (defaults) for (const p of defaultNamesOf(defaults)) bindParam(keyIn(key, p), expr(defaults[p]))
    if (params) for (const p of reassignedIn(body, params)) { const id = keyIn(key, p); if (id !== null) pre.add(id) }
    if (isBlock(body)) {
      stmt(body)
      // A body that can fall through returns undefined.
      if (!exits(body)) raiseResult(key, NULLISH)
    } else raiseResult(key, expr(body))
    current = null
    reset()
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
  const numeric = new Map()   // binding id or `sid\0prop` → NUM: every read converts; COMPAT: or is a `+` operand; false: one read is neither
  const OTHER = 0, COMPAT = 1, NUM = 2, FLOW = 3, NEUTRAL = 4   // NEUTRAL: a read that is no evidence
  // Capture structural metadata once. A retained reader must not consult
  // a subsequent compilation's registry through brandOf/classes.
  const methods = new Map()
  for (let sid = 0; sid < schemas.length; sid++) {
    const cls = classOfSid(sid)
    if (cls) methods.set(sid, new Map(cls.methods))
  }
  const queryFacts = {
    kinds, incoming, fields, results, closures, declared, parent, nameKeys,
    scopeOfSig, scopeOfBody, scopeOfParams, cellUp, elems, tuples, cellProps, cellWild, closureSets, closureSetIds, cells, jsonKinds, closuresByBody, unions,
    schemas: schemas.map(props => props.slice()), methods, sidByKey,
    funcNames: new Set(funcByName.keys()), imports: new Map(imports),
    numeric, dynamicProps, builtinOwnProps, escaped, typedReadPresent, openSchemas, hostSchemas, opaqueSchemas,
    contracts: null,   // the result contracts, built at the freeze below
  }
  const queries = summaryQueries(queryFacts)
  const kindOfExpr = n => queries.at(current ?? MODULE).kindOfExpr(n)
  const isCompatible = (key) => numeric.get(key) >= COMPAT
  // A slot's key, `sid\0prop`, built once per (sid, prop) the same way; its own cache, its own namespace.
  const slotKeys = new Map()   // sid → Map(prop → key)
  const slotKey = (sid, prop) => {
    let m = slotKeys.get(sid)
    if (!m) slotKeys.set(sid, m = new Map())
    let key = m.get(prop)
    if (key === undefined) m.set(prop, key = sid + '\0' + prop)
    return key
  }
  // A flow target (`into`): a key, or a list of keys shared by every reader,
  // built once: the slot behind a name on a known shape, or every schema's
  // slot of that name behind a receiver the summary cannot name.
  const NO_KEYS = []
  const slotKeyLists = new Map()   // sid → Map(prop → [key])
  const slotKeyList = (sid, prop) => {
    let m = slotKeyLists.get(sid)
    if (!m) slotKeyLists.set(sid, m = new Map())
    let l = m.get(prop)
    if (l === undefined) m.set(prop, l = [slotKey(sid, prop)])
    return l
  }
  const propKeyLists = new Map()   // prop → the keys of every schema's slot of that name
  const propKeyList = (prop) => {
    let l = propKeyLists.get(prop)
    if (l === undefined) { l = []; for (const [sid] of byProp.get(prop) ?? NO_KEYS) l.push(slotKey(sid, prop)); propKeyLists.set(prop, l) }
    return l
  }
  const slotKeysOf = (recv, prop) => {
    const r = kindOfExpr(recv), t = tagOf(r)
    if (t === K.OBJECT && paramOf(r) !== UNKNOWN) return schemas[paramOf(r)].indexOf(prop) >= 0 ? slotKeyList(paramOf(r), prop) : NO_KEYS
    return propKeyList(prop)
  }
  let demandChanged = false
  const deny = (key) => { if (numeric.get(key) !== false) { numeric.set(key, false); demandChanged = true } }
  /** A read at `level` (NUM or COMPAT): the key holds the weakest level of its reads. */
  const mark = (key, level) => { const cur = numeric.get(key); if (cur === false) return; const next = cur === undefined ? level : Math.min(cur, level); if (next !== cur) { numeric.set(key, next); demandChanged = true } }
  /** What a flow into `into` (a key, or every key of a list) demands: false once any is denied, the weakest level when all are marked. */
  const demandOf = (into) => {
    if (into === null) return false
    if (typeof into === 'string' || typeof into === 'number') return numeric.get(into)
    let level = NUM
    for (const k of into) { const v = numeric.get(k); if (v === false) return false; if (v === undefined) return undefined; if (v < level) level = v }
    return level
  }
  /** The context `cx` (FLOW resolved through `into`), no stronger than `level`. */
  const atMost = (level, cx, into) => { const l = cx === FLOW ? demandOf(into) : cx; return l === undefined || l === false ? l : Math.min(l, level) }
  const useKey = (key, level) => { if (level === OTHER || level === false) deny(key); else if (level !== undefined) mark(key, level) }
  const useOf = (n, cx, into) => {
    // `n` is read in context `cx`; `into` names the key(s) it flows into under FLOW.
    if (typeof n === 'string') {
      const key = keyOf(n)
      if (key === null) return
      const level = cx === FLOW ? demandOf(into) : cx
      if (level !== NEUTRAL) useKey(key, level)
      return
    }
    if (!(Array.isArray(n) && (n[0] === '.' || n[0] === '?.') && typeof n[2] === 'string')) { demand(n, cx, into); return }
    demand(n[1], OTHER)
    const keys = slotKeysOf(n[1], n[2])
    if (!keys.length) return
    const level = cx === FLOW ? demandOf(into) : cx
    if (level === NEUTRAL) return
    for (const key of keys) useKey(key, level)
  }
  const isStringExpr = (e) => tagOf(kindOfExpr(e)) === K.STRING
  const isBigintExpr = (e) => tagOf(kindOfExpr(e)) === K.BIGINT
  const isNumberExpr = (e) => typeof e === 'number' || (Array.isArray(e) && ((e[0] == null && typeof e[1] === 'number') || NUMBER_OPS.has(e[0]) || e[0] === 'u-' || e[0] === 'u+' || (e[0] === '.' && e[2] === 'length'))) || tagOf(kindOfExpr(e)) === K.NUMBER
  const relCx = (o) => isStringExpr(o) ? OTHER : isNumberExpr(o) ? NUM : COMPAT
  const argCount = (a) => a == null ? 0 : Array.isArray(a) && a[0] === ',' ? a.length - 1 : 1
  const argAt = (a, i) => Array.isArray(a) && a[0] === ',' ? a[i + 1] : a
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
      const sid = literalSid(n)
      for (let i = 1; i < n.length; i++) {
        const p = n[i], key = typeof p === 'string' ? p : p[0] === ':' ? p[1] : null, value = typeof p === 'string' ? p : p[0] === ':' ? p[2] : p[1]
        if (sid >= 0 && typeof key === 'string' && !isBrand(key)) useOf(value, FLOW, slotKey(sid, key)); else demand(value)
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
    if (op === '+=') { const str = isStringExpr(n[1]) || isStringExpr(n[2]), num = tagOf(core(kindOfExpr(n[1]))) === K.NUMBER && tagOf(core(kindOfExpr(n[2]))) === K.NUMBER; useOf(n[1], str ? OTHER : num ? NUM : COMPAT); useOf(n[2], str ? OTHER : num ? NUM : COMPAT); return }
    // Beside a BigInt operand ToNumeric completes only for a BigInt (kind.js
    // arith): a Number there throws, so the read converts nothing.
    if (MUTATE_OPS.has(op)) { const cx = n[2] !== undefined && isBigintExpr(n[2]) ? OTHER : NUM; useOf(n[1], cx); if (n[2] !== undefined) useOf(n[2], cx); return }
    if (NUMBER_OPS.has(op) || op === 'u-' || op === 'u+' || op === '+1' || op === '-1') { const cx = n.length === 3 && (isBigintExpr(n[1]) || isBigintExpr(n[2])) ? OTHER : NUM; for (let i = 1; i < n.length; i++) useOf(n[i], cx); return }
    if (op === '+') { const num = tagOf(core(kindOfExpr(n[1]))) === K.NUMBER && tagOf(core(kindOfExpr(n[2]))) === K.NUMBER; useOf(n[1], isStringExpr(n[2]) || isBigintExpr(n[2]) ? OTHER : num ? NUM : COMPAT); useOf(n[2], isStringExpr(n[1]) || isBigintExpr(n[1]) ? OTHER : num ? NUM : COMPAT); return }
    // A relational compare converts against a number; two strings compare as strings, so an unknown pair is compatible.
    if (op === '<' || op === '<=' || op === '>' || op === '>=') { useOf(n[1], relCx(n[2])); useOf(n[2], relCx(n[1])); return }
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
      const callee = n[1], as = n[2], count = argCount(as)
      if (typeof callee === 'string') {
        // Math takes numbers, except sumPrecise, which takes an iterable.
        if ((callee.startsWith('Math.') || callee.startsWith('math.')) && !callee.endsWith('.sumPrecise')) { for (let i = 0; i < count; i++) useOf(argAt(as, i), NUM); return }
        const f = funcByName.get(callee)
        if (f && !escaped.has(callee)) { for (let i = 0; i < count; i++) { const p = f.sig.params[i]; if (p && !p.rest) useOf(argAt(as, i), FLOW, keyIn(callee, p.name)); else demand(argAt(as, i)) } return }
      }
      // A closure binding by name, or the closure set a callee expression
      // reads (`TABLE[k](…)`): each member's parameter is a flow target; a
      // member that escaped, or a position it lacks, is a plain read.
      const key = typeof callee === 'string' ? keyOf(callee) : null
      const ck = typeof callee === 'string' ? (key === null ? undefined : kinds[key]) : (demand(callee), kindOfExpr(callee))
      if (ck !== undefined && tagOf(ck) === K.CLOSURE && paramOf(ck) !== UNKNOWN) {
        const members = membersOf(paramOf(ck))
        if (members.length === 1) {
          const id = members[0], names = callableParams(id)
          for (let i = 0; i < count; i++) { const name = i < names.length ? names[i] : null; if (!escaped.has(id) && name != null) useOf(argAt(as, i), FLOW, keyIn(id, name)); else demand(argAt(as, i)) }
          return
        }
        const ids = members.filter(id => !escaped.has(id))
        for (let i = 0; i < count; i++) {
          const keys = ids.map(id => callableParams(id)[i] != null ? keyIn(id, callableParams(id)[i]) : null)
          if (ids.length && keys.every(k => k !== null)) useOf(argAt(as, i), FLOW, keys); else demand(argAt(as, i))
        }
        return
      }
      // `new Float64Array(x)` sizes by a number and copies an array: the
      // argument is no evidence either way (a parameter read only there
      // stays ANY, the host's array copies); a view's offset and length are
      // numbers.
      if (typeof callee === 'string' && callee.startsWith('new.') && (TYPED_CTOR.test(callee) || callee === 'new.ArrayBuffer')) { for (let i = 0; i < count; i++) useOf(argAt(as, i), i === 0 ? NEUTRAL : NUM); return }
      // `Array(x)` sizes by a number and holds anything else: no evidence either way.
      if ((callee === 'new.Array' || callee === 'Array') && count === 1) { useOf(argAt(as, 0), NEUTRAL); return }
      for (let i = 0; i < count; i++) demand(argAt(as, i))
      return
    }
    for (let i = 1; i < n.length; i++) demand(n[i])
  }
  const seedable = new Set()   // exported parameters (keys) the demand may seed NUMBER
  for (const f of funcs) if (exported(f)) for (const p of f.sig.params) if (!p.rest && !f.defaults?.[p.name]) seedable.add(keyIn(f.name, p.name))
  // An explicit numeric entry prologue is already the host boundary's coercion.
  // Later reads observe the overwritten value and cannot revoke that contract.
  const entryNumeric = new Set()
  for (const f of funcs) if (exported(f)) {
    const pending = [f.body]
    while (pending.length) {
      const n = pending.shift()
      if (!Array.isArray(n)) break
      if (n[0] === ';' || isBlock(n)) { pending.unshift(...n.slice(1)); continue }
      if (n[0] !== '=' || typeof n[1] !== 'string' || n[2]?.[0] !== 'u+' || n[2][1] !== n[1]) break
      const key = keyIn(f.name, n[1])
      if (!seedable.has(key)) break
      entryNumeric.add(key)
    }
  }

  // Each round walks the whole program; a round without a change is the
  // fixpoint. Every key rises through a lattice of finite height, so the
  // rounds are bounded; a bound this far above any program is a bug.
  const rounds = (step) => { for (let round = 0; ; round++) { if (round === 10000) throw new Error('summary: no fixpoint'); if (!step()) return } }
  const fixpoint = () => rounds(() => {
    changed = false
    for (const f of funcs) {
      if (f.rest) raise(kinds, keyIn(f.name, f.rest), kind(K.ARRAY))
      if (escaped.has(f.name)) for (const p of f.sig.params) bindParam(keyIn(f.name, p.name), ANY)
      walkFunction(f.name, f.body, paramNamesOf(f), f.defaults)
      if (exported(f) || hostClosures.has(f.name)) escapeToHost(results.get(f.name) ?? K.NONE)
    }
    for (let id = 0; id < closureBodies.length; id++) {
      if (escaped.has(id)) for (const p of closureParams[id]) if (p != null) bindParam(keyIn(id, p), ANY)
      walkFunction(id, closureBodies[id], closureParams[id], closureDefaults[id])
      if (hostClosures.has(id)) escapeToHost(results.get(id) ?? K.NONE)
    }
    current = null
    for (const top of tops) stmt(top)
    for (const name of hostGlobals) { const key = keyIn(MODULE, name); if (key !== undefined) escapeToHost(kinds[key] ?? K.NONE) }
    const seen = new Set()
    for (const key of declared.get(MODULE)?.values() ?? []) retain(kinds[key] ?? K.NONE, seen)
    for (const id of hostClosures) for (const key of captures.get(id) ?? []) retain(kinds[key] ?? K.NONE, seen)
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
  const seeded = [...seedable].filter(p => (entryNumeric.has(p) || isCompatible(p)) && tagOf(kinds[p] ?? K.NONE) === K.ANY)
  if (seeded.length) {
    kinds.length = 0; incoming.length = 0; fields.clear(); opaqueSchemas.clear(); hostSchemas.clear(); hostArrays.clear(); retainedArrays.clear(); hostClosures.clear(); results.clear(); escaped.clear(); certainKeys.clear(); for (let i = 0; i < elems.length; i++) { elems[i] = K.NONE; cellUp[i] = i }
    tuples.clear()
    poisonedAll = 0; poisonedIndexed = 0
    seed(seeded)
    fixpoint()
  }

  // Resolve union-find roots once before publishing. Readers never compress
  // paths or borrow the solver's mutable current scope.
  for (let id = 0; id < cellUp.length; id++) cellUp[id] = cell(id)
  // The result contracts (contract.js), from the settled results. A return
  // whose own kind names BigInt among a bounded set, through its joins and its
  // calls to such callables, is a BigInt member the join to ANY erased
  // (`if (c) return 5n; return x`, x of every kind): those keys are `certain`.
  const certain = new Set()
  const returns = new Map()
  for (const f of funcs) returns.set(f.name, returnExprs(f.body))
  for (let id = 0; id < closureBodies.length; id++) returns.set(id, returnExprs(closureBodies[id]))
  const calleeKeys = c => typeof c === 'string' ? [c] : membersOf(c)
  const certainBigint = (scope, node) => {
    const q = queries.at(scope), k = q.kindOfExpr(node)
    if (!hasTag(k, K.BIGINT)) return false
    if (!unbounded(k)) return true
    if (typeof node === 'string') { const key = q.keyOfName(node); return key !== null && certainKeys.has(key) }
    if (!Array.isArray(node)) return false
    const op = node[0]
    if (op === '?:') return certainBigint(scope, node[2]) || certainBigint(scope, node[3])
    if (op === '&&' || op === '||' || op === '??') return certainBigint(scope, node[1]) || certainBigint(scope, node[2])
    if (op === ',') return certainBigint(scope, node[node.length - 1])
    if (op === '=' && typeof node[1] === 'string') return certainBigint(scope, node[2])
    if (op === '()') { const c = q.calleeOf(node); return c !== null && calleeKeys(c).some(key => certain.has(key)) }
    return false
  }
  rounds(() => {
    let marked = false
    for (const [key, tails] of returns)
      if (!certain.has(key) && tails.some(e => e != null && certainBigint(key, e))) { certain.add(key); marked = true }
    return marked
  })
  const dispatcher = new Set(funcs.filter(f => f.sig?.dispatcher === true).map(f => f.name))
  const exportedNames = new Set(funcs.filter(exported).map(f => f.name))
  queryFacts.contracts = buildResultContracts({
    results, funcs, closureCount: closureBodies.length, closureSets, setBase: SET_BASE, membersOf, certain, returns,
    direct: name => !exportedNames.has(name) && !escaped.has(name) && !closureSetIds.has(name) && !dispatcher.has(name),
  })
  return summaryQueries(queryFacts)
}
