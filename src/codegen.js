// AST to WAT code generation
// AST format: [op, ...args] | [, literal] | string (identifier)
import { tv, asF64, asI32, truthy, conciliate, fmtNum, f64, i32 } from './build.js'

// --- Constants ---
const CONSTANTS = { PI: Math.PI, E: Math.E, Infinity: Infinity, NaN: NaN }

// --- Native WASM operations ---
const NATIVE_F64_UNARY = {
  sqrt: 'f64.sqrt', abs: 'f64.abs', floor: 'f64.floor',
  ceil: 'f64.ceil', trunc: 'f64.trunc', nearest: 'f64.nearest',
  neg: 'f64.neg', int: 'f64.trunc',
}
const NATIVE_I32_UNARY = { clz32: 'i32.clz', ctz32: 'i32.ctz', popcnt32: 'i32.popcnt' }
const NATIVE_I32_BINARY = { rotl: 'i32.rotl', rotr: 'i32.rotr', idiv: 'i32.div_s', irem: 'i32.rem_s' }
const NATIVE_F64_BINARY = { min: 'f64.min', max: 'f64.max', copysign: 'f64.copysign' }

// --- Imported math ---
const IMPORTED_NULLARY = ['random']
const IMPORTED_UNARY = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'exp', 'expm1', 'log', 'log2', 'log10', 'log1p', 'cbrt', 'sign', 'round', 'fract', 'fround']
const IMPORTED_BINARY = ['pow', 'atan2', 'hypot']

// --- Codegen context ---
class Context {
  constructor() {
    this.locals = new Map()
    this.localDecls = []
    this.globals = new Map()  // Module-level bindings: name -> { type, init }
    this.usedImports = new Set()
    this.usedArrayType = false
    this.usedNullRef = false
    this.usedStringType = false
    this.localCounter = 0
    this.structTypes = new Map()
    this.structCounter = 0
    // Function definitions: name -> { params, body, exported }
    this.functions = new Map()
    this.inFunction = false  // Whether we're generating inside a function body
  }

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
  }

  getLocal(name) { return this.locals.get(name) }

  addGlobal(name, type = 'f64', init = '(f64.const 0)') {
    if (!this.globals.has(name)) {
      this.globals.set(name, { type, init })
    }
    return this.globals.get(name)
  }

  getGlobal(name) { return this.globals.get(name) }

  getStructType(fields) {
    const sorted = [...fields].sort()
    const key = sorted.join(',')
    if (!this.structTypes.has(key)) {
      this.structTypes.set(key, { fields: sorted, typeName: `struct${this.structCounter++}` })
    }
    return this.structTypes.get(key)
  }
}

let ctx = null

// --- Public API ---
export function generate(ast) {
  ctx = new Context()
  const result = asF64(gen(ast)).wat
  return { wat: result, ctx }
}

export function generateExpression(ast) {
  ctx = new Context()
  return asF64(gen(ast)).wat
}

export function getContext() { return ctx }
export const generateImports = () => ''
export const generateLocals = () => ctx?.localDecls.join(' ') || ''
export const needsArrayType = () => ctx?.usedArrayType || false
export const needsStringType = () => ctx?.usedStringType || false
export const needsNullRef = () => ctx?.usedNullRef || false
export const getStructTypes = () => ctx?.structTypes || new Map()
export const generateStdLib = () => ''

// --- Core generator ---
function gen(ast) {
  // Literal: [, value]
  if (Array.isArray(ast) && ast[0] === undefined) return genLiteral(ast[1])

  // Identifier
  if (typeof ast === 'string') return genIdent(ast)

  // Operator
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
    const bytes = [...v].map(c => `(i32.const ${c.charCodeAt(0)})`).join(' ')
    return tv('string', `(array.new_fixed $string ${v.length} ${bytes})`)
  }
  throw new Error(`Unsupported literal: ${JSON.stringify(v)}`)
}

// --- Identifiers ---
function genIdent(name) {
  if (name === 't') return tv('f64', '(local.get $t)')
  if (name === 'die') return tv('f64', '(call $die)')
  if (name in CONSTANTS) return tv('f64', `(f64.const ${fmtNum(CONSTANTS[name])})`)
  // Check local first
  const loc = ctx.getLocal(name)
  if (loc) return tv(loc.type, `(local.get $${name})`)
  // Check global (for module-level bindings)
  const glob = ctx.getGlobal(name)
  if (glob) return tv(glob.type, `(global.get $${name})`)
  throw new Error(`Unknown identifier: ${name}`)
}

