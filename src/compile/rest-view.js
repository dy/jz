/**
 * The rest slot view. A closure's rest parameter that never escapes
 * (analyze-scans.js restViewAliases) is read straight from the closure ABI's
 * argument slots – `$__argc`, `$__a0..$__a{W-1}`, and the spread call's
 * spill array past them – instead of an array packed at every entry.
 * `rest.length` is the argument count past the fixed parameters; `rest[i]`
 * is the slot when `i` is in range and undefined otherwise, as on an array.
 * A `for…of` alias reads the same view. The view record lives on the frame
 * (`ctx.func.restView`, name → view) for the `.`/`[]` emitters.
 *
 * @module compile/rest-view
 */
import { ctx } from '../ctx.js'
import { typed, tempI32, undefExpr } from '../ir.js'
import { idx as emitIndex } from '../bridge.js'
import { intLiteralValue } from '../static.js'

/** `rest.length`. */
export const restViewLength = (view) => typed(['f64.convert_i32_s', ['local.get', `$${view.len}`]], 'f64')

// Only a spread call passes more arguments than the inline slots hold
// (module/function.js: it publishes its array's offset in $__closure_spill).
const spilled = () => ctx.closure.spread !== false

// The spill array's offset, taken at entry once a read names it (closure-emit.js).
const spillIR = (view) => { view.spillUsed = true; return ['local.get', `$${view.spill}`] }

/** `rest[idx]`: a literal index reads its slot behind one bound check; a
 *  dynamic index selects among the inline slots and loads the spill past them. */
export function restViewRead(view, idx) {
  const k = intLiteralValue(idx)
  if (k != null) {
    if (k < 0 || (k >= view.slots && !spilled())) return undefExpr()
    const slot = k < view.slots
      ? ['local.get', `$__a${view.fixedN + k}`]
      : ['f64.load', ['i32.add', spillIR(view), ['i32.const', (view.fixedN + k) * 8]]]
    return typed(['if', ['result', 'f64'],
      ['i32.gt_s', ['local.get', `$${view.len}`], ['i32.const', k]],
      ['then', slot],
      ['else', undefExpr()]], 'f64')
  }
  const i = tempI32('ri')
  let inline = ['local.get', `$__a${view.fixedN + view.slots - 1}`]
  for (let j = view.slots - 2; j >= 0; j--)
    inline = ['select', ['local.get', `$__a${view.fixedN + j}`], inline, ['i32.eq', ['local.get', `$${i}`], ['i32.const', j]]]
  const read = !spilled() ? inline : ['if', ['result', 'f64'],
    ['i32.lt_u', ['local.get', `$${i}`], ['i32.const', view.slots]],
    ['then', inline],
    ['else', ['f64.load', ['i32.add', spillIR(view),
      ['i32.shl', ['i32.add', ['local.get', `$${i}`], ['i32.const', view.fixedN]], ['i32.const', 3]]]]]]
  return typed(['block', ['result', 'f64'],
    ['local.set', `$${i}`, emitIndex(idx)],
    ['if', ['result', 'f64'],
      ['i32.lt_u', ['local.get', `$${i}`], ['local.get', `$${view.len}`]],
      ['then', read],
      ['else', undefExpr()]]], 'f64')
}
