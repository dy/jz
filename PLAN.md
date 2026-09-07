# JZ core plan

## Decision

JZ compiles good-parts JS to fast, small, safe wasm. One program analysis owns separate domains for semantic kinds, payloads, presence, representation, ranges, effects, and escape. A typed function carries static kinds with no boxing; a function that needs the tagged `any` kind is boxed and calls a runtime written in jz. The tier of every function is decided by rule and reported, never guessed per value. Memory is regions with a deterministic release, no collector. Divergence from JS is rejected or reported at compile time, never silent.

There is one compiler, `src/`, and it is rebuilt in place. Each step below replaces one subsystem with its canonical form and deletes what it replaced, gated by the test corpus, the bench rows and the reachability probe. A step that keeps the old path "for now" is not done. No second compiler, no `core/`, no frozen `src/`. The compact prototype (retired 2026-09-02, `c7616d6e~1`) is the seed for the representation, not for a second lowering: numeric ids, parallel typed arrays, per-function scratch, no shared compile state.

## The pipeline

1. **Front and expansion**: parse → normalize → validate all source → conservative ProgramIndex → structural expansion to closure. Normalized nodes are immutable; rewrites produce new nodes with explicit identity/provenance mapping. ProgramIndex owns callable identities and the graph. Specializations have canonical keys, deduplication, and a finite budget; an exhausted budget keeps a correct general operation or rejects.
2. **Summary and freeze**: provisional analysis can guide expansion. After variants, closures, dispatchers, and wrappers close, solve the final summaries by SCC. Freeze identities, signatures, representations, tiers, ABIs, and runtime demands. SummarySolution readers cannot bind parameters, merge mutable cells, escape values, or invoke the solver. Semantic kind never substitutes for physical representation or presence.
3. **Lower**: normalized program → verified FunctionIR, one function at a time, scratch only. Values have explicit definitions, representations, source provenance, and effects. Checked loads, typed field access, coercions, box/unbox, and region operations remain semantic instructions until their consumers have run. Reusing a value cannot reevaluate its producer. Structured control flow preserves normal and abrupt completion.
4. **Optimize**: one shared optimizer, implemented in watr (`~/projects/watr`) and used by JZ. Range, LICM, CSE, kind unswitch, and vectorize consume explicit IR facts under one scheduler. JZ supplies language-specific semantics, representation contracts, and lowering; generic passes and their shared IR/effect machinery belong in watr. Recognizers use canonical IR classes rather than recovering erased meaning from WAT shapes.
5. **Emit**: lower verified functions to disposable Wasm fragments, assemble sections and reachable runtime, then use watr for optimization, validation, and encoding. There is no JZ replacement for watr's optimizer and no second generic optimizer around it.
6. **Runtime**: jz source (`src/std`), compiled by the same pipeline and linked by reachability. Keep a small explicit intrinsic set for operations the source language cannot express. Retire WAT-template implementations family by family.

State: a persistent Program and immutable SummarySolution, plus disposable function scratch. Passes receive the inputs they own; no ambient `ctx` or singleton tape is added. The current WAT transport tape is not FunctionIR. Verify FunctionIR before encoding; debug builds also verify after each pass. The verifier checks types, representation joins, control flow, and effect/region rules. The tier report names each function's tier and the site that decided it.

## Next milestone: a verified result contract

This sequence takes priority over further class features and the remaining work
listed in step 3. It replaces result reasoning inside the existing compiler.
There is no second backend or permanent fallback.

1. **Make validation trustworthy.** A failed fresh self-build must prevent use
   of an older artifact. Pin query-order and compile-reuse tests, including
   A → A and A → different B against fresh instances, and copy retained outputs
   before reset. Replace self-confirming reachability evidence with independent
   semantic cases and mutations that remove a required root or edge.
2. **Separate summary solving from reading.** Move query answers onto the
   settled solution; delete query calls into transfer/mutation routines. Use
   ProgramIndex identities for persistent callable facts. Preserve existing
   identity-linked metadata until each consumer moves. Test that queries in
   different orders leave facts, subsequent answers, and emitted bytes unchanged.
   This is the first compiler slice, before changing more carrier rules.
3. **Replace result reconstruction.** Give each producer and callable one
   explicit result contract. Number, Boolean, BigInt, and undefined must survive
   direct/closure calls, checked reads, storage, joins, and returns. Conversions
   are explicit at the edge. Delete the covered return-expression rewalks,
   method-name carrier guesses, and deferred boxing thunks in the same slices.
   A new record above the existing priority chain does not complete this work.
4. **Keep those contracts through lowering.** Build the smallest FunctionIR
   needed by the result corpus, with explicit value definitions and effects.
   Its Wasm projection uses the existing optimizer path during migration; there
   is one production lowering. Retire the covered WAT-array builders as semantic
   instructions replace them. Define the opcode/effect interface with watr so
   the shared optimizer consumes those facts without another classifier.

Exit evidence includes the five failures pinned at `894764cd`: member BigInt
update results, absent BigInt indices, Boolean/Number array carriers, optional
BigInt-array reduce with a Number accumulator, and watr memory64 limits. Add
mixed/error arms, collision-shaped i64 payloads, bare return/fallthrough, and
single-evaluation checks to the same semantic classes. Do not special-case their
source spellings. Full matrix and fresh functional bootstrap must pass before
this milestone is complete; existing red checkpoints are not a new baseline.

### Reviewed pre-merge slice (not milestone completion)

- Self-build gates now use a private fresh output, retain its bytes, and keep
  failures sticky, including directory setup and cleanup failures. Bytes publish
  only after cleanup succeeds. They never read `dist/jz.wasm`. Fourteen harness
  tests (73 assertions) cover stale output, nonzero/signalled exits, missing/
  invalid output, an empty valid module, final-byte write boundaries, cleanup,
  and reuse. A real child confirmed Node can return status 0 with ETIMEDOUT
  after handling SIGTERM with exit(0). The helper and both artifact consumers
  now reject subprocess errors/signals independently of status. Three direct
  regressions failed before that correction and pass after it. The kernel reuse
  pin caught a further retry after a failed load: build/read/validation failures
  now stay failed even when a valid artifact appears. A tiny fixture compiler
  proves empty → empty → A → A → B → program error → A, exact retained outputs,
  one artifact read, and fresh instances; this is not bootstrap evidence.
  Standalone correctness and performance processes each build once; neither
  trusts the other's disk artifact. Retained hosted outputs are copied
  before arena reset. Artifact consumers such as `test/kernel-target.js` and
  `scripts/bench-self-compile.mjs` still intentionally use disk artifacts; this
  helper does not turn those consumers into fresh-source gates.
- `summary/index.js` owns solving; `summary/query.js` owns readers;
  `summary/kind.js` owns the shared scalar lattice/rules. Deleted the reader
  calls into `call`, `reduceResult`, and `merge`, the query-time union-find
  compression, and the reader's mutation of the solver's current scope.
  Schema/method/import metadata is captured once for the provisional and final
  readers rather than copied twice or read through a later compile's registry.
  Callable-ID migration and final structural closure/freeze remain open; this
  is not yet the complete immutable SummarySolution.
