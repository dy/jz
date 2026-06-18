# jz Vectorizer — Architecture Research & Roadmap

> Produced by the multi-agent `vectorizer-architecture-research` workflow (8 investigators →
> 4 architecture designs → 4 adversarial critiques → synthesis), then **verified against the
> live codebase**. Corrections from verification are in §0; they override the body where they
> conflict.

## 0. Verification corrections (read first)

The synthesis is accurate on its load-bearing codebase claims (`tryMapReduceVectorize`,
`liftPPC`/`PPC_CALL2`, `cloneNode`, `$math.sin2/cos2/pow2`, `matchExitBrIf` only matching
`lt_s`/`lt_u`, `Math.log` fdlibm-inlined — all confirmed). Three fixes:

1. **There is no native `f64.log` WASM instruction.** WASM f64 ops are only
   sqrt/abs/neg/ceil/floor/trunc/nearest/min/max/copysign — no transcendentals. So Step 4's
   "emit wasm `f64.log`" is impossible. The real options for the lyapunov/bifurcation `Math.log`
   cost are: (a) **host-import call** (`host:'js'` lowers `Math.log` to an `env.*` import — fast
   and accurate but adds a call boundary and is **platform-non-deterministic**, only available
   when a host provides it; breaks WASI/standalone), or (b) keep a polynomial but a **cheaper**
   one and provide a **2-wide vector mirror**. Step 4 should be reframed as "stop over-inlining
   the 30-op Cephes `log`; offer a host-import fast path **and** a 2-wide mirror," not "emit a
   native instruction."

2. **Name collision: `$math.log2` is already taken** — it means **log base 2** (scalar,
   `module/math.js:672`). The 2-wide-mirror naming convention is `sin`→`sin2`, `cos`→`cos2`
   (the `2` = "2 lanes"), which collides with `log2` = log₂. The vector log mirror needs a
   non-colliding name (e.g. `$math.logx2` / `$math.log_v` / `$math.vlog`). Pick a convention
   that disambiguates "2-wide" from "base-2" before adding `pow`/`log`/`atan2` mirrors.

3. **Dispatch-order nuance.** The report's "outer-pixel recognizers all run *first*" is a
   *proposed* invariant, not the current state. Today the chain (in `vectorizeLaneLocal`) runs
   `tryDivergentEscapeVectorize → tryMemCopyFill → tryVectorize → tryReduceVectorize →
   tryMapReduceVectorize → tryRampMap → tryBlurMultiPixel → tryChannelReduce → tryByteScan →
   tryPerPixelColor → tryStrengthReduceIV`. `tryVectorize` (inner map) currently runs *before*
   several outer-pixel recognizers. The recommended refactor (Step 2) makes the outer/inner
   tiering explicit; treat "outer tier first" as the target, and the A/B parity gate (Step 2)
   as the thing that proves no existing win regresses during the change.

---

## 1. Verdict

**Recommended: Factored-Enumerative (adapted), with the VPlan "plan-as-data seam" idea applied
narrowly.** Extract a shared `matchBlockLoop` scaffold matcher and route the existing
lifter/tables through a `classifyBody` → `BODY_LIFTER` dispatch — unifying the inner-loop
recognizers (`tryVectorize`, `tryReduceVectorize`, `tryMapReduceVectorize`, `tryByteScan`)
behind one scaffold while leaving the structurally-distinct outer recognizers
(`tryDivergentEscapeVectorize`, `tryPerPixelColor`, `tryRampMap`, `tryBlurMultiPixel`,
`tryChannelReduce`, `tryMemCopyFill`) as a fast-path tier. Then add new `BODY_LIFTER` entries
(`stencil-offset`, `outer-strip`, `divergent-mask`) as flagged increments.

The sharpest sentence: **jz has an enumeration problem, not a coverage-model problem — each gap
cluster needs one new ~100-LOC *primitive*, not a new ~400-LOC *recognizer* — but only once
recognition and emission are separated at the body level.**

