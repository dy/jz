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
 * Per-function state on ctx: locals (Map name→type), stack (loop labels), uid (counter), sig.
 *
 * @module compile
 */

import { parse as parseWat } from 'watr'
import { ctx, err } from './ctx.js'
let funcNames  // Set<string> — known function names, set per compile()

// === Type helpers ===

/** Tag a WASM node with its result type. */
export const typed = (node, type) => (node.type = type, node)

/** Coerce node to f64. */
export const asF64 = n => n.type === 'f64' ? n : typed(['f64.convert_i32_s', n], 'f64')

/** Coerce node to i32. */
export const asI32 = n => n.type === 'i32' ? n : typed(['i32.trunc_f64_s', n], 'i32')

/** Coerce to i32 boolean (for br_if/if conditions). NaN is falsy (like JS). */
function toBool(node) {
  const op = Array.isArray(node) ? node[0] : null
  // Comparisons and ! already emit i32
  if (['>', '<', '>=', '<=', '==', '!=', '!'].includes(op)) return emit(node)
  const e = emit(node)
  if (e.type === 'i32') return e
  // f64: truthy iff non-zero AND not NaN. (eq x x) is false for NaN; (ne x 0) is false for 0
  const t = temp()
  return typed(['i32.and',
    ['f64.eq', ['local.tee', `$${t}`, e], ['local.get', `$${t}`]],
    ['f64.ne', ['local.get', `$${t}`], ['f64.const', 0]]
  ], 'i32')
}

/** Allocate a temp local (always f64 for now), returns name without $. */
function temp() {
  const name = `__${ctx.uid++}`
  ctx.locals.set(name, 'f64')
  return name
}

/** Get current loop labels or throw. */
function loopTop() {
  const top = ctx.stack.at(-1)
  if (!top) err('break/continue outside loop')
  return top
}

/** Find free variables in AST that aren't in the given set (for closure capture). */
function findFreeVars(node, bound, free) {
  if (node == null) return
  if (typeof node === 'string') {
    // Free if: not a param of the inner function, AND exists in outer scope (locals or params)
    const isOuterVar = ctx.locals?.has(node) || ctx.sig?.params.some(p => p.name === node)
    if (!bound.has(node) && isOuterVar && !free.includes(node)) free.push(node)
    return
  }
  if (!Array.isArray(node)) return
  const [op, ...args] = node
  if (op === '=>') return  // don't cross into nested arrows
  for (const a of args) findFreeVars(a, bound, free)
}

/** Emit let/const initializations as typed local.set instructions. */
function emitDecl(...inits) {
  const result = []
  for (const i of inits) {
    if (!Array.isArray(i) || i[0] !== '=') continue
    const [, name, init] = i
    if (typeof name !== 'string' || init == null) continue
    const val = emit(init)
    const localType = ctx.locals.get(name) || 'f64'
    result.push(typed(['local.set', `$${name}`, localType === 'f64' ? asF64(val) : asI32(val)], localType))
  }
  return result.length === 0 ? null : result.length === 1 ? result[0] : result
}

// === Pre-analysis ===

// Value types — what a variable holds (for method dispatch, schema resolution)
export const VAL = {
  NUMBER: 'number', ARRAY: 'array', STRING: 'string',
  OBJECT: 'object', SET: 'set', MAP: 'map',
  CLOSURE: 'closure', TYPED: 'typed',
}

/** Infer value type of an AST expression (without emitting). */
export function valTypeOf(expr) {
  if (expr == null) return null
  if (typeof expr === 'number') return VAL.NUMBER
  if (typeof expr === 'string') return ctx.valTypes?.get(expr) || null
  if (!Array.isArray(expr)) return null

  const [op, ...args] = expr
  if (op == null) return VAL.NUMBER // literal

  if (op === '[') return VAL.ARRAY
  if (op === 'str') return VAL.STRING
  if (op === '=>') return VAL.CLOSURE
  if (op === '{}' && args[0]?.[0] === ':') return VAL.OBJECT

  if (op === '()') {
    const callee = args[0]
    // Constructor results
    if (typeof callee === 'string') {
      if (callee === 'new.Set') return VAL.SET
      if (callee === 'new.Map') return VAL.MAP
      if (callee.startsWith('new.')) return VAL.TYPED
    }
    // Method return types
    if (Array.isArray(callee) && callee[0] === '.') {
      const method = callee[2]
      if (method === 'map' || method === 'filter' || method === 'slice') return VAL.ARRAY
      if (method === 'push') return VAL.ARRAY
      if (method === 'add' || method === 'delete') return VAL.SET
      if (method === 'set') return VAL.MAP
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
  function walk(node) {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === 'let' || op === 'const') {
      for (const a of args) {
        if (!Array.isArray(a) || a[0] !== '=' || typeof a[1] !== 'string') continue
        const vt = valTypeOf(a[2])
        if (vt) types.set(a[1], vt)
      }
    }
    if (op === '=' && typeof args[0] === 'string') {
      const vt = valTypeOf(args[1])
      if (vt) types.set(args[0], vt)
    }
    for (const a of args) walk(a)
  }
  walk(body)
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
        if (!Array.isArray(a) || a[0] !== '=' || typeof a[1] !== 'string') continue
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

    for (const a of args) walk(a)
  }

  walk(body)
  return locals
}

