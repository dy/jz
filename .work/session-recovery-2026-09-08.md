# Interrupted Claude work, recovered 2026-09-08

Integration base: `e3deee60`. Worktrees were subsequently retired after their
histories were reconciled into main (see the branch-resolution section). Recovery
patches are in `/private/tmp/jz-session-recovery-20260908/`.

| Owner | Recovered work | Original location |
| --- | --- | --- |
| `2bbff4f8` | Main integration and compiler migration | Claude project transcript, `PLAN.md` |
| `a467eba815ecdcd05` | Result contract slice 2, including self-graph WAT attribution | `.claude/worktrees/agent-a467eba815ecdcd05` |
| `ac3edc1367d6d2335` | Array element facts from summary cells | `.claude/worktrees/agent-ac3edc1367d6d2335`, head `3f036c18` |
| `a2a88096a3334b732` | Remove schema-field sidecar mirrors | `.claude/worktrees/agent-a2a88096a3334b732`, head `96f2495e` |
| `78adaaf2` | In-place object-field update performance and entity benchmark | Untracked `bench/entity/` sources in the main checkout |

The task titled “Rebuilding self-graph WATs for attribution” belongs to the
result-contract agent. Its `base-by-head.wat` and `head-self.wat` both exist;
their logs confirm the rebuilds completed. The explanation of their differences
was unfinished. These files and the other saved measurements live under
`/private/tmp/claude-501/-Users-div-projects-jz/2bbff4f8-396e-4f40-a7a0-00248ca1826a/scratchpad/`,
in `rc2/`, `elem/`, and `dyn/`.

## Prior evidence, not certification of the combined changes

- Main's recorded native suite: 4,372 pass, 2 fail, 1 skip. The failures
  are a complex plain-array BigInt update and the string code-unit contract.
- Result contract: saved functional, sequence, and recursive gates green;
  recursive output 13,898,897 bytes. Native recording was still running
  when recovery began.
- Element facts: saved native suite 4,372 pass, 6 fail, 1 skip. Additional
  failures involve BigInt updates and a reduction callback.
- Sidecar removal: saved functional, sequence, and recursive gates green;
  recursive output 13,703,345 bytes. Its draft report flags static writes of
  undefined after deletion, static enumeration after computed deletion,
  and reinserted-key ordering as unresolved.

## Recovery work

The return-contract and array-element slices are integrated into main in
`462ee182`. Their
interaction exposed mixed Number/BigInt update and reduction-accumulator bugs;
the emitters now preserve the runtime kind through both operations. Existing
postfix and reduction regressions exercise these paths.

The dynamic-property slice was evaluated and removed from the integration
because its saved deletion/presence defects remain unresolved. Its original
worktree and recovery patch are intact.

The entity benchmark's six source ports are retained and registered in
`50dfa4ee`. The
compiler recovers the original offset when a proven fixed-layout pointer was
just boxed, avoiding redundant pointer decoding on field updates. A regression
pin checks JavaScript parity and emitted code at optimization levels 0, 2, 3.

Saved WAT comparisons were completed with the original attribution scripts.
For identical source, the return-contract compiler adds 472,325 WAT characters;
the source migration under that compiler removes 302,026. These are textual
counts, not wasm-byte changes. Reports are saved with the recovery patches as
`return-codegen-attribution.txt` and `return-attribution.txt`.

## Recovery verification

- Full `npm test`: 4,381 pass, 2 fail, 1 skip (61,111 assertions).
  One failure is the already documented `fromCharCode` code-unit defect. The
  other was the new pointer assertion expecting a separate function after
  inlining; the assertion now accepts the inlined driver. Its complete
  `inplace-store` suite then passed (6 tests, 22 assertions). The full core
  suite was not repeated after this test-only correction.
- Postfix/statement suite after the final BigInt fix: 202 tests pass, 470 assertions.
- `npm run test:self`: 25 pass, 1 fail. Repeated Map/property compilation traps
  on round 13; the saved baseline kernel reproduces the same round-13 trap.
  The command stops before its performance stage.
