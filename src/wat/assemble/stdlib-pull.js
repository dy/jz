/**
 * Stdlib template realization — the parse-cache (parse once per distinct
 * resolved WAT string, hand out clones), reachability over the actually-
 * compiled output, the late f64x2-vectorizer stdlib top-up, and the main
 * pull-stdlib-and-decide-memory/allocator phase that rides on all three.
 *
 * Split out of assemble.js (pipeline-minimality slice) — pure move, no
 * behavior change. See ../assemble.js for the stage contract and
 * `.work/assemble-outliers.md` §4. `syncImports` (host-import merge, runs
 * just before `pullStdlib` — compile/index.js:2892/2991) shares this file as
 * a small `sec.imports`/`sec.stdlib` bookkeeping sibling with no other
 * natural home.
 */

import parseWat from 'watr/parse'
import { ctx, inc, resolveIncludes, err, declGlobal } from '../../ctx.js'
import { walkAst, some } from '../../ast.js'
import { dataAlign, dataPush, dataLen, strPoolLen } from '../../static-data.js'
import { MEM_OPS, findBodyStart } from '../../ir.js'
import { installHelperCounters, instrumentHelperCounter } from '../../helper-counters.js'

// Stdlib WAT templates are fixed text (or feature-keyed text from a factory) —
// `parseWat` of the same string always yields the same tree. Parsing is the
// dominant cost when a program pulls heavy stdlib (Math pow/sqrt, JSON, regex):
// it re-tokenizes ~KB of text every compile. Parse once per distinct resolved
// string, then hand out a deep clone (downstream passes mutate nodes in place).
// Module-level on purpose: the cache persists across compile() calls.
let stdlibParseCache = new Map()  // resolved WAT string → pristine parsed tree
const cloneTemplate = (node) => {
  if (!Array.isArray(node)) return node
  const copy = node.map(cloneTemplate)
  if (node.loc != null) copy.loc = node.loc
  return copy
}
const parseTemplate = (str) => {
  let tmpl = stdlibParseCache.get(str)
  if (tmpl === undefined) stdlibParseCache.set(str, tmpl = parseWat(str))
  return cloneTemplate(tmpl)
}
// Self-compile-only: see clearDollar (src/ir.js) — same dangling-arena-pointer hazard,
// and the same fix: swap in a fresh Map, don't just `.clear()` the old one (its
// backing table is itself an arena allocation `_clear` invalidates). Must run every
// compile in a warm-instance loop (see scripts/self.js setupSelf).
export const clearStdlibParseCache = () => { stdlibParseCache = new Map() }
// Region-arena EMISSION rounds (re-landing .work/research.md §Emission
// rounds): same non-`ctx` module-scope hazard as DOLLAR (src/ir.js,
// dollarMap/setDollarMap) — stdlibParseCache lives entirely outside `ctx`,
// invisible to any ctx.*-based region-round root array. `parseTemplate`
// fires for every stdlib helper `pullStdlib` realizes, growing this cache's
// backing Map heavily during that one stage — a pullStdlib-scoped round must
// root/rebind it exactly like DOLLAR, via this pair.
export const stdlibParseCacheMap = () => stdlibParseCache
export const setStdlibParseCacheMap = (m) => { stdlibParseCache = m }

/**
 * Stdlib funcs actually reachable from the emitted program. Seeds from real
 * `call`/`return_call`/`ref.func` sites in the user funcs, `__start`, and the elem
 * table, then closes transitively over the stdlib call graph (each reached helper's
 * template references). Conservative by construction — a template `$__foo` in a
 * feature-dead branch is kept, never dropped — so it's safe to gate inclusion and the
 * memory/allocator decision on it. An eagerly-`inc`'d helper that nothing calls is
 * absent, which is the whole point.
 */
