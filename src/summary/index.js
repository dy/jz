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
import { MUTATE_OPS, extractParams } from '../ast.js'
import { encodeTypedElemAux, ctorFromElemAux } from '../../layout.js'
import { VAL } from '../reps.js'

export const K = {
  NONE: 0, NUMBER: 1, STRING: 2, BOOL: 3, BIGINT: 4, NULLISH: 5, TYPED: 6, ARRAY: 7,
  OBJECT: 8, CLOSURE: 9, MAP: 10, SET: 11, DATE: 12, REGEX: 13, HASH: 14, ANY: 15,
}
const PARAM_BITS = 20, UNKNOWN = (1 << PARAM_BITS) - 1, NULLABLE = 1 << 30
export const kind = (tag, param = UNKNOWN) => (tag << PARAM_BITS) | (param & UNKNOWN)
export const tagOf = (k) => (k >>> PARAM_BITS) & 0x3FF
export const paramOf = (k) => k & UNKNOWN
export const isNullable = (k) => (k & NULLABLE) !== 0
const core = (k) => k & ~NULLABLE
const ANY = kind(K.ANY), NUMBER = kind(K.NUMBER), STRING = kind(K.STRING), BOOL = kind(K.BOOL), BIGINT = kind(K.BIGINT), NULLISH = kind(K.NULLISH)

export function join(a, b) {
  if (a === K.NONE) return b
  if (b === K.NONE || a === b) return a
  const n = (a | b) & NULLABLE
  a = core(a); b = core(b)
  if (a === b) return a | n
  const ta = tagOf(a), tb = tagOf(b)
  if (ta === K.NULLISH) return b | NULLABLE
  if (tb === K.NULLISH) return a | NULLABLE
  if (ta !== tb || ta === K.ANY) return ANY
  return kind(ta) | n  // same tag, different parameter: the tag alone
}

// Builtins that read their arguments and never write a field of them; any
// other unresolved callee may store into an object it receives.
const PURE_BUILTINS = /^(Object\.(keys|values|entries|freeze|isFrozen|getOwnPropertyNames|getPrototypeOf|hasOwn|is)|JSON\.stringify|Array\.isArray|console\.\w+|Math\.\w+|Number(\.\w+)?|String(\.\w+)?|Boolean|BigInt|Symbol(\.\w+)?|isNaN|isFinite|parseInt|parseFloat|structuredClone)$/

/** The value kind (reps.js VAL) of a monomorphic, non-nullable kind; null otherwise. */
const VAL_OF = [null, VAL.NUMBER, VAL.STRING, VAL.BOOL, VAL.BIGINT, null, VAL.TYPED, VAL.ARRAY, VAL.OBJECT, VAL.CLOSURE, VAL.MAP, VAL.SET, VAL.DATE, VAL.REGEX, VAL.HASH, null]
export const valOf = (k) => isNullable(k) ? null : VAL_OF[tagOf(k)] ?? null

const TYPED_CTOR = /^new\.(\w+Array)(\.view)?$/
const NUMBER_METHODS = new Set(['length', 'size', 'byteLength', 'byteOffset'])
const TYPED_SAME = new Set(['subarray', 'slice', 'map', 'filter', 'fill', 'reverse', 'sort', 'copyWithin', 'set'])
const STRING_METHODS = new Set(['slice', 'substring', 'substr', 'trim', 'trimStart', 'trimEnd', 'toUpperCase', 'toLowerCase', 'padStart', 'padEnd', 'repeat', 'replace', 'replaceAll', 'concat', 'normalize', 'at', 'charAt'])
const STRING_NUMBER_METHODS = new Set(['charCodeAt', 'codePointAt', 'indexOf', 'lastIndexOf', 'search', 'localeCompare'])
const NUMBER_OPS = new Set(['-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>', '~', '++', '--'])
const BOOL_OPS = new Set(['<', '<=', '>', '>=', '==', '!=', '===', '!==', '!', 'in', 'instanceof'])

