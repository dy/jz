# Phase 2d: the integer levels read from the proof; `int-certain.js` deleted

Part of `.work/architecture.md` (phase 2). Read that first: row 2 of the phase table
and "Found on the way (2026-11-11)", which lists what the review of 2c met.

## The state

2c decides a local's and a module global's storage from the interval proof's values
(`compile/analyze/body-facts.js` `widenLocalTypes`, `compile/plan/scope.js`
`inferModuleIntGlobals`). `src/type/int-certain.js` (the levels 0, 1, 2 of a name over
the writes one body holds) is still what seven files ask:

- `compile/analyze/val-types.js` `analyzeIntCertain` (`rep.intCertain`, `intOrMiss`:
  floor elision, the ToNumber skip, whole index keys, the guarded character key);
- `compile/narrow/int-params.js` (a callee's parameter), `compile/narrow/param-abi.js`
  (a parameter its function writes);
- `compile/program-facts/slot-int-census.js` (schema slots);
- `compile/analyze-for-emit.js` (closure cells);
- `compile/plan/counted-loops.js` (offset tests), `compile/plan/integral-loops.js`
  (`markExactDivisions`, `isExactDivision`).

It is a second classifier of one fact, and the review of 2c found it wrong at every
level, on `main` before 2c: a name with an integer write in sight was an integer though
other code writes it (`let G = 0; const w = (d) => { G += 0.25; if (d > 0) w(d - 1) };
export let f = () => { G = 0; w(5); return Math.round(G) }` answered 1.5; `T[G]` read
the first element for `G = 0.5`; a closure's parameter the body also writes was an
integer by that write). The landing grounds such a name (`levelsOfDefs`: a module
binding, a capture, a closure's parameter start from what is known of all their writes),
which is sound and gives up precision: a module global every write of which is an
integer, stored as a Number, is floored and its keys checked again.

2c's agent named what stands between the readers and the proof: level 1 is "an integer
wherever finite" (an integer, NaN or an infinity), which the table's `int` (a finite
integer) cannot carry without a fact for the infinities; and four readers decide for
bindings written in more than one flow (cells, written parameters, slots, callers'
arguments), where the proof walks one flow.

## The outcome

1. `src/type/int-certain.js` is deleted. Each reader asks the proof's published values,
   as `body-facts.js`, `emit/arithmetic.js` and `plan/scope.js` do since 2c.
2. What level 1 means is one fact of the table (`src/summary/num-range.js`), with every
   rule and the property test holding it, or the readers are shown not to need it.
3. A binding written in more than one flow has one value: the meet of its writes in
   every flow that can run, found as a module global's word is now (the proof per flow
   under a hypothesis the caller verifies), or by a construction you show is simpler.
4. The precision the grounding gave up returns where it is true: a module global every
   write of which anywhere is an integer is read as one.

How is yours to decide from the code.

## The rules that must keep holding

Write your own battery against these before you change anything, run it on `main`, and
keep it green; a wrong answer against Node at any level is a miscompile to report with
its smallest source.

- A name is an integer only where every write of it is one, in every flow that can run:
  a callee's, a sibling closure's, a generator's, a callback's, the caller's argument
  for a parameter, the host's for an export's parameter.
- The value of an assignment is the number assigned, not what the target's storage
  keeps of it.
- An unsigned word is no signed word: its top is past 2^31, and a proof of one side of
  `a - k` says nothing of the other.
- -0, NaN, an infinity, a fraction, `undefined` and a box are no integers; a Boolean is
  no number.
- What the emitter asks about a node the proof never walked still gets a sound answer.
- No analysis is told of a choice the emitter makes later, and the emitter makes no
  choice an analysis relied on the opposite of.

## Done when

- `int-certain.js` is gone and `src/` is smaller than it began.
- `node test/index.js spellings perf-ratchet`: no cell opens, no listed excess grows,
  ratchet equal or lower on both hosts (`JZ_TEST_HOST=wasi` for the other).
- Compile time not above today's (measure your own baseline first, alternating base
  and new on the same machine).

## Rules of work

- General means general: no bench, corpus program or spelling is special-cased.
- Work only on your worktree branch; first `git rebase main`, and link the shared
  modules with `ln -s /Users/div/projects/jz/node_modules node_modules` (never
  `npm install` there). Never push. Never run repo-wide `checkout`, `reset`, `stash`,
  `clean`, `restore`. Stage files by name. No attribution lines in commits. No em-dash.
- Other agents are at work in `src/normalize.js`, `src/prepare/`,
  `src/compile/loop-model.js`, `src/compile/emit/control-flow.js`, the loop plans under
  `src/compile/plan/`, and in `src/optimize/driver.js`, `src/wat/assemble/`. Where a
  reader of the levels lives in one of those (`plan/counted-loops.js`,
  `plan/integral-loops.js`), keep the change to the lines you need and name them in
  the report.

## Verify, in this order

1. `node test/index.js spellings perf-ratchet` after each change.
2. The reviewer's batteries, in
   `/private/tmp/claude-501/-Users-div-projects-jz/36e8fd26-a3d4-48ec-97bb-7106b08fda8d/scratchpad/`:
   `node p2c-review.mjs <repo>` (5,234 programs; a group or several: `W`, `X,G,H`),
   and the probes `outsight.mjs`, `unseen.mjs`, `cparam.mjs`, `uread.mjs`, `usub.mjs`,
   `wval.mjs`, `chain.mjs`, `floorg.mjs` (each `node <probe> <repo>`). All answer 0
   wrong on the landed tree, but `cparam.mjs`'s `sorted`, which reads the order a
   comparator is called in.
3. `sh sweep.sh <repo> <tag>` there (the earlier phases' batteries), against the summary
   recorded for the landed tree.
4. Bytes of every bench case before and after (`sizes.mjs`, `cmp-sizes.mjs` there):
   name each case that grows and why.
5. `npm test` before every commit that claims a fix, then `npm run test:matrix`,
   `npm run test:generated`, `npm run test:self`, one at a time
   (`JZ_TEST_TIMEOUT=10800000` if a leg hits the hour on the loaded machine).

## Report

First line: the model you are. Then: where each reader asks now (file:line); what was
deleted; what the table gained; gate cells and ratchet deltas; compile time; bench
bytes that moved; lines added and removed under `src/`. Every miscompile found, with
its smallest source and whether it was on `main`. What stays a second classifier and
why. What in this brief was wrong. What you ran and what you inferred.
