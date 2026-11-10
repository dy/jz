# Phase 1: one loop form

Part of `.work/architecture.md`. Read that first, then `.work/maps/loops.md` sections
1, 3I, 4 and 5 (a scout's map: leads with file:line, each claim marked verified or
inferred; check a line before relying on it).

## Goal

The same loop written another way compiles to the same code. Today 78 sites match a
counter, a step or a test by its written shape; a spelling outside a site's list falls
off that optimization. This phase puts every source loop into one form before anything
reads it, so the lists can shrink to that form.

Done is measured by `test/spellings.js` (`node test/index.js spellings`; table
`test/spellings.json`, `--update` rewrites it). A listed gap that closes must leave the
table; no cell may open; no listed excess may grow. `test/perf-ratchet.js` is an
equality per host: a count that drops is locked with `--update`, a count that rises is
a regression to explain.

## Design (decided; push back with evidence, do not improvise another)

One module, `src/normalize.js` (name it as the tree names things), with one entry:

    normalize(node, isNumber)

It rewrites a statement tree in place into the normal form below. `isNumber(name)`
says whether a name holds a Number at every point of the tree. Every rewrite below is
exact in value, in evaluation order and in what it calls; where exactness needs a
name to be a Number, the rewrite asks `isNumber`.

Two callers:

1. **Front end**, at the end of `frontHalf` (`src/front.js`), over every function body
   and the module init, before `summarizeProgram` reads a loop. Kinds are unknown
   here, so `isNumber` is syntactic induction: a local (not a parameter) declared with a
   numeric literal, every write of it a numeric step (`++`, `--`, `+=`/`-=` a numeric
   literal, `= name ± literal`, `= literal + name`) or a numeric literal, and not written
   by a closure (`closureMutatedVars`). Such a name is a Number, never NaN while its
   steps are finite literals from a finite start.
2. **Inside a versioned copy** (`src/compile/plan/integral-loops.js`), over the copy the
   run-time tests guard, with the tested names as Numbers. This is where a counter that
   starts from a parameter, and a bound that is a parameter, reach the same form.
   (Second step of the phase; land the front-end caller first.)

Normal form of a counted loop:

    for (init; i < bound; ++i) body        // 5-ary post-prepare `for`; `<=`, `>`, `>=`, `--i`, `i += K` likewise

Rewrites:

- **Step.** For a Number `i`: `i += 1`, `i = i + 1`, `i = 1 + i`, `i -= -1`,
  `i = i - -1` → `++i`; the same with −1 → `--i`; `i = i + K`, `i = K + i`, `i -= -K`
  → `i += K`. Only where the value of the statement is unused (prepare's
  `dropDeadPostfix` already decides this for `++`). Not `(i + 1) | 0`: that wraps, it
  is a different step.
- **Test orientation.** A comparison with a Number name on the right and none on the
  left is mirrored: `n > i` → `i < n`, `n >= i` → `i <= n`, `n < i` → `i > n`,
  `n <= i` → `i >= n`. Exact because converting a Number calls nothing, so the order
  of the two conversions cannot be observed. Loop tests first; say in the report
  whether doing it for every comparison changed anything.
- **A leading break is the test.** `while (true) { if (c) break; B }` (the break is
  this loop's, `B` may `continue`) → `while (!c) { B }`. Structural, always exact.
- **Negated tests.** `!(a >= b)` → `a < b` and the three siblings only where neither
  side can be NaN: both Numbers by `isNumber`, or a numeric literal / module constant.
  Otherwise the `!` stays. (`3 >= NaN` is false, so `!(i >= n)` runs and `i < n` does
  not.) Caller 2 is what makes this reach a parameter bound.
- **`do…while`.** jzify (`jzify/transform.js`, about line 737) and strict prepare
  (`prepare/handlers.js`, about line 867) lower it to `let F = true; while (F || c) {
  F = false; B }`, which no reader takes for a counted loop. Before that lowering:
  - `if (c) do B while (c)`, the two tests the same expression with no effects → `while
    (c) B`. Structural, always exact: the tests run in the same order.
  - `do B while (c)` where `c` is true on entry by constant evaluation (the counter's
    declaration with a literal directly precedes the loop, the bound a literal or
    module constant) → `while (c) B`.
  - Any other `do` keeps the flag form in this phase. Whether it becomes a first-class
    bottom-tested loop is the phase's open question: report what the emitter and the
    vectorizer scaffold would need.
- **`while` with a trailing step.** `while (i < n) { B; ++i }` → `for (; i < n; ++i) B`
  only if `B` has no `continue` of this loop and does not write `i`, and the loop is
  not the target of a label that a rewrite would move. If the readers already treat
  the two alike (the gate's `while` style has no gap beyond the default's), leave it.

What it must keep (each has an existing guard in the tree; `.work/maps/loops.md` §5
lists them): per-iteration `let`s captured by closures (prepare already turned those
into `for (;;)` with carriers: do not match inside), `continue` targets, labels adopted
by the loop directly inside them, the number of times and the order a bound is
evaluated, a bound the body changes, −0/NaN/fractions.

## Then delete

With every producer of loops going through the form, a reader needs one spelling.
After each caller lands, remove from the readers the spellings the form excludes, and
say which you removed and which you had to keep and why (a pass that builds a loop
after normalization and does not use the form is a producer to fix, not a reason to
keep a list). Start with `unitIncVar` (`src/compile/loop-model.js`), its dead export
`uniqueUnitIncOf`, the step lists in `src/static.js` (`forCounterBoundsIn`,
`elementCounter`), and `matchInc1` (`src/optimize/vectorize/addr-model.js`), which
requires `local.get` first where the emitter can be made to emit it first.

The phase ends with fewer lines under `src/` than it began, or the report says why not.

## Not in this phase

- `i !== n` (needs start ≤ bound and integrality: phase 2).
- The ring cursor `% M`, `i <= N - 1`, offset indices (range facts: phase 2).
- `for…of`, `forEach`, `reduce` (emit-built loops: phase 3).
- New optimization passes of any kind. If a cell does not close by normalization,
  write down which reader rejects the normal form and stop there.

## Verify, in this order

1. `node test/index.js spellings perf-ratchet` after each rewrite: the cells you
   expect, and no others, move.
2. `npm test` (splits over cores, a few minutes).
3. `npm run test:matrix` (default, opt0, opt3, wasi).
4. `npm run test:generated` (fuzz against Node, WAT populations, ratchet, gate).
5. `npm run test:self`: the new source must stay inside the subset the compiler
   compiles itself in (AGENTS.md: an index into a Number reads as a pointer; ask
   `Array.isArray` before indexing a child).
6. Results equal Node's on every spelling of every probe kernel at the default and
   speed levels (the gate's check (a) does this; a difference is a miscompile, report
   it with the smallest source, never list it as a gap).

## Report

Per rewrite: gate cells closed (by style), ratchet deltas per category, lines added
and removed under `src/`, the readers whose lists shrank. What did not close and which
reader stopped it (file:line). Anything in this design that was wrong.
