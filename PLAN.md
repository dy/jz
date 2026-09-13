# JZ v1

Compile audiojs.dev DSP through JS → Wasm → VST, with JZ or Porffor selected
at build time. Release requires correct audio, bounded callback work,
reproducible installation and passing conformance, speed, size and memory gates.
README owns the public contract; CONTRIBUTING owns compiler invariants.

## Completed foundations

- Consolidated binding/use and representation facts; shared Watr propagation,
  folding and LICM machinery. No additional semantic IR or optimizer layer.
- UTF-16 strings; exact integer conversion shared by typed stores, DataView,
  Atomics and string construction. Proven ranges keep direct lowering.
- Proven builder capacities and array lengths; guarded i64 accumulators in the
  speed tier. Default/size tiers retain one loop and the original ratchet.
- Iterator destructuring and stateful VST lifecycle fixtures for both compilers.
- Optional final-Wasm inspection of allocation, host calls and finite work.
  Unknown proofs remain null; current loop bounds are deliberately conservative.
  Closure calls resolve through the table when nothing outside the module can
  reach it, which the native host guarantees by exporting no table.

## Compatibility and simplification — 2026-09-11

Changes after `7c1111f8` close the two listed compatibility blockers:

- Missing/non-callable record methods throw TypeError after argument effects;
  nullish member reads throw before arguments. Scalarized callees use the same
  non-callable path. Dynamic dispatch checks callability once.
- Internal exceptions use private tagged transport. A catch materializes an
  ordinary branded Error; user-thrown numbers, including colliding codes, remain
  numbers. The numeric error-property decoder and unused range table are removed.
- Coercion distinguishes a fixed slot, proven absence and an unresolved layout.
  Unresolved methods use the existing presence probe instead of assuming absence.
- Canonical TypeErrors share lazy helpers, allowing dead guards and their message
  data to disappear together. Dead generated guards leave no host error export.
  A catch links the decoder only where its binding is read, so an unread binding
  and a binding-less catch both stay at the pre-change size. No new public
  compiler option.

Generated Wasm and interop must be rebuilt together for the transport change.

Measured size effect on a minimal JSON-catch program, against `7c1111f8`, at the
size tier. An earlier draft of this section claimed a fall from 13,579 to 7,179
bytes; that figure is not reproducible at any option set tried and is withdrawn.

| Catch form | Before | After |
|---|---:|---:|
| `catch { }` | 11,159 | 11,162 |
| `catch (e)`, binding unread | 11,159 | 11,469 |
| `catch (e)`, binding read | 18,737 | 19,150 |

Review of the change set confirmed four defects. Two were regressions it
introduced, both now fixed and pinned:

- A missing method on an object or hash receiver evaluated its arguments before
  testing the receiver for nullish, running effects JavaScript never runs
  (`obj.missing(c = c + 1)` on an absent element returned 21 where the host
  returns 11, and 31 with spread arguments). Both arms of that path throw, so the
  test is unconditional rather than gated on the maybe-undefined census, which
  reports false for exactly this shape.
- `btoa`'s `InvalidCharacterError` is the one message name outside the seven
  modeled classes, so a caught instance answered `instanceof Error` false. It now
  brands as `Error` and keeps its own name, as the host reports it.

The third was a coverage gap, now closed: the identity test exercised no
TypeError-class internal code. The fourth, that the transport carries no
provenance, is real but not introduced here and not specific to the error tag:
typed-array aliasing forges the existing `undefined` tag identically on
`7c1111f8`, where jz reports `typeof` as `"undefined"` and the host reports
`"number"`. It belongs with the README's documented divergences.

Two pre-existing defects surfaced during this work, neither introduced by it:

- `o.length` on an unproven receiver crashed the compiler under shared or
  imported memory: `__throw_property_nullish requires a static string literal`.
  The helper unwrapped raw bits and rejected anything else, but a memory whose
  start-function copy length is already fixed cannot extend static data, so its
  string emitter yields a runtime construction. The helper now prints whatever
  the emitter yields, as the catch decoder already did. Own-memory output is
  byte-identical across six programs at three tiers, and a static literal still
  records the span that reclaims its bytes when the helper dies. Fixed.
- A closure capturing a catch binding fails to compile (`'ef1_1' is not in
  scope`). Not fixed; it rejects at compile time rather than miscompiling.

## Verification

Re-measured against the corrected change set. Logs are under the session
scratchpad; the rows below are the runs those logs record, not earlier drafts.

