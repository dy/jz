# jz — TODO

Full working history (hunts, refutations, landing paths, process lessons)
archived in .work/archive-todo-2026-07.md — grep it before re-deriving
anything; every kernel bug class and perf frontier has a banked dissection.

## Status (2026-07-23)

STATUS (re-audit v3 corrected): plan stages 0-5 SUBSTANTIALLY advanced but
NOT complete — open: unified solver (stage 2), LoopPlan (stage 3),
CompileSession/TargetProfile (stage 4), claims enforcement + bench refresh
(stage 5), kernel parity long-tail. Perf: V1 bench wins measured locally
(aggregate jz 1.00× leads every WASM lane: C 1.88× / Rust 1.97× / AS 2.06× /
V8 2.17×; native C 1.11×; strbuild/lz/immutable/glyfparse won). Re-audit
items landed: shared final-optimizer tail (watr-tail.js) + kernel byte-parity
leg · six named O0 flags killing bare optimize-object gates (+ latent
lean-hash O0 fix) · solver caller-ctx copies + throwing convergence caps ·
PR #108 incorporated (snprintf clamp + ASan bench-c leg) · kernel modules-ABI
(finally-scoping fix) · SSO/JSON cluster (reassigned-param val poisoning;
objects/strings/spread cleared from KERNEL_EXCLUDE) · subscript
template-escape fix (local commit) · JSON.parse(undefined) SyntaxError ·
MUTATE_OPS dedup (3 drifted sets fixed) · dyn-keys leg registered.

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
  Standalone jz-compiled watr (module-graph path, watr-diff entry)
  matches node exactly at gate granularity -- but the KERNEL is built
  differently: scripts/build-dist.mjs ESBUILD-BUNDLES src/ + watr
  first, THEN self-compiles the bundle. PRIME SUSPECT: the esbuild-
  transformed watr text (renamed helpers, hoisted scopes) compiled by
  jz behaves differently at count() (undercount -> cap passes ->
  select fires; a .length/recursion miscompile class on the bundled
  form only). NEXT LEG (decisive): extract the bundled watr's count/
  select-rule region from the esbuild bundle (build-dist writes it --
  check for an intermediate artifact or add a flag to keep it), run
  the SAME gate-counter differential on THE BUNDLED FORM node-vs-
  jz-wasm; a count() divergence there names the miscompile. ALSO
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
  * kernel-parity TODO rows (dict|2, dict|3, sum|3, arr|3): in-kernel
    vectorizer/unroller bails where native fires (O3 output smaller).
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
      (load/store/stride scanning) the way scaffolds were unified. Solver stage-2 slices
      landed: lazy fact store (plan() owns freshness), convergence
      advisories in production. CompileSession + TargetProfile (59 ctx
      importers) still open.
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
