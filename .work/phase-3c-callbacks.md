# Phase 3c: a callback's statements run in place; a for…of reads its array

> Landed, with decision 1 below corrected: "a local of the enclosing function it
> writes stays a local" was wrong. A local an arrow writes stays in its cell for every
> analysis, and the optimizer holds a cell no closure took in a local
> (`.work/architecture.md`, "Found on the way (2026-11-10)"). Do not brief from this
> file as it stands.

Part of `.work/architecture.md` (phase 3). Read that first, then `.work/phase-3b-loops.md`
(landed: one `walk`, src/ir/arrays.js, at 38 emitter sites; typed-array callbacks bound
by the summary and inlined through `makeCallback`, module/array/callback.js).

## The defect

`node test/index.js spellings` (table `test/spellings.json`): `kernel/dot` written with
`forEach` or with `for…of` and an index loses SIMD at both levels where the `for`
spelling keeps it. What 3b's agent found (verify before relying on it):

- **`forEach`**: the loop body is `(drop (call_indirect …))`, refused by the lift
  (src/optimize/vectorize/lift.js, "standalone drop statement"). The callback
  `{ s += x * b[i] }` has a statement body, which `makeCallback` never inlines (only an
  expression body, `isPureExpr`), and `s` becomes a heap cell because an arrow writes it
  (compile/analyze-scans.js `boxedCaptures`, compile/closure-emit.js). The same on plain
  arrays.
- **`for…of` with an index**: `for…of` already lowers to a source `for`
  (src/prepare/handlers.js, about line 1490), but binds `arr = __iter_arr(a)`, a boxed
  pointer whose decode LICM leaves in the block preamble, which the three reduce
  recognizers refuse (`bl.preamble.length`, src/optimize/vectorize/reduce.js). A draft
  that reads `__iter_arr(a)` as `a` in `src/compile/plan/alias.js` closed both cells
  with no other cell moving:
  `/private/tmp/claude-501/-Users-div-projects-jz/36e8fd26-a3d4-48ec-97bb-7106b08fda8d/scratchpad/p3b/forof-alias.diff`.
  It writes kinds as numbers; do it by the summary's own names.

## The change (decided; push back with evidence)

1. An arrow written in place as the callback of an array or typed-array method the
   emitter walks runs in that walk: its statements are emitted in the loop, its
   parameters are the walk's locals (as an expression body's are since 3b), and a local
   of the enclosing function it writes stays a local, because the arrow is called there
   and nowhere else. A block body qualifies where its value is plain: no `return`
   (`forEach`), or one `return` as its last statement. Anything else keeps the closure.
2. `for (const x of a)` where the summary holds `a` to a present array or typed array,
   stable and uncaptured over the loop, reads `a` itself: no copy binding between the
   loop and its receiver.

Prefer fixing the producer to teaching a reader a second form. Where a reader must
change, say why the producer could not.

What must hold, each against Node at every level (a wrong answer is a miscompile:
report its smallest source):
- A closure made inside an inlined body sees its own round's values
  (`a.forEach(x => fns.push(() => x))`), and one made after the walk sees the final ones.
- A callback that throws, that grows, shrinks or stores into the receiver, that writes
  a captured local another closure also reads; nested callbacks sharing a name; `thisArg`.
- `for…of` over an array the body grows visits the new elements; over a typed array,
  a string, a Set and a Map it answers as today.
- `forEach`'s value is `undefined`.

## Done when

- The `kernel/dot` cells for `forEach` and `for-of + idx` leave the table (`--update`),
  no cell opens, no listed excess grows.
- `test/perf-ratchet.js` equal or lower on both hosts.
- Fewer lines under `src/` and `module/` than it began, or the report says why not.

## Also yours: three defects in this area, each with a test when fixed

- `Array.from(a, f)` where `f` grows `a` stops at the first length:
  `const a = [1, 2, 3]; Array.from(a, (x, i) => { if (i === 0) a.push(4); return x * 2 })`
  answers `[2, 4, 6]`, Node `[2, 4, 6, 8]` (module/array/from.js).
- `Array.from(set)` through a helper answers `[]` at level 0 where the direct form is a
  compile error with a message.
- Levels 2 and over: `const t = new Float64Array(4); let i = 0, c = 0;
  while (i < 4 && (t[i++] = 1) > 0) { c++ }` compiles to a module that does not validate
  ("not enough arguments on the stack"): a typed store's value in a loop test.

## Rules

- General means general: no method, callback shape, bench or corpus program is
  special-cased. If a method needs a line of its own, say why in the report.
- Work only on your worktree branch; first `git rebase main`. Never push. Never run
  repo-wide `checkout`, `reset`, `stash`, `clean`, `restore`. Stage files by name. No
  attribution lines in commits. No em-dash.
- Stay out of `src/type/`, `src/static.js`, `src/summary/num-range.js`,
  `src/compile/analyze/body-facts.js`, `src/optimize/int-range.js`,
  `src/optimize/word-ranges.js`, and in `src/compile/analyze-scans.js` everything but
  the capture functions (`boxedCaptures`, `findFreeVars`): another agent is in them.

## Verify, in this order

1. `node test/index.js spellings perf-ratchet` after each change.
2. The differential batteries, each taking the repo path, in
   `/private/tmp/claude-501/-Users-div-projects-jz/36e8fd26-a3d4-48ec-97bb-7106b08fda8d/scratchpad/`:
   `cb.mjs` (callbacks and emitted walks: its `storeSelf | h` lines are the harness's,
   a module array doubled once per level), `adv.mjs`, `adv2.mjs`, `adv3.mjs`,
   `promo.mjs`, `once.mjs`, `filt.mjs`, `tstore2.mjs`, `p3b/adv3b.mjs`
   (`sweep.sh <repo> <tag>` runs all of the session's; `sweep-final.summary` beside it
   is the pushed tree's result: equal it or explain each line that moved).
3. Bytes of every bench case before and after (`sizes.mjs` there, `cmp-sizes.mjs`
   compares two runs): name each case that grows and why.
4. `npm test` before every commit that claims a fix, then `npm run test:matrix`,
   `npm run test:generated`, `npm run test:self`, one at a time; another agent shares
   the machine.

## Report

First line: the model you are. Then: what inlines now and what keeps the closure
(file:line, why), gate cells and ratchet deltas, bench bytes that moved, lines added and
removed. What did not vectorize and the check that refuses it. What in this brief was
wrong. What you ran and what you inferred.
