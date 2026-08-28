# analyzeBody traversal map (pipeline-minimality slice)

Inventory of every traversal over a function body in `src/compile/analyze.js`
(3,301 lines) and `src/compile/analyze-scans.js` (1,438 lines), before any
split/fusion/retirement. Written first and committed standalone so a restart
loses no analysis. Drives the module split (step 2), fusion candidates (step
3) and walker retirements (step 4) of this slice.

Related prior art, already read, not re-derived here:
- `.work/walk-count-design.md` §1 ("Site 1 — analyzeBody's 8 traversals") did
  the same dependency analysis for analyzeBody's OWN sub-passes back when
  there were 8; §1.3's conclusions are cited inline below where still
  relevant. Its Sites 2-3 (index.js re-derivation, plan/index.js re-runs) are
  a different part of the pipeline — out of scope here, not re-litigated.
- Commit `200baa26` (`refactor/pipeline-minimality`, unmerged sibling
  branch) retired several of analyze.js/analyze-scans.js's hand-rolled
  walkers onto `walkAst`. Its own claim ("378/378 corpus rows unchanged") was
  checked against a narrower corpus (bench+examples only, O0/O2/speed, no
  O3, no kernel-parity, no watr) than this slice's oracle (140 specs ×
  O0/O2/O3/size). Per the orchestrator, the wider oracle shows drift in
  74/560 entries somewhere in that commit's 19-file diff — cause not
  isolated to analyze.js/analyze-scans.js. Its diff for THOSE TWO FILES
  (reproduced in full below) touches exactly 7 traversals, all of the same
  mechanical shape (pre-order recursive walk → `walkAst({enter})` with
  `return false` standing in for the old `if (!Array.isArray) return` + a
  no-further-recursion guard). Each is evaluated on its own merits below,
  independently re-verified against THIS session's oracle rather than
  trusted from the commit message.

## Part 1 — `src/compile/analyze.js` (3,301 lines)

### 1.1 `analyzeBody(body)` — lines 231-874 (644 lines)

The main per-function fact-collection entry, cached in `getFactStore().bodyFacts`
keyed by body identity (freshness gated by `sigFingerprint`, see 907-912).
Contains ONE hand-written walk (`walk`, 676-798, called once at 807) plus
five more full-body passes run back-to-back after it, inside the
`withFunctionField` overlay (804-832):

| # | call | line | descends into `=>`? | gated? |
|---|---|---|---|---|
| 1 | `walk(body)` | 807 | no (`if (op === '=>') return` at 679) | no |
| 2 | `stampCoInductionRanges(body)` | 813 | no (own walk, analyze-scans.js) | no |
| 3 | `widenLocalTypes(body, locals)` | 814 | conditionally (only if `nestedNames.size`, see below) | no |
| 4 | `narrowUint32(body, locals)` | 819 | no (closures ban the name instead) | no |
| 5 | `scanNumericFill(body, ...)` | 831 | no (delegates to `scanBindingUses`, closure-safe by construction) | no |
| 6 | `scanObjectArrayFacts(body)` | 847 | no (delegates to `scanBindingUses`) | `doSchemas` |

This is already down from the 8 counted in `walk-count-design.md` §1.1 (dated
2026-08-17) — #6 above is the FUSED replacement for what were three
separate calls (`scanFlatObjects`/`scanSliceViews`/`scanNeverGrown`), landed
per that doc's own "clearest, lowest-risk fusion target" recommendation
(analyze-scans.js:698-720 doc comment cites it as "walk-count design A1").
**That fusion is prior art, not something this slice needs to redo.**

Order dependencies (from `walk-count-design.md` §1.3, still accurate):
- `walk` → `widenLocalTypes`: genuine data dependency (`locals` map `walk`'s
  `processDecl` populates). Cannot reorder.
