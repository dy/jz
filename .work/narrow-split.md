# narrow.js structure map and module plan (pre-split)

Base: `b900cd09` (`refactor/pipeline-minimality`, merge-base with `main` @
`0d785f9c` — the same commit that merged the vectorize split). `src/compile/narrow.js`
is 3,934 lines (`wc -l`; `node --check` clean), **62** top-level declarations
— 9 `const` (data tables + one one-line arrow helper, `kindName`), 43 plain
`function`, 1 `export default function`, 9 `export function` (52 functions
total, 9 of them named-exported plus the 1 default; tallied against the
family table in §2, which sums to 62) — and 1 default + 9 named exports.
Dependency edges below were extracted with a comment/string-stripped
scan (throwaway script, `/private/tmp/claude-501/-Users-div-projects-jz/19d4c08f-5baa-4dee-92c5-d778ac161604/scratchpad/narrow-deps.mjs`,
not in the repo) — same method `.work/vectorize-split.md` used, so they
reflect real code references, not doc-comment mentions of sibling names.
Style/target follow that file exactly (it is the template for part (a) of
this map).

## Corrections to the brief — read this first

Three numbers in the task brief don't match direct inspection. Stating them
up front because they change the shape of part (b) materially:

1. **62 top-level declarations, not 61.** A naive `^(export )?(function|const|...)`
   grep — the obvious way to produce a "61" count — matches `export function`
   but not `export default function`, so it silently drops exactly one
   declaration: `narrowSignatures` at line 1815, the file's default export
   and its single largest function. `node --check`-clean, script-verified
   (see §4): 62.
2. **`inferTypedValueRanges` is 181 lines (1633–1813), not ~1,270.** The
   brief's "~1,270-line function `inferTypedValueRanges` (~lines 1633–2900)"
   conflates two adjacent, separately-declared top-level functions:
   `inferTypedValueRanges` itself (1633–1813, 181 lines — closes with `return
   { locals, summaries, hull, initialRange }` at line 1812–1813) and
   `narrowSignatures` (1815–2899, **1,085 lines** — the default-exported
   fixpoint driver, the file's real outlier). `2900 − 1633 = 1267`, i.e. the
   brief's line-count arithmetic is exactly the SUM of both functions, done
   as if only one existed. This isn't a fresh mistake: `.work/pipeline-minimality.md`'s
   own "Queue after M1b" section already lists `` `inferTypedValueRanges`
   (~1.3k, narrow.js) `` as outlier-function item 3 — the same conflation is
   already committed to the campaign doc, presumably from the same kind of
   measurement. The 3 named nested phases (`computeDirectEffects` /
   `propagateCallForwarding` / `computeLocalRanges`) genuinely are all three
   nested inside the real, 181-line `inferTypedValueRanges` (confirmed by
   direct read, §6) — that part of the brief is accurate. `narrowSignatures`
   is a separate, much bigger problem, addressed at the end of §6.
3. **"9 exports" is right, read as 9 named + 1 default = 10 exported bindings.**
   Verified exhaustively (§1): all 10 are live, all imported somewhere. No
   correction needed here, just stated precisely so §1/§5 aren't ambiguous.

---

## 1. External contract

Exactly **three** files import from `narrow.js` anywhere in the repo (grepped
`src/`, `module/`, `jzify/`, root `index.js`, `scripts/`, `test/` for
`from '.*narrow\.js'` plus `require(.*narrow`/`import(.*narrow` for
dynamic/CJS forms — none found beyond the three static ES imports below).
Every other file that contains the substring `narrow.js` (`src/ir.js`,
`src/type.js`, `src/kind.js`, `src/session-views.js`, `src/reps.js`,
`src/compile/flow-types.js`, `module/core.js`, several `test/*.js`, several
`.work/*.md`) does so only in prose comments referencing the file by name —
confirmed by reading each hit, not assumed.

| importer | line | imports | call site |
|---|---|---|---|
| `src/compile/plan/index.js` | 33–37 (multi-line) | `narrowSignatures` (default), `specializeBimorphicTyped`, `specializeValKindDichotomy`, `speculateTypedParams`, `refineDynKeys`, `applyJsstringBoundaryCarrierStandalone`, `narrowBoolResults`, `strictBoundaryTypeCheck` | `narrowSignatures(programFacts, ast)` at line 286; the other 7 called elsewhere in the same file's `plan()` pipeline |
| `src/compile/plan/advise.js` | 6 | `adviseJsstringCarrier` | line 348: `adviseJsstringCarrier(programFacts.paramReps, programFacts.valueUsed)` |
| `src/compile/index.js` | 55 | `specializeUnionCursorParams` | line 2555: `for (const clone of specializeUnionCursorParams(programFacts)) {` — return value (`clones`) is consumed |

All **10** exported bindings (1 default + 9 named) are imported by at least
one of these three files — none dead, none missing an importer:
`narrowSignatures` (default), `applyJsstringBoundaryCarrierStandalone`,
`narrowBoolResults`, `adviseJsstringCarrier`, `strictBoundaryTypeCheck`,
`specializeBimorphicTyped`, `specializeValKindDichotomy`,
`specializeUnionCursorParams`, `speculateTypedParams`, `refineDynKeys`.

This is a smaller, simpler contract than `vectorize.js`'s (4 exports/1
importer) but the same shape: a pure-move split can keep every one of these
three files' import lines byte-identical by re-exporting from a shim (§5).

