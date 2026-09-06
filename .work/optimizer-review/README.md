# Optimizer handoff review — 2026-09-05

## Receipt and integration

Reviewed the frozen `handoff-03cf346d` worktree at **44309407**, based on
`03cf346d`, clean. Its implementation ends at `79a0b897`; the last commit adds
its handoff. The complete range is **nine commits, 27 files, +1877/-343**, not
the implementation-only 26-file diffstat quoted in the handoff.

Integrated only these compiler changes:

- **c8f3589f**: exact cherry-pick of `79a0b897`, B-only key construction caches.
- **5c4b6292**: transport/cleanup code from `0a075eaf`, with reserve-boundary and
  append-after-slack tests. No second optimizer: cleanup calls watr.
- **01cb3e5c**: the final diagnostics from `55d774ab` + `aedb3531`, with review
  repairs and test registration described below.
- This review's additional summary-retention tests and portable fact-graph
  evidence are separate from those implementation commits.

**Excluded** `3d65764f`, `cd66af98`, and `ecfae2d5`: Porffor alpha 4, the Web
Audio case, dependency/CI changes, and the noisy benchmark refresh. The old
allocation notes and handoff remain on the frozen branch, not transplanted as
combined-main certification. No dependency install, publication, push, or
change to generated output was made. Candidate, installed, and sibling watr
matched **all 34 installed files**, with the sibling clean at `5ff0037`.

Main's prior eight modified files remain uncommitted. The tests below ran on
that combined working tree, **not merely the clean integration HEAD**. A new
agent worktree from HEAD must state that it excludes those pending changes.

## Findings and repairs

1. **Tests were absent from the runner.** `node test/index.js kernel-marks
   summary-keys` rejected both names. Both are now registered in `test/index.js`.
2. **The claimed full fact dump was incomplete.** It skipped `closures`,
   `scopeOfSig`, `scopeOfParams`, and `methods`, substituted counts for some,
   and stringified Map keys. The independent hook here snapshots at publication
   and preserves key types, object identities, array holes, metadata, and every
   fact root. All **27 publications over ten programs**, plus output SHA-256s
   and exact errors, match before/B. This holds both on the frozen candidate and
   combined main. Closure/signature/parameter and method maps are nonempty in
   the corpus; this is not equality of empty placeholders.
3. **Capacity bounds were not integer bounds.** `setPhaseCapacity(1.5)` followed
   by three records reported two records and 1.5 dropped; NaN produced a NaN
   dropped count. A fractional read index returned a real phase. Capacities now
   clamp to integers; invalid read indices return the empty/zero sentinel.
4. **Changing capacity could expose stale slots.** Raising a limit after overflow
   made unwritten slots appear recorded. Setting capacity now starts a new
   recording, including stage reset; configured capacity still survives entry
   resets. Tests cover lowering, raising, zero, fractions, NaN, infinities, and
   overflow through the real compiled recorder.
5. **An old disk kernel could mask the original failure while reading marks.**
   The host reader rejects missing/outdated APIs and malformed counts explicitly;
   the intentional disk-artifact recursive script checks this before compiling.
6. Allocation checks now cover **O0–O3**, with external heap observations as well
   as in-kernel deltas. Ordinary mutable-global reset is independently observed.
   Fresh hosted tests cover `compileDiag` as well as binary/WAT/warnings entries,
   and copy, validate, execute, retain, and reinstantiate successful output.
   No change was made to general `_clear()`.

**Still missing:** forced internal **park → rewind → unpark → encode** in the
compiler pipeline. `_clear()` plus subsequent allocation proves the tested
reset mechanism, not that whole checkpoint. Do not describe it as completed
checkpoint or recursive-memory certification.

## Verification

Independent frozen-candidate checks: recorder **4/4, 43 assertions**, key tests
**4/4, 31**, and summary/query/tape/determinism/minimal selection **147/147,
9966**. These precede the review's test additions.

Final combined-working-tree results:

| command/selection | result |
|---|---|
| `node test/index.js kernel-marks summary-keys summary summary-queries tape optimizer wat-invariants perf-ratchet determinism minimal-output` | **421/421**, 14560 assertions |
| broad selection below, opt0 | **672/672**, 6006 |
| broad selection, opt3 | **672/672**, 6025 |
| broad selection, WASI runner | **671/671**, 5550 |
| private fresh `npm run test:self` | **20/26**, 98; same six failures; performance leg skipped by `&&` |
| `npm run test:matrix` | native leg completes: **4104 pass / 52 fail / 1 skip**, 4157 tests, 44698 assertions; remaining full legs skipped by `&&` |
| `npm run test:262` | 2996 pass, 4024 negative rejects, **9 failures / 21 negative accepts**, 20 expected failures; one unexpected pass |
| `npm run test:262:builtins` | 864 pass, **4 failures**, 50 expected failures; one unexpected pass |

