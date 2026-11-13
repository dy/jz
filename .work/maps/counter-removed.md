Scout report (Sonnet 5.5, 2026-11-13), tree `557fbd525`, read-only. Leads, not facts: V = the
scout read the line or ran the command, I = inferred. The integrator compiled five of the
reduced programs of `counter-census.md` on the same tree and saw the same f64 locals; nothing
else here is re-derived. `SCRATCH/counter-widths/` in the text is session scratch (the reduced
programs, the tree of `e88a8e907`, the instrumentation patch, the raw rows): not in the repo.

# removed.md: what 2c842394d and b30443c4f removed

Model: claude-sonnet-5-5. Tree: worktree of `main` 557fbd525 (identical `src/` to cdc3b0711). V means I read the line (`file:line`, on HEAD unless a commit hash is named) or ran the command. I means inferred.

Both commits are dated 2026-10-01 (01:58:23 and 01:58:44, `git show --stat`). I read both whole: `git show 2c842394d` (9 files, 176 insertions, 287 deletions) and `git show b30443c4f` (6 files, 134 insertions, 163 deletions). The old tree is `git archive e88a8e907` in `SCRATCH/counter-widths/old` (node_modules linked, unmodified except two one-line debug hooks, `__dbg`, in `src/compile/analyze-for-emit.js` and `src/compile/plan/integral-loops.js`, which do nothing unless a global is set).

## The one assumption under all of it

Before the two commits a local stayed an `i32` wasm local on the strength of how it was used, not of what values it could hold:

1. it was compared (a loop test), or
2. it was an affine component of an array index, or
3. it fed such a local by assignment.

Each of those was taken to bound the local to the signed word. None does:

- a comparison reads the Number, not its word (`i < n` with `n = 2147483649` is true at `i = 2147483648`);
- an index of a typed array is not a proof, because jz's checked read of an out-of-range key is the value `undefined` and the store is ignored (a missing element is a valid answer, not a trap), so a valid run does not imply `index < 2^31`;
- arithmetic (`*`, `+=`, `-`) of integers is an integer of any size (up to 2^53 exact, then rounded), and storing it in an i32 wraps it modulo 2^32.

## Rule by rule

### R1. A compared name is never blamed as a bare escape (`collectComparedNames`, `testedCounters`)

- Removed by 2c842394d from `src/compile/analyze-scans.js` (old lines 78 to 112 of the diff hunk; the deleted doc comment names it "sound for n <= 2^31", the asm.js integer contract).
- Assumed: a name that is a direct operand of any comparison anywhere in the body (or tested by `--i`, `i--`, `while (sp)`, `a && --i`) is a loop counter, and its other arithmetic inherits "the same accepted tolerance": the counter is below 2^31.
- Wrong on: a counter that reaches 2^31. Smallest program (test/integral-loops.js, 'Number counters cross signed-word boundaries without wrapping'):

  ```js
  export function up(n) { let out = []; for (let i = 2147483647; i < n; i++) { out.push(i, i % 6); if (out.length === 4) break } return out }
  ```

  With `n = 2147483649` Node answers `[2147483647, 1, 2147483648, 2]`. I ran it (`SCRATCH/counter-widths/removed-run.mjs`, test/util.js `jz`, and Node as oracle):
  - now at level 0, 2, speed: equal to Node (V, ran).
  - e88a8e907 at level 0: `[2147483647, 1, -2147483648, -2]` (wrapped, V, ran); at level 2 and speed: `[]` (V, ran, zero trips: see R3).
- Present rule: `bareEscapeScan` (`src/compile/analyze-scans.js:1260-1337`) has a `'cmp'` mode that blames the compared name exactly like a value read (`:1279`: `if (mode === 'value' || mode === 'cmp') escape(node)`); a blamed name is spared only if `escapeInRangeI32(name)` (`:1271`, the name's range rep lies in [-2^31, 2^31-1]). `++`/`--` blame their operand (`:1292`). The decision that reads it is `widenLocalTypes` at `src/compile/analyze/body-facts.js:814-824`: an `i32` local stays i32 only if it is a `wordLocals`/`unsignedLocals` member, a Boolean, `nrWord(hull)` (the interval proof's lifetime hull is an integer, never -0 or NaN, inside [-2^31, 2^31-1]: `src/summary/num-range.js:76`), or `hull.int` (integer of any size) with no bare escape.

### R2. Pass A and Pass D of `widenLocalTypes` (comparison widening exempt for counters; level-1 integers checked only without a governing comparison)

