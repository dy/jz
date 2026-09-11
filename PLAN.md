# JZ v1

Compile audiojs.dev DSP through JS → Wasm → VST, with JZ or Porffor selected
at build time. Release means correct audio, bounded callback work, reproducible
installation and passing conformance, speed and size gates.

README owns the public contract; CONTRIBUTING owns compiler architecture and
invariants. Completed reviews and superseded design proposals remain in Git
history. This file tracks only release evidence and unfinished work.

## Verification

JZ pins Watr `8c866b1`. Runtime JSON now shares decimal conversion with
Number/parseFloat, canonicalizes object keys, and reuses schemas correctly.
Schema-table growth preserves existing objects; representation exhaustion throws
a branded RangeError. Core and JSON share its existing error materializer.
URLSearchParams uses class methods through ordinary lowering and reachability.

The complete matrix passes: default 4,187 checks / 46,738 assertions;
O0 3,994 / 38,938; O3 3,994 / 39,259; WASI 4,045 / 39,334, each with one skip.
Language/built-in conformance passes 3,151/869 cases. Functional self-hosting passes 38 checks
(304 assertions). The focused JSON/number/web-global suites cover rounding,
malformed-input recovery, duplicate/index keys, cache collisions, table growth
and clear, schema-ID exhaustion, independent instances and live iteration.
Downstream Watr passes its full source and rebuilt Wasm suites: 352 checks
with two skips, 26 propagation checks, and 268 spec files with 20 skips in
each backend. The VST fixture results below predate these runtime changes.

The full recursive gate passes, including execution of a program compiled by
the recursively built compiler. Named-function trampolines now reuse direct-call
argument coercion: treating a narrowed object pointer as a numeric i32 had
turned the parsed argument record into address zero. The regression is pinned
by tiny function-property calls with empty, supplied, missing and excess args.
The recursive output is 14,757,111 bytes, with a final heap cursor of
1,525,655,368 bytes. The checkpoint reserves the full 4 GiB address space;
the gate process peaks at 4,121 MiB RSS. This closes recursive correctness,
not the remaining speed/evidence requirements.

The default-tier URL lookup probe shrinks 39,596→33,163 bytes; speed-tier output
shrinks 47,381→36,711. Paired warm compile medians are 392→321 ms (lookup) and
330→273 ms (literal input). A fixed creation workload uses 288→192 MiB peak
linear memory; its runtime is within measurement noise. JSON correctness has a
cost: standalone parse/stringify grows 13,058→25,761 bytes, mostly from sharing
the full decimal conversion table. The corpus JSON checksum remains 2797819845:
227 µs versus Node's 287 µs, with a 21.6 kB module versus the earlier 9.6 kB.
A repeated-runtime-parse probe improves for short keys (32.0→15.4 µs), while
long-key content verification costs more (14.0→18.5 µs). These are scoped probes,
not replacement evidence for the open whole-corpus gates.

The stateful VST fixture in `@audio/compile` passes 12,438 checks with each
compiler (JZ reverified on this optimizer; Porffor verified previously): variable blocks, live parameters, independent overlapping instances,
close/reopen and last-close reset agree exactly with JS and keep callback heaps
fixed. The gain fixture passes 132 checks per compiler over 12,000 blocks.
These are fixture proofs, not a public target builder or a real-time guarantee.

## Open gates

1. **Size.** Keep the encoder cap at 300,000 bytes and strict per-case
   AssemblyScript leadership. The audit follow-up measures:

   | Case | JZ bytes | Limit / AS bytes |
   |---|---:|---:|
   | Watr encoder | 300,260 | 300,000 |
   | FFT | 1,685 | 1,758 |
   | bezfit | 3,211 | 3,017 |
   | immutable | 1,446 | 1,481 |
   | sdf | 2,191 | 2,209 |
   | shapes | 1,807 | 1,695 |
   | slices | 1,595 | 1,657 |
   | tokenizer | 1,520 | 1,551 |
   | wordcount | 3,664 | 3,480 |
   | dispatch | 1,853 | 1,614 |
   | JSON (speed artifact) | 22,016 | 12,500 |

   Equality is not a strict win. No benchmark sources or budgets changed.
   Watr shares exact casts with JZ's early lowering, removes redundant
   narrow-store casts/masks, and pools integer bits independently of spelling.
   Binaryen `-Oz` on the resulting modules yields encoder 340,540, shapes 1,777,
   tokenizer 1,500, wordcount 3,654 and bezfit 3,511 bytes. Its small kernel wins
   justify individual general folds, not adding its entire pipeline.
   The current zero-test encoding and simpler allocator reduce every sampled
   module and close the SDF/tokenizer size gaps. The allocator retains its
   growth ratios, exact-delta retry and byte-overflow guard; its old page-count
   guard was unreachable. No new optimizer pass or runtime layout is added.

