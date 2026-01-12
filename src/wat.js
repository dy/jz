// AST to WAT compilation
// Combines: type helpers, code generation, module assembly
import { CONSTANTS, FUNCTIONS, DEPS } from './stdlib.js'

// --- Typed value: { t: type, wat: string } ---
const tv = (t, wat) => ({ t, wat })

// --- Type coercions ---
const asF64 = v =>
  v.t === 'f64' ? v :
  v.t === 'ref' ? tv('f64', '(f64.const 0)') :
  tv('f64', `(f64.convert_i32_s ${v.wat})`)

const asI32 = v =>
  v.t === 'i32' ? v :
  v.t === 'ref' ? tv('i32', '(i32.const 0)') :
  tv('i32', `(i32.trunc_f64_s ${v.wat})`)

const truthy = v =>
  v.t === 'ref' ? tv('i32', `(i32.eqz (ref.is_null ${v.wat}))`) :
  v.t === 'i32' ? tv('i32', `(i32.ne ${v.wat} (i32.const 0))`) :
  tv('i32', `(f64.ne ${v.wat} (f64.const 0))`)

const conciliate = (a, b) =>
  a.t === 'i32' && b.t === 'i32' ? [a, b] : [asF64(a), asF64(b)]

// --- Number formatting ---
const fmtNum = n => {
  if (Object.is(n, -0)) return '-0'
  if (Number.isNaN(n)) return 'nan'
  if (n === Infinity) return 'inf'
  if (n === -Infinity) return '-inf'
  return String(n)
}

// --- WAT instruction builders ---
const f64 = {
  add: (a, b) => tv('f64', `(f64.add ${asF64(a).wat} ${asF64(b).wat})`),
  sub: (a, b) => tv('f64', `(f64.sub ${asF64(a).wat} ${asF64(b).wat})`),
  mul: (a, b) => tv('f64', `(f64.mul ${asF64(a).wat} ${asF64(b).wat})`),
  div: (a, b) => tv('f64', `(f64.div ${asF64(a).wat} ${asF64(b).wat})`),
  eq: (a, b) => tv('i32', `(f64.eq ${asF64(a).wat} ${asF64(b).wat})`),
  ne: (a, b) => tv('i32', `(f64.ne ${asF64(a).wat} ${asF64(b).wat})`),
  lt: (a, b) => tv('i32', `(f64.lt ${asF64(a).wat} ${asF64(b).wat})`),
  le: (a, b) => tv('i32', `(f64.le ${asF64(a).wat} ${asF64(b).wat})`),
  gt: (a, b) => tv('i32', `(f64.gt ${asF64(a).wat} ${asF64(b).wat})`),
  ge: (a, b) => tv('i32', `(f64.ge ${asF64(a).wat} ${asF64(b).wat})`),
}

const i32 = {
  add: (a, b) => tv('i32', `(i32.add ${asI32(a).wat} ${asI32(b).wat})`),
  sub: (a, b) => tv('i32', `(i32.sub ${asI32(a).wat} ${asI32(b).wat})`),
  mul: (a, b) => tv('i32', `(i32.mul ${asI32(a).wat} ${asI32(b).wat})`),
  and: (a, b) => tv('i32', `(i32.and ${asI32(a).wat} ${asI32(b).wat})`),
  or: (a, b) => tv('i32', `(i32.or ${asI32(a).wat} ${asI32(b).wat})`),
  xor: (a, b) => tv('i32', `(i32.xor ${asI32(a).wat} ${asI32(b).wat})`),
  shl: (a, b) => tv('i32', `(i32.shl ${asI32(a).wat} (i32.and ${asI32(b).wat} (i32.const 31)))`),
  shr_s: (a, b) => tv('i32', `(i32.shr_s ${asI32(a).wat} (i32.and ${asI32(b).wat} (i32.const 31)))`),
  shr_u: (a, b) => tv('i32', `(i32.shr_u ${asI32(a).wat} (i32.and ${asI32(b).wat} (i32.const 31)))`),
  eq: (a, b) => tv('i32', `(i32.eq ${asI32(a).wat} ${asI32(b).wat})`),
  ne: (a, b) => tv('i32', `(i32.ne ${asI32(a).wat} ${asI32(b).wat})`),
  lt_s: (a, b) => tv('i32', `(i32.lt_s ${asI32(a).wat} ${asI32(b).wat})`),
  le_s: (a, b) => tv('i32', `(i32.le_s ${asI32(a).wat} ${asI32(b).wat})`),
  gt_s: (a, b) => tv('i32', `(i32.gt_s ${asI32(a).wat} ${asI32(b).wat})`),
  ge_s: (a, b) => tv('i32', `(i32.ge_s ${asI32(a).wat} ${asI32(b).wat})`),
}

// --- Native WASM operations mapped to JS Math/Number ---
// All functions MUST be accessed via namespace (Math.sqrt, not sqrt)
// This ensures JZ code is pure JS that runs in any JS interpreter

// Math methods with native WASM ops
const MATH_F64_UNARY = {
  sqrt: 'f64.sqrt', abs: 'f64.abs', floor: 'f64.floor',
  ceil: 'f64.ceil', trunc: 'f64.trunc', round: 'f64.nearest',
}
const MATH_I32_UNARY = { clz32: 'i32.clz' }
const MATH_F64_BINARY = { min: 'f64.min', max: 'f64.max' }

// Math methods implemented in stdlib
const STDLIB_MATH_UNARY = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'exp', 'expm1', 'log', 'log2', 'log10', 'log1p', 'cbrt', 'sign', 'fround']
const STDLIB_MATH_BINARY = ['pow', 'atan2', 'hypot', 'imul']

// Math constants (accessed via Math.PI, Math.E, etc.)
const MATH_CONSTANTS = {
  PI: Math.PI, E: Math.E,
  SQRT2: Math.SQRT2, SQRT1_2: Math.SQRT1_2,
  LN2: Math.LN2, LN10: Math.LN10, LOG2E: Math.LOG2E, LOG10E: Math.LOG10E,
}

