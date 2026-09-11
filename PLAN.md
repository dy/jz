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

## Release blockers

1. **Runtime integer stores.** Compile-time conversion is fixed, but dynamic
   integer stores still saturate beyond the i64/u64 conversion range.
   `export function f(x){const a=new Int16Array(1);a[0]=x;return a[0]}`
   returns -1 for `f(1e30)`; JS returns 0. Share exact runtime conversion across
   typed stores and DataView before claiming this boundary is covered.

2. **Speed, memory and evidence.** Final self-compile timings fail: warm
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

3. **Compatibility edges.** Preserve effects of excess intrinsic arguments:
   `map.delete('x', n++)` currently loses the increment. A replaced record's
   missing callable field (`p={x:3}; p.y()`) is rejected instead of throwing
   TypeError at runtime. Caught internal numeric error codes can report
   `name === 'TypeError'` while `e instanceof TypeError` is false. Preserve
   the README's existing dialect; do not silently add exceptions to it.

4. **VST product path.** Implement the public `@audio/compile-vst` builder
   with compiler selection and matching ABI adapters. Existing stateful
   fixtures in `@audio/compile` pass 12,438 checks per compiler; the gain
   fixture passes 132 checks per compiler across 12,000 blocks. They predate
   this candidate and are not a public builder or a real-time guarantee.
   Extend coverage to concurrent audio threads and within-block automation.
   Porffor's shared arena stays live until the last instance closes.

5. **Independent review and release provenance.** Give a reviewer the pinned
   candidate and gate logs; implementation work is not expert approval.
   Produce attested recursive speed/memory evidence. Replace archive pins
   with npm releases once those releases contain the required fixes.

## Next measured reductions

- **Guarded wide integer accumulation.** Use existing loop/range facts to
  carry i64 accumulators while every intermediate stays in JS's exact-integer
  range, retaining f64 for other inputs. Target the repeated conversions in
  mixed perf-fuzz; prove zero trips, fractional bounds, overflow, negative zero
  and nonfinite inputs before measuring. This remains a candidate.
- **Self-host allocation and dispatch.** Profiles point to string equality,
  hashing and dynamic property access. Shared censuses and demanded range
  analysis remove repeated work, but do not close the speed/memory gate.
  Profile surviving operations before adding another cache or pass.
- **Useful audio guarantees.** Explore proving absence of allocation and
  host calls, plus work bounds, from existing effect/range facts. Publish only
  facts actually proved; no such general callback guarantee exists yet.

A new semantic IR, wholesale context/vectorizer rewrite, region API,
representation tiers and frozen raw ABI are not prerequisites for v1.
