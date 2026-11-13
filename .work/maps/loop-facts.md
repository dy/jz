Scout report (Sonnet 5.5, 2026-11-13), tree `cdc3b0711` (the tree 6a landed from), read-only.
Leads, not facts: V = the scout read the line or measured it, I = inferred. Not re-derived by
the integrator. The scripts, patches and raw rows the text names (`probe.mjs`,
`instrumentation.patch`, `census-*.jsonl` and the rest) were session scratch and are not in the
repo.

# Part A: what the emitter knows about a loop, and what reaches the vectorizer

Scout: Claude Sonnet 5.5 (`claude-sonnet-5-5`). Tree read: `land-e`, commit `cdc3b0711` (my worktree fast-forwarded to it; the only git write). Instrumented, uncommitted: `src/optimize/vectorize/index.js` (see `instrumentation.patch`). V = I read the line or ran it (file:line or command given); I = inferred.

## A1. The link: built, held, read

**Built (V).** `src/compile/emit/control-flow.js:1411` `const facts = loopFacts(init, cond, step, body)`; `:1485` `ctx.plans.loweringLinks.set(loopBlockNode, { plan: facts, lowering: { ivName: counterName, guardName } })`, where `counterName = facts.iv` and `guardName = facts.guard` (`:1412`). The map is `ctx.js:958` (`new WeakMap()`, key = the WAT `(block $brk (loop …))` node, by identity). It reaches the optimizer as `passFacts.loweringLinks` (`src/wat/assemble/optimize-module.js:69`) and the vectorizer as `opts.links` (`src/optimize/driver.js:96`). The `while` handler is `controlFlowOps['for'](null, cond, null, body)` (`control-flow.js:1492`), so a source `while` is linked as a `for` with no init and no step.

**Every field (V, `src/compile/loop-model.js:145-160`).** `plan` is `Object.freeze`d:

| field | line | what it is |
|---|---|---|
| `iv` | 146 | `guardCounterName(cond)` (`src/static.js:514`): the name the exit test compares, bare or `name ± const` (`i + 1 < n` names `i`). Null when `cond` is not a relational op (`!==`, a flag), or its left side is anything else. Stays set when the body writes the counter. |
| `hull` | 152 | `{lo, hi}`: the counter's range in the body. Only when `iv` is set, the body never writes it (`isReassigned(body, iv)`, :147), the loop head declares its start (`counterInit`, `static.js:527`: no `init` means null), the step is a positive constant in the guard's direction (`forCounterBoundsIn`, `static.js:638-700`) and the bound has a closed range on the side the counter runs toward. |
| `test` | 153 | `{lo, hi}`: the counter's range where the guard reads it (initial value, or one step on). Same preconditions as `hull`. |
| `step` | 154 | `range.step`: a **positive magnitude** (1, 2, …). Sign is not kept: `i--` and `i++` both give `step: 1` (V: `3/Float64Array#B` link `{"hull":{"lo":0,"hi":60},"step":1}` for a descending loop). Null with `hull`. |
| `counters` | 155 | secondary counters `{name, lo, hi}` from `secondaryCounters` (`loop-model.js:187`), read from the **for-step** only. Always 0 in every row I ran (V): `i++, k++` reaches the emitter with `k++` already in the body (the step is `++i` alone; `JZ_DBG_USC` print: `["++","if2_3int7"]`), so the field is dead for that spelling. Census (423 units): `counters` is non-empty on **2** of 4,240 linked loops. |
| `guard` | 148 | the name on the left of a `<`/`<=` test, when it is a bare name (not `i + 1`). |
| `guardRange` | 149 | `intExprRange(cond[2])`: the bound's range. |
| `boundConst` | 158 | the bound when `guardRange` is one point. |

`lowering` (`control-flow.js:1485`): `ivName`, `guardName`: **WAT local names without the `$`** (`if2_2int9`), kept current by the rename at `control-flow.js:85-110` (`renameScalarBindings`, which rewrites the two fields through the rename map and never touches `plan`).

