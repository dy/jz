/**
 * Function module — closures, first-class functions, call_indirect.
 *
 * Closures are NaN-boxed pointers: type=10 (PTR.CLOSURE), aux=funcIdx, offset=envPtr.
 * Closure body: (env: f64, ...params: f64) → f64 — env is pointer to captured values.
 * Captured variables stored as f64 in memory at envPtr.
 *
 * Auto-included when inner functions reference outer variables.
 *
 * @module fn
 */

import { typed, asF64, asI64, mkPtrIR, temp, tempI32, MAX_CLOSURE_ARITY, UNDEF_NAN, ptrTypeEq, throwTypeErrorIR } from '../src/ir.js'
import { emit, storedValue, storedValuePlanned } from '../src/bridge.js'
import { constNumExpr } from '../src/static.js'
import { isReassigned } from '../src/ast.js'
import { findFreeVars } from '../src/compile/analyze.js'
import { BIGINT_REP_CLOSED, BIGINT_REP_BOXED, BIGINT_REP_RAW, REP_EDGE_REJECT, representationActiveMaterializedRep, representationClosureArgAction } from '../src/compile/representation-plan.js'
import { T } from '../src/ast.js'
import { lookupValType, repOf } from '../src/reps.js'
import { PTR, LAYOUT, inc, err, declGlobal, setLinkDemand, registerGetter } from '../src/ctx.js'
import { reachOn } from './core/reach.js'
import { functionLength } from '../src/function.js'
import { dataLen, dataPush } from '../src/static-data.js'

const topLevelIntConsts = (body, captures) => {
  if (!captures.length) return null
  const inner = Array.isArray(body) && body[0] === '{}' ? body[1] : body
  if (!Array.isArray(inner) || inner[0] !== ';') return null
  let out = null
  for (let s = 1; s < inner.length; s++) {
    const stmt = inner[s]
    if (!Array.isArray(stmt) || (stmt[0] !== 'const' && stmt[0] !== 'let')) continue
    for (let i = 1; i < stmt.length; i++) {
      const decl = stmt[i]
      if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') continue
      if (!captures.includes(decl[1])) continue
      if (stmt[0] === 'let' && isReassigned(body, decl[1])) continue
      const v = constNumExpr(decl[2])
      if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) (out ||= new Map()).set(decl[1], v)
    }
  }
  return out
}