// Number methods
const STDLIB_NUMBER_UNARY = ['isInteger']

// Global constants (Infinity, NaN are standard JS globals)
const GLOBAL_CONSTANTS = { Infinity: Infinity, NaN: NaN }

// --- Codegen context ---
let ctx = null

function createContext() {
  return {
    locals: new Map(),
    localDecls: [],
    globals: new Map(),
    usedStdlib: new Set(),
    usedArrayType: false,
    usedNullRef: false,
    usedStringType: false,
    localCounter: 0,
    loopCounter: 0,
    structTypes: new Map(),
    structCounter: 0,
    functions: new Map(),
    inFunction: false,
    // String interning
    strings: new Map(),  // string content -> { id, offset, length }
    stringData: [],      // accumulated string data bytes (UTF-16 LE)
    stringCounter: 0,

    addLocal(name, type = 'f64') {
      if (!this.locals.has(name)) {
        this.locals.set(name, { idx: this.localCounter++, type })
        let wasmType = type
        if (type === 'array' || type === 'ref') wasmType = '(ref null $f64array)'
        else if (type === 'string') wasmType = '(ref null $string)'
        else if (type.startsWith('struct:')) wasmType = `(ref null $${type.slice(7)})`
        this.localDecls.push(`(local $${name} ${wasmType})`)
      }
      return this.locals.get(name)
    },

    getLocal(name) { return this.locals.get(name) },

    addGlobal(name, type = 'f64', init = '(f64.const 0)') {
      if (!this.globals.has(name)) this.globals.set(name, { type, init })
      return this.globals.get(name)
    },

    getGlobal(name) { return this.globals.get(name) },

    getStructType(fields) {
      const sorted = [...fields].sort()
      const key = sorted.join(',')
      if (!this.structTypes.has(key)) {
        this.structTypes.set(key, { fields: sorted, typeName: `struct${this.structCounter++}` })
      }
      return this.structTypes.get(key)
    },

    // Intern a string literal, return its id
    internString(str) {
      if (this.strings.has(str)) return this.strings.get(str)
      const id = this.stringCounter++
      const offset = this.stringData.length / 2  // offset in i16 units
      // Store as UTF-16 LE bytes
      for (const char of str) {
        const code = char.charCodeAt(0)
        this.stringData.push(code & 0xFF)        // low byte
        this.stringData.push((code >> 8) & 0xFF) // high byte
      }
      const info = { id, offset, length: str.length }
      this.strings.set(str, info)
      return info
    }
  }
}

// --- Public API ---
export function compile(ast) {
  ctx = createContext()
  // Register 't' as the implicit main function parameter
  ctx.locals.set('t', { type: 'f64', idx: ctx.locals.size })
  const bodyWat = asF64(gen(ast)).wat
  return assemble(bodyWat, ctx, generateFunctions())
}

export function compileExpression(ast) {
  ctx = createContext()
  return asF64(gen(ast)).wat
}

export function getContext() { return ctx }

// --- Core generator ---
function gen(ast) {
  if (Array.isArray(ast) && ast[0] === undefined) return genLiteral(ast[1])
  if (typeof ast === 'string') return genIdent(ast)
  if (!Array.isArray(ast)) throw new Error(`Invalid AST: ${JSON.stringify(ast)}`)
  const [op, ...args] = ast
  if (op in operators) return operators[op](args)
  throw new Error(`Unknown operator: ${op}`)
}

// --- Literals ---
function genLiteral(v) {
  if (v === null || v === undefined) {
    ctx.usedNullRef = true
    return tv('ref', '(ref.null none)')
  }
  if (typeof v === 'number') return tv('f64', `(f64.const ${fmtNum(v)})`)
  if (typeof v === 'boolean') return tv('i32', `(i32.const ${v ? 1 : 0})`)
  if (typeof v === 'string') {
    ctx.usedStringType = true
    const { id, offset, length } = ctx.internString(v)
    // Use array.new_data to reference the interned string
    return tv('string', `(array.new_data $string $str${id} (i32.const 0) (i32.const ${length}))`)
  }
  throw new Error(`Unsupported literal: ${JSON.stringify(v)}`)
}

// --- Identifiers ---
function genIdent(name) {
  // Handle null/undefined as identifiers (standard JS)
  if (name === 'null' || name === 'undefined') {
    ctx.usedNullRef = true
    return tv('ref', '(ref.null none)')
  }
  // Standard JS global constants
  if (name in GLOBAL_CONSTANTS) return tv('f64', `(f64.const ${fmtNum(GLOBAL_CONSTANTS[name])})`)
  // User-defined locals
  const loc = ctx.getLocal(name)
  if (loc) return tv(loc.type, `(local.get $${name})`)
  // User-defined globals
  const glob = ctx.getGlobal(name)
  if (glob) return tv(glob.type, `(global.get $${name})`)
  throw new Error(`Unknown identifier: ${name}`)
}

