# Phase 4: compile time: what was optimized once is not optimized again

Part of `.work/architecture.md` (phase 4; "What is wrong", item 6). Read that first.

## The state (measured at the start of this work, on 508428d82; measure again)

A program that allocates links 30 to 110 helper functions (the stdlib a string, an
array or an object pulls in) and optimizes them again on every compile: 420 ms warm for
a string/array one-liner, of which 263 ms is in watr's fixpoint and 76 ms in jz's own
per-function passes (`src/optimize/driver.js` `optimizeFunc`, called from
`src/wat/assemble/optimize-module.js`); a scalar loop compiles in 7 ms. The same
program compiled 160 ms on the first compile of a process and 29 ms warm in another
measurement. The suite is about 7,300 tests, most of them a compile, so this is also
what every verification of every later phase costs.

## The outcome

1. A helper's optimized form is computed once per process for what it depends on, and
   reused: jz's per-function passes first (they are jz's own), then whatever of watr's
   work on an already-settled function can be skipped.
2. An allocating one-liner compiles at least 3× faster warm than it does today, and
   `npm test` takes measurably less wall time. Report both against your own baseline,
   alternating base and new on the same machine (it is shared and loaded: a single run
   proves nothing).

What a helper's optimized form depends on (its IR, the config, module flags, the
callees it may inline or that may be inlined into it) is yours to establish from the
code; the plan's guess was "IR, config, four module flags, callee closure". Verify it.

## The rule that must keep holding

With the memo on, every compile emits byte-for-byte the module it emits with the memo
off: at every level, on either host, whatever was compiled before it in the process
and in whatever order. Nothing else is acceptable: a stale entry is a miscompile no
test of one program can see.

- Write the differential first: a corpus (the suite's programs, `bench/`, `examples/`,
  the self-compile's inputs) compiled memo-off, memo-on cold, memo-on warm, and
  memo-on after a shuffled order of other programs at other levels and hosts; bytes
  compared. Keep it as a test the suite runs.
- A switch that makes every memo hit recompute fresh and compare (a debug mode, off by
  default), run once over the whole suite before you report.
- `AGENTS.md`: "a test that passes standalone but fails in the full suite is almost
  always a compile-state leak". The memo is state across compiles by design; say in the
  report what bounds its size and what clears it.
- A helper a program's own code can change the meaning of (a feature flag, a host, a
  layout choice, an import the program supplies) is keyed on that or not memoized.

## watr

watr is the owner's separate package (`/Users/div/projects/watr`, npm `watr`), and all
agents share one `node_modules` through a symlink. Never edit, reinstall or relink
anything under the shared `node_modules`. If part of the gain needs a change in watr
(a way to tell its optimizer which functions are already at their fixpoint, while they
stay available to its inliner), deliver it as a patch file with its own tests against
a private copy of watr loaded by path, and say what it gains; the integrator applies
and releases it with the owner. jz's side must be correct with the released watr.

## Done when

- The byte-identity test is in the suite and green; the debug mode has run over the
  whole suite once.
- The two figures of the outcome, with how they were measured.
- `node test/index.js spellings perf-ratchet` unchanged (this phase changes no emitted
  byte, so every gate and every bench size is identical: say that you checked).

## Rules of work

- Work only on your worktree branch; first `git rebase main`, and link the shared
  modules with `ln -s /Users/div/projects/jz/node_modules node_modules` (never
  `npm install` there). Never push. Never run repo-wide `checkout`, `reset`, `stash`,
  `clean`, `restore`. Stage files by name. No attribution lines in commits. No em-dash.
- Two other agents are at work: one in `src/type/`, `src/compile/analyze/`,
  `src/compile/analyze-scans.js`, `src/compile/plan/scope.js`, `src/summary/`; one in
  `src/normalize.js`, `src/prepare/`, `src/compile/loop-model.js`,
  `src/compile/emit/control-flow.js` and the loop plans. Your ground is
  `src/optimize/driver.js`, `src/wat/assemble/`, the link stage and a new file of your
  own. Stay out of theirs.

## Verify, in this order

1. Your byte-identity differential after each change.
2. `npm test` before every commit that claims a fix, then `npm run test:matrix`,
   `npm run test:generated`, `npm run test:self`, one at a time
   (`JZ_TEST_TIMEOUT=10800000` if a leg hits the hour on the loaded machine).
3. Bytes of every bench case before and after
   (`/private/tmp/claude-501/-Users-div-projects-jz/36e8fd26-a3d4-48ec-97bb-7106b08fda8d/scratchpad/sizes.mjs`,
   `cmp-sizes.mjs`): identical, or the phase is wrong.

## Report

First line: the model you are. Then: what is memoized and its key (file:line), what is
not and why; the two figures with their method; the memo's bound and what clears it;
what watr would need, with the patch if you made one; lines added and removed. Every
defect found, with its smallest source and whether it was on `main`. What in this
brief was wrong. What you ran and what you inferred.
