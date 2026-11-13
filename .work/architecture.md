# Architecture work: one generic optimizing layer

Started 2026-11-09. The owner's brief: a clean, minimal architecture whose optimizations
are general, so that ordinary numeric JS compiles well however it is written. This file
is the plan and its state. Maps of what exists are in `.work/maps/` (scout reports: read
them as leads, each claim there is marked verified or inferred). The handover of the
earlier work is `.work/handover.md`.

## What is wrong (measured)

1. **Speed depends on spelling.** The gate `test/spellings.js` holds every spelling of a
   loop to the best spelling of the same program. On 508428d82: 358 of 470 cells are
   gaps (115 of them an artifact of the zero-trip call, to be excluded). `i -= -1`,
   `n > i`, a guarded `do…while` and `while (true) … break` each cost more in 31 to 36
   of 40 corpus cells; worst, 170 → 1164 loop instructions. Timed on three kernels,
   13 of 27 spellings ran 13% to 12× slower than V8 where the canonical one led.
2. **The cause is matching.** 78 sites recognize a counter, a bound or a cursor by its
   written shape (55 on the source AST, 13 on WAT before link, 9 on WAT after watr, 1 on
   the tape; `.work/maps/loops.md`). All accept `i++`; none accepts `i -= -1`; five
   accept a flipped test; one accepts `!==`. `do…while` is lowered through a flag
   (`while (FLAG || c)`) that no consumer reads as a counted loop.
3. **Facts are derived many times and disagree.** The rule for `x % K` exists at 12+
   sites; for a ring cursor they give `[-15, 15]`, `[0, 15]`, "integral", and "number".
   A local's wasm type is decided, flipped and flipped back by three stages. There are
   four interprocedural range fixpoints and two kind lattices (`.work/maps/ranges.md`).
   `src/type/interval-proof.js` (1,541 lines) is already an abstract interpreter with
   widening and narrowing, and is off by default.
4. **Hand-built loops bypass everything.** `forEach`/`map`/`reduce` and the stdlib emit
   WAT loops directly (about 378 sites), so a reduction over `reduce` or `for…of` does
   not vectorize where the `for` does, and `reduce`'s accumulator is typed "tagged"
   (generic `+`, string helpers linked) although the summary knows its kind.
5. **No pass manager, no shared index.** Order is four hand-written call sequences plus
   39 steps around watr; about 20 files rebuild def-use for themselves; 132 pass flags
   and 63 tuning keys with no order or dependency data. The 11 link passes on the tape
   are the one place with the right signature, `(IR, facts)`.