**Not in the link (V, absent from `loopFacts`).** The start expression; the bound expression and its constant shift K (`i + K < n`, `nameShift` `static.js:495`, computed and dropped); the step's **sign**; the exit comparison as written (`<`, `<=`, `>`, `>=`); the trip count; whether the bound is invariant (only "the first write ends the fact", `loopGuardHi`, in the emitter's own refinement map); the element type and array of each access; aliasing (carried separately on the func node: `fn.distinctParams` `emit-func.js:186`, `fn.arrayParams` `:188`, `fn.presentTyped` `:194`, `fn.viewNames` `:404`).

**For which loops an entry exists (V).**
- Yes: every loop the `'for'` emitter writes, i.e. a source `for`, a `while`, a `for…of` (it lowers to an AST `for`: `17a` link `{"iv":"i0","hull":{"lo":0,"hi":63},"boundConst":64}`), and a do-while after `normalize.js` lowers it (but its `iv` is null: the flag test is not a relational op; `16b` link all null).
- No: loops built by other emitters. `forEach` (`walk`, `src/ir/arrays.js:61`, 38 sites after phase 3b) has **no link** (`17b`: `link=none`); neither do the stdlib's own loops (`__simd_map_*`, `__gc_*`, sort, regex, collection: `NOLINK` in every probe dump), the loops a pass builds (`unswitch.js:352`, `ring-laps.js:198`, `loop-compact.js:234`), the `canonicalizeCounters` retry node (`index.js` retry), and every cold twin (`cold` loops are skipped by the walk, `index.js:232`).
- Coverage over the 423-unit census at speed (user functions, cold twins and runtime helpers left out; V, `census.md`): **4,240 of 5,719** visited `(block (loop))` nodes carry a link (74%); of the 4,401 whose scaffold matches, 3,090 (70%); of the 585 lifted, 572; of the 1,318 with no scaffold, 1,150. Of the linked loops: `iv` null 444, `hull` 2,440, `step` 1: 2,377, step > 1: 63, `guard` set 3,695, `boundConst` 1,948. So a fact read from the link would be absent for about one loop in four, and `hull` is absent on 43% of the linked ones.

