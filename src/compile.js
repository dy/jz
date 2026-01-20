/**
 * jz compiler - AST to WAT compilation
 *
 * This is the core compiler that transforms JavaScript AST into WAT code.
 *
 * === Module Map ===
 * src/
 *   types.js     - Type system: wat(), f64(), i32(), bool(), predicates
 *   ops.js       - WAT operations: f64.*, i32.*, MATH_OPS
 *   gc.js        - GC abstraction: nullRef, mkString, arrGet, envGet/Set
 *   analyze.js   - Closure analysis: analyzeScope, findHoistedVars
 *   context.js   - Compilation context: locals, globals, functions, closures
 *   emit.js      - WAT assembly: assemble() builds final module
 *   stdlib.js    - Standard library: Math, isNaN, parseInt, etc.
 *   normalize.js - AST normalization from parser
 *   compile.js   - This file: AST→WAT generator, operators, functions
 *   methods/     - Array/string method implementations
 *
 * === This File Sections ===
 * Line ~25   - Imports and exports
 * Line ~55   - Public API: compile()
 * Line ~65   - Core helpers: isConstant(), evalConstant(), generate()
 * Line ~100  - Identifiers: closureDepth(), genLiteral(), genIdent()
 * Line ~145  - Call resolution: resolveCall()
 * Line ~330  - Closure calls: genClosureCall(), genClosureCallExpr()
 * Line ~480  - Closure creation: genClosureValue()
 * Line ~590  - Operators object: all AST operators
 * Line ~1210 - Assignment: genAssign()
 * Line ~1450 - Loop init: genLoopInit()
 * Line ~1480 - Function generation: generateFunction(), generateFunctions()
 *
 * === Data Flow ===
 * 1. compile(ast) creates context, calls generate(ast)
 * 2. generate() dispatches to operators[op] based on AST node type
 * 3. operators return typed values [type, wat, schema?]
 * 4. generateFunctions() compiles user-defined functions
 * 5. assemble() builds final WAT module from all parts
 *
 * @module compile
 */

import * as array from './array.js'
import * as string from './string.js'

const arrayMethods = {
  fill: array.fill, map: array.map, reduce: array.reduce, filter: array.filter,
  find: array.find, findIndex: array.findIndex, indexOf: array.indexOf, includes: array.includes,
  every: array.every, some: array.some, slice: array.slice, reverse: array.reverse,
  push: array.push, pop: array.pop, forEach: array.forEach, concat: array.concat, join: array.join
}

const stringMethods = {
  charCodeAt: string.charCodeAt, slice: string.slice, indexOf: string.indexOf, substring: string.substring,
  toLowerCase: string.toLowerCase, toUpperCase: string.toUpperCase, includes: string.includes,
  startsWith: string.startsWith, endsWith: string.endsWith, trim: string.trim,
  split: string.split, replace: string.replace
}
import { PTR_TYPE, wat, fmtNum, f64, i32, bool, conciliate, isF64, isI32, isString, isArray, isObject, isClosure, isRef, isRefArray, bothI32, isHeapRef, hasSchema } from './types.js'
import { extractParams, extractParamInfo, analyzeScope, findHoistedVars } from './analyze.js'
import { f64ops, i32ops, MATH_OPS, GLOBAL_CONSTANTS } from './ops.js'
import { createContext } from './context.js'
import { assemble } from './assemble.js'
import { nullRef, mkString, envGet, envSet, arrGet, arrGetTyped, arrLen, objGet, strCharAt, mkArrayLiteral, callClosure } from './gc.js'

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
  // Initialize shared state for method modules
  opts = { gc }
  setCtx(createContext(gc))
  gen = generate
  const bodyWat = String(f64(generate(ast)))
  return assemble(bodyWat, ctx, generateFunctions(), gc)
}


/**
 * Check if an AST node is a constant expression (can be computed at compile time).
 * Used for optimizations like constant folding in array literals.
 *
 * @param {any} ast - AST node to check
 * @returns {boolean} True if expression can be evaluated at compile time
 * @example isConstant([null, 42]) → true
 * @example isConstant(['+', [null, 1], [null, 2]]) → true
 * @example isConstant('x') → false (variable reference)
 */
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

/**
 * Evaluate a constant expression at compile time.
 * Used with isConstant() for constant folding optimizations.
 *
 * @param {any} ast - Constant AST node (must pass isConstant check)
 * @returns {number} Evaluated numeric result
 * @example evalConstant([null, 42]) → 42
 * @example evalConstant(['+', [null, 1], [null, 2]]) → 3
 * @example evalConstant('true') → 1
 */
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

/**
 * Core AST generator: converts an AST node to a typed WAT value.
 * Dispatches to genLiteral, genIdent, or operators based on node type.
 *
 * @param {any} ast - AST node: null, [undefined, literal], string (identifier), or [op, ...args]
 * @returns {object} Typed WAT value with {type, wat, schema?}
 * @example generate(['+', [null, 1], [null, 2]]) → {type:'f64', wat:'(f64.add (f64.const 1) (f64.const 2))'}
 * @example generate('x') → {type:'f64', wat:'(local.get $x)'}
 */
function generate(ast) {
  if (ast == null) return wat('(f64.const 0)', 'f64')
  if (Array.isArray(ast) && ast[0] === undefined) return genLiteral(ast[1])
  if (typeof ast === 'string') return genIdent(ast)
  if (!Array.isArray(ast)) throw new Error(`Invalid AST: ${JSON.stringify(ast)}`)
  const [op, ...args] = ast
  if (op in operators) return operators[op](args)
  throw new Error(`Unknown operator: ${op}`)
}

/**
 * Calculate closure nesting depth: how many nested arrows before reaching a non-arrow expression.
 * Used to track return types for curried functions.
 *
 * @param {any} body - Function body AST
 * @returns {number} 0 for f64 result, 1+ for closure result
 * @example closureDepth(['+', 'x', 'y']) → 0 (returns f64)
 * @example closureDepth(['=>', 'y', ['+', 'x', 'y']]) → 1 (returns closure)
 * @example closureDepth(['=>', 'y', ['=>', 'z', 'x']]) → 2 (returns closure returning closure)
 */
function closureDepth(body) {
  if (!Array.isArray(body) || body[0] !== '=>') return 0
  return 1 + closureDepth(body[2])  // body[2] is the arrow body
}

/**
 * Generate WAT for a literal value (number, boolean, string, null).
 *
 * @param {any} v - Literal value: number, boolean, string, null, or undefined
 * @returns {object} Typed WAT value
 * @example genLiteral(42) → {type:'f64', wat:'(f64.const 42)'}
 * @example genLiteral(true) → {type:'i32', wat:'(i32.const 1)'}
 * @example genLiteral('hello') → {type:'string', wat:'(call $__strconst ...)'}
 */
function genLiteral(v) {
  if (v === null || v === undefined) return nullRef(opts.gc)
  if (typeof v === 'number') return wat(`(f64.const ${fmtNum(v)})`, 'f64')
  if (typeof v === 'boolean') return wat(`(i32.const ${v ? 1 : 0})`, 'i32')
  if (typeof v === 'string') return mkString(opts.gc, ctx, v)
  throw new Error(`Unsupported literal: ${JSON.stringify(v)}`)
}

/**
 * Generate WAT for an identifier reference.
 * Resolves: builtins (true/false/null), global constants (PI, Infinity),
 * hoisted vars (closure env), captured vars, locals, and globals.
 *
 * @param {string} name - Identifier name
 * @returns {object} Typed WAT value
 * @throws {Error} If identifier is unknown
 * @example genIdent('true') → {type:'i32', wat:'(i32.const 1)'}
 * @example genIdent('PI') → {type:'f64', wat:'(f64.const 3.14159...)'}
 * @example genIdent('x') → {type:'f64', wat:'(local.get $x)'}
 */
function genIdent(name) {
  if (name === 'null' || name === 'undefined') return nullRef(opts.gc)
  if (name === 'true') return wat('(i32.const 1)', 'i32')
  if (name === 'false') return wat('(i32.const 0)', 'i32')
  if (name in GLOBAL_CONSTANTS) return wat(`(f64.const ${fmtNum(GLOBAL_CONSTANTS[name])})`, 'f64')

  // Check if this is a hoisted variable (in our own env, for nested closure access)
  if (ctx.hoistedVars && name in ctx.hoistedVars) {
    const { index, type } = ctx.hoistedVars[name]
    return wat(envGet(opts.gc, ctx.ownEnvType, '$__ownenv', index, type), type)
  }

  // Check if this is a captured variable (from closure environment passed to us)
  if (ctx.capturedVars && name in ctx.capturedVars) {
    const { index, type } = ctx.capturedVars[name]
    const envVar = opts.gc ? '$__envcast' : '$__env'
    return wat(envGet(opts.gc, ctx.currentEnv, envVar, index, type), type)
  }

  const loc = ctx.getLocal(name)
  if (loc) return wat(`(local.get $${loc.scopedName})`, loc.type, ctx.localSchemas[loc.scopedName])
  const glob = ctx.getGlobal(name)
  if (glob) return wat(`(global.get $${name})`, glob.type)
  throw new Error(`Unknown identifier: ${name}`)
}


