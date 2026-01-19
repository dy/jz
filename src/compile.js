// AST to WAT compilation
import { CONSTANTS, FUNCTIONS, DEPS } from './stdlib.js'
import { arrayMethods, stringMethods } from './methods/index.js'

// Shared compilation state - accessible by all compiler modules
// Pointer types for gc:false NaN-boxing mode
// Types 1-7 are pointers (quiet bit clear, bit 51=0)
// Types 8-15 reserved for canonical quiet NaN (bit 51=1)
// Layout: f64 NaN pattern with mantissa [type:4][length:28][offset:20]
export const PTR_TYPE = {
  // Type 0 unused (signaling NaN pattern, rare)
  F64_ARRAY: 1,   // Float64Array
  I32_ARRAY: 2,   // Int32Array
  STRING: 3,      // UTF-16 string
  I8_ARRAY: 4,    // Int8Array
  OBJECT: 5,      // Object
  REF_ARRAY: 6,   // Mixed-type array
  CLOSURE: 7      // Closure environment
}
export const PTR_ELEM_SIZE = { 1: 8, 2: 4, 3: 2, 4: 1, 5: 8, 6: 8, 7: 8 }

// Current compilation context - set by compile()
export let ctx = null
export let opts = { gc: true }

// Typed value constructor
export const tv = (t, wat, schema) => [t, wat, schema]

// Number formatting for WAT
export const fmtNum = n =>
  Object.is(n, -0) ? '-0' :
  Number.isNaN(n) ? 'nan' :
  n === Infinity ? 'inf' :
  n === -Infinity ? '-inf' :
  String(n)

// Type coercions
export const asF64 = ([t, w]) =>
  t === 'f64' || t === 'array' || t === 'string' ? [t, w] :
  t === 'ref' || t === 'object' ? ['f64', '(f64.const 0)'] :
  ['f64', `(f64.convert_i32_s ${w})`]

export const asI32 = ([t, w]) =>
  t === 'i32' ? [t, w] :
  t === 'ref' || t === 'object' ? ['i32', '(i32.const 0)'] :
  ['i32', `(i32.trunc_f64_s ${w})`]

export const truthy = ([t, w]) =>
  t === 'ref' ? ['i32', `(i32.eqz (ref.is_null ${w}))`] :
  t === 'i32' ? ['i32', `(i32.ne ${w} (i32.const 0))`] :
  ['i32', `(f64.ne ${w} (f64.const 0))`]

export const conciliate = (a, b) =>
  a[0] === 'i32' && b[0] === 'i32' ? [a, b] : [asF64(a), asF64(b)]

// AST generator - set by compile() after _gen is defined
export let gen = null

// Initialize state for a new compilation
export function initState(context, options, generator) {
  ctx = context
  opts = options
  gen = generator
}

// Set context only (for nested function generation)
export function setCtx(context) {
  const prev = ctx
  ctx = context
  return prev
}

// Helper to extract params from arrow function AST
export function extractParams(params) {
  if (!params) return []
  if (typeof params === 'string') return [params]
  if (Array.isArray(params)) {
    if (params[0] === '()' && params.length === 2) return extractParams(params[1])
    if (params[0] === ',') return params.slice(1).flatMap(extractParams)
    return params.flatMap(extractParams)
  }
  return []
}

// WAT binary ops generators
const binOp = (resType, argType, op) => (a, b) => {
  const [, wa] = argType === 'f64' ? asF64(a) : asI32(a)
  const [, wb] = argType === 'f64' ? asF64(b) : asI32(b)
  return [resType, `(${op} ${wa} ${wb})`]
}

const f64 = {
  add: binOp('f64', 'f64', 'f64.add'), sub: binOp('f64', 'f64', 'f64.sub'),
  mul: binOp('f64', 'f64', 'f64.mul'), div: binOp('f64', 'f64', 'f64.div'),
  eq: binOp('i32', 'f64', 'f64.eq'), ne: binOp('i32', 'f64', 'f64.ne'),
  lt: binOp('i32', 'f64', 'f64.lt'), le: binOp('i32', 'f64', 'f64.le'),
  gt: binOp('i32', 'f64', 'f64.gt'), ge: binOp('i32', 'f64', 'f64.ge'),
}

