/**
 * Synthetic `$__start` function — building it (module-init IR, boxed
 * autoBox/schema-table/string-pool/typeof/closure-env-side-table setup) and
 * later simplifying it (hoisting single-assignment const globals out of it,
 * possibly deleting the whole start func once emptied).
 *
 * Split out of assemble.js (pipeline-minimality slice) — pure move, no
 * behavior change. See ../assemble.js for the stage contract and
 * `.work/archive/assemble-outliers.md` §4. `hoistConstGlobalInits` runs much later
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

/** Auto-box init: schema.autoBox entries (`let` globals whose schema was
 *  minted after their declaration) — alloc+init+ptr-box each hoisted global.
 *  Collect step (buildStartFn splices the returned IR at a fixed position —
 *  pipeline-minimality slice, `.work/archive/assemble-outliers.md` §5).
 */
function buildBoxInit() {
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
  return boxInit
}

/** Schema name-table init: static data-segment layout when every key folds
 *  to a constant, else a runtime alloc+store fallback. Collect step
 *  (buildStartFn splices the returned IR at a fixed position — pipeline-
 *  minimality slice, `.work/archive/assemble-outliers.md` §5).
 */
function buildSchemaInit() {
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
    ctx.core.includes.has('__dyn_set')
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
  return schemaInit
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
    // Statement context, like the entry program below: a module init whose
    // last statement is an assignment must not leave its value on the stack.
    moduleInits.push(...normalizeEmittedIR(emitVoid(mi)))
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

  const boxInit = buildBoxInit()

  const schemaInit = buildSchemaInit()

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

  const wasiTimers = ctx.features.timers && ctx.transform.targetProfile.timerModel === 'blocking'
  if (moduleInits.length || init?.length || boxInit.length || schemaInit.length || typeofInit.length || strPoolInit.length || wasiTimers) {
    const initIR = normalizeEmittedIR(init)
    const startFn = ['func', '$__start']
    for (const [l, t] of ctx.func.locals) startFn.push(['local', `$${l}`, t])
    startFn.push(...strPoolInit, ...typeofInit, ...boxInit, ...schemaInit,
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
  // The constant an init expression denotes, as the literal of a `${type}.const`,
  // or null. A pointer-ABI global narrowed from a folded NaN-box pointer carries
  // `i32.wrap_i64(i64.reinterpret_f64(f64.const nan:0x…))`: the box's low word.
  const constLit = (c, type) => {
    if (!Array.isArray(c)) return null
    if (c[0] === `${type}.const`) return c[1]
    if (type === 'i32' && c[0] === 'i32.wrap_i64' && Array.isArray(c[1]) && c[1][0] === 'i64.reinterpret_f64'
        && Array.isArray(c[1][1]) && c[1][1][0] === 'f64.const'
        && typeof c[1][1][1] === 'string' && c[1][1][1].startsWith('nan:0x'))
      return Number(BigInt(c[1][1][1].slice(4)) & 0xFFFFFFFFn) | 0
    return null
  }
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
    const lit = constLit(c, g.type)
    if (lit == null) continue
    ctx.scope.globals.set(name, { ...g, mut: false, init: lit })
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
