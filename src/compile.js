/**
 * Compile prepared AST to WASM module (S-expression arrays for watr).
 *
 * Core abstraction: emitter table (ctx.emit) maps AST ops → WASM nodes.
 * Base operators defined in `emitter` export, modules extend via prototype chain.
 * emit(node) dispatches: numbers → i32/f64.const, strings → local.get, arrays → ctx.emit[op].
 *
 * Type system: every emitted node carries .type ('i32' | 'f64').
 * Operators preserve i32 when both operands are i32.
 * Division/power always produce f64. Bitwise/comparisons always produce i32.
 * Variables are typed by pre-analysis: if any assignment is f64, local is f64.
 *
 * Per-function state on ctx: locals (Map name→type), stack (loop labels), uniq (counter), sig.
 *
 * @module compile
 */

import { parse as parseWat } from 'watr'
import { ctx, err, inc } from './ctx.js'
let funcNames  // Set<string> — known function names, set per compile()
let funcMap    // Map<string, func> — name → func info, set per compile()

// === Type helpers ===

/** Tag a WASM node with its result type. */
export const typed = (node, type) => (node.type = type, node)

/** Coerce node to f64. */
export const asF64 = n => n.type === 'f64' ? n : typed(['f64.convert_i32_s', n], 'f64')

/** Coerce node to i32. */
export const asI32 = n => n.type === 'i32' ? n : typed(['i32.trunc_f64_s', n], 'i32')

/** Extract i64 from BigInt-as-f64. */
export const asI64 = n => typed(['i64.reinterpret_f64', asF64(n)], 'i64')

/** Wrap i64 result back to BigInt-as-f64. */
const fromI64 = n => typed(['f64.reinterpret_i64', n], 'f64')

/** Compiler temp prefix — PUA character, impossible in user JS source. */
export const T = '\uE000'

/** Null/undefined: one nullish value inside jz. NaN-boxed ATOM (type=0, aux=1, offset=0).
 *  Distinct from 0, NaN, and all pointers. Triggers default params.
 *  At the JS boundary, null and undefined preserve their identity for interop. */
export const NULL_NAN = '0x7FF8000100000000'

// === Constant folding helpers ===

/** Emit typeof comparison: typeof x == typeCode → type-aware check. */
function emitTypeofCmp(a, b, cmpOp) {
  let typeofExpr, code
  if (Array.isArray(a) && a[0] === 'typeof' && typeof b === 'number') { typeofExpr = a[1]; code = b }
  else if (Array.isArray(a) && a[0] === 'typeof' && Array.isArray(b) && b[0] == null) { typeofExpr = a[1]; code = b[1] }
  else return null
  if (typeof code !== 'number') return null

  const t = temp()
  const va = asF64(emit(typeofExpr))
  const eq = cmpOp === 'eq'

  if (code === -1) {
    // 'number' → x === x (not NaN-boxed pointer, not NaN)
    return typed(eq
      ? ['f64.eq', ['local.tee', `$${t}`, va], ['local.get', `$${t}`]]
      : ['f64.ne', ['local.tee', `$${t}`, va], ['local.get', `$${t}`]], 'i32')
  }
  if (code === -2) {
    // 'string' → is NaN-boxed AND ptr_type is 4 (heap) or 5 (SSO)
    const isPtr = ['f64.ne', ['local.tee', `$${t}`, va], ['local.get', `$${t}`]]
    const tt = `${T}${ctx.uniq++}`; ctx.locals.set(tt, 'i32')
    const isStr = ['i32.or',
      ['i32.eq', ['local.tee', `$${tt}`, ['call', '$__ptr_type', ['local.get', `$${t}`]]], ['i32.const', 4]],
      ['i32.eq', ['local.get', `$${tt}`], ['i32.const', 5]]]
    return typed(eq ? ['i32.and', isPtr, isStr]
      : ['i32.or', ['i32.eqz', isPtr], ['i32.eqz', isStr]], 'i32')
  }
  if (code === -3) {
    // 'undefined' → check for null NaN
    return typed(eq
      ? ['i64.eq', ['i64.reinterpret_f64', va], ['i64.const', NULL_NAN]]
      : ['i64.ne', ['i64.reinterpret_f64', va], ['i64.const', NULL_NAN]], 'i32')
  }
  if (code === -4) {
    // 'boolean' → always false (no boolean type in jz)
    return typed(['i32.const', eq ? 0 : 1], 'i32')
  }
  // Direct type code (6=object, 1=array, 8=set, etc.)
  if (code >= 0) {
    const check = ['i32.eq', ['call', '$__ptr_type', va], ['i32.const', code]]
    return typed(eq ? check : ['i32.eqz', check], 'i32')
  }
  return null
}

/** Check if emitted node is a compile-time constant. */
const isLit = n => (n[0] === 'i32.const' || n[0] === 'f64.const') && typeof n[1] === 'number'
const litVal = n => n[1]

/** Emit a numeric constant with correct i32/f64 typing. */
const emitNum = v => Number.isInteger(v) && v >= -2147483648 && v <= 2147483647
  ? typed(['i32.const', v], 'i32') : typed(['f64.const', v], 'f64')

/** WASM has no f64.rem — implement as a - trunc(a/b) * b */
const f64rem = (a, b) => typed(['f64.sub', a, ['f64.mul', ['f64.trunc', ['f64.div', a, b]], b]], 'f64')

/** Convert already-emitted WASM node to i32 boolean. NaN is falsy (like JS). */
function toBoolFromEmitted(e) {
  if (e.type === 'i32') return e
  // f64: truthy iff non-zero AND not NaN
  const t = temp()
  return typed(['i32.and',
    ['f64.eq', ['local.tee', `$${t}`, e], ['local.get', `$${t}`]],
    ['f64.ne', ['local.get', `$${t}`], ['f64.const', 0]]
  ], 'i32')
}

function toBool(node) {
  const op = Array.isArray(node) ? node[0] : null
  if (['>', '<', '>=', '<=', '==', '!=', '!'].includes(op)) return emit(node)
  return toBoolFromEmitted(emit(node))
}

/** Check if name is a module-scope global (not shadowed by local/param). */
function isGlobal(name) {
  return ctx.globals.has(name) && !ctx.locals?.has(name) && !ctx.sig?.params?.some(p => p.name === name)
}

/** Check if assigning to name would violate const. Only applies when not shadowed. */
function isConst(name) {
  return ctx.consts?.has(name) && !ctx.locals?.has(name) && !ctx.sig?.params?.some(p => p.name === name)
}

/** Allocate a temp local (always f64 for now), returns name without $. */
export function temp() {
  const name = `${T}${ctx.uniq++}`
  ctx.locals.set(name, 'f64')
  return name
}

/** Get current loop labels or throw. */
function loopTop() {
  const top = ctx.stack.at(-1)
  if (!top) err('break/continue outside loop')
  return top
}

/** Extract param names from arrow params AST. Handles (x), (x, y), (() x), etc. */
export function extractParams(rawParams) {
  let p = rawParams
  if (Array.isArray(p) && p[0] === '()') p = p[1]
  return p == null ? [] : Array.isArray(p) ? (p[0] === ',' ? p.slice(1) : [p]) : [p]
}

/** Collect all bound names from a param/destructuring pattern into a Set. */
export function collectParamNames(raw, out = new Set()) {
  for (const r of raw) {
    if (typeof r === 'string') out.add(r)
    else if (Array.isArray(r)) {
      if (r[0] === '=' && typeof r[1] === 'string') out.add(r[1])
      else if (r[0] === '...' && typeof r[1] === 'string') out.add(r[1])
      else if (r[0] === '=' && Array.isArray(r[1])) collectParamNames([r[1]], out)
      else if (r[0] === '[]' || r[0] === '{}' || r[0] === ',') collectParamNames(r.slice(1), out)
    }
  }
  return out
}

/** Find free variables in AST: referenced in node, not in `bound`, present in `scope`. */
function findFreeVars(node, bound, free, scope) {
  if (node == null) return
  if (typeof node === 'string') {
    if (bound.has(node) || free.includes(node)) return
    // Check if in outer scope — locals, params, or scope-tracked vars
    const inScope = scope
      ? scope.has(node)
      : (ctx.locals?.has(node) || ctx.sig?.params.some(p => p.name === node))
    if (inScope) free.push(node)
    return
  }
  if (!Array.isArray(node)) return
  const [op, ...args] = node
  // Nested arrows: don't directly cross, but find what they would capture from us
  if (op === '=>') {
    // Recurse into nested arrows — anything they capture from us is also our capture
    const innerBound = collectParamNames(extractParams(args[0]), new Set(bound))
    findFreeVars(args[1], innerBound, free, scope)
    return
  }
  // Track let/const/for declarations so nested closures see loop-scoped vars
  if ((op === 'let' || op === 'const') && scope) collectParamNames(args, scope)
  if (op === 'for' && scope && Array.isArray(args[0]) && (args[0][0] === 'let' || args[0][0] === 'const'))
    collectParamNames(args[0].slice(1), scope)
  for (const a of args) findFreeVars(a, bound, free, scope)
}

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '>>=', '<<=', '>>>=', '||=', '&&=', '??='])

/**
 * Pre-scan function body for captured variables that are mutated.
 * Collects outer-scope declarations, then for each arrow, finds true captures
 * (vars declared in outer scope, not inside the closure), checks for mutations.
 */
function analyzeBoxedCaptures(body) {
  // Collect outer-scope declarations (not inside arrows) + function params
  const outerScope = new Set()
  ;(function collectDecls(node) {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '=>') return
    if (op === 'let' || op === 'const')
      for (const a of args)
        if (Array.isArray(a) && a[0] === '=' && typeof a[1] === 'string') outerScope.add(a[1])
    for (const a of args) collectDecls(a)
  })(body)
  if (ctx.sig?.params) for (const p of ctx.sig.params) outerScope.add(p.name)

  // For each closure, find captures, check if any are mutated anywhere
  ;(function walk(node) {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '=>') {
      let p = args[0]
      if (Array.isArray(p) && p[0] === '()') p = p[1]
      const raw = p == null ? [] : Array.isArray(p) ? (p[0] === ',' ? p.slice(1) : [p]) : [p]
      const paramSet = new Set(raw.map(r => Array.isArray(r) && r[0] === '...' ? r[1] : r))
      const captures = []
      findFreeVars(args[1], paramSet, captures, outerScope)
      if (captures.length === 0) return
      const captureSet = new Set(captures)
      const mutated = new Set()
      findMutations(body, captureSet, mutated)  // walks everywhere, including nested closures
      for (const v of mutated) ctx.boxed.set(v, `${T}cell_${v}`)
      return
    }
    for (const a of args) walk(a)
  })(body)
}

/** Check if any of the given variable names are assigned anywhere in the AST (crosses into closures). */
function findMutations(node, names, mutated) {
  if (node == null || typeof node !== 'object' || !Array.isArray(node)) return
  const [op, ...args] = node
  if (ASSIGN_OPS.has(op) && typeof args[0] === 'string' && names.has(args[0]))
    mutated.add(args[0])
  if ((op === '++' || op === '--') && typeof args[0] === 'string' && names.has(args[0]))
    mutated.add(args[0])
  for (const a of args) findMutations(a, names, mutated)
}

