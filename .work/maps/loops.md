# Scout report: loops in jz (tree: /Users/div/projects/jz/.claude/worktrees/v1)

Model: Sonnet 5.5. Read-only; no repo file touched. Scratch probes (mine, in this directory): `scout-wat.mjs`, `scout-probe*.mjs`, `scout-one.mjs`, `scout-ast.mjs`, `ast2.mjs`.

Legend. **V** = I read the code at that line. **R** = I ran a compile and read the WAT/AST. **I** = inferred / skimmed header only. File paths are relative to the worktree root.

Coverage statement (Q3):
- Fully read (matcher functions read): `src/compile/loop-model.js`, `src/static.js` (loop parts), `src/compile/plan/{counted-loops,loops,read-buffers,advise,index-array-patterns}.js`, `src/compile/plan/integral-loops.js` (heads, helpers, ~15 of ~2200 lines; the rest is rewrite machinery), `src/type/{canonical-bounds,loop-unroll,bounded-counters}.js`, `src/optimize/vectorize/{scaffold,addr-model}.js`, `src/optimize/{rotate-loops,unroll-trips,word-ranges,guards (counter part)}.js`.
- Sampled (grep for step/test forms + read the deciding block): `src/type/{loop-versioning,loop-versioning-nest,interval-proof,int-certain}.js`, `src/compile/{loop-divmod,loop-recurrence,loop-jam,loop-square,peel-stencil,cse-load,carry-elements,twin-locals,sentinel-guard,analyze-scans}.js`, `src/compile/emit/{control-flow,arithmetic,i32-bounds}.js`, `src/summary/index.js`, `src/prepare/{split-bindings,handlers,pre-eval}.js`, vectorize `{stencil,outer-scaffold,counter-run,strength-reduce,gather-map}.js`, `src/optimize/{ring-laps,pointer-exits,jump-pointers,lead-gathers,skip-latches,search-loops,split-funcs,carry-stores,licm,unswitch,peephole}.js` (file headers + the counter/test recognizer).
- Grep-only (no IV matching found by keyword scan; not read): the other 20 files in `src/optimize/vectorize/` (they consume `matchBlockLoop` output), `src/optimize/{sink-stores,early-stores,lead-chains,quiet-loops,loop-compact,loop-rewind,int-range,flow-range}.js`, `src/link/*` (no loop or IV code at all: V, `grep loop|counter|induction src/link` hits only `rotateLoops` import), `src/ir/*` except `control.js`, `arrays.js`, `tape.js`.
- Not covered: `watr` (external; its `loopify`/`lsr` run inside `watOptimize`), `module/**` hand-written stdlib loops (378 lines matching `['loop'`/`(loop ` in 31 files under module/, src/ir, src/abi; they are producers, not matchers), tests, bench.

---------------------------------------------------------------------------

## 0. Pipeline as it really is (corrections to your map)

| Stage | Where | Notes |
|---|---|---|
| parse | `src/parse.js` | V |
| liftIIFEs, jzify, prepare, preEval | `src/front.js:34-48` (`frontHalf`) | the ONE front half; host and self-compile both call it (V, header comment) |
| whole-program summary | `src/compile/index.js:246` `ctx.summary = summarizeProgram()` | runs BEFORE `plan`; `summary/index.js:1178 loopCounter` already reads source loops (V) |
| plan (~70 AST sweeps) | `src/compile/plan/index.js` | order in section 5 |
| analyze/narrow/emit | `src/compile/index.js:302 plan()`, `:552 emitFuncs` | emit is where `for`/`while` become `(block (loop))` |
| optimize (WAT s-expr, per function) | `src/optimize/driver.js` | licm/narrowLoopBound (27), unswitch (65), vectorize (66), wideAccumulator (185), combineGuards (181) |
| link (tape) | `src/compile/index.js:113` -> `src/link/index.js` | only `fold` + `rotateLoops` look at loops; arena rewind/treeshake/sections do not match IVs (V) |
| **watrTail** (WAT s-expr AGAIN) | `src/optimize/watr-tail.js:699-730+` | watr's `watOptimize`, then jz WAT-array passes run AFTER watr: `unrollTrips`, `ringLaps`, `pointerExits`, `jumpPointers`, `leadChains`, `searchLoops`, `leadGathers`, `carryStores`, `skipLatches`, `splitFuncs/loopPasses` (V). Your map lists link -> watr only; the post-watr jz passes are a second WAT-array stage. |

---------------------------------------------------------------------------

## 1. Loop syntax through the front end (all R unless noted; dumps via `ast2.mjs`)

AST after parse (`parse()`), after jzify (`jzify(...)`), and after prepare (read from `ctx.funcs.list[].body`; `prepare()` returns null for function bodies, they live in `ctx.funcs`, V+R).

| Source | After parse | After jzify | After prepare (what every later pass sees) |
|---|---|---|---|
| `for (let i=0;i<n;i++) B` | `['for',[';',['let',['=','i',[,0]]],['<','i','n'],['++','i',null]],B]` (3-ary; postfix `i++` = `['++','i',null]`, prefix = 2-ary) | unchanged (jzify 'for' only maps the 3 head slots, `jzify/transform.js:~755`) | `['for', ['let',['=','if1_3',[,0]]], ['<','if1_3','nf1_1'], ['++','if1_3'], B]` : 5-ary, head de-`;`'d, unique names (`if1_3`), step is PREFIX when value unused (`dropDeadPostfix`, `prepare/const-fold.js`), `['postfix',['++',x]]` only when the value is used (`prepare/handlers.js:1144-1151`). Cond runs `stripBoolNot`; a `.length`/`.size`/`.byteLength` bound gets `\|0` (`handlers.js:1456-1470`, both orientations, kept INLINE because the body may resize the array) |
| `while (c) B` | `['while',c,B]` | unchanged | `['while',c,B]` (`handlers.js:853`) |
| `do B while (c)` | `['do',B,c]` | **lowered here**: `[';',['let',['=',FLAG,[,true]]],['while',['\|\|',FLAG,c],['{}',[';',['=',FLAG,[,false]],B]]]]` (`jzify/transform.js:737-742`, flag `do<n>`, `jzify/names.js:29`) | already a while; in strict mode jzify is skipped and `prepare/handlers.js:867-873` does the identical rewrite (flag `T+'do'+id`, e.g. `do0f1_2` in the dump) |
| `for (const x of a) B` | `['for',['of',['const','x'],'a'],B]` | unchanged (except generator / iterator-protocol forks, `jzify/transform.js:731-760`) | `['for', ['let',['=','arr1',['()','__iter_arr','a']],['=','i0',[,0]]], ['<','i0',['\|',['.','arr1','length'],[,0]]], ['++','i0'], [';',['let',['=','x','arr1[i0]']],B]]` (`handlers.js:1489-1516`) |
| `for (k in o) B` | `['for',['in',...],B]` | unchanged | `for (let ks=__keys_ro(o) (nullish-guarded), ix=0, len=(ks.length\|0); ix<len; ++ix) { let k = ks[ix]; B }` (`handlers.js:1517-1580`); NOTE bound is a hoisted `len` here, unlike for-of |
| `while(true){…break}` | `['while',['bool',1],B]` | unchanged | unchanged, cond stays `['bool',1]` (R) |
| `for(;;)` | `['for',[';',null,null,null],B]` | unchanged | `['for',null,null,null,B]` |
| labeled | `[':','outer',LOOP]` | unchanged | `['label','outer',LOOP]` (`handlers.js:416-424`; a labeled `for` is re-entered with the label for the captured-let path) |
| `break`/`continue` | `['break']`, `['continue','outer']` | unchanged | unchanged (`handlers.js:413-414`) |
| for-head `let` captured by a closure | same as plain for | same | **loop shape destroyed**: `{ let i=…; let ipi=i, first=true; for(;;){ let i=ipi; if(first) first=false else STEP; if(!COND) break; label next:{BODY'}; ipi=i } }` (`handlers.js:1405-1424`, R in the `capt` dump). Neither counted loop matchers nor the vectorizer see a counter after this. |
| `a.forEach(f)`, `.map`, `.reduce`, `.filter`, … | calls | calls | still `['()',['.','a','forEach'],arrow]` through summary AND plan (only `inlineLocalLambdas` may splice a lambda); lowered **at emit** by `ctx.core.emit['.forEach']` etc. (`module/array.js:2466-2731`) -> `callbackLoop` (`module/array/callback.js:33`) -> `arrayLoop` (`src/ir/arrays.js:68`), emitting directly WAT `(block $brk (loop $loop (br_if $brk (i32.ge_s i len)) VISIT (local.set i (i32.add i 1)) (br $loop)))` with an i32 counter. Typed arrays: `typedLoop` `module/typedarray.js:3295` same shape (V). |

