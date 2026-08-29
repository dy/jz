# ledger-correctness.md — wrong-value families

Every wrong-value family found during the representation-plan/self-host/
region-arena campaigns: symptom, root cause, fix or pin, gate. Historical
session-by-session narrative (which agent tried what, in what order) is
dropped; every commit sha, file:line citation, and battery number is kept.
Families are grouped by the subsystem they live in. Cross-reference:
`STABILITY.md`'s contract is "correct or reject, no unlisted silent wrong
value"; `audit.md` §4 audits compliance; `plan.md`'s "Open KNOWN-WRONG
ledger" points here.

---

## 1. BigInt representation across call/closure/member boundaries

One continuous campaign (phase-c-unification → Shape #6 → #7 → #7-residual
→ #8 → #9 → member-callee-binding-write), all the same root mechanism:
`RepresentationPlan` (`src/compile/representation-plan/`, sole authority
per ADR-0001) must PROVE a value is BigInt and MATERIALIZE it (BOX/UNBOX
at every producer/consumer edge) before any reader trusts a raw i64
payload; every family below is a place the proof chain broke at a
boundary — call arguments, closures, `.`-member dispatch, storage reads,
ternary/logical joins — so a box POINTER's own bits got read as the i64
PAYLOAD (or vice versa), always the same NaN-box tag-collision signature
(`(bits >> 47) & 0xF === 5 === PTR.BIGINT`).

### C1-C5b — mixed-entry params, union results, join expressions (2026-08-20/22)

**Symptom**: a param whose BigInt-ness is only provable via body writes
(`if (typeof n==='string') n = BigInt(n)`) never materializes; once it
does, two more seams misread it (export-boundary result decode; `===`/`==`
comparison). Ternary/`||`/`&&`/`??` joins whose value is BigInt-only-on-
one-arm don't materialize either, especially once inlined or select-folded.

**Root cause / fix, by slice**:
- **C1** boundary-semantic precision: a closed `possibleKinds` set without
  BIGINT must keep the precise set, not widen to `noBigintSemantic()`
  (`representation-plan.js` `makeBoundaryData`).
- **C2** union-result boundary decode: a `TAG_REQUIRED` result routes the
  generic NaN-box decode, not the bigint-sentinel lane
  (`synthesizeBoundaryWrappers`/interop `readRet`/`readSettled`).
- **C3** tagged-union comparison: `===`/`==` on a plan-tagged operand
  routes through `$__eq`'s dynamic dispatch, mirroring the `typeof` exemption.
- **C4a** LANDED (`707f4306`): legacy `sig.bigintBoxed` coerceArg arms fire
  only on plan-REJECT; any real plan verdict wins. Producer-side gating was
  rejected as circular — authority resolves at the edge, not the source.
- **C4b** LANDED (merged `ef444bfc`): `jz:hostabi` descriptor replaces
  `jz:bigintbox`; zero-evidence host BigInt ingress at a non-ingress slot
  throws a typed TypeError instead of silently reading garbage (the old
  `wrapVal` decimal-string accident is dead code).
- **C5/C5b** LANDED (`10b7d3c0`, then branch `phase-c5b`): `buildBodyData`'s
  materialization fixpoint must prove spliced/select-shaped and *direct-
  return* joins too, not just named-local ternaries — a `directResultNodes`
  WeakSet had unconditionally excluded any join in return position; deleted,
  generalized `'?:'`-only wiring to all four `JOIN_OPS`. Residual: a bare
  OPEN PARAM arm (`flag ? 1n : n`) still can't prove its own carrier — same
  as the C1 mixed-entry-param gap, not this slice's scope.
- Closure-forwarding slice LANDED: `paramNeedsHostTag` gained a same-body
  closure-forwarding producer; `buildBodyData` gained `closureCallNeedsBox`/
  `paramForwardsToReturn`; `mintRepresentationPlan` now also registers
  `ctx.func.current` for closures (previously only closures' own `repSig`
  was registered — every closure body was silently invisible to plan
  lookups before this).
- Negative-BigInt sign bit: `interop.js`'s `isBox` mask (`0x7FF80000`) never
  examined the sign bit, misclassifying a negative host BigInt's
  two's-complement top bits as an already-built box. Fixed: mask widened to
  `0xFFF80000`. One-line, sign-safe for every existing box.

**Gate**: full suite 3611/3609/0/2 (20998 assertions) after the negative-
BigInt fix; kernel-oracle 14/14 (619), kernel-parity 3/3 (33/33), watr
37/37. C5/C5b: FULL SUITE 3606/0/2, kernel-oracle 14/14 (619).

### Shape #6 — storage-read → reassigned-param → cross-function (2026-08-24)

**Symptom**: `g(arr.at(i))` where the callee reassigns and forwards the
param crosses as raw box-pointer bits (watr's real memory64.wast CI shape).

**Root cause**: a covered callee's boundary param semantic trusts the
legacy whole-program `paramReps` census whenever `kindsCoverage: 'closed'`
— but that census has no notion of `.at()`/`.get()` storage reads, so it
reports the maximal "any of 14 kinds, closed" (BOOL included), tripping
the BOOL-veto permanently.

**Fix**: `solveBigintProvenance` gains `paramBigintOnly` — a final pass
(after the provenance fixpoint settles) proving a covered function's param
via `exprRep`'s storage-read-aware proof at every call site. Layer 6 found
only against real watr: provenance propagates BACKWARD (callee mutates →
caller inherits) but never FORWARD (caller's storage-tainted argument →
callee's param) — added the forward mirror. Two regressions found only by
the FULL suite (targeted repros missed both): (1) `provenBigintOnly`
defaulted `nullish=false`, upgrading a genuinely-nullable param to
"definitely present"; (2) `isStorageReadProducer`'s memberReceiver branch
matched any `[]`/`.member` read, not just genuine mutation-tracked storage
(array-destructure temps aren't mutated, so "write side always boxes"
never held for them) — both fixed by deriving from the exact same sets
`exprMay` already consults.

**Residuals pinned KNOWN-WRONG, not fixed** (later closed — see below):
`++`/`--` on a provenance-only-proven param (kind.js's own gap, not
representation-plan.js); watr's real chain goes through a DISPATCH TABLE
(`HANDLER[imm](nodes,...)`), not a bare-name call — needs the closure-
materialization subsystem.

**Shape #6 residuals CLOSED** (2026-08-24, v1 campaign Slice 2): (1)
`representationUnaryUpdateAction` reads the active frozen plan for
`++`/`--`, no broader heuristic added; (2) generic closure planning builds
a closure-local storage set from get/pop/shift/at — closes the real
`HANDLER[key](nodes)` shape. Also fixed: 3 wasm-host-only optional-chain
instabilities in `paramBigintOnly` (explicit Map/record checks).

**Gate**: native 3652/3651/0/1 (21349), test:wasm 2905/2904/0/1 (13990),
watr 37/37, oracle 14/14, parity 3/3.

### Shape #7 / #7-residual — dispatch-table & lifted-property callees (2026-08-25/28)

**Symptom**: `encode(imm, nodes) => HANDLER[imm](nodes)` (computed dispatch)
and `i64.parse` attached to a named function declaration (`fn.prop =
arrow`) both leave the reassigned param unmaterialized — watr's actual
memory64/float_memory64/call_indirect64 CI trio.

**Root cause**: `call-target-index.js`'s `resolveMember` only resolves an
object-literal `ns.parse = namedFn` shape (Shape #8); a lifted
function-property write can get REMOVED by `flattenFuncNamespaces` once
proven call-only, invisible to the points-to census; `safeReceiver`'s
`nameEscapes` check rejects ANY function ever called directly by name
(coarse-but-wrong for the callee-position question specifically).

**Fix (`fix/fnprop-call-target`)**: `resolveMember` extended to the named-
function-property lift shape; a narrower `collectValueEscapes` gate used
only for a function-declaration receiver (does the name appear anywhere
OTHER than a call-callee or safe receiver position); `releaseLiftedValueUsed`
releases a lifted `fn$prop`'s own defining write from `valueUsed` once the
index re-derives the identical fact.

**Watr trio stayed red after this fix** — attributed to Shape #9 (below):
`encode.js`'s `i64(n, buffer)` reassigns its OWN param
(`if (typeof n==='string') n = i64.parse(n)`), exactly Shape #9's shape.

### Shape #8 — object-literal `ns.parse` callee (retired branch, replaced)

The original `fix/shape8-member-callee` branch's Tier-1/Tier-2 machinery
TAINTED THE KERNEL'S OWN SELF-BUILD: watr's real `i64.parse` got a wrong
representation decision baked permanently into that branch's `dist/jz.wasm`
during compilation, so every LATER i64 constant whose bits aliased jz's
NaN-box tag misencoded — traced via 4 rounds of source-literal `warn()`
instrumentation; every representation-plan.js decision for the repro was
byte-identical native vs. kernel, ruling out that machinery as the site,
pointing instead at `kind.js`'s Tier-1 `VT['()']` reading
`ctx.funcs.map.get(fname).valResult` with no ordering guarantee against
late-synthesized `.`-member callees DURING THE KERNEL'S OWN BUILD.
**Retired 2026-08-28**: replaced by `call-target-index.js` — ONE frozen,
computed-once-before-any-consumer index. The four i64Hex hazard fixes from
that branch (BigInt64Array box-tag-vs-raw hex reads) were independently
sound and ported. One hunk (BigInt64Array/BigUint64Array element-store
`isBigInt` branch) was ported then REVERTED: self-hosting it taints the
kernel again (20 unrelated failures — statements.js compound-assign,
number.js parseInt, pointers.js box-tag family — reverting alone cleared
all 20). Pinned KNOWN-WRONG in test/data.js ("BigInt64Array element store
misreads a box-forcing Number|BigInt union"), root cause of the taint
undiagnosed. `readI64`'s `isPlanTaggedBigint` arm hardened to
`maybeUnboxBigInt` (conservative pairing) as defense-in-depth regardless.

**Also found while porting, confirmed on main's own architecture, NEW
KNOWN-WRONG families** (pinned in test/data.js, next to the shape 8/9
cluster): object-literal property assigned an INLINE closure (not a
bare-name reference — never eligible for call-target resolution at all,
`foldWrite`'s `isFuncRef` gate structurally requires a name); nested member
`a.b.c(...)` (one level deeper than shape #8's base.prop — both write- and
read-side require a bare-string receiver one level deep).

**Gate**: test/data.js 176/176 (971), full suite 3829/3830 (28411, 1
pre-existing skip), kernel-parity 33/33, kernel-oracle 14/14,
`JZ_TEST_TARGET=jz.wasm` 3005/3006 (14545), refactor-oracle CLEAN 560/560.

### Shape #9 — BOXED-source crossing into a RAW-demanding call argument (2026-08-28)

**Symptom**: `function leb(n){ n >>= 7n; return n }` called with a
reassigned bare-name caller local crosses BOXED pointer bits unconverted.

**Root cause**: `leb`'s plan-TARGET is BOXED (legacy `paramReps` census
can't see through a bare-name argument that is itself a reassigned local —
`exprRep` resolves it ANY_BIGINT, open, falling back to the coarse
closed-ALL-14-kinds-incl.-BOOL answer) — trips the BOOL-veto, so `leb`'s
own `n` never enters `materializedNames` for ANY caller;
`representationCallArgAction` sees `bodyReady=false` and REJECTs the edge
outright (no coercion at all).

**Fix (`fb2dec2e`)**: extended `paramNeverBool`/`markNeverBoolArg` (Shape
#7's structurally-weaker "boolean impossible" bar) with
`argStructurallyNeverBool` — a bare-name argument counts as never-bool
when every reaching definition in the caller's own body is itself
structurally never-bool. Wired through the one shared `visitCallSites`
loop Shape #8 already made `.`-member-aware, so both resolution paths
share the proof. No new box/unbox primitive needed.

**Two new residuals pinned KNOWN-WRONG** (separate scope, comparably sized
to the closure-materialization subsystem): (1) index-resolved `.`-member
callee (`obj.leb = leb; obj.leb(n)`) — writing a function's value to ANY
property marks it `valueUsed`, forcing `uncovered`, excluding it from the
fixpoint AND routing emission through `trySchemaClosureCall`'s generic
closure dispatch (never `representationCallArgAction` at all); (2)
`buildBodyData`'s `directCallBoundary` is bare-name-only, no
`resolveMemberCallee` fallback (unlike `solveBigintProvenance`'s own
already-`.`-member-aware proof).

**Gate**: native 3714/3713/0/1 (21619), kernel-parity 3/3 (33/33),
kernel-oracle 14/14 (605); watr downstream 600/626, byte-identical to
baseline (confirms shape #9 was never watr's real `i64.parse` failure).

### member-callee-binding-write — kind.js becomes the one authority (2026-08-28)

**Final architecture** (superseding three earlier per-site-widening
attempts that each regressed something — see "false starts" below):
`src/kind.js`'s `valTypeOf` (`VT['()']`'s `.`-member branch) now resolves
a `.`-member callee itself, via `ctx.types.callTargets?.resolveMember(obj,
method)?.valResult`, mirroring `calleeValType`'s existing bare-name tail
exactly. Every OTHER consumer (`edgeMaterializable`'s BOX/UNBOX gate,
`ir.js`'s `applyBigintRepresentationAction`) reverts byte-for-byte to
`valTypeOf(node) === VAL.BIGINT` and inherits the fix for free — no
per-site re-derivation left. Net diff vs. the 21bcfc57 baseline: 108
changed lines (down from an earlier attempt's 152), even after adding two
unrelated real fixes below.

**Kept, not collapsible into valTypeOf** (each needs something valTypeOf
structurally can't express): `buildBodyData`'s `calleeNameOf` (feeds
`directCallBoundary`'s full boundary RECORD, not just a kind);
`structurallyNeverBoolExpr`'s own `.`-member resolution (a whole-body
structural walk); `representationActiveMaterializedRep`'s `()` branch
(carrier fact, not a kind).

**Two more real, unrelated bugs found and fixed en route**:
1. `plannedOf`/`semanticOf`'s call-node branches used only the callee's
   coarse PRE-BODY boundary guess, with no upgrade to the callee's own
   settled `resultTarget`/`resultSemantic` once materialized — unlike
   `currentOf`, which already had this upgrade (Shape #7's own pattern).
   Pre-existing on baseline too, merely newly reachable once `.`-member
   callees started flowing through these branches at all.
2. `ir.js`'s `applyBigintRepresentationAction` had its OWN separate,
   un-widened `valTypeOf`-gated admission (the 8th site the original
   7-site fix never touched) — this is why a real hex-literal magnitude
   (`3078696982321561`, whose bits alias PTR.BIGINT's tag) stayed `0n`
   through the `.`-member path (residual 1) even after the other 7 sites
   were fixed.

**False starts, briefly** (three sessions of dead ends before the kind.js
fix above): reusing a call-site-INSENSITIVE `resultTarget` carrier fact as
a stand-in for a semantic-kind proof regressed watr's `float_memory*`
family 603→600/626 (a shared `i64.parse` callee has two call sites with
opposite RAW/BOXED needs — a single verdict can't serve both); a
per-site re-derivation helper (`calleeSourceProvenBigint`) crashed the
self-hosted kernel on `parseInt(1e-7)` merely by being CALLED at all
(re-deriving inside an analysis fixpoint, self-hosted, is hazardous
independent of what it resolves to — not fully root-caused, but the final
architecture sidesteps it by never re-deriving from inside the fixpoint).

**Gate**: watr downstream 604/626, 0 fail (task's own explicit target) —
zero of the memory64/float_memory64/call_indirect64/int_literals/`compile:
simd const` family remain red. Native 3725/3724/0/1 (21670), kernel build
clean, kernel-parity 3/3 (33/33), kernel-oracle 14/14, kernel-target full
suite (unscoped) 2976/2975/0/1 (14291).

**Merged to main @ 9da6a37c**; 4 conflicts (program-facts split landing
concurrently, plan/index.js's two new passes), all resolved by combining
both sides' intent. Post-merge battery: native 3838/3837/0/1 (28433),
kernel-target 3035/3034/0/1 (14639), kernel-parity 33/33, kernel-oracle
605/605, `test/pointers.js` 73/73, `test/eager-stdlib-parity.js` 22/22.

### Self-host fixpoint divergence — CLOSED, not reproducible on main (2026-08-27)

**Symptom investigated**: `let n = 0x7ffa800000000000n; return n.toString(16)`
— native "7ffa800000000000" every level, kernel-compiled "6e69666e494e614e"
("NaNInfin", string-pool bytes).

**Finding**: NOT reproducible on main at `92fa1ed1` — the taint lived
entirely in the now-retired `fix/shape8-member-callee` branch (see Shape
#8 above); none of that Tier-1 machinery exists on main. Landed anyway,
independent of reproducibility: `readI64`'s `isPlanTaggedBigint` arm was
the one remaining plan-directed unbox call site still using unconditional
`unboxBigInt` instead of the `maybeUnboxBigInt` conservative pairing
`applyBigintRepresentationAction`/`coerceArg` already use — defense in
depth, matching established practice.

**Gate**: build clean, kernel-oracle 14/14 (605), kernel-parity 3/3 (33),
native 3710/3709/0/1 (21602), kernel-target 2962/2961/0/1 (14229).

### watr downstream — decodeThrown schema collision (2026-08-27, CLOSED)

**Symptom**: watr's `err()` throws correctly (right site, right text) but
the host-decoded `.message` came back `""`/`"[object Object]"` for the
2nd+ built-in Error class thrown in one program.

**Root cause**: `interop.js`'s `enhance()` merges the `jz:schema` custom
section (a POSITIONAL list) by CONTENT alone (`props.join(',')`);
`module/schema.js`'s `ctx.schema.register` deliberately keeps the 7
built-in Error classes as separate ids sharing ONE physical prop list
`['message','name']`, distinguished only by a `salt` the write side never
serialized — 2+ of the 7 thrown in one program collapse into one runtime
index, shifting every later sid.

**Fix**: `enhance()` reads `jz:errcls` (sid→className) before `jz:schema`
and computes the same salted dedup key `ctx.schema.register` uses,
persisted in `mem._schemaKeyToId` across enhances. Pinned in
test/interop.js (4 built-in classes thrown from one module, O0/O2/O3).

**Gate**: watr suite 601/626 (was 600/626 — the unknown-instruction case
gone; the 3 Shape #7/#8 fails unchanged).

---

## 2. SIMD `.typed:map` op-validity (2026-08-28, CLOSED)

**Symptom**: `genSimdMap` (module/typedarray/simd-map.js) lowered 4 (op,
elemType) pairs to a WASM instruction that either doesn't exist (compile
crash) or computes the wrong value: `div` on Int32Array/Uint32Array with
any non-fractional constant (`Unknown instruction i32x4.div` — WASM SIMD
has no integer-lane division at all); `sqrt`/`ceil`/`floor` on
Int32Array/Uint32Array (float-only WASM instructions, no integer
equivalent at any width); `abs` on Uint32Array (compiles and validates,
but the lane op is *signed* absolute value — `4294967295` round-trips as
`1` instead of the ECMAScript-correct `4294967295`, since `ToUint32`
values are already non-negative).

**Fix**: replaced two ad hoc per-case declines (float×bitwise,
integer×fractional-constant) with one table, `SIMD_MAP_VALID_KINDS`
(module/typedarray/simd-map.js) — `genSimdMap` consults it once:
`if (!SIMD_MAP_VALID_KINDS[op]?.has(elemType)) return null`. One residual
value-level check stays separate (mul/add/sub on an integer element need
an integer-valued constant — about the constant's value, not the (op,
elemType) shape, so it can't live in the static table).

**Gate**: after the fix, all 60 (op × elemType) cells plus every
div/abs/sqrt/ceil/floor/bitwise variant: 0 compile throws, 0
`WebAssembly.validate` failures, 0 value mismatches vs. the host
`TypedArray.prototype.map` oracle, across O0/O2/O3. `test/simd.js` 231/231
(6577 assertions) unchanged elsewhere. `refactor-oracle.mjs check --ref
a76a3d23`: CLEAN (corpus has no `.typed:map` callback shaped like the 4
bug rows, so zero attributed differences, as expected for a bug fix with
no prior corpus coverage of the broken shapes).

---

## 3. Own-property-shadows-builtin-method hijack (ARRAY/STRING guessing)

One family across three branches (fix/literal-method-typed-index →
fix/param-mutation-propagation → fix/string-method-guess): jz's static
`methodEvidence` heuristic in `src/compile/infer.js` guessed a parameter's
kind from method-CALL SYNTAX alone (`<param>.push(...)` "proves" ARRAY,
`<param>.charCodeAt(...)` "proves" STRING) with no check for an own
same-named closure property shadowing the builtin — the makeByteBuf idiom
(`const b = {...}; b.push = (v) => {...}`).

### Layer 1 — `.subarray`/typed-only methods with no generic analog (2026-07-23/28, CLOSED)

**Symptom**: `b.buf.subarray(0,4)` returns `undefined` (or traps) whenever
a closure ANYWHERE in the compiled unit — called or not — writes
`X.buf[<non-literal>] = v` (property name "buf", non-constant index).

**Root cause, two layers**: (A) `src/kind.js`'s `VT['.']` object-literal
child-type fold consults `ctx.schema.slotWriteHazards`, keyed by property
NAME across the WHOLE compiled unit, not by receiver identity and not
reachability-sensitive (dead code in an uncalled closure still populates
it — deliberate "fail-closed" design, sound IF the runtime fallback stays
correct). (B) `tryRuntimePtrTypeFork` (emit.js, strategy 8 of 12) — the
function meant to catch exactly this case (dispatch at runtime on the real
ptr-tag) — unconditionally REQUIRES a generic (`.${method}`) emitter to
exist as a gate, even though the runtime dispatch only needs
`strEmitter||typedEmitter`. `.subarray`/`.set` have no generic analog (no
Array.prototype equivalent), so the gate is always false, the fork
declines entirely, and dispatch falls to `tryDynamicPropCall` — wrong
unconditionally for a receiver that IS a typed array at runtime.

**Fix** (`src/compile/emit.js`, `tryRuntimePtrTypeFork`): guard narrowed to
require `(strEmitter || typedEmitter)` only; when `genEmitter` is absent,
defer to the later strategies (`tryDynamicPropCall`/`externalMethodFallback`)
reusing the already-evaluated receiver temp. General — not a `.subarray`
special case (any typed/string-exclusive method with no generic analog).
Landed as commit `779b6a2f`.

**Layer 2 — same root cause, not a separate bug**: "adding never-called
sibling functions changes whether an unrelated path traps" (watr-stream's
own finding) traced to the SAME whole-unit hazard census — sibling
functions containing dynamic-indexed writes populate the census
regardless of whether they're ever called.

**Gate**: native 3714/3715/0/1 (1 skip); kernel build clean (17466.4 kB);
kernel-target 2969/2970/0/1; kernel-parity 33/33 (task target); kernel-oracle
605/605 (task target); bench.js 207/221 (14 fail, all speed-only, zero
size/correctness fails).

### Layer 2 — array-mutating closure through a parameter (2026-08-28, CLOSED)

**Symptom**: `writeOne(out,v){ out.push(v) }` where `out` is a plain object
with a hand-attached `.push` closure returns 0/garbage instead of calling
the real closure.

**Root cause**: `src/compile/infer.js`'s `ARRAY_INDUCERS` set
(push/pop/shift/unshift/splice/flat/flatMap) treats `<param>.push(...)`
syntax as HARD PROOF the parameter is `VAL.ARRAY`, unconditionally. This
non-null `vt` skips `tryGenericEmitter`'s existing own-property shadow
probe (correctly gated on `vt == null`), landing straight on the
unconditional builtin Array-push machinery. TWO consumers of the same
wrong `val=ARRAY` fact, not one: the method dispatch AND a plain
`.length` PROPERTY READ elsewhere in the same function
(`module/core.js`'s `emitLengthAccess` trusts `vt===VAL.ARRAY`
unconditionally for `.length` — correctly so for a REAL array, since a
genuine Array's `.length` can never collide with an own property).

**Fix, at the source, not every consumer** (since a method-dispatch
widening alone left the `.length` consumer, and any future consumer,
still broken): `infer.js`'s `methodEvidence` no longer calls
`induce(name,'array')` for `ARRAY_INDUCERS` names at all — proves only the
NEGATIVE ("not a STRING"), never asserts a positive ARRAY kind from usage
alone. Restores the module's own documented contract ("default is never
wrong, only sometimes wider than necessary").

**Gate**: all bisection repros 0 mismatch O0-O3; full project battery
(native, kernel, parity, oracle, bench size) green.

### STRING twin — `charCodeAt`/`trim`/`padStart` guessing (2026-08-28, CLOSED, 8 sessions)

**Symptom**: identical mechanism, one rung over — `methodEvidence`'s
`STRING_ONLY_METHODS` branch induced STRING unconditionally, with no
own-property-shadow check. STRING_ONLY_METHODS names ALSO have no
`.string:${method}` generic sibling, so the same `tryGenericEmitter`
shadow probe protects both once `vt` is genuinely null.

**Fix**: `methodEvidence` retired COMPLETELY (both the STRING and ARRAY
halves reduce to a permanent no-op once neither `induce()` call exists) —
deleted, along with the now-dead `guessedArrayParam` widening in emit.js
(the widening's only remaining effect was forcing the shadow probe onto
every SOUNDLY-proven ARRAY parameter reached via a forwarding chain — the
dominant contributor to a real watr.wasm size regression, below).

**watr.wasm regression, measured and mostly recovered across 8 sessions**
(same branch, `fix/string-method-guess`; jz's own byte counts, `-O3`):
564cc27b (pre-fix) 586426 B → ebee13ba (ARRAY fix only) 616516 B →
methodEvidence retirement alone: no change (watr's push/shift-heavy hot
paths were already broken by the ARRAY fix's own emit.js widening) →
`guessedArrayParam` removal: **603144 B** (recovers ~45% of the gap).
Four more sessions closed most of the rest, each a DISTINCT, real,
independently-diagnosed limitation in the whole-program kind census, not
variations on one bug:

1. **`possibleKinds` census ordering** (session 2, landed `594879e1`):
   `mergeRule`'s `trackKind`/`possibleKinds` join is a MONOTONE union with
   no retraction — a param reached only through a forwarding chain
   (`wleb(v,out) => uleb(v,out)`) could get permanently, falsely flagged
   "closed-census polymorphic" by mid-fixpoint visit ORDER alone, even
   though its narrow `val` genuinely converges. Fix: deferred `trackKind`
   out of every mid-fixpoint sweep into the single final hard-settle sweep
   (`mergeRule('val', ..., true)`, trackKind default false elsewhere).
   `node cli.js watr.js -O3`: 603144→**597581 B**. Bonus: also fixed the
   already-pinned "shape #9 sibling — non-reassigned BOXED param" O3
   KNOWN-WRONG (a different `possibleKinds` consumer,
   `paramEntryExcludesBool`, hit by the identical ordering artifact).
2. **Computed dispatch-table call-site invisibility** (sessions 3-6):
   `HANDLER[imm](nodes,ctx,op,out)` (watr's real opcode dispatch, ~30
   inline-arrow properties) is invisible to `program-facts.js`'s call-site
   walker (`isFuncRef` requires a literal bare-name callee). New
   `call-target-index.js`: `resolveComputed(objName)` resolves BOTH
   named-function-reference members (Shape-8-shaped) AND inline-arrow-
   literal members (watr's real shape — discovered only after an
   incorrect first assumption that all members were named-function
   references, verified false against real watr source). New
   `program-facts.js`: `synthesizeComputedDispatchCallSites` walks each
   resolved arrow's own body (never descending into a nested `=>`),
   substitutes the arrow's formal params with the outer call's actual
   arguments, and synthesizes one call site per inner call to a real named
   function. Landed PER-POSITION (not per-call all-or-nothing — the
   original all-or-nothing gate threw away a good sibling argument
   whenever any OTHER position still mentioned an arrow-local name;
   sound because prepare's `mintLocal` renames every function-local
   binding to a module-wide-unique name, so a leftover unsubstituted name
   can never collide with a real binding). Two safety refinements found
   only by measuring the real build: `unsuppliable` (a param the outer
   site genuinely doesn't supply must decline, not forward a bare
   arrow-local name) and `calleeArityShortfalls` (an inner call
   under-supplying ITS OWN callee's no-default trailing param poisons
   unconditionally regardless of outer-site completeness — narrow.js's
   `missing()` has no self-heal, unlike `apply()`'s soft `v==null`).
   `node cli.js watr.js -O3`: 597581→595859 B (byte-identical after item 2
   alone regressed it +1255 B first, root-caused to the same
   under-supply hazard, then items 2+3 together restored it).
3. **`.`-property-read arguments** (session 7): `inferValAtSite` had no
   case for a `.`-node argument (`c.type`) at all — only bare-name and
   `[]`-element shapes. New cases in `narrow.js`: schema-based
   (`ctx.schema.slotVTBySid`, a new raw accessor factored out of the
   existing `slotVT`) and one hop through a proven array-element read.
   Net zero bytes on real watr (its own `ctx` receiver is `[]`, not a
   schema-registered `{}`), but a real, generically-applicable precision
   win — verified via 4 new pins.
4. **`dict-kind-index.js`** (session 8, new file): a `for (k in OBJ)
   T[k]=...` unrolled loop populating a second dispatch table, closed
   generically (occurrence classification: `decl`/`safe`/`literalWrite`/
   `loopKeyWrite`/`fwdNamed`/`fwdComputed`/`poison`; positional
   array-of-arrows tables via a THIRD resolver, `constArrayMembers` +
   `arrowParamNameAt`, needed because a closure-ABI normalization pass
   rewrites multi-arity table members to one rest-param prologue).
   `??=`/`||=`/`&&=` fold like `=`; arithmetic compounds still poison.
   Net STILL zero bytes on real watr — root-caused precisely to a FIFTH,
   deeper limitation: `SIZE_HANDLER` (watr's size-only twin table) is
   populated via a for-in-DERIVED WRAPPER table (needs proving an arrow
   body is exactly `OBJNAME[K](args forwarded)`, an alias question, not a
   kind question) and via `Object.assign(SIZE_HANDLER, {...})` (a batch
   write shape no resolver in the codebase recognizes) — both real,
   generalizable, NOT attempted (would touch `call-target-index.js`'s
   `foldWrite`, a foundational primitive with a 3-prior-revert
   unsoundness history for exactly this class of "small extension").

**Landing decision** (orchestrator, same-machine A/B): watr got 10% FASTER
at runtime (jz/v8 1.25×→1.06× median) for +2.2% larger (293047→299511 B) —
"sound inference costs bytes" is the correct trade, not a regression to
chase further. `SIZE_BUDGET.watr` recalibrated 298000→300000 in
`test/bench.js` with a 3-line attribution comment, matching the existing
`245000→298000` comment's style.

**Merged to main @ 9da6a37c**. `refactor-oracle.mjs check --ref 9da6a37c`:
24 (spec,level) differences across 9 specimens, every one individually
diffed by FUNCTION identity and attributed to this branch's own intentional
mechanisms (methodEvidence/guessedArrayParam retirement, the
`possibleKinds` ordering fix, computed-dispatch resolution, dict-kind-index)
— none a merge mistake or unrelated regression. `jessie` (a JS-in-JS
parser, heavy genuinely-polymorphic string/other dispatch) grew at all 4
optimize levels — the class of program this whole branch exists to make
sound.

**Gate** (post-merge): `dist/jz.wasm` 17,920,628 B (main alone:
17,817,535 B, +0.58%, expected — new compiler source self-compiles too);
native 3838/3837/0/1 (28433); kernel-target 3035/3034/0/1 (14639);
kernel-parity 33/33; kernel-oracle 605/605; `test/pointers.js` 73/73;
`test/data.js` 204/204 (1062); `test/eager-stdlib-parity.js` 22/22;
`bench-size.mjs --json` 23/24 (watr recalibrated, above).

---

## 4. Param mutation propagation, STRING_ONLY_METHODS twin — OPEN, out of scope

Flagged during the ARRAY_INDUCERS fix (§3), not touched by any session:
`STRING_ONLY_METHODS` (`charCodeAt`/`charAt`/`trim`/`padStart`/…) has the
identical own-property-shadow unsoundness the ARRAY fix closed — a plain
object with an own same-named closure property, called through a
parameter, gets hijacked to jz's STRING builtin at O0 (native=102,
jz=NaN). *This specific finding was superseded* by the STRING-guess
retirement in §3 above (which deleted `methodEvidence`'s STRING half
entirely) — confirmed closed as a side effect, not re-verified with its
own dedicated pin at the time it was first flagged.

**Still genuinely open, shared by both the ARRAY and STRING families**: a
parameter of a function with NO closures anywhere in the compiled program
has no shadow-probe machinery to fall back to at all —
`ctx.closure.call`'s own availability gates the probe, and a zero-closure
program never pulls in that runtime infra. A HOST-CONSTRUCTED hijack
object crossing the export boundary of such a program is not defended
against (`export function tail(xs){xs.push(0);...}` called with a foreign
`{push:...}` object silently returns 0, not a throw). Not a regression
from any fix above; flagged for visibility, not scheduled.

---

## 5. Region-arena / region-hooks defects

`REGION_HOOKS_ACTIVE` stays `false` in shipped source; the region arena is
one candidate strategy for the 4 GiB self-compile wall (`plan.md`'s "4 GiB
self-compile" section has the strategy-level framing). This section is the
defect ledger for everything found while probing hooks-on: fixed
root-completeness gaps, and the still-open correctness debt that keeps the
default off.

### Fixed root-completeness gaps

- **Front's round: mid-round stdlib module registration escapes the
  root** (`88e48378`). `prepare()`'s own entry unconditionally calls
  `includeModule('core')` (prepare/index.js:800) — its FIRST call ever,
  registering ~1000 lines of closure-valued `ctx.core.emit`/`.stdlib`
  entries, strictly AFTER `front()`'s `mark()` fires. `ctx.core` is
  deliberately excluded from every round's root (closures aren't proven
  safe to relocate — the "first re-land attempt", `7085cb57`, tried
  rooting `ctx.core` wholesale and made a DIFFERENT regression worse,
  independently confirmed in `evidence.md` §CompileSession Slice D as real
  WASM traps — not reopened). Fix: `frontHalf` now calls `includeMods(...)`
  for all 21 stdlib module names (gated on `regionHooks` truthy) BEFORE
  `mark()`, forcing every module's first load durable regardless of which
  module the source itself would have first-loaded mid-round;
  `includeModule`'s existing idempotency guard makes every later call a
  no-op. Bisection proof: front's round alone, region-live, in isolation:
  kernel-oracle 11/14→(3 residual failures are all benign WAT-size
  divergences, not crashes) after the fix, vs. 2/14 before (aborts on
  `sum`, the very first AGREE-tier row).
- **emitIR's round, `__stdlibMark`: `lateSchema` snapshot dropped
  `namedUses`**. `ctx.schema.namedUses` (populated eagerly by
  `$__throw_property_nullish`/JSON's error paths for essentially every
  compile) wasn't captured into the narrowed `lateSchema = {list}` stub —
  a later, unconditional `.length` read on it threw the exact
  `Cannot read properties of undefined` TypeError this whole investigation
  chased across two sessions before being found. Fix: widen `lateSchema`
  to `{list, namedUses}` — no new root category, one existing snapshot
  object gains one plain-data field. Verified: real O0/O2/O3 self-compile
  of the `sum` corpus source now compiles cleanly with every region round
  genuinely active — first time this exact repro passed.
- **emitIR's round: `jz:errcls` custom-section builder reads a METHOD off
  the already-narrowed `ctx.schema`** — `errorSidEntries?.()` silently
  short-circuited via the optional chain (no throw, section just never
  emitted, for ANY region-live compile). Fix: read the already-captured
  `lateFacts.errorSidEntries` instead (the exact same call was already
  being resolved pre-narrowing, twice, for other post-round consumers —
  this builder just wasn't following the established `lateFacts.X`
  pattern). Same conceptual bug as the `namedUses` gap, found only because
  the first fix let compiles run far enough to reach this code at all.
- **Class 2 — dispatch tiers gate on "module loaded" instead of "actually
  demanded"** (`d1f4b585`). Two `emitMethodCall` tiers (`tryGenericEmitter`'s
  shadow probe, `tryDynamicPropCall`) use `ctx.core.emit.str`/
  `ctx.closure.call` truthiness as a proxy for "source needs string/closure
  support" — sound under lazy loading, silently wrong once eager preload
  registers every module regardless of content (`dvnested`'s DataView
  dispatch corrupts; `[3,1,2].frobnicate()`'s compile-time reject silently
  stops firing). Fix: `ctx.module.demanded` (a Set, tracked separately from
  `ctx.module.modules`) — `includeModule` marks demand unconditionally
  (even on the idempotent early return), `includeAllMods` (eager bulk
  preload) calls the new `loadModule` primitive directly, invisible to
  `demanded` by construction. Both dispatch tiers additionally require
  `ctx.module.demanded.has(...)`. Verified: `dvnested`'s own `$f` compiles
  byte-identical in SHAPE to native; `[3,1,2].frobnicate()` rejects
  identically lazy vs. eager.
- **Class 1 — unconditional module-init side effects** (`31ce2aa6` reverted
  and corrected, `610d44c7`, `72eddaee`). `module/function.js`'s
  `ctx.closure.types.add(1)` and `module/timer.js`'s `setupWasi`
  (unconditional `inc()`s + host import + `declGlobal`s) ran on module
  LOAD, not on actual need — inflates eager-loaded output. First fix
  attempt (gate on `ctx.closure.mint`-count) caused a REAL regression: 71
  NATIVE (lazy) test failures, `'ftN' is not in scope` — undercounted every
  trigger that emits `call_indirect (type $ftN)` without literally minting
  a closure (the generic dynamic-dispatch fallback, timer's invoke-closure
  trampolines). Reverted to bare truthy; fixed downstream instead —
  `finalizeClosureTable` (`src/wat/assemble.js`) computes `callIndirectSeen`
  (an actual scan of compiled output for real `call_indirect` usage)
  UNCONDITIONALLY, never gated by `preserveClosureTable` (an embedder-facing
  flag that has nothing to do with in-module `$ftN` need). `setupWasi`'s
  four effects extracted into a lazy idempotent `ensureWasiTimerRuntime()`
  thunk, matching the existing `setupJsHost` pattern. Byte-identity probe:
  `sum`/`math`/`arr`/`fold`/`boolconst`/`nestedtyped`/`fromnested`
  byte-identical eager vs. lazy at both hosts (were diverging on every
  entry before).
- **Group 1 — `stripStaticDataPrefix` heuristic false-positive** (`ae5dc024`).
  Not a region-arena bug — a size-optimization heuristic false-positives
  once eager loading makes the static-data prefix nonzero. Confirmed fixed:
  kernel-parity's `dvnested O3: identical`/`subviewtyped O3: identical`
  rows.

### Open — banked correctness debt (keep this list; nothing below is fixed)

- **dvnested region-live O2/O3 soundness — the original prerequisite,
  still not closed.** A region-enabled kernel fails `kernel-oracle` on
  12/14 tests, INCLUDING `sum` (the simplest AGREE-tier program) — broader
  than previously documented. Failure signature: `decodeThrown` decodes a
  thrown value to `src/optimize/vectorize.js`'s BodyModel/`bl` 8-field
  shape instead of the expected Error `{message,name}` shape — a
  `__schema_tbl` misresolution under region relocation. Same bug CLASS as
  the dyn-props layer-1/2/3 fixes already in `module/core.js`'s
  `__region_exit`, evidently not fully closed by those. NOT the same
  finding as the `namedUses`/`lateSchema` fix above (that closed the
  `sum`-at-O0 case specifically, front's round only) — this entry tracks
  whatever residual soundness gap remains once every fix above is applied
  together; not re-measured after the full fix set landed.
- **`dvnested` residual — fully localized, lives in watr, not jz.** Under
  eager load, `$f`'s own compiled body is confirmed byte-identical in
  dispatch shape to native (Class 2 is fully closed for this function) —
  the residual invalid-wasm is a DEAD-INSTRUCTION-ELIMINATION gap in
  watr's own optimizer: `$f`'s body ends in a void `f64.store` followed by
  a dead `f64.convert_i32_s` wrapper (a `.setFloat64` implicit-return
  coercion that's never consumed, since the whole expression is a
  statement). Native (lazy) `dvnested` has the IDENTICAL dead-wrapper shape
  pre-optimize and watr's own DCE eliminates it there — but at the larger
  module scale eager loading produces (33-52 functions sharing the module
  vs. 6), the elimination fails to fire. Plausibly a genuine watr bug
  (iteration budget, working-set size, or a fixpoint/CSE threshold), not
  jz's own module-loading code.
- **Streaming-encoder prototype (Strategy B) has its own, separate,
  uncaught correctness bug.** `kernel-oracle` 9/14 fail against a kernel
  built with `streamCode:true` wired in, first failure on `sum` (O0/O2/O3),
  the identical `decodeThrown`-wrong-shape signature — confirmed NOT
  pre-existing (the same unmodified test passes 14/14 against a dormant
  baseline built from identical source). Root cause not found; watr's own
  604/0/22 green suite only ever exercised the DEFAULT path against
  official conformance tests — `streamCode:true` was validated against 2
  tiny hand-written smoke modules before being wired into a real jz
  self-compile, which is structurally far more complex. Most plausible
  site: the reserve+backpatch offset bookkeeping
  (`buildCodeItemStreaming`/`patchUleb5`), not the underlying instruction
  encoding (shared with the already-tested default path). **Required
  before trusting `streamCode:true` for anything real**: a differential
  test running the full official wasm testsuite (or jz's own real compiled
  output) through both `compile()` and `compile(...,{streamCode:true})`
  and comparing EXECUTION results, not just validity.
- **`$ftN`/closure-table WAT-size divergence from eager module loading** —
  `module/function.js`'s `ctx.closure.types.add(1)` (a Set checked for
  mere truthiness) fires whenever `fn` loads, regardless of whether the
  compile ever creates a closure; front's necessary eager-load fix (above)
  makes this fire for every region-live compile. `$sum`'s own function BODY
  is byte-identical between native and kernel; the only difference is a
  dead `(type $ftN ...)` + empty closure-table preamble that treeshake
  doesn't strip (type/table sections aren't reachability-pruned the way
  functions are). Fixing it needs `$ftN`-emission to depend on an ACTUAL
  closure being minted, not mere module presence — a separate,
  non-trivial change to `module/function.js`'s architecture. Flagged, not
  fixed; same class as the `Object.assign`/for-in-wrapper gap in §3 item 4.
- **Spurious host imports on a program that needs none** — a `try/catch`
  program with nothing time/IO-related declares a WASI `clock_time_get`
  import under region-live eager load (`module/timer.js:79`'s
  `hostImport` isn't gated behind actual reachability the way stdlib
  HELPER functions already are via `pullStdlib`'s `reachableStdlib` scan).
  Same general class as the `$ftN` divergence above — a module's
  `init(ctx)` doing something unconditional that used to only ever run for
  programs that needed the module, now running for every region-live
  compile since eager-loading breaks "module loaded" ⟺ "module's feature
  used". Not root-caused to a specific fix.
- **Six hooks-on-only regressions, discovered by the first genuinely
  clean-enough `JZ_TEST_TARGET=jz.wasm` run against a region-live kernel**
  (2797/2811 pass, 13 fail — 7 already-known/excluded-class, these 6
  confirmed NOT pre-existing by re-running each against a freshly-built
  DORMANT kernel, where all 6 pass cleanly). Kept verbatim — this is the
  correctness debt a future hooks-on flip must close:
  1. `test/array-methods.js` — "runtime-polymorphic TypedArray writes tag
     computed named-method results": `'parse' — jz dispatched this method
     call to the host, but the receiver is not a host object (an
     unsupported builtin method, or a receiver type jz couldn't resolve)`.
     Triaged further: reproduces NATIVELY with `_eagerStdlib:true` (no
     kernel needed) — `STDLIB` bisection narrows the trigger to `fn`
     eager-loaded alongside `core`/`array`/`object`. NOT explained by the
     already-fixed Class 2 mechanism (`fn` is genuinely, unconditionally
     demanded by this exact source, so that gate should still pass) — a
     different tier or receiver-type-proof difference, not traced to an
     exact line.
  2. `test/mem.js` — "shared memory: duplicate schemas not re-added":
     `same schema not duplicated` — `is(memory.schemas.length, 1)` fails
     after two separate `jz(src, {memory})` calls sharing one
     `jz.memory()`. Schema-table related. Not triaged (structurally
     different from the other five — a cross-compile, host-side `{memory}`
     sharing concern, not obviously a single-compile eager-load or
     region-round question).
  3. `test/perf.js` — "codegen: no-arg scalar allocator rewinds heap on
     return": `expected heap save local` — a WAT-shape assertion.
     Triaged: does NOT reproduce via `_eagerStdlib:true` natively (clean
     at every level) — the ONE defect of the six genuinely specific to
     self-hosted/region-hooks execution, not triageable further without a
     kernel build.
  4. `test/passes.js` — "passes: dead code never changes retained-code
     bytes (no hidden auto-tuning)": `byte count stable under appended
     dead code (2)`. Triaged: reproduces NATIVELY with `_eagerStdlib:true`
     — 60 genuinely-unreferenced closure-shaped functions add 424 bytes
     eager vs. 48 bytes lazy (not fully treeshaken). `STDLIB` bisection:
     `['core','fn','number']` reproduces (`string` not required once
     `number` is present). Leading, unverified hypothesis: same family as
     the already-fixed `$ftN`/closure-table residual — the landed fix
     narrows the TABLE's contents but may not force treeshake to drop a
     closure-shaped function's own BODY when `number`'s eager-registered
     helpers give its operations a retained-looking call target.
  5. `test/objects.js` — "spread copy: read-after-copy with no mutation
     resolves slots correctly": plain `should be equal` — an actual wrong
     VALUE, the most concerning of the six. Triaged: reproduces NATIVELY
     with `_eagerStdlib:true` (`c.x` returns `NaN` instead of `56`, `let a
     = [{x:5,y:6}]; let c = {...a[0]}`). Root mechanism: `emitObjectSpread`
     itself is byte-identical lazy vs. eager (correctly takes the generic
     clone path both times, since `a[0]` never has a provable static
     schema at construction) — the divergence is entirely on the READ
     side: lazy's `c.x` compiles to a direct `f64.load` (some separate,
     unlocated analysis infers "a clone of a single-schema array's element
     is that same schema"); eager's `c.x` compiles to a fully dynamic
     `$__dyn_get_expr_t_h` lookup, which THEN fails to find `x` at all.
     Two open questions, neither resolved: which pass grants the static
     schema in the lazy case; why the dynamic fallback itself fails to
     find a property that structurally exists.
  6. `test/conditional-spread.js` — "conditional-spread: base props read
     correctly alongside a conditional group": `Maximum call stack size
     exceeded` on `{ a: 1, c: 3, ...(cond && { b: 2 }) }` — as trivial a
     program as this campaign has seen trigger a stack overflow, the
     single highest-priority lead of the six. Triaged furthest of all six:
     needs the KERNEL itself built at O3 (not just the guest optimize
     level) to reproduce at all; symptom at that build is actually
     `Unknown local $b` (a watr-level "undeclared local" validation
     error), read as the SAME underlying defect surfacing differently
     depending on build layout (this campaign's own recurring
     "address-boundary-sensitive" pattern). Root-caused via a custom WAT
     dump + declared-name checker (parses with watr's own native
     `parse.js`, flags any `local.get/set/tee` outside its enclosing
     func's declared names): exactly ONE bad reference in a ~15,800-line
     dump, inside `$__to_str`'s inlined Ryu float-formatting helper — one
     instruction reads bare `$b` where every sibling in the same inlined
     region correctly uses the `$__inl7_`-prefixed rename. Traced to
     **watr's own self-hosted inliner** (`node_modules/watr`'s
     `src/optimize.js`, not any jz `src/*.js` file) — `inline`/`inlineOnce`'s
     rename step substitutes only names IN its computed rename map,
     silently passing through any name NOT in the map unchanged, with no
     error. Read both `inline` and `inlineOnce` in full: internally
     self-consistent (no out-of-sync snapshot bug in watr's own logic) —
     the callee body handed to the inliner already referenced a local its
     own signature never declared, before inlining touched it. Where
     watr's OWN region round lives: `runRounds` (watr's `optimize.js`) is
     a separate, self-contained region round rooting
     `[ast,dirty,snapshots,constF64,SW]`, with `dirty`/`snapshots` being
     POINTER-KEYED Map/Set — exactly the shape this campaign's own
     doctrine flags as needing rebuild-fresh handling under relocation.
     Bisection signal across 8 of `compile()`'s round-boundary bits was
     genuinely noisy (5 unrelated bits each independently "clear" the
     symptom, one flips it to the ORIGINAL "Maximum call stack" symptom) —
     read as several bits shifting heap layout enough to dodge the
     trigger, not as five independent root causes. Disposition: same "real
     bug, lives in a vendored dependency (watr), not jz's own `ctx.*`
     round doctrine" class as the `dvnested` residual above — the "widen a
     round's snapshot" fix shape does not directly apply. Not fixed.

  Consequence for all six: `REGION_HOOKS_ACTIVE` correctly, definitively
  stays `false`. None were fixed in the session that found them (all
  root-caused to varying depth, none reaching a landed patch) — flagged
  precisely, with reproduction commands, rather than left to be
  re-discovered.
