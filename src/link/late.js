/**
 * The late link: the module watr optimized goes onto the tape once more,
 * and what its fixpoint left runs again here, where nothing follows to
 * undo it: the fold, the vacuum, the block merge, and the locals order
 * (watr's coalescing renumbered the locals the first order was counted
 * on). Each pass shrinks or holds, so the module only gets smaller: 300
 * of 300 corpus rows, 12 KB; the flagship 3.3 KB, for 130 ms.
 *
 * When the tape's own passes cover watr's, watr's optimizer goes and the
 * two links are one.
 *
 * @module link/late
 */
import { resetTape, fromWat, toWat, verify } from '../ir/tape.js'
import { funcs } from '../optimize/fn.js'
import { fold } from '../optimize/fold.js'
import { vacuum } from '../optimize/vacuum.js'
import { mergeBlocks } from '../optimize/merge-blocks.js'
import { sortLocalsByUse } from '../optimize/sort-locals.js'

const DBG = typeof process !== 'undefined' && process.env?.JZ_DEBUG_INVARIANTS === '1'

export function lateLink(module, cfg) {
  if (cfg && cfg.fusedRewrite === false && cfg.sortLocalsByUse === false) return module   // level 0: nothing to run
  resetTape()
  const root = fromWat(module, true)   // watr's output is a private tree: consumed as it is read
  if (!cfg || cfg.fusedRewrite !== false) for (const f of funcs(root)) { fold(f); vacuum(f); mergeBlocks(f) }
  if (!cfg || cfg.sortLocalsByUse !== false) sortLocalsByUse(root)
  if (DBG) { const bad = verify(root); if (bad) throw new Error(`[link] module invalid after the late link: ${bad}`) }
  return toWat(root)
}
