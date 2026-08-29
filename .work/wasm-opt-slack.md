# wasm-opt slack: attribution and closure

Campaign for `perf/wasm-opt-slack` (worktree, branch off `17bca77f`). Owner's brief:
`CONTRIBUTING.md`'s performance invariant says `wasm-opt -Oz` should find little to
remove in jz's own output; the gate `WASMOPT_SLACK_MIN=0.70` (`test/bench.js`)
still allows ~25-30% slack per its own comment, target 0.95+.

Iron rule (`CLAUDE.md` "optimize the tool, never the input"): `bench/` sources are
fixed specimens. Every byte saved comes from the engine, generically — never a
per-case special case.

Method: `scripts/bench-size.mjs`'s own `jzCompileSize`/`wasmOptSize` helpers,
replicated verbatim (same `wasm-opt -Oz --all-features` invocation, same compile
options) for both the `'size'` preset (what the gate measures) and the `'speed'`
preset (`bench/bench.mjs`'s `compileJzAt(c, {level:'speed'})` — what the per-case
`SPEED`/AS gate uses). Toolchain: `wasm-opt` version 128, `asc` 0.28.19, `watr`
5.9.3 (matches `package.json`'s `^5.9.3` pin), node v25.9.0.

---

## 0. Headline finding: the gate is stale, not tight

Before attributing anything, the baseline measurement itself contradicts the
brief's premise. Fresh `scripts/bench-size.mjs --json` at `17bca77f` (unmodified):

- **geomean size-preset slack = 2.88%** (ratio 0.9712), not "~25-30%".
- **worst single case = `shapes` at 9.53%** (ratio 0.9047).
- **zero of 58 comparable cases fall below `WASMOPT_SLACK_MIN=0.70`** — the gate
  has roughly 20-25 points of unused headroom on every case in the corpus, not
  "margin," today.

`git blame` on the constant: `WASMOPT_SLACK_MIN = 0.70` was set once, on
2026-05-15 (commit `720831d5`), and never touched again — 3.5 months of daily
engine work (the S2 loop-body fixpoint, watr 5.5.0 intguard checked-read
collapse, the cross-function PARAM TYPEDLEN channel, etc. — see
`.work/handoff-2026-08-22.md`, `.work/size-leadership.md`) closed most of the
codegen-size gap as a side effect of correctness/speed work, but nobody
re-ran the ratchet described in `CONTRIBUTING.md`: *"when you shrink codegen,
tighten... the `wasm-opt` slack budget."* The "~25-30%" prose in
`CONTRIBUTING.md` and the comments in `test/bench.js` (lines 187-189, 264-267)
describe a state that no longer exists. This is the single highest-value,
zero-risk finding of this session: **most of the "gap" the brief describes was
already closed by other work; what's left is real but an order of magnitude
smaller than documented.**

The **speed preset** (not gated today, measured per the brief's instruction
since "the per-case AS gate uses the speed preset") shows a materially larger
gap: **geomean 8.57% slack**, several cases 15-22% (`radixsort` 22.3%, `bezfit`
19.8%, `conv2d` 19.5%, `watr` 19.7%). Section 3 explains why this is mostly a
*different, already-understood, deliberate* trade (`hoistConstantPool` is
turned OFF at speed on purpose — see §3), not new engine slack.

---

## 1. Per-case slack table (size preset — the gate; speed preset — recorded per brief)

`jz` = raw `compile(..., {optimize, alloc:false})` bytes. `wasm-opt -Oz` = same
bytes through `wasm-opt -Oz --all-features` (bench-size.mjs's exact invocation).
Slack = `1 - wasm-opt/jz`; negative means `wasm-opt -Oz` made jz's output
*larger* (see §2). `jessie` and `jz` (the two graph-module cases) fail to
compile under `bench-size.mjs`'s single-file harness both before and after
every change in this session — pre-existing, unrelated to this campaign.

| case | size jz (B) | size wasm-opt -Oz (B) | size slack | speed jz (B) | speed wasm-opt -Oz (B) | speed slack |
|---|---:|---:|---:|---:|---:|---:|
| alpha | 1113 | 1060 | 4.8% | 1915 | 2129 | -11.2% |
| aos | 1972 | 1872 | 5.1% | 2591 | 2359 | 9.0% |
| base64 | 1701 | 1644 | 3.4% | 2063 | 1809 | 12.3% |
| bezfit | 3624 | 3822 | -5.5% | 18425 | 14775 | 19.8% |
| biquad | 1858 | 1806 | 2.8% | 5352 | 4691 | 12.4% |
| bitwise | 1100 | 1016 | 7.6% | 1467 | 1301 | 11.3% |
| blur | 1538 | 1483 | 3.6% | 5771 | 5173 | 10.4% |
| bytebeat | 995 | 931 | 6.4% | 1211 | 1078 | 11.0% |
| callback | 1669 | 1616 | 3.2% | 1897 | 1754 | 7.5% |
| colorconv | 2459 | 2493 | -1.4% | 5689 | 5809 | -2.1% |
| colorlch | 2969 | 3150 | -6.1% | 6837 | 6893 | -0.8% |
| colorlog | 2018 | 2028 | -0.5% | 4562 | 4977 | -9.1% |
| colorpq | 5053 | 4985 | 1.3% | 14362 | 16144 | -12.4% |
| conv2d | 1535 | 1470 | 4.2% | 5510 | 4436 | 19.5% |
| crc32 | 1124 | 1070 | 4.8% | 1850 | 1681 | 9.1% |
| delayline | 1656 | 1567 | 5.4% | 1821 | 1643 | 9.8% |
| deltae | 3650 | 4069 | -11.5% | 4420 | 4161 | 5.9% |
| dict | 1330 | 1260 | 5.3% | 1689 | 1505 | 10.9% |
| dispatch | 1813 | 1883 | -3.9% | 2074 | 1875 | 9.6% |
| dotprod | 1069 | 1009 | 5.6% | 1498 | 1385 | 7.5% |
| fft | 2384 | 2184 | 8.4% | 4090 | 3505 | 14.3% |
| fftplan | 30763 | 30328 | 1.4% | 36917 | 34637 | 6.2% |
| glyfparse | 3082 | 3265 | -5.9% | 5449 | 5097 | 6.5% |
| hash | 1151 | 1078 | 6.3% | 1391 | 1233 | 11.4% |
| hashjoin | 1495 | 1413 | 5.5% | 1979 | 1762 | 11.0% |
| heat | 1445 | 1356 | 6.2% | 1844 | 1643 | 10.9% |
| immutable | 1851 | 1774 | 4.2% | 2481 | 2292 | 7.6% |
| json | 8117 | 8015 | 1.3% | 10808 | 10449 | 3.3% |
| levenshtein | 1358 | 1318 | 2.9% | 2637 | 2323 | 11.9% |
| lorenz | 1543 | 1553 | -0.6% | 1759 | 1633 | 7.2% |
| lz | 2126 | 2136 | -0.5% | 4578 | 4183 | 8.6% |
| mandelbrot | 1121 | 1047 | 6.6% | 1911 | 1763 | 7.7% |
| mat4 | 1522 | 1445 | 5.1% | 3022 | 2803 | 7.2% |
| matmul | 1384 | 1302 | 5.9% | 1823 | 1678 | 8.0% |
| nbody | 2205 | 2154 | 2.3% | 3938 | 3607 | 8.4% |
| noise | 2168 | 2029 | 6.4% | 4549 | 4115 | 9.5% |
| nqueens | 1167 | 1118 | 4.2% | 1596 | 1411 | 11.6% |
| particle | 1609 | 1572 | 2.3% | 2110 | 1912 | 9.4% |
| poly | 1096 | 1045 | 4.7% | 1568 | 1469 | 6.3% |
| provenance | 30172 | 29617 | 1.8% | 35992 | 33702 | 6.4% |
| qoi | 2796 | 2689 | 3.8% | 3988 | 3848 | 3.5% |
| radixsort | 1424 | 1341 | 5.8% | 2746 | 2133 | 22.3% |
| raytrace | 2242 | 2232 | 0.4% | 5526 | 5167 | 6.5% |
| resample | 1933 | 1936 | -0.2% | 3592 | 3247 | 9.6% |
| sdf | 2737 | 2667 | 2.6% | 4934 | 4326 | 12.3% |
| shapes | 3023 | 2735 | 9.5% | 4811 | 4325 | 10.1% |
| sieve | 1090 | 1022 | 6.2% | 1394 | 1220 | 12.5% |
| slices | 2146 | 2040 | 4.9% | 2688 | 2372 | 11.8% |
| sort | 1667 | 1556 | 6.7% | 1927 | 1713 | 11.1% |
| spmv | 1935 | 1836 | 5.1% | 2543 | 2233 | 12.2% |
| strbuild | 1911 | 1862 | 2.6% | 2179 | 2028 | 6.9% |
| synth | 1895 | 1828 | 3.5% | 2035 | 1865 | 8.4% |
| tokenizer | 2094 | 2084 | 0.5% | 2813 | 2650 | 5.8% |
| trace | 1908 | 1852 | 2.9% | 2785 | 2501 | 10.2% |
| vm | 1531 | 1464 | 4.4% | 1789 | 1633 | 8.7% |
| watr | 299383 | 306304 | -2.3% | 540785 | 434085 | 19.7% |
| wav | 1655 | 1615 | 2.4% | 1925 | 1780 | 7.5% |
| wordcount | 16372 | 16238 | 0.8% | 16996 | 16595 | 2.4% |
| **geomean** | | | **2.88%** | | | **8.57%** |

**After fix 1** (§4): `shapes` (size) 3023→3019 B, `radixsort` and
`kernel-parity:dvnested` also shrink at O2/O3 (refactor-oracle catch, not in
this table — see §4). New worst case: `shapes` 0.9059 (was 0.9047).

---

## 2. Negative-slack cases: `wasm-opt -Oz` is not a pure oracle here

11/58 size-preset cases get *larger* under `wasm-opt -Oz`: `resample`, `lz`,
`colorlog`, `lorenz`, `colorconv`, `watr`, `dispatch`, `bezfit`, `glyfparse`,
`colorlch`, `deltae`. Root-caused via `wasm-objdump -h` before/after on
`bezfit` (3624→3822 B, +198): Global section shrinks 191B→23B (18 mutable f64
globals collapse to 4) while Code grows 3192B→3557B (+365) — `wasm-opt`
un-hoists jz's `hoistConstantPool` globals back to inline `f64.const` at every
read site. `.work/size-leadership.md` §4 item 1 already independently proved
jz's hoist-vs-inline break-even policy (hoist wins once a constant is read
≥2 times: 12B decl + 2B/use vs 9B/use inline) is *correct* — `wasm-opt`
disagrees and is worse here, not jz. This is the same category of confound
`scripts/audit-fixpoint.mjs`'s own header comment documents for `-O3`
(unroll/vectorize deltas): a foreign optimizer's *different trade*, not jz's
slack. **Not a fix target — do not chase.**

---

## 3. Speed-preset const-hoisting: also deliberate, not a bug

Speed-preset `const-hoisting` (binaryen's function-local repeated-constant
hoist) alone finds 79076B / 9.97% aggregate across the corpus — the single
largest speed-preset number measured. `src/optimize/config.js`'s `'speed'`
preset (= level 3) explicitly sets `hoistConstantPool: false` on purpose: *"a
mutable global can't be constant-folded by V8... Inline `f64.const` is the
minimal lowering: V8 CSEs identical constants for free. Measured -3% on
jessie parse for +14% binary — exactly the size↔speed trade `'speed'` exists
to make."* `wasm-opt`'s function-local const-hoisting works directly against
this deliberate choice. **Not a fix target at speed** — flagged so nobody
re-discovers and "fixes" it.

---

## 4. Pass-class attribution (size preset, the gate)

Every named group below (mapped 1:1 onto the brief's list, using this
`wasm-opt`'s actual flags — `--gvn` does not exist in this build; `--gufa`
[Grand Unified Flow Analysis] is the closest available substitute for
"ssa+gvn", called out explicitly, not silently swapped) run **individually**,
`--all-features -c <flags> in.wasm -o out.wasm`, against each case's raw
`'size'`-preset wasm, converged to its own local fixpoint. Ranked by geomean
ratio (lower = more of the corpus it shrinks) over the 47/58 cases where
`wasm-opt -Oz` finds *any* positive slack (excludes §2's 11 negative-slack
cases, where "did this group shrink it" isn't the right question).

| group | geoRatio | total bytes | % of jz | avg share of full -Oz's win | cases with ≥1B |
|---|---:|---:|---:|---:|---:|
| const-hoisting | 0.9930 | 863 | 0.54% | 25.9% | 57 |
| vacuum | 0.9931 | 721 | 0.45% | 21.6% | 55 |
| optimize-instructions | 0.9932 | 841 | 0.52% | 22.9% | 58 |
| directize+dae | 0.9935 | 1041 | 0.65% | -3.1% | 43 |
| cfg-cleanup (merge-blocks/remove-unused-brs/remove-unused-names) | 0.9935 | 980 | 0.61% | 23.2% | 58 |
| local-cse | 0.9940 | 661 | 0.41% | 20.2% | 58 |
| locals (simplify/coalesce/reorder-locals) | 0.9940 | 673 | 0.42% | 15.9% | 43 |
| code-folding | 0.9942 | 672 | 0.42% | 19.9% | 58 |
| rse | 0.9943 | 660 | 0.41% | 19.6% | 57 |
| dce | 0.9943 | 638 | 0.40% | 19.3% | 57 |
| duplicate-function-elimination | 0.9943 | 638 | 0.40% | 19.3% | 57 |
| merge-similar-functions | 0.9943 | 638† | 0.40%† | 19.3%† | 57 |
| inlining-optimizing | 0.9960 | -175 | -0.11% | 6.8% | 50 |
| simplify-globals-optimizing | 1.0088 | -1875 | -1.16% | -87.6% | 22 |
| precompute(-propagate) | 1.0337 | -5105 | -3.17% | -190.9% | 2 |
| gufa (~cross-fn value flow; no `--gvn` in this build) | 1.0706 | -10575 | -6.56% | -307.3% | 2 |
| ssa-form-cse (`--flatten --ssa-nomerge --local-cse --vacuum`, ~"ssa+gvn") | 4.8100 | -590536 | -366% | — | 0 |

† `merge-similar-functions`'s geoRatio/aggregate-total row is dominated by
the 57 SMALL cases, where it ties `dce`/`duplicate-function-elimination`
exactly (same bytes, same cases — a shared small dead/duplicate-helper
residue). Its real story is a single outlier the geomean-over-47-cases table
can't show: **on `watr` alone it finds 28297B (9.5% of that one 299383B
module)** — by far the single largest number in this entire sweep. See §6.

`ssa-form-cse` is **not real signal** — `--flatten` alone explodes every
nested expression into flat single-assignment statements with fresh locals,
which is a *normalization* step meant to precede a recombination tail
(coalesce+DCE+re-fold) it doesn't get when run alone; 4.81x is an artifact of
running one half of a two-part pipeline, not a shrink opportunity. Excluded
from ranking.

**Speed preset**, same method, 53/58 positive-slack cases (full numbers in
this doc's companion `attribution.speed.json`/`attribution.size.json` in the
worktree's `.work/` — summarized): `const-hoisting` 0.9658 (9.97%, **but
deliberate, §3**), `directize+dae` 0.9676 (1.95%, 15500B — same class as
size), `locals` 0.9839 (3.17%, 25178B — bigger at speed, more scratch temps
from unrolling), `cfg-cleanup` 0.9928, `merge-similar-functions` 0.9932
(8.46%, 67156B — same watr-self-host outlier, bigger module). The class
ranking is the same shape as size; nothing new qualitatively.

---

## 5. WAT idioms — the top three classes, concretely

### (a) `merge-similar-functions` — near-duplicate large function bodies (watr, 28297B / 9.5%)

Pairing `wasm-opt --print` output before/after by function index (order is
stable across this transform) surfaces three clusters of functions with
**byte-for-byte identical WAT text before** (267727 / 21188 / 18810 chars
respectively, ×2-3 each) that collapse to 427-531-char thunks after. Sample
(function type = `(param f64 i32 f64×8) (result f64)` — jz's uniform closure
ABI, `$__env f64, $__argc i32, $__a0..a9 f64`):

```
before:  (func $322 (type $0) (param $0 f64) …9 more f64 params…) (result f64)
           (local $10 i32) … 289 locals total …
           (local.set $1 (i32.load (i32.wrap_i64 (i64.reinterpret_f64 (local.get $0))))) …
           … ~10,000 lines of real closure-body logic …
after:   (func $322 (type $0) (param $0 f64) (result f64)
           (call $<shared-impl> (local.get $0) (i32.const <k1>) …))
```

`--duplicate-function-elimination` alone (exact structural match) finds only
2879B on the same module — these bodies are *similar*, not byte-identical, so
only the fuzzy merge (which factors out one shared implementation and
converts each original to a thunk parameterized by the few positions where
they differ) catches them. `duplicate-function-elimination`/`dce` agreeing
exactly on 638B elsewhere (§4's `merge-similar-functions` row) is a *different*,
much smaller, exact-duplicate residue — the 28297B watr number is
`merge-similar-functions`'s *own* additional find, not a re-count.

This is a pure, jz-semantics-free, whole-module structural transform — no
NaN-boxing/proof knowledge needed, only WASM-level body comparison. Per
`src/optimize/config.js`'s own documented two-layer contract ("watr/optimize
owns generic structural rewrites... dedupe"), **this class belongs in watr**,
not `src/optimize/`. **Deferred to the watr-side campaign** (§6).

### (b) `directize`+`dae` — dead/constant-argument elimination (colorpq, 400B / 7.9%)

jz's own named WAT (`compile(..., {wat:true})`) makes the mechanism legible.
`$math.pow(x, y)` is full JS-spec `Math.pow` (NaN/±Infinity/±0/non-integer-
exponent branch ladder, 1049 lines) called from exactly one place, `$spow`,
which forwards its own `e` parameter untouched. `$spow` is itself called 10
times from `$main`, and **all 10 call sites pass the identical second
argument**, `(global.get $__fc5)` — a jz-`hoistConstantPool`-hoisted shared
f64 global:

```
(call $spow (f64.div (local.get $__inl11_inl12_Ya) (global.get $__fc4)) (global.get $__fc5))
(call $spow (f64.div (local.get $__inl11_inl17_M)  (global.get $__fc4)) (global.get $__fc5))
… 8 more, every one ending  (global.get $__fc5) …
```

`--dae-optimizing` recognizes the argument expression is structurally
identical at every call site (a hoisted-global read is cheap/pure to
duplicate), drops the parameter, splices the shared expression into the
callee body once — `$spow`'s signature loses a param, which then lets
`$math.pow`'s **now call-site-invariant exponent** collapse the same way:
`(type $1)(param f64 f64)(result f64)` → `(type $0)(param f64)(result f64)`,
26189→18309 WAT chars. The hoisted-global read (not a literal `f64.const`) is
exactly what defeats a naive "is this arg a literal" check — jz's own
`hoistConstantPool` (independently correct, §2) is what hides the opportunity
from a shallower pass.

Also pure WASM-level structural reasoning (no jz semantics) — same config.js
boundary, **deferred to watr** (§6).

### (c) `optimize-instructions` — redundant bitmask after logical right-shift (shapes, 78B / 2.6% locally; fixed on jz's side)

```
before:  (local.set $6 (i32.and (i32.shr_u (local.get $1) (i32.const 23)) (i32.const 511)))
after:   (local.set $15 (i32.shr_u (local.get $10) (i32.const 23)))
```

Inside an inlined xorshift32 PRNG mix (`x^=x<<13; x^=x>>17; x^=x<<5`) followed
by bit-field extraction. `X >>> 23` is bounded to `[0, 2^9-1]` by the shift
alone; ANDing with `511` (`2^9-1`) is a no-op — the mask happens to be a
leftover source-level habit, not a real constraint. This is a **pure,
context-free algebraic identity** (no proof machinery, no jz semantics — just
"does this mask cover every bit the shift can produce"), exactly the class of
rule jz's own `src/optimize/peephole.js` already hosts alongside its
NaN-boxing-specific folds (e.g. `simplifyBoolContexts`'s generic `!= 0`/
double-`eqz` canonicalization lives there for the same reason: it rides the
existing fused bottom-up walk for free, and running *before* watr/LICM/CSE
lets those later passes see the simplified form too). **Fixed on jz's own
side — see §7.**

---

## 6. Classes deferred to the watr-side campaign

Per `node_modules/watr/src/optimize.js` (8677 lines, read for attribution
only, not edited): watr already implements conceptually-equivalent passes for
most of §4's diffuse classes — `treeshake`, `deadcode` (≈dce/vacuum),
`localReuse` (≈coalesce-locals/rse), `identity`+`strength` (≈optimize-
instructions), `branch` (≈cfg-cleanup), `constF64Globals` (≈module-level
const-hoisting). The residual `wasm-opt` still finds is therefore best read
as **watr's rule catalog being less complete than binaryen's mature, ~8+
year-old, heavily-fuzzed catalog for the same conceptual classes** — not a
missing jz-side pass. This matches `.work/core-simplification-audit.md` §5
item 1's own prediction almost exactly ("whatever generic pass classes
`wasm-opt -Oz` applies that neither jz's own `src/optimize/` nor watr's
fixpoint yet reaches... candidates: more aggressive... propagation across
function boundaries, duplicate-code folding of near-identical blocks, tighter
local coalescing"). Per `src/optimize/config.js`'s documented two-layer
contract, each is a generic structural rewrite with no jz-semantic
dependency, so each belongs in watr, external, not edited here:

| class | byte weight (this session's measurement) | idiom |
|---|---|---|
| **merge-similar-functions** | 28297B / 9.5% on `watr.size` alone (single largest number found); 67156B / 8.46% aggregate at speed | near-duplicate (not byte-identical) large function bodies from independently-compiled but structurally-similar source functions — §5(a) |
| **directize+dae** (dead/constant-argument elimination) | 400B / 7.9% on `colorpq.size` alone; 1041B/0.65% aggregate size, 15500B/1.95% aggregate speed | a parameter whose argument expression is syntactically identical (often a hoisted-global read) at every call site across the whole reachable call graph — §5(b) |
| **const-hoisting** (function-local, distinct from jz's own module-level `hoistConstantPool`) | 863B/0.54% aggregate size (real gap); 79076B/9.97% aggregate speed (**mostly deliberate, §3** — do not conflate) | a constant repeated ≥2× within one function's own body, never module-wide, so it never qualifies for jz's own pooling pass |
| **vacuum / dce / rse / local-cse / code-folding / cfg-cleanup / locals / inlining-optimizing** | 0.4-0.65% aggregate each; all concentrated in the 3 largest/most-real specimens (`watr`, `provenance`, `fftplan` — 30-300KB), near-zero on the small kernels | diffuse, overlapping, all dominated by the same single largest function (`main`/entry) in each big case — consistent with "smaller rule catalog on complex real programs," not a distinct per-class jz gap |
| **precompute / gufa / simplify-globals-optimizing** | net *negative* on this corpus in isolation (2/47, 2/47, 22/47 cases improve; more cases regress) | low confidence either way — matches `.work/core-simplification-audit.md` §5 item 4's own "flagged for investigation, not asserted as a loss" precedent; needs a case that exposes genuine cross-block redundancy before ranking further |

None of the above were touched in `src/optimize/` or `node_modules/watr` this
session.

---

## 7. Landed fix 1: redundant bitmask after `i32.shr_u`

`src/optimize/peephole.js`, `walkRewrite`: new rule, `(i32.and (i32.shr_u X K)
M) → (i32.shr_u X K)` when `M`'s low `(32-K)` bits are all set (checked both
operand orders; `i32` only — no measured `i64` evidence, not speculatively
added). Context-free, per-function, rides the existing fused walk (zero extra
pass).

**Verification** (per the campaign's required loop, all at `17bca77f` base):

- `node scripts/bench-size.mjs --json` (size preset), diffed against the
  fresh baseline in §1: **only `shapes` changes (3023→3019 B, -4B/-0.13%)**.
  Zero cases grow. 56/56 comparable cases (excl. the pre-existing
  `jessie`/`jz` failures) pass.
- `node scripts/refactor-oracle.mjs check --ref 17bca77f`: **8 differences,
  all pure byte reductions, zero growth, zero `errorClass` changes**, across
  3 specs at their O2/O3/size build levels:
  - `bench:shapes` — O2 3627→3623 (-4), O3 4811→4807 (-4), size 3023→3019 (-4)
  - `bench:radixsort` — O2 2534→2522 (-12), O3 2746→2734 (-12) — **not
    hand-traced**, found by the oracle: radix-digit extraction
    (`(key >>> shift) & digitMask`) is the same idiom class, confirming this
    generalizes beyond the one case it was diagnosed on.
  - `kernel-parity:dvnested` — O2 616→612 (-4), O3 624→620 (-4), size 617→613 (-4)
- Full battery (commit `790bbb7e`): `npm run build` (clean exit),
  `node test/index.js` (3864 specs / 28541 assertions, pass 3863, skip 1 —
  pre-existing skip, unrelated),
  `node test/kernel-parity.js` (3 specs / 33 assertions, pass 3),
  `node test/kernel-oracle.js` (14 specs / 605 assertions, pass 14),
  `node test/pointers.js` (73 specs / 132 assertions, pass 73),
  `node test/data.js` (209 specs / 1098 assertions, pass 209).
  `JZ_TEST_TARGET=jz.wasm node test/index.js` re-run once against the final
  combined state — see §9.

`shapes`'s own wasm-opt slack ratio moves 0.9047→0.9059 (still the corpus's
worst case) — most of the local win this rule finds is bytes watr's own
fixpoint already reached a different way in most instances; the 3 cases the
oracle caught are the net new ones.

**Speed-preset bytes** (direct `compile(..., {optimize:'speed'})`, cross-checked
against the oracle's O3 rows above — exact match): `shapes` 4811→4807 (-4B),
`radixsort` 2746→2734 (-12B). `sort`/`hash`/`sieve`/`base64`/`crc32` (other
bit-twiddling-heavy cases spot-checked for the same idiom) are byte-identical
at speed — the redundant-mask shape doesn't recur there.

---

## 7b. Landed fix 2: computed `i32.eq X, 0` → `i32.eqz X`

Found while hand-diffing `optimize-instructions`: WASM has a dedicated
compare-to-zero opcode, so

```
(i32.eq X (i32.const 0))  →  (i32.eqz X)
(i32.eq (i32.const 0) X)  →  (i32.eqz X)
```

produces the same i32 0/1 value in every context and removes two encoded
bytes. The rule lives in `walkRewrite`, next to fix 1, and handles both
operand orders. It is not limited to a boolean consumer: mask tests feeding a
`select`, global flags, and arithmetic predicates all qualify. This measured
slice is i32-only; no unmeasured i64 sibling was added speculatively.

One structural handoff must remain visible. The downstream dense-chain pass
recognizes switch candidates only as `i32.eq(local.get, const)` at every arm.
Changing the zero arm alone to `eqz` hides that arm and can split one
`br_table` into an outer `if` plus a smaller table. Because this peephole is
node-local and cannot prove whether its parent chain will satisfy the later
density/cost gates, it conservatively leaves **bare named-local** comparisons
unchanged and canonicalizes every other operand. The first broad draft did
not have that exclusion: the refactor oracle caught two +4 B O2/O3 outputs
from one fragmented dense chain. That draft was rejected; the final rule has
zero growth and preserves the single table. Extending the downstream matcher
to accept `eqz(local.get)` is watr-owned follow-up, not a benchmark exception.

`test/_optimizer-kernels.js` pins the general class, not a corpus specimen:

- the minimum five-arm same-local dense chain remains five literal
  `i32.eq(local,const)` conditions before watr and one `br_table` after watr
  at O2/O3;
- right-zero mask and left-zero arithmetic value expressions become `eqz` at
  O2/O3 and remain unoptimized at O0;
- all exports execute against fixed edge inputs at O0/O2/O3;
- native and JZ-hosted WAT are byte-identical at all three levels and both
  agree with the plain-JS oracle;
- one hosted compiler instance is exercised A→A, A→B, then B→A: A is
  byte-identical on every visit, B differs and executes as B.

**Size-preset bench output vs `790bbb7e`**: 6 shrink, 52 equal, zero grow (the
two graph-only cases retain their pre-existing single-file-harness failures):

| case | before | after | delta |
|---|---:|---:|---:|
| lz | 2126 | 2124 | -2 |
| noise | 2168 | 2152 | -16 |
| qoi | 2796 | 2794 | -2 |
| trace | 1908 | 1904 | -4 |
| watr | 299383 | 299373 | -10 |
| wordcount | 16372 | 16370 | -2 |

The wasm-opt slack geomean is 0.971394; the floor remains 0.905929
(`shapes`, 3019→2735 through wasm-opt), so the 0.90 ratchet remains sound.

**Refactor oracle vs `790bbb7e`**: 141 specs × O0/O2/O3/size, 67 changed
outputs across 23 specs; every one is a byte reduction, with zero growth and
zero compile/error-class changes. O0 is byte-identical throughout. Totals:
O2 -101 B (23 rows), O3 -167 B (23), size -78 B (21), -346 B combined.
Every changed row is listed below; each WAT diff starts at an eligible
non-local eq-zero site. Later watr CSE/local reuse can amplify or partially
offset the direct two-byte deletion (hence the -1/-5/-80 net rows), but no
unrelated opcode or semantic path initiates a delta.

| specimen | O2 | O3 | size |
|---|---:|---:|---:|
| bench:lz | 3901→3899 (-2) | 4578→4576 (-2) | 2126→2124 (-2) |
| bench:noise | 2550→2534 (-16) | 4549→4469 (-80) | 2168→2152 (-16) |
| bench:qoi | 3266→3264 (-2) | 3988→3986 (-2) | 2796→2794 (-2) |
| bench:trace | 2664→2660 (-4) | 2785→2781 (-4) | 1908→1904 (-4) |
| bench:watr | 368366→368356 (-10) | 540785→540773 (-12) | 299383→299373 (-10) |
| bench:wordcount | 16480→16478 (-2) | 16996→16994 (-2) | 16372→16370 (-2) |
| example:apollonian | 23686→23684 (-2) | 24699→24697 (-2) | 22881→22879 (-2) |
| example:bz | 26893→26885 (-8) | 28695→28689 (-6) | 22491→22486 (-5) |
| example:cloth | 25764→25762 (-2) | 26946→26944 (-2) | — |
| example:diffusion | 28624→28618 (-6) | 30880→30874 (-6) | 22224→22220 (-4) |
| example:lbm | 30920→30906 (-14) | 32737→32723 (-14) | — |
| example:magnet | 26016→26014 (-2) | 27274→27272 (-2) | 24270→24268 (-2) |
| example:maze | 29090→29088 (-2) | 30838→30836 (-2) | 24749→24747 (-2) |
| example:ocean | 36134→36132 (-2) | 40257→40255 (-2) | 26476→26474 (-2) |
| example:pathtracer | 26658→26656 (-2) | 28387→28385 (-2) | 25105→25103 (-2) |
| example:pendulum | 27050→27046 (-4) | 29438→29434 (-4) | 25031→25027 (-4) |
| example:penrose | 27324→27320 (-4) | 28502→28498 (-4) | 24035→24033 (-2) |
| example:raytrace | 30707→30705 (-2) | 32627→32625 (-2) | 25670→25668 (-2) |
| example:sand | 22764→22762 (-2) | 23441→23439 (-2) | 21470→21468 (-2) |
| example:slime | 26351→26350 (-1) | 28429→28428 (-1) | 22862→22861 (-1) |
| example:wireworld | 42987→42985 (-2) | 50418→50416 (-2) | 35179→35177 (-2) |
| kernel-parity:eqzero | 750→746 (-4) | 972→968 (-4) | 754→750 (-4) |
| watr:watr.js | 419756→419750 (-6) | 624316→624308 (-8) | 338221→338215 (-6) |

---

## 8. Ratchet

New worst-case measured slack ratio (size preset, post-fix-1): **0.9059**
(`shapes`). `WASMOPT_SLACK_MIN` raised **0.70 → 0.90** in the same commit as
fix 1 (small margin below the measured worst case, matching the tight-margin
pattern the original constant appears to have followed relative to its
own-era worst case). `CONTRIBUTING.md`'s "~25-30% slack... target is 0.95+"
prose corrected to match this session's measurement in the same commit —
leaving stale, disproven numbers in a doc that explicitly claims to be the
enforced invariant is worse than no doc.

Fix 2 shrinks six more size-preset cases (§7b) without changing the worst
case (`shapes` remains 3019 B raw / 2735 B after wasm-opt, ratio 0.905929).
No second ratchet bump is available beyond fix 1's 0.90 floor; if a later fix
changes the minimum, re-measure and ratchet again then.

---

## 9. Final verification (both fixes landed)

All commands below ran from `perf/wasm-opt-slack`; no broad speed benchmark
was run and no benchmark source was edited.

- `npm run build`: pass; wat-strip parity 3/3; final self-host artifact
  `dist/jz.wasm` validates at 17,904,176 B. Rebuilding the exact `790bbb7e`
  graph/config in memory produced 17,902,007 B, so the optimizer
  implementation itself costs +2,169 B in this unpublished/non-golden
  compiler artifact. That footprint is attributed here rather than hidden;
  generated-program artifacts are the product gate and none grows.
- `node test/optimizer.js`: 222 specs / 4,152 assertions, all pass, including
  the raw IR rule, O0/O2/O3 shape checks, one-table handoff, and native
  execution.
- `node test/kernel-parity.js`: 3 specs / 36 assertions, all pass;
  `node test/kernel-oracle.js`: 14 specs / 668 assertions, all pass. The new
  source is native/JZ-hosted WAT-identical and both execute identically to JS
  at O0/O2/O3.
- Targeted reset/determinism: `test/determinism.js` 5/37,
  `test/session-reentrancy.js` 20/61, `test/refactor-oracle.js` 2/50, all
  pass. The dedicated self-host A→A/A→B/B→A test also passes 6/6.
- `node test/self-compile.js`: 22 specs / 212 assertions, all pass, including
  build, fresh and reusable hosted compilers, and execution of their output.
- `JZ_TEST_TARGET=jz.wasm node test/index.js`: 3,040 specs / 14,675
  assertions, pass 3,039, skip 1 (the existing skip).
- `npm test`: 3,868 specs / 28,642 assertions, pass 3,867, skip 1.
  Matrix default/opt0/opt3 legs also pass respectively at 28,642 / 28,521 /
  28,644 assertions. The WASI leg reaches one pre-existing structural failure
  in `optimizer.js` (`charCodeAt` WAT contains one `__to_num` under the WASI
  host); the same targeted test fails identically at clean `790bbb7e` (1 vs
  expected 0). No gate was changed or loosened.
- `npm run test:262`: pass 2,976, negative-reject 3,908, fail 0;
  `npm run test:262:builtins`: pass 858, fail 0 (tracked skips/xfails remain).
- Size/golden gates: `bench-size.mjs --json` gives the six reductions in §7b,
  52 equal and zero growth; all four `golden size:` tests pass and an exact
  `790bbb7e` A/B compile shows all four byte-identical; `npm run test:ratchet`
  passes 10/10.
- `refactor-oracle.mjs check --ref 790bbb7e`: 141 specs × four levels,
  67/564 outputs differ exactly as listed in §7b; all 67 shrink, O0 is wholly
  identical, and there are no growth or error-class changes.
