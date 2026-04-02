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

import { emit, typed, asF64, asI32 } from '../src/compile.js'
import { ctx } from '../src/ctx.js'

const CLOSURE = 10

export default () => {
  // Function type registry: arity → type name
  if (!ctx.fn.types) ctx.fn.types = new Set()
  if (!ctx.fn.table) ctx.fn.table = []
  if (!ctx.fn.bodies) ctx.fn.bodies = []

  const ensureType = (arity) => ctx.fn.types.add(arity)

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
  ctx.fn.make = ({ params, body, captures, restParam }) => {
    const arity = restParam ? 1 : params.length
    ensureType(arity)

    // Generate closure body function name
    const fnName = `__closure${ctx.fn.table.length}`

    // Build the closure body: (env: f64, param0: f64, ...) → f64
    // Inside the body, captured vars are loaded from env memory
    // If closure has rest params, the single param is the rest array
    const bodyFn = { name: fnName, params, body, captures, arity, ...(restParam && { rest: restParam }) }
    ctx.fn.bodies.push(bodyFn)

    const tableIdx = addToTable(fnName)

    // At call site: allocate env, store captured values, return NaN-boxed pointer
    if (captures.length === 0) {
      // No captures — just a function reference
      return typed(['call', '$__mkptr', ['i32.const', CLOSURE], ['i32.const', tableIdx], ['i32.const', 0]], 'f64')
    }

    const t = `__env${ctx.uniq++}`
    ctx.locals.set(t, 'i32')

    const block = [
      ['local.set', `$${t}`, ['call', '$__alloc', ['i32.const', captures.length * 8]]],
    ]
    // Store each captured variable as f64 in env
    for (let i = 0; i < captures.length; i++) {
      block.push(['f64.store',
        ['i32.add', ['local.get', `$${t}`], ['i32.const', i * 8]],
        asF64(emit(captures[i]))])
    }
    block.push(['call', '$__mkptr', ['i32.const', CLOSURE], ['i32.const', tableIdx], ['local.get', `$${t}`]])

    return typed(['block', ['result', 'f64'], ...block], 'f64')
  }

  /**
   * Call a closure value: extract funcIdx + env from NaN-boxed pointer, call_indirect.
   * @param {WasmNode} closureExpr - Already-emitted closure pointer expression
   * @param {any[]} args - AST nodes (will be emitted) OR pre-emitted nodes (if .type is set)
   */
  ctx.fn.call = (closureExpr, args) => {
    const arity = args.length
    ensureType(arity)

    const t = `__clos${ctx.uniq++}`
    ctx.locals.set(t, 'f64')

    // Args: emit if AST, pass through if already emitted WASM node
    const emittedArgs = args.map(a => asF64(a?.type ? a : emit(a)))

    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, asF64(closureExpr)],
      ['call_indirect', ['type', `$ft${arity}`],
        ['local.get', `$${t}`],
        ...emittedArgs,
        ['call', '$__ptr_aux', ['local.get', `$${t}`]]]], 'f64')
  }
}
