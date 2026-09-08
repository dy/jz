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

## Known compiler gates

- Static-object returns are repaired: hoisting preserves the constant IR and
  its schema. The 2026-09-08 core run finished with 4,413 pass, one existing
  character-code failure, and one skip (61,515 assertions). Fresh functional
  bootstrap and 15 hosted object-return cases also pass.
- String construction and the compiler's byte-string builders need one
  consistent contract. The saved fromCharCode patch alone breaks those builders.
- The last dedicated self suite trapped during repeated Map/property compiles
  without reset. Resolve or precisely bound that lifecycle before claiming
  reusable compiler instances are reliable.
- Recursive self-compilation already produced and probed a working compiler;
  the pinned accepted-invalid parser ledger is empty. Neither is an unstarted
  architecture task. Keep their regression gates.
- After correctness fixes, run the full matrix, conformance and self gates on
  the packaged revision. Existing speed/size promises still require measured
  evidence; this plan does not weaken their tests or claim they are satisfied.

## Compiler simplification

The target is normalize and expand → settle program facts → lower → optimize
and encode in watr. Analysis consolidation has priority: migrate a consumer to
the settled summary and delete its old inference in the same change. Necessary
fixpoint iterations and refreshes after program rewrites remain explicit.

The typed-parameter specialization pass now reads named-call result payloads
from the summary. Its separate recursive return census and memo table are gone,
as is a duplicate summary lookup at each call site. Twelve sampled O2/O3 builds
(including FFT and resampling) remain byte-identical; specialization and fresh
functional bootstrap checks pass.

Result boundaries now read the summary contract, including whether a body has
any explicit result. Map and dictionary contents use its alias-aware cells;
their local/global scans and duplicate state are removed. Short-circuit value
selection is shared by the solver and its queries. Focused inference checks
and fresh functional bootstrap pass; the full core run is still pending.

Remaining analysis consolidation: schema-slot values and representation hints,
then local value/presence inference. Finish this before the shared optimizer.

## Deferred architecture

These are unfinished directions, not prerequisites merely because they were
once planned. Take a slice only for a reproduced correctness defect, measured
DSP bottleneck, or a deletion that preserves behavior:

- Consolidate remaining kind, result, representation and range analyses onto
  settled summaries; finish the consumers, rather than adding another record.
- Add semantic FunctionIR with explicit value definitions and effects, then
  replace the covered WAT-array builders. The current tape is transport IR.
- Move remaining generic JZ optimizations into watr when the replacement passes
  JZ's gates. Retain the proven early local passes until that is demonstrated.
- Replace selected WAT-template runtime families with JS where it simplifies
  maintenance without worsening emitted code.
- Replace ambient `ctx` ownership with program facts and disposable function
  state where reentrancy or memory measurements justify it.

No arbitrary line-count target, compiler-binary size target, complete runtime
rewrite, or self-hosting speed race is a substitute for the plugin fixture.

## Working rule

One defect or measured bottleneck per compiler change. Keep complete test logs
outside the conversation; report counts and failures. Do not open another
architecture campaign while the useful next step is a small correctness fix.
Historical plans and measurements are recoverable through [.work/README.md](.work/README.md).
