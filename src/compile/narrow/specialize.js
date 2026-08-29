/**
 * Call-site specialization / cloning via materializeVariant: per-typed-ctor
 * clones at sticky-bimorphic positions (specializeBimorphicTyped), one clone
 * pinned at landslide-majority (>=90%) VAL-kind positions (specializeValKindDichotomy),
 * raw i32 packed-cell union-cursor clones (collectUnionSites/specializeUnionCursorParams),
 * and tag-guarded speculative clones behind a runtime dispatch (speculateTypedParams).
 *
 * @module compile/narrow/specialize
 */

import { ctx, DBG_INVARIANTS } from '../../ctx.js'
import {
  returnExprs, ASSIGN_OPS, extractParams, classifyParam, PARAM_KIND, PARAM_NAME, some,
} from '../../ast.js'
import { analyzeBody } from '../analyze.js'
import { typedElemCtor } from '../../type.js'
import { typedElemAux, ctorFromElemAux } from '../../../layout.js'
import { VAL } from '../../reps.js'
import { paramFactsOf, joinKinds } from '../../param-reps.js'
import { inferValType, inferTypedCtor } from '../infer.js'
import { materializeVariant } from '../variant.js'
import { assertValKindConsistent, buildCallerTypedCtx, buildCallerCtx } from './caller-ctx.js'

/**
 * Phase: bimorphic typed-array param specialization.
 *
 * For each non-exported user function with a typed-array param that F/G-phase
 * left bimorphic (paramReps[name][k].typedCtor === null because two or more call sites
 * disagreed on the elem-ctor — e.g. `sum(f64)` and `sum(i32)`), clone the
 * function once per concrete ctor seen at the call sites, narrow each clone's
 * sig.params[k] to a monomorphic typed pointer ABI (type='i32', ptrKind=TYPED,
 * ptrAux=ctor's aux), and rewrite the call AST nodes to dispatch to the right
 * clone. The original survives as a fallback for any non-static call sites
 * (e.g. inside arrow bodies); treeshake removes it if every site got rewritten.
 *
 * Why this matters: without specialization, `arr[i]` inside `sum` falls into
 * the runtime `__typed_idx` path on every iteration — V8 can't inline a wasm
 * call dominated by a switch on elem type. After specialization, each clone's
 * `arr[i]` lowers to a direct `f64.load` (or `i32.load + f64.convert`) with
 * the elem-ctor known at compile time. On poly bench this is the difference
 * between ~5 ms and matching AS at ~1 ms.
 *
 * Safety mirrors G-phase: skip exported, raw, value-used, defaulted, rest, or
 * already-i32 params. Bounded by MAX_CLONES_PER_FN to guard against polymorphic
 * blow-up (≥5 distinct ctors at one site → no specialization).
 */
