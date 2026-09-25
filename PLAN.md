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
- An object literal's accessor is the one own property it defines wherever a
  property is listed, copied, keyed or deleted: Object.keys, values and entries,
  for-in, `in`, JSON.stringify, Object.assign, spread, structuredClone, a
  computed key and an object the host receives see it through the layout's
  enumeration view (`layoutView`), which reads it through its getter once;
  JSON.stringify calls a value's toJSON, its own or its class's, with the key
  (CONTRIBUTING has the forms).
- A layout slot marked hidden (`ctx.schema.hidden`) reads, writes and calls
  as before, but the enumeration view drops it: an Error's `message` and
  `name` and a closure-lowered class's methods and accessors are not listed,
  copied or serialized, as in JS. A program with neither pays nothing.
- A host object that matches no layout stays a host reference: `in`, keys,
  values, entries, for-in, spread, Object.assign and JSON.stringify go through
  the host, so the caller sees the module's writes (README states it).
- A runtime key reads a string's index and an array's `length` in the
  lookup chain's string and array arms, which ended at `length` and at the
  indices; a first-character digit test read in place keeps an identifier
  key off the index parse. A canonical index literal takes the index dispatch.
- Derived closure-class methods use a hidden rank in the existing property hash;
  growth preserves it and an own assignment restores enumeration. Runtime keys
  read Map/Set size and source function arity through the shared lookup chain.
  Function arities stay beside closure table entries after body deduplication.
- An array hole is an `undefined` element: `[1, , 3]` lists `"1"`. The
  divergence is in the README; a hole would need an element value apart
  from undefined, tested on every read.
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

