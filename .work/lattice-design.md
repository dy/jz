# Product-lattice design — audit-#15 center (2026-08-08)

Design pass for `.work/todo.md` "PRODUCT-LATTICE CAMPAIGN — design-pass opening
brief" (line 7122), grounded in `.work/lattice-survey.md` (a212fa1f, treated as
ground truth per the brief) and `.work/research.md` §Middle-end consolidation
(line 693). Design only — no `src/` changes. Every decision below is argued
against a specific survey finding or a specific wall (`.work/carrier-
representation-design.md` §17-§22); nothing is asserted without a citation.
Written for the coordinator's mechanism review — it will not land without that
review.

**Thesis** (stated up front because it organizes every section below): the
five walls and the ten findings are not ten independent problems. They are one
category error, repeated. `possibleKinds`, `presence`, `pointsTo`, and the
carrier-boxed half of `rep` are all **existential** facts — "does some
observation put this value in kind K" — and existential facts compose by
**union**: two disagreeing observations don't cancel, they both stay true, so
the sound join is "wider," never "unknown." `numeric` (int-certainty, i32
narrowing) is a **universal** fact — "does *every* observation agree this
fits i32" — and universal facts compose by **intersection/meet**: one
disagreeing observation genuinely does falsify the claim, so poison-on-
disagreement is *correct* there, not a bug. `mergeParamFact` (`src/param-
reps.js:58-63`) and `makeValTracker`/`makeTypedTracker` (`src/compile/
analyze.js:123-132`) apply the **universal** algebra to `val` — an
**existential** question — and that mismatch is FINDING-7, and it is the
generative cause of §22's sticky-null wall. The fix is not "make TOP safer" in
the abstract; it is "give each field the algebra its own logic requires,"
which is what a genuine product lattice is *for*.

---

## 1. The Fact record

```
Fact = {
  possibleKinds: Set<VAL.*>,              // powerset, join = ∪
  presence:      boolean,                  // false=PRESENT, true=MAYBE_UNDEF; join = ∨
  pointsTo:      Set<SchemaId> | 'ALL',    // powerset + explicit top sentinel, join = ∪ / absorbing
  numeric:       { level: 0|1|2, range: [lo,hi] | null },  // MEET-semilattice, unchanged polarity
  rep:           Set<'raw'|'boxed'|'tagged'>,  // powerset, join = ∪
}
```

### 1.1 `possibleKinds` — powerset over `VAL.*`

Domain: the 14-member `VAL` enum (`src/reps.js:33-39`: `NUMBER, ARRAY, STRING,
OBJECT, HASH, SET, MAP, CLOSURE, TYPED, REGEX, BIGINT, BUFFER, DATE, BOOL`).
BOTTOM = `∅` (no observation yet — the field's initial state, same meaning as
today's `undefined` in `mergeParamFact`, param-reps.js:70). Join:
`possibleKinds(a) ∪ possibleKinds(b)`. **This is a genuine widening join, not
a meet dressed up as one**: an observed kind `k` at any site contributes the
**singleton** `{k}` to the union — never an exact "the" value the way today's
`mergeParamFact` treats `observed` (param-reps.js:60-71). Two disagreeing call
sites yesterday collapsed `val` to `null` (TOP-as-poison); today they produce
`{NUMBER, STRING}` — strictly *more* information than yesterday's outcome, not
less, and every subsequent `.has()`/`⊆` query on that set is sound by
construction (§1.4).

Height: ≤14 per key (the union can add at most 14 distinct elements before
it equals the full domain) — a hard, static bound, independent of program
size. A worklist fixpoint over `N` Fact-holding keys therefore does at most
`14·N` productive join operations before every key's `possibleKinds` is
either stable or has hit the full-domain TOP; this is the SAME finite-lattice
argument `param-reps.js:12-13`'s own height-2 proof already uses
(`meet(BOTTOM,x)=x, meet(x,x)=x, meet(x,y≠x)=TOP`), just with height 14
instead of height 2 because the new lattice tracks *which* kinds were seen
instead of collapsing to a single disagreement bit.

### 1.2 `presence`

Isomorphic to the EXISTING `mayBeUndefined` field (`reps.js`'s own doc,
survey §1.2 line 157: "monotonic OR, never un-sets once true — safe-
widening"). This field is **already sound today** under existential
semantics — it is not migrated *conceptually*, only *re-homed* onto the
unified Fact record. Height 1 (boolean, one join can only flip false→true
once). `presentVal` (the *kind when present*, `reps.js:154-158`,
poison-on-disagreement today) is **not** a separate field in this design —
it is subsumed by `possibleKinds` once `presence` is orthogonal: the awkward
`r.presentVal ?? r.val` fallback in `censusMaybeUndefinedKind` arm 3
(`kind.js:468-500`) disappears, because "kind when present" and "was this
ever undefined" stop needing to be mutually exclusive by construction
(reps.js:157's own documented asymmetry — sound for a decl-site local,
NOT sound for a param, per survey line 160-161) — with `presence` orthogonal,
that asymmetry is no longer a special case to remember, it is structurally
impossible to violate.

### 1.3 `pointsTo` — powerset over `SchemaId`, with an explicit top sentinel

This field is where §1.1's "materialize the full domain as TOP" move
**cannot** be reused verbatim, and the reason is a real asymmetry worth
stating: `VAL.*` is a fixed, 14-member, compile-time-constant alphabet.
`SchemaId` is **not** — `ctx.schema.register` is called throughout
compilation, including *inside* the hazard-collection walk itself
(`program-facts.js:1331, 1346`, both inside `collectSlotWriteHazards` —
verified directly against the tree, not inferred from the survey). New
structural shapes can mint fresh sids **while a pointsTo fixpoint is
running**. A materialized "full current sid set" TOP would therefore be
a moving target — sound at the moment it's built, silently stale the
instant a later pass registers a shape nothing observed before.

Design: `pointsTo` is `Set<SchemaId>` for every narrowed case, and the
literal string `'ALL'` for TOP — an **abstract** sentinel, never a
materialized snapshot of "every sid known so far." `'ALL'` absorbs: `'ALL' ∪
anything = 'ALL'`; membership (`pointsTo === 'ALL' || pointsTo.has(sid)`) is
correct regardless of how many MORE sids get registered later, because it
never claims to enumerate them. This is exactly today's `hz.all` shape
(`program-facts.js`'s single whole-program boolean, survey §1.4 lines
296-347) — the new design keeps its polarity and its "coarsest possible
TOP" role (§21 proved this load-bearing, survey line 319-328, **not**
narrowable) but relocates it from a bolt-on side channel (`slotWriteHazards`
has "NO seed in `ctx.js`'s `reset()` literal," survey line 252, a FINDING in
its own right) into a first-class lattice value on the SAME field every
other points-to answer lives on.

Height: bounded by "however many distinct sids the WHOLE compile ultimately
registers" — determined only after every registration pass completes, not a
static constant like `possibleKinds`'s 14. Still finite (a program has a
finite number of distinct object-literal shapes) and still monotone (only
grows via `register`, which is itself a terminating, already-audited set of
passes — prepare/index.js, plan/scope.js, static.js, program-facts.js, per
the grep above) — termination holds, the bound is just data-dependent rather
than universe-fixed. **This is the one place the design asks the coordinator
to independently confirm**: that no registration pass can itself depend on a
`pointsTo` fixpoint result (a registration→fact→registration cycle would
break the "registration terminates independently of the fact fixpoint"
premise this argument leans on). Flagged in §6.

`hz.sids`/`hz.props`/`hz.numeric` (survey lines 305-317, the SCOPED poison
channels the same two setter sites also populate) are **not** collapsed into
`pointsTo='ALL'` — they stay narrower states representable within the SAME
`Set<SchemaId>|'ALL'` shape: `hz.sids` is literally `pointsTo`'s own
non-ALL set (a write hit exactly those sids); `hz.props` (a property NAME
poisoned program-wide, independent of sid) and `hz.numeric` (a numeric-key
class poisoned independent of sid) are cross-cutting predicates that don't
fit `pointsTo` as a per-key field at all — they stay what they are today,
program-wide side predicates consulted ALONGSIDE `pointsTo`, not folded into
it. Collapsing them into the single `'ALL'` sentinel would be the FINDING-8
mistake in reverse: trading a correctly-scoped channel for a blanket one.
Flagged explicitly so no slice "simplifies" this away.

### 1.4 `numeric` — unchanged polarity, re-homed only

