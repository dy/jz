# JZ v1 plan

Compile JavaScript audio DSP for audiojs.dev: JS → Wasm → VST. JZ and
Porffor are selectable compilers behind the same DSP interface. Correct audio,
bounded callback work and reliable installation are the release outcome.

## Release gates

- **Functional verification:** the full default/O0/O3/WASI matrix passes
  (4,466/4,466/4,466/4,463 tests, one skip per leg), as do self-compilation,
  hosted closure regressions and type checks.
- **Conformance:** function reflection consistently rejects on the known builtin
  and Promise paths. Property descriptors remain a documented limitation; the
  generated array-spread test now has the same classification as its call/new
  siblings. Strict accessor bodies, bare async parameter defaults, malformed
  `await using`, and initialized `for await` bindings are validated before DCE.
  Full language/builtin runs pass 3,151/869 cases with zero failures; the
  accepted-negative ledger is zero. Keep those gates and pass floors intact.
- **Size:** callback lowering across runtime method arms reduces Watr from
  330,237 to 305,757 bytes. Its 300,000-byte budget remains open. Current size
  losses to AssemblyScript: bezfit, dispatch, fft, immutable, lz, sdf, shapes,
  slices, tokenizer and wordcount. Keep benchmark sources and thresholds fixed.
- **Speed/evidence:** committed benchmark results predate the current compiler.
  Refresh complete rival coverage after fixes, on a machine within the existing
  load/swap limits. A loaded development run cannot certify leadership. The
  current self-compile timing gate still fails: best warm geomean 1.313×
  against 1.03×, fresh 1.134× against 0.99×. Measured with 13.5 GB swap in use;
  do not treat this run as release evidence or relax the caps.
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
The rebuilt compiler is 15,372,714 bytes (51,050 fewer than the UTF-16 baseline).
A six-case warm self-compile CPU profile puts about 26% of Wasm samples in string
hashing/equality, dynamic property reads and Map lookup. Reducing repeated
metadata access is the next measured lead for compiler throughput; loop-pass
consolidation serves generated-code quality and maintainability separately.

The next loop consolidation should give generic LICM one owner in watr and
express JZ's helper effects/alias proofs as explicit inputs. Today JZ's LICM
contains those contracts and runs before and after address rewriting; watr's
LICM handles pure arithmetic after inlining. They are not interchangeable.
Migrate with zero-trip/trap/alias tests and corpus measurements before deleting
an invocation or pass. Vectorizers should share loop shape, address and effect
analysis; retain distinct loop and adjacent-scalar packing strategies. Replacing
all recognizers or adding a new semantic IR is not a prerequisite for v1.

## Remaining semantic/lifetime work

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
Exercise variable block sizes, persistent state, instance teardown and bounded
allocation in the process callback before generalizing `@audio/compile-vst`.

On the M4 Max gain fixture, median 128-frame stereo blocks measured 0.625 µs with
JZ and 1.166 µs with Porffor, including native hosting and copies. This demonstrates
fixture feasibility, not a universal ranking or real-time guarantee. Porffor keeps
its shared arena until the final instance closes; concurrent audio threads and
within-block automation remain unvalidated. Compiler selection is a build option
(the fixture supports `--compiler=jz|porffor`), not audio-module metadata.
