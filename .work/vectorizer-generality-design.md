# Vectorizer generality — assessment + design (2026-08-13)

Assessment + design only, no source change. Question answered: can
`src/optimize/vectorize.js`'s 19 recognizers be generalized (keep) or are
they dead weight (delete)? Grounded in the actual code (7247 lines) and the
census (`.work/feature-reach-census.md` §9). Proof primitives referenced
read-only: `src/static.js` (`intExprRange`, `forCounterRange`,
`linearIndexOf`), `src/compile/narrow.js:1483` (`arrayReadProvenInBounds`).

## 0. Verdict up front

**19 → 12 recognizers**, zero corpus-coverage loss, by merging
precondition-superset groups that already share matching infrastructure —
not by deleting working code. One recognizer (`tryByteScan`, 0/130 reach,
confirmed real via a working synthetic repro) deletes outright. Shape-
recognizer vectorization is **valid for whole-idiom fusion, invalid as the
sole strategy** — see §3. Endgame: promote the 3 general-purpose classes
(MAP/REDUCTION/STENCIL) off syntactic WAT-pattern matching onto the AST-
level affine proofs `static.js` already has for a different consumer, and
keep the idiom fusers (outer-strip, channel, butterfly) as a thin top
layer where they structurally beat LLVM. Do not attempt to out-build
LLVM's dependence-driven vectorizer wholesale (§3, rejected).

## 1. Taxonomy

8 transform classes hold all 19 recognizers. Class = the general SIMD
idiom; "shape-specific precondition" = what today's matcher demands
beyond the transform's actual semantic requirement (syntactic WAT-shape
matching in place of a semantic proof).

