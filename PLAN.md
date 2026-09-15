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
- All prepared, imported, synthesized and specialized functions share one
  constructor. Variant queue entries are records. Function registries and
  active frames use the same constructors initially and at reset; registry
  lookups no longer allocate intermediate entry arrays unnecessarily.
- Array-pattern parameters use the existing positional initialization path
  for ordinary functions and generators, avoiding synthetic rest allocation.
  Object-only patterns retain their existing lowering; generalizing that path
  exposed a parser ambiguity in block statements followed by arrows.
- Concatenations retain cached hashes, Map/Set probes reuse their capacity
  load when following relocation, wide schemas use a static key index, and
  dynamic reads beyond the specialization budget retain an inline cache.
- Schema indexes write binary words directly, preserving capacities and signed
  relative offsets through self-compilation. JSON's schema cache explicitly
  clears reused arena storage; repeated object-form compiler options stay intact.
- Stateful native VST lifecycle fixtures, block-size/automation checks,
  allocation counters and concurrent processing exist. Public VST scope and
  proof limits remain below.

The handoff has been folded here and removed. Watr remains pinned
to `d6d140d`; Subscript to `0f65c86`.

## Candidate verification — September 15

Final core: 4317 pass, one skip, zero failures (65806 assertions). The matrix
passed all four legs; its O0/O3 legs each passed 4122 tests, WASI 4175. The last
field-table refactor was followed by a fresh full core and affected summary
checks across the matrix settings. The old nullish-read expectations now
require TypeError. The structural golden and ratchet updates are
isolated to required receiver checks: omitting only `requireReceiverWat`
restores all ten prior loop counts; the typed class example returns from 3132
bytes to 3060. Its size-class ceiling retains the previous 40-byte slack.
Product timing, Watr/JSON size and memory caps are unchanged.

Fresh self-host functional suite: 50 passes, 2329 assertions. Language
conformance: 3151 positive passes, 4045 negative rejections, 8 expected failures;
built-ins: 874 passes, 45 expected failures. Both report zero failures.
Import lint and public types pass. Kernel provenance, byte parity, recursive
compilation, reuse and error recovery pass. The memory gate now excludes the
deliberately invalid source from compilation comparisons (the sequence gate
still checks rejection, and process peaks cover it). All 28 comparable rows
stay within the existing 10% memory band against the preceding candidate.
The final manifest is `/private/tmp/jz-finish-candidate.json`; recursive
compilation uses 1556383816 heap bytes and emits 15330661 wasm bytes.

The fresh size sweep beats AssemblyScript on all 51 comparable cases at
0.778× bytes. Watr is 297238 bytes against 300000; JSON is 10772 against 12500.
This standalone sweep does not refresh committed benchmark rows.
Evidence logs use `/private/tmp/jz-finish-`.

Final self-host timing: warm 1.080×/1.103×/1.120× against 1.03× (fails),
fresh 0.913× against 0.99× (passes).
The indexed field tables are 0.987× the preceding kernel's time in a paired
diagnostic. Packed Int32 field rows did not improve timing and were discarded.
The direct forwarding-helper experiment was slower (1.124×) and was discarded.
A shared private nullish-throw helper did not reduce the emitted size and
was discarded. These diagnostic measurements are not release attestations:
current swap is 13022 MB, above the 4096 MB validity cap.

The earlier stateful native VST fixture passed 12438 checks and 4000
concurrent blocks with zero sample error and fixed callback heaps. It has
not been rerun for these compiler changes and does not prove deadlines.

## Remaining release work

1. **Warm self-host speed.** Close the remaining roughly 5–9% gap without
   changing the 1.03× cap. Uniform function records are implemented, and
   `ctx.funcs` now has an exact physical layout; `createFunction().sig` and
   `ctx.func.current` still join to unknown. Trace mixed Map/tuple value flow
   before adding another analysis: constructing Map-entry tuples merges the
   string key with the object value and escapes its shape before a positional
   read can use it. Preserve tuple positions without hiding effects of a later
   dynamic index, mutation, escape or union. This remains conservative today.
   The previous profile attributes about 14% to Map/Set probes and 5% to
   pointer decoding. The retained changes reduce dispatch and allocation;
   blanket forwarding inlining is not established as a win.

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
   layouts remain refused. Re-run the stateful fixture on the pinned candidate.

4. **Proof and independent review.** Reachable dynamic calls can still make
   static allocation/work proofs unknown. Empirical block checks establish
   neither allocation freedom for all inputs nor callback deadlines. Reuse
   entry-range facts for useful bounds; a full-i32 domain proves no deadline.
   Present the pinned candidate and complete gate evidence for independent
   review. Implementation alone is not expert approval. Replace dependency
   source pins once published packages contain their fixes. Another context,
   vectorizer or semantic-IR rewrite is not a v1 prerequisite.