- Seven query tests (51 assertions) pin parameter/array-cell/closure mutation,
  query order, empty/nullish/missing inputs, scope isolation, retained schema/
  method/import metadata, and A → A → B followed by empty/error compiles → A.
  B-after-A bytes match a fresh process; retained outputs execute. The bounded
  review passes 21 query/harness tests (124 assertions), and the combined summary
  selection passes opt0/opt3 (38 tests/9,455 assertions each) and WASI (38/9,460).
  Kernel parity (3/39), minimal-output (98/412), differential, determinism, and
  the op-count ratchet passed before this cache-only follow-up. No compiler
  passes or emitted-code paths changed in the follow-up.
- The last completed native run, before the reader extraction, had 4,027 tests:
  4,021 pass, five existing failures, one skip. The subsequent matrix attempt
  timed out after 1,200 seconds in native pow-fold tests; the post-extraction
  `npm test` timed out after 1,200 seconds at the third assertion of
  `iterator helpers: spec callbacks and terminals` (`g().take(-1)` inside
  try/catch, `test/generators.js`). The generator file passes standalone (26/60),
  so warm-suite behavior remains an open gate. The bounded review's `npm test`
  passed that generator case and reproduced all five checkpoint failures, then
  hit its 360-second limit in the pow-fold tests.
  No complete current matrix is certified. The five checkpoint defects remain.
- Fresh self-build still rejects `id >>> 5`; all 23 dependent correctness tests
  now fail rather than validating the old artifact, including on the bounded
  review rerun. Hosted reuse now keeps the immediate A → A → B → A transition
  before empty → bare-return → A, with `_clear` after each compile. Those
  retained-output assertions remain blocked behind the build; their five
  source/expectation pairs pass under JS and native JZ O0. Self-performance is not certified. Disk artifact SHA-256 is
  unchanged; the review left no private build directories or scratch logs.
- Diagnostic compile-budget comparison against `e62d7361`: Jessie remains
  115,152 B and watr 371,636 B. Before/after median ms and peak MB were
  8,789.4/464 → 3,464.0/461 and 14,455.1/1,046 → 14,308.9/775 respectively.
  Other compiler processes were active: these are not stable timing baselines
  or speedup claims. After removing the duplicate metadata copy, the slice adds
  62 production lines (117,161 total).

## Reconciliation checkpoint — 2026-09-05

- `c9cee767` preserves the reviewed query/fresh-build work. Merge `5113d8bd`
  brings all eight `summary-locals` commits through `6a1b37be` into main.
  Another session finalized the merge while the combined tree was under test;
  the follow-up completes the read-only query relocation and dependency setup.
  `classCallee` is in `summary/query.js`; receiver-family count rules are shared
  by solver and reader in `summary/kind.js`. Main's spread propagation, HASH
  fallback exclusion, result repairs, and both branches' regressions survive.
- The clean `s3-wt` is the merged branch. `head-wt` is an ancestor; `slice-wt`
  holds older versions of the same work, including the superseded late-link
  copies. Neither is another patch set to apply. The compact branch and old
  `origin-local/main` are already ancestors. Worktrees and their scratch are
  left intact, including other sessions' running gates.
- Integrated: summary-backed locals/slots and literal allocation facts;
  class devirtualization/factory inlining; read-before-store ordering;
  transport reserve/exact encode with repeated-encode ownership tests; heap
  stage diagnostics; the optimizer tail's tape passes. The consuming decode
  was dropped. At this reconciliation checkpoint the reserve still rounded
  capacity to a power of two. The reviewed integration below replaces that
  final rounding; the original count-first change avoided intermediate growth.
- The late link and its duplicate vacuum/block-merge implementations are gone.
  Their useful generic effects are in watr: numeric-local CSE (`b53c92c`), final
  local ordering (`a137283`), and `memory.size` read semantics (`5ff0037`).
  Remaining generic JZ passes are still migration work, not another optimizer
  to extend. Keep local folds before devirtualization until the recorded 4x
  dispatch scheduling regression is closed. Branch measurements, including
  the five small size increases, remain in `.work/optimizer-evidence.md`;
  they are not combined-tree speed/size certification.
- **Local dependency, not a release:** npm has no `watr@5.11.0`. This checkpoint
  explicitly consumes `file:../watr` at `5ff0037d4dd5d38d6779a7c1965e581f1870adc5`.
  `.npmrc` installs a copy rather than a symlink so self-build graph paths stay
  canonical. The lockfile agrees; no generated artifacts or dependency-only
  source patches are committed. Publishing/consuming a real registry release
  and removing this local dependency are required before JZ distribution.
  No push or publish was performed.

### Combined-tree evidence

- Native focused selection: **711 tests / 21,976 assertions pass** (`summary`,
  `summary-queries`, `self-build`, `tape`, `classes`, `iteration`, `objects`,
  `dyn-keys`, `minimal-output`, `differential`, `determinism`, `perf-ratchet`,
  `optimizer`, `wat-invariants`). The first eight selections also pass at opt0
  (327 / 10,379), opt3 (327 / 10,380), and WASI (327 / 10,334).
- `data statements watr self-compile-source`: **464 tests, 459 pass, five fail**
  (2,151 assertions): exactly the five result-carrier defects listed above.
  Source guards pass across 291 compiler files. Disk-kernel parity additionally
  differs on `dict` at O2/O3 (49/13 WAT characters); the selected artifact is old,
  so this is not an attribution to a fresh hosted compiler.
- `npm test` and `npm run test:matrix` each reached their 420-second review limit,
  in in-place replacement and recursive-boolean tests respectively. The matrix
  did not finish its native leg. No complete matrix is certified. Concurrent
  gates in other worktrees were left alone; no timing claims follow these runs.
- `npm run test:self`: **23 failures**, all behind fresh build rejection of
  `id >>> 5` (`id…f5173_2`). Performance, hosted reuse, recursive compilation,
  and the heap diagnostics remain uncertified. `dist/jz.wasm` is unchanged.
- watr at `5ff0037`: unit suite **349 pass / 2 skip**, spec suite **268 pass /
  20 skip**, using `node --experimental-wasm-exnref test` and the same flag for
  `test/testsuite.js`. The flag is not accepted through `NODE_OPTIONS` here.
- JZ production LOC: **117,569**, +408 from the reviewed pre-merge tree (count
  lines including unterminated final lines). watr's production optimizer adds
  61 lines versus published 5.10.1, including the earlier CSE change; tests and
  docs are additional maintained work. Consolidation is not yet a net deletion.

### Bootstrap contract review — 2026-09-05

The unsigned-shift build rejection and two startup carrier faults are repaired;
this is not yet a green bootstrap or result-contract milestone.

