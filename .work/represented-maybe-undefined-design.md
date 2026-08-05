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

## 13 — Slice 5, as landed (the BigInt export-lane class, §6's presentKindUnboxed)

Closes §6's one remaining named item: repro 5 (`m.get('x')` alone, 5n stored,
read back `2.5e-323`) and the present-key BigInt-unary KNOWN-FAIL 7288b69b
left pinned in test/dyn-keys.js. This is the last named value-wrong family
from the whole audit campaign.

**Mechanism — LANE/KIND-INFORMATION, not a representation change**, per this
design's own permanent carrier doctrine (raw i64 BigInt bits reinterpreted as
f64, magnitude-ambiguous at the boundary by construction): `synthesizeBoundaryWrappers`
(compile/index.js) already computes the CORRECT i64 bits for a census-BIGINT
dict/Map result — `resultBigint`'s and `resultDynamic`'s wasm bodies were
already byte-identical (`toI64(callIR)`) before this slice. The only broken
piece was HOST-SIDE DECODE: a census-BIGINT-maybe-undefined result took the
generic `resultDynamic` lane, whose interop.js decode reinterprets
unrecognized i64 bits as an f64 NaN-box-or-number — misreading a small
BigInt's raw bits as a subnormal float.

Fixed with a new `jz:i64exp` result marker, `s` (sentinel kind), sibling to
the existing `r`/`m` markers, sourced from a new `censusBigintSentinelKind`
(kind.js, built directly on `censusMaybeUndefinedKind` — no VT dependency,
see below): kind 1 (bare dict/Map read or call-result — sentinel bits =
UNDEF_NAN, decodes to `undefined`), kind 2 (unary `-` of one — sentinel =
canonical NaN's bits, decodes to `NaN`, ES2024 13.5.6 ToNumeric(undefined)),
kind 3 (unary `~` of one — sentinel = `-1`'s bits, decodes to `-1`, ES2024
13.5.9). Computed once per export in `analyzeFuncForEmit` (while per-function
census reps are live — `_resultBigintSentinel`, mirrors `_resultNumeric`'s
own live-vs-torn-down split) and consulted in `synthesizeBoundaryWrappers`
with PRIORITY over `resultBool`/`resultBigint` (see "gap found" below — not
just an `else` arm). interop.js's `decodeBigintSentinel` compares the raw
i64 result against exactly the sentinel kind's fixed bit pattern (normalized
to the SIGNED range a wasm i64 result actually crosses as — `-1`'s bits have
the sign bit set, `BigInt.asIntN(64, …)` needed, unlike UNDEF_NAN/NaN whose
NaN-box-tagged high bits never do) — a match decodes to the sentinel's real
JS value, anything else returns as a raw BigInt. No new WASM instruction
anywhere in this slice; every byte the inner `$name`/wrapper `$name$exp`
functions emit is unchanged — confirmed by the fresh-build byte-identity gate.

**Two deeper, pre-existing bugs found and fixed en route** (both real
miscompiles, not export-lane issues — found because the census-BIGINT return
tail needed a genuinely correct WASM signature/codegen before any export
marker could matter):

1. `valTypeOfWithLocals`'s unary BigInt-preserving family (`u- ~ ++ --`,
   kind.js) fell through to `numericUnaryVT`'s unconditionally-resolving
   optimistic-NUMBER default whenever the operand's kind was genuinely
   UNRESOLVED at narrowValResults' early whole-program pass — the identical
   "unknown side → no claim" gap the pre-existing SOUND-`+` fix already
   closed for `+` (§4), never extended to the unary family. Left unfixed,
   `export let f = () => -m.get('x')` claimed `func.valResult = VAL.NUMBER`
   and skipped i64 boundary wrapping ENTIRELY (crossed as a bare f64,
   corrupting the BigInt on the present-key branch) — a live miscompile.
   Fixed: unresolved operand now propagates null instead of falling to the
   optimistic default.
2. type.js's `exprType` (Phase E i32-result narrowing, `narrowI32Results`)
   had the identical class of gap for the bitwise family (`~ & | ^ << >>`):
   an unresolved (not proven-BIGINT) operand still defaulted to `'i32'`,
   narrowing an export's WASM signature away from f64 even when the operand
   could genuinely be a census-BIGINT — `~m.get('x')` compiled the wrapper
   with an `i32` result type, discarding the true i64 bits outright (host
   received `0`, not even boundary-decode-wrong — structurally wrong).
   Fixed with a `censusShapedNode` guard that keeps the safe `'f64'` default
   specifically for that ambiguous case; ordinary, non-census bitwise ops
   are unaffected (verified: `~a`, `a << 2`, `~~a` truncation fold all
   byte-identical before/after).

