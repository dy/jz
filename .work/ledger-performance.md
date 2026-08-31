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

### 6.1 Cross-function value-range/relationship proofs — design pass
(2026-08-31, `perf/cross-fn-ranges`, worktree base `35148654`). Bucket (b)'s
three named instances (tokenizer, dispatch, immutable) re-examined with a
design requirement: EXTEND an existing fact channel, never invent a parallel
one. **Verdict: one instance (tokenizer) is genuinely bounded and is
implemented below; the other two are precisely diagnosed — considerably more
precisely than their §3.3/§3.5 entries — but are NOT bounded this session,
for two structurally different reasons documented per-instance.**

**The shape-class, precisely.** All three are a fact that is TRUE BY
CONSTRUCTION at a value's origin (an argument expression at a call site; a
write into an array) and NEEDED at a distant use site (a checked read in a
different function), where today's analyses stop at the exact function
boundary that separates origin from use. The general form: a CALLER-side
proof, computed once from the caller's own expressions/effects, published
onto the callee's `paramReps` entry (the SAME product-lattice `param-reps.js`
already hosts `typedLen`/`typedCtor`/`schemaId`/`arrayElemRange`/…), gated by
the SAME host-reachability/rest/default/body-write exclusions every existing
field in that lattice already uses, seeded into the callee's OWN
`ctx.func.*` fact map at analysis/emit time (mirroring `typedLen`'s two
seeding sites), and consumed by extending an EXISTING elision authority
rather than writing a new one. This shape held for tokenizer. It did NOT
fully hold for dispatch or immutable — in both, the missing piece turned out
to be on the CONSUMER side (an elision authority that doesn't exist yet for
the specific receiver-kind/access-shape), not merely a channel gap — see
each instance below.

**Fixpoint/ordering note (applies to all three, whether or not implemented):
this class of fact belongs immediately after `typedLen`'s own producer/
validator pair in `narrowSignatures` (`compile/narrow/index.js`) — same
round, same `sitesByCallee`/`runCallsiteLattice` driver, same `paramReps`
freeze point (program-facts §7: `paramReps` is a STAGED fact, mutable
through `plan()`'s rounds 2-3, frozen by `readonlyParamReps` at its own
true last-producer point — a new field here is just one more producer inside
that same window, not a new lifecycle to design).**

---

**Instance 1 — tokenizer's `len ≤ src.length`: BOUNDED, IMPLEMENTED.**

