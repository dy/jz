// Typed codegen for floatbeat/bytebeat
// AST format: [op, ...args] where [, value] is literal, string is identifier
// Features:
//   - t parameter (sample counter)
//   - Constants: PI, E, Infinity, NaN
//   - null/undefined via WASM GC ref.null
//   - Native WASM math: sqrt, abs, floor, ceil, min, max, trunc, copysign, nearest
//   - Imported math: sin, cos, tan, asin, acos, atan, sinh, cosh, tanh, exp, log, log2, log10, pow, cbrt, sign, random
//   - Variables via comma expressions: (a = 1, b = 2, a + b)
//   - WASM GC arrays: [1,2,3] and arr[i]

const tv = (t, wat) => ({ t, wat })

// --- Coercions ---
const asF64 = v => v.t === 'f64' ? v : v.t === 'ref' ? tv('f64', '(f64.const 0)') : tv('f64', `(f64.convert_i32_s ${v.wat})`)
const asI32 = v => v.t === 'i32' ? v : v.t === 'ref' ? tv('i32', '(i32.const 0)') : tv('i32', `(i32.trunc_f64_s ${v.wat})`)
const truthy = v =>
  v.t === 'ref' ? tv('i32', `(i32.eqz (ref.is_null ${v.wat}))`) :
  v.t === 'i32' ? tv('i32', `(i32.ne ${v.wat} (i32.const 0))`) :
  tv('i32', `(f64.ne ${v.wat} (f64.const 0))`)
const conciliate = (a, b) =>
  a.t === 'i32' && b.t === 'i32' ? [a, b] : [asF64(a), asF64(b)]

// --- Constants ---
const CONSTANTS = { PI: Math.PI, E: Math.E, Infinity: Infinity, NaN: NaN }

// --- Native WASM f64 unary math ---
const NATIVE_UNARY = {
  sqrt: 'f64.sqrt', abs: 'f64.abs', floor: 'f64.floor',
  ceil: 'f64.ceil', trunc: 'f64.trunc', nearest: 'f64.nearest',
  neg: 'f64.neg', int: 'f64.trunc',
}

// --- Native WASM f64 binary math ---
const NATIVE_BINARY = { min: 'f64.min', max: 'f64.max', copysign: 'f64.copysign' }

// --- Imported math functions ---
const IMPORTED_UNARY = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'exp', 'log', 'log2', 'log10', 'cbrt', 'sign', 'round', 'fract']
const IMPORTED_BINARY = ['pow', 'atan2']
const IMPORTED_NULLARY = ['random']

// --- Code generation context ---
class CodegenContext {
  constructor() {
    this.locals = new Map()
    this.localDecls = []
    this.usedImports = new Set()
    this.usedArrayType = false
    this.usedNullRef = false
    this.localCounter = 0
  }
  addLocal(name, type = 'f64') {
    if (!this.locals.has(name)) {
      this.locals.set(name, { idx: this.localCounter++, type })
      this.localDecls.push(`(local $${name} ${type})`)
    }
    return this.locals.get(name)
  }
  getLocal(name) { return this.locals.get(name) }
}

let ctx = null

// --- Public API ---
export function generateExpression(ast) {
  ctx = new CodegenContext()
  return asF64(gen(ast)).wat
}

export function getContext() { return ctx }

export function generateStdLib() {
  if (!ctx) return ''
  return `
  (func $die (result f64) (unreachable))
  (func $f64.rem (param f64 f64) (result f64)
    (f64.sub (local.get 0) (f64.mul (f64.trunc (f64.div (local.get 0) (local.get 1))) (local.get 1))))`
}

export function generateImports() {
  if (!ctx) return ''
  let code = ''
  for (const fn of ctx.usedImports) {
    if (IMPORTED_NULLARY.includes(fn))
      code += `  (import "math" "${fn}" (func $${fn} (result f64)))\n`
    else if (IMPORTED_UNARY.includes(fn))
      code += `  (import "math" "${fn}" (func $${fn} (param f64) (result f64)))\n`
    else if (IMPORTED_BINARY.includes(fn))
      code += `  (import "math" "${fn}" (func $${fn} (param f64 f64) (result f64)))\n`
  }
  return code
}

export function generateLocals() {
  return ctx?.localDecls.join(' ') || ''
}

export function needsArrayType() {
  return ctx?.usedArrayType || false
}

export function needsNullRef() {
  return ctx?.usedNullRef || false
}

