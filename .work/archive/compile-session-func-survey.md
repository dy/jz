# CompileSession prerequisite: `ctx.func` field-ownership survey

**Status:** read-only survey at `14c4f7a2`; no compiler source changed. This is
the prerequisite demanded by `.work/session-survey.md`'s coordinator ruling
before the full `CompileSession` record may proceed. It inventories what the old
survey counted as “410 `ctx.func` write sites” at field/lifetime level and names
the smallest decomposition that makes session ownership meaningful.

## 0. Method and corrected census

Scope matches the earlier session survey: root `index.js`, `src/**/*.js`, and
`module/**/*.js`; tests, scripts, generated output, examples, and benches
excluded. Comments and strings are excluded. I parsed every source file with
jz's own parser, then classified direct field assignment/update and collection
mutation (`set/add/delete/clear/push/pop/shift/unshift/splice/sort/reverse/
copyWithin/fill`) against `ctx.func.<field>`. The parser census is exact for
those direct shapes. It does not pretend a read alias later mutated is a direct
`ctx.func` write; those aliases were reviewed separately.

Current HEAD has:

- **43 real files** reading or writing `ctx.func` (47 textual grep hits; 4 are
  comments only: `src/front.js`, `src/optimize/watr-tail.js`,
  `src/param-reps.js`, `src/session.js`).
- **25 direct writer files**.
- **1,097 direct field occurrences:** 654 reads, **443 writes**, across **65
  live fields**. The old “410 writes” was a regex-era estimate and is now stale:
  most of the delta is the complete count of all 128 `ctx.func.uniq++` updates.
- Direct writes by broad phase: prepare 42; plan 18; analysis/narrow 52;
  function orchestrator 91; emit/utilities 219; assemble 21.
- The two biggest files are `src/compile/emit.js` (115 writes) and
  `src/compile/index.js` (91). The biggest *fields* are `uniq` (129 writes) and
  `locals` (86), together **215/443 = 48.5%** of all direct writes.

This confirms the original gate but changes its interpretation: the obstacle is
not 443 unrelated facts. Most writes are mechanically concentrated in one temp
allocator and one locals table, while several wholly different lifetimes are
hidden behind the same object.

## 1. `ctx.func` is six records wearing one name

| proposed owner | fields | reads / writes | direct writer files | actual lifetime |
|---|---|---:|---:|---|
| **ProgramFunctions** | `list`, `names`, `map`, `exports`, `multiProp`, `globalDevirt` | 222 / 29 | 4 | whole compile; prepare populates, plan may append variants, emit/assemble mostly read |
| **ActiveFunction** | `current`, `body`, `exported`, `valResult`, `mixedAtomReturn`, `boxedResult`, `atModuleScope`, `directClosures` (`name` adds 2 dead diagnostic reads; see §4) | 93 / 22 | 4 | one active user function, closure, or synthetic `__start`; temporarily rebound by narrow and late-closure compilation |
| **FunctionAnalysis** | `localReps`, `repsFrozen`, `boxed`, `cellTypes`, `flatObjects`, `sliceViews`, `leanHashLocals`, `i32HashLocals`, `leanHashDomains`, `localProps`, `p1Predicted` | 158 / 59 | 6 | mutable while analysis settles, then snapshot/frozen plan consumed by emit |
| **EmitFrame** | `locals`, `uniq`, `preboxed`, `closureAux`, `zeroInitSeen`, `charDecomp`, `charDecompGlobals`, `concatBufs`, `probeHoist`, `lenHoist`, `hoistTempDefs` | 83 / 245 | 17 | one emission frame; temps/local declarations/prologues minted while lowering |
| **FlowState** | `refinements`, `localValTypesOverlay`, `localTypedElemsOverlay`, `flowValBlocked`, `stack`, `finallyStack`, `inTry`, `pendingLabel`, `_expect`, `_arrayLiteralNeverEscapes`, `_selfAccumConcat`, `_schemaSpecSlow`, `maybeNullish`, `ternaryBoxedNames` | 84 / 72 | 10 | dynamically scoped branch/block/try/loop/call-context overlays; must restore on exit/throw |
| **BodyMemo** | `_ccBody`, `ccInBounds`, `_aiBody`, `aiInBounds`, `aiLitBounds`, `_ipBody`, `ipProven`, `ipRanges`, `_boolEagerBody`, `_boolEagerValue`, `_constPropAliasBody`, `_constPropAliases`, `_typedBundleBody`, `_typedBundleGuards` | 12 / 16 | 4 | memoized pure derivations keyed by body identity; not active-frame authority |

