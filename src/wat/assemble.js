/**
 * Module assembly — WAT section construction, optimization, and finalization.
 *
 * # Stage contract
 *   IN:  per-function WAT IR (from emit), ctx state (includes, scope, closure, etc.)
 *   OUT: assembled module sections via the `sec` object, mutated in place.
 *
 * Extracted from compile.js to separate "per-function compilation" from
 * "module assembly" concerns. All functions receive `sec` (the named-slots
 * section accumulator) and read/write ctx state as needed.
 *
 * @module assemble
 */

import parseWat from 'watr/parse'
import { ctx, inc, resolveIncludes, err, PTR, LAYOUT, HEAP, declGlobal, assertCtxInvariants } from '../ctx.js'
import { i64Hex } from '../../layout.js'
import { dataAlign, dataPush, dataLen, dataString, dataReset, strPoolLen, strPoolString, pushStaticSlots } from '../static-data.js'
import { assembleView } from '../session-views.js'

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
import { T, walkAst, some } from '../ast.js'
import { analyzeValTypes, analyzeBody, findMutations } from '../compile/analyze.js'
import { enterActiveFunction, restoreActiveFunction } from '../compile/active-function.js'
import { enterPreparedFunction, functionPlanOf, publishPreparedFunctionPlan, retireFunctionPlan } from '../compile/function-plan.js'
import { mintRepresentationPlan, representationProgramHasBigint } from '../compile/representation-plan.js'
import { mintTypedStoragePlan } from '../compile/typed-storage-plan.js'
import { VAL } from '../reps.js'
import {
  optimizeFunc, collectVolatileGlobals, collectReachableGlobalWrites, collectReachableMemoryWrites,
  hoistGlobalPtrOffset, hoistLoopGlobalPtrOffset, hoistStableGlobalConstLoads, guardMaskedVectorSuffix, hasIROp, stablePtrGlobalNames,
  hoistConstantPool, specializeMkptr, arenaRewindModule, buildPureFuncMap, inlinePureFnsInFn,
} from '../optimize/index.js'
import { emit, emitVoid } from '../compile/emit.js'
import { mkPtrIR, MAX_CLOSURE_ARITY, MEM_OPS, findBodyStart, extractF64Bits, asF64 } from '../ir.js'
import { staticArrayPtr } from '../../module/array.js'
import { installHelperCounters, instrumentHelperCounter } from '../helper-counters.js'

// memory[HEAP.PTR_ADDR] holds the heap pointer only for shared memory (wasm globals are
// per-instance — see module/core.js comment). Non-shared memory uses $__heap.
const heapUsesMem = () => assembleView().memory.shared

const heapGetIR = () => heapUsesMem()
  ? ['i32.load', ['i32.const', HEAP.PTR_ADDR]]
  : ['global.get', '$__heap']

const heapSetIR = value => heapUsesMem()
  ? ['i32.store', ['i32.const', HEAP.PTR_ADDR], value]
  : ['global.set', '$__heap', value]

const ARENA_SAFE_CALLS = new Set([
  '$__alloc', '$__alloc_hdr', '$__alloc_hdr_n', '$__mkptr',
  '$__ptr_offset', '$__ptr_type', '$__ptr_aux',
  '$__len', '$__cap', '$__typed_shift', '$__typed_data',
])

function applyArenaRewind(func, fn, safeCallees) {
  if (ctx.transform.optimize?.arenaRewind === false) return false
  if (func.raw || func.sig.params.length !== 0 || func.sig.results.length !== 1) return false
  if (func.sig.ptrKind != null) return false
  if (func.sig.results[0] === 'f64' && func.valResult !== VAL.NUMBER) return false
  if (func.sig.results[0] !== 'f64' && func.sig.results[0] !== 'i32') return false

  const bodyStart = findBodyStart(fn)
  let hasAlloc = false
  let unsafe = false
  const scan = node => {
    if (unsafe) return false
    const op = node[0]
    if (op === 'global.set' || op === 'return_call' || op === 'call_indirect' || op === 'call_ref') { unsafe = true; return false }
    if (op === 'call') {
      const name = node[1]
      if (name === '$__alloc' || name === '$__alloc_hdr' || name === '$__alloc_hdr_n') hasAlloc = true
      if (!(safeCallees ?? ARENA_SAFE_CALLS).has(name)) { unsafe = true; return false }
    }
  }
  for (let i = bodyStart; i < fn.length; i++) walkAst(fn[i], { enter: scan })
  if (unsafe || !hasAlloc) return false

  let id = 0
  const hasLocal = name => fn.some(n => Array.isArray(n) && n[0] === 'local' && n[1] === name)
  while (hasLocal(`$${T}heap_save${id}`) || hasLocal(`$${T}arena_ret${id}`)) id++
  const save = `$${T}heap_save${id}`
  const ret = `$${T}arena_ret${id}`
  const restore = () => heapSetIR(['local.get', save])
  const resultType = func.sig.results[0]

  // Rewrite the return's VALUE, not the return: `return` is stack-polymorphic
  // (never falls through), so it validates in statement AND value position alike.
  // The old form — a value-typed block AROUND the return — reified `(result T)`
  // even where the return was a statement, leaving a phantom value on the stack
  // of a void enclosing frame (a `return` inside try_table failed validation:
  // "expected 0 elements on the stack for fallthru, found 1").
  const rewriteReturns = node => {
    if (!Array.isArray(node)) return node
    if (node[0] === 'return' && node.length > 1) {
      return ['return', ['block',
        ['result', resultType],
        ['local.set', ret, node[1]],
        restore(),
        ['local.get', ret]]]
    }
    for (let i = 1; i < node.length; i++) node[i] = rewriteReturns(node[i])
    return node
  }

  const endsWithReturn = fn.at(-1)?.[0] === 'return' || fn.at(-1)?.[0] === 'return_call'
  for (let i = bodyStart; i < fn.length; i++) fn[i] = rewriteReturns(fn[i])
  const newBodyStart = findBodyStart(fn)
  fn.splice(newBodyStart, 0,
    ['local', save, 'i32'],
    ['local', ret, resultType],
    ['local.set', save, heapGetIR()])
  if (!endsWithReturn) {
    const last = fn.pop()
    fn.push(['local.set', ret, last], restore(), ['local.get', ret])
  }
  return true
}

