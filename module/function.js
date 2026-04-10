/**
 * Function module — closures, first-class functions, call_indirect.
 *
 * Closures are NaN-boxed pointers: type=10 (CLOSURE), aux=funcIdx, offset=envPtr.
 * Closure body: (env: f64, ...params: f64) → f64 — env is pointer to captured values.
 * Captured variables stored as f64 in memory at envPtr.
 *
 * Auto-included when inner functions reference outer variables.
 *
 * @module fn
 */

import { emit, typed, asF64, asI32, T } from '../src/compile.js'
import { ctx } from '../src/ctx.js'

const CLOSURE = 10

export default () => {
  // Uniform closure convention: all closures use (env: f64, args: f64) → f64
  if (!ctx.fn.types) ctx.fn.types = new Set()
  if (!ctx.fn.table) ctx.fn.table = []
  if (!ctx.fn.bodies) ctx.fn.bodies = []

  ctx.fn.types.add(1) // single type: (env, args_array) → f64

  const addToTable = (name) => {
    let idx = ctx.fn.table.indexOf(name)
    if (idx === -1) { idx = ctx.fn.table.length; ctx.fn.table.push(name) }
    return idx
  }

  /**
   * Create a closure: compile inner function as closure body, capture outer vars.
   * @param {{ params: string[], body, captures: string[], restParam: string|null }} info
   * @returns {WasmNode} NaN-boxed closure pointer
   */
  ctx.fn.make = ({ params, body, captures, restParam, defaults }) => {
    // Generate closure body function name
    const fnName = `${T}closure${ctx.fn.table.length}`

    // All closures use uniform convention: (env: f64, args_array: f64) → f64
    // The body unpacks individual params from the args array
    const boxedCaptures = captures.filter(c => ctx.boxed?.has(c))
    const bodyFn = { name: fnName, params, body, captures, arity: 1,
      ...(restParam && { rest: restParam }),
      ...(defaults && { defaults }),
      ...(boxedCaptures.length && { boxed: new Set(boxedCaptures) }) }
    ctx.fn.bodies.push(bodyFn)

    const tableIdx = addToTable(fnName)

    // At call site: allocate env, store captured values, return NaN-boxed pointer
    if (captures.length === 0) {
      // No captures — just a function reference
      return typed(['call', '$__mkptr', ['i32.const', CLOSURE], ['i32.const', tableIdx], ['i32.const', 0]], 'f64')
    }

    const t = `${T}env${ctx.uniq++}`
    ctx.locals.set(t, 'i32')

    const block = [
      ['local.set', `$${t}`, ['call', '$__alloc', ['i32.const', captures.length * 8]]],
    ]
    // Store captured values (or cell pointers for boxed vars) in env
    for (let i = 0; i < captures.length; i++) {
      const v = ctx.boxed?.has(captures[i])
        ? (() => {
            const cell = ctx.boxed.get(captures[i])
            const ct = ctx.locals?.get(cell) || 'i32'
            return ct === 'f64' ? typed(['local.get', `$${cell}`], 'f64')
              : typed(['f64.convert_i32_u', ['local.get', `$${cell}`]], 'f64')
          })()
        : asF64(emit(captures[i]))
      block.push(['f64.store', ['i32.add', ['local.get', `$${t}`], ['i32.const', i * 8]], v])
    }
    block.push(['call', '$__mkptr', ['i32.const', CLOSURE], ['i32.const', tableIdx], ['local.get', `$${t}`]])

    return typed(['block', ['result', 'f64'], ...block], 'f64')
  }

  /**
   * Call a closure value: extract funcIdx + env from NaN-boxed pointer, call_indirect.
   * @param {WasmNode} closureExpr - Already-emitted closure pointer expression
   * @param {any[]} args - AST nodes (will be emitted) OR pre-emitted nodes (if .type is set)
   */
  ctx.fn.call = (closureExpr, args, prebuiltArray) => {
    const t = `${T}clos${ctx.uniq++}`
    ctx.locals.set(t, 'f64')

    let argsPtr, setup = []
    if (prebuiltArray) {
      // Args already packed as a single array expression
      argsPtr = asF64(args[0])
    } else {
      // Pack all args into a heap array (uniform calling convention)
      const emittedArgs = args.map(a => asF64(a?.type ? a : emit(a)))
      const arrT = `${T}ca${ctx.uniq++}`
      ctx.locals.set(arrT, 'i32')
      const n = emittedArgs.length
      setup = [
        ['local.set', `$${arrT}`, ['call', '$__alloc', ['i32.const', n * 8 + 8]]],
        ['i32.store', ['local.get', `$${arrT}`], ['i32.const', n]],
        ['i32.store', ['i32.add', ['local.get', `$${arrT}`], ['i32.const', 4]], ['i32.const', n]],
        ['local.set', `$${arrT}`, ['i32.add', ['local.get', `$${arrT}`], ['i32.const', 8]]],
      ]
      for (let i = 0; i < n; i++)
        setup.push(['f64.store', ['i32.add', ['local.get', `$${arrT}`], ['i32.const', i * 8]], emittedArgs[i]])
      argsPtr = typed(['call', '$__mkptr', ['i32.const', 1], ['i32.const', 0], ['local.get', `$${arrT}`]], 'f64')
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