/** Emit let/const initializations as typed local.set instructions. */
function emitDecl(...inits) {
  const result = []
  for (const i of inits) {
    if (!Array.isArray(i) || i[0] !== '=') continue
    const [, name, init] = i
    if (typeof name !== 'string' || init == null) continue
    // Let {} emitter use variable's merged schema (from Object.assign inference)
    if (Array.isArray(init) && init[0] === '{}') ctx.schema.target = name
    const val = emit(init)
    ctx.schema.target = null
    // Boxed variable: allocate cell, store value, cell local holds pointer (i32)
    if (ctx.boxed.has(name)) {
      const cell = ctx.boxed.get(name)
      ctx.locals.set(cell, 'i32')
      result.push(
        ['local.set', `$${cell}`, ['call', '$__alloc', ['i32.const', 8]]],
        ['f64.store', ['local.get', `$${cell}`], asF64(val)])
      continue
    }
    // Module-scope variable → WASM global (only if not shadowed by local/param)
    if (isGlobal(name)) {
      // Already folded to immutable global in pre-fold pass → skip init
      if (ctx.globalTypes.has(name)) continue
      // Non-constant or non-foldable const → mutable global, init in __start
      result.push(['global.set', `$${name}`, asF64(val)])
      continue
    }
    const localType = ctx.locals.get(name) || 'f64'
    result.push(['local.set', `$${name}`, localType === 'f64' ? asF64(val) : asI32(val)])

    // Auto-box local variable if it has property assignments
    if (ctx._localProps?.has(name) && ctx.schema.vars.has(name)) {
      const schemaId = ctx.schema.vars.get(name)
      const schema = ctx.schema.list[schemaId]
      if (schema?.[0] === '__inner__') {
        inc('__alloc', '__mkptr')
        const bt = `${T}bx${ctx.uniq++}`
        ctx.locals.set(bt, 'i32')
        // Save original value as inner temp for method delegation
        const innerName = `${name}${T}inner`
        ctx.locals.set(innerName, 'f64')
        result.push(
          ['local.set', `$${innerName}`, ['local.get', `$${name}`]],  // save inner before boxing
          ['local.set', `$${bt}`, ['call', '$__alloc', ['i32.const', schema.length * 8]]],
          ['f64.store', ['local.get', `$${bt}`], ['local.get', `$${name}`]],
          ...schema.slice(1).map((_, j) =>
            ['f64.store', ['i32.add', ['local.get', `$${bt}`], ['i32.const', (j + 1) * 8]], ['f64.const', 0]]),
          ['local.set', `$${name}`, ['call', '$__mkptr', ['i32.const', 6], ['i32.const', schemaId], ['local.get', `$${bt}`]]])
      }
    }
  }
  return result.length === 0 ? null : result.length === 1 ? result[0] : result
}

// === Pre-analysis ===

// Value types — what a variable holds (for method dispatch, schema resolution)
export const VAL = {
  NUMBER: 'number', ARRAY: 'array', STRING: 'string',
  OBJECT: 'object', SET: 'set', MAP: 'map',
  CLOSURE: 'closure', TYPED: 'typed', REGEX: 'regex',
  BIGINT: 'bigint',
}

/** Infer value type of an AST expression (without emitting). */
export function valTypeOf(expr) {
  if (expr == null) return null
  if (typeof expr === 'number') return VAL.NUMBER
  if (typeof expr === 'bigint') return VAL.BIGINT
  if (typeof expr === 'string') return ctx.valTypes?.get(expr) || ctx.globalValTypes?.get(expr) || null
  if (!Array.isArray(expr)) return null

  const [op, ...args] = expr
  if (op == null) return typeof args[0] === 'bigint' ? VAL.BIGINT : VAL.NUMBER // literal

  if (op === '[') return VAL.ARRAY
  if (op === 'str') return VAL.STRING
  if (op === '=>') return VAL.CLOSURE
  if (op === '//') return VAL.REGEX
  if (op === '{}' && args[0]?.[0] === ':') return VAL.OBJECT
  // Arithmetic expressions: BigInt if either operand is BigInt, else number
  if (['-', 'u-', '*', '/', '%', '&', '|', '^', '<<', '>>'].includes(op)) {
    if (valTypeOf(args[0]) === VAL.BIGINT || valTypeOf(args[1]) === VAL.BIGINT) return VAL.BIGINT
    return VAL.NUMBER
  }
  if (['**', '++', '--', '~', '>>>', 'u+'].includes(op)) return VAL.NUMBER
  if (op === '+') {
    const ta = valTypeOf(args[0]), tb = valTypeOf(args[1])
    if (ta === VAL.STRING || tb === VAL.STRING) return VAL.STRING
    if (ta === VAL.BIGINT || tb === VAL.BIGINT) return VAL.BIGINT
    return VAL.NUMBER
  }

  if (op === '()') {
    const callee = args[0]
    // Constructor results
    if (typeof callee === 'string') {
      if (callee === 'new.Set') return VAL.SET
      if (callee === 'new.Map') return VAL.MAP
      if (callee.startsWith('new.')) return VAL.TYPED
      if (callee === 'String.fromCharCode' || callee === 'String') return VAL.STRING
      if (callee === 'BigInt' || callee === 'BigInt.asIntN' || callee === 'BigInt.asUintN') return VAL.BIGINT
    }
    // Method return types
    if (Array.isArray(callee) && callee[0] === '.') {
      const [, obj, method] = callee
      if (method === 'map' || method === 'filter') return VAL.ARRAY
      if (method === 'push') return VAL.ARRAY
      if (method === 'add' || method === 'delete') return VAL.SET
      if (method === 'set') return VAL.MAP
      // String-returning methods
      if (['toUpperCase', 'toLowerCase', 'trim', 'trimStart', 'trimEnd',
        'repeat', 'padStart', 'padEnd', 'replace', 'charAt', 'substring'].includes(method)) return VAL.STRING
      // slice/concat preserve caller type (string.slice → string, array.slice → array)
      if (method === 'slice' || method === 'concat') {
        const objType = valTypeOf(obj)
        if (objType) return objType
        return VAL.ARRAY // default to array when unknown
      }
    }
  }
  return null
}

/**
 * Analyze all local value types from declarations and assignments.
 * Builds ctx.valTypes map for method dispatch and schema resolution.
 */
function analyzeValTypes(body) {
  const types = ctx.valTypes
  function trackRegex(name, rhs) {
    if (ctx.regex && Array.isArray(rhs) && rhs[0] === '//') ctx.regex.vars.set(name, rhs)
  }
  function trackTyped(name, rhs) {
    if (!ctx.typedElem) ctx.typedElem = new Map() // first use in this function scope
    if (Array.isArray(rhs) && rhs[0] === '()' && typeof rhs[1] === 'string' && rhs[1].startsWith('new.'))
      ctx.typedElem.set(name, rhs[1]) // e.g. 'new.Float64Array'
  }
  function walk(node) {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '=>') return  // don't leak inner-closure val types
    // Propagate typed array type through method calls (e.g. buf.map → typed)
    function propagateTyped(name, rhs) {
      if (!Array.isArray(rhs) || rhs[0] !== '()') return
      const callee = rhs[1]
      if (!Array.isArray(callee) || callee[0] !== '.') return
      const src = callee[1], method = callee[2]
      if (typeof src === 'string' && types.get(src) === VAL.TYPED && method === 'map') {
        types.set(name, VAL.TYPED)
        if (ctx.typedElem?.has(src)) ctx.typedElem.set(name, ctx.typedElem.get(src))
      }
    }
    if (op === 'let' || op === 'const') {
      for (const a of args) {
        if (!Array.isArray(a) || a[0] !== '=' || typeof a[1] !== 'string') continue
        const vt = valTypeOf(a[2])
        if (vt) types.set(a[1], vt)
        if (vt === VAL.REGEX) trackRegex(a[1], a[2])
        if (vt === VAL.TYPED) trackTyped(a[1], a[2])
        propagateTyped(a[1], a[2])
      }
    }
    if (op === '=' && typeof args[0] === 'string') {
      const vt = valTypeOf(args[1])
      if (vt) types.set(args[0], vt)
      if (vt === VAL.REGEX) trackRegex(args[0], args[1])
      if (vt === VAL.TYPED) trackTyped(args[0], args[1])
      propagateTyped(args[0], args[1])
    }
    // Track property assignments for auto-boxing: x.prop = val
    if (op === '=' && Array.isArray(args[0]) && args[0][0] === '.' && typeof args[0][1] === 'string') {
      const [, obj, prop] = args[0]
      // Only auto-box known non-object types (array, closure, typed, string, number)
      const vt = types.get(obj)
      if (vt && vt !== VAL.OBJECT && ctx.locals?.has(obj) && ctx.schema.register) {
        if (!ctx._localProps) ctx._localProps = new Map()
        if (!ctx._localProps.has(obj)) ctx._localProps.set(obj, new Set())
        ctx._localProps.get(obj).add(prop)
      }
    }
    for (const a of args) walk(a)
  }
  walk(body)

  // Register boxed schemas for local variables with property assignments
  if (ctx._localProps) {
    for (const [name, props] of ctx._localProps) {
      if (ctx.schema.vars.has(name)) continue
      const schema = ['__inner__', ...props]
      ctx.schema.vars.set(name, ctx.schema.register(schema))
    }
  }
}

/**
 * Infer expression result type from AST (without emitting).
 * Used to determine local variable types before compilation.
 */
function exprType(expr, locals) {
  if (expr == null) return 'f64'
  if (typeof expr === 'number')
    return Number.isInteger(expr) && expr >= -2147483648 && expr <= 2147483647 ? 'i32' : 'f64'
  if (typeof expr === 'string') return locals.get(expr) || 'f64'
  if (!Array.isArray(expr)) return 'f64'

  const [op, ...args] = expr
  if (op == null) return exprType(args[0], locals) // literal [, value]

  // Always f64
  if (op === '/' || op === '**' || op === '[' || op === '[]' || op === '{}' || op === '.' || op === 'str') return 'f64'
  // Always i32
  if (['>', '<', '>=', '<=', '==', '!=', '!', '&', '|', '^', '~', '<<', '>>', '>>>'].includes(op)) return 'i32'
  // Preserve i32 if both operands i32
  if (['+', '-', '*', '%'].includes(op)) {
    const ta = exprType(args[0], locals)
    const tb = args[1] != null ? exprType(args[1], locals) : ta // unary: inherit
    return ta === 'i32' && tb === 'i32' ? 'i32' : 'f64'
  }
  // Unary preserves type
  if (op === 'u-' || op === 'u+') return exprType(args[0], locals)
  // Ternary / logical: conciliate
  if (op === '?:' || op === '&&' || op === '||') {
    const branches = op === '?:' ? [args[1], args[2]] : [args[0], args[1]]
    const ta = exprType(branches[0], locals), tb = exprType(branches[1], locals)
    return ta === 'i32' && tb === 'i32' ? 'i32' : 'f64'
  }
  // Array literal (multi-return) → f64
  if (op === '[') return 'f64'
  // Function calls → conservative f64
  return 'f64'
}

/**
 * Analyze all local declarations and assignments to determine types.
 * A local is i32 if ALL assignments produce i32. Any f64 widens to f64.
 */
