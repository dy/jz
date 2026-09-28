/**
 * Arena rewind on the tape: a function that allocates only for its own
 * result restores the heap pointer before it returns, so a call leaves no
 * garbage. A function qualifies when its record allows it (one scalar
 * result that is not a pointer, and a frame no allocation escapes:
 * `rewindable` maps its name to the result type, `unsafe` names every
 * function whose frame lets an allocation escape — compile/analyze/
 * frame-effects.js) and its body has no `global.set`, `return_call` or
 * `call_ref` and calls only arena-safe callees: the allocator and pointer
 * helpers, or functions that are transitively safe themselves (not unsafe
 * by record, no `global.set` or `call_ref`, no call to an import that takes
 * arguments (a host may keep what it receives; the runtime's own imports
 * keep nothing but a callback they schedule, `keepsNothing`) and, for a
 * runtime kernel, no store through an address a global reaches: a kernel that files a
 * value into a module-wide table lets it outlive every frame), found by a
 * fixpoint over the call graph. A `call_indirect` reaches only the functions
 * the table holds. In a function whose closure calls the census resolved
 * (frame-effects.js), it reaches the closures those calls may run
 * (`closureTargets`) and whatever the table holds besides closures: those
 * become its callees. Elsewhere it is safe when every function the table
 * holds is (a greatest fixpoint: a closure calling closures is safe when the
 * table is).
 *
 * The rewrite saves the heap pointer into a local at entry and, at every
 * `return` and at the fall-through, moves the result into a local, restores
 * the pointer and yields the local. `return` is stack-polymorphic, so the
 * value is what gets wrapped, never the return itself.
 *
 * A frame the census found escape sites in (`conditional`, frame-effects.js)
 * restores the heap only when none ran: it saves the escape flag at entry and
 * clears it, the sites raise it where they run (emit/dispatch.js), and at
 * return the heap goes back when the flag is still down, then the flag joins
 * the caller's. What the tape would veto at one instruction (a store of a
 * table's global, a call that hands a host import a value, an indirect call
 * into a table holding unsafe code) raises the flag there instead when the
 * instruction may not run on a call (an `if` arm, or past an instruction that
 * may return), making its callers conditional the same way; one that runs on
 * every call reaching it vetoes, as do a kernel filing into a module-wide
 * table, a tail call out of the frame and a frame that suspends. A frame
 * restores on the flag for a reason of its own (a census site, or a flag
 * raised in user code); one a runtime kernel's rare path alone flags keeps
 * its heap, sparing every call the protocol. The flag's writes in functions
 * no conditional frame reaches are dropped.
 *
 * The same proof, allocating or not, is what lets the host release a call's
 * argument copies after it (interop.js, the `jz:release` section): a frame
 * that keeps nothing it made keeps none of what it was handed either, since
 * the census counts a parameter as outer storage and every store of one as
 * an escape. The pass returns those functions; `rewrite: false` (optimize
 * levels without the rewind) proves them without rewriting any.
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
// (`__enumc_arr` and the offset, length and epoch it was made for) holds a key
// array a rewind may free: it stays vetoed. Its epoch counter
// (`__enumc_epoch`, bumped by a dynamic property write) only makes the cache
// miss, which strands nothing.
const HEAP_GLOBALS = new Set(['$__heap', '$__heap_end', '$__heap_end64', '$__heap_start', '$__heap_reset', '$__jz_last_err_bits', '$__seq',
  '$__ic_found_slot', '$__ic_found_hi', '$__dyn_get_cache_off', '$__dyn_get_cache_props', '$__enumc_epoch', '$__esc'])
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
 *  @param report      optional (name, reason) => void: why a candidate in `rewindable` was not rewound
 *  @param rewrite     false: prove the functions without rewriting them (the returned set only)
 *  @param scalarGlobals Set of `$name`: module bindings that never hold a heap value
 *  @param closureTargets Map `$name` → Set of `$closure`: the closures a function's resolved calls may run
 *  @param closureNames Set of `$name`: every closure body the module emitted
 *  @param conditional Map `$name` → reason: functions whose frames run escape sites (restore on the flag)
 *  @param censused   Set of `$name`: the functions and closures the frame census walked; a
 *                    write there to a module binding (`userGlobals`) is the census's to judge:
 *                    a heap value it flagged as a site, anything else keeps nothing fresh
 *  @param keepsNothing Set of `$name`: runtime imports that keep nothing they are handed
 *  @returns `releasable` (the rewindable functions whose frames keep nothing, allocating or
 *    not), `rewound` (those rewritten), and per function whether it allocates and why not */
