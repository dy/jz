# JZ v1

Compile audiojs.dev DSP through JS → Wasm → VST, with JZ or Porffor selected
at build time. Release means correct audio, bounded callback work, reproducible
installation and passing conformance, speed and size gates.

README owns the public contract; CONTRIBUTING owns compiler architecture and
invariants. Completed reviews and superseded design proposals remain in Git
history. This file tracks only release evidence and unfinished work.

## Verification

JZ pins Watr `c001a5f`. Exact cast simplification is shared between early
lowering and the final optimizer; integer pools use canonical values. Record
replacement preserves missing fields, own keys, BigInt and absent-array reads.
Eight audit regressions pass 923 assertions across all optimization tiers.
With the shared workspace's pending test consolidation, default passes 4,197
checks (46,620 assertions); O0/O3/WASI pass 3,983/3,983/4,034 checks
(38,652/38,973/39,048 assertions), each with one skip. Default's benchmark-anchor
checks pass with their unchanged tolerance. Language/builtin conformance passes 3,151/869 cases.
Functional self-hosting passes 34 checks (296 assertions). Watr rebuilt with
this compiler passes its full Wasm suite. The VST results below predate the
shape-consensus and shared-cast changes.

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
   | Watr encoder | 300,301 | 300,000 |
   | FFT | 1,716 | 1,758 |
   | bezfit | 3,244 | 3,017 |
   | immutable | 1,478 | 1,481 |
   | sdf | 2,224 | 2,209 |
   | shapes | 1,839 | 1,695 |
   | slices | 1,628 | 1,657 |
   | tokenizer | 1,555 | 1,551 |
   | wordcount | 3,704 | 3,480 |

   Equality is not a strict win. No benchmark sources or budgets changed.
   Watr `c001a5f` shares exact casts with JZ's early lowering, removes redundant
   narrow-store casts/masks, and pools integer bits independently of spelling.
   Tiny unprofitable literals no longer allocate pool records. Against `9b9b0bee`,
   encoder/FFT/bezfit/tokenizer/wordcount shrink 182/2/1/1/2 bytes; the other four
   measured cases are unchanged. No new pass or runtime representation is added.
   A paired self-build with unrelated workspace changes held constant grows
   15,255,422→15,256,927 bytes (+1,505). Paired warm compilation on six workloads
   is 0.997× after/before, effectively neutral; generated O0 bytes match exactly.
   These scoped measurements do not close the speed or memory gates.
   Binaryen `-Oz` on the resulting modules yields encoder 340,600, shapes 1,805,
   tokenizer 1,534, wordcount 3,696 and bezfit 3,540 bytes. Its small kernel wins
   justify individual general folds, not adding its entire pipeline.

2. **Speed and evidence.** The stored reference fails leadership claims,
   including V8 losses on jessie and Watr, and is stale. After this consolidation,
   the isolated self-compile timing gate still fails: warm 1.455×/1.500×/1.519×
   against 1.03×, fresh 1.225× against 0.99×. Functional bootstrap passes.
   These are current gate results, not a paired before/after speed comparison.
   The last complete benchmark run, before tiny-constant specialization, passed
   247 checks and failed 19: eight fastest-Wasm comparisons, native resample,
   stored native-lowering bands, six strict AS size comparisons, the encoder cap,
   perf-fuzz and example speed. Immutable's size comparison is now fixed by the
   measured specialization above; the complete rival reference still needs renewal.
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
- Keep generic affine lane-local vectorization, alias/dependence checks and
  scalar tails. Narrower butterfly/channel/tone-map recognizers and four-term
  dot-product SLP remain; fold overlap into shared machinery when a measured
  gap justifies it. They do not prove arbitrary-program V8 leadership.

A new semantic IR, wholesale context/vectorizer rewrite, region API, selectable
representation tiers and frozen raw ABI are not prerequisites for v1.
