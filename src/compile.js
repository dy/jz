// AST to WAT compilation
import { CONSTANTS, FUNCTIONS, DEPS } from './stdlib.js'

// Pointer type encoding for gc:false mode
// Encoding: [type:4][length:28][offset:32] packed into i64, reinterpreted as f64
const PTR_TYPE = { F64_ARRAY: 0, I32_ARRAY: 1, STRING: 2, I8_ARRAY: 3, OBJECT: 4 }
const PTR_ELEM_SIZE = { 0: 8, 1: 4, 2: 2, 3: 1, 4: 8 }  // bytes per element

// Typed value: [type, wat, schema?] - schema for objects to track property layout
const tv = (t, wat, schema) => [t, wat, schema]

// Type coercions
const asF64 = ([t, w]) =>
  t === 'f64' ? [t, w] :
  t === 'ref' || t === 'object' ? ['f64', '(f64.const 0)'] :
  ['f64', `(f64.convert_i32_s ${w})`]

const asI32 = ([t, w]) =>
  t === 'i32' ? [t, w] :
  t === 'ref' || t === 'object' ? ['i32', '(i32.const 0)'] :
  ['i32', `(i32.trunc_f64_s ${w})`]

const truthy = ([t, w]) =>
  t === 'ref' ? ['i32', `(i32.eqz (ref.is_null ${w}))`] :
  t === 'i32' ? ['i32', `(i32.ne ${w} (i32.const 0))`] :
  ['i32', `(f64.ne ${w} (f64.const 0))`]

const conciliate = (a, b) =>
  a[0] === 'i32' && b[0] === 'i32' ? [a, b] : [asF64(a), asF64(b)]

// Number formatting for WAT
const fmtNum = n =>
  Object.is(n, -0) ? '-0' :
  Number.isNaN(n) ? 'nan' :
  n === Infinity ? 'inf' :
  n === -Infinity ? '-inf' :
  String(n)

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

// Codegen context
let ctx = null

// Compile options
let opts = { gc: true }

