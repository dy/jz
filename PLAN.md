# JZ v1

Compile audiojs.dev DSP through JS → Wasm → VST, with the compiler selected
at build time. Release requires correct audio, reproducible installation and
passing conformance, speed, size and memory gates. README owns the public
contract; CONTRIBUTING owns compiler invariants. This file holds the decisions
that shaped the tree, the work left before release and the latest gate reading.

## Release status, September 25

**V1 is not ready to tag.** Published watr 5.11.6 is installed and locked.
The earlier compiler graph passed recursive self-compilation and the full
core, opt0, opt3 and WASI matrix. The subsequent shared WAT checkpoint path
passes the current full core suite and checkpoint tests; the remaining matrix
and kernel attestation need renewal. Fresh release performance evidence and
the Jessie/watr memory gaps remain open; no release cap was relaxed.
Reference evidence can now be measured and strictly checked in CI.

| Gate | Current evidence | Remaining action |
| --- | --- | --- |
| Dependency | Official npm watr 5.11.6, pinned by lockfile integrity; no local dependency override. | Keep the registry artifact through final verification. |
| Correctness | Current full core passes 4803 tests / 125292 assertions, with no TODOs. Release-evidence tests pass 5 / 48; checkpoint tests pass 9 / 112. The matrix has advanced to opt0. Prior matrix: opt0 4552 / 96884, opt3 4552 / 97349, WASI 4605 / 110058; self-compile 74 / 2472. | Finish the remaining matrix and renew self-compile verification. The former rest-spread TODO passes execution checks across O0–O3, WASI, and the Wasm-hosted compiler. |
| Recursive bootstrap | The prior graph passed functional, sequence and recursive gates. Its recursive compiler is 18903703 bytes and executes its probe to 19. Final heap: 1174270400 bytes; headroom: 3120696896 bytes. | Renew the attestation after the shared WAT checkpoint change. The compiler reserves 4 GiB for the checkpoint lane; heap headroom does not certify RSS parity. |
| Conformance | Final-tree runs pass: language 3195 passes, 4045 correct rejections, zero unexpected failures, two documented ordering exceptions; builtins 880 passes, zero unexpected failures, 43 expected failures. | Cleared for the supported subsets; these do not establish full test262 coverage. |
| Build/package | Browser assets and all 81 examples build; types pass. Package dry run includes both JS bundles and excludes the compiler Wasm. | Repeated after the function-order fix; cleared for this tree. |
| Size | All 59 speed and size checksums match after the linker-order fix; all binary sizes are unchanged. Current size binaries are smaller than the stored parity-valid AssemblyScript artifacts on all 50 comparable cases (geomean 0.779×), including all eight old recorded losses. | Refresh pinned reference evidence; the private size comparison does not update the public snapshot. |
| Performance claims | Last stored-evidence run: 7 pass, 16 fail, including uncommitted compiler inputs. The 58 JZ rows, rival coverage and memory evidence still need renewal; the snapshot carries 14738.81 MB swap, above the 4096 MB limit. | Run `bench` with `reference=true` against the committed compiler; close every strict failure in the retained artifact before release. |
| Rival coverage | Entity checksum 1275530752 matches JZ, Node, native C, Go-Wasm, Zig and Porffor. Go/Zig resample match 1711808418. TinyGo 0.42.0 with Go 1.26.0 passes all 45 comparable cases. Native Go/Porffor resample FMA variants are independently verified. | Refresh all 45 rows for each rival on the reference machine. |
| Web Audio | Fresh JZ and Node runs match checksum 2866527759; the stored mismatch is stale. | Refresh reference evidence. |
| Memory | Latest paired diagnostic readings: Jessie 106.7 MiB vs V8 98.7 MiB; watr 150.0 MiB vs V8 75.1 MiB. The allocation reductions have not closed those gaps. | The CI reference gate now requires each allocation-heavy case to use no more peak RSS than V8. Fix any measured loss before release. |

