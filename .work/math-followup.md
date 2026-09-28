# Math follow-up

## Main landing, 2026-09-28

The full math-target lineage (through `7104c8c4`) and this follow-up landed on
main at `7d99a984`, after merge `97a4a68b`. The landing retained concurrent
uncommitted edits in eleven overlapping files; unrelated work was not staged.
The object-field CSE work and plain-array CSE share the resolved working tree.

`7d99a984` adds `npm run test:math` (`test/pmath.js`) to the default core suite:
all four fixed library workloads must match their first-call checksum and Node
across three successive calls, including FABRIK's evolving state. The command
prints diagnostic timing ratios; `JZ_MATH_PIN=1` requires every case to beat V8.
The claims gate still lists all four as pending. No speed win is inferred from
the overloaded shared machine.

The minimal plain-array kernels now have six-load ceilings, alongside their
pass-on/pass-off comparisons (uncached counts nine and ten). Existing numeric
conversion, parameter hull, forwarding and SLP pins remain enabled. The unused
SLP import was removed; full compiler import lint passes.

The new math gate passes on main: 4 tests / 44 assertions. Focused kernel
sweep: 14 tests / 221 assertions pass. The resolved working-tree
snapshot passes 74/75 tests / 854 assertions, including array CSE, field CSE,
SLP and scalar records. Its sole failure is the pre-existing BigInt shape-join
result: at O2, a selected `{value: 1n}` can return the number `5e-324`. The same
minimal source fails on frozen `6f37e16f`, the committed integration and the
pre-landing main workspace. The object-field patch's updated assertion exposes
the value failure previously hidden by its earlier summary-kind assertion.

The earlier self gate below passed before the merge from newer main. Its
remaining serial checks were superseded by the landing validation runner:
`/private/tmp/jz-math-verify-landed.mjs`. It runs core, opt0, opt3, WASI, self,
language/builtins conformance and three.js, retaining every leg's exit status
even after a failure. Logs: `/private/tmp/jz-math-landed-*.log`; completed-leg
results: `/private/tmp/jz-math-landed-verification.json`. The core rerun has
already reproduced the baseline strict-mode failure. Full matrix results are
still pending; this is not a v1 release certification.

Worktree: `/private/tmp/jz-math-followup`, branch `math-followup`.
Base: `6f37e16f` (the reported math-target head).
Frozen comparison checkout: `/private/tmp/jz-math-base`.
The original math-target worktree is being modified by another agent; it must
not be used as a reference for later measurements.

## Changes

- Reuse plain-array reads using the existing load cache. The settled summary's
  array cells distinguish storage; aliases joined into one cell stay conservative.
  A missing receiver retains its first throwing access. Named stores and deletion
  invalidate the cache, and writes through typed views retain the existing rules.
  Eligible values are Numbers and nested array pointers; missing BigInt and
  boolean elements cannot be reused through a scalar carrier that erases absence.
- Bound-once receivers loaded from the same available array element share its
  pointer identity. Reassignment and changes to the containing slot invalidate
  the relevant proof. Scalar conditional arms preserve only prior reads that
  both arms leave intact. Numeric Math calls preserve reads.
- Preserve a const initializer's finite interval when forming a callee's argument
  hull. These facts belong to the current summary frame. A parameter assigned
  anywhere, including by a closure, does not supply a stable incoming interval.
  Exported, escaped and dispatcher entries have no closed argument hull, even
  when an internal call happens to pass a constant.
- Use the settled Number|undefined kind at numeric conversion sites. This removes
  a null-to-zero branch while retaining undefined-to-NaN conversion. A caller or
  captured writer that can introduce null retains its conversion.

The benchmark and vendored library sources are unchanged. These changes do not
add public options or dependencies.

## Structural evidence

- Quaternion workload's `run`: 28 → 18 scalar loads, 22 stores unchanged.
- Worley module: 36 → 16 selects after retaining the bounded x/y coordinate
  initializers and removing impossible null conversions.
- Polygon's `between` and `intersectProp`: 24 → 2 null-sentinel comparisons.
  A named binary of the polygon workload shrank 27,620 → 26,992 bytes between
  the array-cache/range change and the conversion change.
- Final structural comparison: `/private/tmp/jz-math-structure.json`, generated
  by `/private/tmp/jz-math-structure.mjs` against frozen `6f37e16f`.
- Minimal regression kernels live in `test/array-load-cse.js` and
  `test/param-range.js`.

## Validation

- Array regressions: 4 tests / 62 assertions pass with `JZ_TEST_SWEEP=1`
  (levels 0, 2, 3).
