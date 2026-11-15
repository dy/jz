# The exception edge

Not a phase of `.work/architecture.md`: a class of wrong answers on main, in every release
from v1.0.0 to v1.0.3, found on 2026-11-15 while reviewing phase 7. Commit this file as
`.work/exception-edges.md` in your first commit.

`SCRATCH` below is
`/private/tmp/claude-501/-Users-div-projects-jz/36e8fd26-a3d4-48ec-97bb-7106b08fda8d/scratchpad`.

## The rule that is broken

jz emits a `try` as a `try_table` whose catch clause names a block; the handler is the code
after that block's end (src/compile/emit/statements.js, 'catch' and 'finally': read both
first). A finalizer is emitted once for each way out of its body: the normal copy inside
the block, the handler's copy after it, another before each `return`.

1. **A catch clause is a branch to its label from every point of the body that may
   throw.** What holds at the handler is what held before the body and nothing in the
   body ends. Nothing the body or the normal copy of a finalizer computed holds there.
2. **A local the handler reads is live through the whole body**, and holds at the handler
   whatever the body had written when it threw: not what the body's end leaves, not what
   stood before it.

Walkers that read `br`, `br_if` and `br_table` as the only branches break the first; a
liveness that seeds only the body's end breaks the second.

## What is confirmed (each run by the integrator on main 9ff7eb3d5, six levels, against Node)

`node SCRATCH/scoutcheck.mjs <tree>` runs them; `node SCRATCH/scoutcheck.mjs <tree> h1 reuseLoads`
runs one with a pass off. On main: 24 of 42 checks differ.

| | where | program (in scoutcheck.mjs) | Node | jz | levels |
|---|---|---|---|---|---|
| h1 | src/optimize/reuse-loads.js `targets` | a field read in a finalizer after a throw | 10.25 | 1.75 | 2, 3, size, speed |
| h2 | src/optimize/settled-tests.js `branchesTo` | a test in a finalizer the body's write changed | 1005 | 102000 | 2, 3, size, speed |
| h3 | src/compile/cse-load.js `CONTROL` (no try, catch, finally) | a read after the throw and again in the finalizer | 36.25 | 4.25 | 2, 3, size, speed |
| h4 | src/optimize/liveness.js at `try_table`, read by loop-compact.js | a list the handler reads, set again after the loop | 350350003 | 394084694 | 2, 3, speed |
| c6 | src/compile/plan/integral-loops.js | a local written either side of a call that throws, read by the handler, in a loop | 33009 | 33066 | 2, 3, speed |
| e4 | the emitter: a `return`'s copy of the finalizer runs inside the try's own `try_table` | a `return` under a handler and a finalizer that throws: the finalizer runs twice | 101 | 102 | every level |

Already fixed on this branch: src/optimize/forward-checked.js `targets` (c32cc3eaf), with
`test/finalizer-population.js`. Fixed by another writer on another branch, not yours:
optimize/numbering.js (it replaces reuse-loads.js and cse-address.js when phase 7 lands;
fix reuse-loads.js here all the same, main has it until then).

The scout's report with its reading of forty files is `SCRATCH/scout-catch/` (its probes
`h1.js` to `e4.js`, `c1.js` to `c7.js`, a fuzzer `fuzz.mjs`, a grid `grid1.mjs`, the logs)
and the table at the end of this file. It is model output: its HOLE rows the integrator
ran; its CLEARS, BAILS and NO STATE rows nobody checked. Treat them as where to look.

## What is wanted

1. **One reader of "what leaves to this label"**, a catch clause among the branches
   (`catch`, `catch_ref`, `catch_all`, `catch_all_ref`: the label is the clause's last
   operand; src/optimize/arena-rewind.js `BRANCHES` lists the forms). Today
   forward-checked.js, reuse-loads.js, settled-tests.js, cse-address.js and others each
   have a copy. Put it where the IR's helpers live (src/ir.js) and make the walkers ask it.
   The numbering's writer will import the same function: name it `leavesTo(node, label)`
   (whether a branch inside `node` goes to `label`) and `leftLabels(node)` (the set), and
   tell me if you choose otherwise.
2. **Each confirmed hole fixed at its cause**, as a class and not for its program: the
   liveness fix is the handler's live-in held through the body (src/optimize/split-funcs.js
   line 169 does it), which is also what pair-tests.js, extreme-guards.js and
   tested-choices.js read; the emitter's fix is a `return`'s finalizer running outside the
   `try_table` it leaves; cse-load.js and integral-loops.js read the prepared layout
   (`['catch', body, param, handler]`, `['finally', inner, cleanup]`): say what each
   decides at a try and why that is the rule above.
3. **Each suspect settled**: flow-range.js (a handler never walked after `br`),
   jump-pointers.js (the same), forward-hops.js `deadResets` (a liveness of its own),
   split-slots.js `shareSplitSlots` (lifetimes by text order), licm.js `cseScalarLoad`
   (right only because the emitter puts a `br` after every normal way out). For each: a
   program that differs and its fix, or the line that shows it cannot.
