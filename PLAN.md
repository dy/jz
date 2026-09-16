# JZ v1

Compile audiojs.dev DSP through JS → Wasm → VST, with the compiler selected
at build time. Release requires correct audio, reproducible installation and
passing conformance, speed, size and memory gates. README owns the public
contract; CONTRIBUTING owns compiler invariants.

## Implemented

- Binding/use census, allocation-site summaries and settled representation
  plans feed one lowering pipeline. Watr owns generic propagation, folding,
  LICM, local-slot allocation and the final optimizer; no additional IR layer.
- UTF-16 strings, shared exact integer conversions, proven builder capacities
  and lengths, guarded i64 accumulators, generic SIMD and scalar optimizations.
- Closure argument facts and disjoint ProgramIndex identities, scoped active
  function state, recycled iterator bindings and recursive self-compilation.
- Coercion, method lookup, enumeration and internal errors preserve JS effects.
  Nullish field/index reads and writes now throw instead of decoding memory.
  Computed object keys retain evaluation and conversion order. Generated Wasm
  and interop must be rebuilt together for the private error transport.
- Summary fields retain construction identity, side properties, bounded shape
  sets, collection cells and positional rest facts. Pending effects propagate
  only when changed; the redundant layout-set census is removed.
  Construction and layout IDs index field rows directly instead of hashing them.
  Passive arguments are proven in one walk per function, including direct
  forwarding and field predicates. Testing a field does not merge unrelated
  layouts' unused values; defaults, accessors and escaping uses stay conservative.
  Tuple positions retain nested shapes through array literals, rest arguments
  and collection entries. A mixed dynamic read, mutation, union or host escape
  exposes their identities to effects; constructing the tuple alone does not.
- All prepared, imported, synthesized and specialized functions share one
  constructor. Variant queue entries are records. Function registries and
  active frames use the same constructors initially and at reset; registry
  lookups and export queries no longer allocate intermediate entry arrays.
  Inlining builds its exported subset once per pass and reuses body maps for
  membership and nested-call hoisting.
- Array-pattern parameters use the existing positional initialization path
  for ordinary functions and generators, avoiding synthetic rest allocation.
  Object-only patterns retain their existing lowering; generalizing that path
  exposed a parser ambiguity in block statements followed by arrows.
- Concatenations retain cached hashes, Map/Set probes reuse their capacity
  load when following relocation, wide schemas use a static key index, and
  dynamic reads beyond the specialization budget retain an inline cache.
  Numeric/pointer hashes mix into low bucket bits, avoiding the quadratic
  clustering of consecutive integer-valued doubles. Dictionary and proven Map
  updates share one lowering and upsert implementation, removing a duplicate
  grow/probe loop and repeated get/set probes.
  Map reads depend on hashing/equality directly instead of mutation helpers.
  Slot fusion declines throwing/effectful RHS and object key coercion. Nullable
  coercion reads once, avoiding duplicated key conversions and table probes.
- Schema indexes write binary words directly, preserving capacities and signed
  relative offsets through self-compilation. JSON's schema cache explicitly
  clears reused arena storage; repeated object-form compiler options stay intact.
  Runtime-table setup resolves declared helper dependencies before selecting
  tables, so an indirect object write updates the same slot as a static read.
  Template constants are still generated later, preserving dead-data removal.
  Source inlining preserves spread calls for runtime argument marshalling.
- Stateful native VST lifecycle fixtures, block-size/automation checks,
  allocation counters and concurrent processing exist. Public VST scope and
  proof limits remain below.

The handoff has been folded here and removed. Watr remains pinned
to `d6d140d`; Subscript to `0f65c86`.

## Candidate verification — September 16

