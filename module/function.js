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

import { emit, typed, asF64, asI32, T, mkPtrIR, temp, tempI32 } from '../src/compile.js'
import { ctx, PTR, inc } from '../src/ctx.js'


export default () => {
  inc('__mkptr', '__alloc', '__ptr_aux')

  // Uniform closure convention: all closures use (env: f64, args: f64) → f64
  if (!ctx.closure.types) ctx.closure.types = new Set()
  if (!ctx.closure.table) ctx.closure.table = []
  if (!ctx.closure.bodies) ctx.closure.bodies = []

  ctx.closure.types.add(1) // single type: (env, args_array) → f64

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
    // Generate closure body function name
    const fnName = `${T}closure${ctx.closure.table.length}`
    const captureValTypes = new Map()
    const captureSchemaVars = new Map()
    const captureTypedElems = new Map()
    for (const name of captures) {
      const vt = ctx.func.valTypes?.get(name) || ctx.scope.globalValTypes?.get(name)
      if (vt != null) captureValTypes.set(name, vt)
      const schemaId = ctx.schema.vars.get(name)
      if (schemaId != null) captureSchemaVars.set(name, schemaId)
      const elemType = ctx.types.typedElem?.get(name)
      if (elemType != null) captureTypedElems.set(name, elemType)
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
      ...(captureTypedElems.size && { typedElems: captureTypedElems }) }
    ctx.closure.bodies.push(bodyFn)

    const tableIdx = addToTable(fnName)

    // At call site: allocate env, store captured values, return NaN-boxed pointer
    if (captures.length === 0) {
      // No captures — just a function reference
      return mkPtrIR(PTR.CLOSURE, tableIdx, 0)
    }

    const t = tempI32('env')

    const block = [
      ['local.set', `$${t}`, ['call', '$__alloc', ['i32.const', captures.length * 8]]],
    ]
    // Store captured values in env: boxed → cell pointer packed as f64, otherwise value
    for (let i = 0; i < captures.length; i++) {
      const v = ctx.func.boxed?.has(captures[i])
        ? typed(['f64.convert_i32_u', ['local.get', `$${ctx.func.boxed.get(captures[i])}`]], 'f64')
        : asF64(emit(captures[i]))
      block.push(['f64.store', ['i32.add', ['local.get', `$${t}`], ['i32.const', i * 8]], v])
    }
    block.push(mkPtrIR(PTR.CLOSURE, tableIdx, ['local.get', `$${t}`]))

    return typed(['block', ['result', 'f64'], ...block], 'f64')
  }

  /**
   * Call a closure value: extract funcIdx + env from NaN-boxed pointer, call_indirect.
   * @param {WasmNode} closureExpr - Already-emitted closure pointer expression
   * @param {any[]} args - AST nodes (will be emitted) OR pre-emitted nodes (if .type is set)
   */
  ctx.closure.call = (closureExpr, args, prebuiltArray) => {
    const t = temp('clos')

    let argsPtr, setup = []
    if (prebuiltArray) {
      // Args already packed as a single array expression
      argsPtr = asF64(args[0])
    } else {
      // Pack all args into a heap array (uniform calling convention)
      const emittedArgs = args.map(a => asF64(a?.type ? a : emit(a)))
      const arrT = tempI32('ca')
      const n = emittedArgs.length
      setup = [
        ['local.set', `$${arrT}`, ['call', '$__alloc', ['i32.const', n * 8 + 8]]],
        ['i32.store', ['local.get', `$${arrT}`], ['i32.const', n]],
        ['i32.store', ['i32.add', ['local.get', `$${arrT}`], ['i32.const', 4]], ['i32.const', n]],
        ['local.set', `$${arrT}`, ['i32.add', ['local.get', `$${arrT}`], ['i32.const', 8]]],
      ]
      for (let i = 0; i < n; i++)
        setup.push(['f64.store', ['i32.add', ['local.get', `$${arrT}`], ['i32.const', i * 8]], emittedArgs[i]])
      argsPtr = mkPtrIR(PTR.ARRAY, 0, ['local.get', `$${arrT}`])
    }

    return typed(['block', ['result', 'f64'],
      ...setup,
      ['local.set', `$${t}`, asF64(closureExpr)],
      ['call_indirect', ['type', '$ft1'],
        ['local.get', `$${t}`],
        argsPtr,
        ['call', '$__ptr_aux', ['local.get', `$${t}`]]]], 'f64')
  }
}