- Captured Map values proven Number/nullish no longer acquire a BigInt domain
  merely from tagged storage. `test/unsigned.js` covers both unsigned-shift
  operands, unary plus/complement/double-complement, AND and left shift; missing
  and repeated keys, null, undefined, -0, fractions, subnormal Numbers, uint32
  max, NaN and Infinity; one producer evaluation; and genuine BigInt rejection.
  The normalized postfix BigInt control prevents overriding explicit producer
  semantics with the synthetic Number 1 in the current normalization.
- The start plan now covers imported initializers and the entry AST together,
  without cloning expression nodes. This replaces typed storage's separate
  `extraBodies` path. `test/imports.js` pins unary/raw-slot call edges at O0–O3,
  both halves of collision-shaped payloads, true→true→error→true calls, and
  A→A→B→empty→error→A compiles. The latter also includes an empty imported module,
  a typed field read, initializer trace 1234 (dependency/operand/callee/entry),
  retained instances and executable retained bytes.
- Slot read representation follows both storage and read-side unboxing. The
  review caught mixed refined schemas incorrectly satisfying per-arm raw OR
  unboxed: a merged read must unbox all arms or none. `test/slot-hazards.js`
  isolates that contract, including unknown/missing schemas. Static bracket
  reads now share dot-access kind facts and slot lowering; the duplicate plain
  load was deleted. Tests cover raw collision payloads through brackets and a
  uniformly boxed slot with explicit writer/unbox precondition assertions.
- Final focused native: **156 tests / 1,509 assertions pass** (`imports unsigned
  slot-hazards`); WASI: **156 / 1,495**. Opt3 plus `objects dyn-keys pointers
  array-methods summary-queries self-compile-source`: **615 / 2,832 pass**.
  Source guards cover 291 compiler files. An earlier opt0 selection including
  minimal-output, determinism and the op-count ratchet passed 571 / 2,748 before
  the bracket sibling repair; it is not a final whole-matrix result.
- `data statements watr inference`: **604 tests, 598 pass / six fail** (2,473
  assertions): the five existing carrier defects plus the receiver-HASH
  no-computed-write expectation. The latter also fails with unmodified
  `18aab52a` production sources. Final `npm test` reached its 420-second review
  limit in cursor-versioning tests after reproducing the first four carrier
  defects. No full matrix is certified.
- Private fresh `npm run test:self`: **17 pass / six fail**, 61 assertions.
  Remaining failures: L2 inliner BigInt mixing; SIMD output execution OOB;
  eq-zero native/hosted byte parity; warm charCodeAt bytes after clear;
  bare-return bytes after A→A→B→A→empty; and Map/property output execution OOB
  without clear. Performance does not run after the failing correctness leg.
- Eighty valid numeric corpus outputs (`perf-corpus.mjs`, all ten categories,
  seeds 1/2, O0/O1/O2/O3) are byte-identical to `18aab52a`. This bounds unaffected
  output size/runtime, not whole-compiler speed or the cost of required boxes
  at previously incorrect edges. No timing claim. `dist/jz.wasm` is unchanged;
  owned bootstrap/review scratch and diagnostic artifacts were removed.
- Recursive OOM remains separate: the other session attributes it to plan after
  `refineSlotIntCensus`, with two summary runs allocating about 2.5 GB before
  emit/link/watr are reached. This review does not recertify recursive memory.

### Bitwise write normalization — 2026-09-05

A bounded follow-up to `03cf346d`; the six hosted failures remain open.

- Prepare now rewrites bare-binding `&=`, `|=`, `^=`, `<<=`, `>>=` and `>>>=`
  into ordinary binary expressions and assignments **before** summary and
  representation planning. The separate bitwise compound emitter was deleted;
  member assignments retain their existing lowering. Arithmetic compounds and
  updates are not migrated by this slice. No numeric-readiness widening or
  dependency/source workaround was added. Through the grouping checkpoint below,
  production source was net **−12 lines**; the shift follow-up is recorded separately.
- Five checked-BigInt producer/compound/typed-store regressions failed before
  the repair and pass at O0–O3. Tests include canonical and collision-shaped
  payloads, Number/BigInt alternation, repeated calls, negative shift counts,
  retained outputs, and exact producer/RHS counts. Further pins cover reading
  the old value before an RHS closure writes it, the assignment's result value,
  mismatch TypeErrors and recovery, and zero-iteration unsigned loops.
- The unsigned-loop pin exposed a second defect in the retired emitter:
  `f(1, -1)` for `for (let i=0; i<n; i++) value >>>= i` returned −1 instead
  of 4294967295. The only WAT change is signed→unsigned i32-to-f64 widening.
- Pre-review native `unsigned imports slot-hazards`: **164 / 2,249 pass**; WASI:
  **164 / 2,235 pass**. Opt0 plus `summary-queries objects dyn-keys pointers
  self-compile-source minimal-output perf-ratchet determinism`: **580 / 3,624
  pass**. Opt3 plus `objects dyn-keys pointers array-methods summary-queries
  self-compile-source`: **623 / 3,572 pass**. These are selections, not a full
  matrix certificate. `npm test` hit its 420-second limit during Float64Array
  fuzzing; its owned process group was terminated and waited for.
- `data statements inference`: **562/567 pass**, retaining the four value
  failures and receiver-HASH expectation. `watr`: **36/38 pass**, retaining
  memory64 and a newly pinned NaN-payload failure. Both watr failures also occur
  with `03cf346d` production sources, loaded without changing the checkout.
- Fresh private `npm run test:self`: still **17/23 pass**, 61 assertions;
  performance is skipped. A fresh diagnostic compiler emits the same bare-return
  WAT as native (`f64.const nan:0x7FF8000200000000`), but encodes BigInt box-pointer
  bits rather than the payload. In the full watr graph, `f64`'s reassigned
  `value` binding has an ANY summary and a Boolean-capable semantic domain:
  its NaN-branch join materializes, but binding materialization is vetoed.
  Normalizing compounds repairs the closed reduced kernel, not this open
  carrier contract. Do not remove the Boolean guard without a proof covering
  all producers and consumers; do not assume an ANY input is numeric.
- Cost probe against `03cf346d`: **124 valid rows**. The existing 80-row numeric
  corpus and 20 signed-bitwise loop rows are byte-identical. Four unsigned-loop
  rows change the widening opcode with unchanged sizes (157/157/144/145 B at
  O0/O1/O2/O3). Twenty previously incorrect checked-BigInt rows grow **121–260 B**
  for normalization and checking; this is correctness cost, not a speed win.
  No timing or recursive-memory claim. `dist/jz.wasm` and sibling watr remain
  unchanged; owned diagnostic builds, probes and logs were removed.

### Grouped-reference review — 2026-09-05

The bounded bitwise repair stays; the wider compound/result contract is **not
closed**. The earlier selections above predate the additional regression pins.

