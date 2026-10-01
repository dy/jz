/**
 * Clone an AST subtree with substitutions/renames (loop unroll, inline), carrying
 * typed-bounds proofs across the clone: substitution only SHRINKS an index's value
 * set, so a proven typed access stays proven under its post-substitution key.
 *
 * @module type/clone
 */
import { cloneNode } from '../ast.js'
import { ctx, getFactStore } from '../ctx.js'
import { idxKey } from './canonical-bounds.js'
import { intervalProvenIdx } from './interval-proof.js'

/** Clone AST with substitutions/renames. Skips into `=>` bodies. */
export function cloneWithSubst(node, subst, rename = null, closures = false) {
  if (!(subst instanceof Map)) {
    const name = subst, value = rename
    if (node === name) return [null, value]
    if (!Array.isArray(node)) return node
    if (node[0] === '=>') return node
    const out = node.map(x => cloneWithSubst(x, name, value))
    stampClonedIdxProof(node, out)
    return carrySite(node, out)
  }
  const ren = rename instanceof Map ? rename : new Map()
  if (typeof node === 'string') {
    if (subst.has(node)) return cloneNode(subst.get(node))
    return ren.get(node) || node
  }
  if (!Array.isArray(node)) return node
  const op = node[0]
  if (op === 'str') return carrySite(node, node.slice())
  // A closure is cloned where the caller names its bindings anew with the body's
  // (a spliced body that makes closures, plan/inline.js); else it is the node itself.
  if (op === '=>' && !closures) return node
  if (op === '.' || op === '?.') return carrySite(node, [op, cloneWithSubst(node[1], subst, ren, closures), node[2]])
  if (op === ':') return carrySite(node, [op, node[1], cloneWithSubst(node[2], subst, ren, closures)])
  const out = node.map((part, i) => i === 0 ? part : cloneWithSubst(part, subst, ren, closures))
  stampClonedIdxProof(node, out)
  return carrySite(node, out)
}

/** A clone keeps its source site for diagnostics. An escape site's clone is
 *  also a site of the same origin: whichever copy is emitted flags it. */
function carrySite(node, out) {
  if (node.loc != null) out.loc = node.loc
  const sites = ctx.plans?.escapeSites
  if (sites?.has(node)) {
    sites.add(out)
    ;(ctx.plans.siteOrigin ??= new WeakMap()).set(out, ctx.plans.siteOrigin.get(node) ?? node)
  }
  return out
}

/** Proof carry-over for clones: substitution only SHRINKS an index's value set (an
 *  unrolled iv becomes one literal from its proven range), so a proven typed access
 *  stays proven under its post-substitution key — without this, loop unrolling
 *  silently re-checks every access the interval walk or a versioned guard covered. */
function stampClonedIdxProof(node, out) {
  if (node[0] !== '[]' || node.length !== 3 || typeof node[1] !== 'string' || out[1] !== node[1]) return
  const k = idxKey(node[1], node[2])
  const ip = intervalProvenIdx(ctx)   // memoized; NO_INTERVAL_PROVEN when no function ctx
  if (ip.has(k)) ip.add(idxKey(out[1], out[2]))
  if (ip.has(node)) ip.add(out)   // the occurrence's own proof, carried to its clone
  // intervalProvenIdx(ctx) above already populated getFactStore().ipRanges for
  // ctx.func.body when it's a valid function body (AdHocMemo retirement — was
  // ctx.func.ipRanges, a plain field mirroring the same memoized Map).
  const ranges = Array.isArray(ctx.func?.body) ? getFactStore().ipRanges.get(ctx.func.body) : null
  const rng = ranges?.get(k)
  if (rng != null) ranges.set(idxKey(out[1], out[2]), rng)   // hulls survive substitution too
  const owner = ctx.types?.assumedBounds?.get(k)
  if (owner != null) ctx.types.assumedBounds.set(idxKey(out[1], out[2]), owner)
}