- Removed by 2c842394d from `src/compile/analyze/body-facts.js` (the long doc block of `widenLocalTypes`, "Pass A ... EXCEPT integer counters used as affine array indices ... Sound for n <= 2^31", and "Pass D ... the loop-counter 'sound for n<=2^31' tolerance is scoped to compared names only").
- Assumed: `i32` counters compared against an f64 bound need not widen ("an f64 counter would poison the loop body's arithmetic ... measured 18x vs V8 before this"): a perf rule that became a soundness assumption.
- Wrong on: the same programs as R1. A smaller one for the index case is R4.
- Present rule: Pass A/B (`:756-812`) widen only after inputs widen; the one decision at `:814-824` replaces them (R1). `keepI32` (`:755`) is now `unsignedLocals || wordLocals || i32SafeIdx || (hull.int && !f64IdxVars)`, a provisional carrier that the decision then re-checks.

### R3. `narrowLoopBound`: `i < n` as `i < trunc_sat(ceil(n))` for a non-negative i32 counter (`src/optimize/licm.js`)

- Removed by 2c842394d (old lines 400 to 525 of the hunk). The deleted doc names its own divergence: "n >= 2^31 saturates to INT32_MAX => terminates after 2^31-1 iterations where the original wrapped $i negative and spun forever ... pathological in both versions (a JS double counter would keep counting)".
- Assumed: a counter whose every write in the function is a non-negative `i32.const` or `$i + positive-const` (`nonNegCounter`) cannot reach 2^31 "in a non-pathological program".
- Wrong on: `up(2147483649)` above: the counter starts at the constant 2147483647 (non-negative), the snapped bound is `trunc_sat(ceil(2147483649))` = 2147483647, `i < 2147483647` is false at once: zero trips, Node does two (V, ran: old@2 and old@speed answer `[]`).
- Present rule: `narrowLoopBound` (`src/optimize/licm.js:979`) takes the counter type only (`localTypes.get(ctr) === 'i32'`) but compares against an exact i64 threshold (`i64.trunc_sat_f64_s` of `ceil`/`floor`, NaN to `i64.const -9223372036854775808`), so an explicit word counter (`i = (i + 1) | 0`) still matches JS; an ordinary Number counter gets a bounded copy at plan time (R9). Test: test/optimizer.js 'narrowLoopBound: raw i32 comparisons preserve every Number threshold' (it runs the rewritten function in wasm for 7 counter values x 15 bounds incl. NaN, +-Infinity, +-2^31 neighbours). The `wat-invariants` ablation that asserted "no f64 compare in the loop with the pass ON" was replaced by one asserting a guarded copy has no floating trip-count operation and that the fallback keeps the f64 test (test/wat-invariants.js 'bounded loop copies keep < counters in integer registers').

### R4. `collectI32SafeIndexVars`: an index local is bounded by being indexed (b30443c4f)

- Removed by b30443c4f from `src/compile/analyze-scans.js` (about 150 deleted lines: the three-source doc, `addAffine`, edge back-propagation to a fixpoint, `isIntShaped`, `isI32Lit`, and the final promotion loop `for (const n of safe) if (locals.get(n) === 'f64' && isIntShaped(n)) locals.set(n, 'i32')`).
- Assumed (the deleted doc): (1) "a valid wasm32 access requires the byte offset to fit i32, and an affine index is monotone in the local, so the local is i32-bounded for every non-trapping run"; (2) back-propagation: a local that flows by affine assignment or step (`let i0 = ix`, `i0 += id`) into an already bounded index local is bounded by it ("FFT butterflies"); (3) an integer-shaped feeder left at f64 (`o = y * w`) may be promoted to i32.
- Wrong on: any index local that grows past 2^31 and is only read through an element access, because an out-of-bounds index is not a trap. Smallest programs (test/index-width.js, 'index-only arithmetic retains the full key across local writes'):

  ```js
  export function f(mode) {
    const a = new Float32Array([2, 3]); let x = mode ? 65536 : 0; x *= 65536
    const read = a[x]
    let effects = 0
    const assigned = a[x] = (++effects, 9)
    return [read, assigned, effects, a[0], a[1]]
  }
  ```

  `f(1)`: Node `[undefined, 9, 1, 2, 3]` (x = 2^32, a[4294967296] is undefined, the store is ignored). Ran (V): now at 0, 2, speed equal to Node; e88a8e907 at 0, 2, speed answers `[2, 9, 1, 9, 3]` (x wrapped to 0: read a[0], and the store hit a[0]).
