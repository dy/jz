/**
 * Pure IR construction helpers for WAT-as-array output.
 *
 * # Stage contract
 *   IN:  bare primitives (strings, numbers, AST nodes), ctx reads for locals/globals/schema
 *   OUT: tagged IR nodes (arrays with `.type` property)
 *   NO-EMIT: nothing here calls `emit()` — these are leaf constructors. Helpers that
 *        recurse into AST nodes (toBool, materializeMulti, emitDecl, buildArrayWithSpreads,
 *        emitTypeofCmp) live in emit.js because they invoke the dispatch table.
 *
 * # Layers
 *   - Type tagging (`typed`, coercions)
 *   - Nullish sentinels + NaN-boxed pointer construction
 *   - Literal / purity classifiers
 *   - Constant pools (WASM_OPS, MEM_OPS, mutator sets)
 *   - Temp-local factories (mutate `ctx.func.locals`)
 *   - Variable storage abstraction (boxed/global/local dispatch)
 *   - Array-layout IR (slot/elem loads, allocPtr, arrayLoop)
 *
 * @module ir
 */

import { ctx, err, inc, PTR } from './ctx.js'
import { T, VAL, valTypeOf, lookupValType } from './analyze.js'

// === Type helpers ===

/** Tag a WASM node with its result type. */
export const typed = (node, type) => (node.type = type, node)

/** Coerce node to f64. */
export const asF64 = n => n.type === 'f64' ? n
  : (n[0] === 'i32.const' && typeof n[1] === 'number') ? typed(['f64.const', n[1]], 'f64')
  : typed(['f64.convert_i32_s', n], 'f64')

/** Coerce node to i32 (saturating — fast, correct for values < 2^31). */
export const asI32 = n => n.type === 'i32' ? n : typed(['i32.trunc_sat_f64_s', n], 'i32')

/** Coerce emitted IR to a target WASM param type ('i32' | 'f64'). */
export const asParamType = (n, t) => t === 'i32' ? asI32(n) : asF64(n)

/** Coerce node to i32 with wrapping (JS `|0` semantics: values > 2^31 wrap to negative). */
export const toI32 = n => n.type === 'i32' ? n : typed(['i32.wrap_i64', ['i64.trunc_sat_f64_s', n]], 'i32')

/** Extract i64 from BigInt-as-f64. */
export const asI64 = n => typed(['i64.reinterpret_f64', asF64(n)], 'i64')

/** Wrap i64 result back to BigInt-as-f64. */
export const fromI64 = n => typed(['f64.reinterpret_i64', n], 'f64')

// === Nullish sentinels ===

/** Null/undefined: one nullish value inside jz. NaN-boxed ATOM (type=0, aux=1, offset=0).
 *  Distinct from 0, NaN, and all pointers. Triggers default params.
 *  At the JS boundary, null and undefined preserve their identity for interop. */
export const NULL_NAN = '0x7FF8000100000000'
export const UNDEF_NAN = '0x7FF8000000000001'
/** WAT-template-ready sentinel expressions for use in stdlib template strings.
 *  `f64.const nan:0xHEX` is 3 bytes shorter than `f64.reinterpret_i64 (i64.const ...)`. */
export const NULL_WAT = `(f64.const nan:${NULL_NAN})`
export const UNDEF_WAT = `(f64.const nan:${UNDEF_NAN})`
export const NULL_IR = ['f64.const', `nan:${NULL_NAN}`]
export const UNDEF_IR = ['f64.const', `nan:${UNDEF_NAN}`]
export const nullExpr = () => typed(NULL_IR, 'f64')
export const undefExpr = () => typed(UNDEF_IR.slice(), 'f64')

// === Constants ===

/** Max arity of inline closure slots. Closures are compiled with signature
 *  (env f64, argc i32, a0..a{MAX-1} f64) → f64 — no per-call heap alloc.
 *  Calls with more args than MAX error; rest-param closures receive at most
 *  MAX rest args when invoked via spread with >MAX dynamic elements. */
export const MAX_CLOSURE_ARITY = 8

/** Matches WASM instructions that require a memory section. */
export const MEM_OPS = /\b(i32\.load|i32\.store|f64\.load|f64\.store|f32\.load|f32\.store|i64\.load|i64\.store|memory\.size|memory\.grow|i32\.load8|i32\.load16|i32\.store8|i32\.store16)\b/