Rejected: **SPMD-Total** (the escape-time masking it proposes already exists in
`tryDivergentEscapeVectorize`; a universal-predication path adds 600–900 LOC to a file the repo
already flags as too large, with no recognizer-count reduction). **Hybrid-Layered's** universal
REPLICATE fallback is rejected — its legality gate is unimplementable at WAT level (no purity
annotations on `call` nodes) and it introduces intra-macro-iteration alias miscompiles. **VPlan**
is *adapted not adopted*: its recipe model fits `map`/`reduce` but **cannot** express
`tryMapReduceVectorize` (scalar-order accumulation via `extract_lane`, not a horizontal fold —
collapsing it would break bit-exactness) or `tryByteScan` (a different loop shape).

---

## 2. The principle: enumerative vs structural coverage

**Current design is enumerative:** each recognizer fuses the *structural predicate* (does this
loop have this shape?) with the *emission template* (produce exactly this WAT). A new body shape
costs a new 300–500 LOC recognizer that re-implements the same scaffold check, lane-type
inference, preamble skip, and scalar-tail construction. The duplicated ~15-line prologue is the
symptom; **recognition and emission being fused** is the cause.

**Structural/total coverage** (ISPC, FlexAttention, Halide) lowers the "slot" (loop body /
score_mod / schedule) by *one mechanical rule* regardless of content, so coverage scales with
expressible content, not recognizer count. Guarantee: *no loop is silently dropped.*

**What "total" cannot mean for jz — the WASM SIMD-128 ceilings:**
1. **No gather/scatter.** Non-affine `A[index[i]]` must scalarize; 4× scalar replication buys
   nothing and often loses → the right move is to *recognize and route to scalar*.
2. **No masked store.** Each conditional write emulates via `extract_lane + if`, 4–6 ops/lane —
   for write-divergent kernels this exceeds the SIMD arithmetic win.
3. **Fixed 128-bit width.** Gang size fixed (i32x4=4, f64x2=2, i8x16=16); no scalable escape.
4. **No predicate register.** Conditional execution is always `compare → bitselect`, spending
   SIMD ops on "skipped" lanes.

**Achievable target: predictable coverage with *reported* misses, not 100% lowering.** Every
plausibly-SIMD loop either gets lowered or emits a `failReason`. Fast-path recognizers survive
where hand-tuned emission beats mechanical lowering (the bit-exact `map-reduce` accumulation; the
`any_true` escape fast-path). The general path takes the long tail. **The general path must be at
least as conservative on legality as the fast-path, and never emit code unverifiable as
equivalent to the scalar loop.**

---

## 3. Gap → primitive → examples

| Primitive | Perf-map rows retired | Key WASM-SIMD ops | Bit-exact risk | Effort |
|---|---|---|---|---|
| **Stencil-offset load** — `v128.load` w/ static `memarg.offset` for `a[i±1]`, `a[i±w]`; pre-decrement base for negative offsets (offset is unsigned u32) | waves (1.34→~2.5×), schrodinger (1.13→~2×), diffusion interior (1.73→~3×), slime box-blur (1.45→~2×) | `v128.load offset=N`, `i32.sub` base pre-dec, existing `f64x2.add/sub/mul` | **Reassoc-ulp** (cross-lane add reorder); gate at `optimize≥2` like float reductions. Integer stencil value-exact. | **M** — `matchStencilDelta` (~40) + `liftStencil` (~80) with left-boundary skip (start SIMD at i=LANES) |
| **Active-mask divergent loop** — per-lane `i32x4` counters, `bitselect` freeze, `all_true` exit; extends the escape model to single-level variable-trip loops the current recognizer rejects | julia (1.45→~2×), burningship (1.23→~1.6×), raymarcher (1.07→~1.5×), newton (1.07→~1.4×), mandelbrot `any_true`-waste residual | `i32x4.splat`, `v128.and/andnot/bitselect`, `i32x4.all_true`, `f64x2` arith | **None** (frozen lanes frozen, not discarded) **iff** trapping ops in speculatively-eval'd branches force scalarization | **L** — `liftDivergentMask` (~300); trapping-op gate is the crux |
| **Outer-strip-mine** — 2-wide f64x2 strip of an independent outer loop; inner reduction runs per-lane; inner data `splat`-broadcast | metaballs (0.81→~1.5×), lbm (1.63→~2.5×), voronoi (1.38→~2×, argmin caps it) | `f64x2.splat/add/mul/min`, `extract_lane 0/1`, `replace_lane` | **Low** (per-lane scalar order); f64 min value-exact | **L** — `matchOuterStrip` (~80) + `liftOuterStrip` (~120) + **new** `cloneNodeSubst` (~40) + voronoi i32x4 argmin tracker (~60) |
| **`atan2` 2-wide mirror** — new `PPC_CALL2` entry; quadrant select via `bitselect` on sign bits | domain-color (1.67→~2.5×) | f64x2 poly + `bitselect`, like existing sin2/cos2 | **None** (same poly, per-lane) | **S** — ~80, follows sin2/cos2 template |
| **`$fbm` inlining pre-pass + sin2/cos2 in straight-line bodies** | plasma (1.60→~2.5×) | existing `$math.sin2`, WAT call expansion | **None** | **M** — ~150 inline pre-pass (gate callee: loop-free, non-recursive, side-effect-free) |
| **Fixed-trip RK4 trig in per-pixel loops** — extend `tryPerPixelColor` to fixed-count inner loops | pendulum (1.85→~3×) | existing `$math.sin2/cos2`, f64x2 | **None** | **L** — ~200 |
| **Cheaper `Math.log` + 2-wide log mirror** *(see §0.1, §0.2 corrections)* — host-import fast path and/or smaller poly; vector mirror under a non-`log2` name | lyapunov (0.81→~2.5×), bifurcation (0.93→~1.5×) | host `env` import (non-deterministic) **or** f64x2 poly; `bitselect` for bifurcation `v>0` mask | **Divergent** (host libc) — relax those tests to ULP tolerance; poly path deterministic | **S** (inlining change) + **M** (vector mirror + ULP tests) |

