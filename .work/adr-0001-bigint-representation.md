# ADR-0001: BigInt representation — tagged dynamic core, raw i64 as proven specialization

Status: **Accepted** 2026-08-21 (audit-E "yours to answer" ratification). Supersedes the
BigInt-retirement direction of `.work/compat-handoff.md` §BigInt and
`.work/bigint-retirement-design.md`'s end state. Ratifies `.work/representation-plan-v2-design.md`
§0 as the standing architecture.

## Context

Two carriers exist for BigInt at runtime: raw i64 (fast, but a raw BigInt∪Number union is
physically ambiguous — tagged Number 0 bit-equals raw 0n, Number.MIN_VALUE bit-equals 1n)
and the NaN-box tagged carrier (unambiguous, costs a box). The repository carried two
conflicting directions:

- **representation-plan-v2-design.md**: plan owns edge representation; normalize (box),
  split, or reject — never a raw-TOP fallback. Completion measured by deleting fallback
  authority.
- **compat-handoff.md / bigint-retirement-design.md**: BigInt mixing is compat leakage;
  end state raw-i64-only, unprovable Number/BigInt flows = compile errors
  (`JZ_BIGINT_STRICT=1` semantics as default).

## Decision

**Mixed dynamic BigInt is a core product feature, not compat sugar.** The retirement
end-state is falsified by the repository's own history:

1. **Self-host is load-bearing mixed BigInt.** watr parses `i64.const` operands and needs
   real 64-bit parsing; retiring the dynamic half broke the self-compiled kernel
   (dc6139d9 wall, .work/todo.md:10044-10097). Raw-only-with-reject would reject jz's own
   self-host graph — the compiler could not compile itself.
2. **Raw-TOP fallbacks miscompile Numbers, not just BigInts.** v1's magnitude heuristic
   read `-5e-324` as a raw BigInt and compiled it to `-1` (v2 design §1). Ambiguity is
   physical; no analysis labeling makes a raw union distinguishable at runtime.
3. **Strict-only was already reverted once** (fc28a3da → 8b7277ab same-day revert).

Therefore:

- **Tagged carrier is the universal correct crossing** for any BigInt∪other edge
  (call, storage, closure, return, host). Raw i64 is an *optimization* applied only where
  the plan proves single-representation flow end-to-end.
- **RepresentationPlan is the sole representation authority.** Every edge gets exactly one
  action (RAW / BOX / REJECT). Analysis discovers facts; the plan chooses actions; emission
  never reconstructs a plan decision; optimizers preserve plan-materialized unions or
  invalidate the plan (this is the C5 obligation — see Consequences).
- **Host boundary is evidence-based per slot, one descriptor.** The wrapper dispatches on a
  per-export per-slot policy emitted by the compiler (RAW_BIGINT | TAGGED_VALUE | NUMBER |
  EXTERNREF, plus rest-element policy) — never by guessing from the absence of a box marker.
  Zero-evidence BigInt ingress **rejects with a typed TypeError**; it never silently
  stringifies or misdecodes (correct-or-reject doctrine).
- **`JZ_BIGINT_STRICT=1` remains opt-in** (reject-unprovable as a lint/deploy mode), never
  the default semantics.

## Release gates bound to this decision

- **No accepted program returns a known-wrong value at any optimization level.**
  KNOWN-WRONG pins are campaign trail markers only; the release gate is zero such pins on
  semantic paths. C5 (optimizer-erased materialization: inline + O3 select manifestations)
  is release-blocking.
- **jz×jz self-compile completes under wasm32's 4 GiB ceiling.**

## Consequences (the funded deletion phase, post-C5)

Completion is measured by deleting fallback authority, not adding planners (v2 design §8).
In order:

1. **Done (443dfc60):** legacy `bigintBoxed` authorities, field, clone row and
   consumers are deleted; storage/call/return/join edges read RepresentationPlan.
2. **Done:** joint dispatch is feature- and plan-gated; zero-BigInt programs emit no arms.
3. **Done (20fe3b22):** the result sentinel custom-section field, layout tables,
   interop decoder and hand-built wrapper lane are deleted.
4. **Remaining architectural follow-up:** collapse the duplicate semantic-kind lattice
   onto canonical kind facts; move `programFacts.paramReps` to SignatureSolution.
5. **Done:** erasure-diag.js and bigint-boxed-stats.js deleted as blocks.
6. **Done:** obsolete direction documents point here; bigint-retirement-design.md remains
   historical evidence of the wall.

Not in scope: `.work/compat-handoff.md`'s HASH dict-mode workstream (unrelated, still live)
and the jzify desugar-to-core direction (compatible: BigInt is core, not sugar — nothing
about generators/async/classes changes).
