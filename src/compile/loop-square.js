// A nonnegative, unit-stepped integer counter under `i*i < CONST` has a
// canonical counter bound. Expose that bound to the shared range analysis;
// its body then narrows products and dependent counters by their true hulls.
import { ctx } from '../ctx.js'
import { counterInit } from '../static.js'
import { loopLitVal, unitIncVar, normalizeLoop, rewriteBlocks, loopHazards } from './loop-model.js'

const SQUARE_BOUND_MAX = 2 ** 30
const boundVal = n => {
  const lit = loopLitVal(n)
  if (lit != null) return lit
  if (typeof n === 'string') { const v = ctx.scope.constInts?.get(n); return typeof v === 'number' ? v : null }
  return null
}
const isSquare = n => Array.isArray(n) && n[0] === '*' && typeof n[1] === 'string' && n[1] === n[2]

function tryNarrow(stmt, cm) {
  const loop = normalizeLoop(stmt)
  // A while's initializer is outside this occurrence; its entry value is not
  // proved here. In particular, Math.imul could wrap its first square to zero.
  if (!loop || loop.kind !== 'for') return null
  const { init, cond, step, body } = loop
  if (!Array.isArray(cond)) return null
  const op = cond[0], mirrored = op === '>' || op === '>='
  if (!mirrored && op !== '<' && op !== '<=') return null
  const product = cond[mirrored ? 2 : 1], bound = boundVal(cond[mirrored ? 1 : 2])
  if (!isSquare(product) || !Number.isInteger(bound) || bound < 0 || bound > SQUARE_BOUND_MAX) return null
  const iv = product[1], start = boundVal(counterInit(init, iv))
  if (!Number.isSafeInteger(start) || start < 0 || Object.is(start, -0) ||
      cm.has(iv) || unitIncVar(step) !== iv || loopHazards(cm, body).mutated(iv)) return null
  // Integer squares are exact in this envelope, including the first false
  // test. A large positive entry is still correctly rejected by the bound.
  const inclusive = op.length === 2
  const limit = inclusive ? Math.floor(Math.sqrt(bound)) : Math.ceil(Math.sqrt(bound))
  return [['for', init, [inclusive ? '<=' : '<', iv, [null, limit]], step, body]]
}

export function narrowBoundedSquare(body, cm) {
  return rewriteBlocks(body, stmt => tryNarrow(stmt, cm))
}
