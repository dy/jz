# JZ v1 plan

Compile JavaScript audio DSP for audiojs.dev: JS → Wasm → VST. JZ and
Porffor are selectable compilers behind the same DSP interface. Correct audio,
bounded callback work and reliable installation are the release outcome.

## Release gates

- **Functional verification:** the iterator/shared-optimizer follow-up passes
  4,505 default-suite tests with one skip (63,105 assertions), 34 self-hosting
  checks (296 assertions), and 150 focused iterator/destructuring/numeric checks
  at each of O0, O3 and WASI. The 254 optimizer checks and all ten deterministic
  loop-work ratchets pass. Watr's rebuilt Wasm passes its core, propagation and
  specification suites. The complete new CI matrix remains to run; the previous
  `b0a6e9c5` matrix and extended fuzz passed. Timing remains a separate red gate.
- **Conformance:** function reflection consistently rejects on the known builtin
  and Promise paths. Property descriptors remain a documented limitation; the
  generated array-spread test now has the same classification as its call/new
  siblings. Strict accessor bodies, bare async parameter defaults, malformed
  `await using`, and initialized `for await` bindings are validated before DCE.
  Full language/builtin runs pass 3,151/869 cases with zero failures; the
  accepted-negative ledger is zero. Keep those gates and pass floors intact.
- **Size:** the current encoder measures 300,595 bytes against the unchanged
  300,000-byte limit, down from the preceding focused 305,301-byte build.
  Native collection coverage is included. FFT is 1,726 bytes against
  AssemblyScript's 1,758. Seven AssemblyScript comparisons remain red:
  bezfit, immutable, sdf, shapes, slices, tokenizer and wordcount.
- **Speed/evidence:** the preceding local benchmark run passes 245 checks and fails
  21: runtime gaps, seven AssemblyScript size losses, the encoder budget,
  performance fuzz, two examples, missing TinyGo coverage and stale native
  lowering evidence. The preceding self-compile timing run remains red: best warm
  1.332× against 1.03×; fresh 1.166× against 0.99×.
  TinyGo's local 0.34 installation has a broken root lookup and rejects Go 1.26.
  An isolated official 0.42.0 run builds all 44 comparable cases: 43 checksums
  verify, while entity has an unclassified reference. This repairs the coverage
  diagnosis; it does not replace the committed benchmark snapshot.
  CI's claims job passes 7 of 20 checks. The 13 failures include stale reference
  and memory evidence, invalid swap pressure and unproven runtime/size leadership.
  Live swap remains 14,417 MB against the 4,096 MB evidence-validity limit.
  Refresh the complete reference and memory evidence on a quiet machine after
  the remaining codegen gaps are fixed; do not relax the caps or certify these
  development timings. The old alpha native row also needs that refresh: its
  WASI corruption is fixed and the current paired probe has the correct checksum.
- **Compatibility:** rebuild downstream Wasm with matching compiler and interop
  revisions. Replace the pinned watr archive with an npm release containing its
  required fixes when available. The rebuilt Watr encoder passes 352 core
  and 268 specification tests with the current compiler/interoperability pair.

## Architecture

The shared program summary owns semantic facts; FunctionPlans own physical
representations. The tape transports emitted WAT through linking. Generic
optimization belongs in watr; JZ supplies language and representation proofs.
Detailed ownership and conventions are in [CONTRIBUTING.md](CONTRIBUTING.md).

Runtime method alternatives now share block-callback lowering, avoiding repeated
closure bodies and nested closures without a new cache or ambient state.
The summary's declarations own numeric binding IDs. Kind and incoming facts
use indexed arrays; flow-sensitive assignment and refinement facts use sparse
numeric-keyed collections with per-function reset and branch rollback. Dense
arrays for the sparse facts added allocation without a measurable speed gain,
so they were not retained. The declaration census includes default-parameter
closures before the fixpoint. The latest six-case paired comparison preserves
output bytes and shows no meaningful throughput change from this consolidation.

