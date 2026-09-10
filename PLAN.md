# JZ v1

Compile audiojs.dev DSP through JS → Wasm → VST, with JZ or Porffor selected
at build time. Release means correct audio, bounded callback work, reproducible
installation and passing conformance, speed and size gates.

README owns the public contract; CONTRIBUTING owns compiler architecture and
invariants. Completed reviews and superseded design proposals remain in Git
history. This file tracks only release evidence and unfinished work.

## Verification

The shared-inliner pin `b401fe2` passes 4,510 core tests with one skip
(63,188 assertions), 34 self-hosting checks, 254 focused optimizer checks at each
of O0/O3/WASI, and all ten deterministic loop-work ratchets. Language and builtin
conformance pass 3,151/869 cases with zero failures and zero accepted invalid
parse cases. Watr's rebuilt Wasm passes core, propagation and specification
suites. The complete new CI matrix remains to run; focused local checks do not
replace it.

The stateful VST fixture in `@audio/compile` passes 12,438 checks with each
compiler (JZ reverified on this optimizer; Porffor verified previously): variable blocks, live parameters, independent overlapping instances,
close/reopen and last-close reset agree exactly with JS and keep callback heaps
fixed. The gain fixture passes 132 checks per compiler over 12,000 blocks.
These are fixture proofs, not a public target builder or a real-time guarantee.

## Open gates

1. **Size.** Keep the encoder cap at 300,000 bytes and strict per-case
   AssemblyScript leadership. The shared-inliner revision measures:

   | Case | JZ bytes | Limit / AS bytes |
   |---|---:|---:|
   | Watr encoder | 300,499 | 300,000 |
   | FFT | 1,718 | 1,758 |
   | bezfit | 3,245 | 3,017 |
   | immutable | 1,481 | 1,481 |
   | sdf | 2,224 | 2,209 |
   | shapes | 1,858 | 1,695 |
   | slices | 1,628 | 1,657 |
   | tokenizer | 1,559 | 1,551 |
   | wordcount | 3,748 | 3,480 |

   Equality is not a strict win. No benchmark sources or budgets changed.
   Relative to the preceding revision, all nine measured outputs shrink. The
   compiler itself shrinks 7,111 bytes to 15,419,008. The fixed structural corpus
   emits 2,098 fewer instructions inside loops across four categories; the other
   six are unchanged, and all 400 programs compile. This is code-size/work
   evidence, not a new timing claim.

2. **Speed and evidence.** The stored reference fails leadership claims,
   including V8 losses on jessie and Watr, and is stale. Prior self-compile
   timing also fails: warm 1.332× against 1.03× and fresh 1.166× against 0.99×.
   Excessive load/swap invalidates development timing as release evidence.
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

5. **Review handoff.** Complete the callable-reachability probe (exports,
   address-taken functions, init/default/optional/member/dispatch edges). Give
   an independent reviewer a pinned candidate and its gate logs; previous
   implementation work does not constitute independent expert approval.

## Next reductions

- Preserve known array lengths through lowering and size-aware inlining.
  The shapes WAT repeats header loads/division and inlines a large dispatch;
  AssemblyScript retains dispatch as a function and encodes a known length.
- Compare remaining byte gaps with Binaryen output and fix whole classes through
  existing folding/propagation. Binaryen shrinks several kernels but grows the
  encoder; adopting its entire pipeline is not justified.
- Keep generic affine lane-local vectorization, alias/dependence checks and
  scalar tails. Narrower butterfly/channel/tone-map recognizers and four-term
  dot-product SLP remain; fold overlap into shared machinery when a measured
  gap justifies it. They do not prove arbitrary-program V8 leadership.

A new semantic IR, wholesale context/vectorizer rewrite, region API, selectable
representation tiers and frozen raw ABI are not prerequisites for v1.