// --- Function call resolution ---
// PURE JS: Only namespaced calls (Math.sin, Number.isNaN) or user-defined functions
function resolveCall(namespace, name, args, receiver = null) {
  // Method calls on objects (receiver.method(args))
  if (receiver !== null) {
    // String methods
    if (receiver.t === 'string') {
      // charCodeAt(index) - get UTF-16 code unit
      if (name === 'charCodeAt' && args.length === 1) {
        ctx.usedStringType = true
        const idx = asI32(gen(args[0]))
        return tv('i32', `(array.get_u $string ${receiver.wat} ${idx.wat})`)
      }
      throw new Error(`Unknown string method: .${name}`)
    }
    // Array methods
    if (receiver.t === 'array') {
      // fill(value) - fill array with value, returns the array
      if (name === 'fill' && args.length >= 1) {
        ctx.usedArrayType = true
        ctx.usedStdlib.add('arrayFill')
        const val = asF64(gen(args[0]))
        return tv('array', `(call $arrayFill ${receiver.wat} ${val.wat})`)
      }
      // map(fn) - transform array with callback
      if (name === 'map' && args.length === 1) {
        const callback = args[0]
        // Callback must be an arrow function: x => expr
        if (!Array.isArray(callback) || callback[0] !== '=>') {
          throw new Error('Array.map requires an arrow function callback')
        }
        const [, params, body] = callback
        // Extract parameter name
        let paramName
        if (typeof params === 'string') {
          paramName = params
        } else if (Array.isArray(params) && params.length === 1 && typeof params[0] === 'string') {
          paramName = params[0]
        } else {
          throw new Error('Array.map callback must have exactly one parameter')
        }
        ctx.usedArrayType = true
        // Generate unique local names
        const arrLocal = `$_map_arr_${ctx.locals.size}`
        const lenLocal = `$_map_len_${ctx.locals.size + 1}`
        const idxLocal = `$_map_idx_${ctx.locals.size + 2}`
        const resultLocal = `$_map_result_${ctx.locals.size + 3}`

        // Add locals
        ctx.localDecls.push(`(local ${arrLocal} (ref $f64array))`)
        ctx.localDecls.push(`(local ${lenLocal} i32)`)
        ctx.localDecls.push(`(local ${idxLocal} i32)`)
        ctx.localDecls.push(`(local ${resultLocal} (ref $f64array))`)
        ctx.addLocal(paramName, 'f64')  // callback param

        // Generate callback body with param bound
        const savedLocals = new Map(ctx.locals)
        ctx.locals.set(paramName, { type: 'f64', idx: ctx.locals.size })
        const bodyResult = asF64(gen(body))
        ctx.locals = savedLocals
        ctx.locals.set(paramName, { type: 'f64', idx: ctx.locals.size })

        return tv('array', `
          (local.set ${arrLocal} ${receiver.wat})
          (local.set ${lenLocal} (array.len (local.get ${arrLocal})))
          (local.set ${resultLocal} (array.new $f64array (f64.const 0) (local.get ${lenLocal})))
          (local.set ${idxLocal} (i32.const 0))
          (block $_map_done
            (loop $_map_loop
              (br_if $_map_done (i32.ge_s (local.get ${idxLocal}) (local.get ${lenLocal})))
              (local.set $${paramName} (array.get $f64array (local.get ${arrLocal}) (local.get ${idxLocal})))
              (array.set $f64array (local.get ${resultLocal}) (local.get ${idxLocal}) ${bodyResult.wat})
              (local.set ${idxLocal} (i32.add (local.get ${idxLocal}) (i32.const 1)))
              (br $_map_loop)))
          (local.get ${resultLocal})`)
      }
      // reduce(fn, init) - aggregate array with callback
      if (name === 'reduce' && args.length === 2) {
        const callback = args[0]
        const initVal = gen(args[1])
        // Callback must be arrow function: (acc, curr) => expr
        if (!Array.isArray(callback) || callback[0] !== '=>') {
          throw new Error('Array.reduce requires an arrow function callback')
        }
        const [, params, body] = callback
        // Extract parameter names - params is [",", "a", "b"] or [paramsWrapper]
        let accName, currName
        if (Array.isArray(params) && params[0] === ',') {
          // [",", "a", "b"]
          accName = params[1]
          currName = params[2]
        } else if (Array.isArray(params) && params.length === 2 && typeof params[0] === 'string' && typeof params[1] === 'string') {
          accName = params[0]
          currName = params[1]
        } else {
          throw new Error('Array.reduce callback must have exactly two parameters (acc, curr)')
        }
        ctx.usedArrayType = true

        // Generate unique local names
        const arrLocal = `$_reduce_arr_${ctx.locals.size}`
        const lenLocal = `$_reduce_len_${ctx.locals.size + 1}`
        const idxLocal = `$_reduce_idx_${ctx.locals.size + 2}`

        // Add locals
        ctx.localDecls.push(`(local ${arrLocal} (ref $f64array))`)
        ctx.localDecls.push(`(local ${lenLocal} i32)`)
        ctx.localDecls.push(`(local ${idxLocal} i32)`)
        ctx.addLocal(accName, 'f64')
        ctx.addLocal(currName, 'f64')

        // Generate callback body with params bound
        const savedLocals = new Map(ctx.locals)
        ctx.locals.set(accName, { type: 'f64', idx: ctx.locals.size })
        ctx.locals.set(currName, { type: 'f64', idx: ctx.locals.size + 1 })
        const bodyResult = asF64(gen(body))
        ctx.locals = savedLocals
        ctx.locals.set(accName, { type: 'f64', idx: ctx.locals.size })
        ctx.locals.set(currName, { type: 'f64', idx: ctx.locals.size + 1 })

        return tv('f64', `
          (local.set ${arrLocal} ${receiver.wat})
          (local.set ${lenLocal} (array.len (local.get ${arrLocal})))
          (local.set $${accName} ${asF64(initVal).wat})
          (local.set ${idxLocal} (i32.const 0))
          (block $_reduce_done
            (loop $_reduce_loop
              (br_if $_reduce_done (i32.ge_s (local.get ${idxLocal}) (local.get ${lenLocal})))
              (local.set $${currName} (array.get $f64array (local.get ${arrLocal}) (local.get ${idxLocal})))
              (local.set $${accName} ${bodyResult.wat})
              (local.set ${idxLocal} (i32.add (local.get ${idxLocal}) (i32.const 1)))
              (br $_reduce_loop)))
          (local.get $${accName})`)
      }
      throw new Error(`Unknown array method: .${name}`)
    }
    throw new Error(`Method calls not supported on type: ${receiver.t}`)
  }

  // Math namespace (standard JS)
  if (namespace === 'Math') {
    // Native WASM f64 unary (Math.sqrt, Math.abs, Math.floor, etc.)
    if (name in MATH_F64_UNARY && args.length === 1)
      return tv('f64', `(${MATH_F64_UNARY[name]} ${asF64(gen(args[0])).wat})`)
    // Native WASM i32 unary (Math.clz32)
    if (name in MATH_I32_UNARY && args.length === 1)
      return tv('i32', `(${MATH_I32_UNARY[name]} ${asI32(gen(args[0])).wat})`)
    // Native WASM f64 binary (Math.min, Math.max)
    if (name in MATH_F64_BINARY && args.length === 2)
      return tv('f64', `(${MATH_F64_BINARY[name]} ${asF64(gen(args[0])).wat} ${asF64(gen(args[1])).wat})`)
    // Variadic min/max
    if (name in MATH_F64_BINARY && args.length > 2) {
      let result = asF64(gen(args[0])).wat
      for (let i = 1; i < args.length; i++)
        result = `(${MATH_F64_BINARY[name]} ${result} ${asF64(gen(args[i])).wat})`
      return tv('f64', result)
    }
    // Math stdlib (sin, cos, tan, pow, etc.)
    if (STDLIB_MATH_UNARY.includes(name) && args.length === 1) {
      ctx.usedStdlib.add(name)
      return tv('f64', `(call $${name} ${asF64(gen(args[0])).wat})`)
    }
    if (STDLIB_MATH_BINARY.includes(name) && args.length === 2) {
      ctx.usedStdlib.add(name)
      return tv('f64', `(call $${name} ${asF64(gen(args[0])).wat} ${asF64(gen(args[1])).wat})`)
    }
    // Math.random
    if (name === 'random' && args.length === 0) {
      ctx.usedStdlib.add('random')
      return tv('f64', '(call $random)')
    }
    throw new Error(`Unknown Math method: Math.${name}`)
  }

  // Number namespace (standard JS)
  if (namespace === 'Number') {
    // Number.isNaN
    if (name === 'isNaN' && args.length === 1) {
      const v = asF64(gen(args[0])).wat
      return tv('i32', `(f64.ne ${v} ${v})`)
    }
    // Number.isFinite
    if (name === 'isFinite' && args.length === 1) {
      const v = asF64(gen(args[0])).wat
      return tv('i32', `(i32.and (f64.eq ${v} ${v}) (f64.ne (f64.abs ${v}) (f64.const inf)))`)
    }
    // Number.isInteger
    if (name === 'isInteger' && args.length === 1) {
      ctx.usedStdlib.add('isInteger')
      return tv('i32', `(i32.trunc_f64_s (call $isInteger ${asF64(gen(args[0])).wat}))`)
    }
    throw new Error(`Unknown Number method: Number.${name}`)
  }

  // Global isNaN/isFinite (standard JS globals)
  if (namespace === null && (name === 'isNaN' || name === 'isFinite')) {
    return resolveCall('Number', name, args)
  }

  // Global parseInt(string, radix) - standard JS
  if (namespace === null && name === 'parseInt' && args.length >= 1) {
    const strArg = gen(args[0])
    const radixArg = args.length >= 2 ? asI32(gen(args[1])).wat : '(i32.const 10)'
    // String must be string type, returns f64 (for consistency with JZ)
    if (strArg.t === 'string') {
      ctx.usedStdlib.add('parseInt')
      return tv('f64', `(call $parseInt ${strArg.wat} ${radixArg})`)
    }
    // If it's a number, treat it as already parsed (common in floatbeat where char codes are used)
    if (strArg.t === 'f64' || strArg.t === 'i32') {
      ctx.usedStdlib.add('parseIntFromCode')
      return tv('f64', `(call $parseIntFromCode ${asI32(strArg).wat} ${radixArg})`)
    }
    throw new Error('parseInt expects string or number argument')
  }

  // Array constructor: Array(n) - creates array of n elements (uninitialized)
  if (namespace === null && name === 'Array' && args.length === 1) {
    ctx.usedArrayType = true
    const size = asI32(gen(args[0]))
    // Create array with default value 0
    return tv('array', `(array.new $f64array (f64.const 0) ${size.wat})`)
  }

  // User-defined function
  if (namespace === null && ctx.functions.has(name)) {
    const fn = ctx.functions.get(name)
    if (args.length !== fn.params.length)
      throw new Error(`${name} expects ${fn.params.length} args, got ${args.length}`)
    const argWats = args.map(a => asF64(gen(a)).wat).join(' ')
    return tv('f64', `(call $${name} ${argWats})`)
  }

  throw new Error(`Unknown function: ${namespace ? namespace + '.' : ''}${name}`)
}

