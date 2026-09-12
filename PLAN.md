# JZ v1

Compile audiojs.dev DSP through JS → Wasm → VST, with JZ or Porffor selected
at build time. Release requires correct audio, bounded callback work,
reproducible installation and passing conformance, speed, size and memory gates.
README owns the public contract; CONTRIBUTING owns compiler invariants.

## Candidate evidence — 2026-09-11

JZ `0a0a15c9` pins Watr `6025256` and Subscript `0f65c86`.

| Check | Result |
|---|---|
| Default suite | 4,220 pass, 59,216 assertions, one skip |
| O0 / O3 | 4,026 pass each, one skip each |
| WASI | 4,078 pass, 51,810 assertions, one skip |
| Language / built-in conformance subsets | 3,151 / 869 pass; 8 / 45 expected failures; zero unexpected failures |
| Functional self-host smoke suite | 43 pass, 2,289 assertions |
| Focused self-host regressions | 77 pass, 1,967 assertions |
| Recursive self-compilation | Completes; 14,731,014 output bytes |
| Callable reachability | 145 specimens; zero compile errors or unsound functions |
| Build, types, import lint, benchmark-merge tests | Pass |

The release JS/Wasm artifacts are 2,429,108 / 15,250,962 bytes. The Wasm
artifact is byte-identical to the focused regression kernel. Recursive
compilation uses 1,528,831,688 heap bytes; its report remains uncertified
because the artifact has no build attestation. Completion is not certification.
The full self-hosted CI suite passes:
[run 34642275803](https://github.com/dy/jz/actions/runs/34642275803).
All CI matrix legs and fuzz pass; the aggregate test workflow is red only
because of its stored-claims job.

Watr's source and compiled encoder suites pass with the local-use census
oracle enabled. Its clean build uses public JZ `1307e77` and produces 549,222
bytes. Hash producers and host codecs now reserve unsigned words 0/1
consistently: rebuild downstream Wasm together with matching interop.

The final size pass covers 60 samples and beats AssemblyScript on all 51
comparable cases, with geometric-mean JZ/AS size 0.778×. No inputs or budgets
were relaxed.

| Case | JZ bytes | Limit / AS bytes |
|---|---:|---:|
| Watr encoder | 288,777 | 300,000 |
| JSON | 10,764 | 12,500 |
| bezfit | 2,814 | 3,017 |
| wordcount | 3,303 | 3,480 |

## Recovery work — 2026-09-11

The interrupted work is recovered without importing its full session history.

- Exact runtime ToInt32 is shared by typed stores, DataView, Atomics and UTF-16
  unit construction. Unknown values no longer saturate beyond i64; known ranges
  retain direct lowering. Atomics.store also preserves argument evaluation order.
- The speed tier carries eligible integer accumulators as guarded i64 values.
  Exception handlers, negative-zero constants, numeric aliases and live guard
  temporaries decline the rewrite. The default/size tiers retain one loop.
  The original default-tier operation-count ratchet passes without rebasing.
- `inspect.runtime` reports proved absence of allocation/host calls and finite
  instruction bounds for recognized counter loops. Unknowns remain null. The
  full-i32-domain loop bounds are conservative, not audio deadline guarantees;
  SIMD/dynamic-bound loops and recursion can remain unknown.
- Intrinsic calls share user-call excess-argument handling. Collection methods
  use the same boxed-value conversion and retain precomputed hashes, removing
  their duplicate conversion/argument paths. Missing arguments become undefined.

Focused native checks pass (247 tests), as do focused self-host regressions
(33 tests). The functional self-host suite passes 44 tests / 2,291 assertions.
The full matrix passes: default 4,229 tests / 64,051 assertions,
O0 and O3 4,035 tests each, WASI 4,087; one skip per leg.
Conformance remains 3,151 language / 869 builtin passes, zero unexpected failures.
The runtime-inspection boundary suite passes three tests / 24 assertions;
hexadecimal/underscored counter immediates cannot manufacture a termination proof.
The final self-host speed gates still fail: warm 1.465×/1.527×/1.533× (cap 1.03×),
fresh 1.155× (cap 0.99×). No threshold or benchmark source was relaxed.
The size campaign wins all 51 AssemblyScript pairs (geomean 0.7783×): Watr
288,571 bytes, JSON 10,764, bezfit 2,814, wordcount 3,221. Paired speed-tier
accumulator ablations give on/off ratios 0.068× and 0.126× on seeds 15/29, at
254/309 bytes versus 130/172 bytes. These are diagnostic under load, not release
certification. Current swap usage is 16,668 MB, above the 4,096 MB validity cap.

## Release blockers

1. **Speed, memory and evidence.** Final self-compile timings fail: warm
   1.511×/1.584×/1.593× against the 1.03× cap; fresh 1.204× against 0.99×.
   This machine has about 15 GB of swap in use, above the 4 GiB validity limit.
   These timings are diagnostic. Re-measure on quiet reference hardware.
   Stored claims fail 13 checks, including stale compiler rows, memory,
   invalid swap evidence and incomplete rival coverage.

   The last complete local runtime campaign (before this candidate) passed
   256 checks and failed 10. Fastest-Wasm losses were glyfparse 1.278×,
   sdf 1.151×, trace 1.051×, lz 1.121×, shapes 1.108× and wordcount 1.471×.
   Float/mixed perf-fuzz geomeans were 1.05×/1.71× against 0.90×/1.25×;
   examples won strictly on 19/21 cases. These need fresh measurements.
   The TinyGo executable issue is diagnosed: 0.42.0 builds and its checksum
   matches JS; use that installation in the complete rerun.

   CI on `8100d3a1` passed 247 benchmark checks and failed the stored native
   alpha ratio: 3.52× against 3.50×. CI's fresh timing ratios are informational;
   they cannot replace reference-hardware release evidence.

2. **Compatibility edges.** A replaced record's
   missing callable field (`p={x:3}; p.y()`) is rejected instead of throwing
   TypeError at runtime. Caught internal numeric error codes can report
   `name === 'TypeError'` while `e instanceof TypeError` is false. Preserve
   the README's existing dialect; do not silently add exceptions to it.

3. **VST product path.** Implement the public `@audio/compile-vst` builder
   with compiler selection and matching ABI adapters. Existing stateful
   fixtures in `@audio/compile` pass 12,438 checks per compiler; the gain
   fixture passes 132 checks per compiler across 12,000 blocks. They predate
   this candidate and are not a public builder or a real-time guarantee.
   Extend coverage to concurrent audio threads and within-block automation.
   Porffor's shared arena stays live until the last instance closes.

4. **Independent review and release provenance.** Give a reviewer the pinned
   candidate and gate logs; implementation work is not expert approval.
   Produce attested recursive speed/memory evidence. Replace archive pins
   with npm releases once those releases contain the required fixes.

## Next measured reductions

- **Self-host allocation and dispatch.** Profiles point to string equality,
  hashing and dynamic property access. Shared censuses and demanded range
  analysis remove repeated work, but do not close the speed/memory gate.
  Profile surviving operations before adding another cache or pass.
- **Tighter callback work bounds.** Reuse entry-range facts to replace the
  conservative i32-domain count, and extend proofs to SIMD and dynamic block
  lengths without accepting unproved loops or host calls.

A new semantic IR, wholesale context/vectorizer rewrite, region API,
representation tiers and frozen raw ABI are not prerequisites for v1.
