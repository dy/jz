/**
 * Arena rewind on the tape: a function that allocates only for its own
 * result restores the heap pointer before it returns, so a call leaves no
 * garbage. A function qualifies when its record allows it (one scalar
 * result that is not a pointer, and a frame no allocation escapes:
 * `rewindable` maps its name to the result type, `unsafe` names every
 * function whose frame lets an allocation escape — compile/analyze/
 * frame-effects.js) and its body has no `global.set`, `return_call`,
 * `call_indirect` or `call_ref` and calls only arena-safe callees: the
 * allocator and pointer helpers, or functions that are transitively safe
 * themselves (not unsafe by record, no `global.set`, `call_indirect` or
 * `call_ref`, no call to an import that takes arguments — a host may keep
 * what it receives — and, for a runtime kernel, no store through an
 * address a global reaches: a kernel that files a value into a module-wide
 * table lets it outlive every frame), found by a fixpoint over the call
 * graph.
 *
 * The rewrite saves the heap pointer into a local at entry and, at every
 * `return` and at the fall-through, moves the result into a local, restores
 * the pointer and yields the local. `return` is stack-polymorphic, so the
 * value is what gets wrapped, never the return itself.
 *
 * @module optimize/arena-rewind
 */
import { T, NONE, intern, text, walk, node, str, num, push, insertAfter, remove } from '../ir/tape.js'
import { T as MARK } from '../ast.js'

const ARENA_SAFE = [
  '$__alloc', '$__alloc_hdr', '$__alloc_hdr_n', '$__mkptr',
  '$__ptr_offset', '$__ptr_type', '$__ptr_aux',
  '$__len', '$__cap', '$__typed_shift', '$__typed_data',
]
const DECLS = ['export', 'import', 'type', 'param', 'result', 'local']

// Globals whose writes are not state a rewind could strand: the heap pointer
// and its limits (a write is an allocation or a growth); the error
// transport, written on every throw path before the trap or the exception
// that leaves the frame and read by the host only after a trap; and the
// collection insertion stamp (module/collection/upsert.js), a counter that
// only ever grows.
// The heap's own globals, and the property caches a rewind leaves valid: the
// inline caches (module/collection.js, optimize/devirt.js) key on the schema
// id in a pointer's high word, never on an address; the dynamic-get cache
// (the last header-less receiver's address and its properties in the global
// table) is kept coherent by every writer of that table, which no rewound
// frame reaches (a store through a global is vetoed below), so an address a
// rewind reuses reads what the table holds for it. The for-in key cache
// (`__enumc_*`) holds a key array a rewind may free: it stays vetoed.
const HEAP_GLOBALS = new Set(['$__heap', '$__heap_end', '$__heap_end64', '$__heap_start', '$__heap_reset', '$__jz_last_err_bits', '$__seq',
  '$__ic_found_slot', '$__ic_found_hi', '$__dyn_get_cache_off', '$__dyn_get_cache_props'])
const IC_SITE = /^\$__ic_(hi|slot)\d+$/
const heapScratch = (name) => HEAP_GLOBALS.has(name) || IC_SITE.test(name)
const NO_NAMES = new Set()
// The durable-heap log (module/core/durable-log.js) allocates its buffers and
// records entries only when a durable (pre-init) array or slot is grown,
// mutated in place, or handed an ephemeral heap value. Every rewind
// candidate and every user function it can reach is census-clean
// (compile/analyze/frame-effects.js): none performs such a write, so these
// kernels never take their logging path inside a rewound frame.
const CENSUS_GUARDED = /^\$__durable_/

/** @param rewindable  Map `$name` → result type of the functions whose records allow a rewind
 *  @param unsafe      Set of `$name`: functions whose frame lets an allocation escape (never safe callees)
 *  @param heapAddr    the heap pointer's memory address under shared memory, null when it is the `$__heap` global
 *  @param report      optional (name, reason) => void: why a candidate in `rewindable` was not rewound */
