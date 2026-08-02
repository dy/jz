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

DECL-INIT WALL ROOT-CAUSED 2026-08-01 (the kernel-scale mystery
DISSOLVED — deterministic NATIVE repro, no wasm build needed):
carrierF64→asF64→boxPtrIR rebuilds ptrKind-tagged IR through typed()
(ir.js:38), which sets ONLY .type — .ptrKind/.ptrAux/.closureFuncIdx are
ERASED. Bits correct (NaN-boxed pointer), metadata gone. The P1
plan/emit-parity predictor (inheritPtrAliases, analyze.js:1916; assert
emit.js:1819) then drifts — fires deterministically during a plain
`node scripts/build-dist.mjs` with DBG_INVARIANTS forced true ("P1
predictor drift: (top)/d4654 predicted object, emit sees undefined";
the earlier 'self-host-only mystery' existed because the invariants
fold out under the wasm target AND were never armed during the build
step). CLOSURE aliases lose closureAux minting (emit.js:1830 gate never
fires) → the i32/f64 desync and, compiling self.js itself, total export
loss. CAUSAL PROOF: identical forced-invariants build without the
storedValue patch = ZERO violations across the full 14.8MB O3 self
compile; failure is level-independent (optimize:false through O3).
FIX (conceptual, named): make boxPtrIR/asF64 TAG-PRESERVING (copy
.ptrKind/.ptrAux/.closureFuncIdx onto the boxed result) — repairs every
asF64 caller on tagged IR, then the decl-init site can take storedValue
and oracle row 11 graduates. Residual lead: the triggering alias shape
lives in self.js's desugared source (synthetic param arg0f5715, schema
aux 0x2A8) — trivial synthetic probes don't hit it; the shaped-parser/
dict-rows unification hypothesis is NOT confirmed by this bug (this one
is a plain deterministic metadata-erasure, not context-dependent) but
the 0x2A8/__schema_tbl lead is noted for those hunts.