6. **Compile time is the runtime's.** A program that allocates links 30 to 110 helper
   functions and re-optimizes them on every compile: 420 ms warm for a string/array
   one-liner (263 ms in watr, 76 ms in jz's per-function passes), 7 ms for a scalar loop.
   This is also the test suite's cost: about 7,200 tests, most of them a compile.

## Target

```
parse → jzify → prepare
  → normalize        one loop form, one step form, tests oriented; value-exact rewrites only
  → facts            ONE abstract interpretation: kind × {int, lo, hi, nz, nan} per value,
                     induction (start, step, bound, trips) per loop, alias classes;
                     one transfer table (`%`, `&`, `+` …) used by every level
  → plan             passes ask the facts; versioning only for what cannot be proven
  → emit             one loop constructor for source, callback and stdlib loops
  → optimize         passes are (IR, facts) → IR, listed in one table with requires and
                     preserves, over one def-use and loop index; re-runnable
  → watr             generic cleanup and encoding
  → target           the few V8-specific layout choices, each with its measurement
```

Rules for every change here:
- A pass that names a bench, or accepts one written form, is the wrong pass. Extend the
  normal form or the facts, then delete the matcher it replaces.
- Each phase ends with fewer lines in `src/` than it began, or says why not.
- Gates before code: the spelling gate and the ratchet define done; a phase lands when
  its cells close and nothing else opens.

## Phases

| # | Phase | Done when | State |
|---|---|---|---|
| 0 | Base: land `v1`, split the suite over cores, spelling gate, two-sided ratchet per host | main green on the four legs, pushed | done (e7b8b62f4) |
| 1 | Normalize loops on the AST (flipped tests, step spellings, `while (true)` with a leading break, guarded `do…while`; `do…while` first-class instead of flagged) | corpus styles in the gate have no gap beyond the default's; form lists in `loop-model.js`/`static.js` shrink to the one form | landed: `src/normalize.js`, gate 243 -> 84 gaps, no corpus style with a gap the default lacks. 1b landed (0b3f3b09e, 69fdca41f; `.work/phase-1b-normalize.md`): normalize runs again once the summary knows kinds (a local of kind Number that only its declarer writes), so a counter declared from a parameter takes the canonical step and test (`for (let i = k; n > i; i = 1 + i)` is the WAT of `for (let i = k; i < n; ++i)` at level 2 and at speed, where it did not vectorize), the readers' spelled-out steps are deleted, and `do…while` reaches normalize as a node and is lowered there alone (`while (c) B` where the test holds on entry, else a flag loop). The gate did not move, 76 gaps of 470: its counters are declared from literals, and the gaps are distances from the best spelling (fgather 28, map 22, ring 14, dot 12: causes in the 1b report, most inferred). The landing tree: core 7,286, level 0 7,069, level 3 7,083, wasi 7,158, generated 68, self-compile 89; the earlier phases' batteries equal; bench bytes equal at size, +216 at speed (stdlib-ddot: `i += M` reads as the literal step, which `main` already compiled larger); compile CPU time equal within the spread. Left: `do…while` first-class (a bottom-tested form loses the countdown range `stampCountdowns` reads off the right arm of `F \|\| c`, and the vectorizer's scaffold takes top-tested loops only); about 20 loop sets under `src/compile` and `src/type` that still name `'do'` though no stage past normalize sees one; the step matchers under `src/type` (canonical-bounds, loop-versioning, bounded-counters, interval-proof, loop-unroll), with 2d |
| 2 | One domain: a transfer table with module constants resolved, behind every `%`/mask/step rule; `interval-proof` as the engine, on by default; the local's type decided once | ring and offset-index kernels close; `int-certain`, the stamp scans and the duplicate rules are deleted | 2a landed: the table is `src/summary/num-range.js` (`{lo, hi, int, nz, nan, gap}`, no rule reads a name), every `%` rule but two reads it (left: integral-loops' symbolic hull, the summary's `keepHull`), ring `% M` equals the mask spelling (2/27), `mixed` back to 2264/1060. `src/` +49 lines net. 2b landed: the proof's environment holds table values and is the reader behind every local's lifetime range, a sum's trip bound and the widening's word test; `stampBodyRanges`, `fractionalLoopRange`, `outerDeclInits` and the widening's own `held`/`boundOf` are deleted (`src/` 59 lines fewer over the phase); the proof's bitwise, shift and mask rules are the table's. Ring "step first" 35 -> 4 at level 2 and 37 -> 29 at speed (canonical 2 and 27), dot and map `for i<=N-1` and `i!==N` vectorize, 76 gaps of 470, `mixed` 2250/1046; proof time -23% over the 94 single-file bench cases (3.8% of compile), total within noise on a loaded machine. Still scans: a countdown in an arm of `\|\|`/`&&` (`stampCountdowns`: the proof refines neither arm), and the emitter's own `intExprRange`/`forCounterRange` and `extractRefinements` (it asks about nodes the proof never walked: plan rewrites, inlined copies, version twins). 2c landed: a local's storage is one decision over the proof's lifetime value (`analyze/body-facts.js` `widenLocalTypes`: a word where every number it holds is one, or where it holds integers and every read re-applies ToInt32), a module global's the same over the whole program (`plan/scope.js` `inferModuleIntGlobals`: the proof per flow under the hypothesis that the candidates still standing are words; the fraction classifier, the integer default and the `int-global-truncation` warning are deleted), carriers enter the proof as values (a word parameter's, a call's, a sized property's, a code unit's), and the widening's hypothesis loop and integer levels are gone; `src/` 209 lines fewer, `mixed` 2234/1045, bench bytes -802 at size and -9,313 at speed (the landing tree: core 7,285, level 0 7,068, level 3 7,082, wasi 7,157, generated 68, self-compile 89; the earlier phases' batteries equal but 3c's review battery, 2 diffs -> 0). 2d landed (9bafbb6a6, eaf0ffabb, 1ee4305aa; `.work/phase-2d-int-certain.md`): `type/int-certain.js` is deleted and every reader of integrality (a local's, a parameter's, a cell's, a module global's, a schema slot's) reads the proof. The table holds an integer wherever finite as one fact (`whole`); a binding other flows write holds the meet of its writes in every flow, each walked under the hypothesis that it holds its rung (type/interval-proof.js `bindingFlows`, `flowNumbers`); a module global every write of which is an integer reads as one. `src/` and `module/` 102 lines fewer; two regressions in time (pcmconvert 1.2×, aos 2.16×) found by timing the cases whose bytes moved and fixed in the landing ("2d landed" below). Open cells: ring "step first" keeps the copy `q = p` (2 ops; needs the update sunk below `q`'s reads, a scheduling change), `reverse i--` is refused by the vectorizer's exit-shape check (optimize/vectorize/addr-model.js, phase 6), `offset idx i-1` keeps 4 and 2 ops, not analyzed |
| 3 | One loop constructor in emit; callback parameters and accumulators typed from the summary | `for…of`, `forEach`, `reduce` cells equal the `for` cell; `reduce` links no string helper on numbers | 3a landed (parameters read the summary: reduce over numbers is one `f64.add`); 3b landed: one `walk` (src/ir/arrays.js) at 38 sites, typed-array callbacks bound by the summary and inlined, `reduce` cells closed (82 gaps of 470), `src/` and `module/` 114 lines fewer. 3c landed: an arrow of plain value runs in the walk that calls it (compile/in-place.js, every emitter that builds a callback), `for…of` reads its array (plan/alias.js), and a cell no closure took is a local in the optimizer (optimize/cells.js `promoteCells`); `kernel/dot` written with `forEach` or `for…of` and an index vectorizes as the `for` loop does (78 gaps of 470), ratchet unchanged, bench bytes -847 at size and -3,232 at speed, `src/` and `module/` 221 lines more (the pass is 76). Left: a typed `map` whose callback reads a second array by the index does not vectorize (its walk is sized by `__len` at run time; cause inferred by 3c's agent, not traced); a body that makes a function, writes a parameter or returns early keeps the closure |
| 4 | Compile time: memoize jz's per-function passes for parsed helpers (key: IR, config, four module flags, callee closure), a `settled` set for watr | allocating programs compile 3× faster warm; a debug mode proves memo = fresh on the whole suite | handed back, held unlanded (branch `worktree-agent-ad38f46bbe9197c87`, a48e8b6fe on ba71f66a6; `.work/phase-4-compile-time.md`): the memo is byte-identical with it off on the agent's checks (the suite compared compile by compile, 561 corpus pairs, bench bytes; not run again by the integrator), and warm allocating one-liners compile 1.25× to 1.36× faster, not 3×: the per-function passes are 20 to 26% of a warm compile and watr about 75% of what remains; `npm test` CPU -8%, its wall time unchanged; a `settled` set for watr breaks byte identity and the byte-safe segment memo has a ceiling near 11% of watr's time. The 3× was the plan's estimate and it was wrong. Held, the owner's decision (2026-11-12), on the integrator's recommendation: the mechanism (518 lines under `src`, 491 of them recording what each pass reads through proxies, and state kept across compiles) is what phase 5's explicit `(fn, facts)` inputs replace with a keyed cache, and landing it now puts it under `src/optimize` just before phase 5 moves every file there. Its findings go to phase 5's brief: what the passes read, emit's node marks, `word-ranges.js` at 18.9% and watr's `optimize.js` at 19.1% of compile CPU |
| 5 | Pass table and shared index: every optimize pass takes `(fn, facts)`, order and requirements are data, def-use and loop tree built once | no `ctx` read under `src/optimize`; the hand sequences are generated from the table | 5a landed (d462f1b6e, e7e5d1fd2, b8d12a2bd, b03e99d4e; `.work/phase-5a-pass-table.md`): the order is `src/optimize/pass-table.js`, 123 entries in 7 stages, and no file under `src/optimize` imports `ctx.js`. The sequences are not generated from the table: each stage lists its runners where it calls them and fails where it loads if list and table differ (runners collected by the table made the hosted compiler 9.5% larger; as landed 2.1%). No byte moved natively. 5b is closed with a census and no index: built once to be read many times it saves 0.6% of compile CPU, so it is built with phase 7's passes, which need it; the one helper the census found costly, the range walk, is fixed (963a49a64: decode-wav compiles in 23 s, was 71). See "5a landed" and the two sections after it |
| 6 | Vectorizer legality from induction facts and a dependence test, if-conversion; recognizers become cost choices | the fixed-order recognizer list is gone; no corpus cell loses SIMD | Measured, not started in code: nine programs answer wrongly at levels 2 and over, in 1.0.2 too, and the special recognizers hold 60% of the lifts. Three steps: 6a one legality for every lift (briefed, `.work/phase-6a-legality.md`), 6b the loop's facts from the emitter and the forms the scaffold refuses, 6c lowerings chosen by cost. See "Phase 6 measured before it was designed" |
| 7 | Value passes on the index (numbering, redundancy, constants, memory) | the forwarding and reuse files are deleted, ratchet not above today's | |
| 8 | Peephole rules as a checked table | each rule has a machine-checked equivalence | |
| 9 | Claims: a held-out lane measured once on first contact; a lane at exact JS semantics; relaxations opt-in | README states only what the lanes show | |
| 10 | CONTRIBUTING.md cut to a guide; shape-pin tests retired with the recognizers they pin | under 30 KB; pins replaced by gate cells | |

## Found on the way (2026-11-09)

Each was on `main` before the phase that met it; each has a test now unless marked open.
- `forEach` answered 0, not `undefined`, on every receiver (five emitters, an old convention).
- `i ||= 2.5`, `&&=`, `**=` on an integer-declared local stored a truncated word: the
  local-type walk listed five compound operators by hand (body-facts.js).
- `const o = { n: 5 }; o.n |= v` did not compile at the default level: the bitwise
  handlers trusted prepare to have rewritten every bare `x |= v`, and scalar replacement
  makes one after it (emit/assignment.js).
- The do-while recognizer of phase 1 took a flag loop the source wrote, and an entry
  literal a later declarator overwrote (both fixed before landing).
- `Array.from(set)` through a helper answered `[]` at level 0 where the direct form was
  a compile error with a message (fixed by 3c: a Set or a Map gives its entries).
- Open: the ratchet's `mixed` entered count rose 1060 -> 1085 with phase 1, because one
  spelling used to dodge a versioning defect every other spelling paid (phase 2a, item 2).
- Open: `fgather` compiles 15 ops better as a `while` than as a `for`; `watr` grew 163
  bytes at speed with 3a, unexplained.

A hand-listed operator or spelling set was the cause each time but the first.

## Found on the way (2026-11-10)

Met while reviewing 2a and 3b with batteries against Node; every one was on `main`
before this session, most at every level. Each has a test now unless marked open.
- A sum of words past one word stayed a word where a term was one the integer levels
  cannot name: `let a = k | 0; a += K` (a module constant, a module `let`, a call's
  word) at 2147483647 answered -2147483646, where `a += 3` was right. `exprType` types
  the sum i32 provisionally and `int-certain` gave it no level, so the widening keyed on
  level 1 never looked (body-facts.js). The class 2c removes: two classifiers of one fact.
- `a < 0 ? 1 : 0` on an overflowed sum compared a word: the escape scan skipped a node
  whose result is bounded, and a conditional's arms bound it whatever its test reads
  (analyze-scans.js).
- `[1, 2].map(x => x / 2)` answered `[0, 1]` at the default level, and `.map`, `.filter`,
  `.slice` of an integer literal reached a return or an argument as an Int32Array: the
  literal's promotion checked a map's callback for numbers, not words, and a derived
  value only where a name held it (plan/literals.js; the summary's `elemNumsOfExpr`
  decides the words now).
- `[1.5, 2.5, 3.5].filter(x => x > 3)[1]` answered 0: the summary gave a filter's result
  the receiver's kind, length and all (summary/index.js).
- `Object.fromEntries(g())` called `g` twice below level 3, and a Map argument read out
  of bounds at every level (module/object.js).
- `t[0] = '7'` stored 0 at an integer element (a string's box read as NaN by the range of
  a constant, ir/numeric.js), `t.set([true, '3'])` stored NaN (module/typedarray.js),
  `'ab'.repeat('3')` repeated nothing (bridge.js).
- `BigInt64Array.find` and `findLast` answered the element's bits as a Number (fixed by
  3b's binding of typed callbacks).
- 3b itself made `Float64Array.from(a, x => null)` store null boxes at level 2 and over
  once its loop vectorized (the lift took `__to_num` for the identity anywhere); its
  agent fixed it on the branch before the hand-back.
- A name a test bounds and then writes kept the bound in the body: after
  `while (i < n && s[i++] !== 0)` a read `t[i]` at `i = n` was taken unchecked and
  answered 0 for `undefined`, at every level (type/interval-proof.js `refineAll`, and
  the emitter's own refinements, compile/flow-types.js).
- Three tests pinned a miscompile and were rewritten to the source's answer: the
  n-queens count as a word (`cnt = cnt + solve(…)` wrapped past 2^31: a leaf weighing
  10^9 on a board of 6 answered -294967296 for 4000000000), a masked recursive sum's
  accumulator as a word, and a param-fed global compared under a conditional kept as a
  word (`N = 2.5; i < N ? 1 : 0` answered as `N = 2`; every other spelling of the
  comparison already kept the Number). `bench/nqueens` now adds its count in f64: one
  unpaired run each way, 2.62 ms against 2.42 ms with V8 at 5.24 and 4.64 in the same
  runs (0.50 and 0.52 of V8), 931 B against 885 B.
- A step under a test of its own name stays a word where the test keeps the result in
  the word (`rep--` under `rep > 0`): a rule in body-facts.js `widenLocalTypes`, beside
  the binding-use scan's own guarded step (analyze-scans.js `guardedStep`, which asks a
  different question of the same shape). Both belong to the one engine of 2b/2c.
- `Array.from(a, f)` where `f` grows `a` stopped at the first length (`[2, 4, 6]` for
  Node's `[2, 4, 6, 8]`), and one that shrinks it answered `[1, 2, NaN, NaN]` for
  `[1, 2]`; `Array.from(set)` through a helper answered `[]` below level 2 (3c,
  module/array/from.js).
- A closure made by an expression-bodied function lost its writes to that function's
  parameter: `export let f = (s) => ((() => { s = 7 })(), s)` answered the argument, at
  every level, and so did the same shape made as a closure. `boxedCaptures` ran for block
  bodies only (analyze-for-emit.js, closure-emit.js). 3c's agent met it through a check
  the emitter now keeps: a closure that writes a local its maker holds in no cell is a
  compile error (emit/call.js).
- 3c as handed back left a local an in-place callback writes out of its cell, as my
  brief told it to. That was wrong: `let o = { a: 1 }; a.forEach(x => { o = { b: x } });
  o.b` answered `undefined` at every level, because the pointer-local analysis keeps a
  declaration's layout unless it sees a reassignment, takes a mention inside an arrow
  for a capture, and says in its comment that a capture-mutated local is already in
  `boxed` (analyze/ptr-eligibility.js). 72 sites read `boxed` and 215 scans stop at an
  arrow; the rule they share is that a local an arrow writes is in a cell. The landed
  form keeps the rule: running the arrow in place is the emitter's choice, no analysis
  is told, and the cell is removed after the fact where nothing took its address.
- A bound declared beside its counter was taken at its first value though the loop
  writes it: `for (let i = 0, l = x.length; i < l; i++) { …x[i]…; if (i === 0) l = l * 2 }`
  read `x[4..7]` unchecked and answered 8 for Node's 404, at levels 0, 2 and 3
  (static.js `forCounterBoundsIn`; found and fixed by 2b's agent, test in
  test/counter-width.js). The deleted range scan had hidden the `l = l + 1` spelling.
- Both agents met the staged store whose value a test reads and fixed it in the same
  file; the landed form is 2b's (the staging leaves the expectation as it found it),
  with both tests.
- What 2b's brief got wrong: the table's `+` cannot serve `int-range.js`, whose readers
  take `int` as "an integer wherever finite" (the ring counter became f64; reverted);
  "ring step first equals canonical" needs scheduling, not a range.
- Decided by the owner (make it sound; with 2c's agent): a module global fed a fraction through a closure's or a
  callback's parameter is a word. `let S = 0; export let f = () => { const add = (x) =>
  { S += x }; S = 0; add(1.5); add(2); return S }` answers 3 for 3.5, and so does
  `[1.5, 2].forEach(x => { S += x })`, at every level; a named function's parameter is
  followed to its arguments and answers 3.5. plan/scope.js `inferModuleIntGlobals` says
  the integer default is deliberate and offers a warning; README lists no such
  divergence. The sound rule asks the summary for the parameter's numbers.
- Level 1 only: `let i = 3, r = 0; if (i >= 4 || i++ === 9) { r = -1 } else { r += i }`
  left `r` 7 for 4. watr's `coalesceLocals` took a local both arms write for written on
  every path, though one arm adds to its initial zero, and let it share the slot of the
  step's temp. Fixed in watr 5.13.5 (its `armSets`), which jz takes; test in
  test/audit-regressions.js.
- Levels 2 and over: `while (i < 4 && (t[i++] = 1) > 0) { c++ }` over a Float64Array
  compiled to a module that does not validate. Staging the store's reference emitted the
  step `i++` as a statement and the store read that expectation, keeping no value to
  compare (3c, emit/assignment.js). Statement-position element stores take the guarded
  typed path since, which is where `watr` (+277 at size, +455 at speed) and `webaudio`
  (+200 at size) grew.
- Open: a map of a filter's result is no longer promoted with its literal (the summary
  holds a walk over an array of no known count to miss; one over a receiver nothing else
  reaches cannot).
- Open, from 3b's agent, not checked here: bench bytes at speed +0.15% (19 cases, the
  largest `watr` +3,191 and `webaudio` +2,643; traced for four of them to loops that
  now vectorize).

The causes this time: two classifiers of one fact, a fact of a value applied to what
derives from it (twice), a box read as a number (three times), an expression emitted at
two reads, a fact of a test applied after the test wrote its name. Three of the fixes
first failed five pins in the full suite: I had run the gates and the files beside the
change, not the suite, before committing them. And a brief of mine decided a mechanism
(the written local "stays a local") without first asking what else relies on its
opposite: a brief names the outcome and the rule that must keep holding, and the
reviewer's battery is written against the rule, not against the feature.

## Found on the way (2026-11-11)

The review of 2c: 5,234 programs against Node at six levels, written against the rule
(a word holds what JS holds at every read) before reading the change, plus probes of
each class it met. 2c's own batteries answered 0 diffs and held neither regression.

- A regression of 2c: the value of an assignment was read from the word its target
  keeps. A module global is a word wherever every read takes its word, whatever it
  holds, so `G = H = k / 2; return G`, `return (G = k / 2)`, `h(G = k / 2)` and
  `if ((G = k / 2) > 0.25)` answered 0 for 0.5. The integer forms were on `main`:
  `a = b = (k | 0) + 1; return a` answered -2^31 for 2^31. The escape scan
  (analyze-scans.js) took the assignment's operand for read and not its target; an
  assignment read as a number is a read of its target now.
- A regression of 2c: `const a = k >>> 0; const b = a - 1` answered -2 for 4294967294
  (12 forms; `(a - 1) % 7` on `main`). The emitter's proof that `a - k` fits a word
  bounds one side, which holds of a signed word; an unsigned local's range, published
  since 2c, gave it the lower side and nothing asked for the upper
  (emit/i32-bounds.js). A read of an unsigned local is marked wrap-safe whatever reads
  it (ir/vars.js), so the guard beside the proof never held it back.
- On `main`, every level, not met by 2c: a name with an integer write in sight was an
  integer though other code writes it (type/int-certain.js started each name a body
  defines as a strict word, lowered by the defs of that body alone). `G = 0; w(5);
  return Math.round(G)` answered 1.5 where `w` adds 0.25 to the module's `G`; `T[G]`
  read the first element for 0.5 in an array, a typed array and a string;
  `G === Math.floor(G)` held for a fraction a closure, a callback or a generator
  stored; a local a sibling closure writes read the same way; and a closure's
  parameter its body also writes was an integer by that write (`[0.5, 1.5].forEach(x
  => { if (x > 100) x = 1; s += Math.round(x) })` answered 2 for 3). Grounded now; the
  precision given up (a module global stored as a Number whose every write is an
  integer is floored again; a closure's parameter rewritten to a word reads as a
  Number) is 2d's to return.
- Was open on `main`, fixed as de94b68cc (below): `for (let i = 0; i < k; i++) { let i
  = 5; c += i }` never returned (the body's own `let i` was taken for the loop's; one
  more pair of braces and it answered).
- Was open on `main`, levels 2 and over, fixed as 2265a4914 (below): `let i = null, c =
  0; for (; i < 3; i += 1) c++` ran 0 times for 3. The test compared the null box, a
  NaN, where its number is 0. The cause named here first (the shadow local `inum`,
  compile/num-shadow.js) was not it.
- Open, on `main`: `do i++; while (c)` and `do { … } while (c) stmt` are compile errors
  ("Unclosed (", "Unclosed {"); both are JS. The parser package's: subscript's `do` rule
  skipped five characters after the body for its `while` and ended no statement at the
  test's `)`. Fixed there as 10.8.3 (published; see below). Through jz's parser, 56,004
  sources (jz, watr, subscript, three.js,
  test262) parse as before but 25 of test262: 5 positive tests parse now, 20 negative
  ones reject as before. jz pins 10.8.2: the bump has test/test262.js to reconcile (its
  three `parser: do-while` entries and its `do ; while` skip rule; the gate has not run
  against 10.8.3 yet).
- Open, from 2c's agent, not checked here: `await null` does not let another call run
  before the function resumes.
- Not a defect: a comparator's arguments arrive in another order than V8's.

The causes this time: a read that is not written as one (an assignment's value), a
proof of one side taken for both once a fact it never had arrived, and a classifier
answering for the writes it could see. The last two were sound only while something
else was missing: publishing a true range and admitting a true word each exposed a
reader that had relied on its absence.

The review of 1b: 3,119 programs against Node at six levels (the four lines open on
`main` and no other), 41 `do…while` programs (assignments a `continue`, a `break` or a
throw skips; a do-while in a `case`, a `catch`, an arrow, a generator; labels; a test
no literal decides), 2c's 5,234 programs again, and the bytes of each step's spelling
over 25 kinds of counter: four kinds lost their gap (a local from `param | 0`, an inner
function's parameter, a counter declared bare, a countdown), none gained one. What the
brief got wrong is in the row above: no gate cell could move, and the flag has a reader
besides normalize.

The fixes landed after 1b (de94b68cc..267ad34bb, eight commits, each with a differential
test in test/audit-regressions.js). Found by probes written against the rule (a compiled
answer is Node's) around each defect the reviews above left open, 1,608 programs at six
levels after the fixes: 0 diffs but one probe of mine that reads a `let` before its
declaration.

- The for body's own `let` (de94b68cc; the line above). The parser hands a braced body
  as its bare list, and the head's frame held the body's declarations: of 57 probe
  programs on `main`, 7 never returned, 11 answered wrong and 2 were refused.
- A null's conversion to 0, levels 2 and over (2265a4914; the line above, whose cause
  was not the shadow local): the pass that drops an undefined test whose value only
  comparisons read (optimize/nan-canon.js) dropped the null test beside it.
- `let x = null; if (c) x = undefined` kept null at levels 2 and over (707d47956): two
  definitions were compared by their JSON text (compile/plan/alias.js). The class is
  wider than this site: about 35 comparisons or map keys of a node by its JSON text
  under `src`, which writes NaN, the infinities, null and undefined as `null` and -0 as
  `0`. A 152-program probe finds no other live one; briefed apart
  (`.work/node-keys.md`, before phase 5 moves `src/optimize`). Landed 2026-11-12
  ("Node keys landed" below): the agent's probes and a second battery found live ones.
- `g(-0)` beside `g(0)` compiled the parameter as -0 for both (cba74ea40, levels 0, 1
  and size): -0 was an integer constant of a parameter (compile/narrow/index.js).
- A module binding of a Number, a string or a Boolean that may be null or undefined was
  read as its declared kind (4f5754644): `Object.is(X, NaN)` held for a null `X`,
  `typeof X` named the Boolean, `X < 'b'` compared null as a string. A BigInt keeps its
  claim (dropping it made `X < 6` throw).
- `let X = 'ab'` read as 'ab' in a template after `X = 'cdef'`, at every level
  (f375142a8): the fold ran during the walk, ahead of the scan that drops an assigned
  name.
- What a function knows of a module binding, or of a cell a closure assigns, ended at
  no call (43d73d4ed): `X = 1; w(); return X + 1` and `if (typeof X === 'number') {
  w(); return X + 1 }` added a string as a number where `w` had stored one, and an
  export's result crossed as an f64 where it was a string. The summary's straight-line
  facts and the emitter's guard refinements both (summary/index.js `fnAssigned`,
  compile/flow-types.js `heldOver`).
- `Array.isArray` answered true for every operand the compiler held for an array
  (267ad34bb): `let a; if (c) a = []`, a `find`'s or a `get`'s result and a callee's
  null read their length through undefined.

The cost, bench bytes against e278d719b: +3,667 at size (0.13%), +10,263 at speed
(0.17%). The null test kept (stdlib-dists, webaudio, stdlib-special, decode-dsd,
decode-tta, movavg, jessie) and `Array.isArray` asking the value (polytri +2,407 and
+6,464, setops, watr at speed): the kind's one tag for null and undefined makes a
comparison pay the null test where only undefined can arrive, and two of polytri's
loop-versioning guards on names of kind array-or-absent stay run-time tests. Both are
precision to return, not defects. The other six fixes moved no byte. (The versioning
guards' bytes are returned, 47103b716: "CI read whole" below. The null test stays.)

The landing tree (267ad34bb): core 7,294, level 0 7,077, level 3 7,091, wasi 7,166,
generated 68, self-compile 89.

subscript 10.8.3 is published (the owner's, b916571) and jz takes it in the landing
below (360770d24: the pin, the lock, src/early-errors.js for `if (c) do x; while (y)
else z`, test/test262.js's three `parser: do-while` entries and its `do ; while` rule,
a test). What stayed open is in the list that ends the next section.

## 2d landed (2026-11-11)

Nine commits on ba71f66a6: three soundness fixes (8745d4cea, b16d106a1, 6c8338ef8),
2d (9bafbb6a6, eaf0ffabb, 1ee4305aa), the subscript 10.8.3 bump (360770d24) and two
fixes of what 2d cost in time (a67c16b3c, 642ef8a46).

The review of 2d: 1,500 programs a seed against Node at six levels, written against the
rule (a name the compiler holds for an integer holds one at every read, whoever writes
it) before reading the change. `main` 43 programs differing, 2d alone 12, every one of
the 12 on `main` too and one defect (the first below); with the three fixes 0 at seeds
1 and 7. 2d's own review battery answered 0 and so did mine for its change: what
follows was found beside it.

Three defects on `main`, each fixed with a differential test (test/audit-regressions.js):
- Levels 1 and over: a slot of a split literal that is written was read as the constant
  it was declared with. `const a = [1, 2]; a[1] = Math.floor(x); A[a[1]]` read `A[0]`
  for 2^30, raw memory through a typed array, and `t[w] = 9` wrote `t[0]`
  (plan/literals.js declared every slot `const`; the summary's facts of a `const` bound
  the key). 175 of 1,560 programs of a slot-write battery differed, 0 after.
- Level 0, and level 1 once the object is passed on: `const o = { w: 2, t: 1 };
  o['w'] *= 3; return o.w` answered 6, 18, 54 over three calls. A write through a string
  key was no write of the property, so the literal stayed one shared static instance
  (program-facts/walk-facts.js).
- Levels 2 and over: the value of an assignment to a local every read of which
  re-applies ToInt32 was read from the word. `(p = v * 1) + 1` answered 1 for 0.5,
  `A[p = 0.5]` read `A[0]`, `return (p = 2 ** 32)` answered 0 (analyze-scans.js: the
  census counts an assignment whose value is read as a read of its target; the loss is
  `t = p = x`, which keeps `p` a Number).

Two regressions of 2d in time, neither in bytes worth a look (+648 and +8), neither a
wrong answer, both found by timing the cases whose bytes the change moved:
- pcmconvert 1.2× slower (10 of 10 paired rounds). `const si = (i % seg) * ch + ~~(i /
  seg); s[si]`: once the name was known whole, the key took the word form, and the
  integer pass, which holds the sum in i64, clamped it to a word between two selects
  ahead of every bounds test. An expression key of that hull already met the length in
  i64 (emit/dispatch.js emitIndex); a name holding one does now, by its binding's hull.
  A stronger fact chose the worse form. The pin of this kernel (test/typed-wide-index.js)
  looked for the fit test and the select of -1 and passed over the clamps: it names them
  now.
- aos 2.16× slower (8 of 8). The census holds `y: i + 1` for a word since it reads the
  proof, so `p.y` was read as a word: truncated at the read and converted back at each
  float use, in place and through the plan's local for a field read twice. A field read
  carries the mark a dense array's element has (`wordOf`: a float consumer takes the
  load, ir/numeric.js asF64), and a word local every write of which is such a read and
  every read of which converts back holds the number (optimize/peephole.js
  holdWordNumbers, first in the driver, by the mark). The kernel is byte-equal to
  `main`'s again at levels 1, 2 and speed.
After both: 29 cases (every one whose bytes differ from the tree without 2d, and the four
the second fix returned to it) at 8 paired rounds, medians 0.974 to 1.042; the seven
outermost again at 16 rounds, 0.988 to 1.006. Probes of the two fixes: 648 programs of
keys held in names past a word (2^32 + 1, whose low word is an element), 700 of word
locals read by float code with a fraction, a -0, a NaN or 2^32 stored behind them, 225
of stores through parameters that may be one array: 0 diffs each, here and on the tree
without 2d.

Bench bytes against the tree without 2d (the three fixes on ba71f66a6): -4,152 at size
(0.15%), +59 at speed. jessie's +128 and +1,038 are its input (the case compiles
subscript, 10.8.3 now); without it -4,280 and -979. Not traced: watr +2,014 at speed
(time 0.98 and 0.99 of the base in two sweeps), stdlib-dists +135 (2d's agent: the key
`factorials_default[x]` goes through a guard where it was truncated; time 1.01).

The review batteries again on the landing tree: the 1,500 programs at seeds 1 and 7, the
slot-write battery (1,560), the module-null, JSON-key and null-number batteries (608,
366, 152, 425) and the three above, 0 differing; the shadow battery (57) its one known
probe, which reads a `let` before its declaration.

The landing tree (642ef8a46): core 7,306, level 0 7,089, level 3 7,103, wasi 7,178,
generated 68, test262 4,120 pass and 0 fail, self-compile 89.

What the procedure takes from this: a review of a change to codegen times every case
whose bytes it moved, paired against its base (`JZ_BASE_ROOT=<base worktree> node
bench/bench.mjs --cases=<ids> --targets=jz,jz-base --paired=8 --no-web --json=<scratch
file>`; 16 rounds for a case within 4% of 1). A byte battery told neither of these: 8
bytes were twice the time.

Still open after these:
- The carrier of a word is chosen without its readers. holdWordNumbers returns the
  number to a word read off memory, by a mark emit sets; nothing else was found to pay
  (a word computed in integers converts once for a float reader, a rounded value stays a
  Number: three kernels), and nothing proves no other does. The general choice is phase
  7's (the value passes see every reader).
- From 2d's agent, on `main` too: a typed array's key that may be a Boolean beside a
  number is taken for 0 or 1. A battery of 2,160 programs (nine holders of the key, ten
  values, what else reads it, three uses, two element types): 396 differing, every one
  a Boolean; none for null, undefined, a string, NaN, -0 or a fraction, none through a
  field or a parameter. `W[k > 1 ? true : n]` reads and writes element 1 at every level
  with nothing else reading the key. A binding (a module's, a local, one a closure
  writes, a call's result) does at every level, and an array's element at levels 1 and
  over, where their other reads convert: `let G = 0; const W = new Float64Array(3);
  const w = () => { G = G > 1 }; export let f = (k) => { G = Math.floor(k); w(); W[G] =
  9; return W[0] * 100 + W[1] * 10 + W[2] }` answers 900 or 90 for 0. An array, a string
  and an object keyed by `G` answer right there, and so do `typeof G`, `G === true`,
  `'' + G` and `G + 1`. Two causes, read and not yet fixed: the summary's demand pass
  takes a typed key for no evidence (summary/index.js `index`), so a Boolean beside
  numbers is stored as its number (emit/dispatch.js boolCarrier); and the typed read
  takes a Boolean-or-Number conditional for a Number key (module/array.js: the value
  type of such a merge is NUMBER, kind/val-type-of.js). The cause 2d's agent named
  (`boolTagged` refusing a name that has a value type) is not it. Fixed 2026-11-12
  ("A Boolean beside a number" below).
- A method named `do` (class or object shorthand) does not parse, and methods named
  `if` and `for` are refused by an early error. Both before 10.8.3.
- The node-keys class (about 35 comparisons of a node by its JSON text, and 2d's
  `sameNode` in type/interval-proof.js): briefed (`.work/node-keys.md`). Landed
  2026-11-12 ("Node keys landed" below).
- The shared modules of the main checkout hold subscript 10.8.2 on disk under a hidden
  lockfile that says 10.8.3, so `npm install` there changes nothing and the do-while
  tests fail against them. The owner's to repair (`rm -rf node_modules/subscript
  node_modules/.package-lock.json && npm install`); until then a worktree links
  `.claude/worktrees/bump-subscript/node_modules`, which holds 10.8.3 and is kept for it.
  Repaired by the owner (2026-11-12: 10.8.3 on disk); a worktree links the main
  checkout's modules again.
- The kind's one tag for null and undefined (the +0.13% of the fixes before).
- `await null` does not yield; `do…while` is still a flag loop past normalize.

## A Boolean beside a number; two reports of #120 (2026-11-12)

Three commits on 0ebaad572 (49554075d, 7edd3de24, 726db51f8).

The rule the batteries hold: a read answers what JS answers of the value a binding
holds. Six batteries against Node at six levels (the first written from the rule before
the code was read, the others as each cause showed its readers):

| battery | programs | `main` differing | after |
|---|---|---|---|
| a typed array's key (nine holders, ten values, three uses) | 2,160 | 396 | 0 |
| a binding read by what does not convert it (nine holders, five values, 36 readers) | 2,952 | 168 | 0 |
| a Boolean-or-number conditional handed to a reader | 1,071 | 132 | 87 |
| the same, more readers (objects, arrays, collections, strings, control) | 672 | 71 | 12 |
| a missing element of an array, by its reader | 792 | 64 | 64 |
| a conditional of a Boolean and a number handed to a built-in | 112 | 10 | 10 |

What the last four rows leave is the open list below: of the 87, 55 are the conditional
itself handed to a built-in, a method or a string sum and 32 a hole of `Array(x)` read
by `typeof`; the 12 are `Array(x)`, `new Array(x)` and `encodeURIComponent`; of the 10,
8 are `parseInt`, `parseFloat` and `Number.isInteger` and 2 `Math.hypot`'s last digit.

One cause behind the first two (49554075d). The summary's demand pass
(summary/index.js) lets a Boolean be stored as its number where every read it counted
converts (emit/dispatch.js `boolCarrier`), and it counted a read that does not convert
as no evidence: a typed array's key, `Array(x)`'s count, a field of an object read whole
(JSON.stringify, Object.values and entries, for-in, a spread, Object.assign, a host
return, a computed key) and a field read by a literal string key. Each now denies the
demand where the summary names something beside a Number in the value (`namesBeside`,
`readWhole`); the unknown kind, an exported parameter's, is left to the boundary's
contract. Every one of `main`'s 168 was a Boolean beside a converting read. Bench
bytes: 0 of 105 cases moved.

The second cause is a convention and stays: a `?:`, `&&`, `||` or `??` of a Boolean and
a Number has the value type NUMBER (the raw 0 or 1), so a reader that tells them apart
must ask `hasAmbiguousBoolMerge` (58 references) and emit by `emitIdentitySafe` or
`storedValue` (65). Two readers that did not ask are fixed: a typed read's key
(kind/val-type-of.js `typedNumberOrMissingKey`) and a key staged into a temp
(emit/assignment.js `stage`). Staging every argument of a built-in the same way was
written and reverted: a built-in that inspects a literal argument then sees a temp
(`JSON.stringify(x, null, s ? 2 : true)` lost its literal `null` replacer and was
refused; `Math.max(c ? true : n, 0.5)` answered wrong at level 2).

Open, listed and not fixed (Decisions taken: the last entry):
- A Boolean-or-number conditional handed to a built-in (`Number.isInteger`, `isFinite`,
  `isSafeInteger`, `parseInt`, `parseFloat`, `Array(x)`, `new Array(x)`,
  `encodeURIComponent`), as a method's receiver or argument (`.toString()`,
  `?.toString()`, `indexOf`) and in `'' + (c ? true : n)`: read as 0 or 1. The fix is the
  convention turned over, identity by default and the raw carrier where the reader
  converts: phase 7's, with the carrier choice it already owns.
- A missing element of a Boolean or BigInt array read by `typeof`, `??`,
  `JSON.stringify`, a field store or a default parameter (the 64 of 792).
- `Math.hypot`'s last digit differs from V8's: the spec leaves it to the
  implementation, no defect.

What the batteries taught: a helper that reads a field by name through a receiver of
unknown shape (`const slotKind = (o) => typeof o.a`) is a read of every field so named,
rightly, and it hid every object reader's failure in the first run. A battery's helper
takes the value, never the holder.

Two reports of discussion 120 (7edd3de24):
- An optional chain on a name the compiler resolves where it is used was refused, or
  read as the host's global: `process?.exit(1)` under `host: 'wasi'` ("reference to host
  global `process`"), and `Math?.max(a, b)`, `JSON?.stringify(x)`, `console?.log(x)`,
  `Object?.keys(o)` on either host. Prepare resolved the `.` callee alone
  (prepare/handlers.js `staticMember`, `servedCallee`: the four optional forms are the
  plain member where the name is a namespace or the call is served).
- `scripts/native/compile.mjs` failed in clang with WABT 1.0.42 ("too many arguments
  provided to function-like macro invocation"): since 1.0.42 wasm2c hands every memory
  helper the base and size from locals of the calling function, and
  `postprocess-watr.awk` shadowed the helpers with macros of the earlier arity. The
  script now leaves 1.0.42's helpers and removes only the load barriers. Checked against
  the tagged sources (1.0.41 names no local base, 1.0.42 does) and on a fixture of
  1.0.42's declarations; no 1.0.42 build ran here (local 1.0.39, CI 1.0.41; fetching the
  release was refused by the session's permissions), and its speed is not measured.

The third commit (726db51f8) removes an import nothing reads, left by 2d's deletion of
`int-certain.js`: CI's `lint:imports` step failed on it, so the default leg's tests did
not run on CI from e245ca67e on. The integrator's miss twice: the step was not run
before 2d landed and CI was not read after the push. Both are steps of a landing now
(`npm run lint:imports && npm run audit:files` before, `gh run list --workflow test.yml`
after). The `claims` job is red as before the takeover (handover, "Red").

Battery: the tree of the two fixes on e245ca67e, core 7,309, level 0 7,092, level 3
7,106, wasi 7,181, generated 68, test262 4,120 and 0 failing, self-compile 89, all
passing. The landing tree is that tree and the example commit of 0ebaad572 (nine files
under `examples/` and `test/examples.js`: the example's bytes are identical at every
level on either host with and without the fixes) and the import: core 7,309, passing; `lint:imports` and `audit:files` clean.

## Node keys landed (2026-11-12)

The agent's four commits (f9021e648, f6b4caf27, d4289e960, cf79b518f; brief
`.work/node-keys.md`) and three fixes of the review (25e4f79da, 1c8a1ce08, e232efb25),
on 5b0a63dda.

The rule: a node is one node only where every leaf is the same value. JSON text writes
NaN, the infinities, null and undefined all as `null` and -0 as `0`; a join writes 1
and '1' alike. `src/ast.js` `nodeEqual` (Object.is on leaves; a literal's hole head and
null head one), `nodeKey` (the JSON text where no leaf is one JSON writes as another's,
else the same form with the leaf written as itself) and `constText` (an IR constant by
its value, every lane, -0 as -0) are behind every comparison and key of a node, in 47
files, the hand-written equalities that compared leaves by `===` among them.
`test/node-keys.js` holds every `JSON.stringify` under `src`, `module` and `jzify` to a
stated reason (31 entries; it cannot see a `join`, a `String()` or a template: those
were read, not checked).

Three defects on `main`, each pinned there:
- Every level: closure bodies were deduplicated by a hash and a comparison kept to the
  JSON key's classes on purpose (test/invariants.js pinned them): `const fs = [() =>
  Infinity, () => -Infinity]; fs[k & 1]()` answered Infinity for both, `() => 0` and
  `() => -0` were one closure (wat/assemble/closure-table.js).
- Every level: hoisted literal arrays were keyed by their values' join, so `[0, 1][i]`
  and `[-0, 1][i]` shared one segment (prepare/literals.js).
- Levels 2 and over: `for (let i = 0; i < 4; i += 2) { t[i] = k + null; t[i + 1] = k +
  Infinity }` rolled back into one statement and `t[1]` was `k`; `k * 0` and `k * -0`
  alike (plan/counted-loops.js `same`).
Beside them: cse-load keyed an expression index by its first two operands and a
literal by its text (`i + '1'` was `i + 1`); the vector lifts' Infinity guard matched
`-inf`.

The review. The integrator's battery of the rule, written before the change was read
(14 pairs of leaves a text equates × 30 places a compiler shares or deduplicates code,
378 programs at six levels): 25 differing on `main`, 6 with the agent's four commits,
0 on the landing tree; the 6 were one defect of another class (the conditional
below). The 152-program probe of the first find: 0. Bench bytes by hash: identical on
all 105 cases at size and speed, so nothing to time.

Found in the review, on `main`, fixed with tests:
- Every level: `c ? -0 : 1` was the negated bit of the condition and `c ? 1 : -0` the
  bit, which has no -0: `1 / (k > -1 ? -0 : 1)` answered Infinity (emit/logical.js: the
  fold compared the literal with `=== 0`). `x - -0` was x, -0 for x = -0 where JS
  answers +0 (emit/arithmetic.js; found by the agent). A battery of the rule (a literal
  0 or -0 in 38 operations × 28 forms of the zero, the operand and the reader, 1,064
  programs at six levels): 48 differing on `main`, 24 the conditional and 24 the subtraction, 0 after.
- Two specifiers that spell one prefix (`./a-b` and `./a_b`, `./a/b.js` and
  `./a_b.js`) were one module's names: the first module's export answered for both, and
  a module-level binding of one name in each was refused as a compiler internal
  (prepare/handlers.js `prepareModule`; found by the agent).
- `nodeKey` wrote a leaf that is an object, a function or a symbol by `String`, every
  object one leaf where `nodeEqual` tells them apart by identity (as watr's
  `structuralKey` did before). It now refuses such a leaf: a node that holds one fails
  its compile instead of sharing a key. It threw nowhere in the battery below, which is
  the census: no node that reaches a key in the suite, test262, the bench corpus or the
  compiler's own source holds one.

Open, from the agent, reproduced and not fixed:
- `JSON.stringify(o, [null, 1, 'a'])` keeps a key `"null"` (module/json.js: the
  replacer's list is read by `String`).
- The setters of getter-only `$a` and `_a` both report `$a` (module/core/error-object.js:
  a thrower's name collapses punctuation; a message's text only).

Not reached by any probe or corpus (the agent's instrumented copy; reasons from the
code, unverified): the store passes' address keys (sink-stores, forward-store,
early-stores, carry-stores, forward-hops), the vectorizer's index keys (alias, ramp,
stencil, counter-run, lift, tone-map), loop-versioning's forms, twin-locals,
integral-loops' hull tests, guards, and pair-tests, hoist-splats, dot-slp and
share-quotients, whose passes the probes did not make fire.

Compile time (the agent's, not rerun: CPU over 95 bench cases at level 2 and speed,
base and new run at the same time each round on a loaded machine), base against new:
568.9 s and 560.2 s, 537.8 s and 537.4 s, 457.2 s and 458.8 s. Every key and
comparison together costs 109 ms where the JSON text cost 375 ms, of 565 s of compile
CPU: the equality at integral-loops.js:1322 no longer writes two texts (0.5 ms against
281.8 ms), and `idxKey` is the costliest key (123,749 calls: 59.6 ms against 16.5 ms).

Battery on the landing tree (e232efb25): `lint:imports` and `audit:files` clean; bench
bytes identical by hash on 105 cases at size and speed against 5b0a63dda; core 7,317,
level 0 7,100, level 3 7,114, wasi 7,189, generated 68, test262 4,120 and 0 failing,
self-compile 89, all passing; the integration suite 224 (1 skipped), 76, 76 and 79 at
the default, level 0, level 3 and wasi.

The integration suite is a step of a landing from here: CI runs it on each of the four
legs and the integrator's battery did not (it ran green on CI's legs for the landings
before; no failure was missed, the step was).

## CI read whole: three regressions of the takeover's landings (2026-11-12)

A push runs six workflows (test, self-compile, bench, test262, examples-perf, pages).
The integrator read `test` alone after each push. Read whole, two of the others had
gone red on its landings, and a native defect of the same landing sat beside the first:

| what | since | cause | fix |
|---|---|---|---|
| `self-compile`: the hosted suite's "integer width: only nonzero masked unsigned shifts prove signed storage", level 1 | 6ccc51b90 (2c) | the numeric table's word of one number by `v.lo \| 0`: run as wasm, the compiler takes a number past 2^63 for -1, so `n >>> 1e100` was a shift by 31 to the storage decision | f2b4a81fe |
| a module binding that holds +Infinity and is read only as a word held -1 (`const C = Infinity; C \| 0`), native, every level | 9ea3a640c (2c) for any numeric binding; before it for one a function writes | the binding's store converted by asI32, which has no test for the infinity; a local's store uses toI32 | 4a7728aec |
| `bench`: "size setops jz < as": 5,069 B against AssemblyScript's 5,037 | 4f5754644 (the eight fixes) | `Array.isArray` asks the value where its operand may be missing, so the guard split-bindings puts before the loops over a binding that mixes an array with primitives no longer folded for one that mixes it with nothing but a missing value, and each such loop was emitted twice | 47103b716 |

The hosted compiler (f2b4a81fe). The compiler's source has to convert a number it reads off
the source by `int32` before any bitwise operation, since compiled by itself it
converts as its own output does (README, "Bitwise operands under 2^63"). Four places
did not: the numeric table's `toWord`, the loop planner's hulls of a shift by a
literal, the typed element range of `x >>> K`, the folder's `Math.imul` and
`Math.clz32`. `int32` is the numeric table's now. The battery of the rule (a literal past
2^63 as a count or an operand in 29 forms, 348 programs at six levels, through a
hosted compiler built from each tree): 43 differing on `main`, 7 after, the same 7
the native compiler gives (a constant local read at run time at levels 0 and 1: the
documented divergence). The native legs cannot see this class; `test:bootstrap --
--full` and the `self-compile` workflow can, and AGENTS.md says so now.

An infinity held as a word (4a7728aec). A battery of the rule (+Infinity from ten sources
into eighteen holders under eight converting reads, 1,344 programs at six levels):
104 differing before 2c, 368 on `main`, 0 after; every one a module binding (locals,
parameters, cells, fields and elements were right). One bench case moved
(stdlib-dists, 24 bytes smaller at speed; 111.5 ms against 111.4 in eight paired
rounds).

The doubled loops (47103b716). A binding that is an array wherever it holds a value (an
element of an array of arrays, a `find`'s result) is not versioned by split-bindings:
the guard's miss is the missing value's TypeError, which the statements as written
throw at the same read. Eight bench cases moved, all smaller: 10,769 bytes at size and
40,312 at speed (setops 5,069 to 4,980, under AssemblyScript again; polytri 31,326 to
28,932 and 66,173 to 62,248; webaudio 369,044 to 361,101 and 1,280,363 to 1,243,965;
async and the four three.js cases 67 to 69 bytes at size). Their times, twelve paired
rounds each (webaudio twenty-four): 0.985 to 1.004 of before. A battery of the
rule (an array that may be missing, from 14 holders, read by 14 loop forms, there and
not, 196 programs at six levels): 0 differing before and after. This returns the
bytes the plan's note on the eight fixes called "precision to return" for polytri and
setops; the null test kept beside an undefined one (the other half of that note) stays.

The Porffor evidence gate of `bench` and the `claims` job of `test` are red as before
the takeover (handover, "Red"): the reference run is the owner's.

The procedure, from here: after a push, every workflow of the push is read (`gh run
list --limit 8`), and the battery has two more legs, the invariants leg
(`JZ_TEST_OPTIMIZE=3 JZ_DEBUG_INVARIANTS=1`) and `test:bootstrap -- --full`, whose
hosted suite is the one place a compiler source outside the hosted subset shows.

## 5a landed: the pass table (2026-11-12)

The agent's two commits (d462f1b6e, e7e5d1fd2; brief `.work/phase-5a-pass-table.md`) and
two of the review (b8d12a2bd, b03e99d4e).

What it is. No file under `src/optimize` imports `ctx.js` (15 did): what the passes read
of the compile is read once, as the module stage starts (wat/assemble/optimize-module.js
`passFacts`; link's and the tail's facts were values already), and what a pass wrote into
the context it hands back (an inline cache's globals through `icSite`, the lifted
functions, the quiet loops, whether a loop compacts). The order is one table,
`src/optimize/pass-table.js`: 123 entries in 7 stages (module 17, each function 43, the
two per-function pairs the module stage interleaves 2 and 2, link 12, link's
per-function bodies 2, the tail 45), each with its flags, the steps it follows and why
(98, each from the code's own order comment), the facts it takes and makes, the
emitter's marks it reads and drops. The four hand sequences (driver.js, optimize-module.js,
link/index.js, watr-tail.js) are walks of it: each stage lists its runners in the
table's order, and `stage` fails where it loads if the two differ. `src` is 359 lines
longer (945 added and 586 removed in 24 files): the table is data that was comments
and `if`s spread over four files, and no pass was deleted. Phase 7 deletes.

No byte moved natively. The integrator's two differentials, each tree hashed in a
process of its own: every optimize flag (196: the registry's and the five the code
reads beside it) set true, false and 1, one at a time at level 2 and at speed, with
watr off and its six cleanup flags, and 12 pairs the hand sequences nested, on four
programs and six bench cases (7,902 compiles, 82 of the flags moving a byte somewhere:
0 differing, on the first three commits and again on the fourth's content); the review
batteries' programs at six levels and two WASI levels (10,960 compiles: 0 differing,
on the first three commits, not run again on the fourth). Bench bytes by hash, the
landing's tree against the same tree without the four commits (77d1d2846): 0 of 105
cases moved at size and at speed.
The agent's own (1,729 compiles of the phase-4 feature programs
with flags flipped, the bench at five configurations, the examples): 0.

What the review changed:
- Nothing held a step to the facts its entry states (b8d12a2bd): link's rewind listed 8
  of the 19 it reads. Under JZ_DEBUG_INVARIANTS every step is handed its facts through a
  guard (test/_facts-guard.js; a Proxy, so it lives with the tests): a read of a fact
  the entry does not take, or a write of one it does not make, fails the compile naming
  the step and the fact. The suite's level-3 invariants leg and CI's fuzz job run under
  it. `checkOrder` compared positions across stages, the run's order only while a walked
  stage's entries stand right behind the step that walks them: it now fails a table
  where they do not.
- The hosted compiler (b03e99d4e). As handed back, the compiler compiled by itself came
  out 9.5% larger and 9% slower (39,275,064 bytes against 35,851,758; ten bench cases
  at two levels in 10.1 s against 9.3), and no native check shows it: the integrator
  met it reading the bootstrap leg's build line. Two causes, each found by measuring a
  hosted build (a census of the inline-cache sites by property name and by function,
  and of the closures the summary gives up on):
  - A step is named after its flag, and the runners were records keyed by step name
    (an entry's `after` too). A field of that name in any record gave every read of the
    flag off the config, the compiler over, an inline cache that never hits, the config
    being a dictionary: 4,123 cache sites more, of 9,641 (optimize/devirt.js
    devirtSchemaReads keys on the property's name program-wide).
  - Collected into a Map and called off a list made from it, the runners were closures
    of unknown use, and 1,542 closures more were with them: the comparators and
    predicates the passes hand `sort`, `some`, `filter`, emitter handlers. The chain
    from the one to the other was not traced.
  A stage's runners are now a list of `[id, runner]` it walks itself, where it calls
  them. The hosted compiler is 2.1% larger and 1.3% slower than with the hand
  sequences (36,617,101 bytes; 9.93 s against 9.80 in four paired rounds on a loaded
  machine): the cost of 123 calls through a list.

Two defects of jz the table met, open (each general: any large program with a config
dictionary, or with a table of handlers):
- A read of a property through a receiver the summary knows nothing of takes an inline
  cache wherever any record of the program has a field of that name, also where the
  receiver there is never a record. Smallest known source: the compiler itself.
- Closures collected from one list into another (through a Map, a `map`) are of
  unknown use, and take other closures with them.

What holds the table, and what does not:
- Held: the flags are registered keys; a step runs after the steps it follows and after
  the maker of what it takes; first and last of a stage; a walked stage's place; a
  stage's runners against its entries; takes and makes, as it runs.
- Not held: `drops` and `lost` are a measurement (571 compiles: the bench at three
  levels, the examples, the phase-4 features), true of that corpus. A step's `after`
  says what the comment said; that the order is needed is proven for none.
- The passes' helpers outside `src/optimize` were read for the same rule: of the
  modules they import that import `ctx.js` (ir/numeric.js, ir/mem-alias.js, reps.js,
  static-data.js, static.js), none of the functions they call reads it, nor calls one
  of the three in ir/numeric.js that do (`asF64`, `toInt32`, `wordQuotient`).

What the table shows, left as it is (phases 6 and 7 decide each):
- `splitLoopPrivateScratch` rebuilds more marked nodes than any other step (19 marks,
  among them 9,921 of about 88,000 `irange`, 1,100 `presentNumRead`, 428 of 5,273
  `checkedTwin`) and runs before the readers of most: the schema devirtualization, the
  loop specializer, the integer narrowing, the third LICM. Those act on the marks left.
- `mem` (the alias class of a load or store) is dropped by fusedRewrite (648 of 17,797),
  forwardStores (531), foldLoadCasts (950) before sinkStores and reuseLoads read it; 12
  steps drop `irange` before int-range's readers. A dropped mark is a missed
  optimization, not a wrong answer (a miss means no fact): inferred from the code.
- optimizeFunc's all-off gate tests 13 flags, two of them no function step's
  (propagateLocals, sortLocalsByUse), and omits the flags of 24 function steps: with
  the 13 off, `{ level: 0, intNarrow: true }` runs nothing.
- The write closure (which function may write which global) is built where a step first
  asks, so before or after the function walk by program and flags; forwardHops and
  hoistGlobalConstLoads may read one built before the walk added the inline caches'
  writes. Sound for the globals they ask about by reading; not proven.
- `holdWordNumbers` reads word locals ahead of `promoteCells`, whose comment says
  before every pass that reads locals; `poolFloats`' comment says last and four tail
  steps follow it.
- Not in the table: `quietLoops` at the stdlib pull; the vectorizer's recognizer order
  (phase 6).

Found by the agent, by reading: the hosted compiler's large-compile path resets the
compile state before the tail (scripts/self.js `releaseTo`), and the tail then read
`ctx.funcs.map` (which function is the program's: inlineTiny, loopPasses) and
`ctx.scope.globalValTypes` (the typed-length capture of the pointer hoist after watr),
both empty by then. The tail's facts now carry both from before the release, so a
large program compiled by the hosted compiler may change toward the native compiler's
output. The integrator read the same in the code; no large hosted compile was
compared apart from the bootstrap leg's recursive check.

The memo of phase 4 (outcome 3 of the brief) is not built, as decided: the agent's
key for a parsed helper (its text after the per-compile patches, the function stage's
flags, four program facts, the header-safe entries of its callees, the globals it
reads) is in its hand-back.

Compile time, native (CPU, base and new at the same time each round, on the agent's
two commits and the first of the review): the 94 single-file bench cases at level 2,
151.9 s against 151.2, 152.4 against 152.4, 158.9 against 161.9; at speed 217.0
against 216.6, 216.4 against 215.1, 221.6 against 223.9; 1,200 small programs at five
levels, 172.4 against 174.7, 177.7 against 174.3, 193.8 against 193.7.

## The index of phase 5b, measured before it was built (2026-11-12)

A census of the analyses the optimizer's passes each rebuild (a Sonnet scout and five
under it; `scratchpad/index-census/`, on b8d12a2bd; the bench corpus but jz, watr and
jessie, 103 cases at speed and at level 2, load 6 to 14, shares ±3 points):
- Where the compile goes: the function stage 15 to 17% (11,680 functions through 43
  steps), the tail 51 to 55% (watr's own fixpoint 24 to 32%, `constBases` 17 to 20%),
  the module stage 1.4 to 1.8%, link 1%.
- The same analysis run again on a function no step changed between: 0.6% of the
  compile's CPU over every named helper (`buildRefcount` three times a function, 0.25%;
  `copyRoots` 0.14%; `findBodyStart` 32 calls a function, 0.08%).
- 96.6% of function-and-step pairs leave the function as it was (97.5% in the tail).
- `watOptimize` replaces every function's array: nothing keyed by a node survives it.
  `narrowInts`, `narrowWrappedWords`, `narrowFloat32`, `narrowBoxedLocals` and
  `poolFloats` copy the whole body of each function they touch.
- What the passes derive apart, by count of sites: a function's body start 40 and over
  (five variants that differ on what a header is), the header's names and types 30,
  a fresh local name 13 through `nextLocalId` and 25 schemes beside it (four with no
  test for a name taken: `$__ran`, `__sr`, `$__w64_`, select-bits), a local's read
  count 18, its definitions 14, the locals a loop writes 32, the loops and their
  nesting 40, a node's parent 25, liveness four times, value ranges five ways.

So an index built once to be read many times saves no time worth the name (0.6%), and
was not built for that. What the census gives phase 7, which is where an index earns
its place, as the ground of one value numbering and one memory model: the list above
is what its passes ask, `watOptimize` and the body-copying passes are where it ends,
and a step that says whether it changed its function (96% do not) is what keeps it.
5b as planned is closed with the census; its two certain items are done or listed:
- `wordRanges` (below), the one helper that was a fifth of the corpus's compile.
- One source of fresh local names and one of a function's header: the four schemes
  that test for no name taken can collide only if a pass runs twice on a function,
  which none does today; listed for phase 7, whose passes run again.

## The range walk's environments (2026-11-12)

`optimize/word-ranges.js` held the intervals of the i32 locals at each point as a Map
and copied it at every write, refinement and join, so a walk cost writes times locals:
decode-wav, a decoder inlined into one function of thousands of locals, spent 49 s of a
71 s compile at speed in it, which was 20% of the compile CPU of the whole bench corpus
(the phase-4 agent had measured 18.9% and the cause was not looked for until the
census named the case). The environment is still a value, now slots in runs of 32
shared between points (963a49a64). No interval changed: the walk as it was and as it
is answer the same on every function of every bench case at speed, at size and with
the functions left whole (24,102 functions, 1,251,330 intervals; 82 s of walks against
13). decode-wav compiles in 23 s at speed and 19 s at level 2 (71 and 48) to the same
bytes; bench bytes 0 of 105 moved. Still slow, and not looked into: webaudio 78 s,
stdlib-special 46 s, stdlib-dists 36 s at speed, on a loaded machine.

## The landing of the table and the three fixes: the battery (2026-11-12)

Eight commits on 6e641dbde, landed together: the hosted compiler's words (f2b4a81fe),
an infinity held as a word (4a7728aec), the pass table (d462f1b6e, e7e5d1fd2,
b8d12a2bd, b03e99d4e), the range walk (963a49a64), the doubled loops (47103b716). On
the last of them, one leg at a time: `lint:imports` and `audit:files` clean; bench
bytes by hash 0 of 105 moved against the same tree without the table; the invariants
leg (level 3, the facts guard on) 7,127; core 7,328; `test:bootstrap -- --full`, its
five parts (round trip, kernel parity, checkpoint, the hosted suite, recursive); level
0 7,111; level 3 7,125; wasi 7,200; generated 68; the integration suite 224 (1
skipped), 76, 76 and 79 at the default, level 0, level 3 and wasi; test262 4,120 and 0
failing; the core suite in one process 7,328. All passing. Five and three quarter
hours, the hosted suite 81 minutes of it.

## Phase 6 measured before it was designed (2026-11-12)

Three measurements on d50ccbfbf, then the design. The scout's reports are
`.work/maps/vectorize.md`, `vectorize-leads.md`, `vectorize-census.md`.

**The lifts are not sound.** Nine plain programs answer differently from Node at levels
2, 3 and `speed`, and right with the vectorizer off; the published 1.0.2 answers the same
nine wrongly (run on both trees by the integrator). A local read after a reduction
(`d = a[i] * 2; s = s + d * d`, then `s + d`); `a[63 - i] = a[i]` in place;
`a[2 * i + 2] = a[2 * i] + 1`; a store under a condition beside a ramp; `(a[i] * a[i])
>> 16` into bytes; a counter stepped twice; a conditional arm's first store; a scalar an
outer pixel loop rewrites. The programs are whole in `vectorize-leads.md`. An alias
battery written the same day (two views of one buffer, 28 unit-step kernels, five
element types, 450 programs, 596,700 checks) found 0: it held no kernel shaped like the
nine, and the integrator told the owner "sound" on it before the scout's report came. A
battery proves its shapes, not the pass.

**The cause is one.** Legality is each recognizer's own: beside the shared helpers the
scout counts 4 private exit matchers, 4 step matchers, 9 address matchers, 8 write
censuses, 6 first-access classifiers, 5 alias tests and 5 lift bodies. The gate every
lift passes (`gateStrips`) tests two bases and skips two sites on one base as "the lift's
own dependence test"; six of the thirteen recognizers have none. Seven steps never ask
what the continuation reads.

**What the recognizers hold.** 589 loops lifted at `speed`, 425 at level 2, over 423
units (105 bench cases, 83 example kernels, the perf corpus, the spellings). 341 of the
589 have one possible taker. With only the bulk copy and the general map, stencil and
reduce, 350 of 587 lose their lift (`tryVectorize` 185, `tryStencil` 118). With the
general three moved to the front, 157 loops change taker, none is lost and three units
change bytes. Timed on 54 bench cases: alpha 10x from the ramp, blur 4.3x from the
channel reduce, hsl 4.7x and hwb 3.7x from `tryVectorize`, conv2d 2.9x from the outer
strip.

**What ordinary loops get nothing** (the alias battery's kernels, 178 of 450 lifted at
`speed`, 5 at `size`): a bound of `i + 1 < n` and the three-point stencil with it; a
descending loop; a step of 2; a counter or a local read after the loop; a load the store
may change; `min` and a conditional minimum; a ternary over integers; integer sums and
dot products. The spelling gate lists the descending loop (4 cells) and two counters at
`speed` (1 cell, the loop arrives unrolled by two). These are the scaffold refusing a
form (`matchBlockLoop`: one exit form, a unit ascending step, the step last), not a
limit of legality.

**The design, corrected by the numbers.** The reading before the census was that the
special recognizers collapse onto the general map, stencil and reduce. The ablation
refutes it: they hold 60% of the lifts. The order of the chain, though, holds almost
nothing. So:

- 6a (`.work/phase-6a-legality.md`): one legality for every lift, a function of the
  scalar loop: a dependence test over every pair of sites, one base or two; one account
  of the locals the loop writes; each private lift held to what the shared lifter
  refuses. The nine fixed by class, the thirty leads run down, a population of
  dependence-shaped loops in the generated suite. No byte moves but where a lift was
  wrong.
- 6b: the loop's facts (induction, bound, steps) from the emitter's own, not matched
  back out of WAT, and the forms above lifted through them: the coverage table is its
  gate beside the spelling gate.
- 6c: the recognizers become lowerings of a loop the legality has passed, chosen by
  cost; the private re-derivations and the fixed-order chain go.

## Decisions taken

- Normalization is value-exact and runs before the summary (kinds unknown there):
  a step is rewritten only for a counter that starts from a number and is only ever
  stepped; `i !== n` needs a start-below-bound proof and belongs to phase 2.
- `interval-proof.js` is grown into the analysis; a seventh is not written.
- The tape stays the link stage's IR until phase 5 decides: 40+ array passes and the
  emitters are array-based, and the index can be built on either.
- watr stays generic. JS-level facts live in jz.
- Phase 4's memo is not landed (the owner, 2026-11-12): phase 5's facts make the cache
  it was a lookup, and its measurements are in phase 5's brief.
- The index of phase 5 is not built ahead of its readers (the integrator, 2026-11-12,
  on the census: 0.6% of compile CPU is all it saves alone). Phase 7 builds it with
  its first value pass. The owner was told and may say otherwise.
- The compiler's own source keeps to the forms jz compiles well where a table is
  central (pass-table.js's header: no record keyed by a flag's name, no list of
  closures made from another), until jz's two defects there are fixed.
- A push is read whole: every workflow of it, not `test` alone.
- A defect found on the way is fixed where the phase's change touches it or where
  ordinary code answers wrong; the rest is listed here with its smallest source and
  left to the phase that rebuilds its ground (the owner, 2026-11-12: no time on what a
  later phase replaces).
- Phase 6 keeps the recognizers as lowerings and makes legality one (the integrator,
  2026-11-12, on the ablation). Soundness comes first, as its own landing.

## Open questions

- Whether `do…while` becomes a first-class bottom-tested loop through emit, or a counted
  `for` with bound `N > i0 + s ? N : i0 + s` under a guard fact. Decide in phase 1 from
  what the emitter and the vectorizer scaffold accept.
- A memo shipped as build-time data would help the first compile of a process (160 ms
  against 29 ms warm for the same program); the per-process memo does not.
