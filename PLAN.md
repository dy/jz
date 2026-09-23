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

1. **Runtime and self-host speed.** Close the red rows listed in the gate
   evidence below, plus webaudio and watr. Caps stay unchanged; benchmark
   sources stay fixed. Paired local measurements on this loaded machine
   are diagnostics, not release evidence.

   | Remaining class | Evidence and next proof |
   | --- | --- |
   | SDF scratch-array gathers | Bounds checks account for about 72% of its gap. Its cursor stops at sentinels in mutable arrays; removing those checks requires a relational or sentinel proof. |
   | Bounded byte/short accumulators | Glyph parsing's fast loop retains f64 because its checked fallback can produce NaN. Preserve the bounded trip count and step width into integer narrowing. |
   | Noise's dependent lookups | The candidate preserves all-writers element hulls through in-place copies and swaps, and preserves intervals through load-CSE's unary plus. Four lookup checks disappear, but the Rust-Wasm gap is still open. |
   | FFT, sort, CRC32, wordcount | FFT, sort and CRC32 remain red in the latest run; wordcount's standing varies. TinyGo's scalar FFT advances pointers directly while JZ's SIMD loop still calculates indexed addresses. Compare paired hot loops before changing code. |
   | webaudio | Numeric-width loop versions retain all numeric input types and specialize floating outputs. Reprofile receiver reads and automation callbacks before adding another version. |
   | watr | Separate cold tier-up from steady-state helper work. Cold paths out of line and size-aware speculation remain the useful levers. |

   Retained diagnostics:

   - The checked-integer and global-length work makes percolation 7.6–8.0%
     faster across three grids and four occupancies, with identical outputs;
     its binary shrinks 13168 → 12969 bytes. Final paired V8/JZ is
     1.046–1.048×, with narrow margins that still need quiet evidence.
   - The validated candidate reuses the binding-use census to keep checked
     integer locals in words when every consumer already converts to a word.
     Glyph parsing shrinks 3124 → 3011 bytes, noise 2307 → 2116 bytes.
     SDF, wordcount and FFT remain byte-identical to 4b729882.
     Noise's final range fix measures 2987 → 2954 µs in ten alternating
     forced-optimized pairs, about 1%; glyph timing establishes no gain.
     Checksums match. An exposed pre-existing typed-store defect is also
     fixed: element dispatch and property storage convert an object key once.
   - Adjacent integer min/max updates now share the statement scheduler's
     loop walk. Deferring the recurrence input reduces Levenshtein's optimized
     paired median 1788 → 1232.5 µs (31%); normal-tier pairs give
     1939.5 → 1228 µs. All checksums are 981953199 and the speed binary stays 1920 bytes.
     Eight focused tests pass (1871 assertions), covering signed/unsigned
     comparisons, both operand orders, word boundaries, zero work, repeated
     calls, JavaScript parity and effects that forbid reordering.
     The combined benchmark closes the Levenshtein row: 1.22 ms versus
     AssemblyScript's 1.69 ms (0.721×). This agrees with the paired improvement.
   - webaudio's five paired runs improve 7.447 → 6.471 ms with checksum
     2866527759 unchanged, versus the earlier V8 diagnostic of 4.88 ms.
     Speed size grows 598817 → 616071 bytes; size mode skips width versioning.
     All 16 numeric input/output combinations remain covered.
   - colorpq's scalar/SIMD pow, value numbering and scheduling are implemented:
     49.4 ms with the passes versus 86.8 ms with both disabled, 16197 →
     15014 bytes, matching checksums. Ulam's early-return inlining improves
     1.440 → 0.780 ms versus V8's 1.313 ms, with identical pixels.
   - The combined tree passes self-compile speed: warm 0.955× (cap 1.03×),
     fresh 0.775× (cap 0.99×). The preceding tree measured 0.961× / 0.837×,
     with an earlier fresh run failing at 1.073×. These loaded-machine
     timings still need quiet reference evidence.
   - Published watr 5.11.2 closes the 320000-byte size backstop. The latest
     completed benchmark build is 319898 bytes. Its shared optimizer rules
     and JZ's dependency are implemented, not pending release work.

   Rejected experiments stay out of the compiler: a wordcount propagation
   extension saved 49 bytes but had inconsistent runtime results; stamping
   glyph-count bounds generated identical Wasm. A scratch guarded-i64
   accumulator extension increased glyph size 3011 → 3441 bytes and paired
   optimized time 8408.5 → 9422 µs with the same checksum. That result points
   to bounded i32 narrowing without an in-loop guard, not a larger wide loop.
   Earlier self-host wrapper isolation, forwarding inlining, leaf-skipping
   visitors and broader read reuse also measured no gain and were removed.

2. **Memory.** Close the Jessie and watr RSS gaps. webaudio already measured
   70.3 MB versus V8's 70.6 MB on the earlier paired tree: per-sample arena
   rewind keeps one render's 87 MB allocation volume to 9 MB retained.

   Jessie and watr remain behind V8's approximately 98 MB and 77 MB peaks.
   Exact nonempty-literal capacity reduced Jessie's paired peak
   177.4 → 163.0 MB with unchanged checksum and median runtime; two-slot
   property sidecars saved approximately another 18 MB. Watr's paired peak
   moved 170.8 → 166.6 MB. These are diagnostic improvements, not parity.

   Jessie's allocation trace attributes about 66.5 MB to `parse.asi`, split
   between its suffix slice and the new statement-list array. The smaller
   sidecars bring total benchmark allocation volume to 81.3 MB; this is not
   per-parse live memory. The next optimization must prove a copied slice
   is consumed only by a following spread, without intervening mutations or
   custom method/iterator behavior. Immutable string views do not establish
   that proof for arrays. Keep the parser source unchanged. Watr retains
   64 KB code buffers between assemblies; use its lifetime evidence before
   changing allocation policy.