const createContext = () => ({
  locals: new Map(), localDecls: [], globals: new Map(),
  usedStdlib: new Set(), usedArrayType: false, usedStringType: false, usedMemory: false,
  localCounter: 0, loopCounter: 0, functions: new Map(), inFunction: false,
  strings: new Map(), stringData: [], stringCounter: 0,
  objectCounter: 0, objectSchemas: new Map(), localSchemas: new Map(),
  // Memory allocation tracking for gc:false mode
  staticAllocs: [], staticOffset: 0,

  addLocal(name, type = 'f64', schema) {
    if (!this.locals.has(name)) {
      this.locals.set(name, { idx: this.localCounter++, type })
      // In gc:false mode, arrays/objects are f64 (encoded pointers)
      const wasmType = opts.gc
        ? (type === 'array' || type === 'ref' || type === 'object' ? '(ref null $f64array)' : type === 'string' ? '(ref null $string)' : type)
        : (type === 'array' || type === 'ref' || type === 'object' || type === 'string' ? 'f64' : type)
      this.localDecls.push(`(local $${name} ${wasmType})`)
    }
    if (schema !== undefined) this.localSchemas.set(name, schema)
    return this.locals.get(name)
  },
  getLocal(name) { return this.locals.get(name) },
  addGlobal(name, type = 'f64', init = '(f64.const 0)') {
    if (!this.globals.has(name)) this.globals.set(name, { type, init })
    return this.globals.get(name)
  },
  getGlobal(name) { return this.globals.get(name) },
  internString(str) {
    if (this.strings.has(str)) return this.strings.get(str)
    const id = this.stringCounter++
    const offset = this.stringData.length / 2
    for (const char of str) {
      const code = char.charCodeAt(0)
      this.stringData.push(code & 0xFF, (code >> 8) & 0xFF)
    }
    const info = { id, offset, length: str.length }
    this.strings.set(str, info)
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
  opts = { gc: true, ...options }
  ctx = createContext()
  ctx.locals.set('t', { type: 'f64', idx: ctx.locals.size })
  const [, bodyWat] = asF64(gen(ast))
  return assemble(bodyWat, ctx, generateFunctions())
}

export function assembleRaw(bodyWat) {
  return assemble(bodyWat, {
    usedArrayType: false, usedStringType: false, usedMemory: false, usedStdlib: new Set(),
    localDecls: [], functions: new Map(), globals: new Map(), strings: new Map(), stringData: [],
    staticAllocs: [], staticOffset: 0
  })
}

// Core generator
function gen(ast) {
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
      return tv('string', `(array.new_data $string $str${id} (i32.const 0) (i32.const ${length}))`)
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
  const loc = ctx.getLocal(name)
  if (loc) return tv(loc.type, `(local.get $${name})`, ctx.localSchemas.get(name))
  const glob = ctx.getGlobal(name)
  if (glob) return tv(glob.type, `(global.get $${name})`)
  throw new Error(`Unknown identifier: ${name}`)
}

// Function call resolution
function resolveCall(namespace, name, args, receiver = null) {
  // Method calls
  if (receiver !== null) {
    const [rt, rw] = receiver
    if (rt === 'string' && name === 'charCodeAt' && args.length === 1) {
      ctx.usedStringType = true
      if (opts.gc) {
        return tv('i32', `(array.get_u $string ${rw} ${asI32(gen(args[0]))[1]})`)
      } else {
        ctx.usedMemory = true
        const iw = asI32(gen(args[0]))[1]
        return tv('i32', `(i32.load16_u (i32.add (call $__ptr_offset ${rw}) (i32.shl ${iw} (i32.const 1))))`)
      }
    }
    if (rt === 'array') {
      if (name === 'fill' && args.length >= 1) {
        ctx.usedArrayType = true
        if (opts.gc) {
          ctx.usedStdlib.add('arrayFill')
          return tv('array', `(call $arrayFill ${rw} ${asF64(gen(args[0]))[1]})`)
        } else {
          ctx.usedMemory = true
          ctx.usedStdlib.add('arrayFillMem')
          return tv('array', `(call $arrayFillMem ${rw} ${asF64(gen(args[0]))[1]})`)
        }
      }
      if (name === 'map' && args.length === 1) {
        ctx.usedArrayType = true
        const callback = args[0]
        if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.map requires arrow function')
        const [, params, body] = callback
        const paramName = extractParams(params)[0] || '_v'
        const id = ctx.loopCounter++
        const arr = `$_map_arr_${id}`, result = `$_map_result_${id}`, idx = `$_map_i_${id}`, len = `$_map_len_${id}`
        ctx.addLocal(arr.slice(1), 'array')
        ctx.addLocal(result.slice(1), 'array')
        ctx.addLocal(idx.slice(1), 'i32')
        ctx.addLocal(len.slice(1), 'i32')
        ctx.addLocal(paramName, 'f64')
        if (opts.gc) {
          return tv('array', `(local.set ${arr} ${rw})
    (local.set ${len} (array.len (local.get ${arr})))
    (local.set ${result} (array.new $f64array (f64.const 0) (local.get ${len})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} (array.get $f64array (local.get ${arr}) (local.get ${idx})))
      (array.set $f64array (local.get ${result}) (local.get ${idx}) ${asF64(gen(body))[1]})
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
        } else {
          ctx.usedMemory = true
          return tv('array', `(local.set ${arr} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    (local.set ${result} (call $__alloc (i32.const ${PTR_TYPE.F64_ARRAY}) (local.get ${len})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${idx}) (i32.const 3)))))
      (f64.store (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (local.get ${idx}) (i32.const 3))) ${asF64(gen(body))[1]})
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
        }
      }
      if (name === 'reduce' && args.length >= 1) {
        ctx.usedArrayType = true
        const callback = args[0]
        if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.reduce requires arrow function')
        const [, params, body] = callback
        const paramNames = extractParams(params)
        const accName = paramNames[0] || '_acc', curName = paramNames[1] || '_cur'
        const id = ctx.loopCounter++
        const arr = `$_reduce_arr_${id}`, acc = `$_reduce_acc_${id}`, idx = `$_reduce_i_${id}`, len = `$_reduce_len_${id}`
        ctx.addLocal(arr.slice(1), 'array')
        ctx.addLocal(acc.slice(1), 'f64')
        ctx.addLocal(idx.slice(1), 'i32')
        ctx.addLocal(len.slice(1), 'i32')
        ctx.addLocal(accName, 'f64')
        ctx.addLocal(curName, 'f64')
        if (opts.gc) {
          const initAcc = args.length >= 2
            ? `(local.set ${acc} ${asF64(gen(args[1]))[1]})\n    (local.set ${idx} (i32.const 0))`
            : `(local.set ${acc} (array.get $f64array (local.get ${arr}) (i32.const 0)))\n    (local.set ${idx} (i32.const 1))`
          return tv('f64', `(local.set ${arr} ${rw})
    (local.set ${len} (array.len (local.get ${arr})))
    ${initAcc}
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${accName} (local.get ${acc}))
      (local.set $${curName} (array.get $f64array (local.get ${arr}) (local.get ${idx})))
      (local.set ${acc} ${asF64(gen(body))[1]})
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${acc})`)
        } else {
          ctx.usedMemory = true
          const initAcc = args.length >= 2
            ? `(local.set ${acc} ${asF64(gen(args[1]))[1]})\n    (local.set ${idx} (i32.const 0))`
            : `(local.set ${acc} (f64.load (call $__ptr_offset (local.get ${arr}))))\n    (local.set ${idx} (i32.const 1))`
          return tv('f64', `(local.set ${arr} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    ${initAcc}
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${accName} (local.get ${acc}))
      (local.set $${curName} (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${idx}) (i32.const 3)))))
      (local.set ${acc} ${asF64(gen(body))[1]})
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${acc})`)
        }
      }
      // Array.filter
      if (name === 'filter' && args.length === 1) {
        ctx.usedArrayType = true
        const callback = args[0]
        if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.filter requires arrow function')
        const [, params, body] = callback
        const paramName = extractParams(params)[0] || '_v'
        const id = ctx.loopCounter++
        const arr = `$_filter_arr_${id}`, result = `$_filter_result_${id}`, idx = `$_filter_i_${id}`, len = `$_filter_len_${id}`, outIdx = `$_filter_out_${id}`, val = `$_filter_val_${id}`
        ctx.addLocal(arr.slice(1), 'array')
        ctx.addLocal(result.slice(1), 'array')
        ctx.addLocal(idx.slice(1), 'i32')
        ctx.addLocal(len.slice(1), 'i32')
        ctx.addLocal(outIdx.slice(1), 'i32')
        ctx.addLocal(val.slice(1), 'f64')
        ctx.addLocal(paramName, 'f64')
        if (opts.gc) {
          return tv('array', `(local.set ${arr} ${rw})
    (local.set ${len} (array.len (local.get ${arr})))
    (local.set ${result} (array.new $f64array (f64.const 0) (local.get ${len})))
    (local.set ${idx} (i32.const 0))
    (local.set ${outIdx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set ${val} (array.get $f64array (local.get ${arr}) (local.get ${idx})))
      (local.set $${paramName} (local.get ${val}))
      (if ${truthy(gen(body))[1]}
        (then
          (array.set $f64array (local.get ${result}) (local.get ${outIdx}) (local.get ${val}))
          (local.set ${outIdx} (i32.add (local.get ${outIdx}) (i32.const 1)))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
        } else {
          ctx.usedMemory = true
          return tv('array', `(local.set ${arr} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    (local.set ${result} (call $__alloc (i32.const ${PTR_TYPE.F64_ARRAY}) (local.get ${len})))
    (local.set ${idx} (i32.const 0))
    (local.set ${outIdx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set ${val} (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${idx}) (i32.const 3)))))
      (local.set $${paramName} (local.get ${val}))
      (if ${truthy(gen(body))[1]}
        (then
          (f64.store (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (local.get ${outIdx}) (i32.const 3))) (local.get ${val}))
          (local.set ${outIdx} (i32.add (local.get ${outIdx}) (i32.const 1)))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
        }
      }
      // Array.find
      if (name === 'find' && args.length === 1) {
        ctx.usedArrayType = true
        const callback = args[0]
        if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.find requires arrow function')
        const [, params, body] = callback
        const paramName = extractParams(params)[0] || '_v'
        const id = ctx.loopCounter++
        const arr = `$_find_arr_${id}`, idx = `$_find_i_${id}`, len = `$_find_len_${id}`, val = `$_find_val_${id}`, found = `$_find_found_${id}`
        ctx.addLocal(arr.slice(1), 'array')
        ctx.addLocal(idx.slice(1), 'i32')
        ctx.addLocal(len.slice(1), 'i32')
        ctx.addLocal(val.slice(1), 'f64')
        ctx.addLocal(found.slice(1), 'f64')
        ctx.addLocal(paramName, 'f64')
        if (opts.gc) {
          return tv('f64', `(local.set ${arr} ${rw})
    (local.set ${len} (array.len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (local.set ${found} (f64.const nan))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set ${val} (array.get $f64array (local.get ${arr}) (local.get ${idx})))
      (local.set $${paramName} (local.get ${val}))
      (if ${truthy(gen(body))[1]}
        (then
          (local.set ${found} (local.get ${val}))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${found})`)
        } else {
          ctx.usedMemory = true
          return tv('f64', `(local.set ${arr} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (local.set ${found} (f64.const nan))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set ${val} (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${idx}) (i32.const 3)))))
      (local.set $${paramName} (local.get ${val}))
      (if ${truthy(gen(body))[1]}
        (then
          (local.set ${found} (local.get ${val}))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${found})`)
        }
      }
      // Array.findIndex
      if (name === 'findIndex' && args.length === 1) {
        ctx.usedArrayType = true
        const callback = args[0]
        if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.findIndex requires arrow function')
        const [, params, body] = callback
        const paramName = extractParams(params)[0] || '_v'
        const id = ctx.loopCounter++
        const arr = `$_findi_arr_${id}`, idx = `$_findi_i_${id}`, len = `$_findi_len_${id}`, result = `$_findi_result_${id}`
        ctx.addLocal(arr.slice(1), 'array')
        ctx.addLocal(idx.slice(1), 'i32')
        ctx.addLocal(len.slice(1), 'i32')
        ctx.addLocal(result.slice(1), 'i32')
        ctx.addLocal(paramName, 'f64')
        if (opts.gc) {
          return tv('i32', `(local.set ${arr} ${rw})
    (local.set ${len} (array.len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const -1))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} (array.get $f64array (local.get ${arr}) (local.get ${idx})))
      (if ${truthy(gen(body))[1]}
        (then
          (local.set ${result} (local.get ${idx}))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
        } else {
          ctx.usedMemory = true
          return tv('i32', `(local.set ${arr} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const -1))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${idx}) (i32.const 3)))))
      (if ${truthy(gen(body))[1]}
        (then
          (local.set ${result} (local.get ${idx}))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
        }
      }
      // Array.indexOf
      if (name === 'indexOf' && args.length >= 1) {
        ctx.usedArrayType = true
        const id = ctx.loopCounter++
        const arr = `$_indexof_arr_${id}`, idx = `$_indexof_i_${id}`, len = `$_indexof_len_${id}`, result = `$_indexof_result_${id}`, target = `$_indexof_target_${id}`
        ctx.addLocal(arr.slice(1), 'array')
        ctx.addLocal(idx.slice(1), 'i32')
        ctx.addLocal(len.slice(1), 'i32')
        ctx.addLocal(result.slice(1), 'i32')
        ctx.addLocal(target.slice(1), 'f64')
        const startIdx = args.length >= 2 ? asI32(gen(args[1]))[1] : '(i32.const 0)'
        if (opts.gc) {
          return tv('i32', `(local.set ${arr} ${rw})
    (local.set ${target} ${asF64(gen(args[0]))[1]})
    (local.set ${len} (array.len (local.get ${arr})))
    (local.set ${idx} ${startIdx})
    (local.set ${result} (i32.const -1))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (if (f64.eq (array.get $f64array (local.get ${arr}) (local.get ${idx})) (local.get ${target}))
        (then
          (local.set ${result} (local.get ${idx}))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
        } else {
          ctx.usedMemory = true
          return tv('i32', `(local.set ${arr} ${rw})
    (local.set ${target} ${asF64(gen(args[0]))[1]})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    (local.set ${idx} ${startIdx})
    (local.set ${result} (i32.const -1))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (if (f64.eq (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${idx}) (i32.const 3)))) (local.get ${target}))
        (then
          (local.set ${result} (local.get ${idx}))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
        }
      }
      // Array.includes
      if (name === 'includes' && args.length >= 1) {
        ctx.usedArrayType = true
        const id = ctx.loopCounter++
        const arr = `$_includes_arr_${id}`, idx = `$_includes_i_${id}`, len = `$_includes_len_${id}`, result = `$_includes_result_${id}`, target = `$_includes_target_${id}`
        ctx.addLocal(arr.slice(1), 'array')
        ctx.addLocal(idx.slice(1), 'i32')
        ctx.addLocal(len.slice(1), 'i32')
        ctx.addLocal(result.slice(1), 'i32')
        ctx.addLocal(target.slice(1), 'f64')
        if (opts.gc) {
          return tv('i32', `(local.set ${arr} ${rw})
    (local.set ${target} ${asF64(gen(args[0]))[1]})
    (local.set ${len} (array.len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (if (f64.eq (array.get $f64array (local.get ${arr}) (local.get ${idx})) (local.get ${target}))
        (then
          (local.set ${result} (i32.const 1))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
        } else {
          ctx.usedMemory = true
          return tv('i32', `(local.set ${arr} ${rw})
    (local.set ${target} ${asF64(gen(args[0]))[1]})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (if (f64.eq (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${idx}) (i32.const 3)))) (local.get ${target}))
        (then
          (local.set ${result} (i32.const 1))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
        }
      }
      // Array.every
      if (name === 'every' && args.length === 1) {
        ctx.usedArrayType = true
        const callback = args[0]
        if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.every requires arrow function')
        const [, params, body] = callback
        const paramName = extractParams(params)[0] || '_v'
        const id = ctx.loopCounter++
        const arr = `$_every_arr_${id}`, idx = `$_every_i_${id}`, len = `$_every_len_${id}`, result = `$_every_result_${id}`
        ctx.addLocal(arr.slice(1), 'array')
        ctx.addLocal(idx.slice(1), 'i32')
        ctx.addLocal(len.slice(1), 'i32')
        ctx.addLocal(result.slice(1), 'i32')
        ctx.addLocal(paramName, 'f64')
        if (opts.gc) {
          return tv('i32', `(local.set ${arr} ${rw})
    (local.set ${len} (array.len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const 1))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} (array.get $f64array (local.get ${arr}) (local.get ${idx})))
      (if (i32.eqz ${truthy(gen(body))[1]})
        (then
          (local.set ${result} (i32.const 0))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
        } else {
          ctx.usedMemory = true
          return tv('i32', `(local.set ${arr} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const 1))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${idx}) (i32.const 3)))))
      (if (i32.eqz ${truthy(gen(body))[1]})
        (then
          (local.set ${result} (i32.const 0))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
        }
      }
      // Array.some
      if (name === 'some' && args.length === 1) {
        ctx.usedArrayType = true
        const callback = args[0]
        if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.some requires arrow function')
        const [, params, body] = callback
        const paramName = extractParams(params)[0] || '_v'
        const id = ctx.loopCounter++
        const arr = `$_some_arr_${id}`, idx = `$_some_i_${id}`, len = `$_some_len_${id}`, result = `$_some_result_${id}`
        ctx.addLocal(arr.slice(1), 'array')
        ctx.addLocal(idx.slice(1), 'i32')
        ctx.addLocal(len.slice(1), 'i32')
        ctx.addLocal(result.slice(1), 'i32')
        ctx.addLocal(paramName, 'f64')
        if (opts.gc) {
          return tv('i32', `(local.set ${arr} ${rw})
    (local.set ${len} (array.len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} (array.get $f64array (local.get ${arr}) (local.get ${idx})))
      (if ${truthy(gen(body))[1]}
        (then
          (local.set ${result} (i32.const 1))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
        } else {
          ctx.usedMemory = true
          return tv('i32', `(local.set ${arr} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${idx}) (i32.const 3)))))
      (if ${truthy(gen(body))[1]}
        (then
          (local.set ${result} (i32.const 1))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
        }
      }
      // Array.slice
      if (name === 'slice' && args.length >= 0) {
        ctx.usedArrayType = true
        const id = ctx.loopCounter++
        const arr = `$_slice_arr_${id}`, idx = `$_slice_i_${id}`, len = `$_slice_len_${id}`, result = `$_slice_result_${id}`, start = `$_slice_start_${id}`, end = `$_slice_end_${id}`, newLen = `$_slice_newlen_${id}`
        ctx.addLocal(arr.slice(1), 'array')
        ctx.addLocal(idx.slice(1), 'i32')
        ctx.addLocal(len.slice(1), 'i32')
        ctx.addLocal(result.slice(1), 'array')
        ctx.addLocal(start.slice(1), 'i32')
        ctx.addLocal(end.slice(1), 'i32')
        ctx.addLocal(newLen.slice(1), 'i32')
        const startArg = args.length >= 1 ? asI32(gen(args[0]))[1] : '(i32.const 0)'
        if (opts.gc) {
          const endArg = args.length >= 2 ? asI32(gen(args[1]))[1] : `(array.len (local.get ${arr}))`
          return tv('array', `(local.set ${arr} ${rw})
    (local.set ${len} (array.len (local.get ${arr})))
    (local.set ${start} ${startArg})
    (local.set ${end} ${endArg})
    ;; Handle negative indices
    (if (i32.lt_s (local.get ${start}) (i32.const 0))
      (then (local.set ${start} (i32.add (local.get ${len}) (local.get ${start})))))
    (if (i32.lt_s (local.get ${end}) (i32.const 0))
      (then (local.set ${end} (i32.add (local.get ${len}) (local.get ${end})))))
    ;; Clamp
    (if (i32.lt_s (local.get ${start}) (i32.const 0)) (then (local.set ${start} (i32.const 0))))
    (if (i32.gt_s (local.get ${end}) (local.get ${len})) (then (local.set ${end} (local.get ${len}))))
    (local.set ${newLen} (i32.sub (local.get ${end}) (local.get ${start})))
    (if (i32.lt_s (local.get ${newLen}) (i32.const 0)) (then (local.set ${newLen} (i32.const 0))))
    (local.set ${result} (array.new $f64array (f64.const 0) (local.get ${newLen})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${newLen})))
      (array.set $f64array (local.get ${result}) (local.get ${idx})
        (array.get $f64array (local.get ${arr}) (i32.add (local.get ${start}) (local.get ${idx}))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
        } else {
          ctx.usedMemory = true
          const endArg = args.length >= 2 ? asI32(gen(args[1]))[1] : `(call $__ptr_len (local.get ${arr}))`
          return tv('array', `(local.set ${arr} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    (local.set ${start} ${startArg})
    (local.set ${end} ${endArg})
    ;; Handle negative indices
    (if (i32.lt_s (local.get ${start}) (i32.const 0))
      (then (local.set ${start} (i32.add (local.get ${len}) (local.get ${start})))))
    (if (i32.lt_s (local.get ${end}) (i32.const 0))
      (then (local.set ${end} (i32.add (local.get ${len}) (local.get ${end})))))
    ;; Clamp
    (if (i32.lt_s (local.get ${start}) (i32.const 0)) (then (local.set ${start} (i32.const 0))))
    (if (i32.gt_s (local.get ${end}) (local.get ${len})) (then (local.set ${end} (local.get ${len}))))
    (local.set ${newLen} (i32.sub (local.get ${end}) (local.get ${start})))
    (if (i32.lt_s (local.get ${newLen}) (i32.const 0)) (then (local.set ${newLen} (i32.const 0))))
    (local.set ${result} (call $__alloc (i32.const ${PTR_TYPE.F64_ARRAY}) (local.get ${newLen})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${newLen})))
      (f64.store (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (local.get ${idx}) (i32.const 3)))
        (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (i32.add (local.get ${start}) (local.get ${idx})) (i32.const 3)))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
        }
      }
      // Array.reverse
      if (name === 'reverse' && args.length === 0) {
        ctx.usedArrayType = true
        const id = ctx.loopCounter++
        const arr = `$_rev_arr_${id}`, idx = `$_rev_i_${id}`, len = `$_rev_len_${id}`, tmp = `$_rev_tmp_${id}`, j = `$_rev_j_${id}`
        ctx.addLocal(arr.slice(1), 'array')
        ctx.addLocal(idx.slice(1), 'i32')
        ctx.addLocal(len.slice(1), 'i32')
        ctx.addLocal(tmp.slice(1), 'f64')
        ctx.addLocal(j.slice(1), 'i32')
        if (opts.gc) {
          return tv('array', `(local.set ${arr} ${rw})
    (local.set ${len} (array.len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (local.set ${j} (i32.sub (i32.sub (local.get ${len}) (local.get ${idx})) (i32.const 1)))
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${j})))
      (local.set ${tmp} (array.get $f64array (local.get ${arr}) (local.get ${idx})))
      (array.set $f64array (local.get ${arr}) (local.get ${idx}) (array.get $f64array (local.get ${arr}) (local.get ${j})))
      (array.set $f64array (local.get ${arr}) (local.get ${j}) (local.get ${tmp}))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${arr})`)
        } else {
          ctx.usedMemory = true
          return tv('array', `(local.set ${arr} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (local.set ${j} (i32.sub (i32.sub (local.get ${len}) (local.get ${idx})) (i32.const 1)))
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${j})))
      (local.set ${tmp} (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${idx}) (i32.const 3)))))
      (f64.store (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${idx}) (i32.const 3)))
        (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${j}) (i32.const 3)))))
      (f64.store (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${j}) (i32.const 3))) (local.get ${tmp}))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${arr})`)
        }
      }
      // Array.push
      if (name === 'push' && args.length >= 1) {
        ctx.usedArrayType = true
        // For simplicity, only support push of single element
        // Returns new length
        if (opts.gc) {
          throw new Error('push not supported in gc:true mode (immutable arrays)')
        } else {
          ctx.usedMemory = true
          const id = ctx.loopCounter++
          const arr = `$_push_arr_${id}`, len = `$_push_len_${id}`, newLen = `$_push_newlen_${id}`
          ctx.addLocal(arr.slice(1), 'f64')
          ctx.addLocal(len.slice(1), 'i32')
          ctx.addLocal(newLen.slice(1), 'i32')
          return tv('i32', `(local.set ${arr} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    (local.set ${newLen} (i32.add (local.get ${len}) (i32.const ${args.length})))
    ;; Note: This doesn't actually resize - just writes beyond current length
    ;; Real implementation would need reallocation
    (f64.store (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${len}) (i32.const 3))) ${asF64(gen(args[0]))[1]})
    (local.get ${newLen})`)
        }
      }
      // Array.pop
      if (name === 'pop' && args.length === 0) {
        ctx.usedArrayType = true
        if (opts.gc) {
          throw new Error('pop not supported in gc:true mode (immutable arrays)')
        } else {
          ctx.usedMemory = true
          const id = ctx.loopCounter++
          const arr = `$_pop_arr_${id}`, len = `$_pop_len_${id}`
          ctx.addLocal(arr.slice(1), 'f64')
          ctx.addLocal(len.slice(1), 'i32')
          return tv('f64', `(local.set ${arr} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    (if (result f64) (i32.gt_s (local.get ${len}) (i32.const 0))
      (then
        (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (i32.sub (local.get ${len}) (i32.const 1)) (i32.const 3)))))
      (else (f64.const nan)))`)
        }
      }
      // Array.forEach
      if (name === 'forEach' && args.length === 1) {
        ctx.usedArrayType = true
        const callback = args[0]
        if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.forEach requires arrow function')
        const [, params, body] = callback
        const paramName = extractParams(params)[0] || '_v'
        const id = ctx.loopCounter++
        const arr = `$_foreach_arr_${id}`, idx = `$_foreach_i_${id}`, len = `$_foreach_len_${id}`
        ctx.addLocal(arr.slice(1), 'array')
        ctx.addLocal(idx.slice(1), 'i32')
        ctx.addLocal(len.slice(1), 'i32')
        ctx.addLocal(paramName, 'f64')
        if (opts.gc) {
          return tv('f64', `(local.set ${arr} ${rw})
    (local.set ${len} (array.len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} (array.get $f64array (local.get ${arr}) (local.get ${idx})))
      (drop ${asF64(gen(body))[1]})
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (f64.const 0)`)
        } else {
          ctx.usedMemory = true
          return tv('f64', `(local.set ${arr} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${idx}) (i32.const 3)))))
      (drop ${asF64(gen(body))[1]})
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (f64.const 0)`)
        }
      }
      // Array.concat
      if (name === 'concat' && args.length >= 1) {
        ctx.usedArrayType = true
        const id = ctx.loopCounter++
        const arr1 = `$_concat_arr1_${id}`, arr2 = `$_concat_arr2_${id}`, result = `$_concat_result_${id}`
        const len1 = `$_concat_len1_${id}`, len2 = `$_concat_len2_${id}`, idx = `$_concat_i_${id}`, totalLen = `$_concat_total_${id}`
        ctx.addLocal(arr1.slice(1), 'array')
        ctx.addLocal(arr2.slice(1), 'array')
        ctx.addLocal(result.slice(1), 'array')
        ctx.addLocal(len1.slice(1), 'i32')
        ctx.addLocal(len2.slice(1), 'i32')
        ctx.addLocal(totalLen.slice(1), 'i32')
        ctx.addLocal(idx.slice(1), 'i32')
        
        const arg2 = gen(args[0])
        if (opts.gc) {
          return tv('array', `(local.set ${arr1} ${rw})
    (local.set ${arr2} ${arg2[1]})
    (local.set ${len1} (array.len (local.get ${arr1})))
    (local.set ${len2} (array.len (local.get ${arr2})))
    (local.set ${totalLen} (i32.add (local.get ${len1}) (local.get ${len2})))
    (local.set ${result} (array.new $f64array (f64.const 0) (local.get ${totalLen})))
    ;; Copy first array
    (local.set ${idx} (i32.const 0))
    (block $done1_${id} (loop $loop1_${id}
      (br_if $done1_${id} (i32.ge_s (local.get ${idx}) (local.get ${len1})))
      (array.set $f64array (local.get ${result}) (local.get ${idx})
        (array.get $f64array (local.get ${arr1}) (local.get ${idx})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop1_${id})))
    ;; Copy second array
    (local.set ${idx} (i32.const 0))
    (block $done2_${id} (loop $loop2_${id}
      (br_if $done2_${id} (i32.ge_s (local.get ${idx}) (local.get ${len2})))
      (array.set $f64array (local.get ${result}) (i32.add (local.get ${len1}) (local.get ${idx}))
        (array.get $f64array (local.get ${arr2}) (local.get ${idx})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop2_${id})))
    (local.get ${result})`)
        } else {
          ctx.usedMemory = true
          return tv('array', `(local.set ${arr1} ${rw})
    (local.set ${arr2} ${arg2[1]})
    (local.set ${len1} (call $__ptr_len (local.get ${arr1})))
    (local.set ${len2} (call $__ptr_len (local.get ${arr2})))
    (local.set ${totalLen} (i32.add (local.get ${len1}) (local.get ${len2})))
    (local.set ${result} (call $__alloc (i32.const ${PTR_TYPE.F64_ARRAY}) (local.get ${totalLen})))
    ;; Copy first array
    (local.set ${idx} (i32.const 0))
    (block $done1_${id} (loop $loop1_${id}
      (br_if $done1_${id} (i32.ge_s (local.get ${idx}) (local.get ${len1})))
      (f64.store (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (local.get ${idx}) (i32.const 3)))
        (f64.load (i32.add (call $__ptr_offset (local.get ${arr1})) (i32.shl (local.get ${idx}) (i32.const 3)))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop1_${id})))
    ;; Copy second array
    (local.set ${idx} (i32.const 0))
    (block $done2_${id} (loop $loop2_${id}
      (br_if $done2_${id} (i32.ge_s (local.get ${idx}) (local.get ${len2})))
      (f64.store (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (i32.add (local.get ${len1}) (local.get ${idx})) (i32.const 3)))
        (f64.load (i32.add (call $__ptr_offset (local.get ${arr2})) (i32.shl (local.get ${idx}) (i32.const 3)))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop2_${id})))
    (local.get ${result})`)
        }
      }
      // Array.join
      if (name === 'join' && args.length >= 0) {
        // For now, return a simple approximation - the array length as a number
        // Full implementation would require string concatenation infrastructure
        ctx.usedArrayType = true
        const len = opts.gc ? `(array.len ${rw})` : `(call $__ptr_len ${rw})`
        return tv('i32', len)
      }
    }
    // String methods
    if (rt === 'string') {
      // String.length is handled via '.' operator
      // String.slice
      if (name === 'slice' && args.length >= 0) {
        ctx.usedStringType = true
        const id = ctx.loopCounter++
        const str = `$_sslice_str_${id}`, idx = `$_sslice_i_${id}`, len = `$_sslice_len_${id}`, result = `$_sslice_result_${id}`, start = `$_sslice_start_${id}`, end = `$_sslice_end_${id}`, newLen = `$_sslice_newlen_${id}`
        ctx.addLocal(str.slice(1), 'string')
        ctx.addLocal(idx.slice(1), 'i32')
        ctx.addLocal(len.slice(1), 'i32')
        ctx.addLocal(result.slice(1), 'string')
        ctx.addLocal(start.slice(1), 'i32')
        ctx.addLocal(end.slice(1), 'i32')
        ctx.addLocal(newLen.slice(1), 'i32')
        const startArg = args.length >= 1 ? asI32(gen(args[0]))[1] : '(i32.const 0)'
        if (opts.gc) {
          const endArg = args.length >= 2 ? asI32(gen(args[1]))[1] : `(array.len (local.get ${str}))`
          return tv('string', `(local.set ${str} ${rw})
    (local.set ${len} (array.len (local.get ${str})))
    (local.set ${start} ${startArg})
    (local.set ${end} ${endArg})
    (if (i32.lt_s (local.get ${start}) (i32.const 0))
      (then (local.set ${start} (i32.add (local.get ${len}) (local.get ${start})))))
    (if (i32.lt_s (local.get ${end}) (i32.const 0))
      (then (local.set ${end} (i32.add (local.get ${len}) (local.get ${end})))))
    (if (i32.lt_s (local.get ${start}) (i32.const 0)) (then (local.set ${start} (i32.const 0))))
    (if (i32.gt_s (local.get ${end}) (local.get ${len})) (then (local.set ${end} (local.get ${len}))))
    (local.set ${newLen} (i32.sub (local.get ${end}) (local.get ${start})))
    (if (i32.lt_s (local.get ${newLen}) (i32.const 0)) (then (local.set ${newLen} (i32.const 0))))
    (local.set ${result} (array.new $string (i32.const 0) (local.get ${newLen})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${newLen})))
      (array.set $string (local.get ${result}) (local.get ${idx})
        (array.get_u $string (local.get ${str}) (i32.add (local.get ${start}) (local.get ${idx}))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
        } else {
          ctx.usedMemory = true
          const endArg = args.length >= 2 ? asI32(gen(args[1]))[1] : `(call $__ptr_len (local.get ${str}))`
          return tv('string', `(local.set ${str} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${str})))
    (local.set ${start} ${startArg})
    (local.set ${end} ${endArg})
    (if (i32.lt_s (local.get ${start}) (i32.const 0))
      (then (local.set ${start} (i32.add (local.get ${len}) (local.get ${start})))))
    (if (i32.lt_s (local.get ${end}) (i32.const 0))
      (then (local.set ${end} (i32.add (local.get ${len}) (local.get ${end})))))
    (if (i32.lt_s (local.get ${start}) (i32.const 0)) (then (local.set ${start} (i32.const 0))))
    (if (i32.gt_s (local.get ${end}) (local.get ${len})) (then (local.set ${end} (local.get ${len}))))
    (local.set ${newLen} (i32.sub (local.get ${end}) (local.get ${start})))
    (if (i32.lt_s (local.get ${newLen}) (i32.const 0)) (then (local.set ${newLen} (i32.const 0))))
    (local.set ${result} (call $__alloc (i32.const ${PTR_TYPE.STRING}) (local.get ${newLen})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${newLen})))
      (i32.store16 (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (local.get ${idx}) (i32.const 1)))
        (i32.load16_u (i32.add (call $__ptr_offset (local.get ${str})) (i32.shl (i32.add (local.get ${start}) (local.get ${idx})) (i32.const 1)))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
        }
      }
      // String.indexOf
      if (name === 'indexOf' && args.length >= 1) {
        ctx.usedStringType = true
        const searchVal = gen(args[0])
        // For simplicity, only support single char search (number)
        if (searchVal[0] === 'i32' || searchVal[0] === 'f64') {
          const id = ctx.loopCounter++
          const str = `$_sindexof_str_${id}`, idx = `$_sindexof_i_${id}`, len = `$_sindexof_len_${id}`, result = `$_sindexof_result_${id}`, target = `$_sindexof_target_${id}`
          ctx.addLocal(str.slice(1), 'string')
          ctx.addLocal(idx.slice(1), 'i32')
          ctx.addLocal(len.slice(1), 'i32')
          ctx.addLocal(result.slice(1), 'i32')
          ctx.addLocal(target.slice(1), 'i32')
          if (opts.gc) {
            return tv('i32', `(local.set ${str} ${rw})
    (local.set ${target} ${asI32(searchVal)[1]})
    (local.set ${len} (array.len (local.get ${str})))
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const -1))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (if (i32.eq (array.get_u $string (local.get ${str}) (local.get ${idx})) (local.get ${target}))
        (then
          (local.set ${result} (local.get ${idx}))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
          } else {
            ctx.usedMemory = true
            return tv('i32', `(local.set ${str} ${rw})
    (local.set ${target} ${asI32(searchVal)[1]})
    (local.set ${len} (call $__ptr_len (local.get ${str})))
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const -1))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (if (i32.eq (i32.load16_u (i32.add (call $__ptr_offset (local.get ${str})) (i32.shl (local.get ${idx}) (i32.const 1)))) (local.get ${target}))
        (then
          (local.set ${result} (local.get ${idx}))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
          }
        }
      }
      // String.substring (similar to slice)
      if (name === 'substring' && args.length >= 1) {
        ctx.usedStringType = true
        const id = ctx.loopCounter++
        const str = `$_substr_str_${id}`, idx = `$_substr_i_${id}`, len = `$_substr_len_${id}`, result = `$_substr_result_${id}`, start = `$_substr_start_${id}`, end = `$_substr_end_${id}`, newLen = `$_substr_newlen_${id}`
        ctx.addLocal(str.slice(1), 'string')
        ctx.addLocal(idx.slice(1), 'i32')
        ctx.addLocal(len.slice(1), 'i32')
        ctx.addLocal(result.slice(1), 'string')
        ctx.addLocal(start.slice(1), 'i32')
        ctx.addLocal(end.slice(1), 'i32')
        ctx.addLocal(newLen.slice(1), 'i32')
        const startArg = asI32(gen(args[0]))[1]
        if (opts.gc) {
          const endArg = args.length >= 2 ? asI32(gen(args[1]))[1] : `(array.len (local.get ${str}))`
          return tv('string', `(local.set ${str} ${rw})
    (local.set ${len} (array.len (local.get ${str})))
    (local.set ${start} ${startArg})
    (local.set ${end} ${endArg})
    (if (i32.lt_s (local.get ${start}) (i32.const 0)) (then (local.set ${start} (i32.const 0))))
    (if (i32.gt_s (local.get ${start}) (local.get ${len})) (then (local.set ${start} (local.get ${len}))))
    (if (i32.lt_s (local.get ${end}) (i32.const 0)) (then (local.set ${end} (i32.const 0))))
    (if (i32.gt_s (local.get ${end}) (local.get ${len})) (then (local.set ${end} (local.get ${len}))))
    (if (i32.gt_s (local.get ${start}) (local.get ${end}))
      (then
        (local.set ${newLen} (local.get ${start}))
        (local.set ${start} (local.get ${end}))
        (local.set ${end} (local.get ${newLen}))))
    (local.set ${newLen} (i32.sub (local.get ${end}) (local.get ${start})))
    (local.set ${result} (array.new $string (i32.const 0) (local.get ${newLen})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${newLen})))
      (array.set $string (local.get ${result}) (local.get ${idx})
        (array.get_u $string (local.get ${str}) (i32.add (local.get ${start}) (local.get ${idx}))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
        } else {
          ctx.usedMemory = true
          const endArg = args.length >= 2 ? asI32(gen(args[1]))[1] : `(call $__ptr_len (local.get ${str}))`
          return tv('string', `(local.set ${str} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${str})))
    (local.set ${start} ${startArg})
    (local.set ${end} ${endArg})
    (if (i32.lt_s (local.get ${start}) (i32.const 0)) (then (local.set ${start} (i32.const 0))))
    (if (i32.gt_s (local.get ${start}) (local.get ${len})) (then (local.set ${start} (local.get ${len}))))
    (if (i32.lt_s (local.get ${end}) (i32.const 0)) (then (local.set ${end} (i32.const 0))))
    (if (i32.gt_s (local.get ${end}) (local.get ${len})) (then (local.set ${end} (local.get ${len}))))
    (if (i32.gt_s (local.get ${start}) (local.get ${end}))
      (then
        (local.set ${newLen} (local.get ${start}))
        (local.set ${start} (local.get ${end}))
        (local.set ${end} (local.get ${newLen}))))
    (local.set ${newLen} (i32.sub (local.get ${end}) (local.get ${start})))
    (local.set ${result} (call $__alloc (i32.const ${PTR_TYPE.STRING}) (local.get ${newLen})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${newLen})))
      (i32.store16 (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (local.get ${idx}) (i32.const 1)))
        (i32.load16_u (i32.add (call $__ptr_offset (local.get ${str})) (i32.shl (i32.add (local.get ${start}) (local.get ${idx})) (i32.const 1)))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
        }
      }
      // String.toLowerCase
      if (name === 'toLowerCase' && args.length === 0) {
        ctx.usedStringType = true
        const id = ctx.loopCounter++
        const str = `$_tolower_str_${id}`, idx = `$_tolower_i_${id}`, len = `$_tolower_len_${id}`, result = `$_tolower_result_${id}`, ch = `$_tolower_ch_${id}`
        ctx.addLocal(str.slice(1), 'string')
        ctx.addLocal(idx.slice(1), 'i32')
        ctx.addLocal(len.slice(1), 'i32')
        ctx.addLocal(result.slice(1), 'string')
        ctx.addLocal(ch.slice(1), 'i32')
        if (opts.gc) {
          return tv('string', `(local.set ${str} ${rw})
    (local.set ${len} (array.len (local.get ${str})))
    (local.set ${result} (array.new $string (i32.const 0) (local.get ${len})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set ${ch} (array.get_u $string (local.get ${str}) (local.get ${idx})))
      (if (i32.and (i32.ge_s (local.get ${ch}) (i32.const 65)) (i32.le_s (local.get ${ch}) (i32.const 90)))
        (then (local.set ${ch} (i32.add (local.get ${ch}) (i32.const 32)))))
      (array.set $string (local.get ${result}) (local.get ${idx}) (local.get ${ch}))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
        } else {
          ctx.usedMemory = true
          return tv('string', `(local.set ${str} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${str})))
    (local.set ${result} (call $__alloc (i32.const ${PTR_TYPE.STRING}) (local.get ${len})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set ${ch} (i32.load16_u (i32.add (call $__ptr_offset (local.get ${str})) (i32.shl (local.get ${idx}) (i32.const 1)))))
      (if (i32.and (i32.ge_s (local.get ${ch}) (i32.const 65)) (i32.le_s (local.get ${ch}) (i32.const 90)))
        (then (local.set ${ch} (i32.add (local.get ${ch}) (i32.const 32)))))
      (i32.store16 (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (local.get ${idx}) (i32.const 1))) (local.get ${ch}))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
        }
      }
      // String.toUpperCase
      if (name === 'toUpperCase' && args.length === 0) {
        ctx.usedStringType = true
        const id = ctx.loopCounter++
        const str = `$_toupper_str_${id}`, idx = `$_toupper_i_${id}`, len = `$_toupper_len_${id}`, result = `$_toupper_result_${id}`, ch = `$_toupper_ch_${id}`
        ctx.addLocal(str.slice(1), 'string')
        ctx.addLocal(idx.slice(1), 'i32')
        ctx.addLocal(len.slice(1), 'i32')
        ctx.addLocal(result.slice(1), 'string')
        ctx.addLocal(ch.slice(1), 'i32')
        if (opts.gc) {
          return tv('string', `(local.set ${str} ${rw})
    (local.set ${len} (array.len (local.get ${str})))
    (local.set ${result} (array.new $string (i32.const 0) (local.get ${len})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set ${ch} (array.get_u $string (local.get ${str}) (local.get ${idx})))
      (if (i32.and (i32.ge_s (local.get ${ch}) (i32.const 97)) (i32.le_s (local.get ${ch}) (i32.const 122)))
        (then (local.set ${ch} (i32.sub (local.get ${ch}) (i32.const 32)))))
      (array.set $string (local.get ${result}) (local.get ${idx}) (local.get ${ch}))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
        } else {
          ctx.usedMemory = true
          return tv('string', `(local.set ${str} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${str})))
    (local.set ${result} (call $__alloc (i32.const ${PTR_TYPE.STRING}) (local.get ${len})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set ${ch} (i32.load16_u (i32.add (call $__ptr_offset (local.get ${str})) (i32.shl (local.get ${idx}) (i32.const 1)))))
      (if (i32.and (i32.ge_s (local.get ${ch}) (i32.const 97)) (i32.le_s (local.get ${ch}) (i32.const 122)))
        (then (local.set ${ch} (i32.sub (local.get ${ch}) (i32.const 32)))))
      (i32.store16 (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (local.get ${idx}) (i32.const 1))) (local.get ${ch}))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
        }
      }
      // String.includes
      if (name === 'includes' && args.length >= 1) {
        ctx.usedStringType = true
        const searchVal = gen(args[0])
        if (searchVal[0] === 'i32' || searchVal[0] === 'f64') {
          const id = ctx.loopCounter++
          const str = `$_sincludes_str_${id}`, idx = `$_sincludes_i_${id}`, len = `$_sincludes_len_${id}`, target = `$_sincludes_target_${id}`, result = `$_sincludes_result_${id}`
          ctx.addLocal(str.slice(1), 'string')
          ctx.addLocal(idx.slice(1), 'i32')
          ctx.addLocal(len.slice(1), 'i32')
          ctx.addLocal(target.slice(1), 'i32')
          ctx.addLocal(result.slice(1), 'i32')
          if (opts.gc) {
            return tv('i32', `(local.set ${str} ${rw})
    (local.set ${target} ${asI32(searchVal)[1]})
    (local.set ${len} (array.len (local.get ${str})))
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (if (i32.eq (array.get_u $string (local.get ${str}) (local.get ${idx})) (local.get ${target}))
        (then
          (local.set ${result} (i32.const 1))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
          } else {
            ctx.usedMemory = true
            return tv('i32', `(local.set ${str} ${rw})
    (local.set ${target} ${asI32(searchVal)[1]})
    (local.set ${len} (call $__ptr_len (local.get ${str})))
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (if (i32.eq (i32.load16_u (i32.add (call $__ptr_offset (local.get ${str})) (i32.shl (local.get ${idx}) (i32.const 1)))) (local.get ${target}))
        (then
          (local.set ${result} (i32.const 1))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
          }
        }
      }
      // String.startsWith
      if (name === 'startsWith' && args.length >= 1) {
        ctx.usedStringType = true
        const searchVal = gen(args[0])
        if (searchVal[0] === 'i32' || searchVal[0] === 'f64') {
          const id = ctx.loopCounter++
          const str = `$_starts_str_${id}`, ch = `$_starts_ch_${id}`, target = `$_starts_target_${id}`
          ctx.addLocal(str.slice(1), 'string')
          ctx.addLocal(ch.slice(1), 'i32')
          ctx.addLocal(target.slice(1), 'i32')
          if (opts.gc) {
            return tv('i32', `(local.set ${str} ${rw})
    (local.set ${target} ${asI32(searchVal)[1]})
    (local.set ${ch} (if (result i32) (i32.gt_s (array.len (local.get ${str})) (i32.const 0))
      (then (array.get_u $string (local.get ${str}) (i32.const 0)))
      (else (i32.const -1))))
    (i32.eq (local.get ${ch}) (local.get ${target}))`)
          } else {
            ctx.usedMemory = true
            return tv('i32', `(local.set ${str} ${rw})
    (local.set ${target} ${asI32(searchVal)[1]})
    (local.set ${ch} (if (result i32) (i32.gt_s (call $__ptr_len (local.get ${str})) (i32.const 0))
      (then (i32.load16_u (call $__ptr_offset (local.get ${str}))))
      (else (i32.const -1))))
    (i32.eq (local.get ${ch}) (local.get ${target}))`)
          }
        }
      }
      // String.endsWith
      if (name === 'endsWith' && args.length >= 1) {
        ctx.usedStringType = true
        const searchVal = gen(args[0])
        if (searchVal[0] === 'i32' || searchVal[0] === 'f64') {
          const id = ctx.loopCounter++
          const str = `$_ends_str_${id}`, ch = `$_ends_ch_${id}`, target = `$_ends_target_${id}`, len = `$_ends_len_${id}`
          ctx.addLocal(str.slice(1), 'string')
          ctx.addLocal(ch.slice(1), 'i32')
          ctx.addLocal(target.slice(1), 'i32')
          ctx.addLocal(len.slice(1), 'i32')
          if (opts.gc) {
            return tv('i32', `(local.set ${str} ${rw})
    (local.set ${target} ${asI32(searchVal)[1]})
    (local.set ${len} (array.len (local.get ${str})))
    (local.set ${ch} (if (result i32) (i32.gt_s (local.get ${len}) (i32.const 0))
      (then (array.get_u $string (local.get ${str}) (i32.sub (local.get ${len}) (i32.const 1))))
      (else (i32.const -1))))
    (i32.eq (local.get ${ch}) (local.get ${target}))`)
          } else {
            ctx.usedMemory = true
            return tv('i32', `(local.set ${str} ${rw})
    (local.set ${target} ${asI32(searchVal)[1]})
    (local.set ${len} (call $__ptr_len (local.get ${str})))
    (local.set ${ch} (if (result i32) (i32.gt_s (local.get ${len}) (i32.const 0))
      (then (i32.load16_u (i32.add (call $__ptr_offset (local.get ${str})) (i32.shl (i32.sub (local.get ${len}) (i32.const 1)) (i32.const 1)))))
      (else (i32.const -1))))
    (i32.eq (local.get ${ch}) (local.get ${target}))`)
          }
        }
      }
      // String.trim
      if (name === 'trim' && args.length === 0) {
        ctx.usedStringType = true
        const id = ctx.loopCounter++
        const str = `$_trim_str_${id}`, idx = `$_trim_i_${id}`, len = `$_trim_len_${id}`, result = `$_trim_result_${id}`, start = `$_trim_start_${id}`, end = `$_trim_end_${id}`, ch = `$_trim_ch_${id}`, newLen = `$_trim_newlen_${id}`
        ctx.addLocal(str.slice(1), 'string')
        ctx.addLocal(idx.slice(1), 'i32')
        ctx.addLocal(len.slice(1), 'i32')
        ctx.addLocal(result.slice(1), 'string')
        ctx.addLocal(start.slice(1), 'i32')
        ctx.addLocal(end.slice(1), 'i32')
        ctx.addLocal(ch.slice(1), 'i32')
        ctx.addLocal(newLen.slice(1), 'i32')
        if (opts.gc) {
          return tv('string', `(local.set ${str} ${rw})
    (local.set ${len} (array.len (local.get ${str})))
    (local.set ${start} (i32.const 0))
    (local.set ${end} (local.get ${len}))
    ;; Find start
    (block $start_done_${id} (loop $start_loop_${id}
      (br_if $start_done_${id} (i32.ge_s (local.get ${start}) (local.get ${len})))
      (local.set ${ch} (array.get_u $string (local.get ${str}) (local.get ${start})))
      (br_if $start_done_${id} (i32.and (i32.ne (local.get ${ch}) (i32.const 32)) (i32.and (i32.ne (local.get ${ch}) (i32.const 9)) (i32.and (i32.ne (local.get ${ch}) (i32.const 10)) (i32.ne (local.get ${ch}) (i32.const 13))))))
      (local.set ${start} (i32.add (local.get ${start}) (i32.const 1)))
      (br $start_loop_${id})))
    ;; Find end
    (block $end_done_${id} (loop $end_loop_${id}
      (br_if $end_done_${id} (i32.le_s (local.get ${end}) (local.get ${start})))
      (local.set ${ch} (array.get_u $string (local.get ${str}) (i32.sub (local.get ${end}) (i32.const 1))))
      (br_if $end_done_${id} (i32.and (i32.ne (local.get ${ch}) (i32.const 32)) (i32.and (i32.ne (local.get ${ch}) (i32.const 9)) (i32.and (i32.ne (local.get ${ch}) (i32.const 10)) (i32.ne (local.get ${ch}) (i32.const 13))))))
      (local.set ${end} (i32.sub (local.get ${end}) (i32.const 1)))
      (br $end_loop_${id})))
    (local.set ${newLen} (i32.sub (local.get ${end}) (local.get ${start})))
    (local.set ${result} (array.new $string (i32.const 0) (local.get ${newLen})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${newLen})))
      (array.set $string (local.get ${result}) (local.get ${idx})
        (array.get_u $string (local.get ${str}) (i32.add (local.get ${start}) (local.get ${idx}))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
        } else {
          ctx.usedMemory = true
          return tv('string', `(local.set ${str} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${str})))
    (local.set ${start} (i32.const 0))
    (local.set ${end} (local.get ${len}))
    ;; Find start
    (block $start_done_${id} (loop $start_loop_${id}
      (br_if $start_done_${id} (i32.ge_s (local.get ${start}) (local.get ${len})))
      (local.set ${ch} (i32.load16_u (i32.add (call $__ptr_offset (local.get ${str})) (i32.shl (local.get ${start}) (i32.const 1)))))
      (br_if $start_done_${id} (i32.and (i32.ne (local.get ${ch}) (i32.const 32)) (i32.and (i32.ne (local.get ${ch}) (i32.const 9)) (i32.and (i32.ne (local.get ${ch}) (i32.const 10)) (i32.ne (local.get ${ch}) (i32.const 13))))))
      (local.set ${start} (i32.add (local.get ${start}) (i32.const 1)))
      (br $start_loop_${id})))
    ;; Find end
    (block $end_done_${id} (loop $end_loop_${id}
      (br_if $end_done_${id} (i32.le_s (local.get ${end}) (local.get ${start})))
      (local.set ${ch} (i32.load16_u (i32.add (call $__ptr_offset (local.get ${str})) (i32.shl (i32.sub (local.get ${end}) (i32.const 1)) (i32.const 1)))))
      (br_if $end_done_${id} (i32.and (i32.ne (local.get ${ch}) (i32.const 32)) (i32.and (i32.ne (local.get ${ch}) (i32.const 9)) (i32.and (i32.ne (local.get ${ch}) (i32.const 10)) (i32.ne (local.get ${ch}) (i32.const 13))))))
      (local.set ${end} (i32.sub (local.get ${end}) (i32.const 1)))
      (br $end_loop_${id})))
    (local.set ${newLen} (i32.sub (local.get ${end}) (local.get ${start})))
    (local.set ${result} (call $__alloc (i32.const ${PTR_TYPE.STRING}) (local.get ${newLen})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${newLen})))
      (i32.store16 (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (local.get ${idx}) (i32.const 1)))
        (i32.load16_u (i32.add (call $__ptr_offset (local.get ${str})) (i32.shl (i32.add (local.get ${start}) (local.get ${idx})) (i32.const 1)))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
        }
      }
      // String.split - simplified version for single char separator
      if (name === 'split' && args.length >= 1) {
        // For now, return empty array - full implementation needs dynamic array building
        ctx.usedArrayType = true
        if (opts.gc) {
          return tv('array', `(array.new $f64array (f64.const 0) (i32.const 0))`)
        } else {
          ctx.usedMemory = true
          return tv('array', `(call $__alloc (i32.const ${PTR_TYPE.F64_ARRAY}) (i32.const 0))`)
        }
      }
      // String.replace - simplified to replace single char
      if (name === 'replace' && args.length >= 2) {
        // For now, return original string - full implementation needs string building
        return tv('string', rw)
      }
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
      ctx.usedStdlib.add(name)
      return tv('f64', `(call $${name} ${asF64(gen(args[0]))[1]})`)
    }
    if (MATH_OPS.stdlib_binary.includes(name) && args.length === 2) {
      ctx.usedStdlib.add(name)
      return tv('f64', `(call $${name} ${asF64(gen(args[0]))[1]} ${asF64(gen(args[1]))[1]})`)
    }
    if (name === 'random' && args.length === 0) {
      ctx.usedStdlib.add('random')
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
      ctx.usedStdlib.add('isInteger')
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
        return tv('array', `(call $__alloc (i32.const ${PTR_TYPE.F64_ARRAY}) ${asI32(gen(args[0]))[1]})`)
      }
    }
    if (name === 'parseInt') {
      const val = gen(args[0])
      const radix = args.length >= 2 ? asI32(gen(args[1]))[1] : '(i32.const 10)'
      if (val[0] === 'string') {
        ctx.usedStdlib.add('parseInt')
        ctx.usedStringType = true
        return tv('f64', `(call $parseInt ${val[1]} ${radix})`)
      }
      ctx.usedStdlib.add('parseIntFromCode')
      return tv('f64', `(call $parseIntFromCode ${asI32(val)[1]} ${radix})`)
    }
  }

  // User-defined function
  if (namespace === null && ctx.functions.has(name)) {
    const fn = ctx.functions.get(name)
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
    const vals = elements.map(e => asF64(gen(e))[1])
    if (opts.gc) {
      return tv('array', `(array.new_fixed $f64array ${vals.length} ${vals.join(' ')})`)
    } else {
      // gc:false - allocate on heap, return encoded pointer
      ctx.usedMemory = true
      const id = ctx.loopCounter++
      const tmp = `$_arr_${id}`
      ctx.addLocal(tmp.slice(1), 'f64')
      // Build the stores as side effects, then return the pointer
      let stores = ''
      for (let i = 0; i < vals.length; i++) {
        stores += `(f64.store (i32.add (call $__ptr_offset (local.get ${tmp})) (i32.const ${i * 8})) ${vals[i]})\n      `
      }
      // Use block to sequence: alloc, stores, return pointer
      return tv('array', `(block (result f64)
      (local.set ${tmp} (call $__alloc (i32.const ${PTR_TYPE.F64_ARRAY}) (i32.const ${vals.length})))
      ${stores}(local.get ${tmp}))`)
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
    ctx.objectSchemas.set(objId, keys)
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
    if (prop === 'length' && (o[0] === 'array' || o[0] === 'string')) {
      if (opts.gc) {
        if (o[0] === 'array') ctx.usedArrayType = true
        else ctx.usedStringType = true
        return tv('i32', `(array.len ${o[1]})`)
      } else {
        // gc:false - extract length from pointer encoding
        ctx.usedMemory = true
        return tv('i32', `(call $__ptr_len ${o[1]})`)
      }
    }
    if (o[0] === 'object' && o[2] !== undefined) {
      const schema = ctx.objectSchemas.get(o[2])
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
    if ((o[0] === 'array' || o[0] === 'ref') && prop === 'length') {
      if (opts.gc) {
        ctx.usedArrayType = true
        return tv('f64', `(if (result f64) (ref.is_null ${o[1]}) (then (f64.const 0)) (else (f64.convert_i32_s (array.len ${o[1]}))))`)
      } else {
        ctx.usedMemory = true
        return tv('f64', `(if (result f64) (f64.eq ${o[1]} (f64.const 0)) (then (f64.const 0)) (else (f64.convert_i32_s (call $__ptr_len ${o[1]}))))`)
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
    ctx.functions.set(name, { params: extractParams(params), body, exported: true })
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
  '**'([a, b]) { ctx.usedStdlib.add('pow'); return ['f64', `(call $pow ${asF64(gen(a))[1]} ${asF64(gen(b))[1]})`] },

  // Comparisons
  '=='([a, b]) { const va = gen(a), vb = gen(b); return va[0] === 'i32' && vb[0] === 'i32' ? i32.eq(va, vb) : f64.eq(va, vb) },
  '==='([a, b]) { return operators['==']([a, b]) },
  '!='([a, b]) { const va = gen(a), vb = gen(b); return va[0] === 'i32' && vb[0] === 'i32' ? i32.ne(va, vb) : f64.ne(va, vb) },
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
    if (init) {
      if (Array.isArray(init) && init[0] === '=') code += genLoopInit(init[1], init[2])
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

  // Block
  '{}'([body]) {
    if (!Array.isArray(body) || body[0] !== ';') return gen(body)
    return operators[';'](body.slice(1))
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

  // typeof and void
  'typeof'([a]) {
    // In WASM context, typeof returns type strings as encoded numbers
    // 0: undefined, 1: number, 2: string, 3: boolean, 4: object, 5: function
    const val = gen(a)
    if (val[0] === 'f64') return tv('i32', '(i32.const 1)')  // number
    if (val[0] === 'i32') return tv('i32', '(i32.const 3)')  // boolean
    if (val[0] === 'string') return tv('i32', '(i32.const 2)')  // string
    if (val[0] === 'ref') return tv('i32', '(i32.const 0)')  // undefined (null ref)
    if (val[0] === 'array' || val[0] === 'object') return tv('i32', '(i32.const 4)')  // object
    return tv('i32', '(i32.const 1)')  // default to number
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
  // Function definition
  if (Array.isArray(value) && value[0] === '=>') {
    if (typeof target !== 'string') throw new Error('Function must have name')
    ctx.functions.set(target, { params: extractParams(value[1]), body: value[2], exported: true })
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
    const schema = ctx.objectSchemas.get(obj[2])
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

  // Global constant optimization (only at top level)
  if (typeof target === 'string' && !ctx.inFunction && !returnValue) {
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
  const glob = ctx.getGlobal(target)
  if (glob) {
    const code = `(global.set $${target} ${asF64(val)[1]})`
    return returnValue ? tv(val[0], `${code} (global.get $${target})`) : code + '\n    '
  }
  ctx.addLocal(target, val[0], val[2])
  return returnValue
    ? tv(val[0], `(local.tee $${target} ${val[1]})`, val[2])
    : `(local.set $${target} ${val[1]})\n    `
}

function genLoopInit(target, value) {
  if (typeof target !== 'string') throw new Error('Loop init must assign to variable')
  const [t, w] = gen(value)
  const glob = ctx.getGlobal(target)
  if (glob) return `(global.set $${target} ${asF64([t, w])[1]})\n    `
  const loc = ctx.getLocal(target)
  if (loc) return `(local.set $${target} ${asF64([t, w])[1]})\n    `
  ctx.addLocal(target, t)
  return `(local.set $${target} ${asF64([t, w])[1]})\n    `
}

function extractParams(rawParams) {
  if (rawParams == null) return []
  if (typeof rawParams === 'string') return [rawParams]
  if (Array.isArray(rawParams)) {
    if (rawParams[0] === '()' && rawParams.length === 2) return extractParams(rawParams[1])
    if (rawParams[0] === ',') return rawParams.slice(1).flatMap(extractParams)
  }
  return []
}

function generateFunction(name, params, bodyAst, parentCtx) {
  const prevCtx = ctx
  ctx = createContext()
  ctx.usedStdlib = parentCtx.usedStdlib
  ctx.usedArrayType = parentCtx.usedArrayType
  ctx.usedStringType = parentCtx.usedStringType
  ctx.functions = parentCtx.functions
  ctx.globals = parentCtx.globals
  ctx.inFunction = true
  ctx.returnLabel = '$return_' + name

  for (const p of params) ctx.locals.set(p, { idx: ctx.localCounter++, type: 'f64' })
  const [, bodyWat] = asF64(gen(bodyAst))
  const paramDecls = params.map(p => `(param $${p} f64)`).join(' ')
  const localDecls = ctx.localDecls.length ? `\n    ${ctx.localDecls.join(' ')}` : ''
  // Wrap body in block to support early return
  const wat = `(func $${name} (export "${name}") ${paramDecls} (result f64)${localDecls}\n    (block ${ctx.returnLabel} (result f64)\n      ${bodyWat}\n    )\n  )`
  ctx = prevCtx
  return wat
}

function generateFunctions() {
  return [...ctx.functions].map(([name, def]) => generateFunction(name, def.params, def.body, ctx))
}

// Module assembly
function assemble(bodyWat, ctx, extraFunctions = []) {
  let wat = '(module\n'

  // GC types (only in gc:true mode)
  if (opts.gc) {
    if (ctx.usedArrayType) wat += '  (type $f64array (array (mut f64)))\n'
    if (ctx.usedStringType) wat += '  (type $string (array (mut i16)))\n'
  }

  // Memory (required for gc:false mode)
  if (ctx.usedMemory || !opts.gc) {
    wat += '  (memory (export "memory") 1)\n'
    // Heap pointer global - starts after static data
    const heapStart = ctx.staticOffset || 1024  // Reserve 1KB for static data by default
    wat += `  (global $__heap (mut i32) (i32.const ${heapStart}))\n`
  }

  // String data segments
  for (const [, info] of ctx.strings) {
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

  // Memory helper functions for gc:false mode
  if (ctx.usedMemory && !opts.gc) {
    wat += `
  ;; Pointer encoding: [type:4][length:28][offset:32] in i64, reinterpreted as f64
  ;; Allocate memory and return encoded pointer
  (func $__alloc (param $type i32) (param $len i32) (result f64)
    (local $offset i32) (local $size i32)
    ;; Calculate size based on type: 0=f64(8), 1=i32(4), 2=i16(2), 3=i8(1), 4=object(8)
    (local.set $size
      (i32.shl (local.get $len)
        (select (select (select
          (i32.const 3)  ;; f64/object: *8
          (i32.const 2)  ;; i32: *4
          (i32.lt_u (local.get $type) (i32.const 2)))
          (i32.const 1)  ;; i16: *2
          (i32.lt_u (local.get $type) (i32.const 3)))
          (i32.const 0)  ;; i8: *1
          (i32.lt_u (local.get $type) (i32.const 4)))))
    ;; 8-byte align the size
    (local.set $size (i32.and (i32.add (local.get $size) (i32.const 7)) (i32.const -8)))
    (local.set $offset (global.get $__heap))
    (global.set $__heap (i32.add (global.get $__heap) (local.get $size)))
    (call $__mkptr (local.get $type) (local.get $len) (local.get $offset)))

  ;; Create encoded pointer from type, length, offset
  (func $__mkptr (param $type i32) (param $len i32) (param $offset i32) (result f64)
    (f64.reinterpret_i64
      (i64.or
        (i64.or
          (i64.shl (i64.extend_i32_u (local.get $type)) (i64.const 60))
          (i64.shl (i64.extend_i32_u (local.get $len)) (i64.const 32)))
        (i64.extend_i32_u (local.get $offset)))))

  ;; Extract offset from encoded pointer
  (func $__ptr_offset (param $ptr f64) (result i32)
    (i32.wrap_i64 (i64.reinterpret_f64 (local.get $ptr))))

  ;; Extract length from encoded pointer
  (func $__ptr_len (param $ptr f64) (result i32)
    (i32.and
      (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $ptr)) (i64.const 32)))
      (i32.const 0x0FFFFFFF)))

  ;; Extract type from encoded pointer
  (func $__ptr_type (param $ptr f64) (result i32)
    (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $ptr)) (i64.const 60))))
`
  }

  const included = new Set()
  function include(name) {
    if (included.has(name)) return
    included.add(name)
    for (const dep of DEPS[name] || []) include(dep)
    if (FUNCTIONS[name]) wat += `  ${FUNCTIONS[name]}\n`
  }
  if (ctx.usedStdlib.size > 0) {
    wat += CONSTANTS
    for (const name of ctx.usedStdlib) include(name)
  }

  for (const [name, g] of ctx.globals) wat += `  (global $${name} (mut f64) ${g.init})\n`

  wat += `  (func $die (result f64) (unreachable))\n`
  wat += `  (func $f64.rem (param f64 f64) (result f64)\n    (f64.sub (local.get 0) (f64.mul (f64.trunc (f64.div (local.get 0) (local.get 1))) (local.get 1))))\n`

  for (const fn of extraFunctions) wat += `  ${fn}\n`

  const hasMainBody = bodyWat && bodyWat.trim() && bodyWat.trim() !== '(f64.const 0)'
  if (hasMainBody || extraFunctions.length === 0) {
    const locals = ctx.localDecls.length ? `\n    ${ctx.localDecls.join(' ')}` : ''
    wat += `\n  (func $main (export "main") (param $t f64) (result f64)${locals}\n    ${bodyWat}\n  )`
  }

  return wat + '\n)'
}