export function specializeBimorphicTyped(programFacts) {
  const { callSites, valueUsed, paramReps } = programFacts
  const MAX_CLONES_PER_FN = 4

  // Per-callee static-call-site index. Built once; cheap.
  const sitesByCallee = new Map()
  for (const cs of callSites) {
    const list = sitesByCallee.get(cs.callee)
    if (list) list.push(cs); else sitesByCallee.set(cs.callee, [cs])
  }

  // Per-caller typedElem map: body-local `new TypedArray(N)` bindings layered
  // over the module's typed globals (shared with buildCallerTypedCtx).
  const callerTypedCtx = buildCallerTypedCtx()
  // Per-caller typed-param map: caller's own params that F/G already narrowed
  // (so transitive `sum(arr)` inside a func that took `arr` from above resolves).
  const callerTypedParamsCtx = new Map()
  for (const func of ctx.funcs.list) {
    const m = paramFactsOf(paramReps, func, 'typedCtor') || null
    let acc = m
    if (func.sig?.params) for (const p of func.sig.params) {
      if (p.ptrKind === VAL.TYPED && p.ptrAux != null) {
        acc ||= new Map()
        if (!acc.has(p.name)) acc.set(p.name, ctorFromElemAux(p.ptrAux))
      }
    }
    if (acc) callerTypedParamsCtx.set(func, acc)
  }

  // Snapshot ctx.funcs.list — we'll be appending clones during the loop.
  const originals = ctx.funcs.list.slice()
  for (const func of originals) {
    if (func.exported || func.raw || valueUsed.has(func.name)) continue
    if (!func.body) continue
    if (func.rest) continue
    const reps = paramReps.get(func.name)
    if (!reps) continue
    const sites = sitesByCallee.get(func.name)
    if (!sites || sites.length < 2) continue

    // Find sticky-bimorphic typed-param positions left by F-phase.
    const bimorphic = []
    for (let k = 0; k < func.sig.params.length; k++) {
      const r = reps.get(k)
      if (!r || r.val !== VAL.TYPED || r.typedCtor !== null) continue
      const p = func.sig.params[k]
      if (p.type === 'i32') continue
      if (func.defaults?.[p.name] != null) continue
      bimorphic.push(k)
    }
    if (bimorphic.length === 0) continue

    // For each site, infer the ctor combination across bimorphic positions.
    // Abort if any site has unknown ctor at any bimorphic position — we can't
    // route that call to a specific clone without it.
    const siteCombos = []
    let abort = false
    for (const site of sites) {
      const callerTypedElems = callerTypedCtx.get(site.callerFunc)
      const callerTypedParams = callerTypedParamsCtx.get(site.callerFunc)
      const combo = []
      for (const k of bimorphic) {
        if (k >= site.argList.length) { abort = true; break }
        const c = inferTypedCtor(site.argList[k], { callerElems: callerTypedElems, paramFacts: callerTypedParams })
        if (c == null || typedElemAux(c) == null) { abort = true; break }
        combo.push(c)
      }
      if (abort) break
      siteCombos.push(combo)
    }
    if (abort) continue

    // Distinct combos seen across call sites.
    const distinct = new Map()
    for (const combo of siteCombos) {
      const key = combo.join('|')
      if (!distinct.has(key)) distinct.set(key, combo)
    }
    if (distinct.size < 2) continue          // F-phase already mono — nothing to do
    if (distinct.size > MAX_CLONES_PER_FN) continue  // polymorphic blow-up

    // Build one clone per distinct combo, retargeting only the sites whose
    // own combo matches it.
    for (const [dkey, cmb] of distinct) {
      // NB: this loop variable must NOT reuse the name `combo` (declared twice above, at the
      // site loop and the distinct-building loop). The self-host miscompiles a for-of loop
      // variable whose name collides with an earlier block-scoped declaration — it aliases the
      // prior binding instead of rebinding per iteration, so `combo` would stay stuck at the
      // last site's ctor and every clone would get the same (wrong) element type → silent
      // garbage. A unique name gets a clean per-iteration binding.
      const suffix = cmb.map(c => c.replace(/^new\./, '').replace(/\./g, '_')).join('$')

      // Build cloneSig with clean, fully-formed object literals — never by spreading a
      // live object and then overriding/extending its keys. A MULTI-prop spread of a
      // member-access source (`{ ...func.sig, params, results }`) takes the static
      // allKnown OBJECT-merge path, which trusts func.sig's COMPILE-TIME schema; sig
      // objects are polymorphic (some carry result/ptrKind/unsignedResult), so that
      // schema can be a subset of the runtime shape and the slot-copy then faults a
      // later `sig.params` read out of bounds in the self-host. (The single-unknown
      // `{ ...x }` clone is fixed at the root — __obj_clone — but the allKnown merge
      // path is a separate hazard.) Constructing each param with its pointer ABI baked
      // in sidesteps it; output is unchanged on the host.
      const cloneSig = {
        params: func.sig.params.map((p, idx) => {
          const bi = bimorphic.indexOf(idx)
          return bi < 0
            ? { ...p }
            : { name: p.name, type: 'i32', ptrKind: VAL.TYPED, ptrAux: typedElemAux(cmb[bi]) }
        }),
        results: [...func.sig.results],
      }

      // Mirror per-param reps under the clone's name with mono ctors at bimorphic
      // positions. emitFunc's preseed reads typedCtor → seeds typedElem map →
      // `arr[i]` lowers to direct typed load. cloneRep is a true clone, so
      // pinning typedCtor on it leaves the source rep untouched (__obj_clone).
      materializeVariant({
        origin: func, name: `${func.name}$${suffix}`, sig: cloneSig, paramReps,
        factOverrides: bimorphic.map((k, i) => ({
          k, patch: r => { r.typedCtor = cmb[i]; r.val = VAL.TYPED; joinKinds(r, 'possibleKinds', [VAL.TYPED]) },
        })),
        eligibleSites: sites.filter((_, i) => siteCombos[i].join('|') === dkey),
        fallback: func,
      })
    }
  }

  if (DBG_INVARIANTS) assertValKindConsistent(paramReps)
}

