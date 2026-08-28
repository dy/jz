/**
 * program-facts split — fact-store cache lifecycle (the `gen`/`walkCache`/
 * `moduleInitSlot`/`bodyIntCertain` WeakMaps every other program-facts
 * module reads through `getFactStore().programFacts`). See
 * `../program-facts.js` for the full module map and build order.
 * @module program-facts/cache
 */
import { getFactStore } from '../../ctx.js'

/** Drop all cached program-fact walks (called at compile entry — normally
 *  implicit via beginSession's fresh factStore; exposed for any caller that
 *  needs to force a mid-session drop). Natively the gen bump alone is enough
 *  (stale entries just go unreachable on a real GC heap). In the self-compile
 *  kernel these WeakMaps' own backing storage is itself an arena allocation
 *  that `_clear` rewinds between compiles in a warm-instance loop — a
 *  post-`_clear` alloc can overwrite the WeakMap's internal bytes, so we also
 *  swap in fresh WeakMap instances (cheap: O(1), no traversal). */
export function resetProgramFactsCache() {
  const pf = getFactStore().programFacts
  pf.gen++
  pf.walkCache = new WeakMap()
  pf.moduleInitSlot = new WeakMap()
  pf.bodyIntCertain = new WeakMap()
}

/** Drop cached walks for specific AST roots (in-place module rewrites). */
export function invalidateProgramFactsCache(...roots) {
  const pf = getFactStore().programFacts
  for (const r of roots) {
    if (r == null || typeof r !== 'object') continue
    pf.walkCache.delete(r)
    pf.moduleInitSlot.delete(r)
    pf.bodyIntCertain.delete(r)
  }
}
