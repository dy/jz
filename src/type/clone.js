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
export function cloneWithSubst(node, subst, rename = null) {
  if (!(subst instanceof Map)) {
    const name = subst, value = rename
    if (node === name) return [null, value]
    if (!Array.isArray(node)) return node
    if (node[0] === '=>') return node
    const out = node.map(x => cloneWithSubst(x, name, value))
    stampClonedIdxProof(node, out)
    return out
  }
  const ren = rename instanceof Map ? rename : new Map()
  if (typeof node === 'string') {
    if (subst.has(node)) return cloneNode(subst.get(node))
    return ren.get(node) || node
  }
  if (!Array.isArray(node)) return node
  const op = node[0]
  if (op === 'str') return node.slice()
  if (op === '=>') return node
  if (op === '.' || op === '?.') return [op, cloneWithSubst(node[1], subst, ren), node[2]]
  if (op === ':') return [op, node[1], cloneWithSubst(node[2], subst, ren)]
  const out = node.map((part, i) => i === 0 ? part : cloneWithSubst(part, subst, ren))
  stampClonedIdxProof(node, out)
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
  // intervalProvenIdx(ctx) above already populated getFactStore().ipRanges for
  // ctx.func.body when it's a valid function body (AdHocMemo retirement — was
  // ctx.func.ipRanges, a plain field mirroring the same memoized Map).
  const ranges = Array.isArray(ctx.func?.body) ? getFactStore().ipRanges.get(ctx.func.body) : null
  const rng = ranges?.get(k)
  if (rng != null) ranges.set(idxKey(out[1], out[2]), rng)   // hulls survive substitution too
  const owner = ctx.types?.assumedBounds?.get(k)
  if (owner != null) ctx.types.assumedBounds.set(idxKey(out[1], out[2]), owner)
}