- subscript `b0e3a65` (on 10.8.0, bulk literal decoding) and watr `b08bad2` (on 5.11.3); 5.11.3 carries the two
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

   **JSC focus, September 24:** resample, sdf, spmv, synth, vm, colorlog,
   crc32, delayline and dict. Recontest all nine against both Bun and the
   standalone JSC shell. The vm/dict/crc32 claim exception remains a
   regression band, not a reason to stop optimizing these cases.

   | Case | Current diagnosis and next proof |
   | --- | --- |
   | resample | Four adjacent taps retain separate checks around a floating phase index. Extend the shared range proof with an enclosure for repeated floating addition; preserve rounding and out-of-range behavior. |
   | sdf | Sentinel copies lost their locals' summary kinds, introducing generic conversions and property dispatch. Preserve the original kind through the existing alias query, including missing values. The measured speed artifact shrinks from 12705 to 3420 bytes; alternating timings are too noisy to establish a speed improvement. Next isolate guard placement and dependent gather checks. |
   | spmv | The current tree leads JSC in all four paired rounds (JZ/JSC 0.403–0.437). Keep the indirect-gather path pinned and confirm on a quiet machine before refreshing the older public loss. |
   | synth | The scalar phase/envelope/biquad loop still trails JSC (paired median 1.110). Inspect polynomial speculation and the phase conversion in machine code; changes to generic sinking or scheduling belong in watr. |
   | vm | Near parity in this run (paired median 0.989; range 0.814–1.018). Recheck dispatch and dependent operand loads under stable load; this does not establish leadership. |
   | colorlog | Both public and fresh output remain checksum-DIFF. Measure the exp2 error separately from speed and preserve the documented numerical contract; do not count this as a correct-result win. |
   | crc32 | The dependent byte/table recurrence still trails JSC (paired median 1.302). Compare generated machine code and general dependency-chain transformations. |
   | delayline | Leads JSC in the public snapshot and in the fresh paired median (0.762). Keep the masked ring indices and feedback recurrence as regression controls. |
   | dict | Largest paired JSC gap here (median 1.441, range 1.093–1.562). Profile probe branches, repeated slot reads and address generation; existing integer narrowing alone does not close it. |

   These readings used the unchanged corpus, four alternating rounds per
   target, and the current uncommitted compiler tree. Large timing drift
   makes them diagnostic only. Reproduce with
   `JSC_BIN=~/.jsvu/bin/javascriptcore node bench/bench.mjs --targets=jz,bun,jsc,v8 --cases=resample,sdf,spmv,synth,vm,colorlog,crc32,delayline,dict --paired=4 --json=/tmp/jz-focus.json`.
   Keep the published snapshot unchanged until the tree passes its gates and
   quiet measurements support a refresh.

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
   A standalone array-growth trial removed the `alloc:false` restriction from
   the existing heap-top extension. A 100-element builder dropped from 1984 to
   1040 allocated bytes and its allocation/alias tests passed, but neither
   library's RSS gap closed. Watr's ordinary-tier timings regressed in four
   of five alternating pairs; fully optimized pairs were near parity. The
   trial is not retained. String aliasing is fixed through the binding-use
   census: only private builders may grow in place; typed and dynamic addition
   preserve retained operands. Across all five tiers, alias regressions and
   linear-allocation pins pass. A second raw-ABI growth trial after this fix
   leaves both libraries at 64 MB linear memory with no consistent speed gain,
   so it is also rejected.

   Safe string concatenation exposed quadratic decoding in Subscript's
   character-at-a-time lexer. Its shared span scanner now copies ordinary
   text in bulk and joins decoded escapes once. A 12000-unit literal in the
   self-hosted compiler takes 0.91 MB of front-half allocation instead of
   145 MB, with identical text. Subscript's full suite passes (377 tests,
   7 skips); long quoted/template/escaped literals also pass through the
   rebuilt kernel, including A → A → B reuse. This restores recursive
   front-half memory to 602 MB; shared copy-on-change front-end walks reduce
   it further to 566 MB. Carrier-only changes now retain the semantic
   summary; forwarding-only majority-kind clones are skipped using the binding
   census. Recursive compilation needs two summary solves instead of three.
   Literal folding also preserves unchanged subtrees. Interval branches retain
   their completed maps and share one hull join instead of copying both arms
   and materializing key unions. Its numeric-range phase allocates 93 MB, down
   from 183 MB. Named-function emission now ends at 3.349 GB, versus 4.064 GB
   before these changes. Startup emission completes at 4.211 GB. Closure
   deduplication now shares local numbering, hashes numeric bits without
   decimal strings, and redirects prefixed names without copying every local
   name. The recursive trace advances into WAT printing during assembly but
   still exceeds 4 GiB. All 20 kernel parity and nine reuse/error sequence
   cases pass; 28 representative outputs at O1/O2/O3/size remain byte-identical
   after the interval and deduplication changes. The recursive gate is open.
   Shallow Map copies now retain the existing probe layout when it costs no
   more than rebuilding. A 32-entry copy allocates 1808 B instead of 3728 B
   (compact layout 1552 B instead of 3216 B); sparse sources still rebuild.
   This saves another 23 MB before assembly, which now starts at 4.188 GB.
   The recursive compile still overflows while parsing runtime templates.
   The data suite passes 213 tests, all-tier reset checks pass 210 assertions,
   the affected Wasm-hosted checks pass 276 assertions, kernel parity passes
   20/20 and the instruction ratchet passes 10/10. Full CI remains required.
   Runtime templates now own their parsed IR directly: the old cache was
   cleared every compile yet still cloned each helper. Removing it preserves
   all 28 output comparisons and 20 kernel parity rows. Watr's token parser
   now slices completed source spans instead of concatenating each character.
   A 12000-unit token allocates 24 KB instead of 144 MB; its compiled parser
   shrinks by 2538 bytes. Quoted, ordinary and comment tokens share this path.
   All-tier allocation and internal location checks pass 95 assertions, 20000 differential boundary
   cases match (including errors and locations), and Watr's full suite passes:
   355 core, 31 propagation, 268 spec, 22 skips on both JS and Wasm backends.
   Kernel parity stays 20/20. Recursive compilation still reaches the 4 GiB
   ceiling after startup (4.187 GB); assembly attribution is in progress.
   The trace attributes another 31 MB to closure deduplication and 41 MB to
   helper reachability, leaving about 21 MB before helper parsing overflows.
   Scanning helper references without capture records saves 0.2–0.6 MB on
   representative compiler probes with identical bytes, but does not close
   the recursive limit. Increasing the compiler's dynamic-constructor capacity
   floor from two to four slots (leaving literal capacity unchanged) saves no
   memory and is not retained.
   Terminal character regex runs now omit impossible retries before capture-end
   markers and non-multiline end anchors. This preserves backtracking for other
   suffixes, lookarounds and multiline anchors; 684 targeted assertions pass
   across all five tiers. All 84 regex tests and 10 loop-cost checks pass,
   as do 414 targeted Wasm-hosted assertions and 20 kernel parity cases.
   Watr's size build falls another 150 bytes to 311026. The recursive
   compiler measurement and full CI for these final changes are pending.
   The scratch-set trial and optional transitive-callee-table idea did not
   explain enough allocation and were not retained.

   Seven paired CI rounds at `04431ef2` on Intel Xeon 8573C measure watr's
   peak at 121044 KiB (V8 76164), Jessie at 112356 KiB (V8 101056), and
   webaudio at 97352 KiB (V8 79348). These memory gaps remain. JZ/V8
   runtime medians are watr 1.114×, Jessie 0.719×, webaudio 1.538×,
   sort 1.029×, CRC32 1.251×, SDF 1.205× and noise 0.600×. The previous
   `7ea32282` run used AMD EPYC 7763, so its timing changes are not a clean
   code comparison. Every checksum matches. Watr's paired
   timings vary widely; these diagnostic rows do not establish its speed
   parity or replace the required full reference dataset. Its size-tier
   output is 311176 bytes, below the unchanged 320000-byte cap.

   Watr's code buffer now starts at 4 KB, using its existing geometric growth
   instead of reserving 64 KB for every assembly. The unchanged workload drops
   from 64 to 32 MiB linear memory and from 154656 to 116432 KiB median peak
   RSS across five alternating local rounds. Checksums match; four of five
   timing pairs improve, but loaded-machine timing is diagnostic. The existing
   exact framing tests now cover both sides of the 4 KB boundary; watr's full
   suite passes (353 core, 268 spec, 22 skips).
   Before this reduction its run ended at 153 MB RSS:
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