const i32 = {
  add: binOp('i32', 'i32', 'i32.add'), sub: binOp('i32', 'i32', 'i32.sub'), mul: binOp('i32', 'i32', 'i32.mul'),
  and: binOp('i32', 'i32', 'i32.and'), or: binOp('i32', 'i32', 'i32.or'), xor: binOp('i32', 'i32', 'i32.xor'),
  eq: binOp('i32', 'i32', 'i32.eq'), ne: binOp('i32', 'i32', 'i32.ne'),
  lt_s: binOp('i32', 'i32', 'i32.lt_s'), le_s: binOp('i32', 'i32', 'i32.le_s'),
  gt_s: binOp('i32', 'i32', 'i32.gt_s'), ge_s: binOp('i32', 'i32', 'i32.ge_s'),
  shl: (a, b) => ['i32', `(i32.shl ${asI32(a)[1]} (i32.and ${asI32(b)[1]} (i32.const 31)))`],
  shr_s: (a, b) => ['i32', `(i32.shr_s ${asI32(a)[1]} (i32.and ${asI32(b)[1]} (i32.const 31)))`],
  shr_u: (a, b) => ['i32', `(i32.shr_u ${asI32(a)[1]} (i32.and ${asI32(b)[1]} (i32.const 31)))`],
}

// Native WASM ops for Math
const MATH_OPS = {
  f64_unary: { sqrt: 'f64.sqrt', abs: 'f64.abs', floor: 'f64.floor', ceil: 'f64.ceil', trunc: 'f64.trunc', round: 'f64.nearest' },
  i32_unary: { clz32: 'i32.clz' },
  f64_binary: { min: 'f64.min', max: 'f64.max' },
  stdlib_unary: ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'exp', 'expm1', 'log', 'log2', 'log10', 'log1p', 'cbrt', 'sign', 'fround'],
  stdlib_binary: ['pow', 'atan2', 'hypot', 'imul'],
  constants: { PI: Math.PI, E: Math.E, SQRT2: Math.SQRT2, SQRT1_2: Math.SQRT1_2, LN2: Math.LN2, LN10: Math.LN10, LOG2E: Math.LOG2E, LOG10E: Math.LOG10E },
}
const GLOBAL_CONSTANTS = { Infinity: Infinity, NaN: NaN }

// Closure analysis - find free variables in an AST
// Returns { free: Set<string>, defined: Set<string>, innerFunctions: [...] }
function analyzeScope(ast, outerDefined = new Set(), inFunction = false) {
  const defined = new Set(outerDefined)
  const free = new Set()
  const innerFunctions = []

  function walk(node, inFunc = inFunction) {
    if (node == null) return
    if (typeof node === 'string') {
      // Identifier reference
      if (!defined.has(node) && !node.startsWith('_') &&
          !(node in GLOBAL_CONSTANTS) && !(node in MATH_OPS.constants) &&
          !['t', 'true', 'false', 'null', 'undefined'].includes(node)) {
        free.add(node)
      }
      return
    }
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === undefined) return // Literal like [undefined, 5]
    if (op === null) return // Special literal like NaN

    // Variable declarations define new names
    if (op === '=' && typeof args[0] === 'string') {
      // Check if RHS is a function (closure)
      if (Array.isArray(args[1]) && args[1][0] === '=>') {
        const fnParams = extractParams(args[1][1])
        const fnBody = args[1][2]
        // Analyze inner function with ONLY its own params as defined
        // This way, uses of outer variables will be marked as 'free'
        const analysis = analyzeScope(fnBody, new Set(fnParams), true)
        // Captured = free vars that are defined in outer scope
        const captured = [...analysis.free].filter(v => defined.has(v) || outerDefined.has(v))
        innerFunctions.push({
          name: args[0],
          params: fnParams,
          body: fnBody,
          captured,
          innerFunctions: analysis.innerFunctions
        })
        defined.add(args[0])
        return
      }
      walk(args[1], inFunc)
      defined.add(args[0])
      return
    }
    if (op === 'let' || op === 'const' || op === 'var') {
      if (Array.isArray(args[0]) && args[0][0] === '=') {
        walk(args[0][1], inFunc)
        defined.add(args[0][0])
      } else if (typeof args[0] === 'string') {
        defined.add(args[0])
      }
      return
    }
    if (op === 'function') {
      const [name, params, body] = args
      const fnParams = extractParams(params)
      // Analyze inner function with ONLY its own params as defined
      const analysis = analyzeScope(body, new Set(fnParams), true)
      const captured = [...analysis.free].filter(v => defined.has(v) || outerDefined.has(v))
      innerFunctions.push({ name, params: fnParams, body, captured, innerFunctions: analysis.innerFunctions })
      defined.add(name)
      return
    }
    if (op === '=>') {
      // Anonymous arrow - analyzed when assigned
      const fnParams = extractParams(args[0])
      // Analyze with only params as defined
      const analysis = analyzeScope(args[1], new Set(fnParams), true)
      // Pass through free vars that come from outer scopes
      for (const v of analysis.free) {
        if (!fnParams.includes(v)) free.add(v)
      }
      return
    }
    // Loop variables
    if (op === 'for') {
      const [init, cond, update, body] = args
      if (Array.isArray(init) && (init[0] === 'let' || init[0] === 'const' || init[0] === 'var')) {
        if (Array.isArray(init[1]) && init[1][0] === '=') {
          walk(init[1][1], inFunc)
          defined.add(init[1][0])
        }
      } else {
        walk(init, inFunc)
      }
      walk(cond, inFunc)
      walk(update, inFunc)
      walk(body, inFunc)
      return
    }
    // Recurse into all children
    for (const arg of args) walk(arg, inFunc)
  }

  walk(ast)
  return { free, defined, innerFunctions }
}

