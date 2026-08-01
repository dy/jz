# Ambiguous BOOL-merge identity design (2026-07-31)

Read-only design deliverable for the mixed-BOOL-return open class. KEY
PREMISE CORRECTION: the general ≥2-return class is CLOSED at HEAD
(mixedAtomReturn generalization, boolconst AGREE) — the remaining open
work is the MERGE-OPERATOR hole, and it is WIDER AND LIVE beyond the
pinned s?1:false oracle row.

## New live miscompiles found (native, O2, value-wrong TODAY)

- 7b: `(s?1:false)===false` INLINE (no function boundary) → wrong
- 7c: `typeof (s?1:false)` → "number" where JS says "boolean"
- 10a: `((x>0)&&1)===false` → wrong (&& shares the hole; || only
  vacuously safe in the tested shape)
- 7a: the pinned s?1:false function-boundary row (known)
All four fire through ONE mechanism: emitStrictEq's differing-primitive-
class STATIC FOLD (emit.js:2412-2415) — `x===false` folds to compile-time
FALSE for both arguments (not a bit-compare bug, a constant fold).
Symmetric true/1.0 collision exists (s?0:true).

Full envelope table in the agent deliverable (13 shapes tested against a
host-JS oracle): everything else correct, including NUMBER+atom returns,
STRING+BOOL, closures (boxedResult), arithmetic consumers of the ternary
(case 11 — the coercion carry is CORRECT there and must stay).

## Root mechanism

kind.js VT['?:'] (142-179) and VT['&&']/['||']/['??'] (196-202) carry a
DELIBERATE benign coercion: BOOL-vs-NUMBER merge reports NUMBER (raw 0/1
bool carrier IS its ToNumber image — keeps hot numeric code off
polymorphic dispatch; kind.js:147-152). Sound for arithmetic, unsound at
identity-observing consumers. Six sites trust valTypeOf===VAL.BOOL as
exhaustive: index.js:1299 mixedAtomReturn gate; ir.js:406 carrierF64
(post-hoc — STRUCTURALLY cannot fix this: by then the coerced false and a
genuine 0 are the same bits; the fix must happen inside the merge's own
emission while arms are separately known); emitStrictEq fold 2412-2415 +
box decision 2428-2432; emitTypeofCmp 395; the four merge arm-
materialization guards (4301/4438/4505/4555 — already box BOOL-vs-opaque,
deliberately exclude BOOL-vs-NUMBER).

## Why the reverted broad fix broke 190+ kernel rows (reconstructed)

Its trigger was "kind not yet proven non-BOOL" — TIMING-dependent (
narrowValResults fixpoint can resolve after the gate ran), so it boxed
uniform-NUMBER self-host helpers; self-compiled raw-f64 consumers then
read NaN-boxed atoms as numbers. Lesson: require STRUCTURAL evidence of
genuine mixing, never "unproven".

## Recommended design (hybrid a, bounded)

1. `hasAmbiguousBoolMerge(node)` in kind.js beside VT['?:'] — pure
   structural predicate, true exactly where the merge coercion branch
   fires (kind.js:160-161, 199-200), recursive through nested merges;
   BIGINT/nullish carve-outs (162-177) stay excluded. NO timing
   dependency — categorically unlike the reverted trigger. isConst's
   if/two-return shape is NOT in the trigger set (stays on the verified
   mixedAtomReturn path).
2. `emitIdentitySafe(node)` in emit.js — generalize the EXISTING
   per-arm-materialize-then-select code (4298-4311 ?:, 4432-4448 &&,
   ||/?? twins) with the NUMBER exclusion lifted, taken ONLY from
   enumerated escape sites AND only when hasAmbiguousBoolMerge; else
   byte-identical degradation to emit(node).
3. Wire at the six sites: emitStrictEq fold+box (guard with
   !hasAmbiguousBoolMerge(a) && !hasAmbiguousBoolMerge(b) before
   trusting collapsed kinds; else route through emitIdentitySafe and
   bit-compare); emitTypeofCmp; mixedAtomReturn tail (additive single-
   return admission); container-store/closure-arg boxing (emit-assign.js
   :35, emit.js:3468).
NO unboxing anywhere — nothing currently expects atoms at these sites.
Rejected: (b) general consumer-context threading through emit() — the
reverted fix's pervasive shape + the emit.js 3805-3821 re-emission
self-host hazard; (c) return-tail-only — misses 7b/7c/10a and the actual
fold mechanism.

## Self-host safety

Structural trigger = explicit ?:/&&/||/?? node with one BOOL leaf and a
NUMBER/unproven sibling. Grep across src/+module/: 9 matches, none in
identity-observing positions (list in deliverable — walk it during
implementation). Byte-identical for every non-matching node — the same
non-regression shape that got mixedAtomReturn to 0 regressions.

## Order + gates

1. Predicate + direct unit tests (mirror VT truth table).
2. emitStrictEq + emitTypeofCmp wiring — flips kernel-oracle s?1:false
   PENDING-FIX→AGREE (the not() tripwire failing = definition of done),
   both legs.
3. Return-tail + && (add a NEW oracle row for 10a — live, not
   hypothetical) .
4. Container-store/closure-arg sites.
5. Gates each step: battery, kernel-parity 33/33 byte-identity
   (arithmetic ternaries MUST stay byte-identical — the scoping's whole
   point), kernel-oracle AGREE growing, kernel-target self-host leg run
   TWICE with fresh dist rebuilds (the step that would have caught the
   190-failure class — non-negotiable).

## Risks

- Source-grep is a snapshot; emit-synthesized merges (??=, optional
  chaining desugars) need the predicate on generated shapes too — second
  sweep once the predicate exists.
- emitStrictEq's STRICT_PRIM fold soundness beyond this bug: flagged for
  the same sweep (other resolveValType===VAL.BOOL trust points).
- Perf claim (byte-identical non-ambiguous case) wants parity-corpus
  confirmation, not assertion.
