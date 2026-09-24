/**
 * JSON.stringify's `toJSON` step (SerializeJSONProperty): before the walker
 * (module/json.js) serializes an object, it calls the object's `toJSON` with
 * the property's key and serializes the result. An own property shadows the
 * class's method (own-method.js); an instance without one reaches its class's
 * function, a derived class's first. The walker calls this through one
 * prepared function, as the coercion kernels call ToPrimitive
 * (to-primitive.js). A program that defines no `toJSON`, or never names JSON
 * (whose walker alone calls it), synthesizes nothing.
 *
 * @module compile/emit/to-json
 */
import { ctx } from '../../ctx.js'
import { createFunction } from '../../function.js'
import { memberUses } from './class-dispatch.js'
import { defineOwnMethodOps } from './own-method.js'

/** `(value, key) → value`, the boxed ABI: `key` the property name or array index. */
export const TO_JSON = '__jz_tojson'
const V = TO_JSON + '_v', K = TO_JSON + '_k', M = TO_JSON + '_m'

const classes = () => ctx.transform.classes
const depth = (e) => { let d = 0; for (let c = e; c.base; c = classes().get(c.base)) d++; return d }
/** Classes with a `toJSON`, most derived first, so an override wins its base. */
const holders = () => classes() ? [...classes().values()].filter(e => e.methods.has('toJSON')).sort((a, b) => depth(b) - depth(a)) : []

export function synthesizeToJSON() {
  if (!ctx.module.demanded.has('json') || ctx.funcs.list.some(f => f.name === TO_JSON)) return
  const { defined, written } = memberUses(), own = defined.has('toJSON') || written.has('toJSON'), classed = holders()
  if (!own && !classed.length) return
  const key = ['()', 'String', K]
  let inherited = ['return', V]
  for (const e of [...classed].reverse())
    inherited = ['if', ['instanceof', V, e.brand], ['return', ['()', e.methods.get('toJSON'), [',', V, key]]], inherited]
  if (own) defineOwnMethodOps()
  const body = own
    ? [['let', M], ['=', M, ['__own_get', V, ['str', 'toJSON']]],
      ['if', ['__own_missing', M], inherited, ['if', ['__own_callable', M], ['return', ['__own_call', M, V, key]]]],
      ['return', V]]
    : [inherited]
  ctx.funcs.list.push(createFunction(TO_JSON, ['{}', [';', ...body]],
    { params: [{ name: V, type: 'f64' }, { name: K, type: 'f64' }], results: ['f64'], dispatcher: true }))
  ctx.funcs.runtimeRoots.add(TO_JSON)
}
