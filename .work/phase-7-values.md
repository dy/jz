# Phase 7: one answer to what a call does, where an address points, what ends a value

Part of `.work/architecture.md` (phase 7: "Value passes on the index (numbering,
redundancy, constants, memory)"; done when "the forwarding and reuse files are deleted,
ratchet not above today's"). Read first: the plan's "Target" and "Phases", "5a landed:
the pass table", "The index of phase 5b, measured before it was built", "Decisions
taken"; then `.work/maps/value-passes.md`, a scout's map of the value passes on
3420027ce (inventory, kill rules side by side, alias assumptions, what each pass is worth
in bytes, overlap with watr, the tests that pin each). The map is a scout's: leads, not
facts. What the integrator ran again is marked below.

`SCRATCH` below is
`/private/tmp/claude-501/-Users-div-projects-jz/36e8fd26-a3d4-48ec-97bb-7106b08fda8d/scratchpad`.

## What the map shows

Sixteen value passes and about as many beside them (3,627 lines in the sixteen) each
answer three questions for themselves:

1. **What does a call do.** Five closures over one call graph in jz
   (`collectReachableGlobalWrites`, `collectReachableMemoryWrites` in
   `optimize/globals.js`, `collectStillFuncs` in `forward-hops.js`, `writers` in
   `forward-checked.js`, `collectHeaderSafeFuncs` in `licm.js`), a sixth in watr, and
   beside them hand lists of runtime helpers that disagree: `INERT_CALLS` (4 names),
   `SAFE_OFFSET_CALLS` (7), `KEEPS_STORAGE` (4, with `$__mkptr` and without `$__len`),
   sink-stores' `HEADERS` (3), `READONLY_MEM_CALLS`, `NON_MUTATING_CALLS`, `pureKernel`,
   `isPureFnCall`, `noReturnCall`, forward-hops' `LOWERINGS`.
2. **Where an address points.** Nine address models, three of them copies of
   `accessOf`; regions told apart by the emitter's `mem` marks in three passes, by a
   local's name in one, by `distinctParams` in two, by a whitelist of kinds in one.