export function arenaRewind(root, { rewindable, heapAddr, unsafe = NO_NAMES, report = null, rewrite = true, scalarGlobals = NO_NAMES, closureTargets = null, closureNames = NO_NAMES, conditional = NO_NAMES, censused = NO_NAMES, userGlobals = NO_NAMES, keepsNothing = NO_NAMES }) {
  const releasable = new Set(), rewound = new Set(), flagged = new Set()
  // A write the rewind cannot strand: the heap's own globals and caches, and a
  // module binding that never holds a heap value (a counter, a clock).
  const strandsNothing = (name) => heapScratch(name) || scalarGlobals.has(name)
  const FUNC = intern('func'), CALL = intern('call'), RETURN = intern('return'), RETURN_CALL = intern('return_call'), IMPORT = intern('import'), GLOBAL = intern('global'), MUT = intern('mut')
  const GLOBAL_SET = intern('global.set'), CALL_INDIRECT = intern('call_indirect'), CALL_REF = intern('call_ref')
  const LOCAL = intern('local'), LOCAL_SET = intern('local.set'), LOCAL_GET = intern('local.get'), LOCAL_TEE = intern('local.tee'), BLOCK = intern('block'), RESULT = intern('result'), DROP = intern('drop')
  const IF = intern('if'), THEN = intern('then'), ELSE = intern('else')
  const decl = new Set(DECLS.map(intern))
  // The header: declarations, and the comment atoms a template carries between them.
  const isHeader = (c) => T.op[c] < 0 || decl.has(T.op[c])
  const bodyStart = (f) => { let c = T.next[T.a[f]]; while (c !== NONE && isHeader(c)) c = T.next[c]; return c }
  const eachBody = (f, fn) => { for (let c = bodyStart(f); c !== NONE; c = T.next[c]) walk(c, fn) }
  const opText = (id) => T.syms[T.op[id]]

  // Imports: callees the module declares but does not define. Immutable
  // globals: pooled constants, values rather than tables.
  const imports = new Set(), constants = new Set(HEAP_GLOBALS), table = new Set()
  const ELEM = intern('elem')
  for (let c = T.a[root]; c !== NONE; c = T.next[c]) {
    if (T.op[c] === ELEM) { for (let d = T.a[c]; d !== NONE; d = T.next[d]) { const n = text(d); if (n !== null && n.startsWith('$')) table.add(n) } }
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
  const vetoRec = (rec, why) => { rec.tapeUnsafe = true; rec.tapeWhy ??= why; if (!rec.unsafe) { rec.unsafe = true; rec.why = why } }
  const returned = new Map()
  const returns = (id) => {
    let hit = returned.get(id)
    if (hit === undefined) { hit = false; walk(id, (n) => { if (hit) return false; if (T.op[n] === RETURN || T.op[n] === RETURN_CALL) hit = true }); returned.set(id, hit) }
    return hit
  }
  // Whether an instruction of `rec`'s function may not run on a call: it sits
  // in an `if` arm, or past an instruction that may return.
  const guarded = (rec, id) => {
    if (rec.up === null) { const up = rec.up = new Map(); eachBody(rec.f, (n, p) => { up.set(n, p) }) }
    for (let n = id; ;) {
      const p = rec.up.get(n)
      if (p === undefined) return false
      for (let c = p === NONE ? bodyStart(rec.f) : T.a[p]; c !== n && c !== NONE; c = T.next[c]) if (returns(c)) return true
      if (p === NONE) return false
      if (T.op[p] === THEN || T.op[p] === ELSE) return true
      n = p
    }
  }
  // An escape at one instruction: where it may not run on a call, the flag
  // goes up there when it runs (in user code, the frame's own reason to
  // restore on it); elsewhere every call reaching it keeps.
  const escapeAt = (rec, id, why) => {
    if (!guarded(rec, id)) return vetoRec(rec, why)
    rec.flagAt.push(id); rec.flagWhy ??= why
    if (rec.censused) rec.ownFlag = true
  }
  for (let f = T.a[root]; f !== NONE; f = T.next[f]) {
    if (T.op[f] !== FUNC) continue
    const name = text(T.a[f])
    if (name === null) continue
    const rec = { unsafe: unsafe.has(name), why: unsafe.has(name) ? 'escape' : null, tapeUnsafe: false, tapeWhy: null, calls: new Set(), allocs: false, indirect: false,
      f, up: null, censused: censused.has(name), flagAt: [], flagWhy: null, indirectAt: [] }
    eachBody(f, (id) => {
      const op = T.op[id]
      if (op === GLOBAL_SET) { const g = text(T.a[id]); if (!strandsNothing(g) && !(censused.has(name) && userGlobals.has(g?.slice(1)))) escapeAt(rec, id, 'global.set ' + g) }
      else if (op === CALL_INDIRECT) { rec.indirect = true; rec.indirectAt.push(id) }
      else if (op === CALL_REF) escapeAt(rec, id, opText(id))
      else if (op === CALL) {
        const callee = text(T.a[id])
        if (callee === '$__alloc' || callee === '$__alloc_hdr' || callee === '$__alloc_hdr_n') rec.allocs = true
        if (callee === null || ARENA_SAFE.includes(callee) || CENSUS_GUARDED.test(callee)) return
        // jz's own interop imports (`$__ext_*`, interop.js) decode what they
        // receive into host values; the one pointer they keep is a typed
        // array filed on a host object (`__ext_set`), whose store the census
        // flags when its value is fresh and the host counts as kept. The
        // runtime's other imports keep nothing but a callback they schedule
        // (`keepsNothing`, bridge.js hostImport). A user import that takes an
        // argument may keep whatever it is handed.
        if (imports.has(callee)) { if (T.next[T.a[id]] !== NONE && !callee.startsWith('$__ext_') && !keepsNothing.has(callee)) escapeAt(rec, id, 'import ' + callee); return }
        rec.calls.add(callee)
      }
    })
    if (!rec.unsafe && name.startsWith('$__') && !CENSUS_GUARDED.test(name) && storesOutside(f)) vetoRec(rec, 'stores outside')
    info.set(name, rec)
  }
  // A function is unsafe when it is unsafe itself or calls one that is: the
  // veto propagates to callers until nothing changes, so a cycle of clean
  // functions (mutually recursive kernels) stays safe. A callee the module
  // does not define (an import) is safe when it takes no argument, checked
  // where the call was seen.
  // An indirect call whose closures the census resolved calls them, and what
  // the table holds besides closures (a function held as a value, a method).
  const beyondClosures = [...table].filter(n => !closureNames.has(n))
  for (const [name, rec] of info) {
    const targets = rec.indirect ? closureTargets?.get(name) : undefined
    if (!targets) continue
    rec.resolved = true
    for (const t of [...beyondClosures, ...targets]) {
      if (!info.has(t)) { vetoRec(rec, `call_indirect: ${t} is not defined here`); break }
      rec.calls.add(t)
    }
  }
  const propagate = () => {
    for (let changed = true; changed;) {
      changed = false
      for (const [, rec] of info) {
        for (const c of rec.calls) {
          const g = info.get(c)
          if (g?.unsafe && !rec.unsafe) { rec.unsafe = true; rec.why = 'calls ' + c + ': ' + g.why; changed = true }
          if (g?.tapeUnsafe && !rec.tapeUnsafe) { rec.tapeUnsafe = true; rec.tapeWhy = 'calls ' + c + ': ' + g.tapeWhy; changed = true }
        }
      }
    }
  }
  propagate()
  // The table, assumed safe for the indirect calls inside it: when a function
  // in it is not, no indirect call is, and that propagates to their callers.
  const tableUnsafe = [...table].find(n => { const r = info.get(n); return r == null || r.unsafe || r.tapeUnsafe })
  const tableSafe = tableUnsafe === undefined
  if (!tableSafe) {
    const r = info.get(tableUnsafe), why = `call_indirect: the table holds ${tableUnsafe}` + (r ? ': ' + (r.tapeWhy ?? r.why) : '')
    for (const [, rec] of info) if (rec.indirect && !rec.resolved) for (const id of rec.indirectAt) escapeAt(rec, id, why)
    propagate()
  }
  // Flagging is transitive: a function that calls one whose instructions
  // raise the flag, or reaches the table through an indirect call it could
  // not resolve, restores on the flag too.
  for (const [, rec] of info) if (rec.flagAt.length) { rec.tapeFlag = true; rec.tapeFlagWhy = rec.flagWhy }
  for (let changed = true; changed;) {
    changed = false
    const tableFlag = [...table].find(n => info.get(n)?.tapeFlag), tableOwn = [...table].some(n => info.get(n)?.ownFlag)
    for (const [, rec] of info) {
      const viaTable = rec.indirect && !rec.resolved
      if (!rec.ownFlag && ([...rec.calls].some(c => info.get(c)?.ownFlag) || viaTable && tableOwn)) { rec.ownFlag = true; changed = true }
      if (rec.tapeFlag) continue
      let via = [...rec.calls].find(c => info.get(c)?.tapeFlag)
      if (via === undefined && viaTable && tableFlag !== undefined) via = tableFlag
      if (via !== undefined) { rec.tapeFlag = true; rec.tapeFlagWhy = 'calls ' + via + ': ' + info.get(via).tapeFlagWhy; changed = true }
    }
  }
  // A tail call leaves before the epilogue: its callee must neither escape nor raise the flag.
  const safe = new Set(ARENA_SAFE)
  for (const [name, rec] of info) if (!rec.unsafe && !rec.tapeFlag) safe.add(name)
  // Allocation is transitive: a string concatenation allocates inside its
  // kernel, and an indirect call allocates when a function the table holds does.
  for (let changed = true; changed;) {
    changed = false
    const tableAllocs = [...table].some(n => info.get(n)?.allocs)
    for (const [, rec] of info) {
      if (rec.allocs) continue
      if (rec.indirect && !rec.resolved && tableAllocs) { rec.allocs = true; changed = true; continue }
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
      if (op === GLOBAL_SET) { if (!strandsNothing(text(T.a[n]))) why = 'global.set ' + text(T.a[n]) }
      else if (op === CALL_REF || (op === CALL_INDIRECT && (!tableSafe || [...table].some(t => info.get(t)?.tapeFlag)))) why = opText(n)
      else if (op === CALL) {
        const callee = text(T.a[n])
        if (callee === null || callee === '$__alloc' || callee === '$__alloc_hdr' || callee === '$__alloc_hdr_n' || ARENA_SAFE.includes(callee) || CENSUS_GUARDED.test(callee)) return
        if (imports.has(callee)) { if (T.next[T.a[n]] !== NONE && !callee.startsWith('$__ext_') && !keepsNothing.has(callee)) why = 'import ' + callee; return }
        const g = info.get(callee)
        if (g === undefined) why = 'calls ' + callee + ' (undefined)'
        else if (g.tapeUnsafe) why = 'calls ' + callee + ': ' + g.tapeWhy
        else if (g.tapeFlag) why = 'calls ' + callee + ': ' + g.tapeFlagWhy
      }
    })
    return why
  }
  const allocatesIn = (id) => { let hit = false; walk(id, (n) => { if (hit) return false; if (T.op[n] === CALL) { const c = text(T.a[n]); if (c === '$__alloc' || c === '$__alloc_hdr' || c === '$__alloc_hdr_n' || info.get(c)?.allocs) hit = true } }); return hit }
  if (rewrite) for (let f = T.a[root]; f !== NONE; f = T.next[f]) {
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
  const escGet = () => { const g = node(intern('global.get')); push(g, str('$__esc')); return g }
  const escSet = (value) => { const s = node(GLOBAL_SET); push(s, str('$__esc')); push(s, value); return s }
  const i32c = (v) => { const c = node(intern('i32.const')); push(c, num(v)); return c }
  // The return of a rewound frame: the heap back, or for a conditional frame
  // back only when no site raised the flag, the flag then joining the saved one.
  const restore = (save, esave) => {
    if (esave == null) return [heapSet(localGet(save))]
    const test = node(intern('i32.eqz')); push(test, escGet())
    const iff = node(intern('if')); push(iff, test)
    const then = node(intern('then')); push(then, heapSet(localGet(save))); push(iff, then)
    const or = node(intern('i32.or')); push(or, escGet()); push(or, localGet(esave))
    return [iff, escSet(or)]
  }
  const localGet = (name) => { const g = node(LOCAL_GET); push(g, str(name)); return g }
  const localSet = (name, value) => { const s = node(LOCAL_SET); push(s, str(name)); push(s, value); return s }

  for (let f = T.a[root]; f !== NONE; f = T.next[f]) {
    if (T.op[f] !== FUNC) continue
    const name = text(T.a[f])
    const resultType = name === null ? undefined : rewindable.get(name)
    if (resultType === undefined) continue
    const rec = info.get(name)
    if (rec == null) continue
    if (rec.unsafe) { if (rewrite) report?.(name, rec.why); continue }
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
    if (rewrite && !unsafe && hasAlloc) for (const id of tails) {
      // `(return_call $k args…)` → `(return (call $k args…))`: the children move
      // under a new call node, and the return wrapping below treats it like any
      // other `return X`.
      const call = node(CALL)
      T.a[call] = T.a[id]
      T.a[id] = call
      T.op[id] = RETURN
    }
    const cond = conditional.has(name) || rec.tapeFlag
    if (cond && !conditional.has(name) && !rec.ownFlag) { if (rewrite) report?.(name, 'escape: ' + rec.tapeFlagWhy); continue }
    if (!unsafe) { releasable.add(name); if (cond) flagged.add(name) }
    if (!rewrite) continue
    if (unsafe || !hasAlloc) { report?.(name, unsafe ? 'return_call' : 'no allocation'); continue }

    const declared = new Set()
    for (let c = T.next[T.a[f]]; c !== NONE; c = T.next[c]) if (T.op[c] === LOCAL) declared.add(text(T.a[c]))
    let id = 0
    while (declared.has(`$${MARK}heap_save${id}`) || declared.has(`$${MARK}arena_ret${id}`) || declared.has(`$${MARK}esc_save${id}`)) id++
    const save = `$${MARK}heap_save${id}`, ret = `$${MARK}arena_ret${id}`
    const esave = cond ? `$${MARK}esc_save${id}` : null

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
      for (const n of restore(save, esave)) push(block, n)
      push(block, localGet(ret))
      T.a[id] = block
      return false
    })
    // The fall-through value takes the same path.
    if (!endsWithReturn) {
      T.next[beforeLast] = NONE
      T.next[last] = NONE
      push(f, localSet(ret, last))
      for (const n of restore(save, esave)) push(f, n)
      push(f, localGet(ret))
    }
    // Declarations and the save at the top of the body.
    let at = T.a[f]
    while (T.next[at] !== NONE && isHeader(T.next[at])) at = T.next[at]
    const entry = esave == null ? [local(save, 'i32'), local(ret, resultType), localSet(save, heapGet())]
      : [local(save, 'i32'), local(esave, 'i32'), local(ret, resultType), localSet(save, heapGet()), localSet(esave, escGet()), escSet(i32c(0))]
    for (const n of entry) { insertAfter(f, at, n); at = n }
    rewound.add(name)
    if (esave != null) { flagged.add(name); report?.(name, 'kept on a call that runs an escape: ' + (conditional.get(name) ?? rec.tapeFlagWhy)) }
  }
  // The flag is read by the conditional frames rewound here and, through the
  // host, by the conditional exports it releases (`flagged`): every function
  // they can reach keeps its writes; elsewhere they go.
  const reached = new Set(), work = [...flagged]
  let viaTable = false
  while (work.length) {
    const n = work.pop()
    if (reached.has(n)) continue
    reached.add(n)
    const r = info.get(n)
    if (!r) continue
    for (const c of r.calls) work.push(c)
    if (r.indirect && !r.resolved && !viaTable) { viaTable = true; for (const t of table) work.push(t) }
  }
  const isRaise = (id) => id !== NONE && T.op[id] === GLOBAL_SET && text(T.a[id]) === '$__esc'
  // `(if test (then (global.set $__esc …)))`: an if whose only work is the raise.
  const raisesOnly = (id) => {
    let then = NONE, n = 0
    for (let c = T.a[id]; c !== NONE; c = T.next[c]) { n++; if (T.op[c] === THEN) then = c }
    return n === 2 && then !== NONE && isRaise(T.a[then]) && T.next[T.a[then]] === NONE
  }
  // The flag raised as the statement before the one that runs an escape: every
  // operand of a statement runs when it does, and each instruction keeps its
  // arity (a pass reading a `global.set`'s value takes its one operand).
  const SEQUENCE = new Set([FUNC, BLOCK, intern('loop'), THEN, ELSE, intern('try_table')])
  const raiseBefore = (f, up, id) => {
    let n = id, p = up.get(n)
    if (p === undefined) throw new Error(`arena rewind: an escape of ${text(T.a[f])} left its body`)
    while (p !== NONE && !SEQUENCE.has(T.op[p])) { n = p; p = up.get(n) }
    const seq = p === NONE ? f : p
    let prev = NONE
    for (let c = T.a[seq]; c !== n; c = T.next[c]) prev = c
    insertAfter(seq, prev, escSet(i32c(1)))
  }
  for (let f = T.a[root]; f !== NONE; f = T.next[f]) {
    if (T.op[f] !== FUNC) continue
    const name = text(T.a[f]), rec = name === null ? null : info.get(name)
    if (!reached.has(name)) {
      walk(f, (id, parent) => {
        if (parent === NONE) return
        // A guarded raise (emit/dispatch.js: `(if (receiver is no typed array)
        // (then raise))`) goes whole, its test with it, unless the test sets a
        // local later code reads (the type test optimize/cse-address.js shares
        // with the receiver's other reads): that test stays, dropped.
        if (T.op[id] === IF && raisesOnly(id)) {
          const test = T.op[T.a[id]] === THEN ? T.next[T.a[id]] : T.a[id]
          let sets = false
          walk(test, (n) => { if (sets) return false; if (T.op[n] === LOCAL_SET || T.op[n] === LOCAL_TEE) sets = true })
          if (!sets) { remove(parent, id); return false }
          T.op[id] = DROP; T.a[id] = test; T.next[test] = NONE
          return false
        }
        if (T.op[id] === GLOBAL_SET && text(T.a[id]) === '$__esc') { remove(parent, id); return false }
      })
      continue
    }
    if (!rec) continue
    if (!rec.flagAt.length) continue
    const up = new Map()
    eachBody(f, (n, p) => { up.set(n, p) })
    for (const id of rec.flagAt) raiseBefore(f, up, id)
  }
  return { releasable, rewound, flagged, allocates: (name) => info.get(name)?.allocs ?? false, why: (name) => info.get(name)?.why ?? null }
}