3. **Reproducible speed, size and memory evidence.** `bench/results.json` is
   stale: timed above the 4096 MB swap-validity cap, 43 comparable
   Porffor/TinyGo rows against 44 required, and alpha's w2c row no longer
   describes the tree. Regenerate through the benchmark runner on quiet
   reference hardware with current compiler and memory-baseline provenance.
   Keep TinyGo 0.42.0 and the same-machine Porffor comparison. Local paired
   timings and standalone size sweeps do not replace this evidence.

   TinyGo now builds all 44 cases locally. Forty-three match committed
   checksums; entity's 1275530752 matches the separate V8 reference run.
   The build defect is closed, the committed-evidence gap is not. The latest
   focused run still used about 25.5 GB of swap. Its JZ/rival medians were
   glyfparse/C-Wasm 1.418×, SDF/C-Wasm 1.420×, noise/Rust-Wasm 1.148×,
   wordcount/C-Wasm 1.011×, watr/V8 1.546× and Jessie/V8 0.988×.

4. **Public VST scope and identity.** The builder is JZ/macOS/mono-or-stereo.
   Porffor needs a public state-object adapter and build verification. Use
   `org.audiojs` for the permanent vendor root, matching the audio compiler
   contract and the user's audiojs choice. Restart-flagged edits take effect
   on next setup; active restart needs the component-handler interface.
   Events and wider layouts remain refused.

5. **Proof and independent review.** Reachable dynamic calls can still make
   static allocation and work proofs unknown. Empirical block checks prove
   neither allocation freedom for all inputs nor callback deadlines. Reuse
   entry-range facts for useful bounds; a full-i32 domain proves no deadline.
   Present the pinned candidate and complete gates for independent review.
   Implementation alone is not expert approval.

## Gate evidence, September 23

Validated candidate on top of `4b729882`: checked integer-word demand,
single key conversion, same-array element hulls, unary-plus interval transfer
and integer recurrence scheduling. The full sequence ran with the same
315 source/test inputs, checked by digest before each gate and after completion.

- Core: 4648 passed, one skip (118421 assertions). Opt0: 4456
  passed (96173 assertions); opt3: 4456 passed (96601 assertions);
  WASI: 4509 passed (108982 assertions), each with one skip. All four ran
  on the same compiler tree with published watr 5.11.2. No compiler source
  changed during these gates.
- Self-compile: 68 passed (2365 assertions). Perf ratchet: 10 passed.
  The final self-compile speed run passes: warm 0.955× V8 (cap 1.03×), fresh
  0.775× (cap 0.99×). An earlier fresh run failed at 1.073×; the old/current
  comparison and loaded-machine limitation are recorded in item 1.
  Public types and import lint pass.
  Regenerating `dist/jz.wasm` and running the scheduler suite through that
  compiler also passes all eight tests and 1871 assertions. An initial check
  had selected an older local artifact; the release gates use fresh private
  builds and were unaffected.
- Language conformance: 3201 pass, zero failures, two xfails; all 4045
  negative syntax cases reject. The receiver suite passes 23 tests in both
  hosts, including captured iterator operations, spread callback receivers
  and strict closure calls with effectful receiver arguments.
  Built-ins pass 878 cases, zero failures and 44 xfails.
  Ten invalid programs accepted by 070f9adb now reject: duplicate method
  parameters, restricted async grammar and mixed static/instance private
  accessor pairs. They reject through the Wasm-hosted compiler too. No xfail,
  negative ledger or coverage floor changed.
- The full benchmark: 266/271 pass. Speed geomeans are 0.467× V8,
  0.694× native C and 0.481× AssemblyScript; size is 0.781× AssemblyScript.
  Perf-fuzz passes (integer 0.87×, float 0.71×, mixed 0.86× V8), as does
  floatbeat (0.402×). TinyGo coverage passes. Watr's size backstop passes at
  319898 bytes against 320000; its runtime is 1.24× V8 in this run.
- Five checks remain red: fastest-Wasm fft 1.061× (TinyGo), sdf 1.467×
  (C-Wasm), sort 1.144× (Zig-Wasm), crc32 1.051× (C-Wasm), and alpha's
  stale committed w2c row. FFT and SDF are byte-identical to the preceding
  tree. Levenshtein's 0.721× AssemblyScript result follows
  a measured scheduling improvement; glyfparse, noise and wordcount passing
  in this run does not establish that their standing gaps are closed.
  Timing bands and all caps remain unchanged.
- The example driver had stale arguments for Ulam, waves, attractors and
  raymarcher. Their calls now match the current kernels, and an untimed
  arity check validates all 21 drivers. Lenia's effective zero seed is
  explicit. Kernel sources and timing caps are unchanged. Ulam's zero-size,
  repeated-view and changed-view outputs match JS pixel for pixel at O0,
  O3 and WASI. The current example run has a 1.60× V8/JZ geomean and 21/21
  strict wins; the new candidate run measures 1.61× and also wins 21/21.
  The preceding run measured Ulam 1.66×, waves 1.12× and percolation 1.09×. Percolation's
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