`{level: 0|1|2, range}` is `slotIntLevels`'s existing 3-point meet-lattice
(`program-facts.js:1602-1615`, "genuine meet, not first-wins": `next = cur
=== undefined ? level : Math.min(cur, level)`) — **not redesigned**. The
brief's constraint ("monotone join only, sets grow, never exact-flip-to-
null") targets the fields that were WRONGLY given universal/poison algebra
for an existential question (§thesis). `numeric` is genuinely universal —
"does every observed write to this slot/param fit i32" — and a
monotone-DOWN meet is the *correct*, already-proven-sound (survey lines
254-278: 64-round fixpoint cap, `err()` on exhaustion treated as a compiler
bug not a silent fail-close) mechanism for a universal claim. Forcing it into
an ascending powerset would not be unification, it would be
**unsoundness**: "level 2 (strict i32)" must mean *every* observation
agreed, and a union-style join can only ever ADD possibilities, never
subtract a disproven one — exactly wrong for this question. `range` rides
alongside `level` as the SAME pointer into the existing range-proof
machinery (research.md's induction-variable range work) — this design
re-homes the field, it does not redesign the interval algebra.

Height: the existing proof stands unmodified (program-facts.js:1696-1727).

### 1.5 `rep` — powerset over `{raw, boxed, tagged}`

Sourced from `bigintBoxed` and `carrier` (both already in `REP_FIELDS`,
`reps.js:253-258`). Existential, same as `possibleKinds`: `slotBigintObserved`
is *already* "pure OR, never resets... FAIL-OPEN on hazard" (survey line
249, "under-boxing a real BigInt is unsound but over-boxing a non-BigInt is
a harmless cost") — i.e. it is *already* the correct existential algebra,
just not expressed as a set. Join = `∪`, height 3.

`isTernaryBoxedBigint` (`ir.js:557`, `ctx.func.ternaryBoxedNames`) is
**deliberately excluded** from `rep`. Survey §2.3 (line 460-462) is explicit
that this is an emission-tier, per-function-transient decision ("its own
dedicated handler already owns box placement — a documented past
box-of-a-box bug"), not a durable fact about a binding. Folding it into
`Fact.rep` would be exactly the mistake `isTernaryBoxedBigint`'s own history
already paid for once — a durable Fact answering an inherently
per-emission-site question. It stays outside the record, as it is today.

### 1.6 FINDING-7, resolved structurally

FINDING-7 (survey lines 639-649): `!== VAL.BIGINT` is satisfied today by
BOTH "provably a different kind" and "unresolved" (`null`), and a naive
`!possibleKinds.has(VAL.BIGINT)` migration only preserves soundness if TOP
is the FULL set, not `∅` — the OPPOSITE convention from how `null` is used
as poison elsewhere. The resolution is not a rule for migrators to remember
— it's structural:

- `Fact.possibleKinds` is **never** `null`/`undefined` for a resolved key.
  It is always a real `Set`. There is no second, sentinel-typed "I don't
  know" value to compare against.
- BOTTOM (`∅`, unobserved) and TOP (the full 14-member set, "could be
  anything") are **both** ordinary members of the SAME type as every
  narrowed answer. A consumer never special-cases them.
- The only sound idiom is membership: `possibleKinds.has(VAL.X)` (may be)
  and `possibleKinds.size === 1 && possibleKinds.has(VAL.X)` (definitely
  is). At TOP, `.has(VAL.BIGINT)` is `true` for every `X` — so
  `!possibleKinds.has(VAL.BIGINT)` (the FINDING-7 pattern's replacement)
  is automatically `false` at TOP, which is the CORRECT "cannot prove
  not-BIGINT" answer, with no separate TOP-check required to get there.

**The trap to name explicitly** (so no slice reintroduces FINDING-7 in a new
shape): a shared frozen `KIND_TOP = Object.freeze(new Set(ALL_VAL_KINDS))`
singleton, reused by reference for perf when a key's set has widened to the
full domain, is a legitimate OPTIMIZATION (`fact.possibleKinds === KIND_TOP`
as an O(1) fast-path before falling to `.has()`) — but it must never become
a *required* correctness check. `.has()` must give the right answer even if
every identity fast-path is skipped or the object is a differently-allocated
Set with the same 14 members. If a future micro-optimization makes
`===KIND_TOP` load-bearing for correctness (not just speed), it has silently
reintroduced a second "TOP means something different" convention — the exact
class of bug FINDING-7 names. This is a REVIEW GATE, not a slice: any PR
touching `possibleKinds` comparisons should be checked for this specifically.

---

## 2. The key space (FINDING-6)

**No new identity type is introduced.** FINDING-6 (survey lines 630-638)
already concludes the honest minimum is "a 3-part discriminated key or three
cooperating tables" — and warns, correctly, that a single grand key would
paper over param/slot being "irreducibly different dimensions... not
alternate encodings of one underlying ID." The design below takes the
weaker, cheaper half of that disjunction: **three cooperating tables,
sharing the Fact *shape*, keyed by the SAME dimensions the code already
uses** — no unifying ID is minted at all, because none of the three
dimensions needs one:

```
BindingFacts: Map<funcName|'MODULE', Map<name: string, Fact>>
ParamFacts:   Map<funcName: string, Map<paramIdx: number, Fact>>
SlotFacts:    Map<sid: SchemaId, Fact[]>          // array-indexed by slot
```

- `BindingFacts` unifies `localReps` + `globalReps` (survey §1.2 table, lines
  132-136) by scoping on `funcName|'MODULE'` instead of maintaining two
  separately-instantiated maps — a mechanical merge, not a new concept:
  `localReps` was already "current function body only," `globalReps` was
  already "module-level" — `'MODULE'` is just the existing global scope
  spelled as a key instead of a separate object.
- `name` inside `BindingFacts` is the **bare string**, reusing Stage 1's own
  proof (`4a0102d2`, "BindingId totality") verbatim: "after an enforced
  uniqueness pass... a bare name string is already a sound proxy for a
  per-function binding identity" (survey lines 549-556, citing
  `plan/scope.js:216-217`). This design does not supersede that proof, it
  is the SAME proof, applied at the field-shape layer instead of a new
  identity layer.
- `ParamFacts`' key is **exactly** `paramReps`'s existing `(funcName,
  paramIdx)` (`param-reps.js:2`) — unchanged. `SlotFacts`' key is
  **exactly** `slotTypes`'s existing `(sid, idx)` (`program-facts.js`,
  survey §1.4 table) — unchanged.

**"Map-values" (the brief's fourth term) do not need a fourth table.**
Survey §3.1 (line 492) already shows `dictValueValType`/`mapValueValType`
living as FIELDS on the SAME `repOf(name)` record as `val` — i.e. today's
code already treats "the kind of values inside this dict/map" as an
attribute of the container's OWN binding, not a separately-keyed fact. This
design keeps that: a `BindingFact` may carry a nested `elemFact: Fact` (same
5-field shape, recursively) representing "the kind of what's stored inside,"
populated by the same union-join discipline as every other field. This
generalizes cleanly to `arrayElemSchema`/`arrayElemValType` too (already
present in `REP_FIELDS`, survey line 56-59) — one nested-Fact convention
replaces several ad-hoc `arrayElem*`/`dictValue*`/`mapValue*` field families,
without inventing a key dimension for "element of."

**Why not go further and merge `ParamFacts` into `BindingFacts` by
scoping-with-index** (e.g. `name = '#' + paramIdx`)? Because a parameter's
Fact is a **cross-call** fact (settled once per whole program, consulted by
every caller) while a local's Fact is **per-function-instance** (reset at
`enterFunc`, survey line 134) — genuinely different reset/scope lifetimes,
not just different key shapes. Folding them into one table would force one
lifetime discipline onto both, silently breaking whichever one didn't
originally own it. FINDING-6's own warning against a "grand" key applies
here specifically: the temptation to merge two SIMILAR-LOOKING key spaces
because the string happens to fit is exactly the move the survey's evidence
argues against.

---

## 3. Projection catalog

Each row: the named projection, its narrowing guarantee, and the survey §2
consumer(s) it replaces.

| Projection | Signature | Guarantee | Replaces |
|---|---|---|---|
| `kindsOf(key)` | `→ Set<VAL.*>` | sound superset of every kind ever observed at `key` | `valTypeOf`/`lookupValType` (reps.js §1.2 4-tier), `program-facts.js`'s `kindOf` closure (FINDING-3) |
| `isExactly(key, X)` | `→ bool` | true only if `kindsOf(key) = {X}` | every `=== VAL.X` site (kind.js, emit.js, ir.js, type.js) |
| `cannotBe(key, X)` | `→ bool` | true only if `X ∉ kindsOf(key)` — sound at TOP by §1.6 | every `!== VAL.X` site (FINDING-7's risk class) |
| `isDisjointFrom(key, kindSet)` | `→ bool` | true only if `kindsOf(key) ∩ kindSet = ∅` | `keyedWrite`'s `KEYED_EXEMPT_VALS` check (§17), `recvArrTyped`'s ARRAY-OR-TYPED test |
| `mayBeUndefined(key)` | `→ bool` | monotone OR, unchanged from today | `censusMaybeUndefined` boolean family (13+ sites) |
| `elementKinds(key)` | `→ Set<VAL.*>` | same guarantee as `kindsOf`, over the nested elemFact | `dictValueKindOf`/`mapValueKindOf` |
| `pointsToSet(key)` | `→ Set<SchemaId>|'ALL'` | sound superset (or the abstract top) of every sid `key` could alias | `sidOf` ×3 duplicates, `chainSid`, `program-facts.js`'s `kindOf` receiver half (FINDING-9) |
| `isHazarded(key, prop)` | `→ bool` | `pointsToSet(key)==='ALL' \|\| pointsToSet(key).has(sid) \|\| propPoisoned(prop) \|\| numericKeyPoisoned` | `slotHazarded` (module/schema.js:247-254), unchanged logical shape |
| `intCertainty(key)` | `→ 0\|1\|2` | meet-sound (§1.4, unmodified) | `slotIntCertainAt`/`slotI32CertainAt`/`repOf().intCertain`/`curParamIntCertain` |
| `repClass(key)` | `→ Set<'raw'\|'boxed'\|'tagged'>` | existential, sound superset | `isProvenBoxedBigint`/`isCurrentlyBoxedBigint`/`slotBigintBoxedBySid`/`slotBigintProvenBySid` |

### 3.1 §17 — `keyedWrite`'s two independent gaps, traced through the new join

`keyedWrite` (`program-facts.js:1271-1279`) sets `hz.all=true` in its
"non-numeric-key fallback": when the KEY isn't provably numeric AND the
RECEIVER's kind can't rule out `OBJECT`. Survey/carrier-doc §17 Task 1 item 2
(carrier-representation-design.md:2019-2068) traced the dominant, banked
class to **two simultaneously unresolvable facts** at the same site:
`arr[idx] = v` where `arr = someMap.get(key) ?? []` (receiver kind
unresolvable) and `idx` is a plain function parameter (key numeric-certainty
unresolvable). These have **different root causes**, and the new join
dissolves only one of them — stating precisely which, rather than claiming a
blanket "wall collapses," is the point of this section.

**The receiver half (`arr`) DOES dissolve.** Today, `Map.get()`'s return is
deliberately **not** promoted to feed `arr`'s kind census at all — audit-#10
reverted an earlier attempt at exactly this promotion for the closely
related `censusMaybeUndefinedKind` consumer, because promoting a `.get()`
read to an EXACT single kind is unsound when the map holds heterogeneous
values (`kind.js`'s own comment, cited carrier-doc:2029-2032: "VT['()'] does
not promote a `.get()` read to an exact VT"). Under the OLD exact-or-null
`val` field, that fear is correct — a map holding both `NUMBER` and `STRING`
values has no single exact kind to promote to, and promoting one anyway
would be a live miscompile.

Under `possibleKinds`, that choice is a false dichotomy. `mapValueKindOf`'s
answer becomes `elementKinds(mapKey)` — the UNION of every value kind ever
written to that map (already the join `dictValueValType`/`mapValueValType`
compute today per-value, survey line 162-163, just not currently fed back
into the RECEIVER's own kind fact after a `.get()`). Promoting `Map.get()`'s
return to `arr`'s `possibleKinds` by **union** (`arr.possibleKinds ∪=
elementKinds(mapKey) ∪ {presence-implied-undefined-if-absent}`) is sound
for a heterogeneous map — the set correctly contains both `NUMBER` and
`STRING` if both were ever stored, and `isDisjointFrom(arr, KEYED_EXEMPT_VALS)`
answers `true` whenever that UNIONED set happens to exclude `OBJECT` (e.g.
the map only ever stores Arrays) — audit-#10's objection was specifically to
**exact** promotion; it does not apply to a **safe over-approximation**.
This is the mechanism, not a hope: it is exactly the "opt-out instead of
opt-in" asymmetry `kind.js:272-293` already names as the *reason* the
current functions are gated internal-only (survey line 184) — the gate was
protecting against a POINT CLAIM, and a set is not a point claim.

**The key half (`idx`) does NOT dissolve, and should not be expected to.**
`idx`'s int-certainty is a UNIVERSAL claim (§1.4) — "every call site passes
an integer" — and §22 (carrier-representation-design.md:3086-3119) already
implemented and verified the correct wiring for this (threading
`curParamIntCertain` into the same check) and found it **structurally,
correctly** fails for self.js's dominant class: hundreds of call sites into
generic helpers, and it takes exactly one disagreeing site to falsify
"always an integer." That is not a representation bug the lattice can fix —
it is the honest answer to a universal question the corpus genuinely doesn't
satisfy. The unification's payoff here is **narrower but real**: `idx`'s
`intCertainty` is computed by ONE shared meet primitive instead of two
(`repOf(key)?.intCertain` for locals, `curParamIntCertain` as a bespoke
side-Set for params, survey lines 2036-2041's "wrong function's cursor" bug)
— because params are now first-class `Fact`-holders keyed by their own
`(funcName, paramIdx)`, `intCertainty(paramKey)` is the SAME call as
`intCertainty(localKey)`, with no separate cursor-alignment channel to get
wrong. The KEYING bug closes for free; the CERTAINTY itself stays honestly
poisoned, because it should.

**Net prediction for the acceptance criterion** ("the §17 keyedWrite class
collapses"): read as "the dominant, previously-banked class — `arr` sourced
from `Map.get()` — is resolved, shrinking `hz.all`'s footprint on self.js
substantially," NOT as "hz.all reaches zero." The residual (writes where
`idx` genuinely isn't provably integer) correctly falls through to the
narrower `hz.numeric`/no-exemption path, same as today. This must be
measured, not assumed — see §6 open question 1.

### 3.2 §22 — sticky-null, traced through the new join

`mergeParamFact` (`param-reps.js:58-63`) today:
```js
if (rep[key] === null) return                                  // already TOP — sticky
if (observed == null) { rep[key] = null; latticeMeet.changed = true; return }
if (rep[key] === undefined) { rep[key] = observed; latticeMeet.changed = true }
else if (rep[key] !== observed) { rep[key] = null; latticeMeet.changed = true }
```
Applied to `val`, this is the universal/AND algebra (§thesis) misapplied to
an existential question. Under the new record, the disagreement branch
becomes union instead of poison:
```js
possibleKinds = possibleKinds ∪ {observedKind}          // was: rep[key] = null
```
For self.js's generic helpers — the exact population §22 diagnosed (survey
lines 3097-3119 of the carrier doc: "hundreds of sites... any two
disagreeing sites → sticky null, forever"): two call sites passing `NUMBER`
and `STRING` respectively no longer collapse `val` to "no idea." They
produce `{NUMBER, STRING}` — a set that still soundly EXCLUDES `BIGINT`,
`OBJECT`, `ARRAY`, etc. Any consumer asking `cannotBe(paramKey, VAL.BIGINT)`
gets a sound `true` where today it gets an uninformative "unresolved" that
collapses to the SAME code path as "genuinely could be BIGINT." This is a
strict precision gain with zero soundness cost, because the underlying
question — "what kinds has this param been observed as" — was always
existential; the old code was just answering it with the wrong algebra.

**What §22's fix does NOT retroactively unlock.** §22's actual target was
the `wasm`/`intCertain` exemption for `keyedWrite`'s numeric-key check — a
UNIVERSAL question (§1.4, §3.1). That stays a `numeric` field, stays a meet,
and stays honestly poisoned for the same hundreds-of-call-sites reason. The
sticky-null RETIREMENT is real and closes FINDING-7's root cause for
`possibleKinds`; it is not a second, independent fix for §22's own
originally-stated numeric goal, which was already correctly diagnosed as
unfixable by representation alone (carrier-doc:3097-3119's own "this
generalizes... to the KEY's int-certainty too — both facts die to the
identical... structural property," a statement about the CORPUS, not the
lattice). This slice's acceptance criterion should be phrased to match: the
KIND question stops poisoning; the NUMERIC question stays correctly
unresolved on self.js, and that is not a regression.

### 3.3 The remaining walls, briefly

- **§18** (`mapValueKindOf`'s HARD-only `new Map()` gate, survey line 449):
  dissolves as a CONSEQUENCE of the unified key space, not a new mechanism —
  a property-aliased binding (`const slotTypes = ctx.schema.slotTypes`) gets
  its `possibleKinds` populated by the SAME assignment-flow copy rule
  `BindingFacts` already needs for any `const x = y` decl (copy `y`'s Fact
  into `x`'s key, a mechanical widening, not a new AST-shape detector).
  `new Map()`-only detection was a special case of a more general "propagate
  the RHS's Fact at any decl" rule this design already needs for `x`'s
  `possibleKinds` in general.
- **§19/§20** (property-kind tracing scope check / chain resolution):
  already landed independent of this design (survey line 450-451, "chain
  resolution itself LANDED and works"); gated only on the terminal
  `slotHazarded`/`isHazarded` call, so it inherits §17's dissolution for
  free — no separate projection needed.
- **§21** (`hz.all` load-bearing for slot-KIND, proven by concrete
  counter-example, survey lines 319-328): **does not dissolve, and must
  not.** It is preserved exactly, as the correct behavior of `pointsTo`'s
  `'ALL'` top state (§1.3) — every one of the 7 `slotHazarded` callers keeps
  consulting it unconditionally. This wall was never a representation
  problem; it is a real soundness boundary, and the design's job here is to
  represent it cleanly (a first-class lattice value instead of a bolt-on
  boolean with no `ctx.js` reset seed), not to remove it.

---

## 4. Consolidation

| Duplication (survey FINDING) | Collapses to | Deleted |
|---|---|---|
| FINDING-2: 3 independent poison-join implementations (`mergeParamFact`, `makeValTracker`/`makeTypedTracker`, `observeSlot`/`poisonSlot` inline) | ONE `joinKinds(fact, key, observedSet)` primitive (union) + the EXISTING `meetLevel` primitive (unchanged, reused for `numeric` everywhere including `repOf().intCertain`) | Three separately-coded algebras; `latticeMeet.changed`'s convergence signal becomes the ONE fixpoint driver both `ParamFacts` and `SlotFacts` register against (today invisible to each other, survey line 611) |
| FINDING-3: `kindOf` (program-facts.js) vs `lookupValType` (reps.js) — 2 priority chains | ONE `resolveFact(key)` consulting the same tiers (refinements → overlay → durable Fact); the hazard walk's `curParamVts` becomes a transient overlay contribution via the SAME overlay mechanism `localValTypesOverlay` already uses, not a bespoke closure | `program-facts.js`'s standalone `kindOf` |
| FINDING-9: 5 independent receiver→sid resolvers | ONE `pointsToSet(key)` projection + the ALREADY-LANDED `chainSid` walker (§20) reused by all five call sites | `observeProgramSlots`'s inline `sidOf`, `collectSlotWriteHazards`'s own `sidOf`, `analyzeSchemaSlotIntCertain`'s `sidOfName` |
| slot* family (`slotTypes`, `slotTypedCtors`, `slotBigintObserved`, `slotObjSids`, `slotIntCertain`/`slotI32Certain`) | Named projections of ONE `SlotFact` per `(sid,idx)`: `slotVT=kindsOf`, `slotTypedCtorBySid=rep`, `slotBigintProvenBySid=repClass.has('boxed')`, `slotObjSids=pointsToSet`, `slotIntCertainAt`/`slotI32CertainAt=numeric.level` | 5 parallel `Map<sid,...[]>` structures → 1 `Map<sid,Fact[]>` — literally the audit-#15 verdict's own words (todo.md:6962, "SlotFact with named projections... replacing the fragmenting slot* census family") |
| FINDING-4: `censusBigintSentinelKind`'s `0`-vs-`null` fail-value inconsistency | ONE universal "no information" token: `∅` (empty `possibleKinds`) | The bespoke falsy-zero sentinel; migrate this function's fail path to `possibleKinds.size===0` |
| FINDING-10: P-carrier invariant, currently `JZ_DEBUG_INVARIANTS`-only runtime assert (program-facts.js:1747-1756) | Structural, not asserted: if `numeric.level` and `rep` are BOTH derived from the SAME per-write observation (one runtime type-check branch produces "this write proved i32-safe" XOR "this write proved BigInt-needs-boxing" as two projections of one classification, never two independently-timed passes), the two facts cannot diverge by construction — the assert becomes unreachable and can be downgraded to a documented-why-it-can't-fire comment, not deleted outright (a still-cheap tripwire against a future regression in the SHARED classification itself is worth keeping; what's retired is the NEED for two independently-maintained observation passes to agree) | The two-separate-passes structure that made the invariant possible to violate in the first place |
| FINDING-5: name collision, `invalidateBodyFacts` (target) vs `narrow.js:958-961` (existing, differently-shaped) | Resolved by fiat, not merging: rename the existing phase-local method (e.g. `clearNarrowingBodyState()`) BEFORE introducing the module-level `invalidateBodyFacts(body, reason)` entry point | — (this is a precondition, not a consolidation; listed here because it blocks Slice 0) |

---

## 5. Migration slices

Ordered lowest-risk first per survey §4's own ranking. Every slice is
independently green; every slice's gate is the project's STANDARD triad
(bench-corpus byte-identity + full battery + `kernel-parity`), escalated to
fuzz/differential specifically where survey §4 flags HIGH soundness risk.
Revert boundary given per slice — all slices revert as a single commit range
since consumers sit behind stable projection names throughout (no
cross-slice API coupling).

**Slice 0 — plumbing, zero behavior change.**
Files: `src/param-reps.js` (add `joinKinds`), `src/compile/narrow.js` (rename
`invalidateBodyFacts` → `clearNarrowingBodyState`, FINDING-5's precondition).
Consumers migrated: none — introduces the shared primitive and the Fact
shape as dead code alongside the existing storage; the rename's call sites
are mechanically updated in the same commit. Gate: grep for zero un-renamed
references + full battery byte-for-byte unchanged (this slice cannot change
any WAT output — it adds unused code and renames a private method). Revert:
trivial, single commit, no downstream dependents yet.

**Slice 1 — `dictValueKindOf`/`mapValueKindOf` onto `BindingFacts`.**
Files: `src/kind.js`. Consumers migrated: internal-only (survey line 582,
"0 external" — `censusMaybeUndefinedKind` is the SOLE dispatch point, its
contract stays identical). Gate: standard triad only (fully contained
change, matches survey's own "LOW" rating). Revert: single commit.

**Slice 2 — `recvArrTyped` reframed as `isDisjointFrom` precedent.**
Files: `src/reps.js`, `src/module/array.js`. Re-expresses the EXISTING
`{ARRAY,TYPED}` field as `isDisjointFrom(key, ALL_KINDS \ {ARRAY,TYPED})` —
no computation changes (survey line 585, "the existing precedent... not a
migration risk"), establishes the projection idiom the later slices reuse.
Gate: standard triad, trivial. Revert: single commit.

**Slice 3 — `presence` unification (`censusMaybeUndefined` boolean family,
13 sites).**
Files: `src/kind.js`, `src/compile/emit.js`, `src/module/{core,string,
console,number}.js`. Consumers migrated: the 13 boolean call sites (survey
line 581, "MEDIUM... risk is in getting the tri-state boundary right, not
call sites"). Sub-slice discipline: shadow-assert FIRST (compute both the
old `makeValTracker`-derived boolean and the new `presence` field for one
full battery run under `JZ_DEBUG_INVARIANTS`, assert equal, per the
Heap-kind-registry "prove equality, then move the source of truth" method,
research.md:862-871) — only delete `makeValTracker`'s poison-Set AFTER that
shadow run is clean. Gate: shadow-assert clean, then standard triad. Revert:
single commit; if the shadow-assert ever fires post-land, revert immediately
(it means the two mechanisms were never actually equivalent).

**Slice 4 — `paramReps.val` → `ParamFacts.possibleKinds`.**
Files: `src/param-reps.js`, `src/compile/narrow.js`. Two sub-slices, per the
survey's own risk split (line 584: "the join already IS a real lattice...
the risk is entirely on the CONSUMER side"):
  - **4a (storage):** `mergeParamFact`'s disagreement branch flips to union
    (§3.2's code change). A compatibility SHIM keeps every existing exact-
    kind caller byte-identical: `valTypeOf`-shaped callers read
    `possibleKinds.size===1 ? [...possibleKinds][0] : null` — i.e. today's
    `null`-on-disagreement observable behavior is reproduced exactly by the
    shim even though the underlying storage now retains more information.
    Gate: standard triad (must be BYTE-IDENTICAL — the shim's whole purpose
    is that nothing downstream can tell the difference yet).
  - **4b (consumers, N separate slices):** each `kind.js` VT-dispatch call
    site that WANTS the new precision (starting with the two named in §3.1:
    `arr`'s `isDisjointFrom` check in `keyedWrite`, and `mapValueKindOf`'s
    receiver-alias gate for §18) drops the shim and reads `possibleKinds`
    directly, one call site at a time. Gate per sub-slice: standard triad +
    a fuzz/differential pass (this is where set-shaped answers first reach
    a live decision, survey's own "no existing convention... would require
    touching the dispatch mechanism itself" warning, line 584).
Revert: 4a and 4b are independently revertible (4b's shim-drop reverts to
the shim without touching 4a's storage; 4a alone reverts to the old
`mergeParamFact` body, and every 4b site would need to revert WITH it,
enforced by making 4b depend on 4a's commit SHA in review, not by tooling).

**Slice 5 — FINDING-7 `!==`/`===` sites (`censusMaybeUndefinedKind`
consumers, emit.js ×6, ir.js ×2, type.js ×1, ~9 sites).**
Files: `src/compile/emit.js`, `src/ir.js`, `src/type.js`. Per-site, NOT a
bulk sweep — survey's own explicit warning (line 580: "getting this
inversion wrong at even one migrated site is a live miscompile, not a
coverage regression"). Each site: `=== VAL.X` → `isExactly(key, VAL.X)`,
`!== VAL.X` → `cannotBe(key, VAL.X)` (§1.6's structural TOP guarantees these
are drop-in sound, but each site still gets independent verification since
the CONSEQUENCE of a wrong answer here is silent type confusion, not a
crash). Gate per site: standard triad + fuzz (mandatory, per survey) +
`JZ_DEBUG_INVARIANTS=1` battery leg. Revert: per-site, independently.

**Slice 6 — `SlotFact` unification (the slot* family, §4's table).**
Files: `src/compile/program-facts.js`, `src/module/schema.js`. The largest
structural slice: `slotTypes`/`slotTypedCtors`/`slotBigintObserved`/
`slotObjSids`/`slotIntCertain`/`slotI32Certain` → projections of one
`Map<sid, Fact[]>`; `hz.all`/`hz.sids`/`hz.props`/`hz.numeric` → `pointsTo`
+ the two cross-cutting side predicates (§1.3, kept separate on purpose).
Mandatory precondition (survey's own explicit mandate, line 583): "any
lattice migration touching how `hz.all` composes with a new set-valued kind
fact must re-run §21's exact audit methodology (every setter site × every
caller) before landing, not just re-derive it by analogy" — this is not
optional due-diligence, it is the slice's gate. Consumers migrated: the 7
`slotHazarded` callers in `module/schema.js` (`slotVT`,
`slotBigintProvenBySid`, `slotTypedCtorBySid`, `slotTypedCtorByProp`,
`slotIntCertainAt`, `slotI32CertainAt`, `slotI32CertainBySid`). Gate:
standard triad + full §21 re-audit + `JZ_CARRIER_BOX=1` legs (whose `dict`
divergence is a KNOWN pre-existing gap, survey line 586 — gate is "the
divergence shape stays the same," not byte-identity, for that leg only).
Revert: single commit range, all-or-nothing (a partial revert could leave a
REGRESSED hazard gap if only some `SlotFact` projections were reverted while
`hz.all`'s old boolean was already deleted — flagged in §6).

**Slice 7 — sticky-null retirement + §17/§22 acceptance (capstone).**
Files: `src/param-reps.js` (§3.2's disagreement-branch flip, now WITHOUT the
Slice-4 shim — the shim's whole purpose was to defer exactly this), plus
whatever `Map.get()`-promotion wiring §3.1 needs in `program-facts.js`.
Depends on Slice 4 (params must already be `possibleKinds`-shaped) and
Slice 1 (`mapValueKindOf` must already be a `Fact` projection, so the
promotion in §3.1 has something sound to union from). Acceptance, matching
the brief's own wording verbatim ("hz.all keyedWrite collapse on self.js"):
re-run the SAME temporary `JZ_DEBUG_HZALL` instrumentation methodology
§17/§22 already used (carrier-representation-design.md:1980-1982, stripped
before commit) against the real `scripts/self.js` build, and confirm (a) the
`arr`-from-`Map.get()` class of `hz.all` sites closes (§3.1's prediction),
(b) the `idx`-numeric class stays honestly unresolved with NO regression in
count (§3.1's honest limitation), (c) `ctx.schema.slotWriteHazards.all` still
correctly fires for the genuinely-OBJECT-shaped remainder. Gate: standard
triad + the `JZ_DEBUG_HZALL` measurement (temporary instrumentation, not
committed, same discipline as §17/§22) + fuzz. Revert: single commit,
reverts cleanly to Slice 4/6's already-landed state (this slice adds
precision, it doesn't change what any OTHER slice's projections return for
already-covered cases).

---

## 6. Risk register

Ranked by survey §4's own axes (exact-equality call-site count ×
soundness-critical vs performance-only), plus FINDING-10's structural
opportunity.

1. **FINDING-7 inversion risk (Slice 5), HIGH.** Mitigated structurally by
   §1.6 (TOP is never a special-cased sentinel) and procedurally by Slice
   5's per-site, mandatory-fuzz discipline. Residual risk: a site that reads
   `possibleKinds` through a CACHED/copied reference taken before a later
   join widened it (a staleness bug, not an algebra bug) — not covered by
   this design; the existing `bodyFacts` staleness discipline (survey §1.5,
   `assertBodyFactsFresh`) needs to be checked against each Slice-5 site
   individually, not assumed.

2. **`hz.all`/`slotHazarded`'s 7-caller soundness boundary (Slice 6), HIGH.**
   Mitigated by Slice 6's mandatory §21 re-audit gate. Named failure mode:
   the ALL-OR-NOTHING revert requirement (§5, Slice 6) — a tooling or
   process gap here (partial revert of a multi-file structural slice) is
   itself a risk the design can name but not eliminate; recommend the
   implementation session tag Slice 6 as a single non-decomposable commit
   for this reason, contrary to the "every consumer its own byte-identity
   unit" default.

3. **Slice 4's consumer-side dispatch assumption (kind.js's VT table
   assumes singleton), HIGH by volume.** Mitigated by the 4a/4b shim split
   — nothing observes the new shape until a 4b sub-slice explicitly opts
   in. Residual: the shim itself (`possibleKinds.size===1 ? ... : null`) is
   new code on a hot path (73+ `repOf(` sites, survey line 584) — needs a
   perf regression check the byte-identity gate alone won't catch (byte-
   identity proves the WAT is unchanged, not that compile TIME is
   unchanged); flag for the coordinator to decide whether a compile-time
   budget check belongs in Slice 4a's gate.

4. **OPEN QUESTION — is set-valued `Map.get()` promotion (§3.1) actually
   the full resolution of audit-#10's revert, or only the reason this
   design INFERS for it?** This document's §3.1 argument (exact promotion
   unsound, set promotion sound) is derived from `kind.js:272-293`'s
   comment and the carrier-doc's own framing of the banked gap — it has not
   been independently re-audited against whatever ELSE audit-#10 considered
   before reverting. Per this project's own standing practice (§18's "wall
   confirmed at a third layer" — the SAME idea was tried twice and reverted
   twice before this design's angle), Slice 7 should not treat §3.1's
   argument as proven; it should re-run a scoped version of the audit-#10
   investigation BEFORE landing the `Map.get()` promotion, not after. This
   is the single highest-value thing for the coordinator to weigh in on
   before implementation starts.

5. **`pointsTo`'s height bound depends on schema registration terminating
   independently of the fact fixpoint (§1.3), MEDIUM, unverified.**
   `ctx.schema.register` is called from `collectSlotWriteHazards` itself
   (`program-facts.js:1331,1346`) — confirmed directly, not inferred. If any
   FUTURE registration site were made conditional on a `pointsTo` read (none
   are today, per the grep this design ran), the termination argument in
   §1.3 would need re-deriving. Flagged as a standing invariant to protect,
   not a currently-violated one.

6. **FINDING-10's structural fix (Consolidation, §4) is an opportunity, not
   an obligation, LOW.** If `numeric` and `rep` genuinely cannot share one
   observation timing (e.g. a real ordering constraint this design hasn't
   surfaced), keep the `JZ_DEBUG_INVARIANTS` assert rather than force a
   shared pass — the assert is cheap and already proven correct; the
   structural fix is a nice-to-have this design recommends attempting
   inside Slice 6, not a blocking requirement of it.

7. **FINDING-5's rename (Slice 0) is a hard sequencing dependency, LOW
   risk but zero slack.** Every later slice's `invalidateBodyFacts(body,
   reason)` entry point (research.md:704-708's own target name) collides
   with the existing method if Slice 0 doesn't land first. Named here only
   to make the ordering constraint explicit in the risk register, not just
   the slice list.

8. **`JZ_CARRIER_BOX=1` `dict` divergence (Slice 6/7), N/A for byte-
   identity, tracked separately.** Survey's own framing stands unchanged:
   this is an ALREADY-diverging path (survey line 586); the gate for any
   slice touching it is "the divergence shape is unchanged," never byte-
   identity — restated here so Slice 6/7's gate list doesn't accidentally
   demand an impossible bar.

---

## LATTICE OQ1 VERDICT (2026-08-08)

**Answering §6 risk item 4.** §3.1's claim — "audit-#10's objection was
specifically to **exact** promotion; it does not apply to a **safe
over-approximation**" — is **not supported by the historical record** and
is false as a blanket statement. §3.1/§3.3's "dissolves" language and
Slice 7's acceptance criterion must not proceed on the current text.

**The count is three reverts, not two, and the design cites the wrong one
as its baseline for the exactness argument:**

1. `1db8e55e` → reverted `f8f61591` (ledgered **audit-#7 P0**, 2026-08-02).
   Exact-kind promotion (`mapValueKindOf` short-circuiting `VT['()']`'s
   `.get` dispatch to a single `VAL.*`). Unsound two ways per the commit
   message and `.work/todo.md`'s 2026-08-02 status entry: (a) **absent
   key** — `m.get(missing)+1` gave `undefined` instead of `NaN`,
   `String(m.get(missing))` gave `"NaN"` instead of `"undefined"`; (b)
   **alias write** — census keyed by syntactic receiver name, so
   `alias.set(k,v)` after `const alias=m` is invisible, leaving a stale
   kind live after the alias write.
2. `061e2c6e` (dict Slice 1, presence-join at curated chokepoints) +
   Slices 2-3 → reverted `7288b69b` (**audit-#9 P0-1**, 2026-08-04). The
   presence-aware fix was **AST-shape-only**: it recognized only the
   direct read node, so it evaporated at a decl-hop (`let x =
   m.get(missing); x+1`), and several consumer sites were never on the
   curated gate list at all (the STRING `+`-concat fast path,
   `bigintMixReject`'s compile-time BigInt-mix check) — the join itself
   was sound where applied; its *coverage* wasn't, and coverage couldn't
   be proven complete by manual chokepoint audit.
3. `79082fb2`→`3782a692` (represented-maybeUndefined: `presentVal` as a
   real REP field, correctly propagated through decl/param/return/closure
   — `.work/represented-maybe-undefined-design.md` Slices 1-3, deleted at
   `6039b38b` once superseded) → Slice 4 (`3782a692`) wired this
   now-correctly-presence-gated `presentVal` claim back into
   `VT['[]']/VT['.']/VT['()']` directly → reverted `098014a5` (**audit
   #10**, 2026-08-04) — **this is the revert §3.1 cites.** Its own commit
   message: *"a census claim promoted to a global exact-kind fold made
   every `valTypeOf` consumer silently exposed to a maybeUndefined value
   unless it separately remembered to check `censusMaybeUndefined`,
   opt-out instead of opt-in."* Five NEW live failures were found by audit
   #10 that Slice 4's own landing-session chokepoint walk had missed:
   composed expressions (`?:`, `&&`, `||`, comma around a census read),
   container storage (array/object literal wrapping a census read),
   kind-specific dispatch (`Array.isArray`, `.length`, closure-call —
   several decode as a WASM trap instead of a JS `TypeError`, e.g.
   `m.get(missing).length`, `m.get(missing)()`), the String `+` fast
   path, and BigInt joint dispatch.

**The fact §3.1 gets backward:** audit #10's target (Slice 4) was
**already presence-aware** — it promoted `presentVal`, built on top of
correctly-propagated `mayBeUndefined`, not a naive write-kind claim blind
to absence (that was `1db8e55e`/audit-#7's mistake, already fixed by the
time Slice 4 landed). Audit #10 did not object to exactness. What it
killed was feeding *any* census-derived claim — however presence-correct
at the point of derivation — into a fact channel (`valTypeOf`/`VT`) whose
consumer set is open-ended and not exhaustively enumerable by inspection,
proven twice over (2 gaps at Slice-4's own landing, 5 more at audit #10,
same manual-audit method both times). The fix that was actually accepted
(`represented-maybe-undefined-design.md` §14, "opt-in `presentVal`
model, supersedes §5") is structural: `val`/`valTypeOf` never carries a
census claim; the claim lives on a separate, narrowly-named field
(`presentVal`) read only by an individually-verified, explicitly
opted-in consumer list; `valTypeOf` returns null (no optimistic default)
for a census-shaped node absent that explicit ask. This is exactly the
architecture live in `src/kind.js` today: `dictValueKindOf`/
`mapValueKindOf` are internal-only helpers, never reaching `VT`, consulted
solely through `censusMaybeUndefinedKind`'s curated chokepoint list.

**Verdict on (a)/(b)/(c):**

- **(c) is false.** The historical unsoundness is not scoped to exact-kind
  promotion — two of the three reverts (audit-#9, audit #10) hit a
  presence-aware claim and still failed, for a reason orthogonal to
  exact-vs-set.
- **(a) set-valued kind union feeding a boolean-disjointness consumer
  (§17's `isDisjointFrom(arr, KEYED_EXEMPT_VALS)` reuse) is UNSOUND AS
  SPECIFIED.** §3.1 writes the union directly into `arr.possibleKinds` —
  the Fact record's general field, the same one §3's own table (line 288)
  says replaces `valTypeOf`/`lookupValType` for every consumer, present
  and future. That is exactly the opt-out shape audit #10 killed, with a
  set standing in for the exact kind; nothing in the Fact record or the
  projection catalog requires a `kindsOf`/`isDisjointFrom`/`isExactly`/
  `cannotBe` caller to also consult `presence` before treating a kind
  answer as license to skip a runtime check. Traced concretely:
  `possibleKinds={ARRAY}, presence=true` (homogeneous-ARRAY map, key
  absent, no `?? []` guard) makes `isDisjointFrom(arr,{OBJECT})`
  sound-and-true for `keyedWrite`'s own narrow "could this alias a
  tracked OBJECT schema slot" question specifically — `undefined` cannot
  alias a schema slot either, so `hz.all`'s bookkeeping is genuinely
  presence-orthogonal *for that one question*. But Slice 4b (§5)
  explicitly proposes wiring the SAME `possibleKinds`/`kindsOf` answer
  into `kind.js`'s general VT dispatch beyond `keyedWrite` ("starting
  with... `keyedWrite`... and `mapValueKindOf`'s receiver-alias gate for
  §18"), and any consumer that uses a proven-kind answer to select codegen
  that skips a presence check reproduces the exact failure class the
  audit-#10 battery already caught five times (kind-specific dispatch on
  a genuinely-absent value: WASM trap instead of `TypeError`). The design
  never states — and the projection catalog as written cannot enforce —
  the conjunction `isDisjointFrom(k,S) AND !mayBeUndefined(k)` that
  soundness for any codegen-affecting consumer actually requires.
- **(b) presence-aware union feeding a value consumer that explicitly,
  jointly reads BOTH the kind claim AND `mayBeUndefined` at one
  individually-audited call site is SOUND** — this is precisely the
  architecture §14 landed and that is live today (`censusMaybeUndefinedKind`,
  restricted to internal-only helpers, consulted only by the curated
  chokepoint list: `ir.js` `toNumF64`/`toStrI64`, `emit.js`'s
  `nullableOperand`/`bigIntOperand`/`bigIntUnary`/`bigintMixReject`/
  `+`-concat). The design's `mayBeUndefined(key)` projection (§3, line
  292) is a correct re-homing of this — but only if it stays what it is
  today: a projection an opted-in consumer explicitly calls alongside the
  kind question, never a fact folded automatically into what `kindsOf`/
  `isDisjointFrom` return.

**The exact projection that must be restricted:** §3.1's `arr.possibleKinds
∪= elementKinds(mapKey) ∪ {presence-implied-undefined}` must not write
into the SAME `possibleKinds` field that `kindsOf`/`isExactly`/`cannotBe`/
`isDisjointFrom` expose to every consumer. Two structurally sound
alternatives, both matching the §14 precedent that's actually landed and
green:

- **Option A (match precedent).** Keep the Map/dict-census union OUT of
  `arr`'s general Fact `possibleKinds` entirely. Give it its own
  opt-in-only projection (`censusKindsOf(key)`, the set-valued sibling of
  today's `presentVal`) that only an enumerated, individually-verified
  consumer list may call — `keyedWrite`'s exemption check becomes one
  such consumer, explicitly conjoined with `!mayBeUndefined(arr)` at that
  call site, not a blanket `isDisjointFrom` reuse.
- **Option B (harden the general projection).** Redefine `isDisjointFrom`'s
  guarantee (§3's table) to be `possibleKinds(key) ∩ kindSet = ∅ AND
  !presence(key)` whenever `possibleKinds` carries any census-sourced
  contribution — presence becomes structurally part of the disjointness
  answer, not a separate fact a caller might forget to check. This
  changes the projection catalog's stated contract and requires
  re-verifying `isDisjointFrom`'s other existing caller (`recvArrTyped`'s
  ARRAY-OR-TYPED test) doesn't regress from the tightened conjunction it
  never needed.

**Conclusion for the coordinator:** risk register item 4 is right to flag
this as unverified — this verdict confirms the gap is real, not merely
cautious. It should be upgraded from "open question" to a **blocking
precondition on Slice 4b and Slice 7**: re-run a scoped version of the
audit-#10 battery (composed expressions, container storage,
kind-specific/codegen dispatch — the three classes that caught 5 of the
last 7 total failures across the three reverts) against
`isDisjointFrom(arr, KEYED_EXEMPT_VALS)` and any other Slice-4b consumer
specifically, before landing, and land Slice 4b only through Option A or
Option B above — not through the plain `arr.possibleKinds ∪=` union §3.1
currently specifies.

## COORDINATOR RULING on OQ1 (2026-08-08, binding for implementation)
Option A. Census-derived kind unions NEVER enter the general `possibleKinds`
field — they live in a separate OPT-IN projection (`censusKindsOf`),
mirroring the live presentVal architecture that survived audit hardening:
the consumer set is enumerable by construction, each consumer added
deliberately with its own gate. §3.1's promoted-union is amended
accordingly; Slice 4b is RESTRICTED to opt-in consumers only; risk item 4
is upgraded to a BLOCKING precondition on Slices 4b and 7. Option B
(presence baked into isDisjointFrom) is rejected as primary — it repairs
one projection while leaving the open-ended-consumer shape alive; it MAY
be adopted additionally as belt-and-braces on that one projection.
Rationale: the three-revert history (f8f61591, 7288b69b, 098014a5) shows
the killed axis is opt-out consumer exposure, not fact precision — the
design must encode opt-in structurally, not procedurally.

## LATTICE OQ2+OQ4 VERDICTS (2026-08-08)

### OQ4 — §6 risk item 5, `pointsTo` height/termination

**Verdict: TODAY's invariant holds — confirmed directly, not inferred.**
No `ctx.schema.register` call site is reachable from a `pointsTo`-shaped
fact-READ path. Every site's argument (the name-list it mints a sid for)
is derived either from literal AST syntax or from a stable, already-settled
schema-identity lookup (`ctx.schema.vars`, `repOf(obj)?.schemaId`,
`ctx.schema.list[sid]`) — never from `hz.all`/`hz.sids`/`slotWriteHazards`
membership, which is the field `pointsTo`/`'ALL'` will replace. Data flow
is one-directional: AST/static-shape → `register` → sid → (feeds) hz/
pointsTo. Nothing runs the other way. (Also: `pointsTo` itself does not
exist in the codebase yet — `grep -rn pointsTo src/ module/` is empty — so
this checks the design's own precondition against today's closest analog,
the `hz.*` write-hazard registry §1.3 says `pointsTo` subsumes.)

Full enumeration: 36 real call sites (37 grep hits, 1 is a comment at
`module/core.js:1804`) across 14 files —
`module/{schema,object,array,core,json,date}.js` (11),
`src/prepare/index.js` (7), `src/compile/program-facts.js` (7),
`src/compile/analyze.js` (5), `src/{static.js,compile/{infer,emit-assign,
inplace-store,plan/scope}.js}` (5), full list confirmed by
`find src module -name "*.js" | xargs grep -n "schema\.register("`.
Classified into three groups, none of which reads `pointsTo`/hz as input:

1. **Census/discovery walks that PRODUCE facts** (`walkFactsRoot`
   `program-facts.js:240`, `observeNestedDictMapWrites`'s `{}`-literal arm
   `program-facts.js:909`, `analyzeValTypes` `analyze.js:1720/1796/1801/
   1911/1923`, `src/prepare/index.js`'s 7 sites — prepare runs before any
   fact fixpoint exists in the pipeline at all). Argument is always
   `staticObjectProps(...)`-parsed literal syntax or a `shapeOf`-derived
   JSON-literal name list. No hz/pointsTo read anywhere in the call chain.

2. **`collectSlotWriteHazards` itself** (`program-facts.js:1331,1346,1360`
   — the two sites §1.3 names directly, plus a third for JSON.parse
   keysets). This is the function that PRODUCES `hz.sids`/`hz.all`, so it's
   the one place a register→hz→register cycle would have to originate. Read
   directly: the merge name-lists come from `sidOf(obj)` (resolves via
   `curSids`/`repOf(obj)?.schemaId`/`ctx.schema.vars` — a schema-identity
   fact settled by EARLIER passes, not by this scan's own hz output) and
   `ctx.schema.list[sid]` (an existing schema's already-registered name
   list). Neither reads `hz.all`/`hz.sids`/`hz.props`/`hz.numeric`. The
   three `register` calls only ever WRITE into `hz.sids`/`hz.kindSafeSids`
   afterward — one-directional.

3. **`register` calls inside the separate intCertain fixpoint**
   (`program-facts.js:1672`, inside the `while`-style round loop at
   `sweep`/`visit`, lines 1600-1722). Argument is `staticObjectProps(...)`
   again — identical every round, so `register`'s own dedupe-by-shape
   (`module/object.js:576`'s documented contract) makes repeated calls a
   no-op re-fetch of the same sid, not alphabet growth. This fixpoint's
   round count is driven by `observeSlot`'s int-level comparisons, never by
   `register`.

4. **Emission-time and post-census one-shot sites**
   (`module/{object,array,core,json,date,schema}.js`, `emit-assign.js:382`,
   `inplace-store.js:142`, `plan/scope.js:1131,1140`'s
   `materializeAutoBoxSchemas`). These run during codegen (after the fact
   fixpoint is fully resolved) or as a single deterministic pass over a
   completed `propMap` snapshot — not inside any iterative fact re-read.

**Guard to keep this true going forward:** the invariant is exactly "no
`register` caller's argument-computation path passes through `hz.*`/
`pointsTo`". Concretely, when `pointsTo` lands (Slice 6/7):
- Keep the direction enforced structurally — `pointsTo`/`hz` stay
  write-only from `register`'s perspective; `register`'s own argument
  builders (`staticObjectProps`, `sidOf`, `ctx.schema.list[sid]` lookups,
  `Object.keys(sample)`) must never be extended to accept a `pointsTo` Set
  or iterate its members to decide what to register.
- Add a cheap dev-mode assert in `ctx.schema.register` itself (mirroring
  the project's existing `JZ_DEBUG_INVARIANTS` convention): reject if any
  argument in the call stack traces to a live `pointsTo`/`slotWriteHazards`
  read within the same call — impractical to check generically, so the
  practical form is a **standing audit rule**: re-run this exact grep +
  per-site read-path check (the one just performed) any time a NEW
  `ctx.schema.register` call site is added, and gate it in review, not
  just at Slice-6/7 landing.
- No FINDING: the invariant is unconditionally true today: confirmed
  by exhaustive enumeration, not sampling. §1.3's own text already reaches
  this conclusion by construction (register's producing passes are
  "already-audited... terminating"); this verdict is the direct
  confirmation §1.3 asked the coordinator for.

### OQ2 — §6 risk item 2, Slice 6 partial-revert / hazard-gap risk

**Verdict: the slice is NOT one atomic blob — it splits into a LARGE,
independently-revertible storage refactor and a SMALL, genuinely
non-decomposable core. The design's "tag Slice 6 as a single
non-decomposable commit" recommendation (§6 item 2) is safe but
over-broad; a tighter partition is available and preferable (smaller
non-decomposable surface = smaller review/revert blast radius).**

Evidence — the hz/`pointsTo` composition boolean is not consulted from one
chokepoint, it's consulted from **three** distinct sites across two files,
found by tracing every `hz.all`/`hz.sids`/`hz.props`/`hz.numeric` read (not
write) in `program-facts.js` and `module/schema.js`:

1. `applySlotWriteHazards(hz, poison, opts)` (`program-facts.js:1409-1423`)
   — the SHARED poison/observe gate called at slot-census (re)build time.
   Its `whole` composition (`program-facts.js:1416-1417`): `hz.all ||
   hz.sids.has(sid) || externs?.has(sid) || (hz.kindSafeSids?.has(sid) &&
   kindSafe==null)`, plus per-slot `hz.props.has(...) ||
   (hz.numeric && ...)` (line 1419). Called from exactly 2 sites:
   `program-facts.js:734` (feeds `slotTypes`/`slotCtors`/
   `slotBigintObserved` via its poison/observe callbacks) and
   `program-facts.js:1699` (feeds the intCertain fixpoint's `slotIntCertain`/
   `slotI32Certain` poisoning, inside `sweep()`).
2. `slotHazarded` (`module/schema.js:247-253`) — the READ-time gate for
   the 7 named consumers (`slotVT`, `slotBigintProvenBySid`,
   `slotTypedCtorBySid`, `slotTypedCtorByProp`, `slotIntCertainAt`,
   `slotI32CertainAt`, `slotI32CertainBySid`). Same shape as #1's `whole`
   plus `hz.props`/`hz.numeric`: `hz.all || hz.sids.has(id) ||
   hz.props.has(prop) || (hz.numeric && /^(0|[1-9][0-9]*)$/.test(...))`.
   Because all 7 named consumers funnel through this ONE function, they
   need **zero individual edits** for the hz→`pointsTo` swap — correcting
   the slice spec's framing (§5, "Consumers migrated: the 7 `slotHazarded`
   callers") which reads as if 7 call sites need touching; only the shared
   gate does.
3. `chainHazarded` (`module/schema.js:275-278`) — a DELIBERATELY NARROWER
   sibling for `slotObjSids`/`chainSid` resolution: `hz.sids.has(id) ||
   hz.props.has(prop)`, explicitly WITHOUT `hz.all`. The comment at
   `schema.js:256-274` documents why: consulting the program-wide `hz.all`
   blanket here would reproduce a resolution circularity (`chainSid`
   feeds the very kind facts that would clear `hz.all`'s causes).

**The minimal revert-safe partition, two commits:**

- **Commit 6a — SlotFact storage unification (LARGE, independently
  revertible, byte-identical).** `slotTypes`/`slotTypedCtors`/
  `slotBigintObserved`/`slotObjSids`/`slotIntCertain`/`slotI32Certain` →
  projections over one `Map<sid, Fact[]>`. This touches only the
  DESTINATION of `applySlotWriteHazards`'s `poison`/`observe` callbacks
  (`program-facts.js:734-736,1699` — rewrite the callback bodies to write
  the unified map instead of 6 separate ones) and the projection getters
  in `module/schema.js`. `applySlotWriteHazards`'s own hz-composition
  logic (§ evidence #1 above), `slotHazarded`, and `chainHazarded` are
  UNTOUCHED in this commit — same hz shape in, same poison semantics out.
  Gate: every one of the 7 projection getters returns byte-identical
  values pre/post, for every (sid, prop) pair, same as Slice 2's
  `isDisjointFrom` precedent (§5, "no computation changes"). Revert-safe
  by construction: reverting restores 6 separate Maps with zero hazard-
  logic change — there is no intermediate state where hazard soundness
  could regress, because this commit never changes what counts as
  hazarded, only where the observed values are stored.

- **Commit 6b — `hz.all`/`hz.sids` → `pointsTo` (SMALL, atomic, the true
  non-decomposable core).** Must land, in ONE commit: (i) the setter
  sites in `collectSlotWriteHazards` that currently do `hz.sids.add(...)`/
  `hz.all = true` (`program-facts.js:1274,1279,1289-1290,1331,1343,1346,
  1349`) rewritten to populate `pointsTo`/`'ALL'`; (ii) `applySlotWriteHazards`'s
  `whole` composition (`program-facts.js:1416-1417`); (iii) `slotHazarded`
  (`module/schema.js:252-253`); (iv) `chainHazarded`
  (`module/schema.js:278`) — with its `'ALL'`-exclusion preserved
  EXPLICITLY (`pointsTo !== 'ALL' && pointsTo.has(id)`, not
  `pointsTo === 'ALL' || pointsTo.has(id)`), since a naive translation
  that copies `slotHazarded`'s composition onto `chainHazarded` silently
  re-widens the deliberately-narrower predicate back into the
  circularity its own comment says it exists to avoid — this is a
  concrete implementation gotcha this verdict surfaces, not one the
  design doc states. `hz.props`/`hz.numeric` (§1.3: kept separate,
  never folded into `pointsTo`) stay untouched vocabulary at all four
  sites. This is the true atomic unit — small (roughly a dozen call
  sites across 2 files, not "7 callers"), which makes "single
  non-decomposable commit" a low-cost requirement here, not the
  large-diff risk §6 item 2 implies. Partial landing (e.g. setters
  write `pointsTo` while a reader still checks `hz.sids`, now
  permanently empty) is exactly the silent-unsoundness failure mode —
  every slot reads as un-hazarded, a miscompile, not a crash — so this
  commit cannot be split further.

Both commits still sit behind Slice 6's mandatory §21 re-audit gate
(re-verify every setter site × every one of the three composition sites,
not just re-derive by analogy, per survey's own explicit mandate quoted
in §5) and the `JZ_CARRIER_BOX=1` divergence-shape check. Recommendation
for the coordinator: adopt the 6a/6b split in place of the single-commit
default — it satisfies the "every consumer its own byte-identity unit"
discipline for 6a while honoring the all-or-nothing requirement only where
it's actually load-bearing (6b).

## COORDINATOR REVIEW COMPLETE (2026-08-08) — implementation authorized
OQ3 ruling: the shared numeric/rep observation pass (FINDING-10) is adopt-
if-free during Slice 4a — do not force; a follow-on slice may make the
P-carrier tripwire structural. OQ2's 6a/6b split is ADOPTED as binding,
including the chainHazarded-stays-narrow gotcha as an explicit 6b gate.
OQ4's directionality guard: re-run the register-site read-path check as
part of Slice 6's gate. With the OQ1 Option-A amendment, this design is
mechanism-reviewed and BINDING. Slices proceed in order 0→7, each
independently green, byte-identity-gated, per-step local commits; any wall
banks per the standing discipline.

## AS-LANDED — Slice 0 (2026-08-08)

SHAs: `b538cea8` (0a, rename), `9e22eacd` (0b, joinKinds + Fact doc).

**0a — FINDING-5 rename.** Landed exactly as specified: the phase-local
`createPhaseState()` method at `narrow.js:958` renamed `invalidateBodyFacts`
→ `clearNarrowingBodyState`; its 2 call sites (`narrow.js:1979, 2099` at
survey time, `1984, 2104` post-rename since the doc comment added 5 lines
above the method) updated in the same commit. `grep -rn invalidateBodyFacts
src/ module/` post-land returns zero code hits (only `invalidateAllBodyFacts`,
a distinct, untouched, already-existing module-level function name — not a
collision). No deviation.

**0b — `joinKinds` + `Fact` shape.** Landed exactly as specified, in
`src/param-reps.js` alongside `mergeParamFact` (unchanged): a JSDoc
`@typedef Fact` transcribing SS1's record verbatim, and `joinKinds(fact, key,
observedSet)` — union-into-Set, BOTTOM=∅, reusing `latticeMeet.changed` as
its convergence signal (FINDING-2's "ONE joinKinds primitive"). Deviation
from the literal design text: the design describes Slice 0 as introducing
"the Fact shape as dead code" — read here as a JSDoc type doc (zero runtime
footprint), matching `reps.js`'s own `@typedef ValueRep` convention, not a
literally-instantiated dead object (which would have no referent to check
against and would just be waste). No behavior change; `joinKinds` has zero
callers as of this commit.

**Gate results (both 0a+0b together, since neither changes runtime
behavior independently):**
- Bench-corpus byte-identity: 58-case/174-compile corpus (all non-graph
  `bench/*/*.js` cases, O0/O2/O3), sha256-compared against a disposable
  `git worktree` at pre-slice HEAD (`93d04a44`) — **0 diffs**.
- Full battery: `npm test` — **3407/3415 pass, 2 pre-existing fails**
  ("interval walk: strided companion cursor…", "typed RMW: one guard covers
  the pure read…"), confirmed pre-existing by running the identical suite
  against the same `93d04a44` worktree baseline (same 2 fails, same count) —
  not a regression.
- kernel-parity: **33/33** byte-identical (3 files × 11 rows, O0/O2/O3).
- `npm run build` ×2: byte-identical (`dist/jz.js` sha256
  `01b4f258ca7c94988bada567b5728e852ff0180dad3b3f660bfd13b2bae33d3b`,
  `dist/jz.wasm` sha256
  `47dccc12660964f86531d77d5fdf5231c3b35d6d9d96796c369e769466cb9652`,
  `dist/interop.js` sha256
  `ef42c9da1ab79349a5ab69d55558082de4b3d228850b87a9a188b6722ef730e1`, both
  rounds — this is the SAME build that also covers Slice 1 below, run once
  after both slices landed).

**Verdict: GREEN, zero deviation from spec beyond the JSDoc-vs-literal-dead-
code clarification above.**

## AS-LANDED — Slice 1 (2026-08-08)

SHA: `83f034b8`.

**What shipped vs spec.** Design text: "Slice 1 — dictValueKindOf/
mapValueKindOf onto BindingFacts. Files: src/kind.js." Read literally this
suggests migrating dictValueKindOf/mapValueKindOf's STORAGE onto a new
`BindingFacts` table. That table does not exist yet (no slice before 7
creates it), and reconstructing genuine multi-kind union precision would
require touching the actual census PRODUCERS — `analyze.js`'s
`dictValueTypeOf`/`mapValueTypeOf` and `program-facts.js`'s
`observeDictValue`/`poisonDictValue` — which already collapse a disagreeing
pair of writes to `null` (first-wins-then-clash poison, the SAME
universal/meet algebra FINDING-7 names as wrong for this existential
question) BEFORE `dictValueKindOf`/`mapValueKindOf` ever see the raw
per-write kinds. Touching those producers is outside the design's own
"Files: src/kind.js" scope for this slice, and the design's OWN Slice 7 file
list independently confirms this precision work is deliberately deferred
there ("plus whatever Map.get()-promotion wiring SS3.1 needs in
program-facts.js").

**Resolution (not a spec conflict requiring a STOP — reconciled within the
design's own words):** Slice 1 lands `censusKindsOf(name)` in `src/kind.js`
as the OPT-IN, Set-valued sibling the COORDINATOR RULING on OQ1 names,
computed from dictValueKindOf/mapValueKindOf's EXISTING (already-resolved,
single-kind-or-none) answer, wrapped through `joinKinds` — "dictValueKindOf/
mapValueKindOf onto the Fact shape" in the sense of "exposed through the
Fact-shaped Set/`joinKinds` vocabulary," not "their storage substrate
replaced." This is genuinely a "fully contained... src/kind.js[-only]"
change (matching the design's own risk framing) precisely BECAUSE it doesn't
touch the producers. The producer-side union-widening that would let
`censusKindsOf` return a real `{NUMBER, STRING}`-shaped answer for a
genuinely heterogeneous dict/map is banked as explicitly out of scope for
this slice, matching Slice 7's own file list — not a new deviation, a
reading the design text already supports once Slice 7's scope is
cross-checked.

**OQ1 ruling compliance:** `censusKindsOf` is additive-only — no existing
field, function, or call site changed. `dictValueKindOf`, `mapValueKindOf`,
and their sole dispatcher `censusMaybeUndefinedKind` are byte-for-byte
untouched. `grep -rn censusKindsOf src/ module/ test/` post-land shows
exactly 2 hits, both inside its own definition/doc comment in `kind.js` —
zero consumers, as required.

**Gate results:**
- Bench-corpus byte-identity: same 58-case/174-compile corpus, same
  `93d04a44` baseline — **0 diffs** (trivial: the new function is dead code,
  nothing reads it).
- Full battery: `npm test` — **3407/3415 pass**, same 2 pre-existing fails
  as Slice 0, no new failures.
- kernel-parity: **33/33** byte-identical.
- `npm run build` ×2: byte-identical (hashes above, same run covers 0+1).
- Fuzz: `node test/fuzz.js --count=2000 --opt=0,3` (seeds 1..2000) and a
  second independent run `--seedStart=2001` (seeds 2001..4000) — **0
  divergence** both runs, 30173 + 30672 numeric-input comparisons, jz wasm
  == JS at every opt level tested.
- Design's own Slice 1 acceptance ("standard triad only... fully contained
  change"): satisfied — see byte-identity/battery/kernel-parity above.

**Verdict: GREEN. No design deviation requiring coordinator re-ruling** —
the file-scope tension is resolved by treating "onto the Fact shape" as a
projection/vocabulary change (this slice) with the producer-side precision
work correctly attributed to Slice 7 (the design's own text already says
so); flagged here in full so the coordinator can override this reading if
Slice 4b/7 turn out to need `censusKindsOf` to carry real union precision
sooner than Slice 7.

## AS-LANDED — Slice 2 (2026-08-08)

SHA: `0be8533e`.

**What shipped.** Exactly as specified: `src/reps.js` gains `ALL_KINDS`
(`new Set(Object.values(VAL))`, the 14-member domain) and `isDisjointFrom(name,
kindSet)` — a projection returning `true` only when `name`'s existing
`recvArrTyped` class proof holds AND `kindSet` excludes both `VAL.ARRAY` and
`VAL.TYPED`. `module/array.js`'s single `recvArrTyped` definition site
(numeric-key guard, was `ctx.func.localReps?.get(arr)?.recvArrTyped ===
true`) now reads `isDisjointFrom(arr, NOT_ARRAY_OR_TYPED)`, with
`NOT_ARRAY_OR_TYPED` (`ALL_KINDS \ {ARRAY, TYPED}`) computed once at module
scope. Both of `recvArrTyped`'s two USE sites (the two `if (recvArrTyped)`
checks further down the function) are untouched — only the single definition
changed, since both reads already flowed from that one local.

**No computation change, as the design specifies.** `isDisjointFrom` reads
the exact same `r.recvArrTyped === true` bit `module/array.js` read directly
before; the kindSet exclusion check is the algebraic identity
`kindsOf ⊆ {ARRAY,TYPED} ⟺ kindsOf ∩ (ALL_KINDS∖{ARRAY,TYPED}) = ∅` — same
boolean, every input. No other `recvArrTyped` producer (narrow.js
`hardParamRecvArrTyped`, compile/index.js's two propagation sites) needed
touching — the design's file list (`src/reps.js`, `src/module/array.js`)
was exactly sufficient, no scope tension to bank.

**OQ1 ruling compliance:** not applicable to this slice — `isDisjointFrom`
here draws solely on `recvArrTyped` (an ordinary REP field, not a
census-derived claim), so the Option-A opt-in restriction (binding on
census-kind unions specifically) has nothing to gate. Flagged so a later
slice doesn't assume `isDisjointFrom` is already OQ1-restricted by
construction — it will need its own gate the day a census-sourced kind set
feeds it.

**Gate results:**
- Bench-corpus byte-identity: 58-case/174-compile corpus (all non-graph
  `bench/*/*.js` cases, O0/O2/O3), against a disposable `git worktree` at
  pre-slice HEAD (`6a73b575`) — **0 diffs**.
- Full battery: `npm test` — **3407/3415 pass**, same 2 pre-existing fails
  as Slices 0-1 ("interval walk: strided companion cursor…", "typed RMW: one
  guard covers the pure read…"), no new failures.
- kernel-parity: **33/33** byte-identical (3 files × 11 rows, O0/O2/O3).
- `npm run build` ×2 (foreground, both rounds after the source change):
  byte-identical — `dist/jz.js` sha256
  `7513a9c4cd81a1cbb58c320f9e282a4181300f30cc4e41a8f7f82f45378bb6fe`,
  `dist/jz.wasm` sha256
  `beb60df421e0e8f07cb08a9dc0785bdc3393096033c843959576c655b0de58e6`,
  `dist/interop.js` sha256
  `ef42c9da1ab79349a5ab69d55558082de4b3d228850b87a9a188b6722ef730e1` (identical
  to Slice 0-1's own interop.js hash, as expected — this slice never touches
  interop). `jz.js`/`jz.wasm` differ from Slice 0-1's recorded hashes, as
  expected — they embed this slice's own source change.
- Fuzz: `node test/fuzz.js --count=2000 --opt=0,3` (seeds 1..2000, 30173
  numeric-input comparisons) and `--seedStart=2001` (seeds 2001..4000, 30672
  comparisons) — **0 divergence** both runs.
- test/perf.js (the two pins directly naming this mechanism — "receiver
  proven ARRAY-or-TYPED across disagreeing call sites drops the guard
  entirely" / "genuinely unproven receiver (ARRAY vs OBJECT) keeps the
  numeric-key guard"): 55/55 pass, unchanged.

**Verdict: GREEN, zero deviation from spec.** No behavior delta — the design's
own framing for this slice ("no computation changes... trivial") is exactly
what landed; there is no newly-firing disjointness to report (that only
becomes possible once a real `possibleKinds` Set exists, Slice 6/7).
