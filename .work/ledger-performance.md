# ledger-performance.md: size/speed/memory/compile-time campaigns

Size, speed, memory, and compile-time work are tracked as campaigns rather
than one-off findings. This ledger contains the size-leadership campaign
from `archive/size-leadership.md`. At branch base `dd92662e`, no separate
self-compile-memory note had landed, so no result from that work is claimed
here. Existing 4 GiB allocation counts and region measurements remain in
`plan.md` and the dated entries in `evidence.md`; they are not duplicated.

---

## size-leadership: jz wasm strictly smaller than AssemblyScript, per case

Owner's bar (verbatim, from the campaign brief): produced size must be
ALWAYS smaller than AssemblyScript: ×1, per case, hard. Not geomean, not
par-or-tie.

Iron rule (`AGENTS.md` "optimize the tool, never the input"): bench
sources under `bench/` are fixed specimens. Every byte saved must come
from the engine. A fix that helps one named case only is the wrong fix.

Method: `scripts/bench-size.mjs --json` for ground-truth byte totals (jz
`optimize:'size'` vs `asc -Oz --converge --runtime stub --noAssert`, both
compiled fresh, deterministic, offline). Per-case attribution is from
`wasm-objdump -h`/`-x`/`-d` section/segment/function breakdowns and
`compile(src, {wat:true})` named WAT, cross-checked with isolation
experiments (scratch variants of the real bench source, never the
committed file) and static reads of the compiler's own devirtualization
code. Measured at HEAD `105bdc18` (branch tip after the Phase 1 gate
commit); byte counts drift a few bytes as the compiler changes but the
shape-class attribution is structural, not a snapshot.

### 1. Gate status (Phase 1: landed, commit `105bdc18`)

