# ClosureEnvPlan design (audit-#18 item 1) — survey + design draft for coordinator mechanism review — 2026-08-10

Design + survey only — **no `src/` changes land from this document**; the two
temporary source edits used to gather the corpus counts below (a `globalThis`-
gated relaxation of `scanAndTagNonEscapingClosures`'s grant condition and a
handful of `globalThis.__CEP_SURVEY`-gated counters) were reverted in-session,
confirmed by a clean `git diff` before this file was written (§0). Grounded in
`.work/todo.md` "AUDIT-#18 DOWNSTREAM GATE LADDER" (line 57) — the session
that measured `_nonEscaping`'s 642→0 grant collapse and closed with "If
ClosureEnvPlan … is picked up, self.js itself is the most productive corpus
to re-derive concrete paying shapes from" (line 139). Written for the
coordinator's mechanism review — it will not land without that review, per
`.work/lattice-design.md`'s own precedent for this phrasing.

**Thesis**: the static-env optimization was never wrong about WHAT to avoid
(heap allocation for a closure env) — it was wrong about HOW to avoid it. A
shared, compile-time-fixed *storage location* (data-segment slot) is
unsound the moment the enclosing activation can re-enter, because storage
is state that outlives a single call. Lambda lifting sidesteps the whole
soundness question by using **no storage at all**: captures travel as
ordinary call-stack arguments, which the platform (WASM call frame) already
gives fresh, race-free semantics for on every call, recursive or not. The
audit-#17/#18 bug class (a re-entrant write clobbering a shared slot before
the first activation reads it back) is not fixed by a cleverer safety
predicate — it is **unrepresentable** once there is no shared slot to
clobber. This is the same move the codebase already made twice this
half-year (product-lattice: existential facts stopped being forced through
a universal-meet algebra; LoopPlan: a mutable AST tag became a frozen,
WeakMap-keyed pre-emission fact) — ClosureEnvPlan is the third instance of
"stop patching the unsound mechanism, replace it with one where the bug
class cannot occur."

---

## 0. Survey method

Two corpora, compiled with the exact options their own gate scripts use (so
the counts match what `bench-size.mjs`/`build-dist.mjs` actually ship):

- **bench corpus**: `scripts/bench-size.mjs`'s own `jzCompileSize` options
  (`optimize: 'size'`, `alloc: false`, per-case `modules`/`imports`) over
  every `bench/<case>/<case>.js` (`bench-size.mjs:55-68`). 58/60 case
  directories compiled cleanly under this harness; `jessie` and `jz` need
  extra module resolution (`node_modules/subscript`, `scripts/self.js`
  itself) `bench-size.mjs` doesn't wire into its own `modules:` map either —
  excluded, not a new gap.
- **self.js**: `scripts/build-dist.mjs`'s own options
  (`resolveModuleGraph(scripts/self.js, {resolveNode:true})`,
  `{modules: g.modules, memory: 8192, optimize: {level:3, watrGuard:false,
  snapshotInit:true}}`, `build-dist.mjs:120,156-160`) — the actual self-host
  compile, minus the `CARRIER_BOX` build-time literal injection (irrelevant
  to closure counting).

Counters were `globalThis.__CEP_SURVEY`-gated (no-op unless the harness sets
the object first) one-liners at the four load-bearing sites: `module/
function.js`'s `ctx.closure.make` (storage-path counts, per-closure capture-
count histogram, boxed-capture presence), and `src/compile/emit.js`'s
`emitDecl` direct-dispatch registration + the `()` call dispatcher's three
outcomes (direct dispatch hit, direct-dispatch arity fallback, generic
`call_indirect`). A second pass added one more counter (`liftEligible`) and
a `globalThis.__CEP_SURVEY_WEAK`-gated relaxation of `scanAndTagNonEscaping
Closures`'s grant (drops the loop/`onlyCallIsSelf` reentrancy restrictions
those exist ONLY to protect the static-slot technique — §2.1 argues these
restrictions are not needed for lambda lifting at all) to measure the TRUE
lift-eligible population in one AST scan, joined against the SAME closure's
boxed-capture fact. Both scripts compiled-and-discarded (never validated via
`new WebAssembly.Module`, never executed) — safe to run with a relaxed,
provisionally-unsound tag since the bytes are never loaded.

## 1. Survey: current closure lowering inventory

Four independent mechanisms touch closure lowering today; they compose (a
closure can be zero-cap AND direct-dispatched, or captured AND heap AND
generically dispatched, etc. — the axes are orthogonal, not a single enum
today, which is itself part of the case for a unifying plan record, §3).

### 1.1 `ctx.closure.make` (`module/function.js:93-245`) — the closure literal

Fires once per closure literal (`(...) => {...}` reaching emit). Always
computes `envCaptures` (closure captures minus any provably-constant-int
capture folded away, `module/function.js:100-105`) and always registers the
body in `ctx.closure.table`/`ctx.closure.bodies` (needed for `call_indirect`
`elem`, regardless of what the call sites end up doing). Three storage
outcomes:

