/**
 * The stable sort behind Array#sort, Array#toSorted and a typed array's sort
 * with a comparator: a bottom-up merge sort over records in a heap scratch
 * buffer, O(n log n) comparisons where the insertion sort before it made
 * O(n²). Records are one f64 (a value) or two (a string key and its value).
 *
 * @module array/sort
 */
import { tempI32 } from '../../src/ir.js'
import { ctx, inc } from '../../src/ctx.js'
import { freshId } from '../../src/ir.js'

const get = (n) => ['local.get', `$${n}`]
const set = (n, v) => ['local.set', `$${n}`, v]

/** Scratch of `bytesIR` bytes on the heap, in local `at`. `release()` gives it
 *  back where nothing was allocated after it (a comparator may keep what it
 *  allocates), and never in shared memory, where another thread may have. */
export function heapScratch(at, bytesIR) {
  inc('__alloc')
  const save = tempI32('sks'), top = () => ctx.memory.shared ? ['i32.const', 0] : ['global.get', '$__heap']
  return {
    take: [set(save, top()), set(at, ['call', '$__alloc', bytesIR])],
    release: ctx.memory.shared ? ['nop']
      : ['if', ['i32.eq', ['global.get', '$__heap'], ['i32.and', ['i32.add', ['i32.add', get(at), bytesIR], ['i32.const', 7]], ['i32.const', -8]]],
        ['then', ['global.set', '$__heap', get(save)]]],
  }
}

/** Sort `len` records of `1 << shift` bytes (shift 3 or 4) at the address in
 *  local `buf`, stably, through `tmp`, a scratch of the same size.
 *  `after(aAddr, bAddr)` is i32 IR: record a must come after record b (a
 *  comparator's positive result; NaN is no order). The records end at `buf`. */
export function mergeSortIR(buf, tmp, len, shift, after) {
  const id = freshId(ctx)
  const w = tempI32('msw'), lo = tempI32('msl'), mid = tempI32('msm'), hi = tempI32('msh')
  const i = tempI32('msi'), j = tempI32('msj'), k = tempI32('msk'), src = tempI32('mss'), dst = tempI32('msd'), t = tempI32('mst')
  const at = (base, x) => ['i32.add', get(base), ['i32.shl', get(x), ['i32.const', shift]]]
  const move = (from) => shift === 3
    ? [['i64.store', at(dst, k), ['i64.load', at(src, from)]]]
    : [['i64.store', at(dst, k), ['i64.load', at(src, from)]],
       ['i64.store', ['i32.add', at(dst, k), ['i32.const', 8]], ['i64.load', ['i32.add', at(src, from), ['i32.const', 8]]]]]
  const take = (from) => [...move(from), set(from, ['i32.add', get(from), ['i32.const', 1]])]
  const min = (a, b) => ['select', a, b, ['i32.lt_u', a, b]]
  return ['block',
    set(src, get(buf)), set(dst, get(tmp)), set(w, ['i32.const', 1]),
    ['block', `$msdone${id}`, ['loop', `$mswidth${id}`,
      ['br_if', `$msdone${id}`, ['i32.ge_u', get(w), get(len)]],
      set(lo, ['i32.const', 0]),
      ['block', `$msrund${id}`, ['loop', `$msrun${id}`,
        ['br_if', `$msrund${id}`, ['i32.ge_u', get(lo), get(len)]],
        set(mid, min(['i32.add', get(lo), get(w)], get(len))),
        set(hi, min(['i32.add', get(mid), get(w)], get(len))),
        set(i, get(lo)), set(j, get(mid)), set(k, get(lo)),
        ['block', `$msmd${id}`, ['loop', `$msm${id}`,
          ['br_if', `$msmd${id}`, ['i32.ge_u', get(k), get(hi)]],
          // the left run's element unless the right one must come first
          ['if', ['i32.lt_u', get(i), get(mid)],
            ['then', ['if', ['i32.lt_u', get(j), get(hi)],
              ['then', ['if', after(at(src, i), at(src, j)), ['then', ...take(j)], ['else', ...take(i)]]],
              ['else', ...take(i)]]],
            ['else', ...take(j)]],
          set(k, ['i32.add', get(k), ['i32.const', 1]]),
          ['br', `$msm${id}`]]],
        set(lo, get(hi)),
        ['br', `$msrun${id}`]]],
      set(t, get(src)), set(src, get(dst)), set(dst, get(t)),
      set(w, ['i32.shl', get(w), ['i32.const', 1]]),
      ['br', `$mswidth${id}`]]],
    ['if', ['i32.ne', get(src), get(buf)],
      ['then', ['memory.copy', get(buf), get(src), ['i32.shl', get(len), ['i32.const', shift]]]]]]
}
