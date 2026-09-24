/**
 * The own-property probe a synthesized protocol function makes before it
 * reaches a class's method (to-json.js; to-primitive.js makes the same one):
 * an own property shadows the class's member, callable or not, and only its
 * absence reaches the class. These are intrinsic reads and calls, not source
 * member accesses, so the member census stays valid after synthesis.
 *
 * @module compile/emit/own-method
 */
import { ctx, inc, PTR } from '../../ctx.js'
import { typed, asF64, asI64, ptrTypeEq, TOMB_NAN, UNDEF_NAN } from '../../ir.js'
import { emit } from '../../bridge.js'
import { stringHash } from '../../string-data.js'

export function defineOwnMethodOps() {
  // `r`'s own property `name`, TOMB where it has none
  ctx.core.emit.__own_get = (r, name) => {
    ctx.module.include('collection')
    ctx.module.include('string')
    ctx.runtime.schemaTblConsumed = true
    inc('__dyn_get_t_hm', '__ptr_type')
    const bits = asI64(emit(r))
    return typed(['f64.reinterpret_i64', ['call', '$__dyn_get_t_hm', bits, asI64(emit(name)),
      ['call', '$__ptr_type', bits], ['i32.const', stringHash(name[1])]]], 'f64')
  }
  ctx.core.emit.__own_missing = (v) => typed(['i64.eq', asI64(emit(v)), ['i64.const', TOMB_NAN]], 'i32')
  ctx.core.emit.__own_callable = (v) => ptrTypeEq(asF64(emit(v)), PTR.CLOSURE)
  // the closure `m` called with `r` as `this`; a program without closures has none to call
  ctx.core.emit.__own_call = (m, r, ...args) => ctx.closure.call
    ? ctx.closure.call(typed(asF64(emit(m)), 'f64'), args, false, false, asF64(emit(r)))
    : typed(['f64.reinterpret_i64', ['i64.const', UNDEF_NAN]], 'f64')
}