| # | recognizer | reach | class | what makes it shape-specific TODAY |
|---|---|---|---|---|
| 1 | `tryVectorize` | 54 | **MAP** (elementwise, contiguous stride) | address must match `matchLaneAddr`'s literal `(add base (shl i K))` WAT shape post-lowering, not an AST-level affine proof; lane type pinned by which op the scan hits, not a declared type |
| 2 | `tryMemCopyFill` | 28 | **MAP** (degenerate: body = 1 copy/const store) | exact 1- or 2-statement body (`loopNode.length===6\|\|7`, line 3921); a general MAP recognizer would pick `memory.copy`/`.fill` as a *codegen tier* of the same transform, not a separately gated function |
| 3 | `tryRampMap` | 6 | **MAP** (IV-as-data / widened-narrow variant) | lane type can't be derived from a load (no source load, or narrow-widened) — a MAP-specific special case of "how is lane type inferred", not a different transform |
| 4 | `tryToneMap` | 4 | **MAP** (mixed i32/f64 lane-width island) | `tryVectorize`'s single-lane-type architecture can't express an f64 intermediate inside an i32 store; needs `hasConvert` (line 6567) as its own gate |
| 5 | `tryReduceVectorize` | 4 | **REDUCTION** (trip-count fold, reassociating) | body must literally be `S = OP(S, EXPR(arr[i]))`, one statement (2381-2467) |
| 6 | `tryMapReduceVectorize` | 2 | **REDUCTION** (trip-count fold, bit-exact/non-reassociating) | same transform as #5, differs ONLY in fold order (scalar-order-preserving f64x2 pairing vs horizontal-reduce) — a **policy knob**, not a distinct transform |
| 7 | `tryStencil` | 8 | **STENCIL** (halo/neighbour-load map) | affine index coefficient on IV must be exactly 1 (line ~2010); in-place aliasing checked by literal subtree distinctness, not a real alias proof |
| 8 | `tryDivergentEscapeVectorize` | 5 | **OUTER-STRIP**, masked-divergent | outer pixel loop + exactly 1 inner break-loop, matched via `matchOuterPixelLoop` (shared) |
| 9 | `tryPerPixelColor` | 3 | **OUTER-STRIP**, straight-line | dual of #8 with `innerIdxs.length===0` required (line 5683) |
| 10 | `tryOuterStrip` | **1** | **OUTER-STRIP**, invariant-data reduction | dual of #8/#9: exactly 1 inner loop, body is an accumulate over pixel-invariant data |
| 11 | `tryIteratedReduce` | **1** | **OUTER-STRIP**, iterated recurrence | generalizes #10 to loop-carried (non-additive) recurrences + a transcendental gate (`sawHeavy`, line 6275) |
| 12 | `tryConvColumn` | **1** | **OUTER-STRIP**, int8 unrolled MAC | same outer scaffold, integer lane width instead of f64x2, body pre-unrolled (no inner loop) |
| 13 | `tryBlurMultiPixel` | **1** | **CHANNEL-REDUCE**, strip-mined (4 px/step) | requires a clamp-free interior (line 4724) — the *entire* function exists as the fast tier of #14 |
| 14 | `tryChannelReduce` | **1** (same specimen as #13) | **CHANNEL-REDUCE**, 1 px/step | own doc calls it "the 1-pixel-per-step fallback of tryBlurMultiPixel" (line 4870) — already conceptually one recognizer split across two functions |
| 15 | `hoistReductionInvariantsIn` | **1** | **SLP** (LICM-for-packing, enabling) | hardwired to `DOT_UNROLL=4` f64-dot shape (`matchF64DotSeq`) |
| 16 | `vectorizeStraightLineF64DotPairsIn` | **0** | **SLP** (horizontal pack: adjacent dot reductions) | same `matchF64DotSeq` shape as #15, packs 2 adjacent instances |
| 17 | `slpStorePairsIn` | 3 | **SLP** (horizontal pack: adjacent stores) | same general idea as #16 (pack 2 adjacent isomorphic op-trees), narrowed to plain element stores only |
| 18 | `tryButterfly` | 2 | **BUTTERFLY** (dual-IV strided rotate, fixed topology) | 17-statement **positional** unification (lines 6885-6954) — the most rigid matcher in the file, near-zero shared infra |
| 19 | `tryByteScan` | **0** | **BYTE-SCAN** (early-exit search — not map/reduce) | own transform class; no other recognizer does early-exit masked search |

Helpers correctly excluded from the 19 (confirmed against the dispatch
site, `vectorizeLaneLocal`, lines 7039-7247): `tryLiftLaneIf` (lift-time
helper used transitively by MAP/REDUCTION/RAMP), `tryStrengthReduceIV`
(deferred non-SIMD fallback for loops the chain rejects, dispatched
separately at lines 7230-7234).

**Same transform, different specialization** — the direct answer to
"which recognizers are the SAME general transform": #1-4 (MAP), #5-6
(REDUCTION), #8-12 (OUTER-STRIP), #13-14 (CHANNEL-REDUCE), #15-17 (SLP).
Only STENCIL (#7) and BUTTERFLY (#18) and BYTE-SCAN (#19) stand alone.

## 2. Generalization path per class

### MAP (#1-4, 92/130 reach) — biggest class, NOT proposed for internal merge

Already lane-width-general (`LANE_INFO` covers i8/i16/i32/i64/f32/f64,
lines 561-568) and already the highest-reach class. The 4 functions earn
their keep individually (54/28/6/4, all multi-specimen) — merging them
mechanically buys nothing. What they lack is **semantic** generality: the
address proof (`matchLaneAddr`) runs on lowered WAT text, re-deriving
"affine in IV, loop-invariant base" from op shapes instead of consulting
the AST-level proof `static.js`/`narrow.js` already build for a different
consumer (bounds narrowing). This is the lever for §3's endgame, not a
recognizer-count reduction — see step 2 in §4.

### REDUCTION (#5-6) → 1 general recognizer

**Unify.** Precondition: a single scalar accumulator, `S = OP(S,
EXPR(arr[i]))`, `OP` associative-commutative (existing `REDUCE_OPS`
table, line 712). Codegen: one shared lift, branching only on a
`bitExact` flag that picks fold order — scalar-order-preserving f64x2
pairing (today's `tryMapReduceVectorize`) when `bitExact`, tree-reduce +
horizontal-sum (today's `tryReduceVectorize`) otherwise. Subsumes both;
corpus coverage (`bench/{dotprod,matmul,poly}`, `examples/{buddhabrot,
metaballs}`, `bench/nbody`) unchanged — same preconditions, same gate
order, just one dispatch entry instead of two.

### OUTER-STRIP (#8-12, 5 recognizers, 11 reach) → 2 general recognizers

All 5 already share `matchOuterPixelLoop`, `bumpPixelIV`,
`epilogueIsSafe`, `PPC_CALL2`, `LANE_PURE.f64`/`CMP_LANE` — the outer
scaffold is *already* one shared driver; only the "what happens inside
the outer body" is bespoke per function. Split cleanly on one axis: does
the inner body terminate independently per lane (divergent control flow,
needs masking) or not.

- **General transform A — masked-divergent outer-strip.** Precondition:
  outer pixel loop, ≥1 inner loop(s) with a data-dependent early exit
  (break/escape), OR a loop-carried recurrence needing per-lane
  conditional accumulate. Codegen: f64x2 lockstep, per-lane active mask,
  bitselect-freeze on escape (today's `tryDivergentEscapeVectorize`
  machinery, generalized to accept `tryIteratedReduce`'s multi-inner-loop
  + transcendental-recurrence case — that recognizer's own doc already
  calls itself "generalizes tryOuterStrip to the iterated-map shape").
  Subsumes #8, #11. Reach: `bench/mandelbrot`, `examples/{burningship,
  julia,newton,mandelbrot}`, `examples/lyapunov`.
- **General transform B — straight-line/reduction outer-strip.**
  Precondition: outer pixel loop, body is either straight-line (no inner
  loop) or an inner loop over pixel-INVARIANT data with no escape/break
  (fixed trip count). Codegen: f64x2 (or, for `tryConvColumn`'s int8 MAC
  case, an integer-lane instantiation of the same driver — `i16x8.mul` +
  `i32x4.extend` widening, not a separate function, a separate `LANE_INFO`
  parameter). Subsumes #9, #10, #12. Reach: `examples/{chladni,
  domain-color,plasma}`, `examples/interference`, `bench/conv2d`.

5 recognizers → 2. Coverage preserved by construction: each general
transform's precondition is the union of its subsumed functions'
preconditions (a strict superset), not a narrower re-derivation.

### CHANNEL-REDUCE (#13-14) → 1 general recognizer

**Unify — this is nearly free.** `tryBlurMultiPixel`'s own doc already
states it "bails to tryChannelReduce on any deviation" (line 4698); the
two are already one conceptual recognizer with two codegen tiers keyed
on one boolean (clamp-free interior detected → 4 px/step; clamp present →
1 px/step). Merge into one function: run the clamp-free structural check
first, pick the tier, share `matchChannelReducePixelLoop`/
`matchChannelGroup` (already shared, lines 4191-4234). Both fire only on
`bench/blur` (h/v passes) — the only specimen for either tier, so this
merge needs a dedicated bit-exact re-verification (both tiers), not just
"still fires" (§4 risk list).

### SLP (#15-17) → 2 (1 general pack + 1 generalized LICM)

`vectorizeStraightLineF64DotPairsIn` (pack 2 adjacent dot-reductions) and
`slpStorePairsIn` (pack 2 adjacent element stores) are both instances of
classic bottom-up SLP (Larsen-Amarasinghe): seed on 2 adjacent isomorphic
memory ops, walk operand trees pairwise, pack when both sides match
(`slpPackF64x2`, line 461, already does exactly this walk for the store
case). **Unify into one general basic-block SLP walker** that seeds on
ANY 2 adjacent isomorphic root ops (store OR reduction-store) and packs
recursively — subsumes both, and its broader match surface likely also
fixes `vectorizeStraightLineF64DotPairsIn`'s own honest "unknown
precondition, synthetic repro failed twice" flag (census §9 row 18) as a
side effect, since the narrow standalone function disappears into the
general matcher rather than needing its own bug hunt.

`hoistReductionInvariantsIn` is a **different transform category** (LICM
— reassociating hoist of loop-invariant partial products), not a packer;
keep it distinct but generalize its own precondition beyond the hardwired
`DOT_UNROLL=4` f64-dot shape (currently coupled to the emitter's own
unroll constant, line 199's `matchF64DotSeq`) to any N-wide unrolled
accumulate with ≥1 invariant term. 3 → 2.

### STENCIL, BUTTERFLY — no merge proposed

`tryStencil` (8 reach) is already one well-defined transform; its
shape-specificity (coefficient-1 affine index, literal-subtree aliasing)
is a real, still-open generalization (dependence analysis, §3) but not a
recognizer-count reduction — it's already 1 recognizer.

`tryButterfly` (2 reach, FFT-specific) is the most rigid matcher in the
file (17-statement **positional** unification, line 6885) and genuinely
singular — no sibling recognizer shares its dual-IV strided-rotate shape.
Decomposing it into something more general means building real
dependence + reassociation-safety analysis for arbitrary strided gathers,
which is the SLP/loop-transform investment named in §3's rejected
alternative, not a cheap merge. Leave as-is; it's cheap insurance (2
specimens, self-contained, zero coupling to anything else).

## 3. The strategy question

**Rivals are uniformly LLVM-backed**: `rustc --target wasm32-wasip1`,
`zig cc`/`zig build-exe -target wasm32-wasi` (clang), `tinygo` — all get
loop vectorization from LLVM's `LoopVectorize`/`SLPVectorizer` passes:
general dependence analysis + a cost model, firing on **any** loop
shape that satisfies the proof obligations, independent of surface
syntax. jz's chain instead pattern-matches 19 **specific WAT shapes**
its own lowering happens to emit for 19 **recognized source idioms** —
syntactic, post-lowering, closed-world.

**This is exactly the user's concern, and it is real.** A novel user
loop — semantically vectorizable (affine addressing, no loop-carried
dependence) but not matching any of the 19 hand-coded shapes (a slightly
different operand order, an extra invariant term, a different comparison
direction) — gets **zero** vectorization, not degraded vectorization.
`tryButterfly`'s positional 17-statement matcher is the sharpest example:
one extra statement and the whole recognizer declines, no partial credit.
There is no general fallback for lane-vectorization (only
`tryStrengthReduceIV`, which rewrites addressing, never lanes) — the `??`
chain is "if none of 19 match, do nothing," structurally the opposite of
LLVM's graceful degradation (fails one proof, tries another interleave
factor, etc.).

**Where recognizers are structurally STRONGER than LLVM** — real, not
aspirational:
- `tryDivergentEscapeVectorize`: masked lockstep across per-lane
  independently-terminating escape loops (mandelbrot family). LLVM's
  outer-loop / predicated vectorization exists (VPlan) but is
  experimental and rarely fires without hints; jz's version is unhinted
  and bit-exact by construction (frozen-lane bitselect, not a
  speculative execute-and-mask).
- `tryBlurMultiPixel`/`tryChannelReduce`: struct-of-4-channels-as-lanes
  fusion for a box filter. This needs domain knowledge ("these 4 scalar
  accumulators are one SoA reduction") that a generic SLP pass matches
  unreliably at best.
- `tryButterfly`: bit-exact (non-reassociating) FFT butterfly SIMD.
  LLVM defaults to NOT reassociating floats without `-ffast-math`; even
  with it, LLVM has no domain knowledge of the Cooley-Tukey rotation
  shape to pack without help. jz gets exact SIMD here with zero flags.

**Where recognizers are WEAKER** — the MAP/REDUCTION/STENCIL classes
(92+4+8 = 104/130 reach, most of the corpus) are semantically ordinary
data-parallel loops that a real dependence-driven vectorizer handles for
free, for ANY syntax variant. jz gets them ONLY because 4 people wrote 4
matchers for 4 syntax shapes. Every unmatched variant of the SAME
semantic idiom is a silent miss.

**Rejected alternative 1 — full recognizer consolidation only, no AST-level
work.** Cheap (§4 step 1), safe, but doesn't touch the actual complaint:
still 0 vectorization for any novel MAP-shaped loop that isn't
byte-identical in WAT shape to what `tryVectorize` expects. Solves
recognizer-count bloat, not the strategy question.

**Rejected alternative 2 — throw away the chain, build an LLVM-class
general vectorizer from scratch.** LLVM's vectorizer is years of tuning
(cost models, interleaving heuristics, target-specific lane-width
selection). A homegrown competitor without comparable maturity risks
being *worse* than today — either missing real wins the syntactic
matchers currently catch (idiom fusion LLVM structurally can't reach,
§3 above) or, worse, introducing subtle mis-vectorizations a naive
dependence prover gets wrong. Also forfeits the idiom-fusion wins that
are jz's actual edge against LLVM-backed rivals.

**Recommendation — the endgame architecture**: general innermost-loop
auto-vectorizer as the base layer (promote MAP/REDUCTION/STENCIL off
WAT-syntax matching onto AST-level affine + dependence proofs, reusing
`static.js`'s `intExprRange`/`forCounterRange`/`linearIndexOf` and
`narrow.js`'s `arrayReadProvenInBounds` — proof primitives that already
exist for a *different* consumer, bounds-check elimination) **+** a small
number of high-value idiom fusers on top (masked-divergent outer-strip,
straight-line/reduction outer-strip, channel-reduce, butterfly) for
exactly the whole-idiom cases named above. Not full consolidation into
one universal matcher (loses the idiom-fusion edge), not a ground-up
rewrite (too costly, too risky, forfeits the edge in the interim).

## 4. Migration order, effort/payoff, at-risk bench rows

| step | action | effort | payoff | corpus risk |
|---|---|---|---|---|
| 1 | Consolidate: REDUCTION 2→1, OUTER-STRIP 5→2, CHANNEL 2→1, SLP 3→2. Delete `tryByteScan`. | **S-M** — mechanical, infra already shared per §2 | −7 recognizers, real maintenance win, zero strategic gap closed | LOW if merges are precondition-supersets (the design constraint above); **CHANNEL merge is the one exception** — `bench/blur` is the *sole* specimen for both tiers, no second specimen as a safety net; needs a dedicated bit-exact WAT-diff re-check for both the 4px and 1px tiers, not just "still fires". OUTER-STRIP merge touches all 11 specimens across the family (`bench/mandelbrot`, `examples/{burningship,julia,newton,mandelbrot,chladni,domain-color,plasma,interference,lyapunov}`, `bench/conv2d`) simultaneously since they'd share one driver — re-verify all 11, not just the ones semantically nearest the edit |
| 2 | Fold `vectorizeStraightLineF64DotPairsIn` into `slpStorePairsIn`'s general SLP walker; generalize `hoistReductionInvariantsIn` beyond `DOT_UNROLL=4`. | **S-M** | resolves the 2nd zero-reach recognizer's honest "unknown precondition" flag as a side effect (census §9 row 18) instead of a standalone bug hunt | `bench/mat4` (hoist) and `slpStorePairsIn`'s 3 specimens (`examples/{lenia,penrose}`, `realinput/jzify_entry`) — re-verify all 4 |
| 3 | Promote MAP class (`tryVectorize` first — highest reach, highest blast radius) to prove "affine in IV, base loop-invariant" via `static.js`'s `intExprRange`/`linearIndexOf`/`forCounterRange` at the AST level, instead of `matchLaneAddr`'s post-lowering WAT-pattern re-derivation. | **L** — genuine pipeline rearchitecture (moves the proof obligation earlier), though the proof primitives already exist and don't need inventing | **HIGH** — this is the actual fix for "rivals naturally compile efficient programs": any novel affine loop starts vectorizing without a bespoke recognizer, the real gap named in the task | Every MAP-class bench row (≈92/130, roughly half the corpus) is at risk simultaneously — highest blast-radius change in the file. Must re-verify bit-identical output, not just re-verify "still vectorizes" |
| 4 | Extend `static.js`'s affine algebra with a real loop-carried dependence test (distance-vector / index-difference-range non-zero proof) for REDUCTION and eventually STENCIL to generalize past their current syntactic matchers. | **L-XL** | MEDIUM — REDUCTION/STENCIL already have decent reach (12/130); marginal novel-loop win smaller than step 3's, since MAP dominates real programs | `bench/{dotprod,matmul,poly}`, `bench/heat`, `bench/sdf`, `examples/{diffusion,ocean,schrodinger,slime,watercolor,waves}`, `examples/{buddhabrot,metaballs}`, `bench/nbody` |

Order: 1 → 2 (cheap, safe, do first) → 3 (the actual strategic fix,
budget it as the real investment) → 4 (only after 3 proves the AST-level
approach doesn't regress anything, lower urgency given smaller reach).

**Fixed-specimen discipline**: bench sources never change under this
plan — every row above is the compiler re-proving the SAME source
program, never a source edit to help the engine along (repo convention,
`CLAUDE.md` "Optimize the tool, never the input").

## 5. Delete-now list

**`tryByteScan` only.** 0/130 reach, confirmed real (not an
instrumentation gap — a synthetic memchr-shaped repro fired the trace on
first try, census §9 row 10). Self-contained, zero shared infra with any
other recognizer (own bespoke `matchByteCompare`) — deleting it costs no
coupling risk elsewhere in the file. It is a genuinely different
transform (early-exit masked search, not map/reduce/stencil), so it does
NOT fold into any of the consolidations in §2 — there is nothing to
subsume it into. Recommend delete, not rebuild: 0 evidence any real
program needs it, and re-adding a general early-exit-loop vectorizer
later (if a real specimen ever shows up) is exactly the kind of harder,
dependence-driven work §3 step 4 already earmarks — no reason to carry
dead insurance for it now.

**NOT deleted**: `vectorizeStraightLineF64DotPairsIn` (0/130, but the
census's own honest framing is "unknown(precondition)", not a confirmed
real zero — its synthetic repro attempts failed, unlike `tryByteScan`'s)
folds into the general SLP pass in §4 step 2 rather than a bare delete —
cheaper to let the broader matcher subsume it than to debug why the
narrow one won't trigger.
