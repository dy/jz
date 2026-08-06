# Rival WAT analysis — radixsort, sdf, sort, trace

Comparative WAT dissection of jz's speed-tier host build against each case's best
rival (`bench/results.json`: radixsort → zig-wasm, sort → zig-wasm, sdf → c-wasm,
trace → c-wasm), disassembled with `wasm2wat` (wabt 1.0.36) and read side by side.
Read-only: no source edits, no dist builds, no timing runs (numbers below are
*read* from the committed `bench/results.json`, not remeasured this session).

Method: rebuilt jz's speed-tier host wasm for the 4 cases directly via
`compile()` (mirrors `bench/bench.mjs`'s `compileJzHost`, minus the timing
harness) — byte-identical to the cached bench build (2624/4981/1967/2661 bytes),
confirming no codegen drift since the cache was built. Rival wasm read from the
cached bench build dir (`zig build-exe -O ReleaseFast` / `zig cc -O3` artifacts,
`JZ_BENCH_BUILD_DIR` default `$TMPDIR/jz-bench/<case>/`). All four `run_kernel`-
class hot functions read in full; C/Zig function names came from each binary's
own `name` custom section (`wasm2wat` **without** `--generate-names`, which
otherwise silently discards it).

## Headline state (bench/results.json, jz commit 2eb3af0b, current HEAD 213c04b0 — no
## src/ change between them touches these 4 cases)

| case | jz vs rival | state |
|---|---|---|
| radixsort | 1.035× zig-wasm | **CLOSED** — was 1.456–1.472×; lever landed `ca718788` |
| sort (heapsort) | 1.030× zig-wasm | **CLOSED** — was ~1.42–1.53×; levers landed `cfbb23dd` (2026-07-26) + `d6460bce` |
| sdf | 1.199× c-wasm | **OPEN** — documented hard tail, research-tier (sentinel/symbolic-hull proof) |
| trace | 1.492× c-wasm | **OPEN** — documented hard tail (branch misprediction; two levers tried, both measured neutral, one reverted for unsoundness) |

The premise "the rivals definitely have something more optimal, worth
implementing" is **already true only for two of the four cases**. For
radixsort and sort, the WAT-level gap the rival held was root-caused and
closed in the days before this session — the honest finding here is *confirm
closed, don't re-chase*, and catalog what (small) differences remain. sdf and
trace are the two cases still carrying real gaps, and both are pre-existing,
heavily-instrumented hard tails, not overlooked levers — see the ALREADY-
DISSECTED section. The one genuinely new, general, cheap lever this session
found (range-check fusion not recursing into `&&` chains) was found by
diffing jz's own emitted code against itself (x vs y in trace's bounds check),
not by copying a rival trick — but it's real, general, and unrelated to the
already-chased hard tails.

---

## Per-case technique tables

### radixsort vs zig-wasm (`radixsort.runKernel`, WAT lines ~1380–2242 of the zig binary)

| technique | zig-wasm | jz | class |
|---|---|---|---|
| array-refill (`a[i] = base[i] + it`) | scalar, 4× pointer-offset unroll (no SIMD) | **SIMD**, `i32x4.splat` + `i32x4.add`, 4-wide | jz ahead here — not a rival advantage |
| histogram bump `count[d]++` | scalar, 2× unroll, plain `i32.add`/`i32.store` | scalar, no unroll, plain `i32.add`/`i32.store` (post-`ca718788`) | (a) unroll only — see inventory item 3 |
| prefix-sum `count[i]=sum; sum+=c` | scalar, 4× unroll (batched loads, then serial adds) | scalar, no unroll | (a) unroll only, LOW priority |
| scatter `b[count[d]]=a[i]; count[d]++` | scalar, 2× unroll, **no bounds check** (raw store) | scalar, no unroll, **bounds-checked store** (`count[d]<16384 ? store : skip`), unconditional `count[d]++` | (b) SEMANTICS-PRICED — see below |
| digit extraction `(a[i]>>shift)&0xff` | shift amount folded as immediate per unrolled pass | same (4 passes fully unrolled, shift 0/8/16/24 constant-folded) | parity |

### sort (heapsort) vs zig-wasm (`sort.runKernel`, WAT lines ~1209–1472)

