/**
 * Compile prepared AST to WASM module (S-expression arrays for watr).
 *
 * Core abstraction: emitter table (ctx.core.emit) maps AST ops → WASM nodes.
 * Base operators defined in `emitter` export; on reset, ctx.core.emit starts as a flat copy
 * of emitter and modules add/override entries directly. No prototype chain.
 * emit(node) dispatches: numbers → i32/f64.const, strings → local.get, arrays → ctx.core.emit[op].
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
import { ctx, err, inc, resolveIncludes, PTR } from './ctx.js'
import {
  T, VAL, STMT_OPS, valTypeOf, analyzeValTypes, analyzeLocals,
  extractParams, classifyParam, collectParamNames,
  findFreeVars, analyzeBoxedCaptures,
} from './analyze.js'
// Re-export for backward compatibility (modules import from compile.js)
export { T, VAL, valTypeOf, extractParams, classifyParam, collectParamNames }
let funcNames  // Set<string> — known function names, set per compile()
let funcMap    // Map<string, func> — name → func info, set per compile()

// === Type helpers ===

/** Tag a WASM node with its result type. */
export const typed = (node, type) => (node.type = type, node)

/** Coerce node to f64. */
export const asF64 = n => n.type === 'f64' ? n : typed(['f64.convert_i32_s', n], 'f64')

/** Coerce node to i32 (saturating — fast, correct for values < 2^31). */
export const asI32 = n => n.type === 'i32' ? n : typed(['i32.trunc_sat_f64_s', n], 'i32')

/** Coerce node to i32 with wrapping (JS `|0` semantics: values > 2^31 wrap to negative). */
const toI32 = n => n.type === 'i32' ? n : typed(['i32.wrap_i64', ['i64.trunc_sat_f64_s', n]], 'i32')

/** Extract i64 from BigInt-as-f64. */
export const asI64 = n => typed(['i64.reinterpret_f64', asF64(n)], 'i64')

/** Wrap i64 result back to BigInt-as-f64. */
const fromI64 = n => typed(['f64.reinterpret_i64', n], 'f64')


/** Null/undefined: one nullish value inside jz. NaN-boxed ATOM (type=0, aux=1, offset=0).
 *  Distinct from 0, NaN, and all pointers. Triggers default params.
 *  At the JS boundary, null and undefined preserve their identity for interop. */
export const NULL_NAN = '0x7FF8000100000000'
export const UNDEF_NAN = '0x7FF8000000000001'
/** WAT-template-ready sentinel expressions for use in stdlib template strings. */
export const NULL_WAT = `(f64.reinterpret_i64 (i64.const ${NULL_NAN}))`
export const UNDEF_WAT = `(f64.reinterpret_i64 (i64.const ${UNDEF_NAN}))`
const NULL_IR = ['f64.reinterpret_i64', ['i64.const', NULL_NAN]]
const nullExpr = () => typed(NULL_IR, 'f64')

const WASM_OPS = new Set(['block','loop','if','then','else','br','br_if','call','call_indirect','return','return_call','throw','try_table','catch','nop','drop','unreachable','select','result','mut','param','func','module','memory','table','elem','data','type','import','export','local','global','ref'])
const SPREAD_MUTATORS = new Set(['push', 'add', 'set', 'unshift'])
const BOXED_MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'reverse', 'sort'])

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
    // 'string' → is NaN-boxed AND ptr_type is STRING (heap) or SSO.
    inc('__ptr_type')
    const isPtr = ['f64.ne', ['local.tee', `$${t}`, va], ['local.get', `$${t}`]]
    const tt = `${T}${ctx.func.uniq++}`; ctx.func.locals.set(tt, 'i32')
    const isStr = ['i32.or',
      ['i32.eq', ['local.tee', `$${tt}`, ['call', '$__ptr_type', ['local.get', `$${t}`]]], ['i32.const', PTR.STRING]],
      ['i32.eq', ['local.get', `$${tt}`], ['i32.const', PTR.SSO]]]
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
    inc('__ptr_type')
    const isPtr = ['f64.ne', ['local.tee', `$${t}`, va], ['local.get', `$${t}`]]
    const check = ['i32.eq', ['call', '$__ptr_type', ['local.get', `$${t}`]], ['i32.const', code]]
    return typed(eq ? ['i32.and', isPtr, check] : ['i32.or', ['i32.eqz', isPtr], ['i32.eqz', check]], 'i32')
  }
  return null
}

/** Check if emitted node is a compile-time constant. */
const isLit = n => (n[0] === 'i32.const' || n[0] === 'f64.const') && typeof n[1] === 'number'
const litVal = n => n[1]
const isNullLit = n => Array.isArray(n) && n.length === 2 && n[0] == null && n[1] == null
const isUndefLit = n => Array.isArray(n) && n.length === 0
const isNullishLit = n => isNullLit(n) || isUndefLit(n)

/** Emit a numeric constant with correct i32/f64 typing. */
const emitNum = v => Number.isInteger(v) && v >= -2147483648 && v <= 2147483647
  ? typed(['i32.const', v], 'i32') : typed(['f64.const', v], 'f64')

/** WASM has no f64.rem — implement as a - trunc(a/b) * b */
const f64rem = (a, b) => typed(['f64.sub', a, ['f64.mul', ['f64.trunc', ['f64.div', a, b]], b]], 'f64')

/** Convert already-emitted WASM node to i32 boolean. NaN is falsy (like JS). */
function toBoolFromEmitted(e) {
  if (e.type === 'i32') return e
  // Truthy: handles regular numbers AND NaN-boxed pointers (strings, arrays, objects)
  inc('__is_truthy')
  return typed(['call', '$__is_truthy', asF64(e)], 'i32')
}

function toBool(node) {
  const op = Array.isArray(node) ? node[0] : null
  if (['>', '<', '>=', '<=', '==', '!=', '!'].includes(op)) return emit(node)
  return toBoolFromEmitted(emit(node))
}

/** Check if name is a module-scope global (not shadowed by local/param). */
function isGlobal(name) {
  return ctx.scope.globals.has(name) && !ctx.func.locals?.has(name) && !ctx.func.current?.params?.some(p => p.name === name)
}

/** Check if assigning to name would violate const. Only applies when not shadowed. */
function isConst(name) {
  return ctx.scope.consts?.has(name) && !ctx.func.locals?.has(name) && !ctx.func.current?.params?.some(p => p.name === name)
}

function keyValType(node) {
  return typeof node === 'string'
    ? (ctx.func.valTypes?.get(node) || ctx.scope.globalValTypes?.get(node))
    : valTypeOf(node)
}

export function usesDynProps(vt) {
  return vt === VAL.ARRAY || vt === VAL.STRING || vt === VAL.CLOSURE
    || vt === VAL.TYPED || vt === VAL.SET || vt === VAL.MAP || vt === VAL.REGEX
}

/** Allocate a temp local, returns name without $. Optional tag aids WAT readability. */
export function temp(tag = '') {
  const name = `${T}${tag}${ctx.func.uniq++}`
  ctx.func.locals.set(name, 'f64')
  return name
}
export function tempI32(tag = '') {
  const name = `${T}${tag}${ctx.func.uniq++}`
  ctx.func.locals.set(name, 'i32')
  return name
}

/** Build a NaN-boxed pointer from a header allocation.
 *  type/aux/stride may be JS numbers; len/cap may be JS numbers or IR.
 *  Returns { local, init, ptr } where:
 *    local — i32 name pointing to data start (post-header)
 *    init  — IR statement that allocates and sets `local`
 *    ptr   — f64 IR expression: __mkptr(type, aux, local).
 *  Caller emits init, fills via local, then uses ptr (or local for further work). */
export function allocPtr({ type, aux = 0, len, cap, stride = 8, tag = 'ap' }) {
  inc('__alloc_hdr', '__mkptr')
  const local = tempI32(tag)
  const irOf = v => typeof v === 'number' ? ['i32.const', v] : v
  const init = ['local.set', `$${local}`,
    ['call', '$__alloc_hdr', irOf(len), irOf(cap == null ? len : cap), ['i32.const', stride]]]
  const ptr = typed(['call', '$__mkptr', ['i32.const', type], irOf(aux), ['local.get', `$${local}`]], 'f64')
  return { local, init, ptr }
}

/** Load f64 element from array data at ptr + i*8. ptr/i are local name strings. */
export function elemLoad(ptr, i) {
  return ['f64.load', ['i32.add', ['local.get', `$${ptr}`], ['i32.shl', ['local.get', `$${i}`], ['i32.const', 3]]]]
}

/** Store f64 val at array data ptr + i*8. ptr/i are local name strings. */
export function elemStore(ptr, i, val) {
  return ['f64.store', ['i32.add', ['local.get', `$${ptr}`], ['i32.shl', ['local.get', `$${i}`], ['i32.const', 3]]], val]
}

/** Emit a loop iterating over array elements. Returns IR instruction list.
 *  bodyFn(ptr, len, i, item) should return an array of IR instructions. */
export function arrayLoop(arrExpr, bodyFn) {
  inc('__ptr_offset', '__len')
  const arr = temp('aa'), ptr = tempI32('ap'), len = tempI32('al'), i = tempI32('ai'), item = temp('av')
  const id = ctx.func.uniq++
  return [
    ['local.set', `$${arr}`, asF64(arrExpr)],
    ['local.set', `$${ptr}`, ['call', '$__ptr_offset', ['local.get', `$${arr}`]]],
    ['local.set', `$${len}`, ['call', '$__len', ['local.get', `$${arr}`]]],
    ['local.set', `$${i}`, ['i32.const', 0]],
    ['block', `$brk${id}`, ['loop', `$loop${id}`,
      ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]],
      ['local.set', `$${item}`, elemLoad(ptr, i)],
      ...bodyFn(ptr, len, i, typed(['local.get', `$${item}`], 'f64')),
      ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
      ['br', `$loop${id}`]]],
  ]
}