function analyzeLocals(body) {
  const locals = new Map() // name → 'i32' | 'f64'

  function walk(node) {
    if (!Array.isArray(node)) return
    const [op, ...args] = node

    // let/const declarations
    if (op === 'let' || op === 'const') {
      for (const a of args) {
        // Bare declaration: let x; → default f64
        if (typeof a === 'string') { if (!locals.has(a)) locals.set(a, 'f64'); continue }
        if (!Array.isArray(a) || a[0] !== '=') continue
        // Destructured: collect all bound names from pattern
        if (typeof a[1] !== 'string') {
          for (const n of collectParamNames([a[1]])) if (!locals.has(n)) locals.set(n, 'f64')
          walk(a[2]); continue
        }
        const name = a[1], t = exprType(a[2], locals)
        if (!locals.has(name)) locals.set(name, t)
        else if (locals.get(name) === 'i32' && t === 'f64') locals.set(name, 'f64')
      }
    }

    // Plain assignment
    if (op === '=' && typeof args[0] === 'string') {
      const name = args[0], t = exprType(args[1], locals)
      if (locals.has(name) && locals.get(name) === 'i32' && t === 'f64') locals.set(name, 'f64')
    }

    // Compound assignment
    if (['+=', '-=', '*=', '%='].includes(op) && typeof args[0] === 'string') {
      const name = args[0], opChar = op[0]
      const t = exprType([opChar, args[0], args[1]], locals)
      if (locals.has(name) && locals.get(name) === 'i32' && t === 'f64') locals.set(name, 'f64')
    }
    if (['/='].includes(op) && typeof args[0] === 'string') {
      if (locals.has(args[0])) locals.set(args[0], 'f64') // division always f64
    }

    if (op !== '=>') for (const a of args) walk(a)  // don't leak inner-closure locals
  }

  walk(body)
  return locals
}

/** Normalize emitter output to flat node array. */
/** Normalize emit result to instruction list. Single instruction = string op at [0]. Multi = array at [0]. */
const flat = ir => {
  if (ir == null) return []
  if (!Array.isArray(ir)) return [ir]  // bare 'drop', 'nop', etc.
  if (typeof ir[0] === 'string' || ir[0] == null) return [ir]  // single instruction: ['op', ...args] or [null, val]
  return ir  // multi-instruction: [instr1, instr2, ...]
}

/**
 * Reconstruct arguments with spreads inserted at correct positions.
 * Example: normal=[a, c], spreads=[{pos:1, expr:arr}] → [a, __spread(arr), c]
 */
function reconstructArgsWithSpreads(normal, spreads) {
  const combined = []
  let normalIdx = 0
  for (let targetPos = 0; targetPos <= normal.length; targetPos++) {
    // Insert all spreads marked for this position
    for (const spread of spreads) {
      if (spread.pos === targetPos) {
        combined.push(['__spread', spread.expr])
      }
    }
    // Insert the next normal argument (if available)
    if (normalIdx < normal.length) {
      combined.push(normal[normalIdx++])
    }
  }
  return combined
}

/**
 * Build an array from items, handling ['__spread', expr] markers.
 * Split into sections (normal arrays and spreads), then copy all into result.
 */
function buildArrayWithSpreads(items) {
  const spreads = []
  for (let i = 0; i < items.length; i++) {
    if (Array.isArray(items[i]) && items[i][0] === '__spread') {
      spreads.push({ pos: i, expr: items[i][1] })
    }
  }

  // No spreads: simple array literal
  if (spreads.length === 0) {
    return emit(['[', ...items])
  }

  // Split into sections: [a, b, ...arr, c] → [[a,b], arr, [c]]
  const sections = []
  let currentArray = []

  for (let i = 0; i < items.length; i++) {
    if (Array.isArray(items[i]) && items[i][0] === '__spread') {
      if (currentArray.length > 0) {
        sections.push({ type: 'array', items: currentArray })
        currentArray = []
      }
      sections.push({ type: 'spread', expr: items[i][1] })
    } else {
      currentArray.push(items[i])
    }
  }
  if (currentArray.length > 0) {
    sections.push({ type: 'array', items: currentArray })
  }

  // Single section: just emit it
  if (sections.length === 1) {
    const sec = sections[0]
    return emit(sec.type === 'array' ? ['[', ...sec.items] : sec.expr)
  }

  // Multiple sections: calculate total length, allocate, copy each section
  const result = `${T}arr${ctx.uniq++}`
  const len = `${T}len${ctx.uniq++}`
  const pos = `${T}pos${ctx.uniq++}`
  ctx.locals.set(result, 'i32')
  ctx.locals.set(len, 'i32')
  ctx.locals.set(pos, 'i32')

  const ir = [
    // Calculate total length
    ['local.set', `$${len}`, ['i32.const', 0]],
  ]

  // Emit spread expressions once, store in locals
  for (const sec of sections) {
    if (sec.type === 'spread') {
      sec.local = `${T}sp${ctx.uniq++}`
      ctx.locals.set(sec.local, 'f64')
      ir.push(['local.set', `$${sec.local}`, asF64(emit(sec.expr))])
    }
  }

  // Sum lengths of all sections
  for (const sec of sections) {
    if (sec.type === 'array') {
      ir.push(['local.set', `$${len}`, ['i32.add', ['local.get', `$${len}`], ['i32.const', sec.items.length]]])
    } else {
      ir.push(['local.set', `$${len}`, ['i32.add', ['local.get', `$${len}`], ['call', '$__len', ['local.get', `$${sec.local}`]]]])
    }
  }

  // Allocate result array
  ir.push(
    ['local.set', `$${result}`, ['call', '$__alloc', ['i32.add', ['i32.const', 8], ['i32.shl', ['local.get', `$${len}`], ['i32.const', 3]]]]],
    ['i32.store', ['local.get', `$${result}`], ['local.get', `$${len}`]],
    ['i32.store', ['i32.add', ['local.get', `$${result}`], ['i32.const', 4]], ['local.get', `$${len}`]],
    ['local.set', `$${result}`, ['i32.add', ['local.get', `$${result}`], ['i32.const', 8]]],
    ['local.set', `$${pos}`, ['i32.const', 0]]
  )

  // Copy each section
  for (const sec of sections) {
    if (sec.type === 'array') {
      for (let i = 0; i < sec.items.length; i++) {
        ir.push(
          ['f64.store',
            ['i32.add', ['local.get', `$${result}`], ['i32.shl', ['local.get', `$${pos}`], ['i32.const', 3]]],
            asF64(emit(sec.items[i]))],
          ['local.set', `$${pos}`, ['i32.add', ['local.get', `$${pos}`], ['i32.const', 1]]]
        )
      }
    } else {
      const src = `${T}src${ctx.uniq++}`, slen = `${T}slen${ctx.uniq++}`, sidx = `${T}sidx${ctx.uniq++}`
      ctx.locals.set(src, 'i32'); ctx.locals.set(slen, 'i32'); ctx.locals.set(sidx, 'i32')
      const loopId = ctx.uniq++
      ir.push(
        ['local.set', `$${src}`, ['call', '$__ptr_offset', ['local.get', `$${sec.local}`]]],
        ['local.set', `$${slen}`, ['call', '$__len', ['local.get', `$${sec.local}`]]],
        ['local.set', `$${sidx}`, ['i32.const', 0]],
        ['block', `$break${loopId}`, ['loop', `$loop${loopId}`,
          ['br_if', `$break${loopId}`, ['i32.ge_s', ['local.get', `$${sidx}`], ['local.get', `$${slen}`]]],
          ['f64.store',
            ['i32.add', ['local.get', `$${result}`], ['i32.shl', ['local.get', `$${pos}`], ['i32.const', 3]]],
            ['f64.load', ['i32.add', ['local.get', `$${src}`], ['i32.shl', ['local.get', `$${sidx}`], ['i32.const', 3]]]]],
          ['local.set', `$${pos}`, ['i32.add', ['local.get', `$${pos}`], ['i32.const', 1]]],
          ['local.set', `$${sidx}`, ['i32.add', ['local.get', `$${sidx}`], ['i32.const', 1]]],
          ['br', `$loop${loopId}`]]]
      )
    }
  }

  ir.push(['call', '$__mkptr', ['i32.const', 1], ['i32.const', 0], ['local.get', `$${result}`]])  // 1 = ARRAY type
  return typed(['block', ['result', 'f64'], ...ir], 'f64')
}

// === Module compilation ===

/**
 * Compile prepared AST to WASM module IR.
 * @param {import('./prepare.js').ASTNode} ast - Prepared AST
 * @returns {Array} Complete WASM module as S-expression
 */
