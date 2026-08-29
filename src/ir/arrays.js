/**
 * Array-layout IR helpers routed through the array carrier (abi/array.js):
 * slot/elem loads and stores, the arrayLoop scaffold, and allocPtr (header
 * allocation for Array/Set/Map/typed-buffer construction).
 *
 * @module ir/arrays
 */

import { ctx, inc } from '../ctx.js'
import { typed } from './tag.js'
import { temp, tempI32, freshId } from './locals.js'
import { mkPtrIR } from './pointers.js'
import { asF64 } from './numeric.js'

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
 *  an i32 local. Reuses it instead of calling __ptr_offset again. */
export function arrayLoop(arrExpr, bodyFn, lenLocal, ptrLocal, reverse) {
  const arr = ptrLocal ? null : temp('aa'), ptr = ptrLocal ?? tempI32('ap'), i = tempI32('ai'), item = temp('av')
  const len = lenLocal ?? tempI32('al')
  const id = freshId(ctx)
  const setup = []
  if (!ptrLocal) {
    inc('__ptr_offset')
    setup.push(
      ['local.set', `$${arr}`, asF64(arrExpr)],
      ['local.set', `$${ptr}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${arr}`]]]],
    )
  }
  if (!lenLocal) setup.push(
    ['local.set', `$${len}`, ['i32.load', ['i32.sub', ['local.get', `$${ptr}`], ['i32.const', 8]]]])
  // Forward: i 0→len-1. Reverse (findLast*): i len-1→0, same elem indices.
  const start = reverse ? ['i32.sub', ['local.get', `$${len}`], ['i32.const', 1]] : ['i32.const', 0]
  const done = reverse ? ['i32.lt_s', ['local.get', `$${i}`], ['i32.const', 0]]
                       : ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]
  const step = ['i32.const', reverse ? -1 : 1]
  setup.push(
    ['local.set', `$${i}`, start],
    ['block', `$brk${id}`, ['loop', `$loop${id}`,
      ['br_if', `$brk${id}`, done],
      ['local.set', `$${item}`, elemLoad(ptr, i)],
      ...bodyFn(ptr, len, i, typed(['local.get', `$${item}`], 'f64')),
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
  const args = [irOf(len), irOf(cap == null ? len : cap)]
  let helper
  if (stride === 8) helper = '__alloc_hdr'
  else { helper = '__alloc_hdr_n'; args.push(['i32.const', stride]) }
  inc(helper)
  const init = ['local.set', `$${local}`, ['call', '$' + helper, ...args]]
  const ptr = mkPtrIR(type, aux, ['local.get', `$${local}`])
  return { local, init, ptr }
}
