# Phase 7b and 7c: one address, one set of regions, one numbering

Part of `.work/architecture.md` (phase 7, done when "the forwarding and reuse files are
deleted, ratchet not above today's") and the second and third steps of
`.work/phase-7-values.md`. 7a answered what a call does (`optimize/effects.js`, which
every pass asks). Two questions are still answered per pass: where an address points,
and what ends a remembered value. Read the phase 7 brief, `.work/maps/value-passes.md`
(sections 2b, 2e and 5: the alias assumptions, the nine address models, what a single
design must cover), the plan's "The index of phase 5b, measured before it was built",
and the integration's notes on 7a.

`SCRATCH` below is
`/private/tmp/claude-501/-Users-div-projects-jz/36e8fd26-a3d4-48ec-97bb-7106b08fda8d/scratchpad`.

Two steps, in this order, in one hand-back: the commits of 7b complete and green by
themselves (so they can land if 7c is held), then 7c on top.

## 7b: the outcome

1. **One address form.** An access reads as `base + index * scale + constant` through
   one reader, canonical: two addresses that are equal compare equal whatever the order
   of the add, the tee or the copy that carries them. Today nine models answer
   (`vectorize/access.js accessOf`/`resolveAddr`/`windowDefs`, the widest; early-stores'
   and carry-stores' copies of it; reuse-loads' local name; forward-hops' `boxRoot`,
   `offsetRoot`, `wordRoot`; licm's `baseParamOf`; globals.js' `memAddress` and
   `globalBaseAliases`; cse-address's shape key; const-bases over `wordRanges`). Every
   pass asks the one; the copies are deleted. `vectorize/access.js` is yours for this
   (the vectorizer's writer leaves it alone); the vectorizer's own `linearIndex`
   (`vectorize/alias.js`, the dependence distance in lanes) stays the vectorizer's and
   may ask yours.
2. **One set of regions.** What an access touches, as (kind, identity, byte range): an
   array's elements by allocation cell, an object's fields by slot and layout set, a
   typed buffer by its base's value and by what the plan proved distinct
   (`distinctParams`, `freshTypedGlobals`), a header word (length at -8, forward at -4),
   a module global by name, a closure cell, static data, the host. One `mayAlias` over
   them (today `ir/mem-alias.js` over the emitter's `mem` marks, and a rule beside it in
   each pass). The marks reach every reader: the map's D10 counts them dropped before
   they are read (fusedRewrite 648 of 17,797, forwardStores 531, foldLoadCasts 950), so
   a pass that rebuilds a load or a store carries its region, and under
   `JZ_DEBUG_INVARIANTS` an access that had a region and lost one fails the step that
   lost it.
3. **The differences settled to the true answer**: D5 (reuseLoads cannot see `$a2 =
   $a`), D6 (forwardStores assumes same-base slots at other offsets disjoint whatever
   the offsets, the others compare bytes), D8 (what a store of one width does to a
   remembered value of another). A difference you find beside these the same way.

## 7c: the outcome

1. **One numbering of a function's values**: an operation by its code, type and
   immediates over its operands' numbers; an address in the one form; a load by region
   and generation, the generation moved by what writes the region (a store by region and
   bytes, a call by the effects summary, a `global.set`); a local by its definition; a
   loop's back edge, a join, a guard that dominates (the map's 5a to 5c list what each
   pass relies on today: version per definition, copies, tees, the DAG where one node
   has two parents, values available only under a test).
2. **The passes that are redundancy by another name become uses of it and their files
   are deleted**: reuseLoads, cseScalarLoad, hoistPtrType, hoistPtrOffset, hoistAddrBase
   (five walks over one skeleton), the forwarding half of forwardStores, the numbering
   inside forwardChecked, foldStaticArrReads, settledTests. It runs where they ran:
   before watr, where the emitter's regions exist, and after it, over what the inliner
   brought together (watr's own `valueNumber` stays watr's: the plan, "watr stays
   generic"). Whether it is profitable to keep a value in a local is a cost question
   apart from whether two values are equal (today: two sites a region, no reuse out of a
   deeper arm): keep the two apart.
3. **The passes a numbering does not subsume stay code and ask the same address,
   regions and effects**: the loop-carried ones (sinkStores, carryStores, leadGathers,
   stillLoads, forwardHops), the factoring ones (shareQuotients, selectArms,
   truncChoice, testedChoices), the backward ones (nanCanon, the dead-store drop), the
   schedulers (leadChains, issueOrder, earlyStores), constBases, poolFloats. A pass that
   changes no function of the 423 units at level 2, `size` or `speed` is deleted with
   its flag and its shape tests, named with the count; the scout's list at `speed` alone
   was cseScalarLoad, hoistInvariantPtrOffset, hoistPtrOffset, truncChoice, leadChains,
   foldStaticArrReads, postGlobalPtr, promoteCells (it used digests of each step's
   input and output: `SCRATCH/scout-7/`, the instrumentation in its `tree`). A pass that
   fires only on its own tests' programs is not dead if the program is one a user
   writes: say which, and add the shape to a gate instead.
4. **Flags and tests.** A deleted pass's flag goes; a test that compared jz with the
   host with and without it keeps its meaning under the numbering's flag (one flag for
   the numbering or one a use: decide and say). Shape pins of a deleted pass go; what
   they protected becomes a cell of the ratchet, the spelling gate or the coverage
   table.
5. **The gates**: the ratchet not above today's in any category on either host (a
   category that falls is re-baselined with its cause by function, as 7a's note in
   `test/perf-ratchet.js`), the spelling gate with no new gap, and fewer lines under
   `src/` than you began with, counted (7a ended 15 lines up).

How is yours to decide from the code. Settle by measurement and say: what the numbering
costs against the walks it replaces on the heavy units (the function stage is 15 to 17%
of a compile, the tail's value passes sit beside watr's fixpoint at 24 to 32%), and
whether one implementation serves both sides of watr.

## Known on your base, yours to carry

- `specializeLoops` versions a loop that is entered often and runs few rounds once a
  copy of a global stands ahead of it (jessie's whitespace scanner, polytri's ear loop,
  7a's report). The integrator's timing of both is in the integration's notes; if either
  is slower there, it is the first thing to settle: the cost question is general (a
  version pays only where the loop's rounds repay its entry test).
- Reading `valueOf` through a parameter gives NaN (7a's probe `dynNumArg`, `dynNumArr`):
  not looked into.

## The rules that must keep holding

- **Sound first.** `SCRATCH/reentrypop.mjs <tree> 400 <seed>` for seeds 1 to 3,
  `SCRATCH/scout-7/repro/memfuzz.mjs` and `memfuzz2.mjs`, `SCRATCH/p7check.mjs`,
  `p7more.mjs`: none wrong. A population of your own for the numbering: a store
  forwarded to a load through views that overlap by `subarray` and by offset, through a
  call that may throw between two stores to one slot (7a's D11), around loops and joins,
  across widths; every program against Node at six levels. Each new test fails with its
  change taken out; say you ran it so.
- **A byte that moves is named and timed**: bench bytes by hash at `size` and `speed`,
  the 70 examples at three levels; base rows `SCRATCH/bh-int.jsonl`,
  `SCRATCH/exsize-int.jsonl`. Per case that moves: the function, the cause, paired
  timing in alternating rounds (`casetimes.sh`, `ctmin.mjs`, `fixedalt.sh`). Slower is
  not landed.
- **The claims are the bar** (`AGENTS.md`): general answers, no case named, no bench or
  example source changed.
- **The hosted compiler**: source in its subset (no `delete` of a static key; an index
  into a Number reads a pointer; pass-table.js's header on records and closures: 7a's
  summary cost the hosted build 64 KB, 11 closures wrapped in 11 more, so measure as you
  go); the bootstrap once at the end, bytes before and after.
- Not yours, other writers hold them: `src/optimize/vectorize/**` but `access.js`
  (phase 6c); `bench/**`, `test/bench-claims.js`, `.github/**` (phase 9b);
  `src/compile/plan/**`; the rows of `src/optimize/rules.js` (read by all, changed by
  none of you). What you need changed there goes in the report.

## Verify

Focused files as you build; once at the end, one at a time: `npm test`; `npm run
test:matrix`; `JZ_TEST_OPTIMIZE=3 JZ_DEBUG_INVARIANTS=1 node test/index.js`; `node
test/index.js --suite=generated` on both hosts; `npm run lint:imports && npm run
audit:files`; `JZ_SELF_BUILD_TIMEOUT=3600000 npm run test:bootstrap -- --full`; the
populations; the bytes. Two other writers and the integrator's battery share the
machine: `JZ_TEST_JOBS=4`, and say which timings were taken under load.

## Working rules

Your worktree, `node_modules` symlinked, never `npm install`; scratch under
`SCRATCH/p7b/`; commits by class with their tests, files staged by name, messages in the
repo's voice with no agent or tool named, no co-author line and no em-dash; never push,
never a repo-wide git command (`checkout`, `stash`, `reset`, `clean`, `switch`,
`restore .`); a permission refusal is an answer: say what was refused and go on. Do not
edit a tree while a measurement runs on it.

## Report

Your model id first. What is not done or not verified, first. Then: the commits, 7b's
apart from 7c's; the address form and the regions as built and who reads each; the
numbering (what a number is, what ends one, where it runs); each file deleted and each
pass kept with why; the passes that fired nowhere; D5, D6, D8 and what else differed;
every bench case and example whose bytes moved with cause and timing; the ratchet and
the spelling gate before and after; lines under `src/` before and after; hosted bytes;
compile time.