| Check | Result |
|---|---|
| Default suite | 4,241 tests / 64,167 assertions pass, one skip, zero failures |
| Full opt matrix | O0 4,046 / O3 4,046 / WASI 4,098 tests pass; zero failures |
| Functional self-host suite | 46 tests / 2,295 assertions pass |
| Language conformance | 3,151 pass; zero fail; 8 expected; zero negative-accepts |
| Built-in conformance | 867 pass; zero fail; 47 expected |
| Size vs AssemblyScript | 51/51 strict wins; geometric mean 0.7783× |
| Size limits | Watr 290,045 / 300,000 bytes; JSON 10,764 / 12,500 |
| Release artifacts | `dist/jz.js` 2,438,656 and `dist/interop.js` 35,899 bytes; build succeeds |
| Self-compile timing pins | Fail; see blocker 1. The machine is invalid for timing |
| Audio compile suite | 22 tests pass (unchanged; measured before this change set) |
| Stateful VST, each backend | 12,438 checks + 4,000 concurrent blocks; fixed callback heaps |

Conformance, size and artifact rows are identical before and after the two
regression fixes, so neither moved a gate. The class-based gain figure and the
audio rows predate this change set and were not re-measured here.

The audio fixture is committed as `@audio/compile` `64cfbc3`. Concurrent audio
processing is verified against independent JS state; setup/teardown are serialized.
Watr remains pinned at `6025256`, Subscript at `0f65c86`.

## Release blockers

1. **Speed, memory and valid evidence.** Self-host time gates remain unpassed.
   The guarded i64 accumulator is on only at level 3 and `speed`; the perf-fuzz
   gate and the codegen ratchet compile at level 2, so its measured effect never
   reaches the tier the gate reads. On this machine, back to back: mixed geomean
   1.79× at level 2 against 1.16× at level 3 (cap 1.25×); mixed max 7.57× against
   2.03× (cap 2.25×). Float stays 1.10× at both because its slowest seeds are
   `acc = acc + (1)`, excluded by the pass's sink requirement, and
   `acc = acc + (acc)`, which has no integer step. Enabling the pass at level 2
   needs the ratchet to stop counting the cold fallback loop and a re-baseline.
   Previous warm ratios were 1.465×/1.527×/1.533× (cap 1.03×), fresh 1.155×
   (cap 0.99×). Current swap is 16,572 MB, above the 4,096 MB validity cap.
   Obtain quiet reference-hardware measurements; do not relax the caps.
   Stored claims still need current compiler rows, complete rival coverage and
   valid memory/provenance evidence. Recursive compilation previously completed
   using 1,528,831,688 heap bytes, without a build attestation.

   The last complete runtime campaign still had fastest-Wasm losses in
   glyfparse, sdf, trace, lz, shapes and wordcount, plus float/mixed perf-fuzz
   failures. Those scores predate this candidate and require a fresh campaign.
   Wasm-opt size comparison leaves only 0.2–1.6% in most of these kernels and
   enlarges lz: byte-level cleanup alone does not explain the runtime losses.
   Profile self-host string equality, hashing and dynamic dispatch before
   adding another cache or pass. Use working TinyGo 0.42.0 in the comparison.
   The current named-kernel CPU profile confirms those helpers lead. Schema
   reads/writes dominate string comparisons; Map key probes dominate hashing.
   `/private/tmp/jz-plan-complete-warm.cpuprofile` is diagnostic evidence,
   not a valid release timing run.

2. **Public VST builder.** `@audio/compile-vst` now exists (`packages/compile-vst`
   in `@audio/compile`): `toVst3(atom)` derives identity, parameters, buses,
   latency and tail from the manifest; `build()` compiles with JZ, gates the
   compiled atom in plain Node (heap cursor and memory size fixed across
   hundreds of blocks with every host import stubbed to throw), links one fixed
   native shell against a generated data header and writes a signed macOS
   bundle. Bundles for the gain, stateful and a mixed-parameter atom load in the
   repo's host and match the atoms sample for sample across sample rates and
   block sizes; two workers process one bundle concurrently. 25 tests.

   Remaining: the Porffor backend (its native output is one global program, so
   the shim needs a state-object ABI as the fixture's does); mono buses in the
   native build, refused until the speaker-arrangement constant is checked
   against the SDK header; a restart hook, since the vendored interface header
   declares no `IComponentHandler`, so restart-flagged edits take effect at the
   host's next `setupProcessing` or activation; within-block automation, which
   the shell interpolates but the host's single-point queue cannot exercise;
   and a root re-export once the workspace dependency is wired.

   The static allocation proof stays `null` for every contract-shaped atom: a
   process closure entered through the table keeps untyped parameters, so its
   dynamic property arms remain reachable in the static graph although the
   gate shows they never run. The next compiler step is call-site parameter
   propagation through a closed table, or single-target closure
   devirtualization; the closed-table resolution landed with this work already
   certifies `noHostCalls` for atoms whose closures reach no import.

3. **Independent review and release provenance.** Provide the pinned candidate
   and gate logs for independent review; implementation is not expert approval.
   Produce attested recursive speed/memory evidence. Replace archive pins with
   npm releases once they contain the required fixes.

## Next measured reduction

Reuse entry-range facts for useful callback work bounds, including SIMD and
runtime block lengths. Current full-i32-domain bounds do not establish an audio
deadline. A wholesale context/vectorizer rewrite, region API, new semantic IR
and frozen raw ABI are not prerequisites for v1.