// --- Operators (object dispatch) ---
const operators = {
  // Function call
  '()'([fn, ...args]) {
    // Extract function name - handles Math.fn, simple fn
    let name = null
    if (typeof fn === 'string') {
      name = fn
    } else if (Array.isArray(fn) && fn[0] === '.' && fn[1] === 'Math' && typeof fn[2] === 'string') {
      name = fn[2]  // Math.sqrt -> sqrt
    }
    if (!name) throw new Error(`Invalid call: ${JSON.stringify(fn)}`)
    if (name === 'die') return tv('f64', '(call $die)')

    // Native f64 unary
    if (name in NATIVE_F64_UNARY && args.length === 1)
      return tv('f64', `(${NATIVE_F64_UNARY[name]} ${asF64(gen(args[0])).wat})`)
    // Native i32 unary
    if (name in NATIVE_I32_UNARY && args.length === 1)
      return tv('i32', `(${NATIVE_I32_UNARY[name]} ${asI32(gen(args[0])).wat})`)
    // Native i32 binary
    if (name in NATIVE_I32_BINARY && args.length === 2)
      return tv('i32', `(${NATIVE_I32_BINARY[name]} ${asI32(gen(args[0])).wat} ${asI32(gen(args[1])).wat})`)
    // Native f64 binary
    if (name in NATIVE_F64_BINARY && args.length === 2)
      return tv('f64', `(${NATIVE_F64_BINARY[name]} ${asF64(gen(args[0])).wat} ${asF64(gen(args[1])).wat})`)
    // Variadic min/max
    if (name in NATIVE_F64_BINARY && args.length > 2) {
      let result = asF64(gen(args[0])).wat
      for (let i = 1; i < args.length; i++)
        result = `(${NATIVE_F64_BINARY[name]} ${result} ${asF64(gen(args[i])).wat})`
      return tv('f64', result)
    }
    // isNaN
    if (name === 'isNaN' && args.length === 1) {
      const v = asF64(gen(args[0])).wat
      return tv('i32', `(f64.ne ${v} ${v})`)
    }
    // isFinite
    if (name === 'isFinite' && args.length === 1) {
      const v = asF64(gen(args[0])).wat
      return tv('i32', `(i32.and (f64.eq ${v} ${v}) (f64.ne (f64.abs ${v}) (f64.const inf)))`)
    }
    // Imported
    if (IMPORTED_NULLARY.includes(name) && args.length === 0) {
      ctx.usedImports.add(name)
      return tv('f64', `(call $${name})`)
    }
    if (IMPORTED_UNARY.includes(name) && args.length === 1) {
      ctx.usedImports.add(name)
      return tv('f64', `(call $${name} ${asF64(gen(args[0])).wat})`)
    }
    if (IMPORTED_BINARY.includes(name) && args.length === 2) {
      ctx.usedImports.add(name)
      return tv('f64', `(call $${name} ${asF64(gen(args[0])).wat} ${asF64(gen(args[1])).wat})`)
    }
    // User-defined function call
    if (ctx.functions.has(name)) {
      const fn = ctx.functions.get(name)
      if (args.length !== fn.params.length)
        throw new Error(`${name} expects ${fn.params.length} args, got ${args.length}`)
      const argWats = args.map(a => asF64(gen(a)).wat).join(' ')
      return tv('f64', `(call $${name} ${argWats})`)
    }
    throw new Error(`Unknown function: ${name}`)
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
        return tv('i32', `(if (result i32) (ref.is_null ${a.wat}) (then (i32.const 0)) (else (array.get_s $string ${a.wat} ${i.wat})))`)
      }
      ctx.usedArrayType = true
      return tv('f64', `(if (result f64) (ref.is_null ${a.wat}) (then (f64.const 0)) (else (array.get $f64array ${a.wat} ${i.wat})))`)
    }
    const a = gen(arr), i = asI32(gen(idx))
    if (a.t === 'string') {
      ctx.usedStringType = true
      return tv('i32', `(array.get_s $string ${a.wat} ${i.wat})`)
    }
    ctx.usedArrayType = true
    return tv('f64', `(array.get $f64array ${a.wat} ${i.wat})`)
  },

  // Property access
  '.'([obj, prop]) {
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

      // Extract params
      const params = extractParams(rawParams)

      // Register function for later generation
      ctx.functions.set(name, { params, body, exported: true })

      // Return a reference (for now, return 0 as placeholder)
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
  '**'([a, b]) { ctx.usedImports.add('pow'); return tv('f64', `(call $pow ${asF64(gen(a)).wat} ${asF64(gen(b)).wat})`) },

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

// --- Helper: assignment as side effect (in comma expr) ---
function genAssignmentSideEffect(target, value) {
  // Arrow function assignment - register function, emit nothing
  if (Array.isArray(value) && value[0] === '=>') {
    const [, rawParams, body] = value
    const name = typeof target === 'string' ? target : null
    if (!name) throw new Error('Function must be assigned to a variable')
    const params = extractParams(rawParams)
    ctx.functions.set(name, { params, body, exported: true })
    return ''  // No runtime code - function is compiled separately
  }

  // Simple variable with literal number or constant → create global (accessible in functions)
  if (typeof target === 'string' && !ctx.inFunction) {
    // Check if value is a simple numeric literal
    if (Array.isArray(value) && value[0] === undefined && typeof value[1] === 'number') {
      ctx.addGlobal(target, 'f64', `(f64.const ${fmtNum(value[1])})`)
      return ''  // No runtime init needed
    }
    // Check if value is a constant identifier
    if (typeof value === 'string' && value in CONSTANTS) {
      ctx.addGlobal(target, 'f64', `(f64.const ${fmtNum(CONSTANTS[value])})`)
      return ''
    }
    // Everything else (arrays, objects, expressions) → fall through to local
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
    ctx.addLocal(target, val.t)
    return `(local.set $${target} ${val.wat})\n    `
  }
  throw new Error('Invalid assignment target')
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
  // No params: null, undefined, or literal [, 0] from normalize
  if (rawParams == null) return []
  if (Array.isArray(rawParams) && rawParams[0] === undefined) return []  // literal [, x] → no params

  // Single param: just a string
  if (typeof rawParams === 'string') return [rawParams]

  // Multiple params directly: [',', 'a', 'b']
  if (Array.isArray(rawParams) && rawParams[0] === ',') {
    return rawParams.slice(1).filter(p => typeof p === 'string')
  }

  // Grouped: ['()', ...]
  if (Array.isArray(rawParams) && rawParams[0] === '()') {
    const inner = rawParams[1]
    if (inner == null) return []
    // Literal [, x] inside () → no params
    if (Array.isArray(inner) && inner[0] === undefined) return []
    if (typeof inner === 'string') return [inner]
    // Multiple params: ['()', [',', 'a', 'b']]
    if (Array.isArray(inner) && inner[0] === ',') {
      return inner.slice(1).filter(p => typeof p === 'string')
    }
  }

  throw new Error(`Invalid params: ${JSON.stringify(rawParams)}`)
}

// --- Generate function code ---
export function generateFunction(name, params, bodyAst, parentCtx) {
  // Create a fresh context for this function
  const prevCtx = ctx
  ctx = new Context()

  // Copy over shared state but not locals
  ctx.usedImports = parentCtx.usedImports
  ctx.usedArrayType = parentCtx.usedArrayType
  ctx.usedStringType = parentCtx.usedStringType
  ctx.structTypes = parentCtx.structTypes
  ctx.functions = parentCtx.functions  // Share functions for cross-calls
  ctx.globals = parentCtx.globals      // Share globals for module-level bindings
  ctx.inFunction = true                // Mark we're inside a function

  // Add params as locals (they become the first locals)
  for (const p of params) {
    ctx.locals.set(p, { idx: ctx.localCounter++, type: 'f64' })
  }

  // Generate body
  const body = asF64(gen(bodyAst))

  // Build function WAT
  const paramDecls = params.map(p => `(param $${p} f64)`).join(' ')
  const localDecls = ctx.localDecls.length ? `\n    ${ctx.localDecls.join(' ')}` : ''

  const wat = `(func $${name} (export "${name}") ${paramDecls} (result f64)${localDecls}
    ${body.wat}
  )`

  // Restore context
  ctx = prevCtx

  return wat
}

// --- Generate all registered functions ---
export function generateFunctions() {
  const fns = []
  for (const [name, def] of ctx.functions) {
    fns.push(generateFunction(name, def.params, def.body, ctx))
  }
  return fns
}
