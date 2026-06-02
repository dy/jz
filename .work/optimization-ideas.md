# jz optimizer — feasibility analysis

Analysis of the four "potential compiler improvement" FIXMEs that lived in the README's optimization section. Grounded in the current source; each item notes where it hooks in, difficulty (S/M/L), and expected payoff. Honest about what's worth doing vs. what's low-ROI.

Current state for context: ~25 passes across three layers — AST plan (`src/compile/plan/`, `src/compile/narrow.js`), WAT-IR (`src/optimize/index.js`, `src/optimize/vectorize.js`), WAT-level (`src/wat/optimize.js`). Value model is NaN-boxed f64; dynamic access dispatches via `__ptr_type` / `__typed_idx` / `__str_idx`.

---

## 1. Vectorization

**Today** (`src/optimize/vectorize.js`): lane-local map loops (i8–f64, unit stride only — address must be `(i32.add base (i32.shl i K))`, K≤3, `vectorize.js:464-479`), horizontal reductions (`+ ^ & |`, and f32/f64 `min`/`max`, `:317-364`), and straight-line f64×2 dot pairs (`:119-201`). Bails on: calls, conditionals (except the NaN-canon `select`), mixed element types, loop-carried scalars, stencils, non-unit stride.

### Q1 — Array-of-structures (`a[i*3+k]`)
**Blocker:** `matchLaneOffset` (`vectorize.js:464-479`) only accepts `i<<K` (K≤3); interleaved access produces `(i32.mul i C)` / byte-stride offsets it rejects. SIMD-128 also has no gather, and a 16-byte `v128.load` can't span interleaved fields.
- **Route A — AoS→SoA layout transform** (each field its own contiguous region → already-vectorizable unit stride). **L**, multi-week, cross-cutting: the carrier ABI (`src/abi/array.js`) would need a `schemaId` threaded through every array consumer (`__arr_*`, hash, emit, `hoistInvariantPtrOffset`). `structInline` is the groundwork but still emits interleaved. Payoff high *only* for struct-array numeric kernels — and jz's real workloads (biquad/mat4/rfft) already hand-write SoA typed arrays that vectorize today.
- **Route B — strided/gather loads** (`v128.loadN_lane` deinterleave). **M** recognizer, but **low payoff**: for 2-field AoS, two `load64_lane` + address math lose to one SoA `v128.load`; no native gather.
- **Verdict:** Defer. The existing advisory (`advise.js:296`, `simd-aos-stride` → "split into SoA") is the right answer. True AoS SIMD is high-effort / low-ROI right now.

### Q2 — What else can vectorize (ranked by ROI)
| Idea | Where | Diff | Payoff |
|---|---|---|---|
| **i32/i64 `min`/`max` reductions** | add to `REDUCE_OPS` `vectorize.js:317-336` (ops exist, exact, no NaN) | **S** (~10 lines) | real — common, falls back to scalar today |
| **i32 product reduction** (`p *= a[i]`) | `REDUCE_OPS`, identity 1 (`i32x4.mul` already in `LANE_PURE`) | **S** (~3 lines) | small but clean |
| **`v128.select` conditional lanes** (clamp, masked fill) | new `LANE_COMPARE` table + non-NaN `select` case at `vectorize.js:1134` | **M** | medium — enables `cond ? … : …` loops |
| **i8/i16→i32 extending-add** (byte sums) | `extadd_pairwise_*` recognizer (`:315` notes the gap) | **M** | moderate |
| **Stencils** `a[i-1..i+1]` via shifted loads | new stencil mode; relax `:702` loop-carried gate with aliasing proof | **M** | niche (no current bench uses them) |
| **charCodeAt / string SIMD scan** (`i8x16.eq`+`any_true`) | new recognizer (string-scan shape ≠ map shape) | **L** | **high for parsers** (subscript is a target) |
| **relaxed-SIMD FMA** | add to `LANE_PURE` | **M** | gated on availability + NaN semantics |

**Do first:** i32 min/max + product reductions (S, table-only), then `v128.select`. charCodeAt-scan is the biggest strategic win but a distinct pass.

**Structural note:** vectorization only fires after carrier inference has stripped a value to a direct `i32.load`/`f64.load`. Any still-dynamic value in the loop body (plain `Array`, closure capture) keeps `__ptr_type` calls and never lifts — correct, but means mixed typed/dynamic loops won't vectorize regardless of shape.