/**
 * Resolve a function/method call to WAT code.
 * Handles: Math.*, Number.*, global functions, user-defined functions, method calls on arrays/strings.
 *
 * @param {string|null} namespace - 'Math', 'Number', or null for global/user functions
 * @param {string} name - Function/method name (e.g. 'sin', 'isNaN', 'myFunc', 'map')
 * @param {any[]} args - Array of AST argument nodes
 * @param {object|null} receiver - For method calls, the typed value being called on (e.g. array for arr.map)
 * @returns {object} Typed WAT value with {type, wat, schema?}
 * @example resolveCall('Math', 'sin', [[null, 1]]) → {type:'f64', wat:'(call $sin (f64.const 1))'}
 * @example resolveCall(null, 'myFunc', [args...]) → {type:'f64', wat:'(call $myFunc ...)'}
 */
function resolveCall(namespace, name, args, receiver = null) {
  // Method calls
  if (receiver !== null) {
    const rt = receiver.type, rw = String(receiver)

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
      return wat(`(${MATH_OPS.f64_unary[name]} ${f64(gen(args[0]))})`, 'f64')
    if (name in MATH_OPS.i32_unary && args.length === 1)
      return wat(`(${MATH_OPS.i32_unary[name]} ${i32(gen(args[0]))})`, 'i32')
    if (name in MATH_OPS.f64_binary && args.length === 2)
      return wat(`(${MATH_OPS.f64_binary[name]} ${f64(gen(args[0]))} ${f64(gen(args[1]))})`, 'f64')
    if (name in MATH_OPS.f64_binary && args.length > 2) {
      let result = String(f64(gen(args[0])))
      for (let i = 1; i < args.length; i++) result = `(${MATH_OPS.f64_binary[name]} ${result} ${f64(gen(args[i]))})`
      return wat(result, 'f64')
    }
    if (MATH_OPS.stdlib_unary.includes(name) && args.length === 1) {
      ctx.usedStdlib.push(name)
      return wat(`(call $${name} ${f64(gen(args[0]))})`, 'f64')
    }
    if (MATH_OPS.stdlib_binary.includes(name) && args.length === 2) {
      ctx.usedStdlib.push(name)
      return wat(`(call $${name} ${f64(gen(args[0]))} ${f64(gen(args[1]))})`, 'f64')
    }
    if (name === 'random' && args.length === 0) {
      ctx.usedStdlib.push('random')
      return wat('(call $random)', 'f64')
    }
    throw new Error(`Unknown Math.${name}`)
  }

  // Number namespace
  if (namespace === 'Number') {
    if (name === 'isNaN' && args.length === 1) {
      const w = f64(gen(args[0]))
      return wat(`(f64.ne ${w} ${w})`, 'i32')
    }
    if (name === 'isFinite' && args.length === 1) {
      const w = f64(gen(args[0]))
      return wat(`(i32.and (f64.eq ${w} ${w}) (f64.ne (f64.abs ${w}) (f64.const inf)))`, 'i32')
    }
    if (name === 'isInteger' && args.length === 1) {
      ctx.usedStdlib.push('isInteger')
      return wat(`(i32.trunc_f64_s (call $isInteger ${f64(gen(args[0]))}))`, 'i32')
    }
    throw new Error(`Unknown Number.${name}`)
  }

  // Global functions
  if (namespace === null) {
    if (name === 'isNaN' || name === 'isFinite') return resolveCall('Number', name, args)
    if (name === 'Array' && args.length === 1) {
      ctx.usedArrayType = true
      if (opts.gc) {
        return wat(`(array.new $f64array (f64.const 0) ${i32(gen(args[0]))})`, 'array')
      } else {
        ctx.usedMemory = true
        return wat(`(call $__alloc (i32.const ${PTR_TYPE.F64_ARRAY}) ${i32(gen(args[0]))})`, 'f64')
      }
    }
    if (name === 'parseInt') {
      const val = gen(args[0])
      const radix = args.length >= 2 ? String(i32(gen(args[1]))) : '(i32.const 10)'
      if (isString(val)) {
        ctx.usedStdlib.push('parseInt')
        ctx.usedStringType = true
        return wat(`(call $parseInt ${val} ${radix})`, 'f64')
      }
      ctx.usedStdlib.push('parseIntFromCode')
      return wat(`(call $parseIntFromCode ${i32(val)} ${radix})`, 'f64')
    }
  }

  // User-defined function (including closures)
  if (namespace === null && name in ctx.functions) {
    const fn = ctx.functions[name]

    // Check for rest param in target function
    const restParam = fn.paramInfo?.find(p => p.rest)
    const fixedParamCount = restParam
      ? fn.params.indexOf(restParam.name)
      : fn.params.length

    // Check for spread args: [...arr] in call
    const hasSpread = args.some(a => Array.isArray(a) && a[0] === '...')

    // Calculate required params (those without defaults, excluding rest)
    const requiredParams = fn.paramInfo
      ? fn.paramInfo.filter(p => p.default === undefined && !p.rest && !p.destruct).length
      : fn.params.length

    // Generate args for rest param functions
    const genRestArgs = () => {
      // Fixed args first
      const fixedArgs = args.slice(0, fixedParamCount)
      const restArgs = args.slice(fixedParamCount)
      const fixedWats = fixedArgs.map(a => String(f64(gen(a))))

      // Build rest array from remaining args
      if (hasSpread && restArgs.length === 1 && Array.isArray(restArgs[0]) && restArgs[0][0] === '...') {
        // Single spread: fn(a, ...arr) -> pass arr directly as rest param
        const spreadArr = gen(restArgs[0][1])
        return [...fixedWats, String(spreadArr)].join(' ')
      } else {
        // Normal args: fn(a, b, c) -> build array [b, c] for rest
        ctx.usedArrayType = true
        const restVals = restArgs.map(a => gen(a))
        const restArrayWat = mkArrayLiteral(ctx, opts.gc, restVals, () => false, () => null, restArgs)
        return [...fixedWats, String(restArrayWat)].join(' ')
      }
    }

    // Detect destructuring params
    const destructParams = fn.paramInfo?.filter(p => p.destruct) || []

    // Generate args for normal functions
    const genArgs = () => {
      if (hasSpread) {
        throw new Error(`Cannot spread into function ${name} - use rest params or fixed array`)
      }
      // Map args to WAT, handling destructuring params specially
      const argWats = args.map((a, i) => {
        const paramInfo = fn.paramInfo?.[i]
        if (paramInfo?.destruct) {
          // Destructuring param - pass the array/object directly
          return String(gen(a))
        }
        return String(f64(gen(a)))
      })
      // Pad missing optional args with NaN (undefined)
      while (argWats.length < fn.params.length) {
        argWats.push('(f64.const nan)')
      }
      return argWats.join(' ')
    }

    if (fn.closure) {
      // Closure call - need to pass environment
      const argWats = restParam ? genRestArgs() : genArgs()
      if (!restParam) {
        if (args.length < requiredParams) throw new Error(`${name} expects at least ${requiredParams} args`)
        if (args.length > fn.params.length) throw new Error(`${name} expects at most ${fn.params.length} args`)
      }

      const { envFields, envType, usesOwnEnv } = fn.closure

      // If the closure uses our own env, pass it directly
      if (usesOwnEnv && ctx.ownEnvType) {
        if (opts.gc) {
          // Convert from (ref null) to (ref) for the call
          return wat(`(call $${name} (ref.as_non_null (local.get $__ownenv)) ${argWats})`, 'f64')
        } else {
          return wat(`(call $${name} (local.get $__ownenv) ${argWats})`, 'f64')
        }
      }

      // Otherwise, build a new environment with captured variables
      if (opts.gc) {
        // GC mode: create struct with captured values
        const envVals = envFields.map(f => {
          // Check our own hoisted vars first
          if (ctx.hoistedVars && f.name in ctx.hoistedVars) {
            const { index } = ctx.hoistedVars[f.name]
            return `(struct.get ${ctx.ownEnvType} ${index} (local.get $__ownenv))`
          }
          // Then check received env (capturedVars)
          if (ctx.capturedVars && f.name in ctx.capturedVars) {
            const { index } = ctx.capturedVars[f.name]
            return `(struct.get ${ctx.currentEnv} ${index} (local.get $__env))`
          }
          const loc = ctx.getLocal(f.name)
          if (loc) return `(local.get $${loc.scopedName})`
          const glob = ctx.getGlobal(f.name)
          if (glob) return `(global.get $${f.name})`
          throw new Error(`Cannot capture ${f.name}: not found`)
        }).join(' ')
        return wat(`(call $${name} (struct.new ${envType} ${envVals}) ${argWats})`, 'f64')
      } else {
        // gc:false mode: allocate env in memory
        ctx.usedMemory = true
        const envSize = envFields.length * 8
        const envVals = envFields.map((f, i) => {
          let val
          if (ctx.hoistedVars && f.name in ctx.hoistedVars) {
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
          return `(f64.store (i32.add (global.get $__heap) (i32.const ${i * 8})) ${val})`
        }).join('\n        ')
        // Allocate env, store values, call function
        return wat(`(block (result f64)
          ${envVals}
          (call $${name}
            (call $__mkptr (i32.const ${PTR_TYPE.CLOSURE}) (i32.const ${envFields.length}) (global.get $__heap))
            ${argWats})
          (global.set $__heap (i32.add (global.get $__heap) (i32.const ${envSize})))
        )`, 'f64')
      }
    }

    // Regular function call
    const argWats = restParam ? genRestArgs() : genArgs()
    if (!restParam) {
      if (args.length < requiredParams) throw new Error(`${name} expects at least ${requiredParams} args`)
      if (args.length > fn.params.length) throw new Error(`${name} expects at most ${fn.params.length} args`)
    }

    // Check if function returns a closure
    if (fn.returnsClosure) {
      const depth = (fn.closureDepth || 1) - 1
      if (opts.gc) {
        // Cast anyref result to (ref null $closure)
        ctx.usedClosureType = true
        return wat(`(ref.cast (ref null $closure) (call $${name} ${argWats}))`, 'closure', { closureDepth: depth })
      } else {
        // gc:false: closure is f64 NaN-boxed, but we track type for chained calls
        return wat(`(call $${name} ${argWats})`, 'closure', { closureDepth: depth })
      }
    }
    return wat(`(call $${name} ${argWats})`, 'f64')
  }

  throw new Error(`Unknown function: ${namespace ? namespace + '.' : ''}${name}`)
}

// =============================================================================
// CLOSURE CALLS
// =============================================================================

/**
 * Generate WAT for calling a closure stored in a variable.
 * Handles both gc:true (struct-based closures) and gc:false (NaN-boxed closures).
 *
 * @param {string} name - Variable name containing the closure
 * @param {any[]} args - Array of AST argument nodes
 * @returns {object} Typed WAT value for the call result
 * @example genClosureCall('add', [[null, 1], [null, 2]]) → call to closure in $add with args 1, 2
 */
function genClosureCall(name, args) {
  const argWats = args.map(a => String(f64(gen(a)))).join(' ')
  const closureVal = genIdent(name)
  const isNullable = isClosure(closureVal) // nullable if typed as closure
  return wat(callClosure(ctx, opts.gc, String(closureVal), argWats, args.length, isNullable), 'f64')
}

/**
 * Generate WAT for calling a closure from an expression result.
 * Handles curried calls like a(1)(2) where a(1) returns a closure.
 *
 * @param {object} closureVal - Typed WAT value containing closure (from previous call)
 * @param {any[]} args - Array of AST argument nodes
 * @returns {object} Typed WAT value for the call result
 * @example // For code: add(1)(2) where add = x => y => x + y
 *          // First call: genClosureCall('add', [[null,1]]) returns closure
 *          // Second call: genClosureCallExpr(closure, [[null,2]]) returns f64
 */
function genClosureCallExpr(closureVal, args) {
  const argWats = args.map(a => String(f64(gen(a)))).join(' ')
  const remainingDepth = closureVal.schema?.closureDepth ?? 0
  const returnsClosure = remainingDepth > 0
  const resultType = returnsClosure ? 'closure' : 'f64'
  const code = callClosure(ctx, opts.gc, String(closureVal), argWats, args.length, true, returnsClosure)
  return wat(code, resultType, returnsClosure ? { closureDepth: remainingDepth - 1 } : undefined)
}

// =============================================================================
// CLOSURE CREATION
// =============================================================================

/**
 * Create a closure value: funcref + environment.
 * gc:true: struct { funcref fn, anyref env }
 * gc:false: NaN-boxed with table index + env pointer
 *
 * @param {string} fnName - Name of the generated function
 * @param {string} envType - WASM type name for environment struct (e.g. '$env0')
 * @param {object[]} envFields - Array of {name, index, type} for captured variables
 * @param {boolean} usesOwnEnv - True if closure uses parent's own env directly
 * @param {number} arity - Number of parameters (for functype)
 * @returns {object} Typed WAT value with type 'closure'
 * @example genClosureValue('__anon0', '$env0', [{name:'x', index:0, type:'f64'}], false, 1)
 */
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
          const { index } = ctx.hoistedVars[f.name]
          return `(struct.get ${ctx.ownEnvType} ${index} (local.get $__ownenv))`
        }
        if (ctx.capturedVars && f.name in ctx.capturedVars) {
          const { index } = ctx.capturedVars[f.name]
          // Use $__envcast in gc:true mode
          return `(struct.get ${ctx.currentEnv} ${index} (local.get $__envcast))`
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
    return wat(`(struct.new $closure (ref.func $${fnName}) ${envWat})`, 'closure')
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
      return wat(`(f64.reinterpret_i64 (i64.or
        (i64.const 0x7FF0000000000000)
        (i64.or
          (i64.shl (i64.const ${tableIdx}) (i64.const 32))
          (i64.const 0))))`, 'closure')
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

    // Create closure: NaN-box with [0x7FF][tableIdx:16][envLen:16][envOffset:20]
    // Actually simpler: use lower 32 bits for env offset, bits 32-47 for table idx, bits 48-51 for env length
    return wat(`(block (result f64)
      (local.set ${tmpEnv} (call $__alloc (i32.const ${PTR_TYPE.CLOSURE}) (i32.const ${envFields.length})))
      ${stores}(f64.reinterpret_i64 (i64.or
        (i64.const 0x7FF0000000000000)
        (i64.or
          (i64.shl (i64.const ${tableIdx}) (i64.const 32))
          (i64.or
            (i64.shl (i64.extend_i32_u (call $__ptr_len (local.get ${tmpEnv}))) (i64.const 48))
            (i64.extend_i32_u (call $__ptr_offset (local.get ${tmpEnv}))))))))`, 'closure')
  }
}