- `((value)) |= rhs()` bypassed the prepare handler's bare-name check and kept
  corrupting checked BigInt payloads at every level. Five grouped operator pins
  failed before the repair. Prepare now shares one pure, iterative `ungroup`
  helper between write validation, bitwise normalization, and the existing
  sole-comma-argument handling; it neither clones nor mutates operand ASTs.
- The sibling validation path also accepted `const value=1; ((value)) += 1`
  without an error. Every mutating form now checks the ungrouped reference.
  Tests cover grouped const writes/updates, readonly `Math.sin` aliases, writable
  shadowing locals, and invalid assignment targets in dead source. Arithmetic
  compounds still retain their original lowering; this is reference validation,
  not a new representation fallback.
- Expanded JS-oracle tests cover old-LHS capture, assignment results, abrupt RHS
  effects without the final write, zero/empty/OOB/negative-index/null operands,
  repeated calls and recovery, and receiver→key→RHS order for dot, computed and
  grouped members. All five bitwise BigInt operations run both bare and grouped,
  with canonical/collision payloads and retained bytes. Native compile reuse is
  pinned as empty→empty→A→A→B→error→A, including fresh-process B comparison and
  execution of both retained instances and retained bytes. This is not hosted
  reuse certification. The former “throws before writing” test was relabeled:
  it had observed only the exception and next call, not the local write.
- **Twelve new arithmetic pins remain red:** ten bare/grouped checked-producer
  cases for `+=`, `-=`, `*=`, `/=`, `%=`; one mixed Number/BigInt case; one
  null/absent checked-operand case. They fail with `03cf346d` production too.
  An attempted extension of early normalization to arithmetic repaired these,
  but broke existing string accumulation (`1-2` became `1NaN2`) and the strided
  outer-loop/cursor-versioning optimizations. `strings optimizer perf` was
  **434/434** on baseline and **431/434** on that candidate. The extension and
  its helper deletions were completely reverted, not hidden behind a type gate.
  Those existing string/optimizer checks pass again in the final selections.
- Two further red pins in `test/data.js` use **ordinary binary/plain writes**:
  open nullish arithmetic returns null/undefined instead of Number 0/NaN, and
  caught mixed BigInt arithmetic loses the catch flag/pre-write value. At O0,
  the latter's Number call yields `[0,1,false]`, not `[1,1,true]`. These also
  fail on `03cf346d`; the broader open-parameter/catch contracts need repair.
  They are not claimed fixed by bitwise normalization.
- Final selection, run on native/opt0/opt3/WASI:
  `unsigned imports slot-hazards objects dyn-keys pointers array-methods strings
  summary-queries self-compile-source minimal-output perf-ratchet determinism
  optimizer perf`. Native **1,183/1,195**, 10,808 assertions; opt0
  **1,183/1,195**, 10,768; opt3 **1,183/1,195**, 10,812; WASI
  **1,182/1,194**, 10,311. Each has exactly the twelve arithmetic reds above.
  `data statements inference watr`: **598/607**, 2,480 assertions, including
  the two new ordinary-write failures and the seven pre-existing failures.
  A loader-baseline run of the expanded `unsigned data` pins was **261/295**;
  it independently reproduced the new red families as well as the repaired
  grouping/bitwise cases. No main-tree or dependency checkout was substituted.
- Final `npm test` reached Float64Array pure-map fuzzing, then hit the owned
  **420-second limit**; its process group was terminated and waited for.
  Fresh private `npm run test:self` remains **17/23**, 61 assertions, with the
  same six hosted failures and the performance leg skipped by `&&`. Full matrix,
  conformance, recursive memory, and timing leadership remain uncertified.
- Updated cost probe: **168/168 binaries validate** against the same `03cf346d`
  production baseline. **120 are byte-identical** (80 corpus rows plus 40
  signed-bitwise loops); eight unsigned-loop rows correct the widening opcode
  at unchanged sizes **157/157/144/145 B**. Forty checked-BigInt rows grow
  **121–260 B**, exactly the previous per-operation costs now also covering
  grouping. All **44 bare/grouped output pairs are byte-identical** after the
  fix. No timing or heap-saving claim: validations ran concurrently at points.
  Only the three original production files, tests, and this evidence changed;
  no optimizer-agent work, sibling watr changes, or generated output is retained.
  Owned review probes/logs and private diagnostic artifacts were removed.

### Shift contract follow-up — 2026-09-05

The follow-up review found two defects in the shared language-specific shift
lowering, not in generic optimization. Arithmetic normalization remains reverted.

- `bigIntShiftIR` used wasm's modulo-64 count after reversing negative counts.
  Thus `1n << 64n` and `1n >> 64n`, observed through BigInt64Array storage,
  both returned 1n rather than 0n. It also evaluated the RHS before reading the
  left value: `let value=6n; ((value)) <<= (value=99n,1n)` returned 198 rather
  than 12; the corresponding right shift returned 49 rather than 3.
- The helper now captures both numeric operands once in source order. Far left
  shifts produce the wrapped i64 value zero; far right shifts sign-extend using
  count 63. Unsigned magnitude comparison handles negation of INT64_MIN without
  mistaking its overflowing absolute value for a small count. Binary and compound
  callers share this helper; no new representation authority or watr pass was added.
- New O0–O3 oracle pins cover zero, ±1, signed i64 extremes, counts 0/±1/±63/±64/±65,
  and extreme counts in the right-shifting direction (avoiding huge allocations
  in the JS oracle). Typed storage supplies the same result truncation in JS.
  Separate binary/compound pins cover old-left-value capture and repeated calls.
  The existing null/absent error matrix now includes count 64, so a zero result
  cannot bypass the TypeError/RHS-count checks. Only successful oracle results
  there are wrapped with `BigInt.asIntN(64, ...)`, matching the documented width.
- Grouping sibling tests now pin logical short circuits, RHS mutation/throws,
  local and module consts, zero-argument calls, and nested sole-comma arguments.
  Native reuse adds an empty compile after B and truncates A immediately before
  its final `}` before compiling complete A again. Empty output bytes are compared
  before and after other work. This tests the whole-source compile API, not a
  streaming decoder or hosted reuse.
- **Two additional carrier pins remain red**, before and after the shift helper:
  a captured RHS returning 1n gives `[0,1]` instead of `[12,1]` after a left shift;
  comma BigInt operands give `[0,12]` rather than `[12,12]`. The latter's old trace
  was 21, now correctly 12, but its payload remains wrong. These are in `test/data.js`;
  neither the count guard nor early compound normalization closes the general
  producer/consumer carrier contract. The twelve arithmetic pins, two earlier
  ordinary-write pins, and established value/encoding failures remain red too.
