# Handover, 2026-11-09

The owner moved the remaining compiler work to one session (jz-52). Two sessions
handed over: the integration session (branch `v1` and the batch branches) and the
decode session (the @audio/decode work, landed on main). This file holds the state
they reported and what was checked. "Reported" is their statement; "checked" was run
or read by jz-52 on the date above.

## State after the takeover (same day)

- main was fast-forwarded to `v1` (b33e45ec7). Checked before it: the stride-cursor
  miscompile below reproduces on 508428d82 (a 5-frame kernel returns 1020 against Node's
  2460 at the default and speed levels) and is gone on v1.
- v1's one red, the ratchet's slice count, was bisected by the integration session to
  f07a4a11d: the runtime's `$__gc_move` now drops dead stubs from the log as it forwards
  them, 56 loop instructions in each of the 8 slice programs that link it. Required
  work. The ratchet's file was also stale-high (float listed 1548, produced 1372), so it
  becomes an equality per host.
- The main checkout's `node_modules` held watr 5.13.3 against a lockfile at 5.13.4, and
  runs made in it were on the wrong optimizer (one `test/iteration.js` failure came from
  that, not from the compiler). Reinstalled with `npm ci`. A checkout that changes
  branch needs its install checked: `node -e "console.log(require('watr/package.json').version)"`.
- `src/optimize/liveness.js`: the 12 lines noted below were rewritten by three's next
  commit; v1's file is identical to three's tip (checked).

## Branches (as handed over)

main = 508428d82, 52 commits ahead of origin/main (6a9fbbc8f), not pushed.