The first architecture finding is therefore categorical:

> **Do not create a `CompileSession` that merely embeds today’s `ctx.func`.**
> It would preserve the ambiguity and still require saving/restoring arbitrary
> subsets of one global bag. Decompose ownership first; sessionization then
> becomes replacing one record reference, not migrating 443 independent facts.

## 2. Field-level ownership and migration notes

### 2.1 ProgramFunctions — extract first

`list` is the prepared function catalog. `names`/`map` are derived indexes:
`compile()` clears and rebuilds both from `list`, then adds imported signatures.
`exports` is the current module's prepare-time export table; bundled-module
preparation temporarily replaces it and restores the parent. `multiProp` is a
prepare census. `globalDevirt` is a late plan result.

Writers are already concentrated:

- `src/prepare/index.js`: add/rename functions, export tables, `multiProp`.
- `src/compile/index.js`: derive `names`/`map` and register imported sigs.
- `src/compile/variant.js`: atomically append a materialized variant to all
  three catalog/index structures.
- `src/compile/plan/scope.js`: append devirtualized functions and publish
  `globalDevirt`.

This is the safest first extraction because it has only 29 writes and four
writers, no per-node hot mutation, and no reason to be swapped at function
entry. `materializeVariant` already acts as the mutation seam for five variant
producers. Preserve `list` as source authority and explicitly define when the
`names`/`map` indexes are rebuilt or incrementally extended.

**Naming authority finding:** `uniq` does *not* belong here. It currently starts
at session reset, is consumed 25 times during prepare, then is reset to zero by
every `enterFunc` and consumed by plan/emit. One field currently denotes two
independent domains. Split it into a prepare/session name source and an
EmitFrame-local name source; do not carry `ctx.func.uniq` into ProgramFunctions.

### 2.2 ActiveFunction — replace ad-hoc swaps with one reference

`current` and `body` are the semantic identity consulted by type/kind/IR
utilities. Return-carrier flags and `directClosures` belong to the same active
unit. `atModuleScope` identifies synthetic `__start`, not an ordinary function.

Today narrow temporarily assigns `current` in three places. `buildStartFn`
manually initializes parts of a frame, then saves only ten selected
`ctx.func.*` fields before compiling late closures and restores them with
`Object.assign(ctx.func, startCtx)`. This selected-field save is the exact bug
shape a session record should eliminate: any newly added frame field can leak
unless someone remembers to extend `startCtx`.

The replacement should be structurally simple and self-host-safe:

```js
const prev = session.active
session.active = makeActiveFunction(...)
try { ... }
finally { session.active = prev }
```

The active record owns references to its analysis, emit, flow, and memo records.
No Proxy/getters, no dynamic property closures, and no shallow clone of mutable
facts. Nested emission swaps **one active-record reference**, not selected
fields on a singleton.

### 2.3 FunctionAnalysis — the real gate to frozen plans

This group mixes analysis products with their temporary installation into the
active frame. The existing `analyzeFuncForEmit()` already returns most of the
right canonical shape:

`locals`, `boxed`, `cellTypes`, `flatObjects`, `sliceViews`, `cseLoadBases`,
`distinctParams`, lean-hash sets/maps, `typedElem`, `typedLen`, `localReps`.

`emitFunc()` then clones these values back into `ctx.func`/`ctx.types`. That
return-then-reinstall seam is the strongest existing decomposition precedent.
It should become an explicit frozen **FunctionPlan** stored by function
identity—preferably in the session-owned `ctx.plans`/successor PlanStore—rather
than a local `funcFacts` map plus mutable ambient reinstallation.

Important details:

