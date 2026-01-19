/**
 * jz compiler - AST to WAT compilation
 *
 * Architecture:
 * - types.js: Type system, coercions (tv, asF64, asI32, truthy)
 * - analyze.js: Closure analysis (analyzeScope, findHoistedVars)
 * - ops.js: WAT operations (f64, i32, MATH_OPS)
 * - gc.js: GC-mode abstractions (nullRef, mkString, envGet, etc)
 * - context.js: Compilation context factory
 * - emit.js: WAT module assembly
 * - compile.js: Core AST->WAT generator and operators (this file)
 *
 * Flow: AST → analyze closures → generate WAT → assemble module
 */

import { FUNCTIONS } from './stdlib.js'
import { arrayMethods, stringMethods } from './methods/index.js'
import { PTR_TYPE, tv, fmtNum, asF64, asI32, truthy, conciliate, typeOf, watOf, isType, isF64, isI32, isString, isArray, isObject, isClosure, isRef, isRefArray, isNumeric, bothI32, isHeapRef, isArrayLike, hasSchema } from './types.js'
import { extractParams, analyzeScope, findHoistedVars } from './analyze.js'
import { f64, i32, MATH_OPS, GLOBAL_CONSTANTS } from './ops.js'
import { createContext } from './context.js'
import { assemble } from './emit.js'
import { nullRef, mkString, envGet, envSet, arrGet, arrLen, objGet, strCharAt } from './gc.js'

// Current compilation state (module-level for nested access)
export let ctx = null
export let opts = { gc: true }
export let gen = null

export { assemble };

// Set context only (for nested function generation)
export function setCtx(context) {
  const prev = ctx
  ctx = context
  return prev
}

// Public API
export function compile(ast, options = {}) {
  const { gc = true } = options
  const newOpts = { gc }
  const newCtx = createContext(gc)
  // Initialize shared state for method modules
  ctx = newCtx
  opts = newOpts
  gen = generate
  const [, bodyWat] = asF64(generate(ast))
  return assemble(bodyWat, newCtx, generateFunctions(), gc)
}


// Check if an AST node is a constant expression (can be computed at compile time)
function isConstant(ast) {
  if (ast == null) return true
  if (Array.isArray(ast) && ast[0] === undefined) return typeof ast[1] === 'number'
  if (typeof ast === 'string') return /^(true|false|null|undefined|Infinity|-Infinity|NaN)$/.test(ast) || !isNaN(Number(ast))
  if (!Array.isArray(ast)) return false
  const [op] = ast
  // Only certain operations are safe to evaluate at compile time
  if (op === '+' || op === '-' || op === '*' || op === '/' || op === '%') {
    return ast.slice(1).every(isConstant)
  }
  return false
}

// Evaluate a constant expression at compile time
function evalConstant(ast) {
  if (ast == null) return 0
  if (Array.isArray(ast) && ast[0] === undefined) return ast[1]
  if (typeof ast === 'string') {
    const val = parseFloat(ast)
    return isNaN(val) ? (ast === 'true' ? 1 : 0) : val
  }
  if (!Array.isArray(ast)) return 0
  const [op, ...args] = ast
  const vals = args.map(evalConstant)
  switch (op) {
    case '+': return vals[0] + vals[1]
    case '-': return vals.length === 1 ? -vals[0] : vals[0] - vals[1]
    case '*': return vals.reduce((a, b) => a * b, 1)
    case '/': return vals[0] / vals[1]
    case '%': return vals[0] % vals[1]
    default: return 0
  }
}

// Core generator: AST node → typed WAT value
function generate(ast) {
  if (ast == null) return tv('f64', '(f64.const 0)')
  if (Array.isArray(ast) && ast[0] === undefined) return genLiteral(ast[1])
  if (typeof ast === 'string') return genIdent(ast)
  if (!Array.isArray(ast)) throw new Error(`Invalid AST: ${JSON.stringify(ast)}`)
  const [op, ...args] = ast
  if (op in operators) return operators[op](args)
  throw new Error(`Unknown operator: ${op}`)
}

// Calculate closure depth: how many nested arrows before reaching a non-arrow expression
// Returns 0 for f64 result, 1+ for closure result
function closureDepth(body) {
  if (!Array.isArray(body) || body[0] !== '=>') return 0
  return 1 + closureDepth(body[2])  // body[2] is the arrow body
}

// Literals
function genLiteral(v) {
  if (v === null || v === undefined) return nullRef(opts.gc)
  if (typeof v === 'number') return tv('f64', `(f64.const ${fmtNum(v)})`)
  if (typeof v === 'boolean') return tv('i32', `(i32.const ${v ? 1 : 0})`)
  if (typeof v === 'string') return mkString(opts.gc, ctx, v)
  throw new Error(`Unsupported literal: ${JSON.stringify(v)}`)
}

// Identifiers
function genIdent(name) {
  if (name === 'null' || name === 'undefined') return nullRef(opts.gc)
  if (name === 'true') return tv('i32', '(i32.const 1)')
  if (name === 'false') return tv('i32', '(i32.const 0)')
  if (name in GLOBAL_CONSTANTS) return tv('f64', `(f64.const ${fmtNum(GLOBAL_CONSTANTS[name])})`)

  // Check if this is a hoisted variable (in our own env, for nested closure access)
  if (ctx.hoistedVars && name in ctx.hoistedVars) {
    const fieldIdx = ctx.hoistedVars[name]
    return tv('f64', envGet(opts.gc, ctx.ownEnvType, '$__ownenv', fieldIdx))
  }

  // Check if this is a captured variable (from closure environment passed to us)
  if (ctx.capturedVars && name in ctx.capturedVars) {
    const fieldIdx = ctx.capturedVars[name]
    const envVar = opts.gc ? '$__envcast' : '$__env'
    return tv('f64', envGet(opts.gc, ctx.currentEnv, envVar, fieldIdx))
  }

  const loc = ctx.getLocal(name)
  if (loc) return tv(loc.type, `(local.get $${loc.scopedName})`, ctx.localSchemas[loc.scopedName])
  const glob = ctx.getGlobal(name)
  if (glob) return tv(glob.type, `(global.get $${name})`)
  throw new Error(`Unknown identifier: ${name}`)
}

