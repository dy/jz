/**
 * The accessor a builtin reaches over a layout with one (module/schema.js
 * enumView): Object.values and entries, for-in, JSON.stringify, spread,
 * Object.assign and structuredClone read a literal's getter, a computed-key
 * read `o[k]` runs it and a computed-key store runs the setter. Either is the
 * closure in its `x__get` / `x__set` slot, called with the object as `this`.
 * Inline enumerations and the runtime kernels call it through one prepared
 * function, as the coercion kernels call ToPrimitive (to-primitive.js). A
 * program whose object literals define no accessor synthesizes nothing.
 *
 * @module compile/emit/accessor-call
 */
import { ctx } from '../../ctx.js'
import { createFunction } from '../../function.js'
import { typed, asF64 } from '../../ir.js'
import { emit } from '../../bridge.js'

/** `(accessor, receiver, value) → result`, the boxed ABI: a getter ignores `value`. */
export const ACCESSOR_CALL = '__jz_accessor'
const F = ACCESSOR_CALL + '_f', R = ACCESSOR_CALL + '_r', V = ACCESSOR_CALL + '_v'

export function synthesizeAccessorCall() {
  if (!ctx.transform.literalAccessorNames?.size || ctx.funcs.list.some(f => f.name === ACCESSOR_CALL)) return
  ctx.core.emit.__accessor_call = (f, r, v) => ctx.closure.call(typed(asF64(emit(f)), 'f64'), [v], false, false, asF64(emit(r)))
  ctx.funcs.list.push(createFunction(ACCESSOR_CALL, ['{}', [';', ['return', ['__accessor_call', F, R, V]]]],
    { params: [{ name: F, type: 'f64' }, { name: R, type: 'f64' }, { name: V, type: 'f64' }], results: ['f64'], dispatcher: true }))
  ctx.funcs.runtimeRoots.add(ACCESSOR_CALL)
  // the kernels that call it, and the data copy the module exports
  // (start-fn.js), live in the collection module
  ctx.module.include('collection')
}