- And the case that is rfft's: `id *= 4` stepped without bound, read only as an index feeder (`i0 += id`). In the reduced first pass `while (ix < n) { x[id] = x[ix] + 1; ix = 2 * (id - 1); id *= 4 }` (`SCRATCH/counter-widths/exp/reduced.mjs geo`), e88a8e907 never terminates for `n >= 2147483647`: `id` wraps to 0, `ix = 2 * (0 - 1)` stays below `n` forever. Node ends after 16 trips (`[16, 8589934590, 17179869184]`); now equal to Node (V, ran, `drive2.mjs geo`). For `n <= 2147483646` all five engines agree.
- Present rule: `collectI32SafeIndexVars` (`src/compile/analyze-scans.js:1528`) promotes only a name in affine index position whose range rep is already a closed signed word (`escapeInRangeI32`), "the canonical range authority includes all writes; unknown hulls stay f64". The index operand is read in `'value'` mode by `bareEscapeScan` (`:1296`, was `'idx'`).

### R5. Module-global counters (the same two exemptions at program scope)

- 2c842394d removed the compared-names pass from `collectGlobalBareEscapes` and changed the test 'safe control: module-global counters ... keep i32 storage' to 'module-global counter widths distinguish Number growth from explicit words' (test/inference.js): `let idx = 0; export let advance = (n) => { for (idx = 0; idx < n; idx++) {} ; return idx }` is `(mut f64)` now, was `(mut i32)`.
- Present rule: `inferModuleIntGlobals` (`src/compile/plan/scope.js:262-300`): a global becomes i32 if the flow proof `held` is a word (`held.get(name) === WORD_VALUE`) or it has no bare escape in any body (`collectGlobalBareEscapes(bodies, ..., ALL_WIDE)`). rfft's `N` (assigned from the export parameter `n`, compared `i < N` everywhere) is neither, so `N` is `(mut f64)`.

### R6. Counter hull of a `for` (`stampLoopCounterRanges`) and the integral copy (`counterBound`)

- 2c842394d made `forCounterRange` read the entry and bound through the single initializer of a name (`hasSingleInitializer`, then `scanBindingUses`), and required `range.test` (which includes the final step) to lie in [-2^31, 2^31-1] (`analyze-scans.js:1454-1522` now).
- 2c842394d added to `src/compile/plan/integral-loops.js` the `counterBound` guarded copy (HEAD `:796-826` for a `for`, `:848-881` for a `while`): the bound `n` is rounded once into a private `bound = ceil(n) >> 0`, the copy tests `i < bound`, and the guard `typeof n === 'number' && n >= min && n <= max` (min/max leave room for the last step) selects the copy; the loop as written stays beside it. Test: test/integral-loops.js 'bounded copies preserve fractional bounds, initialization, mutation and exits'.
- Assumed by what it replaced: nothing new; it is the replacement for R1 and R3 on the loops they served (`for (i = 0; i < n; i++)` over a parameter `n`).

### R7. Captured names: the cell's type (b30443c4f, `src/type/expr-type.js:73`)

- Removed assumption: `exprType('x')` of a closure-captured mutable name reported the type of its local, which is the i32 pointer to the cell, as the type of its value. Present: `if (locals === ctx.func.locals && ctx.func.boxed?.has(expr)) return ctx.func.cellTypes?.has(expr) ? 'i32' : 'f64'`. Test: test/index-width.js 'a boxed cell type belongs only to its active storage map'. Not part of rfft.

## Tests I ran

- `node test/index.js index-width`: 8 tests, 418 assertions, pass (V).
- `node test/index.js integral-loops`: 70 tests, 3647 assertions, pass (V).
- `SCRATCH/counter-widths/removed-run.mjs` (three of the programs above, through test/util.js and the Node oracle): now equals Node at levels 0, 2, speed; e88a8e907 differs on programs 1 and 2 at every level run (output in this file's sections). The third program (`id *= 100000` then `return id`, test/inference.js) is answered correctly by e88a8e907 too: that case had been closed earlier by the bare-escape rule (the `return` is a bare read), so it is not one the two commits changed.

## What the two commits did not remove

- The checked read of an out-of-range key (`undefined`) and the `unsigned`/`>>> 0` carriers.
- `wordLocals` (`narrowWordLocals`, `analyze-scans.js:1143`): a local every read of which applies ToInt32 keeps its word whatever its writes are. This is why `n2`, `n4`, `n8`, `nn`, `ti` of rfft are still words (see rfft.md).
