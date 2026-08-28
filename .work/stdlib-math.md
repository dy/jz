# stdlib generators: math.js — map + refactor record

Baseline: 3e960ee8 (branch point; `module/math.js` is not among main's dirty
files listed for this task, so this worktree's pristine checkout is
byte-identical to what's live in the main worktree). Follows
`.work/stdlib-generators.md` (collection.js/typedarray.js) and
`.work/stdlib-string-array.md` (string.js/array.js).

## Shape difference from both precedents (read before the plan below)

collection.js/typedarray.js had generator families as **top-level functions
BEFORE** `export default (ctx) => {...}` opens. string.js/array.js had a
substantial top-level (pre-closure) portion too (SSO codec; allocArray/
hoistArrayValue/makeCallback/etc), with registrations interleaved through the
closure body.

**math.js has neither.** The entire file (2296 lines) is ONE closure —
`export default (ctx) => {` opens at line 22 and doesn't close until line
2295, EOF. There is no top-level pre-closure helper at all. Every family
identified below is extracted FROM INSIDE the closure, following the
string-array precedent's own proof that this is safe (`array/from.js`,
`array/early-exit.js`, `array/callback.js` all did exactly this): the target
module imports the `ctx` **singleton** directly (`import { ctx } from
'../../src/ctx.js'`) instead of receiving it as a parameter — confirmed by
reading `src/autoload.js`'s `loadModule`: `init(ctx)` calls each module's
default export with the SAME singleton object `ctx.js` exports, so a sibling
file reaching for the module-level `ctx` import gets the identical object.

A second, novel wrinkle not present in either precedent: math.js's WAT-string
kernels (the back two-thirds of the file, the `wat()` calls) have almost
**zero** JS-level coupling to the front third's `f`/`fn`/`canon`/`emitPow`-
style JS emit-dispatch helpers — a `wat()` body is a template string
interpolating pre-computed JS numbers, never calling `emit`/`typed`/`f`/`fn`.
That makes the WAT section's own sub-families (trig, exp/log, the two pow
kernels, hypot/cbrt) individually low-fan-in candidates — but most of them
are NOT extracted here: per the precedent's own warning ("grab-bag files
often have one interconnected core plus a FEW genuinely self-contained
families — extract only the latter"), a family must have single-cluster
call sites AND either an author-drawn boundary (a comment marker) or true
zero shared state with its neighbors — not just "happens to not call `f`/
`fn`". trig/exp/log/pow(core)/hypot/cbrt/atan-family fail that bar: they
WAT-call each other constantly (tan→sin+cos, sinh/cosh/tanh/asinh/acosh/
atanh→exp/log/isFinite, acos→asin, atan2→atan) and have no author-drawn
sub-boundary beyond one `// ====` header for the whole "WAT stdlib
implementations" section — moving them would be relabeling the interconnected
bulk under an invented name, exactly what the precedent rejects. Four
families DO clear the bar; each is documented below with the grep evidence.

## Full-file map (2296 lines before)

- 1-21: imports, module doc. **Stays** (trimmed as moves make imports unused
  — see per-move notes).
