# JZ v1

Compile audiojs.dev DSP through JS → Wasm → VST, with the compiler selected
at build time. Release requires correct audio, bounded callback work,
reproducible installation and passing conformance, speed, size and memory gates.
README owns the public contract; CONTRIBUTING owns compiler invariants.

## Completed foundations

- Consolidated binding/use and representation facts; shared Watr propagation,
  folding and LICM. No additional semantic IR or optimizer layer.
- UTF-16 strings; shared exact integer conversion for typed stores, DataView,
  Atomics and string construction. Proven ranges retain direct lowering.
- Proven builder capacities and array lengths; guarded i64 accumulators at
  level 2 and above. Size mode retains one loop; the ratchet counts the fast
  clone and its checks, excluding the cold fallback.
- Iterator destructuring and stateful VST fixtures for both compilers.
- Missing/non-callable methods and internal exceptions retain JS effect order
  and Error identity. Unread catch bindings link no error decoder. Generated
  Wasm and interop must be rebuilt together for the private transport change.
- Catch captures use ordinary declarations and cell lifetimes, including
  module-loop iterations. IIFE lifting understands both function forms, catch
  scopes, defaults and computed keys, and reuses the existing binding collector.
- Direct and closure bodies consume settled argument representations through
  one helper. The summary already resolves closed closure sets; emission now
  retains their object, array and string facts as well as typed/numeric facts.
  A representative typed-array/object callback proves no allocation or host
  calls. The stateful VST atom still has an unknown allocation proof.
- Watr proves locals constant when every write preserves their zero value.
  Calls, traps, changing values and signed-zero changes fail that proof;
  substitutions must pay for their retained literal encodings. This removes
  the zero-doubling recurrence without a benchmark-specific rule.
- Public JZ VST callbacks expose actual channel and sample-parameter lengths
  without allocating. Tests compare three-argument stateful atoms with JS over
  repeated short, zero and full blocks. Native automation tests cover multiple
  points, endpoint interpolation, zero-frame flushes and scalar fallback.
- The audio umbrella exposes VST under Node and preserves its browser entry.
  The empirical build gate rejects zero-work/invalid-size configurations.
- Dynamic object reads, writes, presence and deletion share one schema-slot
  search. Query representation checks move outside the scan; canonical keys
  compare by bits, while host/slice/JSON keys retain content equality. No cache,
  new layout or allocation. Size mode keeps one content-comparison loop.

The final direct paired self-host comparison is 8.8% faster than `e3e750af`
(0.912× geomean; all six cases improve). The isolated changes measured 0.949×
for shared short-key lookup, then 0.960× for canonical long keys.
The compiler artifact is 15,400,914 bytes versus 15,402,610. Hash hot/cold
splitting did not improve the workload and was discarded. These are diagnostic
measurements, not valid-hardware release attestations; logs use the
`/private/tmp/jz-gap-` prefix. Functional candidate verification passes.

Watr is pinned to `d6d140d`; Subscript remains at `0f65c86`.

## Candidate verification — 2026-09-13

Functional verification passes on compiler commit `e194a7eb`; release performance
and evidence gates remain open. Current logs are `/private/tmp/jz-gap-*`.

| Gate | Evidence |
|---|---|
| Core suite | 4,245 tests / 64,379 assertions pass; one skip |
| Opt0/opt3/WASI matrix | 4,051 / 4,051 / 4,103 tests pass; 49,376 / 49,694 / 56,973 assertions; one skip per leg |
| Functional bootstrap | 46 tests / 2,295 assertions pass |
| Recursive self-compile | Pass on an attested build; 14,894,077 output bytes; runnable probe returns 19 |
| Language conformance | 3,151 pass; 4,045 negative rejects; zero failures/negative accepts; 8 expected failures |
| Built-in conformance | 867 pass; zero failures; 47 expected failures |
| Size vs AssemblyScript | 51/51 strict wins; geomean 0.7782× |
| Size ceilings | Watr 290,091 / 300,000 bytes; JSON 10,764 / 12,500 bytes |
| Class-based gain size | 1,812 bytes vs AssemblyScript 1,903 |
| Audio suites | 29 VST + 22 WAM pass; zero skips |
| Watr compiled-Wasm suite | Pass, including differential local-propagation and spec suites |
| Perf-fuzz | Final-tree diagnostic pass: int 0.93×, float 0.71×, mixed 0.94×; maxima 1.07×, 0.94×, 1.88×; no competing test jobs, but swap exceeds the release validity cap |
| Self-host timing | Structural pins pass; both timing gates fail: warm 1.409× / 1.418× / 1.443× (cap 1.03×), fresh 1.133× (cap 0.99×) |

