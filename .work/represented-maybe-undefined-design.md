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
