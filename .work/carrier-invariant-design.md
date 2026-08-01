# Represented-carrier invariant — design (2026-08-01, re-audit #6 response)

Read-only deliverable. Full sweep: 120 rows (16 contexts x 3 O-levels x 2
arms + follow-ups) against a host-JS oracle → 51 mismatches, ALL O-levels
(representation bug, not an optimizer artifact). Confirms and extends the
audit's 19 sites: array/object/Map/Set construction AND mutation, Map/Set
KEYS, JSON.stringify, direct + captured closure args, String()/template
stringification, computed property keys. Controls: arithmetic stays
correct (the deliberately-raw case); ==/in probes non-discriminating by
construction.

## TWO root mechanisms (not one)

MECHANISM A — enumerated-list drift, proven structurally: emit-assign.js
:42's storedValue is the CORRECT shape (hasAmbiguousBoolMerge ?
emitIdentitySafe : carrierF64(emit)) — but the unsound half,
`carrierF64(node, emit(node))`, is hand-reimplemented UNFIXED 16 times:
module/array.js x10 (638,657,1209,1297,1407,1509,1515,2103,2155,2172,
2193 — literal/push/unshift/splice...), module/collection.js x4
(1550,1551,1563,1972 — Map value/KEY/get, structuredClone),
module/object.js x1 (line 48 — a LOCAL storedValue clone with NO guard,
feeding 4 uses), module/function.js x1 (291 — closure-arg boxing).
carrierF64 itself cannot fix this (receives already-emitted IR — the
merge collapsed before it runs; the guard must precede emit()).

MECHANISM B — detector blind spot (NEW, independent): VT['()'] is a
call-dispatcher only; a parenthesized NON-call `(x>0)` → ['()',['>',...]]
matches no branch → valTypeOf null → hasAmbiguousBoolMerge false. The
wrongness and its detector share the blind spot BY CONSTRUCTION —
`((x>0)&&1)` fails at O0/O2 for real (verified live: f(false) → 0, JS
false). Even perfect consumer enumeration cannot close this. Fix:
valTypeOf/VT['()'] unwraps single-arg non-call grouping nodes (pure
structural). PREREQUISITE for any invariant.

QUARANTINE CLOSED 2026-08-01 (dedicated hunt at HEAD a1cad96f): the
identical-subtree return anomaly does NOT reproduce — it was MECHANISM B
all along (both branches independently computed the same wrong value
through the VT['()'] blind spot; duplication was incidental, never
causal). CSE/dedup class structurally impossible: the parser allocates
fresh nodes per occurrence (M1 !== M2 verified), all identity-keyed
caches are WeakMaps, the return handler runs per-node with no cross-
occurrence memoization. Closed by 8a0bad4f + f6ec5129 as a side effect;
pinned at all tiers in test/booleans.js. The only live remnant in the
family is the KNOWN scalar decl-init gap (emit.js ~1712 plain emit(init)
— deliberately unfixed pending the self-host emitDecl wall, tracked by
the captured-then-read oracle row).

## Decision: (a) box-at-production via ONE producer chokepoint

Promote storedValue to src/bridge.js as THE exported chokepoint; delete
module/object.js's local clone; replace all 16 raw sites with
storedValue(node). NET CODE SHRINK. Rejected (b) VAL.BOOLNUM lattice
member: the codebase has ZERO switch/case on VAL.* (115 scattered ===
VAL.BOOL comparisons) — no structural switch to hang exhaustiveness on;
(b) rebuilds the rejected enumeration at the tag layer and doesn't fix
mechanism B. Rejected (c) more list entries: the sweep found sites
outside the original 19 (String, templates, computed keys) — drift is
the disease.

COST (bounded, enumerated): arithmetic consumers that trust vt===NUMBER
to read raw bits = 7 sites (emit.js:2391-2392 emitLooseEq numA/numB
asF64 branch; emit.js:4318,5691; ir.js:1188,1200,1308,1335) — fix via
hasAmbiguousBoolMerge-aware coercion or unconditional toNumF64 (already
atom-aware: VAL.BOOL → convert truthyIR — '+'s generic fallback is
ALREADY safe). CENSUS: ZERO ambiguous-merge shapes in the entire bench
corpus — always-boxing is free in hot code. Self-host structural grep now
~21 candidate sites (up from the original design's 9) — RE-RUN the walk
at implementation HEAD.

## Order + gates

1. Mechanism B fix (VT['()'] grouping unwrap) + its oracle row. Gate:
   kernel-parity byte-identity (no-op for non-parenthesized shapes).
2. 13 PENDING-FIX oracle rows (array/object literal, Map value+key, Set,
   push, String(), template, JSON, direct arg, captured-read, computed
   key, parenthesized-&&) — land BEFORE production changes.
3. storedValue promotion + 16-site substitution + object.js clone
   deletion. Gate: rows 1-12 flip → AGREE; parity 33/33 byte-identical
   (non-ambiguous code pays nothing); battery; self-host TWICE with
   fresh dist rebuilds (the 190-precedent gate).
4. 7-site arithmetic-consumer sweep. Gate: arithmetic control ternaries
   byte-identical (the anti-190 gate).
5. String()/template/ToPropertyKey formatter sub-sweep (un-traced —
   real follow-up work, same storedValue-before-stringify shape).
6. Self-host ~21-site walk with the real predicate.

SCHEDULING: 4 of 5 target files are under the concurrent Error-model
wave — land AFTER it merges (no semantic overlap found in its diff; all
its hunks are throw-site code additions).

## Risks

Mechanism-B siblings (other AST-shape opacity in valTypeOf fallthroughs —
audit VT['()'] fallthrough after landing); the formatter sub-sweep may
hide its own duplication; the quarantined identical-subtree anomaly is
NOT closed by this design; self-host census is a regex proxy — re-verify
with the real predicate.
