# Counter widths: a loop's integers held as words where a test at run time shows what no proof can

A step between 6a and 6b of `.work/architecture.md`. Read there "The examples gate: rfft
below V8 since October" and "Counter widths, measured before they were designed", then
the scout's five reports: `.work/maps/counter-removed.md` (what two soundness fixes of
2026-10-01 took away and why they were right), `counter-deciders.md` (every place that
decides a local is an i32, in pipeline order), `counter-rfft.md` (rfft's `transform`
local by local, and the inputs for which an i32 answers wrongly), `counter-census.md`
(252 loops whose counter is an f64, by cause, with the smallest source of each),
`counter-guards.md` (entries and trips of rfft's loops, what a test costs where). They
are leads, not facts: read each line you build on.

`SCRATCH` below is
`/private/tmp/claude-501/-Users-div-projects-jz/36e8fd26-a3d4-48ec-97bb-7106b08fda8d/scratchpad`.
The scout's reduced programs, its tree of `e88a8e907` (the last commit that held these
locals as words, unsoundly) and its instrumentation are in `SCRATCH/counter-widths/`.

## The state (the scout's figures on 557fbd525; measure again on your base)

- A local is a word by proof alone: its lifetime hull is a closed signed word, or it is
  an integer and no read observes its magnitude (`compile/analyze/body-facts.js
  widenLocalTypes`, the decision at its end). Before October a local was also a word
  for being compared, or for feeding an index. That was wrong (`x *= 65536; a[x]` read
  `a[0]`) and is not coming back in any form: a use is not a proof.
- `examples/rfft` pays for it: in `transform` the index locals `i`, `ix`, `id`, `i0`,
  `i1`..`i8`, `si`, `j` are f64 (163 `trunc_sat`, 51 `f64.lt` at `speed`), and the
  example runs at 0.64x of V8 on the M4 (14.9 us against 9.7; 9.4 us at `e88a8e907`,
  5.1 in June). It is the one failure of `examples/bench.mjs`'s gate here.
- **No proof exists for these locals, with or without a bound on `N`.** For `N >= 2^31
  - 1` the first pass's `id *= 4` leaves the word; for `N >= 3 * 2^29 - 1` `i0 += id`
  does; for `N >= 2^29` the stage loops' `ix = (id << 1) - n2` does. Node answers each
  (or loops, as JS says), `e88a8e907` answered otherwise. So what makes them words on
  the path a real call takes is a test at run time, or nothing. And under a test of `N`
  alone the interval proof still cannot close `id` and `ix`: they grow geometrically
  and are bounded only through the test of another variable (`ix < N` with `ix = 2 *
  (id - 1)`).
- The planner already tests at run time (`compile/plan/integral-loops.js
  versionIntegralLoops`): `if (tests) { integer copy } else { the loop as written }`,
  the tests on names the loop does not write, evaluated where the loop statement was,
  an inner version's tests taken by the enclosing copy. In `transform` it versions the
  bit-reversal loop and the `j < count` nest and nothing else: a `while` gets a copy
  only if its counter advances by a literal-bounded amount (`maxAdvanceBudget`), which a
  step by the name `id` and a write like `ix = 2 * (id - 1)` are not.
- Over 423 units, 252 loops with a load or a store have an f64 counter where the
  vectorizer runs (it refuses each before any recognizer). By cause: the bound has no
  range, 117 (a parameter or a Number derived from one 54, a field or call of an
  unknown receiver 34, a module binding 24); the hull ends a step or a sum past the
  word, 45 (`i <= n` over a word; a difference of two words); the counter starts from
  or is updated by an f64-typed expression, 49 (rfft's); a side counter no test names,
  16 (`bits++`); not an integer, 6; a step by a name, 4; closure bodies, 14; one other.
  With every loop test's bound assumed inside the word (an emulation of a test on the
  bound, an upper bound on what one reaches) 139 of the 252 become words: 102 of the
  117, 28 of the 45, 2 of the 49.
- What refuses a copy today, for those: "nothing to version" (the bound read is not a
  stable name, or the bound is already a word and `<=` needs one less, or every name is
  an integer of unknown size, which is neither a word nor a candidate), a nested loop
  with no bound of its own, the size and growth budgets, no entry at all (a side
  counter; loops made after the planning sweep; closures).
- `transform`'s loops at N = 2048: 1,213 entries, 5,865 trips. The innermost `i0`
  loops of the twiddle nest are entered 652 times for 1,252 trips. The test the planner
  emits today is 55 operator nodes, one innermost trip 240: a test at each entry of
  that loop is about 12% of it, at the `j` loop's entry 0.2%, at the function's entry
  nothing.

## The outcome

1. **rfft's index locals are words on the path every real call takes**, and
   `examples/bench.mjs` passes on the M4: rfft at 0.9x of V8 or better, the aim above
   1x. Say what sound code reaches and what still separates it from June's 1.89x.
2. **The census row drops, by class, not by case.** Each of the causes above either
   reaches words through one rule or is listed with what forbids it: a bound with no
   range; a hull a step past the word; a counter that starts from a Number, is stepped
   by a name or is recomputed in the body; a side counter. Not integers (6) are out.
   Closure bodies and loops made after the planning sweep: say what it would take.
3. **Soundness is run, not argued.** The inputs of `counter-rfft.md` as tests, in
   reduced programs with a trip cap where Node itself does not end; and a generated
   population in the repo's generated suite (starts, bounds and steps at the word's
   edges and past them, 2^31 - 1, 2^31, 2^32 - 1, 2^53, a non-integer, NaN, a negative,
   -0, Infinity; `<`, `<=`, `>`, `>=`, `!==`; a counter read after the loop; a bound or
   a step the body writes; a `break` and a `continue`; nests) against Node at levels 0
   to 3, `size` and `speed`. The integrator runs its own, written without reading yours.