4. **VST follow-up after JZ v1.** The audio compiler's current README explicitly
   defers native release work until JZ v1 and requires verification from its
   installed tarball. The builder is JZ/macOS/mono-or-stereo.
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

## CI review, September 24

The CI candidate is on `codex/v1-review-ci-20260924`. V1 is not ready.
The prior gate evidence below describes its own tree, not this candidate.

- Fixed from the first CI run: inactive-frame analysis leaking representation
  facts under debug fuzzing; shared-memory function-arity setup; WASI tests
  accidentally exporting a void command entry; brittle SIMD instruction-count
  assertions (pixel parity remains); a built-in conformance case that now passes.
- Watr's scheduler moved a result-producing call out of its folded value
  position. JZ pins the tested public watr commit `5ed6b5d` until a release carries
  it. Both EventTarget speed-tier reproducers pass with this dependency.
- Runtime method dispatch now requires the correct receiver family. NaN and
  BigInt no longer enter array helpers via optional calls; missing methods skip
  arguments, while a null receiver's nonoptional property read throws first.
  Array searches evaluate their search value once, including empty input.
  The self-host spread-omission crash and diagnostic forwarding checks pass.
- Nullable numeric helper results retain their Number.isNaN proof. This lets
  the self-hosted optimizer normalize numeric NaN payloads instead of treating
  them as object tags. Module-initializer array construction passes again;
  null, undefined, finite numbers and signed NaN payloads have regressions.
- WAT output shares the binary pipeline's checkpoints. Watr prints fragments
  once per node: the 1.2 MB crPow WAT output is byte-identical, with printer
  allocations reduced from 2.81 GB to 107 MB. This does not reduce the earlier
  optimizer peak (1.69 GB in that case).