- `widenLocalTypes` → `narrowUint32`: genuine, documented ("Runs post-widen
  so a local already demoted to f64 above is reconsidered with final
  types"). Cannot reorder.
- `stampCoInductionRanges`: must precede `widenLocalTypes` (stamps ranges
  Pass D's bare-escape check reads) but does NOT consume `walk`'s output —
  independent AST re-derivation. Repositionable, not fusable with `walk`
  (different node-kind selection — see 2.14).
- `scanNumericFill`: needs `valTypes` (available right after `walk`, inside
  the overlay) but nothing from `widenLocalTypes`/`narrowUint32`. Its
  current tail position is "candidate accretion" per the design doc, not a
  proven need — repositioning doesn't reduce walk COUNT though, only order,
  so out of scope for a fusion-counting slice.
- `walk` → `widenLocalTypes` → `narrowUint32` full fusion into one dispatch
  pass: the design doc calls this "a materially bigger and riskier change"
  needing an internal fixpoint — **declined here** for the same reason (see
  §3 Fusions declined, in the final report).

`walk` itself (676-798): single hand-recursion, `if (!Array.isArray(node))
return; if (op === '=>') return`. Visits every node depth-first, pre-order,
with special-cased handling for `let`/`const` (walks only the RHS, never the
`=` node itself — deliberate, documented at 699-701), `return`, `()` (arg
escape marking), `arr.push(...)`, index-write, plain `=`, compound-assign,
`for`/`for-in`/`for-of` (escape-marks the iterated collection), array/object
literals (spread escape marking), and `[]` index reads. Produces 9 of
`analyzeBody`'s 10 result-object fields in one pass: `locals`, `valTypes`,
`arrElemSchemas`(+Sets), `arrElemValTypes`, `arrElemTypedCtors`, `typedElems`
(+Lens), `escapes`. Consumers: every later analyze/narrow/emit pass that
reads `ctx.func.localReps`/`.locals` (dozens; see `program-facts.js`,
`narrow.js`, `index.js`, `emit.js`).

`widenLocalTypes(body, locals)` (950-1050) is itself FOUR internal
sub-traversals, not one:
- Pass A `widenPass` (976-988) — one walk, descends into `=>` only if
  `nestedNames.size` (closures that reassign an outer local, computed by
  `findMutations` at 965 — a separate whole-body walk from
  analyze-scans.js).
- Pass B `recheck` fixpoint (993-1027) — a `while (widened)` loop, each
  iteration a fresh full walk (`recheck(body)` at 1026); same conditional
  `=>` descent as Pass A.
- Pass D (1043-1049) — no walk of its own; consumes `collectBareEscapes`
  (analyze-scans.js, a full walk) only when `level1I32` is true (a scan over
  the ALREADY-COMPUTED `intLevels` map, not the AST).
- Plus three more full-body helper walks called for their return values
  before the passes run: `collectI32SafeIndexVars` (951, itself 3 internal
  passes — see 2.11), `findMutations` (965), `intLevelMap` (973, lives in
  `type.js`, out of scope), `collectF64StridedIndexVars` (974).

So `analyzeBody`'s TRUE traversal count, counting every full-body descent
transitively (including analyze-scans.js's contributions, excluding
type.js's `intLevelMap`/`exprType` since those are a different file's
concern), is **13**: walk, stampCoInductionRanges (+4 sub-helpers, see 2.14),
collectI32SafeIndexVars (3 passes), findMutations, collectF64StridedIndexVars,
widenPass, recheck (≥1×, fixpoint), collectBareEscapes (conditional),
narrowUint32, scanNumericFill (+ numFillSafe per candidate name),
scanObjectArrayFacts (fused, 1 shared walk).

### 1.2 `analyzeValTypes(body)` — lines 1444-1892 (449 lines)

One hand-written walk (`walk`, 1596-1854, called once at 1856), pre-order,
descends into `if`/`?:`/`&&`/`||`/`??`/loops/`try` with a `cond` flag
threaded (conditional-position tracking for the BIGINT-param-write poison
rule — see 1843-1847) but **does not descend into `=>`** (1599). Calls
`analyzeBody(body)` first (1484) to reuse its facts (arrElemSchemas etc.) —
a real data dependency, not a redundant walk (facts are read, not
recomputed). Populates `ctx.func.localReps` (`val`, `presentVal`, `nullable`,
`mayBeUndefined`, `presence`, `range`, `schemaId`, `schemaIdSet`,
`jsonShape`, `arrayElemValType`, `dictValueValType`, `mapValueValType`,
`arrayElemSchema`) — the durable representation lattice `narrow.js`/`emit.js`
consult.

Six small per-name helper walks live in this section, called from inside the
main walk for dict/map-shaped candidates only (not run on every body — gated
by `dict`/`vt === VAL.MAP`):
- `dictWalkLean` (1204-1248) — ITERATIVE (explicit stack), by documented
  necessity: the original nested-closure recursive form miscompiled under
  self-host (83d6add5 bisect). Full-body worklist per candidate dict name.
- `dictWalkI32` (1258-1280) — same, iterative, worklist of `[node,parent,
  pos,grand]` tuples.
- `dictDomainOf` (1288-1323) — same, TWO iterative worklist passes.
- `dictValueTypeOf` (1389-1411) — recursive, skips `=>` unless the name is
  bound inside it (shadow check via `collectAllBoundNames`).
- `mapValueTypeOf` (1423-1442) — recursive, same shadow-aware `=>` rule.

`analyzeIntCertain(body)` (1898-1911) is a thin wrapper: no walk of its own,
delegates to `type.js`'s `intCertainMap` (out of scope for this file).

### 1.3 `unboxablePtrs(body, locals, boxed)` — lines 1947-2024 (78 lines)

No traversal of its own — a PURE POLICY over `scanBindingUses(body)`
(analyze-scans.js, §2.4): iterates the returned per-name use summary and
applies `isFreshInit`/use-kind predicates. Zero AST descent here.

### 1.4 `inheritPtrAliases(body, locals, boxed)` — lines 2050-2106 (57 lines)

One hand-written walk (2076-2105, IIFE), pre-order, stops at `=>` (2079),
descends only `let`/`const` declarators otherwise skipped generically (falls
to the generic `for` loop at 2103-2104). Independent of `analyzeBody`'s
walk (different predicate: RHS ptrKind provenance, not val-type).

### 1.5 `cseSafeLoadBases(body, locals, localReps)` — lines 2136-2247 (112 lines)

THREE hand-written full-body walks, sequential, each with a different
node-selection rule (genuinely different traversals, not fusable — see final
report §Fusions declined):
- Pass 1 `collect` (2156-2176) — collects bound-once ptrKind candidates,
  stops at `=>`, special-cases `let`/`const` to walk only initializers.
- Pass 2 `walk` (2182-2219) — verifies every occurrence is a safe read
  receiver; tracks `inClosure` (does NOT stop at `=>`, descends WITH a flag,
  unlike Pass 1) — a real behavioral difference from Pass 1, not just
  cosmetic, so the two cannot share one walker without threading the
  closure flag through Pass 1 too (which would change Pass 1's `declCount`
  semantics — deliberately not attempted).
- Pass 3 `scanStores` (2226-2238) — collects store-target kinds, descends
  everything unconditionally (no `=>` special case — a store inside a
  closure still counts, correctly, since a captured pointer's allocation
  is still reachable).

### 1.6 `analyzeStructInline(programFacts)` — lines 2284-2733 (450 lines)

Whole-PROGRAM analysis (loops `ctx.funcs.list`, not a single body). Per
function: one `collectCursors` walk (2411-2429, stops at `=>`) then one
`verify`/`verifyCall` mutually-recursive walk (2453-2703) with bespoke
per-op-kind rules (return, call, assignment, decl, `.`/`[]` read) and an
explicit `poisonAll` fallback (2320-2341) for anything reaching a `=>`
boundary. Not a generic tree walk — every branch encodes a specific
structInline-legality rule; retiring this onto `walkAst` would lose the
early-return/no-further-descent-into-verified-subtree control flow the
function relies on (e.g. `visitChild` vs. direct recursion choice per op).

### 1.7 `analyzeUnionInline(programFacts)` — lines 2751-3152 (402 lines)

Structurally the mirror of 1.6 for closed heterogeneous unions instead of
single schemas: one `collect` walk (2821-2876, tracks `assigned`/`tagAlias`/
`maskMax`, stops at `=>` but records closure writes via a nested `cw` walk
first, 2825-2829 — TWO walks fused with different jobs at one call site),
then one `verify` walk (2946-3123) additionally threading a `refs`
(discriminant-narrowing) parameter through `if`/`?:`/`;`-sequence nodes —
richer than 1.6's `verify` (needs the refinement lattice for member-set
narrowing). Same conclusion: bespoke, not a generic-walker candidate.

### 1.8 `analyzeFuncNamespaces(ast)` — lines 3191-3300 (110 lines)

Whole-program (walks `ast` top level + `ctx.module.moduleInits` + every
`ctx.funcs.list` body). One `visit` walk (3208-3284), pre-order, tracks
`atInit` (top-level-statement position for constant-fold eligibility).
Escape-vs-callee-position distinction (call callee vs. bare mention) is the
whole point of the function — not reducible to a `some`/`walkAst` predicate.

### Dead code found in analyze.js (not a traversal — noted for step 5)

- Orphaned doc comment at lines 3154-3158 ("Schema id when `name` is bound
  …") documents no function — the code it once described is gone; the very
  next block (3160-3300) is `analyzeFuncNamespaces`'s own unrelated doc.
  Grep-verified dead (no function starts within 5 lines).
- 31 of the ~76 symbols imported into analyze.js are unused anywhere in the
  file (verified: `grep -n '<symbol>'` returns only the import line itself
  for each). Full dead list: from `../ast.js` — `STMT_OPS`, `isBlockBody`,
  `I32_MIN`, `I32_MAX`, `T`, `extractParams`, `classifyParam`,
  `alwaysReturns`, `returnExprs`, `refsName`, `REFS_IN_EXPR` (11); from
  `../reps.js` — `updateGlobalRep`, `lookupValType`, `lookupNotString` (3);
  from `../kind.js` — `jsonConstString`, `shapeOfObjectLiteralAst` (2); from
  `../static.js` — `nonNegIntLiteral`, `constIntExpr`, `NO_VALUE`,
  `staticValue`, `staticObjectProps` (5); from `../type.js` —
  `typedElemCtor`, `scanBoundedLoops`, `inBoundsCharCodeAt` (3); from
  `../../layout.js` — the ENTIRE line is dead: `TYPED_ELEM_CODE`,
  `TYPED_ELEM_VIEW_FLAG`, `TYPED_ELEM_BIGINT_FLAG`, `encodeTypedElemAux`,
  `typedElemAux`, `TYPED_ELEM_NAMES`, `ctorFromElemAux` (7). These do not
  carry forward into the split — each new module imports only what it
  actually calls, which mechanically drops all 31 (see module map, §4).

## Part 2 — `src/compile/analyze-scans.js` (1,438 lines)

### 2.1 `findFreeVars(node, bound, free, scope)` — lines 15-64

Recursive, called per-arrow (not once per body) from `boxedCaptures` and
from `emit.js`/`closure-plan.js` directly. Descends into `=>` (computing a
fresh `innerBound`) and `catch` specially. No caching.

### 2.2 `findMutations(node, names, mutated)` — lines 67-80

Recursive, descends everywhere including `=>` (deliberately — a closure's
own reassignment of a captured name must be seen; this is exactly what
distinguishes it from most other scans here that stop at `=>`). Used by
`boxedCaptures`, `widenLocalTypes` (analyze.js), `narrow.js` (5 call sites),
`loop-model.js`, `wat/assemble.js`.

### 2.3 `boxedCaptures(body)` — lines 86-151

TWO hand-written walks: `collectDecls` (88-95, stops at `=>`, collects the
outer-scope name set) then the main `walk` (124-150, tracks `assignTarget`/
`seen` per block via `';'`/`'{}'`-scoped copies of `seen`). Calls
`findFreeVars`/`findMutations` once per arrow encountered
(`markArrowCaptures`, 99-122) — so its true cost is O(arrows × body size),
not O(body size) — same shape as `analyzeValTypes`'s dict helpers.

### 2.4 `scanBindingUses(body, trackNames)` — lines 225-407

The BIG fused walk. One traversal (`walk`, 274-397), pre-order, threads
`inClosure`; INSIDE a closure every mention becomes a `CAPTURE` use (298-305)
rather than being separately classified — i.e. it still visits closure
bodies (unlike most scans here), just downgrades precision once inside one.
Cached in `getFactStore().bindingUses`, keyed by body identity, no surgical
invalidation (relies on `setFuncBody` always handing a fresh node — see
analyze.js's own cache-seam doc). This is the substrate for FIVE otherwise-
independent per-name POLICIES (not separate walks — see 2.5-2.9): each is
`for (const [name, s] of scanBindingUses(body))` plus a pure predicate over
the returned `[decls, initRhs, uses]` triple.

### 2.5-2.7 `flatObjectCandidate` / `sliceViewCandidate` / `neverGrownCandidate` — lines 513-576, 623-625, 685-690

Policies over `scanBindingUses`'s summary. `flatObjectCandidate` additionally
calls `selfPreservingWrittenKeys` (458-505, its OWN full-body walk, run only
when the candidate has written keys) — so this one policy is NOT walk-free
like the other two. `neverGrownCandidate` (and `scanNeverGrown` itself,
692-696) delegates the real work to `safeReads` (649-680), a SEPARATE
full-body recursive walk per candidate name (default-deny, MEMORY-SAFETY
CRITICAL per its own doc — deliberately self-contained, does not trust
`escapes`).

### 2.8 `scanObjectArrayFacts(body)` — lines 711-720

The already-fused replacement for 2.5-2.7 (walk-count design A1, prior art —
see Part 1 §1.1). ONE `scanBindingUses(body)` loop runs all three
classifications inline. `scanFlatObjects`/`scanSliceViews`/`scanNeverGrown`
(2.5-2.7's public wrappers) stay exported and correct for any direct/test
caller but `analyzeBody` calls only the fused form.

### 2.9 `scanNumericFill(body, isNumericRhs)` — lines 783-790

Policy over `scanBindingUses` + `numFillSafe` (746-781), a SEPARATE full-body
walk per candidate name. **`numFillSafe` is structurally near-identical to
`safeReads` (2.7)** — same call/write/decl escape rules, same `.`/`[]`-read
allowance — differing only in the fill-write arm (753-755) that lets a
proven-NUMBER `a[i]=expr` write through. Flagged as a dedup candidate; not
fused in this pass because their DEFAULT-DENY safety margins are each
independently load-bearing per their own doc comments and a shared
implementation risks silently widening one's tolerance to match the other's
future edits. Recorded, not acted on — see final report's declined list.

### 2.10 `narrowUint32(body, locals)` — lines 810-866

One hand-written walk (823-855), tracks `inClosure` (bans any name touched
inside one, 824), descends into `=>` (831, unlike most scans here — needed
to still SEE closure mentions in order to ban them, same reasoning as
`scanBindingUses`'s CAPTURE rule).

### 2.11 `collectI32SafeIndexVars(body, locals)` — lines 1307-1406

THREE internal traversals plus a fixpoint: `collect` (1322-1335, records
assignment edges, stops at `=>`), `seed` (1367-1374, finds i32-provable
array indices, stops at `=>`), then a non-AST fixpoint loop over `edges`
(1377-1386, no tree descent — iterates the flat edge list), then filters via
`collectBareEscapes` (a fourth, full, separate traversal). Early-exits
entirely (1308) via `some(body, isDynamicIndexNode)` — a `src/ast.js`
generic-combinator call, already NOT hand-rolled — when the body has no
dynamic index at all (the one place in this file already using `ast.js`'s
shared combinators).

### 2.12 `collectF64StridedIndexVars(body, locals)` — lines 1417-1431

One walk (1424-1429), stops at `=>`, same `some(...)` early-exit gate as
2.11.

### 2.13 `collectBareEscapes(body, locals, crossClosure)` — lines 1047-1103

One walk (1050-1100) threading a `mode` ('idx'|'edge'|'value') parameter —
the richest node-classification in this file (7 distinct op-set gates). Not
generic-walker material: the return value of `walk` is irrelevant, only the
`mode` threading and early per-node bailout (`escapeInRangeI32(node)` short-
circuits an entire subtree) matter. `crossClosure` (default false) makes
this the ONE traversal in the file with a caller-chosen closure-boundary
policy: local mode stops at `=>` (1068), module-global mode (used by
`plan/scope.js`'s `inferModuleIntGlobals`, a call site OUTSIDE analyze.js/
analyze-scans.js) descends into it. Calls `collectComparedNames` first
(1049, a full separate walk, 985-998, itself with the same `crossClosure`
duality).

### 2.14 `stampCoInductionRanges(body)` — lines 1273-1304

One outer walk (1274-1302, only inspects `for` nodes with a static-shaped
5-arg form) that, PER QUALIFYING LOOP, calls FOUR more full-(sub)body walks
per mutated name found inside that loop's body:
`collectMutatedNames` (1137-1150), `writesOutsideLoop` (1159-1171, walks the
WHOLE enclosing body minus the loop's own subtree, by reference identity),
`findOuterDeclInit` (1183-1196, ditto), `collectConstStep` (1217-1260, walks
just the loop body, refuses on nested loops/switch/try/`=>` via `refsName`).
Worst case is O(loops × mutated-names-per-loop × body-size) — the most
traversal-heavy single call in `analyzeBody`'s top-level sequence, though in
practice bounded by loop count (rare relative to body size).

### 2.15 `safeReads(node, name)` — lines 649-680

Already covered under 2.7 — listed here too since it is independently
exported and called directly from `program-facts.js` (`import { safeReads }
from './analyze-scans.js'`), not only from `neverGrownCandidate`.

## 3. Traversal count summary

| body | traversals before | notes |
|---|---:|---|
| `analyzeBody` (own + transitively via analyze-scans.js) | 13 | walk, stampCoInductionRanges+4 helpers, collectI32SafeIndexVars×3+collectBareEscapes, findMutations, collectF64StridedIndexVars, widenPass, recheck(≥1), narrowUint32, scanNumericFill+numFillSafe/candidate, scanObjectArrayFacts(fused) |
| `analyzeValTypes` | 1 main + ≤5 per dict/map candidate | dictWalkLean/I32/DomainOf/ValueTypeOf, mapValueTypeOf |
| `unboxablePtrs` | 0 (policy only) | rides `scanBindingUses` |
| `inheritPtrAliases` | 1 | |
| `cseSafeLoadBases` | 3 | collect, walk, scanStores |
| `analyzeStructInline` | 2 per function | collectCursors, verify(+verifyCall) |
| `analyzeUnionInline` | 2 per function (+1 nested `cw`) | collect(+cw), verify |
| `analyzeFuncNamespaces` | 1 | whole-program |
| `boxedCaptures` | 2 + findFreeVars/findMutations per arrow | collectDecls, walk |
| `scanBindingUses` | 1 (shared substrate for 5 policies) | |
| `selfPreservingWrittenKeys` | 1 per flat-object candidate w/ writes | |
| `safeReads`/`numFillSafe` | 1 per candidate name each | near-duplicate pair |
| `narrowUint32` | 1 | |
| `collectI32SafeIndexVars` | 3 + collectBareEscapes | |
| `collectF64StridedIndexVars` | 1 | |
| `collectBareEscapes` | 1 + collectComparedNames | |
| `stampCoInductionRanges` | 1 outer + 4 per mutated name per loop | heaviest single sequence |

**Total distinct hand-written traversal FUNCTIONS across both files: 32**
(counting each named `walk`/`collect`/`verify`/etc. closure once, not its
per-call-site invocation count). This is more granular than the task
brief's "six hand-rolled walkers" in analyze-scans.js — that phrase reads as
this session's rough count of the file's HEADLINE exports
(`boxedCaptures`, `scanBindingUses`, `narrowUint32`, `collectBareEscapes`,
`collectI32SafeIndexVars`, `stampCoInductionRanges`), not the full transitive
count including their private helpers; both readings are recorded here so
the discrepancy is auditable rather than silently reconciled.

Total lines: analyze.js 3,301 + analyze-scans.js 1,438 = **4,739** (the
task's "3,301" figure is analyze.js alone; analyze-scans.js is a pre-existing
separate module, not part of that count).

### Dead code found in analyze-scans.js

- Orphaned doc comment at lines 1434-1438 ("Returns the cached facts object
  directly — DO NOT MUTATE...") documents `analyzeBody`, which lives in
  analyze.js, not this file — describes no function in THIS file and is the
  last thing in it (nothing follows to line 1438, confirmed by `wc -l`).
  Grep-verified dead; likely stranded when analyzeBody's one-line facade was
  inlined away (analyze.js:1920-1922 documents that exact prior removal).

## 4. Module split plan (step 2 — pure moves)

`src/compile/analyze.js` splits into `src/compile/analyze/` along its real
internal seams (verified by usage, not guessed — every cross-file consumer
enumerated via grep before committing to a boundary):

| new file | contents (line ranges in current analyze.js) |
|---|---|
| `analyze/trackers.js` | `makeValTracker` (127-136), `makeTypedTracker` (137-188) — private helpers shared by body-facts.js AND val-types.js, so neither can own them outright |
| `analyze/body-facts.js` | `resetBodyFactsCache` (100), `analyzeBody` (190-874), `sigFingerprint` (876-912), `widenLocalTypes` (914-1050), `invalidateLocalsCache`/`reanalyzeBody`/`setFuncBody`/`invalidateBodies`/`invalidateAllBodyFacts` (1052-1132) |
| `analyze/val-types.js` | `mayBeNullish`/`mayBeUndefinedRhs` (1134-1191), dict/map helpers (1193-1443), `analyzeValTypes` (1444-1892), `analyzeIntCertain` (1894-1911) |
| `analyze/ptr-eligibility.js` | `unboxablePtrs` (1913-2024), `inheritPtrAliases` (2026-2106), `cseSafeLoadBases` (2108-2247) — grouped: all three are per-function pointer/CSE eligibility passes, imported together at every call site (`index.js`'s one import line) |
| `analyze/struct-inline.js` | `analyzeStructInline` (2249-2733) |
| `analyze/union-inline.js` | `analyzeUnionInline` (2735-3152) |
| `analyze/func-namespaces.js` | `analyzeFuncNamespaces` (3160-3300); the orphaned 3154-3158 comment is dropped, not moved |
| `analyze.js` (barrel) | re-exports only — every current external import path (`from './analyze.js'` in narrow.js/index.js/emit.js/closure-plan.js/infer.js/inplace-store.js/program-facts.js) keeps working unchanged. Also keeps its existing `export { findFreeVars, findMutations, boxedCaptures } from './analyze-scans.js'` passthrough verbatim. |

`src/compile/analyze-scans.js` is NOT moved or renamed — it is already its
own well-scoped module with four direct external importers
(`emit.js`, `dyn-closure-tables.js`, `program-facts.js`, `loop-model.js`)
that import from it directly, not through analyze.js's barrel. Moving it
would only add path-churn risk for zero structural benefit; the task's step
2 names only analyze.js for splitting.

Per-file imports are trimmed to what each file actually calls (verified by
grep per symbol, not copied wholesale) — this mechanically drops the 31 dead
symbols noted in Part 1's "Dead code" section; nothing else changes.
