# Round-3 Boxed-BigInt Design — Sound Boundary Boxing Without Runtime Disambiguation

Design produced 2026-07-29 at HEAD 18d9c056 (read-only agent), after round-1
(always-box: correct, warm-blocked 1.012-1.023 vs 0.99) and round-2 (boundary
boxing w/ runtime tag-check fallback: UNSOUND — raw bigint data can be
box-shaped) were both honestly reverted. Ledger context: .work/todo.md entries
"BOXED-BIGINT DESIGN COMPLETE 2026-07-27", "ROUND 1", "ROUND 2 WALL".

## 1. The invariant

The two prerequisite disjuncts are one fact viewed def-side and use-side:
COMPUTE the dataflow fact ("raw iff def AND every reachable use prove bigint")
and ENFORCE it structurally (box-dominance, zero runtime disambiguation):

> INVARIANT. For every VAL.BIGINT-kinded value V, the solver computes one
> frozen boolean bigintBoxed(V): false iff every consumer V's value can reach —
> intra-body AND cross-function, transitively — independently re-proves
> valTypeOf === VAL.BIGINT for that operand (the emit.js arithmetic/compare/
> typeof/bitwise sites already gated on VAL.BIGINT). If true, V is materialized
> as a real PTR.BIGINT heap box at the last point inside its raw-eligible
> region; every remaining read unboxes explicitly before raw i64 ops. No
> consumer of kind-erased input ever inspects bit SHAPE to decide box-vs-raw —
> kind-erased reads dispatch on the 4-bit PTR.BIGINT tag only, exact BECAUSE
> the write side guarantees no unboxed bigint content can reach the slot.

Checkable form:
- W (def-side): at every kind-erasing sink, a statically-BIGINT value's
  emitted IR subtree is rooted at boxBigInt(...) — never bare fromI64/asF64
  of a raw result.
- R (use-side): every generic reader (__to_num, __to_bigint, __eq dynamic
  fallback, __is_truthy, typeof runtime arm, __same_value_zero, __map_hash,
  interop decode) recovers bigint-ness via __ptr_type(v) == PTR.BIGINT, never
  the finite/nonzero/subnormal magnitude heuristic (emit.js 433-441 TYPEOF,
  number.js 1476-1489 __to_num — whose own comments confess the ambiguity).

Why sound vs round-2's wall: layout.js ptrBits (70-74) and wat/assemble.js
(54-60, 1301-1309) build NaN-box-shaped bit patterns as genuine BIGINT data.
Their reach-set is pure local arithmetic → bigintBoxed=false → 100% raw
forever. If the solver can't prove that, they get a real box BEFORE reaching
any dict — so later tag checks are exact, not guesses.

## 2. Erasure/recovery inventory

Arithmetic core stays RAW forever (both operands prove BIGINT at site):
emitNeg 277-307, ~ 4461-4478, + - * / % 3921/3992/4019/4056/4077, compound
bitwise 3810-3814, u+ guard 4008-4010, cmpOp pure-bigint 2454-2455. These are
why round 1 failed warm; untouched in round 3.

W-sinks (BOX REQUIRED, def-side):
1. Object/dyn-prop store — collection.js __dyn_set deps 1184, core.js 181-182
   generic i64 mover. Box at the emit.js assignment site, not in the mover.
2. Array elem store, non-uniform elem kind — kind.js VT['[]'] 239-247/253-264
   read mirror; write side = arr[i]=/push without proven uniform kind.
   BigInt64/BigUint64Array receivers exempt (row 8).
3. Set.add/Map.set/key hashing — collection.js 1168-1169, 2211-2212.
   Inherently polymorphic: unconditional box.
4. Call arg/return without uniform BIGINT proof — narrow.js paramReps/
   callSites lattice 2062-2148 (the nullability lattice 2108-2119 is the
   template to clone).