`test/bench.js` and `test/bench-claims.js` assert `jz bytes < AS bytes`
per case, hard, over the full bench corpus (not the old curated ~30-case
`SIZE` table's win/tie subset): commit `105bdc18` "size gate: strict
per-case jz < AssemblyScript". `SIZE_TOL`/win/tie/todo no longer gate
anything; the `SIZE` object's per-case prose stays as shape-class
narrative.

**Red list at gate landing: 24/49 comparable cases, geomean 1.042×**
(fresh `scripts/bench-size.mjs --json` at HEAD; this was the Phase-3 diff
baseline):

| rank | case | jz B | AS B | ratio |
|---:|---|---:|---:|---:|
| 1 | wordcount | 16372 | 3480 | **4.705×** |
| 2 | shapes | 3023 | 1695 | **1.783×** |
| 3 | fft | 2384 | 1758 | 1.356× |
| 4 | tokenizer | 2094 | 1551 | 1.350× |
| 5 | resample | 1933 | 1463 | 1.321× |
| 6 | slices | 2146 | 1657 | 1.295× |
| 7 | glyfparse | 3082 | 2408 | 1.280× |
| 8 | immutable | 1851 | 1481 | 1.250× |
| 9 | sdf | 2737 | 2209 | 1.239× |
| 10 | bezfit | 3624 | 3017 | 1.201× |
| 11 | noise | 2168 | 1868 | 1.161× |
| 12 | delayline | 1656 | 1470 | 1.127× |
| 13 | dispatch | 1813 | 1614 | 1.123× |
| 14 | raytrace | 2242 | 2007 | 1.117× |
| 15 | lz | 2126 | 1910 | 1.113× |
| 16 | matmul | 1384 | 1285 | 1.077× |
| 17 | heat | 1445 | 1364 | 1.059× |
| 18 | synth | 1895 | 1797 | 1.055× |
| 19 | mat4 | 1522 | 1456 | 1.045× |
| 20 | particle | 1609 | 1549 | 1.039× |
| 21 | spmv | 1935 | 1897 | 1.020× |
| 22 | biquad | 1858 | 1830 | 1.015× |
| 23 | nbody | 2205 | 2174 | 1.014× |
| 24 | aos | 1972 | 1957 | 1.008× |

25/49 already won (strict `<`) at gate landing.

### 2. Section-level attribution (all 24 red cases)

`wasm-objdump -h` section sizes, jz minus AS, reconciled to the totals
above (residual "other" absorbs module-header/section-length framing, never
more than ±13B: confirms the accounting is sound):

| case | gapB | codeGap | dataGap | globalGap | exportGap |
|---|---:|---:|---:|---:|---:|
| wordcount | 12892 | +2187 | **+10566** | +75 | +30 |
| shapes | 1328 | +1466 | −172 | +27 | +30 |
| fft | 626 | +679 | −131 | +65 | +30 |
| tokenizer | 543 | +686 | −207 | +46 | +30 |
| resample | 470 | +503 | −131 | +101 | +30 |
| slices | 489 | +497 | −131 | +125 | +30 |
| glyfparse | 674 | +705 | −114 | +108 | +30 |
| immutable | 370 | +524 | −172 | +27 | +30 |
| sdf | 528 | +546 | −131 | +120 | +30 |
| bezfit | 607 | +574 | −131 | +180 | +30 |
| noise | 300 | +293 | −131 | +161 | +30 |
| delayline | 186 | +287 | −131 | +41 | +30 |
| dispatch | 199 | +406 | −265 | +46 | +43 |
| raytrace | 235 | +268 | −131 | +101 | +30 |
| lz | 216 | +308 | −114 | +48 | +30 |
| matmul | 99 | +191 | −131 | +41 | +30 |
| heat | 81 | +185 | −131 | +29 | +30 |
| synth | 98 | +26 | −53 | +118 | +30 |
| mat4 | 66 | +157 | −131 | +41 | +30 |
| particle | 60 | +109 | −131 | +77 | +30 |
| spmv | 38 | +178 | −243 | +101 | +30 |
| biquad | 28 | +208 | −243 | +53 | +30 |
| nbody | 31 | +49 | −131 | +101 | +30 |
| aos | 15 | +189 | −233 | +51 | +30 |

**Universal patterns, 24/24 cases**: CODE is always larger in jz (+26 to
+2187B): the dominant, sole loss driver on 23/24 cases (everything but
wordcount). DATA is always SMALLER in jz except wordcount: not a loss
driver; AS's runtime carries a bigger fixed floor (214B vs jz's 83B) for
the NaN/Infinity/error-string table every module needs. GLOBAL is always
larger in jz (+27 to +180B, see §3 below: mostly legitimate/deliberate,
not free bytes). EXPORT is always +30B (+43 for dispatch), fully explained:
`__heap` and `__jz_last_err_bits` are exported by design (external
inspection / the no-EH trap-decode host contract); AS exports neither -
**not a fix target**.

### 3. Shape-class findings

**3.1 `wordcount` (4.705×): dynamic-dictionary + ToString/Ryu pull-in.
BLOCKED externally.** Isolation (3 scratch variants): replacing
`counts[w]=...` (a plain-object dictionary keyed by a runtime string) with
`new Int32Array(NWORDS)` collapses the module 16372B→3461B -
**≈79% of the whole case is the dynamic-object dictionary machinery**.
Varying `NWORDS` 512→32 changes output by 3 bytes (cost is not
proportional to vocabulary size: the data segments are domain-size-
independent fixed infrastructure: `wasm-objdump -x -j Data` shows two
segments, 5560B and 4505B, both constant across the sweep, consistent
with Ryu shortest-round-trip float→string lookup tables). `archive/todo.md`
(2026-07-29) independently named this and then self-corrected the exact
mechanism in the same session (first: `__str_concat` pulls in `__to_str`
via an unproven-operand arm; corrected: `__str_concat` was already
stratified; `__dyn_set`/`__dyn_get_t` is the monolith, and its
`ToPropertyKey` pulls `__to_str`): not refereed between the two, but both
name the same family (an unproven-operand coercion helper reachable from
wordcount's dynamic-object machinery unconditionally drags in the whole
ToString/Ryu formatter), consistent with the isolation result either way.
**Fix is already designed and BLOCKED, not open**: a helper-stratification
attempt (split the concat/dyn-property helper's strings-only core from
its ToString-coercing wrapper) triggers a LATENT WATR INLINER BUG in the
vendored dependency (`a.name=7;a.shift()` → wrong result; `JSON.parse` +
computed-key read → wrong result). Installed watr is `5.9.3`, matching
`package.json`'s `^5.9.3` pin: no record of which watr version the bug
was filed against, so a version bump alone doesn't prove it's fixed;
re-verify by attempting the stratification and checking for the same
corruption repros before trusting a retry.

