Scout report (Sonnet 5.5, 2026-11-12), tree `d50ccbfbf`, read-only. Leads, not facts: V = the
scout read the line or measured it, I = inferred. The nine programs of `vectorize-leads.md` were
run again by the integrator on `d50ccbfbf` and on the published `v1.0.2`: all nine differ from
Node on both. The scripts the text names (`leads-minimal.mjs`, `ablate.mjs`, the raw rows and
tables) were session scratch and are not in the repo.

# A. Vectorizer map: what each recognizer proves

Tree: worktree of `d50ccbfbf` (jz, `src/optimize/vectorize/`, 28 files, 10,613 lines). V = I read the code or measured it; I = inferred.
Line numbers of `index.js` below are the committed file's (my instrumentation, `instrumentation.patch`, shifts them).
Sections 0 to 4 are mine (items a to k for tryMemCopyFill, tryVectorize, tryReduce, tryStencil, tryGeneralStencil, tryGeneralMap, tryGeneralReduce, tryGatherMap). Appendices B1 to B3 (below) were mapped by three Sonnet 5.5 agents (`claude-sonnet-5-5`, claim by claim with `file:line`, V/I marked, each told to read only): B1 = tryDivergentEscapeVectorize, tryChannelReduce, tryOuterStripRest and per-pixel-color; B2 = tryToneMap, tryRampMap, slpPairsIn, hoistReductionInvariantsIn; B3 = tryPrefilter, tryPairIterations, tryStrengthReduceIV, hoistStripSplats, hoist-consts, the canonicalizeCounters retry. I read none of those files whole (outer-strip, blur-channel, divergent-escape, tone-map, dot-slp, prefilter, pair-iterations, per-pixel-color, outer-scaffold): their claims are the agents' except where marked; I re-read 11 quoted lines of theirs against the source and all matched (alias.js:285, outer-strip.js:113-115 and 153-157, per-pixel-color.js:207, ramp.js:160 and 207, dot-slp.js:265, blur-channel.js:335, divergent-escape.js:182-193, lift.js:419), and I reproduced 5 of their leads as wrong answers (leads.md W2-W6; W1, W7-W9 came from my own reading of reduce.js and map.js).

## 0. How the pass is called (V)

- `src/optimize/driver.js:82-98` is the pass body: `vectorizeLaneLocal(fn, { multiAcc: cfg.reduceUnroll===true, relaxedFloat: cfg.relaxedFloat===true, relaxedSimd: cfg.relaxedSimd===true, blurMP: cfg.blurMultiPixel!==false, whyNot: cfg.whyNotSimd===true, stencil: cfg.stencil!==false, outerStrip: cfg.outerStrip!==false, pureFuncMap, toneMap: cfg.toneMap!==false, slp: cfg.slp!==false, crPow: cfg.crPow===true, pairIterations: cfg.pairIterations===true, links, typedView, warn })`. `aliasVersion` is not passed: default `true` (index.js:108).
- `src/optimize/pass-table.js:111` registers it `'+vectorizeLaneLocal'`, after `nanCanon` and `pureFuncMap`.
- Flags per level (`node -e` over `resolveOptimize`, `flags.txt`): level 2 and `'speed'`/3 both have `vectorizeLaneLocal, blurMultiPixel, stencil, outerStrip, toneMap, slp, clampPeel` on. Differences, V: level 3 (`L3_PRESET`, config.js:66) additionally sets `reduceUnroll` (4 accumulators in `reduceWrapper`, reduce.js:396, and relaxed integer-to-float forms), `relaxedFloat` (f64 pmax/pmin reductions reduce.js:165, f32 lanes for f64 math, `hoistReductionInvariantsIn`), `relaxedSimd` (relaxed madd / relaxed trunc), `pairIterations` (L2_PRESET sets it false, config.js:67), `hoistVectorConsts`, `unrollTrips` (feeds the convolution-column recognizer). `'speed'` is the same object as 3 (config.js:199 `speed: L3_PRESET`), so there is no third setting to measure; I confirmed by compiling both (`flags.txt`; hash identity of speed vs 3 not separately run, they are one preset object, V). `'size'` and `noSimd` turn the whole pass off (config.js:130, 279). Levels 0, 1 are off.
- Chain order (index.js:291-303), V: DivergentEscape, MemCopyFill, Vectorize, Reduce, Stencil, RampMap, ChannelReduce, OuterStripRest, ToneMap, GeneralMap, GeneralStencil, GeneralReduce, GatherMap. Around it: `hoistReductionInvariantsIn` (index.js:172, L3 only), `slpPairsIn` (175), retry after `canonicalizeCounters` (307-321), `gateStrips` (324) on any chain or retry lift, `hoistStripSplats` (326) on any lift, `tryPrefilter` (327) when nothing lifted or the gate declined, `tryPairIterations` (329, gated again 330), `tryStrengthReduceIV` deferred to after the walk (357, 375-382).
- The scaffold is matched once for the chain: `matchBlockLoop(node, { allowPreamble: true, allowInlinedLi: true })` (index.js:232) and, separately, `matchOuterPixelLoop(node)` (index.js:271). A loop whose block does not match either never reaches a recognizer (the census counts those as no row).

## 1. The shared scaffold (what every `bl` consumer inherits) (V)

`matchBlockLoop` default arm, scaffold.js:186-323:
- Block must be labeled; exactly one `loop`, labeled, ending `(br loop)` (scaffold.js:215-243, `matchLoopBrEnd` 152-158). Non-loop content in the block: only, with `allowPreamble`, pure `local.set` (hasSideEffect guard with `SAFE_OFFSET_CALLS`, scaffold.js:234-235); anything after the loop bails.
- Step: the statement before the back edge must be `x = x + C` with `C === 1` (`matchIncN`, addr-model.js:23-30; scaffold.js:301-303). The CSE'd form `x = $t` with a tee `$t = x + 1` anywhere in the body is recovered (scaffold.js:306-313). So: unit step, ascending, no other step, no descending loop, no unrolled-by-2 loop (a loop that an earlier pass unrolled to `i += 2` has no scaffold: see the spelling gate, C).
- Exit: `loopNode[2]` must be `br_if $block (i32.eqz (i32.lt_s|lt_u (local.get i) BOUND))` (`matchExitBrIf`, addr-model.js:36-44), and its counter must equal the step's (scaffold.js:316-317). No `<=`, `>=`, `!=`, no bound on the left, no exit anywhere else than the top. `lt_u` is accepted but every lift tests `lt_s` (scaffold.js:57, 74; lead).
- Bound: any expression is matched (`bound`, `boundLocal` when `local.get`, scaffold.js:319-320); each recognizer then demands a local or a constant (`!boundLocal && !isI32Const(bound)`: map.js:79, reduce.js:300, tone-map.js:138, ramp.js:38, memcpy.js:83, gather-map.js:13-14) except stencils (`boundPureInv`: const, unwritten local, global, +,-,* thereof, stencil.js:13-19).
- `bodyFacts` (scaffold.js:176-184): `writes` (every local set/tee in the body; the IV is in it unless the run was split off), `referenced`, `hasGlobalSet`, `hasImpureCall`, and the BodyModel (`addrTable`, `offsetTees`, `siteAccess`, constant `aliasClass`, addr-model.js:548-554). `bl.outsideReads` is attached by index.js:260-264 (lazy `liveOutOf`, index.js:185-207).
- Variants: `multiInc` (ramp; trailing run of `x += C`, exit counter c===1, scaffold.js:248-267), `ivRun` (general map + counter-run; secondary counters `k += const | unwritten local`, scaffold.js:274-299), `envelope: 'loose'` (channel reduce: any non-loop content, nothing validated, scaffold.js:210-244), `envelope: 'pixelIV'` (outer pixel loops; any `local.set` preamble, scaffold.js:191-208).

### Dependence machinery shared by recognizers (V)

1. `laneAccess(body, name, outsideReads)` (addr-model.js:70-77): first access `read` = carried, `write` = lane local; `write` followed by a read some path reaches first is `read` (82-101); a lane local the continuation reads is `liveout`. Every recognizer that classifies through it declines or special-cases `liveout`.
2. `aliasGuards(sites, stride, lanes, {defs, varying, version})` (alias.js:73-99): per store, every other site of the same base expression (`exprEq(normTee(base))`, alias.js:78) gets the linear distance of the two indices (`linearIndex`, alias.js:22-41, mod 2^32, index temporaries and tees resolved). Distance constant: accepted iff 0 or `|d| >= lanes` (alias.js:83); not constant: a hoisted run-time test `d <= -lanes || d >= lanes` (alias.js:86-95) unless `varying` writes it (then decline). Different base expressions are not compared at all here. Users: `tryGeneralMap` (map.js:560), `tryGeneralStencil` (stencil.js:407) only.
3. `gateStrips(r, node, fnLocals, distinct, pointerOf)` (alias.js:210-350), applied by index.js:324 to every chain/retry lift and 330 to pair-iterations. Not applied to prefilter, memcpy's `ordered` lifts return early (alias.js:350 `found || r.ordered`). What it proves: for every store site of the scalar loop against every other memory site (`memorySites`, alias.js:130-139: all loads/stores in the loop, memarg folded into the address), (a) `s.raw === st.raw` (same base as the recognizers read bases, `baseOf(ptr, defs)`) is SKIPPED (alias.js:285 `if (s.raw && s.raw === st.raw) continue`, comment "the lift's own dependence test"); (b) distance zero is fine (287); (c) two bases both in `distinctParams` apart (alias.js:275-278, 288); (d) two array-pointer locals need only `P != Q` (alias.js:289-292, 319); (e) any other pair: a run-time `apart(d, S*lanes)` when both move by the same step and width (alias.js:322-325), else a byte-interval test `below()` needing the strip's `bound` (alias.js:326-332), else decline. The test wraps the strip bound (`select limit iv test`) or the strip block (`if test then c`) (alias.js:345). A lift that registers no strip and is not `ordered` is declined (alias.js:350). So the contract is: same base = the recognizer's job; different bases = the gate's job. Recognizers without their own same-base test (tryVectorize, tryRampMap, tryToneMap, the outer family, 4px blur) are exact only when their address forms force same base => same element.
4. `distinctParams` (index.js:131-132): `fn.distinctParams` minus every parameter the function writes (compile/emit-func.js sets it). `arrayPointers(fn)` (alias.js:169-196): a local is an array pointer if it is a parameter in `fn.arrayParams` never written, or every write of it decodes a pointer (`$__ptr_offset*`, `$__alloc_hdr*`, `i32.wrap_i64(reinterpret)`).
5. `isProfitable(body, lifted, lanes, guardCount)` (cost-model.js): used by tryGeneralMap (map.js:623), tryGeneralStencil (stencil.js:452), tryGeneralReduce (reduce.js, end), tryGatherMap (gather-map.js:107). Not by any other recognizer.

## 2. Recognizers I read: items a to k

Legend: gate = the `opts` name and `cfg` flag; all of them also need `vectorizeLaneLocal` (levels 2 and 3).

### 2.1 tryMemCopyFill (memcpy.js, 199 lines; entry :77; chain 2nd, index.js:292; retried after counter rewrite, index.js:313)
- a. No option. Levels 2, 3.
- b. `bl` default, `bl.preamble.length === 0` (:78); `loopNode.length` 6 or 7, i.e. one store, or one `local.set` plus one store (:81).
- c. Unit step (scaffold). Bound: const or a local that is not the IV (:83); not checked unwritten (a store-only body writes only `tempName`).
- d. Store/load of one of `MEMOP_STORES` (:40-47): same width, element stride k; address via `matchLaneAddr` with an unwritten i32 base (:100-101) or its own `splitLane` (:20-35: IV, `IV<<K`, plus invariant terms); memarg folded (:112-113). Value: a constant (0 fill, byte const for store8) or a load of the same width (:135-143).
- e. Dependence, exact: memory.copy is memmove; the forward loop equals it unless the destination starts strictly inside the source window. :185-192: `if (dst <= src || dst >= src + len) then memory.copy else <original loop>` (run-time, per entry). Same array and different arrays both covered. Returns `ordered: true` (:198) so gateStrips lets it through (alias.js:350). Fill needs no test.
- f. No lane locals. The temp `tempName` and the address/offset tees are landed with their last values (:170-175), the IV set to the bound (:170). So reads after the loop are exact; `outsideReads` not needed (V).
- g. Control flow: none.
- h. `if i < bound then (setup; action)` (:196): no strip, no tail, one bulk op; a zero-trip loop untouched.
- i. No cost test.
- j. `memory.copy` / `memory.fill`; no lanes.

### 2.2 tryVectorize (map.js:71-447; 643-line file; chain 3rd, index.js:293; retried index.js:314)
- a. Gate none. Args `pureFuncMap`, `constLocals`.
- b. `bl` default + preamble (cloned ahead, :437). `blHasGlobalSet` declines (:218).
- c. Unit step ascending; bound local or const (:79); a bound local written in the body declines (:236).
- d. `matchLaneAddr` (addr-model.js:249-266) with AoS pixel strides (`allowAos = true`, :96), CSE offset tees (:91, 227-229 re-verifies each with `_offsetLocalStride`), full-address tees (:88), pixel-index locals (:103-111), mirror stores `base + ((INV - i) << K)` (f64 only, :178-186). A folded `offset=N` memarg is read through (`memAddr`, :139) and survives onto the vector access (lift.js:668-671, 626, 648). One lane type from the first float lane (`floatLane`, :118) or first load (:149-152), narrowing stores and f32/f64 widening allowed (:116, 152, 169).
- e. Dependence, exact: the recognizer has no dependence test at all. There is no distance computation, no `aliasGuards`, no `distinctParams` (imports map.js:2-11; `aliasGuards` is imported for the general map only, used :560). What it enforces is purely syntactic: every load and store address is `base + (i << K)` with the same `i` and (AoS aside) one stride, so two accesses through the SAME base expression hit the same element at the same iteration. But memargs are NOT part of that: `a[i+1] = a[i]` reads `f64.load a+(i<<3)` and writes `f64.store offset=8 a+(i<<3)`; both address nodes are the same `base+(i<<3)` and the offsets are dropped by `memAddr` (:139). The strip then loads lanes (i, i+1) before storing (i+1, i+2): the scalar forward-propagation is broken. What stops it, if anything, is gateStrips and it skips pairs on the same base (alias.js:285). Lead A2/A3/A7/A8 in `leads.md` (measured there). The different-base case is covered by gateStrips through `simdBound` (:414; scaffold.js:80 registers the strip).
- f. Locals: every referenced local is `invariant` (unwritten), `addr` (i32 and an address/offset/pixel-index local, :262), or `lane` (:265); first access a read => loop-carried => decline (:251); a lane local the continuation reads (`liveout`) is accepted only as a constant flag (`constantFlagStore`, :17-36, landed after the loop :431) else decline (:254-258).
- g. Control flow through `liftStmt`: lane-if, predicated if, if-store (lift.js:146-545); no `br_if` out.
- h. `simdBound(i, bound, lanes)` span-aligned from the entry value of `i` (:414), strip, then the original block as the scalar tail (:437); no minimum-trip test (empty strip when the span is short, scaffold.js:75-79).
- i. No cost test.
- j. Lane type from the data: f64x2, f32x4, i32x4, i16x8, i8x16 (LANE_INFO); AoS gather/scatter over 2 f64 lanes.

### 2.3 tryReduce = tryReduceReassoc ?? tryReduceBitExact (reduce.js:81-368, 512-611; entry :613; chain 4th, index.js:294; retried index.js:317)
- a. Gate: `multiAcc` (= `cfg.reduceUnroll`, level 3 only) selects 4 vector accumulators for f64/f32 plain reductions (:396); `vecState.relaxF32` (= relaxedFloat, level 3) gates the f64 pmax/pmin min-max form (:165). Otherwise levels 2 and 3.
- b. `bl` default, no preamble (:83). Body one statement (`acc = acc OP expr`) or the NaN-canon pair; a conditional-store min/max is rewritten to a select (:98-113), a load-cache temp is inlined (:45-79, :133-145).
- c. Unit step; bound local or const (:300); loop-invariant `INV` folded out of an `(INV+i)<<K` index (:243-269).
- d. `matchLaneAddr` (:323) on loads only, stride = lane stride (f32 widening 4); `offset=` memarg read through (:321-323).
- e. Dependence: none needed, none made. Stores and intermediate `local.set/tee` inside the expression are forbidden (:331-332), the accumulator is not re-read (:333). No memory writes in the loop, so no strip pair exists (gateStrips: no store, returns r, alias.js:214).
- f. The accumulator is the one carried local; its type must match the lane (:296). `outsideReads` is used for load-cache temps and select-assign stage temps (:57, :104). The scalar tail continues from the merged acc (`reduceWrapper` merge).
- g. Control flow: `select` forms only (canon min/max).
- h. `simdBound(i, bound, lanes * NACC)` (reduceWrapper), strip, horizontal fold, scalar tail = original block.
- i. No cost test (reassoc tier).
- j. f64x2 / f32x4 / i32x4 / i16x8 / i8x16 (min/max narrow, widening byte sum to i32x4).
- tryReduceBitExact (:512-611): a second shape in the same entry. Body of >= 2 `local.set` statements, accumulators `acc = acc + E` (f64 only, :517-525), loads checked through `bl.siteAccess` stride 8 (:546-548); lifts only f64 const/load/arith/sqrt (:540-565); two scalar adds per accumulator in lane order (bit-exact). Dependence: no store exists in the body (all statements are `local.set`, :520), so none needed. LOCAL AFTER THE LOOP: the lane locals (non-accumulator `local.set` targets) live only as v128 temps (:553-570); they are not landed in the scalar and `bl.outsideReads` is never read in this function (grep: reduce.js has outsideReads only at lines 45, 57, 104, 122). Lead A1.