**Read, under `src/optimize` (V, `grep -rnE "\blinks\b|loweringLinks|\.plan\b|\.lowering\b" src/optimize`).** Three places, not two:
1. `vectorize/index.js:277-278` (the committed file's line numbers; the instrumented copy shifts them): `bl.incVar = dollar(link.lowering.ivName)`. The only value the vectorizer takes. The WAT scaffold's own incVar would be identical wherever both resolve (the assertion proves it).
2. `vectorize/index.js:84-92` `assertLoopPlanAgrees`, under `JZ_DEBUG_INVARIANTS`: `ivName` against `bl.incVar`, `plan.boundConst` against a constant WAT bound.
3. **`optimize/peephole.js:577-596`** (`boundedFloatLocal`, called from `fusedRewrite`, the pass before the vectorizer: `driver.js:51`): `facts.hull` and `facts.step` bound a float accumulator `acc += c` by `count = ⌊(hi - lo) / step⌋ + 1`. This is the one consumer of `hull`/`step`; the claim "only the counter name" is wrong by this one (V).
`lowering.guardName` is read by nothing but the rename (V: grep).

## A2. What the compiler knows of a counted loop, where it is computed, whether it survives

| fact | computed | held by | to the optimizer? |
|---|---|---|---|
| counter | `guardCounterName` `static.js:514` from the (normalized) test | `plan.iv`, `lowering.ivName` | yes, while the block node survives; **null** for `!==`, flag loops, do-while |
| start | `counterInit(init, name)` `static.js:527` (a single `let i = E` in the head) | consumed inside `forCounterBoundsIn` → `hull.lo` (up) / `hull.hi` (down), `test` | the range only, not E. A counter declared **outside** the head (`let i = 0; for (; i < n; i++)`) has no start: `hull` null (V: `5`: `"hull":null`, and the counter is an **f64** local, first refusal `S9 f64 counter step`) |
| bound | `cond[2]`; range `intExprRange` (`loop-model.js:149`) | `guardRange`, `boundConst` | the range, not the expression (for `n - K` forms the K too is dropped); the WAT bound is a local the optimizer re-reads (`$nf2_1`, snapped `…bound10`) |
| bound invariant? | `isReassigned(r, b)` inside `forCounterBoundsIn` (`held`, `static.js:674`); the emitter's `loopGuardHi` (`control-flow.js:1417-1425`) | not recorded | no. The vectorizer re-derives it from `bl.writes` (`scaffold.js:177`) |
| step | `stepMatches` in `forCounterBoundsIn` | `plan.step` (magnitude) | yes, magnitude only |
| step sign / direction | `increasing` (`static.js:642`), local | nowhere | **lost at emit** |
| exit comparison | `cond[0]` | nowhere (`guard` only for `<`/`<=`) | **lost**; the WAT keeps it (`i32.lt_s`, `i32.le_s`, `i32.ge_s`, `f64.ne` …) |
| trip count | derivable `⌊(hi-lo)/step⌋ + 1` (`loop-model.js:155`, `peephole.js:595`) | not stored | an **upper bound** from the hull, derived by the one consumer |
| body writes counter / bound | `isReassigned(body, iv)` `loop-model.js:147` (gates `hull`); `secondaryCounters` filters (`loop-model.js:~190-200`) | a missing `hull` | indirectly; no flag |
| element type, array of each access | emitter: `ctx.func.typedElem`/`typedLen` (`analyze-for-emit.js:~129`), summary kinds | not in the link; typed arrays reach IR as `i32.load8_u`, `f64.load` over `(i32.add base (i32.shl idx K))` | the vectorizer re-derives type and base from the opcode and the address (`lane-tables.js`, `addr-model.js`) |
| alias: distinct params, array params | `emit-func.js:128-188` | `fn.distinctParams`, `fn.arrayParams` | yes, on the func node (`index.js:132`, `alias.js:169`) |
| value ranges of i32 reads | `irange` mark (`ir/vars.js:201`) | on `local.get` nodes | dropped before the vectorizer by 8 passes (`pass-table.js`: `holdWordNumbers`, `narrowLoopBound`, `hoistInvariantLoop`, `fusedRewrite`, `unswitchStringRepLoop`, `shiftRemainder`, `hoistAddrBase`, `forwardStores`); the vectorizer reads no `irange` |

What the AST-side normal form fixes (V, `src/normalize.js:1-37`): a step is `++i`, `--i`, `i += K`, `i -= K` (K > 0); a mirrored test `n > i` is `i < n`; `i <= B` is `i < floor(B) + 1` and `i !== B` is `i < B` **only** for a counter declared by the loop from an integer literal against a **constant** B; do-while is `while (c) B` where the test holds on entry, else a flag loop `let F = true; while (F || c) { F = false; B }`. `plan/counted-loops.js` (`unitWalks`, `guardConstants`, `canonicalizeCountedLoops`, `plan/index.js:252-257`) rewrites cursors beside the counter into one counter from 0 (`c + K·k`), but not a plain `i += 2`. `loop-recurrence.js` unrolls (below). The loop constructor of phase 3b is `walk` (`src/ir/arrays.js:61`): top test `br_if $brk (i32.eqz (i32.lt_s i len))` (`i32.ge_s i 0` reversed), step `i = i ± 1` at the bottom: scaffold-compatible, but unlinked.

## A3. What passes rewrite a loop between emit and the vectorizer

Measured, not read: `passwatch.mjs` wraps every runner of the 'func' stage (`driver.js` `RUN`) and compares, per `(block (loop))` node by identity, the exit test + step statement ("header"), the body and the block's preamble before and after. Result over 93 bench units at speed, user functions only (the runtime `$__*` helpers skipped), 1,570 `(block (loop))` nodes (`passwatch2.out`, V). "shape" = the exit comparison's op, its left operand's op, the step statement's op and its value's op (names and constants ignored); "header" = the exit test and step statement as text (an operand rewrite counts); "lost" = the block node is no longer in the function (its link goes with it).

| pass (table order) | shape | header | body | preamble | lost |
|---|---:|---:|---:|---:|---:|
| holdWordNumbers | 0 | 0 | 12 | 0 | 0 |
| nanCanon | 0 | 13 | 169 | 0 | 0 |
| hoistPtrType | 0 | 10 | 17 | 0 | 0 |
| **narrowLoopBound** (`licm.js:979`) | **40** | 40 | 19 | 0 | 0 |
| hoistInvariantLoop (`licm.js:919`) | 2 | 60 | 545 | **519** | 0 |
| fusedRewrite (`peephole.js:265`) | 11 | 100 | 1,013 | 90 | 0 |
| unswitchStringRepLoop | 0 | 0 | 0 | 0 | 1 |
| hoistAddrBase | 0 | 9 | 454 | 9 | 0 |
| hoistInvariantLoop.late | 0 | 1 | 11 | 8 | 0 |
| **forwardStores** (`forward-store.js:33`) | **25** | 60 | 1,125 | 0 | 0 |
| sinkStores, earlyStores, promoteGlobals | 1 | 2 | 81 | 4 | 0 |
| **vectorizeLaneLocal** | 9 | 469 | 693 | 32 | 28 (all lifted: replaced by the wrapper) |
| after it: splitLoopPrivateScratch | 0 | 0 | 14 | 10 | 38 |
| specializeLoops | 0 | 0 | 19 | 0 | 34 (+171 new) |
| **narrowInts** | 0 | 0 | 0 | 0 | **1,144** (800 linked) |
| narrowWrappedWords | 0 | 0 | 0 | 0 | 384 |

Reading it (V = the numbers; I = the causes): before the vectorizer **no pass rebuilds a loop's block node** (one `unswitchStringRepLoop` loss). The passes that change the exit test or the step rewrite an operand in place: `narrowLoopBound` (the bound snapped into an i32 local), `forwardStores` (a forwarded load in the test), `fusedRewrite` (memarg folds, inline ptr-type), `hoistInvariantLoop` (a hoisted operand). So the link's counter name stays right up to the vectorizer and its `hull`/`step` stay true of the loop; what goes stale is the **bound operand** the optimizer re-reads (`$nf2_1` against the link's `boundConst`) and the preamble (`$__liN` sets, 519 loops) the scaffold must tolerate. `narrowInts` runs after the vectorizer and rebuilds 1,144 of 1,570 nodes: no link reaches anything later (the link-stage `fusedRewrite` is called without links).

Read, for what each does (V = the file's own header; effect on facts I = from the measurement above):

- **At AST, before emit** (these produce the loop the emitter's facts describe, so no fact goes stale; they decide what shape arrives): `plan/index.js` sweeps `adoptLoopCounters` :158, `joinExitTests` :235, `promoteLoopFields` :238, `hoistLoopInvariants` :249, `unitWalks` :252, `guardConstants` :253, `canonicalizeCountedLoops` :257, `splitCharScan` :258, `splitArrayScan` :260, `forwardConditions` :281, `unswitchLoops` :283 (two copies per tested flag), `splitLoopKinds` :285, `peelClampedStencil` :287, `strengthReduceLoopDivMod` :290 (`loop-divmod.js`: `q`, `r` counters stepped in the body), `jamLoopItems` :292 (`loop-jam.js`: two items in one loop), `reciprocalLoopDivisors` :294, `versionIntegralLoops` :296 (`plan/integral-loops.js`: an int32 copy named `…int9` plus the loop as written, marked `cold`), `unrollRecurrences` :298 (`loop-recurrence.js`). At emit: `analyzeFuncForEmit` `analyze-for-emit.js:107-111`: `narrowBoundedSquare` (`loop-square.js`), `carryKeys`, **`unrollScalarChains`** (`loop-recurrence.js:333`, flag `unrollScalarChain`, speed only), `selectArmUpdatesIn`; and the emitter itself fully unrolls a constant small loop (`unrollSmallConstFor`, `control-flow.js:792`, `unrollSmallConstFor` :256, ≤ 8 trips, nested ≤ 64: no loop remains).
- **Module, before the function walk** (`pass-table.js`): `pureFuncMap`, `inlinePureFns`: a pure callee's body is inlined into the lane lift only.
- **Function stage, in order, up to the vectorizer** (`pass-table.js:73-121`): `foldStaticArrReads`, `holdWordNumbers` (`peephole.js:441`), `promoteCells` (`cells.js:32`: a closure-free cell becomes a local), `nanCanon`, `hoistPtrType` (`cse-address.js:35`), `hoistInvariantPtrOffset` (`licm.js:153`), `hoistPtrOffset` (`cse-address.js:62`), `narrowLoopBound` (`licm.js:979`: a threshold wider than a word snaps to an i32 `$__lbN` once), **`hoistInvariantLoop` (`licm.js:919`: invariant subtrees leave the loop as `(local.set $__liN …)` inside the same block, before the loop; the only pass measured to touch the exit test or step)**, `fusedRewrite` (`peephole.js:265`: `(i32.add base (i32.const N))` becomes `offset=N` on loads and stores, inline ptr-type), `unswitchStringRepLoop`, `shiftRemainder` (`shift-remainder.js:47`), `boolConvertToSelect` (`peephole.js:50`), `hoistAddrBase` (`cse-address.js:319`), `hoistInvariantLoop.late`, `cseScalarLoad` (`licm.js:1163`), `forwardStores` (`forward-store.js:33`), `sinkStores` (`sink-stores.js:53`: a store a loop repeats leaves by the loop's end), `earlyStores` (`early-stores.js:242`), `promoteGlobals` (`globals.js:898`: `global.get` becomes a local), `unswitchTypedParamLoop` (`unswitch.js:47`: builds a **new** loop for a Float64Array fast arm, `unswitch.js:352`: unlinked).
- **The vectorizer's own prelude** (`index.js`, in place, so node identity and the link survive): `normalizeTransparentBlocks` (`scaffold.js:84`, splices unlabeled blocks, rewrites `(block (result) …)` statement values), `foldVecIdentities` (`scaffold.js:109`, `i<<0`, `x+0`, `x*1`), `canonicalizeIfBr` (`scaffold.js:136`, `if c (then (br L))` → `br_if`), `slpPairsIn`, `hoistReductionInvariantsIn`; and the retry `canonicalizeCounters` (`counter-run.js`) which builds a **new** node (no link).
- **After the vectorizer, not before:** `specializeLoops`, `narrowInts`, `narrowFloat32`, `wideAccumulator`, `unrollTrips`, `rotateLoops`, `ringLaps`, `pointerExits`. In particular the integer narrowing of counters (`narrowInts`) and the `specializeLoops` "hit" copies run **after** `vectorizeLaneLocal` (`pass-table.js`), so a loop whose counter the emitter left f64 reaches the vectorizer as an f64 loop (rows 1-5, 11b: first refusal "f64 counter step").

## A4. The five facts of A that matter most

1. The link carries counter, hull, magnitude step and the bound's range; it does **not** carry start, bound expression (nor the shift K of `i + K < n`), step sign, or the exit comparison. Each of the six scaffold refusals of rows 1-4, 11 is a fact the emitter computed and dropped (`nameShift`, `increasing`, `cond[0]`).
2. The vectorizer consumes one value of it (`bl.incVar`); the one other reader is `peephole.js:577` (hull and step), a pass before it.
3. `plan.counters` is empty for `i++, k++` loops in every case I ran: the normalizer moves `k++` into the body before `loopFacts` reads the step.
4. Where the counter is f64 (a Number `n` with no int twin, a counter declared outside the head, `!==`, do-while) the vectorizer sees `f64.add`/`f64.lt` and no scaffold; `narrowInts` is later in the table than the vectorizer.
5. `unrollScalarChains` (speed only) unrolls a loop with a second counter by two because `stepOf` (`loop-recurrence.js:295`) does not accept the normalized step `++k` (rows 12).
