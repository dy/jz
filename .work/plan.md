# plan.md — the living plan

THE cross-session plan: current state, the seven-gate scorecard, the 4 GiB
self-compile strategies, and the remaining queue. Present tense; superseded
session-by-session history lives in `archive/handoff-2026-08-22.md`,
`archive/v1-architecture-campaign.md`, and `archive/todo.md` (grep those for
the story of how a number was reached — this file only states what's true
now and what's left).

## Current state

- **Matrix** (native/O0/O3/WASI, zero-fail floor): 3660/3659/0/1 core,
  WASI 3659/3658/0/1 as of the v1-architecture campaign's Slice 6 merge
  product. `dist/jz.wasm` 17,732.2 kB there (region-disabled build).
  Functional self-compile 21/21; kernel-parity 3/3 (33 byte-identical WAT
  rows); kernel-oracle 14/14 (605); ratchet 10/10; optimizer fixpoint 10/10.
- **test262**: language 2976 pass, 0 fail, 21 xfail; negative split 3908
  reject / 137 accept (the 2026-08-27 refresh; supersedes the earlier
  3003/54/3858/187 figures — `a47e3644` rejected 50 more exact paths with
  zero additions). Builtins 853 pass / 0 fail / 86 xfail (unchanged since
  Slice 5).
- **Warm self-compile perf gate**: RED, machine-sensitive — last read
  1.039–1.161× across sessions vs the unchanged 1.03× cap (V8-referenced,
  single-process wall-clock). Fresh-instance (new instance per compile) is
  reliably GREEN, 0.838–0.887× across the same sessions. **Attribution
  rule**: raw stopwatch deltas on this machine are not trustworthy signal
  (an unchanged artifact read 0.987×–1.161× run to run — four orphaned
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
  measurement finished — not release-certified. Rerun after reboot and
  source freeze (see Reference-refresh commands).
- **Full jz×jz self-compile (162 modules)**: still traps at exactly
  2^32 bytes (wasm32's ceiling), zero output bytes. Not closed — see
  "4 GiB self-compile" below for the mechanism and the two candidate
  strategies.
- **Open KNOWN-WRONG pins**: see `ledger-correctness.md` for the
  family-by-family record (symptom, root cause, fix or pin, gate). None
  are release-blocking silently — STABILITY.md's rule is that v1 does not
  ship with any open pin on a semantic path.

## Seven-gate scorecard (2026-08-26, adopted)

1. **Soundness** — RED. Member-call provenance (Shape #8) in flight as a
   canonical call-target index (finish-order item 1). Newly exposed
   accepted-wrong families hiding as test262 xfails: 17 Boolean join/throw
   carrier (`x = false ?? 1` → number 0; `throw true` catch → number 1), 12
   promoted-rest (`const [...x]=[1]; Array.isArray(x)` → false at O1-O3).
   Both violate STABILITY.md:10-22 and must become exact or reject; every
   xfail needs outcome classification (valid-rejected OK / dialect OK /
   accepted-wrong BLOCKING).
2. **Performance** — RED. Fresh local geomeans are strong (0.492× V8,
   0.503× AS, 0.726× native C, size 0.885× AS) but 7 strict per-case misses
   remain, warm is 1.123–1.163× vs the 1.03× cap, and perf-fuzz is red on
   float/mixed. Refresh only after code freeze — do not burn reference
   evidence before the wrong-value fixes land.
3. **Full jz×jz goal** — RED. Traps at 2^32, heap -16. The region path
   requires fixing the one remaining dvnested region-live O2/O3 soundness
   trip before release-behind-the-cursor can ship; choose streaming vs
   release-behind-the-cursor from measured prototypes (see "4 GiB
   self-compile" below).
4. **Language** — RED. The 187 (now 137, post-`a47e3644`) exact parser
   accepts are v1 blockers under STABILITY.md:27-30's own text —
   principled early rejection counts as closure, silent acceptance
   doesn't.
5. **Architecture** — ORANGE. Call-target authority and program-facts
   separation block v1 because they cause wrong-value classes; the broader
   181-walker/large-file cleanup (pipeline minimality) does not block v1.
6. **API/ABI** — GREEN. Pack rehearsal passes; `prepublishOnly` is red only
   via the performance gates above.
7. **Native target** — RED. watr-specific path: v1 needs a generic
   source→native command with fixtures, or the owner explicitly descopes
   the promise (owner decision, not yet made).

### Finish order (adopted)

1. Call-target index + flip the `ns.parse` pin.
2. Boolean-join/throw-slot/promoted-rest families — fix or reject.
3. 4 GiB via measured-prototype choice (region soundness trip first).
4. 187/137 parser residuals.
5. Freeze source → reference refresh → close general loss classes + warm.
6. Native: generalize or descope.
7. Status-doc sweep + final gates (build, matrix, wasm-hosted, test262,
   bench, self, pack, release).

## Campaign 2026-08-28/29 — integrate, audit, simplify

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
−256/+52 lines, `src/ops.js` deleted); `v1-readiness-audit.md` (`8986c2e2`);
shape8 pins (`29cf9895` — the shelved `fix/shape8-member-callee` retired: its
i64Hex fixes and Shape #8 itself were already on main; four sibling pins
ported, two new KNOWN-WRONG families — object-literal property assigned an
inline closure, and nested member `a.b.c(...)` — plus a BigInt64Array
store box/unbox hazard whose correct fix taints the self-hosted kernel [20
unrelated kernel-target failures; reverted, pinned KNOWN-WRONG in
`test/data.js`, root cause undiagnosed], and two incidental gaps:
cross-export bare BigInt64Array-element return host-tagging, and
`let y = (arr[0] = x)` re-widening). Every pre-existing branch is deleted;
the only branches are the live campaign branches below.

**Live** (one agent each, own scratch worktree, lands only through the
gate):
- `refactor/emit-split`, `refactor/prepare-split` (the mapped splits; then
  `core.js`, `compile/index.js`) — **pending fold-in**, see README.md.
- `perf/size-leadership` — strict per-case `jz < AssemblyScript` gate
  written into `test/bench.js` + `bench-claims`, then engine fixes by
  shape-class. 24/49 cases red at campaign start, worst wordcount 4.705×,
  shapes 1.783×. See `ledger-performance.md`.
- `perf/self-compile-memory` — measured attribution of the 4 GiB wall,
  strategy by prototype, output-identical steps under the oracle —
  **pending fold-in**, not yet landed in this .work snapshot.
- `fix/parser-residuals` — 137 accepted-invalid families → early
  rejection, native + kernel, exact-set ledger.
- Expert heaviness audit → `audit.md` (merged from `core-simplification-audit.md`).

**Queued behind the emit split** (they edit `emit.js`; timing needs a quiet
machine):
- Speed reds vs wasm rivals, 13/60 cases: trace 1.562× c-wasm, shapes
  1.431× AS, sdf 1.293× c-wasm, sort 1.209× zig, glyfparse 1.169× c,
  base64 1.145× tinygo, delayline 1.124× rust, lorenz 1.096× AS, fft
  1.095× rust, crc32 1.076× c, slices 1.067× c, radixsort 1.054× zig, vm
  1.052× rust.
- Wrong-value families: Boolean-join/throw-slot (17), promoted-rest (12),
  the closure-materialization pin (`test/data.js` ~2452), the two shape8
  sibling families, the BigInt64Array store hazard.
- `.work` consolidation to a minimal set (citations from code comments
  updated in the same commit) — **this document**.
- Reference refresh on a quiet machine after source freeze, CI green.

Process note: subagents cannot `git merge` (permission classifier) — merge
products are built in a gate worktree; conflicts are resolved by hand
against main's current structure, never by taking a whole file from one
side.

**Files still >3k lines** (pipeline-minimality backlog, re-measured
2026-08-28): `emit.js` 8129–8167, `prepare/index.js` 4430–4452,
`optimize/index.js` 5537 (split in flight), `narrow.js` 3934–4027,
`collection.js` 3974, `compile/index.js` 3476–3503, `core.js` 3474–3535,
`analyze.js` 3301, `typedarray.js` 3055, plus `vectorize.js` 8500.

## 4 GiB self-compile — strategies and measurements

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
allocation-compaction pass — down from 6,528,188 pre-Slice-6). A
diagnostic region-live build then survives front, planning, all named
emission, `pullStdlib`, and the pre-watr optimizer (576 exits) and reaches
the final module boundary — then exhausts wasm32 while copying/encoding
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
   release points are function boundaries, not object lifetimes — no
   refcount, no sweep, no per-allocation cost. Reuses the dormant region
   machinery (`REGION_HOOKS_ACTIVE`) rather than rewriting the encoder.
   Prerequisite: fix the one remaining region-live soundness trip (the
   dvnested mechanism's O2/O3 trap family — see `ledger-correctness.md`
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
implemented and measured against the O3 self graph — 4,923 unresolved
local-receiver attempts, 0 resolved, 4,923 ALL (every sampled live def was
a call/member result, array element, global alias, or missing initializer
— never a literal/known-sid RHS). Artifact grew 3,218 bytes, native build
time moved 306.6→325.9 s, and the goal gate would show no codegen change.
Reverted completely. Closing this wall requires scope-stable result/kind
provenance for calls, elements and globals (or indexed HIR), not another
local-literal walker.

## Remaining queue

In priority order (finish-order items 1-2 and the soundness families are
tracked in `ledger-correctness.md`; this list is everything else):

1. **4 GiB self-compile** — pick a strategy per "4 GiB self-compile" above,
   after the dvnested region soundness trip is fixed.
2. **137 parser residuals** — `fix/parser-residuals`, exact-set ledger,
   native + kernel early rejection.
3. **Schema-liveness scan** re-derives facts from emitted WAT
   (`compile/index.js` ~:3158-3273) instead of an emission-time used-sid
   fact — wrong-level architecture, audit-flagged (seven-gate item 5).
4. **Pipeline minimality**, same campaign as the traversal retrofit
   (`ledger-refactor.md`), queued after M1d:
   - `analyzeBody` 6 → 5 traversals: fold `scanNumericFill` (walk-count
     design A2; needs its own assert-gated old-vs-new run).
   - Outlier functions (re-measured 2026-08-28, the audit's list was
     partly stale): `genUpsertStrictPrehashed` (~2.5k ln, `collection.js`,
     blocked on main's uncommitted edits inside it); `narrowSignatures`
     (1,085 ln, `narrow.js` default export — one mutable `sharedSiteState`
     shared by ~20 nested closures for a measured perf reason, needs its
     own audit, see `ledger-refactor.md` narrow-split §6); `emitInstanceof`
     already split to 14 lines; `inferTypedValueRanges` (181 ln) stays
     nested, zero reuse payoff from hoisting.
   - The >3k-line file list above.
   - `some()` needs a `boundary` option follow-up is DONE (landed batch 3);
     remaining follow-ups: module/typedarray.js `hasWrite`/`hasSameRead`
     and `safeRmwAst` combinator; the six verbatim load/store validator
     ports across vectorize map/stencil/reduce (one walker copied six
     times — a semantic DRY slice, not a mechanical swap);
     `optimize/index.js`'s 19 walker sites once `refactor/optimize-split`
     lands, in the new modules.
   - `src/ops.js`-class dormant/zero-importer files: owner delete-or-keep
     decision, not taken during the retrofit.
5. **Speed-tail cases** — the 13/60 wasm-rival misses under Campaign
   2026-08-28/29 above, queued behind the emit split.
6. **Wrong-value families** queued behind the emit split (Boolean-join/
   throw-slot, promoted-rest, closure-materialization pin, shape8
   siblings, BigInt64Array store hazard) — tracked family-by-family in
   `ledger-correctness.md`.
7. **Reference refresh** on a quiet machine after source freeze (Porffor
   floor rerun without the swap ceiling breach; full case-by-case speed/
   size/memory refresh) — see Reference-refresh commands below.
8. **Native target**: generalize the watr-specific source→native path or
   have the owner descope the promise.
9. **Status-doc sweep + final gates** once 1-8 are closed: build, matrix,
   wasm-hosted, test262, bench, self, pack, release.

## Process rules (binding for any resumer)

- Serial merges only; every branch validates its **merge product** (merge
  main into branch, rebuild, battery) before merging back; bar is zero
  fails at the current suite total. Build before suites — stale `dist` is
  false-fails. `pwd`-verify before every git/build/test command.
- Git safety: no repo-wide commands (`stash`/`checkout`/`reset`/`clean`/
  `switch`/`restore`); stage named files only; the user is sole author (no
  `Co-Authored-By` / "Generated with"); never push/pull — the user pushes.
- `.work/todo-original.md` in the main worktree belongs to the user.
- Bench/demo sources are fixed specimens: fix the engine, never the input.
- Wrong-value classes outrank performance work. KNOWN-WRONG pins are trail
  markers with named flip conditions — zero allowed at release on semantic
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
  one bulk multi-case/multi-target invocation — a bulk run's `memKb`
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
  source is frozen for the duration — the 2026-08-27 snapshot is not
  release-certified for exactly that reason.