Current full matrix: core 4337 passes (69574 assertions), O0 4143, O3 4143,
WASI 4195; each has one skip and zero failures. New regressions cover bounded
element reads through scalar locals and load-reuse temporaries, empty arrays,
boundary misses, wrapped stores, large squares and negative zero. The focused
compiler run passed 521 cases; the kernel's empty → A → A → B → A sequence
preserves bytes and results for the new kernels. No product cap changed.
Logs use `/private/tmp/jz-load-bounds-final-` (core is `final-matrix.log`).

Current self-host functional suite: 52 passes, 2333 assertions. Current
language conformance reports 3151 positive passes, 4045 negative
rejections and 8 expected failures; built-ins reported 874 passes and 45
expected failures, both with zero failures. Import lint passes.
Public types passed on the preceding candidate; no public signatures changed.

The preceding kernel passes provenance, byte parity, recursive compilation, reuse,
error recovery and all 28 memory comparisons within the existing 10% band.
The manifest is `/private/tmp/jz-rest-final-candidate.json`, compared against
`/private/tmp/jz-finish-candidate.json`. Recursive compilation uses 1555927920
heap bytes and emits 15308343 wasm bytes. The shared upsert removes roughly
21 KB from the kernel; paired warm timing is unchanged (1.002×).

The current full size sweep beats AssemblyScript on all 51 comparable cases at
0.778× bytes (`/private/tmp/jz-load-bounds-sizes.log`). Current affected size checks keep Watr below 300000 bytes and
JSON below 12500. This does not refresh committed benchmark rows.
Evidence logs use `/private/tmp/jz-rest-`.

Current self-host timing: warm 1.093×/1.134×/1.146× against 1.03× (fails), fresh
0.886× against 0.99× (passes). Logs: `/private/tmp/jz-load-bounds-self.log` and
`/private/tmp/jz-load-bounds-self-perf.log`. The kernel is 15871642 bytes
(+0.06% from the previous candidate). Tuple precision, inline-map
reuse and export enumeration showed no meaningful paired timing improvement.
The numeric hash removes a separate severe defect: isolated Map fill/read
workloads improved about 5–51× for 128–4096 sequential keys, while aggregate
warm compilation remained unchanged. The Map counter now uses one probe per update, sharing dictionary fusion's
effect proof and the ordinary upsert generator. In an alternating paired run
of 100000 updates, fusion reduced time from 1.226 to 0.699 ms (0.570×); V8
took 0.882 ms (JZ/V8 0.793×). Both compiler variants and V8 returned 4799685.
The same source shrank from 29183 to 28835 bytes. These are local diagnostics,
not refreshed benchmark evidence. Logs use `/private/tmp/jz-map-fusion-`.
An alternating baseline/candidate run for the passive-summary cleanup measured
0.984× warm compile time over the six self-host cases, with byte-identical
outputs. Kernel size moved from 15856275 to 15862819 bytes (+0.04%); the
comparison includes the spread and runtime-table correctness fixes. This
modest improvement does not close the warm gate. Logs use `/private/tmp/jz-passive-`.
These are diagnostics, not release attestations. The current committed-evidence
audit records 15830.94 MB of swap, above the 4096 MB validity cap. No cap was relaxed.

The current compiler passed the stateful native VST fixture: 12438 checks,
4000 concurrent blocks, zero sample error and fixed callback heaps. The public
compile-vst package's 29 tests also pass, including three real bundle builds.
These tests do not prove callback deadlines.

## Remaining release work

1. **Warm self-host speed.** Close the remaining roughly 6–12% gap without
   changing the 1.03× cap. Uniform function records and positional collection
   flow are implemented. `ctx.funcs` has an exact layout; `createFunction().sig`
   and `ctx.func.current` still join to unknown. Passive export predicates and
   unused `opts.locals` reads no longer lose these shapes. The next traced
   loss is the unresolved `reachableForLowering` callable read from
   `programFacts.programIndex`. Isolating profiling wrappers at call sites did not restore that
   precision and was discarded; do not assume it is the sole cause.
   The previous profile attributes about 14% to Map/Set probes and 5% to
   pointer decoding. General primitive get/set fusion is now implemented; it
   requires unchanged Map methods and a non-observable, non-throwing RHS.
   Object-building and effectful updates retain ordinary probes. Blanket
   forwarding inlining was measured slower and discarded.
   The latest trace confirms that `collectProgramFacts` and `buildProgramIndex`
   return exact records, but polymorphic timing callbacks merge their results
   to unknown. Preserving each call's result must also preserve callback effects
   and its physical return carrier; a new context-specialization layer is not
   justified without a measured benefit.

