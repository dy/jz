# Unified declarative type inference — design

## Premise (verified, not assumed)

jz infers value types from plain JS usage. Today this works but lives in **four
disjoint mechanisms** with three different walk idioms. The goal: one declarative
substrate, every inference a table row, no behavior regression — plus three new
capabilities the user asked for (default-value hints, strict boundary checks,
string-accumulator fix).

### Soundness axis (the one rule that governs everything)

An inference may set a param/local's `val` only from a **type-exclusive** signal —
one whose presence is impossible (traps, or is JS-observably different) for any
other type. Verified empirically:

- `.charCodeAt`/`.push` — trap on wrong receiver → exclusive ✓ (already used)
- `xs[i]=v` index write — silently dropped on a string → proves not-string ✓
- `x + y` — coerces, defined for all types → NOT exclusive ✗ (correctly excluded)
- `o.foo` read — `(42).foo` is `undefined`, defined → NOT exclusive ✗
- `x[0]` / `x['a']` — `'h'[0]`/`'h'['a']` defined → NOT exclusive ✗
- default value `(s='')` — overridden by any non-undefined arg → NOT a *proof*,
  but IS an *intent hint* (see below) ✓

The numeric path is the exception jz already chose: `f("5")` on `(x)=>x+1` returns
`6`, not `"51"`. Passing a string to a numerically-used param is **out of
contract**. That decision is what makes "default = hint" and "strict = error"
coherent.

## Current state — the four mechanisms

| # | Mechanism | File | Walk idiom | Output | Declarative? |
|---|-----------|------|-----------|--------|--------------|
| 1 | `registerEvidence` ladder | infer.js | shared `(body,names)→Map` | `{val}`/`{notString}` | ✅ |
| 2 | `paramAllUsesNumeric` | index.js:581 | bespoke + alias-fixpoint + closure-recurse | bool (2-level: proven) | ❌ |
| 3 | `analyzeValTypes` | analyze.js | giant per-decl walk, mutates reps | many fields | ❌ |
| 4 | flow refinements | emit.js | per-branch typeof/isArray | scoped `{val,notString}` | ~ |

Mechanism (1) is the intended substrate — its own header calls it "the evidence
ladder." (2) is the same *concept* as `methodEvidence` (all-uses-agree) but
implemented once, narrowly, for NUMBER, outside the registry. (3) is structural
JSON/array-shape and stays (it shares the canonical typed-elem/schema walk; lifting
it would duplicate machinery — see infer.js:20). (4) is per-branch and correctly
separate.

### What (2) knows that (1) doesn't (must preserve)

- **copy-alias fixpoint**: `let T = t; …T…` — T's uses count for t
- **closure recursion**: `let s=(f)=>…t…` — captured-param uses count
- **two-level verdict**: must *prove* numeric. `new Float64Array(p)` is
  type-*compatible* but not *proving* — it must NOT trigger NUMBER (would the
  param be the array, or its length? ambiguous). `methodEvidence` has no such
  level because its signals are self-proving.

## Target — one declarative engine

### A. A use→fact table

```
USE_FACTS = [
  { kind: 'method',  set: STRING_ONLY_METHODS, fact: {val: STRING}, proving: true },
  { kind: 'method',  set: ARRAY_INDUCERS,      fact: {val: ARRAY},  proving: true },
  { kind: 'method',  set: ARRAY_ONLY_POISON,   poison: STRING },     // poisons, no induce
  { kind: 'numOp',   set: NUM_BIN_OPS,         fact: {val: NUMBER}, proving: true },
  { kind: 'indexW',                            fact: {notString:true} },
  { kind: 'typeofGuard',                       poison: '*' },         // stays polymorphic
  …
]
```

### B. One walk that classifies every mention (already exists: `scanBindingUses`)

`scanBindingUses` (analyze-scans.js:158) already produces the `USE.*` taxonomy
per binding with alias handling. The unified source consumes *that* instead of
re-walking. Closure-capture + alias are already modeled there (USE.CAPTURE).

### C. One reducer: uses → fact, with poison + proving

```
allUsesAgree(uses) →
  collect contexts; any poison → drop; require ≥1 proving use; all agree → fact
```

Registered as a single evidence source. `paramAllUsesNumeric`'s three call sites
become reads of this source's result.

## New capabilities

### 1. Default value as intent hint — SOUND ONLY UNDER STRICT (verified)

**Empirical finding that reframes this whole item:** a default value is NOT
type-exclusive. `(a=[]) => a[0]` called `f("hi")` returns `"h"` today (string arg
overrides the `[]` default; param stays polymorphic; string indexing honored). If
we narrowed `a` to ARRAY from the default, `f("hi")` would read string bytes as
array elements → miscompile.

