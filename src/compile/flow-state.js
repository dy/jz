import { ctx } from '../ctx.js'

/** Scope one active-function field with throw-safe restoration. */
export function withFunctionField(field, value, fn) {
  const frame = ctx.func
  const previous = frame[field]
  frame[field] = value
  try { return fn() }
  finally { frame[field] = previous }
}

/** Scope several fields as one transaction on the same owning record. */
export function withFunctionFields(values, fn) {
  const frame = ctx.func
  const keys = Object.keys(values)
  const previous = keys.map(key => frame[key])
  for (let i = 0; i < keys.length; i++) frame[keys[i]] = values[keys[i]]
  try { return fn() }
  finally { for (let i = keys.length - 1; i >= 0; i--) frame[keys[i]] = previous[i] }
}

/** Push one control frame and pop it from the same owning stack on every exit. */
export function withControlFrame(value, fn) {
  const stack = ctx.func.stack
  stack.push(value)
  try { return fn(value) }
  finally { stack.pop() }
}

export const withValueOverlay = (value, fn) => withFunctionField('localValTypesOverlay', value, fn)
export const withTypedElemOverlay = (value, fn) => withFunctionField('localTypedElemsOverlay', value, fn)
export const withExpectedValue = (value, fn) => withFunctionField('_expect', value, fn)
export const withTryState = (value, fn) => withFunctionField('inTry', value, fn)
export const withFinallyStack = (value, fn) => withFunctionField('finallyStack', value, fn)
export const withFlowBlocked = (value, fn) => withFunctionField('flowValBlocked', value, fn)
export const withSchemaSpeculation = (value, fn) => withFunctionField('_schemaSpecSlow', value, fn)
export const withArrayLiteralEscape = (value, fn) => withFunctionField('_arrayLiteralNeverEscapes', value, fn)
export const withCurrentFunction = (value, fn) => withFunctionField('current', value, fn)
export const withTypedElems = (value, fn) => withFunctionField('typedElem', value, fn)
export const withPendingLabel = (value, fn) => withFunctionField('pendingLabel', value, fn)
