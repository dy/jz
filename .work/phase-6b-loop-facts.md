# Phase 6b: the loop's facts reach the vectorizer, and the forms it refuses lift through them

Part of `.work/architecture.md` (phase 6; "Phase 6 measured before it was designed", "6a
landed", "Found reviewing 6a"). Read those first, then `.work/phase-6a-legality.md` (what
6a built and the rules that still hold), `.work/maps/loop-facts.md` (what the emitter
knows of a loop and what reaches the optimizer), `.work/maps/loop-refused.md` (seventeen
loop forms, the first check that refuses each) and `.work/maps/loop-census.md` (which
refusals occur in the 423 units). The maps are a scout's: leads, not facts.

6a made legality one. This step makes the loop one: what a recognizer is offered is a
counted loop described by facts, not a WAT shape matched back out of the emitter's
output. The third step (6c: recognizers as lowerings chosen by cost, the chain and the
private re-derivations retired) is not this one; do not start it.

A step lands before this one: counter widths ("The examples gate: rfft below V8 since
October"), which proves words many of the counters this brief's first row counts as
f64. The figures below are from before it; the brief is revised on what it leaves.

`SCRATCH` below is
`/private/tmp/claude-501/-Users-div-projects-jz/36e8fd26-a3d4-48ec-97bb-7106b08fda8d/scratchpad`.

## The state (the scout's figures on cdc3b0711; measure again on your base)

- The emitter records a link per loop it writes (`compile/emit/control-flow.js`,
  `compile/loop-model.js loopFacts`): counter, the counter's hull, the step's magnitude,
  the bound's range. It computes and drops the start, the bound's shift (`i + K < n`),
  the step's sign, the exit comparison as written. The vectorizer takes one value of
  the link, the counter's name; everything else it matches from WAT
  (`vectorize/scaffold.js matchBlockLoop`: a top exit of the form `eqz(i <s bound)`, a
  unit ascending i32 step as the last statement, a pure `local.set` preamble).
- 74% of the loops the vectorizer visits carry a link (4,240 of 5,719 in user code);
  `forEach`'s loop (`ir/arrays.js walk`), loops a pass builds and the retry on rewritten
  counters carry none.
- Of 5,159 loops with a load or a store, 1,318 have no scaffold. The refusals a fact of
  the emitter's reaches: a counter still an f64 where the vectorizer runs (252 loops in
  54 units; `narrowInts` is later in the table), a descending step (138 in 110 units), a
  constant step other than 1 (68 in 55), `<=` (20), a step by an invariant (8).
- Kernels refused though nothing forbids them (`SCRATCH/vecalias.mjs` with
  `SIMD_COUNT=1`, `loop-refused.md` rows 1 to 6, 11, 12, 15, 16): a bound of `i + 1 <
  n` and the three-point stencil with it; a descending loop; a step of 2; a counter or a
  local read after the loop; `<=` and `!==` bounds; two counters at `speed` (the loop
  arrives unrolled by two: `compile/loop-recurrence.js stepOf` does not read the
  normalized `++k`); an in-place mirror; a do-while.
- The spelling gate (`test/spellings.json`) lists five cells that lose SIMD: the
  descending loop (four) and two counters at `speed`.

## The outcome