5. Closure capture — kind walk stops at '=>' (analyze.js 610); hard boundary.
6. Ternary merge across nullish arm — kind.js VT['?:'] 162-178 ("the one kind
   with NO runtime tag"); needs re-derivation, see risk 5.
7. Export/interop — narrow.js 2170-2178 thunks; interop.js isBox() 133,
   decode 181-182/354-357/465. isBox() is the same shape-heuristic class.
8. Atomics/DataView.getBig64 unproven receiver — atomics.js 63-75,
   typedarray.js 860/932. Exempt only when receiver provably BigInt64/U64.
9. String coercion of unproven join — emit.js tryConcatChain 1232-1234 bails
   to numeric-join → feeds read-row 1, not a fresh sink.

R-recovery (currently magnitude-heuristic → must become tag dispatch):
1. __to_num number.js 1469-1489. 2. TYPEOF.bigint emit.js 433-441.
3. __to_bigint number.js 1614-1623 (separate narrower gap — flag, out of
   scope). 4. __eq core.js 72-122 (sign-bit disjointness covers only negative
   raws). 5. __same_value_zero*/__map_hash — NO bigint arm today; ADD arm.
6. interop isBox() 133.

## 3. Solver/emit changes (check, not just implement)

1. reps.js REP_FIELDS += bigintBoxed (85-89 discipline, freeze).
2. analyze.js intra-body sink walk (clone the escapes precedent 279/578-598):
   mark bigintBoxed=true when value reaches any W-sink. poisonUndeclared's
   BIGINT scalar carve-out (401) is the base case.
3. narrow.js inter-function fixpoint: mergeRule('bigintBoxed') in the same
   runCallsiteLattice machinery as nullability (2062-2119); OR across
   call-sites + callee verdict; settle before runFixpointConverged (2056);
   stamp onto sig like r.val (2139-2147).
4. ir.js boxBigInt/unboxBigInt BESIDE asI64/fromI64 (326-338) — built on top,
   never retagging (30+ non-bigint callers). box = __alloc 8B + i64.store +
   mkPtrIR(PTR.BIGINT=5, 0, off); unbox = ptrOffsetIR + i64.load.
5. Generic i64 movers stay dumb; only the truly-generic dispatchers gain a
   PTR.BIGINT arm (exact by invariant W), same pattern as PTR.STRING/OBJECT.

## 4. Dbg-invariant design (JZ_DEBUG_INVARIANTS, per reps.js 91-96 pattern)

1. Def-side: boxBigInt throws if source kind ≠ VAL.BIGINT; raw fromI64 for a
   bigintBoxed=true name throws (round-2 class caught at COMPILE time).
2. Erasure-graph assert: post-emit walk per function — every W-sink store's
   value subtree roots at boxBigInt or proven-non-bigint, else throw with AST
   node + position. This is what would have caught the dict OOB pre-kernel.
3. Read-side trap arm (debug flag): if the OLD magnitude heuristic fires but
   __ptr_type ≠ PTR.BIGINT → trap loudly at the exact seam.
4. Fixpoint-completeness: after bigintBoxed settles, one extra propagation
   round must not flip any binding (assertBodyFactsFresh class).

## 5. Re-application list

Round-1 carry-over: PTR.BIGINT tag 5 (free, layout.js 27-39), 8-byte cell,
mkPtrIR-consistent; boxBigInt/unboxBigInt seam; three representation-
independent bug fixes (re-apply unconditionally): __is_truthy bigint arm
(core.js WAT + optimize/index.js inlined peephole copy, features.bigint-
gated), numLiteralNode ['nan'] marker, interop mem.read t===5.

Round-2's 8 fixes, reframed to the new read-side: emitLooseEq i64-type fix
(moot; __eq still needs tag arm); array elem unbox-on-read via tag; reduce VT
rule re-verify; DataView methodValType confirm; same_value_zero+map_hash
DESIGNED tag arms; ternary-nullish re-DERIVE (risk 5, not mechanical); box
atom-passthrough guard + interop decodeBigintResult (4 atoms).

## 6. Expected gates

Correctness: green (round 1 was already correct). Warm cap: holds — the
kernel's layout/assemble BigInt math is pure local arithmetic → settles
raw → zero alloc (round 1's regression was construction-boxing). Carrier
rows clear as side effect (tag dispatch replaces magnitude heuristic).

## 7. Honest risks

1. SOLVER COMPLETENESS IS THE WHOLE BET — a missed sink (generators, await,
   destructuring paths analyze.js walkers may not traverse) reproduces
   round 2 relocated. Mitigation: erasure-graph assert on the FULL corpus
   incl. dict/object-heavy programs BEFORE gates get called green.
2. Round-2's exact trigger is unrecoverable from tree (revert was clean).
   FIRST STEP OF IMPLEMENTATION: reconstruct a dict+bigint repro and prove
   assert §4.2 fires on it — if not, the ASSERT is incomplete, not the bug
   gone.
3. Fixpoint cost: another O(call-sites) lattice — watch compile-time in
   compileProfile; a real unbounded cost if it regresses.
4. __to_bigint pass-through gap is a separate spec bug — decide explicitly,
   don't roll silently into "round 3 done".
5. Ternary+nullish BIGINT carry: kind.js documents "no runtime tag" as a
   design property; boxed values DO have a tag — re-derive, don't carry over.
6. BigInt64Array "closed system" exemption breaks if read via generic
   callbacks (.map/.forEach unspecialized closure param) — check explicitly,
   don't assume exempt by category.

## Round-6 execution blueprint (2026-07-29, verified line-by-line against af731cf0)

PREREQS CLOSED: (a) closure-return-kind pre-pass landed af731cf0; (b) ternary-
nullish single seam = carrierF64 (ir.js 406-408) — ALREADY the choke-point for
8/9 W-sinks (grep call sites: bridge.js 91, compile/index.js 1815,
emit-assign.js 35, array.js x9, object.js 47, collection.js 1549-1550/1971,
function.js 291, emit.js 1175/2415-2416/3454/3752); ternary needs ZERO
special-case code — bare-name arm boxes at its own decl (refPayload branch
emit.js 4291-4297 passes arms untouched), inline-expr arm self-boxes via one
isProvenBoxedBigint clause for '?:'-with-nullish-carry. OWNERSHIP RULE (kills
round-5 bug #4): decl/assign ASK isProvenBoxedBigint, never box
unconditionally; (c) O0 parity divergence DOES NOT EXIST at HEAD (round-5
artifact; re-verify after each emit stage).

EXECUTE IN ORDER (all file:lines verified, not guessed):
1. layout.js 27-39: PTR.BIGINT=5.
2. ir.js beside asI64/fromI64 (326-338): boxBigInt (asI64-normalize, $__alloc
   8 via allocPtr pattern 1565-1578, i64.store, mkPtrIR); unboxBigInt
   (i64.load at ptrOffsetIR — SAFE: PTR.BIGINT not in FORWARDING_MASK, plain
   offset return, core.js 279-290); isProvenBoxedBigint (bare name →
   repOf .bigintBoxed, fail toward FALSE; '?:' BIGINT-nullish-carry → true;
   MUTATE_OPS node → delegate to node[1]; else false); unboxBigIntIfBoxed;
   carrierF64 BIGINT branch (box iff not proven boxed).
3. emit.js: readI64/readI64Var wrappers; swap at emitNeg 277-287, postfix
   +/- 3905/4039/4043-4044, binary + - * / % 3966/4044/4069/4106/4127, ~ +
   bitwise 4518/4526, compoundAssign 3540, bitwise compound 3836, cmpOp
   BIGINT 2450/2455, ++/-- 3886. Write-backs at 3540/3836/3886 use
   bigintResultCarrier (boxed rep → boxBigInt else fromI64). Decl
   materialization: emitDecl 1731-1765 new branch before f64 coercion;
   reassign '=' 3772-3791 same gate. coerceArg 1164-1177: both directions
   vs param.bigintBoxed (narrow.js 2164-2226 stamps it).
4. DO NOT TOUCH: return-statement emission (3710-3768) and
   synthesizeBoundaryWrappers (compile/index.js 1504-1526 already special-
   cases valResult BIGINT to cross raw). Returns box at DECL sites per the
   invariant — params-only fixpoint is CORRECT.
5. R-recovery (highest risk, WAT surgery — do $__eq FIRST, parity after):
   $__eq core.js 72-122 PTR.BIGINT deref-compare arm parallel to the STRING
   arm 107-121, features.bigint-gated (5579/6487 call sites — hottest
   helper); $__is_truthy 145-159 + optimize/index.js peephole twin;
   __same_value_zero/__map_hash content arms (collection.js); number.js
   1779-1851 bigint:toString/asIntN/asUintN via readI64; interop.js
   133/163-182/354-357/465 type===5 arm; TYPEOF.bigint emit.js 433-441 tag
   check before the magnitude fallback.
6. Erasure assert + carrier un-curation + full 7-gate battery (incl. watr
   35/35, warm ≤0.99 AC).
WHY ROUNDS 5-6 STOPPED: wiring consumption without ALL R-recovery arms
regresses the EXISTING battery (analyze/narrow already mark real bindings
today — the fact goes live the moment emit consumes it). Land all-or-nothing.

## Implementation order (de-risked)

1. Build §4.2 erasure-graph walk as a DIAGNOSTIC first (pre-boxing it fires
   on every bigint→sink flow = empirical inventory); run over corpus +
   kernel graph; cross-check §2. 2. Reconstruct dict+bigint repro; prove
   diagnostic catches it. 3. Solver fact + fixpoint. 4. Emit boxing +
   reader tag arms + re-applications. 5. Full gates incl. warm cap.
