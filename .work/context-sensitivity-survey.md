# Context-sensitivity survey — the carrier flip's final dependency

Read-only survey. Method: temporary probes in `src/compile/narrow.js` and
`src/compile/program-facts.js` (same `typeof process !== 'undefined' &&
process.env?.X` module-scope-flag / `console.error` discipline as
`JZ_DEBUG_HZALL`/`JZ_DBG_SPEC`, §17-§23 of `carrier-representation-design.md`
— proven self-host-safe since `DBG_INVARIANTS`/`DBG2` already use the exact
same pattern in files that are themselves compiled as part of `scripts/
self.js`), run against the real `scripts/self.js` compile
(`JZ_SELFHOST_OPT=0 JZ_DBG_CTXSENS=1 node scripts/selfhost-build.mjs`, ~78s,
`dist/jz.wasm` byte output unaffected — the probes only add `console.error`
calls behind a flag), fully reverted before commit (`git diff` confirmed
empty for `src/` at the end of this session — see the closing note).

**Two probes:**
1. `program-facts.js`'s `collectSlotWriteHazards` → `keyedWrite`'s `hz.all`
   trigger branch (late/post-narrowing mode only): logs the enclosing
   function, the receiver (`obj`) and key names, and their param indices if
   they're bare params of the enclosing function. Tag `CTXSENS_KW`.
2. `narrow.js`'s `mergeRule`'s `val` field (soft, the general per-param kind
   lattice) and the `wasm` field's `apply` rule: for every (calleeFunc,
   paramIdx), records the FINAL resolved value at every distinct call site —
   deduped per call site via a `WeakMap` keyed on the site's own `argList`
   array (stable identity across fixpoint sweeps, so repeated visits during
   convergence overwrite rather than double-count). Dumped once at the end of
   `narrowSignatures`. Tag `CTXSENS_VAL_DUMP`, plus a one-line `CTXSENS_SCALE`
   summary (`funcs`, `totalParamEntries`, `callSitesTotal`).

This is a **ground-truth re-derivation**, independent of §17-§23's own
narrative, using the SAME `inferValAtSite`/`argWasmType` inference the real
fixpoint uses (I hooked the existing call sites, not a reimplementation) —
so it measures exactly what the live lattice sees, not an approximation.

---

## 1. The poisoned population — the PRIZE measurement

### 1a. Whole-program census (all multi-call-site params, `val` and `wasm`)

Scale (`CTXSENS_SCALE`, real compile): **1610 functions**, **2906 tracked
(func,param) entries**, **12710 live call sites** (post `filterLiveCallSites`
reachability filter — `narrow.js:1502`).