| technique | zig-wasm | jz | class |
|---|---|---|---|
| array-refill (`a[i] = src[i] + it`) | scalar, 4× pointer-offset unroll | **SIMD**, `f64x2.splat` + `f64x2.add`, 2-wide | jz ahead here |
| sibling-index bound `child+1 < n` | **strength-reduced to `child == n-1`** (n is a comptime-constant array length) | `i32.lt_s`/`i32.ge_s` against a **runtime-loaded** `n` (header `i32.load`, hoisted once per call, not folded to a literal) | (a) LOW-confidence secondary item — see inventory item 2 |
| pick-larger-child select | branch form (block + `br_if` skip-store) | branch form (`if`/`else` returning i32, no eager `select`) | parity — jz's own `cfbb23dd` (2026-07-26) landed exactly this shape |
| child-index vs `end` compare (extract phase) | `i32.lt_u` (child is `usize`, naturally unsigned) | `i32.lt_s` (child is signed i32) | cosmetic — signed/unsigned compare is the same cost on wasm/native; not a real lever |

### sdf vs c-wasm (`run_kernel` / `edt1d`, WAT lines ~7357–8000)

| technique | c-wasm | jz | class |
|---|---|---|---|
| gather/scatter row↔column copies | scalar, 4× pointer-offset unroll | scalar, no unroll | (a) unroll only, LOW priority (not the hard tail) |
| hull-vertex access `v[k]`, `z[k]`, `f[v[k]]` in `edt1d`'s inner while | **raw, unchecked** load/store (ReleaseFast: no slice bounds check) | **checked read** (`if 0≤k<len then load else NaN`) at every access — the f64/NaN cascade this forces is the actual hard tail | (c) ALREADY-DISSECTED — hard tail, not a lever |
| hull-pop `while(sMid <= z[k]) k--` | plain decrement + pointer walk | plain decrement (index-based) | parity in structure; cost is entirely in the checked-read tax above |

### trace vs c-wasm (`run_kernel`, WAT lines ~6875–7100)

| technique | c-wasm | jz | class |
|---|---|---|---|
| `x>=0 && x<W` bound test | **single fused unsigned compare** (`(u32)x > 511 → skip`) | **single fused unsigned compare** (`i32.le_u 511`) — already matches | parity |
| `y>=0 && y<H` bound test (3rd/4th conjunct of the same `&&` chain) | **single fused unsigned compare**, same as x | **two separate signed compares + `i32.and`** — the x/y asymmetry is a real jz gap | (a) TRANSFERABLE — inventory item 1 |
| conditional `visited[y*W+x]=1` store | **branches** around the store (no masked/conditional store in wasm) | **branches** around the store, identically | (b) SEMANTICS-PRICED / true hard tail — both engines pay this, confirmed by reading C's own WAT, not just citing the archive |
| direction dispatch (`dir==0/1/2/3` → x++/y++/x--/y--) | `br_table` (4-way jump table) | branchless `select` chain (3 compares + 3 selects, twice — once per candidate loop-versioning arm) | (c) ALREADY-DISSECTED — `selectArmUpdates`/`traceLoop` select-lever, measured neutral on trace, landed for the general class anyway |
| codes-buffer bound `nc<MAXCODES` | plain signed compare per store | **loop-versioned**: a fast unchecked arm (`L11`) guarded by a hoisted range precondition, and a slow checked arm (`L17`) as fallback | jz ahead in structure here (loop versioning); not a rival technique |

---

## TRANSFERABLE inventory (ranked by expected impact)

### 1. Recurse `fuseRangeCheck`/`fuseRangeCheckOr` across left-deep `&&`/`||` chains

**Where**: `src/compile/emit.js` — `rangeBound` (852–868), `fuseRangeCheck`
(874–882), `fuseRangeCheckOr` (887–~900), called once each from the `'&&'`
handler (5687) and `'||'` handler (5773).

**What's wrong**: `&&` parses left-deep (subscript's generic left-associative
`binary()` combinator — `node_modules/subscript/parse.js:90`, default
`right=false`), so `x>=0 && x<W && y>=0 && y<H` is
`((((x>=0 && x<W) && y>=0) && y<H))`. The `'&&'` emit handler fires once per
`&&` **node**, calling `fuseRangeCheck(a, b)` on that node's immediate
children only. `rangeBound()` requires `n[0]` to be a bare comparison op — it
rejects a subtree headed by `&&`. So fusion only ever fires on the
**innermost** pair (`x>=0`, `x<W`, direct children of the deepest `&&`); every
later pair in the chain (`y>=0`, `y<H`) has an intervening `&&` node between
it and its partner and never fuses. Verified directly: compiling
`bench/trace/trace.js` emits `i32.le_u $x 511` for the x-bound (fused) and
`i32.and(i32.ge_s $y 0, i32.lt_s $y 512)` for the y-bound (unfused) — same
source shape, different emitted code, purely because of chain position.

