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

## AS-LANDED — Slice 3 (2026-08-08)

SHA: `83d8f569`.

**What shipped vs the design's literal Slice 3 text.** Design text: "presence
unification (`censusMaybeUndefined` boolean family, 13 sites)... Consumers
migrated: the 13 boolean call sites... Sub-slice discipline: shadow-assert
FIRST (compute both the old `makeValTracker`-derived boolean and the new
`presence` field... assert equal)... only delete `makeValTracker`'s poison-Set
AFTER". Read literally this describes touching 13 call sites across
`kind.js`/`emit.js`/`module/{core,string,console,number}.js` and shadow-
verifying against a `makeValTracker`-derived boolean.

Two things in that text don't match live code, checked directly rather than
assumed: (1) `censusMaybeUndefined`'s 13+ call sites (`emit.js` ×8, `ir.js`
×3, `module/{core,string,console}.js` ×4) already call
`censusMaybeUndefined(node)`/`censusMaybeUndefinedKind(node)` as an opaque
boolean/kind function — none of them read a REP field directly, so there is
no per-call-site "migration" left to do; the presence check lives at exactly
ONE place, `censusMaybeUndefinedKind`'s bare-name arm (`kind.js:508`,
`if (r?.mayBeUndefined)`). (2) `makeValTracker` (`analyze.js:123`) is the
poison-on-disagreement tracker used for `val`/`presentVal` — an unrelated
kind-lattice mechanism (§thesis's own target for the *separate* `val`
migration, design §5 Slice 4) — `mayBeUndefined` itself is set via plain
`updateRep(name, {mayBeUndefined: true})` (`analyze.js:1747,1871`,
`compile/index.js:626,1889`), an unconditional monotonic-OR merge with no
poison branch and no `makeValTracker` involvement anywhere in its producer
chain (checked directly: `grep -n mayBeUndefined src/compile/*.js`, all
producer sites shown are plain `updateRep` calls). There is no second,
independently-computed "old boolean" to shadow-assert against — `presence`
*is* `mayBeUndefined`, today, not a parallel mechanism converging toward it
(exactly what §1.2 itself already says: "isomorphic to the EXISTING
`mayBeUndefined` field... not migrated conceptually, only re-homed").

**Resolution (reconciled within the design's own words, matching Slice 1's
precedent — not a spec conflict requiring a STOP):** landed per the
coordinating brief's explicit narrower framing for this slice ("existing
censusMaybeUndefined behavior byte-identical... becomes a projection reading
the same underlying facts; no consumer behavior change this slice"), which
is what §1.2's own text already supports once read literally (a re-homing,
not a re-derivation). `src/reps.js` gains `mayBeUndefined(name)` — a named
projection wrapping the exact same `ctx.func.localReps?.get(name)
?.mayBeUndefined === true` read `kind.js` used to inline — and
`censusMaybeUndefinedKind`'s ONE presence-check site now calls it. No shadow-
assert was needed or run: a one-line delegation to the identical field read
cannot diverge from itself, so there is nothing for a shadow run to compare
against (the "prove equality, then move the source of truth" discipline
research.md:862-871 describes applies to genuinely-independent twins, e.g.
the layout-kinds.js migration it documents — not applicable here since only
one mechanism exists). The 13+ `censusMaybeUndefined`/`censusMaybeUndefinedKind`
call sites are untouched, confirmed byte-for-byte unchanged; `makeValTracker`
is untouched (it is Slice 4's concern, not this slice's — the design's own
file list for Slice 4 is `src/param-reps.js`, `src/compile/narrow.js`,
disjoint from this slice's `src/reps.js`, `src/kind.js`).

**OQ1 ruling compliance:** not applicable — this slice touches only the
`presence` component (a plain REP field, never a census-derived KIND claim),
so the Option-A opt-in restriction (binding on kind-unions specifically)
has nothing to gate here. `mayBeUndefined(name)` is a direct field
projection, not a `possibleKinds`-shaped answer.

**Gate results:**
- Bench-corpus byte-identity: 58-case/174-compile corpus, disposable `git
  worktree` at pre-slice HEAD (`84347d08`) — **0 diffs**.
- Full battery: `npm test` — **3407/3415 pass**, same 2 pre-existing fails,
  no new failures.
- kernel-parity: **33/33** byte-identical.
- `npm run build` ×2 (foreground, explicit long timeout both rounds):
  byte-identical — `dist/jz.js` sha256
  `247f368324f42e37bf3f9dcd3bc3897528636ca3c17be3c1b9587e248faeb574`,
  `dist/jz.wasm` sha256
  `87bac73c58c1a8d9102ec26fc1c05caec053de29ddc8d9cadc67c03481d2a4b8`,
  `dist/interop.js` sha256
  `ef42c9da1ab79349a5ab69d55558082de4b3d228850b87a9a188b6722ef730e1`
  (identical to Slices 0-2's own interop.js hash — this slice never touches
  interop either).
- Fuzz: `node test/fuzz.js --count=2000 --opt=0,3` (seeds 1..2000, 30173
  comparisons) and `--seedStart=2001` (seeds 2001..4000, 30672 comparisons)
  — **0 divergence** both runs.

**Verdict: GREEN. No design deviation requiring coordinator re-ruling** —
the file-scope/mechanism tension between the design's literal "13-site
migration + shadow-assert against `makeValTracker`" text and live code is
resolved the same way Slice 1's was: the coordinating brief's own narrower,
explicit framing for this slice ("byte-identical... projection reading the
same underlying facts... no consumer behavior change") already matches what
§1.2 independently says about `presence`/`mayBeUndefined` being a re-homing,
not a migration. Flagged in full so the coordinator can override this
reading if a later slice (Slice 4+, once `val`'s own lattice changes) turns
out to need the 13+ call sites individually touched after all.

## AS-LANDED — Slice 4a (2026-08-08)

SHA: `3947fef2`.

**What shipped vs the design's literal 4a text.** Design text: "mergeParamFact's
disagreement branch flips to union... A compatibility SHIM keeps every existing
exact-kind caller byte-identical: `valTypeOf`-shaped callers read
`possibleKinds.size===1 ? [...possibleKinds][0] : null`." Read literally this
replaces `val`'s own storage with a shim computed FROM `possibleKinds`. The
coordinating brief for this session specified a narrower, safer form instead —
"`val`'s existing meet/sticky-null behavior stays BIT-IDENTICAL this slice...
`possibleKinds` ... stored ALONGSIDE (not replacing) `val`" — no shim, `val`
keeps its own independent storage and algebra untouched, `possibleKinds` is
purely additive. This is a stricter reading of the same acceptance criterion
("byte-identical... nothing downstream can tell the difference yet," design §5)
reached without the shim's own flagged cost (risk register item 3: "new code on
a hot path... needs a perf regression check the byte-identity gate alone won't
catch") — the additive form makes byte-identity trivially, structurally true
for `val` (it is never read through a derived path) rather than provably true
of a new indirection. Matches the Slice 1/Slice 3 precedent of the
coordinating brief's own narrower framing superseding the design's literal
mechanism where the two diverge; not a spec conflict requiring a STOP.

**Producer sites (the design's "same observation sites that feed val's meet").**
Exhaustive grep-verified enumeration of every `paramReps` `.val` write in
`narrow.js` (four hits total; a fifth, `p.val = r.val` at the sig.params
stamp, line ~2536, writes a *different* object — `func.sig.params[k]`, not the
paramReps rep — and was left untouched, out of scope):
1. `mergeRule('val', inferValAtSite, true)` (line ~1780, inside `fixpointRules`,
   the SOFT sweep run to convergence by `runFixpointConverged`'s worklist).
2. `mergeRule('val', inferValAtSite)` (line ~2280, the ONE-SHOT HARD settle
   sweep after every producer — results, typedCtor, enrichment — has run).
3. `specializeBimorphicTyped`'s clone-rep override, `r.val = VAL.TYPED`
   (line ~3000) — gated on `r.val === VAL.TYPED` already holding on the SOURCE
   rep (`specializeBimorphicTyped`'s own bimorphic-position filter,
   `r.val !== VAL.TYPED || r.typedCtor !== null` → skip), so the source rep's
   `possibleKinds` (inherited via `{...r}` spread into `cloneReps`) already
   contains `VAL.TYPED` before this line runs — the explicit `joinKinds` here
   is defensive redundancy, not a new fact, kept anyway so the invariant does
   not depend on a different function's filter staying aligned with this one.
4. `speculateTypedParams`'s clone-rep override, `r.val = VAL.TYPED`
   (line ~3386) — NOT similarly gated (its candidate filter accepts `r.val ===
   null`, i.e. a genuinely-poisoned source, promoted here via a STRONGER,
   independent inference — `inferTypedCtor`/`evidenceOfArg` — than
   `inferValAtSite` ever ran). Here the explicit `joinKinds(r, 'possibleKinds',
   [VAL.TYPED])` is load-bearing: without it, a poisoned source rep's
   `possibleKinds` could lack `VAL.TYPED` even though the clone's `val` is
   forcibly set to it, which would violate the consistency invariant for real.

`mergeRule`'s `trackKind` flag (new 4th parameter, default `false`, `true` only
at sites 1-2) computes the per-site kind once and feeds BOTH channels: `val`
through the unchanged `mergeParamFact` call at the unchanged
`r[field]===null` guard position, `possibleKinds` through `joinKinds`
UNCONDITIONALLY (even once `val` has already gone sticky-TOP) — this is the
one deliberate behavioral divergence from "identical code path," and it is
required: `possibleKinds`'s entire reason to exist is retaining the kinds
`val`'s poison discards, so gating it behind `val`'s own early-return would
make it degenerate to mirroring `val` (empty or singleton, never the
`{NUMBER,STRING}`-shaped answer §3.2 describes). Non-`val` `mergeRule` fields
(`schemaId`) pass `trackKind=false` and are byte-identical to pre-slice code
— `infer` is called from the exact same branch, same count, same order.

**Consistency invariant.** `assertValKindConsistent(paramReps)`
(module-scope, DBG-only) throws unless every resolved `r.val` is a member of
`r.possibleKinds`, called after each of the three functions that can still
write `.val` post-`narrowSignatures` returns: end of `narrowSignatures`
itself, end of `specializeBimorphicTyped`, end of `speculateTypedParams`.
Zero fires across the full `JZ_DEBUG_INVARIANTS=1` battery (below).

**OQ1 ruling compliance.** Not yet applicable in the restrictive sense —
`paramReps.possibleKinds` here is populated from per-call-site argument-kind
inference (`inferValAtSite`), the SAME producer `val` already used, not from
a census/`.get()`-sourced claim (the specific pattern OQ1's verdict examined
and restricted). No consumer reads `possibleKinds` yet at all (see Slice 4b
below), so the opt-in restriction has nothing to gate this slice — flagged
so a later slice doesn't assume paramReps' `possibleKinds` is pre-cleared for
general consumption; it is exactly as unconsumed as the design intends for a
storage-only slice.

**OQ3 (shared numeric/rep observation pass, FINDING-10) — not applicable
here.** OQ3's adopt-if-free opportunity targets `numeric`/`rep`'s
observation TIMING (unifying two separately-timed passes so the P-carrier
invariant becomes structural). Slice 4a touches neither field — it is a
`possibleKinds`/`val` change only — so there is no shared-pass opportunity
to take or skip in this slice; noted per the task's instruction to record
why, not silently passed over.

**Gate results:**
- Byte-identity: 59 compilable cases (all `bench/*/*.js` entries except `jz`,
  a self-referential compiler-graph source that fails to compile on BOTH the
  current tree and the baseline worktree — pre-existing, unrelated) × O0/O2/O3
  = 177 compiles, against a disposable `git worktree` at pre-slice HEAD
  (`b5673050`) — **0 diffs**.
- Full battery: `npm test` — **3407/3415 pass**, same 2 pre-existing fails as
  Slices 0-3 ("interval walk...", "typed RMW..."), no new failures.
- `JZ_DEBUG_INVARIANTS=1` battery (exercises `assertValKindConsistent` on
  every paramReps entry across the whole corpus): **3407/3416 pass**, 3 fails
  — the same 2 pre-existing ones plus one already-known flake under this flag
  (`analyzeValTypes: declRange restamp for 'cf1_8' diverges`, audit-#12 item 2's
  own idempotence probe, unrelated to param-reps/narrow.js) — **zero**
  occurrences of `possibleKinds/val consistency` in the failure list; the new
  assert never fired.
- kernel-parity: **33/33** byte-identical.
- `npm run build` ×2: byte-identical — `dist/jz.js` sha256
  `4f8cda078b8c64811463e438281ea2554f9360e5c00073b644c597fe1d5e0e42`,
  `dist/jz.wasm` sha256
  `36fb5b0997c7f659fca5d3d22b680fb80517aef630d624aebdfaa469dc6d2e63`,
  `dist/interop.js` sha256
  `ef42c9da1ab79349a5ab69d55558082de4b3d228850b87a9a188b6722ef730e1`
  (identical to every prior slice's interop.js hash — this slice never
  touches interop either).
- Fuzz: `node test/fuzz.js --count=2000 --opt=0,3` (seeds 1..2000, 30173
  numeric comparisons, 9827 skipped i32-contract-exceeded) and
  `--seedStart=2001` (seeds 2001..4000, 30672 comparisons, 9328 skipped) —
  **0 divergence** both runs.

**Verdict: GREEN.** One design-text-vs-coordinating-brief reconciliation
(the shim-vs-additive-storage divergence above), resolved the same way as
Slices 1/3 — the brief's narrower, explicit framing for THIS session
supersedes the design doc's literal mechanism, banked in full for the
coordinator to override if a later slice needs the shim's actual
`possibleKinds.size===1` behavior for some consumer the additive form
doesn't serve.

## AS-LANDED — Slice 4b (2026-08-08)

No code landed — **zero consumers**, a legitimate outcome the task's own
brief names explicitly ("It is a legitimate outcome for 4b to land ZERO
consumers this session").

**Exclusion list.** The design's own Slice 4b text (§5, pre-amendment) names
exactly two consumers, both "starting with" — no others are named anywhere
in the design for `possibleKinds`-shaped consumption: (1) `arr`'s
`isDisjointFrom` check in `keyedWrite` (§3.1's `Map.get()`-promotion
mechanism), (2) `mapValueKindOf`'s receiver-alias gate for §18. Both are
EXCLUDED by the COORDINATOR RULING on OQ1: these are the EXACT two mechanisms
the OQ1 verdict traced concretely and found unsound-as-specified — a
census-derived kind union (`arr.possibleKinds ∪= elementKinds(mapKey) ∪
{presence-implied-undefined}`) written into the SAME general `possibleKinds`
field that `isDisjointFrom`/`kindsOf`/`isExactly`/`cannotBe` expose to every
consumer, with no structural requirement that a codegen-affecting caller also
consult `presence` — reproducing the exact opt-out-consumer-exposure shape
that killed `1db8e55e`/`7288b69b`/`098014a5` (the three-revert history OQ1's
verdict re-examined). The ruling's Option A requires census-derived kind
unions to live behind a separate opt-in projection (`censusKindsOf`, already
landed Slice 1) — `keyedWrite`'s `arr` check and `mapValueKindOf`'s
receiver-alias gate would need to consume `censusKindsOf` (and explicitly
conjoin `!mayBeUndefined`), not `paramReps.possibleKinds`/general
`isDisjointFrom`, to land at all — a DIFFERENT, not-yet-attempted mechanism,
correctly deferred to Slice 7 per the design's own file list ("plus whatever
`Map.get()`-promotion wiring §3.1 needs in `program-facts.js`").

**Why no other 4b candidate exists for THIS slice's producer.** Slice 4a's
`possibleKinds` is populated for `paramReps` (per-parameter call-site kind
observations) — a different producer from the `arr`/`mapValueKindOf`
receiver-kind mechanism §3.1/OQ1 examined. No consumer anywhere in the design
text reads `paramReps.possibleKinds` specifically; the two named 4b
candidates were never about params at all. Since the design names no
opt-in-safe consumer for paramReps' own `possibleKinds`, and the ruling
forbids inventing a general-dispatch consumer ad hoc, the correct, minimal,
ruling-compliant landing for this slice is zero consumers — precision banked
for a future slice that names one explicitly, with its own gate.

**Verdict: GREEN by construction** — no code, no risk, no gate beyond what
Slice 4a already ran. Next: Slice 5 (FINDING-7 `!==`/`===` sites) or Slice 6
(`SlotFact` unification), per the design's ordering — both independent of
Slice 4b landing zero consumers here.

## AS-LANDED — Slice 5 (2026-08-08)

No code landed — **zero sites migrated, all 8 excluded by the standing OQ1
ruling**, a legitimate outcome directly analogous to Slice 4b's.

**The 8 code sites, exhaustively enumerated** (survey's own count: "emit.js:
6 (298, 4596, 4754, 4792, 6224, +1 doc), ir.js: 2, type.js: 1" — the "+1 doc"
is a comment at `emit.js:290` quoting the pattern that lands as real code at
line 298 one line of context below it; a second such quoting comment sits at
`emit.js:6222` immediately above line 6224 — neither is a second code site,
confirmed by direct read, not assumed):

| Site | Direction | Function | Shape |
|---|---|---|---|
| `emit.js:298` | `===` (OR'd with `valTypeOf(a)===VAL.BIGINT`) | `emitNeg` | opt-in chokepoint |
| `emit.js:4596` | `===` | `bigIntDomain` | opt-in chokepoint |
| `emit.js:4754` | `!==` | `bigIntOperand` | opt-in chokepoint |
| `emit.js:4792` | `!==` | `bigIntUnary` | opt-in chokepoint |
| `emit.js:6224` | `===` (OR'd with `valTypeOf(a)===VAL.BIGINT`) | `~` unary emit | opt-in chokepoint |
| `ir.js:1285` | `===` (gated `vt==null &&`) | `toNumF64` | opt-in chokepoint |
| `ir.js:1475` | `===` (gated `vt==null &&`) | `toStrI64` | opt-in chokepoint |
| `type.js:2288` | `===` (unconditional, deliberately NOT `vt==null`-gated per its own §14 point-4 comment) | `preciseBigCensus` | opt-in chokepoint |

Every one of the 8 is a `censusMaybeUndefinedKind(node) === / !== VAL.X`
sub-expression — confirmed by direct read of each site (not sampled): all
eight are exactly the audit-#8/§14-hardened "individually audited,
explicitly opted-in chokepoint" architecture (`.work/lattice-design.md`
OQ1 verdict's own words), the same architecture that survived three prior
reverts (`1db8e55e`, `7288b69b`, `098014a5`) by staying opt-in rather than
folding a census claim into a general-dispatch kind projection.

**Why none of the 8 is eligible for the `isExactly`/`cannotBe(key, X)`
migration Slice 5's literal text specifies — traced structurally, not
asserted:**

1. **The projections don't exist for what these sites read.** `isExactly`/
   `cannotBe` (§3's catalog) are defined over `Fact.possibleKinds` — a
   `key`-addressable field (`BindingFacts`/`ParamFacts`/`SlotFacts`, §2).
   `censusMaybeUndefinedKind(node)` takes an arbitrary AST node (a
   census-shaped `[]`/`.`/`()` read OR a bare name) and returns its OWN
   independently-resolved single-kind-or-null answer — it is not a read of
   `Fact.possibleKinds` at any key, so there is no `key` to hand
   `isExactly`/`cannotBe`.
2. **Even where a `key` could be manufactured (the bare-name arm), routing
   through the general projection would be a live behavior change, not a
   migration.** `Fact.possibleKinds`, per Slice 1's own landed decision AND
   the COORDINATOR RULING on OQ1 (this file, above), never receives a
   census-derived contribution — `censusKindsOf` is a separate, opt-in,
   currently-zero-consumer sibling specifically BECAUSE folding census
   claims into the general field is the exact opt-out-consumer-exposure
   shape that killed three prior landings. `isExactly(key, VAL.BIGINT)` at
   any of these 8 sites would therefore answer FALSE for every case the
   census arm exists to catch (a dict/Map value proven BIGINT, or a
   decl-hopped `presentVal`/`mayBeUndefined` claim) — silently discarding
   exactly the information audit-#8/§14 fought to keep reachable. This is
   not a hypothetical: `bigIntDomain`'s own doc comment (`emit.js:4558-4580`)
   names the `'census'` domain as a THIRD, independent evidence source
   precisely because `valTypeOf`/`Fact.possibleKinds`-shaped evidence
   (`'bigint'`) does not cover it.
3. **`censusMaybeUndefinedKind`'s own representation is not migrating under
   this design.** FINDING-7's sentinel-inversion risk (survey lines
   639-649) is a risk that only exists WHEN a field's storage flips from
   "exact-kind-or-null" to "Set-valued, TOP=full-domain" — the survey's own
   framing ("a naive migration to `!possibleKinds.has(VAL.BIGINT)`
   preserves this only if TOP is represented as the FULL kind set") presumes
   exactly that flip is happening. Slice 1 (AS-LANDED, above) landed
   `censusKindsOf` as PURELY ADDITIVE — `dictValueKindOf`, `mapValueKindOf`,
   and `censusMaybeUndefinedKind` are "byte-for-byte untouched," confirmed by
   the zero-consumer grep at Slice-1 landing time and re-confirmed here
   (unchanged since). No representation flip is scheduled for
   `censusMaybeUndefinedKind` anywhere in the design (Slice 6/7's file lists
   are `program-facts.js`/`module/schema.js`/`param-reps.js` — the slot* and
   `val` families, not `kind.js`'s census helpers). With no flip, there is no
   sentinel to invert — the risk the survey's row names never materializes
   at these 8 sites under the design AS RULED, only under the naive
   migration the ruling forecloses.
4. **The `valTypeOf(a) === VAL.BIGINT` half of the two OR-expressions
   (`emit.js:298, 6224`) is a different, out-of-scope producer, not a second
   instance of the surveyed pattern.** `valTypeOf` recursively resolves an
   arbitrary expression tree (literals, unary/binary ops, bare names) via
   `VT[op]` — the survey's migration-risk row names `censusMaybeUndefinedKind`
   specifically, not `valTypeOf`; `valTypeOf`'s own dispatch table is
   untouched by every slice landed so far and is not on Slice 5's file list
   in any generative sense (its consumers are legion — 492 `=== VAL.`/
   `!== VAL.` matches repo-wide, most of them `kind-traits.js`'s VT dispatch
   table computing a DERIVED kind from already-resolved operand kinds, a
   sound-by-construction shape with no unresolved-sentinel to invert at all,
   confirmed by grep and excluded from the survey's own count for exactly
   this reason).

**Directional check (per the task's own "review lowest-risk first"
instruction, and per FINDING-7's explicit `!==`-is-higher-risk framing).**
The 2 `!==` sites (`emit.js:4754, 4792`, `bigIntOperand`/`bigIntUnary`) were
read in full context: both are audit-#8 P0-4-hardened, and both comments
state directly that "unresolved ⇒ take the definitely-not-BIGINT fast path"
is the INTENDED, already-proven-safe semantics (absent-key `ToNumeric`
correctly yields Number NaN, never BigInt, so a census-unresolved node
correctly takes the plain-i64-read path with no undefined-check). This
confirms the survey's own characterization ("silently relying on
'unresolved ⇒ treat as not-BIGINT' being safe in context") as accurate
description of INTENDED behavior, not a latent bug — and per finding 3
above, migrating the boolean's SHAPE (not its answer) is unreachable without
violating OQ1, so the sound-idiom migration this slice was chartered to do
has no landing site here. The 6 `===` sites carry no analogous risk in
either direction (`null !== VAL.X` and `null === VAL.X` are both correct
under EITHER exact-or-null or Set/TOP representation — the direction
FINDING-7 itself calls the safe one).

**Resolution — not a STOP.** This is the identical shape as Slice 4b's
exclusion, one level down: OQ1's ruling ("census-derived kind unions NEVER
enter the general `possibleKinds` field... they live in a separate OPT-IN
projection") is a standing, already-coordinator-reviewed and BINDING part of
this design, not a live ambiguity requiring a new ruling. Slice 4b excluded
the two named PRODUCER-side candidates (`arr`'s `isDisjointFrom`,
`mapValueKindOf`'s receiver-alias gate) on this exact ground; Slice 5's 8
CONSUMER-side sites are excluded on the same ground, one hop downstream —
they read the same opt-in mechanism OQ1 protects, through the SAME contract
(`censusMaybeUndefinedKind`'s existing null-vs-kind answer, unchanged). Per
the task's own spec-vs-live-conflict clause, a STOP is for an unresolved
tension the design doc doesn't already adjudicate; this one is adjudicated,
in the design doc itself, by name.

**Site accounting.** Migrated: 0. Skipped (false positive for THIS slice's
projection-catalog target, excluded by the standing OQ1 ruling): 8 (all
`censusMaybeUndefinedKind` `===`/`!==` sites, table above). Banked as
genuinely ambiguous: 0 — nothing here is ambiguous, all 8 resolve the same
way for the same stated reason.

**Verdict: GREEN by construction** — no code, no risk beyond what Slices 1
and 4b already carried. No new gate run (no source line changed; the
standard triad would trivially reproduce Slice 4a's own recorded numbers
against an unmodified tree, not new evidence) — `npm test` re-run once for
current-tree sanity only (see ledger). Next: Slice 6 (`SlotFact`
unification, per the OQ2-adopted 6a/6b split) or Slice 7 (sticky-null
retirement, blocked on Slice 6) — Slice 5's own `!==`/`===` consumer target
is now fully accounted for (0 migrated, 8 excluded), so no further work
remains under this slice's name; a genuine `censusMaybeUndefinedKind`-shaped
Set migration, if ever wanted, would require first re-opening OQ1's ruling
itself, not a Slice-5-shaped consumer edit.

## AUDIT-#16 FOUNDATION CORRECTIONS (2026-08-08, coordinator, pre-Slice-6-consumer)
Landed before any possibleKinds consumer exists (all P0/P1 dormant, fixed at
the root): P0-1 unresolved live observations (v==null at both mergeRule arms)
now join the full KIND_UNIVERSE — possibleKinds is a genuine runtime-kind
superset or ∅; the ∅=BOTTOM exclusion contract (fail closed on empty/absent,
covers zero-observed/exported/host-callable params that never reach the
rules) is written into param-reps.js as the binding projection contract.
P1-3 cloneRep() is THE authoritative deep clone (possibleKinds Set copied;
future Set fields get their line there); the three narrow.js spread-clone
sites migrated — the confirmed clone-aliasing leak is closed. P1-4
censusKindsOf is pure (no joinKinds/latticeMeet.changed from a query).
P1-5 ALL_KINDS replaced by frozen KIND_UNIVERSE array + isKind() membership.
P0-2 (presence lacks unknown/completeness): RULING — the boolean stays
positive-evidence-only; `!mayBeUndefined(name)` is NOT a definitelyPresent
proof and no consumer may treat it as one until a completeness bit lands
(Slice 7 must respect this; the presence upgrade to a 4-point lattice or
coverage bit is queued as its own gated slice, not improvised).

## AS-LANDED — Slice 6a (2026-08-08/09)

SHA: `1d900cc8`.

**What shipped.** `slotTypes`/`slotTypedCtors`/`slotObjSids`/`slotBigintObserved`
— 4 of the design's named "slot* family" — GENUINELY DELETED (not faceted
over): `src/ctx.js` no longer declares any of the 4 as `new Map()`; the sole
storage is `ctx.schema.slotFacts: Map<sid, Array<SlotFact|undefined>>`, one
record `{ kind, typedCtor, objSid, bigintObserved }` per `(sid, idx)`.
`program-facts.js`'s `observeProgramSlots` (the single-pass producer all 4
share) rewrites its `observeSlot`/`poisonSlot`/`poisonCtor`/`observeObjSid`/
`poisonObjSid`/`observeCtor`/`observeBigintJoin` closures onto ONE shared
grow-helper (`slotFact(sid,idx)`) instead of 4 separately-grown arrays.
`module/schema.js`'s 8 consumer functions (`slotVT`, `slotTypedCtorBySid`,
`slotTypedCtorByProp`, `chainSid`, `slotBigintBoxedBySid`,
`slotBigintProvenBySid`, plus the 2 that read them transitively) share ONE
`factAt(sid,idx)` read helper. `module/core.js`'s one direct
`ctx.schema.slotTypes.get(...)` read (a guard-arm stamp check, outside both
files the design's own file list names) migrated too — verified via
exhaustive grep, zero surviving references to the 4 old names anywhere in
`src/`/`module/`/`test/` outside historical doc comments.

**Deliberately NOT unified** (banked, matching this session's own
audit-#16-adjacent scoping discipline, not a design deviation requiring a
STOP): `slotIntCertain`/`slotI32Certain` stay their own dedicated Maps. The
design's consolidation table counts "5 parallel Map structures" (treating
the intCertain/i32Certain PAIR as one item, since they're twin projections
published together from ONE source, `slotIntLevels`) — unlike the 4 fields
above, they were never a genuinely duplicated algebra (FINDING-2's actual
target): `analyzeSchemaSlotIntCertain`'s round-based fixpoint already
publishes both from a SINGLE `slotIntLevels` source with no independent
clash-poison logic to delete. They also have a materially different
clear/rebuild lifecycle (`opts.paramReps`-keyed, not `opts.fresh`-keyed) and
genuine external Map-native consumers (`compile/index.js`'s `.size` gate,
`test/slot-hazards.js`'s `.values()` assertion, the P-carrier invariant
loop) that would need reconciling two independently-timed clear disciplines
on shared storage for zero reduction in duplicated logic. Left untouched.

**OQ1/OQ2/OQ4 compliance:** not directly applicable — 6a touches storage
representation only, no new consumer reads `possibleKinds` and no
`hz`/`pointsTo` composition changed (that's 6b). `applySlotWriteHazards`'s
own hz-composition logic, `slotHazarded`, `chainHazarded` are byte-for-byte
untouched in this commit, confirmed by grep — the OQ2 verdict's own
"same hz shape in, same poison semantics out" requirement for 6a holds.

**Gate results:**
- Byte-identity: 58-case/174-compile corpus (bench-lib-resolved, matching
  the documented precedent count exactly — 'jz' and 'jessie' excluded, the
  latter a harness module-resolution gap not a compiler behavior gap),
  disposable `git worktree` at pre-slice HEAD (`8c1f5ea4`) — **0 diffs**.
- Full battery: `npm test` — **3407/3415 pass**, same 2 pre-existing fails
  as every prior slice ("interval walk...", "typed RMW..."), no new
  failures.
- `JZ_DEBUG_INVARIANTS=1` battery: **3407/3416 pass**, 3 fails — the same 2
  pre-existing plus one already-known flake (audit-#12 item 2's own
  idempotence probe, unrelated) — the P-carrier invariant (now reading
  `ctx.schema.slotFacts.get(sid)?.[i]?.bigintObserved` instead of the old
  `slotBigintObserved.get(sid)?.[i]`) never fires.
- kernel-parity: **33/33** byte-identical.
- `npm run build` ×2: byte-identical — `dist/jz.js` sha256
  `3b28dd11f82861785d5fa1373b9168b48cc2ca8975bcd691edd67af306e3baff`,
  `dist/jz.wasm` sha256
  `8c56f9f1d7ba90c3e2486e4adfce366b8a2e4420264a332d20727f0cfc45d934`,
  `dist/interop.js` sha256
  `ef42c9da1ab79349a5ab69d55558082de4b3d228850b87a9a188b6722ef730e1`
  (identical to every prior slice's interop.js hash).
- Fuzz: `node test/fuzz.js --count=2000 --opt=0,3` (seeds 1..2000) and
  `--seedStart=2001` (seeds 2001..4000) — **0 divergence** both runs, 60845
  numeric-input comparisons total.

**Verdict: GREEN.** Independently revertible (single commit, `1d900cc8`);
reverting restores the 4 separate Maps with zero hazard-logic change.

## AS-LANDED — Slice 6b (2026-08-09)

SHA: `ae2f653a`. Landed as ONE non-decomposable commit per the OQ2 verdict's
atomicity requirement, exactly as ruled.

**What shipped.** `hz.all`/`hz.sids` collapse into `hz.pointsTo:
Set<SchemaId> | 'ALL'` (the abstract top sentinel — never materialized,
matching §1.3's argued asymmetry). `hz.props`/`hz.numeric` stay untouched,
separate cross-cutting predicates, per §1.3's explicit "do not fold these
in" instruction. All setter sites in `collectSlotWriteHazards`
(`keyedWrite`, `patternTargets`, the spread-literal branch, the
`Object.assign` branch) route through two shared mutators — `addPointsTo`
(no-ops once `pointsTo==='ALL'`, matching the old sticky-poison shape) and
`markPointsToAll`. `applySlotWriteHazards`'s `whole` composition and
`slotHazarded` (`module/schema.js`) both read `pointsTo === 'ALL' ||
pointsTo.has(id)`. `chainHazarded` stays DELIBERATELY narrow — `pointsTo
!== 'ALL' && pointsTo.has(id)`, never the widened form — with the OQ2
verdict's own gotcha text reproduced as an in-code comment, and a
differentially-verified regression test (flipping the operator to the wide
form makes the new probe assertion fail — confirmed by deliberately
introducing the bug, running the test, seeing it fail, then reverting).

**§21 re-audit found a 4th composition site the design/OQ2 text didn't
name:** `src/kind.js`'s `VT['.']` census-deferral read (`hz.all ||
hz.props.has(...) || ...`, a decl-shape fallback independent of `slotHazarded`/
`chainHazarded`/`applySlotWriteHazards`). Full enumeration method: grepped
every `ctx.schema.slotWriteHazards` read site (not just the 3 the design
names), found 5 total — 2 producer assignments, `slotHazarded`,
`chainHazarded`, and this one. (The other 2 `slotWriteHazards` reads,
`module/json.js`'s extern-write belts, touch only `hz.kindSafeSids`, an
untouched field — not a 5th composition site.) This is the exact
methodology §21/the design's own mandate requires ("re-run the exact audit
methodology... before landing, not just re-derive it by analogy") — this
session's re-run found a real gap the original methodology's own text
missed counting.

**Mid-session coordinator constraint (banked, not a STOP — a mechanical
reconciliation):** an external audit-#16 fix landed concurrently in
`src/kind.js`/`src/param-reps.js`/`src/reps.js` this same session (commits
`3e42fbaa`/`0202b95f`, disjoint from this slice's own surfaces) — the
coordinator's instruction was to leave those 3 files untouched. Since 6b's
atomicity requirement (every `hz.all` reader must move together, or a
silent un-hazarded miscompile opens per OQ2's own text) collides with "do
not touch `kind.js`," the reconciliation: `hz.all` stays a REAL, PLAIN
boolean field on the `hz` object (not deleted, not a getter/accessor — jz's
own language subset has no getter/setter support, and this exact object
literal is compiled through itself at self-host build time; a `get all()`
accessor was tried first and correctly REJECTED by jz's own compiler with
"object getter/setter not supported," caught by the build gate before it
could land), set at the SAME single site (`markPointsToAll`) that
establishes `pointsTo`'s `'ALL'` sentinel — one classification, two fields,
never two independently-timed writes (the FINDING-10 discipline extended
here: not just numeric/rep sharing one observation pass, but `pointsTo`/
`hz.all` sharing one SETTER). `src/kind.js` diffs zero against HEAD,
confirmed by `git diff HEAD -- src/kind.js`.

**OQ4 directionality re-check (Slice 6's own gate, repeated per the task
brief):** re-ran the exact grep (`schema\.register\(` across `src/`/
`module/`) — **36 real call sites** (37 hits, 1 comment), matching OQ4's
own count exactly. Read-path check on the two sites this slice's own edits
touch (`program-facts.js`'s spread-literal and `Object.assign` branches,
lines with `addPointsTo(ctx.schema.register(names))`): `names` is built
from pure structural AST traversal (`staticAssignTargetNames`, the
spread-entries loop) in both cases — no `hz`/`pointsTo` read anywhere in
the argument-computation path. `addPointsTo`/`markPointsToAll` are
write-only (never read from within a `register`-argument builder).
Invariant holds unconditionally, same conclusion OQ4's original exhaustive
enumeration reached — this is the confirmation, not a re-derivation.

**Probe suite (targeted, per the task's own requirement):**
`test/slot-hazards.js` gains one test pinning the exact §21 counter-example
shape (`class Foo{constructor(){this.count=0}}`, `const corrupt=(obj,key,val)=>
{obj[key]=val}`, called with an untyped-param receiver AND an untyped-param
key) — asserts `f.count+'!'` decodes as `'oops!'` (string concat dispatch)
at O0/O2, not a raw-NUMBER-arithmetic type confusion, confirming
`pointsTo==='ALL'` still gates the slot-KIND read exactly as `hz.all` did.
A white-box half then confirms the GOTCHA directly: after driving
`pointsTo` to `'ALL'` via `corrupt()`, a SEPARATE, unrelated `r.p={q:1}`
write (populating `slotFacts[...].objSid`, independent of `corrupt`'s
sid/prop) still resolves through `ctx.schema.chainSid(['.','r','p'], ...)`
to the nested `{q}` schema — proving `chainHazarded` did NOT get poisoned
by the unrelated global `'ALL'`. Differentially verified: temporarily
patching `chainHazarded` to the wide (`slotHazarded`-shaped) form and
re-running makes this exact assertion fail (`actual: null, expected: 1`),
then reverted — confirms the test actually discriminates the gotcha, not a
vacuous pass.

**Gate results:**
- Byte-identity: same 58-case/174-compile corpus, same `8c1f5ea4` baseline
  — **0 diffs**. `slotHazarded`'s answers are exactly today's for every
  input, as required (this swap changes representation, not decisions).
- Full battery: `npm test` — **3408/3416 pass** (one more total than 6a's
  run — the new probe test's 6 assertions), same 2 pre-existing fails, no
  new failures. Re-run a final time on the exact landed code (post the
  `kind.js`-conflict reconciliation) for certainty: identical result.
- `JZ_DEBUG_INVARIANTS=1` battery: **3407/3416 pass**, same 3 fails as 6a's
  run (2 pre-existing + the unrelated audit-#12 flake).
- kernel-parity: **33/33** byte-identical.
- `npm run build` ×2: byte-identical — `dist/jz.js` sha256
  `ac01a76229c50ad7a2d8d2eebfe6e39cf08a5dafece23da15b33ce2c633c97f7`,
  `dist/jz.wasm` sha256
  `a26a8f4cd955562e007e797d95ad6928aad09cbdfa453b95af76efb502b0b872`,
  `dist/interop.js` sha256
  `ef42c9da1ab79349a5ab69d55558082de4b3d228850b87a9a188b6722ef730e1`.
  Self-hosting build (compiling jz's own source through itself, which the
  getter-shim attempt broke) verified working with the final plain-field
  form.
- Fuzz: `node test/fuzz.js --count=2000 --opt=0,3` (seeds 1..2000) and
  `--seedStart=2001` (seeds 2001..4000) — **0 divergence** both runs.
- `JZ_CARRIER_BOX=1` battery: ran in full, twice, on a CLEAN isolated
  rebuild of both this tree and a fresh `8c1f5ea4` baseline worktree (dist/
  deleted and rebuilt fresh for each, sequentially, no concurrent load).
  Both trees fail the SAME 11 top-level test groups (diffed by name,
  zero groups differ) — the known, already-tracked `JZ_CARRIER_BOX=1`
  divergence class (§6 risk item 8, "the gate is the divergence SHAPE
  stays the same, never byte-identity"). One already-documented-broken row
  ("kernel oracle: PENDING-FIX — generic-scalar-decl BOOL∪NUMBER carrier
  collapse," an unrelated, pre-existing, already-tracked wall per its own
  name and `research.md` citation — nothing to do with schema slot
  hazards) fails with a hard crash ("memory access out of bounds") on the
  baseline's self-hosted kernel and with its normal documented-wrong
  tripwire assertions (no crash) on this tree's kernel — investigated
  directly (not assumed): reproduced on a FRESH, isolated baseline rebuild
  specifically to rule out environmental/concurrent-load corruption as the
  cause, and the crash reproduced identically — this is a genuine,
  reproducible property of the PRE-slice-6 baseline's self-hosted kernel
  build for this one already-broken, unrelated test, not an artifact of
  this session's concurrent execution and not a regression this slice
  introduced (this tree's kernel does NOT crash on it). Banked here in
  full rather than silently absorbed into "divergence shape unchanged,"
  since the exact FAILURE MODE (crash vs assertion) did change for this
  one row — the coordinator should decide whether this pre-existing,
  unrelated crash is worth a dedicated follow-up investigation.

**Verdict: GREEN.** Non-decomposable single commit (`ae2f653a`), matching
OQ2's own "true atomic unit" framing. Reverting must revert this commit
whole — no partial-revert path exists by construction (the setter sites,
the 3 composition sites, and `src/kind.js`'s back-compat field all changed
together). Next: Slice 7 (sticky-null retirement), which depends on both
6a and 6b having landed, per the design's own ordering.
