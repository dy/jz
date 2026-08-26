# Pipeline audit (agent, 2026-08-20) — complements the external audit of 11588771

## JZ Compiler Pipeline Audit — Findings Report

Read `.work/research.md` (23,330 lines) and `.work/todo.md` (11,711 lines) headers plus the targeted design docs (`walk-count-design.md`, `carrier-representation-design.md`) before touching source, per instructions. This codebase runs its own continuous audit practice — CONSISTENCY-AUDIT sweeps, `audit-#11` through `#19`, a dedicated walk-count campaign — so a large fraction of what a naive audit would flag is already found, fixed, or explicitly rejected with reasoning on record. Findings below are marked **NEW** or **KNOWN, BANKED** accordingly. Every walker/line-count/gap claim was machine-verified against current HEAD (not the design docs' snapshot); the dispatch-bench claim was verified by actually compiling it.

---

### 1. NEW — No shared AST traversal combinator: 227 hand-rolled recursive descents across 35 files

**Evidence.** `grep -rnE "^\s*(const|function)\s+(walk|visit|scan|traverse|recurse)[A-Za-z]*\s*[=(]" src/ jzify/ module/` → **227** definitions, machine-counted (`wc -l`), across 35 files. Concentration: `src/optimize/index.js` 51, `src/optimize/vectorize.js` 31, `src/compile/narrow.js` 15, `src/type.js` 12, `src/prepare/index.js` 12, `src/compile/program-facts.js` 10, `src/compile/analyze.js` 10, `src/wat/assemble.js` 9, `src/compile/plan/scope.js` 8. Each is an independent `if (!Array.isArray(n)) return; … for (i=1;i<n.length;i++) recurse(n[i])`-shaped closure with its own scope-boundary policy (does it stop at `=>`? handle `let`/`const` specially? recurse into `catch`?).

Confirmed three concretely-distinct "collect names bound in this subtree" implementations with different, individually-correct-but-undocumented-relative-to-each-other contracts: `collectAllBoundNames` (`src/ast.js:495-507`, deliberately position-insensitive, recurses into nested arrows — for shadow detection), `functionLocals`/`scan` (`src/prepare/lift-iife.js:77-88`, deliberately stops at `=>` — single-frame locals only), and `boxedCaptures`'s own `collectDecls` (`src/compile/analyze-scans.js:88-95`, same single-frame contract as `lift-iife.js`, written independently). The user-named "`findFreeVars` in analyze-scans vs lift-iife" pair turned out **not** to be duplicated — `liftIIFEs` correctly calls the canonical `findFreeVars`/`findMutations` (`lift-iife.js:131,134` → `analyze-scans.js:15,67`) — but the *locals-collector* it needs as an input is reimplemented locally instead of reusing `collectAllBoundNames`.

**Known precedent, narrower scope.** `.work/walk-count-design.md:80-82` diagnoses this exact pattern but scopes it to **one file**: "No shared generic walker exists (`src/ast.js` has none) — each of the 8 is its own hand-written recursive descent… historical accretion." Two of that design's slices landed (`624c53c3`, 2026-08-17/18: A1 fused `scanFlatObjects`/`scanSliceViews`/`scanNeverGrown` → `scanObjectArrayFacts`, `analyze.js:998`; B1 promoted `sigFingerprint` to a live cache-coherence gate, `analyze.js:270-284`, confirmed live at `index.js:633`'s "not a forced reanalyzeBody" comment). `analyzeBody`'s own chain is now 6 traversals, not 8 (`analyze.js:958,964,965,970,982,998`) — A2 (fold `scanNumericFill` into `walk`) not landed. C1/C2 (worklist-convert the plan-tail duplicates) were **attempted and explicitly voided** (`67c6fd09`): in-window AST rewrites invalidate any pre-recorded site list; sound shape needs a mutation delta-log, not a return-contract change — correctly banked, not a live gap.

**Class size.** 227 sites, but the *pattern* — not the combinator — is what's missing; this is the mechanism that makes it cheap to add walk #9 instead of a dispatch arm in an existing walk, which is exactly how `analyzeBody` got to 8 in the first place.

**Canonical form.** A `walkAst(node, {enter, boundary})` combinator in `ast.js`, adopted at new call sites first (zero regression risk — additive), then retrofitted into the two concentration files (`optimize/index.js`, `vectorize.js`) where 3-5 near-identical walkers often coexist in the same function.