Emit of the two source loop ops (V): `'while'` is literally `controlFlowOps['for'](null, cond, null, body)` (`emit/control-flow.js:1492`); `for` emits `(block $brk (loop $loop (br_if $brk (i32.eqz COND)) [(block $cont BODY) if step&&continue | BODY] STEP (br $loop)))` (`control-flow.js:1393-1404`).

**Is there one place where every loop is still an AST node and nothing has optimized yet?** For SOURCE loops: yes, the output of `frontHalf` (`src/front.js:46`, after preEval; function bodies in `ctx.funcs.list`, module init in the returned `ast`), strictly before `summarizeProgram()` at `compile/index.js:246`. Caveats (V): (a) `preEval` deliberately leaves `for` heads unfolded so later shape matchers still fire (`prepare/pre-eval.js:768-777`), i.e. loop shape is a stated contract; (b) the library/callback loops (`.forEach/.map/.reduce/.filter/.find/...`, typed-array methods, ~378 hand-built stdlib loop sites) never exist as AST: they are born as WAT at emit, so no front-end pass can canonicalize them; (c) plan passes synthesize new loops later (unitWalks, splitCharScan/splitArrayScan, versionIntegralLoops, peel-stencil, loop-jam, kind-split...), most already build `['for',['let',['=',i,a]],['<',i,b],['++',i],body]`.

---------------------------------------------------------------------------

## 2. `src/compile/loop-model.js` (235 lines; V)

Header says "shared AST-level loop primitives ... post-prepare AST". It is more than `unitIncVar`: it also owns `loopFacts` (the HIR->WAT bridge).

| Export (line) | Accepts | Rejects / notes |
|---|---|---|
| `freshLoopId()` (22) | per-compile counter `ctx.transform.loopXformId` | - |
| `loopLitVal(n)` (28), `litN(n,k)` (29) | post-prepare literal `[<hole>, v]` of length 2 | not a number literal -> null/false |
| `unitIncVar(stmt)` (34) | a statement that steps a NAME by exactly +1: `i++`, `++i`, `['postfix',…]` wrapper, `(++i) - 1` spelled form, `i += 1`, `i = i + 1`, `i = 1 + i`, `i = (i + 1) \| 0`, `i = (1 + i) \| 0` | `i += 2`, `i -= -1`, `i = i - -1`, `i--`, `i = i + k` (even k const), `i = 0 \| (i+1)` (literal first), anything non-string target (`a.x++`), `i = i + 1.0` accepted only as literal 1 |
| `normalizeLoop(stmt)` (54) | `while` -> `{kind,init:null,cond,step:null,body}`; 5-ary `for` | `for` with <5 slots, `do`, labeled node |
| `closureMutatedVars(body)` (65) | set of names written inside any `=>` | - |
| `soleUnitInc(body)` (83) | `;`-body with exactly ONE unit-inc statement of ANY name -> `{iv,ivIdx}` | two incs (any names) -> null |
| `uniqueUnitIncOf(body, iv)` (93) | index of the sole unit inc of `iv`; -1 none; null two | **DEAD**: exported, zero importers (V grep) |
| `loopHazards(cm, body)` (100) | `.mutated(name, exceptIdx)`: direct writes (findMutations) or closure writes | - |
| `rewriteBlocks(body, tryStmt)` (118) | post-order block rewrite with identity-preserving copy | - |
| `loopFacts(init,cond,step,body)` (167) | iv = `guardCounterName(cond)` (static.js:521); hull via `forCounterRange` only when body does not write iv; `guard` = LHS name of a `<`/`<=` cond only (not `>`/`>=`); `guardRange`/`boundConst`; secondary counters via `counterStep`/`secondaryCounters` | any cond whose top op is not relational (`\|\|`, `&&`, `!==`) -> iv null, guard null (line 168-171) |
| `counterRefinements(facts)` (188), `testRefinements(facts)` (195) | facts -> refinement maps | - |
| (private) `counterStep` (200) | `x++`, `x--`, `x += S`, `x -= S`, `x = x ± S`, `x = S + x`, postfix wrapper, `(++x)-1` / `(--x)+1`; comma steps | `S - x`, non-name target |
| (private) `secondaryCounters` (215) | other counters of a comma step, moving by literal or never-written name | - |

Imports it takes from `static.js`: `guardCounterName, forCounterRange, intExprRange, counterInit, constIntExpr` and `findMutations` from `analyze-scans.js` (so the "shared model" already depends on the second, bigger induction model in `static.js`).

Importers (V grep over src, scripts, test, bench; comment-only mentions excluded):

