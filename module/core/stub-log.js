/**
 * The compaction's leaf: whether a module compacts, whether its loops
 * compact in place, and the stub log the growth helpers feed those loops
 * (module/array.js relocateWat, module/collection/upsert.js). A leaf so the
 * collections can import it: module/core/compact.js imports the collections.
 *
 * @module core/stub-log
 */
import { ctx, declGlobal } from '../../src/ctx.js'

export const compactOn = () => ctx.transform.host === 'js' && !ctx.memory.shared && !ctx.memory.atomic && ctx.transform.optimize?.compact !== false
  && ctx.transform.optimize?.arenaRewind !== false && !ctx.memory.fixed?.length

/** Whether loops compact in place (optimize/loop-compact.js): the growth
 *  helpers then log the stubs a compaction must rewrite (`stubLogIR`). */
export const sitesOn = () => compactOn() && !!ctx.plans.compactLoopLabels?.size
/** The stub log: a block older than the innermost compacting loop that grew
 *  left a stub forwarding to its new block, which a caller's local may still
 *  name; entries of [stub address, box of the new block], 16 bytes each.
 *  `optimize.compactStubs` sets how many: 65,536 (1 MB of address space, a
 *  page of it resident per 4,096 entries written) holds a parser's run ten
 *  times over; a compiler's phases take a million. */
export const stubEntries = () => {
  const asked = ctx.transform.optimize?.compactStubs ?? 65536
  // a declared maximum bounds the table to a sixteenth of the memory
  const max = ctx.memory.max > 0 ? ctx.memory.max * 65536 : 0
  return max ? Math.max(16, Math.min(asked, max >> 8)) : asked
}
export const stubLogBytes = () => stubEntries() * 16
/** The globals of a module whose loops compact: the stub log's table and
 *  count (all ones once it overflowed: no loop compacts until the next
 *  outermost call), and the highest mark a compacting loop took in this call. */
/** The host's pin, declared with the kernels (wat/assemble/stdlib-pull.js): the
 *  end of the highest block the host holds by address (a view of the module's
 *  memory, a closure, storage it made). No compaction moves memory below it;
 *  the host raises it as it decodes (interop.js). */
/** A walk's cost saturates here (a gibibyte): twice it still fits an i32, and
 *  past it the pressure rule, not the amortizing one, times compactions. */
export const COST_CAP = 1 << 30
/** A loop site's slack past twice the walked cost, and the margin it keeps
 *  from the memory's cap for the kernel's scratch (optimize/loop-compact.js). */
export const SLACK = 16 << 20, MARGIN = 64 << 20
export const declarePin = () => {
  if (ctx.scope.globals.has('__pin')) return
  declGlobal('__pin', 'i32', 0, { export: '__pin' })
  // what the last compaction walked, in bytes of the blocks it reached above
  // the floor and below: what the next one costs, which its trigger amortizes
  // (the host's `settle`, interop.js; a loop's site, optimize/loop-compact.js)
  declGlobal('__g_cost', 'i32', 0, { export: '__g_cost' })
}
export const declareSites = () => {
  declarePin()
  if (ctx.scope.globals.has('__stubn')) return
  const dbg = typeof process !== 'undefined' && process.env?.JZ_DEBUG_GC === '1'
  for (const g of ['__stubs', '__stubn', '__lmark']) declGlobal(g, 'i32', 0, dbg ? { export: g } : undefined)
}
/** A growth helper's log of the stub it leaves at `off`, forwarding to `newOff`. */
export const stubLogIR = (off, newOff, tag) => sitesOn()
  ? `(call $__gc_stub (local.get $${off}) (i64.reinterpret_f64 (call $__mkptr (i32.const ${tag}) (i32.const 0) (local.get $${newOff}))))` : ''