## 2. Top-level inventory (62 declarations)

Grouped by family (this grouping is what §5's module plan is built from).
Ranges are `start`–`end` where `end` = next declaration's start line − 1
(script-verified, not hand-counted).

**A. `caller-ctx` — shared per-caller context builders + tiny shared data (14 items, ~286 ln)**

| lines | name | role |
|---|---|---|
| 40–43 | `PTR_ABI_KINDS` | const Set; pointer-ABI-eligible VAL kinds (fan-in 1: `applyPointerParamAbi`) |
| 44–55 | `RECUR_INT_OPS` | const Set; int-preserving ops for recursive-arg optimism (fan-in 1: `narrowSignatures`) |
| 56–62 | `assertValKindConsistent` | DBG_INVARIANTS-gated `val`/`possibleKinds` consistency check (fan-in 4) |
| 63–88 | `filterLiveCallSites` | in-place compacts `callSites` to reachable-from-live-funcs only |
| 89–109 | `buildCallerCtx` | per-caller `{callerLocals, callerValTypes, callerTypedElems}` map |
| 110–137 | `buildCallerElems` | per-caller array-elem-schema slice map, keyed by `sliceKey` |
| 366–377 | `callerTypedElemsFor` | shadow-aware local+global typed-array map for one caller |
| 378–391 | `buildCallerTypedCtx` | per-caller typed-elem map (wraps `callerTypedElemsFor`) |
| 392–410 | `buildCallerTypedLenCtx` | per-caller static-typed-length map |
| 350–365 | `refreshCallerValTypes` | re-derives `callerCtx[*].callerValTypes` post-mutation |
| 453–488 | `refreshCallerLocals` | re-derives `callerCtx[*].callerLocals` w/ pointer-param seeding |
| 440–452 | `enrichCallerValTypesFromPointerParams` | seeds callerValTypes from settled `p.ptrKind` |
| 489–520 | `resetParamWasmFacts` | clears `r.wasm` across all `paramReps` |
| 1078–1123 | `createPhaseState` | factory: lazily-cached `{callerCtx, callerElems, callerTyped, clearNarrowingBodyState, refreshValTypes, refreshLocals}` — bundles the above |

**B. `param-abi` — wasm-type / pointer-ABI param specialization (8 items, ~241 ln)**

| lines | name | role |
|---|---|---|
| 138–166 | `isIntSafeMutatedParam` | proves a body-written param's mutations stay int-preserving |
| 167–188 | `callerArgSelfConsistentI32` | cross-function self-consistency check for the above |
| 189–244 | `applyI32ParamSpecialization` | Phase D tail: narrows `p.type` to `'i32'`/`'v128'` from hard call-site consensus |
| 245–266 | `validateTypedLenParams` | drops `r.typedLen` on host-reachable/body-written/untyped params |
| 267–288 | `validateIntConstParams` | drops `r.intConst` on body-written params |
| 289–343 | `applyPointerParamAbi` | narrows OBJECT/SET/MAP/BUFFER params from NaN-boxed f64 to i32 offset |
| 344–349 | `narrowableFuncs` | filter: non-raw, non-value-used, single-result funcs |
| 411–439 | `applyTypedPointerParamAbi` | Phase G: narrows TYPED params to i32 + ptrAux=elem-type |

**C. result-narrowing — numeric/VAL-kind/pointer/bool function results + return-path array-elem propagation (13 items, ~684 ln)**

| lines | name | role |
|---|---|---|
| 521–732 | `narrowI32Results` | Phase E: numeric i32 result narrowing + sign classification |
| 733–743 | `installArrElemReps` | installs non-null `arrElemValTypes` facts onto `localReps` for a resolution window |
| 744–827 | `narrowValResults` | Phase E2: VAL-kind result inference (`func.valResult`) |
| 828–831 | `PTR_RESULT_KINDS_NOAUX` | const Set; SET/MAP/BUFFER — pointer kinds needing no aux |
| 832–852 | `localElemAuxMap` | per-body local `new TypedArray` → aux map |
| 853–907 | `typedAuxOfReturn` | resolves a return expr's typed-elem aux (self-recursive over `?:`/`&&`/`\|\|`) |
| 908–939 | `passesParamThrough` | is a return expr exactly `paramName`, incl. one recursive hop |
| 940–977 | `passthroughPtrParam` | a func whose every return is one already-pointer-narrowed param |
| 978–994 | `passthroughPtrCall` | a func whose every return is a call into an already-narrowed callee |
| 995–1077 | `narrowPointerResults` | Phase E3: pointer result narrowing (param/call passthrough + valResult-driven) |
| 1124–1130 | `_FIELD_TO_SLICE` | const object; field name → `analyzeBody` slice-key map |
| 1131–1190 | `narrowReturnArrayElems` | propagates Array\<T\> elem facts from return paths into `func[field]` |
| 2925–2984 | `narrowBoolResults` | leaf-module-skip-path bool/bigint result inference — **concurrent-edit region, see §7** |

**D. `whole-program-summaries` — self-contained interprocedural analyses feeding `narrowSignatures` (9 items, ~624 ln)**

| lines | name | role |
|---|---|---|
| 1191–1437 | `inferInternalArrayLengths` | whole-program fixed-length proof for literal+push-built arrays |
| 1438–1466 | `literalOrCallerParamInt` | literal/intConst/module-const int resolver (no `repOf`, self-recursive) |
| 1467–1496 | `singleDefRhs` | the one `let`/`const` RHS of a name in a body, or null if ambiguous |
| 1497–1518 | `builderTypedArrayLen` | a builder func's own provable typed-array return length |
| 1519–1536 | `callerArrayLen` | provable elem length of a name as seen inside one caller |
| 1537–1565 | `coInductionCounterHull` | canonical `for` loop's `[lo,hi]` hull |
| 1566–1599 | `findCoInductionLoopCtx` | walks to find the innermost provable loop enclosing a target ref (self-recursive) |
| 1600–1632 | `arrayReadProvenInBounds` | co-induction bounds proof for one `arr[idx]` read |
| 1633–1813 | `inferTypedValueRanges` | **target function for §6** — whole-program typed-elem-store range hulls |

**E. entry point (1 item, 1,085 ln — the file's real outlier, see §6)**

| lines | name | role |
|---|---|---|
| 1815–2899 | `narrowSignatures` | default export; the fixpoint driver (phases D→J) |

**F. `jsstring-carrier` — externref string-param boundary opt-in (6 items, ~172 ln)**

| lines | name | role |
|---|---|---|
| 2900–2908 | `jsstringEnabled` | host/opt-out gate (fan-in 3) |
| 2909–2924 | `applyJsstringBoundaryCarrierStandalone` | Phase J standalone entry for the skip-narrow path |
| 2985–2997 | `JSS_OK_PROPS` | const Set; `.length`/`.charCodeAt` |
| 2998–3050 | `paramAllUsesJsstringMappable` | body-use-shape check for one string param |
| 3051–3090 | `applyJsstringBoundaryCarrier` | Phase J: flips eligible exported string params to `externref` |
| 3091–3131 | `adviseJsstringCarrier` | warn-only near-miss diagnostics |

**G. `strict-boundary` — host type-conflict rejection (3 items, ~98 ln)**

| lines | name | role |
|---|---|---|
| 3132–3137 | `STRICT_CONFLICT` | const object; mutually-exclusive VAL-kind pairs |
| 3138–3158 | `kindName` | const arrow fn; VAL kind → display string |
| 3159–3229 | `strictBoundaryTypeCheck` | `strict: true` boundary-coercion compile error |

**H. `specialize` — call-site specialization / cloning via `materializeVariant` (5 items, ~624 ln)**

| lines | name | role |
|---|---|---|
| 3230–3395 | `specializeBimorphicTyped` | clone per distinct typed-ctor combo at sticky-bimorphic positions |
| 3396–3492 | `specializeValKindDichotomy` | one clone pinned at landslide-majority (≥90%) VAL-kind positions |
| 3493–3531 | `collectUnionSites` | module-scope iterative (non-recursive) call-site walk for union cursors |
| 3532–3627 | `specializeUnionCursorParams` | `$union` clones with raw i32 packed-cell cursor params |
| 3628–3853 | `speculateTypedParams` | `$spec` clones behind a runtime tag-guard, weak-evidence engine |

**I. `dyn-keys` — dynamic-key refinement, standalone late pass (3 items, ~81 ln)**

| lines | name | role |
|---|---|---|
| 3854 | `NON_DYN_VTS` | const Set; VAL kinds exempt from "dynamic key" pessimism |
| 3855–3856 | `TYPED_ARRAY_CTOR` | const regex; typed-array ctor name matcher |
| 3857–3934 | `refineDynKeys` | narrows `ctx.types.anyDynKey` using post-narrow type info |

## 3. Module-level mutable state / side effects / TDZ

**None of concern — this is a materially simpler pure-move than `vectorize.js`'s.**
Verified by grep, not assumption:

- **No top-level `let`** anywhere in the file (`grep -n '^let '` — zero hits).
  Every module-scope binding is `const` or a declaration.
- **No top-level side-effectful statements.** `vectorize.js` had one
  top-level `registerResetHook(...)` call; narrow.js has none (checked for
  `registerResetHook`, `resetHook`, `ctx.reset` at column 0 — zero hits, and
  the script's own "top-level statements not matching a declaration pattern"
  scan in §4 independently confirms **zero**).
- **No module-level cache/memo** (no top-level `WeakMap`, no cross-call
  `Map` used as a cache — grepped `WeakMap|cache` file-wide; the few hits
  are all *comments* about caches living elsewhere, e.g. `analyzeBody`'s
  own cache in `analyze.js`). All 9 top-level `const` declarations
  (`PTR_ABI_KINDS`, `RECUR_INT_OPS`, `PTR_RESULT_KINDS_NOAUX`,
  `_FIELD_TO_SLICE`, `JSS_OK_PROPS`, `STRICT_CONFLICT`, `kindName`,
  `NON_DYN_VTS`, `TYPED_ARRAY_CTOR` — see §2 for the per-family count) are
  frozen literals or a single pure one-line arrow (`kindName`), read-only
  for the process lifetime.
- **TDZ is a non-issue.** None of the top-level `const` initializers
  reference another top-level `const` or `function` (each is a self-contained
  literal `new Set([...])` / object / regex / one-line arrow). Since nothing
  at module top level *executes* immediately (every declaration is either
  data or a function body that only runs once called, by which point the
  whole module has finished evaluating), declaration order within the file
  — and therefore across the split's module boundaries — is free; the only
  ordering constraint is the *import* graph in §4, not TDZ.
- Unlike `vectorize.js`'s `vecState` wrapper (needed because `_whyNotActive`
  etc. were bare `let`s **reassigned** from a different module, which ES
  modules forbid through an imported binding), nothing in narrow.js is
  reassigned across a would-be module boundary — every cross-function
  "state" here is either a fresh object created per `narrowSignatures` call
  and passed by reference (`paramReps`, `sitesByCallee`, `sharedSiteState`,
  `summaries`, ...) or ordinary function parameters. **No wrapper-object
  trick is needed anywhere in this split.**

## 4. Dependency graph (script-derived) + topological module plan

Method: `narrow-deps.mjs` (throwaway, scratchpad-only) strips `//` and
`/* */` comments and string/template literals character-by-character
(preserving newlines so line numbers stay aligned), locates the 62
column-0 declarations via the same pattern class as §2, then for every
declaration's body slice does a whole-word (`\bNAME\b`) scan for every
*other* declaration's name. `node --check`-clean input; line-count-preserved
output verified before scanning. Full run log:
`/private/tmp/claude-501/-Users-div-projects-jz/19d4c08f-5baa-4dee-92c5-d778ac161604/scratchpad/narrow-deps-out.txt`.

**Headline results:**

- **62 declarations found** (matches §2 exactly; independent confirmation of
  the "not 61" correction in the preamble).
- **Zero top-level statements outside the declaration patterns** — confirms
  §3's side-effect claim mechanically, not just by eyeballing.
- **66 edges, 0 cycles** (Tarjan SCC over the reference graph, self-recursion
  excluded — `typedAuxOfReturn`, `literalOrCallerParamInt`, and
  `findCoInductionLoopCtx` are the 3 self-recursive leaves, harmless to any
  module boundary). Same "no cycles" result as `vectorize.js`.
- **`narrowSignatures` fan-out 22** — by far the largest in the file (next
  highest fan-out is 5, `narrowPointerResults`/`createPhaseState`) — the
  script's own independent confirmation that it is the file's root/entry
  node, consistent with it being the default export.
- **`inferTypedValueRanges` fan-out 0 at the top-level graph** — it
  references zero *other* top-level declarations (its 3 nested phases and
  their shared closure helpers are invisible to this scan by construction,
  since they're not top-level — which is itself informative: nothing
  outside the function's own body is involved). Confirms it can move to its
  own module needing only the header imports, no sibling-module import.
- **`inferInternalArrayLengths` is the same shape** (fan-out 0) — the two
  "whole-program summary" functions are structurally twins: both build a
  per-caller `Map<func, Map<name, fact>>` called `locals`, both are consumed
  identically downstream (`internalArrayLengths.locals.get(state.callerFunc)?.get(arg)`
  at line 2423 / `typedValueRanges.locals.get(state.callerFunc)?.get(arg)`
  at line 2452 — the parallel construction is verbatim, not a loose
  analogy). This is the direct evidence for grouping them into one module
  in §5 rather than splitting `inferTypedValueRanges` off in isolation.
- **Fan-in-0 set** (never referenced by any other top-level decl —
  expected to be exactly "the exported surface plus anything only called
  from outside the file"): `narrowSignatures`,
  `applyJsstringBoundaryCarrierStandalone`, `narrowBoolResults`,
  `adviseJsstringCarrier`, `strictBoundaryTypeCheck`,
  `specializeBimorphicTyped`, `specializeValKindDichotomy`,
  `specializeUnionCursorParams`, `speculateTypedParams`, `refineDynKeys` —
  **exactly the 10 exported bindings**, no more, no less. Every
  module-private declaration is reachable from something inside the file;
  nothing is dead.

**Topological module plan** (derived from the edge list; "later module may
import earlier ones, never the reverse" — same rule as the template):

```
caller-ctx  ─┬─────────────────────────────────────┐
             │                                      ├─▶ index.js (narrowSignatures)
param-abi    │ (needs caller-ctx: PTR_ABI_KINDS)     │
             │                                      │
results      │ (no cross-family deps)                │
             │                                      │
summaries    │ (no cross-family deps)                │
             │                                      │
jsstring-carrier (no cross-family deps) ─────────────┘
             │
strict-boundary (freestanding — no in-file consumer at all)
             │
specialize   (needs caller-ctx: assertValKindConsistent, buildCallerCtx, buildCallerTypedCtx)
             │
dyn-keys     (freestanding)
```

`strict-boundary` and `dyn-keys` have **no** in-file consumer in either
direction — `strictBoundaryTypeCheck`/`refineDynKeys` are called only from
`plan/index.js`, never from `narrowSignatures` or anything else inside
`narrow.js` (confirmed by the fan-in-0 list above — both appear there).
They can sit anywhere in the module order; placed to match the original
file's own physical position for readability continuity.

## 5. Module plan (`src/compile/narrow/`)

| # | file | original lines | contents (§2 family) | depends on (within `narrow/`) |
|---|------|----------------|----------------------|-------------------------------|
| 1 | `caller-ctx.js` | 40–43, 44–55, 56–62, 63–137, 350–410, 440–520, 1078–1123 | A — infra (14 decls, ~286 ln) | — |
| 2 | `param-abi.js` | 138–349, 411–439 | B (8 decls, ~241 ln) | `caller-ctx.js` (`PTR_ABI_KINDS`) |
| 3 | `results.js` | 521–1190, **+2925–2984** | C (13 decls, ~684 ln) | — |
| 4 | `summaries.js` | 1191–1814 | D (9 decls, ~624 ln) | — |
| 5 | `jsstring-carrier.js` | 2900–2924, 2985–3131 | F (6 decls, ~172 ln) | — |
| 6 | `strict-boundary.js` | 3132–3229 | G (3 decls, ~98 ln) | — |
| 7 | `index.js` | 1815–2899 | E — `narrowSignatures`, default export (~1,085 ln) | `caller-ctx.js`, `param-abi.js`, `results.js`, `summaries.js`, `jsstring-carrier.js` |
| 8 | `specialize.js` | 3230–3853 | H (5 decls, ~624 ln) | `caller-ctx.js` (`assertValKindConsistent`, `buildCallerCtx`, `buildCallerTypedCtx`) |
| 9 | `dyn-keys.js` | 3854–3934 | I (3 decls, ~81 ln) | — |

All 9 files land at or under the ~1,200-line ceiling; the largest
(`index.js`, 1,085 ln) is `narrowSignatures` alone and cannot shrink further
under a *pure move* — decomposing it is a logic-level change, addressed as
an outlier candidate at the end of §6, deliberately out of scope here (same
treatment `vectorize-split.md` gives `tryDivergentEscapeVectorize`: named,
sized, deferred to "phase 3, after the pure-move split").

Row-sum ≈ 3,895 of the file's 3,934 lines; the ~39-line gap is blank-line/
doc-comment-header attribution at the 9 module boundaries (my
`end = next_start − 1` convention), not missing content. Expect the *actual*
post-split total to land a little *above* 3,934, not below — `vectorize.js`
went 8,500 → 8,671 (+2%) purely from each new file repeating its own subset
of the original 18-line import block; the same overhead applies here.
Each module's precise import list is a mechanical subset of narrow.js's
current header (`ctx.js`, `flow-state.js`, `session-views.js`, `ast.js`,
`ir.js`, `analyze.js`, `static.js`, `loop-model.js`, `type.js`, `layout.js`,
`program-facts.js`, `kind.js`, `kind-traits.js`, `reps.js`, `param-reps.js`,
`infer.js`, `variant.js`) re-derivable per file from actual usage — not
enumerated here (an unused-import lint pass after the move catches any
miscopy faster and more reliably than a hand-typed list would), matching
`vectorize-split.md`'s own scope (it doesn't enumerate per-module imports
either).

**Shim** (`src/compile/narrow.js`, replacing the whole file):

```js
export { default } from './narrow/index.js'
export { applyJsstringBoundaryCarrierStandalone, adviseJsstringCarrier } from './narrow/jsstring-carrier.js'
export { narrowBoolResults } from './narrow/results.js'
export { strictBoundaryTypeCheck } from './narrow/strict-boundary.js'
export { specializeBimorphicTyped, specializeValKindDichotomy, specializeUnionCursorParams, speculateTypedParams } from './narrow/specialize.js'
export { refineDynKeys } from './narrow/dyn-keys.js'
```

Six lines, all 10 bindings covered, every one of the 3 importers in §1 keeps
its `from '../narrow.js'` / `from './narrow.js'` path byte-identical — zero
changes needed in `plan/index.js`, `plan/advise.js`, or `compile/index.js`.

## 6. `inferTypedValueRanges` decomposition

Confirmed boundaries (§ preamble item 2): **1633–1813, 181 lines total**,
signature `function inferTypedValueRanges(paramReps)`. One more finding
before the matrix: **the `paramReps` parameter is dead** — grepped the full
181-line body for `paramReps`; it appears nowhere but the signature. (Not a
decomposition blocker, just means it drops out of any parameter list for
free; flagged as a one-line follow-up cleanup, out of scope for a pure move.)

Outer-scope setup, in declaration order, before the 3 nested phases:

```
literal = typedValueLiteral            (import alias)
exprRange = typedValueExprRange        (import alias)
elemBounds = new Map([...])            (frozen per-element-ctor [lo,hi] table)
storedRange = (ctor, r) => ...         (pure fn of elemBounds + its args)
initialRange = (rhs, ctor) => ...      (pure fn of literal/exprRange/hull/staticArrayElems + storedRange)
mentions = (n, name) => refsName(...)  (pure fn of the refsName import)
carries = carriesName                  (import alias)
funcs = ctx.funcs.list.filter(...)     (PER-CALL: fresh each invocation, ctx.funcs.list is per-compile state)
summaries = new Map(); for (f of funcs) summaries.set(...)   (PER-CALL: fresh Map, pre-populated {range:null,writes:false,bad:false} per param)
```

### Closure-variable read/write matrix

R = reads · W = writes/mutates · — = untouched · "(via X)" = touches it only
transitively, by calling another outer-scope helper that touches it.

| variable | `computeDirectEffects` (1681–1718) | `propagateCallForwarding` (1723–1747) | `computeLocalRanges` (1755–1807) |
|---|---|---|---|
| `paramReps` (param) | — | — | — (dead everywhere) |
| `literal` | — | — | (via `initialRange`) |
| `exprRange` | **R** direct (line 1693) | — | **R** direct (line 1783) + (via `initialRange`) |
| `elemBounds` | — | — | (via `storedRange`) |
| `storedRange` | — | — | **R** direct calls (1783, 1797) + (via `initialRange`) |
| `initialRange` | — | — | **R** direct call (1773) |
| `mentions` | **R** (1689) | — | **R** (1767, 1794) |
| `carries` | **R** (1698, 1700, 1711) | — | **R** (1785, 1786, 1789, 1795) |
| `funcs` | **R** iterated (1682) | **R** iterated (1727) | **R** iterated (1757) |
| `summaries` | **W** mutates entries' `.bad`/`.writes`/`.range` via `sum[k]` | **R** other functions' entries (`summaries.get(n[1])`) **+ W** own entries via `sum[...]` | **R** only, via `target = summaries.get(callee)` — never writes |

Module-level imports each phase also touches directly (not closure state —
available unchanged regardless of hoist, since every new module just
imports them too): `ASSIGN_OPS`, `callArgs` (all three phases); `hull`
(`propagateCallForwarding` line 1737 direct, `computeLocalRanges` line 1762
direct, both bypassing the `initialRange` wrapper); `typedStaticLen`,
`typedElemCtor` (`computeLocalRanges` only).

`locals` (line 1811, `const locals = computeLocalRanges()`) is **not**
shared closure state — it's the driver's own binding for phase 3's return
value, populated *after* all three phases have already run, read by nothing
inside the function except the final `return`.

### Is a hoist a clean parameter set?

**Mechanically, yes, for exactly two of the ten bindings above.** `funcs`
and `summaries` are the only ones that are genuinely *per-call* (recomputed
fresh every `inferTypedValueRanges` invocation, because `ctx.funcs.list` is
per-compile state) — everything else in the table (`elemBounds`,
`storedRange`, `initialRange`, `mentions`, `carries`, plus the `literal`/
`exprRange` import aliases) is a **pure function of its own arguments and
already-static module data**, with zero per-call state, so it hoists to
true module scope unchanged, no parameter needed, exactly like every other
one of the file's 62 existing top-level helpers. Unlike `vectorize.js`'s
`_whyNotActive`/`_relaxF32`/etc., nothing here is *reassigned* across a
would-be module boundary — `summaries` is mutated in place through an
ordinary object reference, which works identically whether the mutating
function is nested or top-level. **No `vecState`-style wrapper object is
needed.** So: `computeDirectEffects(funcs, summaries)` and
`propagateCallForwarding(funcs, summaries)` are both clean, 2-parameter,
literally that simple.

`computeLocalRanges` is the one wrinkle: it additionally calls
`storedRange`/`initialRange`/`mentions`/`carries` **directly**, not just
`funcs`/`summaries`. Two honest options, both fine:
- Hoist `elemBounds`/`storedRange`/`initialRange`/`mentions`/`carries` (plus
  the `literal`/`exprRange` aliases, or just reference the imports directly)
  to true module scope *alongside* the 3 phases — then `computeLocalRanges`
  stays a clean `(funcs, summaries)` too, at the cost of **~10 new names**
  in the module's top-level namespace, not 3.
- Or pass them explicitly — `computeLocalRanges(funcs, summaries,
  storedRange, initialRange, mentions, carries)`, a 6-parameter function.

Either way the hoist is *mechanically* fine — never "worse than the status
quo" in the threading sense the brief asks about. The real question is
whether it's worth doing.

### Recommendation: keep nested

Weighing it, not just asserting it:

**For hoisting:** matches the file's dominant convention elsewhere (`narrowI32Results`/
`narrowValResults`/`narrowPointerResults` are top-level "Phase E/E2/E3"
functions, not nested); would let each phase be independently grep-able
(`^function computeDirectEffects`) and, in principle, independently testable.

**Against hoisting**, and the deciding factors:
- **Zero reuse.** All three phases have exactly one call site each, always
  in the same fixed order, always from inside this one function (lines
  1809–1811). Hoisting doesn't unlock anything a second caller could use —
  there is no second caller, now or foreseeably (this is a self-contained,
  fan-in-0-from-outside, fan-out-0-to-outside whole-program analysis, per
  §4).
- **The real footprint is ~10 names, not 3.** As shown above, a hoist that
  keeps `computeLocalRanges` at a clean 2-parameter signature has to move
  the whole apparatus — 3 phases + 7 pure helpers — to module scope. All 10
  exist *only* to compute typed-value ranges. Nesting them is exactly the
  language's mechanism for saying that: today, nothing outside
  `inferTypedValueRanges`'s own 181 lines can even see `storedRange` or
  `elemBounds` exist. Hoisting trades that for ~10 more entries in
  `summaries.js`'s module namespace (§5) for a payoff that's purely
  taxonomic.
- **Already well-documented in place.** Each phase already carries its own
  doc comment immediately above it (1675–1680, 1720–1722, 1749–1754) in the
  same voice as the file's top-level "Phase E:"/"Phase E2:" headers — the
  thing a hoist-for-clarity would buy is already present.
- Performance is a wash either way (V8 allocates these closures once per
  `inferTypedValueRanges` call regardless of nesting; no hot per-iteration
  allocation in either shape).

Verdict: **keep nested.** The mechanical case for hoisting is clean (unlike
the harder question below), but nothing is actually gained by moving code
whose entire reason to exist is serving one 181-line function, once, in a
fixed order. If a future change *does* give one of these phases a second
caller, that's the moment to hoist it — not before.

### `narrowSignatures` — flagged, not solved, here

The brief's "~1,270 line" function is really two: the 181-line one just
analyzed, and `narrowSignatures` itself (1815–2899, 1,085 lines, the file's
actual outlier — also `.work/pipeline-minimality.md`'s Queue-item-4 "Files
>3k lines" entry's real internal-complexity driver). It is **not** a
similarly clean decomposition candidate, for a concrete, load-bearing reason
found by reading it in full: it deliberately reuses **one mutable
`sharedSiteState` object** across every call-site visit in its ~20 nested
closures (`intConstArg`, `applySiteRules`, `runCallsiteLattice`,
`inferValAtSite`, `hardParamVal`, `argWasmType`, `runArrElemFixpoint`,
`runFixpointConverged`, ...), and the comment at its own declaration (lines
1876–1881) states why: *"The former fresh 13-field object + method closure
+ Map per site was the largest attributed HASH-sidecar source in
self-hosted narrowing... this mutate-in-place form is required to stay
under [test/self-compile-perf.js's warm-instance ratio cap]."* That is a
measured, documented performance constraint on the *closure-sharing shape
itself*, not just a readability convenience — the kind of thing
`inferTypedValueRanges` has no analog of. A decomposition here would need
to either preserve object-reuse across a parameter-threaded version (likely
fine, but unverified) or risk regressing the exact metric this comment
guards. Sizing it (1,085 ln, ~20 nested closures, ~22 top-level fan-out) and
naming the risk is as far as this map goes — full closure-matrix treatment
of `narrowSignatures` is its own audit, sized like `vectorize-split.md`'s
own deferred `tryDivergentEscapeVectorize` (567 ln, flagged, not solved, in
that document either). It lands whole in `index.js` (§5) for the pure move;
nothing here blocks that.

One more small, separate finding while in the neighborhood: `inferTypedValueRanges`'s
return object `{ locals, summaries, hull, initialRange }` — `narrowSignatures`
reads `.locals` (line 2452), `.initialRange` (2456), and `.hull` (2460), but
grepping the whole repo for `typedValueRanges.summaries` (and `.summaries`
generally, on the returned binding) finds nothing — `summaries` appears to
be a dead return field. Not touched by this plan (logic-level, not a pure
move), flagged for the same follow-up as the dead `paramReps` parameter.

## 7. Verification recipe and risks

**Recipe** (house convention for this exact campaign — `.work/refactor-oracle.md`'s
rule: *"A pipeline-minimality slice merges only with `check --ref main`
clean, or with every difference documented"* — and the literal precedent,
`vectorize.js`'s own split merge commit: *"refactor oracle 560/560
identical"*):

1. `node scripts/refactor-oracle.mjs check --ref main` — must report clean.
   Since this is a pure move (no logic changes, confirmed by §3/§4), this
   should be the whole proof: byte-identical compiled WAT across the corpus
   at O0/O2/O3/size.
2. `npm test` (`node test/index.js`) — the main behavioral battery; directly
   exercises narrow.js via `pointers`, `data`, `closures`, `dyn-keys`,
   `inference`, `provenance-inference`, `unsigned`, `jsstring`, `booleans`
   (all confirmed present in `test/index.js`'s own list).
3. `node scripts/battery.mjs` — full gate (native/O0/O3/`dbg`=O3+`JZ_DEBUG_INVARIANTS`/wasi/kernel-on-wasm/functional
   self-compile/fuzz/fixpoint), ~15.5 min per this same campaign's M1 slice
   report. Matches the `DBG_INVARIANTS`-gated `assertValKindConsistent`
   calls this file makes at the end of `narrowSignatures`,
   `specializeBimorphicTyped`, `specializeValKindDichotomy`, and
   `speculateTypedParams` — all preserved verbatim by a pure move, but worth
   running the `dbg` leg specifically since it's the one that exercises them.
   **Known pre-existing failure, not a regression to chase**: per
   `.work/pipeline-minimality.md`'s M1 slice notes, `test/jsstring.js`
   "jsstring opt-in" already trips a ctx invariant under the `dbg` leg on a
   clean `d2c04d32` checkout — directly relevant here since `jsstring-carrier.js`
   is one of the 9 new modules.

**Risks:**

1. **Concurrent edit, `narrowBoolResults` (2925–2984 in this snapshot).**
   The task brief flags "another session has uncommitted edits in main's
   copy of narrow.js around lines 2950–2975" — independently corroborated
   by `.work/pipeline-minimality.md`'s M1b "No-go regions" list, which
   names the identical range: `` narrow.js 2950–2975 ``. That sub-range
   sits inside `narrowBoolResults`'s body (the `vt`/`evaluate`/
   `withFunctionFields` block, roughly lines 2950–2969). **Move
   `narrowBoolResults` into `results.js` verbatim only after that work
   lands** — the other 8 modules have no overlap with the flagged range and
   are move-ready now. This worktree's own copy currently matches `main`
   exactly (`git diff --stat main -- src/compile/narrow.js` is empty), so
   the uncommitted hunk lives only in some other live tree, not in any ref
   reachable from here.
2. **Line-number drift — observed, not just theoretical.** Between this
   analysis starting and this document being written, another session's
   walker-retrofit edits (this same campaign's M1b batch — `narrow.js` is
   explicitly in its scope) landed in this worktree: `main`'s copy is now
   161 lines diffed against it (68 insertions/93 deletions, file
   3,934→3,909 lines). Checked what actually moved, not just the delta:
   every touched hunk is a mechanical `const walk = (n) => {...}; walk(root)`
   → `walkAst(root, { enter: n => {...} })` conversion inside
   `localElemAuxMap`, `inferInternalArrayLengths`, `literalOrCallerParamInt`,
   `propagateCallForwarding`/`computeLocalRanges` (both nested in
   `inferTypedValueRanges`), two walkers inside `narrowSignatures`
   (`moduleSids`'s decl-scan, `bodyNameNullable`'s `nameNullable`), and
   `refineDynKeys` — same visit order/node set/closure-variable reads and
   writes, just the traversal helper swapped (this campaign's own documented
   byte-identity conversion contract, `.work/pipeline-minimality.md`). A
   name-level diff (`grep -oE` for every declaration keyword, old tree vs.
   new) confirms **zero top-level declarations added, removed, or renamed**
   — the family groupings, dependency edges, export list, and the §6 closure
   matrix are all still accurate; only line numbers moved, by single-digit
   amounts concentrated in the 8 functions just named. `computeDirectEffects`
   specifically (the one phase this document quotes most heavily) was not
   touched at all. Every range in §2/§5 is anchored to declaration **names**
   regardless; re-run `narrow-deps.mjs` (or a fresh `grep -n '^\(export
   \)\?\(function\|const\|class\)'`, remembering to also catch `export
   default function`, per the §-preamble correction) immediately before
   executing the move to get current line numbers — do not trust the exact
   numbers in this document by then, only the names and the structure.
3. **Doc-comment cross-references go stale.** `src/kind.js`,
   `src/session-views.js`, `src/reps.js`, `src/compile/flow-types.js`,
   `module/core.js`, and several `.work/*.md` files mention `narrow.js` by
   name in prose (confirmed comments, not imports, in §1). Harmless to the
   move and invisible to the oracle/tests either way — not a blocking risk,
   just won't be caught by any automated gate if someone wants to update
   them for freshness.
4. **Two self-host-miscompile landmines to leave untouched, both already
   flagged in the source, both irrelevant to a pure move but worth
   restating so nobody "cleans up" a diff mid-move:**
   - `specializeBimorphicTyped`'s comment at line ~3314 warns that a
     for-of loop variable name colliding with an earlier block-scoped
     declaration currently miscompiles under the self-host (aliases the
     prior binding instead of rebinding per iteration) — the code already
     works around it with a deliberately unique variable name; a
     reflowed/renamed version during the move must keep that uniqueness.
   - `narrowSignatures`'s `sharedSiteState` reuse (§6, "flagged, not
     solved") — moving the whole function verbatim into `index.js`
     preserves it; nothing to do here, just don't "simplify" it in the same
     commit as the move.
5. **Shim correctness is mechanical, not risky**, but worth stating the
   check: after the move, `grep -rn "from '\.\./narrow\.js'\|from '\./narrow\.js'"`
   across `src/compile/` should still show exactly the same 3 files/lines
   as §1, unchanged.