export default function compile(ast) {
  // Known function names + lookup map for direct call detection
  funcNames = new Set(ctx.funcs.map(f => f.name))
  funcMap = new Map(ctx.funcs.map(f => [f.name, f]))

  // Check user globals don't conflict with runtime globals (modules loaded after user decls)
  for (const name of ctx.userGlobals)
    if (!ctx.globals.get(name)?.includes('mut f64'))
      err(`'${name}' conflicts with a compiler internal — choose a different name`)

  // Pre-fold const globals: evaluate constant initializers before function compilation
  // so functions see the correct global types (i32 vs f64).
  if (ast) {
    const evalConst = n => {
      if (typeof n === 'number') return n
      if (Array.isArray(n) && n[0] == null && typeof n[1] === 'number') return n[1]
      if (!Array.isArray(n)) return null
      const [op, a, b] = n
      const va = evalConst(a), vb = b !== undefined ? evalConst(b) : null
      if (va == null) return null
      if (op === 'u-' || (op === '-' && b === undefined)) return -va
      if (vb == null) return null
      if (op === '+') return va + vb; if (op === '-') return va - vb
      if (op === '*') return va * vb; if (op === '%' && vb) return va % vb
      if (op === '/' && vb) return va / vb; if (op === '**') return va ** vb
      if (op === '&') return va & vb; if (op === '|') return va | vb
      if (op === '^') return va ^ vb; if (op === '<<') return va << vb
      if (op === '>>') return va >> vb; if (op === '>>>') return va >>> vb
      return null
    }
    const stmts = Array.isArray(ast) && ast[0] === ';' ? ast.slice(1)
      : Array.isArray(ast) && ast[0] === 'const' ? [ast] : []
    for (const s of stmts) {
      if (!Array.isArray(s) || s[0] !== 'const') continue
      for (const decl of s.slice(1)) {
        if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') continue
        const [, name, init] = decl
        if (!ctx.globals.has(name) || !ctx.consts?.has(name)) continue
        const v = evalConst(init)
        if (v == null || !isFinite(v)) continue
        const isInt = Number.isInteger(v) && v >= -2147483648 && v <= 2147483647
        ctx.globals.set(name, isInt
          ? `(global $${name} i32 (i32.const ${v}))`
          : `(global $${name} f64 (f64.const ${v}))`)
        ctx.globalTypes.set(name, isInt ? 'i32' : 'f64')
      }
    }
  }

  // Pre-scan module-scope value types so functions can dispatch methods on globals
  if (ast) {
    const stmts = Array.isArray(ast) && ast[0] === ';' ? ast.slice(1) : [ast]
    for (const s of stmts) {
      if (!Array.isArray(s) || (s[0] !== 'const' && s[0] !== 'let')) continue
      for (const decl of s.slice(1)) {
        if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') continue
        const vt = valTypeOf(decl[2])
        if (vt) {
          if (!ctx.globalValTypes) ctx.globalValTypes = new Map()
          ctx.globalValTypes.set(decl[1], vt)
          if (vt === VAL.REGEX && ctx.regex) ctx.regex.vars.set(decl[1], decl[2])
        }
      }
    }
  }

  // Pre-scan property assignments (x.prop = val) → auto-box variables with schemas
  if (ast && ctx.schema.register) {
    const propMap = new Map() // varName → Set<propName>
    const scan = (node) => {
      if (!Array.isArray(node)) return
      const [op, ...args] = node
      if (op === ';' || op === '{}') { for (const a of args) scan(a); return }
      if (op === '=' && Array.isArray(args[0]) && args[0][0] === '.') {
        const [, obj, prop] = args[0]
        if (typeof obj === 'string' && (ctx.globals.has(obj) || funcNames.has(obj))) {
          if (!propMap.has(obj)) propMap.set(obj, new Set())
          propMap.get(obj).add(prop)
        }
      }
      for (const a of args) if (Array.isArray(a)) scan(a)
    }
    scan(ast)
    // Also scan function bodies (property assignments like err.loc = pos happen inside functions)
    for (const func of ctx.funcs) if (func.body) scan(func.body)
    for (const [name, props] of propMap) {
      // Skip if variable already has a schema (e.g. from Object.assign in prepare)
      if (ctx.schema.vars.has(name)) continue
      // Skip props that are extracted as functions (fn.prop = arrow)
      const valueProps = [...props].filter(p => !funcNames.has(`${name}$${p}`))
      if (!valueProps.length) continue
      // Include extracted fn props in schema too (so schema is complete)
      const allProps = [...props]
      const schema = ['__inner__', ...allProps]
      const schemaId = ctx.schema.register(schema)
      ctx.schema.vars.set(name, schemaId)
      // For function variables, ensure a global exists for property storage
      if (funcNames.has(name) && !ctx.globals.has(name))
        ctx.globals.set(name, `(global $${name} (mut f64) (f64.const 0))`)
      // Mark for boxing emission in __start
      if (!ctx.autoBox) ctx.autoBox = new Map()
      ctx.autoBox.set(name, { schemaId, schema })
    }
  }

  const funcs = ctx.funcs.map(func => {
    // Raw WAT functions (e.g., _alloc, _reset from memory module)
    if (func.raw) return parseWat(func.raw)

    const { name, body, exported, sig } = func

    const multi = sig.results.length > 1

    // Reset per-function state
    ctx.stack = []
    ctx.uniq = 0
    ctx.sig = sig

    // Pre-analyze local types from body
    // Block body vs object literal: object has ':' property nodes
    const block = Array.isArray(body) && body[0] === '{}' && body[1]?.[0] !== ':'
    ctx.locals = block ? analyzeLocals(body) : new Map()
    ctx.valTypes = new Map()
    ctx.boxed = new Map()  // variable name → cell local name (i32) for mutable capture
    ctx._localProps = null  // reset per function
    if (block) {
      analyzeValTypes(body)
      analyzeBoxedCaptures(body)
    }

    const fn = ['func', `$${name}`]
    if (exported) fn.push(['export', `"${name}"`])
    fn.push(...sig.params.map(p => ['param', `$${p.name}`, p.type]))
    fn.push(...sig.results.map(t => ['result', t]))

    // Default params: missing JS args become canonical NaN (0x7FF8000000000000) in WASM f64 params.
    // Check for canonical NaN specifically — NaN-boxed pointers are also NaN but have non-zero payload.
    const defaults = func.defaults || {}
    const defaultInits = []
    for (const [pname, defVal] of Object.entries(defaults)) {
      const p = sig.params.find(p => p.name === pname)
      const t = p?.type || 'f64'
      // Trigger default on any nullish value (NULL_NAN or UNDEF_NAN — both are type-0 ATOMs)
      defaultInits.push(
        ['if', ['i32.or',
          ['i64.eq', ['i64.reinterpret_f64', typed(['local.get', `$${pname}`], 'f64')], ['i64.const', NULL_NAN]],
          ['i64.eq', ['i64.reinterpret_f64', typed(['local.get', `$${pname}`], 'f64')], ['i64.const', '0x7FF8000000000001']]],
          ['then', ['local.set', `$${pname}`, t === 'f64' ? asF64(emit(defVal)) : asI32(emit(defVal))]]])
    }

    // Box params that are mutably captured: allocate cell, copy param value
    const boxedParamInits = []
    for (const p of sig.params) {
      if (ctx.boxed.has(p.name)) {
        const cell = ctx.boxed.get(p.name)
        ctx.locals.set(cell, 'i32')
        boxedParamInits.push(
          ['local.set', `$${cell}`, ['call', '$__alloc', ['i32.const', 8]]],
          ['f64.store', ['local.get', `$${cell}`], asF64(typed(['local.get', `$${p.name}`], p.type))])
      }
    }

    if (block) {
      const stmts = emitBody(body)
      for (const [l, t] of ctx.locals) fn.push(['local', `$${l}`, t])
      fn.push(...defaultInits, ...boxedParamInits, ...stmts, ...sig.results.map(() => ['f64.const', 0]))
    } else if (multi && body[0] === '[') {
      for (const [l, t] of ctx.locals) fn.push(['local', `$${l}`, t])
      fn.push(...boxedParamInits, ...body.slice(1).map(e => asF64(emit(e))))
    } else {
      const ir = emit(body)
      for (const [l, t] of ctx.locals) fn.push(['local', `$${l}`, t])
      fn.push(...defaultInits, ...boxedParamInits, asF64(ir))
    }

    return fn
  })

  // Compile closure bodies (generated during emit phase)
  const closureFuncs = []
  if (ctx.fn.bodies) {
    for (const cb of ctx.fn.bodies) {
      // Reset per-function state for closure body
      ctx.locals = new Map()
      ctx.valTypes = new Map()
      // In closure bodies, boxed captures use the original name as both var and cell local
      ctx.boxed = cb.boxed ? new Map([...cb.boxed].map(v => [v, v])) : new Map()
      ctx.stack = []
      ctx.uniq = Math.max(ctx.uniq, 100) // avoid label collisions
      // Uniform convention: (env: f64, __args: f64) → f64
      ctx.sig = { params: [{ name: '__env', type: 'f64' }, { name: `${T}args`, type: 'f64' }], results: ['f64'] }

      const fn = ['func', `$${cb.name}`]
      fn.push(['param', '$__env', 'f64'])
      fn.push(['param', `$${T}args`, 'f64'])
      fn.push(['result', 'f64'])

      // Params are locals unpacked from args array
      for (const p of cb.params) ctx.locals.set(p, 'f64')

      // Register captured variable locals (i32 for boxed = cell pointer, f64 otherwise)
      for (let i = 0; i < cb.captures.length; i++) {
        const name = cb.captures[i]
        // All captures are f64 — boxed ones store cell pointer as f64 (convert to i32 on use)
        ctx.locals.set(name, 'f64')
      }

      // Emit body
      const block = Array.isArray(cb.body) && cb.body[0] === '{}' && cb.body[1]?.[0] !== ':'
      let bodyIR
      if (block) {
        for (const [k, v] of analyzeLocals(cb.body)) if (!ctx.locals.has(k)) ctx.locals.set(k, v)
        bodyIR = emitBody(cb.body)
      } else {
        bodyIR = [asF64(emit(cb.body))]
      }

      // Insert locals (captures + params + declared)
      for (const [l, t] of ctx.locals) fn.push(['local', `$${l}`, t])

      // Load captures from env (cell pointer for boxed, value for immutable)
      for (let i = 0; i < cb.captures.length; i++) {
        const name = cb.captures[i]
        const loadEnv = ['f64.load', ['i32.add', ['call', '$__ptr_offset', ['local.get', '$__env']], ['i32.const', i * 8]]]
        fn.push(['local.set', `$${name}`, loadEnv])
      }

      // Unpack params from args array (rest param: pass whole array)
      if (cb.rest) {
        fn.push(['local.set', `$${cb.rest}`, ['local.get', `$${T}args`]])
      } else {
        const argsPtr = `$${T}args`
        // Unpack with bounds check: if i >= len, use sentinel NaN (triggers default)
        for (let i = 0; i < cb.params.length; i++) {
          fn.push(['local.set', `$${cb.params[i]}`,
            ['if', ['result', 'f64'],
              ['i32.gt_s', ['call', '$__len', ['local.get', argsPtr]], ['i32.const', i]],
              ['then', ['f64.load', ['i32.add', ['call', '$__ptr_offset', ['local.get', argsPtr]], ['i32.const', i * 8]]]],
              ['else', ['f64.reinterpret_i64', ['i64.const', NULL_NAN]]]]])
        }
      }

      // Default params for closures (check sentinel after unpack)
      if (cb.defaults) {
        for (const [pname, defVal] of Object.entries(cb.defaults)) {
          fn.push(['if', ['i32.or',
            ['i64.eq', ['i64.reinterpret_f64', ['local.get', `$${pname}`]], ['i64.const', NULL_NAN]],
            ['i64.eq', ['i64.reinterpret_f64', ['local.get', `$${pname}`]], ['i64.const', '0x7FF8000000000001']]],
            ['then', ['local.set', `$${pname}`, asF64(emit(defVal))]]])
        }
      }
      fn.push(...bodyIR)
      if (block) fn.push(['f64.const', 0]) // fallthrough
      closureFuncs.push(fn)
    }
  }

  // Build module sections
  const sections = [...ctx.imports]

  // Function types for call_indirect (one per arity)
  if (ctx.fn.types) {
    for (const arity of ctx.fn.types) {
      const params = [['param', 'f64']] // env
      for (let i = 0; i < arity; i++) params.push(['param', 'f64'])
      sections.push(['type', `$ft${arity}`, ['func', ...params, ['result', 'f64']]])
    }
  }

  if (ctx.modules.core) {
    const pages = ctx.memoryPages || 1
    if (ctx.sharedMemory) sections.push(['import', '"env"', '"memory"', ['memory', pages]])
    else sections.push(['memory', ['export', '"memory"'], pages])
  }
  // Data segment placeholder — filled after emit (string literals append to ctx.data during emit)
  const dataIdx = sections.length
  if (ctx.throws) sections.push(['tag', '$__jz_err', ['param', 'f64']])

  // Table for closures
  if (ctx.fn.table?.length)
    sections.push(['table', ctx.fn.table.length, 'funcref'])

  // Globals placeholder — filled after __start (const folding may update declarations)
  const globalsIdx = sections.length
  sections.push(...[...ctx.includes].map(n => parseWat(ctx.stdlib[n])))
  sections.push(...closureFuncs)
  sections.push(...funcs)

  // Element section: populate function table
  if (ctx.fn.table?.length)
    sections.push(['elem', ['i32.const', 0], 'func', ...ctx.fn.table.map(n => `$${n}`)])

  // Module-scope init code (__start): reset per-function state, emit, collect locals
  ctx.locals = new Map()
  ctx.valTypes = new Map()
  ctx.boxed = new Map()
  ctx.stack = []
  ctx.sig = { params: [], results: [] }
  analyzeValTypes(ast)
  const init = emit(ast)

  // Auto-boxing: emit boxing code for variables with property assignments
  const boxInit = []
  if (ctx.autoBox) {
    const bt = `${T}box`
    ctx.locals.set(bt, 'i32')
    for (const [name, { schemaId, schema }] of ctx.autoBox) {
      inc('__alloc', '__mkptr')
      boxInit.push(
        ['local.set', `$${bt}`, ['call', '$__alloc', ['i32.const', schema.length * 8]]],
        // Store inner value (slot 0) — 0 for functions (calls go direct), current val for others
        ['f64.store', ['local.get', `$${bt}`],
          funcNames.has(name) ? ['f64.const', 0] : ['global.get', `$${name}`]],
        // Initialize property slots to 0
        ...schema.slice(1).map((_, i) =>
          ['f64.store', ['i32.add', ['local.get', `$${bt}`], ['i32.const', (i + 1) * 8]], ['f64.const', 0]]),
        // Create boxed OBJECT pointer and store back
        ['global.set', `$${name}`, ['call', '$__mkptr', ['i32.const', 6], ['i32.const', schemaId], ['local.get', `$${bt}`]]])
    }
  }

  if (init?.length || boxInit.length) {
    const startFn = ['func', '$__start']
    for (const [l, t] of ctx.locals) startFn.push(['local', `$${l}`, t])
    startFn.push(...boxInit, ...init)
    sections.push(startFn)
    sections.push(['start', '$__start'])
  }

  // Insert globals at correct position (after __start may have folded consts)
  sections.splice(globalsIdx, 0, ...[...ctx.globals.values()].map(g => parseWat(g)))

  // Insert data segment (after emit — string literals append to ctx.data during emit)
  // Skip for shared memory — data at address 0 would overwrite other modules' data
  if (ctx.data && !ctx.sharedMemory) {
    let esc = ''
    for (let i = 0; i < ctx.data.length; i++) {
      const c = ctx.data.charCodeAt(i)
      if (c >= 32 && c < 127 && c !== 34 && c !== 92) esc += ctx.data[i]
      else esc += '\\' + c.toString(16).padStart(2, '0')
    }
    sections.splice(dataIdx, 0, ['data', ['i32.const', 0], '"' + esc + '"'])
  }

  // Custom section: embed object schemas for JS-side interop
  if (ctx.schema.list.length)
    sections.push(['@custom', '"jz:schema"', `"${JSON.stringify(ctx.schema.list).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`])

  // Custom section: rest params for exported functions (JS-side wrapping)
  // Format: [{name, fixed}] where fixed = number of non-rest params
  const restParamFuncs = ctx.funcs.filter(f => f.exported && f.rest)
    .map(f => ({ name: f.name, fixed: f.sig.params.length - 1 }))
  if (restParamFuncs.length)
    sections.push(['@custom', '"jz:rest"', `"${JSON.stringify(restParamFuncs).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`])

  // Default export alias: export default name → (export "default" (func $name))
  if (typeof ctx.exports['default'] === 'string') {
    const alias = ctx.exports['default']
    sections.push(['export', '"default"', ['func', `$${alias}`]])
  }

  return ['module', ...sections]
}