Generic LICM extraction now has one owner in watr (`3f89641`): traversal,
private-local checks, exact literal deduplication, typing and temporary insertion.
JZ supplies invocation-local language/representation proofs and profitability
policy; watr's standalone policy remains conservative about loads and calls.
The shared engine neither reads nor stamps JZ metadata. Both JZ maturity points
and watr's post-inline invocation use the same engine. Loop vectorization and
SLP remain distinct.

Scalar constant pooling now runs in Watr after folding and inlining, before
outlining prices repeated expressions; JZ’s
separate tape implementation is removed. Propagation folds whole expressions
through known locals when the encoded result is no larger. The shared pool
preserves exact bits and imported-global indices and accounts for signed
immediate widths. It remains disabled at the speed tier.


JZ now reuses watr's memory-write classifier. Narrow, floating, 64-bit, SIMD,
bulk and atomic writes block mutable helper reads; unknown targets block
alias-dependent motion. Buffer-origin analysis follows single-definition locals
and closed scalar recurrences; other origins remain unknown. Allocation blocks speculative string
indexing and motion of allocator-global reads.
Executable regressions cover these effects, zero-trip loops, signed-zero
constants, shared AST ancestors, and temporaries read outside the loop.

The earlier consolidation produced a 15,417,678-byte compiler and a working
14,893,075-byte recursively compiled child. Those are historical artifacts;
compare fresh private builds under the same profile when attributing growth.
Measurements were made on a loaded development machine and are not release
certification. A six-case profile still attributes about 21% of samples to string hashing,
equality and dynamic property reads. Follow measured lookup/lowering costs;
a new semantic IR or wholesale vectorizer rewrite is not a v1 prerequisite.

## Remaining semantic/lifetime work

Host-exposed object schemas now use tagged BigInt fields; mixed Number/BigInt
shapes no longer require raw-bit decoding guesses. Field-type and numeric
contracts remain, preserving typed class methods. Host construction and writes
preserve boolean identity. Returned literals allocate independently; top-level
initializers outside loops keep static storage. Field metadata omits absent
refinements. The final correctness matrix and bootstrap pass on `b0a6e9c5`.
Shared pooling runs before outlining estimates costs; the size regression is
repaired without changing its 120-byte ratchet (the case is now 119 bytes).

WASI clocks now reserve their own eight-byte static slot instead of overwriting
address zero. Integer console output preserves signed and unsigned 32-bit
values using the existing decimal formatters. All 48 focused WASI tests pass.
The alpha native-lowering probe now has a valid checksum; the current paired
run puts wasm2c at 0.92× the V8 Wasm time. This development sample does not
replace the full committed performance evidence.

- The focused review’s reproduced boundary defects are repaired: standalone
  allocations round upward, recursive writes stage before acquiring their view,
  and plain field metadata enforces the representations used by lowering.
  Retained host arrays have open element facts; fresh returned arrays retain
  construction-time specialization. Analysis dependencies and invalidation seams
  are explicit; whole-store invalidation includes anonymous bodies. See
  [ARCHITECTURE-REVIEW.md](ARCHITECTURE-REVIEW.md) for evidence and remaining gates.

- DataView reads now distinguish byte bounds from indexed elements: `.length`
  and absent numeric properties return undefined. Generic TYPED facts no longer
  prove integer length; concrete typed-array constructors retain that proof.
  Indexed writes reject instead of overwriting buffer bytes. Indexed own
  properties remain unsupported (STABILITY.md); no new representation was added.
  This follow-up passes 4,493 core tests (one skip, 63,022 assertions), 33
  self-hosting tests and 869 builtin conformance cases. The focused Watr size
  harness grows from 304,983 to 305,301 bytes (+318); the size target remains
  open. These harness figures differ from the full benchmark backstop above.
- Parameters, declarations and assignments share iterator-pattern lowering.
  Pulls/defaults remain ordered; early completion and binding errors close the
  iterator. Assignment returns its source and snapshots member references before
  pulling. Literal arrays retain direct lowering. Indexed iterators hold their
  cursor directly, avoiding a next closure and per-step result allocation.
  Native Map/Set views retain the existing snapshot limitation (STABILITY.md).
