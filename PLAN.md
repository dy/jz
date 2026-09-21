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
  (`writesOuter`, `arenaUnsafe`, `callsUnknown`, transitive callees). No pass
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

- subscript ^10.8.0 and watr ^5.11.1 from npm; 5.11.1 carries the two
  optimizer rules the speed rows rely on (the mixed-sign truncation-of-convert
  fold for base64, `ifset` declining a branchy condition for sort), so a clean
  install reproduces the standings.
- CI runs one self-compile workflow (build, round-trip, the suite through
  `dist/jz.wasm`, the recursive check). The self-compile perf gate is
  `npm run test:self:perf`, a local release step.

## Remaining release work

1. **Typed-array property semantics.** Closed. Named keys route through
   property storage and canonical numeric keys through element conversion;
   assignment values, aliases, views, missing keys and reference evaluation
   order have differential regressions, and the typed/static output checks
   pass at their unchanged caps. Preserve these semantics unless the public
   contract changes; never narrow an exported parameter to satisfy a size
   check.

2. **Runtime and self-host speed.** The self-compile gate passes (warm
   0.954× against the 1.03× cap, fresh 0.763× against 0.99×). The compiler's
   own profile is flat (Map/Set probes and hashing 15%, pointer decoding 3%,
   the AST visitor 4.5%); call-site wrapper isolation, blanket forwarding
   inlining, a leaf-skipping visitor, closure-property precision and extended
   duplicate-read reuse each measured nothing and were removed, so a retry
   needs a new measurement first.

   Against V8, the corpus wins everywhere but webaudio, colorpq and watr.
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
   (8%). colorpq (4.4×):
   twelve runtime-exponent pow calls per pixel, jz's pow bit-exact with V8
   and about 3× its time per call; the lever is a two-wide pow that keeps
   the bits. watr: the tier-up above.

   Against the fastest rival Wasm (`WASM_TODO` in `test/bench.js`): sdf's
   bounds checks are 72% of its gap and its scratch cursor's bounds come from
   sentinels in a mutable array, so a relational or sentinel hull is the
   proof it needs; glyfparse's checks cost nothing and its lever is an i32
   representation for the ToInt32-blind checked byte reads; noise stands at
   1.13× of Rust with an instruction census at parity; shapes at 1.12× is
   untouched; sort is at parity with Zig. percolation (0.69× against its
   0.75 floor): `find` and `union` take f64 parameters because `y * w + x`
   is f64 from host numbers, so the path-halving chase converts on every hop.
   It needs the index-chase lowering: an i32 loop whose checked reads stay
   i32 under integer-tolerant consumers, with the generic loop left for an
   out-of-range hop.

3. **Memory.** webaudio holds 70.3 MB of resident memory against V8's 70.6
   (paired, node against node, this tree; 151 before): the automation loops
   rewind per sample once the census named the class functions their
   receivers reach, the tuple destructuring read by index, and the link pass
   judged the loop's own tape. jessie and watr still peak at 170 and 157
   against V8's 98 and 77: one jessie parse keeps 25 MB of `loc` sidecars
   (a 240-byte hash per AST node for one number) and 67 MB attributed to
   whitespace skipping; one watr assembly keeps 39 MB of 64 KB code buffers.
   Those are retained by design, not temporaries: the lever is a compact
   named-property slot for arrays (a record beside the elements instead of a
   hash) and a size-classed reuse of replaced buffers, then measure the two
   cases before quoting memory.

4. **Reproducible speed, size and memory evidence.** `bench/results.json` is
   stale: timed above the 4096 MB swap-validity cap, 43 comparable
   Porffor/TinyGo rows against 44 required, and alpha's w2c row no longer
   describes the tree. Regenerate through the benchmark runner on quiet
   reference hardware with the current compiler and memory-baseline
   provenance; keep TinyGo 0.42.0 and the same-machine Porffor comparison.
   Local paired timings and standalone size sweeps are diagnostics, not
   release evidence.

