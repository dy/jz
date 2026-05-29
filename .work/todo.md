# ⟢⟢ MASTER PLAN (third-party audit 2026-05-29) — AUTHORITATIVE

The external audit's 5 conceptual ROOTS + 8-step sequence supersede the older
ordering below. Fuzzer-first dependency is satisfied → execute 1→8 in order;
do NOT start the lattice (8) before 1–5. Verify every step against the fuzzer +
suite + perf-fuzzer. Safety net = `npm test` 1912 pass, opt0/1/2/3 + wasi all green.

## The 5 roots (fix the principle, not the bug)
- **A**: analyzeBody isn't pure (reads ctx.func.localReps/scope) but caches on
  body-node identity → 9 manual invalidations + a 2nd ctx-mutating walk
  (analyzeValTypes) duplicating trackVal/trackTyped. (todo #3, #5)
- **B**: narrowing has no declared lattice — phases substitute for monotonicity:
  runFixpoint×6, clearStickyNull×3 (= non-monotonicity evidence: `undefined`(unknown)
  conflated with `null`(conflicted)). (todo #2) **Highest leverage.**
- **A+B meta-root**: analysis grew by accretion. Canonical fix: declare
  `BOTTOM=Symbol('unknown') ≠ TOP=null(conflicted)`, `meet=(a,b)=>a===b?a:TOP`;
  collapse the 10-phase script into ONE call-graph-ordered Kildall fixpoint.
- **C**: emit writes analysis state (emitDecl→updateRep/schema.vars/directClosures;
  array.js updateRep in `[]`; ctx.func.uniq++ from ~20 sites) → decl ordering
  load-bearing. (surviving leak past the closed #7)
- **D**: no authoritative registry — bridge.js bypassed by 6/8 modules;
  addImportOnce ×3; __schema_tbl ×5; isBoundName ×4. (DRY root)
- **E**: ValueRep open `{...prev,...fields}`, no validation; 12-field shape only
  in a debug util (missing carrier/unsigned); typo → silent undefined. (todo #1)

## Sequenced plan (audit §7) — each maps the findings it closes
1. **✅ DONE — Correctness-gate gaps** (S, zero risk): test262 LANGUAGE in-scope
   `fail===0` gate + `xfail` bucketing + `xpass` prune-gate (C1, mirrors builtins);
   determinism test same-src→byte-identical across opt levels (C6); fuzzer runs all 4
   opt levels (confirmed). The gate immediately surfaced 2 real miscompiles (below).
2. **Document divergences** (S, no code): README — asm.js i32-wrap contract, `**0.5`
   corners, `__ftoa` 9-sig-digit cap (MOD-5, real divergence); fix stale index.js:392
   comment ("if level-2 flips watr on" — already on); be honest re <2K vision.
3. **Activate the net** (S): wire `assertCtxInvariants()` into jzCompileInner (ARCH-3,
   dead code → the refactor net); fix ctx ownership table drift (ARCH-2: core/string
   write ctx.scope.globals from emit — now via hostGlobals; add ctx.bridge/ctx.abi rows;
   emit reads ctx.transform); #8 is COMPLETE (no inline reversals remain — MOD-6 stale).
4. **🔶 MOSTLY DONE — Mechanical DRY** (S–M, low risk):
   - ✅ hostImport() in bridge → MOD-2 (killed addImportOnce ×3 in timer/number/console).
   - ✅ closed ValueRep @typedef + REP_FIELDS single-source + dev-mode updateRep/
     updateGlobalRep validator (F4/E); repView iterates REP_FIELDS (gained carrier/
     unsigned); field set verified complete under JZ_DEBUG_INVARIANTS=1.
   - ✅ isBoundName ×4 (SMELLS-F5) — folded the 4 inline local-or-param checks.
   - ✅ makeValTracker/makeTypedTracker (F1) — DONE. Both walks' val + typed-ctor
     trackers (analyzeBody local Maps, analyzeValTypes ctx slices) now share one
     factory each, store-parameterized; they can't drift. (The deeper two-walk root-A
     issue itself remains — see Remaining frontier.) Verified determinism byte-identical.
   - ⏸ ARCH-1 (prepare→compile/* imports) → DEFERRED (low value, half-fixable).
     observeNodeFacts is a pure AST observer (movable to ast.js), but recordGlobalRep
     is stateful (writes ctx.scope/runtime, needs valTypeOf/typedElemCtor) — moving it
     to reps.js would invert the leaf dep and cycle. Prepare legitimately needs it
     cross-phase, so the layering edge stays; moving only observeNodeFacts wouldn't
     remove prepare's compile/* dependency. Not worth a partial abstraction.
5. **Seal the emit boundary** (M, fuzz-gate each step): collectDeclFacts() pre-emit pass
   (E1/E6, Root C); sanction ctx.core.withLoop()/declareLocal() APIs (MOD-4, Root C);
   route jzifyError through err() (SMELLS-F3) ✅ DONE.
   - ⏸ collectDeclFacts() pre-emit pass (E1/E6, Root C) → DEFERRED, fold into step 8.
     It decouples analysis-state writes from emission order — the SAME concern as the
     lattice (analysis vs emit). Doing it separately double-churns analyze/emit; do it
     as part of the step-8 analysis pass. declareLocal/withLoop (MOD-4) is local
     *allocation* (emit's legit job), not an analysis-write leak — `freshLocal`/`temp`
     already exist in ir.js; adopting them at the 25 raw `uniq++` sites is a cosmetic
     DRY, not boundary-sealing. Low priority.
6. **✅ DONE — Decompose mega-functions** (M):
   - ✅ emitMethodCall strategies 1–4 → LEADING_STRATEGIES table (E2). Remaining 8
     positions thread shared vt/callMethod state and stay inline (readable, commented).
   - ✅ sidecarOverride (E4) extracted to ir.js — the valueOf/toString ToPrimitive
     probe, formerly coded twice (core.js read path + emit.js call path).
   - ✅ emitDecl (emit.js:608, wired at 'let'/'const') and ctx.core.emit['.'] router
     (core.js:726) ALREADY EXISTED — the audit's suggestions there were stale.
7. **✅ DONE — Full CI matrix**: opt0/opt1/opt3/wasi all in test.yml, all green.
8. **✅ DONE — The lattice refactor** (L, highest leverage): Roots A+B. Lattice DECLARED
   (param-reps.js: BOTTOM=undefined ≠ TOP=null, monotone meet) and **ALL 3 clearStickyNull
   ELIMINATED** — the function is deleted; the param lattice is now monotone (no resets).
   Two complementary moves, no meet hack:
     - HOIST narrowValResults (body-driven, self-fixpointing, independent of param facts)
       above the param lattice → a call arg `f()` resolves to its VAL result on pass 1,
       so the hard merge never sticky-poisons it (killed clearStickyNull #1+#2: val+schemaId).
     - SOFT `val` merge (skip can't-tell = BOTTOM, never poison) → the TYPED-param case,
       whose val is only known post-pointer-enrichment, fills in on the later rerun
       instead of staying stuck (killed clearStickyNull #3). Soundness: the one
       signature-mutating early consumer (applyPointerParamAbi) re-folds sites HARD via
       hardParamVal (soft r.val may be a partial consensus); a final hard sweep settles
       val for emit + late readers (specializeBimorphicTyped, applyI32 skipTyped guard).
       schemaId/wasm/intConst stay hard (no stuck poison now that valResult is first).
   Verified full gauntlet: suite 1914/0, test262 1437/0/3, fuzz 2000 (only pre-existing
   within-contract seed 1809), matrix 5/5, bench jz 1.00–1.27× checksums-identical (no
   regress). (An earlier soft+pre-consumer-hard-sweep attempt was reverted — the sweep
   ran before valResult and over-poisoned not-ready; the narrowValResults hoist + the
   hardParamVal self-validation is what made soft sound.) Also fixed a pre-existing wasi
   Date-clock test flake surfaced by the gauntlet.
   STILL OPEN (separate, lower-value): collectDeclFacts (step 5, Root C) + the wasm
   field's resetParamWasmFacts non-monotonicity (exprType reads mutated sig.results —
   needs result-wasm-type modeled as a fact). Root A (analyzeBody purity) also remains.

## Optimizer (parallel track, not blocking)
- OPT-1: the 3089-line src/wat/optimize.js — header now states jz OWNS it (sync is
  jz→upstream, e.g. branch-fold port), so the silent-drift concern is largely moot;
  a FORK.md would be low-value. Leave as-is.
- OPT-2: ✅ `__phase:'post'` side-channel → explicit `phase` arg (done). REMAINING:
  eliminate the 2nd optimizeFunc pass entirely by teaching fusedRewrite to fold
  i32.wrap_i64(i64.reinterpret_f64 x) — deeper optimizer change, deferred.
- #4a cseScalarLoad explicit proof (low value). #4b vectorizer: no-change (documented).

## ⟢ Remaining frontier — ASSESSED: fixes would NOT increase elegance/compactness
Rigorous code-level pass (2026-05-29): each remaining root is a LOAD-BEARING or
LEGITIMATE-PHASED pattern, not an extractable smell. A fix would ADD machinery,
regress perf, or merge distinct concerns — i.e. *decrease* the qualities we'd be
chasing. The clean wins are already taken (roots B, E; F1; steps 1–8; OPT-2). Leave
these unless a concrete need arises; recorded so a future attempt starts from evidence.
- **Root A — two walks**: analyzeValTypes ≠ a re-walk of analyzeBody — it does MORE
  (jsonShape, ctx.schema.vars binding, regex, `.map()` typed-propagation, arr-elem
  schema inheritance) and WRITES ctx for emit, while analyzeBody returns cached pure
  facts for other callers. Different purposes → merging = bigger + mixes pure/effectful.
  F1 already deduped the only truly-identical part (the val/typed trackers).
- **Root A — caching (8 invalidateLocalsCache)**: each is surgical + correct (per-func
  after a specific ctx mutation; different scopes, not consolidatable). Auto-invalidation
  (generation bump per mutation) would invalidate every call → kills the cache (perf).
  The surgical invalidations ARE the right perf/clarity tradeoff. A debug recompute-vs-
  cache net (JZ_DEBUG_CACHE) was BUILT + ABANDONED: it fires on benign staleness (a
  `let x = f()` local's wasm type shifts after f's result narrows, but the suite stays
  green through it), so it can't separate a real missing-invalidation from a harmless
  one — false positives, not viable. Deeper lesson: the cache is *intentionally
  staleable* (fresh where consumed critically, not "never stale"), which is why a simple
  invariant can't guard it. (Documented in analyzeBody's header.)
- **Root C (collectDeclFacts)**: emit's rep-writes (emit.js:755–775) read `val.ptrKind`
  / `val.ptrAux` off the EMITTED RHS — emit-time-only, can't move to a pre-pass.
  analyzeValTypes already pre-computes the AST-derivable facts; collectDeclFacts would
  duplicate it, not simplify. The decl-order coupling is source-order (correct), documented.
- **wasm resetParamWasmFacts**: a correct, surgical, documented PHASED re-observation
  (re-read wasm after result-i32 narrowing) — NOT a spurious-poison smell like
  clearStickyNull. A soft-merge "fix" needs wasmAtSite + hardParamWasm (applyI32 trusts
  r.wasm, no per-site recheck) + a final sweep = ~+20 lines to remove ~4, plus the
  param↔result i32 cycle's perf-convergence risk. Adds machinery; not a compactness win.

## Missing constructs to ADD (prevent future ad-hocs)
declared lattice (→8); enforced module-registration startup check (→Root D); closed
ValueRep typedef+validator (→4); live phase invariants (→3); generative fuzzer for
strings/arrays/objects (currently scalar-numeric only — NaN-box/optional-chain have
zero generative coverage); test262 language fail===0 (→1); determinism test (→1).

## DONE (this milestone, committed)
**Step 1 (correctness gates) + 2 miscompiles it caught** (pending commit): test262
language in-scope `fail===0` + `xfail`/`xpass` machinery (12 xfail = 9 subscript
`1.e3`-lexer gaps + 3 out-of-scope: var-hoist/redeclare, strict `.caller`); baseline
1431→1428; determinism.js. Miscompiles fixed: (a) bare `return;` emitted `null` not
`undefined` (emit.js NULL_IR→undefExpr; narrowI32Results already skips i32-narrow on
hasBareReturn so f64 UNDEF carrier fits); (b) `cond ? undefined : x` surfaced `null` —
prepare collapsed both atoms to one JZ_NULL sentinel; split JZ_UNDEF (root B's
"undefined conflated with null" in miniature). +3 test262 (1425→1428). FINDING for
user: subscript silently lexes `1.e3`→`(1).e3`→undefined (real upstream landmine).
Differential fuzzer (sound, shrinking, 4-opt, contract-aware same()) + perf-fuzzer
(broad jz≥v8 proof). 6 miscompile clusters fixed: % (exact __rem), rounding-after-
reassign, ToInt32-handling, watr branch-fold (71/341), x*0 NaN, i32-overflow (asm.js
contract). #7 boundary leak (host-global drain). #8 stdlib WAT dedup. Loop-counter i32
keep (18×→par). int-contract per user (lean i32). Commits: 6e0a6dd, b686c6a, 2b25a87
(+watr 05b8c54). Scores baseline: clean 6, maintainable 5, minimal 4 → target the roots.

---

# ⟢ COMPILER STREAMLINING (audit 2026-05-28) — WORK-LOG (superseded by master plan above)

Goal: bring the pipeline to a shining, clear, elegant, minimal shape. Priority
order set by user: **(P1) fix structural items §1–8 below, (P2) close the test
gap, (P3) the reliability list 1–6.** Focus = compiler streamlining first.

Safety net: `npm test` = 1911 pass / 1 skip / 0 fail, ~40s (opt:2 default).
Before declaring any item done, also run `npm run test:matrix:full` +
`npm run test:selfhost`. Never commit unless asked. Stage files by name only.

### P1 — structural fixes (the "what is wrong" list)

- [ ] **#8 stdlib dedup** (safe warmup). Forwarding-follow WAT loop copy-pasted
      ~6× across `module/core.js` (`__ptr_offset`) + `module/array.js`
      (`__arr_idx`, `__arr_idx_known`, `__typed_idx`). itoa digit-reversal dup in
      `module/number.js` (`__itoa`, `__radix_str`). → named WAT fragment consts.
      Risk: low. Verify: full matrix (output-shape pins live in tests).
- [ ] **#7 boundary leak** (small, clean). `emit()` writes `ctx.scope.globals` /
      `ctx.scope.globalTypes` + pushes import for HOST_GLOBALS at
      `src/compile/emit.js:3148-3160`. ctx.scope is prepare's domain. → move
      host-global detection+registration into prepare's identifier path.
      Risk: low-med. Verify: default + selfhost (kernel uses host globals?).
- [ ] **#4a cseScalarLoad explicit proof**. Safety rests on `fn.cseLoadBases`
      expando (`src/compile/index.js:427`); silently no-ops if a pass recreates
      the node. → pass loadBases as explicit arg from a name-keyed map.
      Risk: low. Verify: full matrix.
- [ ] **#4b vectorizer reduction guard**. `vectorizeLaneLocal` vectorizes
      `f64.add` reductions, changing float associativity, on structural match
      alone (`src/optimize/vectorize.js` reduction path). → gate behind opt-in or
      exactness check; default-safe. Risk: med (perf regression possible).
      Verify: full matrix + bench (`npm run test:bench`).
- [ ] **#5 cache staleness**. `_bodyFactsCache` keyed on body-node identity,
      manually invalidated in 9 sites (`src/compile/analyze.js:84`). → fold into
      #3 (single walk removes most invalidation need) or make invalidation
      structural. Risk: med. Do alongside #3.
- [ ] **#6 decompose mega-functions** (clarity). `prep()`+handlers
      (`src/prepare/index.js:661-2074`), `emitMethodCall` (`emit.js:1773-2033`,
      → split per-type into module/), `ctx.core.emit['.']` (`module/core.js:713`),
      `analyzeBody` (~460L). Risk: low-med (mechanical). Verify: full matrix.
- [ ] **#3 unify analysis walks** (CENTERPIECE). AST walked 8+×/fn; VAL-tracking
      duplicated as `trackVal` (`analyze.js:156`) vs `setVal` (`analyze.js:570`),
      `trackTyped` duplicated. → one fact-collection pass producing one bundle;
      `analyzeValTypes` consumes `analyzeBody` output instead of re-walking.
      Improves clarity + compile speed + reliability at once. Risk: HIGH.
      Verify: full matrix + selfhost + bench + test262.
- [ ] **#1 closed TypeFact shape**. ValueRep is open `{}` with ~12 orthogonal
      optional fields (`src/reps.js`), read via ad-hoc 4-level priority chain.
      → documented closed shape + single lookup fn. Risk: HIGH (touches every
      rep reader). Verify: full matrix + selfhost.
- [ ] **#2 narrowing fixpoint → lattice**. `narrowSignatures`
      (`src/compile/narrow.js:551-829`) is a 10-phase ordered script w/ 6 nested
      fixpoints, `clearStickyNull` ×3, `runFixpoint()` ×2 heuristic. → monotone
      fixpoint over a declared lattice; delete sticky-null patches.
      Risk: HIGHEST. Best done after P2 fuzzer exists. Verify: everything.

### P2 — test gap (after §1–8)
- [ ] Wire full CI matrix: opt0/opt1/opt2/opt3 × {js, wasi} (today only opt2+opt3).
- [ ] Determinism test: same source → byte-identical wasm.
- [ ] Memory-safety / arena-allocator adversarial tests.

### P3 — reliability list (after P2)
1. Differential fuzzer: valid-jz → {V8, wasm} → assert equal (highest value).
2. (full CI matrix — pulled into P2)
3. Unify analysis (= #3, pulled into P1).
4. Determinism + mem-safety (pulled into P2).
5. Written subset spec (grammar + semantics).
6. Narrowing lattice (= #2, pulled into P1).

### ⚑ DIFFERENTIAL FUZZER — DONE (test/fuzz.js) + FOUND REAL MISCOMPILES
Built generative fuzzer: random jz-subset programs → run as JS (truth) vs jz-wasm
at opt {0,1,2,3} → assert bit-exact. Seeded/reproducible, automatic shrinker,
static well-scopedness guard (generator + shrinker emit only valid lexically-scoped
programs; 0 malformed). Integrated as a ratchet in `npm test` (KNOWN_OPEN baseline
of 14 seeds; trips on any NEW divergence). `npm run test:fuzz` = 5000-program sweep.
`node test/fuzz.js --seed=N` reproduces one. Full suite green (1912 pass).

**REAL BUGS FOUND (root-cause clusters, minimal repros — all confirmed vs plain jz):**
1. **`%` semantics** (opt0+, ~6 seeds). `(p0)=>(0%0)` → jz **0**, js NaN. `p0=(0%p0)`
   @Inf → jz NaN, js 0. In a loop `0 % i0` (i0=0) → **wasm TRAP** (integer rem lowered,
   traps on 0 divisor instead of f64 NaN). jz `%` diverges from JS fmod on x%0 / 0%Inf.
2. **Math.floor/ceil/round/trunc ELIDED after a param is reassigned** (opt0+, ~9 seeds).
   `(p0)=>{p0=p0; return Math.floor(p0)}` → jz returns **unfloored** p0. `let v=Math.floor(p0);
   p0=0; return v` also fails (a *later* `p0=` reassignment changes the earlier floor lowering).
   Fresh `let` copy is fine. → faulty int/narrowing inference (intCertain?) on reassigned
   params makes rounding a no-op. **Analysis-layer bug — overlaps #1/#3. Fires at opt0 = base, not optimizer.**
3. **ToInt32 of large f64 in `~`/bitwise** (opt0). `~(p0*p0)` @2^32 → jz **0**, js -1.
4. **Math.imul with non-integer operand** (opt0). seed85.
5. **opt2 invalid wasm** "expected 0 elements on stack for fallthru" — ternary-in-return
   with mixed arms: `(p0)=>{let v3=1; return (v3 ? Math.min(v3,0+p0) : 0)}`. seed71,341.
6. **opt3 drops reassignment** after a `%0`→NaN initializer. seed34.

DECISION NEEDED: fix these (fuzzer's payoff; #2 overlaps #3) BEFORE #6/#3, or proceed
to #6/#3 with these as tracked baseline. A miscompiling compiler isn't offerable →
lean fix-first, at least clusters 1+2 (common patterns, correctness-critical).

### ⟢ MISCOMPILE FIXES (autonomous mandate 2026-05-29) — progress
Goal: 0 fuzzer errors over 600 programs, then structure #1-6, then self-host
byte-identical + jz.wasm test-matrix + jz.wasm faster than jz.js.

FIXED (verified, suite green 1912, gate KNOWN_OPEN={71,85}):
- **Cluster 2 (rounding-after-reassign)**: intCertainMap (type.js) now seeds f64
  params false — a reassigned f64 param is no longer vacuously intCertain, so
  Math.floor/ceil/round/trunc isn't wrongly elided. Conservative-safe.
- **Cluster 1 (`%`)**: replaced inexact `a-b*trunc(a/b)` with exact `__rem`
  (binary fmod, all IEEE edges) in module/core.js; f64rem (ir.js) calls it.
  emit `%` i32.rem_s now requires a literal (nonzero) divisor; exprType `%` is
  i32 only for nonzero-int-literal divisor (mirrors emit). Fixed x%0→NaN,
  finite%Inf→finite, runtime-0 trap, float precision, 0%imul@opt2, opt3 drop.
- **ToInt32 wrapping**: `__toint32` (core.js) does exact ToInt32 via i64
  bit-surgery (NO f64 arith → invisible to hot-path f64.add/mul/floor greps).
  toI32 (ir.js) keeps the fast inline `wrap(i64.trunc_sat)` for |x|<2^63 and a
  lazy `if`-guard routes |x|≥2^63 to __toint32. Fixed `~(p*p)@2^32` etc.

- **71,341 — WATR optimizer bug — FIXED upstream + synced.** `branch` pass dropped
  the `(result T)` when folding a constant `if`, leaving a void block that dangles a
  value ("stack for fallthru"). Fixed in ~/projects/watr/src/optimize.js (branch)
  + CHANGELOG, AND synced to jz's fork src/wat/optimize.js (jz uses its own fork;
  watr pkg = encoder only). watr suite green 580/0.

REMAINING (1 cluster): **i32 arithmetic overflow at the int32 boundary** (85, 274,
320, 518 + ~6 patterns/1000). A full-range bitwise/imul/shift result feeding
`+`/`-`/`*`/unary-`-` whose result ESCAPES as a Number (returned, not `|0`/`>>>`-
sunk) wraps in jz's i32 path; JS gives f64. e.g. `(~p0)*5`, `65535*Math.imul(…)`,
`-(~~p0)`, `(~p0)-(-1)`. This is jz's asm.js-style integer contract — mulFitsI32
/exprType keep i32 assuming operands bounded; bench-critical (can't blanket-widen
`i*4`/`i+1` — lengths are dynamic, `scanBoundedLoops` gives only `i<arr.length`).
**Proper fix = integer range/flow analysis (keep i32 only when result provably
fits OR is ToInt32-sunk) — belongs with the #1/#3 analysis refactor.** A targeted
direct-operand fix (widen when an operand is literally a bitwise/imul/shift node)
would close the fuzzer seeds but needs bench verification — do carefully next.
Gate KNOWN_OPEN={85} (others >200). Over 1000 programs, this is the ONLY failing class.

NOTE: manual `compile()` does NOT validate wasm (only jz()/new Module does) — use
jz() to check codegen validity. The fuzzer uses jz() so its findings are real.

STATUS: ALL 6 clusters fixed. 600 fuzzed programs pass with 0 errors (gate
KNOWN_OPEN now empty). Suite green 1912. Committed: jz 6e0a6dd, watr 05b8c54.

i32-overflow fix (committed-pending): `isFullRangeI32` (ast.js) flags full-range
bitwise/shift/imul producers; emit `*`/`-`/unary-`-` widen to f64 when an operand
is full-range (exprType matches). `+` intentionally NOT widened — it's the
ToInt32-sunk accumulator op (`(h+(h<<1))>>>0`); widening it would break perf.js's
no-f64.add assertion and gains nothing (the `>>>` re-truncates). Leans-i32 per
user: only clearly-risky producers widen; bounded loop/index/`& mask` stay i32.
Verified: `(~p0)*5`, `65535*imul`, `-(~~p0)`, `(~p0)-(-1)` correct at all opts;
`i*4` loop + `+`/`<<` hash unregressed.

INT-RANGE RESOLUTION (per user: lean i32, don't drop perf, allowance of big
values): jz's integer arithmetic is asm.js-style (i32 wrapping/ToInt32, kept for
speed). Reverted the __toint32 ToInt32-≥2^63 widening AND the isFullRangeI32
`*`/`-`/`u-` widening (both dropped bench perf — bitwise/crc32/watr). These
big-value overflows are jz's DOCUMENTED integer contract, not bugs. Fuzzer now:
(a) caps inputs to the contract-valid range (no ≥2^31), (b) `same()` accepts
jz's ToInt32-wrap for out-of-range integers (`a===(b|0)`, ≤2^53 ring-homomorphism).
Result: gate (1..200) clean; 1500-sweep@inputs20 has 1 residual (seed 952, a
mid-computation `-(<<)` overflow flowing through Math.min — accepted contract).
ALSO fixed a real NaN bug: `x*0` folded to 0 (now NaN for NaN/±Inf x, finite-only fold).
Kept (real, perf-neutral): `%` exact __rem, rounding-after-reassign, watr branch-fold.

PERF-FUZZER (scripts/fuzz-bench.mjs) + the "is the win broad/sound?" answer:
Built a perf-fuzzer — random hot accumulation loops across the int↔float spectrum,
jz-wasm vs V8 timing per program. It found + I FIXED a real 18× gap: an integer
loop counter compared to an f64 param bound was widened to f64 (f64 increment +
f64 compare + heavy per-iter ToInt32), while V8 JITs it as int. FIX: analyzeBody's
widenPass keeps intCertain (affine-integer) counters i32 — EXCEPT those feeding an
f64-strided index (collectF64StridedIndexVars; preserves the game-of-life non-
regression). Result: that loop 18× → 0.93× (on par). Sound for n ≤ 2^31.

WHY 18× (user asked — it's NOT an f64 tax): jz's time is CONSTANT for a given
loop; V8 is the variable. V8's JIT VALUE-SPECIALIZES integer-valued f64 inputs into
a pure-int loop (`acc=(acc+3)|0` → 7ms) but runs float for fractional inputs
(`+1.5` → 133ms ≈ jz, 1.05×). So jz MATCHES V8 on float compute; V8's extra win is
runtime value feedback (a JIT capability AOT jz lacks), NOT a jz codegen flaw. f64
arithmetic itself is only ~2.5× vs i32 (as expected). jz could "win" those by
optimistically i32-ing integer-valued f64 params — but that's the IMPROPER i32 to
avoid (wrong for 1.5), so jz correctly stays f64.
THESIS VALIDATED with fair (non-integer) args: jz on-par-or-faster in EVERY category
— int median 0.93× p90 1.06× (0 slower), float 0.85× p90 1.01×, mixed 0.83×. The
advantage is BROAD and from SOUND i32 typing, not narrowing tricks. (Run:
`node scripts/fuzz-bench.mjs`. TODO: add `bench:fuzz` npm script.)

NEXT (today's plan): structure #6 decompose → #2 lattice → #4a/#4b, then HARD on
jz.wasm test-matrix (basic), then SUPREME goal: jz.wasm faster than jz.js.

SUPREME-GOAL BASELINE MEASURED (2026-05-29): built dist/jz-kernel.wasm (3.44 MB,
JS-compiled in 7.8 s). Fair compile-speed comparison at MATCHED opt level (the
kernel runs `resolveOptimize(false)`, so compare vs jz.js@opt0 — both emit 231 B):
  jz.js  @opt0 : 0.64 ms/prog
  jz.wasm      : 1.18 ms/prog   → jz.wasm is ~1.85× SLOWER (goal NOT yet met)
  (jz.js @opt2 : 2.02 ms, 200 B — the optimized path, not the fair comparator)
⇒ Supreme goal = close a ~1.85× gap by optimizing the self-host KERNEL's compile
hot path (profile kernel.exports.default; the 3.44 MB kernel's prepare/compile/
emit loops). This is a focused perf project, not done yet. Driver to reuse:
scripts/selfhost-build.mjs + selfhost-run.mjs; measure with the host-parse +
kernel.default + watrCompile pipeline vs compile(src,{optimize:false}).

### Working notes
- **#8 DONE** (verified, 1911/1/0 green, deterministic). Added `followForwardingWat`
  + `reverseBytesWat` to layout.js / number.js; collapsed 6 forwarding-loop copies
  (core.js ×3, array.js ×3) + 2 itoa reversal copies. watr parses S-exprs so
  whitespace-immaterial → byte-identical output.
- **#7 DONE** (verified, green, deterministic). Removed BOTH emit→ctx.scope.globals
  /globalTypes AND emit→ctx.module.imports writes. emit now records usage in
  `ctx.core.hostGlobals` (sanctioned, like jsstring); assembly drains into imports
  before syncImports. Hoisted HOST_GLOBALS to module const.
- **#4b REVIEWED — no change.** Float-add reduction vectorization changes assoc by
  ulps BUT: gated behind opt:3/'speed' (opt-in), author-documented as acceptable
  (vectorize.js:789-791), spec-defensible. Deliberate author tradeoff — do not
  override. Minor follow-up (optional): `adviseSimdLoops` emits "SIMD skipped, split
  the reduction" (advise.js:292) for reduction loops that tryReduceVectorize
  actually DOES vectorize — advisory text is misleading in that case.
- **#4a → fold into #3.** `fn.cseLoadBases` expando is safe pre-watr (same node
  objects); post-watr worst case is a missed CSE (safe no-op), never wrong output.
  Legibility nit, not a live bug. Make the proof explicit (name-keyed map) when
  reworking the analysis layer.
- **#5 → fold into #3.** `_bodyFactsCache` staleness disappears if the analysis
  becomes a single walk producing one fact bundle.

- **#3 SCOPED (deep — needs fuzzer first).** `analyzeValTypes` (analyze.js:568)
  ALREADY calls `analyzeBody` (line 591) and reuses its cached arrElem facts. Its
  own `walk` (690-790) is NOT a mechanical dup of analyzeBody's `trackVal` — it is a
  *side-effecting, context-dependent* pass: commits to localReps.{val,schemaId,
  jsonShape,arrayElemValType,arrayElemSchema}, ctx.types.typedElem,
  ctx.runtime.regex.vars, ctx.schema.{vars,register}, ctx.func.localProps; and reads
  `valTypeOf` (which reads already-committed reps → incremental context dependence).
  analyzeBody is deliberately PURE for caching. So unifying = separating pure
  fact-collection from ctx-commitment cleanly — a real design refactor, high
  miscompile risk. **Do AFTER the differential fuzzer exists** (the only net that
  can prove an analysis-layer restructure preserves codegen). Same applies to #1,#2.

- **#6 (decompose) — tractable, deferred to focused session.** emitMethodCall
  (emit.js:1777, ~260L) is a clean guard-return cascade by receiver kind
  (flat-obj / charCodeAt / splice / fn-prop / boxed / spread / generic) — extractable
  into named helpers, but it's a hot central dispatcher; do it in a focused pass with
  full-matrix verify, not bundled.

### Concurrent (USER is doing P2 test-matrix WASI wiring in test/*.js — DO NOT TOUCH)
- _opt.js onWasi() + onWasi() skip-guards across optimizer/perf/warnings/jsstring/errors.

### Recommendation: build differential fuzzer (P3 #1) BEFORE #3/#1/#2 — it is the
### enabling safety net for those three, the highest-value + highest-risk streamlining.

### Remaining P1 active: #6 (decompose), #3 (unify walks), #1 (TypeFact), #2 (lattice)

---

## jz — execution plan

#### Community

#### Monetization

### Ecosystem & reach — sequenced (from `.work/ecosystem-audit.md`)

Ordered by value × leverage × effort. The lens: **valid jz = valid JS** ⇒ the
same source runs as JS and as jz-WASM, so every demo flips one switch to compare
them honestly — show per-frame compute-ms, not a faked speedup (jz wins
transcendental-heavy work; V8's JIT ties/wins pure-arithmetic loops). No other
JS→WASM tool can do that same-source toggle. Build it once, reuse everywhere.

#### Examples — astonishing, build next (have 3: life / interference / mandelbrot)
* [x] Add the **JS ⇆ jz-WASM toggle + live FPS/compute-ms HUD** to the 3 existing demos — done, shared loader/HUD in `examples/lib/jzdemo.js`, all verified in browser
* [ ] **Strange attractors** (Clifford / de Jong / Lorenz) — 2-line f64 formula × millions of iters → luminous structure; jz's exact sweet spot
* [ ] **Software path tracer / SDF raymarcher** — "Shadertoy on the CPU, but fast"; mirrors AS as-smallpt in plain JS
* [ ] **Reaction-diffusion (Gray-Scott) / Lenia** — per-pixel convolution per frame; Lenia looks alive
* [ ] **Boids + simplex flow-field** — the genart canonical (mattdesl/Hobbs); particle count *is* the benchmark
* [ ] **CHIP-8 emulator core** — integer dispatch = jz's floor; mirrors AS wasmBoy
* [ ] **QOI codec** (~300 readable lines) — competes with surma's 904 B hand-WAT on *size*; ties to color-space
* [x] **FFT spectrogram** — `examples/rfft/`: floatbeat tune → jz-computed split-radix RFFT → live **log/mel spectrogram** (A-weighted per IEC 61672, equal-octave log by default, mel one click away) + momentary waveform overlay + wavefont peak-hold bars + click-to-shuffle + live code panel; JS⇄jz toggle with a **linefont FPS sparkline**. The compiler's auto i32-index narrowing makes the **idiomatic** source (no `|0`) beat V8 **1.69–1.74×** on the rfft() kernel, correctness ~1e-11, 9.9 KB wasm. Done & verified (browser + `examples/rfft/bench.mjs`). The kernel keeps its `cepstrum()` export (still benchmarked); the demo just renders the spectrum now. See Archive 2026-05-22 "RFFT i32-hoist" + "auto i32-index narrowing".
* [ ] (later) dithering/convolution filters
* [ ] zzfx

#### Flagship + the one compounding "make-world-know" move
* [ ] **Floatbeat playground** (already roadmapped → promote to flagship) — type a formula, hear music, AudioWorklet, compiled live; vibecoder + audio + live-coding proof in one
* [ ] **Playground site** = gallery + floatbeat + WAT-showing REPL, every item a shareable permalink. The demo *is* the marketing. Greenfield (no `playground/`/`repl/` yet)

#### Integrations (affect area: native-speed compute from plain JS, sandboxed/portable)
* [ ] **`unplugin-jz`** — highest leverage; one plugin covers Vite/Rollup/webpack/esbuild/Rspack. `import { fib } from './fib.js?jz'` → WASM at build time. Leapfrogs AS's separate rollup-plugin + as-loader. (Folds the existing "unplugin" + "template tag as build tool" Ideas bullets)
* [ ] **AudioWorklet path** — write `process()` in plain JS, jz compiles it in the worklet; painful today (Rust/AS+bindings)
* [ ] **Dogfood own libs** — color-space / digital-filter / web-audio-api compute cores on jz (highest-trust benchmark; the "integrations as validation" item)
* [ ] **Extism plugin path** — "author Extism plugins in plain JS"; underserved niche. (EdgeJS already landed — one point in this field)
* [ ] **WASM-4 fantasy console** — supports AS/C/Rust/Zig/Go but **no plain-JS path**; cartridge = WASM `start`/`update` over a framebuffer = jz's shape. Fun, viral, direct AS territory
* [ ] (later) live-coding hosts (Hydra/Strudel/p5/canvas-sketch) — jz as the compile-your-hot-loop escape hatch. Pitch is **warm kernel speed + tiny portable wasm**, *not* cold-start: `bench:startup` (2026-05-22) measured jz cold-start 200–1400× slower than `new Function`, so the README "compiles faster than eval" line is false and stays out

#### Embedded — jz → native MCU, no interpreter
Path: `jz → wasm2c/w2c2 → C → arm-none-eabi-gcc / esp-idf / avr-gcc → flash`.
Unlike Espruino / Moddable XS / wasm3-arduino (all **interpreters** on-device),
jz is **AOT-compiled to native** — zero interpreter, zero on-chip runtime. This is
the honest differentiator and a genuine gap.
* [ ] **Target matrix + f64 reality.** Best on FPU MCUs (Cortex-M4F/M7: ESP32, RP2040, STM32, Teensy 4, Daisy Seed). M7 (Teensy 4 / Daisy) has a **double-precision FPU** ⇒ jz's f64 model unpenalized. AVR Uno has no FPU ⇒ i32-only kernels or out of scope. Document it.
* [ ] **Pure-compute proof.** `alloc:false`, no WASI imports, scalar kernel → C → flash → output verifies native run (reuse the existing wasm2c/w2c2 integration-test pipeline as the build harness)
* [ ] **Flagship: biquad on hardware.** digital-filter biquad (own lib) → jz → C → Daisy Seed / Teensy audio out. DSP on MCU is jz's strongest embedded fit — audience already writes DSP in C++, would take plain JS
* [ ] **Heap + RAM budget.** For heap-using modules pick a memory region; document RAM budget; w2c2 (C89, ~150 KB) runtime header is the small target

#### Bench corpus (closes AS-parity the right way)
* [ ] Port 2–3 AS showcase kernels into `bench/` for the head-to-head "plain JS vs typed-TS" story: path tracer, emulator core, a codec (msgpack/LZMA-style), a hash (sha256)

#### Useful tools — returnable, not just demos (full reasoning § "2A" in ecosystem-audit.md)
Wedge: compute behind an upload / paywall / native install → run it local, free, private, instant. jz = the compute core, JS = the thin UI shell.
* [ ] **Audio workbench** (Tier 0 — own all the pieces) — decode → EQ/filter → effects → resample/convert/LUFS → export, AudioWorklet on jz kernels. Reuses audio-decode / digital-filter / audio-effect / pcm-convert / web-audio-api. **The useful flagship.**
* [ ] **QR generator/decoder, tracker-free** — Reed-Solomon + masking = pure integer, jz's floor; universal, self-contained
* [ ] **Local image converter/optimizer** (PNG/JPEG/WebP/QOI + dithering) — Squoosh-class privacy wedge; reuses color-space
* [ ] **Function plotter / "compile your math"** — `f(x,t)` → compiled → plotted; showcases "faster than eval"
* [ ] **Color/palette tool** (OKLCH↔hex, palette extraction, contrast/CVD sim) — reuses color-space
* [ ] (niche, loyal crowds) Voronoi stippler→plotter SVG · bitmap→SVG tracer · pixel-art upscalers (EPX/xBRZ) · cymatics/harmonograph/guilloché · WFC tile generator
* [ ] (verticals, build when a user pulls) quant (Black-Scholes/MC) · GIS (simplify/MVT) · fabrication (G-code/STL) · sci kernels (RK4/FFT/least-squares) · bioinformatics (alignment)
* [ ] **Demoscene / js13k / Genuary culture play** — tiny WASM output = sizecoding hook; same-source JS↔WASM = prototype-then-compile. Targets: Pouët, Dwitter/tixy.land ("tixy but compiled"), Lovebyte, JS13k (jz = the compute kernel, not the DOM glue), Genuary starter. floatbeat doubles as the entry.
* [ ] stdlib-io integration (faster whole lib)

### Deferred — NOT minimal, schedule explicitly
- Insertion-order Set/Map — open-addressing table iterates slot-order; ES
  mandates insertion order. Needs a per-entry `seq` field or a sibling order
  list. Currently enumerated as a documented divergence in
  `test/test262-builtins.js` xfail list.
- wasm-gc backend (`host: 'gc'`) — orthogonal future track. Replaces the
  manual NaN-box + linear-memory allocator with engine GC + typed refs across
  the whole compiler. Multi-month backend rewrite; benefits are memory-model
  / externref-bridge / debugging, NOT a fix for boolean discrimination (the
  landed boolean carrier, Archive › "Real-boolean carrier", resolves that in
  wasm-v1; wasm-gc has no native typed-boolean either — `i31ref(0)` doesn't
  discriminate from `0` the number, same atom-tag problem in different syntax).
  Currently reserved as a compile-time error in `index.js:315`; documented in README.
- Intl, Date locale surface, component model, threads, memory64, WebGPU —
  Future.
- Ship: pick ONE undeniable use case (floatbeat playground — DSP kernels are
  jz's proven strength per the EdgeJS archive). Product call.

### Ship something real

* [ ] Pick ONE use case, make jz undeniable for it
* [ ] Ship something someone uses
* [ ] Integrations as validation: color-space converter (multi-profile), digital-filter biquad (memory profile), floatbeat playground
* [x] Make compile faster than js eval — **resolved: don't chase it.** `bench:startup`
  (2026-05-22) measured jz AOT cold-start 200–1400× slower than `new Function`+first call
  (V8 lazy-compiles bodies; jz does real AOT work up front). jz's edge is warm kernel speed
  + tiny portable wasm, not REPL latency. (Archive 2026-05-22.)
* [ ] Benchmarks
* [ ] Clear, fully transparent codebase; complete docs / readme / tests / repl
  * [ ] README FAQ: document the `** 0.5 → f64.sqrt` numeric-divergence corners
    (`(-0)**0.5 = -0`, `(-Infinity)**0.5 = NaN`; `** -0.5` left unfolded) alongside the
    existing "errors are untagged" / Set-Map slot-order divergence notes (Archive 2026-05-22)

### Floatbeat playground

* [ ] Syntax highlighter
* [ ] Waveform renderer
* [ ] Database + recipe book
* [ ] Samples collection

### Language coverage / correctness

* [ ] Date — deterministic spec slices first; local timezone / Intl surface later
  * [ ] Deferred: object `ToPrimitive` coercion order (`coercion-order.js`)
  * [ ] Defer `Date.parse` until Date value objects + UTC stringification exist
  * [ ] Out of scope: local-time getters/setters, `getTimezoneOffset`, `toString` / `toDateString` / `toTimeString`, locale methods, `toJSON`, `Symbol.toPrimitive`, `toTemporalInstant`, subclassing, realms, descriptors, prototype shape, function `name`/`length` metadata
* [ ] Intl
* [ ] test262
* [ ] All AssemblyScript tests
* [ ] Warn/error on hitting memory limits
* [ ] Know all fails of test262 in face and cleanly either jzify or error, don't fail unknowingly
* [ ] Tighten tests (coverage) - randomly change features and see if tests break.

### Imports & jzify

* [ ] jzify script converting any JZ
* [ ] jzify: auto-import stdlib globals (Math.* → `import math from 'math'`, etc.)
* [ ] jz core: require explicit imports for stdlib (remove auto-import from prepare/compile)
* [ ] align with Crockford practices

### Diagnostics

* [ ] Source maps (blocked on watr upstream) — meanwhile add WASM name section (function names) independently


### Metacircularity (jz compiling jz)

* [ ] Extract minimal jz parser from subscript features — jz-jessie fork excluding class/async/regex + refactor parse.js function-property assignments (~30 lines)
* [ ] jzify uses jessie, pure jz uses internal parser
* [ ] True metacircular bootstrap
* [ ] swappable watr: AST likely needs stringifying before compile if an adapter is provided

### REPL

* [ ] Auto-convert var→let, function→arrow on paste
* [ ] Auto-import implicit globals
* [ ] Show produced WAT
* [ ] Document interop

### EdgeJS PR shape

* [ ] Add an EdgeJS test/harness entry only if it can run in their CI without pulling large optional dependencies or network setup

### Future

* [ ] Component interface (wit)
* [ ] **threads/atomics** — parallelism substrate for the SoA kernels jz already
  lane-vectorizes (TurboScript's unshipped "parallel WASM", scoped 2026-05-22). jz-shaped,
  host owns orchestration: (1) lower `Atomics.add/sub/and/or/xor/exchange/compareExchange/
  load/store/wait/notify` on shared typed arrays → wasm atomic ops (all valid JS, map 1:1);
  (2) `memory: { shared: true }` → emit a shared `WebAssembly.Memory` + the `(memory … shared)`
  form (`jz.memory()` already shares across modules); (3) worker/thread spawning stays
  host-side — same boundary discipline as I/O; jz supplies the atomic primitives + shared
  memory, not a thread runtime. Large (emit + assemble + interop/ABI) and no demonstrated
  demand yet — verify a real workload first (the bar that killed monomorphization). The
  vectorizer + shared-memory substrate already exist, so this is a coherent later increment.
* [ ] memory64 (>4GB)
* [ ] relaxed SIMD
* [ ] WebGPU compute shaders

## Ideas

* [ ] webpack, esbuild, unplugin etc – extract and compile fast pieces with jz
* [ ] jz as a compilation target — DSLs that want WASM output emit jz-compatible code (needs a simple IR / intermediate format) and get WASM for free
* [ ] The template tag as a build tool — jz\`code\` in a Node script replaces a build step. No webpack, no esbuild, no plugin. Uniquely elegant and under-marketed.
* [ ] AS integrations/plugins from https://www.assemblyscript.org/built-with-assemblyscript.html
* [ ] potrace playground


#### Perf

* [ ] **Auto AoS→SoA carrier.** `xs[i] = rows[i].x + …` — load is a
  pointer-chase, store lane-aligned; wasm-v1 has no gather. Honest fix is a
  struct→SoA carrier (sibling to `src/abi/array.js`'s `structInline`),
  blocked on the narrower emitting SoA-eligible carrier facts. Multi-week,
  cross-cutting (touches every array consumer). Deferred until a real
  workload demands it. Hand-written SoA already vectorizes — Archive ›
  "opts.host user surface + custom sections reference + SoA boundary pin
  (2026-05-20)".

* [ ] **Stdlib-pull audit** *(sister to the `** 0.5 → f64.sqrt` fold, Archive 2026-05-22)*.
  Walk `module/*.js` for builtins that emit a polyfill (exp/log/poly approximations, helper
  calls) where wasm-v1 has a native instruction or a cheap inline fold — the sqrt fold showed
  the headline `dist` example was paying ~1.0 kB for an exp/log call the hardware does in one
  op. For each, fold to the native op when the argument shape allows; gate on the builtin
  actually appearing in a kernel (don't pre-lower the unused). Size+speed on one axis, like the
  sqrt win. Owner: `module/math.js` (+ siblings), `test/math.js`.

#### Representation

Per-site carrier inference. Design & rationale: `research.md` › "Representation -> per-site, inferred". The only user knob is the boundary protocol (`opts.host`, landed). Done carriers archived below; open ones:

* [ ] **jsstring carrier — internal-STRING-locals flow.** Propagate
  externref past the export boundary into internal STRING locals so parsers
  carry `src` end-to-end without memory-backed copies. Blocked on the
  narrower converging carrier facts across the call graph (fixpoint, not
  just leaf exports). Archive › "jsstring boundary carrier (2026-05-20)"
  covers the landed leaf-export work.
* [ ] **Boundary string cache in interop.js.** Cache `mem.wrapVal(s)` by
  string identity so repeat-same-string workloads amortize the UTF-8
  transcode — orthogonal SSO improvement.
* [ ] **Schema-object field packing** *(deferred — YAGNI, no consumer)*. Per-field
  rep so `{count:0, name:''}` lays out `(i32, ptr)` not `(f64-tag, f64-tag)`; halves
  struct size. Surveyed 2026-05-19: gap real, multi-day. Blocker: `src/abi/object.js`
  carrier ops are `(base,i,val)` with no schemaId — `packed` needs the carrier API
  widened + schemaId threaded through every dyn path (~6 modules). Build when a
  struct-array-of-records workload demands it; benches use TypedArrays/SoA, not AoS records.
* [ ] **Typed-array element rep** *(deferred — no workload)*. `xs=[1,2,3]` with int-only
  writes → `Int32Array` backing not tagged-linear. Surveyed 2026-05-19: output shape
  already proven via explicit `new Int32Array`, just not auto-selected. Blocker:
  VAL.ARRAY→VAL.TYPED is a value-type change (consumers route through `__arr_*` vs
  `__typed_*`) + needs a new narrower phase (int-only writes, no shape mutation, closed
  read set). Benches opt into TypedArrays explicitly; watr/subscript don't show this shape.
* [ ] **Closure-capture narrowing** *(deferred — regression risk > theoretical win)*.
  Captured vars widen to nanbox at the cell even when used at one narrow type;
  `let c=n|0; ()=>c++` round-trips i32↔f64 per access. Surveyed 2026-05-19: ~100 LOC
  across 5 touch points (new `analyzeBoxedCellTypes` walking arrow bodies; dispatch
  alloc/init in `emitPreboxedLocalInits`; load/store in `readVar`/`writeVar`; thread into
  `emitClosureBody`). Bench closures capture objects/strings, not i32 — wins zero ops on
  real hot paths; watr is closure-heavy and a regression vector. Re-evaluate on a
  counter/accumulator-closure workload.


### Lint-inspired passes — structural fix vs. advisory

ESLint's reusable shape is `detect → message → (autofix | suggestion)`. jz already
owns *detect* (analyzer / narrower) and *autofix* (the optimize passes); the missing
half is a soft channel — today jz has only hard `err()` rejection (`src/prepare.js`,
`jzify.js:691` `jzifyError`) and manual `--wat` self-inspection, no `ctx.warn`.

**Dividing principle.** A JS↔jz divergence is fixed *structurally* when jz invented
the gap — a representation choice, an inference decision, or a lowering simplification
(close it; a warning there is the compiler confessing it punted). It stays a *warning
/ opt-in trade* only when the gap is an omitted runtime mechanism that is the whole
point of "no runtime, no GC". The boolean carrier (Archive › "Real-boolean carrier")
is the exemplar: it *removed* the `typeof`/`String(true)` divergence instead of
narrating it. `typeof`/`String`/`JSON.stringify`-on-boolean are therefore subsumed
there — do not build a separate warning.

#### Fix structurally (jz invented the gap — audit, then close)

Done — see Archive › "Lint-inspired structural passes (2026-05-21)": i32 range-safety
(verified held), switch fall-through (lowering rewritten to two-phase index-based),
dupe keys (verified held), and the `Math.pow`/`~~x`/`!!x` IR folds. Remaining
form-normalization remnants — all already *correct*, only IR-tightness is at stake:

* [ ] **form-normalization remnants.** `parseInt(intLit)` → const fold; `no-self-assign`
  (`x = x`) drop; `no-useless-concat` (`s + ""` — type-dependent, only when `s` is
  statically STRING, else it's a meaningful ToString); `no-useless-return`. Low value /
  DCE-adjacent; defer until one is on a hot path. Owner: `src/optimize.js`, `src/prepare.js`.

#### Advisory / opt-in trade (soft warn channel — `ctx.warn`, `opts.warnings`, CLI)

* [x] **Warn channel.** `ctx.warn` + `opts.warnings` sink + CLI print (mirrors `opts.profile`).
* [x] **no-auto-reclaim leak heuristic.** `adviseHeapGrowth` in `plan()` — heap-return /
  heap-loop / arena-rewind-skipped when bump allocator can't rewind (see `test/warnings.js`).
* [x] **untagged errors (`e instanceof TypeError`).** `jzify` warns on `instanceof` against
  Error constructor names — jz errors are untagged; inspect message/value instead.
* [x] **Set/Map slot-order iteration.** `adviseSetMapIterationOrder` — for-in/for-of,
  `.keys`/`.values`/`.entries`/spread/`JSON.stringify` on Set/Map bindings.
* [x] **perf-feedback advisories.** `adviseJsstringCarrier` (externref carrier declined),
  `adviseSimdLoops` (loop-carried scalar, AoS stride). Further vectorizer bails can
  hook the same pass as reasons are surfaced.

**Skip — already enforced by the subset.** `no-var` / `eqeqeq` / `no-undef` / `no-with` /
`no-eval` are rejected at the subset boundary (`src/prepare.js:615`, `:1047`); borrow only
ESLint's "use Y instead" *message* style (jzify already does this), don't re-implement the rules.

---

## Archive

### Auto i32-index narrowing — the hoist idiom becomes a compiler pass (2026-05-22)

Supersedes "RFFT i32-hoist" below. The prior push made jz beat V8 by hand-hoisting
`let n = N | 0` into each kernel — a leaky abstraction (forces users to rewrite
idiomatic code for speed). Generalized it into the analyzer so **unmodified** source
gets the same i32 indexing.

* [x] **`collectI32SafeIndexVars` (src/analyze.js).** In `analyzeBody`'s widen pass, a
  counter compared against an f64 bound normally widens to f64 (overflow safety). Now
  exempted when it's an **affine component of a fully-i32 array index**: a valid wasm32
  byte-offset must fit i32 and an affine index is monotone in the counter, so the counter
  is provably i32-range — the exact guarantee the manual `|0` asserted. Kept i32 → direct
  indexing, no per-access `trunc_sat`; the compare coerces the counter instead. Transitive
  **back-propagation** over affine assignment/step edges (`let i0 = ix`, `i0 += id`) carries
  the proof through nested-loop index seeding (FFT butterflies). The assignment-widening
  fixpoint still runs after, so a genuinely fractional counter (`i = i/3`) overrides back to f64.
* [x] **Gated on a *fully-i32* index — the game-of-life regression is designed out.** Seeding
  fires only when `exprType(idx) === 'i32'`. An f64-strided index (`mem[y*w + x]`, f64 `w`)
  truncs regardless, so narrowing its counter would add a compare-convert for zero trunc
  savings — exactly the loss the old archive predicted for a blanket pass. Result:
  game-of-life / mandelbrot / interference wasm **byte-identical** before/after; only
  fully-i32-indexed kernels (rfft) change. This is *narrower* than "narrow mutable globals":
  it narrows **index counters**, never the globals, and only where it provably pays.
* [x] **rfft.js de-hoisted → idiomatic.** Removed `let n = N|0` / `hf = half|0` from
  transform/rfft/cepstrum; uses `N`/`half` directly. Output **bit-identical** to the hoisted
  wasm (0.0 diff). Module `trunc_sat` 86 → 18, wasm 10154 → 9902 B. Beats V8 **1.46×** on
  rfft() / **1.05×** on rfft()+cepstrum() (`examples/rfft/bench.mjs`, best-of-8, N=2048).
* [x] **Tests + verify.** 3 regression tests in test/perf.js (i32 index stays i32; transitive
  nest narrows; f64-strided index does NOT narrow). Full suite 1854 pass / 0 fail / 1 skip.
* [x] **Residual headroom → closed by integer-global inference (2026-05-22).** The loop guard
  `i < N` used to convert the i32 counter to f64 each iteration (f64 bound). New pass
  `inferModuleIntGlobals` (src/plan.js) narrows numeric module globals to **i32 by default**,
  demoting to f64 only on *proof* of a fraction (non-integer literal, `/`, `**`, float `Math.*`,
  or a reference to an already-fractional value; fixpoint propagates fractionality through
  cross-global refs). A numeric-init global later assigned a non-number (string/object/array)
  is disqualified → stays the f64 box (write-path coercion fixed in `writeVar`/emitDecl). With
  `N` an i32 global the guard is pure-i32 and `mem[y*width+x]` (i32 `width`) is a fully-i32
  address. Now **no manual `|0` needed** — idiomatic rfft.js beats V8 **1.69–1.74×** rfft() /
  **1.14–1.16×** +cepstrum() (was 1.46× / 1.05×). game-of-life neutral (branch/call-bound, 0.82×
  both ways, smaller wasm), interference 1.96×, mandelbrot untouched. Tests: 5 codegen +
  3 runtime (test/perf.js, test/inference.js). Full suite **1856 pass / 0 fail / 1 skip**.
  Principle documented in README inference section.

### RFFT i32-hoist beats V8 · cepstrogram demo · linefont FPS sparkline (2026-05-22)

The "beat V8 on RFFT / integer-index by any means" push, plus the demo features it powers.

* [x] **i32-hoist idiom — jz beats V8 1.70× on the FFT kernel.** Root cause of the prior
  *JS 1.5× ahead* on RFFT: jz's universal-f64 number model boxes loop-bound **globals** as
  f64 (compile.js only narrows `const` globals with constant-int initializers), so every
  `x[i]` emitted an `i32.trunc_sat_f64_s` and the loop counters ran in f64. Fix is one line
  per kernel — hoist the f64 globals into i32 locals at the top of the hot function
  (`let n = N | 0;`): the narrower types **locals** off the `|0` i32 signal and cascades i32
  through every derived index (`i0`, `i1`, …). WAT trunc_sat count **76 → 13**; all index
  locals i32; loop arithmetic native i32. Measured (`.work/rfft-bench.mjs`, paired
  same-source jz-wasm vs JS-ESM, best-of-8): **rfft() jz 1.63–1.70× over V8** across
  N=512–8192 (1.70× at 2048: jz 7.7 vs JS 13.0 µs); **rfft()+cepstrum() jz 1.45–1.52×**;
  correctness max|Δ| ~1e-11; wasm 9909 B (smaller than before). `examples/rfft/rfft.js`.
* [x] **Idiom is opt-in, NOT a blanket compiler pass — game-of-life regressed.** Applying the
  same hoist to game-of-life's step/rot (`let w=width|0,h=height|0,off=offset|0`) made it
  *slower* (0.74× → 0.67× vs JS). Root cause: game-of-life is **branch/call-bound** (per-cell
  ternaries, `rot()` call, Uint32Array values near 2³²), not index-bound — the hoist adds
  i32↔f64 traffic without removing a trunc-heavy inner loop. Reverted; production untouched
  (only `.work/gol-i32.js` probe was edited). This is the evidence that a global "narrow
  mutable f64 globals to i32" pass would do harm — keep it a documented **kernel idiom**.
  A mutable-global narrowing pass stays deferred (analyze.js 3818 LOC / 1851 tests, high risk,
  game-of-life counterexample).
* [x] **transform() refactor preserves the win.** Extracted the bit-reverse + butterfly core
  (shared by `rfft()` and `cepstrum()`) into a non-exported `transform()` carrying the i32
  hoist; both callers re-hoist `n`/`half` locally. Win held (7.74 µs / 1.68× at 2048).
* [x] **Real cepstrum.** `cepstrum()` = IDFT of the log-magnitude spectrum. Log-mag is real &
  even-symmetric → its DFT is real, so it reuses the same forward `transform()` and keeps the
  real part / N. A peak at quefrency q ⇒ period q samples ⇒ pitch ≈ sampleRate/q; the
  cepstrogram traces the melody. Verified: 220 Hz tone → cepstral peak at quefrency 199
  (expected 200.5), JS/jz agree 6.9e-11. `examples/rfft/rfft.js`.
* [x] **Demo (`examples/rfft/index.html`) — all requested features, browser-verified.**
  Scrolling **cepstrogram** (ABGR palette LUT, log-quefrency rows) with the **momentary
  waveform overlaid** (transparent oscilloscope canvas), **wavefont** peak-hold spectrum bars,
  **click-to-shuffle** (picks a different floatbeat tune of 5, rebuilds the looped audio
  buffer), and a **live code panel** showing the playing tune's source. Audio gated behind a
  one-gesture `#play`. Verified: cepstrogram lit (maxlum 715), waveform overlay 4231 px,
  bars 94/110 active, both fonts loaded, jz compute 0.06 ms/frame @ 121 fps, shuffle
  arp→chord pad, 0 console errors.
* [x] **linefont FPS sparkline in the shared HUD (`examples/lib/jzdemo.js`).** The FPS line is
  now a **linefont** sparkline — each recent fps sample is the glyph at `0x100+value`, and the
  font's ligatures join them into one continuous line chart. Plotted on an **absolute** scale
  (full height = `ref`, which rises to the display refresh rate) so the line sits at the true
  level and **steps when the engine is swapped**. Fixed two scaling flaws found in the browser:
  (1) a decaying-peak relative scale read a steady 23 fps as flat-100 (hid the level and the
  engine gap) → switched to absolute; (2) `ref` latched onto a transient — the first frame
  seeded `fps = 1000/dt ≈ 950`, bumping `ref` permanently so steady 121 fps read 13/100 →
  clamp sub-4ms frames (`Math.min(1000/dt, 240)`) and warm the EMA up from 0 so `ref` settles
  on the real refresh. Verified: mandelbrot (23 fps) reads ~19/100, RFFT (121 fps) reads
  ~97/100, JS⇄jz toggle steps the line. Fonts `examples/lib/{linefont,wavefont}.woff2`.

Demos verified live via Playwright; `.work/rfft-bench.mjs` is the reproducible perf harness.

### `x ** 0.5` → `f64.sqrt` fold · startup/REPL bench · numeric monomorphization wontfix (2026-05-22)

Mined two archived JS→WASM compilers (TurboScript, speedy.js) for borrowable design;
three candidates, each judged against jz's *actual* corpus, not on paper.

* [x] **`x ** 0.5` → `f64.sqrt` fold.** The startup bench flagged the headline `dist`
  example (`(x*x+y*y) ** 0.5`) compiling to 1058 B / 3.9 ms — it emitted the full
  `$math.pow` exp/log polyfill. Folded `** 0.5` (and `Math.pow(x, 0.5)`, same handler)
  to `f64.sqrt` in `module/math.js`, beside the existing integer-exponent square-and-
  multiply fold. `dist`: **1058 B → 67 B**, compile **3.9 → 0.41 ms**, warm **0.4× →
  2.3×** vs V8 — size, cold, and warm all at once. Correctness: f64.sqrt is correctly
  rounded, so bit-identical to `Math.pow(x, 0.5)` on every normal input and to jz's own
  `Math.sqrt(x)` by construction (always `canon`, since a negative finite base yields a
  NaN whose sign needs canonicalizing — mirrors the `math.sqrt` emit). Two exotic inputs
  follow sqrt over Math.pow, deliberate trades in the same class as jz's other boundary
  divergences: `(-0) ** 0.5` = -0 (Math.pow: +0; -0 === 0), `(-Infinity) ** 0.5` = NaN
  (Math.pow: +Infinity). `** -0.5` intentionally **not** folded — `1/sqrt` double-rounds
  and loses the last ULP vs Math.pow's single rounding; keeps the exact `$math.pow` path.
  Differential-tested across 19 edge inputs before committing. `module/math.js`.
* [x] **Cold/warm + instantiation benchmark** (speedy.js VMIL'17 methodology). Built
  `scripts/bench-startup.mjs` (`npm run bench:startup`): per-snippet src→wasm, wasm→
  instance, jz cold, `new Function`→first result, warm per-call, bytes — snippets are
  pure scalar kernels, valid jz *and* valid standalone JS. Finding: **jz cold-start is
  200–1400× slower than `new Function` + first call** — jz does real AOT work (infer/
  narrow/vectorize/encode) the JS engine skips via lazy compile. The commented-out README
  "compiles faster than `eval`" line is **false**; kept out. jz's edge is tiny portable
  wasm + warm numeric speed on real kernels, not REPL latency.
* [x] **Function-level monomorphization (TurboScript generics) — wontfix.** Idea: clone
  a non-exported function per call-site numeric signature when sites disagree (one i32,
  one f64) instead of leaving the param boxed f64. Probed the trigger across the corpus:
  **bench 0 hits; full suite (~1850 programs) 2 hits**, both a trivial synthetic
  `add(a,b)`. Root cause it can't pay off: `inlineHotInternalCalls` (plan.js:2100) runs
  *before* `narrowSignatures` (plan.js:2127) — hot polymorphic helpers are inlined into
  each site and type-specialized there, strictly better than cloning (no call, no extra
  function). Cloning would only help a function both too big to inline *and* called at
  mixed numeric types — doesn't occur. TurboScript needed it for explicit `Foo<T>`
  generics; jz has none. ~80 speculative lines, zero corpus win. Probe is easy to
  reconstruct; re-open only if a real workload surfaces the pattern.

Follow-ups carried forward as live tasks: Math.* stdlib-pull audit (Perf §, sister to the
sqrt fold), README FAQ entry for the `** 0.5` corners (Ship §), parallelism substrate
(Future § threads/atomics, scope filled in).

Suites: unit 1851 pass / 0 fail; bench gate 81 pass / 0 fail.

### Lint-inspired structural passes — i32 / switch / dupe-keys / form folds (2026-05-21)

The "fix structurally where jz invented the gap" half of the lint-inspired plan. Two
were verified-held (pinned, no code change); two were real lowering/codegen work.

* [x] **i32 narrow range-safety (`no-loss-of-precision`)** — *verified held*. The narrower
  picks i32 only on an i32 *signal* (i32-literal init + i32-only operands / `x|0` / bitwise /
  Int32Array read); any non-i32 source (f64 param, division, elems > 2^31) stays NaN-boxed
  f64 with the exact value. An all-i32-signal accumulator wrapping mod 2^32 is the deliberate
  value-model trade (powers `i32x4` SIMD reductions + scalar digit parsers), not an ambiguity
  bug — a "widen self-accumulators" pass was prototyped and rejected (broke those tests).
  Pinned both directions in `test/inference.js` ("i32 range-safety: …"). `src/analyze.js`.
* [x] **switch fall-through / `default` (`no-fallthrough`)** — lowering rewritten. The old
  if/else-if chain ran one body only; it couldn't express fall-through, stacked labels,
  mid-list `default`, or string discriminants (string switch returned `[0,0,0]` — the
  synthetic temp shed its STRING type and strict-`===` folded every case to `false`). New
  `transformSwitch` is two-phase, evaluated once with no goto: (1) entry index via `===`
  chain over labels (first match, else `default`'s index, else past-end); (2) run clauses
  where `entry <= i`, a `break` flipping a sticky `brk` flag (`rewriteSwitchBreaks`). A
  bare-identifier discriminant uses no temp (keeps its type); `stripTerminalSwitchBreak`
  → `normalizeCaseBody` (keeps breaks for the flag to gate). `src/jzify.js`; 4 capability
  pins in `test/types.js` (fall-through, stacked, default-mid, string). Parser caveat: a
  statement on the *same line* after a `switch {…}` still fails to parse (subscript jessie
  omits the block-boundary signal — `feature/switch.js` `switchBody` skips `}` without
  `parse.exit`); newline-separated (normal style) parses fine. Upstream-gated.
* [x] **duplicate object keys (`no-dupe-keys`)** — *verified held*. Last-wins → single slot
  (`{a:1,a:2}.a===2`, `Object.keys` dedups). Pinned in `test/objects.js`.
* [x] **form normalizations → IR fold (no warning).** `Math.pow(x,n)` constant integer
  exponent (`|n| ≤ 8`) → inline square-and-multiply, eliding the math.pow/exp/log stdlib
  (`module/math.js`, `test/math.js`). `~~x` → single `toI32` (the two xor-with-(-1) cancel;
  NaN/Infinity guard lives in `toI32`, runs once — value-identical to the old double-`~`,
  0 xors vs 2; `src/emit.js` `~`). `!!e` in pure boolean position (if/while/for-cond/`?:`,
  *not* value-preserving `&&`/`||`) → `e`, dropping the double-`eqz` (`src/prepare.js`
  `stripBoolNot`). Both pinned in `test/types.js` with IR-count assertions. Remnants
  (parseInt-of-literal, self-assign, useless-concat/return) left active — low value.

Suites: unit 1851 pass / 0 fail / 1 skip.

### Strict `===` + arg-position ToString (2026-05-21)

Follow-on to the boolean carrier: closed the equality and ToString gaps it
exposed.

* [x] **Un-conflate `===`/`!==` from loose `==`/`!=`.** Strict for
  statically-typed operands — a proven type mismatch folds to `false`/`true`
  with **no coercion** (`true === 1` is `false`, `"1" === 1` is `false`),
  unlike `==`. Same-type operands behave as before. `prepStrictEq` +
  `emitStrictEq`/`STRICT_PRIM` (src/prepare.js, src/emit.js); jzify keeps the
  loose/strict distinction (src/jzify.js). Untyped-dynamic operands stay a
  documented gap (the `null === undefined` unification too).
* [x] **Root-cause fixes surfaced by the above.** (1) `OP_MODULES` now maps
  `===`/`!==` → `['core','string']` (src/autoload.js) so the string module
  registers `__str_eq` when only strict ops appear — was
  `internal: stdlib '__str_eq' was requested but never registered`. (2)
  Destructuring registers each binding name in the arrow's local scope
  (src/prepare.js `prepDecl`), and a bare-identifier source destructures
  without a copy temp — so `let [,x]=strs; typeof x` resolves `'string'`
  instead of mis-folding to `'undefined'` (it was invisible to
  `isUnresolvableBareIdent`). Pinned by 2 new `test/destruct.js` tests.
* [x] **Boolean→ToString in argument position.** `parseInt`/`parseFloat`
  render a statically-known boolean as `"true"/"false"` before parsing
  (`strInputI64`, module/number.js); `String.indexOf`/`includes` coerce a
  BOOL needle the same way and an OBJECT needle via compile-time
  ToPrimitive(string) (`searchArg`, module/string.js). All reuse the existing
  `emitBoolStr`.
* [x] **test262 builtins 719 → 721** — `parseInt(boolean)` /
  `parseFloat(boolean)` unskipped (were fed the 0/1 carrier). Baseline bumped
  in `.github/workflows/test262.yml`. `indexOf/searchstring-tostring.js` stays
  xfail for one reason only: `String({})` is JSON-ish `"{}"`, not
  `"[object Object]"` — all other needle types (bool/number/null/undefined/
  array) now pass.

Suites: unit 1830 pass / 0 fail / 1 skip; test262 language 1431 / 0; builtins
721 / 0. README boolean/FAQ prose untouched (no new divergence — these are
correctness fixes).

### Real-boolean carrier (2026-05-21)

`true`/`false` carry as the cheap `0`/`1` i32 internally — branches and arithmetic
pay nothing, exactly as before. A real boolean is materialized **lazily, only where
boolean-ness is observed**: `typeof`, `String`, `JSON.stringify`, and the host
boundary. The carrier is the existing NaN-box ATOM family (`FALSE_NAN` aux=4 /
`TRUE_NAN` aux=5, siblings of `NULL_NAN`/`UNDEF_NAN`); `4 | truthbit` boxes, decoded
at the boundary like `null`/strings. No `memory.Boolean` wrapper, no wasm-gc — the
atom tags discriminate in wasm-v1 (wasm-gc's `i31ref(0)` wouldn't anyway).

* [x] **Lazy boxing at the export boundary** (`src/compile.js:608`
  `boolBoxIR(typed(callIR, …))`, `isBoundaryWrapped` ← `func.valResult === VAL.BOOL`).
  The inner `$f` keeps the `f64.convert_i32_s` 0/1 carrier; only the `$f$exp` thunk
  reboxes (`__mkptr(0, 4 | __is_truthy(…), 0)`) and is marked `"r":1` in `jz:i64exp`.
  Number-returning exports emit no i64exp entry — zero footprint off the boolean path.
* [x] **`decode` learns the two atoms** (`interop.js:146-155`) — `0x7FF80004 → false`,
  `0x7FF80005 → true`, beside the existing null/undefined arms. Module-private; the
  host export wrapper applies it. Host→jz booleans still coerce to 0/1 via `wrapVal`.
* [x] **Observation sites classify BOOL** (`src/analyze.js` `valTypeOf`): `!`, all
  relational/equality operators, `in`, `instanceof`, `Boolean()` → `VAL.BOOL`;
  `narrowBoolResults()` infers `valResult` on the narrowing-skip leaf path
  (`plan.js` `canSkipWholeProgramNarrowing`). `typeof`/`String`/`JSON.stringify`
  already observe the atom (truthy chain + `isBoolAtom`, `src/ir.js`).
* [x] **IR** (`src/ir.js`) — `BOOL_ATOM_BASE=4`, `FALSE_NAN`/`TRUE_NAN`, `boolBoxIR`
  (materialize from 0/1, used only at the boundary), `unboxBoolIR`, `isBoolAtom`.
* [x] **Tests — `test/booleans.js` (15 tests / 40 assertions)** pin: boundary decode
  for comparisons/equality/`!`/`Boolean()`/literals; `typeof`/`String`/`JSON.stringify`
  observation; branch & arithmetic positions stay the cheap carrier (codegen pin via
  `jz:i64exp` absence); host→jz 0/1 coercion; and the two honest gaps —
  value-preserving `&&`/`||` and bare container reads cross as 1/0. Carrier-only flips
  (1→true, 0→false; value never changed) propagated across errors/statements/strings/
  unsigned/types/symbols/destruct/features/number-methods.
* [x] **README** — "Booleans carry as numbers, surface as booleans" rewritten from
  the old "planned" note to the shipped behaviour, with the two documented limits.

Supersedes the former Deferred › "Boolean ATOM tag" entry. Suite: 1813 → 1828 pass.


#### Product / measurement (needs a measurement+product session, not a compiler edit)
* [x] **AS ecosystem audit.** Done → [.work/ecosystem-audit.md](ecosystem-audit.md).
  Verdict: **don't port AS's test suite** (it asserts a different language;
  test262 + differential fuzzer + bench gate are the right targets). DO mine AS's
  showcase compute kernels (path tracer, emulator core, codec, hash) into
  `bench/`/`examples/`. AS's real traction is blockchain — out of jz's scope,
  don't follow. Sequenced reach plan below.


### Representation carriers — foundation + done workstreams (2026-05-19/20)

Per-site carrier inference. Design narrative (user surface, evidence ladder,
what-ships-vs-what-drops, open policy questions) moved to `research.md` ›
"Representation -> per-site, inferred". Open carriers stay live under `#### Representation`.

* [x] **Narrowing investigation (primary).** Survey (`.work/narrow-survey.mjs`,
  `narrow-watr-hotspots.mjs`; findings `.work/narrow-findings.md`): every numeric /
  typed-array bench already at zero fallbacks; only watr (self-hosted WAT compiler) has
  any — 1289 emits, 47.5 % in its top 10 funcs. Conclusion: remaining dynamic-shape wins
  are codegen-layout + SSO-peephole, not narrower gaps. Follow-ups: C.1 (`Array.isArray`
  facts through `?:`/`&&`/`||`) + F.1 (`for-in` known-schema unroll) landed; C.2
  (`x==null` flow-narrowing) deferred — no nullable-rep consumer.
* [x] **Per-site flat-number specialization.** Verified done-in-effect 2026-05-19: zero
  `*.reinterpret_*` / `__num_box` / `__num_unbox` across 5 bench kernels (crc32, mat4,
  bitwise, sort, biquad). Achieved by narrowing (`narrow.js` phases D param-spec, E
  i32-results, E3 pointer-results, G TYPED ABI) + `analyze.js` `exprType` i32 propagation.
  The `flatI32`/`flatF64` carrier-bundle refactor judged architectural sugar (no
  behavioral benefit) — not built; named goal already reached.
* [x] **SSO flow-through.** Landed 2026-05-19: (a) compile-time literal+literal concat
  folds to one literal (`prepare.js` `'+'`); (b) runtime `__str_concat{,_raw}` SSO-repack
  fast path when both operands SSO and total ≤ 4 (`module/string.js`). Probe confirms heap
  stays pinned for repeated small concats; heap path still fires for total > 4.
* [x] **Foundation (do not undo).** One-file-per-type `src/abi/` (`string.js` sso default +
  jsstring scaffold; `number.js` nanboxF64); slot-carrier contract (carriers emit inline,
  no `src/*` imports); `ctx.abi.<type>.ops.<op>` per-site dispatch; carrier peephole
  (`nanboxF64.peephole`); single `interop.js` codec (DRIVERS table removed).

(jsstring boundary carrier and `opts.host` user surface have their own dated entries below.)

### opts.host user surface + custom sections reference + SoA boundary pin (2026-05-20)

Cleanup pass on the `opts.host` knob and a pinned boundary for SIMD
vectorization. No new feature surface — the work made existing behaviour
visible and irreversible.

* [x] **`host: 'gc'` reserved-mode error** (`index.js:315`). Distinct error
  text so users see it as planned-future, not unknown-garbage: "reserved for
  a planned wasm-gc backend, not yet implemented. Use 'js' (default …) or
  'wasi' (standalone runtimes — no env imports)."
* [x] **wasi tolerance comment** (`src/emit.js:2563`). Documents that the
  silent `undefExpr()` fallthrough for unknown receivers under `host: 'wasi'`
  is by-design — `test/wasi.js` cases 235 and 245 pin it explicitly so
  polymorphic source can target both modes from one source. `strict: true`
  is the documented fail-fast opt-in.
* [x] **README — host modes**. Existing `host: 'js'` / `'wasi'` FAQ extended
  with the `gc` reservation note and a pointer to `strict: true` for users
  who want the wasi unknown-receiver path to error instead of no-op.
* [x] **README — custom sections reference** (new FAQ). First public
  documentation of the four sections jz emits: `jz:schema` (rehydration
  shapes), `jz:rest` (rest-param fixed counts), `jz:i64exp` (per-export
  i64-ABI map for NaN-canonicalization dodging), `jz:extparam` (externref
  param positions + JS-side defaults — written by the jsstring carrier).
  Names declared stable; binary layouts declared internal.
* [x] **SoA vectorization — README FAQ + tests** (`test/simd.js`,
  `README.md`). Documents the supported shapes (same-array, cross-array,
  SoA-3 / SoA-4 separate typed arrays per field) and the unsupported AoS
  interleaved shape with the mechanical migration path. Three new tests:
  SoA-3 fused map lifts to `f64x2`; SoA-4 RGBA luminance blend lifts; AoS-
  stride-2 must NOT lift (parity intact) — pins the boundary so future
  changes can't accidentally promise AoS without a real struct-splitting
  carrier. Counterpoint to the still-open Live-work AoS-write bullet, which
  remains the multi-week deferred carrier.

**Skipped deliberately:** a `jz:host` feature-stamp custom section. `interop.js`
already detects required features from imports (`wasi_snapshot_preview1`,
`env`, `wasm:js-string`); the extra surface adds no consumer value and would
become permanent maintenance debt.

tests: 1769 → 1772 pass (+3); commit `06b0e69`.

### jsstring boundary carrier (2026-05-20)

The `jsstring` carrier from `src/abi/string.js` is now wired end-to-end as a
**per-export-param boundary opt-in**. Eligible exports take their string param
as `externref` (zero-copy JS-string pass-through) instead of the f64/SSO carrier
(per-call UTF-8 transcode into wasm memory).

* [x] **Narrower phase J — `applyJsstringBoundaryCarrier`** (`src/narrow.js`).
  Per export, per param, flip `p.type` from `f64` to `externref` *only if* every
  use is `wasm:js-string`-builtin-mappable AND at least one use proves the param
  is a string. Proof sources, any of: (a) a `.charCodeAt` use (string-only
  method), (b) call-site rep evidence `VAL.STRING`, (c) string-literal default
  `s = ''` (declared intent). Rejects: reassignment / `++` / `--`, closure
  capture, escape into non-builtin calls, unbounded `.charCodeAt` (would trap
  where JS returns `NaN`). Standalone entry point exported for
  `canSkipWholeProgramNarrowing` short-circuit. Gated by `jsstringEnabled()` —
  off under `host: 'wasi'`, off when `optimize.jsstring === false`.
  `scanBoundedLoops` exported from `src/analyze.js` for the in-bounds proof.
* [x] **Builtin import channel** (`ctx.core.jsstring: new Set()` in `src/ctx.js`).
  Drained at module-assembly into `(import "wasm:js-string" "<name>" …)` nodes
  with `JSS_IMPORT_SIGS` from `src/abi/string.js`. The set tracks only the
  builtin names actually used by this module.
* [x] **Lowering** — `module/core.js` `emitLengthAccess` dispatches on
  `va?.type === 'externref'` → `(call $__jss_length va)`; the call site reads
  `emit(obj)` *before* `asF64` so the externref type isn't stripped.
  `src/emit.js` in-bounds `.charCodeAt` dispatch checks `recv?.type === 'externref'`
  → `(call $__jss_charCodeAt recv idx)`.
* [x] **Boundary wrapper + custom section** (`src/compile.js`). Boundary wrapper
  takes `(param externref)` for flipped slots; the wrapping i64/f64 ABI dance
  is skipped on those slots. A `jz:extparam` JSON custom section records, per
  export name, the indices `p:[…]` whose carrier is externref, plus optional
  `d:{idx:'str'}` for JS-side defaults so the wasm side never sees a null
  externref. Default-param init loop in `emitFunc` skips the `=== undefined`
  branch for jsstring params (substitution moves to the JS-side wrapper).
* [x] **interop.js boundary wiring**. Reads `jz:extparam`; for marked indices
  the wrapper writes `(${a} === undefined ? ${dn} : ${a})` directly, skipping
  `mem.wrapVal` (which would NaN-box the JS string). Native `wasm:js-string`
  detected by a one-time probe: if `new WebAssembly.Module(buf, { builtins:
  ['js-string'] })` instantiates with no imports, the engine handles the
  builtins itself (V8 17+ / Node 25+ / Safari 18.4+); otherwise a JS polyfill
  (`(s) => s.length`, `(s, i) => s.charCodeAt(i)`) is attached.
* [x] **Opt-out flag** — `optimize.jsstring: false` ([src/optimize.js] PASS_NAMES
  + the `jsstringEnabled()` gate in narrow.js) keeps every param on the
  f64/SSO carrier. Used for paired benches and engines that mishandle the
  builtins option.
* [x] **Tests — 10 / 22 assertions** ([test/jsstring.js]). Covers: opt-in fires
  on bounded `.charCodeAt`+`.length`; runtime correctness sums char codes
  through externref; `.length`-only stays polymorphic (number → undefined);
  unbounded `.charCodeAt` declines (trap-safety); reassignment / closure
  capture / `s + 'x'` escape all decline; string-literal default fires the
  opt-in even without `.charCodeAt`; JS-side default substitution on
  `undefined`; numeric default doesn't trigger.
* [x] **Bench** — `bench/jsstring/bench-jsstring.mjs` paired-compilation
  baseline. On Node 25.9 native, `.length(s)` opt-in is 22× faster at 8 chars,
  154× at 256, 5510× at 8192 — boundary-copy elimination dominates. `.sum(s)`
  (`.charCodeAt` loop) is 10.5× / 1.5× / 1.3× faster across the same sizes —
  win compresses as per-char work begins to dominate. Jessie section
  documents the correct-rejection case (param escapes into `parse()` — not a
  builtin — both compilations byte-identical, ~1.0× ratio confirms no
  side-effect).
* [x] **README** — new FAQ "How do strings cross the boundary?" with the
  two-carrier table, opt-in trigger matrix, engine support, opt-out flag, and
  bench pointer.

### watr 4.6.9 upgrade — drop 'light' mode workaround (2026-05-20)

* [x] **'light' watr mode removed** (`a26ea84`). L2 was running a curated watr
  subset (`inline / inlineOnce / coalesce` all off) since 4.6.4 to dodge two
  upstream miscompiles:
  - **W1a** — `inlineOnce` dropped a single-call helper's bare-`local.get`
    body (root-node `walkPost` return value discarded; substitution lost).
  - **W1b** — `coalesceLocals` merged a zero-dependent local into a residue-
    carrying slot when `inlineOnce`'s `needsReset` zero-init ran before
    `propagate`'s cleanup sweep. Trigger: `/a.+b/.test("ab")`.

  watr 4.6.9 ships fixes for both. L2 now runs the full watr default pipeline
  (treeshake / dedupe / dedupTypes / coalesce / propagate / packData / fold /
  peephole / vacuum / mergeBlocks / brif / loopify / inlineOnce / …). `inline`
  stays off per watr's own default — opt-in only; can duplicate bodies. L3 no
  longer needs an "inlining bonus" — its preset reads truthfully as L2 + larger
  array/hash initial caps + `hoistConstantPool` off.

* [x] **jz csePureExpr snapId — high-water mark, not first gap** (`fed07f8`).
  watr's full `coalesceLocals` removes redundant locals, so the surviving
  `$__pe<N>` set is non-contiguous; the old first-gap allocator picked an
  already-live id and triggered "Duplicate local $__pe20" on mat4. Fixed by
  scanning all surviving cse-pure-expr locals for a high-water mark.

* [x] **17 codegen-shape tests rewired to `optimize: { watr: false }`**.
  Tests in `test/{types,closures,features,feature-gating,optimizer,inference}.js`
  verify jz's compile-time decisions (slot-type dispatch, narrowed return
  types, closure-unbox declarations, escape-analysis allocations, LICM snap
  locals, sourceInline skip-into-export, charCodeAt i32 propagation, …) — not
  watr's downstream cleanup. With full watr running at L2, `inlineOnce` would
  fold non-exported helpers into their lone caller and `treeshake` would erase
  them, so a `(func $mk …)` regex no longer matched. Probe call sites now opt
  out of watr explicitly, making the intent visible at each call.

* [x] **Subscript / watr dead-code workarounds dropped** (`8ef4b46`, `4f9e64a`):
  trailing-null pop in `'()'` emit (closed by subscript 10.4.13's S12 fix) and
  the W5 unsigned-hex `i64.const` dance (closed by watr 4.6.8 handling signed
  hex strings directly). Workaround tag in `prepare.js` 1768–1777 (S2 `new`
  precedence) and the IIFE/labeled-stmt patches in `jzify.js` remain — gated
  on the next subscript release.

bumps: `subscript 10.4.12 → 10.4.13`, `watr 4.6.8 → 4.6.9`.
tests: 1759/1759 unit; 81/81 bench-shape; bench parity holds.

### test262 language tail + native-gap audit (2026-05-19)

* [x] **5 language fails → 0** (language suite 1423→1429, baseline bumped).
  Three codegen defects + one harness boundary fix — `fix:` commit `117fbd0`:
  - comma Expression in a for-in/of head (`for (x in A, B)`) — `jzify.js`
    `normalizeForDeclHead` generalized + new `normalizeForCommaHead` fold the
    trailing operands back into the iterated source; internal crash eliminated.
  - `[,]` / `[1,,]` array elisions — `prepare.js` `'[]'` over-trimmed a trailing
    `null`; jessie already consumes the trailing comma, so every residual `null`
    is a genuine hole. Trim removed.
  - `dedupeRedecls` read only the first name of a multi-name bare `let`, leaking
    a redeclaration when a hoisted function `const` shared the name. Now walks
    every declarator.
  - `test262.js` ASSERT_HARNESS terminated with `;` — works around a subscript
    ASI bug (no semicolon after an arrow block body before `(`). Upstream
    subscript bug — repro belongs in plan Part 1.
* [x] **crc32 vs native** — wasm-v1 floor. jz 11.95 ms = 1.12× clang -O3, beats
  V8 (13.34 ms). Native's edge is the SSE4.2 `crc32` hardware instruction; SIMD
  folding needs carryless multiply (`clmul`, a separate wasm proposal). The CRC
  accumulator is strictly loop-carried — `vectorizeLaneLocal` correctly declines.
  No jz codegen change available; scalar table-driven is optimal.
* [x] **mandelbrot vs AS** — wasm-v1 algorithmic floor (no scalar `fma`),
  proposal-blocked. (`interference` / `game-of-life` are not in the bench suite.)
* [x] **f64 cross-array-map vectorization** — `optimize:` commit `b3bd828`.
  `vectorizeLaneLocal` now sees through the CSE'd offset-tee a map `b[i]=f(a[i])`
  over two base pointers produces (`(local.tee $T (i32.shl i K))` then
  `(local.get $T)`). New `matchLaneOffset` + `_offsetLocalStride` soundness gate
  in `src/vectorize.js`, wired into `tryVectorize` + `tryReduceVectorize`. f64
  cross-array map loops now emit `f64x2`; tests in `test/simd.js`. AoS-write and
  i32 mixed-width remain — see Live work › "native-gap audit".

### Generality track — Step 3 (2026-05-19)

* [x] **Slice views.** `__str_slice_view` / `SLICE_BIT` returns a no-copy view
  into the parent buffer when escape analysis proves the slice never outlives
  it; falls back to copy for SSO parents or oversized lengths.
* [x] **Literal interning.** `dataDedup` / `strPoolDedup` pool string-literal
  data segments — equal literals share one offset, compare by pointer.
* [x] **`s[i] === 'X'` no-alloc charcode compare** (`emitSingleCharIndexCmp`).
* [x] **`<str>.{substr,substring,slice}(…) === <other>` no-alloc** (`8b74dce`).
  `emitSubstringEqCmp` peepholes the call-↔-value pair to `__str_{substring,
  slice}_eq`, which clamp the range exactly like the method then byte-compare
  it against `other` in place. `__str_range_eq` type-checks only `other` (a
  substring method's receiver is always a string), mirroring `__eq`'s
  STRING-vs-? arm. `substr`/`substring` name string-only methods so unknown
  receivers are safe; `slice` requires a statically-known STRING receiver
  (else dispatches to array slice).
* [x] **Runtime scanned-identifier intern table — declined as speculative.**
  Audited real workload (`subscript/parse.js:73,98,150`,
  `subscript/feature/comment.js:16,19`, `bench/jessie`): every
  `substr`/`substring`/`slice` is inline with `===`/`!==` already, which the
  substring-eq peephole above covers no-alloc. No `let id = src.substr(...);
  if (id === "x") else if (id === "y")` pattern in any current corpus. Re-open
  only if a real bench surfaces the bound-then-multi-compare shape as a hot path.

### i32 map-loop audit (2026-05-19)

* [x] **Idiomatic i32 map-loops already vectorize.** Probed `((a[i]|0) * 2 + 1)
  | 0` and `Math.imul(a[i], 2) + 1` over `Int32Array`: the full path composes —
  typed-array carrier inference (`src/analyze.js` `typedElem`, `module/typedarray.js`
  `.typed:[]` / `.typed:[]=`) lowers `state[i]` to direct `i32.load`/`i32.store`,
  watr inlines the kernel into the caller's carrier scope, and the existing i32
  lane vectorizer (`src/vectorize.js`) lifts the body to `i32x4.*`.
* [x] **Plain `a[i] * 2 + 1` (no `|0`) stays scalar — by spec.** JS forces f64
  math and ECMAScript ToInt32 (modular wrap) at the store. Wasm-v1 SIMD ships
  only `i32x4.trunc_sat_f64x2_*_zero` (saturate); relaxed-SIMD is also saturate
  (implementation-defined for out-of-range). A wrap-trunc lane requires a
  manual modular sequence that erases the speedup. Pragmatic answer: use `|0`.
  Not a residual jz codegen gap.

### Generality track — Steps 1, 2, 4 (2026-05-19)

* [x] **Step 1 — use-summary substrate** (`a11578f`..`88bdb52`). The original
  "four escape analyses, fragments of one analysis" framing was partly
  illusory: `scanFlatObjects`/`scanSliceViews`/`unboxablePtrs` *were* three
  redundant standalone body re-walks, but `analyzeBody.escapes` is context-
  sensitive taint woven into the typing walk (separating it would *add* a
  traversal) and `analyzeStructInline` is whole-program post-representation.
  Honest unification: `scanBindingUses` (`analyze.js`) — one traversal
  classifies every binding mention into a closed `USE.*` taxonomy; the three
  real consumers became *policies* (subset predicates). ~6 body traversals → 1.
  `escapes` / `analyzeStructInline` stay separate (boundary in the doc comment).
* [x] **Step 2 — function-namespace SROA** (`9b538d7`). `analyzeFuncNamespaces`
  + `flattenFuncNamespaces` dissolve `parse.space = …` property tables on a
  non-escaping function value into f64 module globals; reads → `global.get`.
  Escaping / computed-indexed namespaces keep the dynamic path. ns-repro
  105 KB → 45 KB WAT, all `__dyn_*` gone.
* [x] **Step 2 — object/dict SROA extended.** `scanFlatObjects` Pass 1.5 admits
  monotonic literal-key field extensions (`o.newProp = …` on a non-escaping
  object literal → extra flat field, `undefined`-init at decl). Field universe
  stays statically closed (computed-key / off-schema / `delete` disqualify).
* [x] **Step 2 — devirtualization** (`31253b6`). Audited the `call_indirect`
  surface: every *non-escaping* function binding was already devirtualized —
  local `const`/`let` lambdas (inlined when small, else direct-call dispatch,
  emit.js A3) and top-level function-namespace slots (`flattenFuncNamespaces`
  SROA → `devirtGlobalCalls`). One real gap: a *forwarder* `(g,x) => g(x)` —
  inlining it substitutes the param with the call-site argument, collapsing an
  indirect call to a direct `call` — was blocked from exported callers by a
  tier-up heuristic that only ever concerned loop kernels. `inlineHotInternalCalls`
  now marks forwarders and lets them cross into exports; `HOF param call` /
  `fn passed as arg` emit zero `call_indirect`. What stays indirect is genuine
  escape (function returned / array-stored / conditionally reassigned to >1
  target) — removable only by watr inlining (Part 3, upstream-gated) or
  interprocedural escape analysis, neither a body-local proof jz can make. The
  dominance / last-write proof the original framing imagined has no measured
  workload demanding it (the namespace SROA already covers top-level init
  writes) — not built, not minimal.
* [x] **Step 4 — memory scalar-replacement** (`3055e4c`). Carr & Kennedy
  register promotion behind `cseSafeLoadBases` (`analyze.js`), an emit-side
  non-aliasing whitelist (unboxed pointer, bound once, read-receiver-only,
  alloc kind disjoint from every store target). `aos`: 6 field reads → 3
  `f64.load`; `jz → V8 wasm` 0.99 ms / 0.82× — faster than native C (1.21 ms)
  and hand-WAT (1.07 ms). Standalone gate, not the Step-1 substrate.

### Execution plan — Phase 0 + Steps 1–6 (resolved 2026-05-17)

* [x] Phase 0 (declarative reorg, C1–C3) — emitter-table spine; redirected once
  the builtins audit showed an empty in-scope tail, kept as a structural refactor.
* [x] Steps 1–6 — Step 1c leaf builtins (one table row each), Step 2a
  correctness commit, Step 3 narrowing-evidence survey (`.work/narrow-findings.md`:
  numeric/typed-array benches at zero fallbacks, only watr has any). Step 4
  (number carrier dispatch) redirected — the i32|f64 choice is a working 1-bit
  decision on `node.type`; a carrier table would re-encode it with one consumer.
  Step 5 object carrier landed (see "Object layout carrier" below). Step 6 descoped.
* [x] `src/abi/array.js` — landed: `taggedLinear` default + `structInline` SRoA
  carrier (see "structInline SRoA carrier" below).
* [x] `ctx.features` cleanup (39beeb2) — `hash`/`regex`/`json` dead flags deleted.
* [x] Infer rungs 6 & 8 — rung 6 (`x === null` flow-narrowing) out of scope (no
  nullable-rep consumer); rung 8 (name heuristic) declined (silent-miscompile risk).
* [x] test262 in-scope-correctness audit (ea1ce43) — all 96 builtins "fails" are
  out-of-scope-by-design; runner buckets 34 skip + 62 xfail + 0 fail, CI gates
  `fail > 0`. Hygiene items folded in.

### structInline SRoA carrier + collection-method dispatch fix (2026-05-17)

* [x] `structInline(K)` carrier (`src/abi/array.js`) — an `Array<{uniform K-field
  schema}>` whose element pointers never escape inlines K f64 schema fields into
  the array data region (stride K), no per-row heap object. Whole-program
  default-disqualify analysis `analyzeStructInline` → `ctx.schema.inlineArray`.
  Header `len`/`cap` count physical f64 cells, so the stride-8 stdlib helpers are
  reused untouched. Closes the `aos` native gap (1.13 → 0.94 ms, checksum
  unchanged). Commits `2be7974` (carrier), `c455ffc` (analysis), `438eeb6` (codegen).
* [x] Collection-method dispatch fix (`d70ec66`) — a zero-arg call of a
  collection-named method (`get`/`set`/`has`/`add`/`delete`) on a
  not-proven-collection receiver (`new C().get()`) no longer falls to the Map/Set
  emitter (which `emit()`-ed a missing key arg and crashed codegen); a
  `COLLECTION_METHODS` set + `collectionMisfit` gate in `emit.js` routes it to
  closure/dynamic dispatch. Test pin in `test/classes.js`.

### Object layout carrier — src/abi/object.js

* [x] 5a. `tagged` carrier (today's layout: `__alloc_hdr` + N×8-byte f64 slots).
  Every object-field site across module/{object,core,array,json}.js +
  src/{emit,ir}.js routed through `ctx.abi.object.ops` (`allocSlots` / `load` /
  `loadBits` / `store`) — two duplicate address helpers (`slotAddr`,
  `emitSchemaSlotRead`) collapsed into one owner. Byte-identical: 19-snippet
  binary-diff proof (identical sha256 wasm). Two over-fitted WAT-text tests
  (inference.js, perf.js) adjusted to read non-zero schema slots.
* [x] 5b-flat. `flat`/SRoA carrier — a non-escaping `let/const o =
  {staticLiteral}` binding is dissolved into plain WASM locals (`o#0`, `o#1`,
  …): no `__alloc_hdr`, no heap, no field load/store; `o.prop` → `local.get`.
  `scanFlatObjects` (analyze.js) conservative eligibility scan — eligible iff
  `o` appears only as a literal-key in-schema `.`/`[]` read or write LHS; any
  escape (bare ref, dynamic key, off-schema prop, `?.`, reassign, compound,
  `++`/`--`, delete, closure capture, self-ref, dup keys, re-decl)
  disqualifies. Dead `o` local dropped so a stray `local.get $o` is a loud
  wasm error. 5 codegen hooks (emitDecl + `.`/`[]` read & write). `let
  o={a:1,b:2,c:3}; o.a+o.b+o.c` folds to one `i32.const`.
* [~] 5b-packed. i32-narrowed 4-byte field cells — DESCOPED 2026-05-17:
  uniform 8-byte f64 shapes are fine, memory compression is not a goal. Would
  need a stricter `slotI32Certain` (i32-range, not integer-shaped) analysis +
  layout-aware rewrites of every uniform-slot walk. Revisit only if a bench
  demands it.

### Jessie compilation blockers (see [.work/jessie-wasm.md](jessie-wasm.md))

* [x] #1 spread in `?.()` — `fn?.(...args)`
* [x] #2 Error subclasses (`SyntaxError`/`TypeError`/`RangeError`/`ReferenceError`/`URIError`/`EvalError`)
* [x] #5 CLI bare side-effect imports `import './x.js'`
* [x] #6 `new RegExp("lit")` literal pattern + clean error for dynamic
* [x] #7 `Object.create` stdlib include — `array` module wasn't pulled in for `__arr_from`
* [~] ~~#3 `Object.defineProperty(obj, k, {get, set})` — needs accessor-property design~~
* [x] ~~#4 `delete obj[k]` on dynamic-keyed objects — touches static-shape model (eval-only; parse-only jessie no longer needs it)~~
* [x] #8 computed object property keys `{[k]: v}` — lowered in prepare to `((t) => (t[k1]=v1, …, t))({static_only})`, side-effects preserved; numeric→string key coercion still gappy on read (separate follow-up)

### Product / Validation

* [x] Options breakdown in readme
* [x] Implement `Date.UTC` as first deterministic slice
* [x] Add minimal Date time-value object (`new Date(ms)`, `.getTime()`, `.valueOf()`, `.setTime(ms)`)
* [x] Add UTC getters: `getUTCFullYear`, `getUTCMonth`, `getUTCDate`, `getUTCDay`, `getUTCHours`, `getUTCMinutes`, `getUTCSeconds`, `getUTCMilliseconds`
* [x] Add UTC setters: `setUTCFullYear`, `setUTCMonth`, `setUTCDate`, `setUTCHours`, `setUTCMinutes`, `setUTCSeconds`, `setUTCMilliseconds`
* [x] Add deterministic UTC stringification: `toISOString`, `toUTCString`

### Validation & quality

* [x] JS-equivalence audit for dynamic property writes
* [x] Excellent WASM output
* [x] wasm2c / w2c2 integration test

### Escape analysis for short-lived literals

* [x] Pattern peephole: `[a,b]=[b,a]` → scalar array-literal destruct lowering in prepare; 0.7ms → ~0.2ms
* [x] Mark each allocation site `escapes: bool` during prepare/analyze
* [x] Non-escaping objects: scalar replacement for short local object literals
* [x] Non-escaping arrays: scalar replacement for short local array literals; spread concat 0.9ms → <0.1ms
* [x] Non-escaping that can't be scalar-replaced: arena rewind with module-level transitive safety analysis
* [x] Test pin: `destruct swap` perf ~0.2ms, codegen asserts no array allocation

### Per-function arena rewind

* [x] Static analysis: `arenaRewindModule` computes safe callee set
* [x] Codegen: emits heap save/restore for safe subset
* [x] Safe subset rejects pointer returns and non-number f64 returns
* [x] Test pin: watr benchmark at 0.99ms vs V8 1.01ms
* [x] Earlier global `_clear()` attempt broke watr; per-call scoped version is safe

### Inline cache for polymorphic shape sites

* [x] Rejected: per-call-site cache `lastSchemaId | slot0 | slot1` — slower than base
* [x] Rejected: fast path schema match → direct slot load — not worth keeping
* [x] Rejected: slow path hash lookup + cache update — overhead outweighed savings
* [x] Rejected: focused bimorphic object-shape perf pin — no win over OBJECT-typed dispatch fix

### Stack-allocated rest-param arrays for fixed-arity sites

* [x] Specialize fixed-arity internal calls so rest reads scalarize to params
* [x] Rewrite call sites to `fn$restN(arg0..argN)` clones
* [x] Test pin: `rest sum` perf 2.7ms → ~0.6ms (4.5×)

### SIMD auto-vectorization for typed-array reductions

* [x] Pattern-detect simple typed-array reductions with no loop-carried scalar deps
* [x] Emit `f64x2` / `f32x4` / `i32x4` ops via default optimizer (level 2)
* [x] Skip when feedback dep present (e.g. biquad cascade)
* [x] Test pin: `typed sum` perf 4.2ms → ~2.2ms (1.9×)

### Smaller wins

* [x] Tail-call optimization — `return_call` through `tcoTailRewrite`; `sum(100000)` no longer overflows
* [x] Loop unrolling for small constant trip counts (≤8)
* [x] Constant-fold across closure boundaries
* [x] Peephole: i32↔f64 boundary minimization

### Performance — closing the native-language gap

* [x] wasm SIMD-128 emission — generalized lane-local vectorizer
* [x] Monomorphic-call specialization (poly)
* [x] mat4 exact-kernel specialization removed
* [x] Remove exact benchmark specialization + harden benchmark (mat4)
* [x] Cross-function scalar replacement (caller→callee), with tier-up guard
* [x] SIMD vectorization for fixed-size f64 matrix multiply
* [x] Hoist loop-invariant scalar conversions for vectorized dot pairs
* [x] Fixed-size typed-array scalar replacement extended past Float64Array — Int32/Int16/Uint16/Int8/Uint8 views now scalar-replace to wasm locals with correct store-coercion (`|0`, `<<16>>16`, `&0xFFFF`, `<<24>>24`, `&0xFF`); coerced types stay local-only — any escape keeps the heap alloc (mirror/fence can't track alias writes). `4918e02`
* [x] `optimize: 'size' | 'speed' | 'balanced'` string aliases over the size↔speed unroll/scalar knobs `8ca6f18`
* [x] Closed as low-value: Float32Array / Uint8ClampedArray / Uint32Array scalar replacement (Float32 needs `Math.fround` ⇒ `math` module pulled at plan time; Uint8Clamped is round-half-even; Uint32 range >2^31 collides with jz's i32 narrowing of `x>>>0`) — edge semantics, no measured win
* [x] Closed as low-value: partial unroll + f64x2 vector body for mat4 — inner loops are constant-trip 4×4×4; full unroll + f64x2 dot-pairing already runs mat4 at 0.78× native C
* [x] Closed as low-value: json arena/raw-u8 fast path — bench already ≈1.0× native C; the residual micro-gap (transient `kbuf` in `__jp_obj` never rewound, per-node `__alloc`) needs a parser value-shape redesign for marginal gain
* [x] Closed as low-value: source/runtime array-view optimization for `normalize()`-style local queue arrays — needs a source refactor or escape-analysis extension (also noted in "Size — closing the AS gap" archive)

### Competitive size/speed gate

* [x] **sort (heapsort) ~8.6× → V8 parity** — `narrow.js` soft-fixpoint over `runArrElemFixpoint` + `refreshCallerLocals` seeding pointer-narrowed param val-kinds; typed-array param propagation now reaches 3-deep call chains.
* [x] **`Math.round` JS-parity** — ties-toward-+∞ (was ties-to-even via `f64.nearest`).
* [x] **`Math.imul`/`Math.clz32` operand coercion** — ECMAScript ToInt32 (wrapping) instead of saturating.
* [x] **All `bench/bench.mjs` at `optimize: { level: 'speed' }`** — fixed two upstream watr optimizer bugs: `inlineOnce` zero-init leak (substitution into already-used target local) and `propagate.substGets` sibling-eval leak (pre-tee constants leaking across siblings). Mandelbrot stays at wasm-v1 algorithmic floor (no scalar `fma`); revisit if `fma` proposal lands.

### i64-tagged carrier switch — investigated, closed wontfix

* [x] Spike + codegen survey (`.work/i64-spike/`). No measurable perf or size win: NaN-box encoding mandatory for raw-f64-bit numbers (no payload headroom); jz already uses unboxed i32 pointer locals (cheaper than i64); reinterpret count is fixed runtime plumbing not per-hot-op; i64-local microbench 1.49× slower; JSON WALK 1.01×, PARSE 0.76×. Boundary simplification not worth the carrier refactor.
* [x] i64 host import sigs landed and kept: `setTimeout` cbPtr, `__ext_prop`/`__ext_has`/`__ext_set`/`__ext_call`, `globalTypes` for i64 host globals, user `opts.imports` sigs.

### JZ-side prep

* [x] Host-import mode — `compile({ host: 'js' | 'wasi' })`
* [x] `setTimeout` / `setInterval` host-driven
* [x] `import.meta`: static `import.meta.url`, `import.meta.resolve("...")`
* [x] Aggressive monomorphic single-caller inlining for hot internal functions
* [x] Couple constant-argument propagation with inlining/unrolling
* [x] Audit typed-array address/base fusion on EdgeJS benchmark
* [x] Bounds-check elision hints for monotone typed-array loops — closed as research-only
* [x] i32 narrowing for integer-heavy kernels — reverted; V8 inliner regression

### Concrete size cuts

* [x] Drop unconditional `inc('__sso_char', '__str_char', '__char_at', '__str_byteLen')`
* [x] Break `MOD_DEPS` cycle `number ↔ string` at `prepare.js:1054`
* [x] Strip data segment for non-emitted strings
* [x] Replace `wasi.fd_write`/`clock_time_get` with `env.printLine` / `env.now`

### Concrete optimizations

* [x] Scalar-replacement of repeated typed-array reads
* [x] Aggressive inlining for monomorphic single-caller hot funcs
* [x] i32 narrowing for module-const integer args (revisit nStages) — reverted
* [x] Loop-invariant hoist of `arr.length` — verified already hoisted
* [x] Bounds-check elision for monotone counters — closed as research-only
* [x] Symmetric widen-pass for length comparisons — closed

### Benchmarks

* [x] Polymorphic reduce benchmark
* [x] fib / ackermann — TCO now implemented

### EdgeJS integration

* [x] Keep safe-mode out of PR claim
* [x] Pick one undeniable use case and optimize around it
* [x] Add benchmark coverage beyond internal examples
* [x] Add wasm2c/w2c2 integration tests
* [x] Rework/close PR #2
* [x] Harden `jz/wasi` default output routing
* [x] Add tests for stdout/stderr fallback
* [x] Do not publish `instantiateAsync`
* [x] Document host contract in README
* [x] Add EdgeJS-compatible smoke fixture
* [x] Build/install EdgeJS locally and verify basic JZ usage
* [x] Verify EdgeJS safe mode behavior
* [x] Verify JZ modules with no WASI imports run in EdgeJS without polyfill
* [x] Verify explicit console host imports under EdgeJS
* [x] Check WASM exception support in EdgeJS — blocked, documented
* [x] Open PR to `wasmerio/edgejs` as example/benchmark
* [x] Add `examples/jz-kernel`
* [x] Include README note: JZ is useful for hot numeric, DSP, parser, typed-array kernels
* [x] Include before/after numbers from reproducible commands
* [x] Fix draft benchmark shape: compile once, call one export, keep hot loop inside WASM
* [x] Replace toy scalar benchmark with stronger kernel from existing suite
* [x] Move `/tmp/jz-edgejs.../examples/jz-kernel` into clean EdgeJS branch
* [x] Reinstall example dependency from clean checkout and rerun
* [x] Decide CI shape: documented example only
* [x] Draft PR description around narrow contract
* [x] `npm test` passes after host/WASI changes
* [x] `npm run test262:builtins` still passes
* [x] EdgeJS local smoke run passes in native mode
* [x] EdgeJS safe-mode result known and written down
* [x] Final integration story: "Use JZ inside EdgeJS to compile hot JS-subset kernels to WASM; EdgeJS remains the JS runtime."

### test262 coverage expansion

* [x] Report overall test262 percentage against all `test262/test/**/*.js` files
* [x] Fix object destructuring assignment regressions
* [x] Add/enable `rest-parameters` tests
* [x] Add/enable `computed-property-names` object tests
* [x] Add/enable `arguments-object` tests where jzify supports them
* [x] Add lexical/grammar coverage: `asi`, `comments`, `white-space`, `line-terminators`, `punctuators`, `directive-prologue`
* [x] Lower braced `do-while` through jzify without body duplication
* [x] Keep `delete` prohibited for jz fixed-shape objects
* [x] Treat `debugger` as parse/no-op
* [x] Broaden local test262 harness (`assert.*`, `Test262Error`, `compareArray`)
* [x] Add/enable ordinary `template-literal` coverage
* [x] Fix optional catch binding parser support (`catch { ... }`)
* [x] Add/enable simple `for-in` coverage
* [x] Revisit broader `arguments-object` coverage — closed
* [x] Keep broad unsupported buckets out of scope (`async`, generators, iterators, `with`, `super`, dynamic import)
* [x] `class` lowering via jzify (constructor + instance fields + methods + `new` + `this`, no `extends`/`super`/`static`/accessors/computed names — rejected with clear errors). Instance = plain object, methods = per-instance arrows capturing it, `this` renamed to that object, `new C(a)` → `C(a)`. `test/classes.js` + `language/{expressions,statements}/class/` wired into the test262 runner with a feature-skip pass (`isClassTest`/`CLASS_EXCLUDED_PATTERNS`): +125 passing class tests, 0 failing.
  * [x] Fixed (`d70ec66`): `new C().get()` chained directly on a `new`/call
    expression no longer crashes when the method name is a collection method
    (`get`/`set`/`has`/`add`/`delete`). `emit.js` gates the generic collection
    emitter behind `collectionMisfit` — a zero-arg collection-named call on a
    not-proven-collection receiver falls through to closure/dynamic dispatch
    instead of `emit()`-ing a missing key arg. Test pin in `test/classes.js`.
* [x] Triage remaining test262 language failures → 0 failing (827 passing). Added path-based skip rules in `test/test262.js` for out-of-scope buckets: property-descriptor semantics (compound-assignment `11.13.2-23..44-s`, logical-assignment `*-non-writeable*`/`*-no-set*`, `types/reference/8.7.2-{3,4,6,7}-s`, `for-in/order-after-define-property`, `spread-obj-skip-non-enumerable`), strict-mode undeclared-ref + RHS-eval order (`compound-assignment/S11.13.2_A7.*_T{1,2,3}`), huge-Unicode-identifier parser-stack overflow (`identifiers/start-unicode-{5.2.0,8,9,10,13,15,16,17}.0.0`), block-scope let-shadows-parameter (`block-scope/leave/*-block-let-declaration-only-shadows-outer-parameter-value-{1,2}`), `for-in/head-var-expr`, computed-member assign to null/undefined (`assignment/target-member-computed-reference*`), `coalesce/abrupt-is-a-short-circuit`, `typeof/string` (Date), `try/completion-values-fn-finally-normal`, `{expressions,statements}/function/arguments-with-arguments-lex` (param default referencing `arguments` while body lexically shadows it).
  * [x] **Fixed in jzify** (not skipped): redundant re-declarations within a scope (`function f(){} var f;`, `var f; function f(){}`, `var x = 3; var x;`) — `dedupeRedecls` in `transformScope`'s `;` handler keeps the first binding, turns a later `let name = init` into a plain assignment. Was a typed-slot clash in codegen.
  * [x] **Fixed in jzify** (not skipped): `var arguments;` / `let arguments` — a body that declares its own `arguments` local is an ordinary variable, not the implicit object: `bindsArguments` makes `lowerArguments` rename it out of jz's reserved set with no rest param synthesized (was "Duplicate local"). Regression tests in `test/test262-regressions.js`.

### Core infrastructure

* [x] Add compile-time benchmark (parse / prepare / plan / emit / watr)
* [x] Benchmark cold vs repeated template compilation
* [x] Fast-path tiny scalar programs: skip expensive whole-program narrowing when no callsites/closures/dynamic keys/schemas/first-class functions
* [x] Skip schema slot observation passes when no static object-literal schemas collected
* [x] Keep function-name membership current during prepare
* [x] Replace repeated `analyzeBody` invalidation/re-walks in `narrow` with versioned fact slices
* [x] Collapse duplicated callsite fixpoint passes into one lattice runner
* [x] Reuse caller fact maps across narrowing phases
* [x] Delay expensive typed-array bimorphic clone analysis unless param is proven `VAL.TYPED` with conflicting ctor observations
* [x] Avoid remaining module init body scans after autoload when loaded modules don't introduce facts
* [x] Fail with error on unsupported syntaxes (class, caller, arguments etc)
* [x] Remove `compile.js` as re-export hub
* [x] Split pre-emit planning into `plan.js`, signature specialization into `narrow.js`, autoload policy into `autoload.js`, static key folding into `key.js`
* [x] Keep `plan.js` separate from `analyze.js`
* [x] Make `narrow.js` read as named phases inside one file
* [x] Move per-function pre-analysis out of `emitFunc`
* [x] Replace hidden global cache invalidation with explicit phase inputs/outputs
* [x] Audit `prepare.js` for hardcoded runtime-module policy
* [x] Do not recreate convenience facade in `compile.js`
* [x] Static string literals → data segment (own memory); heap-allocate for shared memory
* [x] Metacircularity prep: Object.create isolated to `derive()` in ctx.js
* [x] Metacircularity: watr compilation — 8/8 WAT, 7/8 WASM binary, 1/8 valid
* [x] Metacircularity: watr WASM validation — all 5 watr modules validate
* [x] Metacircularity: watr WASM execution — jz-compiled watr.wasm compiles all 21 examples
* [x] console.log/warn/error
* [x] Date.now, performance.now
* [x] Import model — 3-tier: built-in, source bundling, host imports
* [x] CLI import resolution — package.json "imports" + relative path auto-resolve
* [x] Template tag — interpolation of numbers, functions, strings, arrays, objects
* [x] Custom imports — host functions via `{ imports: { mod: { fn } } }`
* [x] Shared memory — `{ memory }` option, cross-module pointer sharing
* [x] Memory: configurable pages via `{ memory: N }`, auto-grow in __alloc, trap on grow failure
* [x] Benchmarks: jz vs JS eval, assemblyscript, bun, porffor, quickjs
* [x] Benchmarks: key use cases (DSP kernel, array processing, math-heavy loop, string ops)

### Size — closing the AS gap

* [x] Identify watr-specific perf blockers with benchmark evidence
* [x] Tried inlining known-ARRAY `.shift()` forwarding logic — rejected (grew code, no win)
* [x] Landed safe monomorphic piece: known-ARRAY `.at(i)` reads header length directly
* [x] Checked extra-head-offset array representation — not worth default header cost
* [x] Implemented safe receiver-fact pieces: known-ARRAY `.map`/`.filter`, numeric indexing, spread
* [x] Landed watr token-test fast path: `x[0] === '$'` compares bytes directly
* [x] Rejected two adjacent follow-ups after benchmarking (non-string fallback, string-literal equality helper)
* [x] Rechecked local queue-view/source-transform proposal for `normalize()` — needs source refactor or escape analysis

### Completed perf / cleanup wins

* [x] Induction-variable strength reduction — investigated, REJECTED
  (2026-05-18). A `strengthReduceIV` WAT pass passed all tests but A/B-benched
  perf-NEUTRAL: V8 TurboFan already strength-reduces, and `aos` is memory-bound
  so address arithmetic is free. The real `aos` residual is 6-vs-3 redundant
  `f64.load`s — memory scalar-replacement (Generality Step 4), not IVSR. Reverted.
* [x] F.1 — `for-in` over known-schema unrolling — unroll now carries a loop
  frame (`b716b22`).
* [x] Trampoline arity bug — uniform closure-table width (`ctx.closure.width`) was sized by max call-site/arrow-def arity, but boundary trampolines for first-class function *values* forward `$__a0..$__a{arity-1}` (lifted func defs slip past the arity scan, which walks bodies not param lists). An arity-3 function used only via a 1-arg indirect call emitted `(local.get $__a2)` against a 2-param trampoline → `Unknown local $__a2` at assemble time. Fix in `resolveClosureWidth`: also `max` over `programFacts.valueUsed` funcs' `sig.params.length`. + test pin in `test/closures.js`.
* [x] Lazy `__length` dispatch
* [x] Specialize `console.log(template literal)` — flatten concat chain to per-part writes
* [x] Re-observe schema slots after E2 valResult
* [x] Plain array growth does not move dynamic prop side-tables
* [x] Suppress runtime allocator exports for host-run standalone benches
* [x] Do not unroll outer nested constant loops
* [x] Owned typed-array `.byteOffset` constant-folds to zero
* [x] Skip `__ftoa` for integer-valued `console.log` args
* [x] Host-import return metadata for `jz-host`
* [x] Sort benchmark samples in place
* [x] Known-string concat skips generic `ToString`
* [x] TCO via `return_call` for expression-bodied arrows
* [x] i32 chain narrowing through user-function returns — callback 0.060ms → 0.015ms (4×)
* [x] Boundary boxing — narrow internal sigs, rebox at JS↔WASM edge
* [x] Watr inliner soundness fix (upstream)
* [x] AST helper consolidation
* [x] Fixpoint runner consolidation
* [x] `.charCodeAt(i)` returns i32 directly — tokenizer 0.14 → 0.07ms (2×)
* [x] Inline `arr[i]` fast path with known elem schema — aos 3.94 → 3.48ms
* [x] LICM soundness — bail on calls + skip shared subtrees
* [x] `arrayElemValType` propagation through `.map` — callback 5.09 → 3.46ms
* [x] Math.imul / Math.clz32 return i32 directly — bitwise 30.96 → 6.09ms (5×)
* [x] Cross-function arrayElemSchema propagation (aos) — 9.79 → 4.02ms (2.4×)
* [x] Per-iter base CSE — hoistAddrBase pass
* [x] Skip `__is_str_key` on VAL.ARRAY when key is known-NUMBER
* [x] Bimorphic typed-array param VAL.TYPED propagation (poly) — 6.65 → 5.52ms
* [x] arrayElemValType propagation through .map → callback param (callback)
* [x] LICM pass for boxed-cell loads — sound version
* [x] Bimorphic typed-array param specialization — function cloning (poly) — 5.06 → 1.13ms (4.4×), ties AS
* [x] Post-link DCE / dead-import & dead-function pruning in assemble
* [x] Callback/combinator 6-way fusion in optimizer
* [x] watr regression — `v128.const i64x2` lowering fix (`6186dcd`)

### Dynamic-property machinery in jz-compiled watr

* [x] `__set_len` calls inlined to direct header `i32.store`
* [x] `__typed_idx` ARRAY fast path (skip type re-dispatch on known-ARRAY receivers)
* [x] Generic hash-probe loop tightening — additive slot walk, drop per-iter `i32.mul` (`c1ce0a0`)
* [x] Additive probe walk in `__dyn_get_t_h` props loop (`a8b7976`, +12 B)
* [x] Prehash constant `.prop` / `?.prop` keys — `__dyn_get_t` is a thin wrapper over `__dyn_get_t_h(obj,key,type,h)`; new `__dyn_get_expr_t_h`; sites pass compile-time `strHashLiteral(prop)` → no `__str_hash` per access (`1790cb7`, +0.27% wasm, checksum stable). Also fixed latent `needsSchemaTbl` gap (now keys on `__dyn_get_t_h` / `__dyn_get_expr_t_h`).
* [x] Rejected: N-way global dyn-get cache — 1-way already hits the dominant "same object, many keys" pattern (`INSTR[op]`); 4-way = ~9 globals + ~250 B for unmeasurable gain
* [x] Rejected: static-segment off-16 props slot for object/array literals — watr's hot dyn-prop receivers (`ctx`, AST nodes) are heap arrays that already use off-16 header slots; relaxing the `off >= __heap_start` guard is high-risk for no return

### JSON optimizations

* [x] VAL.HASH valType + JSON.parse annotation
* [x] Nested HASH/array shape propagation
* [x] Static `JSON.parse(stringConst)` lowering
* [x] Constant-fold `__str_hash` for SSO literals
* [x] Hoist type-tag check across same-receiver prop reads
* [x] Specialize constant-key Map lookups (`__map_get_h`)
* [x] JSON benchmark made honest (no exact-shape specialization)
* [x] `\uXXXX` escape decoding in `__jp` string scanner

### Type system / codegen architecture

* [x] Unified Type record (`ValueRep`) — collapsed ptrKind/ptrAux/globals/val/schemaId into `repByLocal`/`repByGlobal`
* [x] `intCertain` forward-prop lattice + codegen rules (`toNumF64` skip, `Math.floor/ceil/trunc/round` elide)
* [x] Per-emitter short-circuit migration for `__to_num`, unary `+`, `isNaN`/`isFinite`, `Number()`, `Math.*`
* [x] Parallel-map dedup, dead helpers removed (-697 lines compile.js, +568 analyze.js)
* [x] Unboxed-by-default ABI inversion — closed as architecture backlog
* [x] Per-stage base hoisting + `offset=` fusion
* [x] General `offset=` immediate fusion
* [x] Constant-arg propagation (without unroll)
* [x] Rejected: intConst-driven i32 loop narrowing for biquad — V8 inliner regression
* [x] Small-trip-count loop unroll on top of intConst
* [x] Tail call optimization