**A third gap found while wiring the dict sibling** (dict's census resolves
EARLIER than Map's — `dictValueKindOf` has a whole-program pre-scan half in
program-facts.js, `mapValueKindOf` is per-function-only): `func.valResult`
can independently settle to a plain `VAL.BIGINT` for a dict-sourced census
read at narrowValResults' own early pass — WITHOUT its
`valResultMayBeUndefined` companion, because `exprMayBeUndefinedIn` (that
OR-join's own predicate) doesn't peel through a `-`/`~` unary wrapper the
way `censusBigintSentinelKind` does. Trusting `func.valResult === VAL.BIGINT`
at face value (the ORIGINAL plan: gate `_resultBigintSentinel` on
`func.valResult == null`) would have taken the plain `resultBigint` lane
(unmarked passthrough) and stayed wrong for `dict: unary "-"` on an ABSENT
key. Fixed by computing `_resultBigintSentinel` UNCONDITIONALLY (not gated
on `valResult == null`) and giving it priority over `resultBool`/
`resultBigint` in `synthesizeBoundaryWrappers`. Same fix closed a
previously-unpinned, genuinely pre-existing bug: a BARE (non-unary) dict
absent-key read (`d[k1]=1n; return d[k2]`) had the identical
`func.valResult`-without-`valResultMayBeUndefined` gap — confirmed broken at
HEAD via a stash diff before this slice touched anything, now fixed as a
side effect and pinned (test/dyn-keys.js, "Slice 5: bare Map/dict... repro
5").

**VT-Slice-4-revert independence — explicitly designed for it**, per this
session's own coordination: `censusBigintSentinelKind` and
`censusMaybeUndefinedKind` (its base) call `dictValueKindOf`/`mapValueKindOf`
DIRECTLY (kind.js), never through `valTypeOf`/VT — those helpers have been
independent of VT['[]']/['.']/['()']'s own exact-kind promotion since Slice 1
(79082fb2)'s "censusMaybeUndefinedKind-only helpers" restoration, and Slice
4 only ADDED a second caller (VT itself), never made the helpers depend on
VT. So the export-lane mechanism (`_resultBigintSentinel`,
`synthesizeBoundaryWrappers`'s `s` marker, interop.js's decode) is fully
VT-independent — repro 5 (bare read, sentinel kind 1) and the dict-early-
resolution fix survive a Slice 4 revert unchanged. The ONE VT-dependent
piece is PRE-EXISTING and not this slice's own code: emitNeg/`~`'s own
activation gate (audit-#8 P0-4, predates this task) originally read only
`valTypeOf(a) === VAL.BIGINT` to decide whether to route through
`bigIntUnary` at all — if Slice 4's VT wiring goes away, a dynamic
census-shaped operand's `valTypeOf` reverts to null and `bigIntUnary` never
fires, silently reverting the present-key unary case (sentinel kinds 2/3)
to its pre-Slice-4 KNOWN-FAIL state (unreachable, not wrong — the export
marker logic stays correct, just dead code). Hardened against this
proactively: emitNeg and the `~` table entry (emit.js) now gate on
`valTypeOf(a) === VAL.BIGINT || censusMaybeUndefinedKind(a) === VAL.BIGINT` —
the OR-arm reads the census helper directly, so `bigIntUnary` keeps firing
for a dynamic dict/Map-read operand independent of VT's own promotion.
Verified: identical present/absent unary values with this OR-arm in place.

**Negative controls** (test/dyn-keys.js, "Slice 5: negative controls"):
- Mixed-kind Map (`m.set('a',5n); m.set('b',6)`): `dictValueKindOf`/
  `mapValueKindOf`'s own census returns null for a mixed receiver (no single
  exact kind to claim) — `censusBigintSentinelKind` never fires, falls back
  to the OLD `resultDynamic` lane. Honestly pinned as the DOCUMENTED, UNFIXED
  behavior (`m.get('a')` still reads back `2.5e-323`, not `5n`) — this slice
  narrows the class to "exact single-kind census claim only," matching every
  other census consumer's own soundness carve-out, not "every BigInt export."
- A statically-proven BigInt export (`() => 5n`, `() => -5n`, no census
  involved at all): `resultBigintSentinel` computes 0 for these (the return
  tail isn't census-shaped), so they keep taking the ORIGINAL unmarked
  `resultBigint` lane, byte-for-byte unaffected — structural pin against the
  new lane over-firing on an already-sound case.

**Carrier doctrine boundary this slice does NOT touch** (named per this
session's own scope discipline, ">2^52 boundary cases per the permanent
documented divergences"): the sentinel-bit-pattern comparison itself has a
single-point collision risk shared with every other atom-vs-raw-bigint
interaction this codebase already accepts (UNDEF_NAN/NULL_NAN/etc. atoms) —
a BigInt whose value is EXACTLY the reserved sentinel's bit pattern
(`ATOM_HI[UNDEF]<<32n` for kind 1; the canonical NaN/`-1` bit patterns for
kinds 2/3) decodes to the sentinel's JS value instead of that exact BigInt.
Astronomically unlikely (one point in 2^64), same class the raw-i64-carrier
doctrine already tolerates everywhere else, not newly introduced by this
slice. Not fixed (would require abandoning the raw carrier for a tagged
one — full `bigintBoxed` producer/consumer wiring, §6's own "alternate
closure", out of scope here as it was for every prior slice).

**Out-of-scope bug found, NOT fixed, honestly pinned** (external audit #10,
found live while testing this slice's own repros, confirmed via a HEAD
stash diff to be byte-for-byte unaffected by this slice): a present-key
census-BIGINT value used in binary `+` with a NUMBER (`m.get('x') + 1`)
silently produces garbage NUMBER instead of JS's TypeError — entirely
IN-WASM (`bigintMixReject`, emit.js: "the mix is PROVABLE... one side
proven BIGINT, the other a NUMERIC LITERAL" — a dynamic dict/Map read
doesn't satisfy that proof at its own call site), not an export-boundary
issue, so no lane this slice adds could fix it. Needs joint runtime-domain
dispatch at the binary-op site (operand-local guards are architecturally
insufficient) — a separate, larger design. Pinned as a new KNOWN-FAIL
(test/dyn-keys.js) so a future fix flips it deliberately.

**Files touched**: kind.js (`censusBigintSentinelKind`, new; the SOUND-unary
fix in `valTypeOfWithLocals`), type.js (`exprType`'s bitwise-family
`censusShapedNode` guard), compile/index.js (`_resultBigintSentinel`
producer in `analyzeFuncForEmit`; `resultBigintSentinel` lane + `s` marker
in `synthesizeBoundaryWrappers`; the `jz:i64exp` JSON-building literal-shape
branch), emit.js (emitNeg/`~`'s VT-independence OR-arm), interop.js
(`decodeBigintSentinel`, the sentinel-bits table, the three call-site
decode branches), test/dyn-keys.js (flipped KNOWN-FAILs, new repro-5 pin,
negative controls, the new out-of-scope KNOWN-FAIL).

**Gates**: full 88-file battery (15 foreground chunks ≤6) — 0 failures;
dyn-keys.js 32/32 (91 assertions) native AND kernel leg (`JZ_TEST_TARGET=
jz.wasm`, genuinely routed through `compileViaKernel`, not just the env var);
kernel-parity 33/33 byte-identical (fresh dist/jz.wasm); kernel-oracle
11/11; perf-ratchet 10/10 at +0 every category; optimizer.js 214/214 (in the
541/541-assertion data+statements+optimizer chunk); selfhost.js 21/21;
fuzz 2000×4 (seeds 1-8000) zero divergence; size sweep geomean 1.055×
unchanged (`scripts/bench-size.mjs`); fresh build ×2 byte-identical
(jz.js/jz.wasm/interop.js, sha256-verified).

`presentKindUnboxed` (§2, §6) is now closed for the class this design named
it for. The remaining, explicitly out-of-scope items: the binary-mix
dispatch bug above (audit #10), and the general `bigintBoxed`
producer/consumer wiring gap (§6's "alternate closure", still un-landed —
would let a properly-boxed dynamic BigInt be self-describing everywhere,
collapsing this whole sentinel-lane mechanism into "just works", but is a
strictly larger undertaking than this slice's lane-only fix).

## 14 — Audit #10 verdict: Slice 4's VT re-enablement REVERTED, opt-in
## `presentVal` is the new re-enablement gate (revises §5)

Slice 4 (§12, 3782a692) wired `dictValueKindOf`/`mapValueKindOf` into
VT['[]']/VT['.']/VT['()'] — a dict/Map read's static `valTypeOf` became the
census's claimed kind, globally, at every VT call site simultaneously. §5's
own criteria (propagation, chokepoint consultation, live pins, gate cost)
were all individually verified at landing time. What §5 did NOT ask, and
what audit #10 found live: **is every consumer of `valTypeOf` — not just the
chokepoints this design's own audit walked — safe to receive an exact kind
claim for a value that can genuinely be `undefined` at runtime?** The answer
is no, structurally: `valTypeOf` is consulted by dozens of call sites across
emit.js/ir.js/kind.js/type.js/module/*.js that were never audited for
`censusMaybeUndefined` composition because they predate this design entirely
— they were written when a dict/Map read's `valTypeOf` was ALWAYS null, so
"trust `valTypeOf`'s claim outright" was always sound for this shape until
Slice 4 made it non-null. Slice 4's model was **opt-out**: every existing and
future `valTypeOf` consumer silently inherits exposure to a maybeUndefined
value the moment the census can prove a kind, unless it separately remembers
to ask `censusMaybeUndefined` too. Two consumers proved this wrong on
contact even during Slice 4's OWN landing session (§12's "two new gaps"),
found by manually walking the ~8 known chokepoints — not by an exhaustive
audit of every `valTypeOf` call site, which the codebase has no mechanism to
enumerate completely. Audit #10 found five more, unaudited, live at HEAD
(3344fc11): composed expressions (ternary/`&&`/`\|\|`/comma around a census
read — analyze.js's `mayBeUndefinedRhs` deliberately doesn't recurse these,
Slice 1's own "smaller surface" scoping, §9), container storage
(array-literal/object-literal wrapping a census read — the SAME decl-hop
propagation gap, one syntactic layer further out), kind-specific dispatch
(`Array.isArray`, `.length`, closure-call, string/number methods — each
trusts a `valTypeOf`/`calleeValType` claim with no `censusMaybeUndefined`
check at all, because each was written for a world where that claim didn't
exist), String `+` (the STATIC-concat fast path takes priority over the
STRING-coercion-of-undefined path whenever `vta === VAL.STRING`, without
checking whether that STRING claim carries `mayBeUndefined`), and BigInt
joint dispatch (`bigintMixReject`'s own narrower literal-proof policy,
pre-existing per §12/§13's own citation, confirmed unaffected either way).

**The revert** (this session): VT['[]']/VT['.']/VT['()']'s consultation of
`dictValueKindOf`/`mapValueKindOf` goes dormant again — kind.js reverts to
its exact Slice-1-era shape for those three sites (dictValueKindOf/
mapValueKindOf restored as `censusMaybeUndefinedKind`-only internal helpers,
never reaching VT's own exact-kind fold). `censusMaybeUndefinedKind` itself,
`censusShapedNode`, and Slice 2's whole-program propagation (params/returns/
closures) all STAY — they are REACHABLE-BUT-INERT again, the exact
Slice-1/2 "honest boundary" property (§9/§10) restored, not a regression:
every `censusMaybeUndefined`/`Kind` chokepoint (ir.js toNumF64/toStrI64,
emit.js nullableOperand/bigIntOperand/bigIntUnary/bigintMixReject/`+`-concat,
module/string.js/number.js/console.js) is correct and ready, just never
fed a non-null `valTypeOf` claim to react to, because nothing promotes one
anymore. Slice 4's own two found-live gap fixes (`nullableOperand`'s
fall-through instead of early-return; `callResultMayBeUndefinedKind`, the
call-result arm) are KEPT, not reverted: both were independently verified
sound-but-inert with VT dormant (their own preconditions — a non-null `val`/
`valResult` for a census-shaped node/return — themselves require the
reverted VT promotion to ever become true), so keeping them costs nothing
and saves re-deriving the wiring when §14's opt-in model lands. Slice 5's
entire export-lane mechanism (3344fc11 — `censusBigintSentinelKind`, the
`_resultBigintSentinel` producer, the `jz:i64exp` `s` marker, interop.js's
`decodeBigintSentinel`, emitNeg/`~`'s `censusMaybeUndefinedKind` OR-arm)
STAYS, per its own explicit, verified VT-independence design (§13's own
"VT-Slice-4-revert independence — explicitly designed for it" section) —
re-verified this session, not just trusted: dyn-keys.js's Slice 5 pins
(32/38 tests, since renumbered — see below) all stay green post-revert.

**A gap in Slice 5's OWN VT-independence claim, found closing this revert**
(not previously known, not named in §13): `_resultNumeric`'s boundary-wrap
decision (compile/index.js, computed while per-function reps are live) and
the base `VT['u-']`/`VT['~']` table entries (kind.js's `numericBinaryVT`/
`numericUnaryVT`, the SAME "operand kind unproven → optimistic NUMBER
default" class the SOUND-`+`/SOUND-unary fixes close elsewhere, §13 point 1)
had ONLY ever resolved a present-key census-BIGINT unary correctly — even at
HEAD, even with Slice 5 landed — because Slice 4's VT wiring made
`valTypeOf(m.get(k))` itself prove BIGINT directly, satisfying
`numericUnaryVT`'s condition without ever exercising its optimistic-default
fallback. Reverting Slice 4 exposed this: `-m.get('x')` (present key)
regressed from `-5n` back to `NaN` (`_resultNumeric` wrongly true, skipping
the i64 boundary wrap that carries the real BigInt bits), and
`-m.get('x') === -5n` regressed from `true` to `false` (emitStrictEq's
REF_EQ_KINDS raw-i64-compare path never reached, since `valTypeOf` of the
unary node no longer proved BIGINT on either side). Both fixed the SAME way
as emitNeg/`~`'s own OR-arm (the established, sanctioned pattern for this
exact situation): `_resultNumeric`'s return-expression check now also
requires `censusBigintSentinelKind(e) === 0`; `VT['u-']`/`VT['~']` (kind.js)
now consult `censusMaybeUndefinedKind(args[0])` directly via a
`censusBigintUnaryVT` wrapper, scoped to EXACTLY the single-operand `u-`/`~`
shape (`args[1] == null`) so the general binary `-`/`*`/etc. and the
`++`/`--`/`**`/`>>>`/`u+` siblings (no export-lane sentinel exists for those,
Slice 5 never covered them) are untouched. Both fixes are VT-independent by
the same construction as everything else in this family — `censusMaybeUndefinedKind`/
`censusBigintSentinelKind` call `dictValueKindOf`/`mapValueKindOf` directly,
never through VT. Verified this is NOT a new soundness hole (a firm BIGINT
claim on the unary node is per-CONTAINER, not per-key, the same carve-out
`dictValueKindOf`/`mapValueKindOf`'s own doc comments establish): an
absent-key strict-equality against a BigInt literal stays correctly `false`
post-fix (REF_EQ_KINDS' raw i64 bit-compare naturally differs — verified,
not assumed), and the full audit-#10 battery (below) is unaffected by this
narrow, BIGINT-only OR-arm (it never fires for a NUMBER/STRING/other-kind
census claim). This is exactly the kind of gap §5/§12's own chokepoint-walk
methodology was built to catch and didn't — a second confirmation that
manually enumerating "the known chokepoints" cannot be trusted to be
exhaustive against a global VT promotion, the core of this section's verdict
below.

**Full audit-#10 battery, re-verified with the census dormant** (every
container PRIMED with a same-kind write before the absent-key read — an
empty census has no claim to promote regardless of VT wiring, so an
un-primed repro exercises nothing):

| case | jz (census dormant) | JS | verdict |
|---|---|---|---|
| `(true?m.get(missing):999)+1` | NaN | NaN | correct |
| `(true&&m.get(missing))+1` | NaN | NaN | correct |
| `(false\|\|m.get(missing))+1` | NaN | NaN | correct |
| `((y=1),m.get(missing))+1` | NaN | NaN | correct |
| `[m.get(missing),1][0]+1` | NaN | NaN | correct |
| `({x:m.get(missing)}).x+1` | NaN | NaN | correct |
| `String([m.get(missing),1][0])` | "undefined" | "undefined" | correct |
| `String(({x:m.get(missing)}).x)` | "undefined" | "undefined" | correct |
| `Array.isArray(m.get(missing))` | false | false | correct (was TRUE, Slice-4-live) |
| `m.get(missing).length` (ARRAY census) | undefined | throws TypeError | KNOWN-FAIL, future work |
| `m.get(missing)()` (CLOSURE census) | throws RuntimeError (wasm table trap) | throws TypeError | KNOWN-FAIL, future work |
| `m.get(missing).length` (STRING census) | undefined | throws TypeError | KNOWN-FAIL, future work |
| `m.get(missing).slice()` (STRING census) | throws RuntimeError (wasm mem trap) | throws TypeError | KNOWN-FAIL, future work |
| `m.get(missing).toFixed(2)` (NUMBER census) | throws Error (jz host-dispatch) | throws TypeError | KNOWN-FAIL, future work |
| `m.get(present)+1` (STRING census) | "x1" | "x1" | correct, unaffected |
| `m.get(missing)+1` (STRING census) | NaN | NaN | correct (was "undefined1", Slice-4-live) |
| `m.get(present)+1` (BIGINT census) | 1 (garbage NUMBER) | throws TypeError | KNOWN-FAIL, pre-existing (§12/§13's own citation), unflipped |
| `Object.assign(new TypeError(x), {message:y})` | compile crash (module/object.js:535) | no crash | KNOWN-FAIL, out of scope (Error-bundle agent) |

The five kind-specific KNOWN-FAILs are a DIFFERENT, PRE-EXISTING bug class
from anything Slice 4 introduced or this revert touches — the generic
dynamic path has never distinguished "genuinely absent/undefined" from
"OOB/unresolved" at a member-access site closely enough to throw the real
JS TypeError instead of trapping or reading a default; census on or off is
irrelevant to this class. Named here (not fixed) because audit #10's own
framing ("isArray/length-trap→TypeError is future work") explicitly scopes
it out. The BigInt-joint and Object.assign rows are likewise pre-existing,
independently pinned KNOWN-FAIL, unaffected by this revert either direction
— re-confirmed, not re-derived.

**Pins updated** (test/dyn-keys.js, test/inference.js): the "Slice 4 positive
win" WAT-codegen-shape pins (dict-value/map-value census "consumer wiring" —
the `+` STRING-coercion-arm elimination) are reverted to their audit-#9-era
"RENAMED, no longer distinguishes the consumer" shape (both escaping AND
non-escaping receivers now keep the fallback arm — verified empirically, not
assumed). Every JS-VALUE correctness pin under the "Slice 4" heading in
dyn-keys.js (multi-hop arithmetic, identity-fold, call-result identity/
arithmetic/soundness) stays GREEN UNCHANGED — the generic dynamic path was
always sufficient for VALUE correctness, only the WAT-shape optimization was
ever VT-dependent, matching every prior slice-disable's own finding restated
once more. Nine new pins added for the audit-#10 battery above (composed
expressions, container storage, isArray, the five kind-specific KNOWN-FAILs,
String `+`, Object.assign) plus the two present-key-unary regression pins
this session's own §14 gap fix required.

**The revised re-enablement gate — supersedes §5 entirely.** §5's criteria
(propagation, "every chokepoint consults it", live pins, gate cost) are
NECESSARY but this audit proves them NOT SUFFICIENT: they describe auditing
a fixed, enumerable list of chokepoints, but a global VT promotion's real
consumer set is `valTypeOf`'s entire call graph — open-ended, added to by
every future feature, impossible to fully enumerate by inspection (proven
twice now: Slice 4's own landing session found 2 gaps this way, audit #10
found 5 more the SAME methodology missed). The structural fix is not a
better audit — it's removing the opt-out obligation entirely:

1. **`val` (the REP field `valTypeOf` reads) stays what it has always meant
   for every OTHER producer**: an exact, unconditional kind claim, safe for
   any consumer to trust without a companion check. A dict/Map census read
   must NEVER set `val` directly — this is the one invariant every prior
   slice (1-3) already upheld and Slice 4 broke.
2. **A new, SEPARATE fact — `presentVal`** (name deliberately distinct from
   `mayBeUndefined`, which only says "might be missing," not "is, when
   present, this kind"): the census's claim, stored where `mayBeUndefined`
   already lives, read ONLY by a consumer that explicitly asks for it. No
   existing or future `valTypeOf`/`VT[op]` call site gains new behavior by
   default — the opt-in list is exactly as long as the set of consumers that
   have been individually verified, the same discipline `censusMaybeUndefined`/
   `censusMaybeUndefinedKind` already model correctly for the chokepoints
   that use them today.
3. **`valTypeOf` itself returns unknown (null) for a census-shaped node
   unless presence is separately proven** — no optimistic default, matching
   the SOUND-`+`/SOUND-unary/`censusBigintSentinelKind` family's own
   discipline, generalized from "the two or three places that needed it" to
   "the rule for this shape everywhere." This is what makes opt-in actually
   safe: a consumer that does NOT ask for `presentVal` sees exactly what it
   saw before Slice 4 ever landed (null), not a silently-wrong exact kind.
4. **Binary/joint operators dispatch on the RUNTIME domain, not a static
   kind claim, whenever either operand is `presentVal`-sourced** — the
   BigInt-joint KNOWN-FAIL (`m.get(x) + 1` not throwing TypeError) is the
   proof this is load-bearing, not decorative: `bigintMixReject`'s own
   "operand-local guards are architecturally insufficient" finding (§13's
   citation) means even a perfect opt-in `presentVal` model doesn't close
   this row without ALSO teaching `+`/relational/etc. to branch on the
   ACTUAL runtime kind when a `presentVal` operand meets an unresolved or
   differently-kinded one — a genuinely separate, larger design (unchanged
   from §13's own framing), named here as the dependency this gate has on
   that future work, not claimed solved by opt-in alone.

A future re-enablement lands `presentVal` + the opt-in consumer list +
runtime-domain joint dispatch, gated on: every current `censusMaybeUndefined`/
`Kind` chokepoint ported to ask for `presentVal` explicitly (not `val`), a
NEW audit pass over `valTypeOf`'s full call graph for any site that would
newly observe a non-null claim (this is the enumeration §5 never required
and this audit proves necessary), and the full audit-#10 battery re-run
GREEN under the NEW mechanism specifically (not just "was already green
before" — the battery's whole point is to catch exactly this class again if
the next attempt repeats Slice 4's opt-out shape by accident).

**Gates this session**: full 88-file battery in foreground chunks of ≤7;
dyn-keys.js 38/38 (109 assertions, native leg — kernel leg identical per
kernel-parity); inference.js 136/136 (299 assertions, the two reverted
"Slice 4 positive win" pins re-verified); types.js 170/170; data.js 125/125;
statements.js 202/202; math.js 75/75; json.js 67/67; optimizer.js 214/214;
kernel-parity 33/33 byte-identical; kernel-oracle; perf-ratchet 10/10
(the census wins vanish again, matching every prior disable's own +0
finding — no NEW cost either, since nothing this revert touches changes
codegen for any non-census-shaped program); selfhost.js 21/21; fuzz 2000×4
zero divergence; size sweep geomean 1.055× unchanged; fresh build ×2
byte-identical.

## 15 — Slice 6, as landed ("begin the presentVal opt-in model")

§14's first slice: a new, SEPARATE `presentVal` REP field (reps.js) — the
census's claimed KIND, riding the same decl/reassign producer sites
`mayBeUndefined` already uses, propagated no further than that (no param/
return/closure hop — the next slice, if `mayBeUndefined`'s own Slice 2 is
the size precedent, is its own significant surface, not attempted here).
`val` is untouched — still exact-only, never census-derived, verified by
construction (see "mutual exclusivity" finding below) not just by absence
of a new write site.

**Producer** (analyze.js `analyzeValTypes`): a dedicated `setPresentVal`
tracker, a SECOND `makeValTracker` instance (own poison `Set`, freshly
created per `analyzeValTypes` call exactly like `setVal`'s own — NOT a
module-level singleton, which would leak poison state across functions and
compiles; caught and fixed before any test ran, not shipped). Called
UNCONDITIONALLY at both existing `let`/`const`/`=` sites, fed
`censusMaybeUndefinedKind(rhs)` directly — no separate helper needed, since
that one predicate already composes a direct census-shaped RHS, a one-hop
bare-name copy-through (reading this SAME field via the forward body walk),
and a call-result. This differs from `mayBeUndefinedRhs`'s boolean
spread-merge on purpose: `presentVal` is an exact KIND claim, so a later
write that disagrees (a different kind, or an ordinary non-census value)
must POISON it — mirroring `val`'s own makeValTracker discipline, not
`mayBeUndefined`'s "stays true forever, worst case an unneeded defensive
check" monotonicity. Pinned (test/types.js, 8 new tests): direct
Map/dict-census decls, one-hop bare-name copy-through, an ordinary decl
never setting it, disagreement-poisons on a later DIFFERENT census kind, a
later ordinary write poisoning a census-shaped decl (flow-insensitive, same
accepted cost `val` already pays), and the reverse order (ordinary decl
later reassigned to a census read stays poisoned — no un-poisoning, matching
`val`'s own rule).

**Consumer — the bare-name REP-fallback arm** (kind.js
`censusMaybeUndefinedKind`, arm 3): rewritten to consult `presentVal` FIRST.

**A real regression found and fixed before landing, not assumed safe**: the
first draft rewrote arm 3 to consult `presentVal` INSTEAD OF `val` (reasoning
that `val` could never legitimately co-occur with `mayBeUndefined` for the
same binding — true for a decl/reassign LOCAL, since `censusMaybeUndefinedKind`
never feeds `val`'s own tracker and vice versa, but FALSE for a PARAM: a
param's `val` is set by narrow.js's entirely separate call-site-argument
fixpoint (`hardParamVal`/`inferValAtSite`), with no census involvement at
all, while its `mayBeUndefined` can independently be true via Slice 2's own
DELIBERATE over-approximation — `censusShapedNode` flags ANY `[]`/`.` 2-arg
read, including a plain array/typed-array OOB-possible index, not just a
dict/Map one, because every `mayBeUndefined` consumer only ever asks it a
boolean question). The `presentVal`-only rewrite regressed test/dyn-keys.js's
"single-call-site `+` param-hop: sibling carrier-domain producers" pin — the
out-of-bounds-array-read case, `g(a[k])` through a single-call-site
`(v) => v + 1`, flipped from `NaN` (correct) back to `undefined` (wrong).
Caught by the gate run, bisected to exactly this line (not guessed): with
BOTH analyze.js producer call sites disabled the regression persisted,
proving the fault was in the CONSUMER rewrite itself, not the new producer.
Root cause: the old `r.val` check was NOT dead code (as §9-§14's own
"decl-hop only, val never settles" reasoning correctly established for
LOCALS but never separately checked for PARAMS) — it was the mechanism
keeping `toNumF64`'s `coerceNullishToNum` safety net reachable for exactly
this param shape. Fixed: `presentVal` checked first (the new, more precise
case), `val` kept as a fallback (the pre-existing, still load-bearing param
case) — both live for their own distinct binding shapes. Pinned (test/
types.js): `val` alone still answers (fallback), `presentVal` wins when both
are set (priority order). This is the kind of gap the design's own §14
verdict exists to catch — a change verified sound by construction for the
shape it was designed for, wrong for a shape sharing the same REP field
that the construction argument didn't consider — caught here by the
mandated gate, not by a wider audit ahead of time (the same honest lesson
§12's own "two new gaps" and audit #10's "five more" already taught, at a
much smaller scale this time).

**Live, not just representationally complete — a genuine value-correctness
win found and pinned, not assumed**: `censusBigintSentinelKind`/Slice 5's
export-lane sentinel machinery (§13) already calls `censusMaybeUndefinedKind`
directly — no refactor needed, it was ALREADY built on the right predicate.
Fixing arm 3 therefore makes it reachable one hop further than Slice 5's own
repro 5 (`m.get(k)` returned directly): `let x = m.get(k); return x` for a
present-key BIGINT census read now ALSO crosses the export boundary
correctly. Verified via a direct stash diff, not assumed: at HEAD before
this slice, `const m = new Map(); m.set('a', 5n); let x = m.get('a'); return x`
returned the host `2.5e-323` (repro 5's exact wrong bit-pattern, one decl-hop
out) — after this slice, `5n`. The unary siblings (`-x`/absent-key `-x`)
flip identically (`-5n`/`NaN`), and the dict receiver shares the fix (same
`censusMaybeUndefinedKind` predicate). The mixed-kind-Map carve-out (Slice
5's own documented, unfixed gap — census returns null for a mixed receiver)
correctly stays unfixed through the decl-hop too — pinned as a negative
control, not silently left to drift. Six new test/dyn-keys.js assertions
(two tests, "Slice 6" heading) pin this — the first slice in this design
since Slice 5 to flip real JS-observable output, not just extend an
analysis-level fact.

**Honest boundary — everything else stays inert, verified not assumed**: the
`toNumF64`/`toStrI64`/`nullableOperand`/`bigIntOperand`/`bigIntUnary`
chokepoints in ir.js/emit.js all compute `vt = valTypeOf(node)` FIRST and
only consult `censusMaybeUndefinedKind` when `vt` already proves a matching
kind — sound and load-bearing for the param case above (`val` there IS
`vt`'s own source), but never true for a decl-hop LOCAL, whose `valTypeOf`
stays null by §14's own point 3 ("no optimistic default", permanent, not a
temporary gap). So arithmetic/coercion/identity dispatch on a decl-hop
census-traced local still takes the generic dynamic path — unaffected by
this slice, matching every prior slice's own finding that the generic path
was already JS-correct for value shapes, just not WAT-optimized. Widening
those chokepoints' own outer gates to fall back to `censusMaybeUndefinedKind`
when `valTypeOf` is null — the actual "runtime presence dispatch: sentinel
check → undefined arm / present-kind arm" machinery — is explicitly NOT this
slice: it is a comparable-sized surface to `mayBeUndefined`'s own Slice 2
(touches ~5-8 call sites individually, each needing its own soundness
verification), not a small extension of this slice's decl-producer-only
scope. Named here as the next slice, not attempted early per this session's
own brief ("if §14 slices this later, respect the slicing; do not improvise
it early"). Binary/joint-operand runtime-domain dispatch (§14 point 4, the
`bigintMixReject`/`m.get(x) + 1` KNOWN-FAIL) remains entirely untouched, as
instructed — no code in this slice reads either operand of a binary op
jointly.

**Params/returns/closures do NOT get a `presentVal` producer in this
slice** — only the decl/reassign sites (mirroring `mayBeUndefined`'s own
Slice 1 scope exactly). A param's `presentVal` stays permanently absent
until a future slice adds that propagation (the `val`-fallback fix above
means this costs nothing today — the param shape that needs a kind claim
already has one, via `val`).

**Files touched**: reps.js (`presentVal` REP_FIELDS entry + doc comment,
including the corrected `mayBeUndefined` doc comment's stale "Slice 4 makes
it load-bearing" claim — now points at this slice instead); analyze.js
(`setPresentVal` tracker + two producer call sites); kind.js
(`censusMaybeUndefinedKind` arm 3 rewrite + doc comment); test/types.js (1
existing test updated, 9 new — 178/178, was 170); test/dyn-keys.js (2 new
tests, 6 new assertions — 40/40, was 38).

**Gates**: full battery (`npm test`, single foreground run, completed inside
the 600s budget — no manual chunking needed) 3308/3314 pass, 6 pre-existing
skips, 0 failures (was 3306/3312 pre-slice, +2 from the new dyn-keys.js
tests); dyn-keys.js 40/40 (125 assertions) BOTH legs — native and
`JZ_TEST_TARGET=jz.wasm` (genuinely routed through `compileViaKernel`) —
byte-for-byte same pass count; inference.js 136/136; types.js 178/178;
data.js 125/125; math.js 75/75; statements.js 202/202; json.js 67/67;
optimizer.js 214/214; kernel-parity 33/33 byte-identical (O0/O2/O3, fresh
dist); kernel-oracle 11/11; perf-ratchet 10/10 at +0 every category
(int/float/mixed/cond/buf/nest/slice/ring/condref/fgather — expected: this
slice's one live win is an export-boundary DECODE fix, not a hot-loop
codegen change); selfhost.js 21/21 (pre- and post-rebuild); fuzz 2000×4
(seeds 1-8000, four separate runs) zero divergence; size sweep geomean
1.055× unchanged (`scripts/bench-size.mjs`); fresh build ×2 byte-identical
(jz.js/jz.wasm/interop.js, sha256-verified, both before and after the final
test-file addition).

Slice 7 (widening the arithmetic/coercion/identity chokepoints' own outer
gates to fall back to `censusMaybeUndefinedKind` when `valTypeOf` is null —
the actual runtime-presence-dispatch machinery §14 names) and the
param/return/closure `presentVal` propagation remain unstarted. §14 point 4
(joint binary-operand runtime-domain dispatch, closing the
`bigintMixReject`/audit-#10 KNOWN-FAIL) remains its own separate, larger,
untouched design.

## 16 — Slice 7, as landed ("widen the consumer chokepoints — repro-first,
## most of the named acceptance criteria were already green")

Repro-first, per the task's own brief: before writing any code, every
acceptance-criteria row named by the task (decl-hop STRING `+`, decl-hop
BigInt unary through hops, composed/container-storage rows) was directly
repro'd against real JS. Every one of them was **already correct at HEAD**
(56daaf22) — the generic dynamic path Slices 1-6 kept finding "already
JS-correct, just not WAT-optimized" turned out to cover ALL of these value
shapes too, including ones never explicitly pinned before (`Math.abs`,
`x>5`, `typeof x`, template literals, ternary/&&/comma/array/object
composition one hop past a decl, `Number.isNaN`). This is the same finding
every prior slice's own disable/re-enable cycle already made, extended one
more level: `toNumF64`'s generic `__to_num` fallback and `toStrI64`'s
generic `__to_str` fallback both ALREADY special-case the UNDEF_NAN sentinel
internally (module/string.js's own `censusMaybeUndefined` comment on
`String()` — "falls through to the LAST branch... already correct" — is
literally true, verified by direct trace, not just trusted). So §15's own
"honest boundary" framing was right that these chokepoints don't yet emit
the CHEAP inline sentinel-dispatch for a hopped claim, but wrong to imply
this was a live VALUE-correctness gap for the named rows — it is a codegen/
WAT-shape gap only, for NUMBER; STRING's would need a NEW "undefined"
string-constant mechanism (MAX_SSO=6 can't hold "undefined", and ir.js's
own NO-EMIT contract blocks reusing module/string.js's literal-string
emitter from inside `toStrI64`) — scoped OUT of this slice as a genuinely
separate, comparable-sized undertaking, not attempted.

**What WAS found live and fixed, by continuing the repro sweep past the
task's own named rows** (methodology: same "verify empirically, don't
assume" discipline every prior slice in this design used) — a genuine,
previously-unpinned value-correctness bug:

1. **`toNumF64` NUMBER-census widening** (ir.js): the `vt === VAL.NUMBER`
   gate around `coerceNullishToNum` now also fires when `vt` is null but
   `censusMaybeUndefinedKind(node) === VAL.NUMBER` — the exact "runtime
   presence dispatch" widening §15 named, applied to the one chokepoint
   where it's small, safe, and reuses the EXISTING `coerceNullishToNum`
   verbatim (no new mechanism). Value-neutral (the generic fallback was
   already correct — confirmed via direct diff, not assumed) but a real
   codegen improvement: a hopped NUMBER-census read skips the generic
   `__to_num` dynamic dispatch call for the cheap 2-branch sentinel check.
2. **Binary `+` on two present-key BigInt census operands, NEITHER side
   separately provable** (`let x = m.get(a); let y = m.get(b); return x +
   y`) — genuinely WRONG at HEAD, confirmed by direct repro (not assumed):
   returned a garbage NUMBER (`4e-323`), not `8n`. Two independent, stacked
   causes, both fixed:
   - **The WASM computation itself** was wrong: `emit.js`'s binary `+`
     handler's entry gate (`valTypeOf(a)===BIGINT||valTypeOf(b)===BIGINT`)
     never sees a hopped census claim (`vt` stays null for this shape, §14
     point 3), so it fell to the generic dynamic-NUMBER path, which does
     `f64.add` on the raw i64-reinterpreted-as-f64 BigInt carrier bits —
     nonsense float arithmetic. Fixed: a new `bothBigIntOperands(a, b)`
     predicate (emit.js) — **AND, never OR** — routes to the existing
     `bigIntOperand`/`bigintMixReject` i64 machinery when BOTH operands are
     bigint-or-census-bigint. The AND is load-bearing, not incidental: an OR
     (a single census-BigInt operand paired with a proven-or-unproven
     NUMBER other side) would silently corrupt exactly the mixed-kind shape
     §14 point 4 already names as its own out-of-scope, "operand-local
     guards are architecturally insufficient" design — verified this stays
     unreachable (the existing audit-#10 KNOWN-FAIL pin, `present-key
     census-BIGINT + NUMBER`, is byte-for-byte unaffected).
   - **The export-boundary decode** was ALSO wrong, independently, even
     once the WASM computation was fixed: `VT['+']`'s own "unknown operand →
     optimistic NUMBER" default (kind.js) still claimed NUMBER for this
     shape, and `compile/index.js`'s `_resultNumeric`/`_resultBigintSentinel`
     boundary-wrap decision trusts that claim — so a genuinely-correct i64
     sum still crossed the JS boundary misread as a subnormal float. Fixed
     two ways, in lockstep: `VT['+']` gets a both-census-BIGINT upgrade
     (mirroring `censusBigintUnaryVT`'s existing pattern for `u-`/`~`,
     §14's own prior fix); `censusBigintSentinelKind` (kind.js) gets a new
     **kind 4** for a binary `+` node whose both operands independently
     claim BIGINT — simpler than kinds 1-3: `bigIntOperand`'s own runtime
     UNDEF_NAN guard already throws `BIGINT_UNDEF_MIX` before a genuinely-
     absent operand could ever reach a return here, so there is no
     absent-case bit pattern to special-case, and interop.js needs no new
     decode-table entry (`BIGINT_SENTINEL_BITS[4]` is simply absent, so
     `decodeBigintSentinel`'s `ret === undefined` check is always false for
     a real BigInt and the raw value passes through unchanged for free).

**Scoped OUT, found live while landing the `+` fix, NOT this slice's
scope** — `bothBigIntOperands` was initially written op-generic (also
wiring `-`/`*`/`/`/`%`/`&`/`|`/`^`/`<<`/`>>`), and the WASM computation for
ALL of them came out correct. But the export-boundary decode for every one
of those siblings stayed broken: `valTypeOfWithLocals` (kind.js, shared by
`narrow.js narrowValResults`) has a "SOUND `+`" no-optimistic-claim rule for
`+` ONLY (its own doc comment) — every sibling operator falls through to
the plain optimistic-NUMBER default, which locks in a WRONG
`func.valResult = NUMBER` claim at PLAN time, before this slice's own
per-function-emit-time widening ever gets a chance to run. Verified this is
**pre-existing and entirely general**, not a census/presentVal artifact at
all — a plain exported function taking two REAL (non-census) BigInt
PARAMS through `-` already misdecodes at HEAD, before any change this
session (`export let f = (a, b) => a - b; f(6n, 3n)` → `1.5e-323`, not
`3n`, byte-identical via `git stash`). Landing the op-generic version would
have been representationally complete but not live — the exact half-fix
this design's own history (§12's "two new gaps", audit #10's "five more")
warns against shipping silently. Reverted `bothBigIntOperands`'s USE at
those 9 call sites back to the original per-op gate (the helper itself,
and the `+`-only VT/`censusBigintSentinelKind` companions, stay); pinned
the current (byte-identical, unregressed) behavior as a dedicated
KNOWN-FAIL in test/dyn-keys.js, with the general non-census repro included
so a future fix's scope is unambiguous — it is a `valTypeOfWithLocals`
fix (broader blast radius: every function using these 9 operators, not a
census-chokepoint widening), not part of this design's own charter.

**Also found live, also scoped OUT** — a param-hop sibling gap, not a
chokepoint gap: `presentVal` has no producer for PARAMS (§15's own explicit
scope line — "Params/returns/closures do NOT get a presentVal producer in
this slice"). `const g = (v) => -v; g(m.get('a'))` (present-key BigInt
census, passed as a call-site argument) still corrupts — `emitNeg`'s own
OR-arm correctly ASKS `censusMaybeUndefinedKind(v)`, but gets `null` back
because nothing ever set `v`'s `presentVal`. This is exactly the
param/return/closure `presentVal` propagation slice §15 already named as
its own, separate, comparable-sized future work — confirmed live (not
just theorized) and pinned as a KNOWN-FAIL, not attempted here.

**`nullableOperand`/`bigIntOperand`/`bigIntUnary` needed NO widening** —
found, not assumed, before writing any code: all three already call
`censusMaybeUndefined`/`censusMaybeUndefinedKind` UNCONDITIONALLY, never
gated on `valTypeOf` first (only `toNumF64`'s NUMBER arm and `toStrI64`'s
STRING identity-bypass arm actually had the `vt`-first gate §15's own
honest-boundary text described for "the chokepoints" collectively — the
other three were already opt-in-clean). This matches the design's own
repeated finding that manually enumerating "the known chokepoints" needs
individual, not collective, verification — re-confirmed at a smaller scale
here, the same lesson §12 and audit #10 already taught.

**Files touched**: ir.js (`toNumF64`'s NUMBER-census widening, +import);
emit.js (`bothBigIntOperands` helper, wired at `+` only; the other 9
binary BigInt table entries get a comment, not a behavior change);
kind.js (`VT['+']`'s both-census-BIGINT upgrade; `censusBigintSentinelKind`
kind-4 arm, scoped to `+`); test/dyn-keys.js (5 new tests: the `+` flip,
its negative controls, and three KNOWN-FAILs — the general
`valTypeOfWithLocals` gap, its census-shaped sibling, and the param-hop
`presentVal` gap).

**Gates**: full 88-file battery in foreground chunks of 7 — every chunk
green (types 656/657 pass+1 pre-existing skip through kernel-parity
37/37 894 assertions — no failures anywhere); dyn-keys.js 44/44 (130
assertions) BOTH legs (native + `JZ_TEST_TARGET=jz.wasm`), byte-for-byte
same pass count; perf-ratchet 10/10 at +0 every category (int/float/mixed/
cond/buf/nest/slice/ring/condref/fgather — expected, per the task's own
framing: a hopped-census-claim shape reaching a WAT-optimized fast path is
rare in this corpus); kernel-parity 33/33 byte-identical (O0/O2/O3);
kernel-oracle 11/11; selfhost.js 21/21 (206 assertions); fuzz 2000×4
(seeds 1-8000, four separate foreground runs) zero divergence across
~120K compared inputs; size sweep geomean 1.055× unchanged
(`scripts/bench-size.mjs`, byte-for-byte per-case table diffed against the
pre-slice run); fresh build ×2 byte-identical (`dist/jz.js`/`dist/jz.wasm`/
`dist/interop.js`, sha256-verified: `2ec1e1f9…`/`54d56c3a…`/`396500b4…`
both times).

The next slice, per §15's own naming, is still open: the remaining
`toStrI64` STRING-census widening (needs a new "undefined" string-constant
mechanism — out of scope here, precisely because it's new machinery, not a
gate widening), the param/return/closure `presentVal` propagation (found
live-blocking a real case this session, not just theorized), the general
`valTypeOfWithLocals` "SOUND" rule gap for `-`/`*`/`/`/`%`/bitwise (found
live this session, pre-existing, general — its own separate fix), and §14
point 4's joint binary-operand runtime-domain dispatch (the
`bigintMixReject`/audit-#10 KNOWN-FAIL, unchanged, still its own separate,
larger design).

## 17 — audit-#10 kind-specific table closed: member access / calls on a
## nullish receiver get real ES TypeError semantics

Closes the five `KNOWN-FAIL (audit #10, future work)` rows §14's own battery
table named (line ~1033-1037): `.length`/`.slice()`/`.toFixed()`/`()` on a
genuinely-`undefined` census read used to trap (wasm bounds/table trap),
read a garbage/default value, or throw jz's own internal host-dispatch
`Error` — never a real, catchable `TypeError`. `Array.isArray` on the same
shape was already correct (§14's own revert).

**Mechanism call: upgrade the existing runtime arms, not a new dispatch
pass.** Every one of the five rows already had ONE specific, existing
"unknown/unresolved receiver" emission arm (found by reading before writing,
per this task's own brief): `module/core.js` `emitLengthAccess`'s
"Unknown → runtime dispatch" arm (`.length`); `src/compile/emit.js`
`tryRuntimeStringFork`'s non-STRING fallback (`.slice()`-shaped STRING-vs-
ARRAY forks); `tryRuntimeNumberMethod`'s no-sidecar-override fallback
(`.toFixed()`-shaped NUMBER-only methods, closures present); `externalMethodFallback`'s
terminal `__ext_call` emission (same methods, closures absent); `emitGenericClosureCall`
(bare `f()` calls on an unresolved callee). Each arm already existed and
already ran on EVERY unresolved-kind receiver — the fix is one `isNullish`
(ir.js) branch inserted into each, throwing instead of falling through to
the old undefined/OOB/host-dispatch behavior. No new dispatch machinery, no
new strategy, no new pass.

**The throw itself** (`src/ir.js` `throwTypeErrorIR`, new, ~25 lines):
constructs a REAL TypeError object inline — the identical shape module/
core.js's `buildErrorObject` uses for a source `new TypeError(...)` (alloc_hdr
+ one store per `ERR_SCHEMA_PROPS` slot + `mkPtrIR`) — and throws it through
the ordinary `$__jz_err` channel (`global.set $__jz_last_err_bits` +
`throw`), the same 48-site pattern err-codes.js's registry already
establishes. A REAL schema-tagged object, not a bare numeric code, is what
makes `catch (e) { e instanceof TypeError }` true in-wasm: audit-#8 P0-2
deleted the numeric-code range arm as unsound (a user's own `throw
<sameNumber>` is bit-identical to an internal code), so only the tag+schema
arm of the Error model's `instanceof` truth table (error-object-design.md
§4) answers true — and only a real object carries a tag. The SAME object
crossing to an uncaught host boundary decodes to a real host `TypeError` via
interop.js's EXISTING `decodeThrown`/`errorSidClassOf` (audit-#7 P1,
2a973082) — zero new decode machinery on either lane.

**`.message`/`.name` are left `undefined`** (UNDEF_NAN, a pure NaN-box
literal) rather than real strings — `instanceof` needs none of it (identity
lives in the schema id, not any slot), and the task's own pin contract is
class + catchability, matching error-object-design.md §5's existing
precedent for internal coded throws ("no lazy materialization... an honest
gap, not a new one"). Deliberate, not an oversight: building real message
strings from these sites would need `module/string.js`'s literal-interning
path, which is CONDITIONALLY autoloaded (not always present, unlike
module/core.js) — reaching for it directly re-exposed two separate,
confirmed PRE-EXISTING, unrelated self-host/module-interaction bugs (below).

**Two found-live, out-of-scope landmines, confirmed pre-existing via a
disposable `git worktree` at clean HEAD before this task, not fixed:**
1. `__mkptr(...)`'s literal third argument (a raw offset constant) folds to
   the WRONG compile-time value whenever `module/string.js` happens to be
   loaded alongside it in the same compile — reproduces identically at HEAD
   1d083ba9 by forcing `module/string.js` to autoload next to an unrelated
   `__mkptr` test snippet. A NaN-box pointer-literal folding bug, nothing to
   do with member access/calls.
2. `.call`/`.apply`/`.bind` static lowering (`foldFnCallApplyBind`,
   prepare/index.js) drops a `thisArg` side effect under the same
   condition — also reproduces at clean HEAD.
Both are latent, pre-existing self-host-adjacent fragility triggered by
"does `module/string.js` happen to be loaded"; this task's OWN mechanism
never triggers module/string.js autoload at all (throwTypeErrorIR builds
inline, no `emit(['str', ...])`), so neither landmine is reachable through
this feature — named here only because they were found while chasing an
early draft's "Unknown op: str" crash (a draft that DID try routing through
`ctx.core.emit['TypeError']`, hence module/string.js — reverted).

**Gate scope: `censusMaybeUndefined`, not "kind unresolved."** The first
landed draft gated every one of the five arms on "receiver's static kind
(`vt`) is unresolved" alone — matching a literal reading of this task's own
brief ("or the receiver is kind-unknown at a dynamic dispatch site"). The
mandated gate run caught this as unsound-for-SIZE, not unsound-for-
correctness: an ordinary POLYMORPHIC-but-never-nullish parameter (e.g.
bench/poly.js's `sum(arr)`, called with both a `Float64Array` and an
`Int32Array` — no single `vt` provable, but never undefined at either call
site) has `vt == null` too, and paid the FULL guard tax at every such site —
a measured SIZE-geomean regression from 1.0418× to 1.111× across the full
49-case size-sweep corpus (49/49 cases regressed, ~+100B flat per program).
Landed fix: gate all five arms on `censusMaybeUndefined` (kind.js) INSTEAD
of "vt unresolved" — the EXISTING, narrower, load-bearing "genuinely might
carry real `undefined`" predicate this whole design (§1-§16) already built
and propagates through param/return/closure hops (`presentVal`/
`mayBeUndefined` REP fields, censusShapedNode, the call-result arm). A
dict/Map absent-key read (this task's own named rows) is exactly what
`censusMaybeUndefined` was built to recognize; an ordinary kind-ambiguous
array/typed-array parameter is not, and correctly pays nothing. Restored
the size-sweep geomean to 1.0418× (baseline, unchanged) — 0 of 49 cases
differ from HEAD 1d083ba9 byte-for-byte.

`instanceof`/`String()`-on-caught-value fold correctness needed one more,
independent hook (`src/prepare/index.js`, inside `prep()`'s universal per-
node walk, mirroring the existing bigint/error whole-program flag pattern):
whenever a `.`/`()` node's receiver/callee is `censusShapedNode`-shaped
(kind.js's pure AST-shape test, no ctx lookup — the same predicate
`mayBeUndefined`'s own Slice 2 producer already uses), pre-register
`ctx.features.errorClasses.add('TypeError')` — order-independent, same
reasoning as the existing bigint-flag comment, needed because
`emitErrorInstanceof`/`toStrI64`'s Error arms fold to a compile-time `false`
whenever `used.has('TypeError')` is false, and a program's OWN throw site
can textually follow its `catch(e){ e instanceof TypeError }` in source.

**A genuine, PRE-EXISTING self-host non-determinism found and then
UN-exposed, not fixed:** the FIRST (vt-unresolved-gated) draft made
`kernel-parity`'s `dict` corpus row (a pure dynamic-hash program, `d[c] =
(d[c]||0)+1`) reachable through `s.length`'s guard, which minted `dict`'s
FIRST-EVER Error schema as a side effect — activating a previously-dead
schema-checking arm in the shared stdlib helper `$__dyn_get_t_h`
(module/collection.js), whose own pre-existing WAT folds one truthiness
check differently native vs self-hosted (confirmed pre-existing at clean
HEAD 1d083ba9 via a disposable worktree, forcing an unrelated dead-code
Error schema into the same `dict` source — byte-for-byte the same 46-byte
divergence class). The `censusMaybeUndefined` narrowing above independently
removed `dict`'s reachability into the guard (`s` is a plain string
parameter, never census-tainted) — re-verified after landing, not assumed:
`dict` is genuinely byte-identical native-vs-kernel again at every tier, so
`test/kernel-parity.js`'s `PARITY_TODO` stays the empty set it already was.

**Files touched**: `src/ir.js` (`throwTypeErrorIR`, new); `module/core.js`
(`emitLengthAccess`'s guarded arm, gated on a new `mayBeUndef` parameter);
`src/compile/emit.js` (`tryRuntimeStringFork`/`tryRuntimeNumberMethod`/
`externalMethodFallback`/`emitGenericClosureCall`, each gated on
`censusMaybeUndefined`); `src/prepare/index.js` (`censusShapedNode`-scoped
`errorClasses` pre-registration hook); `test/dyn-keys.js` (audit-#10 KNOWN-
FAIL block replaced with three green tests — host-boundary uncaught,
in-wasm caught+instanceof, proven-receiver-unaffected — 50/50, 188
assertions); `test/closures.js` (one devirt test's WAT-shape assertion
updated — a ternary-bound closure-local call site no longer devirtualizes,
since the nullish guard now interposes on watr's own devirt pattern match;
functional correctness re-pinned, not dropped); `test/kernel-parity.js`
(comment-only: documents the found-then-closed self-host divergence,
`PARITY_TODO` unchanged at empty).

**Gates**: full ~90-file battery in foreground chunks of 4-7, every chunk
green; dyn-keys.js 50/50 (188 assertions) native leg; kernel-parity 33/33
byte-identical (O0/O2/O3, including `dict`); kernel-oracle 11/11;
perf-ratchet 10/10 at +0 every category (proven receivers genuinely
untouched); optimizer green; minimal-output green (heap-free numeric
programs stay heap-free, Error schema fully reachability-gated);
selfhost.js 21/21 (206 assertions); fuzz 2000×4 (seeds 1-8000, four separate
foreground runs, re-run after the `censusMaybeUndefined` narrowing) zero
divergence; size sweep geomean 1.0418× (baseline 1d083ba9, unchanged, 0/49
cases differ — the 1.05 cap holds with margin); fresh build ×2
byte-identical (`dist/jz.js` sha256 `8a8fb7be…`, `dist/jz.wasm` sha256
`58848b4f…`, `dist/interop.js` sha256 `396500b4…`, both builds).

Residual, out of scope (named above): the `__mkptr`/`.call`-`.apply`-`.bind`
module/string.js-autoload-adjacent landmines (pre-existing, unrelated,
never reachable through this feature); real `.message`/`.name` text for
these internal throws (needs the same STRING-census widening §16 already
named as its own future slice); the general "method not found on a proven
non-nullish OBJECT/HASH receiver" case (still reads `undefined`, unchanged —
a different, pre-existing gap this task's own scope never covered).