| File | Uses |
|---|---|
| `src/compile/loop-recurrence.js:32` | loopLitVal, litN, unitIncVar, normalizeLoop, freshLoopId, loopHazards, rewriteBlocks, closureMutatedVars |
| `src/compile/loop-jam.js:33` | normalizeLoop, rewriteBlocks, freshLoopId, unitIncVar, loopLitVal, closureMutatedVars |
| `src/compile/loop-divmod.js:35` | litN, loopLitVal, normalizeLoop, rewriteBlocks, freshLoopId, soleUnitInc, unitIncVar, loopHazards, closureMutatedVars |
| `src/compile/peel-stencil.js:31` | litN, unitIncVar, normalizeLoop, rewriteBlocks, freshLoopId, loopHazards, closureMutatedVars |
| `src/compile/loop-square.js:6` | loopLitVal, unitIncVar, normalizeLoop, rewriteBlocks, loopHazards |
| `src/compile/cse-load.js:49` | unitIncVar only |
| `src/compile/analyze-for-emit.js:24` | closureMutatedVars only |
| `src/compile/plan/reciprocal-loops.js:45`, `plan/loop-invariants.js:35` | normalizeLoop, rewriteBlocks, closureMutatedVars, loopHazards |
| `src/compile/emit/control-flow.js:20` | loopFacts, counterRefinements, testRefinements |
| comment refs only | `src/ctx.js:830`, `src/ir/classify.js:44`, `src/ir/control.js:154`, tests |

Observation (V): `unitIncVar` is imported by 6 files; 13 other recognizers of "step by one" exist elsewhere (section 3), several narrower, several wider.

---------------------------------------------------------------------------

## 3. Private matchers outside loop-model.js

Columns: id | file:line | function | level | accepts | concludes | verified.
Level: AST = post-prepare source AST; WAT = WAT s-expr (pre-link: optimize/driver, or post-watr: watr-tail); TAPE = src/ir/tape.js.
"LHS-only" = the counter must be `cond[1]`; the flipped orientation `N > i` is NOT recognized.

### 3A. Shared induction code, `src/static.js` (the real second model)

| # | file:line | function | lvl | accepts | concludes | ver |
|---|---|---|---|---|---|---|
| 1 | static.js:502 | `nameShift(expr,name)` | AST | `name`, `name+K`, `K+name`, `name-K` (K const int); `K-name` excluded | K shift | V |
| 2 | static.js:521 | `guardCounterName(cond)` | AST | cond op in RELATIONAL_OPS `< <= > >=`; LHS is a name or nameShift form (i+K, K+i, i-K) | counter name, LHS-only; `!==`, `\|\|`, `&&`, literal LHS -> null | V |
| 3 | static.js:534 | `counterInit(init,name)` | AST | `let/const` decls, `;`/`,` lists; exactly one `=` init; a second write rejects | init expr | V |
| 4 | static.js:571 (+585 private `unitStep`) | `elementCounter(cond,step)` | AST | `R[i++]` / `(d = R[i++])` / `R[i]` under `i++\|i += 1\|i = i+1\|i = 1+i`; receiver length cap by kind | counter bound by element presence (top <= length) | V |
| 5 | static.js:652 (`forCounterRange`/`forCounterBounds`) | `forCounterBoundsIn` | AST | ops `<,<=` (up) / `>,>=` (down); LHS via nameShift; steps: `++`/`--` (matching direction), `+=`/`-=` K>0 (exact: const; Bounds: range), `i = i ± K`, `i = K + i` (+ only), postfix and `(++i)-1`/`(--i)+1` wrapper; comma step with exactly one matching part; init via counterInit; bound via rangeOf/topOf/bottomOf | hull `[lo,hi]`, `.step`, `.test` | V |

### 3B. `src/compile/plan/**` (source AST)

| # | file:line | function | lvl | accepts | concludes | ver |
|---|---|---|---|---|---|---|
| 6 | plan/counted-loops.js:147,156,169 | `nameStep`,`unitSteps`,`walkTest` | AST | test `!==`/`!=` either orientation; every write of cursor x is `x++`, `x-=1`, `x+=1`, or step by one stable NAME (`x += d`, `x = x ± d`) | walk to an end tested by equality | V |
| 7 | counted-loops.js:193,239 | `unitWalk`/`unitWalks` | AST | **`while` nodes only** (`node[0]==='while' && length===3 && parent[0]!=='label'`, line 256), no `=>`, no label/yield/await, no labeled break/continue, body contains a `[]` read | `if (number(x) && x===floor(x) && x<=e) {while (x<e)…} else {orig}` per step direction | V,R |
| 8 | counted-loops.js:271,283 | `stepOf`,`strideOf` | AST | `++ -- += -= x = x±K` with K via `intOf` (literal or module const); `strideOf`: `c += name`/`c = c + name` | signed constant step / stride name | V |
| 9 | counted-loops.js:387 (+287 `indexOnly`, 308 `affineIn`, 341 `reroll`) | `canonicalize` | AST | `for`, init single `let i = start`, test `<`/`<=` LHS, `stepOf>0`, pure bound, no closure/break/continue/label, cursor steps as body statements | one counter from 0, cursors `c+K·k`, unrolled bodies rolled back | V |
| 10 | counted-loops.js:693 | `offsetTest` | AST | `i + k < n` (lag/tap) | `i < n - k` | V(head) |
| 11 | counted-loops.js:610 | `adoptLoopCounters` | AST | counter declared outside loop, read nowhere else | makes it loop-local | V(head) |
| 12 | plan/integral-loops.js:242 | `litStep` | AST | `c++`, `c += k`, `c = c + k`, `c = k + c` (k int >=0), the `+1` member-op | literal step | V |
| 13 | integral-loops.js:281 | `canonicalHead` | AST | `for` with `let/const` multi-decl head; test in `< <= > >=` LHS-only name; comma step; counter init literal or name | splits other cursors out of head | V |
| 14 | integral-loops.js:318 | `unitStep(body,counter)` | AST | a body statement (even inside an expression `buf[p++]`) steps by >=1 each round, no other non-step write, no own `continue` | at-most-bound trips | V |
| 15 | integral-loops.js:338 | `unitFall` | AST | mirror: `c--`, `c -= k`, `c = c - k` | descending while | V |
| 16 | integral-loops.js:378,403 | `boundNames`,`counted` | AST | `for` init `let/var i`, step `COUNTS`(`++ -- +1 -1`)/`+=`/`-=`; test either side (the counter on either side!); `while` counter = the one name stepped by constants | names a loop is bounded by | V |
| 17 | integral-loops.js:795,831,942,963,1321 (+1418) | inline trip / entry rules inside `versionBody` | AST | `trip` requires init literal int, step in COUNTS or `+= 1`; `unitStep` or `minAdvanceBudget`; `forCounterRange` re-used at 784/787/1130 | trip count N, entry | V(sampled) |
| 18 | plan/loops.js:94 | `trySplitFor` | AST | `for`, test `<` with BOTH sides names, init `let i = 0`, `isUnitIncrement(step)` (++ only), body < 250 nodes, a `recv.charCodeAt(i)` | main loop + NaN tail | V |
| 19 | plan/loops.js:190 | `trySplitArrayFor` | AST | `<`, init `let i = C>=0` const, `isUnitIncrement`, bound const / steady Number / array length | main loop under `min(B, len)` + tail | V |
| 20 | plan/read-buffers.js:34 | `isStep` | AST | `i = i+1`, `i = 1+i`, `i += 1`, `i++`, `['postfix',['++',i]]` | step of fs read loop | V |
| 21 | plan/advise.js:110,139 | `forInductionVar`,`simdLoopIssues` | AST | step `++`/`--`, `(++i)-1`, `+=`/`-= 1` only; flags any `+= -= \|= &= ^= *= /= %=` on a non-iv name or `x = f(x)` as "carried" | **advisory `simd-loop-carried`** (not a rejection; fires on loops that DO vectorize, R) | V,R |
| 22 | plan/index-array-patterns.js:224 | `collectionLoop` | AST | exactly prepare's for-of shape `let arr=__iter_arr(src), i=0; i < (arr.length\|0); ++i` | pair-read proof for Map/Set loops | V |
| 23 | type/loop-unroll.js:65 | `smallConstForTripCount` | AST | `let i = 0`; `i < LIT` (not `<=`, not `>`); `i++` or `(++i)-1`; end <= max | trip count; consumers: plan/literals.js:557 `smallScalarTypedForTrip`, plan/exit-tests.js:99, plan/loop-fields.js:509, emit/control-flow.js:256 | V |
| 24 | emit/control-flow.js:256 | `unrollSmallConstFor` (strided branch, 272-296) | AST | init `let i = c0` const; `<`/`<=` LHS const bound; `i++` or `i += K` | explicit value list | V |

