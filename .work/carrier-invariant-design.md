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

EXPORT-LOSS MECHANISM ROOT-CAUSED AND FIXED 2026-08-03 (dedicated hunt,
following the ROUND 8-9 outline-hunt method: dump native WAT of the victim
function, diff good vs patched, locate the wrong instruction sequence). The
2-sided control reproduced exactly as banked: `val = viewInit ||
storedValue(init)` at emit.js ~1712 compiles natively clean, but the
resulting dist/jz.wasm loses every export for every compiled program;
restoring `emit(init)` restores exports. WHAT the bad kernel does wrong,
localized first (compileViaKernel wat:true across optimize levels on
`export let f = (x) => x + 1`): the function BODY is correct at every level;
`(export "f")` is simply ABSENT at O0/O1 (function present, unreferenced);
at O2/O3 watr's own DCE — correctly, given no export/no caller keeps it
alive — removes the function entirely, `(module)` with zero content. So the
"total export loss" symptom is not optimizer-level-dependent corruption; the
export FLAG itself never gets set, and DCE just does its honest job on an
(wrongly) unreferenced function afterward.
WHERE, localized second (native `compile(self.js source, {wat:true})`,
patched vs unpatched, full kernel WAT dump ~350MB each, `$m65_index$defFunc`
extracted and diffed after normalizing synthetic temp-name suffixes):
`prepare/index.js`'s `defFunc` — `const exported = !!ctx.func.exports[name]
&& ctx.module.moduleStack.length === 0` (a plain BOOL const, later read back
into the `funcInfo` object literal `defFunc` pushes onto `ctx.func.list`).
Good build compiles this as a plain i32 `f64.gt`/`i32.eqz` comparison chain
(the local `exported` stays i32, matching a BOOL-kind local's native WASM
storage). Patched build wraps the SAME comparison in `__mkptr_0_d_`
(carrierF64→boolBoxIR boxing, exactly what storedValue is FOR) then
IMMEDIATELY `select(i32.wrap_i64(i64.trunc_sat_f64_s(<the just-boxed
atom>)), i32.const 0, f64.ne(atom, inf))` — this is `toI32` (ir.js:335,
ECMAScript ToInt32) applied to the boxed atom.
MECHANISM (the wrong instruction sequence, and why): emit.js's decl-init
local-storage coercion ladder (now ~1932, was line 1895) —
`localType==='v128' ? val : localType==='f64' ? asF64(val) : val.type===
'i32' ? val : toI32(val)` — assumed any `val` that isn't already i32-typed
must be a genuine f64 NUMBER needing real ToInt32 narrowing into an i32-typed
local. That held for every existing call site because plain `emit(init)`
NEVER returns an f64-typed result for a BOOL-typed init (it always emits the
natural i32 0/1, taking the `val.type==='i32'` arm — never reaching
`toI32`). `storedValue(init)` breaks the invariant: for a BOOL-typed init it
deliberately boxes to an f64 NaN carrier ATOM (TRUE_NAN/FALSE_NAN — meant for
heap/object escape, typeof/String/strict-eq-safe, NOT a numeric quantity).
Landing on this ladder against an i32-typed local (chosen by the compiler
independently, for a BOOL local it believed never escapes as a boxed value),
the ladder's `else` arm ran `toI32` on the atom. ToInt32(NaN) = 0 by spec;
TRUE_NAN and FALSE_NAN are BOTH NaN bit patterns, so toI32 collapsed EVERY
boxed boolean — true or false — to i32 0. `exported` therefore reads 0
(false) for every function `defFunc` ever promotes, in every program the
resulting kernel compiles: universal, deterministic, program-independent
export loss. NAMED FAMILY: MECHANISM C (new, added to the two at the top of
this doc) — narrow-local coercion blind to carrier-atom representation: a
value's WASM type tag (i32 vs f64) was used as a proxy for "is this a raw
number/boolean vs a boxed carrier atom," which held everywhere until
storedValue was introduced at a site whose target local had been narrowed to
a type storedValue's own boxed output no longer matches. Not one of the four
prior class precedents (element-fact misproof, capture-after-nested-emit,
boolean-return collision, closure-capture staleness) — a genuinely new one,
sibling to MECHANISM A/B's representation gaps but at the LOCAL-NARROWING
layer instead of the field-storage layer.
FIX (landed, src/compile/emit.js): the ladder now checks `valTypeOf(init)
=== VAL.BOOL` before falling to `toI32` and takes `unboxBoolIR` (ir.js:469 —
existed, unused anywhere, apparently minted for exactly this) — bit-
extraction (shift+mask off the NaN payload) instead of numeric truncation.
NO-OP at HEAD: kernel-parity 33/33 byte-identical, kernel-oracle 451/451,
full battery 3232/0/6 (18832 assertions) — `emit(init)` never produces an
f64-typed BOOL today, so the new branch is dead code until a decl-init call
site actually feeds one in. PROVEN live (not assumed): `val = viewInit ||
storedValue(init)` PLUS this ladder fix → fresh dist/jz.wasm compiles
`export let f = (x) => x + 1` with `(export "f")` present at EVERY optimize
level (0/1/2/3), matching the good kernel byte-for-byte on that probe.
WALL STAYS CLOSED ANYWAY — a SECOND, independent divergence: with
storedValue live at every decl (fix included), test/kernel-parity.js's
'dict' corpus entry (`d[c] = (d[c] || 0) + 1`) diverges from native at O2/O3
only (kernel WAT ~3% larger; O0 byte-identical; native vs kernel wasm bytes
10859 vs 11199 @ O2, 11250 vs 11552 @ O3). No BOOL-atom coercion involved —
a separate MECHANISM A site (one of the 16 hand-reimplemented
`carrierF64(node, emit(node))` sites this doc already catalogs, or one of
the 13 PENDING-FIX oracle rows the "Order + gates" section already gates
production changes behind) getting exercised for the first time now that
storedValue is live at every decl, not chased further this session (separate
root, separate hunt — start from `test/kernel-parity.js`'s 'dict' CORPUS
entry directly, native-vs-kernel WAT diff at O2, same method as above).
`captured-then-read` oracle row stays PENDING-FIX: the export-loss blocker
that made turning storedValue on here catastrophic is gone, but the wall
stays closed until the dict-O2/O3 divergence is independently named — DO NOT
flip the decl site to storedValue without first closing that gap (kernel-
parity would go red on 'dict' at O2/O3, caught live this session).

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

## Wall's final status (2026-08-03, audit-#8 P0-4 Part 2 — read this LAST,
## it supersedes every "chase the dict-O2/O3 divergence" note above)

STILL BANKED, STILL CLOSED. The dict-O2/O3 divergence entries above (the
"WALL RE-CHARACTERIZED" / "TAG-PRESERVING REBOX" / "EXPORT-LOSS MECHANISM"
sequence) all predate this entry and describe REAL, LANDED work — the
export-loss MECHANISM C fix (2026-08-03, earlier in this file) IS in
production and IS a structural no-op today, confirmed again this session.
What follows is this session's OWN attempt and its own, DIFFERENT finding.

The dict-O2/O3 divergence itself WAS finally named: SELF-HOST GENERATIONAL
DRIFT (see .work/todo.md's Part 2 entry, dated 2026-08-03, for the full
worktree WAT-diff evidence) — `storedValue(init)`'s non-ambiguous branch
boxes every VAL.BOOL-typed decl, not just ambiguous BOOL∪NUMBER merges,
reboxing thousands of unrelated locals throughout self.js's own compiled
body and shifting watr's inliner decisions for unrelated target programs.
Benign in itself (WAT-diff showed only inliner boilerplate, never a
changed value), and fully AVOIDABLE by narrowing the gate to exactly what
the wall's repro needs: emit.js's own `argIR` (`hasAmbiguousBoolMerge(node)
? emitIdentitySafe(node) : emit(node)`) instead of the wider `storedValue`.
`val = viewInit || argIR(init)` proved byte-identical on kernel-parity's
FULL byte-identity corpus (33/33, dict included) — the generational-drift
chain genuinely never fires with this narrower substitution.

BUT a SECOND, unrelated self-host miscompile surfaced that the parity
corpus doesn't exercise: test/kernel-oracle.js's 'closure' AGREE row (a
captured-and-MUTATED outer `let`, jz's `ctx.func.boxed` heap-cell path)
compiled via the resulting self-hosted kernel throws
`WebAssembly.Module(): ... local.set[0] expected type f64, found local.get
of type i32` — genuinely INVALID WASM, not a shape difference. A clean
3-way worktree A/B isolated the cause precisely to THIS substitution (not
"any emit.js edit" — this session's other two parts also edit compiler
source and self-host cleanly). First-localization: native WAT-diff of
`scripts/self.js` compiled with vs without ONLY the argIR substitution
(no self-hosting needed to see the shift) shows `src/prepare/index.js`'s
`resolveCallee` — an unrelated PREPARE-phase function — has its compiled
locals shift by exactly one synthetic temp name, with everything
downstream renumbering. Working hypothesis, NOT yet proven: the argIR
call-site TEXT change in emitDecl.js shifts the GLOBAL `temp()` counter
while the compiler compiles ITS OWN source, which is normally harmless but
collides with a latent watr inliner/local-coalescing bug somewhere between
`resolveCallee` and the closure-boxing codegen it doesn't itself touch —
the SAME outline-hunt self-host-miscompile CLASS as the export-loss entry
above, a NEW, not-yet-root-caused instance of it.

REVERTED before landing (`src/compile/emit.js`'s decl-init line stays
`viewInit || emit(init)`) — the closure-decl miscompile is strictly worse
than the wall itself (a real WASM-validation failure vs. a known,
documented, narrowly-scoped value gap), so shipping it would trade a
smaller bug for a bigger one. kernel-oracle's 'captured-then-read' row
(and the 'computed member key read (named local, ...)' shape the same fix
would have closed as a side effect) both stay exactly as they were before
this session — PENDING-FIX / undocumented, not flipped.

NEXT (bounded, concrete): start from the `resolveCallee` compiled-local
shift — it reproduces with a cheap NATIVE WAT diff (no self-host build
required, ~5 min saved per probe cycle vs. this session's earlier
per-experiment full builds) — and trace which of `resolveCallee`'s callees
(`isDeclared`/`resolveScope`/`hasFunc`/`includeForCallableValue`) actually
get inlined into it, and why the one-local shift produces a genuine type
mismatch rather than pure renaming. A fresh pair of eyes on whether the
`temp()` counter is TRULY global (vs. per-function, in which case the
"shifts everything downstream" framing above is itself wrong and the real
mechanism is something else) is the fastest way to falsify or confirm the
working hypothesis.

ROUND 2 (2026-08-05, time-boxed ~10-probe re-attempt): the `resolveCallee`
lead above is FALSIFIED, cleanly — `temp()`/`freshLocal` (src/ir.js:742) key
off `ctx.func.uniq`, freshly reset PER FUNCTION (`ctx.func.locals.has(name)`
guards the dedupe loop too), never global. The observed one-local shift in
`resolveCallee`'s compiled body needs no cross-function theory at all:
`resolveCallee` ITSELF (src/prepare/index.js:2333) contains `const local =
scopes.length && isDeclared(callee)` — `scopes.length` is NUMBER,
`isDeclared(callee)` is BOOL, an ambiguous BOOL∪NUMBER merge by the exact
shape `hasAmbiguousBoolMerge` targets. The argIR patch changes ITS OWN
codegen at that exact line (confirmed: native `compile(selfSrc,{wat:true})`
control-vs-patched diff of `resolveCallee`'s compiled body shows precisely
one fewer local, `$tb2` gone, everything downstream renumbered by exactly
one — not a mystery, a direct and correctly-scoped effect of the patch on a
line inside the compiler's own source that happens to itself be an
ambiguous-merge decl). Dead end as a causal lead for the closure bug.

The REAL failure was reproduced and localized instead, directly at the
banked repro shape (kernel-oracle 'closure' row, `export let make = (n) =>
{ let total = 0; const add = (x) => { total += x; return total }; for (let
i = 0; i < n; i++) add(i); return total }`), via a self-hosted `dist/jz.wasm`
rebuilt with ONLY the `val = viewInit || argIR(init)` substitution live:
`WebAssembly.Module(): ... local.set[0] expected type f64, found local.get
of type i32` at O0 (function #5), `local.tee[0] ...` at O2/O3 (function #2)
— genuinely invalid WASM, matching the prior session's report exactly.
WAT-diffing the resulting kernel's compiled `$make` (native
`compileWat`/`compileBytesVia` against a saved pre-patch `dist/jz.wasm`,
same target source, same optimize level) shows the GOOD kernel fully
INLINES `add`'s body into the loop — no closure allocation, no heap cell,
no `call_indirect`, `total` stays a plain f64 local (`(local.set $total
(f64.add (local.get $total) (f64.convert_i32_s (local.get $i))))`
directly in the loop body). The BAD (argIR-patched) kernel instead takes
the general boxed-closure path: `$cell_total` (heap-allocated i32 cell),
`add` boxed via `__mkptr`(PTR.CLOSURE) into a `$env0` slot, invoked through
`call_indirect (type $ftN) (local.get $clos2) ...` — while STILL declaring
a now-UNUSED `$total f64` local (dead: the boxed path never reads or writes
it, a leftover from the plain-local codegen shape) whose local SLOT the
wasm encoder then mis-targets against a differently-typed value, producing
the type-mismatched `local.set[0]`/`local.tee[0]`.

Ruled out a semantic cause precisely: `emitIdentitySafe` (emit.js:2535) has
NO `'=>'`-node branch — for an arrow-literal init it falls through every
`?:`/`&&`/`||`/`??` check straight to the same final `return emit(node)`
that `argIR`'s own non-ambiguous arm already takes, so `argIR(init) ===
emit(init)` byte-for-byte for `add`'s own decl regardless of what
`hasAmbiguousBoolMerge` returns on it. Verified live, not just read off the
source: NATIVE `compile(src,{wat:true})` with the patch applied (argIR live
on disk) produces WAT byte-length-identical to the unpatched native
compiler AND to the GOOD kernel for this exact program at every optimize
level (692/659/770 bytes @ O0/O2/O3, fully inlined, zero `call_indirect`
either way). The direct-dispatch/inlining eligibility gate itself
(emit.js:1937, `ctx.func.directClosures` registration keyed on
`val?.closureBodyName` / `!isReassigned(ctx.func.body, name)`) is therefore
PROVABLY unaffected by the patch at the native level for this program — the
only remaining channel for the SELF-HOSTED kernel to decide differently is
its OWN compiled version of that eligibility chain (`isReassigned` and
friends, or the registration check itself) computing a different answer as
a side effect of self-hosting the patched compiler — a self-host
generational-drift / toolchain-level artifact, the same CLASS as the
export-loss MECHANISM C precedent and the outline-hunt family, NOT a value
bug in argIR/emitIdentitySafe's logic. Also checked and ruled out: the
general boxed-closure `call_indirect` codegen path is not simply
pre-existing-broken on its own — a probe that forces the identical
call_indirect-through-a-local shape on the UNPATCHED kernel too (reassigning
`add` mid-function, which independently disqualifies the direct-dispatch
gate on both legs) compiles byte-identically on both kernels, no failure.
The bug is specific to whatever makes the KERNEL flip its eligibility
decision for THIS exact non-reassigned/const-bound/single-capture shape,
not a general defect in the boxed-closure emitter.

NOT chased further within the ~10-probe time-box: which decl inside the
self-hosted `isReassigned`/eligibility chain drifts, and why watr's local
allocator mis-targets the resulting dead `$total` slot, is its own
multi-session-class hunt (start from a self-hosted, not native, WAT/trace
of `isReassigned` and the emit.js:1937 registration block specifically,
comparing good-kernel-compiles-this-logic vs bad-kernel-compiles-this-logic
— NOT `resolveCallee`, which is a red herring, fully explained above).
REVERTED before landing: `src/compile/emit.js` stays `val = viewInit ||
emit(init)`; tree verified byte-identical to HEAD (`git status`/`git diff`
clean) before banking this entry. kernel-oracle 451/451 (row unflipped),
kernel-parity 33/33 byte-identical, both re-verified after rebuilding
`dist/jz.wasm` back to the unpatched baseline. WALL STAYS CLOSED.