// --- Operators ---
const operators = {
  // Function call
  '()'([fn, ...args]) {
    let name = null, namespace = null, receiver = null

    // Parse function reference
    if (typeof fn === 'string') {
      // Bare function call: parseInt(), myFunc()
      name = fn
    } else if (Array.isArray(fn) && fn[0] === '.') {
      // Dot expression
      const [, obj, method] = fn
      if (typeof obj === 'string' && typeof method === 'string') {
        // Namespaced call: Math.sin, Number.isFinite
        namespace = obj
        name = method
      } else if (typeof method === 'string') {
        // Method call: obj.method(args), "str".charCodeAt(0)
        receiver = gen(obj)
        name = method
      }
    }
    if (!name) throw new Error(`Invalid call: ${JSON.stringify(fn)}`)

    // Resolve the function
    return resolveCall(namespace, name, args, receiver)
  },

  // Array literal
  '['(elements) {
    ctx.usedArrayType = true
    const vals = elements.map(e => asF64(gen(e)).wat)
    return tv('array', `(array.new_fixed $f64array ${vals.length} ${vals.join(' ')})`)
  },

  // Object literal
  '{'(props) {
    if (props.length === 0) {
      ctx.usedNullRef = true
      return tv('ref', '(ref.null none)')
    }
    const fields = props.map(p => p[0])
    const st = ctx.getStructType(fields)
    const valueMap = new Map(props.map(([k, v]) => [k, asF64(gen(v)).wat]))
    const vals = st.fields.map(f => valueMap.get(f))
    return tv(`struct:${st.typeName}`, `(struct.new $${st.typeName} ${vals.join(' ')})`)
  },

  // Array/string index
  '[]'([arr, idx]) {
    const isOptional = Array.isArray(arr) && arr[0] === '?.'
    if (isOptional) {
      const a = gen(arr[1]), i = asI32(gen(idx))
      ctx.usedNullRef = true
      if (a.t === 'string') {
        ctx.usedStringType = true
        return tv('i32', `(if (result i32) (ref.is_null ${a.wat}) (then (i32.const 0)) (else (array.get_u $string ${a.wat} ${i.wat})))`)
      }
      ctx.usedArrayType = true
      return tv('f64', `(if (result f64) (ref.is_null ${a.wat}) (then (f64.const 0)) (else (array.get $f64array ${a.wat} ${i.wat})))`)
    }
    const a = gen(arr), i = asI32(gen(idx))
    if (a.t === 'string') {
      ctx.usedStringType = true
      return tv('i32', `(array.get_u $string ${a.wat} ${i.wat})`)
    }
    ctx.usedArrayType = true
    return tv('f64', `(array.get $f64array ${a.wat} ${i.wat})`)
  },

  // Property access
  '.'([obj, prop]) {
    // Handle Math.PI, Math.E, etc. (standard JS)
    if (obj === 'Math' && prop in MATH_CONSTANTS) {
      return tv('f64', `(f64.const ${fmtNum(MATH_CONSTANTS[prop])})`)
    }

    const o = gen(obj)
    if (prop === 'length' && (o.t === 'array' || o.t === 'string')) {
      if (o.t === 'array') ctx.usedArrayType = true
      else ctx.usedStringType = true
      return tv('i32', `(array.len ${o.wat})`)
    }
    if (o.t.startsWith('struct:')) {
      const typeName = o.t.slice(7)
      for (const [, st] of ctx.structTypes) {
        if (st.typeName === typeName) {
          const idx = st.fields.indexOf(prop)
          if (idx === -1) throw new Error(`Unknown property: ${prop}`)
          return tv('f64', `(struct.get $${typeName} ${idx} ${o.wat})`)
        }
      }
    }
    throw new Error(`Invalid property access: .${prop}`)
  },

  // Optional chaining
  '?.'([obj, prop]) {
    const o = gen(obj)
    if (o.t === 'array' || o.t === 'ref') {
      ctx.usedNullRef = true
      if (prop === 'length') {
        ctx.usedArrayType = true
        return tv('f64', `(if (result f64) (ref.is_null ${o.wat}) (then (f64.const 0)) (else (f64.convert_i32_s (array.len ${o.wat}))))`)
      }
      return o
    }
    return o
  },

  // Comma (sequence)
  ','(args) {
    let code = ''
    for (let i = 0; i < args.length - 1; i++) {
      const arg = args[i]
      if (Array.isArray(arg) && arg[0] === '=') {
        code += genAssignmentSideEffect(arg[1], arg[2])
      } else {
        code += `(drop ${gen(arg).wat})\n    `
      }
    }
    const last = gen(args[args.length - 1])
    return tv(last.t, code + last.wat)
  },

  // Ternary
  '?'([cond, then, els]) {
    const c = truthy(gen(cond))
    const [t, e] = conciliate(gen(then), gen(els))
    return tv(t.t, `(if (result ${t.t}) ${c.wat} (then ${t.wat}) (else ${e.wat}))`)
  },

  // Assignment
  '='([target, value]) {
    // Function definition: name = (params) => body
    if (Array.isArray(value) && value[0] === '=>') {
      const [, rawParams, body] = value
      const name = typeof target === 'string' ? target : null
      if (!name) throw new Error('Function must be assigned to a variable')
      const params = extractParams(rawParams)
      ctx.functions.set(name, { params, body, exported: true })
      return tv('f64', `(f64.const 0)`)
    }
    // Array destructuring
    if (Array.isArray(target) && target[0] === '[' && target.length > 1 && typeof target[1] === 'string')
      return genArrayDestructure(target.slice(1), value)
    // Object destructuring
    if (Array.isArray(target) && target[0] === '{' && target.length > 1) {
      const isDestr = target.slice(1).every(p => typeof p === 'string' || (Array.isArray(p) && typeof p[0] === 'string'))
      if (isDestr) return genObjectDestructure(target.slice(1).map(p => typeof p === 'string' ? p : p[0]), value)
    }
    // Array element
    if (Array.isArray(target) && target[0] === '[]') {
      const arr = gen(target[1]), idx = asI32(gen(target[2])), val = asF64(gen(value))
      ctx.usedArrayType = true
      return tv('f64', `(array.set $f64array ${arr.wat} ${idx.wat} ${val.wat}) ${val.wat}`)
    }
    // Simple variable
    if (typeof target !== 'string') throw new Error('Invalid assignment target')
    const val = gen(value)
    // Check if already exists as global
    const glob = ctx.getGlobal(target)
    if (glob) {
      return tv(val.t, `(global.set $${target} ${asF64(val).wat}) (global.get $${target})`)
    }
    ctx.addLocal(target, val.t)
    return tv(val.t, `(local.tee $${target} ${val.wat})`)
  },

  // Arrow function (standalone)
  '=>'([rawParams, body]) {
    throw new Error('Arrow functions must be assigned to a variable: name = (a) => ...')
  },

  // Unary
  'u+'([a]) { return asF64(gen(a)) },
  'u-'([a]) {
    const v = gen(a)
    return v.t === 'i32' ? tv('i32', `(i32.sub (i32.const 0) ${v.wat})`) : tv('f64', `(f64.neg ${asF64(v).wat})`)
  },
  '!'([a]) { return tv('i32', `(i32.eqz ${truthy(gen(a)).wat})`) },
  '~'([a]) { return tv('i32', `(i32.xor ${asI32(gen(a)).wat} (i32.const -1))`) },

  // Arithmetic
  '+'([a, b]) { const va = gen(a), vb = gen(b); return va.t === 'i32' && vb.t === 'i32' ? i32.add(va, vb) : f64.add(va, vb) },
  '-'([a, b]) { const va = gen(a), vb = gen(b); return va.t === 'i32' && vb.t === 'i32' ? i32.sub(va, vb) : f64.sub(va, vb) },
  '*'([a, b]) { const va = gen(a), vb = gen(b); return va.t === 'i32' && vb.t === 'i32' ? i32.mul(va, vb) : f64.mul(va, vb) },
  '/'([a, b]) { return f64.div(gen(a), gen(b)) },
  '%'([a, b]) { return tv('f64', `(call $f64.rem ${asF64(gen(a)).wat} ${asF64(gen(b)).wat})`) },
  '**'([a, b]) { ctx.usedStdlib.add('pow'); return tv('f64', `(call $pow ${asF64(gen(a)).wat} ${asF64(gen(b)).wat})`) },

  // Comparisons
  '=='([a, b]) { const va = gen(a), vb = gen(b); return va.t === 'i32' && vb.t === 'i32' ? i32.eq(va, vb) : f64.eq(va, vb) },
  '==='([a, b]) { return operators['==']([a, b]) },
  '!='([a, b]) { const va = gen(a), vb = gen(b); return va.t === 'i32' && vb.t === 'i32' ? i32.ne(va, vb) : f64.ne(va, vb) },
  '!=='([a, b]) { return operators['!=']([a, b]) },
  '<'([a, b]) { const va = gen(a), vb = gen(b); return va.t === 'i32' && vb.t === 'i32' ? i32.lt_s(va, vb) : f64.lt(va, vb) },
  '<='([a, b]) { const va = gen(a), vb = gen(b); return va.t === 'i32' && vb.t === 'i32' ? i32.le_s(va, vb) : f64.le(va, vb) },
  '>'([a, b]) { const va = gen(a), vb = gen(b); return va.t === 'i32' && vb.t === 'i32' ? i32.gt_s(va, vb) : f64.gt(va, vb) },
  '>='([a, b]) { const va = gen(a), vb = gen(b); return va.t === 'i32' && vb.t === 'i32' ? i32.ge_s(va, vb) : f64.ge(va, vb) },

  // Bitwise
  '&'([a, b]) { return i32.and(gen(a), gen(b)) },
  '|'([a, b]) { return i32.or(gen(a), gen(b)) },
  '^'([a, b]) { return i32.xor(gen(a), gen(b)) },
  '<<'([a, b]) { return i32.shl(gen(a), gen(b)) },
  '>>'([a, b]) { return i32.shr_s(gen(a), gen(b)) },
  '>>>'([a, b]) { return i32.shr_u(gen(a), gen(b)) },

  // Logical
  '&&'([a, b]) {
    const va = gen(a), vb = gen(b), cond = truthy(va)
    const [ca, cb] = conciliate(va, vb)
    return tv(ca.t, `(if (result ${ca.t}) ${cond.wat} (then ${cb.wat}) (else (${ca.t}.const 0)))`)
  },
  '||'([a, b]) {
    const va = gen(a), vb = gen(b), cond = truthy(va)
    const [ca, cb] = conciliate(va, vb)
    return tv(ca.t, `(if (result ${ca.t}) ${cond.wat} (then ${ca.wat}) (else ${cb.wat}))`)
  },
  '??'([a, b]) {
    const va = gen(a)
    return va.t === 'ref' ? gen(b) : va
  },

  // For loop: for (init; cond; step) body
  // Returns: last value from body (or 0 if never executed)
  'for'([init, cond, step, body]) {
    // Setup: execute init (must emit runtime code even for "globals")
    let code = ''
    if (init) {
      if (Array.isArray(init) && init[0] === '=') {
        code += genLoopInit(init[1], init[2])
      } else {
        code += `(drop ${gen(init).wat})\n    `
      }
    }

    // Create unique labels and result local
    const loopId = ctx.loopCounter++
    const breakLabel = `$break_${loopId}`
    const continueLabel = `$continue_${loopId}`
    const resultLocal = `$_for_result_${loopId}`
    ctx.addLocal(resultLocal.slice(1), 'f64')

    // Build loop
    code += `(block ${breakLabel} (loop ${continueLabel}\n      `

    // Condition check (if provided)
    if (cond) {
      code += `(br_if ${breakLabel} (i32.eqz ${truthy(gen(cond)).wat}))\n      `
    }

    // Body - store result
    const bodyVal = gen(body)
    code += `(local.set ${resultLocal} ${asF64(bodyVal).wat})\n      `

    // Step (if provided)
    if (step) {
      if (Array.isArray(step) && (step[0] === '=' || step[0] === '+=' || step[0] === '-=' || step[0] === '*=' || step[0] === '/=' || step[0] === '%=')) {
        // Compound/simple assignment - use side effect generator
        const origOp = step[0]
        if (origOp === '=') {
          code += genAssignmentSideEffect(step[1], step[2])
        } else {
          // Convert += to = and +
          const baseOp = origOp.slice(0, -1)
          code += genAssignmentSideEffect(step[1], [baseOp, step[1], step[2]])
        }
      } else {
        code += `(drop ${gen(step).wat})\n      `
      }
    }

    // Continue loop
    code += `(br ${continueLabel})\n    ))\n    `

    // Return result
    code += `(local.get ${resultLocal})`

    return tv('f64', code)
  },

  // While loop: while (cond) body
  'while'([cond, body]) {
    // Create unique labels and result local
    const loopId = ctx.loopCounter++
    const breakLabel = `$break_${loopId}`
    const continueLabel = `$continue_${loopId}`
    const resultLocal = `$_while_result_${loopId}`
    ctx.addLocal(resultLocal.slice(1), 'f64')

    let code = `(block ${breakLabel} (loop ${continueLabel}\n      `

    // Condition check
    code += `(br_if ${breakLabel} (i32.eqz ${truthy(gen(cond)).wat}))\n      `

    // Body - store result
    const bodyVal = gen(body)
    code += `(local.set ${resultLocal} ${asF64(bodyVal).wat})\n      `

    // Continue loop
    code += `(br ${continueLabel})\n    ))\n    `

    // Return result
    code += `(local.get ${resultLocal})`

    return tv('f64', code)
  },

  // Block: { statements }
  '{}'([body]) {
    // Single statement
    if (!Array.isArray(body) || body[0] !== ';') {
      return gen(body)
    }
    // Statement sequence
    let code = ''
    const stmts = body.slice(1)
    for (let i = 0; i < stmts.length - 1; i++) {
      const stmt = stmts[i]
      if (Array.isArray(stmt) && stmt[0] === '=') {
        code += genAssignmentSideEffect(stmt[1], stmt[2])
      } else {
        code += `(drop ${gen(stmt).wat})\n    `
      }
    }
    const last = gen(stmts[stmts.length - 1])
    return tv(last.t, code + last.wat)
  },

  // Statement sequence (semicolon)
  ';'(stmts) {
    let code = ''
    for (let i = 0; i < stmts.length - 1; i++) {
      const stmt = stmts[i]
      if (Array.isArray(stmt) && stmt[0] === '=') {
        code += genAssignmentSideEffect(stmt[1], stmt[2])
      } else if (stmt !== null) {
        code += `(drop ${gen(stmt).wat})\n    `
      }
    }
    const last = stmts[stmts.length - 1]
    if (last === null) return tv('f64', code + '(f64.const 0)')
    const lastVal = gen(last)
    return tv(lastVal.t, code + lastVal.wat)
  },

  // Compound assignment
  '+='([a, b]) { return operators['=']([a, ['+', a, b]]) },
  '-='([a, b]) { return operators['=']([a, ['-', a, b]]) },
  '*='([a, b]) { return operators['=']([a, ['*', a, b]]) },
  '/='([a, b]) { return operators['=']([a, ['/', a, b]]) },
  '%='([a, b]) { return operators['=']([a, ['%', a, b]]) },
  '&='([a, b]) { return operators['=']([a, ['&', a, b]]) },
  '|='([a, b]) { return operators['=']([a, ['|', a, b]]) },
  '^='([a, b]) { return operators['=']([a, ['^', a, b]]) },
  '<<='([a, b]) { return operators['=']([a, ['<<', a, b]]) },
  '>>='([a, b]) { return operators['=']([a, ['>>', a, b]]) },
  '>>>='([a, b]) { return operators['=']([a, ['>>>', a, b]]) },
}