- Final focused command: `node test/index.js unsigned imports slot-hazards
  statements dyn-keys strings summary-queries self-compile-source minimal-output
  perf-ratchet determinism optimizer perf`. Native **1,010/1,023**, 11,167 assertions;
  opt0 **1,010/1,023**, 11,128; opt3 **1,010/1,023**, 11,171; WASI **1,009/1,022**,
  10,704. All four retain exactly the twelve arithmetic reds and the existing
  homogeneous BigInt update/read failure. `data watr`: **255/264**, 1,692 assertions.
  With only `bigint.js` restored through a loader, `data` is **219/226**, 1,576
  assertions, reproducing both new carrier failures. Before-helper `unsigned` is
  **60/76**, 3,799 assertions: the two boundary tests, old-left capture and extended
  count-64 presence test fail in addition to the twelve arithmetic pins. No checkout
  was substituted.
- Fresh private `npm run test:self`: **17/23**, 61 assertions, the same six failures;
  performance is skipped by `&&`. Final `npm test` hit its owned **600-second**
  limit at the strbuild sanitizer check after 4,068 test headings. It recorded
  the 23 tracked/pinned failures plus the two stale-disk dict O2/O3 parity failures;
  it has no completed-suite total and is not a pass. An earlier 420-second attempt
  stopped in Float64Array fuzzing. Owned process groups were terminated and waited
  for; no full matrix, recursive, conformance, or timing certificate is claimed.
- Incremental shift cost comparison keeps all other dirty source fixed and loads
  `03cf346d`'s `bigint.js` for the before side: **176 valid binaries per side**.
  The 80 numeric corpus rows (ten categories, seeds 1/2, four levels) remain
  byte-identical. The 96 shift rows use the typed-storage fixture with both
  binary/compound writes, both directions, and counts `BigInt(count)`, ±7n, ±64n,
  0n at four levels. Their size deltas are **−65 to +3 B**, net **−484 B**; 24
  changed binaries retain their size. All **48 binary/compound pairs are identical**
  after the fix. Six input pairs per shift row give **576/576** JS-oracle matches,
  versus 184 mismatches before. This is output-size/correctness evidence, not a
  speed or memory claim; validations overlapped at points.
- This follow-up changes one additional production helper; the complete dirty
  production delta is now **−15 lines**, not an all-in LOC recount. Optimizer-agent
  work, watr, dependencies and generated output remain untouched. Owned review
  scratch (27 files, 9,212,654 B) and the sanitizer test's temporary executable
  (53,512 B) were removed; no unrelated scratch or processes were touched.

### Final reference review and optimizer integration — 2026-09-05