export default (ctx) => {
  inc('__mkptr', '__alloc', '__len', '__ptr_offset', '__ptr_type')

  // Uniform closure convention: (env f64, argc i32, a0..a{MAX-1} f64) → f64
  if (!ctx.closure.types) ctx.closure.types = new Set()
  if (!ctx.closure.table) ctx.closure.table = []
  if (!ctx.closure.lengths) ctx.closure.lengths = []
  if (!ctx.closure.bodies) ctx.closure.bodies = []
  ctx.closure.types.add(1) // presence triggers $ftN type emission

  ctx.closure.mint = (name, length) => {
    let idx = ctx.closure.table.indexOf(name)
    if (idx === -1) {
      idx = ctx.closure.table.length
      ctx.closure.table.push(name)
      ctx.closure.lengths.push(length)
    }
    return idx
  }

  ctx.core.stdlib.__closure_length = () => {
    if (ctx.memory.shared && !ctx.scope.globals.has('__staticBase')) declGlobal('__staticBase', 'i32')
    if (ctx.closure.lengthData == null) {
      ctx.closure.lengthData = dataLen()
      dataPush(new Uint8Array(ctx.closure.lengths))
    }
    const base = ctx.memory.shared ? `(i32.add (global.get $__staticBase) (i32.const ${ctx.closure.lengthData}))` : `(i32.const ${ctx.closure.lengthData})`
    return `(func $__closure_length (param $fn i64) (result i32)
      (i32.load8_u (i32.add ${base}
        (i32.wrap_i64 (i64.and (i64.shr_u (local.get $fn) (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK}))))))`
  }
  // The host's call of a closure it holds (interop.js reads one as a JS
  // function). Values cross as i64 bits, as every boxed boundary value does.
  // `argc` counts the host's arguments; past the inline lanes a rest
  // parameter reads them from `spill`, the host's array of all of them (a
  // spread call's $__closure_spill).
  ctx.core.stdlib.__call_closure = () => {
    const lanes = Array.from({ length: ctx.closure.width ?? MAX_CLOSURE_ARITY }, (_, i) => i)
    return `(func $__call_closure (export "__call_closure") (param $clos i64) (param $argc i32) (param $spill i32) (param $this i64)${lanes.map(i => ` (param $a${i} i64)`).join('')} (result i64)
      ${ctx.scope.globals.has('__closure_spill') ? '(global.set $__closure_spill (local.get $spill))' : ''}
      (i64.reinterpret_f64 (call_indirect (type $ftN)
        (f64.reinterpret_i64 (local.get $clos))
        (local.get $argc)
        ${lanes.map(i => `(f64.reinterpret_i64 (local.get $a${i}))`).join(' ')}
        ${ctx.closure.receiver ? '(f64.reinterpret_i64 (local.get $this))' : ''}
        (i32.wrap_i64 (i64.and (i64.shr_u (local.get $clos) (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK}))))))`
  }

  registerGetter('.closure:length', fn => {
    inc('__closure_length')
    return typed(['call', '$__closure_length', asI64(emit(fn))], 'i32')
  })

  /**
   * Create a closure: compile inner function as closure body, capture outer vars.
   * @param {{ params: string[], body, captures: string[], restParam: string|null }} info
   * @returns {WasmNode} NaN-boxed closure pointer
   */
  ctx.closure.make = ({ params, body, captures, restParam, defaults, scope }) => {
    const fixedN = params.length - (restParam ? 1 : 0)
    if (fixedN > MAX_CLOSURE_ARITY) err(`Closure with ${fixedN} fixed params exceeds MAX_CLOSURE_ARITY=${MAX_CLOSURE_ARITY}`)
    if (restParam && fixedN >= MAX_CLOSURE_ARITY) err(`Closure with rest param needs at least one free slot — ${fixedN} fixed params leaves none (MAX_CLOSURE_ARITY=${MAX_CLOSURE_ARITY})`)
    // Generate closure body function name
    const fnName = `${T}closure${ctx.closure.table.length}`
    const owner = ctx.func.current?.name ?? ctx.closure.emitting
    if (owner) (ctx.closure.owner ??= new Map()).set(fnName, owner)
    // The summary's closure this body is (undefined for a body it never saw:
    // one cloned after it ran): link reads a resolved call's targets by it.
    ;(ctx.closure.summaryId ??= new Map()).set(fnName, ctx.summary?.closureIdOfBody?.(body))

    const localIntConsts = ctx.func.body ? topLevelIntConsts(ctx.func.body, captures) : null
    const captureIntConsts = new Map()
    for (const name of captures) {
      // Third fallback: a depth≥2 capture chain whose constant was
      // declared in an ANCESTOR closure, not the current one, is invisible
      // to topLevelIntConsts(ctx.func.body) (current-frame-only) and
      // ctx.scope.constInts (module-only) alike — repOf(name)?.intConst
      // carries it forward regardless, since the ancestor's own
      // seedClosureFrame already republished its fold into this frame's
      // localReps before this arrow's capture set is derived.
      const v = ctx.scope.constInts?.get(name) ?? localIntConsts?.get(name) ?? repOf(name)?.intConst
      if (v != null && !ctx.func.boxed?.has(name)) captureIntConsts.set(name, v)
    }
    const envCaptures = captureIntConsts.size ? captures.filter(name => !captureIntConsts.has(name)) : captures
    const boxedCaptures = envCaptures.filter(c => ctx.func.boxed?.has(c))

    const captureValTypes = new Map()
    const captureSchemaVars = new Map()
    const captureTypedElems = new Map()
    // Propagate parent's intCertain rep across captures: the parent's narrower
    // already guarantees every defining RHS (including assignments inside
    // nested arrows) is integer-valued, so the f64 round-trip through the env
    // slot preserves integer semantics. Consumers inside the inner body —
    // `toNumF64` elision (src/ir.js), math fast paths (module/math.js),
    // bitwise-key indexing (src/emit.js) — fire on captures just as they
    // would on directly-declared locals.
    const captureIntCertain = new Set()
    // Propagate parent's directClosures across captures: a const-bound closure captured
    // by an inner arrow can still be direct-dispatched in the inner body (skip
    // call_indirect on the captured pointer). Gated on isReassigned over the inner body
    // so a local rewrite of the captured name disables propagation.
    const captureDirectClosures = new Map()
    // Propagate the parent's `nullable` mark: a capture whose parent binding can
    // hold null/undefined (e.g. `let x = null` later assigned a number) must keep
    // that fact inside the body, or the body's own write facts (val = NUMBER)
    // would let `x == null` fold to a constant false and skip the guard.
    const captureNullables = new Set()
    // Propagate the parent's `mayBeUndefined` mark (Slice 2,
    // .work/archive/represented-maybe-undefined-design.md §3 "Closure captures") — the container-read
    // sibling of captureNullables just above, same reasoning: a capture whose
    // parent binding can be real JS `undefined` despite a definite `val` claim
    // must keep that fact inside the body, or the body's own write facts
    // would let it evaporate at the capture boundary.
    const captureMayBeUndefineds = new Set()
    const captureBigintReps = new Map()
    for (const name of envCaptures) {
      const carrier = representationActiveMaterializedRep(ctx, name)
      if (carrier === (BIGINT_REP_RAW | BIGINT_REP_CLOSED) || carrier === (BIGINT_REP_BOXED | BIGINT_REP_CLOSED)) captureBigintReps.set(name, carrier)
      const vt = lookupValType(name)
      if (vt != null) captureValTypes.set(name, vt)
      const schemaId = ctx.schema.idOf(name)
      if (schemaId != null) captureSchemaVars.set(name, schemaId)
      const elemType = ctx.func.typedElem?.get(name)
      if (elemType != null) captureTypedElems.set(name, elemType)
      const bodyName = ctx.func.directClosures?.get(name)
      if (bodyName && !isReassigned(body, name)) captureDirectClosures.set(name, bodyName)
      if (repOf(name)?.intCertain === true) captureIntCertain.add(name)
      if (repOf(name)?.nullable) captureNullables.add(name)
      if (repOf(name)?.mayBeUndefined) captureMayBeUndefineds.add(name)
    }

    // findFreeVars's `scope` param needs BOTH `.has(name)` (membership test)
    // AND `.add(name)` (analyze-scans.js's own `let`/`const`/`for(let…)`
    // branches call `collectParamNames(decls, scope)`, which does `scope.add`,
    // to record body-local shadow declarations so a same-named inner `let`
    // doesn't get misread as a free reference to the outer schema var) — a
    // real mutable Set interface, not a plain read-only lookup. The old
    // `new Set(ctx.schema.vars.keys())` materialized a FULL COPY of the
    // program-wide schema table to get that interface, at O(program schema-
    // table size) PER CLOSURE LITERAL (fires for every arrow/function
    // expression seen while ANY body emits, not just ones that end up
    // capturing anything — .work/evidence.md's MapOverlay fix targets the
    // same shape-class one level down, at closure-body-EMISSION time; this
    // site is the more frequent, likely-dominant sibling, at closure-CREATION
    // time). `scopeOwn` below is the SAME two-layer split MapOverlay uses —
    // `.add` writes ONLY into a fresh per-closure Set (bounded by this one
    // closure's own local declarations), `.has` falls through to the real
    // ctx.schema.vars table on miss — so shadow-tracking writes never leak
    // into the shared program-wide map, and constructing the view is O(1).
    if (ctx.schema.vars) {
      const scopeOwn = new Set()
      const schemaVars = ctx.schema.vars
      const scope = { has: (name) => scopeOwn.has(name) || schemaVars.has(name), add: (name) => scopeOwn.add(name) }
      const refs = []
      findFreeVars(body, new Set(params), refs, scope)
      for (const def of Object.values(defaults || {})) findFreeVars(def, new Set(params), refs, scope)
      for (const name of refs) {
        if (captureSchemaVars.has(name)) continue
        const schemaId = ctx.schema.idOf(name)
        if (schemaId != null) captureSchemaVars.set(name, schemaId)
      }
    }

    // i32-narrowed cells travel with the capture: the closure body must access
    // the shared cell at the same width the owner does (see funcFacts.cellTypes).
    const cellI32Captures = boxedCaptures.filter(c => ctx.func.cellTypes?.has(c))
    // Fixed-shape closure-plan record. Conditional spreads used to create a
    // family of HASH-shaped records; region compaction could relocate the
    // outer bodies array while losing one optional-shape member (`params`
    // became null at full jz×jz scale). Null sentinels preserve every existing
    // truthy/optional consumer and give the relocator one stable slot layout.
    const bodyFn = {
      name: fnName, params, body, captures: envCaptures, arity: 1,
      scope: scope ?? null,
      rest: restParam || null,
      defaults: defaults || null,
      boxed: boxedCaptures.length ? new Set(boxedCaptures) : null,
      cellI32: cellI32Captures.length ? new Set(cellI32Captures) : null,
      intConsts: captureIntConsts.size ? captureIntConsts : null,
      intCertain: captureIntCertain.size ? captureIntCertain : null,
      nullables: captureNullables.size ? captureNullables : null,
      mayBeUndefineds: captureMayBeUndefineds.size ? captureMayBeUndefineds : null,
      bigintReps: captureBigintReps.size ? captureBigintReps : null,
      valTypes: captureValTypes.size ? captureValTypes : null,
      schemaVars: captureSchemaVars.size ? captureSchemaVars : null,
      typedElems: captureTypedElems.size ? captureTypedElems : null,
      directClosures: captureDirectClosures.size ? captureDirectClosures : null,
    }
    ctx.closure.bodies.push(bodyFn)

    const tableIdx = ctx.closure.mint(fnName, functionLength(params, defaults, restParam))

    // At call site: allocate env, store captured values, return NaN-boxed pointer.
    // Tag IR with .closureBodyName so emitDecl can register the binding for direct dispatch
    // (skip call_indirect on a const-bound, non-escaping closure local). See emit.js '()' handler.
    setLinkDemand('closure')
    if (envCaptures.length === 0) {
      // No captures — just a function reference
      const ir = mkPtrIR(PTR.CLOSURE, tableIdx, 0)
      ir.closureBodyName = fnName
      ir.closureFuncIdx = tableIdx
      return ir
    }

    const t = tempI32('env')

    // Where a frame may keep what its escapes reach (module/core/reach.js), the
    // environment carries its count in a header, as an array does: the walk
    // reads there how many slots a closure it met holds, and a cell's address
    // fills its slot whole, the high word zero, so what the memory held
    // before reads as no value.
    const walked = !!ctx.plans.hasSites && reachOn()
    const env = walked
      ? (inc('__alloc_hdr'), ['call', '$__alloc_hdr', ['i32.const', envCaptures.length], ['i32.const', envCaptures.length]])
      : ['call', '$__alloc', ['i32.const', envCaptures.length * 8]]
    const block = [['local.set', `$${t}`, env]]
    // Store captured values in env: boxed cells as raw i32 in low 4 bytes, others as f64.
    // Avoids i32↔f64 roundtrip; body loads via i32.load/f64.load using the same branch.
    for (let i = 0; i < envCaptures.length; i++) {
      const addr = ['i32.add', ['local.get', `$${t}`], ['i32.const', i * 8]]
      if (ctx.func.boxed?.has(envCaptures[i])) {
        const cell = ['local.get', `$${ctx.func.boxed.get(envCaptures[i])}`]
        block.push(walked ? ['i64.store', addr, ['i64.extend_i32_u', cell]] : ['i32.store', addr, cell])
      }
      // A Boolean-or-Number binding the closure observes holds its atoms
      // itself (kind.js boolTagged): the capture copies the value.
      else block.push(['f64.store', addr, asF64(emit(envCaptures[i]))])
    }
    block.push(mkPtrIR(PTR.CLOSURE, tableIdx, ['local.get', `$${t}`]))

    const ir = typed(['block', ['result', 'f64'], ...block], 'f64')
    ir.closureBodyName = fnName
    ir.closureFuncIdx = tableIdx
    return ir
  }

  const UNDEF_LIT = () => ['f64.const', `nan:${UNDEF_NAN}`]

  /**
   * Call a closure value: pass args inline as a0..a{MAX-1} + argc, call_indirect.
   * @param {WasmNode} closureExpr - Already-emitted closure pointer expression
   * @param {any[]} args - AST nodes (will be emitted) OR pre-emitted nodes (if .type is set)
   * @param {boolean} prebuiltArray - args[0] is a pre-built args array (spread path)
   */
  /** One argument in the closure ABI's slot form: an AST node by its representation action, pre-emitted IR (has .type) as is. */
  ctx.closure.argIR = (a) => {
    if (a?.type) return asF64(a)
    const action = representationClosureArgAction(ctx, a)
    return action === REP_EDGE_REJECT ? storedValue(a) : storedValuePlanned(a, action)
  }
  ctx.closure.call = (closureExpr, args, prebuiltArray, check = false, thisArg = null) => {
    const t = temp('clos'), recv = typed(['local.get', `$${t}`], 'f64')
    // Every caller captures the callee before evaluating inline or spread args.
    const setup = [['local.set', `$${t}`, asF64(closureExpr)]]
    const receiver = thisArg ? temp('recv') : null
    if (receiver) setup.push(['local.set', `$${receiver}`, asF64(thisArg)])
    const W = ctx.closure.width ?? MAX_CLOSURE_ARITY
    const slots = []
    let argc
    if (prebuiltArray) {
      // Publish the full argument array for rest parameters beyond inline width W.
      declGlobal('__closure_spill', 'i32')
      const arrT = tempI32('sa'), lenL = tempI32('sl'), arrPtrF64 = temp('sp')
      setup.push(['local.set', `$${arrPtrF64}`, asF64(args[0])])
      setup.push(['local.set', `$${arrT}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${arrPtrF64}`]]]])
      setup.push(['local.set', `$${lenL}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${arrPtrF64}`]]]])
      setup.push(['global.set', '$__closure_spill', ['local.get', `$${arrT}`]])
      argc = ['local.get', `$${lenL}`]
      for (let i = 0; i < W; i++) slots.push(['if', ['result', 'f64'],
        ['i32.gt_s', argc, ['i32.const', i]],
        ['then', ['f64.load', ['i32.add', ['local.get', `$${arrT}`], ['i32.const', i * 8]]]],
        ['else', UNDEF_LIT()]])
    } else {
      if (args.length > MAX_CLOSURE_ARITY) err(`Closure call with ${args.length} args exceeds MAX_CLOSURE_ARITY=${MAX_CLOSURE_ARITY}`)
      // The uniform type carries W slots, and W covers every declared parameter
      // list, so an argument past it is one no callee could name.
      const n = Math.min(args.length, W)
      argc = ['i32.const', n]
      for (let i = 0; i < n; i++) {
        const arg = ctx.closure.argIR(args[i])
        if (!check) slots.push(arg)
        else {
          const a = temp('carg')
          setup.push(['local.set', `$${a}`, arg])
          slots.push(['local.get', `$${a}`])
        }
      }
      for (let i = n; i < W; i++) slots.push(UNDEF_LIT())
    }
    const call = ['call_indirect', ['type', '$ftN'], recv, argc, ...slots,
      ...(ctx.closure.receiver ? [receiver ? ['local.get', `$${receiver}`] : UNDEF_LIT()] : []),
      ['i32.wrap_i64', ['i64.and',
        ['i64.shr_u', ['i64.reinterpret_f64', recv], ['i64.const', LAYOUT.AUX_SHIFT]],
        ['i64.const', LAYOUT.AUX_MASK]]]]
    // Unproven member slots need a check after argument effects. Other callers
    // already established callability through analysis or runtime dispatch.
    return typed(['block', ['result', 'f64'], ...setup, check
      ? ['if', ['result', 'f64'], ptrTypeEq(recv, PTR.CLOSURE),
        ['then', call], ['else', throwTypeErrorIR('call')]]
      : call], 'f64')
  }
}