3. **What ends a remembered value.** A kill rule per pass (the map's table 2a): a
   `$math.*` call kills a cached load in five passes and not in two; `global.set` ends a
   cached memory value in three and not in one; "which store can write a header" has
   four answers.

Where two answers differ, one is a missed optimization or a wrong result. One was wrong
(run again by the integrator on main and on the 1.0.3 tag): **a host import that calls
an export back**. `collectReachableGlobalWrites` said an import writes no global, so
`promoteGlobals`, `hoistGlobalPtrOffset` and `hoistLoopGlobalPtrOffset` kept a copy of a
global across the call (`g * k + g; cb(); g * k + g` read the old `g` at the default
level and at `speed`; a typed-array global replaced by the export read the old buffer at
`size` too). Fixed ahead of this phase on your base (the commit before this brief: a
callee outside the module writes what any function writes, the answer the memory closure
already gave; `test/interop.js` "a host import that calls an export back"; the
population `SCRATCH/reentrypop.mjs`, 36 of its first 60 programs wrong before the fix).
What the fix gives up: a function that calls the host keeps no copy of a global at all.
12 of 105 bench cases move at `speed` and none at `size` (`main` beside `env.logResult`
and `performance.now` loses one promoted global in cam16 and hct; the runtime's
`__json_val` beside `__ext_json` reads `$__jgaplen` each time). The copy could be taken
again after each such call, as `forwardHops` resolves its hop again after a call that
may move a block: that is a generation per global, which is 7c's numbering, not 7a.

A numbering laid over this would be the tenth address model and the seventh closure.
So the phase is three steps, each a landing of its own:

- **7a, this brief: one effects summary.** What a call does, asked in one place.
- 7b: one address form and one set of memory regions (what a load or a store touches).
- 7c: one value numbering over both, run where the passes run today; the forwarding
  and reuse files become uses of it and are deleted.

Do 7a. Do not start 7b or 7c: the integrator reviews and lands 7a first, and briefs the
next from what it leaves.

## 7a: the outcome

1. **One summary of effects, solved once per module** (a file of its own under
   `src/optimize`; the name and the shape are yours). For each function, what calling it
   may do, each as the readers of today need it and no finer: the module globals it
   sets; the memory it writes (today's readers ask: any at all; through which typed
   global; a header word or only element payloads); whether a block may move (an array
   grown or forwarded); whether it allocates; whether it returns; whether control can
   reach the host (an import, a `call_indirect`, a `call_ref`). One fixpoint over the
   call graph (`collectReachableGlobalWrites` already condenses the cycles and solves on
   the DAG with bitsets: that engine is the one to keep and widen, not to write again).
   **A name outside the module is the host: it does everything any function of the
   module can do.** An unknown wasm target does the same. A function added after the
   solve (a specialized copy, a helper a pass outlines) is either solved again or
   answered as unknown; say which and why, and show no pass reads a stale row.
2. **The runtime helpers' effects come from their bodies**, by the same solve, wherever
   the body is in the module when the summary is built. A hand entry remains only where
   the body does not show the fact (a kernel the vectorizer adds after the solve; "this
   store writes only a header word"; "never returns"), each with its reason in one
   table, and a test checks every hand entry against the helper's body where a body
   exists (a helper listed as writing no memory holds no store in anything it reaches).
   The ten lists above become that table or go.
3. **Every pass asks the summary.** The five closures are deleted; no file under
   `src/optimize` walks the call graph for itself (a lint or a test says so, as
   `lint:imports` says no file there imports `ctx.js`). What jz vouches to watr for
   (`opts.pure`, the call kinds in `watr-tail.js resolveWatrOpts`) is read off the same
   summary. watr's own closure stays watr's (the plan: "watr stays generic").
4. **The differences the map lists are settled, each to the true answer**, and each
   change of bytes that follows is named with its cause:
   - D2 (`$math.*` kills a cached load in five passes): a pure kernel writes nothing.
   - D3 (four lists of header-reading calls): one fact per helper.
   - D4 (which stores can write a header word). `HEADER_STORE_FREE` rests on "jz writes
     every array or typed header word with `i32.store`". Make that a check that runs
     (under `JZ_DEBUG_INVARIANTS` or a test over every store the emitter and the runtime
     helpers write), or find the store that breaks it.
   - D7 (`global.set` and a cached memory value): a global is no memory.
   - D11 (`forwardStores` drops `S1` in `S1; guard; S2` to one slot, the guard a
     `$__throw_*` call: `inertFor` in `vectorize/access.js`). Memory outlives the
     activation, so a caller's `catch` that reads the slot would see `S2`'s old value
     missing. The scout tried three programs and reached none. Settle it: reach it (a
     TypeError a helper throws between two stores to one slot of an object or a typed
     array the catching caller holds; a throw in a callee; a getter), or say what makes
     it unreachable and put that in the code where the next reader finds it. If it is
     reachable it is a wrong answer in 1.0.3 as well: report its smallest program first
     in the hand-back.
   A difference you find beside these is treated the same way: the true answer, in the
   one place.
5. **Fewer lines under `src/` than you began with**, counted, or the reason.

How is yours to decide from the code. Two things to settle by measurement and say in
the report: what the solve costs on the heavy units against the five it replaces (the
census in "The index of phase 5b": the function stage is 15 to 17% of a compile, the
module stage under 2%); and whether one summary can serve both sides of watr (the tail's
`postGlobalPtr` and `forwardChecked` build closures again after `watOptimize` replaced
every function's array) or is solved twice.

## The rules that must keep holding

- **Sound first.** `node SCRATCH/reentrypop.mjs <tree> 400 1` and with seeds 2 and 3: no
  program wrong (it prints the first six with their source). Extend it where you widen
  the summary: an import that calls an export which grows an array the caller holds,
  which allocates, which throws and is caught by the caller, which writes a typed
  array's elements in place, which replaces a closure cell's value; a closure handed to
  the host and called back. The scout's `SCRATCH/scout-7/repro/memfuzz.mjs` and
  `memfuzz2.mjs` (aliasing through `subarray`, out-parameters, rings) stay at no
  mismatch. Each new test fails with its fix taken out; say that you ran it so.
- **A byte that moves is named and timed.** Bench bytes by hash at `size` and `speed`
  (`node SCRATCH/benchhash.mjs <tree> > out.jsonl`, compare with `SCRATCH/bhcmp.mjs`;
  your base's rows are `SCRATCH/bh-imp.jsonl`), the 70 examples at level 2, `size` and
  `speed` (`SCRATCH/exsize.mjs`, `exsizecmp.mjs`; base `SCRATCH/exsize-imp.jsonl`). The
  expectation is few: the closures mostly agree where the corpus goes. For each case
  that moves: the function, the pass, the cause, and paired timing in alternating
  rounds, a process each (`sh SCRATCH/casetimes.sh <before> <after> 6 <tag> <case>...`
  for bench cases; `sh SCRATCH/lkalt.sh` and `fixedalt.sh` for examples: read their
  headers). Slower is not landed. The machine is shared and loaded (see below): a
  timing taken under load is said to be so.
- **The claims are the bar** (`AGENTS.md`, "Performance claims"): general answers, no
  case named in a pass, no bench or example source changed.
- **The hosted compiler**: source in its subset (prepare refuses `delete` on a static
  key; an index into a Number reads a pointer; see `AGENTS.md` "Verify before claiming
  done" and `src/optimize/pass-table.js`'s header on records and closures), and a
  hosted build's bytes before and after (`npm run test:bootstrap -- --full` prints
  them; your base built 36,972,556 bytes before the import fix).
- **Tests that pin a closure or a list by name** move to the summary with their
  meaning kept; a test that compared jz with the host stays as it is. No optimize flag
  is deleted in 7a (the map, part 6: a deleted flag turns each "with and without" test
  into `Unknown optimize key`); the flags go with their passes in 7c.
- Not yours to edit, other writers hold them now: `src/compile/plan/**` (counters),
  `src/optimize/vectorize/**` but `access.js`'s call lists (the loop description, 6b;
  if a list you replace lives in a file there, change that list alone and say so),
  `src/optimize/config.js` and `bench/**` (the exact lane, 9a), the peephole and fold
  rule files `src/optimize/peephole*.js`, `fold.js`, `fused-rewrite*.js` (phase 8). If
  the summary needs a change in one of them, write the change you need in the report
  and leave the file.

## Verify

Focused files as you build (`npm test -- interop passes optimizer forward-hops
hoist-loop-global` and what you touch); then once, at the end: `npm test`; `npm run
test:matrix`; `JZ_TEST_OPTIMIZE=3 JZ_DEBUG_INVARIANTS=1 node test/index.js`; `node
test/index.js --suite=generated`; `npm run lint:imports && npm run audit:files`;
`JZ_SELF_BUILD_TIMEOUT=3600000 npm run test:bootstrap -- --full` (the last landing broke
the self-compile and neither its writer nor its reviewer had run one); the populations;
the bytes. The machine has 14 cores and four other writers and a battery on it, load 30
to 50: one long run at a time, `JZ_TEST_JOBS=4`, and a `SIGTERM` build exit is the time
limit, not a failure. The battery of every leg is the integrator's after the hand-back.

## Working rules

Your own worktree with `node_modules` symlinked to the main checkout's, never `npm
install`; scratch under `SCRATCH/p7a/`; commits by class with their tests, files staged
by name, messages in the repo's voice (`git log` shows it) with no agent or tool named,
no co-author line and no em-dash; never push, never a repo-wide git command
(`checkout`, `stash`, `reset`, `clean`, `switch`, `restore .`); a permission refusal is
an answer, not an obstacle: say what was refused and go on with what is left. Do not
edit a tree while a measurement runs on it.

## Report

Your model id first. Then: the commits; the summary as built (its fields, who reads
each, what keeps a row true as passes add functions); the helper table (derived, by
hand and why, the check); each closure and list deleted; D2, D3, D4, D7, D11 and any
other difference, each with what was done; every bench case and example whose bytes
moved, with cause and timing; lines under `src/` before and after; hosted bytes; the
solve's cost; what you did not do and what you did not verify.
