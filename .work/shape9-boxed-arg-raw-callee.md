# Shape #9 fix (branch fix/boxed-arg-raw-callee, base fb2dec2e)

## Root cause (live-traced; CORRECTS the pinning agent's original hypothesis)

The pin's own prose guessed leb's param "wants the RAW carrier" and framed
this as a BOXED-source-meets-RAW-target call-arg edge needing an inserted
UNBOX. Traced with temporary instrumentation (now removed): that framing was
wrong on the specific mechanism, right on the symptom.

- `leb`'s own boundary/body TARGET for `n` is BOXED (not RAW). `targetRepFor`
  only picks RAW when `current` is CLOSED+RAW; `current`/`target` are
  deliberately pinned to the LEGACY `programFacts.paramReps` census (never
  the precision-narrowed provenance answer — a hardened invariant from the
  Shape #6 "TWO REGRESSIONS" note).
- `leb`'s ONLY call site (`i64`'s `return leb(n)`) passes a bare name that is
  itself a REASSIGNED CALLER LOCAL. The legacy census can't see through that
  (`exprRep` on a bare local resolves ANY_BIGINT — open, not closed), so it
  reports the coarse "any of the 14 kinds, closed" fallback (BOOL included)
  for `leb`'s param — the same "confident but uninformative" answer Shape #6
  layer 5 already named for storage reads, this time for a reassigned-local
  argument.