## Remaining release work

1. **Self-host speed and valid runtime/memory evidence.** Final-tree diagnostic
   warm ratios are 1.409×/1.418×/1.443× against the 1.03× cap; fresh is 1.133×
   against 0.99×. These ran serially after the functional suites. Current swap
   is 17,164 MB, above the 4,096 MB validity cap, so they are not release
   measurements; the timing failures remain unresolved. Obtain quiet reference
   hardware; do not relax the gates. Profile schema string comparisons,
   Map hashing and dynamic dispatch before adding another cache or pass.
   Recursive compilation now passes on attested commit `e194a7eb`: 56.49 s,
   1,563,773,600 heap bytes, 3,729.6 MiB peak process RSS, 14,894,077 output
   bytes. The 4 GiB Wasm address space includes the checkpoint's reserved lane.
   `/private/tmp/jz-gap-recursive.json` records provenance and the incomplete
   memory verdict: no compatible baseline manifest, so no relative memory
   claim. Obtain a current same-machine Porffor comparison as well.

2. **Current comparison evidence.** Committed benchmark and memory rows remain
   stale. The current claims audit passes 7 checks and fails 13, with incomplete
   rival coverage (including 43 comparable Porffor cases where 44 are required).
   A fresh four-round paired diagnostic beats Clang Wasm on lz (0.788×) and
   shapes (0.292×); Clang losses remain in glyfparse (1.401×), sdf (1.171×),
   trace (1.063×) and wordcount (1.061×). AssemblyScript also wins sdf (1.055×)
   and shapes (1.127×); lz is the only case of these six ahead of both rivals.
   All six match their reference checksums. Re-measure on valid hardware and fix remaining
   losses using general techniques and unchanged benchmark sources. SDF WAT
   shows checked scratch-array reads and repeated conversions where Clang keeps
   loaded indices and their products in integer form. Investigate existing
   cached-load temporaries and their presence proofs: the existing summary
   already gives SDF's scratch parameter the range [0,383], but its cached
   load is nullable and carries no scalar range into arithmetic. Preserve
   out-of-bounds behavior when recovering those facts. Historical
   size losses must not be confused with the fresh 51/51 size wins above.
   Keep TinyGo 0.42.0 in the comparison.

3. **Public VST scope and identity.** The public builder is JZ/macOS/stereo.
   Porffor works in the lifecycle fixture but still needs a public state-object
   adapter and its own build verification. Choose the permanent vendor root
   before publishing derived class IDs. Mono remains refused until its speaker
   arrangement is verified against SDK headers. Restart-flagged edits take
   effect on the next setup/activation; requesting a host restart needs the
   missing component-handler interface. Events and wider layouts remain refused.

4. **Proof and release review.** Static allocation/work results remain unknown
   when reachable dynamic paths cannot be excluded. Empirical block tests do
   not prove allocation freedom or deadlines. Reuse entry-range facts for useful
   callback bounds; full-i32-domain bounds establish no audio deadline. Provide
   the pinned candidate and gate logs for independent review: implementation is
   not expert approval. Replace source archive pins once npm releases contain
   the required fixes. A context/vectorizer rewrite, another semantic IR or a
   frozen raw ABI is not a v1 prerequisite.
