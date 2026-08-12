# ctx.func decomposition survey (CompileSession campaign opener; re-audit
item 11; session-survey ruling's slice (d) gate)

READ-ONLY inventory for the coordinator to design FROM. No design decisions
here — census, lifecycle, ownership, cost/risk/payoff per candidate
sub-record, and a first-slice NOMINATION (not a ruling) only. FINDINGs
flagged inline. Method: a node script (kept at
`/private/tmp/.../scratchpad/census.mjs` for this session, not checked in)
grepping every `ctx.func.<field>` occurrence across `src/` + `module/` +
`index.js` (test/scripts excluded, same scope as session-survey.md),
classifying each occurrence as a write (`=` not `==`/`===`, compound-assign,
`.push/.set/.add/.delete/.clear/.splice(`, computed-member `[...] =`, or
`++`/`--` — the last counted as BOTH a read and a write, since it's a
read-modify-write) or a read otherwise. Regex-based; treat per-site counts
as ±low-single-digits, aggregate shape as reliable — same disclaimer
session-survey.md made for its own census.

## 0. Headline finding — `ctx.func` is two subtrees wearing one name

session-survey.md §5 already caught this exact shape for `ctx.transform`
("SESSION-shaped user opts... alongside per-node counters... itself two
subtrees wearing one name"). The same pattern exists in `ctx.func`,
independently confirmed by this census:

- **The function REGISTRY** — `list`, `names`, `map`, `multiProp`,
  `exports` — compile-lifetime (reset once by `ctx.js`'s own `reset()`,
  never by `enterFunc`), append-only through prepare + `compile/variant.js`'s
  specialization mint. Answers "which functions exist in this program."
- **The ACTIVE FRAME** — `current`, `body`, `locals`, `boxed`, `localReps`,
  `uniq`, … (60 of the 65 fields) — function-lifetime, reset per
  `enterFunc`/per-caller. Answers "what is true of the ONE function
  presently being lowered."

Both live under `ctx.func.*`, so `ctx.func.current` (the active frame's
signature) and `ctx.func.list` (every function ever) read as siblings when
they are different LIFECYCLES entirely. This is not cosmetic: it's why the
registry's natural owner is a compile-scoped **FunctionRegistry** (same
shape as `ctx.schema.list`/`ctx.module`, sibling subtrees today), while the
frame's natural owner is a function-scoped **push/pop frame value** (see §2).
Any decomposition that keeps calling both halves `ctx.func` reproduces the
naming collision session-survey already flagged for `transform`.

## 1. Field census

