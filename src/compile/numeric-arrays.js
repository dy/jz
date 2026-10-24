/**
 * Numeric arrays: an Array the program proves holds only Numbers keeps its
 * elements as raw f64, the way a Float64Array does.
 *
 * A generic array stores NaN-boxed values, so a Number entering it is
 * normalized (ir/sentinels.js canonicalNumberIR: a NaN of any other bits
 * becomes the canonical one, which no box spells), and a read of it tests for
 * the hole and for the boxes of undefined and null. Where every element is a
 * Number and none is a hole, nothing of that is needed: a NaN stored as a
 * Number is read back as a Number because the array, not the bits, says what
 * it holds. The store keeps the bits; the read is the load.
 *
 * What a cell (the summary's allocation class of arrays) needs for that:
 * - its kind is NUMBER alone, so no store puts another value there and none
 *   leaves a hole (src/summary/query.js `numericArrayCandidates`);
 * - every array of it is made where the emitter tags it: a literal of no hole
 *   and no spread, `new Array()`, `new Array(n)`. The pointer carries
 *   ARRAY_RAW in its aux (layout.js), set there (`numericConstruction`), kept
 *   by growth (module/array.js arrGrow): every pointer to the array has it.
 *   A literal a function returns as lanes (a multi-value result) is made
 *   where a call builds the array of them, tagged by the function's result
 *   cell (`numericLanes`), so that cell must be the literal's;
 * - no array of it reaches the host;
 * - no code reads its elements but the emitter's own element paths: an index
 *   read or store under a Number key, `.length`, `.push`, `.fill`, a call of
 *   the program's own functions, the tests of identity, presence and truth.
 *   Any other use of the array, or of a value holding it at any depth (an
 *   object, an array of arrays), is a generic reader (a join, a spread, a copy,
 *   a sort, `in`, a builtin): the cells it may reach keep the boxed layout.
 *   That census is this module's.
 *
 * The census reads a use by the kind of what it uses. Every value holding an
 * array of a candidate has a kind naming the cell: a join that loses a cell
 * escapes it, and an escaped cell's elements are ANY, no candidate's.
 *
 * The runtime reads the aux where it walks: compaction (core/compact.js) and
 * the release walk (core/reach.js) take no element of such an array for a
 * pointer, and its durable snapshot is a raw record (core/durable-log.js). A
 * read of an element is raw ingress (kind/payload.js): a value that leaves for
 * a generic slot is normalized there, as a Float64Array element is.
 *
 * @module compile/numeric-arrays
 */
import { ctx } from '../ctx.js'
import { PTR, ARRAY_RAW, LAYOUT } from '../../layout.js'
import { K, tagOf, hasTag, bitOf, paramOf, TAGS, UNKNOWN } from '../summary/kind.js'
import { typed } from '../ir/tag.js'
import { mkPtrIR } from '../ir/pointers.js'
import { frameRoots } from '../function.js'

// The operators an array can be the value of: a name, a member, a call, a
// choice, an assignment, a sequence, a construction. Any other answers a primitive.
const HOLDS = new Set(['[]', '.', '?.', '()', '?.()', '?:', '&&', '||', '??', '=', ',', '(', '[', '{}'])
const holds = (n) => typeof n === 'string' || Array.isArray(n) && HOLDS.has(n[0])
// Statements and value flows: what they hold is discarded, tested, bound or passed on, never read.
const FLOWS = new Set([';', ',', '(', '?:', '&&', '||', '??', 'return', 'if', 'while', 'for', 'do', 'block', '{', '{}', '[', 'void', '!', 'typeof', 'label', 'export', 'catch', 'finally', 'let', 'const', '===', '!=='])
// Names that are no value: a member's name, a label, a catch's binding, a key.
const nameAt = (op, i) => (op === '.' || op === '?.') && i === 2 || op === 'label' && i === 1 || op === 'break' || op === 'continue' || op === 'catch' && i === 2 || op === ':' && i === 1
// An array's methods the emitter's own paths serve: stores that read no element.
const STORE_METHODS = new Set(['push', 'fill'])
// An array's methods that copy, move, compare or hand on its elements, reading
// none inside: the receiver's own cell is read, not one an element holds (a
// callback is the program's, walked; `concat` copies its arguments' elements the same way).
const SHALLOW_METHODS = new Set(['slice', 'concat', 'splice', 'reverse', 'shift', 'pop', 'unshift', 'indexOf', 'lastIndexOf', 'includes', 'at',
  'toReversed', 'toSpliced', 'with', 'copyWithin', 'map', 'filter', 'forEach', 'reduce', 'reduceRight', 'some', 'every', 'find', 'findIndex',
  'findLast', 'findLastIndex', 'keys', 'values', 'entries'])
