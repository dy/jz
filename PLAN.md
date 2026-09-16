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

The final full run passes core 4345 tests (71822 assertions), O0 4151, O3 4151
and WASI 4203, each with one skip and zero failures. Focused checks also pass
all 259 optimizer tests, 223 SIMD tests and the 10-category loop ratchet.
Seven new regression groups pass 4331 assertions across O0/O2/speed/size,
including the implicit-zero range fix. Full-run logs use
`/private/tmp/jz-presence-final5-`; focused logs use the same prefix without
`final5-`.

Self-host correctness passes all 52 tests (2333 assertions). Language conformance
passes 3151 positives and rejects 4045 negatives, with zero failures and 8
expected failures. Built-ins pass 874, with zero failures and 45 expected
failures. Public types and import lint pass.

The latest full size sweep wins all 51 comparisons against AssemblyScript at
0.784× bytes. The VM size build is 1646 bytes against AS's 1694. No timing,
size, memory or instruction-ratchet cap changed. This standalone sweep does
not refresh the committed benchmark dataset.

The typed-read correctness fixes have a measurable runtime cost. Alternating
pairs against the preceding compiler keep every checksum intact, but SDF
measures 1.382× and VM 2.270×. Glyph parsing measures 0.949×; trace, wordcount
and shapes have unchanged emitted WAT, so their timing movement is noise.
These are local diagnostics, not release attestations.

The preceding candidate passed the stateful native VST fixture: 12438 checks,
4000 concurrent blocks, zero sample error and fixed callback heaps. The public
compile-vst package's 29 tests also passed, including three real bundle builds.
Those tests do not establish callback deadlines.

## Remaining release work

1. **Runtime and self-host speed.** Missing integer reads now preserve
   `undefined` through locals, copies, computed indices and helper returns.
   Uint32 locals retain unsigned magnitude, and signed/unsigned comparisons
   share one proof. Local/result narrowing reuses existing interval and
   canonical-loop proofs; validated caller lengths also reach result analysis.
   Exact integer expression folding is shared by emission and optimization.
   NaN-aware coercion bounds remove unnecessary arbitrary-number conversions
   while keeping missing-index guards. Implicit zero is part of local ranges.

   Recover performance without reversing these fixes. SDF's data-dependent
   scratch cursor still lacks a presence proof. VM's nullable opcode and
   program-counter values now use f64: its old integer jump table becomes six
   floating comparisons. Payload ranges alone cannot authorize integer storage.
   A temporary guarded-f64 jump table was 14.5% slower; a block-result coercion
   experiment was 8.5% slower on VM. Neither was retained. Joining multiple
   local definitions produced no code change and was also discarded.

   Warm self-compilation must meet the unchanged 1.03× cap; fresh compilation
   must meet 0.99×. The preceding candidate measured warm
   1.063×/1.117×/1.100× and fresh 0.912×. The current isolated run measures
   warm 1.095×/1.137×/1.129× (fails) and fresh 0.844× (passes).
   The remaining self-host profile is spread across Map/Set probes and pointer
   decoding. `ctx.funcs` has an exact layout, but polymorphic profiling callbacks
   still merge `createFunction().sig` / `ctx.func.current` facts to unknown.
   Call-site wrapper isolation and blanket forwarding inlining did not help.
   Preserve callback effects and physical return carriers in any future change;
   a new context-specialization layer needs measured justification.

2. **Reproducible speed, size and memory evidence.** The committed benchmark
   dataset is stale, was timed above the 4096 MB swap-validity cap, and lacks
   complete Porffor/TinyGo coverage (43 comparable rows against 44 required).
   A fresh system read reports 11356.19 MB of swap, still above that cap.
   Regenerate through the benchmark runner on quiet reference hardware, with
   the current compiler and memory-baseline provenance. Standalone size wins
   and local paired timings do not replace that evidence. Keep TinyGo 0.42.0
   and the current same-machine Porffor native comparison.

   The prior rival comparison also trailed Clang Wasm on glyph parsing, SDF,
   trace and wordcount, and AssemblyScript on SDF and shapes. Refresh those
   comparisons before ranking further work. No new leadership claim is justified
   by the current diagnostic machine or by smaller WAT alone.

3. **Public VST scope and identity.** The builder is JZ/macOS/stereo.
   Porffor needs a public state-object adapter and build verification. Choose
   the permanent vendor root before publishing derived class IDs. Mono remains
   refused until its arrangement constant is verified against SDK headers.
   Restart-flagged edits take effect on next setup; active restart needs the
   component-handler interface. Events and wider layouts remain refused.

4. **Proof and independent review.** Reachable dynamic calls can still make
   static allocation/work proofs unknown. Empirical block checks establish
   neither allocation freedom for all inputs nor callback deadlines. Reuse
   entry-range facts for useful bounds; a full-i32 domain proves no deadline.
   Present the pinned candidate and complete gate evidence for independent
   review. Implementation alone is not expert approval. Replace dependency
   source pins once published packages contain their fixes. Another context,
   vectorizer or semantic-IR rewrite is not a v1 prerequisite.
