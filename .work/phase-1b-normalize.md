# Phase 1b: normalize once kinds are known; `do…while` first-class; one spelling read

Part of `.work/architecture.md` (phase 1). Read that first: the phase table's row 1,
"Decisions taken" and "Open questions".

## The state

`src/normalize.js` (`normalizeProgram`, called from `src/front.js`) rewrites loop
spellings to one form before the summary runs, so it knows no kinds: a step is
rewritten only for a counter that starts from a number literal and is only ever
stepped. What that leaves:

- A counter declared from a parameter or another name is no Number by syntax, so its
  `i += 1`, `i = i + 1`, `i = 1 + i`, `i -= -1` stay as written, and every reader of a
  loop keeps a list of those forms (`src/compile/loop-model.js` `counterStep` and its
  callers, `src/static.js`, `src/type/`, `src/compile/plan/*loops*`).
- `do…while` is lowered by prepare to `let F = true; while (F || c) { F = false; B }`
  (`src/prepare/handlers.js` `'do'`) and recognized back from the flag by normalize
  and others (`doFlag`, `src/normalize.js:202`).
- `test/spellings.json` holds 76 gaps of 470 cells: each is a spelling of a kernel that
  compiles worse than its canonical `for (let i = 0; i < N; i++)`.

## The outcome

1. After the summary knows kinds, a loop whose counter is a Number is in the one
   canonical form, whatever it was declared from. Where the rewrite runs (a second
   normalize call, or normalize moved) is yours to decide from the pipeline
   (`parse → jzify → prepare → preEval → normalize → summarizeProgram → plan → …`).
2. The readers read one form. Each hand-kept list of step or test spellings is deleted,
   or the report says which reader still needs which form and why.
3. `do…while` is one thing end to end, not a flag another stage must recognize. The
   open question in `.work/architecture.md` names two candidates (a first-class
   bottom-tested loop through emit, or a counted `for` under a guard fact): decide from
   what the emitter and the vectorizer scaffold accept, and say what decided it.

## The rules that must keep holding

Write your own battery against these before you change anything, run it on `main`,
and keep it green; a wrong answer against Node at any level is a miscompile to report
with its smallest source.

- A rewrite is value-exact: the same values in the same order at every read, the same
  number of evaluations of every expression with an effect, the same exceptions. A
  counter that may be a string, a BigInt, `undefined`, -0, NaN, a fraction or past
  2^53 is not rewritten on the strength of what it usually is.
- A body's `continue` reaches the step and the test as it does in the source; a
  `do…while` body runs once before its test, with `break`, `continue`, a labeled exit
  and a `return` in it.
- A counter or a bound the body writes, a closure captures or a callback writes is not
  a counter of the canonical form (a local an arrow writes is in a cell; see 3c in
  `.work/architecture.md`).
- No analysis is told of a choice a later stage makes, and no stage makes a choice an
  analysis relied on the opposite of.

## Done when

- `node test/index.js spellings` with `--update`: gaps leave the table, no cell opens,
  no listed excess grows; the report lists the cells that left and those that stay
  with the check that refuses each.
- `test/perf-ratchet.js` equal or lower on both hosts (`JZ_TEST_HOST=wasi`).
- Fewer lines under `src/` than it began.

## Rules of work

- General means general: no bench, corpus program or kernel is special-cased.
- Work only on your worktree branch; first `git rebase main`, and link the shared
  modules with `ln -s /Users/div/projects/jz/node_modules node_modules` (never
  `npm install` there). Never push. Never run repo-wide `checkout`, `reset`, `stash`,
  `clean`, `restore`. Stage files by name. No attribution lines in commits. No em-dash.
- Another agent is in `src/type/`, `src/compile/analyze/body-facts.js`,
  `src/compile/analyze-scans.js`, `src/summary/num-range.js` and
  `src/compile/narrow/int-params.js`, deciding a local's storage once. Stay out of
  them; where a reader there keeps a spelling list you need gone, keep the change to
  those lines and name them in the report.

## Verify, in this order

1. `node test/index.js spellings perf-ratchet` after each change.
2. The differential batteries in
   `/private/tmp/claude-501/-Users-div-projects-jz/36e8fd26-a3d4-48ec-97bb-7106b08fda8d/scratchpad/`:
   `sh sweep.sh <repo> <tag>` runs all 24; `sweep-pushed2.summary` beside it is the
   pushed tree's result. Equal it or explain each line that moved.
3. Bytes of every bench case before and after (`sizes.mjs`, `cmp-sizes.mjs` there):
   name each case that grows and why.
4. `npm test` before every commit that claims a fix, then `npm run test:matrix`,
   `npm run test:generated`, `npm run test:self`, one at a time; another agent shares
   the machine (`JZ_TEST_TIMEOUT=10800000` if a leg hits the hour).

## Report

First line: the model you are. Then: where the rewrite runs and why there; each
spelling list deleted and each kept (file:line, why); what `do…while` is now; gate
cells and ratchet deltas; bench bytes that moved; lines added and removed under `src/`.
Every miscompile found, with its smallest source and whether it was on `main`. What in
this brief was wrong. What you ran and what you inferred.