---

## 2. Closing the size gap to hand-written WASM

**Today:** jz geomean ≈0.85× AssemblyScript (`asc -O3`), ~on par at `-Oz`, ~25× smaller than Porffor. But hand-WAT is 3–8× smaller on tight kernels (mat4: 3.3 kB vs **414 B**; biquad: 3.4 kB vs **767 B**). `wasm-opt -Oz` still finds ~25–30% slack on jz output. `.work/todo.md`: "single-use runtime-helper inlining + merging `$f$exp` wrappers is the next lever."

**Where the bytes go:** generic allocator helpers (`_alloc`/`_clear`), stdlib/runtime helper functions, NaN-box helpers (`$__ptr_type` etc.), math wrappers (`$f$exp` …), per-function/encoding overhead — not the hot code, which is already tight.

### Levers (ranked by payoff/effort)
| Lever | Where | Diff | Payoff |
|---|---|---|---|
| **Inline single-use runtime helpers** (the bulk of the wasm-opt slack) | extend WAT inliner `src/wat/optimize.js` | **M** | **high** — biggest size lever, matches todo |
| **Tree-shake unused stdlib stubs more aggressively** | `treeshake` `optimize/index.js:2222` | **M** | high — drops helpers a kernel never calls |
| **Merge duplicate / wrapper functions** (`$f$exp` and friends) | WAT-level dedup pass | **M** | medium |
| **`specializeMkptr` threshold 5→3, `specializePtrBase` 20→10** | `optimize/index.js:1677,1805` | **S** | small, free wins |
| **Default `alloc:false` for provably-scalar modules** | auto-detect no heap marshaling | **S–M** | removes allocator from pure-numeric output |

**Realistic floor:** jz can plausibly recover most of the 25–30% wasm-opt slack (self-ratio → ~0.95). The 3–8× hand-WAT gap is largely **structural** — generic helpers, number formatting, and residual dynamic dispatch a hand-coder simply omits. `alloc:false` + `optimize:'size'` already roughly halves it (mat4 3.3 kB → ≤2.5 kB, biquad 3.4 kB → ≤3.0 kB). Matching hand-WAT byte-for-byte is not a realistic target; "within ~1.5–2× with the size knobs on" is.

---

## 3. New / generalized optimizer passes

### Speed
1. **Induction-variable strength reduction** — replace per-iteration `base + (i<<k)` with an accumulating `ptr += stride`. `hoistAddrBase` (`optimize/index.js:358`) is the groundwork; add IV recognition. **M**, **high** for DSP kernels (biquad/zzfx).
2. **Tail-call optimization** — emit `return_call` for tail-recursive `return f(…)` (AST recognition in `emit.js`). **M**, medium speed + makes deep recursion (parsers, tree walks) stack-safe.
3. **LICM global-read hoisting across arena-safe callees** — `pureGiven` (`optimize/index.js:657`) rejects `global.get` when any call is in the loop; link `arenaRewindModule`'s existing `safeCallees` set to allow it. **S**, low–medium.
4. **Speculative `call_indirect` devirtualization** — guard hot single-target callbacks with `if ptr==known { direct } else { indirect }`. **L**, callback-heavy code only.

### Size
5. **NaN-box round-trip elimination across inlined boundaries** — kill `rebox(unbox(x))` that survives inlining; audit `ctx.abi?.number?.peephole` (`optimize/index.js:2134`) coverage. **M**.
6. **Cross-`if` CSE** — `csePureExpr` clears its table entering each arm (`optimize/index.js:979`); carry the pre-condition table in (invalidate on writes). **S**.
7. **Adjacent `f64.store`→`v128.store` coalescing** (straight-line, e.g. object-slot init) — peephole at WAT-IR. **M**, SIMD-on only.