### 3C. `src/compile/*.js` loop transforms (source AST)

| # | file:line | function | lvl | accepts | concludes | ver |
|---|---|---|---|---|---|---|
| 25 | loop-divmod.js:60 (cond at 252) | `loopModel`,`tryReduce` | AST | IV = `unitIncVar(step)` (for) or `soleUnitInc(body)` (while); cond `<`/`<=` LHS = iv | / % strength reduction | V(sampled) |
| 26 | loop-recurrence.js:119,253 (cond 137/268) | `tryUnroll`,`tryUnrollScalarChain` | AST | `unitIncVar(L.step)`, cond `<`/`<=` with `L.cond[1]===iv`, init via counterInit | x2 unroll | V(sampled) |
| 27 | loop-jam.js:66,147 | `plan`,`tryJam` | AST | `unitIncVar(step)===b`, int-literal init, cond `<` LHS, inner loop same | two items side by side | V(sampled) |
| 28 | loop-square.js:17 | `tryNarrow` | AST | `i*i < C`/`<=` and the mirrored `C > i*i`; `unitIncVar` | rewrites to `i < L` | V |
| 29 | peel-stencil.js:48,93,124 | stencil finders | AST | cond `<`/`<=` LHS, `unitIncVar`, `countWrites` | edge-peel | V(sampled) |
| 30 | cse-load.js:94,107 | `stepCounter`,`indexFacts` | AST | step `unitIncVar` or comma-step with exactly one unit inc of the tested name; cond `<` LHS, bound a stable name, init const >=0 | positive-bound guard facts | V |
| 31 | carry-elements.js:91 | `stepBy` | AST | `q++`, `q += lit`, `q = q + lit` | constant step | V |
| 32 | twin-locals.js:63 | `extentTest` | AST | specs from loop-versioning (counter + K·trips) | version guard | I |
| 33 | sentinel-guard.js:86,113 | `stepOf`,`counted` | AST | relational conjunct (`REL`) over a stepped cursor | sentinel range test | I |

### 3D. Analysis / emit / summary / prepare (source AST)

| # | file:line | function | lvl | accepts | concludes | ver |
|---|---|---|---|---|---|---|
| 34 | analyze-scans.js:1513 (+1413 `collectStepRange`) | `stampLoopCounterRanges` | AST | **`for` only** (`node[0]!=='for'` returns, 1520); `guardCounterName(cond)` or `elementCounter`; counter declared by the head or once before; `forCounterBounds` | stamps `rep.range` on the counter (this is what makes it an i32 local) and on other head counters | V |
| 35 | emit/arithmetic.js:101 | `counterRanges` | AST | `while` with `<`/`<=` LHS name, hoisted `let` init a statement above, steps `k++`/`k += c`/`k = k + c`/`(k+c)\|0` literals (line 118-137); `for`: `forCounterRange`, else `<`/`<=` LHS + `++`/`+= 1` + bound magnitude | counter hull for mul/add i32 proofs | V |
| 36 | emit/control-flow.js:1411,1383,491,152,569 | `for` emitter | AST | consumes `loopFacts`; `immutableLenBound` (typed `.length`, either side of a relational); `proveGuardedWords`; `durableLoopArrays` | refinements, hoisted bound, words | V |
| 37 | emit/i32-bounds.js:92 | `loopGuardHi` | AST | set from `facts.guard` (bare `<`/`<=`); first write ends it | upper bound of the guarded name | V |
| 38 | flow-types.js:341 | `refineIntCompareRange` | AST | `name op K` and `K op name` (**both orientations**, 345-348), `&&` positive, `\|\|` negative only (66-67) | branch range of a name | V |
| 39 | narrow/summaries.js:268,352 | `unitInc` | AST | `x++` or `x += 1` only; `for` with init-literal name, test `<` LHS | push count of loop | V |
| 40 | summary/index.js:1178,1194,1202 | `loopCounter`,`countedLoop`,`exactTrip` | AST | `for`, init `let`, test `<`/`<=` LHS name, step `++` or `+= span>0` (exactTrip: `++` only, literal start/end, no break/continue/return) | counter span, exact trips for array-build counting | V |
| 41 | prepare/split-bindings.js:405 | `counterOf` | AST | `for (let i = INT; …; i++\|i--)` | counters of surrounding loops are ints | V |
| 42 | prepare/handlers.js:1456-1470 | `.length` bound wrap | AST | any relational op, bound on either side | `(x.length\|0)` | V |
| 43 | prepare/pre-eval.js:768 | `for` head skip | AST | any `for` | head never folded so matchers keep working | V |

### 3E. `src/type/**`