// --- Assignment as side effect (in comma expr) ---
function genAssignmentSideEffect(target, value) {
  // Arrow function assignment
  if (Array.isArray(value) && value[0] === '=>') {
    const [, rawParams, body] = value
    const name = typeof target === 'string' ? target : null
    if (!name) throw new Error('Function must be assigned to a variable')
    const params = extractParams(rawParams)
    ctx.functions.set(name, { params, body, exported: true })
    return ''
  }
  // Module-level constant
  if (typeof target === 'string' && !ctx.inFunction) {
    if (Array.isArray(value) && value[0] === undefined && typeof value[1] === 'number') {
      ctx.addGlobal(target, 'f64', `(f64.const ${fmtNum(value[1])})`)
      return ''
    }
    // Math property access at module level: x = Math.PI
    if (Array.isArray(value) && value[0] === '.' && value[1] === 'Math' && value[2] in MATH_CONSTANTS) {
      ctx.addGlobal(target, 'f64', `(f64.const ${fmtNum(MATH_CONSTANTS[value[2]])})`)
      return ''
    }
  }
  // Array destructuring
  if (Array.isArray(target) && target[0] === '[' && target.length > 1 && typeof target[1] === 'string') {
    return `(drop ${genArrayDestructure(target.slice(1), value).wat})\n    `
  }
  // Object destructuring
  if (Array.isArray(target) && target[0] === '{' && target.length > 1) {
    const isDestr = target.slice(1).every(p => typeof p === 'string' || (Array.isArray(p) && typeof p[0] === 'string'))
    if (isDestr) {
      const vars = target.slice(1).map(p => typeof p === 'string' ? p : p[0])
      return `(drop ${genObjectDestructure(vars, value).wat})\n    `
    }
  }
  // Array element
  if (Array.isArray(target) && target[0] === '[]') {
    const arr = gen(target[1]), idx = asI32(gen(target[2])), val = asF64(gen(value))
    ctx.usedArrayType = true
    return `(array.set $f64array ${arr.wat} ${idx.wat} ${val.wat})\n    `
  }
  // Simple variable
  if (typeof target === 'string') {
    const val = gen(value)
    // Check if already exists as global
    const glob = ctx.getGlobal(target)
    if (glob) {
      return `(global.set $${target} ${asF64(val).wat})\n    `
    }
    ctx.addLocal(target, val.t)
    return `(local.set $${target} ${val.wat})\n    `
  }
  throw new Error('Invalid assignment target')
}

