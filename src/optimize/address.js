/**
 * Where an access points, and whether two may touch the same bytes: one reader of a load's
 * or a store's address for every pass.
 *
 * An address reads as a sum, `k + Σ scale·atom`: every constant it adds folded into `k`
 * (the memarg's offset too), every `i32.shl` or `i32.mul` by a constant a scale, a tee as
 * the value it carries, an `i32.sub` an add of the negated term. An atom is what the sum
 * cannot open: a local, a global, a box's pointer (`i32.wrap_i64` of the box's bits,
 * masked or not, which is the box's own atom), or an operation of no add over atoms of
 * its own. The terms are kept by the atom's key, so two addresses that are equal compare
 * equal whatever the order of their adds or the tee and the copy that carry them.
 *
 * A reader knows its locals: `look(node)` answers a `local.get` or a `global.get` with
 *   undefined   the name stands as itself
 *   a string    it stands as that atom (a version of a local: `$x@3`; a root: `r:$p`; a
 *               number no buffer comes from: `n:…`)
 *   { e, look, token }  it is what `e` computes, read with `look` (a definition, where it
 *               ran), or the atom `token` where `e` is no register arithmetic
 *   { sum }     it is that sum (what the reader solved it to)
 *   null        the reader cannot say (a local written between the two accesses)
 *
 * What an access touches (`mayAlias`): the emitter's mark where it left one
 * (src/ir/mem-alias.js: an array's elements by allocation cell, an object's fields by slot
 * and layout); bytes, where two accesses have one sum but its constant (a slot's eight
 * bytes against a word four further); a header word against a payload store of a wide
 * type, which jz never writes a header with (HEADER_STORE_FREE);
 * buffers a reader proved apart (a root each, `r:…`, of `distinct`); two constant
 * addresses by their bytes. Anything else may touch anything.
 *
 * @module optimize/address
 */
import { nodeKey } from '../ast.js'
import { LAYOUT } from '../../layout.js'

const isArr = Array.isArray
const MEMOP = /^(i32|i64|f32|f64|v128)\.(load|store)(8|16|32)?(_[su])?$/
const WIDTH = { 8: 1, 16: 2, 32: 4 }

/** A load or a store as its parts: { op, store, bytes, off, ai (the address's index), addr, val },
 *  or null. An access of another form (a lane's, an atomic's) reads as up to 16 bytes, and as a
 *  store where it may write. */
export const memop = (n) => {
  if (!isArr(n) || typeof n[0] !== 'string' || !/\.(load|store|atomic)/.test(n[0])) return null
  const m = MEMOP.exec(n[0])
  let i = 1, off = 0
  while (typeof n[i] === 'string' || typeof n[i] === 'number') { if (typeof n[i] === 'string' && n[i].startsWith('offset=')) off += Number(n[i].slice(7)); i++ }
  const store = m ? m[2] === 'store' : /store|rmw/.test(n[0])
  const bytes = !m ? 16 : m[3] ? WIDTH[m[3]] : m[1] === 'v128' ? 16 : m[1][1] === '3' ? 4 : 8
  return { op: n[0], store, bytes, off, ai: i, addr: n[i], val: store ? n[i + 1] : undefined }
}

/** The stores of an element's payload: jz writes every array and typed header word with
 *  `i32.store` (under JZ_DEBUG_INVARIANTS every effects solve checks each wide store it reads,
 *  `headerStore`), and a payload store lands inside its own allocation (the bounds a store
 *  is emitted under), so these never change a header. */
export const HEADER_STORE_FREE = new Set(['f64.store', 'f32.store', 'i64.store', 'v128.store'])
/** Whether store `n` may write a header word: the bytes it writes, below the pointer its
 *  address steps back from (`X - k`, `X + -k`), reach the length at -8 or the forward word at
 *  -4. (The allocator writes a header ahead of the pointer it returns with word stores,
 *  `__alloc_hdr`; a sum of a base and an index less a constant, a stack's top, steps back
 *  from no pointer.) */
