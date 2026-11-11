# Phase 2b: the interval proof as the one engine of a local's numbers

> Landed (see `.work/architecture.md`, phase 2 and "Found on the way (2026-11-10)" for what
> moved, what stays a scan and what this brief got wrong). 2c and 2d are not briefed yet.

Part of `.work/architecture.md` (phase 2). Read that first (the phase table and both
"Found on the way" sections), then `.work/maps/ranges.md` and `.work/phase-2a-domain.md`
(landed: the transfer table is `src/summary/num-range.js`). The map is a scout's: leads
with file:line, each claim marked verified or inferred; its lines predate phases 1 to 3.

## Why

What a local's value can be is derived in six places, each with rules of its own:

1. `src/type/interval-proof.js` `scanIntervalIdx`: flow-sensitive, with widening; its
   environment holds integer pairs; it runs for index proofs and publishes whole-binding
   hulls (`publishBindingHulls`, compile/analyze/body-facts.js).
2. `src/compile/analyze-scans.js` `stampBodyRanges`: a hull of every write, a countdown
   only where the test is the decrement (`while (x--)`), `for` counters, accumulators by
   trip count, a cyclic remainder.
3. `src/static.js` `intExprRange`, `forCounterRange`: an expression's hull from reps and
   from the emitter's branch refinements.
4. `src/compile/flow-types.js` `extractRefinements`: the emitter's own refinements.
5. `src/compile/analyze/body-facts.js` `widenLocalTypes`: the integer levels
   (type/int-certain.js), `exprType`'s strict bound, the bare-escape scan, and a rule
   added on 2026-11-10 that a step under a test of its own name is exact (`held`). The
   binding-use scan has its own guarded step for another question
   (analyze-scans.js `guardedStep`, `missGuards`).
6. `src/optimize/int-range.js` and `word-ranges.js`, on WAT.

On 2026-11-10 their disagreements were four miscompiles, each on `main` at every level:
a sum by a term the levels cannot name stayed a word (`a += K` wrapped); a conditional's
bounded arms hid its test from the escape scan; and a bound a test gave a name outlived
the test's own write of it, in (1) and in (4) separately (`while (i < n && s[i++])` read
`t[i]` at `i = n` unchecked). Each was patched where it stood. This step removes the
copies.

## The step (decided; push back with evidence, do not improvise another)

- The proof's environment holds table values (`{lo, hi, int, nz, nan}`,
  src/summary/num-range.js), not integer pairs. Its `|`/`^` field rule and its shift and
  mask rules are tighter than the table's: they move into the table first, each checked
  by the property test in `test/element-numbers.js` (extend its operand pool where a
  rule needs it). Three conventions meet at the edges today (`intExprRange` ignores -0,
  summary spans allow -0 only at an end, the proof's hulls exclude -0): one convention,
  the table's, and each caller converts at its edge.
- One query answers "the numbers of local `x` at this node" and "over its lifetime".
  Readers 2 and 5 ask it instead of scanning: the write hull, the countdown, the cyclic
  remainder, `held`, `exprType`'s strict bound. Say for 3 and 4 what keeps them (the
  emitter's refinements exist because emission cannot ask by node: can it?).
- `src/optimize/int-range.js`'s `+` goes through the table, so its `int` means finite.
- Delete each scan the query replaces. The step ends with fewer lines under `src/` than
  it began, or the report says why not.

## Done when

- `node test/index.js spellings`: `kernel/ring/step first, use old q` equals the
  canonical ring cell (2/27). For `kernel/dot` and `kernel/map` cells `for i<=N-1`,
  `for i!==N i=1+i`, `reverse i--`, `offset idx i-1`: close what range and induction
  facts alone close, and name for each one left the check that refuses it (file:line).
  No cell opens; a closed cell leaves the table (`--update`).
- `test/perf-ratchet.js` equal or lower on both hosts (`JZ_TEST_HOST=wasi`).
- Compile time does not rise: the proof was 4.7% of compile at level 2 over the 94
  single-file bench cases (13,630 calls, 6.6 s of 141 s; up to 30% on `qoi`). Measure the
  same before and after, on a quiet machine, and report both.
- Every test listed under Verify passes. A test that pins a wrong answer is not
  re-baselined: report its smallest source and what Node answers.

## Not in this step

- The local's wasm type decided once (2c) and `int-certain` deleted (2d): report what
  each needs once the query exists.
- A vectorizer legality test (phase 6), any new optimization pass.

## Rules

- General means general: no bench, kernel or corpus program is named or matched.
- Work only on your worktree branch; first `git rebase main`. Never push. Never run
  repo-wide `checkout`, `reset`, `stash`, `clean`, `restore`. Stage files by name. No
  attribution lines in commits. No em-dash.
- Stay out of `module/`, `src/ir/arrays.js`, `src/prepare/`, `src/compile/plan/alias.js`,
  `src/compile/closure-emit.js`, and in `src/compile/analyze-scans.js` the capture
  functions (`boxedCaptures`, `findFreeVars`): another agent is in them.

## Verify, in this order

1. `node test/index.js spellings perf-ratchet` after each change.
2. The differential batteries, each taking the repo path, in
   `/private/tmp/claude-501/-Users-div-projects-jz/36e8fd26-a3d4-48ec-97bb-7106b08fda8d/scratchpad/`:
   `leaf.mjs`, `wide.mjs`, `guard.mjs`, `ubound.mjs`, `condw.mjs`, `condw2.mjs`,
   `rec.mjs`, `rem.mjs`, `cmpd.mjs`, `cmpd2.mjs` (`sweep.sh <repo> <tag>` runs all of
   the session's; `sweep-final.summary` beside it is the pushed tree's result: equal it
   or explain each line that moved). README's FAQ lists the accepted divergences.
3. `npm test` before every commit that claims a fix: on 2026-11-10 three fixes passed
   the gates and the files beside them and failed five pins in the suite.
4. `npm run test:matrix`, `npm run test:generated`, `npm run test:self`, one at a time;
   another agent shares the machine.

## Report

First line: the model you are. Then: the readers moved onto the query and the scans
deleted (file:line), gate cells and ratchet deltas, compile time before and after, lines
added and removed under `src/`. What did not close and what refuses it. What in this
brief was wrong. What you ran and what you inferred.
