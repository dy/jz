/**
 * A field cache nothing reads: its read leaves only the throw it may make.
 *
 * `e.type` tested against the names of several records (`isA(e) || isB(e)`,
 * guards spliced into one function) is one load (compile/cse-load.js): a
 * declaration `const t = e.type` before the statement, the tests reading `t`.
 * Where each record's literals store one name each, every test answers by the
 * layout the pointer carries (comparisons.js slotLiteralTest) and reads `t`
 * nowhere. The declaration still read the field: a dispatch over the layouts,
 * with the generic lookup behind them, its value dropped; the function grew by
 * it, past what V8 inlines into a loop that calls it (an automation list's
 * `getEventTime`, 554 bytes, called once per event a sample's search visits).
 *
 * The read is a slot load of a layout the summary lists for the receiver,
 * under a name no accessor bears (analyze-for-emit.js `fieldRead`): all it
 * may do besides the load is throw where the receiver is nullish. A
 * declaration records that throw (`noteFieldCacheGuard`), and where the
 * emitted body reads the cache nowhere, the throw takes the declaration's
 * place (`dropUnreadFieldCaches`).
 *
 * @module compile/emit/field-caches
 */
import { ctx } from '../../ctx.js'
import { cloneIR, isGlobal, isNullish, isUndef, throwTypeErrorIR, typed } from '../../ir.js'
import { K, NULL_BITS, hasTag, tagOf, tagsOf } from '../../summary/kind.js'

/** At the declaration `name = init` of a field cache: what its read does besides the load
 *  (`emit` the emitter's, passed in: the self-compiler's graph holds no import cycle). */
export function noteFieldCacheGuard(name, init, emit) {
  const read = ctx.func.fieldCaches?.get(name)
  if (!read || !Array.isArray(init) || init[0] !== '.' || init[1] !== read[1] || init[2] !== read[2]) return
  if (ctx.func.boxed.has(name) || isGlobal(name)) return
  const recv = read[1], k = ctx.summary?.at(ctx.func.current)?.kindOfExpr(recv)
  // a receiver of no kind the summary names, or never anything but nullish: the read stays
  if (k == null || tagOf(k) === K.ANY || (tagsOf(k) & ~NULL_BITS) === 0) return
  let guard = ['nop']
  if ((k & NULL_BITS) !== 0 && !ctx.func.refinements?.get(recv)?.notNullish) {
    const v = emit(recv)
    if (v?.type !== 'f64' || v.ptrKind != null || v.cellI32) return
    guard = ['if', (hasTag(k, K.NULLISH) ? isNullish : isUndef)(typed(v, 'f64')), ['then', ['drop', throwTypeErrorIR()]]]
  }
  ;(ctx.func.cacheGuards ??= new Map()).set(`$${name}`, guard)
}

/** In the statements `stmts` of a function's body: each declaration of a cache nothing reads, its throw. */
export function dropUnreadFieldCaches(stmts) {
  const guards = ctx.func.cacheGuards
  if (!guards?.size) return
  const read = new Set()
  const scan = (n) => {
    if (!Array.isArray(n)) return
    if ((n[0] === 'local.get' || n[0] === 'local.tee') && guards.has(n[1])) read.add(n[1])
    for (let i = 1; i < n.length; i++) scan(n[i])
  }
  for (const s of stmts) scan(s)
  if (read.size === guards.size) return
  const swap = (list, from) => {
    for (let i = from; i < list.length; i++) {
      const c = list[i]
      if (!Array.isArray(c)) continue
      if (c[0] === 'local.set' && c.length === 3 && guards.has(c[1]) && !read.has(c[1])) list[i] = cloneIR(guards.get(c[1]))
      else swap(c, 1)
    }
  }
  swap(stmts, 0)
}