5. **Public VST scope and identity.** The builder is JZ/macOS/mono-or-stereo.
   Porffor needs a public state-object adapter and build verification. Choose
   the permanent vendor root before publishing derived class IDs.
   Restart-flagged edits take effect on next setup; active restart needs the
   component-handler interface. Events and wider layouts remain refused.

6. **Proof and independent review.** Reachable dynamic calls can still make
   static allocation and work proofs unknown. Empirical block checks
   establish neither allocation freedom for all inputs nor callback
   deadlines; reuse entry-range facts for useful bounds, since a full-i32
   domain proves no deadline. Present the pinned candidate and complete gate
   evidence for independent review; implementation alone is not expert
   approval. Bump watr once its release carries the two rules above.

## Gate evidence — September 21

- Loop rewinds and shared-memory preflight (this commit): core suite
  4545/4546 with one skip, self-compile 68/68, import lint clean, the
  perf ratchet re-baselined for the per-iteration heap restores (nest 16691,
  slice 69760, ring 54040). `test/bench.js` on the final tree: speed geomeans
  0.476× of V8, 0.701× of C, 0.482× of AssemblyScript, size 0.785× of
  AssemblyScript, the examples corpus 1.41× with 19 of 21 winners. webaudio,
  paired alone: 1.87× of V8 (2.15× before) and 70.3 MB resident against
  V8's 70.6 (151 before); one render allocates 87 MB and keeps 9. Ten red
  rows, every one a standing above or noise: sdf's win pin at 1.015×, watr's
  trail at 1.39× (five paired alternations against the pre-session tree
  read 1.14–1.29× there and 1.14–1.59× here, rounds from 1.04× to 1.78× on
  both; the loop-body op count of its compiled module differs by 62 in
  `normalize` of 83514, the tier-up above is the ratio), glyfparse, sdf,
  sort, noise and radixsort against the fastest wasm, TinyGo's builds,
  alpha's w2c row, and percolation at 0.71× under the examples' 0.75× floor
  with output identical to the pre-session tree (0.67–0.71× alone on this
  machine today: the floor's evidence needs the reference machine).
- Core suite 4531/4532 with one skip (`test/index.js`), self-compile 68/68,
  import lint and public types clean; `bench:size` geomean 0.785× of
  AssemblyScript with 0.1% `wasm-opt` slack; the size pins carry the
  `jz:brand` bytes.
- Speed geomeans, paired in a fresh process: 0.476× of V8, 0.705× of C
  (Clang), 0.487× of AssemblyScript; the examples corpus 1.44× of V8 with
  19 of 21 winners. watr 1.14× (`trail`, the tier-up above), jessie 0.99×
  (`tie`). Every corpus case beats V8 except webaudio (2.2× paired at 10.4
  ms, 9.1 ms in-process after reachability; the perf gate does not time
  it), colorpq and watr.
- Eleven red rows on the final tree, every one a standing this round did
  not touch or a noise band: the fastest-wasm rows glyfparse 1.23× and sdf
  1.48× (item 2 above; the noise and shapes rows are green), sort's 1.18×
  of Zig (Zig's own run moved from 5.09 to 4.71 ms between gates; paired
  alone the row reads 1.04× and 1.06×, and the build carries no change from
  this round), the 1.05× band's edge (crc32, delayline, levenshtein,
  bezfit), percolation 0.69× under the examples' 0.9× floor (item 2),
  ulam's 0.77× (V8's own frame moved between 578 and 736 µs across runs;
  the pre-session commit and this tree read 1.01× and 1.00× side by side),
  alpha's stale w2c row and the TinyGo builds (item 4).
- watr 5.11.1, published, replaces the checkout link: sort reads 1.09× of Zig
  and base64 0.81× of AssemblyScript paired with the installed package.
- Correctness closed on this tree: open-object enumeration order with
  integer keys, class identity across modules sharing memory (`jz:brand`),
  nested compilation from a warning callback, the declared-keys pass through
  registration calls (jessie's comment loop) and its stand-downs (a reaching
  call, a callee that reaches, a callee the census cannot see, an alias, a
  callback argument, a parameter default), a specialization clone sharing
  its origin's body, a rest-parameter function property called positionally,
  `'m' in o` for class members.
