# Phase 6c: a lift is a lowering chosen by cost, and a reduction lifts exact

Part of `.work/architecture.md` (phase 6: "Vectorizer legality from induction facts and a
dependence test, if-conversion; recognizers become cost choices", done when "the
fixed-order recognizer list is gone; no corpus cell loses SIMD"). 6a made legality one
(`vectorize/legality.js`), 6b made the loop one (`scaffold.js describeLoop`, `readExit`,
`readStep`). This step makes the choice one: a recognizer is a lowering of a described
loop, and which lowering a loop takes is decided by what each costs, not by the order of
a list. Read `.work/phase-6b-loop-facts.md` and the plan's sections "6a landed", "The
loop's facts, measured for 6b" and the integration's notes first.

`SCRATCH` below is
`/private/tmp/claude-501/-Users-div-projects-jz/36e8fd26-a3d4-48ec-97bb-7106b08fda8d/scratchpad`.

## The outcome

1. **One chooser.** Each lowering declares what it takes (in terms of the description
   and the legality's answer) and what it costs and saves on the loop in hand
   (`cost-model.js` is where that lives today, in part). The vectorizer asks every
   lowering that can take the loop and emits the cheapest; the chain in `index.js`, its
   order, and the retries that exist because one recognizer shadows another are gone. A
   lowering that never wins on any of the 423 units at level 2 or `speed` is deleted,
   named with its count.
2. **Exactness is a property of a lowering, not of a spelling.** Since the float
   relaxations became one option (`optimize.relaxedFloat`, on at `'speed'` alone), the
   one-statement dot `s += a[i] * b[i]` runs scalar at the default level, while the
   two-statement spelling (`const x = a[i] * b[i]; s = s + x`, `for…of`, `forEach`,
   `reduce`) takes an exact lift: the products two at a time, added in source order.
   The cost of that, measured (level 2 before and after, alternating rounds): dotprod
   2.00x, matmul 2.46x, stdlib-ddot 2.15x, poly 1.67x of the time. And the lane at
   JavaScript's floats, `jz-exact` (`'speed'` with `relaxedFloat: false`), trails a
   strict wasm rival where the relaxed one led: stdlib-ddot 2.52x of rust-wasm's time,
   mat4 1.18x, matmul 1.17x of AssemblyScript's (a local run under load; CI is the
   record). So: every reduction a lowering reorders has an exact lowering beside it
   (the elementwise work in lanes, the carried operation in source order; a product, a
   sum of products, a norm, a polynomial's Horner step where the lanes allow one), taken
   where `relaxedFloat` is off, whatever the statement count. Done when the spelling
   gate's dot cells at level 2 carry no `simd: lost`, and `jz-exact` is behind no strict
   wasm rival on those three cases; or, where an exact JavaScript lowering cannot match
   what the rival emits, the rival's wasm for the kernel is read (rustc 1.95 and `asc`
   are local; `bench/_lib` builds each lane) and the report says what it does.
   `SCRATCH/p9a/pop.mjs` (93 programs: sums, dots, norms, products, extrema, scans over
   NaN, the infinities, both zeros, overflow, subnormals) stays bit for bit with Node at
   `false`, `true`, `'size'` and the exact build: it is this outcome's gate, extend it
   with every form you add.
3. **The refusals of the census, each lifted on the general path or listed with what
   forbids it** (`.work/maps/loop-census.md`; the 6b brief's "Not this step"): a call in
   the body where the callee has a lane mirror (which calls the 1,241 loops hold is not
   known: count them first); the general map's decline where a store's width differs
   from its load's (298 of 513 declines); a carried local that is a reduction (325
   carried, some of them); `a[i] * 2` over an integer array, a Number in an integer lane
   (row 6); a strip that can never run (`facts.trips` below the strip's width:
   stdlib-ddot's remainder loop is lifted for nothing today); a bulk copy counting down;
   a clamped store as a saturating narrow; an outer strip over rows with their own
   ranges (bench/spmv, whose earlier lift was wrong: "Found reviewing 6a"). The last two
   only if they fall out of the chooser; say so if not.
4. **The private re-derivations go**: the general map's own `aliasGuards` (blind to
   direction: it declines in-place recurrences counting down that the legality admits);
   what divergent-escape still reads for itself where the description serves;
   `SAFE_OFFSET_CALLS` at `scaffold.js` (the one reader left of a list phase 7a
   replaced: ask the effects summary, `optimize/effects.js`, a call of kind pure or
   header); and `reduce.js`'s header, which says a reordered float sum is acceptable "in
   JS engines either": it is not, the text is wrong, the option's README entry is right.
5. **Fewer lines under `src/optimize/vectorize` than you began with**, counted, or why
   not. The shape-pin tests of a recognizer you delete go with it, replaced by cells of
   the coverage table or the spelling gate (the plan's phase 10 rule).

## The rules that must keep holding

- **The one legality gates every lift**, and a new lowering is a new way to reverse an
  order: `node SCRATCH/vecdep.mjs <repo>`, `vecnarrow.mjs` (two differ by the README's
  "Bitwise operands under 2^63" and no others), `vecalias.mjs`, `vecwrong.mjs`,
  `udiv.mjs`, `sh SCRATCH/popbattery.sh` (its header), the repo's `vector-legality`,
  `vector-dependence`, `vector-coverage`, `loop-forms`, and 9a's population above, all at
  what they are or better. Each new test fails with its change taken out; say you ran it
  so.
- **No loop lifted today loses its lift**: the census takers before and after over the
  423 units at level 2 and `speed` (`SCRATCH/p6b/instrumentation-6b.patch` and
  `instrument.py`; keep the instrumentation out of the commits).
- **A byte that moves is a lift taken, and a lift taken is faster or it is not taken.**
  Bench bytes by hash at `size` and `speed` (`SCRATCH/benchhash.mjs`, `bhcmp.mjs`), the
  70 examples at three levels (`exsize.mjs`, `exsizecmp.mjs`); base rows are written as
  you start: `SCRATCH/bh-int.jsonl`, `SCRATCH/exsize-int.jsonl`. For each case that
  moves: the loop, the lowering, and paired timing (`sh SCRATCH/casetimes.sh <before>
  <after> 8 <tag> <case>...`, then `node SCRATCH/ctmin.mjs SCRATCH/ct-<tag>` for least
  and median; `fixedalt.sh` for a page). A lowering that measures slower is declined in
  the cost model, said so.
- **The claims are the bar** (`AGENTS.md`): general techniques, no case named in a pass,
  no bench or example source changed.
- The hosted compiler: source in its subset; `JZ_SELF_BUILD_TIMEOUT=3600000 npm run
  test:bootstrap -- --full` once at the end, the hosted build's bytes before and after.
  Compile time at `speed` not above today's on webaudio, stdlib-special, stdlib-dists,
  decode-wav (alternate base and new, five rounds).
- Not yours, other writers hold them: `src/optimize/vectorize/access.js` and every value
  pass under `src/optimize` outside `vectorize/` (phase 7b: the address model moves);
  `src/optimize/effects.js` (read it, do not change it); `bench/**`,
  `test/bench-claims.js`, `.github/**` (phase 9b); `src/compile/plan/**`. If you need a
  change in one of them, write it in the report and leave the file.

## Verify

Focused files as you build; once at the end, one at a time: `npm test`; `npm run
test:matrix`; `JZ_TEST_OPTIMIZE=3 JZ_DEBUG_INVARIANTS=1 node test/index.js`; `node
test/index.js --suite=generated`; `npm run lint:imports && npm run audit:files`; the
bootstrap; the populations; the bytes; the census. Two other writers and the
integrator's battery share the machine: `JZ_TEST_JOBS=4`, and say which timings were
taken under load. The battery of every leg is the integrator's after the hand-back.

## Working rules

Your worktree, `node_modules` symlinked, never `npm install`; scratch under
`SCRATCH/p6c/`; commits by class with their tests, files staged by name, messages in the
repo's voice with no agent or tool named, no co-author line and no em-dash; never push,
never a repo-wide git command (`checkout`, `stash`, `reset`, `clean`, `switch`,
`restore .`); a permission refusal is an answer: say what was refused and go on. Do not
edit a tree while a measurement runs on it.

## Report

Your model id first. What is not done or not verified, first. Then: the commits; the
chooser as built (what a lowering declares, how costs compare); each lowering kept,
merged or deleted with its takers; the exact lowerings and the three cases against their
strict rivals; each refusal of outcome 3 with its test or what forbids it; coverage
table and takers before and after; every bench case and example whose bytes moved with
its timing; lines before and after; hosted bytes; compile time.
