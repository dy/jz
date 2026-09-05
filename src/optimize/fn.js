/**
 * A function on the tape, as the body passes see it: its declarations and
 * its statements, the statements of a structured node, the effect class of
 * an instruction, and the tallies of its locals. A pass over a function is a
 * loop over statement lists; the interned ops it compares against are looked
 * up once per pass (the tape's symbols reset per compile).
 *
 * @module optimize/fn
 */
import { T, NONE, OP_STR, intern, text } from '../ir/tape.js'

/** The interned ops a body pass names; re-read per pass, after the tape reset. */
export const ops = () => ({
  FUNC: intern('func'), PARAM: intern('param'), RESULT: intern('result'), LOCAL: intern('local'), EXPORT: intern('export'), IMPORT: intern('import'), TYPE: intern('type'),
  BLOCK: intern('block'), LOOP: intern('loop'), IF: intern('if'), THEN: intern('then'), ELSE: intern('else'), SELECT: intern('select'),
  BR: intern('br'), BR_IF: intern('br_if'), BR_TABLE: intern('br_table'),
  LOCAL_GET: intern('local.get'), LOCAL_SET: intern('local.set'), LOCAL_TEE: intern('local.tee'),
  I32_CONST: intern('i32.const'), I32_EQZ: intern('i32.eqz'), I32_NE: intern('i32.ne'),
})

/** The functions of the module at `root`. */
export function funcs(root) {
  const FUNC = intern('func'), out = []
  for (let f = T.a[root]; f !== NONE; f = T.next[f]) if (T.op[f] === FUNC) out.push(f)
  return out
}

const HEADER = new Set(['export', 'import', 'type', 'param', 'result', 'local'])
/** The first statement of a function (after its name and header entries), or NONE. */
export function bodyOf(f) {
  for (let c = T.next[T.a[f]]; c !== NONE; c = T.next[c]) {
    const op = T.op[c]
    if (op < 0 || HEADER.has(T.syms[op])) continue
    return c
  }
  return NONE
}

/** The statements of a structured node: past a block's or loop's label and
 *  types, an `if`'s condition (its arms are `then`/`else` nodes of their own). */
export function stmtsOf(node) {
  const op = T.syms[T.op[node]]
  let c = T.a[node]
  if (op === 'func') return bodyOf(node)
  if (op === 'block' || op === 'loop') {
    while (c !== NONE && (T.op[c] === OP_STR || T.syms[T.op[c]] === 'result' || T.syms[T.op[c]] === 'type' || T.syms[T.op[c]] === 'param')) c = T.next[c]
    return c
  }
  return c   // then, else
}

/** Effect classes of an instruction. */
export const FX = { PURE: 0, GET: 1, SET: 2, TEE: 3, GLOBAL_GET: 4, GLOBAL_SET: 5, LOAD: 6, STORE: 7, CALL: 8, CONTROL: 9, TRANSFER: 10 }
let fxCache = new Int8Array(0), fxSyms = null   // the class per op symbol, for the symbol table it was built on
const classify = (s) => {
  if (s === 'local.get') return FX.GET
  if (s === 'local.set') return FX.SET
  if (s === 'local.tee') return FX.TEE
  if (s === 'global.get') return FX.GLOBAL_GET
  if (s === 'global.set') return FX.GLOBAL_SET
  if (s === 'call' || s === 'call_indirect' || s === 'call_ref') return FX.CALL
  if (s === 'return_call' || s === 'return_call_indirect' || s === 'br' || s === 'br_if' || s === 'br_table' || s === 'return' || s === 'unreachable' || s === 'throw' || s === 'rethrow') return FX.TRANSFER
  if (s === 'if' || s === 'loop' || s === 'block' || s === 'try' || s === 'try_table') return FX.CONTROL
  if (s === 'memory.grow' || s === 'memory.copy' || s === 'memory.fill' || s.includes('.store') || s.includes('.atomic')) return FX.STORE
  if (s === 'memory.size' || s.includes('.load')) return FX.LOAD
  return FX.PURE
}
/** The effect class of the op at `id` (an atom is pure). */
export function fxOf(id) {
  const op = T.op[id]
  if (op < 0) return FX.PURE
  if (fxSyms !== T.syms) { fxCache = new Int8Array(0); fxSyms = T.syms }   // the symbols reset per compile
  if (op >= fxCache.length) { const grown = new Int8Array(Math.max(op + 1, T.syms.length) * 2).fill(-1); grown.set(fxCache); fxCache = grown }
  let fx = fxCache[op]
  if (fx < 0) fxCache[op] = fx = classify(T.syms[op])
  return fx
}

/** The name atom of a local instruction (`local.get $x`): its symbol id, or NONE. */
export const nameOf = (id) => { const c = T.a[id]; return c !== NONE && T.op[c] === OP_STR ? T.sym[c] : NONE }

/** Sets, gets and tees per local symbol over the subtree at `root` (and its siblings when `withSiblings`). */
export function tallies(root, withSiblings = false) {
  const sets = new Map(), gets = new Map(), tees = new Map()
  const count = (map, id) => { const n = nameOf(id); map.set(n, (map.get(n) || 0) + 1) }
  const stack = [root]
  if (withSiblings) for (let s = T.next[root]; s !== NONE; s = T.next[s]) stack.push(s)
  while (stack.length) {
    const id = stack.pop()
    const fx = fxOf(id)
    if (fx === FX.SET) count(sets, id)
    else if (fx === FX.GET) count(gets, id)
    else if (fx === FX.TEE) count(tees, id)
    for (let c = T.a[id]; c !== NONE; c = T.next[c]) stack.push(c)
  }
  return { sets, gets, tees }
}

/** Whether the subtree at `id` holds a v128 instruction. */
export function hasV128(id) {
  const stack = [id]
  while (stack.length) {
    const n = stack.pop(), op = T.op[n]
    if (op >= 0) { const s = T.syms[op]; if (s.startsWith('v128.') || /^[if]\d+x\d+\./.test(s)) return true }
    for (let c = T.a[n]; c !== NONE; c = T.next[c]) stack.push(c)
  }
  return false
}

/** Drop the `(local $name ty)` declarations of `names` (symbol ids) from the function `f`. */
export function dropLocals(f, names) {
  const LOCAL = intern('local')
  let prev = T.a[f]
  for (let c = T.next[prev]; c !== NONE; c = T.next[c]) {
    if (T.op[c] === LOCAL && names.has(T.sym[T.a[c]])) { T.next[prev] = T.next[c]; continue }
    prev = c
  }
}

/** The number payload of an `i32.const` at `id`, or null. */
export function i32Const(id) {
  if (id === NONE || T.syms[T.op[id]] !== 'i32.const') return null
  const v = T.a[id]
  if (v === NONE) return null
  if (T.op[v] === -2) return T.imm[v]
  const s = text(v)
  return s === null ? null : Number(s)
}