// --- Loop init assignment ---
// Always emits runtime assignment code (unlike genAssignmentSideEffect which may create globals only)
function genLoopInit(target, value) {
  if (typeof target !== 'string') throw new Error('Loop init must assign to a simple variable')
  const val = gen(value)

  // Check if already exists as global
  const glob = ctx.getGlobal(target)
  if (glob) {
    return `(global.set $${target} ${asF64(val).wat})\n    `
  }

  // Check if exists as local
  const loc = ctx.getLocal(target)
  if (loc) {
    return `(local.set $${target} ${asF64(val).wat})\n    `
  }

  // Create new local (or global if we're at module level before main)
  // For now, create as local since we're inside main()
  ctx.addLocal(target, val.t)
  return `(local.set $${target} ${asF64(val).wat})\n    `
}

// --- Destructuring helpers ---
function genArrayDestructure(vars, valueAst) {
  ctx.usedArrayType = true
  const arr = gen(valueAst)
  const temp = `_destruct${ctx.localCounter}`
  ctx.addLocal(temp, arr.t)
  let code = `(local.set $${temp} ${arr.wat})\n    `
  for (let i = 0; i < vars.length; i++) {
    if (typeof vars[i] === 'string') {
      ctx.addLocal(vars[i], 'f64')
      code += `(local.set $${vars[i]} (array.get $f64array (local.get $${temp}) (i32.const ${i})))\n    `
    }
  }
  const last = vars[vars.length - 1]
  return tv('f64', typeof last === 'string' ? code + `(local.get $${last})` : code + '(f64.const 0)')
}