**Risk.** Low to introduce; medium-high to retrofit onto 227 existing sites — but this codebase already has the gate discipline for it (byte-identity corpus + kernel-parity + fuzz, the same bar every CONSISTENCY-AUDIT task above held itself to).

**Payoff.** Directly on the critical path of the user's own "ready for lowering to native downstream" bar, since `jz×jz` (jz compiling itself) is the acceptance target for the memory/size goal gates — see Finding 2.

---

### 2. KNOWN, BANKED — Diffuse multi-pass cost between `narrowSignatures` and `analyzeFuncForEmit` is the largest *unfixed* redundant-walk cost in the pipeline

Not my finding — citing per instructions because it's the single biggest number on record and directly answers axis 2. `.work/research.md` (§ "`analyzeFuncForEmit`'s OWN clone-shape instances FIXED…", 2026-08-13): three real per-call clone duplicates were fixed and verified small, but "the real ~2.1 GB burn is DIFFUSE across a dozen-plus whole-program passes between `narrowSignatures` and `analyzeFuncForEmit`'s own first call, a NEW, unfixed pathology class this session BANKS, not chases." `narrow.js`'s own O(functions×params×callSites) census was separately root-caused and fixed (`13192-13292` in research.md, landed) — the diffuse dozen-plus-pass cost survived that fix and remains open. Still blocks the `jz×jz` self-compile memory goal gate as of `.work/research.md`'s last Region-arena entries (14707-14915: front boundary closed, but the goal gate itself "NOT MET, both configs hit the wasm32 4 GiB hard ceiling"). Rank this #1 by *cost*, #2 by *novelty* — a fresh reader of this report needs to know the biggest fish was already hooked and is still fighting.

---

### 3. NEW, bench-verified — No indexed/computed dispatch-table lowering; `bench/dispatch` compiles to a bare `call_indirect`

**Evidence, empirically obtained** (compiled, not inferred): `node cli.js bench/dispatch/dispatch.js -O3 --wat` → output contains **1 `call_indirect`, 0 `br_table`**. `bench/dispatch/dispatch.js`'s own header names the exact class this tests: *"the canonical dynamic-dispatch kernel… past 4 targets a JIT's call inline-cache goes megamorphic — the classic deopt shape — while an AOT compiler must make the indirect call itself cheap."* The source is `ops[code[i]](x, ks[i])` — a `const` array of 8 arrow closures, indexed by a runtime-varying, bounded (`& (NOPS-1)`-shaped) value at one call site.

