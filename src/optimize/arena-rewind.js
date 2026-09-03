/**
 * Arena rewind on the tape: a function that allocates only for its own
 * result restores the heap pointer before it returns, so a call leaves no
 * garbage. A function qualifies when its record allows it (no parameters,
 * one scalar result that is not a pointer: `rewindable` maps its name to
 * the result type) and its body has no `global.set`, `return_call`,
 * `call_indirect` or `call_ref` and calls only arena-safe callees: the
 * allocator and pointer helpers, or functions that are transitively safe
 * themselves (no `global.set`, `call_indirect` or `call_ref`, calls only to
 * safe callees), found by a fixpoint over the call graph.
 *
 * The rewrite saves the heap pointer into a local at entry and, at every
 * `return` and at the fall-through, moves the result into a local, restores
 * the pointer and yields the local. `return` is stack-polymorphic, so the
 * value is what gets wrapped, never the return itself.
 *
 * @module optimize/arena-rewind
 */
import { T, NONE, intern, text, walk, node, str, num, push, insertAfter } from '../ir/tape.js'
import { T as MARK } from '../ast.js'

const ARENA_SAFE = [
  '$__alloc', '$__alloc_hdr', '$__alloc_hdr_n', '$__mkptr',
  '$__ptr_offset', '$__ptr_type', '$__ptr_aux',
  '$__len', '$__cap', '$__typed_shift', '$__typed_data',
]
const DECLS = ['export', 'import', 'type', 'param', 'result', 'local']

/** @param rewindable  Map `$name` → result type of the functions whose records allow a rewind
 *  @param heapAddr    the heap pointer's memory address under shared memory, null when it is the `$__heap` global */
export function arenaRewind(root, { rewindable, heapAddr }) {
  const FUNC = intern('func'), CALL = intern('call'), RETURN = intern('return'), RETURN_CALL = intern('return_call')
  const GLOBAL_SET = intern('global.set'), CALL_INDIRECT = intern('call_indirect'), CALL_REF = intern('call_ref')
  const LOCAL = intern('local'), LOCAL_SET = intern('local.set'), LOCAL_GET = intern('local.get'), BLOCK = intern('block'), RESULT = intern('result')
  const decl = new Set(DECLS.map(intern))
  // The header: declarations, and the comment atoms a template carries between them.
  const isHeader = (c) => T.op[c] < 0 || decl.has(T.op[c])
  const bodyStart = (f) => { let c = T.next[T.a[f]]; while (c !== NONE && isHeader(c)) c = T.next[c]; return c }
  const eachBody = (f, fn) => { for (let c = bodyStart(f); c !== NONE; c = T.next[c]) walk(c, fn) }

  // Effects per named function, then the safe-callee fixpoint.
  const info = new Map()
  for (let f = T.a[root]; f !== NONE; f = T.next[f]) {
    if (T.op[f] !== FUNC) continue
    const name = text(T.a[f])
    if (name === null) continue
    const rec = { unsafe: false, calls: new Set() }
    eachBody(f, (id) => {
      const op = T.op[id]
      if (op === GLOBAL_SET || op === CALL_INDIRECT || op === CALL_REF) rec.unsafe = true
      else if (op === CALL) { const callee = text(T.a[id]); if (callee !== null && !ARENA_SAFE.includes(callee)) rec.calls.add(callee) }
    })
    info.set(name, rec)
  }
  const safe = new Set(ARENA_SAFE)
  for (let changed = true; changed;) {
    changed = false
    for (const [name, rec] of info) {
      if (safe.has(name) || rec.unsafe) continue
      let ok = true
      for (const c of rec.calls) if (!safe.has(c) && info.has(c)) { ok = false; break }
      if (ok) { safe.add(name); changed = true }
    }
  }

  const inMemory = heapAddr != null
  const heapGet = () => { const g = node(intern(inMemory ? 'i32.load' : 'global.get')); if (inMemory) push(push(g, node(intern('i32.const'))), num(heapAddr)); else push(g, str('$__heap')); return g }
  const heapSet = (value) => {
    const s = node(intern(inMemory ? 'i32.store' : 'global.set'))
    if (inMemory) push(push(s, node(intern('i32.const'))), num(heapAddr)); else push(s, str('$__heap'))
    push(s, value)
    return s
  }
  const local = (name, ty) => { const l = node(LOCAL); push(l, str(name)); push(l, str(ty)); return l }
  const localGet = (name) => { const g = node(LOCAL_GET); push(g, str(name)); return g }
  const localSet = (name, value) => { const s = node(LOCAL_SET); push(s, str(name)); push(s, value); return s }

  for (let f = T.a[root]; f !== NONE; f = T.next[f]) {
    if (T.op[f] !== FUNC) continue
    const name = text(T.a[f])
    const resultType = name === null ? undefined : rewindable.get(name)
    if (resultType === undefined) continue
    let unsafe = false, hasAlloc = false
    eachBody(f, (id) => {
      if (unsafe) return false
      const op = T.op[id]
      if (op === GLOBAL_SET || op === RETURN_CALL || op === CALL_INDIRECT || op === CALL_REF) { unsafe = true; return false }
      if (op === CALL) {
        const callee = text(T.a[id])
        if (callee === '$__alloc' || callee === '$__alloc_hdr' || callee === '$__alloc_hdr_n') hasAlloc = true
        if (!safe.has(callee)) { unsafe = true; return false }
      }
    })
    if (unsafe || !hasAlloc) continue

    const declared = new Set()
    for (let c = T.next[T.a[f]]; c !== NONE; c = T.next[c]) if (T.op[c] === LOCAL) declared.add(text(T.a[c]))
    let id = 0
    while (declared.has(`$${MARK}heap_save${id}`) || declared.has(`$${MARK}arena_ret${id}`)) id++
    const save = `$${MARK}heap_save${id}`, ret = `$${MARK}arena_ret${id}`

    // The last instruction (a trailing comment atom is not it).
    let last = NONE, beforeLast = NONE
    for (let c = T.a[f], prev = NONE; c !== NONE; prev = c, c = T.next[c]) if (T.op[c] >= 0) { beforeLast = prev; last = c }
    const endsWithReturn = T.op[last] === RETURN || T.op[last] === RETURN_CALL

    // Every `return X` yields X through the result local after the restore.
    eachBody(f, (id) => {
      if (T.op[id] !== RETURN || T.a[id] === NONE) return
      const value = T.a[id]
      const block = node(BLOCK)
      push(push(block, node(RESULT)), str(resultType))
      T.next[value] = NONE
      push(block, localSet(ret, value))
      push(block, heapSet(localGet(save)))
      push(block, localGet(ret))
      T.a[id] = block
      return false
    })
    // The fall-through value takes the same path.
    if (!endsWithReturn) {
      T.next[beforeLast] = NONE
      T.next[last] = NONE
      push(f, localSet(ret, last))
      push(f, heapSet(localGet(save)))
      push(f, localGet(ret))
    }
    // Declarations and the save at the top of the body.
    let at = T.a[f]
    while (T.next[at] !== NONE && isHeader(T.next[at])) at = T.next[at]
    for (const n of [local(save, 'i32'), local(ret, resultType), localSet(save, heapGet())]) { insertAfter(f, at, n); at = n }
  }
}
