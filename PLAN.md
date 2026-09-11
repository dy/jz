# JZ v1

Compile audiojs.dev DSP through JS → Wasm → VST, with JZ or Porffor selected
at build time. Release means correct audio, bounded callback work, reproducible
installation and passing conformance, speed and size gates.

README owns the public contract; CONTRIBUTING owns compiler architecture and
invariants. Completed reviews and superseded design proposals remain in Git
history. This file tracks only release evidence and unfinished work.

## Verification

JZ pins Watr `a3e8ef6` and Subscript `0f65c86`. All default/O0/O3/WASI matrix
legs pass. Language and built-in conformance pass
3,151/869 cases with zero unexpected failures (8/45 expected failures remain).
Functional self-hosting passes 40 checks / 2,283 assertions; the recursive gate
also passes, producing a 14,683,818-byte compiler. This is functional evidence,
not release certification or a speed pass.

The compiler's browser bundle is 2,426,136 bytes, down from 2,436,551 at the
preceding checkout. Its Wasm artifact is 15,204,082 bytes, down from 15,218,730.
Lifecycle diagnostics are isolated and removed from release bundles. The
focused debug suites pass 49 lifecycle/structural checks and 10 audit regressions,
including repeated compilation, changed shapes, frozen facts and error recovery.
Watr's source and freshly rebuilt Wasm suites both pass: 352 public checks
(two skips), optimizer/propagation tests, and 268 spec files (20 skips).

Earlier stateful VST fixtures in `@audio/compile` pass 12,438 checks with each
compiler: variable blocks, live parameters, independent overlapping instances,
close/reopen and last-close reset agree with JS and keep callback heaps fixed.
The gain fixture passes 132 checks per compiler over 12,000 blocks. These
fixtures predate this compiler cleanup; they are not a public target builder
or a real-time guarantee.

## Open gates

1. **Size.** All 60 compiled samples stay no larger after the latest pass.
   JZ strictly beats AssemblyScript on 49/51 comparable cases; two remain open.

   | Case | JZ bytes | Limit / AS bytes |
   |---|---:|---:|
   | Watr encoder | 288,220 | 300,000 |
   | JSON | 10,730 | 12,500 |
   | bezfit | 3,211 | 3,017 |
   | wordcount | 3,635 | 3,480 |

   No benchmark sources or budgets changed. Binaryen grows several of these
   modules; use its useful folds individually, not its entire pipeline.

2. **Speed and evidence.** The stored reference fails leadership claims,
   including V8 losses on jessie and Watr, and is stale. After the decimal,
   string and JSON reductions, self-compile timing still fails: the latest
   sample is warm 1.454×/1.475×/1.517× against 1.03×, fresh 1.236× against
   0.99×. This sample overlapped WASI validation; it does not establish a
   speed change. Functional bootstrap passes. A subsequent quiet paired
   probe of the load-cost fix preserves checksums and gives shapes 0.998×
   after/before runtime, with unchanged controls at 1.003–1.020×; no runtime
   improvement is claimed.
   The complete benchmark run passes 250 checks and fails 16 (previously
   247/19). JSON's native comparison and the JSON/encoder size caps pass.
   Remaining failures: fastest-Wasm delayline, glyfparse, sdf, slices, lz,
   base64, shapes and wordcount; native resample; stored native-lowering
   bands; strict AS size comparisons for bezfit and wordcount
   (dispatch/shapes closed by the reductions below); perf-fuzz; and example speed (19/21 strict wins, with
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

- Carry caller-proven affine index facts across internal helper calls using
  the existing parameter summaries and bounds proofs. In the size build,
  bezfit's `fitOnce` still takes offsets `o`/`co` as f64; its body is 928 B
  versus AS's 612 B, with conversion and checked-index code. Preserve checks
  for open inputs; no source hints or benchmark-specific rules.
- Continue eliminating repeated compiler work through existing ownership.
  The binding-use census now supplies array safety and push-site counts;
  fixed builder lengths reserve capacity through ValueReps. Diagnostics use
  one flag and one release specialization; pass-through context views and the
  empty host-profile placeholder are removed. Watr's cost estimator now counts
  implicit memory immediates, enabling profitable repeated-load CSE. These
  changes remove code or improve existing passes without adding another pass.
- String specialization must account for retained shared helpers. Fusing a
  single-unit constructor into append increased wordcount by 100 B; rejected.
  O0 self-host profiles still point to string equality/hashing and dynamic
  property access. The shared LICM census reduction does not close that gate.
- Keep generic lane vectorization, dependence checks, scalar tails and SLP.
  Fold the remaining narrower recognizers only when a measured gap justifies
  it; their presence does not prove arbitrary-program V8 leadership.

A new semantic IR, wholesale context/vectorizer rewrite, region API, selectable
representation tiers and frozen raw ABI are not prerequisites for v1.