### 2.4 tryStencil (stencil.js:170-324; chain 5th, index.js:295) and tryGeneralStencil (stencil.js:349-476; chain 11th, index.js:301)
- a. Gate `stencil` (= `cfg.stencil !== false`; on at levels 2, 3; the header comment "gated until proven" is stale, driver.js:89).
- b. `bl` default + preamble (cloned ahead). No nested loop or non-`$math` call (`hasNestedLoopOrCall`, :181, :356). `hasGlobalSet` declines.
- c. Unit step; bound `boundPureInv` (:13-19), re-evaluated for the strip. Start anywhere (span aligned, `simdBound`).
- d. Index model `stencilIndexModel` (:26-141): `ivCoeff(n) === 1` for IV, derived IVs, `INV ± IV`, toroidal wrap-selects (peeled), float-domain row bases. tryStencil matches `base + (IDX<<K)` privately (:193-214, bases global or unwritten local); the general version uses `matchStrideAddr` (addr-model.js:346-357). Neighbour memargs carried as `memBytes` (:219-220, :372-373).
- e. Dependence, exact. tryStencil (:252-258): for each store, every site whose base expression is structurally equal (`exprEq(normTee)`) must have the SAME element key (`idx@memBytes/stride`) else decline: an in-place stencil is refused; different base expressions are assumed apart (header :163-166, "Distinct base subtrees assumed non-aliasing"), and gateStrips tests them (strip via `simdBound` :309). tryGeneralStencil: `aliasGuards` (:407): constant distance `0` or `>= lanes`, invariant distance versioned behind a hoisted guard (`if (guards) then peel, strip`, :470-472), `version: aliasVersion`.
- f. Locals: i32 = addr (tryStencil :271) or derived IV; lane/invariant by laneType; `laneAccess` with `bl.outsideReads` (:277, :434), `read`/`liveout` decline.
- g. Control flow through `liftStmt`; wrap-selects (peel, :315-318).
- h. `simdBound(i, min(bound, right-wrap bounds), lanes)` (:308-309); left column peeled once scalar (:315-318); scalar tail = original block.
- i. tryStencil none; tryGeneralStencil `isProfitable` (:452).
- j. f64x2/f32x4 (tryStencil: f64/f32 only :222, :234); any lane type for the general one.

### 2.5 tryGeneralMap (map.js:452-643; chain 10th, index.js:300; retried index.js:315)
- a. Gate none (option `aliasVersion` default true). Gets the `ivRun` variant of the scaffold (`getBlRun`, index.js:285-289) falling back to `bl`.
- b. `ivRun`: exit counter by 1 plus secondary counters stepped by const or unwritten local (scaffold.js:274-299). No nested loop/call (:460).
- c. Bound local or const (:457); secondary counters `ivs`.
- d. `matchStrideAddr` (addr-model.js:346-357) with `affineIvCoeff` (:285-302): IDX coefficient 1 in the exit counter. Gathers: an address affine in a secondary counter (:472-481), or any integer expression of the counter and invariants (`counterGather` :499-509), lanes read element i+L; a gather base must not be stored anywhere in the loop (:555).
- e. Dependence, exact: `aliasGuards(sites, stride, lanes, {defs, varying: ivWrites, version})` (:560). Same-base store/other-site pair: constant distance accepted if 0 or >= lanes (alias.js:83), invariant distance gets a hoisted `D <= -lanes || D >= lanes` test; a distance reading a written local, or `version=false`, declines (alias.js:86-89). `(st.memBytes - s.memBytes) % stride !== 0` declines (alias.js:79). Gathers are not paired (alias.js:78) because their base is never stored (:555). Different bases: gateStrips (index.js:324; `simdBound` :630).
- f. Locals: secondary counters, moving index temps and index-only names are `addr` (kept scalar; :593-600); written locals via `laneAccess` with `bl.outsideReads`, `read`/`liveout` decline (:602-603).
- g. `liftStmt` forms (lane if, if-store, select).
- h. `simdBound` (:630); versioned strip `if (guards) then (bound; strip)` (:637-639); scalar tail = original block; skipped strip leaves counters at entry values.
- i. `isProfitable(body, lifted, lanes, guards.length)` (:623), reason "not profitable: vector cost/lane >= scalar cost" (2 loops measured).
- j. Lane type of the first load/store; all of LANE_INFO.

### 2.6 tryGeneralReduce (reduce.js:654-781; chain 12th, index.js:302; retried index.js:318)
- a. Gate `multiAcc` as above. `bl` default, no preamble (:655); body 1 or 2 statements (:658); accumulator type = lane (:717).
- b-d. `affineIvCoeff` (:719) + `matchStrideAddr` (:721) instead of tryReduce's shape list; same single-statement forms; no widening forms.
- e. Dependence: none needed (no stores, scanExpr forbids them, :742). 
- f-h. As tryReduce (`reduceWrapper`, shared).
- i. `isProfitable(body, [[reduceEntry.simd, liftedExpr]], lanes, 0)` (:777).
- j. As tryReduce. It sees only what tryReduce declined; the census counts how many (Table 1: 0 loops at speed take it).

### 2.7 tryGatherMap (gather-map.js, 114 lines; chain 13th, index.js:303)
- a. No option; needs `distinctParams` non-empty (:13), no global set.
- b. `bl` default; exit must be `lt_s` (:14); bound local unwritten or const (:15).
- c. Unit step; counters beyond the exit counter are scalar recurrences kept in order.
- d. One `f64.store` at `base + (i<<3)` with base a `distinctParams` parameter unwritten (:16-22); loads in the scalar prefix at `distinct + offset` of a DIFFERENT distinct parameter (:57-70).
- e. Dependence, exact: `distinctParams` only (index.js:131-132). Loads must name a different proven-owned parameter than the store (:62-63, `a[1][1] === addr.base[1]` unsafe), so delaying the first store past the second iteration's reads cannot matter (header :1-4). Everything else scalar in order (:43-81). gateStrips also applies (`simdBound` :107; `separate` for distinct pairs, alias.js:275-278).
- f. Vector locals must be `write`-first (`laneAccess(suffix, name, outsideReads) === 'write'` :36-37); scalar part may not read or write a delayed vector local (:49-51); scalar-written locals feeding the vector part are packed per lane (:85-108).
- g. Scalar part may hold `if`, `select`, checked loads; no calls, no branches out (:58-72).
- h. 2 iterations per strip (`simdBound(i, bound, 2)` :108), scalar tail = original block.
- i. `isProfitable(body, packed, 2)` (:107).
- j. f64x2 (suffix lifted to f64x2, prefix per-lane scalar).

## 3. Items for the other eight steps

See the appendices: B1 (group1.md) = tryDivergentEscapeVectorize, tryChannelReduce, tryOuterStripRest (+ per-pixel-color); B2 (group2.md) = tryToneMap, tryRampMap, slpPairsIn, hoistReductionInvariantsIn; B3 (group3.md) = tryPrefilter, tryPairIterations, tryStrengthReduceIV, hoistStripSplats, hoist-consts, the canonicalizeCounters retry. Each has items a to l per step; the line numbers inside are relative to `src/optimize/vectorize/` except where a path is given.

