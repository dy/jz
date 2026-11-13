# Phase 6a: one legality for every vector lift

Part of `.work/architecture.md` (phase 6: "Vectorizer legality from induction facts and a
dependence test, if-conversion; recognizers become cost choices"). Read that first, then
`.work/maps/vectorize.md` (what each recognizer proves, line by line),
`.work/maps/vectorize-leads.md` (nine programs that answer wrongly, and about thirty
leads nobody ran) and `.work/maps/vectorize-census.md` (the ablation and the spelling
gate). The maps are a scout's: leads, not facts. The nine programs are facts: I ran them.

Phase 6 is three steps. This is the first: no lift reaches the output unless one
legality, the same for every recognizer, holds. The second (6b) builds the loop's facts
from the emitter's induction and widens what a loop may look like; the third (6c) makes
the recognizers lowerings chosen by cost and retires the chain. Do not start them.

`SCRATCH` below is
`/private/tmp/claude-501/-Users-div-projects-jz/36e8fd26-a3d4-48ec-97bb-7106b08fda8d/scratchpad`.

## The state (measured on d50ccbfbf)

- `src/optimize/vectorize/`: 28 files, 10,613 lines. `vectorizeLaneLocal` (`index.js`)
  offers each `(block (loop))` to 13 recognizers in a `??` chain, then a retry on
  rewritten counters, then `gateStrips`, `tryPrefilter`, `tryPairIterations`.
- Nine plain programs differ from Node at levels 2, 3 and `speed`
  (`node SCRATCH/vecwrong.mjs <repo>`: 27 differing checks of 54). The published 1.0.2
  answers the same nine wrongly. With the vectorizer off all nine are right.
  - W1 `tryReduce` (bit-exact tier): a local each iteration writes, read after the loop,
    lives only in a vector temp.
  - W2 `tryRampMap`: a counter stepped twice an iteration is stepped by the lane count
    twice.
  - W3 `tryRampMap`: a store under a condition is stored unconditionally.
  - W4 `tryRampMap`: `>> 16` lifted to a 16-bit lane shift, whose count is taken mod 16.
  - W5 `tryToneMap`: the first store of a conditional arm is lifted unmasked.
  - W6 `tryDivergentEscapeVectorize`: a scalar the outer body rewrites each pixel is
    broadcast once per strip.
  - W7 `tryVectorize`: `a[63 - i] = a[i]`, one array.
  - W8, W9 `tryVectorize`: `a[2 * i + 2] = a[2 * i] + 1`, and the stride of 4.
- The cause is one: legality is each recognizer's own. The scout's hand census counts,
  beside the shared helpers, 4 private exit matchers, 4 step matchers, 9 address
  matchers, 8 write censuses, 6 first-access classifiers, 5 alias tests, 5 lift bodies.
  `gateStrips` (`alias.js`) tests every lift, but skips a pair of sites on one base
  (`alias.js:285`, "the lift's own dependence test"); of the 13, two call `aliasGuards`,
  three have a test of their own, six have none. Seven steps never ask what the
  continuation reads (`outsideReads`).
- What holds today: two views of one buffer at any distance, five element types, 28
  kernels, six levels: `node SCRATCH/vecalias.mjs <repo>`, 450 programs, 596,700 checks,
  0 differing. Its kernels are unit-step loops over two bases; it has no kernel shaped
  like the nine.
- The lowerings are worth keeping: 589 loops lifted at `speed` and 425 at level 2 over
  423 units (bench, examples, the perf corpus, the spellings); with only the general
  map, stencil and reduce left, 350 of 587 lose their lift. What becomes one is the
  legality, not the lowering.

## The outcome

1. **One legality, a function of the scalar loop and of how many iterations a strip
   runs together, never of the recognizer.** No lift is emitted unless it holds; a
   recognizer that proves nothing lifts nothing.
   - Memory. For every two memory sites of the loop of which one is a store (a store
     against itself across iterations included), same base or not: no two iterations one
     strip runs together touch the same bytes in an order the strip reverses. The strip
     runs site A for all its iterations before site B when A comes before B in the
     body's evaluation order, so with A before B and "A in iteration j and B in
     iteration j + k touch the same bytes": k = 0 keeps the order, k > 0 keeps it, |k| at
     or past the strip's iterations never meets, and k < 0 inside the strip is the
     reversal (W8: load `a[2i]` before store `a[2i + 2]`, k = -1). `a[i] = a[i + 1] * 2`
     is k = +1 and stays lifted. No constant k (W7, steps that differ, an index the loop
     writes): decline, or the run-time test today's code already makes (`aliasGuards`'
     hoisted distance, `apart`, `below`). A lift that does not keep the body's order of
     sites says so and is held to the order it makes.
   - Locals. Every local the loop writes is one of: an induction, stepped by the lift
     exactly as an iteration steps it, every step of it counted (W2); a reduction the
     lift carries and merges; a local every iteration writes before it reads, which
     nothing after the loop reads; or one the lift leaves holding what the scalar loop
     leaves (W1). Anything else declines (W6). The recognizer says which is which; the
     gate checks that against the loop and fails closed.
   - What a private lift carries out. A store, a trap or a call that an iteration
     reaches under a condition is reached under that condition in the strip, or the
     lift declines (W3, W5); an operation lifted to a narrower lane means there what it
     meant in the scalar width (W4). No gate sees these: they are held by reading each
     of the five private lift bodies against what the shared lifter (`lift.js`) refuses,
     and by programs.
