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
   | SDF scratch-array gathers | Sentinel guards remove the hull cursor's checks on the fast path (below). The rest is loop-carried forwarding, read off V8's TurboFan code for both builds: clang's pass keeps `v[k]` (the `q` just stored) and `z[k]` (the `sMid` just stored) in registers, so the `f[v[k]]` gather issues at once and the first pop test is `fcmp` against a register; JZ reloads `v[k]` at the top of each pass, a dependent load before the gather and the divide. Carried elements now forward `v[k]` (below). The guarded pop and scan tests lower to `fcmp; cset; cbz`: watr's `conditions` pass chains only `local.tee` diamonds, and the guard's `&&` has a constant arm (below). `z[k]` would need the pop's first test peeled; its load issues beside the divide, off the critical path. |
   | Bounded byte/short accumulators | Twin locals give glyph parsing's versioned coordinate loops i32 locals of their own, and the word-storage census admits the flag loop's `rep`, whose checked read meets only `rep > 0` and the decrement that test guards (below). Glyph parsing reaches parity with C-Wasm; a clear lead needs quiet evidence. |
   | Noise's dependent lookups | The candidate preserves all-writers element hulls through in-place copies and swaps, and preserves intervals through load-CSE's unary plus. Four lookup checks disappear, but the Rust-Wasm gap is still open. |
   | FFT, sort, CRC32, wordcount | CRC32's red is timing noise: in V8's TurboFan code for both builds the per-byte recurrence is five dependent instructions (`eor`, mask, table add, `ldr`, `eor`); clang only fuses the mask with the shift (`ubfiz`) where JZ fuses the shift with the table add, and JZ's loop test adds one `cmp`. The committed rows lead (0.988×). FFT and sort vary between runs. Wordcount's duplicate tag check is removed and the latest row passes. The attempted FFT pointer advancement lost both speed and size. Require quiet paired evidence before treating a fluctuating row as closed. |
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
   - Dictionary probes reuse the emitter's string-key proof, removing a
     duplicate tag test. Wordcount shrinks 4333 → 4318 bytes. Two sets of ten
     alternating normal-tier pairs improve 909.5 → 568 and 823.5 → 594.5 µs;
     forced-optimized measurements vary, so this is not a steady-state claim.
     The same audit fixed a pre-existing growth allocation: the optional
     four-byte hash lane was counted as a boolean byte. Host collection
     decoding now shares forwarding, tombstone filtering and insertion order.
   - Twin locals (`compile/twin-locals.js`) version a counted loop in the
     source when its checked twin would widen the fast copy's locals: the
     twin declares its own names, so glyph parsing's fast coordinate loops
     accumulate in i32 while the twins keep f64. Sixteen alternating rounds
     measure 1.162 → 1.060× C-Wasm with checksum 4073289688 unchanged; the
     speed binary grows 3082 → 3174 bytes. The fast loops match a scratch
     variant with hand-written `| 0` hints op for op; that variant also
     hinting the flag loop's `rep` reached about 0.96× C.
   - Carried elements (`compile/carry-elements.js`) keep an element a loop
     stores for its next pass in a local. In V8's code for SDF's first pass
     the `f[v[k]]` gather now issues from a register, as in clang's; the
     binary grows 4 bytes and the checksum is unchanged. Paired runs at load
     9 measure no difference (1.001 and 1.006 of the build without it):
     the gather was not the bound. C-Wasm runs at 0.839 of JZ in the same
     pairs.
   - watr's `conditions` pass now also chains a diamond with a constant arm,
     the boolean `a && b` / `a || b` (watr, unreleased): each
     guarded SDF exit becomes one fused compare-and-branch per conjunct, and
     V8's `edt1d` drops 565 → 556 instructions and 11 → 2 `cset`s with the
     checksum unchanged. The shorter code is not faster: paired runs at load
     9 measure SDF 2.8–3.7% slower, with `edt1d` differing only in the
     `cset`s; glyph parsing measures 3% and sort 7% faster, LZ 2% slower,
     trace level. Almost every benchmark binary shrinks, the self-compiled
     compiler by 14.5 KB. jz picks it up with the next watr release.
   - The word-storage census admits a checked integer read whose uses
     answer undefined and zero alike, including a constant step the test's
     true arm guards: glyph parsing's `rep` becomes a word. Sixteen rounds at
     load 11 measure the original 1.122×, twin locals 1.023× and both
     0.998× C-Wasm, checksum unchanged, 3144 bytes.
   - Sentinel guards (`compile/sentinel-guard.js`) version the reads that
     only SDF's `±∞` sentinels bound: the hull pop, the scan and the read after
     the scan run unchecked under one range test per pass. A relational test on
     a typed read now proves its index where the test held, and each access
     node keeps its own proof beside an unprovable twin. Paired SDF medians
     improve 1.407 → 1.190× C-Wasm and 0.974 → 0.820× V8 with checksum
     1749682117 unchanged; the speed binary grows 3056 → 3292 bytes and the
     size tier copies nothing. Removing every remaining check in the kernel
     (WAT surgery, measurement only) reaches about 0.75× of the original
     against the guards' 0.83×.
   - The interval proof iterated body-entry states and took a loop's exit
     from the body's end. Two pre-existing miscompiles followed: after
     `while (i < 5 && j < 3)`, `a[j]` read 0 instead of undefined, and after
     `i = 1; while (i < 10) i += 2`, `a[i]` read 0. Loop proofs now iterate
     the head state and exit where the test failed (`test/interval-proof.js`).
   - Loop rotation cannot rotate SDF's loops while their per-iteration
     arena-rewind markers remain; `arenaRewind` removes them only after
     `rotateLoops`. Running the rewind first rotated all six `edt1d` loops
     but measured about 1%, so the link order is unchanged.
   - Cursor guards require a local that exists at entry and whose writes are
     all covered by the body budget. Nested declarations, header writes and
     external mutation cannot borrow that proof. A nested gather formerly
     returned 7 instead of NaN. Removing its invalid loop version also shrinks
     SDF 3583 → 3056 bytes; ten optimized pairs measure 7574 → 7593 µs with
     checksum 1749682117 unchanged, so the size win is established, not a
     speed win. The corrected tree passes the correctness gates below.
   - webaudio's five paired runs improve 7.447 → 6.471 ms with checksum
     2866527759 unchanged, versus the earlier V8 diagnostic of 4.88 ms.
     Speed size grows 598817 → 616071 bytes; size mode skips width versioning.
     All 16 numeric input/output combinations remain covered.
   - colorpq's scalar/SIMD pow, value numbering and scheduling are implemented:
     49.4 ms with the passes versus 86.8 ms with both disabled, 16197 →
     15014 bytes, matching checksums. Ulam's early-return inlining improves
     1.440 → 0.780 ms versus V8's 1.313 ms, with identical pixels.
   - The combined tree passes self-compile speed: warm 0.969× (cap 1.03×),
     fresh 0.790× (cap 0.99×). The preceding tree measured 0.955× / 0.775×,
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
   Advancing six pointers in the SIMD butterfly instead of calculating
   addresses also loses: 2872 → 2947 bytes and 1082.5 → 1090.5 µs in ten
   optimized pairs. It remains out of the source. Making all checked SDF reads
   branchy saves 55 bytes but measures 7683 → 7821 µs, so that policy stays
   confined to its existing consumers.

