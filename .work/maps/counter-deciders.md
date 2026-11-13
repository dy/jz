Scout report (Sonnet 5.5, 2026-11-13), tree `557fbd525`, read-only. Leads, not facts: V = the
scout read the line or ran the command, I = inferred. The integrator compiled five of the
reduced programs of `counter-census.md` on the same tree and saw the same f64 locals; nothing
else here is re-derived. `SCRATCH/counter-widths/` in the text is session scratch (the reduced
programs, the tree of `e88a8e907`, the instrumentation patch, the raw rows): not in the repo.

# deciders.md: every place that decides a local is an i32 today

Model: claude-sonnet-5-5. Tree: `main` 557fbd525 (worktree). Lines are HEAD lines; V means I read them (or ran something), I means inferred. The earlier maps in `.work/maps/` (`ranges.md`, `loops.md`, `loop-facts.md`) were used as leads only: each line below that I rely on I read myself.

Pipeline order (src/compiler.js:236-352 and src/compile/index.js): `parse -> liftIIFEs -> jzify -> prepare -> preEval -> normalize` (src/front.js, one function), then the summary, then `compile/plan/index.js` sweeps, then per function `analyzeFuncForEmit` (analyze-for-emit.js:99) and `emitFunc`, then `optimizeModule` and the WAT pipeline (`optimize/pass-table.js`).

## 0. What a local's wasm type is made of

A local's type is `ctx.func.locals.get(name)`, built by `analyzeBody` (`src/compile/analyze/body-facts.js:64`) in three layers, and only ever demoted, never promoted, after the first:

1. the walk (`computeBodyFacts`, `:214-664`): the first type of every declaration by `exprType(rhs, locals)` (`processDecl`, `:343-381`) and every write widens `i32` to `f64` when the right side's `exprType` is `f64` (`=` at `:529-541`, compound at `:545-551`, `/=` at `:549`);
2. the narrowings that make a local a word on the strength of its reads or writes (`narrowUint32`, `narrowWordLocals`, `collectI32SafeIndexVars`), `finalizeLocals` (`:175`);
3. `widenLocalTypes` (`:741-830`), whose last block (`:814-824`) is the one decision.

`exprType` (`src/type/expr-type.js`) is the walk's judge: `+`/`-` give `i32` for two `i32` operands (`:204`, non-strict: provisional carrier, no magnitude check), `*` gives `i32` only if `mulRangeFitsI32(a, b)` holds (`:225-232`: both operands need a closed range whose product fits), `%` needs a word result (`:208-221`), `<<`, `>>`, `|`, `&`, `^`, `~` always give `i32`, `>>>` gives `i32` only for a nonzero constant count (`body-facts.js:351-353`, `unsignedShiftFitsI32`).

## 1. parse, prepare (decides nothing about width; shapes the bound)

- `src/prepare/handlers.js:1464-1499` (V): `i < arr.length` becomes `i < (arr.length | 0)`, re-read every iteration, so the bound of a `for` over a `.length` is already a ToInt32 result: a word hull `[-2^31, 2^31-1]`. This is why the census has no "bound is `.length` of an array" class (repro `repros/a-length-unknown.js`: `i` is i32 at level 2 and speed, loop is `i32.lt_s`).
- `src/early-errors.js`, `jzify`: nothing about widths (I, not read).

## 2. normalize (`src/normalize.js`, header :1-40, V)

Runs twice (before the summary, once kinds are known). It rewrites a counted loop to the one form every later reader takes: `for (init; i < bound; ++i)`, `<=`, `>`, `>=`, `--i`, `i += K`, `i -= K`; mirrors `n > i` to `i < n`; `i <= B` as `i < floor(B) + 1` only for a literal-started unit-step `for` against a constant B; lowers `do/while`. A step by a name, `i = i + v`, becomes `i += v`. It decides no type. `while` loops stay `while`: only a `for` reaches `loopFacts` (section 6).