**Fix**: when `rangeBound(a)` fails because `a[0] === '&&'` (resp. `'||'`),
recurse: try `fuseRangeCheck(a[2], b)` — `a`'s right child is the conjunct
adjacent to `b` in source order — and on success return
`['&&', a[1], fusedInner]`. Sound because every operand here is a pure
comparison (no side effects to reorder) and `&&`/`||` are associative over
pure boolean operands; short-circuit order is preserved (`a[1]` still
evaluates and gates first). Mechanical, localized entirely to `emit.js`, no
new range-fact machinery, no narrow.js/type.js involvement.

**Proof obligation**: same as the existing single-pair fusion — `rangeBound`
already restricts to bare-name `x` against compile-time-integer constants; the
recursive form adds no new soundness surface, only reach. Pin: extend
`test/optimizer.js`'s existing range-fusion assertion to a 3-/4-conjunct chain
and check the WAT contains one `i32.le_u`/`i32.sub` pair, not two
`i32.ge_s`/`i32.lt_s` + `i32.and`.

**Expected share**: LOW on trace specifically — the archive's own measurement
(`TRACE SELECT-LEVER`/`TRACE PERF WAVE`, archive-todo-2026-07.md ~351–366,
~5819–5830) already established that removing checks from this exact loop is
wall-clock-neutral there, because the true cost is the data-dependent branch
misprediction on `if(inside)`, not comparison count. The value of this item is
**general, not trace-specific**: any `a>=0 && a<B && c>=0 && c<D`-shaped
conjunction (2-D bounds tests are the single most common shape in image/grid/
raster code — sdf's `transform`, any scanner/parser digit-classification with
more than one range test chained) currently only gets the fusion on its first
pair. Free, always-safe, corpus-wide reach; land as a small standalone item,
not a trace-fix.

### 2. Constant-fold typed-array `.length` when the allocation size is a literal (exploratory, lower confidence)

**Observation**: `sort-host.wat`'s `f2` computes `n = a.length` via a runtime
header load (`i32.load` at `ptr-8`, `>>>3`), hoisted once per call — never
folded to the literal `8192`, even though `a = new Float64Array(8192)` is a
literal-sized, never-reassigned, never-resized binding for the whole bench.
zig's equivalent (`heapsort(a: *[N]f64)`) knows `N` as a comptime constant and
LLVM strength-reduces `child+1 < n` all the way to `child == n-1` (a compare
against a fixed immediate) — jz's `child+1 < n` stays a live two-operand
compare against a runtime-loaded value.

**Plausible locus**: `ctx.types.typedLen` (populated at allocation sites,
`src/compile/analyze.js:164–168`, consulted at `type.js:118,659,1983` and
`compile/analyze.js:1601–1603`) already carries exactly this fact — the
literal length, keyed by binding name — but the `.length` *emission* path
(`module/core.js`'s `emitLengthAccess`, `VAL.TYPED` arm, 1018–1019, which
calls the `$__len` runtime helper; the native mirror in
`src/compile/emit.js` shares the header-load shape, e.g. the `len64Of`
pattern at 6175–6198) doesn't consult it. `emit.js`'s existing
`immutableLenBound` (1119–1129) already proves the *hoisting* soundness gate
(`!isReassigned(body, name)` for `VAL.TYPED`) — the constant-fold would reuse
that same non-reassignment proof, plus requiring the allocation-site size
argument to be a literal (already what `typedLen` records).

**Caveat**: I traced the fact-store and the two plausible emission sites but
did not locate and read the single definitive `.length`-member-read dispatch
point the way item 1's site was pinned down — this needs a follow-up read
before it's implementation-ready. Flagged at lower confidence deliberately
rather than overclaimed.

**Expected share**: LOW–MEDIUM. sort/radixsort are already at 1.03× — this
would shave a header load plus enable further compare-vs-constant strength
reduction on top of an already-closed case, not open new headroom. Worth a
cheap follow-up look, not worth a dedicated session.

### 3. Manual unroll on histogram/prefix-sum/scatter (radixsort) and gather/scatter copies (sdf) — LOW priority

zig/C's 2×/4× scalar pointer-offset unrolling on these loops has no jz
counterpart (jz's `unrollScalarChain` pass, present in the registry, doesn't
fire here). Given radixsort is already 1.035× and sdf's gap is dominated by
the checked-read hard tail (item below), unrolling these loops is unlikely to
move either case meaningfully. Recorded for completeness, not ranked above
items 1–2: chasing the last 3% on an already-closed case is the wrong use of
a soundness-gate-cost session per this codebase's own stated method (see
`70748f70`'s own "banked rather than rushed" disposition on the sort/radixsort
levers before they landed).

---

## SEMANTICS-PRICED (rival shape depends on unchecked/UB semantics jz can't assume)