**Genuinely un-vectorizable (close as no-op):** watercolor (Jacobi loop-carried `pr[c-1]` +
bilinear-gather advect), lorenz (serial RK4 trajectory), ulam (serial spiral state machine),
buddhabrot (`Math.random` PRNG + divergent escape), percolation (union-find pointer-chase), boids
(O(N²) scatter + divergent branch), sand/erosion/marble (`Math.random` per-particle or
non-integer bilinear gather — no WASM gather). These are algorithmically serial; `lorenz`/`ulam`
losing to V8 want better **scalar** i32 codegen, not SIMD.

---

## 4. Architecture comparison

| Candidate | Score | Decisive trade-off |
|---|---|---|
| **Factored-Enumerative** (adapt) | 4/5 | Survivors: `matchBlockLoop` extraction, `matchExitBrIf` widening, `failReason`. Risk: dispatch-order regression on outer-pixel loops → must keep outer tier first; gate with A/B parity. |
| **SPMD-Total** (reject) | 3/5 | Its escape-time masking already exists; +600–900 LOC, no recognizer-count win; `liftExprV` is a stateful emitter, not a predicate — classify/emit split needs costly ctx cloning. |
| **VPlan-Recipe** (adapt) | 4/5 | Plan-as-seam is the keeper. But `map-reduce` (scalar-order accum) and `scan` (different shape) don't fit the recipe model — collapsing them breaks bit-exactness. Apply recipes only to `map`+`reduce`. |
| **Hybrid-Layered** (reject) | 3/5 | Universal REPLICATE has no WAT-level legality gate (no `call` purity info) and an unsolvable intra-macro-iteration alias problem. |

---

## 5. Recommended architecture

**IR stage:** stays at WAT-as-array level. No AST hook in this roadmap (real opportunity, but
touching `emit` is a larger blast radius — do it after the WAT-level architecture is clean).

**Seam = two plain-data objects** (neither mutates IR):
- `LoopDescriptor` from `matchBlockLoop`: `{blockLabel, loopLabel, loopNode, incVar, incStep,
  bound, le, preamble, body}`.
- `BodyClass` from `classifyBody`: `{kind, laneType, localKind, reductions, stencilDeltas,
  failReason}`.

**Reused unchanged (~2,800 LOC):** `liftExprV`, `liftStmt`, `liftCanon`, all tables
(`LANE_PURE`, `REDUCE_OPS`, `REDUCE_CANON`, `LANE_COMPARE`, `LANE_INFO`, `LOAD_OPS`, `STORE_OPS`,
`WIDEN_LOADS`, `MINMAX_WIDEN`), `matchLaneAddr`, `matchLaneOffset`, `_offsetLocalStride`,
`hasSideEffect`, `hasGlobalSet`, `firstAccess`, `collectWrites`, `matchCanonSelect/Block`,
`matchIntMinMaxReduce`, `matchF64DotSeq`, `vectorizeStraightLineF64DotPairsIn`, the bound-align +
label idiom, the v128-local dedup Map, `cloneNode`, `exprEq`, `normTee`.