The possibly-throwing member-reference probe exposed duplicate receiver/key
calls (`12123`, not JS's `123`). Early staging fixed that trace and needed
expression-closure/default-parameter declaration ownership, but regressed an
existing `.subarray()` test at O2 (7 instead of 8). **All new production staging
and scope changes were reverted.** The tests retain 23 member-reference red
pins and four independent result/catch/absence pins. No arithmetic migration
or materialization-readiness widening was retained.

The frozen optimizer candidate `44309407` on `03cf346d` was audited, not merged
wholesale. Integrated B-only key construction (`c8f3589f`), counted transport and
shared watr cleanup (`5c4b6292`), and repaired diagnostics (`01cb3e5c`). Excluded
the Porffor/Web Audio/dependency/benchmark refresh. Full review and reproducible
fact-graph evidence: [.work/optimizer-review/README.md](.work/optimizer-review/README.md).

The review registered two tests omitted from the runner, replaced a lossy fact
comparison with identity-preserving full graphs (27/27 equal, output hashes
also equal), fixed fractional/NaN capacities and read indices, made capacity
changes start a new recording, and rejected stale diagnostic APIs explicitly.
O0–O3 first/repeated recording and reading allocate nothing in the tested
recorder; ordinary globals still reset. The full internal checkpoint path
remains **unproven**; `_clear()` alone is not its certificate.

Combined working-tree validation: focused native **421/421**, opt0 and opt3
**672/672**, WASI selector **671/671**. Fresh private self is **20/26**, the same
six failures; performance is skipped. The final matrix command completes its
native leg with **4104 pass / 52 fail / 1 skip**, 44698 assertions, then skips
its remaining full legs because native failed. Those 52 are the 50 source pins
(23 earlier + 27 newly exposed) and two stale-disk dict parity failures; no new
failing test name appears relative to the pre-integration selections. Test262
remains **9 language failures / 21 negative accepts / 4 builtin failures**, with
one unexpected pass in each runner. This is not milestone certification.

Agent memory figures labeled MB were MiB: B's frozen-lineage failure heap is
3974317824 → 3282419688 bytes, saving **691898136 bytes (659.845 MiB)** before
the same `emitFuncs` TypeError. ABI publication is not completed emission and
later-stage memory is not proven. Key characters are not cache heap bytes.
The reviewer transport/cleanup comparison has 100 valid binaries per side,
80 identical, 20 smaller by 3–9 bytes (90 bytes net), and 160 scalar JS matches
per side. No timing or recursive-memory claim is made from these runs.

Next isolated agent task: [checkpoint evidence, then a read-only recursive
failure reduction](.work/optimizer-review/next-agent.md). Keep the frozen
candidate intact; a new clean worktree excludes main's eight pending files.

### Sequence/result review — 2026-09-06

The comma repair now forwards **kind, presence, and producer readiness**. The
initial `valTypeOf(last)` rule also forwarded the legacy receiver-oriented
BigInt-or-nullish claim, making nullable sequences miscompile. Settled summary
readers now decide their value kind (without falling back from a deliberate
unknown answer); the existing scoped reader handles the pre-summary phase.
Body readiness and active-carrier reads follow the final producer. This does
not widen ANY/Boolean materialization or add a return-expression reconstruction.

Known BigInt/Boolean `typeof` results evaluate the operand once. Sibling
comparisons use proven primitive kinds instead of inspecting raw payload bits;
`typeof ... === 'object'` admits null but excludes boxed BigInts and other
primitive atoms. No generic optimizer or numeric-demand rule changed.

`test/sequence-values.js`: **43/43**, 5137 assertions; the five-module incremental
baseline is **15/43**. Its fresh-B child inherits the baseline loader through
`NODE_OPTIONS`, removing the earlier mixed-compiler comparison. Exact values,
collision payloads, null/undefined, exceptions, external effects, nested
sequences, direct/scoped consumers, and retained A/A/B/empty/error outputs are
covered. Two independent existing defects are retained as red pins in
`test/data.js`: nullish `BigInt()` inputs accepted as 0n, and local BigInt/Boolean
values losing their kind beside Numbers in heterogeneous arrays.

Final combined-tree native: **4148 pass / 53 fail / 1 skip**, 49840 assertions.
Relative to the preceding sequence checkpoint, the only added failing names
are those two pins. The full matrix still stops after its native failure;
explicit broad selections give opt0/opt3 **1421/1472**, WASI **1421/1470**.
Fresh private self remains **20/26**, the same six failures; performance is
skipped. Test262 remains **9 language failures / 21 negative accepts / 4 builtin
failures**, with the same unexpected pass in each runner. No expectations changed.

The replayable byte/value probe has **156 valid binaries per side**, 84 identical
(including all 80 numerical/general control rows), net **3248 bytes smaller**.
Twelve rows grow: nullable-result ABI +6 bytes, object predicates +22 bytes.
JS observations improve **308 → 396 / 468**, none regress; the remaining 72
mismatches are the pinned mixed-array carrier family, not successful evidence.
No timing, compile-allocation, recursive-memory, or leadership claim is made.
Details and replay: [.work/optimizer-review/sequence-review.md](.work/optimizer-review/sequence-review.md).

The frozen checkpoint candidate `5763b63f` remains unintegrated, as does the
original `44309407` candidate's excluded work. The larger isolated agent
assignment is [campaign-after-checkpoint.md](.work/optimizer-review/campaign-after-checkpoint.md).
Coordinator ownership of the exported-helper numeric-demand/BigInt defect
remains separate; no repair or recursive certification is claimed here.

### BigInt division review — 2026-09-06

`x / 0n` and `x % 0n` throw a catchable, branded RangeError built by the
ordinary constructor (`throwErrorIR`; the reserved numeric code collided with
a user's `throw 214`). Both operands are captured once, `-1n` negates, a
constant nonzero divisor costs nothing. Native **4171 / 53 / 1**, the 53
failing names unchanged; opt0/opt3/WASI selections within that set. Details
and bytes: [.work/optimizer-review/division-review.md](.work/optimizer-review/division-review.md).
The kernel's six hosted failures are repaired in the following commits.

### Integration — 2026-09-06

The pi session's pending sequence, bitwise and division slices are committed
(`925baca3`, `86c888d6`, `67bed3f5`); the frozen campaign candidates and the
sibling watr (`5613521`) are integrated. The kernel's hosted failures had six
root causes, each with a native reduction and a pin: numeric demand beside a
BigInt operand, a nullable boolean taken for boolean (every `if` with a
non-literal condition dropped), a BigInt box test without the NaN test, a
join boxed for a raw binding (every `nan:0x…` constant encoded as a heap
address), a compound update that never materialized, and escaped array
callbacks folding `!== null`. Fresh private self-compile **26/26**; native
**4268 / 45 / 1**; kernel oracle and parity green on a fresh kernel;
functional corpus 12/20 byte-identical with every row's results right;
recursive `jz × jz` now reaches the summary and exhausts the 4 GB arena.
Record: [.work/optimizer-review/integration-2026-09-06.md](.work/optimizer-review/integration-2026-09-06.md).

### Recursive self-compile — 2026-09-06

`jz × jz` completes: **14,195,809 bytes in 61 s, 395 MB of headroom**
(`kernel-gate --gate recursive` GREEN). The summary's rounds allocate
nothing (1.35 GB → 86 MB per run: one argument stack, one refinement stack,
structural facts read once); six engine defects every compiled program paid
are fixed with pins (a closure body boxed every parameter and capture a
nested closure captured, boxed cells were made before an early return, a
dynamic method call built an argument array, `Object.fromEntries` stored
number keys raw, a negative literal index folded on every receiver, a
function's write to a typed global stood as its length for a read before
it); jzify enters a node's builtin scope without a closure and copies only
the spine above a change (front 631 → 456 MB); the kernel checkpoints the
assembled module before link (`assemble` / `linkAssembled` / `tailFacts`:
nothing after assembly reads `ctx`), strings interned and integers packed
in the park. Record:
[.work/optimizer-review/kernel-allocation-2026-09-06.md](.work/optimizer-review/kernel-allocation-2026-09-06.md).
The headroom is the encoder's: watr's `compile` allocates 3.6 GB in the
kernel after the second checkpoint. Then (`00f0c8c7`–`36d58177`): a
compound member write evaluates its receiver and key once (the 23
member-reference pins green), a runtime write of `undefined` to a module
object wins over the literal's value, dynamic loose equality converts a
boolean beside a number, `Number`/`Boolean` as values convert. Native
**4304 pass / 18 fail / 1 skip** at `36d58177` (45 reds at `cd41cc54`); recursive GREEN at 466 MB
of headroom. Then the encoder: watr writes the code section into packed byte
buffers (watr `5a78a13`), and its ByteBuf shape exposed three engine defects
on a receiver of unknown kind, each pinned: a tagged BigInt carrier beside an
operand with no evidence took the i64 path unconditionally (the subtraction
`out.length - at` read a Number's bits as a carrier), `out.length = 0`
resized an array alone and dropped the write on an object, and
`out.push(...bytes)` ran the array builtin over the object's memory instead
of its own `push`. Recursive GREEN: **13,858,907 bytes in 55 s, 1,367 MB of
headroom** (the encoder 3.6 → 2.7 GB after the second checkpoint); native
**4306 pass / 18 fail / 1 skip**; kernel families 37/38; functional 12/20,
the same eight byte divergences. Then watr's flattener works over a work
stack with no copies, an `if`'s bodies flatten in place in source order,
and `cleanup` copies a node only above a change (watr `03e7b70`; the build
profile's one-shot specialization of both is deleted); an array whose
storage ends at the heap top extends in place. Recursive GREEN:
**13,860,120 bytes in 57 s, heap 1,260 MB, 3,035 MB of headroom** (the
encoder 1.0 GB).

### The carrier family — 2026-09-07

Native **4321 pass / 6 fail / 1 skip** (from 18 reds at `36d58177`): a
boolean result reaches an array as itself through a callback, a multi-value
lane and a typed store; a call's BigInt result is read as tagged unless the
callee is a known function proved raw or a builtin; a same-body local
closure's possibly-BigInt result is boxed on both sides (the plan registers
the demand on the closure's body before its plan exists) and a
self-referencing definite-BigInt def materializes tagged; a user `try` stays
live around BigInt operators; watr's `coalesceLocals` no longer joins a catch
handler's first write into a dead slot (`deb62e4`); an `any` parameter the
demand pass denied a number keeps JS semantics through a local copy while
every other unknown `+` side keeps the numeric contract; `BigInt(null)`
throws; `new Array(n)` holds holes, a numeric-fill array keeps its element
claim and canonicalizes a hole to NaN in arithmetic; an absent element read as
an index reads no element; a mixed-domain compound dispatches; every method
call's kind is the summary's; the summary keys closures by body beside the
node and the emit-time loop rewrites copy only above a change (every emitted
function ran four passes over a fresh copy of its body, and the summary
answered ANY for every closure in it); the runtime's ToString formats a boxed
BigInt. Recursive GREEN throughout (heap 1,263 MB); kernel families 37/38;
functional 13/20. The six: a member BigInt update of an array element read
bare (`a[0]++; return a[0]`: the summary's `+1` on an ABSENT-bearing element
admits a Number, so the result lane is generic while the store stayed raw
i64; the result-contract milestone's shape), the complex member `++` result,
the boxed-prefix BigInt boundary, receiver-HASH, fromCharCode above 0xff,
watr memory64.

### The array element is a tagged slot — 2026-09-07

Native **4324 pass / 5 fail / 1 skip**. An array element held two carriers:
a literal or an index write into an array the body census proved all-BigInt
stored the raw i64 (`arrProvenBigintElems`, the literal's own narrow), every
other producer (`push`, `unshift`, `fill`, `map`) boxed through the plan's
storage-write edge, and a read took whichever the census promised. One rule
now: every element slot of a non-typed array is tagged, a BigInt lives there
boxed, the write edge boxes it, and a read (`a[i]`, the value of `a[i] = v`,
an inline callback's element parameter) is unboxed at its i64 consumer
(`readI64MayUnbox`: `isTaggedElemRead`, `isTaggedLocal`). The plan names the
slot's carrier once (`memberStorageRep`) for the read, the write's own value
and the compound's rebuilt binary; an emitter-rebuilt node (`a[k] += v`, an
inline callback body) reaches the plan through `ctx.plans.compoundOf`, which
names a binding, a member reference or a tagged slot: a definite BigInt
result stays raw for the slot's write edge, a mixed one normalizes itself.
Three summary defects surfaced on the way: `withTag` widened any two-tag
union to ANY when a nullish tag joined it (`a[0]++` read `a[0]` as
anything), a callback's surplus arguments escaped the receiver
(`a.map(x => x + 1n)` escaped `a`; jzify desugars every pattern parameter
into a rest parameter, which alone collects the surplus), and `elemKindOf`
was defined twice in the query view with the kind-taking variant winning, so
the callback element hint never fired since `c9cee767` (now `elemKindOf(name)`
and `elemOfKind(kind)`); with the hint live, its body-census fallback claimed
a kind without presence and the kernel folded `slots.every(b => b !== null)`
to true over a null slot (the fallback is gone: the summary is the one
source). The provenance consults the summary for a bracket read as it did
for a dot read. Kernel oracle GREEN; recursive GREEN (13,892,087 bytes, heap
1,264 MB); functional 13/20, the same seven; families 40/48 with the
warm-instance leg, the same eight rows as `e08ade69`. The five: the complex member `++` (a typed element through a
call receiver: `valTypeOf` names no element kind for an expression
receiver), the boxed-prefix BigInt boundary, receiver-HASH, fromCharCode
above 0xff, watr memory64.

### Next ownership and order

1. One session owns main. Next: the five reds above, emit's per-closure
   allocation (675 MB on jz × jz), a rest parameter that never escapes
   reading the argument slots (the encoder's `push(...xs)` takes an array per
   byte, 322 MB), the seven hosted byte divergences (the string-equality
   template's `i32.or(x, 0)` folds under the kernel and not natively: one
   predicate reads differently self-hosted). Regions remain the memory
   model; the allocation audit shrinks what they must reclaim. Keep the
   private fresh gate. Do not add source-spelling exceptions.
2. watr is consumed at `deb62e4`; the local-pass deletion stays isolated until
   its `$f$exp` shape is recovered. Agree on the effect/opcode interface before
   introducing semantic FunctionIR.
3. Complete callable identities and structural closure/freeze, replace covered
   result reconstruction with verified FunctionIR, add independent reachability
   mutations, and reconcile ABI/subset/region specs. Then rerun complete matrix,
   fresh/recursive self, exact test262, and current size/speed/memory budgets.
   The verified-result milestone remains the priority; this merge does not
   complete it.

## Steps

The numbered steps below retain the implementation history and long-term work.
Each replacement slice names its deleted authority and callers. Byte identity
is preferred, not required: attributed output differences need explicit budgets
without weakening release claims. Record compile time and peak memory against
committed baselines; missing baselines are an open gate. Keep kernel, differential,
determinism, size, and performance checks. A zero reachability-probe result is
only a consistency check until the independent tests above exist.

1. **Freeze the ledger.** No benchmark leadership claims or refreshed README numbers without fresh evidence under the stated ABI and input contract. Correctness repairs remain allowed. Historical ratios below describe their recorded revisions, not the current checkpoint.
2. **The transport tape.** Mechanical migration done; semantic FunctionIR remains open. The IR tape (`src/ir/tape.js`) enters the pipeline after the last WAT-array pass: link (`src/link`) decodes the assembled module onto it and encodes it back for watr. The mechanical passes are on the tape with their array versions deleted: treeshake, the custom sections, the throw-runtime prune, the function order, the local-name strip, the constant pool, the arena rewind, the low-word mask fold, the local order. The remaining generic optimizer work moves to watr with its scheduling constraints and tests. Step 4 uses shared IR proofs.
3. **One kind fixpoint, emit onto the tape.** The program summary (`src/summary`) is the fixpoint: one kind per binding, slot and result over the whole program, computed at compile entry. Done: the lattice and the fixpoint; a class declares every field its constructor assigns, so an instance keeps one shape (`jzify/classes.js`); the summary answers the slot's typed constructor and value kind, the kind fact of a parameter's fields, and the pointer kind of a local a typed field read initializes. A class method's loop over a typed field lowers to typed storage (`class Gain`: 27.5 ms → 2.6 ms, the record through a parameter 11.9 → 0.9 ms; the flagship's 5 s render 65 → 25 ms against V8's 3, its size unchanged at 805 KB). The representation follows the summary where a census fell short: a call-site argument's schema, a closure parameter's kind, an array's element schema, a call result's kind, and numeric demand (a binding or slot with a ToNumber read and no other; a demanded parameter of an exported function arrives as f64, the host's ToNumber being the program's own coercion), so an exported `class Gain` is 1,907 B against AssemblyScript's 998 (700 of them the polymorphic typed-array constructor for a host-supplied length, which may also be an array to copy) and a factory's record 1,596 B; a method called through an array of instances (`bench/gainclass`, the ledger's first class row) runs in 76 µs against V8's 214 and AS's 607, at 2,363 B against AS's 1,903. A class at module scope is a schema with identity and functions of the receiver (`jzify/classes.js` lowerStruct, `src/compile/emit/class-dispatch.js`): `class P { x; y; len() }` is 810 B and two slots per instance (5,668 B and a closure per instance before), `bench/gainclass` 1,847 B, the flagship 764 KB; a receiver the summary cannot name calls the member's dispatcher, one function per member. The summary owns the module globals' kinds (`plan/scope.js` moduleGlobalKinds; inferModuleLetTypes, inferModuleGlobalValTypes and refineFieldProvenance deleted): a global is the join of every store, so a declaration's claim yields to a function's store of another kind (`let g = 1` then `g = 'abc'` read `g + 1` as a number before); a parameter read before its reassignment has its arguments' kind (subscript's `cur = s` before `s = expr()`). Numeric demand has a compatible level (a `+` operand, a compare against an unknown, an equality against a number): such an exported parameter arrives as f64 under the guarded ABI's one numeric contract (`spec/boundary.md`), which the tier report will name per function; the examples gallery drops 18 KB per kernel (`times-table` 20,670 → 2,299 B) and the known-shape record 18,335 → 55 B. The summary keys a binding by its function, so a specialized variant has its own kinds, and it runs again after the plan's rewrites, so emission reads the program it lowers. A kind is a set of tags with one parameter (the representation plan reads the set: a parameter never a bigint, never a boolean); two arrays joined share one element cell, so a store through either reaches both, and a join that loses a closure's or an array's identity escapes it. The summary supplies the parameter value channels (`val`, `schemaId`, `typedCtor`, the element facts, the kind set: `narrow/index.js` seedParamKinds; the call-site lattice for them, `infer.js`'s resolvers and the caller value contexts deleted, 1,058 lines) and runs once more before narrowing on the program the plan rewrote. For that it covers the bundled modules' top-level statements, closure sets (two closures joined are called as either: a dispatch table's members bind their arguments, `bench/dispatch` at O0 21,513 → 2,226 B), computed keys on a known shape, arrays used as dictionaries (one kind per literal name beside the elements), nullish narrowing on a guarded path (`if (out) write(out)`, `if (o == null) return`, `o && f(o)`), and the host's reach (a closure behind an export's result or an exported global escapes). A binding declared without a value or an element read past the end is ABSENT, a nullish the program does not mean to read, carried as presence beside the kind (`let x; if (c) x = 1; g(x)` reads `x == null` live in `g`; it folded before); a BigInt parameter's carrier is the representation plan's `paramRawOnly` census, not its kind. The summary supplies the result channels too (`results.js` seedResultKinds: `valResult`, presence, the pointer result ABI; narrowValResults, narrowBoolResults, narrowReturnArrayElems, the passthrough resolvers and inferSchemaId deleted), for which it carries a map's values in a cell like an array's elements and masks a name's kind on a `typeof` guard: `bench/fftplan` 33,316 → 10,049 B (the plan cached in a Map reaches the kernel typed). The reconciled branch adds summary-backed local/slot reads and class-member devirtualization with factory-local substitution, allowing some non-escaping instances to scalarize; its measurements are in `.work/optimizer-evidence.md` and commit `760a3fe6`, not current certification. After the verified-result milestone: a class whose base is another module's (the flagship's nodes extend EventTarget and keep their dynamic shape), then the summary replaces the closed schema unions (`schemaIdSet`, `arrayElemSchemaSet`: a set-valued OBJECT parameter), `analyze/val-types`, `program-facts`, `representation-plan`, `kind/`, `type/`, `infer` consumer by consumer; the five integer-range channels (`constIntExpr`, `intExprRange`, the interval prover's evaluator, `narrowUint32`, `.unsigned`, with narrow's `wasm`, `intConst`, `typedLen`, `arrayLen`, `lenBoundOf`, `arrayElemRange`) become one range domain, which also retires the i32 narrowing of an exported parameter (a host value wraps there today) and proves an element read in bounds. Known open in the summary (each is today's behavior, to be closed with the tier report): a closure read through a receiver of unknown shape does not escape, a store through one poisons the schemas but not the array cells, a module global declared without a value is read only after the host's setup. Emit builds the tape directly from the summary, which deletes the WAT-array helpers (`src/ir/*`), the expando facts (`.type`, `.ptrKind`, `.valKind`, `.unsigned`, `.typedLen`, `.schemaSid`, `.saArr`, `.range`) and the decoder. Gate: the record probes (`{buf: Float32Array, gain}` through a factory, `class Gain { buf; gain; process() }`, `class P { x; y; len() }`) at or under AssemblyScript's bytes and at or above V8's speed, as ledger rows.
4. **One optimizer in watr.** Move JZ's generic optimization responsibilities into watr, deleting JZ copies per slice. Range, LICM, CSE, kind unswitch, and vectorize use explicit IR facts under the shared scheduler. Preserve general recognizers and remove WAT-shape reconstruction. JZ retains language-specific analysis and lowering, not a competing generic pass pipeline. Gate: watr's own tests and JZ's semantic, per-case size/speed, compile-budget, and fresh bootstrap tests.
5. **Runtime in jz.** Each `module/*.js` family becomes jz source with a differential test against JS; twins come from the inliner. Deletes `module/`, the template registry and its two registration dialects. Gate per family: bytes at or under the template family's.
6. **No `ctx`.** Transfer ownership per slice to Program, SummarySolution, or function scratch, and delete each ambient reader/writer. Passing a giant mutable context through every call is not the exit. Gate: two interleaved compiles; peak memory linear in function count.
7. **The charter.** Settle ABI, subset, and lifetime rules before the lowering that relies on them. Preserve supported behavior or reject explicitly; no feature cuts solely to meet LOC. Reconcile BigInt-in-`any`, checked access, and region fallback rules in the specs. Keep the five silent-divergence cases (`==` on object operands, methods and accessor slots in enumeration, code before `super()`, integer-first key order) and the tier report as tracked exits. Fresh functional self-hosting gates compiler milestones; recursive performance and memory remain separate release gates. Neither permits source workarounds for inference defects.

## Numbers to hit

- under 50K production lines including runtime, normalization, interop, and CLI; 35K for the compiler is an internal allocation, not an exemption for the runtime. Count tracked JS/MJS in `src/`, `module/`, `jzify/`, and the repository root, including comments. Exclude tests, examples, benchmarks, dependencies, and build output. At `894764cd`: 117,099 lines under this contract. Moving project-owned code into a dependency or stripping useful comments does not meet the goal. Track watr's maintained-line changes alongside JZ's during shared-optimizer consolidation; relocating duplicate passes is not deletion.
- self-hosted `dist/jz.wasm` under 3 MB; the historical artifact was 14.7 MB. Recursive self-compile must stay well under the wasm32 ceiling; the historical 4.10 GB of 4.29 GB is not a certified result for the current source.
- the record probes at or under AssemblyScript's bytes and at or above V8's speed; remeasure after integration, with the historical measurements retained in step 3
- web-audio-api in its own size class on the typed tier; remeasure after integration rather than carrying forward the historical 805 KB and 8x-slower-than-V8 result
- the bench ledger (`scripts/v1-ledger.mjs`) empty; then 1.0.0

Report a number only under its contract: typed or guarded ABI, typed or boxed function, the input shape it was measured on.

## Working discipline

- The spec answers "is this in the subset". A change that needs more prose than a spec edit is the wrong change.
- A commit is a rule, a runtime function, or a corpus slice, with its tests. Twenty commits a day is a symptom, not a pace.
- Every promised JS semantics has a differential test; every typed-tier behavior has a contract test.
- Contributors enter through the runtime (jz source plus differential tests) and the tier report, not through compiler internals.
- One external review at each step's exit.
- Stop a migration slice that adds another precedence rule without deleting an authority. Split the contract and ownership problem before expanding its exception list.