| Branch | Against main | State |
|---|---|---|
| `v1` b33e45ec7 | 39 ahead, 0 behind | To land by fast-forward. Checked: main and origin/main are its ancestors. |
| `intel`, `o3`, `mem`, `minmax`, `three`, `colors`, `batch32` | 4 to 25 ahead | Reported as carried by v1 (cherry-picked, some lines superseded). Checked by added lines: of about 2,160 in the commits with no patch-equivalent in v1, 39 are absent: merged pass lists (`src/optimize/config.js`, `scripts/phase-marks.js`), the relaxed-extremes doc and check, a `pairTests` line, CHANGELOG/CONTRIBUTING lines, and 12 lines of `src/optimize/liveness.js` (three's 35ace0fcb) not yet accounted for. Delete after v1 lands and liveness.js is explained. |
| `watrbump` d631dabf2 | in main | Remove last: v1's and `/tmp/jzw/bis-wt`'s node_modules are symlinks into its worktree. |
| `perf2`, worktree `/Users/div/projects/jz-perf` | at main | Empty. Removed by the decode session with its `v-g11` scratch worktree (checked: neither is listed any more). |

Detached worktrees under `/private/tmp/jzw` (`bis-wt`, `dbg-wt`, `jzc-a`, `jzc-b`,
`main-wt`, `old-wt`): reported as scratch, delete. `dbg-wt` holds four dirty files,
reported as debug toggles.

Remote: every `origin/probe/*` branch is reported as disposable (colors, colors-ab,
colors-diag, colors-final, colors-final2, intel-1..6, mem-1, minmax-ci, minmax-x,
three, three-asm, three-ci, three-stage, three-tip, three-x, three-y, three-z, v1).
Deleting them is a push: the owner's call.

## Red

On main 508428d82 (reported; both fixed in v1):
1. Miscompile from 600b39ecb at O2 and speed. A cursor stepped by a non-literal
   stride around an inner loop indexing by it stays at its entry value:
   `for (f…) { for (i < o.n) out[pos + i] += d[i]; pos += o.h }` adds every frame at 0.
   Cause: integral-loops `hoist` admitted `cursors.has(x)`, so the inner version's
   alias `pos | 0` was taken once at the outer copy's entry. Fix 067aa3b38. Seen as
   the opt3 failure "summary: instanceof narrows a name on both sides".
2. core-wasi: 508428d82's destruct test passes a JS object. Fix b33e45ec7.

On v1 b33e45ec7:
- `perf-ratchet` slice: 230812 loop-body ops against a baseline of 230492 (CI default
  leg). Checked: the ratchet passes on main 508428d82, so one of v1's 39 commits moved
  it. Being bisected by the integration session.

Standing, same on origin/main (reported): the claims job (reference evidence stale: 30
cases missing, 58 stale rows; size against AssemblyScript on 8 cases) and the Porffor
evidence gate (alpha 13 recorded, alpha 19 required).

v1's evidence (reported): full matrix default/opt0/opt3 green locally at 067aa3b38;
integration 222 pass, 1 skip; recursive bootstrap green at 0842de6d6; CI at b33e45ec7
green on opt0, opt3, wasi, fuzz, test262, self-compile. Bench push gate at 067aa3b38,
one unpaired run: 76 strict, 3 band, 10 red, against main d631dabf2's 73, 3, 13; no
longer red hsl, worley, quatmul, threecull, threegeom; new red and unverified
wordcount (2.15× c-wasm) and gainclass (1.08×).

## Findings that were in no file

From the integration session (more in `.claude/worktrees/QUEUE.md`, untracked):
- Compile memory. The Node build of the compiler peaks near 3.2 to 3.3 GB live on v1,
  2.9 GB on d631dabf2; most of the growth comes from dd60857fd..22ef18e30. Root cause
  open. 0842de6d6 gives every Node self build an 8 GB heap, which is room, not a fix.
- The `jz` bench case's speed build: 2651 s and 9.0 GB RSS on the M4 against an 8 GB
  cap (main 7.5 GB). CI's limit is 5400 s.
- x64, not fixed. stdlib-pow: pow4's self-call stays out of line, 1.07 to 1.14× rust on
  every x64 runner. quatmul: 1.11 to 1.24× on Xeon 8573C/6973P and EPYC 9V45, leads on
  7763/9V74/8370C. crc32 against V8: the table-base-in-memarg form wins on Intel (0.98)
  and loses on AMD (0.87 → 1.00); no form leads on both.
- delayline is 1.021× slower on the M4 after o3's readInLoop: the strength-reduce pass
  now applies there.
- hwb against rust on Zen 4/5 is 1.08/1.12× and is not min/max. threegeom needs y/z
  pairing of scalar running extremes.
- A bench build made from a `/tmp` checkout (`/tmp` is a symlink to `/private/tmp`)
  misses the benchlib module override and imports `env.print`. Compare builds from one
  path only.
- CHANGELOG "Unreleased" has no lines for about 50 of the owner's commits.
- Shape-matched passes that came in with v1: `src/optimize/vectorize/ramp.js` (16-wide
  byte map) and `src/optimize/relaxed-extremes.js`.

From the decode session (its notes are `.work/decode.md`):
- Pin audit, read-only, tests not run or mutated: of the 22 decode commits 18 have
  structural pins. 414ad53dc (the counted landing `entry + K·(trips | 0)`, kind-split
  keeping a for head) has none; its only test change relaxes a negative control in
  `test/optimizer.js`. 499d332a5, 22e806bb6 and 6e46329e6 check values only.
- The class behind be07fd142: an inner loop version trusted an enclosing copy's int32
  test of a name the loop itself writes (`if (v >= 0) p += 2` past 2^31 - 1 came back
  -2147483647 for 2147483649 at O2 and speed, no counted loop involved). Pinned in
  `test/integral-loops.js`, "a cursor near 2^31 - 1 stepped in a nest keeps its value
  past the word". Any shared induction analysis keeps that test green.
- Its evidence for be07fd142, 414ad53dc, 508428d82: `npm test` 7204 pass, 1 skip;
  `test:self` 89 pass; matrix, extended, bootstrap, 262 and three not run. Paired 8
  rounds against aecdba61f at the speed tier: decode-tta 0.878× the time, webaudio
  0.981×, decode-qoa 1.043×, decode-dsd 1.020× (inside its spread).
- One kernel compile (an AIFF nest) was SIGKILLed, exit 137. Re-run alone it took 6.84 s
  and 0.6 GB peak RSS, so the session reads the kill as memory pressure from other
  processes (inference; the killed run was not measured).
- The QOA store opening, G12 showing in the plan but not in the wasm types, and
  decode-tta's grade are written up in `.work/decode.md`, "Handed over".

## Local batch branches, tips before deletion

Deleted after the landing; their content is in main by cherry-pick (checked by added
lines, see the table above). A tip can be restored while its objects are still in the
clone: `git branch <name> <sha>`.

```
96fb4fab9 intel
1a62d762d o3
54b5e6e1f mem
e2f0c0155 minmax
611fbe762 three
2d12f13af colors
62fc1e8ee batch32
```

The scratch worktree `/private/tmp/jzw/dbg-wt` (a169cb673) was removed on 2026-11-09
at the owner's word, after a check of its three modified files: the `scope.js` addition
(`unobservedStatic`) and the `frame-effects.js` guard are in main line for line, and
`inline.js` held only debug switches (`OLDS`, `OLDT`, `DBGH`).

## Remote probe branches, tips before deletion

The owner approved deleting the probe branches that have no use (2026-11-09). Checked:
each holds either `probe:` diagnostics marked not for main, or an earlier form of a
commit v1 carries. A tip can be restored while its objects are still in a local clone:
`git push origin <sha>:refs/heads/<name>`.

```
a3d50c4cb2415876c5f708011b746132f657ed74 probe/colors
ed8ae3b4ee4f18f56fb0a11453a6e06e02929a3b probe/colors-ab
cefc1321945d3553b876627480e1b0bd408d9a44 probe/colors-diag
ad49b9b9d279ddd1313a472df4108c47feb6dc7e probe/colors-final
1c14260658d33905cb414c27170da43960665b39 probe/colors-final2
ab06cc193b3b71b0c4b967c012d5a15a684b3a4e probe/intel-1
9707e1dee65d3bd1e7129907cfa673a40d0a647b probe/intel-2
ab46cc56a5ff343d04dad2d6318e253db343cba8 probe/intel-3
23e291505945bb6ae4ac12704aab69aaf6f8d656 probe/intel-4
d4df3ca365f0ade9a8dd89012a67d015e74c0870 probe/intel-5
b75321f4d3d197249e68ebb88f553113a9c3a61c probe/intel-6
54b5e6e1f4d5b3f13aa02e1af9d2fbdf3992e868 probe/mem-1
e2f0c0155ccfde746d4605486d7c0c7d328a56c5 probe/minmax-ci
13789d26fc85e62918018e32d228fc2b0f625195 probe/minmax-x
f78b03479843bca03f823dcd5b9c4679f7ccca52 probe/three
4ee428b48f8ff9670ec3a21cf6e90b68d668bbc7 probe/three-asm
f78b03479843bca03f823dcd5b9c4679f7ccca52 probe/three-ci
555903c93e6d59d4dd9dfa3297e9268caf1e932c probe/three-stage
3f8845cb329561d553e693a5fc6ff8b10f5216d7 probe/three-tip
6dba38618c397440fc45d78618b24252c56d4659 probe/three-x
84cfb634c613a3b5489a642b6eedd7897c73b916 probe/three-y
02f2a41eafd3fe8173a229c391c2bb40df841af6 probe/three-z
b33e45ec7ac0079864c622a4fabb105707b0b3e1 probe/v1
```

## Agent branches of 2026-11-10, tips before deletion

Landed on `main` by cherry-pick or fast-forward (checked: every commit's patch is in
`main`). A tip can be restored while its objects are in the clone: `git branch <name> <sha>`.

```
b8e1c2ede worktree-agent-a58529a9940a7b114   phase 2a, landed as 4329ac723..21e90c516
d19cee4b9 worktree-agent-ac6268c36a2b2510f   phase 3b, landed as d2843e18b..7b662fb90
7b662fb90 land-3b                            the landing branch of 3b, an ancestor of main
6503312a2 worktree-agent-a2d7d1a8604d1235a   phase 3c, landed as 8fe3b4c4b, 094e81fed, corrected by c956bce20
b70b0a25e land-3c                            the landing branch of 3c, an ancestor of main
108607457 worktree-agent-aab0781eee3f918ab   phase 2b, landed as 9ff0ffb2d, 7b43e61f3, 4cb52818a, 0e726f28e
0922b6a92 worktree-agent-a71932a5e8dfc1e8a   phase 2c, landed as 9ea3a640c, corrected by b0f52ced0 (the branch goes on to 2d)
b0f52ced0 land-2c                            the landing branch of 2c, an ancestor of main
69fdca41f worktree-agent-a94139a3c3b6dc7cb   phase 1b, landed as 0b3f3b09e, 69fdca41f (fast-forward)
4aaaddbc3 land-1b                            the tree 1b's batteries ran on: main's tree at 69fdca41f under other commits, not an ancestor
267ad34bb land-fixes                         eight fixes found on the way (2026-11-11), landed by fast-forward as de94b68cc..267ad34bb
```

`wasi-proc-exit` (process.exit under host:'wasi') landed as 751665c63, 803529fff,
a0638326f.

## Branches of the 2d landing (2026-11-11), tips before deletion

Checked with `git cherry` against the landing branch: every patch but the one named is
in `main`.

```
28d57ad53 worktree-agent-a71932a5e8dfc1e8a   phase 2d, landed as 9bafbb6a6 (rebased over the eight fixes, so another patch), eaf0ffabb, 1ee4305aa
080ab484c fix-oob                            the three fixes on 267ad34bb, landed as 8745d4cea, b16d106a1, 6c8338ef8; the timing base "without 2d"
dcd0f60ad land-2d                            the three fixes and 2d on 267ad34bb: the tree 2d's review ran on, not an ancestor
360770d24 land-2d-b                          the same with the subscript bump on ba71f66a6: the first full battery, an ancestor of main
642ef8a46 fix-wide                           the landing tree (the two fixes of 2d's cost in time), an ancestor of main
06a4d9cca bump-subscript                     the subscript bump, landed as 360770d24
```

Kept, not deleted:
- `worktree-agent-ad38f46bbe9197c87` (a48e8b6fe on ba71f66a6): phase 4's memo, handed
  back and held unlanded (the row of phase 4 in `architecture.md`).
- The worktree `.claude/worktrees/bump-subscript`: its `node_modules` is a real
  directory with subscript 10.8.3, which worktrees link while the main checkout's holds
  10.8.2 on disk. Remove it once the main checkout is repaired (`rm -rf
  node_modules/subscript node_modules/.package-lock.json && npm install` there).
  Repaired by the owner on 2026-11-12 (10.8.3 on disk): worktrees link the main
  checkout's modules again, and `bump-subscript` goes with the branches below.

## Branches of 2026-11-12, tips before deletion

```
32a68a16a fix-boolkey      the Boolean fix and the optional-chain and WABT fix on e245ca67e: the tree the seven legs ran on; landed as 49554075d, 7edd3de24 (cherry-picked over the example commit 0ebaad572)
e27e22a82 fix-optns        the optional-chain and WABT fix alone, the same patch as 7edd3de24
e245ca67e fix-wide         main before these fixes: the batteries' unfixed tree
726db51f8 land-b           the landing branch: the two fixes and the unused import, an ancestor of main
```

## Branches of the node-keys landing (2026-11-12), tips before deletion

```
e232efb25 land-nk                            the landing branch: the agent's four commits on 5b0a63dda and the review's three fixes, the tree the battery ran on; an ancestor of main
997ea6733 worktree-agent-aceadade46685f9fd   the node-keys agent's four commits as handed back, on 0ebaad572; landed as f9021e648, f6b4caf27, d4289e960, cf79b518f
06a4d9cca bump-subscript                     the subscript bump (landed as 360770d24); its worktree held the modules the agent's worktree linked
```

## Branches of the pass-table landing (2026-11-12), tips before deletion

```
47103b716 land-d                             the landing branch: eight commits on 6e641dbde, the tree the battery ran on; an ancestor of main
77d1d2846 fix-hosted                         the two CI fixes, the range walk (268279fc0) and the doubled loops on 6e641dbde, without the table: the base of the bench bytes; landed as f2b4a81fe, 4a7728aec, 963a49a64, 47103b716
b8d12a2bd land-c                             the two CI fixes, the agent's two commits and the facts guard: the table as first reviewed, its runners still records the table collected; superseded by land-d
5d73d262a land-5a                            the agent's two commits and the facts guard on 6e641dbde, before the two CI fixes went under them; superseded
e31f723a5 worktree-agent-af27fe75514ac7432   the 5a agent's two commits as handed back (53374f76c, e31f723a5); landed as d462f1b6e, e7e5d1fd2
b8d12a2bd worktree-agent-a7a27ad570fcecfee   the census scout's tree, land-c's tip with no commit of its own; its reports were session scratch, the plan's section on the index holds what was kept
6e641dbde land-nk                            the node-keys landing branch, an ancestor of main
```

## Branches of the 6a landing (2026-11-13), tips before deletion

```
cdc3b0711 land-e                             the landing branch: the writer's eight commits and the review's three on 6beb3dc53, the tree the battery ran on; the notes commit above it; an ancestor of main
6beb3dc53 land-d                             main before 6a: the base of the populations, the census, the bench bytes and the examples timing
07da84014 worktree-agent-a70ba6383107b4dac   the 6a writer's eight commits as handed back, on 6beb3dc53; landed as they are
93f880b86 fix-udiv                           the uint32 division fix on 21112c9aa, built beside the review run; landed as cdc3b0711 (cherry-picked)
d50ccbfbf worktree-agent-a874443978e8f17a0   the first vectorizer scout's tree, no commit of its own; its instrumentation was session scratch, its reports are `.work/maps/vectorize*.md`
cdc3b0711 worktree-agent-af1e6a4d36ea469c7   the loop-facts scout's tree, no commit of its own; its instrumentation was session scratch, its reports are `.work/maps/loop-*.md`
```

## Branches of 2026-11-14 (counter widths held, the pins, 1.0.3), tips as they stand

```
2cfadf01a fix-uext                           the counter-widths landing tree as the battery ran it: 2e9c2ffe7, the extent-guard fix (33690d097, 1267dc7a6), the writer's 3d8d3cb1c and 06d4ea856, the review's 5cf9156fc and 2cfadf01a. Held: see "Counter widths built" in the plan
2cfadf01a box-fix                            fix-uext's tip, where the writer answers the two timing defects; the integrator's trial edit (`ownValue`, `product`) was uncommitted there when it was handed over
f409da3ba worktree-agent-ac63941daac3c6ed9   the writer's two commits as first handed back (68ff8bad5, f409da3ba on 2e9c2ffe7); the branch has moved since, the writer works in it
2e9c2ffe7 land-e                             main's code before the step: the base of every timing and population of it
3d8d3cb1c (detached, worktree bis-table)     the table rule alone, cut to tell its effect from the box's: the line walk times as the base there
cd89b0b74 bench-pins                         2e9c2ffe7 and the pins (Porffor alpha 23, Bend 2.0.40, rustc 1.100.0, AssemblyScript 0.28), pushed to origin for the probe (run 43567712864); these notes go on top
6756402e0 ref-run                            the same pin commit on 2cfadf01a, superseded by bench-pins
1c78b2d3d release-1.0.3 (worktree rel-103)   v1.0.2, with its own node_modules (subscript 10.8.1, watr 5.13.2): where 1.0.3 is ported
557fbd525 worktree-agent-a9152ef4a00edbebc   the counter scout's tree, no commit of its own; its reports are `.work/maps/counter-*.md`
```

Scratch that is not in the repo and would be lost with the session directory: the
populations (`boxpop`, `boxpop2`, `boxprobe` 1 to 3, `mergeprobe` 1 to 3, `cwpop`,
`uextpop`, `udiv`, the four `vec*`), their harness, `popbattery.sh`, `battery.sh`, the
timing scripts (`exbpair.sh`, `pagepair.sh`, `pagealone.sh`, `pagefixed.mjs`,
`linekern.mjs`, `lkcount.mjs`), `relcheck.mjs`. They belong in the repo's generated
suites and `scripts/`; not moved yet.

## Branches of the counter-widths landing (2026-11-14), tips before deletion

```
afc2446f3 box-fix                            the landing tree: the uint32 extent guard, the table rule, the box, the review's fixes, the tier, its absorption, the cold mark set false; these notes go on top
2e9c2ffe7 land-e                             main's code before the step: the base of every timing and population of it
756d7282f worktree-agent-ac63941daac3c6ed9   the box writer's tree as last handed back (the tier and its absorption are cherry-picked from it)
7c5e46f01 v1.0.3 (tag)                       the release line's six commits; its branch release-1.0.3 and bench-pins are deleted on origin
```

Writers at work as this lands, each in a worktree off afc2446f3: counters by a bound test
in the planner, the loop's description (6b), the exact lane and `relaxedFloat` (9a), the
checked peephole table (8), the effects summary (7a, off the import fix `import-writes`).

## Branches of the five-hand-backs landing (2026-11-15), tips before deletion

```
acd02157e integrate                          the landing tree: main (e588b3b33) and 40 commits: the counter writer's two fixes, phase 8, 6b, 9a, the import fix, 7a and the review's four; these notes go on top
238aedd6e worktree-agent-a4519a2dc39ff972e   the counter writer's tree. Its tip is the tier that tests a counter's bound, not landed ("Counters by a bound test" in the plan); its a047f51d0 and ada395f86 are landed as fe734da8c and 260de4584
e2f689420 worktree-agent-ad228c2e8db2ec3e7   the phase 8 writer's tree, landed whole (eight commits, each patch-equal to one of the landing's)
261ced79d import-writes                      the import fix as first cut (c835d2aac, 5dff9fc29 and two briefs), landed and then subsumed by the effects summary
```

At work or held as this lands, each in a worktree off acd02157e:

```
21673f8d7 worktree-agent-af3f6d07ee6e728c6   6c's writer (the tip when this was written)
d9b70dc24 worktree-agent-a0535e0f76860e45e   7b's and 7c's writer (the tip when this was written)
9102a64c5 worktree-agent-a71b879e01b0977a5   9b handed back: the held-out lane, to land next with the five fixes its fixture led to
a48e8b6fe worktree-agent-ad38f46bbe9197c87   phase 4's memo, held by the owner's decision
```

Scratch of this landing, not in the repo, beside what is listed above: the populations
`reentrypop` (a host function that calls back), `boundwrap` (a bound that is a sum),
`tierpop`, `p7check`, `p7more`, `p8check`, `memfuzz` and `memfuzz2` (the phase 7 scout's
aliasing fuzz), the writers' `pop` (9a), `pcbpop`, `boxlenpop` and `entrypop`; the
review's harness `intreview.sh`; the timing scripts `alltimes.sh` (every bench case,
two trees), `stepbis.sh` (a case built at each of several commits), `wasmalt.sh` and
`fixedalt.sh` (a page on a fixed plan, two trees).

