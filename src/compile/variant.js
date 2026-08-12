/**
 * The single function-variant MATERIALIZER (architecture re-audit item 10).
 *
 * Five analyses each decide, independently, that some func should get a
 * specialized sibling for a subset of its call sites — fixed-rest arity
 * (plan/inline.js specializeFixedRestCalls), bimorphic typed-elem splits
 * (narrow.js specializeBimorphicTyped), VAL-kind landslide dichotomy
 * (specializeValKindDichotomy), union-cursor carrier clones
 * (specializeUnionCursorParams), and guarded speculative typed clones
 * (speculateTypedParams). Each analysis stays its own PRODUCER — it alone
 * knows WHETHER to specialize, WHAT the clone's sig/facts must say, and
 * WHICH call sites qualify. What was duplicated five times, byte-for-byte,
 * is pure MECHANISM: mint a collision-free name, build the clone object,
 * register it into ctx.func.{list,map,names}, copy+patch its paramReps
 * entry, and retarget the qualifying call edges. That mechanism now lives
 * here, once.
 *
 * ATOMICITY (the audit's specific ask): a call edge is TWO things pointing
 * at the same callee — the AST node's `node[1]` (what actually gets
 * compiled) and the call-site record's own `.callee` field (what every
 * `.callee`-filtering consumer downstream believes it calls — narrow.js's
 * own `cs.callee === fname` scans, dyn-closure-tables.js's
 * `proveClosureFactory`). Every one of the five paths retargeted only
 * `node[1]`, leaving `.callee` pointing at the pre-specialization name —
 * conceptually stale from the instant the clone exists. `retarget` below
 * always flips both in the same stroke; there is no code path through this
 * module that can produce one without the other.
 *
 * @module compile/variant
 */
import { ctx } from '../ctx.js'
import { cloneRep } from '../param-reps.js'

/**
 * @param {object} opts.origin        Source func — already vetted by the
 *   caller's own eligibility rules (not raw/rest/value-used, etc; whatever
 *   that analysis requires).
 * @param {string} [opts.key]         Identity for IDEMPOTENT reuse: if a func
 *   is already registered under this exact name, it IS this variant — return
 *   it as-is instead of re-cloning (the fixed-rest shape, where several
 *   call-site groups can converge on the same `${name}#rest${N}` clone).
 *   Omit `key` for the "name is a hint, disambiguate on collision" shape the
 *   other four paths use (each clones at most once per qualifying func/combo,
 *   so reuse is never expected — a same-name hit is a coincidental collision
 *   with an unrelated function, not the same variant).
 * @param {string} opts.name          Desired clone name, already carrying the
 *   path's own naming convention (ctor-combo suffix, dom-kind suffix,
 *   `$union`, `$spec`, `#restN`).
 * @param {object} [opts.sig]         Full replacement `{params, results}`.
 *   Omitted → a fresh shallow copy of `origin.sig` (the VAL-kind dichotomy
 *   shape: the clone's ABI is unchanged, only its paramReps facts are pinned).
 * @param {*} [opts.body]             Replacement body. Omitted → `origin.body`
 *   (only fixed-rest's rest-destructuring rewrite needs this).
 * @param {object} [opts.cloneFields] Extra top-level clone overrides beyond
 *   name/sig/body/exported=false (only fixed-rest needs `{ rest: null }`).
 * @param {Map} [opts.paramReps]      `programFacts.paramReps` — when given,
 *   the clone gets a deep-cloned (`cloneRep`) copy of `origin`'s reps map,
 *   patched by `factOverrides`, registered under the clone's name.
 * @param {Array<{k: number, patch: (rep: object) => void}>} [opts.factOverrides]
 *   Per-position paramReps patches applied to the cloned reps map (each
 *   `patch` mutates the rep in place — callers own the VAL/typedCtor/
 *   joinKinds semantics; this module has no opinion on rep field shape).
 * @param {Array<{node: Array, callee: string}>} [opts.eligibleSites]
 *   Call-site records to retarget atomically. Empty/omitted for a path whose
 *   dispatch is resolved elsewhere (speculateTypedParams: EMIT-time guarded
 *   dispatch off `ctx.types.specFns`, not a static retarget here).
 * @param {object} opts.fallback      The func ineligible/unresolved calls
 *   keep reaching — MUST be `origin` (asserted). Every path's soundness rests
 *   on an unretargeted site still calling a fully correct, untouched original;
 *   this makes that invariant a checked precondition instead of an assumption.
 * @returns {object} the materialized (or reused) clone func.
 */
export function materializeVariant({
  origin, key, name, sig, body, cloneFields, paramReps, factOverrides, eligibleSites, fallback,
}) {
  if (fallback !== origin)
    throw new Error(`materializeVariant: fallback must be origin (${origin?.name} vs ${fallback?.name})`)

  let cloneName = name
  let clone = key != null ? ctx.funcs.map.get(cloneName) : null
  if (!clone) {
    if (key == null) while (ctx.funcs.names.has(cloneName)) cloneName += '$'
    clone = {
      ...origin,
      name: cloneName,
      exported: false,
      sig: sig || { params: origin.sig.params.map(p => ({ ...p })), results: [...origin.sig.results] },
      body: body !== undefined ? body : origin.body,
      ...cloneFields,
    }
    ctx.funcs.list.push(clone)
    ctx.funcs.map.set(cloneName, clone)
    ctx.funcs.names.add(cloneName)

    if (paramReps) {
      const reps = paramReps.get(origin.name)
      const overrides = factOverrides || []
      // Match each path's own original semantics: bimorphic/valkind always
      // had `reps` present (gated before ever reaching here); speculate
      // sets paramReps EVEN with no origin reps (the override IS the point —
      // the clone's pinned positions must land regardless); union-cursor
      // skipped the set entirely when origin had no reps AND had nothing to
      // override. One rule reconciles all three: write iff there's a source
      // reps map to copy, or an override that needs somewhere to land.
      if (reps || overrides.length) {
        const cloneReps = new Map()
        if (reps) for (const [k, r] of reps) cloneReps.set(k, cloneRep(r))
        for (const { k, patch } of overrides) {
          if (!cloneReps.has(k)) cloneReps.set(k, {})
          patch(cloneReps.get(k))
        }
        paramReps.set(cloneName, cloneReps)
      }
    }
  }

  for (const site of eligibleSites || []) {
    site.node[1] = cloneName
    site.callee = cloneName
  }

  return clone
}