2. **Speed and evidence.** The stored reference fails leadership claims,
   including V8 losses on jessie and Watr, and is stale. After this consolidation,
   the isolated self-compile timing gate still fails: warm 1.444×/1.469×/1.501×
   against 1.03×, fresh 1.229× against 0.99×. Functional bootstrap passes.
   These are current gate results, not a paired before/after speed comparison.
   The complete benchmark run before the closure-adapter correction passes
   247 checks and fails 19: eight
   fastest-Wasm comparisons, native resample/JSON, stored native-lowering bands,
   four strict AS size comparisons, JSON/encoder caps, perf-fuzz and example
   speed. Dispatch and JSON size failures reproduce before this pass; their
   size-tier modules shrink 1,883→1,853 and 22,101→22,061 bytes respectively.
   All eleven sampled module sizes are unchanged by the adapter correction.
   The ecosystem run reports jessie/Watr at 2.164×/1.386× JS time; those tests
   report timings without enforcing leadership. Stored evidence has 58 stale
   JZ rows and an invalid 15.8 GB swap sample; it cannot certify the release.
   No sources, conformance floors or performance caps were relaxed.
   Repair the remaining codegen gaps, then refresh complete runtime, memory,
   native-lowering and rival evidence on a quiet machine. TinyGo 0.42 builds
   44 comparable cases with 43 matching checksums; classify the entity mismatch
   and update the stored coverage. Keep claims and conformance floors intact.

3. **VST product path.** Implement the public `@audio/compile-vst` builder with
   compiler selection and matching generated ABI adapters. Extend the fixture
   evidence to concurrent audio threads and within-block automation. Porffor's
   shared arena remains live until the last instance closes.

4. **Compatibility.** Preserve the README's explicit dialect, iterator,
   Boolean/Number, BigInt and lifetime boundaries. Rebuild downstream Wasm with
   matching compiler/interop revisions. Replace pinned parser/optimizer archives
   with published npm versions once they contain the required fixes.
   Excess built-in arguments still need effect preservation: with `n = 0`,
   `map.delete('x', n++)` leaves `n` at 0 instead of 1. Preserve evaluation
   before discarding arguments outside an intrinsic's signature.
   A callable edge remains: `let p={x:1,y:2}; p={x:3}; p.y()`
   is rejected during compilation instead of throwing TypeError at runtime.
   Internal errors still use numeric codes (explicitly pinned in `test/errors.js`),
   so unifying their representation remains compatibility work: a nullable local call's caught
   error has `name === 'TypeError'` and reaches the host as TypeError, but
   `e instanceof TypeError` can return false. This reproduces before the
   nullable-dispatch review fix: `let f=flag?twice:null; try { f(4) }
   catch(e) { return e instanceof TypeError }` (with `twice(x){return x*2}`).

5. **Review handoff.** The callable-reachability probe finds no unsound
   functions in 144 compiled specimens. Its Web Audio specimen remains uncovered:
   the oracle's module-graph setup omits that case. Resolve this coverage gap.
   Give an independent reviewer a pinned candidate and its gate logs; previous
   implementation work does not constitute independent expert approval.

## Next reductions

- Extend the retained length/layout facts only where remaining WAT demonstrates
  a gap. Fixed literals/builders and equal-count push branches now propagate
  through local and parameter ValueReps; resizing, spread and escape invalidate
  them. Shapes still exceeds AssemblyScript despite the removed length work.
- Carry proven builder cardinality into allocation capacity where nonescape and
  fixed growth permit it. The AS shapes reference explicitly preallocates its
  fixed table; JZ already retains the final length but still grows the record
  buffer through the generic push helper. This is allocation/lowering work,
  not a missing SIMD pass or evidence that AS inferred the same JS source.
- Compare remaining byte gaps with Binaryen output and fix whole classes through
  existing folding/propagation. Binaryen shrinks several kernels but grows the
  encoder; adopting its entire pipeline is not justified.
- The encoder CPU profile exposed a repeated whole-function local census in
  shared LICM. One incrementally maintained census cuts its per-function
  optimization stage from roughly 720 to 350 ms, with identical output bytes
  before the separate size folds. Compile benchmarking now includes Watr's
  fast cleanup and measures total wall time rather than an incomplete phase sum.
  O0 self-host sampling instead points to string equality/hashing and dynamic
  property access; the LICM reduction does not resolve that timing gate.
- Keep generic affine lane-local vectorization, alias/dependence checks and
  scalar tails. Narrower butterfly/channel/tone-map recognizers and four-term
  dot-product SLP remain; fold overlap into shared machinery when a measured
  gap justifies it. They do not prove arbitrary-program V8 leadership.

A new semantic IR, wholesale context/vectorizer rewrite, region API, selectable
representation tiers and frozen raw ABI are not prerequisites for v1.
