# Phase 3b: one loop constructor in emit

Part of `.work/architecture.md` (phase 3). Read that first, then `.work/maps/loops.md`
section 1 (rows for `forEach`/`map`/`reduce`/`for…of` and the stdlib loops) and
`.work/phase-3a-callbacks.md` (landed: an inlined callback's parameters read their
kinds from the summary through `view.aliasParam`, src/summary/query.js). The map is a
scout's: leads with file:line, each claim marked verified or inferred; its line numbers
are from before phases 1 and 3a.

## The defect

A loop the source writes as `for (let i = 0; i < n; ++i)` reaches the optimizer in one
shape (phase 1). A loop the emitter builds itself does not: `forEach`, `map`, `reduce`,
`for…of` and the stdlib walks are assembled as WAT at about 378 sites, through
`arrayLoop` (src/ir/arrays.js), `typedLoop` (module/typedarray.js), `callbackLoop`
(module/array/callback.js) and by hand. The readers of a loop then miss them.

What the gate shows today (`node test/index.js spellings`, table `test/spellings.json`):
`kernel/dot` written with `for…of`, `forEach` or `reduce` loses SIMD at both levels
where the `for` spelling keeps it.

What phase 3a's agent measured on the way (verify before relying on it):
- A plain-array `reduce` is first refused by `matchExitBrIf`
  (src/optimize/vectorize/addr-model.js, called from scaffold.js): it takes
  `(br_if $brk (i32.eqz (i32.lt_s|lt_u i bound)))`, and the callback loop writes the
  same test as `(i32.ge_s i len)`. Behind it, inferred and not run: the body sits under
  `(if (i32.lt_u i <current length>) …)`, which the reduction recognizer
  (vectorize/reduce.js) does not take for an add.
- Typed-array `forEach`/`reduce`/`map`/… never inline their callback: they go through
  `captureCallback` and the closure ABI (module/typedarray.js, the `.typed:*` emitters),
  a `call_indirect` per element. The summary binds a typed receiver's callback in
  `reduceResult`; check what it does for the other methods.

## The change

One constructor for a counted walk over an array or a typed array, used by every
emitter that walks one, producing the WAT a source `for` over the same receiver
produces: the same exit test, the same counter step, the same bounds and hole handling
as the source loop's element read. Typed-array callbacks inline through `makeCallback`
as array callbacks do, parameters typed by the summary. `for…of` over an array or a
typed array lowers to that walk.

Prefer fixing the producer to teaching a reader a second form: a matcher extended to
accept the emitter's other spelling is the wrong fix. Where a reader must change, say
why the producer could not.

What must hold, each against Node at every level (a wrong answer is a miscompile,
report its smallest source):
- `forEach`, `map`, `filter`, `reduce`, `some`, `every` skip nothing jz stores (README:
  no holes, a gap is `undefined` elements); `find*` visit missing elements as
  `undefined`; `reduce` with no seed over an empty receiver throws.
- A callback that grows, shrinks or stores into the receiver while it is walked.
- A callback's index and receiver parameters; `thisArg`; a BigInt receiver.
- A typed array whose buffer the callback can reach; a zero-length receiver.
- `forEach`'s value is `undefined` (fixed 2026-11-09 on every receiver).

## Done when

- The `kernel/dot` cells for `for-of + idx`, `forEach` and `reduce` leave the table
  (`--update`), no cell opens, no listed excess grows.
- `test/perf-ratchet.js` is an equality per host: lock a drop with `--update` under each
  host, explain a rise; never re-baseline a rise alone.
- `arrayLoop`, `typedLoop` and `callbackLoop` are one function or the report says what
  keeps them apart. The phase ends with fewer lines under `src/` and `module/` than it
  began, or the report says why not.

## Not in this phase

- A new vectorizer legality test (phase 6), any new optimization pass.
- The other gaps in the table (`i<=N-1`, `i!==N`, `reverse i--`, offset index, ring):
  range and induction facts, another agent's.

## Rules

- General means general: no method, callback shape, bench or corpus program is
  special-cased. If a method needs a line of its own, say why in the report.
- Work only on your worktree branch; first `git rebase main` (local `main` is ahead of
  origin). Never push. Never run repo-wide `checkout`, `reset`, `stash`, `clean`,
  `restore`. Stage files by name. No attribution lines in commits. No em-dash.
- Stay out of `src/type/`, `src/static.js`, `src/compile/analyze*`,
  `src/compile/plan/integral-loops.js`, `src/optimize/int-range.js`,
  `src/optimize/word-ranges.js`, `src/summary/num-range.js`: another agent is in them.

## Verify, in this order

1. `node test/index.js spellings perf-ratchet` after each change.
2. A differential battery against Node over every method and receiver you touch, all
   levels. Two to copy from, which take the repo path:
   `/private/tmp/claude-501/-Users-div-projects-jz/36e8fd26-a3d4-48ec-97bb-7106b08fda8d/scratchpad/adv.mjs`
   and `adv2.mjs` beside it. README's FAQ lists the accepted divergences (numeric
   export parameters among them).
3. Bytes of every bench case before and after (`sizes.mjs` in that same folder, repo
   path as its argument): name each case that grows and why.
4. `npm test`, then `npm run test:matrix`, `npm run test:generated`, `npm run test:self`.
   Do not run two of them at once; another agent shares the machine.

## Report

The emitters moved onto the constructor and those left (file:line, why), gate cells and
ratchet deltas, bench bytes that moved, lines added and removed. What did not vectorize
and the check that refuses it (file:line). What in this brief was wrong. What you ran
and what you inferred.