The recursive build now fits through general allocation reductions: diagnostic
work only when requested, reused interval maps and summary views, no copied AST
declaration tails, one emission after failed static probes, captured cells only
on paths that use them, and numeric formatting that retains only its result.
Closure dedup hashes numeric bits and shares canonical declaration ordinals.
Minimal allocation tests pin the individual shapes; compiler input sources and
benchmark kernels remain unchanged.

Checkpoint serialization exposed a separate correctness defect: the writer
could wrap past wasm32's end before its final capacity check, overwriting static
state and heap diagnostics. Each write now checks its complete extent first;
reads use the recorded stream end retained across rewind. Integer lengths,
indexes and payloads use bounded unsigned LEB128. The boundary test covers all
five widths, empty and repeated checkpoints, truncated headers/payloads,
overflowing encodings and allocation collisions (456 assertions across O0–O3).
The final review adds missing-final-byte cases for every multi-byte reader and
checks that rejected partial writes preserve both bytes and the cursor.
The expanded memory sweep passes 88 tests / 1742 assertions across O0–O3;
the subsequent full core run passes 4749 tests / 120287 assertions, with the
same existing TODO and no compiler changes since the matrix above.
The worker also waits for its JSON report to drain before exiting, and preserves
the original compile failure if its diagnostics are damaged.

The full-suite exception failure came from address/tag CSE exporting an
initializer across an exit that could bypass it. Regions now close at abrupt
block exits and exception boundaries, while blocks without exits retain reuse.
A minimal branch kernel returned 88, 0, 0, 88 before the fix and 88 on every
path after it; both cache families are pinned against unoptimized Wasm. The
caught typed-store program matches Node through normal, throw and recovery
calls at every tier. The integer-loop assertion now checks integral locals
after slot reuse instead of requiring the optimizer to keep a particular name.

Native/kernel parity exposed a non-transitive function-order comparator: a
user function compared equal to two runtime helpers that compared unequal to
each other. Tied runtime functions now precede tied user functions, with
name order within the former and source order within the latter. Direct tape
tests cover empty, singleton, interleaved and repeated ordering; the self gate
checks native-identical bytes at O1/O2 through A → A → B → A compiles. The
59-case speed and size sweep changes eight binaries in each tier, with no
size or checksum changes.

## Performance priorities

**Active focus, September 24:** resample, sdf, spmv, synth, vm, colorlog,
crc32, delayline and dict. Recontest all nine against both Bun and the
standalone JSC shell. The vm/dict/crc32 claim exception remains a
regression band, not a reason to stop optimizing these cases.