- Parameter-range regressions: 4 tests / 30 assertions pass with
  `JZ_TEST_SWEEP=1`, including captured writers and open host callers.
- Presence/conversion regressions: 6 tests / 127 assertions pass across
  levels 0, 2, 3 and size.
- Codegen ratchet: 10/10 pass, no baseline edits.
- three.js: final rerun passes 3 tests / 90 assertions, including repeated
  calls after `memory.reset()`: `/private/tmp/jz-math-three-final.log`.
- `git diff --check` passes. Import lint reports the baseline's unused
  `resolveAddr` import in `src/optimize/vectorize/dot-slp.js`; no changed file
  has a lint error.
- The first full suite stopped at the sandbox's local-server restriction in
  `test/async.js`. Intermediate runs were replaced as correctness guards were
  added. The final runner has local-server access and runs self-compile, default,
  opt0, opt3, WASI, language conformance and builtins conformance serially, even
  when a preceding leg fails. It limits conformance to two workers and permits
  a one-hour self build under machine load. Runner: `/private/tmp/jz-math-verify.mjs`;
  results: `/private/tmp/jz-math-verification.json`; logs:
  `/private/tmp/jz-math-final-*.log`. Source hashes:
  `/private/tmp/jz-math-verification-source.json`.
- Final self-compile passes 79 tests / 2,790 assertions (750 seconds under
  shared load): `/private/tmp/jz-math-final-test-self.log`. The runner has
  advanced to `npm test`; the remaining matrix/conformance results are pending.
- Pristine-base checks for the reported existing failures:
  `/private/tmp/jz-math-baseline-tests.log`: 172/175 tests pass. The three
  failures are strict-mode parameter rejection, bounded shape joins, and the
  field-CSE structural pin. All reproduce on frozen `6f37e16f`.
- Lint on all five changed compiler files passes.

All four math checksums match Node, including repeated stateful FABRIK runs.
The final committed compiler was checked again against Node for all four:
`/private/tmp/jz-math-final-checksums.json`, produced by
`/private/tmp/jz-math-verify-kernels.mjs`.
Timing is not release evidence: the shared machine's load ranged from 60 to
over 200, and even same-process ABBA rounds varied several-fold. The diagnostic run
against the frozen base is `/private/tmp/jz-math-paired.json`; the earlier
`jz-math-current.json` used a reference worktree being edited concurrently and
must not be used for a speed claim. No PENDING claim has been promoted.
The final conversion's polygon checksums also match Node in every round of
`/private/tmp/jz-math-poly-paired.json`; its timings have the same limitation.

## Remaining work before an upstream PR

1. Prove separate calls to fresh-array factories produce distinct module scratch
   arrays. Summary cells currently merge factory results (for example `out` and
   `inv`), which limits store elimination and load reuse.
2. Forward stores across conditional joins without moving effects or removing
   stores observable through an alias or exceptional exit. The inverse kernel's
   early return is still a barrier.
3. Reduce the remaining numeric conversion and bounds work in polygon and IK
   kernels, using general proofs and minimal kernels, not benchmark edits.
   The named polygon profile puts most samples in `between`, `intersectProp`
   and `diagonalie`; allocation helpers are a small share. Profile artifacts:
   `/private/tmp/jz-math-profile-named.log` and `jz-math-*-named.cpuprofile`.
4. Rerun all four against V8-family engines on stable hardware; promote claims
   only with reproducible wins. Finish v1's release gates before proposing the
   library integration upstream. No upstream PR has been opened.

## Existing semantics defects discovered during regression design

Both reproduce on the unchanged base with load CSE disabled:

```js
export const f = () => {
  const a = [2, 3], b = a, x = a[0]
  b['length'] = 0
  return x + a[0] // Node: NaN; base jz: 4
}
```

```js
export const f = n => {
  const a = [2, 3], b = a, x = a[0]
  delete b[n - 1]
  return x + a[0] // f(1): Node: NaN; base jz: undefined
}
```

The deletion regression in this change observes `=== undefined` directly so it
tests cache invalidation independently of the existing missing-value arithmetic.

An unrelated wide ToInt32 boundary also reproduces at levels 0/2/3 on both
base and current: `1e30 | 0` gives -1 instead of Node's 0. Reproducer:
`/private/tmp/jz-math-range-repro.mjs`; results:
`/private/tmp/jz-math-range-repro.log`. The exported-parameter regression uses
±Infinity to test the argument-hull boundary independently of this defect.
