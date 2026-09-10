# JZ v1

Compile audiojs.dev DSP through JS → Wasm → VST, with JZ or Porffor selected
at build time. Release means correct audio, bounded callback work, reproducible
installation and passing conformance, speed and size gates.

README owns the public contract; CONTRIBUTING owns compiler architecture and
invariants. Completed reviews and superseded design proposals remain in Git
history. This file tracks only release evidence and unfinished work.

## Verification

The audit follow-up pins Watr `e146006`: public adapters retain shared large
workers, nonescaping record replacement scalarizes, and fixed array lengths
survive lowering and cold argument-free builder inlining. Mixed numeric/tagged comparisons
preserve the original value; Float32 maps retain f64 computation; standalone
higher-order exports accept host callbacks through the existing call ABI.
Bare f64 globals initialize to `undefined`, including when storage analysis has
recorded their type; this keeps nullish closure initialization correct at O0.
Record declarations and assignments now share shape consensus. Replacement
preserves missing fields and own keys, including BigInt and absent-array reads.
Eight audit regressions pass 923 assertions across all optimization tiers.
With the shared workspace's pending test consolidation, default passes 4,197
checks (46,620 assertions); O0/O3/WASI pass 4,011/4,011/4,062 checks
(38,652/38,973/39,048 assertions), each with one skip. Default's benchmark-anchor
check failed under concurrent matrix load and passed in the isolated full rerun;
its tolerance is unchanged. Language/builtin conformance passes 3,151/869 cases.
Functional self-hosting passes 34 checks (296 assertions). The downstream Watr
Wasm and VST results below predate this shape-consensus change.

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
   | Watr encoder | 300,483 | 300,000 |
   | FFT | 1,718 | 1,758 |
   | bezfit | 3,245 | 3,017 |
   | immutable | 1,478 | 1,481 |
   | sdf | 2,224 | 2,209 |
   | shapes | 1,839 | 1,695 |
   | slices | 1,628 | 1,657 |
   | tokenizer | 1,556 | 1,551 |
   | wordcount | 3,706 | 3,480 |

   Equality is not a strict win. No benchmark sources or budgets changed.
   Before the record-shape fix, the audit measured shapes −19 bytes, wordcount
   −42 and encoder +891 against `b401fe2`. Audit kernels shrink: vec/add 4,185→101 bytes (no heap), Float32
   scale 1,013→869, Uint8 clamp 1,213→1,055, matmul 25,561→25,407.
   Correct mixed-value comparison grows fib 18,694→18,894. These are binary
   sizes, not throughput claims; the size gate remains open.

   Named callable values now retain identity in the existing closure analysis.
   A recursive array builder called through an internal object member shrinks
   from 24,643 to 21,394 bytes at speed. On its 32-element O0 probe, pointer-type
   checks fall 165→0 and dynamic property reads 32→0; allocation count remains
   two. Its 25 summary tests pass 9,431 assertions; language/builtin conformance,
   functional self-hosting and the rebuilt Watr Wasm suites also pass.
   The encoder saves 68 bytes. Mixed-kind uses still lose callable identity,
   so this does not eliminate all generic iterator handling in the encoder.
   With the shared workspace's pending import cleanup held constant, a direct
   before/after self-build comparison shrinks the compiler artifact
   15,515,517→15,474,859 bytes. On the six warm compiler workloads, the paired
   after/before geomean is 0.996× (effectively neutral); measured heap use rises
   672–848 bytes per compilation. These scoped measurements do not close the
   release memory or throughput evidence requirements.
   The review follow-up fixes nullable callable dispatch: missing object/array
   entries throw TypeError after argument evaluation, including spreads. The
   shared closure-call boundary captures the callee before arguments and checks
   callability after their effects. Generic, spread and member calls share it;
   duplicate lowering is removed. Required checks add 133 encoder bytes. The
   184-assertion regression covers empty tables/spreads, null, member replacement,
   argument exceptions and A→A→failing B→A recovery at all tiers and under WASI.

   Watr `e146006` substitutes shared tiny constant parameters directly at every
   immutable read. This removes synthesized locals rather than adding a pass.
   Relative to the call-boundary fix it saves encoder/shapes/immutable/tokenizer/
   wordcount 36/7/3/3/16 bytes; the other four measured outputs are unchanged.
   Immutable now passes strict AS size leadership. Numeric constant evaluation
   is consolidated across five former evaluators, with module planning removed
   from the driver; that consolidation alone leaves all nine sizes unchanged.
   A paired self-build with the same optimizer and pending import cleanup on
   both sides shrinks 15,479,117→15,468,221 bytes. Across mat4/fft/biquad/sort/
   crc32/mandelbrot, measured allocation falls 824/2,728/2,328/1,160/920/1,688
   bytes per compilation; paired throughput is 0.987× after/before (a small difference,
   measured during concurrent validation). Direct AST indexing avoids iterator allocation in the shared evaluator.
   These are scoped comparisons, not evidence that the release caps pass.

2. **Speed and evidence.** The stored reference fails leadership claims,
   including V8 losses on jessie and Watr, and is stale. After this consolidation,
   the isolated self-compile timing gate still fails: warm 1.441×/1.479×/1.480×
   against 1.03×, fresh 1.229× against 0.99×. Functional bootstrap passes.
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
   Record replacement now shares declaration/assignment shape consensus:
   missing fields remain absent, including replacement after `Object.assign`.
   The duplicated declaration check is removed. Lost schema identity now selects
   existing tagged BigInt storage, and representation planning retains computed
   field initializers. Possibly absent arrays use the existing checked array
   helper. This shrinks the encoder 301,390→300,483 B (907 B); the other eight
   size fixtures stay byte-identical. The encoder is still 483 B over its cap.
   A separate callable edge remains: `let p={x:1,y:2}; p={x:3}; p.y()`
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
- Compare remaining byte gaps with Binaryen output and fix whole classes through
  existing folding/propagation. Binaryen shrinks several kernels but grows the
  encoder; adopting its entire pipeline is not justified.
- Keep generic affine lane-local vectorization, alias/dependence checks and
  scalar tails. Narrower butterfly/channel/tone-map recognizers and four-term
  dot-product SLP remain; fold overlap into shared machinery when a measured
  gap justifies it. They do not prove arbitrary-program V8 leadership.

A new semantic IR, wholesale context/vectorizer rewrite, region API, selectable
representation tiers and frozen raw ABI are not prerequisites for v1.