// =============================================================================
// OPERATORS
// All AST node handlers, keyed by operator symbol
// Each returns a typed value [type, wat, schema?]
// =============================================================================

const operators = {
  // Spread operator (used in array literals and call args)
  '...'([arg]) {
    // Mark spread for parent to handle
    const val = gen(arg)
    val.spread = true
    return val
  },

  // --- Calls and Access ---
  '()'([fn, ...args]) {
    // Parenthesized expression: (expr) parsed as ['()', expr]
    if (args.length === 0 && Array.isArray(fn)) return gen(fn)

    // Expand comma-separated args: [',', a, b, c] -> [a, b, c]
    args = args.filter(a => a != null).flatMap(a => Array.isArray(a) && a[0] === ',' ? a.slice(1) : [a])

    // Check for spread args: fn(...arr) or fn(a, ...arr)
    const hasSpread = args.some(a => Array.isArray(a) && a[0] === '...')

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
    // Check for spread elements
    const hasSpread = elements.some(e => Array.isArray(e) && e[0] === '...')

    if (!hasSpread) {
      // No spread - use existing array literal codegen
      const gens = elements.map(e => gen(e))
      return mkArrayLiteral(ctx, opts.gc, gens, isConstant, evalConstant, elements)
    }

    // Handle spread: [...arr1, x, ...arr2, y] -> concat arrays and elements
    ctx.usedArrayType = true
    const id = ctx.loopCounter++

    if (opts.gc) {
      // gc:true: build array dynamically
      // First pass: calculate total length and collect values
      const parts = []
      for (const e of elements) {
        if (Array.isArray(e) && e[0] === '...') {
          parts.push({ spread: true, value: gen(e[1]) })
        } else {
          parts.push({ spread: false, value: gen(e) })
        }
      }

      // Generate length calculation and array building
      const tmpLen = `$_slen_${id}`
      const tmpArr = `$_sarr_${id}`
      const tmpIdx = `$_sidx_${id}`
      ctx.addLocal(tmpLen.slice(1), 'i32')
      ctx.addLocal(tmpIdx.slice(1), 'i32')
      ctx.localDecls.push(`(local ${tmpArr} (ref null $f64array))`)
      ctx.locals[tmpArr.slice(1)] = { idx: ctx.localCounter++, type: 'ref' }

      // Calculate total length
      let lenCode = '(i32.const 0)'
      for (const p of parts) {
        if (p.spread) {
          lenCode = `(i32.add ${lenCode} (array.len ${p.value}))`
        } else {
          lenCode = `(i32.add ${lenCode} (i32.const 1))`
        }
      }

      // Build the array
      let code = `(local.set ${tmpLen} ${lenCode})
      (local.set ${tmpArr} (array.new $f64array (f64.const 0) (local.get ${tmpLen})))
      (local.set ${tmpIdx} (i32.const 0))\n      `

      for (const p of parts) {
        if (p.spread) {
          // Copy spread array: loop and copy elements
          const loopId = ctx.loopCounter++
          const tmpSrc = `$_ssrc_${loopId}`
          const tmpI = `$_si_${loopId}`
          ctx.addLocal(tmpI.slice(1), 'i32')
          ctx.localDecls.push(`(local ${tmpSrc} (ref null $f64array))`)
          ctx.locals[tmpSrc.slice(1)] = { idx: ctx.localCounter++, type: 'ref' }
          code += `(local.set ${tmpSrc} ${p.value})
      (local.set ${tmpI} (i32.const 0))
      (block $break_${loopId} (loop $loop_${loopId}
        (br_if $break_${loopId} (i32.ge_u (local.get ${tmpI}) (array.len (local.get ${tmpSrc}))))
        (array.set $f64array (local.get ${tmpArr}) (local.get ${tmpIdx}) (array.get $f64array (local.get ${tmpSrc}) (local.get ${tmpI})))
        (local.set ${tmpIdx} (i32.add (local.get ${tmpIdx}) (i32.const 1)))
        (local.set ${tmpI} (i32.add (local.get ${tmpI}) (i32.const 1)))
        (br $loop_${loopId})
      ))\n      `
        } else {
          // Single element
          code += `(array.set $f64array (local.get ${tmpArr}) (local.get ${tmpIdx}) ${f64(p.value)})
      (local.set ${tmpIdx} (i32.add (local.get ${tmpIdx}) (i32.const 1)))\n      `
        }
      }

      return wat(`(block (result (ref null $f64array))
      ${code}(local.get ${tmpArr}))`, 'array')
    } else {
      // gc:false: build array in linear memory
      ctx.usedMemory = true
      const parts = []
      for (const e of elements) {
        if (Array.isArray(e) && e[0] === '...') {
          parts.push({ spread: true, value: gen(e[1]) })
        } else {
          parts.push({ spread: false, value: gen(e) })
        }
      }

      const tmpLen = `$_slen_${id}`
      const tmpArr = `$_sarr_${id}`
      const tmpIdx = `$_sidx_${id}`
      ctx.addLocal(tmpLen.slice(1), 'i32')
      ctx.addLocal(tmpArr.slice(1), 'f64')
      ctx.addLocal(tmpIdx.slice(1), 'i32')

      // Calculate total length
      let lenCode = '(i32.const 0)'
      for (const p of parts) {
        if (p.spread) {
          lenCode = `(i32.add ${lenCode} (call $__ptr_len ${p.value}))`
        } else {
          lenCode = `(i32.add ${lenCode} (i32.const 1))`
        }
      }

      // Allocate and fill
      let code = `(local.set ${tmpLen} ${lenCode})
      (local.set ${tmpArr} (call $__alloc (i32.const ${PTR_TYPE.F64_ARRAY}) (local.get ${tmpLen})))
      (local.set ${tmpIdx} (i32.const 0))\n      `

      for (const p of parts) {
        if (p.spread) {
          // Copy spread array
          const loopId = ctx.loopCounter++
          const tmpSrc = `$_ssrc_${loopId}`
          const tmpI = `$_si_${loopId}`
          ctx.addLocal(tmpSrc.slice(1), 'f64')
          ctx.addLocal(tmpI.slice(1), 'i32')
          code += `(local.set ${tmpSrc} ${p.value})
      (local.set ${tmpI} (i32.const 0))
      (block $break_${loopId} (loop $loop_${loopId}
        (br_if $break_${loopId} (i32.ge_u (local.get ${tmpI}) (call $__ptr_len (local.get ${tmpSrc}))))
        (f64.store
          (i32.add (call $__ptr_offset (local.get ${tmpArr})) (i32.shl (local.get ${tmpIdx}) (i32.const 3)))
          (f64.load (i32.add (call $__ptr_offset (local.get ${tmpSrc})) (i32.shl (local.get ${tmpI}) (i32.const 3)))))
        (local.set ${tmpIdx} (i32.add (local.get ${tmpIdx}) (i32.const 1)))
        (local.set ${tmpI} (i32.add (local.get ${tmpI}) (i32.const 1)))
        (br $loop_${loopId})
      ))\n      `
        } else {
          // Single element
          code += `(f64.store
        (i32.add (call $__ptr_offset (local.get ${tmpArr})) (i32.shl (local.get ${tmpIdx}) (i32.const 3)))
        ${f64(p.value)})
      (local.set ${tmpIdx} (i32.add (local.get ${tmpIdx}) (i32.const 1)))\n      `
        }
      }

      return wat(`(block (result f64)
      ${code}(local.get ${tmpArr}))`, 'array')
    }
  },

  '{'(props) {
    if (props.length === 0) return nullRef(opts.gc)
    ctx.usedArrayType = true
    const keys = props.map(p => p[0])
    const vals = props.map(p => String(f64(gen(p[1]))))
    const objId = ctx.objectCounter++
    ctx.objectSchemas[objId] = keys
    if (opts.gc) {
      return wat(`(array.new_fixed $f64array ${vals.length} ${vals.join(' ')})`, 'object', objId)
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
      return wat(`(block (result f64)
      (local.set ${tmp} (call $__alloc (i32.const ${PTR_TYPE.OBJECT}) (i32.const ${vals.length})))
      ${stores}(local.get ${tmp}))`, 'object', objId)
    }
  },

  '[]'([arr, idx]) {
    const a = gen(arr), iw = i32(gen(idx))
    if (opts.gc) {
      if (isString(a)) {
        ctx.usedStringType = true
        return wat(strCharAt(true, String(a), iw), 'i32')
      }
      if (isRefArray(a)) {
        // Indexing into anyarray - returns anyref, need to cast based on element type
        ctx.usedRefArrayType = true
        ctx.usedArrayType = true
        // Try to determine element type from schema
        const schema = a.schema  // Array of element types
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
          return wat(`(ref.cast (ref $f64array) (array.get $anyarray ${a} ${iw}))`, 'array')
        } else if (effectiveType === 'refarray') {
          return wat(`(ref.cast (ref $anyarray) (array.get $anyarray ${a} ${iw}))`, 'refarray', effectiveSchema)
        } else if (effectiveType === 'object') {
          return wat(`(ref.cast (ref $f64array) (array.get $anyarray ${a} ${iw}))`, 'object')
        } else if (effectiveType === 'string') {
          ctx.usedStringType = true
          return wat(`(ref.cast (ref $string) (array.get $anyarray ${a} ${iw}))`, 'string')
        } else if (effectiveType === 'f64' || effectiveType === 'i32') {
          return wat(`(array.get $f64array (ref.cast (ref $f64array) (array.get $anyarray ${a} ${iw})) (i32.const 0))`, 'f64')
        } else {
          return wat(`(ref.cast (ref $f64array) (array.get $anyarray ${a} ${iw}))`, 'array')
        }
      }
      return arrGetTyped(ctx, true, String(a), iw)
    } else {
      // gc:false - load from memory
      ctx.usedMemory = true
      const schema = a.schema
      let litIdx = null
      if (isConstant(idx)) {
        const v = evalConstant(idx)
        litIdx = Number.isFinite(v) ? (v | 0) : null
      }
      if (Array.isArray(schema) && litIdx !== null) {
        const elem = schema[litIdx]
        if (elem && elem.type === 'object' && elem.id !== undefined) {
          return wat(`(f64.load (i32.add (call $__ptr_offset ${a}) (i32.const ${litIdx * 8})))`, 'object', elem.id)
        }
      }
      if (isString(a)) {
        return wat(strCharAt(false, String(a), iw), 'i32')
      }
      return arrGetTyped(ctx, false, String(a), iw)
    }
  },

  '?.[]'([arr, idx]) {
    const aw = gen(arr), iw = i32(gen(idx))
    if (opts.gc) {
      ctx.usedArrayType = true
      return wat(`(if (result f64) (ref.is_null ${aw}) (then (f64.const 0)) (else (array.get $f64array ${aw} ${iw})))`, 'f64')
    } else {
      // gc:false - check if pointer is 0 (null)
      ctx.usedMemory = true
      return wat(`(if (result f64) (f64.eq ${aw} (f64.const 0)) (then (f64.const 0)) (else (f64.load (i32.add (call $__ptr_offset ${aw}) (i32.shl ${iw} (i32.const 3))))))`, 'f64')
    }
  },

  '.'([obj, prop]) {
    if (obj === 'Math' && prop in MATH_OPS.constants)
      return wat(`(f64.const ${fmtNum(MATH_OPS.constants[prop])})`, 'f64')
    const o = gen(obj)
    if (prop === 'length') {
      if (isArray(o) || (isString(o) && opts.gc)) {
        if (isArray(o)) ctx.usedArrayType = true
        else ctx.usedStringType = true
        return wat(arrLen(opts.gc, String(o)), 'i32')
      } else if (isString(o) || isF64(o)) {
        ctx.usedMemory = true
        return wat(arrLen(false, String(o)), 'i32')  // gc:false uses ptr_len
      }
      throw new Error(`Cannot get length of ${o.type}`)
    }
    if (isObject(o) && hasSchema(o)) {
      const schema = ctx.objectSchemas[o.schema]
      if (schema) {
        const idx = schema.indexOf(prop)
        if (idx >= 0) {
          if (opts.gc) ctx.usedArrayType = true
          else ctx.usedMemory = true
          return wat(objGet(opts.gc, String(o), idx), 'f64')
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
          return wat(`(if (result f64) (ref.is_null ${o}) (then (f64.const 0)) (else (f64.convert_i32_s (array.len ${o}))))`, 'f64')
        }
      } else {
        // gc:false: arrays and strings are f64 pointers
        if (isF64(o) || isString(o)) {
          ctx.usedMemory = true
          return wat(`(if (result f64) (f64.eq ${o} (f64.const 0)) (then (f64.const 0)) (else (f64.convert_i32_s (call $__ptr_len ${o}))))`, 'f64')
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
      else code += `(drop ${gen(arg)})\n    `
    }
    const last = gen(args[args.length - 1])
    return wat(code + String(last), last.type, last.schema)
  },

  '?'([cond, then, els]) {
    const cw = bool(gen(cond)), [tw, ew] = conciliate(gen(then), gen(els)), t = tw.type
    return wat(`(if (result ${t}) ${cw} (then ${tw}) (else ${ew}))`, t)
  },

  '='([target, value]) { return genAssign(target, value, true) },

  'function'([name, params, body]) {
    ctx.functions[name] = { params: extractParams(params), paramInfo: extractParamInfo(params), body, exported: ctx.exports.has(name) }
    return wat('(f64.const 0)', 'f64')
  },

  '=>'([params, body]) {
    // Arrow function as expression - create a closure value
    // This is for cases like: `add = x => (y => x + y)` where the inner arrow is returned
    const fnParams = extractParams(params)
    const fnParamInfo = extractParamInfo(params)

    // Analyze for captured variables
    const localNames = Object.keys(ctx.locals)
    const capturedNames = ctx.capturedVars ? Object.keys(ctx.capturedVars) : []
    const hoistedNames = ctx.hoistedVars ? Object.keys(ctx.hoistedVars) : []
    const outerDefined = new Set([...localNames, ...capturedNames, ...hoistedNames])

    const analysis = analyzeScope(body, new Set(fnParams), true)
    const captured = [...analysis.free].filter(v => outerDefined.has(v) && !fnParams.includes(v))

    // Helper to get variable type for captured var
    const getVarType = (v) => {
      // Check local first
      const loc = ctx.getLocal(v)
      if (loc) return loc.type
      // Then hoisted vars (stored in ownEnvFields with type)
      if (ctx.ownEnvFields) {
        const field = ctx.ownEnvFields.find(f => f.name === v)
        if (field) return field.type || 'f64'
      }
      // Then captured vars (stored in closure.envFields)
      if (ctx.closureInfo?.envFields) {
        const field = ctx.closureInfo.envFields.find(f => f.name === v)
        if (field) return field.type || 'f64'
      }
      return 'f64'  // default
    }

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
      envFields = captured.map((v, i) => ({ name: v, index: i, type: getVarType(v) }))
      if (opts.gc) {
        ctx.closureEnvTypes.push({ id: envId, fields: envFields })
      }
    }

    // Register the lifted function
    ctx.functions[closureName] = {
      params: fnParams,
      paramInfo: fnParamInfo,
      body,
      exported: false,
      closure: captured.length > 0 ? { envType, envFields, captured, usesOwnEnv: allFromOwnEnv } : null
    }

    // Return closure value
    return genClosureValue(closureName, envType, envFields, allFromOwnEnv, fnParams.length)
  },

  'return'([value]) {
    const retVal = value !== undefined ? f64(gen(value)) : wat('(f64.const 0)', 'f64')
    // If inside a function with a return label, use br to exit early
    if (ctx.returnLabel) {
      return wat(`(br ${ctx.returnLabel} ${retVal})`, 'f64')
    }
    return retVal
  },

  // Unary
  'u+'([a]) { return f64(gen(a)) },
  'u-'([a]) { const v = gen(a); return v.type === 'i32' ? wat(`(i32.sub (i32.const 0) ${v})`, 'i32') : wat(`(f64.neg ${f64(v)})`, 'f64') },
  '!'([a]) { return wat(`(i32.eqz ${bool(gen(a))})`, 'i32') },
  '~'([a]) { return wat(`(i32.xor ${i32(gen(a))} (i32.const -1))`, 'i32') },

  // Arithmetic
  '+'([a, b]) { const va = gen(a), vb = gen(b); return bothI32(va, vb) ? i32ops.add(va, vb) : f64ops.add(va, vb) },
  '-'([a, b]) { const va = gen(a), vb = gen(b); return bothI32(va, vb) ? i32ops.sub(va, vb) : f64ops.sub(va, vb) },
  '*'([a, b]) { const va = gen(a), vb = gen(b); return bothI32(va, vb) ? i32ops.mul(va, vb) : f64ops.mul(va, vb) },
  '/'([a, b]) { return f64ops.div(gen(a), gen(b)) },
  '%'([a, b]) { return wat(`(call $f64.rem ${f64(gen(a))} ${f64(gen(b))})`, 'f64') },
  '**'([a, b]) { ctx.usedStdlib.push('pow'); return wat(`(call $pow ${f64(gen(a))} ${f64(gen(b))})`, 'f64') },

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
          return wat(`(i32.const ${code === 0 ? 1 : 0})`, 'i32')
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
          typeCode = `(if (result i32) (f64.eq ${val} ${val})
            (then (i32.const 1))
            (else (select (i32.const 4) (i32.const 1) (call $__is_pointer ${val}))))`
        } else if (isF64(val)) typeCode = '(i32.const 1)'
        else if (isI32(val)) typeCode = '(i32.const 3)'
        else if (isString(val)) typeCode = '(i32.const 2)'
        else if (isRef(val)) typeCode = '(i32.const 0)'
        else if (isArray(val) || isObject(val)) typeCode = '(i32.const 4)'
        else typeCode = '(i32.const 1)'
        return wat(`(i32.eq ${typeCode} (i32.const ${code}))`, 'i32')
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
        return wat(`(ref.eq ${va} ${vb})`, 'i32')
      } else {
        return wat(`(i64.eq (i64.reinterpret_f64 ${va}) (i64.reinterpret_f64 ${vb}))`, 'i32')
      }
    }
    // Array/object comparison: reference equality
    if ((isArray(va) || isObject(va)) && (isArray(vb) || isObject(vb))) {
      if (opts.gc) {
        return wat(`(ref.eq ${va} ${vb})`, 'i32')
      } else {
        return wat(`(i64.eq (i64.reinterpret_f64 ${va}) (i64.reinterpret_f64 ${vb}))`, 'i32')
      }
    }
    // gc:false f64 comparison: use i64.eq to handle NaN-boxed pointers correctly
    if (!opts.gc && isF64(va) && isF64(vb)) {
      return wat(`(i64.eq (i64.reinterpret_f64 ${va}) (i64.reinterpret_f64 ${vb}))`, 'i32')
    }
    return bothI32(va, vb) ? i32ops.eq(va, vb) : f64ops.eq(va, vb)
  },
  '==='([a, b]) { return operators['==']([a, b]) },
  '!='([a, b]) {
    // Special-case typeof != string
    const isTypeofA = Array.isArray(a) && a[0] === 'typeof'
    const isStringLiteralB = Array.isArray(b) && b[0] === undefined && typeof b[1] === 'string'
    if (isTypeofA && isStringLiteralB) {
      const eq = operators['==']([a, b])
      return wat(`(i32.eqz ${eq})`, 'i32')
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
        return wat(`(i32.eqz (ref.eq ${va} ${vb}))`, 'i32')
      } else {
        return wat(`(i64.ne (i64.reinterpret_f64 ${va}) (i64.reinterpret_f64 ${vb}))`, 'i32')
      }
    }
    // Array/object comparison: reference inequality
    if ((isArray(va) || isObject(va)) && (isArray(vb) || isObject(vb))) {
      if (opts.gc) {
        return wat(`(i32.eqz (ref.eq ${va} ${vb}))`, 'i32')
      } else {
        return wat(`(i64.ne (i64.reinterpret_f64 ${va}) (i64.reinterpret_f64 ${vb}))`, 'i32')
      }
    }
    // gc:false f64 comparison: use i64.ne to handle NaN-boxed pointers correctly
    if (!opts.gc && isF64(va) && isF64(vb)) {
      return wat(`(i64.ne (i64.reinterpret_f64 ${va}) (i64.reinterpret_f64 ${vb}))`, 'i32')
    }
    return bothI32(va, vb) ? i32ops.ne(va, vb) : f64ops.ne(va, vb)
  },
  '!=='([a, b]) { return operators['!=']([a, b]) },
  '<'([a, b]) { const va = gen(a), vb = gen(b); return bothI32(va, vb) ? i32ops.lt_s(va, vb) : f64ops.lt(va, vb) },
  '<='([a, b]) { const va = gen(a), vb = gen(b); return bothI32(va, vb) ? i32ops.le_s(va, vb) : f64ops.le(va, vb) },
  '>'([a, b]) { const va = gen(a), vb = gen(b); return bothI32(va, vb) ? i32ops.gt_s(va, vb) : f64ops.gt(va, vb) },
  '>='([a, b]) { const va = gen(a), vb = gen(b); return bothI32(va, vb) ? i32ops.ge_s(va, vb) : f64ops.ge(va, vb) },

  // Bitwise
  '&'([a, b]) { return i32ops.and(gen(a), gen(b)) },
  '|'([a, b]) { return i32ops.or(gen(a), gen(b)) },
  '^'([a, b]) { return i32ops.xor(gen(a), gen(b)) },
  '<<'([a, b]) { return i32ops.shl(gen(a), gen(b)) },
  '>>'([a, b]) { return i32ops.shr_s(gen(a), gen(b)) },
  '>>>'([a, b]) { return i32ops.shr_u(gen(a), gen(b)) },

  // Logical
  '&&'([a, b]) {
    const va = gen(a), vb = gen(b), cw = bool(va), [ca, cb] = conciliate(va, vb), t = ca.type
    return wat(`(if (result ${t}) ${cw} (then ${cb}) (else (${t}.const 0)))`, t)
  },
  '||'([a, b]) {
    const va = gen(a), vb = gen(b), cw = bool(va), [ca, cb] = conciliate(va, vb), t = ca.type
    return wat(`(if (result ${t}) ${cw} (then ${ca}) (else ${cb}))`, t)
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
          ctx.addLocal(scopedName, val.type)
          code += `(local.set $${scopedName} ${f64(val)})\n    `
        }
      }
      else code += `(drop ${gen(init)})\n    `
    }
    const id = ctx.loopCounter++
    const result = `$_for_result_${id}`
    ctx.addLocal(result.slice(1), 'f64')

    code += `(block $break_${id} (loop $continue_${id}\n      `
    if (cond) code += `(br_if $break_${id} (i32.eqz ${bool(gen(cond))}))\n      `
    code += `(local.set ${result} ${f64(gen(body))})\n      `
    if (step) {
      if (Array.isArray(step) && step[0] === '=') code += genAssign(step[1], step[2], false)
      else if (Array.isArray(step) && step[0].endsWith('=')) {
        const baseOp = step[0].slice(0, -1)
        code += genAssign(step[1], [baseOp, step[1], step[2]], false)
      } else code += `(drop ${gen(step)})\n      `
    }
    code += `(br $continue_${id})\n    ))\n    (local.get ${result})`
    ctx.popScope()
    return wat(code, 'f64')
  },

  // While loop
  'while'([cond, body]) {
    const id = ctx.loopCounter++
    const result = `$_while_result_${id}`
    ctx.addLocal(result.slice(1), 'f64')
    return wat(`(block $break_${id} (loop $continue_${id}
      (br_if $break_${id} (i32.eqz ${bool(gen(cond))}))
      (local.set ${result} ${f64(gen(body))})
      (br $continue_${id})))
    (local.get ${result})`, 'f64')
  },

  // Switch statement
  'switch'([discriminant, ...cases]) {
    const id = ctx.loopCounter++
    const result = `$_switch_result_${id}`
    const discrim = `$_switch_discrim_${id}`
    ctx.addLocal(result.slice(1), 'f64')
    ctx.addLocal(discrim.slice(1), 'f64')

    let code = `(local.set ${discrim} ${f64(gen(discriminant))})\n    `
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
        code += `(br_if $case_${caseId} ${f64ops.ne(wat(`(local.get ${discrim})`, 'f64'), gen(test))})\n        `
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
              code += `(local.set ${result} ${f64(gen(stmt))})\n        `
            }
          }
        } else {
          code += `(local.set ${result} ${f64(gen(consequent))})\n        `
        }

        ctx.loopCounter = saveId  // Restore
        code += `)\n      `
      } else if (Array.isArray(caseNode) && caseNode[0] === 'default') {
        const [, consequent] = caseNode
        code += `(local.set ${result} ${f64(gen(consequent))})\n      `
      }
    }

    code += `)\n    (local.get ${result})`
    return wat(code, 'f64')
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
    ctx.addLocal(name, val.type, val.schema, scopedName)
    return wat(`(local.tee $${scopedName} ${val})`, val.type, val.schema)
  },

  'const'([assignment]) {
    if (!Array.isArray(assignment) || assignment[0] !== '=') {
      throw new Error('const requires assignment')
    }
    const [, name, value] = assignment
    if (typeof name !== 'string') throw new Error('const requires simple identifier')
    // Arrow function: delegate to genAssign which handles function registration properly
    if (Array.isArray(value) && value[0] === '=>') {
      ctx.declareVar(name, true)
      return genAssign(name, value, true)
    }
    const scopedName = ctx.declareVar(name, true)
    const val = gen(value)
    ctx.addLocal(name, val.type, val.schema, scopedName)
    return wat(`(local.tee $${scopedName} ${val})`, val.type, val.schema)
  },

  'var'([assignment]) {
    // var is function-scoped, use global scope (depth 0)
    if (!Array.isArray(assignment) || assignment[0] !== '=') {
      throw new Error('var requires assignment')
    }
    const [, name, value] = assignment
    if (typeof name !== 'string') throw new Error('var requires simple identifier')
    const val = gen(value)
    ctx.addLocal(name, val.type, val.schema, name)  // no scope prefix for var
    return wat(`(local.tee $${name} ${val})`, val.type, val.schema)
  },

  // If statement
  'if'([cond, then, els]) {
    const cw = bool(gen(cond))
    if (els === undefined) {
      // if without else - returns 0 when false
      const tw = f64(gen(then))
      return wat(`(if (result f64) ${cw} (then ${tw}) (else (f64.const 0)))`, 'f64')
    }
    // if/else
    const [tw, ew] = conciliate(gen(then), gen(els)), t = tw.type
    return wat(`(if (result ${t}) ${cw} (then ${tw}) (else ${ew}))`, t)
  },

  // Break and continue
  'break'([label]) {
    // Find the innermost breakable block (loop or switch)
    const id = ctx.loopCounter - 1
    if (id < 0) throw new Error('break outside of loop/switch')
    return wat(`(br $break_${id}) (f64.const 0)`, 'f64')
  },

  'continue'([label]) {
    // Find the innermost loop's continue label
    const id = ctx.loopCounter - 1
    if (id < 0) throw new Error('continue outside of loop')
    return wat(`(br $continue_${id}) (f64.const 0)`, 'f64')
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
    if (!opts.gc && val.type === 'f64') {
      // gc:false: f64 can be number or NaN-encoded pointer
      // NaN != NaN for pointers, number == number for regular floats
      return wat(`(select ${mkStr('number')} ${mkStr('object')} (f64.eq ${val} ${val}))`, 'string')
    }
    if (val.type === 'f64') return wat(mkStr('number'), 'string')
    if (val.type === 'i32') return wat(mkStr('boolean'), 'string')
    if (val.type === 'string') return wat(mkStr('string'), 'string')
    if (val.type === 'ref') return wat(mkStr('undefined'), 'string')
    if (val.type === 'array' || val.type === 'object') return wat(mkStr('object'), 'string')
    return wat(mkStr('number'), 'string')  // default
  },

  'void'([a]) {
    // void evaluates expression and returns undefined (0)
    const w = gen(a)
    return wat(`(drop ${w}) (f64.const 0)`, 'f64')
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
    return wat(`(i32.const ${totalLen})`, 'i32')
  },

  // Export declaration
  'export'([decl]) {
    // export { name } or export { name1, name2 }
    if (Array.isArray(decl) && decl[0] === '{') {
      for (let i = 1; i < decl.length; i++) {
        const name = decl[i]
        if (typeof name === 'string') ctx.exports.add(name)
      }
      return wat('(f64.const 0)', 'f64')
    }
    // export const/let/var name = value
    if (Array.isArray(decl) && (decl[0] === 'const' || decl[0] === 'let' || decl[0] === 'var')) {
      const inner = decl[1]
      if (Array.isArray(inner) && inner[0] === '=') {
        const name = inner[1]
        if (typeof name === 'string') ctx.exports.add(name)
      }
      return gen(decl)
    }
    // export function name() {}
    if (Array.isArray(decl) && decl[0] === 'function') {
      const name = decl[1]
      if (typeof name === 'string') ctx.exports.add(name)
      return gen(decl)
    }
    return gen(decl)
  },

  // Statements
  ';'(stmts) {
    // Filter out trailing line number metadata
    stmts = stmts.filter((s, i) => i === 0 || (s !== null && typeof s !== 'number'))

    // Pre-scan for export { name } declarations to collect export names first
    // This handles both direct exports and nested statement blocks
    const collectExports = (stmt) => {
      if (!Array.isArray(stmt)) return
      if (stmt[0] === 'export') {
        const decl = stmt[1]
        // export { name } or export { name1, name2 }
        if (Array.isArray(decl) && decl[0] === '{') {
          for (let i = 1; i < decl.length; i++) {
            if (typeof decl[i] === 'string') ctx.exports.add(decl[i])
          }
        }
      } else if (stmt[0] === ';') {
        // Nested statement block
        for (let i = 1; i < stmt.length; i++) collectExports(stmt[i])
      }
    }
    for (const stmt of stmts) collectExports(stmt)

    let code = ''
    for (let i = 0; i < stmts.length - 1; i++) {
      const stmt = stmts[i]
      if (Array.isArray(stmt) && stmt[0] === '=') code += genAssign(stmt[1], stmt[2], false)
      else if (Array.isArray(stmt) && stmt[0] === 'function') gen(stmt)
      else if (stmt !== null) code += `(drop ${gen(stmt)})\n    `
    }
    const last = stmts[stmts.length - 1]
    if (last === null || last === undefined) return wat(code + '(f64.const 0)', 'f64')
    const lastVal = gen(last)
    return wat(code + String(lastVal), lastVal.type)
  },
}

