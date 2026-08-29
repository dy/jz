# size-leadership: jz wasm strictly smaller than AssemblyScript, per case

Campaign doc for `perf/size-leadership` (worktree, branch off `8986c2e2`). Owner's
bar (verbatim, from the campaign brief): produced size must be ALWAYS smaller
than AssemblyScript — ×1, per case, hard. Not geomean, not par-or-tie.

Iron rule (CLAUDE.md "optimize the tool, never the input"): bench sources
under `bench/` are fixed specimens. Every byte saved must come from the
engine. A fix that helps one named case only is the wrong fix.

Method: `scripts/bench-size.mjs --json` for ground-truth byte totals (jz
`optimize:'size'` vs `asc -Oz --converge --runtime stub --noAssert`, both
compiled fresh, deterministic, offline). Per-case attribution below is from
`wasm-objdump -h`/`-x`/`-d` section/segment/function breakdowns and
`compile(src, {wat:true})` named WAT, cross-checked with 8 isolation
experiments (scratch variants of the real bench source, never the committed
file, compiled the same way as `bench-size.mjs`) and one static-source read
of the compiler's own devirtualization code. All evidence below was measured
this session at HEAD `105bdc18` (branch tip after the Phase 1 gate commit);
byte counts will drift a few bytes as the compiler changes but the shape-class
attribution is structural, not a snapshot.

---

## 1. Gate status (Phase 1 — landed, commit `105bdc18`)