// === Variable storage abstraction ===
// Centralizes the boxed/global/local 3-way dispatch (used by =, ++/--, +=, etc.)

/** Get i32 memory address for a boxed variable's cell. Cell locals are always i32. */
function boxedAddr(name) {
  return ['local.get', `$${ctx.func.boxed.get(name)}`]
}

/** Read variable value: boxed → f64.load, global → global.get, local → local.get. */
function readVar(name) {
  if (ctx.func.boxed?.has(name))
    return typed(['f64.load', boxedAddr(name)], 'f64')
  if (isGlobal(name))
    return typed(['global.get', `$${name}`], ctx.scope.globalTypes.get(name) || 'f64')
  const t = ctx.func.locals?.get(name) || ctx.func.current?.params?.find(p => p.name === name)?.type || 'f64'
  return typed(['local.get', `$${name}`], t)
}

/** Write variable value with tee semantics (returns the written value).
 *  valIR is raw emit result — coerced to f64 for boxed/global, to local type for locals. */
function writeVar(name, valIR) {
  if (ctx.func.boxed?.has(name)) {
    const addr = boxedAddr(name), t = temp()
    const v = asF64(valIR)
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, v],
      ['f64.store', addr, ['local.get', `$${t}`]],
      ['local.get', `$${t}`]], 'f64')
  }
  if (isGlobal(name)) {
    const t = temp()
    const v = asF64(valIR)
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, v],
      ['global.set', `$${name}`, ['local.get', `$${t}`]],
      ['local.get', `$${t}`]], 'f64')
  }
  const t = ctx.func.locals.get(name) || 'f64'
  return typed(['local.tee', `$${name}`, t === 'f64' ? asF64(valIR) : asI32(valIR)], t)
}

/** Check if f64 expr is nullish (NULL_NAN or UNDEF_NAN). Returns i32. */
const isNullish = (f64expr) => { inc('__is_nullish'); return typed(['call', '$__is_nullish', f64expr], 'i32') }

/** Check if a call expression targets a multi-value function. Returns result count or 0. */
export function multiCount(callNode) {
  if (!Array.isArray(callNode) || callNode[0] !== '()') return 0
  const name = callNode[1]
  if (typeof name !== 'string') return 0
  const func = funcMap?.get(name)
  return func?.sig.results.length > 1 ? func.sig.results.length : 0
}

/**
 * Materialize a multi-value function call as a heap array.
 * Call → store each result in temp → copy to allocated array → return pointer.
 * callNode is AST: ['()', name, commaOrArgs...]
 */
export function materializeMulti(callNode) {
  const name = callNode[1]
  const func = funcMap.get(name)
  const n = func.sig.results.length
  // Unpack args (may be comma-grouped)
  const rawArgs = callNode.slice(2)
  const argList = rawArgs.length === 1 && Array.isArray(rawArgs[0]) && rawArgs[0][0] === ','
    ? rawArgs[0].slice(1) : rawArgs
  const emittedArgs = argList.map(a => asF64(emit(a)))
  // Pad missing args with sentinel NaN (triggers default param init)
  while (emittedArgs.length < func.sig.params.length)
    emittedArgs.push(nullExpr())
  const temps = Array.from({ length: n }, () => temp())
  const out = allocPtr({ type: 1, len: n, tag: 'marr' })
  const ir = [out.init, ['call', `$${name}`, ...emittedArgs]]
  for (let k = n - 1; k >= 0; k--) ir.push(['local.set', `$${temps[k]}`])
  for (let k = 0; k < n; k++)
    ir.push(['f64.store', ['i32.add', ['local.get', `$${out.local}`], ['i32.const', k * 8]], ['local.get', `$${temps[k]}`]])
  ir.push(out.ptr)
  return typed(['block', ['result', 'f64'], ...ir], 'f64')
}

/** Get current loop labels or throw. */
function loopTop() {
  const top = ctx.func.stack.at(-1)
  if (!top) err('break/continue outside loop')
  return top
}


