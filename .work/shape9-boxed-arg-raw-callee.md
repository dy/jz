# Shape #9 investigation notes (branch fix/boxed-arg-raw-callee, base fb2dec2e)

Working notes for the shape #9 fix (test/data.js "BOXED-target reassigned param
crosses into a RAW-expecting bare-name callee argument"). See task brief +
.work/phase-c-unification.md's own "Shape #9" section for the pinning agent's
original (unverified) hypothesis. This file records what live tracing actually
found, which corrects that hypothesis in one important way.

## Repro (unmodified aff67069 / fb2dec2e, all optimize levels)

```js
function leb(n) { n >>= 7n; return n }
function parseIt(n) { n = n.replaceAll('_', ''); return BigInt(n) }
function i64(n) { if (typeof n === 'string') n = parseIt(n); return leb(n) }
export let f = () => i64("900")
```
`f()` returns `7.281331694578972e-304` instead of `7n` at O0/O2/O3.

## Live-traced root cause (CORRECTS the pinning agent's guess)

The pin's own comment says "leb's OWN param wants the RAW carrier (`n >>= 7n`
is raw i64 arithmetic)" and frames this as a BOXED-source-meets-RAW-target
call-arg edge that needs an inserted UNBOX. Traced with instrumented
`representationCallArgAction`/`buildBodyData` (temporary `JZ_SHAPE9_TRACE`
console.error probes, now in the diff): this framing is **not** what actually
happens.

- `leb`'s own boundary/body TARGET for `n` is **BOXED** (packed rep `6`), not
  RAW. `targetRepFor` only picks RAW when `current` is CLOSED+RAW; `current`
  is deliberately pinned to the LEGACY (`programFacts.paramReps`) census, per
  the hardened invariant from the Shape #6 "TWO REGRESSIONS" note (current/
  target never take the precision-narrowed provenance answer, only the
  BOOL-veto does). Traced `programFacts.paramReps` directly:
  - `i64` param 0: `{possibleKinds:["string"], kindsCoverage:"closed"}` —
    precise (only ever called with a string literal).
  - `leb` param 0 **and** `parseIt` param 0: `{possibleKinds: <all 14 kinds>,
    kindsCoverage:"closed"}` — the coarse "confident but uninformative"
    fallback Shape #6 layer 5's own doc names, this time triggered by a
    **bare-name argument that is itself a reassigned caller local**
    (`leb(n)` inside `i64`, where `i64`'s own `n` is reassigned from string
    to BigInt via `n = parseIt(n)`), not by a storage read.
- Because that closed-ALL-14-kinds semantic carries the synthetic BOOL
  member, `buildBodyData`'s materializedNames loop (representation-plan.js,
  the `for (const [name, list] of defs)` loop building `materializedNames`)
  **skips `leb`'s own `n` outright** — confirmed live: `leb`'s and
  `parseIt`'s params never even reach the loop's readiness check (traced
  every loop entry; only `i64`'s own `n` shows up — `leb`'s and `parseIt`'s
  are vetoed before that point).
- `leb`'s `n` therefore never enters `leb`'s OWN materializedNames, for ANY
  caller, independent of what representation the caller passes. This is
  exactly the residual the existing doc comment on `paramBigintOnly` already
  flags and explicitly scopes OUT: "A bare-name argument (`h(n)`...) resolves
  through exprRep as ANY_BIGINT — open, not closed... a missed opportunity,
  not a soundness gap, and stays out of this slice's scope" (representation-
  plan.js, solveBigintProvenance). Shape #9 is that missed opportunity
  actually firing.
- At the call site itself, `representationCallArgAction` computes
  `bodyReady=false` (target name not in callee's materializedNames) and
  `stable=false` (the callee's own param is reassigned), so `ready=false` →
  **REJECT**, not "KEEP when UNBOX was needed" — no coercion at all is
  inserted, and the caller's BOXED value's raw bits cross unmodified. Since
  `leb`'s body never materialized `n`, its own `n >>= 7n` emission falls to
  the legacy/pre-plan compound-bigint path, which assumes the incoming f64
  payload IS the raw NaN-boxed i64 bit pattern directly — misreading the
  caller's box POINTER bits as the i64 payload. Same disease, different
  proximate cause than the pin's own prose guessed.

## Fix direction (in progress)

Not a call-arg-edge UNBOX insertion (there is no source/target rep mismatch
to bridge — both ends agree on BOXED once `leb` is allowed to materialize).
The conceptually right fix closes the actual gap: extend the whole-program
call-site argument proof that feeds `paramNeverBool`/`markNeverBoolArg`
(`solveBigintProvenance`, representation-plan.js) so a **bare-name argument**
counts as structurally never-boolean when:
1. every explicit reaching-definition of that name within the caller's own
   body (`collectDefs`, already computed per-function as `defMapByFunc`) has
   a structurally never-bool RHS (bigint origin, or a call whose callee's own
   return tail(s) are structurally `isBigintOrigin` — pure AST inspection,
   no plan/provenance data, so no ordering hazard), AND
2. the name's own entry semantic, if it is itself a parameter, is also
   never-bool per the SAME legacy `programFacts.paramReps` census already
   available inside `solveBigintProvenance` (i64 param 0 here: `{string}`,
   closed — excludes bool).

This must fire through BOTH callee-resolution paths `visitCallSites`/`scan`
already support (bare name AND call-target-index-resolved `.`-member callee,
per Shape #8's `resolveMemberCallee` wiring) since both share the same
call-site loop — extending the shared predicate covers both automatically
(requirement 1 of the task brief).

Where the plan genuinely cannot prove the boundary (neither this extension
nor the existing proofs close it), `representationCallArgAction` must reject
at compile time with a typed diagnostic rather than silently pass an
unconverted value — need to confirm/build that diagnostic path before
landing (requirement 3); TODO next session if not already done.

## Diagnostic scaffolding currently in the diff

`src/compile/representation-plan.js` currently carries temporary
`process.env.JZ_SHAPE9_TRACE`-gated `console.error` probes in
`representationCallArgAction`, `buildBodyData`'s materializedNames loop, and
`makeBoundaryData`'s param loop. These are zero-cost when unset but are NOT
the fix — remove before the final commit (no other file in src/ uses a
JZ_*_TRACE convention; this codebase's precedent is to trace ad hoc then
strip, not to keep permanent env-gated scaffolding).

## Battery not yet run

No fix implemented yet — nothing to run beyond the baseline-probe repro
above (confirmed failing on fb2dec2e, matching the existing pin).