export const WASM_OPS = new Set(['block','loop','if','then','else','br','br_if','call','call_indirect','return','return_call','throw','try_table','catch','nop','drop','unreachable','select','result','mut','param','func','module','memory','table','elem','data','type','import','export','local','global','ref'])
export const SPREAD_MUTATORS = new Set(['push', 'add', 'set', 'unshift'])
export const BOXED_MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'reverse', 'sort'])

// === Pointer construction ===

const NAN_PREFIX_BITS = 0x7FF8n
const litI32 = n => Array.isArray(n) && n[0] === 'i32.const' && typeof n[1] === 'number' ? n[1] : null

/** Pack (type, aux, offset) into the f64 NaN-box bit pattern as a hex string. */
function packPtrBits(type, aux, offset) {
  const bits = (NAN_PREFIX_BITS << 48n)
    | ((BigInt(type) & 0xFn) << 47n)
    | ((BigInt(aux) & 0x7FFFn) << 32n)
    | (BigInt(offset >>> 0) & 0xFFFFFFFFn)
  return '0x' + bits.toString(16).toUpperCase().padStart(16, '0')
}

/** Build `__mkptr(type, aux, offset)` IR. Folds to `(f64.const nan:0x...)` — 9 bytes
 *  vs 12 for `f64.reinterpret_i64 (i64.const ...)` — when all args are i32 literals.
 *  Args may be raw IR nodes or numbers (numbers are wrapped as i32.const). */
export function mkPtrIR(type, aux, offset) {
  const tIR = typeof type === 'number' ? ['i32.const', type] : type
  const aIR = typeof aux === 'number' ? ['i32.const', aux] : aux
  const oIR = typeof offset === 'number' ? ['i32.const', offset] : offset
  const tL = litI32(tIR), aL = litI32(aIR), oL = litI32(oIR)
  if (tL != null && aL != null && oL != null)
    return typed(['f64.const', 'nan:' + packPtrBits(tL, aL, oL)], 'f64')
  inc('__mkptr')
  return typed(['call', '$__mkptr', tIR, aIR, oIR], 'f64')
}

const _F64_BITS_BUF = new ArrayBuffer(8)
const _F64_BITS_F = new Float64Array(_F64_BITS_BUF)
const _F64_BITS_U = new BigUint64Array(_F64_BITS_BUF)

/** Return i64 bit pattern (BigInt) of a pure-literal IR node, or null if non-literal. */
export function extractF64Bits(node) {
  if (!Array.isArray(node)) return null
  if (node[0] === 'f64.const') {
    if (typeof node[1] === 'number') { _F64_BITS_F[0] = node[1]; return _F64_BITS_U[0] }
    if (typeof node[1] === 'string' && node[1].startsWith('nan:')) {
      try { return BigInt(node[1].slice(4)) | 0x7FF0000000000000n } catch { return null }
    }
    return null
  }
  if (node[0] === 'f64.reinterpret_i64' && Array.isArray(node[1]) && node[1][0] === 'i64.const' && typeof node[1][1] === 'string') {
    const s = node[1][1]
    if (s.startsWith('-')) {
      const abs = s.slice(1)
      try { return ((1n << 64n) - BigInt(abs)) & 0xFFFFFFFFFFFFFFFFn } catch { return null }
    }
    try { return BigInt(s) } catch { return null }
  }
  return null
}

/** Append `slots` (BigInt i64 each) to ctx.runtime.data 8-byte aligned, return raw byte offset of first slot.
 *  Slots that look like NaN-boxed pointers are recorded in `ctx.runtime.staticPtrSlots` so the
 *  prefix-strip pass can patch their embedded offsets. */
export function appendStaticSlots(slots, headerBytes = 0) {
  if (!ctx.runtime.data) ctx.runtime.data = ''
  while (ctx.runtime.data.length % 8 !== 0) ctx.runtime.data += '\0'
  const off = ctx.runtime.data.length
  const u8 = new Uint8Array(headerBytes + slots.length * 8)
  const dv = new DataView(u8.buffer)
  for (let i = 0; i < slots.length; i++) dv.setBigUint64(headerBytes + i * 8, slots[i], true)
  let chunk = ''
  for (let i = 0; i < u8.length; i++) chunk += String.fromCharCode(u8[i])
  ctx.runtime.data += chunk
  if (!ctx.runtime.staticPtrSlots) ctx.runtime.staticPtrSlots = []
  for (let i = 0; i < slots.length; i++) {
    const bits = slots[i]
    if (((bits >> 48n) & 0xFFF8n) === NAN_PREFIX_BITS) {
      ctx.runtime.staticPtrSlots.push(off + i * 8)
    }
  }
  return off
}