## The mechanism is yours. One candidate, to refute or adopt by measurement

The planner's copy today takes names the loop does not write and tests them once. What
rfft needs is names the loop does write. A copy can take those too if it runs only
while they are where the proof was made:

- Run the interval proof of one trip of the loop under an assumption about the head:
  each name the copy would hold as a word lies in a box. If every write of a held name
  in the trip, inner loops included, is then a word, the copy is valid for any trip
  that starts in the box.
- The box test joins the copy's loop condition. When it fails the copy leaves at a
  head, writes its names back, and the loop as written takes over from that state. A
  loop head is a state both forms share, so the hand-over needs no proof of its own. A
  test with an effect (`while ((nn = nn >>> 1))`) must not run twice on the way.
- A name the loop's own test bounds costs no test per trip. A name the loop does not
  write is tested once, where the planner tests today, and hoists as today. In
  `transform` that leaves `ix` and `id` to test per trip of the `ix` loops (688 trips
  at N = 2048), and `N`, `n2`, `n4`, `j` where they do not change.
- The width of the box comes from the proof (the widest for which the trip's writes
  are shown words), never from an example.

It needs no relation between `id` and `ix` and no trip count, and it is not rfft's: it
is "an integer of unknown size, written in a loop". Whether it is right is yours to
find: against carrying such a name in an i64 (`optimize/int-narrow.js` does it after
the fact, within 2^52, after the vectorizer has run), against a trip-count fact for the
side counters and `si` (a uint32 halved each trip runs 31 trips at most), against
whatever the code shows you. What it must not be: the old assumption in another coat; a
relational proof that serves one recurrence; a test at every entry of an innermost
loop where a hoisted one serves.

## The rules that must keep holding

- **Every program answers as Node does at every level.** The two fixes' tests
  (`test/index-width.js`, `test/integral-loops.js`, `test/inference.js`,
  `test/optimizer.js`, `test/wat-invariants.js`) stay as they are; a test that must
  change is a finding to report, not an edit.
- **The compiler reasons; the source gives no hints** (`AGENTS.md`): no bench or
  example source changes; a rule that serves one named case is the wrong rule.
- **A byte that moves is a copy made, and a copy made is faster or it is not made.**
  Bench bytes by hash before and after (`SCRATCH/benchhash.mjs <tree>`,
  `SCRATCH/bhcmp.mjs`; the base's rows are `SCRATCH/bh-le.jsonl`): at `size` nothing
  moves (the pass is off there). For each case whose bytes move at `speed`: the loop
  and paired timing (`sh SCRATCH/casetimes.sh <before> <after> 6 <tag> <case>...`). The
  examples: `node examples/bench.mjs` on base and new, alternated twice, compared by
  `node SCRATCH/exbcmp.mjs <base logs,> <new logs,>`. A copy that measures slower is a
  cost question: decline it where the pass keeps its budgets, and say so.
- **The size claim**: `node scripts/bench-size.mjs`, every case strictly smaller than
  AssemblyScript's (`test/bench.js`, "strictly smaller"); it failed once on loops
  emitted twice (47103b716). The pass's budgets (`MAX_SIZE`, the growth budget) stay
  budgets.
- **6a's populations stay at what they are**: `node SCRATCH/vecdep.mjs <repo>`,
  `vecnarrow.mjs`, `vecalias.mjs`, `vecwrong.mjs`, `udiv.mjs`; the repo's
  `vector-legality` and `vector-dependence`. A counter that becomes a word opens loops
  to the vectorizer that it refused before: every such lift passes `legal()`, and no
  loop lifted today loses its lift (the census rows before and after over the 423
  units at level 2 and `speed`: `SCRATCH/loop-facts/instrumentation.patch` and the
  runner beside it; keep the instrumentation out of the commits).
- **The hosted compiler**: source in its subset (`AGENTS.md`, "Verify before claiming
  done"), a hosted build's bytes before and after. Compile time not above today's on
  `webaudio`, `stdlib-special`, `stdlib-dists`, `decode-wav` (alternate base and new,
  five rounds).

## Not this step

The loop description of 6b and the vectorizer's scaffolds. `off` and `count` (a typed
element read that may miss: presence, not width). ulam and lenia on x64. The slow drift
of rfft before October.

## Verify

`npm test`; `npm run test:matrix`; `JZ_TEST_OPTIMIZE=3 JZ_DEBUG_INVARIANTS=1 node
test/index.js`; `node test/index.js --suite=generated`; `npm run lint:imports && npm run
audit:files`; `npm run test:self`; the populations and gates above. One battery at a
time. The long legs (the full bootstrap, integration, test262, the one-process run) are
the integrator's after the hand-back.

## Working rules

Your own worktree with `node_modules` linked (`ln -s /Users/div/projects/jz/node_modules
node_modules`), never `npm install`; scratch under `SCRATCH/pcw/`; commits by class with
their tests, files staged by name, messages in the repo's voice with no agent or tool
named, no co-author line and no em-dash; never push, never a repo-wide git command
(`checkout`, `reset`, `stash`, `clean`, `switch`, `restore .`); a permission refusal is
an answer, not an obstacle to route around.

## Report

Your model id first. Then: the commits; the mechanism as built and what keeps it sound,
with the candidate above adopted or refuted and on what measurement; rfft's types and
times before and after; the census by class before and after; every bench case and
example whose bytes moved with its timing; the size table's closest cases; hosted
bytes; compile time; what you did not do and what you did not verify.
