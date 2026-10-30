/**
 * Arena rewind on the tape: a function that allocates only for its own
 * result restores the heap pointer before it returns, so a call leaves no
 * garbage. A function qualifies when its record allows it (one scalar result
 * that is not a pointer: `rewindable` maps its name to the result type) and
 * no value it allocated outlives its frame.
 *
 * Whether one does is, for most frames, known only as the call runs. The
 * escape flag `$__esc` holds the lowest address an escape wrote into since it
 * was cleared: all ones while none ran, zero after an escape with no address
 * (a module binding, a host that may keep what it is handed, a module-wide
 * table). Every escape lowers it where it runs: the sites of the frame census
 * (compile/analyze/frame-effects.js, emitted by emit/dispatch.js), and here
 * what the tape finds at one instruction: a write of a global that is no
 * scratch, a call handing a host import a value, a `call_ref`, and in a
 * runtime kernel a store through an address a global reaches (a kernel filing
 * a value into a module-wide table). A frame that may reach such code
 * (`tapeFlag`, a fixpoint over the call graph) saves the flag at entry and
 * clears it, and at return restores the heap when the flag stands at or
 * above the frame's own mark: every write went into memory the frame made,
 * which goes with it. The lower of the flag and the saved one then stands
 * for the caller, whose mark is lower still. A frame that reaches none
 * restores outright. The first such frame on the stack leaves its mark in
 * `$__base` while it runs: a stored value below it was made before every
 * frame that reads the flag, and its store lowers nothing (module/core.js
 * `__esc_new`).
 *
 * So a call is no escape in itself: a `call` runs its callee, a
 * `call_indirect` a function the table holds (in a function whose closure
 * calls the census resolved, the closures those calls may run,
 * `closureTargets`, and whatever the table holds besides closures), and what
 * they run lowers the flag. Only a table holding a function the module does
 * not define flags the indirect call itself.
 *
 * Three verdicts are known before the call. `unsafe`: every call escapes
 * with no address (the census's `arenaUnsafe`, or here an escape every call
 * runs: no `if` arm holds it, and nothing before it leaves by a return or by
 * a branch to a label around both; a loop branching to its own head leaves
 * nothing), so the frame never restores, nor does a caller's that calls it
 * on every call. `keeps`: every call writes into storage older than the
 * frame, which never restores; a caller's may.
 * `entry`: the frame has an escape at no instruction (a site the emitter did
 * not flag, a body the census never walked); the flag goes to zero as the
 * frame is entered. A tail call out of the frame leaves before the epilogue:
 * the frame is not rewound.
 *
 * The protocol is paid where it may free something: by a frame with a reason
 * of its own (`conditional`: a census site, or a flag lowered in censused
 * code it reaches) and by every exported frame, the one a host calls block
 * after block; an inner frame only a runtime kernel's rare path flags keeps
 * its heap until the frame around it returns. The flag has two readers: a
 * frame rewritten here to restore by it, and the host, for a function whose
 * calls it releases (`exportInner`). Its writes in functions no reader
 * reaches are dropped, and with them, where the module has no reader, the
 * flag itself.
 *
 * The rewrite saves the heap pointer into a local at entry and, at every
 * `return` and at the fall-through, moves the result into a local, restores
 * the pointer and yields the local. `return` is stack-polymorphic, so the
 * value is what gets wrapped, never the return itself.
 *
 * The same proof, allocating or not, is what lets the host release a call's
 * argument copies after it (interop.js, the `jz:release` section): a frame
 * that keeps nothing it made keeps none of what it was handed either, since
 * the census counts a parameter as outer storage and every store of one as
 * an escape. The pass returns those functions; `rewrite: false` (optimize
 * levels without the rewind) proves them without rewriting any.
 *
 * Each sweep over the module's functions is a phase where the compiler
 * hosting the compile asks for one (`phase`, scripts/self.js
 * checkpointPhase): what a sweep made and left unreached goes before the
 * next runs. On the compiler's own module the pass allocates gigabytes
 * (6.9 GB under V8), more than a wasm32 heap holds; its records and the
 * tape are what outlive a sweep.
 *
 * @module optimize/arena-rewind
 */
import { T, NONE, OP_NUM, intern, text, walk, node, str, num, push, insertAfter, remove, fromWat } from '../ir/tape.js'
import { T as MARK } from '../ast.js'

// JZ_DEBUG_POISON=1: a rewound frame overwrites what it frees, so a pointer
// kept into it reads all ones where it would read what the freed block held
// until the next allocation took its place. A check of the proof, off in use.
const DBG_POISON = typeof process !== 'undefined' && process.env?.JZ_DEBUG_POISON === '1'
// JZ_DEBUG_ESC=1: the lowerings this pass inserts tell the host which one ran
// (`env.__esc_note(id)`, as the emitter's sites do, emit/dispatch.js), the ids
// from 100000 on listed on stderr.
const DBG_ESC = typeof process !== 'undefined' && process.env?.JZ_DEBUG_ESC === '1'
let escNotes = 100000

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
// miss, which strands nothing. The count a collection's ordering leaves for
// its caller (`__coll_order_n`, module/core.js) is a number read at once.
// Scratch of one call of the runtime, set anew before it is read: the JSON
// writer's buffer, position and depth and the parser's input and cursor
// (module/json.js: `__stringify` and `__jp` start each from their own), the
// argument array a call publishes for its callee's rest parameter
// (`__closure_spill`, module/function.js). Numbers the runtime keeps: the
// random generator's state, a regex's last index and its groups' bounds.
const HEAP_GLOBALS = new Set(['$__heap', '$__heap_end', '$__heap_end64', '$__heap_start', '$__heap_reset', '$__jz_last_err_bits', '$__seq',
  '$__ic_found_slot', '$__ic_found_hi', '$__dyn_get_cache_off', '$__dyn_get_cache_props', '$__enumc_epoch', '$__coll_order_n', '$__esc', '$__base', '$__esc_low',
  '$__jbuf', '$__jstack', '$__jpos', '$__jcap', '$__jgap', '$__jgaplen', '$__jdepth', '$__jsp', '$__jpstr', '$__jplen', '$__jppos', '$__jp_err',
  '$__closure_spill', '$math.rng_state', '$math.rng_seeded',
  '$__roots', '$__rootn', '$__rootl', '$__r_mark', '$__r_top', '$__r_bits', '$__r_sp', '$__r_lim', '$__r_end', '$__ibase', '$__gc_epoch',
  // the reset's log of an object (module/core/durable-log.js `__durable_obj_snap`), which lowers the flag itself
  '$__durable_arr_seen', '$__durable_arr_log',
  // the park lane's cursors (module/core.js): scratch above the heap a phase checkpoint writes and reads back at once
  '$__park_base', '$__park_cursor', '$__park_read'])
const IC_SITE = /^\$__ic_(hi|slot)\d+$/, REGEX_STATE = /^\$__re_(lastIndex_\d+|g\d+_(start|end))$/
// The compaction's own state and the host's pin (module/core/compact.js): no value of the program's.
const GC_STATE = /^\$__(g_\w+|pin|gc_tbl|stubs|stubn)$/
// The for-in enumeration caches (module/object.js, core.js `__hash_keys_ro`):
// every read of one asks the epoch first, and a frame that filled one moves
// the epoch as it restores (`bump`), as `__clear` and a phase's rewind do.
const ENUMC = /^\$__enumc_(off|len|ep|arr)\d*$/
const heapScratch = (name) => HEAP_GLOBALS.has(name) || IC_SITE.test(name) || REGEX_STATE.test(name) || ENUMC.test(name) || GC_STATE.test(name)
const NO_NAMES = new Set()
// The durable-heap log (module/core/durable-log.js) allocates its buffers and
// records entries only when a durable (pre-init) array or slot is grown,
// mutated in place, or handed an ephemeral heap value: a store the census
// counts (compile/analyze/frame-effects.js), whose site lowers the flag to
// the durable receiver, older than every frame, before a value that may hold
// a heap pointer goes in, or after the store when it allocated, as the log's
// first touch does. No frame restores over a logging path. An object's
// snapshot lowers the flag itself where it allocates (module/core/
// durable-log.js): a kernel's arm calls it for a store no site stands at.
const CENSUS_GUARDED = /^\$__durable_(?!(obj|cell)_snap$)/
// A captured cell's record (module/core/durable-log.js `__durable_cell_snap`)
// lowers the flag where it allocates, and what it allocates is the round's,
// not the frame's: a call of it reaches a lowering, as any field record's
// does, and allocates nothing of its caller's.
const ROUND_ALLOCS = new Set(['$__durable_cell_snap'])
// The runtime's own lowering of the flag (module/core.js), and the tag of the
// local a growth site keeps the heap's top in (emit/dispatch.js, same tag).
// A kernel whose store through a global lends a value for a time the runtime
// ends itself: the JSON writer's stack of open containers (module/json.js),
// pushed by `__json_enter` and popped by `__json_leave` within one call.
const LENDS = new Set(['$__json_enter'])
const LOWERS = new Set(['$__esc_at', '$__esc_val', '$__esc_elem', '$__esc_cell', '$__esc_root'])
// The log of what the escapes wrote into and the walk from it as a frame
// returns (module/core/reach.js): kernels of the protocol itself, whose
// stores go into the log and into scratch above the heap.
const REACH = /^\$__(root|root_reset|survive|reach_\w+|gc_\w+|compact|iter_release)$/
const SURVIVE = '$__survive', ROOTN = '$__rootn', ROOTS = '$__roots', ROOT_RESET = '$__root_reset'
// The lowest the flag stood at since the outermost reading frame was entered:
// a handler's flag (compile/emit/statements.js).
const ESC_LOW = '$__esc_low'
// The local a released loop keeps the lowest flag it took over in (emit/control-flow.js iterationRelease).
const ESC_HELD = '$' + MARK + 'ies'
// Below it a receiver is logged too while a loop releases its iterations (module/core/reach.js `__iter_release`).
const IBASE = '$__ibase'
// What asks of a stored value whether a running call made it: no lowering itself.
const ASKS = '$__esc_new'
/** A phase checkpoint's read of the flag (module/core.js, scripts/self.js checkpointPhase): the frame that calls it is a reader. */
const PARK_SAFE = '$__park_safe'
/** A loop's release of an iteration (module/core/reach.js, emit/control-flow.js iterationRelease): its frame reads the flag too. */
const ITER_RELEASE = '$__iter_release'
/** The checkpoint's other helpers before its verdict, and the heap's marks: they read and set the protocol's globals, no escape. */
const PARK_CALLS = /^\$__(park_(mark|enter|low_enter|base_enter|worth|end)|durable_state|heap_since|heap_mark|heap_large|esc_get)$/
// What asks of a frame's result whether the frame made it (module/core.js).
const MADE = '$__made'
// The protocol's cold paths, out of line: a conditional frame's release and the outermost frame's entry.
const GIVE = '$__frame_give', OUTER = '$__frame_outer'
const ESC_MARK = 'esch'
// jz's interop imports that hand the host nothing it could keep: they read.
const EXT_READS = new Set(['$__ext_prop', '$__ext_get', '$__ext_method', '$__ext_has', '$__ext_has_iterator', '$__ext_enum', '$__ext_json', '$__ext_json_omits'])