function genObjectDestructure(vars, valueAst) {
  const obj = gen(valueAst)
  if (!obj.t.startsWith('struct:')) throw new Error('Object destructuring requires struct')
  const typeName = obj.t.slice(7)
  let st = null
  for (const [, s] of ctx.structTypes) if (s.typeName === typeName) { st = s; break }
  if (!st) throw new Error(`Unknown struct: ${typeName}`)

  const temp = `_destruct${ctx.localCounter}`
  ctx.addLocal(temp, obj.t)
  let code = `(local.set $${temp} ${obj.wat})\n    `
  for (const v of vars) {
    if (typeof v === 'string') {
      const idx = st.fields.indexOf(v)
      if (idx === -1) throw new Error(`Unknown field: ${v}`)
      ctx.addLocal(v, 'f64')
      code += `(local.set $${v} (struct.get $${typeName} ${idx} (local.get $${temp})))\n    `
    }
  }
  const last = vars[vars.length - 1]
  return tv('f64', typeof last === 'string' ? code + `(local.get $${last})` : code + '(f64.const 0)')
}

// --- Extract params from arrow function AST ---
function extractParams(rawParams) {
  if (rawParams == null) return []
  if (Array.isArray(rawParams) && rawParams[0] === undefined) return []
  if (typeof rawParams === 'string') return [rawParams]
  if (Array.isArray(rawParams) && rawParams[0] === ',') {
    return rawParams.slice(1).filter(p => typeof p === 'string')
  }
  if (Array.isArray(rawParams) && rawParams[0] === '()') {
    const inner = rawParams[1]
    if (inner == null) return []
    if (Array.isArray(inner) && inner[0] === undefined) return []
    if (typeof inner === 'string') return [inner]
    if (Array.isArray(inner) && inner[0] === ',') {
      return inner.slice(1).filter(p => typeof p === 'string')
    }
  }
  throw new Error(`Invalid params: ${JSON.stringify(rawParams)}`)
}

