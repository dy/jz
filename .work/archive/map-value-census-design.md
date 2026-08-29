# Map-value-kind census — design (2026-07-31)

Read-only design deliverable. PREMISE CORRECTION up front: the 12
fftplan/provenance guard sites carry OBJECT values (typed-array-field
records), so a scalar census closes ZERO of them — the design splits into
Tier 1 (scalar, dict-mirror, low risk, wins watr memo caches) and Tier 2
(schema-id fact, the actual fftplan/provenance fix, own design later).

## Ground truth (WAT-verified)

- m.get(k) is fully generic today: methodValType has .set/.add/.has/
  .delete branches but NO 'get' — valTypeOf falls to null. fftplan pays 6
  __ptr_type guards + 6 __dyn_get_any_t_h fallbacks (one per plan field
  per site); provenance's map edge 2 + 6 downstream __typed_idx.
- provenance-inference.js pins these as KNOWN-OPEN DYNAMIC deliberately —
  the fences this design eventually closes (Tier 2 only).
- There is NO existing Map-provenance mechanism (grep: zero) — the ledger
  phrase named the problem category, not infrastructure.
- Corpus write sites: exactly 2 .set( in bench (fftplan.js:94,
  provenance.js:76, both direct-name module globals); watr self-host has
  I32_MEMO/F64_MEMO (encode.js:75,183 — NUMBER indices, Tier-1 winnable)
  plus function-local heterogeneous AST Maps (correctly out of scope).

## Differences from the dict census

- Receiver gate is CLEANER: new Map() is hard-classified VAL.MAP
  (CALLEE_VAL + recordGlobalRep) — no dynWriteVars-analog proxy; gate on
  objType === VAL.MAP exactly like the existing .set/.add guards.
- Consumer seam is DIFFERENT: .get dispatches through methodValType
  (kind-traits.js:139), not VT['[]']/VT['.'] — mapValueKindOf needs an
  import/relocation decision (small, must be settled before wiring).
- nullableOperand carve-out needs a NEW branch: .get(k) is a '()' call
  node, not []/. — recognize ['()',['.',recv,'get'],k] when
  mapValueKindOf(recv) is set (same NaN-boxed-undefined reasoning as
  typedReadMaybeOob/dict).
- new Map([[k,v],...]) seed literals: real shape difference; DEFERRED
  (YAGNI — zero corpus occurrences).

## Tier 1 census (scalar mapValueValType)

program-facts.js branch beside the []= dict branch (~772-786):
match ['()',['.',recvName,'set'],args], commaList(args) length 2,
writeVT(v,{paramVts}) → observeMapValue/poisonMapValue (verbatim reuse of
the observeDictValue first-wins-then-clash lattice); new
ctx.schema.mapValueTypes Map cleared on {fresh:true}, published via
updateGlobalRep({mapValueValType}); module-init half + moduleInitSlot
cache treatment same as dict Fix B. Local half mirrors dictValueTypeOf
(analyze.js ~1339/~1528) gated on decl vt === VAL.MAP. REP_FIELDS +
'mapValueValType'. Consumer: methodValType 'get' branch → mapValueKindOf
(local-first, then global; no extra gate needed — receiver kind is
proven).

Fail-open: whole-program closed-world (same domains dynWriteVars scans);
INHERITED param-alias gap (f(cache){d.set(...)} buckets under d) — zero
bench occurrences; pre-landing grep gate over watr .set( sites required.

## Tier 2 (mapValueSchemaId — the fftplan/provenance fix, SEPARATE design)

The chokepoint is exprSchemaId (static.js:256-268), which already
resolves direct-call schema via f.sig.ptrAux — extend to recognize
proven-VAL.MAP receiver .get with a monomorphic mapValueSchemaId census
fact. Additive-only (never revises an existing verdict — the dict wall-
avoidance discipline applies). Risk surface: the hard schemaId/ptrAux
pointer-narrowing fixpoint (narrow.js:271-322 documents why schemaId must
be HARD for OBJECT pointers). Requires its own design pass after Tier 1
stabilizes. Expected effect when landed: fftplan's 6 sites + provenance
map edge collapse to slotVT-routed direct loads (the codegen the passing
field/ret edges already get).

## Order + gates

1. Tier 1 census, no consumer. Gate: inference fixture (cross-function,
   cross-module) + battery.
2. Tier 1 consumer wiring (methodValType 'get' + nullableOperand call
   branch + REP_FIELDS). Gate: dyn-keys/data/provenance-inference green —
   the memo/map KNOWN-OPEN pins MUST STAY PINNED (Tier 1 doesn't touch
   OBJECT edges; if they flip, the gate is unsound, not a bonus).
3. watr self-host 35/35 isolation before any measurement (I32_MEMO/
   F64_MEMO codegen diff expected — the win surface).
4. Tier 2 as its own later design/landing; provenance map edge flipping
   DYNAMIC→typed is its definition of done (memo edge = different
   mechanism, stays pinned).
Full gates each step: battery, parity, oracle, kernel leg, ratchet, dbg
invariants, watr 35/35.

## Risks

Tier 2 fixpoint surface (own design pass); param-alias census gap
(inherited, unaudited beyond bench grep — audit watr before trusting);
seed-literal shape uncovered (deferred); methodValType wiring seam
decision needed before consumer code.
