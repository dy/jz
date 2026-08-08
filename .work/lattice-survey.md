# Product-lattice campaign — design-pass survey (2026-08-08)

Read-only inventory for audit-#15's one-solver-domain design (`.work/todo.md`
"PRODUCT-LATTICE CAMPAIGN — design-pass opening brief"). No proposals below —
producers, consumers, conflicts, and migration risk only. All file:line
citations verified against the working tree at survey time (HEAD `061e2c6e`).

## 0. Scope correction on the brief's own file map (FINDING-0)

The brief says "src/infer.js (paramReps lattice — document its exact
join/meet...)". That file does not exist at that path — the actual file is
**`src/compile/infer.js`**, and as of the current tree it does **not** hold
the lattice: it holds a one-line pointer comment only.

```
src/compile/infer.js:67-71
// === paramReps lattice =====================================================
//
// Primitives live in src/param-reps.js (cycle-free leaf). Lifecycle phases
// below document when each field is valid during narrowSignatures.
```

The paramReps mechanism is actually **split across four files**, each with a
distinct role — this split is itself load-bearing (cycle-avoidance) and any
unification design has to route through all four, not one:

| File | Role |
|---|---|
| `src/param-reps.js` (72 lines) | Storage primitives: the `Map<funcName, Map<paramIdx, ValueRep>>` shape, `mergeParamFact` (the meet), `latticeMeet.changed` (fixpoint signal), `ensureParamRep`, `paramFactsOf`. Cycle-free leaf. |
| `src/reps.js` (309 lines) | The shared `ValueRep` typedef (`REP_FIELDS`, 29 keys) reused by paramReps AND per-binding `localReps`/`globalReps`; `updateRep`/`updateGlobalRep` (plain shallow-merge storage, NOT the join itself); the 4-tier `lookupValType` priority chain; the real "phase chronology" doc (`reps.js:6-25`) the brief was actually looking for. |
| `src/compile/infer.js` (608 lines) | Per-body **evidence producers** only (`SOURCES` registry, `inferParams`, `inferValType`/`inferSchemaId`/`inferArrElemSchema*`/`inferTypedCtor`, `recordGlobalRep`) — feeds `updateRep`/`updateGlobalRep`, never touches `paramReps` directly. |
| `src/compile/narrow.js` (~3437 lines) | The actual cross-call **fixpoint driver**: `mergeRule`/`hardParamVal`/`hardParamRecvArrTyped`, the soft/hard policy split, and every real `paramReps` write. 73 references to `paramReps` — by far the largest consumer/producer of the three target files named in the brief. |

`.work/research.md:450-452`'s own citation ("phase chronology... ~line 84 [of
infer.js]") is stale: that comment does not exist in `infer.js` (confirmed via
`git log -S"phase chronology"`, zero hits at that path). The real "what's
valid when" phase list is `src/reps.js:21-25` ("Mutation sites by phase":
plan.js → analyze.js → compile/index.js → emit.js), paired with the 4-tier
lookup order at `reps.js:6-19`.

---

## 1. Fact-producer inventory

### 1.1 `paramReps` — cross-call parameter lattice

**Storage** (`src/param-reps.js:2`): `Map<funcName: string, Map<paramIdx: number, ValueRep>>`
— keyed by **function name then positional index**, not by param name, not by
a BindingId. `ensureParamRep(paramReps, funcName, k)` (`param-reps.js:66-72`)
get-or-creates the `{}` leaf. `paramFactsOf(paramReps, callerFunc, key)`
(`param-reps.js:31-44`) is the sole index→name projection, used to hand a
caller's own settled facts to callee-evidence producers.

**Fields**: the full `ValueRep` shape — 29 keys in `REP_FIELDS` (`reps.js:253-258`):
`val, ptrKind, ptrAux, schemaId, intConst, intCertain, notString,
arrayElemSchema, arrayElemSchemaSet, schemaIdSet, arrayElemValType,
arrayElemRange, arrayLen, arrayElemElemValType, arrayElemTypedCtor, carrier,
unsigned, jsonShape, range, typedCtor, wasm, nullable, neverGrown,
bigintBoxed, recvArrTyped, dictValueValType, mapValueValType, mayBeUndefined,
presentVal`. (`missArg`, set directly in narrow.js e.g. line 1754, is used but
**not** in `REP_FIELDS` — an ad-hoc field outside the closed-shape contract,
FINDING.) Domains: `VAL.*` string enum (14 members, `reps.js:32-37`), booleans,
numbers, closed integer arrays (`arrayElemRange`/`range`), closed sid arrays
(`arrayElemSchemaSet`/`schemaIdSet`), and a shape tree (`jsonShape`).

**Join/meet** — `mergeParamFact(rep, key, observed)` (`param-reps.js:58-63`):
```js
if (rep[key] === null) return                                  // already TOP — sticky
if (observed == null) { rep[key] = null; latticeMeet.changed = true; return }
if (rep[key] === undefined) { rep[key] = observed; latticeMeet.changed = true }
else if (rep[key] !== observed) { rep[key] = null; latticeMeet.changed = true }
```
A genuine **height-2 lattice meet**: BOTTOM (`undefined`, unobserved) ⊑ value
(consensus so far) ⊑ TOP (`null`, disagreement). Documented explicitly
(`param-reps.js:12-13`): "meet(BOTTOM,x)=x, meet(x,x)=x, meet(x,y≠x)=TOP,
meet(TOP,_)=TOP." **Not** a widen-to-LUB — two disagreeing exact values jump
straight to TOP, no intermediate "wider kind" is ever computed. This is
exactly the mechanism the brief's "monotone join (sets grow, never
exact-flip-to-null)" constraint means to replace.

**Sticky-null TOP semantics**: once `rep[key] === null`, `mergeParamFact`'s
own first line makes every further call a no-op forever — no code path resets
`null` back to `undefined` for that field. `param-reps.js:1-26`'s own doc
frames this as the *fix* for a former bug: `narrow.js`'s `clearStickyNull`
(now fully deleted) used to un-stick a spurious "can't tell yet" poison,
which the file calls "root B" — the fix was architectural (split BOTTOM from
TOP at the *policy* level) not a retry loop. Two policies keep it un-stuck at
the source:
  - **soft** fields (only `val` today, `narrow.js:1744` `mergeRule('val', ..., true)`):
    an unresolved site is skipped (stays BOTTOM) instead of poisoning; a
    signature-mutating consumer that can't trust a partial soft answer
    re-folds HARD via `hardParamVal` (`narrow.js:1627-1640`) which
    independently poisons to `null` on ANY untyped/missing/disagreeing site,
    never touching the shared soft lattice.
  - **hard** fields (everything else — `schemaId`, `intConst`, `wasm`, ...):
    poison immediately on an unresolved site, but the producer feeding them
    (`narrowValResults`) was hoisted *above* the param-lattice pass so a
    call-result argument resolves before a "can't-tell" poison can ever form.