// --- Internal typed generator ---
// AST: [op, ...args] | [, literal] | string (identifier)
function gen(ast) {
  // Literal: [, value]
  if (Array.isArray(ast) && ast.length >= 1 && ast[0] === undefined) {
    const v = ast[1]
    if (v === null || v === undefined) {
      ctx.usedNullRef = true
      return tv('ref', '(ref.null none)')
    }
    if (typeof v === 'number') return tv('f64', `(f64.const ${fmtNum(v)})`)
    if (typeof v === 'boolean') return tv('i32', `(i32.const ${v ? 1 : 0})`)
    throw new Error(`Unsupported literal: ${JSON.stringify(v)}`)
  }

  // Identifier: string
  if (typeof ast === 'string') {
    if (ast === 't') return tv('f64', '(local.get $t)')
    if (ast === 'die') return tv('f64', '(call $die)')
    if (ast in CONSTANTS) return tv('f64', `(f64.const ${fmtNum(CONSTANTS[ast])})`)
    const local = ctx.getLocal(ast)
    if (local) return tv(local.type, `(local.get $${ast})`)
    throw new Error(`Unknown identifier: ${ast}`)
  }

  // Operator/call: [op, ...args]
  if (!Array.isArray(ast)) throw new Error(`Unsupported AST: ${JSON.stringify(ast)}`)

  const [op, ...args] = ast

  // Function call: ['()', fn, ...args]
  if (op === '()') return genCall(args[0], args.slice(1))

  // Array literal: ['[', ...elements]
  if (op === '[') return genArrayLiteral(args)

  // Array index: ['[]', arr, idx]
  if (op === '[]') return genArrayIndex(args[0], args[1])

  // Operators
  return genOp(op, args)
}

function genCall(fn, args) {
  const fnName = typeof fn === 'string' ? fn : null
  if (!fnName) throw new Error(`Unsupported call: ${JSON.stringify(fn)}`)

  if (fnName === 'die') return tv('f64', '(call $die)')

  if (fnName in NATIVE_UNARY && args.length === 1)
    return tv('f64', `(${NATIVE_UNARY[fnName]} ${asF64(gen(args[0])).wat})`)
  if (fnName in NATIVE_BINARY && args.length === 2)
    return tv('f64', `(${NATIVE_BINARY[fnName]} ${asF64(gen(args[0])).wat} ${asF64(gen(args[1])).wat})`)
  // Variadic min/max: chain binary operations
  if (fnName in NATIVE_BINARY && args.length > 2) {
    const instr = NATIVE_BINARY[fnName]
    let result = asF64(gen(args[0])).wat
    for (let i = 1; i < args.length; i++) {
      result = `(${instr} ${result} ${asF64(gen(args[i])).wat})`
    }
    return tv('f64', result)
  }
  if (IMPORTED_NULLARY.includes(fnName) && args.length === 0) {
    ctx.usedImports.add(fnName)
    return tv('f64', `(call $${fnName})`)
  }
  if (IMPORTED_UNARY.includes(fnName) && args.length === 1) {
    ctx.usedImports.add(fnName)
    return tv('f64', `(call $${fnName} ${asF64(gen(args[0])).wat})`)
  }
  if (IMPORTED_BINARY.includes(fnName) && args.length === 2) {
    ctx.usedImports.add(fnName)
    return tv('f64', `(call $${fnName} ${asF64(gen(args[0])).wat} ${asF64(gen(args[1])).wat})`)
  }
  throw new Error(`Unsupported function call: ${fnName}`)
}