### Devirtualization reality check
Narrowing already removes most `__ptr_type` dispatch on typed-array code (zzfx/watr). What remains is **genuinely necessary** (an unnarrowed `f64` can hold any type) or needs whole-program/profile specialization. Biggest residual cost is `call_indirect` for callbacks (#4), and `__dyn_get_expr` slot lookup for opaque-schema objects (`ir.js:459`).

### Cheap generalizations of existing passes
- Lower `specializeMkptr` `MIN_USES` 5→3 (`optimize/index.js:1677`) — pure size.
- Switch inlining heuristic from AST node count to emitted-WAT size (`inlineHotInternalCalls`) — tighter, low risk.
- Raise scalarization cap `maxScalarTypedArrayLen` 32→64 (`plan/common.js:114`) — bigger kernels in registers (watch the 128-local LEB128 cliff).

---

## Recommended order (overall ROI)
1. **i32 min/max + product reductions** — S, real speed, table-only. *(Q2)*
2. **specializeMkptr/PtrBase threshold tuning** — S, free size. *(Q3/Q4)*
3. **Single-use runtime-helper inlining** — M, the biggest size lever. *(Q3)*
4. **Induction-variable strength reduction** — M, high speed for DSP. *(Q4)*
5. **Tail-call optimization** — M, speed + recursion safety. *(Q4)*
6. **`v128.select` conditional lanes** — M, broadens vectorization. *(Q2)*
7. **charCodeAt SIMD scan** — L, strategic for parser workloads. *(Q2)*
8. **AoS→SoA** — L; defer, current "split to SoA" advice suffices. *(Q1)*

Items 1–2 are afternoon-sized and ship immediate wins; 3–5 are the meaningful levers; 8 is explicitly not worth it yet.

---

## Status & ground-truth corrections (implementation pass 2026-06-02)

Implemented the safe item end-to-end and pressure-tested the rest against the actual codegen. Several analysis estimates were optimistic — corrected here.

**DONE — SIMD product reductions** (`p *= a[i]` over i32/i64/f32/f64). Added 4 entries to `REDUCE_OPS` (`src/optimize/vectorize.js`) + 2 tests (`test/simd.js`). Integer product is exact (associative/commutative mod 2ⁿ); float product carries the same ulp caveat as the existing float-add reduction. Verified green: `npm test` (opt2), opt3, wasi, selfhost (11/11), `CI=1 test/bench.js` gate, fuzz 2k (0 divergence across 30,883 inputs).

**Corrections to the feasibility estimates:**
- **Int min/max reductions: rated S, actually M.** WASM has no scalar `i32.min`/`i64.min`; jz emits a `select`, so they don't match the single-binary-op recognizer, and the horizontal fold (which reuses the scalar op) has no op to reuse → needs a dedicated recognizer + select-based fold. (Float min/max already vectorize via `REDUCE_CANON`.)
- **"v128.select" is actually if-expression vectorization (M–L).** jz lowers `cond ? x : y` to `(if (result f64) COND (then X) (else Y))` with the condition wrapped (`i32.ne (cmp …) …`), NOT a `select` node. Vectorizing means matching the if-expr, lifting both branches + a comparison→mask, emitting `v128.bitselect`. Fails-closed, but genuinely new logic.
- **Size headroom is ~10%, not 25–30%.** Measured on the size track (`optimize:'size'`): `jz/(jz+wasmopt) = 0.895×`, `jz/AS = 0.901×` (already smaller than `asc -Oz` on geomean). `specializeMkptr`'s threshold is explicitly "tuned so helper cost amortizes" — lowering it risks de-optimizing. Biggest remaining lever stays single-use helper inlining.

**Prerequisite for the next vectorizer batch: FUZZ-1.** The fuzzer is scalar-only; the vectorizer has zero generative coverage. Product reductions were safe because trivially parallel to the existing `add` path; int-min/max and conditional vectorization are new codegen in jz's audio/DSP hot path — add Float64Array generative fuzzing first, then they land safely.

**Revised near-term order:** (1) ✅ product reductions · (2) FUZZ-1 Float64Array coverage · (3) conditional/if-expr vectorization (highest domain value: ReLU/clamp/threshold) · (4) int min/max reductions · (5) induction-variable strength reduction. Helper-inlining (size) and tail-call (recursion) remain independent M items, not gated on FUZZ-1.

---

## Status & corrections — pass 2 (2026-06-02, FUZZ-1 + conditional vectorization)

**DONE — FUZZ-1 (real SIMD coverage).** `test/fuzz.js` gained a pure-MAP mode (`--typed-map`, gate `fuzz: Float64Array pure-map`): internal `new Float64Array(N)` with a const bound (so the loop actually vectorizes) and a value expr that includes `?:` conditionals, diffed element-wise vs JS (Object.is) across opt{0,1,2,3}. The pre-existing `--typed` mode never vectorized (combined map+reduce ⇒ loop-carried `acc`; also an f64 `n` bound ⇒ `f64.lt` exit test the recognizer skips). Verified 5000×4-opt green.

**DONE — conditional-lane vectorization.** `liftExprV` now lifts `(if (result T) COND (then X)(else Y))` → `v128.bitselect(X, Y, mask)` with a `LANE_COMPARE` (scalar-cmp→SIMD-cmp) table (`src/optimize/vectorize.js`). Subtlety that mattered: `v128.bitselect` evaluates X,Y before its mask operand, but the element's address `local.tee` lives in COND — so the mask is hoisted into a `block (result v128)` and computed FIRST, preserving scalar condition-before-branches order. Fails-closed (only adds vectorization). relu/clamp keep folding to the min/max canon path; genuine distinct-arm conds (threshold, mix) now lift.

**Correctness bug FOUND BY FUZZ-1 AND FIXED (the headline).** seed 1039 tripped a pre-existing opt2 miscompile: `(select x x cond)→x` in `src/wat/optimize.js` (vacuum) dropped `cond` even when impure. With an address `local.tee` inside `cond`, a conditional typed-array store (`cond ? K : K`, arms folding equal) lost its address and left the element at its init value. Fixed by `&& isPure(node[3])`. This validates the whole premise of doing FUZZ-1 first — it earned its keep on the first broad sweep.

**Remaining feasibility note discovered:** a `hoistConstantPool`-pooled constant becomes a `global.get`, which `liftExprV` doesn't lift → it silently keeps a map scalar (e.g. a conditional using `0.0`, which also appears in the `!= 0` booleanization). Perf-only, fails-closed. Cheap fix queued: treat a loop-invariant `global.get` as a splat in `liftExprV`.

**Verification (all green):** `npm test` (opt2) 1945/1946, opt0/opt1/opt3/wasi matrix, selfhost 11/11, `CI=1 test/bench.js` 70/70 (no perf/size regression), fuzz: typed-map 5000×4 + scalar 3000×4, zero divergence.

---

## Status & corrections — pass 3 (2026-06-02, int-reduction probe)

Inspected the real IR for the next batch (int min/max, extending-add, IV strength reduction). The backlog under-estimated the first two — they share a root blocker.

**Int sum / min/max reductions are blocked by the integer-accumulator lowering, NOT the recognizer.** `let s=0; s = (s + a[i])|0` over an Int32Array does NOT emit `i32.add` — it emits `select(i32.wrap_i64(i64.trunc_sat_f64_s(f64.add …)), …)`: compute in f64 (the integer contract — no wrap until 2⁵³), then ToInt32. Same for the `a[i] > mx ? a[i] : mx` ternary (it routes through the same f64/box/ToInt32 path). So the reduction recognizer (which matches `s = OP(s, EXPR)` with a clean binary op) never fires. Only *unambiguously*-i32 ops vectorize today: bitwise `xor`/`and`/`or` and `Math.imul`. (`Math.max` over an int array returns an f64 accumulator with an i32 load — a mixed lane/load type the recognizer also rejects.) Float64Array sum/product/min/max already vectorize fully.

→ Closing the int-reduction gap is **L**, not M: it needs a *pure-i32 reduction-accumulator* path (keep `s += a[i]` as `i32.add` when the accumulator is provably i32 and `|0`-clamped each step) — which touches the integer-wrap contract — OR a recognizer for the `select(wrap(trunc(f64.add …)))` shape with correct per-step-ToInt32 reassociation. Both are contract-sensitive correctness work; do it as a dedicated task with its own fuzzing, not a quick add.

**Extending-add (i8/i16→i32)** inherits the same blocker (the `+` is f64) *and* needs `extadd_pairwise` widening — L.

**IV strength reduction:** independent of the above, but marginal on the wasm→V8 path (V8 strength-reduces the loaded module itself) while touching core address arithmetic — low ROI vs risk. Deprioritized.

**Net:** the genuinely landed SIMD wins this session are product reductions, conditional (`?:`) maps, and the pooled-const `global.get` splat — plus the correctness fix. Int-reduction vectorization is real but contract-entangled; recommend it as a separate, fuzzed effort rather than a quick batch.
