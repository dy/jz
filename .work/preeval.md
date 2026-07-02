# Pre-eval campaign — brief (user-mandated)

GOAL: jz detects statically-evaluable source, pre-evaluates it at compile time,
compiles only the residue. static-eval pushed to the limit.

USER DIRECTIVES:
- Metric #1: watr's INSTR table fully statically pre-evaluated and resolved in
  the self-host kernel (init snapshotting → data segment, no init-time build).
- IIFEs are static-eval candidates too.
- THE DREAM: enhanced precision — fold constant formula chains with RATIONAL /
  extended-precision arithmetic at compile time, round ONCE at the end
  ("carry float precision down the formulas"). Deliberate, documented
  improvement over per-op f64 rounding; option-gated off for bit-exact-vs-JS.

TIERS:
1. Pure-expression folding: numeric chains (rational carry), string
   concat/slice/case, bool/null folds, dead branches, pure-fn calls with
   constant args (execute module/math.js JS-side for bit-exact transcendentals),
   IIFE collapse.
2. Static object/array trees → schema slots + data segments.
3. Module-init snapshotting (V8-snapshot style): run top-level init at compile
   time, serialize the heap into the data segment. Kills warm-boot cost,
   shrinks __start, eliminates init-vs-runtime storage bug class. INSTR = the
   acceptance test.

GUARDS: fold only through proven purity (isPureFnCall etc.); never through host
imports/Date/random/observable effects; differential fuzz stays the floor
(rational-fold divergence documented + gated).

EXISTING SUBSTRATE: static.js (staticValue/staticPropertyKey/staticObjectProps),
bindStaticGlobal, intConst interproc consts, unrollSmallConstFor, forInUnroll,
watr const-fold. Unify — one preEval pass over prepared AST, fixpoint.

## AFTER pre-eval — standing perf goals (user, 2026-07-02)
- jz.wasm self-compile beats jz.js (stands; pinned in test/selfhost-perf.js)
- jessie.wasm bench cases FASTER than jessie.js — needs a pin
- watr.wasm FASTER than watr.js — needs a pin

---

# Capability plan (expanded)

Every pre-evaluable construct class jz can fold, grouped by tier, with its
purity precondition and precision policy. Tier 1 is IMPLEMENTED (this
campaign); Tiers 2–3 are planned, not built.

