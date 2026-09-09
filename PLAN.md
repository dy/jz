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
JZ retains lowering-specific optimization and representation proofs.

## Release gates

- Run the core, matrix, conformance and self-hosting gates on the packaged
  revision. Record baseline failures separately from regressions.
- String construction and byte-string builders need one consistent contract;
  changing fromCharCode alone previously broke compiler builders.
- The warm Map/property failure came from counting duplicate and cancelled
  durable-slot log entries toward a fixed limit. The log now reuses them;
  retain the repeated-compile and reset tests as lifecycle gates.
- Speed and size promises require measured evidence, including the DSP fixture.
  Architecture changes alone do not establish real-time suitability.
- Replace the pinned watr source archive with an npm release when it contains
  the required fixes.

Semantic IR, more generic-pass migration, JS runtime replacements and removing
ambient ctx are optional follow-ups. Take one only for a reproduced defect,
a measured DSP bottleneck, or a deletion that preserves behavior. Historical
plans remain recoverable through [.work/README.md](.work/README.md).