| Case | Current diagnosis and next proof |
| --- | --- |
| resample | Four adjacent taps depend on a floating phase. Removing checks via a scratch dyadic enclosure saved bytes but gave 1.015× runtime. Further controls also fail to establish a gain: constant pooling gives 0.977× normally / 1.079× with V8 optimization forced; reading those globals once at function entry gives 1.087× / 1.096×; disabling the two-way unroll gives 1.019× / 1.160× (six pairs each). Keep all out. The engine contest is noisy: JZ/JSC medians 1.118 then 0.959; the latter spans 0.593–2.022. A private WAT-only two-output SIMD experiment preserves the exact phase additions and checksum, with 10-pair after/before medians 0.852 normally and 0.781 with V8 optimization forced; binary 2336 → 2390 bytes. The temporary rewrite assumes even lengths and disjoint buffers and was removed after measurement. Next extend general gather packing with proven alias guards and scalar tails before considering production. |
| sdf | Sentinel copies lost their locals' summary kinds, introducing generic conversions and property dispatch. Preserve the original kind through the existing alias query, including missing values. Disabling only this fix produces 15746 speed-tier bytes versus 3420; six pairs gave after/before 0.846. The earlier JZ/JSC 1.191 gap becomes 0.998 in the latest noisy four-round contest (0.903–1.161), which does not establish leadership. Next isolate guard placement and dependent gather checks. |
| spmv | Leads JSC in every round of both contests: earlier JZ/JSC 0.403–0.437, latest 0.421–0.481. Keep the indirect-gather path pinned and confirm on a quiet machine before refreshing the older public loss. |
| synth | Implemented as lazySelect in published watr 5.11.5: defer costly pure initializers to exclusive value arms before local reuse. Fresh six normal and six forced-optimized pairs both give 0.740× runtime; checksum 41574153 is unchanged. Speed grows 1676 → 2509 bytes; default/size stay unchanged. Of 59 standalone cases, the other 58 are byte-identical with the pass off/on. Four engine rounds favor JZ (JZ/JSC 0.793, JZ/Bun 0.828); an isolated six-round repeat remains favorable on median (0.911 / 0.893) but includes losses, so stable JSC leadership is still unproven. Watr source/Wasm suites and all 71 self-compile tests pass. Review also fixed partial-operand stack handling in the shared guard, with regressions for lazy select, value numbering and scheduling. JZ now depends on published watr ^5.11.6; fresh builds of all 59 cases in both speed and size modes match the verified candidate byte for byte and retain every checksum. |
| vm | Earlier near parity (JZ/JSC median 0.989; range 0.814–1.018); the latest four rounds lead at 0.863–0.950. The binary is unchanged by lazySelect. Keep dispatch and dependent operand loads under review; these noisy readings do not justify removing the claim exception. |
| colorlog | Checksum 297103274 still matches the existing exp2 exception in test/bench.js (within 1 ulp of V8, separately checked against a 200-bit reference); the JS engines give 3137122272. Preserve that numerical gate when optimizing the table/polynomial path. The runner correctly excludes this case from checksum-identical paired rankings. |
| crc32 | The dependent byte/table recurrence still trails JSC (latest paired median 1.401). V8 emits a wrapped 32-bit table-base addition before its load; JSC uses a native base plus scaled index. Adjacent-byte load widening regresses six normal / six forced-optimized pairs to 1.030× / 1.070×; moving the byte mask inside XOR gives 1.018× / 1.002×. Both stay out. A private WAT-only static-data experiment removes that base addition: ten paired after/before medians are 0.873 normally and 0.920 with V8 optimization forced, checksum 304463882 unchanged; binary 1485 → 2514 bytes. The experiment leaves runtime table construction in place and redirects only the fixed corpus reads. Next prove constant initialization and nonescape generally before adopting static placement; the experiment alone is not a compiler transformation. |
| delayline | Leads JSC in the public snapshot and both private contests (latest four-round median 0.862, every round below 1). Keep masked ring indices and the feedback recurrence as regression controls. |
| dict | The JSC gap persists: latest four-round median 1.408, isolated six-round repeat 1.350 with every round slower. The earlier slot-cache experiment removed two instructions but regressed ten normal pairs to 1.266× and ten forced-optimized pairs to 1.188×; keep it out. The V8 median moves from 1.200 to 0.748 between the two new contests, so leadership is not certified by these noisy readings. Next inspect branch prediction and address generation; fewer emitted loads alone do not prove faster execution. |

The initial nine-case readings used the unchanged corpus, four alternating
rounds per target, and the current uncommitted compiler tree. Later controlled
experiments are identified in the rows above. Large timing drift
makes them diagnostic only. Reproduce with
`JSC_BIN=~/.jsvu/bin/javascriptcore node bench/bench.mjs --targets=jz,bun,jsc,v8 --cases=resample,sdf,spmv,synth,vm,colorlog,crc32,delayline,dict --paired=4 --json=/tmp/jz-focus.json`.
Keep the published snapshot unchanged until the tree passes its gates and
quiet measurements support a refresh.

Before the release fixes above, the integrated matrix reproduced baseline
failures (core/opt0/opt3/WASI: 3/3/5/13). The corrected tree now passes all four
legs with the scheduler-only candidate, plus self-compile and both conformance
subsets. The complete optimizer candidate separately passes self-compile.
Watr 5.11.6 is now published and locked; the release-status table above tracks
the registry-package verification. Private candidate results remain historical.

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

- subscript ^10.8.0 and watr ^5.11.6 from npm; watr carries the two
  optimizer rules the speed rows rely on (the mixed-sign truncation-of-convert
  fold for base64, `ifset` declining a branchy condition for sort), so a clean
  install includes those rules and the lazy-select/partial-operand fixes.
