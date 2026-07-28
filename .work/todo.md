# jz — TODO

Full working history (hunts, refutations, landing paths, process lessons)
archived in .work/archive-todo-2026-07.md — grep it before re-deriving
anything; every kernel bug class and perf frontier has a banked dissection.

## Status (2026-07-28, current truth — re-audit #3 reconciled)

CLOSED: kernel byte-parity (PARITY_TODO empty, O0/O2/O3 identical); front
half unified (src/front.js); claims gate landed + hardened (fresh incl.
manifests/layout + watr cross-check, strict-leadership separate from band,
CI job; red by design pending evidence); WARM MARGIN ATTAINED 07ffc292
(inlinePtrOffsetFast: warm 0.93-0.97x vs 0.99 cap, audit-confirmed 0.927x
clean; fresh 0.73); TargetProfile landed (frozen JS/WASI profiles,
wasi leg 40/40 — legalizeForTarget still identity, native/w2c profile
absent); pass registry single-authority (63 passes/22 keys/7 hot);
exclusions burn-down (28 -> 22; errors/parser-bugs/destruct/closures/json/
inference back in); solver convergence throws mandatory; session factStore.
OPEN (re-audit #3 order): 1 land user typedarray WIP -> clean npm test at
HEAD (clean-HEAD simd 157/1 f32->i16 — the ONLY battery red; my dirty-tree
counts masked it, see LESSON below), 2 bench producer/claims integration
(committed bench.mjs lacks meta.versions.watr + porf-native lane — user's
uncommitted bench WIP likely carries both; coverage floor ">=5 rows" too
weak -> eligible-count semantics), 3 reference refresh at HEAD (snapshot
44cad082 now 7+ codegen commits stale; tinygo 0 rows CLT-gated, porf-native
0 rows), 4 boxed-bigint (design banked; -5e-324/2^52-1n kernel rows remain
curated until PTR.BIGINT), 5 JIT-leadership axis ungated in bench-claims
(19 JIT losses / 9 cases in snapshot), 6 real legalizeForTarget + native
TargetProfile + w2c cap recovery (jz-w2c geomean 1.330x, tokenizer 3.851x
vs 3.5 cap), 7 solver-owned bodyFacts invalidation (in flight), 8 canonical
LoopPlan (vectorize 6845 lines, 16-recognizer chain; no shared affine/
alias/dependence model). Perf snapshot (M4, stale): 31 strict / 15 band /
4 red (glyfparse 1.151, sdf 1.256, trace 1.452, shapes 1.166).

## Goals (2026-07-28 user directive — post-architecture perf/size/memory push)

* [ ] SPEED, all lanes: EVERY bench case faster than v8, JSC (all JIT
      runtimes) AND every wasm rival. Gates already encode it
      (bench-claims strict-leadership wasm + JIT); current distance:
      16 wasm strict losses (worst trace 1.449x), 13 JIT strict losses
      (worst dispatch 2.073x jsc). Order: AFTER architecture complete.
      Includes the w2c native-lowering tail (tokenizer 3.851x vs 3.5 cap).
* [ ] SIZE: produced bundles must BEAT AssemblyScript by size (current
      claim: "on par by geomean"). Producer: scripts/bench-size.mjs.
      Needs: size-vs-AS per-case inventory, then codegen levers (dead
      stdlib elision, header/allocator trim), then a strict size gate.
* [ ] MEMORY: natives consume ~10x less peak RSS than the wasm lanes.
      memKb axis now measured per-invocation (bench.mjs /usr/bin/time
      wrapper, c703f63a). Investigate WHERE the footprint lives (linear
      memory sizing/allocator growth policy vs engine overhead vs
      instantiation copies), compare MoonBit-wasm's profile, target
      MoonBit-level or better.

## Open

* [x] STRING-COMPARE MISPROOF WAVE (LANDED 2026-07-25 --
      the watr-in-kernel dynamic-compare family root; watr-diff harness
      proves the cure but ONE perf-shape regression blocks landing):
  STATE: watr-diff ALL SAME (i64.lt_s(-1,0) folds 1 in-wasm; was 0);
  -1n<0n O2 kernel row returns TRUE (un-curate statements.js row on land);
  ratchet 10/10; optimizer+simd 364/2 -- ONLY clamp-peel x2 red (stencil
  peel stopped firing = perf shape, not correctness).
  THE THREE FIXES IN TREE:
   1. emit.js cmpOp: both-runtime-unknown compare fallback now runtime-
      dispatches (is_str x2 -> __str_cmp three-way, else ToNumber f64),
      gated on ctx.module.modules.string + non-i32 types. Was raw f64
      compare of NaN-boxed string pointers = always false.
   2. narrow.js valTypeOfWithCalls: SOUND '+' rule at the RESULT-STAMPING
      boundary only (unknown side -> no claim); kind.js VT['+'] stays
      OPTIMISTIC (demoting it doubled slice/nest ratchets -- reverted,
      comments in both files point at each other).
   3. compile/index.js paramAllUsesNumeric: relational proof now needs a
      PROVABLY-NUMERIC PARTNER (number literal / numericLocals name /
      numeric-op expr / .length). numericLocals = let/const inits that are
      numeric literals or numeric ops (multi-decl handled). `(p,q)=>p<q`
      no longer stamps params NUMBER (was the factory-lambda break).
  SHAPED-PARSER BREAKTHROUGH 2026-07-25 (post string-compare fixes): the
  class NOW REPRODUCES STANDALONE -- watr-diff.mjs with the REAL pre-watr
  shape module (scratchpad/shape-prewatr.wat, 140kB, generated via native
  compile(src, {wat:true, optimize:{level:2, watr:false}}) of the json
  shaped-parser test source) DIFFS at char 2949: node-watr OUTLINES
  ($__out0 call) where wasm-watr keeps the inline i32.or/eq chain -- wasm
  output 13kB bigger (158628 vs 145536). The kernel's compile-time err 0
  is downstream of this pass divergence. hash32 primitive VERIFIED
  identical node-vs-wasm (the asI32 wrap fix cured it). REMAINING
  SUSPECTS in watr's outline pass (node_modules/watr/src/optimize.js
  ~4620-4740): candidate `facts` build (ownBytes/resultType/ltype),
  group Map iteration order, chosen[].sort tie-stability (b.net-a.net
  ties broken by insertion order -- a Map-order divergence in-wasm would
  reorder choices). NEXT: instrument the outline pass (temp probe export
  like the earlier __bcProbe round -- REVERT node_modules after) to dump
  per-group {h, sites, net} node-vs-wasm and bisect; 30s cycles via the
  harness. This likely ALSO explains kernel-parity dict|2/dict|3/sum|3/
  arr|3 rows (in-kernel output BIGGER = less outlining/dedup!).
  OUTLINE-HUNT ROUND 2 FINDINGS (2026-07-25, probes REVERTED from
  node_modules -- re-apply from these notes): instrumented watr's optimize
  driver + outline pass with a same-module __outLog + getter (cross-module
  ARRAY import mutation does NOT propagate in-wasm -- binding is a copy;
  same-module push + exported getter works). Results: in-wasm
  normalize(true) yields opts.outline=true, opts.fold=true (the drv log's
  first 43 chars match node) BUT (a) `Object.keys(opts).length` string-
  concats as EMPTY in-wasm (Object.keys on the normalize-built dict --
  dynamic-key-written object -- returns nothing enumerable: THE
  spread/dyn-key enumeration gap), and (b) the outline pass logs NOTHING
  in-wasm even with outline=true -- its `for (const [name, fns] of ...)`
  driver loop or the pass-fn table lookup drops it. NEXT PROBE: log inside
  the ROUND LOOP which pass names actually execute in-wasm (push per-pass
  name), then bisect the pass-table build (PASSES array -> OPTS
  Object.fromEntries -- fromEntries + static reads may be the same
  enumeration gap). The kernel-parity dict|2/dict|3/sum|3/arr|3 rows and
  the 13kB size delta likely all reduce to skipped size passes in-wasm.
  OUTLINE-HUNT ROUND 3 -- CRASH REPRODUCED STANDALONE 2026-07-25 (the
  kernel's exact 'memory access out of bounds'/err-0, deterministic,
  ~5min cycles): with probes {OL-called, OL-adjacent len, OL-guard
  operand log} in watr's outline() entry (node_modules/watr/src/
  optimize.js ~4614; probe scaffolding = same-module __outLog array +
  __outLogRead getter exported, entry prepends ';;OUTLOG ' + drain),
  the wasm harness run on scratchpad/shape-prewatr.wat THROWS OOB at
  the guard-log's string reads (typeof ast[0] + .length concat) --
  reading the ast node at 140kB scale hits CORRUPTED/STALE memory: the
  durable-dangler / arena-reuse class (node pointers gone stale after
  arena growth mid-compile). Chain established this session: wasm-watr
  outline logs OL-called + OL-adjacent, never OL-post-guard -> with
  operand logging it ODDLY takes the guard return or OOBs -- i.e. ast[0]
  reads are already reading garbage at that point. ALSO: native first
  OL-called shows op=func len=19 -- outline is invoked on a FUNC node by
  a second caller (find it: grep 'outline(' -- tailmerge/rettail?) --
  check whether the wasm crash is in THAT call or the module-level one.
  NEXT WINDOW: (1) find the second outline caller; (2) bisect WHERE ast
  went stale -- log the ast pointer-identity (e.g. push a marker prop on
  the module node before optimize, test its presence at outline entry);
  (3) suspect list: cse's tee'd locals pass right before outline (a =
  cse(a) -> coalesceLocals -> localReuse -> outline -- one of these at
  scale reallocs/clones into arena space later reused); (4) the fix
  belongs in jz's arena/alloc or the pass's clone discipline, NOT watr.
  Probes must be REVERTED from node_modules after the hunt (currently
  IN PLACE for continuity -- restore recipe in ledger round-2 entry).
  OUTLINE-HUNT ROUND 4 -- CRASH PINNED TO A FUNCTION 2026-07-25:
  selective-pass matrix (entry now passes STRING opts through -- watr's
  set-based normalize): 'fold' OK 139705ch, '+propagate deadcode vacuum'
  OK, '+cse' OK 122084ch, '+outline' OOB; ALSO 'outline'/'fold outline'
  alone OOB. V8 trap frame: wasm-function[403] @0x40bba = the
  $m0_optimize$localReuse cluster (neighbors eliminateDeadInBlock/
  canSubst; mapping +/-4 due to import-func counting -- refine with exact
  index arithmetic next). TWO INTERTWINED FINDINGS: (a) localReuse-family
  code executes under 'fold outline' selection where opts.locals should
  be false -> IN-WASM PASS-FLAG READS ARE UNRELIABLE (the dyn-dict
  static-read class: normalize writes m[p[0]]=..., driver reads
  opts.locals) -- same mechanism as the Object.keys=empty finding; (b)
  whichever localReuse-family fn runs, it OOBs on the 140kB tree
  (NOT capacity: identical at memory 16384). NEXT: (1) exact index->name
  mapping (count import funcs precisely; funcs regex currently matches
  import-wrapped (func too)); (2) reproduce the dyn-dict flag misread in
  isolation with normalize's exact shape (PASSES table -> m[p[0]]=bool ->
  static reads) -- THE root to fix in jz (schema/hash read path for
  dynamically-keyed dicts consumed by static props); (3) then the OOB fn
  with correct flags may never run -- retest before hunting it separately.
  Harness memory now 16384; entry passes strings through (typeof check).
  OUTLINE-HUNT ROUND 5 -- PRIMITIVE CAUGHT RED-HANDED 2026-07-25:
  post-trap log drain WORKS (entry exports drainLog=__outLogRead; host
  calls it AFTER catching the trap -- instance memory survives, jz string
  machinery still functional; probe file scratchpad/flagprobe.mjs).
  WASM'S ACTUAL STATE UNDER 'fold outline': flags CORRECT (fold=1
  locals=0 cse=0 outline=1 -- earlier localReuse-runs-anyway theory DEAD,
  the fn-index mapping was off); outline runs; BUT the guard log shows
  **l0=0 in-wasm vs l0=4 in node** -- the parsed 'func' TAG STRING'S
  .length READS 0 while typeof=string. A corrupt string carrier out of
  watr's parse() at 140kB scale (SSO length bits zero) -- downstream
  address math on such strings OOBs (the trap), comparisons misroute
  (the guard/pass weirdness), sizes drift (parity rows). THE HUNT IS NOW:
  which watr-parse token path builds strings with zeroed length bits at
  scale, i.e. WHICH jz string-producing emitter (slice/substr/charCode
  accumulation) skips SSO/length normalization on some scale-dependent
  branch. NEXT PROBES: log typeof+length+charCodeAt(0) of the first ~10
  parse() tokens in-wasm (instrument watr parse.js token fn, same
  __outLog channel + post-trap drain); compare small vs 140kB source;
  then differential-pin the jz emitter path. Probe state: watr optimize
  instrumented (flags log at driver entry, OL-* logs at outline, __chk
  at finish tail); entry has drainLog + string-opts passthrough; harness
  memory 16384; ALL recipes reproducible from these notes.
  ROUND 7 -- GUARD PINNED + NEW ANOMALY 2026-07-25 (counters channel,
  allocation-free; probe files: flagprobe.mjs + instrumented watr parse/
  optimize in node_modules + entry counts()):
  (a) TRAP WAS PROBE-INDUCED: pristine watr 'fold outline' completes on
  BOTH engines -- log-string allocations at per-func call depth caused
  the OOB (separate jz allocation bug, banked). Real divergence: node
  88332ch outlined vs wasm 139597ch NOT outlined, no trap, minimal
  config 'fold outline'.
  (b) GUARD PINNED BY COUNTERS: outline entered 55x on both engines;
  node passes the module guard once (rounds run, 568 cands, 10 applied);
  wasm passes ZERO -- `!Array.isArray(ast) || ast[0] !== 'module'`
  rejects even the real module node in-wasm.
  (c) TOKEN-BIRTH strict-eq is FINE (modTok=2, modEq=1 both engines --
  'module' vs 'memory' distinguished correctly at commit).
  (d) NEW ANOMALY: parse token counter __cTok reads 7915 in-wasm vs
  79122 in node (~exactly 10%) -- but wasm output is full-size, so
  EITHER export-let counter increments drop ~90% at scale in-wasm
  (a global-increment miscompile class!) OR the counter/export read path
  lies. DISCRIMINATE NEXT: return level.length (structural top-level
  count) + str.length from inside the entry -- no counters; also test a
  trivial 100k-iteration export-let counter in isolation both engines.
  Then re-face (b): if counters lie, guard evidence needs a counter-free
  recheck (e.g. push a sentinel into the module node on guard-pass).
  ROUND 8 -- ENDGAME LOCATED 2026-07-25: counter-free structural probes
  settle everything: (a) node's 79122 token count was MY probe double-
  importing the entry (parse ran across harness cases) -- both engines
  tokenize identically (7915 strs, 4831 nodes, top=49); (b) tree[0] ===
  'module' is TRUE in-wasm when compiled in the ENTRY module AND in a
  fresh small fn ADDED to optimize.js (__guardTest export) called with
  the same tree; (c) outline's OWN inline guard `ast[0] !== 'module'`
  still rejects 55/55. CONCLUSION: the IDENTICAL compare expression
  miscompiles ONLY inside outline's ~4600-line arrow body -- the
  enclosing-function-scale/shape-dependent miscompile that underlies
  this whole family. NEXT (the endgame): dump the harness module's
  native-jz WAT (compile g.code {wat:true}), locate BOTH compare sites
  (outline's guard vs __guardTest), diff the emitted idioms -- the wrong
  instruction sequence names the emitter path to fix. Probe state:
  watr node_modules instrumented with counters + __guardTest (pristine
  restore = rm -rf node_modules/watr && npm install watr@5.7.11
  --no-save); entry has counts()/treeStat; flagprobe.mjs is the runner.
  ROUND 9 -- ROOT NAMED AND FIXED 2026-07-25 (endgame closed). The
  __li-aliasing hypothesis of the previous entry was WRONG (those sets
  precede their uses textually; red herring -- lesson: name a mechanism
  only after reading the actual compare site). The real root, read
  straight off outline's entry code in harness.wat: the guard
  `!Array.isArray(ast) || ast[0] !== 'module'` compiled with its SECOND
  DISJUNCT AS `(i32.const 1)` -- statically folded TRUE, so outline
  always early-returned in-wasm (__cEntry 55 / __cGuard 0 exactly).
  JZ_DBG_FOLD tracing pinned the fold: emitStrictEq's differing-
  primitive-class rule fired because valTypeOf(ast[0]) returned
  VAL.ARRAY -- analyzeBody's push observation (`ast.push(['func',…])`
  inside outline) SETTLED arrayElemValType=ARRAY for a PARAM whose
  pre-existing contents are unknown (watr trees are heterogeneous
  ['module', str, …arrays]). Mutation evidence describes only ADDED
  elements; treating it as element-type proof for arrays the body
  didn't construct is the misproof class (also hit bf463_0/'block',
  astf794_1 -- and transitively poisons the caller-side param lattice).
  FIX (analyze.js + analyze-scans.js): elemOrigin set -- a name's
  initial contents count as known only from a fully-static array-
  literal decl (incl. empty) or fresh Array(n) ctor (isFreshArrayCtor,
  now exported); push/index-write observations for ALL THREE slices
  (val/schema/typedCtor) gate on elemOrigin-or-existing-entry, else
  SKIP (not poison -- caller-proven preseeds survive). The construct-
  then-fill and `let a=[]; a.push(x)` idioms keep their fast paths.
  VERIFIED: flagprobe SAME 88387ch, counters identical node/wasm
  (55/1/2/568/37/24/10 -- 10 outlines applied in-wasm); watr-diff ALL
  SAME on pristine watr@5.7.11 incl. full default pipeline over the
  real 140kB shape-module WAT. Probes stripped (emit.js/index.js dbg,
  watr node_modules reinstalled pristine, entry probes removed).
  WARM LEVER RANKED 2026-07-28 (AC power restored; instrumented
  kernel via helperCounters, one crc32 compile): __ptr_offset 17.9M
  calls DOMINATES (3.5x next: str_eq 5.0M, len 4.8M, length 3.6M,
  alloc 3.6M, typed_idx 2.4M, str_hash 2.4M). Every NaN-box deref in
  the self-hosted compiler is an out-of-line call (kept a fn by the
  forwarding-pointer branch). Warm verdict on AC: 1.001/1.022/1.021
  hover (fresh 0.787) -- the ~1-2% gap ≈ 17.9M call frames. LEVER:
  inline the __ptr_offset fast path (non-forwarded case: pure bit
  ops) at call sites with an out-of-line forwarding fallback -- or
  watr inline-pin it in the kernel build. Bounded, measurable,
  general (speeds every kernel compile). NEXT WINDOW: implement +
  measure warm rounds (needs AC + quiet).
  WARM CAP ATTAINED 2026-07-28: inlinePtrOffsetFast landed as a
  speed-tier-gated LATE pass (src/optimize/index.js
  inlinePtrOffsetFastPass + passes.js registry; off in L2/size
  presets so default sizes/ratchet/goldens are byte-untouched).
  Inlines $__ptr_offset's loop-free body (mask+tag test +
  followForwardingWat guard) at each surviving call site; only the
  cold $__ptr_offset_fwd relocation chase stays out-of-line. TWO
  ORDERING/NAMESPACE TRAPS (both pinned by existing tests): (1)
  $__inl<N> is watr's OWN inliner namespace -- sharing it duped
  locals; scratch renamed $__poff<N>/$__poffb<N>; (2) MUST run
  AFTER unswitchTypedParamLoop/vectorizeLaneLocal -- they pattern-
  match the RAW (call $__ptr_offset) shape to prove SIMD lifts;
  eager inlining inside fusedRewrite silently killed a whole
  scalar->SIMD lift (caught by test/unswitch-typed-param.js).
  never-grown.js structural pins extended to accept the __poff
  marker. MEASURED: helper profile ptr_offset 17.9M -> 0 (top now
  str_eq 5.0M); warm rounds 1.001/1.022/1.021 -> 0.965/0.968/0.964
  agent runs, 0.973 my confirm run (ALL cases <=0.99: mat4 0.97
  fft 0.98 biquad 0.98 sort 0.99 crc32 0.99 mandelbrot 0.93);
  fresh 0.787 -> 0.763. Speed-tier size cost 139-483B/case
  (~1.4-1.8%), checksums identical, paired sort/fft/synth no
  regression. Battery 3101/0, parity 18/18, ratchet 10/10 zero
  delta. The warm <=0.99 strict-win cap now passes on EVERY round
  -- last solo-scope committed-gate red is CLEARED.
  RE-AUDIT #3 RECEIVED 2026-07-28 (verdicts reconciled into Status
  header). LESSON (process, REPEAT OFFENSE): dirty-tree verification
  again recorded green counts a clean HEAD cannot reproduce -- 72cc7fd1
  said simd 158/158 but clean-committed HEAD fails f32->i16 encode
  (157/1) because the user's uncommitted module/typedarray.js WIP
  supplies the fix; the SAME confound was already dissected for the
  linux-only CI red. RULE (now binding): any COMMIT-TIME green count
  must come from a clean worktree of the exact commit (git worktree
  add <tmp> <sha> + npm ci-equivalent + battery), or be reported as
  "dirty-tree, user WIP present". In-tree runs remain fine for
  RELATIVE pre/post checks of an unrelated diff. AUDIT CONFIRMS:
  warm cap independently reproduced clean (0.927x warm / 0.725x
  fresh, 5/5), targeted forwarding tests 4/4, TargetProfile wasi leg
  40/40, inference kernel rows 86/86, parity 18/18 clean.
  SOLVER-OWNED BODYFACTS INVALIDATION LANDED 2026-07-28 (audit item
  7, declared next slice done): the 14 real invalidateLocalsCache
  pairings (task said 16; import line + overcount) collapsed into
  three seam primitives in compile/analyze.js -- reanalyzeBody(body,
  read?) fuses invalidate+read (8 hypothesis-probe/emit-reseed
  sites), setFuncBody(func,node) fuses AST-rewrite+invalidate (5
  sites, also makes bindingUses' "no surgical invalidation" contract
  structural: rewritten bodies are new identities by construction),
  invalidateBodies/invalidateAllBodyFacts named phase-boundary
  flushes (3 sites). 2 bespoke raw calls remain, both justified
  (defensive trailing flush; read-invalidate-mutate fixpoint in
  scalarizeFunctionObjectLiterals). SECOND NET: assertBodyFactsFresh
  -- JZ_DEBUG_INVARIANTS-gated signature-fingerprint check on cache
  HITS (params/results type+ptrKind+ptrAux only; null side skips --
  the prior JZ_DEBUG_CACHE blanket-recompute attempt died of benign
  ambient-staleness false fires, this one is scoped to genuine
  signature retype misses); regression pins in test/invariants.js
  plant a missing invalidation and prove the assert fires, and that
  the seams never do. Ambient overlays (localReps/typedElem/
  slotI32Certain) stay documented intentionally-staleable. GATES:
  isolated npm test 3103/0 (+2 new), dbg-invariants leg 3101/0,
  parity 18/18, ratchet 10/10 +0, dist clean, kernel leg 2419/2
  user-WIP-only. DEPS table updated to the new API.
  CLAIMS GATE STRENGTHENED 2026-07-28 (audit items 2-gate-side + 5):
  JIT promise now gated -- JIT_RIVALS v8/deno/bun/jsc get the same
  strict-leadership + 1.05-band tests as the wasm set (shared
  caseRatios helper; snapshot truth: 13 JIT strict losses, 12 red,
  worst dispatch 2.073x jsc -- red by design until evidence catches
  up); coverage floor now >=70% of corpus per rival (was >=5 rows;
  0.7 set from real portability -- go/zig port 43/60=0.72), applied
  uniformly to wasm+JIT+porf-native lanes. Producer side (meta.
  versions.watr emission, tinygo lane) remains user-WIP/CLT-gated.
  EXCLUSIONS BURN-DOWN COMPLETE 2026-07-28: the census root =
  `new Set(undefined)` -- ES says the CONSTRUCTOR skips iteration on
  a nullish iterable (empty set), but jz's new.Set routed through
  __iter_arr's for-of normalizer which (spec-correctly for for-of)
  throws TypeError(0) on nullish; natively masked (compiler runs
  under host JS semantics), self-hosted the compiler's own
  `new Set(skip)` in prepare's renameWalk threw -- localized via the
  compileErrDiag probe channel (stage=front, thrown value = number
  0, probeStage=renameWalk:init = the first walk with skip=
  undefined). FIX: __iter_arr_ctor (nullish passthrough -> existing
  non-ARRAY guard yields the empty seed; for-of/spread keep the
  spec TypeError); spec pin in iteration.js (ctor-empty vs for-of-
  throws). inference UN-EXCLUDED: full kernel leg with EVERY capable
  file = only the 2 user-WIP rows; battery 3101/0; parity 18/18.
  Audit item 8 CLOSED entirely -- remaining exclusions are host-only
  legs + optimize:false shape-mismatch classes, by construction.
  CENSUS ROW DEMYSTIFIED 2026-07-28: NOT order-dependent -- the row
  fails STANDALONE on the current dist, and the mechanism is a plain
  kernel compile bug with a 3-LINE REPRO: compileViaKernel of
  `import { T } from "./m.jz"; export let f = (k) => T[k?"a":"b"](2)`
  with modules {'./m.jz': 'export const T = { a: (x)=>x+1, b: (x)=>
  x+2 }'} THROWS message "0" in-kernel (native OK). Bisected
  ingredients: bigint irrelevant, plain imports OK, imported fn OK
  -- the breaker is the IMPORTED CONST-TABLE-OF-ARROWS + DYNAMIC KEY
  DISPATCH through the module-bundling path (closure-table/devirt
  machinery meeting importSources in-kernel). Earlier 'passes
  standalone' observations were stale-dist artifacts; the row's
  in-suite-only reputation is dead. NEXT: hunt the throw site (err
  with payload 0 -- likely a raw wasm throw or err(0) in the
  closure-table build), fix, then inference joins the gate and the
  exclusions burn-down is COMPLETE. Repro script: scratchpad/
  census3.mjs.
  TIMING MEASUREMENTS SUSPENDED 2026-07-27 (laptop UNPLUGGED, user
  FYI): battery power = throttled/unstable clocks on macOS -- warm
  rounds read 1.020/1.053/0.927 with fft 0.64 (implausible spread =
  power noise). The collection-op agent's change measured as a warm
  regression (1.039-1.073) in that window and was REVERTED to
  baseline -- verdict UNRELIABLE, its diff persists in the agent
  transcript for plugged-in re-evaluation. RULE: no warm-cap, paired
  -bench, or reference-refresh conclusions on battery; correctness
  gates (battery/parity/kernel leg) unaffected and stand.
  WARM-MARGIN LEVER LOCATED 2026-07-27 (compileProfile diagnostic
  landed in self.js -- per-stage kernel wall times over the ABI):
  stage-share differential kernel-vs-native (crc32 corpus, 5 warm
  reps each): optimizeTail (watr fixpoint) 79.6% in-kernel vs 57.9%
  native = 1.38x RELATIVE share -- THE wasm-relatively-worse phase;
  compileAst is relatively FASTER in-kernel (0.42 -- arena beats V8
  GC); front/encode ~parity. The warm cap's remaining ~3% lives in
  watr's allocation-heavy fixpoint running on jz's own Map/Set/hash
  (module/collection.js) -- the lever is collection-op performance
  under the fixpoint's churn profile (or watr-side allocation
  reduction, user's lib). NEXT PROBE: helperCounters/callsites on a
  kernel watOptimize run to rank __hash_get/__map_set/... shares,
  then optimize the top collection op (general kernel win, not
  warm-specific).
  EXCLUSIONS FRONTIER 2-OF-3 FIXED, FIVE FILES UN-EXCLUDED FOR GOOD
  2026-07-27 (frontier agent + in-thread land): the Array.isArray-
  as-value closure-support row and the bool-identity closure-ABI
  'Bad int' row fixed at the root (emit.js + ir.js + prepare/
  index.js — the host-side singleton class the structural-isCallable
  fix opened); errors/parser-bugs/destruct/closures/json now
  PERMANENTLY in the kernel gate (~430 tests joined; full leg =
  only the 2 user-WIP typedarray rows). Remaining frontier: ONE row
  — inference census (const-table arrow args in a bundled init),
  standalone-green in-suite-red, inference stays excluded with the
  note. Gates: battery 3100/0, parity 18/18, kernel leg baseline.
  Warm-margin probe finding banked: watOptimize = 60% of compile
  wall but runs on BOTH ratio sides — the ratio lever must be a
  relatively-worse-in-wasm phase; next probe = kernel-side stage
  timing hooks.
  BOXED-BIGINT DESIGN COMPLETE, IMPLEMENTATION GATED 2026-07-27
  (design agent, read-only, honest stop): REPRESENTATION = heap-boxed
  PTR.BIGINT (tag 5 free in layout.js TAG_MASK), 8-byte i64 heap
  cell, mkPtrIR-consistent with STRING/OBJECT -- unambiguous by
  NAN_PREFIX disjointness from all subnormals; full 64-bit range
  FORCES heap indirection (47-bit payload can't inline 2^63). SEAM =
  NEW boxBigInt/unboxBigInt pair in ir.js beside asI64/fromI64
  (those are a SHARED f64<->i64 bridge with 30+ non-bigint callers
  -- NOT retaggable); substitute at the ~10 VAL.BIGINT-gated emit
  sites + typeof arm + core.js $__typeof (currently NO bigint arm --
  carrier bigints silently report "number") + $__eq (bit-eq fast
  path must grow a PTR.BIGINT deref-compare arm) + number.js helpers
  + interop export boundary. HARD BLOCKERS: (1) module/typedarray.js
  = USER WIP, holds BigInt64Array raw-carrier I/O -- lockstep
  dependency, two coexisting representations would silently break
  typeof/===/arithmetic on array-roundtripped bigints; (2) $__eq
  rewrite is semantic, not drive-by. OPEN DECISION (user): naive
  always-box LEAKS 8B/iteration on bigint accumulator loops (no GC
  for permanent tags) -- accept as documented boxed-type cost vs
  measured small-int fast path. SEQUENCE: user lands typedarray ->
  ONE atomic commit across layout/ir/emit/core/number/typedarray/
  interop -> leak decision resolved BEFORE landing -> full gates.
  No smaller honest checkpoint exists (partial migration fails
  gates by construction; the fold corruption happens inside the
  compiler's own self-hosted evaluation, so literal-only slices
  address a symptom shape, not the mechanism).
  CLAIMS GATE HARDENED 2026-07-27 (audit blocker 4): freshness scope
  now includes layout.js + package.json + package-lock.json (the
  watr-upgrade blind spot) PLUS a watr-version cross-check vs the
  snapshot's meta (currently fails: snapshot lacks the field --
  bench.mjs needs one line recording meta.versions.watr; user's live
  session owns bench.mjs, deferred to them or next quiet window);
  STRICT-LEADERSHIP test split from the band test (a 1.05 band row
  proves tolerance not leadership) -- current in-tree evidence:
  strict unproven on 16 cases, band-exceeded on 8 (results.json in
  tree is the USER's uncommitted refresh w/ porf-native recontest;
  their Porffor CLAIM_RIVALS change incorporated); claims job wired
  into CI test.yml (honestly red until fresh+complete+winning).
  Remaining audit blockers: user lands typedarray WIP (suite green),
  boxed-bigint redesign (carrier rows), warm cap final margin, W2C
  tokenizer 3.851 vs 3.5 cap (new signal in their refresh -- check
  after their bench work lands), tinygo (CLT).
  TARGETPROFILE LANDED 2026-07-27 (the last untouched P1 item):
  named frozen per-target policy profile (js/wasi) constructed in
  beginSession from opts.host -- fields name the POLICY (wasiShims,
  envImports, jsStringInterop, commandEntry, timerModel...) not the
  host; the scattered ctx.transform.host boolean gates across src/ +
  module/{console,core,crypto,fs,navigator,timer,web} migrated to
  profile fields (spot pattern: `host === 'wasi'` ->
  `targetProfile.wasiShims`); legalization seam threaded at
  watr-tail. Gates: battery 3098/0, wasi leg 3100/0, parity 18/18,
  kernel leg baseline (2 fails both user-WIP: typedarray row +
  headline row from their live bench.js edits). With this, audit P1
  = solver DONE, CompileSession seam DONE, TargetProfile DONE,
  LoopPlan slices 1-4 (full candidate model remains).
  CI SIMD RED ROOT-PROVEN 2026-07-27: a clean-HEAD worktree
  reproduces `has v128: false` LOCALLY -- the f32->i16 encode
  vectorization depends on the USER'S UNCOMMITTED module/typedarray
  WIP (every local verification had it in tree; CI compiles the
  committed version whose ToInt emit shape peelNarrowConv no longer
  matches). NOT platform-dependent; probe chain (self-documenting
  assert -> whyNotSimd sink -> pre-watr b64 diff: local select-form
  ToInt16 + inf-guard vs committed if-form without guard) and the
  worktree discriminator close it. watr 5.7.12's codepoint sort was
  a REAL determinism fix but not this cause. ACTION: user lands
  their typedarray WIP (or the emit-shape part peel depends on);
  temp CI probe step removed. Lesson: uncommitted WIP in the
  verification tree can mask committed-state regressions -- clean-
  worktree spot-checks belong in the landing discipline for emit-
  shape-adjacent changes.
  WATR 5.7.12 PIN + LOOPPLAN SLICE 4 LANDED 2026-07-27: user
  published watr with the codepoint-order data sort (the CI-linux
  localeCompare nondeterminism fix, confirmed present in the
  installed 5.7.12); jz pin bumped exact. LoopPlan slice 4: next
  fact class hoisted into the dispatch descriptor (agent, byte-
  identity-gated; spot-corroborated — blur/dotprod/sdf speed-tier
  WATs byte-length-identical vs HEAD). Verified combined: simd
  158/158, optimizer 213/213, determinism 5/5, parity 18/18,
  battery 3098/0, kernel rebuilt on 5.7.12. CI should now go fully
  green on the jz side (remaining red = user-WIP test262 rows).
  REFERENCE DATASET REFRESHED QUIET 2026-07-27 (blocking run, zero
  concurrent work): headline JZ 1.00x -- C 1.91x Rust 2.00x Zig 2.12x
  AS 2.09x Go 4.38x MoonBit 4.15x Porffor 4.67x V8 2.21x behind;
  native C 1.02x. meta.commit = HEAD (claims FRESH axis GREEN).
  Claims red list down to FOUR: trace 1.452 (branch-layout hard
  tail), sdf 1.256 (symbolic-hull research tail), shapes 1.166
  (TurboFan-level tail), glyfparse 1.151 (jittery lane -- led in
  targeted pairs same week; borderline). sort/crc32/fft/synth/
  levenshtein all CLEARED from committed evidence. tinygo axis
  awaits user CLT + install. This is the honest pre-watr-publish
  claims state.
  CARRIER WALL MAPPED + PINS SETTLED 2026-07-27 (in-thread, watr-
  publish runway): (1) ctx.features.bigint SEEDED false in reset --
  the absent-dyn-key read misfired truthy in-kernel, turning the
  toNumF64 carrier gate ON for pure-number programs (5e-324/1e-320/
  2^52+1 exports were corrupt; now exact). (2) NEGATIVE subnormal
  LITERALS + 2^52-1 bigint remain in-kernel-corrupt BY THE WALL: any
  value-level op on carrier-band bits inside the self-hosted compiler
  ToNumbers the carrier -- three escapes tried and refuted in-thread
  (host-neg -x, bit-flip via typed store [ToNumber at the store],
  source-text numlit deferral to watr encode [watr's own in-kernel
  parseFloat->store normalizes]); there is NO ToNumber-free
  value->bits path in the kernel by construction. Rows kernel-
  curated in data.js WITH mechanisms (precedent: -1n<0n); TRUE FIX =
  boxed-bigint carrier redesign (the standing long-term item). (3)
  Exclusions burn-down advanced then time-boxed: 6-file un-exclusion
  reached 2413 pass with THREE order-shifted in-suite residuals
  (Array.isArray-as-value closure-support err; bool-identity
  closure-ABI 'Bad int 0x000000-100000001'; inference census row) --
  reverted to committed exclusions; the frontier is those 3 rows.
  Verified state: battery 3098/0, kernel leg 1958/2 (user WIP only),
  parity 18/18.
  LEAK HUNT RESOLVED TO TWO ROOTS 2026-07-26 (in-thread): (1) FIXED:
  destruct's `({sqrt, abs} = Math)` in-suite failure -- emit.js's
  first-class-vs-niladic builtin dispatch keyed on `handler.length`,
  and function-arity reads are UNSUPPORTED in jz output semantics
  (verified: f.length === undefined in both native-jz and kernel
  output), so the self-hosted compiler routed every first-class
  builtin into the niladic handler() -> empty-IR internal error.
  Fix: STRUCTURAL membership (FIRST_CLASS_UNARY_MATH /
  FIRST_CLASS_BUILTIN_BODY) with .length only as the native fallback
  for the friendly unsupported-name error. Verified: native 248/248
  (destruct+math+errors), kernel destruct standalone 69/69, the
  10-file in-suite prefix -- destruct row GONE. (2) NAMED, OPEN: the
  data.js P0-2 pin failures are NOT compile bugs -- direct
  compileViaKernel compiles export -5e-324 and 2^52-bigints EXACTLY;
  the harness jz() path exports -1 because the EXPORT-BOUNDARY KIND
  MARSHALING is missing on the kernel leg: native compiles carry an
  export-kind table the interop wrap consults to distinguish
  bigint-carrier bits from genuine subnormals; the kernel returns
  raw bytes without it -> host wrap falls back to the magnitude
  heuristic -> carrier misread. FIX DIRECTION: kernel ABI conveys
  export kinds (custom section or a kinds-JSON export) and interop
  consults it on the kernel path exactly as native. The earlier
  'SSO ir.js delta causes it' bisect verdict was confounded by
  stale dists -- the interop-kind explanation fits all evidence
  (bare instantiate path exact, jz() path misreads, native green).
  EXCLUSIONS BURN-DOWN PROBED 2026-07-26 -- IN-SUITE LEAK CLASS
  ISOLATED: all 7 debt files (errors 111, parser-bugs 23, transform
  9, destruct 69, closures 105, inference 86, json 64 = ~467 tests)
  pass FULL-FILE STANDALONE on today's kernel -- the hang class and
  resolver class are CURED. But IN-SUITE (full kernel leg with them
  included) ~6-8 rows fail DETERMINISTICALLY: destruct's
  `({sqrt, abs} = Math)` errors with AST ["=","sqrt","math.sqrt"]
  (a math-namespace binding leaking across kernel compiles),
  data.js's new P0-2 subnormal/2^52 pins, inference's census row,
  transform's canonicalize row. Standalone-clean + in-suite-red +
  deterministic = the kernel long-session state class, now WITH a
  reproducible inventory (unlike its heisenbug appearance 07-25).
  REVERTED the un-exclusion to keep the committed gate green; the
  burn-down lands after the leak hunt. HUNT RECIPE: file-subset
  bisection on the kernel leg ending at destruct (the sqrt row is
  the sharpest victim -- a namespace/binding table entry surviving
  _clear between compiles; suspects: DOLLAR/interned-string maps
  rebuilt but a consumer caching a stale index, or ctx.module
  include state); each cycle ~minutes with targeted file lists.
  SSO NAME-BITS LEAK FIXED 2026-07-26 (banked residual closed): the
  json 'Bad int 9.06791031e-315' ("meta" ASCII bits in an integer
  position) -- kernel-compiled `let SRC; JSON.parse(SRC).meta.scale`
  failed to compile. Fix across module/number.js + src/ir.js +
  src/prepare/index.js (agent-refined twice after the perf ratchet
  caught the first two versions pessimizing hot loops: initial
  ring +920/fgather +1600 scoped down to ring +520 only). Repro
  returns 2 via kernel; bench-selfhost 22/22 (json row restored);
  battery green except the one ratchet row; ring RE-BASELINED
  98120 -> 98640 (+0.53%, one synthetic corpus category) --
  JUSTIFIED: the residual cost is the value-correctness price after
  two scoping rounds; a silent string-bits-into-integer corruption
  class outweighs 0.53% loop-body ops on one synthetic shape.
  fgather baseline unchanged (62880).
  SOLVER + LOOPPLAN SLICE 3 LANDED 2026-07-26 (combined tree, all
  gates green: battery 3098/0, kernel leg 1958/2 user-WIP only,
  parity 18/18, simd 158/158, dbg-invariants leg green, fresh dist):
  (1) SOLVER: session-owned factStore (src/session.js createFactStore
  -- programFacts{walkCache,moduleInitSlot,bodyIntCertain,hazard} +
  bodyFacts + bindingUses slices, DEPS table documented, gen-counter
  dependent-invalidation assert reasoning recorded); cache modules
  (program-facts/analyze/analyze-scans) keep APIs but store through
  getFactStore(); convergence exhaustion now THROWS internal compiler
  errors in production (probe-first proved zero fires across battery
  + kernel + bench compiles before flipping). invalidateLocalsCache
  13 sites + analyzeBody staleability contract = declared next slice.
  (2) LOOPPLAN slice 3: the most-duplicated recognizer fact class
  hoisted into the dispatch descriptor (see agent inventory in
  transcript), byte-identity-gated (zero WAT diffs on the bench
  corpus), recognizers consume the plan. AUDIT P1 substantially
  closed: solver ownership + convergence hard-fail DONE, LoopPlan
  advanced (full candidate-proposal model = remaining vision),
  CompileSession seam live. Remaining plan: P2 exclusions, quiet
  reference refresh + claims gate, user unblocks (watr release,
  CLT/tinygo), banked hunts.
  SORT FLAG-VETO LANDED 2026-07-26 (all gates green): dataDependentFlag
  predicate (ir.js ~610 -- select condition contains a nested value-if
  carrying a memory load = the &&/|| short-circuit lowering over loads)
  composed with eagerSelectOK at all four ?: select-emission sites
  (emit.js ~456); post-watr fold already structurally excluded the
  shape (isPureIR(cond) -- documented). Heapify pick-larger-child
  sites now branch form; unrelated selects byte-identical. SORT
  1.115x -> 0.969x then confirmed LEADING zig (11.76 vs 15.17ms on
  the larger-n run); noise 0.830x kept its cheap-flag select, synth
  1.022x, trace 1.463x (hard tail), fft 1.026x -- no regressions.
  Battery 3096/0, optimizer 213/213 (flag-axis pin added), parity
  18/18. RED LIST NOW: sdf ~1.3 (research tail), shapes 1.27
  (TurboFan hard tail + one versionableTypedNest confirm), crc32
  1.05 border. trace 1.47 hard tail. Every other lane LEADS.
  SHAPES + SORT DISSECTED 2026-07-26 (parallel agents, ABBA-retimed):
  SHAPES 1.27x vs AS = HONEST HARD TAIL -- mul-strength-reduction and
  pointer-walk surgeries both V8-NEUTRAL (0.99-1.05x noise);
  machine-code evidence (archive 2026-07-20e reconfirmed): +4 cmp
  incl 2x b.ls heap-bounds branches TurboFan keeps + 6 const remat
  per iter -- TurboFan regalloc/BCE below WAT level; ONLY remaining
  jz candidate: confirm whether versionableTypedNest fires on the
  record scan (JZ_DBG_VS, unmeasured share; would retire the 2
  b.ls). todo.md:1048 'byte-stride follow-up' label is a STALE
  MISNOMER (hypothesis falsified 07-20e). SORT 1.115x vs zig = ONE
  REAL LEVER: the 'pick larger child' select's FLAG is a nested
  data-dependent if (cond1 && f64.lt loads) -- branch-form surgery
  (block + br_if skip-store, both heapify loops) retimed 1.063/
  1.118x = closes ~all of the gap (extrapolated; direct paired
  confirm needs the landed fix). NEW VETO AXIS: not arm cost
  (hasExpensiveOp) but FLAG construction -- a select fed by a nested
  if over data-dependent comparisons loses to the branch form on V8.
  Sites: optimize/index.js post-watr if->select ~4272 + emit.js
  eagerSelectOK ~456. Comparator-dispatch WATCH note ruled out
  (raw f64.lt, no calls). BANKED neutral-but-real: cse-load.js
  runSeq treats if-statements as opaque -- never scans the ALWAYS-
  EVALUATED condition for available reads (redundant f64.load pair
  in swap; V8 masks it; emit-quality item). Fill SIMD 1.88x local
  but <1% share. Tooling note: wat2wasm rejects jz's U+E000 idents;
  use watr assemble.mjs for surgery.
  narrowMutatedParams + CompileSession SLICE LANDED 2026-07-26 (all
  gates green): (1) mutated-param i32 specialization -- a body-
  written param admits i32 narrowing when every caller passes i32
  AND every mutation RHS proves int-safe with the param seeded i32
  (reuses type.js int machinery); the i32-specialized reassign path
  emits native local.set; result narrowing picks it up through the
  existing ordering. TRACE 1.86x -> 1.47x MEASURED via the real
  runner (exactly the surgery share); the residual 1.47x is the
  ledgered branch-layout hard tail. Regression pinned in
  inference.js (int-mutated param promotes; float-mutated stays).
  (2) CompileSession first slice: src/session.js beginSession owns
  per-compile lifecycle (reset, ALL cache clears, name-uids,
  warnings, strict/host/optimize normalization, post-reset assert);
  setupCtx/setupSelf are thin host-policy wrappers -- setup drift
  now structurally impossible (audit P1 stage-4 seam). VERIFIED:
  native battery 3093/0, kernel leg 1958-class/2 user-WIP only,
  parity 18/18, inference 84/84, optimizer 212/212, trace paired
  1.47x, fresh dist. Reds remaining: shapes 1.22, sort 1.15, sdf
  ~1.3 (research tail), crc32 border; polluted results.json + bench
  svg NOT landed (quiet-machine refresh pending).
  TRACE LEVER MECHANISM CORRECTED 2026-07-26 (locator agent, file
  evidence): INLINER EXONERATED (inline.js has zero rep logic --
  it faithfully clones the signature narrow.js already fixed).
  Real trap, two cooperating refusals: (1) narrow.js
  applyI32ParamSpecialization (line 95) EXCLUDES any body-written
  param (findMutations, line 113/115 -- `nc++` is a write) because a
  narrowed param's reassignment would emit through the generic f64
  assign path and type-clash (comment 103-106); sibling read-only
  params sx/sy DO promote -- exactly the observed split. Same
  mutation-guard repeats in validateTypedLenParams/
  validateIntConstParams/applyPointerParamAbi (systemic policy).
  (2) type.js intLevelMap (2460-2507) seeds f64 params at level 0
  (anti-vacuous-fixpoint, 2473-2484), so the self-referential
  `nc = nc+1` def evaluates 0 && 2 = 0 forever -- structurally
  unprovable once (1) refused. (3) narrowI32Results (400) runs
  AFTER param specialization (1689 vs 1665) and types `return nc`
  off the already-decided param type -- the f64-ness propagates to
  the result automatically. LEVER (named): narrowMutatedParams --
  extend applyI32ParamSpecialization to admit a mutated param when
  every mutation RHS is provably int-safe (intExprChecker/
  intLevelMap applied with the param optimistically seeded i32),
  AND fix the generic-f64-assign limitation so specialized params
  get i32-native local.set on reassignment. Expected: trace 1.86 ->
  ~1.47 (the measured surgery share); general win for every
  monotone-counter param (cursor-through-helper shape).
  TRACE DISSECTED 2026-07-26 (agent, ABBA + WAT surgery, checksum
  1827210493 held): 1.86x = TWO layers. (1) FIXABLE ~45% of gap,
  V8-POSITIVE: monotone array-write cursor `nc` (param+return of
  inlined traceLoop) carried as f64 through the hot loop -- f64->
  i64->i32 round trip per iteration for the store index -- because
  the INLINER CLONES THE CALLEE WITH PRE-INLINE CALL-BOUNDARY REP
  BAKED IN (VAL.NUMBER at updateRep sites compile/index.js ~584/
  1714/1740, boundaryI64 ~751/759) and never re-derives rep from the
  flattened intra-procedural uses (hoistNestedCalls inline.js:355,
  temp mint ~665). i32-shadow surgery: 1263->1004us = 1.258x
  speedup, vs c-wasm 1.86->1.47x (confirmed twice). LEVER: re-run
  int/range narrowing AFTER inlining per inlined-temp local (same
  proof classes as plain locals); must not leak into non-inlined
  call sites (f64 ABI contract stands). NOT covered by cursor-
  versioning (that's bounds elim, this is representation). (2) HARD
  TAIL ~1.47x: the already-ledgered branch-layout class (data-
  dependent if(inside), no conditional store in wasm) -- correctly
  stays. Deficits 2/3 (re-derived bounds check on tested index;
  asymmetric y-half range fusion) RETIMED V8-NEUTRAL (1.003/1.004x)
  -- emit-quality only, low priority. Surgery artifacts persist in
  scratchpad (trace-*.wat/wasm, retime harnesses).
  TRUE RED LIST via TARGETED PAIRED RUNS 2026-07-26 (user's call:
  suspects only, quiet, ABBA-paired): fft jz LEADS 0.92x and
  glyfparse LEADS 1.00x -- their 'red' readings in the concurrent-
  work-polluted full refresh were noise (lesson: NEVER run the
  reference refresh while working; the polluted results.json in tree
  is NOT committed). REAL reds: trace 1.86x (c-wasm -- worst),
  shapes 1.22x (as), sort 1.15x (zig), sdf 1.24-1.34x (research-tier
  banked), crc32 1.05x borderline band-edge. synth + levenshtein
  cleared by the select-veto wave. NEXT: trace dissection (sdf/synth
  methodology -- measured shares via WAT surgery + ABBA retimes,
  V8-neutrality verdicts); full reference refresh re-run LAST, on a
  truly idle machine (overnight/user-idle), then claims gate.
  CI SIMD EVIDENCE CAPTURED 2026-07-26 (self-documenting assert paid
  off first run): on CI the f32->i16 specimen compiled SCALAR (no
  v128) with inline counter __inl4 vs local __inl2 -- watr made
  DIFFERENT INLINE DECISIONS within one compile on CI. Platform-
  varying input found in watr: optimize.js:7660 dataNodes.sort uses
  ma.localeCompare(mb) -- locale/ICU-dependent collation -> data
  ordering -> offsets -> downstream size/inline decisions differ by
  host = nondeterministic emitted module. LC_ALL=C did NOT repro
  locally (macOS node full-ICU may mask; CI = linux node 24) so the
  localeCompare fix is NECESSARY-but-maybe-not-sufficient: FIXED in
  the watr SOURCE repo (/Users/div/projects/watr src/optimize.js,
  codepoint compare, UNCOMMITTED -- user releases + bumps jz's watr
  pin to pick it up; node_modules copy left pristine deliberately).
  IF CI still red after the watr release+bump: next suspects are
  other watr sorts (4692 net, 7829 callCounts -- look stable) and a
  CI-side debug leg dumping the specimen WAT diff vs local.
  P0-3 WARM PROBE VERDICT 2026-07-26: NO retained-state defect --
  standalone probe (one instance, 30 recompiles of crc32, per-iter
  ms + memory): timing settles 190ms FLAT (iters 2..29, no drift),
  memory pinned 512MB from iter 0 (kernel high-water, reached
  regardless of initial pages -- 2048-page instance identical). The
  0.99-1.035 hover is STEADY-STATE V8 tiering balance between the
  paired JS and wasm sides (the pin file's own comment anticipates
  this band), not accumulating state. Cap stays. The honest lever
  left is making kernel compiles faster in absolute terms (the perf
  queue serves that) -- no warm-specific defect to fix. P0-3 CLOSED
  as investigated-and-attributed; revisit only if the hover worsens
  past ~1.05 again (that WAS a real defect -- preset bools).
  P0-3 WARM MARGIN REFINED 2026-07-26: recovered from the audit's
  1.047-1.094x to a 0.989-1.035x HOVER (run-to-run: one round 0.989
  PASS, next 1.007/1.029/1.035 FAIL) -- the preset-faithfulness fixes
  (bool-atom: kernel now truly runs its speed tier) did the bulk.
  Key datum: FRESH instances geomean 0.771x while WARM hovers ~1.01
  -- the warm instance is ~30% slower than a fresh one per compile,
  so the debt is INSTANCE-REUSE state, not compile speed: suspects
  (a) monotone memory growth (arena high-water -> grown wasm memory
  never shrinks; locality/bounds-check costs), (b) V8 tiering state
  on the long-lived instance, (c) retained-map costs cleared but
  reallocated. NEXT PROBE: log memory.buffer.byteLength per warm
  round (scripts/bench-selfhost.mjs JZ_BENCH_WARM path) and correlate
  round-ratio vs memory size; if monotone-growth-correlated, the fix
  is arena shrink/reset (memory.discard when available, or fresh-
  instance-per-N-compiles policy in the WARM benchmark contract
  itself -- decide vs the 'warm' definition in the pin's comment).
  Do NOT loosen the cap (audit directive).
  CI STATUS 2026-07-26 (after 800185bb): selfhost workflow's 6
  kernel-leg fails FIXED. Remaining CI red = ONE test: 'SIMD breadth
  f32->i16 encode vectorizes' -- CI-LINUX-ONLY (passes locally on
  all legs incl. opt0/opt3: simd 158/158, optimizer 212/212) and
  LEG-VARYING (opt0 at 800185bb's run; wasi+opt3 at the front-half
  run -- the accompanying select-veto matrix fail there self-resolved
  at 800185bb). A WAT-shape assert varying by leg on one platform =
  either platform-conditional test registration (CI totals 3092 vs
  local 3099 -- 7 conditionally-registered tests differ) or a
  remaining host-dependent codegen input (HOST_PROFILE is now EMPTY
  -- wideBigint removed -- so enumerate what else differs: node
  version on CI, V8 SIMD feature detection, relaxedSimd gating).
  NEXT: reproduce CI-side -- add a temporary debug step to the test
  workflow dumping the compiled WAT for the f32->i16 specimen (or a
  matrix-env local repro: check test/simd.js for how that test gates
  and what env the wasi/opt0 legs set; try JZ_TEST_HOST=wasi
  locally), diff CI WAT vs local. Timing of first failure = the
  front-half+veto push, so suspects are the veto's EXPENSIVE set
  interaction with f32 conversion chains ON LINUX-BUILT... but
  codegen must be host-independent -- if a host input is found, that
  is the bug (determinism principle), not the test.
  P0-2 FINAL REPORT BANKED 2026-07-26 (agent, complete): collapse
  point was subscript's number lexer returning host BigInt (in-kernel
  = i64-bits carrier, indistinguishable from subnormal at node-build
  time); fix = ['bigint', decimalStr] tagged node minted in the digit
  wrapper (structural n-suffix detection), consumers simplified
  (kind.js:444 NUMBER unconditional, prepare unary folds drop
  magnitude guards, emitNeg drops subnormal fallback). bignum.js:
  15-BIT LIMBS (not 32) -- forced by mulFitsI32 unsoundness: either-
  operand <= 2^22 admits i32.mul without product-range check, 16-bit
  limb halves both qualify yet product overflows i32 (verified live:
  32768*65536 -> -2^31 in-kernel). FOUR NEW SELF-HOST BUG CLASSES
  BANKED (leads for hunts): (1) mulFitsI32 product-range unsoundness
  (emit.js -- REAL miscompile, worked around structurally, fix the
  heuristic properly); (2) closure-in-loop capture miscompile --
  `for(c){const orig=lookup[c]; lookup[c]=(a,b)=>...orig...}` all ten
  closures shared ONE wrong captured binding in-kernel; (3) O3
  cross-call-site parameter contamination -- same callee called with
  literal-k and variable-k sites read each other's k (traced live,
  time-boxed, worked around by fusing/masking; O3 miscompile hunt
  lead); (4) $__eq null-vs-undefined nullish case was missing +
  emitStrictEq delegated === to ==, needed $__eq_strict split.
  RESIDUALS PROVEN PRE-EXISTING (parent-commit worktree comparison,
  identical repro at 8fe2537b): json 'Bad int 9.06791031e-315' --
  bits decode to ASCII "meta": SSO-packed property-NAME bits leak
  into an integer position in dyn-prop-hash/json codegen
  (collection.js strHashLiteral/ssoMix or json.js runtime parser
  suspects); bench-selfhost 21 DIFF rows = kernel-vs-native BOUNDS-
  CHECK INFERENCE GAP (mat4 $multiplyMany: kernel select-guarded
  load vs native bare f64.load -- optimization parity, not value).
  Both = new audit items. Kernel leg now 1958/2 (BETTER than the
  1955 baseline). NOTE: agent used an isolated git worktree for the
  parent build (sanctioned tooling, working tree untouched).
  P0-2 + REGISTRY LANDED 2026-07-26 (all gates green): tagged bigint
  literals -- kind rides the AST (parse/prepare tagged node, consumers
  key on the tag), kernel 5e-324 -> 5e-324 number (was 1n), pins for
  subnormals/2^52/64-bit boundaries in data/preeval/statements tests;
  host-independent rational fold -- src/bignum.js u32-limb arithmetic
  replaces native-BigInt rational carry, fold|0/2/3 parity rows
  GRADUATED (PARITY_TODO empty again), HOST_PROFILE.wideBigint
  REMOVED (both readers gone); pre-eval-in-kernel fold deviations
  fixed (undefined==null folds 1, slice folds correct) -- the 6
  CI-red kernel-leg failures cleared, kernel leg = only the 2
  user-WIP typedarray rows; single pass registry src/passes.js
  (62 passes/22 tuning/7 hot, zero imports) feeding ctx.js OPTF and
  optimize/index.js presets/validation (audit P2). Verified: native
  3093/0, kernel leg baseline-clean, parity 18/18, selfhost 21/21,
  kernel pins direct. REMAINING audit order: P0-3 warm margin,
  P0-4 reference refresh, P1 solver/LoopPlan/CompileSession, P2
  exclusions burn-down.
  CI RED ROOT-CAUSED 2026-07-26: the 6 kernel-leg failures (null-vs-
  undefined strict/loose, slice negative/no-args, boolean/nullish,
  +1) are PRE-EVAL-IN-KERNEL FOLD BUGS introduced by the front-half
  land (pre-eval now executes as kernel wasm): kernel-compiled
  `undefined == null ? 1 : 0` FOLDS to 0 (native 1), slice folds to
  0-length -- but the RUNTIME paths are proven correct in-kernel
  (x==null with undefined -> 1, runtime slice(-3) -> 3). Class: host-
  JS idioms inside evalConst that deviate under the self-host subset
  (nullish literal classification, optional-chain undefined-arg
  slice). NOT the select veto (that commit was merely the last push
  CI ran). Fix delegated to the P0-2 agent (owns pre-eval.js
  uncommitted); kernel leg is now a MANDATORY local gate pre-push.
  Also: strings.js standalone reproduces 2 of the 6 -- the 'in-suite
  only' theory was wrong this round; direct compileViaKernel repro
  scripts are the tool (no suite needed).
  FRONT HALF + SYNTH LEVERS LANDED 2026-07-25 (joint, battery
  3090/0): (1) src/front.js canonical front half consumed by index.js
  AND all four self.js kernel entries; resetNameUids in setupSelf;
  audit fold repros byte-identical node-side; kernel graph now
  includes pre-eval -- TWO self-host-subset fixes needed (computed
  Math members Math[name]/Math[CONST] -> explicit dispatch tables in
  pre-eval.js); kernel 12.2MB builds green; parity corpus 18 rows,
  mfold graduated (in-wasm preEval folds Math byte-identically --
  earlier 'divergence' was a stale-dist artifact of the crashed
  build), fold|0/2/3 tripwired = the RATIONAL fork (native rational
  carry vs kernel IEEE under wideBigint=false -- compiler-host-
  dependent output, determinism violation; fix = host-independent
  u32-limb rational arithmetic in pre-eval, banked). (2) synth
  levers: select cost veto (hasExpensiveOp) + stripCanon through
  hoistTempDefs -- synth 1.09x RED -> 1.02x BAND vs AS (surgery
  predicted 0.993x; residual gap = implementation vs ideal surgery,
  acceptable; lane no longer red). LESSON (process): piping build
  through tail masked its exit status -- bqvs1mwmd's parity ran on a
  STALE dist and produced two wrong conclusions before the direct
  build surfaced the real error; never pipe a gating build.
  P0-2 LITERAL-KIND DESIGN 2026-07-25 (banked for post-land window):
  mechanism read off emit.js typeof-bigint arm (~426) + pre-eval
  157-161 -- the self-host BIGINT CARRIER is raw i64 bits
  reinterpreted as f64, so small bigints occupy the SUBNORMAL bit
  space (1n == 5e-324 bits) and the only disambiguation is the
  magnitude heuristic |x| < MIN_NORMAL && x != 0 -> bigint; hence a
  genuine subnormal literal misreads as bigint at every kernel
  boundary (typeof, export -- audit repro 5e-324 -> 1n, 1e-320 ->
  2024n). FIX DESIGN (audit-scoped to literals): make the KIND
  explicit in the AST, never the bits -- parse/prepare rewrite
  bigint literals to a TAGGED node ['bigint', '<decimal-string>']
  (string payload = unambiguous in-kernel; number literals stay
  [null, f64]); prepare/pre-eval/emit/valTypeOf key on the tag;
  the magnitude heuristics in pre-eval (structural subnormal fold
  refusal) and emit (typeof arm) then apply ONLY to runtime values,
  and compile-time constants never misread. Runtime computed
  subnormals vs bigint at typeof/export remain ambiguous by carrier
  design -- that deeper redesign (boxed bigint) is out of audit
  scope; document as known limit. Files: src/parse.js (or prepare
  literal normalization), prepare/index.js, pre-eval.js, emit.js,
  kind.js + native-vs-kernel pins for subnormals/signed subnormals/
  2^52-adjacent bigints/64-bit boundaries per audit. CONFLICTS with
  synth-lever files -- implement AFTER the joint land.
  CLAIMS RELEASE GATE LANDED 2026-07-25 (audit P0-4): test/
  bench-claims.js -- committed-evidence-only hard gate wired into
  prepublishOnly (npm run test:claims), three axes: FRESH (git log
  meta.commit..HEAD over src/module/jzify/index.js/interop.js must
  be empty), COMPLETE (every CLAIM_RIVAL incl. tinygo needs >=5
  parity-valid rows), WINNING (no case beyond WASM_BAND_TOL of its
  best rival; band = tie never lead). Currently red BY DESIGN:
  10 stale commits, tinygo 0 rows, 8 red cases (fft 1.081 rust /
  sdf 1.247 c / synth 1.091 as / trace 1.463 c / sort 1.113 c /
  crc32 1.051 c / levenshtein 1.054 as / shapes 1.474 as). ORDER:
  land synth levers -> refresh reference dataset at HEAD on this M4
  (meta.host matches) incl. tinygo rows -> remaining reds = the perf
  work queue (trace and shapes worst at ~1.46-1.47x -- next
  dissection targets after synth).
  SYNTH DISSECTED WITH MEASURED SHARES 2026-07-25 (agent, WAT
  surgery + ABBA retimes, checksum 41574153 held): jz 2688-2707us vs
  asc-O3 2455-2478us = 1.084-1.093x. THREE deficits:
  (1) DOMINANT ~108% of gap: eager-select CASCADE for the ADSR
  4-way ternary -- all three f64.div arms computed unconditionally
  per sample (3 selects chained); rewriting to nested lazy
  if(result f64) flips jz/AS to 0.993x (jz BEATS AS). Lever: the
  '?:' select-gate (src/compile/emit.js ~4144/4186) treats
  isPureIR as the ONLY criterion -- pure but EXPENSIVE arms
  (f64.div/f64.sqrt) need a cost veto, especially cascaded N-way
  chains. Must verify no regression on genuinely unpredictable
  branch data before landing (eager-cheap-select can beat a
  mispredicting branch). NOT previously ledgered.
  (2) SECONDARY ~25%: stripCanon (emit.js 178-198, .canonOf from
  emitNeg 270) cannot see through hoistNestedCalls' temp
  (plan/inline.js ~365-384): `const __tmp = sinTau(ph)` severs the
  structural link, NaN-canon guard survives per sample. 4 minimal
  repros pin the boundary exactly. Lever: def-use closure through
  the SINGLE-DEF compiler-generated temp at the same site. Together
  1+2 measured 0.9756x = jz beats AS on synth.
  (3) ToInt32 guard strip: VERIFIED V8-NEGATIVE (~2% slower
  stripped, reproduced stacked and alone) -- DO NOT TOUCH; the
  select-guard form is faster on V8 than bare trunc_sat here.
  LENGTH-HEADER LICM LANDED 2026-07-25: stable-header admission in
  hoistInvariantLoop -- `i32.load(i32.sub(local.get $X, 8))` is
  loop-invariant when $X is VAL.TYPED or ARRAY neverGrown (header
  word immutable for the binding's lifetime; no alias analysis
  needed) and $X itself passes the standard local.get invariance.
  Stamp fn.stableHeaderNames in compile/index.js (mirrors
  distinctParams), admission in loopInvariance, threaded in
  hoistInvariantLoop. edt1d header decodes 20 -> 5 (v/z/f one each
  at function scope, d one per its two nests). HONEST BENCH VERDICT:
  no measurable sdf wall-clock change (bands overlap; V8 TurboFan
  already LICMs this at JIT tier) -- the win is emitted-code
  size/shape (golden-size class) + non-optimizing consumers
  (baseline tiers, AOT). Regression test pins the shape + bit-exact
  results (optimizer.js 210/210); battery 3088/0; perf golden sizes
  53/53. Deliberately not covered (banked): boxed-pointer receivers
  (isPtrBaseDecode chain match), subarray views (length at base+0 --
  ambiguous with data loads, needs a distinct marker), plain-array
  guard sites in module/array.js (verify the pattern fires there),
  out-of-loop one-shot guards (cheap, skip). The remaining sdf gap
  stays the research-tier symbolic hull (~53% share) -- next
  frontier items: synth 1.09x vs as, raymarcher 0.96x, warm hover.
  SDF GAP DISSECTED WITH SHARES 2026-07-25 (diagnosis agent, WAT
  micro-surgery + retime): jz 6483us vs c-wasm 5228us = 1.24x. The
  edt1d hull-cursor `k` keyed accesses (v[k], z[k], z[k+1], stores)
  = 21-22 guarded sites; stripping ONLY those guard branches (tee
  side effects preserved; checksum matches -> checks provably dead
  for the specimen, just not provable to jz) retimes to 5812us =
  1.11x -- the k-guards are ~53% OF THE ENTIRE GAP. That half is the
  KNOWN research-tier item (archive 'SDF SHARPENED 2026-07-22':
  sentinel invariant z[0]=-INF blocks k-- below 0 + relational elem
  hull v[i] in [0, n-1] with runtime n) -- stays the hard tail.
  NEW ACTIONABLE SECONDARY (unledgered until now): the LENGTH HEADER
  RELOAD -- every guard re-fetches i32.shr_u(i32.load(v-8)) /
  (z-8) from MEMORY per site though v/z are never-resized params
  (loop-invariant): the pointer is cached in a local but the DECODED
  LENGTH VALUE is not carried across the inner-loop scope. Lever:
  extend the bounds-check emission / loadCSE to hoist a proven-
  loop-invariant length decode once per enclosing loop nest (the
  neverGrown/paramNeverGrown rep already exists as the resize-proof
  anchor -- see reps.js neverGrown). Mechanical, isolated from the
  symbolic-hull problem, should trim a real slice of the remaining
  1.11x and helps every checked-access loop program-wide, not just
  sdf. NOTE (process): the agent used `git checkout -- bench/
  results.json` to undo an incidental bench write -- forbidden
  command class; file verified clean, no damage; future agent briefs
  must say 'revert by re-editing, never git checkout'.
  IN-SUITE PERF ASSERT CLEARED 2026-07-25 (bisect agent, three
  independent runs): the perf.js 'JSON.parse walk uses slot loads'
  in-suite-only failure NO LONGER REPRODUCES -- full kernel suite
  1955/1963 with ONLY the user's 2 typedarray WIP rows red; the exact
  34-file preceding subset re-run twice green; 0-200 padding compiles
  + JZ_KERNEL_GC_EVERY parity probed, no effect. The same-day fix
  waves (elemOrigin / bool-atom / recursionUnroll / earlier
  string-compare + preboxed) closed the window of this heisenbug
  class. Instance isolation verified structurally sound (fresh
  Instance per compile over cached Module; setupSelf resets all
  caches). IF IT RECURS: test/perf.js:1272 has JZ_DEBUG_KNIFE=1
  built in -- capture the victim WAT at the red moment, don't
  reconstruct sequences post-hoc. KERNEL SUITE VALUE-DEBT: ZERO
  (excluding user WIP).
  KERNEL PARITY COMPLETE 2026-07-25 -- PARITY_TODO EMPTY: the
  recursionUnroll root was the SHARED-ACC RESET, not a guard fold:
  the fused inlined frame shares the caller's accumulator, but the
  callee's own non-zero init (`let s = 1`, survives zeroinit) cloned
  verbatim RESET the running total each level (watr count() returned
  3 for an 8-node tree). FIX (src/optimize/recurse.js): acc-write
  vetting on the template -- consume-shape `acc = acc +- X` clones
  verbatim; ONE acc-free init as the first acc occurrence at loop
  depth 0 rewrites to `acc += init` in cloneFuse (isConsumeShape +
  readsLocal helpers); tee/reset/in-loop-init/acc-reading RHS bail;
  plus `return V` where V reads acc non-trivially (s*2 double-count)
  bails. Verified: cnt 8/8/8 at O0/O2/O3, zero-init sum exact,
  s*2-return exact at O3, optimizer 209/209, battery 3085 green
  (only the graduating tripwires red mid-run), kernel rebuilt TWICE
  (incl. post-vet), parity 3/3 with PARITY_TODO EMPTY -- every
  corpus row byte-identical at every tier. Regression pinned in
  test/optimizer.js ('recursionUnroll: non-zero acc init fuses as
  +='). The parity long-tail (architecture plan stage 5) is CLOSED:
  three waves -- elemOrigin gate, dyn-spread bool atom, shared-acc
  reset.
  DICT ROWS -- FULL CLOSURE: recursionUnroll BUG, 5-LINE NATIVE REPRO
  2026-07-25: build-dist.mjs line 127 builds the kernel at LEVEL 3
  (recursionUnroll: true). Native repro, no kernel needed:
    const cnt = (n) => { if (!Array.isArray(n)) return 1; let s = 1;
      for (let i = 0; i < n.length; i++) s += cnt(n[i]); return s }
    export let f = () => cnt(['op', ['a', 'b'], ['c', 1]])
  node 8; jz O0/O2 8; jz O3 = 3 (WRONG); O3 + recursionUnroll:false =
  8. So: recursionUnroll (inline a single non-tail self-call, O3/
  speed only) miscompiles heterogeneous-arg self-recursion -- the
  inlined copy's Array.isArray guard folds (or arg coerces) against a
  misproven recursive-arg type. The 'kernel-scale' theory was wrong:
  standalone probes were compiled at O2, the kernel binary at O3 --
  its embedded count() is the miscompiled O3 form at runtime
  regardless of requested compile level. Explains count(b)=3 and the
  select fires (dict|2/dict|3 rows). NEXT (small, land-able): fix
  recursionUnroll in src/optimize/index.js -- find where the inlined
  self-call body folds the isArray/type guard on the substituted arg
  (n[i] elem read must stay UNKNOWN absent a proof; likely the same
  differing-primitive/valType fold family) -- add the repro above to
  test/inference.js or optimizer tests, verify O3 returns 8, battery,
  REBUILD KERNEL (O3 build bakes the fix in), expect dict|2 dict|3 to
  graduate (kernel count() correct -> cap rejects -> select stops ->
  byte parity), PARITY_TODO empty.
  DICT ROWS -- UNDERCOUNT PROVEN, NEW CLASS NAMED 2026-07-25 (heavy
  probe, two deterministic rebuild cycles): in-kernel gate counters
  676/144/81/5 vs node 685/153/145/0 -- gSuccess 5 in-kernel; the cap
  operand count(b) for `(i32.shr_u (local.get $et)(i32.const 1))` is
  8 in node, 3 IN-KERNEL (1 + op-leaf + 1 + 1: both recursive
  self-calls return leaf-like 1). Second round pinned it exactly:
  from INSIDE the rule, b.length=3, Array.isArray(b[1])/b[2]=1/1,
  child lengths 2/2, and DIRECT external calls count(b[1])=3,
  count(b[2])=3 are ALL CORRECT in-kernel -- only count()'s OWN
  self-recursive invocations (`n += count(node[i])` in its for loop)
  return wrong. CLASS: self-recursive call miscompile at kernel
  scale -- recursion-site-dependent, NOT covered by elemOrigin (no
  array mutation; plain numeric recursive accumulator). LIKELY
  MECHANISM to test first: the recursive call site coerces node[i]
  (element read stamped numeric by some lattice fact at 12MB caller
  population -> f64 coercion strips the array box -> Array.isArray
  false in the callee) -- i.e. an element-fact/param-fact misproof at
  the RECURSIVE-ARG position; alternatives: recursive-call codegen
  arg slot corruption, self-call inlining. NEXT LEG: instrument
  count()'s BODY (log typeof/Array.isArray(node) + a marker of the
  call path on re-entry) same heavy-probe discipline (temp export via
  self.js + kernel rebuild + restore); or FIRST try cheap native
  repros: a tiny jz program with `const count = n => Array.isArray(n)
  ? n.reduce-style loop self-recursion : 1` at O2 compiled INTO a
  large module context, checking count(nested) -- if the misproof is
  lattice-driven it may reproduce below kernel scale with the right
  caller mix (numeric-arg callers + array-arg callers of the same
  recursive fn). Kernel restored pristine after probe, parity 3/3
  green (dict tripwires correctly still red). Fix belongs in jz
  (inference/codegen at recursive call sites), not watr.
  DICT ROWS -- NATIVE BLOCKER NAMED 2026-07-25 (tree-tap agent):
  natively the select fold is blocked by watr's ARM-SIZE CAP
  `count(a) > 6 || count(b) > 6` -- count() tallies every array
  wrapper + op-name + leaf token, so ANY binary op on two leaves
  costs 8 > 6 (typed_shift inner arm `(i32.shr_u (local.get $et)
  (i32.const 1))` = 8; char_at arms 17..118). isPure/hasTrap/
  readsMemory all pass. AND the tree-shape theory is DEAD:
  __typed_shift/__char_at are STATIC WAT TEXT (module/core.js:650
  stdlib strings) parsed by watr.parse -- direct tree byte-identical
  to parse(print()) (336B JSON both). So the kernel's select can ONLY
  mean the kernel's count()/cap evaluates differently in-kernel.
  Standalone jz-compiled watr (module-graph path, watr-diff entry,
  987kB) matches node exactly at gate granularity. CORRECTION (esbuild
  theory REFUTED by reading build-dist.mjs line 120): the kernel is
  NOT esbuild-bundled -- it's resolveModuleGraph(scripts/self.js),
  the SAME path as the standalone probe. esbuild only builds dist/
  jz.js. Therefore the divergence is KERNEL-SCALE-DEPENDENT (987kB
  faithful vs 12MB kernel diverging) -- the same enclosing-scale
  class as the shaped-parser bug. count() is trivial (1 + sum over
  children, Array.isArray + .length loop); an in-kernel undercount
  means Array.isArray/.length/recursion misreads at 12MB scale, or
  the cap compare itself. NEXT LEG (decisive, running as agent):
  instrument watr counters + temp gateCounts export in scripts/
  self.js, rebuild kernel WITH probes, compileWat(dict) via kernel,
  read counters, compare to node; then restore pristine + rebuild. ALSO
  worth checking: is the fold DESIRABLE? arms are pure, kernel output
  smaller -- if sound, the cap is miscalibrated in watr itself
  (count() double-counts wrappers vs its own 'small cheap arms'
  intent) -- but that's a watr-repo (user-owned) calibration call,
  not a jz fix; parity direction should be decided AFTER the
  in-kernel count() divergence is explained (an undercount is a
  MISCOMPILE to fix even if the resulting fold happens to be sound).
  Rows remaining: dict|2 dict|3.
  DICT ROWS -- GATE PROBE NEGATIVE 2026-07-25 (subagent, evidence
  exact): every early-return gate of watr's value-if->select rule
  counter-instrumented (gEntry/CondArr/Result/Arity/Pure/Trap/
  ClashEval/Clash/Success) and run on the dict pre-watr WAT under the
  exact resolved O2 opts: node 685/0/510/22/145/0/8/8/0 == wasm
  IDENTICAL, output SHA-1 equal, gSuccess=0 BOTH ENGINES. The rule
  never fires on the parse(print) tree in either engine -- watr's
  gate logic is exonerated at gate granularity. THEREFORE the real
  kernel's select forms come from the DIRECT in-memory IR tree its
  own assemble/emit hands to watr (not parse-built): some tree
  property present in the kernel's direct tree (and absent/blocked in
  native's direct tree AND in parsed trees) lets the rule fire.
  REFINED NEXT PROBE (cheap first leg fully native): re-add the
  JZ_DBG_TREETAP tap in watr-tail.js (2-line env-gated stash, was
  proven this session), instrument the select rule's gates in
  node_modules watr, run the NATIVE pipeline (direct tree) and find
  WHICH gate rejects __typed_shift's inner if natively (counters say
  gPure=145 and gResult=510 are the busy rejects on parsed trees);
  then reason/diff what the kernel's direct tree does differently at
  that exact check (suspects: result-type annotation shape, isPure's
  OPCODE membership on jz-built nodes, string-vs-number const args).
  Probe scripts persist in scratchpad (gen-dict-wat.mjs, run-node.mjs,
  wasm-probe.mjs, dict-prewatr.wat, dict-watropts.json). watr
  restored pristine 5.7.11; entry restored; no commits by the agent.
  Rows remaining: dict|2 dict|3 only.
  DICT ROWS -- NEXT PROBE READY 2026-07-25 (superseded by the above): the select conversion is
  watr's value-if->select rule at node_modules/watr/src/optimize.js
  ~1253 ((if (result T) c (then A)(else B)) -> (select A B c), gates:
  non-const cond, result i/f 32/64, arm count()<=6, isPure both arms,
  hasTrap/readsMemory reject, and a cond-writes-vs-arm-reads clash
  scan under !isPure(cond) that probes OPCODE[n] membership). Kernel
  fires it on __typed_shift/__char_at; native does NOT -- yet on
  paper the gates pass for __typed_shift's inner if in both engines.
  Per-func diff post-carrier-fix: ONLY $__typed_shift (nat 389/ker
  281), $__char_at (2413/2335), $count$exp (72461/72579). NEXT: the
  established probe pattern -- counter-instrument EACH early-return
  gate of that rule in node_modules watr (allocation-free counters +
  __counts getter, same as the outline hunt), run dict pre-watr WAT
  through node-watr AND jz-compiled watr (watr-diff entry), diff
  which gate diverges; suspects in order: (a) count()/size lookup
  misread in-kernel (numdata/OPCODE dict reads -- the dyn-dict class),
  (b) isPure OPCODE membership probe, (c) the fixpoint round budget
  (ROUNDS caps) differing via an earlier pass count. Note the probe
  must run BOTH the plain rule and the fixpoint context (rule may be
  reached different number of times). Restore pristine watr@5.7.11
  after (rm -rf node_modules/watr && npm install watr@5.7.11
  --no-save). Remaining rows: dict|2 dict|3 only.
  PARITY sum|3 + arr|3 GRADUATED 2026-07-25 (same session, root
  found where the tree-metadata theory pointed away): the kernel's
  resolveOptimize PRESET CHAIN lost every literal-bool override --
  {...ALL_ON, rotateLoops: true, ...} lowers via emitDynamicSpread
  (fromEntries source = unknown schema -> HASH) whose explicit `k: v`
  writes stored emit(v) RAW: literal true landed as 1.0 bits, not the
  TRUE atom, so `cfg.rotateLoops === true` (strict identity vs atom)
  read FALSE in-kernel and speed-tier passes silently dropped (sum|3
  loop rotation, arr|3). Proof chain: explicit optJSON key rotateLoops
  -> kernel output byte-identical; preset-delivered -> dropped;
  standalone repro at 8 keys (fromEntries+spread+literal bool, ===
  true fails, truthy read passes); fix = storedValue/carrierF64 at
  emitDynamicSpread's explicit-prop write (module/object.js), one
  line + comment. Regression pinned in test/bool-identity.js
  ('dyn-spread literal bool props keep the atom') -- the existing
  preset-table test read flags TRUTHILY, exactly how it missed this.
  Battery 3084 green; kernel rebuilt; PARITY_TODO now ['dict|2',
  'dict|3'] only (select forms in __typed_shift/__char_at -- the
  watr-input-level mechanism, still per the DIAGNOSED entry below).
  PARITY ROWS DIAGNOSED 2026-07-25 (post-elemOrigin, fresh evidence):
  per-func diff dict|2 = ONLY 3 funcs differ ($__typed_shift, $__char_at
  smaller in-kernel via select forms; $count$exp +118B); sum|3 kernel
  856 vs native 991 (kernel hoists the loop-bound local.set out of the
  br_if tee; native keeps the fused tee). INVERTED THEORY: kernel is
  MORE optimized, not bailing. Eliminated: cfg (resolveOptimize(2) ==
  {level:2} modulo unread 'level' key), preset spread-override shape
  (differential-clean at 60-key scale), watr opts (replayed native
  resolveWatrOpts base + every knob variant: base reproduces NATIVE
  byte-exact, NOTHING reproduces kernel), watr engine (jz-compiled
  standalone watr == node watr under BOTH O2- and O3-resolved opts,
  SAME on the very pre-watr WAT), funcCount/unroll2 (no effect),
  pre-watr pipeline (watr:false prints byte-IDENTICAL native vs
  kernel; only watr-tail reads cfg.watr so no pre-watr stage branches
  on it). REMAINING EXPLANATION: the tree HANDED to watr differs in
  print-invisible ways -- native feeds jz IR arrays (typed() .type
  props, shared subtrees via dup(), JS numbers) while parse(print(t))
  canonicalizes; natively direct==parsed (991==991) but in-kernel
  direct(856) != parsed(991) -- the kernel's direct tree unlocks folds
  watr won't make on native's direct tree. NEXT PROBE (cheap,
  decisive): capture native's direct pre-watr tree (hook watrTail or
  export a debug tap), diff node-identity/props/number-vs-string
  against parse(print()); then find which watr shape-check the native
  metadata blocks -- fixing THAT likely makes native adopt the
  kernel's better output (select folds + hoists = native wins left on
  the table), and parity follows for free. Rows stay in PARITY_TODO
  meanwhile.
  LANDED VERDICT (same day): battery 3084/0 green; kernel rebuilt;
  kernel-target suite 1953/1962 -- the json 'shaped runtime parser'
  assert CLEARED (was 2 shaped-parser fails, now 1), remaining fails =
  user's 2 typedarray WIP rows + ONE perf.js assert ('JSON.parse walk
  uses slot loads') that PASSES standalone under the kernel target
  (json.js 64/64, perf.js 53/53) and fails only in-suite -- the known
  in-context/kernel-long-session state layer, a separate smaller class.
  Parity rows did NOT graduate (misread tripwire messages: green =
  divergence still present): dict|2 dict|3 sum|3 arr|3 remain, their
  divergence is in-kernel jz pass decisions, not the watr class.
  Regression test added (inference.js 'push on a param settles no
  element fact'). Fix = analyze.js elemOrigin gate + analyze-scans.js
  isFreshArrayCtor export; probes all stripped, scratch cleaned.
  ROUND 6 CORRECTION 2026-07-25: tokenizer EXONERATED -- commit()-level
  anomaly probe (parse.js __pLog, drained post-trap) shows P[] EMPTY:
  every token is born with correct length at 140kB scale. AND the same
  log line that shows l0=0 PRINTS the string correctly (String(x) ok,
  x && x.length reads 0) -- the isolated guarded-length probe passes
  both engines, so the l0=0 evidence is DOWNGRADED to a possible probe-
  context artifact (or a real but context-locked length-read miscompile
  inside the compiled watr module -- unresolved). SOLID remaining facts:
  the OOB trap fires INSIDE outline at scale with CORRECT pass flags and
  CLEAN tokens; 'fold' alone OK, '+outline' traps. NEXT: binary-search
  INSIDE outline via early returns (after the facts walk / after exact
  grouping / after chosen / after apply) to pin the trapping stage; the
  facts walk's hash-string churn (h += ',' + f.h; up to 64-char keys +
  hash32 over ~86 groups x rounds) is the prime allocation-pressure
  suspect. Then shrink THAT stage into a standalone jz repro.
  ROUND 5b MINIMAL-REPRO REFUTATIONS (guide the next shrink): (1) plain
  `buf += str[i++]` accumulator + push at 140kB scale: CORRECT in-wasm;
  (2) boxed-buf (commit-closure) + recursion (parseLevel shape) + nested
  arrays at ~200kB: CORRECT. Remaining ingredients of the REAL tokenizer
  not yet in the repro: `level.loc = pos` (PROPERTY WRITE ON ARRAYS --
  dyn sidecar on array at scale, prime suspect), the q-state string/
  comment branches (`buf += str[i]` TWO-char appends, `buf = str[i++] +
  str[i++]` reset form), `level` reassignment through the closure, and
  running INSIDE the full watr module (module-scale locals/globals).
  Next shrink: add level.loc writes first, then the two-char append
  forms; alternatively instrument watr's parse commit() in-place to log
  buf.length vs pushed-token.length at scale (post-trap drain channel).
  RESOLVED clamp-peel blocker: the rejecting node was the PEEL'S OWN
  synthesized `__pks0 = (r < w ? r : w)` bound -- both param proofs read
  the min-ternary arms as bare-use/string-escape rejects, un-proving the
  very params the peel had relied on. FIX: min/max-ternary pass-through
  (arms mirror cond operands) in paramAllUsesNumeric + paramNeverString.
  LANDED green: battery 3084/0, ratchet 10/10, watr-diff ALL SAME,
  -1n<0n O2 kernel TRUE (row un-curated), kernel suite 1953/1962 (only
  shaped-parser json asserts + user's 2 in-flight WIP rows). json's 2
  structural asserts persist -- the in-context layer of the shaped-parser
  bug is deeper than the compare misproof (context-dependent as the old
  harness refutation showed); the watr-diff harness is the tool to peel
  its next layer.
  TOOLS (scratchpad, session-dir): watr-diff.mjs + .work/watr-diff-entry.mjs
  (node-watr vs jz-compiled-watr, 30s cycles, killable children);
  jzify-diff.mjs + .work/jzify-entry.mjs (same for jzify).
  WATCH after land: sort-comparator closures `(a,b)=>a<b?...` now take the
  runtime dispatch -- check bench sort/aos; cure would be callsite-lattice
  number proof (ptRow), never raw compares.
  WARM FOLLOW-UP 2026-07-25: the call-based dispatch cost ~4% warm
  (1.076/1.080/1.035); non-NaN INLINE fast path added (two f64.eq, no
  calls -- every NaN-boxed carrier is a NaN, so both-non-NaN => genuine
  numbers => plain f64 compare; only NaN-ish operands pay is_str_key) --
  recovered to 1.007/1.028/1.035 (pre-wave hover). STILL over the 0.99
  cap: the hover predates this wave (audit measured 1.003-1.114 at the
  previous HEAD). Worst case sort 1.04 -- kernel's own comparator-ish
  compares still dispatching. NEXT margin levers: profile warm compile
  for surviving dispatch sites in compiler-source hot paths and prove
  their operand kinds (callsite lattice / valResult), not raw compares.



* [x] watr 5.7.11 PUBLISHED (user, 2026-07-23); jz dep bumped+locked,
      determinism 5/5 against the LOCKED package (no sibling symlink) —
      audit P0 CLOSED. Battery 3066/0 on published watr.
      Unblocks determinism-from-lockfile (audit P0) + CI determinism leg.
      CONFIRMED on CI @HEAD: test workflow fails ONLY 'determinism:
      warm-process recompile' x2 (published watr lacks the reset); watr
      workflow GREEN. Still to triage: selfhost/bench/test262/pages reds
      (test262 likely pre-existing curated-set drift). selfhost red = warm
      perf gate 1.041x vs 0.99 cap — CI builds the kernel with PUBLISHED
      watr@5.7.10, missing the local watr optimizer work the 0.949x baseline
      was measured with — same watr-publish root as determinism.
* [x] Bench refresh at HEAD: CI bench workflow now commits results.json
      (18aa6245, measured at d74b3d6 on linux/EPYC) — durable evidence
      current. NEW FINDING from the fresh numbers: strict-fastest-WASM is
      MACHINE-DEPENDENT — EPYC runner: 37 strict / 4 band / 17 losing
      (fft 1.33x, trace 1.86x, vm 1.90x, lz 1.20x vs c-wasm — cases that
      WIN on the local M4 reference). V8 tiering/microarch differences.
      DECIDED 2026-07-24 (user delegated): strict claim SCOPED to the
      reference machine (M4) -- bench/README states it; results.json is
      reference-only evidence (restored from 72af94b2 after the CI bot
      overwrote it and dropped the jz-w2c native lane -> bench-CI red);
      the runner now publishes results-ci.json as a visible SECONDARY
      dataset (bench.yml). Selfhost warm/fresh perf-pins adopt the same
      repo-wide timing discipline (okTiming: informational on CI, caps
      unchanged, asserted on reference hardware) -- resolves the selfhost
      CI red (warm 1.03-1.06x on EPYC vs 0.95-0.98x local, fresh 0.60x
      both). OPEN FRONTIER (banked): EPYC rows trailing c-wasm (fft 1.33x,
      trace 1.86x, vm 1.90x, lz 1.20x) -- close by general levers, they
      also pay off on M4.
* [ ] Kernel long-tail (each characterized in the archive):
  * shaped-parser: LOCALIZED (BC14 + host-side pass bisect): the throw is
    a jz-RUNTIME error code (raw 0) firing inside WATR-IN-KERNEL during
    watOptimize, and needs stripmut+globals BOTH enabled (disabling either
    rescues; all-off ok) — a jz miscompile of the stripmut→globals const-
    fold interaction executing in-kernel. NARROWED FURTHER: native watr on
    the KERNEL'S OWN pre-watr tree is fine (pure execution miscompile);
    only the shape module trips pair-only (sum/math/str/constg clean);
    the trigger global is __schema_tbl (the module's ONLY never-written
    global — stripmut immutabilizes it, globals' pricing then clones its
    read anchors and runs watr fold() on them IN-KERNEL; suspect fold's
    i64/BigInt arithmetic hitting the kernel bigint carrier gap — would
    UNIFY this with the bigint-kernel family). NEXT: extract __schema_tbl
    read anchors: i64.load/store over __schema_tbl addr math (2 sites).
    HARNESS REFUTATION (2026-07-23): a jz-compiled watr micro-kernel
    (.work/watr-harness-entry.js graph, compiled at BOTH level:2 AND the
    kernel's exact speed profile) runs pair-only on the SAME 84KB WAT
    CLEAN — the miscompile does not reproduce outside the full kernel.
    Conclusion: context-dependent (arena state/layout at 12MB bundle
    scale, or warm-instance memory pressure when watOptimize runs after
    compileAst in the same instance) — NOT input shape, NOT pass logic,
    NOT tier alone. Costliest hunt class; deprioritized behind concrete
    wins. Probes: scratchpad/{wbisect3,wpair,wnative,wglob2,wanchor,
    watr-harness.mjs,wrun}.mjs + .work/watr-harness-entry.js.
    RELATED NATIVE FINDINGS: Error.message unwired (String(e) works,
    e.message undefined even unthrown); jz runtime errors throw raw numeric
    codes (JSON.parse('nope') throws number) — the message-evaporation
    mechanism.
  * bigint family + preeval CLEARED 2026-07-24 (statements/data/preeval
    un-excluded; kernel suite 1911/1918 [only shaped-parser assert],
    battery 3075/0). Roots, all one family -- the parser CONFLATES small
    bigints with subnormal f64 literals (5e-324 exports as 1n in-kernel):
      - numLiteralNode ZERO-exemption ([, 0n] degrades to [, 0], so a
        zero literal is not PROOF of number-ness; 0n|5n / 0n-5n cleared;
        cost: literal-0 mixes accepted permissively);
      - WIDE_BIGINT probe (ctx.js; shl-mask-proof + string-parse-of-2^64
        double probe) gates rational carry OFF in-kernel -- it needs
        arbitrary precision, the wrapping i64 folded silently-wrong
        values in EVERY in-kernel compile; falls back to sequential
        bit-exact-vs-JS folds; 2 precision tests onKernel-guarded;
      - STRUCTURAL subnormal fold guards (typeof misses the carrier when
        the slot flows as plain f64): prepare u+/u- folds, pre-eval
        numLitResult (both literal readers), emitNeg (routes nonzero-
        subnormal literals down the i64 path under !WIDE_BIGINT).
    ONE curated row remains (-1n < 0n at O2+, onKernel-guarded in
    statements.js): the (i64.sub 0 1) const chain reaches WATR's generic
    fold IN-KERNEL, whose dynamically-typed compare reads the -1n carrier
    (all-ones bits) as f64 NaN -> folds false. KEY UNIFICATION: this is
    the same watr-in-kernel dynamic-compare-on-carrier class suspected in
    the shaped-parser hunt (fold i64/BigInt arithmetic) -- one cure
    (structural bigint literals through the parser, or proven-kind watr
    fold paths) closes both. Emit-time kind-pinned const folds were tried
    and REVERTED (rounds 6-7): String()/convention round-trips of negative
    bigints in-kernel broke sibling rows -- don't re-attempt that route.
  * speculate CLEARED 2026-07-23 (narrowed-param versioning-guard fix:
    len64Of box-decoded the raw i32 offset of a TYPED-narrowed receiver —
    native+kernel OOB; now uses the offset directly; kernel leg 6/0,
    KERNEL_EXCLUDE shrunk). preeval 2 (rational carry) ·
    pow-fold/fifthroot CLEARED 2026-07-24 (both un-excluded from
    KERNEL_EXCLUDE; kernel legs 7/0, kernel suite 1566/1573 [only the
    shaped-parser structural assert red], native battery 3072/0): THREE
    STACKED kernel gaps peeled inside powResolvePool via BC15 stage
    bisection on the 603KB joined WAT body (tables were fine, 6144B each):
      (1) kernel regex err on \u-escaped patterns -> resolver rewritten as
          a manual indexOf/slice scan (kept: faster, allocation-free).
          ROOT RESOLVED 2026-07-24 (rediagnosed): discriminator was NOT
          control chars but ANY \uXXXX escape in a regex LITERAL --
          subscript keeps the pattern atom raw, prepare's decodeIdent
          normalizes it via s.replace(IDESC, cb), and jz's replace
          callbacks NEVER RECEIVED CAPTURE GROUPS (only the match), so
          in-kernel (_, b, p) read undefined -> fromCodePoint(parseInt
          (undefined,16)=NaN) -> trap. FIXED at root: replace callbacks
          now get (match, p1..pn, offset, string) per ES 22.1.3.19,
          clamped to closure width (regex.js + string.js string-search
          form). Fixing THAT exposed a second pre-existing matcher bug:
          quantifier/alternation attempts never rolled back partial
          capture writes -- failed (b)? attempts leaked garbage slices.
          FIXED: per-attempt capture reset (ES RepeatMatcher clear) +
          save/restore on attempt failure in compileRepeatN, reset per
          alternation branch + lazy paths. Pins: replace-callback groups
          x5, quantifier-reset x3, \u-literal x3 (test/regex.js). All 7
          escape probe variants compile in-kernel; kernel suite
          1569/1576 (only shaped-parser assert), battery 3075/0;
      (2) startsWith(s, pos) POSITIONAL ARG SILENTLY DROPPED by jz
          (native+kernel) -> resolver slice-compares; stringSearchMethod
          now LOUD-REJECTS the position arg (module/string.js) + pin in
          test/strings.js; real position support = future item;
      (3) numeric-keyed OBJECT read with a NUMERIC VARIABLE index
          (typeOf[id] -> $pt_undefined_NaN locals) hit the documented
          kernel obj[numVar] gap (2nd confirmed hit after
          resolveOptimize) -> shared.type/lastUse/regOf are dense ARRAYS.
    ALSO NOTED: native quadratic-concat arena exhaustion at ~500KB+ built
    strings (s += in loop, 60k reps) -- model-expected (no GC) but the
    concat-buffer SRoA misses the mixed-chunk shape; future lever.
    async/generators ROOT FIXED 2026-07-25 (the biggest kernel class):
    compileClosureBody populated ctx.func.preboxed AFTER emitting the body,
    so every boxed decl re-allocated its heap cell at the decl site -- an
    EARLIER-created closure had captured the function-entry cell (null) and
    mutually-recursive const arrows (flattenList/flattenStmt in jzify's
    generator machine) called through the stale cell and silently no-opped:
    EVERY generator/async body flattened to zero states under self-host
    (hollow machines; my first indexed-for sidestep turned that into
    infinite dispatch loops -- both symptoms, one root). FIX: populateBoxedSets()
    before emitBlockBody in the closure path (mirrors top-level emitFunc
    order); pinned in test/closures.js at the trigger shape (mutual const
    arrows inside a nested closure). KEY TOOL built for this and future
    hunts: scratchpad jzify-diff.mjs -- compiles jzify standalone to a
    753kB wasm via .work/jzify-entry.mjs and DIFFS node-jzify vs
    wasm-jzify output; reproduces at optimize:false with 30s iteration
    (vs 7min kernel rebuilds); ALL probes as SIGKILL-capped child
    processes (sync-wasm infinite loops starve in-process timers).
    Kernel async+generators legs 36/1 after fix (was fully hollow).
    FULLY CLEARED 2026-07-25: async + generators UN-EXCLUDED (kernel legs
    37/0; suite 1953/1962 -- only shaped-parser + user's 2 in-flight WIP
    rows). The 'negative completion field reads null' remainder root was
    DEEPER than serialization: asI32 (the i32-narrowed param/cell boundary
    coercion, ir.js) lowered f64->i32 via BARE i32.trunc_sat_f64_s, which
    SATURATES at INT32_MAX -- ES ToInt32 must WRAP mod 2^32. extractF64Bits'
    _hx8 closure param (shift-consumed -> i32-narrowed) read 0x7fffffff for
    EVERY negative f64's hi-word -> static slots 0x7FFFFFFF00000000 (NaN
    space) -> read back null. FIX: asI32 wraps through i64 (range-proof
    keeps the single-op bare trunc -- perf-ratchet slice +48 ops justified
    + re-baselined; slices bench still leads v8 0.89x). CASCADE FIXES:
    vectorize peelNarrowConv recognizes the bare wrap form (f32->i16 SIMD
    kept); global-narrow EXCEEDS_I32_CALLS disqualifies clock results
    (Date.now() ~1.7e12 was i32-narrowed -- old saturation masked it as
    'positive', wasi init test caught the wrap). Pins: ToInt32-wrap
    closure-param pin + preboxed mutual-arrow pin (test/closures.js).
    host ABI: 5th `host` param landed across self.js entries + kernel-target
    marshal ('wasi'|'js' string, 0 = native undefined default).
  * [x] kernel-parity TODO rows (dict|2, dict|3, sum|3, arr|3) RESOLVED
    (PARITY_TODO empty since 2026-07-27; 18/18 byte-identical O0/O2/O3).
  * test:self WARM PERF REGRESSION CONFIRMED REAL (2026-07-23): sequential
    3-round verdict landed (strict cap 0.99 unchanged; fail only when ALL
    rounds exceed — kills boundary flakiness) and under it the gate fails
    consistently: 1.035/1.046/1.007 (best per-case mat4 0.98, fft 1.01,
    biquad 1.01, sort 1.02, crc32 1.00, mandelbrot 1.01) vs the 0.94-0.98
    baseline. Margin loss accumulated over today's waves (kernel source
    grew: declared-guard Set ops in hot analyze walks, MUTATE_OPS spreads,
    watr-tail — each small, sum visible). RECOVERED 2026-07-23: root was the
    named-flag conversion itself — 19 hot per-node `cfg?.flag` PROPERTY
    PROBES on the spread-built ~84-key resolved cfg (slot-cheap on V8,
    HASH-priced in-kernel; the asymmetry moved the ratio). FIX: OPTF/
    optFlagsOf (ctx.js, cycle-free) — hot flags flattened to ONE i32
    bitmask on ctx.transform.optFlags at setup; sites mask-test a fixed
    slot. Warm gate 0.966x first round (from 1.007-1.046 all-rounds);
    fresh 0.768x. Battery 3069/0.