/**
 * Phase: VAL-kind landslide specialization — the general-kind sibling of
 * specializeBimorphicTyped (`.work/context-sensitivity-survey.md` §3-4,
 * COORDINATOR RULING). specializeBimorphicTyped only fires on
 * the `typedCtor` sub-lattice (`r.val === VAL.TYPED && r.typedCtor ===
 * null`); this fires on the general `val` field itself, for the params the
 * survey's ground-truth census found genuinely, cross-call-site polymorphic
 * — 13/1711 multi-site `val` rows program-wide, and EVERY one of them a
 * landslide majority/minority split (932/934, never a balanced polymorphic
 * spread, §1a).
 *
 * `r.val === null` on a settled paramReps entry is ALREADY exactly "≥2
 * call sites disagreed on the kind" (param-reps.js's meet: BOTTOM stays
 * `undefined` while every site is merely unclassifiable — `mergeParamFact`
 * is never even called for those — and only flips to TOP/`null` on a real
 * kind-vs-kind conflict). So the trigger is a single field read; the work
 * is re-deriving each site's kind from its own `argList[k]` (mirroring
 * specializeBimorphicTyped's `inferTypedCtor` re-derivation, step 3) via
 * `inferValType` — the same call-site inferrer narrow.js's own D-phase
 * `mergeRule('val', ...)` runs, over the identical per-caller `valTypes`
 * context `buildCallerCtx()` already builds for that fixpoint.
 *
 * Unlike the typed case, a VAL-kind pin is NOT an ABI change — `val` is
 * read as a dispatch HINT everywhere in emit.js (method-call static
 * dispatch, REF_EQ_KINDS bitwise-eq fold, spread-copy strategy, jsstring/
 * pointer-ABI decisions all separately gate on their OWN ptrKind/type
 * fields, never on `val` alone) — so pinning it on a clone used ONLY by
 * the call sites PROVEN to carry that kind is sound without touching
 * `func.sig.params[k].type`/`ptrKind` at all. That decouples this pass
 * from specializeBimorphicTyped's "abort unless EVERY site resolves"
 * discipline: a genuine landslide majority (≥90% of RESOLVED sites, the
 * DOMINANCE threshold below) gets ONE clone; the minority AND any still-
 * unresolved sites simply keep calling the untouched, fully generic
 * original — no partial-coverage risk, because the original never
 * changes.
 */