function reachableStdlib(sec) {
  const stdlib = ctx.core.stdlib
  const reach = new Set(), stack = []
  // Track every reached name (module-namespace `math.sin` included), but only follow
  // those with a stdlib template. Names match `$foo`, `$__foo`, `$math.sin_core` — the
  // dotted module funcs are the ones the `$__`-only regex used to miss, pruning live code.
  const add = (name) => { if (!reach.has(name)) { reach.add(name); if (stdlib[name] != null) stack.push(name) } }
  const scanIR = (node) => {
    if ((node[0] === 'call' || node[0] === 'return_call' || node[0] === 'ref.func') &&
        typeof node[1] === 'string' && node[1][0] === '$') add(node[1].slice(1))
  }
  for (const fn of sec.funcs) walkAst(fn, { enter: scanIR })
  for (const fn of sec.start) walkAst(fn, { enter: scanIR })
  for (const e of sec.elem)               // closure table: bare `$fn` func refs
    if (Array.isArray(e)) for (const c of e) if (typeof c === 'string' && c[0] === '$') add(c.slice(1))
  // A stdlib func that self-exports (`(export "__invoke_closure")`) is a host-facing
  // entry point — the JS host calls it directly, so it's a root even when nothing in
  // the wasm calls it. Mirrors treeshake's inline-export rooting.
  for (const n of ctx.core.includes) {
    const v = stdlib[n]
    let t = ''
    try { t = typeof v === 'function' ? v() : v } catch { t = '' }
    if (typeof t === 'string' && t.includes('(export "')) add(n)
  }
  while (stack.length) {
    const v = stdlib[stack.pop()]
    let text = ''
    try { text = typeof v === 'function' ? v() : v } catch { text = '' }
    if (typeof text === 'string') for (const m of text.matchAll(/\$([A-Za-z_][A-Za-z0-9_.]*)/g)) add(m[1])
  }
  return reach
}

// The f64x2 stdlib mirrors the lane vectorizer (optimize/vectorize.js) injects in the LATE 'post'
// pass — after the stdlib was pulled + treeshaken. Keep in sync with that pass's call-rewrite map
// (PPC_CALL2). These are the ONLY helpers appendLateStdlib may add; restricting to them avoids
// touching helpers that live in other module sections (ext-stdlib, imports) where a blind
// referenced-but-absent scan would wrongly re-append and duplicate them.
const LATE_VEC_HELPERS = new Set(['math.sin2', 'math.cos2', 'math.pow2', 'math.atan2_2', 'math.hypot_2', 'math.log_v', 'math.exp_v', 'math.exp2_v', 'math.cbrt_v', 'math.fifthroot_v',
  // math.pow_fold (scalar) is normally eager-included by emitPow's own const-exponent fold (which
  // always `inc()`s it before the vectorizer ever runs, under optimize.crPow — see module/math.js).
  // It's ALSO listed here for the one path where that eager inc doesn't fire: a genuine runtime
  // $math.pow(x,y) whose y is proven constant only during vectorization (vectorize.js's
  // `$math.pow(x,c)` lift) — that rewrite calls pow_fold_v directly, so pow_fold_v's own
  // dependency needs the same fixpoint append. Both only ever exist in the stdlib under crPow.
  'math.pow_fold_v', 'math.pow_fold'])

// A late pass can reference one of the f64x2 mirrors that wasn't present when the stdlib was first
// assembled. Append any referenced-but-missing mirror body (fixpoint over their own calls, though
// the trig mirrors call nothing). moduleArr is mutated in place; non-mirror references are left for
// watr to resolve (a genuine missing helper is the kernel's own pull, already satisfied).
export function appendLateStdlib(moduleArr, pushTarget = moduleArr) {
  const stdlib = ctx.core.stdlib
  const have = new Set()
  for (const n of moduleArr) if (Array.isArray(n) && n[0] === 'func' && typeof n[1] === 'string') have.add(n[1])
  let added = true
  while (added) {
    added = false
    const refs = new Set()
    const scan = (n) => { if ((n[0] === 'call' || n[0] === 'return_call' || n[0] === 'ref.func') && typeof n[1] === 'string' && n[1][0] === '$') refs.add(n[1]) }
    for (const n of moduleArr) walkAst(n, { enter: scan })
    for (const ref of refs) {
      const name = ref.slice(1)
      if (have.has(ref) || !LATE_VEC_HELPERS.has(name) || stdlib[name] == null) continue
      const node = parseTemplate(typeof stdlib[name] === 'function' ? stdlib[name]() : stdlib[name])
      const body = node[0] === 'module' ? node[1] : node
      pushTarget.push(body)
      // Keep the scan array in sync so the fixpoint can resolve a mirror that itself
      // calls another mirror (cbrt_v → log_v/exp_v). When pushTarget IS moduleArr the
      // single push already did this.
      if (pushTarget !== moduleArr) moduleArr.push(body)
      have.add(ref)
      added = true
    }
  }
}