export const headerStore = (n) => {
  const m = memop(n), a = m && m.addr
  const k = isArr(a) && a.length === 3 && isArr(a[2]) && a[2][0] === 'i32.const' ? Number(a[2][1]) : null
  const at = k == null ? null : a[0] === 'i32.sub' ? m.off - k : a[0] === 'i32.add' && k < 0 ? m.off + k : null
  return at != null && at < 0 && at + m.bytes > -8
}

/** A constant i32 subtree's value, folding the arithmetic jz leaves in a constant index; NaN when it is not one. */
export const constOf = (n) => {
  if (!isArr(n)) return NaN
  if (n[0] === 'i32.const') return Number(n[1]) | 0
  if (n.length !== 3) return NaN
  const a = constOf(n[1]), b = constOf(n[2])
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN
  switch (n[0]) {
    case 'i32.add': return (a + b) | 0
    case 'i32.sub': return (a - b) | 0
    case 'i32.mul': return Math.imul(a, b)
    case 'i32.shl': return a << (b & 31)
  }
  return NaN
}

const isMask = (n) => isArr(n) && n[0] === 'i64.const' && Number(n[1]) === LAYOUT.OFFSET_MASK
/** The box a pointer is read out of, `(i32.wrap_i64 (i64.and (i64.reinterpret_f64 X) MASK))` or the
 *  unmasked wrap of its bits: X, or null. */
export const unbox = (e) => {
  if (!isArr(e) || e[0] !== 'i32.wrap_i64' || e.length !== 2) return null
  let b = e[1]
  if (isArr(b) && b[0] === 'i64.and' && b.length === 3 && isMask(b[2])) b = b[1]
  return isArr(b) && b[0] === 'i64.reinterpret_f64' && b.length === 2 ? b[1] : null
}
// (the low word of a box's bits a local or a global holds as an i64: `(i32.wrap_i64 X)`, masked or not)
const bitsOf = (e) => {
  if (!isArr(e) || e[0] !== 'i32.wrap_i64' || e.length !== 2) return null
  let b = e[1]
  if (isArr(b) && b[0] === 'i64.and' && b.length === 3 && isMask(b[2])) b = b[1]
  return isArr(b) && (b[0] === 'local.get' || b[0] === 'global.get') ? b : null
}

// The operations an atom may be made of: register arithmetic, no load or call.
const PURE = new Set(['i32.and', 'i32.or', 'i32.xor', 'i32.shr_u', 'i32.shr_s', 'i32.wrap_i64', 'i32.mul', 'i32.shl',
  'i64.and', 'i64.or', 'i64.shl', 'i64.shr_u', 'i64.reinterpret_f64', 'i64.extend_i32_u', 'i64.const', 'f64.const'])
// The operations whose answer is a number no buffer is: a float's arithmetic, a truncation, a
// test (an index, an answer). An atom of one is `n:`, no root, whatever it was computed from.
const NUMBER = /^(?:(?:i32|i64)\.trunc(?:_sat)?_f(?:32|64)_[su]|[if](?:32|64)\.(?:eqz?|ne|[lg][te](?:_[su])?)|i32\.(?:clz|ctz|popcnt)|f(?:32|64)\.(?!reinterpret)\w+)$/
let fresh = 0

const add = (into, key, scale, node) => {
  const t = into.get(key), s = ((t ? t.scale : 0) + scale) | 0
  if (s) into.set(key, { scale: s, node: t ? t.node : node }); else into.delete(key)
}
const scaled = (lin, c) => {
  const terms = new Map()
  for (const [key, t] of lin.terms) add(terms, key, Math.imul(t.scale, c), t.node)
  return { k: Math.imul(lin.k, c), terms }
}
const sum = (a, b, sign = 1) => {
  const terms = new Map(a.terms)
  for (const [key, t] of b.terms) add(terms, key, Math.imul(t.scale, sign), t.node)
  return { k: (a.k + Math.imul(b.k, sign)) | 0, terms }
}
const atom = (key, node) => ({ k: 0, terms: new Map([[key, { scale: 1, node }]]) })

