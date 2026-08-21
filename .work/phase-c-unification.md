# Phase-C: representation unification — the plan as sole authority

Campaign doc, branch `unification-phase-c` (base ca9ca31d). The 5f13eebd
three-store pin's "first implementation task", executed. Companion trail:
research.md §"Body-write-only BigInt params" (the probes) and §"RETIREMENT
FLIP — HALTED" (why strict-only died; boxing ratified).

## The invariant

For every binding the plan MATERIALIZES, the plan's verdict is the store
contract for the binding's whole lifetime: every producer edge (entry,
write, join arm) normalizes INTO the verdict rep, every consumer (read,
typeof, ==/===, return, boundary decode) dispatches FROM it. No second
authority — the legacy sink-OR/bigintBoxed store never overrides a
materialized binding.

## What already exists (verified in-tree, ca9ca31d)

- Call-arg entry edges: `representationCallArgAction` (representation-plan
  .js:1308) — source→param-target actions, readiness-gated
  (stable || materializedNames), consumed at emit.js:1597/1820 via
  coerceArg. Non-bigint members correctly KEEP (NaN-box self-tagged).
- Binding writes: `representationBindingWriteAction` (+
  applyBigintRepresentationAction at emit '=' — boxes a BIGINT rhs into a
  materialized binding).
- Return edges: `representationReturnAction` (emit.js:5379).
- Reads: readI64's plan arm (isPlanTaggedBigint → unbox); typeof's fold
  already exempts plan-tagged operands (core.js:3089).
- Runtime kind arms: $__typeof/$__eq/$__is_truthy PTR.BIGINT dispatch.

## The gap (probed live, 2026-08-20 gnorm trail)

Mixed-entry params (`if (typeof n === 'string') n = BigInt(n)` with
string+number sites; bigint only via body write) never materialize:
1. Boundary semantic: `mayBigint=false` (provenance now includes body
   writes — LANDED 729491cb) but the no-bigint fallback still stamps
   coarse `noBigintSemantic()` (all-kinds-minus-bigint, BOOL bit set),
   and the body join widens to closed-ALL → the BOOL-member veto blocks
   materialization. Precise fix (probed working): a CLOSED possibleKinds
   set without BIGINT keeps `boundaryParamSemantic(rep, uncovered)` —
   {string,number} closed → +BIGINT from write → no BOOL → materialize.
2. With (1) unlocked, the runtime was wrong at TWO consumer seams (raw
   7.0 bits read as 4619567317775286272n; `=== 9n` false):
   a. EXPORT-BOUNDARY RESULT DECODE: the result lane treats a may-bigint
      result as the bigint-sentinel/i64 lane; a TAG_REQUIRED union must
      route the GENERIC NaN-box decode (interop's readRet already
      handles every tag incl. PTR.BIGINT boxes).
   b. `===`/`==`: comparison on a plan-tagged union operand must take
      $__eq's dynamic dispatch (content-compare arm for PTR.BIGINT),
      never a raw-bits/static-kind fold.

## Slices (each gated: probes + data/pointers/watr legs + build +
kernel-oracle + full suite)

- C1. Boundary-semantic precision: closed-possibleKinds-sans-BIGINT keeps
  the precise set (representation-plan.js makeBoundaryData). The earlier
  revert re-applied, this time WITH C2/C3 in the same slice-set.
- C2. Union-result boundary decode: when the plan's RESULT verdict is
  TAG_REQUIRED (canBeBigint && canBeOther), the export wrapper takes the
  generic decode lane, not the bigint sentinel lane. Seam:
  synthesizeBoundaryWrappers / resultDynamic in compile/index.js +
  interop readRet/readSettled.
- C3. Tagged-union comparison: emitStrictEq/$__eq route dynamic when
  either operand is plan-tagged (mirror the typeof exemption).
- C4. Sink-OR containment (5f13eebd task 1): analyze's markBigintSink
  must not flip bigintBoxed on PARAMS whose plan verdict exists — params
  keep the boundary verdict; sinks box fresh copies via the inline-
  expression arm.
- C5. Acceptance sweep + pin flips: gnorm(string)/gnorm(number) both
  correct through `return n` AND `n + 1n` (TypeError-throw semantics for
  number+bigint mixing is OUT of C-scope — that's arithmetic-checking,
  banked); kind() probe stays correct; watr uleb no-array repro → 46,
  full uleb → 44002 at O0+O3; nullish-taken pin (data.js KNOWN-WRONG)
  flips to 'bigint'; JZ_BIGINT_STRICT enumeration shrinks.

## Non-goals

- No legacy-machinery deletion in this campaign (that follows, mechanism
  by mechanism, once plan coverage is verified — the re-aimed
  retirement).
- No mixed-arithmetic TypeError checking (separate, smaller slice).
- No strict-mode changes.
