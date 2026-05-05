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

import { typed, asF64, asI32, mkPtrIR, temp, tempI32, MAX_CLOSURE_ARITY, UNDEF_NAN } from '../src/ir.js'
import { emit, isReassigned } from '../src/emit.js'
import { T, lookupValType, repOf, findFreeVars } from '../src/analyze.js'
import { PTR, inc, err } from '../src/ctx.js'


export default (ctx) => {
  inc('__mkptr', '__alloc', '__len', '__ptr_offset', '__ptr_type')

  // Uniform closure convention: (env f64, argc i32, a0..a{MAX-1} f64) → f64
  if (!ctx.closure.types) ctx.closure.types = new Set()
  if (!ctx.closure.table) ctx.closure.table = []
  if (!ctx.closure.bodies) ctx.closure.bodies = []

  ctx.closure.types.add(1) // presence triggers $ftN type emission

  const addToTable = (name) => {
    let idx = ctx.closure.table.indexOf(name)
    if (idx === -1) { idx = ctx.closure.table.length; ctx.closure.table.push(name) }
    return idx
  }

  /**
   * Create a closure: compile inner function as closure body, capture outer vars.
   * @param {{ params: string[], body, captures: string[], restParam: string|null }} info
   * @returns {WasmNode} NaN-boxed closure pointer
   */
  ctx.closure.make = ({ params, body, captures, restParam, defaults }) => {
    const fixedN = params.length - (restParam ? 1 : 0)
    if (fixedN > MAX_CLOSURE_ARITY) err(`Closure with ${fixedN} fixed params exceeds MAX_CLOSURE_ARITY=${MAX_CLOSURE_ARITY}`)
    if (restParam && fixedN >= MAX_CLOSURE_ARITY) err(`Closure with rest param needs at least one free slot — ${fixedN} fixed params leaves none (MAX_CLOSURE_ARITY=${MAX_CLOSURE_ARITY})`)
    // Generate closure body function name
    const fnName = `${T}closure${ctx.closure.table.length}`
    const captureValTypes = new Map()
    const captureSchemaVars = new Map()
    const captureTypedElems = new Map()
    // Propagate parent's directClosures across captures: a const-bound closure captured
    // by an inner arrow can still be direct-dispatched in the inner body (skip
    // call_indirect on the captured pointer). Gated on isReassigned over the inner body
    // so a local rewrite of the captured name disables propagation.
    const captureDirectClosures = new Map()
    for (const name of captures) {
      const vt = lookupValType(name)
      if (vt != null) captureValTypes.set(name, vt)
      const schemaId = ctx.schema.idOf(name)
      if (schemaId != null) captureSchemaVars.set(name, schemaId)
      const elemType = ctx.types.typedElem?.get(name)
      if (elemType != null) captureTypedElems.set(name, elemType)
      const bodyName = ctx.func.directClosures?.get(name)
      if (bodyName && !isReassigned(body, name)) captureDirectClosures.set(name, bodyName)
    }

    const schemaNames = ctx.schema.vars?.size ? new Set(ctx.schema.vars.keys()) : null
    if (schemaNames?.size) {
      const refs = []
      findFreeVars(body, new Set(params), refs, schemaNames)
      for (const def of Object.values(defaults || {})) findFreeVars(def, new Set(params), refs, schemaNames)
      for (const name of refs) {
        if (captureSchemaVars.has(name)) continue
        const schemaId = ctx.schema.idOf(name)
        if (schemaId != null) captureSchemaVars.set(name, schemaId)
      }
    }

    // All closures use uniform convention: (env: f64, args_array: f64) → f64
    // The body unpacks individual params from the args array
    const boxedCaptures = captures.filter(c => ctx.func.boxed?.has(c))
    const bodyFn = { name: fnName, params, body, captures, arity: 1,
      ...(restParam && { rest: restParam }),
      ...(defaults && { defaults }),
      ...(boxedCaptures.length && { boxed: new Set(boxedCaptures) }),
      ...(captureValTypes.size && { valTypes: captureValTypes }),
      ...(captureSchemaVars.size && { schemaVars: captureSchemaVars }),
      ...(captureTypedElems.size && { typedElems: captureTypedElems }),
      ...(captureDirectClosures.size && { directClosures: captureDirectClosures }) }
    ctx.closure.bodies.push(bodyFn)

    const tableIdx = addToTable(fnName)

    // At call site: allocate env, store captured values, return NaN-boxed pointer.
    // Tag IR with .closureBodyName so emitDecl can register the binding for direct dispatch
    // (skip call_indirect on a const-bound, non-escaping closure local). See emit.js '()' handler.
    ctx.features.closure = true
    if (captures.length === 0) {
      // No captures — just a function reference
      const ir = mkPtrIR(PTR.CLOSURE, tableIdx, 0)
      ir.closureBodyName = fnName
      ir.closureFuncIdx = tableIdx
      return ir
    }

    const t = tempI32('env')

    const block = [
      ['local.set', `$${t}`, ['call', '$__alloc', ['i32.const', captures.length * 8]]],
    ]
    // Store captured values in env: boxed cells as raw i32 in low 4 bytes, others as f64.
    // Avoids i32↔f64 roundtrip; body loads via i32.load/f64.load using the same branch.
    for (let i = 0; i < captures.length; i++) {
      const addr = ['i32.add', ['local.get', `$${t}`], ['i32.const', i * 8]]
      if (ctx.func.boxed?.has(captures[i]))
        block.push(['i32.store', addr, ['local.get', `$${ctx.func.boxed.get(captures[i])}`]])
      else
        block.push(['f64.store', addr, asF64(emit(captures[i]))])
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
  ctx.closure.call = (closureExpr, args, prebuiltArray) => {
    const t = temp('clos')

    if (prebuiltArray) {
      // Spread path: decode array into inline slots. Slots beyond array len padded with UNDEF.
      // Rest-param closures receive up to (MAX - fixedParams) spread elements (overflow lost).
      const arrT = tempI32('sa')
      const lenL = tempI32('sl')
      const setup = [
        ['local.set', `$${arrT}`, ['call', '$__ptr_offset', asF64(args[0])]],
        ['local.set', `$${lenL}`, ['call', '$__len', ['local.get', `$${t}`]]],  // placeholder — set below
      ]
      // Rebuild setup properly since we need the array ptr before len call
      setup.length = 0
      const arrPtrF64 = temp('sp')
      setup.push(['local.set', `$${arrPtrF64}`, asF64(args[0])])
      setup.push(['local.set', `$${arrT}`, ['call', '$__ptr_offset', ['local.get', `$${arrPtrF64}`]]])
      setup.push(['local.set', `$${lenL}`, ['call', '$__len', ['local.get', `$${arrPtrF64}`]]])

      const W = ctx.closure.width ?? MAX_CLOSURE_ARITY
      const slots = []
      for (let i = 0; i < W; i++) {
        slots.push(['if', ['result', 'f64'],
          ['i32.gt_s', ['local.get', `$${lenL}`], ['i32.const', i]],
          ['then', ['f64.load', ['i32.add', ['local.get', `$${arrT}`], ['i32.const', i * 8]]]],
          ['else', UNDEF_LIT()]])
      }
      return typed(['block', ['result', 'f64'],
        ...setup,
        ['local.set', `$${t}`, asF64(closureExpr)],
        ['call_indirect', ['type', '$ftN'],
          ['local.get', `$${t}`],
          ['local.get', `$${lenL}`],
          ...slots,
          // Inline __ptr_aux for CLOSURE pointer: aux = bits 32..46 holds funcIdx.
          ['i32.wrap_i64', ['i64.and',
            ['i64.shr_u', ['i64.reinterpret_f64', ['local.get', `$${t}`]], ['i64.const', 32]],
            ['i64.const', 0x7FFF]]]]], 'f64')
    }

    // Inline path: emit each arg, pad missing slots with UNDEF
    const n = args.length
    if (n > MAX_CLOSURE_ARITY) err(`Closure call with ${n} args exceeds MAX_CLOSURE_ARITY=${MAX_CLOSURE_ARITY}`)
    const W = ctx.closure.width ?? MAX_CLOSURE_ARITY
    const slots = []
    for (let i = 0; i < n; i++) slots.push(asF64(args[i]?.type ? args[i] : emit(args[i])))
    for (let i = n; i < W; i++) slots.push(UNDEF_LIT())

    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, asF64(closureExpr)],
      ['call_indirect', ['type', '$ftN'],
        ['local.get', `$${t}`],
        ['i32.const', n],
        ...slots,
        // Inline __ptr_aux for CLOSURE pointer: aux = bits 32..46 holds funcIdx.
        ['i32.wrap_i64', ['i64.and',
          ['i64.shr_u', ['i64.reinterpret_f64', ['local.get', `$${t}`]], ['i64.const', 32]],
          ['i64.const', 0x7FFF]]]]], 'f64')
  }
}