/** Check if node is a block body (statement list, not object literal/expression) */
const STMT_OPS = new Set([';', 'let', 'const', 'return', 'if', 'for', 'for-in', 'while', 'break', 'continue', 'switch', '=',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '>>=', '<<=', '>>>=', '||=', '&&=', '??=',
  'throw', 'try', 'catch', '++', '--'])
const isBlockBody = n => Array.isArray(n) && n[0] === '{}' && n.length === 2 && Array.isArray(n[1]) && STMT_OPS.has(n[1]?.[0])

/** Emit any node as flat instruction list, routing block bodies through emitBody. */
function emitFlat(node) { return isBlockBody(node) ? emitBody(node) : flat(emit(node)) }

/** Emit block body as flat list of WASM instructions. */
function emitBody(node) {
  const inner = node[1]
  const stmts = Array.isArray(inner) && inner[0] === ';' ? inner.slice(1) : [inner]
  const out = []
  for (const s of stmts) {
    if (s == null || typeof s === 'number') continue
    // Bare block statement: recurse into emitBody
    if (isBlockBody(s)) {
      out.push(...emitBody(s))
      continue
    }
    const ir = emit(s)
    const items = flat(ir)
    out.push(...items)
    // Drop expression results used as statements (method calls, etc.)
    // Skip: return, let/const, assignments, if/for/while/loop, break/continue, local.set
    const op = Array.isArray(s) && s[0]
    if (op && !['return', 'let', 'const', '=', '+=', '-=', '*=', '/=', '%=',
      'if', 'for', 'while', 'break', 'continue', 'switch', 'local.set'].includes(op)
      && ir?.type && ir.type !== 'void')
      out.push('drop')
  }
  return out
}

// === Emitter table ===

/**
 * Core emitter table. Maps AST ops to WASM IR generators.
 * Modules extend ctx.emit (inherits from emitter) for custom ops.
 * @type {Record<string, (...args: any[]) => Array>}
 */
/** Comparison op factory with constant folding. */
const cmpOp = (i32op, f64op, fn) => (a, b) => {
  const va = emit(a), vb = emit(b)
  if (isLit(va) && isLit(vb)) return emitNum(fn(litVal(va), litVal(vb)) ? 1 : 0)
  return va.type === 'i32' && vb.type === 'i32'
    ? typed([`i32.${i32op}`, va, vb], 'i32') : typed([`f64.${f64op}`, asF64(va), asF64(vb)], 'i32')
}

/** Compound assignment: read → op → write back (handles boxed/global/local dispatch). */
/** Get i32 memory address for a boxed variable's cell. Handles f64→i32 conversion for closure captures. */
function boxedAddr(name) {
  const c = `$${ctx.boxed.get(name)}`
  const ct = ctx.locals?.get(ctx.boxed.get(name)) || 'i32'
  return ct === 'f64' ? ['i32.trunc_f64_u', ['local.get', c]] : ['local.get', c]
}

function compoundAssign(name, val, f64op, i32op) {
  if (typeof name === 'string' && isConst(name)) err(`Assignment to const '${name}'`)
  if (ctx.boxed?.has(name)) {
    const addr = boxedAddr(name)
    return ['f64.store', addr, f64op(typed(['f64.load', addr], 'f64'), asF64(emit(val)))]
  }
  if (isGlobal(name)) {
    return ['global.set', `$${name}`, f64op(typed(['global.get', `$${name}`], 'f64'), asF64(emit(val)))]
  }
  const t = ctx.locals.get(name) || 'f64'
  const va = typed(['local.get', `$${name}`], t), vb = emit(val)
  if (i32op && va.type === 'i32' && vb.type === 'i32') {
    const result = i32op(va, vb)
    return ['local.set', `$${name}`, t === 'f64' ? asF64(result) : result]
  }
  const result = f64op(asF64(va), asF64(vb))
  return ['local.set', `$${name}`, t === 'f64' ? result : asI32(result)]
}