const CALLBACK_METHODS = new Set(['map', 'filter', 'forEach', 'reduce', 'reduceRight', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex'])
// A value that is one of the program's functions: a closure the summary names, or a function's name.
const ownCallee = (view, f) => f != null && (Array.isArray(f) && f[0] === '=>' || (k => tagOf(k) === K.CLOSURE && paramOf(k) !== UNKNOWN)(view.kindOfExpr(f)))
// A Map's and a Set's methods that store, find or hand on a value without reading inside it.
const COLLECTION_METHODS = new Set(['get', 'set', 'has', 'delete', 'add', 'clear'])
const BUILTINS_SERVED = new Set(['Array.isArray', 'new.Array'])
const args = (a) => a == null ? [] : Array.isArray(a) && a[0] === ',' ? a.slice(1) : [a]
const member = (n) => Array.isArray(n) && (n[0] === '.' || n[0] === '?.')
const NUMBER_TAG = bitOf(K.NUMBER)
// The literals a function returns as lanes: each return's (an arm of a returned choice), or an expression body; a closure's returns are its own.
const laneLiterals = (body) => {
  const out = []
  const lit = (e) => { if (!Array.isArray(e)) return; if (e[0] === '[') out.push(e); else if (e[0] === '?:') { lit(e[2]); lit(e[3]) } }
  const walk = (n) => {
    if (!Array.isArray(n) || n[0] === '=>') return
    if (n[0] === 'return') { lit(n[1]); return }
    for (let i = 1; i < n.length; i++) walk(n[i])
  }
  if (Array.isArray(body) && body[0] === '{}') walk(body); else lit(body)
  return out
}
// JZ_NUMERIC_WHY=1: each cell's first generic use, on ctx.runtime.numericWhy (a diagnostic)
const WHY = typeof process !== 'undefined' && process.env?.JZ_NUMERIC_WHY === '1'

/** Decide the program's numeric cells after the last summary (compile/index.js):
 *  `moduleRoots` the module-scope statements, `funcs` the functions emitted. */
export function planNumericArrays(moduleRoots, funcs) {
  ctx.runtime.numericCells = null
  ctx.runtime.numericConstructions = null
  const s = ctx.summary
  if (!s?.numericArrayCandidates || ctx.transform.optimize?.numericArrays === false) return
  const made = s.numericArrayCandidates()
  if (!made.size) return
  const generic = new Set()
  const views = new Map()
  const scoped = (key) => { let v = views.get(key); if (!v) views.set(key, v = s.at(key)); return v }
  const why = WHY ? [] : null
  const readBy = (view, e, n) => {
    if (!holds(e)) return
    for (const c of view.arrayCellsReachedByExpr(e)) {
      if (why && made.size && !generic.has(c)) why.push([c, JSON.stringify(e).slice(0, 80), JSON.stringify(n)?.slice(0, 120)])
      generic.add(c)
    }
  }
  // a use that reads the array `e` itself holds, not an array one of its elements holds
  const readOwn = (view, e) => {
    if (!holds(e)) return
    const c = view.arrayCellOf(e)
    if (c != null && !generic.has(c)) { if (why) why.push([c, JSON.stringify(e).slice(0, 80), 'own']); generic.add(c) }
  }
  const primitive = (view, e) => { const k = view.kindOfExpr(e); return tagOf(k) === K.ANY || hasTag(k, K.NUMBER) || hasTag(k, K.STRING) || hasTag(k, K.BOOL) || hasTag(k, K.BIGINT) }

  // Whether child `i` of `n`, a value, is used the way the emitter's own paths serve.
  const served = (view, n, i) => {
    const op = n[0]
    if (FLOWS.has(op)) return true
    // an index read or store under a Number key: the element path; a key holding an array converts it
    if (op === '[]') return i === 1 && (view.kindOfExpr(n[2]) & TAGS) === NUMBER_TAG
    // a field read passes the field's value on; of an array, only its length is the emitter's
    if (op === '.' || op === '?.') return i === 1 && (n[2] === 'length' || !hasTag(view.kindOfExpr(n[1]), K.ARRAY))
    // a binding or a member written, the value bound; a pattern reads the elements
    if (op === '=') return i === 1 ? typeof n[1] === 'string' || n[1][0] === '[]' || member(n[1]) : !(Array.isArray(n[1]) && (n[1][0] === '[' || n[1][0] === '{}'))
    if (op === ':') return i === 2
    if (op === '==' || op === '!=') return !primitive(view, n[3 - i])
    if (op === 'instanceof') return i === 1
    return false
  }

  const visitCall = (n, view) => {
    const callee = n[1]
    // the program's own function, closure or method: its parameters hold what it is passed, and its uses are walked
    const own = view.calleeOf(n) != null
    let argsServed = own || BUILTINS_SERVED.has(callee), argsOwn = false
    if (member(callee)) {
      const recv = callee[1], m = callee[2], t = own ? K.NONE : tagOf(view.kindOfExpr(recv))
      if (own) {}
      else if (t === K.ARRAY && STORE_METHODS.has(m)) argsServed = true
      // (a callback the program's own: what it is handed, it reads by the uses walked in it)
      else if (t === K.ARRAY && SHALLOW_METHODS.has(m) && (!CALLBACK_METHODS.has(m) || ownCallee(view, args(n[2])[0]))) {
        readOwn(view, recv)
        if (m === 'concat') argsOwn = true; else argsServed = true
      }
      else if ((t === K.MAP || t === K.SET) && COLLECTION_METHODS.has(m)) argsServed = true
      else readBy(view, recv, n)
      visit(recv, view)
    } else if (typeof callee !== 'string') { if (!own) readBy(view, callee, n); visit(callee, view) }
    for (let i = 2; i < n.length; i++) for (const a of args(n[i])) {
      if (argsOwn) readOwn(view, a)
      else if (!argsServed) readBy(view, a, n)
      visit(a, view)
    }
  }

  const visit = (n, view) => {
    if (!Array.isArray(n)) return
    const op = n[0]
    if (op === '=>') {
      // a closure's body in its own scope; the body is its result, the parameters bind
      const body = n[2]
      if (!Array.isArray(body)) return
      if (s.closureIdOfBody?.(body) === undefined) { unscoped(body, view); return }
      visit(body, scoped(body))
      return
    }
    if (op === '()' || op === '?.()') { visitCall(n, view); return }
    // a literal stores its elements; one spreading an array copies the array's, reading none inside
    if (op === '[') {
      for (let i = 1; i < n.length; i++) {
        const c = n[i]
        if (Array.isArray(c) && c[0] === '...') { readOwn(view, c[1]); visit(c[1], view) }
        else visit(c, view)
      }
      return
    }
    for (let i = 1; i < n.length; i++) {
      const c = n[i]
      if (c == null || typeof c === 'string' && nameAt(op, i)) continue
      if (!served(view, n, i)) readBy(view, c, n)
      visit(c, view)
    }
  }
  // A body the summary keeps no scope for: every value in it is read generically.
  const unscoped = (n, view) => {
    for (let i = 1; i < n.length; i++) { const c = n[i]; readBy(view, c, n); if (Array.isArray(c)) unscoped(c, view) }
  }

  const top = scoped('')
  for (const root of moduleRoots) visit(root, top)
  for (const f of funcs) { const view = scoped(f.body); for (const root of frameRoots(f)) visit(root, view) }
  // A function whose result is lanes (prepare/handlers.js detectResults: each
  // return a literal of two to eight elements) makes no array where it
  // returns: a call builds one of the lanes (emit/call-args.js
  // materializeMultiIR, the closure trampoline) or binds them (bindTuple). A
  // lane keeps its bits where its literal's cell keeps raw Numbers
  // (emit/statements.js `return`), the array built of the lanes is tagged by
  // the function's result cell: a literal of another cell keeps the boxed layout, and so does that cell.
  for (const f of funcs) if (f.sig.results.length > 1) {
    const rc = s.resultCellOf(f.name), view = scoped(f.body)
    for (const lit of laneLiterals(f.body)) {
      const c = view.arrayCellOf(lit)
      if (c === rc) continue
      for (const d of [c, rc]) if (d != null && !generic.has(d)) { if (why) why.push([d, JSON.stringify(lit).slice(0, 80), `lanes of ${f.name}`]); generic.add(d) }
    }
  }

  if (why) ctx.runtime.numericWhy = why
  const cells = new Set(), nodes = new WeakSet()
  for (const [node, c] of made) if (!generic.has(c)) { cells.add(c); nodes.add(node) }
  if (!cells.size) return
  ctx.runtime.numericCells = cells
  ctx.runtime.numericConstructions = nodes
}

/** Whether the program keeps any array's elements raw: the runtime's walks and snapshots then read the aux. */
export const numericArraysOn = () => ctx.runtime.numericCells != null

/** Whether the lanes a multi-value function `name` returns are a numeric cell's elements:
 *  each keeps its bits, and an array a call builds of them is tagged ARRAY_RAW. */
export const numericLanes = (name) => {
  const cells = ctx.runtime.numericCells
  if (!cells) return false
  const c = ctx.summary?.resultCellOf(name)
  return c != null && cells.has(c)
}

/** Whether the array expression `e` names a numeric cell (its elements raw Numbers). */
export const numericArrayExpr = (e) => {
  const cells = ctx.runtime.numericCells
  if (!cells || e == null) return false
  const c = ctx.summary?.at(ctx.func.current)?.arrayCellOf(e)
  return c != null && cells.has(c)
}

// ARRAY_RAW in the pointer's high word
const RAW_BITS = '0x' + (ARRAY_RAW << (LAYOUT.AUX_SHIFT - 32)).toString(16).padStart(8, '0') + '00000000'

/** The pointer `ir` a construction `node` made, tagged ARRAY_RAW where it makes a numeric cell's array. */
export const numericConstruction = (node, ir) => {
  if (!ctx.runtime.numericConstructions?.has(node)) return ir
  if (ir?.type !== 'f64') throw new Error(`internal: a numeric array's construction emitted no pointer (${ir?.type})`)
  // a module literal laid out as static data keeps its offset and count for the constant reads
  if (ir?.staticOff != null) {
    const out = mkPtrIR(PTR.ARRAY, ARRAY_RAW, ir.staticOff)
    out.staticOff = ir.staticOff
    out.staticLen = ir.staticLen
    return out
  }
  return typed(['f64.reinterpret_i64', ['i64.or', ['i64.reinterpret_f64', ir], ['i64.const', RAW_BITS]]], 'f64')
}