2. **Fresh speed, size and memory evidence.** The pre-commit claims audit
   reports 6 passes and 14 failures: compiler/memory provenance is stale,
   timing was captured above the swap cap, and rival coverage is incomplete
   (43 comparable Porffor/TinyGo rows where 44 are required). The old size
   losses in that dataset are superseded by the 51/51 standalone wins above,
   but the dataset itself must be regenerated through the benchmark runner.
   Obtain quiet reference hardware and refresh the committed benchmark memory
   baseline. The adjacent-candidate kernel comparison above is complete, but
   does not replace that product-wide evidence.
   Keep TinyGo 0.42.0 and the current same-machine Porffor native comparison.

   The last paired runtime diagnostics, from the preceding candidate, lost
   to Clang Wasm on glyfparse (1.401×), sdf (1.171×), trace (1.063×) and
   wordcount (1.061×), and to AssemblyScript on sdf (1.055×) and shapes
   (1.127×). Re-measure before ranking these. SDF's summary already bounds
   the scratch parameter to [0,383]; its cached load loses presence and
   scalar bounds, leaving checks and conversions that Clang eliminates.
   Recover those existing facts while preserving out-of-bounds behavior.
   The shared scalar range query now recovers stored-element bounds when the
   index hull proves presence. A masked gather's square uses one integer
   multiply and one conversion instead of a float multiply and two conversions;
   the final 32-pair local diagnostic measured 0.978× time (975 → 974 bytes). SDF's
   data-dependent cursor is not proved present, so that case is unchanged.
   Logs use `/private/tmp/jz-load-bounds-` and `/private/tmp/jz-proven-load-`.
   The interval-product proof is shared by local typing and emission and
   rejects products that can lose negative zero. Regression coverage includes
   empty/missing reads, integer-store wrapping, large squares and zero signs.

   A separate pre-existing scalar-storage defect remains: with `a` an
   `Int32Array(16)` and `b` a `Float64Array(16)`, a helper looping to a dynamic
   `n` over `const v=a[i]; s+=b[v]+v*v` returns the same sum for `n=16` and
   `n=17`, where JS returns NaN at 17. The potentially missing read is stored
   in i32 and becomes zero. Fix presence-aware local narrowing before treating
   these general gather paths as conformant; payload bounds alone cannot do it.
   The same review reproduced an existing zero-sign loss for `-v` when `v`
   is an integer typed-element local holding zero. Keep that separate from
   the corrected interval-product proof; it also needs a narrowing fix.

3. **Public VST scope and identity.** The builder is JZ/macOS/stereo.
   Porffor's lifecycle fixture needs a public state-object adapter and build
   verification. Choose the permanent vendor root before publishing derived
   class IDs. Mono remains refused until its arrangement constant is verified
   against SDK headers. Restart-flagged edits take effect on the next setup;
   active host restart needs the component-handler interface. Events and wider
   layouts remain refused. The stateful fixture has been rerun on this candidate.

4. **Proof and independent review.** Reachable dynamic calls can still make
   static allocation/work proofs unknown. Empirical block checks establish
   neither allocation freedom for all inputs nor callback deadlines. Reuse
   entry-range facts for useful bounds; a full-i32 domain proves no deadline.
   Present the pinned candidate and complete gate evidence for independent
   review. Implementation alone is not expert approval. Replace dependency
   source pins once published packages contain their fixes. Another context,
   vectorizer or semantic-IR rewrite is not a v1 prerequisite.
