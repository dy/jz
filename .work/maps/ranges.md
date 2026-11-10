# Scout report: range / integer / kind proofs in jz (tree: .claude/worktrees/v1, HEAD b33e45ec7)

Model: Sonnet 5.5. Nothing in any repo or worktree was modified. Experiments used compiles through
`/Users/div/projects/jz/.claude/worktrees/v1/index.js`, plus an instrumented COPY of the tree in
`scratchpad/jzcopy` (logging only, plus two one-line patches used as experiments; never applied to the repo).

Legend: [V] verified (read the code, or ran a compile / instrumented copy). [I] inferred.

---------------------------------------------------------------------------------------------------

## 1. Inventory

Levels: AST = prepared source AST (`['+', a, b]` arrays); WAT = WAT s-expression arrays; SUM = summary records
(`ctx.summary`); RT = runtime-guarded source rewrite. No range analysis reads the tape: `ir/tape.js` is imported only
by link/ and a few structural passes (sort-locals, fold, arena-rewind, rotate-loops, fn) [V by importer grep].

| # | Module (LOC) | Level | Fact = lattice | Loops | Scope | Callers | Consumers |
|---|---|---|---|---|---|---|---|
| 1 | summary/index.js (6,242; numeric parts ~lines 770-1260, 1455, 2866) + kind.js (213) + num-range.js (135) + span.js (25) + query.js (1,027) | SUM over AST | kind = bitset of 17 tags + 16-bit parameter; numeric = `{lo,hi,int,nz,gap}` (num-range) for array cells, callback params, call results; plain `[lo,hi]` (`rangeOf`, `spanOf`, `hulls`) | whole-program fixpoint; ranges "open after 4 raises" (`widened`, index.js:783-789); hulls only ever lost (`keepHull`, :1235) | interprocedural | built once in session; read via `ctx.summary.at(body)` | `kindOfExpr`/`valOfExpr` everywhere (expr-type.js, int-certain.js:132, interval-proof.js:42), `wordReadRange` (static.js:207, expr-type.js:140), `paramRangesOf` (analyze-for-emit.js:233, emit-func.js:163) |
| 2 | type/int-certain.js (282) | AST | per-name level 0/1/2: 0 unknown, 1 integral (range-open), 2 strict int32 and never -0. No interval. | optimistic greatest fixpoint over defs, `while (changed)` (:236-246); no widening needed (finite height 3) | per function; params seeded from `intLevel` of narrow/int-params | body-facts.js:723 (`widenLocalTypes`), val-types.js:466 (rep `intCertain`), analyze-for-emit.js:559 (closure cells), emit/arithmetic.js:66, counted-loops.js:666, scope.js:547, narrow/param-abi.js:35, narrow/int-params.js:66,81, slot-int-census.js:118,123 | local wasm type (`keepI32`), `Math.floor` elision, typed-key conversion, cell width |
| 3 | type/expr-type.js (342) `exprType` | AST | per expression `'i32'|'f64'`; no lattice, one recursion; reads `repOf(n).range` through `intExprRange` | none | per function | body-facts.js (walk 517, `widenValue` 763), emit paths | local type, result narrowing; header says emit.js DECIDES and this mirrors: "decided in TWO places that must agree" |
| 4 | static.js (956): `intExprRange`, `constIntExpr`, `forCounterRange`, `typedValueExprRange` | AST | expression -> `[lo,hi]` from literals + `rep.range` + branch `refinements` | none | per function | ~everywhere (expr-type, interval-proof, analyze-scans, loop-versioning, integral-loops, i32-bounds) | evaluator over ranges stamped by #5/#6 |
| 5 | compile/analyze-scans.js `stampLoopCounterRanges` + `stampBodyRanges` (lines 1516-1810 of 1,897) | AST | `rep.range = [lo,hi]` per binding, hull of ALL writes (flow-insensitive); counted loops give trips x step deltas | `while (changed)` over defs (:1779), "cycles never seed themselves"; one hard-coded ring rule `hullOver`/`defRangeOf` (:1649-1672, :1795-1802) | per function | body-facts.js:562,580,583 (and :140-142) | `rep.range` (read by #3, #4), `collectI32SafeIndexVars` (:1812) |
| 6 | type/interval-proof.js (1,541) | AST | env name -> `[lo,hi]` (+ symbolic wrap/mask "field" facts); outputs index proofs, arg hulls, store hulls, binding hulls | real fixpoint: 2-round widening join to i32 extreme, verify, <=2 narrowing passes (:575-720); nest costs ~5^depth walks (:62-66) | per function; entry ranges in, arg/store hulls out | body-facts.js:136,297; narrow/summaries.js:120,138 | `typedIdxProven` class 5 -> clone.js:75, loop-versioning.js:101,136,710, loop-versioning-nest.js:92, sentinel-guard.js:152; binding hulls -> `rep.range` only when `optimize.intervalRanges` (body-facts.js:573) |
| 7 | type/canonical-bounds.js (723), loop-versioning.js (748), loop-versioning-nest.js (304), bounded-counters.js (172), loop-unroll.js (96) | AST | boolean proofs by shape: canonical `for (i = C; i < recv.length; i++)`, advance budgets (`maxAdvanceBudget`), `idxKey` bounds-channel | none | per loop | emit/shared.js (`inBoundsArrIdx`), expr-type.js (`inBoundsCharCodeAt`), analyze-for-emit.js:34, twin-locals, carry-elements, integral-loops.js:168 | bounds-check elision, typed extent guard (runtime) |
| 8 | compile/narrow/{int-params 89, summaries 951, param-abi 548, results 429, element-bounds 183} | AST + sigs | `intLevel` per param; `arrayElemRange` per param/local (`inferElementParamRanges`); typed store hulls (`inferTypedValueRanges`); fixed lengths; closed index buffers | `while (changed)` monotone fixpoints (summaries.js:817-858) | interprocedural | compile/narrow/index.js | param/result ABI types, `rep.arrayElemRange` (static.js:209, analyze-scans.js:1634) |
| 9 | compile/program-facts/slot-int-census.js (241) | AST | schema slot (sid, idx) intCertain; "any non-int write anywhere poisons" | per-body fixpoint then global poison | whole program | analyze-for-emit.js:360, ctx.schema | `slotIntCertainAt`, `slotI32CertainAt` (expr-type.js:156) |
| 10 | optimize/int-range.js (1,138) | WAT | `{lo,hi,int,nz,nan}` per i32/i64/f64 local and node; i64 bit-carrier `{of,mask}` for NaN-boxed values | fixpoint: head = hull(entry, back edges); widen to infinity after 2 walks; 2 narrowing walks (header, :19-27); whole function re-walked per head | per function (+ `assume` entry facts from specialized loops) | driver.js:176 (via int-narrow), to-int32.js:230, select-arms.js:157, unsigned-div.js:43 | int-narrow (retype f64 locals), ToInt32 lowering, select arms, unsigned div |
| 11 | optimize/int-narrow.js (890) | WAT | consumer; chooses `N` map local -> i32/i64 by cost (gain/cost/held, loop weight 4^depth) | greatest fixpoint dropping unprofitable locals (:206-215) | per function | driver.js:172-179 | rewrites locals and ops |
| 12 | optimize/word-ranges.js (356) | WAT, i32 only | `{lo,hi}` per i32 local/expression | widen to the next comparison bound, then to none; narrow 3 passes (header :6-17; `WIDEN_AFTER=2, PASSES=4, NARROW=3`) | per function | wide-accumulator.js:147, const-bases.js:48 | trip counts, constant bases |
| 13 | optimize/flow-range.js (136) + ir/numeric.js `f64Range` (lines 410-557 of 747) | WAT | `{lo,hi}` tag on `local.get` nodes (`node.range`); `f64Range` value-based range | none: "locals a loop writes are unknown at its head" | per function; param entry from `fn.paramRanges` | peephole.js:355, vectorize/map.js:55; f64Range via ir.js (peephole.js:14, map.js:5, numeric.js `i32Narrowed`:558) | ToInt32 elision, i32 narrowing of f64 expressions |
| 14 | emit/i32-bounds.js (136), `i32Magnitude` in emit/arithmetic.js (~:60-100), flow-types.js refinements `rlo/rhi` (:353-354) | AST at emit | magnitude bound / branch-local interval refinement | none | per branch | emit/* | choose i32 vs f64 arithmetic at emit |
| 15 | compile/plan/integral-loops.js (2,204), counted-loops.js (754) | AST -> RT | symbolic hulls `[exprLo, exprHi]` (endpoints are AST expressions) + guards | internal `step`/`absorb`/`join`/`refine` walks (:1517-1700) | per loop | plan/index.js:296 | versioned loop copies |
| 16 | kind/val-type-of.js (854), reps.js VAL, analyze/val-types.js (469) | AST | second kind lattice (`VAL.*`) beside summary K tags; summary `valOf` bridges | per function | | emit | representation choices |

Paragraphs (what each can and cannot prove):

- **Summary (1)** [V]. Strongest kind engine: flow-insensitive join per binding, per slot, per parameter (all callers), per result,
  with three finer regions (before first reassignment, after straight-line assignment, under a guard). Numeric facts are a second,
  smaller lattice (num-range) attached only to array cells, callback params and some call results; locals have only `hulls`
  (a `let` with a `d.lo` from split-bindings guards, index.js:1220-1260) and `lengthAliases`/`indexBounds` (the `ptr = (ptr + 1) % m`
  special case, :1241). It cannot give a plain local an interval in general; ranges widen by raise counting, not by loop-head join.
  Exported functions' parameters are ANY (host can call).
- **int-certain (2)** [V]. 3-level integrality, no intervals. `%` is capped at level 1 (int-certain.js:155-163, "Never strict: `-5 % 5`
  is -0"), `+ - *` level 1 "integral-closed, range-open" (:149-153). Level 2 only from literals, comparisons, bit ops, imul/clz32.
  So a `%` result can never be strict int32 here, whatever the dividend's range.
- **exprType + static.js (3,4)** [V]. Expression-local rules, each op re-derived by hand (`%` at expr-type.js:207-228 needs
  `intExprRange(dividend)[0] >= 0` and constant/positive divisor). They are only as good as `rep.range`.
- **stampBodyRanges (5)** [V]. Hull-of-all-writes plus counted-loop trips; no flow sensitivity; a single ring special case (`hullOver`).
- **interval-proof (6)** [V]. Closest thing to the intended design at AST level: env of intervals, widening join, verify, narrowing.
  But it serves index proofs; its binding hulls reach `rep.range` only under `optimize.intervalRanges` (body-facts.js:573), and
  its `%` rule requires `B[0] === B[1]` literal-ish divisor and non-negative A (:329, :361).
- **canonical-bounds / loop-versioning (7)** [V]. Shape recognizers answering booleans (in bounds yes/no), with a runtime extent
  guard as fallback; no values.
- **narrow/* (8)** [V]. Whole-program param/element facts (a third and fourth interprocedural range fixpoint besides the summary's
  `argRanges` and interval-proof's arg hulls).
- **int-range (10)** [V]. Full-featured WAT abstract interpreter with NaN/-0/int flags and the bit-carrier for NaN-boxed values. Its
  `%` support is a pattern match on the emitter's lowering `copysign(x - trunc(x / K) * K, x)` (`remainderOf`, :296-307), and that rule
  has a hole (see Q3).
- **word-ranges (12)** [V]. Same idea as 10 restricted to i32, own widening scheme (thresholds); supports `i32.rem_u` only (:274).
- **flow-range (13)** [V]. Branch refinement only; loop-written locals are unknown at the head.
- **integral-loops (15)** [V]. Not an analysis consumer but a fifth analysis engine in disguise (symbolic hulls, see Q4).

---------------------------------------------------------------------------------------------------

## 2. Overlap (same fact derived by several modules; can they disagree?)

**"`x % K` (K positive constant) is within [0, K-1] / an int32"**: derived at 12+ sites [V by grep]:
static.js:301-325; interval-proof.js:329 and :361; analyze-scans.js:1649-1672 (`hullOver`/`defRangeOf`) and :1795-1802;
summary/index.js:977 (`rangeOf`) and :1241 (`keepHull`); summary/num-range.js:80; int-range.js:296/840/960;
word-ranges.js:274 (rem_u only); ir/numeric.js:470 (f64Range copysign); emit/arithmetic.js:94 (`i32Magnitude`);
int-certain.js:155; expr-type.js:207. They DO disagree [V, observed on the ring cursor]: with `M` a module const,
exprType/static.js read p's range as `[-15,15]` (p+1 as `[-14,16]`) while the literal-16 spelling gives `[0,15]`
(p+1 as `[1,16]`); int-certain caps `%` at level 1 while `&` is level 2; int-range gives `NUMBER` after widening
where the AST layers give `[0,15]`.

**"this local is an int32"**: exprType + widenLocalTypes (body-facts), int-certain levels, rep.range hulls (stamp*, interval-proof),
summary hulls/nr, narrow/int-params, slot-int-census, closure-cell narrowing (analyze-for-emit.js:559), int-narrow (WAT, after
emission), word-ranges (WAT). Disagreement examples [V]: the AST decision says f64 (`% M`) and int-narrow later also refuses
(Q3); `collectI32SafeIndexVars` flips f64 back to i32 (analyze-scans.js:1820) and `widenValue` flips it to f64 again (body-facts.js:763).
Decisions go both directions across stages; nothing reconciles them except order.

**"index within the array's length"**: interval-proof (class 5), canonical-bounds recognizer, loop-versioning (runtime extent),
summary `wordReadRange`/`indexBounds`/`lengthAliases`, element-bounds (closed index buffers), counted-loops/integral-loops
guards, emit/shared `inBoundsArrIdx`, narrow/summaries `boundedByCallerLength`. Same `idxKey` string channel carries some of them
(canonical-bounds.js:25); others are separate. Can disagree only conservatively (each is sound alone), so the cost is missed proofs.

**"value is non-negative"**: static.js `&`/`>>>` rules, interval-proof `nonNegIntegers`, word-ranges `lo >= 0`, int-range `lo`,
summary nr (`a.lo >= 0 && a.nz`), analyze-scans "nonnegative invariant" (:1795-1799), int-certain (`-0` avoidance, level 2 only).

**"index/element is a Number or integer array element range"**: summary `elemNums` (num-range), narrow/summaries `arrayElemRange`
(`inferElementParamRanges`, `inferTypedValueRanges`), static.js `typedValueExprRange`, typed-element width in `rangeOf`
(analyze-scans.js:1636-1642). Three interprocedural fixpoints for one kind of fact.

---------------------------------------------------------------------------------------------------

## 3. Where a local's wasm type is decided; why `p = (p + 1) % M` stays f64

Experiments [V]: module consts `M = 16`, `N = 4096`; loop body `s += x[i] - ring[p]; ring[p] = x[i]; y[i] = s;`.

| update of p | optimize:false | speed | size |
|---|---|---|---|
| `p = (p + 1) % M` | `$p f64` | `$p f64` | `$p f64` |
| `p = (p + 1) % 16` | i32 | i32 | - |
| `p = (p + 1) & (M - 1)` | i32 | i32 (+ ring-laps loops) | i32 |
| `p = (p + 1) % M | 0` | i32 | i32 | - |
| `p++; if (p === 16) p = 0` | f64 | p eliminated | - |
| `if (++p >= 16) p = 0` | f64 | i32 | - |
| `p = p + 1 === 16 ? 0 : p + 1` | f64 | f64 | - |

All variants return the Node result (1999.625) [V: run.mjs, both spellings, optimize speed and false]. (The printed WAT of the `&` case
shows two locals both named `$cse0`, an i32 and an f64; the compiled module validates and matches Node, so it is a text artifact.)

**Stages and whether revisited** [V]:
1. `analyzeBody` (compile/analyze/body-facts.js) builds `ctx.func.locals` (name -> i32|f64). Instrumented trace for p (`SET` log):
   `processDecl` sets i32 from the initializer `0` (body-facts.js:335); the walk of `p = ...` widens it to f64 because `exprType(rhs)` is
   f64 at that moment (:517; the range of `p` is not yet stamped); `collectI32SafeIndexVars` narrows it back to i32 because
   `ring[p]` is a dynamic index and `escapeInRangeI32(p)` holds (analyze-scans.js:1820); then `widenLocalTypes` -> `widenValue`
   re-widens to f64 if `exprType(rhs)` is still f64 (body-facts.js:763, loop :778-799). The fixed outcome is whatever the last flip was.
   This stage IS revisited: `reanalyzeBody`/`invalidateBodies` re-run it after signature narrowing (narrow/*).
2. Emit declares WAT locals from that map.
3. Optimizer `narrowInts` (optimize/int-narrow.js, driver.js:172) can retype an f64 local to i32/i64 from `int-range` facts; this
   is the only post-emission revisit, and only when the cost model scores positive (:195-215).
4. plan/integral-loops.js (before emit) introduces fresh i32 aliases `x$ = x | 0` under runtime guards.

**Why the `%` spelling fails, two independent causes** [V by instrumentation]:

(a) AST stage. `exprType` for `%` (expr-type.js:207-228) returns i32 only if `intExprRange(p + 1)[0] >= 0` and the divisor is a positive
constant (it handles module consts through `constInts`). p's `rep.range` comes from `stampBodyRanges` (analyze-scans.js:1779-1802):
`defRangeOf` (:1665-1672) gives `[1-k, k-1] = [-15, 15]`, then the code tries to prove the nonnegative invariant with
`hullOver(rhs, name, [0, hi])` (:1795-1799). `hullOver` resolves a name by

    if (typeof n === 'string') return n === self ? bound : repOf(n)?.range ?? null     // analyze-scans.js:1650

and `constNumExpr(n)` is called without a resolver, so a module-const name `M` yields null, `hullOver` fails, p stays `[-15,15]`,
`p + 1` is `[-14,16]`, `%` is not provably non-negative, `exprType` stays f64 and `widenValue` re-widens. With the literal `16`
the same code path yields `[0,15]` and i32. Trace (instrumented copy, `REM` log): M: `range [ -14, 16 ]`; literal: `range [ 1, 16 ]`.
Experiment: in the COPY, changing that one line to fall back to `constIntExpr(n)` made `$p` i32 for `% M` [V]. The repo was not changed.

(b) WAT stage (why int-narrow does not rescue it). The emitted write of p is the full lowering
`copysign(sub(add(p,1), mul(trunc(div(add(p,1), 16)), 16)), add(p,1))`; `remainderOf` matches it (int-range.js:296-307) but the rule at
int-range.js:840-844 is

    return isInt(v) ? val(...[0..k-1]...) : v ? NUMBER : null

and `isInt` demands finite bounds within 2^52 and no NaN (int-range.js:54). The loop head widens `p` to `[0, +inf)` after two walks
(`REMV` log: p+1 = [1,1], [1,2], [1,3], then `{lo:1, hi:Infinity, int:true}` -> `isInt` false -> NUMBER), the NUMBER write poisons the head
to `{nan:true, int:false}`, the narrowing phase cannot take it back, and `integerPlan` sees a non-integer write (int-narrow.js:113-116)
so `N` never contains p. The result of `x % K` for an integer, non-NaN dividend with `lo >= 0` is in `[0, K-1]` however the dividend
is bounded above, so the transfer function is non-monotone only because of the `isInt` precondition. (`int-narrow` additionally
sees `ring[p]` reads as the magic-add ToInt32 form `i64.reinterpret(f64.add p 1.5*2^52)`, which `use()` classifies `'f64'`
(int-narrow.js:150), scoring against narrowing even if the writes were integer: [I], not isolated.)

`& (M - 1)` works because `&` is `i32` unconditionally in exprType (expr-type.js:~165-186), level 2 in int-certain (:111), and
`intExprRange` has `[0, m]` for a mask (static.js:255-265): no range of p is needed.

**Rule that would have to exist**: for `a % K`, K a constant integer > 0 (resolved through module consts everywhere a constant is
read) and `a` an integer with `lo >= 0` (not -0, not NaN): result `{int, lo: 0, hi: min(a.hi, K-1), nz: false, nan: false}` with NO
finiteness requirement on `a.hi`; for `a.lo < 0` the result is `[max(a.lo, 1-K), min(a.hi, K-1)]`, `nz` true. With that single transfer
function in one lattice, `p = (p + 1) % K` gives head `[0, K-1]` at the first widening step and the cursor is i32 with no pattern
match on source spelling or on emitter lowering. The rule exists in at least 12 forms already (Q2); none is shared.

---------------------------------------------------------------------------------------------------

## 4. Versioning (plan/integral-loops.js)

Outline [V, header :1-160, mechanism :533-2166]:
- Entry `versionIntegralLoops` (:2167) runs per function and per closure body; called from plan/index.js:296 (`sweep('versionIntegralLoops')`),
  speed-for-size (config.js:156 turns it off in the size tier).
- For each `for`/`while` it chooses "names" (locals/params the loop reads from before it whose values reach an element index through
  `+ - * % ?: & | ...`), "cursors", "counters", "numbers" (typeof tests), "present" names, plus derived ints and "bail" sums.
- Run-time test built as one conjunction (`conj`, :2113-2124): `typeof x === 'number' && x === (x$ = x | 0) && (x !== 0 || 1/x > 0)` per name;
  counter bound tests; positivity of moving bounds and divisors; `typeof` for number kinds; `!= null` for presence; inner-copy
  tests; cursor budget tests (entry plus trips x step fits i32); word tests for wide sums.
- Clones: `copy = cloneWithSubst(loop, ..., own)` (names renamed to fresh `x$`); `version` block = declarations + copy + write-back of
  what the copy wrote + optional bail resume; `asWritten` = the original loop, marked `cold` (also every inner loop in it); `resumption()`
  = a third copy of the loop (from the copy's counter) when a sum can wrap and the copy "bails" like a JIT deopt. So one loop becomes
  up to three loop bodies (copy, as-written, resumption), plus the inner versions it absorbs.
- Nests: inner loops are versioned first (post-order list `loops`), an enclosing copy absorbs an inner version whose names are its own
  words (`absorbs`, :1960-2030) or hoists its test, so a nest multiplies unless absorbed. [V reading; not measured]
- Growth limits: per loop `MAX_SIZE = 800` nodes counting inner versions as written (:179, :638-640); per function `grown > SOURCE_FULL`
  (3000 source nodes, growth.js:70) stops all but "kernel loops" (`kernelLoop`, growth.js:81, loops calling only math kernels,
  integer conversion, remainder, throw); no cap on the number of copies as such. Optimizer-level copies use `IR_FULL = 13000` (growth.js:77).
- Other versioning mechanisms exist beside it [V by names/headers]: type/loop-versioning (typed extent guards, emit-level, a checked
  twin), plan/kind-split, plan/unswitch-loops + optimize/unswitch, optimize/specialize (+ `assume` into int-range), prepare/split-bindings
  `versionRest`, optimize/ring-laps, wide-accumulator. I did not read these beyond headers.

Share of the 2,200 lines (estimate [I], by function map): header comment ~160 (7%); small pattern/shape helpers (:172-530,
`integral`, `litStep`, `indexNames`, `numberNames`, `canonicalHead`, ...) ~360 (16%); per-loop analysis closures inside `versionBody`
(:645-1960: `fractional`, `stableTerms`, `elementRange`, `linkWalk`, `ring`, `steppedBy`, `counterHull`, `hullOf`, `floatHull`, `refine`,
`absorb`, `join`, `wordHull`, `stepHull`, `sumSite`, `step`) ~1,300 (59%); versioning mechanism proper (loop list, size gating, own-name
renaming, guard assembly, clone, write-back, bail/resume, bookkeeping: :533-645 and :1960-2166) ~320-350 (15-16%). So ~75% matches
written forms or is an abstract interpreter over AST with symbolic endpoints; ~15% is versioning.

Static proofs that would make a copy unnecessary (from the header's own list) [I]:
1. Cursor `p` ring-stepped (`qHead++; if (qHead >= QN) qHead = 0`, `(p+1) % N`): interval `[0, N-1]` by head-join + guard refinement (needs the `%` rule and branch refinement in the loop lattice). The header says "stays below its bound whatever the trips".
2. Literal-bounded loop trips x literal steps: counter/cursor intervals from trip count (a counted-loop interval with entry + step * trips); already partly in `stampLoopCounterRanges`.
3. Derived ints (`rowC = y * w`, `c = rowC + x`): interval arithmetic over counter ranges and parameters proven integral/ranged by all callers (int-params, argRanges).
4. A module const or all-callers-integral param (`hblur(img, tmp, W, H, R)` under `const W = 512`): already proven (header notes the copy would guard what the emitter proves), i.e. an existing duplicate proof path.
5. Number kind and presence (`typeof x === 'number'`, `x != null`): kind lattice (summary) where all writers are Numbers; the copies exist because the summary lost the kind (field of a record, mixed storage).
6. Links walk (`j = next[j]`, ints-or-miss): integrality plus a `maybe-miss` flag on an Int32Array element read.
Not statically provable (copy or guard stays): values read from exported-function params or host-written storage; sums of full-range int32 elements (`up + 1`; needs the wrap/bail form); a cursor entering from `let r = off[g]` with no range.

---------------------------------------------------------------------------------------------------

## 5. Alias / memory-dependence analyses

[V from headers and importers; call-graph beyond importers not exhaustive]

| Analysis | Path (LOC) | Level | Answers | Users |
|---|---|---|---|---|
| Summary-cell marks `mayAlias` | ir/mem-alias.js (68) | WAT nodes marked by emit (`node.mem`: `e<cell>`, `f<slot>:<sid,..>`) | do two marked accesses possibly touch the same bytes (disjoint allocation cells / layouts) | optimize/forward-store.js:27,155; reuse-loads.js:17; sink-stores.js:41,167; marks set in compile/emit-assign.js:42 |
| Source-level load CSE disjointness | compile/cse-load.js (672) (+ `provablyDiffer`, `indexFacts`) | AST | survives a store? (receiver family differs; summary proves disjoint cells; same grid and index provably different) | analyze-for-emit.js:29, carry-elements.js:43 |
| Lane-lift dependence | optimize/vectorize/alias.js (351), addr-model.js (713, `buildAliasClass` = one universal class stub, :548-560), stencil.js ("distinct bases assumed non-aliasing", :165), memcpy.js overlap guard | WAT | same-array distance between store and loads at lane stride (linear index difference); runtime disjointness guard per distinct base | vectorize map/stencil/reduce/dot-slp |
| Store motion disjointness | optimize/early-stores.js (`distinctParams`, same base disjoint bytes), optimize/licm.js (effect-summary barriers, :137, :243), optimize/globals.js (per-function typed-global write sets, `*` unknown aliasing :422), optimize/cse-address.js | WAT | may statement reorder/hoist across a store | driver |
| Name aliasing (not memory) | compile/plan/alias.js (290) | AST | binding b is only a copy of a | plan |
| Object identity aliasing | compile/inplace-store.js (349) | AST | can anyone hold the old element object | plan/emit |

So: 3 memory-dependence analyses at three levels (ir/mem-alias, cse-load, vectorize/alias) + store-motion checks inside early-stores/licm/globals,
+ 2 non-memory alias analyses. Facts shared among them: only summary cell ids (mem-alias, cse-load); vectorize/alias and early-stores
use structural base comparison and `distinctParams` instead.

---------------------------------------------------------------------------------------------------

## 6. Arrays: element kind of `const a = []; a.push(i * 2)`, and `reduce`/`map` pulling `__to_str`

Element kind of a plain array [V]: the summary keeps one cell per allocation site; each `push`/store/literal element joins its kind
into the cell (`elems`, `elemOf(recv)`), and numbers join into `elemNums` (num-range) with the 4-raise widening. `a.push(i*2)` gives
`ARRAY(cell)` with element kind NUMBER. Confirmed by compiles: for the array built by push, `for (const x of a) s += x`,
`for (i) s += a[i]`, `a.map(x => x + 1)` then summing `b[i]`, and `a.filter(...)`.length all compile clean (no `__to_str`, `__str_join`,
`__add_slow`) [V, arr2.mjs].

What does NOT hold: `a.map(x => x + 1)` pulled string helpers in none of my 4 map variants [V]. `a.reduce(...)` pulls them in every
variant, even on the literal array `[1,2,3]` and for `s - x` and `Math.max(s, x)` [V]:

| case | WAT bytes | pulls |
|---|---|---|
| literal `[1,2,3]` `.reduce((s,x)=>s+x, 0)` | 153,444 | `__to_str`, `__str_join`, `__add_slow` |
| same with `s - x`, `Math.max(s,x)` | 198,371 / 198,563 | `__to_str`, `__str_join` |
| push-built array, `.reduce((s,x)=>s+x*1, 0)` | 277,692 | same |
| same arrays with for / for-of / map+loop | 6.8k-124k | none |

Missing fact [V by code + experiment]: module/array.js:2645 (`.reduce` base path) hard-codes the accumulator's representation
`const accRep = { tagged: true }` ("Its kind can change during the fold"); the same `{ tagged: true }` is used in the fused map/filter
reduce paths (:2574, :2605). `makeCallback` (module/array/callback.js:169-176) turns an inline callback's `argReps[i].val` into the
local's VAL overlay (`ctx.func.localValTypesOverlay.set(fresh, val)`); with no `val` on the accumulator, `s + x` inside the callback is the
generic `+` (string-or-number) and drags in `__add_slow` -> `__to_str` -> number formatting (ryu) -> `__str_join`/concat.
The summary DOES solve the accumulator: `reduceResult` (summary/index.js:2870-2884) binds callback param 0 to
`merge(initial, prior callback result)` as a monotone fixpoint, so the NUMBER kind of the accumulator is known to the summary at the
callback's own parameter binding [V read; the value itself I did not query]. It is not consulted because inline callbacks substitute
fresh temps (`inl_*`) that did not exist at analysis time (callback.js:161-168 comment).
Experiment in the COPY: `accRep = { tagged: true, val: VAL.NUMBER }` turned the literal-array reduce from 153 KB to 11 KB with no string helpers
(`s+x`, `s+x*1`, `s-x`) [V]; `Math.max(s, x)` stayed heavy [V], a separate pull not investigated. That edit is unsound in general
(an accumulator that can turn into a string); the sound version reads the summary's kind of the callback's first parameter
(`ctx.summary.at(fn[1]).kindOf(param0)` or the equivalent per-binding query) and sets `val` only when it is NUMBER-only. Where to derive it: the
summary already derives it; the consumer is `callbackArgReps` / the `.reduce` emit (module/array.js:2640-2650), `callbackArgReps` being the
place that already maps element kind to `val`.

---------------------------------------------------------------------------------------------------

## What I could not determine

- Per-case exact behaviour of `Math.max(s, x)` in reduce (still pulls `__to_str` after the accumulator fix).
- Whether summary `rangeOf` hulls (summary/index.js:1220-1260) reach any local's wasm type (I saw `paramRangesOf` consumers; not `hulls`).
- Exact lines-of-code split inside summary/index.js between kinds and numerics (sampled only).
- Growth of nests under integral-loops (copy counts) measured: not measured; read from code only.
- The remaining versioning passes (kind-split, unswitch x2, specialize, split-bindings, ring-laps) beyond names/headers.
- Callers of `intLevelMap` by file:line are complete for src/ (grep), but callers of `exprType` are many and not enumerated.
- Whether `int-narrow` would narrow p if its writes were proven integral (the `use()` classification of magic-add reads in int-narrow.js:150 counts against) is inferred, not tested.
- The `% | 0` variants showed an `f64.trunc`/copysign remainder still in the body next to an i32 local; not investigated.
- The instrumented copy lives at `scratchpad/jzcopy` (two experimental one-line patches: analyze-scans.js:1650, module/array.js:2645) plus logging; delete if unwanted.
