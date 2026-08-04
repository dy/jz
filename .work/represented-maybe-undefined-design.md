# Represented maybeUndefined + presentKind — design (audit #9)

Read-only deliverable, companion to the audit-#9 P0-1 disable (.work/todo.md
"audit-#9 P0-1 closed", src/kind.js's dictValueKindOf/mapValueKindOf/
censusMaybeUndefinedKind now dormant, lines 269-332). States the fact the
census's read-side consumers actually need and were never given, so a future
agent can land it instead of re-wiring the same unsound shortcut a fourth
time (audit-#7 revert f8f61591 → Slice 4 re-enable → audit-#9 revert).

## 1. What's broken, restated precisely

`censusMaybeUndefinedKind` (kind.js, now `(node) => null`) recognized exactly
one AST shape: a bracket/dot dict READ or a `.get()` Map CALL node, checked
**at the point where the arithmetic/ToString/equality op consumes it**. That
is a property of the SYNTAX at the consumption site, not a property of the
VALUE. Two consequences, both verified live at HEAD before the disable:

- **Decl propagation loses it.** `let x = m.get('missing'); return x + 1`
  compiled `x` through the ordinary `let` path (analyze.js
  `analyzeValTypes`, ~line 1453): `x`'s rep gets `val = mapValueKindOf(...)`
  — the CLAIMED kind — with no accompanying "but this claim's proof is
  read-site-only" flag. Every later use of `x` sees a plain, unconditionally
  trusted NUMBER/STRING/BIGINT rep, identical to a genuinely proven local.
- **The chokepoint list is enumerated, not derived.** Only sites that
  explicitly call `censusMaybeUndefined`/`censusMaybeUndefinedKind` were
  protected: ir.js `toNumF64` (:1011) and `toStrI64` (:1170), emit.js
  `nullableOperand` (:2481→:2499 before the disable) and `bigIntOperand`/
  `bigIntUnary` (:4142/:4188), module/string.js `String()` (:2054),
  module/number.js `isNaN` (:1318), module/console.js `writePart` (:177/180).
  Two arithmetic sites were NEVER added to that list and diverged from JS
  even with the census's own soundness carve-out fully wired: emit.js's `+`
  STRING-concat fast path (:4741, `vtA === VAL.STRING && vtB === VAL.STRING`
  — no censusMaybeUndefined guard at all) and `bigintMixReject` (:4101, pure
  `valTypeOf(a) === VAL.BIGINT` compile-time literal check). This is exactly
  the audit's "whack-a-mole chokepoint list" finding — MECHANISM A in
  .work/carrier-invariant-design.md is the same shape of bug (an
  enumerated-list of sites reimplementing a guard instead of one function
  every site is forced through).

The fix the audit demands is a REPRESENTED fact — carried BY THE REP, not
re-derived from AST shape — so it survives exactly like `val` itself does:
through `let`, through a call argument, through a `return`, through a
closure capture, through the export boundary.

## 2. Where the fact lives

Reuse the REP_FIELDS lattice (src/reps.js:42+) — this is precisely the
mechanism `nullable` (reps.js:81-83) and `bigintBoxed` (reps.js:84-92)
already use for structurally identical problems:

- `nullable` is already a **propagated boolean fact about a binding**,
  independent of the binding's own `val` kind, consulted at the identity-fold
  chokepoint (emit.js strictSentinel) exactly where a wrongly-confident
  `val` would miscompile `x === null`. narrow.js's BIGINT-nullable
  re-derivation (:2242-2295) is the existing PROOF that a REP boolean can be
  soundly propagated through the whole-program call-site fixpoint
  (`mayBeNullish` walking call args + `bodyNameNullable` walking the callee
  body's own writes) — not just inferred once at declaration.
- `bigintBoxed` (reps.js:84-92, producers: analyze.js `markBigintSink`
  :650-654 walking a fixed W-sink list including Set/Map/dyn-prop-store
  :788-827, narrow.js's inter-function half :2299-2362) is the existing
  PROOF that a REP boolean can gate REPRESENTATION choice (box vs raw
  carrier) at the point of WRITE, propagated to every later READ of the same
  binding via ir.js boxBigInt/unboxBigInt.

**Proposal**: add two REP_FIELDS entries, both booleans (not a nested
object — matches the existing `nullable`/`bigintBoxed` shape, keeps
updateRep's merge lattice flat):

```
@property {boolean} [mayBeUndefined]  binding's value can be real JS
  `undefined` at runtime despite a definite `val` kind claim — the container-
  read generalization of `nullable`. Producer: any assignment/param-bind
  whose RHS is a dict/Map read soundness-carve-out (dictValueKindOf/
  mapValueKindOf's read site, when re-enabled) OR whose RHS is itself
  mayBeUndefined (propagates like nullable does). Consumer: every existing
  censusMaybeUndefined chokepoint, now asking `repOf(name)?.mayBeUndefined`
  for a bare name in addition to the direct-node AST shape.
@property {boolean} [presentKindUnboxed]  `val` is a BIGINT claim whose
  storage representation is a raw i64-as-f64 reinterpretation (no NaN-box
  tag) rather than a genuine heap box (bigintBoxed) or a statically-uniform
  ABI (proven-BIGINT export/param) — set at the SAME W-sink producer sites
  bigintBoxed already walks, the inverse of bigintBoxed firing. Consumer:
  synthesizeBoundaryWrappers' resultBigint/resultDynamic split
  (compile/index.js :1595-1601) and any generic dynamic-value consumption —
  see §6.
```

`mayBeUndefined` is the direct fix for the 4 mayBeUndefined-shaped repros
(1-4). `presentKindUnboxed` is the direct fix for repro 5 and the
present-key BigInt-unary regression this disable surfaced in
test/dyn-keys.js (see that file's "KNOWN-FAIL" comments on the two adapted
tests) — see §6 for why it's a distinct axis from `mayBeUndefined`, not a
special case of it.

## 3. Propagation

**Decl inference** (analyze.js `analyzeValTypes` ~:1453, the `updateRep`
call sites that set `val` from a RHS `valTypeOf`): every RHS-kind assignment
already re-derives `val`; extend the SAME call to also copy
`mayBeUndefined`/`presentKindUnboxed` from the RHS's own rep (name) or from
`censusMaybeUndefinedKind(rhs) != null` (inline read). This is a pure
ADDITION to an existing write path, not a new walk — the same discipline
`nullable`'s own decl-time seeding already follows.

**Param lattice** (narrow.js `inferValAtSite` :1556, the `runCallsiteLattice`
`val`-merge fold, and `hardParamVal` :1611): `mayBeUndefined` needs the SAME
treatment narrow.js already gives BIGINT-nullable (:2242-2295) —
`mayBeNullish`'s existing structural walk already answers "can this call-site
ARGUMENT be nullish", which is a superset check for "is it a maybeUndefined
container read" (a dict/map absent-key read node passed as a call arg
qualifies as mayBeNullish's `undefined`-literal-equivalent case once
`mayBeNullish` is taught to recognize `censusMaybeUndefinedKind(arg) != null`
as itself nullish-producing, not just literal `undefined`/`null`). No new
fixpoint machinery — one more producer feeding the existing nullable
propagation.

**Return kinds** (`func.valResult` via `narrowValResults`, narrow.js:652, and
`closureBodyReturnKind` for value-bound arrows, flow-types.js:485-493): both
already compute a single joined `val` kind across every return site
(`kindOf(sites[i]) !== kind0` poisons on disagreement). Extend the join to
carry `mayBeUndefined` as an OR across sites (any return site that may be
undefined makes the whole function's result maybeUndefined) exactly the way
`dictValueValType`'s own write-census already ORs/poisons across write
sites (program-facts.js `writeVT`).

**Closure captures**: `markBigintCapture` (analyze.js :655-667) already
walks a nested `=>` for the bigintBoxed W-sink; the identical walk, run for
`mayBeUndefined`, marks a captured maybeUndefined binding so the closure's
OWN body doesn't re-trust it as definite.

**Export-kind table** (compile/index.js `synthesizeBoundaryWrappers`
:1583-1701, the `jz:i64exp` custom section, interop.js :667/:822): this is
where `presentKindUnboxed` actually pays for itself — see §6, it's a
DIFFERENT boundary than mayBeUndefined's.

## 4. Consumption — chokepoint rewrite list

Every site below currently asks `censusMaybeUndefined(node)`/
`censusMaybeUndefinedKind(node)` (AST-shape only, now permanently `false`/
`null`). Each becomes `censusMaybeUndefined(node) || (typeof node === 'string'
&& repOf(node)?.mayBeUndefined)` (or the`Kind` twin consulting
`repOf(node)?.val` alongside `.mayBeUndefined`) — i.e. re-enable the DIRECT
AST-shape recognizer (kind.js dictValueKindOf/mapValueKindOf, unchanged
logic) AND add the REP fallback for a bare name:

- ir.js :1011 `toNumF64`, :1170 `toStrI64`
- emit.js :2499 `nullableOperand` (dict/Map identity-fold carve-out)
- emit.js :4158/:4196 `bigIntOperand`/`bigIntUnary` (also need `presentKind`
  is BIGINT alongside mayBeUndefined — these already switch on
  `censusMaybeUndefinedKind(node) !== VAL.BIGINT`, so the rewrite is
  `(censusMaybeUndefinedKind(node) ?? (repOf(node)?.mayBeUndefined ?
    repOf(node)?.val : null)) !== VAL.BIGINT`)
- emit.js :4101 `bigintMixReject` — NEWLY added to the list (never was
  before): the literal-mix compile-time check must also treat a
  `mayBeUndefined`-flagged BIGINT-claimed operand as "not provably BIGINT"
  so it takes the permissive fallback instead of rejecting
- emit.js :4741 `+` STRING-concat fast path — NEWLY added: gate
  `vtA === VAL.STRING && vtB === VAL.STRING` on `!mayBeUndefined` for
  either operand
- module/string.js :2054 `String()`, module/number.js :1318 `isNaN`,
  module/console.js :177/180 `writePart` — same rewrite, no shape change

**A structural note, not a new mechanism**: this list should stop being a
hand-maintained enumeration once `mayBeUndefined` is a REP field — every
site above ALREADY calls `censusMaybeUndefined`/`Kind`; making those two
functions REP-aware fixes every existing call site in one change, and the
`bigintMixReject`/`+`-concat gaps get closed by ADDING those two calls, not
by inventing a new predicate. The list stays finite and auditable (unlike
MECHANISM A's 16 hand-reimplemented copies in carrier-invariant-design.md)
because there is exactly one predicate function, not one per site.

## 5. Re-enablement criteria for dictValueKindOf/mapValueKindOf

Before VT['[]']/VT['.']/VT['()'] (kind.js) resume claiming an exact kind for
a dict/Map value read:

1. `mayBeUndefined` REP field lands (§2) with decl/param/return/closure
   propagation (§3) — verified by a differential test where the census
   claim reaches a NON-chokepoint consumer only through 2+ hops (decl → arg
   → return → use), not just the single-hop repros this audit pinned.
2. Every consumption chokepoint in §4 is rewritten to consult the REP field,
   including the two NEWLY-identified gaps (`bigintMixReject`, `+`
   STRING-concat) — a grep for `valTypeOf(.*) === VAL\.` / `vt.*===.*VAL\.`
   in emit.js/ir.js/module/*.js touching a name that could be a
   maybeUndefined-flagged container read is the audit surface; every hit is
   either already gated or is the NEXT gap.
3. test/dyn-keys.js's audit-P0 + audit-#9 pins all still assert JS-correct
   values (not just "doesn't crash") — including the decl-propagation shape
   this audit's repro 1 added, which does not exist as a pin anywhere at
   HEAD today and must be added before re-enabling, not just once
   re-enabled.
4. Full battery + kernel-parity/oracle + perf-ratchet + fuzz all green (same
   gate list this disable ran) — this audit's own gate run found this
   disable cost ZERO measured perf/size (perf-ratchet 10/10 at +0 delta
   every category, size-sweep geomean unchanged at 1.055) — a re-enable that
   regresses either needs its OWN justification, not an assumption that the
   original Slice 1-4 win reappears unchanged.

## 6. Connections — this is not an isolated container-read bug

**The decl-init wall** (.work/carrier-invariant-design.md): a structurally
IDENTICAL symptom — "a fact about a value evaporates the moment it's bound
to a `let`" — from a DIFFERENT root mechanism (ptrKind/ptrAux/closureFuncIdx
metadata erased by `typed()` rebuilding IR through `asF64`/`boxPtrIR`,
carrier-invariant-design.md "DECL-INIT WALL ROOT-CAUSED"). Both bugs are
instances of the same architectural gap: a fact that lives OUTSIDE the
value's own runtime bit-representation (a NaN-box tag, an i64 payload) does
not survive re-emission through a generic IR node unless something
EXPLICITLY re-attaches it. carrier-invariant's fix direction is per-site
metadata preservation in `typed()`'s callers; this design's fix direction is
a REP field that re-derives itself at every decl/param/return hop instead of
trying to preserve metadata through IR rebuilding — different mechanisms,
same disease. A future unification (one "represented fact propagation"
pass computing both `nullable`/`mayBeUndefined`/`ptrKind`-preservation
together) is out of scope here but worth naming so the next audit doesn't
re-discover the parallel from scratch.

**The BigInt export boundary** (repro 5, and the present-key BigInt-unary
regression this disable's test/dyn-keys.js adaptation pinned as
KNOWN-FAIL): confirmed via a temporary worktree at HEAD (cc78bf56, census
ON) that this is PRE-EXISTING, not caused by the disable —
`m.set('x', 5n); return m.get('x')` already returned `2.5e-323` instead of
`5n` before this audit touched anything, and test/dyn-keys.js's own
pre-existing comment (line ~344, citing commit a919446a) already named it
"a SEPARATE, PRE-EXISTING bug". Root: `synthesizeBoundaryWrappers`
(compile/index.js :1595-1601) has exactly two i64-carrying export lanes —
`resultBigint` (`func.valResult === VAL.BIGINT`, i64 crosses UNCHANGED, no
reinterpret — "the BigInt *is* the value") and `resultDynamic` (unproven
result, i64-reinterpreted-FROM-f64, decoded JS-side as a NaN-boxed dynamic
value). A dict/Map/array value that is ACTUALLY a BigInt at runtime but
lacks a static `val === VAL.BIGINT` proof takes the `resultDynamic` lane —
but the raw i64 bit pattern sitting in that container slot (confirmed via
direct bit-math: `5n` reinterpreted as f64 ≈ `2.47e-323`, exactly the
observed wrong value) was NEVER given a NaN-box tag in the first place
(reps.js `bigintBoxed`'s heap-box mechanism exists for exactly this
representation gap but, empirically, does not currently fire for a bigint
value flowing into `Map.set()`/dict-write even when bound to a named local
whose rep should qualify per analyze.js's own W-sink list — a SEPARATE,
narrower bug in the bigintBoxed producer/consumer wiring, not diagnosed
further here). `presentKindUnboxed` (§2) is the fact that lets
`synthesizeBoundaryWrappers` (and any other generic dynamic-value consumer)
know to route such a value through `resultBigint`'s lane — or, if the
bigintBoxed wiring gap gets fixed first, makes `presentKindUnboxed` false
by construction (a properly-boxed dynamic BigInt IS self-describing, no
static fact needed) and this whole axis collapses into "just works",
leaving `mayBeUndefined` as the only fact this design still needs. Either
fix order is valid; they are independent work items sharing one symptom
family.

## 7. Self-host risk

`mayBeUndefined`/`presentKindUnboxed` are pure REP_FIELDS additions (like
`nullable`/`bigintBoxed`) — no new AST node, no new WASM instruction, no
change to the self-hosted kernel's OWN compiled shape beyond whatever the
kernel's compilation of kind.js/analyze.js/narrow.js/reps.js itself produces
differently once source changes. Same self-host risk class as any other REP
field addition: verify via kernel-parity (byte-identical native vs kernel
WAT on the `dict`/CORPUS rows) and selfhost.js (kernel-compiles-itself
round-trip) before landing — no new risk class introduced.

## 8. Ordered slices for landing agents

1. **REP_FIELDS + decl-time producer** (§2, §3 decl inference only). Land
   `mayBeUndefined` alone first (smaller surface than pairing with
   `presentKindUnboxed`) — re-enable ONLY the direct-node chokepoint
   recognizer plus the REP fallback for a bare name one hop away (`let x =
   read; x + 1`), pin exactly that shape. Gate: dyn-keys.js decl-propagation
   pin (new) + full battery.
2. **Param/return/closure propagation** (§3 remaining). Extend to 2+-hop
   shapes (arg passing, return, capture). Gate: differential fuzz targeting
   dict/Map absent-key values threaded through each hop kind.
3. **Chokepoint sweep completion** (§4's two NEW gaps — bigintMixReject,
   `+` concat). These are real, currently-live miscompiles independent of
   whether dictValueKindOf/mapValueKindOf ever get re-enabled (they only
   fire once a maybeUndefined value legitimately reaches BIGINT/STRING
   claims some OTHER way — e.g. a future re-enable, or any other exact-kind
   producer this design doesn't cover yet) — worth closing even if
   Slices 1-2 stall.
4. **Re-enable dictValueKindOf/mapValueKindOf** (§5 criteria all met).
5. **presentKindUnboxed + BigInt boundary** (§6) — separable, can land
   before or after 1-4; investigate the bigintBoxed producer/consumer wiring
   gap first (cheaper fix if it closes the representation hole outright).

Each slice: full battery (test/index.js, chunks of 4-7, foreground), kernel-
parity 33/33, kernel-oracle, perf-ratchet (per-category delta justified or
zero), fuzz 2000×4, selfhost.js 21/21, fresh build ×2 byte-identical, size
sweep vs 1.055 baseline — same gate list this disable ran, per slice, not
batched at the end.

## 9. Slice 1 — as landed, honest boundary correction

Landed: `mayBeUndefined` REP_FIELD (reps.js), decl+reassign producer
(analyze.js `analyzeValTypes`, the same `let`/`const`/`=` call sites that
already seed `nullable` — a new `mayBeUndefinedRhs` helper, deliberately NOT
folded into `mayBeNullish`'s full ternary/&&/||/`,` walk per this slice's own
"smaller surface" instruction), and `censusMaybeUndefinedKind`'s two ORIGINAL
direct-node arms (dict `[]`/`.` read, Map `.get()` call — `dictValueKindOf`/
`mapValueKindOf`/`dictCensusReceiverIsLive` restored verbatim from before the
audit-#9 revert) PLUS the new third arm, a bare NAME whose rep carries both
`mayBeUndefined` and `val`. `dictValueKindOf`/`mapValueKindOf` are restored as
**censusMaybeUndefinedKind-only helpers** — NOT re-wired into VT['[]']/
VT['.']/VT['()']'s own exact-kind fold, which stays dormant exactly as §5
requires (re-enabling that is still Slice 4, gated on §5's full criteria,
none of which this slice attempts to satisfy alone).

**Correction to this doc's own Slice 1 description** (§8, "pin exactly that
shape" / "Gate: dyn-keys.js decl-propagation pin (new)"): landing this
confirmed a fact the original write-up didn't call out — Slice 1 is
representationally complete but **behaviorally INERT** at both the JS-value
level and the WAT-codegen-shape level. Every existing censusMaybeUndefined
consumer (ir.js toNumF64 :997-1011, toStrI64 :1170; emit.js's
strictSentinel/aSafe/bSafe callers of nullableOperand; bigIntOperand/
bigIntUnary; module/string.js/number.js/console.js) gates its OWN call to
`censusMaybeUndefined`/`Kind` behind `valTypeOf(node) === VAL.SOMETHING`
(or `vtX === VAL.NUMBER`) FIRST — and `valTypeOf` for a dict/Map read stays
null for as long as VT['[]']/VT['.']/VT['()'] stay dormant (Slice 4, not this
slice). So the direct-node arms are reachable-and-correct but never actually
consulted by any real compile yet; the REP-fallback arm's precondition
(`repOf(name)?.val` truthy) is likewise never met today, because the decl
producer only copies `mayBeUndefined` ALONGSIDE whatever `val` the ordinary
`setVal`/`valTypeOf` path derives (§3's own wording — "extend the SAME call")
and that path stays null for this RHS shape too, for the identical reason.
Empirically verified: the audit-#9 5-repro table (.work/todo.md "audit-#9
P0-1 closed") returns byte-for-byte the same values before and after this
slice — repros 1-4 pass (unchanged, still via the generic dynamic path, NOT
via any new mechanism this slice added), repro 5 and the present-key
BigInt-unary KNOWN-FAIL pins (test/dyn-keys.js) are unaffected (presentKind
axis, §6, out of scope for mayBeUndefined entirely).

Consequently the acceptance pin could not live in test/dyn-keys.js as a
black-box `run()`/`jz()` value assertion — there is nothing observable there
yet. It landed instead in test/types.js as a pure-analysis harness
(`runAnalyzeMayBeUndefined`, importing `analyzeValTypes`/`repOf` directly),
mirroring that file's own established precedent for exactly this situation
("intCertain lattice — pure analysis, no codegen impact. Pins the
forward-propagation rule against AST inputs", test/types.js ~line 984) —
proving the FACT now computes and propagates correctly (decl inline-read,
reassignment, one-hop bare-name copy-through, and the REP-fallback arm's
both-fields-required guard, as its own isolated unit) ahead of the slice that
makes it load-bearing. This is not a downgrade of the gate — repro-first
still holds, "repro" just had to mean "the mechanism produces the fact"
rather than "the fact changes a return value", because for THIS slice those
are honestly the same claim once VT['[]'] et al. are confirmed still dormant.

Gates run (post-slice, fresh dist rebuild): full 88-file battery in 13
foreground chunks of ≤7, kernel-parity 33/33 byte-identical (O0/O2/O3, both
pre- and post-rebuild), kernel-oracle 11/11, perf-ratchet 10/10 at +0 delta
every category (int/float/mixed/cond/buf/nest/slice/ring/condref/fgather —
expected: the fields are dormant, see above), optimizer 214/214, dyn-keys.js/
data.js/inference.js run explicitly (all green, repro table unchanged),
selfhost.js 21/21 (pre- and post-rebuild), fresh build ×2 byte-identical
(jz.js/jz.wasm/interop.js), size sweep geomean 1.0550 (unchanged from the
1.055 baseline), fuzz 2000×4 (`node test/fuzz.js --count=2000`) zero
divergence.

**Slice 2 deliberately not taken in the same pass**: per this doc's own §8,
Slice 2 is its own significant surface (narrow.js's whole-program call-site
fixpoint — `mayBeNullish`'s inter-procedural half, `hardParamVal`,
`narrowValResults`, `closureBodyReturnKind` — the same machinery
BIGINT-nullable's own inter-function half required, :2242-2362), not a small
extension of Slice 1's decl-only surface, and it inherits the identical
"inert until Slice 4" property for the identical reason (no VT consumer to
make a param/return/closure-propagated fact load-bearing yet) — landing it
in the same pass would not have bought a second observable repro either,
only a second unit of unverifiable-by-black-box plumbing. Honest boundary:
stopped after Slice 1.

## 10. Slice 2 — as landed, honest boundary correction

Landed: whole-program propagation for `mayBeUndefined` through params,
returns, and closure captures — the §3 machinery §9 deferred.

**The shared predicate** (kind.js, DRY per §4's own "one predicate function"
instruction): `censusShapedNode(node)` factors OUT `censusMaybeUndefinedKind`'s
arms 1/2 AST-shape test (dict `[]`/`.` read, Map `.get()` call) with NO ctx
lookup — `censusMaybeUndefinedKind` itself now calls it internally
(behavior-preserving refactor, verified by the existing Slice 1 test suite
staying green unchanged). `nameMayBeUndefinedInBody(bodyRoot, name)` walks a
raw AST body's own `let`/`const`/`=` writes for `name`, cycle-guarded,
answering true iff some write is `censusShapedNode`-shaped or copies through
a bare name that already traces to one — WeakMap-cached per `bodyRoot`.
`exprMayBeUndefinedIn(expr, bodyRoot)` composes both: direct shape or
bare-name trace. All three are ctx-INDEPENDENT by construction — required
because every Slice 2 join site runs at a point where the queried function's
own `ctx.func.localReps`/`ctx.types.nameEscapes` aren't installed (narrow.js's
whole-program fixpoint runs before per-function emission; a closure's
`ctx.closure.make` runs at the closure literal's creation site, before that
closure body itself has compiled) — the same caveat narrow.js's own
`bodyNameNullable` documents for why it re-derives `mayBeNullish` structurally
instead of trusting a rep lookup. `censusShapedNode` is a conservative
OVER-approximation of the real (ctx-aware) census — sound because every
consumer below only ever asks it to decide `mayBeUndefined = true`, never to
claim an exact kind.

**Params** (narrow.js `narrowSignatures`, alongside the existing BIGINT-boxed
call-site fold): fail-closed on a destructured param body
(`isDestructuredParamBody`, reused verbatim from `bigintBoxedVerdict` — no
per-call-site proof mechanism exists for what a destructured element holds);
otherwise OR-joined across every live call site via `exprMayBeUndefinedIn`.
Deliberately NOT built on `mayBeNullish`/`bodyNameNullable` (the BIGINT-
nullable block's own machinery) — `mayBeNullish` already fails closed for ANY
call/property read, which would flag `mayBeUndefined` on nearly every param
in the program; wrong breadth for a fact whose whole point is staying tied to
dict/Map absent-key provenance. An unwritten bare-name arg (a caller
param/global/capture forwarded straight through) resolves false — narrower
than `nullable`'s blanket "unwritten → fail closed", matching the decl
producer's (Slice 1) own honest default for an ordinary RHS. Seeded onto the
callee's real `ctx.func.localReps` at `compile/index.js`'s per-function param
loop (`analyzeFuncForEmit`), unconditionally (no `!reassigned` guard, unlike
`val`/`recvArrTyped` — this is a monotonic safe-direction fact like
`nullable`, never an exact-kind claim a stale seed could make wrong).

**Returns**: `narrowValResults` (narrow.js) ORs `exprMayBeUndefinedIn` across
the same return-tail exprs its `allSame` fold already unifies, setting
`func.valResultMayBeUndefined` alongside `func.valResult`.
`closureBodyReturnMayBeUndefined` (flow-types.js) is `closureBodyReturnKind`'s
sibling — same return-tail sites (factored into a shared `closureReturnSites`
helper), OR-folded instead of unified — stored in its own
`ctx.closure.valResultMayBeUndefined` Map (module/function.js), parallel to
`ctx.closure.valResult`, NOT merged into that Map's value shape: `valResult`/
`closureBodyReturnKind` return a bare `VAL.*` string with a live consumer
(kind-traits.js `calleeValType`) this slice must not disturb.

**Closure captures** (module/function.js `ctx.closure.make`): `repOf(name)
?.mayBeUndefined` joins the SAME `envCaptures` loop that already builds
`captureNullables` — a direct sibling, not a new walk. Seeded into the
closure body's own reps at `compile/index.js emitClosureBody`
(`cb.mayBeUndefineds`), mirroring `cb.nullables` exactly.

**A real bug found and fixed during this slice**: `nameMayBeUndefinedInBody`'s
WeakMap cache threw `TypeError: Invalid value used as weak map key` the first
time `closureBodyReturnMayBeUndefined` ran against a real expression-bodied
arrow (`() => x` lowers to a bare-STRING body in some arrow shapes, not an
array) — WeakMap keys must be objects. Fixed with an `Array.isArray(bodyRoot)`
guard (a non-array body can't contain a `let`/`=` write to walk anyway, so
"no trace" is the correct answer, not a crash). Caught by exercising the
mechanism through a real `compile()` call during test-writing, not by the
unit tests alone — the unit tests were extended with a regression pin for
exactly this shape.

**Honest boundary — still inert, program-wide, not slice-specific**: like
Slice 1, nothing in Slice 2 changes a compiled byte or a JS-observable value.
Unlike Slice 1 (where the reason was purely "no VT consumer yet"), Slice 2's
inertness is a program-wide INVARIANT that holds at every hop: a census-
shaped read's `val` never settles non-null — not at the read itself
(dormant VT), not at a decl that copies it (Slice 1's own finding), not as a
call-site ARGUMENT (a census-shaped arg contributes null to `hardParamVal`'s
fold, poisoning specialization rather than claiming a kind), and — newly
verified this slice — not as a RETURN value either (`bodyFacts.valTypes`,
`narrowValResults`' own kind resolver, poisons a bare-name return the
identical way once any of its writes is unresolvable). So a param/return
`val` this design's `mayBeUndefined` would ride alongside stays unproven
right along with it, at every hop, until Slice 4.

Two of Slice 2's three join sites are nonetheless independently, DIRECTLY
provable live — proven by not depending on that same `val` chain at all:

- **Param propagation** IS observably live: `paramReps[fname][k].mayBeUndefined`
  sets unconditionally (no `val` gate), reaches `ctx.func.localReps` via the
  compile/index.js seed, and surfaces through the existing `ctx.inspect`
  sink (`compile(src, {inspect:true}).inspect.functions[name].params[k]
  .mayBeUndefined` / `.callerReps[k].mayBeUndefined`) — verified with a real
  `useIt(y)` call site where `y`'s decl traces to a census read.
- **Closure captures** ARE observably live: `ctx.closure.bodies` entries
  carry `mayBeUndefineds` whenever a captured outer binding was flagged —
  verified directly against real compiled closures.
- **`closureBodyReturnMayBeUndefined` is independently live** too, and
  provably ORTHOGONAL to `closureBodyReturnKind`'s own resolution: unlike
  `narrowValResults`, `closureBodyReturnKind`/`closureBodyReturnMayBeUndefined`
  resolve a bare-name return through the EXTERNALLY-SUPPLIED `capturedKinds`
  map (the real caller's proven capture kinds), not through the body's own
  internal value tracker — so a closure whose captured name's kind is proven
  from OUTSIDE while its OWN local (re)declaration still traces to a census
  read demonstrates both facts firing simultaneously, independently. Pinned
  directly (test/types.js), calling the exported `(body, capturedKinds)`
  functions with a hand-resolved local name — no black-box repro needed
  because there's a live, testable divergence to pin.
- **`narrowValResults`' own OR-join is the one join site that stays
  unreachable in practice** (not by construction — empirically, every shape
  tried): the SAME body evidence a return's bare name would need to both (a)
  settle a definite `vt0`/`allSame` kind AND (b) trace to a census read is
  read by two different mechanisms (`bodyFacts.valTypes` vs.
  `exprMayBeUndefinedIn`'s raw-AST walk) that happen to poison identically —
  whenever (b) would be true for a return site, (a) already failed for the
  same site, so the two conditions never co-occur. The OR-fold itself is
  landed and correct (mirrors the `exprs.every(...)` fold it rides beside
  line-for-line); pinned as a negative control (an ordinary settled return
  never sets `valResultMayBeUndefined`) so a future change to
  `bodyFacts.valTypes`' settling rule that DOES make this co-occur doesn't
  silently ship unpinned.

**Test harness** (test/types.js, continuing Slice 1's pure-analysis
precedent): unit tests for `censusShapedNode`/`nameMayBeUndefinedInBody`/
`exprMayBeUndefinedIn` against hand-built AST fragments (including the
WeakMap-crash regression); `compile(src, {inspect:true})` positive/negative
pairs for param propagation; direct `closureBodyReturnKind`/
`closureBodyReturnMayBeUndefined` calls (parse+prepare harness, no full
compile needed — both are pure `(body, capturedKinds)` functions) for the
return-kind join, including the orthogonality pin; `ctx.closure.bodies`
inspection positive/negative pairs for closure captures; a negative-control
pin for `narrowValResults`' own join.

Gates run (post-slice, fresh dist rebuild): full 88-file battery in 13
foreground chunks of ≤7, kernel-parity 33/33 byte-identical, kernel-oracle
11/11, perf-ratchet 10/10 at +0 delta every category, optimizer 214/214,
dyn-keys.js/inference.js/never-grown.js/simd.js run explicitly (all green),
selfhost.js 21/21 (pre- and post-rebuild), fresh build ×2 byte-identical
(jz.js/jz.wasm/interop.js), size sweep geomean 1.0550 (unchanged from the
1.055 baseline — `scripts/bench-size.mjs --json`, 49 cases with both a jz and
an AS byte count), fuzz 2000×4 (`node test/fuzz.js --count=2000`, four
separate runs) zero divergence.

Slice 3 (§8's chokepoint-sweep gaps, `bigintMixReject`/`+`-concat) and Slice 4
(VT re-enablement) remain unstarted — both still gated on §5's full criteria,
untouched by this slice.

## 11. Slice 3 — as landed, honest boundary correction

Landed: §8 point 3's two named gaps — `bigintMixReject` (emit.js) and the `+`
STRING-concat fast path (both the raw-concat branch and its `coercionFree`
sibling) now consult `censusMaybeUndefined` alongside their existing
`valTypeOf` checks, exactly as §4 prescribes: a BIGINT/STRING claim whose
only proof is a maybeUndefined-flagged census read (direct node or a bare
name that copies one through) is treated as unproven — `bigintMixReject`
falls through to its permissive default instead of wrongly rejecting a mix
that's sound whenever the operand turns out to be `undefined`; the STRING
fast paths fall through to the explicit `toStrI64`/`strI64` coercion (which
already stringifies the sentinel as `"undefined"`, not raw bits) instead of
treating the claim as coercion-free.

**Correction to the task brief that opened this slice**: the brief's own
framing — "the decl-hop/param-hop/capture-hop repros should flip from wrong
to correct via Slice 3, without VT re-enablement" — does not hold, verified
by direct repro before writing a single line: at HEAD (Slices 1-2 landed),
`let x = m.get(missing); return x + 1` and its param/capture-hop siblings
ALREADY return the JS-correct `NaN`, unrelated to Slice 3 — because the
census is fully dormant (audit-#9 P0-1), `x`'s `val` never settles non-null
at any hop (Slice 2's own §10 finding), so every hop already takes the
generic dynamic path, which needs no static claim to falsify. The SAME is
true for `bigintMixReject`/`+`-concat's own targets: `valTypeOf(a) ===
VAL.BIGINT`/`=== VAL.STRING` never becomes true for a census-shaped node
(direct or via a mayBeUndefined-flagged bare name) while VT['[]']/['.']/['()']
stay dormant — confirmed by tracing `bigintMixReject`'s `aBig`/`bBig` and the
`+` handler's `vtA`/`vtB` computation directly. So — like Slices 1 and 2
before it — Slice 3 is representationally complete but **behaviorally
INERT** today; it becomes load-bearing the same moment Slice 4 does. This is
not a downgrade of the "repro-first" discipline: it IS the repro (running it
and finding it already green, or structurally unreachable, is itself the
finding) — fabricating a red→green transition that doesn't exist would be
the actual violation.

**A real, live, DIFFERENT bug found during repro verification (out of this
design's scope, not fixed here)**: the ONE hop shape that IS currently
wrong — `const g = (v) => v + 1; g(m.get(missing))` through a genuinely
SEPARATE (non-inlined) callee — returns JS `undefined` instead of `NaN`.
Root-caused via direct `optimize:false` vs default trace, not left as a
guess: emit.js's `+` handler already emits the fully SAFE, correct runtime-
dispatch form for this shape (the `__is_str_key` guard plus the NaN self-
compare atom ladder — the same idiom module/number.js's isNaN fix and
audit-#8 P0-3's `bigIntOperand` both already rely on), confirmed present
byte-for-byte in the PRE-optimize WAT. The POST-optimize (default) module
has that entire guard eliminated, collapsed to a bare unguarded `f64.add` —
a miscompile in the shared WASM-level optimizer (watr's own `optimizeFunc`
or this repo's `src/optimize/*.js` wrapper, not yet bisected further), which
wrongly treats this single-call-site trivial-function param as provably
non-string/non-NaN. Independent of every REP field this design adds or
consults (`optimize:false` already returns the correct value with ZERO
source changes) — a soundness bug in a shared backend pass, not a missing
chokepoint consultation, and a different blast radius than this slice's
mandate (bisecting a generic optimizer pass against kernel-parity/perf-
ratchet risk is its own undertaking). Does NOT reproduce for `-`/`*`/other
non-`+` operators (no alternate string-concat fast path to eliminate) nor
for the decl-hop/capture-hop shapes (same `+` operator, different function
shape — not yet isolated further). Pinned as a KNOWN-FAIL in
test/dyn-keys.js per that file's own established convention (mirrors the
BigInt-unary present-key KNOWN-FAIL pin already there) so a future fix
flips it instead of silently regressing further. Candidate for a dedicated
future audit; this codebase already independently tracks the general class
("watr's own generic WAT optimizer" reacting unsoundly to certain shapes —
.work/todo.md's outline-pass/localReuse hunts) — this is a new instance of
the same class, not previously pinned at this exact shape.

**No toNumF64 change landed** — a chokepoint-consultation fix was drafted
there (mirroring `ctx.func.maybeNullish`'s existing vt-independent gate) but
proved, on direct trace, to be dead code: toNumF64's own bottom-of-function
default (the `ctx.core.stdlib['__to_num']` inline self-compare-then-call
fallback) already coerces an unproven value soundly, and `__to_num`
capability is structurally always requested whenever a program can produce
a census-shaped (Map/dict) value at all — so the "no `__to_num` loaded,
blind passthrough" branch this design's §4 worried about for toNumF64 never
actually fires for a mayBeUndefined-flagged binding. Verified by direct
instrumentation (per-call trace of `toNumF64`'s `node`/`rep` arguments) and
by temporarily reverting the drafted fix and re-running every hop shape —
identical results with or without it. Not landed, per this project's own
standing instruction against unreachable "fixes" that don't change behavior.

**Test coverage** (test/dyn-keys.js, continuing Slices 1-2's honest-boundary
precedent of pinning what's actually observable): negative controls for
`bigintMixReject`/`+`-concat (genuine BigInt-mix still throws, genuine
BigInt+BigInt still adds, genuine STRING+STRING still takes the raw fast
path) — the INERT gap itself has no black-box repro today, matching Slice
1's own "could not live as a value assertion" finding; a regression pin for
the decl/param/capture-hop arithmetic table using a non-`+` operator (`-`),
confirmed already-correct at HEAD, framed explicitly as a regression guard
rather than a Slice-3 flip; the KNOWN-FAIL `+` param-hop optimizer-bug pin
described above.

**Gates run** (post-slice, fresh dist rebuild): full 88-file battery in 13
foreground chunks of ≤7 — 0 failures (pre-existing `test.todo` skips
unaffected); kernel-parity 33/33 byte-identical (O0/O2/O3); kernel-oracle
11/11; perf-ratchet 10/10 at +0 delta every category (int/float/mixed/cond/
buf/nest/slice/ring/condref/fgather); optimizer 214/214; dyn-keys.js/data.js/
types.js/math.js/json.js run explicitly (all green, 460/460); selfhost.js
21/21; fresh build ×2 byte-identical (jz.js/jz.wasm/interop.js); size sweep
geomean 1.055× (`scripts/bench-size.mjs`, unchanged from the 1.0550
baseline — expected: the new `censusMaybeUndefined` calls only change WHICH
compile-time branch is taken, and never take the "flagged" branch today, so
zero bytes move); fuzz 2000×4 (`node test/fuzz.js --count=2000`, four
separate runs) zero divergence.

Slice 4 (VT re-enablement, §5) remains unstarted — every fact this design
has built (Slices 1-3) is now representationally complete and consumption-
wired; Slice 4 is what makes all of it load-bearing at once, per §5's full
criteria (none of which Slice 3 attempted).

## 12 — Slice 4, as landed (VT re-enablement, §5 criteria met)

Landed: `dictValueKindOf`/`mapValueKindOf` (kind.js, restored as internal
helpers by Slice 1) wired directly into VT['[]']/VT['.']/VT['()']'s `.get`
short-circuit — the exact-kind promotion Slices 1-3 deliberately kept
dormant. A dict/Map read's static VT is once again the census's claimed
kind, everywhere protected by the `mayBeUndefined` machinery Slices 1-3
built.

**§5 criteria — per-criterion verdict** (full detail: .work/todo.md's Slice
4 ledger entry):
1. Propagation (decl/param/return/closure) — MET, pre-existing (Slices 1-2).
2. Chokepoint consultation — MET, pre-existing (Slice 3) PLUS two NEW gaps
   found and closed this slice (below) — §4's own "grep for
   valTypeOf(.*)===VAL\.` is the audit surface" instruction found real,
   live hits this time, because VT re-enablement is what made them reachable
   for the first time.
3. dyn-keys.js pins assert JS-correct values LIVE — MET, full matrix
   re-verified (.work/todo.md).
4. Full gate list green, cost justified — MET, zero cost (perf-ratchet +0
   every category, size sweep unchanged at 1.055×) — matches Slices 1-3's
   own "dormant costs nothing" finding extended to "re-enabling costs
   nothing measured" on this corpus.

**Criterion 2's own "next gap" instruction paid off twice**, found by
literally walking every `censusMaybeUndefined`/`Kind` consumer and asking
whether its OWN precondition (a claim that's now genuinely live) still
composes soundly — not assumed, not deduced from the design text alone:

1. `nullableOperand` (emit.js) had an early return for a bare-name operand
   that consulted ONLY `.nullable` (a materially different, broader,
   pre-existing REP field — "can this RHS produce null/undefined" via
   `mayBeNullish`'s own unrelated fail-closed heuristic), never reaching the
   function's own bottom `censusMaybeUndefined(n)` check that would consult
   `.mayBeUndefined`. Empirically inert in every test tried (the broader
   `.nullable` field happens to already cover every census-shaped decl-hop
   RHS, for its own unrelated reason) but WRONG composition per this
   design's own §4 mandate — fixed to fall through instead of early-return.
2. A call to a non-inlined function whose return traces to a census read had
   NO consumer for `func.valResultMayBeUndefined`/
   `ctx.closure.valResultMayBeUndefined` (Slice 2's own §10 "independently,
   directly provable" finding — these fields were SET and independently
   observable via `ctx.inspect`, but literally nothing else ever read them).
   `g(k) === undefined` and `g(k) + 1` both miscompiled for a non-inlined
   `g`. Closed by a new `callResultMayBeUndefinedKind` arm in kind.js,
   mirroring `calleeValType`'s own two-path lookup (direct closure /
   `ctx.func.map`) so a call-result claim and its mayBeUndefined companion
   travel together through the SAME predicate every other arm already uses.

**A soundness regression caught before it ever reached a commit** (full
trace: .work/todo.md): the NEW call-result arm broke `coerceNullishToNum`'s
(ir.js) own documented precondition — "valIR must be side-effect-free... it
is duplicated" — true for the two ORIGINAL arms (a pure dict/Map read, a
local-read bare name) but false for an arbitrary function call. A live
optimizer.js regression (a captured-mutation counter incremented 3× instead
of once) caught it during the routine gate run; fixed by hoisting into a
temp local at the ir.js call site specifically for the call-result shape
(byte-identical for the two original arms, which skip the new branch
entirely). Every OTHER `censusMaybeUndefined`/`Kind` consumer was
individually re-verified (not just inspected) to already be safe against
duplication — this was the one gap.

**Present-key BigInt through the census** (7288b69b's KNOWN-FAILs, §6's own
"present-key BigInt-unary regression" naming): re-verified LIVE, not
mechanically flipped. Value-materialization (`-m.get('x')` where `x`→`5n`)
STAYS KNOWN-FAIL — the wrong value changed (`-5`→`NaN`) because bigIntUnary's
runtime select/isUndef branch now correctly computes the true i64 negate
internally (confirmed by isolating each sub-expression) but the result still
crosses the SAME broken `resultDynamic` export lane §6 names for repro 5 —
this is that same presentKindUnboxed gap, not a new one, now reachable
through one more shape (unary ops, not just a bare read). The STRICT-EQUALITY
siblings (`-m.get('x') === -5n`) DO flip to correct (`false`→`true`) — both
sides prove BIGINT statically, so the comparison takes the REF_EQ_KINDS raw
i64-bit-compare path and never touches the broken export lane at all. Repro
5 itself (`m.get('x')` alone) is unchanged, confirmed still `2.5e-323`.
`presentKindUnboxed` (§2) remains un-landed — Slice 5, separable, still the
right fix for the export-boundary class; nothing in Slice 4 substitutes for
it.

**Positive wins reconstructed**: the ORIGINAL 1db8e55e/2b62b91b "consumer
wiring" pins (dict/Map read vs a NUMBER LITERAL compare) turned out, on
inspection, to never have exercised the consumer at all (cmpOp's relational
family takes the same raw-f64-compare shape whenever the OTHER operand is a
proven NUMBER LITERAL, census or not) — their comments were already updated
to say so at the audit-#9 revert. This slice's real positive-win pin
(test/inference.js) uses an ARITHMETIC consumption instead: a proven-NUMBER
dict/Map read via the census drops `+`'s STRING-coercion fallback arm
entirely (confirmed via `$__str_concat` absence/presence), with an escaping-
receiver negative control (nameEscapes gate) confirming the fallback stays
when the census can't fire.

Gates: full 88-file battery (15 foreground chunks ≤6), dyn-keys.js 27/27,
inference.js 136/136, types.js 170/170, optimizer.js 214/214, kernel-parity
33/33 byte-identical, kernel-oracle green, perf-ratchet 10/10 at +0,
selfhost.js 21/21, fuzz 2000×4 zero divergence, size sweep 1.055× unchanged,
fresh build ×2 byte-identical. Full detail and the exact audit-matrix table:
.work/todo.md's Slice 4 ledger entry.

This design's core deliverable is now fully landed: `mayBeUndefined` is a
represented, propagated REP fact consulted at every chokepoint, and
dictValueKindOf/mapValueKindOf are load-bearing again under its protection.
`presentKindUnboxed` (§2, §6) is the one remaining named item — a separate,
independent axis (present-key BigInt representation, not absent-key
undefined-tracking), left for a future slice per §8's own ordering.
