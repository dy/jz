/** Container payload and presence queries. Container contents are
 *  owned by the program summary; payload queries retain the missing-key
 *  distinction instead of promoting a read to an unconditional value kind. */

import { ctx } from '../ctx.js'
import { KIND_UNIVERSE, repOf, numericStorage } from '../reps.js'
import { K, tagOf, hasTag, valsOf, valOf, core } from '../summary/kind.js'

function dictValueKindSet(name) { return containerValueKindSet(name, K.HASH) }
export function dictValueKindOf(name) { return containerValueVal(name, K.HASH) }

// Container cells join every write and alias in the program summary.
function containerValueKind(name, tag) {
  if (typeof name !== 'string') return null
  const view = ctx.summary?.at(ctx.func.current)
  return view && tagOf(view.kindOf(name)) === tag ? view.elemKindOf(name) : null
}
function containerValueKindSet(name, tag) {
  const k = containerValueKind(name, tag)
  return k == null ? undefined : new Set(hasTag(k, K.NULLISH) ? KIND_UNIVERSE : valsOf(k))
}
function containerValueVal(name, tag) {
  const k = containerValueKind(name, tag)
  return k == null || hasTag(k, K.NULLISH) ? null : valOf(core(k))
}

function mapValueKindSet(name) { return containerValueKindSet(name, K.MAP) }
export function mapValueKindOf(name) { return containerValueVal(name, K.MAP) }

/** The bounded value families stored in a dictionary or Map. */
export function censusKindsOf(name) {
  const s = dictValueKindSet(name) ?? mapValueKindSet(name)
  return s ? new Set(s) : new Set()
}

export const censusShapedNode = (node) =>
  (Array.isArray(node) && (node[0] === '[]' || node[0] === '.') && node.length === 3 && typeof node[1] === 'string') ||
  (Array.isArray(node) && node[0] === '()' && node.length === 3 &&
    Array.isArray(node[1]) && node[1][0] === '.' && node[1][2] === 'get' && typeof node[1][1] === 'string')

/** Payload projection for the runtime's missing-value coercion paths.
 * Indexed Number loads already carry absence as NaN; dictionary/Map reads
 * need tagged coercion. Named storage carries the summary's presence beside
 * its chosen representation. */
export function censusMaybeUndefinedKind(node) {
  if (numericStorage(node)) return null
  if (typeof node === 'string') {
    const flow = ctx.func.localValTypesOverlay?.get(node)
    if (typeof flow === 'number') return hasTag(flow, K.ABSENT) || hasTag(flow, K.NULLISH) ? valOf(core(flow)) : null
    const r = repOf(node)
    return r?.mayBeUndefined ? r.presentVal ?? r.val ?? null : null
  }
  if (censusShapedNode(node)) {
    if (node[0] === '[]' || node[0] === '.') return dictValueKindOf(node[1])
    return mapValueKindOf(node[1][1])
  }
  if (Array.isArray(node) && node[0] === '()' && typeof node[1] === 'string') {
    const k = ctx.summary?.at(ctx.func.current).kindOfExpr(node)
    if (k != null && (hasTag(k, K.ABSENT) || hasTag(k, K.NULLISH))) return valOf(core(k))
  }
  return null
}

export const BIGINT_JOINT_BINARY_OPS = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>'])

export const censusMaybeUndefined = node => !!censusMaybeUndefinedKind(node)
