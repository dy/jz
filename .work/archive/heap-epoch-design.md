# Heap-epoch effect model — design (architecture re-audit item 5, 2026-08-12)

Design only — no `src/` changes. Grounded in `.work/session.js`'s existing
DEPS table (`src/session.js:141-266`), `.work/lattice-design.md`'s Fact
record and key-space taxonomy (§1-§2), `src/param-reps.js`, and a direct
read of `src/ctx.js`'s `ctx.schema` census storage and
`src/compile/program-facts.js`'s `pf.gen` mechanism. `src/compile/narrow.js`
is read-only ground truth here (another agent is actively restructuring it
into a `RepresentationPlan`/whole-graph `FeaturePlan`) — every claim below
about it is stated as an assumption, not a line-pinned fact, per that
constraint.

**Motivating gap, cited directly**: `lattice-design.md`'s own risk register
(§6 item 1) already names this design's target and marks it out of scope:
*"a site that reads `possibleKinds` through a CACHED/copied reference taken
before a later join widened it (a staleness bug, not an algebra bug) — not
covered by this design."* Heap-epoch closes exactly that gap — for
schema-shape facts specifically, not for the lattice's join/meet algebra,
which stays untouched.

---

## 1. What is an epoch

**Model chosen: one monotone counter per `SlotFacts` key (`SchemaId`), plus
one shared "unknown-target" pseudo-key `⊤` that every write with an
unresolvable target bumps and that every per-sid epoch is implicitly joined
with at read time.**

```
epoch: Map<SchemaId, uint>     // per-schema counter, starts at 0 on first register()
epochTop: uint                  // ⊤ — bumped by any write whose target sid(s) can't be resolved
epochEff(sid) = max(epoch.get(sid) ?? 0, epochTop)   // the effective epoch a reader checks
```