2. **Memory.** Close the Jessie and watr RSS gaps. webaudio already measured
   70.3 MB versus V8's 70.6 MB on the earlier paired tree: per-sample arena
   rewind keeps one render's 87 MB allocation volume to 9 MB retained.

   Jessie and watr remain behind V8's approximately 98 MB and 77 MB peaks.
   Exact nonempty-literal capacity reduced Jessie's paired peak
   177.4 → 163.0 MB with unchanged checksum and median runtime; two-slot
   property sidecars saved approximately another 18 MB. Watr's paired peak
   moved 170.8 → 166.6 MB. These are diagnostic improvements, not parity.

   Array slice views (`compile/array-view.js`) remove `parse.asi`'s suffix
   slice: its `items = b.slice(1)` is spread straight from `b`. One Jessie run
   allocates 81.3 → 48.2 MB and its linear memory stays at 64 MB instead of
   128 MB; peak RSS measures 145.6 → 110.3 MB with checksum 2418067300
   unchanged. The speed binary grows 234 bytes; the size tier keeps the copy.

   Jessie's allocation trace attributed about 66.5 MB to `parse.asi`, split
   between its suffix slice and the new statement-list array. The array
   remains: each level of the recursion copies the list below it into a new
   one, and only the outermost survives. Closing the gap to V8's peak needs
   that copy reused in place or reclaimed. Keep the parser source unchanged.
   Watr retains 64 KB code buffers between assemblies; use its lifetime
   evidence before changing allocation policy. Its run ends at 153 MB RSS:
   a 50.6 MB host baseline, a 59 MB heap peak in 64 MB of linear memory, and
   about 39 MB of V8's own, the same without tier-up. The bench loop cannot
   rewind: `assemble` calls `Uint8Array.from`, which the frame census does
   not know as a fresh allocation, and past it stores its buffer into a
   module binding, the retained buffer above.

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

4. **Builtins over accessors and `toJSON`.** At every level, `Object.values`,
   `Object.entries`, `JSON.stringify` and `Object.assign` do not run a
   literal's getter: `Object.values({ a: 1, get g() { return 7 } })` gives
   `[1, null]`, `Object.entries` exposes the slot as `g__get`, `JSON.stringify`
   omits it and `Object.assign` leaves it undefined. Spread copies the getter
   itself, so it runs at each later read instead of once at the spread.
   `JSON.stringify` ignores a class's `toJSON` (`{}` for `{"v":1}`); a
   literal's is rejected at compile time. Each should read the value as JS
   does, or reject the program.