export function specializeValKindDichotomy(programFacts) {
  const { callSites, valueUsed, paramReps } = programFacts
  // Landslide threshold — a pass-registry tuning key (src/passes.js
  // TUNING_KEYS), not a hidden local constant: a visible/overridable knob
  // like every other tuning key (e.g. scalarTypedArrayLen).
  const DOMINANCE = ctx.transform.optimize?.valKindDominance ?? 0.9

  const sitesByCallee = new Map()
  for (const cs of callSites) {
    const list = sitesByCallee.get(cs.callee)
    if (list) list.push(cs); else sitesByCallee.set(cs.callee, [cs])
  }

  // Per-caller val-type context (D-phase's own `inferValType(arg, callerValTypes)`
  // inputs) — module-scope, built once, same shape narrowSignatures' D-phase uses.
  const callerCtx = buildCallerCtx()

  const originals = ctx.funcs.list.slice()
  for (const func of originals) {
    if (func.exported || func.raw || valueUsed.has(func.name)) continue
    if (!func.body) continue
    if (func.rest) continue
    const reps = paramReps.get(func.name)
    if (!reps) continue
    const sites = sitesByCallee.get(func.name)
    if (!sites || sites.length < 2) continue

    // Find every landslide-dichotomy position on this function FIRST, then build
    // ONE combined clone pinning all of them together — never one clone per
    // position (which would fight over the same `sites` array's `node[1]`,
    // each position's rewrite silently discarding an earlier position's).
    // Mirrors specializeBimorphicTyped's own step 4 (one clone per distinct
    // COMBO across all bimorphic positions, not per position).
    const pins = []            // { k, domKind }
    const perPosKinds = []     // parallel to pins: siteKinds vector for that position
    for (let k = 0; k < func.sig.params.length; k++) {
      const r = reps.get(k)
      if (!r || r.val !== null) continue           // only genuinely poisoned (kind-vs-kind disagreement)
      const p = func.sig.params[k]
      if (p.type !== 'f64' || p.ptrKind != null) continue  // already narrowed away from generic boxed — nothing to add
      if (func.defaults?.[p.name] != null) continue

      // Re-derive each site's kind fresh from argList[k] — same inference the
      // fixpoint itself used, just re-run per site instead of joined.
      const counts = new Map()
      const siteKinds = new Array(sites.length).fill(null)
      let resolved = 0
      for (let si = 0; si < sites.length; si++) {
        const site = sites[si]
        if (k >= site.argList.length) continue
        const kind = inferValType(site.argList[k], callerCtx.get(site.callerFunc)?.callerValTypes)
        if (kind == null) continue
        siteKinds[si] = kind
        resolved++
        counts.set(kind, (counts.get(kind) || 0) + 1)
      }
      if (resolved === 0 || counts.size !== 2) continue   // need exactly 2 distinct resolved kinds

      let domKind = null, domCount = -1
      for (const [kind, c] of counts) if (c > domCount) { domCount = c; domKind = kind }
      if (domCount / resolved < DOMINANCE) continue        // not a landslide — no clear majority to exploit
      // specializeBimorphicTyped's own domain — pinning TYPED needs the matching
      // ptrKind/type ABI switch (applyPointerParamAbi/bimorphic's job), which this
      // pass deliberately never touches; leave TYPED dichotomies to that pass.
      if (domKind === VAL.TYPED) continue

      pins.push({ k, domKind })
      perPosKinds.push(siteKinds)
    }
    if (!pins.length) continue

    // ONE clone, pinned at every qualifying position to its dominant kind. A
    // site routes to the clone only if it matches EVERY pinned position's
    // dominant kind; any site that misses on even one (minority OR
    // unresolved) keeps calling the untouched, fully generic original.
    // No `sig` override: this pass never changes the ABI, only paramReps —
    // materializeVariant's default (a fresh copy of origin.sig) is exactly
    // the clone this used to build by hand.
    const eligibleSites = sites.filter((_, si) => pins.every((pn, pi) => perPosKinds[pi][si] === pn.domKind))
    const clone = materializeVariant({
      origin: func, name: `${func.name}$${pins.map(pn => pn.domKind).join('$')}`, paramReps,
      factOverrides: pins.map(({ k, domKind }) => ({
        k, patch: r => { r.val = domKind; joinKinds(r, 'possibleKinds', [domKind]) },
      })),
      eligibleSites, fallback: func,
    })
    if (typeof process !== 'undefined' && process.env?.JZ_DBG_VALKIND)
      console.error('[valkind-clone]', func.name, '->', clone.name, JSON.stringify(pins.map(pn => pn.domKind)))
  }

  if (DBG_INVARIANTS) assertValKindConsistent(paramReps)
}

/** Module-scope ITERATIVE call-site walk for specializeUnionCursorParams —
 *  capture-free worklist, never recursive (a nested self-recursive closure
 *  mutating captured state is the exact shape the self-hosted kernel's
 *  closure ABI miscompiles — the dictWalk* lesson). */
function collectUnionSites(body, callerFunc, candidateNames, sitesByCallee) {
  const stack = [body]
  while (stack.length) {
    const n = stack.pop()
    if (!Array.isArray(n)) continue
    if (n[0] === '()' && typeof n[1] === 'string' && candidateNames.has(n[1])) {
      const argList = n[2] == null ? [] : (Array.isArray(n[2]) && n[2][0] === ',') ? n[2].slice(1) : [n[2]]
      // Shape-identical to program-facts' callSites entries — shares their
      // schema instead of minting a new one. (Episode 3's hard "schema-identity
      // contract" is retired: prepare's binding census now bars cross-function
      // name collisions from the vars channel, so a differently-shaped literal
      // is no longer a correctness hazard — matching the shape is just schema-
      // table hygiene.)
      const site = { callee: n[1], argList, callerFunc, node: n }
      const list = sitesByCallee.get(n[1])
      if (list) list.push(site); else sitesByCallee.set(n[1], [site])
    }
    for (let i = 1; i < n.length; i++) stack.push(n[i])
  }
}