- UTF-16 strings are implemented throughout the value ABI, including lone
  surrogates. UTF-8 is confined to encoding/I/O and Wasm metadata; binary data
  remains bytes. The six-ASCII-unit short-string representation is unchanged.
- The durable-slot log reuses canceled entries. Preserve repeated-compile/reset
  gates; measure warm allocation before a broader ambient-state refactor.

## DSP proof

The gain fixture in `@audio/compile` passes 132 checks per compiler over 12,000
blocks. The new `--stateful` mode passes 12,438 checks with each compiler:
a stereo one-pole closure agrees exactly with JS across variable blocks, live
parameters, overlapping instances, close/reopen and last-close runtime reset.
Both callback heaps remain fixed. The native adapter passes the actual frame
count and reads JZ's generated argument ABI. This is fixture evidence; the public
`@audio/compile-vst` builder remains to be implemented.

On the M4 Max gain fixture, median 128-frame stereo blocks measured 0.625 µs with
JZ and 1.166 µs with Porffor, including native hosting and copies. This demonstrates
fixture feasibility, not a universal ranking or real-time guarantee. Porffor keeps
its shared arena until the final instance closes; concurrent audio threads and
within-block automation remain unvalidated. Compiler selection is a build option
(the fixture supports `--compiler=jz|porffor`), not audio-module metadata.

## Next reductions from the WAT inspection

- Watr `c99ab16` folds integer equality to zero in its existing identity sweep
  and recognizes the canonical zero arm during dense-switch lowering. JZ’s
  duplicate fold and bare-local exception are removed. No pass was added.
- In `slices`, inlining leaves five copies of unchanged caller arguments inside
  the outer loop. Eliminate those through existing inline/local propagation,
  with argument-order and local-write proofs; do not add another cleanup pass.
- In `shapes`, JZ inlines a large dispatch body and reloads/divides the array
  header length each outer iteration. AssemblyScript keeps dispatch out of line
  and encodes the length from its typed source. Improve size-aware inlining and
  propagate JZ's own length proof; keep the benchmark source unchanged.
- Loop SIMD uses affine addresses, lane purity, alias/dependence checks and a
  scalar tail. SLP is separate. Narrower butterfly, channel-reduction and
  mixed-lane recognizers remain; dot SLP still assumes the emitter's four-term
  unroll. These are structural templates, not benchmark-name dispatch, but they
  are not an arbitrary-expression SLP optimizer. Fold them into shared lifting
  only when equivalence tests demonstrate a deletion. The ten loop-op ratchets
  pass; they do not certify universal runtime leadership over V8.

The audit confirms general affine lane-local vectorization with dependence/alias
checks and scalar tails. It also finds narrower recognizers (butterfly, channel
reduction, tone mapping) and a four-term dot-product SLP matcher. These are
structural patterns, but not arbitrary-expression SLP. Preserve the common
address/lane machinery and fold overlapping recognizers when a measured gap
justifies it; do not describe every recognizer as general vectorization.

Fresh self-hosting passes 34 checks (296 assertions). With the same pinned Watr
and build profile, the preceding source builds to 15,424,208 bytes and this
source to 15,426,119: +1,911 bytes (0.012%). The small correctness cost here
should not be confused with differences between stale dist artifacts.

The current focused size run retains seven AssemblyScript losses: bezfit
3,261/3,017; immutable 1,482/1,481; sdf 2,260/2,209; shapes 1,875/1,695;
slices 1,660/1,657; tokenizer 1,574/1,551; wordcount 3,786/3,480 bytes.
Binaryen’s `-Oz` also shrinks several JZ outputs (including immutable to 1,415
and shapes to 1,821); investigate those remaining generic reductions. It grows
the encoder to 340,731, so adopting its entire pipeline is not supported.
The claims audit still rejects the stale snapshot, including V8 losses on
jessie and watr. No universal V8 lead, final timing result or v1 approval follows
from this inspection. Benchmark inputs, thresholds and reference rows are unchanged.