**All 9 trigger sites that write a field to `null`** (exhaustive grep over
`src/compile/narrow.js` + `param-reps.js`):
1. `mergeParamFact` disagreement — `rep[key] !== observed` (`param-reps.js:62`).
2. `mergeParamFact` explicit poison (`observed == null` passed in) (`param-reps.js:60`).
3. `mergeRule(...).missing`, no default arg (`narrow.js:1672`).
4. `mergeRule(...).apply`, hard mode, unresolvable arg (`narrow.js:1677`).
5. `poison(field)` helper (`narrow.js:1566`) as the `missing` handler for
   `wasm` (1746), `intConst` (1761), `arrayLen` (2033), `arrayElemRange` (2067, 2077).
6. `wasm`-specific cross-site type disagreement (`narrow.js:1756`).
7. `intConst` forced null on a rest-param slot (`narrow.js:1763`).
8. `validateTypedLenParams` post-hoc invalidation (host-reachable/no
   body/rest/OOB/missing ctor/default/body-mutation) → `r.typedLen = null`
   (`narrow.js:236-239, 245`).
9. `validateIntConstParams`, identical shape for `intConst` (`narrow.js:259, 261, 267`).

**Producers/consumers**: `paramReps` itself is written almost entirely inside
`narrow.js`'s `narrowSignatures` fixpoint (mergeRule + direct `r.field=`
writes). `recordGlobalRep` (`infer.js:323-401`) does **not** write
`paramReps` — it writes `ctx.scope.globalReps` (a structurally identical but
separately-instantiated mechanism via `updateGlobalRep`, `reps.js:290-295`).
Reference counts of the literal string `paramReps` by file: `narrow.js` 73,
`program-facts.js` 26, `analyze.js` 9, `plan/scope.js` 8, `compile/index.js`
8, `param-reps.js` 7, `plan/index.js` 7, `infer.js` 4, `inplace-store.js` 2,
`prepare/index.js` 1, `kind.js` 1, `plan/advise.js` 1, `analyze-scans.js` 1.

### 1.2 `ValueRep` / `repOf` — the general per-binding record (`src/reps.js`)

This is the fact store the brief's target `Fact` type most directly
generalizes, and it is **not named in the brief's own file list** — a real
gap in the brief's own framing (FINDING-1). It is the shared shape behind
THREE separately-keyed instances:

| Instance | Key space | Scope | Reset |
|---|---|---|---|
| `ctx.func.localReps` (`repOf`/`updateRep`) | bare name (string) | current function body only | per-function (`enterFunc`); frozen after emission begins (`ctx.func.repsFrozen`, throws under `JZ_DEBUG_INVARIANTS` on a post-freeze write, `reps.js:277-278`) |
| `ctx.scope.globalReps` (`repOfGlobal`/`updateGlobalRep`) | bare name (string) | module-level binding, whole program | never reset mid-compile |
| `paramReps` (§1.1) | `(funcName, paramIdx)` | whole program, cross-call | never reset mid-compile |

`updateRep(name, fields)` (`reps.js:270-286`) is **not itself a lattice
join** — it is a plain shallow-merge (`{...prev, ...fields}`, undefined keys
deleted). The actual join/poison algebra is computed by the *producer*
before calling `updateRep`: `makeValTracker`/`makeTypedTracker`
(`analyze.js:123-132, 133-...`) implement an **independently-written,
semantically-identical first-wins-then-clash poison set** for `val`,
`presentVal`, and typed-ctor tracking — the same BOTTOM→value→TOP shape as
`mergeParamFact`, reimplemented from scratch rather than reused (FINDING-2,
see §3).

**4-tier lookup priority** (`reps.js:6-19`, `lookupValType`/`lookupNotString`,
`reps.js:297-309`), first hit wins:
1. `ctx.func.refinements` — flow-sensitive (`typeof`/`instanceof` guard), transient per-branch.
2. `ctx.func.localValTypesOverlay` — call-site/loop-iter overlay, transient.
3. `ctx.func.localReps` — durable per-function fact (`repOf`).
4. `ctx.scope.globalValTypes` — durable module-level fact.

Notable individual fields (full doc in `reps.js:41-252`), each with its own
join discipline documented inline:
  - `mayBeUndefined` (boolean) — **monotonic OR**, never un-sets once true (safe-widening).
  - `presentVal` (VAL.* or null) — **poison-on-disagreement**, mutually
    exclusive with `val` for a decl/reassign local by construction
    (`reps.js:154-158`); NOT mutually exclusive for a param (`val` comes from
    the entirely separate `hardParamVal` call-site fixpoint).
  - `dictValueValType`/`mapValueValType` — **first-wins-then-clash**,
    additive-only, never a substitute for `val`.
  - `recvArrTyped` (boolean) — a genuinely **weaker-than-exact** class fact:
    true iff every site proves ARRAY-OR-TYPED (mixing the two doesn't
    poison) — the ONE field in this file that already answers a
    set-membership question rather than an exact-kind question, i.e. an
    existing precedent for what the target `Fact.possibleKinds` needs to
    become universally.
  - `bigintBoxed` (boolean) — feeds the carrier decision sites, §2.3 below.

### 1.3 `src/kind.js` — census/presence functions

All nine functions read `ctx.func.localReps`/`ctx.scope.globalReps` (§1.2) as
their substrate; none maintain independent storage of their own except two
per-function trace caches.

1. **`dictValueKindOf(name)`** (`kind.js:309-316`) — `(string) → VAL.*|null`.
   Gate: `!ctx.types?.nameEscapes?.has(name)` (never aliased) AND a
   `dictValueValType` fact exists (local, or global if `dynWriteVars` has the
   name). Fail: `null`. **Zero consumers outside kind.js** (grep-confirmed) —
   an "internal helper for censusMaybeUndefinedKind only" by explicit design
   doc (`kind.js:272-293`, citing audit #10's revert of a global-VT-promotion
   attempt as unsound: "opt-out instead of opt-in").