/**
 * The sum an i32 subtree computes, `{ k, terms }` (terms: an atom's key → { scale, node }),
 * read with `look`; null where a load, a call or a local the reader cannot say stands in it.
 */
export const linear = (n, look = null, depth = 0) => {
  if (!isArr(n) || depth > 24) return null
  const op = n[0]
  if (op === 'i32.const') return { k: Number(n[1]) | 0, terms: new Map() }
  if (op === 'local.tee') return typeof n[1] === 'string' ? linear(n[2], look, depth + 1) : null
  if (op === 'local.get' || op === 'global.get') {
    if (typeof n[1] !== 'string') return null
    const r = look ? look(n) : undefined
    if (r === null) return null
    if (r === undefined) return atom((op === 'local.get' ? 'l:' : 'g:') + n[1], n)
    if (typeof r === 'string') return atom(r, n)
    if (r.sum) return { k: r.sum.k, terms: new Map(r.sum.terms) }
    return linear(r.e, r.look, depth + 1) ?? (r.token ? atom(r.token, n) : null)
  }
  if (op === 'i32.add' && n.length === 3) {
    const a = linear(n[1], look, depth + 1), b = a && linear(n[2], look, depth + 1)
    return b && sum(a, b)
  }
  if (op === 'i32.sub' && n.length === 3) {
    const a = linear(n[1], look, depth + 1), b = a && linear(n[2], look, depth + 1)
    return b && sum(a, b, -1)
  }
  if ((op === 'i32.shl' || op === 'i32.mul') && n.length === 3) {
    const c = constOf(n[2]), d = op === 'i32.mul' && Number.isNaN(c) ? constOf(n[1]) : NaN
    const by = !Number.isNaN(c) ? (op === 'i32.shl' ? 1 << (c & 31) : c) : d
    if (!Number.isNaN(by)) { const x = linear(Number.isNaN(c) ? n[2] : n[1], look, depth + 1); return x && scaled(x, by) }
  }
  // a box's pointer: the box's own atom, read through what the reader knows of it (`p:`, of
  // the box's f64; `q:`, of bits held as an i64, which may be no box: never a header)
  const box = unbox(n), bits = box ? null : bitsOf(n)
  if (box || bits) {
    const x = box || bits
    const r = isArr(x) && (x[0] === 'local.get' || x[0] === 'global.get') ? linear(x, look, depth + 1) : null
    const one = r && r.k === 0 && r.terms.size === 1 && [...r.terms.values()][0].scale === 1 ? [...r.terms.keys()][0] : null
    return one ? atom((box ? 'p:' : 'q:') + one, n) : null
  }
  const number = NUMBER.test(op)
  if (!number && !PURE.has(op)) return null
  // an operation of no add: one atom, keyed by what its operands are (a number of operands no
  // one can say is an atom of its own, equal to no other)
  const parts = [op]
  for (let i = 1; i < n.length; i++) {
    const c = n[i]
    if (!isArr(c)) { parts.push(String(c)); continue }
    if (c[0].endsWith('.const')) { parts.push(nodeKey(c)); continue }
    const x = linear(c, look, depth + 1)
    if (!x) return number ? atom('n:#' + fresh++, n) : null
    parts.push(keyOf(x))
  }
  return atom((number ? 'n:(' : '(') + parts.join(' ') + ')', n)
}

/** A sum's terms, written in one order: the key two equal sums share (the constant apart). */
export const termsKey = (lin) => [...lin.terms].map(([key, t]) => t.scale + '*' + key).sort().join('+')
/** The whole sum's key, its constant included. */
export const keyOf = (lin) => termsKey(lin) + '#' + lin.k