// === Literal / purity checks ===

/** Check if emitted node is a compile-time constant. */
export const isLit = n => (n[0] === 'i32.const' || n[0] === 'f64.const') && typeof n[1] === 'number'
export const litVal = n => n[1]
const isNullLit = n => Array.isArray(n) && n.length === 2 && n[0] == null && n[1] == null
const isUndefLit = n => Array.isArray(n) && n.length === 0
export const isNullishLit = n => isNullLit(n) || isUndefLit(n)

/** Side-effect-free (safe for WASM select). */
const PURE_OPS = new Set(['i32.const', 'f64.const', 'local.get', 'global.get',
  'f64.add', 'f64.sub', 'f64.mul', 'f64.div', 'f64.neg', 'f64.abs', 'f64.sqrt',
  'i32.add', 'i32.sub', 'i32.mul', 'i32.and', 'i32.or', 'i32.xor',
  'f64.convert_i32_s', 'f64.convert_i32_u', 'i32.trunc_sat_f64_s',
  'i32.wrap_i64', 'i64.trunc_sat_f64_s', 'f64.eq', 'f64.ne', 'f64.lt', 'f64.gt', 'f64.le', 'f64.ge',
  'i32.eq', 'i32.ne', 'i32.lt_s', 'i32.gt_s', 'i32.le_s', 'i32.ge_s', 'i32.eqz'])
export const isPureIR = n => Array.isArray(n) && PURE_OPS.has(n[0]) && n.slice(1).every(c => !Array.isArray(c) || isPureIR(c))

/** Check if (a, op, b) is a postfix pattern: [op, name] and [, 1] literal. */
export const isPostfix = (a, op, b) => Array.isArray(a) && a[0] === op && Array.isArray(b) && b[0] == null && b[1] === 1

/** Emit a numeric constant with correct i32/f64 typing. */
export const emitNum = v => Number.isInteger(v) && v >= -2147483648 && v <= 2147483647
  ? typed(['i32.const', v], 'i32') : typed(['f64.const', v], 'f64')

// === Temp locals ===

/** Allocate a temp local, returns name without $. Optional tag aids WAT readability.
 *  Skips names already registered (by analyzeLocals from prepare-generated names)
 *  to avoid collisions that would silently override the pre-analyzed type. */
export function temp(tag = '') {
  let name
  do { name = `${T}${tag}${ctx.func.uniq++}` } while (ctx.func.locals.has(name))
  ctx.func.locals.set(name, 'f64')
  return name
}
export function tempI32(tag = '') {
  let name
  do { name = `${T}${tag}${ctx.func.uniq++}` } while (ctx.func.locals.has(name))
  ctx.func.locals.set(name, 'i32')
  return name
}
export function tempI64(tag = '') {
  let name
  do { name = `${T}${tag}${ctx.func.uniq++}` } while (ctx.func.locals.has(name))
  ctx.func.locals.set(name, 'i64')
  return name
}

// === Numeric helpers ===

/** WASM has no f64.rem — implement as a - trunc(a/b) * b.
 *  Both `a` and `b` appear twice in the expansion; cache non-pure operands
 *  in locals so side effects (e.g. assignments) only execute once. */
export const f64rem = (a, b) => {
  const pa = isPureIR(a), pb = isPureIR(b)
  if (pa && pb) return typed(['f64.sub', a, ['f64.mul', ['f64.trunc', ['f64.div', a, b]], b]], 'f64')
  const ta = pa ? null : temp(), tb = pb ? null : temp()
  const ga = pa ? a : ['local.get', `$${ta}`], gb = pb ? b : ['local.get', `$${tb}`]
  const pre = []
  if (!pa) pre.push(['local.set', `$${ta}`, a])
  if (!pb) pre.push(['local.set', `$${tb}`, b])
  return typed(['block', ['result', 'f64'], ...pre,
    ['f64.sub', ga, ['f64.mul', ['f64.trunc', ['f64.div', ga, gb]], gb]]], 'f64')
}

/** Coerce an emitted IR value to a plain f64 Number per JS `ToNumber`.
 *  Skips coercion when static type proves the value is already numeric
 *  (i32 node, compile-time literal, known VAL.NUMBER/VAL.BIGINT) or when
 *  __to_num is not available (no string module loaded → no strings possible). */
export function toNumF64(node, v) {
  if (v.type === 'i32' || isLit(v)) return asF64(v)
  const vt = keyValType(node)
  if (vt === VAL.NUMBER || vt === VAL.BIGINT) return asF64(v)
  if (!ctx.core.stdlib['__to_num']) return asF64(v)
  inc('__to_num')
  return typed(['call', '$__to_num', asF64(v)], 'f64')
}