2. **`mapValueKindOf(name)`** (`kind.js:352-359`) — same shape, gated on the
   HARD receiver classification `valTypeOf(recvName) === VAL.MAP` (only
   provable via `new Map()`'s CALLEE_VAL path) plus `!nameEscapes`. **Zero
   external consumers.** Same audit-#10 non-wiring history.
3. **`censusMaybeUndefinedKind(node)`** (`kind.js:468-500`) — the real
   dispatcher, `(node) → VAL.*|null`, four arms: (1) `[]`/`.` dict-shaped →
   `dictValueKindOf`; (2) `.get()` call →`mapValueKindOf`; (3) bare name →
   `repOf(name)`, gated on `r.mayBeUndefined` first, then `r.presentVal ??
   r.val`; (4) call result → `valResultMayBeUndefined`/`valResult` join.
   **37 external call sites** (grep, excluding kind.js itself) across
   `type.js`, `ir.js`, `reps.js`(doc only), `narrow.js`(doc), `analyze.js`,
   `emit.js` (15 sites, the dominant consumer), `module/number.js`,
   `module/core.js`, `module/string.js`, `module/console.js`.
4. **`censusMaybeUndefined(node)`** (`kind.js:727`) — `!!censusMaybeUndefinedKind(node)`,
   the boolean-only entry point.
5. **`censusBigintSentinelKind(node)`** (`kind.js:538-586`) — fail value is
   `0` (falsy sentinel), NOT `null` — a different fail-mode convention from
   every other function here (FINDING, inconsistent null-vs-zero
   fail-closed convention across the file). Five gated positive branches
   (bare/unary-neg/unary-not/joint-binary/single-param-wrapper-callee).
6. **`nameMayBeUndefinedInBody(bodyRoot, name, seen)`** (`kind.js:623-653`) —
   `(Array, string, Set) → boolean`. Monotonic-OR trace over every write to
   `name` in a body; non-array body → `false`. Cached in
   `getFactStore().mayBeUndefinedTrace` (a session-owned Map, deliberately
   NOT a private module WeakMap — the self-hosted kernel compiles
   `WeakMap`→strong `Map`, so a module-global cache would leak for the
   kernel's whole GC-less lifetime).
7. **`nameMapGetShapedInBody`/`exprMapGetShapedIn`** (`kind.js:696-725`) —
   same boolean-trace shape, narrower AST gate (`.get()` calls only, not the
   full dict-or-map shape) — deliberately narrower per a documented
   regression found when the broader shape was tried.
8. **`namePresentValInBody(bodyRoot, name, seen)`** (`kind.js:757-789`) —
   `(Array, string, Set) → VAL.*|null`. Poison-on-disagreement trace (mirrors
   `mergeParamFact`'s exact-equality discipline independently, again). Fail
   is `null` for BOTH "no evidence" and "poisoned" — explicitly documented as
   an accepted asymmetry vs. #6's clean two-state boolean (`kind.js:737-740`).
9. **`shapeOf(expr)`** (`kind.js:1410-1437`) — resolves a JSON-shape tree
   (`{val, props?, elem?, names?}`) via a binding's `rep.jsonShape` field
   plus `.prop`/`[i]` chain-walk. Fail: `null` when the parent isn't a
   resolved OBJECT/HASH (for `.prop`) or ARRAY (for `[i]`). Two join
   predicates for shape UNIFICATION: `shapeUnifies` (`kind.js:1363-1377`,
   structural, order-independent) and the stricter `shapeLayoutUnifies`
   (`kind.js:1379-1387`, also requires `names` array order-equality) — used
   by `parseUnifiedJsonShape` when folding multiple `JSON.parse` sources.
   `shapeOfObjectLiteralAst` (`kind.js:1476-1491`) is a SEPARATE, stricter,
   eager literal-walk builder used only by `recordGlobalRep` (module-globals
   get frozen-at-decl shape; locals get the lazy JSON.parse-only shape that
   stays extensible under `Object.assign`).
10. **`hasAmbiguousBoolMerge(node, vt=valTypeOf)`** (`kind.js:238-270`) —
    boolean, detects a BOOL∪NUMBER-ambiguous `?:`/`&&`/`||`/`??` merge,
    pluggable `vt` resolver (narrow.js's Phase E runs before `localReps`
    exists for the function under analysis, so it supplies its own overlay).

### 1.4 `program-facts.js` — the slot* family + `hz` hazard model

All slot facts are keyed by **`(schemaId sid, slot index)`** — a completely
different key space from §1.1-1.3's name/paramIdx keying (see §3). `sid` is
minted by `ctx.schema.register(names)` for a structurally-static field-name
list; slot index is the position within that list (`ctx.schema.list[sid]`).

| Fact | Storage | Producer | Join rule |
|---|---|---|---|
| `slotTypes` | `Map<sid, VAL.*[]>` (array indexed by slot) | `observeSlot`/`poisonSlot` in `observeProgramSlots` (`program-facts.js:649-666`), fed from `{}`-literal construction (:906-916) and resolvable `.prop=` writes (:917-950) | first-wins-then-clash per slot index: `undefined`→set, same→no-op, different→sticky `null` (mirrors `makeValTracker`'s shape, independently coded — see §3.2) |
| `slotTypedCtors` (`slotCtors`) | `Map<sid, ctorName[]>` | `observeCtor`/`poisonCtor` (:667-672, 741-749) — fed ONLY from `{}`-literal construction, NEVER from `.prop=` writes (explicit fail-closed design, comment :923-924) | same clash discipline; gated by `ctx.types.writtenProps` at read time (any program-wide write to that PROP NAME anywhere poisons the ctor read, regardless of sid) |
| `slotBigintObserved` | `Map<sid, boolean[]>` (plain booleans, no tri-state) | `observeBigintJoin` (:642-648), hooked as the FIRST line of `observeSlot` itself — "one write census, two projections" | **pure OR, never resets** — the ONE census in this family that is FAIL-OPEN on hazard (marks `true`/"assume BigInt-possible" instead of poisoning, since under-boxing a real BigInt is unsound but over-boxing a non-BigInt is a harmless cost, doc :728-733) |
| `slotObjSids` (§20 nested-sid census) | `Map<sid, (childSid\|null\|undefined)[]>` | `observeObjSid`/`poisonObjSid` (:678-691), fed EXCLUSIVELY by the `.prop=`/`=`-write branch (:946-948) — deliberately excludes the decl-site `{}`-literal branch (a receiver's own declared value is a separate, potentially-placeholder shape, ctx.js:423-426) | first-wins-then-clash, same shape as `slotTypes`; **self-poisoning only** — NOT touched by `applySlotWriteHazards`'s general sweep at all, so an unresolvable-receiver write simply leaves the entry `undefined` (never observed) rather than explicitly `null` (poisoned) — consumers must fail-closed on both |
| `slotIntCertain`/`slotI32Certain` | published **projections** of the real working state `slotIntLevels: Map<sid, (0\|1\|2\|undefined)[]>` (0=non-int/poisoned, 1=integral, 2=strict-int32) | `analyzeSchemaSlotIntCertain` (`program-facts.js:1585-1757`) — a genuine **rounds/fixpoint** solver, see below | **meet (min)** over the 3-point lattice per slot, with a whole-program re-derivation loop (up to 64 rounds) whenever a later observation tightens an earlier optimistic level |
| `slotWriteHazards` (`hz`) | single object `{all: bool, sids: Set<sid>, props: Set<propName>, numeric: bool, kindSafeSids: Map<sid, kinds\|null>}` — **the one field in this entire family with NO seed in `ctx.js`'s `reset()` literal** (FINDING) — attached dynamically at read time, memoized via `getFactStore().programFacts.hazard = {gen, late, hz}` | `collectSlotWriteHazards` (`program-facts.js:1222-1401`), one whole-program walk | NOT per-slot — this is the poison SIGNAL, not a fact about a slot; see below |

**`slotIntCertain`/`slotI32Certain`'s fixpoint in detail** — this is
materially richer than a one-pass census and worth its own paragraph.
`observeSlot(sid, idx, level)` (:1602-1615) is a genuine **meet**, not
first-wins: `next = cur === undefined ? level : Math.min(cur, level)`, and
any DROP (`next < (cur ?? 2)`) sets a `flipped` bit. The per-body integer
check (`isInt`, via `intLevelChecker` in `type.js`) is itself a LOCAL
fixpoint that optimistically reads an unobserved cross-slot self-read as
level-2 TOP (`slotLevelOf`'s `?? 2`, :1639) — a deliberate greatest-fixpoint
choice for self-referential immutable-update idioms. Because that local
checker closes over global slot levels that may later tighten,
`sweep(fresh)` (:1696-1727) reruns the WHOLE walk, invalidating the
`bodyIntCertain` memo, every time any slot's level drops, looping `while
(flipped && ++rounds <= 64)` — monotone-DOWN (2→1→0 only), so guaranteed to
terminate; exhausting 64 rounds is treated as an internal compiler bug
(`err(...)`, :1727), never a silent fail-closed. `applySlotWriteHazards` runs
FIRST inside every sweep (comment: "the optimistic slotIntOf resolver must
never count a hazarded slot int mid-fixpoint — it would infect other slots'
certainty") and — unlike `slotTypes`'s hazard pass — passes NO `kindSafeSids`
observe callback, so kind-safe/JSON sids are unconditionally poisoned to
level 0 for the int census specifically (JSON numbers are arbitrary
doubles). Published-projection asymmetry: `slotIntCertain`'s entry stays
`undefined` when never observed (`l === undefined ? undefined : l >= 1`,
:1734) — bottom is preserved — but `slotI32Certain`'s entry is always a
concrete boolean (`l === 2`, :1735), so poisoned and never-observed collapse
to the same `false` with no way for a consumer to tell them apart.

**Cross-fact consistency invariant (P-carrier, `program-facts.js:1747-1756`,
`JZ_DEBUG_INVARIANTS`-only)**: after publishing, for every `(sid,i)` where
`slotI32Certain.get(sid)[i] === true`, asserts
`slotBigintObserved.get(sid)?.[i] !== true`, throwing "P-carrier invariant:
schema ${sid} slot ${i} is BOTH i32Certain and slotBigintObserved" if
violated. This is the only place in the family where two independently
maintained facts (a meet-lattice int-precision fact and an OR-join
bigint-observation fact) are cross-checked for mutual exclusion — an
assert-only tripwire, not an enforced merge; a real hit is treated as a
compiler bug, not resolved by trusting one census over the other. A unified
Fact record with `numeric` and `possibleKinds` as sibling projections of ONE
underlying observation set would make this invariant STRUCTURAL (the two
questions could not diverge by construction) rather than a debug-only
runtime check — a concrete, positive case for why unification helps, not
just a risk to manage.

**The `hz` model in detail** (verified directly against `program-facts.js`
and cross-checked via `.work/carrier-representation-design.md` §17-§22):
`hz.all=true` has exactly **2 setter sites**, both gated on "receiver's kind
COULD be `VAL.OBJECT`" (i.e. `kindOf(obj)` resolves to `null` or
`VAL.OBJECT` — `VAL.OBJECT` is deliberately excluded from `KEYED_EXEMPT_VALS
= {ARRAY,TYPED,HASH,MAP,SET,STRING}`):
1. `keyedWrite`'s non-numeric-key fallback (`program-facts.js:1271-1279`).
2. `Object.assign`'s unresolved-target fallback (`program-facts.js:1332-1350`).

The SAME two producer sites additionally populate three narrower, SCOPED
poison channels (not just the `hz.all` blanket) for the cases they CAN
attribute: `hz.sids.add(sid)` when the receiver DOES resolve to a sid but
the key/source doesn't (whole-sid, not whole-program — also fed by
destructuring-pattern targets and fully-resolved spread-literal merges);
`hz.props.add(prop)` when a `.prop=` write's receiver is unresolvable but
the property NAME is a literal (poisons that name across every schema,
program-wide); `hz.numeric=true` when an unresolved-receiver computed-key
write's KEY is provably numeric (narrower than `hz.all` — only touches
slots whose property name is itself a canonical-integer string at consume
time, `_numericName`, :1127). `hz.kindSafeSids` is not a poison channel at
all — it registers JSON.parse sample kinds, consumed only by `slotTypes`'s
own `opts.observe` callback (§ above), never by the int census.

§21 of the design doc PROVED (concrete counter-example, not speculation)
that `hz.all` is genuinely load-bearing for the slot-KIND question, not just
value-precision — a receiver whose kind can't be ruled out as OBJECT really
can alias any registered schema's slot at runtime
(`buildObjectSchemaSetArm`/`$__dyn_set` dispatches universally over
`$__schema_tbl`, not scoped to any subset). **Every one of 7 `slotHazarded`
callers in `module/schema.js` is "load-bearing" against both setter sites**:
`slotVT` (303-320), `slotBigintProvenBySid` (510-515), `slotTypedCtorBySid`
(333-340), `slotTypedCtorByProp` (347-359), `slotIntCertainAt` (365-389),
`slotI32CertainAt` (395-418), `slotI32CertainBySid` (419-424).

TOP/BOTTOM semantics for `hz`: this is NOT a per-slot lattice — it is a
**global poison predicate consulted at read time** via `slotHazarded(id,
prop, kindSafeOk)` (`module/schema.js:247-254`):
```js
if (ctx.schema.externSlotSids?.has(id)) return true
const hz = ctx.schema.slotWriteHazards
if (!hz) return false
if (hz.kindSafeSids?.has(id) && (!kindSafeOk || hz.kindSafeSids.get(id) == null)) return true
return hz.all || hz.sids.has(id) || hz.props.has(prop) || (hz.numeric && /^(0|[1-9][0-9]*)$/.test(String(prop)))
```
`hz.all` is a single whole-program boolean; when true, EVERY `(sid,prop)`
pair reads as hazarded regardless of whether that pair was ever actually
written unsafely — the coarsest possible TOP. A narrower, scoped sibling
`chainHazarded(id,prop)` (`module/schema.js:275-278`) exists ONLY for
`chainSid`'s own nested-sid resolution and deliberately omits `hz.all` (checked
and confirmed correct to omit, per §20/§21's "closed set" argument — its
receivers are provably bare-string-chain-resolved, a set the `hz.all`-causing
writes can never alias).

`kindSafeSids` is a THIRD gating tier: a sid whose slot KINDS were observed
safely even though some VALUE-level write was unresolvable (JSON parser
writes arbitrary doubles/values within a sample's kind set) — `slotVT`
passes `kindSafeOk=true` (trusts kind reads on such sids); every
value-precision reader (`slotIntCertainAt`, `slotTypedCtorBySid`, etc.)
passes `kindSafeOk=false` (fails closed regardless).

**Cache/gen lifecycle**: `pf.gen` is a monotonic counter on
`getFactStore().programFacts` (`ctx.js:240-249`); `resetProgramFactsCache()`
(`program-facts.js:168-174`) bumps it AND swaps in fresh `WeakMap` instances
for `walkCache`/`moduleInitSlot`/`bodyIntCertain` (not just relying on
GC-unreachability — the self-hosted kernel's arena-based `_clear` between
warm-instance compiles can overwrite a stale WeakMap's own backing bytes, so
a gen-bump alone isn't sufficient there). `collectSlotWriteHazards` caches
its result as `pf.hazard = {gen, late, hz}` (`program-facts.js:1223-1226,
1399`) — the ONLY cache in this file keyed on a SECOND dimension (`late`)
beyond `gen`, because `late = !!opts?.paramReps` distinguishes a genuinely
different analysis (early pre-`narrowSignatures` vs. post-narrowing, which
can resolve receivers the early pass structurally cannot) that must never be
conflated even within the same generation. §22 confirmed empirically that a
param's WASM rep genuinely does not exist at the early pass. The `opts.fresh`
rebuild path (`observeProgramSlots`, :726) is a deliberate, documented
EXCEPTION to the family's otherwise-monotone-widen-only re-run discipline
(re-running later in compilation can only widen poisoning everywhere else,
per comments at :421-423, :1623-1624) — it `clear()`s all six maps first,
justified because late narrowing genuinely resolves receivers the early pass
could not see and "every kind consumer left reads at emit, after this."

**FINDING-9 — three independently-written near-duplicate receiver-resolution
helpers.** `observeProgramSlots`'s `sidOf` (embedded structurally, via
`repOf`/`ctx.schema.vars`, :925), `collectSlotWriteHazards`'s own `sidOf`
(:1229-1236, the only one of the three that delegates non-string `.`-node
receivers to `ctx.schema.chainSid`), and `analyzeSchemaSlotIntCertain`'s
`sidOfName` (:1630-1633, its own fallback chain via `curSids` local-alias
support) all answer "what schema id does this receiver expression resolve
to" with slightly different fallback chains and different chain-resolution
power. A fourth, near-identical resolver is `program-facts.js`'s own
`kindOf` closure (§2.3) and a fifth is `reps.js`'s `lookupValType` (§1.2) —
the same duplication pattern as FINDING-2/FINDING-3, now confirmed present a
third and fourth time at the sid-resolution layer specifically, not just the
kind-resolution layer.

### 1.5 `analyze.js` — `bodyFacts` cache

**Storage**: `getFactStore().bodyFacts`, a plain `Map` (explicitly NOT a
WeakMap — a documented prior GC/arena-timing bug forced this, comment
`analyze.js:87-93`), keyed by **function body AST node identity**. Value
shape (`analyze.js:924`, the `result` object): `locals, valTypes,
arrElemSchemas, arrElemSchemaSets, arrElemValTypes, arrElemTypedCtors,
typedElems, typedLens, escapes, flatObjects, sliceViews, unsignedLocals,
neverGrown, numericFill` (+ `__sig`, a debug-only signature fingerprint under
`JZ_DEBUG_INVARIANTS`). Non-object bodies (arrow-expression bodies) get an
uncached narrower shape (9 fields) returned directly, never stored.

**`analyzeBody(body)`** (`analyze.js:258-...`): cache hit → optional
`assertBodyFactsFresh` staleness check (narrow: only catches a *signature
retype* surviving under a stale hit, not a full recompute-and-compare — a
full `JZ_DEBUG_CACHE` general-staleness attempt was tried and abandoned per
`.work/todo.md`). **30 real call sites** (39 raw grep hits minus 8
comment-only minus 1 definition), matching the brief's "~31" closely, across
`plan/literals.js` (2), `analyze.js` (2, one is `reanalyzeBody`'s own default
arg), `plan/scope.js` (1), `program-facts.js` (4), `compile/index.js` (3, all
via `reanalyzeBody`), `narrow.js` (14 — the dominant caller), `inplace-store.js`
(2), `wat/assemble.js` (1), `plan/inline.js` (1).

**Invalidation**: the raw primitive `invalidateLocalsCache(body)`
(`analyze.js:1126-1128`, plain `bodyFacts.delete(body)`) has **zero direct
external callers** — every site was migrated onto four fused primitives
(`analyze.js:1130-1202`): `reanalyzeBody(body, read?)` (invalidate+read, 7
call sites), `setFuncBody(func, node)` (assign+invalidate, 5 call sites),
`invalidateBodies(bodies)` (bulk-known-set, 2 call sites), and
`invalidateAllBodyFacts()` (flush-all-non-raw, 2 call sites). There is
already a **same-named but structurally different** `invalidateBodyFacts`
— a `narrow.js:958-961` *phase-local method* (`invalidateAllBodyFacts() +
clearDerived()`, no per-body target, no reason string) — which the brief's
target end-state (a single module-level `invalidateBodyFacts(body, reason)`
entry point, per `.work/research.md:704-708`) would have to either absorb or
rename around, since the name is already taken by a different-shaped thing
(FINDING — naming collision waiting to happen).

---

## 2. Consumer inventory — the projection catalog

### 2.1 By question type

| Question | Representative consumers |
|---|---|
| **Exact kind** (`=== VAL.X`) | `censusMaybeUndefinedKind(x) === VAL.BIGINT` (emit.js ×6, ir.js ×2, type.js ×1); `slotVT` callers expecting one VAL member; `valTypeOf`/`lookupValType` (the whole VT dispatch table) |
| **Boolean presence/maybe-undefined** | `censusMaybeUndefined(x)` (13+ boolean-only call sites); `hz.all`-consulting `slotHazarded` |
| **Boolean disjointness (not-a-specific-kind)** | `keyedWrite`'s `KEYED_EXEMPT_VALS` check (program-facts.js:1276, "is kind provably NOT `VAL.OBJECT`"); `recvArrTyped` (reps.js field, ARRAY-OR-TYPED); `hasAmbiguousBoolMerge` (BOOL∪NUMBER ambiguity) |
| **Int-certainty / numeric precision** | `slotIntCertainAt`/`slotI32CertainAt`/`slotI32CertainBySid`; `repOf(key)?.intCertain`; `curParamIntCertain` (§22's lever) |
| **Points-to / schema identity** | `sidOf`/`idOf`; `chainSid` (multi-hop `.`-chain → sid); `slotObjSids` (nested sid) |
| **Representation (raw/boxed/carrier)** | `isProvenBoxedBigint`/`isCurrentlyBoxedBigint`/`isTernaryBoxedBigint`/`needsBigintBox` (ir.js); `slotBigintBoxedBySid`/`slotBigintProvenBySid` (module/schema.js) |

### 2.2 The five walls (§17-§22, `carrier-representation-design.md`)

| § | Site | Question asked | Wall |
|---|---|---|---|
| §17 | `keyedWrite`, `program-facts.js:1271-1279` | boolean disjointness: is `obj`'s kind provably in `KEYED_EXEMPT_VALS`? | `Map.get()`'s return kind is deliberately unpromoted (audit-#10); key int-certainty (`repOf(key)?.intCertain`) reads the wrong function's cursor |
| §18 | `mapValueKindOf`'s receiver gate, `kind.js:352` | exact kind: is `recvName` provably `VAL.MAP`? | HARD-only via `new Map()` CALLEE_VAL — never fires for a property-aliased binding (`const slotTypes = ctx.schema.slotTypes`); empirically zero effect on self.js (byte-identical `JZ_DEBUG_HZALL` counters before/after) |
| §19 | property-kind tracing scope check | presence: does the slot-write census even see `ctx.schema`'s own construction site? | write-side NOT opaque (`{}`-literal walk sees it); read-side categorically opaque — no chain-resolution mechanism existed yet for a `.`-node receiver (2496 chained reads, 0 resolved) |
| §20 | `chainSid`/`chainHazarded`, `module/schema.js:275-301` | presence/points-to: resolve a multi-hop `.`-chain to a sid | chain resolution itself LANDED and works (946/946 sampled); but `slotVT`'s own terminal `slotHazarded` call still gates on `hz.all` — inert until that clears |
| §21 | `slotHazarded`'s `hz.all` term, audited for `slotVT` | can the slot-KIND question drop `hz.all`? | REFUTED — concrete miscompile counter-example (`corrupt(obj,key,val)` computed-key write); `hz.all` is load-bearing for ALL 7 `slotHazarded` callers, not just value-precision ones |
| §22 | `mergeParamFact`, `param-reps.js:58-63` — **the exact "param sticky-null site"** | int-certainty: thread `curParamIntCertain` into `keyedWrite`'s numeric-key check | implemented, sound, kept — but zero effect on self.js: the cross-call `val`/`wasm` meet collapses to sticky-null the instant ONE of hundreds of call sites can't prove an arg integer, which is structurally near-certain for self.js's generic-helper architecture |

### 2.3 Carrier rep decision sites (`src/ir.js`, consumed by `emit.js`)

| Predicate | Storage | Gate | Consumers |
|---|---|---|---|
| `isProvenBoxedBigint(name)` (`ir.js:473-474`) | `repOf(name)?.bigintBoxed` | excludes current function's OWN params (call-site `coerceArg` already boxed them) | `needsBigintBox` (ir.js:497-500), further sinks |
| `needsBigintBox(node)` (`ir.js:497-500`) | delegates to `isProvenBoxedBigint` for bare names; unconditional for any other BIGINT-kinded compound EXCEPT `'?:'` nodes | excludes `?:` explicitly — its own dedicated handler already owns box placement (a documented past box-of-a-box bug) | W-sink emission (return, store, further calls) |
| `isCurrentlyBoxedBigint(name)` (`ir.js:520-521`) | `repOf(name)?.bigintBoxed` | **requires** current function's OWN param (inverse gate of `isProvenBoxedBigint`) | `readI64` (ir.js:571), `coerceArg` (emit.js:1454) |
| `isTernaryBoxedBigint(name)` (`ir.js:557`) | `ctx.func.ternaryBoxedNames` — a per-function **transient Set**, NOT the rep system (emission-tier, reset per function at `compile/index.js:462`) | name must have been the LHS of a decl whose init matched the narrow ternary-nullish-BIGINT-merge shape at `emitDecl`, `emit.js:2166-2168` | `readI64` (ir.js:571), `coerceArg` (emit.js:1454) |

`keyedWrite`'s `kindOf` call (`program-facts.js:1275`, `kindOf =
program-facts.js:1237-1239`) resolves via `curParamVts?.get(obj) ??
repOf(obj)?.val ?? valTypeOf(obj)` — itself a 3-tier fallback chain distinct
from `reps.js`'s own 4-tier `lookupValType`, a **second, independently
maintained priority list answering nearly the same question** (FINDING —
`program-facts.js`'s `kindOf` and `reps.js`'s `lookupValType` are two
different, not-quite-identical orderings of the same underlying sources: the
former checks a hazard-walk-local `curParamVts` first and skips
`localValTypesOverlay`/`refinements` entirely, since it runs at analysis
time before those exist).

`slotVT`'s chain (`module/schema.js:303-320`): `slotVT` → `idOf` →
(if `.`-node receiver) `chainSid` → `chainHazarded` (narrow gate, no
`hz.all`) → `slotObjSids` (nested-sid lookup) → back to `slotVT`'s own
**broad** final `slotHazarded(id, prop, true)` call (line 317, DOES include
`hz.all`) → `slotTypes.get(id)?.[idx]` (the actual kind read). The chain
resolves cleanly through 3 of its 4 gates; the terminal gate is the one §21
proved must stay broad.

---

## 3. Unification map

### 3.1 Producer → target `Fact` component

| Producer | possibleKinds | presence | pointsTo | numeric | rep |
|---|---|---|---|---|---|
| `paramReps.val` (§1.1) | exact-kind-or-null today; target: set | — | `paramReps.schemaId`/`schemaIdSet` | `paramReps.intCertain`/`range` | `paramReps.wasm`/`typedCtor` |
| `repOf(name).val`/`.presentVal` (§1.2) | exact-kind-or-null (mutually exclusive pair) | `repOf(name).mayBeUndefined` | `repOf(name).schemaId` | `repOf(name).intCertain`/`range` | `repOf(name).carrier`/`bigintBoxed` |
| `dictValueKindOf`/`mapValueKindOf`/`censusMaybeUndefinedKind` (§1.3) | exact-kind-or-null (dormant/gated for the raw kind reads; live for the presence question) | THIS **is** the presence half already (per the brief's own framing) | — | — | — |
| `slotTypes`/`slotVT` (§1.4) | exact-kind-or-null per `(sid,slot)` | via `hz` hazard (absence of poison ⇒ present) | `slotObjSids`/`chainSid` **is** the points-to half already | `slotIntCertain`/`slotI32Certain` | `slotBigintBoxedBySid`/`slotBigintProvenBySid` |
| `recvArrTyped` (§1.2) | **already set-valued** ({ARRAY,TYPED}) | — | — | — | — |
| `bodyFacts` (§1.5) | per-name `valTypes` map (exact) | — | `arrElemSchemas` | — | `typedElems`/`unsignedLocals` |

The brief's target shape (`Fact = { possibleKinds (set), presence,
pointsTo (schema-id set), numeric, rep }`) already has a **partial
precedent for every field** somewhere in the current code — `recvArrTyped`
is literally a 2-element possibleKinds set today; `censusMaybeUndefinedKind`
already separates "presence" (arm gate) from "kind when present"
(`presentVal`); `slotObjSids`/`chainSid` already is a points-to-set
resolver (its VALUES are single sids per hop, but the multi-hop `ids?.length`
CLOSED-set pattern in `slotVT`'s refinement branch, `module/schema.js:304-315`,
already iterates a `schemaIds` array and requires EVERY member to agree —
i.e. a genuine closed-set points-to fact consumed today).

### 3.2 Conflicts — two producers answering the same question differently

1. **`program-facts.js`'s `kindOf` vs `reps.js`'s `lookupValType`** (§2.3) —
   both answer "what kind is this name," different priority orders, computed
   independently, can and do diverge (the former is analysis-time-only,
   never sees refinements/overlay).
2. **`mergeParamFact` (param-reps.js) vs `makeValTracker`/`makeTypedTracker`
   (analyze.js:123-...) vs `slotTypes`'s inline array-push-and-poison
   (program-facts.js)** — THREE independently-coded implementations of the
   identical "first-observation-wins, second-disagreeing-observation-poisons-
   permanently" algebra, at three different key granularities (param,
   local-name, slot-index). A unification MUST decide whether these become
   one shared primitive or stay separate (they currently drift independently
   — e.g. `makeValTracker`'s poison Set never interacts with
   `mergeParamFact`'s `latticeMeet.changed` fixpoint signal, so a local-name
   poison and a param poison are invisible to each other's convergence
   check).
3. **`slotVT` vs `dictValueKindOf`/`mapValueKindOf` (kind.js)** — both
   answer "kind of `obj.prop`/`obj[key]`" for a schema-shaped vs
   dict/map-shaped receiver respectively, gated by structurally analogous
   but separately-coded hazard predicates (`slotHazarded` vs
   `!ctx.types?.nameEscapes?.has`) — no shared "is this receiver-read still
   trustworthy" primitive between the OBJECT and the HASH/MAP worlds.
4. **`censusBigintSentinelKind`'s fail value is `0`, everything else's is
   `null`** (§1.3 item 5) — an inconsistency a unified projection API must
   not inherit; a set-valued Fact needs ONE universal "no information" token
   (empty set), not a mix of `null`/`false`/`0` per producer.

### 3.3 The keying question — no shared key space exists today

Four **disjoint** key spaces coexist, and the brief's "BindingId/sid keying"
question does not have an existing answer to converge on:

| Key space | Used by | Scope |
|---|---|---|
| bare **name** (string) | `localReps`, `globalReps`, `dictValueKindOf`/`mapValueKindOf`, `bodyFacts.valTypes`, `hz.props` | current-function-local (for `localReps`) or whole-module (for `globalReps`) — the SAME string key means different things depending on which map it's looked up in |
| **(funcName, paramIdx)** | `paramReps` | whole-program, cross-call |
| **(sid, slot-index)** | `slotTypes`/`slotIntCertain`/`slotI32Certain`/`slotBigintObserved`/`slotObjSids` | whole-program, per-schema |
| **AST node identity** (object identity, not a string) | `bodyFacts` (keyed by body node), `chainHazarded`'s hop resolution | per-compile-run, GC-lifetime-scoped |

"BindingId totality" (landed Stage 1, commit `4a0102d2`, "stage 1a+1b:
BindingId totality + census collapse") did NOT introduce a numeric BindingId
type — it proved that after an enforced uniqueness pass (every
function-local name is prescanned unique, "names are binding-unique," per
`src/compile/plan/scope.js:216-217`'s comment), a **bare name string is
already a sound proxy for a per-function binding identity** — no separate ID
object needed WITHIN one function body. This closes the gap for
`localReps`/`bodyFacts`' name-keying (sound today), but does **nothing** for
the cross-function case (`paramReps`'s funcName+idx pairing) or the
per-schema case (`slotTypes`'s sid+slot pairing) — those remain genuinely
different dimensions, not different encodings of the same underlying
identity. A unified Fact keyed on "BindingId" would need at minimum a
3-part discriminated key (local binding / param position / schema slot) or
three separate Fact tables sharing only field shape — the brief's phrasing
("what key space unifies locals × params × slots × map-values") presupposes
an answer that the current architecture does not contain even in nascent
form; this is the single largest open design question the survey surfaces
(FINDING).

---

## 4. Migration risk table

Ranked by (a) number of exact-equality call sites that would need rewriting
to a set-membership/disjointness test, and (b) whether the consumer is on a
**soundness-critical** path (a wrong set-narrowing answer causes a
miscompile) vs a pure optimization path (a wrong answer only costs
performance).

| Consumer | Sites (grep-verified) | Current pattern | Byte-identity risk |
|---|---|---|---|
| `censusMaybeUndefinedKind(x) === VAL.BIGINT` / `!== VAL.BIGINT` | emit.js: 6 (`298, 4596, 4754, 4792, 6224`, +1 doc), ir.js: 2, type.js: 1 | exact equality AND exact inequality (`!==`, e.g. `emit.js:4754,4792` — "definitely something else, INCLUDING unresolved-null") | **HIGH**. `!== VAL.BIGINT` today is true for both "resolved to a different kind" and "unresolved" (null). Under a set projection, this must become "the set does NOT contain BIGINT" — a genuinely different, STRONGER claim than "the singleton answer isn't BIGINT." A naive `.has()` rewrite of the `!==` sites would SILENTLY WIDEN what counts as provably-non-BIGINT unless every TOP/unresolved state is represented as the full/unconstrained set (not empty) — get this backward and it's a live miscompile (raw i64 bits read as boxed, or vice versa), not a coverage regression. |
| `censusMaybeUndefined(x)` boolean sites | emit.js: 8 (`2758, 3803, 3844, 4023, 4385, 4532, 4533, 5513`), module/core.js: 1, module/string.js: 1, module/console.js: 2, module/number.js: 1 (13 total) | boolean coercion of arm 1-4 | **MEDIUM**. Boolean truthiness of a set-shaped presence flag is mechanical (`presence !== 'always-present'` or similar) IF the presence dimension stays a clean tri-state; risk is in getting the tri-state boundary right, not in the call sites themselves. |
| `dictValueKindOf`/`mapValueKindOf` direct consumers | **0 external** (kind.js-internal only) | n/a | **LOW** — fully contained; both are already internal helpers behind `censusMaybeUndefinedKind`'s single dispatch point, so a lattice swap only has to keep that ONE function's contract stable. |
| `slotVT`/`slotIntCertainAt`/`slotI32CertainAt`/`slotBigintProvenBySid` (module/schema.js's 7 `slotHazarded` callers) | 1 call site each outside module/schema.js (`kind.js:934` for `slotVT`; `analyze.js:1941` for `slotIntCertainAt`; narrow.js/analyze.js/infer.js/module/array.js for the typed-ctor family) — narrow fan-out, but EVERY caller sits directly on the `hz.all` soundness boundary §21 proved load-bearing | exact boolean/exact-kind reads gated by `slotHazarded` | **HIGH regardless of fan-out width** — §21's counter-example shows a wrong answer here is a direct type-confusion miscompile (string bits read as f64/i64), not an imprecision. Any lattice migration touching how `hz.all` composes with a new set-valued kind fact must re-run §21's exact audit methodology (every setter site × every caller) before landing, not just re-derive it by analogy. |
| `paramReps.val` (`repOf(...).val`, `hardParamVal`, direct `paramReps.get()` reads) | `repOf(` 73 sites, `updateRep(` 80 sites (not all touch `.val`, but `.val` is the single most-read field per `reps.js`'s own doc framing) | exact `=== VAL.X` at most `valTypeOf`/`lookupValType` call sites (the whole VT dispatch table in kind.js keys off exact equality) | **HIGH by volume, MEDIUM by mechanism** — the actual join (`mergeParamFact`) already IS a real lattice and translates cleanly to a monotone-set version (BOTTOM=∅, meet=union, no more TOP-collapse). The risk is entirely on the **consumer** side: kind.js's `VT` dispatch table is built on exact `typeof`-style single-kind switches; every arm implicitly assumes "singleton or null," and there is no existing convention in this codebase for "VT returns a set" (would require touching the dispatch mechanism itself, not just the fact producer). |
| `recvArrTyped` | few sites (module/array.js's numeric-key guard) | already set/class-membership shaped | **LOW** — this field is the existing precedent the new lattice should generalize FROM, not a migration risk. |
| `hz.all`-gated slot-kind reads under `JZ_CARRIER_BOX` | kernel-parity `dict` divergence already tracked as a KNOWN, named, pre-existing gap (§17-§22's own gates) | — | **N/A for byte-identity** (already non-byte-identical under the flag; any lattice change here changes an ALREADY-diverging code path, so the gate is "does the known divergence shape stay the same," not "stay byte-identical") |

---

## FINDINGS (surprising, not proposals)

- **FINDING-0** — the brief's own file citation for the paramReps lattice
  (`src/infer.js`, "~line 84") is stale on two counts: the file is
  `src/compile/infer.js`, and the lattice's actual primitives moved to
  `src/param-reps.js` (a `git log -S` search confirms the "phase chronology"
  text the brief/research.md refers to never existed at that path — the real
  phase-chronology doc lives in `src/reps.js:6-25`).
- **FINDING-1** — `src/reps.js` (the `ValueRep`/`repOf`/`updateRep` system,
  29-field `REP_FIELDS`, 4-tier lookup priority) is not named anywhere in the
  brief's own survey-input list, yet it is the actual shared substrate
  BEHIND `paramReps`, `localReps`, AND `globalReps` simultaneously, and
  several of its fields (`recvArrTyped` especially) are already
  set-valued/class-level facts — the closest existing precedent for the
  target `Fact.possibleKinds` shape.
- **FINDING-2** — the "first-observation-wins, second-disagreement-poisons"
  join algebra is implemented **independently at least three times**:
  `mergeParamFact` (param-reps.js, params), `makeValTracker`/`makeTypedTracker`
  (analyze.js, locals), and the inline array-push-and-poison pattern inside
  `observeSlot`/`poisonSlot` (program-facts.js, slots). These never
  interact — a poison in one is invisible to the others' convergence
  signal (`latticeMeet.changed` is only wired to the paramReps instance).
- **FINDING-3** — `program-facts.js`'s `kindOf` closure
  (`curParamVts?.get(obj) ?? repOf(obj)?.val ?? valTypeOf(obj)`) and
  `reps.js`'s `lookupValType` (4-tier: refinements → overlay → localReps →
  globalValTypes) are two independently-maintained priority orderings
  answering nearly the same "what kind is this name" question, with
  different tie-break order and different available tiers depending on
  compile phase — a second live instance of FINDING-2's duplication problem,
  one level up (orchestration, not just the poison algebra).
- **FINDING-4** — `censusBigintSentinelKind`'s fail-closed sentinel is `0`
  (falsy), inconsistent with every other census/kind function in the same
  file which uses `null`. A unified projection API inherits this
  inconsistency verbatim if migrated mechanically.
- **FINDING-5** — the brief's target end-state name,
  `invalidateBodyFacts(body, reason)`, collides with an ALREADY-EXISTING,
  differently-shaped `invalidateBodyFacts()` (a bulk, no-args, no-reason
  phase-local method at `narrow.js:958-961`) — the design will need to
  either rename the target or absorb/replace the existing one explicitly,
  not just "add" the new one.
- **FINDING-6** — there is no existing key space that unifies locals ×
  params × slots. "BindingId totality" (Stage 1, landed) proved bare NAME is
  a sound per-function binding proxy — it did not create a cross-function or
  cross-schema identity. `paramReps` keys on `(funcName, paramIdx)`;
  `slotTypes` et al. key on `(sid, slotIndex)`; both are irreducibly
  different dimensions from "which binding," not alternate encodings of one
  underlying ID. A unified Fact needs either a 3-part discriminated key or
  three cooperating tables — this is the largest genuinely open design
  question the survey found, not a known-and-banked one like §17-§22.
- **FINDING-7** — the `!== VAL.X` consumer pattern (as opposed to `===
  VAL.X`) is a distinct and HIGHER migration risk than the brief's framing
  suggests: today `!== VAL.BIGINT` is satisfied by BOTH "provably a
  different kind" and "unresolved" (null), so several existing
  soundness-relevant sites (`emit.js:4754, 4792`) are silently relying on
  "unresolved ⇒ treat as not-BIGINT" being safe in context. A naive
  migration to `!possibleKinds.has(VAL.BIGINT)` preserves this only if TOP
  (unresolved) is represented as the FULL kind set, not the empty set — the
  opposite convention from how `mergeParamFact`'s `null` (poison) is used
  elsewhere. Getting this inversion wrong at even one migrated site is a
  live miscompile, not a coverage regression.
- **FINDING-8** — `slotVT`'s own gate is internally two-tier: a NARROW
  `chainHazarded` (used only mid-chain, deliberately omits `hz.all`) and a
  BROAD `slotHazarded` (used at the terminal read, includes `hz.all`) coexist
  in the same function. Any unification that tries to collapse "the hazard
  check" into one shared predicate must preserve this asymmetry exactly —
  §21 already proved collapsing it the other way (dropping `hz.all`
  entirely) is unsound.
- **FINDING-9** — receiver→sid resolution is independently reimplemented
  AT LEAST five times: `observeProgramSlots`'s inline `sidOf` (program-facts.js:925),
  `collectSlotWriteHazards`'s own `sidOf` (program-facts.js:1229-1236, the
  only one that chains through `.`-node receivers via `chainSid`),
  `analyzeSchemaSlotIntCertain`'s `sidOfName` (program-facts.js:1630-1633),
  `program-facts.js`'s `kindOf` closure (§2.3), and `reps.js`'s
  `lookupValType` (§1.2) — five near-duplicate priority chains answering
  "what does this receiver resolve to," each with its own subtly different
  fallback order and different available tiers depending on which compile
  phase it runs in. Combined with FINDING-2/3, this makes THREE separate
  layers of the same duplication pattern (join algebra, kind-lookup
  ordering, sid-lookup ordering) — the largest concrete simplification
  opportunity the survey found, independent of the lattice-shape question.
- **FINDING-10** — the P-carrier cross-invariant (`program-facts.js:1747-1756`,
  §1.4) is the one place today where two independently-maintained facts
  (`slotI32Certain`'s meet-lattice precision claim, `slotBigintObserved`'s
  OR-join kind claim) are checked for mutual consistency, and only as a
  `JZ_DEBUG_INVARIANTS`-gated runtime assertion, not a structural guarantee.
  A unified Fact where `numeric` and `possibleKinds` are sibling projections
  of one observation set would make this invariant true BY CONSTRUCTION —
  the clearest concrete example in the codebase today of what unification
  actually buys, beyond deduplication.
