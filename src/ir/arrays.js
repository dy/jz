/**
 * Array-layout IR helpers routed through the array carrier (abi/array.js):
 * slot/elem loads and stores, the arrayLoop scaffold, and allocPtr (header
 * allocation for Array/Set/Map/typed-buffer construction).
 *
 * @module ir/arrays
 */

import { ctx, inc, PTR } from '../ctx.js'
import { typed } from './tag.js'
import { temp, tempI32, freshId } from './locals.js'
import { mkPtrIR } from './pointers.js'
import { asF64 } from './numeric.js'
import { isPureIR } from './classify.js'
import { UNDEF_NAN, TOMB_NAN } from './sentinels.js'
import { dataAlign, dataPush, dataLen, pushStaticSlots } from '../static-data.js'

/** Read a boxed array cell as a value: an absent cell answers undefined.
 *  The speed tier (the one that inlines functions) tests in place: a holey
 *  array's every read pays the call otherwise, which the engine keeps. */
export function arrayValue(value) {
  if (!ctx.transform.optimize?.inlineFns) {
    inc('__arr_value')
    return typed(['call', '$__arr_value', value], 'f64')
  }
  const t = temp('av')
  return typed(['select', ['f64.reinterpret_i64', ['i64.const', UNDEF_NAN]], ['local.tee', `$${t}`, value],
    ['i64.eq', ['i64.reinterpret_f64', ['local.get', `$${t}`]], ['i64.const', TOMB_NAN]]], 'f64')
}

/** Slot address: element `idx` off `baseLocal`. Constant idx folds the `*8`. */
export function slotAddr(baseLocal, idx) {
  return ctx.abi.array.ops.addr(['local.get', `$${baseLocal}`], idx)
}

/** Load f64 element from array data at ptr + i*8. ptr/i are local name strings. */
export function elemLoad(ptr, i) {
  return ctx.abi.array.ops.load(['local.get', `$${ptr}`], ['local.get', `$${i}`])
}

/** Store f64 val at array data ptr + i*8. ptr/i are local name strings. */
export function elemStore(ptr, i, val) {
  return ctx.abi.array.ops.store(['local.get', `$${ptr}`], ['local.get', `$${i}`], val)
}

/** Emit a loop iterating over array elements. Returns IR instruction list.
 *  bodyFn(ptr, len, i, item) should return an array of IR instructions.
 *  ARRAY-only — elemLoad assumes f64-stride data layout. After __ptr_offset
 *  resolves forwarding, len lives at ptr-8, so skip the second __len call
 *  (which would re-walk forwarding + dispatch on type).
 *
 *  Optional `lenLocal`: caller already has the array length in an i32 local
 *  (e.g. from sizing the output before the loop). Reuses it instead of
 *  re-loading from ptr-8.
 *  Optional `ptrLocal`: caller already has the resolved ARRAY data pointer in
 *  an i32 local. Reuses it instead of calling __ptr_offset again.
 *  `callbacks` refreshes storage and presence per step while keeping the
 *  initial length. Missing indices are skipped, visited as undefined, or
 *  passed to onMissing (map preserves its result length). */
export function arrayLoop(arrExpr, bodyFn, lenLocal, ptrLocal, reverse, from, callbacks) {
  const refresh = callbacks && !callbacks.fixed
  const arr = ptrLocal && !refresh ? null : temp('aa'), ptr = ptrLocal ?? tempI32('ap'), i = tempI32('ai'), item = temp('av')
  const len = lenLocal ?? tempI32('al')
  const id = freshId(ctx)
  const setup = []
  if (arr) setup.push(['local.set', `$${arr}`, asF64(arrExpr)])
  const resolve = ['local.set', `$${ptr}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${arr}`]]]]
  if (!ptrLocal || refresh) inc('__ptr_offset')
  if (!ptrLocal) setup.push(resolve)
  if (!lenLocal) setup.push(
    ['local.set', `$${len}`, ['i32.load', ['i32.sub', ['local.get', `$${ptr}`], ['i32.const', 8]]]])
  // Forward: i 0→len-1. Reverse (findLast*): i len-1→0, same elem indices.
  // Optional `from`: an i32 expression for the first index (indexOf's
  // fromIndex, already resolved against the length by the caller).
  const start = from ?? (reverse ? ['i32.sub', ['local.get', `$${len}`], ['i32.const', 1]] : ['i32.const', 0])
  const done = reverse ? ['i32.lt_s', ['local.get', `$${i}`], ['i32.const', 0]]
                       : ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]
  const step = ['i32.const', reverse ? -1 : 1]
  const body = bodyFn(ptr, len, i, typed(['local.get', `$${item}`], 'f64'))
  const load = ['local.set', `$${item}`, elemLoad(ptr, i)]
  let visit = [load, ...body]
  if (callbacks) {
    const read = [load, ...(callbacks.dense ? body : [['if',
      ['i64.ne', ['i64.reinterpret_f64', ['local.get', `$${item}`]], ['i64.const', TOMB_NAN]],
      ['then', ...body], ...(callbacks.onMissing ? [['else', ...callbacks.onMissing(i)]] : [])]])]
    const present = ['i32.lt_u', ['local.get', `$${i}`],
      ['i32.load', ['i32.sub', ['local.get', `$${ptr}`], ['i32.const', 8]]]]
    if (callbacks.visitMissing) {
      const value = callbacks.dense ? elemLoad(ptr, i) : arrayValue(elemLoad(ptr, i))
      visit = [...(refresh ? [resolve] : []), ['local.set', `$${item}`, refresh
        ? ['if', ['result', 'f64'], present, ['then', value], ['else', ['f64.reinterpret_i64', ['i64.const', UNDEF_NAN]]]]
        : value], ...body]
    } else visit = refresh
      ? [resolve, ['if', present, ['then', ...read], ...(callbacks.onMissing ? [['else', ...callbacks.onMissing(i)]] : [])]]
      : read
  } else visit = [['local.set', `$${item}`, arrayValue(elemLoad(ptr, i))], ...body]
  setup.push(
    ['local.set', `$${i}`, start],
    ['block', `$brk${id}`, ['loop', `$loop${id}`,
      ['br_if', `$brk${id}`, done],
      ...visit,
      ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], step]],
      ['br', `$loop${id}`]]])
  return setup
}