jz's only lever for "devirtualize a call through a const function array" is `devirtConstFnArrayCalls` (`src/optimize/index.js:5124`, gate `hi - lo > 32` at line 5147, generous headroom for 8 targets) — but its own code shows it's keyed by `cfa.get(node.dvArr)` against **per-candidate known constant indices** (`c.idx`, line 5171): it turns *N static call sites each with a known constant index* into inlined direct calls. It has no mechanism for *one call site with a runtime-varying index over a small bounded domain* — which is precisely the shape a `br_table` (a jump table `devirtConstFnArrayCalls` already knows how to build, lines 5170-5182) would resolve directly: emit the same "AOT equivalent of the switch a JIT synthesizes for a hot polymorphic table" (the pass's own comment, line 5185-5186) keyed on the *runtime* index instead of a compile-time-known one.

Calibration check (so this isn't a blind "jz can't do dispatch" claim): `bench/vm/vm.js` — a genuinely different shape, an `if(op===0){}else if(op===1){}…` branch chain, explicitly "no switch" per its own header — **does** produce 1 `br_table` in jz's O3 output (verified the same way). So the gap is precisely bounded: array-of-closures-indexed-by-runtime-value is uncovered; dense if/else opcode chains are already handled by something in the pipeline.

**Class size.** Interpreter loops, virtual/strategy-table dispatch, event pipelines, effect chains — a named, general pattern (the bench file's own framing), not a one-off. `bench/dispatch` and the dispatch component inside `bench/vm`/`bench/tokenizer`-shaped code are the direct beneficiaries.

**Canonical form.** Extend `devirtConstFnArrayCalls` (not a new subsystem — the `br_table`-building machinery at lines 5170-5182 already exists) to recognize: single call site, index expression provably bounded to `[0,N)` at compile time, `N` below a size threshold → build the same `br_table` keyed on the live index instead of per-candidate constants. The range-proof this needs (is `code[i] & 7` bounded?) is exactly what the `narrow.js`/`static.js` int-range family (`intExprRange`, `typedValueExprRange`) already computes elsewhere in the pipeline.

**Risk.** Medium — needs a real soundness proof for "index is bounded," not just "index came from a mask op"; must not fire on an unproven range (silent OOB `br_table` default-arm fallthrough already exists in the const-array version and should transfer).

**Payoff.** High, and precisely on the user's stated bar: this is a class-level lever named by a bench file the user's own suite ships, not a bench-specific hack.

**Retracted by re-audit.** False finding — current lowering is intentional and measured faster (seltree 4.2×).

---

### 4. NEW — `valTypeOf`/`valTypeOfWithLocals`/`inferValType`: justified fork, but `inferValType` silently drops local-awareness for compound call-site arguments

**Evidence.** `valTypeOf` (`src/kind.js:1210-1235`, global-only dispatch table `VT[op]`). `valTypeOfWithLocals` (`src/kind.js:1260-1382`, 123 lines) is a **documented, deliberate near-duplicate**: it re-implements the `?:`/`&&`/`||`/`+`/arithmetic-bitwise/unary/method-call arms already present in `VT[op]` — the doc comment (`1237-1259`) explains precisely why: falling through early to plain `valTypeOf` would silently discard a locally-proven BigInt fact and misroute a result to the wrong export lane, a real, cited miscompile class. This is real, tested, load-bearing divergence, not carelessness.

`inferValType` (`src/compile/infer.js:416-419`) is a **third, narrower** sibling used at call sites (`narrow.js:1888,3422`): `if (typeof expr === 'string') return callerValTypes?.get(expr) || ctx.scope.globalValTypes?.get(expr) || null; return valTypeOf(expr)`. For a bare-identifier argument it's locals-aware; for a **compound** argument (`f(x + y)` where `x`,`y` are locally-proven BigInt) it falls through to plain global-only `valTypeOf`, **not** `valTypeOfWithLocals` — the exact class of miscompile `valTypeOfWithLocals`'s own comment block was written to eliminate, just at the call-site-argument boundary instead of the return boundary. `.work/todo.md:9326` documents this as *deliberate* ("inferValType is deliberately the plain call-site inferrer, not `inferValAtSite`'s full enrichment… a strictly narrower, safe-direction re-derivation") for one specific specialization slice — but I did not find a blanket safety argument that every `inferValType` call site tolerates this narrowing; this is a structural risk grounded in the code's own stated invariants, not a confirmed failing repro.

**Class size.** 3 entry points, ~15 call sites combined (`narrow.js` D/G-phase call-site and return inference).

**Canonical form.** One `resolveKind(expr, {locals, callerCtx})`, with `valTypeOf`/`valTypeOfWithLocals`/`inferValType` becoming call sites of it at their current granularity (locals=null / locals=resolveLocal / locals=callerValTypes-bare-name-only).

**Risk.** Medium — `narrow.js`'s call-site inference was deliberately kept narrow for specific specialization slices; widening it changes which call sites qualify for cloning (byte-identity-relevant), so any unification must preserve the narrow behavior as an explicit mode, not silently widen it.

**Payoff.** Removes a latent-correctness-adjacent gap plus one of three near-synonym entry points.

---

### 5. NEW — Extreme function/file-size outliers, causally downstream of Finding 1

**Evidence.**
- `module/collection.js:1269-3787` — `genUpsertStrictPrehashed`, **2519 lines**, verified by brace-balance (not a regex artifact) — 64% of its own 3916-line file in one function. Predominantly a hand-authored WAT-text template literal (not JS control-flow spaghetti) — an unusual but not indefensible low-level codegen strategy for hot Map/Set primitives, still fails "grasp without documentation."
- `src/compile/emit.js:5110-7193` — `emitInstanceof`, **2084 lines**.
- `src/compile/narrow.js:1566-2875` — `inferTypedValueRanges`, **1310 lines** at current HEAD. Partially addressed already: `.work/todo.md`'s "CONSISTENCY-AUDIT ITEM 4" (2026-08-09) extracted the range algebra to `static.js` and split the body into 3 named nested phases (`computeDirectEffects`/`propagateCallForwarding`/`computeLocalRanges`) — kept **nested, not hoisted**, deliberately, to avoid threading closure state as explicit params. Correct call at the time; still shows as 1310 raw lines to a reader. **KNOWN, partially banked** — cite, don't re-claim.
- 8 files exceed 3000 lines: `vectorize.js` 8480, `emit.js` 7442, `optimize/index.js` 5408, `prepare/index.js` 4147, `collection.js` 3916, `narrow.js` 3910, `analyze.js` 3406, `core.js` 3280, `compile/index.js` 3143. `vectorize.js`+`optimize/index.js` together = 13,888 lines and, per Finding 1, hold 82 of the 227 hand-rolled walkers — directly linking file bloat to the missing-combinator root cause rather than treating them as independent symptoms.

**Canonical form.** `genUpsertStrictPrehashed` already branches on `entrySize`/`eqExpr`/`expectedType`/`hasVal` — those are natural sub-template extraction boundaries. `emitInstanceof` likely decomposes per representation class (Array/TypedArray family/Map/Set/Error family/user class) the way `optimize/index.js`'s own multi-hundred-line functions do.

**Risk.** Low-medium, mechanical, byte-identity-gatable exactly like every refactor this codebase already gates.

**Payoff.** Navigability only — zero perf/size effect expected from pure extraction.

---

### 6. NEW — Schema/shape resolution: 6-entry family, one is a literal redundant alias

**Evidence.** `sourceSchema` (`module/object.js:895`) **is defined as** `(obj) => resolveSchema(obj)` — a same-file, same-module, zero-behavior-difference alias of `resolveSchema` (`object.js:919`) under a third name (the first being `ctx.schema.resolveExpr`, aliased to `resolveSchema` at `object.js:58`). `spreadSourceSchema` (`object.js:951`) wraps `sourceSchema` with one param-guard. Adjacent, differently-scoped family members: `shapeOf`/`shapeOfObjectLiteralAst`/`shapeOfJsonValue` (`kind.js:1480,1565,1406`), `inferSchemaId` (`infer.js:455`), `inferSchemaBranch` (`flow-types.js:311`, its own local `walk`, one more instance of Finding 1's pattern). Each pairwise divergence I checked was individually justified (e.g., `spreadSourceSchema` deliberately treats params as unknown to keep analysis/emit in agreement, documented at `951-954`) — but `sourceSchema` ≡ `resolveSchema` is not a divergence, it's a spare name.

**Canonical form.** Delete `sourceSchema`, inline `resolveSchema` at its 1 call site (`951`). Trivial, safe, immediate. The broader 6-entry family is a candidate for the same umbrella as Finding 4 (fundamentally the same "static fact about an expression" lattice, split by which file happened to need it first).

**Risk.** Near-zero for the alias deletion; medium for the broader fold (schema resolution is load-bearing — CONSISTENCY-AUDIT task 2's own `litVal`/`cloneNode` dedup work shows how much per-caller contract-checking this class of change needs even when it looks trivial).

**Payoff.** Small but free (the alias); modest navigability gain for the rest.

---

### 7. NEW — CSE is split across two pipeline levels with no unifying "redundant load" concept

**Evidence.** `src/compile/cse-load.js` (AST-level, pre-emit, header: "Sound CSE of repeated pure typed-array element loads… provablyDiffer: distinct int constants, or `idx2 = idx ± P` with P provably > 0"). `src/optimize/index.js:1613` `cseScalarLoad` (WAT-level, post-emit, header: "candidacy is the emit-side `cseSafeLoadBases` whitelist… proof is carried from emit… never re-guessed at WAT level") — struct/object field scalar loads, a **different value domain**, explicitly designed to consume a proof computed one level up rather than re-derive it. Both are individually sound and well-documented; there's a third, genuinely reusable piece — `regionTrackCSE` (`optimize/index.js:331`, a generic region-based CSE combinator parameterized by `matchSite`) — called by 2 sites (`optimize/index.js:299,495`), which is the pattern the rest of the codebase should be following (contrast with Finding 1).

**Class size.** 2 domain-specific CSE implementations (array-element loads, struct-field loads); no generalization to e.g. redundant pure-call results or redundant computed-property reads.

**Canonical form.** Not a merge (the two proof mechanisms are legitimately different-level) — a shared "redundant load elimination" *concept* with `cse-load.js` and `cseScalarLoad` as two policy instances over one region-tracking engine, mirroring `regionTrackCSE`'s own existing shape.

**Risk.** Low to formalize as documentation/shared combinator; medium if actually merging soundness proofs.

**Payoff.** Architectural clarity; no named bench case verified this session (unlike Finding 3) — reported as a structural gap, not a proven regression, per the rigor the brief asks for.

---

### 8. NEW, soft finding — Two-tier inlining without a boundary contract comment

**Evidence.** `src/compile/plan/inline.js` (899 lines, AST-level: `inlineHotInternalCalls`/`inlineLocalLambdas`/`specializeFixedRestCalls`, threshold-gated by call-site count/loop depth/escaping) runs before `watr-tail.js`'s WAT-level `watr`'s own `inline`/`inlineWrappers` (gated `cfg.inlineFns`, speed-tier only, `watr-tail.js:52-64`). Unlike the CSE boundary (Finding 7) or `watr-tail.js`'s own header ("One module so the two pipelines cannot drift"), `plan/inline.js`'s header does not reference the WAT-level inliner at all — no stated contract for what happens when both stages want to inline the same call, or whether their size/hot-call heuristics can disagree.

**Risk of the gap itself:** unverified — I did not find or construct evidence of actual double-work or conflicting decisions, only an absence of the cross-referencing discipline present elsewhere in this same codebase.

**Canonical form.** A short header note in `plan/inline.js` (mirroring `cse-load.js`'s or `watr-tail.js`'s own style) stating the division of labor and why running both is safe/non-redundant.

**Risk.** Near-zero (documentation-only fix).

**Payoff.** Closes a verification gap for future maintainers; low urgency, included for completeness on axis 4.

---

### 9. NEW — Naming-convention fragmentation for "derive a static fact about an expression"

**Evidence.** Five different lead verbs cover overlapping "what does this expression statically resolve to" territory: `valTypeOf`/`valTypeOfWithLocals` (kind.js), `inferValType`/`inferSchemaId` (infer.js), `resolveSchema`/`ctx.schema.resolve` (object.js/schema.js), `shapeOf`/`shapeOfObjectLiteralAst` (kind.js), `spreadSourceSchema`/`sourceSchema` (object.js). No verb-to-file mapping a newcomer could predict from the name alone (why is kind inferred with `valTypeOf` but schema resolved with `resolveSchema`, both in overlapping files, both queried from `narrow.js`?).

**Class size.** ~12 functions across 4 files (kind.js, infer.js, object.js, flow-types.js).

**Canonical form.** Not a rename-everything project (churn risk far exceeds payoff given CONSISTENCY-AUDIT's own precedent of how carefully even `litVal`'s 3-way rename was staged) — a documented naming convention (e.g., `valTypeOf*` = kind lattice, `resolve*Schema` = shape lattice) stated once in `CONTRIBUTING.md`, which already hosts the stdlib `reg()`/raw convention from the 2026-08-09 sweep.

**Risk.** Low (docs-only) to zero-risk if no renames are attempted.

**Payoff.** Modest, direct navigability improvement — closest match to the literal "naming inconsistencies" ask.

---

### 10. NEW — Ad-hoc/symptomatic-fix axis is genuinely low-yield; report that honestly rather than force findings

**Evidence.** `grep -rniE "workaround|kludge|hack:|hacky|symptom|band-?aid"` across ~94,000 lines of `src/`+`jzify/`+`module/` → **5 hits total**. Of those: 1 is dead/obsolete by its own comment (`module/math.js:571`), 3 describe a symptom under *investigation* (not code that *is* the workaround), and exactly **1 is a genuine, self-labeled workaround**: `src/bignum.js:30-41` — 15-bit limbs chosen specifically to sidestep a compiler self-hosting bug ("compiling `midLo * 65536`… produced -2147483648… a compiler-narrowing bug, not an algorithm bug"), explicitly labeled *"This is a workaround for the compiler's own bootstrap, not a general fix to `mulFitsI32`… out of this audit's scope"* — fully scoped, fully documented, points at the exact general mechanism (`mulFitsI32` in emit.js) that would subsume it. This is the correctly-handled case the brief's "load-bearing vs. true ad-hoc" distinction asks for: a true ad-hoc that is honestly labeled as one rather than hidden.

Broader markers (`special-case`, `for now`, `temporarily`) resolve almost entirely to either negated assertions ("doesn't special-case", "not by special-casing") or individually-justified branches with paragraph-length invariant proofs (e.g., `kind.js:1358-1374`'s method-call receiver-kind gate). Separately: **KNOWN, BANKED** — `.work/todo.md:11465-11483`, "AdHocMemo retirement" (`e8510fe4`, 2026-08-12) already consolidated 6 hand-rolled single-slot memo caches into `ctx.js`'s `getFactStore()` WeakMap fields; the CONSISTENCY-AUDIT sweep (2026-08-09, `.work/todo.md:8995-9264`) already found and fixed 9 duplicate deep-clone helpers, 3 `cloneNode` duplicates, a 3-way `litVal` naming split, and a stdlib registration split-brain, all gated and landed.

**Verdict for this axis:** low yield is itself the finding — this codebase's dominant comment culture ("root-caused", "INVARIANT", "banked not chased") has already suppressed the pattern axis 3 was built to catch. Don't force weak findings to fill a quota; report the one real hit precisely and move on.

---

## Cross-reference: other known/banked items overlapping this brief (not re-reported)

- **Middle-end consolidation plan** (`research.md:693-714`) — the strategic umbrella under which Findings 1, 2, and 6 already sit: "one fact solver, frozen plans" (slices 1-4 DONE), BindingId totality (DONE), pass-registry (DONE); open items named by the plan's own authors: ~31 `analyzeBody` call sites still on hand-placed invalidation (Finding 1/2's exact territory), CompileSession phase views (~43 ctx importers), per-domain worklists.
- **RepPlan v2** (`.work/representation-plan-v2-design.md`) — explicitly claims `narrow.js`/`reps.js`/`kind.js`/`analyze.js` as its own consolidation territory; `walk-count-design.md §6` maps exactly which of *its own* slices collide with RepPlan v2 and in what order to land them. Any actual work on Findings 1 or 4 should sequence against this, not duplicate its planning.
- **watr-tail.js unification** (`src/optimize/watr-tail.js:1-14`) — cited as a positive calibration point, not a problem: the native pipeline and the self-compile kernel share this one module by explicit design ("so the two pipelines cannot drift… kernel O2/O3 output diverged from native on the same source" before this fix), with a stated invariant ("NO post-watr generic optimizer"). Proof the codebase reaches the user's unification bar when it tries — sharpens rather than undercuts the gaps found above.
- **Region-arena / escape analysis** — by far the most sophisticated, most heavily instrumented program in the entire research log (thousands of lines, dozens of root-cause sessions). This is **not** a class-level gap versus mainstream compilers; if anything it's further along than most WASM-targeting AOT compilers attempt. Not reported as a Finding 5-style gap for that reason.
- **Call-site specialization** (`specializeBimorphicTyped`, `specializeValKindDichotomy`) — a genuine AOT analog of V8-style inline-cache/hidden-class specialization, capped at `MAX_CLONES_PER_FN = 4` (`narrow.js:3208`) and explicitly bimorphic (2-shape) by name. Finding 3 (dispatch bench) is the concrete, verified manifestation of this cap's edge; not re-listed separately.

---

## Verdict

The pipeline is not the ad-hoc-patch-encrusted system the brief's method worried about finding — the dominant defect class this audit surfaces is **proliferation by justified accretion**, not carelessness: nearly every duplication traced back to a real, tested, documented reason (valTypeOf's locals-aware sibling exists because an early return once caused a live miscompile; the two CSE passes exist because they carry different soundness proofs from different pipeline stages), which is exactly why they've survived — each one individually defensible, collectively a comprehension tax and, in `analyzeBody`'s now-partially-fixed 8-pass history, a measured memory cost. The single conceptual fix with the highest leverage is Finding 1: there is no shared AST-traversal combinator anywhere in `src/ast.js`, so every new fact family reaches for a fresh hand-rolled recursive descent (227 of them) instead of a dispatch arm in an existing one — this is the mechanism, not merely a symptom, behind the redundant-walk cost the project's own walk-count campaign is still chasing (Finding 2, banked, unfixed, and the actual blocker on the stated jz×jz/native-lowering goal) and a direct contributor to the eight files over 3,000 lines. The codebase already has the right instinct and the right gate discipline to fix this (CONSISTENCY-AUDIT's own track record proves it can execute exactly this kind of consolidation safely) — what's missing is treating "no shared walker" as the named architectural item it deserves to be, at the same tier as the Middle-end consolidation plan and RepPlan v2 it currently sits underneath unnamed.
