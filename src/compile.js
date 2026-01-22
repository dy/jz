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
  push: array.push, pop: array.pop, shift: array.shift, unshift: array.unshift,
  forEach: array.forEach, concat: array.concat, join: array.join,
  flat: array.flat, flatMap: array.flatMap
}

const stringMethods = {
  charCodeAt: string.charCodeAt, slice: string.slice, indexOf: string.indexOf, substring: string.substring,
  toLowerCase: string.toLowerCase, toUpperCase: string.toUpperCase, includes: string.includes,
  startsWith: string.startsWith, endsWith: string.endsWith, trim: string.trim,
  trimStart: string.trimStart, trimEnd: string.trimEnd,
  substr: string.substr, repeat: string.repeat, padStart: string.padStart, padEnd: string.padEnd,
  split: string.split, replace: string.replace
}
import { PTR_TYPE, ELEM_TYPE, TYPED_ARRAY_CTORS, ELEM_STRIDE, wat, fmtNum, f64, i32, bool, conciliate, isF64, isI32, isString, isArray, isObject, isClosure, isRef, isRefArray, isBoxedString, isBoxedNumber, isBoxedBoolean, isArrayProps, isTypedArray, bothI32, isHeapRef, hasSchema } from './types.js'
import { extractParams, extractParamInfo, analyzeScope, findHoistedVars, findF64Vars, findFuncReturnTypes } from './analyze.js'
import { f64ops, i32ops, MATH_OPS, GLOBAL_CONSTANTS } from './ops.js'
import { createContext } from './context.js'
import { assemble } from './assemble.js'
import { nullRef, mkString, envGet, envSet, arrGet, arrGetTyped, arrLen, objGet, objSet, strCharAt, mkArrayLiteral, callClosure, typedArrNew, typedArrGet, typedArrSet, typedArrLen } from './memory.js'
import { TYPED_ARRAY_METHODS } from './typedarray.js'

// Check if type is array-like (for aliasing warnings)
const isArrayType = t => t === 'array' || t === 'refarray'

// Check if AST node is an array literal or array-returning expression
const isArrayExpr = node => {
  if (!Array.isArray(node)) return false
  const op = node[0]
  // Array literal: ['[', ...]
  if (op === '[') return true
  // Array constructor: ['()', ['.', 'Array', method], ...]
  if (op === '()' && Array.isArray(node[1]) && node[1][0] === '.' && node[1][1] === 'Array') return true
  // Array methods that return arrays: .map, .filter, .slice, .reverse, .concat
  if (op === '()' && Array.isArray(node[1]) && (node[1][0] === '.' || node[1][0] === '?.')) {
    const method = node[1][2]
    if (['map', 'filter', 'slice', 'reverse', 'concat', 'fill'].includes(method)) return true
  }
  return false
}

// Current compilation state (module-level for nested access)
export let ctx = null
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
  // Initialize shared state for method modules
  setCtx(createContext())
  // Pre-analyze for type promotion (which vars need f64)
  ctx.f64Vars = findF64Vars(ast)
  // Pre-analyze function return types (which funcs can return i32)
  ctx.funcReturnTypes = findFuncReturnTypes(ast)
  gen = generate
  const bodyWat = String(f64(generate(ast)))
  return assemble(bodyWat, ctx, generateFunctions())
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
  if (Array.isArray(ast) && ast[0] == null) return typeof ast[1] === 'number'
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
 * Detect if AST is a fixed-size array literal eligible for multi-value return.
 * Must be 2-8 elements, no spread, all numeric expressions.
 * @param {any} ast - AST node to check
 * @returns {number|false} Element count if eligible, false otherwise
 */
function isFixedArrayLiteral(ast) {
  if (!Array.isArray(ast) || ast[0] !== '[') return false
  const elems = ast.slice(1)
  // 2-8 elements, no spread
  if (elems.length < 2 || elems.length > 8) return false
  for (const e of elems) {
    // Spread disqualifies
    if (Array.isArray(e) && e[0] === '...') return false
  }
  return elems.length
}

/**
 * Pre-scan function body to detect if all return statements use same-size fixed array literal.
 * Also handles implicit return (arrow function expression body that is array literal).
 * Returns the count if all returns match, 0 otherwise.
 * @param {any} ast - Function body AST
 * @returns {number} Multi-value count (2-8) or 0 if not eligible
 */