const normalizeEmittedIR = ir => !ir?.length ? [] : Array.isArray(ir[0]) ? ir : [ir]

// Reserve prepare-generated T-sentinel locals so emit-time temp names cannot
// collide with for-of/destructure scratch in the synthetic start frame.
function seedStartGeneratedLocals(body) {
  for (const [name, type] of analyzeBody(body).locals)
    if (name.includes(T) && !ctx.func.locals.has(name)) ctx.func.locals.set(name, type)
}

/** Publish the synthetic module-init FunctionPlan before any start IR emits. */
function analyzeStartForEmit(ast) {
  const start = { name: '__start', body: ast }
  const previousFrame = enterActiveFunction(ctx, {
    sig: { name: '__start', params: [], results: [] },
    body: ast,
    moduleScope: true,
  })
  try {
    analyzeValTypes(ast)
    // ES per-iteration module-loop bindings captured by closures are genuine
    // __start locals. The mutated subset needs the same shared heap cell as a
    // function-loop capture; ordinary module globals must never be boxed here.
    if (ctx.scope.moduleLoopCaptured.size) {
      const mutated = new Set()
      findMutations(ast, ctx.scope.moduleLoopCaptured, mutated)
      if (ctx.module.moduleInits)
        for (const mi of ctx.module.moduleInits)
          findMutations(mi, ctx.scope.moduleLoopCaptured, mutated)
      for (const name of mutated)
        if (!ctx.func.boxed.has(name)) ctx.func.boxed.set(name, `${T}cell_${name}`)
    }
    // Build the cumulative module-init fact state in source order. BindingIds
    // make later-unit facts disjoint from earlier locals; the byte-identity
    // gate pins that planning all units first does not change prior emission.
    if (ctx.module.moduleInits) for (const mi of ctx.module.moduleInits) {
      analyzeValTypes(mi)
      seedStartGeneratedLocals(mi)
    }
    seedStartGeneratedLocals(ast)
    mintTypedStoragePlan(ctx, start, ctx.func.current, ast, ctx.func.localReps, {
      extraBodies: ctx.module.moduleInits || [],
    })
    if (representationProgramHasBigint(ctx))
      mintRepresentationPlan(ctx, start, ctx.func.current, ast, ctx.func.localReps)
    publishPreparedFunctionPlan(ctx, start, ctx.func)
    ctx.plans.start = start
    return start
  } finally {
    restoreActiveFunction(ctx, previousFrame)
  }
}