/** Build a NaN-boxed pointer from a header allocation.
 *  type/aux/stride may be JS numbers; len/cap may be JS numbers or IR.
 *  Returns { local, init, ptr } where:
 *    local — i32 name pointing to data start (post-header)
 *    init  — IR statement that allocates and sets `local`
 *    ptr   — f64 IR expression: __mkptr(type, aux, local).
 *  Caller emits init, fills via local, then uses ptr (or local for further work). */
export function allocPtr({ type, aux = 0, len, cap, stride = 8, tag = 'ap' }) {
  // stride=8 (f64 slots — Array/HASH/OBJECT) hits the specialized __alloc_hdr which
  // hardcodes the multiply. Everything else (Set:16, Map probe:24, raw bytes:1) goes
  // through the generic __alloc_hdr_n(len, cap, stride).
  const local = tempI32(tag)
  const irOf = v => typeof v === 'number' ? ['i32.const', v] : v
  let capture
  if (cap == null && typeof len !== 'number' && !isPureIR(len)) {
    // The default capacity is the same evaluated length, not a second
    // evaluation of a coercion/call/load used to compute that length.
    const n = tempI32('len')
    capture = ['local.set', `$${n}`, len]
    len = ['local.get', `$${n}`]
  }
  const args = [irOf(len), irOf(cap == null ? len : cap)]
  let helper
  if (stride === 8) helper = '__alloc_hdr'
  else { helper = '__alloc_hdr_n'; args.push(['i32.const', stride]) }
  inc(helper)
  const allocate = ['local.set', `$${local}`, ['call', '$' + helper, ...args]]
  const init = capture ? ['block', capture, allocate] : allocate
  const ptr = mkPtrIR(type, aux, ['local.get', `$${local}`])
  return { local, init, ptr }
}

/** Pack literal i64 slots as a static ARRAY into the data segment, returning a
 *  folded ARRAY pointer to the first slot. The 16-byte header MUST match
 *  __alloc_hdr (core.js): a zeroed dyn-props word at off-16, then len/cap at
 *  off-8/-4. Heap arrays get that props word zeroed for free; a static array with
 *  only an 8-byte header left off-16 pointing at adjacent data-segment bytes, so
 *  for-in / named-prop lookup (which read off-16 as the props-sidecar pointer)
 *  walked garbage → OOB (test262 built-ins/Object/keys sparse-array). */
export function staticArrayPtr(slots) {
  dataAlign(8)
  const headerOff = dataLen()
  const len = slots.length
  const hdr = new Uint8Array(16); const dv = new DataView(hdr.buffer)
  dv.setInt32(8, len, true); dv.setInt32(12, len, true)  // off-8: len, off-4: cap (props word at 0..7 stays 0)
  dataPush(hdr)
  pushStaticSlots(slots)
  const ptr = mkPtrIR(PTR.ARRAY, 0, headerOff + 16)
  // Compile-time identity for the static base/len read fold (see the saArr tag in
  // the '[]' handler + optimize's foldStaticConstArrayReads): a const global bound
  // to this literal reads elements with literal base/len instead of the
  // __ptr_offset call + header load.
  ptr.staticOff = headerOff + 16
  ptr.staticLen = len
  return ptr
}