- CI runs one self-compile workflow (build, round-trip, the suite through
  `dist/jz.wasm`, the recursive check). The self-compile perf gate is
  `npm run test:self:perf`, a local release step.

## Remaining release work

1. **Runtime and self-host speed.** Close the red rows listed in the gate
   evidence below, plus webaudio and watr. Caps stay unchanged; benchmark
   sources stay fixed. Paired local measurements on this loaded machine
   are diagnostics, not release evidence.

   The active nine-case work is listed under [Performance priorities](#performance-priorities).

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
     the boolean `a && b` / `a || b` (included in watr 5.11.5): each
     guarded SDF exit becomes one fused compare-and-branch per conjunct, and
     V8's `edt1d` drops 565 → 556 instructions and 11 → 2 `cset`s with the
     checksum unchanged. The shorter code is not faster: paired runs at load
     9 measure SDF 2.8–3.7% slower, with `edt1d` differing only in the
     `cset`s; glyph parsing measures 3% and sort 7% faster, LZ 2% slower,
     trace level. Almost every benchmark binary shrinks, the self-compiled
     compiler by 14.5 KB. JZ now receives it from the published dependency.
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

   Paired diagnostic readings after the formatter/allocation work are Jessie
   106.7 MiB vs V8 98.7 MiB and watr 150.0 MiB vs V8 75.1 MiB. Both gaps
   remain open. The measurements below record the earlier allocation work.
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
   A current watr allocation trace counts 58.9 MiB in 300214 allocations;
   37.2 MiB comes from `makeByteBuf` and the per-assembly 64 KiB code buffer
   plus 4 KiB scratch buffer. These are local buffers, not module bindings;
   the bump arena retains their storage. The loop cannot currently rewind:
   `assemble` reaches unclassified calls and persistent encoder memo tables,
   as well as module error-source state. Recognizing `Uint8Array.from` alone
   would not prove that rewind safe. Closing this gap needs lifetime proof
   for individual temporary buffers, while preserving returned bytes and
   those persistent roots. Keep the dependency and benchmark input unchanged.

3. **Reproducible speed, size and memory evidence.** `bench/results.json` is
   stale: timed above the 4096 MB swap-validity cap, only 43 comparable
   Go-Wasm/Zig-Wasm/Porffor rows and no valid TinyGo rows against the current
   45-row coverage floor, and alpha's w2c row no longer
   describes the tree. Regenerate through the benchmark runner on quiet
   reference hardware with current compiler and memory-baseline provenance.
   Keep TinyGo 0.42.0 and the same-machine Porffor comparison. Local paired
   timings and standalone size sweeps do not replace this evidence. After the
   final matrix, this host still reports 19621.44 MiB of swap, above the
   4096 MiB evidence-validity limit.

   The manual benchmark workflow now measures six paired rounds on CI and
   runs `test:claims` against that exact JSON, retaining results and logs even
   on failure. Linux swap is measured from `/proc/meminfo`. Paired RSS includes
   both positions and rejects missing readings. The claims gate requires the
   complete corpus, ancestor commit provenance and valid machine metadata.
   Jessie, watr and Web Audio each have a strict JZ/V8 RSS floor.
   RSS provenance covers both JZ and V8 even without timing measurements;
   explicit invalid row stamps cannot borrow fresh snapshot metadata.

   Latest benchmark CI run 36109730855 failed only the stored alpha wasm2c
   ratio (3.52× against a 3.5× cap). Native reference checks now live with the
   other claims, retaining the 20-row coverage, 3.5× per-case and 1.35× geomean
   caps. The manual run measures wasm2c before checking them, so stale evidence
   cannot prevent its own refresh. No reviewed-tree reference run has run yet.

   The earlier TinyGo build covered all 44 cases then available. Forty-three
   match committed checksums; entity's 1275530752 matches the separate V8 reference run.
   That build defect is closed; the expanded 63-case corpus now requires 45
   comparable rows, so both coverage and committed evidence still need work. The latest
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
