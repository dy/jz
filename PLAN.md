# JZ v1

Compile audiojs.dev DSP through JS → Wasm → VST, with the compiler selected
at build time. Release requires correct audio, reproducible installation and
passing conformance, speed, size and memory gates. README owns the public
contract; CONTRIBUTING owns compiler invariants. This file holds the decisions
that shaped the tree, the work left before release and the latest gate reading.

## Decisions

Architecture

- One lowering pipeline: parse → jzify → prepare → summary (a fixpoint solver
  behind a query view) → plan sweeps → narrow → emit → optimize → link. Watr
  owns generic propagation, folding, LICM, local-slot allocation and the final
  optimizer. There is no second IR layer, and no context, vectorizer or
  semantic-IR rewrite is a v1 prerequisite.
- The summary is the authority for shapes: construction identity, side
  properties, bounded shape sets, collection cells, positional rest facts and
  closure properties. Plan passes consume its views (`openSidOfExpr`,
  `spreadSidOfExpr`, `sideKeysOfSid`) and the frame-effects census
  (`writesOuter`, `arenaUnsafe`, `callsUnknown`, transitive callees). No source-plan pass
  keeps a private call or effect analyzer; where the shared evidence is
  silent, the optimization declines.
- Frame effects gate the arena rewind: every escape vetoes it, a loop whose
  iteration lets nothing escape restores the heap pointer per iteration, and
  `whyNotRewind` names each declined candidate. A store into a parameter the
  export boundary types is a number into fixed storage, not a growth; the
  loop to rewind is found by its label, which the peephole walk keeps where
  it copies the loop's node. A render loop with a block per iteration holds
  the memory flat (`test/mem.js`).
- Only a DEFINITE store declares a key in a literal's layout. Static
  enumeration stands down whenever the layout is open; the open-layout for-in
  unrolls the closed keys only when neither the layout nor the keys added at
  the receiver's construction sites contain an array index, since JS
  enumerates integer keys first (a layout's added-key facts are per site: two
  literals of one layout keep their own).
- Class identity survives serialization: `jz:brand` names each class layout
  (`Name#id`) beside `jz:schema`, `jz:fields` and `jz:errcls`, so two classes
  with one field list stay two schemas, and a host object that matches only
  such layouts by keys is ambiguous. A pointer carries the schema id its
  module compiled with, so a module whose schema would bind at another id in
  the memory it joins is rejected at instantiation, before the memory's tables
  change: modules sharing a memory are one compilation or the same module
  again, and their host references live in one table.
- A class is a schema across modules: prepare brings a module's imports in
  ahead of its lowering, so a base class of another module resolves; async
  and generator methods hoist with their kind; `'m' in o` sees members. A
  class keeps its closures only inside a function, under a base the module
  cannot see, or as an expression with statics (`class-generic` says which).
- The summary consumes what the emitter does: `fn.call`/`fn.apply`, a static
  call through its lifted function, an optional call, a call through a nullish
  slot, `Object.defineProperty` as a store, an inlined callback's element
  parameter as the element, a class member on an unknown receiver with the
  family of classes that share it. A method inherited by a family reads its
  fields as slots (`commonSlot`) and calls a member every layout resolves to
  one function directly. `why` and any `warnings` sink report `shape-lost`,
  `class-generic` and `deopt-prop-read`: the census a dynamic library is read
  by (`scripts/why-census.mjs <case>`).
- Warnings are delivered after the pipeline returns, so a warning callback
  may compile again; a compile attempted while the pipeline is active is
  rejected. The compiler context is a singleton by design.
