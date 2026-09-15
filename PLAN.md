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
  clustering of consecutive integer-valued doubles. Dictionary slot updates
  share Map/Set's upsert implementation, removing a duplicate grow/probe loop.
  Map reads depend on hashing/equality directly instead of mutation helpers.
  Slot fusion declines throwing/effectful RHS and object key coercion. Nullable
  coercion reads once, avoiding duplicated key conversions and table probes.
- Schema indexes write binary words directly, preserving capacities and signed
  relative offsets through self-compilation. JSON's schema cache explicitly
  clears reused arena storage; repeated object-form compiler options stay intact.
- Stateful native VST lifecycle fixtures, block-size/automation checks,
  allocation counters and concurrent processing exist. Public VST scope and
  proof limits remain below.

The handoff has been folded here and removed. Watr remains pinned
to `d6d140d`; Subscript to `0f65c86`.

## Candidate verification — September 15

Final core: 4324 pass, one skip, zero failures (68956 assertions). The prior
full matrix passed all four legs. This continuation passed 559 affected tests
at O0, O3 and WASI after the tuple/hash changes, collection checks after the
upsert fold, and 252 affected tests in each leg after the final coercion fixes.
Product timing, Watr/JSON size and memory caps are unchanged.

Final self-host functional suite: 50 passes, 2329 assertions. Earlier in this
continuation, language conformance reported 3151 positive passes, 4045 negative
rejections and 8 expected failures; built-ins reported 874 passes and 45
expected failures, both with zero failures. The final coercion fixes pass
objects, ToPrimitive and optimizer tests (432 cases). Import lint passes.
Public types passed on the preceding candidate; no public signatures changed.

The final kernel passes provenance, byte parity, recursive compilation, reuse,
error recovery and all 28 memory comparisons within the existing 10% band.
The manifest is `/private/tmp/jz-rest-final-candidate.json`, compared against
`/private/tmp/jz-finish-candidate.json`. Recursive compilation uses 1555927920
heap bytes and emits 15308343 wasm bytes. The shared upsert removes roughly
21 KB from the kernel; paired warm timing is unchanged (1.002×).

The prior full size sweep beat AssemblyScript on all 51 comparable cases at
0.778× bytes. Current affected size checks keep Watr below 300000 bytes and
JSON below 12500. This does not refresh committed benchmark rows.
Evidence logs use `/private/tmp/jz-rest-`.

Final self-host timing: warm 1.088×/1.129×/1.129× against 1.03× (fails), fresh
0.877× against 0.99× (passes). Tuple precision, inline-map
reuse and export enumeration showed no meaningful paired timing improvement.
The numeric hash removes a separate severe defect: isolated Map fill/read
workloads improved about 5–51× for 128–4096 sequential keys, while aggregate
warm compilation remained unchanged. The audit's Map counter still took
1.383× V8 time (1.298 ms versus 0.936 ms for 100000 updates); it repeats a
get/set probe for each update.
These are diagnostics, not release attestations: the latest swap reading
is 12365 MB, above the 4096 MB validity cap. No cap was relaxed.

The current compiler passed the stateful native VST fixture: 12438 checks,
4000 concurrent blocks, zero sample error and fixed callback heaps. The public
compile-vst package's 29 tests also pass, including three real bundle builds.
These tests do not prove callback deadlines.

## Remaining release work

1. **Warm self-host speed.** Close the remaining roughly 6–10% gap without
   changing the 1.03× cap. Uniform function records and positional collection
   flow are implemented. `ctx.funcs` has an exact layout; `createFunction().sig`
   and `ctx.func.current` still join to unknown. The next observed loss comes
   through the unknown `programFacts`/function-order result passed into export
   queries. Isolating profiling wrappers at call sites did not restore that
   precision and was discarded; do not assume it is the sole cause.
   The previous profile attributes about 14% to Map/Set probes and 5% to
   pointer decoding. A general get/set fusion could reuse the shared slot
   upsert, but must prove intrinsic method identity and a non-observable,
   non-throwing RHS before inserting a missing entry early. Blanket forwarding
   inlining was measured slower and discarded.

2. **Fresh speed, size and memory evidence.** The committed claims audit
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