1. **One description of a counted loop**, built once per loop and handed to every
   recognizer and to the legality: its counter, start, bound, step with its sign, exit
   comparison, the trip count where it is a value, and the body. From the emitter's
   link where there is one, held true to the vectorizer (the passes between rewrite an
   operand in place; say for each fact what keeps it true and check it under
   `JZ_DEBUG_INVARIANTS` as the counter's name is today); matched from WAT only where
   there is none, and those loops (`walk`, the loops passes build) get a link or are
   listed with why not. No recognizer matches an exit test or a step for itself: the
   scout counts four private exit matchers and four step matchers beside the shared
   pair.
2. **The forms above lift**, each through the description and the one legality, not by
   a recognizer per form: a counter the emitter knows is a word though its local is an
   f64; a descending counter; a constant step past 1; a bound shifted by a constant;
   `<=`; a start other than the loop's own (`let i = 0` before the `for`); a counter or
   a local every iteration writes, read after the loop (landed, as the legality asks);
   the two-counter loop at `speed`. Each either lifts on the general path or is listed
   with what forbids it (a true dependence, a float reduction the README does not
   license).
3. **Gates that are tables.** The coverage table of `vecalias.mjs` (28 kernels by five
   element types by three views) joins the repo beside the spelling gate and may only
   grow; the five `simd: lost` cells of `test/spellings.json` go; the scout's seventeen
   rows are tests where they lift.

How is yours to decide from the code. Two questions the maps raise and do not answer,
to settle by measurement and say in the report: whether the f64 counter is better met
by narrowing the counter ahead of the vectorizer or by the description carrying "a
word"; and whether a descending loop lifts as reversed lanes or as the mirror address
form `tryVectorize` already has for f64.

## The rules that must keep holding

- **6a's legality is the gate of every new lift.** `node SCRATCH/vecdep.mjs <repo>`
  (683 programs), `vecnarrow.mjs` (1,000; two differ by the README's "Bitwise operands
  under 2^63" and no others), `vecalias.mjs` (450), `vecwrong.mjs`, `udiv.mjs`, and the
  repo's `vector-legality` and `vector-dependence` stay at what they are. Extend the
  generated population with every form you admit (descending and strided two-site
  loops at distances around a strip, in both statement orders): a new form is a new
  way to reverse an order.
- **No loop lifted today loses its lift.** The census rows before and after over the
  423 units at level 2 and `speed`
  (`SCRATCH/loop-facts/instrumentation.patch` and the runner beside it; keep the
  instrumentation out of the commits).
- **A byte that moves is a lift taken, and a lift taken is faster or it is not taken.**
  For each bench case and example whose bytes move: the loop, the taker, and paired
  timing (`sh SCRATCH/casetimes.sh <before> <after> 6 <tag> <case>...`). A new lift that
  measures slower is a cost question: decline it there (`cost-model.js`), say so.
- **The compiler reasons; the source gives no hints** (`AGENTS.md`): no bench or
  example source changes, and a fix that serves one named case is the wrong fix.
- The hosted compiler: source in its subset, a hosted build's bytes before and after.
  Compile time not above today's on `webaudio`, `stdlib-special`, `stdlib-dists`,
  `decode-wav` (alternate base and new, five rounds).
- No recognizer merged or deleted and no private lift body rewritten: 6c. What 6b may
  delete is what the one description replaces: the private exit and step matchers.

## Not this step, listed for 6c from the census

A call in the body (1,241 loops: which calls is not known); a nested loop (604); the
general map's decline where a store's width differs from its load's (298 of 513); a
call with no lane mapping (244); a carried local (325, of which some are reductions);
an outer strip over rows with their own ranges (bench/spmv); a clamped store as a
saturating narrow.

## Verify

`npm test`; `npm run test:matrix`; `JZ_TEST_OPTIMIZE=3 JZ_DEBUG_INVARIANTS=1 node
test/index.js`; `node test/index.js --suite=generated`; `npm run lint:imports && npm run
audit:files`; `npm run test:self`; the populations above; bench bytes by hash
(`SCRATCH/benchhash.mjs`, `bhcmp.mjs`); the census rows. One battery at a time. The long
legs are mine after the hand-back.

## Working rules

As 6a's: your own worktree with `node_modules` symlinked, never `npm install`; scratch
under `SCRATCH/p6b/`; commits by class with their tests, files staged by name, messages
in the repo's voice with no agent or tool named, no co-author line and no em-dash; never
push, never a repo-wide git command; a permission refusal is an answer.

## Report

Your model id first. Then: the commits; the description as built (its fields, where
each comes from, what keeps each true); each form of outcome 2 with its test or what
forbids it; the coverage table before and after; takers before and after; every bench
case and example whose bytes moved with its timing; hosted bytes; compile time; what you
did not do and what you did not verify.