- `localReps` is durable plan data. `updateRep` already enforces
  `repsFrozen`; keep this tripwire at the FunctionPlan boundary.
- Set/Map-valued facts must keep the current deep-copy discipline
  (`cloneRepMap`, `new Set`, `new Map`); a facade or object spread is not a
  freeze.
- `boxed`, `cellTypes`, flat/slice and lean-hash facts belong in the plan.
- `localProps` and `p1Predicted` are analysis scratch that produce plan facts or
  assertions; they should not survive as ambient emit state.
- `p1Predicted` is currently not initialized by `enterFunc`. It is lazily
  allocated by `inheritPtrAliases`, so a prior function's Set can persist and
  make the emit-time invariant less function-local than its documentation
  claims. The plan extraction must make it per-function explicitly; add a
  regression/invariant before moving it.
- `types.typedElem`/`typedLen` have the same lifetime and are already copied
  into/out of `funcFacts`; they belong beside FunctionAnalysis even though
  historical layout puts them under `ctx.types`.

`__start` is the exception proving the model: it currently interleaves analysis
and emission per module-init unit and toggles `repsFrozen` 11 times across
`compile/index.js` + `wat/assemble.js`. Model it as a named synthetic function
plan/frame with explicit unit boundaries; do not special-case it by re-owning
the global function bag.

### 2.4 EmitFrame — centralize mutation, do not freeze it

`uniq` and `locals` account for 215 writes. They are not durable facts and
should not be forced into FunctionPlan. They form a mutable local allocator:

```text
freshLocal(type, tag) -> reserve collision-free name -> register local type
freshLabel(tag)       -> reserve name only
```

`src/ir.js` already has `freshLocal()` behind `temp/tempI32/tempI64`, but many
module and emitter sites still hand-roll `ctx.func.uniq++` and
`ctx.func.locals.set`. The safe migration is to expand this authority, not to
thread two raw fields through every call:

1. split prepare naming from emit naming;
2. introduce frame-owned `freshLocal`, `freshLabel`, and `declareLocal` seams;
3. migrate hand-rolled sites by class, byte-identity gated;
4. only then hide raw `uniq`/`locals` mutation.

The remaining EmitFrame fields are emission products: closure aux indexes,
preboxed locals, prologue caches, and hoisted temps. They may mutate during
emission, but their owner is one active frame and their lifetime ends when that
frame is emitted. They must never be copied back into FunctionPlan.

### 2.5 FlowState — use scoped combinators, not save/restore pairs

