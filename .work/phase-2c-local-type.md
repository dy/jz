# Phase 2c and 2d: a local's storage decided once, by the proof; `int-certain` deleted

Part of `.work/architecture.md` (phase 2). Read that first: the phase table's row 2 and
both "Found on the way" sections, which list every defect of this class met so far.

## The state

2b made `src/type/interval-proof.js` the engine of a local's numbers (its environment
holds `src/summary/num-range.js` values, `{lo, hi, int, nz, nan, gap}`), and deleted the
range scans it replaced. Whether a local is stored as a word (`i32`) or a Number
(`f64`) is still decided by several classifiers that must agree and have not always:

- `exprType` (`src/type/expr-type.js`), whose non-strict reading types `+`/`-` a word
  provisionally;
- the integer levels, `src/type/int-certain.js` (`intLevelMap`: 0 unknown, 1 integral
  and range-open, 2 a word), read by `compile/analyze/body-facts.js`,
  `compile/narrow/int-params.js`, `compile/emit/arithmetic.js`;
- `widenLocalTypes` (body-facts.js): passes over the body and a hypothesis loop
  (`grew`) that re-runs the proof's `writtenNumbers` each round;
- the bare-escape scan (`collectBareEscapes`, `compile/analyze-scans.js`), which lets a
  range-open integer stay a word where every read re-applies ToInt32.

Two classifiers of one fact gave `let a = k | 0; a += K` at 2147483647 the answer
-2147483646, and a pinned n-queens count that wrapped past 2^31.

## The outcome

1. One decision. A local's storage follows from the proof's value for it over its
   lifetime: a word where every value written to it is one, or where every read of it
   re-applies ToInt32 to an integer of any size; a Number otherwise. The decision is
   made in one place and every reader asks that place.
2. `src/type/int-certain.js` is deleted; what its three readers need they read from
   the proof's published values. `markExactDivisions`/`isExactDivision`
   (`compile/plan/integral-loops.js` reads them) move to where they belong or go.
3. The hypothesis loop in `widenLocalTypes` is gone.

How is yours to decide from the code. 2b's agent reported what it found missing: the
proof's lifetime value published whole (`int`, `nz`, `nan`, not an integer pair), and
the carriers entering the proof as values (a call's ABI word, a typed read's element
numbers). Verify that before relying on it.

## The rules that must keep holding

Write your own battery against these before you change anything, run it on `main`,
and keep it green; a wrong answer against Node at any level is a miscompile to report
with its smallest source.

- A word-stored local holds what JS holds at every read: no sum, product, step or
  negation wraps where JS does not. The boundary is 2^31 on both sides and 2^32 for an
  unsigned reading; test at it, not near it.
- A local a closure or an in-place callback writes is in a cell (`ctx.func.boxed`);
  72 sites and 215 scans rely on that (`.work/architecture.md`, 3c). Do not type such a
  local from writes the scan cannot see.
- -0, NaN, a fraction, `undefined` and a box never enter a word: a local that may hold
  one is a Number.
- What the emitter asks about a node the proof never walked (plan rewrites, inlined
  copies, version twins) still gets a sound answer.
- No analysis is told of a choice the emitter makes later, and the emitter makes no
  choice an analysis relied on the opposite of.

## Done when

- `int-certain.js` is gone, `widenLocalTypes` holds no hypothesis loop, and `src/` is
  smaller than it began.
- `node test/index.js spellings perf-ratchet`: no cell opens, no listed excess grows,
  ratchet equal or lower on both hosts (`JZ_TEST_HOST=wasi` for the other).
- Compile time not above today's: the proof at level 2 over the single-file bench
  cases was 3.8% of compile after 2b (measured on a loaded machine; measure your own
  baseline first, alternating base and new).

## Rules of work

- General means general: no bench, corpus program or spelling is special-cased.
- Work only on your worktree branch; first `git rebase main`, and link the shared
  modules with `ln -s /Users/div/projects/jz/node_modules node_modules` (never
  `npm install` there). Never push. Never run repo-wide `checkout`, `reset`, `stash`,
  `clean`, `restore`. Stage files by name. No attribution lines in commits. No em-dash.
- Another agent is in `src/normalize.js`, `src/prepare/`, `src/compile/loop-model.js`,
  `src/compile/emit/control-flow.js` and the loop plans under `src/compile/plan/`.
  Stay out of them; where you must touch one, keep it to the lines you need and name
  them in the report.
- Do not change `src/compile/plan/scope.js` `inferModuleIntGlobals`: its integer
  default is a decision the owner has not made yet.

## Verify, in this order

1. `node test/index.js spellings perf-ratchet` after each change.
2. The differential batteries in
   `/private/tmp/claude-501/-Users-div-projects-jz/36e8fd26-a3d4-48ec-97bb-7106b08fda8d/scratchpad/`:
   `sh sweep.sh <repo> <tag>` runs all 24 (`p2b-review.mjs` and `p3c-review.mjs` are the
   reviewer's for 2b and 3c); `sweep-pushed2.summary` beside it is the pushed tree's
   result. Equal it or explain each line that moved.
3. Bytes of every bench case before and after (`sizes.mjs`, `cmp-sizes.mjs` there):
   name each case that grows and why.
4. `npm test` before every commit that claims a fix, then `npm run test:matrix`,
   `npm run test:generated`, `npm run test:self`, one at a time; another agent shares
   the machine (`JZ_TEST_TIMEOUT=10800000` if a leg hits the hour).

## Report

First line: the model you are. Then: where the decision lives now (file:line) and each
reader that asks it; what was deleted; gate cells and ratchet deltas; compile time;
bench bytes that moved; lines added and removed under `src/`. Every miscompile found,
with its smallest source and whether it was on `main`. What stays a second classifier
and why. What in this brief was wrong. What you ran and what you inferred.