| # | file:line | function | lvl | accepts | concludes | ver |
|---|---|---|---|---|---|---|
| 44 | canonical-bounds.js:36,46 | `isUnitIncrement`/`isUnitDecrement` | AST | `i++`/`i--` + postfix + `(++i)-1`/`(--i)+1` ONLY (not `+= 1`, `= i + 1`, `= 1 + i`) | unit step | V |
| 45 | canonical-bounds.js:131 | `scanBoundedLoops` | AST | `for`, test `<` LHS name, init `let i = C>=0` const, `isUnitIncrement`, bound `recv.length`/`(…\|0)`/hoisted temp/`Math.min(...)`/caller-proven param | charCodeAt in-bounds | V |
| 46 | canonical-bounds.js:254 | `scanBoundedArrIdx` | AST | same + literal bound `i < B` | `a[i]` bounds-check elision | V |
| 47 | canonical-bounds.js:417 (+406-415 wrappers) | `advanceBudget` | AST | body-step census: `++`, `+=`, `= x+…`, nested loops, round test | max/min advance of a cursor | V(head) |
| 48 | loop-versioning.js:365,382,404 | `monotoneCursorOf`,`cursorStepOf`,`maxCursorAdvance` | AST | cursor `c`, `c+K`, `K+c`, `c++` value forms; step `++`, `+= lit\|name`, `= c+K`/`K+c`/`(c+K)\|0` | cursor advance per round | V |
| 49 | loop-versioning.js:461 | `versionableTypedFor` | AST | test `< <= > >=` with `typeof c[1]==='string'` (line ~476), `&&` chain (leftmost conjunct), step: `isUnitIncrement`/`isUnitDecrement`, `+= K\|name`, `= i + K\|K + i`, comma step with one unit inc + `cursor += slope`, or (no step) one body write `i=(i+LIT)\|0`/`i+=LIT`/`i++` | runtime extent guard + unchecked twin | V |
| 50 | loop-versioning-nest.js:40,169,245 | `condIvName`,`topExtent`,`cursorWrites` | AST | `<`/`<=` LHS name; `++`/`+=` up with `<`/`<=`, `--`/`-=` down with `>`/`>=` | nest lift | V(sampled) |
| 51 | interval-proof.js:754 | `stepDelta` | AST | `x++`, `x += c`, `x = x + c`, `x = c + x`, `x=(x+c)\|0`, postfix | const delta | V |
| 52 | interval-proof.js:901 | `visitFor` | AST | `for`, `< <= >` `>=`, LHS name or `name ± const` (bias), unit decrement for down; init+bound point values | iv hull for const-bound nests | V(sampled) |
| 53 | interval-proof.js:1083-1134 | while handler + wrap forms | AST | `while (c < B)`; wrap cursors: **mask form `nm = (nm + K) & M`** and **reset pair `nm += K; if (nm >= C) nm = 0`** | cursor in `[0,M]`/`[0,C-1]` | V |
| 54 | bounded-counters.js:41,65 | `stepOf`,`bounds` | AST | `x++`, `x += c`, `x = x + c`; **only matcher that accepts both orientations of the test** (`x < len` and `len > x`), string `.length` only | captured counter stays int32 | V |
| 55 | int-certain.js:89-90,155-162 | def collection | AST | `++`/`--` as defs; `%` is **never strict** int32 (-0) | `p = (p+1) % M` local cannot be proved i32 from the `%` alone | V |

### 3F. WAT level, pre-link (`src/optimize/**`, run from `optimize/driver.js`)

| # | file:line | function | lvl | accepts | concludes | ver |
|---|---|---|---|---|---|---|
| 56 | vectorize/addr-model.js:21,36,49 | `matchInc1`,`matchIncN`,`matchExitBrIf` | WAT | step: `(local.set x (i32.add (local.get x) (i32.const C)))` with **`local.get` FIRST** (so `1 + i` fails); exit: `(br_if $blk (i32.eqz (i32.lt_s\|lt_u (local.get i) BOUND)))` | the ONLY loop scaffold the vectorizer reads | V |
| 57 | vectorize/scaffold.js:186 | `matchBlockLoop` | WAT | `(block (loop EXIT BODY… INC (br $loop)))` + envelopes: default, `allowPreamble`, `'loose'`, `'pixelIV'`, `multiInc`, `ivRun` | `{incVar,bound,body,…}` or null | V |
| 58 | vectorize/outer-scaffold.js:83,103,126 | `matchOuterPixelLoop` | WAT | own exit/step matching (`i32.lt_s/lt_u`, `i32.add … 1`), own negation tables | outer pixel loop | V(sampled) |
| 59 | vectorize/stencil.js:26-110 | `stencilIndexModel`,`ivCompare`,`isStep` | WAT | `i32.lt_s`/`f64.lt`, `i32.eq`, step via `i32.add` either operand order | stencil bounds | V(sampled) |
| 60 | vectorize/counter-run.js:24,55 | `cursorAddr`,`canonicalizeCounters` | WAT | `base + ((op + k) << s)` address over a secondary counter; `matchBlockLoop` re-run on copy | rewrites cursor loops over exit counter | V |
| 61 | vectorize/strength-reduce.js:11,32 | `matchAffineAddr`,`tryStrengthReduceIV` | WAT | `(i32.add base (i32.shl ind K))` in either operand order | pointer strength reduction | V |
| 62 | vectorize/gather-map.js:15 | `tryGatherMap` | WAT | exit cmp must be `i32.lt_s` | gather lift | V(head) |
| 63 | vectorize/index.js:260 (85 shadow assert) | link consumer | WAT | `ctx.plans.loweringLinks.get(node)` -> sets `bl.incVar` from HIR `ivName`; debug assert compares HIR vs WAT iv/bound | the ONLY use of `loopFacts` below emit besides #66 | V |
| 64 | optimize/licm.js:979 | `narrowLoopBound` | WAT | f64 invariant threshold compared with an i32 counter | snaps bound to i32/i64 | V(head) |
| 65 | optimize/unswitch.js:47 | `unswitchTypedParamLoop` | WAT | IV read directly, store through snapshot `$asi == $iv` | checked/unchecked twin | I |
| 66 | optimize/peephole.js:525 | `boundedFloatLocal` consumer | WAT | f64 local stepped by f64.const inside a loop whose `loweringLinks` plan has `hull` | magnitude bound | V |
| 67 | optimize/guards.js:52-68 (file entry 344 `combineGuards`) | counter detection | WAT | loop `[… test, …, (local.set c (i32.add c 1)), (br $loop)]`; test `i32.ge_s c L`, `eqz(lt_s)`, `or`/`and`/`if` forms; L const or stable i32 local | guard combining | V |
| 68 | optimize/word-ranges.js:322 (consumer wide-accumulator.js:55) | `loopTrips` | WAT | one back edge; step `i32.add i C>0` as body statement or `local.tee` in last `br_if` test; intervals from `wordRanges` | max passes | V |

### 3G. WAT level, post-watr (`optimize/watr-tail.js`)