/**
 * Phase: pull stdlib + memory.
 */
export function pullStdlib(sec) {
  installHelperCounters()
  resolveIncludes()

  // Reachability, not inclusion, decides what the output needs. `ctx.core.includes`
  // accumulates everything a module *might* use (eager module-load `inc`s + transitive
  // deps), but a const array / static string literal calls none of it. So we seed from
  // the actual call sites in the emitted funcs + __start (+ elem table) and close
  // transitively over the stdlib call graph. An eagerly-included helper that nothing
  // calls never enters this set — so allocator, memory, and exports reflect real use.
  const reachable = reachableStdlib(sec)
  const realize = (n) => { const v = ctx.core.stdlib[n]; try { return typeof v === 'function' ? v() : v } catch { return '' } }

  // Two distinct needs, kept separate:
  //  · needsAlloc — the program allocates at runtime: an allocator func is reachable,
  //    or shared-mem string literals seed a pool __start allocs. Drives the bump
  //    allocator (`__alloc`/`__alloc_hdr`/`__clear`), the `__heap` pointer, and the
  //    `_alloc`/`_clear` marshalling exports.
  //  · needsMemory — linear memory must merely *exist*: we allocate, OR a literal lives
  //    in a static data segment (a const pointer, no allocator behind it), OR a reached
  //    helper / inline body does a load/store, OR `__ptr_type` is reached (the module
  //    discriminates heap tags — an `instanceof`/`typeof x==='object'` whose argument the
  //    host marshals across the boundary). A data segment with no memory is invalid wasm,
  //    so memory can't be gated on allocation alone.
  const ALLOC_FUNCS = ['__alloc', '__alloc_hdr', '__alloc_hdr_n']
  const needsAlloc = strPoolLen() > 0 || ALLOC_FUNCS.some(a => reachable.has(a)) ||
    // shared memory memory.init's the static region into __alloc'd space at start
    !!(ctx.memory.shared && dataLen() > 0)
  // Memory ops can be emitted *inline* into user/start funcs (a heap-path char read
  // loads without calling a stdlib helper), so scan the emitted bodies too.
  const hasMemOp = (node) => some(node, n => typeof n[0] === 'string' && MEM_OPS.test(n[0]), { skipArrow: false })
  // `ctx.runtime.data` is never empty here — the number module seeds a static stringify
  // prefix (`NaNInfinity…`) at offset 0; stripStaticDataPrefix removes it when unused, so
  // the real question is whether any data lives *beyond* that strippable prefix.
  // An explicit `{ memory: pages }` / shared-memory option is a caller request to own
  // linear memory (e.g. to marshal host values in), independent of what the wasm itself
  // reaches — honour it even for an otherwise-memoryless program.
  const explicitMemory = ctx.memory.pages > 0 || !!ctx.memory.shared
  const needsMemory = needsAlloc || explicitMemory ||
    dataLen() > (ctx.runtime.staticDataLen || 0) ||
    reachable.has('__ptr_type') ||
    [...reachable].some(n => MEM_OPS.test(realize(n))) ||
    sec.funcs.some(hasMemOp) || sec.start.some(hasMemOp)
  // Emit only what's reachable: drop every eagerly-`inc`'d *internal* helper the program
  // never calls. This is what lets a const-array / static-string / atom module shed the
  // allocator, pointer dispatchers, and length helpers that an array/object module load
  // pulled in wholesale — and it keeps the dead allocator from dangling on the `$__heap`
  // we delete below. Scoped to `__`-prefixed names: module-namespace funcs (`math.sin`)
  // are pulled in on demand, never eagerly, so they're already minimal and never pruned
  // here (guarding against any reachability blind spot in a dotted-name template).
  for (const n of [...ctx.core.includes]) if (n.startsWith('__') && !reachable.has(n)) ctx.core.includes.delete(n)
  // Lazy data-table injection — Eisel-Lemire decimal→f64 (~2KB) and Ryū
  // float→decimal (~9.7KB), module/number.js. Each table is appended only when
  // its owning function survived pruning, and its base global declared at the
  // offset. Must run HERE so dataPages (below) accounts for the addition; keeps
  // the tables out of programs that never convert decimals at runtime.
  //
  // Reachability here OVER-counts: a dead inlined helper's `arr[i] | 0` on an
  // untyped param pulls __to_num → __dec_to_f64, landing a table even when no
  // LIVE code uses it. Record each span (they are the data tail — the last
  // appends) so stripDeadLazyTables can excise dead ones post-lowering, once
  // reachability is exact. Base globals register in staticI32GlobalInits so a
  // later static-prefix strip shifts them like every other static offset.
  ctx.runtime.lazySpans = []
  const injectTable = (fn, global, bytes) => {
    if (!ctx.core.includes.has(fn) || !bytes) return false
    // ctx.runtime.data is normally already a string by here because module/number.js's
    // setup (which seeds the static NaN/Infinity/… stringify prefix) runs unconditionally —
    // but ONLY for a program that pulls in something from number.js. A program reaching
    // this via a module with no such dependency (e.g. module/math.js's CR-pow tables, needed
    // by any `**`/Math.pow call, independent of number formatting) can hit pullStdlib with
    // ctx.runtime.data still at its unset default — initialize defensively.
    const start = dataLen()
    dataAlign(8)
    // Shared memory: the table lands via memory.init at a runtime base, so the
    // global is MUTABLE and re-pointed at start (compile/index.js); its declared
    // init meanwhile holds the offset WITHIN the static region.
    declGlobal(global, 'i32', dataLen(), ctx.memory.shared ? undefined : { mut: false })
    if (ctx.memory.shared && !ctx.scope.globals.has('__staticBase')) declGlobal('__staticBase', 'i32')
    dataPush(bytes)
    ;(ctx.runtime.staticI32GlobalInits ??= []).push(global)
    ctx.runtime.lazySpans.push({ fn: '$' + fn, global, start, bytes })
    return true
  }
  // prevent double-injection on re-entry (null-sentinel; jz forbids delete)
  if (injectTable('__dec_to_f64', '__el_tbl', ctx.runtime.elTable)) ctx.runtime.elTable = null
  if (injectTable('__ftoa_shortest', '__ryu_tbl', ctx.runtime.ryuTable)) ctx.runtime.ryuTable = null
  // CR-pow log2/exp2 breakpoint tables (module/math.js's $math.pow_transcend) — both gated on
  // the SAME owning function since the shared kernel always needs both tables together.
  if (injectTable('math.pow_transcend', 'math.pow_log2_tbl', ctx.runtime.powLog2Table)) ctx.runtime.powLog2Table = null
  if (injectTable('math.pow_transcend', 'math.pow_exp2_tbl', ctx.runtime.powExp2Table)) ctx.runtime.powExp2Table = null
  if (!needsAlloc) { ctx.scope.globals.delete('__heap'); ctx.scope.globals.delete('__heap_reset') }
  if (needsMemory && ctx.module.modules.core) {
    if (needsAlloc) {
      for (const fn of ['__alloc', '__alloc_hdr', '__clear']) ctx.core.includes.add(fn)
      // Late-add of allocators may pull in transitive deps (__alloc → __memgrow,
      // etc.) that the initial resolveIncludes did not yet see; re-resolve.
      // No-op when the alloc trio was already present.
      resolveIncludes()
      // Record the post-init heap top into `__heap_reset` so `__clear` rewinds to
      // just above this module's init-time heap state (e.g. the self-compile compiler's
      // GLOBALS/atom tables), not into it. Done here — where `__heap` is known to
      // survive — as the last `__start` action before any non-returning timer loop.
      // No `__start` ⇒ no init allocations ⇒ `__heap_reset`'s data-end seed is right.
      // Module-global snapshot sweep: `__clear` rewinds the arena, so ANY mutable module
      // global still holding a pointer into it dangles — the whole warm-reuse landmine
      // class (a lazy `let CACHE = null` cache, json's `__jbuf` stringify buffer, watr's
      // in-kernel NCLS dict, a memoized string…). Fixing sites one at a time is
      // whack-a-mole (eager-NCLS peeled "Unknown memory end" only to expose the next
      // dangler behind it); the class fix is a CONTRACT: `_clear` restores every
      // runtime-written module global to its post-`__start` value — warm behaves as
      // fresh, minus the init cost. Blanket restore beats an is-ephemeral-pointer test:
      // it also heals SCALAR poisoning (a cached length/hash derived from round-1 arena
      // content is stale garbage even though it's no pointer). Mechanics: reserve one
      // durable slab slot per candidate (allocated at `__start` tail — BEFORE the
      // `__heap_reset` capture, so the slab sits under the watermark), store each
      // global's post-init value there, and re-load it in `__clear`. Only globals the
      // write-scan sees mutated OUTSIDE `__start` participate (read-only globals cannot
      // dangle, and rooting them here would defeat watr's dead-global pruning); with no
      // `__start` a global's post-init value IS its declared init — restore the constant
      // directly, no slot. Excluded: the runtime-protocol globals (each has its own
      // reset right here in `__clear` — resetting `__heap_reset` itself would be
      // self-defeating), `__tof_*` coercion scratch (written-before-read within one
      // expression, can never carry state across a round) and `__hc_*` helper counters
      // (diagnostics must observe rounds, not be reset by them).
      const globalRestores = []
      if (!ctx.memory.shared && ctx.scope.globals.has('__heap_reset')) {
        const startFn = sec.start.find(n => Array.isArray(n) && n[0] === 'func' && n[1] === '$__start')
        const SNAP_PROTOCOL = new Set(['__heap', '__heap_reset', '__heap_start', '__dyn_props', '__dyn_props_filter',
          '__dyn_get_cache_off', '__dyn_get_cache_props', '__durable_fwd_buf', '__durable_fwd_n',
          '__durable_arr_buf', '__durable_arr_n', '__gsnap_base',
          '__enumc_off', '__enumc_len', '__enumc_arr'])
        const runtimeWritten = new Set()
        const scanSet = (node) => {
          if (node[0] === 'global.set' && typeof node[1] === 'string' && node[1][0] === '$') runtimeWritten.add(node[1].slice(1))
        }
        for (const fn of sec.funcs) walkAst(fn, { enter: scanSet })
        // stdlib bodies are still WAT text here (parseTemplate runs later) — scan textually.
        // Helpers write registry globals too: collection's __seq, json's __jbuf/__jstack….
        // Thunked templates expand ONCE by contract (expansion-time ctx reads) — memoize
        // the expansion back into the registry so the later parseTemplate pass reuses this
        // exact string instead of expanding a second time.
        for (const name of ctx.core.includes) {
          let src = ctx.core.stdlib[name]
          if (typeof src === 'function') ctx.core.stdlib[name] = src = src()
          if (typeof src !== 'string') continue
          for (const m of src.matchAll(/\(global\.set \$([A-Za-z0-9_.$]+)/g)) runtimeWritten.add(m[1])
        }
        // Self-compile divergence diagnostics (see resolveIncludes' twin block).
        if (ctx.core.diagSink) ctx.core.diagSink.sweep = {
          includes: [...ctx.core.includes].sort().join(' '),
          runtimeWritten: [...runtimeWritten].sort().join(' '),
        }
        const SNAP_TYPES = { i32: 8, i64: 8, f32: 8, f64: 8, v128: 16 }
        const snapSlots = []   // [name, type, slabOffset]
        let slabBytes = 0
        for (const name of runtimeWritten) {
          const g = ctx.scope.globals.get(name)
          if (!g || !g.mut || !SNAP_TYPES[g.type]) continue
          if (SNAP_PROTOCOL.has(name) || name.startsWith('__tof_') || name.startsWith('__hc_')) continue
          if (startFn) { snapSlots.push([name, g.type, slabBytes]); slabBytes += SNAP_TYPES[g.type] }
          // no __start ⇒ post-init value = declared init: restore the constant, no slot
          else globalRestores.push(`(global.set $${name} (${g.type}.const ${g.init ?? 0}))`)
        }
        if (ctx.core.diagSink?.sweep) {
          ctx.core.diagSink.sweep.snapSlots = snapSlots.map(([n]) => n).sort().join(' ')
          ctx.core.diagSink.sweep.restores = globalRestores.slice().sort().join(' ')
          ctx.core.diagSink.sweep.hasStart = !!startFn
        }
        if (startFn) {
          // Tier 2 payoff: when module init folded away entirely (static trees,
          // static schema table) and no global needs a snapshot slot, the ONLY
          // thing left to do is the __heap_reset capture — whose value is exactly
          // the seeded data-end init. Drop __start altogether.
          if (!snapSlots.length && findBodyStart(startFn) >= startFn.length) {
            const dirIdx = sec.start.findIndex(n => Array.isArray(n) && n[0] === 'start')
            sec.start.length = 0
            if (dirIdx !== -1) { /* directive lived in sec.start — cleared above */ }
          } else {
          const capture = ['global.set', '$__heap_reset', ['global.get', '$__heap']]
          const inject = [capture]
          if (snapSlots.length) {
            declGlobal('__gsnap_base', 'i32')
            inject.unshift(['global.set', '$__gsnap_base', ['call', '$__alloc', ['i32.const', String(slabBytes)]]],
              ...snapSlots.map(([name, type, off]) =>
                [`${type}.store`, `offset=${off}`, ['global.get', '$__gsnap_base'], ['global.get', `$${name}`]]))
            for (const [name, type, off] of snapSlots)
              globalRestores.push(`(global.set $${name} (${type}.load offset=${off} (global.get $__gsnap_base)))`)
          }
          const tail = startFn[startFn.length - 1]
          if (Array.isArray(tail) && tail[0] === 'call' && tail[1] === '$__timer_loop') startFn.splice(startFn.length - 1, 0, ...inject)
          else startFn.push(...inject)
          // __heap_reset's DECLARED init is HEAP.START (the static-data-end address —
          // correct for the no-__start case, where it never gets overwritten and IS the
          // true rewind point). But every durable-vs-ephemeral guard (durableFwdLogIR/
          // durableLenLogIR/durableSlotLogIR/durableEntryLogIR — collection.js) reads
          // $__heap_reset's CURRENT value, and while __start is STILL RUNNING (before the
          // `capture` instruction just injected above), that current value is still the
          // stale HEAP.START — which sits ABOVE the low reserved/static-data region a
          // compile-time-constant literal (array/object/collection built entirely from
          // literals) gets folded into. Any IN-PLACE header mutation of such a literal
          // reachable from module-level (non-function) init code — e.g. `let a = [1,2,3];
          // a.length = 2` at top level — then reads its own low static address as "off <
          // __heap_reset" and WRONGLY logs itself as a durable→this-round mutation to heal
          // away, even though it's establishing THIS module's own post-__start baseline,
          // not a runtime round's transient state. `_clear()` then "heals" it back to its
          // PRE-init-mutation content — corrupting the very state `_clear()` is supposed to
          // restore TO (native repro: `let a=[1,2,3,4,5,6,7,8]; a.length=5` then a BARE
          // `_clear()` with no other call reads the array back as all 8 original elements,
          // not the 5 the top-level truncate left it at). Fix: sentinel $__heap_reset to 0
          // (below every real, unsigned pointer — the reserved low region already treats
          // <8 as null/invalid, so 0 is never a live object's own address) as the FIRST
          // instruction of `__start`'s body, before any of its own init code runs. Every
          // guard above is `offset < $__heap_reset`-shaped (or `>=` for __is_eph_bits, same
          // polarity), so while __start executes, EVERY offset — static-low or freshly
          // heap-allocated — reads as "not durable yet", and none of the four helpers logs
          // anything (correct: __start has no prior round to protect against). The existing
          // end-of-body `capture` above restores the TRUE semantics — $__heap_reset becomes
          // the real post-init watermark — the instant __start finishes, unchanged for
          // every caller after that point.
          startFn.splice(findBodyStart(startFn), 0, ['global.set', '$__heap_reset', ['i32.const', 0]])
          }
        }
      }
      // __dyn_props reset: __clear rewinds the bump arena, but __dyn_props /
      // __dyn_get_cache_off / __dyn_get_cache_props (module/collection.js) cache
      // pointers/offsets INTO that arena across calls — a warm compile-clear-
      // compile loop (self-compile kernel: one instance, `_clear()` between compiles)
      // needs them reset too, or a later compile can read a dangling pointer or,
      // worse, alias a stale cached OFFSET onto a freshly-reused arena address
      // (an ABA hazard, not just a dangling one). Only patched in when __dyn_set
      // (the sole writer of __dyn_props) actually SURVIVED reachability pruning
      // (line ~616, just above) — those globals are declared unconditionally
      // whenever the collection module loads, so gating on mere declaration
      // (`ctx.scope.globals.has`) would inject a dead `global.set $__dyn_props`
      // into every such program, wasting bytes and leaking the __dyn_get_cache_*
      // names into WAT text that never otherwise mentions dynamic props (tripping
      // coarse `!/__dyn_get/.test(wat)`-style assertions — see test/closures.js).
      // Both blocks below extend the SAME `__clear` body — accumulate into one
      // shared list and rebuild once, so whichever runs second doesn't clobber the
      // other's addition (a program can need both: dyn-props AND durable-growth
      // relocation both reach here independent of each other).
      const resets = []
      if (ctx.core.includes.has('__dyn_set')) {
        if (ctx.scope.globals.has('__dyn_props')) resets.push(`(global.set $__dyn_props (f64.const 0))`)
        // The membership filter mirrors the table: emptying __dyn_props makes every
        // set bit a stale false-positive — safe, but a warm compile-clear loop would
        // saturate the filter and erode its skip rate. Reset them together.
        if (ctx.scope.globals.has('__dyn_props_filter')) resets.push(`(global.set $__dyn_props_filter (i64.const 0))`)
        if (ctx.scope.globals.has('__dyn_get_cache_off')) resets.push(`(global.set $__dyn_get_cache_off (i32.const -1))`)
        if (ctx.scope.globals.has('__dyn_get_cache_props')) resets.push(`(global.set $__dyn_get_cache_props (f64.const 0))`)
      }
      // for-in enum cache (core.js __hash_keys_ro / object.js ro-enumeration):
      // the cache keys a boxed array by table offset — both live in the arena
      // __clear rewinds, so a later round could re-issue the cached offset to a
      // NEW table and false-hit onto reclaimed memory (same ABA hazard as
      // __dyn_get_cache_off above). Gated on enumcConsumed, not reachability:
      // the OBJECT-arm fill sites are inline IR (no named helper to count).
      if (ctx.runtime.enumcConsumed)
        resets.push(`(global.set $__enumc_off (i32.const 0))`)
      // Durable relocation heal (collection.js's durableFwdLogIR / core.js's
      // __durable_fwd_log/__durable_fwd_heal): only reachable when some growable
      // ARRAY/HASH/SET/MAP relocation site actually logged a durable→ephemeral
      // forward this build — see durableFwdLogIR's header comment for the full
      // rationale. Must run before the next round can allocate over the logged
      // ephemeral targets, so it belongs in `__clear` alongside the arena rewind
      // (order vs the rewind itself doesn't matter — `_clear` never zeroes memory,
      // only moves the bump pointer — but keeping it grouped with the other resets
      // reads as "finish with this round's bookkeeping, then reclaim its arena").
      if (ctx.core.includes.has('__durable_fwd_log')) {
        // __durable_fwd_heal is called ONLY from this injected `__clear` text — it has
        // no OTHER call site for reachableStdlib (line ~582, already run) to have found
        // it through, so (unlike __durable_fwd_log itself, whose deps() edges at every
        // grow/shift call site make it self-compile-robust — see test/self-compile-includes.js)
        // it needs an explicit include here, mirroring the `__alloc`/`__alloc_hdr`/
        // `__clear` late-add just above. `inc()`, not a raw `ctx.core.includes.add()`:
        // the former is what test/self-compile-includes.js's source-scan recognizes as an
        // explicit (self-compile-safe) edge. No further resolveIncludes() needed:
        // __durable_fwd_heal's body calls nothing else (raw i32 loads/stores + global
        // get/set only).
        inc('__durable_fwd_heal')
        resets.push(`(call $__durable_fwd_heal)`)
      }
      // Durable ARRAY element-data heal (module/collection.js's durableArrSnapIR/
      // durableArrSnapNode, core.js's __durable_arr_snap/__durable_arr_heal — the
      // per-array-element sibling of the header-only fwd heal above; see either
      // helper's doc comment for the full rationale). Same explicit-include
      // reasoning as __durable_fwd_heal just above (its only call site is this
      // injected text).
      if (ctx.core.includes.has('__durable_arr_snap')) {
        inc('__durable_arr_heal')
        resets.push(`(call $__durable_arr_heal)`)
      }
      // Durable SLOT heal (core.js __durable_slot_log/__durable_slot_heal — the
      // entry/value sibling of the relocation heal above): every logged durable
      // collection slot written this round is healed (inserted entries zombied +
      // len decremented, overwritten values read undefined) before the arena
      // rewinds. Ordered AFTER the fwd heal: a grown-then-healed table's len must
      // already be its restored pre-grow value when the zombie decrements land.
      // Same explicit-include pattern (its ONLY call site is this injected text).
      if (ctx.core.includes.has('__durable_slot_log')) {
        inc('__durable_slot_heal')
        resets.push(`(call $__durable_slot_heal)`)
      }
      // Global-snapshot restores (see the sweep above) join the same rebuilt body.
      // Order is free — restores touch only globals + the durable slab, which the
      // rewind never moves — but bookkeeping-then-rewind-then-restore reads naturally.
      if (resets.length || globalRestores.length) ctx.core.stdlib['__clear'] = `(func $__clear
          (global.set $__heap (global.get $__heap_reset))
          ${[...resets, ...globalRestores].join('\n          ')})`
    }
    // Initial pages must cover the static data segment (it loads at instantiation), not
    // just the default 1 — otherwise a module whose constants exceed 64 KiB emits a data
    // segment that overflows its own memory. The heap grows past this on demand via
    // __memgrow. (Shared memory loads literals via memory.init into allocated space, so
    // its initial size isn't pinned by the data length.)
    const dataPages = ctx.memory.shared ? 0 : Math.ceil(dataLen() / 65536)
    const pages = Math.max(ctx.memory.pages || 1, dataPages)
    const max = ctx.memory.max || 0   // 0 = no maximum (unbounded growth)
    // Truly-shared memory (opts.sharedMemory) declares the `shared` memtype —
    // the spec requires an explicit max there (default: the wasm32 page ceiling).
    // Plain imported memory (opts.importMemory / a Memory-valued opts.memory)
    // stays non-shared, or a host passing an ordinary Memory could never link.
    if (ctx.memory.shared) sec.imports.push(['import', '"env"', '"memory"',
      ctx.memory.atomic ? ['memory', pages, max || 65536, 'shared']
        : max ? ['memory', pages, max] : ['memory', pages]])
    else sec.memory.push(max ? ['memory', ['export', '"memory"'], pages, max] : ['memory', ['export', '"memory"'], pages])
    if (needsAlloc && ctx.transform.alloc !== false && ctx.core._allocRawFuncs)
      sec.funcs.push(...ctx.core._allocRawFuncs.map(parseTemplate))
  }

  const stdlibStr = (name) => {
    const v = ctx.core.stdlib[name]
    return typeof v === 'function' ? v() : v
  }
  ctx.core.extImports ??= new Set()
  for (const name of Object.keys(ctx.core.stdlib)) {
    if (name.startsWith('__ext_') && ctx.core.includes.has(name)) {
      const parsed = parseTemplate(stdlibStr(name))
      sec.extStdlib.push(parsed[0] === "module" ? parsed[1] : parsed)
      ctx.core.extImports.add(name)
      ctx.core.includes.delete(name)
    }
  }
  for (const n of ctx.core.includes) if (!ctx.core.stdlib[n]) err(`internal: stdlib '${n}' was requested but never registered (this is a jz bug — feature pulled in something it can't deliver)`)
  sec.stdlib.push(...[...ctx.core.includes].map(n => instrumentHelperCounter(n, parseTemplate(stdlibStr(n)))))
}

export function syncImports(sec) {
  for (const imp of ctx.module.imports) {
    if (!sec.imports.some(i => i[1] === imp[1] && i[2] === imp[2])) sec.imports.push(imp)
  }
}