These fields are not “facts about a function”; they are current dynamic context.
The code already contains the right pattern in places (`withRefinements`,
`emitBlockBody`'s `try/finally`, try-state restore). Other sites still use
manual assignments and selected restores.

Required authority is a small family of scoped operations (`withRefinements`,
`withValueOverlay`, `withExpectedValue`, `withTryState`, `withLoopFrame`,
`withSchemaSpeculation`). Each must restore in `finally`. A full CompileSession
can then own FlowState through ActiveFunction without exposing its fields to
every emitter.

`localValTypesOverlay` is the most cross-phase field: 26 writes in eight files,
including program-facts, analyze, plan, emit, modules, and assemble. It is
actually a service overlay for `lookupValType`, not a durable function fact.
Move it behind an explicit scoped overlay API before sessionization. The typed
sibling follows the same rule.

### 2.6 BodyMemo — move out of the active frame

All 14 fields are four private memo families with only four owning modules:

- bounds proofs: `src/type.js`;
- eager-boolean scan: `src/compile/emit.js`;
- const-property aliases: `src/compile/flow-types.js`;
- typed-bundle guards: `module/typedarray.js`.

They are keyed by `body` already. Store them in a session-owned BodyMemo record
(`WeakMap<body, result>` per family), analogous to the existing fact store and
`ctx.plans`, rather than caching the “last body” on ActiveFunction. This removes
14 fields and all 16 writes from `ctx.func` without touching emitted semantics.
Because self-host lowers WeakMap to strong Map, the maps must be recreated by
`beginSession/reset`, not module-global.

## 3. Dependency order for the decomposition campaign

### Slice F0 — pin ownership, no relocation

Add an invariant/test catalog for the six groups and focused sequential probes:
function A must not affect B's `p1Predicted`, memo answers, overlays, temp names,
or active identity. This is the survey's only prerequisite to code changes.

### Slice F1 — extract ProgramFunctions

Create a session-owned program-function record and route the four writer files
through it. Keep temporary compatibility access only if deletion is staged;
measure completion by deleting the six fields from `ctx.func`, not by adding a
shadow facade. Split prepare naming from frame naming in this slice or F2.

### Slice F2 — extract BodyMemo

Move the four memo families to session-owned body-keyed stores. Low fanout,
closed ownership, no codegen authority change. Delete all 14 memo fields.

### Slice F3 — establish ActiveFunction + EmitFrame

Make `enterFunc` construct one complete active record. Make `buildStartFn` and
closure emission swap that record reference with `try/finally`; delete the
selected `startCtx` snapshot. Centralize fresh-local/name APIs and migrate raw
`uniq`/`locals` writers incrementally. This is the largest mechanical slice,
but it is no longer an inference change.

### Slice F4 — publish FunctionPlan

Turn `analyzeFuncForEmit`'s return shape into the authoritative frozen plan,
stored by function identity. Emit consumes that plan; no analysis discovery may
occur after freeze. Move per-function `typedElem`/`typedLen` into it. Give
synthetic `__start` an explicit plan/frame lifecycle.

### Slice F5 — encapsulate FlowState

Replace raw overlay/control writes with scoped combinators and narrow views.
Only after F1–F5 should the coordinator begin the full `CompileSession` record:
at that point the session owns ProgramFunctions, PlanStore/FunctionPlans,
BodyMemo, target/options, and one ActiveFunction reference. The hot emitter sees
an ActiveFunction/EmitFrame, not the whole session.

## 4. Findings and deletion traps

1. **The full CompileSession remains blocked today.** The survey prerequisite is
   complete; implementation is now unblocked only in the ordered F0–F5 slices,
   not as a big-bang `ctx` replacement.
2. **`ctx.func.uniq` has two lifetimes.** Prepare consumes it before any function
   frame; `enterFunc` resets it per function. A one-for-one move is wrong.
3. **`buildStartFn`'s selected snapshot is fragile.** It restores ten fields while
   the active bag has 59 non-program fields. Swapping one active record is the
   canonical shape.
4. **`ctx.func.name` is never assigned.** Two debug-only P1 invariant messages in
   `src/compile/emit.js` read it; the intended authority is
   `ctx.func.current?.name`. Delete/fix during F0, not by adding another field.
5. **`p1Predicted` has no frame-entry reset.** Treat as a named state-leak risk
   requiring a pin before FunctionPlan extraction.
6. **`ctx.func` reset declares only 21 fields, but 65 are live.** Forty-four fields
   are shape-by-use. That is not merely documentation drift: absent-key behavior
   is a known self-host hazard elsewhere in this compiler. New records must seed
   every field explicitly.
7. **Program registry readers dominate (`list`/`map`/`names`: 200+ reads), but
   writes are narrow.** Pass an immutable/read view or stable record reference;
   do not allocate a `derive()` facade in per-node paths.
8. **No Proxy/getter design is admissible.** Keep the earlier session survey's
   self-host constraint: plain explicitly shaped records, reference swaps, and
   direct functions only.

## 5. Verification contract for implementation slices

This survey changes documentation only, so no build/test gate is claimed. Every
future F-slice must follow the existing session ruling plus current project
gates:

- byte-identity against a clean worktree when the slice claims storage-only
  relocation;
- `npm test`, `npm run test:matrix`, `npm run test:self`, and full `test:wasm`;
- `test/session-reentrancy.js` plus the new field-specific probes from F0;
- clean `npm run build` ×2 with equal hashes;
- exact official dependencies; no region hooks or region files touched.

**Ruling requested from coordinator:** adopt F0 → F1 → F2 → F3 → F4 → F5 as
the prerequisite decomposition. Do not authorize a full CompileSession object
until the six old ownership classes no longer share `ctx.func`.