export const emitter = {
  // === Spread operator ===
  // Note: spread is handled specially in call contexts; this catches stray uses
  '...': () => err('Spread (...) can only be used in function/method calls or array literals'),

  // === Statements ===

  ';': (...args) => {
    const out = []
    for (const a of args) {
      const r = emit(a)
      if (r == null) continue
      out.push(...flat(r))
    }
    return out
  },
  '{': (...args) => args.map(emit).filter(x => x != null),
  ',': (...args) => {
    const results = args.map(emit).filter(x => x != null)
    if (results.length === 0) return null
    if (results.length === 1) return results[0]
    const last = results[results.length - 1]
    // If last expression is void (store, etc.), add explicit return value
    if (!last.type) {
      return typed(['block', ['result', 'f64'],
        ...results.map(r => r.type ? ['drop', r] : r),
        ['f64.const', 0]], 'f64')
    }
    return typed(['block', ['result', last.type],
      ...results.slice(0, -1).map(r => r.type ? ['drop', r] : r), last], last.type)
  },
  'let': emitDecl,
  'const': emitDecl,
  'export': () => null,
  // 'block' can appear from jzify transforming labeled blocks or as WASM block IR
  'block': (...args) => {
    // WASM block IR: first arg is ['result', type] → pass through as-is
    if (Array.isArray(args[0]) && args[0][0] === 'result') return ['block', ...args]
    const inner = args.length === 1 ? args[0] : [';', ...args]
    return emitFlat(['{}', inner])
  },

  'throw': expr => {
    ctx.throws = true
    return typed(['throw', '$__jz_err', asF64(emit(expr))], 'void')
  },

  'catch': (body, errName, handler) => {
    ctx.throws = true
    const id = ctx.uniq++
    ctx.locals.set(errName, 'f64')
    const prev = ctx._inTry; ctx._inTry = true
    const bodyIR = Array.isArray(body) && body[0] === '{}' ? emitBody(body) : flat(emit(body))
    ctx._inTry = prev
    const handlerIR = Array.isArray(handler) && handler[0] === '{}' ? emitBody(handler) : flat(emit(handler))
    // Drop any value left by body statements (e.g. nested try/catch result)
    const lastIR = bodyIR[bodyIR.length - 1]
    const needsDrop = lastIR?.type === 'f64' && Array.isArray(lastIR) && lastIR[0]?.startsWith?.('block')
    return typed(['block', `$outer${id}`, ['result', 'f64'],
      ['block', `$catch${id}`, ['result', 'f64'],
        ['try_table', ['catch', '$__jz_err', `$catch${id}`],
          ...bodyIR,
          ...(needsDrop ? ['drop'] : [])],
        ['f64.const', 0],
        ['br', `$outer${id}`]],
      ['local.set', `$${errName}`],
      ...handlerIR,
      ['f64.const', 0]], 'f64')
  },

  'return': expr => {
    if (ctx.sig?.results.length > 1 && Array.isArray(expr) && expr[0] === '[')
      return typed(['return', ...expr.slice(1).map(e => asF64(emit(e)))], 'f64')
    // Bare return → return null
    if (expr == null) return typed(['return', ['f64.reinterpret_i64', ['i64.const', NULL_NAN]]], 'f64')
    // Emit the expression normally (handles defaults, rest, closures)
    const ir = asF64(emit(expr))
    // Tail call optimization: return call $f(...) → return_call $f(...)
    // Only for direct calls (not closures), and not inside try blocks
    if (!ctx._inTry && Array.isArray(ir) && ir[0] === 'call' && typeof ir[1] === 'string')
      return typed(['return_call', ...ir.slice(1)], 'f64')
    return typed(['return', ir], 'f64')
  },

  // === Assignment ===

  '=': (name, val) => {
    if (typeof name === 'string' && isConst(name)) err(`Assignment to const '${name}'`)
    // Array index assignment: arr[i] = x
    if (Array.isArray(name) && name[0] === '[]') {
      const [, arr, idx] = name
      // TypedArray: type-aware store
      if (typeof arr === 'string' && ctx.valTypes?.get(arr) === 'typed' && ctx.emit['.typed:[]=']) {
        const r = ctx.emit['.typed:[]=']?.(arr, idx, val)
        if (r) return r
      }
      const va = emit(arr), vi = asI32(emit(idx)), vv = asF64(emit(val))
      return ['f64.store', ['i32.add', ['call', '$__ptr_offset', asF64(va)], ['i32.shl', vi, ['i32.const', 3]]], vv]
    }
    // Object property assignment: obj.prop = x
    if (Array.isArray(name) && name[0] === '.') {
      const [, obj, prop] = name
      // Schema-based object → f64.store at fixed offset
      if (typeof obj === 'string' && ctx.schema.find) {
        const idx = ctx.schema.find(obj, prop)
        if (idx >= 0) {
          const va = emit(obj), vv = asF64(emit(val))
          return ['f64.store', ['i32.add', ['call', '$__ptr_offset', asF64(va)], ['i32.const', idx * 8]], vv]
        }
      }
      // HASH (dynamic object) → __hash_set (may return new pointer after grow)
      ctx.includes.add('__hash_set'); ctx.includes.add('__str_hash'); ctx.includes.add('__str_eq')
      const setCall = typed(['call', '$__hash_set', asF64(emit(obj)), asF64(emit(['str', prop])), asF64(emit(val))], 'f64')
      // Update variable (pointer may change after hash table grow)
      if (typeof obj === 'string') {
        if (isGlobal(obj)) return ['global.set', `$${obj}`, setCall]
        return ['local.set', `$${obj}`, setCall]
      }
      return setCall
    }
    if (typeof name !== 'string') err(`Assignment to non-variable: ${JSON.stringify(name)}`)
    // Boxed variable: store to memory cell
    if (ctx.boxed?.has(name))
      return ['f64.store', boxedAddr(name), asF64(emit(val))]
    // Module-scope variable → WASM global (only if not shadowed)
    if (isGlobal(name))
      return ['global.set', `$${name}`, asF64(emit(val))]
    const v = emit(val), t = ctx.locals.get(name) || 'f64'
    return ['local.set', `$${name}`, t === 'f64' ? asF64(v) : asI32(v)]
  },

  // Compound assignments: read-modify-write with type coercion
  ...Object.fromEntries([
    ['+=', 'add'], ['-=', 'sub'], ['*=', 'mul'], ['/=', 'div'],
  ].map(([op, fn]) => [op, (name, val) => compoundAssign(name, val,
    (a, b) => typed([`f64.${fn}`, a, b], 'f64'),
    fn === 'div' ? null : (a, b) => typed([`i32.${fn}`, a, b], 'i32')
  )])),
  '%=': (name, val) => compoundAssign(name, val, f64rem, (a, b) => typed(['i32.rem_s', a, b], 'i32')),

  // Bitwise compound assignments: read-modify-write in i32 via compoundAssign
  ...Object.fromEntries([
    ['&=', 'and'], ['|=', 'or'], ['^=', 'xor'],
    ['>>=', 'shr_s'], ['<<=', 'shl'], ['>>>=', 'shr_u'],
  ].map(([op, fn]) => [op, (name, val) => compoundAssign(name, val,
    (a, b) => asF64(typed([`i32.${fn}`, asI32(a), asI32(b)], 'i32')),
    (a, b) => typed([`i32.${fn}`, a, b], 'i32')
  )])),

  // Logical compound assignments: a ||= b → a = a || b, a &&= b → a = a && b
  // Logical/nullish compound assignments: read → check → conditionally write
  // For complex LHS (obj.prop, arr[i]): emit as check(read(lhs)) ? write(lhs, val) : read(lhs)
  ...Object.fromEntries(['||=', '&&=', '??='].map(op => [op, (name, val) => {
    // Complex LHS → desugar (side-effect-safe since obj/arr/idx are locals)
    if (typeof name !== 'string') {
      const baseOp = op.slice(0, -1) // '||', '&&', '??'
      return emit([baseOp, name, ['=', name, val]])
    }
    if (isConst(name)) err(`Assignment to const '${name}'`)
    const t = temp()
    const va = isGlobal(name)
      ? typed(['global.get', `$${name}`], 'f64')
      : typed(['local.get', `$${name}`], ctx.locals.get(name) || 'f64')
    // Condition: ||= → truthy check, &&= → truthy check, ??= → nullish check
    const cond = op === '??='
      ? ['i64.eq', ['i64.reinterpret_f64', ['local.tee', `$${t}`, asF64(va)]], ['i64.const', NULL_NAN]]
      : ['i32.and',
          ['f64.eq', ['local.tee', `$${t}`, asF64(va)], ['local.get', `$${t}`]],
          ['f64.ne', ['local.get', `$${t}`], ['f64.const', 0]]]
    // ||= → keep if truthy, else assign. &&= → assign if truthy, else keep. ??= → assign if null.
    const [thenExpr, elseExpr] = op === '&&='
      ? [asF64(emit(val)), ['local.get', `$${t}`]]
      : op === '??='
        ? [asF64(emit(val)), ['local.get', `$${t}`]]
        : [['local.get', `$${t}`], asF64(emit(val))]
    const result = typed(['if', ['result', 'f64'], cond, ['then', thenExpr], ['else', elseExpr]], 'f64')
    if (isGlobal(name)) return ['global.set', `$${name}`, result]
    const lt = ctx.locals.get(name) || 'f64'
    return ['local.set', `$${name}`, lt === 'i32' ? asI32(result) : result]
  }])),

  // === Increment/Decrement ===
  // Postfix resolved in prepare: i++ → (++i) - 1

  ...Object.fromEntries([['++', 'add'], ['--', 'sub']].map(([op, fn]) => [op, name => {
    if (typeof name === 'string' && isConst(name)) err(`Assignment to const '${name}'`)
    if (ctx.boxed?.has(name)) {
      const addr = boxedAddr(name), t = temp()
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${t}`, [`f64.${fn}`, typed(['f64.load', addr], 'f64'), ['f64.const', 1]]],
        ['f64.store', addr, ['local.get', `$${t}`]],
        ['local.get', `$${t}`]], 'f64')
    }
    if (isGlobal(name)) {
      const t = temp()
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${t}`, [`f64.${fn}`, typed(['global.get', `$${name}`], 'f64'), ['f64.const', 1]]],
        ['global.set', `$${name}`, ['local.get', `$${t}`]],
        ['local.get', `$${t}`]], 'f64')
    }
    const t = ctx.locals.get(name) || 'f64'
    const one = t === 'i32' ? ['i32.const', 1] : ['f64.const', 1]
    return typed(['local.tee', `$${name}`, [`${t}.${fn}`, ['local.get', `$${name}`], one]], t)
  }])),

  // === Arithmetic (type-preserving) ===

  '+': (a, b) => {
    // String concatenation: if either operand is known string, use __str_concat
    const vtA = typeof a === 'string' ? (ctx.valTypes?.get(a) || ctx.globalValTypes?.get(a)) : valTypeOf(a)
    const vtB = typeof b === 'string' ? (ctx.valTypes?.get(b) || ctx.globalValTypes?.get(b)) : valTypeOf(b)
    if (vtA === VAL.STRING || vtB === VAL.STRING) {
      ctx.includes.add('__str_concat'); ctx.includes.add('__to_str')
      ctx.includes.add('__ftoa'); ctx.includes.add('__itoa'); ctx.includes.add('__pow10')
      ctx.includes.add('__mkstr'); ctx.includes.add('__static_str'); ctx.includes.add('__str_byteLen')
      return typed(['call', '$__str_concat', asF64(emit(a)), asF64(emit(b))], 'f64')
    }
    if (vtA === VAL.BIGINT || vtB === VAL.BIGINT)
      return fromI64(['i64.add', asI64(emit(a)), asI64(emit(b))])
    const va = emit(a), vb = emit(b)
    if (isLit(va) && isLit(vb)) return emitNum(litVal(va) + litVal(vb))
    if (isLit(vb) && litVal(vb) === 0) return va
    if (isLit(va) && litVal(va) === 0) return vb
    if (va.type === 'i32' && vb.type === 'i32') return typed(['i32.add', va, vb], 'i32')
    return typed(['f64.add', asF64(va), asF64(vb)], 'f64')
  },
  '-': (a, b) => {
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT)
      return b === undefined
        ? fromI64(['i64.sub', ['i64.const', 0], asI64(emit(a))])
        : fromI64(['i64.sub', asI64(emit(a)), asI64(emit(b))])
    if (b === undefined) { const v = emit(a); return isLit(v) ? emitNum(-litVal(v)) : v.type === 'i32' ? typed(['i32.sub', typed(['i32.const', 0], 'i32'), v], 'i32') : typed(['f64.neg', v], 'f64') }
    const va = emit(a), vb = emit(b)
    if (isLit(va) && isLit(vb)) return emitNum(litVal(va) - litVal(vb))
    if (isLit(vb) && litVal(vb) === 0) return va
    if (va.type === 'i32' && vb.type === 'i32') return typed(['i32.sub', va, vb], 'i32')
    return typed(['f64.sub', asF64(va), asF64(vb)], 'f64')
  },
  'u+': a => emit(a),
  'u-': a => {
    if (valTypeOf(a) === VAL.BIGINT) return fromI64(['i64.sub', ['i64.const', 0], asI64(emit(a))])
    const v = emit(a); return isLit(v) ? emitNum(-litVal(v)) : v.type === 'i32' ? typed(['i32.sub', typed(['i32.const', 0], 'i32'), v], 'i32') : typed(['f64.neg', v], 'f64')
  },
  '*': (a, b) => {
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT)
      return fromI64(['i64.mul', asI64(emit(a)), asI64(emit(b))])
    const va = emit(a), vb = emit(b)
    if (isLit(va) && isLit(vb)) return emitNum(litVal(va) * litVal(vb))
    if (isLit(vb) && litVal(vb) === 1) return va
    if (isLit(va) && litVal(va) === 1) return vb
    if (isLit(vb) && litVal(vb) === 0) return isLit(va) ? vb : typed(['block', ['result', vb.type], va, 'drop', vb], vb.type)
    if (isLit(va) && litVal(va) === 0) return isLit(vb) ? va : typed(['block', ['result', va.type], vb, 'drop', va], va.type)
    if (va.type === 'i32' && vb.type === 'i32') return typed(['i32.mul', va, vb], 'i32')
    return typed(['f64.mul', asF64(va), asF64(vb)], 'f64')
  },
  '/': (a, b) => {
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT)
      return fromI64(['i64.div_s', asI64(emit(a)), asI64(emit(b))])
    const va = emit(a), vb = emit(b)
    if (isLit(va) && isLit(vb) && litVal(vb) !== 0) return emitNum(litVal(va) / litVal(vb))
    if (isLit(vb) && litVal(vb) === 1) return asF64(va)
    return typed(['f64.div', asF64(va), asF64(vb)], 'f64')
  },
  '%': (a, b) => {
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT)
      return fromI64(['i64.rem_s', asI64(emit(a)), asI64(emit(b))])
    const va = emit(a), vb = emit(b)
    if (isLit(va) && isLit(vb) && litVal(vb) !== 0) return emitNum(litVal(va) % litVal(vb))
    if (va.type === 'i32' && vb.type === 'i32') return typed(['i32.rem_s', va, vb], 'i32')
    return f64rem(asF64(va), asF64(vb))
  },

  // === Comparisons (always i32 result) ===

  '==': (a, b) => {
    // typeof x == 'string' → compile-time type check (prepare rewrites string to type code)
    const tc = emitTypeofCmp(a, b, 'eq'); if (tc) return tc
    const va = emit(a), vb = emit(b)
    if (va.type === 'i32' && vb.type === 'i32') return typed(['i32.eq', va, vb], 'i32')
    return typed(['i64.eq', ['i64.reinterpret_f64', asF64(va)], ['i64.reinterpret_f64', asF64(vb)]], 'i32')
  },
  '!=': (a, b) => {
    const tc = emitTypeofCmp(a, b, 'ne'); if (tc) return tc
    const va = emit(a), vb = emit(b)
    if (va.type === 'i32' && vb.type === 'i32') return typed(['i32.ne', va, vb], 'i32')
    return typed(['i64.ne', ['i64.reinterpret_f64', asF64(va)], ['i64.reinterpret_f64', asF64(vb)]], 'i32')
  },
  '<':  cmpOp('lt_s', 'lt', (a, b) => a < b),
  '>':  cmpOp('gt_s', 'gt', (a, b) => a > b),
  '<=': cmpOp('le_s', 'le', (a, b) => a <= b),
  '>=': cmpOp('ge_s', 'ge', (a, b) => a >= b),

  // === Logical ===

  '!': a => {
    const v = emit(a)
    if (v.type === 'i32') return typed(['i32.eqz', v], 'i32')
    // f64: truthy if zero OR NaN. (eq x 0) catches zero; (ne x x) catches NaN
    const t = temp()
    return typed(['i32.or',
      ['f64.eq', ['local.tee', `$${t}`, v], ['f64.const', 0]],
      ['f64.ne', ['local.get', `$${t}`], ['local.get', `$${t}`]]
    ], 'i32')
  },

  '?:': (a, b, c) => {
    // Constant condition → emit only the live branch
    const ca = emit(a)
    if (isLit(ca)) { const v = litVal(ca); return (v !== 0 && v === v) ? emit(b) : emit(c) }
    const cond = toBoolFromEmitted(ca)
    const vb = emit(b), vc = emit(c)
    if (vb.type === 'i32' && vc.type === 'i32')
      return typed(['select', vb, vc, cond], 'i32')
    return typed(['select', asF64(vb), asF64(vc), cond], 'f64')
  },

  '&&': (a, b) => {
    const va = emit(a)
    if (isLit(va)) { const v = litVal(va); return (v !== 0 && v === v) ? emit(b) : va }
    const t = temp()
    return typed(['if', ['result', 'f64'],
      // NaN-aware: truthy iff non-zero AND not NaN
      ['i32.and',
        ['f64.eq', ['local.tee', `$${t}`, asF64(va)], ['local.get', `$${t}`]],
        ['f64.ne', ['local.get', `$${t}`], ['f64.const', 0]]],
      ['then', asF64(emit(b))],
      ['else', ['local.get', `$${t}`]]], 'f64')
  },

  '||': (a, b) => {
    const va = emit(a)
    if (isLit(va)) { const v = litVal(va); return (v !== 0 && v === v) ? va : emit(b) }
    const t = temp()
    return typed(['if', ['result', 'f64'],
      // NaN-aware: truthy iff non-zero AND not NaN
      ['i32.and',
        ['f64.eq', ['local.tee', `$${t}`, asF64(va)], ['local.get', `$${t}`]],
        ['f64.ne', ['local.get', `$${t}`], ['f64.const', 0]]],
      ['then', ['local.get', `$${t}`]],
      ['else', asF64(emit(b))]], 'f64')
  },

  // a ?? b: in f64 world null=0, same as || (revisit when null is distinct from 0)
  // a ?? b: returns b only if a is null (NaN-boxed null), NOT for 0/""/false
  '??': (a, b) => {
    const va = emit(a)
    const t = temp()
    return typed(['if', ['result', 'f64'],
      // Check: is a NOT the null NaN?
      ['i64.ne', ['i64.reinterpret_f64', ['local.tee', `$${t}`, asF64(va)]], ['i64.const', NULL_NAN]],
      ['then', ['local.get', `$${t}`]],
      ['else', asF64(emit(b))]], 'f64')
  },

  'void': a => {
    const v = emit(a)
    if (v == null) return typed(['f64.const', 0], 'f64')
    // Detect WASM-void instructions (local.set, *.store) that don't leave a value on stack
    const op = Array.isArray(v) ? v[0] : null
    const wasmVoid = op === 'local.set' || (typeof op === 'string' && op.endsWith('.store'))
      || op === 'memory.copy' || op === 'global.set'
    if (wasmVoid)
      return typed(['block', ['result', 'f64'], v, ['f64.const', 0]], 'f64')
    // Value-producing instructions: include, drop result, return 0
    if (v.type && v.type !== 'void')
      return typed(['block', ['result', 'f64'], v, 'drop', ['f64.const', 0]], 'f64')
    return typed(['block', ['result', 'f64'], ...flat(v), ['f64.const', 0]], 'f64')
  },

  '(': a => emit(a),

  // === Bitwise (i32 for numbers, i64 for BigInt) ===

  '~':   a => { const v = emit(a); return isLit(v) ? emitNum(~litVal(v)) : typed(['i32.xor', asI32(v), typed(['i32.const', -1], 'i32')], 'i32') },
  ...Object.fromEntries([
    ['&', 'and'], ['|', 'or'], ['^', 'xor'], ['<<', 'shl'], ['>>', 'shr_s'],
  ].map(([op, fn]) => [op, (a, b) => {
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT)
      return fromI64([`i64.${fn}`, asI64(emit(a)), asI64(emit(b))])
    const va = emit(a), vb = emit(b)
    if (isLit(va) && isLit(vb)) {
      const la = litVal(va), lb = litVal(vb)
      if (op === '&') return emitNum(la & lb); if (op === '|') return emitNum(la | lb)
      if (op === '^') return emitNum(la ^ lb); if (op === '<<') return emitNum(la << lb)
      if (op === '>>') return emitNum(la >> lb)
    }
    return typed([`i32.${fn}`, asI32(va), asI32(vb)], 'i32')
  }])),
  '>>>': (a, b) => { const va = emit(a), vb = emit(b); return isLit(va) && isLit(vb) ? emitNum(litVal(va) >>> litVal(vb)) : typed(['i32.shr_u', asI32(va), asI32(vb)], 'i32') },

  // === Control flow ===

  'if': (cond, then, els) => {
    // Dead branch elimination: constant condition → emit only the live branch
    const ce = emit(cond)
    if (isLit(ce)) {
      const v = litVal(ce), truthy = v !== 0 && v === v
      if (truthy) { const t = emit(then); return t?.type && t.type !== 'void' ? [t, 'drop'] : t }
      if (els != null) { const e = emit(els); return e?.type && e.type !== 'void' ? [e, 'drop'] : e }
      return null
    }
    const c = ce.type === 'i32' ? ce : toBoolFromEmitted(ce)
    // Drop trailing value-producing instruction (WASM stack balance)
    const dropBody = items => {
      const last = items[items.length - 1]
      if (last?.type && last.type !== 'void') items.push('drop')
      return items
    }
    const thenBody = dropBody(emitFlat(then))
    if (els != null)
      return ['if', c, ['then', ...thenBody], ['else', ...dropBody(emitFlat(els))]]
    return ['if', c, ['then', ...thenBody]]
  },

  'for': (init, cond, step, body) => {
    if (body === undefined) return err('for-in/for-of not supported')
    const id = ctx.uniq++
    const brk = `$brk${id}`, loop = `$loop${id}`
    ctx.stack.push({ brk, loop })
    const result = []
    if (init != null) result.push(...flat(emit(init)))
    const loopBody = []
    if (cond) loopBody.push(['br_if', brk, ['i32.eqz', toBool(cond)]])
    loopBody.push(...emitFlat(body))
    if (step) loopBody.push(...flat(emit(step)))
    loopBody.push(['br', loop])
    result.push(['block', brk, ['loop', loop, ...loopBody]])
    ctx.stack.pop()
    return result.length === 1 ? result[0] : result
  },

  'switch': (discriminant, ...cases) => {
    const disc = `${T}disc${ctx.uniq++}`
    ctx.locals.set(disc, 'f64')

    const result = [typed(['local.set', `$${disc}`, asF64(emit(discriminant))], 'f64')]

    for (const c of cases) {
      if (c[0] === 'case') {
        const [, test, body] = c
        const skip = `$skip${ctx.uniq++}`
        // Block: skip if discriminant != test, otherwise execute body
        result.push(['block', skip,
          ['br_if', skip, typed(['f64.ne', typed(['local.get', `$${disc}`], 'f64'), asF64(emit(test))], 'i32')],
          ...flat(emit(body))])
      } else if (c[0] === 'default') {
        result.push(...flat(emit(c[1])))
      }
    }

    return result
  },

  'while': (cond, body) => emitter['for'](null, cond, null, body),
  'break': () => ['br', loopTop().brk],
  'continue': () => ['br', loopTop().loop],

  // === Call ===

  // Arrow as value → closure
  '=>': (rawParams, body) => {
    if (!ctx.fn.make) err('Closures require fn module (auto-included)')

    const raw = extractParams(rawParams)
    const params = [], defaults = {}
    let restParam = null, bodyPrefix = []
    for (const r of raw) {
      if (Array.isArray(r) && r[0] === '...') {
        restParam = r[1]
        params.push(r[1])
      } else if (Array.isArray(r) && r[0] === '=') {
        if (typeof r[1] !== 'string') {
          const tmp = `${T}p${ctx.uniq++}`; params.push(tmp)
          defaults[tmp] = r[2]; bodyPrefix.push(['let', ['=', r[1], tmp]])
        } else { params.push(r[1]); defaults[r[1]] = r[2] }
      } else if (Array.isArray(r) && (r[0] === '[]' || r[0] === '{}')) {
        const tmp = `${T}p${ctx.uniq++}`; params.push(tmp)
        bodyPrefix.push(['let', ['=', r, tmp]])
      } else {
        params.push(r)
      }
    }

    // Prepend destructuring to body (if any destructured params)
    if (bodyPrefix.length) {
      if (Array.isArray(body) && body[0] === '{}' && Array.isArray(body[1]) && body[1][0] === ';')
        body = ['{}', [';', ...bodyPrefix, ...body[1].slice(1)]]
      else if (Array.isArray(body) && body[0] === '{}')
        body = ['{}', [';', ...bodyPrefix, body[1]]]
      else body = ['{}', [';', ...bodyPrefix, ['return', body]]]
    }

    // Find free variables in body that aren't params → captures
    const paramSet = new Set(params)
    const captures = []
    findFreeVars(body, paramSet, captures)
    for (const def of Object.values(defaults)) findFreeVars(def, paramSet, captures)

    // Pass closure info including rest param and defaults
    const closureInfo = { params, body, captures, restParam }
    if (Object.keys(defaults).length) closureInfo.defaults = defaults
    return ctx.fn.make(closureInfo)
  },

  '()': (callee, callArgs) => {
    let argList = Array.isArray(callArgs)
      ? (callArgs[0] === ',' ? callArgs.slice(1) : [callArgs])
      : callArgs ? [callArgs] : []

    // Helper: expand spread arguments into flat list of normal arguments + spread markers
    // Returns { normal: [...], spreads: [(pos, expr), ...] }
    const parseArgs = (args) => {
      const normal = []
      const spreads = []
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (Array.isArray(arg) && arg[0] === '...') {
          spreads.push({ pos: normal.length, expr: arg[1] })
        } else {
          normal.push(arg)
        }
      }
      return { normal, spreads, hasSpread: spreads.length > 0 }
    }

    const parsed = parseArgs(argList)

    // Method call: obj.method(args) → type-aware dispatch
    if (Array.isArray(callee) && callee[0] === '.') {
      const [, obj, method] = callee

      // Function property call: fn.prop(args) → direct call to fn$prop
      if (typeof obj === 'string' && funcNames.has(obj)) {
        const fname = `${obj}$${method}`
        if (funcNames.has(fname)) {
          const func = funcMap.get(fname)
          const emittedArgs = parsed.normal.map(a => asF64(emit(a)))
          while (emittedArgs.length < func.sig.params.length)
            emittedArgs.push(typed(['f64.reinterpret_i64', ['i64.const', NULL_NAN]], 'f64'))
          return typed(['call', `$${fname}`, ...emittedArgs], 'f64')
        }
      }

      const vt = typeof obj === 'string' ? (ctx.valTypes.get(obj) || ctx.globalValTypes?.get(obj)) : valTypeOf(obj)

      // Helper to call method with arguments (handles spread expansion)
      const callMethod = (objArg, methodEmitter) => {
        if (!parsed.hasSpread) {
          return methodEmitter(objArg, ...parsed.normal)
        }

        // Single spread at end: call method with normal args, then loop spread elements
        if (parsed.spreads.length === 1 && parsed.spreads[0].pos === parsed.normal.length) {
          const spreadExpr = parsed.spreads[0].expr
          const acc = `${T}acc${ctx.uniq++}`, arr = `${T}sp${ctx.uniq++}`, len = `${T}splen${ctx.uniq++}`, idx = `${T}spidx${ctx.uniq++}`
          ctx.locals.set(acc, 'f64'); ctx.locals.set(arr, 'f64')
          ctx.locals.set(len, 'i32'); ctx.locals.set(idx, 'i32')

          // Mutating methods (push/add/set) modify in-place; accumulating methods (concat) return new values
          const mutating = ['push', 'add', 'set', 'unshift'].includes(method)
          const ir = []
          ir.push(['local.set', `$${acc}`, asF64(emit(objArg))])
          if (parsed.normal.length > 0) {
            const r = asF64(methodEmitter(objArg, ...parsed.normal))
            ir.push(mutating ? ['drop', r] : ['local.set', `$${acc}`, r])
          }

          ir.push(['local.set', `$${arr}`, asF64(emit(spreadExpr))])
          ir.push(['local.set', `$${len}`, ['call', '$__len', ['local.get', `$${arr}`]]])
          ir.push(['local.set', `$${idx}`, ['i32.const', 0]])
          const loopId = ctx.uniq++
          const loopBody = asF64(methodEmitter(acc, ['[]', arr, idx]))
          ir.push(['block', `$break${loopId}`,
            ['loop', `$continue${loopId}`,
              ['br_if', `$break${loopId}`, ['i32.ge_u', ['local.get', `$${idx}`], ['local.get', `$${len}`]]],
              mutating ? ['drop', loopBody] : ['local.set', `$${acc}`, loopBody],
              ['local.set', `$${idx}`, ['i32.add', ['local.get', `$${idx}`], ['i32.const', 1]]],
              ['br', `$continue${loopId}`]]])

          ir.push(['local.get', `$${acc}`])
          return typed(['block', ['result', 'f64'], ...ir], 'f64')
        }

        // More complex spreads - build full array and pass to method
        const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
        const arrayIR = buildArrayWithSpreads(combined)
        return methodEmitter(objArg, arrayIR)
      }

      // Boxed object: delegate method to inner value (slot 0)
      if (typeof obj === 'string' && ctx.schema.isBoxed?.(obj)) {
        const innerVt = ctx.valTypes?.get(obj)
        const emitter = ctx.emit[`.${innerVt}:${method}`] || ctx.emit[`.${method}`]
        if (emitter) {
          const innerName = `${obj}${T}inner`
          if (!ctx.locals.has(innerName)) ctx.locals.set(innerName, 'f64')
          // Load current inner value from boxed object's slot 0 (may have been updated by prior mutations)
          const loadInner = ['local.set', `$${innerName}`,
            ['f64.load', ['call', '$__ptr_offset', asF64(emit(obj))]]]
          const result = callMethod(innerName, emitter)
          // For mutating methods, writeback inner value to boxed slot 0 (push/pop may reallocate)
          const mutating = ['push', 'pop', 'shift', 'unshift', 'splice', 'reverse', 'sort']
          if (mutating.includes(method)) {
            const wb = ['f64.store', ['call', '$__ptr_offset', asF64(emit(obj))], ['local.get', `$${innerName}`]]
            return typed(['block', ['result', 'f64'], loadInner, asF64(result), wb], 'f64')
          }
          // Non-mutating: just load inner and call
          return typed(['block', ['result', 'f64'], loadInner, asF64(result)], 'f64')
        }
      }

      // Known type → static dispatch
      if (vt && ctx.emit[`.${vt}:${method}`]) {
        return callMethod(obj, ctx.emit[`.${vt}:${method}`])
      }

      // Unknown type, both string + generic exist → runtime dispatch by ptr type
      const strKey = `.string:${method}`, genKey = `.${method}`
      if (!vt && ctx.emit[strKey] && ctx.emit[genKey]) {
        const t = `${T}rt${ctx.uniq++}`, tt = `${T}rtt${ctx.uniq++}`
        ctx.locals.set(t, 'f64'); ctx.locals.set(tt, 'i32')
        const strEmitter = ctx.emit[strKey]
        const genEmitter = ctx.emit[genKey]
        return typed(['block', ['result', 'f64'],
          ['local.set', `$${t}`, asF64(emit(obj))],
          ['local.set', `$${tt}`, ['call', '$__ptr_type', ['local.get', `$${t}`]]],
          ['if', ['result', 'f64'],
            ['i32.or',
              ['i32.eq', ['local.get', `$${tt}`], ['i32.const', 4]],   // STRING
              ['i32.eq', ['local.get', `$${tt}`], ['i32.const', 5]]],  // STRING_SSO
            ['then', callMethod(t, strEmitter)],
            ['else', callMethod(t, genEmitter)]]], 'f64')
      }

      // Schema property function call: x.prop(args) where prop is a closure in boxed schema
      if (typeof obj === 'string' && ctx.schema.find && ctx.fn.call && ctx.schema.isBoxed?.(obj)) {
        const idx = ctx.schema.find(obj, method)
        if (idx >= 0) {
          const propRead = typed(['f64.load', ['i32.add', ['call', '$__ptr_offset', asF64(emit(obj))], ['i32.const', idx * 8]]], 'f64')
          return ctx.fn.call(propRead, parsed.normal)
        }
      }

      // Generic only
      if (ctx.emit[genKey]) {
        return callMethod(obj, ctx.emit[genKey])
      }
    }

    if (ctx.emit[callee]) {
      // Pass spread args through to emitter (e.g. Math.max(...arr))
      if (parsed.hasSpread) {
        const allArgs = []
        let ni = 0
        for (const s of parsed.spreads) {
          while (ni < s.pos) allArgs.push(parsed.normal[ni++])
          allArgs.push(['...', s.expr])
        }
        while (ni < parsed.normal.length) allArgs.push(parsed.normal[ni++])
        return ctx.emit[callee](...allArgs)
      }
      return ctx.emit[callee](...parsed.normal)
    }

    // Direct call if callee is a known top-level function
    if (typeof callee === 'string' && funcNames.has(callee)) {
      const func = funcMap.get(callee)

      // Rest param case: collect all args (including expanded spreads) into array
      if (func?.rest) {
        const fixedParamCount = func.sig.params.length - 1
        const fixedArgs = parsed.normal.slice(0, fixedParamCount)
        // Pad missing fixed args with sentinel for defaults
        const emittedFixed = fixedArgs.map(a => asF64(emit(a)))
        while (emittedFixed.length < fixedParamCount)
          emittedFixed.push(typed(['f64.reinterpret_i64', ['i64.const', NULL_NAN]], 'f64'))

        // Reconstruct with spreads, then take rest args
        const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
        const restArgsFinal = combined.slice(fixedParamCount)

        // Build array: emit code for normal args + code to expand spreads
        const arrayIR = buildArrayWithSpreads(restArgsFinal)
        return typed(['call', `$${callee}`,
          ...emittedFixed,
          arrayIR], 'f64')
      }

      // Regular function call without rest params
      if (parsed.hasSpread) err(`Spread not supported in calls to non-variadic function ${callee}`)
      // Pad missing args with canonical NaN (triggers default param init)
      const args = parsed.normal.map(a => asF64(emit(a)))
      const expected = func?.sig.params.length || args.length
      while (args.length < expected) args.push(typed(['f64.reinterpret_i64', ['i64.const', NULL_NAN]], 'f64'))
      return typed(['call', `$${callee}`, ...args], 'f64')
    }

    // Closure call: callee is a variable holding a NaN-boxed closure pointer
    // Uniform convention: fn.call packs all args into an array
    if (ctx.fn.call) {
      if (parsed.hasSpread) {
        // Spread: build the args array directly (handles __spread markers)
        const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
        const arrayIR = buildArrayWithSpreads(combined)
        // Pass pre-built array as single already-emitted arg
        return ctx.fn.call(emit(callee), [arrayIR], true)
      }
      return ctx.fn.call(emit(callee), parsed.normal)
    }

    // Unknown callee — assume direct call
    return typed(['call', `$${callee}`, ...argList.map(a => asF64(emit(a)))], 'f64')
  },
}

