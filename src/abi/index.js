/**
 * src/abi — fixed default codegen carriers.
 *
 * @module src/abi
 */

import nanboxF64 from './number.js'
import sso, { jsstring } from './string.js'
import tagged, { packedI32 } from './object.js'
import taggedLinear, { structInline } from './array.js'

/** Shared across compilations. The string emitter selects its optional
 * externref carrier directly; the other families have fixed defaults. */
export default Object.freeze({
  number: nanboxF64,
  string: sso,
  object: tagged,
  array: taggedLinear,
})

export { nanboxF64, sso, jsstring, tagged, packedI32, taggedLinear, structInline }