- A fresh combined candidate passed functional, sequence, and recursive kernel
  gates (13,882,284 bytes). This preceded the final deferred-BigInt marker fix;
  the self suite above includes that fix.
- Entity benchmark: JZ 13,882 µs, Node 48,301 µs, AssemblyScript 40,366 µs.
  All three return checksum 1,275,530,752. JZ is 1.8 kB; AssemblyScript 2.3 kB.
  These are this run's measurements; the new case has no stored parity oracle yet.
- Full optimization/WASI matrix and conformance suites were not rerun: the user
  requested prompt integration of useful work without expanding verification.

The independent shared-local optimizer work under
`/private/tmp/jz-local-unification-Xj2Y33/` has active test processes and
is not being edited by this recovery.

## Branch resolution

At the user's follow-up request, `f95b964b` merged the property-storage branch
and integrated the newer shared-local migration. `e1018c6e` recorded the
already integrated result/element slices and the superseded optimizer campaign
as merge parents, keeping the corrected main implementation. Result-contract
work that had never been committed is preserved as `44a6cab4`.

Only `main` and its worktree remain. Retired tips `96f2495e`, `44a6cab4`,
`3f036c18`, and `45314c68` are all ancestors of main. No push was performed.

The property integration retains one value slot per schema field. Deletion
invalidates static presence/enumeration and shared-literal assumptions, and
subsequent static writes update presence even when the value is undefined.
The complete dynamic-key suite passed: 76 tests, 600 assertions. The existing
schema-key reinsert ordering and wide-schema sticky-mask limitations are not
resolved by this slice.

The shared module optimizer needs sibling watr `25d828b`: clones and in-place
substitution retain client annotations, including error-schema metadata.
Watr verification: 352 unit tests pass, 25 propagation tests pass, and 268
spec tests pass (20 skipped). No generated dependency artifact is committed.

The proposed replacement of JZ's early local passes is rejected. Its saved
implementation skips early normalization when the module fixpoint is enabled;
both that form and an always-enabled shared pass fail the self-hosted
closure/class oracle. An isolated control with the original local passes
passes the complete functional gate. Main retains those proven implementations
behind the unified `propagateLocals` option; the rejected implementation is
preserved in the merge history rather than on another branch.

The condref instruction-count baseline was regenerated from 87,020 to 87,060.
This is the already isolated watr trap-preservation correction: the old
optimizer discarded a potentially trapping load in runtime cleanup. Every
other ratchet case is unchanged; no source benchmark was altered.

The combined core run completed: 4,382 pass, 6 fail, 1 skip (61,291 assertions).
It loaded the emitter before the last deletion guard correction. Its failures
were that deletion test, the existing fromCharCode defect, the corrected-load
ratchet, and three kernel-oracle failures from the rejected local-pass
replacement. After retaining the early local passes, the functional,
sequence, and recursive gates passed; the broader O3 captured-closure oracle
still exposed a problem in the new instruction-array replacement. Watr
`25d828b` retains the original map/push mechanics and copies only annotations
separately. Its full suite passes, its freshly built functional gate passes,
and the O3 closure returns exactly `false` and `1` against the JS oracle.
Final verification with the corrected dependency:

- `JZ_KERNEL=…/metadata-kernel.wasm node test/index.js dyn-keys kernel-oracle perf-ratchet`:
  101 tests pass, 1,348 assertions. Every integration failure from the earlier
  full run is covered; the existing fromCharCode defect remains outside this slice.
- Fresh functional gate: green. Sequence and recursive gates on those exact
  attested bytes: green; recursive output 13,685,741 bytes, instantiated and probed.
- Watr's full suite: 352 unit, 25 propagation and 268 spec tests pass.
- The full core suite was not repeated after the final corrections; the earlier
  full-run counts above are retained rather than presented as an all-green run.

Main's final local-pass decision is in `00773687`. Separate ongoing edits in
`test/closures.js` and `test/optimizer.js` were left untouched at closeout.
