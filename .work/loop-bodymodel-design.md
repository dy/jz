# Shared body-analysis BodyModel — design (Stage 3 remainder)

Status: DESIGN ONLY, not landed. Read-only survey + proposal for the
coordinator's mechanism review. Continues `.work/architecture-plan.md`
Stage 3 after the scaffold-sharing phase went TERMINAL
(`.work/todo.md:5224` "STAGE-3 SLICE 1", `archive-todo-2026-08.md:6198`
"LOOPPLAN UNIFICATION TERMINAL"): the dispatch descriptor `{bl, op,
blLoose}` (`matchBlockLoop`/`matchOuterPixelLoop`, src/optimize/
vectorize.js:1301/4801) is the single scaffold authority for 15/16
recognizers, and the 2026-07-31 attempt to also force a shared incremental
address-scan across the "incremental trio" (tryVectorize/tryReduceVectorize/
tryMemCopyFill) was correctly refused — a shared `scanAddresses` needed
8-10 knobs to save <20 lines, because the differing knobs ARE the differing
soundness conditions.

**This doc is the redesign the ledger named, not a retry of the refused
incremental path.** The difference: the refused design tried to share the
*scan* (one function walking the body once, mutating shared state as every
recognizer's private policy interleaves with it). This design shares the
*facts* (one precomputed, order-independent table per block, built before
any recognizer runs) and leaves every recognizer's admission policy exactly
as private as the terminal verdict already established. §3 works through why
that distinction resolves the "provisional acceptance" objection instead of
re-litigating it.

Two "loop-model" things exist in this codebase and must not be conflated:
`src/compile/loop-model.js` (138 lines, AST-level, shared by loop-divmod/
loop-square/peel-stencil/loop-recurrence — a *different* pass family, already
consolidated, cited by the task only as the naming precedent for "one home
for shared primitives") vs `src/optimize/vectorize.js` (6995 lines, WAT-level,
post-watr-tail, the 16-recognizer SIMD lifter this doc is about). The BodyModel
proposed here is new and lives beside `vectorize.js`'s existing shared layer
(`matchBlockLoop`, `matchOuterPixelLoop`, `deriveOffsetTees`, `matchLaneAddr`,
`bumpPixelIV`/`rampPixelIV`, `hasImpureCall`/`hasGlobalSet`/`hasSideEffect`).

## 1. Survey — inventory table

17 rows (16 dispatched recognizers + `tryStrengthReduceIV`, the deferred
scalar fallback that runs on every `bl` none of the 16 consumed). Commonality
class: **A** = byte-equivalent duplication across ≥2 recognizers, not yet
hoisted; **B** = same shape, parametrized differently, mergeable behind one
function; **C** = genuinely bespoke (single consumer or a distinct soundness
condition — per the terminal verdict, leave alone).

| Recognizer | Lines | Scaffold | Own body-scan derivations | Method | Class |
|---|---|---|---|---|---|
| tryVectorize | 1411-1798 | `bl` | float lane-width scan; `idxTees` (AoS pixel-index census); `addrLocals`/`offsetTees`/`aosPix`/`mirrorSites`; localKind (lane/invariant/addr); 3 CSE-undo rewrite passes | **incremental** (mutates addrLocals/offsetTees while walking loads/stores; post-scan `_offsetLocalStride` re-check) | A/C mix — discovery table is A, AoS/mirror/undo passes are C |
| tryStencil | 1827-2119 | raw node + `bl` | private `ivCoeff` (richer affine algebra: wrap-select, toroidal boundary), private `matchAddr`/`offTees`/`addrTees`, `derived`-IV fixpoint, `elemKey` in-place gate | incremental (matchAddr side-effects offTees while matching) | C (ledger-noted: richer than matchLaneAddr by design) |
| tryReduceVectorize | 2139-2534 | `bl` | NaN-canon min/max match (`matchIntMinMaxReduce`/`matchCanonBlock`/`matchCanonSelect`), matmul address refold, `addrLocals`/`offsetTees` built live in `scanExpr` (2345), localKind (2 classes, no 'lane'), NACC=4 multi-accumulator unroll | **incremental** (2nd of the trio; verified 2345-2395) | A/C mix |
| tryMapReduceVectorize | 2545-2632 | `bl`, consumes `bl.offsetTees` | `laneV`/`accSet` 2-class scheme (not the lane/invariant/addr triad); recursive `lift` | **post-hoc**, no private discovery — reference implementation for "consume the plan" | — (already unified) |
| tryStrengthReduceIV | 3615-3665 | `bl` (bound-shape-agnostic), deferred fallback | own `{base,k}` grouping via `matchAffineAddr` | post-hoc | B (address grouping shape is the affine-table query in miniature) |
| tryMemCopyFill | 3709-3806 | `bl` | 1/2-stmt shape gate; `laneAddr` wraps `matchLaneAddr`, **rejects viaLocal**, requires bare-i32 non-IV base; verified 3709-3800 | **incremental** (3rd of the trio) | A/C mix |
| tryByteScan | 3857-3923 | `bl` | exact-length gate; `matchByteCompare` → `matchAffineAddr` | post-hoc | C |
| tryRampMap | 4005-4284 | raw node, re-derives own `bl` via `multiInc`, consumes `bl.offsetTees` | multi-store/multi-channel detection; `recordAddrTees` (own full-address-tee scan); `byteValueRange` interval prover; localKind (2 classes) | mixed (recordAddrTees incremental, rest post-hoc) | C (multiInc scaffold + WIDEN16 range proof unique) |
| tryBlurMultiPixel | 4446-4634 | raw node + `blLoose` | own exit/inc re-validation; 4-init + inner-loop locate scan; `matchChannelGroup` | post-hoc | **A** (init/inner-loop-locate scan byte-duplicated with tryChannelReduce, see §1a) |
| tryChannelReduce | 4636-4718 | raw node + `blLoose` | same init/inner-loop locate scan as above | post-hoc | **A** |
| tryDivergentEscapeVectorize | 4860-5414 | raw node + `op` | break/continue classification, carried/temp census, `kindOf`, 3-way emit (fast/masked/multi-outcome) | post-hoc, no incremental mid-scan | C (fully bespoke, no analog) |
| tryPerPixelColor | 5453-5711 | raw node + `op` | `pxAlias` CSE detection; `liftPPC` (f64→f64x2 lift w/ rollback); `liftPPCInline` (2nd pure-call inliner); `epiWritten` epilogue-safety scan (5687-5692) | post-hoc with rollback | A (liftPPC/liftOS family, epiWritten scan) |
| tryOuterStrip | 5728-5915 | raw node + `op` | nested `matchBlockLoop`; `liftOS` (near-dup of liftPPC); accumulator pre-scan; `epiWritten` scan (5879-5884, **byte-identical** to tryPerPixelColor's) | post-hoc | A |
| tryIteratedReduce | 5937-6103 | raw node + `op` | multi-inner-loop + recurrence generalization; own `lift`/`liftInnerStmt`; `sawHeavy` cost gate; `epiWritten` scan (6080-6085, **byte-identical**) | post-hoc | A |
| tryConvColumn | 6121-6241 | raw node + `op` | `oxDep` dependence fixpoint; `matchByteLoad`/`liftProduct` (int8×int8 MAC); i16x8/i32x4 widening | post-hoc | C (only integer-domain outer-pixel recognizer) |
| tryToneMap | 6354-6631 | `bl` | shape-gate scan (exact store+load count, stride, convert-signature); localKind (mirrors tryVectorize); mixed i32x4/f64x2 lift | post-hoc | C (only mixed-width lift) |
| tryButterfly | 6654-6807 | raw node, **no matchBlockLoop at all** | 17-stmt structural unification (`bind`/`U` environment), dual-IV hand-matched | post-hoc via unification, not scan | C (ledger: "fully custom FFT scaffold", confirmed no shared helper used) |

Cross-cutting single/dual-consumer helpers already exist and stay private
per-consumer: `matchConstMulIV`(943), `matchMirrorAddr`(1006),
`matchIntMinMaxReduce`(104), `matchCanonBlock`(153), `matchCanonSelect`(70),
`matchChannelAccum`(3945)/`matchChannelGroup`(3966, shared by blur+channel-
reduce already), `matchByteCompare`(3815), `_isAddressLocal`(2637)/
`_isPixelIndexLocal`(2665, tryVectorize-only), `aosAddrPair`(2699)/
`aosGather`(2711, tryVectorize-only).

**Counts**: 17 recognizer rows surveyed. ~30 distinct derivation kinds
catalogued (address/offset resolution, localKind classification, guard/exit
matching, ivCoeff algebra, reduction-pattern matching, epilogue-safety,
lift-dispatch, dependence fixpoints). Of these, **4 are class-A byte-verified
duplicates already hoistable with zero design risk**: the `epiWritten`/`wr`
epilogue-safety closure (verified byte-identical at vectorize.js:5687-5692,
5879-5884, 6080-6085 — I diffed the three spans directly), the
`bump`/`rampOf` one-line closures redeclared at the top of all 5 outer-pixel
recognizers (5130, 5469+5488, 5747+5748, 5954+5955, 6225), the blur/channel-
reduce init+inner-loop-locate scan (4466-4480 vs 4648-4667), and the
lift-function family (liftPPC/liftOS/tryIteratedReduce's lift/
tryDivergentEscapeVectorize's liftCLane — near-identical dispatch, not
byte-verified verbatim but structurally identical per the survey). ~6 more
are class-B (same shape, parametrizable — the pixel-strip wrapper block, the
plain lane/invariant classification loop). The remainder (~20) are class-C:
single-consumer or a distinct soundness condition, matching the terminal
verdict's finding that the incremental trio "differ on EVERY axis."

## 2. BodyModel spec

One record, computed **once per candidate block** (the same `node` the
dispatcher already walks at vectorize.js:6898), BEFORE any recognizer runs —
sibling to `bl`/`op`/`blLoose`, not a replacement for them (those stay the
scaffold layer; BodyModel is the new body layer):

```
BodyModel(body, ind) = {
  // Superset of today's bodyFacts (1293) — writes/referenced/hasGlobalSet
  // unchanged, offsetTees generalized (see below).
  writes, referenced, hasGlobalSet, hasImpureCall,

  // Affine access table: EVERY scalar i32 local whose write shape is a
  // provably-consistent lane address, keyed by name. Generalizes
  // deriveOffsetTees (1110) + _isAddressLocal (2637) + _isPixelIndexLocal
  // (2665) into one discovery pass producing one table instead of three
  // recognizer-private ones.
  addrTable: Map<name, {
    kind: 'offset' | 'fullAddr' | 'idxTee' | 'mirror',
    strideLog2, pixelStride, base?,        // present for fullAddr/mirror
    invName?,                              // mirror only (matchMirrorAddr)
  }>,

  // Per load/store SITE (not just per-local): the resolved affine access,
  // computed by re-running matchLaneAddr/matchLaneOffset against addrTable
  // instead of a live mutable map. Keyed by node identity (WeakMap) so a
  // recognizer that rewrites the tree doesn't get stale entries.
  siteAccess: WeakMap<node, { base, strideLog2, pixelStride, elemWidth, teeName }>,

  // Alias classes: partition of every `base` expression appearing in
  // siteAccess into equivalence classes by STATIC identity (same local name,
  // same global name, or distinct-by-construction i.e. two different fn
  // params/typed-array locals with no assignment aliasing them in this
  // body — reuses the existing schema/rep channel, does not re-derive
  // pointer provenance). unknown-vs-unknown pairs are UNRESOLVED, not
  // "assumed distinct" — recognizers needing a stronger guarantee (memcpy's
  // overlap guard, stencil's in-place gate) keep their own runtime-guard or
  // fixpoint on top of this partition; the model supplies the base-identity
  // fact, not the soundness policy.
  aliasClass: Map<baseKey, classId>,

  // Dependence: NOT a general edge set in v1 — see §4. A single derived
  // boolean per (write-site, read-site) pair sharing an alias class:
  // provably-same-iteration (no loop-carry) vs cross-iteration (loop-carried,
  // the shape tryStencil's in-place gate and tryConvColumn's oxDep already
  // detect by hand). v1 exposes the alias partition; recognizers that need
  // the loop-carry boolean keep computing it (their fixpoints already work
  // and are class-C by the survey above — not worth forcing).
}
```

Construction is a **two-phase, whole-body, order-independent** walk (§3
explains why order-independence is safe): phase 1 gathers every candidate
`local.set`/`local.tee` name and its write shape (mirrors `deriveOffsetTees`'s
`gather`, 1113); phase 2 validates each candidate's body-wide consistency
(mirrors `_offsetLocalStride`, 1060, generalized to also accept the
`fullAddr`/`idxTee`/`mirror` shapes `_isAddressLocal`/`_isPixelIndexLocal`/
`matchMirrorAddr` already recognize independently today). Both phases are
pure functions of `(body, ind)` — no recognizer-specific admission policy
enters BodyModel construction. `siteAccess` is populated by one more
body-wide pass calling `matchLaneAddr`/`matchLaneOffset` against the frozen
`addrTable` (read-only lookup, not the live-mutation `addrLocals`/
`offsetTees` maps every incremental recognizer builds today).

## 3. The provisional-acceptance question — resolved, not deferred

The three "incremental trio" call sites, verified directly:
- **tryVectorize**: `scanForLoadsStores` (~1496-1580) mutates `addrLocals`/
  `offsetTees`/`aosPix` while walking; a **post-scan loop already re-verifies
  every `offsetTees` entry via `_offsetLocalStride`** before commit (this is
  documented at 1104-1108's `deriveOffsetTees` comment as load-bearing).
- **tryReduceVectorize**: `scanExpr` (2345-2372, read directly) calls
  `matchLaneAddr(node[1], incVar, addrLocals, offsetTees)` inside the walk,
  populating the same two maps as it goes; **also followed by a post-scan
  `_offsetLocalStride` re-check** (2372-2375).
- **tryMemCopyFill**: the `laneAddr` closure (3722-3729, read directly) wraps
  `matchLaneAddr` over shared `addrLocals`/`offsetTees`, called twice
  (source then dest); **also followed by the identical post-scan
  `_offsetLocalStride` re-check** (3757-3760).

All three already run the SAME two-step shape: optimistic accept during a
single top-down walk (needed because `matchLaneAddr`'s `viaLocal` case reads
`addrLocals.has(name)` — resolving a `(local.get $T)` reference requires the
defining `(local.tee $T …)` to have already been recorded), followed by a
body-wide soundness re-check via the SAME `_offsetLocalStride` function
`deriveOffsetTees` already uses as a clean pre-pass for `tryMapReduceVectorize`/
`tryRampMap`. The "provisional acceptance is load-bearing" comment (1105) is
about *within-function sequencing*, not a fundamental order dependency: a
`local.tee $T` always lexically precedes every `(local.get $T)` reference to
it in structured control flow (a tee's scope is the rest of the block; a use
in a sibling `if`/`else` arm never sees a tee from the other arm), so
collecting every tee-definition FIRST in one order-independent body walk and
resolving every reference against that completed table SECOND is strictly
equivalent to interleaving discovery with the primary load/store scan — it
just moves the "have I seen the defining tee yet" question from "walk order"
to "is it in the completed table," which is always yes for well-formed
structured code and the failure mode (an undefined name) can't arise from a
valid wasm tee/get pairing.

**Resolution: two-phase, not mid-scan-refinement.** BodyModel's phase 1+2
(§2) IS the provisional-accept-then-verify pattern already proven safe by
`deriveOffsetTees`, generalized from the offset-only shape to the full
`addrTable` (fullAddr/idxTee/mirror included) that only `tryVectorize` needs
today. What moves out of each recognizer is the *mechanical* bookkeeping
(walk-and-mutate-then-reverify); what stays in each recognizer is the
*admission policy* — `tryMemCopyFill` still rejects `viaLocal` and requires a
bare-i32 non-IV base, `tryReduceVectorize` still forbids stores and
intermediate `local.set`/`local.tee` inside the reduction expression,
`tryVectorize` still needs its own AoS/mirror acceptance — all three become
a filter predicate applied to a `siteAccess` LOOKUP instead of a mutation
during a live scan. This is exactly the split the terminal verdict already
validated for the offset-only case (`bl.offsetTees` consumed post-hoc by
`tryMapReduceVectorize`/`tryRampMap` while the same information is
independently, incrementally re-derived by the trio) — §5 sequences landing
each recognizer onto the query form as its own gated slice specifically
because "moves out" is a claim that needs byte-identity proof per recognizer,
not a blanket one.

## 4. Alias / dependence — scoped down, not full closure

The architecture plan's Stage-3 text names "dependence sets (from solver
aliasing)" as part of the vision. Surveyed evidence: only 3 of 17 recognizers
touch dependence at all, and each already has a working, recognizer-specific
mechanism (`tryMemCopyFill`'s runtime overlap guard 3789-3798, `tryStencil`'s
`elemKey` in-place/loop-carry gate, `tryConvColumn`'s `oxDep` fixpoint) — none
of these are duplicated, so there is no hoist candidate here, only a shared
FOUNDATION candidate. `aliasClass` (§2) supplies exactly the static fact all
three already compute ad hoc as a first step (are these two `base` exprs the
same local/global, or provably-distinct-by-construction) — the recognizer
keeps owning the *policy* built on top (runtime guard vs static gate vs
fixpoint), consistent with §3's split and the terminal verdict's principle.
A general dependence-EDGE graph (arbitrary read/write pairs, arbitrary
distance vectors) is explicitly NOT in v1: no recognizer needs it, and
building it speculatively would be exactly the "steamroll the justified-
private analysis" the task warned against.

## 5. Slice plan (landing-agent sized, byte-identity-gated)

Every slice: zero WAT diffs on the bench corpus (the established discipline —
`deriveOffsetTees`'s slice 6 measured 177/180 compiles × O0/O2/O3, 0 diffs, 3
skips identical pre/post) plus the full battery/parity/kernel-leg/ratchet
gates already standard for this codebase. Order goes low-risk/high-confidence
first (things already proven post-hoc-safe) to high-risk last (the trio).

1. **BodyModel construction, unwired.** Add the module, phase-1/phase-2
   discovery generalizing `deriveOffsetTees`/`_isAddressLocal`/
   `_isPixelIndexLocal`/`matchMirrorAddr` into one `addrTable`. No recognizer
   consumes it yet. Gate: a debug-only shadow assertion comparing
   `addrTable`'s offset-only entries against `deriveOffsetTees`'s existing
   output on the full bench corpus — must be identical (this is the
   "generalization is safe" proof, cheap because it reuses the existing
   gate infrastructure and touches zero recognizer code).
   **LANDED 2026-08-07** (task's "Slice 1", combined with item 2 below —
   see .work/todo.md's BODYMODEL SLICE 1 entry for the full gate record).
2. **`siteAccess` + `aliasClass`, unwired.** Build the per-site resolved
   table and the base-identity partition over the same corpus; shadow-assert
   `siteAccess` results against `matchLaneAddr`'s current post-hoc callers
   (`tryMapReduceVectorize`, `tryRampMap`'s non-`recordAddrTees` paths) —
   these already consume a precomputed table, so this slice proves the new
   table produces the same answers before anything risky touches it.
   **LANDED 2026-08-07** — one real finding en route: `siteAccess`'s query
   must read `node[1]` raw (no `offset=N` memarg unwrap), since neither
   intended consumer ever unwraps one; an initial draft copied tryVectorize's
   memarg-aware `memAddr` helper, which would have been a silently WIDER
   acceptance than either consumer has ever had (exactly the §6 risk below) —
   caught and fixed during construction, before any assert ran against it.
3. **Wire the class-A duplicates (zero soundness risk, pure dedup):**
   `epiWritten`/`wr` epilogue-safety closure → one `epilogueIsSafe(epilogue,
   {loopNode, laneMap, pivType})` consumed by tryPerPixelColor/tryOuterStrip/
   tryIteratedReduce (byte-verified identical, lowest-risk slice in the
   plan); `bump`/`rampOf` redeclaration → already-hoisted `bumpPixelIV`/
   `rampPixelIV` referenced directly instead of re-wrapped (mechanical); the
   blur/channel-reduce init+inner-loop-locate scan → one
   `matchChannelReducePixelLoop(loopNode, bodyStart, bodyEnd)` consumed by
   both.
   **LANDED 2026-08-07** (task's "Slice 2"). One correction found while
   hoisting the blur/channel-reduce scan: the two private copies were NOT
   byte-identical text — tryChannelReduce's zero-init z-push carried an extra
   `typeof s[1] === 'string'` guard tryBlurMultiPixel's copy lacked. Confirmed
   dead (a `local.set`'s name slot is always a string in this IR) rather than
   a behavior difference, so the shared function keeps the guard (matches the
   codebase's prevailing name-narrowing convention) and byte-identity across
   the bench corpus empirically confirms the two were equivalent in practice.
4. **Wire `tryMapReduceVectorize`/`tryRampMap`/`tryStrengthReduceIV` onto
   `addrTable`+`siteAccess`** in place of `bl.offsetTees`/`matchAffineAddr`'s
   private grouping — these are today's cleanest post-hoc consumers, so this
   slice validates the query interface end-to-end on real recognizers before
   the trio.
   **LANDED 2026-08-07 for tryMapReduceVectorize/tryRampMap** (task's
   "Slice 3"). `tryStrengthReduceIV` deliberately NOT wired — see .work/
   todo.md's BODYMODEL SLICE 3 entry for why: `matchAffineAddr` never
   consulted `offsetTees`/`addrLocals` in the first place (its matchLaneAddr
   call passes both as `undefined`, `allowTee: false` — pure structural
   pattern match), so there is no shared table for it to move onto; forcing
   one would be scope creep with no duplication to remove.
5. **`tryMemCopyFill` onto `siteAccess`** (smallest of the trio: 2 static
   `laneAddr` calls, no walk). Its admission policy (reject viaLocal, require
   bare-i32 base) becomes a filter over `siteAccess` lookups. Own slice —
   the terminal verdict's "differ on every axis" means each trio member gets
   its own byte-identity gate, not a combined one.
6. **`tryReduceVectorize` onto `siteAccess`.** Its `scanExpr` shrinks to
   value-shape validation (no-store, no-intermediate-set) over addresses
   resolved via lookup instead of live mutation.
7. **`tryVectorize` onto `siteAccess` + `addrTable`'s `idxTee`/`mirror`
   entries.** Largest, highest-risk slice — do last, after 4-6 have proven
   the query interface on every simpler consumer. `_isAddressLocal`/
   `_isPixelIndexLocal`/`aosAddrPair`/`aosGather` stay tryVectorize-private
   (they consume the model, they don't need to move).
8. **(Optional, only if 3-7 land clean and there's appetite) the class-B
   pixel-strip wrapper emitter** (`buildPixelStripLoop`, §1a) and the
   liftPPC/liftOS/lift family consolidation — these touch the EMIT side, not
   analysis, so they're a natural follow-on but out of this doc's scope
   (BodyModel is an analysis-layer design; the lift-function family is a
   separate, smaller "shared emit helper" slice that doesn't need BodyModel
   first).

Slices 1-2 touch zero recognizer code (pure addition + shadow-assert) and
can land independently of everything else. Slices 3-4 are low-risk dedup/
already-post-hoc consumers. Slices 5-7 are where the terminal verdict's
warning applies most directly — each is its OWN gated unit, sized for one
landing agent, and a slice that fails byte-identity stays parked (recorded,
not forced) exactly as the ledger already does for stalled items.

## 6. Risk register

- **Byte-identity is absolute, not a target.** Any slice producing a single
  WAT byte diff on the bench corpus is a regression, full stop — these
  recognizers are the SPEED goal's engine (audits #9-#12). Every slice above
  is scoped so it can be reverted independently without touching the others.
- **`addrTable` generalization silently widening acceptance.** Generalizing
  `_offsetLocalStride` to also validate `fullAddr`/`idxTee`/`mirror` shapes
  risks accepting a body shape none of today's incremental scans would (a
  false positive in the shared table that a recognizer's own filter forgets
  to reject). Mitigation: slice 1's shadow-assert against the CURRENT
  incremental output on the full corpus before any recognizer consumes the
  new table — a widening shows up as a shadow-assert mismatch, not a WAT
  diff, and is fixed before it can reach emission.
- **Order-independence assumption (§3) breaking on a control-flow shape not
  in the current corpus.** The tee-precedes-use argument holds for
  structured wasm control flow as watr emits it; if a future recognizer
  needs an unstructured or multiply-defined tee shape, phase-1/phase-2 must
  reject it (return no candidate) rather than resolve it inconsistently —
  `_offsetLocalStride`'s existing `ok = false` divergence-tracking already
  does this and generalizes directly.
- **Recognizer admission-policy drift.** Moving from "build my own map" to
  "filter a shared lookup" is a refactor per recognizer; a copy-paste of the
  OLD policy predicate onto the NEW lookup is required, not a rewrite — the
  slice plan keeps each recognizer's filter logic textually close to its
  current form specifically to keep this mechanical and reviewable.
- **Scope creep back into the refused incremental-scan design.** If a slice
  turns out to need the shared table to also PERFORM recognizer-specific
  rejection (not just supply facts), that is the terminal verdict's refused
  shape re-appearing — the right response is to leave that recognizer on its
  private scan (class C), not to add another knob to BodyModel.
- **`aliasClass` scope discipline (§4).** The temptation to grow it into a
  general dependence graph "since we're in there" must be resisted absent a
  second recognizer that would actually consume the edges — YAGNI applies
  directly; the three existing dependence mechanisms are working and
  class-C.

## 7. Non-goals (explicitly out of scope, per the terminal verdict)

- Forcing `tryVectorize`/`tryReduceVectorize`/`tryMemCopyFill` to share one
  scan function. They share FACTS (BodyModel), not control flow.
- A general dependence-edge graph (§4).
- Touching `tryStencil`'s private `ivCoeff`/`matchAddr` (richer than
  `matchLaneAddr` by design), `tryButterfly`'s custom unification matcher,
  `tryDivergentEscapeVectorize`'s 3-way emit classification, or
  `tryConvColumn`'s integer-domain MAC — all class-C, single-consumer or a
  genuinely distinct soundness condition.
- Any change to the scaffold layer (`matchBlockLoop`/`matchOuterPixelLoop`) —
  that phase is TERMINAL and this doc does not reopen it.
