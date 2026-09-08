# JZ plan

## Purpose

Compile JavaScript audio DSP efficiently for audiojs.dev: JS → Wasm → VST.
JZ is a compiler option; Porffor may replace it. The plugin host must depend on
an explicit DSP interface, not JZ's internal object layout or compiler IR.

The useful result is a plugin that sounds correct, meets its audio deadline,
and installs reliably. Compiler architecture serves that result.

## Next work

1. **Establish one end-to-end plugin fixture.** Select a real audiojs processor
   and pin its sample buffers, parameters, persistent state, channel layout,
   and supported block sizes. Exercise JS → Wasm → VST, including parameter
   changes, reset, silence, and repeated processing. This fixture should define
   the compiler-independent DSP interface; do not invent another general ABI.
2. **Bound processing cost.** Measure worst observed block time and memory
   growth over a sustained run. Keep allocation and compilation outside the
   audio callback. Compare output against the JS processor with an explicit
   numeric tolerance. An average benchmark win alone does not establish this.
3. **Make distribution reproducible.** Replace the sibling `file:../watr`
   dependency with a published version. Verify a clean package installation,
   CLI, declarations, and the plugin fixture. Porffor support requires passing
   the same fixture, not merely providing a compiler-selection flag.

The plugin fixture and host contract are not implemented by this plan. Choose
an existing processor and inspect its host before changing compiler interfaces.

## Compiler pipeline

Normalize and expand → settle program facts → lower → link → optimize and
encode in watr. Recompute the summary after program rewrites; emission reads
its settled binding, slot, parameter, result, container and presence facts.
Range proofs and physical storage choices remain separate responsibilities.

The slot-kind census, local value trackers, Map/dictionary alias traces and
repeated parameter-kind joins are removed. Literal tuple positions and
container constructor contents live in summary cells, with mutation and
escape invalidation. Generic local propagation and merging now run in watr
after linking; the duplicate JZ local passes and cleanup sweep are removed.
JZ retains lowering-specific optimization and representation proofs.

## Release gates

- Run the core, matrix, conformance and self-hosting gates on the packaged
  revision. Record baseline failures separately from regressions.
- String construction and byte-string builders need one consistent contract;
  changing fromCharCode alone previously broke compiler builders.
- The dedicated self suite previously trapped during repeated Map/property
  compiles without reset. Bound that lifecycle before promising reusable
  compiler instances.
- Speed and size promises require measured evidence, including the DSP fixture.
  Architecture changes alone do not establish real-time suitability.
- Replace the local watr dependency with a published version before distribution.

Semantic IR, more generic-pass migration, JS runtime replacements and removing
ambient ctx are optional follow-ups. Take one only for a reproduced defect,
a measured DSP bottleneck, or a deletion that preserves behavior. Historical
plans remain recoverable through [.work/README.md](.work/README.md).
