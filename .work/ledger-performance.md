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

**3.1 `wordcount` — UPDATE 2026-08-31: STALE. The 4.705× diagnosis no
longer describes the compiled module; the case is already fixed, by
unrelated prior work, to 1.438×.** Fresh `bench-size.mjs` at the
`perf/size-reds-2` baseline (`3814c151`): jz 5004B / AS 3480B = **1.438×**,
down from the 16372B/4.705× this section originally recorded. Fresh
`compile(src, {wat:true})` on `bench/wordcount/wordcount.js` at this
baseline: **zero** occurrences of `__dyn_set`, `__dyn_get*`, `__to_str`,
`__ftoa`, `__str_concat`, `Ryu` anywhere in the module. `wasm-objdump -x -j
Data`: 2 segments totaling 128B (was 2 segments totaling 10065B) — the
Ryu float→string table is gone. The dictionary-counting idiom
(`counts[w] = (counts[w]|0)+1`) now takes the proven-HASH early-return
probe/load/store path added by `0dc8145e` ("dyn-set RMW-fusion: stop
force-including `__dyn_set` when the HASH arm can never reach it") and the
cross-call array-element kind lattice (`26435f2f`, `ecf99599`) that keeps
`w`'s STRING kind alive across the `words[toks[i]]` call boundary so the
dictionary receiver is provably HASH, never falling through to
`__dyn_set`/`ToPropertyKey`/`__to_str`/Ryu at all. Both commits predate
this ledger's original `105bdc18` snapshot in the branch graph
(`git merge-base --is-ancestor` confirms both are ancestors of
`105bdc18`) yet that snapshot still measured 16372B — so a third,
uncommitted-in-this-ledger factor closed the remaining gap somewhere in
the ~101 `src`/`module` commits between `105bdc18` and `3814c151`; not
bisected (out of scope for this session — the current number is verified
directly, which is what gates the campaign, not its exact history).
**The remaining 1.438× is a different, smaller gap**: section breakdown
(`wasm-objdump -h`, jz vs AS) — Code +2007B (dominant), Data −572B, Global
+60B, Type +37B, residual within 6B of the 1524B total. `wasm-opt -Oz`
slack is only 2.7% (jz 5004B → 4869B): the code is already close to
wasm-opt's own local optimum, so this is not redundant/foldable bytes —
see the Phase 4 status (§6) for the current classification (same diffuse
codegen-slack family as §3.4, not a Ryu/dictionary bug).

**Historical record (superseded, kept for the mechanism trail)**:
Isolation (3 scratch variants, original session): replacing
`counts[w]=...` (a plain-object dictionary keyed by a runtime string) with
`new Int32Array(NWORDS)` collapsed the module 16372B→3461B -
**≈79% of the whole case was the dynamic-object dictionary machinery** at
that time. `archive/todo.md` (2026-07-29) independently named this and
then self-corrected the exact mechanism in the same session (first:
`__str_concat` pulls in `__to_str` via an unproven-operand arm; corrected:
`__str_concat` was already stratified; `__dyn_set`/`__dyn_get_t` is the
monolith, and its `ToPropertyKey` pulls `__to_str`). A helper-
stratification attempt (split the concat/dyn-property helper's
strings-only core from its ToString-coercing wrapper) was believed at the
time to trigger a "LATENT WATR INLINER BUG" (`a.name=7;a.shift()` → wrong
result; `JSON.parse` + computed-key read → wrong result). **That diagnosis
was itself wrong — see the inliner-bug verdict in §6**: the corruption was
JZ's own code, not watr's, and was root-caused and fixed in the
`STRATIFICATION RETRY 2026-08-03` session (`archive/archive-todo-2026-08.md:3270-3364`);
the split was reverted anyway because it gave zero size benefit (wordcount
was already Ryu-free by then, from the unrelated lattice fix above) and
regressed the self-hosted `watr` case by +767B. The one surviving line
from that retry is documented in-tree at
`src/compile/emit-assign.js:221-239`.

**3.2 `shapes` — UPDATE 2026-08-31: the named lever ("shape-set devirt")
is ALREADY LANDED. The 1.783× diagnosis ("every field read lowers through
the generic `__dyn_get` dynamic-property probe") is STALE.** Fresh
`compile(src, {wat:true})` on `bench/shapes/shapes.js` at the
`3814c151` baseline: **zero** occurrences of `__dyn_get`/`__dyn_set`
anywhere in the module (checked by substring, so this also rules out
`__dyn_get_t`/`__dyn_get_expr`/etc.). Reading `runKernel`'s WAT directly:
every record is stored at a **fixed 20-byte stride** (`i32.mul (local.get
$i) (i32.const 20))`, wide enough for the union's largest member (variant
3's 5 i32 fields incl. tag); the tag (`o.k`) is always `i32.load offset=0`;
`measure`'s 8-way `if (k===N) ... else if ...` lowers to exactly that
chain with **direct `i32.load offset=4/8/12/16`** per arm — no schema
table, no hash probe, no dynamic dispatch. This is precisely "a bounded
schema union lowering to a tag-switch over direct slot loads, the static
mirror of a polymorphic IC" (`bench/README.md:616`'s own definition of the
lever) — it already exists in the compiler; whatever landed it is not
named in this ledger and was not bisected this session (out of scope; the
current WAT is the authority, not the history).
**The remaining gap is now 1.616× (2739B / 1695B AS, current baseline),
not 1.783×, and it is NOT a representation gap.** Section breakdown: Code
+1303B (dominant, count 9 fns vs AS's 10), Data −248B, Global +12B, Type
−9B, residual ~7B. `wasm-opt -Oz` slack is 10.3% (2739B → 2457B) — real
but moderate. Reading `main`'s WAT: `initRows()` (XorShift32 + the same
8-way shape-construction branch) is fully inlined into `main` (single call
site), and each of the 8 construction arms repeats its own
`__arr_grow_known`/`__alloc_hdr`/store sequence inline rather than sharing
one parameterized push helper — a duplicate-code-folding opportunity
`wasm-opt -Oz` partially captures (hence the 10.3% slack) but jz's own
pipeline doesn't yet reach. This is the SAME class already ranked #1 in
`audit.md` §9 ("Codegen slack vs `wasm-opt -Oz`... candidates: more
aggressive global/constant propagation across function boundaries,
duplicate-code folding of near-identical blocks, tighter local
coalescing"), not a new shape-class. See §6.

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

**UPDATE 2026-08-31 — the ~340B fresh WAT census this section asked for
(§5's old ranked-next-steps item 3): mostly closed by other work since,
down to 19B (1633B/1614B AS = 1.012×), and the residual 19B is fully
attributed, not unexplained.** `wasm-objdump -h` on the current baseline
(`3814c151`) shows a `Table` (4B) + `Elem` (14B, one segment, 8 entries)
section plus 8 standalone `closure0`..`closure7` functions in Code,
alongside the fully-inlined `br_table` arms inside `runKernel` — reading
`devirtConstFnArrayCalls` (`src/optimize/devirt.js:456-464`, its own
comment): "The untouched original `call_indirect` is the default arm, so
any runtime divergence (an element overwritten through an alias, an
out-of-range index yielding the UNDEF box) takes the generic path:
semantics are bit-identical regardless of the candidate set." The table +
elem + 8 closures are that generic fallback's live targets, not dead
code — `code[i]` is provably in `[0,7]` at its one write site (`code[i] =
s & (NOPS-1)` in `fill()`, a bitmask), but that is a fact about the
Int32Array's stored VALUES, tracked across a write-site/read-site function
boundary (`fill` writes, `runKernel` reads) — a different, harder proof
than the INDEX-bounds proofs `type/loop-versioning.js` already closes
(those bound an index against a receiver's length, not an array's
CONTENTS against a mask, and not across two functions). Removing the
fallback without that proof would be exactly the class of speculative,
unsound trim the campaign's iron rules forbid ("correct-or-reject — never
trade a wrong value for bytes"): if `code` were ever populated
differently, the fallback is the only thing keeping an out-of-range read
from misdispatching. Not attempted; needs the same new-analysis caution as
§3.5's `immutable` generalization and the tokenizer finding in §6 below —
grouped with those as one class ("array-content value-range proof across
a write/read function boundary"), not treated as three separate one-off
gaps.

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

**UPDATE 2026-08-31 — `fft`/`tokenizer` re-examined; the "transcendental
helper pull-in" attribution was imprecise for `fft` and wrong for
`tokenizer`.** Both re-measured at the `3814c151` baseline:

- **`fft`, now 1.287× (2262B/1758B AS)**, down from 1.356×. `bench/fft/
  fft.js` genuinely does carry `sinPoly`/`cosPoly` (6-term Horner-form
  Taylor polynomials, called once each from `buildTwiddles`) — but that
  source is compiled by **both** jz and AS from the same `.js`/`.as.ts`
  specimen, so the polynomial's own bytes are not a jz-only cost; framing
  the gap as "transcendental pull-in" overstates it. Section breakdown:
  Code +677B (dominant), Data −214B (fft's jz build has no Data section at
  all — zero data segments), Global +60B. `optimize:'size'` already turns
  `vectorizeLaneLocal` off (`src/optimize/config.js:108`), so this isn't a
  SIMD-vs-scalar size tax either. `wasm-opt -Oz` slack is 8.9% (2262B →
  2061B) — same moderate-diffuse-slack bucket as `shapes` (§3.2 update),
  not a distinct transcendental-specific shape-class.
- **`tokenizer`, now 1.277× (1981B/1551B AS)**, down from 1.350×. **The
  "transcendental helper pull-in" claim does not apply to this case at
  all**: `bench/tokenizer/tokenizer.js` (`scan`) is a pure-integer
  character classifier — no floats, no `Math.sin`/`Math.cos`, no
  polynomial, nothing transcendental anywhere in the source. `wasm-opt -Oz`
  slack is 0.7% (1981B → 1968B): essentially none, meaning the code is
  already near wasm-opt's own local optimum — this rules out the diffuse
  codegen-slack story too. Reading `scan`'s WAT directly: the real cost is
  a **per-iteration checked read**, `i32.ge_u (local.get $i) (local.get
  $src$cclen)` inside the character loop, guarding `src.charCodeAt(i)`.
  This is the SAME checked-read family named above for `sdf`/`glyfparse`,
  but with a twist that makes it a **harder** instance, not the same
  closed one: the loop's trip count is `scan`'s own `len` PARAMETER (`for
  (i=0;i<len;i++)`, called as `scan(src, n - (i&7))`), not `src.length`
  itself, so the existing canonical-loop pattern (bound and checked
  receiver being the syntactically same expression) never matches — closing
  it needs proving `len <= src.length` across `scan`'s two call sites, an
  interprocedural parameter-relationship proof that doesn't exist today.
  **Checked the obvious lever and it's a dead end for the size axis
  specifically**: `type/loop-versioning.js`'s typed-array loop-versioning
  (guard once, unchecked fast loop vs. checked slow loop) is exactly this
  shape, but `src/optimize/config.js:116` disables it for `optimize:'size'`
  by deliberate design (`versionTypedBounds: false` — "duplicates every
  proven nest... ×1.5-3 on small kernels... speed-only trade"): even a
  string-typed extension of that mechanism would not fire on a size build,
  so it is not a lever for this campaign. Grouped with `dispatch`'s
  residual 19B (§3.3 update) and `immutable` (§3.5) as the same class of
  gap: **a value-range or bound relationship that is true by construction
  at a value's origin, provable only by tracing that value across a
  function boundary the current analyses don't cross** — real, named, and
  consistently NOT a same-session fix.

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

### 6. Phase 4 status (2026-08-31): inliner-bug verdict, four cases
re-examined, zero engine changes — every stale/wrong diagnosis corrected

Session scope: `perf/size-reds-2` (worktree base `3814c151`, watr bumped
to `5.10.1` in `90cd9f44`). Current corpus state at this baseline (fresh
`node scripts/bench-size.mjs --json`, matches `plan.md`'s 2026-08-31
status override exactly): **34/49 strict wins, geomean 0.9368×, 15
losses**:

| rank | case | jz B | AS B | ratio | `wasm-opt -Oz` slack |
|---:|---|---:|---:|---:|---:|
| 1 | shapes | 2739 | 1695 | 1.616× | 10.3% |
| 2 | wordcount | 5004 | 3480 | 1.438× | 2.7% |
| 3 | fft | 2262 | 1758 | 1.287× | 8.9% |
| 4 | tokenizer | 1981 | 1551 | 1.277× | 0.7% |
| 5 | resample | 1813 | 1463 | 1.239× | 0.0% |
| 6 | glyfparse | 2971 | 2408 | 1.234× | −6.1% |
| 7 | slices | 2023 | 1657 | 1.221× | 5.2% |
| 8 | sdf | 2614 | 2209 | 1.183× | 2.7% |
| 9 | bezfit | 3502 | 3017 | 1.161× | −5.6% |
| 10 | noise | 2028 | 1868 | 1.086× | 5.7% |
| 11 | immutable | 1568 | 1481 | 1.059× | 4.8% |
| 12 | raytrace | 2120 | 2007 | 1.056× | 0.5% |
| 13 | lz | 2013 | 1910 | 1.054× | −0.4% |
| 14 | delayline | 1534 | 1470 | 1.044× | 5.9% |
| 15 | dispatch | 1633 | 1614 | 1.012× | −2.6% |

(Negative slack means `wasm-opt -Oz` made the module slightly *larger*
than jz's own output on that case — a wasm-opt quirk on that shape, not a
jz opportunity.)

**Inliner-bug verdict: it was never a watr bug. NOT-A-BUG, independently
confirmed three ways; watr 5.10.1 is not the reason.**

1. **watr's own upstream history rules out a version-bump fix.** `gh api
   repos/dy/watr/compare/v5.9.3...v5.10.1` (network-fetched this session):
   the only changes between the pinned `5.9.3` and current `5.10.1` are
   source-map support (`5.10.0`) and an encoder performance rewrite
   (`Array.shift()` O(n²) token consumption → a reversed-array O(1) `pop()`
   cursor). Both encoder commits are explicitly self-verified upstream
   "byte-for-byte against v5.9.3" (114 artifacts / 92,634 aggregate wasm
   bytes for the first; a differential harness for the second), watr's own
   suite green at 604/626 both times. **No inlining- or optimization-
   decision code changed between these two versions**: whatever compiled
   before compiles byte-identically now. There is nothing for a version
   bump to have fixed.
2. **The suspected mechanism was already structurally impossible.** The
   original 2026-07-29 theory was "smaller fns inline where originals
   didn't; `__dyn_get_t_h`'s single-entry memo cache + multi-site inlining
   corrupts results." But that cache (`$__dyn_get_cache_off`/
   `$__dyn_get_cache_props`) is a **module-level wasm global**, not a
   per-function local — inlining a function's body into multiple call
   sites cannot duplicate a global; there is only ever one. This was
   re-confirmed in the `STRATIFICATION RETRY 2026-08-03` session's own
   write-up: "never the soundness hazard the 2026-07-29 diagnosis
   suspected."
3. **When the split was actually rebuilt and retried (2026-08-03,
   pre-dating this session by three weeks, watr version unchanged at the
   time), the real corruption was found, and it was JZ's own code.**
   `.work/archive/archive-todo-2026-08.md:3281-3352`: rebuilding the
   `__dyn_set`/`__dyn_get_t` core split broke the `JSON.parse+o[k]` pin
   live (→ NaN) at **every** opt level, native, no self-host or inlining
   involved. Root cause: three call sites hardcode the exact literal
   strings `'__dyn_get'`/`'__dyn_set'` to decide whether schema-table
   population / memo-cache resets / array dyn-move machinery are needed
   (at the time: `assemble.js`'s `tblConsumed` gate and its `__clear`-reset
   gate, `module/core.js`'s `lengthNeedsDynArm`, `module/array.js`'s
   `needsArrayDynMove`); a stratified helper reaching the same logic under
   a **different function name** silently bypassed all three gates. Fixed
   by adding the new names to all three gates; both named repros verified
   green after (`a.name=7;a.shift()` = 1; `JSON.parse+o[k]` = 6) at
   O0/O2/O3, native and kernel. **This is documented live in the current
   tree, not just the archive**: `src/compile/emit-assign.js:221-239`
   (read this session) carries the same story verbatim as an in-source
   comment, including "reproduced live via the JSON.parse+o[k] pin,
   root-caused, fixed" and the reason the split still isn't landed (next
   point). Confirmed today: `module/core.js:1726`, `module/array.js:72`
   still gate on the literal string `'__dyn_set'` — the same fragile
   pattern is still there, dormant, correctly documented, and simply not
   currently triggered because no stratified split exists in the tree.

**Given (1)-(3), the stratification is not attempted this session, on
purpose — not because it's blocked, but because it is now a known
net-negative.** Per the same in-tree comment: rebuilding it "showed ZERO
benefit anywhere (wordcount's Ryu-free state predates this work, from the
unrelated cross-call array-elem lattice fix) and a real regression on the
self-compiled watr case (+767B)." §3.1's fresh measurement this session
(0 `__dyn_*`/Ryu symbols in compiled `wordcount`) independently confirms
the "zero benefit" half still holds today: there is nothing left in
`wordcount` for the split to strip. Redoing it would only pay the
self-hosted `watr` case's regression for no offsetting win anywhere in the
current 60-case corpus. **§5's old ranked-next-steps item 4 ("wordcount:
re-check only after confirming the blocking watr inliner bug is fixed
upstream") is retired**: the premise (wordcount is still blocked on this)
was already false before this session started.

**Four target cases re-investigated (wordcount, shapes, fft, tokenizer,
plus a bonus fresh census on dispatch per §5's old item 3); zero were
landable this session; zero engine files were changed.** Summary (detail
in §3.1/§3.2/§3.4/§3.3 updates above):

- **wordcount**: diagnosis stale, case already fixed by prior landed work
  (`0dc8145e`, `26435f2f`, `ecf99599`, plus ≥1 unbisected commit) —
  4.705× → 1.438×, an 8.05× byte reduction, before this session touched
  anything. Nothing to land.
- **shapes**: named lever ("shape-set devirt") already implemented —
  confirmed by reading the compiled WAT (fixed-stride records, tag at a
  constant offset, direct per-arm slot loads, zero `__dyn_get`) — 1.783× →
  1.616×. Remaining gap reclassified from "needs redesign" to the same
  codegen-slack family as §3.4/`audit.md` §9 item 1.
- **fft**: "transcendental helper pull-in" overstated — the polynomial is
  a shared source cost, not jz-only. Reclassified to the same
  codegen-slack family.
- **tokenizer**: "transcendental helper pull-in" was flatly wrong — the
  source has no floating-point code at all. Real cause found (a
  per-iteration checked read whose loop bound is a parameter, not a
  direct `.length` read) and its obvious fix (typed-array loop-versioning)
  confirmed dead-on-arrival for the size axis specifically
  (`versionTypedBounds: false` is deliberate for `optimize:'size'`).
- **dispatch** (bonus): the "fresh WAT census" §5 asked for is done. 340B
  residual → 19B (1.012×, nearly closed by other work); the last 19B is
  the `call_indirect` fallback's table/elem/8-closures, correctly kept
  alive for soundness, not a bug.

**Why zero landed, precisely** (this is a positive result, not a stall):
every one of the four re-examined cases converges on ONE of two already-
named, already-out-of-scope buckets — (a) diffuse codegen slack vs
`wasm-opt -Oz` (shapes, fft, and by extension wordcount's residual):
`audit.md` §9 item 1, ranked there as the single highest-confidence
generic gap in the codebase, requiring a new pass class (duplicate-code
folding / cross-function constant propagation / tighter local coalescing)
that is multi-week-scale engine work, or (b) a value-range/relationship
proof true by construction at a value's origin but only provable by
tracing it across a function boundary today's analyses don't cross
(tokenizer's `len <= src.length` across `scan`'s call sites; dispatch's
`code[i] ∈ [0,7]` across `fill`/`runKernel`; the same family as
`immutable`'s §3.5 gap). Bucket (b) is now three named instances, which
is itself useful: it is no longer "one hard case" (immutable) but a
recognized class worth a real design pass, same as shape-set devirt was
before it got built.

**Ranked next steps, refreshed:**

1. **Bucket (b): cross-function value-range/relationship proofs**
   (tokenizer, dispatch, immutable — 3 named instances now). Needs a
   design pass: what's the general form of "a fact true at a value's
   construction site, needed at a distant use site, current analyses stop
   at the function boundary"? `narrowSignatures`/`type/narrow/` already
   does cross-call PARAM narrowing for some shapes (`caller-ctx.js`,
   `summaries.js`, `param-abi.js`) — audit whether it's extensible before
   inventing a new mechanism (`plan.md`'s remaining queue item 5 already
   flags `narrowSignatures` for an audit pass; do it with this class in
   mind).
2. **Bucket (a): codegen slack vs `wasm-opt -Oz`** (shapes, fft, and the
   numeric-kernel tail of §3.4) — unchanged from `audit.md` §9's own
   ranking: highest-confidence, highest-effort. A new multi-pass
   duplicate-code-folding/local-coalescing pass, or an owner decision on
   external-optimizer integration.
3. **`sdf`/`glyfparse` checked-read residue §3.4**: unchanged from the
   Phase 3 ranking — extend the existing S2 loop-fixpoint mechanism to
   data-dependent cursors.
4. Do **not** re-attempt the `wordcount` helper stratification (see
   verdict above — confirmed net-negative, not blocked).
5. Do **not** re-attempt `shapes` shape-set devirt as a redesign — it's
   already built; treat any further `shapes` work as bucket (a) or (b),
   not a representation gap.
