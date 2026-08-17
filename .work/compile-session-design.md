# CompileSession — design (architecture item 11 / audit-B finding 5)

Design only — no `src/` changes. Grounded in `.work/session-survey.md` (S5(d)
and its landed slices a/b/c), `.work/ctxfunc-survey.md` (the six-lifetime
`ctx.func` decomposition — **note**: the task brief names this file
`compile-session-func-survey.md`; no such file exists in `.work/` — `ctxfunc-
survey.md` is the survey with that exact content, cross-confirmed against
every citation of it in `.work/research.md` §Region-arena's decision-point
entry, which names it by this same path), the `ea423728` audit-B remediation
ledger entry and its 2026-08-16/17 completion (opaque FunctionPlan storage;
typedElem/typedLen moved onto ActiveFunction; closure bodies and synthetic
`__start` plan-first; FlowState completed; `isInactiveFunction` widened),
the `b3cb4f8b` ledger entry (seven-instance
root-completeness defect class, CompileSession recommended as the fix), and a
direct read of `src/ctx.js`, `src/session.js`, `src/compile/active-function.js`,
`src/compile/function-plan.js`, and all five current region-root bundles
(`src/front.js:101-104`, `src/compile/plan/index.js:126-132`,
`src/compile/index.js`'s scan-round/AFE-loop/Slice-3 exits).

## 0. Scope and grounding — what changed since the func-decomposition survey

`.work/ctxfunc-survey.md` (2026-08-12) estimated the full record at "~30-40×
linkDemand's extraction cost" and gated it on `ctx.func`'s own decomposition,
ruling explicitly: "do not implement a full CompileSession record by embedding
or renaming today's `ctx.func`; that preserves the ambiguity this gate exists
to remove." **That gate is now substantially closed.** Slices 1-4f (all
landed 2026-08-12, `ctxfunc-survey.md`'s own AS-LANDED log) plus `ea423728`
(2026-08-13, P1-P3 remediation) delivered exactly the six-lifetime split the
gate demanded:

| lifetime (ctxfunc-survey §0/§2) | landed as | file |
|---|---|---|
| ProgramFunctions (registry) | `ctx.funcs` — Slice 3 | `src/ctx.js` |
| ActiveFunction (frame identity + control flow) | `ctx.func`, one record, swap-by-identity; owns typedElem/typedLen | `src/compile/active-function.js` (Slice 4b + 2026-08-16 completion) |
| FunctionAnalysis/FunctionPlan (immutable facts) | opaque handles; persistent funcs use `functionData`, closure/`__start` use sealed one-shot frames in `functionWorking` | `src/compile/function-plan.js` (Slice 4c + 2026-08-16/17 completion) |
| EmitFrame (id/local minting) | `freshEmitId`/`declareLocal` on the ActiveFunction record | `src/compile/active-function.js` (Slice 4f) |
| FlowState (scoped push/pop) | throw-safe single/multi-field transactions and control-stack scopes over ActiveFunction | Slice 4d + 2026-08-17 completion |
| BodyMemo (identity-keyed caches) | `getFactStore()`'s WeakMaps | Slice 1 (AdHocMemo retirement) |

The consequence for THIS design: **the expensive part ctxfunc-survey feared —
touching 443 `ctx.func` write-sites across 25 files — is not what remains.**
Every one of those sites already reads/writes `ctx.func.X` through the
now-disciplined record; folding `ctx.func` into a `CompileSession` object
changes **where the record's identity slot lives**, not the shape or call
syntax of any of those 443 sites. The `30-40×` estimate priced "decompose
`ctx.func`," which is done. What's priced below is the residual: fold the
one remaining module-scope singleton (`getFactStore()`'s `_factStore`) onto
the session, replace `ctx`'s mutate-in-place singleton with a constructed
value, and collapse the five region-root bundles. This is a materially
smaller bill than the survey's own estimate anticipated — stated here
explicitly rather than silently inherited, per this campaign's own standing
practice of flagging when a prior estimate is stale.

## 1. THE RECORD

### 1.1 What `ctx` already is

`src/ctx.js`'s own header (lines 29-56) already documents `ctx` as exactly a
CompileSession: named subtrees, one lifecycle phase each, writer/reader
tables. `src/session.js`'s own docstring (line 2) already calls
`beginSession()` "the ONE owner of per-compile lifecycle state" and names
"the fuller CompileSession object... grows here" as the acknowledged seam.
**This design does not invent a new object next to `ctx` — it formalizes
`ctx` as `CompileSession` and finishes what `beginSession()` was always
scoped to become**, closing the two structural gaps that keep it from being
one:

1. `export const ctx = {...}` is mutated field-by-field in place by
   `reset()`, never object-identity-replaced — the reentrancy blocker
   (§2.3) and part of why 9 call sites hand-enumerate a "reachable from
   ctx" set instead of passing the value itself.
2. `getFactStore()`'s `_factStore` (`ctx.js:381`, `let _factStore =
   createFactStore()`) is a **second** module-scope singleton, sibling to
   `ctx` in lifecycle (reset by `resetFactStore()`, called from
   `beginSession()`) but not a field of it — the one piece of "compile-
   lifetime state" the survey's own item 1 asks about that is NOT already
   inside `ctx`.

### 1.2 Member inventory (by origin)

**20 of 20 `ctx.*` top-level subtrees move in 1:1** — no internal
restructuring beyond what slices (a)/(b)/(c)/1-4f already did. Enumerated
directly from `ctx.js`'s object literal (lines 74-105) plus the three fields
`reset()` adds afterward (`plans`, `inspect`, `warnings`):

`core, module, scope, funcs, names, func, types, schema, closure, runtime,
memory, error, transform, abi, bridge, features, linkDemand, plans, inspect,
warnings` — **20 fields, 20 → 20, zero drop, zero merge.**

**+1 module-scope singleton folds in**: `getFactStore()`'s `_factStore`
object (`ctx.js:353-380`) becomes `session.facts` — 13 top-level WeakMap/Map
fields (one of which, `programFacts`, is itself a 5-field sub-record:
`gen, walkCache, moduleInitSlot, bodyIntCertain, hazard`). 51 call sites
across 12 files currently call `getFactStore()` (grep-confirmed) — every one
keeps working unchanged if `getFactStore()` becomes `() => session.facts`
(an alias, not a call-site rewrite — see Slice C).

**Already subsumed, not separately counted**: naming/uniq state
(`ctx.names.prepare`, `ctx.func.uniq` — both already fields of the 20 above,
per Slice 4e/4f), diagnostics (`ctx.error`, `ctx.warnings`, `ctx.inspect` —
already in the 20), options (`ctx.transform` — already in the 20, still
internally a "SESSION opts + derived cfg + services + per-node counters"
mix per `ctx.js`'s own comment at line 87-94 and session-survey §5's
"`ctx.transform` is itself two subtrees wearing one name" finding — NOT
re-split here; out of this design's scope, flagged as a possible future
slice, not a blocker for anything below since every internal split of
`ctx.transform` stays a session field regardless of shape).

**Total new/moved top-level session members: 21** (20 existing `ctx.*`
subtrees, formalized as session fields with unchanged shape; +1 new field,
`facts`, absorbing the one remaining module-scope singleton).

### 1.3 What stays OUT, and why

| excluded | reason |
|---|---|
| Per-function ActiveFunction/FunctionPlan **contents** (the ~30 fields inside `ctx.func`, the ~12 inside a `FunctionPlan`) | Not separately enumerated — they travel as ONE opaque value under `session.func` / one `WeakMap` entry under `session.plans.functions`, exactly as today (Slice 4b's "one authority, swap by identity" already delivered this; a views/decomposition refactor over func's OWN internals is a different, already-declined-as-out-of-scope campaign — session-survey §5(d) itself named "func may need to be decomposed" as the gate, now closed at the RECORD level, not at the "further split its 30 fields into their own session members" level, which nothing requires) |
| `prepare/index.js`'s 14 lets, `module/regex.js`'s 4 lets, `optimize/vectorize.js`'s 4 arm/disarm flags | Session-survey's own binding ruling (slice a, `.work/session-survey.md` §"COORDINATOR RULING"): "module-scope perf-motivated lets may stay module-scope — the requirement is single-choreography reset, not relocation." Already `RESET_HOOKS`-registered. Re-opening this ruling is out of scope; flagged as the residual reentrancy gap (§2.3) |
| `index.js`'s `compileTarget` | Deliberately outside any per-compile record — a process-wide test-injection switch, already isolated via the narrower `SESSION_RESET_HOOKS` (landed, session-survey slice a) |
| `ir.js`'s `DOLLAR` Map, `wat/assemble.js`'s `stdlibParseCache` | Content-addressed, append-only, deliberately **cross-session**-persistent caches (same key ⇒ same value forever) — a session boundary is the wrong lifecycle; memory-hygiene clears (`clearDollar`/`clearStdlibParseCache`) already run from `beginSession()` without owning the storage |
| `HOST_PROFILE`, `OPTF`/`optFlagsOf` (registry-derived from `passes.js`), `CARRIER_BOX`, `DBG_INVARIANTS` | Load-time-immutable process/engine constants, not per-compile state — never were candidates |
| `PHASE_ORDER`, `FEATURE_STRATA` | Static schema describing the session's OWN invariants (what `assertCtxInvariants` checks against) — they validate the record, they are not state the record holds |
| `_featureSnapshot`/`_postAnalyze`/`_preAssemble` (FeaturePlan/linkDemand freeze tripwires) | Module-scope **by necessity** (`ctx.js`'s own comment, lines 398-410): must survive raw `reset()`-only test harnesses that never construct/call into a session object at all. Whether these move onto the session record is a small, low-risk open question for whichever slice touches `setFeature`/`setLinkDemand` — not resolved here, not a blocker |

## 2. THE PAYOFF

### 2.1 Region root collapse

Five bundles today, all hand-maintained arrays of `ctx.*` field references,
covering 9 `regionHooks.exit()` call sites (`plan/index.js`'s `round()`
closure at lines 126-132 is shared by all five plan-tail rounds, so 5 array
*definitions* cover 9 *call sites*):

| site | file:line | root array | size |
|---|---|---|---|
| front boundary | `src/front.js:102-103` | `[ast, ctx.funcs, ctx.module, ctx.schema, ctx.closure]` | 5 |
| compile() scan-round | `src/compile/index.js:2589` | `[ast, programFacts, ctx.funcs, ctx.scope, ctx.types, ctx.schema, ctx.closure, ctx.warnings, getFactStore()]` | 9 |
| compile() AFE round-batch | `src/compile/index.js:2678` | `[ast, programFacts, ctx.funcs, ctx.scope, ctx.types, ctx.schema, ctx.closure, ctx.warnings, ctx.plans, ctx.inspect, getFactStore()]` | 11 |
| compile() Slice-3 exit | `src/compile/index.js:3116-3117` | `[builtModule, ctx.func, ctx.funcs, ctx.transform, ctx.scope]` | 5 |
| plan() round() (×5 rounds) | `src/compile/plan/index.js:130-131` | `[ast, programFacts, ctx.funcs, ctx.scope, ctx.types, ctx.schema, ctx.closure, ctx.warnings]` + `getFactStore()` | 9 |

Under `CompileSession`, every one collapses to exactly two elements — the
phase-local value that is NOT session state (`ast`/`builtModule`, per the
task's own framing: "ast/module where they're phase-local") plus the session
itself:

```
[ast, session]                      // front.js
[ast, programFacts, session]        // compile()'s two mid-compile rounds
[builtModule, session]              // compile()'s Slice-3 exit
[ast, programFacts, session]        // plan()'s round()
```

(`programFacts` stays a sibling, not a session field, per `plan/index.js`'s
own doc: it's the function's *return value*, phase-local to the plan→emit
handoff, not compile-lifetime storage — matches the task's "ast/module where
they're phase-local" carve-out exactly.)

### 2.2 The class-kill argument

`b3cb4f8b`'s ledger entry (`.work/research.md` §Region arena, "Decision
point") names **seven distinct instances of the same defect class in one
campaign** — a different container missing from a different round's
hand-enumerated array, each requiring a dedicated forensic session to find:
`b33d603e`'s `$__dyn_props` durable-unreached receivers; `c8246307`/
`274b6bd8`'s `getFactStore()` missing from the scan-round; `1248563f`'s
`ctx.plans`/`ctx.inspect` missing from every round but the AFE loop;
`a616ca43`'s `ctx.func`; this session's `ctx.funcs` in front.js AND
compile/index.js's Slice-3. `REGION_HOOKS_ACTIVE=false` in every shipped
build means **no committed test exercises any of these arrays' correctness**
— a gap sat silent for three sessions (front.js's: 2026-08-12 → 2026-08-14)
before anyone happened to check that specific array against `ctx`'s current
shape.

The defect is structural: nine call sites each independently re-derive "the
set of durable containers reachable from `ctx`," a set that grows every time
a new subtree lands (`ctx.plans`/`ctx.inspect` didn't exist as concepts
until `1248563f`'s session added them). `CompileSession` kills the class, not
an instance: once every hand-enumerated array is `[..., session]`, there is
**no separate enumeration left to under-populate** — a future durable
container (the next `ctx.plans`-shaped addition, or the `RepresentationPlan`
named in `.work/bigint-retirement-design.md` §6/`.work/heap-epoch-design.md`
§7 as not-yet-existing) is reachable from every root the instant it becomes
a session field, because "session" was always the complete root by
construction, never a hand-picked subset of it.

### 2.3 Reentrancy payoff — bounded, stated precisely

Session-survey §3 named four reentrancy blockers. `CompileSession` as scoped
here (Slices A-D below) closes three, leaves one open by explicit prior
ruling:

| blocker (session-survey §3) | closed by this design? |
|---|---|
| 1. `ctx` is a module singleton mutated in place | **Yes** — Slice B replaces `reset()`'s field-by-field mutation with `beginSession()` constructing a fresh session value; two sequential compiles in one process can no longer observe a partially-reset predecessor, and a caller holding an old session reference keeps a coherent (if stale) snapshot instead of watching it mutate underfoot |
| 2. Module-scope mutable state outside `ctx` (prepare's 14 lets, regex's 4, vectorize's 4) | **No** — explicitly excluded per §1.3's citation of session-survey's own binding ruling. This is the honest residual: TRUE concurrent (call-stack-overlapping) compiles are still unsafe through these, unchanged by anything in this design |
| 3. Fact-store WeakMaps keyed on AST identity | **Yes, more directly** — today `getFactStore()` returns a shared module-level object that a concurrent `resetFactStore()` call could swap out from under an in-flight reader holding a stale reference from an earlier call; once `facts` is a session field, each session owns its own, and two sessions never contend for the same slot |
| 4. `assertCtxInvariants`'s `PHASE_ORDER` state (`ctx.transform.sessionPhase`) | **Yes, for free** — already a field of the 20 (§1.2); once `ctx.transform` is a session field with no shared mutation, two sessions get independently-tracked phase markers |

**What this does NOT deliver**: call-stack-concurrent nested/overlapping
`compile()` invocations. That requires threading `session` as an explicit
parameter through the 61 files that today `import { ctx } from '../ctx.js'`
or receive it as a module default-export DI parameter (session-survey §1) —
a call-site-count-driven campaign on the scale of the FeaturePlan/linkDemand
precedent, priced by the SAME "cost ∝ write-site count" model this whole
campaign uses, and explicitly out of scope here. Stating this precisely
rather than folding it into "reentrancy: fixed" matters because audit-B's
stated goal was concurrent/nested compiles specifically — this design
delivers airtight **sequential** reuse (the actual production shape:
self-host's warm-instance recompiles, a bundler's watch-mode rebuilds) and
removes 3 of 4 named concurrent blockers, not all 4.

## 3. MIGRATION SLICES

Ordered lowest-risk first, same gate discipline as every landed slice in
this campaign (bench-corpus byte-identity, full battery, kernel-parity/
kernel-oracle ×N, `npm run build` ×2 SHA-match, `test/session-reentrancy.js`,
self-host correctness). Each slice lands green independently; no slice
depends on a later one.

**Slice A — formalize `CompileSession`, zero call-site change.**
Files: `src/session.js` (add a `CompileSession` type-doc over `ctx`'s
existing shape — no code change, pure documentation-as-code, same idiom
`ctx.js`'s own header table already uses), `src/ctx.js` (rename the header
comment's framing from "Global compilation context" to "CompileSession
record" — comment-only). Consumers migrated: none. Byte-identical by
construction (comment/doc changes only touch nothing executable). Gate:
full battery unchanged (this slice cannot alter behavior). Risk: none —
this slice exists to make the NEXT slice's diff reviewable against a named
target instead of an implicit one.

**Slice B — `facts` absorption + session-as-value (the reentrancy fix).**
Files: `src/ctx.js` (fold `createFactStore()`/`_factStore` into `reset()`'s
own construction as `ctx.facts = createFactStore()`; `getFactStore()`
becomes `() => ctx.facts`, an alias — same return value, same identity
per-session, zero call-site rewrite at any of the 51 `getFactStore()` call
sites), `src/session.js` (`beginSession()`'s `resetFactStore()` call
deleted — folded into `reset()`'s own construction, matching how every
other subtree is already handled there). Second half, the actual identity
change: `export const ctx = {...}` → `export let ctx`, `reset()` restructured
to build a complete new object and assign it (`ctx = { core: ..., facts:
..., ... }`) rather than mutating 20 existing field references in place.
**This is the slice that requires care**: every one of the 64 files that
`import { ctx } from '../ctx.js'` holds a **live binding** to the reassignable
export (ES module `let`-exports are live references, re-read on every access
— confirmed applicable since `export let` + external re-assignment is
standard ESM semantics, not `export const`'s snapshot-at-import-time), so no
call site needs to change; the mechanism is the same as every other landed
slice in this campaign (mechanical, cost ∝ the ONE write site being
converted from field-mutation to whole-object construction, not the 900+
read sites, which are unaffected). Gate: standard triad + `test/session-
reentrancy.js` extended with a NEW case — hold a session reference across a
`beginSession()` call from another simulated "thread" (sequential in one
process, same shape as the existing probe) and assert the held reference's
contents are unchanged (proves old-session isolation, the concrete
reentrancy claim from §2.3 row 1/3). Risk: LOW-MODERATE — the `const`→`let`
conversion is the one place a self-host subset check matters (verify no
self-hosted code path relies on `ctx`'s specific object identity persisting
across a `reset()` it doesn't expect, e.g. a captured closure over the old
`ctx` reference taken before an in-process `reset()` — grep for `const ctx =`
destructuring/aliasing patterns before landing, not assumed clean).

**Slice C — region roots collapse to `[phase-local, session]`.**
Files: `src/front.js`, `src/compile/plan/index.js`, `src/compile/index.js`
(the 5 array literals at the 9 call sites enumerated in §2.1). Consumers
migrated: `regionHooks.exit()`'s own contract — verify (read, not assumed)
that `__region_copy_rec`'s root-walk treats a plain `session`-shaped object
identically to today's flat array-of-references (it already walks nested
dyn-props recursively per `b33d603e`'s "REGION MACHINERY SOUND" fix, so a
2-level-deeper root — array → session-object → its 20 fields — is the same
class of walk the machinery already proved sound for `ctx.scope`'s own
nested Maps/Sets). Gate: **the acceptance test is §4's Slice-D gate below**
— this slice alone is dormant-only (`REGION_HOOKS_ACTIVE=false` ships
regardless), so its own gate is the standard dormant triad (byte-identity,
full battery, kernel-parity/oracle, build ×2) confirming ZERO observable
change on the native/dormant axis, deferring the region-LIVE verdict to
Slice D. Risk: LOW — mechanical array-literal replacement, same shape as
`session-survey.md`'s slice (a)/(b) "storage-location change, no reader
change" cost model.

**Slice D — ns-round re-verification (the acceptance test).**
Not a code slice — a re-run of the banked `ns-round-2026-08-14` branch work
(§4) against a tree that has landed Slices A-C, with `REGION_HOOKS_ACTIVE`
flipped on for the diagnostic run only (never shipped, per every prior
ns-round session's own precedent). **Acceptance statement**: kernel-oracle
region-live reaches **13/13**, matching dormant, on the SAME
`boolconst`/`unreachable` corpus that has failed at **0/13×3** identically
across three prior sessions (`7346f7e7`, `a616ca43`, `b3cb4f8b`) under every
targeted holder-fix those sessions tried. If 13/13 is reached: proceed to
the full jz×jz goal-gate run (unblocked for the first time this campaign).
If NOT reached: the class-kill argument (§2.2) is falsified for whatever
NEW failure signature appears — a different defect entirely, not this
campaign's target, and grounds for a fresh forensic session rather than
another spot-fix. Gate: kernel-oracle ×3 region-live reps (zero-flake bar,
matching every dormant gate's own standard), plus the standard dormant
triad re-confirming no regression on the shipping axis.

**Slice E — `RESET_HOOKS` retirement (reset = new session).**
Files: `src/ctx.js` (`RESET_HOOKS` array + `registerResetHook` — retired in
favor of each subsystem's reset logic running as part of session
construction proper, matching Slice B's own "fold into the constructor"
shape rather than a drained callback list), `src/prepare/index.js`,
`module/regex.js`, `src/optimize/vectorize.js` (their `RESET_HOOKS`
registrations become direct calls inside `reset()`'s construction body, or
— if the coordinator wants to close §2.3's residual gap — their state
itself moves onto the session, reopening the session-survey slice-a ruling
this design deliberately did NOT reopen in §1.3). **Explicitly the slice
that would extend reentrancy coverage to blocker 2** (§2.3's "No" row) — NOT
attempted by Slices A-D, flagged here as the concrete next step if true
concurrent reentrancy becomes a live goal rather than a documented gap.
Gate: same triad + a new reentrancy probe exercising exactly the state
class this slice folds in (mirrors the shape of `test/session-
reentrancy.js`'s existing probes for slices a/1/3/4a-4f). Risk: MODERATE —
reopens a ruling made for stated performance reasons ("78 read sites would
mean a single indirection on every scope query," session-survey §3 item 2);
any change here needs its own perf gate, not just correctness, unlike A-D.

## 4. INTERACTIONS

**`ns-round-2026-08-14` branch (unmerged, 3 sessions: `7346f7e7` designs/
wires the plan-tail rounds, `a616ca43` root-causes+widens, `b3cb4f8b` fixes
two more root-completeness gaps).** All three commits are dormant-gate-clean
and NOT reachable from `main` (confirmed: `git log main..ns-round-2026-08-14`
lists all three; `main`'s own `08b76ea9` carries equivalent — but
differently-committed — content for `b3cb4f8b`'s fixes only, not the earlier
two). The branch's entire body of work is the region-round INFRASTRUCTURE
(the five bundles §2.1 enumerates) that Slice C directly rewrites — Slice C
should be built ON TOP of whichever tree eventually reconciles `main` and
`ns-round-2026-08-14` (a merge/rebase this design does not resolve), since
rewriting the SAME array literals twice — once on `ns-round-2026-08-14`'s
shape, once after a later merge — would be redundant churn. Practically:
land Slices A/B first (they touch `ctx.js`/`session.js` only, disjoint from
the branch's `front.js`/`plan/index.js`/`compile/index.js` diffs), reconcile
the branch, THEN run Slice C against the merged tree, THEN Slice D. Slice
D's acceptance test IS the branch's own unmet goal gate (§3's citation) —
this design does not re-derive it, it names it as the concrete, falsifiable
target.

**Heap-epoch design (`75a9638d`, `.work/heap-epoch-design.md`).** Its own
§4 already composes against `session.js`'s DEPS table without touching
`ctx.js`'s storage shape — its migration slices (§5 there) are schema-fact
epoch-stamping, orthogonal to WHERE `ctx.schema` lives (a session field
either way). Its §7 "open composition question" explicitly names
`RepresentationPlan` as not-yet-existing and flags composition with whoever
lands it — same posture this design takes toward `RepresentationPlan` in
§2.2: a future session field, automatically root-complete once it exists,
no special-casing needed in Slices A-E.

**BigInt retirement Slices 2-5 (`.work/bigint-retirement-design.md` §9;
Slices 0-1 landed, 2-5 not yet).** Slices 2-4 delete boxed-carrier consumer
machinery and fact/diagnostic infrastructure living on `ctx.func`/
`ctx.types` (the deleted fields are among the 65 `ctxfunc-survey.md`
enumerated, now `ActiveFunction`/`FunctionPlan` members). No ordering
dependency either direction: BigInt Slices 2-5 delete FIELDS within records
this design's Slice A-C treat as opaque payloads (§1.3, "not separately
enumerated"); landing them before or after Slices A-C changes nothing about
the session record's shape, only the internal field count of one of its
members. Flagged for awareness, not as a blocking dependency.

**`RepresentationPlan` (referenced, not yet built, per both design docs
above and `.work/todo.md:10177`).** When it lands, it becomes session field
#22 by the same mechanism as every other subtree — the concrete instance of
§2.2's "class-kill, not instance-kill" claim. No design work is needed here
to accommodate it; that is the point.

## 5. REJECTED ALTERNATIVES

**Partial region-only bundling helper** (a `regionRoot()` function that just
bundles today's known containers, without a real session record).
`b3cb4f8b`'s own ledger entry rejects this explicitly and this design
concurs: it "would re-create the SAME enumeration hazard one level of
indirection removed — the helper itself would need updating every time a new
container is added, identical failure mode, just centralized to one function
instead of nine call sites." The `CompileSession` record is valuable
specifically because folding `ctx.func` into ONE swap-by-identity value
(already landed, Slice 4b) makes "loop over every field of one object" a
**sound, complete** root by construction — a `regionRoot()` helper wrapping
today's *hand-picked* list would still be hand-picked, just in fewer places.

**Status-quo whack-a-mole** (keep hunting root-completeness gaps one session
at a time). Directly rejected by the evidence this design is built on:
seven instances across seven sessions (§2.2), the most recent pair
(`b3cb4f8b`) found via dedicated git archaeology specifically because no
committed test exercises `REGION_HOOKS_ACTIVE=true` — nothing about the
NEXT gap would be easier to find than these seven were. `b3cb4f8b`'s own
"Decision point" section states this is "the third dedicated session on
this exact defect without closing it via a holder-fix" and that "continuing
to hunt for a fourth specific site would be exactly the whack-a-mole this
task's own decision point exists to stop" — this design is that stop.

**Proxy-based or getter-based session facade** (a lazy view object that
computes/wraps `ctx`'s subtrees on read). Rejected on the SAME grounds
session-survey §4 already established for phase views and never
re-litigated here: `src/ctx.js` is itself compiled through jz
(`scripts/self.js` → `dist/jz.wasm`), and the self-hosted subset has **zero**
`Proxy` registrations anywhere in the stdlib and **zero** parser support for
`get`/`set` accessor syntax (`AccessorProperty` returns zero hits in
`src/parse.js`/`src/front.js`). A `CompileSession` implemented as anything
but a plain, prototype-less, `derive()`-style flat object could not compile
through the kernel it must itself pass through. Every slice above builds
plain objects only.

**Renaming/embedding `ctx.func` wholesale as "the" session, deferring the
registry/frame split.** This is the specific alternative
`ctxfunc-survey.md`'s coordinator ruling already forbade ("do not implement
a full CompileSession record by embedding or renaming today's `ctx.func`;
that preserves the ambiguity this gate exists to remove") — restated here
because it is the most tempting shortcut now that the gate is closed: since
`ctx.funcs`/`ctx.func` are ALREADY split, a design that quietly re-merged
them under a session wrapper "for convenience" would reopen exactly the
registry/frame naming collision (§0's headline finding in `ctxfunc-survey.md`
§0) the whole prerequisite campaign existed to close. Slice A-E keep them as
two distinct session fields, permanently.

**Threading `session` as an explicit parameter through all 61 `ctx`
importers now, to deliver full concurrent reentrancy in this same
campaign.** Considered and declined for scope, not for unsoundness — it is
the correct NEXT step if concurrent reentrancy becomes a live goal (§2.3,
§3 Slice E's framing), but its cost is the 61-importer call-site rewrite
session-survey §1 already sized, an order of magnitude beyond Slices A-D,
and doing it now would couple two independently-valuable, independently-
gateable changes (root-completeness class-kill vs. true concurrency) into
one high-risk slice. Kept as a named future item, not folded in.
