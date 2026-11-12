# No node compared or keyed by its JSON text

A soundness class found on the way (`.work/architecture.md`, "Found on the way
(2026-11-11)"). Not a phase of the plan: one bounded change, to land before phase 5
moves every file under `src/optimize`.

## The state (measured on the landing of 2d; measure again)

- `grep -rn "JSON.stringify" src module jzify` names about 140 lines. About 35 of them
  compare two AST or IR nodes, or key a map by one. Among them: `optimize/ring-laps.js`
  `same`, `optimize/early-stores.js`, `optimize/forward-store.js` `keyOf`,
  `optimize/pair-tests.js`, `optimize/peephole.js`, `optimize/guards.js`,
  `optimize/unswitch.js`, `optimize/sink-stores.js`, `optimize/devirt.js`,
  `optimize/vectorize/{alias,hoist-splats,dot-slp,ramp,stencil,addr-model,per-pixel-color,
  tone-map,lift,counter-run}.js`, `compile/loop-divmod.js` `same`,
  `compile/plan/counted-loops.js` `same`, `compile/plan/integral-loops.js`,
  `compile/loop-recurrence.js`, `compile/twin-locals.js`, `compile/analyze/val-types.js`,
  `static.js`, `type/{canonical-bounds,loop-versioning}.js`, `type/interval-proof.js`
  `sameNode`. The list is a grep's, not a census: the census is yours.
- JSON text writes `NaN`, `Infinity`, `-Infinity`, `null` and `undefined` all as `null`,
  and `-0` as `0`. Two nodes that differ only there are one node to these comparisons.
- `src/ast.js` `nodeEqual` (watr's `structuralKey`) tells them apart, and runs in the
  self-hosted compiler. Some files already use it (`vectorize/access.js`, `map.js`, …).
- One live defect of the class is fixed on `main`: `compile/plan/alias.js` took
  `let x = null; if (c) x = undefined` for one definition. A 152-program probe of pairs
  of such constants in loops, tests and bindings
  (`SCRATCH/jsonkey.mjs`, run with `node jsonkey.mjs <repo>`) finds no other. That is a
  probe: it does not show the other sites sound.

## The outcome

1. No comparison and no map key of an AST or IR node, anywhere under `src`, `module`
   or `jzify`, takes two nodes that differ in a NaN, an infinity, null, undefined or the
   sign of a zero for one.
2. A check fails when a new one appears. The uses that are not of nodes (messages,
   custom sections, debug output, source literals, keys made of names) are what it
   allows, each by a reason it states.
3. For every site: either a source whose answer or bytes the conflation changed, with a
   regression test, or the reason no node with such a leaf reaches it. The report lists
   each.

How is yours to decide from the code: one key function, one equality, a cheaper form
where a site is hot.

## The rule that must keep holding

- Every module's bytes are what `main` emits, at every level and on either host, except
  where a conflation is removed; each exception is shown with its smallest source.
  Write the differential first and run it on `main` (`SCRATCH/p4-review.mjs` compiles
  about 1,100 programs a round over levels, hosts and flipped pass flags and compares
  bytes; `SCRATCH/sizes.mjs` does the bench corpus).
- A case whose bytes move is timed against its base, paired
  (`JZ_BASE_ROOT=<base worktree> JZ_BENCH_BUILD_DIR=<scratch dir> node bench/bench.mjs
  --cases=<ids> --targets=jz,jz-base --paired=8 --no-web --json=<scratch file>`; 16
  rounds for a case within 4% of 1). The landing of 2d moved 8 bytes of one case and
  doubled its time.
- Compile time not above today's. `structuralKey` is JavaScript where `JSON.stringify`
  is native: measure your own baseline first, alternating base and new by CPU time
  (the machine is shared and loaded), and where a key is hot say what it costs.
- The compiler compiles itself (`npm run test:self`).

## Rules of work

- General means general: no bench, corpus program or spelling is special-cased.
- Work only on your worktree branch; first `git rebase main`. Link the modules with
  `ln -s /Users/div/projects/jz/.claude/worktrees/bump-subscript/node_modules node_modules`
  (subscript 10.8.3; the main checkout holds 10.8.2 on disk until its owner repairs it) and the conformance suite with
  `ln -s /Users/div/projects/jz/test/test262 test/test262`; stage neither. Never
  `npm install` in a directory you did not make. Never push. Never run repo-wide
  `checkout`, `reset`, `stash`, `clean`, `restore`. Stage files by name. No attribution
  lines in commits. No em-dash.
- No other agent writes this repo while you work. The integrator may land a fix on
  `main`: rebase before you report.

## Verify, in this order

1. Your byte differential, and the probe above.
2. `node test/index.js spellings perf-ratchet audit-regressions`.
3. `npm test` before a commit that claims the outcome, then `npm run test:matrix`,
   `npm run test:generated`, `npm run test:self`, one at a time
   (`JZ_TEST_TIMEOUT=10800000` if a leg hits the hour on the loaded machine).

## Report

First line: the model you are. Then: the key and the equality (file:line); every site,
with what it compared and what you found for it (a defect with its source, or why none
reaches it); the check and what it allows; bytes that moved and why, and the time of
each case they moved in; compile time before and after with the method; lines added
and removed under `src/`. What in this brief was wrong. What you ran and what you
inferred.
