# plan.md: the living plan

## 2026-08-31 status override

This section supersedes the older measurements below.

- Recursive jz×jz now produces and probes a working compiler on the complete 321-module graph: 6,827,550 input bytes, 14,005,329 output bytes, 4,103,691,504 final heap, and 191,275,792 bytes of wasm32 headroom. This closes only the fit-under-4-GiB feasibility gate. Compiler efficiency remains red.
- The nearest `/usr/bin/time` recursive run used 4,259,053,568 bytes of process RSS. Porffor's pinned full native self-build uses 1.89 GB. JZ is still about 2.25× heavier, with only 4.5% wasm32 headroom; it does not meet `CONTRIBUTING.md`'s memory requirement.
- A same-architecture hosted build took 25.46 s and 3,129,409,536 bytes max RSS, down from the preceding O3-stage runs at roughly 168–172 s and 4.0–4.5 GB. Those temporary logs are not revision-keyed release evidence, so the comparison must be repeated on a quiet machine against exact source hashes.
- `dist/jz.wasm` is 14,107.7 kB. The full native suite passes 3,894/3,895 with one skip; the hosted suite passes 3,058/3,059 with one skip. Functional self-compilation, warm reuse, snapshot tests, and recursive compilation pass.
- Size improved from 25/49 strict wins and a 1.0403× JZ/AssemblyScript geomean to 34/49 wins and 0.9368×. Fifteen strict per-case losses remain, led by `shapes`, `wordcount`, `fft`, and `tokenizer`; v1 size certification remains red.
- Runtime evidence remains embargoed. The machine currently has about 16 GB of swap in use, well beyond the 4 GB validity ceiling. No timing from this session is release evidence.
- Correctness remains frozen. Late data stripping is limited to exact EL/Ryū ranges and the static number-string seed; broader post-watr string/span reclamation was rejected after full-suite memory faults.