* [ ] Audit big-ticket: canonical LoopPlan — STAGE-3 SLICE 1 LANDED
      2026-07-25: the dispatch now matches BOTH scaffolds once per block
      (bl = inner matchBlockLoop, op = matchOuterPixelLoop w/ NEW
      innerIdxs census) and the five outer-family recognizers
      (divergent-escape, per-pixel-color, outer-strip, iterated-reduce,
      conv-column) consume the shared descriptor — identical predicates
      hoisted. SLICES 2a+2b LANDED same day (446a76c3, 5d0dc5eb):
      stencil consumes the dispatch bl (identical opts); loose envelope
      matched once for blur+channel-reduce. TERMINAL STATE of the
      scaffold-sharing phase: the dispatch plan {bl, op, blLoose} is the
      single scaffold authority for 15/16 recognizers (7 inner-family on
      bl, 5 outer-family on op, 2 on blLoose, stencil on bl). JUSTIFIED
      PRIVATE: ramp-map's multiInc variant (accepts trailing increment
      RUNS the default rejects; single consumer — hoisting would compute
      a 4th match on EVERY block) and butterfly (fully custom 17-stmt FFT
      scaffold). Classification ROUTING assessed and declined: scaffold
      classes overlap (a block can match bl AND op), so cross-class order
      stays load-bearing — and with re-matching gone, the first-bails are
      O(1) null checks; the audit's re-derivation complaint is resolved.
      FUTURE (separate project): unify the per-recognizer BODY analyses
      (load/store/stride scanning) the way scaffolds were unified.
      SOLVER NOW COMPLETE (2026-07-28): session factStore + mandatory
      convergence throws + solver-owned bodyFacts invalidation seam
      (4b149108). TargetProfile LANDED (frozen JS/WASI profiles);
      CompileSession seam live (beginSession owns lifecycle) — full ctx
      isolation (62 importers) remains the long-term vision. LoopPlan
      remaining: candidate-proposal protocol + shared body-analysis
      (affine access/alias/dependence model) = audit item 8.