| # | file:line | function | lvl | accepts | concludes | ver |
|---|---|---|---|---|---|---|
| 69 | optimize/unroll-trips.js:55-57,125,161 | `stepOf`,`testOf`,`unrollTrips` | WAT | top-test `(block (loop (br_if C) BODY (br)))` or bottom-test `(loop BODY (br_if C))`; C = i32 cmp (`lt/le/gt/ge s/u`, `eq`, `ne`) of counter vs literal; step `i32.add x (i32.const s)` | full unroll of 4..16 trips | V |
| 70 | optimize/ring-laps.js:92,224 | `ringOf`,`ringLaps` | WAT | counter `(br_if $L (i32.lt_s (local.tee i (i32.add i 1)) N))`; cursor update as `% m` (`i32.rem_s/u`, m const>0 or local), watr's `lt_u` three-arm form, or mask `& (2^j-1)` | lap loop | V |
| 71 | optimize/pointer-exits.js:303 | `pointerExits` | WAT | counter from const with const steps and const tests + pointer stepped beside | pointer-equality exit | V(head) |
| 72 | optimize/jump-pointers.js:482 | `jumpPointers` | WAT | variable that steps or jumps, address `k*x + c` | carried pointer | V(head) |
| 73 | optimize/lead-gathers.js:285 | `leadGathers` | WAT | gather first in round, inductions written once per round after it, latch `br_if (lt_s (tee i (add i 1)) N)` | next-round gather | V(head) |
| 74 | optimize/skip-latches.js:207,267 | `latchLoop`,`skipLatches` | WAT | loop with one latch `(br_if $L C)` | copy of rest-of-round | V(head) |
| 75 | optimize/search-loops.js:78 | `searchLoops` | WAT | `(loop (block $B guards… REST) (br_if $L C))` | inner scan loop | V(head) |
| 76 | optimize/split-funcs.js:391,440 | `passCounter`,`fewPasses` | WAT | counter stepped by exactly 1 (`i32.add`/`f64.add` const 1), test `lt_s/lt_u/f64.lt` against const N<=256 as last `br_if` or `ge` exit + `(br $loop)` | few-pass loop outlining | V |
| 77 | optimize/carry-stores.js:90 | `carryLoop` | WAT | loop with one latch | carried store | I |

### 3H. TAPE (`src/link`)

| # | file:line | function | lvl | accepts | concludes | ver |
|---|---|---|---|---|---|---|
| 78 | optimize/rotate-loops.js:48 | `rotateLoops` (run from `link/index.js:~60`) | TAPE | `(block $brk (loop $loop (br_if $brk ¬C) BODY (br $loop)))`; ROT_NEG table for i32 compares (f64 compares take `eqz`); skipped for v128 bodies, `continue` to loop label, 3+-arm dispatch | guarded bottom-test loop with fused back edge | V |

