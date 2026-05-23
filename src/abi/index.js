/**
 * src/abi — internal codegen carriers + per-site dispatch.
 *
 * @module src/abi
 */

import nanboxF64 from './number.js'
import sso, { jsstring } from './string.js'
import tagged from './object.js'
import taggedLinear, { structInline } from './array.js'

/** All carriers per value type — keyed by stable id for rep.carrier lookup. */
export const CARRIERS = Object.freeze({
  number: Object.freeze({ nanboxF64 }),
  string: Object.freeze({ sso, jsstring }),
  object: Object.freeze({ tagged }),
  array: Object.freeze({ taggedLinear, structInline }),
})

const DEFAULT_ID = Object.freeze({
  number: 'nanboxF64',
  string: 'sso',
  object: 'tagged',
  array: 'taggedLinear',
})

/** Pick carrier bundle for `type` given optional binding rep hints. */
export function resolveCarrier(type, rep) {
  const table = CARRIERS[type]
  if (!table) return null
  const id = rep?.carrier ?? DEFAULT_ID[type]
  return table[id] ?? table[DEFAULT_ID[type]]
}

/** Default carrier ops bundle — backward-compatible flat shape on ctx.abi. */
export const DEFAULTS = Object.freeze({
  number: nanboxF64,
  string: sso,
  object: tagged,
  array: taggedLinear,
})

/** ctx.abi bundle: default carriers + resolve() + registry. */
export function makeAbi() {
  return Object.assign(Object.create(null), DEFAULTS, {
    carriers: CARRIERS,
    resolve: resolveCarrier,
  })
}

export { nanboxF64, sso, jsstring, tagged, taggedLinear, structInline }
