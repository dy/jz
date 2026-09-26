/**
 * Per-name monotone fact trackers shared by body-facts.js (analyzeBody) and
 * val-types.js (analyzeValTypes) — split out so neither owns the other's
 * copy. See analyze.js's module header for the pipeline-minimality split
 * this file is part of.
 *
 * @module compile/analyze/trackers
 */
import { isReassigned, walkAst, MUTATE_OPS } from '../../ast.js'
import { ctx, setLinkDemand } from '../../ctx.js'
import { isGlobal } from '../../ir/vars.js'
import { TYPED_CTOR_CONFLICT } from '../../typed-provenance.js'
import { typedStorageFactFromName } from '../../typed-context.js'
import { typedStaticLen } from '../../type.js'

export const makeTypedTracker = (get, set, del, getLen, setLen, delLen, body) => {
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
        // captured binding lifecycle — a captured Map would orphan on the
        // per-function ctx.types reset).
        // A module global's length is a program-wide fact (ctx.scope.globalTypedLen,
        // dropped when any function rewrites the binding): a write here proves
        // nothing for a read before it, nor for another function's reads.
        // The cached reassignment census includes closure writes, which the
        // local tracker does not visit.
        if (setLen && (isGlobal(name) || isReassigned(body, name))) delLen(name)
        else if (setLen) {
          // A name alias (`let x = a` — the inliner's param-alias splice) carries
          // the source's static length: typed arrays never resize, and typedLen
          // facts are single-def-stable by construction (validate strips written
          // params; the tracker invalidates redefs), so the copy is exact.
          // A call to a typed factory carries the length its signature
          // published (narrow/results.js).
          const callLen = Array.isArray(rhs) && rhs[0] === '()' && typeof rhs[1] === 'string'
            ? ctx.funcs.map?.get(rhs[1])?.sig?.typedLen ?? null : null
          const len = typedStaticLen(rhs) ?? callLen ?? (typeof rhs === 'string'
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

/** A local typed binding assigned only arrays of one length keeps that length:
 *  typed arrays never resize, so every value it holds is that long — the
 *  ping-pong `const t = a; a = b; b = t` of two equal buffers. Solved
 *  optimistically over the assignment cycle. Only a binding this body declares
 *  with a value qualifies; any other write, a closure's write, or a value of
 *  another or unknown length drops the name. */
export function joinReassignedTypedLens(body, typed, lenOf, setLen) {
  const defs = new Map(), declared = new Set(), bad = new Set()
  const params = new Set((ctx.func.current?.params || []).map(p => p.name))
  walkAst(body, { enter: (n, parent) => {
    if (n[0] === '=>') { walkAst(n, { enter: m => { if (MUTATE_OPS.has(m[0]) && typeof m[1] === 'string') bad.add(m[1]) } }); return false }
    if (n[0] === 'let' || n[0] === 'const')
      for (let i = 1; i < n.length; i++) if (typeof n[i] === 'string') bad.add(n[i])   // declared without a value
    const decl = parent?.[0] === 'let' || parent?.[0] === 'const'
    if (n[0] === '=' && typeof n[1] === 'string') {
      if (typed(n[1])) (defs.get(n[1]) ?? defs.set(n[1], []).get(n[1])).push(n[2])
      if (decl) declared.add(n[1])
    } else if (MUTATE_OPS.has(n[0]) && typeof n[1] === 'string' && !decl) bad.add(n[1])
  } })
  const names = [...defs.keys()].filter(n => declared.has(n) && !bad.has(n) && !params.has(n) && !isGlobal(n) && lenOf(n) == null)
  if (!names.length) return
  const TOP = -1, len = new Map(names.map(n => [n, TOP]))
  const rhsLen = (rhs) => typedStaticLen(rhs) ?? (typeof rhs === 'string' ? (len.has(rhs) ? len.get(rhs) : lenOf(rhs)) : null)
  for (let changed = true; changed;) {
    changed = false
    for (const n of names) {
      if (len.get(n) === null) continue
      let v = TOP
      for (const rhs of defs.get(n)) {
        const l = rhsLen(rhs)
        if (l === TOP) continue
        if (l == null || (v !== TOP && v !== l)) { v = null; break }
        v = l
      }
      if (v !== len.get(n)) { len.set(n, v); changed = true }
    }
  }
  for (const [n, v] of len) if (v != null && v !== TOP) setLen(n, v)
}
