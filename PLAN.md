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

The complete matrix passes: default 4,194 checks / 57,881 assertions;
O0 4,001 / 45,854; O3 4,001 / 46,175; WASI 4,052 / 50,477, each with one skip.
Language/built-in conformance passes 3,151/869 cases. Functional self-hosting now passes 39 checks
(2,281 assertions), including A → A → B decimal-parser compilation across the
full exponent range. The focused JSON/number/web-global suites cover rounding,
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
The recursive output is 14,689,434 bytes, with a final heap cursor of
1,519,148,904 bytes. The checkpoint reserves the full 4 GiB address space;
the latest gate process peaks at 3,919 MiB RSS. This closes recursive correctness,
not the remaining speed/evidence requirements.

The default-tier URL lookup probe shrinks 39,596→33,163 bytes; speed-tier output
shrinks 47,381→36,711. Paired warm compile medians are 392→321 ms (lookup) and
330→273 ms (literal input). A fixed creation workload uses 288→192 MiB peak
linear memory; its runtime is within measurement noise. JSON correctness has a
cost that the shared decimal runtime now reduces: parsing and formatting use
one 828-byte power-of-five seed table and shared unsigned 64×128 multiplication.
A 245-byte correction stream replaces the 10,416-byte decimal table, with no
runtime initialization or cache. Exact integer operands take one f64 operation
for common decimal exponents. Every power entry and carry-boundary product is
checked against BigInt; conversion tests cover all 651 decimal exponents,
subnormals, overflow, invalid input, clears and shared-memory instances.
The decimal/string changes shrink the compiler artifact
15,277,390→15,215,485 bytes and reduce recursive final heap use by 6,039,032
bytes. They shrink the size-tier JSON kernel 22,061→13,163 bytes and its
speed artifact 29,977→21,080 bytes.

JSON's generic and shape-specialized parsers now share one whitespace scanner
instead of expanding its loop at every token boundary. An inline guard keeps
compact input out of the helper. This further shrinks the speed/size artifacts
to 12,857/10,730 bytes, below the unchanged 12,500-byte size backstop. The
paired compact-input probe stays near parity; formatted input is about 3%
slower. All 65,536 UTF-16 code units are checked against Node at trailing
boundaries and inside active whitespace runs, with EOF and error recovery.
The resulting compiler is 15,209,709 bytes. These probes do not establish
whole-corpus performance leadership.

The focused repeated-conversion probe improves common decimal parsing by
5–23%, but extreme-exponent parsing remains 8–16% slower and formatting 1e100
about 8% slower. This is a measured size/speed trade, not whole-corpus leadership.
Heap-string equality compares four UTF-16 units per load and preserves view
bounds; long equal-string probes improve, short-string throughput is near noise.
FunctionPlan projections now copy only the three supported scalar/schema-array
facts, removing the arbitrary recursive Map/Set/object cloner.

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
   | Watr encoder | 290,151 | 300,000 |
   | FFT | 1,685 | 1,758 |
   | bezfit | 3,211 | 3,017 |
   | immutable | 1,446 | 1,481 |
   | sdf | 2,191 | 2,209 |
   | shapes | 1,807 | 1,695 |
   | slices | 1,595 | 1,657 |
   | tokenizer | 1,520 | 1,551 |
   | wordcount | 3,664 | 3,480 |
   | dispatch | 1,853 | 1,614 |
   | JSON (size artifact) | 10,730 | 12,500 |

   The encoder and JSON caps now pass. Equality is not a strict win. No benchmark sources or budgets changed.
   Watr shares exact casts with JZ's early lowering, removes redundant
   narrow-store casts/masks, and pools integer bits independently of spelling.
   Binaryen `-Oz` on the resulting modules yields encoder 330,447, shapes 1,777,
   tokenizer 1,500, wordcount 3,654 and bezfit 3,511 bytes. Its small kernel wins
   justify individual general folds, not adding its entire pipeline.
   The current zero-test encoding and simpler allocator reduce every sampled
   module and close the SDF/tokenizer size gaps. The allocator retains its
   growth ratios, exact-delta retry and byte-overflow guard; its old page-count
   guard was unreachable. No new optimizer pass or runtime layout is added.

2. **Speed and evidence.** The stored reference fails leadership claims,
   including V8 losses on jessie and Watr, and is stale. After the decimal,
   string and JSON reductions, isolated self-compile timing still fails:
   warm 1.485×/1.535×/1.555× against 1.03×, fresh 1.222× against 0.99×.
   Functional bootstrap passes.
   The complete benchmark run passes 250 checks and fails 16 (previously
   247/19). JSON's native comparison and the JSON/encoder size caps pass.
   Remaining failures: fastest-Wasm delayline, glyfparse, sdf, slices, lz,
   base64, shapes and wordcount; native resample; stored native-lowering
   bands; strict AS size comparisons for bezfit, dispatch, shapes and
   wordcount; perf-fuzz; and example speed (19/21 strict wins, with
   raymarcher 0.92× and percolation 0.87× JS speed).
   The ecosystem run reports jessie/Watr at 2.173×/1.478× JS time; those
   tests report timings without enforcing leadership. Stored-claim checks
   still fail 14 checks: evidence includes 58 stale JZ rows, stale memory
   measurements and an invalid 15.8 GB swap sample. Go-Wasm and Porffor
   each have only 43 comparable rows against a 44-row floor, and the Web
   Audio row lacks a matching result. This evidence cannot certify release.
   The O3 compiler exposed a UTF-16 migration defect: copying substring interning
   added a character offset as bytes and could return an unrelated static token.
   Copy/view interning now shares its address calculation; the unreachable old
   SSO copy branch is removed. The minimal false-hit/true-hit regression and
   O3 parser/recursive probes pass. A paired six-case probe gives about 6% faster
   warm compilation for a 13% larger compiler artifact; the production build
   profile remains unchanged. This exploratory comparison is not gate certification.
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

- Reuse the binding-use census for array safety instead of rescanning a body
  for each candidate in `safeReads`/`ownReads`. First distinguish member calls
  from member reads in that census: `a.length()` must not acquire the proof
  for `a.length`. Keep default-deny handling of captures, aliases and writes.
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