`bench/tokenizer/tokenizer.js`'s `scan(src, len)` loops `for (i=0; i<len;
i++) … src.charCodeAt(i) …`; both call sites are `scan(src, n - (i & 7))`
where `n = src.length` (a single-def `const` in `main`, same `src`). The
existing canonical-loop proof (`canonical-bounds.js`'s `scanBoundedLoops`,
`typedIdxProven` class 1) requires the loop bound to be syntactically
`recv.length` (or a hoisted temp declared IN THE LOOP'S OWN `init` clause);
`len` is a PARAMETER with no def inside `scan` at all, so the proof never
fires and every `charCodeAt` pays a per-iteration `i32.ge_u ($i)
($src$cclen)` guard plus the f64/NaN-capable contract that guard forces.

**Design.**
- *Fact*: `paramReps.get(f).get(k).lenBoundOf = r` — param `k`'s value never
  exceeds param `r`'s runtime `.length`.
- *Where computed*: caller side, at each call site, from the two ARGUMENT
  EXPRESSIONS directly (`summaries.js`'s new `boundedByCallerLength(expr,
  recvName, callerBody)`) — a small, terminating structural recursion, NOT
  a general symbolic interval prover (`interval-proof.js`'s own scope is
  numeric-literal-bound loop nests; this needs no absolute bound at all,
  only a relation to an unresolved runtime `.length`): a `.length` read on
  `recvName` (base case); a bare name whose SOLE `let`/`const` def in the
  caller body is itself bounded (single-def alias chase, evicted to
  unprovable on any shadowing — `singleDeclInit`); or `A - B` where `A` is
  bounded and `B` is provably nonnegative (`static.js`'s existing
  `typedValueExprRange`, reused read-only — already used elsewhere for
  exactly this "value stored through a bitmask" idiom, e.g. `s & (NOPS-1)`
  in the dispatch instance below). Fails closed on anything else — forgone
  proof, never a wrong one. Wired into `narrowSignatures` right after the
  `typedLen` block, trying every OTHER param position as receiver candidate
  and keeping whichever one EVERY live call site agrees on
  (`mergeParamFact`'s ordinary exact-agreement poison — the same meet
  `typedLen` itself uses).
- *Where validated*: `param-abi.js`'s new `validateLenBoundOfParams` —
  EXACT mirror of `validateTypedLenParams`'s exclusions, applied to BOTH
  param names: host-reachable (`exported`/`raw`/`valueUsed`) functions
  never trust it (an external caller isn't covered by a proof over the
  enumerated call sites); rest/default position on either side voids it;
  a body that WRITES either name voids it (the proof is an entry-time fact
  about the values bound at call, not an invariant re-derivable from a
  reassigned local).
- *Where consumed*: `canonical-bounds.js`'s `scanBoundedLoops` — when the
  loop bound is a bare name that doesn't resolve through `decls`/
  `lengthRecv` (i.e., it's a parameter, not a loop-local `.length` temp),
  fall back to `ctx.func.lenBoundOf?.get(boundVar)`; if present, treat it
  exactly as if the bound had syntactically been `recv.length` — every
  downstream safety check in the function (`idx !== recv`,
  `!isReassigned(body, idx/recv/boundVar)`, `!redeclaresName`) is
  UNCHANGED and applies identically regardless of how `recv` was
  identified. Seeded into `ctx.func.lenBoundOf` (a new field on
  `active-function.js`'s per-function record, alongside `typedLen`) at the
  SAME two sites `typedLen` is seeded (`analyze-for-emit.js`,
  `emit-func.js`), independent of the `typedCtor` gate those sites nest
  `typedLen` inside (this fact's receiver need not be typed — tokenizer's
  is a STRING).
- **Why sound, precisely — the soundness condition the task asked for
  stated explicitly**: the fact is an ENTRY-TIME relation between two
  parameter VALUES, true once at the call and never re-derived. What could
  invalidate it: (1) *writes through aliases* — guarded by
  `validateLenBoundOfParams`'s body-write check on both names, AND by the
  receiver being consumed ONLY in `scanBoundedLoops`, whose OWN existing
  `!isReassigned(body, recv)` check is unconditional; (2) *re-entrancy* — a
  callback reachable from the loop body mutating the receiver mid-activation
  would need the receiver's LENGTH to be able to change at all; `scan`'s
  receiver is a JS STRING, immutable by language definition, so this
  channel is closed by construction, not by an extra proof — **this is
  exactly why `scanBoundedArrIdx` (the array-idx sibling proof, same file)
  deliberately does NOT take the same fallback**: a mutable Array receiver
  COULD shrink mid-activation through an alias, and unlike the canonical
  `for (i=0; i<recv.length; i++)` case (which re-reads `recv.length` fresh
  every iteration and so self-corrects), a `len`-parameter bound is FIXED
  at entry and decoupled from the receiver's live length — trusting it for
  a shrinkable receiver would be a real OOB-read hazard, not merely an
  imprecision. Extending to `scanBoundedArrIdx` would need its own argument
  (e.g., gating on `ctx.func.typedElem?.has(recv)` — jz's typed arrays are
  fixed-length for their lifetime — or on the SAME `neverGrown`-style
  whole-callee-graph closure §6.2 needs) — not attempted here, on purpose;
  (3) *host boundary* — closed by `validateLenBoundOfParams`'s
  `hostReachable` exclusion, inherited for free from `siteState`'s own gate
  in `narrow/index.js` (a site targeting an exported/value-used callee
  never even reaches the fact-merge rule); (4) *growth* — not applicable to
  a string's `.length` at all (immutable value), and moot for the excluded
  mutable-receiver sibling.
- **No transitive/soft pre-pass**: unlike `typedLen`/`typedCtor`, this is
  ONE direct hard pass — a wrapper-forwarding chain (`g(a,b){return
  f(a,b)}` where `g`'s own `lenBoundOf` would need to feed `f`'s) is NOT
  wired (would need `boundedByCallerLength` taught to consult
  `state.callerParamFacts('lenBoundOf')` the way `inferTypedLen` already
  does for its own field) — skipped because the corpus doesn't currently
  exercise it and an unverified code path in a bounds-elision prover is a
  liability, not a convenience. Flagged as the natural next increment if a
  future case needs it.

**Measured.** `bench-size.mjs --json`, full 60-case corpus, before
(`35148654`) vs after: **exactly one line changes** —
`tokenizer jz=1981→1796 (jz_wasmopt=1968→1770), as=1551` unchanged — every
other case byte-identical. Ratio 1.277×→1.158×. `refactor-oracle.mjs check
--ref 35148654` across the full 142-spec corpus: exactly 2 differences,
both `bench:tokenizer` (`O0`: 15814B→15724B; `size`: 1981B→1796B), both
reductions, nothing else touched. Reading the compiled WAT confirms why the
win is larger than "one guard removed": eliding the bounds check ALSO drops
`charCodeAt`'s contract from f64 (NaN-capable, for the OOB case) to raw i32
(`inBoundsCharCodeAt`'s own existing i32/f64 contract choice — canonical-
bounds.js's module doc), which cascades into simpler downstream comparisons
throughout `scan`'s classifier body. Landed as four commits per the
campaign rule (fact channel, then consumer, plus two same-session hardening
follow-ups caught on self-review): `35fc571e` (the `lenBoundOf` channel —
`refactor-oracle`: 568/568 entries identical, confirming it is a pure no-op
until consumed), `258cc7bf` (the `scanBoundedLoops` consumer — the two
tokenizer diffs above), `3a728fda` (comment rewrap, no functional change),
`5d587c4c` (a cycle guard in `boundedByCallerLength`'s single-def alias
chase — `singleDeclInit` resolves independent of walk order, unlike
`bodyAffineEnv`'s incrementally-populated env, so a pathological
`const n = n - 1` could otherwise recurse forever instead of failing
closed; re-verified inert on the real case after landing it: tokenizer
still 1796B, oracle still shows exactly the same 2 diffs). Full battery,
all green: `test/kernel-parity.js` 39/39 (39 assertions); `npm run build`
clean; `test/index.js` (native) 3894/3895 pass (1 pre-existing skip, 0
fail, 29286 assertions); `test/kernel-oracle.js` 15/15 (738 assertions);
`test/pointers.js` 73/73 (132 assertions); `test/data.js` 210/210 (1171
assertions); `test/invariants.js` 29/29 (169 assertions);
`JZ_TEST_TARGET=jz.wasm test/index.js` (self-hosted) 3058/3059 pass (1
pre-existing skip, 0 fail, 15181 assertions). Zero failures anywhere,
native or self-hosted.

---

**Instance 2 — dispatch's `code[i] ∈ [0,7]`: precisely diagnosed, NOT
bounded.** §3.3's own framing ("a value-range fact about an array's
CONTENTS, tracked across a write-site/read-site function boundary... a
different, harder proof than the INDEX-bounds proofs already closed") is
confirmed correct, and this session narrows exactly WHERE it is hard.

`bench/dispatch/dispatch.js`: `fill(code, ks)` writes `code[i] = s &
(NOPS-1)` (NOPS=8) once in `main`; `runKernel(code, ks)` (a SEPARATE,
non-inlined function — called from 2 sites) later reads `ops[code[i]]` as a
call target through `devirtConstFnArrayCalls`'s (`optimize/devirt.js`)
const-fn-array devirtualization. Reading the compiled WAT directly (`node
scripts/bench-size.mjs` compile of `dispatch.js`, `optimize:'size'`) shows
the exact cost: `code[i]` is read, checked (`i32.lt_u … (i32.const 8)`),
and on OOB falls back to a sentinel closure (`__fc3`); the resulting boxed
value is then `br_table`-dispatched over its 8 known closure identities,
with a `call_indirect` DEFAULT arm — the Table (4B) + Elem (14B, 8 entries)
+ 8 standalone `$closure0..7` functions (kept ONLY as `call_indirect`
targets) exist SOLELY to serve that default arm and the OOB sentinel path.

**A cross-function content-range channel for exactly this fact ALREADY
EXISTS, end-to-end, and needed NO new machinery to build — `arrayElemRange`**
(`param-reps.js`'s own field list; producer `narrow/index.js`'s `rangeAtSite`
+ `summaries.js`'s `inferTypedValueRanges`, "whole-program typed-elem store
range hulls"; consumer `interval-proof.js`'s `ev()`, `written = ctx.func.
localReps?.get(x)?.arrayElemRange`, already used for e.g. `table[in[j]]`-
style narrow-typed-load range bounds). **This session found and FIXED (then
reverted — see below) a real, narrow imprecision in its producer that was
the ONLY reason it wasn't already proving `[0,7]` for `code`.**

`fill` gets inlined into `main` (single call site) before `narrowSignatures`
runs, so `computeDirectEffects` (`summaries.js`) never even sees `fill` as a
separate callee for THIS instance's own local-range tracking (verified by
instrumenting `inferTypedValueRanges` directly — `main`'s inlined body shows
mangled names `codef17_0`, `inl0_sf15_2` etc., confirming inlining precedes
this analysis). The actual break: `runKernel`'s OWN summary
(`computeDirectEffects`, walking `runKernel`'s un-inlined body — 2 call
sites keeps it standalone) marks its `code` param `bad: true` — NOT because
`code` is written (it isn't; `runKernel` only reads it) but because
`ops[code[i]](x, ks[i])`'s CALL node has `code` appearing inside the
CALLEE-SELECTING expression (`n[1] = ['[]', 'ops', ['[]', 'code', 'i']]`),
and `computeDirectEffects`'s receiver-mutation guard —
`if (mentions(n[1], name)) sum[k].bad = true` — treats ANY occurrence of
`name` ANYWHERE in the callee subtree as "this call might mutate `name`",
not just when `name` IS the receiver. `code` here is merely the KEY
selecting which closure runs — the same "element/property reads do not
[alias]" exemption the function's own comment already grants every OTHER
read site, just not this one. **Fix verified**: narrowing the guard to the
callee's actual RECEIVER (the base of a `.`/`?.`/`[]`/`?.[]` access, reusing
`carries` — the SAME aliasing primitive already trusted one line below for
the args loop, in place of the blanket `mentions`) makes `runKernel`'s
`code` summary `bad: false`, `main`'s local `codef17_0` range settle to
`[0,7]`, and `paramReps.get('runKernel').get(0).arrayElemRange` finally
resolve to `[0,7]` — confirmed by direct instrumentation of the fixpoint.
`refactor-oracle.mjs check --ref 35148654` over the FULL 142-spec corpus
with ONLY this fix applied: **CLEAN, 568/568 identical — zero bytes change
anywhere, including dispatch.** The producer fix was therefore reverted
(no case shrinks; landing a verified-inert diff serves nothing this
campaign's gates require) rather than committed; it is fully specified
above for whoever picks this up next (`summaries.js`'s `computeDirectEffects`,
the `if (n[0] === '()')` block, `mentions(n[1], name)` → receiver-scoped
`carries`).

**Why it's still zero bytes even with the channel correct — the actual gap
is on the CONSUMER side, and it is not one gap but two:**
1. `ops[code[i]]`'s checked read is NOT gated by `typedIdxProven` at all —
   confirmed by testing (the producer fix alone changed the WAT nowhere).
   `typedIdxProven`'s whole family is scoped to TYPED (numeric) array
   receivers (`canonical-bounds.js`'s own module doc: "Two sibling proofs…
   array-idx is a bounds-check elision" via `scanBoundedArrIdx`/
   `inBoundsArrIdx` — the GENERAL-array sibling). `ops` is a plain `Array`
   of closures, so the relevant authority is `inBoundsArrIdx`, and THAT
   function has only ONE proof class — the canonical structural loop
   `for (i=C; i<recv.length; i++) recv[i]` — no analog of `typedIdxProven`'s
   class 6 ("refined-range proof": `exprType(idx)==='i32'` then
   `intExprRange(idx)`, which for a TYPED receiver can already reach into
   `arrayElemRange` via `interval-proof.js`'s `ev()`). `ops[code[i]]` is not
   a canonical loop over `ops` at all (`code[i]` isn't `ops`'s own induction
   variable) — so `inBoundsArrIdx` correctly, structurally, does not fire,
   and there is no general-array counterpart to fall back to. Closing THIS
   needs a genuinely new proof class, ported into the general (non-typed)
   array checked-read path, not merely a channel fix.
2. Even with (1) closed — the read fully unchecked, `ops[code[i]]`
   unconditionally one of the 8 known closures — `devirtConstFnArrayCalls`
   does not currently have any code path that OMITS the Table/Elem/8-
   closure fallback. Its own doc is explicit and deliberate: "The untouched
   original call_indirect is the default arm… semantics are bit-identical
   regardless of the candidate set" — it ALWAYS preserves a runtime
   fallback, by design, independent of whatever proof produced the
   candidate arms. Teaching it to omit the fallback when the feeding index
   is separately proven exhaustive is a real design change to a pass whose
   current soundness story is "no proof needed, the fallback covers
   everything" — a materially different, higher-risk kind of change than
   extending a bounds-check elision, and it is where the bulk of the 19B
   actually lives (the guard/sentinel that (1) alone would remove is a
   small fraction of the total; Table+Elem+8 outlined closures are the
   rest).

**Verdict: NOT bounded this session.** Two new consumer-side mechanisms are
needed (a general-array index-value-range proof class; a devirtualization
pass willing to trust an external proof to drop its own safety net), one of
which is an architectural change to a pass that currently trusts nothing
but itself. Recorded here at a level of precision the campaign can act on
directly next time — the old §3.3 framing ("a different, harder proof") is
now three concrete, separately-attackable engineering tasks instead of one
diffuse "needs a proof" note.

---

**Instance 3 — immutable's element-replace bound: precisely diagnosed, NOT
bounded.** §3.5's own framing is confirmed and sharpened to the exact
consumer wiring and the exact reason today's proof rejects it.

`bench/immutable/immutable.js`: `initParticles()` builds `ps` via `N`
(=4096) unconditional `ps.push({...})` calls in a literal-trip loop —
exactly `inferInternalArrayLengths`'s (`summaries.js`) own target shape, so
`initParticles.arrayLen = 4096` is provably known. `runKernel(ps)` then does
`ps[i] = {x,y,vx,vy}` (element replace, same index range `[0,N)`, no
push/no `.length` write) once per particle per step. Reading the compiled
WAT: the store recomputes the array's base (`sib5 = p - i*16`), loads the
header at `sib5-8` (the array's CURRENT capacity, in the general dynamic-
element-store path every non-`neverGrown` array write pays), and gates the
4-field store behind `i32.lt_u(i, header_capacity)` — INSIDE the hot loop,
every iteration.

**The consumer wiring for a fix already exists and is ready to be fed**:
`neverGrown` (a `ValueRep`/`paramReps` field — `param-never-grown.js`'s
whole-callee-graph closure proof) feeds `emit-func.js`'s
`plannedStableHeaderNames` → `optimize/licm.js`'s `stableHeaderNames`,
which hoists exactly this header LOAD out of a loop when the receiver's
header is proven stable (`licm.js:360`, "proven stable-header pointer —
VAL.TYPED or ARRAY neverGrown"). No new wiring needed there — `ps` simply
never qualifies today.

**Why it doesn't qualify — and why BOTH of the two relevant existing
analyses independently reject it for the SAME underlying reason.**
`param-never-grown.js`'s own doc already states the gap precisely: `
neverGrown` requires the body to ONLY EVER PURELY READ the param
(`safeReads`); `ps[i] = {...}` writes, disqualifying it unconditionally —
there is no notion of "writes, but only ever an in-bounds replace" anywhere
in that scan. Separately, `inferInternalArrayLengths`'s OWN "length-
preserving parameter" tracking (the mechanism that would otherwise let
`runKernel`'s `ps` carry its proven 4096-length capacity fact forward)
INDEPENDENTLY rejects it for the identical reason: its per-statement walk
poisons a tracked name on `Array.isArray(n[1]) && refs(n[1], name)` for any
`ASSIGN_OPS` node — `ps[i] = {...}`'s own LHS `['[]', 'ps', 'i']` references
`ps`, so this fires unconditionally, with no in-bounds exception either
(confirmed by reading `summaries.js`'s `locals`-tracking `verify` walk —
the SAME pattern, same file, ~80 lines from the `neverGrown` sibling
concern). **Both proofs need the identical new primitive**: "is `arr[idx] =
expr` (for this specific write, in a known loop context) provably an
in-bounds REPLACE — `idx` provably `< arr`'s own constructed length — never
a resize", usable from BOTH `param-never-grown.js`'s scan (to admit the
write as safe) AND `summaries.js`'s length-preservation tracking (to let
the capacity fact itself survive the write and keep flowing to
`runKernel`'s param). Neither half is landable alone: `neverGrown` alone
would let LICM hoist the header LOAD but the per-iteration COMPARISON
against a non-constant capacity would remain (only a full "capacity ≥ N,
proven" fact — the SECOND half — turns the conditional store into an
unconditional one and removes the base-recompute entirely, which is what
the ledger's original "provably fixed length, no grow/forward check fast
path" language was asking for).

**Verdict: NOT bounded this session.** This is a genuine generalization of
a MEMORY-SAFETY CRITICAL, default-deny, whole-callee-graph closure analysis
(`param-never-grown.js`'s own doc: "default-deny — nested arrows are walked
as part of the enclosing body… unknown callees poison") — landing a new
"safe in-bounds replace" admission rule there, correctly, needs its own
focused design-and-review pass (the in-bounds proof itself likely needs to
reuse or parallel `typedIdxProven`'s machinery for OBJECT-schema array
receivers, which `typedIdxProven` does not cover today — it is typed-numeric-
receiver-only, same gap as dispatch's instance 2). Attempting it inside an
already-large multi-instance session, alongside the higher-confidence
tokenizer fix, would trade the session's remaining verification depth
(empirical, byte-by-byte, before commit — the standard this ledger holds
every landed fix to) for speed on the hardest of the three instances. Two
concrete next steps for whoever picks this up: (a) design the shared
"provably in-bounds replace, not a resize" predicate once, as a small
reusable primitive parallel to `typedIdxProven`'s canonical-loop class but
for object/schema-array receivers; (b) wire it into BOTH
`param-never-grown.js`'s `_NG_SAFE_METHODS`-adjacent write scan and
`summaries.js`'s two independent poison sites (`computeDirectEffects`'s
receiver-write guard is unaffected — this is the SEPARATE local-tracking
`verify`/`locals` walk) — landing either alone is an inert diff, exactly as
instance 2's producer fix was.

---

**Summary verdict for §6.1**: 1 of 3 bounded and implemented (tokenizer,
−185B, `1981→1796`, four commits (two substantive, two same-session
hardening), full battery green native and self-hosted); 2 of 3 precisely
diagnosed but correctly NOT implemented (dispatch needs two new consumer-
side mechanisms, one of which is an architecture change to a
deliberately-conservative devirtualization pass; immutable needs a new
shared in-bounds-write predicate touching a memory-safety-critical
whole-program closure analysis in two places). Both un-implemented
instances converge on the SAME missing primitive at their core — a
provable relationship between an INDEX (or a value read from another
array) and a receiver's true extent, for receivers `typedIdxProven`
does not cover (general Arrays; object-schema Arrays) — which is itself a
useful finding: bucket (b) was "one hard case, then three", and is now
"three, of which one closes cleanly and the other two both bottleneck on
one missing general-array range-proof class." That class, if built, would
likely unblock both remaining instances at once — a genuine next campaign
target, not merely two more one-off gaps.