export function arenaRewind(root, { rewindable, heapAddr, unsafe = NO_NAMES, report = null }) {
  const FUNC = intern('func'), CALL = intern('call'), RETURN = intern('return'), RETURN_CALL = intern('return_call'), IMPORT = intern('import'), GLOBAL = intern('global'), MUT = intern('mut')
  const GLOBAL_SET = intern('global.set'), CALL_INDIRECT = intern('call_indirect'), CALL_REF = intern('call_ref')
  const LOCAL = intern('local'), LOCAL_SET = intern('local.set'), LOCAL_GET = intern('local.get'), BLOCK = intern('block'), RESULT = intern('result')
  const decl = new Set(DECLS.map(intern))
  // The header: declarations, and the comment atoms a template carries between them.
  const isHeader = (c) => T.op[c] < 0 || decl.has(T.op[c])
  const bodyStart = (f) => { let c = T.next[T.a[f]]; while (c !== NONE && isHeader(c)) c = T.next[c]; return c }
  const eachBody = (f, fn) => { for (let c = bodyStart(f); c !== NONE; c = T.next[c]) walk(c, fn) }
  const opText = (id) => T.syms[T.op[id]]

  // Imports: callees the module declares but does not define. Immutable
  // globals: pooled constants, values rather than tables.
  const imports = new Set(), constants = new Set(HEAP_GLOBALS)
  for (let c = T.a[root]; c !== NONE; c = T.next[c]) {
    if (T.op[c] === IMPORT) { for (let d = T.a[c]; d !== NONE; d = T.next[d]) if (T.op[d] === FUNC) { const n = text(T.a[d]); if (n !== null) imports.add(n) } }
    else if (T.op[c] === GLOBAL) { let mut = false; for (let d = T.a[c]; d !== NONE; d = T.next[d]) if (T.op[d] === MUT) mut = true; if (!mut) { const n = text(T.a[c]); if (n !== null) constants.add(n) } }
  }

  // A store: any instruction that writes memory or a table.
  const isStore = (id) => { const s = opText(id); return s != null && (/\.store(8|16|32|64)?(_lane)?$/.test(s) || /\.atomic\.rmw/.test(s) || s === 'memory.copy' || s === 'memory.fill' || s === 'memory.init' || (s.startsWith('table.') && s !== 'table.get' && s !== 'table.size')) }
  // Whether an expression's value may derive from a module-wide table: a
  // global other than the heap pointers, a local such a value reached, or
  // the result of a callee whose returned value may (`tableResults`, below).
  const reaches = (id, tainted) => {
    if (id === NONE) return true   // an operand left on the stack (flat WAT): unknown, so tainted
    let hit = false
    walk(id, (n) => {
      if (hit) return false
      const s = opText(n)
      if (s === 'global.get') { if (!constants.has(text(T.a[n]))) hit = true }
      else if (s === 'local.get') { if (tainted.has(text(T.a[n]))) hit = true }
      else if (s === 'call') { const c = text(T.a[n]); if (!ARENA_SAFE.includes(c) && (!defined.has(c) || tableResults.has(c))) hit = true }
      else if (s === 'call_indirect' || s === 'call_ref') hit = true
    })
    return hit
  }
  // The locals a table-derived value reaches, to a fixpoint over the body.
  const taintedLocals = (f) => {
    const tainted = new Set()
    for (let changed = true; changed;) {
      changed = false
      eachBody(f, (id) => {
        const s = opText(id)
        if ((s === 'local.set' || s === 'local.tee') && !tainted.has(text(T.a[id])) && reaches(T.next[T.a[id]], tainted)) { tainted.add(text(T.a[id])); changed = true }
      })
    }
    return tainted
  }
  // Functions whose returned value may derive from a table: a `return`
  // operand or the fall-through value reaches one. A function the module
  // does not define (an import) may return anything. A fixpoint over the
  // module, since a callee's result feeds its caller's locals.
  const defined = new Set(), tableResults = new Set(), returnsOf = new Map()
  for (let f = T.a[root]; f !== NONE; f = T.next[f]) {
    if (T.op[f] !== FUNC) continue
    const name = text(T.a[f])
    if (name === null) continue
    defined.add(name)
    let hasResult = false
    for (let c = T.next[T.a[f]]; c !== NONE && isHeader(c); c = T.next[c]) if (T.op[c] === RESULT) hasResult = true
    if (!hasResult) continue
    let last = NONE
    for (let c = T.a[f]; c !== NONE; c = T.next[c]) if (T.op[c] >= 0 && !isHeader(c)) last = c
    const values = []
    if (last !== NONE) values.push(last)
    eachBody(f, (id) => { if (T.op[id] === RETURN && T.a[id] !== NONE) values.push(T.a[id]) })
    returnsOf.set(name, { f, values })
  }
  for (let changed = true; changed;) {
    changed = false
    for (const [name, { f, values }] of returnsOf) {
      if (tableResults.has(name)) continue
      const tainted = taintedLocals(f)
      if (values.some(v => reaches(v, tainted))) { tableResults.add(name); changed = true }
    }
  }
  // A runtime kernel stores through an address a global reaches: it files a
  // value into a module-wide table (a durable log, a property cache, a
  // pool), where it outlives every frame. Stores through parameters are the
  // caller's business; stores into its own allocations are fresh memory.
  const storesOutside = (f) => {
    const tainted = taintedLocals(f)
    let outside = false
    eachBody(f, (id) => {
      if (outside) return false
      if (!isStore(id)) return
      const s = opText(id)
      if (s.startsWith('table.') || T.a[id] === NONE || reaches(T.a[id], tainted)) outside = true
    })
    return outside
  }

  // Effects per named function, then the safe-callee fixpoint.
  const info = new Map()
  for (let f = T.a[root]; f !== NONE; f = T.next[f]) {
    if (T.op[f] !== FUNC) continue
    const name = text(T.a[f])
    if (name === null) continue
    const rec = { unsafe: unsafe.has(name), why: unsafe.has(name) ? 'escape' : null, tapeUnsafe: false, tapeWhy: null, calls: new Set(), allocs: false }
    const veto = (why) => { rec.tapeUnsafe = true; rec.tapeWhy ??= why; if (!rec.unsafe) { rec.unsafe = true; rec.why = why } }
    eachBody(f, (id) => {
      const op = T.op[id]
      if (op === GLOBAL_SET) { if (!heapScratch(text(T.a[id]))) veto('global.set ' + text(T.a[id])) }
      else if (op === CALL_INDIRECT || op === CALL_REF) veto(opText(id))
      else if (op === CALL) {
        const callee = text(T.a[id])
        if (callee === '$__alloc' || callee === '$__alloc_hdr' || callee === '$__alloc_hdr_n') rec.allocs = true
        if (callee === null || ARENA_SAFE.includes(callee) || CENSUS_GUARDED.test(callee)) return
        // jz's own interop imports (`$__ext_*`, interop.js) decode every value
        // they receive into host copies and never keep a wasm pointer; a user
        // import that takes an argument may keep whatever it is handed.
        if (imports.has(callee)) { if (T.next[T.a[id]] !== NONE && !callee.startsWith('$__ext_')) veto('import ' + callee); return }
        rec.calls.add(callee)
      }
    })
    if (!rec.unsafe && name.startsWith('$__') && !CENSUS_GUARDED.test(name) && storesOutside(f)) veto('stores outside')
    info.set(name, rec)
  }
  // A function is unsafe when it is unsafe itself or calls one that is: the
  // veto propagates to callers until nothing changes, so a cycle of clean
  // functions (mutually recursive kernels) stays safe. A callee the module
  // does not define (an import) is safe when it takes no argument, checked
  // where the call was seen.
  for (let changed = true; changed;) {
    changed = false
    for (const [name, rec] of info) {
      for (const c of rec.calls) {
        const g = info.get(c)
        if (g?.unsafe && !rec.unsafe) { rec.unsafe = true; rec.why = 'calls ' + c + ': ' + g.why; changed = true }
        if (g?.tapeUnsafe && !rec.tapeUnsafe) { rec.tapeUnsafe = true; rec.tapeWhy = 'calls ' + c + ': ' + g.tapeWhy; changed = true }
      }
    }
  }
  const safe = new Set(ARENA_SAFE)
  for (const [name, rec] of info) if (!rec.unsafe) safe.add(name)
  // Allocation is transitive: a string concatenation allocates inside its kernel.
  for (let changed = true; changed;) {
    changed = false
    for (const [, rec] of info) {
      if (rec.allocs) continue
      for (const c of rec.calls) if (info.get(c)?.allocs) { rec.allocs = true; changed = true; break }
    }
  }

  // Per-iteration rewinds (emit/control-flow.js): a `local.set $<mark>lrwN` before a
  // loop and a restore through that local at the top of its body. Kept where the
  // function's own body and callees are tape-safe and the loop allocates, dropped
  // otherwise; the census that placed them proved the iteration's escapes.
  const isMarker = (id) => { const n = text(T.a[id]); return n !== null && n.startsWith('$' + MARK + 'lrw') }
  // A loop's own tape: what its body does and calls decides its rewind, where
  // the function around it may be vetoed elsewhere (a dispatch through a
  // table before the loop) without touching what the iterations free.
  const tapeUnsafeIn = (id) => {
    let why = null
    walk(id, (n) => {
      if (why !== null) return false
      const op = T.op[n]
      if (op === GLOBAL_SET) { if (!heapScratch(text(T.a[n]))) why = 'global.set ' + text(T.a[n]) }
      else if (op === CALL_INDIRECT || op === CALL_REF) why = opText(n)
      else if (op === CALL) {
        const callee = text(T.a[n])
        if (callee === null || callee === '$__alloc' || callee === '$__alloc_hdr' || callee === '$__alloc_hdr_n' || ARENA_SAFE.includes(callee) || CENSUS_GUARDED.test(callee)) return
        if (imports.has(callee)) { if (T.next[T.a[n]] !== NONE && !callee.startsWith('$__ext_')) why = 'import ' + callee; return }
        const g = info.get(callee)
        if (g === undefined) why = 'calls ' + callee + ' (undefined)'
        else if (g.tapeUnsafe) why = 'calls ' + callee + ': ' + g.tapeWhy
      }
    })
    return why
  }
  const allocatesIn = (id) => { let hit = false; walk(id, (n) => { if (hit) return false; if (T.op[n] === CALL) { const c = text(T.a[n]); if (c === '$__alloc' || c === '$__alloc_hdr' || c === '$__alloc_hdr_n' || info.get(c)?.allocs) hit = true } }); return hit }
  for (let f = T.a[root]; f !== NONE; f = T.next[f]) {
    if (T.op[f] !== FUNC) continue
    const name = text(T.a[f])
    const rec = name === null ? null : info.get(name)
    const parents = new Map(), saves = [], restores = []
    eachBody(f, (id) => {
      for (let c = T.a[id]; c !== NONE; c = T.next[c]) parents.set(c, id)
      const s = opText(id)
      if (s === 'local.set' && isMarker(id)) saves.push(id)
      else if ((s === 'global.set' || s === 'i32.store') && T.a[id] !== NONE) { const v = T.next[T.a[id]]; if (v !== NONE && opText(v) === 'local.get' && isMarker(v)) restores.push(id) }
    })
    if (!saves.length && !restores.length) continue
    const bodyChildren = new Set()
    for (let c = bodyStart(f); c !== NONE; c = T.next[c]) bodyChildren.add(c)
    const drop = (id) => { const p = parents.get(id); if (p !== undefined) remove(p, id); else if (bodyChildren.has(id)) remove(f, id) }
    const keepLocals = new Set()
    for (const r of restores) {
      let loopNode = parents.get(r)
      while (loopNode !== undefined && opText(loopNode) !== 'loop') loopNode = parents.get(loopNode)
      const tape = rec == null || loopNode === undefined ? null : tapeUnsafeIn(loopNode)
      const keep = rec != null && loopNode !== undefined && tape === null && allocatesIn(loopNode)
      if (keep) keepLocals.add(text(T.a[T.next[T.a[r]]]))
      else { drop(r); report?.(name, 'loop: ' + (rec == null ? 'no record' : loopNode === undefined ? 'no loop' : tape !== null ? 'tape: ' + tape : 'no allocation')) }
    }
    for (const s of saves) if (!keepLocals.has(text(T.a[s]))) drop(s)
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
    const rec = info.get(name)
    if (rec == null) continue
    if (rec.unsafe) { report?.(name, rec.why); continue }
    let unsafe = false, hasAlloc = rec.allocs
    const tails = []
    eachBody(f, (id) => {
      if (unsafe) return false
      if (T.op[id] !== RETURN_CALL) return
      // A tail call to a safe runtime kernel (never the function itself, never
      // user code whose own tail calls may recurse) can be a plain call: the
      // frame then survives the callee and can restore the heap after it.
      const callee = text(T.a[id])
      if (callee !== null && callee !== name && callee.startsWith('$__') && safe.has(callee)) { tails.push(id); if (info.get(callee)?.allocs) hasAlloc = true; return }
      unsafe = true; return false
    })
    if (!unsafe && hasAlloc) for (const id of tails) {
      // `(return_call $k args…)` → `(return (call $k args…))`: the children move
      // under a new call node, and the return wrapping below treats it like any
      // other `return X`.
      const call = node(CALL)
      T.a[call] = T.a[id]
      T.a[id] = call
      T.op[id] = RETURN
    }
    if (unsafe || !hasAlloc) { report?.(name, unsafe ? 'return_call' : 'no allocation'); continue }

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