// --- Generate function code ---
function generateFunction(name, params, bodyAst, parentCtx) {
  const prevCtx = ctx
  ctx = createContext()
  ctx.usedStdlib = parentCtx.usedStdlib
  ctx.usedArrayType = parentCtx.usedArrayType
  ctx.usedStringType = parentCtx.usedStringType
  ctx.structTypes = parentCtx.structTypes
  ctx.functions = parentCtx.functions
  ctx.globals = parentCtx.globals
  ctx.inFunction = true

  for (const p of params) {
    ctx.locals.set(p, { idx: ctx.localCounter++, type: 'f64' })
  }

  const body = asF64(gen(bodyAst))
  const paramDecls = params.map(p => `(param $${p} f64)`).join(' ')
  const localDecls = ctx.localDecls.length ? `\n    ${ctx.localDecls.join(' ')}` : ''

  const wat = `(func $${name} (export "${name}") ${paramDecls} (result f64)${localDecls}
    ${body.wat}
  )`

  ctx = prevCtx
  return wat
}

function generateFunctions() {
  const fns = []
  for (const [name, def] of ctx.functions) {
    fns.push(generateFunction(name, def.params, def.body, ctx))
  }
  return fns
}

// --- Module assembly ---
function assemble(bodyWat, ctx, extraFunctions = []) {
  let wat = '(module\n'

  // GC types
  if (ctx.usedArrayType) wat += '  (type $f64array (array (mut f64)))\n'
  if (ctx.usedStringType) wat += '  (type $string (array (mut i16)))\n'

  // Struct types
  for (const [, st] of ctx.structTypes) {
    const fields = st.fields.map(f => `(field $${f} (mut f64))`).join(' ')
    wat += `  (type $${st.typeName} (struct ${fields}))\n`
  }

  // Data sections for interned strings
  for (const [str, info] of ctx.strings) {
    // Compute the byte range for this string in stringData
    const startByte = info.offset * 2
    const endByte = startByte + info.length * 2
    const bytes = ctx.stringData.slice(startByte, endByte)
    const hex = bytes.map(b => '\\' + b.toString(16).padStart(2, '0')).join('')
    wat += `  (data $str${info.id} "${hex}")\n`
  }

  // Pure WASM stdlib - only include used functions
  const included = new Set()
  function include(name) {
    if (included.has(name)) return
    included.add(name)
    const deps = DEPS[name] || []
    for (const dep of deps) include(dep)
    const fn = FUNCTIONS[name]
    if (fn) wat += `  ${fn}\n`
  }

  if (ctx.usedStdlib.size > 0) {
    wat += CONSTANTS
    for (const name of ctx.usedStdlib) include(name)
  }

  // Module-level globals
  for (const [name, g] of ctx.globals) {
    wat += `  (global $${name} (mut f64) ${g.init})\n`
  }

  // Utility functions
  wat += `  (func $die (result f64) (unreachable))\n`
  wat += `  (func $f64.rem (param f64 f64) (result f64)
    (f64.sub (local.get 0) (f64.mul (f64.trunc (f64.div (local.get 0) (local.get 1))) (local.get 1))))\n`

  // User-defined functions
  for (const fn of extraFunctions) {
    wat += `  ${fn}\n`
  }

  // Main function
  const hasMainBody = bodyWat && bodyWat.trim() && bodyWat.trim() !== '(f64.const 0)'
  if (hasMainBody || extraFunctions.length === 0) {
    const locals = ctx.localDecls.length ? `\n    ${ctx.localDecls.join(' ')}` : ''
    wat += `
  (func $main (export "main") (param $t f64) (result f64)${locals}
    ${bodyWat}
  )`
  }

  wat += '\n)'
  return wat
}

// --- Assemble raw WAT (for testing) ---
export function assembleRaw(bodyWat) {
  const emptyCtx = {
    usedArrayType: false, usedStringType: false,
    usedStdlib: new Set(), structTypes: new Map(), localDecls: [],
    functions: new Map(), globals: new Map(),
    strings: new Map(), stringData: []
  }
  return assemble(bodyWat, emptyCtx)
}