// =============================================================================
// ASSIGNMENT
// Assignment handling for simple variables, captured vars, closures, and arrays.
// Compound operators (+=, -=, etc.) generated programmatically from base operators.
// =============================================================================

// Generate compound assignment operators
for (const op of ['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '>>>']) {
  operators[op + '='] = ([a, b]) => operators['=']([a, [op, a, b]])
}

/**
 * Handle all assignment operations: variables, arrays, objects, closures, destructuring.
 * Called by '=' operator and compound operators (+=, -=, etc.).
 *
 * @param {any} target - Assignment target: string (variable), ['[]', arr, idx], or destructuring pattern
 * @param {any} value - AST node for value being assigned
 * @param {boolean} returnValue - If true, returns typed value; if false, returns WAT statements only
 * @returns {object|string} Typed WAT value (if returnValue) or WAT code string
 * @example genAssign('x', [null, 42], true) → {type:'f64', wat:'(local.tee $x (f64.const 42))'}
 * @example genAssign('x', [null, 42], false) → '(local.set $x (f64.const 42))\n    '
 */
function genAssign(target, value, returnValue) {
  // Function/closure definition
  if (Array.isArray(value) && value[0] === '=>') {
    if (typeof target !== 'string') throw new Error('Function must have name')
    const params = extractParams(value[1])
    const paramInfo = extractParamInfo(value[1])
    const body = value[2]

    // Analyze for captured variables from the CURRENT scope
    // Include: ctx.locals, ctx.capturedVars (from received env), ctx.hoistedVars (from own env)
    const localNames = Object.keys(ctx.locals)
    const capturedNames = ctx.capturedVars ? Object.keys(ctx.capturedVars) : []
    const hoistedNames = ctx.hoistedVars ? Object.keys(ctx.hoistedVars) : []
    const outerDefined = new Set([...localNames, ...capturedNames, ...hoistedNames])

    // Helper to get variable type for captured var
    const getVarType = (v) => {
      const loc = ctx.getLocal(v)
      if (loc) return loc.type
      if (ctx.ownEnvFields) {
        const field = ctx.ownEnvFields.find(f => f.name === v)
        if (field) return field.type || 'f64'
      }
      if (ctx.closureInfo?.envFields) {
        const field = ctx.closureInfo.envFields.find(f => f.name === v)
        if (field) return field.type || 'f64'
      }
      return 'f64'
    }

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
        envFields = captured.map((v, i) => ({ name: v, index: i, type: getVarType(v) }))
        if (opts.gc) {
          ctx.closureEnvTypes.push({ id: envId, fields: envFields })
        }
      }

      ctx.closures[target] = { envType, envFields, captured, params, body, usesOwnEnv: allFromOwnEnv }

      // Register the lifted function (with env param)
      // Track closure depth for call sites
      const depth = closureDepth(body)
      ctx.functions[target] = {
        params,
        paramInfo,
        body,
        exported: false,
        closure: { envType, envFields, captured, usesOwnEnv: allFromOwnEnv },
        closureDepth: depth
      }

      return returnValue ? wat('(f64.const 0)', 'f64') : ''
    }

    // Check if function body returns a closure (arrow function as body)
    const returnsClosure = Array.isArray(body) && body[0] === '=>'
    const depth = closureDepth(body)

    // Regular function (no captures) - export only if explicitly exported
    ctx.functions[target] = { params, paramInfo, body, exported: ctx.exports.has(target), returnsClosure, closureDepth: depth }
    return returnValue ? wat('(f64.const 0)', 'f64') : ''
  }

  // Array destructuring: [a, b] = [1, 2]
  if (Array.isArray(target) && target[0] === '[]' && Array.isArray(target[1]) && target[1][0] === ',') {
    const vars = target[1].slice(1)
    ctx.usedArrayType = true
    const id = ctx.loopCounter++
    const tmp = `$_destruct_${id}`
    ctx.addLocal(tmp.slice(1), 'array')
    const aw = gen(value)
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
      ? wat(code + `(local.get $${lastVar})`, 'f64')
      : returnValue ? wat(code + '(f64.const 0)', 'f64') : code
  }

  // Object destructuring: {a, b} = {a: 5, b: 10}
  if (Array.isArray(target) && target[0] === '{}' && Array.isArray(target[1]) && target[1][0] === ',') {
    const props = target[1].slice(1)
    ctx.usedArrayType = true
    const id = ctx.loopCounter++
    const tmp = `$_destruct_${id}`
    ctx.addLocal(tmp.slice(1), 'object')
    const obj = gen(value)
    if (obj.type !== 'object' || obj.schema === undefined)
      throw new Error('Object destructuring requires object literal on RHS')
    const schema = ctx.objectSchemas[obj.schema]
    let code = `(local.set ${tmp} ${obj})\n    `
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
      ? wat(code + `(local.get $${lastVar})`, 'f64')
      : returnValue ? wat(code + '(f64.const 0)', 'f64') : code
  }

  // Array element assignment: arr[i] = x
  if (Array.isArray(target) && target[0] === '[]' && target.length === 3) {
    const aw = gen(target[1]), iw = i32(gen(target[2])), vw = f64(gen(value))
    ctx.usedArrayType = true
    if (opts.gc) {
      const code = `(array.set $f64array ${aw} ${iw} ${vw})`
      return returnValue ? wat(`${code} ${vw}`, 'f64') : code + '\n    '
    } else {
      ctx.usedMemory = true
      const code = `(f64.store (i32.add (call $__ptr_offset ${aw}) (i32.shl ${iw} (i32.const 3))) ${vw})`
      return returnValue ? wat(`${code} ${vw}`, 'f64') : code + '\n    '
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
    const { index, type } = ctx.hoistedVars[target]
    const setCode = envSet(opts.gc, ctx.ownEnvType, '$__ownenv', index, f64(val))
    const getCode = envGet(opts.gc, ctx.ownEnvType, '$__ownenv', index, type)
    return returnValue
      ? wat(`(block (result f64) ${setCode} ${getCode})`, type)
      : setCode + '\n    '
  }

  // Check if this is a captured variable (must be written to received env)
  if (ctx.capturedVars && target in ctx.capturedVars) {
    const { index, type } = ctx.capturedVars[target]
    const envVar = opts.gc ? '$__envcast' : '$__env'
    const setCode = envSet(opts.gc, ctx.currentEnv, envVar, index, f64(val))
    const getCode = envGet(opts.gc, ctx.currentEnv, envVar, index, type)
    return returnValue
      ? wat(`(block (result f64) ${setCode} ${getCode})`, type)
      : setCode + '\n    '
  }

  const glob = ctx.getGlobal(target)
  if (glob) {
    const code = `(global.set $${target} ${f64(val)})`
    return returnValue ? wat(`${code} (global.get $${target})`, val.type) : code + '\n    '
  }
  // Check if variable exists in scope
  const existing = ctx.getLocal(target)
  if (existing) {
    // Check const
    if (existing.scopedName in ctx.constVars) {
      throw new Error(`Assignment to constant variable: ${target}`)
    }
    return returnValue
      ? wat(`(local.tee $${existing.scopedName} ${val})`, val.type, val.schema)
      : `(local.set $${existing.scopedName} ${val})\n    `
  }
  // New variable - add to current scope
  ctx.addLocal(target, val.type, val.schema)
  const loc = ctx.getLocal(target)
  return returnValue
    ? wat(`(local.tee $${loc.scopedName} ${val})`, val.type, val.schema)
    : `(local.set $${loc.scopedName} ${val})\n    `
}