function resolveCall(namespace, name, args, receiver = null) {
  // Method calls
  if (receiver !== null) {
    const [rt, rw] = receiver

    // Dispatch to method modules
    const isArrayType = rt === 'array' || (!opts.gc && rt === 'f64')
    if (isArrayType && arrayMethods[name]) {
      const result = arrayMethods[name](rw, args)
      if (result) return result
    }
    if (rt === 'string' && stringMethods[name]) {
      const result = stringMethods[name](rw, args)
      if (result) return result
    }

    throw new Error(`Unknown method: .${name}`)
  }

  // Math namespace
  if (namespace === 'Math') {
    if (name in MATH_OPS.f64_unary && args.length === 1)
      return tv('f64', `(${MATH_OPS.f64_unary[name]} ${asF64(gen(args[0]))[1]})`)
    if (name in MATH_OPS.i32_unary && args.length === 1)
      return tv('i32', `(${MATH_OPS.i32_unary[name]} ${asI32(gen(args[0]))[1]})`)
    if (name in MATH_OPS.f64_binary && args.length === 2)
      return tv('f64', `(${MATH_OPS.f64_binary[name]} ${asF64(gen(args[0]))[1]} ${asF64(gen(args[1]))[1]})`)
    if (name in MATH_OPS.f64_binary && args.length > 2) {
      let result = asF64(gen(args[0]))[1]
      for (let i = 1; i < args.length; i++) result = `(${MATH_OPS.f64_binary[name]} ${result} ${asF64(gen(args[i]))[1]})`
      return tv('f64', result)
    }
    if (MATH_OPS.stdlib_unary.includes(name) && args.length === 1) {
      ctx.usedStdlib.push(name)
      return tv('f64', `(call $${name} ${asF64(gen(args[0]))[1]})`)
    }
    if (MATH_OPS.stdlib_binary.includes(name) && args.length === 2) {
      ctx.usedStdlib.push(name)
      return tv('f64', `(call $${name} ${asF64(gen(args[0]))[1]} ${asF64(gen(args[1]))[1]})`)
    }
    if (name === 'random' && args.length === 0) {
      ctx.usedStdlib.push('random')
      return tv('f64', '(call $random)')
    }
    throw new Error(`Unknown Math.${name}`)
  }

  // Number namespace
  if (namespace === 'Number') {
    if (name === 'isNaN' && args.length === 1) {
      const [, w] = asF64(gen(args[0]))
      return tv('i32', `(f64.ne ${w} ${w})`)
    }
    if (name === 'isFinite' && args.length === 1) {
      const [, w] = asF64(gen(args[0]))
      return tv('i32', `(i32.and (f64.eq ${w} ${w}) (f64.ne (f64.abs ${w}) (f64.const inf)))`)
    }
    if (name === 'isInteger' && args.length === 1) {
      ctx.usedStdlib.push('isInteger')
      return tv('i32', `(i32.trunc_f64_s (call $isInteger ${asF64(gen(args[0]))[1]}))`)
    }
    throw new Error(`Unknown Number.${name}`)
  }

  // Global functions
  if (namespace === null) {
    if (name === 'isNaN' || name === 'isFinite') return resolveCall('Number', name, args)
    if (name === 'Array' && args.length === 1) {
      ctx.usedArrayType = true
      if (opts.gc) {
        return tv('array', `(array.new $f64array (f64.const 0) ${asI32(gen(args[0]))[1]})`)
      } else {
        ctx.usedMemory = true
        return tv('f64', `(call $__alloc (i32.const ${PTR_TYPE.F64_ARRAY}) ${asI32(gen(args[0]))[1]})`)
      }
    }
    if (name === 'parseInt') {
      const val = gen(args[0])
      const radix = args.length >= 2 ? asI32(gen(args[1]))[1] : '(i32.const 10)'
      if (isString(val)) {
        ctx.usedStdlib.push('parseInt')
        ctx.usedStringType = true
        return tv('f64', `(call $parseInt ${val[1]} ${radix})`)
      }
      ctx.usedStdlib.push('parseIntFromCode')
      return tv('f64', `(call $parseIntFromCode ${asI32(val)[1]} ${radix})`)
    }
  }

  // User-defined function (including closures)
  if (namespace === null && name in ctx.functions) {
    const fn = ctx.functions[name]
    if (fn.closure) {
      // Closure call - need to pass environment
      if (args.length !== fn.params.length) throw new Error(`${name} expects ${fn.params.length} args`)
      const argWats = args.map(a => asF64(gen(a))[1]).join(' ')

      const { envFields, envType, usesOwnEnv } = fn.closure

      // If the closure uses our own env, pass it directly
      if (usesOwnEnv && ctx.ownEnvType) {
        if (opts.gc) {
          // Convert from (ref null) to (ref) for the call
          return tv('f64', `(call $${name} (ref.as_non_null (local.get $__ownenv)) ${argWats})`)
        } else {
          return tv('f64', `(call $${name} (local.get $__ownenv) ${argWats})`)
        }
      }

      // Otherwise, build a new environment with captured variables
      if (opts.gc) {
        // GC mode: create struct with captured values
        const envVals = envFields.map(f => {
          // Check our own hoisted vars first
          if (ctx.hoistedVars && f.name in ctx.hoistedVars) {
            const fieldIdx = ctx.hoistedVars[f.name]
            return `(struct.get ${ctx.ownEnvType} ${fieldIdx} (local.get $__ownenv))`
          }
          // Then check received env (capturedVars)
          if (ctx.capturedVars && f.name in ctx.capturedVars) {
            const fieldIdx = ctx.capturedVars[f.name]
            return `(struct.get ${ctx.currentEnv} ${fieldIdx} (local.get $__env))`
          }
          const loc = ctx.getLocal(f.name)
          if (loc) return `(local.get $${loc.scopedName})`
          const glob = ctx.getGlobal(f.name)
          if (glob) return `(global.get $${f.name})`
          throw new Error(`Cannot capture ${f.name}: not found`)
        }).join(' ')
        return tv('f64', `(call $${name} (struct.new ${envType} ${envVals}) ${argWats})`)
      } else {
        // gc:false mode: allocate env in memory
        ctx.usedMemory = true
        const envSize = envFields.length * 8
        const envVals = envFields.map((f, i) => {
          let val
          if (ctx.hoistedVars && f.name in ctx.hoistedVars) {
            const offset = ctx.hoistedVars[f.name] * 8
            val = `(f64.load (i32.add (call $__ptr_offset (local.get $__ownenv)) (i32.const ${offset})))`
          } else if (ctx.capturedVars && f.name in ctx.capturedVars) {
            const offset = ctx.capturedVars[f.name] * 8
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
          return `(f64.store (i32.add (global.get $__heap) (i32.const ${i * 8})) ${val})`
        }).join('\n        ')
        // Allocate env, store values, call function
        return tv('f64', `(block (result f64)
          ${envVals}
          (call $${name}
            (call $__mkptr (i32.const ${PTR_TYPE.CLOSURE}) (i32.const ${envFields.length}) (global.get $__heap))
            ${argWats})
          (global.set $__heap (i32.add (global.get $__heap) (i32.const ${envSize})))
        )`)
      }
    }
    // Regular function call
    if (args.length !== fn.params.length) throw new Error(`${name} expects ${fn.params.length} args`)
    const argWats = args.map(a => asF64(gen(a))[1]).join(' ')
    // Check if function returns a closure
    if (fn.returnsClosure) {
      const depth = (fn.closureDepth || 1) - 1
      if (opts.gc) {
        // Cast anyref result to (ref null $closure)
        ctx.usedClosureType = true
        return tv('closure', `(ref.cast (ref null $closure) (call $${name} ${argWats}))`, { closureDepth: depth })
      } else {
        // gc:false: closure is f64 NaN-boxed, but we track type for chained calls
        return tv('closure', `(call $${name} ${argWats})`, { closureDepth: depth })
      }
    }
    return tv('f64', `(call $${name} ${argWats})`)
  }

  throw new Error(`Unknown function: ${namespace ? namespace + '.' : ''}${name}`)
}

// Call a closure value stored in a variable
// gc:true: closure is (struct (field $fn funcref) (field $env anyref)), use call_ref
// gc:false: closure is NaN-box with table index and env ptr, use call_indirect
function genClosureCall(name, args) {
  const argWats = args.map(a => asF64(gen(a))[1]).join(' ')
  const numArgs = args.length

  // Get the closure value from the variable
  const closureVal = genIdent(name)

  if (opts.gc) {
    ctx.usedClosureType = true
    // Extract funcref and env from closure struct
    // We need function type based on arity: (func (param anyref) (param f64)* (result f64))
    const funcTypeName = `$fntype${numArgs}`
    if (!ctx.usedFuncTypes) ctx.usedFuncTypes = new Set()
    ctx.usedFuncTypes.add(numArgs)
    // call_ref the funcref with env + args
    // Need to handle both (ref $closure) and (ref null $closure) inputs
    const closureRef = isClosure(closureVal)
      ? `(ref.as_non_null ${closureVal[1]})`  // Cast to non-null if nullable
      : closureVal[1]
    return tv('f64', `(call_ref ${funcTypeName}
      (struct.get $closure $env ${closureRef})
      ${argWats}
      (ref.cast (ref ${funcTypeName}) (struct.get $closure $fn ${closureRef})))`)
  } else {
    ctx.usedFuncTable = true
    ctx.usedMemory = true
    // gc:false: closure is NaN-encoded {table_idx:16, env_offset:32}
    // Extract table index from bits 32-47 (shifted right by 32)
    // Extract env offset from bits 0-31
    const funcTypeName = `$fntype${numArgs}`
    if (!ctx.usedFuncTypes) ctx.usedFuncTypes = new Set()
    ctx.usedFuncTypes.add(numArgs)
    const id = ctx.loopCounter++
    const tmpClosure = `$_clos_${id}`
    const tmpI64 = `$_closi64_${id}`
    ctx.addLocal(tmpClosure.slice(1), 'f64')
    ctx.localDecls.push(`(local ${tmpI64} i64)`)
    // Decode: reinterpret to i64, extract table idx (bits 32-47) and env (bits 0-31)
    return tv('f64', `(block (result f64)
      (local.set ${tmpClosure} ${closureVal[1]})
      (local.set ${tmpI64} (i64.reinterpret_f64 (local.get ${tmpClosure})))
      (call_indirect (type ${funcTypeName})
        (call $__mkptr (i32.const ${PTR_TYPE.CLOSURE})
          (i32.wrap_i64 (i64.shr_u (local.get ${tmpI64}) (i64.const 48)))
          (i32.wrap_i64 (local.get ${tmpI64})))
        ${argWats}
        (i32.wrap_i64 (i64.and (i64.shr_u (local.get ${tmpI64}) (i64.const 32)) (i64.const 0xFFFF)))))`)
  }
}

// Call a closure value from an expression (not a variable)
// This handles cases like a(1)(2) where a(1) returns a closure
function genClosureCallExpr(closureVal, args) {
  const argWats = args.map(a => asF64(gen(a))[1]).join(' ')
  const numArgs = args.length
  // Check if we have closure depth info (stored as 3rd element for closure types)
  const remainingDepth = closureVal[2]?.closureDepth ?? 0

  if (opts.gc) {
    ctx.usedClosureType = true
    // Determine return type based on remaining depth
    const returnsClosure = remainingDepth > 0
    const funcTypeName = returnsClosure ? `$clfntype${numArgs}` : `$fntype${numArgs}`
    if (!ctx.usedFuncTypes) ctx.usedFuncTypes = new Set()
    ctx.usedFuncTypes.add(numArgs)
    if (returnsClosure) {
      if (!ctx.usedClFuncTypes) ctx.usedClFuncTypes = new Set()
      ctx.usedClFuncTypes.add(numArgs)
    }

    // Store the closure in a temp local to avoid re-evaluation
    const id = ctx.loopCounter++
    const tmpClosure = `$_closexpr_${id}`
    ctx.addLocal(tmpClosure.slice(1), 'closure')
    const closureRef = `(ref.as_non_null (local.get ${tmpClosure}))`

    if (returnsClosure) {
      return tv('closure', `(block (result (ref null $closure))
        (local.set ${tmpClosure} ${closureVal[1]})
        (ref.cast (ref null $closure) (call_ref ${funcTypeName}
          (struct.get $closure $env ${closureRef})
          ${argWats}
          (ref.cast (ref ${funcTypeName}) (struct.get $closure $fn ${closureRef})))))`, { closureDepth: remainingDepth - 1 })
    }
    return tv('f64', `(block (result f64)
      (local.set ${tmpClosure} ${closureVal[1]})
      (call_ref ${funcTypeName}
        (struct.get $closure $env ${closureRef})
        ${argWats}
        (ref.cast (ref ${funcTypeName}) (struct.get $closure $fn ${closureRef}))))`)
  } else {
    ctx.usedFuncTable = true
    ctx.usedMemory = true
    const funcTypeName = `$fntype${numArgs}`
    if (!ctx.usedFuncTypes) ctx.usedFuncTypes = new Set()
    ctx.usedFuncTypes.add(numArgs)
    const id = ctx.loopCounter++
    const tmpClosure = `$_closexpr_${id}`
    const tmpI64 = `$_closexpr_i64_${id}`
    ctx.addLocal(tmpClosure.slice(1), 'f64')
    ctx.localDecls.push(`(local ${tmpI64} i64)`)
    const returnsClosure = remainingDepth > 0
    const resultType = returnsClosure ? 'closure' : 'f64'
    return tv(resultType, `(block (result f64)
      (local.set ${tmpClosure} ${closureVal[1]})
      (local.set ${tmpI64} (i64.reinterpret_f64 (local.get ${tmpClosure})))
      (call_indirect (type ${funcTypeName})
        (call $__mkptr (i32.const ${PTR_TYPE.CLOSURE})
          (i32.wrap_i64 (i64.shr_u (local.get ${tmpI64}) (i64.const 48)))
          (i32.wrap_i64 (local.get ${tmpI64})))
        ${argWats}
        (i32.wrap_i64 (i64.and (i64.shr_u (local.get ${tmpI64}) (i64.const 32)) (i64.const 0xFFFF)))))`, returnsClosure ? { closureDepth: remainingDepth - 1 } : undefined)
  }
}

// Create a closure value (funcref + env for gc:true, table_idx + env_ptr for gc:false)
function genClosureValue(fnName, envType, envFields, usesOwnEnv, arity) {
  if (opts.gc) {
    ctx.usedClosureType = true
    // Track function type for funcref
    if (!ctx.usedFuncTypes) ctx.usedFuncTypes = new Set()
    ctx.usedFuncTypes.add(arity)

    // Build environment
    let envWat
    if (!envType || envFields.length === 0) {
      // No environment needed - use null anyref
      envWat = '(ref.null none)'
    } else if (usesOwnEnv && ctx.ownEnvType) {
      // Pass our own env directly
      envWat = '(local.get $__ownenv)'
    } else {
      // Build new env struct with captured values
      const envVals = envFields.map(f => {
        if (ctx.hoistedVars && f.name in ctx.hoistedVars) {
          const fieldIdx = ctx.hoistedVars[f.name]
          return `(struct.get ${ctx.ownEnvType} ${fieldIdx} (local.get $__ownenv))`
        }
        if (ctx.capturedVars && f.name in ctx.capturedVars) {
          const fieldIdx = ctx.capturedVars[f.name]
          // Use $__envcast in gc:true mode
          return `(struct.get ${ctx.currentEnv} ${fieldIdx} (local.get $__envcast))`
        }
        const loc = ctx.getLocal(f.name)
        if (loc) return `(local.get $${loc.scopedName})`
        const glob = ctx.getGlobal(f.name)
        if (glob) return `(global.get $${f.name})`
        throw new Error(`Cannot capture ${f.name}: not found`)
      }).join(' ')
      envWat = `(struct.new ${envType} ${envVals})`
    }

    // Create closure struct: (struct.new $closure funcref env)
    ctx.refFuncs.add(fnName) // Track for elem declare
    return tv('closure', `(struct.new $closure (ref.func $${fnName}) ${envWat})`)
  } else {
    // gc:false: NaN-encode table index + env pointer
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

    // Build environment in memory
    if (!envType || envFields.length === 0) {
      // No env - encode just table index, env length=0
      return tv('closure', `(f64.reinterpret_i64 (i64.or
        (i64.const 0x7FF0000000000000)
        (i64.or
          (i64.shl (i64.const ${tableIdx}) (i64.const 32))
          (i64.const 0))))`)
    }

    // Allocate env in memory
    const id = ctx.loopCounter++
    const tmpEnv = `$_closenv_${id}`
    ctx.addLocal(tmpEnv.slice(1), 'f64')

    // Store captured values in env
    let stores = ''
    for (let i = 0; i < envFields.length; i++) {
      const f = envFields[i]
      let val
      if (usesOwnEnv && ctx.hoistedVars && f.name in ctx.hoistedVars) {
        const offset = ctx.hoistedVars[f.name] * 8
        val = `(f64.load (i32.add (call $__ptr_offset (local.get $__ownenv)) (i32.const ${offset})))`
      } else if (ctx.capturedVars && f.name in ctx.capturedVars) {
        const offset = ctx.capturedVars[f.name] * 8
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

    // Create closure: NaN-box with [0x7FF][tableIdx:16][envLen:16][envOffset:20]
    // Actually simpler: use lower 32 bits for env offset, bits 32-47 for table idx, bits 48-51 for env length
    return tv('closure', `(block (result f64)
      (local.set ${tmpEnv} (call $__alloc (i32.const ${PTR_TYPE.CLOSURE}) (i32.const ${envFields.length})))
      ${stores}(f64.reinterpret_i64 (i64.or
        (i64.const 0x7FF0000000000000)
        (i64.or
          (i64.shl (i64.const ${tableIdx}) (i64.const 32))
          (i64.or
            (i64.shl (i64.extend_i32_u (call $__ptr_len (local.get ${tmpEnv}))) (i64.const 48))
            (i64.extend_i32_u (call $__ptr_offset (local.get ${tmpEnv}))))))))`)
  }
}

// Operators
const operators = {
  '()'([fn, ...args]) {
    // Parenthesized expression: (expr) parsed as ['()', expr]
    if (args.length === 0 && Array.isArray(fn)) return gen(fn)

    // Expand comma-separated args: [',', a, b, c] -> [a, b, c]
    args = args.filter(a => a != null).flatMap(a => Array.isArray(a) && a[0] === ',' ? a.slice(1) : [a])

    let name = null, namespace = null, receiver = null
    if (typeof fn === 'string') name = fn
    else if (Array.isArray(fn) && fn[0] === '.') {
      const [, obj, method] = fn
      if (typeof obj === 'string' && (obj === 'Math' || obj === 'Number' || obj === 'Array')) {
        namespace = obj
        name = method
      } else {
        receiver = gen(obj)
        name = method
      }
    } else if (Array.isArray(fn)) {
      // Callee is a complex expression (e.g., a(1)(2) where a(1) returns a closure)
      // Generate the closure expression and call it directly
      const callee = gen(fn)
      if (isClosure(callee)) {
        // Call the closure value from the expression
        return genClosureCallExpr(callee, args)
      }
      throw new Error(`Cannot call non-closure expression: ${JSON.stringify(fn)}`)
    }
    if (!name) throw new Error(`Invalid call: ${JSON.stringify(fn)}`)

    // Check if this is a closure value call (variable holding a closure, not a known function)
    if (namespace === null && !(name in ctx.functions)) {
      // Check if it's a local or captured variable
      const loc = ctx.getLocal(name)
      const captured = ctx.capturedVars && name in ctx.capturedVars
      const hoisted = ctx.hoistedVars && name in ctx.hoistedVars
      if (loc || captured || hoisted) {
        // This is calling a closure value stored in a variable
        return genClosureCall(name, args)
      }
    }

    return resolveCall(namespace, name, args, receiver)
  },

  '['(elements) {
    const gens = elements.map(e => gen(e))
    const elementTypes = gens.map(g => typeOf(g))
    const hasRefTypes = gens.some(g => isHeapRef(g) || isString(g))
    const hasNestedTypes = hasRefTypes  // Alias for gc:false code

    if (opts.gc) {
      if (hasRefTypes) {
        // gc:true with nested refs: use $anyarray (array of anyref) for maximum flexibility
        ctx.usedArrayType = true
        ctx.usedRefArrayType = true
        const vals = gens.map(g => {
          if (isHeapRef(g)) {
            return g[1]  // Already a ref
          } else if (isString(g)) {
            return g[1]  // String is also a ref
          } else {
            // Wrap scalar in single-element f64 array to make it a ref
            ctx.usedArrayType = true
            return `(array.new_fixed $f64array 1 ${asF64(g)[1]})`
          }
        })
        // Track element types AND schemas for proper nested indexing
        const elementSchemas = gens.map(g => ({ type: g[0], schema: g[2] }))
        return tv('refarray', `(array.new_fixed $anyarray ${vals.length} ${vals.join(' ')})`, elementSchemas)
      } else {
        // gc:true: homogeneous f64 array
        ctx.usedArrayType = true
        const vals = gens.map(g => asF64(g)[1])
        return tv('array', `(array.new_fixed $f64array ${vals.length} ${vals.join(' ')})`)
      }
    } else {
      // gc:false: all values are f64 (either normal floats or NaN-encoded pointers)
      // Return as type 'f64' not 'array' since pointers are f64
      const isStatic = elements.every(isConstant)
      if (isStatic && !hasNestedTypes) {
        // Static f64 array - store in data segment
        ctx.usedMemory = true
        const arrayId = Object.keys(ctx.staticArrays).length
        const values = elements.map(evalConstant)
        const offset = 4096 + (arrayId * 64)
        ctx.staticArrays[arrayId] = { offset, values }
        return tv('f64', `(call $__mkptr (i32.const ${PTR_TYPE.F64_ARRAY}) (i32.const ${values.length}) (i32.const ${offset}))`, values.map(() => ({ type: 'f64' })))
      } else if (hasNestedTypes) {
        // Mixed-type array: store all values (numbers as f64, pointers as NaN-encoded)
        // REF_ARRAY stores 8-byte slots, can hold both f64 values and pointer NaNs
        ctx.usedMemory = true
        const id = ctx.loopCounter++
        const tmp = `$_arr_${id}`
        ctx.addLocal(tmp.slice(1), 'f64')
        let stores = ''
        const elementSchema = []
        for (let i = 0; i < gens.length; i++) {
          const [type, w, schemaId] = gens[i]
          // For nested arrays/objects, value is already a pointer (NaN-encoded)
          // For scalars, convert to f64 but leave as normal IEEE 754 (not NaN)
          const val = (type === 'array' || type === 'object' || type === 'string') ? w : asF64(gens[i])[1]
          stores += `(f64.store (i32.add (call $__ptr_offset (local.get ${tmp})) (i32.const ${i * 8})) ${val})\n      `
          if (type === 'object' && schemaId !== undefined) elementSchema.push({ type: 'object', id: schemaId })
          else elementSchema.push({ type })
        }
        return tv('f64', `(block (result f64)
      (local.set ${tmp} (call $__alloc (i32.const ${PTR_TYPE.REF_ARRAY}) (i32.const ${gens.length})))
      ${stores}(local.get ${tmp}))`, elementSchema)
      } else {
        // Dynamic homogeneous f64 array
        ctx.usedMemory = true
        const id = ctx.loopCounter++
        const tmp = `$_arr_${id}`
        ctx.addLocal(tmp.slice(1), 'f64')
        let stores = ''
        for (let i = 0; i < gens.length; i++) {
          const [, w] = asF64(gens[i])
          stores += `(f64.store (i32.add (call $__ptr_offset (local.get ${tmp})) (i32.const ${i * 8})) ${w})\n      `
        }
        return tv('f64', `(block (result f64)
      (local.set ${tmp} (call $__alloc (i32.const ${PTR_TYPE.F64_ARRAY}) (i32.const ${gens.length})))
      ${stores}(local.get ${tmp}))`, gens.map(() => ({ type: 'f64' })))
      }
    }
  },

  '{'(props) {
    if (props.length === 0) return nullRef(opts.gc)
    ctx.usedArrayType = true
    const keys = props.map(p => p[0])
    const vals = props.map(p => asF64(gen(p[1]))[1])
    const objId = ctx.objectCounter++
    ctx.objectSchemas[objId] = keys
    if (opts.gc) {
      return tv('object', `(array.new_fixed $f64array ${vals.length} ${vals.join(' ')})`, objId)
    } else {
      // gc:false - object is f64 array with schema tracking
      ctx.usedMemory = true
      const id = ctx.loopCounter++
      const tmp = `$_obj_${id}`
      ctx.addLocal(tmp.slice(1), 'f64')
      let stores = ''
      for (let i = 0; i < vals.length; i++) {
        stores += `(f64.store (i32.add (call $__ptr_offset (local.get ${tmp})) (i32.const ${i * 8})) ${vals[i]})\n      `
      }
      return tv('object', `(block (result f64)
      (local.set ${tmp} (call $__alloc (i32.const ${PTR_TYPE.OBJECT}) (i32.const ${vals.length})))
      ${stores}(local.get ${tmp}))`, objId)
    }
  },

  '[]'([arr, idx]) {
    const a = gen(arr), [, iw] = asI32(gen(idx))
    if (opts.gc) {
      if (isString(a)) {
        ctx.usedStringType = true
        return tv('i32', strCharAt(true, a[1], iw))
      }
      if (isRefArray(a)) {
        // Indexing into anyarray - returns anyref, need to cast based on element type
        ctx.usedRefArrayType = true
        ctx.usedArrayType = true
        // Try to determine element type from schema
        const schema = a[2]  // Array of element types
        let litIdx = null
        if (isConstant(idx)) {
          const v = evalConstant(idx)
          litIdx = Number.isFinite(v) ? (v | 0) : null
        }

        // Get element info from schema - schema is array of {type, schema}
        const elemInfo = (Array.isArray(schema) && litIdx !== null) ? schema[litIdx] : null
        const elemType = elemInfo ? elemInfo.type : null
        const elemSchema = elemInfo ? elemInfo.schema : null

        // For dynamic index, check if all elements have same type
        const uniformType = Array.isArray(schema) && schema.length > 0 && schema.every(e => e.type === schema[0].type) ? schema[0].type : null
        const uniformSchema = uniformType && schema[0].schema
        const effectiveType = elemType || uniformType
        const effectiveSchema = elemSchema || uniformSchema

        if (effectiveType === 'array') {
          return tv('array', `(ref.cast (ref $f64array) (array.get $anyarray ${a[1]} ${iw}))`)
        } else if (effectiveType === 'refarray') {
          return tv('refarray', `(ref.cast (ref $anyarray) (array.get $anyarray ${a[1]} ${iw}))`, effectiveSchema)
        } else if (effectiveType === 'object') {
          return tv('object', `(ref.cast (ref $f64array) (array.get $anyarray ${a[1]} ${iw}))`)
        } else if (effectiveType === 'string') {
          ctx.usedStringType = true
          return tv('string', `(ref.cast (ref $string) (array.get $anyarray ${a[1]} ${iw}))`)
        } else if (effectiveType === 'f64' || effectiveType === 'i32') {
          return tv('f64', `(array.get $f64array (ref.cast (ref $f64array) (array.get $anyarray ${a[1]} ${iw})) (i32.const 0))`)
        } else {
          return tv('array', `(ref.cast (ref $f64array) (array.get $anyarray ${a[1]} ${iw}))`)
        }
      }
      ctx.usedArrayType = true
      return tv('f64', arrGet(true, a[1], iw))
    } else {
      // gc:false - load from memory
      ctx.usedMemory = true
      const schema = a[2]
      let litIdx = null
      if (isConstant(idx)) {
        const v = evalConstant(idx)
        litIdx = Number.isFinite(v) ? (v | 0) : null
      }
      if (Array.isArray(schema) && litIdx !== null) {
        const elem = schema[litIdx]
        if (elem && elem.type === 'object' && elem.id !== undefined) {
          return tv('object', `(f64.load (i32.add (call $__ptr_offset ${a[1]}) (i32.const ${litIdx * 8})))`, elem.id)
        }
      }
      if (isString(a)) {
        return tv('i32', strCharAt(false, a[1], iw))
      }
      return tv('f64', arrGet(false, a[1], iw))
    }
  },

  '?.[]'([arr, idx]) {
    const [at, aw] = gen(arr), [, iw] = asI32(gen(idx))
    if (opts.gc) {
      ctx.usedArrayType = true
      return tv('f64', `(if (result f64) (ref.is_null ${aw}) (then (f64.const 0)) (else (array.get $f64array ${aw} ${iw})))`)
    } else {
      // gc:false - check if pointer is 0 (null)
      ctx.usedMemory = true
      return tv('f64', `(if (result f64) (f64.eq ${aw} (f64.const 0)) (then (f64.const 0)) (else (f64.load (i32.add (call $__ptr_offset ${aw}) (i32.shl ${iw} (i32.const 3))))))`)
    }
  },

  '.'([obj, prop]) {
    if (obj === 'Math' && prop in MATH_OPS.constants)
      return tv('f64', `(f64.const ${fmtNum(MATH_OPS.constants[prop])})`)
    const o = gen(obj)
    if (prop === 'length') {
      if (isArray(o) || (isString(o) && opts.gc)) {
        if (isArray(o)) ctx.usedArrayType = true
        else ctx.usedStringType = true
        return tv('i32', arrLen(opts.gc, o[1]))
      } else if (isString(o) || isF64(o)) {
        ctx.usedMemory = true
        return tv('i32', arrLen(false, o[1]))  // gc:false uses ptr_len
      }
      throw new Error(`Cannot get length of ${typeOf(o)}`)
    }
    if (isObject(o) && hasSchema(o)) {
      const schema = ctx.objectSchemas[o[2]]
      if (schema) {
        const idx = schema.indexOf(prop)
        if (idx >= 0) {
          if (opts.gc) ctx.usedArrayType = true
          else ctx.usedMemory = true
          return tv('f64', objGet(opts.gc, o[1], idx))
        }
      }
    }
    throw new Error(`Invalid property: .${prop}`)
  },

  '?.'([obj, prop]) {
    const o = gen(obj)
    if (prop === 'length') {
      if (opts.gc) {
        if (isArray(o) || isRef(o)) {
          ctx.usedArrayType = true
          return tv('f64', `(if (result f64) (ref.is_null ${o[1]}) (then (f64.const 0)) (else (f64.convert_i32_s (array.len ${o[1]}))))`)
        }
      } else {
        // gc:false: arrays and strings are f64 pointers
        if (isF64(o) || isString(o)) {
          ctx.usedMemory = true
          return tv('f64', `(if (result f64) (f64.eq ${o[1]} (f64.const 0)) (then (f64.const 0)) (else (f64.convert_i32_s (call $__ptr_len ${o[1]}))))`)
        }
      }
    }
    return o
  },

  ','(args) {
    let code = ''
    for (let i = 0; i < args.length - 1; i++) {
      const arg = args[i]
      if (Array.isArray(arg) && arg[0] === '=') code += genAssign(arg[1], arg[2], false)
      else code += `(drop ${gen(arg)[1]})\n    `
    }
    const last = gen(args[args.length - 1])
    return tv(last[0], code + last[1], last[2])
  },

  '?'([cond, then, els]) {
    const [, cw] = truthy(gen(cond)), [[t, tw], [, ew]] = conciliate(gen(then), gen(els))
    return tv(t, `(if (result ${t}) ${cw} (then ${tw}) (else ${ew}))`)
  },

  '='([target, value]) { return genAssign(target, value, true) },

  'function'([name, params, body]) {
    ctx.functions[name] = { params: extractParams(params), body, exported: true }
    return tv('f64', '(f64.const 0)')
  },

  '=>'([params, body]) {
    // Arrow function as expression - create a closure value
    // This is for cases like: `add = x => (y => x + y)` where the inner arrow is returned
    const fnParams = extractParams(params)

    // Analyze for captured variables
    const localNames = Object.keys(ctx.locals)
    const capturedNames = ctx.capturedVars ? Object.keys(ctx.capturedVars) : []
    const hoistedNames = ctx.hoistedVars ? Object.keys(ctx.hoistedVars) : []
    const outerDefined = new Set([...localNames, ...capturedNames, ...hoistedNames])

    const analysis = analyzeScope(body, new Set(fnParams), true)
    const captured = [...analysis.free].filter(v => outerDefined.has(v) && !fnParams.includes(v))

    // Generate unique name for anonymous closure
    const closureName = `__anon${ctx.closureCounter++}`

    // Determine environment
    let envType, envFields
    const allFromOwnEnv = ctx.hoistedVars && captured.length > 0 && captured.every(v => v in ctx.hoistedVars)

    if (captured.length === 0) {
      // No captures - simple funcref, null env
      envType = null
      envFields = []
    } else if (allFromOwnEnv) {
      envType = ctx.ownEnvType
      envFields = ctx.ownEnvFields
    } else {
      const envId = ctx.closureCounter++
      envType = `$env${envId}`
      envFields = captured.map((v, i) => ({ name: v, index: i }))
      if (opts.gc) {
        ctx.closureEnvTypes.push({ id: envId, fields: captured })
      }
    }

    // Register the lifted function
    ctx.functions[closureName] = {
      params: fnParams,
      body,
      exported: false,
      closure: captured.length > 0 ? { envType, envFields, captured, usesOwnEnv: allFromOwnEnv } : null
    }

    // Return closure value
    return genClosureValue(closureName, envType, envFields, allFromOwnEnv, fnParams.length)
  },

  'return'([value]) {
    const retVal = value !== undefined ? asF64(gen(value)) : tv('f64', '(f64.const 0)')
    // If inside a function with a return label, use br to exit early
    if (ctx.returnLabel) {
      return tv('f64', `(br ${ctx.returnLabel} ${retVal[1]})`)
    }
    return retVal
  },

  // Unary
  'u+'([a]) { return asF64(gen(a)) },
  'u-'([a]) { const [t, w] = gen(a); return t === 'i32' ? ['i32', `(i32.sub (i32.const 0) ${w})`] : ['f64', `(f64.neg ${asF64([t, w])[1]})`] },
  '!'([a]) { return ['i32', `(i32.eqz ${truthy(gen(a))[1]})`] },
  '~'([a]) { return ['i32', `(i32.xor ${asI32(gen(a))[1]} (i32.const -1))`] },

  // Arithmetic
  '+'([a, b]) { const va = gen(a), vb = gen(b); return bothI32(va, vb) ? i32.add(va, vb) : f64.add(va, vb) },
  '-'([a, b]) { const va = gen(a), vb = gen(b); return bothI32(va, vb) ? i32.sub(va, vb) : f64.sub(va, vb) },
  '*'([a, b]) { const va = gen(a), vb = gen(b); return bothI32(va, vb) ? i32.mul(va, vb) : f64.mul(va, vb) },
  '/'([a, b]) { return f64.div(gen(a), gen(b)) },
  '%'([a, b]) { return ['f64', `(call $f64.rem ${asF64(gen(a))[1]} ${asF64(gen(b))[1]})`] },
  '**'([a, b]) { ctx.usedStdlib.push('pow'); return ['f64', `(call $pow ${asF64(gen(a))[1]} ${asF64(gen(b))[1]})`] },

  // Comparisons
  '=='([a, b]) {
    // Special-case: typeof comparison with string literal
    // typeof returns type code internally, compare with code directly
    const isTypeofA = Array.isArray(a) && a[0] === 'typeof'
    const isStringLiteralB = Array.isArray(b) && b[0] === undefined && typeof b[1] === 'string'
    if (isTypeofA && isStringLiteralB) {
      const s = b[1]
      const code = s === 'undefined' ? 0 : s === 'number' ? 1 : s === 'string' ? 2 : s === 'boolean' ? 3 : s === 'object' ? 4 : s === 'function' ? 5 : null
      if (code !== null) {
        // Check for literal null/undefined first (before gen)
        const typeofArg = a[1]
        if (Array.isArray(typeofArg) && typeofArg[0] === undefined &&
            (typeofArg[1] === null || typeofArg[1] === undefined)) {
          // typeof null === "undefined" or typeof undefined === "undefined"
          return tv('i32', `(i32.const ${code === 0 ? 1 : 0})`)
        }
        // Check for NaN/Infinity constants - parser represents them as [null, null]
        // In gc:false, these are always numbers (not pointers)
        if (Array.isArray(typeofArg) && typeofArg[0] === null && typeofArg[1] === null) {
          // Could be null, undefined, NaN, or Infinity - but at AST level we can't tell
          // However, we know the runtime value: null/undefined generate 0, NaN/Infinity generate nan/inf
          // At runtime, we check: if not NaN → number; if NaN with type=0 → number; else object
          // For compile-time constant folding, we can't know here, so fall through to runtime check
        }
        // Get type code without generating string
        const val = gen(typeofArg)
        let typeCode
        if (!opts.gc && isF64(val)) {
          // gc:false: f64 might be a regular number, the NaN number, or a NaN-boxed pointer
          // Check using our pointer detection: type > 0 means pointer
          // If f64.eq x x is true → regular number (type 1)
          // If f64.eq x x is false → NaN pattern:
          //   - type field = 0 → canonical NaN number (type 1)
          //   - type field > 0 → pointer (type 4 = object)
          ctx.usedMemory = true
          typeCode = `(if (result i32) (f64.eq ${val[1]} ${val[1]})
            (then (i32.const 1))
            (else (select (i32.const 4) (i32.const 1) (call $__is_pointer ${val[1]}))))`
        } else if (isF64(val)) typeCode = '(i32.const 1)'
        else if (isI32(val)) typeCode = '(i32.const 3)'
        else if (isString(val)) typeCode = '(i32.const 2)'
        else if (isRef(val)) typeCode = '(i32.const 0)'
        else if (isArray(val) || isObject(val)) typeCode = '(i32.const 4)'
        else typeCode = '(i32.const 1)'
        return tv('i32', `(i32.eq ${typeCode} (i32.const ${code}))`)
      }
    }
    // Swap check: string literal on left
    const isStringLiteralA = Array.isArray(a) && a[0] === undefined && typeof a[1] === 'string'
    const isTypeofB = Array.isArray(b) && b[0] === 'typeof'
    if (isStringLiteralA && isTypeofB) {
      return operators['==']([b, a])  // Swap and recurse
    }
    const va = gen(a), vb = gen(b)
    // String comparison: for interned strings, compare string IDs
    if (isString(va) && isString(vb)) {
      if (opts.gc) {
        return tv('i32', `(ref.eq ${va[1]} ${vb[1]})`)
      } else {
        return tv('i32', `(i64.eq (i64.reinterpret_f64 ${va[1]}) (i64.reinterpret_f64 ${vb[1]}))`)
      }
    }
    // Array/object comparison: reference equality
    if ((isArray(va) || isObject(va)) && (isArray(vb) || isObject(vb))) {
      if (opts.gc) {
        return tv('i32', `(ref.eq ${va[1]} ${vb[1]})`)
      } else {
        return tv('i32', `(i64.eq (i64.reinterpret_f64 ${va[1]}) (i64.reinterpret_f64 ${vb[1]}))`)
      }
    }
    // gc:false f64 comparison: use i64.eq to handle NaN-boxed pointers correctly
    if (!opts.gc && isF64(va) && isF64(vb)) {
      return tv('i32', `(i64.eq (i64.reinterpret_f64 ${va[1]}) (i64.reinterpret_f64 ${vb[1]}))`)
    }
    return bothI32(va, vb) ? i32.eq(va, vb) : f64.eq(va, vb)
  },
  '==='([a, b]) { return operators['==']([a, b]) },
  '!='([a, b]) {
    // Special-case typeof != string
    const isTypeofA = Array.isArray(a) && a[0] === 'typeof'
    const isStringLiteralB = Array.isArray(b) && b[0] === undefined && typeof b[1] === 'string'
    if (isTypeofA && isStringLiteralB) {
      const eq = operators['==']([a, b])
      return tv('i32', `(i32.eqz ${eq[1]})`)
    }
    const isStringLiteralA = Array.isArray(a) && a[0] === undefined && typeof a[1] === 'string'
    const isTypeofB = Array.isArray(b) && b[0] === 'typeof'
    if (isStringLiteralA && isTypeofB) {
      return operators['!=']([b, a])
    }
    const va = gen(a), vb = gen(b)
    // String comparison
    if (isString(va) && isString(vb)) {
      if (opts.gc) {
        return tv('i32', `(i32.eqz (ref.eq ${va[1]} ${vb[1]}))`)
      } else {
        return tv('i32', `(i64.ne (i64.reinterpret_f64 ${va[1]}) (i64.reinterpret_f64 ${vb[1]}))`)
      }
    }
    // Array/object comparison: reference inequality
    if ((isArray(va) || isObject(va)) && (isArray(vb) || isObject(vb))) {
      if (opts.gc) {
        return tv('i32', `(i32.eqz (ref.eq ${va[1]} ${vb[1]}))`)
      } else {
        return tv('i32', `(i64.ne (i64.reinterpret_f64 ${va[1]}) (i64.reinterpret_f64 ${vb[1]}))`)
      }
    }
    // gc:false f64 comparison: use i64.ne to handle NaN-boxed pointers correctly
    if (!opts.gc && isF64(va) && isF64(vb)) {
      return tv('i32', `(i64.ne (i64.reinterpret_f64 ${va[1]}) (i64.reinterpret_f64 ${vb[1]}))`)
    }
    return bothI32(va, vb) ? i32.ne(va, vb) : f64.ne(va, vb)
  },
  '!=='([a, b]) { return operators['!=']([a, b]) },
  '<'([a, b]) { const va = gen(a), vb = gen(b); return bothI32(va, vb) ? i32.lt_s(va, vb) : f64.lt(va, vb) },
  '<='([a, b]) { const va = gen(a), vb = gen(b); return bothI32(va, vb) ? i32.le_s(va, vb) : f64.le(va, vb) },
  '>'([a, b]) { const va = gen(a), vb = gen(b); return bothI32(va, vb) ? i32.gt_s(va, vb) : f64.gt(va, vb) },
  '>='([a, b]) { const va = gen(a), vb = gen(b); return bothI32(va, vb) ? i32.ge_s(va, vb) : f64.ge(va, vb) },

  // Bitwise
  '&'([a, b]) { return i32.and(gen(a), gen(b)) },
  '|'([a, b]) { return i32.or(gen(a), gen(b)) },
  '^'([a, b]) { return i32.xor(gen(a), gen(b)) },
  '<<'([a, b]) { return i32.shl(gen(a), gen(b)) },
  '>>'([a, b]) { return i32.shr_s(gen(a), gen(b)) },
  '>>>'([a, b]) { return i32.shr_u(gen(a), gen(b)) },

  // Logical
  '&&'([a, b]) {
    const va = gen(a), vb = gen(b), [, cw] = truthy(va), [[t, aw], [, bw]] = conciliate(va, vb)
    return [t, `(if (result ${t}) ${cw} (then ${bw}) (else (${t}.const 0)))`]
  },
  '||'([a, b]) {
    const va = gen(a), vb = gen(b), [, cw] = truthy(va), [[t, aw], [, bw]] = conciliate(va, vb)
    return [t, `(if (result ${t}) ${cw} (then ${aw}) (else ${bw}))`]
  },
  '??'([a, b]) { const va = gen(a); return isRef(va) ? gen(b) : va },

  // For loop
  'for'([init, cond, step, body]) {
    let code = ''
    // For loop creates its own scope for let/const declarations
    ctx.pushScope()
    if (init) {
      if (Array.isArray(init) && init[0] === '=') code += genLoopInit(init[1], init[2])
      else if (Array.isArray(init) && (init[0] === 'let' || init[0] === 'const')) {
        // Handle let/const in for init - declare in loop scope
        const [, assign] = init
        const [, name, value] = assign
        if (typeof name === 'string') {
          const scopedName = ctx.declareVar(name, init[0] === 'const')
          const val = gen(value)
          ctx.addLocal(scopedName, val[0])
          code += `(local.set $${scopedName} ${asF64(val)[1]})\n    `
        }
      }
      else code += `(drop ${gen(init)[1]})\n    `
    }
    const id = ctx.loopCounter++
    const result = `$_for_result_${id}`
    ctx.addLocal(result.slice(1), 'f64')

    code += `(block $break_${id} (loop $continue_${id}\n      `
    if (cond) code += `(br_if $break_${id} (i32.eqz ${truthy(gen(cond))[1]}))\n      `
    code += `(local.set ${result} ${asF64(gen(body))[1]})\n      `
    if (step) {
      if (Array.isArray(step) && step[0] === '=') code += genAssign(step[1], step[2], false)
      else if (Array.isArray(step) && step[0].endsWith('=')) {
        const baseOp = step[0].slice(0, -1)
        code += genAssign(step[1], [baseOp, step[1], step[2]], false)
      } else code += `(drop ${gen(step)[1]})\n      `
    }
    code += `(br $continue_${id})\n    ))\n    (local.get ${result})`
    ctx.popScope()
    return tv('f64', code)
  },

  // While loop
  'while'([cond, body]) {
    const id = ctx.loopCounter++
    const result = `$_while_result_${id}`
    ctx.addLocal(result.slice(1), 'f64')
    return tv('f64', `(block $break_${id} (loop $continue_${id}
      (br_if $break_${id} (i32.eqz ${truthy(gen(cond))[1]}))
      (local.set ${result} ${asF64(gen(body))[1]})
      (br $continue_${id})))
    (local.get ${result})`)
  },

  // Switch statement
  'switch'([discriminant, ...cases]) {
    const id = ctx.loopCounter++
    const result = `$_switch_result_${id}`
    const discrim = `$_switch_discrim_${id}`
    ctx.addLocal(result.slice(1), 'f64')
    ctx.addLocal(discrim.slice(1), 'f64')

    let code = `(local.set ${discrim} ${asF64(gen(discriminant))[1]})\n    `
    code += `(local.set ${result} (f64.const 0))\n    `
    code += `(block $break_${id}\n      `

    // Store loop ID for break statements
    const switchId = id

    // Process cases
    for (const caseNode of cases) {
      if (Array.isArray(caseNode) && caseNode[0] === 'case') {
        const [, test, consequent] = caseNode
        const caseId = ctx.loopCounter++
        code += `(block $case_${caseId}\n        `
        code += `(br_if $case_${caseId} ${f64.ne(['f64', `(local.get ${discrim})`], gen(test))[1]})\n        `
        // Execute consequent - handle as statement sequence
        const saveId = ctx.loopCounter
        ctx.loopCounter = switchId + 1  // So break finds $break_{switchId}

        // If consequent is a statement list (;), execute each statement
        if (Array.isArray(consequent) && consequent[0] === ';') {
          const stmts = consequent.slice(1).filter((s, i) => i === 0 || (s !== null && typeof s !== 'number'))
          for (let i = 0; i < stmts.length; i++) {
            const stmt = stmts[i]
            if (Array.isArray(stmt) && stmt[0] === 'break') {
              code += `(br $break_${switchId})\n        `
            } else if (Array.isArray(stmt) && stmt[0] === '=') {
              code += genAssign(stmt[1], stmt[2], false)
            } else if (stmt !== null) {
              // All non-break statements should set the result
              code += `(local.set ${result} ${asF64(gen(stmt))[1]})\n        `
            }
          }
        } else {
          code += `(local.set ${result} ${asF64(gen(consequent))[1]})\n        `
        }

        ctx.loopCounter = saveId  // Restore
        code += `)\n      `
      } else if (Array.isArray(caseNode) && caseNode[0] === 'default') {
        const [, consequent] = caseNode
        code += `(local.set ${result} ${asF64(gen(consequent))[1]})\n      `
      }
    }

    code += `)\n    (local.get ${result})`
    return tv('f64', code)
  },

  // Block with scope
  '{}'([body]) {
    ctx.pushScope()
    let result
    if (!Array.isArray(body) || body[0] !== ';') {
      result = gen(body)
    } else {
      result = operators[';'](body.slice(1))
    }
    ctx.popScope()
    return result
  },

  // Declarations
  'let'([assignment]) {
    if (!Array.isArray(assignment) || assignment[0] !== '=') {
      throw new Error('let requires assignment')
    }
    const [, name, value] = assignment
    if (typeof name !== 'string') throw new Error('let requires simple identifier')
    const scopedName = ctx.declareVar(name, false)
    const val = gen(value)
    ctx.addLocal(name, val[0], val[2], scopedName)
    return tv(val[0], `(local.tee $${scopedName} ${val[1]})`, val[2])
  },

  'const'([assignment]) {
    if (!Array.isArray(assignment) || assignment[0] !== '=') {
      throw new Error('const requires assignment')
    }
    const [, name, value] = assignment
    if (typeof name !== 'string') throw new Error('const requires simple identifier')
    const scopedName = ctx.declareVar(name, true)
    const val = gen(value)
    ctx.addLocal(name, val[0], val[2], scopedName)
    return tv(val[0], `(local.tee $${scopedName} ${val[1]})`, val[2])
  },

  'var'([assignment]) {
    // var is function-scoped, use global scope (depth 0)
    if (!Array.isArray(assignment) || assignment[0] !== '=') {
      throw new Error('var requires assignment')
    }
    const [, name, value] = assignment
    if (typeof name !== 'string') throw new Error('var requires simple identifier')
    const val = gen(value)
    ctx.addLocal(name, val[0], val[2], name)  // no scope prefix for var
    return tv(val[0], `(local.tee $${name} ${val[1]})`, val[2])
  },

  // If statement
  'if'([cond, then, els]) {
    const [, cw] = truthy(gen(cond))
    if (els === undefined) {
      // if without else - returns 0 when false
      const [t, tw] = asF64(gen(then))
      return tv(t, `(if (result ${t}) ${cw} (then ${tw}) (else (${t}.const 0)))`)
    }
    // if/else
    const [[t, tw], [, ew]] = conciliate(gen(then), gen(els))
    return tv(t, `(if (result ${t}) ${cw} (then ${tw}) (else ${ew}))`)
  },

  // Break and continue
  'break'([label]) {
    // Find the innermost breakable block (loop or switch)
    const id = ctx.loopCounter - 1
    if (id < 0) throw new Error('break outside of loop/switch')
    return tv('f64', `(br $break_${id}) (f64.const 0)`)
  },

  'continue'([label]) {
    // Find the innermost loop's continue label
    const id = ctx.loopCounter - 1
    if (id < 0) throw new Error('continue outside of loop')
    return tv('f64', `(br $continue_${id}) (f64.const 0)`)
  },

  // typeof - returns string pointer for type name
  'typeof'([a]) {
    ctx.usedStringType = true
    const val = gen(a)
    // Intern type name strings (they'll have stable IDs)
    const typeStrings = {
      undefined: ctx.internString('undefined'),
      number: ctx.internString('number'),
      string: ctx.internString('string'),
      boolean: ctx.internString('boolean'),
      object: ctx.internString('object'),
      function: ctx.internString('function')
    }
    const mkStr = (name) => {
      const { id, length } = typeStrings[name]
      if (opts.gc) {
        return `(array.new_data $string $str${id} (i32.const 0) (i32.const ${length}))`
      } else {
        ctx.usedMemory = true
        return `(call $__mkptr (i32.const ${PTR_TYPE.STRING}) (i32.const ${length}) (i32.const ${id}))`
      }
    }
    if (!opts.gc && val[0] === 'f64') {
      // gc:false: f64 can be number or NaN-encoded pointer
      // NaN != NaN for pointers, number == number for regular floats
      return tv('string', `(select ${mkStr('number')} ${mkStr('object')} (f64.eq ${val[1]} ${val[1]}))`)
    }
    if (val[0] === 'f64') return tv('string', mkStr('number'))
    if (val[0] === 'i32') return tv('string', mkStr('boolean'))
    if (val[0] === 'string') return tv('string', mkStr('string'))
    if (val[0] === 'ref') return tv('string', mkStr('undefined'))
    if (val[0] === 'array' || val[0] === 'object') return tv('string', mkStr('object'))
    return tv('string', mkStr('number'))  // default
  },

  'void'([a]) {
    // void evaluates expression and returns undefined (0)
    const [, w] = gen(a)
    return tv('f64', `(drop ${w}) (f64.const 0)`)
  },

  // Template literals
  '\`'(parts) {
    // Template literal: [`parts] where parts alternate between strings and expressions
    // For now, return concatenation length or the first string if simple
    // Full string concatenation requires memory allocation
    if (parts.length === 1) {
      // Simple string without interpolation
      if (Array.isArray(parts[0]) && parts[0][0] === null) {
        return genLiteral(parts[0][1])
      }
    }
    // For expressions, we'd need string concatenation - for now return first part or 0
    // TODO: implement full string concatenation
    ctx.usedStringType = true
    let totalLen = 0
    for (const part of parts) {
      if (Array.isArray(part) && part[0] === null && typeof part[1] === 'string') {
        totalLen += part[1].length
      }
    }
    // Return length as proxy for now
    return tv('i32', `(i32.const ${totalLen})`)
  },

  // Statements
  ';'(stmts) {
    // Filter out trailing line number metadata
    stmts = stmts.filter((s, i) => i === 0 || (s !== null && typeof s !== 'number'))
    let code = ''
    for (let i = 0; i < stmts.length - 1; i++) {
      const stmt = stmts[i]
      if (Array.isArray(stmt) && stmt[0] === '=') code += genAssign(stmt[1], stmt[2], false)
      else if (Array.isArray(stmt) && stmt[0] === 'function') gen(stmt)
      else if (stmt !== null) code += `(drop ${gen(stmt)[1]})\n    `
    }
    const last = stmts[stmts.length - 1]
    if (last === null || last === undefined) return tv('f64', code + '(f64.const 0)')
    const lastVal = gen(last)
    return tv(lastVal[0], code + lastVal[1])
  },
}

// Generate compound assignment operators
for (const op of ['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '>>>']) {
  operators[op + '='] = ([a, b]) => operators['=']([a, [op, a, b]])
}

// Unified assignment handler - returns value if returnValue=true, else just side effect
function genAssign(target, value, returnValue) {
  // Function/closure definition
  if (Array.isArray(value) && value[0] === '=>') {
    if (typeof target !== 'string') throw new Error('Function must have name')
    const params = extractParams(value[1])
    const body = value[2]

    // Analyze for captured variables from the CURRENT scope
    // Include: ctx.locals, ctx.capturedVars (from received env), ctx.hoistedVars (from own env)
    const localNames = Object.keys(ctx.locals)
    const capturedNames = ctx.capturedVars ? Object.keys(ctx.capturedVars) : []
    const hoistedNames = ctx.hoistedVars ? Object.keys(ctx.hoistedVars) : []
    const outerDefined = new Set([...localNames, ...capturedNames, ...hoistedNames])

    // Analyze the function body to find free variables
    const analysis = analyzeScope(body, new Set(params), true)

    // Captured = free vars in the inner function that exist in our current scope
    const captured = [...analysis.free].filter(v =>
      outerDefined.has(v) && !params.includes(v)
    )

    if (captured.length > 0) {
      // Check if all captured vars are in our own hoisted env
      // If so, we can pass our __ownenv directly
      const allFromOwnEnv = ctx.hoistedVars && captured.every(v => v in ctx.hoistedVars)

      let envType, envFields
      if (allFromOwnEnv) {
        // Reuse our own env type - the closure will receive our __ownenv
        envType = ctx.ownEnvType
        envFields = ctx.ownEnvFields
      } else {
        // Need a new env type (captures from multiple sources)
        const envId = ctx.closureCounter++
        envType = `$env${envId}`
        envFields = captured.map((v, i) => ({ name: v, index: i }))
        if (opts.gc) {
          ctx.closureEnvTypes.push({ id: envId, fields: captured })
        }
      }

      ctx.closures[target] = { envType, envFields, captured, params, body, usesOwnEnv: allFromOwnEnv }

      // Register the lifted function (with env param)
      // Track closure depth for call sites
      const depth = closureDepth(body)
      ctx.functions[target] = {
        params,
        body,
        exported: false,
        closure: { envType, envFields, captured, usesOwnEnv: allFromOwnEnv },
        closureDepth: depth
      }

      return returnValue ? tv('f64', '(f64.const 0)') : ''
    }

    // Check if function body returns a closure (arrow function as body)
    const returnsClosure = Array.isArray(body) && body[0] === '=>'
    const depth = closureDepth(body)

    // Regular function (no captures)
    ctx.functions[target] = { params, body, exported: true, returnsClosure, closureDepth: depth }
    return returnValue ? tv('f64', '(f64.const 0)') : ''
  }

  // Array destructuring: [a, b] = [1, 2]
  if (Array.isArray(target) && target[0] === '[]' && Array.isArray(target[1]) && target[1][0] === ',') {
    const vars = target[1].slice(1)
    ctx.usedArrayType = true
    const id = ctx.loopCounter++
    const tmp = `$_destruct_${id}`
    ctx.addLocal(tmp.slice(1), 'array')
    const [, aw] = gen(value)
    let code = `(local.set ${tmp} ${aw})\n    `
    for (let i = 0; i < vars.length; i++) {
      if (typeof vars[i] === 'string') {
        ctx.addLocal(vars[i], 'f64')
        if (opts.gc) {
          code += `(local.set $${vars[i]} (array.get $f64array (local.get ${tmp}) (i32.const ${i})))\n    `
        } else {
          ctx.usedMemory = true
          code += `(local.set $${vars[i]} (f64.load (i32.add (call $__ptr_offset (local.get ${tmp})) (i32.const ${i * 8}))))\n    `
        }
      }
    }
    const lastVar = vars[vars.length - 1]
    return returnValue && typeof lastVar === 'string'
      ? tv('f64', code + `(local.get $${lastVar})`)
      : returnValue ? tv('f64', code + '(f64.const 0)') : code
  }

  // Object destructuring: {a, b} = {a: 5, b: 10}
  if (Array.isArray(target) && target[0] === '{}' && Array.isArray(target[1]) && target[1][0] === ',') {
    const props = target[1].slice(1)
    ctx.usedArrayType = true
    const id = ctx.loopCounter++
    const tmp = `$_destruct_${id}`
    ctx.addLocal(tmp.slice(1), 'object')
    const obj = gen(value)
    if (obj[0] !== 'object' || obj[2] === undefined)
      throw new Error('Object destructuring requires object literal on RHS')
    const schema = ctx.objectSchemas[obj[2]]
    let code = `(local.set ${tmp} ${obj[1]})\n    `
    let lastVar = null
    for (const p of props) {
      const varName = typeof p === 'string' ? p : (Array.isArray(p) && p[0] === ':' ? p[1] : null)
      if (typeof varName === 'string') {
        const idx = schema.indexOf(varName)
        if (idx < 0) throw new Error(`Property ${varName} not found in object`)
        ctx.addLocal(varName, 'f64')
        if (opts.gc) {
          code += `(local.set $${varName} (array.get $f64array (local.get ${tmp}) (i32.const ${idx})))\n    `
        } else {
          ctx.usedMemory = true
          code += `(local.set $${varName} (f64.load (i32.add (call $__ptr_offset (local.get ${tmp})) (i32.const ${idx * 8}))))\n    `
        }
        lastVar = varName
      }
    }
    return returnValue && lastVar
      ? tv('f64', code + `(local.get $${lastVar})`)
      : returnValue ? tv('f64', code + '(f64.const 0)') : code
  }

  // Array element assignment: arr[i] = x
  if (Array.isArray(target) && target[0] === '[]' && target.length === 3) {
    const [, aw] = gen(target[1]), [, iw] = asI32(gen(target[2])), [, vw] = asF64(gen(value))
    ctx.usedArrayType = true
    if (opts.gc) {
      const code = `(array.set $f64array ${aw} ${iw} ${vw})`
      return returnValue ? tv('f64', `${code} ${vw}`) : code + '\n    '
    } else {
      ctx.usedMemory = true
      const code = `(f64.store (i32.add (call $__ptr_offset ${aw}) (i32.shl ${iw} (i32.const 3))) ${vw})`
      return returnValue ? tv('f64', `${code} ${vw}`) : code + '\n    '
    }
  }

  // Global constant optimization (only at top level, and only for new variables)
  if (typeof target === 'string' && !ctx.inFunction && !returnValue && !ctx.getLocal(target)) {
    if (Array.isArray(value) && value[0] === undefined && typeof value[1] === 'number') {
      ctx.addGlobal(target, 'f64', `(f64.const ${fmtNum(value[1])})`)
      return ''
    }
    if (Array.isArray(value) && value[0] === '.' && value[1] === 'Math' && value[2] in MATH_OPS.constants) {
      ctx.addGlobal(target, 'f64', `(f64.const ${fmtNum(MATH_OPS.constants[value[2]])})`)
      return ''
    }
  }

  // Simple variable
  if (typeof target !== 'string') throw new Error('Invalid assignment target')
  const val = gen(value)

  // Check if this is a hoisted variable (must be written to own env)
  if (ctx.hoistedVars && target in ctx.hoistedVars) {
    const fieldIdx = ctx.hoistedVars[target]
    const setCode = envSet(opts.gc, ctx.ownEnvType, '$__ownenv', fieldIdx, asF64(val)[1])
    const getCode = envGet(opts.gc, ctx.ownEnvType, '$__ownenv', fieldIdx)
    return returnValue
      ? tv('f64', `(block (result f64) ${setCode} ${getCode})`)
      : setCode + '\n    '
  }

  // Check if this is a captured variable (must be written to received env)
  if (ctx.capturedVars && target in ctx.capturedVars) {
    const fieldIdx = ctx.capturedVars[target]
    const envVar = opts.gc ? '$__envcast' : '$__env'
    const setCode = envSet(opts.gc, ctx.currentEnv, envVar, fieldIdx, asF64(val)[1])
    const getCode = envGet(opts.gc, ctx.currentEnv, envVar, fieldIdx)
    return returnValue
      ? tv('f64', `(block (result f64) ${setCode} ${getCode})`)
      : setCode + '\n    '
  }

  const glob = ctx.getGlobal(target)
  if (glob) {
    const code = `(global.set $${target} ${asF64(val)[1]})`
    return returnValue ? tv(val[0], `${code} (global.get $${target})`) : code + '\n    '
  }
  // Check if variable exists in scope
  const existing = ctx.getLocal(target)
  if (existing) {
    // Check const
    if (existing.scopedName in ctx.constVars) {
      throw new Error(`Assignment to constant variable: ${target}`)
    }
    return returnValue
      ? tv(val[0], `(local.tee $${existing.scopedName} ${val[1]})`, val[2])
      : `(local.set $${existing.scopedName} ${val[1]})\n    `
  }
  // New variable - add to current scope
  ctx.addLocal(target, val[0], val[2])
  const loc = ctx.getLocal(target)
  return returnValue
    ? tv(val[0], `(local.tee $${loc.scopedName} ${val[1]})`, val[2])
    : `(local.set $${loc.scopedName} ${val[1]})\n    `
}

function genLoopInit(target, value) {
  if (typeof target !== 'string') throw new Error('Loop init must assign to variable')
  const [t, w] = gen(value)
  const glob = ctx.getGlobal(target)
  if (glob) return `(global.set $${target} ${asF64([t, w])[1]})\n    `
  const loc = ctx.getLocal(target)
  if (loc) return `(local.set $${loc.scopedName} ${asF64([t, w])[1]})\n    `
  ctx.addLocal(target, t)
  const newLoc = ctx.getLocal(target)
  return `(local.set $${newLoc.scopedName} ${asF64([t, w])[1]})\n    `
}

function generateFunction(name, params, bodyAst, parentCtx, closureInfo = null) {
  const newCtx = createContext()
  newCtx.usedStdlib = parentCtx.usedStdlib
  newCtx.usedArrayType = parentCtx.usedArrayType
  newCtx.usedStringType = parentCtx.usedStringType
  newCtx.functions = parentCtx.functions
  newCtx.closures = parentCtx.closures
  newCtx.closureEnvTypes = parentCtx.closureEnvTypes
  newCtx.closureCounter = parentCtx.closureCounter
  newCtx.globals = parentCtx.globals
  newCtx.funcTableEntries = parentCtx.funcTableEntries  // Share table entries for correct indices
  newCtx.inFunction = true
  newCtx.returnLabel = '$return_' + name

  // Find variables that need to be hoisted to environment (captured by nested closures)
  const hoistedVars = findHoistedVars(bodyAst, params)

  // If this function has hoisted vars OR is itself a closure, we need env handling
  let envParam = ''
  let envInit = ''

  if (closureInfo) {
    // This is a closure - receives env from caller
    newCtx.currentEnv = closureInfo.envType
    newCtx.capturedVars = {}
    for (const field of closureInfo.envFields) {
      newCtx.capturedVars[field.name] = field.index
    }
  }

  // If this function has hoisted vars, create OWN env for them
  // This is separate from the received env (if any)
  if (hoistedVars.size > 0) {
    const envId = parentCtx.closureCounter++
    newCtx.ownEnvType = `$env${envId}`
    newCtx.ownEnvFields = [...hoistedVars].map((v, i) => ({ name: v, index: i }))
    // Track which vars are in our own env (for read/write)
    newCtx.hoistedVars = {}
    for (const field of newCtx.ownEnvFields) {
      newCtx.hoistedVars[field.name] = field.index
    }
    // Register env type
    if (opts.gc) {
      parentCtx.closureEnvTypes.push({ id: envId, fields: [...hoistedVars] })
    }
  }

  const prevCtx = setCtx(newCtx)

  // Add env parameter for closures
  // For first-class functions, we use generic anyref/f64 and cast inside
  if (closureInfo) {
    if (opts.gc) {
      // Use anyref for compatibility with $closure struct, cast to specific type inside
      envParam = `(param $__env anyref) `
      ctx.locals.__env = { idx: ctx.localCounter++, type: 'anyref' }
      // Cast to specific env type for field access
      if (closureInfo.envType) {
        ctx.localDecls.push(`(local $__envcast (ref null ${closureInfo.envType}))`)
        ctx.locals.__envcast = { idx: ctx.localCounter++, type: 'ref' }
        envInit = `(local.set $__envcast (ref.cast (ref null ${closureInfo.envType}) (local.get $__env)))\n      `
      }
    } else {
      envParam = `(param $__env f64) `
      ctx.locals.__env = { idx: ctx.localCounter++, type: 'f64' }
    }
  }

  // Initialize own env if needed
  if (ctx.ownEnvType) {
    if (opts.gc) {
      // Add local with explicit env struct type
      ctx.locals.__ownenv = { idx: ctx.localCounter++, type: 'envref' }
      ctx.localDecls.push(`(local $__ownenv (ref null ${ctx.ownEnvType}))`)
      // Initialize with zeros
      const zeros = ctx.ownEnvFields.map(() => '(f64.const 0)').join(' ')
      envInit = `(local.set $__ownenv (struct.new ${ctx.ownEnvType} ${zeros}))\n      `
      // Copy captured params into env
      for (const field of ctx.ownEnvFields) {
        if (params.includes(field.name)) {
          envInit += `(struct.set ${ctx.ownEnvType} ${field.index} (local.get $__ownenv) (local.get $${field.name}))\n      `
        }
      }
    } else {
      ctx.usedMemory = true
      ctx.addLocal('__ownenv', 'f64')
      const envSize = ctx.ownEnvFields.length * 8
      envInit = `(local.set $__ownenv (call $__alloc (i32.const ${PTR_TYPE.CLOSURE}) (i32.const ${ctx.ownEnvFields.length})))\n      `
      // Copy captured params into env
      for (const field of ctx.ownEnvFields) {
        if (params.includes(field.name)) {
          envInit += `(f64.store (i32.add (call $__ptr_offset (local.get $__ownenv)) (i32.const ${field.index * 8})) (local.get $${field.name}))\n      `
        }
      }
    }
  }

  for (const p of params) ctx.locals[p] = { idx: ctx.localCounter++, type: 'f64' }
  const bodyResult = gen(bodyAst)
  const [bodyType, bodyWatRaw] = bodyResult

  // Determine return type and final body
  let returnType, bodyWat
  if (opts.gc && bodyType === 'closure') {
    // Function returns a closure - use anyref return type
    returnType = 'anyref'
    bodyWat = bodyWatRaw
  } else {
    // Normal f64 return
    returnType = 'f64'
    bodyWat = asF64(bodyResult)[1]
  }

  const paramDecls = params.map(p => `(param $${p} f64)`).join(' ')
  const localDecls = ctx.localDecls.length ? `\n    ${ctx.localDecls.join(' ')}` : ''
  // Export only if not a closure
  const exportClause = closureInfo ? '' : ` (export "${name}")`
  // Wrap body in block to support early return
  const wat = `(func $${name}${exportClause} ${envParam}${paramDecls} (result ${returnType})${localDecls}\n    (block ${ctx.returnLabel} (result ${returnType})\n      ${envInit}${bodyWat}\n    )\n  )`

  // Track if this function returns a closure (for call sites)
  if (bodyType === 'closure') {
    parentCtx.functions[name].returnsClosure = true
  }

  // Propagate flags to parent context
  if (ctx.usedMemory) parentCtx.usedMemory = true
  if (ctx.usedClosureType) parentCtx.usedClosureType = true
  if (ctx.usedFuncTable) parentCtx.usedFuncTable = true
  if (ctx.usedArrayType) parentCtx.usedArrayType = true
  if (ctx.usedStringType) parentCtx.usedStringType = true
  if (ctx.usedRefArrayType) parentCtx.usedRefArrayType = true
  if (ctx.usedFuncTypes) {
    if (!parentCtx.usedFuncTypes) parentCtx.usedFuncTypes = new Set()
    for (const arity of ctx.usedFuncTypes) parentCtx.usedFuncTypes.add(arity)
  }
  if (ctx.usedClFuncTypes) {
    if (!parentCtx.usedClFuncTypes) parentCtx.usedClFuncTypes = new Set()
    for (const arity of ctx.usedClFuncTypes) parentCtx.usedClFuncTypes.add(arity)
  }
  if (ctx.funcTableEntries) {
    for (const fn of ctx.funcTableEntries) {
      if (!parentCtx.funcTableEntries.includes(fn)) parentCtx.funcTableEntries.push(fn)
    }
  }
  // Propagate ref.func declarations
  if (ctx.refFuncs && ctx.refFuncs.size > 0) {
    for (const fn of ctx.refFuncs) parentCtx.refFuncs.add(fn)
  }
  // Sync closure counter back to parent
  parentCtx.closureCounter = ctx.closureCounter

  setCtx(prevCtx)
  return wat
}

function generateFunctions() {
  const generated = new Set()
  const results = []

  // Keep generating until no new functions are added
  // This handles nested closures that get registered during generation
  while (true) {
    const toGenerate = Object.entries(ctx.functions).filter(([name]) => !generated.has(name))
    if (toGenerate.length === 0) break

    for (const [name, def] of toGenerate) {
      generated.add(name)
      const closureInfo = def.closure || null
      results.push(generateFunction(name, def.params, def.body, ctx, closureInfo))
    }
  }
  return results
}