Counts (my rows): 78 numbered rows = AST 55 (shared static.js 5, plan 19, compile/*.js 9, analysis/emit/summary/prepare 10, type 12) ; WAT pre-link 13 (#56-68); WAT post-watr 9 (#69-77); TAPE 1 (#78). Several rows are consumers of one matcher (e.g. #23 -> 4 consumers; #57 -> ~25 recognizers in vectorize/); unique matcher bodies are about 60.
I did NOT find any IV/counter matching in `src/link/*` (V), `src/ir/*` (only the `loweringLinks` WeakMap in `control.js` and rename helpers), or in `src/compile/narrow/*` other than #39.

### 3I. Forms accepted: how many matchers accept each spelling

Counting the AST-level counter/step recognizers (rows 2,5,6-9,12-14,16-21,23,25-31,34,35,39,40,41,44,45,46,48-54; about 33 distinct):

| Spelling | Accepted by (about) | Not accepted by |
|---|---|---|
| `i++` / `++i` | all of them | - |
| `i += 1` | ~22 (forCounterBounds, unitIncVar, stepOf, litStep, read-buffers, advise, narrow/summaries, summary loopCounter, interval-proof, loop-versioning ...) | `isUnitIncrement` (canonical-bounds:36), `smallConstForTripCount`, `counterOf` (split-bindings:405), `exactTrip` (summary), `loop-unroll` |
| `i = i + 1` | ~17 | the same set as above plus `advise.forInductionVar` |
| `i = 1 + i` | ~12 (unitIncVar, forCounterBounds (+ only), litStep, read-buffers, interval-proof, loop-versioning cursorStepOf, carry-elements ...) | `isUnitIncrement`, `forInductionVar` (advise), `unitInc` (narrow/summaries), `loopCounter` (summary:1190), **WAT `matchInc1`** |
| `i = (i+1)\|0` | unitIncVar, cursorStepOf, interval-proof `stepDelta`, maxCursorAdvance, integral-loops output | static.js `forCounterBounds` (only strips postfix), isUnitIncrement |
| `i -= -1` | 0 (no one) | all |
| `(++i) - 1` wrapper | unitIncVar, isUnitIncrement, forCounterBounds, counterStep, advise, smallConstForTripCount | most others |
| test `i < N` | all | - |
| test `i <= N` | ~14 (forCounterBounds, guardCounterName, loopFacts hull, stampLoopCounterRanges, summary loopCounter, loop-versioning, counterRanges, loop-recurrence, canonicalize ...) | isUnitIncrement users that also need `<` (scanBoundedLoops/ArrIdx, trySplitFor/ArrayFor, smallConstForTripCount, collectionLoop), loop-jam |
| test `N > i` / `N >= i` | 5: `refineIntCompareRange` (flow-types:341), `bounded-counters.bounds`, `loop-square` (mirrored), `integral-loops.boundNames` (either side), `.length` wrap (handlers:1456) | every other matcher (all `cond[1]===counter`) and WAT `matchExitBrIf` |
| test `i !== N` / `!=` | 1: `unitWalk` (counted-loops:169), `while` nodes only | all others |
| descending `i--` with `>`/`>=` | forCounterBounds, interval-proof, loop-versioning(+nest), integral-loops `unitFall`, canonical-bounds `isUnitDecrement`, stencil | most counted-loop/vectorizer paths |

(The counts are approximate; I counted rows whose code I read or whose grep hit the spelling. Marked I-level.)

---------------------------------------------------------------------------

## 4. Why the four bad spellings lose (R: compiled with `optimize:'speed'`, WAT read; `scout-wat.mjs`, `scout-probe*.mjs`)

Probe summary (v128 = count of `v128` tokens in `run`; "i" = Wasm type of the counter local; bchk = `i32.lt_u|ge_u` bounds tests):

| variant | v128 | i | bchk |
|---|---|---|---|
| `for (i=0; i<N; i++) s+=a[i]*b[i]` | 29 | i32 | 0 |
| `for (i=0; N>i; ++i)` | 0 | i32 | yes (twin `$__sp.f0a1` check) |
| `do { …; i++ } while (i<N)` | 0 | **f64** | 2 |
| `for (i=0; i!==N; i=1+i) c[i]=…` | 0 | **f64** | 3 |
| same with `i<N; i=1+i` | 0 | i32 | 0 |
| `while (i!==1024){…;i++}` | 0 | f64 (copy exists, see c) | - |
| `while (f>0 \|\| i<N)` | 0 | f64 | 2 |
| `while (i<N && f>0)` | 0 | i32 | 0 |

### (a) flipped test `N > i` in a reduction loop
Order of rejection (V+R):
1. AST: `N` is a module const, so cond is `['>',[null,1024],'i']`. `guardCounterName` (`static.js:521-532`): op is relational but `cond[1]` is not a string and not `name±const` -> **null**. So `loopFacts.iv` is null (`loop-model.js:168`), `stampLoopCounterRanges` returns at `analyze-scans.js:1525 (if (!name) return)`, no counter hull. (With a non-const bound `n`, cond[1] is the string `'n'` and `versionableTypedFor` would treat `n` as the counter, then fail the `isUnitDecrement(step,'n')` check, `loop-versioning.js` down-branch.)
2. AST bounds proof: `scanBoundedArrIdx` (`canonical-bounds.js:260`) requires `cond[0]==='<'` and `typeof cond[1]==='string'`; fails -> reads keep checks. R: `br_if $__sp.f0a1 (i32.ge_u i (len))` on each `a[i]`, `b[i]`.
3. WAT vectorizer: emitted exit is `(br_if $brk (i32.eqz (i32.gt_s (i32.const 1024) (local.get i))))`; `matchExitBrIf` (`addr-model.js:54`) accepts only `i32.lt_s/lt_u` with `local.get` first -> `matchBlockLoop` null -> **no recognizer runs** and, consistent with that, no `simd-why-not` warning is emitted (it needs `bl||op`, `vectorize/index.js:329`), R.
4. The `simd-loop-carried` advisory is NOT the rejecting check. It is syntactic (`plan/advise.js:110-174`): `for` + step accepted by `forInductionVar` + any `+=` on a non-iv name. It fires identically on the canonical spelling that DOES vectorize (R: both compiles emit exactly one `simd-loop-carried`). Its message ("SIMD vectorization skipped") is wrong for the canonical loop. For the ring loop it also fires, and there `simd-why-not` fires too.

### (b) `do { … i++ } while (i < N)` keeps the counter f64
1. jzify lowers to `let FLAG=true; while (FLAG || (i<N)) { FLAG=false; B }` (`jzify/transform.js:737`).
2. Every consumer keys on a bare relational top op and `||` is not one: `guardCounterName` (`static.js:521`), `loopFacts` guard (`loop-model.js:170`), `emit/arithmetic.js counterRanges` while branch (`:118`, requires `n[1][0]` in `<`,`<=`), `stampLoopCounterRanges` (for only, `analyze-scans.js:1521`). `extractRefinements` handles `&&` under positive sense but `||` only under NEGATIVE sense (`flow-types.js:66-67`), so the body gets no `i < N` refinement. R confirms: `while (f>0 || i<N)` -> f64, `while (i<N && f>0)` -> i32.
3. With no range, `i++` could pass int32, so `i` is an f64 local; indexing goes through `i64.reinterpret(f64.add i magic)` + `i32.lt_u` against the length (R, WAT above). The loop is a bare `(loop … (br_if $loop (f64.lt …)))` with no `block`, so `matchBlockLoop` has nothing to match either.
(The flag local itself disappears in watr; it is not in the final WAT.)

### (c) `i !== N; i = 1 + i` in a map loop
1. `!==` is not in `RELATIONAL_OPS` (`ast.js:334`): `guardCounterName`/`loopFacts`/`stampLoopCounterRanges` all give null -> f64 counter (R: `(local $i f64)`, 3 bounds checks, `trunc_sat` per access).
2. The only code that understands `!==` is `unitWalks`, and it collects **`while` nodes only** (`counted-loops.js:256`). A `for` with `!==` is never visited (R: the `for` form is untouched; the `while` form with literal bound is rewritten to `if (number(i)&&i===floor(i)&&i<=1024) {while (i<1024)…} else {while (i!==1024)…}` (AST dump), but the copy still gets no i32 counter because `counterRanges`/hoistedInit (`emit/arithmetic.js:101-137`) look for the `let i` in the statement list directly above the `while`, and the copy now sits inside `if {…}` blocks, so its hull is not found. I inferred this last step from the code and the f64 local; I did not trace it.)
3. Separately, `i = 1 + i` loses vectorization even under `<`: R `for (i<N; i = 1 + i)` is i32 with no checks (static.js accepts `K + i`) but v128=0, because the emitted step is `(i32.add (i32.const 1) (local.get $i))` and `matchInc1` (`addr-model.js:25-27`) needs `local.get` as first operand. Verified by WAT of that variant. `i += 1` and `i = i + 1` give v128=4.
The 3.3x figure was not re-measured by me.

### (d) ring cursor `p = (p + 1) % M` stays f64
R: `p` is `(local $p f64)`; `p = (p+1)%16` is emitted as `f64.copysign(c - f64.trunc(c / 16) * 16, c)`, every access does `i64.reinterpret(p + magic)` plus `f64.eq(convert(ixw), p)` plus a length check. The `& (M-1)` variant: `p` is i32 and the loop becomes `$__rl` lap loops.
Mechanism (V for the code, I for the exact causal chain):
1. `int-certain.js:155-162`: `%` is never level-2 strict int32 ("`-5 % 5` is -0"); at best level 1, so the local cannot be typed i32 from the expression alone; it needs a proven range.
2. The range prover knows two ring forms: mask `nm = (nm + K) & M` and the reset pair `nm += K; if (nm >= C) nm = 0` (`interval-proof.js:1099-1134`). There is no `%` form, so no `[0, M-1]` hull for `p`. The summary has `ptr = (ptr + 1) % m` support only through `split-bindings` `versionRest` declared guards on array-length divisors (`summary/index.js:1230-1250`, comments), not for a constant modulus on a plain counter.
3. `ringLaps` (post-watr, `ring-laps.js:92-113`) accepts `% m` (and `lt_u` three-arm and mask), but only after `p` is an i32 local; with f64 `p` it never sees the shape.

---------------------------------------------------------------------------

## 5. Where a canonicalization pass could sit

### Earliest point
After `splitReassigned` at the end of prepare (`prepare/entry.js:336`, loops over `ctx.funcs.list`), or at the end of `frontHalf` after `preEval` (`front.js:46`), and in any case before `ctx.summary = summarizeProgram()` (`compile/index.js:246`), because `summary/index.js:1178` already reads counted loops. Reasons it is the right altitude (V):
- All source loop forms are only `for` (5-ary) and `while` (+ `label`, `break`, `continue`) here; `do`, for-of, for-in, captured-let loops were already lowered by jzify/prepare; names are unique (`split-bindings.js:22` states "every local is named apart"), so hoisting/renaming is safe.
- Nothing has read the loop yet; every private matcher in section 3 runs later.
- Cost: kinds are not known yet (the summary comes after). A purely syntactic canonicalizer must therefore only rewrite what is value-exact without kinds. Safe examples: `N > i` -> `i < N` and `N >= i` -> `i <= N` (identical truth including NaN and strings), `i += 1`, `i = i + 1`, `i = 1 + i`, `i -= -1`, `(i+1)|0` -> `++i` ONLY when `i` is initialized by a numeric literal and every write of `i` is one of these numeric step forms (then `i` is a Number by induction; `1 + i` vs `i + 1` differ for strings). `i !== N` -> `i < N` is NOT value-exact (needs int/start checks, that is what `unitWalk` guards at runtime), so it must stay a kind-dependent plan step.
- Loops that appear after this point: inlined callee bodies copy canonical sources; the plan passes that synthesize loops already emit canonical `['for',['let',['=',i,a]],['<',i,b],['++',i],body]`; `unitWalk` emits `while`, so it should emit `for`.
- What the front-end cannot reach: callback/stdlib loops (born as WAT). For those the single form to canonicalize is WAT: have `arrayLoop` (`ir/arrays.js:68`) and `typedLoop` (`module/typedarray.js:3295`) share ONE constructor and make `matchExitBrIf` accept exactly what it emits. They emit `(br_if $brk (i32.ge_s i len))` (a positive compare, not `eqz(lt_s)`). R: `for` dot vectorizes, `a.forEach`, `a.reduce` and `for (const x of a)` reductions have v128=0 (map has 4). I did not trace why; it may be this mismatch or the closure/summary route.

### What it must preserve (V, with the existing guard in the code)
1. Per-iteration `let` bindings captured by closures: prepare already rewrites them into a `for(;;)` with carrier locals and a `first` flag (`handlers.js:1405-1424`); do not pattern-match inside that; every existing matcher bails on `captured.has(i)` (e.g. `counted-loops.js:canonicalize`, `integral-loops.js` "a closure ... is left alone"). Treat "counter or body-declared name captured" as not counted.
2. `continue`: with a step slot the emitter wraps the body in `(block $cont …)` (`control-flow.js:1353-1356`); a `while` with the step inside the body must not move that step into a `for` head if a `continue` of this loop exists in the body (it would skip the step, or run it once more); `do`'s flag form already makes `continue` jump to the test, which is the correct do-while semantics.
3. Labeled `break`/`continue`: a label is adopted by the immediately-enclosed loop (`control-flow.js:777-790`, `contLabel`, `withPendingLabel`); wrapping the loop in an `if`/block (as `unitWalk` does) breaks that, which is why `unitWalk` refuses when `parent[0]==='label'` or the body has a labeled jump (`counted-loops.js:203,256`).
4. Evaluation order and count of the bound: the test runs every iteration. prepare keeps `(arr.length|0)` inline for that reason (`handlers.js:1448-1455`); for-in hoists its length (JS semantics differ: keys snapshot). A canonical `i < n` with a hoisted `n` needs an invariance proof (`closureMutatedVars` + `loopHazards`, `loop-model.js:65,100`); a bound with calls/effects stays in the test; `immutableLenBound` (`control-flow.js:491`) is the existing proof for typed arrays.
5. Bound that changes in the loop: do not rewrite, and do not claim a trip count.
6. Counter exactness: -0, NaN, fractions, > 2^53 (that is what `unitWalk`'s `typeof x==='number' && x===floor(x)` runtime guard and `canonicalize`'s `v === floor(v)` arm are for).
7. do-while: body runs once before the first test. A canonical form needs "bottom-tested" loops to be first-class (an AST `do` node the emitter lowers to `loop BODY (br_if C)`, or a flag form the induction analysis understands), otherwise `<`-guarded trip counts (`max(1, N-i0)`) are wrong. Today emit dies on a raw `do` ("Unknown op: do", `handlers.js:865`).

### Existing partial canonicalizers (name them)
- `prepare/handlers.js`: for-of/for-in -> counted `for` with `++idx` and `i < (len|0)` (1489-1580); `do` -> flag `while` (867); `dropDeadPostfix` (step spelling); `.length` bound wrap (1456); captured-let copy (1405). `jzify/transform.js:737` (do), `jzify/arguments.js:140` (`for…of arguments`).
- `plan/counted-loops.js`: `unitWalks` (`!==` -> `<`/`>` copies, while only), `guardConstants`, `canonicalizeCountedLoops` (cursor -> `c+K·k`, `offsetTest`), `adoptLoopCounters`.
- `plan/integral-loops.js`: `canonicalHead` (multi-counter head -> one counter), integral versions (i32 words, `(i+1)|0` step).
- `loop-square.js` (`i*i < C` -> `i < L`), `plan/loops.js` split scans (bound -> `Math.min(B,len)` + tail), `peel-stencil.js`, `loop-divmod.js`.
- WAT: `vectorize/scaffold.js` `canonicalizeIfBr`/`normalizeTransparentBlocks`/`foldVecIdentities`; `optimize/rotate-loops.js` (top test -> bottom test, tape); watr `loopify`/`lsr` (external, not read).
- The one bridge between levels: `ctx.plans.loweringLinks` (set at `control-flow.js:1485`, read at `vectorize/index.js:260` and `peephole.js:525`; fail-open: any rewrite of the node drops the facts, `ir/control.js` comment).

---------------------------------------------------------------------------

## 6. Not determined / unverified
- Timings (3.3x, 12x, etc.) not re-measured; no benchmarks run (as instructed).
- Why `forEach`/`reduce`/for-of reductions do not vectorize (observed v128=0); whether the `i32.ge_s` exit of `arrayLoop` is normalized to `eqz(lt_s)` before `matchExitBrIf` (fusedRewrite/`canonicalizeIfBr` might do it): not traced.
- Exact consumer that types an unbounded counter local f64 (inferred from the probes and the doc comments); the interplay of `integral-loops` copies with `i`/`p` in (c)/(d) (copy named `iint5`, `__iv1_0` appears in the ring dump) not traced.
- Whether strict mode (`jzify` skipped) differs for loops other than `do`: not run.
- The ~20 other vectorize/ files, sink/early/lead-chains/loop-compact/int-range/flow-range: read by grep only; I did not find a private IV matcher in them but could have missed one.
- The approximate "accepted by N" counts in 3I are from code reading + grep; treat as +-3.
- `watr`'s loop passes (external dep) not examined.