5. **VST follow-up after JZ v1.** The audio compiler's current README explicitly
   defers native release work until JZ v1 and requires verification from its
   installed tarball. The builder is JZ/macOS/mono-or-stereo.
   Porffor needs a public state-object adapter and build verification. Use
   `org.audiojs` for the permanent vendor root, matching the audio compiler
   contract and the user's audiojs choice. Restart-flagged edits take effect
   on next setup; active restart needs the component-handler interface.
   Events and wider layouts remain refused.

6. **Proof and independent review.** Reachable dynamic calls can still make
   static allocation and work proofs unknown. Empirical block checks prove
   neither allocation freedom for all inputs nor callback deadlines. Reuse
   entry-range facts for useful bounds; a full-i32 domain proves no deadline.
   Present the pinned candidate and complete gates for independent review.
   Implementation alone is not expert approval.

## Gate evidence, September 23

Validated candidate on top of `b0f38d36`: dictionary key-proof reuse, corrected
collection growth, shared host collection decoding and sound cursor guards.
The full sequence ran with the same 318 source/test inputs, checked by digest
before each gate and after completion. The preceding checked-integer and
recurrence-scheduling changes are committed in `22a9712f` and `b0f38d36`.

- Core: 4651 passed, one skip (118756 assertions). Opt0: 4459
  passed (96342 assertions); opt3: 4459 passed (96805 assertions);
  WASI: 4512 passed (109317 assertions), each with one skip. All four ran
  on the same compiler tree with published watr 5.11.2. No compiler source
  changed during these gates.
- Self-compile: 70 passed (2369 assertions). Perf ratchet: 10 passed.
  The final self-compile speed run passes: warm 0.969× V8 (cap 1.03×), fresh
  0.790× (cap 0.99×). An earlier fresh run failed at 1.073×; the old/current
  comparison and loaded-machine limitation are recorded in item 1.
  Public types and import lint pass.
  The fresh private kernel passes the growing-dictionary and nested-cursor
  regression samples. Local `dist/jz.wasm` was also regenerated from the same
  source: 19048276 bytes. Generated artifacts remain uncommitted.
- Language conformance: 3201 pass, zero failures, two xfails; all 4045
  negative syntax cases reject. The receiver suite passes 23 tests in both
  hosts, including captured iterator operations, spread callback receivers
  and strict closure calls with effectful receiver arguments.
  Built-ins pass 878 cases, zero failures and 44 xfails.
  Ten invalid programs accepted by 070f9adb now reject: duplicate method
  parameters, restricted async grammar and mixed static/instance private
  accessor pairs. They reject through the Wasm-hosted compiler too. No xfail,
  negative ledger or coverage floor changed.
- The full benchmark: 266/271 pass. Speed geomeans are 0.473× V8,
  0.706× native C and 0.493× AssemblyScript; size is 0.781× AssemblyScript.
  Perf-fuzz passes (integer 0.88×, float 0.69×, mixed 0.85× V8), as does
  floatbeat (0.400×). TinyGo coverage passes. Watr's size backstop passes at
  319898 bytes against 320000; its runtime is 1.041× V8 in this run.
- Five checks remain red: SDF versus V8 1.016× and C-Wasm 1.526×,
  glyfparse versus C-Wasm 1.085×, CRC32 versus C-Wasm 1.053×, and alpha's
  stale committed w2c row. Levenshtein is 0.733× AssemblyScript and wordcount
  is 0.851× C-Wasm, following the measured changes above. FFT, sort and noise
  pass this run; those flips alone do not close their standing gaps.
  Timing bands and all caps remain unchanged.
- The example driver had stale arguments for Ulam, waves, attractors and
  raymarcher. Their calls now match the current kernels, and an untimed
  arity check validates all 21 drivers. Lenia's effective zero seed is
  explicit. Kernel sources and timing caps are unchanged. Ulam's zero-size,
  repeated-view and changed-view outputs match JS pixel for pixel at O0,
  O3 and WASI. The current example run has a 1.60× V8/JZ geomean and 21/21
  strict wins; the new candidate run measures 1.58× and also wins 21/21.
  The preceding run measured Ulam 1.66×, waves 1.12× and percolation 1.09×. Percolation's
  separate three-grid paired comparison establishes the 7.6–8.0% improvement
  recorded above; the benchmark alone does not establish a waves improvement.
  Ulam's five alternating before/after/V8 measurements give
  a 45.9% runtime reduction and 1.68× V8 speed, with identical pixels at
  three camera settings.
- The focused typed-loop suite passes 19 tests and 3671 assertions, including
  primitive signed-zero comparisons that the array deep-equality helper omits.
- The machine uses 23999.56 MB of swap, above the 4096 MB reference-evidence
  cap. These are diagnostics,
  not refreshed release evidence. No timing, size or memory cap was changed.
- The original four review fixes have regressions in `test/destruct.js`,
  `test/value-number.js` and `test/schedule.js`. Addition carriers and
  private inlined parameters are pinned in `test/bigint-tag.js` and
  `test/optimizer.js`; self-hosted dictionary output remains byte-identical.