function genOp(op, args) {
  const n = args.length

  // Comma expression - for variable binding
  if (op === ',') {
    let code = ''
    for (let i = 0; i < n - 1; i++) {
      const arg = args[i]
      // Check for assignment: ['=', name, value]
      if (Array.isArray(arg) && arg[0] === '=') {
        const name = arg[1]
        if (typeof name !== 'string') throw new Error('Assignment target must be identifier')
        const val = gen(arg[2])
        ctx.addLocal(name, val.t)
        code += `(local.set $${name} ${val.wat})\n    `
      } else {
        code += `(drop ${gen(arg).wat})\n    `
      }
    }
    const last = gen(args[n - 1])
    return tv(last.t, code + last.wat)
  }

  // Ternary: ['?', cond, then, else]
  if (op === '?') {
    const c = truthy(gen(args[0])).wat
    const [t, f] = conciliate(gen(args[1]), gen(args[2]))
    return tv(t.t, `(if (result ${t.t}) ${c} (then ${t.wat}) (else ${f.wat}))`)
  }

  // Unary
  if (n === 1) {
    const a = gen(args[0])
    switch (op) {
      case 'u+': return asF64(a)
      case 'u-': return a.t === 'i32'
        ? tv('i32', `(i32.sub (i32.const 0) ${a.wat})`)
        : tv('f64', `(f64.neg ${a.wat})`)
      case '!': return tv('i32', `(i32.eqz ${truthy(a).wat})`)
      case '~': return tv('i32', `(i32.xor ${asI32(a).wat} (i32.const -1))`)
    }
    throw new Error(`Unsupported unary: ${op}`)
  }

  // Binary
  if (n === 2) {
    if (op === '&&') return genAnd(args[0], args[1])
    if (op === '||') return genOr(args[0], args[1])

    // Assignment: ['=', name, value]
    if (op === '=') {
      const name = args[0]
      if (typeof name !== 'string') throw new Error('Assignment target must be identifier')
      const val = gen(args[1])
      ctx.addLocal(name, val.t)
      return tv(val.t, `(local.tee $${name} ${val.wat})`)
    }

    const a = gen(args[0]), b = gen(args[1])

    // Arithmetic
    if ('+-*'.includes(op)) {
      if (a.t === 'i32' && b.t === 'i32') {
        const inst = op === '+' ? 'add' : op === '-' ? 'sub' : 'mul'
        return tv('i32', `(i32.${inst} ${a.wat} ${b.wat})`)
      }
      const inst = op === '+' ? 'add' : op === '-' ? 'sub' : 'mul'
      return tv('f64', `(f64.${inst} ${asF64(a).wat} ${asF64(b).wat})`)
    }

    if (op === '/') return tv('f64', `(f64.div ${asF64(a).wat} ${asF64(b).wat})`)
    if (op === '%') return tv('f64', `(call $f64.rem ${asF64(a).wat} ${asF64(b).wat})`)
    if (op === '**') {
      ctx.usedImports.add('pow')
      return tv('f64', `(call $pow ${asF64(a).wat} ${asF64(b).wat})`)
    }

    // Comparisons
    const cmpOps = { '==': 'eq', '===': 'eq', '!=': 'ne', '!==': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' }
    if (op in cmpOps) {
      if (a.t === 'i32' && b.t === 'i32') {
        const inst = cmpOps[op] === 'eq' || cmpOps[op] === 'ne' ? cmpOps[op] : cmpOps[op] + '_s'
        return tv('i32', `(i32.${inst} ${a.wat} ${b.wat})`)
      }
      return tv('i32', `(f64.${cmpOps[op]} ${asF64(a).wat} ${asF64(b).wat})`)
    }

    // Bitwise
    const bitOps = { '&': 'and', '|': 'or', '^': 'xor' }
    if (op in bitOps) return tv('i32', `(i32.${bitOps[op]} ${asI32(a).wat} ${asI32(b).wat})`)

    // Shifts
    if (op === '<<' || op === '>>' || op === '>>>') {
      const ai = asI32(a).wat, bi = `(i32.and ${asI32(b).wat} (i32.const 31))`
      const inst = op === '<<' ? 'shl' : op === '>>' ? 'shr_s' : 'shr_u'
      return tv('i32', `(i32.${inst} ${ai} ${bi})`)
    }

    // Nullish coalesce - only null/undefined trigger fallback
    if (op === '??') {
      if (a.t === 'ref') {
        // null ?? b → b (ref.null is always "nullish")
        return gen(args[1])
      }
      // Non-ref types (i32, f64) are never nullish, return left value
      return a
    }

    throw new Error(`Unsupported binary: ${op}`)
  }

  throw new Error(`Unsupported operator arity: ${op}(${n})`)
}

// WASM GC array literal
function genArrayLiteral(elements) {
  ctx.usedArrayType = true
  const values = elements.map(e => asF64(gen(e)).wat)
  return tv('array', `(array.new_fixed $f64array ${values.length} ${values.join(' ')})`)
}

// WASM GC array index
function genArrayIndex(arr, idx) {
  ctx.usedArrayType = true
  const arrVal = gen(arr)
  const idxVal = asI32(gen(idx))
  return tv('f64', `(array.get $f64array ${arrVal.wat} ${idxVal.wat})`)
}

function genAnd(aAst, bAst) {
  const a = gen(aAst), b = gen(bAst)
  const cond = truthy(a).wat
  const [ac, bc] = conciliate(a, b)
  return tv(ac.t, `(if (result ${ac.t}) ${cond} (then ${bc.wat}) (else (${ac.t}.const 0)))`)
}

function genOr(aAst, bAst) {
  const a = gen(aAst), b = gen(bAst)
  const cond = truthy(a).wat
  const [ac, bc] = conciliate(a, b)
  return tv(ac.t, `(if (result ${ac.t}) ${cond} (then ${ac.wat}) (else ${bc.wat}))`)
}

function fmtNum(n) {
  if (Object.is(n, -0)) return '-0'
  if (Number.isNaN(n)) return 'nan'
  if (n === Infinity) return 'inf'
  if (n === -Infinity) return '-inf'
  return String(n)
}