function detectMultiReturn(ast) {
  // Direct array literal body (implicit return): () => [a, b, c]
  const directN = isFixedArrayLiteral(ast)
  if (directN) return directN

  let count = 0
  function scan(node) {
    if (!Array.isArray(node)) return true
    const [op, ...args] = node
    if (op === 'return') {
      const n = isFixedArrayLiteral(args[0])
      if (!n) return false  // Non-array return disqualifies
      if (count === 0) count = n
      else if (count !== n) return false  // Inconsistent sizes
      return true
    }
    // Skip nested function definitions
    if (op === '=>' || op === 'function') return true
    // Recurse into children
    for (const arg of args) {
      if (!scan(arg)) return false
    }
    return true
  }
  return scan(ast) ? count : 0
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
  if (Array.isArray(ast) && ast[0] == null) return ast[1]
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
 * @example genLiteral(42) → {type:'i32', wat:'(i32.const 42)'}
 * @example genLiteral(3.14) → {type:'f64', wat:'(f64.const 3.14)'}
 * @example genLiteral(true) → {type:'i32', wat:'(i32.const 1)'}
 * @example genLiteral('hello') → {type:'string', wat:'(call $__strconst ...)'}
 */
function genLiteral(v) {
  if (v === null || v === undefined) return nullRef()
  if (typeof v === 'number') {
    // Integer literals stay i32, float literals become f64
    if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) {
      return wat(`(i32.const ${v})`, 'i32')
    }
    return wat(`(f64.const ${fmtNum(v)})`, 'f64')
  }
  if (typeof v === 'boolean') return wat(`(i32.const ${v ? 1 : 0})`, 'i32')
  if (typeof v === 'string') return mkString(ctx, v)
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
  if (name === 'null' || name === 'undefined') return nullRef()
  if (name === 'true') return wat('(i32.const 1)', 'i32')
  if (name === 'false') return wat('(i32.const 0)', 'i32')
  if (name in GLOBAL_CONSTANTS) return wat(`(f64.const ${fmtNum(GLOBAL_CONSTANTS[name])})`, 'f64')

  // Check if this is a hoisted variable (in our own env, for nested closure access)
  if (ctx.hoistedVars && name in ctx.hoistedVars) {
    const { index } = ctx.hoistedVars[name]
    return wat(envGet('$__ownenv', index), 'f64')
  }

  // Check if this is a captured variable (from closure environment passed to us)
  if (ctx.capturedVars && name in ctx.capturedVars) {
    const { index, type, schema } = ctx.capturedVars[name]
    return wat(envGet('$__env', index), type || 'f64', schema)
  }

  const loc = ctx.getLocal(name)
  if (loc) {
    const result = wat(`(local.get $${loc.scopedName})`, loc.type, ctx.localSchemas[loc.scopedName])
    result.paramName = name  // Track original name for array param inference
    return result
  }
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

    // TypedArray methods - dispatch with compile-time elemType
    if (isTypedArray(receiver) && TYPED_ARRAY_METHODS[name]) {
      ctx.usedTypedArrays = true
      ctx.usedMemory = true
      const elemType = receiver.schema  // elemType stored in schema field
      return TYPED_ARRAY_METHODS[name](elemType, rw, args)
    }

    // Dispatch to method modules - f64 can be array pointer
    const isArrayLike = rt === 'array' || rt === 'f64'
    if (isArrayLike && arrayMethods[name]) {
      // Track param usage for JS interop
      if (receiver.paramName) {
        ctx.inferredArrayParams.add(receiver.paramName)
      }
      const result = arrayMethods[name](rw, args)
      if (result) return result
    }
    if (rt === 'string' && stringMethods[name]) {
      const result = stringMethods[name](rw, args)
      if (result) return result
    }

    // Check if receiver is a closure/function property from an object
    if (receiver.type === 'closure' && receiver.objWat) {
      // Object method call: obj.method(args)
      ctx.usedMemory = true
      const argWats = args.map(a => f64(gen(a))).join(' ')
      const closureWat = receiver.toString()
      const result = wat(callClosure(ctx, closureWat, argWats, args.length), 'f64')
      return result
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

  // Array namespace
  if (namespace === 'Array') {
    if (name === 'isArray' && args.length === 1) {
      const w = gen(args[0])
      // Check: 1) is NaN (pointer), 2) type is ARRAY (1) or ARRAY_PROPS (8)
      // Type is in bits 47-50 (4 bits)
      const v = f64(w)
      const isNaN = `(f64.ne ${v} ${v})`
      const typeVal = `(i32.and (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 ${v}) (i64.const 47))) (i32.const 15))`
      return wat(`(i32.and ${isNaN} (i32.or (i32.eq ${typeVal} (i32.const 1)) (i32.eq ${typeVal} (i32.const 8))))`, 'i32')
    }
    throw new Error(`Unknown Array.${name}`)
  }

  // Object namespace
  if (namespace === 'Object') {
    if (name === 'assign' && args.length >= 2) {
      // Object.assign(target, source) - create boxed string or array with properties
      const targetAst = args[0], sourceAst = args[1]
      const target = gen(targetAst), source = gen(sourceAst)

      // Extract props from source (must be object literal at compile time)
      if (!Array.isArray(sourceAst) || sourceAst[0] !== '{') {
        throw new Error('Object.assign source must be object literal')
      }
      const props = sourceAst.slice(1)
      const propKeys = props.map(p => p[0])

      if (isString(target)) {
        // BOXED_STRING: Schema = ['__string__', ...props], Memory = [stringPtr, ...propVals]
        ctx.usedArrayType = true
        ctx.usedMemory = true
        const schemaId = ctx.objectCounter + 1
        ctx.objectCounter++
        ctx.objectSchemas[schemaId] = ['__string__', ...propKeys]
        // Track property types
        if (!ctx.objectPropTypes) ctx.objectPropTypes = {}
        ctx.objectPropTypes[schemaId] = { __string__: { type: 'string' } }
        const propVals = [String(target)]  // First slot = string pointer
        for (let i = 0; i < props.length; i++) {
          const g = gen(props[i][1])
          propVals.push(String(f64(g)))
          // Track prop type
          if (g.type === 'object' && g.schema) ctx.objectPropTypes[schemaId][propKeys[i]] = { type: 'object', schema: g.schema }
          else if (g.type === 'string') ctx.objectPropTypes[schemaId][propKeys[i]] = { type: 'string' }
          else if (g.type === 'array') ctx.objectPropTypes[schemaId][propKeys[i]] = { type: 'array' }
        }
        const id = ctx.loopCounter++
        const tmp = `$_bstr_${id}`
        ctx.addLocal(tmp.slice(1), 'f64')
        let stores = ''
        for (let i = 0; i < propVals.length; i++) {
          stores += `(f64.store (i32.add (call $__ptr_offset (local.get ${tmp})) (i32.const ${i * 8})) ${propVals[i]})\n      `
        }
        // Allocate as OBJECT with __string__ as first schema key
        return wat(`(block (result f64)
      (local.set ${tmp} (call $__alloc (i32.const ${PTR_TYPE.OBJECT}) (i32.const ${propVals.length})))
      (local.set ${tmp} (call $__ptr_with_id (local.get ${tmp}) (i32.const ${schemaId})))
      ${stores}(local.get ${tmp}))`, 'boxed_string', schemaId)
      }

      if (isArray(target)) {
        // ARRAY_PROPS: Memory = [elements..., propVals...]
        // Use instance table to store both len and schemaId
        ctx.usedArrayType = true
        ctx.usedMemory = true
        const schemaId = ctx.objectCounter + 1
        ctx.objectCounter++
        ctx.objectSchemas[schemaId] = propKeys
        // Track property types
        if (!ctx.objectPropTypes) ctx.objectPropTypes = {}
        ctx.objectPropTypes[schemaId] = {}
        const propVals = []
        for (let i = 0; i < props.length; i++) {
          const g = gen(props[i][1])
          propVals.push(String(f64(g)))
          if (g.type === 'object' && g.schema) ctx.objectPropTypes[schemaId][propKeys[i]] = { type: 'object', schema: g.schema }
          else if (g.type === 'string') ctx.objectPropTypes[schemaId][propKeys[i]] = { type: 'string' }
          else if (g.type === 'array') ctx.objectPropTypes[schemaId][propKeys[i]] = { type: 'array' }
        }
        const id = ctx.loopCounter++
        const tmp = `$_aprp_${id}`, tmpLen = `$_alen_${id}`, tmpInstId = `$_ainst_${id}`
        ctx.addLocal(tmp.slice(1), 'f64')
        ctx.addLocal(tmpLen.slice(1), 'i32')
        ctx.addLocal(tmpInstId.slice(1), 'i32')
        // Get source array length, allocate space for elements + props
        let stores = ''
        for (let i = 0; i < propVals.length; i++) {
          // Props stored AFTER array elements: offset + len*8 + i*8
          stores += `(f64.store (i32.add (call $__ptr_offset (local.get ${tmp})) (i32.add (i32.shl (local.get ${tmpLen}) (i32.const 3)) (i32.const ${i * 8}))) ${propVals[i]})\n      `
        }
        // Allocate with ARRAY_PROPS type using instance table
        // Instance table: [len:u16, schemaId:u16]
        return wat(`(block (result f64)
      (local.set ${tmpLen} (call $__ptr_len ${target}))
      (local.set ${tmp} (call $__alloc_array_props (local.get ${tmpLen}) (i32.const ${propVals.length}) (i32.const ${schemaId})))
      (memory.copy (call $__ptr_offset (local.get ${tmp})) (call $__ptr_offset ${target}) (i32.shl (local.get ${tmpLen}) (i32.const 3)))
      ${stores}(local.get ${tmp}))`, 'array_props', schemaId)
      }

      // Check for boolean literal in AST (true/false identifiers or boolean values)
      const isBoolTarget = targetAst === 'true' || targetAst === 'false' ||
        (Array.isArray(targetAst) && targetAst[0] === undefined && typeof targetAst[1] === 'boolean')
      // Check for number literal in AST
      const isNumTarget = (isI32(target) || isF64(target)) && !isBoolTarget

      if (isBoolTarget) {
        // BOXED_BOOLEAN: Schema = ['__boolean__', ...props], Memory = [boolValue, ...propVals]
        ctx.usedArrayType = true
        ctx.usedMemory = true
        const schemaId = ctx.objectCounter + 1
        ctx.objectCounter++
        ctx.objectSchemas[schemaId] = ['__boolean__', ...propKeys]
        if (!ctx.objectPropTypes) ctx.objectPropTypes = {}
        ctx.objectPropTypes[schemaId] = { __boolean__: { type: 'boolean' } }
        const propVals = [String(f64(target))]  // First slot = boolean as f64
        for (let i = 0; i < props.length; i++) {
          const g = gen(props[i][1])
          propVals.push(String(f64(g)))
          if (g.type === 'object' && g.schema) ctx.objectPropTypes[schemaId][propKeys[i]] = { type: 'object', schema: g.schema }
          else if (g.type === 'string') ctx.objectPropTypes[schemaId][propKeys[i]] = { type: 'string' }
          else if (g.type === 'array') ctx.objectPropTypes[schemaId][propKeys[i]] = { type: 'array' }
        }
        const id = ctx.loopCounter++
        const tmp = `$_bbool_${id}`
        ctx.addLocal(tmp.slice(1), 'f64')
        let stores = ''
        for (let i = 0; i < propVals.length; i++) {
          stores += `(f64.store (i32.add (call $__ptr_offset (local.get ${tmp})) (i32.const ${i * 8})) ${propVals[i]})\n      `
        }
        return wat(`(block (result f64)
      (local.set ${tmp} (call $__alloc (i32.const ${PTR_TYPE.OBJECT}) (i32.const ${propVals.length})))
      (local.set ${tmp} (call $__ptr_with_id (local.get ${tmp}) (i32.const ${schemaId})))
      ${stores}(local.get ${tmp}))`, 'boxed_boolean', schemaId)
      }

      if (isNumTarget) {
        // BOXED_NUMBER: Schema = ['__number__', ...props], Memory = [numValue, ...propVals]
        ctx.usedArrayType = true
        ctx.usedMemory = true
        const schemaId = ctx.objectCounter + 1
        ctx.objectCounter++
        ctx.objectSchemas[schemaId] = ['__number__', ...propKeys]
        if (!ctx.objectPropTypes) ctx.objectPropTypes = {}
        ctx.objectPropTypes[schemaId] = { __number__: { type: 'number' } }
        const propVals = [String(f64(target))]  // First slot = number as f64
        for (let i = 0; i < props.length; i++) {
          const g = gen(props[i][1])
          propVals.push(String(f64(g)))
          if (g.type === 'object' && g.schema) ctx.objectPropTypes[schemaId][propKeys[i]] = { type: 'object', schema: g.schema }
          else if (g.type === 'string') ctx.objectPropTypes[schemaId][propKeys[i]] = { type: 'string' }
          else if (g.type === 'array') ctx.objectPropTypes[schemaId][propKeys[i]] = { type: 'array' }
        }
        const id = ctx.loopCounter++
        const tmp = `$_bnum_${id}`
        ctx.addLocal(tmp.slice(1), 'f64')
        let stores = ''
        for (let i = 0; i < propVals.length; i++) {
          stores += `(f64.store (i32.add (call $__ptr_offset (local.get ${tmp})) (i32.const ${i * 8})) ${propVals[i]})\n      `
        }
        return wat(`(block (result f64)
      (local.set ${tmp} (call $__alloc (i32.const ${PTR_TYPE.OBJECT}) (i32.const ${propVals.length})))
      (local.set ${tmp} (call $__ptr_with_id (local.get ${tmp}) (i32.const ${schemaId})))
      ${stores}(local.get ${tmp}))`, 'boxed_number', schemaId)
      }

      throw new Error('Object.assign target must be string, number, boolean, or array')
    }
    throw new Error(`Unknown Object.${name}`)
  }

  // Global functions
  if (namespace === null) {
    if (name === 'isNaN' || name === 'isFinite') return resolveCall('Number', name, args)
    if (name === 'Array' && args.length === 1) {
      ctx.usedArrayType = true
      ctx.usedMemory = true
      return wat(`(call $__alloc (i32.const ${PTR_TYPE.ARRAY}) ${i32(gen(args[0]))})`, 'f64')
    }
    if (name === 'parseInt') {
      const val = gen(args[0])
      // Warn if no radix provided (JZ defaults to 10, but JS behavior varies)
      if (args.length < 2) {
        console.warn('jz: [parseInt] ' + `parseInt() without radix; JZ defaults to 10, consider explicit radix`)
      }
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
        const restArrayWat = mkArrayLiteral(ctx, restVals, () => false, () => null, restArgs)
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
        return wat(`(call $${name} (local.get $__ownenv) ${argWats})`, 'f64')
      }

      // Build a new environment with captured variables (in memory)
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
        // Store at direct offset (no header)
        return `(f64.store (i32.add (global.get $__heap) (i32.const ${i * 8})) ${val})`
      }).join('\n        ')
      // Calculate total env size (no header), aligned to 8 bytes
      const alignedEnvSize = (envSize + 7) & ~7
      // Allocate env, store values, call function
      // NaN boxing: mkptr(type, id, offset) - for closure, id = envFields.length
      return wat(`(block (result f64)
        ${envVals}
        (call $${name}
          (call $__mkptr (i32.const ${PTR_TYPE.CLOSURE}) (i32.const ${envFields.length}) (global.get $__heap))
          ${argWats})
        (global.set $__heap (i32.add (global.get $__heap) (i32.const ${alignedEnvSize})))
      )`, 'f64')
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
      // Closure is f64 NaN-boxed, track type for chained calls
      return wat(`(call $${name} ${argWats})`, 'closure', { closureDepth: depth })
    }
    // Use pre-analyzed return type if available (i32 or f64)
    const retType = ctx.funcReturnTypes?.get(name) || 'f64'
    return wat(`(call $${name} ${argWats})`, retType)
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
  return wat(callClosure(ctx, String(closureVal), argWats, args.length, isNullable), 'f64')
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
  const code = callClosure(ctx, String(closureVal), argWats, args.length, true, returnsClosure)
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
  // Memory-based closure: NaN-encode table index + env pointer
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

  // Create closure: NaN-box with [0x7FF0][envLen:16][tableIdx:16][envOffset:32]
  // This custom closure encoding stores envLen and tableIdx in upper bits for call_indirect
  // Note: This doesn't use unified __mkptr since closures need special decoding in callClosure
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

  // Constructor calls: new TypedArray(len)
  'new'([ctorCall]) {
    // ctorCall is ['()', ctor, ...args]
    if (!Array.isArray(ctorCall) || ctorCall[0] !== '()') {
      throw new Error(`Invalid new expression: ${JSON.stringify(ctorCall)}`)
    }
    const [, ctor, ...args] = ctorCall
    const ctorName = typeof ctor === 'string' ? ctor : null

    // TypedArray constructors
    if (ctorName && ctorName in TYPED_ARRAY_CTORS) {
      if (args.length !== 1) {
        throw new Error(`${ctorName}(len) requires exactly 1 argument`)
      }
      ctx.usedTypedArrays = true
      ctx.usedMemory = true
      const elemType = TYPED_ARRAY_CTORS[ctorName]
      const lenVal = gen(args[0])
      return wat(typedArrNew(elemType, i32(lenVal)), 'typedarray', elemType)
    }

    throw new Error(`Unsupported constructor: ${ctorName || JSON.stringify(ctor)}`)
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
      if (typeof obj === 'string' && (obj === 'Math' || obj === 'Number' || obj === 'Array' || obj === 'Object')) {
        namespace = obj
        name = method
      } else if (typeof obj === 'string' && ctx.namespaces[obj]) {
        // Static namespace method call: ns.method(args) → call $ns_method
        const ns = ctx.namespaces[obj]
        if (ns[method]) {
          const funcName = ns[method].funcName
          const argWats = args.map(a => f64(gen(a))).join(' ')
          return wat(`(call $${funcName} ${argWats})`, 'f64')
        }
        throw new Error(`Unknown method '${method}' in namespace '${obj}'`)
      } else {
        // Check if this is an object method call (closure property)
        const objVal = gen(obj)
        if (isObject(objVal) && hasSchema(objVal)) {
          const schema = ctx.objectSchemas[objVal.schema]
          const propTypes = ctx.objectPropTypes?.[objVal.schema]
          const idx = schema?.indexOf(method)
          if (idx >= 0 && propTypes?.[method] === 'closure') {
            // This is an object method call - load closure and call it
            ctx.usedMemory = true
            const closureWat = objGet(String(objVal), idx)
            const argWats = args.map(a => f64(gen(a))).join(' ')
            return wat(callClosure(ctx, closureWat, argWats, args.length), 'f64')
          }
        }
        receiver = objVal
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
      return mkArrayLiteral(ctx, gens, isConstant, evalConstant, elements)
    }

    // Handle spread: [...arr1, x, ...arr2, y] -> concat arrays and elements
    ctx.usedArrayType = true
    ctx.usedMemory = true
    const id = ctx.loopCounter++
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
      (local.set ${tmpArr} (call $__alloc (i32.const ${PTR_TYPE.ARRAY}) (local.get ${tmpLen})))
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
  },

  '{'(props) {
    if (props.length === 0) return nullRef()
    ctx.usedArrayType = true
    ctx.usedMemory = true
    const keys = props.map(p => p[0])
    // Schema IDs start at 1 (0 = plain array)
    const schemaId = ctx.objectCounter + 1
    ctx.objectCounter++
    ctx.objectSchemas[schemaId] = keys
    // Track property types for method call support and nested object access
    if (!ctx.objectPropTypes) ctx.objectPropTypes = {}
    ctx.objectPropTypes[schemaId] = {}
    const vals = []
    for (let i = 0; i < props.length; i++) {
      const [key, valueAst] = props[i]
      const g = gen(valueAst)
      vals.push(String(f64(g)))
      // Track property type info for nested access
      if (g.type === 'closure' || (Array.isArray(valueAst) && valueAst[0] === '=>')) {
        ctx.objectPropTypes[schemaId][key] = { type: 'closure' }
      } else if (g.type === 'object' && g.schema) {
        ctx.objectPropTypes[schemaId][key] = { type: 'object', schema: g.schema }
      } else if (g.type === 'array') {
        ctx.objectPropTypes[schemaId][key] = { type: 'array' }
      } else if (g.type === 'string') {
        ctx.objectPropTypes[schemaId][key] = { type: 'string' }
      }
    }
    const id = ctx.loopCounter++
    const tmp = `$_obj_${id}`
    ctx.addLocal(tmp.slice(1), 'f64')
    let stores = ''
    for (let i = 0; i < vals.length; i++) {
      stores += `(f64.store (i32.add (call $__ptr_offset (local.get ${tmp})) (i32.const ${i * 8})) ${vals[i]})\n      `
    }
    // NaN boxing: OBJECT type with schemaId as id field
    // mkptr(OBJECT, schemaId, offset)
    return wat(`(block (result f64)
      (local.set ${tmp} (call $__alloc (i32.const ${PTR_TYPE.OBJECT}) (i32.const ${vals.length})))
      (local.set ${tmp} (call $__ptr_with_id (local.get ${tmp}) (i32.const ${schemaId})))
      ${stores}(local.get ${tmp}))`, 'object', schemaId)
  },

  '[]'([arr, idx]) {
    const a = gen(arr), iw = i32(gen(idx))
    // Memory-based array access
    ctx.usedMemory = true

    // TypedArray access
    if (isTypedArray(a)) {
      const elemType = a.schema  // elemType stored in schema field
      return wat(typedArrGet(elemType, String(a), iw), 'f64')
    }

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
      return wat(strCharAt(String(a), iw), 'i32')
    }
    // Boxed string: delegate indexing to inner string pointer
    if (isBoxedString(a)) {
      return wat(`(i32.load16_u (i32.add (call $__ptr_offset (f64.load (call $__ptr_offset ${a}))) (i32.shl ${iw} (i32.const 1))))`, 'i32')
    }
    // Array with props: index into elements (same as regular array)
    if (isArrayProps(a)) {
      return wat(`(f64.load (i32.add (call $__ptr_offset ${a}) (i32.shl ${iw} (i32.const 3))))`, 'f64')
    }
    return arrGetTyped(ctx, String(a), iw)
  },

  '?.[]'([arr, idx]) {
    const aw = gen(arr), iw = i32(gen(idx))
    // Memory-based: check if pointer is 0 (null)
    ctx.usedMemory = true
    return wat(`(if (result f64) (f64.eq ${aw} (f64.const 0)) (then (f64.const 0)) (else (f64.load (i32.add (call $__ptr_offset ${aw}) (i32.shl ${iw} (i32.const 3))))))`, 'f64')
  },

  '.'([obj, prop]) {
    if (obj === 'Math' && prop in MATH_OPS.constants)
      return wat(`(f64.const ${fmtNum(MATH_OPS.constants[prop])})`, 'f64')
    // Number constants
    if (obj === 'Number') {
      const NUM_CONSTS = {
        MAX_VALUE: 1.7976931348623157e+308, MIN_VALUE: 5e-324, EPSILON: 2.220446049250313e-16,
        MAX_SAFE_INTEGER: 9007199254740991, MIN_SAFE_INTEGER: -9007199254740991,
        POSITIVE_INFINITY: Infinity, NEGATIVE_INFINITY: -Infinity, NaN: NaN
      }
      if (prop in NUM_CONSTS) return wat(`(f64.const ${fmtNum(NUM_CONSTS[prop])})`, 'f64')
    }
    const o = gen(obj)
    if (prop === 'length') {
      if (isTypedArray(o)) {
        ctx.usedMemory = true
        return wat(typedArrLen(String(o)), 'i32')
      }
      if (isArray(o) || isString(o) || isF64(o) || isArrayProps(o)) {
        ctx.usedMemory = true
        return wat(arrLen(String(o)), 'i32')
      }
      if (isBoxedString(o) && hasSchema(o)) {
        // Boxed string length: get inner string pointer, then its length
        ctx.usedMemory = true
        return wat(`(call $__ptr_len (f64.load (call $__ptr_offset ${o})))`, 'i32')
      }
      throw new Error(`Cannot get length of ${o.type}`)
    }
    if (prop === 'byteLength' && isTypedArray(o)) {
      // byteLength = length * stride
      ctx.usedMemory = true
      const elemType = o.schema
      const stride = ELEM_STRIDE[elemType]
      return wat(`(i32.mul ${typedArrLen(String(o))} (i32.const ${stride}))`, 'i32')
    }
    if (prop === 'BYTES_PER_ELEMENT' && isTypedArray(o)) {
      const elemType = o.schema
      const stride = ELEM_STRIDE[elemType]
      return wat(`(i32.const ${stride})`, 'i32')
    }
    if (prop === 'byteOffset' && isTypedArray(o)) {
      // byteOffset - always 0 for our TypedArrays (no ArrayBuffer backing)
      return wat('(i32.const 0)', 'i32')
    }

    // Boxed string property access
    if (isBoxedString(o) && hasSchema(o)) {
      const schema = ctx.objectSchemas[o.schema]
      if (schema) {
        const idx = schema.indexOf(prop)
        if (idx >= 0) {
          ctx.usedMemory = true
          const propInfo = ctx.objectPropTypes?.[o.schema]?.[prop]
          let resultType = 'f64', resultSchema
          if (propInfo) {
            if (propInfo.type === 'object' && propInfo.schema) { resultType = 'object'; resultSchema = propInfo.schema }
            else if (propInfo.type === 'string') resultType = 'string'
            else if (propInfo.type === 'array') resultType = 'array'
          }
          return wat(objGet(String(o), idx), resultType, resultSchema)
        }
      }
    }

    // Boxed number/boolean property access
    if ((isBoxedNumber(o) || isBoxedBoolean(o)) && hasSchema(o)) {
      const schema = ctx.objectSchemas[o.schema]
      if (schema) {
        const idx = schema.indexOf(prop)
        if (idx >= 0) {
          ctx.usedMemory = true
          const propInfo = ctx.objectPropTypes?.[o.schema]?.[prop]
          let resultType = 'f64', resultSchema
          if (propInfo) {
            if (propInfo.type === 'object' && propInfo.schema) { resultType = 'object'; resultSchema = propInfo.schema }
            else if (propInfo.type === 'string') resultType = 'string'
            else if (propInfo.type === 'array') resultType = 'array'
          }
          return wat(objGet(String(o), idx), resultType, resultSchema)
        }
      }
    }

    // Array with props property access
    if (isArrayProps(o) && hasSchema(o)) {
      const schema = ctx.objectSchemas[o.schema]
      if (schema) {
        const idx = schema.indexOf(prop)
        if (idx >= 0) {
          ctx.usedMemory = true
          const propInfo = ctx.objectPropTypes?.[o.schema]?.[prop]
          let resultType = 'f64', resultSchema
          if (propInfo) {
            if (propInfo.type === 'object' && propInfo.schema) { resultType = 'object'; resultSchema = propInfo.schema }
            else if (propInfo.type === 'string') resultType = 'string'
            else if (propInfo.type === 'array') resultType = 'array'
          }
          // Props are stored AFTER array elements: offset + len*8 + idx*8
          return wat(`(f64.load (i32.add (call $__ptr_offset ${o}) (i32.add (i32.shl (call $__ptr_len ${o}) (i32.const 3)) (i32.const ${idx * 8}))))`, resultType, resultSchema)
        }
      }
    }

    if (isObject(o) && hasSchema(o)) {
      const schema = ctx.objectSchemas[o.schema]
      if (schema) {
        const idx = schema.indexOf(prop)
        if (idx >= 0) {
          ctx.usedMemory = true
          const propInfo = ctx.objectPropTypes?.[o.schema]?.[prop]
          // Determine result type and schema from property info
          let resultType = 'f64'
          let resultSchema = undefined
          if (propInfo) {
            if (propInfo.type === 'object' && propInfo.schema) {
              resultType = 'object'
              resultSchema = propInfo.schema
            } else if (propInfo.type === 'closure') {
              resultType = 'closure'
            } else if (propInfo.type === 'array') {
              resultType = 'array'
            } else if (propInfo.type === 'string') {
              resultType = 'string'
            }
          }
          const result = wat(objGet(String(o), idx), resultType, resultSchema)
          // Preserve schema and property info for method calls
          result.objSchema = o.schema
          result.propName = prop
          result.propIdx = idx
          result.objWat = String(o)
          return result
        }
      }
    }
    throw new Error(`Invalid property: .${prop}`)
  },

  '?.'([obj, prop]) {
    const o = gen(obj)
    if (prop === 'length') {
      // Memory-based: arrays and strings are f64 pointers
      if (isF64(o) || isString(o) || isArray(o)) {
        ctx.usedMemory = true
        return wat(`(if (result f64) (f64.eq ${o} (f64.const 0)) (then (f64.const 0)) (else (f64.convert_i32_s (call $__ptr_len ${o}))))`, 'f64')
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

    // Helper to get variable schema for captured var (for objects)
    const getVarSchema = (v) => {
      const loc = ctx.getLocal(v)
      if (loc) return ctx.localSchemas[loc.scopedName]
      if (ctx.capturedVars?.[v]?.schema !== undefined) return ctx.capturedVars[v].schema
      return undefined
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
      envFields = captured.map((v, i) => ({ name: v, index: i, type: getVarType(v), schema: getVarSchema(v) }))
    }

    // Register the lifted function
    // Always mark as closure (needs __env param) since it will be called via call_indirect
    ctx.functions[closureName] = {
      params: fnParams,
      paramInfo: fnParamInfo,
      body,
      exported: false,
      closure: { envType, envFields, captured, usesOwnEnv: allFromOwnEnv }
    }

    // Return closure value
    return genClosureValue(closureName, envType, envFields, allFromOwnEnv, fnParams.length)
  },

  'return'([value]) {
    // Multi-value return: if enabled and returning fixed array literal
    // Only works when multiReturnCount was pre-detected in generateFunction
    if (ctx.multiReturnCount && value) {
      const n = isFixedArrayLiteral(value)
      if (n === ctx.multiReturnCount) {
        const elems = value.slice(1).map(e => f64(gen(e))).join(' ')
        if (ctx.returnLabel) {
          return wat(`(br ${ctx.returnLabel} ${elems})`, 'multi')
        }
        return wat(elems, 'multi')
      }
    }
    const retVal = value !== undefined ? f64(gen(value)) : wat('(f64.const 0)', 'f64')
    // If inside a function with a return label, use br to exit early
    if (ctx.returnLabel) {
      return wat(`(br ${ctx.returnLabel} ${retVal})`, 'f64')
    }
    return retVal
  },

  // Unary
  'u+'([a]) {
    // Error: +[] nonsense coercion
    if (Array.isArray(a) && a[0] === '[') {
      throw new Error('jz: +[] coercion is nonsense; arrays cannot be coerced to numbers')
    }
    return f64(gen(a))
  },
  'u-'([a]) { const v = gen(a); return v.type === 'i32' ? wat(`(i32.sub (i32.const 0) ${v})`, 'i32') : wat(`(f64.neg ${f64(v)})`, 'f64') },
  '!'([a]) { return wat(`(i32.eqz ${bool(gen(a))})`, 'i32') },
  '~'([a]) { return wat(`(i32.xor ${i32(gen(a))} (i32.const -1))`, 'i32') },

  // Arithmetic
  '+'([a, b]) {
    // Error: [] + {} nonsense coercion
    const isArrayA = Array.isArray(a) && a[0] === '['
    const isArrayB = Array.isArray(b) && b[0] === '['
    const isObjectA = Array.isArray(a) && a[0] === '{'
    const isObjectB = Array.isArray(b) && b[0] === '{'
    if ((isArrayA || isObjectA) && (isArrayB || isObjectB)) {
      throw new Error('jz: [] + {} coercion is nonsense; use explicit conversion')
    }
    const va = gen(a), vb = gen(b)
    return bothI32(va, vb) ? i32ops.add(va, vb) : f64ops.add(va, vb)
  },
  '-'([a, b]) { const va = gen(a), vb = gen(b); return bothI32(va, vb) ? i32ops.sub(va, vb) : f64ops.sub(va, vb) },
  '*'([a, b]) { const va = gen(a), vb = gen(b); return bothI32(va, vb) ? i32ops.mul(va, vb) : f64ops.mul(va, vb) },
  '/'([a, b]) { return f64ops.div(gen(a), gen(b)) },
  '%'([a, b]) { return wat(`(call $f64.rem ${f64(gen(a))} ${f64(gen(b))})`, 'f64') },
  '**'([a, b]) { ctx.usedStdlib.push('pow'); return wat(`(call $pow ${f64(gen(a))} ${f64(gen(b))})`, 'f64') },

  // Comparisons
  '=='([a, b]) {
    // Warn: NaN === NaN is always false (IEEE 754), suggest Number.isNaN
    const isNaN_a = a === 'NaN' || (Array.isArray(a) && a[0] === undefined && Number.isNaN(a[1]))
    const isNaN_b = b === 'NaN' || (Array.isArray(b) && b[0] === undefined && Number.isNaN(b[1]))
    if (isNaN_a || isNaN_b) {
      console.warn('jz: [NaN-compare] ' + `NaN comparison is always ${isNaN_a && isNaN_b ? 'false' : 'false for NaN'}; use Number.isNaN(x)`)
    }
    // Warn: x == null idiom (coercion doesn't work in JZ)
    const isNull_a = a === 'null' || (Array.isArray(a) && a[0] === undefined && a[1] === null)
    const isNull_b = b === 'null' || (Array.isArray(b) && b[0] === undefined && b[1] === null)
    const isUndef_a = a === 'undefined' || (Array.isArray(a) && a[0] === undefined && a[1] === undefined)
    const isUndef_b = b === 'undefined' || (Array.isArray(b) && b[0] === undefined && b[1] === undefined)
    if ((isNull_a || isNull_b) && !(isNull_a && isNull_b) && !(isUndef_a || isUndef_b)) {
      console.warn('jz: [null-compare] ' + `x == null idiom won\'t catch undefined; JZ has no type coercion`)
    }
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
        if (Array.isArray(typeofArg) && typeofArg[0] === undefined && typeofArg[1] === undefined) {
          // typeof undefined === "undefined"
          return wat(`(i32.const ${code === 0 ? 1 : 0})`, 'i32')
        }
        if (Array.isArray(typeofArg) && typeofArg[0] === undefined && typeofArg[1] === null) {
          // typeof null === "object" (JS quirk preserved)
          return wat(`(i32.const ${code === 4 ? 1 : 0})`, 'i32')
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
        // Check AST for boolean-producing expressions
        // Unwrap parentheses: ['()', expr] → expr
        let innerArg = typeofArg
        while (Array.isArray(innerArg) && innerArg[0] === '()' && innerArg.length === 2) {
          innerArg = innerArg[1]
        }
        const isBoolExpr = (typeof innerArg === 'string' && (innerArg === 'true' || innerArg === 'false')) ||
          (Array.isArray(innerArg) && innerArg[0] === undefined && typeof innerArg[1] === 'boolean') ||
          (Array.isArray(innerArg) && ['<', '<=', '>', '>=', '==', '===', '!=', '!==', '!'].includes(innerArg[0]))
        if (isF64(val)) {
          // f64 might be a regular number or an integer-packed pointer
          // Pointer threshold: values >= 2^48 are pointers (arrays/objects)
          // Check: if value >= threshold → pointer (type 4 = object), else number (type 1)
          ctx.usedMemory = true
          typeCode = `(select (i32.const 4) (i32.const 1) (call $__is_pointer ${val}))`
        } else if (isI32(val)) {
          // i32 can be boolean result or integer number - check AST
          typeCode = isBoolExpr ? '(i32.const 3)' : '(i32.const 1)'
        }
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
    // String comparison: use __ptr_eq for NaN-boxed pointers (f64.eq fails on NaN)
    if ((isString(va) || isBoxedString(va)) && (isString(vb) || isBoxedString(vb))) {
      ctx.usedMemory = true
      return wat(`(call $__ptr_eq ${va} ${vb})`, 'i32')
    }
    // Array/object comparison: reference equality via __ptr_eq
    if ((isArray(va) || isObject(va) || isArrayProps(va)) && (isArray(vb) || isObject(vb) || isArrayProps(vb))) {
      ctx.usedMemory = true
      return wat(`(call $__ptr_eq ${va} ${vb})`, 'i32')
    }
    // f64 comparison: use __f64_eq to handle both numbers and NaN-boxed pointers
    // f64.eq fails on NaN (including NaN-boxed pointers with identical bits)
    if (isF64(va) && isF64(vb)) {
      ctx.usedMemory = true
      return wat(`(call $__f64_eq ${va} ${vb})`, 'i32')
    }
    return bothI32(va, vb) ? i32ops.eq(va, vb) : f64ops.eq(va, vb)
  },
  '==='([a, b]) { return operators['==']([a, b]) },
  '!='([a, b]) {
    // Warn: NaN !== NaN is always true (IEEE 754), suggest Number.isNaN
    const isNaN_a = a === 'NaN' || (Array.isArray(a) && a[0] === undefined && Number.isNaN(a[1]))
    const isNaN_b = b === 'NaN' || (Array.isArray(b) && b[0] === undefined && Number.isNaN(b[1]))
    if (isNaN_a || isNaN_b) {
      console.warn('jz: [NaN-compare] ' + `NaN comparison is always ${isNaN_a && isNaN_b ? 'true' : 'true for NaN'}; use Number.isNaN(x)`)
    }
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
    // String comparison: use __ptr_eq for NaN-boxed pointers
    if ((isString(va) || isBoxedString(va)) && (isString(vb) || isBoxedString(vb))) {
      ctx.usedMemory = true
      return wat(`(i32.eqz (call $__ptr_eq ${va} ${vb}))`, 'i32')
    }
    // Array/object comparison: reference inequality via __ptr_eq
    if ((isArray(va) || isObject(va) || isArrayProps(va)) && (isArray(vb) || isObject(vb) || isArrayProps(vb))) {
      ctx.usedMemory = true
      return wat(`(i32.eqz (call $__ptr_eq ${va} ${vb}))`, 'i32')
    }
    // f64 comparison: use __f64_ne to handle both numbers and NaN-boxed pointers
    if (isF64(va) && isF64(vb)) {
      ctx.usedMemory = true
      return wat(`(call $__f64_ne ${va} ${vb})`, 'i32')
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
          // Preserve type (i32 stays i32 for loop counters)
          code += `(local.set $${scopedName} ${val})\n    `
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

  // Block with scope OR object literal
  // Parser outputs: block = ["{}", [";", ...]], object = ["{}", [":", k, v]] or ["{}", [",", ...]]
  '{}'([body]) {
    // Empty object
    if (body === null) return operators['{']([] )
    // Object literal: single property [":", key, val]
    if (Array.isArray(body) && body[0] === ':') {
      return operators['{']([[body[1], body[2]]])
    }
    // Object literal: multiple properties [",", [":", k1, v1], [":", k2, v2], ...]
    if (Array.isArray(body) && body[0] === ',') {
      const props = body.slice(1).map(p => [p[1], p[2]])
      return operators['{'](props)
    }
    // Block scope
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

    // Special case: exported arrow function without captures -> direct function registration
    // This enables multi-value returns for: export let rgb = (h, s, l) => [h * 255, ...]
    if (Array.isArray(value) && value[0] === '=>' && ctx.exports.has(name) && !ctx.inFunction) {
      const [, params, body] = value
      const fnParams = extractParams(params)
      const fnParamInfo = extractParamInfo(params)
      // Check if captures anything (exclude namespace refs - they're compile-time only)
      const analysis = analyzeScope(body, new Set(fnParams), true)
      const localNames = Object.keys(ctx.locals)
      const captured = [...analysis.free].filter(v =>
        localNames.includes(v) && !fnParams.includes(v) && !ctx.namespaces[v]
      )
      if (captured.length === 0) {
        // No captures - register as direct exported function
        ctx.functions[name] = { params: fnParams, paramInfo: fnParamInfo, body, exported: true }
        return wat('(f64.const 0)', 'f64')
      }
    }

    // Static namespace pattern: let ns = { fn1: (x) => ..., fn2: (a,b) => ... }
    // All properties must be arrow functions without captures
    if (Array.isArray(value) && value[0] === '{') {
      const props = value.slice(1)
      const isNamespace = props.length > 0 && props.every(([key, val]) =>
        Array.isArray(val) && val[0] === '=>'
      )
      if (isNamespace) {
        const localNames = Object.keys(ctx.locals)
        let hasCaptures = false
        for (const [key, [, params, body]] of props) {
          const fnParams = extractParams(params)
          const analysis = analyzeScope(body, new Set(fnParams), true)
          const captured = [...analysis.free].filter(v => localNames.includes(v) && !fnParams.includes(v))
          if (captured.length > 0) { hasCaptures = true; break }
        }
        if (!hasCaptures) {
          // Register as static namespace - direct function calls, no memory
          ctx.namespaces[name] = {}
          for (const [key, [, params, body]] of props) {
            const fnParams = extractParams(params)
            const fnParamInfo = extractParamInfo(params)
            const funcName = `${name}_${key}`
            ctx.namespaces[name][key] = { params: fnParams, body, funcName }
            ctx.functions[funcName] = { params: fnParams, paramInfo: fnParamInfo, body, exported: false }
          }
          ctx.declareVar(name, false)
          ctx.addLocal(name, 'namespace')
          return wat('(f64.const 0)', 'f64')
        }
      }
    }

    const scopedName = ctx.declareVar(name, false)
    const val = gen(value)
    // Track array variables (type-based for gc:true, AST-based for gc:false)
    const isArr = isArrayType(val.type) || isArrayExpr(value)
    if (isArr) {
      ctx.knownArrayVars.add(name)
    }
    // Warn on aliasing: b = a where a is known array
    if (typeof value === 'string' && ctx.knownArrayVars.has(value)) {
      console.warn('jz: [array-alias] ' + `'${name} = ${value}' copies array pointer, not values; mutations affect both`)
    }
    // Type promotion: if var is assigned f64 anywhere, use f64
    let varType = val.type
    if (varType === 'i32' && ctx.f64Vars && ctx.f64Vars.has(name)) {
      varType = 'f64'
    }
    ctx.addLocal(name, varType, val.schema, scopedName)
    // Convert init value to declared type
    const coercedVal = varType === 'f64' && val.type === 'i32'
      ? wat(`(f64.convert_i32_s ${val})`, 'f64')
      : val
    return wat(`(local.tee $${scopedName} ${coercedVal})`, varType, val.schema)
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
    // Track array variables (type-based for gc:true, AST-based for gc:false)
    const isArr = isArrayType(val.type) || isArrayExpr(value)
    if (isArr) {
      ctx.knownArrayVars.add(name)
    }
    // Warn on aliasing
    if (typeof value === 'string' && ctx.knownArrayVars.has(value)) {
      console.warn('jz: [array-alias] ' + `'${name} = ${value}' copies array pointer, not values; mutations affect both`)
    }
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
    // Warn: var hoisting surprises, suggest let/const
    console.warn('jz: [var] ' + `'var ${name}' is function-scoped and hoisted; prefer 'let' or 'const'`)
    const val = gen(value)
    // Track array variables (type-based for gc:true, AST-based for gc:false)
    const isArr = isArrayType(val.type) || isArrayExpr(value)
    if (isArr) {
      ctx.knownArrayVars.add(name)
    }
    // Warn on aliasing
    if (typeof value === 'string' && ctx.knownArrayVars.has(value)) {
      console.warn('jz: [array-alias] ' + `'${name} = ${value}' copies array pointer, not values; mutations affect both`)
    }
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
      ctx.usedMemory = true
      // NaN boxing: mkptr(type, id, offset) - for string, id = length, offset = memOffset
      const memOffset = 65536 + id * 256  // after instance table
      return `(call $__mkptr (i32.const ${PTR_TYPE.STRING}) (i32.const ${length}) (i32.const ${memOffset}))`
    }
    if (val.type === 'f64') {
      // f64 can be number or NaN-encoded pointer
      // NaN != NaN for pointers, number == number for regular floats
      return wat(`(select ${mkStr('number')} ${mkStr('object')} (f64.eq ${val} ${val}))`, 'string')
    }
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
    // parts = [[null, "literal"], expr, [null, "literal2"], ...]
    ctx.usedStringType = true
    ctx.usedMemory = true

    // Check if all parts are compile-time constant strings
    // Note: subscript uses undefined (not null) as the literal marker
    const allConstStrings = parts.every(part =>
      Array.isArray(part) && part[0] === undefined && typeof part[1] === 'string'
    )

    if (allConstStrings) {
      // Concatenate at compile time
      const fullString = parts.map(p => p[1]).join('')
      return mkString(ctx, fullString)
    }

    // Dynamic template - need runtime concatenation
    // Step 1: Collect all string parts and their lengths
    const id = ctx.loopCounter++
    const result = `$_tpl_result_${id}`
    const totalLen = `$_tpl_len_${id}`
    const offset = `$_tpl_off_${id}`
    ctx.addLocal(result.slice(1), 'string')
    ctx.addLocal(totalLen.slice(1), 'i32')
    ctx.addLocal(offset.slice(1), 'i32')

    // Generate code to calculate total length and generate string values
    let lenCalc = '(i32.const 0)'
    const genParts = []
    for (const part of parts) {
      // Literal check: [undefined, "string"] (subscript parser uses undefined, not null)
      if (Array.isArray(part) && part[0] === undefined && typeof part[1] === 'string') {
        // String literal - add its length
        lenCalc = `(i32.add ${lenCalc} (i32.const ${part[1].length}))`
        genParts.push({ type: 'literal', value: part[1] })
      } else {
        // Expression - generate it and get length
        const partId = ctx.loopCounter++
        const partLocal = `$_tpl_part_${partId}`
        ctx.addLocal(partLocal.slice(1), 'f64')  // Could be string or number
        genParts.push({ type: 'expr', local: partLocal, ast: part })
      }
    }

    // Build the concatenation code
    let code = `(local.set ${totalLen} ${lenCalc})\n`

    // Evaluate expressions and accumulate their lengths
    for (const part of genParts) {
      if (part.type === 'expr') {
        const val = gen(part.ast)
        if (isString(val)) {
          code += `(local.set ${part.local} ${val})\n`
          code += `(local.set ${totalLen} (i32.add (local.get ${totalLen}) (call $__ptr_len (local.get ${part.local}))))\n`
        } else {
          // Non-string interpolation - for now just skip (will be 0 chars)
          // TODO: implement number-to-string conversion
          code += `(local.set ${part.local} (f64.const 0))\n`
        }
      }
    }

    // Allocate result string
    code += `(local.set ${result} (call $__alloc (i32.const ${PTR_TYPE.STRING}) (local.get ${totalLen})))\n`
    code += `(local.set ${offset} (i32.const 0))\n`

    // Copy each part into result
    for (const part of genParts) {
      if (part.type === 'literal') {
        // Copy literal string (interned) to result at offset
        // internString returns {id, offset, length} where memory location is id * 256
        const { id: stringId } = ctx.internString(part.value)
        const partLen = part.value.length
        if (partLen > 0) {
          code += `(memory.copy
            (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (local.get ${offset}) (i32.const 1)))
            (i32.const ${stringId * 256})
            (i32.const ${partLen * 2}))\n`
          code += `(local.set ${offset} (i32.add (local.get ${offset}) (i32.const ${partLen})))\n`
        }
      } else {
        // Copy expression result (if string) to result at offset
        code += `(if (call $__is_pointer (local.get ${part.local}))
          (then
            (memory.copy
              (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (local.get ${offset}) (i32.const 1)))
              (call $__ptr_offset (local.get ${part.local}))
              (i32.shl (call $__ptr_len (local.get ${part.local})) (i32.const 1)))
            (local.set ${offset} (i32.add (local.get ${offset}) (call $__ptr_len (local.get ${part.local}))))))\n`
      }
    }

    code += `(local.get ${result})`
    return wat(`(block (result f64) ${code})`, 'string')
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
    // export (params) => body  - register as 'main' with parameters
    if (Array.isArray(decl) && decl[0] === '=>') {
      const [, params, body] = decl
      const fnParams = extractParams(params)
      const fnParamInfo = extractParamInfo(params)
      // Analyze for captures (exclude namespace variables - they're compile-time only)
      const localNames = Object.keys(ctx.locals)
      const analysis = analyzeScope(body, new Set(fnParams), true)
      const captured = [...analysis.free].filter(v =>
        localNames.includes(v) && !fnParams.includes(v) && !ctx.namespaces[v]
      )

      // Helper to get variable type and schema for captured var
      const getVarType = (v) => {
        const loc = ctx.getLocal(v)
        if (loc) return loc.type
        return 'f64'
      }
      const getVarSchema = (v) => {
        const loc = ctx.getLocal(v)
        if (loc) return ctx.localSchemas[loc.scopedName]
        return undefined
      }

      if (captured.length > 0) {
        // Has captures - register as closure with env (not added to table, just receives env)
        const envId = ctx.closureCounter++
        const envType = `$env${envId}`
        const envFields = captured.map((v, i) => ({ name: v, index: i, type: getVarType(v), schema: getVarSchema(v) }))
        ctx.functions['main'] = {
          params: fnParams,
          paramInfo: fnParamInfo,
          body,
          exported: true,
          closure: { envType, envFields, captured, usesOwnEnv: false }
        }
      } else {
        // No captures - simple exported function
        ctx.functions['main'] = { params: fnParams, paramInfo: fnParamInfo, body, exported: true }
      }
      return wat('(f64.const 0)', 'f64')
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
  // Arrow function assigned to object property: obj.fn = (x) => x * 2
  if (Array.isArray(value) && value[0] === '=>' && Array.isArray(target) && target[0] === '.' && target.length === 3) {
    const [, objAst, prop] = target
    const o = gen(objAst)
    if (!isObject(o) || !hasSchema(o)) {
      throw new Error(`Cannot assign property on non-object`)
    }
    const schema = ctx.objectSchemas[o.schema]
    const idx = schema.indexOf(prop)
    if (idx < 0) {
      throw new Error(`Property '${prop}' not found in object schema`)
    }
    ctx.usedMemory = true

    // Generate closure value using the '=>' operator logic
    const closureVal = gen(value)

    // Track as closure property
    if (!ctx.objectPropTypes) ctx.objectPropTypes = {}
    if (!ctx.objectPropTypes[o.schema]) ctx.objectPropTypes[o.schema] = {}
    ctx.objectPropTypes[o.schema][prop] = 'closure'

    const code = objSet(String(o), idx, String(closureVal))
    return returnValue ? wat(`(block (result f64) ${code} ${closureVal})`, 'f64') : code + '\n    '
  }

  // Function/closure definition to named variable
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
    // Exclude namespace variables - they're compile-time only, no runtime capture needed
    const captured = [...analysis.free].filter(v =>
      outerDefined.has(v) && !params.includes(v) && !ctx.namespaces[v]
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
    ctx.usedMemory = true
    const id = ctx.loopCounter++
    const tmp = `$_destruct_${id}`
    ctx.addLocal(tmp.slice(1), 'array')
    const aw = gen(value)
    let code = `(local.set ${tmp} ${aw})\n    `
    for (let i = 0; i < vars.length; i++) {
      if (typeof vars[i] === 'string') {
        ctx.addLocal(vars[i], 'f64')
        code += `(local.set $${vars[i]} (f64.load (i32.add (call $__ptr_offset (local.get ${tmp})) (i32.const ${i * 8}))))\n    `
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
    ctx.usedMemory = true
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
        code += `(local.set $${varName} (f64.load (i32.add (call $__ptr_offset (local.get ${tmp})) (i32.const ${idx * 8}))))\n    `
        lastVar = varName
      }
    }
    return returnValue && lastVar
      ? wat(code + `(local.get $${lastVar})`, 'f64')
      : returnValue ? wat(code + '(f64.const 0)', 'f64') : code
  }

  // Object property assignment: obj.prop = x
  if (Array.isArray(target) && target[0] === '.' && target.length === 3) {
    const [, objAst, prop] = target
    const o = gen(objAst)
    if (!isObject(o) || !hasSchema(o)) {
      throw new Error(`Cannot assign property on non-object`)
    }
    const schema = ctx.objectSchemas[o.schema]
    const idx = schema.indexOf(prop)
    if (idx < 0) {
      throw new Error(`Property '${prop}' not found in object schema`)
    }
    ctx.usedMemory = true
    const vw = f64(gen(value))
    // Track closure type if assigning a function
    if (Array.isArray(value) && value[0] === '=>') {
      if (!ctx.objectPropTypes) ctx.objectPropTypes = {}
      if (!ctx.objectPropTypes[o.schema]) ctx.objectPropTypes[o.schema] = {}
      ctx.objectPropTypes[o.schema][prop] = 'closure'
    }
    const code = objSet(String(o), idx, vw)
    return returnValue ? wat(`(block (result f64) ${code} ${vw})`, 'f64') : code + '\n    '
  }

  // Array element assignment: arr[i] = x
  if (Array.isArray(target) && target[0] === '[]' && target.length === 3) {
    const aw = gen(target[1]), iw = i32(gen(target[2])), vw = f64(gen(value))
    ctx.usedMemory = true

    // TypedArray element assignment
    if (isTypedArray(aw)) {
      const elemType = aw.schema
      const code = typedArrSet(elemType, String(aw), iw, vw)
      return returnValue ? wat(`${code} ${vw}`, 'f64') : code + '\n    '
    }

    ctx.usedArrayType = true
    const code = `(f64.store (i32.add (call $__ptr_offset ${aw}) (i32.shl ${iw} (i32.const 3))) ${vw})`
    return returnValue ? wat(`${code} ${vw}`, 'f64') : code + '\n    '
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

  // Static namespace: let ns = { fn1: (x) => ..., fn2: (a,b) => ... }
  // All properties must be arrow functions without captures for namespace optimization
  if (typeof target === 'string' && Array.isArray(value) && value[0] === '{') {
    const props = value.slice(1)  // [['name', valueAst], ...]
    const isNamespace = props.length > 0 && props.every(([key, val]) =>
      Array.isArray(val) && val[0] === '=>'
    )
    if (isNamespace) {
      // Check for captures - if any function has captures, can't use namespace optimization
      const localNames = Object.keys(ctx.locals)
      let hasCaptures = false
      for (const [key, [, params, body]] of props) {
        const fnParams = extractParams(params)
        const analysis = analyzeScope(body, new Set(fnParams), true)
        const captured = [...analysis.free].filter(v => localNames.includes(v) && !fnParams.includes(v))
        if (captured.length > 0) {
          hasCaptures = true
          break
        }
      }
      if (!hasCaptures) {
        // Register as static namespace - direct function calls, no memory
        ctx.namespaces[target] = {}
        for (const [key, [, params, body]] of props) {
          const fnParams = extractParams(params)
          const fnParamInfo = extractParamInfo(params)
          const funcName = `${target}_${key}`
          ctx.namespaces[target][key] = { params: fnParams, body, funcName }
          ctx.functions[funcName] = { params: fnParams, paramInfo: fnParamInfo, body, exported: false }
        }
        // Variable holds nothing meaningful - just a marker
        ctx.addLocal(target, 'namespace')
        return returnValue ? wat('(f64.const 0)', 'f64') : ''
      }
    }
  }

  // Simple variable
  if (typeof target !== 'string') throw new Error('Invalid assignment target')
  const val = gen(value)

  // Check if this is a hoisted variable (must be written to own env)
  if (ctx.hoistedVars && target in ctx.hoistedVars) {
    const { index, type } = ctx.hoistedVars[target]
    const setCode = envSet('$__ownenv', index, f64(val))
    const getCode = envGet('$__ownenv', index)
    return returnValue
      ? wat(`(block (result f64) ${setCode} ${getCode})`, type)
      : setCode + '\n    '
  }

  // Check if this is a captured variable (must be written to received env)
  if (ctx.capturedVars && target in ctx.capturedVars) {
    const { index, type } = ctx.capturedVars[target]
    const setCode = envSet('$__env', index, f64(val))
    const getCode = envGet('$__env', index)
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
    // Coerce value to match variable's declared type
    let coercedVal = val
    if (existing.type === 'f64' && val.type === 'i32') {
      coercedVal = wat(`(f64.convert_i32_s ${val})`, 'f64')
    }
    // Note: i32 truncation case removed - type promotion should handle it
    return returnValue
      ? wat(`(local.tee $${existing.scopedName} ${coercedVal})`, existing.type, existing.schema || val.schema)
      : `(local.set $${existing.scopedName} ${coercedVal})\n    `
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
 * @example genLoopInit('i', [null, 0]) → '(local.set $i (i32.const 0))\n    '
 */
function genLoopInit(target, value) {
  if (typeof target !== 'string') throw new Error('Loop init must assign to variable')
  const v = gen(value)
  const glob = ctx.getGlobal(target)
  if (glob) {
    // Globals are f64
    return `(global.set $${target} ${f64(v)})\n    `
  }
  const loc = ctx.getLocal(target)
  if (loc) {
    // Respect existing local type
    const locType = loc.type
    const val = locType === 'i32' ? (isI32(v) ? v : i32(v)) : f64(v)
    return `(local.set $${loc.scopedName} ${val})\n    `
  }
  // New local - use value's type
  ctx.addLocal(target, v.type)
  const newLoc = ctx.getLocal(target)
  return `(local.set $${newLoc.scopedName} ${v})\n    `
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
  newCtx.staticArrays = parentCtx.staticArrays  // Share static arrays for data segments
  newCtx.strings = parentCtx.strings  // Share string interning
  newCtx.stringData = parentCtx.stringData  // Share string data
  newCtx.stringOffset = parentCtx.stringOffset  // Share string offset counter
  newCtx.objectSchemas = parentCtx.objectSchemas  // Share object schemas for method calls
  newCtx.objectPropTypes = parentCtx.objectPropTypes  // Share property types for closure detection
  newCtx.namespaces = parentCtx.namespaces  // Share namespaces for direct method calls
  newCtx.inFunction = true
  newCtx.returnLabel = '$return_' + name
  // Enable multi-value return detection for exported functions (not closures)
  newCtx.allowMultiReturn = exported && !closureInfo
  // Analyze for type promotion within this function body
  newCtx.f64Vars = findF64Vars(bodyAst)

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
      newCtx.capturedVars[field.name] = { index: field.index, type: field.type || 'f64', schema: field.schema }
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
  }

  const prevCtx = setCtx(newCtx)

  // Add env parameter for closures (memory-based)
  if (closureInfo) {
    envParam = `(param $__env f64) `
    ctx.locals.__env = { idx: ctx.localCounter++, type: 'f64' }
  }

  // Initialize own env if needed (memory-based)
  if (ctx.ownEnvType) {
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
        // Default to f64 for params (safe for JS interop - undefined→NaN detectable)
        // TODO: Future - infer i32 from usage analysis or type annotations
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

  // Generate destructuring unpacking code (memory-based)
  for (const di of destructParams) {
    if (di.destruct === 'array') {
      // Array destructuring: extract elements by index
      ctx.usedMemory = true
      di.names.forEach((name, idx) => {
        paramInit += `(local.set $${name} (f64.load (i32.add (call $__ptr_offset (local.get $${di.name})) (i32.const ${idx * 8}))))\n      `
      })
    } else if (di.destruct === 'object') {
      // Object destructuring: extract by index (assumes property order matches)
      ctx.usedMemory = true
      di.names.forEach((name, idx) => {
        paramInit += `(local.set $${name} (f64.load (i32.add (call $__ptr_offset (local.get $${di.name})) (i32.const ${idx * 8}))))\n      `
      })
    }
  }

  // Pre-detect multi-value return for exported non-closure functions
  if (ctx.allowMultiReturn) {
    const multiCount = detectMultiReturn(bodyAst)
    if (multiCount) ctx.multiReturnCount = multiCount
  }

  // Generate body - handle implicit multi-value return (direct array literal body)
  let bodyResult
  if (ctx.multiReturnCount && isFixedArrayLiteral(bodyAst) === ctx.multiReturnCount) {
    // Direct array body: () => [a, b, c] - generate multi-value directly
    const elems = bodyAst.slice(1).map(e => f64(gen(e))).join(' ')
    bodyResult = wat(elems, 'multi')
  } else {
    bodyResult = gen(bodyAst)
  }

  // Determine return type: multi-value, i32, or f64
  // Use pre-analyzed return types if available (enables i32 function returns)
  const multiCount = ctx.multiReturnCount
  let returnType, bodyWat
  if (multiCount) {
    returnType = Array(multiCount).fill('f64').join(' ')
    bodyWat = bodyResult.toString()
  } else {
    // Check if this function was analyzed as returning i32
    const analyzedType = parentCtx.funcReturnTypes?.get(name)
    if (analyzedType === 'i32' && !closureInfo) {
      returnType = 'i32'
      bodyWat = isI32(bodyResult) ? bodyResult.toString() : i32(bodyResult)
    } else {
      returnType = 'f64'
      bodyWat = f64(bodyResult)
    }
  }

  // Generate param declarations (all f64 for JS interop)
  const paramDecls = params.map(p => `(param $${p} f64)`).join(' ')
  const localDecls = ctx.localDecls.length ? `\n    ${ctx.localDecls.join(' ')}` : ''

  // Track export signature for JS wrapper generation
  // JS wrapper in instantiate() uses this to know which params are arrays
  if (exported && !closureInfo) {
    const arrayParams = []
    for (let i = 0; i < params.length; i++) {
      const p = params[i]
      if (restParam && p === restParam.name) {
        arrayParams.push(i)
      } else if (destructParams.find(di => di.name === p)) {
        arrayParams.push(i)
      } else if (ctx.inferredArrayParams.has(p)) {
        // Param was used with array methods (e.g., arr.map())
        arrayParams.push(i)
      }
    }
    const returnsArray = bodyResult.type === 'array' || bodyResult.type === 'refarray' || ctx.returnsArrayPointer
    // Track multi-value return count for JS interop (WebAssembly.Function returns array)
    if (arrayParams.length > 0 || returnsArray || multiCount) {
      parentCtx.exportSignatures[name] = { arrayParams, returnsArray, multiReturn: multiCount || 0 }
    }
  }

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
