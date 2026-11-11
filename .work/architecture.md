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
| 2 | One domain: a transfer table with module constants resolved, behind every `%`/mask/step rule; `interval-proof` as the engine, on by default; the local's type decided once | ring and offset-index kernels close; `int-certain`, the stamp scans and the duplicate rules are deleted | 2a landed: the table is `src/summary/num-range.js` (`{lo, hi, int, nz, nan, gap}`, no rule reads a name), every `%` rule but two reads it (left: integral-loops' symbolic hull, the summary's `keepHull`), ring `% M` equals the mask spelling (2/27), `mixed` back to 2264/1060. `src/` +49 lines net. 2b landed: the proof's environment holds table values and is the reader behind every local's lifetime range, a sum's trip bound and the widening's word test; `stampBodyRanges`, `fractionalLoopRange`, `outerDeclInits` and the widening's own `held`/`boundOf` are deleted (`src/` 59 lines fewer over the phase); the proof's bitwise, shift and mask rules are the table's. Ring "step first" 35 -> 4 at level 2 and 37 -> 29 at speed (canonical 2 and 27), dot and map `for i<=N-1` and `i!==N` vectorize, 76 gaps of 470, `mixed` 2250/1046; proof time -23% over the 94 single-file bench cases (3.8% of compile), total within noise on a loaded machine. Still scans: a countdown in an arm of `\|\|`/`&&` (`stampCountdowns`: the proof refines neither arm), and the emitter's own `intExprRange`/`forCounterRange` and `extractRefinements` (it asks about nodes the proof never walked: plan rewrites, inlined copies, version twins). 2c landed: a local's storage is one decision over the proof's lifetime value (`analyze/body-facts.js` `widenLocalTypes`: a word where every number it holds is one, or where it holds integers and every read re-applies ToInt32), a module global's the same over the whole program (`plan/scope.js` `inferModuleIntGlobals`: the proof per flow under the hypothesis that the candidates still standing are words; the fraction classifier, the integer default and the `int-global-truncation` warning are deleted), carriers enter the proof as values (a word parameter's, a call's, a sized property's, a code unit's), and the widening's hypothesis loop and integer levels are gone; `src/` 209 lines fewer, `mixed` 2234/1045, bench bytes -802 at size and -9,313 at speed (the landing tree: core 7,285, level 0 7,068, level 3 7,082, wasi 7,157, generated 68, self-compile 89; the earlier phases' batteries equal but 3c's review battery, 2 diffs -> 0). 2d is not done: `type/int-certain.js` stays with seven readers (briefed, `.work/phase-2d-int-certain.md`): its level 1 is an integer wherever finite, which the table's `int` does not carry, and four readers decide for bindings written in more than one flow. Until then its levels are grounded: a name a body writes and does not declare starts from what is known of all its writes. Open cells: ring "step first" keeps the copy `q = p` (2 ops; needs the update sunk below `q`'s reads, a scheduling change), `reverse i--` is refused by the vectorizer's exit-shape check (optimize/vectorize/addr-model.js, phase 6), `offset idx i-1` keeps 4 and 2 ops, not analyzed |
| 3 | One loop constructor in emit; callback parameters and accumulators typed from the summary | `for…of`, `forEach`, `reduce` cells equal the `for` cell; `reduce` links no string helper on numbers | 3a landed (parameters read the summary: reduce over numbers is one `f64.add`); 3b landed: one `walk` (src/ir/arrays.js) at 38 sites, typed-array callbacks bound by the summary and inlined, `reduce` cells closed (82 gaps of 470), `src/` and `module/` 114 lines fewer. 3c landed: an arrow of plain value runs in the walk that calls it (compile/in-place.js, every emitter that builds a callback), `for…of` reads its array (plan/alias.js), and a cell no closure took is a local in the optimizer (optimize/cells.js `promoteCells`); `kernel/dot` written with `forEach` or `for…of` and an index vectorizes as the `for` loop does (78 gaps of 470), ratchet unchanged, bench bytes -847 at size and -3,232 at speed, `src/` and `module/` 221 lines more (the pass is 76). Left: a typed `map` whose callback reads a second array by the index does not vectorize (its walk is sized by `__len` at run time; cause inferred by 3c's agent, not traced); a body that makes a function, writes a parameter or returns early keeps the closure |
| 4 | Compile time: memoize jz's per-function passes for parsed helpers (key: IR, config, four module flags, callee closure), a `settled` set for watr | allocating programs compile 3× faster warm; a debug mode proves memo = fresh on the whole suite | briefed and running (`.work/phase-4-compile-time.md`): the rule is byte identity with the memo off, in any order of compiles; watr's part comes as a patch, not installed |
| 5 | Pass table and shared index: every optimize pass takes `(fn, facts)`, order and requirements are data, def-use and loop tree built once | no `ctx` read under `src/optimize`; the hand sequences are generated from the table | |
| 6 | Vectorizer legality from induction facts and a dependence test, if-conversion; recognizers become cost choices | the fixed-order recognizer list is gone; no corpus cell loses SIMD | |
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
- Open, on `main`: `for (let i = 0; i < k; i++) { let i = 5; c += i }` never returns
  (the body's own `let i` is taken for the loop's; one more pair of braces and it
  answers). In prepare; 1b has landed, so nothing holds the fix back.
- Open, on `main`, levels 2 and over: `let i = null, c = 0; for (; i < 3; i += 1) c++`
  runs 0 times for 3. The test compares the null box, a NaN, where its number is 0
  (a shadow local `inum` is declared and not read there: compile/num-shadow.js).
- Open, on `main`: `do i++; while (c)` and `do { … } while (c) stmt` are compile errors
  ("Unclosed (", "Unclosed {"); both are JS. The parser package's: subscript's `do` rule
  skipped five characters after the body for its `while` and ended no statement at the
  test's `)`. Fixed there as 10.8.3 (9909ce7, tag v10.8.3; committed, not published as
  of this note). Through jz's parser, 56,004 sources (jz, watr, subscript, three.js,
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

## Decisions taken

- Normalization is value-exact and runs before the summary (kinds unknown there):
  a step is rewritten only for a counter that starts from a number and is only ever
  stepped; `i !== n` needs a start-below-bound proof and belongs to phase 2.
- `interval-proof.js` is grown into the analysis; a seventh is not written.
- The tape stays the link stage's IR until phase 5 decides: 40+ array passes and the
  emitters are array-based, and the index can be built on either.
- watr stays generic. JS-level facts live in jz.

## Open questions

- Whether `do…while` becomes a first-class bottom-tested loop through emit, or a counted
  `for` with bound `N > i0 + s ? N : i0 + s` under a guard fact. Decide in phase 1 from
  what the emitter and the vectorizer scaffold accept.
- A memo shipped as build-time data would help the first compile of a process (160 ms
  against 29 ms warm for the same program); the per-process memo does not.
