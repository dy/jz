# JZ v1 plan

Compile JavaScript audio DSP for audiojs.dev: JS → Wasm → VST. JZ and
Porffor are selectable compilers behind the same DSP interface. Correct audio,
bounded callback work and reliable installation are the release outcome.

## Release gates

- **Functional verification:** default/O0/O3/WASI and extended fuzz pass in CI
  on `df25e1ba`. Local default/O0/O3 each pass 4,487 tests with one skip.
  Self-hosted correctness passes 32 tests; recursive self-compilation, public
  type checks and example builds pass. Self-compile timing remains a separate
  failing gate.
- **Conformance:** function reflection consistently rejects on the known builtin
  and Promise paths. Property descriptors remain a documented limitation; the
  generated array-spread test now has the same classification as its call/new
  siblings. Strict accessor bodies, bare async parameter defaults, malformed
  `await using`, and initialized `for await` bindings are validated before DCE.
  Full language/builtin runs pass 3,151/869 cases with zero failures; the
  accepted-negative ledger is zero. Keep those gates and pass floors intact.
- **Size:** callback lowering across runtime method arms reduces Watr from
  330,237 to 305,757 bytes before this review. Enforced host contracts bring
  the current encoder fixture to 306,790 bytes; its 300,000-byte budget remains
  open. Current size losses to AssemblyScript: bezfit, dispatch, fft, immutable, lz, sdf, shapes,
  slices, tokenizer and wordcount. Keep benchmark sources and thresholds fixed.
- **Speed/evidence:** committed benchmark results predate the current compiler.
  Refresh complete rival coverage after fixes, on a machine within the existing
  load/swap limits. A loaded development run cannot certify leadership. The
  current self-compile timing gate still fails: best warm geomean 1.320×
  against 1.03×, fresh 1.134× against 0.99×. The development machine has heavy
  swap use;
  do not treat this run as release evidence or relax the caps. The development
  benchmark run passes 242 gates and fails 24: runtime/size gaps, missing TinyGo
  coverage, stale native-lowering evidence, and two examples below strict wins.
  The pinned revision’s CI benchmark run passes 240 checks and fails 8
  (six AssemblyScript size losses, the Watr size budget and stale native
  lowering evidence); its available rivals differ from the local run.
  CI’s separate claims job fails 13 of 20 checks: stale/invalid evidence,
  incomplete rival coverage and unproven runtime/size leadership. Keep that
  failure distinct from the passing correctness matrix. Failed timing commands
  fail explicitly instead of producing NaN ratios.
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

JZ now reuses watr's memory-write classifier. Narrow, floating, 64-bit, SIMD,
bulk and atomic writes block mutable helper reads; unknown targets block
alias-dependent motion. Buffer-origin analysis follows single-definition locals
and closed scalar recurrences; other origins remain unknown. Allocation blocks speculative string
indexing and motion of allocator-global reads.
Executable regressions cover these effects, zero-trip loops, signed-zero
constants, shared AST ancestors, and temporaries read outside the loop.

The compiler is 15,417,678 bytes, 43,116 more than the preceding revision; the
consolidation and correctness fixes do not establish a size or speed win.
Recursive self-compilation produces a working 14,893,075-byte compiler.
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
refinements. Full core verification reached 4,489 passes and one obsolete static
allocation expectation; the corrected module-initialization distinction passes
all 98 minimal-output and 76 host-memory tests. The final matrix and bootstrap
still need verification on the combined optimizer revision.

- The focused review’s reproduced boundary defects are repaired: standalone
  allocations round upward, recursive writes stage before acquiring their view,
  and plain field metadata enforces the representations used by lowering.
  Retained host arrays have open element facts; fresh returned arrays retain
  construction-time specialization. Analysis dependencies and invalidation seams
  are explicit; whole-store invalidation includes anonymous bodies. See
  [ARCHITECTURE-REVIEW.md](ARCHITECTURE-REVIEW.md) for evidence and remaining gates.

- DataView identity and view bounds are preserved, but `.length` and numeric
  property access still take typed-array fallbacks instead of returning undefined.
- Array parameter destructuring uses iterator semantics. Declaration and assignment
  array patterns still use indexed lowering; keep that difference explicit.
- UTF-16 strings are implemented throughout the value ABI, including lone
  surrogates. UTF-8 is confined to encoding/I/O and Wasm metadata; binary data
  remains bytes. The six-ASCII-unit short-string representation is unchanged.
- The durable-slot log reuses canceled entries. Preserve repeated-compile/reset
  gates; measure warm allocation before a broader ambient-state refactor.

## DSP proof

The gain fixture in `@audio/compile` passes 132 checks per compiler, including
parameter queues, overlapping instances and 12,000 blocks without observed heap
growth. The offline Web Audio render matches Node's PCM checksum. Gain is stateless:
next use a filter or compressor with the same JS oracle under both compilers.
JZ now also checks a stateful filter against JS over 200 blocks with reset,
bit-exact output and stable page count. That host-memory test does not validate
the VST lifecycle. Exercise variable block sizes, persistent state, instance
teardown and bounded allocation in both plugin backends before generalizing
`@audio/compile-vst`.

On the M4 Max gain fixture, median 128-frame stereo blocks measured 0.625 µs with
JZ and 1.166 µs with Porffor, including native hosting and copies. This demonstrates
fixture feasibility, not a universal ranking or real-time guarantee. Porffor keeps
its shared arena until the final instance closes; concurrent audio threads and
within-block automation remain unvalidated. Compiler selection is a build option
(the fixture supports `--compiler=jz|porffor`), not audio-module metadata.