/** Convert already-emitted WASM node to i32 boolean. NaN is falsy (like JS).
 *  Peepholes: i32 → as-is; `f64.convert_i32_*(x)` → x (i32 conversion never NaN);
 *  nested `__is_truthy(x)` → x (already 0/1); literal f64 const folds to 0/1. */
export function truthyIR(e) {
  if (e.type === 'i32') return e
  if (Array.isArray(e)) {
    if (e[0] === 'f64.convert_i32_s' || e[0] === 'f64.convert_i32_u')
      return typed(['i32.ne', e[1], ['i32.const', 0]], 'i32')
    if (e[0] === 'call' && e[1] === '$__is_truthy') return typed(e, 'i32')
    // Fold literal f64 constants: zero/NaN → 0, any other number → 1.
    if (e[0] === 'f64.const' && typeof e[1] === 'number') {
      return typed(['i32.const', (e[1] !== 0 && !Number.isNaN(e[1])) ? 1 : 0], 'i32')
    }
    // Fold NaN-boxed pointer literals: UNDEF/NULL/canonical-NaN sentinels are falsy;
    // all other NaN-boxed pointers (SSO strings, heap ptrs, etc.) are truthy.
    if (e[0] === 'f64.reinterpret_i64' && Array.isArray(e[1]) && e[1][0] === 'i64.const') {
      const bits = String(e[1][1])
      const FALSY = new Set([UNDEF_NAN, NULL_NAN, '0x7FF8000000000000', '0x7FFA800000000000'])
      return typed(['i32.const', FALSY.has(bits) ? 0 : 1], 'i32')
    }
  }
  inc('__is_truthy')
  return typed(['call', '$__is_truthy', asF64(e)], 'i32')
}
export const toBoolFromEmitted = truthyIR

// === Value-type classification ===

export function keyValType(node) {
  return typeof node === 'string' ? lookupValType(node) : valTypeOf(node)
}

export function usesDynProps(vt) {
  return vt === VAL.ARRAY || vt === VAL.STRING || vt === VAL.CLOSURE
    || vt === VAL.TYPED || vt === VAL.SET || vt === VAL.MAP || vt === VAL.REGEX
}

/** Does this object literal / property write need a `__dyn_props` shadow update?
 *  `target` is the var name receiving the literal (or null when escaping). */
export function needsDynShadow(target) {
  if (!ctx.module.modules.collection) return false
  const dyn = ctx.types?.dynKeyVars
  if (target == null) return ctx.types?.anyDynKey ?? true
  return dyn ? dyn.has(target) : true
}

// === Variable storage abstraction ===
// Centralizes the boxed/global/local 3-way dispatch (used by =, ++/--, +=, etc.)

/** Check if name is a module-scope global (not shadowed by local/param). */
export function isGlobal(name) {
  return ctx.scope.globals.has(name) && !ctx.func.locals?.has(name) && !ctx.func.current?.params?.some(p => p.name === name)
}

/** Check if assigning to name would violate const. Only applies when not shadowed. */
export function isConst(name) {
  return ctx.scope.consts?.has(name) && !ctx.func.locals?.has(name) && !ctx.func.current?.params?.some(p => p.name === name)
}

/** Get i32 memory address for a boxed variable's cell. Cell locals are always i32. */
export function boxedAddr(name) {
  return ['local.get', `$${ctx.func.boxed.get(name)}`]
}

/** Read variable value: boxed → f64.load, global → global.get, local → local.get. */
export function readVar(name) {
  if (ctx.func.boxed?.has(name))
    return typed(['f64.load', boxedAddr(name)], 'f64')
  if (isGlobal(name))
    return typed(['global.get', `$${name}`], ctx.scope.globalTypes.get(name) || 'f64')
  const t = ctx.func.locals?.get(name) || ctx.func.current?.params?.find(p => p.name === name)?.type || 'f64'
  return typed(['local.get', `$${name}`], t)
}

/** Write variable value. void_ → local.set (no result); otherwise → local.tee.
 *  valIR is raw emit result — coerced to f64 for boxed/global, to local type for locals. */