- The follow-up opt0 failures were inherited Object methods rejected by the
  new receiver-family guard. Registered Object methods now retain their generic
  receiver contract; string own-property checks use their string emitter.
- Watr's slot allocator now keeps implicit zeros when a nested branch bypasses
  a first assignment. This fixes O1 negative regex lookahead and the kernel's
  lone-CR parser rejection. Host import signatures also cross the kernel ABI;
  implementations remain in the host, including external-object results. Numeric
  constants retain signed zero, NaN and infinities across JSON transport; native
  and kernel imports accept zero-valued named/default bindings.
- CI at `a1e18874`: conformance and fuzz pass. The native matrix fails on
  the nullable typed-store regression; WASI also runs a JS-host-only test.
  The self-hosted suite has eight failures (the previous seven plus that store).
- The current fix ends address-CSE regions at branch exits and exception
  handlers, and keeps dependency invalidation valid across sibling arms.
  Nullable Boolean bindings preserve both their Boolean identity and nullish
  values. Call-argument BigInt boxing uses the existing semantic proof: a raw
  carrier for a possible BigInt does not prove that a Number or array is one.
  The external-object import test now follows the existing WASI exclusion.
- Both source-level loop-length scans are removed. Mutable bounds stay live
  until the IR optimizer proves invariance; stable strings and typed arrays
  retain their immutable-length optimization. The cached reassignment census
  invalidates static lengths on closure writes and loop-step rebinding.
- Shared method callbacks retain their semantic kind and separate IR per arm.
  Regex alternatives include the remaining sequence before committing a match:
  `f64|f64x2` followed by a dot now recognizes vector operators in self-hosted
  value numbering instead of dropping them from its value graph.
- Validation: 495 affected native tests pass (6804 assertions), plus 96 regex
  and value-number tests (810 assertions). A fresh normal self-host build passes
  all seven original failures and the nullable-store failure: 12 focused tests,
  2746 assertions. New boundary regressions pass at all five optimization tiers.
  The unchanged instruction ratchet passes 10/10. Full CI is still required.
  GitHub status reads are working again. No green-release claim is justified.
- A separate watr full-optimizer issue was reproduced with numeric branch
  depths through nested blocks (`br 2` becomes an invalid label after the full
  rewrite sequence). The local-slot pass now conservatively leaves numeric
  targets alone. JZ's named-label output does not exercise that separate issue.
- The size-tier follow-up measures watr at 312146 B against its unchanged
  320000 B cap, down from 323672 B at the start. Unknown lengths and numeric
  conversions share their runtime helpers; source inlining retains shared and
  exported bodies. The speed preset keeps its fast paths.
- Full CI on `a9ac1240` exposed a regression from its IR-copy change: 63
  self-host failures, mostly invalid i32-to-f64 conversions. The emitted union
  dispatch now uses the existing IR cloner and explicitly retains its f64
  result. An AST clone's generic metadata enumeration is the wrong contract
  here. Native opt3 and WASI each found one SIMD pin: the immutable-length
  proof excluded parameters. It now uses the shared local-or-parameter query.
  The default leg also found an outdated checkpoint assertion: WAT now shares
  the binary pipeline's stage marks and rewind. The updated test checks the
  rewind, executes the printed WAT and verifies diagnostics reset the marks.
  These fixes are awaiting the next complete CI run.
- The size tests also exposed an older unsafe parameter-coercion hoist:
  numeric uses do not prove valueOf pure, or license conversion before a
  zero-trip loop. Removing that hoist fixes repeated effects and throwing
  order while numeric export performance pins remain green.
- The union dispatcher selects the registered Map/Set handlers for shared
  method names and omits families excluded by the summary. Mixed collection
  forEach calls now return the same values as JS. No cap was relaxed.
  The first rerun passed 75 of 77 selected self-host cases. Its two remaining
  exceptions exposed a query treating an unresolved index as proof of an absent
  array element. Queries now retain possible element and named-property kinds;
  the solver still defers pending transfers. The regression includes both empty
  and populated arrays and verifies queries do not mutate solver state.
  Committed benchmark and memory evidence is stale; the repaired manual
  `bench-probe` workflow retains actual measurements as an artifact and fails
  when the runner produces none. It does not regenerate the release corpus.