// Find all variables in a function that are captured by ANY nested closure
// These need to be stored in an environment struct for shared access
function findHoistedVars(bodyAst, params) {
  const analysis = analyzeScope(bodyAst, new Set(params), true)
  const hoisted = new Set()
  
  function collectCaptured(innerFunctions) {
    for (const fn of innerFunctions) {
      for (const v of fn.captured) hoisted.add(v)
      if (fn.innerFunctions) collectCaptured(fn.innerFunctions)
    }
  }
  collectCaptured(analysis.innerFunctions)
  return hoisted
}

const createContext = () => ({
  locals: {}, localDecls: [], globals: {},
  usedStdlib: [], usedArrayType: false, usedStringType: false, usedRefArrayType: false, usedMemory: false,
  localCounter: 0, loopCounter: 0, functions: {}, inFunction: false,
  strings: {}, stringData: [], stringCounter: 0, internedStringGlobals: {},
  staticArrays: {}, arrayDataOffset: 0,
  objectCounter: 0, objectSchemas: {}, localSchemas: {},
  // Memory allocation tracking for gc:false mode
  staticAllocs: [], staticOffset: 0,
  // Scope tracking for let/const block scoping
  scopeDepth: 0, scopes: [{}], constVars: {},
  // Closure tracking
  closures: {},          // name -> { envType, envFields, captured }
  closureEnvTypes: [],   // Struct type definitions for GC mode
  closureCounter: 0,     // Unique ID for closure types
  currentEnv: null,      // Current closure environment (if inside a closure)
  capturedVars: {},      // Map of captured var name -> field index in env

  // Add a local variable (for internal compiler temps and declared vars)
  // If scopedName is provided, use it directly; otherwise apply scoping rules
  addLocal(name, type = 'f64', schema, scopedName = null) {
    // Use provided scoped name, or compute it
    const finalName = scopedName || name
    if (!(finalName in this.locals)) {
      this.locals[finalName] = { idx: this.localCounter++, type, originalName: name }
      // In gc:false mode, arrays/objects are f64 (encoded pointers)
      const wasmType = opts.gc
        ? (type === 'array' || type === 'ref' || type === 'object' ? '(ref null $f64array)' : type === 'string' ? '(ref null $string)' : type)
        : (type === 'array' || type === 'ref' || type === 'object' || type === 'string' ? 'f64' : type)
      this.localDecls.push(`(local $${finalName} ${wasmType})`)
    }
    if (schema !== undefined) this.localSchemas[finalName] = schema
    return { ...this.locals[finalName], scopedName: finalName }
  },
  getLocal(name) {
    // Internal variables don't have scope
    if (name.startsWith('_')) {
      return name in this.locals ? { ...this.locals[name], scopedName: name } : null
    }
    // Search from innermost scope outward
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const scopedName = i > 0 ? `${name}_s${i}` : name
      if (scopedName in this.locals) return { ...this.locals[scopedName], scopedName }
    }
    // Fallback: check unscoped name
    if (name in this.locals) return { ...this.locals[name], scopedName: name }
    return null
  },
  pushScope() {
    this.scopeDepth++
    this.scopes.push({})
  },
  popScope() {
    this.scopes.pop()
    this.scopeDepth--
  },
  declareVar(name, isConst = false) {
    const scopedName = this.scopeDepth > 0 ? `${name}_s${this.scopeDepth}` : name
    this.scopes[this.scopes.length - 1][name] = true
    if (isConst) this.constVars[scopedName] = true
    return scopedName
  },
  addGlobal(name, type = 'f64', init = '(f64.const 0)') {
    if (!(name in this.globals)) this.globals[name] = { type, init }
    return this.globals[name]
  },
  getGlobal(name) { return this.globals[name] },
  internString(str) {
    if (str in this.strings) return this.strings[str]
    const id = this.stringCounter++
    const offset = this.stringData.length / 2
    for (const char of str) {
      const code = char.charCodeAt(0)
      this.stringData.push(code & 0xFF, (code >> 8) & 0xFF)
    }
    const info = { id, offset, length: str.length }
    this.strings[str] = info
    return info
  },
  // Allocate static memory (for gc:false literals)
  allocStatic(size) {
    const offset = this.staticOffset
    this.staticOffset += size
    return offset
  }
})

// Public API
export function compile(ast, options = {}) {
  const newOpts = { gc: true, ...options }
  const newCtx = createContext()
  newCtx.locals.t = { type: 'f64', idx: newCtx.localCounter++ }
  // Initialize shared state for method modules
  initState(newCtx, newOpts, _gen)
  const [, bodyWat] = asF64(_gen(ast))
  return assemble(bodyWat, ctx, generateFunctions())
}

