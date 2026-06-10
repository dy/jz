# Quality roadmap — 2026-06-10 deep analysis

From a 4-track analysis (pipeline / speed / size / code aesthetics) against the goals:
output faster than V8 (≈C), size ≈ handwritten WAT, compiler minimal/uniform/declarative,
pipeline direct/optimal. Ordering rationale: **output quality first** (it's the product
promise, fully regression-guarded, and several items are provability fixes — not
architecture), **then targeted core declarativization** (only where it unlocks the next
optimization work), **then pipeline throughput** (user-facing via template-tag/REPL
startup), **then stated-criteria gaps**. Full-core refactor before perf work was
considered and rejected: the perf items touch optimize/plan/abi, not the monoliths.

## 0. Aspects missing from the stated criteria (adopt as standing gates)

- **Correctness/JS-fidelity** — aspect #0; every speed/size trade is judged against it
  (it's why the NaN-pass selects, Infinity|0 guards, forwarding loops exist).
  Already enforced (test262, fuzz, differential, determinism) — state it.
- **Performance predictability (no cliffs)** — user must be able to know when they fell
  off the fast path. `strict:true` + warnings are seeds. See item 1.1 (the worst cliff).
- **Compile throughput** — user-facing (template tag, future REPL). See §4.
- **Diagnostics & debuggability** — compile errors → source positions; name section
  exists, source maps don't.
- **Determinism** — already tested; state it as a gate.

## 1. Speed — "exceptional in ALL cases" (the two losing cases are both strings)

- [x] **1.1 narrowLoopBound** (landed 1495ea0): f64 export-param loop bound blocked the
  lane-vectorizer on the naive `(ptr, n) => for(i<n)` shape — the #1 cliff. Naive 65k-sum
  went 27.7ms → 5.8ms (V8: 10.4ms); ratchet locked (int 699 / float 600 / mixed 830).
  Floatbeats now 0.21–0.93× V8, corpus geomean 0.51× — closes the jukebox "slower
  than V8" todo. CI pins (ddebfe6): floatbeat geomean ≤ 0.85×, off-CI per-beat
  backstop 1.2×, v128-structure test in test/optimizer.js, ratchet re-baselined.
- [ ] **1.2 String substrate** [L, multi-week] — the ONLY structurally losing cases:
  tokenizer (AS 1.3× faster), watr (V8 1.07–1.10× faster). Propagate the `jsstring`
  externref carrier through internal STRING locals via fixpoint; or flat charCodeAt
  fast-path on SSO/heap strings (AS-style direct load). Re-measure tokenizer + watr
  after each step. This is THE remaining "exceptional in all cases" blocker.
- [ ] **1.3 Closure-capture narrowing** [M, watr-profile risk] — captures always box to
  NaN-boxed f64 cells; `let c = n|0; () => c++` round-trips i32↔f64 per access.
  Gate: only when capture is provably single-narrow-type AND not object/string
  (the watr regression risk). Helps watr (closure-heavy) and callback case.
- [ ] **1.4 Int-accumulator narrower path** [L] — `(i32±i32)|0` peephole landed but
  arithmetic off the exact pattern (div, mixed coercions) still routes through f64.
  Wait for a workload (owner's YAGNI call stands) unless watr profile shows it.
- [ ] **1.5 Deferred-on-no-workload** (owner's calls stand, triggers listed):
  extending-add i8/i16 SIMD (trigger: color-space dogfood), AoS→SoA [L],
  scalarization cap 32→64 (LEB128 cliff), call_indirect devirtualization
  (trigger: callback-heavy real workload).

## 2. Size — gap vs hand-WAT is 5 enumerable structures (target ≈1.5×, not parity)

- [x] **2.1 guardRefine** (landed d3a564b) — NaN-box tag reads fold under dominating
  tag guards (eq-facts fold whole reads, ne-facts fold compares; aliases tracked
  through reinterpret/copy locals; block-exit + loop-entry kills). Typed-array probe
  876→711 B (−19%), golden 'typed-array loop' 1062→873 (−18%). Annotated bench
  kernels: 0 delta (they never emit the dispatch). Note: slack geomean stayed 0.896×
  — the bench corpus doesn't contain the shape; the win is on unannotated user code.
- [x] **2.2 hoistGlobalPtrOffset** (landed dc93d18) — typed MODULE GLOBALS resolve
  __ptr_offset once per function via transitive reachable-writes call graph
  (collectReachableGlobalWrites — the precise complement to volatile-globals).
  This was THE cliff behind all four slow examples: rfft 0.13→1.19×,
  reaction-diffusion 0.19→1.25×, game-of-life 0.41→1.78×, attractors 1.19→1.29×;
  examples geomean 1.03→1.55×, 11/11 beat V8. Pinned: examples/bench.mjs is now a
  CI gate in test/bench.js (geomean > 1, winners ≥ 0.9×); demo .wasm rebuilt.
  Follow-up candidates: reuse reachableWrites to sharpen promoteGlobals' coarse
  `hasCall && volatile` gate; STRING globals (also non-forwarding).
- [x] **2.2b loop placement beats site count** (cca52f8) — a single in-loop resolve
  site is per-iteration (lenia kdx/kdy/kw: 1 site × 14M taps). lenia 0.87→1.78×,
  diffusion →1.65×, rfft →1.85×. lenia un-flagged, gated.
- [x] **2.2c leaf-into-export inlining** (f7ccefc) — tiny-leaf cap 30→80 when every
  site is in a caller's loop + loop-free leaves now splice into EXPORTED callers
  (game-of-life rot: Node 22 0.80→1.50×, Node 25 →1.79×). Node 22 matters: its
  pre-Turboshaft wasm tier never inlines calls — out-of-line leaves in hot loops
  are a hard per-iteration tax there.
- **Gate state (2026-06-10)**: examples corpus geomean 1.72× (Node 25) / 1.70×
  (Node 22), 10/11 winners both. Floatbeat local backstop 1.05 (≈ parity floor),
  CI backstop 2.0 = documented ratchet target. Remaining sub-1.0 anywhere:
  interference 1.00× (parity — next optimization target to raise examples FLOOR
  0.9→1.0), mandelbrot-SIMD 0.83× on arm64+Node22 only (x64 CI ≥1.0; old-V8
  arm64 v128 lowering, not a jz codegen artifact). The structural "faster-than-JS
  always, anywhere" items remain 1.2 (string substrate) and 1.3 (closure captures).
- [x] **2.3 f64-ABI wrapper inlining** — RESOLVED, already handled: probed 2026-06-10,
  `(a+b)|0` export emits one direct converting function (62 B, no wrapper); an
  internally-called i32 export gets its body inlined into `$f$exp` by inlineOnce.
  The standalone-wrapper claim was stale.
- [x] **2.4 Heap preamble audit** — RESOLVED, already correct: pure-numeric modules
  carry no memory/data section (`add` = 41 B exact minimum); typed-only modules
  carry no string pool (the "57 B pool always" claim was stale); memory+heap
  global appear only with actual heap use.
- [ ] Note: `optimize:'size'` vs `optimize:2` is already a 2.1× size difference —
  document the preset choice in README size table (perception, zero code).

## 3. Minimality / declarativization (each unlocks or de-risks work above)

- [x] **3.1 valTypeOf → table dispatch** (landed bb6e4f9) — the 190-line if-chain is now
  a VT dispatch table; set families enroll at module init from kind-traits.
- [x] **3.2 emitMethodCall strategies 5-12 extraction** (landed 56d3258) — eight named
  functions over one dispatch-context record { obj, method, parsed, vt, callMethod },
  TYPED_STRATEGIES table mirrors LEADING_STRATEGIES; emitMethodCall is now a ~30-line
  orchestrator. Unblocks the 1.2 string-dispatch work.
- [ ] **3.3 analyzeBody decomposition** [M] — 480 lines, 4 nested passes over shared
  maps in one try/finally. Stage it: processDecl / walk / widen-fixpoint /
  narrowUint32 as separate functions passing explicit fact records. Pre-req for the
  pipeline caching work (4.1) — can't fix invalidation while it's a monolith.
- [ ] **3.4 emitClosureBody (623 lines)** [L] — shares ~70% shape with emitFunc but
  diverges into inline WAT-string template synthesis (a string mini-compiler inside
  the emitter — level inversion). Unify with emitFunc's structured-IR path; the
  trampoline synthesis becomes a small named builder.
- [x] **3.5 TYPEOF code enum** (landed 8bce811) — one null-proto TYPEOF table in ast.js,
  shared by prepare/emitTypeofCmp/flow-types; also fixed the `typeof x == "constructor"`
  prototype-leak footgun in the old plain-literal lookup.
- [ ] **3.6 emit.js (3501 lines) split** [S, mechanical] — emit-decl/emit-assign/
  emit-spread modules; the `// === ===` banners already mark the seams.
- [ ] **3.7 Hygiene tail** (owner's list): shadowed objectLiteralEntries jzify/classes.js,
  vestigial opts.extMap write interop.js, cli.js deprecated profileNames, document
  opts nativeTimers/noTailCall/modules.

## 4. Pipeline throughput & boundaries (matters for REPL/template-tag latency)

- [ ] **4.1 Unified per-function analysis cache** [M] — analyzeBody runs 5-10× per body
  across narrow/plan/emit with fragile manual invalidation. Build facts once post-plan,
  pass explicitly. Depends on 3.3.
- [ ] **4.2 Incremental program-facts** [M] — plan re-runs collectProgramFacts up to 12×
  (full whole-program walk after every mutating pass). Re-sweep only mutated bodies.
  First: add per-pass timings under profile (the 12 sub-passes are invisible — one
  `plan` bucket) so this is measured, not guessed.
- [x] **4.3 Structural globals** (landed 3ea8056) — declGlobal records replace the
  WAT-text strings; ~45 writers one-lined, 3 regex parse-backs + backfill loop
  deleted, emission builds IR directly, renames are Map re-keys. Net −8 lines,
  byte-identical output (size geomeans exact-match).
- [x] **4.4a Sentinels → ast.js** (landed 4b918f2) — JZ_NULL/JZ_UNDEF moved to ast.js;
  emit no longer imports from prepare.
- [ ] **4.4b Prepare→compile seeding** [S] — prepare still imports compile/infer
  (recordGlobalRep) + program-facts (observeNodeFacts); document or invert as an
  explicit interface.
- [ ] **4.5 Two-optimizer contract** [doc-only] — jz-level vs watr-level overlap is
  convention; the pre/post fusedRewrite re-run exists because watr inlining un-folds.
  Write the boundary contract down in optimize/index.js header.

## 5. Reach items (owner's audit: binding constraint — unchanged, listed for order)

AudioWorklet live REPL (M, highest leverage) → dogfood digital-filter biquad →
unplugin-jz → subtractive subset spec. §1.1 unblocks the jukebox demo claim.

## Verification protocol (every item)

npm test + opt{0,1,3} + wasi matrix, selfhost, fuzz ≥2000, CI=1 test/bench.js,
bench-size geomean, ratchet (re-baseline only on intentional improvement).