/** @param rewindable  Map `$name` → result type of the functions whose records allow a rewind,
 *                    a list of types where the function has several results
 *  @param asked       Set of `$name`: those of them whose result may be a heap value
 *  @param unsafe      Set of `$name`: functions every call of which escapes with no address
 *  @param keeps       Map `$name` → reason: functions whose own frame never restores, a caller's may
 *  @param entry       Set of `$name`: functions with an escape at no instruction: the flag goes to zero at entry
 *  @param exported    Set of `$name`: the functions a host calls
 *  @param exportInner Map export name → `$name`: the functions whose calls the host releases
 *                    (link/sections.js `jz:release`), reading the flag of a conditional one
 *  @param heapAddr    the heap pointer's memory address under shared memory, null when it is the `$__heap` global
 *  @param report      optional (name, reason) => void: why a candidate in `rewindable` was not rewound
 *  @param rewrite     false: prove the functions without rewriting them (the returned set only)
 *  @param scalarGlobals Set of `$name`: module bindings that never hold a heap value
 *  @param closureTargets Map `$name` → Set of `$closure`: the closures a function's resolved calls may run
 *  @param closureNames Set of `$name`: every closure body the module emitted
 *  @param conditional Map `$name` → reason: functions the census found to run code lowering the flag
 *  @param censused   Set of `$name`: the functions and closures the frame census walked; a
 *                    write there to a module binding (`userGlobals`) is the census's to judge:
 *                    a heap value it flagged as a site, anything else keeps nothing fresh
 *  @param keepsNothing Set of `$name`: runtime imports that keep nothing they are handed
 *  @param optimize   the resolved optimize config: `rewindGuard: false` (the size tier) leaves out the comparison before a release
 *  @returns `releasable` (the rewindable functions whose frames keep nothing, allocating or
 *    not), `rewound` (those rewritten), and per function whether it allocates and why not */
