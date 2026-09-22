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
- Numeric lowering (CONTRIBUTING has the forms): ToInt32 is the i64
  truncation and wrap, range-proven values drop the infinity guard, a checked
  read keeps its `__to_int32` call, load CSE keeps an exit-only `if`'s loads,
  the small-constant loop unroll has a cost budget, and watr's `ifset` leaves
  a branchy condition alone.
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

Dependencies

- subscript ^10.8.0 and watr ^5.11.2 from npm; 5.11.2 carries the two
  optimizer rules the speed rows rely on (the mixed-sign truncation-of-convert
  fold for base64, `ifset` declining a branchy condition for sort), so a clean
  install reproduces the standings.
- CI runs one self-compile workflow (build, round-trip, the suite through
  `dist/jz.wasm`, the recursive check). The self-compile perf gate is
  `npm run test:self:perf`, a local release step.

## Remaining release work

1. **Conformance.** The September 22 language gate has 3200 passes and one
   failure: a detached generator method keeps its receiver because methods
   currently lower to bound closures. The bound-method compatibility decision
   remains open. Built-ins pass: 878 tests, zero failures. The callback,
   parameter/default/body scope, named-function binding, thenable FIFO and
   using-initializer failures are fixed and pinned. Eight accessor-descriptor
   cases now use the existing out-of-scope rejection from README, and six
   passing xfails were removed. No new xfail was added.

2. **Runtime and self-host speed.** The self-compile gate passes (warm
   0.968× against the 1.03× cap, fresh 0.778× against 0.99× with the
   published watr dependency). The compiler's
   own profile is flat (Map/Set probes and hashing 15%, pointer decoding 3%,
   the AST visitor 4.5%); call-site wrapper isolation, blanket forwarding
   inlining, a leaf-skipping visitor, closure-property precision and extended
   duplicate-read reuse each measured nothing and were removed, so a retry
   needs a new measurement first.

   Remaining speed gaps include webaudio, watr and percolation; the aggregate
   speed win does not establish a win on every case.
   webaudio (7.6× → 2.2×, web-audio-api 1.5.6): the roots were the
   iterator protocol (the automation list's `[Symbol.iterator]()` escaped its
   array, and a consumer module without producers of its own indexed the
   list instead of iterating it), the accessor probe on every `event.type`
   read (a dynamic lookup because some class installs a `type` getter), and
   the shared base initializer of the ports joining `AudioParam` into every
   output's `node`. The remaining 2.2× is the generic typed-array element
   helpers in the DSP loops (40% of the render): `AudioBuffer`'s channel
   count read unknown because the summary walked every function whether the
   program reached it or not, and `utils.decodeAudioData`, which nothing
   calls, handed its host-decoded data to `new AudioBuffer(unknown, …)`;
   reachability in the solver closed that (3 shapes lost, 9.1 ms). The
   channel data now reads as a typed array of unknown element type, and
   rightly so: `AudioBuffer` holds `Float32Array` views while the ports mix
   into `Float64Array` blocks (`_useFloat64`), so one channel array carries
   both, and the DSP loops read and store through the generic element
   helpers (40% of the render). The lever is a loop version per element
   type: the emitter clones a loop whose typed source is bimorphic once for
   each width, guarded by the runtime element type, as the bimorphic
   parameter split already does for callees. Then the automation `findIndex`
   callbacks and
   the tuple destructuring `const [t, v] = …` that opens a cursor per call
   (8%). The current update fixes a solver-order loss at
   `Object.assign(factory(), source)`: a pending target no longer escapes the
   source before its factory's result arrives. Small leaf loops now version
   one stable typed receiver for Float32/Float64 stores and reads, preserving
   bounds and conversion semantics. The local audio diagnostic moved from
   9.25 ms to 7.72–7.92 ms with the factory fix, then 7.21–7.46 ms with
   width versions and numeric element-domain joins (V8 4.88 ms, matching
   checksum 2866527759). Joining numeric widths no longer introduces a
   possible BigInt element, and the solver and query share those transfers.
   The combined speed build is 598817 bytes versus 598511 after the factory
   fix alone; size mode does not run width versioning. Width specialization
   now also pins empty/OOB loops, views, coercion, NaN and signed zero. The
   remaining stable receiver reads and callbacks still need work; this does
   not establish parity. A further entry-range guard removed repeated
   bounds checks from 19 loops but measured 7.367 ms versus 7.326 ms in five
   alternating pairs and added 1160 bytes; that experiment was discarded.
   Specializing two receivers together after removing redundant null-check
   captures improved the audio diagnostic by 6%, but made mixed Float32/
   Float64 copies 2.6–4× slower by losing the single-receiver fallback. That
   experiment was also discarded. Future multi-receiver versions must retain
   the existing mixed-width path; moving or folding receiver copies should
   use dominance evidence, not a function-wide alias guess.
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
   proof it needs; glyfparse's checks cost nothing and its lever is an i32
   representation for the ToInt32-blind checked byte reads; noise stands at
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