**Outer-recognizer fast-path tier (runs first, unchanged):** `tryDivergentEscapeVectorize`,
`tryMemCopyFill`, `tryBlurMultiPixel`, `tryChannelReduce`, `tryPerPixelColor`, `tryRampMap`.
Extract their shared ~40-line outer-pixel prologue to `matchOuterPixelLoop()` (cleanup only).

**Inner-loop plan dispatch (after outer tier returns null):**
```
const desc = matchBlockLoop(blockNode)
if (!desc) { tryStrengthReduceIV(...); return }
const body = classifyBody(desc, fnLocals)
if (!body.kind) { populateFailReason(blockNode, body.failReason); tryStrengthReduceIV(...); return }
const r = BODY_LIFTER[body.kind](desc, body, fnLocals, freshIdRef, cfg)
if (r) { parent[idx] = r.wrapper; newLocalDecls.push(...r.newLocalDecls) }
```
```js
const BODY_LIFTER = {
  map:              liftMap,           // was tryVectorize body
  reduce:           liftReduce,        // was tryReduceVectorize body
  'map-reduce':     liftMapReduce,     // bespoke lifter PRESERVED (bit-exact scalar-order)
  scan:             liftScan,          // was tryByteScan body
  'stencil-offset': liftStencil,       // NEW
  'outer-strip':    liftOuterStrip,    // NEW
  'divergent-mask': liftDivergentMask, // NEW (supplements tryDivergentEscapeVectorize)
}
```

**`classifyBody` priority chain:** (1) no `laneType` after load/store scan → null; (2) nested
inner-break pixel loop → null (outer tier owns it); (3) stencil delta ±1..±W on stride-1 base,
not loop-carried → `stencil-offset`; (4) outer-independent nest w/ inner read-only reduction →
`outer-strip`; (5) single acc, len 1–2, op in `REDUCE_OPS`/`REDUCE_CANON` → `reduce`; (6) all
`local.set f64`, one `acc+EXPR`, rest lane-only → `map-reduce`; (7) pure element-wise map →
`map`; (8) single-compare early-exit, no body → `scan`; (9) else null + `failReason`.

**`matchBlockLoop` generalizes:** `matchIncAny` (any `i32.const N` step; SIMD bound becomes
`bound & ~(LANES*step - 1)`); `matchExitBrIf` widened to `le_s` (carry an `le` flag — bound setup
uses `bound + (le?1:0)` *before* masking; **this is the OOB risk — plumb `le` through every
lifter**) and reversed `gt_s`; the `$__li`-only preamble safety check baked in.

**`liftStencil` boundary:** start SIMD prefix at `i = incStep*LANES` (scalar tail covers the
first lane-group, avoiding `a[-1]`); hoist a loop-invariant `base - stride` into the preamble so
all loads use **non-negative** `memarg.offset` (0 for `a[i-1]`, stride for `a[i]`, 2·stride for
`a[i+1]`).