export function writeVar(name, valIR, void_) {
  if (ctx.func.boxed?.has(name)) {
    const addr = boxedAddr(name)
    const v = asF64(valIR)
    if (void_) return typed(['block', ['f64.store', addr, v]], 'void')
    const t = temp()
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, v],
      ['f64.store', addr, ['local.get', `$${t}`]],
      ['local.get', `$${t}`]], 'f64')
  }
  if (isGlobal(name)) {
    const v = asF64(valIR)
    if (void_) return typed(['block', ['global.set', `$${name}`, v]], 'void')
    const t = temp()
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, v],
      ['global.set', `$${name}`, ['local.get', `$${t}`]],
      ['local.get', `$${t}`]], 'f64')
  }
  const t = ctx.func.locals.get(name) || 'f64'
  const coerced = t === 'f64' ? asF64(valIR) : asI32(valIR)
  if (void_) return typed(['local.set', `$${name}`, coerced], 'void')
  return typed(['local.tee', `$${name}`, coerced], t)
}

/** Check if f64 expr is nullish (NULL_NAN or UNDEF_NAN). Returns i32.
 *  Peepholes: fold known NaN-boxed sentinel literals; elide on numeric literals. */
export const isNullish = (f64expr) => {
  if (Array.isArray(f64expr)) {
    if (f64expr[0] === 'f64.const') return typed(['i32.const', 0], 'i32')  // numeric literal — never nullish
    if (f64expr[0] === 'f64.reinterpret_i64' && Array.isArray(f64expr[1]) && f64expr[1][0] === 'i64.const') {
      const bits = String(f64expr[1][1])
      return typed(['i32.const', (bits === NULL_NAN || bits === UNDEF_NAN) ? 1 : 0], 'i32')
    }
  }
  inc('__is_nullish')
  return typed(['call', '$__is_nullish', f64expr], 'i32')
}

// === Array layout helpers ===

/** Slot address: `base + idx*8` IR. Uses `local.get` directly when idx=0. */
export function slotAddr(baseLocal, idx) {
  const base = ['local.get', `$${baseLocal}`]
  return idx === 0 ? base : ['i32.add', base, ['i32.const', idx * 8]]
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

/** Build a NaN-boxed pointer from a header allocation.
 *  type/aux/stride may be JS numbers; len/cap may be JS numbers or IR.
 *  Returns { local, init, ptr } where:
 *    local — i32 name pointing to data start (post-header)
 *    init  — IR statement that allocates and sets `local`
 *    ptr   — f64 IR expression: __mkptr(type, aux, local).
 *  Caller emits init, fills via local, then uses ptr (or local for further work). */
export function allocPtr({ type, aux = 0, len, cap, stride = 8, tag = 'ap' }) {
  inc('__alloc_hdr')
  const local = tempI32(tag)
  const irOf = v => typeof v === 'number' ? ['i32.const', v] : v
  const init = ['local.set', `$${local}`,
    ['call', '$__alloc_hdr', irOf(len), irOf(cap == null ? len : cap), ['i32.const', stride]]]
  const ptr = mkPtrIR(type, aux, ['local.get', `$${local}`])
  return { local, init, ptr }
}

// === Multi-value + control-flow reads ===

/** Check if a call expression targets a multi-value function. Returns result count or 0. */
export function multiCount(callNode) {
  if (!Array.isArray(callNode) || callNode[0] !== '()') return 0
  const name = callNode[1]
  if (typeof name !== 'string') return 0
  const func = ctx.func.map?.get(name)
  return func?.sig.results.length > 1 ? func.sig.results.length : 0
}

/** Get current loop labels or throw. */
export function loopTop() {
  const top = ctx.func.stack.at(-1)
  if (!top) err('break/continue outside loop')
  return top
}

// === Data shaping ===

/** Normalize emit result to instruction list. */
export const flat = ir => {
  if (ir == null) return []
  if (!Array.isArray(ir)) return [ir]  // bare 'drop', 'nop', etc.
  if (typeof ir[0] === 'string' || ir[0] == null) return [ir]  // single instruction: ['op', ...args] or [null, val]
  return ir  // multi-instruction: [instr1, instr2, ...]
}

/**
 * Reconstruct arguments with spreads inserted at correct positions.
 * Example: normal=[a, c], spreads=[{pos:1, expr:arr}] → [a, __spread(arr), c]
 */
export function reconstructArgsWithSpreads(normal, spreads) {
  const combined = []
  let normalIdx = 0
  for (let targetPos = 0; targetPos <= normal.length; targetPos++) {
    for (const spread of spreads) {
      if (spread.pos === targetPos) {
        combined.push(['__spread', spread.expr])
      }
    }
    if (normalIdx < normal.length) {
      combined.push(normal[normalIdx++])
    }
  }
  return combined
}
