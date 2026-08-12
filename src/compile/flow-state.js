import { ctx } from '../ctx.js'

/** Scope one active-function field with throw-safe restoration. */
export function withFunctionField(field, value, fn) {
  const frame = ctx.func
  const previous = frame[field]
  frame[field] = value
  try { return fn() }
  finally { frame[field] = previous }
}

export const withValueOverlay = (value, fn) => withFunctionField('localValTypesOverlay', value, fn)
export const withTypedElemOverlay = (value, fn) => withFunctionField('localTypedElemsOverlay', value, fn)
export const withExpectedValue = (value, fn) => withFunctionField('_expect', value, fn)
export const withTryState = (value, fn) => withFunctionField('inTry', value, fn)
export const withFinallyStack = (value, fn) => withFunctionField('finallyStack', value, fn)
export const withFlowBlocked = (value, fn) => withFunctionField('flowValBlocked', value, fn)
export const withSchemaSpeculation = (value, fn) => withFunctionField('_schemaSpecSlow', value, fn)
