# Phase 5a: the optimizer's passes take what they read, in an order that is data

Part of `.work/architecture.md` (phase 5; "What is wrong", item 5; the target's
`optimize` line). Read that first, and `.work/maps/passes.md` and
`.work/maps/plumbing.md` (a scout's tables of every pass file and of what is handed
between stages: leads, not facts).

Phase 5 is two steps. This is the first: no pass reads the compile's state for itself,
and the order of the passes is one table. The second (5b, briefed after this lands) is
one index of a function shared by the passes; do not start it.

## The state (measured before the landing of 2d; measure again)

- `src/optimize` is about 103 files and 33,700 lines. `optimizeFunc`
  (`src/optimize/driver.js`) runs the per-function passes as about 45 guarded calls in
  an order whose reasons are its comments ("before LICM: …", "after the peephole walk:
  …", LICM "at both maturity points"); `optimizeModule`
  (`src/wat/assemble/optimize-module.js`) is a second hand sequence around it, the link
  passes a third, `src/optimize/watr-tail.js` a fourth.
- `src/optimize/config.js` names 133 pass flags and 63 tuning keys. Nothing says which
  pass needs which to have run, or what a pass leaves valid.
- 15 files under `src/optimize` import `src/ctx.js` and read the compile's state
  directly (`devirt.js` twelve places of it, `static-scratch.js`, `quiet-loops.js`,
  `loop-compact.js`, `watr-tail.js`, `globals.js`, `licm.js` …).
- Passes also read marks the emitter leaves on IR nodes as array properties (`saArr`,
  `saBits`, `provenWord`, `dvProp`, `dvObject`, `elemKey`, `cellI32`, `wordOf`), which a
  pass that rebuilds a subtree drops. `holdWordNumbers` (`optimize/peephole.js`) is the
  newest reader. Which pass reads which mark, and which pass may drop it before that
  reader runs, is written nowhere.
- Phase 4 (a memo of the per-function passes, handed back and not landed: branch
  `worktree-agent-ad38f46bbe9197c87`, a48e8b6fe) had to find what the passes read by
  recording it: `src/optimize/memo.js` on that branch wraps `ctx` in recording views,
  and its driver change gathers the function's own facts as one value (`funcFacts`).
  Read both as leads for the facts value; do not port the memo. Its measurements: the
  per-function passes are 20 to 26% of a warm compile of an allocating program,
  `word-ranges.js` 18.9% of compile CPU, watr's `optimize.js` 19.1%.

## The outcome

1. Every pass under `src/optimize` is a function of the function it is given and of
   facts handed to it: no file there imports `ctx.js`. What a pass reads of the compile
   is a value built once per compile, or once per function where it is the function's.
2. The order is data. One table names each pass with its flag, the facts it takes, the
   node marks it reads, what it needs to have run and what it leaves valid; the
   sequences are walked from it: `optimizeFunc`, the module sequence, the link passes
   and the tail hold no order of their own. A comment that explains an order becomes an
   entry a check enforces.
3. With 1 and 2 a cache of a helper's optimized form is a lookup keyed by the function
   and the facts its passes take. Say in the report what that cache would be (its key,
   where it sits), and what it would save by phase 4's figures. Do not build it.

How is yours to decide from the code.

## The rule that must keep holding

This phase changes no emitted byte: every module, at every level, on either host, is
byte for byte what `main` emits. A pass that runs earlier, later, twice where it ran
once is a change of bytes, and is not this phase: where the table shows an order that
should change, leave it and list it in the report.

- Write the differential first and run it on `main`: bytes of a corpus before and
  after, at levels 0 to 3, size and speed, on both hosts, with pass flags flipped from
  their defaults (`SCRATCH/p4-review.mjs` compiles about 1,100 such programs a round
  and compares bytes between orders of compiles: take its generator; `SCRATCH/sizes.mjs`
  prints the bench corpus's bytes).
- The compiler compiles itself (`npm run test:self`): the table and the facts stay in
  the subset the hosted compiler runs (`AGENTS.md`: an index into a Number reads it as
  a pointer; no `delete` of a static key), and allocate nothing per pass they cannot
  release (`src/ast.js` `takeScratchMap`/`takeScratchSet` are the discipline).
- Compile time not above today's: measure your own baseline first, alternating base
  and new by CPU time on the same machine (it is shared and loaded: one run proves
  nothing).

## Done when

- `grep -l "ctx.js" -r src/optimize` names no file.
- The four sequences are walks of the table; a pass run out of the order its entry
  states fails a test.
- Byte identity shown on the differential, `node test/index.js spellings perf-ratchet`
  unchanged on both hosts, bench bytes identical.
- `src/` no larger than it began, or the report says why.

## Rules of work

- General means general: no bench, corpus program or spelling is special-cased.
- Work only on your worktree branch; first `git rebase main`. Link the modules with
  `ln -s /Users/div/projects/jz/node_modules node_modules` and the conformance suite
  with `ln -s /Users/div/projects/jz/test/test262 test/test262`; stage neither. Never
  `npm install` in a directory you did not make. Never push. Never run repo-wide
  `checkout`, `reset`, `stash`, `clean`, `restore`. Stage files by name. No attribution
  lines in commits. No em-dash.
- Commit in steps that each keep the rule (the facts of one group of passes in as
  values; the table; each sequence walked from it), so a step can land while the next
  is reviewed. If the whole is more than you can finish and verify, stop at a step
  that is whole and say what is left.
- No other agent writes this repo while you work. The integrator may land a fix on
  `main`: rebase before you report.

## Verify, in this order

1. Your byte differential after each step.
2. `node test/index.js spellings perf-ratchet`.
3. `npm test` before every commit that claims a step, then `npm run test:matrix`,
   `npm run test:generated`, `npm run test:self`, one at a time
   (`JZ_TEST_JOBS=4 JZ_TEST_TIMEOUT=10800000 JZ_SELF_BUILD_TIMEOUT=3600000` on the
   loaded machine).

## Report

First line: the model you are. Then: the table (file:line) and what an entry holds;
where each sequence walks it; the facts value, what it holds and who builds it; each
node mark, its writer, its readers and the passes that can drop it before a reader;
the cache of outcome 3; lines added and removed under `src/`; compile time before and
after with the method. Every defect found, with its smallest source and whether it was
on `main`. Each order the table showed to be an accident, left as it was. What in this
brief was wrong. What you ran and what you inferred.