Of those 2906 param entries, **1711 (59%) have ≥2 distinct call sites** for
the `val` field (the rest are single-site — trivially "context-sensitive
already," no lattice join ever happens). Classification of those 1711 rows,
by the SAME cause taxonomy the brief asks for:

| Cause | Count | % of multi-site rows | What it means |
|---|---:|---:|---|
| `allUnresolved` | 1113 | 65.1% | `inferValAtSite` returns `null` at **every** call site — the argument expression is unclassifiable, not disagreeing |
| `partialUnresolved-agree` | 233 | 13.6% | some sites unresolvable, but every site that DOES resolve agrees |
| `agree` | 352 | 20.6% | every site resolves, all agree |
| `oneDissenting` (≥1 minority value, minority ≤25% of resolved sites) | 8 | 0.5% | genuine cross-site disagreement, landslide majority |
| `polymorphic` (minority >25%) | 5 | 0.3% | genuine cross-site disagreement, no clear majority |

Total call-site-observations across the 1711 rows: 17056 (min 2, median 3,
p90 15, max 1012 sites per row).

Same classification for `wasm` (1581 multi-site rows — a hard field, `apply`
only instrumented, `missing`-path poisoning not captured, so this
undercounts its own disagreement slightly, noted honestly): **agree 1544
(97.7%)**, `polymorphic` 23 (1.5%), `oneDissenting` 14 (0.9%).

**FINDING (the prize, quantified): genuine cross-call-site disagreement —
the ONLY cause context-sensitivity (per-call-site storage) can fix — is
0.5–2.3% of the multi-site population, not the dominant cause.** The dominant
cause (65–98% depending on field) is **single-site unclassifiability**:
`inferValAtSite`/`argWasmType` cannot resolve the argument's kind at ANY
individual site, so no amount of keeping facts *separate per site* creates
information the inference function itself doesn't produce. This is a
VALUE-INFERENCE-EXPRESSIVITY gap (what §18-§21 call "the census can't see
this," e.g. `Map.get()`'s value kind, property-chain receivers), not a
context-sensitivity gap. Where genuine disagreement DOES occur, it is
overwhelmingly a landslide (examples below) — exactly the shape
`specializeBimorphicTyped` already exploits for the typedCtor case (§3).

Top disagreeing rows by call-site count (both fields; function is the
self-hosted mangled name, `mNN_basename$func`):

```
val:  m78_ir$typed#0        n=1012 resolved=934  {array:932, number:2}
      m82_bridge$wat#1      n=111  resolved=105  {string:101, closure:4}
      m56_ctx$declGlobal#2  n=81   resolved=77   {number:76, string:1}
      m78_ir$mkPtrIR#0..2   n=59   (3 params, each ~95%+ one kind)
      m82_bridge$reg#1      n=34   resolved=34   {array:31, object:3}
wasm: m78_ir$ptrTypeEq#1    n=26   resolved=26   {i32:25, f64:1}
      m50_encode$uleb#0     n=11   resolved=11   {f64:10, i32:1}
      m106_emit$canonArm#1  n=10   resolved=10   {i32:1, f64:9}
```

Every one of these is the SAME shape: one or two outlier call sites among a
large agreeing majority — never a balanced polymorphic split.

### 1b. The §17/§22 keyedWrite receivers/key-idx params specifically

335 `hz.all`-triggering `keyedWrite` sites fired (late mode), across **126
distinct enclosing functions** — in the same 319–498 band §17-§23 measured
across sessions (this session's own drift, unremarkable — same "ordinary
codebase growth" framing those sessions used).

Of those 335 hits, **30 distinct (func, receiver-or-key, paramIdx) triples**
resolve to a bare parameter of the enclosing function (the rest are body
locals, closure-captured names, or non-string receivers — outside this
lever's scope by construction, matching §17's own finding). Of those 30, 20
have ≥2 call sites in the `val` lattice dump (the other 10 have exactly one
static call site, or the site count never reached the ≥2 filter — reported
honestly, not backfilled).

**Exact fraction-of-call-sites-agreeing, cross-referenced by exact param
index (not just function), for every one that has data:**

| Function (self-host mangled) | role | param | sites | resolved | agreement | class |
|---|---|---|---:|---:|---|---|
| `m127_reps$mergeParamFact` | obj | `rep`#0 | 6 | 0 | — | allUnresolved |
| `m127_reps$mergeParamFact` | key | `key`#1 | 6 | 3 | 3/3 = 100% string | partialUnresolved-agree |
| `m82_bridge$wat` | key | `name`#0 | 111 | 110 | 110/110 = 100% string | partialUnresolved-agree |
| `m82_bridge$reg` | key | `name`#0 | 34 | 34 | 100% string | agree |
| `m65_index$addHostImport` | key | `alias`#2 | 3 | 1 | 1/1 = 100% string | partialUnresolved-agree |
| **`m51_util$walkPost`** | obj | `parent`#2 | 3 | 0 | — | allUnresolved |
| **`m51_util$walkPost`** | key | `idx`#3 | 3 | 1 | 1/1 = 100% number | partialUnresolved-agree |
| `m51_util$walkPostN` | obj | `parent`#2 | 10 | 0 | — | allUnresolved |
| `m51_util$walkPostN` | key | `idx`#3 | 10 | 1 | 1/1 = 100% number | partialUnresolved-agree |
| `m49_compile$regtype` | key | `idx`#3 | 4 | 4 | 100% string | agree |
| `m49_compile$name` | obj | `list`#1 | 3 | 0 | — | allUnresolved |
| `m56_ctx$registerGetter` | key | `key`#0 | 10 | 10 | 100% string | agree |
| `m56_ctx$snapshotFeatures` | obj | `into`#1 | 2 | 0 | — | allUnresolved |
| **`m56_ctx$setFeature`** | key | `key`#0 | 4 | 4 | **100% string** | agree |
| `m56_ctx$setLinkDemand` | key | `key`#0 | 32 | 32 | 100% string | agree |
| `m82_bridge$bind` | key | `name`#0 | 53 | 53 | 100% string | agree |
| `m65_index$registerBuiltinAlias` | key | `name`#0 | 5 | 0 | — | allUnresolved |
| `m127_reps$joinKinds` | obj | `fact`#0 | 4 | 0 | — | allUnresolved |
| `m127_reps$joinKinds` | key | `key`#1 | 4 | 4 | 100% string | agree |
| `m126_narrow$narrowReturnArrayElems` | key | `field`#0 | 3 | 3 | 100% string | agree |

**The result across all 20 rows: ZERO show cross-call-site disagreement.**
10 are `agree` (100% consensus on a kind that is genuinely not
integer/exempt — e.g. `setFeature`'s `key` is 100% STRING across its 4 call
sites, correctly excluded from the numeric-key exemption because it really
is a string, not because context is missing), 3 are `partialUnresolved-agree`
(the few sites that resolve agree; the rest are just unclassifiable
expressions), 7 are `allUnresolved` (the receiver never resolves at any
site — `walkPost`'s `parent`, `mergeParamFact`'s `rep`, `joinKinds`'s `fact`,
`snapshotFeatures`'s `into`, `registerBuiltinAlias`'s `name`,
`compile$name`'s `list`).

**FINDING (this IS the direct, empirical answer to the task's central
question): for the exact receiver/key params driving the §17-§23 `hz.all`
`keyedWrite` wall, context-sensitivity's measured prize is ZERO.** Not one
of the 20 measured rows would change if call sites were kept separate
instead of joined — the joined and per-site answers are IDENTICAL for every
row (either uniformly unresolved, or uniformly agreeing on a genuinely
non-exempt kind). This independently confirms, via a completely different
diagnostic path, what §18-§21 already concluded through direct code
reading: the wall is a CENSUS-EXPRESSIVITY gap (`Map.get()`'s value kind,
property-chain receiver kind — §18-§21's saga), not a cross-call-site
disagreement gap. A context-sensitivity mechanism, however implemented,
cannot manufacture a resolved kind at a site where the underlying inference
(`inferValAtSite`/`kindOf`) has no fact to give it.

**Correction to the historical framing**: `walkPost`/`walkPostN` — named in
§17 as examples of "the compiler's OWN internal census helpers" — are
verified (`grep`, `node_modules/watr/src/util.js:155,171`) to be **`watr`
package source** (a vendored dependency, bundled into `scripts/self.js`
because `self.js` imports `watr`'s `compile`/`print`), not `src/`. They are a
genuinely self-recursive AST post-order walker
(`walkPost = (node, fn, parent, idx) => { ...; walkPost(c, fn, node, i) }`)
— `parent` is, BY DESIGN, every distinct AST-node shape in the whole
program at some level of the recursion (an unbounded-domain receiver no
static analysis resolves), and the recursive self-call is exactly ONE
static call site (fires thousands of times dynamically with different
`node`/`i`, but `argList`-identity dedup correctly counts it once) — a
structural example of why STATIC call-site counting cannot see the DYNAMIC
diversity flowing through a single recursive edge (relevant to §2/§4
below). `mergeParamFact`/`joinKinds`/`setFeature` ARE genuine jz-own-source
(`src/param-reps.js`, `src/ctx.js`) — and are themselves the compiler
narrowing/hazard-censusing ITSELF (self-hosted self-reference), also
correctly excluded (their `key`/`field` params are by-design polymorphic
string dispatchers, not narrowing gaps).

---

## 2. Call-graph shape (top offenders)

`filterLiveCallSites` + the worklist (`narrow.js:1502,1940-1966`) already
give: 12710 live call sites over 1610 functions, avg **7.9 call sites per
tracked function**, but heavily skewed (median row size 3, p90 15, max
1012 — `m78_ir$typed`, itself an `ir.js` leaf helper called from all over
codegen).

**Verified concretely for the top-flagged shapes:**
- **`walkPost`/`walkPostN`** (watr, vendored): self-recursive (SCC size 1),
  3 and 10 static call sites respectively (recursive edge + a handful of
  external callers) — but the recursive edge alone carries unbounded
  DYNAMIC polymorphism (every AST node shape passes through it at
  different depths). This is the sharpest case for why (i) per-call-site
  param facts, keyed by STATIC call site, cannot exploit recursion — the
  one static recursive edge IS the polymorphic majority of the traffic,
  and it would still resolve to the SAME single per-site fact bucket a
  joined lattice already gives it.
- **`mergeParamFact`/`joinKinds`/`setFeature`** (jz-own, self-referential —
  the compiler compiling its own lattice-merge machinery): dispatcher
  functions whose `key`/`field` parameter is INTENTIONALLY different at
  every call site (a field-name string selecting which lattice slot to
  touch) — polymorphic by design, not a missed-precision case for ANY of
  (i)/(ii)/(iii); no lever here helps because there is nothing wrong to fix.
- **`m78_ir$mkPtrIR`, `m82_bridge$wat`/`reg`**: NOT recursive, NOT
  keyedWrite-flagged, but ARE among the small set of genuine
  cross-call-site VAL/WASM disagreements (§1a) — monomorphic-caller
  fraction ~95-100% (majority kind), 1-4 minority sites. These are the
  ones (ii) (cloning) would actually help.

**Indirect/closure calls**: not exhaustively profiled this session (would
need a separate static/dynamic call-target census over `scripts/self.js`'s
full graph — out of this probe's scope, named honestly rather than
estimated). The `walkPost` case above is suggestive that recursion, not
indirection, is the dominant call-graph feature defeating static
per-call-site attribution in this codebase; `specializeUnionCursorParams`
and `speculateTypedParams` (both read below) already carry their OWN
provenance-chasing logic specifically because SOME callers are reached only
through an enclosing arrow/closure (`speculateTypedParams`'s doc: "a name
that is an ENCLOSING ARROW's param → meet over the arrow's own call
sites") — i.e. the existing code already treats indirect/closure-mediated
calls as a distinct, harder case requiring bespoke evidence-chasing, not
naive per-site storage.

**Verdict on (i) vs (ii) vs (iii)**: the measured call-graph shape does NOT
favor (i) full per-call-site param facts — the disagreement population is
too small (0.5-2.3%) and too concentrated (landslide majorities) to justify
instrumenting the ENTIRE 12710-edge call graph. It favors **(ii) targeted
cloning** for the ~20-25 functions that show genuine, exploitable
disagreement (§4), and **(iii) flow-sensitive consumer-side reasoning**
(the `chainSid`/`chainHazarded` precedent, §19-§20) for the dominant
`keyedWrite` wall itself, since that wall's population is 0% disagreement
and 100% "the census literally cannot resolve this receiver's kind" — no
context lever of any kind fixes that; only a stronger KIND fact
(property-chain tracing, already landed infrastructure per §20) can.

---

## 3. Existing machinery

### `specializeBimorphicTyped` (`narrow.js:2882-3028`) — exact mechanism

1. Indexes `callSites` by callee (`sitesByCallee`, one pass, `narrow.js:
   2886-2891`).
2. For each non-exported, non-rest, body-having function with ≥2 call
   sites: finds "sticky-bimorphic" param positions — `r.val === VAL.TYPED
   && r.typedCtor === null` (a param the F-phase fixpoint proved is SOME
   typed array, but couldn't settle WHICH typed-array ctor because ≥2 call
   sites disagree) AND not already `i32`-narrowed, no default
   (`narrow.js:2922-2932`).
3. For each of those bimorphic positions, re-infers the ctor PER CALL SITE
   via `inferTypedCtor(site.argList[k], {callerElems, paramFacts})`
   (`narrow.js:2939-2951`) — literally re-running inference over
   `callSites`' own `argList`, the SAME per-site raw arg data the
   worklist already carries (see the D1 answer below). Aborts the whole
   function if ANY site's ctor is unresolvable at that position — fails
   closed, never partially clones.
4. Distinct combos across sites, capped `2 ≤ distinct.size ≤
   MAX_CLONES_PER_FN(4)` (`narrow.js:2960-2961`) — build one clone per
   distinct combo (new `ctx.func` entry, `cloneSig` with the bimorphic
   positions pinned `i32`/`ptrKind:TYPED`/`ptrAux:ctor-specific`, own
   `paramReps` entry cloned via `cloneRep` with the position's `typedCtor`
   pinned) — `narrow.js:2963-3018`.
5. Rewrites each call site's AST node (`sites[i].node[1] = clone.name`) to
   point at the matching clone (`narrow.js:3021-3024`).

**What limits it to typed params specifically**: the trigger condition
(step 2) is HARD-CODED to `r.val === VAL.TYPED && r.typedCtor === null` —
it only fires for the ONE dichotomy narrow.js already tracks as a
first-class sub-lattice (`typedCtor`, a separate field from `val`,
populated by its own fixpoint, `runArrElemFixpoint`-family). It does not
look at `val` disagreement in general (a param stuck at `val === null`
from a STRING-vs-CLOSURE or ARRAY-vs-OBJECT split, per §1a's measured
rows, is invisible to this function entirely).

**What generalizing to VAL-kind dichotomies would take**: mechanically
small — steps 3-5 are ALREADY generic (they operate on "some inferrer
function over `site.argList[k]`," already parametrized by `inferTypedCtor`
as a plug-in). The needed changes:
- A trigger condition reading `r.val === null` (poisoned by the general
  meet) instead of the TYPED-specific check, PLUS a per-site re-derivation
  using `inferValAtSite`-equivalent (currently a `narrowSignatures`-local
  closure, not exported — would need hoisting or an exported variant, a
  small, mechanical refactor per this codebase's own module-boundary
  conventions).
- A distinctness/cap policy — `MAX_CLONES_PER_FN` generalizes directly,
  but the VAL population (§1a) shows the disagreement is almost always
  BINARY (one majority + 1-4 minority sites), so `distinct.size` will
  rarely exceed 2-3 in practice, unlike the typedCtor case which can
  genuinely see 3-4 distinct ctors.
- `cloneSig`'s per-param literal construction (`narrow.js:2987-2993`) is
  ALREADY val-kind-agnostic in shape (`{name, type, ptrKind, ptrAux}`) —
  reused as-is by `specializeUnionCursorParams` (`narrow.js:3119`) for a
  THIRD, unrelated dichotomy (union-cursor packing), confirming this
  clone-literal shape is already the established, reused convention for
  ANY per-position specialization — no new abstraction needed, just a new
  caller.

### `speculateTypedParams` (`narrow.js:3179-...`) — the GUARDED sibling

For params that can never be STATICALLY proven typed (Map-cache/memo
shapes) but where every static call site's evidence agrees in practice:
clones the callee (same clone machinery), but the CALL SITE keeps BOTH the
original and the clone, and `emitSpeculativeCall` emits a runtime
NaN-box-tag-compare guard (`tags-all-match? call $f$spec(...) : call
$f(...)`) — soundness never depends on the evidence; only speed does. This
is the WEAK-evidence-with-runtime-fallback answer to the same "some sites
prove it, some don't" shape §1a's `partialUnresolved-agree` rows show
(3 of the 20 keyedWrite-flagged rows are exactly this shape) — an existing,
in-repo precedent for "don't need ALL sites to agree statically, guard the
gap at runtime" that a VAL-kind generalization could reuse directly rather
than inventing new machinery.

### The `callSites` D1 worklist — does it already carry per-site facts?

**Yes, unconditionally, today.** `program-facts.js:274,373` build
`callSites` entries as `{ callee, argList, callerFunc, node }` —
`argList` is the RAW, per-call-site argument AST array, never discarded
after the fixpoint runs. `narrow.js`'s own `siteState` (`narrow.js:1532-
1559`) re-derives a fresh per-site inference context from this SAME
`argList` on every fixpoint sweep — the joined `paramReps` Fact is a
PROJECTION computed FROM per-site facts that are already fully available;
nothing is thrown away except the individual observations themselves.
This is exactly how this session's own probe worked (§0) and exactly how
`specializeBimorphicTyped` already re-derives per-site ctors (§3 above,
step 3) — **a per-site (not meet-joined) storage requires NO new
plumbing for the "read the fact" side — `callSites` already IS the
per-site fact vector, in raw (unclassified) form.** What would be NEW is
(a) a place to cache the CLASSIFIED per-site result instead of
re-inferring it from `argList` every time a consumer needs it (a
`Map<argListRef, value>` exactly like this session's own diagnostic
side-table), and (b) deciding which consumers read the joined `Fact` vs.
the per-site vector (most of `narrow.js`'s ~20 `hardParamVal`-style
hard-fold consumers explicitly re-derive per-site already — see
`hardParamVal`, `hardParamRecvArrTyped`, `hardParamPresentVal`, all doing
their OWN `for (const cs of callSites) ...` loop — the joined `paramReps`
Fact is consumed directly only by a MINORITY of call sites, mostly
`kindOf`/`repOf`-style single-fact readers in `program-facts.js`/`kind.js`).

---

## 4. Cost model

### Fixpoint size if params kept per-site fact vectors

Baseline today: 2906 joined `Fact` leaf objects (`totalParamEntries`).
A per-site model needs one leaf per (func, param, call site) instead:
**12710 leaves for the SAME population** (`callSitesTotal`) — a **4.4×**
blowup in Fact-object count, for `val` alone. Restricting to just the
multi-site subset (1711 rows, single-site rows are trivially
"already per-site"): 17056 leaves vs. 1711 joined — **~10×** blowup for
that subset specifically. Since `ValueRep`/`Fact` carries up to 29 fields
(`REP_FIELDS`, `reps.js:253-258`), and the worklist's OWN documented
convergence guard is already sized `callSites.length * 64`
(`narrow.js:1953,1960` — "belt far above any real edge count") — the
worklist ALREADY visits every call site up to 64× per fixpoint; making the
STORAGE per-site (not just the transient visit) multiplies steady-state
memory by the same ~4-10× factor without necessarily changing fixpoint
TIME (the visits already happen; only where the result is WRITTEN
changes). The real cost is elsewhere: every existing single-fact reader
(`kindOf`, `repOf(x)?.val`, `curParamVts.get(name)`, dozens of call sites
across `program-facts.js`/`kind.js`/`emit.js`) would need to become
"pick the fact for THIS specific call, not the function" — a much larger,
diffuse consumer-side rewrite than the storage change itself, and exactly
the class of "materially larger, separately-scoped feature" §18-§21
repeatedly bank for future sessions.

### The specialization-clone alternative's code-size cost

Distinct functions showing genuine cross-call-site disagreement (§1a,
`val` ∪ `wasm`, deduped): **~21 functions** (10 `val`-only, 11
additional `wasm`-only, 2 functions — `mkPtrIR`, `cloneWithSubst` —
appear in both but count once). Per `specializeBimorphicTyped`'s existing
cap (`MAX_CLONES_PER_FN = 4`) and the measured shape (nearly all rows are
a 2-way majority/minority split, `distinct.size` rarely >2 in this
population): **≈2 clones/function typically, ≈42 new function bodies
total, worst case ≤84** (`21 × 4`) — a BOUNDED, targeted cost that scales
with the disagreement population (21 functions), not with the whole call
graph (1610 functions) or the whole call-site set (12710 edges). This is
roughly **2 orders of magnitude cheaper** than the fixpoint-storage
alternative's blast radius, and reuses machinery (`cloneRep`, the
`cloneSig` literal shape, `paramReps.set(cloneName, cloneReps)`) already
landed and tested by `specializeBimorphicTyped`/`specializeUnionCursorParams`
today — no new soundness review needed for the CLONE mechanism itself,
only for the (small, mechanical) trigger-condition generalization named
in §3.

---

## 5. Recommendation inputs (no design — numbers only)

| Wall | Disagreement-driven? | (i) full per-call-site facts | (ii) cloning/specialization | (iii) flow-sensitive consumer reasoning |
|---|---|---|---|---|
| §17/§22 `keyedWrite` receiver/key params (the dominant `hz.all` wall, 335 hits / 126 functions / 20 measured rows) | **0/20 measured rows disagree** — 100% either `allUnresolved` or `agree`-on-non-exempt-kind | **No prize measured** — nothing to recover, joined and per-site answers are identical here | **No prize** — cloning needs ≥2 distinct resolvable outcomes; these rows have ≤1 | **This is the ONLY lever with headroom** — §19-§21's `chainSid`/`chainHazarded` property-kind-tracing infrastructure is already landed and IS what's missing (a stronger KIND fact, not more context); §21 confirmed `slotHazarded`'s `hz.all` gate itself is sound and must not narrow |
| General `val`/`wasm` cross-call-site disagreement (13 `val` + 37 `wasm` rows program-wide, ~21 distinct functions, landslide majorities) | **Yes, by definition** — this IS the disagreement population | Technically sufficient but **~4-10× storage blowup + diffuse consumer rewrite** for a population that's 0.5-2.3% of all multi-site params | **Best fit** — `specializeBimorphicTyped`'s existing mechanism generalizes with a small, mechanical trigger-condition change (§3); ≈42 clones, reuses landed/tested machinery | Not needed — no receiver-kind circularity here, plain arg-kind disagreement |
| `speculateTypedParams`-shaped "some sites prove it, most don't" (3/20 keyedWrite rows: `mergeParamFact`'s `key`, `bridge$wat`'s `name`, `addHostImport`'s `alias` — all `partialUnresolved-agree`) | Partial (agreement where resolvable, silence elsewhere) | Not needed | **Existing guarded-speculation precedent fits directly** — runtime tag-compare, no static full-agreement requirement | N/A |
| Recursive/self-referential call edges (`walkPost`/`walkPostN`, watr-vendored) | N/A — one static site carries unbounded dynamic diversity | **Structurally cannot help** — static per-call-site keying can't separate what one recursive edge conflates | Cloning doesn't apply (single edge, not distinct call sites) | The only sound path is widening the CALLEE's own body-flow reasoning (recursive fixpoint over the tree shape), out of scope for both (i) and (ii) |

**Bottom line, numbers-only**: the carrier flip's actual remaining
dependency (the `hz.all` `keyedWrite` wall) has a measured
context-sensitivity prize of **zero** — independently reconfirming
§17-§23's own conclusion via a different method. Where context-sensitivity
DOES have a non-zero, measurable prize (the general `val`/`wasm`
disagreement population, ~21 functions), the cheaper, already-precedented,
already-audited lever (ii) — generalizing `specializeBimorphicTyped` — is
the better fit than building (i) full per-call-site storage, both by cost
(§4: ~2 orders of magnitude cheaper) and by shape (§1a: disagreement is
almost always a landslide, exactly what cloning exploits and what a
general fixpoint rewrite would not exploit any better).

---

## FINDINGS (flagged, not proposals)

- **FINDING**: context-sensitivity's measured prize for the specific
  §17-§23 `keyedWrite` `hz.all` wall is **zero** (0/20 exact
  receiver/key-param rows show cross-call-site disagreement) — this is a
  new, independent, ground-truth confirmation of §21's conclusion, not a
  restatement of it.
- **FINDING**: program-wide, genuine cross-call-site disagreement is rare
  (0.5% of multi-site `val` rows, 2.3% of multi-site `wasm` rows) and,
  where it occurs, is almost always a landslide majority/minority split —
  the shape `specializeBimorphicTyped` already targets, not a shape a
  general context-sensitive fixpoint would serve meaningfully better.
- **FINDING**: the dominant cause of lattice imprecision in this codebase
  (65-98% of multi-site rows) is single-site value-inference
  unclassifiability, not cross-site disagreement — a DIFFERENT problem
  class (`inferValAtSite`/`kindOf` expressivity) than context-sensitivity
  addresses at all.
- **FINDING (historical correction)**: `walkPost`/`walkPostN`, cited in
  §17 as examples of "the compiler's own internal census helpers," are
  verified to be **vendored `watr` package source**
  (`node_modules/watr/src/util.js:155,171`), not `src/`. `mergeParamFact`/
  `joinKinds`/`setFeature` (this session's own verified jz-own examples)
  are the compiler's lattice-merge machinery examining ITSELF
  (self-hosted self-reference) — their flagged params are intentional
  polymorphic dispatchers (a field-name/feature-key string), not
  precision gaps of any kind.
- **FINDING**: the `callSites` array (`program-facts.js:274,373`) already
  carries per-call-site raw `argList` data, never discarded — a per-site
  (not meet-joined) fact vector requires NO new data-collection plumbing,
  only a new place to cache classified results and consumer-side changes
  to read them; `specializeBimorphicTyped` already demonstrates this
  exact re-derivation pattern for the `typedCtor` sub-lattice.
- **FINDING**: `specializeBimorphicTyped`'s clone-construction machinery
  (steps 3-5, `narrow.js:2939-3024`) is ALREADY generic over "some
  per-site inferrer function" — only its TRIGGER condition
  (`r.val===VAL.TYPED && r.typedCtor===null`) is typed-specific;
  generalizing to VAL-kind dichotomies is a small, mechanical change
  reusing 90%+ of the existing, tested mechanism.
- **FINDING**: recursive call edges (verified concretely via `walkPost`)
  are a structural blind spot for ANY static per-call-site keying scheme
  (both (i) and (ii)) — one static site can carry unbounded dynamic
  polymorphism that no call-site-indexed storage separates.

---

## Probe revert

Both temporary probes (`src/compile/narrow.js`'s `JZ_DBG_CTXSENS`
diagnostics + `_ctxSensDump`/`_ctxSensRecord`/`_ctxSensSiteId` helpers, and
`src/compile/program-facts.js`'s `JZ_DBG_CTXSENS` flag + `CTXSENS_KW`
logging + `curFunc`/`curFuncName` tracking) are reverted to `HEAD` before
commit. `dist/jz.wasm` was rebuilt by the diagnostic runs (`JZ_SELFHOST_
OPT=0`, three times) — rebuilt once more from the reverted, plain source
before concluding, so the repo is left in a normal, buildable state, not a
stale-artifact one.

## COORDINATOR RULING (2026-08-09, binding)
(i) full context-sensitivity: REJECTED — fits nothing measured (0/20 wall
params disagree; 0.76% program-wide, always landslide). (ii) VAL-kind
specialization generalization: APPROVED as a standalone precision slice
(≈42 clones, mechanical per §3) — value is general codegen, NOT the carrier
wall. (iii) is landed. THE CARRIER CONSEQUENCE: the §15 chain cannot be
closed by proving hazarded schemas safe — the hazards are genuine. The
remaining sound direction is CONSERVATIVE PAIRING: under CARRIER_BOX, a
schema slot that is (bigint-POSSIBLE ∧ hazarded/unproven) routes its STATIC
reads through the registry-aware dynamic reader ($__dyn_get's PTR.BIGINT
arm) instead of the bare f64.load — write side already boxes wide on
shadowed schemas; reads stop needing the proof the program can't give.
Cost lands only on hazarded+bigint-possible slots (rare; LAYOUT's own
constants being the known case). This is the §16 slotBigintProven design's
fail-OPEN half completed: proof ⇒ fast unboxed pairing; no proof ⇒ dynamic
dispatch, never a bare misread. PROBE next: implement behind CARRIER_BOX,
measure the §15 differentials + dict parity + test:wasm; if green, the
flip-readiness probe finally has no known blocker.