/**
 * Generate WAT for loop initializer (e.g., 'let i = 0' in for loop).
 * Simpler than genAssign - only handles simple variable assignment.
 *
 * @param {string} target - Variable name to initialize
 * @param {any} value - AST node for initial value
 * @returns {string} WAT code for the initialization
 * @example genLoopInit('i', [null, 0]) → '(local.set $i (f64.const 0))\n    '
 */
function genLoopInit(target, value) {
  if (typeof target !== 'string') throw new Error('Loop init must assign to variable')
  const v = gen(value)
  const glob = ctx.getGlobal(target)
  if (glob) return `(global.set $${target} ${f64(v)})\n    `
  const loc = ctx.getLocal(target)
  if (loc) return `(local.set $${loc.scopedName} ${f64(v)})\n    `
  ctx.addLocal(target, v.type)
  const newLoc = ctx.getLocal(target)
  return `(local.set $${newLoc.scopedName} ${f64(v)})\n    `
}

// =============================================================================
// FUNCTION GENERATION
// Creates WASM function definitions from AST, handling params, locals, closures.
// =============================================================================

/**
 * Generate a complete WASM function definition from AST.
 * Handles params, locals, closure environments, return types, and body compilation.
 *
 * @param {string} name - Function name (e.g., 'add', '__anon0')
 * @param {string[]} params - Parameter names
 * @param {object[]} paramInfo - Rich param info: [{name, default?, rest?, destruct?, pattern?, names?}]
 * @param {any} bodyAst - Function body AST
 * @param {object} parentCtx - Parent compilation context
 * @param {object|null} closureInfo - Closure metadata: {envType, envFields, usesOwnEnv}, or null
 * @param {boolean} exported - Whether function should be exported
 * @returns {string} Complete WAT function definition
 * @example generateFunction('add', ['a', 'b'], [...], ['+', 'a', 'b'], ctx, null, true)
 *          → '(func $add (export "add") (param $a f64) (param $b f64) (result f64) ...)'
 */