/** Carrier-specialized union-cursor clones (audit decision 2): a function
 *  whose params are VERIFIED union cursors (analyzeUnionInline's grammar walk
 *  + registry) gets a `$union` sibling whose cursor params are RAW I32
 *  packed-cell addresses (type 'i32', ptrKind OBJECT — PTR.OBJECT never
 *  forwards, so the address is call-stable). The clone body rides the
 *  EXISTING local-cursor emit path (readVar's rep.ptrKind +
 *  inlineUnionCursors branch → packed i32 loads, ZERO unbox); every
 *  sanctioned callsite (`measure(rows[i])`) rewrites to the clone and passes
 *  the raw address — no NaN-box crosses the call. The f64 original keeps the
 *  generic body for any caller specialization can't see.
 *  Runs AFTER analyzeUnionInline (registry + verified cursors settled),
 *  BEFORE emitFuncs. Sites are collected FRESH over the current AST
 *  (programFacts.callSites is stale at this phase — plan's loop rewrites
 *  clone body nodes). KERNEL-SAFE STYLE throughout: plain loops (no nested
 *  predicate arrows), manual Map copies — INVARIANT: this function is
 *  compiled INTO the self-host kernel, so a non-kernel-safe form breaks the
 *  kernel by mere presence, regardless of whether it's ever called.
 */
export function specializeUnionCursorParams(programFacts) {
  const clones = []
  const cursorsBySig = ctx.schema.inlineUnionCursors
  if (!cursorsBySig?.size) return clones
  const { valueUsed, paramReps } = programFacts
  const candidateNames = new Set()
  for (const func of ctx.funcs.list)
    if (!func.raw && func.sig && cursorsBySig.get(func.sig)?.size) candidateNames.add(func.name)
  const sitesByCallee = new Map()
  for (const func of ctx.funcs.list) if (!func.raw && func.body)
    collectUnionSites(func.body, func, candidateNames, sitesByCallee)
  const originals = ctx.funcs.list.slice()
  for (const func of originals) {
    if (func.exported || func.raw || func.rest || !func.body || valueUsed.has(func.name)) continue
    const cursors = cursorsBySig.get(func.sig)
    if (!cursors?.size) continue
    const idxs = []
    for (let k = 0; k < func.sig.params.length; k++) {
      const p = func.sig.params[k]
      if (p.type !== 'i32' && p.ptrKind == null && cursors.has(p.name) && func.defaults?.[p.name] == null)
        idxs.push(k)
    }
    if (!idxs.length) continue
    const sites = sitesByCallee.get(func.name)
    if (!sites?.length) continue
    // Every static site must pass an element of a REGISTERED union array of
    // the CALLING function whose key matches the callee's cursor registration
    // — explicit carrier PROVENANCE, not shape-matching. Fail closed.
    let ok = true
    for (let si = 0; si < sites.length && ok; si++) {
      for (let ii = 0; ii < idxs.length && ok; ii++) {
        const k = idxs[ii]
        const a = sites[si].argList[k]
        if (!(Array.isArray(a) && a[0] === '[]' && typeof a[1] === 'string' &&
          ctx.schema.inlineUnionArrays?.get(sites[si].callerFunc?.sig)?.get(a[1]) === cursors.get(func.sig.params[k].name)))
          ok = false
      }
    }
    if (!ok) continue
    // Same contract: match specializeBimorphicTyped's param-literal shape
    // ({ name, type, ptrKind, ptrAux } — ptrAux null behaves as absent).
    const cloneSig = {
      params: func.sig.params.map((p, k) =>
        idxs.includes(k) ? { name: p.name, type: 'i32', ptrKind: VAL.OBJECT, ptrAux: null } : { ...p }),
      results: [...func.sig.results],
    }
    const clone = materializeVariant({
      origin: func, name: `${func.name}$union`, sig: cloneSig,
      paramReps, eligibleSites: sites, fallback: func,
    })
    clones.push(clone)

    const cloneCursors = new Map()
    for (const [cn, ck] of cursors) cloneCursors.set(cn, ck)
    cursorsBySig.set(clone.sig, cloneCursors)
  }
  return clones
}