## Branches of the landing of the five fixes and the held-out lane (2026-11-15), tips before deletion

```
9102a64c5 worktree-agent-a71b879e01b0977a5   9b's writer's tree: 3fc396ba1 and 9102a64c5, landed as 4f74e5006 and 13f00eb3d
9b938315a (no branch, a scratch worktree)    the integrator's four fixes on acd02157e (4af3c66de, bf974bdae, 57ab7a8ae, 9b938315a), landed as 3e43a1e19, 4fa0fb34a, 8fc82cf25, 2bab745c7
```

At work or held as this lands:

```
9a6971aa5 populations                         the integrator's: the try population, the finalizer population, forward-checked.js's catch clause (on 2bab745c7)
e52d23ad5 worktree-agent-a29e352754b8f20da   the populations' ports (sixteen commits to 11f24c1ef, accepted), then at work on a hang it found: a host function that calls an export back, levels 2, 3 and speed
4524efb83 worktree-agent-a2790de10cf3d3dfc   the exception edge's writer (`.work/exception-edges.md` on that branch): six wrong answers of one class, at work
ccc68ef24 worktree-agent-af3f6d07ee6e728c6   6c's writer: its twelve commits (to e17a85616) reviewed, at work on two wrong answers of the vectorizer older than them
5d7b0c6fe land-6c                             the review tree of 6c: `populations` and the twelve commits
f5fac8880 worktree-agent-a0535e0f76860e45e   7b's and 7c's writer: handed back, fireflies 4.1% and dwa 2.5% slower by the least of sixty, unsettled
238aedd6e worktree-agent-a4519a2dc39ff972e   the tier that tests a counter's bound: not landed, the owner has not ruled
```