3. **Memory.** webaudio holds 70.3 MB of resident memory against V8's 70.6
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

4. **Reproducible speed, size and memory evidence.** `bench/results.json` is
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

5. **Public VST scope and identity.** The builder is JZ/macOS/mono-or-stereo.
   Porffor needs a public state-object adapter and build verification. Use
   `org.audiojs` for the permanent vendor root, matching the audio compiler
   contract and the user's audiojs choice; do not publish IDs under a temporary root.
   Restart-flagged edits take effect on next setup; active restart needs the
   component-handler interface. Events and wider layouts remain refused.

6. **Proof and independent review.** Reachable dynamic calls can still make
   static allocation and work proofs unknown. Empirical block checks
   establish neither allocation freedom for all inputs nor callback
   deadlines; reuse entry-range facts for useful bounds, since a full-i32
   domain proves no deadline. Present the pinned candidate and complete gate
   evidence for independent review; implementation alone is not expert
   approval. The watr optimizer rules, including the block-prefix size
   correction in item 2, are published and required by the dependency.

## Gate evidence, September 22

- Final core: 4605 passed, one skip (109000 assertions). Opt0: 4413
  passed (88820 assertions); opt3: 4413 passed (89247 assertions);
  WASI: 4466 passed (99562 assertions), each with one skip. All four ran
  on the same compiler tree with published watr 5.11.2. No compiler source
  changed during these gates.
- Self-compile: 68 passed (2365 assertions). Perf ratchet: 10 passed.
  Self-compile speed passes: warm 0.968× V8 (cap 1.03×), fresh 0.778×
  (cap 0.99×). Public types and import lint pass.
- Language conformance: 3200 pass, one fail, two xfails. Built-ins:
  878 pass, zero failures, 44 xfails. The remaining failure is item 1.
- Benchmark: 260/271 pass. Speed geomeans are 0.467× V8, 0.710× native C
  and 0.484× AssemblyScript; size is 0.782× AssemblyScript. Perf-fuzz passes
  (integer 0.93×, float 0.75×, mixed 0.88× V8), as does floatbeat (0.393×).
  TinyGo coverage passes. Watr's published-dependency size passes at 319488
  bytes against 320000, and its 1.114× V8 runtime clears the existing 1.25×
  trail gate, though it remains slower than V8.
- Eleven red rows remain: fastest-Wasm fft 1.074×, glyfparse 1.230×,
  sdf 1.379×, trace 1.069×, sort 1.121×, crc32 1.059×, noise 1.097×,
  radixsort 1.123× and wordcount 1.157×; alpha's stale committed w2c row;
  and strict example wins (below). These loaded-machine readings do not
  establish regressions for the rows near their timing bands.
- The example driver had stale arguments for Ulam, waves, attractors and
  raymarcher. Their calls now match the current kernels, and an untimed
  arity check validates all 21 drivers. Lenia's effective zero seed is
  explicit. Kernel sources and timing caps are unchanged. Ulam's zero-size,
  repeated-view and changed-view outputs match JS pixel for pixel at O0,
  O3 and WASI. The valid example run has a 1.54× V8/JZ geomean and 19/21
  strict wins; Ulam 0.90× and percolation 0.91× still trail V8.
- The machine exceeds the reference-evidence swap cap. These are diagnostics,
  not refreshed release evidence. No timing, size or memory cap was changed.
- The original four review fixes have regressions in `test/destruct.js`,
  `test/value-number.js` and `test/schedule.js`. Addition carriers and
  private inlined parameters are pinned in `test/bigint-tag.js` and
  `test/optimizer.js`; self-hosted dictionary output remains byte-identical.
