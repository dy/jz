/**
 * jz:core - Module extension API
 *
 * Modules use these to register types, emitters, and stdlib functions.
 * ctx is first argument (context-threading style).
 *
 * @module core
 */

import { parse as parseWat } from 'watr'
import { emitExpr } from '../src/compile.js'

/**
 * Declare type signature
 * @param {Object} ctx - Compilation context
 * @param {string} name - Symbol name
 * @param {string} sig - Type signature: 'f64 -> f64' or 'f64'
 */
export function type(ctx, name, sig) {
  ctx.types[name] = parseSignature(sig)
}

/**
 * Register IR emitter (receives pre-emitted args)
 * @param {Object} ctx - Compilation context
 * @param {string} name - Symbol or operator
 * @param {Function} handler - (emittedArgs) => IR
 */
export function emit(ctx, name, handler) {
  ctx.emitters[name] = (args, c) => handler(args.map(a => emitExpr(a, c)))
}

/**
 * Register optimization transform
 * @param {Object} ctx - Compilation context
 * @param {string} name - Transform name
 * @param {Function} fn - (ir) => ir
 */
export function optimize(ctx, name, fn) {
  ctx.optimizers.push({ name, fn })
}

/**
 * Declare stdlib function and auto-register emitter
 * @param {Object} ctx - Compilation context
 * @param {string} name - JS function name (e.g. 'sin')
 * @param {string} wat - WAT function definition (must use $__name internally)
 */
export function func(ctx, name, wat) {
  const tree = parseWat(wat)
  ctx.funcs.push(tree)
  // Auto-register emitter: sin(x) -> (call $__sin <x>)
  ctx.emitters[name] = (args, c) => ['call', `$__${name}`, ...args.map(a => emitExpr(a, c))]
}

/**
 * Declare external host import
 * @param {Object} ctx - Compilation context
 * @param {string} mod - Module name
 * @param {string} name - Import name
 * @param {string} sig - Type signature
 */
export function extern(ctx, mod, name, sig) {
  const parsed = parseSignature(sig)
  const params = parsed.params.map(p => ['param', p])
  const results = Array.isArray(parsed.returns)
    ? parsed.returns.map(r => ['result', r])
    : parsed.returns ? [['result', parsed.returns]] : []
  ctx.imports.push([
    'import', `"${mod}"`, `"${name}"`,
    ['func', `$__${mod}_${name}`, ...params, ...results]
  ])
}

/**
 * Mark that memory is needed
 * @param {Object} ctx - Compilation context
 */
export function needsMemory(ctx) {
  ctx.needsMemory = true
}

/**
 * Parse type signature
 * Formats:
 *   'f64 -> f64'               single param, single return
 *   '(f64, f64) -> f64'        multi param
 *   'f64 -> (f64, i32)'        multi return
 *   '() -> f64'                no params
 *   'f64'                      constant (no arrow)
 */
function parseSignature(sig) {
  if (!sig.includes('->')) {
    return { params: [], returns: sig.trim() }
  }

  const [left, right] = sig.split('->').map(s => s.trim())

  // Parse params: 'f64' | '(f64, f64)' | '()'
  let params
  if (left[0] === '(' && left.at(-1) === ')') {
    const inner = left.slice(1, -1).trim()
    params = inner ? inner.split(',').map(s => s.trim()) : []
  } else {
    params = left ? [left] : []
  }

  // Parse returns: 'f64' | '(f64, i32)'
  let returns
  if (right[0] === '(' && right.at(-1) === ')') {
    returns = right.slice(1, -1).split(',').map(s => s.trim())
  } else {
    returns = right
  }

  return { params, returns }
}
