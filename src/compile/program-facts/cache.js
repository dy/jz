/**
 * program-facts split — fact-store cache lifecycle (the `gen`/`walkCache`/
 * `moduleInitSlot`/`bodyIntCertain` WeakMaps every other program-facts
 * module reads through `getFactStore().programFacts`). See
 * `../program-facts.js` for the full module map and build order.
 * @module program-facts/cache
 */
import { getFactStore } from '../../ctx.js'

/** Drop cached walks for specific AST roots (in-place module rewrites). */
export function invalidateProgramFactsCache(...roots) {
  getFactStore().revision++
  const pf = getFactStore().programFacts
  for (const r of roots) {
    if (r == null || typeof r !== 'object') continue
    pf.walkCache.delete(r)
    pf.moduleInitSlot.delete(r)
    pf.bodyIntCertain.delete(r)
  }
}
