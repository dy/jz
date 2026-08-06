# Slice-1 pre-wiring measurement: per-round liveness vs churn (2026-08-06)

Mandated by `.work/region-arena-design.md` Risks §1: "measure round-liveness
first in Slice 1 with a probe before wiring." No region code was written —
this is the go/no-go instrument only.

## Method

**Fixpoint under test**: `node_modules/watr/src/optimize.js`'s `runRounds` —
the round loop `optimizeTail` (`src/optimize/watr-tail.js`) drives once per
compile, the loop the design names as Slice 1's boundary ("per-round
mark/exit with the round's surviving tree as root").

**Corpus**: pre-watr WAT trees, generated natively (`compile(src, {wat:true,
optimize:{level:2, watr:false}})`, the front/prepare/compile/emit output
watOptimize actually receives) for the three sizes named in the brief:

| corpus | source | graph modules | pre-watr WAT bytes |
|---|---|---|---|
| crc32 | `bench/crc32/crc32.js` | 1 | 38,177 |
| jzify-entry | `.work/jzify-entry.mjs` (406KB graph) | 70 | 14,599,472 |
| watr-graph | `bench/watr/watr.js` (104KB graph — the design's cited 4.3GB case) | 7 | 7,793,658 |

**Probe** (temporary, `node_modules/watr/src/optimize.js`, fully reverted —
see Restore below): a same-module `__RP` log array + `__rpDrain()` getter
(the established outline-hunt pattern — cross-module array-import mutation
does not propagate when this file is self-hosted), pushed at the top of
`runRounds` (round-0 baseline) and after every round's `dirty = next`:
`{round, dirty, liveNodes: count(ast), liveBytes: binarySize(ast)}`. A
second one-line probe made the round cap host-controllable:
`opts.__maxRounds ?? 6` in place of the hardcoded `6`.

**Native measurement** (live-tree size, per task step 2b): one call per
corpus through the patched `optimize()`, `__rpDrain()`'d after — gives
`liveNodes`/`liveBytes`/`dirty` at every round boundary directly. A native
churn cross-check (forced `global.gc()` + `process.memoryUsage().heapUsed`
per round) was attempted and is reported below, but turned out to be a
**live-size** proxy, not a churn proxy — see "Native churn cross-check" below.

**In-kernel measurement** (bump-pointer churn, per task step 2a, "the
authoritative churn number"): rather than rebuild the full 6.6MB
self-hosted `dist/jz.wasm` kernel per round value (minutes each, and shared
state a concurrent agent owns build artifacts near), this used the
established lighter substitute — a standalone **jz-compiled watr-optimizer
micro-kernel**, built once natively from `.work/watr-diff-entry.mjs`'s graph
(`parse`/`optimize`/`print` from `watr`, 7 modules, 1.08MB wasm, ~17s
build). It runs the *identical* patched `optimize.js` as self-hosted WASM
code, on the SAME own-memory bump arena (`module/core.js`'s `$__alloc`/
`$__heap`, exported as `__heap`) the full kernel uses — same mechanism
under test, far cheaper to iterate. `$__heap` is already host-exported, so
no mid-execution checkpoint call was needed: `opts.__maxRounds` gives
**runtime, not build-time**, control over how many rounds execute, so one
build serves every round-cap value. For each corpus and `__maxRounds =
0..6`, a **fresh instance** ran `default(watText, watrOptsJSON)`, then the
host read `exports.__heap.value`. Since the arena never frees intra-call and
allocation is monotonic, `heap(N) − heap(N−1)` is round *N*'s own
bump-pointer churn — an *exact* number, not a proxy, with zero in-wasm
instrumentation needed for the churn side.

**Scope isolation**: both native and in-kernel runs use jz's real level-2
`watrOpts` (`resolveWatrOpts(resolveOptimize(2), …)`: `guardRefine`,
`ifset`, `profile:'speed'`, the transcendental `pin` list) with the
**one-shot** post-round passes forced off (`devirt`, `licm`, `cse`,
`outline`, `inline`, `inlineWrappers`, `unroll2`, `guard`) — Slice 1's
proposed boundary is the round loop only; `finish()`'s one-shot passes run
outside it and would otherwise pollute the round-capped churn reading with
work that doesn't scale with round count. The exact isolated-opts JSON is
reused verbatim by both sides (an earlier pass of this probe used
slightly different opts on each side and got a spurious one-round
convergence mismatch — fixed by sharing one opts file).

## Per-round tables

### crc32 (38KB WAT — too small to be representative; overhead-dominated, kept for shape/sanity only)

| round | in-kernel churn (bytes) | live bytes (native) | live nodes | dirty funcs | ratio churn/live |
|---|---|---|---|---|---|
| 0 (parse+setup baseline) | 4,352,512 | 3,043 | 4,004 | — | — |
| 1 | 6,887,696 | 2,761 | 3,517 | 9 | **2495×** |
| 2 | 2,305,168 | 2,668 | 3,373 | 6 | **864×** |
| 3 | 2,300,680 | 2,652 | 3,348 | 3 | **868×** |
| 4 (confirm, no change) | 1,658,024 | 2,652 | 3,348 | 0 | **625×** |

### watr-graph (104KB source / 7.8MB pre-watr WAT — the design's own 4.3GB-peak case)

| round | in-kernel churn (bytes) | live bytes (native) | live nodes | dirty funcs | ratio churn/live |
|---|---|---|---|---|---|
| 0 (parse+setup baseline) | 2,196,750,472 | 372,309 | 480,039 | — | — |
| 1 | 749,695,744 | 320,071 | 402,575 | 343 | **2342×** |
| 2 | 333,967,440 | 317,838 | 397,938 | 112 | **1051×** |
| 3 | 286,226,488 | 317,139 | 396,891 | 44 | **903×** |
| 4 | 224,171,152 | 317,027 | 396,723 | 7 | **707×** |
| 5 (confirm, no change) | 181,956,480 | 317,027 | 396,723 | 0 | **574×** |

Round-loop total churn (rounds 1–5) = 1,776,017,304 B; heap at round-loop
end = 3,972,767,776 B (2196.75MB baseline + 1776.02MB round-loop). Matches
`maxRounds=6`'s raw reading exactly (convergence at round 5, round 6 is a
zero-delta confirmation of the cap).

### jzify-entry (406KB source / 14.6MB pre-watr WAT — "the one that exceeds 4GiB")

In-kernel: **exceeds the wasm32 4GiB ceiling before completing round 0**
(the parse+setup baseline alone traps `unreachable` via `__memgrow`'s
deliberate ceiling guard, same mechanism `kernel-memory-curve.md` already
named). This is the corpus item the task brief itself flags as the one
that exceeds 4GiB — the finding here *sharpens* that: the failure isn't
"many rounds compound," it's that a single non-round pass over a 14.6MB
tree already needs more arena than exists. Extrapolating the baseline
amplification factor (crc32: 38,177B → 4,352,512B, **114×**; watr-graph:
7,793,658B → 2,196,750,472B, **282×**, growing with size exactly as
`kernel-memory-curve.md` established) to jzify-entry's 14,599,472B WAT
projects **≥4.1GB at 282× alone**, before any round runs and before
accounting for the accelerating trend — consistent with the observed trap.

Native (no ceiling — plain V8) round table, for reference:

| round | live bytes | live nodes | dirty funcs |
|---|---|---|---|
| 0 | 713,948 | 938,394 | — |
| 1 | 620,144 | 796,731 | 666 |
| 2 | 612,846 | 785,755 | 246 |
| 3 | 612,392 | 783,909 | 95 |
| 4 | 613,284 | 783,320 | 26 |
| 5 | 613,143 | 783,027 | 9 |
| 6 | 613,121 | 782,997 | 3 (cap hit, not fully converged — passes are monotonic, so this leaves a few residual simplifications, not a correctness gap) |

### Native churn cross-check (inconclusive as a churn number — informative anyway)

Forced-`global.gc()` + `heapUsed` sampled at every round boundary landed
within roughly the *live-tree* range (e.g. watr-graph: ~115–180MB after GC,
vs. a ~373KB→317KB live tree plus V8's own retained overhead for the
whole compiler+data — not proportional to the in-kernel churn numbers
above at all). Read correctly, this is itself a finding: **V8's GC already
reclaims each round's garbage before the *next* round's allocations pile
on top** — exactly the behavior the wasm bump arena lacks, and exactly what
Slice 1 proposes to add back manually. It is not usable as a churn number
(a forced major GC erases the very garbage being measured), so the
in-kernel bump-delta stands as the sole churn number in the tables above,
per the task brief's own priority ordering.

## Verdict: **GO** for Slice 1, with a sharper arithmetic than the design's
## acceptance line implies

**Ratio test** (design's stated bar: ≥3× sustained → GO): churn/live is
**574×–2495× across every measured round of every corpus**, including the
"confirm" round that changes nothing. This isn't close to the 3× line —
Slice 1's premise (live-tree size ≉ per-round allocation) holds by two to
three orders of magnitude. A Cheney copy at each round boundary would
reclaim >99.8% of that round's bytes.

**But the absolute win from Slice 1 *alone* is smaller than "eliminate all
round churn" arithmetic suggests**, and doesn't reach the design's own
acceptance line ("watr-graph watermark 4.3GB → under ~1GB") on its own.
Per-round mark/exit removes *cross-round accumulation* — it does not shrink
a single round's own transient peak (many passes run inside one round;
Slice 1's root is "the round's surviving tree," not per-pass), and it does
not touch anything before round 1 (front/prepare/compile emission +
watOptimize's own pre-round setup — `computeCallEffects`, the NaN-fold
walk, `constF64Globals`, `deadset` — all currently un-freed and, at
2.197GB, **55% of watr-graph's round-loop-segment total**, is *larger*
than the entire round loop's churn).

Concretely, for watr-graph: today's round-loop-segment peak is
baseline(2196.75MB) + Σchurn(1776.02MB) = **3972.77MB**. Since round 1 is
always the single largest round (unfiltered — no `dirty` set yet, every
function is "work"; every corpus measured here shows round 1 dominating,
monotonically shrinking after), per-round regions cap the round-loop's own
contribution at round 1's own churn rather than the sum: new peak ≈
baseline(2196.75MB) + max-single-round(749.70MB) ≈ **2946.45MB** — a real
**979MB / 25.8%** cut (confirmed directly: this equals the measured
`maxRounds=1` reading), but nowhere near "under ~1GB." crc32 shows the same
shape at its own scale (17.50MB → 11.24MB, −36%).

**What this means for scope**: Slice 1 as designed (round-scoped only) is a
genuine, worthwhile, GO-able win — but reaching the design's stated
acceptance number needs it *paired with* Slice 2 (front boundary — the
2.2GB pre-round baseline is exactly "parse/jzify intermediates die; root =
prepared AST," Slice 2's stated scope) or a finer grain inside round 1
itself (the unfiltered first round, where every function is "work" with no
`dirty` narrowing, is the next-biggest single lever after the front
boundary — worth naming as a candidate Slice 1b, not in scope here). The
per-round mechanism should still be built as designed; the sizing claim in
the design doc's Slice 1 acceptance line should be revised to "material
reduction, full target needs Slice 1+2" rather than implying Slice 1 alone
clears it.

jzify-entry's ceiling-before-round-1 failure is itself evidence for the
same conclusion from the other direction: at that size, the *pre-round*
cost alone already exceeds 4GiB, so no amount of round-boundary compaction
(Slice 1's scope) can rescue that corpus — only a front-boundary region
(Slice 2) or a coarser jz-side reduction of the pre-watr tree can.

## Pointer-bit hazard inventory (Risk §2)

Per-site survey of consumers that compare or hash a value's **raw pointer
bits** rather than dereferencing through `__ptr_offset`'s forwarding
branch — each is a site where a Slice-1 relocation (round-boundary Cheney
copy) would silently misbehave unless explicitly re-keyed or invalidated at
the boundary, per the design's own mitigation ("boundaries are placed where
the ledger already documents cache flushes").

1. **`src/compile/emit.js` `emitLooseEq`/`emitStrictEq`, `REF_EQ_KINDS`
   path (~line 2854).** `==`/`===` between two `ARRAY`, `OBJECT`, `SET`,
   `MAP`, `BUFFER`, `TYPED`, `CLOSURE`, `REGEX`, or `DATE` values compiles
   to a raw `i64.eq` of the NaN-boxed pointer bits (`i64.reinterpret_f64`
   on each side) — no forwarding chase. This is JS's own object-identity
   semantics ("`==` on objects is pure reference equality — no content
   path," per the code's own comment), compiled the fast way. **Any user
   or self-hosted program comparing two references to what should be "the
   same object" across a round boundary breaks** if one side is a stale
   (pre-relocation) reference and the other post-relocation. Broadest,
   most consequential site — CLOSURE is included, so closure-identity
   comparisons (e.g. `fn === otherFn`) are in scope too.

2. **`module/collection.js` `$__map_set`/`$__hash_set`/`$__set_add`
   (object/array used as a Map/Set key).** The key crosses into these
   helpers as a raw `i64` (`asI64(...)` at the call site) and is used
   *both* to hash into a bucket *and* to test slot equality on lookup —
   the exact "hash table keyed on pointer bits" the design names by name.
   An object/array key that gets relocated becomes unfindable via any
   stale reference held past the boundary (silent miss, not a crash —
   the dangerous kind).

3. **`node_modules/watr/src/optimize.js`'s own round-loop bookkeeping —
   `snapshots` (`Map`, keyed by func-node object identity), `dirty`/`next`
   (`Set` of func-node objects), and `ast.indexOf(f)` (identity search).**
   This is the driver loop the region would wrap, not a downstream
   consumer — the closest, most load-bearing hazard site. It already has
   a *narrow* manual re-keying path for the one case it anticipates (a
   pass explicitly rebuilding a func root: `if (r !== f) { dirty.delete
   (f); dirty.add(r); snapshots.delete(f); snapshots.set(r, snap) }`), but
   has **no hook at all** for a region_exit silently relocating every live
   node between rounds — that class of update doesn't flow through this
   narrow path. Mitigating consequence, not correctness: `collectFuncs()`
   re-walks `ast` fresh every round and `snapshots`/`dirty` are rebuilt
   from that fresh walk each time, so a relocation between rounds
   degrades to "every function looks dirty next round" (safe, slower —
   loses the "extra rounds nearly free" dirty-filtering optimization)
   rather than silently miscompiling, *provided* region_exit always runs
   at a clean round boundary (never mid-round) and nothing external holds
   a snapshot/dirty-keyed reference across the boundary. `ast.indexOf(f)`
   is a plainer identity search with no such fallback — worth a direct
   look before wiring lands.

4. **Non-hazard, for contrast**: `hashNode` (the round-convergence
   check) hashes *structural content* (a rolling hash over token stream),
   not pointer bits — already the right shape, and the existing precedent
   for how bookkeeping should be keyed across a relocation boundary.
   `equal(a, b)`'s `a === b` fast path (native-JS-only pointer shortcut,
   used in the size-revert guard) degrades safely to its structural
   fallback on a miss — a false negative here costs one slower comparison,
   not a wrong answer.

Not exhaustively resolved (would need per-site fixes, out of this
measurement's scope) — this is the inventory the design brief asked for
before wiring, not the fix.

## Side finding (not fixed, flagged for the ledger)

Building the in-kernel micro-kernel first failed validation
(`i64.reinterpret_f64[0] expected type f64, found global.get of type i64`)
with a probe that referenced `typeof process !== 'undefined' ?
process.memoryUsage().heapUsed : 0` inside the compiled source — a genuine
jz self-host miscompile (host-global `typeof`-guard around an unresolved
identifier's method call), not touched here (out of scope, and the probe
doesn't need that field for the in-kernel path). Removing the two
`heapUsedAfterGC` fields from the shared probe made the same source compile
and validate cleanly. Worth a `.work/todo.md` line for whoever next hits
`typeof <unresolved-global>` in a self-hosted compile.

## Restore verification

- `node_modules/watr/src/optimize.js`: `rm -rf node_modules/watr && npm
  install watr@5.7.12 --no-save` (the pinned version, `package.json`).
  sha256 post-restore `7d1dd903…` — byte-identical to the pre-probe file
  saved before any edit.
- `dist/jz.wasm`: never touched (measurement used a standalone micro-kernel
  in the scratchpad, not the shared kernel build) — sha256
  `0f8b78e5…` unchanged, confirmed against the pre-task value.
- `git status`: clean except this doc + the ledger line and the
  concurrent agent's own pre-existing `module/array.js`/
  `test/array-methods.js`/`bench/trace/trace.wat` (not touched by this
  task).
- Sanity compile (`compile('console.log(1+2)', {})`) after restore:
  succeeds, 64 bytes.
- All probe artifacts (micro-kernel wasm, corpus WAT, sweep scripts, raw
  JSON) live under the session scratchpad, outside the repo.