// === Emit dispatch ===

/**
 * Emit single AST node to typed WASM IR.
 * Every returned node has .type = 'i32' | 'f64'.
 * @param {import('./prepare.js').ASTNode} node
 * @returns {Array} typed WASM S-expression
 */
export function emit(node) {
  if (Array.isArray(node) && node.loc != null) ctx.loc = node.loc
  if (node == null) return null
  if (node === true) return typed(['i32.const', 1], 'i32')
  if (node === false) return typed(['i32.const', 0], 'i32')
  if (typeof node === 'symbol') // JZ_NULL sentinel → null NaN
    return typed(['f64.reinterpret_i64', ['i64.const', NULL_NAN]], 'f64')
  if (typeof node === 'bigint') {
    // Wrap to signed i64 range (unsigned values > 2^63-1 become negative)
    let n = node
    if (n > 0x7fffffffffffffffn) n = n - 0x10000000000000000n
    if (n < -0x8000000000000000n) n = n + 0x10000000000000000n
    const hex = n < 0n ? '-0x' + (-n).toString(16) : '0x' + n.toString(16)
    return typed(['f64.reinterpret_i64', ['i64.const', hex]], 'f64')
  }
  if (typeof node === 'number') {
    if (Number.isInteger(node) && node >= -2147483648 && node <= 2147483647)
      return typed(['i32.const', node], 'i32')
    return typed(['f64.const', node], 'f64')
  }
  if (typeof node === 'string') {
    // Boxed variable: load from memory cell (check before emitter table to avoid name collisions)
    if (ctx.boxed?.has(node))
      return typed(['f64.load', boxedAddr(node)], 'f64')
    // Local/param variable: check before emitter table to avoid name collisions (e.g. 'str' vs ctx.emit['str'])
    if (ctx.locals?.has(node) || ctx.sig?.params?.some(p => p.name === node))
      return typed(['local.get', `$${node}`], ctx.locals?.get(node) || ctx.sig?.params.find(p => p.name === node)?.type || 'f64')
    // Module-scope global (check before emitter table — globals like 'Number' shadow emitters when used as values)
    if (isGlobal(node))
      return typed(['global.get', `$${node}`], ctx.globalTypes.get(node) || 'f64')
    // Top-level function used as value → wrap as closure pointer for call_indirect
    if (funcNames.has(node) && !ctx.locals?.has(node) && !ctx.sig?.params?.some(p => p.name === node) && ctx.fn.table) {
      // Generate trampoline: (env, __args) → unpack args, call $func(p0, p1, ...)
      const func = funcMap.get(node)
      const trampolineName = `${T}tramp_${node}`
      if (!ctx.stdlib[trampolineName]) {
        const fwd = func?.sig.params.map((_, i) =>
          `(f64.load (i32.add (call $__ptr_offset (local.get $${T}args)) (i32.const ${i * 8})))`
        ).join(' ') || ''
        ctx.stdlib[trampolineName] = `(func $${trampolineName} (param $__env f64) (param $${T}args f64) (result f64) (call $${node} ${fwd}))`
        ctx.includes.add(trampolineName)
      }
      let idx = ctx.fn.table.indexOf(trampolineName)
      if (idx < 0) { idx = ctx.fn.table.length; ctx.fn.table.push(trampolineName) }
      return typed(['call', '$__mkptr', ['i32.const', 10], ['i32.const', idx], ['i32.const', 0]], 'f64')
    }
    // Emitter table: only namespace-resolved names (contain '.', e.g. 'math.PI') — safe from user variable collision
    if (node.includes('.') && ctx.emit[node]) return ctx.emit[node]()
    const t = ctx.locals?.get(node) || ctx.sig?.params.find(p => p.name === node)?.type || 'f64'
    return typed(['local.get', `$${node}`], t)
  }
  if (!Array.isArray(node)) return typed(['f64.const', 0], 'f64')

  const [op, ...args] = node
  // WASM IR passthrough: if an instruction node reaches emit() (from statement flattening), pass through
  if (typeof op === 'string' && !ctx.emit[op] && /^[a-z]/.test(op)) return node

  // Literal node [, value] — handle null/undefined values
  if (op == null && args.length === 1) {
    const v = args[0]
    return v == null ? typed(['f64.reinterpret_i64', ['i64.const', NULL_NAN]], 'f64') : emit(v)
  }

  const handler = ctx.emit[op]
  if (!handler) err(`Unknown op: ${op}`)
  return handler(...args)
}