watr 5.13.7 (pushed 2026-11-15, the npm release the owner's) fixes `outline`, which shared
one helper between two expressions whose locals repeat at other positions (`size`); jz's
pin is 5.13.5 until it is published.

Deleted with nothing landed, on the owner's word (2026-11-15):

```
a48e8b6fe worktree-agent-ad38f46bbe9197c87   phase 4's memo (on ba71f66a6: `src/optimize/memo.js`, 490 lines, and `test/memo.js`); `.work/phase-4-compile-time.md` and the plan's row hold what it measured
```

Scratch of this landing, not in the repo: the population `trypop` (a parameter of two
kinds used ten ways in five try forms, 2,800 programs, each beside a twin with no try;
on its way into the generated suite as `test/try-population.js`, branch `populations`),
the probe of the binding split's crash, and esbuild's bundle of a CommonJS import (the
test in `test/features.js` carries its text).

## Branches of the land-c landing (2026-11-16), tips before deletion

```
5d3f9d9ae land-c                             the landing branch as the battery ran it: land-b and seven more (the hang fix, the hosted leg's three skips, the held-out lane's two, watr 5.13.7, the -o directory, subscript 10.8.4), on f7092c17b. For main it was replayed over the dataset's refresh bf4e75ff6, where it is ea0795b7d; not an ancestor of main
b49b003c9 land-b                             the populations, 6c and the exception edge on f7092c17b: the tree of the first battery, stopped after its self-compile leg; abd8fd14b on main
5d7b0c6fe land-6c                            6c on the populations, before the exception edge; superseded
9a6971aa5 populations                        the integrator's three commits and the sixteen ports' base; its last is 96ad796d7 on main
ccc68ef24 worktree-agent-af3f6d07ee6e728c6   6c's writer, landed as 49a1a75b9 to f8ec7f7fe
4524efb83 worktree-agent-a2790de10cf3d3dfc   the exception edge's writer, landed as cdb188e97 to abd8fd14b
964a137b5 worktree-agent-aa7af9dd572a6b3b7   the held-out harness's writer, landed as 7795bde16, c97822437
83f6f07bb worktree-agent-a999c751978a0f58a   phase 10's guide, eleven commits on 5d3f9d9ae, landed as b4061dd72 to a79b59c52, with f1e4472d4 after them (its pointer to the old file, renamed for main)
```

At work when this was written, each on the next landing tree `land-d` (the guide's tip
and above): `worktree-agent-a0535e0f76860e45e` (7b, 7c, the counted copy),
`worktree-agent-a8c9abf4b664de951` (the tests' comments and nine deletions),
`worktree-agent-a29e352754b8f20da` (the hang's writer: the reset of a shift, shifts as
the module starts, the store through a binding the call made; next the reset of a Map,
a Set and an object's string field). `worktree-agent-a4519a2dc39ff972e` (238aedd6e, the
counter's bound tier) is still not landed and not ruled on.

The pins: watr 5.13.7 and subscript 10.8.4, both published 2026-11-16; the main
checkout's `node_modules` holds them once `npm install` is run there (worktrees of this
session linked a directory of links to the two checkouts meanwhile).

## Branches of the land-d landing (2026-11-16), tips before deletion

```
e521f93b8 land-d                             7b and 7c, the tests' part of phase 10, the reset of a shift, shifts as the module starts and the store through a binding the call made, 29 commits on 9d0bf1ec2
9d0bf1ec2 land-c                             main as the land-c landing left it
2d83eb5a6 worktree-agent-a0535e0f76860e45e   7b, 7c and the counted copy's writer, landed as dcd903159 to 650e3f5b9 and b2dcc75c8 to 4f8e40cd1
d43bd2d0b worktree-agent-a8c9abf4b664de951   the tests' writer, landed as 185dbcd8e to 147558ec2
```

At work when this was written, each on the tree after this one:
`worktree-agent-a29e352754b8f20da` (the reset's writer): f5537a47b, five commits on
e521f93b8 (a Map's, a Set's and a dictionary's table and an object's field made at start
read as they started; the slot log deleted), checked and waiting for its battery; now on
a Map's lookups (phase 11, class C). `worktree-agent-ac3852370d29a350c` (the array
store's writer): dba289f85, nine commits on e521f93b8, checked; rebasing onto f5537a47b,
then on what an array holds (class B). The briefs for three more writers are session
scratch (`brief-gate.md`, the data-form gate; `brief-forin.md`, the for-in fact the
fixed subscript loses; `brief-ci.md`, the hosted suite split over CI jobs).
`worktree-agent-a4519a2dc39ff972e` (238aedd6e, the counter's bound tier) is still not
landed and not ruled on.

The briefs and the scouts' maps named above (`.work/phase-*.md` but 9b's, `.work/maps/`,
`counter-widths.md`, `node-keys.md`, `exception-edges.md`, `populations-port.md`) are
deleted: `git show df1f0a143:.work/<name>`.

## Branches of the land-e landing (2026-11-17), tips before deletion

```
4157cd976 land-e                             the landing branch as the checks ran it, 49 commits on 92d14e2ba; the record's commit after it
661b51a8f worktree-agent-a29e352754b8f20da   the reset's writer: C and D landed as d6e2ddad6 to 8a4fe07dc, the hang fix as 62ff8a67a, 74901a0d8, the Map finds as ad1fc6d1d to 97d520a45; its last three (the threshold after the exit test, the stress switch, a loop's first walk) were taken over by the compaction's writer
81ebe4a1e worktree-agent-a0a76341c63c68a13   the data-form gate's writer, landed as a29ec8d31
815b3c9e2 worktree-agent-a905fc21058d63473   the CI split's writer, landed as fde6cd535
7d1b37b6a worktree-agent-ae6b74456898f3f46   the lift's writer, landed as 924660154 to 656168edb (the guards change set aside, not landed)
397ccc486 worktree-agent-a951f3f2388f0c6cc   the for-in fact's writer, landed as 381e07647
e667b22fb summary-array-n-l0                 the summary test restated for level 0, landed as 4157cd976
9d0bf1ec2 land-c                             main as the land-c landing left it
```

At work or queued when this was written, each for the tree after this one:
`worktree-agent-a1be0465fdf269fbe` (the compaction's writer: 529b7d23b, three fixes of
wrong answers, the stress form, the walk's scratch by the work, the host's walk by its
threshold, a window a site); `worktree-agent-a417d57c6f092b160` (the holders: 6f2f50491,
on class B's tip e40ffa0ac; first the filled array's mark, a wrong answer this tree
has); `worktree-agent-ac3852370d29a350c` (class B's second part, e40ffa0ac, five
commits, handed back); `worktree-agent-a5f89d0c0c9d7eb2f` (the hoist's writer,
8151718b2: constants read through a temporary to land, the identity folds and the load
sinking held); `kinds-ada0` (cbed52d9b) and `decoders-ada0` (099c77415, the sums in
lanes, held for the bench's parity by tolerance) and `worktree-agent-ada0cb75ccefb0bf6`
(the relaxed floats' writer, now on comparisons); `rulings` (2df97ce3d, the tie band of
8%). `worktree-agent-a4519a2dc39ff972e` (238aedd6e, the counter's bound tier) is still
not landed and not ruled on.

The landing check ran 13 legs in a row and took over six hours before it was cut (the
owner: "anything above 1h is something wrong on our side"): its hosted suite was left to
CI's split job, which this push runs for the first time. The briefs of this landing's
writers are session scratch (`brief-lift.md`, `brief-hoist.md`, `brief-relaxed.md`,
`brief-compact.md`, `brief-holders.md`, `brief-red.md`, and for the next tree
`brief-tests.md`, `brief-lanes.md`).

## Branches of the land-g landing (2026-11-17), tips before deletion

```
39a68420f land-f                             the tree as its first check ran it (17 commits on d58dde69e); the check found the rebinding bug of 24125bd05
3ca2082ab land-g                             the landing branch as the checks ran it: land-f and three commits; the record's commit after it
4157cd976 land-e                             the earlier landing branch, kept until the audit's readers ended
2df97ce3d rulings                            the tie band, landed as 2e26b7e00
e40ffa0ac worktree-agent-ac3852370d29a350c   the element facts' second part, landed as 62c739470 to 24125bd05
```

At work or queued when this was written, each for the tree after this one:
`worktree-agent-a417d57c6f092b160` (the holders, handed back at 7306b6dec: 18c52e9fe a
receiver that may be missing joins the split, dc8898829 the gate's measure, 7306b6dec a
covering loop the split rewrote; its tip carries the rebinding bug of its base, fixed on
main by 93a515485); `worktree-agent-a1be0465fdf269fbe` (the compaction's rules, not
handed back); `kinds-ada0`, `decoders-ada0` and `worktree-agent-ada0cb75ccefb0bf6` (the
relaxed floats' writer: comparisons, B2; the sums in lanes held); the hoist's writer
`worktree-agent-a5f89d0c0c9d7eb2f` (the identity folds and the load sinking held);
`worktree-agent-a4519a2dc39ff972e` (238aedd6e, not ruled on); `tests-time` (the
test-time chain's tree). Workflows running: `jz-tests-time`, `jz-wave0` (the parameter
default, the descriptor, the compile's leftovers, the limits, toPrimitive, the hosted
compiler's helper dependencies, the parser's nested calls in /Users/div/projects/subscript),
`jz-words` (an integer element's word by the level's rule: land-e's callback on x64),
`jz-nanbox` (a NaN's bits never make a box), `jz-settle` (the bench after the tiers
settle). Done this day: `jz-110-audit` (the plan of 1.1.0), `jz-live-compile` (the
kernels' compile cost: a design and its critic), `jz-x64-gaps` (seven cases read on x64:
a plan and its critic). Their outputs and the briefs are session scratch.

Tools found or made this day: `.github/workflows/bench-probe.yml` times a commit beside
the tree on one x64 runner (`base`), and the same builds under V8 flags (`node_flags`);
`bench/lowering.mjs`, printed by examples-perf on three targets a push, is the tree's one
measurement of lowering forms; VS Code's universal binary runs as Node in x64 mode under
Rosetta (instruction counts, not Intel's latencies). Two compilers loaded in one process
share the parser's registrations and the second fails to parse: build each tree's output
in its own process.

## The land-h landing (2026-11-17, the evening)

```
39186ffed land-h   main (85e229c76) and one commit: plasma's lift back; the record's commit after it
```

Handed back since the land-g record and waiting for the next tree: `kinds-ada0`
(3b574224d a loop whose counter is tested with an offset, 185a661f5 an exported
parameter kept as the program's own calls pass it, 531d5a8f8 a BigInt compared with a
string and with a number); `worktree-agent-a1be0465fdf269fbe` (the compaction's twelve
commits, tip edac56627; 3ebce5115 goes straight after 2d03ca18c). Started since:
`jz-baseline-tier` (done: `tier/plan/plan.md` and its critic), `jz-audio-a` (typed
arrays' static `of`, a throw while a module starts, an import in the middle of a line).

## Branches of the land-i landing (2026-11-18), tips before deletion

```
3592bf8dd land-i                             the landing branch as its second check ran it: main (7ec77254c) and 20 commits; the record's commit after it
a0ef2262d (land-i, 18 commits)               the tree as its first check ran it; the check found be5777019's kernel
7306b6dec worktree-agent-a417d57c6f092b160   the holders: landed as 809e342e4, b89506283, be5777019
531d5a8f8 kinds-ada0                         the relaxed floats' writer: landed as a3a164b9a, 0fb954d28, 6eda696f5
edac56627 worktree-agent-a1be0465fdf269fbe   the compaction's rules: landed as 30989e452 to 2d8ba71cb
39186ffed land-h                             the earlier landing branch, the base three workflows name
3ca2082ab land-g                             the landing branch before it, the base the words, the box and the bench workflows name
```

Handed back and waiting for the next tree: `worktree-wf_4473d3a7-3a9-1` (the bench after
the tiers settle, nine commits on 3ca2082ab, tip 9fccec9ad; its last is the integrator's:
the pair rule in the chart and the ledger, the README's method paragraph left as main's
until a dataset is measured by the rule; `settle-result.json` in the session scratch is
the workflow's whole result). Held as before: `decoders-ada0` 099c77415 (the sums in
lanes), `worktree-agent-a5f89d0c0c9d7eb2f` 8151718b2 (the identity folds, the load
sinking), `worktree-agent-a4519a2dc39ff972e` 238aedd6e (not ruled on). Workflows running
when this was written: `jz-words`, `jz-nanbox`, `jz-audio-a`, `jz-wave0`, `jz-tests-time`.

The check of a landing tree: `land.sh` in the session scratch (three core legs, lint, the
file audit, bench bytes by hash against a base, `test:self`, the integration suite, the
examples twice). It reads no kernel's loop shape under a set level: test/minimal-output.js
skips there, and the default leg alone runs it. A writer whose change takes a fact away in
the summary runs that file at the default level before it hands back.

## Branches of the land-j landing (2026-11-18), tips before deletion

```
97fa559ee land-j                        the landing branch as its check ran it: main (7125c4739) and 18 commits; the record's commit after it
9fccec9ad worktree-wf_4473d3a7-3a9-1    the bench after the tiers settle: landed as c3ac25e71 to d4b1ca84c
699464d78 worktree-wf_14e8e92f-2ea-2    the word read off memory: landed as 71f2f063b to 395b88e48
```

Handed back and waiting for the next tree: `worktree-wf_757e86d3-74a-1` (the embedding
lane's small ones, seven commits on 85e229c76, tip 26ea299f6; then its hash to the audio
session). Held as before: `decoders-ada0` 099c77415, `worktree-agent-a5f89d0c0c9d7eb2f`
8151718b2, `worktree-agent-a4519a2dc39ff972e` 238aedd6e. Workflows running when this was
written: `jz-nanbox`, `jz-wave0`, `jz-tests-time`. The workflows' whole results are
session scratch (`settle-result.json`, `words-result.json`, `audio-a-result.json`).

Probes of this day, session scratch under `own/`: `rebind4.mjs`, `rebind5.mjs` (a module
literal over a binding the program writes), `holemix.mjs` (a hole read twice), `numprops.mjs`
(arrays that hold number-named properties), `afill2.mjs` (a kernel's loops by the forms a
test asks for), `foldkept.mjs` (which module literals still fold away).

To do after this landing: the x64 probe of callback, polytri and the word's other moved
cases against 7125c4739, and the revert of polytri's form if it loses there; the gate
`test/bench-claims.js` does not ask a dataset for `meta.passes`; the first reference run
by the pass rule, with the README's method sentence in the commit that brings its data.

## Branches of the land-k landing (2026-11-18), tips before deletion

```
3da3e688f land-k                        the landing branch as its check ran it: main (e46e3705c) and seven commits; the record's commit after it
26ea299f6 worktree-wf_757e86d3-74a-1    the embedding lane's small ones: landed as 3474662e4 to 3da3e688f
```

Waiting, each named in the record: `land-l` (this tree and `tests-time`'s eight, 182eb94ae
to d22ffe40f; the chain's fifth step still being written on `tests-time`); `wave0-loops`
(scratch worktree `w0-loops`, tip 8837fce12; its d3372be72 adds a test to test/optimizer.js,
which land-l's split deletes: move it to the split file when both meet);
`worktree-wf_00b2d799-cc8-10` 782b0c991 (the hosted helper dependencies);
`worktree-wf_00b2d799-cc8-17` b39e6aa36 (Symbol.toPrimitive);
`worktree-wf_00b2d799-cc8-12` 1f6989576 (the limits, a writer repairing its gate);
`nested-call-parse` ce53752 in /Users/div/projects/subscript (a writer repairing a tree).
Workflows running: `jz-nanbox`, `jz-tests-time`. Briefs of the two repairs: session
scratch `w0-fix/`.

## Branches of the land-l landing (2026-11-18), tips before deletion

```
8f1cec4f8 land-l                         the landing branch as its check ran it: main (a27648bc1) and 27 commits; the record's commit after it
4b907722a tests-time (first eight)       landed as 182eb94ae to d22ffe40f; the branch goes on (step five being written)
782b0c991 worktree-wf_00b2d799-cc8-10    the hosted helper dependencies: landed as 445f0af99, 3d8b5caa0
b39e6aa36 worktree-wf_00b2d799-cc8-17    Symbol.toPrimitive: landed as ce9a6ed0f to 1b53404e4
8837fce12 wave0-loops                    wf_00b2d799-cc8-1's twelve and the integrator's fix: landed as b9c9bbbdd to 8f1cec4f8
```

`tests-time` from here: its later steps are picked from 4b907722a on (the branch's own
base is 4157cd976; its first commit's split of test/optimizer.js met six lines main had
added, now in test/optimizer-unroll.js, and d3372be72's unit test is in
test/optimizer-induction.js: a later pick that touches those two files is checked by hand).
Comments that still say the scan drops helpers in the hosted compiler: module/array.js
131-135 and 306, module/collection.js 334-340 and 357-358, module/json.js 241-243,
module/typedarray.js about 3096, module/string.js about 225, src/wat/assemble/stdlib-pull.js
601-605, test/self-compile-includes.js (header, test name, message).
Writers at work (Agent tool, briefs in session scratch): `w0-fix/brief-limits.md` on
`worktree-wf_00b2d799-cc8-12`; `audio-b/brief-audio-b.md` in a worktree of its own.
Workflows running: `jz-nanbox` (repair), `jz-tests-time` (step five).

## Branches of the land-m landing (2026-11-18, the night), tips before deletion

```
93bd6202f land-m                         the landing branch as its check ran it: main (86df52211) and 13 commits; the record's commit after it
1a748c898 worktree-agent-ab0f34829902a23e5  the embedding lane's six (c5d1c3520 to 1a748c898): landed as c442b6f39 to d75c13129
93bd6202f land-m-fix                     scratch worktree `bisect-m`, where the two regressions were bisected
```

Waiting: `land-o` f28925d2c (land-m at 69271d30a, the limits' 21 commits of
`worktree-wf_00b2d799-cc8-12`, c8d17fdfa and f28925d2c; lacks 94d20af3a and 93bd6202f:
rebase onto main); `land-n` b86e68e60 (land-m at d8fb5aecd and the NaN box's 17 of
`worktree-wf_cc3b338f-0f7-2`); `nanbox-rest` (the follow-up writer, brief in session
scratch `nanbox-w/brief-rest.md`); `tests-time` (steps five to nine); `decoders-ada0`
099c77415 and a5f8's 8151718b2, held. watr `encode-locals-linear` c6459c7 (scratch clone
`w0-fix/limits/watr`) and subscript `nested-call-parse` 65ce463: not pushed, the owner's.
The landing check from here: `LEGS="wasi default inv3 opt0" sh land.sh <tree> <tag> <base> 8`,
and the touched test files on a fresh hosted compiler (`hosted-some.mjs`) before it.
A wall-time bound that fails inside a loaded check (test/perf.js, examples/bench.mjs) is
rerun alone before it is believed either way.

## Branches of the land-o landing (2026-11-19), tips before deletion

```
48b221b29 land-o                         the landing branch as its checks ran it: main (5f3865889) and 29 commits; the record's commit after it
e473d681a fix-len                        the length read by the closure, on main: landed as 1404dfd3f
6b49e4f3e worktree-wf_00b2d799-cc8-12    the input limits' 21 commits, before the rebase: landed as 62debf945 to ebb10c430
1a748c898 worktree-agent-ab0f34829902a23e5  the embedding lane's six, kept past land-m for the hash the handover had wrong
```

Waiting, each to review with the integrator's own probes before it lands:
`nanbox-rest` 13c8dd1de (26 commits on `land-n` b86e68e60, which is land-m at d8fb5aecd and
the NaN box's 17: the armed check `assertNumberBitsUnread` and what it named; rebase onto
main; it grows three*, webaudio and polytri at the optimizing levels, so time them first);
`tests-time` 99cfc1c3f (the test-time chain's nine steps, each written by one agent and
checked by another; scratch worktree `tests-wt`; the workflow's journal holds each report);
`decoders-ada0` 099c77415 and a5f8's 8151718b2, held. watr `encode-locals-linear` c6459c7
(scratch clone `w0-fix/limits/watr`) and subscript `nested-call-parse` 65ce463: not pushed,
the owner's. Two briefs written and not launched: session scratch `audio-c/brief-helpers.md`
and `audio-c/brief-facts.md`.

The limits follow-up, to brief: a bound on the nesting of what jz hands watr (the call
chain under WASI, the index chain of 1,000, the gate's ten rows that fail at the default
level); the hosted entry naming a walk's overflow; the cubic time of a member chain behind
an optional chain; test/hosted-costs.json timed again.

## Branches of the land-q landing (2026-11-19), tips before deletion

```
1644ad9c3 land-q                              the landing branch as its check ran it: main (9d56c891c) and 8 commits; the record's commit after it
dd37b29b4 worktree-agent-af522bdeb69710f9e    the audio helpers, six commits and two follow-ups on bd6def506: landed as 7d4967e76, 0fb2ac173, 655c9874b
f8ad60e53 worktree-agent-a9ec23575a85c3d81    the limits round two, five commits on 9d56c891c: landed as 5dd373663, e1aecffbc, 2c5a6c321, 513c85b8b, 1644ad9c3 (the branch goes on: the block fix)
```

Staged behind it, each reviewed with the integrator's own probes:
- `land-r` (c8504267d): land-q and the audio facts' eleven commits (names and fields decide nullish tests; a store proves its name an object, each part that may not run walked apart; two wrong answers of main fixed: a folded test as a call's one argument, a proof past a sibling closure's clear). 203 programs of mine and 35 more answer as Node on its tip. Its check is next.
- The NaN box (`nanbox-rest2`, bcb69549d, 47 commits): passes closret (0 of 448), the routes and the probe; back with its writer for the rebase onto land-r, the times on a quiet machine and two data-forms rises.
- The block fix (the limits writer, on f8ad60e53) and the tests' close-out: out.

Waiting on the owner: watr's release (the encoder fix c6459c7 and the seven commits of `limits-depth` in `limits-w/r2/watr`); subscript's `nested-call-parse`; whether probe branches may be pushed.

## Branches of the land-s landing (2026-11-19), tips before deletion

```
82b9008ea land-s                              the landing branch as its check ran it: main (dbf9beb10) and 11 commits; the record's commit after it
e77e5c278 worktree-agent-a9c66c8c6d26bba8c    the audio facts, twelve commits on 9d56c891c: landed as 33b5ef3dc to 82b9008ea (8d252c743 and e77e5c278 as one)
c8504267d land-r                              the same eleven on the landing before the record: superseded by land-s
```

Left standing, no writer at work (the owner stopped them on 2026-11-19):
- `nanbox-rest2` (bcb69549d, 47 commits on 9d56c891c): the NaN box. Passes closret (0 of 448), the routes and the probe. Owed: a rebase onto main (conflicts in module/number.js, src/summary/index.js, test/data-forms.json), the messages' stale hashes, times on a quiet machine, the two data-forms rises.
- `worktree-agent-a9ec23575a85c3d81` (f8ad60e53 and uncommitted work): the block fix by position (a bare block dropped whole where its first statement is no statement keyword's; `limits-w/review-2/cases-blocks2.mjs`).
- `worktree-agent-afab4ffb7d6879342`: the tests' close-out.

Waiting on the owner: `npm install` for jz's bumps (watr 5.13.8, subscript 10.8.6 with src/parse.js:461-467 deleted); the reference run; whether probe branches may be pushed.

## Branches of the land-t landing (2026-11-19), tips before deletion

```
fa11e4fa3 land-t                              the landing branch: main (8db0e890e) and the block fix; the record's commit after it
f8ad60e53 worktree-agent-a9ec23575a85c3d81    the limits round two (landed in land-q) and, uncommitted in its tree, the block fix: landed as fa11e4fa3
```

## Branches of the land-v landing (2026-11-19), tips before deletion

```
baa2ae55d fix-v                               the landing branch: main (6bc58eabd), the sole call's loop (66983ee46) and the label's early errors; the record's commit after it
```

## Branches of the land-x landing (2026-11-20), tips before deletion

```
2b73d089f bump-x      the landing branch: main (f0a5956e8), the two dependencies (56324e3e3) and the member gate; the record's commit after it
dca908186 bump-w      the first build of it, the method's node at its `{`: failed its check, superseded
2e0b2fb57 oo-w        on bump-x: the reserved-word method names and the array's `with` (1ca15361d), the bound class expressions (2e0b2fb57); not checked on the legs
0c430196a fix-v       the reserved-word commit as first written, on f0a5956e8: superseded by 1ca15361d
```

## Branches of the land-y landing (2026-11-20), tips before deletion

```
1d1a497a4 oo-w        the landing branch: main (41ea18ca2), the reserved-word method names, the bound class expressions, the renamer, the CommonJS linker; the record's commit after it
d378bd002 ctor-w      on oo-w: a constructor function that is only constructed folds to a class (uncommitted in its tree, unfinished)
```

## Branches of the land-z landing (2026-11-21), tips before deletion

```
7b0538909 land-z      the landing branch: main (e7fa2008f) and eight commits; the record's commit after it
913bb0735 ctor-w      on e25c3b4ad: the constructor-function fold and a constructor's return as first written (land-z's 75b271efa, 5b4cde057)
84ba1ae6c alias-w     on ctor-w's 4b002a1e6: the early reads, the second flattening, the linker's direct binding (land-z's 54083a3a5, 74f7cc1d9, 35c77c380)
cf8956215 grow-w      on 4b002a1e6: the transitive keeps and the descending counter (land-z's ac8db0ef5, 49d12e7bb), then the descent from the length (cf8956215): not landed, the next landing
```

## Branches of the land-aa landing (2026-11-21), tips before deletion

```
bcbec7004 land-aa     the landing branch: main (094bd1072), the descent from the length, the cursor's extent, the bench driver's `[why]` line; the record's commit after it
1b0a89c56 run-w       on land-aa: the store of a property through an array that may be missing, the lanes of a record that may be missing, the guarded element runs: checked next
cf8956215 grow-w      the descent as first committed (land-aa's 5c40977eb)
```

## Branches of the land-ab landing (2026-11-21), tips before deletion

```
194576713 vec-w       the landing branch: main (2b01e3aba), the store of a property through an array that may be missing, the lanes of a record that may be missing, the guarded element runs, the refused lift, a run that stores; the record's commit after it
411fc3cb0 (no ref)    the tree the check ran on: vec-w before the vector fix's message was rewritten
d44103f68 run-w       the first three commits; its check failed on WASI and armed level 3 (a run of reads alone)
          hull-w      on 411fc3cb0: a recursion's argument range, one commit marked not for landing, and the dispatcher's reachability uncommitted
```

## Branches of the land-ac landing (2026-11-22), tips before deletion

```
5a0100e84 land-ac     the landing branch: 14 commits on a107b46e0 (main 66812d093 and the held-out lane's two records); the record's commit after it
f4c0762f4 (no ref)    land-ac as its sixth check ran it and passed: before a body that never returns was kept a call (jessie 1.015 to 1.019 times main's time)
1ba0a244f (no ref)    land-ac as its fifth check ran it: the splice of bodies that throw without its rule for arrows (decode-qoa 130 MB)
2d1d22256 (no ref)    land-ac as its fourth check ran it: before the tuple return's fix and the destructuring tests' correction
a7aa01249 rng-w       the branch as first built and twice checked: the listing's commit that claimed a gain, the frame census's miscount
190d7bd83 acc-w       the accessor's fix as first committed (land-ac's fed47c0d8)
54e0f1275 hull-w      a recursion's argument range before it was split into land-ac's commits
          next-w      on the land-ac of the fourth check: a while that spells a for, the retired dispatchers and binders; the next landing, to be rebuilt on main
39d0962be bench-versions  on a107b46e0: the rivals' current releases pinned, each lane's versions in the bench page's tooltips; lands after this
```

State kept outside the repository: `/Users/div/projects/jz/.claude/worktrees/tools/` (the landing scripts under `own/`, the bench bytes of each landing `bh-*.jsonl`, the probes, `notes.md`). There too, for phase 12: `keep/arrow-rule.patch` (a local arrow's splice taking a body with a `throw`, a `break` or a `continue`, with its two tests), `own/mutant-arrow.sh`, and the analogs `probe/k-release-a.js` to `-f.js` with `probe/heap-growth.mjs`. The session's scratchpad was emptied by a cleanup on 2026-11-21 and holds nothing that is needed.

## Branches of the land-ae landing (2026-11-22), tips before deletion

```
9d5e7a75d land-ae     the landing branch: 4 commits on 0a9e1b801 (main c59c3a568 and the held-out lane's two records); the record's commit after it
d3a226f74 next-y      the six commits first built for this landing: the two of the rivals' releases, the while that spells a for, the retired dispatchers, the iteration's cut, the perf bars. Its check stopped at the listings (spellings 42 gaps to 82, the data forms' `@this` cells)
339744bec next-x      the while and the dispatchers on c59c3a568 (worktree next-x, its working files the cut and the perf bars as landed, and test/perf.js with the three assertions the while needs): where their rework starts
          key-w       on 9d5e7a75d, uncommitted in its worktree at this record: a key a store inserts is kept (the note `$__ink`, the census's `siteKeyed`); its message msg/key.txt, its mutations own/mutant-key.sh. The next landing
a8cbbf12f bench-v2    bench-versions' two commits on c59c3a568, the tooltip's one line added (landed as fb250ac96 and 793ee2a54)
39d0962be bench-versions  the agent's branch as it left it, on a107b46e0
c59c3a568 land-ac     the landing before
```

Under `/Users/div/projects/jz/.claude/worktrees/tools/` for what comes next: `probe/pass-bisect.mjs` (a program at a level with each pass off alone: which one makes a wrong answer), `probe/levels-of.mjs` (a program's `run(n)` at every level against Node), `probe/spell-abs.mjs` (the loop ops of each spelling of a corpus program, absolute), `probe/k-static*.js` and `probe/k-keyfresh-*.js` (the key's analogs), `probe/k-release-g.js` (the cut's), `keep/ad-listings/` (the two listings as the six commits moved them).

## Branches of the land-al landing (2026-11-22), tips before deletion

```
dd8ee9ca5 key-w       the landing branch: 3 commits on aa8b6ac86 (the fix 466757bbe, its listings a6dd030ef, the level 3 assertion dd8ee9ca5); the record's commit after it
7c758d0eb (no branch, an object the next collection may drop) the fix's first form, the kernel keeping the key and every keyed site asking it: its check stopped at the listings (the string-keyed counters' bar 66 ops and a call dearer)
d3a226f74 next-y      as in the record before: the while and the dispatchers, held at their listings
339744bec next-x      where their rework starts
aa8b6ac86 land-ae     the landing before
```

Under `/Users/div/projects/jz/.claude/worktrees/tools/` for what comes next: `own/mutant-key.sh` (the twelve mutations; `ONLY=Yn` runs one), `probe/key-mem.mjs` (the counting helper's memory at each level and whether the helper stays a function) and `probe/key-mem-wat.mjs` (the lines of its loop that touch the heap's top, the flag, the note or the compaction), `probe/loop-keys.mjs` (where a loop's check reads the note), `probe/k-static*.js` and `probe/k-keyfresh-*.js` (the analogs), `time-key2.out` and `time-key2b.out` (the timing against main).

## Branches of the land-aq landing (2026-11-23), tips before deletion

```
714676b57 land-aq     the landing branch: 8 commits on d0d5ae5b1; the record's commit after it
132508cee land-ap     the same tree, its seventh commit's message stating the spellings as 42 of 470 where the branch has 14: replayed as land-aq
0e0766e4e spell-w     the accumulator's bound, its listings, the atoms' path and the nest's test, on 9e7dd971b
098622809 forms-w     the object cells and the getter's fix, on d0d5ae5b1 (37f9f03e6's message calls static counts "each pass")
bd67ac5b0 release-1.0 1.0.4: three commits on the tag v1.0.3, pushed
9e7dd971b key-w       the landing before
d3a226f74 next-y      the while and the dispatchers, held at their listings
339744bec next-x      where their rework starts
```

Under `/Users/div/projects/jz/.claude/worktrees/tools/` for what comes next: `own/mutant-acc.sh`, `own/mutant-recv.sh` and `own/mutant-obj.sh` (the mutations; `ONLY=On` runs one of the last), `probe/call-time.mjs` (the object programs against Node), `probe/who-retypes.mjs` (who retypes a local after emit) and `probe/who-types.mjs`, `probe/guards-of.mjs` (the missing-receiver tests a function keeps), `probe/count-of.mjs` (a module's lines, bytes and matches, one tree a process), `probe/levels-of.mjs` (a kernel at every level against Node), the kernels `probe/k-list.js`, `k-over2.js`, `k-field.js`, `k-closed-a.js`, `k-held-a.js`, `k-held-b.js`, `k-big-a.js`, `k-big-b.js`, `k-big-c.js`, `k-list-guards.js`.

## Branches of the land-ar landing (2026-11-24), tips before deletion

```
8fd166479 land-ar     the landing branch: 9 commits on afd39f3c5; the record's commit after it
75439e610 obj-w       the same five changes as committed first, on 714676b57 (no changelog)
af975b1db land-aq     the landing before
bd67ac5b0 release-1.0 1.0.4, tagged v1.0.4
d3a226f74 next-y      the while and the dispatchers, held at their listings
339744bec next-x      where their rework starts
```

Under `/Users/div/projects/jz/.claude/worktrees/tools/` for what comes next: `own/mutant-obj.sh` (the twenty mutations; `ONLY=On` runs one), `own/obj-chain.sh` (the two test files on five legs, the narrowing's mutations, the listings, the bench bytes), `own/ar-legs.sh` (named test files on the five legs of any tree), `probe/nan-armed.mjs` (programs of a folded NaN, armed, against Node), `probe/alias-loads.mjs` (the alias test's loads by carrier), `probe/bytes-of.mjs` (a program's module bytes), `probe/call-time.mjs` (the object programs against Node), `probe/time-kernel.mjs` (one program's exports, one tree a process), `probe/form-src.mjs` (a data-forms program's source), `probe/guards-of.mjs` (the missing-receiver tests a function keeps), `probe/who-retypes.mjs` and `probe/who-types.mjs` (who gives a local its wasm type), the kernels `probe/k-list.js` (the hop still at 1.7 ns), `k-over2.js`, `k-field.js`, `k-closed-a.js`, `k-held-a.js` to `k-held-e.js`, `k-big-a.js` to `k-big-d.js`, `k-bool-a.js`, `k-truth-loops.js`, `k-rec-box.js`, and `k-getter-call.js` (the program main refuses).

## Branches of the land-at landing (2026-11-24), tips before deletion

```
d33938ce5 list-w      the landing branch: 2 commits on bf57cb248; the record's commit after it
fd5fbc2d7 arr-y       the array branch: 2 commits on bf57cb248 (a growing store's hand-back keeps its hop out of the loop), five legs passed, not landed
43c23852d arr-w       the same tree as arr-y under a message that misstated a count: to delete
0fb568364 land-ar     the landing before
```

Under `/Users/div/projects/jz/.claude/worktrees/tools/` for what comes next: the analog kernels `probe/k-shapes.js` (plain forms), `probe/k-shapes2.js` (five classes under one base) and `probe/k2-sieve.js`, `k2-permute.js`, `k2-queens.js`, `k2-towers.js`, `k2-storage.js` (one class under its base, the lane's shape); `probe/k-list2.js`, `k-list3.js` (walks, in allocation order and shuffled); `probe/chase-floor.mjs` (hand-written wasm walks), `probe/wat-variants.mjs` (hand edits of an emitted function, timed); `probe/loop-calls.mjs` (each innermost loop's hops, header loads and calls), `probe/fn-calls.mjs` (a function's calls), `probe/params.mjs` and `probe/sum-params.mjs` (parameters as the emitter and as the summary settled them), `probe/sum-field.mjs` (the summary's kind of a field), `probe/why.mjs` (the compiler's own `why`), `probe/agree-all.mjs` (every export against Node at each level), `probe/try.mjs` (programs from stdin against Node), `probe/mod-wat.mjs`, `probe/fn-wat.mjs`; `own/heldout-two.mjs` (two runs of the lane side by side), `own/mutant-getter.sh`, `own/mutant-hops.sh`, `own/ar-legs.sh` (named test files on the five legs).

## Branches of the land-aw landing (2026-11-24), tips before deletion

```
46bc590a4 land-aw     the landing branch: 5 commits on 9d2fb7882; the record's commit after it
52e68b85c aw-hop      (detached) the hop rule and its listing alone: what its bench bytes and its timing against main were taken on
484082b23 land-av     the first assembly, the hop rule in its first form: superseded
fd5fbc2d7 arr-y       the hop rule's first form, two commits on bf57cb248: superseded
31e838229 list-w      the landing before
```

Under `/Users/div/projects/jz/.claude/worktrees/tools/` for what comes next: `probe/tier-bisect.mjs` (each setting 'speed' and level 2 differ in, taken alone on one export), `probe/tier-order.mjs` (every export at level 2 and at 'speed'), `probe/opt-times.mjs` (one export under given optimize settings), `probe/run-one.mjs` (one export called many times, for `node --trace-wasm-inlining`), `probe/pad-variants.mjs` and `probe/asm.mjs` (hand-edited copies of a bench case's module; `bench/_lib/run-jz-host.mjs <wasm>` times one), `probe/case-funcs.mjs`, `probe/funcs-diff.mjs`, `probe/case-wat.mjs` (a bench case's functions, their bytes and their text), `probe/forms-delta.mjs` (two data-forms listings compared), `probe/hop-count.mjs`, `probe/loop-calls.mjs`, `own/time-k2.sh` (the one-class analogs against main), `own/mutant-hops.sh`; the timings `time-tiny.out` (the 44 cases, the splice at none against 16), `time-awhop.out` (the hop rule's cases against main), `keep/ta/` (threeanim's builds, their edited copies and V8's inlining traces).

## Branches of the land-ax landing (2026-11-24), tips before deletion

```
fbff92eb2 gather-w    the landing branch: 3 commits on a48dd5501; the record's commit after it
46bc590a4 land-aw     the landing before
frozen-w             (uncommitted at this record) the array a function reads before the init pushes end: summary/index.js `short`, query.js frozenLenOf, test/fixed-length.js
```

Under `/Users/div/projects/jz/.claude/worktrees/tools/` for what comes next: `probe/try.mjs <tree> <level>` (programs on stdin, separated by a line of `----`, each `f()` beside Node's), `probe/sum-index.mjs` (each indexed read of a function: the summary's kinds of receiver, key and read, whether it is a present read, its word range), `probe/form-src.mjs` (one of the data forms' programs written out), `probe/tier-order.mjs`, `own/mutant-passes.sh`, `own/mutant-frozen.sh`, `own/heldout-two.mjs` (two runs of the held-out record side by side, a program counted changed by either row's bytes); the held-out records `heldout-31e.json`, `heldout-bbe.json`; the early-read programs `keep/frozen/*.txt`, of which test/fixed-length.js on frozen-w holds every one that matters.

## Branches of the land-ay landing (2026-11-24), tips before deletion

```
e3b7b8f45 frozen-x    the landing branch: 2 commits on 6e1ea6df1; the record's commit after it
          frozen-w    (uncommitted, superseded) the fix's first form, on a48dd5501
c503b1845 gate-w      the next landing's base: da64bf084 the data forms' gate measures memory and holds 'speed' to level 2; c503b1845 the fetch test's limit
          rule-w      (uncommitted, on gate-w) a pass of a loop moves for a loop that counts its passes; waits for its timing
          built-w     (uncommitted, on gate-w) an object built by stores is its literal (jzify/bundler.js builtLiterals)
```

Left standing by the owner's silence, not by a ruling: the superseded worktrees and the held branches listed to the owner on 2026-11-24 (the NaN box `nanbox-rest2`; `next-x` and `next-y`; `tests-time` and `worktree-agent-afab4ffb7d6879342`; `decoders-ada0`; `worktree-agent-a4519a2dc39ff972e`; `worktree-agent-a5f89d0c0c9d7eb2f`). The ten worktrees whose tips main held are removed, with their sixteen branches.

Under `/Users/div/projects/jz/.claude/worktrees/tools/` for what comes next: `probe/frozen-len.mjs` and `probe/frozen-cases.mjs` (a program's frozen length; the test file's programs on another tree), `own/mutant-frozen.sh`, `own/mutant-passes2.sh`, `own/mutant-built.sh`, `keep/frozen/*.txt` (the early-read programs), `keep/pass-rule.patch`, `forms-gate-show.txt` (every cell of the gate: ops, calls, calls run, bytes a call), `heldout-526.json`.

## Branches of the land-az landing (2026-11-24), tips before deletion

```
72db55e2a rule-w      the branch the check ran on: seven commits on ca9b379a4, its fold's commit (0189c2a84) failing test/summary.js
af31a913d rule-x      the landing branch: the same seven with the fold's commit carrying its test (f278a6cf1); the record's commit after it
          len-w       (uncommitted, on 72db55e2a) the length an array is built to, for the solver's read rule (summary/index.js `steady`, `steadyOf`, `solve`)
```

Removed since the last record, their content on the landing branch: `gate-w`, `built-w`, `mem-w`, `pass-w`, `frozen-w`, `frozen-x`.

Under `/Users/div/projects/jz/.claude/worktrees/tools/` for what comes next: `probe/try.mjs` (programs from stdin against Node at a level), `probe/present.mjs` (which element reads the summary holds inside a length, per function), `probe/solves.mjs` (the summary's solves per bench case, on a tree patched to record them), `own/mutant-passes2.sh` and `own/mutant-built.sh`, `forms-gate-show.txt` and `forms-len-seq.txt` (every cell of the gate before and after the built length: ops, calls, calls run, bytes a call), `keep/pass-rule.patch`, `keep/built-fold.patch`.

A suite started beside a battery runs in one process unless `JZ_TEST_JOBS` is set (test/index.js splits over the idle cores): three hours where 25 minutes.

## Branches of the land-ba landing (2026-11-24), tips before deletion

```
b643be36b store-x     the landing branch: seven commits on 0b1020068; the record's commit after it
85ddb97de recv-x      its first four (the gate's kernel and the receiver rule), the base of len-x
75fe84a45 len-x       (work in progress, on recv-x, five commits) the built length for the solver's own read rule; the load CSE moving the first read's own node; the read that waits, with its test
          wait-w      (uncommitted, on store-x) the read that waits for its parameter's hull, alone, with its test by the seeded solve: the next landing
b3a4c945c rule-x      the landing before, kept as main's compiler for probes
```

`len-x` is to be replayed on main once its three are settled (the splice at a second direct site, quatmul's time, threecull's 'size' bytes); its finished commit's message is `msg/built-length.txt` under the tools directory, its changelog entry `msg/built-length-changelog.txt`.

Under `/Users/div/projects/jz/.claude/worktrees/tools/` for what comes next: `probe/entered.mjs` (the functions a steady call enters, by name), `probe/present.mjs` and `probe/case-present.mjs` (which element reads the summary holds inside a length: programs from stdin, or a bench case's function), `probe/case-top.mjs` (a bench case's functions after the plan), `probe/show-delta.mjs` (two `--show` listings of the gate, the cells that moved), `probe/heldout-runs.mjs` (the lane's last runs side by side), `probe/phases.mjs` (a compile's phase times), `probe/solves.mjs` (the summary's solves a bench case), `own/mutant-recv.sh`, `own/mutant-store.sh`, `own/mutant-steady.sh`, `keep/len.patch` and `keep/len/` (the built length's three files), `forms-recvx-show.txt` and `forms-lenx-show.txt`.

How a node that lost its verdict was traced: accessor traps on every slot of the path to the node, set after the final summary, print the stack of whatever replaces one (the scratchpad's trap.mjs; the idea is to keep).

## Branches of the land-bb landing (2026-11-25), tips before deletion

```
c4ba84a25 len-z2      the landing branch: six commits on f4afd4a63; the record's commit after it
fff2b47e6 len-z       (superseded) the branch the check ran on: len-z2 is its replay with test/splice.js corrected inside the two-site rule's commit
75fe84a45 len-x       (superseded) the built length's work in progress on the landing before: five commits, their content on len-z but for d26bd2f28's clearing of the reached set, which the waiting read replaced
```

Under `/Users/div/projects/jz/.claude/worktrees/tools/` for what comes next: `probe/mul-sites.mjs` (the calls of a method left in each named function after the plan, and the method's node count), `probe/case-wasm.mjs` and `probe/run-wasm.mjs` (a bench case's wasm written to a file; modules' `main` run in one process by rounds, under any V8 flag: `node --print-wasm-code` prints the machine code here), `own/mutant-steady.sh` (the built length's 33 mutations), `forms-main-f4a-show.txt` and `forms-leny-show.txt` (the gate's every cell before and after), `bh-leny-b3.jsonl` (the landing's bench bytes).

A figure to read before calling a bench case a tie: its bytes at the SIZE tier. threecull's time was 0.994 with 2,261 more bytes there, and the bytes were a kind that had got worse in every method of a class.

## Branches of the land-bc landing (2026-11-25), tips before deletion

```
8ad64526f miss-z      the landing branch: four commits on e06f39782; the record's commit after it
7f9ae40ca miss-y      (superseded) the same four before test/inline-tiny.js was corrected inside the second: the same source
2f4169c68 miss-x      (superseded) the same four on 814c38987, before the held-out lane's record moved main: the same source
          whole-w     on 2f4169c68, uncommitted in its worktree at this record: the named count (`new Array(N)`) and `covers` by the array's own length; held until the receiver's presence leaves the loop (the record above, "Found, not fixed")
```

Under `/Users/div/projects/jz/.claude/worktrees/tools/` for what comes next: `probe/gaps.mjs` (the data forms' listing tallied by family, form, holder, kernel or level: where the calls and the functions entered are), `probe/present.mjs` (each element read's verdict, in, hole or open, with the fixed and built lengths the query answers), `probe/kinds.mjs` (the kind of each read in a function), `probe/entered.mjs` (the functions a steady call enters, by name; it takes arguments and an init export), `probe/misskey-entered.mjs`, `probe/misskey-bytes.mjs` and `probe/misskey-src.mjs` (test/missing-key.js's sixteen programs under any tree), `probe/ast-module.mjs` (the module's statements as the plan left them), `own/mutant-misskey.sh` (the seven mutations of this landing's rules, and an eighth for the named count), `keep/fill/full/` (the named count's two files as they stood with this landing's), `forms-whole1-show.txt` (the listing with the named count and the wider `covers`: 575 gaps).

Two figures to read with care. A count of functions entered by a program with ONE reader flatters: a helper with a single site is spliced whatever it is. And the bench's bytes column is the size build's while the time is the speed build's (bench.mjs compileJzHost, compileJzSize).

## Branches of the land-bd landing (2026-11-25), tips before deletion

```
65a50e02f late-x      the landing branch: six commits on 14d88f53c; the record's commit after it
```

Under `/Users/div/projects/jz/.claude/worktrees/tools/` for what comes next: `own/mutant-unset.sh` with `own/mutate.py` (the sixteen mutations of this landing's four rules, by label: U the holder's presence, W the fill and the named count, F `Array.from`), `own/stage-late.py` and `own/apply-stage.sh` (a landing's stages cut out of one work tree's files), `probe/time-kernel.mjs` (a program's exports timed against Node's, with an init call and its arguments), `probe/form-src.mjs` (the source of one data-forms program), `probe/show-delta.mjs` and `probe/gaps.mjs` (two listings compared, one tallied), `forms-lateP4-show.txt` (this landing's listing, each cell's line).

Read the clock before a listing's ops where a loop is copied or unrolled: the holder's test taken out of an open-length array's loop read as fewer ops in one kernel and timed 7 to 29% slower in two others.

## Branches of the land-be landing (2026-11-25), tips before deletion

```
d6907fa3a own-z      the landing branch: five commits on 2f050eb7e; the record's commit after it
```

Under `/Users/div/projects/jz/.claude/worktrees/tools/` for what comes next: `own/mutant-ownlen.sh` (the four mutations of this landing's two rules; their text is `own/mutate.py`'s, by label B1 to B4), `probe/in/k/own-late.mjs` (the sum, the index sum and the gather bounded by the array's own length, in a holder a function assigns), `forms-ownbound-show.txt` (this landing's listing, each cell's line).

A mutation that widens a rule wants a program the widened rule really takes. "The length of any plain array is a bound" passed three programs that grew the bounding array before one was written that the scan versions: no call in the loop, the typed array the function's own, the growth through another name by a store at its end.

## Branches of the land-bf landing (2026-11-25), tips before deletion

```
110ad8edc open-q     the landing branch: six commits on 95a5ee4c5; the record's commit after it
466a2c343 isum-w     KEPT: the narrowing sum's four accumulators, one commit on e671ca31a, for the landing after this one
```

The same day 23 superseded worktrees were removed at the owner's word, their uncommitted changes saved as patches first; a branch was deleted only where every commit of it is on main by patch (seven), and every other branch stays as a ref. Worktrees left beside main: `nanbox-rest2`, `next-x` and `agent-a5f89d0c0c9d7eb2f` (held), `agent-afab4ffb7d6879342` (the test-time chain's unlanded steps), `v104` (release-1.0).

Under `/Users/div/projects/jz/.claude/worktrees/tools/` for what comes next: `own/mutant-open.sh` (this landing's twenty mutations, their text `own/mutate.py`'s by label), `own/stage-open.py` (a tested tree cut into the landing's commits, each stage a set of whole files, the last rebuilt from the one before it and compared), `probe/raw-time.mjs` (a kernel's export timed raw and through the wrapper), `probe/reset-run.mjs` (one instance, calls and resets in order), `probe/stale-ptr.mjs` (a module global's pointer and header words after the start: a capacity of -1 is a block that moved), `probe/in/a/` (the programs of this landing's findings), `forms-openq4-show.txt` (this landing's listing, each cell's line).

Three things this landing taught:

- A timing taken through the interop wrapper is a call's cost, not a kernel's: the wrapper adds 24 to 51 ns on a kernel of 256 elements, and by different amounts for different exports. Time the raw export beside it.
- A count of ops in a loop's round is no measure across an unroll: four accumulators read as 38 ops where 20 and run in two thirds of the time. Where a change unrolls, read the clock before the listing.
- A name-level fact and a node-level fact are both needed where the emitter rewrites the tree after the last summary (its unrolled loops are literal indices on fresh nodes), and each wants its own witness.

## Branches of the land-bg landing (2026-11-25), tips before deletion

```
710cd12db tests-w                              the landing branch: twenty-nine commits on f39304914; the record's commit after it
0b61334a3 worktree-agent-afab4ffb7d6879342     the test-time chain as its agents left it on 9d56c891c (2026-11-19): landed as the first twenty-four of tests-w
99cfc1c3f tests-time                           the chain's tree before its close-out, contained in the branch above
```

The commands this landing brings, for whoever lands next:

- `npm run test:quick` after every edit: the import lint, the file audit and 109 core files, 1,254 tests in under two minutes. It never replaces the legs.
- `npm run test:landing` is the landing check as one command, but its budgets are stale: run it once with `--record` on a quiet machine (about two hours at 8 jobs) before reading its verdict. Until then the integrator's script under the tools directory stands (`own/check-and-262.sh`).
- `funcWat(text, ...names)` throws where the module defines none of the names: a pin on a function a level may splice away names its caller too, or asks `hasFunc` first. On main before this landing it answered an empty text, and a test that kept it asserted nothing.
- CI's test workflow is cut in slices (`core (default) 1/3` and so on) with a `checks` job for the source checks: read a run by job, not by the four old names.

Under `/Users/div/projects/jz/.claude/worktrees/tools/`: `own/merge-imports.py` (a replay's import-only conflicts resolved by the union of both sides' names), `testsx-landing.out` (the chain's landing check, whole, on the replayed chain).

What this landing taught:

- Work parked "for review" is work not landed. The chain sat a week while main moved 186 commits; the replay cost an afternoon, most of it main's newer tests meeting the chain's stricter helper. Review within the day or say it is not going in.
- A bench byte that moves for a change with no compiler source is a finding, not noise: ten cases 2,445 bytes apart led to one file held as two modules under a linked path.

## Branches of the land-bh landing (2026-11-25), tips before deletion

```
e3048609b isum-x     the landing branch: five commits on 6218cda1c; the record's commit after it
```

For whoever lands next:

- Time a kernel raw and one export a process (the tools directory's `probe/raw-time.mjs`, one name a run). Through the host's wrapper a call costs 24 to 51 ns more, and a timing loop that has called other functions reads slower again.
- Run a mutant against its tests by name: `TST_GREP='<a part of each test's name>' node test/index.js <file>` takes seconds where the file takes minutes. A mutant that passes the named tests is then run against the file.
- The data forms' listing is by the round now: a cell's figure is the ops a call of the kernel runs over 256 elements, not the ops its loops hold.
- A float accumulator pays only in a loop the lanes take. Before typing a value as a float for the lanes' sake, time the forms the lanes refuse.

Under `/Users/div/projects/jz/.claude/worktrees/tools/`: `probe/lifts.mjs` (which reductions lift, by kind of array), `probe/isum-shapes.mjs` (shapes around the float accumulator answered as Node at three levels), `own/time-isum.sh`, `own/mutant-isum.sh`, `forms-run-base-show.txt` and `forms-isum3-show.txt` (the data forms' sweep on main and on this landing, by the round), `probe/show-delta.mjs` (the cells that moved between two sweeps).

What this landing taught:

- The first form of the rule was right by the count of ops and wrong by the clock in four forms. The gate's count is where to look, and a clock on each form the change touches is what decides.
- I named a cause for a hosted failure from reading one file, wrote the fix, and the fix changed nothing: the cause was not the one I read. A cause is named when the fix that follows from it works.

## Branches of the land-bi landing (2026-11-26), tips before deletion

```
41c4d3512 while-x    the landing branch: seven commits on bee5698de; the record's commit after it
084d533dd red-x      its first three commits before the replay onto the held-out lane's record (deleted)
```

For whoever lands next:

- `test/reduce-coverage.json` is the map of reductions: 23 ways of writing one over 5 kinds of array, V where the kernel is in lanes. A `.` at 'speed' is a way of writing a loop that runs an element a round where another runs two to eight. `node test/reduce-coverage.js --update` rewrites it; scripts/listings.mjs holds it with the other listings. A mark says in lanes, not faster: time what a mark gained.
- A lift is not a win until it is timed against its own loop. The ordered tier's lift of an Int32Array's sum was a V on main and ran 26% slower than the loop it replaced.
- The bench corpus moved by no byte in this landing or the one before it: it holds no reduction over a plain array, no `while` reduction, no sum taken from its accumulator. What a user writes over plain arrays is held by the gates alone (test/data-forms.js, test/reduce-coverage.js, test/spellings.js).
- What a loop's test proves of its counter until the counter's first write is kept by the emitter (src/compile/emit/i32-bounds.js `loopGuardHi`, `rangeHere`). It is a fact of one emission position: a decision about a whole body must not read it.
- The `while` loop is known to many readers in its own form (src/type/canonical-bounds.js, interval-proof.js, compile/loop-recurrence.js and others, 102 sites). Rewriting it as a `for` ahead of them costs more than it gives; so does lowering it as one at the emitter, which reads its plans by the body's node.

Under `/Users/div/projects/jz/.claude/worktrees/tools/`: `probe/lifts.mjs` and `scratch-forms.mjs` (which spellings of a reduction lift), `probe/in/a/red-forms.mjs`, `while-forms.mjs`, `i32-sums.mjs`, `callbacks.mjs`, `minmax.mjs`, `maxforms.mjs` (the timing inputs of this landing and of what it found), `own/mutant-red.sh` (24 mutations) and `own/mutant-while.sh` (7), `probe/vec-ir.mjs`, `probe/parse-show.mjs`.

What this landing taught:

- Three times the first idea was the larger one and the wrong one: a rewrite of the loop where one proof asked for the wrong range; a weight in the cost model where one tier took a body it had no work for; an extension of that tier where its lift already lost. Each time the timing or a gate said so within minutes. Measure the small form first.
- A soundness fact borrowed for a new question needs its limits read again. The loop test's bound was safe for the question it was kept for and unsafe for a read's bounds, in one shape: a nested loop that writes the name.

## Branches of the land-bj landing (2026-11-26), tips before deletion

```
fb7f0fa42 cond-x    the landing branch: eight commits on 6dbbf3226 (checked as ee332c1da on 6b961d6f3); the record's commit after it
61bed6601 cliff-x   its first three commits before the two after them were written (deleted)
1ac8d7795 meth-x    its first six (deleted)
```

For whoever lands next:

- The reductions' recognizer (src/optimize/vectorize/reduce.js `tryReduceReassoc`) reads a body as reductions and temps. Each statement is read in a copy: dead tees out, its own lane tees inlined, then the temps of the statements before it. A reduction's operand that reads a local the body writes refuses. `matchReduction` answers one reduction, `reducePart` builds its accumulators, `reduceWrapper` runs the parts in one strip loop under one skip.
- Change the recognizer's copy, never the function, to make two expressions one: the passes after the vectorizer read what it leaves (the ALAC decoder lost 13 specialized loop copies to an in-place dissolve).
- Time every bench case whose bytes move, paired against main. That is what found the 4%.
- The table's mark (test/reduce-coverage.js) is a vector load the kernel adds over the blank program. Any v128 op was the mark before, and read a scalar pseudo-minimum of two splats as lanes: the slowest cell of the table was marked in lanes.
- An array made by counted pushes that nothing resizes has its length for every reader (src/summary/query.js `steadyLenOf`); the array methods' loop now asks for it. A callback that resizes its receiver leaves it no such length.

Under `/Users/div/projects/jz/.claude/worktrees/tools/`: `own/mutant-cliff.sh` and `own/mutate.py` (the mutations by label, run by test name in seconds), `probe/in/a/minmax.mjs`, `maxforms.mjs`, `callbacks.mjs`, `reduce-kinds.mjs` (the timing inputs), `probe/funcs-diff.mjs` and `probe/case-funcs.mjs` (which functions of a bench case moved).

## Branches of the land-bk landing (2026-11-26), tips before deletion

```
cf9bca8a7 narrow-x   the landing branch: nine commits on c3f32d5b9 (checked as c7a23abc9 and, with the fix, 0c04c2f7f, on 8bbe10ce1); the record's commit after it
```

For whoever lands next:

- Run the generated suite whole before a push: `sh own/recheck-gen.sh <tree> <tag>` under the tools directory (13 minutes at 8 jobs, then the vectorizer's files under the sweep, the quick tier and the vector populations on a fresh hosted compiler). The landing check alone does not run it, and CI runs it after the push: land-bj put a wrong answer on main that way.
- A reduction's accumulators after the first read by a whole vector's offset (reduce.js `offsetLoads`). A lowering that reads less than a vector a round (the f32 widening's `load64_zero`) keeps one, whatever the reduction: ask how a reduction loads before giving it more.
- A row for a lift is a row per kind of array it can meet: a plain array, a Float64Array, a Float32Array, each integer width. The populations hold them all; a hand-written row holds what its author thought of.
- A plain array of integers holds floats, each a word exactly, and the emitter reads them as words: `(i32.trunc_sat_f64_s LOAD)` marked `wordOf` (src/ir/numeric.js `exactWord`). A pass that wants the cell reads the mark (reduce.js `exactOf`), which counts only while the node still truncates the operand it was made with; a node rebuilt child by child loses it unless the rebuild carries it (`rebuilt`).
- The reductions' recognizer reads a copy of each statement in three steps: dead tees out (`undead`), the statement's own lane tees and the earlier temps inlined, then the orders and word reads put in the lanes' terms (`readAs`). The function is never rewritten for the recognizer's sake.
- A sum that may not be reordered as a float may still be exact as an integer: i64x2 lanes and one merge, under a test on entry that the loop's own adds would have been exact (`reduceWrapper` `exactly`). The same shape would take a sum of squares of bytes or a conditional integer sum.
- A lift whose lanes start at a lane-width neutral must be skipped where no strip runs. The reductions of one loop share one skip.
- The table's count is not the goal: phase 14 asks for the sequence group's `calls` cells in test/data-forms.js. `node test/data-forms.js --show=seq/<form>` prints a form's cells with their calls by name.

Under `/Users/div/projects/jz/.claude/worktrees/tools/`: `own/mutant-cliff.sh` (the labels NW, WS, WM, WO, FO, FA, WX of this landing), `probe/in/a/words-ext256.mjs`, `words-two.mjs`, `narrow-max.mjs`, `i32-sums.mjs` (the timing inputs), `probe/wat-all.mjs`, `probe/steady-len.mjs`.