/**
 * Speculative typed-param specialization — the GUARDED sibling of
 * specializeBimorphicTyped, for params whose args can never be statically
 * PROVEN typed: plan objects through Map caches, nullable module-let memos,
 * returned-object fields — the fftplan/provenance shape-class, where the
 * receiver's schema is unknowable but every value that ever reaches the call
 * is, in practice, the same typed array.
 *
 * When every static call site's arg at a position carries the SAME ctor as
 * evidence — a proven inferTypedCtor, or the program-wide write-gated slot
 * census for a bare field read (ctx.schema.slotTypedCtorByProp, the
 * guardedSlotOf contract) — clone the callee with those params typed
 * (identical machinery to the bimorphic clones) and record it in
 * ctx.types.specFns. Emit rewrites every static direct call into
 *
 *   tags-all-match? call $f$spec(raw offsets…) : call $f(boxes…)
 *
 * (emitSpeculativeCall) — one masked NaN-box compare per speculated arg per
 * CALL, amortized over the callee's loops. A nullish / other-kind / view
 * value simply falls to the original call unchanged, so speculation can only
 * ever be as fast, never wrong; the original function stays for indirect and
 * boundary callers. Gate on a loop in the body: the win is per-ELEMENT
 * access, so guarding loop-free leaf calls only spends the compare.
 *
 * Evidence is a recursive WEAK lattice (soundness never depends on it — the
 * runtime guard does; evidence only decides where speculating is worth it):
 *   - proven inferTypedCtor at the site (strong)
 *   - `x.prop` → program-wide write-gated slot census (slotTypedCtorByProp)
 *   - a name → its single `=` binding's init, chased recursively
 *   - a name that is an ENCLOSING ARROW's param → meet over the arrow's own
 *     call sites at that position (the `edge(wre, wim)` harness shape: the
 *     kernel call sits inside a local arrow whose args carry the evidence)
 *   - `f(...)` → f's return census: every return a `new K`, a local bound to
 *     one, a censused field read, or another censused call; nullish returns
 *     are SKIPPED (they fail the guard at runtime, by design — this is what
 *     lets Map-cache/memo getters like getPlan(n) census through)
 */