- **radixsort scatter write** `b[count[d]] = a[i]`: zig ReleaseFast slice
  stores are UB-if-out-of-bounds (bounds checking compiled out); JS typed-
  array writes past the end are spec'd no-ops (ECMA-262
  `IntegerIndexedElementSet`), so jz must guard the store. Cheap in practice —
  the guard is always-true by the histogram/prefix-sum invariant, and a
  perfectly-predicted branch is near-free on an OOO core; matches the
  measured 1.035× (the guard is not visibly costing anything). Not worth
  removing even if provable — the win would round to zero.
- **sdf's `v[k]`/`z[k]`/`f[v[k]]` checked reads**: see ALREADY-DISSECTED below
  — the checked-read tax is real and is the actual hard tail, but removing it
  needs a *semantic* (sentinel-invariant) proof, not a *syntactic* one; zig's
  unchecked equivalent is UB-licensed, jz's isn't.
- **trace's conditional `visited[...]=1` store**: confirmed by reading C's own
  WAT (not just the archive) that GCC/Clang-via-LLVM pays the *same* branch
  here — wasm has no masked/conditional-store instruction, so this is a
  target-ISA limitation both compilers hit identically, not a technique gap.

## ALREADY-DISSECTED (cite, don't rechase)

- **sort — original flag-veto** (`cfbb23dd`, 2026-07-26, `todo.md:3830`):
  heapify's pick-larger-child `select` fed by a nested data-dependent `if`
  (comparison over memory loads) loses to the branch form on V8; the
  `dataDependentFlag` predicate (`ir.js` ~610) composed with `eagerSelectOK`
  routes this shape to a branch instead of an eager select. Landed, confirmed
  still in effect in the current WAT (jz's sift-down/extract loops use
  `if`/`else` returning i32, matching zig's own branch-form dispatch).
- **sort — `child+1<n` f64-round-trip regression, and radixsort —
  `count[d]++` f64-round-trip**: root-caused in `70748f70` (2026-08-05,
  `todo.md` "Status (2026-08-05, THREE SPEED REDS DISSECTED…)"), landed as
  `d6460bce` (sort speed lever B: typed `.length` magnitude bound + loop-guard
  hull channel) and `ca718788` (radixsort speed lever A: self-referential
  typed-int member increment skips `addFitsI32`). Confirmed CLOSED by this
  session's WAT read — both `count[d]++` and the sift-down bound compares are
  plain `i32.add`/`i32.lt_s`, no `f64.convert`/`trunc_sat` round-trip anywhere
  in either hot loop.
- **trace — branch-layout class, 1.40–1.49× residual**
  (archive-todo-2026-07.md ~121–131 "TRACE LEVER IDENTIFIED", ~351–366 "TRACE
  SELECT-LEVER — BUILT, EXACT, MEASURED NEUTRAL", ~495–511 "RESIDUALS: trace
  1.40 = branch-layout class (checks are gone)", ~5819–5830 "TRACE PERF WAVE —
  CLEAN NEGATIVE, REVERTED"): two levers already tried — select-arm
  accumulation for the direction update (landed for the general
  state-machine/automaton class, measured wall-clock-neutral on trace itself)
  and store-side bounds-check elision for the `visited[]` write (tried,
  reverted — neutral AND a real soundness corner in kernel/self-host legs).
  The residual is the `if(inside)` branch's data-dependent misprediction
  itself (bitmap-driven, ~50/50), which no codegen lever removes because it's
  inherent to the conditional store, not to check cost — confirmed this
  session by reading C's own WAT: it pays the identical branch around its
  `visited`-equivalent store.
- **sdf — hull-cursor / sentinel-invariant hard tail**
  (archive-todo-2026-07.md ~132–142 "SDF RESIDUAL DISSECTED", ~6041–6053 "SDF
  SHARPENED"): `k`'s lower bound (`k>=0`, never crossed because of the
  `z[0]=-INF` sentinel) is a semantic invariant no syntactic range fact
  captures, and `f[v[k]]` needs a symbolic, flow-sensitive elem-hull for `v`
  (constant-hull `arrayElemRange` already serves the constant-hull gather
  class; this needs the relational/runtime-`n` extension, unbuilt).
  Classified research-tier by the original dissection; this session's WAT
  read confirms the checked-read shape (`if 0≤k<len then load else NaN`) is
  exactly as described, unchanged, and is the dominant cost in `edt1d`'s inner
  loop — no new angle found.

---

## Deliverable

Doc: `.work/rival-wat-analysis.md` (this file).
Ledger pointer: one-line entry appended to `.work/todo.md`, committed
alongside this doc, local only (no push).