Implementation: `src/prepare/pre-eval.js` (the pass) + `src/prepare/math-kernel.js`
(bit-exact JS mirrors of module/math.js's transcendentals). Wired into
`index.js`'s `jzCompileInner`, immediately after `prepare()` and before
`compile()`. Tests: `test/preeval.js`.

## Tier 1 — pure-expression folding (IMPLEMENTED)

For every row: **purity precondition** = what must be statically proven before
folding; **precision policy** = whether/how the fold can diverge from naively
compiling the unfolded source, and why that divergence is safe.

| Construct class | Purity precondition | Precision policy |
|---|---|---|
| Numeric `+ - * /` chains | Every leaf is a literal number (or the result of another fold in the SAME expression tree — never a variable reference, see boundary below) | **Rational carry** (default ON, `optimize.rationalConst !== false`): each literal seeds an exact `n/d` BigInt rational (every finite f64 IS exactly representable); `+-*/ ` combine exactly; the f64 result is materialized via a 60-digit decimal expansion fed through the host's correctly-rounded string→Number parser, ONCE, at the point the chain stops. A zero rational result recomputes via plain f64 (BigInt has no signed zero — `x+(-x)`→+0, `0*-1`→-0 need real IEEE arithmetic, not a rational reconstruction). A non-finite rational (true overflow of the EXACT formula) is kept, not rejected — that's the accuracy win, not a bug. `rationalConst:false` → plain sequential per-op f64 folding instead (still shrinks WAT; bit-exact vs naive JS evaluation of the same expression) |
| `%`, `& \| ^ << >> >>>` | Same | No rational tracking (JS `%`/bitwise ops are basic ECMAScript operators jz targets exactly, not an approximated algorithm) — plain op, still folds to a literal |
| `**` / `Math.pow` | Both operands literal-foldable | NOT part of the rational system — routed through math-kernel.js's `pow`, which mirrors emit.js's OWN existing constant-arg fast path exactly (integer `\|n\|<=16` → square-and-multiply per `foldPow`; exponent `0.5` → `Math.sqrt`; else → host `Math.pow`). Zero new divergence: this is what compiling the unfolded literal expression already produces today |
| `u- u+ ! ~` | Operand literal-foldable | `u-`: exact (BigInt negation, with the same signed-zero fallback as above). `u+`: ToNumber (num/bool/null/undef only — see string exclusion below). `!`: ECMAScript ToBoolean, exact. `~`: ToInt32 + native `~`, exact |
| `< > <= >= == != === !==` | Both operands literal-foldable, non-ASCII strings excluded | Delegates to the HOST `<`/`==`/`===`/... operator directly on the unwrapped JS primitive — this literally IS the Abstract Relational/Equality Comparison algorithm both JS and jz target, no hand-rolled coercion table needed |
| String `+` concat | BOTH operands already string-typed (not string+number) | Exact (`'' + a + b`, the same fresh-accumulation pattern prepare's own `staticStringExpr` uses, defensive against the self-host transient-storage landmine). Mixed string+number `+` is DELIBERATELY NOT folded: the self-host kernel's `${number}` stringification (`__ftoa`, module/number.js) is a 9-significant-digit dtoa, while host JS `String(number)` is shortest-round-trip — folding via host ToString could bake a MORE PRECISE string than the unfolded kernel path would ever produce. A real, load-bearing divergence risk, not paranoia — left for Tier 2+ if the kernel's own ToString is ever proven to match |
| `.toUpperCase() .toLowerCase() .trim() .slice() .charAt() .indexOf() .length` | Receiver (and any string arg) is ASCII-only (`/^[\x00-\x7F]*$/`) | Host method IS the reference (ASCII byte-per-char makes UTF-8 jz and UTF-16 JS agree exactly). Non-ASCII is excluded, not approximated — jz's `.length`/`.slice` are BYTE-indexed (UTF-8), JS's are UTF-16-code-unit-indexed; folding via host semantics for a non-ASCII string would silently bake in the WRONG (JS-shaped) value. Confirmed empirically: `"héllo".length` is 5 in JS, 6 in jz |
| `&& \|\| ??` | Condition literal-foldable AND both branches independently reduce to a literal of the SAME EvalResult type | jz's `&&`/`\|\|` is value-preserving at runtime (returns whichever raw operand won, untyped) and deliberately does NOT re-narrow the result to the picked operand's own type when the two operands' types differ (`5 && true` crosses the host boundary as the numeric carrier `1`, not JS `true` — a documented gap, test/booleans.js). Folding to a literal of the picked operand's own type would be MORE precise than that runtime behavior — a real divergence. So the fold requires BOTH branches to independently prove out (an un-reachable-at-compile-time branch has an unknown type, which is exactly the unsafe case) and to agree in type |
| `?: ` / `? a : b` | Same as above | Same reasoning/guard as `&&`/`\|\|` |
| `if (COND) A else B` (statement) | `COND` literal-foldable | Splices the LIVE branch's statement list in place of the whole `if`, dropping the dead branch — no value/type-narrowing concern (pure statement-list surgery, not a typed value fold) |
| `while (false) { … }` | Condition literal-false | Removed entirely |
| Pure `Math.*` calls, host-exact set: `sqrt abs floor ceil trunc round fround sign min max imul clz32` + `PI E LN2 LN10 LOG2E LOG10E SQRT2 SQRT1_2` | All args literal-foldable | Host `Math.*` directly. Each is proven bit-exact vs the compiled kernel by construction: sqrt/abs/floor/ceil/trunc are IEEE754-mandated correctly-rounded in BOTH JS and wasm (no implementation freedom); the 8 constants are literally embedded via `f64.const ${Math.PI}` using the SAME host Math at compile time already; round/sign/imul/clz32/fround/min/max are WAT bespoke-engineered specifically to reproduce host JS semantics (module/math.js's own comments document each) |
| Pure `Math.*` calls, bespoke-algorithm set: `sin cos tan exp expm1 log log2 log10 log1p atan asin acos atan2 sinh cosh tanh asinh acosh atanh cbrt hypot` | All args literal-foldable | `src/prepare/math-kernel.js` — a literal op-for-op JS transliteration of each `wat('math.X', …)` body (same operand order, same parenthesization — float ops aren't associative, reordering changes the answer). f64 arithmetic in JS is IEEE754 binary64 exactly like wasm's, so the port is bit-identical wherever the shape matches. Validated empirically: 100% bit-exact match (differential harness, `n`≈1050 samples across all these functions incl. NaN/±Inf/±0/subnormal edges) against actually compiling+running the equivalent literal-arg source through the real kernel. Deliberately NOT host `Math.sin` etc. — those differ from jz's minimax/Newton approximations in the last ulp by design |
| Zero-arg pure function call collapse (subsumes IIFE collapse) | Callee has 0 declared params, 0 args at the call site, no `rest`/`defaults`; its OWN body — evaluated in a FRESH, EMPTY env (no outer capture) — is a `let`/`const` chain of literal-foldable initializers ending in exactly one `return`; ANY other statement shape (if/for/while/throw/expression-statement/reassignment) bails, unfolded. Self-/mutually-recursive 0-arg calls are cycle-guarded (never infinite-loop, never fold) | Exact — this is why "IIFE collapse" needed no special-casing: `lift-iife.js` already turns every `(() => EXPR)()` into a 0-param top-level function + a 0-arg call BEFORE `prepare()` even runs, so by the time preEval sees it, a literal IIFE and an ordinary user-authored `let helper = () => {...}; helper()` are the SAME shape, same code path |

### Tier 1 — proven-unsafe boundary (why NOT to inline named-variable references)

The one capability Tier 1 does **NOT** have, despite being "obviously safe" on
first look: `let x = <const>; …later use of x…` → substituting `x` with its
value at every later reference (as opposed to just folding `x`'s OWN
initializer expression, which Tier 1 DOES do). An early revision implemented
this (a `Map<name, EvalResult>` `env` threaded through the whole rewrite) and
it regressed FOUR independently-discovered classes of existing optimizer/
codegen decisions before being deliberately removed:

1. **Schema/dynProps key classification** (`static.js` `staticPropertyKey`/
   `staticIndexKey`) — `prepare()` classifies `o[k]` as static-vs-dynamic
   property access from the SOURCE shape, in source order, and records that
   classification (e.g. into for-in's dynamic-key bookkeeping) before preEval
   ever runs. Rewriting `k` to a literal post-hoc makes `o[k]` LOOK static to
   anything reading the tree downstream while every fact prepare recorded
   still says "dynamic" — repro: `let k='z'; o[k]=2; for (p in o) …` silently
   dropped the dynamically-added key from enumeration.
2. **Object-literal shorthand key/value conflation** — `{a, b}` desugars to
   `[':', 'a', 'a']` (the SAME bare identifier in both the key slot and the
   value slot). A generic "substitute every bare-name reference" walk cannot
   tell the two apart and rewrites the property NAME too, not just its value —
   repro: `{a, b}` with `a`,`b` constants silently became `{10: 10, 20: 20}`.
3. **Module-global reassignment blindness** — a module-level `let` is a
   shared global; it can be reassigned from INSIDE any `ctx.func.list`
   function body (a completely separate tree — top-level arrows are extracted
   out of the module AST). A same-scope-only `isReassigned` scan can't see
   that and wrongly treats the global as constant — repro: `let picks=0; let
   pick=()=>{picks++; return X}; class Y extends pick(){}` folded `picks` to a
   permanent `0`.
4. **Loop-shape-sensitive pattern matching** — several EXISTING passes
   recognize a loop by its SYMBOLIC bound/index shape, not by value: the
   multi-pixel SIMD blur matcher and clamp-peel vectorizer's own loop-shape
   match, `unrollSmallConstFor`'s trip-count recognition, watr LICM's post-
   inline invariant recognition. Replacing `for(k=-rr;k<=rr;k++)` or
   `row=y*ww` with their literal values is value-identical but silently swaps
   which of those shape-sensitive passes fires (observed: SIMD lane-
   vectorized blur → fully-unrolled scalar loop, ~20% WAT growth on that
   shape — exactly the "shrink, never grow" gate this campaign is held to).

Given that discovery pattern (four independent, structurally-unrelated
regressions from ONE capability, each requiring a real compiled-vs-baseline
A/B to even notice), general named-reference inlining is OUT of Tier 1's
proven-safe boundary. What Tier 1 keeps: `[]` index/member keys, `:`
object-literal property keys, and `for`-loop heads (init/cond/step) are never
rewritten by the tree-walk even when nothing else is at risk — the three
`foldNode` guards (`op==='[]'`, `op===':'`, `op==='for'`) exist specifically to
hold this line, so a FUTURE, more careful Tier-2 SSA-with-liveness pass has a
documented, tested boundary to reason from rather than rediscovering these
four the hard way again.

`evalFunctionBodyConst`'s zero-arg-call evaluator is exempt from this
boundary and safely DOES do name→value substitution: its `env` is scoped to
one function's own body, freshly empty on every call, never escapes, and the
whole point is reducing that one body to a single value — none of the four
failure classes above can arise (no cross-function visibility, no shorthand
object-literal desugar re-use of the substituted position, no loop to
mis-shape, since the body must be a straight-line `let`/`const`-then-`return`
chain or it bails).

## Tier 2 (planned, not built) — static object/array trees

- **Construct class**: object/array literals whose every property/element is
  itself Tier-1-or-Tier-2-foldable → hoist to a schema slot backed by a
  read-only data-segment record instead of runtime `__alloc`/`__mkptr`/field
  stores.
- **Purity precondition**: no computed keys with non-literal-foldable
  expressions, no spread of a non-static source, no getter/setter (jz already
  rejects those), the binding must be provably never-mutated in place
  (`arr.push`, `obj.x = …`) — mutation after construction is legitimate JS and
  must still work; only the INITIAL allocation moves to the data segment.
- **Precision policy**: none (no floating-point rounding decisions — this
  tier is about ALLOCATION strategy, not arithmetic). The only "policy" is
  aliasing: two structurally-identical static literals may or may not share
  one data-segment record (mirrors the existing `static literal: read-only
  literals keep the shared static instance` invariant — extend it, don't
  duplicate it).
- **Relationship to Tier 1**: `evalConst`'s `EvalResult` model (`t: 'num' |
  'str' | 'bool' | 'null' | 'undef'`) has no `'obj'`/`'array'` variant yet;
  Tier 2 adds one, carrying a schema id + a flat value list, and reuses
  `static.js`'s `staticObjectProps`/`staticArrayElems`/`objLiteralSchemaId`
  (already exists, already used for schema inference) rather than
  reimplementing shape recognition.
- **New landmine class to budget time for**: this tier's fold changes
  ALLOCATION shape (heap vs data segment), which is exactly the kind of
  structural change Tier 1's boundary section above shows the codebase's
  loop/SIMD/LICM passes are sensitive to — expect a similar A/B-discovery
  cycle against `test/simd.js`, `test/optimizer.js`, and the object-shape
  tests in `test/objects.js`/`test/types.js` before landing.

## Tier 3 (planned, not built) — module-init snapshotting

- **Construct class**: the ENTIRE top-level module init sequence (every
  module-scope `let`/`const` + its initializer, in source order, including
  ones that call Tier-1/Tier-2-foldable functions), run once at COMPILE time
  and its resulting heap state serialized into the data segment — the
  self-host kernel's own `INSTR` table (`watr`'s opcode/instruction metadata,
  built today by a `__start`-time init loop) is the acceptance test named by
  the user.
- **Purity precondition**: the WHOLE init sequence must be provably free of
  host imports, `Date`, `Math.random`, external/host-object touches, and any
  effect observable before `__start` returns (`ctx.module.initFacts` —
  `dynVars`/`anyDyn`/`hasSchemaLiterals`/`hasFuncValue`/`timerNames` — already
  tracked by `prepare/index.js`'s `recordModuleInitFacts`; Tier 3 is the
  consumer that turns "provably static init" into "skip `__start`, snapshot
  the heap" rather than just an analysis fact).
- **Precision policy**: bit-exact by construction — this tier doesn't
  introduce any NEW arithmetic, it moves WHEN the (already Tier-1/2-correct)
  arithmetic runs, from module-instantiation-time to compile-time. The only
  new risk is nondeterminism: any init-time value that could legitimately
  differ between the compile-time run and the eventual runtime instantiation
  (there shouldn't be any, once the purity precondition holds, but this is
  the tier where "prove it holds" earns its keep — the self-host kernel's
  own warm-vs-cold `ctx` reset bugs, referenced in recent commit history
  — "json warm-trap … watr INSTR sidecar landmine" — are exactly the class of
  bug this tier must not reintroduce).
- **Acceptance test**: `watr`'s `INSTR` table fully resolved at compile time
  in the self-host kernel build (`scripts/self.js`/`scripts/selfhost-build.mjs`)
  — no init-time build loop in the emitted `__start`, table lives in the data
  segment from instantiation. Shrinks `__start`, kills warm-boot cost, and
  (per the user's stated theory) eliminates the init-vs-runtime storage bug
  class currently worked around by hand (see `.work/selfhost-perf-groundtruth.md`,
  the warm-trap commits).
- **NOT wired into the self-host kernel bundle in Tier 1**: `scripts/self.js`
  (what `npm run build`/`selfhost-build.mjs` actually compiles into
  `dist/jz.wasm`) does not import `prepare/pre-eval.js` — deliberately, this
  campaign. Tier 1's preEval only runs in the HOST-facing pipeline
  (`index.js`). Wiring it into the kernel's own bootstrap is exactly Tier 3's
  job (the kernel needs the FULL module-init-snapshotting story, not just
  expression folding, to make it worth the self-compile risk) and needs its
  own bit-exactness gate first: preEval's Tier-1 code uses `BigInt`/`DataView`
  (the Rational type, math-kernel.js's bit-reinterpret helpers) which have
  never been proven to self-compile through jz's own restricted subset.

---

# Tier 1 — implementation record

- **Files**: `src/prepare/pre-eval.js` (the pass — `evalConst`/`foldNode`/
  `foldStmts`/Rational), `src/prepare/math-kernel.js` (bit-exact transcendental
  mirrors), `test/preeval.js` (27 tests / 62 assertions).
- **Wiring**: `index.js` `jzCompileInner`, immediately after `prepare()`,
  before `compile()`/`detectOptimizeConfig`. NOT wired into
  `scripts/self.js` (see Tier 3 note above).
- **Option**: `optimize.rationalConst` (default `true`; `false` opts into
  plain-sequential-per-op folding, bit-exact vs naive JS evaluation of the
  same source instead of the rational-carried, more-precise answer).
- **Gates run clean** (2026-07-02, this campaign): `test/preeval.js`,
  `test/differential.js`, `test/statements.js`, `test/strings.js` all green;
  `test/perf.js` golden sizes byte-IDENTICAL to a clean pre-campaign baseline
  (2 of the 4 goldens already failed their pin on that baseline too — a
  pre-existing dependency/environment drift unrelated to this work, confirmed
  via `git worktree` A/B); `test/selfhost.js` 15/16, the one failure
  byte-for-byte reproduced on the same clean baseline (pre-existing,
  unrelated — a warm-instance-reuse OOB trap). Full suite (`npm test`):
  2644/2650, the 6 failures all independently confirmed pre-existing.