TAG-PRESERVING REBOX LANDED, DECL-INIT WALL STAYS CLOSED 2026-08-01
(implementation session against the FIX above): the P1-tag-erasure
diagnosis was CONFIRMED correct and its fix LANDED — but the "then the
decl-init site can take storedValue" conclusion was WRONG. Two findings:
(1) the literal fix as specified ("copy .ptrKind/.ptrAux/.closureFuncIdx
onto the boxed result") is UNSOUND, not just conceptually incomplete —
tried verbatim, it CRASHES. `.ptrKind`/`.ptrAux` are not inert metadata;
they're a live dispatch convention ("`.ptrKind != null` ⇒ this node's OWN
storage is an unboxed i32 offset") read by asF64 itself plus truthyIR,
writeVar, and the matchF64Bits/isNullish family — none of which re-check
`.type` first. Stamping them onto boxPtrIR's f64-typed result makes a
LATER asF64 pass over an already-boxed value re-enter boxPtrIR and emit
`i64.extend_i32_u` on an f64 operand — confirmed live (control build:
reverted the rename, kept the decl patch, got exactly this wasm
validation failure). Landed fix instead carries the source's kind/aux
under NEW, non-colliding names (`.srcPtrKind`/`.srcPtrAux`, ir.js
boxPtrIR) that nothing pre-existing reads — additive by construction,
verified byte-identical on the full kernel-parity corpus (33/33) with the
rename alone. `.closureFuncIdx` had no such collision (copied under its
own name; in practice always a no-op — every current minter already
builds an f64-typed node directly, so it never reaches boxPtrIR as
`i32node`). PROVEN with the prescribed forced-invariants recipe: a
fresh native `build-dist.mjs` under `JZ_DEBUG_INVARIANTS=1` throws ZERO
P1 predictor errors, confirmed BOTH with and without the decl patch
applied (four full builds: control-broken/decl-patch reproduces the
exact "P1 predictor drift: (top)/d4654 predicted object, emit sees
undefined" from the entry above; corrected-fix/decl-patch is clean;
corrected-fix alone and clean-baseline-alone are both clean). This part
of the design's diagnosis and fix is SOUND and LANDED (src/ir.js
boxPtrIR, src/compile/emit.js's P1 assert reading `val.ptrKind ??
val.srcPtrKind`).
(2) Taking emitDecl's init through storedValue REGARDLESS is a SEPARATE
bug the tag fix does not touch, re-confirming the superseded
"RE-CHARACTERIZED" entry below rather than unifying with this one: a
fresh dist built with `val = viewInit || storedValue(init)` PLUS the tag
fix compiles cleanly natively (zero P1 fires — mechanism (1) really is
fixed) but the resulting dist/jz.wasm then loses every export for EVERY
compiled program, including `export let f = (x) => x + 1` — a program
with a closure-literal init that storedValue boxes to the IDENTICAL node
as plain `emit(init)` (mkPtrIR's result is already f64-typed with no
`.ptrKind`, so asF64's early `n.type === 'f64'` return hands it back
unchanged either way — provably the same value, not just probably). That
rules out a semantics/value bug in the patch: the miscompile is in how
the native compiler compiles THIS CALL SHAPE inside its own emitDecl
source at THIS position, independent of what the call computes or
whether any ambiguous-merge/pointer-alias shape is even in the compiled
program. WALL STAYS CLOSED: emit.js ~1712 keeps `val = viewInit ||
emit(init)`; kernel-oracle's 'captured-then-read' row (row 11) stays
PENDING-FIX. Verified no regression either way: kernel-parity 33/33
byte-identical, kernel-oracle 430/430 assertions (all PENDING-FIX rows,
including row 11, still correctly WRONG — no accidental flip), full
battery 3203/0/6 (unchanged from baseline), selfhost.js 21/21, warm gate
0.985× / fresh 0.820× (both under cap — the tag-copy is a genuine no-op
for every existing call site, confirmed by the byte-identical parity
corpus, not just "trivial cost"). NEXT: the total-export-loss shape is
now isolated to an extremely tight, fully mechanical repro (one call
site, one line, value-identical either way) — a stronger candidate for
the shaped-parser/dict-rows kernel-scale family than anything found so
far; a future hunt should start from "native miscompiles ITS OWN
compilation of `x ? A(y) : B(y)`-shaped storedValue at this exact
position in emitDecl" rather than re-deriving the P1 mechanism.

DECL-INIT WALL RE-CHARACTERIZED 2026-08-01 (superseded by the above) (dedicated hunt, worktree,
3 full builds patched/control/patched): the wall is NOT the banked
"narrow captured-then-read gap" — the one-line storedValue(init) patch
at emit.js ~1712, SELF-COMPILED, produces TOTAL EXPORT LOSS: every
exported function in every program vanishes from the export section
(even `export let f = (x) => x`), all O-levels; function bodies present
and plausible — the miscompile is in export bookkeeping, not the changed
line's codegen. SECOND symptom, independently decodable: capture-free
closure locals desync (kernel emits bare local.get i32 → local.set f64,
instantiation fails) — the SAME program is correct natively at every
level INCLUDING under JZ_DEBUG_INVARIANTS (the P1 drift assert never
fires natively). RULED OUT: bridge indirection (storedValue is local to
emit.js), capture-after-nested-emit (single emit() call, no mutable
captures), code shape (the IDENTICAL ternary is self-host-green at 20+
sites including one 90 lines earlier in the SAME emitDecl function).
SURVIVOR: the enclosing-scale self-host miscompile class (outline-hunt
arrayElemValType + dict-rows recursive-count precedents) — now with the
class's sharpest-ever repro (one line, total blast radius, 3-build
verified). Prior "narrow gap" note likely a stale-dist probe artifact
(missing export misread as wrong value — the ledger's own dirty-tree
risk). NEXT (bounded, concrete): build ONE kernel tier with
JZ_DEBUG_INVARIANTS forced true at self-compile (small scripts/self.js
shim — the flag folds false under the wasm target today) so the P1
assert fires IN-KERNEL and localizes; fallback = the watr-diff harness
on emitDecl's module slice with the call stubbed. Medium confidence on
mechanism, high confidence on blast radius. Confidence this is the SAME
root as shaped-parser/dict-rows kernel-scale family: plausible, would
unify three banked hunts into one.

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