2. The nine programs answer what Node answers at every level, each fixed at its class:
   W7 to W9 by the one dependence test, W1 and W6 by the one account of locals, W2 to W5
   where the matcher accepts what its lift does not carry out, with the class stated and
   searched (every lane shift narrowed from a wider one, every scaffold variant's steps,
   every private arm).
3. Every lead of the last row of the table in `vectorize-leads.md` (the scout's working
   files are `SCRATCH/vec-census/map-parts/group1.md` to `group3.md`) ends as one of: a
   program whose answer was wrong, fixed, with its test; a program that reaches the
   recognizer and answers right, with the check that makes it right named; or shown
   unreachable from source, with the reason. "Compiled scalar" proves nothing: say which.
4. Tests in the repo. Each wrong program is a named core test. A generated population
   of dependence-shaped loops (two sites at `c * i + k` on one base and on two, a mirror,
   strides 1, 2, 3, 4, both orders of load and store, a second store, a conditional
   store, a local read after the loop, a counter stepped twice, a scalar the body
   carries; five element types; trip counts around a strip) joins the generated suite,
   compared with Node at every level and with the vectorizer off. Seeds:
   `SCRATCH/vecalias.mjs`, `SCRATCH/vecwrong.mjs`, `SCRATCH/vec-census/leads-mod.mjs`,
   `SCRATCH/harness.mjs` (it runs each program in a worker it can stop).

How is yours to decide from the code.

## The rules that must keep holding

- **A check that passes changes no byte.** `node SCRATCH/benchhash.mjs <repo> > f.jsonl`
  and `node SCRATCH/bhcmp.mjs base.jsonl f.jsonl` (base of d50ccbfbf:
  `SCRATCH/bh-fh-final.jsonl`, the same bytes): a bench case whose bytes move holds a
  loop the legality declined. List each with the loop, the dependence or local that
  declined it, and a program that shows the old lift wrong. A decline you cannot show
  wrong is a defect of the legality: make it prove more, do not accept the loss.
- **Every loop lifted today stays lifted by the same taker**, but those of the line
  above. The census instrumentation (`SCRATCH/vec-census/instrumentation.patch`, with
  `run.mjs`, `child.mjs`, `corpus.mjs`, `analyze.mjs` there) writes one row per loop
  with its taker over the 423 units; run it before and after at level 2 and at `speed`
  and compare rows. Keep the instrumentation out of the commits.
- `node test/index.js spellings` passes with `test/spellings.json` as it is, but for a
  cell a wrong lift held.
- No new lift here: a descending loop, a step of 2, a shifted bound, a local landed by
  a last scalar iteration, a mirror versioned at its midpoint are 6b. No recognizer
  merged or deleted, no private lift body rewritten onto the shared one, the chain's
  order as it is: 6c. Where a private lift lacks a guard, add the decline and the test.
- One check where one serves: no copy of the dependence test per recognizer. A private
  alias test that the one legality now covers goes, when the bytes do not move.
- The compiler compiles itself: the source stays in the subset the hosted compiler runs
  (`AGENTS.md`, "Verify before claiming done"), and a hosted build's bytes are measured
  before and after.
- Compile time not above today's on the slow units (`webaudio`, `stdlib-special`,
  `stdlib-dists`, `decode-wav`): alternate base and new, three rounds, say the figures.
- Bench sources, example sources and existing tests' expected values are fixed inputs.

## Verify

`npm test`; `npm run test:matrix`; `JZ_TEST_OPTIMIZE=3 JZ_DEBUG_INVARIANTS=1 node
test/index.js`; `node test/index.js --suite=generated`; `npm run lint:imports && npm run
audit:files`; `npm run test:self`; `vecwrong.mjs` and `vecalias.mjs` at 0 differing; the
bench hashes; the taker rows. One battery at a time, nothing overlapping. The long legs
(`test:bootstrap -- --full`, integration, test262) are mine after the hand-back.

## Working rules

- Your own worktree; symlink `node_modules` (and `test/test262` if a leg wants it) from
  `/Users/div/projects/jz`, never `npm install`. Scratch files under `SCRATCH/p6a/`.
- Commit by class, each commit with its tests, files staged by name. Commit messages
  say what changed and why in the repo's voice: no agent or tool named, no
  co-author line, no em-dash. Never push, never a repo-wide git command (`checkout`,
  `reset`, `stash`, `clean`, `switch`, `restore .`).
- A permission refusal is an answer: do not work around it; say it in the report.

## Report

Your model id first. Then: the commits; the legality as built (where it sits, what it
takes, what each recognizer now says to it); for each of the nine, the class, the check
and the test; the table of leads with its three endings; takers before and after; bench
cases whose bytes moved; hosted bytes; compile time; every `test/spellings.json` cell
changed; what you did not do and what you did not verify.