**`liftOuterStrip` needs `cloneNodeSubst(node, {incVar: expr})`** (~40 LOC, doesn't exist) to
emit the inner body per outer lane. Alias safety: inner stores must address only inner-local or
outer-IV-derived **non-overlapping** positions (lane0→`px[j]`, lane1→`px[j+1]` non-overlapping
iff store stride == element size — checked via `matchLaneAddr`).

**Never-miscompile invariant preserved:** scalar tail is always the unmodified `blockNode`;
neither `classifyBody` nor any `liftX` mutates it; `parent[idx]` is reassigned only on a clean
lift (no `ctx.fail`). Structurally identical to today's guarantee.

---

## 6. Migration roadmap (each step independently shippable)

**Step 0 — Visibility (✅ DONE, zero behavior change).** Added `liftFail(ctx, reason)` (first-write
-wins, names the deepest blocking op) and routed all 15 `ctx.fail` sites in `liftExprV`/`liftStmt`
through it. Added `--why-not-simd` CLI flag → `opts.whyNotSimd` → rides the resolved optimize cfg →
`vectorizeLaneLocal(…, whyNot)`; a canonical loop-shaped block that no SIMD pass took emits a
`simd-why-not` warning via the existing `warn()`/`opts.warnings` channel (already printed by the
CLI), reported *before* the scalar strength-reduce fallback so it isn't masked. `_whyNotActive` is
armed only for the duration of the flagged call (cleared on exit — never read by codegen).
*Verified:* names the op (`i32.rem_s: no lane-pure SIMD mapping for i32`); silent without the flag;
suite green; **ratchet +0** (the `failReason` writes are inert; warnings gated). Files: vectorize.js,
src/optimize/index.js, index.js, cli.js. *(The +1 test seen during verification was the user's
concurrent edit to the untracked `test/grid-current.js`, not this change.)*

**Step 1 — `matchBlockLoop` extraction (✅ DONE, zero behavior change).** Added `matchBlockLoop`
(scaffold facts only — no policy; `allowPreamble` opt for tryVectorize's `$__li` preamble; bound
returned raw so tryStrengthReduceIV stays bound-shape-agnostic) and substituted the duplicated
prologue in `tryVectorize`/`tryReduceVectorize`/`tryMapReduceVectorize`/`tryByteScan`/
`tryStrengthReduceIV`. Also extracted `matchOuterPixelLoop` (the outer per-pixel scaffold shared by
`tryDivergentEscapeVectorize` + `tryPerPixelColor`). Net **−67 lines** (105+/172−), 7 call sites.
*Verified:* opt2 + opt3 + self-host all identical (2352 pass / 1 skip); **codegen ratchet +0 ops**
(int/float/mixed) — emitted WASM byte-identical.
  - *Deferred to a later step (not needed for the pure extraction):* `matchIncAny` (strided IV)
    and `matchExitBrIf` `le_s`-widening — both are *new coverage*, so they belong with Step 3+,
    not the zero-behavior-change refactor. **Risk when added: `le` off-by-one** → plumb `le` into
    every bound setup; test `i<=bound` with exact-multiple N.

**Step 2 — compute-once dispatch / descriptor-threading (✅ DONE, zero behavior change).**
`matchBlockLoop` is now called **exactly once** per block in the walk; the six inner-scaffold
lifters (`tryMemCopyFill`, `tryVectorize`, `tryReduceVectorize`, `tryMapReduceVectorize`,
`tryByteScan`, `tryStrengthReduceIV`) **consume the descriptor `bl`** instead of each re-matching.
The outer-pixel/special recognizers (`tryDivergentEscapeVectorize`, `tryRampMap`,
`tryBlurMultiPixel`, `tryChannelReduce`, `tryPerPixelColor`) keep their own matching on the raw node.
`matchBlockLoop` returns `blockNode` (the scalar-tail source).
  - **Order preserved exactly** (first-match-wins is load-bearing) — *not* reordered into tiers (the
    #1 regression risk). Recognizers stay bespoke: the research rated a unified
    `classifyBody`-returns-kind / recipe model "adapt, not adopt" (`map-reduce` scalar-order accum
    and `scan` shape don't fit one model). Realized win: single recognition call + an explicit
    descriptor seam that Step 3 extends by adding **one lifter** to the chain.
  - **Preamble policy** preserved per-lifter: matched once with `allowPreamble:true`; the five
    no-preamble lifters add `if (bl.preamble.length) return null` (provably equivalent to the old
    `allowPreamble:false`); `tryVectorize` keeps its `$__li` preamble.
  - *Verified:* **ratchet +0** (byte-identical) after each sub-step; suite + opt3 (2353 pass) +
    self-host (11/11); `--why-not-simd` still names the op through the new dispatch. Net across
    Steps 0–2: **−44 lines** in vectorize.js.

  *The fuller `classifyBody`-returns-kind / `BODY_LIFTER[kind]` form (Section 5) is deferred — its
  payoff is realized when adding primitives (Steps 3+), and the bespoke lifters resist a clean
  classify/emit split today. The chain already gives "add a primitive = add one `bl`-consuming
  lifter."*

### Step 3 investigation findings (before implementation)

Inspected how jz lowers a 3-point stencil (`b[i] = a[i-1]+a[i]+a[i+1]`) to WAT:
- `a[i-1]` → `(i32.add base (i32.shl (i32.sub i 1) 3))` — IV-minus-constant **inside** the shift.
- `a[i]`   → `(i32.add base (i32.shl i 3))` — the clean form `matchLaneAddr` already accepts.
- `a[i+1]` → `(f64.load offset=8 (local.get $teedAddr))` — jz already folds the +1 neighbour onto
  `a[i]`'s address tee via a wasm **memarg `offset`**.

**The lift is bit-exact by construction.** A scalar `f64.load` at address `base+(i+δ)·8` becomes
`v128.load` at the *same* address; for f64x2 lanes (i, i+1) that load naturally covers the δ-shifted
pair `(a[i+δ], a[i+δ+1])` — exactly the bytes scalar iterations i and i+1 read. No extra memory is
touched, so **no new OOB and no boundary special-casing** is needed beyond the existing scalar
tail (the `i=LANES` head-skip in the original plan is unnecessary — the addresses already encode δ).
The only real work is **address recognition**: extend `matchLaneAddr` to accept `(i±δ)<<K` and the
`offset=N` tee-reuse form, classifying them as (offset) lane data rather than bailing.

**The genuine hazard is aliasing, not boundaries.** Two cases:
1. *In-place stencil* (`a[i] = f(a[i-1], …)`) — reading the **written** array at a nonzero offset is
   loop-carried; vectorized reads see old values where scalar sees just-written ones → **miscompile**.
   The scan MUST bail when the written base also appears as a nonzero-δ load. (Offset-0 read of the
   written array, e.g. `b[i] = b[i] + …`, is safe.)
2. *Swapped double-buffers* (the real `waves`/likely `schrodinger`): `a`/`b` are globals swapped each
   frame (`tmp=a;a=b;b=tmp`), so the compiler can't statically prove `a ≠ b` — the current
   distinct-base-⇒-no-alias assumption is unsound here. `waves` needs alias disproof (or a
   conservative bail) before it's safe (initial concern — corrected just below).

**Recommended first target:** a stencil over **distinct, non-swapped** arrays with no wrap
conditional (a clean `dst[i] = f(src[i±δ])`, `dst≠src`) — NOT `diffusion` (toroidal-wrap
conditional index is a separate blocker). Implement gated behind `cfg.experimentalStencil`, with
the in-place-alias bail as a hard correctness gate, and bit-exact `test/simd.js` cases (incl.
odd-width tail) before enabling by default.

### Refined plan — `waves` needs NO new alias analysis (corrects the initial concern above)

Verified against the codebase:
- `--why-not-simd` on `waves` reports the fallback reason for `$frame`'s loops → they **are
  recognized** by `matchBlockLoop` but bail in the **address scan** (`matchLaneAddr` rejects the
  shapes). So the work is bounded to the matcher + lift; recognition already works.
- The existing vectorizer **already assumes distinct base subtrees don't alias** — a 2-array map
  `b[i]=a[i]*2` over two module globals vectorizes today (2 f64x2). `waves` reads global `$a`,
  writes global `$b` (distinct subtrees); the buffer **swap is outside the inner loop**, so the
  base subtrees in the loop are fixed `(global.get $a)` / `(global.get $b)`. Under the same model
  this is safe — **no runtime alias guard / loop versioning / swap-group analysis needed.** (jz
  does compile `.subarray`; buffer-sharing views are the one unsound case, but that's the *same*
  pre-existing assumption maps already rely on — not a new regression. Note it; don't block on it.)

**Exact `$loop2` address shapes (IV = `$x`; `c = rc + x` is a per-iteration derived IV; `rn`,`rs`,
`rc` loop-invariant):**
| source | WAT offset | form needed |
|---|---|---|
| `a[rn+x]` | `(i32.shl (i32.add rn x) 3)` | `(INV + x) << K` |
| `a[rs+x]` | `(i32.shl (i32.add rs x) 3)` | `(INV + x) << K` |
| `a[c-1]`  | `(i32.shl (i32.sub c 1) 3)` | `(derivedIV − δ) << K` |
| `a[c]`    | `(i32.shl c 3)` tee `$__pe0`/`$__ab0` | `derivedIV << K` |
| `a[c+1]`  | `(f64.load offset=8 $__ab0)` | tee + memarg `offset` |
| `b[c]` (store + offset-0 read) | `base_b + $__pe0` | `derivedIV << K`, distinct base |

**Bounded work (no alias subsystem):**
1. **Affine-IV derivation:** recognize a body-local `c = (i32.add INV (local.get x))` (INV
   loop-invariant) as stride-1 in the IV; treat `(local.get c)` like the IV in `matchLaneOffset`.
   Also accept the inline `(i32.add INV x)` sub-expression form (a[rn+x]).
2. **Offset matching:** extend `matchLaneOffset`/`matchLaneAddr` to accept `(IV±δ)<<K`,
   `(derivedIV±δ)<<K`, and the existing tee + memarg `offset=N` reuse (already emitted by jz).
3. **Lift:** unchanged — each `f64.load` at addr A → `v128.load` at A (address-preserving ⇒
   bit-exact, no boundary special-casing; scalar tail handles the remainder). Store likewise.
4. **In-place bail (hard gate):** if the written base subtree also appears as a base of a
   **nonzero-offset** load → loop-carried → return null. (Offset-0 read of the written array, e.g.
   `b[c]` here, is safe.)
5. **Bit-exact gate:** stencils that SUM neighbours reorder f64 adds across lanes → ulp; gate at
   `optimize≥2` like float reductions. Integer stencils are value-exact.

Gate behind `cfg.experimentalStencil` (default off → ratchet stays +0). Verify: bit-exact
`test/simd.js` cases (3-/5-point, odd-width tail, in-place-bail negative) + the real `waves`
example vs scalar. Feature-sized but mechanical now that recognition + (non-)aliasing are settled —
best executed as a focused pass on a clear repo (commits are currently blocked by other active
agent sessions).

**Step 3 — Stencil-offset (✅ DONE, NEW coverage, gated `experimentalStencil`).** Added
`tryStencil` (a `bl`-consuming lifter in the dispatch) handling neighbour loads — `b[i] =
f(a[i-1], a[i], a[i+1])` and the 2-D 5-point form `b[c] = f(a[c±1], a[rn+x], …)` with a derived IV
`c = rc + x`. Approach as planned: address-preserving lift (each `f64.load` at A → `v128.load` at
A; the `a[i+1]` neighbour → `v128.load offset=8`), so **bit-exact by construction**; type-based
localKind (i32 = index/address kept scalar, f64 = lane data); `ivCoeff` affine-in-IV check
(coeff-1 incl. derived IVs); pure-invariant bound (`w-1`); overshoot-safe SIMD bound `bound-(lanes
-1)` (handles the `x=1` start); in-place-alias hard bail (written base read at a different element).
A small additive `liftExprV` fix lifts the memarg `offset=N` load. **No alias analysis needed** —
confirmed: the buffer swap is outside the loop, in-loop bases stay distinct (the same assumption the
plain map path relies on). *Verified:* waves vectorizes 2→16 f64x2 and is **bit-exact end-to-end**
(1200 px, 25 frames); synthetic 3-point (odd-width tail), 5-point derived-IV, and in-place-bail tests
in test/simd.js; waves regression in test/examples.js; **default builds byte-identical (ratchet +0,
flag off)**. CLI `--experimental-stencil` / `opts.experimentalStencil`; off by default until proven
across the rest of the corpus.

  *Corpus status (measured):* `waves` ✓ (vectorizes + bit-exact). `ivCoeff` also handles inline row
  bases `idx = y*w + x` (invariant×invariant ⇒ coeff 0; tested bit-exact). The other stencil rows
  are blocked on **recognition**, not the lift: `schrodinger`/`slime`/`diffusion` aren't even
  candidates — `--why-not-simd` is silent on their hot loops, so `matchBlockLoop` (and
  `matchOuterPixelLoop`) reject them before any stencil scan. Extending stencil to them is a
  recognition task (their loop nesting/shape), tracked as the next stencil increment — NOT an
  `ivCoeff`/lift gap. `diffusion` additionally needs the toroidal-wrap conditional index handled.

  *Superseded original plan (kept for reference):* `matchStencilDelta` + `liftStencil` +
`classifyBody` branch, behind `cfg.experimentalStencil`. *Unlocks:* waves, schrodinger, diffusion,
slime. *Guard:* reassoc-ulp, gate `optimize≥2`; SIMD starts at i=LANES. *Verify:* `test/simd.js`
per-element vs scalar; boundary cases `bound ∈ {LANES-1, LANES, 2·LANES}`; ratchet waves ≥1.5×.

**Step 4 — `Math.log` cost + vector log mirror (revised, see §0).** *Not* "native f64.log" (no
such instruction). Instead: (a) optionally lower `Math.log` to a **host import** under `host:'js'`
(faster/accurate, non-deterministic — relax those tests to ≤2 ULP; keep poly for WASI), and/or
(b) replace the 30-op Cephes inline with a cheaper poly + a **2-wide vector mirror under a
non-`log2` name** (log2 = log base 2 already). Add the `PPC_CALL2` entry. *Unlocks:* lyapunov,
bifurcation (incl. `v>0` mask via `bitselect`). *Verify:* ULP-tolerance checker; bifurcation
zero-pixels stay 0.

**Step 5 — `atan2` 2-wide mirror (1–2 d).** New `PPC_CALL2` poly pair (~80), quadrant select via
`bitselect` on sign bits. *Unlocks:* domain-color. *Verify:* pixel-identical to scalar across
odd/even widths; ratchet ≥2.2×.

**Step 6 — `$fbm` inlining pre-pass (3–4 d).** Inline loop-free/non-recursive/side-effect-free
leaf WAT fns before the f64x2 pass; existing sin2/cos2 then cover the exposed `Math.sin`.
*Unlocks:* plasma. *Verify:* plasma pixel-identical; pre-pass gated on `hasSideEffect` + callee
loop scan.

**Step 7 — Outer-strip-mine (5–7 d, flagged).** `cloneNodeSubst` + `matchOuterStrip` +
`liftOuterStrip` + voronoi i32x4 argmin tracker, behind `cfg.experimentalOuterStrip`. *Unlocks:*
metaballs, lbm, voronoi. *Guard:* per-lane scalar order; f64 reassoc gate `optimize≥2`; alias
check (no store depends on both inner+outer IV; outer-IV writes non-overlapping). *Verify:*
metaballs pixel-identical (integer); lbm ULP; ratchet metaballs >1.0×.

**Step 8 — Active-mask divergent loop (5–7 d, flagged).** `liftDivergentMask` (~300):
per-lane i32x4 counters, `bitselect` freeze, `all_true` exit, conditional-store suppression via
`extract_lane + if`. Supplements `tryDivergentEscapeVectorize` for shapes it rejects. *Guard
(critical):* any trapping op (`i32.div_s/u`, `i32.rem_s/u`, non-sat trunc) in a speculatively
-eval'd branch **must** force scalarization, not `bitselect` — WASM traps where x86 SIMD doesn't.
Use the `LANE_PURE` whitelist as the gate (any non-whitelisted op in a would-be-`bitselect`
branch → scalarize). *Verify:* N=5/LANES=4 produces exactly 5 stores not 8; ratchet julia >1.6×.

---

## 7. Risks & non-goals

**Non-goals:** Don't chase serial-recurrence rows (watercolor/lorenz/ulam/buddhabrot/
percolation/boids/sand) — REPLICATE-unrolling pessimizes already-losing benches. Don't relax
bit-exactness by default — every divergence must be a documented, flag/opt-gated exception tested
with the relaxed criterion. Don't build SPMD-Total or a VF sweep (one lane width per type — a
sweep is pure latency). Don't attempt gather/scatter — scalarized gather loses on any warm cache;
route indirect-indexed loops to scalar.

**Top risks:** (1) dispatch-order regression on outer-pixel loops → outer tier first + Step 2 A/B
gate; (2) `le_s` bound off-by-one → plumb `le`, test exact-multiple N; (3) stencil left-boundary
→ start at i=LANES, test small N; (4) outer-strip inner-body alias → `matchOuterStrip` address
check; (5) divergent-mask trapping ops → `LANE_PURE` scalarization gate; (6) **double-run
idempotency** — after wrapping, the post-watr walk revisits the wrapper; the scalar tail inside is
the original loop and could re-vectorize. Mitigate by renaming the tail loop label to a `$__tail_*`
prefix that `matchBlockLoop` bails on (or confirm the v128 non-`$__li` preamble already fails the
preamble safety check). **Confirm idempotency before shipping Step 2.**