- That closed-but-BOOL-including semantic trips `buildBodyData`'s BOOL-veto,
  so `leb`'s `n` never enters `leb`'s OWN `materializedNames`, for ANY
  caller — independent of what the caller passes.
  `representationCallArgAction` then sees `bodyReady=false` (and
  `stable=false`, since `leb`'s own `n` is reassigned via `n >>= 7n`) and
  **REJECTs** the edge outright — not "wrong action", **no coercion at
  all**. The caller's still-boxed pointer bits cross unconverted and get
  misread as the i64 payload.
- This is exactly the residual `solveBigintProvenance`'s own `paramBigintOnly`
  doc comment already named and explicitly scoped OUT: "A bare-name argument
  (`h(n)`...) resolves through exprRep as ANY_BIGINT — open, not closed...
  a missed opportunity, not a soundness gap, and stays out of this slice's
  scope."

## Fix (src/compile/representation-plan.js, `solveBigintProvenance`)

Extended the call-site argument proof feeding `paramNeverBool`/
`markNeverBoolArg` (the existing, structurally-weaker "boolean impossible"
bar Shape #7 already established — not kind purity) with
`argStructurallyNeverBool`/`structurallyNeverBoolExpr`:

- A bare-name argument counts as structurally never-boolean when every
  explicit reaching definition of that name within the caller's own body
  (`collectDefs`, already computed per-function as `defMapByFunc`) is itself
  structurally never-bool — a bigint origin, a storage read, a number/string
  literal, or a call whose callee's own return tail(s) are structurally
  `isBigintOrigin` (pure AST inspection, no plan/provenance data — no
  ordering hazard against the callee-before-caller settling this file's
  other cross-function facts rely on) — AND the name's own entry semantic,
  if it is itself a parameter, is also never-bool per the SAME legacy
  `programFacts.paramReps` census (already in scope inside
  `solveBigintProvenance`).
- Wired into the ONE shared `visitCallSites` call-arg loop that ALREADY
  resolves both bare-name (`ctx.funcs.map.get`) and `.`-member
  (`resolveMemberCallee`, Shape #8's call-target-index) callees identically
  — so the proof itself fires through both resolution paths without a
  separate wiring point.
- This clears the BOOL-veto so `leb`'s `n` materializes — target stays
  BOXED (the legacy-derived default, unchanged, per the hardened
  current/target invariant) — and the call-arg edge becomes an ordinary
  BOXED→BOXED KEEP once both ends agree. No new box/unbox primitive was
  needed for this shape; `maybeUnboxBigInt`/`unboxBigInt`/`boxBigInt` and
  `representationCallArgAction`'s own UNBOX/BOX branches were already
  correct and untouched — the actual gap was upstream, in whether the edge
  was READY at all, not in which coercion it chose once ready.

## Sibling pins (test/data.js, all next to the flipped primary pin)

1. **Primary — FIXED.** `is(e.f(), 7n, ...)` at O0/O2/O3.
2. **Index-resolved `.`-member callee — KNOWN-WRONG, separate residual.**
   `obj.leb = leb; ... obj.leb(n)` inside `i64` (i64/parseIt stay bare-name).
   Traced root cause: ANY property write of a function's own value (which
   `call-target-index.js` itself needs to resolve ANY `.`-member call)
   marks that function `valueUsed` in narrow.js's whole-program census,
   which flips `makeBoundaryData`'s `uncovered` true — and
   `buildBodyData`'s materializedNames loop has a DELIBERATE gate,
   `if (params.has(name) && boundary.covered !== true && !exportedIdentity)
   continue`, that excludes an uncovered non-exported param from this
   fixpoint entirely, regardless of this fix. `leb`'s `n` falls to the
   pre-RepresentationPlan legacy sink/generic-closure machinery instead —
   confirmed independently at the emission side too: `emit.js`'s
   `trySchemaClosureCall` dispatches `.`-member calls via `ctx.closure.call`
   (a generic call_indirect) and passes `parsed.normal` UNCOERCED;
   `representationCallArgAction`/`coerceArg` is never even invoked for this
   edge (traced: zero call-arg entries). Fixing this needs the closure-
   materialization subsystem (`closureBoxParams`/
   `mintRepresentationPlan(...,{generic:true})`) to ALSO prove a value-used
   named function's own param boxed-by-construction across a property-
   dispatched call — the same "comparably-sized, separate undertaking"
   Shape #7's own dispatch-table residual and the closure-forwarding slice
   already name. Verified this is a GENUINE, DIFFERENT gap, not a scope
   dodge: `directCallBoundary` (buildBodyData's own callee lookup, used by
   `semanticOf`/`currentOf`/`plannedOf`/`walkEdges`) is bare-name-only too
   (`ctx.funcs.map.get(name)`, no `resolveMemberCallee` fallback) — a
   SEPARATE, narrower, also-real gap found while isolating this residual
   (member-resolving only the INNER bigint-provenance-supplying call, with
   `leb`/`i64` both staying bare-name/covered, reproduces the SAME wrong
   value) — neither one is this fix's scope.
3. **Non-reassigned BOXED param (union case) — O0/O2 FIXED, O3 pre-existing
   KNOWN-WRONG.** `relay`'s own param `n` is a genuine, never-reassigned
   Number|BigInt union proven from two real (executed) call sites
   (`relay(900n)`, `relay(5)`, discriminated by `typeof` so the Number arm
   never reaches `leb`'s raw `>>=` — avoids the real JS TypeError that would
   throw). O3 failure confirmed IDENTICAL on unmodified fb2dec2e (fix
   reverted, same wrong value) — pre-existing, not introduced or fixed by
   this change. Matches the class the already-LANDED "storage-read forwarded
   through TWO plain named functions... shape #7 sibling" pin documents:
   `inlineHotInternalCalls` splices `f`'s call to `relay` away at -O3 before
   provenance/census analysis runs; that pin's own fix covers a
   storage-read argument specifically, not a bare bigint-literal argument
   forwarded the same way — still open for this shape.
4. **Negative control — no regression.** `leb(900n)` (bare literal, leb's
   only call site) stays RAW→RAW: correct value at O0/O2/O3 plus a WAT-shape
   assertion (O0) that `f`'s own body contains neither `call $__ptr_type`
   (maybeUnboxBigInt's tag-check) nor `call $__alloc` (boxBigInt's
   allocator) — confirms the fix does not insert unneeded coercion.

## Diagnostic scaffolding

All temporary `JZ_SHAPE9_TRACE`-gated `console.error` probes (added during
root-cause tracing) have been removed from the final diff. No permanent
trace scaffolding was added — matches this codebase's existing precedent
(trace ad hoc, then strip).

## Battery — IN PROGRESS

See task report for final numbers; this file is a working log, updated as
each leg completes.