function generateFunction(name, params, paramInfo, bodyAst, parentCtx, closureInfo = null, exported = false) {
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
    newCtx.closureInfo = closureInfo  // Store for getVarType helper
    for (const field of closureInfo.envFields) {
      newCtx.capturedVars[field.name] = { index: field.index, type: field.type || 'f64' }
    }
  }

  // If this function has hoisted vars, create OWN env for them
  // This is separate from the received env (if any)
  // Note: hoisted vars currently assume f64 type - arrays/objects as hoisted vars
  // would need type tracking during body compilation (TODO)
  if (hoistedVars.size > 0) {
    const envId = parentCtx.closureCounter++
    newCtx.ownEnvType = `$env${envId}`
    newCtx.ownEnvFields = [...hoistedVars].map((v, i) => ({ name: v, index: i, type: 'f64' }))
    // Track which vars are in our own env (for read/write)
    newCtx.hoistedVars = {}
    for (const field of newCtx.ownEnvFields) {
      newCtx.hoistedVars[field.name] = { index: field.index, type: field.type }
    }
    // Register env type
    if (opts.gc) {
      parentCtx.closureEnvTypes.push({ id: envId, fields: newCtx.ownEnvFields })
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

  // Detect rest param (must be last in paramInfo)
  const restParam = paramInfo?.find(pi => pi.rest)
  const hasRestParam = !!restParam

  // Detect destructuring params
  const destructParams = paramInfo?.filter(pi => pi.destruct) || []

  // Register params as locals with appropriate types
  for (const p of params) {
    if (restParam && p === restParam.name) {
      // Rest param is typed as array
      ctx.locals[p] = { idx: ctx.localCounter++, type: 'array' }
      ctx.usedArrayType = true
    } else {
      // Check if destructuring param
    const destructInfo = destructParams.find(di => di.name === p)
    if (destructInfo) {
      // Destructuring param - both array and object are typed as f64array
      ctx.locals[p] = { idx: ctx.localCounter++, type: 'array' }
      ctx.usedArrayType = true
    } else {
      ctx.locals[p] = { idx: ctx.localCounter++, type: 'f64' }
    }
    }
  }

  // Add locals for destructured names
  for (const di of destructParams) {
    for (const name of di.names) {
      ctx.addLocal(name, 'f64')
    }
  }

  // Generate default param initialization code
  let paramInit = ''
  if (paramInfo) {
    for (const pi of paramInfo) {
      if (pi.default !== undefined) {
        // Generate: if param is NaN (undefined), set to default
        // In JS, undefined args come as NaN in our encoding
        const defaultVal = gen(pi.default)
        // Check if param is undefined (NaN) - use f64.ne(x, x) which is true for NaN
        paramInit += `(if (f64.ne (local.get $${pi.name}) (local.get $${pi.name}))
        (then (local.set $${pi.name} ${f64(defaultVal)})))\n      `
      }
    }
  }

  // Generate destructuring unpacking code
  for (const di of destructParams) {
    if (di.destruct === 'array') {
      // Array destructuring: extract elements by index
      di.names.forEach((name, idx) => {
        if (opts.gc) {
          paramInit += `(local.set $${name} (array.get $f64array (local.get $${di.name}) (i32.const ${idx})))\n      `
        } else {
          // gc:false: array is NaN-boxed pointer, need to read from memory
          ctx.usedMemory = true
          paramInit += `(local.set $${name} (f64.load (i32.add (call $__ptr_offset (local.get $${di.name})) (i32.const ${idx * 8}))))\n      `
        }
      })
    } else if (di.destruct === 'object') {
      // Object destructuring: extract by index (assumes property order matches)
      // Note: objects are f64array with schema, keys accessed by index
      di.names.forEach((name, idx) => {
        if (opts.gc) {
          paramInit += `(local.set $${name} (array.get $f64array (local.get $${di.name}) (i32.const ${idx})))\n      `
        } else {
          ctx.usedMemory = true
          paramInit += `(local.set $${name} (f64.load (i32.add (call $__ptr_offset (local.get $${di.name})) (i32.const ${idx * 8}))))\n      `
        }
      })
    }
  }

  const bodyResult = gen(bodyAst)

  // Determine return type and final body
  let returnType, bodyWat
  if (opts.gc && bodyResult.type === 'closure') {
    // Function returns a closure - use anyref return type
    returnType = 'anyref'
    bodyWat = String(bodyResult)
  } else {
    // Normal f64 return
    returnType = 'f64'
    bodyWat = f64(bodyResult)
  }

  // Generate param declarations with correct types
  const paramDecls = params.map(p => {
    if (restParam && p === restParam.name) {
      // Rest param is array type
      return opts.gc ? `(param $${p} (ref null $f64array))` : `(param $${p} f64)`
    }
    // Check if destructuring param - both array and object are f64array
    const destructInfo = destructParams.find(di => di.name === p)
    if (destructInfo) {
      return opts.gc ? `(param $${p} (ref null $f64array))` : `(param $${p} f64)`
    }
    return `(param $${p} f64)`
  }).join(' ')
  const localDecls = ctx.localDecls.length ? `\n    ${ctx.localDecls.join(' ')}` : ''
  // Export only if explicitly exported and not a closure
  const exportClause = (exported && !closureInfo) ? ` (export "${name}")` : ''
  // Wrap body in block to support early return
  const watCode = `(func $${name}${exportClause} ${envParam}${paramDecls} (result ${returnType})${localDecls}\n    (block ${ctx.returnLabel} (result ${returnType})\n      ${envInit}${paramInit}${bodyWat}\n    )\n  )`

  // Track if this function returns a closure (for call sites)
  if (bodyResult.type === 'closure') {
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
  return watCode
}

/**
 * Generate all registered functions, including closures added during generation.
 * Iterates until no new functions are added (handles nested closures).\n * \n * @returns {string[]} Array of WAT function definitions\n */
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
      results.push(generateFunction(name, def.params, def.paramInfo, def.body, ctx, closureInfo, def.exported))
    }
  }
  return results
}