export function speculateTypedParams(programFacts, ast) {
  const { callSites, paramReps } = programFacts
  if (!ctx.schema.slotTypedCtorByProp) return

  const sitesByCallee = new Map()
  for (const cs of callSites) {
    const list = sitesByCallee.get(cs.callee)
    if (list) list.push(cs); else sitesByCallee.set(cs.callee, [cs])
  }
  const callerTypedCtx = buildCallerTypedCtx()
  const callerTypedParamsCtx = new Map()
  for (const func of ctx.funcs.list) {
    const m = paramFactsOf(paramReps, func, 'typedCtor') || null
    let acc = m
    if (func.sig?.params) for (const p of func.sig.params) {
      if (p.ptrKind === VAL.TYPED && p.ptrAux != null) {
        acc ||= new Map()
        if (!acc.has(p.name)) acc.set(p.name, ctorFromElemAux(p.ptrAux))
      }
    }
    if (acc) callerTypedParamsCtx.set(func, acc)
  }

  const hasLoop = (n) => Array.isArray(n)
    && (n[0] === 'for' || n[0] === 'while' || n[0] === 'do' || n.some((c, i) => i > 0 && hasLoop(c)))

  // ---- weak evidence engine (see doc above) ----
  const DBG2 = typeof process !== 'undefined' && !!process.env?.JZ_DBG_SPEC
  const isNullish = (r) => r == null || r === 'null' || r === 'undefined'
    || (Array.isArray(r) && (r[0] === 'null' || r[0] === 'undefined'))
  const retMemo = new Map()
  const MAX_DEPTH = 6
  const bodyOf = (callerFunc) => callerFunc ? callerFunc.body : ast

  // Return census of a named function: the single ctor every non-nullish
  // return resolves to, or null.
  function retCensus(fname, depth) {
    if (retMemo.has(fname)) return retMemo.get(fname)
    retMemo.set(fname, null)                       // cycle guard
    const func = ctx.funcs.map.get(fname)
    if (!func?.body || func.raw || depth > MAX_DEPTH) return null
    const te = analyzeBody(func.body).typedElems
    let ctor = null
    for (const r of returnExprs(func.body)) {
      if (isNullish(r)) continue
      const c = typedElemCtor(r)
        || (typeof r === 'string' ? te?.get(r) : null)
        || (Array.isArray(r) && r[0] === '.' && typeof r[2] === 'string' ? ctx.schema.slotTypedCtorByProp(r[2]) : null)
        || (Array.isArray(r) && r[0] === '()' && typeof r[1] === 'string' ? retCensus(r[1], depth + 1) : null)
      if (!c || (ctor && c !== ctor)) return null
      ctor = c
    }
    retMemo.set(fname, ctor)
    return ctor
  }

  // Chain of arrow nodes enclosing `target` inside `root` (outermost first).
  function arrowPathTo(root, target) {
    const path = []
    const walk = (n) => {
      if (!Array.isArray(n)) return false
      if (n === target) return true
      const isArrow = n[0] === '=>'
      if (isArrow) path.push(n)
      for (let i = 1; i < n.length; i++) if (walk(n[i])) return true
      if (isArrow) path.pop()
      return false
    }
    return walk(root) ? path : null
  }

  function evidenceOfArg(arg, callerFunc, siteNode, depth, seen) {
    const r = evidenceOfArgInner(arg, callerFunc, siteNode, depth, seen)
    if (DBG2) console.error('[evid=]', JSON.stringify(arg)?.slice(0, 50), '→', r)
    return r
  }
  function evidenceOfArgInner(arg, callerFunc, siteNode, depth, seen) {
    if (arg == null || depth > MAX_DEPTH) return null
    const proven = inferTypedCtor(arg, { callerElems: callerTypedCtx.get(callerFunc), paramFacts: callerTypedParamsCtx.get(callerFunc) })
    if (proven) return proven
    if (Array.isArray(arg)) {
      if (arg[0] === '.' && typeof arg[2] === 'string') return ctx.schema.slotTypedCtorByProp(arg[2])
      if (arg[0] === '()' && typeof arg[1] === 'string' && ctx.funcs.map.has(arg[1])) return retCensus(arg[1], depth)
      return typedElemCtor(arg)
    }
    if (typeof arg !== 'string') return null
    // Cycle guard is PATH-local: the key backtracks on exit (a name legitimately
    // recurs across sibling meet branches — e.g. duplicated call sites after
    // lambda inlining — and must resolve fresh in each).
    const key = (callerFunc?.name || '') + '|' + arg
    if (seen.has(key)) return null
    seen.add(key)
    try {
      return resolveName()
    } finally { seen.delete(key) }

    function resolveName() {
    const body = bodyOf(callerFunc)
    if (!body) return null
    // Enclosing-arrow param? Meet the arrow's own call sites at that position.
    const arrows = siteNode ? arrowPathTo(body, siteNode) : null
    if (arrows) for (let a = arrows.length - 1; a >= 0; a--) {
      const names = extractParams(arrows[a][1]).map(p => classifyParam(p)).filter(c => c[PARAM_KIND] === 'plain').map(c => c[PARAM_NAME])
      const j = names.indexOf(arg)
      if (j < 0) continue
      // The binding name of this arrow (`const edge = (…) => …`), then its calls.
      let bindName = null
      const findBind = (n) => {
        if (!Array.isArray(n)) return
        if (n[0] === '=' && typeof n[1] === 'string' && n[2] === arrows[a]) bindName = n[1]
        for (let i = 1; i < n.length && !bindName; i++) findBind(n[i])
      }
      findBind(body)
      if (!bindName) return null
      const calls = []
      const findCalls = (n) => {
        if (!Array.isArray(n)) return
        if (n[0] === '()' && n[1] === bindName) calls.push(n)
        for (let i = 1; i < n.length; i++) findCalls(n[i])
      }
      findCalls(body)
      if (!calls.length) return null
      let ctor = null
      for (const cn of calls) {
        const list = cn[2] == null ? [] : (Array.isArray(cn[2]) && cn[2][0] === ',') ? cn[2].slice(1) : [cn[2]]
        const c = evidenceOfArg(list[j], callerFunc, cn, depth + 1, seen)
        if (!c || (ctor && c !== ctor)) return null
        ctor = c
      }
      return ctor
    }
    // Single-`=` local binding: chase its init. More than one write → too
    // murky to be worth the guard.
    let decl = null, writes = 0
    const findDecl = (n) => {
      if (!Array.isArray(n)) return
      if (typeof n[1] === 'string' && n[1] === arg) {
        if (n[0] === '=') { decl = n; writes++ }
        else if (ASSIGN_OPS.has(n[0]) || n[0] === '++' || n[0] === '--') writes++
      }
      for (let i = 1; i < n.length; i++) findDecl(n[i])
    }
    findDecl(body)
    if (!decl || writes !== 1) return null
    return evidenceOfArg(decl[2], callerFunc, decl, depth + 1, seen)
    }
  }

  const DBG = typeof process !== 'undefined' && !!process.env?.JZ_DBG_SPEC
  const originals = ctx.funcs.list.slice()
  for (const func of originals) {
    if (func.raw || func.rest || !func.body) continue
    if (func.sig?.results?.length !== 1) continue
    const sites = sitesByCallee.get(func.name)
    if (!sites?.length) { if (DBG) console.error('[spec]', func.name, 'no sites'); continue }
    if (!hasLoop(func.body)) continue

    // Candidate positions: still a dyn f64 box after F-phase/bimorphic (no
    // pointer ABI, not numeric-narrowed), no default (undefined must reach it).
    const reps = paramReps.get(func.name)
    const candidates = []
    for (let k = 0; k < func.sig.params.length; k++) {
      const p = func.sig.params[k]
      if (p.type !== 'f64' || p.ptrKind != null) continue
      if (func.defaults?.[p.name] != null) continue
      const r = reps?.get(k)
      if (r && (r.val != null && r.val !== VAL.TYPED)) continue
      candidates.push(k)
    }
    if (!candidates.length) continue

    // Evidence meet across sites per position. A site WITHOUT evidence is
    // NEUTRAL — its calls just miss the guard at runtime and take the
    // original (a plain-array or debug caller must not veto the hot sites'
    // win). Only CONFLICTING evidence (two different ctors) kills the
    // position — a guard can only test one kind.
    const specs = []
    for (const k of candidates) {
      let ctor = null, dead = false
      for (const site of sites) {
        const arg = site.argList[k]
        if (arg == null) continue
        const proven = inferTypedCtor(arg, { callerElems: callerTypedCtx.get(site.callerFunc), paramFacts: callerTypedParamsCtx.get(site.callerFunc) })
        const c = proven ?? evidenceOfArg(arg, site.callerFunc, site.node, 0, new Set())
        if (DBG) console.error('[spec]', func.name, 'k=' + k, JSON.stringify(arg)?.slice(0, 60), 'proven=' + proven, 'c=' + c)
        if (c == null) continue
        if (ctor && c !== ctor) { dead = true; break }
        ctor = c
      }
      if (dead || !ctor) continue
      const aux = typedElemAux(ctor)
      if (aux == null) continue
      specs.push({ k, ctor, aux })
    }
    if (!specs.length) continue

    const specAt = new Map(specs.map(s => [s.k, s]))
    const cloneSig = {
      params: func.sig.params.map((p, idx) => {
        const s = specAt.get(idx)
        return s ? { name: p.name, type: 'i32', ptrKind: VAL.TYPED, ptrAux: s.aux } : { ...p }
      }),
      results: [...func.sig.results],
    }
    // No eligibleSites: unlike the other four paths, dispatch here is a
    // runtime-guarded call inserted at EMIT time (emitSpeculativeCall, off
    // ctx.types.specFns) — a genuinely unique step this analysis keeps as
    // its own policy rather than a static call-edge retarget.
    const clone = materializeVariant({
      origin: func, name: `${func.name}$spec`, sig: cloneSig, paramReps,
      factOverrides: specs.map(s => ({
        k: s.k,
        patch: r => { r.typedCtor = s.ctor; r.val = VAL.TYPED; joinKinds(r, 'possibleKinds', [VAL.TYPED]) },
      })),
      eligibleSites: [], fallback: func,
    })

    ;(ctx.types.specFns ||= new Map()).set(func.name, { clone: clone.name, guards: specs.map(s => ({ k: s.k, aux: s.aux })) })
  }

  if (DBG_INVARIANTS) assertValKindConsistent(paramReps)
}

