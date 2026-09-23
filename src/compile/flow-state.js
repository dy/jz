import { ctx } from '../ctx.js'
import { makeMapOverlay } from './map-overlay.js'

// Every scope here names its field statically. The record is a fixed-shape
// object; one computed-key access (`frame[field] = value`) would make it a
// dynamic-keyed record everywhere: a sidecar hash of every field beside the
// slots, built at every frame entry (3 KB and 46 dynamic writes per frame in
// the self-compile), and a hash probe behind every `ctx.func.x` read.

/** Push one control frame and pop it from the same owning stack on every exit. */
export function withControlFrame(value, fn) {
  const stack = ctx.func.stack
  stack.push(value)
  try { return fn(value) }
  finally { stack.pop() }
}

export function withValueOverlay(value, fn) {
  const frame = ctx.func, previous = frame.localValTypesOverlay
  frame.localValTypesOverlay = value
  try { return fn() }
  finally { frame.localValTypesOverlay = previous }
}

export function withTypedElemOverlay(value, fn) {
  const frame = ctx.func, previous = frame.localTypedElemsOverlay
  frame.localTypedElemsOverlay = value
  try { return fn() }
  finally { frame.localTypedElemsOverlay = previous }
}

export function withExpectedValue(value, fn) {
  const frame = ctx.func, previous = frame._expect
  frame._expect = value
  try { return fn() }
  finally { frame._expect = previous }
}

export function withTryState(value, fn) {
  const frame = ctx.func, previous = frame.inTry
  frame.inTry = value
  try { return fn() }
  finally { frame.inTry = previous }
}

export function withFinallyStack(value, fn) {
  const frame = ctx.func, previous = frame.finallyStack
  frame.finallyStack = value
  try { return fn() }
  finally { frame.finallyStack = previous }
}

export function withSchemaSpeculation(value, fn) {
  const frame = ctx.func, previous = frame._schemaSpecSlow
  frame._schemaSpecSlow = value
  try { return fn() }
  finally { frame._schemaSpecSlow = previous }
}

export function withArrayLiteralEscape(value, fn) {
  const frame = ctx.func, previous = frame._arrayLiteralNeverEscapes
  frame._arrayLiteralNeverEscapes = value
  try { return fn() }
  finally { frame._arrayLiteralNeverEscapes = previous }
}

export function withCurrentFunction(value, fn) {
  const frame = ctx.func, previous = frame.current
  frame.current = value
  try { return fn() }
  finally { frame.current = previous }
}

export function withTypedElems(value, fn) {
  const frame = ctx.func, previous = frame.typedElem
  frame.typedElem = value
  try { return fn() }
  finally { frame.typedElem = previous }
}

/** A query before emission that must see the body analysis's local typed
 *  receivers and lengths, which the emitter installs later. */
export function withBodyTypedFacts(facts, fn) {
  const frame = ctx.func, elem = frame.typedElem, len = frame.typedLen
  if (facts?.typedElems?.size) frame.typedElem = makeMapOverlay(elem ?? new Map(), new Map(facts.typedElems))
  if (facts?.typedLens?.size) frame.typedLen = makeMapOverlay(len ?? new Map(), new Map(facts.typedLens))
  try { return fn() }
  finally { frame.typedElem = elem; frame.typedLen = len }
}

export function withPendingLabel(value, fn) {
  const frame = ctx.func, previous = frame.pendingLabel
  frame.pendingLabel = value
  try { return fn() }
  finally { frame.pendingLabel = previous }
}

/** A binding initializer's emission scope: the self-accumulating concat target and the array-literal escape verdict, as one transaction. */
export function withInitializerScope(selfAccumConcat, arrayLiteralNeverEscapes, fn) {
  const frame = ctx.func
  const previousConcat = frame._selfAccumConcat, previousEscape = frame._arrayLiteralNeverEscapes
  frame._selfAccumConcat = selfAccumConcat
  frame._arrayLiteralNeverEscapes = arrayLiteralNeverEscapes
  try { return fn() }
  finally {
    frame._arrayLiteralNeverEscapes = previousEscape
    frame._selfAccumConcat = previousConcat
  }
}
