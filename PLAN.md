# JZ v1

Compile audiojs.dev DSP through JS → Wasm → VST, with JZ or Porffor selected
at build time. Release means correct audio, bounded callback work, reproducible
installation and passing conformance, speed and size gates.

README owns the public contract; CONTRIBUTING owns compiler architecture and
invariants. Completed reviews and superseded design proposals remain in Git
history. This file tracks only release evidence and unfinished work.

## Verification

The audit follow-up pins Watr `9120319`: public adapters retain shared large
workers, nonescaping record replacement scalarizes, and fixed array lengths
survive lowering and cold argument-free builder inlining. Mixed numeric/tagged comparisons
preserve the original value; Float32 maps retain f64 computation; standalone
higher-order exports accept host callbacks through the existing call ABI.
Bare f64 globals initialize to `undefined`, including when storage analysis has
recorded their type; this keeps nullish closure initialization correct at O0.
The full default suite passes 4,517 tests with one skip (63,676 assertions),
including six audit regressions with 383 assertions and all ten deterministic
loop-work ratchets. Language/builtin conformance passes
3,151/869 cases, and functional self-hosting passes 34 checks (296 assertions).
The rebuilt Watr Wasm passes its full suite. The full O0/O3/WASI matrix also
passes: 4,517/4,517/4,514 tests respectively, with one skip in each leg.

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
   | Watr encoder | 301,361 | 300,000 |
   | FFT | 1,718 | 1,758 |
   | bezfit | 3,245 | 3,017 |
   | immutable | 1,481 | 1,481 |
   | sdf | 2,224 | 2,209 |
   | shapes | 1,846 | 1,695 |
   | slices | 1,628 | 1,657 |
   | tokenizer | 1,559 | 1,551 |
   | wordcount | 3,722 | 3,480 |

   Equality is not a strict win. No benchmark sources or budgets changed.
   Against `b401fe2`, shapes shrinks 12 bytes and wordcount 26; the encoder grows
   862 bytes. Audit kernels shrink: vec/add 4,185→101 bytes (no heap), Float32
   scale 1,013→869, Uint8 clamp 1,213→1,055, matmul 25,561→25,407.
   Correct mixed-value comparison grows fib 18,694→18,894. These are binary
   sizes, not throughput claims; the size gate remains open.

2. **Speed and evidence.** The stored reference fails leadership claims,
   including V8 losses on jessie and Watr, and is stale. Prior self-compile
   timing also fails: warm 1.332× against 1.03× and fresh 1.166× against 0.99×.
   Excessive load/swap invalidates development timing as release evidence.
   The audit validation also fails the warm self-compile gate (1.340× median
   against 1.03×); its functional bootstrap passes. Concurrent validation is
   insufficient evidence for any fresh-start performance improvement.
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
   Fix missing-field reads after record shape changes: `let p={x:1,y:2};
   p={x:3}; return p.y` currently returns `0`, not `undefined`, including O0.
   Scalar replacement rejects differing field sets; this remaining defect is
   in the general record representation/read proof.

5. **Review handoff.** Complete the callable-reachability probe (exports,
   address-taken functions, init/default/optional/member/dispatch edges). Give
   an independent reviewer a pinned candidate and its gate logs; previous
   implementation work does not constitute independent expert approval.

## Next reductions

- Extend the retained length/layout facts only where remaining WAT demonstrates
  a gap. Fixed literals/builders and equal-count push branches now propagate
  through local and parameter ValueReps; resizing, spread and escape invalidate
  them. Shapes still exceeds AssemblyScript despite the removed length work.
- Compare remaining byte gaps with Binaryen output and fix whole classes through
  existing folding/propagation. Binaryen shrinks several kernels but grows the
  encoder; adopting its entire pipeline is not justified.
- Keep generic affine lane-local vectorization, alias/dependence checks and
  scalar tails. Narrower butterfly/channel/tone-map recognizers and four-term
  dot-product SLP remain; fold overlap into shared machinery when a measured
  gap justifies it. They do not prove arbitrary-program V8 leadership.

A new semantic IR, wholesale context/vectorizer rewrite, region API, selectable
representation tiers and frozen raw ABI are not prerequisites for v1.
