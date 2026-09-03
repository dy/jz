/**
 * Dynamic-key refinement: `ctx.types.anyDynKey` says some computed-index
 * access or `for-in` in the program may read an object dynamically, which
 * makes every reachable object carry a props sidecar. A receiver the program
 * summary knows as a typed array, an array or a string is indexed, not
 * read by key, so an access on it is not dynamic; when every such access
 * resolves that way the flag drops.
 *
 * @module compile/narrow/dyn-keys
 */

import { ctx } from '../../ctx.js'
import { REFS_THROUGH_ARROWS, some } from '../../ast.js'
import { isLiteralStr } from '../../ir.js'
import { isExported } from '../func-exports.js'
import { K, tagOf } from '../../summary/index.js'

// A receiver of bottom kind is one no call reaches: the access never runs.
const INDEXED = new Set([K.TYPED, K.ARRAY, K.STRING, K.NONE])

export function refineDynKeys(programFacts) {
  if (!ctx.types.anyDynKey) return
  const { paramReps } = programFacts
  const addressTaken = programFacts.programIndex.addressTaken
  const indexed = (recv) => INDEXED.has(tagOf(ctx.summary.kindOfExpr(recv)))
  const dynamic = (body) => some(body, n =>
    n[0] === 'for-in' || (n[0] === '[]' && !isLiteralStr(n[2]) && !indexed(n[1])), REFS_THROUGH_ARROWS)
  const isLive = f => isExported(f) || paramReps.has(f.name) || addressTaken.has(f.name)

  for (const f of ctx.funcs.list) if (f.body && isLive(f) && dynamic(f.body)) return
  if (ctx.module.initFacts?.anyDyn && ctx.module.moduleInits)
    for (const mi of ctx.module.moduleInits) if (dynamic(mi)) return
  ctx.types.anyDynKey = false
}
