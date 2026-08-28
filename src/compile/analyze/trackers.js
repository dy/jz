/**
 * Per-name monotone fact trackers shared by body-facts.js (analyzeBody) and
 * val-types.js (analyzeValTypes) — split out so neither owns the other's
 * copy. See analyze.js's module header for the pipeline-minimality split
 * this file is part of.
 *
 * @module compile/analyze/trackers
 */
import { ctx, setLinkDemand } from '../../ctx.js'
import { TYPED_CTOR_CONFLICT } from '../../typed-provenance.js'
import { typedStorageFactFromName } from '../../typed-context.js'
import { typedStaticLen } from '../../type.js'

export const makeValTracker = (get, set, del) => {
  let poison = null
  return (name, vt) => {
    if (poison?.has(name)) return
    if (!vt) { (poison ||= new Set()).add(name); del(name); return }
    const prev = get(name)
    if (prev && prev !== vt) { (poison ||= new Set()).add(name); del(name); return }
    set(name, vt)
  }
}
export const makeTypedTracker = (get, set, del, getLen, setLen, delLen) => {
  let poison = null
  const invalidate = (name) => { (poison ||= new Set()).add(name); del(name); if (delLen) delLen(name) }
  // Resolve a variable-name ternary branch to its known typed-array ctor: a
  // local typed binding (`get`), or a module global promoted typed by plan
  // (`inferModuleLetTypes` populates `globalTypedElem`, copied into
  // `ctx.func.typedElem` per-func). Lets `let cur = flip ? bufA : bufB` keep
  // the fast typed-load path instead of decaying to `$__typed_idx`.
  const resolveName = (n) =>
    get(n) ?? ctx.func.typedElem?.get(n) ?? ctx.scope.globalTypedElem?.get(n) ?? null
  return (name, rhs) => {
    if (poison?.has(name)) return
    const setOrInvalidate = (c) => {
      if (c === TYPED_CTOR_CONFLICT) return invalidate(name)
      // Module-level alias fact: a `.view` ctor (subarray / buffer-backed) is the ONLY
      // way two typed-array bindings can overlap. Recording that the program creates
      // ANY view lets memory-reordering passes (SLP) stay sound by bailing when set —
      // with no view, distinct typed bases own disjoint allocations.
      if (typeof c === 'string' && c.endsWith('.view')) setLinkDemand('typedView')
      const prev = get(name)
      if (prev && prev !== c) invalidate(name)
      else {
        set(name, c)
        // Static length rides the ctor's stability (fixed-length arrays): a redef
        // with an unknown or conflicting length drops the entry — typedStaticLen is
        // null for subarray/copy/ternary/computed rhs, so those invalidate for free.
        // Same live-closure style as get/set/del (call-time ctx deref, per the
        // makeValTracker comment above — a captured Map would orphan on the
        // per-function ctx.types reset).
        if (setLen) {
          // A name alias (`let x = a` — the inliner's param-alias splice) carries
          // the source's static length: typed arrays never resize, and typedLen
          // facts are single-def-stable by construction (validate strips written
          // params; the tracker invalidates redefs), so the copy is exact.
          const len = typedStaticLen(rhs) ?? (typeof rhs === 'string'
            ? getLen(rhs) ?? ctx.func.typedLen?.get(rhs) ?? ctx.scope?.globalTypedLen?.get(rhs) ?? null
            : null)
          const prevLen = getLen(name)
          if (len == null || (prevLen !== undefined && prevLen !== len)) delLen(name)
          else setLen(name, len)
        }
      }
    }
    // One expression-provenance authority covers direct constructors, aliases,
    // nested method chains, fresh species-preserving copies, and subarray views.
    // This is what keeps BigInt64Array map/slice/filter results typed after a
    // local assignment instead of decaying to a raw f64 element read.
    const ctor = typedStorageFactFromName(ctx, rhs, resolveName)
    if (ctor) return setOrInvalidate(ctor)
    if (typeof rhs === 'string') return
  }
}