/** Normalize emitter output to flat node array. */
const flat = ir => ir == null ? [] : Array.isArray(ir) && ir.length && Array.isArray(ir[0]) ? ir : [ir]

// === Module compilation ===

/**
 * Compile prepared AST to WASM module IR.
 * @param {import('./prepare.js').ASTNode} ast - Prepared AST
 * @returns {Array} Complete WASM module as S-expression
 */
export default function compile(ast) {
  // Known function names for direct call detection
  funcNames = new Set(ctx.funcs.map(f => f.name))

  const funcs = ctx.funcs.map(func => {
    // Raw WAT functions (e.g., _alloc, _reset from memory module)
    if (func.raw) return parseWat(func.raw)

    const { name, body, exported, sig } = func

    const multi = sig.results.length > 1

    // Reset per-function state
    ctx.stack = []
    ctx.uid = 0
    ctx.sig = sig

    // Pre-analyze local types from body
    // Block body vs object literal: object has ':' property nodes
    const block = Array.isArray(body) && body[0] === '{}' && body[1]?.[0] !== ':'
    ctx.locals = block ? analyzeLocals(body) : new Map()
    ctx.valTypes = new Map()
    if (block) analyzeValTypes(body)

    const fn = ['func', `$${name}`]
    if (exported) fn.push(['export', `"${name}"`])
    fn.push(...sig.params.map(p => ['param', `$${p.name}`, p.type]))
    fn.push(...sig.results.map(t => ['result', t]))

    // Default params: missing JS args become NaN in WASM f64 params
    // Check: if param != param (NaN test), use default value
    const defaults = func.defaults || {}
    const defaultInits = []
    for (const [pname, defVal] of Object.entries(defaults)) {
      const p = sig.params.find(p => p.name === pname)
      const t = p?.type || 'f64'
      defaultInits.push(
        ['if', ['f64.ne', typed(['local.get', `$${pname}`], 'f64'), typed(['local.get', `$${pname}`], 'f64')],
          ['then', ['local.set', `$${pname}`, t === 'f64' ? asF64(emit(defVal)) : asI32(emit(defVal))]]])
    }

    if (block) {
      const stmts = emitBody(body)
      for (const [l, t] of ctx.locals) fn.push(['local', `$${l}`, t])
      fn.push(...defaultInits, ...stmts, ...sig.results.map(() => ['f64.const', 0]))
    } else if (multi && body[0] === '[') {
      for (const [l, t] of ctx.locals) fn.push(['local', `$${l}`, t])
      fn.push(...body.slice(1).map(e => asF64(emit(e))))
    } else {
      const ir = emit(body)
      for (const [l, t] of ctx.locals) fn.push(['local', `$${l}`, t])
      fn.push(...defaultInits, asF64(ir))
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
      ctx.stack = []
      ctx.uid = Math.max(ctx.uid, 100) // avoid label collisions
      ctx.sig = { params: [{ name: '__env', type: 'f64' }, ...cb.params.map(n => ({ name: n, type: 'f64' }))], results: ['f64'] }

      const fn = ['func', `$${cb.name}`]
      fn.push(['param', '$__env', 'f64'])
      fn.push(...cb.params.map(p => ['param', `$${p}`, 'f64']))
      fn.push(['result', 'f64'])

      // Load captured variables from env memory into locals
      for (let i = 0; i < cb.captures.length; i++) {
        const name = cb.captures[i]
        ctx.locals.set(name, 'f64')
      }

      // Emit body
      const block = Array.isArray(cb.body) && cb.body[0] === '{}' && cb.body[1]?.[0] !== ':'
      let bodyIR
      if (block) {
        analyzeLocals(cb.body)  // adds declared locals
        bodyIR = emitBody(cb.body)
      } else {
        bodyIR = [asF64(emit(cb.body))]
      }

      // Insert locals (captures + declared)
      for (const [l, t] of ctx.locals) fn.push(['local', `$${l}`, t])

      // Load captures from env
      for (let i = 0; i < cb.captures.length; i++) {
        fn.push(['local.set', `$${cb.captures[i]}`,
          ['f64.load', ['i32.add', ['call', '$__ptr_offset', ['local.get', '$__env']], ['i32.const', i * 8]]]])
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

  if (ctx.modules.ptr) sections.push(['memory', ['export', '"memory"'], 1])
  if (ctx._hasTag) sections.push(['tag', '$__jz_err', ['param', 'f64']])

  // Table for closures
  if (ctx.fn.table?.length)
    sections.push(['table', ctx.fn.table.length, 'funcref'])

  sections.push(...(ctx.globals || []).map(g => parseWat(g)))
  sections.push(...[...ctx.includes].map(n => parseWat(ctx.stdlib[n])))
  sections.push(...closureFuncs)
  sections.push(...funcs)

  // Element section: populate function table
  if (ctx.fn.table?.length)
    sections.push(['elem', ['i32.const', 0], 'func', ...ctx.fn.table.map(n => `$${n}`)])

  const init = emit(ast)
  if (init?.length) {
    sections.push(['func', '$__start', ...init])
    sections.push(['start', '$__start'])
  }

  // Custom section: embed object schemas for JS-side interop
  if (ctx.schema.list.length)
    sections.push(['@custom', '"jz:schema"', `"${JSON.stringify(ctx.schema.list).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`])

  return ['module', ...sections]
}

/** Emit block body as flat list of WASM instructions. */
function emitBody(node) {
  const inner = node[1]
  const stmts = Array.isArray(inner) && inner[0] === ';' ? inner.slice(1) : [inner]
  const out = []
  for (const s of stmts) {
    if (s == null || typeof s === 'number') continue
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
export const emitter = {
  // === Statements ===

  ';': (...args) => args.map(emit).filter(x => x != null),
  'let': emitDecl,
  'const': emitDecl,
  'export': () => null,

  'throw': expr => {
    ctx._hasTag = true
    return typed(['throw', '$__jz_err', asF64(emit(expr))], 'void')
  },

  'catch': (body, errName, handler) => {
    ctx._hasTag = true
    const id = ctx.uid++
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
    // Tail call: return f(args) — not inside try (return_call bypasses try_table)
    if (!ctx._inTry && Array.isArray(expr) && expr[0] === '()' && typeof expr[1] === 'string' && funcNames.has(expr[1])) {
      const callArgs = Array.isArray(expr[2])
        ? (expr[2][0] === ',' ? expr[2].slice(1) : [expr[2]])
        : expr[2] ? [expr[2]] : []
      return typed(['return_call', `$${expr[1]}`, ...callArgs.map(a => asF64(emit(a)))], 'f64')
    }
    return typed(['return', asF64(emit(expr))], 'f64')
  },

  // === Assignment ===

  '=': (name, val) => {
    // Array index assignment: arr[i] = x → f64.store at offset + i*8
    if (Array.isArray(name) && name[0] === '[]') {
      const [, arr, idx] = name
      const va = emit(arr), vi = asI32(emit(idx)), vv = asF64(emit(val))
      return ['f64.store', ['i32.add', ['call', '$__ptr_offset', asF64(va)], ['i32.shl', vi, ['i32.const', 3]]], vv]
    }
    // Object property assignment: obj.prop = x → f64.store at schema index
    if (Array.isArray(name) && name[0] === '.') {
      const [, obj, prop] = name
      // Delegate to '.' emitter for index calculation, but store instead of load
      if (typeof obj === 'string' && ctx.schema.find) {
        const idx = ctx.schema.find(obj, prop)
        if (idx >= 0) {
          const va = emit(obj), vv = asF64(emit(val))
          return ['f64.store', ['i32.add', ['call', '$__ptr_offset', asF64(va)], ['i32.const', idx * 8]], vv]
        }
      }
    }
    if (typeof name !== 'string') err(`Assignment to non-variable: ${JSON.stringify(name)}`)
    const v = emit(val), t = ctx.locals.get(name) || 'f64'
    return typed(['local.set', `$${name}`, t === 'f64' ? asF64(v) : asI32(v)], t)
  },

  // Compound assignments: read-modify-write with type coercion
  ...Object.fromEntries([
    ['+=', 'add'], ['-=', 'sub'], ['*=', 'mul'],
  ].map(([op, fn]) => [op, (name, val) => {
    const t = ctx.locals.get(name) || 'f64'
    const va = typed(['local.get', `$${name}`], t), vb = emit(val)
    const result = va.type === 'i32' && vb.type === 'i32'
      ? typed([`i32.${fn}`, va, vb], 'i32')
      : typed([`f64.${fn}`, asF64(va), asF64(vb)], 'f64')
    return typed(['local.set', `$${name}`, t === 'f64' ? asF64(result) : asI32(result)], t)
  }])),

  '/=': (name, val) => {
    const t = ctx.locals.get(name) || 'f64'
    const va = asF64(typed(['local.get', `$${name}`], t)), vb = asF64(emit(val))
    return typed(['local.set', `$${name}`, t === 'f64' ? typed(['f64.div', va, vb], 'f64') : asI32(typed(['f64.div', va, vb], 'f64'))], t)
  },

  '%=': (name, val) => {
    const t = ctx.locals.get(name) || 'f64'
    const va = asF64(typed(['local.get', `$${name}`], t)), vb = asF64(emit(val))
    return typed(['local.set', `$${name}`, t === 'f64' ? typed(['f64.rem', va, vb], 'f64') : asI32(typed(['f64.rem', va, vb], 'f64'))], t)
  },

  // === Increment/Decrement (local.tee: set + return new value) ===
  // Postfix resolved in prepare: i++ → (++i) - 1

  '++': name => {
    const t = ctx.locals.get(name) || 'f64'
    const one = t === 'i32' ? ['i32.const', 1] : ['f64.const', 1]
    return typed(['local.tee', `$${name}`, [`${t}.add`, ['local.get', `$${name}`], one]], t)
  },
  '--': name => {
    const t = ctx.locals.get(name) || 'f64'
    const one = t === 'i32' ? ['i32.const', 1] : ['f64.const', 1]
    return typed(['local.tee', `$${name}`, [`${t}.sub`, ['local.get', `$${name}`], one]], t)
  },

  // === Arithmetic (type-preserving) ===

  '+': (a, b) => {
    const va = emit(a), vb = emit(b)
    if (va.type === 'i32' && vb.type === 'i32') return typed(['i32.add', va, vb], 'i32')
    return typed(['f64.add', asF64(va), asF64(vb)], 'f64')
  },
  '-': (a, b) => {
    if (b === undefined) { const v = emit(a); return v.type === 'i32' ? typed(['i32.sub', typed(['i32.const', 0], 'i32'), v], 'i32') : typed(['f64.neg', v], 'f64') }
    const va = emit(a), vb = emit(b)
    if (va.type === 'i32' && vb.type === 'i32') return typed(['i32.sub', va, vb], 'i32')
    return typed(['f64.sub', asF64(va), asF64(vb)], 'f64')
  },
  'u+': a => emit(a),
  'u-': a => { const v = emit(a); return v.type === 'i32' ? typed(['i32.sub', typed(['i32.const', 0], 'i32'), v], 'i32') : typed(['f64.neg', v], 'f64') },
  '*': (a, b) => {
    const va = emit(a), vb = emit(b)
    if (va.type === 'i32' && vb.type === 'i32') return typed(['i32.mul', va, vb], 'i32')
    return typed(['f64.mul', asF64(va), asF64(vb)], 'f64')
  },
  '/': (a, b) => typed(['f64.div', asF64(emit(a)), asF64(emit(b))], 'f64'), // always f64
  '%': (a, b) => typed(['f64.rem', asF64(emit(a)), asF64(emit(b))], 'f64'), // f64 rem (no i32 rem in wasm)

  // === Comparisons (always i32 result) ===

  '==': (a, b) => {
    const va = emit(a), vb = emit(b)
    if (va.type === 'i32' && vb.type === 'i32') return typed(['i32.eq', va, vb], 'i32')
    // Bit-equal: handles both number equality and pointer identity (NaN-boxed)
    return typed(['i64.eq', ['i64.reinterpret_f64', asF64(va)], ['i64.reinterpret_f64', asF64(vb)]], 'i32')
  },
  '!=': (a, b) => {
    const va = emit(a), vb = emit(b)
    if (va.type === 'i32' && vb.type === 'i32') return typed(['i32.ne', va, vb], 'i32')
    return typed(['i64.ne', ['i64.reinterpret_f64', asF64(va)], ['i64.reinterpret_f64', asF64(vb)]], 'i32')
  },
  '<':  (a, b) => { const va = emit(a), vb = emit(b); return va.type === 'i32' && vb.type === 'i32' ? typed(['i32.lt_s', va, vb], 'i32') : typed(['f64.lt', asF64(va), asF64(vb)], 'i32') },
  '>':  (a, b) => { const va = emit(a), vb = emit(b); return va.type === 'i32' && vb.type === 'i32' ? typed(['i32.gt_s', va, vb], 'i32') : typed(['f64.gt', asF64(va), asF64(vb)], 'i32') },
  '<=': (a, b) => { const va = emit(a), vb = emit(b); return va.type === 'i32' && vb.type === 'i32' ? typed(['i32.le_s', va, vb], 'i32') : typed(['f64.le', asF64(va), asF64(vb)], 'i32') },
  '>=': (a, b) => { const va = emit(a), vb = emit(b); return va.type === 'i32' && vb.type === 'i32' ? typed(['i32.ge_s', va, vb], 'i32') : typed(['f64.ge', asF64(va), asF64(vb)], 'i32') },

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
    const vb = emit(b), vc = emit(c)
    if (vb.type === 'i32' && vc.type === 'i32')
      return typed(['select', vb, vc, toBool(a)], 'i32')
    return typed(['select', asF64(vb), asF64(vc), toBool(a)], 'f64')
  },

  '&&': (a, b) => {
    const t = temp()
    const va = emit(a)
    return typed(['if', ['result', 'f64'],
      ['f64.ne', ['local.tee', `$${t}`, asF64(va)], ['f64.const', 0]],
      ['then', asF64(emit(b))],
      ['else', ['local.get', `$${t}`]]], 'f64')
  },

  '||': (a, b) => {
    const t = temp()
    const va = emit(a)
    return typed(['if', ['result', 'f64'],
      ['f64.ne', ['local.tee', `$${t}`, asF64(va)], ['f64.const', 0]],
      ['then', ['local.get', `$${t}`]],
      ['else', asF64(emit(b))]], 'f64')
  },

  // a ?? b: in f64 world null=0, same as || (revisit when null is distinct from 0)
  '??': (a, b) => {
    const t = temp()
    const va = emit(a)
    return typed(['if', ['result', 'f64'],
      ['f64.ne', ['local.tee', `$${t}`, asF64(va)], ['f64.const', 0]],
      ['then', ['local.get', `$${t}`]],
      ['else', asF64(emit(b))]], 'f64')
  },

  'void': a => { emit(a); return typed(['f64.const', 0], 'f64') },

  '(': a => emit(a),

  // === Bitwise (always i32) ===

  '~':   a => typed(['i32.xor', asI32(emit(a)), typed(['i32.const', -1], 'i32')], 'i32'),
  '&':   (a, b) => typed(['i32.and', asI32(emit(a)), asI32(emit(b))], 'i32'),
  '|':   (a, b) => typed(['i32.or', asI32(emit(a)), asI32(emit(b))], 'i32'),
  '^':   (a, b) => typed(['i32.xor', asI32(emit(a)), asI32(emit(b))], 'i32'),
  '<<':  (a, b) => typed(['i32.shl', asI32(emit(a)), asI32(emit(b))], 'i32'),
  '>>':  (a, b) => typed(['i32.shr_s', asI32(emit(a)), asI32(emit(b))], 'i32'),
  '>>>': (a, b) => typed(['i32.shr_u', asI32(emit(a)), asI32(emit(b))], 'i32'),

  // === Control flow ===

  'if': (cond, then, els) => {
    const c = toBool(cond)
    if (els != null) return ['if', c, ['then', emit(then)], ['else', emit(els)]]
    return ['if', c, ['then', emit(then)]]
  },

  'for': (init, cond, step, body) => {
    if (body === undefined) return err('for-in/for-of not supported')
    const id = ctx.uid++
    const brk = `$brk${id}`, loop = `$loop${id}`
    ctx.stack.push({ brk, loop })
    const result = []
    if (init != null) result.push(...flat(emit(init)))
    const loopBody = []
    if (cond) loopBody.push(['br_if', brk, ['i32.eqz', toBool(cond)]])
    loopBody.push(...flat(emit(body)))
    if (step) loopBody.push(...flat(emit(step)))
    loopBody.push(['br', loop])
    result.push(['block', brk, ['loop', loop, ...loopBody]])
    ctx.stack.pop()
    return result.length === 1 ? result[0] : result
  },

  'switch': (discriminant, ...cases) => {
    const disc = `__disc${ctx.uid++}`
    ctx.locals.set(disc, 'f64')

    const result = [typed(['local.set', `$${disc}`, asF64(emit(discriminant))], 'f64')]

    for (const c of cases) {
      if (c[0] === 'case') {
        const [, test, body] = c
        const skip = `$skip${ctx.uid++}`
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

    // Extract param names
    let p = rawParams
    if (Array.isArray(p) && p[0] === '()') p = p[1]
    const params = p == null ? []
      : Array.isArray(p) ? (p[0] === ',' ? p.slice(1) : [p])
      : [p]

    // Find free variables in body that aren't params → captures
    const paramSet = new Set(params)
    const captures = []
    findFreeVars(body, paramSet, captures)

    return ctx.fn.make(params, body, captures)
  },

  '()': (callee, callArgs) => {
    const argList = Array.isArray(callArgs)
      ? (callArgs[0] === ',' ? callArgs.slice(1) : [callArgs])
      : callArgs ? [callArgs] : []

    // Method call: obj.method(args) → type-aware dispatch
    if (Array.isArray(callee) && callee[0] === '.') {
      const [, obj, method] = callee
      const vt = typeof obj === 'string' ? ctx.valTypes.get(obj) : valTypeOf(obj)
      // Known type → static dispatch
      if (vt && ctx.emit[`.${vt}:${method}`]) return ctx.emit[`.${vt}:${method}`](obj, ...argList)
      // Unknown type, both string + generic exist → runtime dispatch by ptr type
      const strKey = `.string:${method}`, genKey = `.${method}`
      if (!vt && ctx.emit[strKey] && ctx.emit[genKey]) {
        const t = `__rt${ctx.uid++}`, tt = `__rtt${ctx.uid++}`
        ctx.locals.set(t, 'f64'); ctx.locals.set(tt, 'i32')
        return typed(['block', ['result', 'f64'],
          ['local.set', `$${t}`, asF64(emit(obj))],
          ['local.set', `$${tt}`, ['call', '$__ptr_type', ['local.get', `$${t}`]]],
          ['if', ['result', 'f64'],
            ['i32.or',
              ['i32.eq', ['local.get', `$${tt}`], ['i32.const', 4]],   // STRING
              ['i32.eq', ['local.get', `$${tt}`], ['i32.const', 5]]],  // STRING_SSO
            ['then', ctx.emit[strKey](t, ...argList)],
            ['else', ctx.emit[genKey](t, ...argList)]]], 'f64')
      }
      // Generic only
      if (ctx.emit[genKey]) return ctx.emit[genKey](obj, ...argList)
    }

    if (ctx.emit[callee]) return ctx.emit[callee](...argList)

    // Direct call if callee is a known top-level function
    if (typeof callee === 'string' && funcNames.has(callee))
      return typed(['call', `$${callee}`, ...argList.map(a => asF64(emit(a)))], 'f64')

    // Closure call: callee is a variable holding a NaN-boxed closure pointer
    if (ctx.fn.call) return ctx.fn.call(emit(callee), argList)

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
  if (typeof node === 'number') {
    if (Number.isInteger(node) && node >= -2147483648 && node <= 2147483647)
      return typed(['i32.const', node], 'i32')
    return typed(['f64.const', node], 'f64')
  }
  if (typeof node === 'string') {
    if (ctx.emit[node]) return ctx.emit[node]()
    const t = ctx.locals?.get(node) || ctx.sig?.params.find(p => p.name === node)?.type || 'f64'
    return typed(['local.get', `$${node}`], t)
  }
  if (!Array.isArray(node)) return typed(['f64.const', 0], 'f64')

  const [op, ...args] = node
  // Literal node [, value] — handle null/undefined values
  if (op == null && args.length === 1) {
    const v = args[0]
    return v == null ? typed(['f64.const', 0], 'f64') : emit(v)
  }

  const handler = ctx.emit[op]
  if (!handler) err(`Unknown op: ${op}`)
  return handler(...args)
}
