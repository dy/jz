/**
 * The own-property probe a synthesized protocol function makes before it
 * reaches a class's method (to-json.js; to-primitive.js makes the same one):
 * an own property shadows the class's member, callable or not, and only its
 * absence reaches the class. These are intrinsic reads and calls, not source
 * member accesses, so the member census stays valid after synthesis.
 *
 * @module compile/emit/own-method
 */
import { ctx, inc, PTR, LAYOUT, OPTF } from '../../ctx.js'
import { typed, asF64, asI64, ptrTypeEq, boxedPtrTypeEq, ptrOffsetIR, block64, temp, tempI32, undefExpr, TOMB_NAN, UNDEF_NAN } from '../../ir.js'
import { emit } from '../../bridge.js'
import { strHashLiteral } from '../../../module/collection.js'
import { i64Hex } from '../../../layout.js'
import { VAL } from '../../reps.js'

const TAG_MASK_HEX = i64Hex(BigInt(LAYOUT.TAG_MASK) << BigInt(LAYOUT.TAG_SHIFT))
const STRING_TAG_HEX = i64Hex(BigInt(PTR.STRING) << BigInt(LAYOUT.TAG_SHIFT))

/** An own property named like a builtin shadows it (ES2024 10.1.8.1): the
 *  receiver `objIR`'s own `name` where it holds a closure yields
 *  `onOverride($p, $o)`, else `onFallback($o)` (both f64). A number or a string
 *  owns no such property (string writes drop, module/collection.js). Neither
 *  does an array whose word before its header is zero, here or in the global
 *  table (`__dyn_get_expr_t` reads the same word), so a plain array reaches
 *  the builtin without a lookup: a `push` through a receiver of no known kind
 *  paid a key hash and a probe per element. The rest look the key up prehashed,
 *  and a layout that holds the key is a slot load (optimize/devirt.js). */
export function sidecarOverride(objIR, name, onOverride, onFallback) {
  const o = temp('vo'), p = temp('vp')
  const box = () => typed(['local.get', `$${o}`], 'f64')
  const bits = () => ['i64.reinterpret_f64', ['local.get', `$${o}`]]
  const key = asI64(emit(['str', name]))
  let probe
  // Without the collection module no value has own properties: its stub misses.
  // The size tier keeps one call a site (it builds no slot loads either).
  if (ctx.core.stdlib.__dyn_get_expr_t_h && !ctx.transform.optimize?.leanRuntime) {
    inc('__dyn_get_expr_t_h')
    const call = ['call', '$__dyn_get_expr_t_h', bits(), key,
      ['i32.wrap_i64', ['i64.and', ['i64.shr_u', bits(), ['i64.const', LAYOUT.TAG_SHIFT]], ['i64.const', LAYOUT.TAG_MASK]]],
      ['i32.const', strHashLiteral(name)]]
    if ((ctx.transform.optFlags & OPTF.devirtDynProps) && !ctx.func._schemaSpecSlow) call.dvProp = name
    const base = tempI32('vb')
    probe = ['if', ['result', 'f64'],
      ['if', ['result', 'i32'], boxedPtrTypeEq(box(), PTR.ARRAY),
        ['then', ['local.set', `$${base}`, ptrOffsetIR(box(), VAL.ARRAY)],
          ['if', ['result', 'i32'], ['i32.ge_u', ['local.get', `$${base}`], ['i32.const', 16]],
            ['then', ['i64.eqz', ['i64.load', ['i32.sub', ['local.get', `$${base}`], ['i32.const', 16]]]]],
            ['else', ['i32.const', 0]]]],
        ['else', ['i32.const', 0]]],
      ['then', undefExpr()],
      ['else', ['f64.reinterpret_i64', call]]]
  } else {
    inc('__dyn_get_expr')
    probe = ['f64.reinterpret_i64', ['call', '$__dyn_get_expr', bits(), key]]
  }
  return block64(
    ['local.set', `$${o}`, asF64(objIR)],
    ['local.set', `$${p}`, ['if', ['result', 'f64'],
      ['i32.and', ['f64.ne', box(), box()],
        ['i64.ne', ['i64.and', bits(), ['i64.const', TAG_MASK_HEX]], ['i64.const', STRING_TAG_HEX]]],
      ['then', probe],
      ['else', undefExpr()]]],
    ['if', ['result', 'f64'],
      ptrTypeEq(['local.get', `$${p}`], PTR.CLOSURE),
      ['then', onOverride(p, o)],
      ['else', onFallback(o)]])
}

export function defineOwnMethodOps() {
  // `r`'s own property `name`, TOMB where it has none
  ctx.core.emit.__own_get = (r, name) => {
    ctx.module.include('collection')
    ctx.module.include('string')
    ctx.runtime.schemaTblConsumed = true
    inc('__dyn_get_t_hm', '__ptr_type')
    const bits = asI64(emit(r))
    return typed(['f64.reinterpret_i64', ['call', '$__dyn_get_t_hm', bits, asI64(emit(name)),
      ['call', '$__ptr_type', bits], ['i32.const', strHashLiteral(name[1])]]], 'f64')
  }
  ctx.core.emit.__own_missing = (v) => typed(['i64.eq', asI64(emit(v)), ['i64.const', TOMB_NAN]], 'i32')
  ctx.core.emit.__own_callable = (v) => ptrTypeEq(asF64(emit(v)), PTR.CLOSURE)
  // the closure `m` called with `r` as `this`; a program without closures has none to call
  ctx.core.emit.__own_call = (m, r, ...args) => ctx.closure.call
    ? ctx.closure.call(typed(asF64(emit(m)), 'f64'), args, false, false, asF64(emit(r)))
    : typed(['f64.reinterpret_i64', ['i64.const', UNDEF_NAN]], 'f64')
}
