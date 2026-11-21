# Architecture work: one generic optimizing layer

Started 2026-11-09. The owner's brief: a clean, minimal architecture whose optimizations
are general, so that ordinary numeric JS compiles well however it is written. This file
is the plan and its state. The handover of the earlier work is `.work/handover.md`.

The briefs this record names (`.work/phase-*.md` but 9b's, `counter-widths.md`,
`node-keys.md`, `exception-edges.md`, `populations-port.md`) and the scouts' maps
(`.work/maps/`) were deleted on 2026-11-16, on the owner's word, their work landed or
dropped: `git show df1f0a143:.work/<name>` reads one as it last stood.

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
| 4 | Compile time: memoize jz's per-function passes for parsed helpers (key: IR, config, four module flags, callee closure), a `settled` set for watr | allocating programs compile 3× faster warm; a debug mode proves memo = fresh on the whole suite | handed back, held unlanded (branch `worktree-agent-ad38f46bbe9197c87`, a48e8b6fe on ba71f66a6; `.work/phase-4-compile-time.md`): the memo is byte-identical with it off on the agent's checks (the suite compared compile by compile, 561 corpus pairs, bench bytes; not run again by the integrator), and warm allocating one-liners compile 1.25× to 1.36× faster, not 3×: the per-function passes are 20 to 26% of a warm compile and watr about 75% of what remains; `npm test` CPU -8%, its wall time unchanged; a `settled` set for watr breaks byte identity and the byte-safe segment memo has a ceiling near 11% of watr's time. The 3× was the plan's estimate and it was wrong. Held, the owner's decision (2026-11-12), on the integrator's recommendation: the mechanism (518 lines under `src`, 491 of them recording what each pass reads through proxies, and state kept across compiles) is what phase 5's explicit `(fn, facts)` inputs replace with a keyed cache, and landing it now puts it under `src/optimize` just before phase 5 moves every file there. Its findings go to phase 5's brief: what the passes read, emit's node marks, `word-ranges.js` at 18.9% and watr's `optimize.js` at 19.1% of compile CPU Dropped 2026-11-15 on the owner's word ("if useless then drop"): its base stands before phase 5, which took `ctx` out of every pass the memo recorded through, so it would be written again, for 1.25x to 1.36x on warm one-liners. The branch is deleted, its tip in the handover; the two costs it measured (`word-ranges.js`, watr's `optimize.js`) are where compile time is to be had. |
| 5 | Pass table and shared index: every optimize pass takes `(fn, facts)`, order and requirements are data, def-use and loop tree built once | no `ctx` read under `src/optimize`; the hand sequences are generated from the table | 5a landed (d462f1b6e, e7e5d1fd2, b8d12a2bd, b03e99d4e; `.work/phase-5a-pass-table.md`): the order is `src/optimize/pass-table.js`, 123 entries in 7 stages, and no file under `src/optimize` imports `ctx.js`. The sequences are not generated from the table: each stage lists its runners where it calls them and fails where it loads if list and table differ (runners collected by the table made the hosted compiler 9.5% larger; as landed 2.1%). No byte moved natively. 5b is closed with a census and no index: built once to be read many times it saves 0.6% of compile CPU, so it is built with phase 7's passes, which need it; the one helper the census found costly, the range walk, is fixed (963a49a64: decode-wav compiles in 23 s, was 71). See "5a landed" and the two sections after it |
| 6 | Vectorizer legality from induction facts and a dependence test, if-conversion; recognizers become cost choices | the fixed-order recognizer list is gone; no corpus cell loses SIMD | 6a landed (6ae8ff1f1 to 07da84014 and the review's 21112c9aa, dc4858fbc, cdc3b0711; `.work/phase-6a-legality.md`): every lift passes one legality (`vectorize/legality.js`: memory, locals, iterations), the nine wrong programs fixed by class and the leads run down. One loop lost its lift, bench/spmv's rows, whose lift was wrong. Ahead of 6b: counter widths (the examples gate's rfft at 0.64x of V8, one root with the 252 loops the vectorizer refuses for an f64 counter): landed as a tier above the planner's copy (b41b03528 to afc2446f3; "Counter widths landed"): rfft 1.06x, no input slower than before by more than the entry tests. Then 6b the loop's facts from the emitter (`.work/phase-6b-loop-facts.md`, with its writer), 6c lowerings chosen by cost. See "Phase 6 measured before it was designed", "6a landed", "Found reviewing 6a", "The loop's facts, measured for 6b", "The examples gate" 6b landed (1195ad0ed, 5a6fffa78, f1df9cc00, dcee6f67f): a counted loop is read once (`vectorize/scaffold.js` `describeLoop`), shifted, inclusive and descending tests lift through one scaffold, and which loops of the alias battery lift is a table that only grows (`test/vector-coverage.json`, 321 -> 357 of 840). 6c landed (49a1a75b9 to f8ec7f7fe; `.work/phase-6c-lowerings.md`, "6c landed" below): every lowering is asked of every loop and the lift whose pass costs least is emitted, a reduction's exact lowering beside the reordered one; the fixed order is gone. |
| 7 | Value passes on the index (numbering, redundancy, constants, memory) | the forwarding and reuse files are deleted, ratchet not above today's | 7a landed (778a2225e to 9b05247da, the review's acd02157e; `.work/phase-7-values.md`, the scout's map `.work/maps/value-passes.md`): one effects summary answers what a call does (`src/optimize/effects.js`), six closures and nine hand lists deleted. 7b and 7c landed (dcd903159 to 650e3f5b9, the counted copy b2dcc75c8 to 4f8e40cd1; `.work/phase-7b-values.md`, "7b and 7c handed back" below): one address form (`src/optimize/address.js`) and one numbering (`src/optimize/numbering.js`) under every memory pass; `cse-address.js` and `reuse-loads.js` are deleted, `forward-store.js` and `forward-hops.js` stay on the shared reader. Bench bytes -78 at size and -308 at speed in 29 cases, then +251 at speed in 7 by the counted copy, which closes 32 cells of the spelling gate (74 gaps to 42). |
| 8 | Peephole rules as a checked table | each rule has a machine-checked equivalence | landed (d0976a1ed to 094d0e159): `src/optimize/rules.js`, 32 rows, each with its relation, checked by `test/rules.js` on every row's own values and on a population; one `foldMemarg` for the three passes that folded an address's constant apart. |
| 9 | Claims: a held-out lane measured once on first contact; a lane at exact JS semantics; relaxations opt-in | README states only what the lanes show | 9a landed (50f7854d3 to 53a139b82): every float rewrite that rounds otherwise than JavaScript is one option, `optimize.relaxedFloat`, on at `'speed'` alone; the lanes `jz-exact` and `c-wasm-fast`; README's and the landing's measured figures written from the dataset. 9b landed (4f74e5006, 13f00eb3d; `.work/phase-9b-heldout.md`): the held-out lane, 25 programs registered and none fetched, its record a chain the workflow alone appends to. Its first dry run's two programs that no lane can run are marked not measured (7795bde16, c97822437). The contact run waits for the last compiler phase. |
| 10 | CONTRIBUTING.md cut to a guide; shape-pin tests retired with the recognizers they pin | under 30 KB; pins replaced by gate cells | the guide landed (b4061dd72 to a79b59c52): 501,512 -> 32,730 bytes, 24,977 outside the public contract. By the owner's word (2026-11-16) a design note is kept only where a change would go wrong without it, in the header of the file it concerns; `.work/phase-10-docs.md` is the ledger of every block. The tests' part, by the same word, landed (185dbcd8e to 85f101fe2): test/ scripts 8,962,098 -> 8,480,711 bytes, comments cut by the same test and 844 warnings restored, nine tests that guard nothing deleted, 44 stale titles renamed. "Pins replaced by gate cells" is not done: no pin is of a deleted recognizer, and no gate has a cell for a helper's absence ("Phase 10 mapped before it was briefed" below). |
| 11 | Meet the claims: every sentence of AGENTS.md and README the reference run contradicts (`.work/claims-for-the-owner.md`) | a reference run passes the claims gate: each gap closed, or an exception earned by measurement as AGENTS.md says | after phase 10 (the owner, 2026-11-15); the sentences stay as written until then |

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

## CI of d50ccbfbf, read whole (2026-11-13)

`pages`, `examples-perf`, `test262`, `self-compile` green: `self-compile` was red from 2c
to this push. `test`: fuzz, default, level 0, level 3 and wasi green; `claims` red as
before the takeover (the reference evidence lacks cases, is stale and was measured under
swap: the owner's reference run). `bench`: 319 of 320, the one failing the Porffor
evidence check (alpha 13 committed, alpha 19 required: the same run); the size gate that
was red since the eight fixes passes.

One thing the count does not show. Inside `npm run test:bench` the examples gate
(`examples/bench.mjs`: geomean over 1 and every gated example at 0.9x of V8 or better)
exits non-zero on CI's bench runner and no test fails for it: `okTiming`
(`test/bench.js:234`) prints a timing assertion as "informational on CI". On this push:
ulam 0.84x, lenia 0.75x, rfft 0.45x. It is not of the takeover: 32cc7697b (2026-11-06)
printed lenia 0.84x and rfft 0.46x, and the eight runs read between print rfft at 0.29x
to 0.47x every time, lenia at 0.73x to 0.90x. The other workflow (`examples-perf`,
`examples/bench-pages.mjs`, whole pages on three machines) has ulam at 1.20x to 1.55x and
lenia at 1.04x to 1.48x on the same commit. So either the bench runner's CPU loses where
the others win, or the frame harness measures what the page harness does not. Open: not
run down. The comment over the gate says a demo's regression "trips CI, not a user"; on
CI it trips nothing.

## 6a landed: one legality for every vector lift (2026-11-13)

Eight commits of the writer (6ae8ff1f1 to 07da84014, `.work/phase-6a-legality.md`) and
three of the integrator's review (21112c9aa, dc4858fbc, cdc3b0711).

**The legality** is `src/optimize/vectorize/legality.js`, `legal(r, node, liveAfter,
env)`, called by `index.js` on every chain lift, every retry on rewritten counters and
the paired iterations; the prefilter, which has no strip, passes its locals and its
count through the same two checks. It takes the lift (its strips from the scaffold's
registry and what the recognizer declares on its result), the scalar loop, and what the
continuation reads (an exact scan: an `if`'s other arm is no continuation, a write on
both arms kills). Three parts:

- Memory (`alias.js gateStrips`, now over two sites of one base too). A constant
  distance is held to the order a strip runs the sites in: with A before B in the
  body, B of iteration j - k touching what A of j touches, 0 < k < the strip, is the
  reversal and declines; every other constant distance is kept (`a[i] = a[i + 1] * 2`
  stays lifted). Any other distance on one base takes the run-time test two bases
  already had. A lift that versions its own one-base distances says `versioned` (the
  general map and stencil), one that runs statements lane by lane in the loop's order
  says `inOrder` (an outer strip's epilogue).
- Locals (`localsHold`). Every local the loop writes is an induction (a strip's counter
  or one the lift names, written once, at the top level, as `x = x + step`), private to
  an iteration (written before read on every path, not read after), a reduction the
  lift declares, or one it declares landed. Anything else declines; a recognizer that
  says nothing lifts no loop with a carried or live-out local.
- Iterations (`countsSigned`). A loop that leaves on `i <u bound` opens its strips only
  behind `i >= 0 && bound >= 0`, where the signed count the strip keeps is the loop's.

What each recognizer declares: `tryVectorize` its flag landings; the general map its
secondary counters and `versioned`; both reduce tiers their accumulators; the general
stencil `versioned`; the gather map and the prefilter what their scalar parts write;
the divergent escape, the per-pixel colour and the three outer strips their pixel
counters and the epilogue `inOrder`; the paired iterations their counters; the bulk copy
and the channel sums `ordered` (they keep the loop's order of every effect and answer
for themselves).

**The nine** by class: W7 to W9 the dependence test; W1, W2 and W6 the account of
locals; W3 and W5 a store under a condition (the shared if-store declines a store whose
width is not the lane's, the tone map an arm with a store before its last); W4 a shift
in a narrow lane (a constant count below the lane's width). **The leads**: 15 programs
of the straight-line packer (a zero sum's sign, a load the low store may write, a second
dot reading the first's output, an accumulator read past the pair, a kept addend
rewritten, `s += s * y` hoisted, a -0 reset), a counter bumped mid-body, an address
through a copy of the counter, u8 x u8 taps in 16-bit lanes, a strided or reversed tap,
ten of the channel sums, a pixel local read after, the prefilter and four others under
an unsigned exit: all wrong on base, fixed, pinned in `test/vector-legality.js`. Four
leads answer right, with the check named; eight are unreachable from source, with the
reason (the writer's report; not re-derived by the integrator).

**What it cost.** One loop lost its lift: `bench/spmv`'s rows, whose lift was wrong (see
below). Takers over the 423 units: 424 to 423 at level 2, 589 to 588 at speed, no other
taker moved. Bench bytes by hash: spmv at speed alone (6,458 to 6,264); the census
units: `examples/rfft` (+63, +64: its cepstrum mirror behind a run-time test) and
`bench/mat4` at level 2 (+58: its dot pairs' +0 seed). The hosted compiler 36,627,017 to
36,735,135 bytes (+0.30%, the writer's build). Compile time: within noise on
stdlib-special, stdlib-dists and decode-wav; webaudio +0.6% in 6 of 8 paired rounds,
with the vectorizer's own inclusive time unchanged in a profile (628 ms of 54 s): cause
not located, listed.

**Not reached.** "One check where one serves": five private alias tests stay
(`aliasGuards`, the stencil's in-place gate, the bulk copy's overlap test, the paired
iterations' roots, the gather map's distinct parameters): removing each made new lifts
or moved bytes, which is 6c's to weigh. `tone-map.js`'s header still says "gated".

## Found reviewing 6a (2026-11-13)

The integrator's populations, written without reading the writer's tests, each program
against Node at six levels.

- 683 dependence-shaped loops (two sites of one base in either statement order at
  distances around a strip, stencils and records in place, what a loop leaves in a local
  or a global, ramps, arms, exits, outer loops, straight lines, one function over arrays
  apart or one): base answers 16 wrongly, the landed tree none.
- 1,000 programs of narrow-element arithmetic (48 expressions over seven integer element
  types and twelve mixed triples, eleven reductions): base answers 11 wrongly.
  - **A comparison in a narrow lane** (dc4858fbc). A store into a `Uint8ClampedArray`
    clamps by `v < 0` and `v > 255` on the word; the lift compared byte lanes signed, and
    `b[i] = a[i] & c[i]` stored 0 for every byte past 127. A comparison lifts to a byte
    or 16-bit lane only where both operands fit it under one reading (`lift.js
    laneCompare`). No census unit's bytes move.
  - **A uint32 divided as a signed word** (cdc3b0711), no fault of the vectorizer:
    `((x >>> 0) / 3) | 0` was -715827882 at x = 2^31, at levels 2 and over and at size,
    for a `Uint32Array` element, `x >>> 0` and a local holding one; `u[i] % n` by a
    runtime divisor the same at every level. 53 of 135 programs.
  - Not a defect: `(u * v) | 0` of two uint32 whose product reaches 2^63 is -1 at every
    level, the README's "Bitwise operands under 2^63". The integrator listed it to the
    owner as a defect before reading the README; a grep that finds nothing is not a
    reading. The same of float sums: a scout reported sums, dots and products
    over a Float64Array differing from Node in the last digits at levels 2 and over as
    undocumented; the README's "Float sums in lanes" covers it, though it says "two
    lanes" where `speed` runs four accumulators of two and a product is reassociated
    as a sum is (phase 10).
- **An assignment's value** (21112c9aa), found by the writer as a lead it could not
  place: `if (t = x === 3 || x & 1)` took the false arm when t became true, `(t = …) +
  10` was NaN, at every level, for a local, a module binding, a captured one, a field, an
  element. `VT['=']` called a Boolean beside a Number a Number. 30 of 42 programs. Open:
  `(f64[1] = (x === 3 || x & 1)) === true`.

All three, and the nine, are in the published 1.0.2.

**bench/spmv was measured on wrong code.** The outer strip summed the even row's range
of nonzeros for both rows of a pair: every odd row of `y` was wrong at levels 2 and
over, in 1.0.2 too (`rowPtr[r] .. rowPtr[r + 1]` taken at the first row for both). The
bench's checksum reads every 256th 32-bit word of `y`, which falls on even rows, and
agreed with Node's. Scalar, as written, the kernel takes 1.87 ms against the wrong
lift's 1.08; in six paired rounds on the M4 it still leads every wasm producer and both
JS engines (AssemblyScript 2.38 ms, bun 2.66, V8 3.34, C to wasm 5.93; native C 1.69).
The checksum is the bench's and is not touched here: a checksum that samples cannot
hold a parity claim, and the other cases' are not audited.

**Left to the later steps**, from what 6a declined. For 6b: a local read after the loop
landed by a last scalar iteration; an in-place mirror versioned at its midpoint. For
6c: an outer strip whose rows have their own ranges (spmv: equal trip counts tested at
run time, each lane its own index); a clamped store as a saturating narrow from wider
lanes, where today a clamp declines; the comparisons through a lane local of several
definitions.

## The landing of 6a: the battery (2026-11-13)

Eleven commits on 6beb3dc53, landed together: the writer's eight (6ae8ff1f1 to
07da84014) and the review's three (21112c9aa, dc4858fbc, cdc3b0711). On the last of
them, one leg at a time: `lint:imports` and `audit:files` clean; bench bytes by hash 1
of 105 moved (spmv at `speed`, 6,458 to 6,264: the lift that was wrong, gone); the
invariants leg (level 3, the facts guard on) 7,142; core 7,343; `test:bootstrap --
--full`, its five parts (round trip, kernel parity, checkpoint, the hosted suite,
recursive); level 0 7,126; level 3 7,140; wasi 7,215; generated 69; the integration
suite 224 (1 skipped), 76, 76 and 79 at the default, level 0, level 3 and wasi; test262
4,120 and 0 failing; the core suite in one process 7,343. All passing. Five hours and
thirty-five minutes, the hosted suite 76 minutes of it.

The battery had no timing leg, and a gate that fails nothing on CI (above) was not seen
by it either. After it, the examples benchmark (`examples/bench.mjs`) on the base and the
landing tree, alternated twice on the M4: no example's jz time moved past 2.4% (rfft
14.8 us and 14.9, 0.64x of V8 on both; geomean 1.60x). The benchmark is a leg of the
battery from here, compared against the base's run.

## The loop's facts, measured for 6b (2026-11-13)

A second scout (Sonnet 5.5) on cdc3b0711, read-only: `.work/maps/loop-facts.md` (what
the emitter knows of a loop and what reaches the optimizer), `loop-refused.md`
(seventeen loop forms, the first check that refuses each), `loop-census.md` (the
refusals over the 423 units at `speed`). Leads, not facts.

- The emitter's link per loop (`compile/emit/control-flow.js`, `loop-model.js
  loopFacts`) carries the counter, its hull, the step's magnitude and the bound's range;
  the start, the bound's shift, the step's sign and the exit comparison are computed and
  dropped. It has three readers, not the two 6a's brief named: the vectorizer (the
  counter's name, and an assertion) and `optimize/peephole.js:577-596` (hull and step).
- Of 5,159 loops of user code with a load or a store, 1,318 have no scaffold. What an
  emitter fact would reach: a counter still an f64 where the vectorizer runs (252
  loops), a descending step (138), a constant step other than 1 (68), `<=` (20), a step
  by an invariant (8). What is a lowering's to gain (6c): a call in the body (1,241), a
  nested loop (604), the general map's decline (513, of which 298 a store's width
  differing from its load's), a call with no lane mapping (244), a carried local (325).
- `legal()` refused no lift in the corpus: 6a costs coverage nothing but spmv's rows.
- The two-counter loop reaches the vectorizer unrolled by two at `speed`
  (`compile/loop-recurrence.js stepOf` does not read the normalized `++k`).

The brief is `.work/phase-6b-loop-facts.md`. It waits on the counter widths (below),
which change its largest row.

## The examples gate: rfft below V8 since October (2026-11-13)

The owner asked for the examples gate's failures to be chased unless a later phase rules
them out (the gate prints them on CI and fails nothing: "CI of d50ccbfbf, read whole").
Measured on the M4 with `examples/bench.mjs`'s own protocol for one example, V8's time
9.6 to 10.1 us in every run:

| commit | date | jz, us | against V8 |
|---|---|---:|---:|
| 910a162d2 | 2026-06-15 | 5.10 | 1.89x |
| 167343490 | 2026-08-01 | 6.88 | 1.40x |
| f40a2a191 | 2026-09-15 | 7.15 | 1.39x |
| 3b61c97ef | 2026-09-21 | 8.04 | 1.22x |
| a2bb0b975 | 2026-09-27 | 9.51 | 1.02x |
| e88a8e907 | 2026-10-01 | 9.36 | 1.04x |
| 2c842394d | 2026-10-01 | 11.73 | 0.83x |
| b30443c4f | 2026-10-01 | 16.50 | 0.59x |
| v1.0.0, v1.0.2 | 2026-11-02, 03 | 16.3, 16.1 | 0.62x, 0.61x |
| d50ccbfbf | 2026-11-12 | 15.5 | 0.65x |

The example's source has not changed since May. The cliff is two soundness fixes of one
day: 2c842394d ("prove counter widths and preserve full Number loop bounds") and
b30443c4f ("Require true width bounds for index-local storage"). Both removed an
unsound assumption that a local used as an index is a word. In `transform` (the
split-radix butterflies: `while (i0 < N) { … i0 += id }`, `N` a module binding set from
a parameter, `id` stepped by `id *= 4` and `id << 2` in the loop around, eight indices
`i0 + j + 1`, `i1 + n4` … derived per trip) the index locals went from i32 to f64:
`trunc_sat` 8 to 163, `f64.lt` 0 to 51, f64 locals 21 to 52. The fixes were right; the
inference that should have replaced the assumption does not reach these loops: a while
whose counter starts outside its head and steps by a name the loop around it writes
gets no hull (`loop-model.js loopFacts`) and no integer copy
(`compile/plan/integral-loops.js`, whose cursors step by literals). The slower drift
before the cliff (5.1 us in June to 9.4 at the end of September) is spread over many
commits and is not bisected.

It is one root with the vectorizer's largest refusal an emitter fact would lift (252
loops whose counter is still an f64: webaudio 40, dwa 19, stdlib-special 14). No later
phase replaces it: it is a step of its own, before 6b, which then reads a counter that
is a word. Its gates: the examples gate passes on the M4 (rfft at 0.9x of V8 or better,
the aim above it), the census's f64-counter row drops, no source of a bench or an
example changes, and every byte that moves is timed.

ulam and lenia, the gate's other two on CI (0.84x, 0.75x on the x64 bench runner), pass
on the M4 (1.34x, 1.32x) and in `examples-perf`'s page harness on all three runners:
not reproduced here, needs x64 runs.

## Counter widths, measured before they were designed (2026-11-13)

A scout (Sonnet 5.5) on 557fbd525, read-only: `.work/maps/counter-removed.md`,
`counter-deciders.md`, `counter-rfft.md`, `counter-census.md`, `counter-guards.md`.
Leads; the integrator compiled five of its reduced programs and saw the same locals.

**What October removed was one assumption**: a local is a word because it is compared,
or feeds an index. On `e88a8e907` `x *= 65536; a[x]` read `a[0]`, a counter started at
2^31 - 1 ran no trip, and the reduced first pass of rfft never ended for `n >= 2^31 -
1`. Today a local is a word by proof alone (`widenLocalTypes`: a closed word hull, or
an integer whose magnitude no read observes).

**No proof exists for rfft's locals.** `id *= 4` leaves the word for `N >= 2^31 - 1`,
`i0 += id` for `N >= 3 * 2^29 - 1` (run: equal to Node at 1610612734, not at
1610612735), the stage loops' `ix = (id << 1) - n2` for `N >= 2^29`. A test of `N` at
the function's entry excludes them all, and under it the interval proof still cannot
close `id` and `ix`: geometric growth bounded only through another variable's loop
test. So the reading before the scout ("the inference does not reach these loops") was
half of it: there is nothing to infer; the words must be earned by a test at run time
that the copy keeps checking where the loop writes the names.

**The 252 by cause**: a bound with no range 117; a hull a step or a sum past the word
45; a counter that starts from or is updated by an f64-typed expression 49 (rfft's); a
side counter 16; not an integer 6; a step by a name 4; closure bodies 14; one other. A
test on the bound alone (emulated, an upper bound) turns 139 into words: 102, 28 and 2
of the first three. The planner's integer copies (`versionIntegralLoops`) refuse most of
them for want of something to test or a budget, not for soundness.

**Where a test can sit**: `transform` at N = 2048 enters its loops 1,213 times for
5,865 trips; the innermost twiddle loop 652 times for 1,252. A test at each of those
entries is about 12% of that loop, one hoisted to the `j` loop 0.2%.

**The brief** is `.work/counter-widths.md`. Its candidate, the integrator's, for the
writer to refute or adopt by measurement: the integer copy takes names the loop writes
too, proved for one trip under a box at the head; the box test joins the loop
condition; when it fails the copy leaves at a head and the loop as written takes over
from that state. No relation, no trip count, and not rfft's alone.

## A uint32 read as a signed word in the extent guard (2026-11-13)

Found by the integrator's own population for the counter widths step
(`SCRATCH/cwpop.mjs`, 612 loop programs at the word's edges against Node at six levels),
run on the base before the writer's change: 13 programs wrong at levels 2, 3 and
`speed`, every one with a bound `b >>> 0`.

**The root**: the emitter's versioning on typed extents (`compile/emit/control-flow.js`,
"Typed-bounds loop VERSIONING") computes its guard in i64 and extended every i32 word
it read with `i64.extend_i32_s`: the loop's bound, the counter's start, a stride, an
offset of the index. A uint32 past 2^31 has a negative word's bits, so `B - 1 < length`
held for a bound no array reaches and the unchecked arm ran. `const B = b >>> 0; for
(let i = 0; i < B; i++) { if (++c > 44) break; sum += x[i] }` at `b = 2^31` gave 36
where Node gives NaN (the elements past the end read as the memory there); `x[i] = c +
10` from a uint32 start wrote into the array through the wrapped address (the checksum
of `x` moved 204 to 369) or trapped; `x[i - off]` with `off = 2^32 - 1` read `x[i + 1]`.
The line is in every tag from v0.9.1 on (`git grep`); run here on the base and on the
tree before 6a, both wrong. It needs a uint32 of 2^31 or more and a loop that leaves
before the bound, so ordinary sizes never met it, but what it does there is read and
write outside the array.

**The fix** (33690d097 on `fix-uext`, off 2e9c2ffe7): the extension follows the word's
own sign (`ir.unsigned`), one line. A test in `test/unsigned.js`: nine loop shapes,
three bodies, two array types, twelve argument rows, against Node; it fails at its
first row with the line put back.

**Run**: a population for the class (`SCRATCH/uextpop.mjs`: a uint32 as bound, inline
bound, bound less and plus one, halved, mirrored index, `while`, counting down to and
from it, start, stride, six offsets of the index, cursors, nests; read, presence test,
store, read and store; four array types): 124 programs, 695,640 checks, 28 programs
wrong on the base (21,606 checks), none with the fix. The counter population's uint
programs: 66, 312,900 checks, none wrong with the fix. Bench bytes: 0 of 105 cases
moved. `unsigned`, `optimizer`, `integral-loops`, `index-width`, `element-bounds`,
`licm-loop-bounds`, `typed-length`: 627 tests pass; lint and audit clean. Not run on
this commit alone: the battery. It lands under the counter widths change and takes
that landing's battery.

**Read and left**: `optimize/guards.js combineGuards` also sign-extends i32 terms, but
only for a counter the loop itself compares signed and for sums the copy tested as
wrapped words; the population's offset and cursor shapes pass at `speed` with it.
## Counter widths built: the battery green, the landing held on what it costs (2026-11-14)

Not on main. Branch `fix-uext`, 2cfadf01a: 2e9c2ffe7, the extent-guard fix (33690d097,
1267dc7a6, its section rides with that branch), the writer's two (Opus 5.5: 3d8d3cb1c a
table rule, a product of two integers, one above zero and the other never -0, is never
-0; 06d4ea856 the box, `compile/plan/integral-loops.js`, its header), the review's two
(5cf9156fc, 2cfadf01a).

**The box**: a `while` that writes integers by other than literal steps and indexes by
them takes a copy holding those names as words while a box [0, 2^k - 1] holds them (k
the widest of 15 to 30 the interval proof closes over one round with the box's tests at
its head). Names the round only reads are in the box too, tested at entry. A head test
that fails writes the names back and the loop as written resumes.

**Found reading it, wrong answers, both fixed with a test that fails without the fix**:
the one cold loop of a copy that can leave was the loop as written past its guard, and
a `for (z += 5; …)` left at a sum ran its init twice; a stable name every write of
which is a word passed the box's range test at -0 and the proof read it as no -0
(`const z = -0; … i = (i + 1) * z` gave +0). Neither was in a release.

**Run on 2cfadf01a**: populations against Node at six levels (boxpop 380 programs,
3,683,106 checks; boxpop2 96, 2,128,896; boxprobe 48, 615,042; boxprobe2 25; boxprobe3
92, 1,490,400; three resumption probes 30; cwpop 638, 3,216,870; uextpop 124, 695,640;
6a's five): nothing wrong but one boxprobe program whose argument is a string (the host
passes jz a number: the same 150 checks on the base at every level) and vecnarrow's two
README programs. The battery: lint, audit; default 7,353, invariants 7,152, level 0
7,136, level 3 7,150, wasi 7,225, one process 7,353, generated 70, integration 224, 76,
76, 79, bootstrap full, test262 4,120 and 0 (run after the others from the corpus on
disk: the machine had no IPv4 that night, GitHub has no IPv6, and the leg's clone
failed). Bench bytes 0 of 105 by hash; the hosted compiler 36,744,067 to 36,862,622
(+0.32%).

**What it gains**: rfft 14.8 to 9.0 µs a frame, four alternating rounds (0.61 of
before, 1.04x of V8; the gate 25 of 25, geomean 1.64x). The f64 counters of the census
252 to 242 at speed: the box takes the counters updated by an f64 expression; a bound
with no range (117) and a hull a step past the word (45) are literal-stepped counters it
refuses by design. Pages timed alone, six alternating rounds: field-lines 0.93, nbody
0.96, wireworld 0.97, ocean 0.98 of before.

**What it costs, and why it is held.** Two defects of the box, both measured, neither
a wrong answer:
- A product with a stable name of the box never passes its guard. `hullOf` gives such a
  name the box's hull, `[0, top]`, so `px[y * W + x]` tests `min(top, H - 1) * top`
  against INT_MAX: false for every H past 3. The copy is unreachable and the loop runs
  as written where the base ran its integer copy. penrose's `drawLine`: the page 2.4%
  slower (a fixed plan, five alternating rounds: 4.41 to 4.44 ms on the base, 4.50 to
  4.56). The same walk spliced into a caller's loop: 0.72 to 0.76 µs a line on the
  base in each of four directions, 0.85 to 0.93 with the box; counters at the loop
  heads show every line in the loop as written. The head tests are not the cost
  (taken out of the WAT: no change).
- An entry outside the box loses the copy the loop had. With the name's own value in
  the product (a trial), the walk right and down gains 17% and the walks with a stride
  of -1 or a start left of zero run 6 to 8% slower than the base: they fail the box's
  entry and fall to the loop as written.
Handed back to the writer (branch `box-fix`) with one invariant: on no input does a
loop run slower than on the base by more than the entry tests. The box adds a tier; it
does not replace one.

**How pages are timed, learned here.** `examples/bench-pages.mjs` takes its plan (how
many frames warm, how many a batch) from how fast the JS ran in that process, and
times every page in one process. gauss-primes read 10% slower in four rounds of a
ten-page run; its frame's code is the same but for local names, its pixels equal JS,
and alone in its process it is equal (0.072 ms both). dithering runs at 3.0 or at 3.45
ms by process, on both trees and on a fixed plan. So a page is timed alone, and on a
fixed plan where its frames differ along its tour. The battery's examples leg read ulam
6% slower in two runs against runs of hours before; four alternating rounds: 0.999.

## CI of 557fbd525, read whole (2026-11-14)

`pages`, `self-compile`, `test262`, `examples-perf` green; `test`: default, level 0,
level 3, fuzz green; `claims` and `bench`'s Porffor evidence red as before (bench 319 of
320). `test (wasi)`: the runner lost contact 113 minutes in (62 to 72 on the five pushes
before), no log kept; the job run again passed in 58. Once, not reproduced. The examples
gate inside `bench` on that x64 runner: lenia 0.84x, rfft 0.44x, ulam 1.09x.

## The reference run: the rivals' current releases (2026-11-14)

The owner asked for the reference run on the latest Porffor, Bend 2 and Rust. What the
bench held against what is out: Porffor alpha 19 against alpha 23 (2026-11-10); Bend
2.0.39 against 2.0.40; rustc whichever the runner image shipped, in no dataset, against
1.100.0; AssemblyScript `~0.27` on CI (0.27.37) against 0.28.20, where the September
reference on the M4 was measured with 0.28.19. Pinned to those (cd89b0b74), and the
dataset now names rustc, zig, go and tinygo: a shard merge refuses where they differ,
and a prep stamp carries them so an upgraded compiler rebuilds its lanes.

A probe from the branch `bench-pins` (six cases with every port: alpha, crc32, sieve,
nqueens, levenshtein, wordcount; run 43567712864, a Xeon 6975P-C): every bumped lane
builds and answers. No wasm lane leads jz on the six (the nearest: zig-wasm 1.01x of
jz's time on nqueens, c-wasm 1.03x on crc32 and sieve). On crc32 V8, bun and JSC take
0.90 of jz's time (the handover's Intel and AMD forms). js2wasm (DIFF) and tslang (build fails)
fail as in the dataset of 11-09. AssemblyScript 0.28.20's binaries are 2 to 3% smaller
than 0.27.37's, rustc 1.100's wasm about 7% larger than the image's.

The claims gate on the committed evidence fails 18 of 31: its jz rows are of
2026-09-02 (1,585 compiler commits since), it lacks cases, was measured under swap; and
beside that it shows size against AssemblyScript on 8 cases, jessie against JSC at
1.83x under a 1.2x band, sdf and synth against JSC. The run says which are left. Its
freshness test fails again at the first compiler commit after it: it is a release's
gate, and `prepublishOnly` runs it.

## 1.0.x: how it is cut, and what 1.0.2 answers wrong (2026-11-14)

1.0.1 and 1.0.2 are not on main: each is a few commits off the tag before (eight in
all off 1.0.0, 31b57232f), the fixes carried to main a day later. main is 493 commits
past 1.0.0. 1.0.2 pins subscript 10.8.1 and watr 5.13.2; main has 10.8.3 (`do i++;
while (…)` compiles, `from`, `as`, `of` are names) and 5.13.5 (coalesceLocals: `if (a
|| i++ === 9) { r = -1 } else { r += i }` left 7 for 4 at level 1).

Run on the tag at the public levels (a worktree with its own pinned dependencies):
`((x >>> 0) / 3) | 0` at 2^31 is -715827882 at the default, size and speed; a clamped
store of `a[i] & c[i]` stores 0 past 127 at the default and speed; `if (t = x === 3 ||
x & 1)` takes the false arm and `(t = …) + 10` is NaN at all four. The extent guard's
uint32: a read past the end in one form, the bound written inline (`i < (b >>> 0)`),
3 programs of the 124 (28 on main before its fix); no store past the end. The
integrator had told the owner "a read and a write out of bounds in 1.0.2" from the
line's presence in the tag, not from a run: half of it was wrong.

The four fixes port: five of six source patches apply as they are, the sixth is an
export line. Not logged in to npm on this machine: the owner publishes.

## Counter widths landed: the box a tier above the planner's copy (2026-11-14)

The two timing defects the landing was held on are fixed by the writer (d6a6f23c9, 44d6282b7)
and re-measured by the integrator; one defect the battery found is fixed by the integrator
(afc2446f3).

**The roots.** D1: the walk read a name the box holds stable as the literal `[0, top]`. Under a
refinement (`y < H`) the product `y * W` was tested as `(H - 1) * top <= 2^31 - 1`, which no
height above 3 passes, so the copy never ran; over the box alone it was `top * top`, past the
word, and the index stayed a Number. D2: the box stood in place of what the planner builds with
no box, two ways. An entry outside the box (a stride of -1, a start below zero) failed the box's
guard and ran as written where the planner had a copy; and where only the box built a copy, the
loop beside it was marked cold (no vectorizing, no LICM, no recurrence) and lost its inner
copies, where the base ran it hot with them.

**What was built.** A stable name reads as its own value (`W * min(n - 1, H - 1)` is the test);
the box's range serves only `span`, to drop the tests it already implies; the box's top counts
as an open end; held names are refined by the loop's own test. A loop with a box, or with an
inner one, is built twice: with no box (inner box nodes read as what stands below them), then
with the boxes. Where both build a copy: `if (boxTest) boxCopy else copyWithNoBox`, one cold loop
below both. Where only the box builds one: the loop past its guard stands as the planner with no
box leaves it, not cold, its inner copies in place. A head read in another form (a canonical
`for`, a negated test) is built with no box. Inside an enclosing box copy, an inner tier's copy
with no box is absorbed like any inner version, its guard once per call.

**Measured by the integrator** (base 2e9c2ffe7 against the writer's tip, alternating rounds, a
process each):

| what | result |
|---|---|
| line-walk kernel, 8 rounds (new/base): right-down, left-up, right-up, from left of canvas | 0.773, 1.009, 1.001, 0.969 |
| penrose page, fixed plan 400/60/9, 5 rounds, medians ms | base 4.29 to 4.38, new 4.29 to 4.36 |
| rfft | 14.8 to 9.0 us, 1.06x of V8 (was 0.64x) |
| the other 24 examples | within 2%; geomean 1.66x of V8, 25 of 25 |
| pages alone, 6 rounds (new/base) | penrose 1.003, wireworld 1.003, dithering 0.919, sand 1.013 (rounds 0.87 to 1.04), nbody 0.982, field-lines 0.922, lbm 0.993, ocean 0.963, gauss-primes 0.932 |

The invariant holds: no direction and no page slower than the base beyond the entry tests.

**What it costs.** No bench case moves (0 of 105, size and speed) and the 94 single-file bench
cases compile in the same time (speed 146.8 s base, 145.7 to 146.2 s new, CPU). No example
moves at `size`. Ten of 70 examples move at level 2 and speed:

| example | level 2 | speed | compile at speed, CPU ms |
|---|---|---|---|
| rfft | 26083 to 41025 (+57%) | 31645 to 47596 (+50%) | 3190 to 6440 |
| sand | 23435 to 30538 (+30%) | 28380 to 36255 (+28%) | 1500 to 2750 |
| lbm | 34228 to 39167 (+14%) | 43880 to 49519 (+13%) | 2950 to 3620 |
| wireworld | 81378 to 90454 (+11%) | 123699 to 139159 (+12.5%) | 30300 to 35100 |
| gauss-primes | +4.1% | +3.7% | |
| ocean | +3.1% | +2.4% | |
| field-lines | +3.0% | +1.0% | |
| penrose | +2.7% | +2.9% | 1310 to 1500-1840 |
| dithering | +1.4% | +1.5% | |
| nbody | -2.4% | -0.2% | |

rfft's growth is all in `transform`, the kernel (7,876 to 17,344 lines of WAT): the box's copy
beside the copy with no box and the loop as written. wireworld's and lbm's growth is setup code
(`seed`, `busTaps`, `diagMesh`, `reseed`): the box does not weigh how often a loop runs. Each
tiered loop is built twice, which is the compile time; the search for a box costs time where
none results too (the mandelbrot example +23%, about 150 ms, its bytes unmoved; raytrace +4%).

**Correctness.** The writer's three pins fail on the tree with the box alone (2cfadf01a's
planner under the new test file): the product of a stable name, the entry outside the box, the
loop beside a box-only copy. The population battery on the tree: the two known lines only
(boxprobe "arguments of other kinds", vecnarrow's two programs). A population of the
integrator's own for the tier (`SCRATCH/tierpop.mjs`: 88 programs, 6,507,648 checks against Node
at six levels; line walks over widths where `y * W` leaves the word, entries outside the box,
tiers inside counted loops, boxes and inlined calls, heads in other forms): no difference on
the base or on the tree; the box and the tier change the bytes of 73 of the 88 against the
base, the tier 61 of 88 against the box alone.

**The battery** (44d6282b7; the bootstrap and one-process legs on afc2446f3): lint and audit
clean; examples 25 of 25, geomean 1.65x; bench bytes 0 of 105; invariants 7,155; default
7,356; level 0 7,139; level 3 7,153; wasi 7,228; generated 70; integration 224, 76, 76, 79;
test262 4,120 pass and 0 fail; the self-compile, a hosted build of 36,972,556 bytes (36,744,067 on the base), its round trip, kernel parity, checkpoint, hosted suite and recursive compilation; one process 7,356.

**Found by the battery: the compiler no longer compiled itself.** The tier's hand-over
removed a loop's cold mark with `delete n.cold`, and prepare refuses `delete` on a static key
(the compiler compiled by jz removes no field of a node), so the bootstrap build stopped at
integral-loops.js. The writer's checks and the integrator's review ran no self-compile;
the brief's verify list named `test:self` and the hand-back did not run it. The mark is set
false instead (every reader tests it for true; no byte of the 70 examples or the bench
corpus moves). The briefs of the writers after this one say to run `test:bootstrap -- --full`
before handing back.

**Open, listed.**
- The box does not weigh how often a loop runs: setup code is boxed, and the tier doubles
  what that costs in bytes and compile time for no frame time.
- The search for a box costs compile time on loops where none results.
- Hoisted inner tests repeat in guards (`typeof m === number` three times in one guard).
- A closure body shared between a copy and its loop as written is versioned once per
  occurrence; a box-only loop inside such a body could be boxed twice. The base has the same
  exposure for its copies; not observed.
- The examples gate on the x64 runners read rfft at 0.28x to 0.44x of V8 before the box; the
  box's 1.64x there is not yet read.

## The reference run, read (2026-11-14)

Run 43583320878 on 3420027ce (the pins of cd89b0b74: Porffor alpha 23, Bend 2.0.40, rustc
1.100.0, AssemblyScript 0.28.20), ten shards, 106 cases on four machine types (EPYC 9V74,
EPYC 7763, Xeon Platinum 8573C, Xeon 6975P-C). The claims gate: 22 pass, 7 fail, 2 skip (18
failed on the evidence of 2026-09-02). Nothing was published, as designed; the evidence is the
run's `reference-3420027c…` artifact (`SCRATCH/ref1/evidence/`).

Geomeans, a rival's time over jz's on the cases the lane runs (`SCRATCH/refsum.mjs`, the paired
ratio where the pair was measured): the best wasm producer per case 1.36x (89 cases); V8 2.26x
(jz ahead on 93 of 101); Deno 2.07x; Bun 1.77x; JSC 1.80x (85 of 101); `clang -O3` native 1.03x
(jz ahead on 40 of 89); AssemblyScript 2.66x (57 of 57); Porffor 13.9x (96 of 96); Bend 3.36x
(23 of 29: behind on tokenizer 1.08, crc32 1.11, radixsort 1.03, levenshtein 1.01, dict 1.17,
arraynumeric 1.10).

The reds, which are phase 9's work list and the optimizer's:
- Wasm producers, past the band: stdlib-gamma 1.249x (clang), threescene 1.209x (rustc),
  stdlib-pow 1.126x (rustc), gainclass 1.080x (clang), hwb 1.063x (rustc), quatmul 1.053x
  (clang). Ties within the band, not leads: trace 1.005x, sosfilter 1.029x, worley 1.026x,
  threegeom 1.018x.
- V8 family: decode-dsd 1.327x (Deno), crc32 1.112x (V8; on the Xeon 6975P-C, the known split
  by CPU).
- Bun and JSC: decode-wav 2.264x, decode-dsd 1.521x, decode-alac 1.408x, decode-qoa 1.299x,
  decode-tta 1.264x, resample 1.106x.
- A named exception past its band: the self-compile case against JSC 1.669x, band 1.35x.
- Passing now: size against AssemblyScript (56 of 57 smaller, geomean 0.804x; arraydowngrade
  held at 4.93x of its band 5x), Porffor, freshness, coverage, webaudio's RSS (1.002x).
- Not contested: deltae, colorconv, colorlch, colorlog, colorpq, whose stored checksum no lane
  reproduces on the CI machines, V8 included. Not looked into (the phase 9 scout is asked).
- Lanes that answer nothing: tslang (106 of 106 fail to build), js2wasm (92 wrong).

## 1.0.3 released (2026-11-14)

Cut off v1.0.2 as 1.0.1 and 1.0.2 were (tag v1.0.3 at 7c5e46f01, six commits; the branch is
deleted, the tag holds them), published to npm and as a GitHub release by the integrator on
the owner's word, `release.yml` attaching `jz.wasm`. Five fixes for wrong results, each run
on the tags v1.0.0, v1.0.1 and v1.0.2 and wrong on all three:
- An assignment yields what it stored (main's 21112c9aa): 73 of 84 programs wrong at every
  level.
- A captured variable that holds a Boolean beside a number keeps a cell of Numbers: found
  porting the first (its test failed on the 1.0 line for a captured target). The cell was a
  word where every write's integer level is 2, and a comparison counts as level 2, so the
  store truncated the Boolean's box: `let t = 7; const g = () => t; t = x === 3` read false
  at x = 3. 151 of 312 programs wrong. main answers them since 9bafbb6a6 (2d), which had no
  test of it; the release's test is mirrored to main with this landing.
- A byte or 16-bit lane compares only what fits it (dc4858fbc): five clamped programs of
  1,000 at levels 2, 3 and speed. The 1.0 line lifts a store under a condition by a
  comparison of its own, which takes the same test there.
- A uint32 divides as unsigned (cdc3b0711): 31 of 135 programs, 30 at levels 2 and over and
  the element's remainder by a runtime divisor at all six.
- A uint32 bound in a loop's extent guard (33690d097's fix): 3 of 124 programs at levels 2,
  3 and speed, the bound in the loop's test, a read past the array's end; no store.
No bench case (90) and no example (69) changes bytes between v1.0.2 and v1.0.3. The release
line's CI on the branch: the four test legs, fuzz, self-compile, test262, the bench gate and
examples-perf green; claims red there as on v1.0.2 (17 of 31), so the package was published
with `--ignore-scripts` after `build:web` by hand (410 files, as 1.0.2). The dependency
updates since 1.0.2 are not in it: on the 1.0 line they fix one thing visible at the public
levels, a compile error on `do i++; while (i < n)`.

## A host import that calls an export back (2026-11-14)

Found by the phase 7 scout reading the kill rules side by side (`.work/maps/value-passes.md`,
D1), run again by the integrator on main and on the tag v1.0.3: the write closure
(`optimize/globals.js collectReachableGlobalWrites`) answered that a callee outside the
module writes no global, so `promoteGlobals`, `hoistGlobalPtrOffset` and
`hoistLoopGlobalPtrOffset` kept a copy of a global across a call to the host.
`const a = g * k + g; cb(); const b = g * k + g` read the old `g` at the default level and
at `speed` where `cb` calls an export that writes it (0 for 8 at `f(7)`); a typed-array
global the export replaces read the old buffer at `size` too; a closure handed to the host
and called there the same. Of the first 60 programs of a population written for it
(`reentrypop`, a scratch population: globals of seven kinds, exports that write or replace them,
reads around the imports' calls, in loops, behind a function of the module) 36 were wrong
on main. The memory side was right: the memory closure fails closed on a missing target,
and arrays, objects, typed arrays and closure cells written during a host call read
current (`p7more`, a scratch population).

**The fix** (c835d2aac, 5dff9fc29, 261ced79d): a name the closure has no row for and the
module does not define is the host, which writes what any function writes; the closure
answers so for a callee a pass asks of, not only inside its own solve. The first version
counted every import, and every function that called `Math.random()` lost its copies to
the seed import (28 of 70 examples moved, sand 22% larger at `speed`): found by the byte
check before anything landed. The runtime's own imports (`bridge.js hostImport`: the
seed, the clock, a printed line, a timer armed, WASI; the engine's string builtins) are
recorded as calling no export (`ctx.module.callsNothing`) and write nothing. A function
the user imports, an `_interp` import and the `__ext_*` calls, which run a host value,
are the host. A function made after the solve (a specialized copy) reads as unknown
where it read as writing nothing.

**Checked.** 700 programs of the population at six levels against Node, 16,800 checks and
109,152 calls back: none differs. `test/interop.js` "a host import that calls an export
back" fails on the tree without the fix; `test/wat-invariants.js` "a runtime shim ends no
copy of a global" fails on the first version (five reads of the global beside
`Math.random()`, one with the fix) and on main (a user import: two reads, six with the
fix).

**What it costs.** No bench case moves at `size`; 12 of 105 at `speed`; one example of 70
(lsystem). By WAT, the functions that changed call the host: `main` beside the harness's
`env.logResult` and `performance.now` (cam16, hct: one copy), the runtime's `__json_val`
beside `__ext_json`, decode-wav's decode closure and lsystem's `frame` beside `__ext_get`
and its kin (dynamic property fallbacks that reach the host only for a host value):
`$closure0$s0` reads 741 globals where it read 612; `frame` loses three copies and ten
typed-array bases. Timed against the box's tip in alternating rounds on a machine at load
40 to 65 (least of the rounds is the figure): eleven of the twelve within the spread
(webaudio's medians read 1.63 and then 0.77 on two runs, least 3289 to 3264 over 20
rounds); decode-wav slower, least 764 to 815 us, median 806 to 849 over 8 rounds, about
5%. lsystem's page could not be read (medians 2.0 to 4.2 ms on the base alone).

**Not landed alone.** The copy is given up for the whole function where one call in it
reaches the host; asked per loop it stands in every loop that calls neither the host nor
a writer of the global. That is 7a's (LICM's rule for a `global.get` asks the effects
summary per loop), and the fix lands with it: one battery, and main never carries
decode-wav's 5%.

## Five hand-backs joined: the rule table, the loop's description, the exact lane, the effects summary (2026-11-15)

Five writers worked side by side from the box's tip, each in files no other held, and
handed back within a day. They were joined on one branch in this order and reviewed as
one tree: the two counter fixes, phase 8, 6b, 9a, the import fix and 7a. What conflicted:
the generated suites' list (two entries, both kept), one paragraph of CONTRIBUTING.md
(both kept), and the two baselines that phase 8, 6b, 9a and 7a each re-wrote. Both
baselines were written again from the joined tree. The ratchet is the sum of phase 8's
change and 7a's in every category, less what the review's fix below takes back (JS host
buf 31463/2820, slice 229468/30144, condref 201475/7441; the other categories as they
were); the spelling table has 75 gaps of 470 (76 on main: 6b closes its five lost
cells, 9a opens the one-statement dot's cells at level 2, below; the 19 that 7a's
copies closed are in the review).

### Counters by a bound test: two fixes landed, the tier not

The writer's own verdict, which the integrator takes: the bound tier (238aedd6e, a copy
of the loop under a test of its bound where the bound has no range, the box's machinery)
is not landed. It takes 46 of the 242 loops whose counter is an f64 where the vectorizer
runs at `speed`, gives six more lifts at `speed` and two at level 2, and costs up to 35%
of an example's bytes at `speed` and 40% at level 2 (dwa, schrodinger, maze) and 27 to
65% of five examples' compile time; no page and no bench case whose bytes moved measured
faster (pages alone at load 11 to 16, new/base 0.95 to 1.03). The emulation's 139 loops
do not reproduce under a sound guard: what refuses the rest is nesting with no counter
bound (32), no stable bound (32), the size and growth budgets (22), loops built after the
planning sweep (24). The commit stays in no branch; its id is here.

Landed, both wrong answers found by building it:
- `int32Held` read any `.length` as a word (a047f51d0): a counter bound's start read from
  `{ length: 2.5 }` entered the copy untested and ran a trip past Node's, and a stable
  name of the box read from such a length was taken for an integer (`ix = (n - k) | 0`
  read x[39] for x[39.5]). Levels 2 and over, in no release (the box is this week's).
- The range-check fusion `(x - LO) <=u (HI - LO)` read a uint32 past 2^31 as a negative
  word (ada395f86): `n >= -5 && n <= 100` held at 2^32 - 1, at every level. The fusion is
  c6334baa5, in every tag from v0.7.0 to v1.0.3 by `git tag --contains`; not run on a
  tag.

Found by the writer in a file it did not hold, fixed by the integrator (8b9c75438): the
extent guard computed an expression bound through ToInt32. `i < B0 + B1` of two words is
2^31 at B0 = B1 = 2^30, the guard read -2^31, under every length, and the arm with no
bounds checks read past the array (levels 2 and over). Each name of such a bound was
held to 2^30, which leaves room for no sum of two. `boundwrap`, a scratch population: 48 of 192
programs wrong on main (sums, differences and sums of three; products and shifts were
right), none after. A bound the emitter types a Number now takes the Number's test.

### Phase 8: the local rewrites as one table, checked

`src/optimize/rules.js`: 32 rows `[name, relation, match, out, when]`, one matcher, four
lists that apply them (the fused walk 22, the tag-test inlines 4, the wrapped words 4,
the load casts 4). A row's relation is part of it: 28 exact, 2 exact but for a NaN's
payload, 2 that trap on fewer inputs under a named invariant. `test/rules.js` assembles
both sides of every row for every admitted spelling of its constants and runs them over
grids (the word's and the long's edges, NaNs of several payloads, boxes of every tag,
addresses at both ends of a page), and runs 58 of the rules that stay code the same way
on generated patterns. Checked means run on a grid: evidence, not a proof, and the
table's header says so. What stays code and why is in CONTRIBUTING.md (a fact from
outside the tree, chains of any length, fresh locals, flow, effects).

The three defects the scout reached, each with a pin against Node and a population in
the generated suite: two shifts left merged with the counts summed raw (`((x << -1) <<
1) | 0` gave x); a Boolean addend's select returned `x` for `x + 0`, which is -0 for -0
at `speed`; an arm a constant condition takes came back unboxed where its join boxes it
(an invalid module, 6 of 279 generated ternaries). The latent ones: a convert of a
constant spelled past 2^31 made true; the three memarg folds made one function under "the
address sum does not wrap"; `inert` in the tape's fold refuses what may trap; the low
word of a long load and the merged byte stores restated with their invariants, which a
population of accesses past either end of six typed-array kinds now tests. Three more
the checker found beside the scout's six.

Cost and gain: bench bytes -2,130 at size and -4,468 at speed over 94 cases (the rows
read the runtime's constants, which the parser spells as strings, where the chains took
numbers only); `src/` 79 lines longer (the table's 239 against 210 lines of chains); the
hosted compiler +906 bytes. Not built: checks of the rules that need a laid-out memory
(the string and heap inlines) and of narrowInts over runtime calls.

### 6b: one description of a counted loop

`vectorize/scaffold.js describeLoop` with `readExit` and `readStep`
(`addr-model.js`): counter, exit relation with its signedness and constant shift, bound,
steps, direction, and the emitter's facts where the loop carries a link (`cmp`, `shift`,
`dir`, `by`, `boundRange`, `trips`). Eight private exit and step matchers are gone.
Under `JZ_DEBUG_INVARIANTS` the link is checked against the WAT; checking every readable
test found four loops whose test reads another local than the emitter's counter (a
nullable counter's numeric shadow in three, a test LICM hoisted in one), which take
nothing from the link.

Lifted through it and the one legality: a test shifted by a constant (`i + K < n`, the
stencil), `<=`, a loop counting down (strips from the counter toward the low end, lanes
in address order, no shuffle), a lane local read after the loop over f64, two counters at
`speed`. The coverage table of the alias battery joined the repo
(`test/vector-coverage.json`, 840 marks, 321 lifted on the base and 357 now, none lost);
takers 586 to 593 at `speed` and 421 to 423 at level 2 over the 423 units. One bench
case moves, by two bytes.

Not built, with the reason measured: the counter "known a word" (the emitter knows it for
21 of the 254 f64-counter loops; the planner's test is the lever, above); a constant
step past 1 (a gather and a scatter of every c-th element, and 48 of the corpus's 68 are
the bench harness's sampling checksums); `let i = 0` ahead of the `for`, `!==` and
do-while, which reach the vectorizer with an f64 counter or as a flag loop. The hosted
compiler +87,816 bytes.

### 9a: the float relaxations one option, a lane at JavaScript's floats

`optimize.relaxedFloat`: every rewrite that can round otherwise than JavaScript is behind
it (a float sum or product in lanes and in several accumulators, the lane maximum's zero
sign, hoisted dot terms, the f32 lanes, `relaxed_madd`, and `rationalConst`, which
follows it unless set). Off at `false`, the default level and `'size'`; on at `'speed'`.
The writer's population (93 programs, 108,810 checks over NaN, the infinities, both
zeros, overflow, subnormals): bit for bit with Node at `false`, `true`, `'size'` and the
exact build, where 28 of the 93 differed at the default level before; at `'speed'` none
past the bound the README now states. `(-0) ** 0.5` is +0.

What it costs, said plainly because it is the default level's speed: a float sum written
in one statement runs scalar at the default level. dotprod 2.00x, matmul 2.46x,
stdlib-ddot 2.15x, poly 1.67x of the time there (alternating rounds, under load); no
example moves. The two-statement spellings keep an exact lift (products in lanes, added
in order), which is 6c's lead: exactness as a property of a lowering.

The lanes: `jz-exact` (`'speed'` with `relaxedFloat: false`) on every case, paired
against every rival as `jz` is; `c-wasm-fast` (`-O3 -ffast-math`) on the 91 C ports. The
wasm claim is held twice, like against like (`wasm`: jz against the strict rivals and
c-wasm-fast; `wasm-exact`: jz-exact against the strict rivals). Every claim lane's flags
come from one table (`LANE_FLAGS`), which the builds read and the dataset records. On a
local run the exact lane trails where the relaxed one led: stdlib-ddot 2.52x of
rust-wasm's time, mat4 1.18x, matmul 1.17x of AssemblyScript's; it leads on dotprod and
poly. Exactness costs jz 7.7x on dotprod and 6.2x on stdlib-ddot at `speed`. CI is the
record: the committed reference predates the lanes, so the gate is red on coverage until
the next reference run.

The five colour probes are checked at 16 significant bits, where every engine and jz
agree (`checksumF64Near16`; engines differ by up to 2.7e-8 relative), and are held to
parity again. Measured figures of README and the landing page are written from the
dataset and checked in the claims gate. Not done: hashing the whole buffer in
`checksumF64` (86 definitions across the ports, every reference to pin again).

The writer's list of the owner's sentences the reference run contradicts is in
`.work/claims-for-the-owner.md`, for the owner; none was edited.

### The import fix and 7a: one effects summary

The defect ("A host import that calls an export back", above) is fixed by c835d2aac and
5dff9fc29 and then subsumed: `src/optimize/effects.js` solves once a module, and again
over what watr hands back, what calling each function may do (the globals it may set,
the memory it may write and through which typed global, a header word, a throw, the
host, whether it returns), as bitset rows over the condensed call graph. A name outside
the module is the host and does everything a function of the module can; a runtime shim
does what a table says of it (`SHIMS`, from interop.js); a helper whose body does not
show a fact has one hand entry with its reason (`HELPERS`), checked against the body
where there is one (`test/effects.js`). Six closures and nine hand lists are deleted;
`SAFE_OFFSET_CALLS` stays for one reader in the vectorizer (6c's).

Settled: a pure call ends no remembered load (D2); one fact per helper (D3); no wide
store writes a header word, checked by a throw under `JZ_DEBUG_INVARIANTS` over the
whole suite (D4); a `global.set` ends only memory whose address reads that global (D7);
a store ahead of a call that may throw, stored again after it, is no longer dropped
(D11: wrong by reading, reached by no program, pinned on IR). Beside them: a conversion
helper that may run a user's method writes; an element read that throws on a receiver it
cannot index is not lifted ahead of a loop that may run no round; a `return_call` is
answered by its target.

The copy of a global the import fix gave up for a whole function is kept per loop
(`promoteGlobals` and LICM ask the summary for the loop's own calls): decode-wav's hot
function reads 585 globals in loops as before the fix (714 with it alone). As handed
back the copy went into every loop that read a global; the review held it to the
function's threshold (below).

Costs: `src/` 15 lines longer; the hosted compiler +64 KB (eleven closures of the summary
wrapped in eleven more: 7b is told to measure as it goes).

### The integrator's review of the joined tree (810187c9d)

**The suite once before anything else**: 7,475 pass and one fails, where two hand-backs
meet: 6b's test of a float sum counting down expects a lift at level 2 that 9a's option
now withholds. The test asks for the option.

**Populations**, every one against Node on the joined tree: the population battery shows
the two known lines only (boxprobe's "arguments of other kinds", vecnarrow's two README
programs); the tier's 88 programs, 6.5M checks; the re-entry population, 1,200 programs
over three seeds, 182,616 calls back into the module; 9a's 93 float programs (none
differs at the exact levels, none past the bound at `speed`); the counter writer's 421
(its ten wrong programs of the base are the extent guard's, fixed above); the aliasing
fuzz, 380 programs; the sum-bound probe, 192; the probes of phases 7 and 8. None wrong.

**Bytes against main.** Bench: -2,273 at `size` over 40 cases; -2,619 at `speed` over 94
(fabrik +897, polytri +704, stdlib-special +350, jessie +328; webaudio -607, watr -599).
Examples: -512 at `size`, +380 at level 2, +818 at `speed` over 69 of 70 (lbm +2,605,
metaballs +1,689, lsystem +1,563; waves -2,916, marble -1,003).

**Timing, on a quiet machine** (load 5 to 7; main against the joined tree, a process a
run, alternating). Every bench case, six rounds: geomean new/base 1.001 by the least of
the rounds and 0.995 by the median. The first pass found one loss: three.js's animation
case at 1.079 and 1.083. Built at each step of the join it fell at one commit of 7a, the
copy of a global in every loop; with the copy switched off in one group of functions at
a time it was `__ptr_offset_fwd` alone, the helper every array access calls, whose loop
follows a forward and runs one round: the copy read the global once as the loop did, and
cost a local. A loop's copy is now held to the function's own threshold of three reads
(acd02157e): threeanim 1.019 and 1.003, decode-wav 0.991 and 0.995 (the copies the
import fix had taken are kept), bench bytes at `speed` 3,539 smaller than with the copy
everywhere. The 19 spelling cells the copy had closed at level 2 (a module array read
once a round) are open again as on main: 75 gaps of 470. The rule that tells a counted
loop from one that chases is the first item of 7b.
Two cases one pass flagged (glyfparse, wordcount) show no step apart over ten rotating
rounds at each step: the spread of allocating cases. hashjoin is 7 to 8% faster in both
passes, async 2 to 4%. polytri 0.996 and 1.011, jessie 1.013 and 1.014, fabrik 1.000
and 1.015, the four float kernels unmoved at `speed`.
Pages alone, five rounds: lbm 1.001, metaballs 0.998, lsystem 1.000, waves 1.002,
marble 1.001, dwa 1.033 by the median and 1.008 by the least. game-of-life does not run
in the page harness on either tree. The battery's examples leg, against the base's
logs of another hour, read seven pages 5 to 10% slower with V8's own times 1 to 8%
longer beside them; the two furthest after V8's drift, alone, four rounds: raymarcher
0.985 in each, ulam 0.97 to 1.02.

**The battery** (acd02157e): lint and audit clean; examples 25 of 25, geomean 1.64x; bench bytes as reviewed, 0 of 105 moved; invariants 7,276; default 7,477; level 0 7,260; level 3 7,274; wasi 7,349; generated 144; integration 225, 76, 76, 79; test262 4,120 pass and 0 fail; the self-compile, a hosted build of 37,145,851 bytes (36,972,556 on the base), its round trip, kernel parity, checkpoint, hosted suite and recursive compilation; one process 7,477.

### Open, listed

- The examples gate on CI (`examples-perf`, 66 pages, three runners; it fails nothing).
  A scout read 47 runs (`.work/maps/examples-gate.md`): the arm runner repeats within 0.01
  and is the instrument, x64 repeats only within one CPU model, macOS has no signal
  under 20%. Stably slower than the same source in V8, in every run since 2026-10-06: on
  arm maze 0.77, erosion 0.82, fireflies 0.85, swarm 0.85, ocean 0.93, plume 0.94, boids
  0.96, attractors 0.97; on x64 maze 0.80, lenia 0.84, plume 0.92, erosion 0.96. Leads,
  none measured: six of the nine call transcendentals every frame (jz's own against
  V8's); gathers and scatters under branches in five; five are slower on arm only. The
  harness times JavaScript first and jz second, once: pairing the two would cut its
  noise.
- `specializeLoops` versions a loop that is entered often and runs few rounds (7a's
  observation on jessie and polytri; the box's "does not weigh how often a loop runs"
  is the same question).
- Reading `valueOf` through a parameter gives NaN (7a's probe; not looked into).
- The hosted compiler grew with each of the four (906 bytes, 88 KB, 1 KB, 64 KB).

## A bundle with a CommonJS module, and what its probes found (2026-11-15)

Found by the 9b writer on its own fixture, written to Are We Fast Yet's interface, before
any program of the held-out sets was fetched: every driver esbuild bundles from a
CommonJS program stopped the compile with `summary: no fixpoint`. Run down, it is five
defects, each in every release that has its code. Two stop a bundle; the population
written to check the first (`trypop`: a parameter of two kinds used ten ways in five
try forms, 2,800 programs, each beside a twin with no try) found two more, and probes
of a proof beside the assignment, written while the first of those was run down, the
fifth.

**A parameter used inside a try statement read as only tested** (since 0a68216f2,
2026-09-16: v1.0.0 to v1.0.3). The summary joins the arguments of a parameter that is
only tested, compared or asked its `typeof` without losing what a join loses
(`passiveParamsOf`). Its scan read a try statement in the parser's layout, `['catch',
param, handler]`; a prepared one is `['catch', body, param, handler]`. So it walked the
handler's name and nothing else: a parameter stored through, kept, returned or assigned
in the protected body or the handler was one only tested.

- Wrong answers: an object passed where a value of another kind is too kept its fields'
  kinds past a store through the parameter (`f(a); f(7)` with `try { o.x = 'str' }`
  inside `f`: `typeof a.x` read as `number`). At level 0 beside a number or a string;
  at every level beside a typed array.
- No fixpoint: a captured parameter assigned in a handler (`catch (e) { throw mod = 0,
  e }`, esbuild 0.28's `__commonJS`) joined without its cell on the call, quietly, and
  with it on the assignment, a round each, until the solve stopped at its bound of
  10,000 rounds. No bundle with a CommonJS module compiled.

The fix removes the case: the walk's own rule reads every operand of a node as a use,
and the handler's name, a string among them, stops being a candidate (3e43a1e19).

**A comma call rebuilt with an operand an argument** (since 6d43d2d9a, 2026-05-23: v0.6.0
to v1.0.3). An alias of an Object builtin at the top of a module (`var __getOwnPropNames
= Object.getOwnPropertyNames`: every bundle with a CommonJS module) turns the
bundler-helper fold on. The fold took each `(0, f)(…)` whose callee is a member or an
index for an interop read it had replaced: it compared its copy of the callee with the
callee by identity, and the copy is always another array. It then rebuilt the call as
`['()', f, a, b]`, where a call's arguments are one operand, so every reader took the
first argument and dropped the rest; a call of no argument became the grouping `(f)`,
the function in place of its result; and the callee lost the `(0, …)` that calls it
with no receiver. esbuild writes every call of a CommonJS import so, and `__commonJS`
calls the module's function with `(exports, module)`: `module.exports = …` threw on an
undefined `module`. The one test of the fold had a module that writes `exports.answer`
and a read of it, no call. The callee is compared by structure now, and a call the
fold builds has the parser's shape (4fa0fb34a). A call whose callee is an interop read
still becomes a method call on the module (`(0, import_a.add)(1, 2)` to
`require_a().add(1, 2)`): a function of the module that reads `this` sees the module
where JavaScript gives it undefined. Listed, not changed.

esbuild 0.28.2's bundle of `import { add, id, k, mix } from './a.cjs'` with calls of
none, one, two and three arguments answers what Node answers at levels 0, 2 and `speed`;
it is the test (`test/features.js`), with seven comma calls whose callee is no interop
read.

**A parameter assigned under an `if`, on a path the walk does not follow, read as what
its callers pass.** The walk reads a parameter as its callers' kinds until its first
reassignment (`pre`). A conditional that assigns it restores the entry state between
its arms and ends the region at its join, but only on a path the straight-line state
follows; a loop clears its names at the head, and a try statement's body, handler and
finalizer and a labelled block with a break clear nothing. There the join left the
parameter not yet reassigned, and every read after it, a call's argument among them,
was of the callers' kinds alone: `try { if (typeof o === 'number') o = { x: o } } catch
(e) {} show(o)` never told `show` of an object, its `typeof v === 'object'` arm was
folded away, and the answer was `object[object Object]` for `obj7`, at every level.
The idiom is a parameter made uniform inside a try (`if (typeof input === 'string')
input = JSON.parse(input)`). The join now ends the region whether or not the path is
followed (8fc82cf25).

**A test's arm restoring a mask past an assignment.** A name is read within the tags
its tests prove (`refined`); a test saves the mask the name had, to restore where its
arm ends. An arm that assigns the name ended the proof and the arm's end restored the
mask of before: after `if (o == null) return; if (typeof o === 'number') o = null` the
reads were not nullish again, and a callee's `v === null` was folded away (wrong at
level 0; with the defect above, at every level inside a try). An assignment now clears
the masks the tests around it saved (the same commit). Both changes only widen what a
read may be.

**An empty statement in the binding split.** A conditional whose test the argument's
kind decides is folded away in a function spliced into its caller (`let sink = (v) =>
{ if (typeof v === 'object') v.x = 'str' }` called with a closure, a number or a
string); the list keeps an empty statement, and `split` (prepare/split-bindings.js)
read its operator without asking whether there was one: an internal error at levels 2
and over. Every other reader of the list in that file asks first; this one does now
(2bab745c7).

Each test fails with its fix taken out (the bundle's with either half of the second;
`a try body under a guard that leaves` with either of the third and fourth).
`trypop` on the fixed tree (2bab745c7): none of its 2,800 programs differs from Node at
the three levels. On main, a quarter of it (700): 25 differ where the twin with no try
agrees, 16 of them at level 2 or `speed` too, and 10 stop on the internal error with a
try or without.

**Bytes and time.** One bench case of 105 moves, jessie: 101 bytes more at `size` (76,072
to 76,173) and 65 at `speed` (193,286 to 193,351), in one function of its 274, with no
loop: a value the walk no longer takes for an array is tested for its tag before an
element of it is read. No example of 70 moves. Sixty alternating rounds, a process each,
at load 30: jessie 0.999 of the base by the least and 0.992 by the median; watr, the same
bytes on both trees and timed beside it as the control, 1.000 and 0.970. Eight rounds did
not resolve it (the control read 1.113 by the least): on a loaded machine the least of
sixty is what a timing is read by.

The population itself, moved into the generated suite as `test/try-population.js` (the
landing after this one), fails with the first, third and fifth fixes taken out and passed
with the fourth out, as the scratch one does: it gained a use that holds a proof across
the assignment, and fails with each of the four now.

**Not changed, listed.** `analyzeFreshTypedGlobals` (plan/literals.js) reads the try
node the way the first defect did: at `catch` it takes every name of the protected body
out of the module arrays known to own their buffer, and leaves the handler's name in.
The first costs precision (an array named in a try body is no longer known distinct
from the others, so LICM keeps its reads in the loop); for the second, three probes of
a handler's name that hides a module array, stored through beside a read of another,
answer what Node answers at the three levels. The fixture's program that builds code at
run time (`new Function`) compiles and throws when run, where the README lists it as
not supported: its row is a trap, not the refusal the fixture's comment expects.

## The held-out lane (9b), as landed (2026-11-15)

`bench/heldout/manifest.json` names 25 programs jz was never tuned on, before any was
fetched: Are We Fast Yet's 14 JavaScript programs (smarr/are-we-fast-yet at 74306fec)
and the Benchmarks Game's 11 Node.js programs of nbody, spectralnorm, fannkuchredux and
mandelbrot (Byron/benchmarksgame-cvs-mirror at 0077cab4). Nothing of either set is in
the repo: `scripts/heldout.mjs` fetches a program at its commit, checks its blob,
generates a driver to the set's interface and runs it; the fixture
(`bench/heldout/fixture/`) is six programs written here to the two interfaces, for
the harness alone.

What holds the lane (`bench/heldout/lane.mjs`, tested in `test/bench-claims.js`):

- A program's registration is the last commit that changed its line of the manifest. A
  contact run is refused where compiler source (`SOURCE_SCOPE`, bench/claims.mjs)
  changed after it: what is measured is a compiler written before the program was
  named.
- The record (`bench/heldout.json`) is a chain: each entry carries the sha256 of the one
  before it, the program's blob, its driver's hash, the compiler's commit and the run.
  The workflow appends to it and nothing else does; a second measurement of a program
  is an entry marked `tuned`, never a replacement.
- Every program is counted. A compile failure, a trap, a wrong answer and a timeout are
  rows (`RESULTS`), and V8's result of the unmodified source is the oracle.
- `.github/workflows/heldout.yml` runs on dispatch alone: `mode=dry` runs V8 only and
  writes nothing; `mode=contact` runs on main only, and its record job is the one job
  with write access.

What no test can hold is in the manifest's own words: that no one read a program of a
set, or ran it with jz, before it was registered.

The review: the workflow, the lane module and the diffs to `bench/bench.mjs`,
`bench/claims.mjs`, `bench.yml` and `test.yml` read whole. `node test/bench-claims.js`
has 48 tests where it had 40; the 8 new pass, and the failing ones are the same 21 by
name on both trees (the stale dataset, see `.work/claims-for-the-owner.md`). The
fixture through the whole pipeline on the fixed tree: `squares` (a CommonJS program
through esbuild's bundle) answers right where it stopped the compile before the five
fixes above; `harmonic` and `bitmap` right; `roots` wrong (the documented
`(-Infinity) ** 0.5`); `cores` a compile failure (`node:module`); `evaluated` a trap
(`new Function`), where its comment expects a refusal.

Not run: the contact. It is run once, so it waits for the last compiler phase: every
src commit after a program's registration refuses it, and the commit before it is one
of its own that registers the programs again (each `"registered"` date), dispatched
before the next src commit. `mode=dry` is run after this landing, to check the harness
on the real sets with V8 alone.

The landing's battery: on 2bab745c7, one leg at a time: `lint:imports` and `audit:files` clean; bench bytes by hash 0 of 105 moved; the examples 1.65× V8 by geomean, jz ahead on 25 of 25 (blackhole read 3% slower in the first run and epicycles 5.6% in the second, each byte for byte main's wasm at level 2, size and speed: the machine's, three writers' suites beside the run); the invariants leg (level 3, the facts guard on) 7,280; core 7,481; `test:bootstrap -- --full`, its five parts, the hosted build 37,146,722 bytes against main's 37,145,851; level 0 7,264; level 3 7,278; wasi 7,353; generated 144; the integration suite 226 (1 skipped), 76, 76 and 79 at the default, level 0, level 3 and wasi; test262 4,120 and 0 failing; the core suite in one process 7,481. All passing. Eleven hours, the hosted suite 108 minutes of it.

**The first dry run (2026-11-15)**, run 43777318282 on f7092c17b: `awfy` 14 of 14 pass,
`clbg` 9 of 11. V8 did not run two through the harness, and each is the program's shape,
not a defect of the harness:

- `clbg-nbody-node-2` is a script of sloppy mode: `n = +process.argv[2];` and `runTest =
  function(n) {…}` assign names it never declares. A script makes globals of them; the
  driver is an ES module, strict, and the first throws `ReferenceError: n is not defined`.
  Every lane takes the driver as an ES module, and declaring the names would rewrite it.
- `clbg-mandelbrot` spreads its work over processes: `require('cluster')` forks
  `os.cpus().length * 2` workers of the running script, which send their rows back by
  `process.send` for the master to write. In the driver the round returned once the master
  had forked, so the driver passed with a time of the forks alone (read from the source,
  and reproduced by the fixture's `forks`); the check, run by `node -e`, has no script to
  fork, and `fork` threw (`ERR_INVALID_ARG_TYPE` at `child_process:126`).

Neither can run as one ES module in one process without being rewritten, and neither
decision reads a result of jz's (a dry run builds none). Both stay registered, marked
`notMeasured` with the reason. The dry check requires a marked program to fail in V8 and
fails when one passes; no lane measures one (its driver is `not-measured.js`, which
bench.mjs does not take as a case); the record stores no entry of it, and the figures keep
it in every denominator, named (`k of 11 (2 not measured)`). A failure's line now quotes
V8's error, where it quoted the source line above it. The two sources were fetched to this
machine and read after their registration, not run; the manifest's header says so. The
fixture gains `sloppy` and `forks`, written to those shapes: on the unchanged harness they
fail as the two did on CI, and each new test fails with its piece taken out (scratch
copies).

## A catch clause is a branch: the finalizer population and what it found (2026-11-15)

Found reading 7b/7c's hand-back (ec74f23f2), then on main by the population written to hold it.

A finalizer is emitted once for each way out of its body (compile/emit/statements.js,
'finally'): the normal copy inside the block a `try_table`'s catch clause names, the
handler's copy after that block's end, which only the clause reaches. A walker that
takes `br`, `br_if` and `br_table` for the branches reads that end as fallen into, and
gives the handler's copy what the normal copy computed, on a way that never ran it.

- **7c's numbering** (not landed): `targetedIn` and `targets` of optimize/numbering.js.
  `try { if (t) throw 1 } finally { sum += a[i] + a[i + 1] }` over a Float64Array read
  the subscript's address from a local the handler's way never set: 103 for 115 at levels
  2, 3, size and speed. Main answered right: the pass it replaced cleared at the end of
  every block that held any exit, a `try_table` among them. Back with its writer.
- **optimize/forward-checked.js** (4a9fa96de, 2026-10-21: v1.0.0 to v1.0.3), `targets`:
  `for (…) { try { if (t && k) throw 1 } finally { sum += o[i] } i += 1 }` over an
  Int32Array gave the handler's copy the word the normal copy had loaded the round
  before: 600.25 for 306.25, at `size` alone, where the function is spliced into its
  caller. Fixed (3b5b5381a): a catch clause's last operand is its
  label.

`test/finalizer-population.js`: 12 uses of a parameter of one kind (a typed element, an
element, a field, a length, a tag, a string, a closure, a word and its bytes) in 7 forms
of finalizer (alone, a body that returns, a callee that throws, the use in the body too,
after a handler that throws on, a handler and a finalizer, in a loop), each called
without a throw, with one and without again: 84 programs, a module each, six levels, 62
s at load 12. With the fix out `a word read once in a finalizer in a loop` fails at
`size`. Its first form, twelve programs to a module, passed with the fix out: what the
optimizer shares in a function turns on what its module inlines, and a program of this
class has a module of its own.

The try population had no finalizer whose body throws (`try { r = 1 } finally { … }` is
emitted as the two in a row, no handler made). It gained the position (96ad796d7: 4,312
programs, about eleven minutes of one core); the position does not catch this class,
its parameters being of two kinds, and differs on main where the handler's does.

A scout then read forty walkers for the class and found, on main and in every release
since v1.0.0, six more wrong answers the integrator ran (`scoutcheck.mjs`, 24 of 42 checks
differ on 9ff7eb3d5): reuse-loads.js (a field read in a finalizer after a throw adds 0),
settled-tests.js (a test in a finalizer the body's write changed is dropped),
compile/cse-load.js (a read after the throw read again in the finalizer),
liveness.js through loop-compact.js (a list the handler reads is no root of a loop's
compaction), plan/integral-loops.js (a local written either side of a call that throws),
each at levels 2 and over, and the emitter at every level (a `return`'s copy of a
finalizer runs inside the try's own `try_table`, so a finalizer that throws runs twice).
One class: a catch clause is a branch to its label from every point of its body, and a
local the handler reads is live through the body. Its writer's brief is
`.work/exception-edges.md`.

## What the scout of 6c's lowerings found on main (2026-11-15)

A scout ran about fifteen million calls of generated kernels against Node on the 6c tree and
on its base (copy and fill counting down, views of one buffer, three and four arrays, strips
counting down, exact reductions, the chooser over the examples): no difference of 6c's own.
Three it found on both trees, each run by the integrator on main 9ff7eb3d5 and on v1.0.3
(`scout6c-check.mjs`, 9 of 24 checks differ on each; `scout6c-bisect.mjs` names the pass):

- **Two views of one buffer, of different element types, swapped at one index**
  (`t = d[i]; d[i] = s[i]; s[i] = t`, `d` a Float32Array and `s` an Int32Array of the same
  bytes): the words keep the float's bits where Node leaves 0, at levels 2, 3 and speed.
  Righted by `vectorizeLaneLocal: false`. With 6c's writer.
- **A Uint32Array element stored to a Float32Array in a lifted copy converts as signed**:
  -1 for 4294967296, at levels 3 and speed. Righted by `vectorizeLaneLocal: false`. With
  6c's writer, as the class "a lane conversion out of an unsigned element".
- **watr's `outline` shared one helper between two expressions**, at `size`:
  `A[i*16+j]*x[j]` in one export and `A[j*16+i]*x[j]` in another, the second read `x[i]`
  (400 for 200). Righted by `watr: { outline: false }`. The pass grouped sites by a
  name-blind key (every `local.get` an `L`) and the parameters' types, and built the helper
  from the first site alone: where each local repeats was compared nowhere. Its key is a
  32-bit hash past 64 characters, compared nowhere either: two expressions that differ in a
  constant (439599 and 622382, searched for) shared the first's constant.
  Fixed in watr 5.13.7 (740f3db and 49e387a, pushed with the tag 2026-11-15; the npm release
  is the owner's, `npm whoami` answers 401 here): the key takes the position each local
  repeats at, and a site takes the first's body only where the two compare equal node for
  node, a leaf by its spelling. Three tests, each failing with its part of the fix out.
  watr's suite, plain and against its wasm build: 382 pass and 2 skipped, 39 of 39, the spec
  suite 268 pass and 20 skipped. jz reads it through its pin in package.json (5.13.5 today).

  **Where the integrator was wrong.** The first form of the fix (tagged v5.13.6, never
  published) compared leaves by type, and moved the `size` bytes of 25 of the 105 bench
  programs up by 5 to 245. Read as wrong shares undone; it was not. Each of the 25 answers
  at `size` under 5.13.5 what it answers at `speed` (`sizecheck.sh`), and an instrumented
  5.13.5 (`outline-diag.sh`) counted 828 groups and 11,650 sites in them with no site of
  other positions and none of another tree: 1,337 sites differed from their group's first
  only in a constant held as a number where the first held a string (jz's emitted nodes
  beside its runtime's parsed text). With leaves compared by spelling the 25 are byte for
  byte what 5.13.5 gives (`bhsize.mjs`, moved 0), and the two programs that fail on 5.13.5
  answer right. So the defect is real and no bench program has it.

Read by the integrator in 6c's diff: memcpy.js whole (a copy counting down is memmove unless
the source starts strictly inside the destination's window: the guard is that test, the
counter left one below the low end, the last offset the low end's); the exact reduction's
lane tables (each load reads exactly the two elements' bytes; the conversions are the
scalar ones per lane). `tryReduceBitExact` gives a body local its lanes before it lifts the
local's own statement, so the recognizer alone would take `x = x * 0.5 + a[i]` for a lane:
the one legality declines the loop (`carryprobe.mjs`, seven programs, six levels, no
difference). alias.js's `own` and `limits` splice read, not proven by reading.

Scratch: `v103` (a worktree of v1.0.3), `jzwatr` (main linked to the fixed watr, built by
`watrfarm.sh`), `watr-outline` (the watr worktree), `bh-main9ff.jsonl` and `bh-watr.jsonl`
(bench bytes, main against main with the fixed watr).

## 6c landed: a lift chosen by cost, the exact lowering beside the reordered one (2026-11-16)

Landing tree `land-b`: main f7092c17b, then the integrator's three (the try population's new
position, forward-checked.js's catch clause with the finalizer population), the sixteen
ports of the scratch populations (test files only), 6c's twelve commits and three more of
its writer's. Notes of the first two groups: the sections "A catch clause is a branch" and
"What the scout of 6c's lowerings found" above.

**What 6c is.** vectorize/index.js asks every lowering of every loop and takes the one whose
pass costs least (cost-model.js); a reduction has two, the reordered (lanes folded at the
end, under `relaxedFloat` alone for a float sum or product) and the exact (`tryReduceBitExact`:
the work of each element in f64x2 lanes, the accumulation in the loop's own order). Strips
count down; a copy or a fill counting down is `memory.copy` / `memory.fill`; the general map's
and stencil's own alias versioning is gone, the one legality's distance test answers; an
enclosing loop's lift wins over the lifts inside it.

**The writer's figures (not rerun by the integrator).** Census of 423 units: lifted at speed
593 to 594, at level 2 375 to 401 (26 gained, none lost). The exact lowering at level 2:
dotprod 0.931, matmul 0.838, stdlib-ddot 0.759 of the time before. Hosted compiler +42,955
bytes on its own bootstrap. Examples: nbody alone moves.

**The integrator's review.**
- A scout: about fifteen million calls against Node over the new lowerings, no difference of
  6c's own (its three older finds are the section before this one).
- The scratch populations on the twelve commits: nothing new (the two documented divergences,
  boxprobe 150 in 1 and vecnarrow 144 in 2; `finloop`'s handler in a loop at `size`, which the
  base has and the exception edge's branch rights).
- Bench bytes by hash: no case at `size`; ten at `speed` (colorconv, colorlch, colorlog and
  colorpq -92 each, fft -34, fftplan -39, stdlib-ddot -192, webaudio -60, matmul +5,
  provenance +10). forward-checked.js's fix alone moves none.
- Timing, sixty alternating rounds a process each at load 20, those ten and two controls
  (alpha 1.000, aos 1.003 by the least): every one within 1.5% by the least and the median
  (fftplan 0.991 and 1.009, webaudio 1.007 and 0.985, matmul 0.986 and 0.989, provenance
  0.991 and 0.990), geomean 0.998. The 1.038 of fftplan and 1.031 of webaudio the writer
  could not settle did not repeat.
- Read: memcpy.js whole, the exact reduction's lane tables, the two fixes below. alias.js's
  `own` and `limits` splice read and not proven by reading.

**Two wrong answers older than 6c, fixed by its writer (in v1.0.0 to v1.0.3).**
- vectorize/map.js moved a lane local's definition, its load with it, to its one use past a
  store between: `t = d[i]; d[i] = s[i]; s[i] = t` over a Float32Array and an Int32Array of
  one buffer left the float's bits (levels 2, 3, speed). `movesTo`: a definition moves only
  where it commutes with what runs between. `test/view-order-population.js`, 378 programs.
  Of the three rewrites the rule guards, the narrowing store's alone is shown failing
  without it.
- vectorize/lift.js took an f32 lane conversion's sign from the load, which an Int32Array
  and a Uint32Array share: a Uint32Array copied to a Float32Array read 4294967296 as -1
  (levels 3, speed). One table, `CONVERT_LANES`, keyed by the scalar's conversion.
  `test/lane-convert-population.js`, 518 programs. The column convolution's new guard is not
  shown failing.
- `tryReduceBitExact` registers a body local's lanes after its statement is lifted (no wrong
  answer before: the one legality declined the loop).

**Open after 6c.**
- stdlib-ddot at the exact level is 2.44× rust-wasm: optimize/guards.js does not merge the
  bounds checks of a cursor stepped by a constant.
- `INT_WIDEN_F32`'s `lossy` on `i32.load` is wrong (an i32 to f64 is exact and the demotion
  rounds once, as the lanes' conversion does): an Int32Array or Uint32Array to Float32Array
  map could lift at the exact levels. Moves bytes; not taken.
- Four loop kinds the chooser does not lift (the writer's hand-back names them);
  `licm.js` `SAFE_OFFSET_CALLS` has no reader.
- The two new populations add about twelve minutes to the generated suite.

**The float default (the integrator's reading of the owner's rule, open to the owner).** The
rule: a deviation within 100 ulp is allowed where it saves time or size. Kept: the default
level exact, reordered float sums and products at `'speed'` (which is level 3) alone. A
reordered sum has no ulp bound under cancellation (README's bound is n·2⁻⁵² of the terms'
total magnitude), so it cannot be promised within 100 ulp; and the gain is three kernels of
105 (dotprod, matmul, stdlib-ddot, 1.6 to 2×) and no example, where the exact lowering
already takes 7 to 24% of their time at level 2.

## The exception edge landed: six wrong answers of one class (2026-11-16)

Eight commits of its writer's, on the same tree (its brief is `.work/exception-edges.md`).
One reader, `leavesTo(node, name)` and `leftLabels(node)` in src/ir/control.js: a branch's
labels and a `try_table`'s catch clause, whose label is its last operand. reuse-loads.js,
settled-tests.js, forward-checked.js, cse-address.js, effects.js and
vectorize/outer-scaffold.js ask it. liveness.js holds what a handler reads live through the
whole of its `try_table`'s body (`keep`: no write in the body kills it); compile/cse-load.js
ends its loads at a try statement; plan/integral-loops.js leaves a step inside a try
statement where it is; the emitter takes the throw of a finalizer's copy that a `return`,
`break` or `continue` runs past the statement's own handlers by a catch clause of its own
(the copy stays where the exit is; it ran inside the statement's `try_table`, and a
finalizer that threw ran twice); split-funcs.js moves no run out of a list that already
left with an earlier one (a compile error, `'f0$p5' is not in scope`, which the scout had
read as a state leak: it is not one).

- `scoutcheck.mjs` on the landing tree: 0 of 42 differ (24 on 9ff7eb3d5). `finloop.mjs`'s
  handler in a loop at `size`, which the populations tip had, is right.
- `test/handler-population.js`: 527 programs, a module each, six levels; the writer shows
  it failing with each of the seven fixes out.
- Bench bytes (the writer's take-outs; the integrator's hashes agree): async +52 at speed
  (more compaction roots), decode-dsd +67 and +99, decode-tta +29 and +33, decode-wav +31
  and +33, webaudio +58 and +55 at size and speed (the emitter: `try { … return f() }
  finally { r.free() }`), stdlib-special -30 and watr -19 at speed.
- Timing by the integrator, sixty alternating rounds, load 12 to 27, controls alpha 1.000,
  decode-qoa 1.002 and jessie 1.002 by the least: async 1.011 and 1.020 (least, median),
  watr 1.013 and 1.011, the other five within 0.5%. Geomean 1.002. The writer's own run
  (load 30 to 40, a control at 1.049) decided nothing.
- Hosted compiler +633 bytes on the writer's bootstrap.

Not fixed, by the writer's reading (no program differs today): jump-pointers.js never
joins a handler's path (it keeps the body's end state; safe while interval-proof.js kills
at entry every local a try statement writes, so none is typed i32), and licm.js
`cseScalarLoad` is right only because every block a catch clause names ends in a `br` or a
`return` the emitter puts there. flow-range.js, forward-hops.js `deadResets` and
split-slots.js settled by their own lines. The loop and region escape checks that bail at
a `try_table` (word-ranges.js, split-funcs.js `back`, sink-stores.js, specialize.js,
prefilter.js, wide-accumulator.js, guards.js, carry-stores.js) keep their own readers,
unchecked.

## The held-out lane's first dry run, and the two programs it cannot run (2026-11-16)

(The harness writer's own note is its commit c97822437 under 9b; this is the integrator's.)
Run 43777318282 on f7092c17b, V8 alone: awfy 14 of 14, clbg 9 of 11. clbg-nbody-node-2 is
a sloppy-mode script (it assigns `n` and `runTest`, never declared) and every lane takes
the driver as a module; clbg-mandelbrot forks `cluster` workers and a lane is one process.
Both stay registered and carry `notMeasured` with the reason (7795bde16): the dry check
expects each to fail in V8 and fails when one passes, the record holds no entry for them,
the figures keep them in the denominator by name. The two sources were fetched and read
on the integrator's word after their registration and before any contact; neither was run
here. Harness only: not in the battery below, its own `npm test` 7,481 and the held-out
tests of test/bench-claims.js passing (the file's 21 failures are main's, the stale
dataset). The dry run after landing should print 9 of 11 and `2 not measured`, exit 0.

## A program that never returned: the record of an array's first store, freed under the log (2026-11-16)

Found by the re-entry population's port, fixed by its writer (82e3cbc75 on the landing
tree), in v1.0.0 to v1.0.3. Eight lines, three exports called in order from JavaScript:

    let a = [7, 1, 5]
    export let w1 = () => { a[0] = a[0] + 1; return 1 }
    let b = [2, 3, 5]
    let s = 'bc'
    export let w2 = () => { b[0] = b[0] + 2; s = s + 'x'; return 1 }
    let c = [4, 8, 4]
    let o = { a: 4, b: 4 }
    export let w3 = () => { c[0] = c[0] + 6; o = { a: 1, b: o.b + 1 }; return c[0] + c[1] + o.a + o.b }

`w3()` never returned at the default level and at `speed` (levels 0 and `size` answered).
The integrator ran it in a child process with a 20 s limit at the four public levels
(`hangcheck.mjs`): no answer at `true` and `speed` on main f7092c17b and on the tag v1.0.3,
Node's answers at all four on the landing tree.

The cause: a call's first in-place store of a number into an array made as the module
started saves the array for `memory.reset()` in a record (`__durable_arr_snap`) allocated in
the call's own frame and linked into the round's log. Such a store is no escape the frame
census counts, so nothing lowered the escape flag, and a frame that gives its heap back at
its return (`w2`'s, which reads the flag for the concatenation) freed the record while the
log still named it. The next allocation wrote over it; the next walk of the log
(`__survive`, module/core/reach.js) followed the overwritten link without end, or
`memory.reset()` read it and trapped. The fix is at the one inline site every direct
element store emits (module/collection/durable.js `durableArrSnapNode`): the flag goes down
to the array as the record is made. The kernels' stores (push, fill, splice, sort and the
rest) stood at census sites and were right: the writer probed 19 mutation paths.

- `test/mem.js`: the hang and the trap, each in a worker the test stops at 60 s
  (`test/_bounded.js`); `test/reentry-population.js`: 1,200 programs of three seeds, a
  seed's programs one module, in the generated suite (about 250 s at load 20 to 31). The
  writer shows seed 1 and the pin failing with the lowering out.
- Bench bytes: 0 of 105 at size and speed (no bench program resets its memory). Hosted
  compiler +4,170 bytes on the writer's bootstrap.
- What it costs, found by the integrator hashing all 70 examples (the bench corpus does
  not show it): `examples/zzfx` grows 32,950 -> 37,619 bytes at the default level and
  46,274 -> 51,077 at speed (equal at size), the one example of 70 that moves. Its
  `b = []` is filled by `b[i++] = …`; the site of such a store now holds a call that
  lowers the flag, so the function's frame reads as one that may keep memory, and that
  links the compaction kernel (`__compact` and 19 helpers) into a program that had none.
  At run time the path is never taken (the array is the call's own): the frame of
  examples/bench.mjs took 721 to 741 µs before and 721 to 730 after, five interleaved
  rounds, and `memory.used` stays 0. Open: a store through a local whose every value is
  an array the same activation made needs no record and no test (a resumable function
  aside: a generator begun as the module starts stores after it); that drops the site,
  the kernel here and a compare from every such store.
- Not fixed, a separate defect the writer found: `memory.reset()` does not undo `shift()` of
  an array made at start (`const b = [2, 3, 5, 7]`, shifted once, reads `3,5,7` after the
  reset, at every level, in v1.0.3 too): the log never records a shift.

**The hosted leg cannot hold three of the ported populations** (6177d78ee): the compiler
compiled by jz frees nothing within a compile and ran out of memory on the vector order
and vector narrow modules (683 and 1,000 programs joined) and on the float reductions at
exact and speed. They return at once on that leg (`onKernel()`), with the reason beside
each; the re-entry population's generated programs skip it too. Split in thirds the float
reductions passed there and took 66 minutes, so they are not split. The integrator's run
of the tree before the skips (abd8fd14b, `test:bootstrap -- --full`) ended 6,533 of 6,537
on the hosted suite in 3.5 hours: those four tests and no other, each "Out of memory: the
heap cannot grow". Every other ported population passed there.

## The two parsers' and the two commands' small things (2026-11-16)

- **watr 5.13.7** (4da718708): the `outline` fix of the section above; `scout6c-check.mjs`
  is 0 of 24 on the landing tree. Published 2026-11-16 from 334b608.
- **subscript 10.8.4** (ea0795b7d): subscript's issue 41 (`a < b << c` read
  `(a < b) << c` wherever `<` was registered after `<<`) is the defect jz's parser entry
  had worked around by ordering each character's operators longest first after its tokens.
  subscript now keeps that order as each operator is registered (one stable sort in its
  `register`), so the entry's loop is deleted. The order every character's operators are
  tried in is the same before and after (`opsdump.mjs`, 39 first characters). In subscript
  the fix was checked against V8: every pair and triple of JS's 23 binary operators,
  12,959 expressions, 385 differed before and none after.
  One bench case moves with the pin, by its input: `bench/jessie` compiles subscript's own
  parser from `node_modules`, so 10.8.4's `register` is in its source (76,173 -> 77,433
  bytes at size, 193,351 -> 192,628 at speed; the tree before the pin, given 10.8.4,
  compiles it to the same bytes). Its times in the dataset are of 10.8.3's source until
  the next reference run.
- **`-o` naming a directory** (63c13d60f, discussion #120): `compile.mjs … -o ./out` with
  `./out` a directory built everything and failed in the linker; `jz … -o out` answered
  EISDIR. An output that is a directory, or is spelled with a trailing separator, holds
  the file under the input's name (`out/host`, `out/host.wasm`), as `go build -o` reads
  one, and the native script makes its output's directories as jz does.

- Found on the way, not fixed, older than this landing: two copies of jz loaded in one
  process over one copy of subscript (two checkouts whose `node_modules` resolve to the
  same directory) stop parsing a source that begins with a comment, in both copies:
  "Unexpected character" at 1:1 (`twojz.mjs`; abd8fd14b with subscript 10.8.3 the same).
  The parser entry registers its tokens on subscript's module-wide tables as it loads,
  and the second load undoes the first's comment handling. An install does not meet it
  unless two copies of jz share one subscript; a probe that imports two trees does.

**The landing's battery** (2026-11-16, 05:22Z to 12:40Z, a leg at a time at four jobs), on
the landing tree as it stood then: land-b's 42 commits and the seven above them on
f7092c17b, tip 5d3f9d9ae. Lint and the file audit clean; bench bytes 1 of 105 moved against
land-b's rows (jessie, by its input); the invariants leg 7,286; default 7,487; the
bootstrap whole (self-roundtrip, kernel parity, checkpoint, the hosted suite in 2 h 10 min,
recursive); level 0 7,270; level 3 7,284; WASI 7,359; generated 229; integration 229, 76,
76 and 79; test262 4,120 and 0; one process 7,487; the examples 25 of 25 ahead of V8,
geomean 1.66× (24 of them 8 to 14% faster than land-b's logs, which were taken beside a
stray process of the integrator's at a full core, the hang's reproduction left running
ten hours: the bytes of 69 of the 70 examples are equal on the two trees, so the
difference is the base's load). The first battery, on land-b, was stopped after its
self-compile leg ended as foreseen, 6,533 of 6,537 on the hosted suite.

The guide's eleven commits above it (tip 83f6f07bb) change no code token in 60 script
files; on that tree the core suite 7,487, lint and the audit clean.

**Replayed for main.** The weekly bench run had meanwhile committed its refresh on main
(bf4e75ff6: bench/results-ci.json, one figure of README.md, index.html), so the sixty
commits were replayed over it and every commit of this landing is named in this file as
main has it: the tested tips 5d3f9d9ae and 83f6f07bb are ea0795b7d and a79b59c52 there,
their trees equal but for the refresh's three files. One commit more points the guide and
its ledger at ea0795b7d, the last tree with the 501 KB file (f1e4472d4).

Found at the replay, not this landing's: the refresh leaves `test/bench-claims.js` with one
failure more on main itself (24 pass and 22 fail at bf4e75ff6, 25 and 21 before it): "2
figure(s) in the prose are STALE vs results.json". The weekly run writes README's figures
from `bench/results-ci.json` and the test holds them to `bench/results.json`. Phase 11's
to settle with the reference run.

## Phase 10 mapped before it was briefed (2026-11-16)

A scout mapped the file and the tests before a writer was briefed (Sonnet 5.5, read-only,
on the landing tree ea0795b7d; its map was session scratch). The integrator checked: 25 headings, the one
reader at test/bench-claims.js:320, the two `docs/CONTRIBUTING.md` paths.

- CONTRIBUTING.md is 501,512 bytes, 6,606 lines, 25 headings, 270 paragraph blocks.
  254 KB stand under one heading that does not describe them ("Shared watr optimizer").
  By the scout's classes (inferred from first lines for about 240 blocks): design prose
  465,614 bytes, guide 30,843, history 4,784. About 17% repeats text found elsewhere
  (8-word runs, a lower bound that generic phrases inflate); the large blocks are in no
  other file. It grew from 145 KB on 2026-09-25.
- 42 lines elsewhere point into it; 11 name "Stdlib registration", which is no heading.
  One test reads it (`asc -Oz --converge`). Eight workflows ignore pushes that touch it
  alone. No gate holds its size.
- Tests: 1,498 assertions on WAT text in 184 files (plus 397 through helpers), about 40%
  the presence or absence of a named helper or instruction; no test imports a deleted
  recognizer; about 38 labels and 10 comments name functions or files that are gone.
  No existing gate has a cell for "this program links no helper X".

The row's done criterion as briefed (the row was written before the map):
1. The guide is at most 30,000 bytes.
2. No design note is deleted for size: each block is kept in the guide, moved to the
   header of the file it describes or to a README of the directory whose mechanism it
   describes, deleted as a duplicate of a named place, or deleted as stale with what
   contradicts it named. A ledger (`.work/phase-10-docs.md`) and a rerunnable check hold
   the move; moved text is moved by script, not retyped.
3. Under src/, module/, jzify/ only comments change: token streams equal, bench bytes 0
   of 105.
4. Every pointer into the file names something that exists.
5. Tests: stale labels only. "Pins replaced by gate cells" is dropped from this phase
   (the integrator's call, put to the owner): no pin is of a deleted recognizer, and
   turning 1,500 assertions into table cells is a project of its own with no cell kind
   for helper absence today. Left as open work: a census of which pins state an outcome
   (links no string helper, vectorizes) and which a form (an instruction sequence).

The writer (Opus 5.5, xhigh) started 2026-11-16 on land-c's tip, beside the battery.
Blocks about files 7b/7c deletes stay in a marked tail until that branch lands.

**The owner's ruling, the same day** ("contributing - srink drastically; design notes are
not needed if no value; reply to the question; shrink whatever tests possible to shrink"):
- Points 2 and 5 above are overruled. A design block is deleted by default and kept only
  where a person changing the code would get something wrong without it (a contract the
  code does not state, a soundness condition, a decision with the figure that decided
  it); kept sentences verbatim, by selection, never paraphrased. The ledger records each
  block's state. Sent to the writer as a change of brief; test labels taken out of its job.
- Tests are to shrink wherever they can. A census first (the scout again, read-only:
  duplicates by AST, identical compiles, tests that assert nothing, pins a gate holds,
  dead files, comment weight; session scratch, `p10/tests.md`), then a writer after the
  battery, a test deleted or merged only on evidence that what it guards stays guarded.
- The reply in discussion #120 is posted (discussioncomment-19646838).

**The guide as handed back** (branch `worktree-agent-a999c751978a0f58a`, 11 commits on
ea0795b7d, b4061dd72 to a79b59c52; Opus 5.5, effort asked xhigh and not confirmable from
its transcript): CONTRIBUTING.md 501,512 -> 32,730 bytes (24,977 outside the public
contract, which is 7,753 of its 11,851). By the ledger (`.work/phase-10-docs.md`, its
check session scratch, `p10w/check.py`): cut as describing the code 393,718, as a
duplicate of a header 52,427, stale 3,282, history 1,730; guide 27,859; kept verbatim in
the headers of 55 source files 22,496. No README was made, README.md is untouched.
The integrator's checks: the ledger check passes; `tokeq.mjs ea0795b7d <branch>` reads 60
script files equal in code with comments dropped, 0 differing; the authors are the owner
alone; read whole; of the ten cuts the writer was least sure of, one read (the x64
rounding hazard of the ToInt32 lowering: src/optimize/to-int32.js's header holds it).
Sent back once: the contract had gone to README.md (50 KB, internals in it) and returned
to the guide cut by the same test; "recognizers are tried in order" was stale since 6c and
now reads as index.js's own words. Not rerun by the integrator: the whole suite (the
writer's: 7,487 pass), bench bytes (the writer's: 0 of 105). Lands with or right after
land-c: it changes no code.
- Put to the owner, unanswered: the guide's "One shared optimizer, owned by watr … the
  existing generic passes in `src/optimize/` are migration work" beside the pass table
  and rule table built in jz.
- At the merge of 7b/7c: its CONTRIBUTING.md hunk (old L1941-1951) lands on cut text; drop it.

## 7b and 7c handed back: one address form, one numbering; the counted copy held (2026-11-16)

The writer's branch
`worktree-agent-a0535e0f76860e45e` (Opus 5.5), five commits taken onto `land-d` (land-c,
the guide, then dcd903159, 740cf8fad, 0e0808317, c61552682, 650e3f5b9; the writer's
56a764eb8, d7bf2a9dd, 38f600a95, 690935515, 2e8dc0e59), its guide hunk dropped (it edited
text phase 10 cut).

- **7b** `src/optimize/address.js`: one reader of where a load or a store points, a sum
  `k + Σ scale·atom`, and one `mayAlias` (the emitter's marks, bytes of one sum, a header
  word against a wide payload store, roots a reader proved apart). Every memory pass reads
  it. `src/optimize/cse-address.js` is deleted.
- **7c** `src/optimize/numbering.js`: one walk numbers a function's values for the four
  uses that each walked it themselves (a box's tag, an array's forward word, a typed
  subscript's address, a load); `src/optimize/reuse-loads.js` is deleted, with
  `foldStaticArrReads` and `postGlobalPtr`, which changed no function of the 423 census
  units. Joins: both arms of an `if`, nothing past a block a branch leaves to, nothing at
  or past a loop, a try or a handler. The row's done criterion (the forwarding and reuse
  files deleted) holds for reuse; `forward-store.js` and `forward-hops.js` stay, on the
  shared reader.
- The writer's figures, not rerun by the integrator unless said: bench bytes 29 cases
  moved, -78 at size and -308 at speed, against the tree before; the hosted compiler
  +54,668 bytes (37,259,351); generated suite 226 of 226; the hosted suite 6,543 of 6,547,
  the four the three populations that land-c now skips there; lint and audit clean.
- The integrator: read numbering.js and address.js whole (the walk kills a run at a write
  of a local it reads, at a store that may reach its bytes, at a call not pure, at every
  bulk operation; a store's address that tees its own local is read after the tee, and
  the runs of that local are dead by then); on land-d lint 0, audit 0, `scoutcheck` 0,
  `scout6c-check` 0 (it read 1 on the writer's tree, watr 5.13.5's outline defect),
  `finprobe` 0 of 9 programs at 6 levels, `hangcheck` 0 of 4 levels; bench bytes against
  land-c's rows 29 of 105 moved, -78 at size and -308 at speed, the writer's figures
  exactly (decode-qoa -261 at speed, decode-alac -49, decode-wav +15, watr +8, seven color
  cases +4 each); the tests the passes touch 76 of 76 (loop-forms, spellings, effects,
  numbering, address, mem-alias, pass-table) and 897 of 897 (optimizer, frame-effects,
  closures, strings, mem); the finalizer, handler and try populations 30 of 30.
- **Held, with its writer: the counted copy** (4240477e8): a counted loop takes a local
  copy of a global its rounds read, which the base fold then puts in the memargs. The
  spelling gate goes 74 gaps to 42 (the dot and map kernels' 32 cells close, two of map's
  shrink, six of ring's grow by one op); bench bytes +251 at speed in 7 cases. It fails
  one core test: a countdown loop's strips at level 2, where the lane lift's distance test
  now compares against the local copy of a `const` typed array's global and no longer
  folds. The fix asked for: a copy of a global no code writes after start reads as the
  global wherever the lift reads an address; and the six ring cells explained or closed.
- **The counted copy handed back and taken** (land-d b2dcc75c8, 0fe8d1130; the writer's
  3c3394fca, 284ea7a27). The fix is general: a local every write of which is one
  `global.get` of a global no code writes after start reads as that global in the strip's
  distance test (`vectorize/alias.js` `globalCopies`, `optimize/globals.js`
  `settledGlobal`, `optimize/effects.js` `setAfterStart`). It also serves the copies
  `promoteGlobals` already made: a countdown loop over two module arrays is 70 lines of
  WAT where it was 91. The spelling gate: 74 gaps to 42, nothing opening but the six ring
  cells, which count one op more for one ALU instruction fewer an iteration (the base now
  a local, `tryStrengthReduceIV` steps two element pointers where the loop shifted and
  added twice): the count's artifact, recorded as such. The writer's figures: `npm test`
  7,499 of 7,499, the generated suite 229 of 229, vector-coverage with no mark lost or
  gained, bench bytes 0 moved by the fix and 7 cases +251 at speed by the rule
  (stdlib-special +209: 26 small kernels copying one to three module globals).
  The integrator asked one guard more: inside the start function a global start writes is
  not settled (no source reaches it: `startcopy.mjs`, 24 cells, 0 differ).
- Open, to time after the battery: the 7 cases the rule grows, the 29 moved cases, and the examples `fireflies`
  (1.041) and `dwa` (1.025) the writer measured slower and did not settle.
- `test/handler-population.js`'s header still names `optimize/reuse-loads.js`.

## `memory.reset()` undoes a shift; and what the probes of it found (2026-11-16)

The hang's writer (Opus 5.5), 8d994aa5f on 83fb473a5.

- **The defect** (in v1.0.3 too): README promises an array the module made as it started
  reads as it started after `memory.reset()`. Of 15 mutations of a 4-element array of
  numbers, strings or both, in one call, at the four public levels (`resetprobe.mjs`, 156
  cells), the 36 that shift differed and no other: after `shift(); reset()` the array read
  `3,5,7`.
- **Cause**: a shift moves the live header up a slot and rewrites the forward word at the
  base, and the round's record held neither: `__arr_shift` made none, and a record taken
  from the live header leaves the base's word out for an array already shifted.
- **Fix**: the record is the array's words from the base's header to its last cell
  (module/core/durable-log.js `__durable_arr_snap`, healed by `__durable_arr_heal`); the
  shift tests the base's bit (module/collection/durable.js `durableArrSnapBaseIR`).
  A shift of storage the call made runs 4 instructions fewer than before; of a durable
  array already saved this round, about 22 more and a byte load.
- The writer's figures: `test/reset-population.js` (generated suite, four seeds of 100
  arrays, 28 mutators, 2 to 3 rounds, a fresh instance the oracle), failing under each
  take-out; `npm test` 7,482; generated 198 of 198 on WASI, native 195 of 198 before the
  ratchet's new baseline (9 loop nodes fewer in `$_clear$exp`) and not rerun whole after;
  `test:self` 89, the hosted compiler +3,441 bytes; bench bytes 0 of 105 (the bench
  compiles with `alloc: false`: no reset log there at all, which is why it never showed
  the hang fix's cost either); three examples 13 bytes smaller.
  The integrator: `resetprobe.mjs` on the writer's tree, 0 of 156. On land-d as
  3a156daf7 (its guide paragraph and its dated ratchet note left out: the code's comments
  hold the first, the cut ratchet file the rule; the two test lists merged): lint and
  audit clean, `resetprobe` 0 of 156, `hangcheck` 0 of 4, the memory, compaction and
  array-method tests 325 of 325, the reset and re-entry populations and the ratchet 20 of
  20; zzfx reads 37,610 and 51,068 bytes (9 fewer than on land-c).

**Found by the writer's probes, confirmed and widened by the integrator: shifts as the
module starts** (no reset involved; `startshift.mjs`, nine programs at four levels, each
a child process with a 15 s limit; land-c 5d3f9d9ae: 24 of 36 cells differ):
- `const q = [1, 2, 3, 4, 5]; let s = 0; while (q.length > 2) s += q.shift()` at top
  level never answers, at every level;
- two shifts at start then a read: 323 for 502; a loop over it: 15 for 12; a shift then
  a push: 50331648 for 3094;
- one shift at start, and two shifts inside a call, are right.
  The tag v1.0.3 (7c5e46f01): the same 24 of 36, the queue unanswered at all four levels
  (`startshift-v103.sh`). The tree with the reset fix (8d994aa5f): 16 of 36.
  **Fixed** (the writer's 192fa9250, land-d 1414c7ee0). Cause: every reader that follows
  an array's forward first tests the offset against `__heap_end64`, declared 0 and set
  only by `__memgrow`, so no forward was followed before the module's first heap
  allocation; a shift is the one move that writes a forward without allocating, and an
  array of the static data (a literal: `const c = [1]` is no allocation either) needs
  none to exist. Once one was shifted in that window every later read took the base's
  forward words for its length and capacity. The fix is where the memory is declared
  (src/wat/assemble/stdlib-pull.js): the bound starts at the declared pages × 65536.
  A module that declares the bound is 2 bytes larger (48 of 105 bench cases, 69 of 70
  examples). `test/start-population.js` (generated suite: three seeds of 100 modules,
  top-level code of 1 to 5 mutators, reads and loops over the length, each module a
  bounded worker, Node the oracle; 22, 20 and 12 differ with the fix out) and a pin in
  test/mem.js. The writer's figures: `startshift` 0 of 36, `npm test` 7,483, generated
  201 of 201 native and WASI, `test:self` 89, the hosted compiler +420 bytes.

**The store through a binding the call itself made** (the writer's 51bf8b683, land-d
e521f93b8): what the hang fix cost zzfx. The frame census's `freshObjects`
(compile/analyze/frame-effects.js: a binding every write of which is a literal, no
parameter, none a nested function writes) holds array literals beside object literals,
and the reset's snapshot test is left out at a store or a mutator call through such a
name (module/collection/durable.js `madeByCall`; the sites: an element store, the push
inline, a block's and a loop's saves, pop, splice, reverse, sort, the spread unshift).
Right because an array the activation made is one made at start only while the start
runs, when the reset mark is 0 and no record is made anyway; any later store reaches it
through another name. zzfx: 37,612 -> 32,721 bytes at the default level, 51,070 ->
46,031 at speed (229 and 243 below what it was before the hang fix: the test is gone
too); no other example moves, no bench case (no reset log there). Nine must-not-apply
programs are fixed cases of the reset population, two failing with the census's delete
taken out. The writer's figures: `npm test` 7,483, generated 210 of 210 native and
WASI, `test:self` 89, the hosted compiler 3,375 bytes smaller. The integrator: nine
programs of its own (`freshprobe.mjs`: returned from a start call, a spread copy, an
alias under a test, nested, recursion, a closure's store, kept in a loop, reassigned to
a second literal, a default parameter), three rounds each against a fresh instance at
four levels: 0 of 36 differ.

**Also found, with the writer after that**:
- A Map made at start: `delete`, `clear` and a new value for a start key persist across
  a reset (246 of 360 program-levels of the generator); a Set: `delete` and `clear`; an
  object: a static string stored into a field. README names collections and objects
  beside arrays. Asked first: whether a value made in the round and set under a start
  key dangles after the reset.
- An async function begun at start: reset returns to the end of `__start`, before its
  continuations ran, so a reset instance reads `[1, 2]` where a fresh one reads `[9, 2]`.
  A limit to write down, not built.
- The site of a store through a local the same activation made (`b = []; b[i] = …`):
  none in the bench corpus (no reset log), four in the 70 examples, all in zzfx; the
  frame census already knows such locals for object literals (`freshObjects`); the
  writer builds the same for array literals.

## Phase 10, the tests' part (2026-11-16)

**The census of test/** (session scratch, `p10/tests.md`, the scout, nothing run): 385 script
files, 8,962,098 bytes, 7,202 static tests, 18,153 assertion sites. The tests are not
copies: 2 provably identical, 4 subset pairs, 185 of 6,219 static compiles repeat another,
no test asserts only what a gate's cell asserts. Comments are 1,816,529 bytes (20.3%),
943,261 of them in blocks over 400 bytes: bug stories with dates and tickets, root-cause
prose naming functions since gone, banners. 79 tests assert only a compile's success or a
form true by construction. The logs hold time per process only (12 processes, 5,583 s
summed), none per file.
- So what shrinks at no cost to protection is comment text and a few dozen tests: the
  test writer (Opus 5.5, xhigh, on land-c's tip) cuts comments by the same test of value
  (citations of a source for an expected value always kept), fixes the stale names,
  reads the 79 and deletes those that guard nothing. The 1,498 assertions on WAT text stay.
- **As handed back** (branch `worktree-agent-a8c9abf4b664de951`, 17 commits on 5d3f9d9ae,
  taken onto land-d as 185dbcd8e to 147558ec2, one comment conflict in test/strings.js
  kept as 7b/7c wrote it; Opus 5.5, effort not confirmable): test/ scripts 8,962,098 ->
  8,480,711 bytes, comments 1,816,529 -> 1,363,110 characters. Nine tests deleted (one of
  two identical, three subsets of another, two that pass whether the compile throws or
  not, three `ok(true)` after work the same file asserts by value), 44 titles renamed
  from functions since gone to the behaviour, the export `scalarCasesIn` and two
  `_comment` fields removed. A first pass cut 669 KB; the writer's own sample showed
  about one story sentence in six was a warning, so it read all 1,130 and restored 844
  (213 KB): what a test guards, warnings, sources of values, the reason of each entry of
  an exclusion or known-gap list still in its list.
  The integrator: `tokeq.mjs 650e3f5b9 land-d --strings`, 187 script files equal in code,
  9 differing (the eight files of the deletions and the export), 44 strings; the three
  "PARKED" notes of known wrong answers cut from test/data.js are right today
  (`parked.mjs`, 8 programs at 4 levels, 0 differ); the ratchet's dated notes of each
  raise of its baseline, which the writer restored whole, cut again on land-d (85f101fe2:
  a raise's reason is its commit's message). The suite after the first pass, the
  writer's: 7,478 of 7,478 (7,487 less the nine). The integrator's, on land-d at 85f101fe2
  with the guide and 7b/7c under it: 7,488 of 7,488 at four jobs.
- Open, found in the cut: `new Date(0)` links the allocator and memory growth for one
  pointer (the note went with its `ok(true)` test in test/minimal-output.js).
- Open, the integrator's after the battery: time per file and the run-time count of
  repeated compiles (`JZ_HASHES=<out> node --import ./test/_hashes.mjs test/index.js`),
  before deciding whether tests are merged to share compiles.

## The land-d landing: main's CI, the reset's next part, the briefs scrapped (2026-11-16)

**CI on 9d0bf1ec2 (the land-c landing as pushed).** test262, pages and examples-perf
green (the examples: x64 1.40× by geomean and ahead on 55 of 66, Linux arm 1.39× and 57
of 66, macOS M1 1.66× and 64 of 66, as the push before it). `test`: the default, level 0,
level 3, wasi and fuzz jobs green; its claims job red, as it stays until phase 11. `bench`
red by the Porffor evidence item alone; its three new timing notes are the runner's: the
300 perf-fuzz programs compile to the same bytes on f7092c17b and 9d0bf1ec2, 68 of the 70
example builds too, and perf-fuzz passes on both trees here. The held-out dry run
(43902691018) green: awfy 14 of 14 pass their check in V8, clbg 9 of 11 with the 2 marked
not measured.

**`self-compile` did not finish on 9d0bf1ec2.** Run 43869637359 was cancelled at the
job's 240-minute limit, inside "bootstrap, parity, hosted suite and recursive jz × jz":
not a pass, and what it would have said on that runner is not known (the same leg passes
here on land-c and on this tree). The runs before it took 2 h 43 min (f7092c17b) and
3 h 20 min (9ff7eb3d5). The hosted suite is what grew. On this machine, four jobs, other
work beside it each time: 4,255 s on 14 November, 4,894 s and 6,463 s on the 15th,
7,813 s on land-c, 7,141 s on this tree. The populations the land-c landing ported into
the suite are the largest part by inference: time per file under the hosted compiler is
not measured. This landing raises the job's limit to 360 minutes, the most a hosted
runner gives, so that the gate reports again. That is a stopgap, and it is not known
that 360 is enough. Next: time per file under the hosted compiler, then the suite split
over jobs as the bench corpus is, or the populations sampled in that leg.

**The reset, task C: checked, not landed here.** 152b40849 on this tree's tip (branch
`worktree-agent-a29e352754b8f20da`): a Map's and a Set's table is saved whole on its first
write after the module starts (`__durable_tbl_snap`, the array's record format), an
object's field is saved when it holds anything but a number, and the entry, value,
cancel and relocation logs are deleted. The integrator's probe (`tblprobe.mjs`: 78
programs over Map, Set and literal objects at four levels, each a child process with a
time limit, a fresh instance and Node as oracles): 312 of 312 cells right on 152b40849,
where 145 of the first 204 were wrong on this tree and on main. (The brief to the writer
said 280 of 280: the integrator's miscount.) The cost, `tblcost.mjs`, jz against itself:
reads unchanged and nothing kept; the first write to a table of 100,000 entries keeps
8.7 MB and takes 0.2 to 0.4 ms; a loop of writes to a saved table is 1.2 to 1.8 times
slower (the test "already saved" on every write), a local table 0.82 to 0.84. The
hosted compiler 37,282,113 -> 37,305,213 bytes, not broken down. Bench bytes: 8 of 105
smaller at speed. A frame's release of memory cannot free a table's record: the census
site lowers the escape flag when the heap moved (27 programs written for it pass).
**The reset, task D: handed back and checked the same day, not landed here.** Four
commits on 152b40849, tip f5537a47b: an object used as a dictionary is saved whole as a
Map's table is (24 of its 32 cells were wrong, on main and on 1.0.3 as well: `D.list =
['z']` in a round, and after a reset every call threw), with an object's deleted-field
mask; a write compares its table with the table saved last before it calls the save;
the "no number" test is one signed compare; the slot log, which no site wrote any more,
is deleted. The integrator's probe: 344 of 344 cells right, no fresh instance differing
from Node; `tblcost.mjs` as the writer's (a loop of writes to a saved table 12.3 ms at
the default level and 14.2 at speed, 10.8 and 8.9 before C). The writer's figures: the
hosted compiler 37,270,978 bytes (37,305,213 on C, 37,282,113 on this tree); bench bytes
against C equal at size and 1,622 fewer at speed over 94 cases, none larger; `npm test`
7,492, the generated suite 254 of 254 native and wasi, `test:self` 89. Listed by the
writer and not taken: compaction walks every word of a saved table's record (a round
6.5 ms where 2.1 would do, were a record a leaf), one `set` keeps the whole table's
copy, the zombie-key arms are dead code. C and D land on the next tree with the
array stores below.

**Phase 11, class A (the array store): handed back and checked, not landed here.** Nine
commits on this tree's tip, dba289f85 (branch `worktree-agent-ac3852370d29a350c`). The
advisory had blamed the receiver; the key was what no proof resolved. A store into a
known array under a Number now stores inline inside the length and makes one call past
it (`__arr_set_num`), a counter a loop steps by one with a store each round and a
cursor stepped through stores are proven element indices, and a counted loop is split
at the end of the arrays it indexes affinely. The integrator's kernels (`dwtime.mjs`,
load 7): `buf[i] = v` under `i < n` 5.60 of V8's time before and 0.89 after, through a
parameter 3.67 and 0.57, six stores a bone 5.20 and 0.69; the controls unchanged; no
`deopt-dyn-write` on an array receiver in the integrator's probes. The writer's
figures: fabrik 106 to 62 µs (3.79 to 2.30 of C-wasm), polytri 1,048 to 990 (1.98 to
1.83); bench bytes 17,071 fewer at size and 24,987 at speed; the hosted compiler
+2,597; a population against Node in the generated suite, on which this tree differs in
120, 112 and 108 of 240 runs a seed (a read trapped after a third inserted property; a
store through a cursor into packed cells wrote eight bytes over four: both fixed there).
An index in [2^31, 2^32-2] past every length throws now, as the README's "32-bit element
indices" says, where it stored a property. Open with the writer: two counters in one
loop head and a cursor after the plan's copies (polytri still links the hash store
through them), then class B. Its commits conflict with D's in module/collection.js: the
writer rebases them.

**The briefs and the scouts' maps are deleted**, on the owner's word ("scrap the
outdated/unused .work md files"): 21 briefs and 17 maps, 771,228 bytes, in the commit
after this record; the opening of this file says how to read one. Kept: this file, the
handover, `claims-for-the-owner.md`, `phase-9b-heldout.md` (the contact run is ahead and
the lane's manifest names it), `decode.md` and `audiojs.md` (bench/ names them), and the
owner's notes (`abi.md`, `ecosystem.md`, `marketing.md`, `strategy.md`, `todo.md`: the
owner's to rule on). Found on the way and not fixed: 215 pointers in 105 source files to
`.work/archive/*`, `.work/evidence.md`, `.work/emit-split.md`, `.work/prepare-split.md`
and `.work/optimizer-review/*`, files deleted in September; a comment-only change for
the next tree, checked by token equality.

**subscript 10.8.4 costs 6.5% more instructions a parse than 10.8.3** (the owner:
"last few sessions made subscript slower"). Measured by instructions retired
(`/usr/bin/time -l`, a difference of two run lengths, three times), which the machine's
load does not move as it moves times: the expression of subscript's own perf test is
42,500 a parse from 10.5.2 to 10.8.3 and 45,400 on 10.8.4 (`subscript`), 58,900 and up
to 62,900 (`justin`); jsep 1.4.0 is 69,300. One commit, this session's: 0938157 (#41)
sorts a first char's operators longest first, so `+` is tried after `++` and `+=`,
about 230 instructions a failed try. The fix, in session scratch and not yet in the
checkout (this tree's tests read the checkout through a link): the dispatcher files
its operators by second char and a position tries only those that can be spelled
there. 42,400 (`subscript`), 56,400 (`justin`), 74,300 against 78,300 (`jessie`); the
same tree or the same error text as 10.8.4 on 1,200,000 generated strings over the three
entries and on 1,500 source files (the same generator finds 3,473 differences in 60,000
between 10.8.3 and 10.8.4); subscript's suite 380 passing; the bundles 96 to 105 bytes
larger minified. Over three more shapes (a comparison chain, strings, a program of
statements) no release from 10.7.3 to 10.8.3 costs more than the one before it (10.8.1
made strings a quarter cheaper), and the fix costs least of the seven on each: a
comparison chain 16,700 against 18,000 (`subscript`) and 31,800 against 37,800
(`jessie`), the program 245,500 against 253,000 to 283,000. Under Bun the three are
within the spread. Pushed to subscript's main on the owner's word the same day; jz's pin
stays 10.8.4.

**And compiled by jz the fixed parser is 70% slower: a fact lost far from the change.**
Over the fix 104 of the 105 bench cases compile to the same bytes; the 105th is `jessie`,
whose source it is: 77,435 -> 80,992 bytes at size, and at speed, alternated twice on
one machine, jz 1.30 ms over 10.8.4 (V8 2.3 to 3.1) and 2.12 to 2.25 ms over the fix
(V8 1.8 to 2.0): from ahead of V8 to 1.15 behind, the checksums equal. The profile puts
it in a function whose source did not change, the comment reader (`parse.space` of
`feature/comment.js`): 2.5% of 1.24 ms before, 22% of 2.29 ms after; its loop
`for (s in cm = parse.comment)` was unrolled over the literal's two keys and now
enumerates at run time, allocating, at every token (`unrollForIn` asks the summary for
the source's keys and no longer gets them). Bisected over ten variants of the fix: the
trigger is building, in `dispatch`, a local array of arrays by computed-index stores;
not the read of it, the closures, the callbacks or the default parameters. A one-file
kernel of the same shapes does not show it. Not found yet: the fact and the rule that
drops it. With a writer (`brief-forin.md` in session scratch). jz takes the new
subscript after that.
## Phase 11 mapped before the reference run (2026-11-16)

For `.work/architecture.md`. All on land-d's tip e521f93b8 (a frozen copy, session scratch
`at-d`), measured beside the landing battery at four jobs: ratios, not times.

**The owner's rulings of the day.** No 1.0.4 and no patch line: the next release is 1.1.0,
complete, once the phases and the architecture are done. (v1.0.1 to v1.0.3 are 14 commits
on the tree of 2 November, 31b57232f; main is 616 commits past that fork and none of it is
released. The integrator first told the owner to publish main as 1.0.4, which would have
shipped all of it under a patch number, and took it back.)

**Where the wasm-rival gaps stand** (`bench.mjs --targets=jz,c-wasm,rust-wasm,zig-wasm,as
--paired=4`, jz's time over the best rival's, C-wasm each time): fabrik 3.00, polytri 1.90,
mapobj 1.39, mapint 1.35, threescene 1.15, gainclass 1.10; stdlib-gamma 0.96 and stdlib-pow
0.94 lead now (1.25 and 1.13 in the reference run of 2026-11-14).

**Where each case's time goes** (`benchprof.mjs`: V8's sampling profile of the module built
with names, main() repeated 1.5 s, self samples by wasm function):
- fabrik: 94% in `run` (the whole solver inlined), 5% `restoreSolution`.
- polytri: `diagonalie` 58%, `triangulatePolygon2` 24%; the dynamic store helpers under 2%.
- mapobj: `plan` 32%, `__map_find` 16%, `__map_get_ob` 10%, the compaction (`__gc_*`) 26%.
- mapint: `__map_find` 50%, `analyze` 22%, `__map_get_ob` 12%, the compaction 9%.
- threescene: 99% in `run`. gainclass: `Gain.process` 85%, `__alloc_hdr_n` 11%.

**The classes found.**
- A. *An indexed store into a plain array at an index not proven below its length* takes
  the fully dynamic write (`deopt-dyn-write`, key conversion and hash store inlined, the
  loop in four versions, a call of `__arr_set_idx_ptr` each iteration): `buf[i] = v` for
  `i < n` 5.5 of V8's time, through a parameter 3.7, six stores a bone (pmath's
  saveSolution) 5.25, where bounded by `.length` it is 0.96 and on a Float64Array 0.89;
  24,831 bytes where the `.length` form is 294 (`dwtime.mjs`, `dynwrite*.mjs`). In fabrik
  (fabrik3.js:631-636), polytri (`out[...]`), stdlib-gamma (`IQ[...]`), stdlib-special,
  stdlib-dists, movavg, decode-qoa. Handed back the same day (above).
- B. *ToInt32 of an element of a plain array of integers*: `vertices[(indices[s] & MASK) *
  2]` converts each f64 element by the general form (12 instructions and a branch), twice
  for one element (the copy `inf66 = inf54` hides it from the reuse), in polytri's
  `diagonalie`. The kernel (`toint.mjs`): 1.15 to 1.20 of V8's time whether the integers
  pass 2^31 or stay under 2^30, 0.80 with a Uint32Array. The fact missing: every store
  into the array is an integer of bounded magnitude (then the conversion is a truncation
  and a wrap). With the array store's writer, after its rebase.
- C. *A Map's find by a key of known kind*, and the compaction's share: `__map_find` (the
  find of a statement that reads then stores) is generic where get, has and set have forms
  by key kind, and `has` then `get`, `get` then `set` probe twice for one key: a find as
  a read the numbering of phase 7 can reuse until a write to the Map. With the reset's
  writer.
- D. *Property reads without a static slot.* The scout's map is session scratch
  `p11/props.md` (Sonnet 5.5; 60 kernels under `p11/k/`, each run): the reasons are `hash`
  (an empty `{}` filled by stores, or a spread of an open source: decode-wav's `hdr`,
  stdlib-dists, jessie; about 50 instructions a read), `dynamic` (slots differ across a
  join: pcmconvert; one slot, two carriers: decode-dsd; a nullable holder or a conditional
  key: decode-wav), `guard` (one layout lacks the key), `sidecar` (an array with more than
  four named properties, a function's properties). The advisory count misleads both ways:
  at speed a `dynamic` read becomes a table of slot loads after the advisory fired
  (`devirtSchemaReads`), advisories fire for bodies later inlined, and an array of records
  calls `__dyn_get_t_h` with no advisory. So the measure for this class is the helper
  calls left in the WAT of the functions the profile names, not the advisories.
- The census of advisories itself (`whycensus.mjs`): 85 of 106 cases have none; fabrik 16,
  polytri 8, stdlib-gamma 16, stdlib-special 32, stdlib-dists 107, decode-wav 22,
  decode-dsd 18, pcmconvert 15, jsontransform 17, async 12, jessie 21, the four three.js
  cases 174 to 350, watr 247, webaudio 886; the self-compile case ran the census's child
  out of memory (a warnings callback on that program: not looked into).

**The owner's bar, said again (2026-11-16): "it should be generic and best in class
optimizer."** What that changes in how phase 11 is run. The loops became general under a
gate that compared spellings (`test/spellings.js`: 358 cells of 470 short at first, 42
now); the classes above were found one bench case at a time, and would be fixed one
bench case at a time. So the data gets its gate: the same work over the same data held
in every form a programmer holds it (a sequence typed, pushed, filled by index, made by
`map`; a record literal, a class instance, `{}` then stores, one of two literals; a Map
by integer, string or object keys, an object as a dictionary), each form listed with its
shortfall from the best, the listing only shrinking (`brief-gate.md` in session
scratch). Its table orders the classes by the cells a general fix closes. "Best in
class" stays what the reference run and the held-out lane say, the rivals at their
current releases.

The landing's battery: on e521f93b8, one leg at a time, two writers' suites beside it for most of it: `lint:imports` and `audit:files` clean; the examples 1.67× V8 by geomean against land-c's two runs (1.73× in the second run alone), jz ahead on 25 of 25, one page moved past 5% (fern, 7.6% faster); bench bytes by hash 51 of 105 moved against land-c's and no errors (two bytes in the 48 cases that declare the shift's bound, with 7b, 7c and the counted copy); the invariants leg (level 3, the facts guard on) 7,291; core 7,492; `test:bootstrap -- --full`, its five parts (the hosted suite 119 minutes; the hosted build 37,282,113 bytes by two writers' builds of this tip); level 0 7,275; level 3 7,289; wasi 7,364; generated 245; the integration suite 229 (1 skipped), 76, 76 and 79 at the default, level 0, level 3 and wasi; test262 4,120 and 0 failing; the core suite in one process 7,492. All passing. Eight hours. After the battery, on the same tree: the self-compile job's limit (the workflow file alone), this record, and the briefs' deletion, which re-points two tests' comments (those two files run again, 22 tests passing).

## The land-e landing: array stores, the reset's last part, lifts over plain arrays, the late hoist (2026-11-17)

49 commits on 92d14e2ba, tip `4157cd976`.

### What landed

- **The reset, C and D** (`d6e2ddad6`; `78d702b54`, `92efd1169`, `fd9911654`, `8a4fe07dc`), as land-d recorded them: a table made at start is saved whole before a round's first write.
- **The hang fix** (`62ff8a67a`, `74901a0d8`). D's mask save linked a record in the running frame without lowering the escape flag; a rewind freed it and `$__survive` walked a cycle for ever. Every path that links a durable record now lowers the flag or stands behind a census site, and the mask is saved only where a store gives a deleted field back.
- **Array stores, class A** (`cfd0d3b9f`, `10dbbbb31`, `6b0fc0598`, `443c9fd47`, `7ec5ca455`, `e85712190`, `287cd61d1`, `102c1afbd`, `c0612612a`): a store under a Number is inline inside the length and calls `__arr_set_num` past it; a counter or cursor stepped through stores is a proven element index; a counted loop splits at its arrays' ends. An index in [2^31, 2^32-2] past every length throws.
- **Element facts, class B** (`cbec6fb3d`, `4050e8517`, `4a22bc2a8`): the summary bounds an array's Numbers and proves it free of holes from every store, so ToInt32 of an element is a truncation; counters closing from both ends and copied cursors keep their index proofs.
- **Map finds** (`ad1fc6d1d`, `3ea262069`, `89421b585`, `97d520a45`): tables a quarter full at speed; a statement that reads then stores a key finds and inserts by the key's form.
- **The vectorizer** (`924660154`, `08e4d9647`, `757919f19`, `9ffcc2c6c`, `e57ff2893`, `231e35dce`, `7de74b797`, `365463696`, `b10ef60cc`, `51f37a352`): reductions over plain arrays, and in the exact tier over an array holding records of 2 to 8 fields in a row; an address teed once read as its value; a Float32Array compared with a double as JavaScript does; advisories only where no copy lifted, with the cause.
- **The late hoist** (`3b149f861`, `5a5f3d55a`): invariant arithmetic leaves every loop without vector code, outermost included, last among the loop passes, only where it saves work a round.
- **The for-in fact** (`381e07647`): the init-order walk names the callee of a builtin call made during initialization where it took every function made so far as run. Pinned by no test: the rule that a walk of a builtin sequence runs nothing.
- **The data-form gate** (`a29ec8d31`; listings `a47c99e0b`, `0cd788b79`): 744 cells, each form held to the best form's code, the listing only shrinking.
- **The self-compile job split** (`fde6cd535`): `bootstrap` and four `hosted` slices. Not yet run on CI.
- **`149a0e47a`, the integrator's**: an unsigned i32 compare is decided where a side's sign is known; a never-run arm of `L[3e9] = 5` had failed 10 invariant tests.
- **Found on the way**: `f76d64c7c` rolls an unrolled float sum only under relaxedFloat (`656168edb`, 18,560 checks); `64a4684b8` leaves the escape log full after every compaction move; `e562a359a` and `5007613df` rewrite the last stub of a chain below the floor, a regression of `78d702b54` ([16,16] for [16,7] after a compaction and a reset).

### Wrong answers fixed here that v1.0.3 has

- A dot unrolled by five by hand over fractional Float64Array data, `optimize: true`: 23393190.000000015 for Node's 23393189.999999966.
- A loop pushing a 400,000-element Float64Array into a module array, an export that allocates, one that reads: 1,2,11 for 1,2,3 at the default level and speed.
- An object used as a dictionary across `memory.reset()`: `D.list = ['z']` in a round, then every call threw.

Also wrong on main, v1.0.3 not checked: an own `push` set during initialization; a Float32Array comparison at speed; a Map's and a Set's table across a reset.

### What is measured

- Gates on `0cd788b79`: data-forms 653 of 744 short (666 on main and `a47c99e0b`; against it 27 closed, 356 smaller, 35 larger, 14 new); vector-coverage 417 of 840 marks; the perf ratchet's buf 30,083 to 30,475 loop-body ops by `5007613df`.
- The integrator's probes on `0cd788b79` match Node but for the README's allowances; reset 344 of 344.
- Time ratios on the M4: stdlib-ddot at jz-exact over rust-wasm 2.355 to 0.780; mat4 likewise 1.177 to 1.008, rust's arithmetic exactly (x64 open); bezfit 0.797 of strict C-wasm and 1.128 of c-wasm-fast (1.42 before), its checksum reading no fitted value; mapint over C-wasm 1.39 to 1.05, mapobj 1.46 to 1.26; polytri 1.91 to about 1.80 of C-wasm; fabrik 2.182.
- Decoders on `0cd788b79` at speed, over V8 / over bun: QOA 1.255 / 0.61, TTA 0.92 to 0.94 / 1.015, ALAC 1.07 to 1.13 / 1.605.
- Class B makes the hosted self-build 14 to 15% slower; the cut is queued.
- The landing check, on `5007613df`: lint and the file audit clean; bench bytes of 105 cases, 96 moved against land-d, no error; invariants 7,329; default 7,531; level 0 7,312 and 1 failing (test/summary.js:779, a test outdated by `4050e8517`, restated as `4157cd976`); level 3 7,327; wasi 7,402; generated 282; integration 229, 76, 76, 79; test262 4,120 and 0 failing; one process 7,531 (2 h 38 min). On `4157cd976`: `summary` under four legs, level 0 whole 7,313, `test:self` 89, the examples 1.72× and 1.68× of V8 in two runs, 24 and 25 of 25 ahead (rfft 0.91 then 1.03, a 9 µs kernel); against land-d no example's lead moved past the noise (ulam, the largest, 1.014 by twelve alternated rounds, six each way; its speed build 13,250 to 14,116 bytes). Not run on this tip: the hosted suite, 2 h 15 min on land-d, left to CI's split job, which this push runs for the first time. The check ran 13 legs in a row and was cut after six hours on the owner's rule that nothing runs over an hour.

### Known wrong on this tree, landed knowingly

- **A filled array's mark** (found by the audit, brought by `4050e8517`; main and v1.0.3 are right): a holed `new Array(3)` and an array a covering loop fills, read through one function, answer 0 holes at `optimize: false` and `'size'` for Node's 300: the mark was keyed by the cell's root and cleared the hole from the joined cell. And at `optimize: false` a covering loop whose value reads the array it fills (`x[i] = x[n-1-i] === undefined ? 1 : 2`) answers 8 for 6. No test of this tree catches either. Fix `af1632b60` on the holders' branch (the mark a fact of the construction, the count a meet folded in `unify`), with pins; it does not apply here alone (four conflicts against class B's second part) and comes first in the next tree.
- Older than the tree, wrong at the default level and speed: an object stored into a module array of constants is freed (v1.0.3, main; fix `55d314139`); an array made at start, grown, then shifted never returns (main; fix `0be6b2a38`); one that takes named properties and grows reads them empty (main; fix `3c53a2649`).
- A function that is exported and also called inside the program with a string (`f('10')` where `f = (n) => { ... i + 1 < n ... }`) reads the string as NaN: the export rule holds the parameter as f64 and the internal call passes the value as it is. Every level, v1.0.3 and main too. Fix assigned (B2 below).
- An exported `(a, b) => a < b` called by the host with "a", "b" answers 0 at every level, in v1.0.3 too: the README's "Numeric export parameters" contract, which names `+` and not the comparison. Ruled to stay; the README gains the clause.
- Symbol.toPrimitive is never called by an operator. Level 0's `+` over a typed array's NaN canonicalizes it; `DataView.getFloat64` returns the canonical NaN. No README note covers these.

### Queued for the next tree

- **Compaction** (`worktree-agent-a1be0465fdf269fbe`, on `5007613df`): `0be6b2a38` fix 4, `55d314139` fix 1, `3c53a2649` fix 5, `3d9441213` the stress switch, `4486e611b` 1a, `d9ca06fcb` 1c (built otherwise than approved), `aaba55d1c`, `a9c46d439` the stress form, `f018467d9` rule 2, `2d03ca18c` rule 3, `3ebce5115`, `c5f050dec`. decode-wav after 1a and 1c 631 to 450 µs.
- **Hoist writer** (on `5007613df`): `d3dbb840c` constants read through a temporary, `b95894aeb`, `a122712e5`. Held: `145ae6ac6` (identity folds) until decode-alac's 1.064 is retimed; `8151718b2` (sink-loads, off) stays on the branch, no threshold measured.
- **Class B** (on `435bdbac7`): `edc4393d7` the compile-time cut, `64ad2a709` the split past the growth budget (fabrik 1.286 to 1.062 of C-wasm), `0be322a08`, `0bb747dc8`, `e40ffa0ac`. Held: the split on a receiver that may be missing.
- **Relaxed floats writer** (`kinds-ada0`): `435bdbac7`, a nullable array keeps its cell (QOA 0.782 of land-e's build); `cbed52d9b`, no version on a bound no fact gives (ALAC 0.912 of V8). Held for parity: lane sums `099c77415` (`decoders-ada0`).
- **Holders** (`worktree-agent-a417d57c6f092b160`, on `e40ffa0ac`): `6f2f50491`, a statement list ends at a statement that reads through a receiver only missing (mapint, mapobj, webaudio smaller); `af1632b60`, the filled array's mark. Next: the split on a receiver that may be missing, `this`, a field, a closure. **`rulings`**: `2df97ce3d`, the tie band.

### The owner's rulings of 2026-11-17

- "Let's get everything done into the best shape. [...] we need faster iterations. [...] it should be embeddable and able to live-compile. So finish your phases work and find out what other work or refactoring is needed to land brilliant v1.1.0". Turns into the audit `jz-110-audit` (`audit/plan-1.1.0.md`).
- "Parity at speed - tolerance is allowed, but 26% is too much. Ties - ok, 5-8% can be said ties. [...]" The 26% was nbody's time saved by lane sums, read as a deviation (measured: at most 1,303 ulp, relative 1.66e-13). Turns into: nbody's ports to the near hash; `WASM_BAND_TOL` 1.05 to 1.08; per-case twists in one layer with stated conditions.
- "We should not have tests that run 9h, anything above 1h is something wrong on our side." Turns into the battery's cut; target: the landing check under an hour.
- "we don't have to rerun the bench for contenders if we already have it - record fixed by contender version, platform it ran with." Owed: rival timings keyed by version, flags, case source and CPU.
- Sent to the relaxed floats' writer: A2 (the export contract stays, the README gains the comparison), B2 (no f64 parameter where an internal caller may pass a non-Number), Symbol.toPrimitive built or named.

### Dropped or ruled out

- Read-only parameter views: a second cell model, until a data-form row measures the class.
- F7, a constant divisor's reciprocal: no gain (munsell 0.998), eight cases lose parity.
- The rival's other float folds: unbounded in ulp, or wrong on inf, NaN or underflow.
- The scout's three repeat leads: no gain on the M4.
- stdlib-ddot's guards change: its running loop has no bounds test now.
- polytri's count chain: 0.965 for 150 to 250 lines.
- ALAC's design (B): the specializer already assumes integers.
- Float32Array as a data form: no static bar for a 2-lane loop.

## The land-g landing: the filled array's mark, three compaction fixes, the nullable array, the second part of the element facts, the tie band (2026-11-17)

20 commits on d58dde69e, tip `3ca2082ab`.

### What landed

- **The filled array's mark** (`6ce826703`): land-e's known wrong answer. "Filled" is a fact of the construction (`filledSites`), the count alias a meet folded in `unify`; a covering loop's stored value may not read the array or the count.
- **Three compaction fixes** (`1e40e02db`, `75ec8f92a`, `4a815d311`): a shifted array's base record is a stub and its own handle; the static data's blocks are walked for the pointers they hold; a shifted array's mark is both its words.
- **A nullable array keeps its cell** (`20500d4b7`); **no loop version on a bound no fact gives** (`d8cf58f58`).
- **The element facts, second part** (`62c739470`, `069c1e638`, `c22a0f9ce`, `cf40c6bd9`, `24125bd05`): the deferral of element numbers turns strict when the intervals settle (the compile-time cut); a kernel loop of a function past its growth budget splits; `x != null` proves present on its arm; a module `let` is saved for the reset ahead of a loop nothing in which rebinds it; a split loop's main counter is bounded by every length its bound is the least of.
- **The throw rule** (`03f2ec294`): a statement list ends at a statement that reads through a receiver only missing.
- **Constants read through a temporary** (`82d1e0216`, `56b65c9a9`).
- **The tie band** (`2e26b7e00`): a case within 8% of the best rival passes the claims gate, printed as a target.
- **The wild store** (`2f7a2c54c`): what computed-key stores through a lost shape put is published by reference (`wildStore`), not as first values.
- **`93a515485`, the integrator's**: no loop is bounded by the length of an array its body rebinds. `24125bd05` had kept that filter on the alias arm only; the tree's first check caught it (test/closures.js, 0 for "TypeError:1"), and written without a closure it was wrong at every level (1 for 101). Found by bisecting the tree's 17 commits; the writer's own branch failed the same test.
- Listings rewritten on the assembled tree (`12aec1f5c`); the hoist population's NaN payload row held to jz at level 0, not to Node (`39a68420f`: Node 24 on x64 answers the canonical NaN, Node 25 on arm64 keeps the payload; main's CI was red on it).

### Wrong answers fixed here that v1.0.3 has

- An object stored into a module array of constants was freed by a compaction.
- `o.y + 1` after a computed-key store through an escaped receiver (`put(o, 'y', 'a')`): NaN for "a1" at false, true and size.

On main and not checked on v1.0.3: an array made at start, grown, then shifted never returned; one that takes named properties and grows read them empty; the filled array's mark (land-e's own).

### What is measured

- Bench bytes against main: size total -1.00%, speed -1.10%; up base64 speed +11.8%, blur +9.3%, conv2d and fabrik +2.3% (split loops; base64's and blur's times on the split are not measured); down mapint -10.1%, mapobj -8.5%, jessie -7.0%, decode-qoa -5.4%, webaudio size -3.9%.
- Gates on `12aec1f5c`: data-forms 653 of 744 short; the perf ratchet's entered counts 2,034 to 1,986 and 4,001 to 3,992, buf's total +116.
- The integrator's probes: filled 0 of 36 rows differ (main 4); the compaction's findings as Node in all 11 files; hoist rows 0 of 232; lift rows 1 (a zero's sign at speed, allowed); element rows 12 of 384 (the forms past 2^31, as before); the reset probe 344 of 344; on the tip, the rebinding programs 128, 408 and 300 rows, none differing; the wild store's row as Node at four levels.
- The check, first run on `39a68420f` (stopped at its failure): default 7,551 of 7,552. On `3ca2082ab`: lint and the file audit clean; bench bytes of 105 cases, no error, none differing from `39a68420f`; level 0 7,336; `test:self` 89; the armed level 3 7,351 of 7,352 and default 7,553 of 7,554, the one failing in both `async: bare fetch binds from the JS host`, a 5 s limit the test's compile alone uses up at load 45 to 85 (standalone at the armed level 3: compile 4,792 ms, run 132 ms, the right answer; at the default level 3,137 ms and 47 ms; main the same). The check took 129 minutes on a machine other sessions and seven workflows shared. The examples' timing ran at load 53 to 85 and says nothing (1.73 and 1.48 of V8, other examples below 1 in each run: percolation 0.69 then 1.01, rfft 1.64 then 0.13, zzfx 2.79 then 0.45). Every example's bytes move (the compaction's kernel), most by under 0.2%; dla -10.6%, nbody -17.1%, sandpile -17.5%, watercolor -5.8%. percolation, the one lower in both runs than main's, timed against main's build in alternated rounds in one process: 0.963, 5 of 12 rounds above 1. CI's examples-perf on three targets is the measure of this landing's examples.
- On x64 (five runs of bench-probe.yml on Xeon 6975P-C, main beside 92d14e2ba): of 24 cases probed, land-e moved callback 2.24 (slower) and polytri 1.059; mapobj 0.786, mapint 0.869, fabrik 0.912 (faster); the rest within 2%.

### Known wrong on this tree, landed knowingly

- **callback on x64** (land-e's): an integer element's word is read as `i32.trunc_sat_f64_s` of the load, a form the level's rule (`wordTruncation`) does not choose and V8 lowers through a round, a convert, a convert back and a compare; 636 us for 286 on the Xeon, nothing on the M4. In work (`jz-words`).
- **A NaN's bits make a box** (v1.0.3 too, every level): a Float64Array or Float32Array element whose bits are a box's, read at an index that may miss and kept in an object literal's field or through `??`, is taken for undefined, null, a boolean, an array or a string. In work (`jz-nanbox`).
- **`optimize: false` never releases a call that returns a heap value** (v1.0.3 too): 1 page to 256 in 20,000 calls of `s => s.toUpperCase()`; the README's "Memory is freed by scope" names no level.
- As before: a closure in a parameter default flips a loop's flag; a test of `Object.getOwnPropertyDescriptor`'s result crashes the compiler; an internal call passes a string to a parameter the export rule made a number; `Symbol.toPrimitive` is never called; a 500-case switch, a 500-arm else-if chain and a sum of 800 terms overflow the compiler's stack; the parser's time doubles with each level of nested calls.

### The owner's rulings of the evening

- "yes", after two questions were open: read as the answer to the later one, that the bench times every engine lane after the engine's tiers settle, sources unchanged, the first pass recorded beside it (fabrik on the Xeon: 54 us as timed, 29 with V8's baseline tier off, C's wasm 26). In work (`jz-settle`). The earlier question, pushing probe branches to time a change on x64 before it lands, stays unanswered: no branch is pushed.

### Queued for the next tree

- The holders' `18c52e9fe` (a receiver that may be missing joins the split), `dc8898829` (the gate's measure), `7306b6dec` (a covering loop the split rewrote); the compaction's rules; the relaxed floats' writer's comparisons and B2; wave 0 (the parameter default, the descriptor, the compile's leftovers, the limits, toPrimitive, the hosted compiler's helper dependencies, the parser); the test-time chain; W1, W2 and the harness as they hand back.

## The land-h landing: plasma's lift back (2026-11-17, the evening)

One commit on 85e229c76, `39186ffed`.

- **What land-g broke.** `d8cf58f58` (no loop version on a hull no fact bounds) marks a hull by walking the body again with no carrier's range and no word operator's over an unknown value. examples/plasma indexes a table of 256 by `(u * 255.0) | 0` clamped by two `if`s: the second walk has nothing for the tests to refine, the hull [0, 255] opens there, and the nest lost its version and the lift behind it: 585 f64x2 and 61 `$math.sin2` to none, the build 1.54 times slower (twelve alternated rounds on the M4; 1.47 on CI's Linux arm64, 1.22 on its macOS).
- **How it was found.** By CI's integration suite on 85e229c76 (test/examples.js "plasma vectorizes", red in every leg), after the landing: the local check ran no integration suite, and the integrator read CI's examples run as clean (the comparison took the log's first time column for jz's; it is JS's). The landing check runs the integration suite now.
- **The repair.** The veto holds only where the marked hull's top is at least 2^26 elements (loop-versioning-nest.js NO_REAL_LENGTH). Every candidate the mark drops on 85e229c76 over the 70 gallery examples and the 105 bench cases at speed: plasma 0..255, dla 0..254 and wireworld 0..4 return; all the others top at 2^27 - 1 or more and stay dropped, decode-alac's gain with them. The bench corpus is byte-identical to 85e229c76. The size is a stand-in: what decides is where a bound comes from. The rule's writer left the form (the second walk keeps the range with each end tagged unfounded, a test's arm founds the end it bounds, a join keeps an end founded only if every arm does); to brief.
- **The check on `39186ffed`** (178 minutes at load 40 to 80): lint and the file audit clean; bench bytes of 105 cases identical; `test:self` 89; level 0 7,337; default 7,554 of 7,555 and the armed level 3 7,352 of 7,353, the one failing in both the fetch test's 5 s limit (its program alone at each level: right, 35 to 40 ms, the compile 6.5 to 7 s at this load); integration 228 of 230, one skipped, the one failing `web-smoke`: its dist build and then its driver's two speed compiles of the hero grid overran its 120 s limits (alone the build passes and the driver is killed in the grid's compile, 49 to 69 s a compile at this load; the grid's bytes are 85e229c76's, 135,186). The examples' tests pass, "plasma vectorizes" among them (39 of 40 with web-smoke alone). The pin (test/interval-proof.js, plasma's shape) fails against 85e229c76's compiler at "0 f64x2".

## The land-i landing: the split over a receiver that may be missing, the exported parameter kept, BigInt comparisons, the compaction's rules, a read asked by its own node (2026-11-18)

20 commits on 7ec77254c, tip `3592bf8dd`.

### What landed

- **The holders' three** (`809e342e4`, `b89506283`, `be5777019`): a loop over an array a binding may hold missing is split under a test of each such receiver; the perf gate counts a loop only where it runs a step; `Array(n)` filled by a counter is hole-free at levels 2 and 3 as below (the summary reads the covering loop as the array split left it).
- **A counter tested with an offset** (`a3a164b9a`): `i + c < B`, `c + i <= B`, `i - c >= B` counting down are versioned on the bound the test states; 60 more vector marks; a three-point stencil under a bound read from data 2.41 times faster on the M4 (eight paired rounds).
- **An exported parameter stays as the program's own calls pass it** (`0fb954d28`, B2): the export rule made it a Number for every caller, so an internal call with a string, undefined, null or a boolean read it wrongly. The summary keeps the internal callers' kinds beside the host's (`internalIncoming`).
- **A BigInt compared with a string or a Number** (`6eda696f5`): a string through StringToBigInt (`-1n < '1e1'` was true), a Number exactly (`10n < 2.5` was true).
- **The compaction's rules** (`30989e452` to `2d8ba71cb`, eleven commits): no walk on the round a loop leaves; a loop's first walk is one that drops what it makes; the visited bits cleared over what a walk reached, not the heap's span; the host's walk asked as soon as the calls since its last look may have passed the threshold; a loop site's window carried across its entries. A stress form (`JZ_DEBUG_COMPACT=1`, a word of slack) runs the files that move memory in the generated suite, cut to 4.5 minutes.
- **`669dadbe8`, the integrator's**: the value type of an indexed read is asked of the read's own node. VT['[]'] (src/kind/val-type-of.js) asked the summary about a copy of the read, which the presence facts (keyed by node) do not know; an array that holds a number-named property then had no value type on any read. A store under a counter no span bounds raises one (`a[i] = v` under `i < n`, n a parameter), so `Array(n)` filled by a counter was typed only through its hole, and `be5777019`, taking the hole away at levels 2 and 3, sent each read of the split's main loop through a self-compare and `__to_num` and lost the vector loop. Found by the tree's first check (test/minimal-output.js "numeric Array(n) (arithmetic fill) skips ToNumber/string" at level 2, the default leg) and by scanning the tree's commits. The fix also closes seven cells of the data-form gate, all of an array literal read through a closure (`gather` from 27 calls and 1,028 operators over the best form to the best form).
- Listings rewritten on the assembled tree (`a0ef2262d`) and after the fix (`3592bf8dd`): data-forms 640 of 744 short (main 653), spellings 42 of 470, vector marks 453 of 840 (main 393), the reset probe 344 of 344.

### Wrong answers fixed here

On main, not checked on v1.0.3:

- `export let f = x => ...` also called inside the program with a string, undefined, null or a boolean: `f('10')` 0 for 9, `f('2')` NaN for "21".
- `-1n < '1e1'`, `10n < '1e1'`, `1n < true`, `10n < 2.5`: true for false.

24 rows of the integrator's probe as Node at four levels; 16 of them differ on main.

### What is measured

- Bench bytes against main: size total +0.02% (9 cases; stdlib-special +414, `$__str_to_bigint` comes in), speed total +0.48% (94 cases: +88 bytes in 51 of them, the compaction's kernel; sosfilter -11.4%; webaudio +7,204, 4,979 of it two closure bodies equal but for their locals' names that are no longer one text). The fix alone: webaudio's size build -23 bytes, the other 104 cases identical.
- The integrator's probes on the tip: the rebinding programs 128, 408 and 300 rows, none differing; 19 programs that store under negative, fractional and unknown keys and read in and past the range, six levels, 912 rows, none differing (on main and on the tree before the fix as well); plasma 585 f64x2 and 61 sin2; the review script line for line as on land-g (a zero's sign at speed, the forms past 2^31, the export contract's comparison).
- The first check, on `a0ef2262d` (163 minutes at load 72 to 155): default 7,562 of 7,563, the kernel above; the armed level 3 7,360 of 7,361 (the fetch test's 5 s limit); integration 228 of 230 (web-smoke at that load).
- The check on `3592bf8dd` (92 minutes at load 100 to 184): lint and the file audit clean; bench bytes of 105 cases, no error; `test:self` 89; default 7,563 of 7,563; the armed level 3 7,361 of 7,361; level 0 7,345 of 7,345; integration 229 of 230, one skipped, none failing; the examples 1.79 and 1.63 of V8 at that load (noise: blackhole 0.99 then above 1, percolation 0.90 in the second).

### What the first check taught

- A writer runs the files it touches. test/minimal-output.js skips under a set level, so the two levelled legs do not run it, and the writer's files did not include it: a fact taken away in the summary changed a kernel's loops in a file nobody ran before the default leg did.
- The integrator's probes compare answers with Node. None reads a kernel's loop shape, and the answer here was right at every level.

### Known wrong on this tree, landed knowingly

- A store under a counter below the array's own count still raises a number-named property: the count's range after `Array(n)` returns, [0, 2^32 - 1], is no fact of the intervals. The read is typed now; the store's fact is a rule for the intervals.
- `a3a164b9a`'s message names a defect of level 0 it met (a number compared with a string or an object, in a function the program calls with a string): whether `0fb954d28` closes it is not checked.
- As on land-g: an integer element's word on x64 (land-e's callback); a NaN's bits read as a box (v1.0.3 too); `optimize: false` never releases a call that returns a heap value; a closure in a parameter default; `Object.getOwnPropertyDescriptor`'s result tested; `Symbol.toPrimitive` never called; a 500-case switch, a 500-arm else-if chain and a sum of 800 terms overflow the compiler's stack; the parser's time doubling with nested calls; `%TypedArray%.of` refused.
- **CI's default test job takes 3.5 to 4.2 hours on each of the last four commits** (85e229c76 3 h 28, d58dde69e 4 h 10, 92d14e2ba 3 h 45, 9d0bf1ec2 3 h 38; on 7ec77254c still running after 4 h): over the owner's one-hour rule. The test-time chain is the remedy and has not landed.

### Handed back and waiting for the next tree

- **The bench after the tiers settle** (`worktree-wf_4473d3a7-3a9-1`, nine commits on 3ca2082ab, tip `9fccec9ad`): a program's pass repeats in one process until 300 ms have passed, the pass after is counted, the first recorded beside it. Six cases' `main` carries state between calls (fabrik, jsontransform, setops, stringify, threegeom, threescene): their JS lanes run once and jz meets them first pass to first pass, so fabrik against C's wasm settles and fabrik against V8 does not. MoonBit's lane moves from moonrun to Node's V8. The README's method sentence waits for the first dataset measured by the rule. No CI run of it yet.

## The land-j landing: the bench timed after the tiers settle, a word read off memory by the level's rule, two wrong answers of v1.0.3 (2026-11-18)

18 commits on 7125c4739, tip `97fa559ee`.

### What landed

- **The bench after the tiers settle** (`c3ac25e71` to `d4b1ca84c`, nine commits; the owner's ruling of 2026-11-17). A program's pass repeats in one process until 300 ms have passed since the first began; the pass after is counted, the first recorded beside it (`firstUs`); a first pass of 2.4 s or more counts as it is (bench/_lib/passes.js, one helper for every engine lane, stringified into the shells). A time and not "twice": fabrik's module settles at pass 6 or 7, 14 to 17 ms in. A wasm lane's pass is a fresh instance of one compiled module, a JS lane's another call of `main`. bench.mjs holds the lines to the count the rule prints, and every pass to the first's checksum.
  - **Six cases' `main` carries state between calls** (fabrik a step; jsontransform, setops, stringify, threegeom, threescene a seed), read off the source by two calls under `node --jitless`. Their JS lanes run once (`settled: false`) and jz meets them first pass to first pass (`pairedUs`: the gate, the paired verdict, the page, the README table, the chart and the ledger). So fabrik against C's wasm settles (1.96 to 2.81 down to 1.07 to 1.37 on the M4 at load) and fabrik against V8 stays a cold comparison. The other way, a `main` that starts from the same state in every port, changes bench sources: the owner's.
  - **MoonBit's lane runs in Node's V8**, with moonrun's three imports: moonrun runs a module once. On callback 479 to 504 us for 627 to 685, its memory 51.9 MB for 14.2. The writer's choice, the owner's to keep.
  - Memory is a first-pass process beside every counted run. `--passes=first` is the protocol before; `meta.passes` names a dataset's, and `--merge` refuses to mix two.
  - README.md's method paragraph is unchanged: its figures are first-pass figures (bench/results.json, 2026-09-30) until a reference run by the rule is committed, and the sentence goes in with that data.
  - Not verified: no CI run of the rule; the cost is a model the reviewer measured 1.7 times low per case (the reference run 17.5 h of compute to about 20.6, the push gate's 155 minutes about +9).
- **A word read off memory by the level's rule** (`71f2f063b` to `395b88e48`, six commits): land-e's callback on x64. A conversion to a word fed by a load is the 64-bit truncation's low word at levels 0, 1, 2 and size; at speed the bare sum for an integer (one add of 1.5 * 2^52 and a move, no conversion), the sum over a rounding for a bound fraction, and the 64-bit truncation kept for an element that may be missing and is no integer. A gate over a population holds it (test/elem-population.js: 32 programs at five levels, by forbidden forms and by Node; 207 forbidden forms on land-g). bench/lowering.mjs has a third column, `loaded`.
- **`f4cc6b664`, the integrator's**: a module literal's element is folded into a read only where its names hold from the literal on. `let A = [1, 2, 3]; const O = { a: A }` then `A = [7, 8]` read `O.a` as the second array, at every level (plan/literals.js foldStaticConstAggregates copies each element's expression into each read; nothing asked whether its names are written).
- **`817fcbbd4`, the integrator's**: a shared in-bounds read's temp is present only where the element is. `A[s] | 0` then `A[s] ?? 1` over an array with holes summed NaN at level 2 and above (compile/cse-load.js shares the load; analyze-for-emit.js marked the temp of a read proven inside the length as never undefined or null, a rule of 2026-09-25 meant for typed arrays).
- The data-form listing rewritten on the assembled tree (`97fa559ee`): 640 short of 744 as before, 102 cells smaller and 38 larger (the `mask` kernel at speed, +11 operators each: the word's form), no vector loop lost.

### Wrong answers fixed here that v1.0.3 has

- A module-level object or array literal whose element names a binding the program writes later: every read through the literal took the binding's new value. A number, a string, an object, an array, a typed array, a function; `{ a: A }`, `[A]`, `{ a: A + 1 }`; a const or a let holder; every form of the write. 60 of 108 rows of the first probe differ on main and on v1.0.3 alike; 102 of 168 of the second on main.
- An element read twice in one statement list, the index proven inside the length, where the element may be a hole, deleted, or a stored undefined or null: the second reader skipped its test (NaN for 250537409; `R[s] == null` false for a null row). 56 of 168 rows differ on main at levels 2, 3, size and speed; the reviewer's program differs on v1.0.3.

Both found by the review of the word's branch, in its base.

### What is measured

- Bench bytes against main: 13 of 105 cases, +39 at size and +243 at speed in all (async +72, polytri +41, decode-qoa +33 at speed): the word's forms. The fold refuses no literal it took before over the 105 cases and the 69 gallery examples that compile (its first form refused `{ HIGH, LOW }` in six stdlib cases, where the index would have stopped being a known 0 or 1: the rule now lets a name written only before the literal, in its module, by no function). The hole fix un-marks one read in one case (fabrik `start[0]`, 8 bytes fewer).
- The word on the M4: callback 1.007 of its base (noise's edge), polytri 0.936 (20 rounds, none slower). On x64 nothing is timed: callback is expected at or under 286 us on the Xeon 6975P-C for main's 636; **polytri keeps 41 64-bit truncations of a load at speed, which bench/lowering.mjs's x64 column predicts slower** (4.13 ns for the 32-bit form's 1.56). The probe after this landing decides; the revert is one condition in int-narrow.js provenForm and one line in to-int32.js.
- The integrator's probes on the tip: the two fixes' three probes 108, 168 and 168 rows, none differing; the number-named properties 912; the rebinding programs 128, 408, 300; the export and BigInt rows 24; plasma 585 f64x2 and 61 sin2; the review script as on land-i.
- The check on `97fa559ee` (87 minutes at load 23 to 58): lint and the file audit clean; bench bytes of 105 cases, no error; `test:self` 89; default 7,589 of 7,589; the armed level 3 7,387 of 7,387; level 0 7,371 of 7,371; integration 238 of 239, one skipped; the examples 1.70 and 1.71 of V8, the second run naming cloth at 0.57 (its build is byte for byte main's, as swarm's, percolation's and blackhole's are: the load's).

### What land-i moved on x64

bench-probe 44268543353, Xeon Platinum 8573C, 7125c4739 beside 7ec77254c, five paired rounds:

- **decode-wav 0.292 of its time before** (775 us for 2,651), 0.306 of V8: the compaction's rules. It is named unmet against V8 (`CLAIM_UNMET`); on this runner it leads by 3.3. The name comes off when a reference run shows it on every CPU.
- jessie 0.981, tokenizer 0.924 (110 us); the other eleven within 1%.
- Against C's wasm there: mapint 1.119, mapobj 1.058, sosfilter 1.051.

CI on 7125c4739: examples-perf, test262, pages, self-compile (bootstrap and four slices), fuzz, test (opt0, opt3, wasi) green; the default test job running past three hours (on 7ec77254c it passed after 4 h 19); claims red as before.

### Known wrong on this tree, landed knowingly

- module/core.js reads a record's field of words by the 32-bit truncation at levels 0 and 1 (the gate lists it, `KNOWN_NARROW`, with a tripwire).
- polytri's elements are integers and the summary's hull does not say so (with it the tested sum has no rounding and runs at parity on the M4).
- From the embedding lane's review, on main too: `new Float64Array(aBigInt64Array)` copies bits where JavaScript throws; `Float64Array.from(BigInt64Array.from([1n]))` is NaN at three levels; a typed constructor held in a variable has no statics; `'a'.repeat(-1)` returns a string the host cannot read; an Error's `cause` is dropped.
- As on land-i: a NaN's bits read as a box; `optimize: false` never releases a call that returns a heap value; a closure in a parameter default; `Object.getOwnPropertyDescriptor`'s result tested; `Symbol.toPrimitive`; the three stack overflows of the compiler; the parser's nested calls; CI's default test job at 3.5 to 4.3 hours.

### Handed back and waiting for the next tree

- **The embedding lane's small ones** (`worktree-wf_757e86d3-74a-1`, seven commits on 85e229c76, tip `26ea299f6`): `%TypedArray%.of` as `from` of the list of its arguments (jzify); a literal's elements converted after the last is evaluated; a BigInt view's elements through ToBigInt; a throw while a module starts given to the host as an export's is (an init that can throw is `_initialize`); the fixed-memory proof without the init guard; import sites read off the parser (an import in the middle of a line). Its last commit the integrator's: a class's own name bound in its body, `new T.of()` left as written.

## The land-k landing: the embedding lane's small ones (2026-11-18)

Seven commits on e46e3705c, tip `3da3e688f`. No listing moves.

### What landed

- **`%TypedArray%.of`** (`c705f6734`; ECMA-262 23.2.2.2): jzify's typedCtorValues rewrites `T.of(args)` as `T.from([args])`, under the shadow test the `BYTES_PER_ELEMENT` fold beside it uses, so no later stage learns the name. Every kind, a spread, no arguments, effects in order, a fresh array a call, a module-level one. Not handled, refused as before: `of` as a value, `.of.call`, `?.of`, `['of']`; under the test-only `strict` option jzify is skipped and `of` stays refused.
- **A typed array's literal converts its elements after the last is evaluated** (`3474662e4`): `T.from([…])` and `new T([…])` converted each element as it was evaluated, so a `valueOf` ran before the later elements (aAbB for abAB). Held only where the program defines a `valueOf` or `toString` and an element before the last is not proven primitive.
- **A BigInt view's elements go through ToBigInt** (`7dee036db`): `of`, `from([…])`, `new T([…])` and the Array copy stored a Number's bits or a box's (`BigInt64Array.of(1)` 4607182418800017408 where JavaScript throws); `T.from` of a BigInt view routes by its source's kind (a Set, a string); a Number view holds its items where one may be a BigInt.
- **A throw while a module starts reaches the host as an export's does** (`95953170b`): an init that can throw is emitted as `_initialize` in place of a start section (optimize/watr-tail.js initThrows), so `jz()` and `instantiate()` throw the program's Error, string, number or object; 28 programs as Node, 21 of them `object {}` or `RuntimeError: unreachable` before. An export called first runs init through its guard. A module whose init cannot throw keeps its start section: over the 69 gallery examples and the 105 bench cases the 19 modules that export `_initialize` are the same as before.
- **The fixed-memory proof leaves the init guard out** (`95324756e`): the census of emitted code counted the guard's arm as the export's own work and refused `memory: { fixed: [...] }` with "process → $__start" for a WASI build and a host-reading init (on main already), then for a throwing init.
- **Import sites off the parser** (`70fd740ba`): src/resolve.js read them by a line-anchored pattern; an import in the middle of a line (a minified bundle) was missed. 219 graphs of the repo fingerprint the same.
- **`3da3e688f`, the integrator's**: a class's own name is bound in its body (a class expression named as a typed constructor had its `of` taken for the real one's, and its `BYTES_PER_ELEMENT` folded to 8 for its own 3 on main); a call that `new` constructs is left as written (`new Float64Array.of(1)` made an array where JavaScript throws). The branch's final review found both.

### What is measured

- Bench bytes: 0 of 105 cases move. The four listings as on main.
- The integrator's probes on the tip: `of` and the forms beside it 12 rows as Node at four levels; the class and `new` forms as intended; the earlier probes (912, 108, 168, 168, 24 rows) none differing; plasma 585 f64x2.
- The check on `3da3e688f` (108 minutes at load 20 to 35): lint and the file audit clean; bench bytes of 105 cases, no error; `test:self` 89; default 7,597 of 7,597; the armed level 3 7,395; level 0 7,379; integration 238 of 239, one skipped; the examples 1.69 and 1.66 of V8, the first run naming blackhole at 0.88 (its build byte for byte main's).

### What land-j moved on x64

Two runners, both AMD; the Xeon 6975P-C where land-e's callback lost is not measured yet.

- EPYC 7763 (44298567534, five rounds): callback 0.968, polytri 0.984, async 0.979, decode-qoa 0.951, each in every round; decode-tta 1.031, every round slower; nine others within 0.1%.
- EPYC 9V74 (44305778388, seven rounds): callback 0.961, polytri 0.975, decode-qoa 0.930; decode-tta 1.001.
- Against C's wasm on the 7763, by the pass rule: polytri 2.268, mapint 1.326, fabrik 1.276, stdlib-gamma 1.032.

### For an embedder

A module whose top level can throw has no start section: it exports `_initialize`, and every export runs it first if it has not run. A host that reads the module's memory before it calls any export calls `_initialize` itself. Under WASI a throw at start traps in wasmtime with no message (the owner's ABI decision).

### Known wrong on this tree, landed knowingly

- From this lane's reviews, on main before it too: `new Float64Array(aBigInt64Array)` copies bits; `Float64Array.from(BigInt64Array.from([1n]))` is NaN at three levels; a typed constructor held in a variable, an element or a parameter has no statics (a runtime TypeError); `'a'.repeat(-1)` returns a string the host cannot read; an Error's `cause` is dropped; `e.constructor` of a runtime-raised error is undefined; `T[Symbol.species]`, `Symbol.toStringTag` of a typed array.
- A module `let` written a fraction in a parameter default is held to a word (5 for 6; v1.0.3 too): fixed on `wave0-loops`, for the next tree but one.
- As on land-j.

### Handed back and waiting

- **The test-time chain's first four steps** (`tests-time`, eight commits, picked onto this tree as `land-l`): test/optimizer.js cut into 17 files; a file's CPU seconds a leg (`--costs`), a split run weighed by them; the landing battery's armed level 3 in place of plain; the one-process core run moved to a weekly workflow and the per-push default leg split; each leg its own levels.
- **Wave 0** (the audit's soundness tasks): `wave0-loops` (13 commits on e46e3705c: loop passes and a default's closures, the descriptor through an alias, a function's prototype, three compile-state leaks, the default's write above), the hosted compiler's helper dependencies (sound, comments), Symbol.toPrimitive (four commits, no blocker). Two with a blocker and a writer on each: the input limits' gate (watr's encoder quadratic in locals) and subscript's nested-call parse (`new get[k](x).z`).

## The land-l landing: the test-time chain's first four steps, Symbol.toPrimitive, a default's closures and writes, three compile-state leaks (2026-11-18)

27 commits on a27648bc1, tip `8f1cec4f8`. No listing moves; no bench case's bytes move.

### What landed

- **Test time, four steps of nine** (`182eb94ae` to `d22ffe40f`, eight commits):
  - test/optimizer.js cut into 17 files by the pass each group pins, so a split run can balance it.
  - `node test/index.js --costs` times each file on a leg (test/native-costs.json); a split run's processes are weighed by those CPU seconds, not by bytes.
  - The landing battery runs level 3 armed in place of plain: the two compile the same bytes (3,395 compile keys over 15 core files, none changed), the checks cost 4.7% of the CPU.
  - **CI: the per-push default leg is split** (it ran the core suite in one process, 3.5 to 4.3 hours a commit), **and the one-process run moves to a weekly workflow** (`one-process.yml`, a 300-minute limit). In the 23 CI runs since the split landed the one-process run never failed. By CI's own logs the split default job will still take 68 to 78 minutes, over the owner's hour; the weekly job is the owner's to accept or drop (told, not answered).
  - Each leg its own levels: 205 literal level lists in 68 core files go through `ownedLevels`; the three JS legs divide the listed levels, WASI and hosted keep the whole list. The trade: `npm test` alone no longer catches a defect that shows only at level 0, 3 or speed at those sites; the landing's three legs together do.
  - This check: default 1,673 s, level 0 291 s, armed level 3 1,641 s; 64 minutes in all (land-k's, at about the same load: 3,149, 794, 2,391; 108 minutes).
- **`Symbol.toPrimitive`** (`ce9a6ed0f` to `1b53404e4`): called before `valueOf` and `toString` with the hint its operator gives (ECMA-262 7.1.1); a non-callable value and an object result are TypeErrors; class methods, inherited ones, getters, literal methods, arrows and methods stored later; `parseInt`, `parseFloat` and an Error's message convert an object argument. Only a program that defines or stores the key links the prelude.
- **A parameter default's closures** (`b9c9bbbdd`, `96b7cb720`, `95679867b`): the loop passes (unswitch, kind-split, counted loops, integral loops), guardConstants and both scan splits count the closures a default makes (compile/loop-model.js closureCensus).
- **`8f1cec4f8`, the integrator's**: a module `let` written a fraction in a parameter default was narrowed to an i32 global (`let g = 1; export const f = (x, y = (g = 2.5)) => g + y + x`: 5 for 6, every level). inferModuleIntGlobals takes a function's defaults with its body; bindingFlows holds a closure default's write unvalued. The branch's recheck named the pass.
- **Lowerings that include the module they build for** (`9bb5ae8d2`, `419628c8b`, `f950cecf5`): `Object.getOwnPropertyDescriptor` through an alias crashed "Unknown op: []"; `g.prototype` of a function in a program with no other object crashed "Unknown op: {}"; the six error classes besides Error name the string module.
- **Three compile-state leaks** (`b28c92714`, `2aef18ada`, `c0de57db2`): whether a parameter grows is kept in ctx.plans, rebuilt each compile; the inliner drops its records, its summary view and its closure flag as each run starts and ends.
- A NaN literal is no change in rewriteBlocks (`e1c119c88`): a body holding one was copied each pass and the summary ran again.
- The hosted compiler's helper dependencies (`445f0af99`, `3d8b5caa0`): measured the same as the native one's (706 templates, 345,956 scans, 822,595 edges over 196 compiles, none differing); the comments that said the scan drops helpers there are corrected in five places (others still say so, listed in the handover).

### Wrong answers fixed here that v1.0.3 has

- A module binding written a fraction, NaN or a value past a word in a parameter default: 48 of the probe's 72 rows differ on v1.0.3 (54 on a27648bc1).
- `[Symbol.toPrimitive]` was never called.

### What is measured

- Bench bytes: 0 of 105 cases move. The four listings as on main.
- The integrator's probes on the tip: the default's writes 72 rows, the earlier ones 912, 108, 168, 168 and 24, none differing; plasma 585 f64x2; 8 nearest files 171 pass.
- The check on `8f1cec4f8` (64 minutes): lint and the file audit clean; bench bytes of 105 cases, no error; `test:self` 89; default 7,613 of 7,613; level 0 7,373; integration 238 of 239, one skipped; the examples 1.73 and 1.72 of V8, 25 of 25 in both runs; the armed level 3 7,394 of 7,395, the one the fetch test's 5 s limit while the load rose past 100 (alone at that level it passes, its compile 1.6 s).
- land-j on x64, a third probe (44322773983, EPYC 9V74 again): callback 0.961, polytri 0.976, decode-tta 0.996. No Intel runner in three probes.

### The audio corpus on a27648bc1 (the audio session's run)

99 processors compile; **89 pass its real-time gate** (52 on 85e229c76). The ten: allocation in `process` 8 (jz's: the four complex-STFT denoisers and the moog filter, allocation-free in V8; theirs: three that allocate in V8 too), the closure arity cap 1, a dynamic import of node:fs 1 (theirs). `memory: { fixed: ['process'] }` holds for none: 96 stop at "host or unresolved call" (the proof does not follow the closure table). A writer is on the three (session scratch `audio-b/brief-audio-b.md`).

### Known wrong on this tree, landed knowingly

- From wave 0's rechecks: a typed-array parameter a default closure rebinds to an Array reads wrong in a loop from level 1 (not located); a typed parameter any closure rebinds to a typed array of another kind too; `new Date(o)` and `Date.parse(o)` skip ToPrimitive's hint; a class field under `[Symbol.toPrimitive]` is stored under 'undefined' (a `[Symbol.iterator]` field too); a method with a parameter, made by a factory whose captured value is a string at one call and a number at another, is compiled as a number at levels 2 and 3; an arrow's or a method's `prototype` is an empty object; `o == 'default'` false at levels 2 and 3 where `o.valueOf()` returns that string (the peephole's literal inline of `__eq`); `x += v` takes ToNumber for an object local.
- Chained assignment `a0 = a1 = … = x` doubles its compile time a level (40 levels past a minute); 200 nested index reads end in an internal error: with the limits' writer.
- As on land-k.

### Waiting

- The input limits (`worktree-wf_00b2d799-cc8-12`, 18 commits): its gate passes or fails on noise at the level off; a writer repairs it and fixes watr's encoder (quadratic in a function's locals) on a branch of watr.
- subscript's nested-call parse (`nested-call-parse`, 12 commits, not pushed): repaired (`65ce463`: `new get[k](x).z`); the owner's to push and publish; bench/jessie grows 8.5% in bytes with it.
- The test-time chain's steps five to nine; the NaN box; the embedding lane's three.

## The land-m landing: the fixed-memory proof follows closure calls, a closure of any arity, two TypeErrors raised by code, CI's WASI leg (2026-11-18, the night)

13 commits on 86df52211, tip `93bd6202f`.

### What landed

- **CI's WASI leg, red since land-k** (`bb8332764`): the fixed-memory entry pin asked a WASI module for `_initialize`, and interop's start-throw after a host read is a program the compiler refuses there. The integrator's miss: the landing check ran no WASI leg and CI was not read before land-l went on top. The check runs WASI now (session scratch `land.sh`, `LEGS`), first.
- **The embedding lane's six** (`c442b6f39` to `d75c13129`):
  - A property read of null or undefined and a call of a non-function raise their TypeError by code (`__throw_property_nullish`, `__throw_not_callable`, ERR 129 and 131; a catch builds the object). A path that can only fail this way no longer allocates.
  - The census of emitted code counts a frame's mark stored back into the heap cursor as no allocation, and keeps at a catch's label the marks its try body never writes.
  - **The fixed-memory proof follows a closure call** to the closures it can reach (`ctx.closure.targetsOf` → `call.closureIds` → the tape's calls); a `memory.fixed` module keeps `__jz_table` to itself.
  - **A closure of any arity**: the one closure signature is as wide as the program's widest closure (plan/scope.js resolveClosureWidth; 8 lanes unless a wider closure exists).
- **The integrator's six**:
  - `679f11a45`: a table of arrows called by index, two of them with one body, did not compile from level 2 (the dedup renamed a body the dispatch still called by its old name). Main and v1.0.3 too.
  - `94d20af3a`: a module that only calls a host object's methods keeps its memory (stdlib-pull.js hostOps). The old thrower's allocation had kept it; without, such a module went memoryless and the scalar codec cannot carry a host reference. Found by the check's first run.
  - `93bd6202f`: a function's `length` under WASI where the program holds a function as a value (module/core.js lengthNeedsDynArm). The old thrower had registered the TypeError schema that kept the arm; four WASI tests said so.
  - `69271d30a`, `d8fb5aecd`, `f5c242b5d`: the fixed-memory refusal's position is asked only where the compiler holds the source (the hosted one does not); CONTRIBUTING on the table; the data-forms listing (the gather over a late-grown sequence: one call fewer, 68 to 76 fewer operations).

### Not compiled on v1.0.3, compiled here

- A closure of more than eight parameters; a table of arrows called by index with two equal bodies (level 2 and up).

### What is measured

- Bench bytes: 38 of 105 cases move, 36 smaller in both builds; threeanim +64 at speed (−31 at size), threegeom +65 at size (−38 at speed), neither examined. Totals: size 2,712,651 → 2,708,371, speed 5,988,518 → 5,983,846.
- The 70 examples at speed: every module smaller, 2,614,602 → 2,588,618 bytes; lenia −4,584, maze −845, lsystem −682, the rest about 300 each.
- The integrator's probes on the tip, against Node and main: the two TypeErrors 684 rows, none differing from main; the proof over programs that allocate through a closure 3,402 rows, no wrong certificate; over clean ones 288 of 378 certified (main 18); over direct calls 1,044 rows, none wrong, 286 certified (main 274); wide closures 390 of 396 as Node (main 288), the six below; equal-bodied tables 60 rows, none differing; host values 96 rows as main; a function's length right on every host and level.
- The touched test files on a freshly self-compiled compiler: parity 19, fixed-memory 14, feature-gating 36, closures 186, interop 66, minimal-output 131, function-props 9, all pass.
- The check on `93bd6202f` (93 minutes, the load 27 to 109, another session's agents on 12 cores): lint and the file audit clean; bench bytes of 105 cases, no error; `test:self` 89; default 7,617 of 7,617; armed level 3 7,399; level 0 7,377; integration 238 of 239, one skipped; WASI 7,489 of 7,490, the one test/perf.js's wall-time bound (spread concat 8.0 ms against 5 ms; alone under WASI it passes three times of three). The examples in the check: 1.65 of V8, then 1.77 with rfft at 0.79 (a failure); at a load of 13 to 16, alternating with main: this tree 1.72 and 1.69, 25 of 25 both; main 1.69 (24 of 25, rfft 0.97) and 1.68. rfft is noise on both.
- The check's first run (69271d30a, 117 minutes at a load of 100 to 200) found the two regressions above and nothing else.

### The audio corpus (the embedding writer's run, the audio session re-runs it on this commit)

99 processors compile; 90 pass the real-time gate; `memory: { fixed: ['process'] }` certifies 26 (none on a27648bc1). The next wall for 15: `__to_num` and `Math.pow` call themselves, which the proof refuses.

### Known wrong on this tree, landed knowingly

- A call of more than eight arguments of a callee the compiler cannot name, in a program with no closure that wide, is refused (6 of the probe's 396 rows).
- The proof: `__to_num` and `Math.pow` self-calls; the moog filter's Number-key scratch at 'size'; a closure call bounded by a set wider than what reaches it; a closure made per call.
- As on land-l.

### Waiting

- `land-o` (the input limits, 21 commits, and the integrator's two: a parenthesized comma expression as the only argument became two arguments where an operand folds, 846 of the probe's 1,800 rows on main; an optional call of a declared function did not compile or answered wrong, 69 of 90): assembled on this tree less its last two commits, its check next. Eight of the gate's rows wait for watr's encoder fix (`encode-locals-linear` c6459c7 in a scratch clone of watr, the owner's to push and publish).
- `land-n` (the NaN box, 17 commits: 2,973 probe answers fixed, none lost) and its follow-up writer on `nanbox-rest`: five classes still read a raw Number's bits as a box.
- The test-time chain's steps five to nine. CI's default job on 86df52211: 117 minutes (4 h 19 before the split), over the owner's hour; the runner has no shard option yet.
- subscript's `nested-call-parse` (65ce463), the owner's to push and publish.

## The land-o landing: how big an input compiles, a sole comma argument, an optional call of a declared function, a function's length by the closure (2026-11-19)

29 commits on 5f3865889, tip `48b221b29`.

### What landed

- **The input limits** (`62debf945` to `ebb10c430`, 21 commits, the limits writer's):
  - **The reader takes a chain a link a pass** (`89ca50c19`, `3f945f608`): an else-if chain, a `?:` chain down its alternates, a `;` list on one line. It overflowed near 1,000 links of else-if or `?:` and 1,500 statements.
  - **A chain that is a list in meaning is written as one past 64 links** (`d7b16fd1c`, src/list-form.js, run by the parse before the early errors): an else-if chain as a guard list, a `?:` chain as that chain or as chunks behind a flag, one logical operator as a balanced tree, any other left spine (arithmetic, comparisons, string +, member reads, calls) as steps on an accumulator; the switch lowering builds its entry chain the same way. No chain of the corpus reaches 64 links.
  - **A run of guarded exits on one word gets a table** (`a4fbe7af3`, src/optimize/guard-tables.js, after watr): what the list form and jzify/switch.js write, watr's chainTable took only as an else-if chain.
  - **A nesting too deep for the parse or a walk after it is a SyntaxError that names its construct and place** (`c417ee452`, `4262a0a5d`); a long line shows the stretch around the column (`37751b717`).
  - **Nine times that grew by the square of the input or doubled a level, each to its size**: the method-shorthand reader tried at every call (26 nested calls: 82 s); the early errors' line search; a body's bindings split (`9a2ee287e`, `33700d80f`); a lexical name declared twice (10,000 consts: 3.1 s to 70 ms); `typeof typeof … x` and `a0 = a1 = … = x` (each level twice the one inside); a flag local's writes; an element read's key emitted twice a level (`a[a[…a[0]…]]` of 14 levels: "local count too large").
  - **A labeled break inside a switch case keeps its target** (`62debf945`): `break L` out of a block in a case gated the rest of the case (Node 10, jz 0), `break outer` out of a loop around the switch only left the case (Node 0, jz 30). Main and v1.0.3 too.
  - **The gate** (test/limits.js, the generated suite): each chain kind at 10,000 links in a process of its own, answering what its generator computes, its time held to t(10,000) / t(2,500) at most 6 by the compiling thread's CPU, warm; 8 nesting forms at 5,000 levels each a SyntaxError.
  - **What holds, and what does not** (the gate's own header): at the level off 11 of the 22 kinds hold the bound at 10,000 links and 8 more once watr takes a function's locals in one splice (past 5.13.7); the rest are named in KNOWN with their cause. **At the default level no kind holds at 10,000 links**: 10 fail (8 in an internal stack overflow, 1 in SIGABRT, 1 in "summary: no fixpoint") and 12 compile past the bound (7.1 to 16.4). At 1,000 links six kinds compile at the default level (test/parse-list.js). The optimizing levels' limit is the depth and the time of what jz hands watr.
- **The integrator's**:
  - `f68a89b26`: `f((a, b))` is one argument. Every pass that rebuilt a call's arguments wrote one argument bare, and a sole comma expression became two arguments where the constant folder had folded an operand (src/ast.js argList, the inverse of commaList). The list form writes this shape for a chain that is an argument.
  - `6b79fa731`: `f?.(a, b)` of a declared function is the call `f(a, b)`; the facts counted the two as one site and read the optional call's arguments in the wrong form, and the program did not compile.
  - `1404dfd3f`: a function's `length` is read from the closure itself where nothing else in the program can hold one (module/core.js lengthClosureArm). **The integrator's miss in land-m**: 93bd6202f linked the whole dynamic read into every module that holds a closure, which cost such a module two kilobytes and refused the fixed-memory proof for a module of closures and arrays reading a `length` of an unproven receiver (the audio session's standalone program: certified on 94d20af3a, refused on 5f3865889, certified here).
  - `22fd8181a`: the handover gave the embedding writer's branch tip a wrong hash (1a748c898 is the tip).
  - `2b2096465`: **the nesting error's own hole**. A walk's overflow is named by parsing the source again, and the engine drops its compiled frames at an overflow, so that parse ran out where the compile's own had held; nestingOf took it for "does not parse" and the compile ended in an internal error (a class field's sum of 1,800 terms in a warm process, at the level off and the default). The measuring parse's nesting error is now the answer. The limits tests pinned a stage to a depth, which goes by the engine's state (a field's sum of 1,500 terms: "to compile" where the test asked "to parse", two runs of three at the level off; found by the check's level 0 leg): they hold the stage only where no stack holds the input, and across the band a module or a SyntaxError naming the nesting.
  - `e4a034e88`: `guardTables` named in the kernel's phase table (the rebase met the test that holds the table to every timed phase).
  - `1b2880faf`: the call chain of 1,000 links is left to the JS host (below).
  - `48b221b29`: test/errors.js says what the hosted compiler does with a nesting too deep (below), runs the band on the native legs alone, and asserts nestingOf's three answers.

### Wrong on v1.0.3, right here

- Run on the v1.0.3 tree and this one (session scratch `own/v103wrong.mjs`), at the level off and the default:
  - `break L` out of a block in a switch case (Node 10, v1.0.3 0) and `break outer` out of a loop around a switch (Node 0, v1.0.3 30), both levels.
  - `id((1 + 2, x))`: Node 7, v1.0.3 3, both levels.
  - `g?.(x, 2)` of a declared function: v1.0.3 does not compile at the default level ('__a0' is not in scope); `id?.((3, x))` does not compile at the level off and answers 3 at the default.

### What is measured

- Bench bytes: 27 of 105 cases move, all at speed, all smaller by 27 to 65 bytes (the table takes the runtime's own runs: `__to_str` and `__json_val` on a value's type, `__date_to_string` on a day or month): speed 5,983,846 → 5,982,860; size 2,708,371, unmoved. Not timed by the integrator; the writer's six cases read 0.93 to 1.07 of base at a load of 80 to 150.
- The integrator's probes on the rebased tree, against Node: a sole comma argument 1,800 rows, a parenthesized comma 114, a comma in a loop head 48, optional calls 90, shadowed names 72: none differs. The chain population (22 kinds, the lengths to 1,000, five levels): 5,440 rows and the four kinds of a shard stopped after an hour, 3 differing: an index chain of 1,000 links at level 2, size and speed overflows the stack.
- The listings (data forms, perf ratchet on both hosts, spellings, vector coverage): none moves. The reset probe: 344 cells, none differs.
- The check on `1b2880faf` (76 minutes, the load 11 to 68): lint and the file audit clean; bench bytes of 105 cases, no error; `test:self` 89; WASI 7,514 of 7,514; default 7,641 of 7,641; armed level 3 7,423; level 0 7,401; integration 238 of 239, one skipped; the examples 1.69 of V8 with 25 of 25, then 1.67 with 24 of 25 (blackhole 0.99).
- The touched test files on a freshly self-compiled compiler (37,646,128 bytes, of `1b2880faf`): parity 19, limits 27, optimizer-branches 25, optimizer-words 44, parse-list 14, split-bindings 19, statements 191, fixed-memory 15, all pass; errors 147 of 150, the three the hosted overflow below; with `48b221b29`'s test on that compiler, errors 150 of 150 twice in 53 s (the errors file on the four native legs: 150 of 150 each).
- test/hosted-costs.json, which plans CI's hosted slices, was not timed again: it holds parse-list at 1 s and statements at 56 s, and they took 45 s and 248 s here.
- **The check's first run** (`1404dfd3f`, 107 minutes at a load of 120 to 139) found what the three follow-up commits answer: the phase name (default leg), the call chain under WASI (WASI leg, deterministic, the limits branch's own before the rebase), the stage a depth meets (level 0 leg), and one wall-time bound (a body of 8,000 lines in 10.2 s; alone three times of three it passes). The integrator's miss: land-o's earlier runs had no WASI leg and no hosted run of the errors file; the limits branch's own check ran while CI's WASI leg was red.

### Found, not fixed

- **A member chain behind an optional chain compiles in cubic time** (main too): 200 links 1.05 s, 400 links 12.5 s (the plain chain: 0.23 s). 69% in `continuesOptional` (src/summary/kind.js), asked by `chainOp` (src/summary/query.js) at each link of each query.
- **Under WASI a call chain stops near 300 links at the optimizing levels** (500 overflow in watr's substGets; the JS host compiles 1,000): the WASI target keeps every closure on the whole closure ABI (session.js preserveClosureTable), the callee read off the receiver the link before returned, and watr re-nests each receiver into its one use, five levels a link. The same class as the index chain of 1,000: the depth of what jz hands watr is the source's chain length times a constant. The remedy is a bound on the nesting of an emitted expression (the first-evaluated operand of a tree past the bound goes to a local of its own), or watr's walks off the stack.
- At 1,000 links the sum and the switch need more than 500 kB of Node's 984 kB stack at the default level (they pass at 700). Not measured on x64: CI's default leg is the first run there.
- **The hosted compiler names a nesting only where its parse runs out.** A walk after the parse that runs out there ends in the engine's RangeError: its entry (scripts/self.js compileModule) has no conversion like compileInProcess's, and one means a catch inside a phase of the kernel's arena. Which of the two a depth meets goes by the tier its wasm functions run at (5,000 arrows: named in one test, a RangeError in the next, one process). test/errors.js accepts the RangeError on the hosted compiler alone.
- The WASI target's closures never take the narrowed signature the JS host's do (the same flag): a method call of an object literal passes six operands there, two on the JS host. Not measured.
- `(f ? proc : sets).length` beside `sets[i]` weakens the element read to the dynamic one; `proc.length` on a module binding of closures under the JS host links `__dyn_get_any_t_h`.
- The limits writer's own list: a typed array's nested keys, a switch of returns at the level off, the rows the gate names; a switch of 200 breaks at speed read 1.24 of base once (single runs 250 to 773 ms at a load of 80 to 150), not settled.

### The audio catalogue on 5f3865889 (the audio session's run)

- 99 processors compile, 90 pass the real-time gate, 26 certify fixed memory. The 73 refused, by last cause: 24 `__alloc_hdr`, 13 the recursion in `math.pow`, 2 in `__to_num`, 10 a closure entered again (this line said 7 until the land-q record: the list then summed to 69), 7 `__length.value_tail` (the bus sets whose slots differ in their channels lose "is an array"; `1404dfd3f` answers the standalone form, the seven keep an object literal that links the dispatcher), 5 `__alloc_hdr_n`, 3 `__durable_obj_snap`, 3 `__str_idx`, 2 `__mkstr`, 1 each `__dyn_get_t`, `__durable_arr_snap`, a kernel's own closure, and rnnoise unresolved. Two briefs stand written for it (the helpers' self-calls and the named-key read; the facts a default no call takes needs).

### land-m on x64 (bench-probe, jz against 86df52211, ratio of times)

- EPYC 9V45, 5 rounds: polytri 1.002, dispatch 0.999, decode-tta 0.994, decode-alac 0.990, decode-wav 1.002, threeanim 1.002, threegeom 0.996, mapstr 1.000, entity 1.001, decode-qoa 1.050; decode-qoa again at 9 rounds: 0.994 (EPYC 7763), 0.990 (Xeon 8370C). Nothing moved.
- CI on 5f3865889: the WASI job green, the first since land-k; it took 2 h 33 min, the level 3 job longer: both past the owner's hour.

## The land-q landing: runtime helpers that call themselves no more, and three compile times of the optimizing levels (2026-11-19)

8 commits on 9d56c891c, tip `1644ad9c3`. Before it, with no record of their own: `0d14fd136` and `9d56c891c`, the fix of what CI's first Linux run of the limits gate showed (below).

### What landed

- **The audio helpers** (the helpers writer's, three commits; its two follow-ups folded in):
  - **`$math.pow` takes a negative base in its own kernel** (`7d4967e76`): it called itself for |x|; the sign of an odd exponent now rides in the scale's bits. Bit for bit main's: the writer's 3,028,644 calls at six configurations, and 301,054 pairs of mine through `x ** y` and `Math.pow` at four levels, the same bytes on both trees.
  - **`__to_num`, `__number` and `__to_str` take a user conversion's primitive first and run their steps once** (`0fb2ac173`): each called itself on it. The first form, a loop of two passes, raised test/perf-ratchet.json by 645 ops a program (the landing check stopped on it); this form holds main's counts.
  - **A string's unit at an index key is read in `__dyn_get_t` alone** (`655c9874b`): the prehashed read no longer reaches `__str_idx`, which allocates. test/data-forms.json: 72 gather cells 18 ops fewer, 12 `seq/from` cells 4 calls and 21 ops more, the string arm now inline in the read they inline (a static count: the arm runs for a string receiver alone; timed 1.005 and 0.915 of main).
  - The writer's run of the audio session's tool: 38 of 99 processors certify fixed memory, against 26. Not verified here: the audio session reruns its catalogue on this commit.
- **The limits, round two, jz's side** (the limits writer's, five commits):
  - **The f32 narrowing gives up a local past 64 writes reaching one read, and writes its env in place where one place holds it** (`5dd373663`): 10,000 switch cases ran past a 4 GB heap, the SIGABRT round one recorded.
  - **Store forwarding finds what a store ends by sum and offset, and elsewhere by the kind of access** (`e1aecffbc`): an array of 10,000 literals took the square of its elements.
  - **The emitter asks "is it written later" of one table of last writes a block** (`2c5a6c321`): a switch of returns took the square of its cases at the level off.
  - **The hosted compiler names a walk's stack overflow at its host** (`513c85b8b`, test/kernel-target.js): the kernel cannot catch it, and the instance it leaves is mid-phase; the host measures the source with the native `nestingOf` and never reads the instance again. test/errors.js no longer accepts the engine's RangeError.
  - **The gate keys its default-level rows by watr's release, and holds each row KNOWN to fail to the failure its line names** (`1644ad9c3`). On watr 5.13.7 two rows leave KNOWN: array literal at the default level, switch of returns at the level off.
  - What the writer's watr branch adds is not here: seven commits on the unreleased encoder fix, in its own clone (`limits-w/r2/watr`, branch `limits-depth`): forwarding stops at 256 levels, deadset's scan and value numbering and CSE take a run in its size. With it 13 rows hold at the default level at 10,000 links. It waits on the owner's review and a watr release.

### The check (q, on `1644ad9c3`)

88 minutes at a load of 9 to 136. The four listings and the reset probe move nothing. WASI 7,522, default 7,649, armed level 3 7,431, level 0 7,409, each whole; test:self 89; lint and audit clean; examples 1.71 (24 of 25) and 1.69 (25 of 25). Integration 237 of 239 with one skipped and one failure, game-of-life's self-driven frames ("~6 frames at 16ms fallback, got 1") at a load past 100: the file alone, 38 of 38 three times. On a fresh hosted compiler (37,740,426 bytes; main's 37,646,128): parity 19, dyn-keys 171, fixed-memory 17, pow 17, to-primitive 53, errors 150, parse-list 15, float32 14, address 7. After it, the generated store, alias-fuzz, float-order, float-reduction and vector-alias populations (the store forwarding's and the f32 narrowing's): 15 tests pass in 918 s at a load of 8. The rest of the generated suite was not run on this tree.

Bench bytes against main: 36 of 105 cases move, size 2,708,371 to 2,707,314, speed 5,982,860 to 5,974,536. Seven color cases grow 12 and 9 (pow's sign), three others 1 or 2 at speed; webaudio 6,133 less at speed. The limits commits move none.

My own probes beside the writers': 132 rows of user conversions and keyed reads answer as main on the helpers; 790 rows of six review populations answer as main on the limits tree; the three compiler changes of the limits read against what they replace (`isReassigned` is `collectAssignedNames`; `mayAlias` across sums goes by mark, header, store and op alone; the f32 walk's shared envs are the one part held by evidence only: the 105 cases' bytes and the suite).

### CI's first Linux run of the limits gate (`0d14fd136`, `9d56c891c`)

On bd6def506 CI was red in two places of the land-o landing. The gate handed each source to its child in the environment, Linux bounds one environment string at 131,072 bytes, twelve kinds are longer at 10,000 links: six rows failed and six, held to fail, passed by it. Sources now ride the standard input, a child that does not start or ends unsaid fails its row, a row KNOWN as 'time' stops at two minutes, each row answers at 2,500 links. The split-bindings pin had 8 s of wall time and the runner took 8.5: held now by the share of the compile `analyzeFuncs` takes. CI on 9d56c891c: green but the standing `claims`.

### Corrections of the land-o record

- Its audio paragraph said "7 a closure entered again": the group is 10, and rnnoise, unresolved, was missing; the list summed to 69 of 73. Corrected in place.

### Found, not fixed

- **A bare block in a statement list is dropped whole where its first statement's operator is not in STMT_OPS** (src/ast.js isBlockBody): `{ { x++ } }`, a block that begins `a && f()`, `c ? f() : g()`, a labeled loop, `!f()`. On main and in 1.0.3; 198 of 960 rows of `limits-w/review-2/cases-blocks2.mjs`. The limits writer is fixing it by position.
- **A string's `length` read by a key the program holds is typed a string** (`'str'[k]`, k 'length'): `String(v)` is the number, `v === 3` false. Two lines (src/kind/val-type-of.js:327, src/summary/index.js:4048); a patch stands in `audio-c/helpers2/string-length-key.patch`.
- **`continue outer` out of an inner `for (;;)` does not compile at the default level and 'speed'** ("continue label 'outer' is not in scope").
- **shareSplitSlots grows faster than the square**: 139 ms at 4,000 lines of two writes, 822 at 8,000, 5,844 at 16,000.
- **Nested for loops double a level at the level off** (type/interval-proof.js loopFixpoint: 15 levels 2 s, 20 levels 65 s); nested `%`, arrays, trys and templates at the default level.
- **The generated suite runs on CI at the default level and under WASI alone**: the gate's level-off rows, the only ones held, run on no CI job.
- **CI jobs past the hour** on 9d56c891c: test (default) 1 h 59, test (opt3) 1 h 42, test (wasi) 1 h 35, generated (wasi) 1 h 11.
- **The bench workflow** is red on the committed Porffor evidence's age, 2 h 49 a run.
- **A wall-time pin in the integration suite**: game-of-life's frames in a window of the clock.

## The land-s landing: nullish and falsy tests decided by kind, and two wrong answers of main (2026-11-19)

11 commits on dbf9beb10, tip `82b9008ea` (the facts writer's twelve, its last two folded into one; each message's hashes rewritten to this history).

### What landed

- **Two wrong answers, on main and in 1.0.3** (reproduced at all four levels before the fix):
  - `33b5ef3dc`: a `?:` whose test the summary decided and whose evaluation may do something folded to a bare comma, which a call's sole argument reads as two: `h(x.isV ? 1 : 2)` answered 102 where Node answers 2; a method's and a constructor's one argument NaN where Node answers 2020.
  - `759619390`: inside a closure, a guard's proof about a captured binding outlived a call of a sibling closure that assigns it (a default dropped: 0 where Node answers 21). Such a binding now holds no proof outside its own scope's walk.
- **Every nullish or falsy test of a name reads the kind it has there** (`3ca152ad5`): `??`, `??=`, `||`, `||=`, `&&`, `&&=`, `x?.p`, `== null`, `=== undefined`, `!x`; the plan folds what never runs (plan/fold-kind-tests.js).
- **A test of a field is decided by the join of its slots over every shape its object can hold** (`8796208f4`, and `82b9008ea`: a comparison whose name waits on a call decides nothing that round).
- **A store or a method call through a name proves it an object past it** (`d2f6d147a`, narrowed to stores and method calls by `22a1c50cc`), **each part that may not run walked apart** (`49dfba1fd`): the first form was unsound, below.
- **A parameter knows the size of the typed array every call passes** (`9b72f35e1`); **rows of different counts join by position** (`23c4378a5`); a logical test waiting on an unbound parameter walks both operands (`6d93fecc6`).

### The review

203 programs of mine at four levels against Node, a process a tree, then 35 more. On the first hand-back 40 rows were wrong that main had right: the store's proof held past a part that may not have run, the arguments and keys of an optional chain (`o?.m(p.x = 1)`) and the value of `??=`, `||=`, `&&=`. A proof used to arise only at a test; arising inside any expression, every construct that may skip a part is a path. The writer's fix is one pair (`apart`/`rejoin`) at every such place of the walk, with a test that reads the places from the source. On the final tip every row answers as Node (populations: `audio-c/review-facts/cases*.mjs`).

### The check (fa, on `82b9008ea`)

58 minutes at a load of 8 to 19. Listings and reset probe unmoved. WASI 7,535, default 7,662, armed level 3 7,444, level 0 7,422, each whole; test:self 89; integration 238 of 239 with one skipped; lint and audit clean; examples 1.69 and 1.70, 25 of 25 twice. On a fresh hosted compiler (37,728,062 bytes; main's 37,740,426): parity 19, kind-tests 17, typed-length 19, summary-queries 74, dyn-keys 171, fixed-memory 17, errors 150. The generated suite was not run on this tree.

Bench bytes against main: 31 of 105 cases move, size 2,707,314 to 2,702,642, speed 5,974,536 to 5,927,502 (webaudio 34,330 less at speed, decode-qoa 8,395). Nine grow: watr 701 at speed (451 less at size: a parameter narrowed to a pointer is boxed again where it flows on into a boxed parameter, compile/narrow/), the three decode cases 12 to 40 (the price of `759619390`), async and the three* cases 18 to 24 at speed (one more site inlined in jz_async's __p_fin).

Costs the writer measured and did not remove: the summary's solve on the `jz` case 8% longer (429 rounds to 442; the whole compile unchanged within its runs), watr's unchanged.

The audio catalogue, by the writer's run of the audio session's tool on its own branch: 33 of 99, 26 without the store's proof, the seven it adds autowah, bitcrusher, exciter, lofi, noiseshaper, ringmod, slew. The session measures main after this landing.

### Beside it, the same day

- **The audio catalogue on dbf9beb10** (the audio session's run): 38 of 99 certify fixed memory, 26 before; twelve newly, none lost. The helpers writer's number held.
- **x64 probe of dbf9beb10 against 9d56c891c** (run 44542945582, jz against the base): cam16 0.999, hct 0.995, jzazbz 0.997, jessie 1.006, watr 1.015, mapstr 0.998, stringify 0.995, webaudio 1.004, decode-qoa 1.001, async 1.006, jsonroundtrip 0.985. Nothing moved.
- **CI on dbf9beb10**: green but the standing `claims` and one test of `test (opt3)`, test/async.js's fetch of a loopback server past its 5 s (its process took 50 minutes there); the file at level 3 here, 60 of 60 twice.
- **watr 5.13.8** (the owner's word: both branches, a patch): the encoder's one splice and the limits writer's seven commits, on watr's main as `8f7927d`, tagged. Checked first by jz's whole landing check with it linked in (four legs whole, test:self, integration, six hosted files; one bench case moves, watr's own source) and the limits gate, 29 of 29 at the default level and 27 of 27 at the level off. The npm publish is the owner's (no login where the integrator works); jz pins 5.13.7 until its bump.
- **subscript 10.8.6** (published by the owner): the method shorthand as a rule on `{` whose left operand is the call already read (g(g(…x)) at depth 24: 5.5 s to 0.01 ms), in place of the pull request that wrapped the lookup table by hand. jz pins 10.8.4; the bump deletes src/parse.js's wrapper of the old rule (it picks the lowest `(` rule, which is no longer the method's).
- **By the owner's word the writers are stopped** (the limit): the integrator works alone, one thing at a time. Left where they stood: the NaN box (`nanbox-rest2`, bcb69549d, passes the review's probes; to rebase onto this landing, time, and settle two data-forms rises), the block fix (uncommitted in the limits writer's tree), the tests' close-out.

## The land-t landing: a block by where its braces stand (2026-11-19)

One commit on 8db0e890e, `fa11e4fa3` (the limits writer's work, stopped before its commit; finished by the integrator).

### What landed

A statement that opens with `{` is a block whatever it holds; braces in an expression's position are an object literal. Prepare decides it there (src/prepare/handlers.js `prepBraces`, `prepStatement`; jzify/transform.js `transformStatement`) and writes every block's statements as a `;` list, the one form every later stage reads (src/ast.js `isBlockBody`). The three operator lists that guessed from a block's first statement are deleted (`STMT_OPS`, `JZ_BLOCK_OPS`, `LABEL_BODY_OPS`). A block that reaches the object literal's reader is an internal error.

What it fixes, on main and in 1.0.3: a bare block in a statement list was read as an object literal where its first statement's operator was in none of the lists, and dropped whole. `{ { x++ } }` lost the write; so went a block that opens with `a && f()`, `a || f()`, `a ?? f()`, `c ? f() : g()`, a labeled loop, `!f()`, `void f()`, a comma, a template. 198 of 960 rows (thirty first statements in eight places, four levels) and 61 of 88 (22 kernels of nested writes) answered otherwise than Node; all answer as Node now but the delete of a static key, the stated refusal. Beside it: a strict arrow of a destructured parameter that returns an object ended in "Unknown op: :".

### The check (bl, on the commit before its three test corrections)

64 minutes at a load of 5 to 24. Listings unmoved. test:self 89; integration 238 of 239 with one skipped; lint and audit clean; examples 1.67 and 1.68, 25 of 25 twice. On a fresh hosted compiler (37,727,870 bytes): parity 19, statements 196, split-bindings 19, parse-list 15, errors 150, classes 73, objects 200, destruct 93, generators 55. The four legs each failed the same three tests of their whole (WASI 7,537 of 7,540, default 7,664 of 7,667, armed level 3 7,446 of 7,449, level 0 7,424 of 7,427): tests that build a block by hand in forms prepare no longer writes (a statement as the braces' one child, statements as their children, bare braces for an object literal in a statement's place). Written as prepare writes them, the three files pass on the four legs (149 each) and hosted (64, 11, 74). The whole suite was not run again after that: the compiler did not change.

Bench bytes: 3 of 105 cases move, stdlib-special 10 at speed, webaudio 4 and 4, stdlib-dists by its text alone (a few functions by 5 bytes: not traced to the instruction).

### Found, not fixed

- A producer after prepare that writes a block as `['{}', statement]` is read as an expression now, where it was a block before. The suite and the 105 cases' bytes found none; no armed check holds the form.

## The land-v landing: a sole call's loop written once, and a label's early errors (2026-11-19)

Two commits on 6bc58eabd, both the integrator's, both repairs of what the two landings before it broke.

### What the two landings before it broke

- **Speed (land-s, the facts).** Landed with "speed not verified". The x64 probe after it (run 44573135102, 8db0e890e against dbf9beb10): worley 1.144, decode-tta 1.063, the other cases within 1.5%. The cause in worley: the facts typed a loop that holds the one call of a kernel, the typed-bounds versioning wrote that loop twice, the kernel then had two call sites and watr's `inlineOnce` no longer spliced it.
- **Conformance (land-t, the block fix).** CI's test262 on 6bc58eabd: accepted-negative ledger 12 where 0. fa11e4fa3 made a statement's colon a label whatever follows it and deleted `LABEL_BODY_OPS`; everything that list had left out had been refused by accident. The landing check had no test262 step.

### What landed

- `66983ee46` A loop that holds the one call of a program function is written once (src/compile/index.js `soleCalls`: called at one site, named nowhere else, not exported; src/compile/emit/control-flow.js asks it before versioning). worley at speed 12,808 bytes (13,601), 0.870 of main's time and 0.996 of the time before the facts (arm64, alternating, 16 rounds); provenance 229 bytes less, 0.993. No other of the 105 cases moves. test/advanced-index.js holds the kernel spliced at default and speed; it fails with the emitter's condition out.
- `baa2ae55d` A label's early errors, by the code's kind (src/early-errors.js): `yield` names no label in strict code or a generator, `await` none in a module's own code, an async function or a static block, escaped spellings alike (ECMA-262 14.13.1); a label stands before a statement, not a class, a lexical declaration, a generator or an async function; a class field whose initializer runs on into a `*` on the next line is refused. A first form of it in jzify refused the two words in a sloppy script too, where they are names: test262 run locally showed 2 in-scope failures before any push. test/errors.js holds the fourteen forms refused, the two script labels accepted and six labeled statements against Node.

### The check (fx, on baa2ae55d)

55 minutes at a load of 5 to 15, then test262 in 30. Listings unmoved (data-forms 640 gaps of 744, spellings 42 of 470, vector-coverage 453 of 840). WASI 7,542; default 7,669; armed level 3 7,451; level 0 7,429; test:self 89; integration 238 of 239 with one skipped; lint and audit clean; examples 1.70 and 1.69, 25 of 25 twice. On a fresh hosted compiler (37,739,478 bytes): parity 19, errors 151, statements 196, classes 73, generators 55, advanced-index 3. test262: pass 4,128, refused negatives 4,045, accepted negatives 0, failures 0. Bench bytes: 2 of 105 cases move (worley 793 and provenance 229 less at speed).

The landing check runs `npm run test:262` from here on, and an optimizer change is timed on the cases whose bytes it moves before it lands.

### Open

- decode-tta is 6% slower on x64 since the facts and this does not repair it. Bisected to d2f6d147a (1.091 on arm64); `versionTypedBounds: false` brings it to 1.050 of the time before, the rest unexplained.
- A labelled plain function inside a function body of a sloppy script (`L: function f() {} f()`) is refused with "f is not defined".

## The held-out lane's first contact (2026-11-20)

Run 44642830405 on 45e512a8a (the programs registered again by that commit: compiler source had changed since their first registration, and no one had run one with jz). The record job committed `bench/heldout.json` (731886e18, f0a5956e8). One runner, Xeon 6975P-C, paired rounds.

### The figures

25 programs registered, 2 marked not measurable beforehand, 23 run by V8, Deno, Bun, JSC and Porffor.

- jz answers 18 of the 23, the same with JavaScript's floats. Refused: havlak, clbg-nbody and clbg-nbody-node-4 ("`this` not supported: use explicit parameter"); deltablue (an internal error at `Vector.with(editC)`). cd traps at run time.
- Time over V8's, geomean of the 18: 4.72 (the lane's figure 0.21×). Are We Fast Yet, 11 programs: 9 times V8's time; the Benchmarks Game, 7: 1.6 times.
- At or ahead of V8: nbody-node-5 0.92, spectralnorm-node-2 0.95, mandelbrot 1.00. Behind: richards 74, permute 40, queens 33, towers 30, storage 11, list 6.6, json 5.3, sieve 4.3, bounce 3.5, fannkuch 2.7 and 3.0, the class-written nbody 2.8, three spectralnorms 1.3 to 1.8.
- Peak RSS over V8's: json 13.7, sieve 12.6, storage 16.2; the rest 1.0 to 2.4.
- Against Porffor's native build: faster on 13 of 18 (geomean 0.69 of its time), slower on richards 5.7, queens 3.8, permute 3.6, towers 2.7, storage 1.65.

The claims of AGENTS.md hold on the bench corpus, where jz was tuned. On programs it was never tuned on they do not: object-written programs are 3 to 74 times V8's time.

### Where the time goes

Measured on a kernel of the integrator's own in that style (a class deriving a harness class, methods on `this`, an array in a field), nothing fetched; under load, so the ratios are rough.

| The form | jz time over Node's |
|---|---|
| class declarations at the module level | 2.4 |
| one class in a function | 4.5 |
| a class deriving another, in a function | 30 |
| a class deriving a module's class, itself in a function | 30 |
| `var X = class`, `const X = class`, `let X = class` at the module level | 27 to 35 |
| a class deriving through `const A = B` | 35 |
| the lane's own build: CommonJS modules bundled by esbuild | 23 |

- **A class that is no declaration at the module level is a class of closures** (jzify/classes.js: the schema lowering asks `atModuleScope()` and a base that is a schema). One deriving a base it cannot name builds its instance from the base's factory and adds each member at run time (`__dyn_set`, `__hide_member`), and every member read and call goes through the runtime (`__dyn_get_expr`, `__ext_method`, `__ext_invoke`).
- **esbuild writes every class as `var X = class {}`** and wraps each CommonJS module in a function it calls once (`__commonJS`), a module's classes reaching another through `require_x().Name`.
- **A plain array in a field** costs a durable-store test at every element store and, where the field is assigned in a method, the generic element helpers (`__ptr_offset_fwd`, `__arr_prop`, `__arr_set_num`, `__esc_elem`): 2.3 to 2.7 times Node's time where a `Float64Array` in the same field takes 1.2.

### The work it sets

1. A binding of a class expression declares the class; a const alias of a class denotes it (branch oo-w, 2e0b2fb57).
2. esbuild's CommonJS modules linked at compile time where their requires are static: the wrapper's bindings the module's own, an export read the exporter's binding (jzify/bundler.js, beside the helper folds it has).
3. A function that runs once (an IIFE, a function of one call at the module level): its declarations the module's.
4. Element access on a plain array a field holds.
5. `this` in a plain function in a function body (the module level folds it to a class already: foldPseudoClassical), the cd trap.

## The land-x landing: watr 5.13.8 and subscript 10.8.6, a method only where a member stands (2026-11-20)

Two commits on f0a5956e8 (main with the held-out record), the integrator's.

### What landed

- `56324e3e3` The two dependencies. watr 5.13.8 bounds its walks, so the limits rows keyed by its version turn. subscript 10.8.6 reads a method shorthand as the `{` after the call it has read. In the parser entry the rule held to braces is the `{` rule's, and a method's node is put back where its head's `(` stands: subscript places it at the `{`, and the early errors read a method's modifiers off the source from the `(`.
- `2b73d089f` A method is read only where a member stands, an object literal's braces or a class body's. A call and a block on the line after it (`f(x)⏎{ n += 10 }`) were read as a method inside any braces: of 24 places a statement stands, 14 answered without the call and the block and 8 were refused. The silence in a body was fa11e4fa3's (the block fix of land-t), which let a label stand before any statement; 1.0.3 refused 20 of the 24 and lost the call in five. Directly in a bare block the form is an early error now.

### The first check failed, and what it showed

The bump was first built with the method's node left at its `{` (branch bump-w), the integrator calling the position's move harmless. The check (bw) failed one test on each of four legs: `field method() {}` in a class body was refused by another message, the early errors having gone silent. Rebuilt as bump-x.

A parser change is now compared over 25,208 files (the repository's sources and test262's language tests, every node with its position: scratch `own/parse-hashes.mjs`, `own/parse-diff.mjs`). The bump changes 4 (`static get⏎*a() {}` a static field and a generator, where `static` stood over both; `x = 42⏎*gen() {}` refused by the parser, the early error that refused it gone with its input). The gate changes 6 more: four of the repository's own test files, each a call and a bare block in an arrow's body, and two negatives by their message.

### The check (bx, on 2b73d089f)

76 minutes at a load of 9 to 62, then test262. Listings unmoved (data-forms 640 gaps of 744, spellings 42 of 470, vector-coverage 453 of 840). WASI 7,545; default 7,672; armed level 3 7,454; level 0 7,432; test:self 89; integration 238 of 239 with one skipped; lint and audit clean; examples 1.70 and 1.67, 25 of 25 twice. On a fresh hosted compiler (37,879,018 bytes, 139,540 more than before the bump: the two dependencies' own source): parity 19, statements 199, parse-list 15, errors 151, classes 73, objects 200, generators 55, parser-bugs 64. test262: pass 4,128, refused negatives 4,045, accepted negatives 0, failures 0. Bench bytes: 2 of 105 cases move, jessie and watr, whose inputs are the two dependencies.

CI on 45e512a8a (the compiler before this landing): test262 green, the label regression of land-t closed there; self-compile green; test green but claims.

### Found, not fixed

- Directly in a bare, a labelled or a case's block a call and a block on the next line are refused, where Node runs them: the literal's rule reads a bare block too.
- `new(F)` (a parenthesized callee, no arguments) answers NaN at every level.
- A class declaration's name assigned another class is still the first class to an `extends` or an `instanceof` after it.

## The land-y landing: classes a bundler writes, and esbuild's CommonJS modules linked (2026-11-20)

Five commits on 41ea18ca2, the integrator's: the first work the held-out lane's first contact set.

### What landed

- `7b27962af` A reserved word at a class member's head is the method's name (`delete(k) {}`, `return() {}`, `with(e) {}`): of 870 forms 365 were refused, 26 are. An array's `with` short of its value stores undefined, where the compile ended in the internal error of the lane's deltablue.
- `82f4c810f` A binding of a class expression nothing assigns again declares the class (`const C = class {}`, `var C = class {}`), and a const of a class's name denotes the class. Each was a class of closures, a class deriving one 22 to 35 times Node's time on the two-class kernel; 2 to 4 now. A `var` of an arrow or a class stays one declaration only where no read can take the undefined it holds until its statement: `typeof f` ahead of `var f = () => 1` answered 'function' on main and in 1.0.3.
- `caed352bd` A renamer of names through a tree (jzify/rename.js: every identifier of a name, nothing that only spells it; `free`, `occurs`), by which a bound class expression's own name takes its binding's (`var C = class _C {}`, esbuild's form for a class that names itself).
- `d378bd002` esbuild's CommonJS modules linked at compile time (jzify/link-cjs.js): a module required only as its requirers start stands at the module level, its exports consts, what a requirer takes a const of the export; a module anything else is done with stays a function, named by the advisory `module-kept` with its reason. A bundle of two modules in the lane's style: 26.9 times Node's time, 2.7 now; one of three, which ended in deltablue's internal error: 3.4.
- `1d1a497a4` The renamed-program test off the hosted compiler, which does not take a test's jzify.

### The check (ow, on d378bd002)

58 minutes at a load of 22 to 60, then test262 in 29. Listings unmoved. WASI 7,557; default 7,684; armed level 3 7,466; level 0 7,444; test:self 89; integration 238 of 239 with one skipped; lint and audit clean; examples 1.68 twice, 25 of 25. test262: pass 4,128, refused negatives 4,045, accepted negatives 0, failures 0. Bench bytes: none of the 105 cases moves (none binds a class expression or bundles CommonJS). On a fresh hosted compiler (38,038,894 bytes, 159,876 more than main's: the linker and the renamer): parity 19, classes 78, statements 199, parser-bugs 64, parse-list 15, errors 151, link-cjs 4, objects 200. rename failed one of three there (the test, corrected in 1d1a497a4 and run again: 3 of 3 hosted and on the four legs). imports fails 6 of 100 there, as it does on main's hosted compiler (bx): not this landing's.

The renamer outside the suite: every bench case compiled with every top-level name of its modules renamed. 97 of 106 give the binary of the source as written, byte for byte; of the others async, polytri, threeanim, threecull, threegeom and threescene run to the same checksum (their bytes differ: the output depends on the names' order somewhere); jz and webaudio hold a nested import form the driver does not rename around; stdlib-special does not run under that runner either way.

CI on 41ea18ca2 (the compiler before): test262, self-compile and examples-perf green, test green but claims.

### What the first contact's figures need next

- **A store at an index not proven inside the length.** The swap kernel takes 2.42 times Node's time with its indexes as they come and 1.01 with them masked to the array's length (`i & 7`): a store that may grow the array is an allocation and an escape, so every function above it carries the frame protocol (optimize/arena-rewind.js), and `permute` is 1,777 nodes where it is 244. A frame whose only allocations grow storage older than itself has nothing of its own to free.
- **A class in a function that runs more than once** stays a class of closures (4.5 times Node's time; a class deriving another there, 30).
- **A constructor function** (`this` in a plain function) folds to a class only at the module level and only with a prototype method: branch ctor-w folds one that is only constructed, in a function's statements too.
- The lane's `contact` mode run again records each program beside its first contact, marked tuned.

### Found, not fixed

- `new(F)` answers NaN; a class declaration's name assigned another class is still the first to `extends` and `instanceof`; a method named `for`, `in`, `instanceof`, `else` (a generator) or `catch` (an accessor) in a class, and 15 reserved words as an object literal's method, are refused.
- test/imports.js fails 6 on a hosted compiler (`import.meta.url` needs its option there).
- The bytes jz writes depend on the names a program gives its bindings (six of 106 cases, by up to 881 bytes).

## The land-z landing: constructor functions, a constructor's return, and the frame above a growth (2026-11-21)

Eight commits on e7fa2008f, the integrator's: what the held-out lane's tuned run still failed on, and the first part of the store that may grow an array.

### The tuned run before it (44739230492, on e25c3b4ad)

19 of 23 programs run. Geomean of jz's time over V8's: 4.72 at first contact, 1.89 (Are We Fast Yet 9.34 to 2.12, the Benchmarks Game 1.61 to 1.56). Four did not compile: deltablue ("'IdentityDictionary_3' is not in scope"), havlak, clbg-nbody and clbg-nbody-node-4 ("`this` not supported"). This landing aims at all four; none is shown to compile until the lane's `contact` mode runs again.

### What landed

- `75b271efa` A function that is only constructed is a class, in a function's statements as in the module's (`function Body(x) { this.x = x }` with `new Body(1)`). The fold took a constructor function with prototype methods at the module level alone. One called as a function, through `call`, or handed on as a value stays a function and is refused as before, as is `var P = function () { this.x = 1 }`.
- `5b4cde057` A constructor's `return` gives the instance, or the Object it names (ECMA-262 10.2.2 [[Construct]], steps 9 to 11). A class of closures answered `true` for `return true`, undefined for a bare `return`; a schema class answered the instance where the constructor named an object: all three on main too. A constructor that may return an Object makes a class of closures (the advisory says why); a value that is certainly none keeps the schema. A class folded from a function declaration in a function's statements is hoisted as its function was. The first check of the fold failed test262's S13.2.2_A6_T2 on this, then S13.2.2_A15_T2 on the hoist.
- `7b0538909` An object literal's `get` and `set` in a constructor keep their own returns. Without it webaudio's MediaStreamAudioDestinationNode lost its schema (10,099 bytes more at size), found by the bench bytes before the check.
- `54083a3a5` A const that holds a function keeps its storage where a function declared beside it read the name first (`const A = B` above `function mk() { return new A() }`): "'A' is not in scope", the CommonJS linker's own const and deltablue's error.
- `74f7cc1d9` A function's namespace is flattened again once the global it escaped through is dropped: "'f$two' is not a known function or built-in", an internal error on main too.
- `35c77c380` What a linked module requires is the exporter's own binding where that binding is never assigned again and the requirer binds the name nowhere else: no const between them, so `new Dict()` in a requirer's function declaration is a direct construction.
- `ac8db0ef5` A frame whose callees only grow storage older than itself keeps its heap and pays no frame protocol; the rule held of a frame with no calls alone. Settled over the call graph (frame-effects.js `transitiveFrameEffects`). The class swapping two elements of an array field through a method: 2.41 times Node's time, 2.13 now.
- `49d12e7bb` A descending counted loop's counter takes the integers from its bound up to its start (summary/index.js `descendingCounter`), so `for (let i = 7; i >= 0; i--) a[i] = x` stores in place as the loop upward does. Of fifteen shapes of an in-bounds store four were held; seven are.

### The check (lz, on 7b0538909)

73 minutes at a load of 11 to 30, then test262 in 30. Listings unmoved. WASI 7,563; default 7,690; armed level 3 7,472; level 0 7,450; test:self 89; integration 238 of 239 with one skipped; lint and audit clean. test262: pass 4,137 (nine more than land-y's), refused negatives 4,045, accepted negatives 0, failures 0. On a fresh hosted compiler (38,085,375 bytes, 46,481 more than land-y's): parity 19, classes 80, statements 200, closures 187, link-cjs 4, frame-effects 76, array-scan 12.

Examples: the first run 1.69 with 24 of 25 (blackhole 0.99); the second failed its floor on rfft (0.84, a kernel of 10 µs whose V8 time went from 9.9 to 13.6 µs in that run). All 25 examples compile to main's bytes on this branch, so no example's code moved; two runs after the check gave 1.69 and 1.71, 25 of 25.

Bench bytes: 5 of 105 cases move, all smaller, all by `ac8db0ef5` (built without it they are main's; `49d12e7bb` moves none): fabrik 26,343 to 26,138 at size and 53,630 to 51,000 at speed; polytri 23,261 to 23,142 and 51,081 to 50,927; stdlib-dists 259,863 to 234,333 and 442,017 to 434,335; stdlib-gamma 24,730 to 24,007 and 62,540 to 59,691; stdlib-special 233,464 to 216,259 and 498,100 to 485,965. Their time against main's compiler, paired over 6 rounds on the M4: fabrik 1.000, polytri 0.990, stdlib-dists 0.989, stdlib-gamma 1.001, stdlib-special 0.993.

CI on e25c3b4ad (the compiler before): test262, self-compile, examples-perf and pages green; test green but claims. The bench workflow is red there as on every push since 2026-11-19 at least, with the same three causes each time: the Porffor evidence older than the gate requires (alpha 13 against 23), the perf-fuzz gate's mixed maximum (4.34 times against a bound of 2.25), and three examples under their floor on that runner (ulam 0.87, lenia 0.76, rfft 0.60). Phase 11's, not this landing's.

### The store that may grow an array: what is measured, and what follows

The swap kernel takes 2.08 times Node's time as written (in the run that measured the rest), 1.07 with its indexes masked to the array's length and 1.25 over a Float64Array: the cost is the open array (a forwarding test, the bounds, the hole, and on a store the durable test, the growth arm and the escape), not the index's conversion. Over the 100 bench cases the `array-open` advisory names 84 arrays opened by `push`, 19 joined with a growing one, 5 by `splice`, 4 stored past the count at a bounded index, 2 by `pop`, 1 by a stored length, and 2 stored at an index the walk cannot bound: the corpus hardly holds the shape, the held-out programs do (an index that is a method's parameter or a recursion's).

Such an index often has no range to prove, so more proofs do not close it: the checked path has to be cheap. Next, in order:

1. A descent from the length (`for (let i = a.length - 1; i >= 0; i--)`), the emitter's canonical loop: done on branch grow-w (`cf8956215`), not landed.
2. A store under its own bounds test (`if (i >= 0 && i < a.length) a[i] = x`) is no growth in the summary; the emitter already takes it.
3. One index conversion, one forwarding resolve and one length for the accesses of one array in straight-line code (the swap does four conversions and four forwarding tests where two and one do).
4. A straight-line block of several accesses under one guard: plain loads and stores in the arm the guard admits, the code as written in the other.
5. A while loop's counter, and a recursion's argument counting under a guard (its hull opens after four moves).

Still open from land-y's list: a class in a function that runs more than once stays a class of closures; a class in a function that runs once outside the CommonJS linker.

### Found, not fixed

- A derived class's constructor that returns a primitive gives the instance where JS throws a TypeError.
- land-y's list stands: `new(F)` answers NaN; a class declaration's name assigned another class; reserved words as method names; test/imports.js fails 6 on a hosted compiler; the bytes depend on the names a program gives its bindings.

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
- Counter widths are a step of their own ahead of 6b (the owner, 2026-11-13: the
  examples gate's failures are chased unless a later phase rules them out; none does,
  and rfft's cliff is one root with the vectorizer's largest emitter-fact refusal).
- The landing battery times: the examples benchmark is a leg, compared against the
  base's run. A gate that fails nothing on CI is read by the integrator, not trusted.
- A change of bytes is timed in alternating rounds against the base, a page alone in
  its process (the integrator, 2026-11-14: one comparison against an earlier run read
  6% that was nothing, and a ten-page run read 10% that was the process).
- A copy the planner adds takes no input's copy away: on no input does a loop run
  slower than before by more than the entry tests (the integrator, 2026-11-14, on the
  box). The box is held until it meets that.
- The reference run measures the rivals' current releases, each compiler named in the
  dataset; a pin is proved by a probe from a branch before it reaches main (the owner
  asked for the run, 2026-11-14).
- 1.0.3 is cut as 1.0.1 and 1.0.2 were, off the tag before, with the fixes that
  reproduce there (the integrator's reading of the owner's "do 1.0.3 release",
  2026-11-14). Published by the integrator on the owner's word the same day.
- The phases run side by side (the owner, 2026-11-14: "don't hoard branches, we need to
  get all phases work done sooner"): a scout maps each phase while the one before it is
  built, writers work in their own trees on files no other writer holds, and the
  integrator reviews each hand-back with populations of its own and one battery.
- A writer runs the self-compile before handing back (`test:bootstrap -- --full`): the
  box's hand-over held a `delete` of a static key that only the battery's bootstrap leg
  found.
- No patch release ahead of the architecture (the owner, 2026-11-14): what the phases
  find wrong in 1.0.3 is fixed on main and ships with the release that carries them.
- `relaxedFloat` is off below `'speed'` (the integrator, 2026-11-15, on the plan's
  "relaxations opt-in"; the owner was asked on 2026-11-14): the default level answers
  what Node answers bit for bit, and four float kernels run about twice as long there
  until 6c's exact lowerings. One line of the preset flips it; the owner may.
- A tier that tests a counter's bound is not landed (the integrator, 2026-11-15): up to
  40% more bytes and 65% more compile time on five examples for six more lifts and
  nothing faster. Its commit is named in the handover.
- A writer whose step has a successor carries on in its own context and tree, told of
  each landing so it rebases (the integrator, 2026-11-15): 6c, 7b and 7c, 9b.
- Float results (the owner, 2026-11-15): "some deviation within 100ulp is allowed if that
  saves perf or size times. But do the most meaningful way." Applied per relaxation, with
  numbers, once 6c has landed its exact lowerings: a rewrite that rounds otherwise than
  JavaScript is on at the default level where it saves a multiple over the best exact
  lowering of the same loop and its results stay within the bound on the float
  population; every other one stays at `'speed'`. A reordered sum has no bound in ulp of
  its result (under cancellation its bound is n·2^-52 of the terms' total magnitude, as
  README says): what the default promises is written from what is measured. Until then
  the default level is exact, and nothing is released from it.
- The claims stay as written and are to be met (the owner, 2026-11-15: "we're going to
  need to work on meeting these claims when we land all phases"): phase 11.
- Phase 4's memo is dropped (the owner, 2026-11-15: "if useless then drop"; the
  integrator's reading, in its row).
- A case within 8% of the best rival is a tie, which passes the claims gate, is printed
  as a target and is never called a lead (the owner, 2026-11-17: "Ties - ok, 5-8% can be
  said ties"). On main with land-g (`2e26b7e00`).
- At `'speed'` the bench holds a relaxed lane to a tolerance, not to JavaScript's bits
  (the owner, 2026-11-17: "Parity at speed - tolerance is allowed"): the single-precision
  hash for the float cases where a relaxed lane differs in rounding only, for jz and for
  the rivals' fast-math lanes alike. Not built yet; the sums in lanes wait on it.
- jz leads by general means; where only a twist for one case would win, the twists live
  in one layer with stated conditions, or the case is listed as a gap (the owner,
  2026-11-17, quoted in the land-e record).
- No test run takes over an hour (the owner, 2026-11-17): the landing check and each of
  CI's jobs. The landing check of land-e did not meet it; the chain `tests-time` is the
  work to. (land-g's took 129 minutes at load 45 to 85.)
- The bench times every engine lane after the engine's tiers settle, sources unchanged,
  the first pass recorded beside it; the claim reads "fastest optimized wasm" (the owner,
  2026-11-17: "yes" to that question; fabrik on a Xeon 6975P-C: 54 us as timed, 29 with
  V8's baseline tier off, C's wasm 26). In work (`jz-settle`), not on a tree yet.

## Open questions

- Whether `do…while` becomes a first-class bottom-tested loop through emit, or a counted
  `for` with bound `N > i0 + s ? N : i0 + s` under a guard fact. Decide in phase 1 from
  what the emitter and the vectorizer scaffold accept.
- A memo shipped as build-time data would help the first compile of a process (160 ms
  against 29 ms warm for the same program); the per-process memo does not.
- `host: 'native'` as a public value (a raw host with no interop: no tail calls, a
  uniform parameter lane) and a small frozen embedder ABI (`memory`, `__jz_heap`,
  `__jz_alloc`, `__jz_clear`, accessors for a typed array's data address and length):
  asked for by the audio session on 2026-11-17 as the owner's decision of that day; to
  be confirmed by the owner with the 1.1.0 list. Today `@audio/compile-vst` reaches for
  internal flags and writes a typed array's header itself.
- Whether short-lived probe branches may be pushed to origin, so that a change is timed
  on x64 (bench-probe.yml, which times a commit of the repository beside a base on one
  runner) before it lands: asked of the owner on 2026-11-17, not answered. Until then a
  change is timed on x64 after it is on main; land-e's callback (2.24 slower on a Xeon,
  nothing on the M4) is what that order costs.
  (Asked again on 2026-11-18: the word's rule keeps a form at speed in polytri that the
  repo's x64 table predicts slower, and it lands untimed there.)
- The six bench cases whose `main` carries state between calls (fabrik, jsontransform,
  setops, stringify, threegeom, threescene): their JS lanes cannot be timed after the
  tiers settle without a `main` that starts from the same state, a change of the source
  in every port. Until the owner rules, jz meets those lanes first pass to first pass.
- MoonBit's lane in Node's V8 instead of moonrun (the pass rule needs a second
  instance, which moonrun does not give): faster for MoonBit, its memory figure larger.
  The writer's choice, the owner's to keep or to turn back.
- A literal `import('./x.js')` in a branch never taken that names a missing module, or
  one jz cannot compile, fails the whole compile, where JavaScript runs; and the
  target's code is in the binary whether or not it is loaded. Read and reported
  (2026-11-18), not changed.
- WASI: a throw while a module starts traps under wasmtime with no message. Printing
  it needs an ABI the owner has not decided.