Gate summary (V, from the agents' reports and config.js): tryDivergentEscapeVectorize, tryMemCopyFill, tryVectorize, tryReduce, tryRampMap, tryGeneralMap, tryGatherMap, tryPrefilter, tryStrengthReduceIV, canonicalizeCounters, hoistStripSplats: no own option (pass level). tryStencil/tryGeneralStencil: `stencil`. tryOuterStripRest: `outerStrip` (tryPerPixelColor inside it ungated; conv-column effectively level 3, it needs the unrolled body `unrollTrips`). tryChannelReduce: `blurMP` for the 4-pixel tier, the 1-pixel tier always. tryToneMap: `toneMap`. tryPairIterations: `pairIterations` = level 3 only. hoistReductionInvariantsIn: `relaxedFloat` = level 3 only. slpPairsIn: always (dot tier); element-store tier `slp && !typedView`. FMA forms: `relaxedFloat && relaxedSimd`, level 3.

## 4. Shared helpers against private re-derivations (V, from imports and the agents' k sections)

Which shared helpers each file imports (grep of `^import` of every recognizer file, `imports.txt`):

| recognizer (file) | matchBlockLoop/bl | addr-model fns | alias.js | cost-model | lane-tables | lift.js | node-utils |
|---|---|---|---|---|---|---|---|
| tryMemCopyFill (memcpy) | bl | matchLaneAddr, _offsetLocalStride, constNum | none (own run-time test) | no | no | no | isArr |
| tryVectorize (map) | bl | matchLaneAddr, matchLaneOffset, matchMirrorAddr, matchConstMulIV, _isAddressLocal, _isPixelIndexLocal, _offsetLocalStride, laneAccess | gateStrips only | no | LANE_INFO, LOAD/STORE_OPS | liftStmt, liftCtx | yes |
| tryReduce (reduce) | bl | matchLaneAddr, _offsetLocalStride, laneAccess-free | no | no | REDUCE_*, LANE_INFO | liftExprV | yes |
| tryStencil (stencil) | bl | none of matchLaneAddr (private matchAddr), laneAccess | no (private in-place gate) | no | LANE_INFO | liftStmt | yes |
| tryRampMap (ramp) | own `matchBlockLoop(multiInc)` | matchLaneAddr, laneAccess | gate only | no | LOAD/STORE_OPS | liftStmt, liftExprV | yes |
| tryChannelReduce (blur-channel) | loose `bl` | constNum, isLocalGet, isI32Const only | gate only (`strips` WeakMap direct, :335) | no | no | no | yes |
| tryOuterStripRest (outer-strip, per-pixel-color) | `matchBlockLoop` for the inner loop, `op` for the outer | matchIncN | gate only (`stripBlock`) | no | LANE_PURE, LOAD/STORE_OPS | own three lift bodies | yes |
| tryToneMap (tone-map) | bl | laneAccess, constNum | gate only (`simdBound`) | no | LANE_*, PPC_CALL2 | liftCtx, vecState (own `liftV`) | yes |
| tryGeneralMap (map) | `ivRun` bl | matchStrideAddr, affineIvCoeff, indexDefs, laneAccess | aliasGuards + gate | yes | yes | liftStmt | yes |
| tryGeneralStencil (stencil) | bl | matchStrideAddr, indexDefs, laneAccess | aliasGuards + gate | yes | yes | liftStmt | yes |
| tryGeneralReduce (reduce) | bl | matchStrideAddr, affineIvCoeff | no | yes | yes | liftExprV | yes |
| tryGatherMap (gather-map) | bl | matchLaneAddr, laneAccess, collectWrites | distinctParams + gate | yes | LANE_PURE | liftStmt | no |
| tryDivergentEscapeVectorize | `op` (pixelIV) | hasSideEffect, isLocalGet | gate only | no | LANE_PURE | none (own `liftable`) | yes |
| tryPrefilter | bl | constNum, hasGlobalSet | none (no gate: runs after it) | no | own LANES | none | yes |
| tryPairIterations | `op` | readsBeforeWrite | gate (after) | no | own regexes | none | yes |
| tryStrengthReduceIV | bl | matchLaneAddr (allowTee false) | none | no | no | no | yes |
| canonicalizeCounters | ivRun | hasBranchOrReturn | gate (via retried lift) | no | no | no | yes |
| slpPairsIn / hoistReduction (dot-slp) | none | collectWrites | none (no strips) | no | no | none | yes + access.js |

Private re-derivations, counted per kind. These are counts of the entries listed in the "where" column, assembled from my reading and the agents' k sections; they are a hand census, not a mechanical one, and a private copy I did not see is not in them (V for each listed entry, I for completeness):

| kind | shared helper | private re-implementations | where |
|---|---|---|---|
| exit-test matching | `matchExitBrIf` (addr-model.js:36) | 4 | outer-scaffold.js:97 `matchPixelExit`; blur-channel.js:187-188 (pixel) and 203-204 (tap); divergent-escape.js:48-73 `breakCond`/`keepOf` |
| step/increment matching | `matchIncN` (addr-model.js:23) | 4 | outer-scaffold.js:79 `matchNumericInc1`; blur-channel.js:193-195; divergent-escape.js:36; strength-reduce.js (bumps `1<<k` assuming c=1); counter-run.js:61-66 (own const-step run) |
| address matching | `matchLaneAddr`/`matchStrideAddr` | 9 | memcpy `splitLane` (:20); stencil `matchAddr` (:193) x2 inside tryStencil; tone-map `matchToneAddrShift` (:80); blur-channel `matchChannelAccum`+`buildPivotCoeff` (:25, :125); counter-run `cursorAddr` (:24); prefilter `affine` (:68); outer-strip `liftOS` address read (:61-67) + conv `isGatherAddr`; reduce.js `foldAddr` (:248) |
| invariance / writes census | `collectWrites`, `bodyFacts.writes`, `isInvariantBase` | 8 | memcpy `invariant` (:10); divergent-escape `inv`/`boundInvariant` (:27, :172) using `writesName`; outer-scaffold `writesName` (:51); counter-run `invariant` (:26); dot-slp `isInv` (:175); prefilter `writes` scan (:136); strength-reduce `written` (:48); pair-iterations `W` scan (:176-187); hoist-splats `written` (:82) |
| first-access classing | `laneAccess` | 6 | divergent-escape carried/temp (:118-130); tone-map `_toneFirstWrite` (:109-132); pair-iterations `itemPrivate` (:106-143); per-pixel-color lane/epilogue split (:203-227); outer-strip lane classing (:98-164); iterated reduce `shadowOf` |
| aliasing | `aliasGuards`, `gateStrips` | 5 | tryStencil in-place gate (stencil.js:252-258); memcpy overlap test (memcpy.js:185-192); pair-iterations roots by name (:252-273); gather-map `distinct` loads (gather-map.js:57-70); dot-slp `slpReadsSlot` + `!typedView` (dot-slp.js:216-229, 261-268) |
| lift bodies (lane op translation) | `liftStmt`/`liftExprV` | 5 | tone-map `liftV` (:259), outer-strip `liftOS` (:48-92) and iterated `lift` (:265-308), per-pixel-color `liftPPC` (:146-191), divergent-escape `liftCLane` (:304-323) |
| SIMD loop construction | `simdLoop`/`simdBound` | 3 | tone-map.js:541-546; reduce BitExact (`$__mrl`); blur-channel 4px (`b4end`) |
| profitability | `isProfitable` | 3 private proxies | per-pixel-color `heavy` regex (:229-230), iterated-reduce `sawHeavy`, prefilter "heavy body behind the test" (:131-134) |

The 13-recognizer chain therefore splits (V) by what proves "no store of one iteration reaches another access of the strip": 2 call `aliasGuards` (GeneralMap, GeneralStencil); 3 have a test of their own (Stencil: refuses any other element of a written base; MemCopyFill: run-time overlap test, `ordered`; GatherMap: `distinctParams`); 6 have none and rest on their address shape plus gateStrips, which skips same-base pairs (Vectorize, RampMap, ToneMap, ChannelReduce 4px, OuterStripRest family, DivergentEscape); 2 are read-only, no store in the loop (Reduce, GeneralReduce). Of these six, Vectorize, RampMap, ToneMap and DivergentEscape each have a program in leads.md whose answer is wrong. 4 recognizers use `isProfitable` (GeneralMap, GeneralStencil, GeneralReduce, GatherMap).



---

# Appendix B1: divergent-escape, channel-reduce, outer-strip family (Sonnet 5.5 agent, `map-parts/group1.md`, verbatim)

# Group 1 map: divergent-escape, channel-reduce, outer-strip family

Worktree: /Users/div/projects/jz/.claude/worktrees/agent-a874443978e8f17a0, dir src/optimize/vectorize/ (paths below relative to it).
V = read in code. I = inferred. All line numbers are of the worktree files.

## 0. Shared facts (all three groups)

- Chain (index.js:291-303): `tryDivergentEscapeVectorize(node, fnLocals, freshIdRef, op)` is 1st (L291); `tryChannelReduce(node, fnLocals, freshIdRef, getBlLoose(), blurMP)` is 7th (L297); `tryOuterStripRest(node, fnLocals, freshIdRef, pureFuncMap, outerStrip, op)` is 8th (L298). V
- `op = matchOuterPixelLoop(node)` (index.js:271). `getBlLoose()` = `matchBlockLoop(node,{envelope:'loose'})` (index.js:281-282). V
- NONE of the three receives `outsideReads`. `outsideReads` is only attached to `bl` (index.js:260-264) and the `ivRun` variant (index.js:287). The loose `bl` and `op` carry none. V
- None of the five files imports cost-model.js (`isProfitable`); none calls `aliasGuards`, `laneAccess`, `matchLaneAddr`, `matchStrideAddr`, BodyModel (grep of imports: divergent-escape.js:1-6, blur-channel.js:1-5, outer-strip.js:1-7, per-pixel-color.js:1-7, outer-scaffold.js:1-4). V
- Strips: every outer recognizer registers its strip with `stripBlock(simdOuter, pxVar, pivType.get(pxVar)==='f64' ? null : widthBound, lanes)` (divergent-escape.js:581; per-pixel-color.js:269; outer-strip.js:200, 391, 528). `stripBlock` sets `strips.set(node,{iv,bound,lanes,block:true})` (scaffold.js:68). blur 4px registers `strips.set(b4end,{iv:pivot,bound:dc(bound),lanes:4})` (blur-channel.js:335); blur 1px registers none and returns `ordered:true` (blur-channel.js:396). V
- `gateStrips(r, scalar, ...)` runs on the result (index.js:324). With no store in the original loop it returns `r` ungated (alias.js:214 `if (!sites.some(s => s.store)) return r`). With stores it only adds a run-time test for pairs it cannot prove, and it SKIPS any pair whose two sites have the same raw base: alias.js:285 `if (s.raw && s.raw === st.raw) continue` with comment "(one base as the recognizers read bases: the lift's own dependence test)". None of these recognizers has a dependence test of its own, so same-base pairs are never tested for them. V
- gateStrips never sees an f64 pixel IV bound (`bound` null): a pair needing the `below()` test then returns null (alias.js:330 `if (!bound) return null`), i.e. declines. V
- Option / level gating (V unless I): pass `vectorizeLaneLocal` runs `vectorizeLaneLocal(fn, {...})` (driver.js:82-97) when `cfg.vectorizeLaneLocal` (pass-table.js:111 `'+vectorizeLaneLocal'`). L2_PRESET (config.js:67) and L3_PRESET (config.js:66) both spread ALL_ON (config.js:63) and neither sets `vectorizeLaneLocal`/`blurMultiPixel`/`outerStrip` false, so all on at levels 2 and 3/'speed'. Off: level 0 (ALL_OFF), `size` (config.js:130 `vectorizeLaneLocal:false`), `noSimd` (config.js:279). `blurMultiPixel` and `outerStrip` are PASS_NAMES entries (passes.js:162, 164; `TUNING_KEYS` starts passes.js:177). `unrollTrips` is after L177 (passes.js:202) so I: tuning key, set true only by L3_PRESET; it unrolls the loops that make tryConvColumn's body (L397-399 comment) so ConvColumn is I: effectively level-3 only.
- Common outer scaffold `matchOuterPixelLoop` (outer-scaffold.js:126-160), used by groups 1 and 3:
  - `matchBlockLoop(node,{envelope:'pixelIV'})` (scaffold.js:191-208): block must be labeled `$..`; children: any number of `local.set` (any RHS, no purity test, L201) before exactly one `loop`; nothing after; loop label + final `(br loop)` (matchLoopBrEnd scaffold.js:152-158).
  - Step: trailing run of `v = v + 1` statements (`matchNumericInc1`, outer-scaffold.js:79-86; i32.add const 1, or f64.add f64.const 1) read backwards from `endIdx-1` while `i >= 3` (L132-136) = the "pixel IVs".
  - Exit (loopNode[2], `matchPixelExit` L97-106): `br_if $oLabel (i32.eqz (CMP (local.get IV) BOUND))`, CMP in {i32.lt_s, i32.lt_u, f64.lt}; the IV must be one of the pixel IVs with the same type (L139).
  - Bound: `i32.const` (L143), or `local.get`/`global.get` not written in loop (`writesName(loopNode,..)` = local.set/tee/global.set only, L144-146, L51-58). A bound read through a call that writes a global is not seen. V
  - No `br`/`br_if`/`br_table` in obody naming oLabel or loopLabel (L151). A `return` or branch to an outer label is not rejected. V
  - `innerIdxs` = obody top-level statements that are a `block` containing a `loop` (L154-158). `hasImpureCall` = any `call` not starting `$math.` in obody (addr-model.js:648-655). V

---

## 1. tryDivergentEscapeVectorize (divergent-escape.js)

### a. File / entry / gate
- divergent-escape.js, 588 lines. Entry `tryDivergentEscapeVectorize(blockNode, fnLocals, freshIdRef, outer)` L8; returns `{wrapper,newLocalDecls}` L587. Helpers from outer-scaffold.js (188 lines): CMP_LANE, bumpPixelIV, matchNumericInc1, readsVar, writesName. V
- Args from index.js:291: `(node, fnLocals, freshIdRef, op)`; `op` null returns null (L11). No pureFuncMap, no outsideReads, no option flag of its own. Gate = the pass only (see 0). V

### b. Scaffold
- Outer: matchOuterPixelLoop (0 above). Exactly one inner `(block $i ... (loop $il ...))` in obody (L13-20), labels must start `$`.
- Inner loop tail: last = `(br $il)` (L35), second last = `it = it + 1` via matchNumericInc1 (L36), `it`'s local type must equal the op type (L37); if f64 counter it may not be written elsewhere in the loop (L41). Top statement innerLoop[2] must be a break condition (`br_if $iLabel C` or `if C (then ... (br $iLabel))`, `breakCond` L48-62), `keepOf` (L69-73): after stripping `i32.eqz` the compare must be in CMP_LANE (f64.gt/ge/lt/le/eq/ne or i32 lt/le/gt/ge s/u). Compound guard `eqz(and(cmpA,cmpB))` also accepted (L84-89).
- Inner body (`ibody` = innerLoop.slice(3, iEnd-1), L79): only `local.set` of f64 locals (L98, L106) plus break statements (`midBreaks`). No other statement kinds. V
- Inner block may carry `innerPre` = `local.set` statements before the loop, each RHS invariant (L24-29). V

### c. Counter / step / bound
- Pixel counter: i32 or f64, step exactly +1; unit step only, ascending only, exit `<` only (outer-scaffold.js:79-106). Iteration counter `it`: +1, init must be const 0 (L257), kept in own type.
- Limit bound: expression taken from the keep compare (L160, L167), must not read carried/temp (L171) and `boundInvariant` (L172-173: every `local.get/global.get` in it unwritten in the loop nest; any other node kind, including a load or call, is accepted, and memory the epilogue stores to is not considered: I, low-reach lead). V

### d. Address forms
- None in the SIMD part: lifted exprs must be `LANE_PURE.f64` ops, `f64.const`, `local.get`, loop-invariant `global.get` (`liftable` L178-196; L193 `if (!LANE_PURE.f64.has(n[0])) bad`). LANE_PURE.f64 = add/sub/mul/div/min/max/neg/abs/sqrt/floor/ceil/trunc/nearest (lane-tables.js ~L94-110), no loads/stores/calls. Seeds/c-var inits: `liftCLane` (L304-323), same set. V
- The epilogue (obody after inner block, L229) is arbitrary scalar code run twice per pair (`epiLane(0)`, `epiLane(1)`, L578) with pixel IVs bumped by +k (`bumpPixelIV`). It may hold loads/stores/calls. V

### e. DEPENDENCE
- SIMD portion reads and writes no memory, so no memory dependence exists inside the strip (V: L193 + L321). Memory effects live only in the scalar epilogue, in pixel order. Lane 1's inner loop (pure) runs before lane 0's epilogue; that is safe only for memory because the lifted code reads none. It is NOT safe for scalar state the epilogue writes (see l1, l2).
- Function: none (no `aliasGuards`, no `distinctParams`). gateStrips applies (L581 registers the strip, block form): extra run-time test or decline only when the original loop has a store and a non-same-base pair it cannot prove; harmless here. V
- Quote of the only invariance proofs: `if (writesName(loopNode, n[1])) bad = true` for `global.get` (L192); NO such test for a `local.get` c-var (L182-190): `if (!carried.has(v) && !temp.has(v)) { if (fnLocals.get(v) !== 'f64') {bad...}; cVars.add(v) }`. V

### f. Local classing
- `carried` = f64 locals written in [top guard, body] whose first access is a read; `temp` = first access a write (L118-130). `cVars` = every other f64 local read in the lifted exprs (L175-196) = "per-pixel/invariant inputs", splatted (L333) or built by `liftCLane` when they have a pre-inner init (`perPxInit`, L260). Carried needs a seed in the pre-inner statements (L251-254, L266); seeds may read c-vars (pixel ramps through `liftCLane`).
- i32 outcome vars (multi-break path): seeded by a pre-inner `i32.const` init (L215, L261, L461-462).
- Epilogue reads of a `temp` or a per-pixel c-var with no prior epilogue write bail (L270-279).
- outsideReads: NOT consulted (signature L8 has none). Which locals hold a correct scalar value after the strip: fast path (L375-434) extracts carried + temp + perPxInit c-vars (epiLane L418-433); masked single-break path extracts only carried-read-by-epilogue and `it` (L564-571); multi-break path likewise plus outcome vars (L522-531). So a carried/temp/c-var not read by the epilogue keeps a stale scalar value after the strip when no tail iteration recomputes it. V

### g. Control flow
- Inner loop: top break + at most one mid-break (single-break path), or several outcome mid-breaks (multi-break, Newton), or compound top guard. Outcome-break assigns: only i32 consts, `it`, forbidden in single-break (L112) and top break (L76). No `if`/`select` inside body other than break forms. Lane divergence handled by v128 active mask (masked paths) or first-escape-exit plus per-lane scalar tail (fast path `relabelInner()` L407-414, L425-431). V

### h. Trip / tail
- SIMD loop: `br_if sOut (eqz (cmp (px+1) widthBound))` (L577): runs a pair while px+1 is valid, then every pixel IV += 2 (L579); the original block `tailBlock = (block oLabel loopNode)` (L585) finishes. No minimum trip test. V
- Preamble once, `innerPre` hoisted once ahead of SIMD (L586); the tail block keeps `innerPre` inside the original loop. V

### i. Cost test
- None (no isProfitable, no private threshold). V

### j. Emit
- f64x2 lanes (z/c shadows), `iter` f64x2 on masked paths, i32x4 outcome vectors (multi-break), `v128.any_true` exits. V

### k. Private re-derivations
- Exit-test/inc matching: outer-scaffold.js:79-86 `matchNumericInc1` (i32+f64 form) vs addr-model.js:23-30 `matchIncN`; outer-scaffold.js:97-106 `matchPixelExit` vs addr-model.js:36-44 `matchExitBrIf` (adds f64.lt, loses `i32.lt_s/u` check on IV type only via `isLocalGet`). V
- Invariance test: divergent-escape.js:27 `inv`, L172 `boundInvariant`, L192, L313 all `writesName` (outer-scaffold.js:51-58), vs scaffold.js `bodyFacts.writes`/`collectWrites` (addr-model.js:50-55) which also cover `local.tee`/params. `writesName` includes `global.set`; `collectWrites` only locals. V
- Per-lane classification L118-130 (carried/temp by first access) vs addr-model.js:57+ `laneAccess` (first-access classification with outsideReads). Not called. V
- Shared helpers called: `matchBlockLoop` (via matchOuterPixelLoop), `stripBlock`, `hasSideEffect`, `isLocalGet`, `LANE_PURE`. V

### l. Soundness leads (unverified by execution; each traced through the lines given)
1. LEAD DE-1, f64 pixel IV read directly in the inner loop. `liftable` L182-190 adds any f64 `local.get` that is not carried/temp/`it` to `cVars`, including an f64 pixel IV (param-bound loops, outer-scaffold.js:77-78). `cOrder` L325 puts it in the non-perPx group and `pre` gets `splat(local.get px)` (L333): both lanes get lane 0's px. `liftCLane` L311 ramps an f64 IV only inside a pre-inner init expr. Reachable if the inner update reads the pixel IV directly (not via a pre-inner local), e.g. width as f64 param:
   `export function f(out,w,n){for(let x=0;x<w;x++){let zx=0,it=0;while(it<n){zx=zx*zx+x*0.001;if(zx>4)break;it++}out[x]=it}}` (needs w to be f64-typed so x is f64; if LICM hoists `x*0.001` the `innerPre` check (L27) rejects). Reachable: I, moderate.
2. LEAD DE-2, c-var local written by the epilogue. Direct-read c-vars (L182-190) get no `writesName(loopNode, v)` test (only `global.get` does, L192); `pre` splats the local ONCE per pair (L333) before lane 0's epilogue ran. A scalar the epilogue updates and the inner loop reads is a recurrence across pixels:
   `export function f(out,w,n){let k=0.5;for(let x=0;x<w;x++){let zx=0,it=0;while(it<n){zx=zx*zx+k;if(zx>4)break;it++}out[x]=it;k=k+0.001*it}}`
   Epilogue guard L270-279 only rejects reads of temp/perPxInit, not writes to a c-var. A call in the epilogue that writes a global read by the inner loop (`global.get` check sees only `global.set`, L192) is the same hole; `outer.hasImpureCall` is never consulted here. Reachable: I, likely.
3. LEAD DE-3, no outsideReads. A carried/temp/c-var read after the outer loop (function-scope `var zx` returned after the nest) is stale on the masked paths (carried only extracted if read by the epilogue, L564, L522) and for any local the strip never materialises (perPxInit scalars on masked paths; dead per-pixel locals dropped, L262). Program: `export function f(out,w,n){var zx=0;for(let x=0;x<w;x++){zx=0;let it=0;while(it<n){zx=zx*zx+0.3;if(zx>4)break;it++}out[x]=it}return zx}` (carried zx not read by epilogue; masked path = escape-at-top forms, e.g. compound guard). Reachable: I, moderate.

---

## 2. tryChannelReduce (blur-channel.js)

### a. File / entry / gate
- blur-channel.js, 421 lines. Entry `tryChannelReduce(blockNode, fnLocals, freshIdRef, bl, blurMP)` L410. Two tiers: `tryBlurMultiPixel` (4 pixels per step, L179-346; gate `blurMP` = `cfg.blurMultiPixel !== false` driver.js:87, on at L2 and L3), then `tryChannelReduce1px` (L355-397, always when the scan matches). V
- Args: `(node, fnLocals, freshIdRef, getBlLoose(), blurMP)` (index.js:297). V

### b. Scaffold
- `bl` = loose envelope (scaffold.js:210-244): labeled block, ONE loop, ANY other array content anywhere before or after the loop with NO validation (`if (loose) continue` L224); loop label + final `br loop`.
- `bodyStart=3, bodyEnd=endIdx-1` (L413); no exit test and no increment test in the 1px tier (L355-357 "never validates the exit/inc shape"). V
- Scan `matchChannelReducePixelLoop` (L74-108): four consecutive top-level `acc = 0` i32 inits (L77-86); first top-level `(block (loop))` or bare `loop` after them (L90-94); inner loop must end in some `br` (L99, label NOT compared to the loop's own); `innerBody = innerLoop.slice(3, ilEnd-1)` (L100); `matchChannelGroup` L46-63: four consecutive top-level statements `acc_c = acc_c + i32.load8_u[offset=c] BASE`, first with `local.tee base EXPR`, other three `local.get base` (matchChannelAccum L25-40); four distinct accs equal (as a set) to the four zero-inited (L105).
- 4px tier extra (L184-266): exit must be `br_if (any label) (eqz (i32.lt_s (local.get x) BOUND))` (L187-188, label unchecked), inc `x = x + 1` at `loopNode[endIdx-1]` (L193-195), no `if` before the group in the inner body (L199), tap loop exit `br_if (eqz (i32.le_s (local.get k) R))` with R `local.get` or `i32.const` (L202-206), then store block (below).

### c. Counter / step / bound
- 1px: none of its own. 4px: pixel counter i32, unit step ascending, bound ANY expression (L190), re-evaluated once as `dc(bound)` in `b4end` (L332-335); not checked invariant, not checked pure. Tap counter: `k <= R`, R a local (any local, including the pixel IV or a pixel-written local) or const; tap init and step unchecked. V

### d. Address forms
- Matched privately: load `i32.load8_u [offset=c] (local.tee/get base)` (L25-40). Source base expression is any `teeExpr`; 4px adds stride analysis `buildPivotCoeff` (L125-160): symbolic per-pivot-step delta through add/sub/shl/mul-by-const/convert/trunc/tee/select-with-0; `pivotDelta(teeExpr) === 4` required (L257). Destination: the first store must be `i32.store8 (local.tee ab1 DST) val` then `offset=1..3 (local.get ab1)` (L230-243); DST stride per pixel is NEVER analysed. V

### e. DEPENDENCE
- 1px tier: no dependence issue by construction: the four consecutive loads become one `v128.load32_zero` at the same program point (L369-370, L373); stores stay where they were; returns `ordered:true` (L396, comment "(lanes of one pixel: its reads still run ahead of its stores...)"). gateStrips: no strip registered, `found||r.ordered` passes (alias.js:350). V
- 4px tier: proves NOTHING itself about src vs dst (no aliasGuards, no distinctParams). Relies entirely on gateStrips on `b4end` (L335). gateStrips outcome (I, from alias.js): different pointer bases get the run-time `P != Q` test (alias.js:289-292, 319); SAME raw base pairs are skipped (alias.js:285), so an in-place blur (load and store on the same array param) gets NO test. Other pairs with unknown motion decline (alias.js:321). V for the skip; I for blur outcome.
- Within the strip all four pixels' loads happen before any of their stores (v128 loads in the tap loop, stores in `epilogue` L303-310). V

### f. Local classing
- Lifted: only the 4 accs (to accLo/accHi i16x8 or accv i32x4). Everything else is scalar and unclassified. 1px: extracts back right after the inner block into `grp.accs[c]` (L387, L392-393). 4px: per pixel j sets accs from lane then reuses the store template (L304-310).
- NOT checked in either tier: other statements reading or writing the accs outside the matched group (inner-loop exit test, other inner-body statements, statements between the inits and the inner block). The `acc = 0` inits are removed (1px: replaced by one splat, L393; 4px: not carried L317) and the scalar accs are never updated inside the lifted inner loop. V
- 4px (c) (L267-279): store VALUES may read only accs and pivot-invariants. preStore (innerIdx+1..storeIdx, L302) and everything after the 4th store up to the increment are not checked (see l). V
- outsideReads: NOT consulted. 4px leaves per-pixel locals (`o`, `ab1`, tee'd `base`, preStore temps) at the group-base-pixel values (L303 computes them once per group). V

### g. Control flow
- 1px: whatever the inner loop already has (kept verbatim, only the 4 statements change). 4px: no `if` before the group (L199), inner loop `k <= R`. V

### h. Trip / tail
- 4px: `b4 = x + (R<128 ? ((bound - x) & -4) : 0)` (L332-334); loop while `x < b4`, step 4 (L315, L320); original block follows as the <=3 pixel tail (L344). `R < 128` guard is the i16 overflow guard (comment L328-331: win*255 < 2^16). No minimum trip test. 1px: n/a. V

### i. Cost test
- None. V

### j. Emit
- 1px: i32x4 `i32x4.extend_low_i16x8_u(i16x8.extend_low_i8x16_u(v128.load32_zero))` (L369-370). 4px: two i16x8 accumulators with `v128.load` 16 bytes (L290-291). V

### k. Private re-derivations
- Exit test blur-channel.js:187-188 (lt_s, any label) and tap exit L203-204 (le_s) vs addr-model.js:36-44 `matchExitBrIf`. Increment L193-195 vs `matchIncN` addr-model.js:23-30. Stride/affine analysis `buildPivotCoeff` L125-160 vs addr-model.js `affineIvCoeff`/`matchStrideAddr`/`matchLaneAddr`. Loop-written set L271-272 vs `collectWrites`. Pointer/alias: none (delegated to gateStrips). V (by reading); I that affineIvCoeff covers the same ground (addr-model.js not read in full).
- Shared helpers called: `matchBlockLoop` (loose, in index.js), `strips` (WeakMap from scaffold.js), `isI32Const/isLocalGet/constNum`, `readsVar`. V

### l. Soundness leads
1. LEAD CH-1 (strong), in-place same-array blur, 4px tier. 4px has no dependence test and gateStrips skips same-raw-base pairs (alias.js:285). Scalar order is pixel x stores then pixel x+1 loads (which re-read x's bytes through the window); the strip loads four pixels' windows before any store (blur-channel.js:290-291 vs 303-310). Program (src and dst the same param; RGBA row; run at r<128):
   `export function f(a,w,r){for(let x=r;x<w-r;x++){let s0=0,s1=0,s2=0,s3=0;for(let k=-r;k<=r;k++){const p=(x+k)<<2;s0+=a[p];s1+=a[p+1];s2+=a[p+2];s3+=a[p+3]}const o=x<<2,n=2*r+1;a[o]=(s0/n)|0;a[o+1]=(s1/n)|0;a[o+2]=(s2/n)|0;a[o+3]=(s3/n)|0}}`
   Whether the emitted WAT meets every private matcher (store temp `tw`, clamp-free) is I; the dependence hole itself is V.
2. LEAD CH-2 (strong), destination stride unchecked. Only the source delta is tested (L257). Stores use `offset=j*4+c` off the group-base `ab1` (L309), i.e. assume dst advances 4 bytes per pixel. A transposed or strided write (dst index `(x*h+y)<<2`, or `(x*2)<<2`) with unit-4 source reads passes every check and with src != dst even the run-time test. Program: `export function f(s,d,w,h,y,r){for(let x=r;x<w-r;x++){let a0=0,a1=0,a2=0,a3=0;for(let k=-r;k<=r;k++){const p=(y*w+x+k)<<2;a0+=s[p];a1+=s[p+1];a2+=s[p+2];a3+=s[p+3]}const o=(x*h+y)<<2,n=2*r+1;d[o]=(a0/n)|0;d[o+1]=(a1/n)|0;d[o+2]=(a2/n)|0;d[o+3]=(a3/n)|0}}`. Reachability of the matcher on this emission: I.
3. LEAD CH-3, statements dropped or run once per group in the 4px tier. `fourBody` (L314-322) = exit, inits..inner (`slice(initIdx+4, innerIdx)`), lifted inner, `epilogue` (preStore + ab1 + 4x4 stores), `x += 4`. Statements after the 4th store up to the increment (`scanIdx`..`bodyEnd`, L236-243) are never emitted: no check that `scanIdx` reaches `bodyEnd`. Statements between the inner loop and the first store (preStore, L302) run ONCE per group, not per pixel, and see stale scalar accs (extraction comes after them, L303-308). Program: an RGBA blur body with a trailing `cnt[x] = 1` or `total += s0` after the four stores, or `m[x]=1` between the loops and the stores. Reachable: I.
4. LEAD CH-4, tap trip count assumed pixel-independent and bounded by R. 4px: `R` may be any local including the pixel IV (L205-206): `for (let k=0;k<=x;k++)` gives pixels x..x+3 the group-base trip count; the i16 guard `R<128` assumes <= 2R+1 taps but the tap init (`k = -R`?) is never matched, so `k = -1000` with R small overflows i16 lanes. Statements between the inits and the inner loop are carried verbatim at base x (L317). Reachable: I (needs the matcher to accept, `k<=x` form).
5. LEAD CH-5, accumulator use outside the group, both tiers. Inner exit test, other inner-body statements, or statements between the inits and the inner block that read an acc (stale, init removed, L372-376, L393) or write one (`sr = 7` before the loop is overwritten by the extraction). Program: `... let s0=0,s1=0,s2=0,s3=0; s0=5; for(k...){... s0+=a[p]...}` (JS `let`+assign). Reachable: I, plausible only in hand-written variants.
6. LEAD CH-6, loose envelope runs unvalidated content twice. 4px: `preamble = blockNode.slice(2, loopPos).map(dc)` (L343) is any array content before the loop (loose matcher accepted it unchecked, scaffold.js:224) and is then run again inside `blockNode` (L344). The default matcher (scaffold.js:235) demands pure `$__li` sets; the loose one does not. Reachable only if a block carries a non-idempotent statement before its loop (jz emission normally does not): I, low.
7. LEAD CH-7, no outsideReads: 4px leaves `o`/`ab1`/base-tee/preStore temps at the group-base pixel values; read after the loop with an even remainder (no tail iteration) they differ from scalar (last pixel). Reachable: I, low.

---

## 3. tryOuterStripRest (outer-strip.js, 565 lines) and per-pixel-color.js (272 lines)

### a. File / entry / gate
- Entry `tryOuterStripRest(blockNode, fnLocals, freshIdRef, pureFuncMap, outerStrip, outer)` outer-strip.js:559-564 = `tryPerPixelColor ?? tryOuterStrip ?? tryIteratedReduce ?? tryConvColumn` in this order (L560-563). `tryPerPixelColor` (per-pixel-color.js:20, the only per-pixel-color export used) is ungated (needs `outer`, optional `pureFuncMap` = `facts.pureFuncMap`, driver.js:91). The other three are gated `enabled`=`outerStrip` = `cfg.outerStrip !== false` (driver.js:90), on at L2 and L3. tryConvColumn only fires after the body is unrolled (I: L3, unrollTrips). V
- Sizes: tryOuterStrip L24-203, tryIteratedReduce L225-394, tryConvColumn L412-531.

### b. Scaffold
- Common: matchOuterPixelLoop (0). Per recognizer:
  - tryPerPixelColor: `innerIdxs.length === 0` (L27).
  - tryOuterStrip: exactly one inner block-loop (L30); inner via `matchBlockLoop(innerBlock,{allowPreamble:true})` (L33) = default envelope: `(block $b [$__li set]* (loop (br_if $b (eqz (i32.lt_{s,u} i BOUND))) body (i = i + 1) (br loop)))`, exit `matchExitBrIf` (scaffold.js:316), step `matchIncN` c===1 at incIdx (scaffold.js:301-303); preamble must be empty (L35).
  - tryIteratedReduce: >=1 inner block-loops (L229); each via `matchBlockLoop(..,{allowPreamble:true})` (L340); preamble cloned (L345).
  - tryConvColumn: pixel IV must be i32 (L416), no inner loop (L417).
- All: `!outer.hasImpureCall` for outer-strip/iterated/conv (L39, L234, L419); per-pixel-color uses its own `impureCall` (per-pixel-color.js:33-41) which also allows `pureFuncMap` calls. V

### c. Counter / step / bound
- Outer: see 0 (unit +1, `<`, invariant bound, ascending only). Inner (outer-strip, iterated): i32 `i < BOUND`, `i += 1`; the INNER BOUND IS NOT CHECKED INVARIANT AGAINST THE PIXEL (`ibl.bound` never read in outer-strip.js or the iterated inner path; `iExit = innerLoopNode[2]` reused verbatim L185, L345). V

### d. Address forms
- per-pixel-color: no loads lifted (`liftPPC` has no load case, per-pixel-color.js:146-191); loads stay in the scalar epilogue. V
- outer-strip / iterated: an `f64.load` is lifted as `splat(scalar load)` when its address reads neither `pxVar` nor a lane local (outer-strip.js:61-67, L278-282). Address is otherwise unconstrained. V
- conv: `i32.load8_s/u` byte taps, gather = address that reads any local transitively dependent on `pxVar` (`oxDep`, L421-427), lifted as `v128.load64_zero` at the same address (L441, L454). V

### e. DEPENDENCE
- per-pixel-color: lifted code is pure ($math/pure-fn/arith, no loads). Memory only in the scalar epilogue in pixel order. No dependence needed. Lane locals read invariants only if `!writesName(loopNode, v)` (L155), which covers writes in the epilogue. V
- outer-strip / iterated: invariant loads of the inner loop (`bx[b]`) run for both lanes before lane 0's epilogue store. NO own dependence test. Safety rests on gateStrips (strip registered L200/L391), which skips same-base pairs (alias.js:285): a store `a[x]` in the epilogue and an inner load `a[b]` of the same array are never tested. Different pointer bases: `P != Q` test (alias.js:289-292). V for the skip; reachability of the program in l2 is I.
- conv: 8 pixels' byte loads happen before 8 stores. No own test; same gateStrips dependence, `lanes` = 8 (L528). Same-base skip applies. V
- The header text (outer-strip.js:22) says "Bases that may be one array are tested at the strip (alias.js gateStrips)": true except for the same-raw-base case above. V

### f. Local classing
- tryPerPixelColor: statement-wise: a top-level `local.set f64` whose RHS fully lifts becomes a lane local (L203-211); everything else is epilogue; a lane local re-set in the epilogue and consumed by another lane expr bails (hazard L221-227). `laneLifted`/`laneMap` are `Map`s keyed by name (L62-63, L207). outsideReads: NOT consulted; lane locals the epilogue does not read never reach the scalar local (`epiReads` L254).
- tryOuterStrip: invariant (not written in loop: splat, L56-57), lane (f64 local reading `pxVar` directly: ramp lane L127-133; accumulators `acc = acc + E`; inner temps L159-164), scalar (everything else, kept verbatim: non-f64 sets and ANY non-`local.set` statement before the inner loop, L115, L134). Carried-across-outer accumulators must be freshly seeded (L137-143). Epilogue read-safety `epilogueIsSafe` (outer-scaffold.js:69-76). outsideReads NOT consulted; only epilogue-read lanes are extracted (L181).
- tryIteratedReduce: f64 locals become lanes on assignment (`shadowOf`); scalar counters need `laneInvariant` rhs (reads no lane local and no pixel IV, L243-250, L315, L359); non-local.set pre-inner statements return null (L362). outsideReads NOT consulted.
- tryConvColumn: `oxDep` transitive pixel-dependent locals (L422-426); single f64 accumulator `acc = acc + product` with >=4 writes (L463-467); scalar statements before the last MAC are copied once per 8 pixels (L505-506). outsideReads NOT consulted.

### g. Control flow
- per-pixel-color: lifted expr may contain `if (result f64)` -> bitselect (L174-186); the epilogue has any control flow. outer-strip: inner body only `local.set` f64 and the IV bump (L150); lifted expr may hold `if (result f64)`. iterated: also `select` (L302), scalar-invariant `if` with i32 sets (L320-322), per-lane `if(cond) acc += E` (L324-334). conv: straight-line (no inner loop). V

### h. Trip / tail
- Pair strip (per-pixel-color, outer-strip, iterated): `px+1 < width` then +2; original block as tail (e.g. per-pixel-color.js:265-270). conv: `px+7 < width`, +8 (L524-526), tail = original. No minimum trip test. V

### i. Cost test
- tryPerPixelColor: private `heavy` (regex of sin2/cos2/pow2/log_v/atan2_2/hypot_2/exp2_2/tan2 calls or `f64x2.sqrt` in a lifted lane, L229-230). tryIteratedReduce: `sawHeavy` = some `PPC_CALL2` call lifted (L288, L364). tryOuterStrip, tryConvColumn: none. No isProfitable anywhere. V

### j. Emit
- f64x2 (per-pixel-color, outer-strip, iterated); conv: i16x8 products (`i16x8.mul` of `i16x8.extend_low_i8x16_{s,u}(v128.load64_zero)` and `i16x8.splat`), widened into two i32x4 accumulators `i32x4.extend_low/high_i16x8_s` (L475-479), 8 lanes. V

### k. Private re-derivations
- Pixel-IV ramp: `rampPixelIV` (outer-scaffold.js:183-187) is the shared helper, used. `bumpPixelIV`, `epilogueIsSafe` shared and used. Re-derived privately: `laneInvariant` (iterated, L243-250), `oxDep` (conv L422-427), `impureCall` (per-pixel-color.js:33-41 vs `hasImpureCall` addr-model.js:648), `pxAlias` (per-pixel-color.js:47-57), a second copy of `liftOS`/`lift`/`liftPPC` (outer-strip.js:48-92, L265-308, per-pixel-color.js:146-191; three near-identical lift bodies), `findStore` (outer-strip.js:175, 369, 512). Exit/step: through matchOuterPixelLoop/matchBlockLoop (shared) and `matchIncN` (shared). No alias/affine helper from addr-model/alias is used. V

### l. Soundness leads
1. LEAD OS-1 (strong), non-`local.set` statement before the inner loop runs once per pair. tryOuterStrip L113-115: `if (!(local.set ...)) { laneInit.push(s); continue }`. A store, `if`, or call-free side effect in obody before the inner loop executes for pixel x only; pixel x+1 never gets it (tail only handles a leftover odd pixel). `outer.hasImpureCall` allows `$math.*` only, stores pass. Program: `export function f(a,b,out,n,w){for(let x=0;x<w;x++){b[x]=1;let s=0;for(let i=0;i<n;i++)s+=a[i];out[x]=s}}` (f64 arrays). Reachable: I, likely (needs LICM/normalization to leave `b[x]=1` as a top-level obody statement; `normalizeTransparentBlocks` flattens).
2. LEAD OS-2 (strong), acc written in a form other than `+` is treated as `+`. Pre-scan registers a name as an accumulator when ANY ibody statement is `name = name + E` (L98-105); the lift loop then handles EVERY statement writing that name as `acc += addend`, with `addend = isLocalGet(rhs[1], name) ? rhs[2] : rhs[1]` (L153-157) and never checks `rhs[0] === 'f64.add'`. `s = s - E` or `s = s * c` becomes `s += E` / `s += c`. Program: `export function f(a,b,out,n,w){for(let x=0;x<w;x++){let s=0;for(let i=0;i<n;i++){s+=a[i];s-=b[i]}out[x]=s}}`. Reachable: I, likely.
3. LEAD OS-3, inner loop bound / inner loads not tested against per-pixel dependence. `iExit` reused unchanged (L185, L188, iterated L345); no check that the inner `BOUND` is invariant. A triangular nest (`for (let i=0;i<x;i++)`) gives lane 1 the lane 0 trip count. Program: `export function f(a,out,w){for(let x=0;x<w;x++){let s=0;for(let i=0;i<x;i++)s+=a[i];out[x]=s}}`. Also the load address test reads only `pxVar` (L65, L280), not other pixel IVs or an i32 local derived from `pxVar` in a pre-inner scalar statement (`laneInit.push(s)` L134, no taint as conv's `oxDep`): `const base=x*4; for(..) s+=t[base+i]` splats lane 0's load. Reachable: I, likely for the bound; moderate for the derived-local address (iterated rejects derived i32 defs at L359; outer-strip does not).
4. LEAD OS-4 (strong), same-array read and write across pixels. Inner loop reads `a[i]` (pixel-invariant, splat), epilogue stores `a[x]`; scalar pixel x+1 reads what pixel x wrote, the strip does not; gateStrips skips same-raw-base (alias.js:285). Program: `export function f(a,n,w){for(let x=0;x<w;x++){let s=0;for(let i=0;i<n;i++)s+=a[i];a[x]=s*0.001}}`. Reachable: I, likely. Same for iterated (L278-282) and conv (taps vs `inp[ox]` stores).
5. LEAD OS-5 (strong), conv: unsigned x unsigned products overflow i16. `matchByteLoad` accepts `load8_u` for both operands (L436-437); the product is `i16x8.mul` (L455) of `extend_low_i8x16_u` values and an `i16x8.splat`, widened with `extend_*_i16x8_s` (L477-478). u8*u8 up to 65025 wraps to a negative i16. Comment says "int8 x int8" (L402). Program: four or more unrolled taps `acc+=x[ox+0]*w0 ...` over Uint8Array with Uint8Array weights, values near 255. Reachable: I (needs >=4 MAC statements in an unrolled body, speed tier).
6. LEAD OS-6, conv: input stride unchecked. `isGatherAddr` says "depends on ox", not "advances 1 byte per ox"; `v128.load64_zero` at the lane-0 address (L441, L454) assumes unit stride. `inp[ox*2+k]` (strided conv) lifts 8 contiguous bytes. Also scalar statements before the last MAC (L505-506) run once per 8 pixels, including stores. Reachable: I.
7. LEAD PPC-1 (strong), tryPerPixelColor with a lane local assigned twice. `laneLifted.set(s[1], lifted)` (L207) overwrites the first lifted expr for the same name while `laneCompute` keeps first position (Map insertion order, L258); the second assignment `x = x*0.5` lifts to a read of the lane's OWN shadow. Program: `export function f(px,n){for(let x=0;x<n;x++){let v=Math.sin(x*0.1);v=v*v;px[x]=(v*255)|0}}` (u32 store needed; exactly one i32.store, L236). First assignment lost, v128 shadow uninitialised/stale. Reachable: I, likely (depends on whether the jz front end already splits the reassignment into a fresh local; propagateLocals runs after the vectorizer per blur-channel.js:213-215 comment).
8. LEAD OUT-1, no outsideReads in any of the four: a lane local the epilogue does not read (or an accumulator not read by the epilogue) is never materialised in the scalar local, so reading it after the outer loop sees the stale value (even width, tail runs zero iterations). Program: `var s; export function f(a,out,n,w){var s=0;for(let x=0;x<w;x++){s=0;for(let i=0;i<n;i++)s+=a[i];out[x]=1}return s}`. Reachable: I, low.
9. LEAD OUT-2, a secondary pixel IV (parallel `j += 1`) written elsewhere in obody, or any non-`pxVar` pixel IV read in a load address: not checked (outer-strip.js:65 only `pxVar`). Reachable: I, low.


---

# Appendix B2: tone-map, ramp-map, slp / dot hoist (Sonnet 5.5 agent, `map-parts/group2.md`, verbatim)

# Group 2: tryToneMap, tryRampMap, slpPairsIn / hoistReductionInvariantsIn

Worktree: /Users/div/projects/jz/.claude/worktrees/agent-a874443978e8f17a0. Paths below are relative to `src/optimize/vectorize/` unless prefixed (`config.js`, `driver.js`, `passes.js` are `src/optimize/` or `src/`).
Marks: V = read in code, I = inferred. Nothing was run.
Abbrev: I=index.js, S=scaffold.js, A=addr-model.js, AL=alias.js, AC=access.js, L=lift.js, T=tone-map.js, R=ramp.js, D=dot-slp.js.

---------------------------------------------------------------------
## 1. tryToneMap (tone-map.js)
---------------------------------------------------------------------

### a. file / entry / gate
- V tone-map.js = 558 lines. Entry `export function tryToneMap(bl, fnLocals, freshIdRef, enabled)` T:135.
- V Call site I:299 `tryToneMap(bl, fnLocals, freshIdRef, toneMap)`. Receives the shared default scaffold `bl` (I:232 `matchBlockLoop(node, {allowPreamble:true, allowInlinedLi:true})`, with `bl.incVar` possibly overridden from the lowering link I:263 and `bl.outsideReads` set I:264). `bl` may be null: T:136 `if (!enabled || !bl) return null`.
- V Option: `toneMap`. I:107 destructure default `toneMap = false`; driver.js:92 `toneMap: cfg.toneMap !== false`.
- V `toneMap` is a registered pass name, passes.js:165 (inside PASS_NAMES, starts passes.js:11; TUNING_KEYS starts passes.js:177). So `ALL_ON` has it true.
- V Levels: config.js:66-67 L3_PRESET/L2_PRESET both spread `...ALL_ON` and neither sets toneMap false, so ON at level 2, level 3 / 'speed' (config.js:124, 199), and 'fast' (config.js:88). OFF where the whole pass is off: level 0 (config.js:70), level 1 (config.js:71, vectorizeLaneLocal not listed), 'size' (config.js:130 `vectorizeLaneLocal: false`).
- V Header comment T:8 and T:28 call it "experimental ... Gated until proven"; the driver default makes it on. Comment and behaviour disagree (stale comment).
- V Level-3-only sub-feature: `vecState.relaxedSimd` picks `i32x4.relaxed_trunc_f64x2_*` (T:239-241). relaxedSimd is L3 only (config.js:66; driver.js:86 reads cfg.relaxedSimd). At L2 it emits `trunc_sat`.

### b. scaffold
- V Shared `matchBlockLoop` default + allowPreamble + allowInlinedLi (S:301-322): `(block $b [pure local.set preamble]* (loop $l (br_if $b (i32.eqz (i32.lt_{s,u} (local.get i) BOUND))) BODY… (local.set i (i32.add i 1)) (br $l)))`. Exit test via `matchExitBrIf` (A:36-44), increment via `matchIncN` c===1 (S:302-303), plus the CSE'd-increment recovery (S:306-313).
- V Requires `boundLocal` or `i32.const` bound: T:138.
- V The SIMD loop is hand-assembled T:541-546 (exit test `i32.eqz (i32.lt_s i simdBound)`, `i += 2`), not via shared `simdLoop` (S:55).

### c. counter / step / bound
- V Unit step ascending only (S:302-303 c===1). SIMD step LANES=2 (T:537). Bound: local (must not be written in body, T:175) or `i32.const` (T:138). Any other bound expression: rejected T:138.
- V matchExitBrIf accepts `lt_u` (A:41) but the SIMD guard is always `lt_s` (T:543, simdBound uses `lt_s` S:74). See lead L-T4.

### d. address forms
- V Private matcher `matchToneAddrShift` T:80-96: `base + i` (shift 0) or `base + (i << shift)`, either operand order (T:95 `pair(addr[1],addr[2]) || pair(addr[2],addr[1])`), base must be `local.get` (not the IV) or `global.get` (T:89-90). Also `(local.tee $a ADDR)` / `(local.get $a)` reuse (T:81-86), `tees.once` = exactly one write (T:146).
- V NO constant offset, NO memarg: a load/store with `offset=K` has n[1] a string, fails T:87 `!isArr(addr)` for the store (T:153) and `n.length === 2` for loads (T:158, falls to T:164 `LOAD_OPS` -> ok=false).
- V Allowed ops: `i32.load` shift 2, `i32.load8_u/_s` shift 0, `i32.load16_u/_s` shift 1, `f32.load` shift 2 (TONE_LOAD T:65-73); store only `i32.store` and `f32.store` at shift 2 (T:151-156). Any other load/store op: ok=false (T:164).
- V Base invariance NOT checked (see L-T2).

### e. DEPENDENCE
- V Recognizer-internal proof: NONE beyond the address shape. The shape forces every access to index exactly `i` (no offset), so two accesses through the SAME base expression hit the same element index (or, for different shifts, a different element width, see L-T5). There is no `aliasGuards`, no `distinctParams`, no same-base distance computation in T (grep: T imports only constNum/laneAccess/isI32Const/isLocalGet, lane tables, lift ctx, simdBound; T:1-6).
- V Distinct-base aliasing is delegated to `gateStrips`: T:550 `simdBound(incVar, boundExpr, LANES, overread)` registers the strip (`strips.set(limit, {iv, bound, lanes: lanes+overread})`, S:80). `gateStrips` finds it (AL:340 `strips.get(c)`), builds the pair list from the scalar loop's own memory sites (AL:255-297) and wraps the bound `select limit iv test` (AL:345) or returns null when a pair cannot be tested (AL:343, 350). index.js:324 applies it to this recognizer's output with `scalar = node` (I:290).
- V What gateStrips does for pairs T produces: same local-base name -> skipped (AL:285 `if (s.raw && s.raw === st.raw) continue`: "the lift's own dependence test", which T does not have, see L-T5); two distinct bases both proven `distinctParams` -> skipped (AL:288); two array-pointer locals -> `P != Q` test (AL:289-293); otherwise `apart(d, S*lanes)` run-time `D==0 || |D|>=span` for equal step/width (AL:322-325), or a byte-range `below` test for different widths such as u8 load against u32 store (AL:330-332).
- V Within the strip: lane 1 of an iteration pair loads after lane 0's store only through the same index (no offset), so same-base same-index in-place maps are exact. Statement order is preserved in the lift (liftS in body order, T:532).
- V `hasGlobalSet` -> null (T:170). Calls: only `PPC_CALL2` math mirrors (T:303-307); other calls fail "no lane mapping" (T:332). So no memory written by a call.
- I Speculative evaluation of both lanes inside `if` arms (T:484 `out.push(...pre); return v` when the arm has no call; T:513-524) includes loads at `base+(i<<k)` for lane i+1 even when the scalar guarded them. Safe only if the loop bound already guarantees the array holds index < bound (which is what let jz emit a bare `i32.load`). Not proven here (lead L-T6, low).

### f. local classing
- V `localKind` T:176-185: IV skipped; written -> `laneAccess(body, name, bl.outsideReads)` T:181, `'read'` (carried) or `'liveout'` -> return null T:182; else 'lane'; unwritten -> 'invariant'. There is no 'addr' class.
- V outsideReads IS consulted (T:181 via `bl.outsideReads`, set by I:264). Per-iteration lifted locals read after the loop decline.
- V Carried local: declined (no handling). First-write-inside-`if` locals: allowed only if they appear in no other statement (T:190-196).
- V IV written in body: declined, `local.set`/`local.tee` of a non-lane name fails T:448, T:298.
- V Bound local written in body: declined T:175.

### g. control flow
- V Accepted in body: `block`, `local.set` of lane, `f32.store (f32.demote_f64)`, `i32.store`, `if` forms: (a) conditional store (then-only or then/else, both ending in a store to the same address by `nodeEqual`, T:468-494), (b) no-else conditional lane update (T:498-526). Value-position `select`, `if (result)` (T:308-317). Not accepted: br_if / br out of the body (no case in liftS0, T:529 "unsupported statement"), calls as statements, nested loops.
- V Store-count gate: 1 or 2 stores total (T:169).

### h. trip count / tail
- V 2 iterations per strip; `simdBound(incVar, boundExpr, 2, overread)` T:550: `end = iv + ((bound - iv - overread) & -2)`; for non-const bound `select end iv (iv<bound && span >= 2+overread)` (S:75-79). `overread` = 2 for u8 loads (T:67-68, `load32_zero` reads 4 bytes for 2 lanes), else 0. No minimum-trip test beyond that. Scalar tail = original `bl.blockNode` (T:551) with its own preamble; a cloned preamble also runs before the strip (T:551 `preamble.map(cloneNode)`).

### i. cost test
- V None. No `isProfitable` import (T:1-6). Gate is shape-only (`hasConvert` f64-island signature, T:169).

### j. emits
- V f64x2 island with i32x4 low lanes: `v128.load64_zero` / `load32_zero` + widen, `f64x2.convert_low_i32x4_*`, `$math.*_v`/`*2` 2-wide calls, `i32x4.trunc_sat_f64x2_*_zero` (or relaxed at L3), final masked `i64.store` of `i64x2.extract_lane 0` (2 pixels, 8 bytes) or demoted f32x4 pair. 2 elements per iteration.
- V Truncation guarded by a lane-range test with scalar fallback per lane (T:231-255, 418-435), so no ulp/range drift.

### k. private re-derivations / shared helpers
- Re-implements:
  - address matcher `matchToneAddrShift` T:80 (vs `matchLaneAddr` A:249: the shared one requires base on the LEFT n[1], A:262-263; T accepts either order) [V]
  - write counting `addrTees.once` T:146 (vs `collectWrites`/BodyModel `addrTable` A:476) [V]
  - first-write/liveness `_toneFirstWrite`, `_toneAppears` T:109-132 (vs `laneAccess`/`readsBeforeWrite` A:70-101) [V]
  - hand-built SIMD loop T:541-546 (vs `simdLoop` S:55) [V]
  - `_toneCalls` T:29 (vs `hasImpureCall` A:648 / `hasNestedLoopOrCall` A:660) [V]
  - ToInt32 pattern matchers `matchTruncF64`/`matchInfCanonTone` T:35-56 (vs `peelNarrowConv`/`unmaskStore` L:1003-1009) [V as existence, I as to overlap]
  - its own `liftV` T:259 (nested, deliberate, T:205-209) beside `liftExprV` L:604 [V]
  - no invariance test for bases (T:89), unlike `isInvariantBase` A:278 [V]
- Calls shared: `matchBlockLoop` (through bl, I:232), `laneAccess` (T:181), `constNum/isI32Const/isLocalGet` (T:2), `liftCtx/liftFail/vecState` (T:4), `simdBound` (T:550), `LANE_PURE/LANE_COMPARE/LOAD_OPS/STORE_OPS/PPC_CALL2` (T:3). NOT used: `aliasGuards`, `matchStrideAddr`, `affineIvCoeff`, `indexDefs`, `isProfitable`, `simdLoop`, `liftStmt`, `liftExprV`.

### l. soundness leads (all unverified by execution)

- L-T1 (high-ish, plausible shape). Conditional-store arm with an intermediate store is lifted UNMASKED.
  T:480-488 `arm()`: `for (const s of stmts.slice(0,-1)) { liftS(s, pre) }` then `out.push(...pre)` (T:484) when the arm has no call, or `if taken {pre…}` when it has one (T:486). An intermediate statement that is a store goes through `liftS0` STORE_OPS branch (T:457-461) and emits an unconditional full 2-lane `i64.store`. Count gate allows it: `storeCount <= 2` (T:169) and the store-address shape holds. Scalar semantics: that store happens only in lanes where the condition holds; lifted: both pixels.
  Program: `export function f(d, a, b, n){ for (let i=0;i<n;i++){ const v=d[i]; if (v>0){ b[i] = 7; a[i] = (Math.log(v+1)*20)|0 } } }` with d,a,b Int32Array (needs `f64.convert_i32_*` to set hasConvert, e.g. use `v * 1.5`). Reachable: I think yes if jz keeps the shape (arm = [store, store] with no else; a[i] last store). Lead.
- L-T2 (low). Base local written in the body is accepted as an address base. `matchToneAddrShift` T:89-90 checks only `local.get` and not equal to IV; `writes` classification T:176-185 then marks it 'lane' and lifts its `local.set` into a v128 shadow (T:446-450), while the address node is kept verbatim scalar (T:281 `['v128.load64_zero', expr[1]]`, T:460). The scalar `$p` is never set inside the strip. tryVectorize classes such i32 address locals 'addr' (map.js ~ localKind 'addr', kept scalar); tone-map has no 'addr' class. Program: `for (i<n) { const q = flag ? a : b; q[i] = Math.log(d[i]+1)*5|0 }` with a Int32Array... reachable only if jz leaves the per-iteration pointer select in the loop (normally hoisted by LICM). Lead.
- L-T3 (low). IV written in body is declined here (T:448), fine. (Contrast with ramp, L-R3.)
- L-T4 (low, shared with every recognizer). `matchExitBrIf` accepts `i32.lt_u` (A:41); SIMD guard and `simdBound` are `lt_s` (T:543; S:74, S:57). With a `lt_u` scalar loop and an entry value with the sign bit set the strip would run where the scalar loop would not. Reachability: jz emits `lt_s` for `i < n` on i32; `lt_u` only from unsigned compares. Lead, unverified.
- L-T5 (very low). `gateStrips` skips pairs whose bases are the same local name (AL:285), assuming the recognizer proved same-index. T proves same index (no offsets) but not same element WIDTH: a u8 load (shift 0) and an i32 store (shift 2) through ONE local `p` would be skipped by gateStrips though bytes overlap across iterations. Needs one local used as both a u8 and an u32 pointer; jz types a local one way, so I think unreachable without views.
- L-T6 (low). Speculative lane-1 loads in no-call arms (T:484, T:513-524): lane i+1 read at `base+((i+1)<<k)` even if the scalar skips it. Safe only given loop bound <= array length, which T does not check.

---------------------------------------------------------------------
## 2. tryRampMap (ramp.js)
---------------------------------------------------------------------

### a. file / entry / gate
- V ramp.js = 377 lines. Entry `export function tryRampMap(blockNode, fnLocals, freshIdRef, outsideReads)` R:29.
- V Call site I:296 `tryRampMap(node, fnLocals, freshIdRef, outsideReads)` (raw block node, the lazy `outsideReads` object I:260).
- V NO option gates it: it sits in the `??` chain unconditionally (I:291-303, no flag). It runs wherever `vectorizeLaneLocal` runs: level 2, 3/'speed', 'fast' (config.js:81, 88, 124, 199); off at 0, 1, 'size' (config.js:70, 71, 130).
- V Position: after tryStencil (I:295), before tryChannelReduce (I:297).

### b. scaffold
- V Its own `matchBlockLoop(blockNode, { multiInc: true })` R:32 (S:248-267): NO preamble allowed (allowPreamble false, S:223-236: any non-loop array content returns null), no `allowInlinedLi`, so no CSE'd-increment recovery. Exit test `matchExitBrIf(loopNode[2], blockLabel)` (S:249): `br_if $blk (i32.eqz (i32.lt_{s,u} (local.get i) BOUND))`. Trailing RUN of `x += C` statements via `matchIncN` (S:252-258); the first run entry named like the exit IV must have c===1 (S:260-261 `increments.find(x => x.name === exitInfo.ind)`; `find` returns the FIRST entry for that name).
- V Private residual R:62 `increments.some(x => x.name !== ivName) return null` (only the IV may be stepped: so strided output pointers are NOT accepted despite the header comment R:20-23).
- V `bl.outsideReads` is not set on this private `bl`; the function uses its parameter `outsideReads` (R:117).

### c. counter / step / bound
- V Unit step IV, ascending. SIMD step = `c * LANES` for every increment (R:336-337). LANES 4, 16 or 64 (R:263, R:274, R:233). Bound: `boundLocal` or `i32.const` only (R:38); bound local not written in body (R:110). Counter starts anywhere (span aligned from entry by `simdBound`, R:341).
- V `lt_u` accepted by matcher, SIMD uses `lt_s` (R:339 `simdLoop` -> S:57). Same as L-T4.

### d. address forms
- V Store address `matchLaneAddr(storeAddr, ivName, addrLocals, offsetTees)` (R:85) must have `strideLog2 === elemLog2` (R:86): `i32.store8` stride 0, `i32.store` stride 2. matchLaneAddr (A:249-266): `[tee] (i32.add BASE OFFSET)` with BASE on the left and OFFSET `local.get i` / `i << K` (K 0..3) / an offset-tee local / (local.tee of those); or `(local.get $A)` for a recorded address tee.
- V NO constant offset, NO memarg: store `length !== 3` -> null (R:59); multi-store `stmt.length !== 3` (R:237); a load with `offset=K` has n[1] string -> matchLaneAddr null -> loadsOk=false (R:98-99).
- V Loads: only `i32.load8_u`, only with `i32.store8`, stride 0 (R:96-99); any other load op -> decline. Pure-ramp (no loads) allows `i32.store8` or `i32.store`.
- V BASE is the raw left operand `a` (A:262) with no invariance test (see L-R2).
- V Only TOP-LEVEL body statements are scanned for stores (R:52-55). Stores inside an `if` are never address-checked (see L-R1).

### e. DEPENDENCE
- V Recognizer-internal proof: NONE beyond the address shape (R has no `aliasGuards`, `distinctParams`, distance computation; imports R:1-6). Each load/store address is exactly `base + i<<K` with no offset, so same base expression => same element index.
- V Distinct-base aliasing delegated to `gateStrips`: R:341 `simdBound(ivName, boundExpr, LANES)` registers the strip (S:80), so index.js:324 can wrap it (AL:345). `found` is set when a strip is gated (AL:344). Per pair: same local base name skipped (AL:285), else `apart(d, S*lanes)` run-time test with lanes = 4/16/64 (AL:322-325; `lanes` = strip's LANES from S:80).
- V Multi-store path (several `i32.store8` in one body, R:226-252) and the u8 widening paths hoist all loads of a statement before its store, in lane groups of 16 bytes: valid only if no store of the strip reaches a load of the same strip at another index. Same-base is same-index; cross-base needs gateStrips' test; both hold under the above.
- V `hasGlobalSet` -> null (R:40). No `hasImpureCall` check in R. liftExprV handles calls only through its own tables (I: it can lift `$math.*` mirrors); an impure call would fail to lift (I).
- V What it does NOT do: it does not treat stores nested in `if` (L-R1), and a mid-body write to the IV is not rejected (L-R3).

### f. local classing
- V `localKind` R:113-123: skip IV (R:115); written -> `laneAccess(body, name, outsideReads)` R:117; 'read' or 'liveout' -> null R:118; else 'lane'; unwritten -> 'invariant'. No 'addr' class.
- V outsideReads consulted: R:117. Carried locals decline. Loop-carried IV-derived locals: declined via 'read'.
- V In the WIDEN16 single-store path the lane temp's `local.set` is dropped from the strip entirely (body.length 1 or 2, R:133-142); safe only because outsideReads declined live-out temps (R:118).

### g. control flow
- V Single-store paths: WIDEN16 requires body.length 1 or 2 with the optional `tw = EXPR; store(tw)` (R:133-142); WIDE16 requires every non-store stmt to be a lane `local.set` (R:259-260). Generic 4-wide path (R:313-328) runs `liftStmt` on every other body statement, which accepts `if` forms (lane-assignment if, predicated if, conditional STORE, L:494-545). Multi-store path: every stmt must be a store or its feeding set (R:252).
- V No `br_if` out is accepted (liftStmt falls to `standalone … statement`, L:548).

### h. trip count / tail
- V `simdBound(ivName, boundExpr, LANES)` (R:341) with LANES in {4,16,64}: strip while at least LANES iterations remain; scalar tail = the ORIGINAL block `blockNode` (R:347). No separate minimum trip test (empty strip when span < LANES, S:75-79 for non-const bounds; for const bound `end = iv + ((bound-iv) & -LANES)`).
- V WIDEN16 uses LANES=64 (R:274): four independent 16-byte groups per trip.

### i. cost test
- V None. No `isProfitable` (R:1-6). Shape-only.

### j. emits
- V i32x4 lanes (ramp `i32x4.add (splat i) [0..3]`, R:264) narrowed with `i8x16.shuffle` (low byte, truncation-exact) or `narrow` when `storeValueIsByte` (R:289-312, R:354-365); or i16x8 widening byte-map, 16 bytes per group, 4 groups (R:186-223, 267-281) when `byteValueRange` proves every node in [0,65535] and result <= 255 (R:151-164). Stores: `v128.store` (16 B), or `i32.store` of lane 0 of the packed vector (4 B) for the 4-wide byte path (R:367-377).

### k. private re-derivations / shared helpers
- Re-implements:
  - recordAddrTees R:75-82 (private, acknowledged in comments A:496-500) [V]
  - the store collection R:51-55 (vs `bl.siteAccess` A:516) [V]
  - the load-address check `checkLoad` R:93-104 (calls shared `matchLaneAddr`) [V]
  - `byteValueRange` R:151-164 (a private u16 interval analysis; no shared range helper used) [V]
  - `storeValueIsByte` R:354-365 (private byte-range test) [V]
  - the "every increment is the IV" check R:62 (residual of multiInc, S:246-247) [V]
- Calls shared: `matchBlockLoop` multiInc (R:32), `matchLaneAddr` (R:78, 85, 98, 238), `laneAccess` (R:117), `bl.offsetTees` (R:34, from BodyModel A:548-554), `simdLoop`+`simdBound` (R:339, 341), `liftCtx/liftExprV/liftStmt` (R:129, 298-325), `constNum/isI32Const/isLocalGet` (R:2). NOT used: `aliasGuards`, `affineIvCoeff`, `indexDefs`, `matchStrideAddr`, `isProfitable`, `stripBlock`.

### l. soundness leads

- L-R1 (medium, plausible shape). A conditional store inside the body is never address- or width-checked, and `liftStmt`'s if-store path emits a 16-byte `v128.store` of i32 lanes.
  R:52-55 collects only top-level stores; `storeStmts` needs >=1 (R:56). Other statements in the generic 4-wide path go to `liftStmt` (R:323). `liftStmt` `if` branch (L:494-545): lane-if and predicated-if decline for a store; `armOf` accepts any `STORE_OPS` last statement (L:506), compares only then/else store ops (L:511), never compares store width with `ctx.laneType` ('i32'), and emits `['v128.store', thenA.addr, bitselect(thenVal, ['v128.load', thenA.addr], mask)]` (L:541-543): 16 bytes of i32 lanes at the scalar-verbatim address. `checkLoad` (R:93) checks loads only. WIDE16 (R:259-260) and WIDEN16 (R:133) exclude an `if`, so it hits only the generic path (needs `!hasLoads`-or-non-eligible value).
  Program: `export function f(o, p, n){ for (let i=0;i<n;i++){ o[i] = i & 255; if ((i & 1) === 0) p[i] = 7 } }` with o,p Uint8Array. Expected: p[i]=7 on even i, others untouched. Lifted: 4 i32 words written as 16 bytes at p+i. Reachable: I think yes (both stores are ordinary). Lead.
- L-R2 (low, shared with tryVectorize): base subtree not checked invariant (A:262 returns raw `a`; R never tests it). A base local written in the body is classed 'lane' (R:116-119), its set lifted to a v128 shadow, address read scalar: stale (same mechanism as L-T2).
- L-R3 (medium-low). IV written in the body outside the trailing run is not rejected: R:115 `if (name === ivName) continue`; `matchIncN` run takes any number of trailing `i += 1`.
  (i) Two trailing increments: body `...; i++` then the loop's own `i++` form the run [{i,1},{i,1}]. R:62 passes (both names equal the IV). S:260 `find` returns the first c===1. R:336-337 then emits BOTH `i += LANES` (two statements) -> the IV advances 2*LANES per strip while the lift handles LANES contiguous elements (R:339). Scalar semantics: `i` advances 2 per iteration, stores at i, i+2, ... Program: `export function f(o, n){ for (let i=0;i<n;i++){ o[i] = i & 255; i++ } }` (Uint8Array o). Expected: even indices only. Lifted: contiguous. Reachable only if jz does not fold `i++; i++` before this pass (unchecked). Lead.
  (ii) A mid-body `i += 1` followed by a statement using `i` in the store address: the set is lifted as a lane local (localKind undefined, L:386-390; `local.get i` reads the ramp, L:686-689), the scalar address keeps the entry `i`. Lead.
- L-R4 (medium-low). Offset-local classing weaker than tryVectorize. `bl.offsetTees` (A:501-505) includes names whose every write is `i<<K`/`i` whether written by a standalone `local.set` or a tee (A:365-398, 476-492). matchLaneAddr then accepts `(local.get $T)` as the offset (A:173-177). tryVectorize marks such i32 locals 'addr' (kept scalar); ramp has no 'addr' class, so a STANDALONE `local.set $T (i<<K)` in the body is a lane local: WIDE16 accepts it (R:259-260 `localKind.get(s[1]) === 'lane'`), lifts its set into `T__v` (R:297-301) and the store's address `(local.get $T)` (verbatim, R:310) reads the scalar `$T`, never set in the strip. Teed forms are fine (the tee sits inside a kept address, R:167-169 comment). Reachability depends on whether jz leaves a standalone offset set in a pure-ramp or u8 loop body; tryVectorize's comment (map.js:~200) says such sets exist. Lead.
- L-R5 (HIGH confidence of wasm semantics, shape plausible). `byteValueRange` admits a constant right shift of exactly 16: R:160 `if (s < 0 || s > 16) return null`, so `s == 16` passes; the value after the shift is [a0>>16, a1>>16] = [0,0] for u16 inputs. liftW emits `['i16x8.shr_u', x, e[2]]` (R:207) with `e[2] = (i32.const 16)`; a wasm i16x8 shift count is taken modulo the lane width (16), so the SIMD shift is by 0 and returns the unshifted value, while the scalar `>> 16` of a u16 is 0. highByte shortcut (R:176-177) only triggers on 8. Fix would be `s > 15`.
  Program: `export function f(o, a, n){ for (let i=0;i<n;i++) o[i] = (a[i] * a[i]) >> 16 }` with o,a Uint8Array. Product <= 65025 in u16, value after shift is 0, lift gives the low byte of the product. Gate chain: store8, one u8 load stride 0, body.length 1 -> `byteValueExpr` R:135 -> WIDEN16 true (R:262). Reachable: I think yes. Lead.
- L-R6 (low). Multi-store lane-temp resolution: R:244 loops `for j < idx` without `break` and keeps the LAST matching `local.set` of the temp; a temp assigned twice before one store takes the later value, but `consumed` marks only that index, so `consumed.size !== body.length` (R:252) declines when an earlier set exists. Safe; noted only.
- Note: the header comment R:20-23 describes strided output pointers (`p += C`); the code rejects them (R:62). Comment is stale.

---------------------------------------------------------------------
## 3. slpPairsIn and hoistReductionInvariantsIn (dot-slp.js)
---------------------------------------------------------------------

### a. file / entry / gates
- V dot-slp.js = 517 lines. Entries: `export const hoistReductionInvariantsIn = (fn, fnLocals, freshIdRef, newLocalDecls)` D:205; `export function slpPairsIn(fn, fnLocals, freshIdRef, newLocalDeclsAll, relaxedFma, slp)` D:497.
- V Both called from `vectorizeLaneLocal` BEFORE the walk (I:172, I:175), on the whole function, after normalization and before any recognizer.
- V hoist: `if (relaxedFloat) hoistReductionInvariantsIn(...)` I:172. `relaxedFloat` option <- driver.js:85 `cfg.relaxedFloat === true`; relaxedFloat is in TUNING_KEYS (passes.js:185), NOT in ALL_ON, set true only in L3_PRESET (config.js:66). So hoist runs at level 3 / 'speed' only (or when the user passes `optimize:{relaxedFloat:true}`); never at level 2, 'fast', 'size'.
- V slpPairsIn is always called (I:175, no outer `if`). Args: `relaxedFma = relaxedFloat && relaxedSimd` (L3 only, config.js:66); `slp = slp && !typedView` with `slp` <- driver.js:93 `cfg.slp !== false` (passes.js:168 PASS_NAMES, in ALL_ON, so true at level 2, 3, 'fast'), `typedView` <- driver.js:96 `!!facts.typedView` (ctx linkDemand typedView, ctx.js:926, set by analyze/trackers.js:34 for `.view`/`.anyview` and typedarray emit handlers).
- V Tiers inside slpPairsIn (D:497-515):
  1. dot-sequence tier `vectorizeStraightLineF64DotPairsIn`: gate only `hasF64Mul` (D:506). NOT gated by `slp`, `typedView`, or relaxedFloat (only the FMA opcode is).
  2. element-store tier: `f64Stores >= 2 && slp` (D:507): `fuseCanonStaging`, `slpStorePairsIn`, `slpPlaceFieldPairs`.
- V `noSimd` sets `slp=false` and `vectorizeLaneLocal=false` (config.js:279; whole pass gone).
- V Levels on: dot tier and element-store tier at levels 2, 3, 'fast'; off at 0, 1, 'size' (pass not run). Hoist at 3 only. FMA (`f64x2.relaxed_madd`) at 3 only.

### b-d. what each matches
**hoistReductionInvariantsIn** (D:205-209, hoistDotInvariant D:172-200)
- V Walks the function post-order; for every `loop` with an array parent (D:207) it scans every statement list inside the loop (D:198) for the unrolled dot shape `matchF64DotSeq` (D:37-50): `acc = f64.const 0` (f64Zero, node-utils.js:14: `Number(n[1]) === 0`, so also `-0`), then exactly DOT_UNROLL=4 steps `acc = acc + (local.get L * local.get R)` (either operand order, matchAccumStep D:13-20), then `out = acc | acc+X | X+acc` (matchDotStore D:22-30). Operands are plain locals; no memory.
- V A product is "invariant" iff both operand locals are f64 and NOT written anywhere in the enclosing loop (isInv D:175, writeSet from `collectWrites(loop)` D:174). Fires only when at least one product is invariant (D:183). Else untouched.
- V Rewrite: `INV = ((0 + tk1) + tk2) + …` over the invariant products in original order, computed once before the loop (parent.splice D:199); in loop `acc = INV; acc = acc + tv …` (variant products, original order); `out = acc (+ addend)` (D:191-193).
- V FP order: reassociated. Original ((((0+t0)+t1)+t2)+t3); new: invariant terms first, then variant terms. Results differ in last bits; this is why it is gated by relaxedFloat (D:159-165). The `0 +` seed is kept for the invariant sum, so the sign-of-zero behaviour of the original `0 + …` is preserved for the INV part.
- V Memory proven: none read or written; hoisted code reads only f64 locals unwritten in the loop. Placed immediately before the loop node (D:199), so values equal the in-loop values.
- V Idempotence on revisit: after `parent.splice` the walker (ast.js:296-306, live length) re-enters the loop node; the rewritten dot no longer begins with an `f64.const 0` reset, so no second match (I).

**vectorizeStraightLineF64DotPairsIn** (dot tier, D:83-145)
- V Matches TWO ADJACENT `matchF64DotSeq` instances `a`, `b` in one statement list (D:95-97) with: same `acc` name, `exprEq(a.left, b.left)`, `exprEq(a.addend, b.addend)`, both outs f64 locals (D:98-99). Replaces both (D:137-142) by `v = dotPairExpr(a.left, pairs)`, `a.out = extract_lane 0`, `b.out = extract_lane 1`, where `pairs[k] = f64x2.replace_lane 1 (splat right_a[k]) right_b[k]` (D:52, 131) memoized per statement list by name pair (D:124-132).
- V Expression: `mul(splat a0, p0)` then `add(expr, mul(splat ai, pi))`, or `relaxed_madd(splat ai, pi, expr)` when `relaxedFma` (D:60-68). Addend: `f64x2.add(dot, splat(addend))`, addend computed ONCE into a temp before the pair (D:109-120).
- V Memory: none (scalar register operands only, D:73-77). No aliasing proof needed or made.
- V FP order per lane: left-to-right as the scalar, without the `0 +` seed. Non-relaxed form is "bit-identical" per the comment (D:56-58) except the sign of zero: see L-D1. Relaxed form: fused, implementation-defined rounding, L3 only.

**Element-store SLP tier** (`slpStorePairsIn`, D:421-462; helpers D:240-412)
- V Matches two `f64.store`s in one statement list within SLP_WINDOW=8 statements (D:240, 428), consecutive slots (`u1.off - u0.off === 8`, D:430), same base per `sameBase` over `windowDefs` (D:432; AC:57-109: resolves tees and locals defined once in the window; any local written in the window that is not defined once resolves to null), high address tees dead (`deadTees`, D:430), no statement between reads/writes what the high value reads or stores (`inertFor(node[j], reads, true)`, strict: no stores, no loads, no calls except pure kernels, no branches, D:439; AC:124-139).
- V Packs the two value trees only if overhead-free (`slpPackF64x2` D:346-384): adjacent f64 loads (same base, offsets 8 apart, AC `sameBase`) -> `v128.load`; a local pair from `slpFieldPairs` (D:279-303) -> its v128; identical pure subtree -> `f64x2.splat` (`slpSplatSafe`, D:247-258: no calls, loads, stores, sets); two NaN-canonicalizing selects -> `v128.bitselect` (D:328-339, 364-371); matching f64 add/sub/mul/div/min/max/neg/abs/sqrt -> f64x2 op (D:237-238, 372-381). Otherwise null (no replace_lane build).
- V Memory/aliasing proof: two obligations stated D:216-229.
  1. Cross-base aliasing: relies ONLY on the module fact `typedView` false (`slp && !typedView`, I:175; "distinct bases own disjoint allocations", D:219-222). No per-site test.
  2. Read-after-write: `slpReadsSlot(u1.value, u0.off)` (D:261-268; call D:440) declines when any `f64.load` in the high value has constant offset equal to the LOW store's offset, through any base (`accessOf(n).off === off`, D:265). It compares the folded constant only, not the dynamic index part: see L-D2.
- V Field pairs: `slpFieldPairs` (D:279-303): two locals each defined once by `f64.load` of consecutive slots, with only inert statements between (`inertFor`, non-strict, D:298); the v128 load is placed right after the second load (D:313); sound because it equals [X, Y] at that point and X, Y have one definition each (I).
- V Value moves: the high value is evaluated up to the low store (before the low store, after intervening inert statements); both stores happen at the low store's position, low then high (D:458). Per-lane f64 ops are IEEE element-wise, so each lane equals the scalar op (D:230-233); order of FP ops within a lane unchanged.

### e. (dependence summary)
- Hoist: none needed (locals only).
- Dot tier: none needed for memory; register dependence between the two dots is NOT checked: see L-D3.
- Element-store tier: module-level no-view fact + constant-offset slot test only.

### f. local classing
- V Hoist: locals "invariant" = unwritten in the loop and f64 (D:175). `acc` is written so never invariant. Not consulted: `outsideReads`; acc remains set in the rewrite, so liveness of acc does not change.
- V Dot tier: removes ALL writes to `acc` of both dots (D:137 splice); no check that `acc` is dead afterwards (L-D4). No `outsideReads`.
- V Element-store tier: `keep` temps refilled from lanes (D:457); `deadTees` / `getCounts` read counts across the function (D:149-155); no `outsideReads`.

### g. control flow
- V Dot tier and hoist match within any one statement list (any block/then/else/loop body, D:85-94; hoist D:198). Element-store tier: one statement list, statements between must be inert (no branches, D:439; AC:48 BRANCH_OPS).

### h. trip count / tail
- V Not loop vectorizers: no strip, no tail, no trip logic. They rewrite straight-line code (and the hoist moves invariants before loops).

### i. cost
- V No cost model. Element-store tier is "overhead-free only": packs only when no `replace_lane` is needed (D:230-233), so it cannot grow code. Dot tier: unconditional once the shape matches (it adds a `replace_lane` per pair, D:52).

### j. emits
- V f64x2 (v128 locals `$__dot2_N`, `$__dotpair_N`, `$__dotadd_N`, `$__slpN`, `$__slppN`, `$__slpcN`); v128.load/store (`memarg`, AC:44), `f64x2.*`, optional `f64x2.relaxed_madd`.

### k. private re-derivations / shared helpers
- Calls shared: `collectWrites` (D:2, D:174), `walkAst`, `nodeEqual`, `nodeKey` (D:1), access.js model (`accessOf`, `sameBase`, `windowDefs`, `inertFor`, `deadTees`, `localReads`, `localGetCounts`, `memarg`, D:3), node-utils (`f64Zero`, `forEachLocalDef`, `localGetName`, D:4). Not used: scaffold, `matchBlockLoop`, `alias.js`, `gateStrips` (no strip is registered; gateStrips cannot gate these), `cost-model`, `laneAccess`, `outsideReads`.
- Re-implements: invariance test `isInv` D:175 (own; vs `isInvariantBase` A:278 / AL `invariant` AL:217); own tee-resolving address model (access.js) instead of `matchLaneAddr`; own statement-inertness test (`inertFor`) instead of `hasSideEffect` (A:628) [V as to existence].

### l. soundness leads

- L-D1 (low-medium, bit result). Dot tier is not bit-identical to the scalar for `-0`. Scalar chain starts `acc = +0; acc = acc + t0` (D:39 reset matches +0 and -0), i.e. `+0 + t0`; packed starts `f64x2.mul(splat a0, p0)` with no `+0 +` (D:61). If all four products are `-0`, scalar sums to `+0` (`+0 + -0 = +0`), packed gives `-0`. The header claim "bit-identical" (D:56-58) is false for that case. Applies at levels 2 and 3 (the non-relaxed form). Needs an unrolled `acc=0; acc+=…x4` pair in jz IR (mat4-shaped). Program idea (shape unverified): two adjacent 4-term dots over locals loaded from typed arrays with inputs `[-0,-0,-0,-0] * [1,1,1,1]`; observe with `1/r`. Lead.
- L-D2 (medium, plausible). `slpReadsSlot` compares only the constant offset of loads (D:265), but the pack hoists the high value's loads above the low store (D:437-443). A high value that loads through a DIFFERENT base expression with a different dynamic index, which at run time equals the low store's slot, passes the test. Cross-base aliasing is assumed away by `!typedView` (D:219-222), but two parameters may be one array (the comment itself notes `multiply(m, m, x)`, D:226).
  Program (needs jz to fold `[j+1]` into `offset=8` so `accessOf` sees off 8; shape unverified): `export function f(o, a, i, j){ o[i] = a[j] * 2; o[i+1] = a[j+1] * 2 }`, Float64Array, call `f(x, x, 5, 4)`: scalar writes o[5] then reads a[5] (new value); packed `v128.load a[4..5]` reads old a[5]. Mismatch iff `accessOf` gives the loads off 0 and 8 vs the store's off 0 (so no hazard flagged). Lead; reachability depends on the emitted offset folding.
- L-D3 (medium-low). Dot tier: no check that the SECOND dot's operands do not read the FIRST dot's output (or that `a.out` is not one of `a.left`). Conditions checked D:98-99 are acc name, left equality, addend equality, f64 outs. The pair vector reads `b.right[k]` BEFORE `a.out` is assigned (prefix, D:131; splice D:137-142), and `b.left` equals `a.left` by `exprEq`. If `a.out` is `b.right[k]` (second dot consumes the first's result) or `a.out` is in `a.left`, the packed form reads the stale value. Reachability: needs two adjacent unrolled dots where the second reads the first's result. Lead; shape unverified.
- L-D4 (low). Dot tier drops every write of `acc` (D:137) without a liveness check; `matchDotStore` accepts `out = acc + acc` too (D:26-27 takes `e[2]` as addend even when it is `acc`), and then `prefix = local.set tmp (local.get acc)` (D:118) reads `acc` BEFORE the dot. Any later read of `acc` outside the matched store sees an unset value. jz names acc a fresh temp per unrolled dot, so I expect it unreachable; unverified.
- L-D5 (low). Addend equality is syntactic (D:98 `exprEq`), and the addend is evaluated once into a temp (D:112-118, `addendTemps` keyed by `nodeKey`, reused by LATER pairs in the same list D:110-117). The scalar form evaluates it twice, each time after its own dot. An addend containing a call (non-pure) or a load would be evaluated once, early; and a reused temp (same key, a later pair) keeps the value computed at the first pair even if an addend local was rewritten between the pairs. Same for `pairTemps` keyed by right-operand NAMES (D:124-131): a later pair with the same names reuses a v128 built earlier, stale if those locals were rewritten in between. Nothing in D:94-102 checks writes between pairs. Lead; reachability depends on mat4-shaped specimens (reused right cells across rows while an `out` cell aliasing a right cell is written between).
- L-D6 (low). Hoist: a product whose operand is `acc` itself (`acc = acc + acc*y`) is classed variant (acc is written, D:175) but the reordering changes the value of `acc` seen by that step, not just rounding (D:191-192). `matchAccumStep` accepts it (D:13-20: `matchF64MulLocals` takes any two locals, including `acc`). Fires only if another term is invariant. Unlikely source shape. Lead.
- L-D7 (low). Hoist `-0` seed: reset matches `-0` too (f64Zero), but INV and rewritten acc start from `+0` (D:185 `['f64.const','0']`), differing from the original `-0 + t0 = t0` when t0 = `-0`. Relaxed tier only. Lead.

---------------------------------------------------------------------
## Cross-cutting notes
---------------------------------------------------------------------
- V `gateStrips` coverage: tone-map and ramp both register through `simdBound` so `gateStrips` gates them (index.js:324); the dot-slp passes register no strip and never see it.
- V Neither tone-map nor ramp uses `aliasGuards` (same-base distance with offsets), because their address forms have no offsets; both therefore rely 100% on (shape) + (gateStrips).
- V Neither tone-map nor ramp calls `isProfitable`; both are shape-only.
- V Both consult `outsideReads` through `laneAccess` (T:181, R:117). The dot-slp passes do not.
- V Shared hole between recognizers: `matchBlockLoop`/`bodyFacts` never reject a body write of the IV (S:176-184); tone-map blocks it incidentally (T:448), ramp and (I) tryVectorize do not.


---

# Appendix B3: prefilter, pair-iterations, strength-reduce, hoist-splats, counter-run retry (Sonnet 5.5 agent, `map-parts/group3.md`, verbatim)

# group3: prefilter, pair-iterations, strength-reduce, hoist-splats/hoist-consts, counter-run retry

Worktree: /Users/div/projects/jz/.claude/worktrees/agent-a874443978e8f17a0 (paths below relative to `src/optimize/` unless absolute). V = read the code, I = inferred.

## Common gating (V unless marked)
- `vectorizeLaneLocal` step: driver.js:82-98. Flag `cfg.vectorizeLaneLocal` (pass name, passes.js:97). Level 0/1: off (config.js:69-70 ALL_OFF / L1 list has no it). Level 2: on (L2_PRESET = ALL_ON + overrides, config.js:67, no override of it). Level 3 / 'speed': on (config.js:66, 199). 'fast' = L2 shapes: on (config.js:88). 'size': off (config.js:130). `noSimd` forces off (config.js:279).
- `pairIterations` option: driver.js:95 `cfg.pairIterations === true`; passes.js:166 PASS_NAMES entry; L2_PRESET false (config.js:67); L3_PRESET inherits ALL_ON true (config.js:66); size false (config.js:158). So ON only at level 3 / 'speed'.
- prefilter, strength-reduce, hoistStripSplats, counter-run retry have NO option of their own: they run whenever `vectorizeLaneLocal` runs (levels 2, 3, fast). hoistStripSplats' header says "speed tier" (hoist-splats.js:2) but nothing gates it to level 3 (index.js:326 unconditional) (V).
- hoistVectorConsts: tuning key (passes.js:203), NOT in PASS_NAMES so not in ALL_ON; L3_PRESET sets it true (config.js:66); L2/size do not set it (I: undefined = off).

---------------------------------------------------------------------------------------------------
## 1. tryPrefilter (prefilter.js)

a. prefilter.js, 163 lines (wc). Entry `tryPrefilter(bl, fnLocals, freshIdRef)` prefilter.js:123. Called index.js:327 `if (!r) r = tryPrefilter(bl, fnLocals, freshIdRef)`, i.e. also when a chain recognizer matched but `gateStrips` nulled r (index.js:324) (V). No own option; levels 2, 3, fast. `fnLocals` unused in the body (V, no reference in 123-163). `bl.outsideReads` exists (index.js:264) but is not read (V).
b. Scaffold: `bl` = `matchBlockLoop(node,{allowPreamble,allowInlinedLi})` (index.js:232): default envelope, step must be +1 (scaffold.js:301-303) or the CSE'd `x = $t` form (scaffold.js:306-312). Body must be exactly one statement: `if (body.length !== 1) return null` (prefilter.js:127), `(if COND (then ...))`, no else, length 3 (129).
c. Counter `incVar` from bl, step +1 (V). Bound: `i32.const` or a local (`!boundLocal && !isI32Const(bound)` null, 126). Exit comparison signedness is NOT looked at: matchExitBrIf accepts `i32.lt_u` too (addr-model.js:41, returns only {ind,bound}); the scan uses signed `i32.ge_s` (prefilter.js:148) and `simdBound` signed (scaffold.js:72-77). See lead L1.
d. Loads: only the FIRST TEST of the guard is lifted: `firstTest` (51-65, unwraps `if (result i32) (cond) (then ..)(else 0)` chains, and the value-preserving `else (local.get t)` form with `tee t` cond, recording `zeros`) then `laneTest` (86-107). Test forms: bare load (!=0), `cmp(load,const)` either order, `eqz(load)`. Loads in `LANES` (31-37): i32.load8_u/s, load16_u/s, i32.load; constant must be in the element's range (97); `_u` compare of sign-extended narrow element rejected (99). Address: outer `local.tee`s stripped (101-102), then `affine(addr,x,stride,writes)` (68-83): sum of consts/globals/locals not written by the stmt, with coefficient of `x` exactly `stride` (shl/mul by consts allowed). No stores in the lifted part.
e. DEPENDENCE: none needed and none proven. It reorders nothing: the vector test runs on memory in the state the scalar loop has at x; where no lane holds, the scalar loop would have run no statement (no effects); where a lane holds, the real statement runs from `x+ctz(m)` to `stop=x+lanes` tests included (prefilter.js:152-157), then the span is re-scanned with a fresh v128.load. Stores of the guarded body never meet the vector load of the same span before its lanes are re-tested scalar. `gateStrips` is NOT applied to the result (index.js:324 is before 327; no gate after) (V). `simdBound` does register a `strips` entry on the end-limit node (scaffold.js:80, via prefilter.js:160) but nobody gates it (V); lead L2 (I): an enclosing lift's `gateStrips` walks `gate(wrapper)` over its embedded `node`, which would find this registered strip. Outer recognizers bail on an inner wrapper, so probably unreachable.
f. Locals: `writes` = every local written anywhere in the stmt (136-137); only used (i) bail if counter or boundLocal written (138), (ii) `affine` rejects an address term in `writes` (73). No carried/private classification. Skipped spans omit the scalar test's writes: `zeros` locals reset to 0 (150), but a tee'd address temp stripped at prefilter.js:101-102 is never written in a skipped span ("the lanes write no local", comment 100). outsideReads is NOT consulted (V). Lead L3.
g. Control flow: guarded part (stmt[2]) must be "heavy": contains call/call_indirect/loop (131-134); no global.set in guarded (134); `staysInside` (110-121): no return/return_call*/throw/rethrow/try*, br/br_if/br_table only to labels declared inside. The test part (stmt[1]) is not scanned for global.set/branches beyond `firstTest` shape.
h. Trip/tail: lanes 16/8/4 by load width. `end = simdBound(incVar,bound,lanes)` (160) = x + ((bound-x) & -lanes), guarded by select when bound not a safe constant; scan loop 146-158; original `blockNode` is the remainder (161), re-running its own preamble (preamble cloned ahead at 159 as well). No min trip count.
i. Cost test: none from cost-model.js. The proxy is "heavy body behind the test" (131-134, comment 26-27).
j. Emits `(block preamble.. (local.set end ..) (block brk (loop pf: br_if x>=end; mask=bitmask(test); if !mask {zeros=0; x+=lanes; br pf}; stop=x+lanes; x+=ctz(mask); (loop in: STMT; x+=1; br_if x<stop); br pf)) blockNode)` (146-162). Locals end/stop/mask i32 (162). Counts as simdFired (index.js:341).
k. Private re-derivations: `affine` (68-83) vs `affineIvCoeff` addr-model.js:285 / `linearIndex` alias.js:22; `staysInside` (110-121) vs `hasBranchOrReturn` addr-model.js:606 / outer-scaffold.js `branchesTo`; `writes` scan (136-137) vs `collectWrites` addr-model.js:50 (and bl.writes, scaffold.js:183); `LANES` table (31-37) vs lane-tables.js `LANE_INFO`/`LOAD_OPS` (lane-tables.js:3, 15); `COMPARE` vs lane-tables.js `LANE_COMPARE` (lane-tables.js:242).
l. Leads:
 - L1 (lead, I): unsigned exit. `bl` can come from `for(...; (x>>>0) < n; ...)`-style `i32.lt_u`; prefilter scans with signed compare, so with x<0 (huge unsigned, scalar loop exits at once) the scan would run the statement. Program (exact emission of lt_u untraced): `export let f=(a,n)=>{let c=0;for(let x=-1;(x>>>0)<(n>>>0);x++){if(a[x+1]===1&&...) c+=g(x)};return c}` (needs a call/loop in the guarded body). Reachability: low; also applies to every `bl` consumer that assumes signed.
 - L3 (lead): address-tee temp skipped. Body `if (u8[(t = r + x)] === 1 && ...) call(t)`; skipped spans never write `t`; a read of `t` after the loop (outsideReads not consulted) sees an older value when the whole range is skipped. Reachability: low (jz CSE scratch is not normally live-out; I).

---------------------------------------------------------------------------------------------------
## 2. tryPairIterations (pair-iterations.js)

a. pair-iterations.js, 371 lines. Entry `tryPairIterations(node, fnLocals, freshIdRef, op, outsideReads, enabled)` (161). Called index.js:329 only if `r` is null; `enabled` = option `pairIterations` (index.js:108; driver.js:95); level 3 / 'speed' only (see Common). `op` = `matchOuterPixelLoop(node)` (index.js:271). Result passed through `gateStrips(paired, node, ...)` (index.js:330). Not a lane lift: it does not set simdFired (index.js:341 runs before 342 `if (paired) r = paired`) (V).
b. Scaffold: outer-pixel envelope `matchBlockLoop(..,{envelope:'pixelIV'})` (scaffold.js:191-208: labeled block; preamble = only `local.set` of ANY value, no hasSideEffect check, scaffold.js:201; one loop; nothing after) + `matchOuterPixelLoop` (outer-scaffold.js:121-188): trailing run of `v += 1` pixel IVs (i32 or f64, outer-scaffold.js:75-82, 142-148), exit `IV < WIDTH` (i32.lt_s/lt_u or f64.lt, :99-105), width = const or local/global unwritten in the loop (:150-155), `obody` (between exit and IV bumps) must not branch to the outer block/loop label (:160-165). Inner loop: `findInner` (74-101): exactly ONE loop in obody (76-77), as the last child of a labeled `block $b` (labeled loop, no result/param, 82-88), directly in obody or under nested `if` arms (typed/labeled ifs rejected, 53-62; loop in an `if` condition rejected, 91).
c. Counters: pixel IVs step +1 (i32 or f64) (outer-scaffold.js:75-82); width bound as above. Paired loop condition `iv+1 < width` using `oExit.cmpOp` (i32) or `f64.lt` (pair-iterations.js:356-359); all pixel IVs bumped by 2 (361-363). Lane B reads pixel IVs +1 (`bumpPixelIV`, 285, outer-scaffold.js:170-176).
d. Addresses: not analysed for form. Only base ROOTS: `rootsOf` (146-154) = all local.get/global.get names under the store address (past single-def local copies, 8 deep), and under load addresses (`n[n.length-1]`, 255).
e. DEPENDENCE (what is proven; items independent):
 1. `NO_PAIR_OPS` (40-42) and non-`$math.*` or `$math.random` calls (180) and variable divisors / trapping truncs (181, 41-43) reject; branches must stay in own labels (189).
 2. Stores only after the inner loop: `storeEarly` (252-267): `scanMem(s, early)` flags any store in X, Y, statements before the inner block at any level, the other arm, or an arm's cond. `if (storeEarly) return null` (267). So within a lane every store is in `post`; lane order A.post then B.post keeps store/store order.
 3. Store roots vs load roots by NAME: `for (const r of storeRoots) { if (loadRoots.has(r)) return null; ... if (W.has(name)) return null }` (269-273), after dropping pixel-IV roots (268). Roots are over every local/global read in the address, so it is conservative for shared names, but two different NAMES for one array are not caught here.
 4. Different names: run-time `gateStrips(paired, node, fnLocals, distinctParams, pointerOf)` (index.js:330). `stripBlock(paired, iv.name, iv.type==='f64' ? null : widthBound, 2)` (pair-iterations.js:369) registers the strip (`strips.set`, scaffold.js:68) so `gateStrips` wraps it `if (test) paired` (alias.js:345). gateStrips pairs every store with every other access of the whole outer body (alias.js:280-297): `distinctParams` (`separate`, alias.js:275-278), two pointers need `P != q` test (289-292), else byte-interval `below()` test (alias.js:305-313, 330-332) which needs `bound` (f64 IV: `if (!bound) return null`, alias.js:330 -> declines). Same raw base is SKIPPED by gateStrips (`if (s.raw && s.raw === st.raw) continue`, alias.js:285), covered here only by item 3 (store root = load root rejected) and item 2 (store/store order kept).
 5. Early return: no stores at all -> gateStrips returns r (alias.js:214).
 Not proven: trap ordering (see l).
f. Locals: `W` = all locals written in obody (173-185). Must not be pixel IVs (190); `outsideReads.has(x)` -> decline (191) (V, consulted); must be in fnLocals (191); `itemPrivate(obody, W)` (106-143) requires every read of a W local to follow a write on every path of the same item (branch exits meet via `exits`), loops walked once with entry state; fail -> null (246). Lane B gets renamed copies `${x}__pi${id}` (279-281, 291) and renamed labels (281, 292). Non-W locals are shared read-only.
g. Control flow: if/block/loop, br/br_if to own labels only (189), inner block's branches all inside it (197-201), no label shadowing (193-195). Float-recurrence heuristic (below) is profitability, not soundness.
h. Trip/tail: pair loop runs while `iv+1 < width`, bump 2; `wrapper = block(preamble clone, paired, node)` (370): original `node` runs the rest (odd last item); its preamble runs a second time. Jam loop: both lanes' inner steps run until both inactive (350-353). No min trip.
i. Cost test: none from cost-model.js. Structural heuristic: an f64 local the inner loop reads before writing that is not a +const counter (217), taint closure (222-237), and a `br`/`br_if` to the inner block/loop label under a test of a tainted value (238-245), else null; size cap `MAX_NODES = 12000` over obody (50, 165-166).
j. Emits, per lane k, `pre` (statements before the inner loop, `on`/`cv` flags per `if` level), `step` (one inner-loop iteration under `act`), `post`; then `block po (loop pl: br_if !(ahead); A.pre; B.pre; jam; A.post; B.post; bumps; br pl)` (348-368). New locals: act/cv/on per lane, renamed W copies (decls).
k. Private re-derivations: `isStore`/`isLoad` regexes (44-45) vs lane-tables.js `STORE_OPS`/`LOAD_OPS` (lane-tables.js:15, 20); `itemPrivate` (106-143) vs `readsBeforeWrite`/`laneAccess` (addr-model.js:82, 70); `rootsOf` (146-154) vs alias.js `baseOf`/`addressFacts` (alias.js:242, 146); `hasLoop`, label scan (176-187) vs outer-scaffold.js `branchesTo`; written-set scan (176-187) vs `collectWrites` (addr-model.js:50); branch-target containment (189, 197-201) vs `hasBranchOrReturn`.
l. Leads:
 - L4 (lead, I): preamble run twice. 'pixelIV' envelope accepts any `local.set` as preamble with no `hasSideEffect` (scaffold.js:201; contrast scaffold.js:235), and the wrapper clones it ahead of `paired` and `node` re-runs it (pair-iterations.js:370). Harmless for LICM-pure preambles; a preamble value with a side effect or reading a local a call-free obody later changes would differ. Reachability: low (I: LICM emits pure values).
 - L5 (lead): trap/partial-effect order. Lane B's loads and divisions-by-const-free arithmetic run before A's stores; an OOB load in B traps before A's pixel stores, where scalar stores A's first. Not covered by any check (NO_PAIR_OPS does not list loads). Program: `export let f=(o,n)=>{for(let q=0;q<n;q++){let x=0.3*q,k=0;while(x<4){x=x*x+0.1;k++}; o[q]=k + src[q+1]}}` where `src[q+1]` is OOB only at the second item. Reachability: only observable through a trap; low.
 - L6 (lead): two names for one array where roots differ and `distinctParams` claims separation: relies wholly on `fn.distinctParams` (index.js:131-132) and `arrayPointers`; same trust as other recognizers.

---------------------------------------------------------------------------------------------------
## 3. tryStrengthReduceIV (strength-reduce.js)

a. strength-reduce.js, 81 lines. Entry `tryStrengthReduceIV(bl, fnLocals, freshIdRef)` (32). Called ONLY from the deferred loop index.js:378-382 (candidates pushed at index.js:357 when `r` is null and `bl` non-null). Skipped if the node lies in a SIMD-consumed subtree (`srConsumed`, index.js:347, 379) or its slot changed (379). No option; runs with `vectorizeLaneLocal` (levels 2, 3, fast) (V). Comment says "speed levels" (strength-reduce.js:30) but level 2 also runs it (V config).
b. Scaffold: `bl` default (allowPreamble, allowInlinedLi) with `bl.preamble.length` must be 0 (36). Single +1 IV, bottom increment (scaffold.js:301-303; CSE'd form 306-312).
c. Counter +1; bound any shape, not inspected (comment 33-34). Exit test not scanned (loop starts at index 3, line 52). Bumps by `1<<k` after `incIdx` (79) which is only equal to the counter step when the IV step is +1 (V via matchIncN c===1, scaffold.js:303).
d. Address forms: `matchAffineAddr` (11-18): `(i32.add (local.get B) (i32.shl (local.get i) k))`, k in 0..3, or `(i32.add B i)` (k=0), either operand order; via `matchLaneAddr(..., allowTee=false)` (addr-model.js:249-266, matchLaneOffset 173-210 with tee-free) so no tee node is replaced; base must be a plain `local.get` ≠ i (15). Only loads/stores are NOT specially treated: ANY `i32.add` node of that shape in the body (including nested loops, any non-memory use) is rewritten (inspect 44-51).
e. DEPENDENCE: none needed (scalar rewrite, order untouched). Soundness rests on invariance: `written` = every local set/tee in body statements [3, incIdx) (48, 52); bail if `written.has(incVar)` (53); base must be i32 and not written (58); bail on any `br`/`br_if` targeting the LOOP label anywhere in the body (47) (a `br_if` to the block label is allowed, loop is exiting). Memory/aliasing irrelevant.
f. Locals: new i32 pointer locals `$__iv{id}_{n}` (72), init before the block (75) as `base + (i<<k)` (at entry value of i), bumped after the increment (76, 79). The IV itself keeps its own value, so a read of i after the loop is unaffected; no outsideReads needed (V reasoning); pointer locals are fresh. Not registered in fnLocals (I: harmless).
g. Control flow: anything except a branch to the loop label (47). Early exits, nested loops, calls fine.
h. Trip/tail: none (scalar loop keeps its exit test).
i. Cost test: none (grouping by (base,k), always applied, comment 24-27 "~6% faster").
j. Emits `(block (local.set p (i32.add base off))... blockNode)` with each matched address replaced by `(local.get p)` and `p += 1<<k` inserted at `incIdx+1` (66-80). Returned wrapper replaces the node (index.js:381).
k. Private re-derivations: `written` scan (48) vs `bl.writes` (scaffold.js:183, same range, already computed); `matchAffineAddr` is a thin wrapper over matchLaneAddr (acknowledged, 10).
l. Leads:
 - L7 (lead, I): CSE'd increment recovery (scaffold.js:306-312) accepts `x = $t` when a tee `$t = x+1` exists ANYWHERE in the body (`m.some(findInc1)` recursion, includes a conditional arm). If `$t` is tee'd on one arm only, x's real step is not +1, yet strength-reduce bumps `p` by `1<<k` per iteration. Affects every `bl` consumer. Reachability: low (I: CSE only emits dominating tees); no minimal JS known.
 - No other soundness issue found: replaced node never contains a tee (allowTee=false), `i` unwritten, base unwritten.

---------------------------------------------------------------------------------------------------
## 4. hoistStripSplats (hoist-splats.js) and hoist-consts.js

### hoistStripSplats
a. hoist-splats.js, 154 lines. Entry `hoistStripSplats(wrapper, freshIdRef, outsideReads=null)` (40). Called index.js:326 on EVERY accepted lift's wrapper (chain lifts and counter-run retry lifts), after `gateStrips` accepted it (324). Not applied to prefilter or pair-iterations results (V: line 326 is `if (r)` before 327/329). No option; levels 2, 3, fast.
b. Wrapper shape it hunts: labeled `block` with a `loop` child whose `loop[2]` is `br_if $block cond` (length 3) and whose body contains any vector op (`VECTOR` regex, 34, 44-49). Walks the whole wrapper (nested strips, not only top).
c/d. n/a (no counter/address matching of its own beyond `STORE_OPS` address operand, 112).
e. DEPENDENCE: uses the claim that gateStrips already ran: header 11-21. Moves a splat's operand out only when: operand not `plain` (so LICM could not do it) (116, 128-132); every pass runs it (`every`, 91-125; control ops evaluate children with every=false, 101); operand is an expression of locals the strip never writes (`!written.has`, 94) or of chosen `env` copies (straight-line scratch tracking, 96-100), globals not `global.set` in the strip (95). Loads in the operand additionally need `!effects && !movelessStore` (134): `effects` = call_indirect/call_ref/memory.*/non-`$math` call (84); `movelessStore` = a store whose address evaluates to a strip-invariant expression (112). Stores at MOVING addresses vs the hoisted load are NOT checked here: relies on gateStrips (alias.js:216-334: motion-0 access vs store bytes tested at strip open) plus the recognizer's own same-base proof, because gateStrips skips same raw base (alias.js:285). I: this reliance is the soundness boundary; a recognizer with weaker same-base proof than gateStrips assumes would be exposed.
f. Locals: new v128 locals `$__hs{id}_{n}` (141), deduped by `nodeKey` (138-143). A tee inside the moved operand: its write is kept (`kept`, 149) only if read in a strip, early (outside any loop / a non-strip loop reading it before writing, 55-66), or `outsideReads?.has(t)` (68) (V, consulted when passed; index.js:326 passes it).
g. Control: moved splat runs after a re-evaluated copy of the strip's exit test (`block.splice(at,0,['br_if',label,clone(cond)],...sets)`, 151-152): read happens only where the first pass would run it.
h/i. Trip/tail: unchanged. No cost test (any non-plain splat moves).
j. Emits `local.set $__hs.. value` before the loop, splat site becomes `local.get`.
k. Private: own `PURE` op regex (36) vs lane-tables.js `LANE_PURE`; `LOAD_OPS`/`STORE_OPS` are imported (good); own `written` scan (82) vs `collectWrites`.
l. Lead L8 (lead, I): a load operand's hoist soundness vs a store with a moving address to the same array depends on the recognizer having rejected the same-base pair; untraced per recognizer. Plain-JS shape to test: `function f(o,n){for(let i=0;i<n;i++) o[i]=o[0]*3+i*0.5}` (should stay scalar, per recognizer; hoisting `o[0]` would be wrong).

### hoist-consts.js (hoistVectorConsts)
a. hoist-consts.js, 94 lines. Entry `hoistVectorConsts(module)` (39). NOT called by vectorizeLaneLocal and NOT by hoistStripSplats. Called by watr-tail.js:722 as TAIL step `['hoistVectorConsts', ...]`, registered `P('hoistVectorConsts','tail','+hoistVectorConsts',{last:true})` (pass-table.js:225), after watr (comment hoist-consts.js:10-13). Flag: tuning key `hoistVectorConsts` (passes.js:203): on at level 3 / 'speed' (config.js:66); off at 2 and size (I).
e. DEPENDENCE: none; a `v128.const` is pure. Rewrites each costly constant (not all-zero/all-ones, `cheap` 28-36) inside a loop body (not inside a nested loop, 61) to `local.get $__vcK`, with `local.set $__vcK <const>` spliced before that loop in its statement list (73-85; loops not in a `func/block/loop/then/else` list are skipped, 78). One local per distinct constant per function, always the same value, so reuse across loops is sound; names avoid collisions (45-53). Locals declared after export/type/param/result/local decls (89-91).
l. No soundness lead found (set executes even for a zero-trip loop; pure).

---------------------------------------------------------------------------------------------------
## 5. canonicalizeCounters retry (counter-run.js, index.js:307-321)

a. counter-run.js, 140 lines. Entry `canonicalizeCounters(node, fnLocals, freshIdRef)` (55) -> `{ node: copy, setup, landing, decls }` or null. Runs only `if (!r)` after the 12-recognizer chain (index.js:307). No option; levels 2, 3, fast. Arguments to the retry: `cbl = matchBlockLoop(canon.node,{allowPreamble,allowInlinedLi})` (index.js:309) with `cbl.outsideReads = outsideReads` (312); decls added to fnLocals (311).
b. Scaffold: `matchBlockLoop(node,{allowPreamble,allowInlinedLi,ivRun:true})` (counter-run.js:56; scaffold.js:274-299): trailing run of `x = x + (const | local)` statements; exit counter once with step 1, other counters any const step or a local never written in body (scaffold.js:286-295); `ivs` non-empty or null (57). Retry re-matches the rewritten copy with the DEFAULT scaffold (single +1 IV).
c. Counters: secondary counters need `i32.const` nonzero step (61), i32 local (61), never written (set/tee) anywhere in the body (63-65). Exit counter: +1, any bound (the run matcher does NOT check the bound's locals; see lead L9).
d. Addresses: `cursorAddr` (24-48): `base + ((op + k) << s)` (shl optional, either operand order), base `invariant` = only consts/global.get/add/sub/shl/mul and `local.get` not in `writes` (26-32). Rewritten as `P + (i<<k')` where `P = base + ((B+k)<<s)` computed once in setup (115-125) and `k' = log2(c<<s)` only for a positive power of two stride (117, 126-127); otherwise falls through to the generic substitution `op` -> `B + c*i` (132-134). Handles `tee`-wrapped addresses (112-115) and CSE'd shl temps (73-90).
e. DEPENDENCE: the rewrite proves `op = B + c*i` inside the body (B = op - c*i at entry; the body holds no branch/return `body.some(hasBranchOrReturn)` null, 59; so the block exits only via the exit test where the relation holds). It proves no memory dependence. The retried recognizers prove their own; then `gateStrips(r, scalar=canon.node, ...)` (index.js:324) tests bases at run time. New bases P1, P2, ... are plain locals set before the block (setup), not in `canon.node`, so gateStrips reads them as loop-invariant leaves (alias.js:241) and tests P - Q apart (apart, alias.js:201-205 / below test). Different offsets of one array (`out[op]`, `out[op+1]`) get different P (key `[base,k,s]`, 118) so recognizers see "different bases" and gateStrips decides at run time (I, by reading).
f. Locals: step statement deleted from the copy (101-105); secondary counter not written in loop afterwards; landing `op = B + c*i` after the block (100, 319 `...canon.landing`), unconditionally, with the final `i`, so a read of `op` after the loop is right (V) (no outsideReads needed). Temps `t = tee(shl(op,k))` are inlined and the tee dropped (82-90) (lead L10). `cbl.outsideReads` is passed to the lifts for the other locals.
g. Control: none allowed in body (59).
h. Trip/tail: from the retried lift; scalar tail is the rewritten `canon.node` (index.js:319 `scalar = canon.node`).
i. Cost: none of its own; the lift's.
j. Emits `['block', ...setup, lifted.wrapper, ...landing]` with `newLocalDecls = [...canon.decls, ...lifted.newLocalDecls]` (index.js:319); original `node` is dropped. Not retried recognizers: tryDivergentEscape, tryStencil, tryRampMap, tryChannelReduce, tryOuterStripRest, tryToneMap, tryGeneralStencil, tryGatherMap. Retried (index.js:313-318), in order: tryMemCopyFill(cbl), tryVectorize(cbl,..pureFuncMap,constLocals), tryGeneralMap(canon.node,.., cbl, {aliasVersion}), tryReduce(cbl, multiAcc), tryGeneralReduce(cbl, multiAcc). (V)
k. Private: own `cursorAddr`/`index` (24-48) vs `matchLaneAddr`/`matchStrideAddr` (addr-model.js:249, matchStrideOffset 329); own `invariant` (26-32) vs `isInvariantBase` addr-model.js:278; own temp inlining (73-90) vs `indexDefs` (addr-model.js:308, which does check outsideReads and single def at top level).
l. Leads (all untraced against a real lift unless stated):
 - L9 (lead, likely reachable if emitted): exit test reads a secondary counter. Nothing rejects `bound` reading `op` (scaffold.js:296-298 does not check; counter-run.js:57-66 does not check `run.bound`). The rewrite deletes the step of `op` and visits only `loop[3..]` (137), so the exit test at loop[2] keeps reading a never-updated `op`, and `cbl` no longer lists `op` in `writes` (default scaffold, scaffold.js:183) so a lift can treat `op` (boundLocal) as invariant. Program: `export let f=(n)=>{const a=new Int32Array(64);let op=n|0;for(let i=0;i<op;i++,op+=-1)a[i]=i;return a[0]+a[63]}` with n=100: scalar writes a[0..49]; rewritten stale bound makes it run to 100. Needs jz to emit `op+=-1` as `i32.add` const and tryVectorize to take `a[i]=i` (I). The same failure with bound `i32.sub(n, local.get op)` is stopped only where a recognizer demands a local/const bound.
 - L11 (lead): block preamble vs setup order. Wrapper is `block(setup, lifted.wrapper, landing)` (index.js:319) and `lifted.wrapper` carries the preamble clone, but `setup` reads `base`/`op`/`i` BEFORE the preamble runs. `invariant(b)` accepts any local not written in the body (counter-run.js:29), including a `$__li*` base defined in the block's preamble (allowInlinedLi accepts any pure local.set, scaffold.js:234-236; SAFE_OFFSET_CALLS includes pointer decode). Then `P` uses the stale `$__li`. Program shape: `export let f=(o,n)=>{let op=0;for(let i=0;i<n;i++){o[op]=i;op+=2}}` where `o`'s decoded base is hoisted as a block preamble local (I: depends on LICM emission; dasum-style tests suggest the common emission keeps bases outside the block).
 - L12 (lead): `invariant()` accepts the EXIT counter `i` inside the base (`writes` excludes incVar, because incVar is only in the removed run, scaffold.js:289-298), so an address `(base + (i<<2)) + (op<<2)` is rewritten as `P + (i<<k)` with `P` computed from `i` at entry: the `i` term in the base is lost. Program: needs emission as add(add(base,shl(i,2)),shl(op,2)); jz source `y[i+op]` emits `shl(add(i,op),2)`, which does not match (cursorAddr.index null), so reachability: low (I).
 - L10 (lead): inlined CSE temps `t` (73-90): the tee write is dropped and every `local.get t` replaced; no check that `t` is read after the loop (outsideReads not consulted for it: it no longer appears in the body so no lift sees it) or read before its tee in an iteration (readsBeforeWrite). Reachability: low (CSE scratch).
 - Residual: `body.some(hasBranchOrReturn)` does not cover `unreachable`/`throw` out of a function with a handler that reads `op` (landing skipped). Negligible.
 - Verified OK: landing correctness (op = B + c*i with final i; zero-trip gives op unchanged); address rewrite arithmetic mod 2^32; negative/non-power-of-two stride falls back to generic substitution; original node untouched if no lift takes it (copy at 68).