4. **The fuzzer's other differences.** Its seeds that differ at level 0 are the emitter's
   (156, 164 reduced to e4's family; 203 another shape, unreduced). Reduce each family,
   fix it or list it with its smallest program. One compile error, `'f1$p8' is not in
   scope` at levels 3 and speed, showed only in a process that had compiled other
   programs: a compile-state leak (AGENTS.md says how to tell one). Reduce it; fix it if
   the fix is small, list it with a reproducer if not.
5. **The population.** `test/finalizer-population.js` is the worked example: read it and
   its header. Grow it, or add `test/handler-population.js` beside it in the generated
   suite: the shapes of the scout's grid (a value, a store, a test, a local's write in the
   body before the throw, in the normal copy, in a handler; read in the handler's copy and
   after the statement; in a loop and not; a `return` in the body; the throw from a
   callee), a module to a program, six levels, and a seeded slice of the fuzzer if it
   still finds what the grid does not. Every fix has a program there that fails with the
   fix taken out: show it for each (a scratch worktree with the one fix reverted; do not
   edit a tree something is running on). A population whose first form put twelve
   programs in one module passed with its fix out: a module to a program.

## The rules

- **Base.** Your worktree starts at main. First: `git merge --ff-only populations` (tip
  9a6971aa5: main, five fixes, the held-out lane, the populations). Link the modules:
  `ln -s /Users/div/projects/jz/node_modules node_modules`. Never `npm install`.
- **Soundness before speed, and both measured.** These passes may only do less around a
  try. Bench bytes by hash before and after (`node SCRATCH/benchhash.mjs`, compared by
  `SCRATCH/bhcmp.mjs`; read both): name every case that moves and why. For each that
  moves, time it: the least of sixty alternating rounds, a process each, with a
  byte-identical case beside it as the control (`sh SCRATCH/alltimes.sh <base-tree>
  <new-tree> 60 <tag> <cases>`); eight rounds decide nothing on this machine. watr,
  jessie and the self-compile are the cases with handlers.
- **The compiler compiles itself.** Compiler source stays in the subset AGENTS.md
  describes; `npm run test:bootstrap -- --full` before you hand back, and the hosted
  build's bytes beside main's 37,145,851.
- **Checks before hand-back:** `npm test`, `JZ_DEBUG_INVARIANTS=1 npm test`, the
  generated suite native and under `JZ_TEST_HOST=wasi`, `npm run lint:imports`,
  `npm run audit:files`, the bootstrap, `node SCRATCH/scoutcheck.mjs <your tree>` at 0
  differ. One suite at a time: three writers and a battery share fourteen cores. Write
  the load beside any time.
- **Not yours:** src/optimize/numbering.js does not exist here; do not write it. Do not
  restructure passes beyond what the rule needs. A defect you find outside the class:
  its smallest program in the hand-back, no fix.
- **Git.** Stage files by name (`git add -- path`), never `-A` or `.`; no push, no pull,
  no repo-wide `checkout`, `reset`, `stash`, `clean`. The owner is the sole author: no
  co-author line, no tool's name in a message. A subject says what changed, as the log's
  do. No em-dash anywhere. No `pkill` by pattern: stop your own children by pid.

## Hand-back

First: what is not done, what you did not verify, where you were wrong. Then a table:
defect, cause in a line, the commit, the program in the population, shown to fail without
the fix or not. Then the suspects, each settled how. Then bytes and timings with their
controls and loads, the hosted build's bytes, and every check with its count.

## The scout's table (unchecked but for the HOLE rows)

HOLE: reuse-loads.js (lines 45-50, 60, 77), settled-tests.js (28, 118, 125, 134),
compile/cse-load.js (82, 350), liveness.js (54-59) through loop-compact.js (59).
CLEARS: forward-store.js (access.js 48-49, 129-140; line 189), cse-address.js (218,
222-226), static-scratch.js (220, 286), forward-hops.js hop walk (262, 273, 204),
guard-defs.js (7, 17), licm.js cseScalarLoad (1081, by the emitter's `br`),
split-funcs.js (169), arena-rewind.js (462), int-narrow.js narrowFlagLocals and
narrowBoxedLocals (301-306, read only).
BAILS: int-range.js (833), float32.js (227), word-ranges.js (216), const-bases.js,
specialize.js (352, 358), wide-accumulator.js (97-98), still-loads.js (53),
unroll-trips.js (87), quiet-loops.js (73), skip-latches.js (235), sink-stores.js (48,
95), carry-stores.js (133), early-stores.js (43), extreme-guards.js, relaxed-extremes.js,
search-loops.js, ring-laps.js, lead-gathers.js, shift-remainder.js, vectorize/prefilter.js
(116), pair-iterations.js (40), reduce.js (67), access.js (48), addr-model.js (about 740).
NO STATE: effects.js, cells.js, globals.js, nan-canon.js, fold.js, peephole.js,
to-int32.js, mask-operands.js, trunc-choice.js, share-quotients.js, unsigned-div.js,
devirt.js, recurse.js, rotate-loops.js, select-bits.js, unswitch.js, pointer-exits.js,
vectorize/hoist-splats.js, lift.js, outer-scaffold.js, func-inspect.js, inline-tiny.js.
SUSPECT: flow-range.js (116), jump-pointers.js (306-313), forward-hops.js deadResets
(356), pair-tests.js, extreme-guards.js, tested-choices.js (liveness), split-slots.js.
Not read: the bodies of devirt.js, unswitch.js, guards.js, recurse.js, select-bits.js,
pointer-exits.js, lead-chains.js, issue-order.js, most of vectorize/, licm.js
hoistInvariantLoop, loop-rewind.js, watr-tail.js and the tail passes, src/compile/plan/
but integral-loops.js, and watr's optimize.js but its `try_table` lines (it names catch
clauses at 3205, 4738, 5083, 6091-6250, 6301; no difference reduced to it).
