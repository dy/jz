/**
 * Closure code generation for jz compiler
 *
 * Closures in jz use NaN-boxed pointers with table indices:
 * - Closure value: NaN-box with [tableIdx:16][envLen:16][envOffset:32]
 * - Call: extract tableIdx for call_indirect, build env pointer from len+offset
 *
 * @module closures
 */

import { PTR_TYPE, wat, f64 } from './types.js'
import { callClosure as memCallClosure } from './memory.js'

/**
 * Generate WAT for calling a closure stored in a variable.
 *
 * @param {object} ctx - Compilation context
 * @param {function} gen - AST generator function
 * @param {function} genIdent - Identifier generator function
 * @param {string} name - Variable name containing the closure
 * @param {any[]} args - Array of AST argument nodes
 * @returns {object} Typed WAT value for the call result
 * @example genClosureCall(ctx, gen, genIdent, 'add', [[null, 1], [null, 2]])
 */
export function genClosureCall(ctx, gen, genIdent, name, args) {
  const argWats = args.map(a => String(f64(gen(a)))).join(' ')
  const closureVal = genIdent(name)
  return wat(memCallClosure(ctx, String(closureVal), argWats, args.length), 'f64')
}

/**
 * Generate WAT for calling a closure from an expression result.
 * Handles curried calls like a(1)(2) where a(1) returns a closure.
 *
 * @param {object} ctx - Compilation context
 * @param {function} gen - AST generator function
 * @param {object} closureVal - Typed WAT value containing closure (from previous call)
 * @param {any[]} args - Array of AST argument nodes
 * @returns {object} Typed WAT value for the call result
 * @example // For code: add(1)(2) where add = x => y => x + y
 *          // First call: genClosureCall returns closure
 *          // Second call: genClosureCallExpr(ctx, gen, closure, [[null,2]])
 */
export function genClosureCallExpr(ctx, gen, closureVal, args) {
  const argWats = args.map(a => String(f64(gen(a)))).join(' ')
  const remainingDepth = closureVal.schema?.closureDepth ?? 0
  const returnsClosure = remainingDepth > 0
  const resultType = returnsClosure ? 'closure' : 'f64'
  const code = memCallClosure(ctx, String(closureVal), argWats, args.length)
  return wat(code, resultType, returnsClosure ? { closureDepth: remainingDepth - 1 } : undefined)
}

/**
 * Create a closure value: funcref + environment.
 * NaN-boxed with table index + env pointer in linear memory.
 *
 * @param {object} ctx - Compilation context
 * @param {string} fnName - Name of the generated function
 * @param {string} envType - WASM type name for environment (unused in memory mode, kept for compat)
 * @param {object[]} envFields - Array of {name, index, type} for captured variables
 * @param {boolean} usesOwnEnv - True if closure uses parent's own env directly
 * @param {number} arity - Number of parameters (for functype)
 * @returns {object} Typed WAT value with type 'closure'
 * @example genClosureValue(ctx, '__anon0', '$env0', [{name:'x', index:0, type:'f64'}], false, 1)
 */
export function genClosureValue(ctx, fnName, envType, envFields, usesOwnEnv, arity) {
  ctx.usedFuncTable = true
  ctx.usedMemory = true
  if (!ctx.usedFuncTypes) ctx.usedFuncTypes = new Set()
  ctx.usedFuncTypes.add(arity)

  // Add function to table and get its index
  let tableIdx = ctx.funcTableEntries.indexOf(fnName)
  if (tableIdx === -1) {
    tableIdx = ctx.funcTableEntries.length
    ctx.funcTableEntries.push(fnName)
  }

  // No env - encode just table index, env length=0
  if (!envType || envFields.length === 0) {
    return wat(`(f64.reinterpret_i64 (i64.or
      (i64.const 0x7FF0000000000000)
      (i64.or
        (i64.shl (i64.const ${tableIdx}) (i64.const 32))
        (i64.const 0))))`, 'closure')
  }

  // Allocate env in memory
  const id = ctx.uniqueId++
  const tmpEnv = `$_closenv_${id}`
  ctx.addLocal(tmpEnv.slice(1), 'f64')

  // Store captured values in env
  let stores = ''
  for (let i = 0; i < envFields.length; i++) {
    const f = envFields[i]
    let val
    if (usesOwnEnv && ctx.hoistedVars && f.name in ctx.hoistedVars) {
      const offset = ctx.hoistedVars[f.name].index * 8
      val = `(f64.load (i32.add (call $__ptr_offset (local.get $__ownenv)) (i32.const ${offset})))`
    } else if (ctx.capturedVars && f.name in ctx.capturedVars) {
      const offset = ctx.capturedVars[f.name].index * 8
      val = `(f64.load (i32.add (call $__ptr_offset (local.get $__env)) (i32.const ${offset})))`
    } else {
      const loc = ctx.getLocal(f.name)
      if (loc) val = `(local.get $${loc.scopedName})`
      else {
        const glob = ctx.getGlobal(f.name)
        if (glob) val = `(global.get $${f.name})`
        else throw new Error(`Cannot capture ${f.name}: not found`)
      }
    }
    stores += `(f64.store (i32.add (call $__ptr_offset (local.get ${tmpEnv})) (i32.const ${i * 8})) ${val})\n      `
  }

  // Create closure: NaN-box with [0x7FF0][tableIdx:16][envLen:16][envOffset:20]
  return wat(`(block (result f64)
    (local.set ${tmpEnv} (call $__alloc (i32.const ${PTR_TYPE.CLOSURE}) (i32.const ${envFields.length})))
    ${stores}(f64.reinterpret_i64 (i64.or
      (i64.const 0x7FF0000000000000)
      (i64.or
        (i64.shl (i64.const ${tableIdx}) (i64.const 32))
        (i64.or
          (i64.shl (i64.extend_i32_u (call $__ptr_id (local.get ${tmpEnv}))) (i64.const 48))
          (i64.extend_i32_u (call $__ptr_offset (local.get ${tmpEnv}))))))))`, 'closure')
}
