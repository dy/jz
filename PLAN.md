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
  `whyNotRewind` names each declined candidate.
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
   webaudio (9.8× → 7.6×, web-audio-api 1.5.6): the library's classes were
   closures, since every base class lives in another module; they are
   schemas now, and the remaining time is the dynamic dispatch of a few
   receivers the summary still loses. The `shape-lost` census names the
   roots in order: the node classes lose their layouts through a cycle
   (`this._outputs` read on the 22-class family joins an unknown value in
   `_wake`; a port stores its node into a lost layout; a lost layout escapes
   the arrays and maps its slots hold, which every instance shares, since a
   class initializer allocates once for the whole family); the emitter
   listener maps of `EventTarget` are one cell for every instance, so one
   lost instance loses every listener; an `.add(fn)` on an unknown Set
   receiver calls `AutomationEventList.add` with a closure, and the
   automation events read dynamic from then on. The levers, in order: the
   family read that joins unknown (find the member whose slot is unknown),
   allocation cells keyed by the receiver's class for class initializers, and
   candidate calls that do not merge arguments a candidate's parameter cannot
   hold. Then the accessor dispatchers (`type`, `value`: an own-property probe
   and an `instanceof` chain per read) and the generic typed-array element
   helpers in the DSP loops. colorpq (4.4×): twelve runtime-exponent pow
   calls per pixel, jz's pow bit-exact with V8 and about 3× its time per call;
   the lever is a two-wide pow that keeps the bits. watr: the tier-up above.

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

3. **Reproducible speed, size and memory evidence.** `bench/results.json` is
   stale: timed above the 4096 MB swap-validity cap, 43 comparable
   Porffor/TinyGo rows against 44 required, and alpha's w2c row no longer
   describes the tree. Regenerate through the benchmark runner on quiet
   reference hardware with the current compiler and memory-baseline
   provenance; keep TinyGo 0.42.0 and the same-machine Porffor comparison.
   Local paired timings and standalone size sweeps are diagnostics, not
   release evidence.

4. **Public VST scope and identity.** The builder is JZ/macOS/mono-or-stereo.
   Porffor needs a public state-object adapter and build verification. Choose
   the permanent vendor root before publishing derived class IDs.
   Restart-flagged edits take effect on next setup; active restart needs the
   component-handler interface. Events and wider layouts remain refused.

5. **Proof and independent review.** Reachable dynamic calls can still make
   static allocation and work proofs unknown. Empirical block checks
   establish neither allocation freedom for all inputs nor callback
   deadlines; reuse entry-range facts for useful bounds, since a full-i32
   domain proves no deadline. Present the pinned candidate and complete gate
   evidence for independent review; implementation alone is not expert
   approval. Bump watr once its release carries the two rules above.

## Gate evidence — September 21

- Core suite 4528/4528 (`test/index.js`), self-compile 68/68, import lint
  and public types clean; `bench:size` geomean 0.785× of AssemblyScript with
  0.1% `wasm-opt` slack; the size pins carry the `jz:brand` bytes.
- Speed geomeans, paired in a fresh process: 0.472× of V8, 0.706× of C
  (Clang), 0.485× of AssemblyScript; the examples corpus 1.42× of V8 with
  19 of 21 winners. watr 1.14× (`trail`, the tier-up above), jessie 0.94×
  (`tie`). Every corpus case beats V8 except webaudio (7.6× paired, module
  476 → 287 KB; the perf gate does not time it), colorpq and watr.
- Twelve red rows, every one a standing this round did not touch or a noise
  band: the fastest-wasm rows glyfparse 1.25×, sdf 1.25×, noise 1.14× and
  shapes 1.14× (item 2 above), sort, crc32, delayline and levenshtein at
  1.05× and bezfit at 1.055× (the band's edge; sort is 1.04× of Zig paired),
  percolation 0.71× under the examples' 0.9× floor (item 2), alpha's stale
  w2c row and the TinyGo builds (item 3).
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