## 3. summary (`src/summary/*`) and the interval proof (`src/type/interval-proof.js`)

- `src/summary/num-range.js` (V, read whole): the value `{lo, hi, int, whole, nz, nan, gap}` and one transfer rule per operator. `nrWord(r)` (`:76`) = integer, never -0, never NaN, `lo >= -2^31`, `hi <= 2^31-1`. `int` with an open end means "an integer of any size" (`:5-8`). `+`/`-` keep `int` only if one operand is below 2^969; `*` keeps `int` only for finite ends; `<<`, `>>`, `>>>`, `&`, `|`, `^`, `~` and `Math.imul` return a word or a uint32 hull whatever the operands (`bitwise`, `:120-145`), so `n2 << 1`, `id << 2`, `nn >>> 1` are words by the table.
- `src/type/interval-proof.js` (V for the parts below): an abstract interpreter over a body with one environment of `num-range` values. A loop is walked by `loopFixpoint` (`:749-910`): pass A (discovery), widening join (an end the back edge moves past the entry goes to the word's end if the back edge is inside the word, else it opens to infinity; thresholds for truth tests), pass B (verify, the loop test refines by `applyCond` at `:753-755`), final recording pass. The test refines a counter only through `refineRaw` (`:502-587`): the right side must have a known value (`R = constNum(r) ?? env.get(r)`; `if (!R || empty(R)) return null`, `:518-523`). A bound of unknown value (a parameter, a module binding, a field read, a call) refines nothing, so `i < n` leaves `i` at `[start, +inf]` after widening. A bound that the walk knows only as an integer of open range gives `hi = R.hi - 1 = inf`. `i <= n` with `n` a full word gives `hi = 2^31-1`, and the step makes the hull `2^31`: past the word.
- Published to locals by `publishBindingHulls` (`body-facts.js:120-132`): `rep.intCertain = true` for a binding whose proof is `whole`, `meetRange(name, nrSpan(v))` for a finite integer hull. Read by `widenLocalTypes` as `numbersOf(name)` (`:753`).
- `inferModuleIntGlobals` (`src/compile/plan/scope.js:262-300`, V; first sweep of the plan, `plan/index.js:128`): a module `let` becomes `(mut i32)` only if `flowNumbers` over every write in every flow proves a word (`held.get(name) === WORD_VALUE`), or no body blames it as a bare escape (`collectGlobalBareEscapes`, `analyze-scans.js:1251`, called with `ALL_WIDE`). `N` of rfft (written from the export parameter `n`, compared in every loop) is neither: `(global $N (mut f64))` (V, `rfft-now-speed.wat:97`; it was `(mut i32)` at e88a8e907).

## 4. plan (`src/compile/plan/*`, sweep order in `plan/index.js:111-298`)

### 4.1 `versionIntegralLoops` (`plan/integral-loops.js:2206`, the sweep at `plan/index.js:296`; V read of `:553-2204` in the parts below)

What it emits (V, the `versions` tuple at `:2179-2195`, printed for rfft in `rfft.md`): for each loop it decides to version, in place of the loop statement,

```
if (<test>) { let <fresh int aliases>, <bound>...; <copy of the loop over the fresh names>; <write-backs> } else { <the loop as written, every loop in it marked .cold> }
```

where `<test>` is a conjunction (`:2158-2160`) of: `typeof n === 'number' && n >= min && n <= max` for a counter's bound (`counterBound`), `typeof x === 'number' && x === (x | 0) && (x !== 0 || 1 / x > 0)` for each index name or bound the copy takes as an int32 alias (`nameTests`), `typeof x === 'number'` for names the copy only reads as Numbers, `x != null` for presence, `>= 0` / `> 0` tests for moving cursors and divisors, and the tests an inner version needs. The guard sits where the loop statement was, so it is evaluated once per execution of that statement (once per entry of the loop). An enclosing copy takes an inner version's test as its own where the names hold through the loop and keeps the inner fast arm alone (`versions` map, `:625-629`), so a nest of versioned loops is one guard at the outermost loop. The loop as written is marked `cold`, which `optimize/vectorize/index.js` and the emitter skip (that is why the census has no "cold twin" in its 252).

What the integer copy assumes: each guarded name equals its int32 alias for the whole loop (the loop never writes it: `!loopWrites.has(n)`; no closure assigns it; `outerOk`: a local, not captured, not a function name; a module binding only if `quietNames() != null`, i.e. nothing in the loop can run user code), a private rounded bound `bound = ceil(n) >> 0` (or `floor`, `+1` for `<=`), the counter's final step fits i32 (the `min`/`max` slack: `max = 2^31-1 - advance`), and for a `while` that the counter starts at a literal or is itself word-guarded (`entry`).

Which counters and steps it takes (`counterBound`, V):
- a `for` whose head is `let c = init` (init a literal or `boundTerms` of names), test `c < B`, `c <= B`, `c > B`, `c >= B` with `B` a name or a sum of names/literals (`stableTerms`, `:791-795`), `c` not captured and not written in the body (`!writesIn(loop[4]).has(counter)`), the counter hull computed by `forCounterRange` fits [-2^31, 2^31-1], and `B` has no known int range nor is it `int32Held` (a name the emitter already holds as an int32: then there is nothing to guard) (`:796-826`);
- a `while (c < B)` / `while (c <= B)` with `c` a local Number, `B` stable terms, and `maxAdvanceBudget(body, c, budget) > 0` (`:848-863`): the body must advance `c` by a literal-bounded amount (the budget reads literal steps and element-typed steps via `elementRange`); `advance <= 2^31-1`. `maxAdvanceBudget` returns null when `c` is stepped by a name with no hull (`i0 += id`) or written by a non-step (`ix = 2 * (id - 1)`): measured `advance: null` for every `i0` and `ix` loop of rfft (`probe2.mjs`);
- a `while (c > B)` / `>=` counting down (`:868-881`) with `unitFall`.
It refuses a loop that contains a closure, label, yield or await (`:685`), is bigger than `MAX_SIZE = 800` nodes after inner versions count as written (`:668`), a loop past the growth budget `SOURCE_FULL` unless it is a kernel loop (`:650`), or sits inside a `try`.

Cost in bytes (V, `SCRATCH/counter-widths/bytes.mjs`): rfft's module is 26083 bytes at level 2 and 31645 at speed with the pass, 23451 and 28391 without (`optimize: { level, versionIntegralLoops: false }`): +2632 and +3254 bytes for the two copies it makes in `transform`. One copy is the bit-reversal loop; the other copies the whole twiddle nest (`j`, `ix`, `i0` loops) so the function is 7023 WAT lines against 6079 at level 2 (7876 against 6920 at speed). The pass is off at the size tier (`optimize/config.js:155`).

What it did for rfft (V, `rfft-plan-ast-speed.txt`): two guards. `if (typeof N === 'number' && N >= -2147483648 && N <= 2147483647) { let Nbound = ceil(N) >> 0, i$ = 0; while (i$ < Nbound) ... }` once before the bit-reversal loop; and `if (typeof count === 'number' && count >= -2147483648 && count <= 2147483647)` around the `j < count` loop, entered 10 times at N = 2048 (guards.md). No guard for any `while (ix < N)` or `while (i0 < N)` loop (reasons in rfft.md).

### 4.2 Other plan decisions that touch counters

- `adoptLoopCounters` (`plan/counted-loops.js`, sweep `plan/index.js:158`), `canonicalizeCountedLoops` (`:257`): a counter declared outside its `for` and read nowhere else moves into the head; offset tests. They change the shape the later steps see (I, not read in full).
- `unswitchLoops` (`:283`), `splitLoopKinds` (`:285`), `reciprocalLoopDivisors` (`:294`): copies per answer of a test, per kind, per divisor; not width decisions.
- `inferModuleIntGlobals` (section 3).

## 5. analyze (body facts): where `ix`, `id`, `i0` of rfft are decided

All in `src/compile/analyze/body-facts.js` and `src/compile/analyze-scans.js`:

- `processDecl` (`:343-381`): `let i0 = ix` takes `exprType('ix')`, which is `ix`'s current provisional type. Order matters: the walk is in source order, so a declaration copied from a local that a later statement widens keeps `i32` until the widening fixpoint (`widenValue` loop, `:773-812`), which re-checks every declaration and write and propagates `f64` along copies and arithmetic. Measured on rfft: `ix = 2 * (id - 1)` (an `*` with no range on `id`) and `id *= 4` (`:545-548`, the compound rule) are the two walk-time refusals; every `i0..i8` is `f64` by copying or adding them (`rfft.md`).
- `stampLoopCounterRanges` (`analyze-scans.js:1454-1522`, run at `body-facts.js:582,603`): a counter that a `for` declares, written only by its step, gets the range `forCounterRange` finds, if the whole `test` range (incl. the final step) is in [-2^31, 2^31-1]; `forCounterBoundsIn` (`src/static.js:645-690`) needs `rangeOf(cond[2])` (the bound's closed range) or a `topOf` side (a string `.length`, `math.min` with a bounded operand); a name bound of unknown width returns null and the counter keeps whatever the proof says. `stampCountdowns` (`:1428`): the `--i` in `a || --i` form. Only `for` loops.
- `narrowUint32` (`analyze-scans.js:1012`): a local every write of which is a proven uint32 (typed `Uint32Array` element, `>>> 0`) is a `unsigned` word.
- `narrowWordLocals` (`:1143`): the local every read of which applies ToInt32/ToUint32 (a bitwise operand, `Math.imul`, the value stored to a modular integer element, a copy into another such local) holds its word; any arithmetic step (`++`, `+=`, `*=`) removes it (`:1169-1172`). This is the rule that keeps `n2 = n2 << 1`, `nn >>>= 1` words. A comparison is not a word read: `nn` is a word because its hull `[0, 2^31-1]` is closed, not by this rule (decision event in rfft.md).
- `collectI32SafeIndexVars` (`:1528`): names in affine index position (`+ - * << u-`) whose range rep is a closed word (`escapeInRangeI32`); sets `locals` to `i32` for them and feeds `keepI32` (`body-facts.js:755`).
- `widenLocalTypes` (`:741-830`): Pass A (`widenPass`, comparison against an `f64` operand widens a local not in `keepI32`; V events `cmp-widen`), Pass B (`widenValue`: a typed-element read that may miss, an unsigned value, a copy from an `f64` local; V events `value-widen`), then the decision `:814-824`:

  ```
  for (const [name, type] of locals) {
    if (type !== 'i32' || unsignedLocals.has(name) || wordLocals.has(name) || valTypes.get(name) === VAL.BOOL) continue
    const v = numbersOf(name)
    if (nrWord(v) || v?.int && !(bareEscapes ??= collectBareEscapes(body)).has(name)) continue
    locals.set(name, 'f64')
  }
  ```
  What it proves: the lifetime hull `v` is a closed signed word, or `v.int` and no read of the name observes its magnitude. What it refuses: an integer of open range that is compared, indexed by, stepped (`++`, `+=`, `*=`), returned, or copied into a blamed local (the demand is carried back along definition edges by `bareEscapeScan`'s `drain`, `analyze-scans.js:1339`). That means every counter of a `while` or `for` over a bound of unknown width.
  Pass E (`:825-829`): a Boolean-tagged binding is f64.
- Phase 2d "integer-certain" (V, `.work/phase-2d-int-certain.md` is the brief; landed by 9bafbb6a6 on 2026-11-11, `src/type/int-certain.js` is deleted): the fact is now the proof's own `whole` / `int` bits (`num-range.js` header): `rep.intCertain` is set by `publishBindingHulls` (`:124`) and read by the emitter for floor elision, whole index keys, `intOrMiss`. It is what the planner's `already()` reads in spirit (`integral-loops.js:718`: a name every write of which is an integer of such names): a local that is `already` integral is never put in a guarded copy, so an integral but unbounded `i0` has neither a word nor a copy (the `S1961 nothing to version` of the census).

## 6. emit and the loop facts

- `loopFacts(init, cond, step, body)` (`src/compile/loop-model.js:140-157`, V): for a `for` only (the `for` emitter derives it), `iv` is the counter the guard tests, `hull`/`test`/`step` come from `forCounterRange(init, cond, step, iv, undefined, body)`, null if the bound's range is unknown (`static.js:667-679`: `if (!initRange || !boundRange0) return null`). They go to the optimizer as a lowering link (`ctx.plans.loweringLinks`) read by the vectorizer. A `while` counter has no hull there: no strip count, no `test` refinement.
- Emit arithmetic (`src/compile/emit/arithmetic.js`, `exprType(..., strict)`): an unwrapped `+`/`-` result of two i32 operands is f64 unless `bound(a) + bound(b) <= 2^31-1` from `intExprRange` (`expr-type.js:198-206`); a product likewise. So a sum of word locals that an index uses is `f64.add` + a convert unless their ranges are closed: the 150 `f64.add` of `transform`.
- An index read of an `f64` local costs an `i32.trunc_sat_f64_s` or `i64.trunc_sat_f64_s` per access plus the bounds test; counts in rfft.md.

## 7. optimize (WAT level; `src/optimize/pass-table.js`)

- `narrowLoopBound` (`licm.js:979`, pass-table `:87`): `f64.lt(convert_i32_s(i), n)` becomes an i64 compare against an exact threshold of an invariant f64 bound (V, R3 of removed.md). Needs an `i32` counter local.
- `vectorizeLaneLocal` (`optimize/vectorize/index.js`, pass-table `:111`): its scaffold (`scaffold.js matchBlockLoop`) requires the loop to end `local.set c (i32.add c 1)` and to start with `br_if exit (i32.eqz (i32.lt_s/lt_u c bound))`; an `f64` counter step is the census's `S9 f64 counter step` and refused before any recognizer (V, `loop-facts/instrumentation.patch` `scaffoldWhy`; the 252 rows). It runs before `narrowInts`.
- `narrowInts` (`optimize/int-narrow.js:438`, pass-table `:129`, V header `:1-24`): after the vectorizer and `specializeLoops`. Its engine `integerPlan` (`:81`) reads each value's interval from `optimize/int-range.js` (`LIMIT = 2^52`), and carries an `f64` local in an `i32` or an `i64` where every write of it is an integer within `[-2^52, 2^52]`, "only when it removes more conversions than it adds, weighted by loop depth", and a value that may be -0 only where no read sees the sign. A counter whose hull the WAT intervals cannot close (`i0 += id` with `id` growing) is not narrowed; the narrowed copies that exist in the module are in the `.f2.f5.f7` copies of `ix`/`id` (an `i64` `$ix.f2.f5.f7`, an `i32` `$id.f2.f5.f7`, V from the local list of `rfft-now-speed.wat`). Not a soundness proof for the loop: it runs after the loop is already f64, and cannot make a vectorizer scaffold match.
- `narrowWrappedWords`, `refoldMemargs` (pass-table `:130-131`), `wideAccumulator` (`:133`): a wide integer read only for its low word; addresses.
- `optimize/word-ranges.js`, `flow-range.js`: WAT-level ranges for the vectorizer's counts (not read in full: I).

## What I did not read

`src/prepare/*` beyond `handlers.js:1464-1555`, `src/early-errors.js`, `src/jzify`, the emitter's arithmetic (`emit/arithmetic.js`) and `readVar`/`writeVar` in `src/ir.js` (only through comments and counts), `plan/counted-loops.js`, `optimize/int-range.js`, `word-ranges.js`, `flow-range.js` beyond headers.
