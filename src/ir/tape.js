/**
 * The IR tape: a module, or one function, as parallel typed arrays.
 *
 * Every node is an index. Columns: `op` (an interned name for an instruction;
 * a negative marker for an atom: string, number, bigint, null, undefined,
 * boolean, a byte blob), `a` (first child), `next` (next sibling), `ty`
 * (interned result type, 0 for none), `imm` (number payload), `sym` (interned
 * string payload), `sid` (schema id, NONE for none). A pass is a loop over
 * indices; a rewrite links children; nothing is looked up by name at emission.
 *
 * The tape enters the pipeline between the last WAT-array pass and watr:
 * `fromWat` decodes the assembled module, tape passes run, `toWat` encodes
 * it back. Each WAT-array pass ported here deletes its array version; when
 * emit builds the tape directly the decoder goes. Until then the facts
 * carried across are the result type (`.type`) and the schema id
 * (`.schemaSid`); the other expando facts end at the boundary, nothing after
 * it reads them.
 *
 * @module ir/tape
 */

export const OP_STR = -1, OP_NUM = -2, OP_BIG = -3, OP_NULL = -4, OP_UNDEF = -5, OP_BOOL = -6, OP_BYTES = -7
/** A `[null, …]` node: the reserved intern id of the empty name. */
export const OP_NULLHEAD = 0
export const NONE = -1

const INIT = 1 << 12

/** The one tape. Scratch: reset per compile, grown by doubling. */
export const T = {
  n: 0,
  op: new Int32Array(INIT),
  a: new Int32Array(INIT),
  next: new Int32Array(INIT),
  ty: new Int32Array(INIT),
  imm: new Float64Array(INIT),
  sym: new Int32Array(INIT),
  sid: new Int32Array(INIT),
  syms: [''],
  symId: new Map([['', 0]]),
  bigs: [],
  blobs: [],
}

export function resetTape() {
  T.n = 0
  T.syms = ['']
  T.symId = new Map([['', 0]])
  T.bigs = []
  T.blobs = []
}

export const intern = (s) => {
  let id = T.symId.get(s)
  if (id === undefined) { id = T.syms.length; T.syms.push(s); T.symId.set(s, id) }
  return id
}

const grow = () => {
  const cap = T.op.length * 2
  const op = new Int32Array(cap); op.set(T.op); T.op = op
  const a = new Int32Array(cap); a.set(T.a); T.a = a
  const next = new Int32Array(cap); next.set(T.next); T.next = next
  const ty = new Int32Array(cap); ty.set(T.ty); T.ty = ty
  const imm = new Float64Array(cap); imm.set(T.imm); T.imm = imm
  const sym = new Int32Array(cap); sym.set(T.sym); T.sym = sym
  const sid = new Int32Array(cap); sid.set(T.sid); T.sid = sid
}

/** Allocate a node with no children. */
export function node(op) {
  if (T.n === T.op.length) grow()
  const id = T.n++
  T.op[id] = op; T.a[id] = NONE; T.next[id] = NONE; T.ty[id] = 0; T.imm[id] = 0; T.sym[id] = NONE; T.sid[id] = NONE
  return id
}

export const str = (s) => { const id = node(OP_STR); T.sym[id] = intern(s); return id }
/** A string atom of an interned symbol. */
export const sym = (id) => { const a = node(OP_STR); T.sym[a] = id; return a }
export const num = (v) => { const id = node(OP_NUM); T.imm[id] = v; return id }
/** A byte blob (a custom section's payload), one atom. */
export const bytes = (b) => { const id = node(OP_BYTES); T.imm[id] = T.blobs.length; T.blobs.push(b); return id }
export const isStr = (id, s) => T.op[id] === OP_STR && T.syms[T.sym[id]] === s
/** The text of the string atom at `id`, or null. */
export const text = (id) => id !== NONE && T.op[id] === OP_STR ? T.syms[T.sym[id]] : null
/** The i-th child of `id`, or NONE. */
export function child(id, i) {
  let c = T.a[id]
  while (i-- > 0 && c !== NONE) c = T.next[c]
  return c
}
/** Unlink the child `old` of `parent`. */
export function remove(parent, old) {
  if (T.a[parent] === old) { T.a[parent] = T.next[old]; return }
  let c = T.a[parent]
  while (T.next[c] !== old) c = T.next[c]
  T.next[c] = T.next[old]
}

/** Append `child` as the last child of `parent`. */
export function push(parent, child) {
  let c = T.a[parent]
  if (c === NONE) { T.a[parent] = child; return child }
  while (T.next[c] !== NONE) c = T.next[c]
  T.next[c] = child
  return child
}

/** Replace the child `old` of `parent` with `id`, keeping the position. */
export function replace(parent, old, id) {
  T.next[id] = T.next[old]
  if (T.a[parent] === old) { T.a[parent] = id; return }
  let c = T.a[parent]
  while (T.next[c] !== old) c = T.next[c]
  T.next[c] = id
}

