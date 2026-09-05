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
  was dropped. The current reserve still rounds capacity to a power of two;
  count-first allocation avoids intermediate growth, not the final rounding.
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

### Next ownership and order

1. Integration/result-contract session owns summary, representation, emitter,
   and combined-tree certification. Repair the bootstrap unsigned-shift
   rejection and the five value defects through producer/callable contracts;
   keep the private fresh gate. Do not add source-spelling exceptions.
2. Optimizer session owns watr, transport allocation evidence, and coordinated
   dependency release. Supply committed shared changes and an explicit handoff;
   keep shared summary/representation edits serial. Agree on the effect/opcode
   interface before introducing semantic FunctionIR.
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
