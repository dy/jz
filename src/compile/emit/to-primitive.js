/**
 * OrdinaryToPrimitive (ES2024 7.1.1.1) shared by known and unknown receivers,
 * synthesized as prepared functions the runtime coercion kernels (`__to_str`,
 * `__to_num`, `__eq`, the dynamic `+`) call by name: an own `toString`/`valueOf`
 * slot is probed and called, a class instance reaches its class function, and
 * a method that returns an object falls through to the next method or the
 * TypeError the spec requires. The inherited Object.prototype.toString
 * resolves to `[object Object]`.
 *
 * A program with no user `toString`/`valueOf` anywhere synthesizes nothing;
 * the kernels keep their constant arm. The functions are runtime roots
 * (`ctx.funcs.runtimeRoots`): address-taken, so they keep the boxed ABI the
 * kernels call with.
 *
 * @module compile/emit/to-primitive
 */
import { ctx, inc, PTR } from '../../ctx.js'
import { createFunction } from '../../function.js'
import { typed, asF64, asI64, ptrTypeEq, UNDEF_NAN, TOMB_NAN, TO_PRIMITIVE } from '../../ir.js'
import { emit } from '../../bridge.js'
import { errorCodeLiteral, ERR } from '../../../err-codes.js'
import { stringHash } from '../../string-data.js'
import { memberUses } from './class-dispatch.js'

const T = '__jz_tp_'
/** Hint string: `toString`, then `valueOf`. */
const TO_PRIM_STR = TO_PRIMITIVE.string
/** Hint number and default: `valueOf`, then `toString`. */
const TO_PRIM_NUM = TO_PRIMITIVE.number
const R = T + 'r', V = T + 'v', M = T + 'm'

const classes = () => ctx.transform.classes
const depth = (e) => { let d = 0; for (let c = e; c.base; c = classes().get(c.base)) d++; return d }
/** Classes with a method `name`, most derived first, so an override wins its base. */
const classesWith = (name) => classes()
  ? [...classes().values()].filter(e => e.methods.has(name)).sort((a, b) => depth(b) - depth(a)) : []

/** The prelude adds direct class calls and intrinsic property probes, not new
 * source member accesses, so the shared census remains valid after synthesis. */
export function synthesizeToPrimitive() {
  if (ctx.funcs.list.some(f => f.name === TO_PRIM_STR)) return
  const { defined, written } = memberUses()
  if (!['toString', 'valueOf'].some(name => defined.has(name) || written.has(name))) return
  // Preserve absence as TOMB: an own undefined/null/non-callable value
  // shadows the class/prototype method just as a callable own property does.
  ctx.core.emit.__tp_get = (r, propLit) => {
    ctx.module.include('collection')
    ctx.module.include('string')
    ctx.runtime.schemaTblConsumed = true
    inc('__dyn_get_t_hm')
    return typed(['f64.reinterpret_i64', ['call', '$__dyn_get_t_hm', asI64(emit(r)), asI64(emit(propLit)),
      ['i32.const', PTR.OBJECT], ['i32.const', stringHash(propLit[1])]]], 'f64')
  }
  ctx.core.emit.__tp_missing = (v) => typed(['i64.eq', asI64(emit(v)), ['i64.const', TOMB_NAN]], 'i32')
  ctx.core.emit.__tp_callable = (v) => ptrTypeEq(asF64(emit(v)), PTR.CLOSURE)
  ctx.core.emit.__tp_call = (v, r) => ctx.closure.call
    ? ctx.closure.call(typed(asF64(emit(v)), 'f64'), [], false, false, asF64(emit(r)))
    : typed(['f64.reinterpret_i64', ['i64.const', UNDEF_NAN]], 'f64')
  ctx.core.emit.__isprim = (v) => { inc('__is_object'); return typed(['i32.eqz', ['call', '$__is_object', asI64(asF64(emit(v)))]], 'i32') }
  ctx.core.emit.__tperr = () => {
    ctx.runtime.throws = true
    const code = ['f64.const', errorCodeLiteral(ERR.TO_PRIMITIVE)]
    return typed(['block', ['result', 'f64'],
      ['global.set', '$__jz_last_err_bits', ['i64.reinterpret_f64', code]],
      ['throw', '$__jz_err', code]], 'f64')
  }
  const call = (fn, arg) => ['()', fn, arg]
  const block = (...stmts) => ['{}', [';', ...stmts]]
  const accept = (value) => block(['=', V, value], ['if', ['__isprim', V], ['return', V]])
  const step = (prop) => {
    // Only absence reaches inherited methods. A non-callable own slot skips
    // this method; an object result proceeds to the next lookup, after effects.
    let inherited = prop === 'toString' ? ['return', ['str', '[object Object]']] : block()
    for (const e of classesWith(prop).reverse())
      inherited = ['if', ['instanceof', R, e.brand], accept(call(e.methods.get(prop), R)), inherited]
    return block(['=', M, ['__tp_get', R, ['str', prop]]],
      ['if', ['__tp_missing', M], inherited,
        ['if', ['__tp_callable', M], accept(['__tp_call', M, R])]])
  }
  for (const [name, order] of [[TO_PRIM_STR, ['toString', 'valueOf']], [TO_PRIM_NUM, ['valueOf', 'toString']]]) {
    ctx.funcs.list.push(createFunction(name,
      block(['let', M, V], ...order.map(step), ['return', ['__tperr']]),
      { params: [{ name: R, type: 'f64' }], results: ['f64'], dispatcher: true }))
    ctx.funcs.runtimeRoots.add(name)
  }
}