The CI probe at `c58ef1f` (Linux x64 EPYC, Node 24, five paired runs) measured
JZ/V8 median time ratios: watr 0.8905, Jessie 0.7705, webaudio 1.4907, sdf
0.9432, noise 0.6075, crc32 1.0204, sort 1.0477, glyfparse 0.6920. Every
checksum matched. This is a diagnostic subset, not the complete release dataset.
Watr/Jessie process RSS was 154380/111584 KiB against V8's 96988/100196 KiB.

## CI follow-up, September 24

Candidate `be6a9f2f` closes the seven original self-host failures. The full
Wasm-hosted suite passes 3773 tests with one skip; its sole failure, also the
sole failure in opt0, opt3 and WASI, is an architecture assertion naming the
removed parameter-coercion hoist. That assertion is corrected in the follow-up.
The 71 self-compile round-trip tests, fuzz and test262 pass. Default also has
only that stale assertion (4722 pass, six skips). Bench passes 252 of 253;
its sole hard failure is alpha's old committed native row, 3.52x versus its
3.5x cap. Claims retains stale evidence reds.

Watr's fresh size is **312146 B**, below its unchanged **320000 B** cap.
All eight AS size losses in the old claims snapshot also pass fresh builds:
bezfit 2949/3017, fft 1707/1758, immutable 1221/1481, lz 1893/1910,
sdf 2082/2209, shapes 1509/1695, slices 1635/1657 and wordcount 3208/3480
(JZ/AssemblyScript bytes). These builds do not refresh old timing evidence.

The five-round CI probe on the same candidate (Linux x64 EPYC 9V74, Node
24.21) gives JZ/V8 median time ratios: watr 0.896, Jessie 0.679, webaudio
1.362, sdf 0.960, noise 0.625, crc32 0.997, sort 1.046 and glyfparse 0.694.
All checksums match. Watr/Jessie process RSS is 156072/111568 KiB versus V8's
98168/101008 KiB. This diagnostic subset leaves webaudio and sort speed and
both memory gaps open; it does not establish the complete release claims.

A boundary test for a possible load-reuse improvement exposed an existing
watr unclamp ordering defect: a select reads its index before its guard, but
an if reads it afterward. The shared optimizer now checks intervening writes
and retains skipped address effects and traps. Named and numeric slots, zero
length, negative/boundary indices, signed zero and NaN have regression tests.
Watr's full suite passes (353 core tests, 268 spec tests; 22 skips). The JZ
integration regression passes all four requested tiers (36 assertions), the
other 284 optimizer tests pass, and all ten perf ratchets pass. The updated
pin retains watr's 312146-byte size. Full CI must confirm this follow-up.

CI at `2f485a20` passes the default/opt0/opt3/WASI matrix, fuzz, both test262
suites, all 71 self-compile round trips and the full Wasm-hosted suite. The
subsequent recursive compiler-graph check traps after `emitFuncs`; this is
still a release blocker. A local trace confirms allocation overflow at
4294967256 bytes, with 4066072528 bytes already allocated after named-function
emission. Three summary builds consume roughly 0.5 GB each. Bench again passes 252/253 with the same committed
alpha native row failure. No timing or memory leadership claim is closed by
these functional results.

The string ownership fix passes 584 affected tests (10820 assertions), the
five-tier alias/allocation sweep (987 assertions) and all ten instruction
ratchets. Watr's size before the smaller dependency buffer is 311541 bytes,
605 bytes smaller. Full CI must validate this follow-up.

CI at `7ea32282` passes default, opt0, opt3, WASI, fuzz, conformance,
self-compile round trips and the full Wasm-hosted suite. The self workflow
fails only its recursive memory check; claims still rejects the stale benchmark
evidence. The subsequent traversal and interval changes require full CI.

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