`bump(sid)` (resolved target) increments `epoch.get(sid)`; `bump(⊤)`
(unresolvable target) increments `epochTop`, which — via `epochEff` —
retroactively covers every sid, including ones registered *after* the bump
(a freshly-registered sid's own counter starts at 0, but `epochEff` still
folds in the current `epochTop`, so it can never look "cleaner" than the
program's true hazard state at the moment it was minted).

**Key space is not invented — it is `lattice-design.md` §2's own
`SlotFacts: Map<sid, Fact[]>` table, unchanged.** FINDING-6 already ruled
against a new grand identity ("three cooperating tables... no unifying ID is
minted"); this design keeps that ruling and rides the *one* table among the
three (`SlotFacts`, not `BindingFacts` or `ParamFacts`) whose defining
structural property makes an epoch necessary at all: a schema's slot facts
are written from many, textually unrelated AST sites (every `{}` literal of
that shape, every `obj.prop=` through any of arbitrarily many aliased
bindings) and read by consumers that did not walk those write sites
themselves. `BindingFacts`/`ParamFacts` don't have this — a given
`(funcName, paramIdx)` or `(funcName, name)` has exactly the write sites the
fixpoint pass visits directly, so the fixpoint's own `latticeMeet.changed`
signal (`param-reps.js:51`) already IS the staleness discipline; layering an
epoch under it would duplicate a soundness proof that already exists (§3
below spells this out per-analysis).

`epochTop` is the counter form of today's `hz.all` (`program-facts.js`'s
whole-program hazard boolean) — `lattice-design.md` §1.3/§21 already proved
this exact role load-bearing and non-narrowable ("the coarsest possible TOP
… NOT narrowable"). This design does not invent a new escape hatch; it
promotes an already-proven-necessary boolean to a counter, so a fact stamped
*before* the hazard fires can still be told apart from one stamped after —
which a boolean structurally cannot do.

### Rejected alternatives

1. **Pure global (one counter for the whole heap).** Rejected: `ctx.schema`
   already stores every census field as `Map<SchemaId, …>`
   (`slotFacts`/`slotIntCertain`/`slotI32Certain`/`slotConstInts`/
   `slotIntLevels`, `ctx.js:520-546`) and every read-side projection is
   sid-keyed (`slotBigintBoxedAt`/`BySid`, `slotIntCertainAt`,
   `slotTypedCtorAt` — `ctx.js:480-482,540-546`). A single global counter
   bumped by *every* heap-shape event anywhere in the program — an
   `obj.prop=` write to a completely unrelated schema, an array resize on a
   name that shares nothing with schema S — would invalidate every schema's
   cached facts on every event, for every schema, for the whole compile.
   `bench/provenance`/`bench/fftplan` are named in `ctx.js:480-482` as
   depending on `slotTypedCtorAt` staying valid *per-sid* through unrelated
   program mutation elsewhere; a global counter deletes exactly the locality
   the `Map<SchemaId,…>` storage shape was built to give, turning "did the
   schema I care about change" into "did anything, anywhere, change."

2. **Per-binding (`BindingId`/name).** Rejected: the write sites that matter
   here are keyed by schema, not by binding — `obj.prop=` where `obj` is one
   of potentially many aliased locals/params/captures pointing at the same
   schema instance. `ctx.js`'s own comments say `dictValueTypes`/
   `mapValueTypes` are deliberately "NOT scope-aware, consumers gate at read
   time" (`ctx.js:564-566`) — precisely because per-binding tracking is
   unsound here: two different binding names can write the same underlying
   schema slot, and a per-binding epoch would let a consumer reading through
   binding B miss a write that came in through alias A of the same schema.
   Per-binding IS the right grain for `ParamFacts`/`BindingFacts`'
   binding-local fields (`val`, `nullable`, `range` — see §3) — which is
   exactly why the epoch does not apply there at all, rather than applying
   there with the wrong key.

3. **Per-`(sid, idx)` (slot-level, matching `SlotFacts: Map<sid, Fact[]>`'s
   own array-indexed shape).** Rejected as unnecessary precision: the
   hazard fail-open belt (`applySlotWriteHazards`, `program-facts.js`) already
   poisons at the whole-sid grain whenever a write's target index can't be
   proven (`Object.assign`/spread merges, computed-key writes) — the exact
   case where per-index staleness tracking would matter most is the case the
   census itself already can't attribute to one index. Per-index epochs
   would thread a second dimension through every producer call site for a
   precision the existing hazard model structurally can't exploit; revisit
   only if a future producer proves it can attribute hazarded writes to a
   single index (no evidence of that today).

---

## 2. Soundness statement

**A fact stamped at epoch E for key `sid` may be consumed at read-time
epoch E' iff E' = epochEff(sid) — i.e. no heap-shape-affecting event
touching `sid`, directly or through an unresolved/hazarded write folded
into the shared `⊤` counter, has been recorded between the fact's stamp
and its read.**

Equality, not "E' ≥ E is fine" — this is a memoization-validity check
(same algebra as `program-facts.js`'s existing `hit?.gen === pf.gen`,
§1015/§1678/§230), not a staleness-tolerance check. Two reasons equality is
required, not merely sufficient, tied to concrete jz facts:

- **Monotone/union facts still need it.** `possibleKinds`/`dictValueTypes`/
  `mapValueTypes` only ever grow (join = ∪, `lattice-design.md` §1.1/§1.5),
  so a stale cached set is always a *sound subset* of the truth — safe for
  an inclusion query (`kindsOf(key).has(X)` under-approximating "maybe" is
  conservative), but **unsound for the `kindsCoverage: 'closed'` exclusion
  claim** (re-audit item 9(a), `param-reps.js:91-104`): "closed" asserts
  every call site was enumerated at stamp time; a write since the stamp
  could have added a kind the cached set doesn't carry, silently turning a
  true "closed, safe to exclude" into a lie. Exact-epoch equality is what
  lets a 'closed' claim be re-validated cheaply instead of re-derived.
- **Non-monotone facts need it more obviously.** `slotIntCertain`/
  `slotI32Certain`'s poison-on-disagreement meet (`numeric`,
  `lattice-design.md` §1.4) can flip `true → false` on a later write; a
  stale hit under the old epoch is not a safe under-approximation, it is
  simply wrong.

---

## 3. Producer/consumer inventory

**Epoch-stamped** (heap-shape facts, `SlotFacts`-shaped or its whole-program
dyn/hazard siblings — many textually-unrelated write sites share one key):

| Analysis | Storage | Key | Why epoch-stamped |
|---|---|---|---|
| Schema slot census | `ctx.schema.slotFacts`/`slotIntCertain`/`slotI32Certain`/`slotConstInts`/`slotIntLevels` (`ctx.js:520-546`) | `SchemaId` | Written by every `{}` literal + `obj.prop=` site of that shape, program-wide; the exact `SlotFacts` key space §1 rides. |
| dyn/map value census | `ctx.schema.dictValueTypes`/`mapValueTypes` (`ctx.js:547-585`) | dyn-root name (whole-program, not scope-aware by design) | Same many-writers-one-key shape, different key (name, not sid) — same soundness contract, `epochEff` generalizes trivially to this key space too (a second `Map<name,uint>` + the SAME shared `⊤`). |
| Hazard/escape belt | `ctx.schema.slotWriteHazards`/`externSlotSids` (`program-facts.js`, `collectSlotWriteHazards`) | `⊤` (already whole-program, `hz.all`) | This IS `epochTop`'s existing precedent (§1) — an escape event (`nameEscapes`) means future writes can arrive through code the census never walks, which is exactly what bumping `⊤` from that point forward encodes. |
| `possibleKinds` + `kindsCoverage:'closed'` | `paramReps`/`ValueRep` (`param-reps.js:87-114`) | `(funcName,paramIdx)` for the 'closed' *coverage claim* only — the coverage claim's soundness depends on the schema/escape state at the moment it was proven, not on paramReps' own binding-local writes | 'closed' is a claim about the *call-site census*, which is influenced by escape/hazard events the same way `SlotFacts` is; re-validate at consumption via the SAME `epochEff` mechanism, keyed by whatever schema/escape state the 'closed' proof actually depended on (open composition question, §7). |

**Epoch-free** (identity-keyed `WeakMap`s where a rewrite always produces a
fresh key, or fixpoint-local state with no shared aliasing — an epoch would
be redundant machinery, not wrong, just unnecessary):

| Analysis | Storage | Why epoch-free |
|---|---|---|
| `bodyFacts` (`analyze.js`) | `WeakMap<bodyNode, …>` | `setFuncBody` always assigns a fresh `func.body` reference on rewrite (`session.js:165-207`'s own DEPS entry) — a stale key can never be looked up; the soundness statement (§2) holds trivially because E' can only ever equal E (no other E is reachable through that key). |
| `bindingUses`, `mayBeUndefinedTrace`, `mapGetShapedTrace`, `presentValTrace` | body-identity-keyed `WeakMap`s (`analyze-scans.js`, `kind.js`) | Same identity argument; `session.js:208-250` already documents this explicitly ("no surgical invalidation exists, and this is fine, not a gap"). |
| `LoopPlan` (`astLoopPlan`), `ClosureEnvPlan` (`astClosurePlan`) | AST-node-identity-keyed `WeakMap`s, session-reset via `registerResetHook` (architecture re-audit items 4/7, `.work/closure-plan-design.md`) | Same identity argument. **Composition point, not exemption**: if either plan comes to carry a field *derived from* a schema fact (e.g. "this loop's array elements are schema S, slot K is int-certain" — plausible once `RepresentationPlan` composes loop/schema evidence), the epoch check belongs on the *schema fact being read at plan-construction time*, not on the plan record itself — the plan is a **consumer** of an epoch-stamped fact, not itself epoch-stamped storage. Stated as an assumption for whichever agent lands that composition, since `narrow.js`'s restructuring is in flight and not read past its current public shape here. |
| `paramReps` scalar fields (`val`, `wasm`, `intConst`, `nullable`, `range`, …) | `Map<funcName, Map<paramIdx, …>>` (`param-reps.js:2`) | Binding-scoped, cross-call but settled by the fixpoint's own `latticeMeet.changed` convergence signal — the fixpoint visits every write site itself, so there is no "reader outside the fixpoint" hazard to guard against. Becomes an epoch **consumer**, not stamped storage, exactly where a merge step reads a schema-keyed fact (e.g. a param's kind inferred from `obj.prop` — `infer.js`'s evidence producers) — flagged as the same open composition question as `kindsCoverage` above, §7. |

---

## 4. Composition with the existing DEPS table (`session.js`)

`session.js:141-266`'s hand-written DEPS table stays — this design does not
replace it, it **replaces one entry's mechanism** (`programFacts`'s shared
`pf.gen`, `program-facts.js:168-185`) with the finer per-sid/per-name
`epoch`/`epochTop` pair, and **documents** (rather than mechanizes) the
`SlotFacts`-vs-everything-else split §3 draws. `pf.gen`'s own two triggers —
(a) fresh session, (b) `invalidateProgramFactsCache(root)` for an in-place
rewrite — map onto the new model as: (a) `epoch`/`epochTop` reset to empty/0
in `beginSession` (a `SESSION_RESET_HOOKS` entry, same idiom as
`astLoopPlan`/`astClosurePlan`'s `registerResetHook`, architecture re-audit
item 3's `ctx.plans` precedent); (b) becomes a `bump(sid)` (or `bump(⊤)` if
the rewrite's target sid can't be resolved from the call site) rather than a
`WeakMap.delete(root)` — same intent (drop stale cache), finer effect (only
the affected key's dependents recompute, not the whole `walkCache`/
`moduleInitSlot`/`bodyIntCertain` trio).

---

## 5. Migration slices

Mirrors `lattice-design.md` §5's own convention: independently gated, each
slice's gate is the project's standard triad (bench-corpus byte-identity ×10
O2 + full battery + `kernel-parity`), shadow-assert before any behavioral
switch, single-commit revert boundary per slice.

**Slice 0 — plumbing, zero behavior change, DORMANT.** Add
`epoch: Map<SchemaId,uint>` + `epochTop: uint` + `bump(sid?)`/`epochEff(sid)`
as a session-owned object (`SESSION_RESET_HOOKS` entry, `session.js:40-41`'s
existing idiom), reset fresh every `beginSession`. Zero call sites read or
write it. Gate: full battery byte-for-byte unchanged (pure addition, same
"zero consumers" shape as re-audit item 9's own landing).

**Slice 1 — wire producers only, still DORMANT.** Every resolved
heap-shape write site `observeProgramSlots` already visits (object-literal
construction, `obj.prop=`, array resize, `nameEscapes`) additionally calls
`bump(sid)`; every hazarded/unresolvable site (`Object.assign`/spread merge,
computed-key write, escape into `valueUsed`) calls `bump(⊤)` — additive,
alongside the existing hazard-poison/census logic, not replacing it yet.
Gate: byte-identity (a bump with no reader is inert by construction) + full
battery.

**Slice 2 — first real consumer: retrofit `pf.gen`'s own 3 call sites**
(`program-facts.js:230,1015,1678` — `walkCache`/`moduleInitSlot`/
`bodyIntCertain` hit checks). Shadow-assert first, per the project's own
"prove equality, then move the source of truth" method (`lattice-design.md`
§5 Slice 3, `research.md:862-871`): compute both the old `hit.gen===pf.gen`
check and the new `hit.epoch===epochEff(sid)` check for one full battery run
under `JZ_DEBUG_INVARIANTS`, assert the new check is **at least as
conservative** — i.e. old-check-valid ⟹ epoch-would-also-consider-valid is
NOT required (the new model is intentionally finer, so it may accept a hit
`pf.gen` would have wholesale-dropped); only the reverse direction
(epoch-valid ⟹ actually sound) is asserted, via differential/fuzz replay
against a clean rebuild. Gate: shadow-assert clean + standard triad. Cannot
change output bytes (still a caching mechanism only) but can change cache
hit rates — flag for a compile-time budget check alongside the correctness
gates, same caveat `lattice-design.md` §6 item 3 raises for its own Slice 4a.

**Slice 3 — switch program-facts.js's 3 caches fully onto the new model**,
retire `pf.gen` (or keep it as a derived `epochEff(⊤)` alias for any
external reader — an implementation-time call, not pinned here). Gate:
standard triad; this is the first slice that can change cache-hit-driven
compile time, not correctness.

**Slice 4 — extend to `dictValueTypes`/`mapValueTypes`** (name-keyed sibling
census, §3 row 2): same `Map<name,uint>` + shared `⊤`, same shadow-assert-
first discipline. Independently revertible from Slice 2/3 (different key
space, same mechanism).

**Slice 5 — `kindsCoverage:'closed'` re-validation** (re-audit item 9(a)'s
own stated blocker: "zero consumers — this is what finally makes
`possibleKinds` safe to consume for exclusion"). Stamp each 'closed' claim
with the `epochEff` of every schema/escape state it read at proof time;
re-check at each consumption site. **Depends on Slice 1** (bump sites must
exist) and resolves the open composition question in §7 as its
precondition, not as part of this slice — if that composition isn't settled
by the time Slice 5 is scheduled, Slice 5 waits, it does not improvise a
narrower answer.

Every slice above is a **caching/soundness infrastructure change: output
bytes stay byte-identical through Slices 0-4** (the mechanism only changes
which cache entries survive, never what a cache miss recomputes to).
Slice 5 is the first slice that changes what's *safe to consume* (unblocks
exclusion reasoning that was previously always "cannot exclude") — matching
how re-audit items 9 and 7 landed the field with zero consumers first, and a
separate, later, audited item made it the source of a real decision.

---

## 6. What it must not be

- **No wall-clock, no `Date.now`.** The epoch is a plain integer counter
  (`epoch.get(sid)+1`, same shape as `pf.gen++`, `program-facts.js:170`) —
  never derived from host time. The self-compiled kernel compiles itself
  without a live WASI clock during bootstrap (`module/timer.js`'s
  `wasi_snapshot_preview1` syscalls are unavailable at that point); an
  epoch that depended on wall time could not exist inside the kernel's own
  self-compilation at all, and would diverge kernel-vs-native even where it
  could.
- **No global "flush everything" reintroducing `clearStickyNull`-style
  resets.** `bump(⊤)` is reserved for **genuinely unresolvable** write
  targets (hazarded merges, computed keys with unproven receiver) — never a
  lazy default for a producer that "isn't sure" which schema changed. If a
  producer can't cheaply determine the affected key, the fix is to make the
  key resolution smarter or the producer's own hazard classification finer
  — not to fall back to `⊤` as a convenience, which would silently degrade
  the whole model back to alternative 1 (§1) one call site at a time. This
  is the same principle as "optimize the tool, never the input," applied to
  the compiler's own internals: a coarse `bump(⊤)` call site is a bug in the
  epoch wiring to fix, not a shortcut to keep.
- **Not a second source of truth for VALUES.** The epoch answers "is this
  fact's content still current," never "what is the fact." It composes with
  the Fact record's own BOTTOM/value/TOP (or BOTTOM/∅/union) algebra — it
  does not replace or duplicate it. A fact's *value* still comes from
  `mergeParamFact`/`joinKinds`/the slot census; the epoch only gates whether
  a *cached* value is safe to reuse without recomputing.
- **`bump` must be O(1) and push-free.** A bump is a `Map` write, never a
  synchronous re-walk or cascade — consumers pull-check lazily at read time
  (`hit.epoch === epochEff(sid)`, same shape as today's `hit?.gen===pf.gen`
  read), producers never trigger recomputation themselves.

---

## 7. Open composition question (explicit deferral)

`narrow.js`'s in-flight `RepresentationPlan`/whole-graph `FeaturePlan`
restructuring is assumed, not read past its current public shape, per this
task's constraint. Two places in §3/§5 above name a real but unresolved
interaction: whenever that work makes a binding-scoped fact
(`paramReps.val`, a `LoopPlan`/`ClosureEnvPlan` field) **derive from** a
schema-keyed fact (an `obj.prop` read feeding a param's inferred kind; a
loop's element type feeding from a schema's slot int-certainty), the
consuming fixpoint needs to snapshot the schema `epochEff` it read at each
merge step, and a schema-epoch bump discovered mid-fixpoint should force
another round — i.e. `latticeMeet.changed` gains a second source ("a fact I
already merged now reads a different epoch") alongside its existing "a
merge actually changed a value" source. This design states the **contract**
(§2's soundness statement applies unchanged to that composition) without
prescribing the mechanism, since prescribing it would mean guessing at
`RepresentationPlan`'s eventual shape. Flag for whichever session lands
Slice 5 or the `RepresentationPlan` composition, whichever comes first.
