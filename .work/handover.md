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