/** A deep copy of the subtree at `id` (a sibling-less root). */
export function clone(id) {
  const c = node(T.op[id])
  T.ty[c] = T.ty[id]; T.imm[c] = T.imm[id]; T.sym[c] = T.sym[id]; T.sid[c] = T.sid[id]
  let prev = NONE
  for (let k = T.a[id]; k !== NONE; k = T.next[k]) { const kc = clone(k); if (prev === NONE) T.a[c] = kc; else T.next[prev] = kc; prev = kc }
  return c
}

/** Insert `id` after the child `prev` of `parent`, or first when `prev` is NONE. */
export function insertAfter(parent, prev, id) {
  if (prev === NONE) { T.next[id] = T.a[parent]; T.a[parent] = id; return }
  T.next[id] = T.next[prev]
  T.next[prev] = id
}

/** Decode a WAT-array tree into the tape; returns the root index. With `consume`, an
 *  array with array children is emptied once decoded, so the tree it came from is
 *  collectable as the tape takes it (a module the size of the compiler is held once,
 *  not twice); an array the tree shares decodes once and copies after. A leaf's array
 *  (`['i32.const', 0]`: atoms alone) holds no subtree and stays: watr's peephole shares
 *  such constants across every module it optimizes. */
export function fromWat(x, consume = false, seen = consume ? new Map() : null) {
  if (Array.isArray(x)) {
    const head = x[0]
    if (typeof head === 'number') return bytes(x)
    if (seen) { const was = seen.get(x); if (was !== undefined) return clone(was) }
    const id = node(head == null ? OP_NULLHEAD : intern(String(head)))
    if (typeof x.type === 'string') T.ty[id] = intern(x.type)
    if (typeof x.schemaSid === 'number') T.sid[id] = x.schemaSid
    let prev = NONE, leaf = true
    for (let i = 1; i < x.length; i++) {
      if (Array.isArray(x[i])) leaf = false
      const c = fromWat(x[i], consume, seen)
      if (prev === NONE) T.a[id] = c; else T.next[prev] = c
      prev = c
    }
    if (seen) { seen.set(x, id); if (!leaf) x.length = 0 }
    return id
  }
  if (typeof x === 'string') return str(x)
  if (typeof x === 'number') return num(x)
  if (typeof x === 'bigint') { const id = node(OP_BIG); T.imm[id] = T.bigs.length; T.bigs.push(x); return id }
  if (x === null) return node(OP_NULL)
  if (x === undefined) return node(OP_UNDEF)
  if (typeof x === 'boolean') { const id = node(OP_BOOL); T.imm[id] = x ? 1 : 0; return id }
  throw new Error(`tape: cannot decode a ${typeof x} node`)
}

/** Encode a tape subtree back into WAT arrays. */
export function toWat(id) {
  const op = T.op[id]
  if (op === OP_STR) return T.syms[T.sym[id]]
  if (op === OP_NUM) return T.imm[id]
  if (op === OP_BIG) return T.bigs[T.imm[id]]
  if (op === OP_NULL) return null
  if (op === OP_UNDEF) return undefined
  if (op === OP_BOOL) return T.imm[id] !== 0
  if (op === OP_BYTES) return T.blobs[T.imm[id]]
  const out = [op === OP_NULLHEAD ? null : T.syms[op]]
  for (let c = T.a[id]; c !== NONE; c = T.next[c]) out.push(toWat(c))
  if (T.ty[id] !== 0) out.type = T.syms[T.ty[id]]
  if (T.sid[id] !== NONE) out.schemaSid = T.sid[id]
  return out
}

/** Structural check of the subtree at `root`: every link in range, atoms
 *  childless, every node reached once (a tree, not a graph). Returns an
 *  error string or null. Iterative, so a deep body cannot overflow it. */
export function verify(root) {
  const seen = new Uint8Array(T.n)
  const stack = [root]
  while (stack.length) {
    const id = stack.pop()
    if (seen[id]) return `node ${id} reached twice`
    seen[id] = 1
    if (T.op[id] < 0 && T.a[id] !== NONE) return `atom ${id} has children`
    if (T.op[id] >= T.syms.length) return `node ${id} names an unknown op`
    for (let c = T.a[id], k = 0; c !== NONE; c = T.next[c], k++) {
      if (c < 0 || c >= T.n) return `link out of range: ${c}`
      if (k > T.n) return `sibling cycle under node ${id}`
      stack.push(c)
    }
  }
  return null
}

/** Pre-order visit of the subtree at `root`: `fn(id, parent)`; returning
 *  false skips the children. Iterative, one stack of (node, parent) pairs:
 *  a node's sibling goes under its first child, so the subtree comes first. */
export function walk(root, fn) {
  const stack = [root, NONE]
  while (stack.length) {
    const parent = stack.pop(), id = stack.pop()
    const descend = fn(id, parent) !== false
    if (id !== root && T.next[id] !== NONE) stack.push(T.next[id], parent)
    if (descend && T.a[id] !== NONE) stack.push(T.a[id], id)
  }
}