- `E[Symbol.iterator]()` is the iterator over E for every receiver
  (`__it_from`); the protocol lowerings are gated by the program's iterator
  producers, witnessed over every module before any is lowered, so a module
  iterates what another one mints. The summary names each minted record by
  its call node and keeps the source (or a generator's own closures) beside
  it: `it.next().value` is the element, not the join of every mint. A class
  initializer runs once per receiver layout in the summary (initializer
  contexts), so a derived class's `super(…)` no longer joins its arguments
  into every layout of the family; a lost shape escapes only the fields a
  read through an unknown receiver cannot answer precisely. The summary
  walks what the program reaches (exports, escaped and host-held callables,
  module initializers, and what their walks call): an API surface the
  program never exercises cannot pollute the allocations the exercised one
  shares.
- Booleans ride either carrier, the raw 0/1 or the atom box. A test of a
  BOOL-typed f64 is the number test, then the atom compare.
- Export boundary: a parameter an exported function never uses as a string is
  compiled as a number and converted at the boundary (README lists it);
  typed-array index parameters are numeric; property keys cross as strings.
  Named typed-array keys use property storage, canonical numeric keys convert
  to elements. Array indices follow the documented i32-truncating contract;
  object keys keep fractional names.
- Numeric lowering (CONTRIBUTING has the forms): range-proven values avoid
  general conversion helpers. Checked integer reads stay in words through
  integer conversions and comparisons; missing elements remain undefined
  until the consumer decides their result. Load CSE keeps an exit-only
  `if`'s loads, small-constant unrolling has a cost budget, and watr's `ifset`
  leaves a branchy condition alone.
- Transcendentals share one evaluation tree (`polyTree`) across the scalar
  WAT, the two-wide WAT and the JS constant folder, so the three agree bit
  for bit. exp and exp2 are one table kernel at 0.5 ulp; the atan, asin and
  acos minimax (1e-10) is a deliberate speed trade. The LAB colour cases gate
  through `LAB_SPEED` with a named, measured divergence from V8 instead of
  checksum equality.
- The source inliner splices a multi-declarator declaration only in an
  innermost loop, the loops the vectorizer takes. A `let`-declared local
  arrow inlines like a const one.
- The bench measures the first call of a fresh process, so a large speed-tier
  module pays Liftoff until TurboFan lands. watr's ratio is that tier-up; its
  steady state is 1.24× of V8's warmed JS. The lever is a smaller hot module
  (cold paths out of line, a size-aware branch-speculation budget), not a
  different steady state.
- Gated invariant checks stay: frame effects, kernel parity, output-size and
  loop-count ratchets and the speed pins in `test/bench.js` protect compiler
  development and are not the source of complexity.
- A per-iteration rewind is registered under its function's name by the
  loop's label: labels count from zero in every function, and a module-wide
  registry handed the first function's loop of that label another function's
  proof.
- A module joining a shared memory is validated before it is instantiated:
  its tables are read from the custom sections and merged on copies, so a
  rejected module's start function, data segments and tables never touch the
  memory, and a merge commits whole or not at all.
- An array pattern over a value the summary proves an array reads by index
  (a plan sweep): the protocol's cursor record and its pool are module state
  no rewound frame may touch, and the protocol cost a call per element.
- The frame census names the class functions a member reaches on the
  receiver's listed layouts, a receiver that may be nullish or of several
  classes included, and reads through the function's own summary view; a
  loop's callee allocations belong to the iteration. Before this, every
  accessor-named read anywhere made its frame unsafe, and the census ran on
  the module's view, where a parameter had no kind.
- A loop marker is validated against the loop's own tape at link, not the
  whole function's; the schema-keyed inline caches and the coherent
  dynamic-get cache are no veto. webaudio's per-sample loops rewind: one
  render allocates 87 MB and keeps 9.
- A derived class's accessor is a class function of its own schema, not a
  dynamic install: the dispatcher's fallback probes for an accessor slot only
  where an object literal's schema or a static pair may carry it.
- `slice` yields an array with a cell of its own: the receiver's positional
  row carried over unshifted, so `['func', [..]].slice(1)[0]` read as a
  string.
- Object methods receive `this` at invocation through the closure ABI,
  including optional calls, accessors and callbacks with `thisArg`. Generators
  capture it before suspension. This removes the per-object receiver capture;
  programs without receiver reads omit the ABI slot. Class methods retain
  the documented bound-method contract.
- Prepared statement lists share the block emitter's flow facts and
  invalidation. A throwing typeof guard retains its callable proof, so an
  unshadowed closure `call` uses the invocation ABI without a property probe.

Dependencies

- subscript ^10.8.0 and watr ^5.11.2 from npm; 5.11.2 carries the two
  optimizer rules the speed rows rely on (the mixed-sign truncation-of-convert
  fold for base64, `ifset` declining a branchy condition for sort), so a clean
  install reproduces the standings.
- CI runs one self-compile workflow (build, round-trip, the suite through
  `dist/jz.wasm`, the recursive check). The self-compile perf gate is
  `npm run test:self:perf`, a local release step.

## Remaining release work

1. **Runtime and self-host speed.** The final self-compile run passes (warm
   0.961× against the 1.03× cap, fresh 0.837× against 0.99× with the
   published watr dependency). An earlier fresh run failed at 1.073×;
   the preceding compiler measured 0.966× warm / 0.955× fresh in the
   follow-up comparison. Keep the failed run visible: quiet reference
   evidence is still required. The compiler's
   own profile is flat (Map/Set probes and hashing 15%, pointer decoding 3%,
   the AST visitor 4.5%); call-site wrapper isolation, blanket forwarding
   inlining, a leaf-skipping visitor, closure-property precision and extended
   duplicate-read reuse each measured nothing and were removed, so a retry
   needs a new measurement first.

   Remaining speed gaps include webaudio, watr and the rival-Wasm rows below.
   Percolation and waves lead in the current example run; the broader paired
   percolation inputs and reference-hardware evidence remain relevant.
   webaudio now preserves channel-array types through iteration, accessors,
   base initializers and solver reachability. Pending `Object.assign` targets
   wait for their factories before joining source shapes. Small leaf loops
   version a stable output receiver for Float32/Float64 storage; a second
   numeric input caches its base, length and element width. Numeric-width
   joins keep their Number domain instead of introducing possible BigInt.
   Null checks refine eligible direct locals through existing flow facts;
   effectful/coercing keys retain their captures and evaluation order.

   Five alternating audio pairs give median 7.447 → 6.471 ms (about 13%),
   checksum 2866527759 unchanged. The earlier V8 diagnostic was 4.88 ms,
   so parity remains open. Speed-mode size grows 598817 → 616071 bytes
   (2.9%); size mode does not run width versioning. Across 16 input/output
   combinations, floating outputs improve 1.46–2.50× and integer outputs
   remain within about 4% of baseline. Tests pin every numeric storage kind,
   views, aliasing, OOB, null receivers, key order, NaN and signed zero.
   These loaded-machine measurements remain diagnostic.

   Float-only companion versions regressed integer inputs feeding Float32
   output; the retained version handles all numeric input kinds and keeps
   the original fallback. An entry-range guard that removed repeated bounds
   checks measured no gain and was discarded. Reprofile the remaining
   receiver reads and automation callbacks before the next optimization.
   colorpq's scalar Arm pow, value numbering, statement scheduling and
   true two-wide pow kernel are implemented. On the final tree, three paired
   runs take 49.4 ms with the new passes versus 86.8 ms with both disabled;
   bytes fall from 16197 to 15014 and checksums match. The SIMD kernel is
   bit-identical to the scalar path on 2651 test lanes. These are local
   diagnostics; renew the V8 comparison with the release evidence. watr:
   the tier-up above.

   Against the fastest rival Wasm (`WASM_TODO` in `test/bench.js`): sdf's
   bounds checks are 72% of its gap and its scratch cursor's bounds come from
   sentinels in a mutable array, so a relational or sentinel hull is the
   proof it needs; glyfparse's checks cost nothing and its bounded byte/short
   accumulations still use f64 inside bounds-proven loop versions. Preserve
   the trip-count and step-width proof into integer narrowing; noise stands at
   1.13× of Rust with an instruction census at parity; shapes at 1.12× is
   untouched; sort is near parity with Zig. The checked-read i32 lowering
   has landed, but glyfparse still trails in the current gate. percolation's
   small-helper calls now inline into existing export loops at speed, and a
   single bare early return folds to a guard. The local diagnostic fell from
   4.78 to 3.28 ms against V8's 3.00 ms, clearing its 0.75 V8/JZ floor but
   still trailing V8. General guard/evaluation-order, repeated-call and
   exported-loop regressions pass. The benchmark exposed a regression in
   4274bd7f: a small wrapper was priced before expanding its callees, moving
   bulk work into a cold export. The export budget now waits for call-free
   bodies. Paired diagnostics improve resample 3.13 → 1.30 ms, delayline
   1.67 → 0.63 ms, bytebeat 3.21 → 1.38 ms and entity 39.7 → 11.3 ms,
   with matching checksums and smaller binaries. The new minimal structural
   regression fails under the old rule; all 14 source-inlining tests pass
   at levels 0–3. The final core, O3, self-compile and ratchet gates pass.
   wordcount's current 1.238× of C-wasm is not caused by the two new passes:
   its Wasm is byte-identical with them disabled.

   Single early value returns now join the existing source-inlining path.
   Ulam's arithmetic helper consequently inlines into the pixel loop: five
   alternating local runs give median 1.440 → 0.780 ms, versus V8's 1.313 ms.
   Three camera settings match pixel for pixel; the binary grows 4637 → 4664
   bytes. Glyph parsing, sdf, noise and wordcount are unchanged by this
   optimization. These are diagnostic measurements, pending release hardware.
   Checked integer comparisons and dependent indices now avoid float round
   trips. Stable global typed-array snapshots also cache allocation lengths
   under the existing call-graph write proof. Across three fixed grids and
   four occupancy levels, two paired runs put percolation 7.6–8.0% faster
   than 82b4e4e6, with identical pixels and cluster counts. V8/JZ is
   1.046–1.048×; the final run leads on all 12 inputs. The earlier run
   led on 11, with one 0.9% behind, so the narrow margins still need quiet
   reference evidence. Its binary shrinks 13168 → 12969 bytes. Watr's size remains
   319894 bytes. These are paired local diagnostics, not release evidence.

   The published watr 5.11.2 dependency closes the 320000-byte size backstop.
   Watr commit 434213d generalizes its existing block merging: a first
   operand's statement prefix moves out without crossing an earlier
   evaluation. The measured candidate is 319499 bytes versus 321224;
   54 of 60 size cases shrink, five are unchanged, and one grows by two
   bytes under the conservative flat-branch guard. Watr's full test command and
   five direct order/trap/control-flow regressions pass. Commit eda41d4 reuses
   its scratch array across statements. All-tier native/kernel integration
   passes 38 tests and 914 assertions. JZ now requires published 5.11.2;
   its measured size is 319499 bytes, matching the candidate. Exact
   literal capacity and unused value-number capture removal are already
   implemented; the latter now preserves the original expression node
   through a removable block, restoring self-hosted byte parity.

2. **Memory.** webaudio holds 70.3 MB of resident memory against V8's 70.6
   (paired, node against node, the earlier measured tree; 151 before): the automation loops
   rewind per sample once the census named the class functions their
   receivers reach, the tuple destructuring read by index, and the link pass
   judged the loop's own tape. jessie and watr still peak at 170 and 157
   against V8's 98 and 77 in that profile. Watr retains 64 KB code buffers
   between assemblies. Jessie's September 22 allocation trace corrects the
   earlier whitespace attribution: about 66.5 MB comes from `parse.asi`,
   split between its suffix slice and the new statement-list array. The
   measured program allocates 81.3 MB in total with the smaller sidecars;
   this is allocation volume across the benchmark, not per-parse live memory.
   Removing the growth reserve from nonempty literals now saves 14.4 MB of
   jessie's peak RSS in three paired local runs (177.4 → 163.0 MB), with the
   same checksum and unchanged median runtime (1.395 → 1.399 ms). Watr's
   paired median RSS moved 170.8 → 166.6 MB; its timings were noisy. These
   diagnostics reduce the gap but do not establish memory parity with V8.
   The speed tier now shares the two-slot named-property reserve with the
   other tiers, saving another approximately 18 MB of jessie's diagnostic
   RSS without a repeatable runtime loss. No new storage representation was
   added; aliasing and property growth use the existing table machinery.
   A next allocation optimization must prove that a copied slice is consumed
   only by a subsequent spread and that intervening effects cannot change
   its contents. The parser's source remains a fixed specimen.
   Removing object methods' receiver captures saves 480000 bytes in a retained
   20000-object workload (1644352 → 1164352, 29%). Five alternating runs give
   median 0.404 → 0.367 ms; its binary shrinks 2266 → 2171 bytes and the
   checksum is unchanged. This is a focused allocation result, not closure
   of the Jessie/watr RSS gaps. Final speed binaries grow by 927 bytes for
   watr and shrink by 84 bytes for webaudio; Jessie's validation adds 283
   bytes. Watr's benchmark size build is 319898 bytes,
   still below its 320000-byte backstop.

3. **Reproducible speed, size and memory evidence.** `bench/results.json` is
   stale: timed above the 4096 MB swap-validity cap, 43 comparable
   Porffor/TinyGo rows against 44 required, and alpha's w2c row no longer
   describes the tree. Regenerate through the benchmark runner on quiet
   reference hardware with the current compiler and memory-baseline
   provenance; keep TinyGo 0.42.0 and the same-machine Porffor comparison.
   Local paired timings and standalone size sweeps are diagnostics, not
   release evidence.
   TinyGo 0.42 now builds all 44 cases locally. Forty-three match committed
   checksum references; entity has no committed reference yet, but its
   checksum 1275530752 matches V8 in the separate reference run. This closes
   the toolchain build defect, not the committed-evidence gap.
   The September 22 focused paired run still has 25.5 GB of swap in use.
   Its diagnostic JZ/rival medians are glyfparse/C-Wasm 1.418×,
   sdf/C-Wasm 1.420×, noise/Rust-Wasm 1.148× and wordcount/C-Wasm 1.011×;
   watr/V8 is 1.546× and jessie/V8 0.988×. All checksums match.

4. **Public VST scope and identity.** The builder is JZ/macOS/mono-or-stereo.
   Porffor needs a public state-object adapter and build verification. Use
   `org.audiojs` for the permanent vendor root, matching the audio compiler
   contract and the user's audiojs choice; do not publish IDs under a temporary root.
   Restart-flagged edits take effect on next setup; active restart needs the
   component-handler interface. Events and wider layouts remain refused.

5. **Proof and independent review.** Reachable dynamic calls can still make
   static allocation and work proofs unknown. Empirical block checks
   establish neither allocation freedom for all inputs nor callback
   deadlines; reuse entry-range facts for useful bounds, since a full-i32
   domain proves no deadline. Present the pinned candidate and complete gate
   evidence for independent review; implementation alone is not expert
   approval. The watr optimizer rules, including the block-prefix size
   correction in item 1, are published and required by the dependency.

## Gate evidence, September 23

- Core: 4640 passed, one skip (114002 assertions). Opt0: 4448
  passed (93032 assertions); opt3: 4448 passed (93460 assertions);
  WASI: 4501 passed (104563 assertions), each with one skip. All four ran
  on the same compiler tree with published watr 5.11.2. No compiler source
  changed during these gates.
- Self-compile: 68 passed (2365 assertions). Perf ratchet: 10 passed.
  The final self-compile speed run passes: warm 0.961× V8 (cap 1.03×), fresh
  0.837× (cap 0.99×). An earlier fresh run failed at 1.073×; the old/current
  comparison and loaded-machine limitation are recorded in item 1.
  Public types and import lint pass.
- Language conformance: 3201 pass, zero failures, two xfails; all 4045
  negative syntax cases reject. The receiver suite passes 23 tests in both
  hosts, including captured iterator operations, spread callback receivers
  and strict closure calls with effectful receiver arguments.
  Built-ins pass 878 cases, zero failures and 44 xfails.
  Ten invalid programs accepted by 070f9adb now reject: duplicate method
  parameters, restricted async grammar and mixed static/instance private
  accessor pairs. They reject through the Wasm-hosted compiler too. No xfail,
  negative ledger or coverage floor changed.
- The full benchmark: 263/271 pass. Speed geomeans are 0.474× V8,
  0.706× native C and 0.496× AssemblyScript; size is 0.782× AssemblyScript.
  Perf-fuzz passes (integer 0.85×, float 0.71×, mixed 0.86× V8), as does
  floatbeat (0.395×). TinyGo coverage passes. Watr's size backstop passes at
  319898 bytes against 320000; its runtime is 1.01× V8 in this run.
- Eight checks remain red: fastest-Wasm fft 1.090×, glyfparse 1.366×,
  sdf 1.514×, noise 1.175×, levenshtein 1.152× and wordcount 1.293×;
  sdf/V8 1.026×; and alpha's stale committed w2c row. All six Wasm kernels
  are byte-identical to 82b4e4e6 with identical build options, so these are
  not regressions introduced by the checked-integer and length-cache work.
  The changing red-row count on this loaded machine does not establish an
  improvement. Timing bands and all caps remain unchanged.
- The example driver had stale arguments for Ulam, waves, attractors and
  raymarcher. Their calls now match the current kernels, and an untimed
  arity check validates all 21 drivers. Lenia's effective zero seed is
  explicit. Kernel sources and timing caps are unchanged. Ulam's zero-size,
  repeated-view and changed-view outputs match JS pixel for pixel at O0,
  O3 and WASI. The current example run has a 1.60× V8/JZ geomean and 21/21
  strict wins: Ulam 1.66×, waves 1.12× and percolation 1.09×. Percolation's
  separate three-grid paired comparison establishes the 7.6–8.0% improvement
  recorded above; the benchmark alone does not establish a waves improvement.
  Ulam's five alternating before/after/V8 measurements give
  a 45.9% runtime reduction and 1.68× V8 speed, with identical pixels at
  three camera settings.
- The focused typed-loop suite passes 19 tests and 3671 assertions, including
  primitive signed-zero comparisons that the array deep-equality helper omits.
- The machine exceeds the reference-evidence swap cap. These are diagnostics,
  not refreshed release evidence. No timing, size or memory cap was changed.
- The original four review fixes have regressions in `test/destruct.js`,
  `test/value-number.js` and `test/schedule.js`. Addition carriers and
  private inlined parameters are pinned in `test/bigint-tag.js` and
  `test/optimizer.js`; self-hosted dictionary output remains byte-identical.