export function buildStartFn(ast, sec, closureFuncs, compilePendingClosures) {
  const start = analyzeStartForEmit(ast)
  const startPlan = functionPlanOf(ctx, start)
  const outerFrame = enterPreparedFunction(ctx, startPlan)
  try {
  const moduleInits = []
  if (ctx.module.moduleInits) for (const mi of ctx.module.moduleInits) {
    ctx.func.repsFrozen = true
    assertCtxInvariants('pre-emit')
    moduleInits.push(...normalizeEmittedIR(emit(mi)))
  }
  // __start has no result: emit the top-level program in void context so a
  // single bare expression cannot leave a value on the start stack.
  ctx.func.repsFrozen = true
  assertCtxInvariants('pre-emit')
  const init = emitVoid(ast)
  ctx.func.repsFrozen = false
  ctx.func.atModuleScope = false

  // Module-scope object literals can create closure bodies while `emit(ast)`
  // runs. Those late closures may pull in stdlib helpers (notably JSON.parse)
  // that affect __start setup, so flush them before deciding which runtime
  // tables __start must initialize. Closure plans transfer their complete
  // prepared records, so no selected-field snapshot is needed here.
  const beforeLateClosures = closureFuncs.length
  compilePendingClosures()

  const boxInit = []
  if (ctx.schema.autoBox) {
    const bt = `${T}box`
    ctx.func.locals.set(bt, 'i32')
    for (const [name, { schemaId, schema }] of ctx.schema.autoBox) {
      inc('__alloc_hdr', '__mkptr')
      boxInit.push(
        ['local.set', `$${bt}`, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', Math.max(1, schema.length)]]],
        ['f64.store', ['local.get', `$${bt}`],
          ctx.funcs.names.has(name) ? ['f64.const', 0] : ['global.get', `$${name}`]],
        ...schema.slice(1).map((_, i) =>
          ['f64.store', ['i32.add', ['local.get', `$${bt}`], ['i32.const', (i + 1) * 8]], ['f64.const', 0]]),
        ['global.set', `$${name}`, mkPtrIR(PTR.OBJECT, schemaId, ['local.get', `$${bt}`])])
    }
  }

  const schemaInit = []
  const hasJpObj = ctx.core.includes.has('__jp_obj') || ctx.core.includes.has('__jp')
  const hasStringify = ctx.core.includes.has('__stringify')
  // Empty object literals register a `[]` schema so their schemaId indexes a
  // valid list entry. But __dyn_get already guards `$__schema_tbl == 0`, so a
  // table holding only empty schemas is pure dead weight there. __json_obj has
  // no such guard — it must read the table whenever stringify is in play.
  const tblConsumed = hasStringify ||
    // Inline readers (object.js enumeration scaffolds) — no named helper to count.
    ctx.runtime.schemaTblConsumed ||
    ctx.core.includes.has('__obj_clone') ||
    ctx.core.includes.has('__dyn_get') ||
    ctx.core.includes.has('__dyn_get_t') ||
    ctx.core.includes.has('__dyn_get_t_h') ||
    ctx.core.includes.has('__dyn_get_expr_t_h') ||
    ctx.core.includes.has('__dyn_get_any') ||
    ctx.core.includes.has('__dyn_get_any_t') ||
    ctx.core.includes.has('__dyn_get_any_t_h') ||
    ctx.core.includes.has('__dyn_get_expr') ||
    ctx.core.includes.has('__dyn_get_expr_t') ||
    ctx.core.includes.has('__dyn_get_or') ||
    // A string runtime-key WRITE `o[k]=v` whose `k` matches a schema field must
    // mirror the value into the fixed schema slot (buildObjectSchemaSetArm), or a
    // later static `o.x` read returns the stale slot. That mirror is gated on
    // `$__schema_tbl != 0`, so a write-only module (no `__dyn_get*`) must still
    // build the table. (needsSchemaTbl below skips it when every schema is empty.)
    ctx.core.includes.has('__dyn_set') ||
    // Heap-kind registry Slice 2 (.work/research.md §Heap-kind registry):
    // __region_copy_rec's OBJECT arm (layout-kinds.js regionArmObject) derives
    // slot COUNT from `$__schema_tbl[sid]` — same `(if $__schema_tbl != 0 ...)`
    // guard every other reader here uses, but if the table were never actually
    // BUILT (this OR-chain not tripped), that guard reads 0 slots for every
    // real OBJECT: an ephemeral relocation then allocates the WRONG (1-slot,
    // via __alloc_hdr's own `max(n,1)`) block and copies zero of its real
    // fields — __alloc_hdr never zero-fills payload, so the "extra" slots a
    // wider real schema needed sit as bump-allocator GARBAGE, later read back
    // as a bogus NaN-boxed pointer and dereferenced — confirmed live (kernel-
    // oracle String()-with-ambiguous-bool-merge repro, region-live only,
    // `memory access out of bounds`, root-caused to exactly this gap).
    ctx.core.includes.has('__region_copy_rec')
  const needsSchemaTbl = (ctx.schema.list.length && tblConsumed &&
    (hasStringify || ctx.schema.list.some(s => s.length > 0))) ||
    hasJpObj
  if (needsSchemaTbl) {
    const nSchemas = ctx.schema.list.length
    const runtimeReserve = hasJpObj ? 256 : 0
    // Pre-eval tier 2: the schema NAME TABLE is compile-time data — every key is a
    // static string literal, every keys-array a constant, the table an array of
    // constant boxed pointers. Lay it out in the data segment (staticArrayPtr per
    // schema + one slot run for the table incl. a zeroed runtime reserve) and bake
    // __schema_tbl/__schema_next as GLOBAL INITS: zero init code, and the reserve
    // (JSON.parse-registered runtime schemas) lives in writable data the globals
    // sweep correctly rewinds at _clear (runtime schemas are round state).
    //
    // `tblConsumed` (above) is a whole-program "might some dynamic dispatch need
    // ANY schema's key array" decision — coarser than what any later pass proves.
    // A schema minted only because an opaque `.length`/property-dispatch site was
    // VISITED here (e.g. module/core.js's emitLengthAccess, before narrowing/
    // devirtualization resolve the receiver's real type) can end up with NO
    // surviving reader at all once optimizeModule/treeshake finish — every key
    // string this loop interns for such a schema would otherwise leak into the
    // data segment unconditionally. Record the byte span this whole table
    // construction owns (every nested key array, chained off ONE `__schema_tbl`
    // global) so stripDeadInternedSpans can reclaim it from the tail once real
    // reachability is known. Skipped under `runtimeReserve`: JSON.parse can write
    // a NEW schema pointer into a reserved slot past `nSchemas` at RUNTIME, a
    // write this static liveness scan can't see — reclaiming there could orphan
    // a slot a live runtime write still depends on.
    const schemaDataStart = dataLen()
    let staticBits = ctx.memory.shared ? null : []
    if (staticBits) for (const keys of ctx.schema.list) {
      const bits = keys.map(k => extractF64Bits(asF64(emit(['str', String(k)]))))
      if (bits.some(b => b == null)) { staticBits = null; break }
      staticBits.push(extractF64Bits(staticArrayPtr(bits)))
    }
    if (staticBits) {
      const tblOff = pushStaticSlots([...staticBits, ...Array(runtimeReserve).fill('0x0000000000000000')])
      // The consumers declGlobal '__schema_tbl' lazily at TEMPLATE EXPANSION
      // (pullStdlib) — AFTER this runs. Declare it here so the static offset
      // lands as the initializer instead of silently missing a not-yet-declared
      // global (which then defaulted 0 and the `$__schema_tbl == 0` guards
      // disabled the whole schema arm — for-in enumerated zero keys).
      if (!ctx.scope.globals.has('__schema_tbl')) declGlobal('__schema_tbl', 'i32')
      const tblG = ctx.scope.globals.get('__schema_tbl')
      if (tblG) tblG.init = tblOff
      // Raw-i32 global init pointing into static data: stripStaticDataPrefix
      // patches BOXED slots via staticPtrSlots, but a global's declared init
      // needs its own shift (same as __internBase's bespoke re-declare).
      ;(ctx.runtime.staticI32GlobalInits ??= []).push('__schema_tbl')
      if (!runtimeReserve && dataLen() > schemaDataStart)
        ctx.runtime.reclaimSpans.push({ global: '__schema_tbl', start: schemaDataStart, end: dataLen() })
      if (runtimeReserve) {
        if (!ctx.scope.globals.has('__schema_next')) declGlobal('__schema_next', 'i32')
        const nextG = ctx.scope.globals.get('__schema_next')
        if (nextG) nextG.init = nSchemas
      }
    } else {
      const stbl = `${T}stbl`
      const sarr = `${T}sarr`
      ctx.func.locals.set(stbl, 'i32')
      ctx.func.locals.set(sarr, 'i32')
      inc('__alloc', '__alloc_hdr', '__mkptr')
      schemaInit.push(
        ['local.set', `$${stbl}`, ['call', '$__alloc', ['i32.const', (nSchemas + runtimeReserve) * 8]]],
        ['global.set', '$__schema_tbl', ['local.get', `$${stbl}`]])
      if (runtimeReserve) {
        schemaInit.push(['global.set', '$__schema_next', ['i32.const', nSchemas]])
      }
      for (let s = 0; s < nSchemas; s++) {
        const keys = ctx.schema.list[s]
        const n = keys.length
        schemaInit.push(
          ['local.set', `$${sarr}`, ['call', '$__alloc_hdr', ['i32.const', n], ['i32.const', n]]])
        for (let k = 0; k < n; k++)
          schemaInit.push(
            ['f64.store', ['i32.add', ['local.get', `$${sarr}`], ['i32.const', k * 8]],
              emit(['str', String(keys[k])])])
        schemaInit.push(
          ['f64.store', ['i32.add', ['local.get', `$${stbl}`], ['i32.const', s * 8]],
            mkPtrIR(PTR.ARRAY, 0, ['local.get', `$${sarr}`])])
      }
    }
  }

  const strPoolInit = []
  if (strPoolLen()) {
    const total = strPoolLen()
    strPoolInit.push(
      ['global.set', '$__strBase', ['call', '$__alloc', ['i32.const', total]]],
      ['memory.init', '$__strPool', ['global.get', '$__strBase'], ['i32.const', 0], ['i32.const', total]],
      ['data.drop', '$__strPool'],
    )
  }

  const typeofInit = []
  if (ctx.runtime.typeofStrs) {
    for (const s of ctx.runtime.typeofStrs)
      typeofInit.push(['global.set', `$__tof_${s}`, emit(['str', s])])
  }

  // Region arena CLOSURE relocation side table (.work/research.md §Region
  // arena, the front-boundary's own forcing case) — funcIdx → {env slot
  // count, cell-mode bitmask}, sourced from ctx.closure.envMeta (module/
  // function.js's ctx.closure.make captures both facts at its own
  // env-allocation site, so this is a straight materialization, not a
  // re-derivation). Gated on `__region_exit` — NOT `__region_copy_rec`
  // itself (needsSchemaTbl's OBJECT gate just above reads that name, but
  // pullStdlib's resolveIncludes() — which expands `inc()`'d names into
  // their full transitive-dep closure — runs AFTER buildStartFn; every
  // OTHER condition in that OR-chain is a DIRECTLY-inc()'d name so it stays
  // accurate there, but `__region_copy_rec` is exclusively a DEP of
  // `__region_exit`, never inc()'d on its own, so reading it HERE would
  // always be false). `__region_exit` is `inc()`'d synchronously the moment
  // source calls it (ctx.core.emit['__region_exit'], module/core.js) — by
  // buildStartFn, `emitVoid(ast)` has already run, so this reads accurately.
  // Every other build (the default dist, native compiles, any program that
  // never reaches a region boundary) pays zero bytes for this.
  // By the time we reach here every closure literal in the program has been
  // through ctx.closure.make (the two compilePendingClosures() drains above
  // — line ~246 and the late-closures one after this block — only compile
  // closure BODIES; a closure's ctx.closure.table/envMeta entry is minted
  // synchronously when its LITERAL is emitted, which for a top-level
  // program has always already happened by this point in buildStartFn).
  //
  // Runtime alloc+store sequence (mirrors schemaInit's own dynamic-fallback
  // shape just above, NOT pushStaticSlots's static-data-segment path):
  // pushStaticSlots's per-8-byte-slot pointer-relocation marking
  // (staticPtrSlots, keyed on the NaN-prefix bit pattern) is for BOXED
  // values — reusing it for these plain integers risks a false-positive
  // match purely by chance on a cellMask's bit pattern. A future slice could
  // add a dedicated raw-i32 static-segment appender (this table has no
  // runtime-computed content unlike schema keys, so it could ALWAYS take
  // the fast path schemaInit only gets to when every key folds statically)
  // — not done here; this is the same O(n) instruction cost schemaInit's
  // own fallback already accepts, paid only by region-live builds.
  const closureEnvInit = []
  if (ctx.core.includes.has('__region_exit') && ctx.closure.table?.length) {
    const nClosures = ctx.closure.table.length
    const lenT = `${T}cenvlen`
    const maskT = `${T}cenvmask`
    ctx.func.locals.set(lenT, 'i32')
    ctx.func.locals.set(maskT, 'i32')
    inc('__alloc')
    if (!ctx.scope.globals.has('__closure_env_len')) declGlobal('__closure_env_len', 'i32')
    if (!ctx.scope.globals.has('__closure_env_mask')) declGlobal('__closure_env_mask', 'i32')
    closureEnvInit.push(
      ['local.set', `$${lenT}`, ['call', '$__alloc', ['i32.const', nClosures * 4]]],
      ['global.set', '$__closure_env_len', ['local.get', `$${lenT}`]],
      ['local.set', `$${maskT}`, ['call', '$__alloc', ['i32.const', nClosures * 4]]],
      ['global.set', '$__closure_env_mask', ['local.get', `$${maskT}`]],
    )
    for (let i = 0; i < nClosures; i++) {
      const meta = ctx.closure.envMeta[i] || { len: 0, cellMask: 0 }
      closureEnvInit.push(
        ['i32.store', ['i32.add', ['local.get', `$${lenT}`], ['i32.const', i * 4]], ['i32.const', meta.len]],
        ['i32.store', ['i32.add', ['local.get', `$${maskT}`], ['i32.const', i * 4]], ['i32.const', meta.cellMask]],
      )
    }
  }

  const wasiTimers = ctx.features.timers && ctx.transform.targetProfile.timerModel === 'blocking'
  if (moduleInits.length || init?.length || boxInit.length || schemaInit.length || typeofInit.length || strPoolInit.length || closureEnvInit.length || wasiTimers) {
    const initIR = normalizeEmittedIR(init)
    const startFn = ['func', '$__start']
    for (const [l, t] of ctx.func.locals) startFn.push(['local', `$${l}`, t])
    startFn.push(...strPoolInit, ...typeofInit, ...boxInit, ...schemaInit, ...closureEnvInit,
      ...(wasiTimers ? [['call', '$__timer_init']] : []),
      ...moduleInits, ...initIR,
      ...(ctx.features.blockingTimers ? [['call', '$__timer_loop']] : []),
    )
    sec.start.push(startFn, ['start', '$__start'])
  }

  compilePendingClosures()
  if (closureFuncs.length > beforeLateClosures)
    sec.funcs.unshift(...closureFuncs.slice(beforeLateClosures))
  } finally {
    retireFunctionPlan(ctx, start, startPlan)
    restoreActiveFunction(ctx, outerFrame)
  }
}

/**
 * Hoist constant global initializers out of `__start` into immutable inline decls.
 *
 * A top-level `const x = <constant>` for a non-numeric value (atom `true`/`null`/
 * `undefined`/`NaN`, an SSO or static-string NaN-box, a folded pointer) emits a
 * `(global.set $x (f64.const …))` into `__start`, because only *numeric* consts are
 * folded ahead of emit. But the value is a compile-time constant, so it belongs in
 * the decl itself — `(global $x f64 (f64.const …))` — exactly like the numeric path.
 * That drops the store, and when it empties `__start` the start function and its
 * directive go too. Gated to single-assignment user `const`s so we never freeze a
 * binding something else writes.
 */
export function hoistConstGlobalInits(sec) {
  const startFn = sec.start.find(n => Array.isArray(n) && n[0] === 'func' && n[1] === '$__start')
  if (!startFn) return
  const writes = new Map()
  const scan = (node) => {
    if (node[0] === 'global.set' && typeof node[1] === 'string') writes.set(node[1], (writes.get(node[1]) || 0) + 1)
  }
  for (const arr of [sec.funcs, sec.stdlib, sec.start]) for (const fn of arr) walkAst(fn, { enter: scan })
  for (let i = startFn.length - 1; i >= findBodyStart(startFn); i--) {
    const stmt = startFn[i]
    if (!Array.isArray(stmt) || stmt[0] !== 'global.set' || writes.get(stmt[1]) !== 1) continue
    const name = typeof stmt[1] === 'string' && stmt[1][0] === '$' ? stmt[1].slice(1) : null
    const g = name && ctx.scope.globals.get(name)
    const c = stmt[2]
    if (!g || !g.mut || !ctx.scope.consts?.has(name) || !ctx.scope.userGlobals?.has(name)) continue
    if (!Array.isArray(c) || c[0] !== `${g.type}.const`) continue
    ctx.scope.globals.set(name, { ...g, mut: false, init: c[1] })
    startFn.splice(i, 1)
  }
  // Hoisting can empty `__start`. The O2 watr pass prunes a bodyless start, but at
  // O0/O1 nothing else does — drop it (func + directive) here so a const-only module
  // carries no start at all. A body reduced to ONLY the `__heap_reset` capture
  // (injected before this hoist ran) counts as empty too: with every init store
  // folded away, nothing allocated, so the capture would store exactly the
  // data-end seed `__heap_reset` already declares — tier-2 static-tree modules
  // ship with no start section at all.
  const bs = findBodyStart(startFn)
  const captureOnly = startFn.length - bs === 1 &&
    Array.isArray(startFn[bs]) && startFn[bs][0] === 'global.set' && startFn[bs][1] === '$__heap_reset'
  if (bs >= startFn.length || captureOnly)
    for (let j = sec.start.length - 1; j >= 0; j--)
      if (Array.isArray(sec.start[j]) && sec.start[j][1] === '$__start') sec.start.splice(j, 1)
}

// Closure funcs section — body dedup, then table finalize + ABI shrink.
// Moved to assemble/closure-table.js (pipeline-minimality split); re-exported
// here so every existing `from '../wat/assemble.js'` import keeps working.
export { dedupClosureBodies, finalizeClosureTable } from './assemble/closure-table.js'

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

/**
 * Phase: whole-module + per-function optimization passes.
 */

// WAT display-name cleanup (stripLocalRenameSuffixes). Moved to
// assemble/rename-locals.js (pipeline-minimality split); re-exported here so
// every existing `from '../wat/assemble.js'` import keeps working.
export { stripLocalRenameSuffixes } from './assemble/rename-locals.js'

export function optimizeModule(sec, profiler, regionHooks) {
  const t = profiler?.time ? (name, fn) => profiler.time(`optMod:${name}`, fn) : (_, fn) => fn()
  const cfg = ctx.transform.optimize
  if (!cfg || cfg.specializeMkptr !== false) t('specializeMkptr', () =>
    specializeMkptr([...sec.funcs, ...sec.stdlib, ...sec.start], wat => sec.stdlib.push(parseWat(wat)), parseWat, regionHooks))
  // (specializePtrBase and sortStrPoolByFreq deleted: byte-identical output with
  // both disabled across the bench + examples corpora AND the self-compile kernel at
  // every watr tier — watr's own inlining/offset folding subsumed them. ~350ms/corpus.)
  // (globalTypes backfill gone: declGlobal sets the type at declaration.)
  // Build global name→type map from ctx.scope.globalTypes (keys without $) for promoteGlobals
  const globalTypesMap = ctx.scope.globalTypes ? new Map([...ctx.scope.globalTypes].map(([k, v]) => [`$${k}`, v])) : null
  const allFuncs = [...sec.funcs, ...sec.stdlib, ...sec.start]
  const volatileGlobals = t('volatileGlobals', () => collectVolatileGlobals(allFuncs))
  const reachableWrites = t('reachableWrites', () => collectReachableGlobalWrites(allFuncs))
  // Offset-hoist BEFORE promoteGlobals (inside optimizeFunc): value-promoting a
  // stable-pointee global to a $_pg local would destroy the global.get pattern
  // this pass matches, reverting rfft/diffusion to per-iteration resolves. After
  // the hoist, the surviving global.get count is 1 (the entry snap) — naturally
  // below promoteGlobals' threshold, so the two passes compose either way.
  if (!cfg || cfg.hoistGlobalPtrOffset !== false) t('hoistGlobalPtr', () => {
    const stable = stablePtrGlobalNames()
    if (stable.size) for (const s of allFuncs) hoistGlobalPtrOffset(s, stable, reachableWrites)
  })
  // Per-loop complement: a function the whole-function pass above declined
  // (an unrelated call_indirect / write ANYWHERE in the function poisons
  // every global for it) may still have individual loops that are clean on
  // their own narrower scope — e.g. a char-scan loop inside a devirtualized
  // Pratt-loop trampoline that also inlines unrelated operator dispatch.
  if (!cfg || cfg.hoistLoopGlobalPtrOffset !== false) t('hoistLoopGlobalPtr', () => {
    const stable = stablePtrGlobalNames()
    if (stable.size) for (const s of allFuncs) hoistLoopGlobalPtrOffset(s, stable, reachableWrites)
  })
  // Build the pure-function map for tryPerPixelColor's Phase-2 lane inline BEFORE the
  // per-function vectorizer runs — the vectorizer is jz lowering (pre-watr), so it needs
  // its inline candidates now, not after watr. Bodies are still clean scalar here.
  if (cfg && cfg.vectorizeLaneLocal === true) {
    const pureFuncMap = buildPureFuncMap(allFuncs)
    if (pureFuncMap.size) {
      cfg._pureFuncMap = pureFuncMap
      // jz semantic inlining (LOWERING) — inline pure user functions into their call sites BEFORE the
      // vectorizer, so it sees the callee arithmetic (the pow/decode a colour helper hides). jz owns
      // this because the decision is purity+type-driven; watr keeps only mechanical residual inlining.
      // Gated to SINGLE-CALLER pure functions: inlining the sole call site is a guaranteed win (removes
      // the call AND the now-dead function, zero size cost). Multi-caller small helpers stay watr's
      // size-gated mechanical job at the speed tier — jz doesn't duplicate that.
      // SMALL single-caller only: inlining a small pure helper (a `spow`/`decode` colour term) into its
      // sole caller exposes its arithmetic to the vectorizer at zero size cost. Inlining a LARGE function
      // (a whole conversion loop) is neutral-to-harmful (worse layout/regalloc, measured on colorpq), and
      // watr's own inlineOnce already handles the mechanical single-caller case — so jz stays out of it.
      // OPT-IN (default off): correct + fuzz-clean, but inlining across the corpus changes a lot of
      // pinned output-shape assertions for no measured bench win (the current regressions are outer-strip/
      // widening recognition + watr wasm-opt-class, not inlining). Kept as the architectural home for
      // semantic inlining, enabled per-compile via `optimize.inlinePureFns: true`, until a real case pays.
      if (cfg.inlinePureFns === true) t('inlinePureFns', () => {
        const callCount = new Map()
        for (const s of allFuncs) walkAst(s, { enter: n => {
          if ((n[0] === 'call' || n[0] === 'return_call') && typeof n[1] === 'string') callCount.set(n[1], (callCount.get(n[1]) || 0) + 1)
        } })
        const nodeCount = (n) => { let c = 0; walkAst(n, { enter: () => { c++ } }); return c }
        const INLINE_MAX = 48
        const canInline = new Set([...pureFuncMap.keys()].filter(name =>
          callCount.get(name) === 1 && nodeCount(pureFuncMap.get(name)) <= INLINE_MAX))
        if (canInline.size) { const idRef = { next: 0 }; for (const s of allFuncs) inlinePureFnsInFn(s, pureFuncMap, idRef, canInline) }
      })
    }
  }
  // Candidate bodies for devirt arm inlining and block-narrowing
  // (devirtConstFnArrayCalls): the UNFILTERED name→fn map of const-fn-array
  // element bodies. Built here — the pass runs per-function inside optimizeFunc
  // and can't see sibling functions. No purity filter: the inliner enforces
  // straight-line shape itself, and an arm executes exactly when the original
  // call did, so side-effecting bodies substitute safely.
  if (ctx.scope.constFnArrays?.size) {
    const candNames = new Set()
    for (const list of ctx.scope.constFnArrays.values()) for (const c of list) candNames.add(`$${c.name}`)
    ctx.scope.dvArmFns = new Map(allFuncs.filter(f => Array.isArray(f) && candNames.has(f[1])).map(f => [f[1], f]))
  }
  t('optimizeFuncs', () => {
    let mark = null, batch = []
    for (let i = 0; i < allFuncs.length; i++) {
      if (regionHooks && mark == null) mark = regionHooks.mark()
      const s = allFuncs[i]
      optimizeFunc(s, cfg, globalTypesMap, volatileGlobals, reachableWrites)
      if (regionHooks) batch.push(s)
      if (regionHooks && (batch.length >= 16 || i === allFuncs.length - 1)) {
        ;[batch, ctx.scope, ctx.transform, ctx.types, ctx.schema, ctx.core.includes, ctx.runtime] =
          regionHooks.exit(mark, [batch, ctx.scope, ctx.transform, ctx.types, ctx.schema, ctx.core.includes, ctx.runtime])
        mark = null
        batch = []
      }
    }
  })
  if (!cfg || cfg.hoistGlobalConstLoads !== false || cfg.maskedSuffixGuard !== false) t('hoistGlobalConstLoads', () => {
    const wantLoads = cfg.hoistGlobalConstLoads !== false && !!ctx.scope.globalTypedLen?.size
    // The guarded form necessarily writes a declared v128 local. Keep scalar
    // programs on the old allocation-free path; only SIMD functions pay for
    // the DAG-safe deep opcode probe.
    const mayHaveMasks = cfg.maskedSuffixGuard !== false && allFuncs.some(fn =>
      fn.some(n => Array.isArray(n) && n[0] === 'local' && n[2] === 'v128'))
    const wantMasks = mayHaveMasks && hasIROp(allFuncs, 'v128.bitselect')
    if (!wantLoads && !wantMasks) return
    const memoryWrites = collectReachableMemoryWrites(allFuncs)
    for (const s of allFuncs) {
      if (wantLoads) hoistStableGlobalConstLoads(s, memoryWrites, reachableWrites)
      if (wantMasks) guardMaskedVectorSuffix(s, memoryWrites)
    }
  })
  // The lane vectorizer can inject f64x2 stdlib mirrors ($math.log_v, $math.cos2, …)
  // absent from the already-pulled+treeshaken module. Append any now-referenced mirror
  // body to sec.stdlib — the pre-watr analogue of index.js's post-watr appendLateStdlib.
  if (cfg && cfg.vectorizeLaneLocal === true) t('appendLateStdlib', () => appendLateStdlib(allFuncs, sec.stdlib))
  if (!cfg || cfg.arenaRewind !== false) {
    const safeCallees = arenaRewindModule([...sec.funcs, ...sec.stdlib, ...sec.start])
    const fnByName = new Map()
    for (const fn of sec.funcs) {
      if (Array.isArray(fn) && fn[0] === 'func' && typeof fn[1] === 'string')
        fnByName.set(fn[1], fn)
    }
    for (const func of ctx.funcs.list) {
      const fn = fnByName.get(`$${func.name}`)
      if (fn) applyArenaRewind(func, fn, safeCallees)
    }
  }
  if (!cfg || cfg.hoistConstantPool !== false)
    hoistConstantPool([...sec.funcs, ...sec.stdlib, ...sec.start], (name, lit) => declGlobal(name, 'f64', lit))

  // Second promoteGlobals pass disabled: promoting hoistConstantPool's __fc*
  // globals regressed the watr perf micro-pin (WASM compile time increased).
  // The __fc* globals are typically read 3-4 times; the local setup overhead
  // in large functions outweighs the per-read savings.  Left as a no-op hook
  // in case future analysis finds a profitable threshold or function-size gate.
  // if (!cfg || cfg.promoteGlobals !== false) {
  //   const globalTypesMap2 = ctx.scope.globalTypes ? new Map([...ctx.scope.globalTypes].map(([k, v]) => [`$${k}`, v])) : null
  //   for (const s of [...sec.funcs, ...sec.stdlib, ...sec.start]) promoteGlobals(s, globalTypesMap2)
  // }

  const dataBytes = dataLen()
  if (dataBytes > 1024 && !ctx.memory.shared) {
    // 64-byte heap-base alignment: the compiler's own vectorizer emits v128
    // stream loads/stores, and a heap base that isn't 64-byte aligned makes
    // every such access straddle cache lines on memory-bound kernels — a real,
    // measurable slowdown that a single unrelated prelude-size change can
    // trigger by shifting the base's alignment. Cache-line alignment makes
    // perf immune to prelude size changes — without it every stdlib edit
    // re-rolls the layout lottery.
    // Cost: ≤56 bytes of memory per module, zero code bytes.
    const heapBase = (dataBytes + 63) & ~63
    // Non-shared memory always carries a $__heap global — start it past the
    // static data so the bump allocator never overwrites a literal. `__heap_reset`
    // seeds to the same data end (its runtime value is overwritten by `__start`'s
    // tail capture for modules that init-allocate; this seed serves modules with no
    // `__start`, where the data end IS the correct rewind point). `__clear` reads
    // `$__heap_reset` directly, so no per-function constant patch is needed.
    declGlobal('__heap', 'i32', heapBase, { export: '__heap' })
    if (ctx.scope.globals.has('__heap_reset')) declGlobal('__heap_reset', 'i32', heapBase)
    if (ctx.scope.globals.has('__heap_start')) declGlobal('__heap_start', 'i32', heapBase)
  }
}

// Data-segment tail lifecycle (stripDeadLazyTables, stripDeadInternedSpans,
// stripStaticDataPrefix). Moved to assemble/static-data.js (pipeline-
// minimality split); re-exported here so every existing
// `from '../wat/assemble.js'` import keeps working.
export { stripDeadLazyTables, stripDeadInternedSpans, stripStaticDataPrefix } from './assemble/static-data.js'