export function assembleRaw(bodyWat) {
  return assemble(bodyWat, {
    usedArrayType: false, usedStringType: false, usedMemory: false, usedStdlib: [],
    localDecls: [], functions: {}, globals: {}, strings: {}, stringData: [],
    staticArrays: {}, arrayDataOffset: 0, closureEnvTypes: []
  })
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

// Core generator
function _gen(ast) {
  if (ast == null) return tv('f64', '(f64.const 0)')
  if (Array.isArray(ast) && ast[0] === undefined) return genLiteral(ast[1])
  if (typeof ast === 'string') return genIdent(ast)
  if (!Array.isArray(ast)) throw new Error(`Invalid AST: ${JSON.stringify(ast)}`)
  const [op, ...args] = ast
  if (op in operators) return operators[op](args)
  throw new Error(`Unknown operator: ${op}`)
}

// Literals
function genLiteral(v) {
  if (v === null || v === undefined) {
    return opts.gc ? tv('ref', '(ref.null none)') : tv('f64', '(f64.const 0)')
  }
  if (typeof v === 'number') return tv('f64', `(f64.const ${fmtNum(v)})`)
  if (typeof v === 'boolean') return tv('i32', `(i32.const ${v ? 1 : 0})`)
  if (typeof v === 'string') {
    ctx.usedStringType = true
    const { id, length } = ctx.internString(v)
    if (opts.gc) {
      // Use interned string global - created once, reused for same string literals
      ctx.internedStringGlobals[id] = { length }
      // Global is (ref null $string), use ref.as_non_null to get (ref $string) for function calls
      return tv('string', `(ref.as_non_null (global.get $__str${id}))`)
    } else {
      // gc:false - string is stored in data segment, return encoded pointer
      // Data segment offset will be resolved at assembly time
      ctx.usedMemory = true
      return tv('string', `(call $__mkptr (i32.const ${PTR_TYPE.STRING}) (i32.const ${length}) (i32.const ${id}))`)
    }
  }
  throw new Error(`Unsupported literal: ${JSON.stringify(v)}`)
}

// Identifiers
function genIdent(name) {
  if (name === 'null' || name === 'undefined') {
    return opts.gc ? tv('ref', '(ref.null none)') : tv('f64', '(f64.const 0)')
  }
  if (name === 'true') return tv('i32', '(i32.const 1)')
  if (name === 'false') return tv('i32', '(i32.const 0)')
  if (name in GLOBAL_CONSTANTS) return tv('f64', `(f64.const ${fmtNum(GLOBAL_CONSTANTS[name])})`)

  // Check if this is a hoisted variable (in our own env, for nested closure access)
  if (ctx.hoistedVars && name in ctx.hoistedVars) {
    const fieldIdx = ctx.hoistedVars[name]
    if (opts.gc) {
      return tv('f64', `(struct.get ${ctx.ownEnvType} ${fieldIdx} (local.get $__ownenv))`)
    } else {
      const offset = fieldIdx * 8
      return tv('f64', `(f64.load (i32.add (call $__ptr_offset (local.get $__ownenv)) (i32.const ${offset})))`)
    }
  }

  // Check if this is a captured variable (from closure environment passed to us)
  if (ctx.capturedVars && name in ctx.capturedVars) {
    const fieldIdx = ctx.capturedVars[name]
    if (opts.gc) {
      return tv('f64', `(struct.get ${ctx.currentEnv} ${fieldIdx} (local.get $__env))`)
    } else {
      const offset = fieldIdx * 8
      return tv('f64', `(f64.load (i32.add (call $__ptr_offset (local.get $__env)) (i32.const ${offset})))`)
    }
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
      if (val[0] === 'string') {
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
    return tv('f64', `(call $${name} ${argWats})`)
  }

  throw new Error(`Unknown function: ${namespace ? namespace + '.' : ''}${name}`)
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
    }
    if (!name) throw new Error(`Invalid call: ${JSON.stringify(fn)}`)
    return resolveCall(namespace, name, args, receiver)
  },

  '['(elements) {
    ctx.usedArrayType = true
    const gens = elements.map(e => gen(e))
    const elementTypes = gens.map(g => g[0])
    const hasNestedTypes = elementTypes.some(t => t === 'array' || t === 'object' || t === 'string')

    if (opts.gc) {
      // gc:true: convert everything to f64 (refs become placeholders)
      const vals = gens.map(g => {
        if (g[0] === 'array' || g[0] === 'string' || g[0] === 'object') {
          return '(f64.const 0)'  // Can't store refs in f64 arrays
        }
        return asF64(g)[1]
      })
      return tv('array', `(array.new_fixed $f64array ${vals.length} ${vals.join(' ')})`)
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
    if (props.length === 0) {
      return opts.gc ? tv('ref', '(ref.null none)') : tv('f64', '(f64.const 0)')
    }
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
      if (a[0] === 'string') {
        ctx.usedStringType = true
        return tv('i32', `(array.get_u $string ${a[1]} ${iw})`)
      }
      ctx.usedArrayType = true
      return tv('f64', `(array.get $f64array ${a[1]} ${iw})`)
    } else {
      // gc:false - load from memory
      ctx.usedMemory = true
      // If the array has a compile-time element schema and the index is a literal,
      // propagate object schema for property access.
      const schema = a[2]
      let litIdx = null
      if (isConstant(idx)) {
        const v = evalConstant(idx)
        // Ensure integer index
        litIdx = Number.isFinite(v) ? (v | 0) : null
      }
      if (Array.isArray(schema) && litIdx !== null) {
        const elem = schema[litIdx]
        if (elem && elem.type === 'object' && elem.id !== undefined) {
          return tv('object', `(f64.load (i32.add (call $__ptr_offset ${a[1]}) (i32.const ${litIdx * 8})))`, elem.id)
        }
      }
      if (a[0] === 'string') {
        return tv('i32', `(i32.load16_u (i32.add (call $__ptr_offset ${a[1]}) (i32.shl ${iw} (i32.const 1))))`)
      }
      return tv('f64', `(f64.load (i32.add (call $__ptr_offset ${a[1]}) (i32.shl ${iw} (i32.const 3))))`)
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
    // For length: gc:true arrays are type 'array', gc:false arrays are type 'f64' (pointers)
    // Strings are type 'string' in gc:true but type 'f64' (pointers) in gc:false
    if (prop === 'length') {
      if (o[0] === 'array' || (o[0] === 'string' && opts.gc)) {
        if (opts.gc) {
          if (o[0] === 'array') ctx.usedArrayType = true
          else ctx.usedStringType = true
          return tv('i32', `(array.len ${o[1]})`)
        }
      } else if (o[0] === 'string' || o[0] === 'f64') {
        // gc:false: either explicit string type or f64 pointer (could be string, array, or object)
        // Try pointer extraction which works for all pointer types
        ctx.usedMemory = true
        return tv('i32', `(call $__ptr_len ${o[1]})`)
      }
      throw new Error(`Cannot get length of ${o[0]}`)
    }
    if (o[0] === 'object' && o[2] !== undefined) {
      const schema = ctx.objectSchemas[o[2]]
      if (schema) {
        const idx = schema.indexOf(prop)
        if (idx >= 0) {
          if (opts.gc) {
            ctx.usedArrayType = true
            return tv('f64', `(array.get $f64array ${o[1]} (i32.const ${idx}))`)
          } else {
            ctx.usedMemory = true
            return tv('f64', `(f64.load (i32.add (call $__ptr_offset ${o[1]}) (i32.const ${idx * 8})))`)
          }
        }
      }
    }
    throw new Error(`Invalid property: .${prop}`)
  },

  '?.'([obj, prop]) {
    const o = gen(obj)
    if (prop === 'length') {
      if (opts.gc) {
        if (o[0] === 'array' || o[0] === 'ref') {
          ctx.usedArrayType = true
          return tv('f64', `(if (result f64) (ref.is_null ${o[1]}) (then (f64.const 0)) (else (f64.convert_i32_s (array.len ${o[1]}))))`)
        }
      } else {
        // gc:false: arrays and strings are f64 pointers
        if (o[0] === 'f64' || o[0] === 'string') {
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
    throw new Error('Arrow functions must be assigned: name = (x) => ...')
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
  '+'([a, b]) { const va = gen(a), vb = gen(b); return va[0] === 'i32' && vb[0] === 'i32' ? i32.add(va, vb) : f64.add(va, vb) },
  '-'([a, b]) { const va = gen(a), vb = gen(b); return va[0] === 'i32' && vb[0] === 'i32' ? i32.sub(va, vb) : f64.sub(va, vb) },
  '*'([a, b]) { const va = gen(a), vb = gen(b); return va[0] === 'i32' && vb[0] === 'i32' ? i32.mul(va, vb) : f64.mul(va, vb) },
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
        if (!opts.gc && val[0] === 'f64') {
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
        } else if (val[0] === 'f64') typeCode = '(i32.const 1)'
        else if (val[0] === 'i32') typeCode = '(i32.const 3)'
        else if (val[0] === 'string') typeCode = '(i32.const 2)'
        else if (val[0] === 'ref') typeCode = '(i32.const 0)'
        else if (val[0] === 'array' || val[0] === 'object') typeCode = '(i32.const 4)'
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
    if (va[0] === 'string' && vb[0] === 'string') {
      if (opts.gc) {
        return tv('i32', `(ref.eq ${va[1]} ${vb[1]})`)
      } else {
        return tv('i32', `(i64.eq (i64.reinterpret_f64 ${va[1]}) (i64.reinterpret_f64 ${vb[1]}))`)
      }
    }
    // Array/object comparison: reference equality
    if ((va[0] === 'array' || va[0] === 'object') && (vb[0] === 'array' || vb[0] === 'object')) {
      if (opts.gc) {
        return tv('i32', `(ref.eq ${va[1]} ${vb[1]})`)
      } else {
        return tv('i32', `(i64.eq (i64.reinterpret_f64 ${va[1]}) (i64.reinterpret_f64 ${vb[1]}))`)
      }
    }
    // gc:false f64 comparison: use i64.eq to handle NaN-boxed pointers correctly
    if (!opts.gc && va[0] === 'f64' && vb[0] === 'f64') {
      return tv('i32', `(i64.eq (i64.reinterpret_f64 ${va[1]}) (i64.reinterpret_f64 ${vb[1]}))`)
    }
    return va[0] === 'i32' && vb[0] === 'i32' ? i32.eq(va, vb) : f64.eq(va, vb)
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
    if (va[0] === 'string' && vb[0] === 'string') {
      if (opts.gc) {
        return tv('i32', `(i32.eqz (ref.eq ${va[1]} ${vb[1]}))`)
      } else {
        return tv('i32', `(i64.ne (i64.reinterpret_f64 ${va[1]}) (i64.reinterpret_f64 ${vb[1]}))`)
      }
    }
    // Array/object comparison: reference inequality
    if ((va[0] === 'array' || va[0] === 'object') && (vb[0] === 'array' || vb[0] === 'object')) {
      if (opts.gc) {
        return tv('i32', `(i32.eqz (ref.eq ${va[1]} ${vb[1]}))`)
      } else {
        return tv('i32', `(i64.ne (i64.reinterpret_f64 ${va[1]}) (i64.reinterpret_f64 ${vb[1]}))`)
      }
    }
    // gc:false f64 comparison: use i64.ne to handle NaN-boxed pointers correctly
    if (!opts.gc && va[0] === 'f64' && vb[0] === 'f64') {
      return tv('i32', `(i64.ne (i64.reinterpret_f64 ${va[1]}) (i64.reinterpret_f64 ${vb[1]}))`)
    }
    return va[0] === 'i32' && vb[0] === 'i32' ? i32.ne(va, vb) : f64.ne(va, vb)
  },
  '!=='([a, b]) { return operators['!=']([a, b]) },
  '<'([a, b]) { const va = gen(a), vb = gen(b); return va[0] === 'i32' && vb[0] === 'i32' ? i32.lt_s(va, vb) : f64.lt(va, vb) },
  '<='([a, b]) { const va = gen(a), vb = gen(b); return va[0] === 'i32' && vb[0] === 'i32' ? i32.le_s(va, vb) : f64.le(va, vb) },
  '>'([a, b]) { const va = gen(a), vb = gen(b); return va[0] === 'i32' && vb[0] === 'i32' ? i32.gt_s(va, vb) : f64.gt(va, vb) },
  '>='([a, b]) { const va = gen(a), vb = gen(b); return va[0] === 'i32' && vb[0] === 'i32' ? i32.ge_s(va, vb) : f64.ge(va, vb) },

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
  '??'([a, b]) { const va = gen(a); return va[0] === 'ref' ? gen(b) : va },

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
      ctx.functions[target] = {
        params,
        body,
        exported: false,
        closure: { envType, envFields, captured, usesOwnEnv: allFromOwnEnv }
      }

      return returnValue ? tv('f64', '(f64.const 0)') : ''
    }

    // Regular function (no captures)
    ctx.functions[target] = { params, body, exported: true }
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
    if (opts.gc) {
      const code = `(struct.set ${ctx.ownEnvType} ${fieldIdx} (local.get $__ownenv) ${asF64(val)[1]})`
      return returnValue 
        ? tv('f64', `(block (result f64) ${code} (struct.get ${ctx.ownEnvType} ${fieldIdx} (local.get $__ownenv)))`)
        : code + '\n    '
    } else {
      const offset = fieldIdx * 8
      const code = `(f64.store (i32.add (call $__ptr_offset (local.get $__ownenv)) (i32.const ${offset})) ${asF64(val)[1]})`
      return returnValue
        ? tv('f64', `(block (result f64) ${code} (f64.load (i32.add (call $__ptr_offset (local.get $__ownenv)) (i32.const ${offset}))))`)
        : code + '\n    '
    }
  }
  
  // Check if this is a captured variable (must be written to received env)
  if (ctx.capturedVars && target in ctx.capturedVars) {
    const fieldIdx = ctx.capturedVars[target]
    if (opts.gc) {
      const code = `(struct.set ${ctx.currentEnv} ${fieldIdx} (local.get $__env) ${asF64(val)[1]})`
      return returnValue 
        ? tv('f64', `(block (result f64) ${code} (struct.get ${ctx.currentEnv} ${fieldIdx} (local.get $__env)))`)
        : code + '\n    '
    } else {
      const offset = fieldIdx * 8
      const code = `(f64.store (i32.add (call $__ptr_offset (local.get $__env)) (i32.const ${offset})) ${asF64(val)[1]})`
      return returnValue
        ? tv('f64', `(block (result f64) ${code} (f64.load (i32.add (call $__ptr_offset (local.get $__env)) (i32.const ${offset}))))`)
        : code + '\n    '
    }
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
  if (closureInfo) {
    if (opts.gc) {
      envParam = `(param $__env (ref ${closureInfo.envType})) `
      ctx.locals.__env = { idx: ctx.localCounter++, type: 'ref' }
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
  const [, bodyWat] = asF64(gen(bodyAst))
  const paramDecls = params.map(p => `(param $${p} f64)`).join(' ')
  const localDecls = ctx.localDecls.length ? `\n    ${ctx.localDecls.join(' ')}` : ''
  // Export only if not a closure
  const exportClause = closureInfo ? '' : ` (export "${name}")`
  // Wrap body in block to support early return
  const wat = `(func $${name}${exportClause} ${envParam}${paramDecls} (result f64)${localDecls}\n    (block ${ctx.returnLabel} (result f64)\n      ${envInit}${bodyWat}\n    )\n  )`
  
  // Propagate usedMemory to parent context
  if (ctx.usedMemory) parentCtx.usedMemory = true
  
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

// Module assembly
function assemble(bodyWat, ctx, extraFunctions = []) {
  let wat = '(module\n'

  // GC types (only in gc:true mode)
  if (opts.gc) {
    if (ctx.usedArrayType) wat += '  (type $f64array (array (mut f64)))\n'
    if (ctx.usedStringType) wat += '  (type $string (array (mut i16)))\n'
    if (ctx.usedRefArrayType) wat += '  (type $refarray (array (mut (ref null $f64array))))\n'
    // Closure environment types
    for (const env of ctx.closureEnvTypes) {
      const fields = env.fields.map(f => `(field $${f} (mut f64))`).join(' ')
      wat += `  (type $env${env.id} (struct ${fields}))\n`
    }
  }

  // Memory (required for gc:false mode)
  if (ctx.usedMemory || !opts.gc) {
    wat += '  (memory (export "memory") 1)\n'
    // Heap pointer global - starts after static data
    const heapStart = ctx.staticOffset || 1024  // Reserve 1KB for static data by default
    wat += `  (global $__heap (mut i32) (i32.const ${heapStart}))\n`
  }

  // String data segments
  for (const str in ctx.strings) {
    const info = ctx.strings[str]
    const startByte = info.offset * 2, endByte = startByte + info.length * 2
    const hex = ctx.stringData.slice(startByte, endByte).map(b => '\\' + b.toString(16).padStart(2, '0')).join('')
    if (opts.gc) {
      wat += `  (data $str${info.id} "${hex}")\n`
    } else {
      // gc:false - strings go into memory at fixed offsets
      const memOffset = info.id * 256  // Simple: each string gets 256 bytes max
      wat += `  (data (i32.const ${memOffset}) "${hex}")\n`
    }
  }

  // Static array data segments (gc:false mode)
  const staticArrayKeys = Object.keys(ctx.staticArrays)
  if (!opts.gc && staticArrayKeys.length > 0) {
    for (const key of staticArrayKeys) {
      const {offset, values} = ctx.staticArrays[key]
      // Encode f64 values as 8 bytes each (little-endian IEEE 754)
      let hex = ''
      for (const val of values) {
        const f64bytes = new Float64Array([val])
        const bytes = new Uint8Array(f64bytes.buffer)
        hex += Array.from(bytes).map(b => '\\' + b.toString(16).padStart(2, '0')).join('')
      }
      if (hex) wat += `  (data (i32.const ${offset}) "${hex}")\n`
    }
  }

  // Memory helper functions for gc:false mode
  if (ctx.usedMemory && !opts.gc) {
    wat += `
  ;; NaN-boxing pointer encoding
  ;; IEEE 754 f64: [sign:1][exponent:11][mantissa:52]
  ;; NaN pattern: exponent=0x7FF, mantissa=[type:4][length:28][offset:20]
  ;; Canonical quiet NaN (0x7FF8...) has bit 51 set (type field bits 51-48 = 8+)
  ;; We use types 1-7 for pointers (bit 51 clear), type 0 is also pointer-able
  ;; Types 8-15 (bit 51 set) are reserved for quiet NaN numbers
  ;; This allows typeof NaN === "number" to work correctly

  ;; Allocate memory and return NaN-encoded pointer
  (func $__alloc (param $type i32) (param $len i32) (result f64)
    (local $offset i32) (local $size i32)
    ;; Calculate size based on type: 1=f64(8), 2=i32(4), 3=i16(2), 4=i8(1), 5=object(8), 6=refarray(8)
    (local.set $size
      (i32.shl (local.get $len)
        (select (i32.const 3)
          (select (i32.const 2)
            (select (i32.const 1) (i32.const 0) (i32.eq (local.get $type) (i32.const 3)))
            (i32.eq (local.get $type) (i32.const 2)))
          (i32.or (i32.eq (local.get $type) (i32.const 1)) (i32.ge_u (local.get $type) (i32.const 5))))))
    ;; 8-byte align
    (local.set $size (i32.and (i32.add (local.get $size) (i32.const 7)) (i32.const -8)))
    (local.set $offset (global.get $__heap))
    (global.set $__heap (i32.add (global.get $__heap) (local.get $size)))
    (call $__mkptr (local.get $type) (local.get $len) (local.get $offset)))

  ;; Create NaN-encoded pointer
  (func $__mkptr (param $type i32) (param $len i32) (param $offset i32) (result f64)
    (f64.reinterpret_i64
      (i64.or
        (i64.const 0x7FF0000000000000)  ;; NaN exponent
        (i64.or
          (i64.or
            (i64.shl (i64.extend_i32_u (i32.and (local.get $type) (i32.const 0x0F))) (i64.const 48))
            (i64.shl (i64.extend_i32_u (i32.and (local.get $len) (i32.const 0x0FFFFFFF))) (i64.const 20)))
          (i64.extend_i32_u (i32.and (local.get $offset) (i32.const 0x0FFFFF)))))))

  ;; Check if f64 is a pointer (NaN with type < 8, i.e., quiet bit clear)
  ;; Canonical NaN has type=8+ (quiet bit set), pointers use types 1-7
  (func $__is_pointer (param $val f64) (result i32)
    (i32.and
      (i32.eq  ;; Is NaN?
        (i32.and (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $val)) (i64.const 52))) (i32.const 0x7FF))
        (i32.const 0x7FF))
      (i32.lt_u (call $__ptr_type (local.get $val)) (i32.const 8))))  ;; type < 8?

  ;; Extract offset from pointer (bits 0-19)
  (func $__ptr_offset (param $ptr f64) (result i32)
    (i32.and (i32.wrap_i64 (i64.reinterpret_f64 (local.get $ptr))) (i32.const 0x0FFFFF)))

  ;; Extract length from pointer (bits 20-47)
  (func $__ptr_len (param $ptr f64) (result i32)
    (i32.and (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $ptr)) (i64.const 20))) (i32.const 0x0FFFFFFF)))

  ;; Extract type from pointer (bits 48-51)
  (func $__ptr_type (param $ptr f64) (result i32)
    (i32.and (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $ptr)) (i64.const 48))) (i32.const 0x0F)))
`
  }

  const included = {}
  function include(name) {
    if (name in included) return
    included[name] = true
    for (const dep of DEPS[name] || []) include(dep)
    if (FUNCTIONS[name]) wat += `  ${FUNCTIONS[name]}\n`
  }
  if (ctx.usedStdlib.length > 0) {
    wat += CONSTANTS
    for (const name of ctx.usedStdlib) include(name)
  }

  // Interned string globals (gc:true mode only)
  // Declare with null, initialize in main function start
  if (opts.gc) {
    for (const id in ctx.internedStringGlobals) {
      wat += `  (global $__str${id} (mut (ref null $string)) (ref.null $string))\n`
    }
  }

  for (const name in ctx.globals) wat += `  (global $${name} (mut f64) ${ctx.globals[name].init})\n`

  wat += `  (func $die (result f64) (unreachable))\n`
  wat += `  (func $f64.rem (param f64 f64) (result f64)\n    (f64.sub (local.get 0) (f64.mul (f64.trunc (f64.div (local.get 0) (local.get 1))) (local.get 1))))\n`

  for (const fn of extraFunctions) wat += `  ${fn}\n`

  const hasMainBody = bodyWat && bodyWat.trim() && bodyWat.trim() !== '(f64.const 0)'
  if (hasMainBody || extraFunctions.length === 0) {
    const locals = ctx.localDecls.length ? `\n    ${ctx.localDecls.join(' ')}` : ''
    // Initialize interned strings at start of main (gc:true mode)
    let strInit = ''
    if (opts.gc) {
      for (const id in ctx.internedStringGlobals) {
        const { length } = ctx.internedStringGlobals[id]
        strInit += `(if (ref.is_null (global.get $__str${id})) (then (global.set $__str${id} (array.new_data $string $str${id} (i32.const 0) (i32.const ${length})))))\n    `
      }
    }
    wat += `\n  (func $main (export "main") (param $t f64) (result f64)${locals}\n    ${strInit}${bodyWat}\n  )`
  }

  return wat + '\n)'
}