- 22-26: `export default (ctx) => {` open; `crPow` const (`ctx.transform.
  optimize?.crPow`) — used throughout the WHOLE file (deps table, `emitPow`,
  `math.pow`/`math.pow_core`/`math.pow_fold` kernel selection, the SIMD
  block's `pow_fold_v` gate). **Stays**, highest fan-out const in the file.
- **27-37: random-seeding const trio** (`rngEntropy`/`rngSeedConst`/`wasi`) +
  their doc comment. Grep-verified (`rngEntropy|rngSeedConst|wasi\b` across
  the whole file): used ONLY by the random family (below). **MOVES**.
- 38-70: `deps({...})` — the stdlib deps table. Flat name→name[] data,
  location-independent (matches both precedents: "doesn't force anything to
  stay together"). Includes `'math.sumPrecise': [...]` — stays here even
  though sumPrecise's registration moves, exactly as the precedent kept
  collection.js's/array.js's deps maps intact when their generators moved.
  **Stays.**
- 71-267: general JS emit-helpers used file-wide by the emit-dispatch layer
  below (`f`, `isIntCertain`, `isBoundName`, `isSinCoreFastPath`, `fInt`,
  `stripCanon`, `fn`, `canon`, `pureF64`, `sameIR`, `nonNegF64`, `sqrtIR`) +
  the 8 `math.PI`/`E`/`LN2`/… constant-fold emits + `emitArrayReduce` + the
  built-in-wasm-op emits (sqrt/abs/floor/ceil/trunc/min/max/round/fround).
  Deeply interconnected, high fan-in both ways — matches the precedent's
  "general primitives… stays" verdict exactly. **Stays.**
- 271-**517**: registration calls — sign/trig/hyperbolic/exp/log reg()
  one-liners, the POW JS-level fold ladder (`POW_FOLD_MAX`/`get`/`constInt`/
  `foldPow`/`constNum`/`powCall`/`exp2Call`/`emitPow`, ~155 lines — the
  compile-time constant-exponent fast paths), cbrt/sumPrecise/integer-ops/
  random reg()s. This is math.js's own "Method emitters"-equivalent
  dispatch bulk (string.js precedent's term) — every piece calls back into
  the 71-267 helpers. **Stays**, except the two carve-outs below
  (sumPrecise's reg(), random's reg() — each moves as one half of an
  otherwise-self-contained family whose other half lives in the WAT
  section).
- 519-2295: "WAT stdlib implementations" (the file's own `// ====` marker).
  f16round/sign (tiny, single-function, no family — **stays**), trig scalar
  kernels, the SIMD family, exp/log family, the crPow pow-transcend kernel,
  pow/pow_scalbn/pow_core/pow_fold, atan-family, cbrt/fifthroot/isFinite,
  hypot, sumPrecise's WAT body, math.random's WAT body + globals. **Stays**
  except the four carve-outs below.

## Family 1 — correctly-rounded pow kernel (995-1502, ~500 lines)

**MOVES** to `module/math/pow-transcend.js`.

Grep-verified (`powMkBuilder|powResolvePool|powSplit\b|powTwoSum|powTwoProd|
powAbsorb|powFoldK|powMulExtDouble|powMulExt\b|powAddExt|powDivExt|
powHornerExt|powFrexpGen|powLog1pCheapGen|powLog2ExtGen|powExp2ExtGen|
genPowTranscend|POW_LOG2_T|POW_EXP2_T|POW_LOG_N_DD|POW_LOG_N_TD|
POW_EXP_N_DD|POW_EXP_N_TD|POW_LOG2_ABS_ERR|POW_EXP2_REL_ERR|POW_LOG_SERIES|
POW_EXP_SERIES|POW_LOG2E|POW_TOK_1|POW_TOK_2|POW_SPLITTER|powHexToBytes`,
80 occurrences total): every single hit falls between line 1058 and 1501 —
none outside. The block is already delimited by the ORIGINAL author's own
comment ("The entire correctly-rounded kernel below … is built and
registered ONLY when `optimize.crPow` is set") and by the `if (crPow) {`
(1002) / `} // if (crPow)` (1502) it's wrapped in — same shape as
typedarray.js's SIMD-map section, the cleanest of either precedent's cuts.

Boundary decision: the wrapper `if (crPow) { … }` (1002/1502) and its
rationale comment (995-1001, explains why the WHOLE section — not just the
`wat()` call — is gated) **stay** in math.js as the call site; the interior
(1003-1501) becomes `export const registerPowTranscend = () => { … }`,
called as `registerPowTranscend()` inside the unchanged `if (crPow) {}`.
Needs only `wat` (bridge.js) and `ctx` (for the two
`ctx.runtime.pow{Log2,Exp2}Table =` assignments) — no IR helpers at all,
zero coupling to math.js's `f`/`fn`/`canon`/`emit`/`typed` layer (pure
WAT-text generation from its own `Builder` abstraction).

Separately, `math.pow_fold`'s block (1833-1849, ALSO `if (crPow) {}`) is
**declined**: it's a 17-line `wat()` call that only invokes `$math.pow_
transcend` **by WAT name** (a runtime dep, no JS symbol), sits naturally
beside `math.pow`/`math.pow_core` (its real neighbors), and its own comment
is written against `emitPow`'s ladder — moving it would fragment the "pow"
JS-adjacent cluster for no coupling benefit (mirrors the precedent declining
to chase every low-fan-in scrap).

## Family 2 — trig coefficient tables + SIMD f64x2 variants (563-572, 642-796)

Two-piece extraction (leaf + consumer), mirroring `elem-tables.js` ←
`simd-map.js` exactly (STRIDE/SHIFT/LOAD/STORE needed by both typedarray.js
and simd-map.js → pulled to a zero-dependency leaf to avoid a cycle).

**2a. `module/math/trig-tables.js`** (563-572, 10 lines): `SIN_C`/`COS_C`/
`EXP2_C` (minimax coefficient tables, fit by `scripts/minimax-trig.mjs`) +
`PI`/`INV_PI`/`HALF_PI`. Grep-verified fan-out: `SIN_C`/`COS_C` used at
604/627 (scalar `sin_core`/`cos_core`, BEFORE line 642) and 675/678 (SIMD,
INSIDE 642-796); `EXP2_C` at 814 (scalar `exp2`, AFTER line 796) and 785
(SIMD); `PI`/`INV_PI`/`HALF_PI` at 595-623 (scalar sin/cos_core), 661-664
(SIMD `reduce2`), and 1921-1950 (`acos`/`atan2`, far below, PI/HALF_PI only
— NOT `INV_PI`). Three consumers spread across the whole WAT section, zero
dependencies of its own (pure `Math.PI`-derived arithmetic + literal
arrays) — a true leaf. **MOVES.**

`horner` (560-562, the scalar Horner-string builder) stays in math.js: used
only at 604/627/814, never inside the SIMD block (which builds its own
`horner2`) — no reason to move it.

**2b. `module/math/simd.js`** (642-796, 155 lines): `splat`/`horner2`/
`reduce2`/`signClamp` (local helpers, used ONLY 655-796) + the `wat()`
registrations for `math.sin2`/`cos2`/`pow2`/`pow_fold_v` (itself
`if(crPow){}`-gated, verbatim)/`atan2_2`/`hypot_2`/`cbrt_v`/`fifthroot_v`/
`log_v`/`exp2_v`/`exp_v`. Delimited by the author's own comment banner
("── f64x2 SIMD sin/cos — both lanes through one polynomial ───"). No
back-reference from math.js: every non-SIMD consumer of these WAT functions
reaches them by **name** (`src/optimize/vectorize.js`'s PPC_CALL2 lifts, per
`pow2`'s own comment), never a JS symbol — so math.js needs nothing back
from `simd.js`, keeping the graph a one-directional star:
`trig-tables.js` ← `math.js`, `trig-tables.js` ← `simd.js`. **MOVES.**

## Family 3 — Math.sumPrecise (479-496 + 2097-2274, 196 lines, 2 cuts)

**MOVES** to `module/math/sum-precise.js`. Grep-verified: every `sumPrecise`
occurrence outside the deps-table entry (line 69, stays — flat data) falls
in these two ranges. Zero shared helpers with anything else in math.js —
doesn't touch `f`/`fn`/`canon`/`isIntCertain`/etc., only generic imports
(`typed`/`asF64`/`emit` from ir.js/bridge.js, `err` from ctx.js,
`PTR`/`TYPED_ELEM_BIGINT_FLAG` from layout.js — the LAST of which becomes
**wholly unused** in math.js post-move, its import line dropped entirely).
Own ECMA-262 §Math.sumPrecise citation, own 2304-bit fixed-point-accumulator
algorithm, calls nothing but WAT-level `$__ptr_type`/`$__ptr_offset`/
`$__len`/`$__alloc`/`$__typed_get_idx`/`$__ptr_aux` (the deps-table entry).

## Family 4 — Math.random / seed (27-37 + 506-517 + 2082-2095 + 2276-2294, 4 cuts, 45 lines)

**MOVES** to `module/math/random.js`. `rngEntropy`/`rngSeedConst`/`wasi`
(family-only per Family-header grep above) + `reg('math.random', …)` (JS
emit, calls `hostImport` — becomes unused in math.js post-move) + the
`rngSeedPrologue` const + `wat('math.random', …)` + the two `declGlobal`
calls + `wat('__rng_seed', …)`. Interleaved with `sumPrecise`'s own WAT body
in the original (2082-2095 random, then 2097-2274 sumPrecise, then
2276-2294 random again) — same multi-cut shape the precedent's own
`array/callback.js` used (3 non-contiguous source ranges), verified the same
way: each cut mechanically sed-extracted and diffed byte-identical on its
own before being concatenated into the new file.

## Declined (considered, not extracted)

- **Integer ops** (`math.clz32`/`math.imul`, 2 one-liners) — far below the
  "family" bar, already minimal, embedded in the general built-in-op
  cluster that stays.
- **`fround`/`hypot`/`cbrt`** as a group — `fround` has no `wat()` body at
  all (one inline instruction combo, part of the interconnected built-in-op
  cluster); `hypot`'s/`cbrt`'s JS reg()s use the same shared `fn`/`f`
  helpers as every other one-line trig/exp reg() — pulling them out would
  cut into the "stays" dispatch bulk for a ~30-line win with no
  self-contained boundary. `hypot`'s/`cbrt`'s WAT bodies are individually
  clean but there's no author-drawn grouping tying them together or setting
  them apart from `atan`/`asin`/`sinh`/etc., which have the identical
  shape and are demonstrably more numerous — cutting just these two would
  be arbitrary.
- **Constants** (`math.PI`/`E`/`LN2`/`LN10`/`LOG2E`/`LOG10E`/`SQRT2`/
  `SQRT1_2` emits, 8 one-liners, lines 201-208) — genuinely self-contained
  but too small to justify a file on its own (mirrors the precedent
  declining collection.js's `numConstLiteral`/`ASCII_KEY` block: "moving
  would force [the caller] to import back a pile of one-off constants for
  no benefit").
- **trig / exp-log / pow-core-ladder as their own files** — considered and
  rejected; see "Shape difference" above. No author-drawn sub-boundary, and
  they cross-call each other by WAT name throughout (tan→sin+cos, sinh/
  cosh/tanh/asinh/acosh/atanh→exp/log/isFinite, acos→asin, atan2→atan) —
  exactly the "deeply interconnected, stays" shape both precedents leave
  alone (string.js's Method-emitters bulk, array.js's map/filter/reduce
  core).
- **De-duplication (task step 3):** none found. The file already routes
  every shared shape through one generator (`horner`/`horner2` for
  Horner-form polynomials, `minmax` for min/max, `foldPow` for the
  square-and-multiply ladder) — no duplicated template text survived the
  original authors' own DRY pass.
- **Dead code (task step 4):** none found. Every top-level name defined in
  the closure has at least one other use site (grep-verified during the
  mapping pass above); unlike array.js's `arrMethod`, math.js has no
  zero-call-site leftover.

## Commits

(filled in as each move lands)

## Verification

- Each move: exact line ranges sed-extracted from a pristine copy of
  math.js and diffed byte-identical against the new file's body (mechanical
  script, not hand-retyping) before the edit is considered done.
- `resolveModuleGraph('bench/jz/jz.js', { resolveNode: true })` re-run after
  every move (matches the precedent's own check) — must resolve with no
  `Circular import` error and a module count that climbs by exactly 1 per
  new file.
- `node scripts/refactor-oracle.mjs check --ref 3e960ee8` after every
  commit — must report CLEAN (560/560).
- Full battery at the end: oracle clean; `node test/index.js` (excl.
  bench-c.js); kernel build + `JZ_TEST_TARGET=jz.wasm node test/index.js`;
  `node test/kernel-parity.js` (33/33); `node test/kernel-oracle.js`
  (14/14); `node scripts/bench-size.mjs --json` byte-identical; kernel byte
  count before/after.

(Numbers filled in below once the battery runs.)