export function arenaRewind(root, { rewindable, numberResult = NO_NAMES, asked = NO_NAMES, heapAddr, unsafe = NO_NAMES, keeps = NO_NAMES, entry = NO_NAMES, exported = NO_NAMES, exportInner = null, report = null, rewrite = true, scalarGlobals = NO_NAMES, closureTargets = null, closureNames = NO_NAMES, conditional = NO_NAMES, censused = NO_NAMES, userGlobals = NO_NAMES, keepsNothing = NO_NAMES, optimize = null, phase = run => run() }) {
  const releasable = new Set(), rewound = new Set(), flagged = new Set()
  // The conditional functions whose flag something reads: the frames rewound
  // here, and those the host releases by it.
  const readers = new Set(), hosted = new Set(exportInner?.values())
  // A write the rewind cannot strand: the heap's own globals and caches, and a
  // module binding that never holds a heap value (a counter, a clock).
  const strandsNothing = (name) => heapScratch(name) || scalarGlobals.has(name)
  const FUNC = intern('func'), CALL = intern('call'), RETURN = intern('return'), RETURN_CALL = intern('return_call'), IMPORT = intern('import'), GLOBAL = intern('global'), MUT = intern('mut')
  const GLOBAL_SET = intern('global.set'), GLOBAL_GET = intern('global.get'), CALL_INDIRECT = intern('call_indirect'), CALL_REF = intern('call_ref')
  // Whether a handler of the module takes the lowest flag for its own: the frames hand theirs over then.
  let folds = false
  // A tail call is a call: what its callee runs reaches whoever called the
  // function, as what the function runs itself does.
  const RETURN_CALL_INDIRECT = intern('return_call_indirect'), RETURN_CALL_REF = intern('return_call_ref')
  const TAILS = new Set([RETURN_CALL, RETURN_CALL_INDIRECT, RETURN_CALL_REF])
  const callsDirect = (op) => op === CALL || op === RETURN_CALL
  const callsTable = (op) => op === CALL_INDIRECT || op === RETURN_CALL_INDIRECT
  const callsRef = (op) => op === CALL_REF || op === RETURN_CALL_REF
  const LOCAL = intern('local'), LOCAL_SET = intern('local.set'), LOCAL_GET = intern('local.get'), LOCAL_TEE = intern('local.tee'), BLOCK = intern('block'), RESULT = intern('result'), DROP = intern('drop')
  const UNREACHABLE = intern('unreachable')
  // `(call $f)` followed by `unreachable`, bare or dropped, or a runtime throw helper.
  const neverReturns = (callee, id) => {
    if (callee.startsWith('$__throw')) return true
    const n = T.next[id]
    if (n === NONE) return false
    return T.op[n] === UNREACHABLE || (T.op[n] === DROP && T.a[n] !== NONE && T.op[T.a[n]] === UNREACHABLE)
  }
  const IF = intern('if'), THEN = intern('then'), ELSE = intern('else')
  const SEQUENCE = new Set([FUNC, BLOCK, intern('loop'), THEN, ELSE, intern('try_table')])
  const decl = new Set(DECLS.map(intern))
  // The header: declarations, and the comment atoms a template carries between them.
  const isHeader = (c) => T.op[c] < 0 || decl.has(T.op[c])
  const bodyStart = (f) => { let c = T.next[T.a[f]]; while (c !== NONE && isHeader(c)) c = T.next[c]; return c }
  const eachBody = (f, fn) => { for (let c = bodyStart(f); c !== NONE; c = T.next[c]) walk(c, fn) }
  const opText = (id) => T.syms[T.op[id]]
  // A write of the flag that lowers nothing: the flag cleared, or put back to the
  // lowest a released loop took over from it (emit/control-flow.js iterationRelease),
  // no lower than the loop's own escapes, flagged where they run, made it.
  const allOnes = (v) => v !== NONE && opText(v) === 'i32.const' && T.a[v] !== NONE && T.op[T.a[v]] === OP_NUM && T.imm[T.a[v]] === -1
  const heldGet = (v) => v !== NONE && opText(v) === 'local.get' && text(T.a[v])?.startsWith(ESC_HELD) === true
  const clearsFlag = (id) => {
    const v = T.next[T.a[id]]
    if (v === NONE) return false
    if (allOnes(v)) return true
    // the loop keeps the lowest as its complement: `(i32.xor (local.get $ies…) (i32.const -1))`
    if (opText(v) !== 'i32.xor') return false
    const a = T.a[v], b = a === NONE ? NONE : T.next[a]
    return (heldGet(a) && allOnes(b)) || (allOnes(a) && heldGet(b))
  }

  // Imports: callees the module declares but does not define. Immutable
  // globals: pooled constants, values rather than tables.
  const imports = new Set(), constants = new Set(HEAP_GLOBALS), table = new Set(), globals = new Set()
  const ELEM = intern('elem')
  for (let c = T.a[root]; c !== NONE; c = T.next[c]) {
    if (T.op[c] === ELEM) { for (let d = T.a[c]; d !== NONE; d = T.next[d]) { const n = text(d); if (n !== null && n.startsWith('$')) table.add(n) } }
    if (T.op[c] === IMPORT) { for (let d = T.a[c]; d !== NONE; d = T.next[d]) if (T.op[d] === FUNC) { const n = text(T.a[d]); if (n !== null) imports.add(n) } }
    else if (T.op[c] === GLOBAL) { let mut = false; for (let d = T.a[c]; d !== NONE; d = T.next[d]) if (T.op[d] === MUT) mut = true; const n = text(T.a[c]); if (n !== null) { globals.add(n); if (!mut) constants.add(n) } }
  }

  // A store: any instruction that writes memory or a table.
  const isStore = (id) => { const s = opText(id); return s != null && (/\.store(8|16|32|64)?(_lane)?$/.test(s) || /\.atomic\.rmw/.test(s) || s === 'memory.copy' || s === 'memory.fill' || s === 'memory.init' || (s.startsWith('table.') && s !== 'table.get' && s !== 'table.size')) }
  // Whether an expression's value may derive from a module-wide table: a
  // global other than the heap pointers, a local such a value reached, or
  // the result of a callee whose returned value may (`tableResults`, below).
  // What the allocator returns is fresh whatever sized it (a count read off a
  // table is no address in one).
  const ALLOCATES = new Set(['$__alloc', '$__alloc_hdr', '$__alloc_hdr_n'])
  // Growth returns its receiver or fresh storage; its capacity is no address.
  const GROWS = new Set(['$__arr_grow', '$__arr_grow_known'])
  // The JSON writer's output buffer and cycle stack: allocated afresh by the
  // call that writes them (module/json.js `__stringify`), so a store into
  // them is a store into the call's own memory, and nothing reads them after
  // the call. A global that names scratch of one call derives no table.
  const CALL_SCRATCH = new Set(['$__jbuf', '$__jstack'])
  const reaches = (id, tainted) => {
    if (id === NONE) return true   // an operand left on the stack (flat WAT): unknown, so tainted
    let hit = false
    walk(id, (n) => {
      if (hit) return false
      const s = opText(n)
      if (s === 'global.get') { if (!constants.has(text(T.a[n])) && !CALL_SCRATCH.has(text(T.a[n]))) hit = true }
      else if (s === 'local.get') { if (tainted.has(text(T.a[n]))) hit = true }
      else if (s === 'call') {
        const c = text(T.a[n])
        if (ALLOCATES.has(c)) return false
        if (GROWS.has(c)) { hit = reaches(T.next[T.a[n]], tainted); return false }
        if (!ARENA_SAFE.includes(c) && (!defined.has(c) || tableResults.has(c))) hit = true
      }
      else if (s === 'call_indirect' || s === 'call_ref') hit = true
    })
    return hit
  }
  // Whether an address lies in a module-wide table: its base derives from
  // one. An offset added to a base is no base: a constant, a scaled index (a
  // slot number read off a schema table addresses the receiver it indexes).
  // Two plain operands do not say which is the base: either may be.
  const SCALES = new Set(['i32.shl', 'i32.mul', 'i32.const'])
  const inTable = (id, tainted) => {
    if (id === NONE) return true
    const s = opText(id)
    if (s === 'local.tee') return inTable(T.next[T.a[id]], tainted)
    if (s === 'i32.add' || s === 'i32.sub') {
      const a = T.a[id], b = a === NONE ? NONE : T.next[a]
      if (a === NONE || b === NONE) return true
      if (s === 'i32.sub' || SCALES.has(opText(b))) return inTable(a, tainted)
      if (SCALES.has(opText(a))) return inTable(b, tainted)
      return inTable(a, tainted) || inTable(b, tainted)
    }
    return reaches(id, tainted)
  }
  // The locals a table-derived value reaches, to a fixpoint over the body.
  const taintedLocals = (f) => {
    const tainted = new Set()
    for (let changed = true; changed;) {
      changed = false
      eachBody(f, (id) => {
        const s = opText(id)
        if ((s === 'local.set' || s === 'local.tee') && !tainted.has(text(T.a[id])) && inTable(T.next[T.a[id]], tainted)) { tainted.add(text(T.a[id])); changed = true }
      })
    }
    return tainted
  }
  // Functions whose returned value may derive from a table: a `return`
  // operand or the fall-through value reaches one. A function the module
  // does not define (an import) may return anything. A fixpoint over the
  // module, since a callee's result feeds its caller's locals: a function is
  // asked again only when a callee it calls joins the set (the set only
  // grows, so the order of the asking does not change the fixpoint).
  const defined = new Set(), tableResults = new Set(), returnsOf = new Map(), callersOf = new Map()
  phase(() => { for (let f = T.a[root]; f !== NONE; f = T.next[f]) {
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
    eachBody(f, (id) => {
      if (T.op[id] === RETURN && T.a[id] !== NONE) values.push(T.a[id])
      else if (T.op[id] === CALL) {
        const callee = text(T.a[id])
        if (callee === null) return
        const callers = callersOf.get(callee)
        if (!callers) callersOf.set(callee, [name])
        else if (callers[callers.length - 1] !== name) callers.push(name)
      }
    })
    returnsOf.set(name, { f, values })
  }
  const queue = [...returnsOf.keys()], queued = new Set(queue)
  for (let i = 0; i < queue.length; i++) {
    const name = queue[i], { f, values } = returnsOf.get(name)
    queued.delete(name)
    const tainted = taintedLocals(f)
    if (!values.some(v => reaches(v, tainted))) continue
    tableResults.add(name)
    for (const caller of callersOf.get(name) ?? []) if (!tableResults.has(caller) && !queued.has(caller)) { queued.add(caller); queue.push(caller) }
  } })
  // Whether every value `f` returns is storage it allocated: an allocator's
  // address boxed, growth of such storage (its receiver or fresh storage), or
  // a local every assignment of which is one. A local's assignments are
  // assumed made while they are being proven (a loop carrying the value).
  const resultMade = (f) => {
    const defs = new Map()
    eachBody(f, (id) => {
      const s = opText(id)
      if (s === 'local.set' || s === 'local.tee') { const n = text(T.a[id]); (defs.get(n) ?? defs.set(n, []).get(n)).push(T.next[T.a[id]]) }
    })
    const proving = new Set()
    const lastOf = (id) => { let l = NONE; for (let c = T.a[id]; c !== NONE; c = T.next[c]) if (T.op[c] >= 0 && T.op[c] !== RESULT) l = c; return l }
    const made = (id) => {
      if (id === NONE) return false
      const s = opText(id), a = T.a[id]
      if (s === 'call') {
        const c = text(a), args = T.next[a]
        if (ALLOCATES.has(c)) return true
        if (c === '$__mkptr') { let x = args; for (let i = 0; i < 2 && x !== NONE; i++) x = T.next[x]; return made(x) }
        return GROWS.has(c) && made(args)
      }
      if (s === 'local.get') {
        const n = text(a), ds = defs.get(n)
        if (!ds) return false
        if (proving.has(n)) return true
        proving.add(n)
        const all = ds.every(made)
        proving.delete(n)
        return all
      }
      if (s === 'local.tee') return made(T.next[a])
      if (s === 'block') return made(lastOf(id))
      if (s === 'if') {
        let arms = 0
        for (let c = a; c !== NONE; c = T.next[c]) if (T.op[c] === THEN || T.op[c] === ELSE) { if (!made(lastOf(c))) return false; arms++ }
        return arms === 2
      }
      if (s === 'select') return made(a) && made(T.next[a])
      return false
    }
    let last = NONE
    for (let c = T.a[f]; c !== NONE; c = T.next[c]) if (T.op[c] >= 0 && !isHeader(c)) last = c
    const values = []
    if (last !== NONE && T.op[last] !== RETURN) values.push(last)
    eachBody(f, (id) => { if (T.op[id] === RETURN) values.push(T.a[id]) })
    return values.length > 0 && values.every(made)
  }

  // The stores of a runtime kernel through an address a global reaches: it
  // files a value into a module-wide table (a property cache, a pool), where
  // it outlives every frame. Stores through parameters are the caller's
  // business (the census counts the operation that called the kernel);
  // stores into its own allocations are fresh memory.
  const storesOutside = (f) => {
    const tainted = taintedLocals(f), stores = []
    eachBody(f, (id) => {
      if (!isStore(id)) return
      const s = opText(id)
      // the address is the first operand that is an instruction (a memarg is an atom)
      let addr = T.a[id]
      while (addr !== NONE && T.op[addr] < 0) addr = T.next[addr]
      if (s.startsWith('table.') || addr === NONE || inTable(addr, tainted)) stores.push(id)
    })
    return stores
  }

  // Effects per named function, then the fixpoints over the call graph.
  const info = new Map()
  const vetoRec = (rec, why) => { rec.tapeUnsafe = true; rec.tapeWhy ??= why; if (!rec.unsafe) { rec.unsafe = true; rec.why = why } }
  // An instruction that may leave the sequence it stands in: what follows may
  // not run. One that leaves the function does; a branch does where its label
  // stands outside the instruction (a loop branching to its own head stays).
  const EXITS = new Set(['return', 'return_call', 'return_call_indirect', 'throw', 'throw_ref', 'rethrow', 'unreachable'].map(intern))
  const BRANCHES = new Set(['br', 'br_if', 'br_table', 'br_on_null', 'br_on_non_null', 'br_on_cast', 'br_on_cast_fail', 'catch', 'catch_ref', 'catch_all', 'catch_all_ref'].map(intern))
  const TAGGED = new Set(['catch', 'catch_ref'].map(intern))
  const LABELED = new Set(['block', 'loop', 'if', 'try_table', 'try'].map(intern))
  const left = new Map()
  const leaves = (id) => {
    let hit = left.get(id)
    if (hit !== undefined) return hit
    const scope = []
    const out = (n) => {
      const op = T.op[n]
      if (op < 0) return false
      if (EXITS.has(op)) return true
      if (BRANCHES.has(op)) for (let c = TAGGED.has(op) ? T.next[T.a[n]] : T.a[n]; c !== NONE && T.op[c] < 0; c = T.next[c]) {
        const label = text(c), depth = label === null ? T.imm[c] : /^\d+$/.test(label) ? +label : -1
        if (depth < 0 ? !scope.includes(label) : depth >= scope.length) return true
      }
      const labeled = LABELED.has(op)
      if (labeled) scope.push(text(T.a[n]))
      let leaving = false
      for (let c = T.a[n]; c !== NONE && !leaving; c = T.next[c]) leaving = out(c)
      if (labeled) scope.pop()
      return leaving
    }
    hit = out(id)
    left.set(id, hit)
    return hit
  }
  // The parent of every node of a function asked about, filled once per
  // function into one column over the tape (-2 for a node of no function
  // asked about): a Map per function held most of the module's nodes for the
  // whole pass.
  let up = null
  // Whether an instruction of `rec`'s function may not run on a call: it sits
  // in an `if` arm, or past an instruction that may leave.
  const guarded = (rec, id) => {
    if (up === null) up = new Int32Array(T.n).fill(-2)
    if (!rec.up) { rec.up = true; eachBody(rec.f, (n, p) => { if (n < up.length) up[n] = p }) }
    for (let n = id; ;) {
      const p = n < up.length ? up[n] : -2
      if (p === -2) return false
      for (let c = p === NONE ? bodyStart(rec.f) : T.a[p]; c !== n && c !== NONE; c = T.next[c]) if (leaves(c)) return true
      if (p === NONE) return false
      if (T.op[p] === THEN || T.op[p] === ELSE) return true
      n = p
    }
  }
  // An escape at one instruction: the flag goes to zero there when it runs;
  // where every call runs it, no call of the function restores.
  const escapeAt = (rec, id, why) => {
    rec.flagAt.push(id); rec.flagWhy ??= why
    if (rec.censused) rec.ownFlag = true
    if (!guarded(rec, id)) vetoRec(rec, why)
  }
  phase(() => { for (let f = T.a[root]; f !== NONE; f = T.next[f]) {
    if (T.op[f] !== FUNC) continue
    const name = text(T.a[f])
    if (name === null) continue
    const verdict = unsafe.has(name)
    const rec = { unsafe: verdict, why: verdict ? 'escape' : null, keeps: keeps.has(name), entry: entry.has(name), tapeUnsafe: false, tapeWhy: null, calls: new Set(), every: new Map(),
      allocs: false, allocCalls: new Set(), indirect: false, refs: false, lowers: false, f, up: false, censused: censused.has(name), flagAt: [], flagWhy: null, indirectAt: [], ownFlag: false }
    eachBody(f, (id) => {
      const op = T.op[id]
      if (op === GLOBAL_GET && text(T.a[id]) === ESC_LOW) folds = true
      if (op === GLOBAL_SET) {
        const g = text(T.a[id])
        // the emitter's own lowering (a census site, a catch handler)
        if (g === '$__esc') { if (!clearsFlag(id)) { rec.lowers = true; if (rec.censused) rec.ownFlag = true } }
        else if (ENUMC.test(g)) rec.enumc = true
        else if (!strandsNothing(g) && !(censused.has(name) && userGlobals.has(g?.slice(1)))) escapeAt(rec, id, 'global.set ' + g)
      }
      else if (callsTable(op)) { rec.indirect = true; rec.indirectAt.push(id) }
      else if (callsRef(op)) { rec.refs = true; escapeAt(rec, id, opText(id)) }
      else if (callsDirect(op)) {
        const callee = text(T.a[id])
        if (callee === '$__alloc' || callee === '$__alloc_hdr' || callee === '$__alloc_hdr_n') rec.allocs = true
        if (LOWERS.has(callee)) { if (!LOWERS.has(name)) { rec.lowers = true; if (rec.censused) rec.ownFlag = true } return }
        if (callee !== null && REACH.test(callee)) return
        // the checkpoint's helpers write the flag: reached from their caller, a reader, so their writes stay
        if (callee === PARK_SAFE || callee === ITER_RELEASE || PARK_CALLS.test(callee)) { if (callee === PARK_SAFE || callee === ITER_RELEASE) rec.reader = true; rec.calls.add(callee); return }
        if (callee === null || callee === ASKS || callee === MADE || ARENA_SAFE.includes(callee) || CENSUS_GUARDED.test(callee)) return
        // jz's own interop imports (`$__ext_*`, interop.js) that read hand the
        // host nothing; one that calls the host or sets a property of its
        // object hands it values it may keep (a typed array is a view of the
        // module's memory, a closure its environment). The runtime's other
        // imports keep nothing but a callback they schedule (`keepsNothing`,
        // bridge.js hostImport). A user import that takes an argument may
        // keep whatever it is handed.
        if (imports.has(callee)) { if (T.next[T.a[id]] !== NONE && !EXT_READS.has(callee) && !keepsNothing.has(callee)) escapeAt(rec, id, 'calls ' + callee.slice(1) + ", the host's"); return }
        rec.calls.add(callee)
        // A call that never returns (a throw helper, or one the code marks
        // unreachable after) allocates only on a path that leaves the frame
        // by an exception: the epilogue a rewind adds never runs there. Its
        // escapes still reach whoever catches it (`calls`).
        if (!neverReturns(callee, id) && !ROUND_ALLOCS.has(callee)) rec.allocCalls.add(callee)
      }
    })
    if (name.startsWith('$__') && !CENSUS_GUARDED.test(name) && !LOWERS.has(name) && !LENDS.has(name) && !REACH.test(name)) for (const id of storesOutside(f)) escapeAt(rec, id, 'stores outside')
    info.set(name, rec)
  } })
  // A module with no heap pointer and no call of the allocator allocates
  // nothing: there is nothing to restore and no flag to read, and the checks
  // its sites carry go (a program whose objects all became scalars keeps the
  // sites the census found in its source).
  let heapless = heapAddr == null && !globals.has('$__heap')
  if (heapless) for (const rec of info.values()) if (rec.allocs) { heapless = false; break }
  // Whether `rec` calls `callee` on every call of its own: some call of it
  // stands behind no branch and no earlier return.
  const callsEvery = (rec, callee) => {
    let every = rec.every.get(callee)
    if (every === undefined) {
      every = false
      eachBody(rec.f, (id) => { if (every) return false; if (callsDirect(T.op[id]) && text(T.a[id]) === callee && !guarded(rec, id)) every = true })
      rec.every.set(callee, every)
    }
    return every
  }
  // An indirect call whose closures the census resolved calls them, and what
  // the table holds besides closures (a function held as a value, a method).
  // A table holding a function the module does not define hands a host what
  // the call passes: the call itself is flagged.
  const beyondClosures = [...table].filter(n => !closureNames.has(n))
  const foreign = [...table].find(n => !info.has(n))
  for (const [name, rec] of info) {
    if (!rec.indirect) continue
    const targets = closureTargets?.get(name)
    if (targets && [...beyondClosures, ...targets].every(t => info.has(t))) { rec.resolved = true; rec.targets = [...beyondClosures, ...targets] }
    else if (foreign !== undefined) for (const id of rec.indirectAt) escapeAt(rec, id, `call_indirect: ${foreign} is not defined here`)
  }
  // A function escapes on every call when it does itself or calls, on every
  // call, one that does: a fixpoint over the direct calls. The tape's own
  // verdicts are kept apart (`tapeUnsafe`), for a loop inside a function the
  // census ruled out.
  phase(() => { for (let changed = true; changed;) {
    changed = false
    for (const [, rec] of info) {
      if (rec.unsafe && rec.tapeUnsafe) continue
      for (const c of rec.calls) {
        const g = info.get(c)
        if (!g || !(g.unsafe || g.tapeUnsafe) || !callsEvery(rec, c)) continue
        if (g.unsafe && !rec.unsafe) { rec.unsafe = true; rec.why = 'calls ' + c + ': ' + g.why; changed = true }
        if (g.tapeUnsafe && !rec.tapeUnsafe) { rec.tapeUnsafe = true; rec.tapeWhy = 'calls ' + c + ': ' + g.tapeWhy; changed = true }
      }
    }
  } })
  // Code a function may reach lowers the flag: its own instructions, a callee's,
  // a closure's its resolved calls run, or any function's the table holds.
  // `ownFlag`: for a reason found in censused code.
  const reason = (rec) => rec.flagWhy ?? (rec.unsafe ? rec.why : null) ?? (rec.keeps ? keeps.get?.(text(T.a[rec.f])) : null) ?? 'an escape'
  for (const [, rec] of info) if (rec.lowers || rec.flagAt.length || rec.unsafe || rec.keeps || rec.entry) { rec.tapeFlag = true; rec.tapeFlagWhy = reason(rec) }
  phase(() => { for (let changed = true; changed;) {
    changed = false
    const tableFlag = [...table].find(n => info.get(n)?.tapeFlag), tableOwn = [...table].some(n => info.get(n)?.ownFlag)
    const tableEnumc = [...table].some(n => info.get(n)?.enumc)
    for (const [, rec] of info) {
      const viaTable = rec.indirect && !rec.resolved, reached = rec.resolved ? [...rec.calls, ...rec.targets] : [...rec.calls]
      if (!rec.ownFlag && (reached.some(c => info.get(c)?.ownFlag) || viaTable && tableOwn)) { rec.ownFlag = true; changed = true }
      // a frame that reaches a fill of an enumeration cache frees what the cache names as it restores: it moves the epoch too
      if (!rec.enumc && (reached.some(c => info.get(c)?.enumc) || viaTable && tableEnumc)) { rec.enumc = true; changed = true }
      if (rec.tapeFlag) continue
      let via = reached.find(c => info.get(c)?.tapeFlag)
      if (via === undefined && viaTable && tableFlag !== undefined) via = tableFlag
      if (via !== undefined) { rec.tapeFlag = true; rec.tapeFlagWhy = 'calls ' + via + ': ' + info.get(via).tapeFlagWhy; changed = true }
    }
  } })
  // Whether what `from` runs may run `name` again: by a call, a tail call, a
  // closure a resolved call runs, or the table. A search from every tail call's
  // callee over the whole call graph ran the compiler's own link a third of its
  // time (12k functions); the graph's strong components are taken once instead,
  // with each component's reach of a function whose reference escapes, which
  // may run anything. The callee of a tail call runs its caller again exactly
  // when the two share a component (the caller calls the callee) or the callee
  // reaches such a function; a callee its caller's census does not call (a
  // runtime helper the census leaves out) takes the search as written.
  // (the table is one node of the graph, its functions its edges: a function that may run any of
  // them reaches it, and every path through it is a path through one of them)
  const TABLE = '\0table'
  const edges = (n) => {
    if (n === TABLE) return [...table]
    const r = info.get(n)
    if (!r) return []
    const out = [...r.calls]
    if (r.refs || r.indirect && !r.resolved) out.push(TABLE)
    else if (r.indirect) out.push(...r.targets)
    return out
  }
  const comp = new Map(), reachesRefs = []   // function → component; component → may run a function whose reference escapes
  phase(() => {
    const index = new Map(), low = new Map(), onStack = new Set(), stack = []
    let next = 0
    const nodes = new Set([...info.keys(), ...table])
    for (const [, r] of info) { for (const c of r.calls) nodes.add(c); if (r.targets) for (const t of r.targets) nodes.add(t) }
    for (const start of nodes) {
      if (index.has(start)) continue
      // Tarjan's components, iteratively: the stack holds a frame per node with its edge list.
      const frames = [{ n: start, es: edges(start), i: 0 }]
      index.set(start, next); low.set(start, next); next++; stack.push(start); onStack.add(start)
      while (frames.length) {
        const fr = frames[frames.length - 1]
        if (fr.i < fr.es.length) {
          const m = fr.es[fr.i++]
          if (!index.has(m)) {
            index.set(m, next); low.set(m, next); next++; stack.push(m); onStack.add(m)
            frames.push({ n: m, es: edges(m), i: 0 })
          } else if (onStack.has(m)) low.set(fr.n, Math.min(low.get(fr.n), index.get(m)))
          continue
        }
        frames.pop()
        if (frames.length) { const up = frames[frames.length - 1].n; low.set(up, Math.min(low.get(up), low.get(fr.n))) }
        if (low.get(fr.n) !== index.get(fr.n)) continue
        // a component complete: every component it reaches is complete already
        const c = reachesRefs.length
        let refs = false
        const members = []
        for (;;) { const m = stack.pop(); onStack.delete(m); comp.set(m, c); members.push(m); if (m === fr.n) break }
        for (const m of members) {
          if (info.get(m)?.refs) refs = true
          for (const e of edges(m)) { const ce = comp.get(e); if (ce !== undefined && ce !== c && reachesRefs[ce]) refs = true }
        }
        reachesRefs.push(refs)
      }
    }
  })
  const searchesAgain = (from, name) => {
    const seen = new Set(), work = [from]
    while (work.length) {
      const n = work.pop()
      if (n === name) return true
      if (seen.has(n)) continue
      seen.add(n)
      const r = info.get(n)
      if (!r) continue
      for (const c of r.calls) work.push(c)
      if (r.refs || r.indirect && !r.resolved) { if (r.refs || table.has(name)) return true; for (const t of table) work.push(t) }
      else if (r.indirect) for (const t of r.targets) work.push(t)
    }
    return false
  }
  const runsAgain = (from, name) => {
    if (from === name) return true
    if (!info.get(name)?.calls.has(from)) return searchesAgain(from, name)
    const cf = comp.get(from)
    return cf !== undefined && (reachesRefs[cf] || cf === comp.get(name))
  }
  // Allocation is transitive: a string concatenation allocates inside its
  // kernel, and an indirect call allocates when a function the table holds does.
  phase(() => { for (let changed = true; changed;) {
    changed = false
    const tableAllocs = [...table].some(n => info.get(n)?.allocs)
    for (const [, rec] of info) {
      if (rec.allocs) continue
      if (rec.indirect && !rec.resolved && tableAllocs) { rec.allocs = true; changed = true; continue }
      for (const c of rec.resolved ? [...rec.allocCalls, ...rec.targets] : rec.allocCalls) if (info.get(c)?.allocs) { rec.allocs = true; changed = true; break }
    }
  } })

  // Per-iteration rewinds (emit/control-flow.js): a `local.set $<mark>lrwN` before a
  // loop and a restore through that local at the top of its body. Kept where the
  // function's own body and callees are tape-safe and the loop allocates, dropped
  // otherwise; the census that placed them proved the iteration's escapes.
  const isMarker = (id) => { const n = text(T.a[id]); return n !== null && n.startsWith('$' + MARK + 'lrw') }
  // A loop's own tape: what its body does and calls decides its rewind, where
  // the function around it may escape elsewhere (a dispatch through a table
  // before the loop) without touching what the iterations free. An iteration
  // restores outright: nothing it runs may lower the flag.
  const tableFlags = foreign !== undefined || [...table].some(t => info.get(t)?.tapeFlag)
  const tapeUnsafeIn = (rec, id) => {
    let why = null
    walk(id, (n) => {
      if (why !== null) return false
      const op = T.op[n]
      if (op === GLOBAL_SET) { const g = text(T.a[n]); if (g === '$__esc') { if (!clearsFlag(n)) why = 'lowers the flag' } else if (!strandsNothing(g)) why = 'global.set ' + g }
      else if (callsRef(op)) why = opText(n)
      else if (callsTable(op)) { if (rec.resolved ? rec.targets.some(t => info.get(t).tapeFlag) : tableFlags) why = opText(n) }
      else if (callsDirect(op)) {
        const callee = text(T.a[n])
        if (LOWERS.has(callee)) { why = 'lowers the flag'; return }
        if (callee === null || callee === ASKS || callee === MADE || callee === '$__alloc' || callee === '$__alloc_hdr' || callee === '$__alloc_hdr_n' || ARENA_SAFE.includes(callee) || CENSUS_GUARDED.test(callee)) return
        if (imports.has(callee)) { if (T.next[T.a[n]] !== NONE && !EXT_READS.has(callee) && !keepsNothing.has(callee)) why = 'calls ' + callee.slice(1) + ", the host's"; return }
        const g = info.get(callee)
        if (g === undefined) why = 'calls ' + callee + ' (undefined)'
        else if (g.tapeUnsafe) why = 'calls ' + callee + ': ' + g.tapeWhy
        else if (g.tapeFlag) why = 'calls ' + callee + ': ' + g.tapeFlagWhy
      }
    })
    return why
  }
  const poisoned = []
  // A dictionary literal reuses the table its binding held (module/object.js
  // `__hash_reuse_eph`): in a loop, the one the iteration before made, which a
  // restore frees. The locals such a call reads, each with its type, to start
  // every iteration empty; null where one is no plain local of a number type.
  const REUSES = '$__hash_reuse_eph'
  const carriedIn = (id, types) => {
    const out = new Map()
    let plain = true
    walk(id, (n) => {
      if (!plain) return false
      if (T.op[n] !== CALL || text(T.a[n]) !== REUSES) return
      let got = null, many = false
      walk(T.next[T.a[n]], (m) => { const s = opText(m); if (s === 'local.get') { if (got !== null) many = true; got = text(T.a[m]) } else if (s === 'call' || s === 'global.get' || s?.endsWith('.load')) many = true })
      const ty = got === null ? null : types.get(got)
      if (many || got === null || !(ty === 'f64' || ty === 'i64' || ty === 'i32')) plain = false
      else out.set(got, ty)
    })
    return plain ? out : null
  }
  const allocatesIn = (id) => { let hit = false; walk(id, (n) => { if (hit) return false; if (T.op[n] === CALL) { const c = text(T.a[n]); if (c === '$__alloc' || c === '$__alloc_hdr' || c === '$__alloc_hdr_n' || info.get(c)?.allocs) hit = true } }); return hit }
  phase(() => { if (rewrite) for (let f = T.a[root]; f !== NONE; f = T.next[f]) {
    if (T.op[f] !== FUNC) continue
    const name = text(T.a[f])
    const rec = name === null ? null : info.get(name)
    const saves = [], restores = []
    eachBody(f, (id) => {
      const s = opText(id)
      if (s === 'local.set' && isMarker(id)) saves.push(id)
      else if ((s === 'global.set' || s === 'i32.store') && T.a[id] !== NONE) { const v = T.next[T.a[id]]; if (v !== NONE && opText(v) === 'local.get' && isMarker(v)) restores.push(id) }
    })
    if (!saves.length && !restores.length) continue
    // the parent of every node, for a function with a loop to rewind only
    const parents = new Map()
    eachBody(f, (id) => { for (let c = T.a[id]; c !== NONE; c = T.next[c]) parents.set(c, id) })
    const types = new Map()
    for (let c = T.next[T.a[f]]; c !== NONE && isHeader(c); c = T.next[c]) if (T.op[c] === LOCAL || T.op[c] === intern('param')) { const n = text(T.a[c]); if (n !== null && n.startsWith('$')) types.set(n, text(T.next[T.a[c]])) }
    const bodyChildren = new Set()
    for (let c = bodyStart(f); c !== NONE; c = T.next[c]) bodyChildren.add(c)
    const drop = (id) => { const p = parents.get(id); if (p !== undefined) remove(p, id); else if (bodyChildren.has(id)) remove(f, id) }
    const keepLocals = new Set()
    for (const r of restores) {
      let loopNode = parents.get(r)
      while (loopNode !== undefined && opText(loopNode) !== 'loop') loopNode = parents.get(loopNode)
      const tape = rec == null || loopNode === undefined ? null : tapeUnsafeIn(rec, loopNode)
      const carried = rec != null && loopNode !== undefined && tape === null ? carriedIn(loopNode, types) : null
      const keep = rec != null && loopNode !== undefined && tape === null && carried !== null && allocatesIn(loopNode)
      if (keep) {
        const mark = text(T.a[T.next[T.a[r]]])
        keepLocals.add(mark)
        // a table the iteration before left in a local is freed with it: the local starts empty
        let at = r
        for (const [name, ty] of carried) { const z = node(intern(ty + '.const')); push(z, num(0)); const set = node(LOCAL_SET); push(set, str(name)); push(set, z); insertAfter(parents.get(r) ?? f, at, set); at = set }
        if (DBG_POISON) poisoned.push([r, parents.get(r) ?? f, mark])
      }
      else { drop(r); report?.(name, 'loop: ' + (rec == null ? 'no record' : loopNode === undefined ? 'no loop' : tape !== null ? 'tape: ' + tape : carried === null ? 'a table kept from the iteration before' : 'no allocation')) }
    }
    for (const s of saves) if (!keepLocals.has(text(T.a[s]))) drop(s)
  }
  // What an iteration's restore frees, overwritten first (JZ_DEBUG_POISON).
  for (const [r, parent, mark] of poisoned) {
    let prev = NONE
    for (let c = T.a[parent]; c !== r && c !== NONE; c = T.next[c]) prev = c
    const fill = node(intern('memory.fill')), len = node(intern('i32.sub'))
    const top = () => { const g = node(intern(heapAddr != null ? 'i32.load' : 'global.get')); if (heapAddr != null) push(push(g, node(intern('i32.const'))), num(heapAddr)); else push(g, str('$__heap')); return g }
    const get = () => { const g = node(LOCAL_GET); push(g, str(mark)); return g }
    const byte = node(intern('i32.const')); push(byte, num(255))
    push(len, top()); push(len, get())
    push(fill, get()); push(fill, byte); push(fill, len)
    insertAfter(parent, prev, fill)
  } })

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
  // What a restore frees, overwritten first (JZ_DEBUG_POISON): a pointer kept
  // into it reads all ones, no value a program made.
  const poison = (save) => {
    const fill = node(intern('memory.fill')), len = node(intern('i32.sub'))
    push(len, heapGet()); push(len, localGet(save))
    push(fill, localGet(save)); push(fill, i32c(255)); push(fill, len)
    return fill
  }
  const back = (save) => DBG_POISON ? [poison(save), heapSet(localGet(save))] : [heapSet(localGet(save))]
  // A frame that filled an enumeration cache moves the epoch: what the cache
  // names may lie in the memory the frame gives back.
  const epochBump = () => {
    const s = node(GLOBAL_SET); push(s, str('$__enumc_epoch'))
    const add = push(s, node(intern('i32.add'))); const g = push(add, node(intern('global.get'))); push(g, str('$__enumc_epoch')); push(add, i32c(1))
    return s
  }
  // The return of a rewound frame: the heap back, or for a conditional frame
  // back only when no escape wrote below the frame's mark, the lower of the
  // flag and the saved one then standing for the caller.
  // Where an escape did write below the mark, the outermost frame reading the
  // flag (none ran as it was entered: the base it saved is all ones) keeps
  // what the escapes reach and gives back the rest (module/core/reach.js); a
  // frame inside another keeps all, the outer one deciding for both.
  // A call that left nothing above its mark gives back nothing: one
  // comparison spares it the result's question, the flag's test and the
  // epoch. The epoch moves wherever the call left memory above its mark,
  // kept or given back: a cache filled in the call may name it, and what
  // the frame keeps a frame around it, a loop's iteration or the host may
  // give back later, none of which moves it.
  const reach = globals.has(ROOTN) && info.has(SURVIVE) && info.has(ROOT_RESET)
  const outermost = (bsave) => { const t = node(intern('i32.eq')); push(t, localGet(bsave)); push(t, i32c(-1)); return t }
  // A frame whose result may be a heap value (`ask`: the locals its results
  // stand in, and their types) gives back nothing where one names memory
  // above its mark: what it made is the caller's. An address is asked as it
  // is, a tagged value by `__made`.
  const unlessMade = (ask, save, nodes) => {
    if (ask == null) return nodes
    const madeOf = (ret, type) => {
      // The numeric-only fallback accepts ordinary numbers. NaNs (including
      // boxes) keep the frame; asked results use the age test below.
      if (ask.numeric) {
        const boxed = node(intern('f64.ne'))
        push(boxed, localGet(ret)); push(boxed, localGet(ret))
        return boxed
      }
      const made = type === 'i32' ? node(intern('i32.ge_u')) : node(CALL)
      if (type !== 'i32') push(made, str(MADE))
      push(made, localGet(ret)); push(made, localGet(save))
      return made
    }
    let made = madeOf(ask.rets[0], ask.types[0])
    for (let i = 1; i < ask.rets.length; i++) { const any = node(intern('i32.or')); push(any, made); push(any, madeOf(ask.rets[i], ask.types[i])); made = any }
    const iff = node(intern('if')); push(iff, made)
    push(iff, node(intern('then')))
    const not = push(iff, node(intern('else')))
    for (const n of nodes) push(not, n)
    return [iff]
  }
  // The kernels of the protocol's cold paths, out of line (optimize/watr-tail.js
  // OUT_OF_LINE keeps them there): every conditional frame calls them, a call
  // runs them only where memory may go back, or as the outermost frame is
  // entered. Made once, where a frame first needs one, and added to the module
  // as the pass ends.
  const kernels = []
  const heapAt = () => inMemory ? ['i32.load', ['i32.const', heapAddr]] : ['global.get', '$__heap']
  const heapTo = (v) => inMemory ? ['i32.store', ['i32.const', heapAddr], v] : ['global.set', '$__heap', v]
  // `$__frame_give(save, bsave)`: a conditional frame's release, past the
  // result's question. Where no escape wrote below the mark the heap goes back
  // to it; where one did, the outermost frame keeps what the escapes reach and
  // gives back the rest.
  let give = null
  const giveKernel = () => give ??= (kernels.push(['func', GIVE, ['param', '$save', 'i32'], ['param', '$bsave', 'i32'],
    ['if', ['i32.ge_u', ['global.get', '$__esc'], ['local.get', '$save']],
      ['then', ...(DBG_POISON ? [['memory.fill', ['local.get', '$save'], ['i32.const', 255], ['i32.sub', heapAt(), ['local.get', '$save']]]] : []), heapTo(['local.get', '$save'])],
      ...(reach ? [['else', ['if', ['i32.eq', ['local.get', '$bsave'], ['i32.const', -1]], ['then', heapTo(['call', SURVIVE, ['local.get', '$save']])]]]] : [])]]), GIVE)
  // `$__frame_outer()`: the outermost frame reading the flag starts the log
  // empty and the lowest flag clear, no loop's floor raised.
  let outer = null
  const outerKernel = () => outer ??= (kernels.push(['func', OUTER,
    ...(reach ? [['call', ROOT_RESET]] : []), ...(folds ? [['global.set', ESC_LOW, ['i32.const', -1]]] : []),
    ...(globals.has(IBASE) ? [['global.set', IBASE, ['i32.const', 0]]] : [])]), OUTER)
  const restore = (save, esave, bsave, ask = null, bump = false) => {
    let gives
    if (esave == null) gives = unlessMade(ask, save, back(save))
    else {
      const call = node(CALL); push(call, str(giveKernel())); push(call, localGet(save)); push(call, localGet(bsave))
      gives = unlessMade(ask, save, [call])
    }
    const bumped = bump ? [epochBump()] : []
    // a plain restore is one store: no comparison saves anything; the size tier pays none
    if (optimize?.rewindGuard !== false && (esave != null || ask != null || bump)) {
      const above = node(intern('i32.gt_u')); push(above, heapGet()); push(above, localGet(save))
      const iff = node(intern('if')); push(iff, above)
      const then = push(iff, node(intern('then'))); for (const n of [...bumped, ...gives]) push(then, n)
      gives = [iff]
    } else gives = [...gives, ...bumped]
    if (esave == null) return gives
    const lower = node(intern('i32.lt_u')); push(lower, localGet(esave)); push(lower, escGet())
    const join = node(intern('if')); push(join, lower)
    const joined = node(intern('then')); push(joined, escSet(localGet(esave))); push(join, joined)
    return [...gives, join, baseSet(localGet(bsave))]
  }
  // The log starts empty with the outermost frame, and the lowest flag clear.
  const lowSet = (value) => { const s = node(GLOBAL_SET); push(s, str(ESC_LOW)); push(s, value); return s }
  const lowGet = () => { const g = node(intern('global.get')); push(g, str(ESC_LOW)); return g }
  const logFrom = (bsave) => {
    const iff = node(intern('if')); push(iff, outermost(bsave))
    const call = push(push(iff, node(intern('then'))), node(CALL)); push(call, str(outerKernel()))
    return iff
  }
  // A frame that clears the flag hands what it held to the lowest: a handler
  // reads there what the frames an exception left did not hand back.
  const handOver = (esave) => {
    const lower = node(intern('i32.lt_u')); push(lower, localGet(esave)); push(lower, lowGet())
    const iff = node(intern('if')); push(iff, lower)
    push(push(iff, node(intern('then'))), lowSet(localGet(esave)))
    return iff
  }
  const baseGet = () => { const g = node(intern('global.get')); push(g, str('$__base')); return g }
  const baseSet = (value) => { const s = node(GLOBAL_SET); push(s, str('$__base')); push(s, value); return s }
  // The mark of the outermost frame reading the flag: this one's where none runs yet.
  const baseEnter = (save) => {
    const lower = node(intern('i32.lt_u')); push(lower, localGet(save)); push(lower, baseGet())
    const pick = node(intern('select')); push(pick, localGet(save)); push(pick, baseGet()); push(pick, lower)
    return baseSet(pick)
  }
  const localGet = (name) => { const g = node(LOCAL_GET); push(g, str(name)); return g }
  const localSet = (name, value) => { const s = node(LOCAL_SET); push(s, str(name)); push(s, value); return s }

  phase(() => { for (let f = T.a[root]; f !== NONE; f = T.next[f]) {
    if (T.op[f] !== FUNC) continue
    const name = text(T.a[f])
    const resultType = name === null ? undefined : rewindable.get(name)
    if (resultType === undefined) continue
    const types = Array.isArray(resultType) ? resultType : [resultType]
    const rec = info.get(name)
    if (rec == null) continue
    const bump = rec.enumc === true && globals.has('$__enumc_epoch')
    // a tagged result is asked by a kernel the module has to hold
    if (asked.has(name) && types.some(t => t !== 'i32') && !info.has(MADE)) { if (rewrite) report?.(name, 'result: may hold a heap value'); continue }
    if (rec.unsafe) { if (rewrite) report?.(name, rec.why); continue }
    let unsafe = false, flat = false
    const hasAlloc = rec.allocs, tails = []
    eachBody(f, (id) => {
      if (unsafe) return false
      const op = T.op[id]
      // a return whose value is on the stack (flat, or an atom) would leave past the restore:
      // the outermost frame's mark would stay
      if ((op === RETURN && T.a[id] === NONE) || (op < 0 && text(id) === 'return')) flat = true
      if (!TAILS.has(op)) return
      // A tail call leaves before the epilogue. One whose callee never runs the
      // function again can be a plain call: the frame then outlives the callee
      // and restores the heap after it, at the price of one frame. One that
      // may run it again keeps the frame elision a recursion written as a
      // tail call counts on, and the function keeps its heap.
      const callee = op === RETURN_CALL ? text(T.a[id]) : null
      if (callee !== null && !runsAgain(callee, name)) { tails.push(id); return }
      unsafe = true; return false
    })
    // What the frame may reach lowers the flag: it restores by it, where that
    // may free something (its own reason, or a host calling it again and again).
    const cond = rec.tapeFlag === true
    if (cond && !conditional.has(name) && !rec.ownFlag && !exported.has(name)) { if (rewrite) report?.(name, 'escape: ' + rec.tapeFlagWhy); continue }
    if (!unsafe) { releasable.add(name); if (cond) { flagged.add(name); if (hosted.has(name)) readers.add(name) } }
    if (!rewrite) continue
    if (unsafe || flat || !hasAlloc) { report?.(name, unsafe ? 'return_call' : flat ? 'flat return' : 'no allocation'); continue }
    // A result asked by its age that is always storage the frame made gives
    // nothing back on any call: the rewind would only test it.
    if (asked.has(name) && !numberResult.has(name) && types.length === 1 && resultMade(f)) { report?.(name, 'result: always storage the frame made'); continue }
    if (heapless) continue
    // `(return_call $k args…)` → `(return (call $k args…))`: the children move
    // under a new call node, and the return wrapping below treats it like any
    // other `return X`.
    for (const id of tails) {
      const call = node(CALL)
      T.a[call] = T.a[id]
      T.a[id] = call
      T.op[id] = RETURN
    }

    const declared = new Set()
    for (let c = T.next[T.a[f]]; c !== NONE; c = T.next[c]) if (T.op[c] === LOCAL) declared.add(text(T.a[c]))
    let id = 0
    while (declared.has(`$${MARK}heap_save${id}`) || declared.has(`$${MARK}arena_ret${id}`) || declared.has(`$${MARK}esc_save${id}`)) id++
    const save = `$${MARK}heap_save${id}`, ret = `$${MARK}arena_ret${id}`
    const esave = cond ? `$${MARK}esc_save${id}` : null, bsave = cond ? `$${MARK}esc_base${id}` : null
    // one local a result: the first by the name a single result has
    const rets = types.map((t, i) => i === 0 ? ret : `${ret}_${i}`)
    const ask = asked.has(name) || numberResult.has(name) ? { rets, types, numeric: numberResult.has(name) } : null
    // Several results stand on the stack as their expressions end, however
    // many expressions made them (a call may yield all): the locals take them
    // last first, and yield them in order past the restore.
    const taken = () => rets.map((r) => { const s = node(LOCAL_SET); push(s, str(r)); return s }).reverse()

    // The last instruction (a trailing comment atom is not it).
    let last = NONE, beforeLast = NONE
    for (let c = T.a[f], prev = NONE; c !== NONE; prev = c, c = T.next[c]) if (T.op[c] >= 0) { beforeLast = prev; last = c }
    const endsWithReturn = T.op[last] === RETURN || T.op[last] === RETURN_CALL

    // Every `return X` yields X through the result local after the restore.
    // Several results stay under the `return` itself, its operands in a row
    // (a block of several results names a type, which the encoder indexes
    // wrongly past the 64th). A return inside X leaves before the one around
    // it (a dispatched tail call: each arm returns its call), and takes the
    // same path: the walk goes on into X. The restore stands at each return,
    // not once past a block every return leaves for: a branch to it merges
    // every path's values there, which measured slower on V8 than the copies.
    eachBody(f, (id) => {
      if (T.op[id] !== RETURN || T.a[id] === NONE) return
      if (types.length > 1) {
        for (const n of taken()) push(id, n)
        for (const n of restore(save, esave, bsave, ask, bump)) push(id, n)
        for (const r of rets) push(id, localGet(r))
        return
      }
      const value = T.a[id]
      const block = node(BLOCK)
      push(push(block, node(RESULT)), str(resultType))
      T.next[value] = NONE
      push(block, localSet(ret, value))
      for (const n of restore(save, esave, bsave, ask, bump)) push(block, n)
      for (const r of rets) push(block, localGet(r))
      T.a[id] = block
    })
    // The fall-through value takes the same path.
    if (!endsWithReturn) {
      if (types.length === 1) {
        T.next[beforeLast] = NONE
        T.next[last] = NONE
        push(f, localSet(ret, last))
      } else for (const n of taken()) push(f, n)
      for (const n of restore(save, esave, bsave, ask, bump)) push(f, n)
      for (const r of rets) push(f, localGet(r))
    }
    // Declarations and the save at the top of the body.
    let at = T.a[f]
    while (T.next[at] !== NONE && isHeader(T.next[at])) at = T.next[at]
    const results = rets.map((r, i) => local(r, types[i]))
    const entry = esave == null ? [local(save, 'i32'), ...results, localSet(save, heapGet())]
      : [local(save, 'i32'), local(esave, 'i32'), local(bsave, 'i32'), ...results, localSet(save, heapGet()), localSet(esave, escGet()),
        ...(folds ? [handOver(esave)] : []), escSet(i32c(-1)),
        localSet(bsave, baseGet()), ...(reach || folds ? [logFrom(bsave)] : []), baseEnter(save)]
    for (const n of entry) { insertAfter(f, at, n); at = n }
    rewound.add(name)
    if (esave != null) { flagged.add(name); readers.add(name); report?.(name, 'kept on a call that runs an escape: ' + (conditional.get?.(name) ?? rec.tapeFlagWhy)) }
  } })
  // The flag is read by the conditional frames rewound here, through the
  // host by the conditional exports it releases, and by a phase checkpoint
  // (`readers`): every function they can reach keeps its writes; elsewhere they go.
  for (const [name, rec] of info) if (rec.reader) readers.add(name)
  const reached = new Set(), work = heapless ? [] : [...readers]
  let viaTable = false
  while (work.length) {
    const n = work.pop()
    if (reached.has(n)) continue
    reached.add(n)
    const r = info.get(n)
    if (!r) continue
    for (const c of r.calls) work.push(c)
    if (r.resolved) for (const t of r.targets) work.push(t)
    else if (r.indirect && !viaTable) { viaTable = true; for (const t of table) work.push(t) }
  }
  const lowersFlag = (id) => id !== NONE && (T.op[id] === GLOBAL_SET ? text(T.a[id]) === '$__esc' : T.op[id] === CALL && LOWERS.has(text(T.a[id])))
  const setsLocal = (id) => { let sets = false; walk(id, (n) => { if (sets) return false; if (T.op[n] === LOCAL_SET || T.op[n] === LOCAL_TEE) sets = true }); return sets }
  // `(if test (then lowerings…))`: an if whose only work is to lower the flag.
  const lowersOnly = (id) => {
    let then = NONE, n = 0
    for (let c = T.a[id]; c !== NONE; c = T.next[c]) { n++; if (T.op[c] === THEN) then = c }
    if (n !== 2 || then === NONE || T.a[then] === NONE) return false
    for (let c = T.a[then]; c !== NONE; c = T.next[c]) if (!lowersFlag(c) || setsLocal(c)) return false
    return true
  }
  // `(if test (then (local.set $mark …)…))`: an if whose only work is to move a
  // site's mark (emit/dispatch.js, past an operand that allocates).
  const marksOnly = (id) => {
    let then = NONE, n = 0
    for (let c = T.a[id]; c !== NONE; c = T.next[c]) { n++; if (T.op[c] === THEN) then = c }
    if (n !== 2 || then === NONE || T.a[then] === NONE) return false
    for (let c = T.a[then]; c !== NONE; c = T.next[c]) {
      if (T.op[c] !== LOCAL_SET || !isMark(c)) return false
      const value = T.next[T.a[c]]
      if (value !== NONE && setsLocal(value)) return false
    }
    return !setsLocal(T.op[T.a[id]] === THEN ? T.next[T.a[id]] : T.a[id])
  }
  // The flag lowered as the statement before the one that runs an escape: every
  // operand of a statement runs when it does, and each instruction keeps its
  // arity (a pass reading a `global.set`'s value takes its one operand).
  // the note stands before its lowering, which takes the flag to zero
  const noted = (f, why) => {
    const note = node(CALL), id = ++escNotes, before = node(GLOBAL_GET)
    push(before, str('$__esc'))
    push(note, str('$__esc_note')); push(note, i32c(id)); push(note, before); push(note, i32c(0))
    console.error(`esc-note ${id}: ${text(T.a[f])}: ${why}`)
    return note
  }
  const lowerBefore = (f, up, id, why) => {
    let n = id, p = up.get(n)
    if (p === undefined) throw new Error(`arena rewind: an escape of ${text(T.a[f])} left its body`)
    while (p !== NONE && !SEQUENCE.has(T.op[p])) { n = p; p = up.get(n) }
    const seq = p === NONE ? f : p
    let prev = NONE
    for (let c = T.a[seq]; c !== n; c = T.next[c]) prev = c
    const lower = escSet(i32c(0))
    insertAfter(seq, prev, lower)
    if (DBG_ESC && imports.has('$__esc_note')) insertAfter(seq, prev, noted(f, why))
  }
  const isMark = (id) => { const n = text(T.a[id]); return n !== null && n.startsWith('$' + MARK + ESC_MARK) }
  phase(() => { for (let f = T.a[root]; f !== NONE; f = T.next[f]) {
    if (T.op[f] !== FUNC) continue
    const name = text(T.a[f]), rec = name === null ? null : info.get(name)
    if (!reached.has(name)) {
      if (LOWERS.has(name)) continue
      const marks = []
      walk(f, (id, parent) => {
        if (parent === NONE) return
        // A check whose only work is the lowering (emit/dispatch.js: a growth
        // site's `(if (the heap moved) (then lower))`) goes whole, its test
        // with it, unless the test sets a local later code reads: that test
        // stays, dropped.
        if (T.op[id] === IF && lowersOnly(id)) {
          const test = T.op[T.a[id]] === THEN ? T.next[T.a[id]] : T.a[id]
          if (!setsLocal(test)) { remove(parent, id); return false }
          T.op[id] = DROP; T.a[id] = test; T.next[test] = NONE
          return false
        }
        // a mark moved for a check that goes with it
        if (T.op[id] === IF && marksOnly(id)) { remove(parent, id); return false }
        if (T.op[id] === GLOBAL_SET && text(T.a[id]) === '$__esc') { remove(parent, id); return false }
        // a lowering by a value: the value stays where reading it sets a local
        if (T.op[id] === CALL && LOWERS.has(text(T.a[id]))) {
          const value = T.next[T.a[id]]
          if (value === NONE || !setsLocal(value)) { remove(parent, id); return false }
          T.op[id] = DROP; T.a[id] = value
          return false
        }
        if (T.op[id] === LOCAL_SET && isMark(id)) marks.push([id, parent])
      })
      // What a growth site kept for its check (the heap's top, its receiver)
      // goes with the check, unless a pass before this one made later code
      // read the local: a receiver read twice is read once into it.
      if (marks.length) {
        const read = new Set()
        walk(f, (id) => { if ((T.op[id] === LOCAL_GET || T.op[id] === LOCAL_TEE) && isMark(id)) read.add(text(T.a[id])) })
        for (const [id, parent] of marks) {
          if (read.has(text(T.a[id]))) continue
          const value = T.next[T.a[id]]
          if (value === NONE || !setsLocal(value)) remove(parent, id)
          else { T.op[id] = DROP; T.a[id] = value }
        }
      }
      continue
    }
    if (!rec) continue
    if (rec.flagAt.length) {
      const up = new Map()
      eachBody(f, (n, p) => { up.set(n, p) })
      for (const id of rec.flagAt) lowerBefore(f, up, id, rec.flagWhy)
    }
    if (rec.entry) {
      let at = T.a[f]
      while (T.next[at] !== NONE && isHeader(T.next[at])) at = T.next[at]
      const lower = escSet(i32c(0))
      insertAfter(f, at, lower)
      if (DBG_ESC && imports.has('$__esc_note')) insertAfter(f, at, noted(f, 'entered: ' + rec.why))
    }
  } })
  if (heapless) flagged.clear()
  // The host is the outermost reader of a call it releases by the flag: what
  // such a call keeps is the host's to walk (interop.js).
  // Its log starts empty as the host sets its mark (link/sections.js `__base`).
  else if (reach && [...readers].some(n => hosted.has(n))) for (const name of [SURVIVE, ROOT_RESET]) {
    const e = push(root, node(intern('export')))
    push(e, str(`"${name.slice(1)}"`))
    push(push(e, node(FUNC)), str(name))
  }
  // The log the module makes as it starts (wat/assemble/stdlib-pull.js) goes
  // where no frame walks from it.
  if (rewrite && !(reach && !heapless && readers.size)) for (let f = T.a[root]; f !== NONE; f = T.next[f]) {
    if (T.op[f] !== FUNC || text(T.a[f]) !== '$__start') continue
    walk(f, (id, parent) => { if (parent !== NONE && T.op[id] === GLOBAL_SET && text(T.a[id]) === ROOTS) { remove(parent, id); return false } })
  }
  for (const k of kernels) push(root, fromWat(k))
  return { releasable, rewound, flagged, allocates: (name) => info.get(name)?.allocs ?? false, why: (name) => info.get(name)?.why ?? null }
}