/** Emit let/const initializations as typed local.set instructions. */
function emitDecl(...inits) {
  const result = []
  for (const i of inits) {
    if (typeof i === 'string') {
      const undef = nullExpr()
      if (ctx.func.boxed.has(i)) {
        const cell = ctx.func.boxed.get(i)
        ctx.func.locals.set(cell, 'i32')
        result.push(
          ['local.set', `$${cell}`, ['call', '$__alloc', ['i32.const', 8]]],
          ['f64.store', ['local.get', `$${cell}`], undef])
        continue
      }
      if (isGlobal(i)) {
        if (!ctx.scope.globalTypes.has(i)) result.push(['global.set', `$${i}`, undef])
        continue
      }
      result.push(['local.set', `$${i}`, undef])
      continue
    }
    if (!Array.isArray(i) || i[0] !== '=') continue
    const [, name, init] = i
    if (typeof name !== 'string' || init == null) continue
    // Push assignment target so a top-level {} can use the merged schema (from Object.assign inference).
    // Stack survives nested emits — only the {} immediately under this `=` peeks the top.
    const isObjLit = Array.isArray(init) && init[0] === '{}'
    if (isObjLit) ctx.schema.targetStack.push(name)
    const val = emit(init)
    if (isObjLit) ctx.schema.targetStack.pop()
    // Boxed variable: allocate cell, store value, cell local holds pointer (i32)
    if (ctx.func.boxed.has(name)) {
      const cell = ctx.func.boxed.get(name)
      ctx.func.locals.set(cell, 'i32')
      result.push(
        ['local.set', `$${cell}`, ['call', '$__alloc', ['i32.const', 8]]],
        ['f64.store', ['local.get', `$${cell}`], asF64(val)])
      continue
    }
    // Module-scope variable → WASM global (only if not shadowed by local/param)
    if (isGlobal(name)) {
      // Already folded to immutable global in pre-fold pass → skip init
      if (ctx.scope.globalTypes.has(name)) continue
      // Non-constant or non-foldable const → mutable global, init in __start
      result.push(['global.set', `$${name}`, asF64(val)])
      continue
    }
    const localType = ctx.func.locals.get(name) || 'f64'
    result.push(['local.set', `$${name}`, localType === 'f64' ? asF64(val) : asI32(val)])

    // Auto-box local variable if it has property assignments
    if (ctx.types._localProps?.has(name) && ctx.schema.vars.has(name)) {
      const schemaId = ctx.schema.vars.get(name)
      const schema = ctx.schema.resolve(name)
      if (schema?.[0] === '__inner__') {
        inc('__alloc', '__mkptr')
        const bt = `${T}bx${ctx.func.uniq++}`
        ctx.func.locals.set(bt, 'i32')
        // Save original value as inner temp for method delegation
        const innerName = `${name}${T}inner`
        ctx.func.locals.set(innerName, 'f64')
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



/** Normalize emit result to instruction list. */
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
  const len = tempI32('len')
  const pos = tempI32('pos')
  const out = allocPtr({ type: 1, len: ['local.get', `$${len}`], tag: 'arr' })
  const result = out.local

  const ir = [
    // Calculate total length
    ['local.set', `$${len}`, ['i32.const', 0]],
  ]

  inc('__len', '__ptr_offset')
  // Emit spread expressions once, store in locals
  // Multi-value function calls get materialized as heap arrays
  for (const sec of sections) {
    if (sec.type === 'spread') {
      sec.local = `${T}sp${ctx.func.uniq++}`
      ctx.func.locals.set(sec.local, 'f64')
      const n = multiCount(sec.expr)
      ir.push(['local.set', `$${sec.local}`, n ? materializeMulti(sec.expr) : asF64(emit(sec.expr))])
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

  ir.push(out.init, ['local.set', `$${pos}`, ['i32.const', 0]])

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
      const slen = `${T}slen${ctx.func.uniq++}`, sidx = `${T}sidx${ctx.func.uniq++}`
      ctx.func.locals.set(slen, 'i32'); ctx.func.locals.set(sidx, 'i32')
      const loopId = ctx.func.uniq++
      ir.push(
        ['local.set', `$${slen}`, ['call', '$__len', ['local.get', `$${sec.local}`]]],
        ['local.set', `$${sidx}`, ['i32.const', 0]],
        ['block', `$break${loopId}`, ['loop', `$loop${loopId}`,
          ['br_if', `$break${loopId}`, ['i32.ge_s', ['local.get', `$${sidx}`], ['local.get', `$${slen}`]]],
          ['f64.store',
            ['i32.add', ['local.get', `$${result}`], ['i32.shl', ['local.get', `$${pos}`], ['i32.const', 3]]],
            ctx.module.modules['string']
              ? ['if', ['result', 'f64'],
                ['i32.or',
                  ['i32.eq', ['call', '$__ptr_type', ['local.get', `$${sec.local}`]], ['i32.const', PTR.STRING]],
                  ['i32.eq', ['call', '$__ptr_type', ['local.get', `$${sec.local}`]], ['i32.const', PTR.SSO]]],
                ['then', (inc('__str_idx'), ['call', '$__str_idx', ['local.get', `$${sec.local}`], ['local.get', `$${sidx}`]])],
                ['else', (inc('__typed_idx'), ['call', '$__typed_idx', ['local.get', `$${sec.local}`], ['local.get', `$${sidx}`]])]]
              : (inc('__typed_idx'), ['call', '$__typed_idx', ['local.get', `$${sec.local}`], ['local.get', `$${sidx}`]])],
          ['local.set', `$${pos}`, ['i32.add', ['local.get', `$${pos}`], ['i32.const', 1]]],
          ['local.set', `$${sidx}`, ['i32.add', ['local.get', `$${sidx}`], ['i32.const', 1]]],
          ['br', `$loop${loopId}`]]]
      )
    }
  }

  ir.push(out.ptr)
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
  funcNames = new Set(ctx.func.list.map(f => f.name))
  funcMap = new Map(ctx.func.list.map(f => [f.name, f]))
  // Include imported functions for call resolution (e.g. template interpolations)
  for (const imp of ctx.module.imports)
    if (imp[3]?.[0] === 'func') funcNames.add(imp[3][1].replace(/^\$/, ''))

  // Check user globals don't conflict with runtime globals (modules loaded after user decls)
  for (const name of ctx.scope.userGlobals)
    if (!ctx.scope.globals.get(name)?.includes('mut f64'))
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
        if (!ctx.scope.globals.has(name) || !ctx.scope.consts?.has(name)) continue
        const v = evalConst(init)
        if (v == null || !isFinite(v)) continue
        const isInt = Number.isInteger(v) && v >= -2147483648 && v <= 2147483647
        ctx.scope.globals.set(name, isInt
          ? `(global $${name} i32 (i32.const ${v}))`
          : `(global $${name} f64 (f64.const ${v}))`)
        ctx.scope.globalTypes.set(name, isInt ? 'i32' : 'f64')
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
          if (!ctx.scope.globalValTypes) ctx.scope.globalValTypes = new Map()
          ctx.scope.globalValTypes.set(decl[1], vt)
          if (vt === VAL.REGEX && ctx.runtime.regex) ctx.runtime.regex.vars.set(decl[1], decl[2])
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
        if (typeof obj === 'string' && (ctx.scope.globals.has(obj) || funcNames.has(obj))) {
          if (!propMap.has(obj)) propMap.set(obj, new Set())
          propMap.get(obj).add(prop)
        }
      }
      for (const a of args) if (Array.isArray(a)) scan(a)
    }
    scan(ast)
    // Also scan function bodies (property assignments like err.loc = pos happen inside functions)
    for (const func of ctx.func.list) if (func.body) scan(func.body)
    for (const [name, props] of propMap) {
      // Merge new properties into existing schema if needed
      if (ctx.schema.vars.has(name)) {
        const existing = ctx.schema.resolve(name)
        const newProps = [...props].filter(p => !existing.includes(p))
        if (newProps.length) {
          const merged = [...existing, ...newProps]
          const mergedId = ctx.schema.register(merged)
          ctx.schema.vars.set(name, mergedId)
        }
        continue
      }
      // Skip props that are extracted as functions (fn.prop = arrow)
      const valueProps = [...props].filter(p => !funcNames.has(`${name}$${p}`))
      if (!valueProps.length) continue
      // Include extracted fn props in schema too (so schema is complete)
      const allProps = [...props]
      const schema = ['__inner__', ...allProps]
      const schemaId = ctx.schema.register(schema)
      ctx.schema.vars.set(name, schemaId)
      // For function variables, ensure a global exists for property storage
      if (funcNames.has(name) && !ctx.scope.globals.has(name))
        ctx.scope.globals.set(name, `(global $${name} (mut f64) (f64.const 0))`)
      // Mark for boxing emission in __start
      if (!ctx.schema.autoBox) ctx.schema.autoBox = new Map()
      ctx.schema.autoBox.set(name, { schemaId, schema })
    }
  }

  const funcs = ctx.func.list.map(func => {
    // Raw WAT functions (e.g., _alloc, _reset from memory module)
    if (func.raw) return parseWat(func.raw)

    const { name, body, exported, sig } = func

    const multi = sig.results.length > 1

    // Reset per-function state
    ctx.func.stack = []
    ctx.func.uniq = 0
    ctx.func.current = sig

    // Pre-analyze local types from body
    // Block body vs object literal: object has ':' property nodes
    const block = Array.isArray(body) && body[0] === '{}' && body[1]?.[0] !== ':'
    ctx.func.locals = block ? analyzeLocals(body) : new Map()
    ctx.func.valTypes = new Map()
    ctx.func.boxed = new Map()  // variable name → cell local name (i32) for mutable capture
    ctx.types._localProps = null  // reset per function
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
      defaultInits.push(
        ['if', isNullish(typed(['local.get', `$${pname}`], 'f64')),
          ['then', ['local.set', `$${pname}`, t === 'f64' ? asF64(emit(defVal)) : asI32(emit(defVal))]]])
    }

    // Box params that are mutably captured: allocate cell, copy param value
    const boxedParamInits = []
    for (const p of sig.params) {
      if (ctx.func.boxed.has(p.name)) {
        const cell = ctx.func.boxed.get(p.name)
        ctx.func.locals.set(cell, 'i32')
        boxedParamInits.push(
          ['local.set', `$${cell}`, ['call', '$__alloc', ['i32.const', 8]]],
          ['f64.store', ['local.get', `$${cell}`], asF64(typed(['local.get', `$${p.name}`], p.type))])
      }
    }

    if (block) {
      const stmts = emitBody(body)
      for (const [l, t] of ctx.func.locals) fn.push(['local', `$${l}`, t])
      fn.push(...defaultInits, ...boxedParamInits, ...stmts, ...sig.results.map(() => ['f64.const', 0]))
    } else if (multi && body[0] === '[') {
      const values = body.slice(1).map(e => asF64(emit(e)))
      for (const [l, t] of ctx.func.locals) fn.push(['local', `$${l}`, t])
      fn.push(...boxedParamInits, ...values)
    } else {
      const ir = emit(body)
      for (const [l, t] of ctx.func.locals) fn.push(['local', `$${l}`, t])
      fn.push(...defaultInits, ...boxedParamInits, asF64(ir))
    }

    return fn
  })

  const closureFuncs = []
  const compilePendingClosures = (startIndex = 0) => {
    const bodies = ctx.closure.bodies || []
    for (let bodyIndex = startIndex; bodyIndex < bodies.length; bodyIndex++) {
      const cb = bodies[bodyIndex]
      const prevSchemaVars = ctx.schema.vars
      const prevTypedElems = ctx.types.typedElem
      // Reset per-function state for closure body
      ctx.func.locals = new Map()
      ctx.func.valTypes = new Map()
      if (cb.valTypes) for (const [name, vt] of cb.valTypes) ctx.func.valTypes.set(name, vt)
      if (cb.schemaVars) ctx.schema.vars = new Map([...prevSchemaVars, ...cb.schemaVars])
      if (cb.typedElems) ctx.types.typedElem = new Map(cb.typedElems)
      else ctx.types.typedElem = prevTypedElems
      // In closure bodies, boxed captures use the original name as both var and cell local
      ctx.func.boxed = cb.boxed ? new Map([...cb.boxed].map(v => [v, v])) : new Map()
      ctx.func.stack = []
      ctx.func.uniq = Math.max(ctx.func.uniq, 100) // avoid label collisions
      // Uniform convention: (env: f64, __args: f64) → f64
      ctx.func.current = { params: [{ name: '__env', type: 'f64' }, { name: `${T}args`, type: 'f64' }], results: ['f64'] }

      const fn = ['func', `$${cb.name}`]
      fn.push(['param', '$__env', 'f64'])
      fn.push(['param', `$${T}args`, 'f64'])
      fn.push(['result', 'f64'])

      // Params are locals unpacked from args array
      for (const p of cb.params) ctx.func.locals.set(p, 'f64')

      // Register captured variable locals: boxed = i32 cell pointer, otherwise f64 value
      for (let i = 0; i < cb.captures.length; i++) {
        const name = cb.captures[i]
        ctx.func.locals.set(name, ctx.func.boxed.has(name) ? 'i32' : 'f64')
      }

      // Emit body
      const block = Array.isArray(cb.body) && cb.body[0] === '{}' && cb.body[1]?.[0] !== ':'
      let bodyIR
      if (block) {
        for (const [k, v] of analyzeLocals(cb.body)) if (!ctx.func.locals.has(k)) ctx.func.locals.set(k, v)
        bodyIR = emitBody(cb.body)
      } else {
        bodyIR = [asF64(emit(cb.body))]
      }

      // Pre-allocate cache locals for env/args unpacking
      const envBase = cb.captures.length > 0 ? `${T}envBase${ctx.func.uniq++}` : null
      if (envBase) { ctx.func.locals.set(envBase, 'i32'); inc('__ptr_offset') }
      let argsBase, argsLen
      if (!cb.rest && cb.params.length > 0) {
        argsBase = `${T}argsBase${ctx.func.uniq++}`
        argsLen = `${T}argsLen${ctx.func.uniq++}`
        ctx.func.locals.set(argsBase, 'i32')
        ctx.func.locals.set(argsLen, 'i32')
      }

      // Insert locals (captures + params + declared)
      for (const [l, t] of ctx.func.locals) fn.push(['local', `$${l}`, t])

      // Load captures from env: boxed → i32.trunc_f64_u (cell pointer), immutable → f64 value
      if (envBase) {
        fn.push(['local.set', `$${envBase}`, ['call', '$__ptr_offset', ['local.get', '$__env']]])
        for (let i = 0; i < cb.captures.length; i++) {
          const name = cb.captures[i]
          const loadEnv = ['f64.load', ['i32.add', ['local.get', `$${envBase}`], ['i32.const', i * 8]]]
          fn.push(['local.set', `$${name}`, ctx.func.boxed.has(name) ? ['i32.trunc_f64_u', loadEnv] : loadEnv])
        }
      }

      // Unpack params from args array (rest param: pass whole array)
      if (cb.rest) {
        fn.push(['local.set', `$${cb.rest}`, ['local.get', `$${T}args`]])
      } else if (argsBase) {
        const argsPtr = `$${T}args`
        inc('__len', '__ptr_offset')
        fn.push(['local.set', `$${argsBase}`, ['call', '$__ptr_offset', ['local.get', argsPtr]]])
        fn.push(['local.set', `$${argsLen}`, ['call', '$__len', ['local.get', argsPtr]]])
        // Unpack with bounds check: if i >= len, use sentinel NaN (triggers default)
        for (let i = 0; i < cb.params.length; i++) {
          fn.push(['local.set', `$${cb.params[i]}`,
            ['if', ['result', 'f64'],
              ['i32.gt_s', ['local.get', `$${argsLen}`], ['i32.const', i]],
              ['then', ['f64.load', ['i32.add', ['local.get', `$${argsBase}`], ['i32.const', i * 8]]]],
              ['else', NULL_IR]]])
        }
      }

      // Default params for closures (check sentinel after unpack)
      if (cb.defaults) {
        for (const [pname, defVal] of Object.entries(cb.defaults)) {
          fn.push(['if', isNullish(['local.get', `$${pname}`]),
            ['then', ['local.set', `$${pname}`, asF64(emit(defVal))]]])
        }
      }
      fn.push(...bodyIR)
      if (block) fn.push(['f64.const', 0]) // fallthrough
      closureFuncs.push(fn)
      ctx.schema.vars = prevSchemaVars
      ctx.types.typedElem = prevTypedElems
    }
  }
  compilePendingClosures()

  // Build module sections — named slots, assembled at the end (no index bookkeeping)
  const sec = {
    extStdlib: [],  // external stdlib (imports that must precede all other imports)
    imports: [...ctx.module.imports],
    types: [],      // function types for call_indirect
    memory: [],     // memory declaration
    data: [],       // data segment (filled after emit)
    tags: [],       // error tags + related exports
    table: [],      // function table (at most one)
    globals: [],    // globals (filled after __start)
    funcs: [],      // closure funcs + regular funcs
    elem: [],       // element section (table init)
    start: [],      // __start func + start directive
    stdlib: [],     // stdlib functions
    customs: [],    // custom sections + exports
  }

  // Function types for call_indirect (one per arity)
  if (ctx.closure.types) {
    for (const arity of ctx.closure.types) {
      const params = [['param', 'f64']] // env
      for (let i = 0; i < arity; i++) params.push(['param', 'f64'])
      sec.types.push(['type', `$ft${arity}`, ['func', ...params, ['result', 'f64']]])
    }
  }

  if (ctx.module.modules.core) {
    const pages = ctx.memory.pages || 1
    if (ctx.memory.shared) sec.imports.push(['import', '"env"', '"memory"', ['memory', pages]])
    else sec.memory.push(['memory', ['export', '"memory"'], pages])
  }

  if (ctx.runtime.throws) {
    ctx.scope.globals.set('__jz_last_err_bits', '(global $__jz_last_err_bits (mut i64) (i64.const 0))')
    sec.tags.push(['tag', '$__jz_err', ['param', 'f64']])
    sec.tags.push(['export', '"__jz_last_err_bits"', ['global', '$__jz_last_err_bits']])
  }

  if (ctx.closure.table?.length)
    sec.table.push(['table', ctx.closure.table.length, 'funcref'])

  sec.funcs.push(...closureFuncs, ...funcs)

  if (ctx.closure.table?.length)
    sec.elem.push(['elem', ['i32.const', 0], 'func', ...ctx.closure.table.map(n => `$${n}`)])

  // Module-scope init code (__start): reset per-function state, emit, collect locals
  ctx.func.locals = new Map()
  ctx.func.valTypes = new Map()
  ctx.func.boxed = new Map()
  ctx.func.stack = []
  ctx.func.current = { params: [], results: [] }
  analyzeValTypes(ast)
  const normalizeIR = ir => !ir?.length ? [] : Array.isArray(ir[0]) ? ir : [ir]
  // Emit sub-module init code first (imports must be initialized before main module)
  const moduleInits = []
  if (ctx.module.moduleInits) {
    for (const mi of ctx.module.moduleInits) {
      analyzeValTypes(mi)
      moduleInits.push(...normalizeIR(emit(mi)))
    }
  }
  const init = emit(ast)

  // Auto-boxing: emit boxing code for variables with property assignments
  const boxInit = []
  if (ctx.schema.autoBox) {
    const bt = `${T}box`
    ctx.func.locals.set(bt, 'i32')
    for (const [name, { schemaId, schema }] of ctx.schema.autoBox) {
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

  // Schema name table: if JSON.stringify is used, build runtime table mapping schemaId → key arrays
  const schemaInit = []
  if (ctx.core.includes.has('__stringify') && ctx.schema.list.length) {
    const nSchemas = ctx.schema.list.length
    const stbl = `${T}stbl`
    const sarr = `${T}sarr`
    ctx.func.locals.set(stbl, 'i32')
    ctx.func.locals.set(sarr, 'i32')
    inc('__alloc', '__alloc_hdr', '__mkptr')
    schemaInit.push(
      ['local.set', `$${stbl}`, ['call', '$__alloc', ['i32.const', nSchemas * 8]]],
      ['global.set', '$__schema_tbl', ['local.get', `$${stbl}`]])
    for (let s = 0; s < nSchemas; s++) {
      const keys = ctx.schema.list[s]
      const n = keys.length
      schemaInit.push(
        ['local.set', `$${sarr}`, ['call', '$__alloc_hdr', ['i32.const', n], ['i32.const', n], ['i32.const', 8]]])
      for (let k = 0; k < n; k++)
        schemaInit.push(
          ['f64.store', ['i32.add', ['local.get', `$${sarr}`], ['i32.const', k * 8]],
            emit(['str', String(keys[k])])])
      schemaInit.push(
        ['f64.store', ['i32.add', ['local.get', `$${stbl}`], ['i32.const', s * 8]],
          ['call', '$__mkptr', ['i32.const', PTR.ARRAY], ['i32.const', 0], ['local.get', `$${sarr}`]]])
    }
  }

  if (moduleInits.length || init?.length || boxInit.length || schemaInit.length) {
    const initIR = normalizeIR(init)
    const startFn = ['func', '$__start']
    for (const [l, t] of ctx.func.locals) startFn.push(['local', `$${l}`, t])
    startFn.push(...boxInit, ...schemaInit, ...moduleInits, ...initIR)
    sec.start.push(startFn, ['start', '$__start'])
  }

  // Late closures (compiled during __start emit) — prepend before earlier closures
  const compiledClosureCount = closureFuncs.length
  compilePendingClosures(compiledClosureCount)
  if (closureFuncs.length > compiledClosureCount)
    sec.funcs.unshift(...closureFuncs.slice(compiledClosureCount))

  // Finalize function table + element section (table may grow during __start emit)
  if (ctx.closure.table?.length) {
    sec.table = [['table', ctx.closure.table.length, 'funcref']]
    sec.elem = [['elem', ['i32.const', 0], 'func', ...ctx.closure.table.map(n => `$${n}`)]]
  }

  // Resolve stdlib AFTER __start emit — inc() calls during __start must be captured
  resolveIncludes()
  for (const [name, fnStr] of Object.entries(ctx.core.stdlib)) {
    if (name.startsWith('__ext_') && ctx.core.includes.has(name)) {
      const parsed = parseWat(fnStr)
      sec.extStdlib.push(parsed[0] === "module" ? parsed[1] : parsed)
      ctx.core.includes.delete(name)
    }
  }
  sec.stdlib.push(...[...ctx.core.includes].map(n => parseWat(ctx.core.stdlib[n])))

  // Adjust heap base past data section (data at offset 0 may exceed 1024 bytes)
  const dataLen = ctx.runtime.data?.length || 0
  if (dataLen > 1024 && !ctx.memory.shared) {
    const heapBase = (dataLen + 7) & ~7 // align to 8
    ctx.scope.globals.set('__heap', `(global $__heap (mut i32) (i32.const ${heapBase}))`)
    // Patch __reset in stdlib to use correct heap base
    for (const s of sec.stdlib)
      if (s[0] === 'func' && s[1] === '$__reset')
        for (let i = 2; i < s.length; i++)
          if (Array.isArray(s[i]) && s[i][0] === 'global.set' && Array.isArray(s[i][2]) && s[i][2][0] === 'i32.const')
            s[i][2][1] = `${heapBase}`
  }

  // Populate globals (after __start — const folding may update declarations)
  sec.globals.push(...[...ctx.scope.globals.values()].filter(g => g).map(g => parseWat(g)))

  // Data segment (after emit — string literals append to ctx.runtime.data during emit)
  // Skip for shared memory — data at address 0 would overwrite other modules' data
  if (ctx.runtime.data && !ctx.memory.shared) {
    let esc = ''
    for (let i = 0; i < ctx.runtime.data.length; i++) {
      const c = ctx.runtime.data.charCodeAt(i)
      if (c >= 32 && c < 127 && c !== 34 && c !== 92) esc += ctx.runtime.data[i]
      else esc += '\\' + c.toString(16).padStart(2, '0')
    }
    sec.data.push(['data', ['i32.const', 0], '"' + esc + '"'])
  }

  // Custom section: embed object schemas for JS-side interop
  if (ctx.schema.list.length)
    sec.customs.push(['@custom', '"jz:schema"', `"${JSON.stringify(ctx.schema.list).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`])

  // Custom section: rest params for exported functions (JS-side wrapping)
  const restParamFuncs = ctx.func.list.filter(f => f.exported && f.rest)
    .map(f => ({ name: f.name, fixed: f.sig.params.length - 1 }))
  if (restParamFuncs.length)
    sec.customs.push(['@custom', '"jz:rest"', `"${JSON.stringify(restParamFuncs).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`])

  // Named export aliases: export { name } or export { source as alias }
  for (const [name, val] of Object.entries(ctx.func.exports)) {
    if (val === true) {
      if (ctx.scope.userGlobals?.has(name)) sec.customs.push(['export', `"${name}"`, ['global', `$${name}`]])
      continue
    }
    if (typeof val !== 'string') continue
    const func = ctx.func.list.find(f => f.name === val)
    if (func) sec.customs.push(['export', `"${name}"`, ['func', `$${val}`]])
    else if (ctx.scope.globals.has(val)) sec.customs.push(['export', `"${name}"`, ['global', `$${val}`]])
  }

  // Assemble: named slots → flat section list
  const sections = [
    ...sec.extStdlib, ...sec.imports, ...sec.types, ...sec.memory, ...sec.data,
    ...sec.tags, ...sec.table, ...sec.globals, ...sec.funcs, ...sec.elem,
    ...sec.start, ...sec.stdlib, ...sec.customs,
  ]
  return ['module', ...sections]
}

/** Check if node is a block body (statement list, not object literal/expression) */
const isBlockBody = n => Array.isArray(n) && n[0] === '{}' && n.length === 2 && Array.isArray(n[1]) && STMT_OPS.has(n[1]?.[0])

/** Emit node in void context: emit + drop any value. Block bodies route through emitBody. */
export function emitFlat(node) {
  if (isBlockBody(node)) return emitBody(node)
  const ir = emit(node)
  const items = flat(ir)
  if (ir?.type && ir.type !== 'void') items.push('drop')
  return items
}

/** Emit block body as flat list of WASM instructions. Unwraps {} and delegates to emitFlat per statement. */
function emitBody(node) {
  const inner = node[1]
  const stmts = Array.isArray(inner) && inner[0] === ';' ? inner.slice(1) : [inner]
  const out = []
  for (const s of stmts) {
    if (s == null || typeof s === 'number') continue
    out.push(...emitFlat(s))
  }
  return out
}

// === Emitter table ===

/**
 * Core emitter table. Maps AST ops to WASM IR generators.
 * ctx.core.emit is seeded with a flat copy of this object on reset;
 * modules add or override ops on ctx.core.emit directly.
 * @type {Record<string, (...args: any[]) => Array>}
 */
/** Comparison op factory with constant folding. */
const cmpOp = (i32op, f64op, fn) => (a, b) => {
  const va = emit(a), vb = emit(b)
  if (isLit(va) && isLit(vb)) return emitNum(fn(litVal(va), litVal(vb)) ? 1 : 0)
  return va.type === 'i32' && vb.type === 'i32'
    ? typed([`i32.${i32op}`, va, vb], 'i32') : typed([`f64.${f64op}`, asF64(va), asF64(vb)], 'i32')
}

/** Compound assignment: read → op → write back (via readVar/writeVar). */
function compoundAssign(name, val, f64op, i32op) {
  if (typeof name === 'string' && isConst(name)) err(`Assignment to const '${name}'`)
  const va = readVar(name), vb = emit(val)
  if (i32op && va.type === 'i32' && vb.type === 'i32')
    return writeVar(name, i32op(va, vb))
  return writeVar(name, f64op(asF64(va), asF64(vb)))
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
      if (r?.type && r.type !== 'void') out.push('drop')
    }
    return out
  },
  '{': (...args) => args.map(emit).filter(x => x != null),
  ',': (...args) => {
    const results = args.map(emit).filter(x => x != null)
    if (results.length === 0) return null
    if (results.length === 1) return results[0]
    const last = results[results.length - 1]
    // Flatten: multi-instruction arrays (from ';') need spreading, typed nodes need drop
    const spread = r => Array.isArray(r) && Array.isArray(r[0]) ? r : [r]
    const dropSpread = r => r.type ? [['drop', r]] : spread(r)
    // If last expression is void (store, etc.), add explicit return value
    if (!last.type) {
      return typed(['block', ['result', 'f64'],
        ...results.flatMap(dropSpread),
        ['f64.const', 0]], 'f64')
    }
    return typed(['block', ['result', last.type],
      ...results.slice(0, -1).flatMap(dropSpread), last], last.type)
  },
  'let': emitDecl,
  'const': emitDecl,
  'export': () => null,
  // 'block' can appear from jzify transforming labeled blocks or as WASM block IR
  'block': (...args) => {
    // WASM block IR: first arg is ['result', type] → pass through, preserve type
    if (Array.isArray(args[0]) && args[0][0] === 'result')
      return typed(['block', ...args], args[0][1])
    const inner = args.length === 1 ? args[0] : [';', ...args]
    return emitFlat(['{}', inner])
  },

  'throw': expr => {
    ctx.runtime.throws = true
    const thrown = temp()
    return typed(['block',
      ['local.set', `$${thrown}`, asF64(emit(expr))],
      ['global.set', '$__jz_last_err_bits', ['i64.reinterpret_f64', ['local.get', `$${thrown}`]]],
      ['throw', '$__jz_err', ['local.get', `$${thrown}`]]], 'void')
  },

  'catch': (body, errName, handler) => {
    ctx.runtime.throws = true
    const id = ctx.func.uniq++
    ctx.func.locals.set(errName, 'f64')
    const prev = ctx.runtime._inTry; ctx.runtime._inTry = true
    let bodyIR; try { bodyIR = emitFlat(body) } finally { ctx.runtime._inTry = prev }
    const handlerIR = emitFlat(handler)
    return typed(['block', `$outer${id}`, ['result', 'f64'],
      ['block', `$catch${id}`, ['result', 'f64'],
        ['try_table', ['catch', '$__jz_err', `$catch${id}`],
          ...bodyIR],
        ['f64.const', 0],
        ['br', `$outer${id}`]],
      ['local.set', `$${errName}`],
      ...handlerIR,
      ['f64.const', 0]], 'f64')
  },

  'return': expr => {
    if (ctx.func.current?.results.length > 1 && Array.isArray(expr) && expr[0] === '[')
      return typed(['return', ...expr.slice(1).map(e => asF64(emit(e)))], 'void')
    if (expr == null) return typed(['return', NULL_IR], 'void')
    const ir = asF64(emit(expr))
    if (!ctx.runtime._inTry && Array.isArray(ir) && ir[0] === 'call' && typeof ir[1] === 'string')
      return typed(['return_call', ...ir.slice(1)], 'void')
    return typed(['return', ir], 'void')
  },

  // === Assignment ===

  '=': (name, val) => {
    if (typeof name === 'string' && isConst(name)) err(`Assignment to const '${name}'`)
    // Array index assignment: arr[i] = x
    if (Array.isArray(name) && name[0] === '[]') {
      const [, arr, idx] = name
      const keyType = keyValType(idx)
      const useRuntimeKeyDispatch = keyType == null || (typeof idx === 'string' && keyType !== VAL.STRING)
      const keyExpr = asF64(emit(idx))
      const valueExpr = asF64(emit(val))
      const storeArrayValue = (arrExpr, idxNode, persist) => {
        const arrTmp = `${T}asi${ctx.func.uniq++}`
        const idxTmp = `${T}asj${ctx.func.uniq++}`
        const valTmp = `${T}asv${ctx.func.uniq++}`
        ctx.func.locals.set(arrTmp, 'f64')
        ctx.func.locals.set(idxTmp, 'i32')
        ctx.func.locals.set(valTmp, 'f64')
        inc('__arr_set_idx_ptr')
        const body = [
          ['local.set', `$${arrTmp}`, arrExpr],
          ['local.set', `$${idxTmp}`, asI32(typed(idxNode, 'f64'))],
          ['local.set', `$${valTmp}`, valueExpr],
          ['local.set', `$${arrTmp}`, ['call', '$__arr_set_idx_ptr', ['local.get', `$${arrTmp}`], ['local.get', `$${idxTmp}`], ['local.get', `$${valTmp}`]]],
        ]
        if (persist) body.push(persist(['local.get', `$${arrTmp}`]))
        body.push(['local.get', `$${valTmp}`])
        return typed(['block', ['result', 'f64'], ...body], 'f64')
      }
      const setDyn = () => {
        inc('__dyn_set')
        return typed(['call', '$__dyn_set', asF64(emit(arr)), keyExpr, valueExpr], 'f64')
      }
      const dispatchKey = (numericIR) => {
        const keyTmp = temp()
        return typed(['block', ['result', 'f64'],
          ['local.set', `$${keyTmp}`, keyExpr],
          ['if', ['result', 'f64'], ['call', '$__is_str_key', ['local.get', `$${keyTmp}`]],
            ['then', ['call', '$__dyn_set', asF64(emit(arr)), ['local.get', `$${keyTmp}`], valueExpr]],
            ['else', numericIR(['local.get', `$${keyTmp}`])]]], 'f64')
      }
      if (keyType === VAL.STRING) return setDyn()
      if (typeof arr === 'string' && ctx.func.valTypes?.get(arr) === 'typed' && ctx.core.emit['.typed:[]=']) {
        const r = ctx.core.emit['.typed:[]=']?.(arr, idx, val)
        if (r) return r
      }
      if (typeof arr === 'string' && ctx.schema.isBoxed?.(arr)) {
        const inner = ctx.schema.emitInner(arr)
        const storeNumeric = keyNode => storeArrayValue(inner, keyNode, ptr =>
          ['f64.store', ['call', '$__ptr_offset', asF64(emit(arr))], ptr])
        if (useRuntimeKeyDispatch) {
          inc('__dyn_set', '__is_str_key')
          return dispatchKey(storeNumeric)
        }
        return typed(storeNumeric(keyExpr), 'f64')
      }
      const va = emit(arr), vi = asI32(emit(idx)), vv = valueExpr, t = temp()
      if (typeof arr === 'string' && keyValType(arr) === VAL.ARRAY) {
        const persist = ptr => {
          if (ctx.func.boxed?.has(arr)) return ['f64.store', boxedAddr(arr), ptr]
          if (isGlobal(arr)) return ['global.set', `$${arr}`, ptr]
          return ['local.set', `$${arr}`, ptr]
        }
        if (useRuntimeKeyDispatch) {
          inc('__dyn_set', '__is_str_key')
          return dispatchKey(keyNode => storeArrayValue(asF64(va), keyNode, persist))
        }
        return storeArrayValue(asF64(va), keyExpr, persist)
      }
      if (useRuntimeKeyDispatch) {
        inc('__dyn_set', '__is_str_key')
        return dispatchKey(keyNode => {
          const keyI32 = asI32(typed(keyNode, 'f64'))
          return ['block', ['result', 'f64'],
            ['local.set', `$${t}`, vv],
            ['f64.store', ['i32.add', ['call', '$__ptr_offset', asF64(va)], ['i32.shl', keyI32, ['i32.const', 3]]], ['local.get', `$${t}`]],
            ['local.get', `$${t}`]]
        })
      }
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${t}`, vv],
        ['f64.store', ['i32.add', ['call', '$__ptr_offset', asF64(va)], ['i32.shl', vi, ['i32.const', 3]]], ['local.get', `$${t}`]],
        ['local.get', `$${t}`]], 'f64')
    }
    // Object property assignment: obj.prop = x
    if (Array.isArray(name) && name[0] === '.') {
      const [, obj, prop] = name
      // Schema-based object → f64.store at fixed offset
      if (typeof obj === 'string' && ctx.schema.find) {
        const idx = ctx.schema.find(obj, prop)
        if (idx >= 0) {
          const va = emit(obj), vv = asF64(emit(val)), t = temp()
          inc('__dyn_set')
          return typed(['block', ['result', 'f64'],
            ['local.set', `$${t}`, vv],
            ['f64.store', ['i32.add', ['call', '$__ptr_offset', asF64(va)], ['i32.const', idx * 8]], ['local.get', `$${t}`]],
            ['drop', ['call', '$__dyn_set', asF64(va), asF64(emit(['str', prop])), ['local.get', `$${t}`]]],
            ['local.get', `$${t}`]], 'f64')
        }
      }
      if (typeof obj === 'string') {
        const objType = keyValType(obj)
        if (usesDynProps(objType)) {
          inc('__dyn_set')
          return typed(['call', '$__dyn_set', asF64(emit(obj)), asF64(emit(['str', prop])), asF64(emit(val))], 'f64')
        }
        inc('__hash_set')
        const setCall = typed(['call', '$__hash_set', asF64(emit(obj)), asF64(emit(['str', prop])), asF64(emit(val))], 'f64')
        if (isGlobal(obj)) return typed(['block', ['result', 'f64'],
          ['global.set', `$${obj}`, setCall], ['global.get', `$${obj}`]], 'f64')
        return typed(['local.tee', `$${obj}`, setCall], 'f64')
      }
      inc('__dyn_set')
      return typed(['call', '$__dyn_set', asF64(emit(obj)), asF64(emit(['str', prop])), asF64(emit(val))], 'f64')
    }
    if (typeof name !== 'string') err(`Assignment to non-variable: ${JSON.stringify(name)}`)
    return writeVar(name, emit(val))
  },

  // Compound assignments: read-modify-write with type coercion
  '+=': (name, val) => {
    // String concatenation: desugar to name = name + val (+ handler knows about strings)
    const vt = typeof name === 'string' ? keyValType(name) : null
    const vtB = keyValType(val)
    if (vt === VAL.STRING || vtB === VAL.STRING) return emit(['=', name, ['+', name, val]])
    return compoundAssign(name, val, (a, b) => typed(['f64.add', a, b], 'f64'), (a, b) => typed(['i32.add', a, b], 'i32'))
  },
  ...Object.fromEntries([
    ['-=', 'sub'], ['*=', 'mul'], ['/=', 'div'],
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
    (a, b) => asF64(typed([`i32.${fn}`, toI32(a), toI32(b)], 'i32')),
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
    const va = readVar(name)
    // Condition: ||= → truthy check, &&= → truthy check, ??= → nullish check
    const cond = op === '??='
      ? isNullish(['local.tee', `$${t}`, asF64(va)])
      : ['i32.and',
          ['f64.eq', ['local.tee', `$${t}`, asF64(va)], ['local.get', `$${t}`]],
          ['f64.ne', ['local.get', `$${t}`], ['f64.const', 0]]]
    // &&= and ??= assign when cond is true (truthy / nullish); ||= assigns when cond is false
    const [thenExpr, elseExpr] = op === '||='
      ? [['local.get', `$${t}`], asF64(emit(val))]
      : [asF64(emit(val)), ['local.get', `$${t}`]]
    const result = typed(['if', ['result', 'f64'], cond, ['then', thenExpr], ['else', elseExpr]], 'f64')
    // Write back (handles boxed/global/local)
    if (ctx.func.boxed?.has(name)) {
      const bt = temp()
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${bt}`, result],
        ['f64.store', boxedAddr(name), ['local.get', `$${bt}`]],
        ['local.get', `$${bt}`]], 'f64')
    }
    return writeVar(name, result)
  }])),

  // === Increment/Decrement ===
  // Postfix resolved in prepare: i++ → (++i) - 1

  ...Object.fromEntries([['++', 'add'], ['--', 'sub']].map(([op, fn]) => [op, name => {
    if (typeof name === 'string' && isConst(name)) err(`Assignment to const '${name}'`)
    const v = readVar(name)
    const one = v.type === 'i32' ? ['i32.const', 1] : ['f64.const', 1]
    return writeVar(name, typed([`${v.type}.${fn}`, v, one], v.type))
  }])),

  // === Arithmetic (type-preserving) ===

  '+': (a, b) => {
    // String concatenation: if either operand is known string, use __str_concat
    const vtA = keyValType(a)
    const vtB = keyValType(b)
    if (vtA === VAL.STRING || vtB === VAL.STRING) {
      inc('__str_concat')
      return typed(['call', '$__str_concat', asF64(emit(a)), asF64(emit(b))], 'f64')
    }
    if (vtA === VAL.BIGINT || vtB === VAL.BIGINT)
      return fromI64(['i64.add', asI64(emit(a)), asI64(emit(b))])
    // Runtime string dispatch: if either operand type is unknown and string module loaded, check at runtime
    if ((vtA == null || vtB == null) && ctx.core.stdlib['__str_concat']) {
      const tA = temp('add'), tB = temp('add')
      inc('__str_concat', '__is_str_key')
      return typed(['if', ['result', 'f64'],
        ['i32.or',
          ['call', '$__is_str_key', ['local.tee', `$${tA}`, asF64(emit(a))]],
          ['call', '$__is_str_key', ['local.tee', `$${tB}`, asF64(emit(b))]]],
        ['then', ['call', '$__str_concat', ['local.get', `$${tA}`], ['local.get', `$${tB}`]]],
        ['else', ['f64.add', ['local.get', `$${tA}`], ['local.get', `$${tB}`]]]
      ], 'f64')
    }
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
  'u+': a => {
    if (valTypeOf(a) === VAL.BIGINT)
      return typed(['f64.convert_i64_s', asI64(emit(a))], 'f64')
    inc('__to_num')
    return typed(['call', '$__to_num', asF64(emit(a))], 'f64')
  },
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
    // JS loose nullish equality: x == null / x == undefined
    if (isNullishLit(a)) { inc('__is_nullish'); return typed(['call', '$__is_nullish', asF64(emit(b))], 'i32') }
    if (isNullishLit(b)) { inc('__is_nullish'); return typed(['call', '$__is_nullish', asF64(emit(a))], 'i32') }
    // typeof x == 'string' → compile-time type check (prepare rewrites string to type code)
    const tc = emitTypeofCmp(a, b, 'eq'); if (tc) return tc
    const va = emit(a), vb = emit(b)
    if (va.type === 'i32' && vb.type === 'i32') return typed(['i32.eq', va, vb], 'i32')
    inc('__eq')
    return typed(['call', '$__eq', asF64(va), asF64(vb)], 'i32')
  },
  '!=': (a, b) => {
    if (isNullishLit(a)) { inc('__is_nullish'); return typed(['i32.eqz', ['call', '$__is_nullish', asF64(emit(b))]], 'i32') }
    if (isNullishLit(b)) { inc('__is_nullish'); return typed(['i32.eqz', ['call', '$__is_nullish', asF64(emit(a))]], 'i32') }
    const tc = emitTypeofCmp(a, b, 'ne'); if (tc) return tc
    const va = emit(a), vb = emit(b)
    if (va.type === 'i32' && vb.type === 'i32') return typed(['i32.ne', va, vb], 'i32')
    inc('__eq')
    return typed(['i32.eqz', ['call', '$__eq', asF64(va), asF64(vb)]], 'i32')
  },
  '<':  cmpOp('lt_s', 'lt', (a, b) => a < b),
  '>':  cmpOp('gt_s', 'gt', (a, b) => a > b),
  '<=': cmpOp('le_s', 'le', (a, b) => a <= b),
  '>=': cmpOp('ge_s', 'ge', (a, b) => a >= b),

  // === Logical ===

  '!': a => {
    const v = emit(a)
    if (v.type === 'i32') return typed(['i32.eqz', v], 'i32')
    inc('__is_truthy')
    return typed(['i32.eqz', ['call', '$__is_truthy', asF64(v)]], 'i32')
  },

  '?:': (a, b, c) => {
    // Constant condition → emit only the live branch
    const ca = emit(a)
    if (isLit(ca)) { const v = litVal(ca); return (v !== 0 && v === v) ? emit(b) : emit(c) }
    const cond = toBoolFromEmitted(ca)
    const vb = emit(b), vc = emit(c)
    if (vb.type === 'i32' && vc.type === 'i32')
      return typed(['if', ['result', 'i32'], cond, ['then', vb], ['else', vc]], 'i32')
    return typed(['if', ['result', 'f64'], cond, ['then', asF64(vb)], ['else', asF64(vc)]], 'f64')
  },

  '&&': (a, b) => {
    const va = emit(a)
    if (isLit(va)) { const v = litVal(va); return (v !== 0 && v === v) ? emit(b) : va }
    const t = temp()
    const teed = typed(['local.tee', `$${t}`, asF64(va)], 'f64')
    return typed(['if', ['result', 'f64'],
      toBoolFromEmitted(teed),
      ['then', asF64(emit(b))],
      ['else', ['local.get', `$${t}`]]], 'f64')
  },

  '||': (a, b) => {
    const va = emit(a)
    if (isLit(va)) { const v = litVal(va); return (v !== 0 && v === v) ? va : emit(b) }
    const t = temp()
    const teed = typed(['local.tee', `$${t}`, asF64(va)], 'f64')
    return typed(['if', ['result', 'f64'],
      toBoolFromEmitted(teed),
      ['then', ['local.get', `$${t}`]],
      ['else', asF64(emit(b))]], 'f64')
  },

  // a ?? b: returns b only if a is nullish
  '??': (a, b) => {
    const va = emit(a)
    const t = temp()
    return typed(['if', ['result', 'f64'],
      // Check: is a NOT nullish?
      ['i32.eqz', isNullish(['local.tee', `$${t}`, asF64(va)])],
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

  '~':   a => { const v = emit(a); return isLit(v) ? emitNum(~litVal(v)) : typed(['i32.xor', toI32(v), typed(['i32.const', -1], 'i32')], 'i32') },
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
    return typed([`i32.${fn}`, toI32(va), toI32(vb)], 'i32')
  }])),
  '>>>': (a, b) => { const va = emit(a), vb = emit(b); return isLit(va) && isLit(vb) ? emitNum(litVal(va) >>> litVal(vb)) : typed(['i32.shr_u', toI32(va), toI32(vb)], 'i32') },

  // === Control flow ===

  'if': (cond, then, els) => {
    // Dead branch elimination: constant condition → emit only the live branch
    const ce = emit(cond)
    if (isLit(ce)) {
      const v = litVal(ce), truthy = v !== 0 && v === v
      if (truthy) return emitFlat(then)
      if (els != null) return emitFlat(els)
      return null
    }
    const c = ce.type === 'i32' ? ce : toBoolFromEmitted(ce)
    const thenBody = emitFlat(then)
    if (els != null)
      return ['if', c, ['then', ...thenBody], ['else', ...emitFlat(els)]]
    return ['if', c, ['then', ...thenBody]]
  },

  'for': (init, cond, step, body) => {
    if (body === undefined) return err('for-in/for-of not supported')
    const id = ctx.func.uniq++
    const brk = `$brk${id}`, loop = `$loop${id}`
    ctx.func.stack.push({ brk, loop })
    const result = []
    if (init != null) result.push(...emitFlat(init))
    const loopBody = []
    if (cond) loopBody.push(['br_if', brk, ['i32.eqz', toBool(cond)]])
    loopBody.push(...emitFlat(body))
    if (step) loopBody.push(...emitFlat(step))
    loopBody.push(['br', loop])
    result.push(['block', brk, ['loop', loop, ...loopBody]])
    ctx.func.stack.pop()
    return result.length === 1 ? result[0] : result
  },

  'switch': (discriminant, ...cases) => {
    const disc = `${T}disc${ctx.func.uniq++}`
    ctx.func.locals.set(disc, 'f64')

    const result = [['local.set', `$${disc}`, asF64(emit(discriminant))]]

    for (const c of cases) {
      if (c[0] === 'case') {
        const [, test, body] = c
        const skip = `$skip${ctx.func.uniq++}`
        // Block: skip if discriminant != test, otherwise execute body
        result.push(['block', skip,
          ['br_if', skip, typed(['f64.ne', typed(['local.get', `$${disc}`], 'f64'), asF64(emit(test))], 'i32')],
          ...emitFlat(body)])
      } else if (c[0] === 'default') {
        result.push(...emitFlat(c[1]))
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
    if (!ctx.closure.make) err('Closures require fn module (auto-included)')

    const raw = extractParams(rawParams)
    const params = [], defaults = {}
    let restParam = null, bodyPrefix = []
    for (const r of raw) {
      const c = classifyParam(r)
      if (c.kind === 'rest') { restParam = c.name; params.push(c.name) }
      else if (c.kind === 'plain') params.push(c.name)
      else if (c.kind === 'default') { params.push(c.name); defaults[c.name] = c.defValue }
      else {
        const tmp = `${T}p${ctx.func.uniq++}`
        params.push(tmp)
        if (c.kind === 'destruct-default') defaults[tmp] = c.defValue
        bodyPrefix.push(['let', ['=', c.pattern, tmp]])
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
    return ctx.closure.make(closureInfo)
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
            emittedArgs.push(nullExpr())
          return typed(['call', `$${fname}`, ...emittedArgs], 'f64')
        }
      }

      const vt = keyValType(obj)

      // Helper to call method with arguments (handles spread expansion)
      const callMethod = (objArg, methodEmitter) => {
        if (!parsed.hasSpread) {
          return methodEmitter(objArg, ...parsed.normal)
        }

        // Single spread at end: call method with normal args, then loop spread elements
        if (parsed.spreads.length === 1 && parsed.spreads[0].pos === parsed.normal.length) {
          const spreadExpr = parsed.spreads[0].expr
          const acc = `${T}acc${ctx.func.uniq++}`, arr = `${T}sp${ctx.func.uniq++}`, len = `${T}splen${ctx.func.uniq++}`, idx = `${T}spidx${ctx.func.uniq++}`
          ctx.func.locals.set(acc, 'f64'); ctx.func.locals.set(arr, 'f64')
          ctx.func.locals.set(len, 'i32'); ctx.func.locals.set(idx, 'i32')

          // In-place spread methods modify target; accumulating methods (concat) return new values
          const inPlace = SPREAD_MUTATORS.has(method)
          const ir = []
          ir.push(['local.set', `$${acc}`, asF64(emit(objArg))])
          if (parsed.normal.length > 0) {
            const r = asF64(methodEmitter(objArg, ...parsed.normal))
            ir.push(inPlace ? ['drop', r] : ['local.set', `$${acc}`, r])
          }

          inc('__len')
          const n = multiCount(spreadExpr)
          ir.push(['local.set', `$${arr}`, n ? materializeMulti(spreadExpr) : asF64(emit(spreadExpr))])
          ir.push(['local.set', `$${len}`, ['call', '$__len', ['local.get', `$${arr}`]]])
          ir.push(['local.set', `$${idx}`, ['i32.const', 0]])
          const loopId = ctx.func.uniq++
          const loopBody = asF64(methodEmitter(acc, ['[]', arr, idx]))
          ir.push(['block', `$break${loopId}`,
            ['loop', `$continue${loopId}`,
              ['br_if', `$break${loopId}`, ['i32.ge_u', ['local.get', `$${idx}`], ['local.get', `$${len}`]]],
              inPlace ? ['drop', loopBody] : ['local.set', `$${acc}`, loopBody],
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
        const innerVt = ctx.func.valTypes?.get(obj)
        const emitter = ctx.core.emit[`.${innerVt}:${method}`] || ctx.core.emit[`.${method}`]
        if (emitter) {
          const innerName = `${obj}${T}inner`
          if (!ctx.func.locals.has(innerName)) ctx.func.locals.set(innerName, 'f64')
          const boxBase = tempI32('bb')
          // Load current inner value from boxed object's slot 0 (may have been updated by prior mutations)
          const loadInner = [
            ['local.set', `$${boxBase}`, ['call', '$__ptr_offset', asF64(emit(obj))]],
            ['local.set', `$${innerName}`, ['f64.load', ['local.get', `$${boxBase}`]]]]
          const result = callMethod(innerName, emitter)
          // Mutating methods may reallocate; writeback inner value to boxed slot
          if (BOXED_MUTATORS.has(method)) {
            const wb = ['f64.store', ['local.get', `$${boxBase}`], ['local.get', `$${innerName}`]]
            return typed(['block', ['result', 'f64'], ...loadInner, asF64(result), wb], 'f64')
          }
          // Non-mutating: just load inner and call
          return typed(['block', ['result', 'f64'], ...loadInner, asF64(result)], 'f64')
        }
      }

      // Known type → static dispatch
      if (vt && ctx.core.emit[`.${vt}:${method}`]) {
        return callMethod(obj, ctx.core.emit[`.${vt}:${method}`])
      }

      // Unknown type, both string + generic exist → runtime dispatch by ptr type
      const strKey = `.string:${method}`, genKey = `.${method}`
      if (!vt && ctx.core.emit[strKey] && ctx.core.emit[genKey]) {
        const t = `${T}rt${ctx.func.uniq++}`, tt = `${T}rtt${ctx.func.uniq++}`
        ctx.func.locals.set(t, 'f64'); ctx.func.locals.set(tt, 'i32')
        const strEmitter = ctx.core.emit[strKey]
        const genEmitter = ctx.core.emit[genKey]
        return typed(['block', ['result', 'f64'],
          ['local.set', `$${t}`, asF64(emit(obj))],
          ['local.set', `$${tt}`, ['call', '$__ptr_type', ['local.get', `$${t}`]]],
          ['if', ['result', 'f64'],
            ['i32.or',
              ['i32.eq', ['local.get', `$${tt}`], ['i32.const', PTR.STRING]],
              ['i32.eq', ['local.get', `$${tt}`], ['i32.const', PTR.SSO]]],
            ['then', callMethod(t, strEmitter)],
            ['else', callMethod(t, genEmitter)]]], 'f64')
      }

      // Schema property function call: x.prop(args) where prop is a closure in boxed schema
      if (typeof obj === 'string' && ctx.schema.find && ctx.closure.call && ctx.schema.isBoxed?.(obj)) {
        const idx = ctx.schema.find(obj, method)
        if (idx >= 0) {
          const propRead = typed(['f64.load', ['i32.add', ['call', '$__ptr_offset', asF64(emit(obj))], ['i32.const', idx * 8]]], 'f64')
          return ctx.closure.call(propRead, parsed.normal)
        }
      }

      // Generic only
      if (ctx.core.emit[genKey]) {
        return callMethod(obj, ctx.core.emit[genKey])
      }

      // Dynamic property function call on non-external values.
      if (ctx.closure.call) {
        const objTmp = `${T}mobj${ctx.func.uniq++}`
        ctx.func.locals.set(objTmp, 'f64')
        const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
        const arrayIR = buildArrayWithSpreads(combined)
        const propRead = typed(['call', '$__dyn_get_expr', ['local.get', `$${objTmp}`], asF64(emit(['str', method]))], 'f64')
        if (usesDynProps(vt)) {
          inc('__dyn_get_expr')
          return typed(['block', ['result', 'f64'],
            ['local.set', `$${objTmp}`, asF64(emit(obj))],
            ctx.closure.call(propRead, [arrayIR], true)], 'f64')
        }
        inc('__dyn_get_expr', '__ext_call')
        return typed(['block', ['result', 'f64'],
          ['local.set', `$${objTmp}`, asF64(emit(obj))],
          ['if', ['result', 'f64'],
            ['i32.eq', ['call', '$__ptr_type', ['local.get', `$${objTmp}`]], ['i32.const', PTR.EXTERNAL]],
            ['then', ['call', '$__ext_call', ['local.get', `$${objTmp}`], asF64(emit(['str', method])), arrayIR]],
            ['else', ctx.closure.call(propRead, [arrayIR], true)]]], 'f64')
      }

      // Unknown callee - assume external method
      inc('__ext_call')
      const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
      const arrayIR = buildArrayWithSpreads(combined)
      return typed(['call', '$__ext_call', asF64(emit(obj)), asF64(emit(['str', method])), arrayIR], 'f64');
    }

    if (ctx.core.emit[callee]) {
      // Pass spread args through to emitter (e.g. Math.max(...arr))
      if (parsed.hasSpread) {
        const allArgs = []
        let ni = 0
        for (const s of parsed.spreads) {
          while (ni < s.pos) allArgs.push(parsed.normal[ni++])
          allArgs.push(['...', s.expr])
        }
        while (ni < parsed.normal.length) allArgs.push(parsed.normal[ni++])
        return ctx.core.emit[callee](...allArgs)
      }
      return ctx.core.emit[callee](...parsed.normal)
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
          emittedFixed.push(nullExpr())

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
      while (args.length < expected) args.push(nullExpr())
      // Multi-value return: materialize as heap array (caller expects single pointer)
      if (func?.sig.results.length > 1) return materializeMulti(['()', callee, ...parsed.normal])
      return typed(['call', `$${callee}`, ...args], 'f64')
    }

    // Closure call: callee is a variable holding a NaN-boxed closure pointer
    // Uniform convention: fn.call packs all args into an array
    if (ctx.closure.call) {
      if (parsed.hasSpread) {
        // Spread: build the args array directly (handles __spread markers)
        const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
        const arrayIR = buildArrayWithSpreads(combined)
        // Pass pre-built array as single already-emitted arg
        return ctx.closure.call(emit(callee), [arrayIR], true)
      }
      return ctx.closure.call(emit(callee), parsed.normal)
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
  if (Array.isArray(node) && node.loc != null) ctx.error.loc = node.loc
  if (node == null) return null
  if (node === true) return typed(['i32.const', 1], 'i32')
  if (node === false) return typed(['i32.const', 0], 'i32')
  if (typeof node === 'symbol') // JZ_NULL sentinel → null NaN
    return nullExpr()
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
    // Variable read: boxed / local / param / global (check before emitter table to avoid name collisions)
    if (ctx.func.boxed?.has(node) || ctx.func.locals?.has(node) || ctx.func.current?.params?.some(p => p.name === node) || isGlobal(node))
      return readVar(node)
    // Top-level function used as value → wrap as closure pointer for call_indirect
    if (funcNames.has(node) && !ctx.func.locals?.has(node) && !ctx.func.current?.params?.some(p => p.name === node) && ctx.closure.table) {
      // Generate trampoline: (env, __args) → unpack args, call $func(p0, p1, ...)
      const func = funcMap.get(node)
      const trampolineName = `${T}tramp_${node}`
      if (!ctx.core.stdlib[trampolineName]) {
        const argLen = `${T}argc`
        const argBase = `${T}argp`
        const forwardArg = i => `(if (result f64) (i32.gt_s (local.get $${argLen}) (i32.const ${i})) (then (f64.load (i32.add (local.get $${argBase}) (i32.const ${i * 8})))) (else (f64.reinterpret_i64 (i64.const ${NULL_NAN}))))`
        const fwd = func?.sig.params.map((_, i) => forwardArg(i)).join(' ') || ''
        if ((func?.sig.results.length || 1) > 1) {
          const n = func.sig.results.length
          const arr = `${T}retarr`
          const temps = Array.from({ length: n }, (_, i) => `${T}ret${i}`)
          const tempLocals = temps.map(name => `(local $${name} f64)`).join(' ')
          const stores = temps.map((name, i) =>
            `(f64.store (i32.add (local.get $${arr}) (i32.const ${i * 8})) (local.get $${name}))`
          ).join(' ')
          const capture = temps.slice().reverse().map(name => `(local.set $${name})`).join(' ')
          ctx.core.stdlib[trampolineName] = `(func $${trampolineName} (param $__env f64) (param $${T}args f64) (result f64) (local $${argLen} i32) (local $${argBase} i32) (local $${arr} i32) ${tempLocals} (local.set $${argBase} (call $__ptr_offset (local.get $${T}args))) (local.set $${argLen} (i32.load (i32.sub (local.get $${argBase}) (i32.const 8)))) (call $${node} ${fwd}) ${capture} (local.set $${arr} (call $__alloc (i32.const ${n * 8 + 8}))) (i32.store (local.get $${arr}) (i32.const ${n})) (i32.store (i32.add (local.get $${arr}) (i32.const 4)) (i32.const ${n})) (local.set $${arr} (i32.add (local.get $${arr}) (i32.const 8))) ${stores} (call $__mkptr (i32.const 1) (i32.const 0) (local.get $${arr})))`
        } else {
          ctx.core.stdlib[trampolineName] = `(func $${trampolineName} (param $__env f64) (param $${T}args f64) (result f64) (local $${argLen} i32) (local $${argBase} i32) (local.set $${argBase} (call $__ptr_offset (local.get $${T}args))) (local.set $${argLen} (i32.load (i32.sub (local.get $${argBase}) (i32.const 8)))) (call $${node} ${fwd}))`
        }
        inc(trampolineName, '__ptr_offset', '__alloc', '__mkptr')
      }
      let idx = ctx.closure.table.indexOf(trampolineName)
      if (idx < 0) { idx = ctx.closure.table.length; ctx.closure.table.push(trampolineName) }
      return typed(['call', '$__mkptr', ['i32.const', 10], ['i32.const', idx], ['i32.const', 0]], 'f64')
    }
    // Emitter table: only namespace-resolved names (contain '.', e.g. 'math.PI') — safe from user variable collision
    if (node.includes('.') && ctx.core.emit[node]) return ctx.core.emit[node]()
    // Auto-import known host globals (WebAssembly, globalThis, etc.)
    const HOST_GLOBALS = new Set(['WebAssembly', 'globalThis', 'self', 'window', 'global', 'process'])
    if (HOST_GLOBALS.has(node) && !ctx.func.locals?.has(node) && !ctx.func.current?.params?.some(p => p.name === node) && !isGlobal(node)) {
      ctx.scope.globals.set(node, null)
      ctx.module.imports.push(['import', '"env"', `"${node}"`, ['global', `$${node}`, ['mut', 'f64']]])
      return typed(['global.get', `$${node}`], 'f64')
    }
    const t = ctx.func.locals?.get(node) || ctx.func.current?.params.find(p => p.name === node)?.type || 'f64'
    return typed(['local.get', `$${node}`], t)
  }
  if (!Array.isArray(node)) return typed(['f64.const', 0], 'f64')

  const [op, ...args] = node
  // WASM IR passthrough: internally-generated IR nodes (from statement flattening) pass through
  if (typeof op === 'string' && !ctx.core.emit[op] && (op.includes('.') || WASM_OPS.has(op))) return node

  // Literal node [, value] — handle null/undefined values
  if (op == null && args.length === 1) {
    const v = args[0]
    return v == null ? nullExpr() : emit(v)
  }

  const handler = ctx.core.emit[op]
  if (!handler) err(`Unknown op: ${op}`)
  return handler(...args)
}
