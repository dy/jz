# JZ plan

## Purpose

Compile JavaScript audio DSP efficiently for audiojs.dev: JS → Wasm → VST.
JZ is a compiler option; Porffor may replace it. The plugin host must depend on
an explicit DSP interface, not JZ's internal object layout or compiler IR.

The useful result is a plugin that sounds correct, meets its audio deadline,
and installs reliably. Compiler architecture serves that result.

## Next work

1. **Correct static-object returns.** Preserve schema-bearing constant
   initializers when moving them from startup code into globals. Test ordinary
   objects, nested objects, and arrays of objects across optimization levels.
2. **Establish one end-to-end plugin fixture.** Select a real audiojs processor
   and pin its sample buffers, parameters, persistent state, channel layout,
   and supported block sizes. Exercise JS → Wasm → VST, including parameter
   changes, reset, silence, and repeated processing. This fixture should define
   the compiler-independent DSP interface; do not invent another general ABI.
3. **Bound processing cost.** Measure worst observed block time and memory
   growth over a sustained run. Keep allocation and compilation outside the
   audio callback. Compare output against the JS processor with an explicit
   numeric tolerance. An average benchmark win alone does not establish this.
4. **Make distribution reproducible.** Replace the sibling `file:../watr`
   dependency with a published version. Verify a clean package installation,
   CLI, declarations, and the plugin fixture. Porffor support requires passing
   the same fixture, not merely providing a compiler-selection flag.

The plugin fixture and host contract are not implemented by this plan. Choose
an existing processor and inspect its host before changing compiler interfaces.

## Known compiler gates

- The last core run had four static-object-return failures (one defect family)
  and the existing string code-unit failure. The initializer repair above
  targets the object family; its verification is recorded with the fix.
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
