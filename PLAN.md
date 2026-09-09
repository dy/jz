# JZ plan

## Purpose

Compile JavaScript audio DSP efficiently for audiojs.dev: JS → Wasm → VST.
JZ is a compiler option; Porffor may replace it. The plugin host must depend on
an explicit DSP interface, not JZ's internal object layout or compiler IR.

The useful result is a plugin that sounds correct, meets its audio deadline,
and installs reliably. Compiler architecture serves that result.

## Next work

1. **Restore reproducible, passing builds.** Use a remotely installable watr
   revision; run the core/matrix and both projects' compiled suites. Separate
   semantic failures from stale benchmark evidence; do not relax the gates.
2. **Prove stateful DSP lifetime.** The gain fixture in `@audio/compile` now
   passes 132 checks per compiler (JZ and Porffor), including parameter queues,
   overlapping instances and 12,000 blocks without observed heap growth.
   Gain is stateless: next use a filter or the existing compressor to exercise
   exact frame counts, variable blocks, persistent state and instance teardown.
   Keep the same source and JS oracle for both compiler chains.
3. **Make ownership explicit where it fails.** Keep compiler-specific memory
   layouts behind the existing DSP adapter. Establish setup/process/disposal
   ownership and bounded callback allocation before generalizing compile-vst.
   For JZ itself, measure warm compiler allocation and reset behavior before
   removing ambient state; fix the responsible lifetime, not every ctx reader.

Gain timing on M4 Max (48 kHz stereo, scalar builds) measured median block
costs of 0.625 µs for JZ and 1.166 µs for Porffor at 128 frames, including the
native host, shell and copies. Three alternating trials establish feasibility
for this fixture, not a compiler-wide ranking or real-time guarantee. The
Porffor adapter retains its shared arena until the final instance closes;
concurrent audio threads and within-block automation are unvalidated.

The offline Web Audio fixture now matches Node's 16-bit PCM checksum after
repeated one-second, 44.1 kHz stereo renders. The discrepancy came from shared
trig approximation precision; the fixture source is unchanged.

Compiler selection belongs to `@audio/compile-vst`'s build options, not atom
metadata or the host. The implemented fixture accepts `--compiler=jz|porffor`;
the general package is still planned. Both chains must pass the same contract.

## Compiler pipeline

Normalize and expand → settle program facts → lower → link → optimize and
encode in watr. Recompute the summary after program rewrites; emission reads
its settled binding, slot, parameter, result, container and presence facts.
Range proofs and physical storage choices remain separate responsibilities.

The slot-kind census, local value trackers, Map/dictionary alias traces and
repeated parameter-kind joins are removed. Literal tuple positions and
container constructor contents live in summary cells, with mutation and
escape invalidation. Generic local propagation and merging now run in watr
after linking. Guarded scalar updates become selects there too, using Wasm
local types, without synthesizing conditional ASTs after representation planning.
The duplicate local passes, update matcher and cleanup sweep are removed.
Condition chaining and boolean simplification likewise belong to watr; their
tape implementations and linker sweeps are removed.
Snapshot initialization reuses the probe's encoded function bodies when removing
the start preserves indices; changed layouts use the ordinary encoder. Compiler
artifacts explicitly target the JS host, independently of the test matrix.
Fixed scalar builtin callbacks normalize to ordinary functions during prepare,
using signatures that both compiler hosts can read. Their separate WAT closure
emitter is removed. Compile-time math folding and scalar/SIMD emission share
the trig/exp2 coefficient table; reduced-interval trig precision is regression-gated.
Constant folding covers imported module initializers as well as entry statements
and function bodies, so analysis receives normalized constants throughout the graph.
JZ retains lowering-specific optimization and representation proofs.
Static data and shared string pools now stay in Uint8Array chunks from their
producers through relocation and WAT escaping. Binary serialization no longer
depends on JavaScript string character semantics.
Compiler-state inspection explicitly uses the in-process entry; execution tests
keep their selected compiler. Session reset no longer owns that test configuration.
The Wasm adapter forwards allocator export options through the shared session setup.
Local schema facts stay in each function's representation plan. Specialized
variants retain source binding names, so publishing their layouts in the global
schema map was unsound. Analysis visits every dynamic literal initializer and
keeps boolean/pointer logical joins distinct. Prepared null and undefined are
ordinary literal values, so the summary sees their presence without private
symbol sentinels. Strict undefined checks retain the possibility of null;
destructuring assignment expressions preserve their RHS identity and effects.
Generator and async exception paths share one finalizer state; normal completion,
rejection and catch exceptions converge there, and finalizer return/throw overrides
the pending exception.
Parameter initialization now shares one lowering across ordinary functions and
generator factories. In iterator-producing programs, array parameters pull lazily,
interleave defaults and close on early completion. Uncaught generator exceptions
close the machine, including machines without source-level try/catch.
Subscript 10.7.3 restores ASI state when speculative method parsing backtracks;
JZ requires that published patch, including its multiplication-after-semicolon fix.

## Release gates

- Run the core, matrix, conformance and self-hosting gates on the packaged
  revision. Record baseline failures separately from regressions.
- Compiler byte-string builders are removed. Public string construction and
  decoding still need a consistent UTF-8 contract; the fromCharCode > 255
  regression remains open. Resolve surrogate handling and escape decoding together;
  changing a single assertion does not establish a consistent string contract.
- Conformance still exposes property enumerability and function reflection.
  Iterator parameter acquisition/step errors are corrected; declaration and
  assignment patterns still use indexed lowering. DataView also shares its
  runtime tag/aux with Int8Array views, so dynamic iterable classification cannot
  distinguish them yet. Preserve semantics or clearly
  reject unsupported operations; do not add failure-ledger entries to hide them.
- The warm Map/property failure came from counting duplicate and cancelled
  durable-slot log entries toward a fixed limit. The log now reuses them;
  retain the repeated-compile and reset tests as lifecycle gates.
- Speed and size promises require measured evidence, including the DSP fixture.
  Architecture changes alone do not establish real-time suitability. Refresh
  benchmark and memory evidence after compiler changes, with complete rival
  coverage and a machine inside the existing load/swap validity limits. The
  committed evidence is currently stale and does not meet those requirements.
- Replace the pinned watr source archive with an npm release when it contains
  the required fixes.

Semantic IR, more generic-pass migration, JS runtime replacements and removing
ambient ctx are optional follow-ups. Take one only for a reproduced defect,
a measured DSP bottleneck, or a deletion that preserves behavior. Historical
plans remain recoverable through [.work/README.md](.work/README.md).