Broad selection:

```sh
node test/index.js kernel-marks summary-keys summary-queries tape optimizer \
  wat-invariants perf-ratchet determinism minimal-output classes iteration objects dyn-keys
```

An earlier opt0 retry timed out at 240 seconds during typed-int sweeps while
other validation ran. The later, completed run above used a 360-second deadline.
An earlier direct `npm test` also completed (4103/4156, 52 failures, one skip),
before the last host-reader test was added. Neither full native run is green.
Fixture/internal-compiler tests are not transformed into hosted bootstrap proof
by running the WASI selector.

The full native failures are exactly the 48 failures in the pre-integration
`unsigned data watr` selection, plus the established homogeneous BigInt update,
receiver-HASH expectation, and two **stale disk-kernel** dict parity failures.
No additional failing test name appeared in that comparison. Conformance expectations
were not changed to make the gates pass.

## Cost and attribution

The agent's allocation script divides by **1048576**: its reported “MB” values
are **MiB**. The native sampled summary volumes are approximately
3545/3661/3669 → 2858/2951/2956 MiB (about 19% less), not exact malloc totals.
The cache's 1.11–1.18 million key characters are **not measured cache heap bytes**;
Maps, entries, string headers and encoding overhead also exist.

Read directly from the retained recursive JSON:

| frozen-lineage B comparison | baseline | B |
|---|---:|---:|
| front completion, bytes | 649166256 | 649166256 |
| first summary delta, bytes | 788194136 | 564257944 |
| plan summary delta, bytes | 810023088 | 576067536 |
| third summary delta, bytes | 810126904 | 576120512 |
| heap at failure, bytes | 3974317824 | 3282419688 |
| heap at failure, MiB | 3790.205 | 3130.359 |

Saving at that failure: **691898136 bytes (659.845 MiB)**. Both runs stop on
`Cannot mix BigInt and other types` in `emitFuncs`; `publishParameterAbi` is
only the last completed phase. This is not successful emission, nor proof that
later stages fit in memory. Completion deltas are not inclusive parent costs.
Elapsed times from these loaded-machine runs are not speed evidence. Old A+B
branch numbers are not B-only or combined-main evidence.

Reviewer transport/cleanup comparison held B and all other working source fixed,
substituting only pre-change `tape.js` and `watr-tail.js`: ten perf-corpus
categories × seeds 1/2 × O0/O1/O2/O3/fast = **100 valid binaries per side**.
**80 are byte-identical**; the other 20 shrink by 3–9 bytes, **90 bytes net**
(36 at O1, 54 at fast). O0/O2/O3 are entirely byte-identical. **160 scalar
executions per side** match the JS oracle. This is output/correctness evidence,
not a speed or heap claim, and is not the B-only experiment.

## Reproduce the full fact comparison

From this repo, using Node's loader support:

```sh
R=$(mktemp -d)
JZ_FACT_REV=03cf346d node --no-warnings \
  --loader ./.work/optimizer-review/fact-hook.mjs \
  .work/optimizer-review/full-facts.mjs "$R/before.json"
JZ_FACT_REV=79a0b897 node --no-warnings \
  --loader ./.work/optimizer-review/fact-hook.mjs \
  .work/optimizer-review/full-facts.mjs "$R/B.json"
cmp "$R/before.json" "$R/B.json"
```

Set `JZ_FACT_ROOT` to the frozen candidate worktree to repeat that lineage. The
hook reads the chosen committed summary, retains the rest of the selected tree,
and changes only its publication site for observation; no source is overwritten,
no facts are added to production readers or `ctx`. These intercepted native runs
are not allocation measurements or bootstrap tests.

All four dumps in this review were 142534 bytes, SHA-256:
`ee3cc1c78e45d2dfdff70eb7faeab8e8b37908839279a04cecbcdc7f582b9336`.

## Separate reference experiment — reverted

The concurrent bounded review found that possibly-throwing receiver/key helpers
in `get()[key()] += rhs()` produce trace **12123**, not JS's **123**. An early
staging candidate corrected reference evaluation, including a key reassigning
its receiver. It also required declaration ownership for expression-bodied
closures and parameter defaults. But the existing `.subarray()` sibling test
then returned **7 instead of 8 at O2**. All new production staging/scope changes
were reverted; no readiness widening or arithmetic migration was retained.

The main working-tree tests retain **23 newly exposed member-reference failures**
and four independent pre-existing failures: BigInt member expression results,
BigInt member postfix TypeError, normal-path catch initializer corruption (5
instead of 0), and an absent array slot in a returned closure (0 instead of 7).
Together with the earlier 23 source failures, that is 50 source pins, plus the
two stale-artifact parity failures in the full run. These are not failures
introduced by B. The failed staging patch is not part of the integration.