**65 real fields** (2 grep false positives excluded: `ctx.func.X` is inside
a comment string in `src/compile/emit-assign.js:933`; `ctx.func.valTypes` is
a stale reference inside `index.js:18`'s own header-comment prose — no such
field exists in `ctx.js`'s `reset()`). **457 write-site occurrences, 905
read-site occurrences**, 47 touching files (21 write at least one field, 26
read-only).

FINDING: session-survey.md's own §1 aggregate table cites **410 write-sites
/ 40 files** for the `func` subtree. This census finds 457/47. Both counts
are regex-based and both surveys flag ±low-single-digit per-site fuzziness,
but the gap here is structural, not noise: (a) **7 new files** have landed
`ctx.func` touches since session-survey's 2026-08-09 snapshot —
`compile/variant.js` (FunctionVariantPlan, landed 2026-08-11),
`compile/closure-plan.js` (ClosureEnvPlan, landed per closure-plan-design.md
2026-08-10), `abi/string.js`, `kind-traits.js`, `param-reps.js`, plus `ctx.js`
itself (its own `reset()`/`assertCtxInvariants`/`err()` touches, which
session-survey's importer-census correctly excluded since ctx.js isn't an
"importer" of itself — but they're still real write/read sites for a
field-level census); (b) session-survey's per-file regex likely undercounted
the `ctx.func.uniq++` idiom (129 sites, the single largest field by
occurrence — see §2) and computed-member writes (`ctx.func.exports[name] =
…`, 18 sites) the way this census's refined classifier catches them. Not
chased further — same "stable to within expected regex variance, not worth
chasing" verdict session-survey reached for its own ctx-importer count
(§1's FINDING there).

### 1a. Per-field table (W=write-sites, R=read-sites, bucket = §2's ownership grouping)

```
FIELD                        W    R   BUCKET            LIFECYCLE
list                         3  124   FunctionIdentity  compile (reset() only)
names                        7   37   FunctionIdentity  compile
map                          5   70   FunctionIdentity  compile
multiProp                    1    4   FunctionIdentity  compile
exports                     12   22   FunctionIdentity  compile
name                         0    2   FunctionIdentity  compile (read-only alias into current.name-ish use)
current                      8   51   BodyContext       function (enterFunc)
body                         1   32   BodyContext       function (enterFunc)
uniq                       129  132   BodyContext       function (enterFunc; ++ idiom, 128/129 W-sites)
stack                        5   21   BodyContext       function (enterFunc)
exported                     1    3   BodyContext       function (enterFunc)
pendingLabel                 5    0   BodyContext       function (enterFunc)
inTry                        5    2   BodyContext       function (manual save/restore, nested-safe)
finallyStack                 4    4   BodyContext       function (manual save/restore, nested-safe)
atModuleScope                2    1   BodyContext       function (wat/assemble.js buildStartFn save/restore)
locals                      92   62   AnalysisFacts     function, CALLER-DIVERGENT (§2)
boxed                        8   64   AnalysisFacts     function, CALLER-DIVERGENT
localReps                   12   99   AnalysisFacts     function, CALLER-DIVERGENT
cellTypes                    3    4   AnalysisFacts     function, CALLER-DIVERGENT
flatObjects                  6   17   AnalysisFacts     function, CALLER-DIVERGENT
sliceViews                   2    2   AnalysisFacts     function, CALLER-DIVERGENT
leanHashLocals                5    2   AnalysisFacts     function, CALLER-DIVERGENT
i32HashLocals                 5    5   AnalysisFacts     function, CALLER-DIVERGENT
leanHashDomains                5    3   AnalysisFacts     function, CALLER-DIVERGENT
hoistTempDefs                 3    1   AnalysisFacts     function, CALLER-DIVERGENT
preboxed                      7    4   AnalysisFacts     function, mixed
localTypedElemsOverlay        4    5   AnalysisFacts     function (pass-scoped overlay)
localValTypesOverlay          26   11   AnalysisFacts     function (enterFunc + pass-scoped overlay)
repsFrozen                    11    1   AnalysisFacts     function (enterFunc + FunctionPlan freeze flag)
refinements                    4   25   AnalysisFacts     function (enterFunc; flow-sensitive)
localProps                     5    5   AnalysisFacts     function (enterFunc)
directClosures                 6    9   ClosureState      function (enterFunc)
closureAux                     3    2   ClosureState      function (enterFunc; "emission state, not analysis" per its own comment)
boxedResult                    2    4   ClosureState      function (enterFunc, overridden post-hoc by emitClosureBody)
valResult                      2    0   ClosureState      function (enterFunc)
mixedAtomReturn                2    4   ClosureState      function (enterFunc)
zeroInitSeen                   2    1   EmissionScratch   function (enterFunc)
maybeNullish                   1    5   EmissionScratch   function (enterFunc)
ternaryBoxedNames              1    5   EmissionScratch   function (enterFunc)
charDecomp                     7    7   EmissionScratch   function (enterFunc, drained by emitFunc's path only)
charDecompGlobals              2    2   EmissionScratch   function (enterFunc)
concatBufs                     4    3   EmissionScratch   function (enterFunc)
probeHoist                     3    2   EmissionScratch   function (enterFunc)
lenHoist                       2    2   EmissionScratch   function (enterFunc)
flowValBlocked                 2    2   EmissionScratch   emit (transient dispatch)
globalDevirt                   1    3   EmissionScratch   plan-phase (single write, plan/scope.js)
p1Predicted                    1    2   EmissionScratch   analyze-phase (single write)
_arrayLiteralNeverEscapes      6    8   EmissionScratch   emit (transient dispatch)
_expect                        3   11   EmissionScratch   emit (transient dispatch)
_schemaSpecSlow                2    4   EmissionScratch   emit (manual save/restore, confirmed prevSlow/finally)
_selfAccumConcat               3    2   EmissionScratch   emit (manual save/restore, confirmed prevSA/finally)
_ccBody / ccInBounds          1/1  1/1  AdHocMemo         PERSISTS across enterFunc — body-identity memo
_aiBody / aiInBounds/aiLitBounds  1/1/1 1/1/0 AdHocMemo    PERSISTS across enterFunc — body-identity memo
_ipBody / ipRanges / ipProven  1/2/1 1/0/1 AdHocMemo      PERSISTS across enterFunc — body-identity memo
_constPropAliasBody / _constPropAliases  1/1  1/1 AdHocMemo  PERSISTS across enterFunc
_boolEagerBody / _boolEagerValue  1/1  1/1  AdHocMemo      PERSISTS across enterFunc
_typedBundleBody / _typedBundleGuards  1/2  1/1  AdHocMemo  PERSISTS across enterFunc
```

## 2. Ownership buckets (the decomposition's raw material)

Six buckets, evidence-derived (not the task prompt's four guessed at
face value — the real fields sorted differently once traced). Every one of
the 65 fields assigned to exactly one bucket; W/R sums below reconcile
exactly to §1's 457/905 totals.

**FunctionIdentity** (6 fields, W=28 R=259, 4 write-files: prepare/index.js,
compile/plan/scope.js, compile/index.js, compile/variant.js). The compile-
lifetime registry — "which functions exist." Natural owner: a compile-
scoped **FunctionRegistry**, sibling to `ctx.schema`/`ctx.module`, NOT
part of the active frame at all (§0). **Already substantially
consolidated**: `compile/variant.js` (landed 2026-08-11, architecture
re-audit item 10) is a real precedent — it centralized what used to be 5
independent `ctx.func.{list,map,names}` mint sites (one per specialization
analysis) into ONE mechanism function. The registry's write surface is
smaller and more disciplined than its 259 read-sites suggest.

**BodyContext** (9 fields, W=160 R=246, all in `enterFunc`'s own 23-field
reset list except `inTry`/`finallyStack`/`atModuleScope`, which are
independently save/restored — confirmed by reading their call sites,
`prev`/`finally` pattern each time). "What function/body am I lowering
right now" — the frame's own identity + control-flow bookkeeping.
`uniq` alone is 129 of the 160 writes, ALL the same idiom
(`` `${tag}${ctx.func.uniq++}` `` — mint-a-fresh-temp-name), confirmed by
grep: 128 of 129 write occurrences are the postfix-increment form, one file
each touch, one line each. High occurrence count, near-zero structural
complexity — this field is mechanically the cheapest of the whole census to
migrate (single scalar, single idiom, no aliasing).

**AnalysisFacts** (16 fields, W=198 R=310, ~10 write-files headed by
`narrow.js`, `compile/index.js`, `wat/assemble.js`, `reps.js`, `module/*`).
The per-function type/rep WORKING SET — `locals`, `boxed`, `localReps`,
`cellTypes`, `flatObjects`, `sliceViews`, the 3 lean/i32-hash Sets/Maps,
`hoistTempDefs`, `preboxed`, the 2 pass-scoped overlays, `repsFrozen`,
`refinements`, `localProps`. **This is the bucket session-survey.md's §2
`func`-subtree entry was already warning about** ("every pass that lowers
or analyzes one function necessarily writes here... any phase view exposing
`func` either has to be the FULL mutable frame or the refactor has to first
decompose `func` itself") — confirmed here at field granularity: it's
promiscuous WITHIN itself too, not just across the whole `func` subtree.
Natural owner: **NOT a fresh record** — `src/compile/index.js:2401`'s
`funcFacts` (a `Map<func, facts>`, populated by `analyzeFuncForEmit`) is
ALREADY the frozen, function-keyed store most of these fields mirror at
emission time (see §3 — `emitFunc` reads `locals`/`boxed`/`cellTypes`/
`flatObjects`/`sliceViews`/`localReps`/`leanHash*` straight OFF `funcFacts`,
not from scratch). `repsFrozen` is literally the FunctionPlan freeze flag
(`"FunctionPlan freeze: body emission begins"`, compile/index.js:1598) —
the DBG-enforced freeze research.md's Stage-2 entry already names
("FunctionPlan frozen with DBG enforcement — updateRep throws when
frozen"). **ctx.func's copy is a working-register cache of `funcFacts`,
not an independent source of truth** for most of this bucket — the
decomposition question for AnalysisFacts is closer to "stop double-storing
what `funcFacts` already owns" than "invent a new sub-record."

**ClosureState** (5 fields, W=15 R=19, 2 write-files: compile/index.js
(enterFunc + emitClosureBody's post-hoc override) and compile/emit.js).
`directClosures`, `closureAux`, `boxedResult`, `valResult`,
`mixedAtomReturn` — closure-specific emission facts. Natural owner: a
sibling record to the ALREADY-LANDED `src/compile/closure-plan.js`
(`ClosureEnvPlan`, audit-#18 item 1, a frozen pre-emission fact keyed on
the closure arrow's body node — same idiom as `loopPlanLink`). Today these
5 fields and `ClosureEnvPlan` are two separate closure-fact homes that
don't know about each other — a real seam the closure-plan.js landing
created without reconciling.

**EmissionScratch** (15 fields, W=40 R=59, scattered — mostly
`compile/emit.js`, some `compile/index.js`/`module/*`/`compile/plan/*`/
`compile/analyze.js`). Transient, single-dispatch-or-nested-emit-local
bookkeeping — string/char-decomposition specializations
(`charDecomp`/`concatBufs`/`ternaryBoxedNames`/`zeroInitSeen`/
`maybeNullish`), hoist scratch (`probeHoist`/`lenHoist`), a handful of
single-write-site analysis outputs (`globalDevirt`, `p1Predicted`), and
confirmed manual-save/restore pairs (`_schemaSpecSlow`, `_selfAccumConcat`
— both traced to `prev*`/`finally` blocks, nested-emit-safe by
construction). Natural owner: phase-local, mostly emit-phase; the least
conceptually unified bucket (grab-bag by construction — each field is one
optimization's own private scratch, no shared shape).

**AdHocMemo** (14 fields across 6 memo pairs/triples, W=16 R=12, 4
write-files: `src/type.js` ×3 groups, `src/compile/flow-types.js`,
`src/compile/emit.js`, `module/typedarray.js`). `_ccBody`/`ccInBounds`,
`_aiBody`/`aiInBounds`/`aiLitBounds`, `_ipBody`/`ipRanges`/`ipProven`,
`_constPropAliasBody`/`_constPropAliases`, `_boolEagerBody`/
`_boolEagerValue`, `_typedBundleBody`/`_typedBundleGuards`. Every one is
the SAME hand-rolled idiom, confirmed at each site: `if (ctx.func._xBody
=== body) return ctx.func.xResult; ...compute...; ctx.func.xResult = …;
ctx.func._xBody = body`. **Not reset by `enterFunc` at all** — deliberately
persists across function-frame boundaries, self-invalidating purely by
`===` identity comparison against the CURRENT `ctx.func.body`. Natural
owner: **not `ctx.func` at all** — this is the exact shape of `ir.js`'s
`DOLLAR` Map or `ctx.js`'s own fact-store `WeakMap`s (`bodyFacts` et al.,
keyed on AST-node identity), just reimplemented 6 times by hand as a
single-slot cache instead of a `WeakMap`. See §3 for why this matters more
than its tiny site-count suggests.

## 3. The per-function lifecycle question

**`enterFunc`** (`src/compile/index.js:391-433`) is the single named reset
point, called from exactly 3 sites, and resets 23 of the 65 fields directly
in its own body (the full list: `stack`, `exported`, `repsFrozen`,
`localValTypesOverlay`, `closureAux`, `zeroInitSeen`, `maybeNullish`,
`ternaryBoxedNames`, `refinements`, `pendingLabel`, `uniq`, `current`,
`body`, `boxedResult`, `valResult`, `mixedAtomReturn`, `directClosures`,
`localProps`, `charDecomp`, `concatBufs`, `charDecompGlobals`,
`probeHoist`, `lenHoist`). The other ~11 AnalysisFacts fields
(`locals`/`boxed`/`localReps`/`cellTypes`/`flatObjects`/`sliceViews`/
`leanHashLocals`/`i32HashLocals`/`leanHashDomains`/`hoistTempDefs`/
`preboxed`) are **NOT reset inside `enterFunc`** — each of the 3 callers
resets them ITSELF, immediately around its own `enterFunc` call, and — this
is the load-bearing finding — **from three different data sources**:

1. **`analyzeFuncForEmit`** (line 481's caller) resets them to EMPTY
   (`new Map()`/`new Set()`/`null`) — this is the pass that BUILDS the
   facts from scratch by walking the body.
2. **`emitFunc`** (line 1358's caller) resets them by COPYING from
   `funcFacts.get(func)` — the frozen record `analyzeFuncForEmit` (run
   earlier, over ALL functions) already produced. `ctx.func.locals = new
   Map(funcFacts.locals)`, `.boxed = new Map(funcFacts.boxed)`, etc.
   (compile/index.js:1412-1420).
3. **`emitClosureBody`** (line 1961's caller) resets `locals`/`localReps`/
   the hash Sets/`hoistTempDefs` to FRESH EMPTY (like path 1, not path 2 —
   closures don't go through `funcFacts` at all), then separately seeds
   `boxed`/`cellTypes` from the closure-literal record `cb`
   (`ctx.closure.make`'s output — `cb.boxed`/`cb.cellI32`, a THIRD data
   source), and does so BEFORE calling `enterFunc`, not after (compile/
   index.js:1897-1961 — `repsFrozen`/`locals`/`localReps`/hash-Sets/
   `hoistTempDefs`/`boxed`/`cellTypes`/`preboxed` are all set in the ~50
   lines PRECEDING the `enterFunc` call at line 1961; `boxedResult` is then
   set to `true` in the ~10 lines AFTER it, overriding `enterFunc`'s own
   `false` reset).

FINDING: this 3-way divergence is real evidence for the AnalysisFacts
bucket's "natural owner" question (§2) — the same 11 fields get populated
from three semantically different sources (scratch / frozen-plan-copy /
closure-record-copy) depending on caller, which is exactly the shape you'd
expect if the true owner is a **value object each caller constructs**
(`buildFrame(fromScratch|fromFuncFacts|fromClosureRecord)`) that then gets
bound to the active frame, rather than 11 independently-reset mutable
fields that happen to be reset consistently BY CONVENTION across 3 call
sites today (nothing enforces the 3 callers stay in sync; a 4th future
caller could easily reset a subset and silently leak state from whichever
function compiled last).

**Re-entrancy.** `emitClosureBody` is called from exactly one site
(`compile/index.js:2455-2461`'s `compilePendingClosures`), inside a
`while (bodyIndex < bodies.length)` loop over the LIVE `ctx.closure.bodies`
array (not a snapshot — `bodies` is the same array reference `ctx.closure.
make` pushes onto when a NESTED closure literal is discovered mid-emission
of an outer one). Traced this fully: **`emitClosureBody` is never
JS-call-stack-reentrant** — a nested closure literal encountered while
emitting body N doesn't recursively call `emitClosureBody`, it just
registers a new entry via `ctx.closure.make` and returns; the outer body
finishes emitting completely (with its own full `ctx.func` frame intact)
before the `while` loop's next iteration picks up the newly-appended entry.
No two frames are ever "in flight" on the call stack simultaneously —
`ctx.func`'s mutate-in-place design is safe here TODAY, but only because of
this one call site's worklist discipline, not because anything in
`ctx.func`'s own shape enforces it. `emitClosureBody` does not save/restore
a caller's frame before overwriting `ctx.func.*` — if a future change ever
made closure-body emission genuinely eager/recursive (nested inline
emission rather than deferred-worklist), the frame would clobber silently,
with no assertion to catch it. **This is the concrete, present-day shape of
"the reentrancy limit"** the CompileSession campaign framing gestures at
for `func` specifically (distinct from session-survey.md §3's
`compile()`-level reentrancy blockers, which are about module-scope state
OUTSIDE `ctx` — this one is internal to `ctx.func`'s own mutate-in-place
convention).

**AdHocMemo's own reentrancy shape** (§2) is milder but real: because the
6 memo pairs are single-slot (`_xBody === body ? cached : recompute`), NOT
WeakMaps, a hypothetical reentrant call into the SAME helper for a
DIFFERENT body mid-computation would not corrupt anything (identity
comparison fails cleanly, recomputes, overwrites) — but it WOULD silently
defeat the cache for whichever computation resumes second, an unbounded
"always miss under interleaving" degradation rather than a correctness
bug. Today's flat, non-recursive `analyzeFuncForEmit`/`emitFunc`/
`emitClosureBody` dispatch never triggers this (confirmed: none of the 6
memo functions' consumers appear on any call path that re-enters the same
memo helper before the outer call returns), so it's LATENT, not live.

## 4. Migration cost model

Ranked by write-site count (the FeaturePlan/linkDemand precedent's own cost
driver, per session-survey.md §5's ruling-adopted framing: "cost is
proportional to write-site COUNT, not subtree complexity") — modulated by
read-frequency risk where session-survey.md's slice-(c) AS-LANDED report
already banked a concrete exception to that rule ("here the READ frequency
itself is the cost driver" for hot per-AST-node reads).

| Bucket | W-sites | write-files | Risk | Payoff |
|---|---|---|---|---|
| **AdHocMemo** | 16 | 4 | LOWEST — each memo pair used inside ONE file, mostly one function; zero external readers of the `_xBody`/cache fields (grep-confirmed: no file outside the pair's own defines touches either half). Not hot-path in the abi/bridge sense — each memo GUARDS a hot path (charCodeAt/array-idx bounds proofs), it isn't itself called per-node. | Closes research.md's open "declared invalidation" item, generalized past its named ~31 `analyzeBody` sites to this class; converts §3's LATENT reentrancy-thrash hazard into a structural non-issue (a `WeakMap` keyed on body never thrashes under interleaving, self-invalidates by construction) — the AdHocMemo→WeakMap swap is byte-identical BY CONSTRUCTION (same cache-or-recompute semantics, same trigger condition, just correct under a hazard that's never fired yet). |
| **ClosureState** | 15 | 2 | LOW-MODERATE — small write surface, but `boxedResult`'s post-`enterFunc` override (§3) and `directClosures`' dual-populate (enterFunc's `directClosures` param AND emit.js's own later writes) mean the migration must preserve TWO write orderings, not one. | Reconciles the ClosureEnvPlan (`compile/closure-plan.js`) / ctx.func closure-field split §2 flagged — a real, currently-open seam from the most recent closure-plan landing, not a hypothetical. |
| **FunctionIdentity** | 28 | 4 | LOW — already funneled through `compile/variant.js`'s mint mechanism (1 of 4 write-files) plus `prepare/index.js` (population) and `compile/plan/scope.js` (1 site); 259 read-sites but reads of a compile-lifetime registry don't need touching if the new record keeps field names, only the OWNING object moves. | Mostly hygiene/documentation — closes §0's naming collision (registry vs. frame under one name) rather than a live bug. Matches session-survey.md §2's "already-disciplined" shape more than its "promiscuous" one, once separated from the frame. |
| **BodyContext** | 160 | ~6 (dominated by `uniq`'s single-idiom 129) | LOW-MODERATE — high raw count but mechanically flat: `uniq` alone is 129/160 writes, all one idiom, one field, no aliasing; the other 8 fields are enterFunc-reset + 3 manual-save/restore pairs, already well-behaved. | Prerequisite plumbing for hardening §3's reentrancy-by-convention into reentrancy-by-construction (an explicit push/pop `FunctionFrame` instead of mutate-the-singleton) — same "prerequisite, not the fix itself" framing session-survey.md gave slice (a). |
| **EmissionScratch** | 40 | ~8, scattered | MODERATE — grab-bag bucket by construction (§2), no shared shape to exploit; migration is 15 independent small moves, not one mechanism. | LOW — mostly bookkeeping hygiene; no audit finding traced to this bucket specifically in this session. |
| **AnalysisFacts** | 198 | ~10 | **HIGHEST** — narrow.js's fixpoint and emit.js's per-node dispatch both read `localReps`/`locals`/`boxed` on hot paths (kind.js's `valTypeOf`, type.js — the same per-AST-node read-frequency caution slice (c)'s AS-LANDED report banked for `abi`/`bridge`). This is the bucket session-survey.md's own §2 `func` entry already named as needing decomposition BEFORE a view means anything. | Highest — closes the `func`-subtree promiscuity finding directly, is the load-bearing prerequisite for slice (d)'s CompileSession record. But §2's `funcFacts`-mirror finding narrows the real work: much of this bucket may be a REMOVE (stop double-storing what `funcFacts` already owns) rather than a MOVE, which would change the cost model's shape entirely — worth a dedicated pre-slice audit of `funcFacts`-vs-`ctx.func` field overlap before scoping this bucket's migration, not assumed here. |

Aggregate: AdHocMemo + ClosureState + FunctionIdentity + BodyContext +
EmissionScratch = 259 of 457 write-sites (57%) sit in five buckets whose
individual risk is LOW-to-MODERATE and whose migrations are independently
shippable, byte-identity-gatable slices (same gate shape as slices a/b/c).
The remaining 198 (43%) — AnalysisFacts alone — is where session-survey.md's
"func may need to be DECOMPOSED, not just wrapped" warning actually bites,
and is NOT scoped by this survey (matches the ruling: slice (d) stays
gated).

## 5. First-slice candidate (raw material, not a ruling)

**AdHocMemo is the strongest first-slice candidate**, ranking above even
FunctionIdentity (which session-survey.md's general framing might suggest
as the "obvious" first cut, being the smallest/most disciplined-looking
bucket at a glance):

- **Lowest write-site count (16) among all six buckets**, with the
  narrowest file footprint (4 files, each touching exactly one memo pair)
  — cheaper than FunctionIdentity's 28 by the precedent's own metric.
- **Zero cross-file read contract to preserve** — every one of the 12
  read-sites is inside the SAME file (often the same function) as its
  matching write, unlike FunctionIdentity's 259 reads spread across ~30
  files or AnalysisFacts's 310 across ~20. A `WeakMap` swap changes nothing
  any OTHER file observes.
  = a "read-only facade" in the slice-(c) sense isn't even needed — the
  migration is invisible outside each pair's own module.
- **Direct existing precedent already in the codebase**, not a new pattern
  to invent: `ir.js`'s `DOLLAR` Map, `ctx.js`'s own fact-store `WeakMap`s,
  and `compile/closure-plan.js`/`loop-model.js`'s `WeakMap`-keyed-on-AST-
  identity idiom are all the SAME shape this bucket already wants — the
  slice is "stop hand-rolling it a 7th time," not "design something new."
  Self-host subset-safe by the same precedent (session-survey.md §4:
  `WeakMap` is used elsewhere in ctx.js's own self-hosted portion already).
- **Byte-identical by construction**: `if (cache.has(body)) return
  cache.get(body); ...compute...; cache.set(body, result); return result`
  is semantically identical to today's `_xBody === body` check for every
  case that fires TODAY (single-threaded, non-reentrant call pattern,
  confirmed §3) — the only BEHAVIOR change is the currently-latent
  reentrancy-thrash case, which cannot currently occur (§3's confirmation
  that none of the 6 memo helpers' call graphs re-enter themselves).
- **Real payoff, not just cleanup**: directly generalizes research.md's own
  named-but-unstarted "declared invalidation" REMAINING item (Stage 2) to 6
  more sites, and closes §3's AdHocMemo reentrancy-thrash finding
  structurally rather than leaving it latent.

Runner-up: **BodyContext's `uniq` field alone** (129 of 457 total
write-sites, one file-spanning idiom) — if the coordinator wants the
single LARGEST write-site reduction for the least design risk, extracting
just `uniq` (a monotonic per-function counter, trivially a value returned
by a `nextUniq()` function rather than a raw mutable field) would move
more raw site-count than any other single-field cut in the census, at
BodyContext-bucket risk (LOW-MODERATE), not AnalysisFacts-bucket risk.
Left as the coordinator's call between "smallest bucket, cleanest
precedent" (AdHocMemo) vs. "biggest single-field win" (`uniq` in
isolation) — this survey doesn't rule between them.

## 6. Explicitly out of scope here

Per the ruling that gated slice (d): no design for a `FunctionFrame`/
`FunctionRegistry`/`ClosureEnvPlan`-merge shape is proposed here, no slice
plan, no migration order beyond §5's raw ranking. The `funcFacts`-vs-
`ctx.func` overlap flagged in §4's AnalysisFacts row (whether large parts
of that bucket are a REMOVE not a MOVE) is named as an open question for
whichever future session scopes that bucket specifically, not answered
here — it would change that bucket's whole cost model and deserves its own
census pass over `funcFacts`' actual field list vs. `ctx.func`'s, not a
guess folded into this survey.

## COORDINATOR RULINGS (2026-08-12, binding)
1. The campaign spine: the REGISTRY/FRAME split (the ctx.transform precedent)
   — ctx.funcs (registry: list/names/map/multiProp/exports, compile-lifetime)
   vs ctx.frame (the active function, per-enterFunc). Named that way; the
   split is the slice-(d) prerequisite's actual shape.
2. First slice: AdHocMemo (the nomination ACCEPTED — 6 single-slot memo
   caches → the WeakMap-on-identity precedent; byte-identical by
   construction). Second: uniq extraction (the 129-site idiom → one
   counter object on the frame).
3. AnalysisFacts (198W): NOT a decomposition target — it's a MIRROR of the
   frozen funcFacts Map; the campaign's endgame there is deletion-by-
   redirection (readers go to the store), one reader-family at a time,
   byte-gated. This is what actually kills the ambient-cache audit finding.
4. The emitClosureBody flat-worklist reentrancy convention: make it
   structural during the frame extraction (the frame swap becomes explicit
   push/pop or fresh-frame-per-closure — pick during implementation,
   byte-gated).

## AS-LANDED — Slice 1: AdHocMemo retirement (2026-08-12)

All 6 memo pairs/groups the census found (§1a, §2) converted to WeakMaps
keyed on body identity, living on `getFactStore()` (src/ctx.js) — the exact
precedent §5 nominated (`ir.js`'s `DOLLAR` Map / `ctx.js`'s existing
`mayBeUndefinedTrace`/`mapGetShapedTrace`/`presentValTrace` WeakMaps, all
already housed there for the identical reason: session-owned, kernel
WeakMap→strong-Map lowering makes a bare module-global leak entries across
compiles — audit-#11/#12's own framing, re-confirmed here rather than
assumed). `getFactStore()` gained 8 new WeakMap fields (`aiInBounds` and
`ipProven` each pair with a second field — `aiLitBounds`, `ipRanges` — that
was always populated in lockstep, so 6 memo PAIRS/groups map to 8 fields,
not 6). `resetFactStore()` (called every `beginSession`) already rebuilds
the whole store fresh — no new reset plumbing needed, confirming §4/§5's
"closes the reentrancy-thrash finding structurally" claim: a `WeakMap`
swapped in fresh every session can't thrash under interleaving by
construction, whether or not any caller is currently reentrant.

**Disposition of the 6 caches:**

| cache (was `ctx.func.*`) | new home | file |
|---|---|---|
| `_ccBody`/`ccInBounds` | `getFactStore().ccInBounds` | src/type.js `inBoundsCharCodeAt` |
| `_aiBody`/`aiInBounds`/`aiLitBounds` | `getFactStore().aiInBounds`/`aiLitBounds` | src/type.js `inBoundsArrIdx`/`litBoundArrIdx` |
| `_ipBody`/`ipProven`/`ipRanges` | `getFactStore().ipProven`/`ipRanges` | src/type.js `intervalProvenIdx`/`intervalIdxRanges`/`stampClonedIdxProof` |
| `_constPropAliasBody`/`_constPropAliases` | `getFactStore().constPropAliases` | src/compile/flow-types.js `constPropAliases` |
| `_boolEagerBody`/`_boolEagerValue` | `getFactStore().boolEager` | src/compile/emit.js `boolEagerBody` |
| `_typedBundleBody`/`_typedBundleGuards` | `getFactStore().typedBundleGuards` | module/typedarray.js `typedBundleGuard` |

Every site's cache-or-recompute shape is preserved exactly (`cache.get(body)`
replaces `ctx.func._xBody === body`; `cache.set(body, …)` replaces the
paired field writes). `boolEagerBody`'s cached value is a `boolean`, so its
lookup uses `.has()`/`.get()` rather than truthiness (`false` is a valid
cached result — a truthiness check would have re-scanned every call-free
body forever). Every site that could theoretically see a non-array/absent
`ctx.func.body` (a WeakMap key must be an object) now short-circuits BEFORE
touching the WeakMap, returning the same vacuous answer the old code
produced for that case (empty Set/Map, or `true` for `boolEagerBody`'s
`!calls` default) — none of these guards fire on any path exercised by the
gates below; they exist for construction-safety, not because a real caller
hits them. `ctx.func`'s reset shape (`src/ctx.js` `reset()`) had the
`_ccBody`/`ccInBounds`/`_aiBody`/`aiInBounds` declarations removed (the
other 4 fields were never declared there — lazily created on first write,
confirmed by reading `enterFunc`'s own 23-field reset list, §3); the 6
caches never belonged in the per-function reset shape since they
deliberately persist across `enterFunc`.

**Byte-identity by construction, confirmed, not just asserted**: every
cache-or-recompute call site produces the identical value for the identical
input on every path the gates below exercise (60-case × 3 opt levels,
kernel-parity, full battery, fuzz) — 0 diffs.

**Gates:**

| gate | result |
|---|---|
| 60-case × O0/O2/O3 byte-identity sweep (180 compiles, vs `38b08f19` worktree baseline) | 180/180 identical |
| `node scripts/battery.mjs` (native/O0/O3/dbg/wasi/fuzz/fixpoint/build/kernel/self) | GREEN modulo 1 pre-existing flake (`test/optimizer.js` "typed RMW: one guard covers..." — confirmed byte-identical fail on the unmodified baseline, unrelated to this slice); fuzz 30173 compared, 0 divergence; self 21/21; kernel 2716 pass/6 skip |
| `node test/index.js` (native) | 3419/3427 pass, 2 pre-existing fails (both confirmed on baseline), 6 skip |
| `JZ_DEBUG_INVARIANTS=1` (battery's `dbg` leg) | same 2 pre-existing fails, 0 new |
| `node test/kernel-parity.js` | 3/3 groups, 33/33 assertions, byte-identical WAT at O0/O2/O3 |
| `JZ_TEST_TARGET=jz.wasm node test/index.js` (test:wasm) | 2716/2722 pass, 6 skip, 0 fail |
| `node scripts/build-dist.mjs` ×2 | byte-identical SHA-256 (`dist/jz.wasm` 74605ad2…, `dist/jz.js` f865dabf…) |
| `node test/session-reentrancy.js` | 5/5 (12 assertions) |

**Verdict: LANDED.**

## AS-LANDED — Slice 2: uniq extraction (2026-08-12)

The 128 `ctx.func.uniq++` sites (census: 129 W-sites total, 128 the `++`
idiom — the 129th is `ctx.func.uniq = uniq`, a save/restore assignment at
`compile/index.js:421`, correctly left untouched, not a mint site) now mint
through ONE function: `export function freshId(ctx) { return ctx.func.uniq++
}` (`src/ir.js`, beside `freshLocal`/`temp`/`tempI32`/`tempI64` — the exact
family this belongs to per the survey's own runner-up framing). `freshLocal`
itself now calls `freshId(ctx)` internally instead of touching
`ctx.func.uniq` directly, so the local-minting and bare-id-minting paths
share the one increment point. `freshId` takes `ctx` explicitly (not
`ir.js`'s own module-scope import) so the same function works unchanged at
every call site regardless of whether that site's own `ctx` binding is an
import or a factory parameter (`module/*.js`'s `export default (ctx) => …`
shape).

**One exception, deliberate**: `src/abi/string.js` cannot import from
`src/ir.js` — its own header comment documents why (`src/ir.js` is loaded
transitively FROM `src/ctx.js`, so an `abi/string.js → ir.js` import would
close a real load cycle, reading `LAYOUT.NAN_PREFIX_BITS` before `ctx.js`'s
own `LAYOUT` const is bound; this is why `allocLocalI64`/`allocLocalI32` in
that file already replicate `freshLocal` locally instead of importing it).
`freshId` is replicated there too, as a one-line `const freshId = (ctx) =>
ctx.func.uniq++`, commented as a cycle-safety duplicate of the canonical
`ir.js` definition, not a second mechanism — matching the file's own
existing precedent rather than inventing a new one.

**Site count by file** (128 total, matches the census exactly):

| file | sites |
|---|---|
| src/prepare/index.js | 25 |
| src/compile/emit.js | 33 |
| src/compile/index.js | 5 |
| src/compile/emit-assign.js | 5 |
| src/compile/plan/literals.js | 5 |
| src/compile/plan/loops.js | 4 |
| src/compile/plan/inline.js | 3 |
| src/compile/plan/scope.js | 1 |
| src/ir.js (freshId's own definition site + freshLocal + 2 direct) | 3 |
| src/abi/string.js (cycle-safe local replica) | 3 |
| module/array.js | 11 |
| module/object.js | 12 |
| module/typedarray.js | 8 |
| module/atomics.js | 2 |
| module/collection.js | 8 |

Mechanical by construction: every replacement is the exact substring
`ctx.func.uniq++` → `freshId(ctx)`, applied uniformly (scripted, then
verified with `node --check` on all 15 touched files and a full-tree grep
confirming zero remaining `ctx.func.uniq++` occurrences outside `freshId`'s
own two definitions). The counter sequence is unchanged — same field
(`ctx.func.uniq`), same reset (`enterFunc`'s `uniq: 0`... — actually set via
`enterFunc`'s reset list, §3), same save/restore sites
(`compile/index.js:421`'s `ctx.func.uniq = uniq`, `compile/index.js:1963`
and `wat/assemble.js:243`'s snapshot reads) — all three left untouched, so
every synthetic name downstream is byte-identical.

**Gates:**

| gate | result |
|---|---|
| 60-case × O0/O2/O3 byte-identity sweep (180 compiles, vs `38b08f19` worktree baseline, Slice 1 + Slice 2 combined) | 180/180 identical |
| `node scripts/battery.mjs` | same result as Slice 1's table (re-run against the combined tree) — GREEN modulo the same 1 pre-existing flake |
| `node test/kernel-parity.js` | 3/3 groups, 33/33 assertions |
| `JZ_TEST_TARGET=jz.wasm node test/index.js` | 2716/2722 pass, 6 skip, 0 fail |
| `node scripts/build-dist.mjs` ×2 | byte-identical SHA-256 |
| `node test/session-reentrancy.js` | 5/5 (12 assertions) |

**Verdict: LANDED.**

## AS-LANDED — Slice 3: ProgramFunctions extraction (2026-08-12)

The compile-lifetime registry is now the explicit `ctx.funcs` record:
`list`, `names`, `map`, `exports`, `multiProp`, and `globalDevirt`. The active
analysis/emission frame remains `ctx.func`; it contains none of those fields and
no compatibility mirror. `reset()` creates both records independently, and
`assertCtxInvariants()` pins the registry's full shape. All production readers
and writers, self-host entry readers, and reset-level test harnesses now use the
new authority directly.

This is the coordinator-ruling #1 registry/frame split's first half. It deletes
duplicate ownership rather than adding a facade: prepare/module export swapping,
variant materialization, plan publication, direct-call lookup, emit, optimize,
and assembly all address `ctx.funcs`. `test/session-reentrancy.js` pins both
record separation and fresh-registry behavior across sequential compiles.

**Gates:** `npm test` reaches the same two standing optimizer-shape failures
(3419 pass, 2 fail, 6 skip); no new failure. `test/session-reentrancy.js` 7/7
(18 assertions). `npm run build` ×2 produced byte-identical `dist/jz.wasm`
SHA-256 `e0752988f3f645028159bc06814f3e401b2f4913e047ed5c30545d3f68806954`.
`npm run test:self` passed correctness 21/21 and fresh-instance perf; its warm
compile timing pin was machine-load red in all three rounds (1.039–1.060× vs
1.03 cap), so no performance claim is made from that noisy run.

**Next:** extract the active record / EmitFrame structurally. AnalysisFacts is
still deletion-by-redirection into `funcFacts`, per ruling #3, not another
record to move wholesale.

## AS-LANDED — Slice 4a: frame-entry ownership pins (2026-08-12)

Before the ActiveFunction/EmitFrame reference-swap, `enterFunc()` now seeds the
previously shape-by-use `p1Predicted` Set on every function and closure entry,
and explicitly clears `hoistTempDefs` with the rest of the frame. The two debug
invariant messages no longer read the nonexistent `ctx.func.name`; their sole
identity authority is `ctx.func.current?.name`.

This closes the two concrete drift findings from the ownership survey without
creating a compatibility field. `test/session-reentrancy.js` proves the P1 Set
is replaced across sequential entries/sessions and that no `name` field appears
on the active frame. `npm test` reaches only the two standing optimizer-shape
failures (3421 pass, 2 fail, 6 skip); debug invariants pass 18/18.

The next frame slice remains structural: one complete active-frame record and
reference swap for nested closure / synthetic `__start` emission, deleting
`buildStartFn`'s selected-field snapshot.

## AS-LANDED — Slice 4b: complete ActiveFunction record + reference swaps (2026-08-12)

`src/compile/active-function.js` is now the one complete constructor for the
active analysis/emission record. `reset()` creates the inactive record through
that constructor. Every real function boundary (`analyzeFuncForEmit`,
`emitFunc`, `emitClosureBody`) installs a fresh record and restores the displaced
record in `finally`; synthetic `__start` does the same.

The old `buildStartFn` selected-field snapshot/Object.assign restore is deleted.
There is no compatibility mirror or second active-field list: production writes
to `ctx.func` identity occur only in `active-function.js` (enter/restore) and
`ctx.js` (session reset). Fields still scoped within one function (flow overlays,
try/finally stack, expression expectations) remain mutations of that active
record rather than pretending to be separate function authorities.

The complete record includes the fields formerly created by use, including
`p1Predicted`, `hoistTempDefs`, `finallyStack`, `flowValBlocked`, expression
scopes, temp/overlay maps, and diagnostic identity through `current`. A debug
post-compile invariant requires an inactive frame, and the reentrancy probe
covers named functions + late nested closures + synthetic `__start`.

Certification:
- `test/session-reentrancy.js`: 10/10, 27 assertions (also under debug invariants)
- `test/closures.js`: 110/110, 221 assertions (also under debug invariants)
- `test/statements.js`: 202/202, 468 assertions
- `test/invariants.js`: 18/18; debug 18/18
- `npm test`: 3423 pass, only the two standing optimizer-shape failures, 6 skip
- kernel oracle: 13/13, 541 assertions
- kernel parity: 3/3, 33 assertions
- build twice: byte-identical; `dist/jz.wasm` SHA-256
  `63ef4ce18f359c37f0184df63f593f9938a037b9ab67e4fe97f97961f4efe9de`
- self-host correctness/warm reuse: 21/21, 206 assertions

## AS-LANDED — Slice 4c: authoritative frozen FunctionPlan (2026-08-12)

`src/compile/function-plan.js` turns `analyzeFuncForEmit`'s existing return seam
into an explicit record. Each prepared function publishes exactly once into the
session-owned `ctx.plans.functions` WeakMap. `analyzeStructInline` and
`analyzeUnionInline` now read that authority directly; the local `funcFacts`
map is deleted. `emitFunc` resolves the plan by function identity and installs
deep mutable working copies into the ActiveFunction record.

The published record owns locals, local reps, boxed/cell facts, flat/slice and
lean-hash facts, typed element/length facts, CSE bases, and distinct-param facts.
Its object is frozen; every mutable Map/Set and every Set-valued rep field is
detached through the established `cloneRep` discipline both at publication and
at emission install. Emission can mint locals or adjust working reps without
rewriting plan truth. Missing or duplicate publication is an internal error.
Closures remain on their dedicated analyze+emit lifecycle for now; `__start`
remains an explicit synthetic ActiveFunction because its module-init units
interleave analysis and emission.

Certification:
- `test/session-reentrancy.js`: 11/11, 30 assertions (also debug invariants)
- `test/closures.js`: 110/110, 221 assertions
- `test/invariants.js` debug: 18/18, 31 assertions
- `npm test`: 3425 pass, only the two standing optimizer-shape failures, 6 skip
- kernel oracle: 13/13, 541 assertions
- kernel parity: 3/3, 33 assertions
- build twice: byte-identical; `dist/jz.wasm` SHA-256
  `57f14eb5aa04201fc6e49ab541381afcd7ad86eaefcccbe0394b1d77ff13fdbc`
- self-host correctness/warm reuse: 21/21, 206 assertions