`test/bench.js` and `test/bench-claims.js` now assert `jz bytes < AS bytes`
per case, hard, over the full bench corpus (not the old curated ~30-case
`SIZE` table's win/tie subset) — see commit `105bdc18` "size gate: strict
per-case jz < AssemblyScript". `SIZE_TOL`/win/tie/todo no longer gate
anything; the `SIZE` object's per-case prose stays as shape-class narrative.

**Current red list — 24/49 comparable cases, geomean 1.042×** (fresh
`scripts/bench-size.mjs --json` at HEAD, saved as
`/private/tmp/claude-501/-Users-div-projects-jz/0482f00a-7cbc-475b-939a-b25b5ba26704/scratchpad/baseline-sizes-8986c2e2.txt`
— this IS the Phase-3 diff baseline):

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

25/49 already win (strict `<`); not reproduced here (green, not the campaign's concern).

---

## 2. Section-level attribution (all 24 red cases)

`wasm-objdump -h` section sizes, jz minus AS, reconciled to the authoritative
totals above (residual "other" column absorbs module-header + section-length-
prefix framing bytes, never more than ±13B — confirms the accounting is sound):

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

**Universal patterns, 24/24 cases:**

- **CODE is always larger in jz** (+26 to +2187B) — the dominant, sole loss
  driver on 23/24 cases (everything but wordcount).
- **DATA is always SMALLER in jz** except wordcount — not a loss driver;
  AS's runtime carries a bigger fixed floor (214B vs jz's 83B) for the
  NaN/Infinity/error-string table every module needs.
- **GLOBAL is always larger in jz** (+27 to +180B) — see §3.3, mostly
  legitimate/deliberate, not free bytes.
- **EXPORT is always +30B (+43 for dispatch)** — fully explained (§3.3):
  `__heap` and `__jz_last_err_bits` are exported by design (external
  inspection / the no-EH trap-decode host contract); AS exports neither.
  **Not a fix target** — deliberate, already re-baselined per `test/bench.js`'s
  own SIZE-table history.

---

## 3. Shape-class findings

### 3.1 `wordcount` (4.705×) — dynamic-dictionary + ToString/Ryu pull-in. BLOCKED externally.

**Confirmed by isolation** (3 scratch variants, compiled exactly like
`bench-size.mjs`, never touching the committed bench file):

- Replacing `counts[w]=...` (a plain-object dictionary keyed by a runtime
  string) with `new Int32Array(NWORDS)` collapses the module from 16372B to
  3461B — **12911B (≈79% of the whole case) is the dynamic-object dictionary
  machinery**, confirmed as the dominant cost.
- Varying `NWORDS` 512→32 changes the compiled output by 3 bytes — the cost
  is **not** proportional to vocabulary size (rules out "512 words get
  constant-folded into the binary"; the data segments are domain-size-
  independent fixed infrastructure).
- `wasm-objdump -x -j Data` on the untouched case: segment[1] is 5560B of
  high-entropy bytes, segment[29] is 4505B — both constant across the NWORDS
  sweep, consistent with Ryu (shortest-round-trip float→string) lookup
  tables. `.work/todo.md` (prior session, 2026-07-29, `.work/todo.md:5340`)
  independently named this: "source never stringifies a number yet Ryu is in
  the module — `__str_concat` is a MONOLITHIC generic helper whose unproven-
  operand arm calls `__to_str` internally... transitively drags the whole
  ToString/Ryu formatter (~26% of wordcount's size module)" via
  `w += String.fromCharCode(...)` in `buildWords()`. **Caveat, read
  honestly**: the SAME log later self-corrects this exact claim
  (`.work/todo.md:5315`, same date): "`__str_concat` was ALREADY stratified
  (concat_raw, pre-existing) — my monolithic-helper diagnosis wrong in the
  specific; the REAL monolith is `__dyn_set`/`__dyn_get_t` (ToPropertyKey
  pulls `__to_str`)" — i.e. the dynamic-object GET/SET path itself (not
  string concatenation) is the more likely proximate cause. I did not referee
  between these two entries. Either way, both name the SAME family (an
  unproven-operand coercion helper reachable from wordcount's dynamic-object
  machinery unconditionally drags in the whole ToString/Ryu formatter) and
  both are consistent with my OWN isolation result above (removing the
  dynamic object removes the cost regardless of which exact helper is the
  trigger).
- **Fix is already designed and BLOCKED, not open**: the same log records a
  helper-stratification attempt (split the concat/dyn-property helper's
  strings-only core from its `ToString`-coercing wrapper) that "triggers a
  LATENT WATR INLINER BUG" in the vendored `watr` dependency — explicitly
  filed as a "USER-repo item," i.e. outside jz's own source
  (`.work/todo.md:5320`). **Do not re-attempt this without first confirming
  the watr bug is fixed upstream** — installed watr is `5.9.3`, matching
  package.json's `^5.9.3` pin, checked this session; there's no record of
  which watr version the inliner bug was originally filed against, so a
  version bump alone doesn't prove it's fixed — re-verify by attempting the
  stratification and checking for the same corruption repros
  (`.work/todo.md:5321-5323`: `a.name=7;a.shift()` → wrong result,
  `JSON.parse` + computed-key read → wrong result) before trusting a retry.

### 3.2 `shapes` (1.783×) — megamorphic union representation. Needs redesign, not a quick fix.

Prior investigation (`bench/README.md:612-616`, `test/bench.js:368`) already
diagnosed this in depth for the SPEED axis: an 8-schema closed union defeats
schema-slot inference, so every field read lowers through the generic
`__dyn_get` dynamic-property probe. That prior analysis claims "op census ≤
AS" — **this session's fresh measurement contradicts that for the SIZE axis**:
jz's Code section is 2720B vs AS's 1254B (+1466B, 2.17× AS's code alone).
Either the "op census" claim was scoped to a different build (speed preset,
not `optimize:'size'`) or it has drifted since. Treat the size-axis gap as
**unverified by prior work — genuinely open**, not settled. The known lever
(per `bench/README.md`) is "shape-set devirt": specializing the union's
runtime representation once the closed set of concrete shapes is provably
enumerable, which is a representation-level change (new work), not a bug fix.

### 3.3 `dispatch` (1.123× → 1.089×) — closure-table calling convention. LANDED (commit follows this doc update).

Named WAT dump of `dispatch.jz.wasm` (`ops = [8 capture-free arrows]`,
dispatched via `ops[code[i]](x, ks[i])`) shows the devirtualization machinery
(`src/optimize/devirt.js:407` `devirtConstFnArrayCalls`) is already extremely
sophisticated: it recognizes the const-array-of-arrows pattern, builds a
`br_table` over the 8 candidate bodies, and INLINES each arm's body directly
(`inlinePureCallExpr`) instead of paying `call_indirect`.

**Root cause, fully traced** (via a temporary `JZ_DEBUG_DEVIRT`-gated trace
added and removed this session — not shipped): each closure body is emitted
by `emitClosureBody` (`src/compile/index.js:2061`) with params `$__env f64,
$__argc i32, $__a0..a{W-1} f64` — a uniform ABI every closure gets regardless
of its real arity. Reading one of those `$__aN` params as a number then goes
through the SAME generic f64-boxed-value-to-i32 coercion any dynamically-
typed value gets, which computes the guarded i32 AND the guard's own
comparison operand from the SAME `local.tee`:
```
select(i32.wrap_i64(i64.trunc_sat_f64_s(local.tee L E)), 0,
       f64.ne(local.get L, SENTINEL))
```
(`select` pops `(trueVal, falseVal, cond)` — wasm returns `trueVal` when
`cond ≠ 0`.) I did not fully pin down SENTINEL's exact semantic role (a
padding value for an arity beyond what a given call site supplied, most
likely, given `$__argc`'s presence in the same ABI — but I would not commit
that to print without tracing it as rigorously as the rest of this section).
What IS fully verified, independent of that: `devirtConstFnArrayCalls`
substitutes call-site argument expressions for `E` — for `dispatch`'s
`k`/`ks[i]` argument, `E` becomes `f64.convert_i32_s(i32.load(...))` (a
value provably in `[-2^31, 2^31-1]`), and `SENTINEL` here is `+Infinity`,
which no such conversion can ever produce, regardless of what it's FOR. The
guard is a compile-time-
decidable tautology in this new context. But it doesn't fold: it isn't
`f64.ne(f64.convert_i32_s(_), SENTINEL)` directly (which an existing
`peephole.js` rule already folds — see the `f64.eq`/`f64.ne` + `intK` rule
around line 717) — it's `f64.ne(local.get L, SENTINEL)`, ONE LEVEL removed
behind the very `local.tee` that also produces the value everything else
needs. `devirt.js`'s own `spill()` (lines ~432-444, doc comment "behind an
f64 spill local the value-flow is invisible") anticipates exactly this
failure MODE, but at the wrong LAYER — it protects the argument expression
`E` reaching the closure body correctly (confirmed by trace: `k`'s spill
*does* arrive as `f64.convert_i32_s(...)`), not the closure body's own
internal tee/reread of its unboxed value. And it can't fold generically
either way: `peephole.js`'s `fusedRewrite` runs *before*
`devirtConstFnArrayCalls` in `optimize/driver.js` (line 86 vs 172), so it
never sees the spliced-in arm at all; watr's downstream fixpoint has no
reason to know this jz-specific ABI fact (the sentinel is still a raw
`f64.const`, not yet hoisted to a global — `hoistConstantPool` runs strictly
after the whole `optimizeFuncs` loop, confirmed by reading
`src/wat/assemble/optimize-module.js`).

**Fix** (`src/optimize/devirt.js`, `foldImpossibleConvertGuards`): a small,
local, mathematically-unconditional fold applied once to each freshly-
inlined arm, right where `inlinePureCallExpr` produces it. It recognizes the
exact `select(i32.wrap_i64(trunc_sat(tee L E)), 0, f64.ne(local.get L, C))`
shape, and when `E` is `f64.convert_i32_s(_)`/`f64.convert_i32_u(_)` and `C`
is a constant no such conversion can produce (the same range test the
`peephole.js` `intK` rule already uses, mirrored the other direction),
replaces the whole `select` with just `trueVal` — dropping the guard,
keeping the `tee` (it still produces the real value; an unread local write
is cheap and a later dead-local sweep can clean it up).

**Verified**: `scripts/bench-size.mjs --json` before/after is byte-identical
on all 59 other cases — `dispatch` alone: **1813 B → 1758 B (−55 B, 1.123× →
1.089×)**. `scripts/refactor-oracle.mjs check --ref 8986c2e2` (140 specs ×
{O0,O2,O3,size}, bench + examples + kernel-parity + jessie/watr corpora)
found exactly 3 differences, ALL in `bench:dispatch`, ALL pure reductions:
O2 1965→1896 (−69B), O3 2074→2066 (−8B), size 1813→1758 (−55B). No
regression anywhere; the change's blast radius is exactly the one shape-
class it targets.

**Does not close `dispatch`**: 55B is real but the case still needs ≥145B
more to cross under AS's 1614B. The general shape-class ("a devirtualized
closure-table arm still carries its callee's fully-generic per-parameter
unbox guard, and the dead-guard fold that's supposed to clean it up doesn't
see through the callee's own local.tee reuse") is now closed for THIS
pattern everywhere it recurs (any const-fn-array dispatch whose argument is
provably int-sourced), not just dispatch.js — "eradicate the whole shape-
class," per the campaign's own rule — but it was never, by itself, the
lever that flips this one case green. The remaining ~340B of dispatch's
code gap is unattributed (likely shares the diffuse backend-maturity tax of
§3.4 — arm 0's own `(x,k)=>(x+k)|0` path, and the 8 standalone closure
bodies kept for the `call_indirect` fallback, are untouched by this fix).

### 3.4 The numeric-kernel long tail (matmul, heat, particle, spmv, nbody, mat4, biquad, raytrace, delayline, bezfit, noise, resample, slices, synth, fft) — diffuse backend-maturity gap, no single fix point found.

Deep-dived `matmul` (smallest, cleanest representative: `Float64Array`
triple-nested loop, gap 99B / 191B code). Named WAT shows:

- The `matmul` kernel function itself: **149B**, zero bounds checks, zero
  calls, textbook-optimal scalar f64 codegen (`i32.shl`/`i32.add` addressing,
  no redundant work) — not a proof gap, not checked-read residue.
- `__alloc`/`__alloc_hdr_n_d_d_1` (the bump allocator + typed-array header
  writer): 190B + 50B, a real, necessary, already-tuned amortized-growth
  allocator (doubling heuristic keyed off `memory.size` thresholds) — legit
  infrastructure, not bloat.
- `main`: **712B** — the warmup loop, 21-run timed loop, insertion-sort
  median, and checksum reduction (all of `benchlib.js`'s helpers) are fully
  INLINED into `main` (single call site each → correct size decision, not a
  bug). AS's equivalent keeps the same logic in **7 separate small functions**
  (`glyfparse.as` shows the same pattern even more starkly: 19 AS functions
  vs jz's 6) totaling 912B vs jz's 1103B.

**Conclusion**: AS gets a multi-pass, iterative binaryen `-Oz --converge`
fixpoint optimizer for free; jz's single-pass emission leaves comparable
"final assembly" slack behind — the SAME phenomenon `test/bench.js`'s own
`WASMOPT_SLACK_MIN` self-check already tracks (`wasm-opt -Oz` finds ~25-30%
slack in jz's raw output — see `scripts/bench-size.mjs --json`'s `jz_wasmopt`
column: 20/24 red cases shrink under `wasm-opt -Oz`, sometimes 5-8%). This is
real, but it is NOT one bug or one shape-class with a bounded fix — it is
distributed across inlining-heuristic tuning, local-slot allocation, and
watr's own peephole coverage vs binaryen's. **No general engine fix was
identified this session that closes this class without either (a) a new
multi-pass size-fixpoint optimizer inside jz (a large, multi-week-scale
project matching the project's own history for similarly-scoped features), or
(b) integrating an external optimizer into the compile pipeline (an
architecture decision — jz currently has zero native-binary dependencies;
`wasm-opt` is used only as an offline diagnostic in `bench-size.mjs`, never
in `compile()` itself — not mine to make unilaterally).**

`sdf` and `glyfparse` specifically also carry the **checked-read** shape-class
already diagnosed for the SPEED axis (`test/bench.js`'s `WASM_TODO`,
2026-07): a data-dependent cursor (`r` advances a data-dependent 1-2 bytes
per glyph flag) defeats the interval-proof machinery that already closed this
class for `aos`/`sort`/`hash`/`base64`/`wav`/`conv2d` (checked-by-default
typed indexing, collapsed via watr 5.5.0 intguard + the cross-function
`PARAM TYPEDLEN` channel + the S2 loop-body fixpoint). The general lever
(runtime-bound versioning: guard once per glyph instead of once per byte) is
named but not implemented — it is the same "general fix, not per-case hack"
shape as the already-landed wins, just not yet extended to cover a
data-dependent (not statically-bound) cursor.

`fft`/`synth`/`tokenizer` carry a named-but-unquantified "transcendental
helper pull-in" cost (poly-sin/twiddle tables) per `test/bench.js`'s own SIZE
comments — no deeper lever than that is on record anywhere I found.

### 3.5 `immutable`/`aos` (closed-shape records, not dynamic dictionaries)

Distinct from wordcount's dictionary: `{x,y,vx,vy}`/`{x,y,z}` are FIXED-SHAPE
record literals, not string-keyed maps. `aos` is already heavily optimized
(prior work: in-place replace-stores, packed-i32-cell field stores) and sits
at 1.008× (nearly closed). `immutable`'s code gap (524B) is proportionally
larger. Confirmed via `wasm2wat`: `immutable.jz.wasm` has **zero** calls to
`$__alloc` in its function list (so the `ps[i] = {x,y,vx,vy}` replace-store
IS already scalar-replaced in place, matching `aos`'s precedent — no
per-iteration allocation). But the store site still carries a header-
resize/forwarding check (an `i32.load` at header offset −4 compared against
the write, guarded by a `≥8 AND ≤ __heap_end` range test, then a conditional
`call $__zomb_scan`-shaped forwarding-pointer resolution before the field
stores) — the general dynamic-element-store path, not a specialized
"this array's length is provably fixed, no grow/forward check needed" fast
path. `ps` is built once (`initParticles()`, no `.push` in the hot loop) and
only ever *replaced* element-by-element (never grown).

Checked the two existing never-grown proofs directly — **neither covers
this pattern as written**, so this is a real gap, not a mis-firing existing
proof: `src/compile/program-facts/param-never-grown.js`'s own header doc
restricts it to a param the body only ever "purely READS... (safeReads:
index / .length, no aliasing, no passing on)" — `runKernel(ps)` WRITES
`ps[i] = {...}`, disqualifying it outright, by design (the doc's own
motivating example is wordcount's *read-only* `words` param, not a write
site). `scanNeverGrown` (referenced from the same file, "fresh-literal
LOCALS only") is scoped to arrays built and consumed within ONE function —
`ps` is built in `initParticles()` and consumed in a DIFFERENT function,
`runKernel()`, so it's a cross-function param, outside `scanNeverGrown`'s
reach too. **The gap: no existing proof covers "a param array that's
provably only ever ELEMENT-REPLACED (never resized) across its whole
reachable callee graph."** That's a natural generalization of
`param-never-grown.js`'s own read-only proof (same activation-scoped
graph-closure argument, extended from "only reads" to "only reads and
same-index element replacements") — plausible, bounded in spirit, but a NEW
analysis, not a bug fix; needs its own design pass before implementation,
same discipline as `shapes` (§3.2).

---

## 4. Hypotheses tested and DISPROVEN this session (don't re-chase)

Following the project's own stated discipline ("root causes are MEASURED, not
assumed... don't re-chase the disproven hypotheses" — `test/bench.js`'s own
`WASM_TODO` notes on `noise`/`mat4`):

1. **"f64-constant hoisting into globals is wasteful for single-use
   constants."** Checked `bezfit` (14 hoisted f64 globals, +180B Global-
   section gap, the largest in the corpus): every single constant is used
   ≥2 times (`global.get` reference counts 2-14). Break-even for
   hoist-vs-inline is at 2 uses (hoist: 12B decl + 2B/use; inline: 9B/use).
   **The hoisting policy is already correct** — the Global gap here is
   inherent to bezfit's source having 14 distinct repeated literals, not an
   engine bug.
2. **"`$__heap_end` (i32) and `$__heap_end64` (i64) are redundant shadow
   globals — derive one from the other."** Checked call sites
   (`module/core.js:486`, `module/collection.js:1537/2014/2202`): the i64
   shadow is an explicit, commented micro-optimization — hash-table probe
   loops (hot, per-iteration bounds checks) read the cached i64 global
   instead of recomputing `i64.shl(i64.extend_i32_u(memory.size), 16)` at
   every iteration. Removing it would cost MORE bytes at every read site (and
   regress speed). **Deliberate, not a bug.**
3. **"The `'size'` optimize preset doesn't disable loop-unroll-for-small-
   constant-bounds the way the internal `mat4`/`biquad` size spot-check test
   does."** Checked `src/optimize/config.js`'s `size` preset directly: it
   already sets `smallConstForUnroll: false`, `nestedSmallConstForUnroll:
   false`, plus 15+ other speed-only flags explicitly turned off with
   individual byte-cost comments (`recursionUnroll`, `unrollScalarChain`,
   `forInUnroll`, `clampPeel`, `versionTypedBounds`, `promoteGlobals`,
   `hoistInvariantLoop`, …). **This preset is already exhaustively tuned** —
   there is no missed off-switch here.

These three near-misses are worth recording precisely so nobody re-derives
them: the size-preset configuration layer (`src/optimize/config.js`) and the
constant/global-hoisting policy are NOT where the remaining gap lives. Most
of what remains lives in (a) two large, already-diagnosed, currently-
blocked-or-unscoped cases (wordcount, shapes), and (b) a diffuse, no-single-
fix backend-maturity tax across the numeric-kernel tail (§3.4). One
precisely-located dead-code residue (dispatch §3.3) WAS fully traced and
landed this session — see §5.

---

## 5. Phase 3 status: one fix landed (§3.3), full battery green

**Landed**: the dispatch closure-table dead-guard fold (§3.3),
`src/optimize/devirt.js`'s `foldImpossibleConvertGuards`. `dispatch`
1813→1758B (−55B, 1.123×→1.089×), zero regressions anywhere in the corpus
(`bench-size.mjs` byte-identical on all 59 other cases;
`refactor-oracle.mjs check --ref 8986c2e2` found exactly 3 differences, all
in `bench:dispatch`, all reductions). Full verification battery green:
`npm run build`, `node test/index.js`, `node test/kernel-parity.js`, `node
test/kernel-oracle.js`, `node test/pointers.js`, `node test/data.js`, and
`JZ_TEST_TARGET=jz.wasm node test/index.js` all pass at this commit. Does
not close `dispatch` — the case needs ≥145B more; see §3.3's own tail for
what's left unattributed there.

**Why nothing else landed**: every other lever with real byte impact
requires either an external-dependency fix outside this repo (wordcount,
blocked), a representation redesign needing its own design pass before
implementation (shapes), or — for the numeric-kernel tail — a genuinely
large, multi-week-scale optimizer feature (§3.4), none of which I could
responsibly finish, implement, AND fully battery-verify (per STABILITY.md's
correct-or-reject bar) within this session. Three plausible "quick,
mechanical, safe" fixes were investigated and disproven (§4) rather than
shipped speculatively; one real one (§3.3) was traced all the way to a
verified, scoped, landable fix and shipped.

Given "no compromise... first make it work, then make it right" and the
explicit instruction that a fix helping one named case only is the wrong
fix, forcing any of the remaining candidates through would have meant either
a narrow, per-case-only change (against the iron rule) or an under-verified
change to correctness-critical optimizer machinery (against STABILITY.md).
The dispatch fix clears both bars — general (any const-fn-array dispatch
with this argument shape, not just this one case) and fully verified — the
rest do not yet.

**Ranked next steps for a follow-up session, by expected value:**

1. **`immutable` §3.5** — a cross-function "never-grown, element-replace-only
   param" proof (generalizing `param-never-grown.js`'s existing read-only
   proof to also allow same-index writes) would remove the resize/forwarding
   check the replace-store site still pays. Confirmed neither existing
   never-grown proof covers this (param-never-grown is read-only by design;
   scanNeverGrown is same-function-only) — a real, scoped gap, not a
   mis-firing existing proof, but still new analysis work, not a one-line fix.
2. **`sdf`/`glyfparse` checked-read residue §3.4** — extend the existing
   S2 loop-fixpoint / runtime-bound-versioning mechanism (already closed
   this exact shape for 6 other cases) to data-dependent (not statically-
   bound) cursors. Named lever, prior precedent, but nontrivial (the
   "versioning" itself is the hard part).
3. **`dispatch`'s remaining ~340B §3.3** — arm 0's `+` path and the 8
   standalone closure bodies kept for the `call_indirect` fallback are
   untouched by the landed fix; worth a fresh WAT census now that the
   dead-guard noise is gone, to see what's left cleanly.
4. **`wordcount` §3.1** — re-check only after confirming the blocking watr
   inliner bug is fixed upstream (watr version bump); otherwise do not
   re-attempt the helper-stratification approach blind.
5. **`shapes` §3.2** — needs a design pass first (shape-set devirt is a
   representation change, not a bug fix); highest single-case byte value
   (1328B) but also the highest-risk, least-bounded scope here.
6. **The numeric-kernel tail §3.4** — only worth a dedicated multi-week
   effort (a real size-fixpoint pass, matching binaryen's iterative -Oz) or
   an explicit owner decision on external-optimizer integration; not a
   session-sized task.