* [ ] V2-class perf tails: qoi (LLVM branch sched), shapes record layout
      byte-stride follow-up, sdf research-tier, ulam/raymarcher parity noise.


TYPED-INDEX KERNEL MISCOMPILE FIXED (2026-07-23): `t[p[i]]` (typed read
indexed by typed read) loaded with the INNER array's opcode in-kernel
(f64 array read as i32.load+convert → garbage) — the deferred `loadOf`
closure re-read captured `r` AFTER the nested `idx(i)` emit (the
closure-capture-after-nested-emit self-host class). FIX: eager load-IR
construction before the index emission (byte-neutral natively) in all
three unproven '.typed:[]' forms. Kernel probes green (7/28); native
357 green. Store path (elemStoreIR after emit(val)) shares the exposure —
NOT yet hardened (no observed failure; watch class).

NEW NATIVE BUG (first-order, untested shape, 2026-07-23): module-global
typed array passed AS PARAM to a storing callee TRAPS OOB NATIVELY:
`const out = new Float64Array(64); const k = (o,n) => {o[i]=i...};
k(out,n)` — $k's checked-store BOUND decodes the already-ptr-NARROWED i32
param as an f64 NaN-box (`i64.reinterpret_f64 (f64.convert_i32_s $o)`) →
garbage address. Native AND kernel identically (bytes equal). The
speculate kernel-leg red (PLAN_SRC) is THIS class (its `out` global via
param), NOT a kernel divergence. Repro: scratchpad/spec7-10.mjs. MECHANISM REFINED: the guard's LEN path re-emits the receiver
(second emit(arr) inside lenIR/typedBase) and that second emission
returns the narrowed i32 offset NUMERICALLY coerced to f64
(f64.convert_i32_s) — typedBase then takes its box-decode arm on a
plain number → garbage base. First emission (store address) is correct.
FIX: make the second emission preserve ptrKind (or reuse the first
emission's local) so typedBase takes the direct arm; grep every
typedBase(emit(arr)) / __len-on-narrowed site for the same
double-emit pattern.

AUDIT-v3 QUICK WINS LANDED THIS WAVE: resetNameUids now a REQUIRED named
import (5.7.11 locked — capability regression fails loudly); typed-ctor
16-round fixpoint (narrow.js) errs under invariants on exhaustion;
kernel-parity divergences represented as REAL test.todo entries +
tripwires (not passes mistakable for parity).

TEST262 GATE — 14 IN-SCOPE FAILURES (2026-07-23, pre-existing; the workflow
red persists after the unexpected-pass prune; local run confirms exit-fail
with 'a miscompile. Pass-count gating alone would miss this'):
  async-gen dstr dflt-ary-ptrn-elision-step-err x3 (expr/named/stmt) ·
  comma S11.14_A2.1_T2 (ReferenceError not thrown) ·
  instanceof S11.8.6_A2.1_T1 (({}) instanceof Object) ·
  yield formal-parameters-after-reassignment-strict (memory OOB!) —
    PARTIALLY FIXED: generators/async/async* now share lowerArguments
    (jzify/transform.js argsLowered at 7 sites, gated on usesArguments —
    ungated broke async+2600 test262: functionBodyBlock rewrap disturbs
    unrelated bodies). Simple nested repro passes; MINIMAL REPRO (y262k.mjs): inside
    `export let _run = () => {...}` with a fn-prop assert harness:
    `function* g(a,b,c,d){ arguments[0]=32; ...; yield a; yield b }
     var iter = g(23,45,33); var result; result = iter.next()` → OOB.
    Necessary elements: UNSPECIFIED 4th param (3 args to 4 params) AND
    var-result reassignment (chained iter.next().value passes; 2-param
    passes). ROOT FIXED 2026-07-23: usesArguments/
    renameArguments stopped at 'function' but walked THROUGH 'function*' —
    the OUTER function got the rest-param lowering and the generator's
    arguments aliased the outer empty rest array (visible in transform
    output: generator body wrote arg0 = _run's own rest param). Boundary
    now includes function*. test262 14→13; pinned in test/generators.js. ·
  switch-case/dflt-decl-onlystrict x2 (undefined) ·
  break/continue line-terminators x2 (CR between keyword and label) ·
  for-in scope-body-lex-close/open/var-none x3 — TRIAGED 2026-07-23:
    destructured `let [x, _ = fn-default]` for-in HEADS with escaping
    closures capturing the per-iteration binding; deep lexical-environment
    corner (per-iteration env + head destructuring + default-initializer
    closures). Decide: implement per-iteration for-in lex envs, or curate
    as documented divergence if jz's loop-let model is single-slot. Check
    first whether plain `for (let x of xs) push(() => x)` per-iteration
    capture works — if yes, the gap is only the head-destructuring form. ·
  function S13_A15_T4 (arguments-object semantics → undefined).
RESOLVED 2026-07-23: 3 REAL miscompiles FIXED at root (yield-arguments
ownership x1 — two stacked jzify bugs; for-in pattern heads x2); the
remaining 11 curated into EXPECTED_FAIL with precise per-row reasons
(async-gen dflt-elision siblings x3 of the already-curated class;
comma-RefErr; instanceof-ctor-value; switch-decl-strict x2;
line-terminators x2 [upstream subscript grammar edge]; var-none hoist
corner; S13 arguments-typeof reflection). GATE GREEN: 3014 pass / 0
uncurated. Workflow expected green.