/**
 * An access through `look` (or the subtree `pre` resolves its address to, read as it
 * stands): memop's parts and the address as `key + at`, `key` the sum's
 * terms (null where the reader cannot say) and `at` every constant with the memarg's,
 * the bytes touched [at, at + bytes); `mem` the emitter's mark, `root` the one root atom a
 * reader named (`r:…`), `header` a word at -8 or -4 of a box's pointer.
 */
export const addressOf = (n, look = null, pre = null) => {
  const m = memop(n)
  if (!m) return null
  const src = pre ? pre(m.addr) : m.addr
  return accessAt(m, src && linear(src, look), n.mem)
}
/** An access of memop's parts `m` at the sum `lin` (null: one a reader cannot say) plus `m.off`, marked `mem`. */
export const accessAt = (m, lin, mem) => {
  if (!lin) return { ...m, key: null, at: m.off, lin: null, mem, root: null, header: false }
  const at = lin.k + m.off
  const root = rootOf(lin)
  let ptr = false
  for (const [key, t] of lin.terms) if (t.scale === 1 && key.startsWith('p:')) ptr = true
  return { ...m, key: termsKey(lin), at, lin, mem, root, header: ptr && lin.terms.size === 1 && at >= -8 && at < 0 }
}
/** The one root (`r:…`, a reader's, under a box's pointer or not) a sum offsets, every other term
 *  an index (a multiple, a mask, a number of no buffer), or null. */
export const rootOf = (lin) => {
  if (!lin) return null
  let root = null
  for (const [key, t] of lin.terms) {
    const r = key.startsWith('p:r:') ? key.slice(2) : key
    if (r.startsWith('r:')) { if (t.scale !== 1 || root) return null; root = r }
    else if (t.scale === 1 && !r.startsWith('n:') && !r.startsWith('(i32.and ')) return null
  }
  return root
}

/** Whether two accesses of one sum overlap by their bytes; null where their sums differ or a reader could not say. */
export const overlaps = (a, b) => a.key == null || b.key == null || a.key !== b.key ? null : a.at < b.at + b.bytes && b.at < a.at + a.bytes

/** A function's loads and stores and how many of them carry the emitter's mark: a step that
 *  rebuilds an access carries its mark over (`carry`), so under JZ_DEBUG_INVARIANTS one that
 *  leaves fewer marked than it found, beyond the accesses it removed, fails (optimize/driver.js). */
export const markCount = (fn) => {
  let accesses = 0, marked = 0
  const walk = (n) => {
    if (!isArr(n)) return
    if (typeof n[0] === 'string' && MEMOP.test(n[0])) { accesses++; if (n.mem != null) marked++ }
    for (let i = 1; i < n.length; i++) walk(n[i])
  }
  walk(fn)
  return { accesses, marked }
}
/** `to`, a load or a store a pass made in place of `from`, with `from`'s mark; returns `to`. */
export const carry = (from, to) => { if (isArr(from) && isArr(to) && from.mem != null) to.mem = from.mem; return to }

const layoutsOf = (m) => m.slice(m.indexOf(':') + 1).split(',')
/** Whether two marks (a node's `mem`) may name the same bytes. */
export const marksMeet = (a, b) => {
  if (a == null || b == null) return true
  if (a[0] !== b[0]) return false
  if (a[0] === 'e') return a === b
  if (a.slice(0, a.indexOf(':')) !== b.slice(0, b.indexOf(':'))) return false
  const lb = new Set(layoutsOf(b))
  return layoutsOf(a).some(s => lb.has(s))
}

/** Whether accesses `a` and `b` (addressOf's) may touch the same bytes; `distinct` the roots a reader proved apart. */
export const mayAlias = (a, b, distinct = null) => {
  if (!marksMeet(a.mem, b.mem)) return false
  const o = overlaps(a, b)
  if (o !== null) return o
  if (a.header && b.store && HEADER_STORE_FREE.has(b.op) || b.header && a.store && HEADER_STORE_FREE.has(a.op)) return false
  if (distinct && a.root && b.root && a.root !== b.root && distinct.has(a.root) && distinct.has(b.root)) return false
  return true
}