**3.2 `shapes` (1.783×): megamorphic union representation. Needs
redesign, not a quick fix.** An 8-schema closed union defeats schema-slot
inference, so every field read lowers through the generic `__dyn_get`
dynamic-property probe. `bench/README.md`'s prior speed-axis analysis
claims "op census ≤ AS": this session's fresh size-axis measurement
contradicts that: jz's Code section is 2720B vs AS's 1254B (+1466B, 2.17×
AS's code alone). Either that claim was scoped to a different build
(speed preset, not `optimize:'size'`) or it has drifted: treat the
size-axis gap as genuinely open, not settled. The known lever ("shape-set
devirt": specialize the union's runtime representation once the closed
set of concrete shapes is provably enumerable) is a representation-level
change, not a bug fix.

**3.3 `dispatch` (1.123× → 1.089×): closure-table calling convention.
LANDED.** Named WAT dump of `dispatch.jz.wasm` (8 capture-free arrows
dispatched via `ops[code[i]](x, ks[i])`) shows `devirtConstFnArrayCalls`
(`src/optimize/devirt.js:407`) already recognizes the const-array-of-
arrows pattern and inlines each arm directly instead of paying
`call_indirect`. **Root cause**: every closure body gets a uniform ABI
(`$__env f64, $__argc i32, $__a0..a{W-1} f64`) regardless of real arity;
reading an `$__aN` param goes through the generic f64-boxed-to-i32 coercion
- `select(i32.wrap_i64(trunc_sat(tee L E)), 0, f64.ne(local.get L, C))`.
For `dispatch`'s own call site, `E` is `f64.convert_i32_s(i32.load(...))`
(provably `[-2^31, 2^31-1]`) and `C` is `+Infinity`, which no such
conversion can ever produce: a compile-time-decidable tautology that
doesn't fold because it's one level removed behind the very `local.tee`
that also produces the value everything else needs (`peephole.js`'s
existing `f64.eq`/`f64.ne`+`intK` fold only matches the direct form; it
also runs *before* `devirtConstFnArrayCalls` in `optimize/driver.js`, so
it never sees the spliced-in arm at all). **Fix** (`devirt.js`,
`foldImpossibleConvertGuards`): recognizes the exact `select(...)` shape
and, when `E` is a provably-int-range conversion and `C` is unreachable
from it, replaces the whole `select` with `trueVal`, keeping the dead
`tee` for a later dead-local sweep to clean up. **Verified**:
`bench-size.mjs --json` byte-identical on all 59 other cases; `dispatch`
alone 1813→1758B (−55B, 1.123×→1.089×); `refactor-oracle.mjs check --ref
8986c2e2` found exactly 3 differences, all in `bench:dispatch`, all pure
reductions (O2 1965→1896, O3 2074→2066, size 1813→1758). **Does not close
`dispatch`**: needs ≥145B more; the shape-class ("a devirtualized
closure-table arm still carries its callee's fully-generic per-parameter
unbox guard, invisible to the dead-guard fold through the callee's own
`local.tee` reuse") is closed everywhere it recurs. It reduced this row
but did not make it green. Remaining ~340B
unattributed (likely the diffuse backend-maturity tax of §3.4).

**3.4 The numeric-kernel long tail** (matmul, heat, particle, spmv, nbody,
mat4, biquad, raytrace, delayline, bezfit, noise, resample, slices, synth,
fft): diffuse backend-maturity gap, no single fix point found.
Deep-dived `matmul` (smallest, cleanest representative, gap 99B/191B
code): the kernel function itself is 149B, zero bounds checks, zero
calls, textbook-optimal: not a proof gap. `__alloc`/typed-array header
writer (190B+50B) is legitimate, already-tuned infrastructure. `main`
(712B) fully inlines the warmup loop, timed loop, median, and checksum
(single call site each → correct size decision): AS keeps the same logic
in 7 separate small functions (`glyfparse.as`: 19 AS functions vs jz's 6),
totaling 912B vs jz's 1103B. **Conclusion**: AS gets a multi-pass,
iterative binaryen `-Oz --converge` fixpoint optimizer for free; jz's
single-pass emission leaves comparable "final assembly" slack: the same
phenomenon `test/bench.js`'s own `WASMOPT_SLACK_MIN` self-check already
tracks (`wasm-opt -Oz` finds ~25-30% slack in jz's raw output; 20/24 red
cases shrink under `wasm-opt -Oz`, sometimes 5-8%, per `bench-size.mjs
--json`'s `jz_wasmopt` column). Real, but not one bug or one bounded
shape-class: distributed across inlining-heuristic tuning, local-slot
allocation, and watr's own peephole coverage vs. binaryen's. Closing it
needs either (a) a new multi-pass size-fixpoint optimizer inside jz
(large, multi-week-scale) or (b) integrating an external optimizer into
the compile pipeline (an architecture decision: jz currently has zero
native-binary dependencies; `wasm-opt` is an offline diagnostic only,
never in `compile()` itself).

`sdf`/`glyfparse` additionally carry the **checked-read** shape-class
already diagnosed for the speed axis (`test/bench.js`'s `WASM_TODO`): a
data-dependent cursor defeats the interval-proof machinery that already
closed this class for `aos`/`sort`/`hash`/`base64`/`wav`/`conv2d`
(checked-by-default typed indexing, collapsed via watr 5.5.0 intguard +
the cross-function `PARAM TYPEDLEN` channel + the S2 loop-body fixpoint).
The lever (runtime-bound versioning: guard once per glyph instead of once
per byte) is named but not implemented for a data-dependent cursor.
`fft`/`synth`/`tokenizer` carry a named-but-unquantified "transcendental
helper pull-in" cost (poly-sin/twiddle tables): no deeper lever on
record.

**3.5 `immutable`/`aos` (closed-shape records, not dynamic dictionaries).**
`{x,y,vx,vy}`/`{x,y,z}` are fixed-shape record literals. `aos` sits at
1.008× (in-place replace-stores, packed-i32-cell field stores already
land). `immutable`'s 524B code gap: `wasm2wat` confirms **zero** calls to
`$__alloc` (the replace-store is already scalar-replaced in place,
matching `aos`): but the store site still pays a header-resize/forwarding
check (an `i32.load` at header offset −4, range-tested, then a conditional
`$__zomb_scan` forwarding-pointer resolution before the field stores) -
the general dynamic-element-store path, not a "provably fixed length, no
grow/forward check" fast path, even though `ps` is built once and only
ever replaced element-by-element. **Confirmed a real gap, not a
mis-firing existing proof**: `src/compile/program-facts/param-never-
grown.js`'s own doc restricts it to a param the body only ever purely
READS (its motivating example is wordcount's read-only `words`; `ps[i] =
{...}` writes, disqualifying it by design); `scanNeverGrown` is scoped to
fresh-literal LOCALS built and consumed within one function (`ps` crosses
`initParticles()` → `runKernel()`). The gap: no existing proof covers "a
param array that's provably only ever element-replaced (never resized)
across its whole reachable callee graph": a natural generalization of
`param-never-grown.js`'s read-only proof (same activation-scoped
graph-closure argument, extended from reads-only to reads-and-same-index-
replacements), bounded in spirit but new analysis, needing its own design
pass first (same discipline as §3.2).

### 4. Hypotheses tested and DISPROVEN (do not re-chase)

1. **"f64-constant hoisting into globals is wasteful for single-use
   constants."** Checked `bezfit` (14 hoisted f64 globals, +180B Global
   gap, the corpus's largest): every constant is used ≥2 times
   (`global.get` reference counts 2-14); break-even for hoist-vs-inline is
   2 uses. **The hoisting policy is already correct**: the gap is
   inherent to bezfit's source having 14 distinct repeated literals.
2. **"`$__heap_end` (i32) and `$__heap_end64` (i64) are redundant shadow
   globals."** The i64 shadow is an explicit, commented micro-optimization
   (`module/core.js:486`, `module/collection.js:1537/2014/2202`): hash-
   table probe loops read the cached i64 global instead of recomputing
   `i64.shl(i64.extend_i32_u(memory.size), 16)` every iteration. Removing
   it costs MORE bytes at every read site and regresses speed.
   **Deliberate, not a bug.**
3. **"The `'size'` optimize preset doesn't disable loop-unroll-for-small-
   constant-bounds."** `src/optimize/config.js`'s `size` preset already
   sets `smallConstForUnroll: false`, `nestedSmallConstForUnroll: false`,
   plus 15+ other speed-only flags explicitly off with individual byte-cost
   comments. **Already exhaustively tuned**: no missed off-switch.

Most of what remains lives in (a) two large, already-diagnosed,
currently-blocked-or-unscoped cases (wordcount, shapes), and (b) a
diffuse, no-single-fix backend-maturity tax across the numeric-kernel tail
(§3.4). One precisely-located dead-code residue (dispatch, §3.3) was
fully traced and landed.

### 5. Phase 3 status: one fix landed, full battery green

**Landed**: the dispatch closure-table dead-guard fold (§3.3). Full
verification battery green at landing: `npm run build`, `node
test/index.js`, `node test/kernel-parity.js`, `node test/kernel-oracle.js`,
`node test/pointers.js`, `node test/data.js`, and
`JZ_TEST_TARGET=jz.wasm node test/index.js`.

**Why nothing else landed**: every other lever with real byte impact
requires either an external-dependency fix outside this repo (wordcount,
blocked), a representation redesign needing its own design pass (shapes),
or a genuinely large, multi-week-scale optimizer feature (the numeric-
kernel tail): none landable, fully implemented and battery-verified, in
one session. Three plausible "quick, mechanical, safe" fixes were
investigated and disproven (§4) rather than shipped speculatively; one
real one (§3.3) was traced to a verified, scoped, landable fix and
shipped.

**Ranked next steps, by expected value:**

1. **`immutable` §3.5**: a cross-function "never-grown, element-replace-
   only param" proof (generalizing `param-never-grown.js`'s read-only
   proof) would remove the resize/forwarding check the replace-store site
   still pays. Real, scoped gap; still new analysis work.
2. **`sdf`/`glyfparse` checked-read residue §3.4**: extend the existing
   S2 loop-fixpoint / runtime-bound-versioning mechanism (already closed
   for 6 other cases) to data-dependent cursors. Named lever, prior
   precedent, nontrivial (the versioning itself is the hard part).
3. **`dispatch`'s remaining ~340B §3.3**: arm 0's `+` path and the 8
   standalone closure bodies kept for the `call_indirect` fallback are
   untouched by the landed fix; worth a fresh WAT census now that the
   dead-guard noise is gone.
4. **`wordcount` §3.1**: re-check only after confirming the blocking watr
   inliner bug is fixed upstream; do not re-attempt the helper-
   stratification approach blind.
5. **`shapes` §3.2**: needs a design pass first (shape-set devirt is a
   representation change); highest single-case byte value (1328B) but
   also the highest-risk, least-bounded scope.
6. **The numeric-kernel tail §3.4**: only worth a dedicated multi-week
   effort (a real size-fixpoint pass) or an explicit owner decision on
   external-optimizer integration; not a session-sized task.