So `(x=0)`/`(s='')`/`(a=[])` defaults can only seed the param TYPE when something
guarantees no conflicting arg reaches it. Two regimes:

- **Non-strict**: a caller may pass any type (the default only fills `undefined`).
  Default is NOT standalone proof. It may only *corroborate* a usage proof (which
  already narrows on its own — so no new win). The existing jsstring path
  (narrow.js:1085) already works this way: `hasStringDefault` is accepted ONLY
  alongside `paramAllUsesJsstringMappable` (all uses string-compatible).
  → For non-strict, default-hints add ~nothing beyond what usage already gives.
  Numeric defaults especially: `(x=0)=>x+1` already compiles optimally.

- **Strict**: if strict REJECTS a conflicting-type arg at the boundary (item 2),
  the default's type becomes a guaranteed contract → narrowing is sound. This is
  why the two asks are ONE feature: the hint is sound *because* strict enforces it.

**Conclusion:** implement item 2 (strict boundary type-check) FIRST; it is the
primitive that makes default-as-contract sound. Then, under strict only, a typed
default (or a usage proof) narrows the param. Non-strict keeps today's
usage-only behavior.

### 2. Strict mode: error on wrong-type args at the boundary

Today strict mode does NO arg-type checking (verified). Since a typed param is now
a contract-ish intent, strict mode should reject a *statically* wrong call:

```
const f = (x = 0) => x + 1
f('hi')   // strict: error "numeric param 'x' received string"
```

Only fires when the caller's arg type is *statically known* and *conflicts*. Keeps
non-strict permissive (current behavior). Scope: intra-module call sites where
paramReps already resolves arg types.

### 3. String-accumulator re-coercion (the measured gap)

`s += a; s += b` emits 4 `__to_str` (needs 2). `let s=''` → s is STRING (proven by
`.length` path) but the `+` emitter's `strOperand` re-coerces the proven-STRING
left operand. Fix: `+` consults `valTypeOf(lhs)===STRING` → skip `__to_str` on it
(mirror the `.length` path that already does). Independent of the unification;
ship alongside.

## VERIFIED OUTCOME (this session)

Empirical investigation changed the conclusion materially — recorded here so it
isn't re-litigated:

- **Default-narrowing already works for INTERNAL functions, soundly.** The
  `paramReps` `val` lattice (narrow.js:732) already computes a per-param consensus
  kind across all call sites, AND substitutes the default's type for an omitted
  arg (mergeRule.missing → inferValAtSite(def)). So `const g=(a=[])=>a.length`
  called with `g([1,2])`/`g()` already drops poly `__length`; `g(x)` (untyped
  forward) correctly keeps it. Verified across array/number, omitted/typed/mixed,
  and transitive chains. Locked with 3 regression tests in test/inference.js.

- **Exported numeric defaults are already optimal** — usage inference + the
  `wrapVal` boundary handle `export (x=0)=>x+1`. Nothing to add.

- **Exported array/object default narrowing is UNSOUND and correctly NOT done.**
  `export f(a=[])=>a.length` must stay polymorphic: external `f("hi")` →
  `"hi".length===2` is valid JS; `.length` is string/array-polymorphic and the
  default does not prove the runtime value's type. The string-default case narrows
  ONLY because it flips to the jsstring externref carrier (boundary marshals a real
  string); there is no analogous carrier for array/object, so no sound narrowing.

- **Net: the sound, unblocked slice of default-as-hint is ALREADY realized.** No
  new narrowing was added (any would be unsound). Value delivered = locking the
  existing behavior with tests + the strict boundary check (committed separately).

- **The remaining unify (fold paramAllUsesNumeric into the registry) stays
  blocked** on the uncommitted index.js generalization. Do it once that lands.

## Order of work (each step test-green before next)

1. Build `allUsesAgree` source from `scanBindingUses` + table; register it.
2. Re-point `paramAllUsesNumeric`'s 3 call sites to the source; delete the bespoke
   walk once WAT-identical. (behavior-preserving; golden-size pinned)
3. Default-value hints (numeric/array/object; string already partly there).
4. Strict boundary type errors.
5. String-accumulator `+` fix.
6. Regression tests per step; full suite + golden sizes green.

## Risks

- **Golden sizes**: (2)→source must be WAT-identical or sizes shift. Pin first.
- **Two-level proving**: lose it → `new TypedArray(p)` mis-fires NUMBER. Encode
  `proving` in the table.
- **Hot path**: analyzeValTypes runs per-function; the unified source must not add
  a second full walk — reuse `scanBindingUses`' cached result.