/** Summarize the prepared program: `funcs` are the function records, `schemas` the schema prop lists. */
export function summarize(ast, { funcs, schemas, exported, imports }) {
  const kinds = new Map()            // binding name → kind
  const fields = new Map()           // sid → kind[]
  const results = new Map()          // function name or closure id → kind
  const closures = new Map()         // `=>` node → closure id
  const closureParams = []           // closure id → param names
  const closureBodies = []           // closure id → body
  const escaped = new Set()          // closure ids and function names whose callers are unknown
  const schemaKey = (props) => props.length + '\x01' + props.join('\x01')
  const sidByKey = new Map(schemas.map((props, sid) => [schemaKey(props), sid]))
  const byProp = new Map()
  schemas.forEach((props, sid) => props.forEach((p, i) => { let b = byProp.get(p); if (!b) byProp.set(p, b = []); b.push([sid, i]) }))
  const funcByName = new Map(funcs.map(f => [f.name, f]))
  let changed = false

  const slots = (sid) => { let a = fields.get(sid); if (!a) fields.set(sid, a = new Array(schemas[sid].length).fill(K.NONE)); return a }
  const raise = (map, key, k) => { const old = map.get(key) ?? K.NONE; const nk = join(old, k); if (nk !== old) { map.set(key, nk); changed = true } }
  const raiseSlot = (sid, i, k) => { const a = slots(sid); const nk = join(a[i], k); if (nk !== a[i]) { a[i] = nk; changed = true } }
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
  const raiseElem = (arr, k) => { if (tagOf(arr) !== K.ARRAY || paramOf(arr) === UNKNOWN) return; const id = paramOf(arr), nk = join(elems[id], k); if (nk !== elems[id]) { elems[id] = nk; changed = true } }
  /** A value the summary no longer follows: a closure's callers become unknown, an array's elements too. */
  const escape = (k) => {
    if (tagOf(k) === K.CLOSURE && paramOf(k) !== UNKNOWN && !escaped.has(paramOf(k))) { escaped.add(paramOf(k)); changed = true }
    if (tagOf(k) === K.ARRAY) { escape(elemOf(k)); raiseElem(k, ANY) }
  }
  /** An object handed to code the summary cannot see: its fields may be stored to. */
  const escapeObject = (k) => { if (tagOf(k) === K.OBJECT && paramOf(k) !== UNKNOWN) poisonSchema(paramOf(k)); escape(k) }
  const args = (a) => a == null ? [] : Array.isArray(a) && a[0] === ',' ? a.slice(1) : [a]
  const bind = (names, ks) => {
    for (let i = 0; i < names.length; i++) { if (names[i] != null) raise(kinds, names[i], i < ks.length ? ks[i] : NULLISH); }
    for (let i = names.length; i < ks.length; i++) escape(ks[i])
  }
  const call = (callee, argKinds) => {
    if (typeof callee === 'string') {
      const m = TYPED_CTOR.exec(callee)
      if (m) { const aux = encodeTypedElemAux(m[1], !!m[2]); return kind(K.TYPED, aux == null ? UNKNOWN : aux) }
      if (callee === 'new.Map') return kind(K.MAP)
      if (callee === 'new.Set') return kind(K.SET)
      if (callee === 'new.Date') return kind(K.DATE)
      if (callee === 'new.RegExp') return kind(K.REGEX)
      if (callee === 'new.Array' || callee === 'Array') return kind(K.ARRAY)
      if (callee === 'String' || callee.startsWith('String.')) return STRING
      if (callee === 'Number' || callee === 'parseInt' || callee === 'parseFloat' || callee.startsWith('Math.') || callee.startsWith('Number.')) return NUMBER
      if (callee === 'Boolean') return BOOL
      if (callee === 'BigInt') return BIGINT
      // jzify's `for…of` lowering iterates `__iter_arr(v)` by index: an array,
      // typed array or string iterates as itself, anything else as an array
      // of unknown elements.
      if (callee === '__iter_arr') { const t = argKinds.length ? tagOf(argKinds[0]) : K.NONE; return t === K.ARRAY || t === K.TYPED || t === K.STRING ? argKinds[0] : t === K.NONE ? K.NONE : kind(K.ARRAY) }
      const f = funcByName.get(callee)
      if (f) {
        if (!escaped.has(callee)) bind(f.sig.params.map(p => p.rest ? null : p.name), argKinds)
        return results.get(callee) ?? K.NONE
      }
      const k = kinds.get(callee)
      if (k !== undefined && tagOf(k) === K.CLOSURE && paramOf(k) !== UNKNOWN) return callClosure(paramOf(k), argKinds)
      if (k === undefined && modelled.has(callee)) return K.NONE  // a local callee not known yet
      if (PURE_BUILTINS.test(callee) || imports.has(callee)) { for (const k of argKinds) escape(k); return ANY }
    }
    for (const k of argKinds) escapeObject(k)
    return ANY
  }
  const callClosure = (id, argKinds) => {
    if (!escaped.has(id)) bind(closureParams[id], argKinds)
    return results.get(id) ?? K.NONE
  }
  const method = (recv, name, argKinds) => {
    const t = tagOf(recv)
    if (t === K.NONE) return K.NONE  // the receiver is not known yet; a later round sees it
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
      if (name === 'pop' || name === 'shift' || name === 'at' || name === 'find') { for (const k of argKinds) escape(k); return elemOf(recv) | NULLABLE }
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

  /** The kind of an expression, with its effects: calls bind parameters, stores raise slots. */
  const expr = (n) => {
    if (n == null) return NULLISH
    if (typeof n === 'number') return NUMBER
    if (typeof n === 'string') {
      const k = kinds.get(n)
      if (k !== undefined) return k
      if (funcByName.has(n)) { if (!escaped.has(n)) { escaped.add(n); changed = true } return kind(K.CLOSURE) }
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
    if (op === '`') { for (let i = 1; i < n.length; i++) expr(n[i]); return STRING }
    if (op === '=>') { const id = closureId(n); return kind(K.CLOSURE, id) }
    if (op === '{}') {
      const props = [], vals = [], init = definite.get(n)
      for (let i = 1; i < n.length; i++) {
        const p = n[i]
        if (Array.isArray(p) && p[0] === ':' && typeof p[1] === 'string') { props.push(p[1]); vals.push(init?.has(p[1]) && isNullishLit(p[2]) ? K.NONE : expr(p[2])) }
        else if (typeof p === 'string') { props.push(p); vals.push(expr(p)) }
        else { if (Array.isArray(p)) for (let j = 1; j < p.length; j++) escape(expr(p[j])); return kind(K.HASH) }
      }
      const sid = sidByKey.get(schemaKey(props))
      if (sid === undefined) { for (const v of vals) escape(v); return kind(K.HASH) }
      for (let i = 0; i < props.length; i++) raiseSlot(sid, i, vals[i])
      return kind(K.OBJECT, sid)
    }
    if (op === '[') {
      let elem = K.NONE
      for (let i = 1; i < n.length; i++) elem = join(elem, expr(n[i]))
      const arr = arrayOf(n, K.NONE)
      raiseElem(arr, elem)
      return arr
    }
    if (op === '.' || op === '?.') {
      const recv = expr(n[1]), prop = n[2], t = tagOf(recv)
      if (typeof prop !== 'string') { expr(prop); return t === K.NONE ? K.NONE : ANY }
      if (t === K.NONE) return K.NONE
      if (t === K.OBJECT && paramOf(recv) !== UNKNOWN) {
        const i = schemas[paramOf(recv)].indexOf(prop)
        return i >= 0 ? slots(paramOf(recv))[i] : NULLISH
      }
      if (NUMBER_METHODS.has(prop) && (t === K.ARRAY || t === K.TYPED || t === K.STRING || t === K.MAP || t === K.SET)) return NUMBER
      return ANY
    }
    if (op === '[]') {
      const recv = expr(n[1]), idx = n[2], t = tagOf(recv)
      if (Array.isArray(idx) && idx[0] == null && typeof idx[1] === 'string') return expr(['.', n[1], idx[1]])
      expr(idx)
      if (t === K.NONE) return K.NONE
      if (t === K.TYPED) return paramOf(recv) !== UNKNOWN && (paramOf(recv) & 16) ? BIGINT : NUMBER
      if (t === K.ARRAY) return elemOf(recv) | NULLABLE
      if (t === K.STRING) return STRING
      return ANY
    }
    if (op === '()') {
      const callee = n[1], as = args(n[2]).map(expr)
      if (Array.isArray(callee) && (callee[0] === '.' || callee[0] === '?.') && typeof callee[2] === 'string') {
        const recv = expr(callee[1])
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
    if (op === '+') { const a = expr(n[1]), b = expr(n[2]); const ta = tagOf(a), tb = tagOf(b); if (ta === K.STRING || tb === K.STRING) return STRING; if (ta === K.NONE || tb === K.NONE) return K.NONE; if (ta === K.NUMBER && tb === K.NUMBER) return NUMBER; if (ta === K.BIGINT && tb === K.BIGINT) return BIGINT; return ANY }
    if (NUMBER_OPS.has(op)) { let big = true; for (let i = 1; i < n.length; i++) if (tagOf(expr(n[i])) !== K.BIGINT) big = false; return big && n.length > 1 ? BIGINT : NUMBER }
    if (BOOL_OPS.has(op)) { for (let i = 1; i < n.length; i++) expr(n[i]); return BOOL }
    if (op === '&&' || op === '||' || op === '??') return join(expr(n[1]), expr(n[2]))
    if (op === '?' || op === '?:') { expr(n[1]); return join(expr(n[2]), expr(n[3])) }
    if (op === ',') { let k = NULLISH; for (let i = 1; i < n.length; i++) k = expr(n[i]); return k }
    if (op === 'typeof') { expr(n[1]); return STRING }
    if (op === 'delete') { stmt(n); return BOOL }
    if (op === 'void') { expr(n[1]); return NULLISH }
    if (op === 'await') return expr(n[1]) === K.NONE ? K.NONE : ANY
    if (op === '...' ) { escape(expr(n[1])); return ANY }
    for (let i = 1; i < n.length; i++) stmt(n[i])
    return ANY
  }

  /** `target op= value`: the stored kind reaches the binding or the slot; returns the expression's kind. */
  const assign = (op, target, value) => {
    let v = op === '=' ? expr(value) : op === '++' || op === '--' ? NUMBER : join(expr(target), value == null ? NUMBER : expr(value))
    if (op === '+=') v = tagOf(v) === K.STRING ? STRING : tagOf(v) === K.NUMBER ? NUMBER : tagOf(v) === K.BIGINT ? BIGINT : ANY
    else if (op !== '=' && op !== '||=' && op !== '&&=' && op !== '??=') v = tagOf(v) === K.BIGINT ? BIGINT : NUMBER
    if (typeof target === 'string') { raise(kinds, target, v); return v }
    if (Array.isArray(target) && (target[0] === '.' || target[0] === '?.')) {
      const recv = expr(target[1]), prop = target[2], t = tagOf(recv)
      if (t === K.NONE) return v
      if (typeof prop !== 'string') { poisonAll(recv); escape(v); return v }
      if (t === K.OBJECT && paramOf(recv) !== UNKNOWN) { const i = schemas[paramOf(recv)].indexOf(prop); if (i >= 0) raiseSlot(paramOf(recv), i, v); else poisonSchema(paramOf(recv)) }
      else if (t !== K.ARRAY && t !== K.TYPED && t !== K.STRING && t !== K.MAP && t !== K.SET) { poisonProp(prop); escape(v) }
      return v
    }
    if (Array.isArray(target) && target[0] === '[]') {
      const recv = expr(target[1]), idx = target[2], t = tagOf(recv)
      if (Array.isArray(idx) && idx[0] == null && typeof idx[1] === 'string') return assign(op, ['.', target[1], idx[1]], value)
      expr(idx)
      if (t === K.ARRAY) raiseElem(recv, v)
      else if (t !== K.NONE && t !== K.TYPED && t !== K.STRING) { poisonAll(recv); escapeObject(v) }
      return v
    }
    escape(v)
    return v
  }
  const poisonAll = (recv) => { if (tagOf(recv) === K.OBJECT && paramOf(recv) !== UNKNOWN) poisonSchema(paramOf(recv)); else for (let sid = 0; sid < schemas.length; sid++) poisonSchema(sid) }

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
  const noteDefinite = (list, from) => {
    const d = list[from]
    if (!Array.isArray(d) || (d[0] !== 'let' && d[0] !== 'const') || d.length !== 2 || !Array.isArray(d[1]) || d[1][0] !== '=' || typeof d[1][1] !== 'string') return
    const name = d[1][1], lit = d[1][2]
    if (!Array.isArray(lit) || lit[0] !== '{}' || lit.length < 2 || !lit.slice(1).every(p => Array.isArray(p) && p[0] === ':' && typeof p[1] === 'string')) return
    if (!lit.slice(1).some(p => isNullishLit(p[2]))) return
    const assigned = new Set()
    for (let i = from + 1; i < list.length; i++) {
      const st = list[i]
      if (!Array.isArray(st) || st[0] !== '=' || !Array.isArray(st[1]) || st[1][0] !== '.' || st[1][1] !== name || typeof st[1][2] !== 'string') break
      if (mentions(st[2], name, assigned) || isNullishLit(st[2])) break
      assigned.add(st[1][2])
    }
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
    if (op === 'for') { stmt(n[1]); expr(n[2]); expr(n[3]); stmt(n[4]); return }
    if (op === 'for-of' || op === 'for-in' || op === 'for-await') {
      const it = expr(n[2]), target = Array.isArray(n[1]) && (n[1][0] === 'let' || n[1][0] === 'const' || n[1][0] === 'var') ? n[1][1] : n[1]
      if (typeof target === 'string') raise(kinds, target, op === 'for-in' ? STRING : tagOf(it) === K.ARRAY ? elemOf(it) : tagOf(it) === K.TYPED ? NUMBER : tagOf(it) === K.STRING ? STRING : ANY)
      else pattern(target)
      stmt(n[3]); return
    }
    if (op === 'if') { expr(n[1]); stmt(n[2]); stmt(n[3]); return }
    if (op === 'while' || op === 'do') { expr(n[1]); stmt(n[2]); return }
    if (op === 'try') { for (let i = 1; i < n.length; i++) stmt(Array.isArray(n[i]) && n[i][0] === 'catch' ? (typeof n[i][1] === 'string' && raise(kinds, n[i][1], ANY), n[i][2]) : n[i]); return }
    if (op === 'throw') { escapeObject(expr(n[1])); return }
    if (op === 'delete') {
      // Prepared as `['delete', receiver, key]`. A static key on a fixed shape
      // is rejected downstream; a computed key may remove any slot.
      const r = expr(n[1]); expr(n[2])
      if (tagOf(r) === K.OBJECT || tagOf(r) === K.ANY) poisonAll(r)
      return
    }
    if (op === 'switch') { expr(n[1]); for (let i = 2; i < n.length; i++) stmt(n[i]); return }
    if (op === 'case') { expr(n[1]); for (let i = 2; i < n.length; i++) stmt(n[i]); return }
    if (op === 'label') { stmt(n[2]); return }
    if (op === 'break' || op === 'continue' || op === 'default') return
    if (op === 'export') { for (let i = 1; i < n.length; i++) stmt(n[i]); return }
    expr(n)
  }
  const isBlock = (body) => Array.isArray(body) && body[0] === '{}' && !(body.length > 1 && body.slice(1).every(p => typeof p === 'string' || (Array.isArray(p) && p[0] === ':')))
  const walkFunction = (key, body) => {
    const outer = current
    current = key
    if (isBlock(body)) {
      stmt(body)
      const last = body.length > 1 && Array.isArray(body[1]) && body[1][0] === ';' ? body[1][body[1].length - 1] : body[1]
      if (!(Array.isArray(last) && last[0] === 'return')) raise(results, key, NULLISH)
    } else raise(results, key, expr(body))
    current = outer
  }

  for (const f of funcs) if (exported(f)) for (const p of f.sig.params) raise(kinds, p.name, ANY)
  for (let round = 0; round < 64; round++) {
    changed = false
    for (const f of funcs) {
      if (f.rest) raise(kinds, f.rest, kind(K.ARRAY))
      if (f.defaults) for (const p in f.defaults) raise(kinds, p, expr(f.defaults[p]))
      if (escaped.has(f.name)) for (const p of f.sig.params) raise(kinds, p.name, ANY)
      walkFunction(f.name, f.body)
    }
    for (let id = 0; id < closureBodies.length; id++) {
      if (escaped.has(id)) for (const p of closureParams[id]) if (p != null) raise(kinds, p, ANY)
      walkFunction(id, closureBodies[id])
    }
    current = null
    stmt(ast)
    if (!changed) break
  }

  return {
    kindOf: (name) => kinds.get(name) ?? K.NONE,
    sidOf: (name) => { const k = kinds.get(name); return k !== undefined && tagOf(k) === K.OBJECT && !isNullable(k) && paramOf(k) !== UNKNOWN ? paramOf(k) : null },
    fieldKind: (sid, prop) => { const i = schemas[sid]?.indexOf(prop); return i == null || i < 0 ? K.NONE : fields.get(sid)?.[i] ?? K.NONE },
    /** The slot's value kind (reps.js VAL) when one kind holds under every construction and store, else null. */
    fieldVal: (sid, prop) => { const i = schemas[sid]?.indexOf(prop); return i == null || i < 0 ? null : valOf(fields.get(sid)?.[i] ?? K.NONE) },
    /** The typed-array constructor a binding holds under every assignment, or null. */
    typedCtorOf: (name) => { const k = kinds.get(name) ?? K.NONE; return tagOf(k) === K.TYPED && paramOf(k) !== UNKNOWN && !isNullable(k) ? ctorFromElemAux(paramOf(k)) : null },
    /** The typed-array constructor a slot holds under every construction and store, or null. */
    fieldTypedCtor: (sid, prop) => { const i = schemas[sid]?.indexOf(prop); const k = i == null || i < 0 ? K.NONE : fields.get(sid)?.[i] ?? K.NONE; return tagOf(k) === K.TYPED && paramOf(k) !== UNKNOWN && !isNullable(k) ? ctorFromElemAux(paramOf(k)) : null },
    resultOf: (name) => results.get(name) ?? K.NONE,
    /** Some slot holds a typed array under every construction and store. */
    hasTypedFields: [...fields.values()].some(a => a.some(k => tagOf(k) === K.TYPED && paramOf(k) !== UNKNOWN && !isNullable(k))),
    escaped,
  }
}
