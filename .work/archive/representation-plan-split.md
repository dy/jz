# representation-plan.js split (pipeline-minimality slice)

Base 0feb9e29. `src/compile/representation-plan.js` is 2,565 lines, sole
representation authority per ADR-0001 (`.work/adr-0001-bigint-representation.md`).
Grown through the Shape #5-#9 campaign (`.work/archive/phase-c-unification.md`).
Outliers: `buildBodyData` (1251-2056, 806 lines), `solveBigintProvenance`
(303-934, 632 lines).

## Phase map (by line range, current file)

| phase | lines | entry point(s) | job |
|---|---|---|---|
| primitives | 1-297 | (none exported except BIGINT_REP_*/BIGINT_DEMAND_*/REP_EDGE_*) | packed-fact algebra: semantic bit-packing (kinds/closed/nullish/observed), rep bit-packing (raw/boxed/closed), edge-kind enum, isExported, BIGINT_TYPED_CTORS/STORAGE_*_METHODS sets, isBigintOrigin, collectLocalClosures/collectDispatchTableClosures/paramForwardsToReturn (closure-shape AST utilities) |
| provenance fixpoint | 303-934 | `solveBigintProvenance` | whole-program existential BigInt-origin proof: per-param/result/storage/global provenance sets via a scan+exprMay/exprRep fixpoint (Shape #6-#9: storage read propagation fwd+bwd, dispatch-table closures, `.`-member call resolution via call-target-index, paramBigintOnly/paramNeverBool refinement passes for the BOOL-veto) |
| local provenance | 936-977 | `deriveLocalProvenance` | per-closure (generic/uncovered) scoped provenance, built from the program provenance's `exprMay` + a local storage scan |
| boundary solving | 979-1189 | `makeBoundaryData`, `solveRepresentationBoundaries` (exported), `ensureBoundary`, `directCallBoundary`, `publishBoundary` | per-function param/result semantic+current+target+demand records ("the boundary"), published once per identity into `ctx.plans.representations`/`representationData`; host-param edges computed for exported funcs |
| shared op/def vocabulary | 1191-1249 | `memberReceiver`/`callMember`, `NUMERIC_VALUE_OPS`/`NON_BIGINT_OPS`/`JOIN_OPS`(exported)/`CONDITIONAL_ASSIGN_OPS`/`joinArms`, `collectDefs` | AST shape predicates and op-classification sets shared by provenance and body-data phases |
| body data / materialization | 1251-2056 | `buildBodyData` | per-body fixpoint: semantic fixpoint (semanticOf) -> current-carrier fixpoint (currentOf) -> target+edge walk (plannedOf/walkEdges) -> materialization decision (materializedNames/materializedJoins/materializedResult/hostBoxParams/closureBoxParams) -> compaction into primitive-valued nodeFacts/packedSemantics maps |
| mint | 2059-2105 | `mintRepresentationPlan` (exported) | orchestrates: derive local provenance (closures) -> ensureBoundary -> buildBodyData -> publish `record.body` |
| debug invariant | 2542-2565 | `assertRepresentationPlan` | edge-action soundness check, gated by `DBG_INVARIANTS` |
| query / materialize (emission-time) | 2107-2536 minus call-arg trio | `representationPlanOf`/`BoundaryOf`, `representationParamRep`/`ResultRep`/`BindingRep`, `representationActionCount`/`BoundaryActionCount`, `activeBody`/`activeRep` (private), `representationActiveMaterializedRep`, `representationStorageWriteAction`, `representationHostBoxesParam`, `representationJoinArmAction`, `representationComputedExprAction`, `representationReturnAction`, `representationBindingWriteAction`, `representationCompoundAssignAction`, `representationUnaryUpdateAction`, `activeEmittedRep`/`activeStorageSourceRep`, `representationResultRawBigint`, `representationResultTagRequired`, `representationProgramHasBigint`/`RejectCount` | the frozen-plan read API every emit.js/ir.js/emit-assign.js/bridge.js call site consults for one edge's action or one node/name's materialized carrier |
| call-arg actions | 2248, 2368-2387, 2526-2535 | `representationClosureArgAction`, `representationCallArgAction`, `recordClosureCallRepresentations` | the action/provenance for one argument at a call site (direct call, closure/call_indirect, and pre-plan closure-call recording) |

Two concerns are cross-cutting, not separate phases: **closure forwarding**
(paramNeedsHostTag's closure-forwarding case + collectLocalClosures in
provenance; closureCallNeedsBox/closureBoxParams/closureAbiIdentity/
resultForwardsProvenCallee in body-data; the closure-registration branch in
mintRepresentationPlan) and **index-resolved `.`-member callees**
(`resolveMemberCallee`, defined and returned by solveBigintProvenance,
consumed by buildBodyData's `calleeNameOf` and by
`representationActiveMaterializedRep`'s `()` branch at emission time). Per
`.work/archive/member-callee-binding-write-notes.md` (a sibling branch,
fix/member-callee-binding-write, not merged into this base): kind.js's
`valTypeOf` now resolves `.`-member callees itself through the same frozen
call-target index, so two of the four per-site widenings that branch added
were already reverted to their baseline (`valTypeOf(node) === VAL.BIGINT`)
form before that branch's tip — confirmed: this file's `edgeMaterializable`
(line 1732) already reads the plain baseline form, nothing redundant remains
here to delete. The other two widenings that branch's own notes say are
correctly KEPT (`calleeNameOf`/`directCallBoundary`, `representationActiveMaterializedRep`'s
`()` branch) are exactly the ones this map already lists under "index-resolved
`.`-member callees" above — they carry plan-internal facts (carrier choice,
boundary records) valTypeOf's kind-only vocabulary cannot express, so they are
not redundant and are not touched.

## Exported surface (grep-verified consumers)

38 exported names. External consumers:
- `src/bridge.js`: REP_EDGE_BOX, REP_EDGE_REJECT, representationStorageWriteAction
- `src/ir.js`: BIGINT_REP_BOXED, BIGINT_REP_CLOSED, REP_EDGE_BOX, REP_EDGE_UNBOX, representationActiveMaterializedRep
- `src/compile/index.js`: mintRepresentationPlan, representationHostBoxesParam, representationProgramHasBigint, representationResultRawBigint, representationResultTagRequired, representationReturnAction
- `src/compile/emit.js`: JOIN_OPS, REP_EDGE_BOX, REP_EDGE_REJECT, REP_EDGE_UNBOX, recordClosureCallRepresentations, representationBindingWriteAction, representationCallArgAction, representationJoinArmAction, representationResultTagRequired, representationReturnAction, representationComputedExprAction, representationCompoundAssignAction, representationUnaryUpdateAction, representationStorageWriteAction, representationProgramHasBigint
- `src/compile/emit-assign.js`: REP_EDGE_BOX, representationProgramHasBigint, representationStorageWriteAction
- `src/compile/plan/index.js`: solveRepresentationBoundaries
- `src/wat/assemble.js`: mintRepresentationPlan, representationProgramHasBigint
- `test/session-reentrancy.js`: representationActionCount, representationBindingRep, representationBoundaryActionCount (+ others already listed)

The barrel (`src/compile/representation-plan.js`) re-exports all 38 names
unchanged so none of these import lines move.

## Module split plan (pure moves, step 2)

`src/compile/representation-plan/`, layered DAG (no cycles):
`common.js` <- `{boundaries.js, provenance.js, materialize.js}` <-
`{body-data.js (also <- boundaries.js, provenance.js), call-args.js (also <- materialize.js)}`
<- barrel.

| new file | contents | ~lines |
|---|---|---|
| `common.js` | BIGINT_REP_*/BIGINT_DEMAND_*/REP_EDGE_* consts (exported); the packed-fact algebra (KIND_BITS, ALL_KIND_BITS, BIGINT_KIND_BIT, SEM_*_BIT, packSemantic+semantic{Kinds,Closed,Nullish,Observed}, EDGE_KIND/EDGE_KIND_NAME, packRep+bigintRep{Bits,IsClosed}, NO/RAW/BOXED/ANY_BIGINT, bitOfKind, semBottom/semAll/semKind, sameSem, joinSem, canBeBigint/canBeOther/onlyBigintKind/definiteBigint/excludesBigint, joinRep, semanticFromRep, targetRepFor — kept as one unit: mutually-referential one-liners defining a single shared vocabulary, not splittable by usage count without fragmenting the notation); isExported; noBigintSemantic; programPlanRecord; BIGINT_TYPED_CTORS/BIGINT_READ_METHODS/VALUE_COERCERS/STORAGE_READ_METHODS/STORAGE_WRITE_METHODS; isBigintOrigin; collectLocalClosures (genuinely 2-file: provenance.js + body-data.js); memberReceiver/callMember (genuinely 2-file); NUMERIC_VALUE_OPS (genuinely 2-file); JOIN_OPS (exported, 2-file + external emit.js); CONDITIONAL_ASSIGN_OPS (2-file, inside collectDefs + body-data.js); DEF_RHS/DEF_OWNER + collectDefs (genuinely 2-file: deriveLocalProvenance + buildBodyData); edgeAction (4-file, the most cross-cutting function in the plan) | ~300 |
| `boundaries.js` | boundaryParamSemantic, currentParamRep, resultSemantic, currentResultRep, makeNoBigintBoundary, demandFor (usage-count says boundaries-only, kept beside makeBoundaryData rather than common), makeBoundaryData, publishBoundary, solveRepresentationBoundaries (exported), ensureBoundary | ~260 |
| `provenance.js` | solveBigintProvenance, deriveLocalProvenance, plus hoisted-to-top-level (were solveBigintProvenance-local closures with zero or trivially-explicit dependency on its fixpoint state): paramNeedsHostTag (byte-identical, already took every dependency as an explicit param), isStorageReadArgShape (byte-identical, already zero closure state), collectDispatchTableClosures (usage-count: provenance-only), seedBigintTyped (mechanical: `bigintTyped` becomes an explicit 2nd param instead of closed-over), paramEntryExcludesBool (mechanical: `programFacts` becomes an explicit 1st param) | ~700 |
| `body-data.js` | buildBodyData, mintRepresentationPlan (exported), assertRepresentationPlan (debug invariant, sole caller is mintRepresentationPlan); hoisted: edgeMaterializable (byte-identical, already zero closure state — pure function of its 4 explicit params), hasClosedBool (NEW: the repeated `semanticClosed(x) && (semanticKinds(x) & bitOfKind(VAL.BOOL)) !== 0` guard, byte-identical in every occurrence, appears 7x — see step 3); directCallBoundary (usage-count: body-data-only despite the boundary-flavored name — every call site is inside buildBodyData); paramForwardsToReturn, NON_BIGINT_OPS, joinArms, sameSem, joinSem (usage-count: body-data-only) | ~900 |
| `materialize.js` | representationPlanOf/BoundaryOf, representationParamRep/ResultRep/BindingRep, representationActionCount/BoundaryActionCount, activeBody (private), activeRep/activeEmittedRep/activeStorageSourceRep (exported cross-module for call-args.js), representationActiveMaterializedRep, representationStorageWriteAction, representationHostBoxesParam, representationJoinArmAction, representationComputedExprAction, representationReturnAction, representationBindingWriteAction, representationCompoundAssignAction, representationUnaryUpdateAction, representationResultRawBigint, representationResultTagRequired, representationProgramHasBigint/RejectCount | ~420 |
| `call-args.js` | representationClosureArgAction, representationCallArgAction, recordClosureCallRepresentations | ~55 |
| `representation-plan.js` (barrel) | re-export only, all 38 original names, zero logic | ~45 |

Per-file imports trimmed to what's actually called at each new location
(verified by grep per symbol before committing, not copied wholesale) —
mechanically drops nothing extra here since, unlike analyze.js's split, this
file imports only 5 external modules and every import was already used
somewhere in the monolith.

## Decompositions (step 3 — outliers, real seams only)

**solveBigintProvenance** (632 -> ~560 lines after hoisting): the four
functions above (paramNeedsHostTag, isStorageReadArgShape, seedBigintTyped,
paramEntryExcludesBool) are genuinely free-standing — each computes a pure
answer from explicit inputs, no dependency on the fixpoint's own mutable
Maps (storage/bigintTyped/results/resultReps/globalReps) except
seedBigintTyped's target Set and paramEntryExcludesBool's programFacts
lookup, both trivially threaded as explicit parameters (Set/Map mutate by
reference either way — zero behavior change). Hoisting them to module scope
in provenance.js is a real seam: each is an independently-nameable,
independently-testable sub-proof (host-tag ingress recognition,
storage-read call-argument shape, syntactic BigInt-typed-array seeding,
whole-program-census boolean-exclusion), not an arbitrary slice.

Declined (with reasons, no change): `exprMay`/`exprRep`/`scan`/`visitCallSites`
— each closes over 4+ of the fixpoint's own mutable Maps
(storage/bigintTyped/results/resultReps/globalReps/paramsByFunc/namesByFunc)
and several are mutually recursive with each other and with
`dispatchClosureMayBigint`/`noteResult`; separating "collect facts" from
"decide actions" here would require threading a ~10-field context bundle
through code that campaign history (`.work/archive/phase-c-unification.md`'s Shape
#6 "the landing plan's fixpoint suspicion was one layer too deep", Shape #7,
C5's four-falsified-forms note) shows is unusually sensitive to ordering and
staleness mistakes. Not a "collect vs decide" seam either — every one of
these functions both collects new facts AND immediately uses them to decide
whether to mark something, node by node, in one pass; there is no clean
before/after split without breaking the single-pass property that makes the
fixpoint terminate correctly.

**buildBodyData** (806 -> ~770 lines after hoisting, plus the new
`hasClosedBool` dedup): `edgeMaterializable` is hoisted (byte-identical, see
above). The "collect facts" (semantic fixpoint / current fixpoint / target +
edge walk, ~1251-1713) vs "decide actions" (materialization fixpoints,
~1715-2013) split that the task brief's own example names was evaluated in
depth and **declined**: `semanticOf`/`currentOf` are called LIVE (not just
read from their memo Maps) by the decide-actions half (materializedJoins
fixpoint's `semanticOf(node)`, `emittedCandidate`'s `currentOf(node)`
default branch, materializedNames readiness's `currentOf(def[DEF_RHS])`),
and `nodeCurrent`/`nodeSemantic` are intentionally `.clear()`-ed at specific
points inside the fixpoints (lines 1444, 1558, 1569) — so a caller-side
data-only handoff (return the Maps, throw away the closures) is not
sufficient; the closures themselves must cross the boundary. A correct split
requires bundling ~20 shared bindings (ctx/identity/sig/boundary/options/
provenance/localStorage/params/defs/semanticNames/currentNames/targetNames/
nodeTarget/calleeNameOf/closureCallNeedsBox/semanticOf/currentOf/
bodyResultSemantic/bodyResultTarget/resultExprs/exportedIdentity/edges) into
one context object threaded through every read site in the "decide actions"
half — a large-surface mechanical rewrite of the single function in this
file with the most extensively documented history of subtle
staleness/ordering bugs (Shape #6 layers 1-6, Shape #7, C4b, C5, C5b, the
member-callee-binding-write sibling's own multi-session bisection). This is
exactly the risk profile "never speculative abstraction" warns against: the
transformation is mechanical in form but the SAFETY of each of the ~20
handoffs is not independently checkable by inspection, only by the oracle +
full battery — acceptable for a small hoist, not for a rewrite touching most
of an 800-line function. Declined; buildBodyData stays one function.

**hasClosedBool dedup** (new, real): the guard
`semanticClosed(X) && (semanticKinds(X) & bitOfKind(VAL.BOOL)) !== 0` (the
"BOOL-veto" the file's own comments name repeatedly) appears byte-identical
at 7 sites (materializedNames loop guard, hostBoxParams guard, closureBoxParams
guard, the JOIN_OPS materialization fixpoint, the census-unary/joint
materialization pass, the materializedNames-propagation-via-materializedJoins
pass, and resultHasClosedBool) differing only in which semantic value is
tested and whether the caller negates it. Extracted to one named predicate
in body-data.js, called at all 7 sites — exactly the "repeated guard blocks
that are genuinely identical in intent become one helper" case the task
brief names.

## walkAst retirement (step 4)

`walkAst`'s contract (`src/ast.js:119-128`): `enter(node, parent, index)`
fires only on **array** nodes (bare string/number leaves are never
independently visited — a hard incompatibility for any walker that
special-cases a bare string leaf, per `.work/archive/analyze-traversals.md`'s own
finding for analyze.js); `boundary`, when supplied, applies **uniformly** to
every visited node with no root exemption; there is no support for an
`Array.isArray(node[0])` "the op itself is a list" node shape (the walk
always treats index 0 as the non-recursed opcode slot).

Candidates found (both **retired**, see commit): `collectLocalClosures`'s
and `collectDispatchTableClosures`'s inner `collect` functions. Verified
byte-identical to a walkAst port: neither ever inspects a bare string leaf
(both immediately no-op on one, matching walkAst's own skip), neither has a
root-vs-nested asymmetry (no `=>`-boundary special case at all — they
recurse into arrow bodies exactly like anywhere else, an existing,
unchanged imprecision noted in their own doc comments, not something this
move touches), and neither is ever called with a node shaped so that
`Array.isArray(node[0])` matters for `collectLocalClosures` (only ever
called with a function `body`, never the top-level `ast`); for
`collectDispatchTableClosures`, which **is** called with `ast` as one of its
roots, the port is still safe because the CURRENT code already has the
identical "skip index 0" behavior for that shape (its own loop starts at
`i = 1`, same as walkAst) — the port changes nothing about which nodes get
visited, whatever `ast[0]`'s shape turns out to be.

CORRECTION (post-merge, main b76a34b3): the `root`-parameterized-`=>`-boundary
class above was mis-analyzed as a hard `walkAst` incompatibility. `walkAst`'s
`enter(node, parent, index)` receives `parent` — `parent === null` identifies
the root call (`visit(node, null, -1)`), so `if (parent !== null && n[0] ===
'=>') return false` inside `enter` replicates `if (!root && op === '=>')
return` exactly, no `boundary` option or root exemption needed. The sibling
`refactor/pipeline-minimality` campaign found this independently and retired
`deriveLocalProvenance`'s `scanStorage` this way; merged into this branch
verbatim (byte-identical to main's tip) rather than re-derived. Retired:
`collectLocalClosures`, `collectDispatchTableClosures` (this branch's own
finding, both in common.js/provenance.js respectively), plus `scanStorage`
(merged from main, now in provenance.js) — three for three of the
root-exempt walkers actually named below turned out to be safe once the
`parent` trick is used; the fourth (`paramNeedsHostTag`) and the two
`Array.isArray(node[0])`-dependent ones were not touched by the sibling
campaign either and stay declined for the reason already given.

Declined (documented, unchanged): `collectDefs`'s `walk` and `buildBodyData`'s
`walkEdges` still have the `Array.isArray(op)` "op is itself a list" branch
in addition to the root exemption (see below) — the `parent` trick alone
does not resolve that second incompatibility, so retiring these needs the
same list-shape care the declined pair below already flags, not attempted
here. `paramNeedsHostTag` (solveBigintProvenance-local, not hoisted this
slice) has the plain root exemption only and IS a same-shape candidate for
the `parent` trick — not applied in this slice (found only via the merge,
not independently), recorded here as a follow-up rather than guessed at
under time pressure. Also
declined: `solveBigintProvenance`'s `seedBigintTyped`/`scan`/`visitCallSites`
(all three have the `Array.isArray(node[0])` "op is itself a list" branch,
used for the top-level `ast` walk specifically — walkAst has no equivalent).
`semanticOf`/`currentOf`/`plannedOf`/`emittedCandidate` and provenance's
`exprMay`/`exprRep` are not traversals in walkAst's sense at all (memoized
recursive VALUE functions with op-specific pattern matching, not
visit-every-node side-effecting walks) — not candidates.

## Dead code (step 5)

None found by this pass beyond what step 3's hoisting already removes from
the outliers' own bodies. The per-site-widening redundancy the task brief
flagged as a possible deletion target was already resolved before this
base commit (see "index-resolved `.`-member callees" above) — confirmed via
`.work/archive/member-callee-binding-write-notes.md` and a direct read of
`edgeMaterializable`'s current form.

## Status — what actually landed

Shas (branch `refactor/representation-plan-split`, base `0feb9e29`):
- `8d27e543` — pure move (this doc's committed version, one commit).
- `c963c418` — merge `b76a34b3` (main): main landed `ffac902c` mid-slice
  (a sibling `refactor/pipeline-minimality` campaign retiring 152 walkers
  onto `walkAst`/`some` repo-wide, including 3 in this exact file). Resolved
  by keeping this branch's split for `representation-plan.js` itself and
  reapplying the 3 walkAst conversions verbatim to their new homes
  (`collectLocalClosures` → common.js, `collectDispatchTableClosures` +
  `deriveLocalProvenance`'s `scanStorage` → provenance.js). New baseline
  for all gates from this commit on: `b76a34b3`, not `0feb9e29`.
- `0db49b24` — corrected this doc's own scanStorage mis-analysis (see
  "CORRECTION" note above).
- `1f127c42` — decompose: 5 helpers hoisted (provenance.js:
  paramNeedsHostTag, isStorageReadArgShape, seedBigintTyped,
  paramEntryExcludesBool; body-data.js: edgeMaterializable), plus the new
  `hasClosedBool` dedup helper (7 call sites).

Final module map (lines, `wc -l`): barrel 62, common.js 239, boundaries.js
252, provenance.js 785, body-data.js 933, materialize.js 400, call-args.js
45 — 2716 total (vs 2565 original; growth is import-statement overhead
from splitting one scope into six, plus new/expanded doc comments on the
5 hoisted helpers — no logic duplication).

Full battery (final commit `1f127c42`):
- `refactor-oracle check --ref b76a34b3` (140/560 non-self-host corpus):
  CLEAN, both after the merge commit and after the decompose commit.
- `node test/index.js` (excluding bench-c, sandbox constraint): 3771
  total / 3770 pass / 0 fail / 1 skip (27416 assertions) — the 1 skip is
  pre-existing (unrelated to this slice).
- kernel build (`npm run build`): clean. `JZ_TEST_TARGET=jz.wasm node
  test/index.js` (plain invocation): 2984 total / 2983 pass / 0 fail /
  1 skip (14348 assertions) — the self-compiled kernel, built from this
  branch's own split source, compiles and runs the full suite with zero
  failures.
- `node test/kernel-parity.js`: 3/3 (33/33 byte-identical WAT at O0/O2/O3).
- `node test/kernel-oracle.js`: 14/14 (605 assertions).
- `node test/data.js` standalone: 171/171 (935 assertions, incl. the
  Shape #5-#9 pins). `node test/pointers.js` standalone: 73/73 (132
  assertions).
- `node scripts/bench-size.mjs --json`: ran clean; spot-checked `watr`
  (293047 bytes) against the non-full oracle's own `bench:watr|size`
  entry for the same commit — identical, as expected (both measure the
  same size-tuned build through the same corpus the oracle already
  proved byte-identical).
- Kernel bytes (`dist/jz.wasm`, `npm run build`): baseline (`b76a34b3`)
  17,881,876 bytes. After the pure-move split alone: 17,881,862 bytes
  (-14). After the decompose commit (the `hasClosedBool` dedup removes 6
  duplicate inline copies of the BOOL-veto guard from the self-compiled
  kernel's own body): 17,878,294 bytes (-3,582 from baseline). Both
  deltas are reproducible (rebuilt twice, identical sha256 each time) but
  NOT byte-for-byte identical to the baseline kernel — expected and
  benign, not a correctness concern: the self-host leg compiles jz's OWN
  source graph, which now has 7 modules where representation-plan.js used
  to be 1 (170 total modules vs presumably 165), so any module-count- or
  discovery-order-sensitive pass (e.g. `ctx.funcs.list` ordering) can
  shift the compiled layout even under a byte-for-byte behavior-preserving
  source change — a different class of guarantee than the non-self-host
  corpus the standard oracle covers, which compiles individual small
  programs unaffected by jz's OWN module count. A `refactor-oracle
  --full` run (which includes this exact self-host leg in its SHA256
  comparison) was attempted but its own temp baseline worktree was
  removed mid-run by what looks like unrelated concurrent activity in
  this multi-agent campaign (`fatal: cannot change to
  '.../jz-oracle-IG3NXX/wt'`, `baseline commit null` in its own output) —
  inconclusive, not re-attempted a second time (30+ min per attempt) given
  the direct behavioral evidence already in hand: the FULL test suite
  (2983/2984, 0 fail) run THROUGH this exact rebuilt, byte-different
  kernel — the strongest available proof for THIS file specifically, since
  representation-plan.js's own documented history (`.work/archive/phase-c-
  unification.md`) is full of self-host-only divergences that manifest as
  test failures, not silent byte-identity.