THE cross-session plan: current state, the seven-gate scorecard, the 4 GiB
self-compile strategies, and the remaining queue. Present tense; superseded
session-by-session history lives in `archive/handoff-2026-08-22.md`,
`archive/v1-architecture-campaign.md`, and `archive/todo.md` (grep those for
the story of how a number was reached: this file only states what's true
now and what's left).

## Current state

- **Current checkout battery** (branch base `dd92662e` plus this
  documentation-only consolidation): `npm test` reports 3,864 total,
  3,863 pass, 1 skip, 0 fail (28,541 assertions). Its kernel-parity and
  kernel-oracle groups pass. The narrow split separately recorded refactor
  oracle 560/560 and a 17,898,864-byte kernel, unchanged in size from its
  `a45ce6ca` baseline. A fresh full kernel-target suite is still required
  by the final gate; no merged-product total is inferred from the split
  branch's older battery.
- **test262 baseline at the branch base**: language 2,976 pass, 0 fail,
  21 xfail; negative split 3,908 reject / 137 accept. Builtins 858 pass,
  0 fail, 70 xfail. These values come from `test/test262-baseline.json`
  and supersede the older 3,003/54/3,858/187 and 853/86 figures retained
  in archived campaign measurements.
- **Warm self-compile perf gate**: RED, machine-sensitive: last read
  1.039–1.161× across sessions vs the unchanged 1.03× cap (V8-referenced,
  single-process wall-clock). Fresh-instance (new instance per compile) is
  reliably GREEN, 0.838–0.887× across the same sessions. **Attribution
  rule**: raw stopwatch deltas on this machine are not trustworthy signal
  (an unchanged artifact read 0.987×–1.161× run to run: four orphaned
  `strbuild` bench processes were once found eating a core for 8–11 days).
  Use same-process, order-alternated A/B artifact comparison to attribute a
  regression, not a bare before/after stopwatch. That method already found
  and closed one real regression (opaque `.length` double-dispatch: merged
  tree 1.041× → repaired 1.011× vs the pre-opaque baseline).
- **Competitive floor vs Porffor alpha 3** (exact commit `03b6b54f`,
  2026-08-27; `.github/workflows/bench.yml` fails if this exact rival isn't
  installed): anchored alpha-3 + jz `4c38662f`, 43/43 JZ wins including the
  `synth` FMA checksum. Runtime geomean 21.722× (jz faster), narrowest
  margin 1.865×. Artifact-byte geomean 63.865×, narrowest margin 4.981×.
  Porffor's 14 checksum divergences and 3 lab failures are excluded as
  non-wins. Same machine, Porffor's self-hosted compiler: 11.23 MB C from a
  2.10 MB bundle in 1.94–1.95 s (7/7), 251 MB RSS; full native output
  203.77 s / 1.89 GB. JZ's hosted self-build: 344.02 s / 3.91 GB RSS, 4.34 GB
  peak. An instrumented byte-identical rerun (348.42 s) attributes 119.25 s
  to watOptimize, 100.40 s to snapshotInit, 82.25 s to final encoding,
  42.15 s to semantic compile. **Caveat**: this snapshot raised swap to
  4.20 GB (above the 4 GB validity bound) and source moved on before the
  measurement finished: not release-certified. Rerun after reboot and
  source freeze (see Reference-refresh commands).
- **Full jz×jz self-compile (162 modules)**: still traps at exactly
  2^32 bytes (wasm32's ceiling), zero output bytes. Not closed: see
  "4 GiB self-compile" below for the mechanism and the two candidate
  strategies.
- **Open wrong-value pins at `dd92662e`**: four live families remain in
  `test/data.js`: the Shape #9 index-resolved member callee, the
  BigInt64Array box-forcing union store, an object-literal property holding
  an inline closure, and nested `a.b.c(...)` member dispatch. A separate
  host-constructed own-method shadow gap is recorded in
  `ledger-correctness.md` §4. All are release blockers under
  `STABILITY.md`; none is claimed complete.

## Seven-gate scorecard (2026-08-26, adopted)

1. **Soundness**: RED. The canonical call-target index landed, as did the
   Boolean join/throw and promoted-rest fixes. The four wrong-value
   families listed above remain exact-or-reject blockers. Every xfail still
   needs outcome classification: valid rejection, documented dialect, or
   accepted-wrong blocker.
2. **Performance**: RED. The strict per-case size gate landed in
   `105bdc18`, but 24/49 comparable cases were larger than AssemblyScript
   at gate landing. The dispatch dead-guard fold in `18690313` reduces one
   case without closing it. Speed evidence remains stale and red on 13/60
   wasm-rival rows; warm remains above the unchanged 1.03 cap in the last
   quiet-machine readings. Refresh only after source freeze.
3. **Full jz×jz goal**: RED. It traps at 2^32. The region path requires
   fixing the remaining dvnested region-live O2/O3 soundness trip before
   release-behind-the-cursor can ship. Choose it or streaming from measured
   prototypes, as described below.
4. **Language**: RED. The 137 exact accepted-invalid parser paths are v1
   blockers under `STABILITY.md:27-30`. Principled early rejection closes
   a path; silent acceptance does not.
5. **Architecture**: ORANGE. The call-target index, program-facts split and
   freeze audit, optimizer split, and narrow split landed. Open
   representation edges still produce the four wrong-value families. The
   broader large-file cleanup does not itself block v1.
6. **API/ABI**: GREEN. Pack rehearsal passes; `prepublishOnly` is red only
   via the performance gates above.
7. **Native target**: RED. watr-specific path: v1 needs a generic
   source→native command with fixtures, or the owner explicitly descopes
   the promise (owner decision, not yet made).

### Finish order (adopted)

1. Fix or reject the four live wrong-value families and the host shadow
   gap.
2. Close the region soundness trip, then choose the measured 4 GiB
   strategy.
3. Reject the 137 accepted-invalid parser paths by family.
4. Close general speed and size loss classes; freeze source and refresh
   evidence on a quiet machine.
5. Generalize the native target or record an owner decision to descope it.
6. Sweep status docs and run final gates: build, matrix, wasm-hosted,
   test262, bench, self, pack, release.

## Campaign 2026-08-28/29: integrate, audit, simplify

Owner's bar (verbatim intent): all branches integrated into main and
deleted; `.work` reduced to a minimal unified set; v1 readiness audited
honestly (CI red, washed-out requirements restored); size always smaller
than AssemblyScript per case (×1 gate); speed always faster than every
other wasm toolchain per case; jz compiles itself well; the compiler's
heaviness identified as an expert would, and rectified.

**Landed since the owner's `9da6a37c`** (each behind the gate: scratch
worktree at main HEAD → merge product → refactor oracle 560/560 identical
or every difference attributed → kernel build → kernel-parity 33/33 →
kernel-oracle 14/14 → pins → full suites on the landing product →
`--ff-only`): `ir.js` split (`17c8899e`); test registration (`47edac89`);
the walker-conversion batches, M1-M1d (`ba77ce78`, final drop `e79fc619`;
see `ledger-refactor.md` "Traversal-combinator retrofit"); string-method-guess
fix (`019af7fb`; 24 attributed oracle differences; `SIZE_BUDGET.watr` raised
to 300000); `kind.js` split (`a15ec98c`); dead-exports sweep (`a45ce6ca`;
−256/+52 lines, `src/ops.js` deleted); `archive/v1-readiness-audit.md` (`8986c2e2`);
shape8 pins (`29cf9895`: the shelved `fix/shape8-member-callee` retired: its
i64Hex fixes and Shape #8 itself were already on main; four sibling pins
ported, two new KNOWN-WRONG families: object-literal property assigned an
inline closure, and nested member `a.b.c(...)`: plus a BigInt64Array
store box/unbox hazard whose correct fix taints the self-hosted kernel [20
unrelated kernel-target failures; reverted, pinned KNOWN-WRONG in
`test/data.js`, root cause undiagnosed], and two incidental gaps:
cross-export bare BigInt64Array-element return host-tagging, and
`let y = (arr[0] = x)` re-widening).

### Branch-base reconciliation at `dd92662e`

- The strict `jz < AssemblyScript` per-case size gates landed in
  `105bdc18`. The gate is honest and red: 24/49 comparable cases were
  larger at landing. The general dispatch dead-guard fold landed in
  `18690313`; it reduced `dispatch` by 55 bytes but did not make that row
  smaller than AssemblyScript. See `ledger-performance.md`.
- The nine-commit narrow split landed. `src/compile/narrow.js` is now a
  30-line barrel; the 1,085-line `narrowSignatures` driver remains intact
  in `src/compile/narrow/index.js` for its measured shared-state reason.
- `emit-split.md` and `prepare-split.md` remain maps only. They are pending
  fold-in after those splits land. No self-compile-memory or parser-
  residual note exists in this branch base, so no completion is claimed.
- The 13/60 speed-red list remains: trace 1.562× c-wasm, shapes 1.431× AS,
  sdf 1.293× c-wasm, sort 1.209× zig, glyfparse 1.169× c, base64 1.145×
  tinygo, delayline 1.124× rust, lorenz 1.096× AS, fft 1.095× rust, crc32
  1.076× c, slices 1.067× c, radixsort 1.054× zig, vm 1.052× rust.
- The four wrong-value pins named in Current state remain. The Boolean
  join/throw and promoted-rest families are closed and are not queued.

Merge products are built in a gate worktree. Resolve conflicts against the
current structure and preserve both sides' intent; never take an entire
file merely to avoid a conflict.

**Files still over 3,000 lines at `dd92662e`**: `src/compile/emit.js`
8,167, `src/prepare/index.js` 4,452, `module/core.js` 3,535, and
`src/compile/index.js` 3,503. The optimizer, narrow, vectorizer, analyze,
kind, type, program-facts, representation-plan, and collection outliers
listed in older audits are below this threshold or split into barrels.

## 4 GiB self-compile: strategies and measurements

The full 162-module `jz×jz` self-compile (`default(code,0,0,modules,0)`)
traps at exactly wasm32's 2^32-byte ceiling with zero output bytes. This is
the last release-blocking memory wall (STABILITY.md; seven-gate scorecard
item 3).

**Mechanism** (Slice 6 compaction + region-live diagnostic, 2026-08-22):
compiler analysis records were moved to compact tuples/lazy collections
where the self-host previously paid a HASH allocation per query or per
empty field; FunctionPlans are tuple-packed and linearly retired after
their sole emission consumer; body/binding caches retire at the same
boundary. On the exact 162-module graph this cut `__alloc_hdr_n`
6,528,188 → 3,258,286 and `__hash_new_cap` 2,989,365 → 517,263 (further
cut to `__hash_new_small` 692,582 / fixed-cap collection blocks
636,658+503,892 / `__hash_new_cap` 517,263 by the 2026-08-26 general
allocation-compaction pass: down from 6,528,188 pre-Slice-6). A
diagnostic region-live build then survives front, planning, all named
emission, `pullStdlib`, and the pre-watr optimizer (576 exits) and reaches
the final module boundary: then exhausts wasm32 while copying/encoding
the already-large WAT IR (`memory=4,294,967,296`, heap within 144 bytes of
the ceiling, zero output bytes). An in-place watr cleanup experiment moved
the wall into string/code byte materialization but did not close it and
was reverted. `REGION_HOOKS_ACTIVE` remains **false** in source; the
shipped `dist/jz.wasm` is built region-disabled.

**Two candidate strategies, not yet chosen between:**

1. **Streaming/typed byte encoder** (then a compact HIR). The general
   next step per Slice 6: the final wall is the WAT tree and the output
   bytes coexisting in memory at once; a streaming encoder removes that
   coexistence requirement directly. Prerequisite work, not yet started.
2. **Region release-behind-the-cursor** (2026-08-26 candidate, from the
   manual-release line of thinking). Bytes are produced by *walking* the
   WAT tree, so per-function region-scoped subtrees can reset the moment
   their bytes emit ("free behind the cursor"). Tax-free by construction:
   release points are function boundaries, not object lifetimes: no
   refcount, no sweep, no per-allocation cost. Reuses the dormant region
   machinery (`REGION_HOOKS_ACTIVE`) rather than rewriting the encoder.
   Prerequisite: fix the one remaining region-live soundness trip (the
   dvnested mechanism's O2/O3 trap family: see `ledger-correctness.md`
   "region-release" for the closed/open sub-findings). Evaluate against
   the streaming encoder on: implementation size, whether
   `pullStdlib`/optimizer boundaries allow per-function region scoping,
   and native-path benefit (both strategies should also cut the native
   build's ~3.1 GB peak).

**Decision rule** (finish order item 3): choose from measured prototypes,
not from argument. Whichever closes the dvnested soundness trip and
demonstrates a real reduction on the 162-module graph first is the one
that ships.

**Precision-rung dead end** (2026-08-22, do not re-attempt without new
scope): a fail-closed local-def-site solver for `dynPointsTo` was
implemented and measured against the O3 self graph: 4,923 unresolved
local-receiver attempts, 0 resolved, 4,923 ALL (every sampled live def was
a call/member result, array element, global alias, or missing initializer
- never a literal/known-sid RHS). Artifact grew 3,218 bytes, native build
time moved 306.6→325.9 s, and the goal gate would show no codegen change.
Reverted completely. Closing this wall requires scope-stable result/kind
provenance for calls, elements and globals (or indexed HIR), not another
local-literal walker.

## Remaining queue

In priority order (finish-order items 1-2 and the soundness families are
tracked in `ledger-correctness.md`; this list is everything else):

1. **Wrong values**: CLOSED 2026-08-30/31 — every `test/data.js` family
   pin now reads "was KNOWN-WRONG" (fixed) and the STRING shadow twin is
   closed by the guess retirement (`ledger-correctness.md` §3). Still open
   there, unscheduled: §4's zero-closure host-hijack export-boundary gap.
2. **4 GiB self-compile**: fix the dvnested region soundness trip, then
   choose a strategy using the decision rule above.
3. **Parser residuals**: CLOSED 2026-08-30 — `test262-neg-accepts.json`
   count is 0 at the pinned corpus; any future accept is a release blocker.
4. **Pipeline minimality** (`ledger-refactor.md`):
   - `scanNumericFill` fold: DECLINED 2026-08-31 — attempted, two concrete
     gaps found in reconciling `numFillSafe`'s default-deny bare-string
     walk against `walk`'s array-only dispatch, plus a flow-sensitivity
     hazard in `valTypes` (`makeValTracker`'s poison-based join) that
     would make a clean corpus-diff weak evidence either way. See
     `ledger-refactor.md`'s "`scanNumericFill` fold — declined" for the
     full reasoning and the smaller, safe alternative left for a future
     session (batch `numFillSafe`'s K per-candidate walks into one, A1-
     style — does not itself close this item).
   - Audit `narrowSignatures`'s 1,085-line shared-state driver before any
     decomposition. Keep `inferTypedValueRanges` nested at 181 lines.
   - Split the four files over 3,000 lines listed above, beginning with the
     already-mapped emit and prepare files.
   - Typedarray `hasWrite`/`hasSameRead`/`safeRmwAst` combinator work and
     the six repeated vector load/store validators: CLOSED 2026-08-31 —
     `every()` added to `ast.js` as `some()`'s dual, `safeRmwAst` folded
     onto it; `tryGeneralStencil`/`tryGeneralMap`/`tryGeneralReduce`'s six
     verbatim `matchOffset`/`matchAddr` ports unified onto two new
     `addr-model.js` exports. See `ledger-refactor.md`'s "Typedarray
     `every()` combinator + the six vectorize load/store validators".
   - Revisit dormant zero-importer files only with an explicit owner
     delete-or-keep decision. `src/ops.js` itself is already deleted.
5. **Performance loss classes**: close the 24/49 size-red and 13/60
   speed-red sets through general engine work. Do not edit specimens.
6. **Reference refresh**: after source freeze, rerun the Porffor floor
   without swap pressure and refresh case-by-case speed, size, and memory.
7. **Native target**: generalize the watr-specific source-to-native path
   or record an owner decision to descope the promise.
8. **Final sweep and gates**: build, matrix, wasm-hosted, test262, bench,
   self, pack, release.

(A stale "schema-liveness scan" item was carried in this queue past its
own completion: `b8c858d9` (2026-08-26) already replaced the post-treeshake
`scanMkptrAux` WAT-text scan with the emission-time `.schemaSid` node tag
mkPtrIR/boxPtrIR now stamp — see `ledger-refactor.md` "Schema-liveness
scan" for the verification that closed it out.)

## Process rules (binding for any resumer)

- Serial merges only; every branch validates its **merge product** (merge
  main into branch, rebuild, battery) before merging back; bar is zero
  fails at the current suite total. Build before suites: stale `dist` is
  false-fails. `pwd`-verify before every git/build/test command.
- Git safety: no repo-wide commands (`stash`/`checkout`/`reset`/`clean`/
  `switch`/`restore`); stage named files only; the user is sole author (no
  `Co-Authored-By` / "Generated with"); never push/pull: the user pushes.
- `.work/todo-original.md` in the main worktree belongs to the user.
- Bench/demo sources are fixed specimens: fix the engine, never the input.
- Wrong-value classes outrank performance work. KNOWN-WRONG pins are trail
  markers with named flip conditions: zero allowed at release on semantic
  paths.
- Agents: never park on background-wake promises (they die); hold turns
  with chained bounded-wait loops (`for i in $(seq 1 27); do <check> &&
  break; sleep 15; done`, immediately followed by the next check). Zombie
  recovery: `TaskStop`, then `SendMessage` (resumes from the transcript at
  the exact stall point). Dead-man watch: file-driven watchlist +
  transcript-mtime staleness + main-HEAD moves.

## Reference-refresh commands

- **`memcheck-results.csv`** (jz-wasmtime vs moonrun peak-RSS evidence,
  `bench/README.md`'s "Where jz lands vs MoonBit" section): regenerate
  with `node bench/bench.mjs --cases=<case> --targets=jz-wasmtime,moonbit
  --json=<path>`, run **per-case** (or in small dedicated chunks), NOT as
  one bulk multi-case/multi-target invocation: a bulk run's `memKb`
  column carries a spurious uniform floor shift (the
  `c28f218c`/`2f0720a5`/`bce7d1d7` precedent), so narrow per-case isolation
  is load-bearing for the numbers, not just a style choice. `jz-wasmtime`
  is `bench.mjs`'s `--host wasi -O3 <case>.js → wasmtime --invoke main`
  lane (~:987); moonrun is the MoonBit-via-V8 wasm runner (~:1067-1083,
  needs `moon`/`moonrun` installed). Peak-RSS-via-`/usr/bin/time -l`
  machinery is `bench.mjs` ~:283-337. The CSV's `mem` column is peak RSS of
  the whole per-case process (engine + module), matching `bench/README.md`'s
  `mem` column contract.
- **`results.json`** (`bench/index.html`'s data source, the full
  speed+size table across every available target): `npm run bench`
  (= `node bench/bench.mjs`); add `--json` to persist, `--paired` for the
  release-verdict cross-round-median protocol, `--targets=`/`--cases=` to
  scope a rerun.
- **Porffor floor** (evidence.md "Porffor alpha 3" entries): pin the exact
  commit (`03b6b54f` as of this writing), fast-forward the local checkout,
  rerun on a quiet, freshly rebooted machine so swap never crosses 4 GB and
  source is frozen for the duration: the 2026-08-27 snapshot is not
  release-certified for exactly that reason.
