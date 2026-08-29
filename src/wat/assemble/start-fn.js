/**
 * Synthetic `$__start` function — building it (module-init IR, boxed
 * autoBox/schema-table/string-pool/typeof/closure-env-side-table setup) and
 * later simplifying it (hoisting single-assignment const globals out of it,
 * possibly deleting the whole start func once emptied).
 *
 * Split out of assemble.js (pipeline-minimality slice) — pure move, no
 * behavior change. See ../assemble.js for the stage contract and
 * `.work/assemble-outliers.md` §4. `hoistConstGlobalInits` runs much later
 * in the real compile/index.js pipeline (after pullStdlib/optimizeModule),
 * but shares this file because both operate exclusively on `sec.start`'s
 * `$__start` function.
 */

import { ctx, inc, PTR, declGlobal, assertCtxInvariants } from '../../ctx.js'
import { T, walkAst } from '../../ast.js'
import { analyzeValTypes, analyzeBody, findMutations } from '../../compile/analyze.js'
import { enterActiveFunction, restoreActiveFunction } from '../../compile/active-function.js'
import { enterPreparedFunction, functionPlanOf, publishPreparedFunctionPlan, retireFunctionPlan } from '../../compile/function-plan.js'
import { mintRepresentationPlan, representationProgramHasBigint } from '../../compile/representation-plan.js'
import { mintTypedStoragePlan } from '../../compile/typed-storage-plan.js'
import { emit, emitVoid } from '../../compile/emit.js'
import { mkPtrIR, findBodyStart, extractF64Bits, asF64 } from '../../ir.js'
import { staticArrayPtr } from '../../../module/array.js'
import { dataLen, strPoolLen, pushStaticSlots } from '../../static-data.js'

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
