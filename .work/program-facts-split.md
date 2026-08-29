# program-facts.js split (v1 architecture-convergence, pipeline-minimality)

Map of `src/compile/program-facts.js` (2,010 lines at ref `0feb9e29`, the
branch point) written BEFORE any move, per this slice's own instructions —
restart-safe, and the basis for the module split (step 2) below. Companion
prior art already read, not re-derived here: `.work/refactor-oracle.md` (the
gate), and `.work/analyze-traversals.md` (`refactor/analyze-traversals`
branch — the sibling slice that split `analyze.js`/`analyze-scans.js`; its
`walkAst` pitfalls (bare-string leaves never independently visited, iterative
walks that exist to survive self-host, fixpoint walks) are the reason step 3
of THIS slice declines every retirement below).

## 1. What the file produces — fact → builder → consumers → order

Every export, what it publishes, who reads it (grep-verified: `rg -n "from
'.*program-facts\.js'"` across the whole repo — exactly 5 importing files,
listed per-fact below; nothing else imports this module by any relative
path), and where in the internal call graph it sits.

| fact / export | builder (lines, original file) | publishes to | external consumers | internal callees |
|---|---|---|---|---|
| `observeNodeFacts(node, f)` | 47-193 (147 lines) | mutates the caller's `f` accumulator in place (dynVars/dynWriteVars/anyDyn/nameEscapes/arrResized/writtenProps/literalWriteKeys/objectLiteralDefs/hasBigint/hasSchemaLiterals/hasMapSet/maxDef/maxCall/hasRest/hasSpread) | `src/prepare/index.js` (direct call, per-node, during AST construction) | none (leaf) |
| `collectProgramFacts(ast)` | 387-493 (107 lines) | returns the whole-program facts object (`dynVars, dynWriteVars, anyDyn, propMap, valueUsed, callSites, maxDef, maxCall, hasRest, hasSpread, paramReps, hasSchemaLiterals, hasMapSet, hasBigint, writtenProps, literalWriteKeys, arrResized, nameEscapes, literalObjectVars`); also sets `ctx.module.writtenProps` | `src/compile/plan/index.js` (`facts()`, the ONLY external call site — one per compile, re-invoked lazily after any AST-mutating pass reports dirty) | `observeProgramSlots(ast)` (conditionally, no opts — "early" mode), `analyzeSchemaSlotIntCertain(ast)` (conditionally, no opts) — see §2 for the exact gates |
| `resetProgramFactsCache()` | 203-209 (7 lines) | bumps `pf.gen`, replaces `pf.walkCache`/`moduleInitSlot`/`bodyIntCertain` with fresh WeakMaps | `scripts/self.js` (self-host warm-instance loop, between compiles) | none (leaf) |
| `invalidateProgramFactsCache(...roots)` | 212-220 (9 lines) | deletes specific AST-root entries from the same three WeakMaps | `src/compile/plan/scope.js` (in-place module rewrites) | none (leaf) |
| `observeProgramSlots(ast, opts)` | 677-1163 (487 lines) | populates `ctx.schema.{slotFacts, slotConstInts, dictValueTypes, mapValueTypes, hasTypedSlots}`; publishes `dictValueValType`/`mapValueValType` onto `ctx.scope.globalReps` via `updateGlobalRep` (copies, never the live Set — see §4) | `src/compile/narrow.js` (post-E2 valResult refinement), `src/compile/plan/index.js` (late `{fresh:true}` rebuild after narrowing) | `collectSlotWriteHazards(ast, ...)`, `applySlotWriteHazards`, `analyzeBody` (external, analyze.js) |
| `effectiveWriteValue(op, lhs, rhs)` | 1221-1226 (6 lines) | pure function, no publish | none currently (grep-verified: exported, zero external importers at this ref — kept exported for API stability, a future/sibling consumer could exist) | none (leaf, pure) |
| `collectSlotWriteHazards(ast, opts)` | 1308-1655 (348 lines) | returns AND sets `ctx.schema.slotWriteHazards = hz` (`{pointsTo, dynPointsTo, props, numeric, kindSafeSids}`); caches on `pf.hazard` keyed by `(gen, late)` | none currently (grep-verified: exported, zero external importers — see `applySlotWriteHazards` note below) | `collectBodyElemSids` (private, shared) |
| `applySlotWriteHazards(hz, poison, opts)` | 1663-1677 (15 lines) | calls the caller-supplied `poison(sid,idx)` / `opts.observe(sid,idx,vt)` callbacks — no state of its own | none currently (grep-verified: exported, zero external importers) | none (leaf) |
| `analyzeParamNeverGrown(paramReps)` | 1718-1813 (96 lines) | mutates the `paramReps` Map ARGUMENT in place (`reps.get(k).neverGrown = true`) — does not return a new object | `src/compile/plan/index.js` (optimizing-only, post-narrowSignatures) | `analyzeBody` (external), `safeReads` (external, analyze-scans.js) |
| `analyzeSchemaSlotIntCertain(ast, opts)` | 1837-2009 (173 lines) | clears+rebuilds `ctx.schema.{slotIntCertain, slotI32Certain}` from the working `ctx.schema.slotIntLevels` map | `src/compile/plan/index.js` (early, inside `collectProgramFacts`'s own gate, AND late `{fresh:true}`-equivalent rebuild via `opts.paramReps`) | `collectSlotWriteHazards`, `applySlotWriteHazards`, `collectBodyElemSids` (private, shared), `effectiveWriteValue`, `intLevelChecker` (external, type.js) |

Private (never exported) helpers, and which family actually calls them —
this is where TEXTUAL position in the original file misleads (flagged
explicitly per this slice's instructions):

| helper | lines | real family | textual position suggests |
|---|---|---|---|
| `ARR_RESIZE_METHODS` | 24 | shared: `observeNodeFacts` (family A) AND `analyzeParamNeverGrown` (family E) | looks A-only (sits right above `observeNodeFacts`) |
| `isObjectLiteral`, `recordObjectLiteralDef`, `ESCAPE_SKIP` | 29, 32-35, 37-45 | A only | — (correct) |
| `emptyWalkFacts`, `mergeWalkFacts`, `walkFactsRoot` | 222-232, 234-260, 265-385 | A only (private to `collectProgramFacts`) | — (correct) |
| `writeVT` family: `SELF_READ`, `isSelfDictRead`, `ATOM`, `truthyVS`, `falsyVS`, `nonNullishVS`, `reduceVS`, `vsOf`, `writeVT` | 534-665 | B only (`observeProgramSlots`) — grep-verified zero uses in `analyzeSchemaSlotIntCertain`, which has its own independent `isInt`/`intLevelChecker` path | — (correct; textually adjacent to `observeProgramSlots`, which is right) |
| `collectBodyElemSids` | 1192-1215 | shared: `collectSlotWriteHazards` (family C, late mode) AND `analyzeSchemaSlotIntCertain` (family D, `bodySidsOf`) — doc comment at 1186 says so explicitly | sits between B and C/D, looks C-only |
| `isSelfPreservingPropWrite`, `SELF_PRESERVING_OPS` | 1244-1264 | **B only** (`observeProgramSlots`'s `.prop=` branch, line 985 in the original) | **misleading**: textually defined AFTER `observeProgramSlots` ends (1163) and BEFORE `collectSlotWriteHazards` starts (1308) — sits in hazard territory, reads like a C helper, but its only call site is inside B. (Works today only because `function` declarations hoist; B's body executes long after module load.) |
| `KEYED_EXEMPT_VALS` | 1266 | C only | — (correct) |
| `_numericName` | 1184 | C only (`applySlotWriteHazards` + `collectSlotWriteHazards`'s own `keyedWrite`) | sits before `collectBodyElemSids`, in the "middle zone" — still C, just early |
| `_NG_SAFE_CALLEES`, `_NG_SAFE_METHODS` | 1698-1714 | E only | — (correct) |

Two dead imports, grep-verified (every occurrence besides the import line
itself is inside a comment, never a real reference): `ASSIGN_OPS` (from
`../ast.js`, line 5 — zero uses anywhere in the file body) and
`lookupValType` (from `../reps.js`, line 7 — its only two other mentions are
prose inside doc comments explaining `valTypeOf`'s own behavior, e.g.
"through valTypeOf → lookupValType"). No orphaned doc comments were found
(unlike the analyze.js slice) — every comment block precedes real code.

## 2. Order dependencies

**Internal** (inside this file, at every original call site — verified by
reading each function body, not inferred):

- `collectProgramFacts` (A) → `observeProgramSlots` (B), conditionally on
  `doSchema && (hasSchemaLiterals || hasMapSet)` — B runs strictly after A's
  own whole-program walk, since the gate flags (`hasSchemaLiterals`/
  `hasMapSet`) are themselves outputs of that walk.
- `collectProgramFacts` (A) → `analyzeSchemaSlotIntCertain` (D), conditionally
  on `hasSchemaLiterals` (a STRICTER gate than B's — D never runs on a
  Map-only program with no `{}` anywhere), and only AFTER B has already run
  (both live inside the same `if (doSchema && (...))` block, B first).
- `observeProgramSlots` (B) → `collectSlotWriteHazards` (C) → (inside C)
  `collectBodyElemSids` (shared) — late mode only (`opts.paramReps`).
- `observeProgramSlots` (B) → `applySlotWriteHazards` (C).
- `analyzeSchemaSlotIntCertain` (D) → `collectSlotWriteHazards` (C) again.
  Because C caches on `pf.hazard` keyed by `(gen, late)` (line ~1311) and A's
  B-then-D sequence calls C with the SAME `late` value both times (both
  early/non-late inside one `collectProgramFacts` pass), D's call is a cache
  hit, not a recompute — a PERFORMANCE order dependency (B must run first for
  D's call to be free), not a correctness one (D's call would still be
  correct cold).
- `analyzeSchemaSlotIntCertain` (D) → `applySlotWriteHazards` (C).
- Neither B nor D ever calls the other directly — parallel siblings over the
  same hazard substrate.
- `analyzeParamNeverGrown` (E) calls neither B, C, nor D — a fully
  independent fact domain (array growth-freedom, not schema slots). Its only
  shared dependency is the `ARR_RESIZE_METHODS` constant, also used by A.

**External** (`src/compile/plan/index.js`, documented in full in that file's
own comments — cited, not re-litigated, since that file is out of scope for
this slice):

1. `collectProgramFacts` — the EARLY pass, pre-narrowing receivers. Internally
   triggers B and D per the gates above.
2. `buildCallTargetIndex` (`call-target-index.js`, prior slice, frozen) reads
   `programFacts.nameEscapes`/`.dynWriteVars`/`.valueUsed` — a CONSUMER of
   family A's output, not part of this file.
3. `narrowSignatures` (`narrow.js`) mutates `programFacts.paramReps`/
   `.callSites` IN PLACE (see §3 — this is the freeze finding).
4. `observeProgramSlots` again, `{fresh:true}` — late-mode REBUILD (not a
   patch) with narrowed `paramReps`/`callSites`/`valueUsed` threaded through,
   so receivers `re[j] = tr` on a now-typed param resolve as element writes
   instead of world-poisoning.
5. `analyzeParamNeverGrown(programFacts.paramReps)` — optimizing-only, after
   (4) so raw-base eligibility sees narrowed reps.
6. `analyzeSchemaSlotIntCertain` again, same late-mode rebuild shape as (4).

## 3. Freeze findings — fact objects mutated after publication today

Per this slice's explicit instruction: documented, NOT changed (freeze-
before-consumers is a follow-up unless byte-identical and trivial — none of
these are).

- **`programFacts.paramReps`** (a `Map`, created empty by `collectProgramFacts`
  at line 388: `const paramReps = new Map()`, included in the returned object
  still empty). Populated in place by TWO different later writers: (a)
  `narrow.js`'s `narrowSignatures` (external, confirmed via `plan/index.js`'s
  own comment: "narrowSignatures returns nothing — its entire effect is IN-
  PLACE MUTATION of programFacts (`.paramReps`/`.callSites`)" — also
  `ensureParamRep(paramReps, ...)` call sites inside narrow.js itself), and
  (b) THIS FILE's own `analyzeParamNeverGrown`, which sets `.neverGrown` on
  each per-function-per-param entry (`reps.set(k, {neverGrown: true})` /
  `r.neverGrown = true`). Neither is a rebuild-from-scratch; both are
  incremental in-place additions to the SAME Map identity `collectProgramFacts`
  handed out. The exact ad-hoc, pass-order-dependent shape the v1 gate names
  as the class of bug this campaign exists to close — but re-deriving it
  soundly (e.g. `analyzeParamNeverGrown` returning a fresh overlay instead of
  mutating the shared Map) is a real behavior-surface change, out of scope
  here.
- **`programFacts.callSites`** (an `Array`, built by `collectProgramFacts`).
  Per the same `plan/index.js` comment, also mutated in place by
  `narrowSignatures` (bundled with `.paramReps` in that file's own doc — not
  independently re-verified inside `narrow.js`'s body, which this slice does
  not touch or own).
- **`programFacts.callTargets`** — not present in the object
  `collectProgramFacts` constructs at all; stapled on afterward by
  `plan/index.js` (`programFacts.callTargets = buildCallTargetIndex(...)`).
  Not a mutation of an existing field, but the same underlying issue: the
  returned object is an open bag, not a closed/frozen shape, so any later
  pass can extend it unchecked.
- **Deliberate counter-example** (evidence the file's own author already
  applies freeze-discipline where it mattered most): `observeProgramSlots`
  publishes `dictValueTypes`/`mapValueTypes` onto `ctx.scope.globalReps` as
  **copies** (`new Set(s)`, never the live working Set) specifically so a
  later observation in the same pass can't silently mutate an
  already-published rep field by aliasing (see that function's own comment,
  original lines ~1146-1156). `ctx.schema.slotWriteHazards = hz`
  (`collectSlotWriteHazards`'s publish) is REASSIGNED wholesale on every
  call, never mutated in place by a reader — `applySlotWriteHazards` only
  READS `hz.pointsTo`/`.props`/`.numeric`/`.kindSafeSids`.

No change to any of this in the current slice (pure move only) — the map
above is the record the task asked for.

## 4. Module split plan (step 2 — pure moves)

`src/compile/program-facts.js` splits into `src/compile/program-facts/`,
one small file per fact family, verified against actual usage (every import
list below is grep-checked per-file against the exact moved line ranges —
comment-only mentions of a symbol, e.g. "through valTypeOf → lookupValType",
were excluded after checking each one individually; several first-pass
guesses were wrong this way, see execution notes). `program-facts.js`
becomes the stable barrel: same 10 exported names, same signatures, zero
consumer import-path changes.

| new file | contents (original line ranges) | depends on |
|---|---|---|
| `program-facts/shared.js` | `ARR_RESIZE_METHODS` (24), `collectBodyElemSids` (1192-1215), `effectiveWriteValue` (1221-1226) — cross-family primitives two builders each share, so neither owns them outright (mirrors `analyze/trackers.js`'s identical reason) | `analyzeBody` (external) only |
| `program-facts/cache.js` | `resetProgramFactsCache` (203-209), `invalidateProgramFactsCache` (212-220) | `getFactStore` (external) only |
| `program-facts/slot-write-hazards.js` | `KEYED_EXEMPT_VALS` (1266), `_numericName` (1184), `collectSlotWriteHazards` (1308-1655), `applySlotWriteHazards` (1663-1677) | `shared.js` (`collectBodyElemSids`) + externals |
| `program-facts/slot-kind-census.js` | the `writeVT` family (534-665), `isSelfPreservingPropWrite`/`SELF_PRESERVING_OPS` (1244-1264, moved here despite textual position — see §1's table), `observeProgramSlots` (677-1163) | `slot-write-hazards.js` + `shared.js` (`effectiveWriteValue`) + externals |
| `program-facts/slot-int-census.js` | `analyzeSchemaSlotIntCertain` (1837-2009) | `slot-write-hazards.js` + `shared.js` (`collectBodyElemSids`, `effectiveWriteValue`) + externals |
| `program-facts/param-never-grown.js` | `_NG_SAFE_CALLEES`/`_NG_SAFE_METHODS` (1698-1714), `analyzeParamNeverGrown` (1718-1813) | `shared.js` (`ARR_RESIZE_METHODS`) + externals |
| `program-facts/walk-facts.js` | `isObjectLiteral`/`recordObjectLiteralDef`/`ESCAPE_SKIP` (29-45), `observeNodeFacts` (47-193), `emptyWalkFacts`/`mergeWalkFacts`/`walkFactsRoot` (222-385), `collectProgramFacts` (387-493) | `slot-kind-census.js` (`observeProgramSlots`), `slot-int-census.js` (`analyzeSchemaSlotIntCertain`), `shared.js` (`ARR_RESIZE_METHODS`) + externals |
| `program-facts.js` (barrel) | re-exports only, plus the module-map/build-order doc comment (this file's §1/§2, condensed) | all seven above |

Dependency DAG (no cycles): `shared.js`/`cache.js` at the bottom (depend on
nothing else in this module); `slot-write-hazards.js` depends only on
`shared.js`; `slot-kind-census.js` and `slot-int-census.js` each depend on
`slot-write-hazards.js` + `shared.js` and are mutually independent;
`param-never-grown.js` depends only on `shared.js`; `walk-facts.js` sits on
top, depending on both slot-census modules.

Verified with `node scripts/refactor-oracle.mjs check` after every commit:
CLEAN throughout (see commit messages for per-step counts).

## 5. Fusions / retirements — none attempted, and why

Per this slice's step 3, fusion/retirement is only IN SCOPE once the pure
move lands. Recorded here as a pre-scan so the split above already accounts
for what step 3 will find, rather than discovering it mid-move:

- **No two traversals in this file visit the same node set in the same order
  with independent per-node actions.** `observeNodeFacts`'s per-node walk (A)
  runs once over the WHOLE program including nested closures/arrows (it is
  itself the generic per-node observer `walkFactsRoot` calls at every node);
  `observeProgramSlots`'s `visit` (B) and `collectSlotWriteHazards`'s `visit`
  (C) both stop descending into function bodies (`func.raw` guard) and
  install a PER-FUNCTION `withValueOverlay` before walking each body
  separately — same shape as each other, but B additionally threads
  `intRefs`/`maskMax` (branch-local integer refinement, `if`/`?:` arms) that C
  does not, and C additionally threads `curParamVts`/`curParamIntCertain`/
  `curFuncName`/`curParamIdx` (late-mode param resolution) that B does not
  need in the same form — forcing them into one walk would mean threading the
  union of both parameter sets through every node-kind branch for zero
  reduction in visited-node count (B and C already run back-to-back, once
  each, not redundantly). `analyzeSchemaSlotIntCertain`'s `visit` (D) is a
  THIRD independent per-node walk over the same bodies, with its OWN
  `isInt`/fixpoint-round state (`sweep`, up to 64 rounds) — not fusable with
  B/C without smuggling the intCertain fixpoint's re-entrancy into the
  single-pass kind census, which would change convergence semantics, not
  just traversal count.
- **`walkAst`/`some` (src/ast.js) retirement**: every hand-rolled walk in this
  file (`observeNodeFacts`'s caller `walkFactsRoot`'s `walkFacts`, B's
  `visit`, B's `observeNestedDictMapWrites`'s `walk`, C's `visit`, C's
  `patternTargets`, D's `visit`, `collectBodyElemSids`'s `scan`,
  `analyzeParamNeverGrown`'s `scan`/`collectObjDecls`) either (a) special-
  cases a BARE STRING node directly (e.g. `collectProgramFacts`'s single-bare-
  identifier-arrow-body branch, original line 275: `if (typeof root ===
  'string') acc.nameEscapes.add(root)`) — the exact hard incompatibility the
  analyze-traversals slice's final report names (`walkAst`'s `enter` only
  ever fires on ARRAY nodes, never an independently-visited string leaf), or
  (b) threads caller-specific state through the recursion signature itself
  (`inArrow`/`caller` in A, `intRefs`/`paramVts` in B, `curSids`/`curParamVts`
  in C, `isInt`/round state in D) in a shape `walkAst`'s single `{enter}`
  callback does not accommodate without a `WeakMap`-side-channel rewrite —
  out of scope for a traversal-COUNT slice, and exactly the kind of "bigger,
  riskier change" `.work/walk-count-design.md` already declined for the
  sibling file's analogous cases. None of this file's walks are the
  iterative-by-necessity or fixpoint-outer-loop shape `analyze-traversals.md`
  catalogs (no `dictWalkLean`-style self-host-miscompile history found in
  this file's git log) — `analyzeSchemaSlotIntCertain`'s OWN fixpoint
  (`sweep`, ≤64 rounds) is the one fixpoint here, and it is already a
  bounded `while` loop over a flat `slotIntLevels` map, not a tree re-walk
  pattern `some`/`walkAst` could stand in for.

Step 3 (fusion) and step 4 (dead-code deletion) proceed after the module
split lands; the two dead imports found in §1 are dropped mechanically as
part of the split (each new module imports only what it actually calls).

## 6. Discrepancy note

The task brief names a `synthesizeComputedDispatchCallSites` function "added
for the call-target index." No such name exists anywhere in the repository
at ref `0feb9e29` (`rg` across the whole tree, zero hits). The closest real
code is `collectSlotWriteHazards`'s `sitesByCallee` construction (built from
`opts.callSites`, used to resolve a dyn-key receiver that's a function
PARAMETER to the union of schemas its call sites pass — the "computed-
dispatch" the git log's `39c8ecff`/`6c099324`/`9c347b8f` commits describe) —
but that is call-site RESOLUTION, not synthesis, and it long predates
`call-target-index.js`. `call-target-index.js` itself (`buildCallTargetIndex`)
is a separate, already-existing module (the prior slice), not part of
`program-facts.js` and not touched here; it consumes
`programFacts.nameEscapes`/`.dynWriteVars`/`.valueUsed` (family A's output)
but contains no program-facts.js code. Recorded per this file's own
convention (§1's dead-import note, `analyze-traversals.md`'s "both readings
recorded" precedent) rather than silently reconciled or invented.

## 7. Freeze audit (`refactor/program-facts-freeze` slice) — fact lifecycle table

v1 architecture-convergence "facts frozen before consumers" (handoff's second-
audit gate 5/finish-order item 1's sibling finding: "call-target authority +
program-facts separation block v1 — they cause wrong-value classes"). Scope:
`programFacts.paramReps`, `.callSites`, `.callTargets` — the three fields §3
above named as mutated/stapled after publication. Method: grep-verified
producer call graph (every `.set(`/`.push(`/`.length =`/`eligibleSites`
retarget site across `src/`, plus every reader), not inferred from doc
comments alone — several of §3's own claims turned out incomplete once
checked against `plan/index.js`'s actual round structure (see 7.2).

### 7.1 Fact lifecycle table

| fact | producers, in true execution order | last producer WITHIN `plan()` | freeze point chosen | mechanism |
|---|---|---|---|---|
| `paramReps` | (1) `collectProgramFacts` publishes empty (`walk-facts.js:356`) → (2) `narrowSignatures` fixpoint (`narrow.js`, via `param-reps.js:122 ensureParamRep`) → (3) `analyzeParamNeverGrown` IFF `optimizing()` (`param-never-grown.js:143-147`, sets `.neverGrown`, can even mint a fresh per-func Map) → (4) `specializeBimorphicTyped`, UNCONDITIONAL, last stmt of plan round 2 (`variant.js:112` via `materializeVariant`) → (5) `specializeValKindDichotomy` IFF `optimizing()`, plan round 3 → (6) `speculateTypedParams` IFF `optimizing()`, plan round 3, right before the always-run-but-read-only `refineDynKeys` → **(7) `specializeUnionCursorParams`, called NOT from `plan()` but from `src/compile/index.js:2556` (off-limits file), during EMIT's `unionClones` phase, AFTER `plan()` has already returned** | end of plan round 3 (after step 6, or step 4 if `!optimizing()`) | end of plan round 3, i.e. between the round-3 `round(()=>{...refineModuleLetTypes})` call and round 4's `round(()=>{refineSlotIntCensus})` | read-only VIEW `{ get: k => paramReps.get(k) }` installed on `programFacts.paramReps` for rounds 4-5 + `solveRepresentationBoundaries`, then **restored to the real Map right before `plan()` returns** (both return points) so step (7)'s later legitimate write keeps working unchanged — see 7.2 |
| `callSites` | (1) `collectProgramFacts` builds via the whole-program walk (`walk-facts.js` `f.callSites.push`, ×2) → (2) `narrowSignatures` entry: `filterLiveCallSites` truncates in place (`narrow.js:63-87`, `callSites.length = w`) → (3) entry-level `.callee`/`node[1]` retarget via `materializeVariant`'s `eligibleSites`, from `specializeFixedRestCalls` (early-plan, pre-narrowing — reads the PRE-filter census, legitimately), `specializeBimorphicTyped` (round 2), `specializeValKindDichotomy` (round 3) — `speculateTypedParams` passes `eligibleSites:[]`, no retarget | end of plan round 3 | same point as `paramReps` | `Object.freeze(callSites)` (array) + `Object.freeze()` each entry — **permanent, no restore needed**: grep-confirmed `specializeUnionCursorParams` (the one later EMIT-phase writer) never destructures/touches `programFacts.callSites` at all, so unlike `paramReps` this fact IS fully closeable for the whole program run, not just within `plan()` |
| `callTargets` | (1) `buildCallTargetIndex` (`call-target-index.js:261-306`) returns `Object.freeze({resolveMember})` — value already sound/frozen at construction | `plan/index.js:230`, the ONLY `programFacts.X = ` staple-on site anywhere in `src/compile/` (grep-verified — zero others, including inside `narrow.js`) | immediately at `plan/index.js:230-231` | value was already frozen; the actual defect is the CONTAINER (`programFacts` itself has no closed shape) — fixed via a `DBG_INVARIANTS`-gated `assertProgramFactsShape` allowlist check, not a container freeze (see 7.3 for why `Object.seal` is unusable here) |

### 7.2 Readers, and the premise this audit corrected

Full-repo grep of every `paramReps`/`callSites` reader outside `narrow.js`
(`src/compile/plan/scope.js`, `program-facts/slot-kind-census.js`,
`program-facts/slot-int-census.js`+`shared.js`, `inplace-store.js`,
`representation-plan.js`, `analyze/struct-inline.js`, `analyze/union-inline.js`,
`plan/inline.js`, `plan/literals.js`, `dyn-closure-tables.js`,
`plan/advise.js`, emit-time `compile/index.js`) — **no reader was found
reading either fact before its relevant producer settled**. The two
early-plan `callSites` readers (`inlineHotInternalCalls`,
`specializeFixedRestCalls`, both pre-narrowing) legitimately want the raw,
pre-filter census (inlining off the original call graph); every
post-narrowing reader already runs in plan round 2+ or later. So this audit
found no live wrong-VALUE bug — the finding is that the architecture is
sound today only by pass-ORDERING DISCIPLINE, not by construction, which is
exactly gate 5's complaint ("a shared mutable bag" that the next edit can
silently misuse).

The one place this audit's own evidence corrected the task brief's premise:
the brief named `narrowSignatures` as `paramReps`'s last producer. Tracing
every `materializeVariant({..., paramReps, ...})` call site
(`variant.js:95-113` writes `paramReps.set(cloneName, cloneReps)` whenever
`paramReps` is passed) shows FOUR more writers after `narrowSignatures`
returns: `specializeBimorphicTyped` (round 2, unconditional),
`specializeValKindDichotomy` + `speculateTypedParams` (round 3, both
`optimizing()`-gated), and **`specializeUnionCursorParams`**, which is not
called from `plan()` at all — its one call site is `src/compile/index.js:2556`
(`unionClones`, inside `analyzeFuncForEmit`'s post-`plan()` batch), an
off-limits file per this slice's own scope. `paramReps`'s true lifecycle
therefore spans TWO pipeline stages (PLAN, closed at round 3; EMIT, reopened
by union-cursor specialization for newly-materialized clone functions only)
— "one documented producer phase" holds for PLAN's own contribution but not
for the whole program run. This is reported, not papered over: the freeze
below protects the portion this slice can reach (plan()'s own rounds 4-5 +
`solveRepresentationBoundaries`) and hands back the live, mutable Map,
unwrapped, before `plan()` returns, so the EMIT-phase writer is unaffected.
`callSites` has no such second stage (7.1) and is frozen for good.

### 7.3 Why the mechanism is a plain read-only view, not `Proxy`/`Object.seal`

`src/compile/plan/index.js` and everything it imports (`program-facts/*.js`,
`narrow.js`, `variant.js`) are reachable from `scripts/self.js` →
`src/compile/index.js` → `plan()`, i.e. part of the self-hosted kernel's own
module graph — this slice's code is itself compiled BY jz when building
`dist/jz.wasm`, not just run by it. Three subset limits, grep-verified before
picking a mechanism (the wrong pick would either silently no-op or break the
kernel build outright):

- **No `Proxy`.** `src/session-views.js:12-13`: "jz registers no Proxy global
  at all, in any module/*.js"; `src/ctx.js:173-175` (`registerName`'s own doc):
  "Proxy traps aren't in the self-compilable subset." A throw-on-write Proxy
  wrapper is not merely costly here, it is inexpressible.
- **`Object.freeze` is a no-op under self-host.** `module/object.js:294-299`:
  "Object.freeze: identity passthrough — jz objects have no per-property
  [protection]"; `src/compile/function-plan.js:135` names the exact same
  asymmetry as an ALREADY-ACCEPTED tradeoff elsewhere ("logical deep
  immutability in native JS and the self-compile, where Object.freeze is
  identity"). Freezing `callSites` (7.1) is real under native `node
  test/index.js` and inert-but-harmless self-hosted — matching
  `call-target-index.js`'s own precedent (`Object.freeze({resolveMember})`,
  already shipping), not a new risk.
- **`Object.seal`/`Object.preventExtensions` are not implemented at all** —
  zero registrations anywhere in `module/*.js` (grep-verified). Calling
  either from kernel-reachable code risks an outright self-host compile
  failure (the `Object.defineProperty` precedent at `module/object.js:745-746`
  shows an unregistered-shape builtin becomes a hard `err(...)`), so
  `programFacts`'s "closed shape" (7.1's `callTargets` row) cannot be
  enforced via seal.

The chosen `paramReps` mechanism — a plain frozen object exposing only
`{ get }` — sidesteps all three: it needs no Proxy trap and no freeze
semantics, because its protection comes from ordinary property lookup (a
caller reaching for `.set` finds no such method and gets a plain "not a
function" TypeError) — identical behavior natively and self-hosted, and the
same idiom `call-target-index.js` already proves self-hostable
(`Object.freeze({resolveMember})`). `programFacts`'s shape check is a
`DBG_INVARIANTS`-gated `Object.keys(programFacts)` allowlist scan (`Object.keys`
IS implemented, `module/object.js:429`) — mirrors the existing
`assertValKindConsistent`/`assertMidCompile` convention
(`narrow.js:2891` etc., `session-views.js:43-46`) exactly: opt-in via
`JZ_DEBUG_INVARIANTS=1`, zero cost when unset, real value in dev/CI.

Implementation follows in `src/compile/program-facts/freeze.js` +
`src/compile/plan/index.js` call sites (this slice's own commits).