| storage | condition | allocates | call-site shape |
|---|---|---|---|
| **none** (zero-cap) | `envCaptures.length === 0` (`function.js:204`) | nothing — `mkPtrIR(PTR.CLOSURE, tableIdx, 0)`, env slot is the literal `0` | any call reads env=0, body never touches it |
| **static** (`_nonEscaping`) | `body._nonEscaping && (optFlags & OPTF.staticClosureEnv)` (`function.js:220` — line renumbers after this session's revert but the condition is unchanged) | ONE data-segment slot per capture, `appendStaticSlots` (`ir.js`), fixed address for the closure's whole program lifetime | env = the fixed static address |
| **heap** (default) | everything else | `call $__alloc` sized `envCaptures.length * 8`, fresh every activation | env = the fresh alloc's address |

`_nonEscaping` is set by `scanAndTagNonEscapingClosures`
(`src/compile/index.js:383-492`), a mutable-AST-tag scan run from
`enterFunc` (`compile/index.js:540`) — i.e. re-run at EVERY frame entry for
a body (analyze pass, then emission pass, then per closure-body emission —
`enterFunc`'s own doc at `compile/index.js:494-498` names all three
callers), not a frozen pre-emission fact. Grant requires (as of the
audit-#18 completion): not boxed, not global, not reassigned, `onlyCalled
NotReferenced` (never used as a value, only ever `name(...)`),
`calledOnlyOutsideLoops`, AND `onlyCallIsSelf` (the enclosing body's only
call, anywhere, is to the closure itself — `compile/index.js:454-463`, the
audit-#18 addition closing the audit-#17 reentrancy gap). **This predicate
is FINDING-1 dead on the measured corpus: 0/174 bench closures and 0/4404
self.js closures satisfy it** (§1.5) — matches audit-#18's own 642→0
measurement (`.work/todo.md:95`) generalized to a fresh, independent scan.

### 1.2 Direct-dispatch (`ctx.func.directClosures`) — `src/compile/emit.js:2220-2239` (registration), `4255-4301` (`tryDirectClosureCall`), `7108-7111` (call-site gate)

Orthogonal to storage. Registered in `emitDecl` whenever a `let`/`const`
binds a closure literal (or copy-propagates from an already-direct binding,
`emit.js:2236-2238`) and the binding itself is stable: not boxed, not
global, not reassigned (`emit.js:2224-2225`). **Does not require
`onlyCalledNotReferenced`** — a closure that ALSO escapes (stored in an
array, passed as a callback) still gets direct dispatch at any call site
that uses its bound name literally; only the escaping USE goes through the
generic path. At a call site, `tryDirectClosureCall` emits `call
$closureBodyName(env, argc, a0..a{W-1})` (`emit.js:4297-4300`) instead of
`call_indirect` — same uniform closure ABI (`env: f64, argc: i32, a0..a7:
f64`, `MAX_CLOSURE_ARITY=8`, `src/ir.js:791`), same env allocation as §1.1
picked, just a static callee instead of a table lookup. This is a genuine,
measured, ALREADY-LIVE optimization — 114/137 bench closure-call sites
(114 direct + 23 generic) and 3864/7284 self.js closure-call sites (3864
direct + 3420 generic) hit this path (§1.5) — but it still pays the
storage cost every time; it only removes the `call_indirect` indirection,
not the allocation.

### 1.3 Boxed heap-cell path (`ctx.func.boxed`) — `src/compile/analyze-scans.js:71-99`, consumed throughout `module/function.js`/`emit.js`/`ir.js`

A DIFFERENT axis: not "how is the closure's env stored" but "is a
CAPTURED VARIABLE mutated by any closure that captures it" (including
writes from the ENCLOSING scope after the closure exists — this is real JS
by-reference capture semantics, `let x = 1; const f = () => x; x = 2;
f()` must see `2`). `boxedCaptures` (`analyze-scans.js:71-99`) walks the
whole function body once, finds every arrow's free variables
(`findFreeVars`), intersects with `findMutations` over the SAME body, and
allocates each mutated capture its own heap cell (`${T}cell_${name}`,
`i32` local holding a pointer) — SEPARATE from the closure's own env array.
`module/function.js:162-165,212-213,234-235` store the boxed cell's raw
i32 pointer into the env slot (not the value) so every closure sharing the
capture reads/writes the SAME cell. This is the case ClosureEnvPlan's
"mutable-capture exclusion" (§2.4) must preserve untouched — it is a
distinct, already-sound mechanism, not something lambda lifting can touch.
**Extremely common**: 42/56 (75%) of captured bench closures and 1410/2912
(48%) of captured self.js closures have at least one boxed capture
(§1.5) — the single largest disqualifier for lift eligibility.

### 1.4 Closure-table devirt (`src/compile/dyn-closure-tables.js`, `optimize/index.js:5119` `devirtConstFnArrayCalls`)

A DIFFERENT problem again: closures that DO escape (stored in a
module-const array literal, or — `dyn-closure-tables.js`'s extension — an
imperatively-built dispatch table like subscript's operator lookup) but
whose every write traces to the SAME lexical closure literal (one funcIdx,
many different captured envs). Devirtualizes the READ-then-`call_indirect`
into a guarded direct `call` (funcIdx checked at runtime, false arm falls
back to the untouched `call_indirect` — `dyn-closure-tables.js:19-26`).
Still allocates an env per activation; it only removes indirection on the
BODY dispatch, not the storage. **Not a lambda-lift candidate by
definition** — these closures are genuinely first-class values (stored,
aliased, read back later with different captured state per slot) —
`ClosureEnvPlan.escapes = true` for all of them, and the plan's optimal
lowering stays heap (or table-devirt-eligible heap, which already exists
and is untouched by this design).

### 1.5 Corpus counts (self.js: `scripts/self.js` via `build-dist.mjs`'s own compile options; bench: `bench-size.mjs`'s own compile options, 58/60 cases)

| metric | bench (58 cases) | self.js |
|---|---|---|
| total closures created | 174 | 4404 |
| zero-capture (storage=none already) | 118 | 1492 |
| with ≥1 capture | 56 | 2912 |
| … of which ≥1 capture is boxed (mutable) | 42 (75%) | 1410 (48%) |
| `_nonEscaping` tagged (current, audit-#18 predicate) | 0 | 0 |
| static-env storage actually used | 0 | 0 |
| heap-env storage used | 56 (100% of captured) | 2912 (100% of captured) |
| direct-dispatch decl sites (`directClosures` registered) | 17 | 1155 |
| direct-dispatch call sites (skip `call_indirect`) | 114 | 3864 |
| direct-dispatch arity-fallback (fell through to generic) | 0 | 0 |
| generic (`call_indirect`) call sites | 23 | 3420 |
| `_nonEscaping`-tagged under the WEAK (audit-#17-only, no loop/`onlyCallIsSelf`) predicate — includes zero-cap | 16 | 371 |
| … of which with-capture (would take the static branch) | 15 | 268 |
| **lift-eligible** (weak-predicate tagged, WITH captures, AND zero boxed captures) | **1** | **161** |

Capture-count histogram (with-capture closures only): bench `{1:47, 2:6,
3:1, 4:1, 8:1}`; self.js `{1:1292, 2:704, 3:399, 4:204, 5:123, 6:52, 7:51,
8:29, 9:18, 10:6, 11:9, 12:5, 13:5, 14:3, 15:3, 16:3, 17:2, 18:1, 19:1,
21:1, 27:1}` — heavily 1-2 captures (69% of self.js's captured closures),
a long thin tail to 27 (a lambda-lift transform must handle >`MAX_CLOSURE_
ARITY`-sized capture lists, but as ORDINARY function params, which have no
8-slot ceiling — §2.2).

**FINDING**: the corpus is dominated by THREE real classes, not the one the
now-dead `_nonEscaping` predicate targeted. (1) Zero-capture closures
(1492/4404 self.js, 34%) already pay nothing — no work needed. (2)
Boxed-capture closures (1410/2912 captured, 48%) can never be lifted by
construction — the mutation contract requires shared, aliasable storage;
this is the SINGLE largest disqualifier — of the 268 self.js closures that
clear the (weak, loop/reentrancy-unrestricted) escaping test, 107 (40%)
still fail on a boxed capture. (3) The lift-eligible remainder is
**161/4404 (3.7% of ALL self.js closures, 60% of the 268 that clear the
escaping test, 5.5% of all captured closures)** and **1/174 bench closures**
(`provenance` — 3 captures, none boxed, `directCallSites: 8`, §5.2) — a
modest but real, precisely bounded population, answering audit-#18's own
open question ("no per-case who-pays list … self.js is the most productive
corpus to re-derive concrete paying shapes from," `.work/todo.md:130-142`)
with an honest number rather than the much larger figure a coarser
"non-escaping" count alone would suggest (371 tagged, of which only 161
survive the boxed-capture filter — the filter matters more than the escape
predicate does, on this corpus).

---

## 2. The lambda-lift design

### 2.1 Eligibility — precise definition

A closure literal `L` (an `=>` node with body `B`, bound to name `N` by a
`let`/`const`/plain assignment in enclosing body `E`) is **lift-eligible**
iff ALL of:

1. **Only called, never referenced as a value** — `onlyCalledNotReferenced
   (E, N)` (`compile/index.js:385-408`, unchanged — this predicate is
   already exactly "does the closure ever need to exist as a first-class
   NaN-boxed pointer," which is precisely "does it need ANY env
   representation at all"). Any use as a value (stored, passed, returned,
   compared, wrapped in `[]`/`{}`) means the closure must still materialize
   a real pointer somewhere — disqualified, falls to §1.2/§1.3/§1.4 as
   today.
2. **`N` is stable** — not reassigned (`!isReassigned(E, N)`), not a
   function param, not global, not boxed (`!ctx.func.boxed?.has(N)`) — the
   SAME stability gate `emitDecl`'s direct-dispatch registration already
   uses (`emit.js:2224-2225`). Lifting only makes sense for a fixed callee;
   a reassignable `N` might hold a genuinely different closure body at
   different calls, which needs real dispatch.
3. **Every capture is effectively-final at every call, i.e. no capture is
   in `ctx.func.boxed`** — the boxed-heap-cell path (§1.3) exists
   PRECISELY for captures whose value can be observed to change by a
   write from either side of the capture boundary after the closure is
   created. Lambda lifting passes a capture's CURRENT value at each call
   site as a plain stack argument — sound only if that value cannot
   diverge from what a shared cell would show, i.e. only if nothing ever
   writes it after declaration. This is not a new analysis: `boxedCaptures`
   (`analyze-scans.js:71-99`) already computes exactly this fact, for
   exactly this reason, today. **Reject the whole closure if ANY capture is
   boxed** — no partial lift (lifting only the non-boxed captures while
   leaving boxed ones behind in an env would need to keep an env allocation
   ANYWAY, defeating the point; simpler and sufficient to require all-clear).
4. **NO restriction on loops, recursion, or reentrancy** — this is the
   central claim of this design, argued in §2.3: those restrictions exist
   ONLY because `_nonEscaping`'s storage technique (a SHARED, reused
   address) can be clobbered by a second live activation. Lambda lifting
   has no shared address — every call gets its own stack-frame copy of the
   captures, by the SAME mechanism (WASM call frame) that already makes
   plain recursive function calls sound. Condition 4 is exactly what takes
   §1.5's live count from 0 (today, audit-#18 predicate) to 371
   (weak-predicate escaping-safe count, this session's independent scan —
   in the same ballpark as, though not identical to, audit-#18's own 642
   under a slightly different bench/self.js compile pass; not reconciled
   this session, flagged as an open question, §6) — the reentrancy
   restrictions were dropping essentially the ENTIRE eligible population,
   not a narrow edge case.

Note conditions 1-3 are STRICTLY the audit-#17 predicate (`onlyCalled
NotReferenced && !boxed(N) && !isGlobal(N) && !isReassigned(E,N)`) plus the
NEW capture-boxedness check (condition 3, not in the original `_nonEscaping`
predicate at all — the static-slot technique never needed it, because a
boxed capture already stores an i32 CELL POINTER in the env slot, which
IS effectively-final at declaration time even though the pointee mutates;
lambda lifting can't use that trick since there's no slot to hold a stable
pointer through — the ARGUMENT itself must be current at call time, and a
mutated-after-declaration capture has no single "current" value valid for
the closure's whole lifetime).

### 2.2 The transform

**Where in the pipeline**: lift decisions belong in the SAME pre-emission
analysis phase LoopPlan's mint runs in (`analyzeFuncForEmit`,
`compile/index.js:559-972`, `mintLoopPlans(body)` called last at line 972,
"sees this function's FINAL AST … maximally-settled `repOf` facts"). A new
`mintClosureEnvPlans(body)` walk, called from the SAME place (or folded
into `mintLoopPlans`'s own walk — both are single-pass AST walks over the
same finalized body), replaces `scanAndTagNonEscapingClosures`'s
`enterFunc`-time mutable tag entirely (§4 — retirement). It must run AFTER
`boxedCaptures` (already runs earlier in `analyzeFuncForEmit`, populating
`ctx.func.boxed` — the plan needs that fact settled) and BEFORE emission
begins (the plan is read at emission, never written).

**The transform itself** (once a plan is minted with `storage: 'none'`
i.e. lift):
- The closure body compiles as an ORDINARY named function
  (`ctx.func.map`-registered, real per-param WASM types via the SAME path
  `emitDirectFunctionCall`'s callees use — `compile/index.js`'s regular
  function-body compiler, NOT `emitClosureBody`'s uniform `(env f64, argc
  i32, a0..a7 f64) → f64` ABI, `compile/index.js:2048-2069`). Signature:
  `(capture_0, capture_1, …, capture_k, param_0, …, param_n) → result`,
  captures prepended in stable declaration order. This is a strict
  upgrade over today's closure ABI even setting aside allocation: real
  WASM param types (i32/f64/etc, whatever each capture's/param's own `rep`
  already proves) instead of the boxed-f64-NaN-slot convention every
  closure body pays today (`emitClosureBody`'s own numeric/typed-ctor
  lattice, `emit.js:4260-4295`, exists ONLY to claw back some of what the
  uniform ABI gives away by default — lifting sidesteps needing that
  lattice at all for these bodies, since real params start typed).
- No `ctx.closure.table`/`ctx.closure.bodies` registration, no
  `mkPtrIR(PTR.CLOSURE, …)`, no NaN-boxed pointer ever constructed for
  this closure (condition 2.1.1 guarantees nothing ever needs to hold it
  as a value).
- Every call site (`N(args...)`) becomes `call $liftedName(capture_0, …,
  capture_k, args...)` — literally `emitDirectFunctionCall`'s own path,
  once the lifted function is registered in `ctx.func.map` like any other
  named function. `tryDirectClosureCall`'s whole apparatus (paramTypes
  lattice, minArgc tracking, arity-fallback) becomes unnecessary for
  lifted closures — real params already carry real types and the callee
  has one true arity, no `MAX_CLOSURE_ARITY`-driven inline-slot padding.
- Capture arity is UNBOUNDED (ordinary WASM function params, no 8-slot
  ceiling) — directly resolves the self.js long-tail (up to 27 captures,
  §1.5) that would otherwise need `ctx.closure.spill`'s array-based
  overflow path (`emit.js:262-296`) even under the OLD ABI.

**Multiply-called closures**: nothing in the transform assumes a single
call site. Each of N call sites independently evaluates its own current
capture values and passes them — this is exactly what a shared env would
have stored ONCE and every call site would have READ; lifting just moves
the "when is the value captured" moment from closure-creation-time to
each-call-time, which are IDENTICAL moments for an effectively-final
capture (that's what "effectively final" means — the value literally
cannot differ between them, so there is no distinction to preserve, hence
condition 2.1.3's soundness).

### 2.3 Interaction with direct-dispatch: SUBSUMPTION, not composition

`ctx.func.directClosures` (§1.2) exists to skip `call_indirect` for a
callee whose funcIdx is statically known. A lifted closure's callee is
MORE statically known than that — it isn't even dispatched through the
closure convention at all, it's an ordinary function call. Every lift-
eligible closure (§2.1) is a STRICT SUBSET of what `directClosures`
already accepts (compare conditions: direct-dispatch requires !boxed(N),
!isGlobal(N), !isReassigned(E,N) — identical to 2.1.2; lift ADDS 2.1.1
`onlyCalledNotReferenced` and 2.1.3 captures-non-boxed, which direct-
dispatch does not require). So: **lifting fully replaces direct-dispatch
for every closure it fires on**; direct-dispatch remains exactly as it is
today for the (larger) remainder — closures that escape as values but are
ALSO called by name (a real, measured shape — e.g. a closure returned from
a factory then also called locally before being returned, or captured by
an inner arrow per `module/function.js:117-121`'s `captureDirectClosures`
propagation). No new machinery needed to keep the two working together:
`ctx.func.map` lookup already precedes the `directClosures` check in the
call dispatcher (`emit.js:7105-7111`) — a lifted closure's name, once
registered as an ordinary function, is found by
`ctx.func.names.has(callee)` (`emit.js:7105`) BEFORE the `directClosures`
branch is even reached, so the subsumption is structural, not an added
special case.

### 2.4 Recursion/reentrancy safety BY CONSTRUCTION

The entire audit-#17→#18 saga (`compile/index.js:410-463`, `.work/
todo.md`'s AUDIT-#17/#18 entries) was about proving increasingly narrow
sufficient conditions for a SHARED address to be safe across possible
reentrant activations — each fix (loop restriction, then `onlyCallIsSelf`)
closed one more concrete counterexample the previous fix's proof missed,
and the corpus measurement shows the safe subset shrank to the empty
set. This is the classic sign of an unsound MECHANISM being patched
towards soundness by narrowing its domain rather than fixing its shape.
Lambda lifting has NO shared address: each call's captures are (WASM spec)
distinct local-scoped stack values, one instantiation per call frame,
guaranteed non-aliased across concurrent (recursive) activations by the
SAME guarantee that already makes ordinary recursive function calls
(`fact(n) => n <= 1 ? 1 : n * fact(n-1)`) correct without any special
analysis. The audit-#17 bug (`module/object.js`'s `fieldStoredValue`,
re-entered via a nested object literal's own `{}` handler, `.work/todo.
md`'s AUDIT-#17 account, `compile/index.js:419-422`) and the audit-#18 bug
(`outer(2)` reading `12` vs `6`, `compile/index.js:444-446`) are BOTH,
structurally, "two activations sharing one slot" — under lifting there are
two independent sets of stack arguments, and the bug class has no object
to attach to. This is not a claim that needs a NEW proof; it is the
observation that the proof obligation itself disappears.

### 2.5 The mutable-capture exclusion (recap, see §2.1.3/§1.3)

Boxed captures keep the EXISTING heap-cell path unconditionally — §1.3's
mechanism is untouched by this design. A closure with a mix of boxed and
non-boxed captures does NOT partially lift; §2.1.3 rejects the whole
closure from lift eligibility the moment any capture is boxed, falling
through to today's behavior (heap env storage, possibly direct-dispatched
per §1.2, unchanged). This keeps ClosureEnvPlan's "storage" decision
binary at the closure granularity (matches the LoopPlan/FunctionPlan
precedent of one frozen decision per plan-holding node, not a per-field
sub-plan) and avoids inventing a NEW hybrid ABI (lifted-params-plus-env)
that would need its own dispatch convention, doubling the surface for a
case (§1.5: 1410/2912 self.js captured closures have a boxed capture) that
already has a working, sound lowering.

---

## 3. The plan record — `ClosureEnvPlan`

Mirrors the `LoopPlan`/`FunctionPlan` idiom already established
(`src/compile/loop-model.js:171-210`'s `astLoopPlan` WeakMap +
`mintLoopPlans`; `src/reps.js:280-285`'s `repsFrozen` durable-fact freeze):
a **frozen, pre-emission fact**, keyed on AST node identity, computed once
after all AST-rewrite and analysis passes for the enclosing function have
settled, read-only from then on.

```js
// src/compile/closure-plan.js (new module, mirrors loop-model.js's shape)
export const astClosurePlan = new WeakMap()   // keyed on the arrow's BODY node (`B`, §2.1) —
                                                // same node identity ctx.closure.make already
                                                // receives as `body`, so the lookup at emission
                                                // is a single WeakMap.get, no plumbing needed.

// ClosureEnvPlan = {
//   storage:            'none' | 'direct-params' | 'heap' | 'static',
//   captures:            string[],            // declaration-order capture names (lift: becomes param order)
//   callMultiplicity:    number,               // count of call sites to N within E (informational — NOT a
//                                               // soundness input; §2.2 argues multiplicity is irrelevant)
//   enclosingReentrant:   boolean,              // true if E's own body contains ANY call other than to N
//                                               // itself (the audit-#18 onlyCallIsSelf fact) — kept as
//                                               // PROVENANCE for 'static' plans only (§4: dying path);
//                                               // lift plans never consult it (§2.1 condition 4)
//   escapes:             boolean,               // !onlyCalledNotReferenced — true disqualifies 'none'/
//                                               // 'direct-params', forces 'heap' or 'static'
// }
```

`storage` values map onto §1's four mechanisms directly: `'none'` = §1.1's
existing zero-cap case (already optimal, plan just RECORDS the fact instead
of re-deriving `envCaptures.length===0` at emission — minor uniformity
win, not a behavior change). `'direct-params'` = the NEW lambda-lift
outcome (§2). `'heap'` = §1.1's default heap-alloc path, `'static'` =
§1.1's now-provably-empty static path, **kept in the record shape for
completeness/future-proofing but never selected** by the mint (§4 argues
for deleting the CODE, not the enum value — an enum with an unreachable
member costs nothing; deleted dead branches in `module/function.js` do).

**Where it's minted**: `mintClosureEnvPlans(body)`, called from
`analyzeFuncForEmit` alongside `mintLoopPlans(body)` (`compile/index.js:
972`) — same call site, same "last, sees final AST + settled reps"
guarantee. Walks `body` for `let`/`const`/plain-assignment closure
literals (literally `scanAndTagNonEscapingClosures`'s existing walk shape,
`compile/index.js:465-490`, minus its mutation of the AST node — it writes
into `astClosurePlan` instead of `arrow_body._nonEscaping`), computing
`escapes` via the unchanged `onlyCalledNotReferenced`, `captures` from the
literal's own `findFreeVars` result (already computed once per closure by
`ctx.closure.make` itself, `module/function.js:151` — the mint can share
that computation or (simpler, avoids a subtle staleness risk) recompute it
freshly against the frozen AST, since `findFreeVars` is a pure AST query),
and the boxed-capture check against `ctx.func.boxed` (settled by this
point in `analyzeFuncForEmit`, per §2.2's ordering requirement).

**Where it's read**: `ctx.closure.make` (`module/function.js:93`) looks up
`astClosurePlan.get(body)` once, at the top, instead of computing
`envCaptures`/checking `body._nonEscaping` inline — the `storage` field
drives which of the (now four, was three) branches fires. `emitDecl`
(`emit.js:2220-2239`) and the call dispatcher (`emit.js:7108-7111`) read
the SAME plan (via the closure's registered body-name → plan, or by
keeping the WeakMap keyed on the DECL node so both the creation site and
call sites resolve consistently) instead of independently re-deriving
"is this closure direct-dispatchable" from `ctx.func.directClosures`'
emission-time bookkeeping.

## 4. Migration slices

Ordered so every slice up to the last is **byte-identity-gated** (`test/
kernel-parity.js`'s O0/O2/O3 byte-identical-WAT gate, plus a full default-
vs-flag build diff, the same technique audit-#18's own gate ladder used)
and only the slice that actually fires lifting is **measured-delta**
(`test/perf-ratchet.js` + `scripts/bench-size.mjs` geomean, same gates
audit-#18 ran).

1. **Introduce `astClosurePlan` + `mintClosureEnvPlans`, storage values
   `{none, heap, static}` only** (no lift yet) — pure refactor: `ctx.
   closure.make` reads the plan instead of recomputing `envCaptures.
   length===0`/`body._nonEscaping` inline. `emitDecl`/call-dispatcher
   UNCHANGED (still read `ctx.func.directClosures` directly — that
   machinery isn't touched by this slice). **Byte-identity gate**: WAT
   output must be IDENTICAL before/after for every corpus case (kernel-
   parity + a targeted bench-size + perf-ratchet re-run) — this slice
   changes representation, not behavior, and should measure exactly 0
   delta everywhere, mirroring the LoopPlan mint's own precedent
   (`.work/todo.md:484-529`, a same-shape "plan minted earlier, same
   facts" refactor that was itself byte-identity-gated).
2. **Add the `'direct-params'` (lift) storage decision to the mint**,
   condition 2.1(1-4). `ctx.closure.make` still does NOT change codegen
   for `'direct-params'` yet — it's computed and asserted-consistent
   (e.g. a debug-only cross-check that the plan's `escapes`/boxed-capture
   facts match a fresh re-derivation) but emission still takes the `heap`
   path for everything. **Byte-identity gate again** — this slice adds a
   fact, doesn't consume it.
3. **Wire `'direct-params'` into actual emission** — the transform itself
   (§2.2): lifted closures compile as ordinary named functions, call sites
   emit `emitDirectFunctionCall`-shaped calls. THIS is the first slice
   that can change output. **Measured-delta gate**: `perf-ratchet.js`
   (loop-body op counts — lifted closures inside a loop body should show a
   MEASURABLE per-iteration op reduction, the alloc+store sequence
   replaced by nothing), `bench-size.mjs` geomean (≤1.05 gate, same
   threshold audit-#18's own ladder used), full `test:wasm` correctness
   suite, `kernel-oracle`, `fuzz` (seeded, opt levels 0-3) — the full gate
   ladder audit-#18 itself ran, since this is the slice that actually
   changes what ships. Given §1.5's numbers (161/4404 self.js closures,
   3.7% of all closures — an order of magnitude more than the 0 the
   current gate reaches), this is the slice most likely to show a REAL,
   attributable size/speed win, unlike audit-#18's own 100%-tags-withdrawn-
   zero-cost surprise.
4. **Retire the static path** — delete `module/function.js`'s
   `_nonEscaping`/`OPTF.staticClosureEnv` branch (the dead code identified
   in §1.1/§1.5: 0/4404 grants on the full self.js corpus, 0/174 on bench,
   confirmed independently twice this session under both the audit-#18
   predicate AND relaxed weak predicate — the static-SLOT technique
   specifically, not just today's overly narrow gate, has no live
   customer once lifting exists, because §2.3 proves lifting is a strict
   superset of what the static path could ever safely cover, at STRICTLY
   lower cost (no storage at all vs. one static slot)), `scanAndTagNon
   EscapingClosures`'s `enterFunc`-time mutation
   (`compile/index.js:383-492,540`), the `OPTF.staticClosureEnv` flag
   entry (`src/passes.js:20`), and its `HOT_PASSES` registration
   (`src/passes.js:125`). **This is dead-code deletion, not a behavior
   change** — audit-#18's own measurement already proved removing every
   grant costs nothing (dist even shrank, `.work/todo.md:96`); this slice
   just stops carrying the machinery that computes a permanently-empty
   set. Gate: same byte-identity check as slice 1 (output must be
   UNCHANGED, since the removed path was already unreachable) — the value
   here is code-size/maintenance, not runtime.

Slices 1-2 could land together (both refactor-only); 3 must be isolated
(the only slice touching shipped bytes); 4 can land any time after 3 is
proven safe (or even independently, today, ahead of the rest of this
design — audit-#18 already supplied the proof).

## 5. Risk register + expected wins

### 5.1 Risks

- **Capture-order/identity mismatch between mint and `ctx.closure.make`**:
  the plan computes `captures` once (mint time); `ctx.closure.make` must
  consume the SAME list in the SAME order the lifted function's params
  were declared in, or a call site could pass argument N's value into
  param N+1's slot. Mitigate by making the plan carry the definitive order
  and having BOTH the lifted-function declaration and every call site read
  captures off the plan, never re-deriving independently (unlike today's
  `envCaptures` which IS re-derived, safely, because it's always derived
  from the same closure literal at the same point — the risk is new only
  because slice 3 introduces a SECOND consumer, the call sites, that must
  agree).
- **A capture that is a PARAMETER of a currently-executing loop iteration
  is "effectively final" per closure but genuinely different per
  activation** (e.g. `for (let i=0;...) { const f = () => i*2; ... f() }`
  — `i` is a fresh per-iteration binding in JS's `let` semantics, jz's
  own model may or may not already materialize that as a fresh local per
  iteration). This is NOT a NEW risk lifting introduces — `boxedCaptures`/
  `isReassigned` already have to get this right for the EXISTING heap-env
  path (the value stored into the env array at closure-creation time is
  already "this iteration's i", by the same mechanism). Lifting simply
  inherits whatever that mechanism already proves; flagged here only so
  the mint's capture-value-read point is verified to reuse the EXACT same
  "read i's current value" codegen `ctx.closure.make`'s heap path already
  uses (`module/function.js:230-238`'s per-capture store loop), not a
  fresh derivation that could disagree.
- **`ctx.closure.width`/spill-array interaction**: lifted closures don't
  use the closure ABI at all, so `MAX_CLOSURE_ARITY`/`ctx.closure.spill`
  (`emit.js:262-296`) simply don't apply — verify no downstream consumer
  (e.g. `ctx.closure.paramTypes`/`minArgc` lattices, `emit.js:4260-4287`)
  is accidentally consulted for a lifted closure's (now non-existent)
  `bodyName` entry; those maps should simply never gain an entry for a
  lifted closure (its "body name" IS its function name in `ctx.func.map`,
  a different namespace).
- **Debug/inspect tooling** (`ctx.transform.inspect`, referenced near
  `compile/index.js:337`) may have closure-specific assumptions (e.g.
  "every closure has a `funcIdx`/table entry") that a lifted closure
  breaks by design (§2.2: no table registration). Needs an audit pass
  before slice 3, not blocking the design.

### 5.2 Expected wins

Per §1.5: **161/4404 self.js closures (3.7%)** and **1/174 bench closures**
are lift-eligible under the FULL condition (weak-predicate non-escaping AND
zero boxed captures, measured jointly in one pass — not estimated). This is
a smaller, more honest number than a coarse "how many closures are
non-escaping" count would suggest: 268 CAPTURED self.js closures clear the
escaping test (371 total tagged includes 103 zero-capture closures, already
optimal today, not lift candidates in any meaningful sense — §1.1's "none"
tier); of those 268, the boxed-capture filter (§2.1.3) removes 107 (40%),
leaving 161 (60%). Per-closure win
shape: one `call $__alloc` + N `f64.store`/`i32.store` (the env-population
loop, `module/function.js:230-238`) replaced by N ordinary stack-argument
pushes — for a closure called from inside a loop (the shape `perf-
ratchet.js` actually measures), this converts a HEAP ALLOCATION per
iteration into pure stack traffic, a categorically cheaper operation (no
allocator bookkeeping, no GC-relevant pointer, no cross-iteration liveness
to reason about).

**Bench**: exactly one named target, `provenance` — 1 closure, 3 captures
(none boxed), already direct-dispatched today (`directDeclSites: 1`,
`directCallSites: 8`, per-case data in §0's harness output). The other 11
bench cases that looked like candidates at a glance (`bezfit`, `delayline`,
`deltae`, `glyfparse`, `nbody`, `resample`, `sdf`, `slices`, `spmv`,
`trace`, plus `watr`'s 4 static-tagged closures) ALL clear the weak
non-escaping test but EVERY one of them has exactly one capture and that
capture is boxed — disqualified by §2.1.3, not by the escape test. This is
itself a useful, unglamorous finding: on this bench corpus, "single-helper,
called-only, called-repeatedly" (the shape the dead `_nonEscaping` gate was
built for) correlates STRONGLY with "captures something it also mutates"
(an accumulator, a running index, a small state struct) — real closures
factored out of loop bodies tend to close over the very state the loop is
updating. Lambda lifting's win is real but narrower than the raw
non-escaping count implies; `provenance`'s shape (multiple READ-ONLY
captures feeding a pure computation, no mutation) is the one that
generalizes.

**self.js**: 161 lift-eligible closures span the whole self-hosted
compiler; no per-source-file breakdown was captured this session (the
`__CEP_SURVEY` counters are corpus-aggregate, not attributed back to
`scripts/self.js`'s module graph — recovering per-file attribution is
cheap, a few more lines threading the current compiling filename through
the same counter, but wasn't needed to answer THIS survey's question and
is left as a slice-2 task, §6 item 3). The 161 count alone is sufficient to
justify slice 3 (§4): an order of magnitude larger than the 0 closures the
current dead gate reaches, on the SAME corpus audit-#18 itself measured
zero cost from removing.

## 6. Open questions for the coordinator

1. **Plan-record granularity**: should `ClosureEnvPlan` be keyed on the
   arrow's BODY node (matches `ctx.closure.make`'s own `body` parameter,
   minimal plumbing) or the DECL node (matches where `escapes`/stability
   facts naturally live, since they're about the BINDING not the literal)?
   §3's draft picks body-node keying for the emission-side lookup
   convenience; the mint-side computation naturally wants decl-node
   context (`E`, `N`). A single WeakMap can only key on one, but nothing
   stops maintaining two (or one WeakMap of `bodyNode → decl-derived
   plan`, populated once).
2. **Should slice 1 (plan introduction, no behavior change) and slice 4
   (static-path retirement) be sequenced BEFORE or independent of slices
   2-3 (the actual lift)?** §4 argues slice 4 can land today, standing
   alone — audit-#18 already supplied the "0 grants, 0 cost" proof. Is
   there value in landing it immediately as its own small, low-risk
   cleanup commit, decoupled from this design's remaining review cycle?
3. **self.js's 161 lift-eligible closures have no per-source-file
   attribution yet** (§5.2) — the corpus-aggregate count is real and
   already sufficient to justify slice 3, but slice 3's "measured-delta"
   gate will want NAMED targets (which `src/*.js` files' helpers actually
   lift, so a reviewer can sanity-check the WAT diff against a specific
   source location) rather than a single number. Coordinator call: derive
   this now (cheap — thread the compiling filename through the same
   counters) or defer to slice-3 implementation time, when the actual
   transform will need per-site identification anyway.
4. **Is `callMultiplicity` in the plan record actually load-bearing for
   anything**, or is it pure provenance/debugging? §2.2 argues soundness
   doesn't depend on it. If it has no consumer, `LoopPlan`'s own minimalism
   (only `id`/`hull`/`boundConst`, no unused fields) argues for dropping it
   from the record rather than carrying dead weight from day one.
5. **This session's weak-predicate self.js tag count (371) does not match
   audit-#18's own reported pre-fix grant count (626, `.work/todo.md:95`)**
   — both are "closures satisfying `onlyCalledNotReferenced` + stability,
   no loop/reentrancy restriction" over self.js, but from two different
   sessions' scans. Not reconciled here (out of scope for this design
   pass — the DOWNSTREAM number that matters for this design, 161
   lift-eligible, was measured fresh and independently in one pass, §0).
   Plausible causes worth a coordinator-directed follow-up if it matters:
   source drift between the two sessions (real, `self.js`'s own module
   graph changes commit-to-commit), a different measurement point
   (audit-#18 instrumented `scanAndTagNonEscapingClosures`'s two grant
   sites directly; this session reads `body._nonEscaping` downstream at
   `ctx.closure.make`, which should be equivalent but wasn't cross-checked
   line-for-line), or a subtly different bench/self.js compile
   configuration. Does not change this design's conclusions (§2 doesn't
   depend on either count being exact), but should not be silently
   smoothed over.

---

**Local commit**: `.work/closure-plan-design.md` only. No `src/` changes —
confirmed via `git diff --stat` showing only this file before commit (§0).

## COORDINATOR RULINGS (2026-08-10, binding)
1. Plan keying: BODY node (the loopPlanLink precedent — the identity that
   survives lowering; decl nodes die in prepare). WeakMap, fail-open.
2. Static-path retirement: YES, land NOW as its own slice — 0 grants on both
   corpora independently re-derived; deletion first simplifies the surface
   the plan replaces. (scanAndTagNonEscapingClosures + module/function.js's
   static-env branch + OPTF.staticClosureEnv registry entry + the _nonEscaping
   plumbing; keep the audit-#17/#18 pins as history — they now pin the
   heap path's correctness.)
3. callMultiplicity: DROPPED from the record — it was the static-env
   concept's need; lambda-lifting has no shared storage, multiplicity is
   irrelevant. Record stays minimal: {storage, captures}.
4. The 371-vs-626 count discrepancy: reconcile inside slice 1's shadow-assert
   (likely predicate-version drift — audit-#18's count predates
   onlyCallIsSelf); a reconciliation failure is a FINDING.
5. Slices 1-2 (plan introduction + lift-decision computation, both
   byte-identity-gated) AUTHORIZED alongside the retirement slice. Slice 3
   (lift emission, measured-delta) waits for coordinator review of slice 2's
   decision census.

---

## AS-LANDED (2026-08-10) — slices R, 1, 2

Three commits, in order, matching §4's own sequencing (slice R first, slices
1-2 each their own commit though authorized together):

- `cf760af8` — slice R: `scanAndTagNonEscapingClosures` + its `enterFunc`
  call site, `module/function.js`'s static-env branch, the
  `OPTF.staticClosureEnv` registry entry (`src/passes.js` PASS_NAMES +
  HOT_PASSES + the level-1 preset reference), and the `emit.js`
  `_nonEscaping` tag-forwarding plumbing — all deleted. The audit-#17/#18
  regression test (`test/closures.js` "static closure env: re-entrant
  enclosing function…") is untouched by name and content; it now pins the
  heap path's own correctness rather than the retired static path's.
- `c624a25b` — slice 1: `src/compile/closure-plan.js` (new), `astClosurePlan`
  + `mintClosureEnvPlans`, minted alongside `mintLoopPlans` at all three
  call sites (`analyzeFuncForEmit`, `emitClosureBody`'s block and
  expression-body arms). `ctx.closure.make` consults the plan
  (`storage` drives the `zero-capture` vs. alloc branch), fail-open on a
  miss, `JZ_DEBUG_INVARIANTS`-gated shadow-assert against the legacy inline
  decision.
- `64953399` — slice 2: `'lift-eligible'` storage value, UNWIRED (plan data
  only — `ctx.closure.make`'s branch stays binary, so a lift-eligible
  closure emits exactly like `'heap'` today).

### Reconciliation (coordinator ruling 4): the 371-vs-626 discrepancy

**Finding: a measurement-point artifact, not a predicate-version or
source-drift issue.** Re-derived both numbers fresh, on the SAME commit
(pre-slice-R HEAD, `6242d0ee`, via a disposable worktree), using the exact
weak-predicate relaxation §0 describes:

- Counting at `scanAndTagNonEscapingClosures`'s OWN grant sites (audit-#18's
  own instrumentation point): **1048**. This is the WRONG place to count —
  `enterFunc` calls the scan at every frame entry for a body (analyze pass,
  emission pass, AND per-closure-body emission, per `enterFunc`'s own
  three-caller doc), so a grant gets counted 2-3× over. 1048 (this session,
  current source) vs. audit-#18's own 626 (an earlier session, less source)
  are consistent with the SAME over-counting artifact at two different
  points in self.js's growth — not a different predicate.
- Counting downstream, at `ctx.closure.make` (`body._nonEscaping` read
  exactly once per closure literal, the natural dedup point — matching what
  a frozen pre-emission mint like `ClosureEnvPlan` produces by construction):
  **371** — an EXACT match to the design doc's own §1.5 number, on the same
  commit, independently re-derived this session.

Conclusion: 371 is the correct, reproducible count; 626 (and this session's
own re-derived 1048) are both grant-site artifacts of the OLD mechanism's
multi-pass re-scan, not a real population difference. `ClosureEnvPlan`'s
single mint-per-body-per-frame design (§3, mirroring `mintLoopPlans`)
structurally cannot reproduce this artifact — there is no second scan to
over-count from.

### Slice 2 decision census

Bench (58-case corpus, `bench-size.mjs`'s own `optimize:'size'` options) and
self.js (`build-dist.mjs`'s own options), counted at `astClosurePlan.set`
(i.e. MINT-COVERED closures only — closures whose plan lookup would fail
open, e.g. destructured-param closures whose body node is rewritten before
`ctx.closure.make` sees it, are not counted here; that population is a
separate, smaller gap from the escaping/boxed-capture funnel this table
measures):

| storage | bench (58 cases) | self.js |
|---|---|---|
| zero-capture | 31 | 1059 |
| heap | 10 | 1298 |
| boxed-cell | 34 | 1367 |
| **lift-eligible** | **1** | **148** |
| mint-covered total | 76 | 3872 |

Mint coverage (mint-covered / §1.5's own total-closures-created count) is
**76/174 (44%) on bench** and **3872/4404 (88%) on self.js** — the gap is
closures whose shape this mint's walker doesn't classify (destructured
params, primarily) or whose enclosing binding form the walker doesn't
special-case; ALL such closures fail open to the legacy inline decision
(verified byte-identical + 0 `JZ_DEBUG_INVARIANTS` fires), so the gap is a
census-completeness limitation, not a correctness one. Bench's lower
coverage rate tracks §5.2's own finding: bench closures skew toward
single-boxed-capture accumulator shapes, several of which sit inside
destructured-param callback signatures (array-method callbacks) the mint
skips by design.

The self.js **148** lift-eligible count is lower than §1.5's own **161**
(measured via a from-scratch relaxed-predicate scan, not this mint) — both
numbers are in the same ballpark and consistent with the SAME 88% mint-
coverage gap: 161 × 0.88 ≈ 142, close to 148 given the two measurements use
different code paths (this mint's `onlyCalledNotReferenced` + stability
check vs. §1.5's relaxed `scanAndTagNonEscapingClosures` + separate boxed-
capture join). Both agree on the header finding: a modest, precisely
bounded population (~150 self.js closures, ~1 bench closure), not the much
larger raw escaping-count §1.5 itself warned against over-reading.

### Gate summary

- Byte-identity: 58-case bench corpus (jessie/jz excluded), O0/O2/O3, 174
  compiles — 0 diffs at every slice (R, 1, 2 each independently re-verified
  against the pre-slice-R baseline).
- Battery (`node scripts/battery.mjs`): fixpoint/fuzz(30173 cmp)/build/
  self(21/21)/kernel(2714 pass) all green at every slice; native/O0/O3/dbg/
  wasi each show exactly the ONE pre-existing, already-documented
  `test/optimizer.js` "typed RMW: one guard covers the pure read and
  ignored OOB store" flake (5 guards vs. expected 4) — confirmed
  pre-existing and unrelated by reproducing it identically on a disposable
  worktree at the pre-slice-R commit (`6242d0ee`), both standalone
  (`node test/optimizer.js`) and via the full suite (`node test/index.js`,
  same 2 fails: this one + "interval walk…codec bounds checks"). Not this
  campaign's regression; not touched.
- `JZ_DEBUG_INVARIANTS` battery leg (dbg): 0 `ClosureEnvPlan` shadow-assert
  fires at slice 1 and slice 2 — one real gap the assert itself caught
  during slice 2's own gate run (the normalization fix now in
  `64953399`, `'lift-eligible'` was flagging a false drift against the
  legacy path before that fix landed).
- `node test/kernel-parity.js`: 3/3 groups, 33/33 assertions, byte-identical
  WAT at O0/O2/O3 — at every slice.
- `node scripts/build-dist.mjs` ×2: byte-identical dist output across two
  consecutive runs, at every slice (dist/jz.wasm hashes differ SLICE-TO-
  SLICE, as expected — dist/jz.wasm compiles `scripts/self.js`, whose own
  source now includes the new `closure-plan.js` file, so the self-hosted
  compiler's OWN size changes; this is not the byte-identity gate's
  target — the bench-corpus check above, same fixed input source compiled
  by different compiler versions, is).

## COORDINATOR RULING — slice 3 (2026-08-10, binding)
DEFERRED, evidence-driven. The census: bench 1/76 lift-eligible (the corpus
simply doesn't carry lift-shaped closures), self.js 148/3872 (real but
modest kernel benefit). Correctness-by-construction was already achieved by
the retirement (heap path everywhere — the audit-#17/#18 class is
unrepresentable). Lift emission is therefore a perf/size play whose
measured corpus payoff is ~nil against a real call-site-rewrite risk — the
inlinePureFns precedent applies verbatim: correct architectural home built,
transform deferred until a real case needs it (a closure-bound hot bench
case, or kernel-build profiling showing closure-alloc cost post-reboot).
The plan record + eligibility data stay live so that day needs only the
emitter.

## AS-LANDED (2026-08-10) — audit-#19 P0: session-owned plan storage

Confirmed-fixed hazard: `astClosurePlan` (this module) was a module-scope
`const … = new WeakMap()`, same shape as `astLoopPlan` (loop-model.js) and
`loopPlanLink` (ir.js). Under self-hosting, WeakMap lowers to a strong Map
(the kernel has no native GC) — entries from a PRIOR `compile()` session
therefore survive into the next one for the lifetime of the wasm instance.
Combined with the self-hosted kernel's bump-allocator arena (`scripts/self.js`
setupSelf's own doc: "the arena is a bump allocator that `_clear` rewinds
between compiles… a post-`_clear` allocation can overwrite a dangling entry's
bytes"), a fresh AST node minted after reset can be allocated at the SAME
arena offset a stale key occupied — a stale-plan HIT exactly where every
reader (`ctx.closure.make`, emit.js's `'for'` handler, vectorize.js's
SIMD-eligibility check) fails open on a MISS, per the pre-trio spec. Precedent
followed: NOT the ctx.js fact-store's `getFactStore()`-accessor idiom (that
exists to dodge an import cycle across program-facts.js/analyze.js/
wat/assemble.js — none of these three maps have that problem, each already
lives in and is imported directly from its own home module) but the simpler
sibling idiom already used for prepare/index.js's 14-let working set and
optimize/vectorize.js's why-not-simd flags: a module-scope **`let`** (not
`const`), reassigned to a fresh WeakMap by a small `resetX` closure,
registered once via `ctx.js`'s `registerResetHook` (session survey audit-#13
slice a's `RESET_HOOKS`, drained by every `reset()`/`beginSession()` call —
both native `index.js` setupCtx and the self-host kernel's `setupSelf` run
the identical `src/session.js` `beginSession`, so the fix covers both legs
uniformly). ES-module live bindings mean every existing named import
(`module/function.js`'s `astClosurePlan`, `src/compile/emit.js`'s
`astLoopPlan`/`loopPlanLink`, `optimize/vectorize.js`'s `loopPlanLink`) keeps
working with ZERO call-site changes — the reassignment inside the defining
module is visible to every importer automatically. WeakMap stays the TYPE
(native-GC benefit when NOT self-hosted); only OWNERSHIP+LIFECYCLE changed —
bounded to one compile's worth of nodes, which is what makes the strong-Map
kernel lowering sound.

Files: `src/compile/closure-plan.js` (`astClosurePlan` → `let` +
`resetAstClosurePlan` + `registerResetHook`), `src/compile/loop-model.js`
(`astLoopPlan`, same shape), `src/ir.js` (`loopPlanLink`, same shape).
`test/session-reentrancy.js` gained a fourth pair, `CLOSURE_LOOP_A`/
`CLOSURE_LOOP_B` — two STRUCTURALLY parallel programs (same shape/position:
a zero-capture closure, a heap-capture closure, a boxed-cell closure via a
reassigned-inside-closure counter, two loops with different literal bounds)
compiled sequentially in one process both orders, asserted byte-equal to a
fresh-process compile of each — a stale plan leaking from A into B's
same-shaped nodes would read the WRONG hull/boundConst/storage and
miscompile, not merely no-op, so this is a real regression guard even though
(like the suite's existing two pairs) it is `onKernel()`-skipped: the actual
arena-offset-collision vehicle is self-hosted warm-instance reuse
(`JZ_BENCH_WARM`), a benchmark-only path with its own unrelated known gaps
(bench-selfhost.mjs's documented WAT-reparse flake) — the in-process JS-host
probe validates the fix does not regress ordinary warm reentrancy, matching
the standing suite's own stated scope.

Gates (isolated worktree, HEAD `3f344c6d`): full battery 3427 total / 3419
pass / 2 fail (both the pre-existing, already-documented `interval walk:
strided companion cursor…` and `typed RMW: one guard covers…` codec-bounds
flakes, unchanged) / 6 skip; `test/simd.js` 158/158; `test/kernel-parity.js`
33/33 (O0/O2/O3); `test/session-reentrancy.js` 5/5 (12 assertions, the new
pair included); `scripts/build-dist.mjs` ×2 byte-identical (dist/jz.js,
dist/jz.wasm, dist/interop.js, assets/sprae.js sha256 match across two
consecutive builds); a 10-case × O2 bench-corpus byte-identity spot-check
(alpha/blur/bytebeat/crc32/fft/mandelbrot/nbody/particle/synth/lorenz)
sha256-diffed against the unfixed shared tree at the SAME HEAD — 0 diffs, a
pure lifecycle change.

## AS-LANDED (2026-08-11) — architecture re-audit item 4: ClosureId +
## authoritative per-capture plan record (`0edcddea`)

Per the audit's own record shape: `{ id: ClosureId, storage: 'none'|'heap',
captures: [{ name, bindingId, mode: 'value'|'cell'|'constant', constant? }] }`
— a deepening of slice 1/2's `{ storage, captures: string[] }` record, not a
new mechanism. Three changes:

1. **`id`** — a stable ClosureId, `ctx.transform.closureId++` (src/ctx.js's
   reset(), mirroring loop-model's `freshLoopPlanId`) — identifies a PLAN
   RECORD, never names anything emitted.
2. **`storage` narrowed to `'none'|'heap'`** — the now-dead `'boxed-cell'`
   distinction moves onto each capture's own `mode` (below); the never-wired
   `'lift-eligible'` tag (design §4 slice 3, COORDINATOR RULING: DEFERRED) is
   dropped from the enum entirely — it had zero consumers and slice 3 remains
   not undertaken (this item does not revisit that ruling).
3. **`captures` becomes `[{name, bindingId, mode, constant?}]`** — the
   planner (closure-plan.js's `mintArrow`) now computes the FULL
   classification (free vars, constant folds via `ctx.scope.constInts`/
   `topLevelIntConsts`, boxed cells via `ctx.func.boxed`) that module/
   function.js's `ctx.closure.make` used to independently re-derive inline
   at lines 108-155 (pre-item-4 numbering) EVERY closure literal.
   `bindingId` is `name` itself when it carries prepare/index.js's
   `<T>f<fnId>_<serial>` BindingId-totality suffix (every function-local
   capture), `undefined` for a bare module-scope global (BindingId totality
   only renames function-locals) — "when-available" per the record's own
   spec, not a promise.

**Primary/shadow flip**: `ctx.closure.make` now derives `envCaptures`/
`captureIntConsts`/`boxedCaptures`/`storage` FROM the plan when one is
present (`legacyDerive()`'s inline walk over `captures` is SKIPPED on that
path) — the reverse of slice 1, which always computed the legacy path and
only used the plan for an after-the-fact `storage`-string check. Under
`JZ_DEBUG_INVARIANTS`, `legacyDerive()` still runs, now as the shadow-assert:
its `env`/`boxed`/`intConsts`/`storage` are compared field-for-field against
the plan-derived values (order-sensitive for the two arrays, Map-equality for
`intConsts`), throwing `ClosureEnvPlan drift: …` on any disagreement.

**Destructured-param closures get plans too.** Previously EXCLUDED entirely
(closure-plan.js's own doc: "the body identity this mint would key on does
not yet exist at mint time" — emit.js's `'=>'` handler reconstructs a FRESH
body array to prepend the destructuring `let`s, so a body-keyed plan minted
against the pre-rewrite body could never be looked up again). Two options
considered:
- **Move the destructuring rewrite earlier** (into the mint, or into a
  prepare-phase normalization pass, matching prepare/index.js's `defFunc`
  precedent for TOP-LEVEL functions, which already desugars destructured
  params at prepare time). REJECTED: the rewrite mints fresh temp names via
  `ctx.func.uniq++`; moving that allocation earlier than today's
  emission-time point reorders it against every OTHER `ctx.func.uniq`
  consumer in the enclosing function (loop transforms, literal-promotion
  passes, every preceding statement's own emission-time temps) — a REAL
  output change (different generated local names) for any program with a
  destructured-param closure, which the byte-identity gate this item ships
  under forbids. Confirmed by direct reasoning about `ctx.func.uniq`'s ~40
  call sites across prepare/compile/emit, not just asserted.
- **Key the plan on `rawParams` instead of `body`, for the destructured case
  only** — CHOSEN. `rawParams` is untouched by the destructuring-prepend
  rewrite (only `body` is reassigned); the generic AST dispatcher passes
  handler arguments via a shallow `node.slice(1)`, so the handler's
  `rawParams` local is the SAME reference the mint saw. `ctx.closure.make`
  tries the body key first (the common case), then `rawParams` as a
  fallback. The mint's own free-var scan for this case additionally excludes
  every param's bound names — plain AND destructured (a small local
  `collectPatternNames`, mirroring prepare/lift-iife.js's private helper of
  the same name and shape) — from the capture scan, matching what the
  post-rewrite body's synthesized `let` destructure statement would have
  taught `findFreeVars` had the rewrite already happened.

**Correctness spot-check** (destructured closures, direct execution, not
just byte-diff): a `.forEach(({a, b}) => { sum += a + b })` accumulator (36,
matches hand-computed expectation) and a destructured param with a default
value plus a second call site overriding it (96, matches). Both also clean
under `JZ_DEBUG_INVARIANTS=1` (0 `ClosureEnvPlan drift` fires).

### Coverage report

Measured independently this session (methodology: `globalThis.__ITEM4_
CENSUS`-gated counters at `ctx.closure.make`'s plan lookup and at the mint's
key-type-miss branch — temporary, reverted before commit, same technique the
original survey in §0 of this document used and discarded the same way):

| corpus | mint-covered / total closures | % | miss: primitive-body key | miss: other/unreached |
|---|---|---|---|---|
| self.js (build-dist.mjs's own `resolveSelfhostBuild()` options) | 4003 / 4417 | 90.6% | 27 | 387 |
| bench (57/58 cases — `watr` excluded from THIS particular measurement pass only, a script gap in the module-loading shim, not a coverage gap; `jessie`/`jz` excluded per precedent) | 11 / 19 | 57.9% | 0 | 8 |

**self.js**: up from the AS-LANDED slice-2 census's 3872/4404 (88.0%) — a
real, modest gain (+131 net covered, uncovered population 532→414) primarily
attributable to destructured-param closures now minting. Total-closure count
(4417 vs 4404) is close enough to be ordinary source drift between sessions
(self.js's own module graph grows commit-to-commit — the design doc's own
§6 item 5 already established this is expected, not a measurement bug).

**bench**: total-closures-created (19, this session, at `ctx.closure.make`)
does NOT reconcile with the AS-LANDED slice-2 census's own bench total (174,
same instrumentation point, same corpus, same compile config —
`bench-size.mjs`'s `optimize:'size', alloc:false`). NOT reconciled this
session (flagged, not silently smoothed over, per this document's own
established practice for the 371-vs-626 and 148-vs-161 discrepancies above).
Spot-checked individually: every closure-bearing bench case this session's
census found (bezfit, delayline, deltae, dispatch, glyfparse, nbody,
provenance, resample, sdf, slices, spmv, trace — 12 cases, matching names
against §5.2's own list almost exactly) reproduces a plausible, individually-
verified count (1 closure each, except `dispatch`'s 8 — an array-indexed
closure table, 0/8 mint-covered, a genuine `other/unreached` case: PLAUSIBLY
built by a shape (populated by NAME reference to already-let-bound closures,
or a runtime-constructed table) the walker's structural pattern-matching
doesn't reach, not investigated further this session — the mint's fail-open
guarantee means this is a lost optimization opportunity, not a correctness
risk). Most likely explanation for the 174-vs-19 gap: the prior session's
`__CEP_SURVEY` counters (this document's own §0) were NOT re-run this
session to cross-check — a live re-measurement was not attempted, so a
counter-placement or corpus-config drift between the two sessions' harnesses
cannot be ruled out. The self.js number's close agreement with precedent
argues the MECHANISM (this session's instrumentation) is sound; the bench
discrepancy is the OPEN QUESTION.

**`dispatch`'s 0/8** and self.js's 387 `other/unreached` are the FULL
enumerated fail-open remainder by shape, on this measurement: (1) an arrow
whose ENTIRE body is a bare expression collapsing to a primitive AST node
(string/number, e.g. `x => x`) — WeakMap requires an object key, 27 self.js
instances, 0 bench; (2) closures reached by `ctx.closure.make` whose
enclosing form the mint's `walk()` never visits or whose free-var scan this
session did not further classify — 387 self.js instances, 8 bench (all in
`dispatch`). Both remainders fail OPEN (verified: 0 `JZ_DEBUG_INVARIANTS`
`ClosureEnvPlan drift` fires anywhere in the full battery run below), never
silently wrong.

### Gate ladder (two isolated worktrees: `0edcddea` item-4 and `9d0e3384`
### its immediate parent on main — NOT `975ada70`/item-3, which predates an
### unrelated concurrent collection-fix commit that also landed on main
### mid-session and would have produced false byte-diffs against an older
### baseline; caught and corrected before drawing any conclusion)

| check | result |
|---|---|
| 58-case × O0/O2/O3 byte-identity sweep (jessie/jz excluded, 174 compiles) | 174/174 byte-identical vs. immediate-parent baseline |
| `node test/kernel-parity.js` | 3/3 groups, 33/33 assertions, byte-identical WAT at O0/O2/O3 |
| `node test/closures.js` under `JZ_DEBUG_INVARIANTS=1`, `JZ_TEST_OPTIMIZE=3` | 110/110 (221 assertions), 0 `ClosureEnvPlan drift` fires |
| `node scripts/battery.mjs` (incl. `dbg`) | GREEN except the one pre-existing, already-documented flake ("typed RMW: one guard covers…", fired on all 5 of native/O0/O3/dbg/wasi this run — same single-test signature as items 2 and 3's battery runs); fixpoint PASS; fuzz 30173 compared, 0 divergence; self 21/21 (206 assertions); kernel 2716 pass; build succeeded |
| `JZ_TEST_TARGET=jz.wasm node test/index.js` (test:wasm) | 2716/2722 pass, 6 skip, 0 fail |
| `node scripts/build-dist.mjs` ×2 | byte-identical (`eefd3c66…`) |

**Commits**: `0edcddea` (src/ctx.js, src/compile/closure-plan.js,
src/compile/emit.js, module/function.js) + this entry + `.work/todo.md`'s
matching append.
