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
  correct through `return n`; `n + 1n` correct ON THE STRING PATH ONLY
  (post-conversion bigint+bigint) — the NUMBER-entry path's JS truth is a
  TypeError, and mixed-arithmetic CHECKING stays out of C-scope (banked as
  its own slice; C does not make that expression "correct" for number
  entries, it stays a recorded gap until the checking slice); kind() probe
  stays correct; watr uleb no-array repro → 46, full uleb → 44002 at
  O0+O3; nullish-taken pin (data.js KNOWN-WRONG) flips to 'bigint';
  JZ_BIGINT_STRICT enumeration shrinks.

## Non-goals

- No legacy-machinery deletion in this campaign (that follows, mechanism
  by mechanism, once plan coverage is verified — the re-aimed
  retirement).
- No mixed-arithmetic TypeError checking (separate, smaller slice).
- No strict-mode changes.

## C2/C3 landing notes (2026-08-21)

The lane/compare predicate went through four forms, each falsified by a
different pin family before the coherent one:
demand-keyed (LAYOUT nullish-raw pins), target-keyed (same), current-bit
(statements' raw member compounds — open-ANY is both shapes), and finally
PER-RETURN-EXPRESSION with recursion: a call's verdict IS the callee's
verdict one level deeper (cycle-guarded); '.'-members answer through
slotBigintProvenAt/slotBigintBoxedAt; names through materializedNames×
targetNames; joins OR their arms; unresolved tails fall back to the
boundary current's BOXED bit only when OPEN. C3's compare arm reuses the
same predicate for call operands; the emission is an explicit source-order
two-stash tag dispatch with else-FALSE (the earlier maybeUnbox form was the
carrier-collision P0 — a tagged Number's bits equated with a raw payload —
and `else 0` before that misread genuinely-raw OPEN operands; the resolution
is the three-state split: proven-tagged → else-FALSE arm, OPEN → dynamic
raw-carrier path, never one form for both).

BANKED SIBLING (C5 blocker): the INLINED union — with few call sites the
callee inlines, the compare/return operand stops being a call node, and
the union rides an inline temp local the plan does not materialize
(observed: 2-export probe inlines gnorm → geq false, gs box-bits; the
5-export probe keeps the call and is fully correct). Fix direction: the
inline temp must inherit materialization (plan the inlined body's locals
like any body's), or inlining of box-producing unions defers until C's
edges cover inline temps.

## C4 state (2026-08-21)

C4a LANDED (707f4306): consumer-side containment at coerceArg — the legacy
sig.bigintBoxed arms fire ONLY on plan-REJECT; any real verdict (BOX/
UNBOX/KEEP) is the plan's own. Producer-side gating (markBigintSink) was
REJECTED as circular: the plan's current-rep derivation reads the sink's
marks, so the sink keeps marking and the plan keeps deriving — authority
resolves at the EDGE. Verified: acceptance shapes + data/pointers/
statements/watr/closures all green.

C4b DESIGNED, not yet implemented (boundary ABI — do with fresh care):
zero-evidence host BigInt ingress → correct-or-reject at the wrapper.
Mechanism: interop's wrapVal line ~413 sends a plain BigInt VALUE as a
decimal string (mem.String(v.toString())) — a happy accident for
typeof-guarded params, silent garbage for zero-evidence numeric params
(the dyn-keys.js KNOWN-FAIL `f(5n,3n) → number` pin). With the plan's
exported-identity materialization, typeof-guarded EXPORTED params can take
hostBoxParams' PTR.BIGINT ingress and handle real host BigInts CORRECTLY
through the tag — so the reject scope narrows to genuinely zero-evidence
slots: at the export call wrapper (per-slot marker data — the jz:i64exp
lane), a plain-BigInt argument at a NON-ingress slot throws a typed
TypeError naming the param and the two remedies (give the program BigInt
evidence, or pass the guarded-normalization string). Flip the dyn-keys pin
from silent-number to throws. AUDIT ANSWER embodied: dynamic-correct where
the plan carries it, loud reject where it can't, never a guess.

## C5 blocker: SECOND manifestation (2026-08-21)

O3's select-folding erases a union local's branch writes (`flag ? 1n : 0`
compiles to a raw select), materialization never happens, and the carrier
is the RAW union — the zero-bits collision is then inherent (pinned
KNOWN-WRONG at O3 in test/data.js's effect-fold pin; O0/O2 box and stay
correct). Same root as the few-callsite inlining manifestation: inline/
select-shaped unions must inherit materialization. The C5 slice now has
two acceptance flips banked (the 2-export inline probe and the O3 pin).

## C5 landing plan (2026-08-21 recon, cites verified read-only)

ONE fix point, not three. Recon falsified both "fix the inliner" and "fix
the optimizer":

- Inliner CANNOT consult the plan: `inlineHotInternalCalls` runs at
  plan/index.js:190, but `solveRepresentationBoundaries` publishes at :237/
  :332 and per-body plans mint later still (compile/index.js:882-887). At
  splice time (`inline.js:232-234`, `:253`, `:265`, `:275` — where
  `shape.value`, the callee's stripped return expression, becomes a bare
  caller operand) NO plan exists for ANY function. Pre-minting per-callee
  boundaries before inlining = two authorities (forbidden by ADR-0001) and
  conflicts with solveRepresentationBoundaries' stated precondition of
  seeing the final post-inline graph (plan/index.js:329-331).
- Optimizer gating is redundant-or-masking: the if→select fold
  (optimize/index.js:4407-4442) is already inert on boxed arms because
  `isPureIR` (ir.js:982-990) excludes `call` and boxBigInt emits
  `['call','$__alloc',…]`. When the fold fires on a raw union, emission had
  ALREADY failed to materialize (emit.js:6148-6150 join-action gate found
  no `materializedJoins` entry). A "refuse the fold" marker would keep the
  wrong raw carrier in an unfolded `if` — symptom moved, bug intact.

THE fix: `buildBodyData`'s materialization fixpoint
(representation-plan.js:677-1128; `materializedNames` :987-1004,
`materializedJoins` :1045-1060) must prove spliced/select-shaped unions —
an inlined body's result expression and its inline temp local planned like
any body's own locals/joins, so `flag ? 1n : 0` reaches materializedJoins
regardless of whether it arrived by source text or by splice. Plan stays
sole authority; no pipeline reorder; optimizer stays plan-blind.

Acceptance: (1) flip test/data.js:1905 O3 pin KNOWN-WRONG→correct
(`o3.f(0)` → false, matching O0/O2); (2) COMMIT the 2-export gnorm probe
as a real pin (it exists only as prose here — never landed in test/); (3)
O0/O2 legs stay green (materialization must not regress the call-kept
5-export shape); (4) full battery. Hazard log: this file's own
falsified-forms note — four wrong predicate shapes died in
representationResultTagRequired's design; extend the fixpoint by the same
discipline (per-expression, tri-state, no demand-keyed shortcuts).

## C5 LANDED (2026-08-22, main 10b7d3c0) + C5b residual

The landing plan's fixpoint suspicion was one layer too deep: live trace
showed the plan HAD materialized both the named union local AND the
hoisted temp (matNames = [inl0_h, value…]) — the loss was in the READERS.
hoistNestedCalls (inline.js:381, from 7068ae8e) wrapped its temp as
`[null, tmp]` — the boxed-literal shape, whose payload every reader
treats as a VALUE: valTypeOf kind-erased the temp's bigint to number (so
emitStrictEq's rawVt gate skipped the C3 dispatch → raw f64.eq → the
0-bits collision), representationActiveMaterializedRep's name lookup
missed (Set of strings), and stringLiteral would have read the temp NAME
as a string literal (latent adjacent wrong-value class). Fix: the hoist
returns the bare name — a name IS a bare string in this AST; every
reader then resolves it like any local. One line + comment.
Both banked flips landed: O3 pin asserts correct false at [O0,O2,O3];
gnorm 2/5-export pin committed (30 assertions incl. lossless past 2^53
— manifestation 1 was already healed on tip by C1-C4, now locked).
Battery (quintuple integration product): data 145/145, array-methods
143+1skip, optimizer 219/219, kernel-parity 3/3 (33 asserts — trio DEAD,
see .work/printer-trio.md: date.js flat .valueOf overwrite, same root as
the watr-regression trio), kernel-oracle 14/14, FULL SUITE 3603/0/2 —
first zero-fail suite.

C5b RESIDUAL (pre-existing, probed on the integration product): a
DIRECT-return union expression — `export let g = (flag) => flag ? 1n : 0`
— never materializes: g(1) crosses as 5e-324 (raw 1n bits as subnormal)
at O2 and O3. The named-local shape (C5's pin) works; the anonymous
direct-return join doesn't reach materializedJoins/the boxed return
edge, and the result lane exports raw f64. Same class the c4b agent hit
independently (its pin 2 rewrote around it). Slice: return-edge drives
materialization for direct '?:'/'||'/'&&'/'??' return expressions +
resultTagRequired routes the generic decode (C2 lane). Pin KNOWN-WRONG
on landing the slice branch. Follow-up hardening in the same campaign:
delete stringLiteral's [null,string] arm (no producer remains) + make
valTypeOf throw-or-null on [null,string] rather than misclassify.

## C5b LANDED (2026-08-22, branch phase-c5b)

Root cause was exactly the layer C5's own note flagged as the risk: the
join fixpoint (buildBodyData, representation-plan.js) computes a node's
BOXED_BIGINT target and its join-arm edges the same regardless of where
the join's value flows — but a SEPARATE WeakSet, `directResultNodes`,
unconditionally barred any join that IS itself a return/expression-body
result from ever entering `materializedJoins`. A named local's ternary
sits at a binding-write site (never a result node) so C5's fix let it
through; the textually-identical anonymous direct return IS a result
node, so it hit the exclusion on every optimization level alike (a plan-
time gate, not an optimizer artifact — the "O2/O3 only" prose guess in
the residual note above didn't survive a live O0 check).

Fix landed in two parts, no pipeline reorder, plan stays sole authority:
- representation-plan.js: `directResultNodes` deleted outright — a join's
  position was never a real precondition, only an accident of how the
  fixpoint was first written for named locals (slice 3e, 5468977f). The
  fixpoint, `representationActiveMaterializedRep`'s node dispatch, and
  `representationResultTagRequired`'s `exprMayBox` all generalized from
  '?:'-only to all four join ops (`JOIN_OPS`, `joinArms` — arm indices
  differ: [2]/[3] for '?:', [1]/[2] for the three short-circuit ops).
  exprMayBox additionally asks `materializedJoins` directly before
  recursing into arms — ground truth beats guessing, and a leaf-only join
  like `1n : 0` has no name/call for the recursion to ever resolve.
- emit.js: '?:' already had a materialized fast path (from C5's own
  '?:'-only wiring) gated on `representationJoinArmAction` — the plan fix
  alone was sufficient for it. '&&'/'||'/'??' had ZERO box-application
  wiring, named-local or direct — a bigger pre-existing gap than '?:'s
  alone, only surfaced by generalizing the plan side. Each gained its own
  early guarded-return branch (tee the condition/first-arm, test truthi-
  ness or nullishness on the RAW value, box only whichever arm actually
  surfaces), REP_EDGE_REJECT (not materialized) leaving every branch below
  byte-for-byte untouched. The emit dispatch's `self`-node passthrough
  (needed so a handler can ask the plan about itself) generalized from a
  `op === '?:'` special case to `JOIN_OPS.has(op)`.

Acceptance: pin flipped for '?:' (incl. lossless past 2^53), '||', '&&',
'??', all four crossing typed at O0/O2/O3 for a literal-arm direct-return
shape. '&&'/'||'/'??' reuse their condition slot as a surfacing arm (no
separate condition slot like '?:'), so a bare OPEN PARAM arm still can't
prove its own carrier through this fixpoint — verified this limitation is
symmetric with '?:' (`flag ? 1n : n` fails identically) and is the C1
mixed-entry-param boundary-semantic gap, not this slice's scope; the
pinned/flipped shapes use a literal-producing sub-expression on the non-
bigint side instead. A nullish-vs-typed nested ternary
(`(flag?null:5)??1n` specifically) hits a SEPARATE, pre-existing
imprecision — `semanticOf`'s `!mayCarryBigint` fallback returns the coarse
`noBigintSemantic()` (ALL kinds incl. BOOL) for a sub-ternary whose
`valTypeOf` can't agree across a null arm and a typed arm, tripping the
BOOL-veto — banked, not touched (found via probing, confirmed unrelated
to the materialization fixpoint itself: the same sub-shape with BOTH
ternary arms real values, e.g. `(flag?1n:0n)||5`, materializes cleanly).

Hardening (separate commit, same campaign): audited every `[null, X]`
producer in the tree for a STRING payload. prepare/index.js's generic
op==null handler normalizes every raw-parser string (including template-
literal segments, which use this exact shape pre-normalization) to
`['str', x]`; every post-prepare producer found constructs `[null, NUMBER]`
(array indices, loop counters, bit constants) only. Zero remaining STRING
producers — inline.js's hoisted-temp wrapper (C5's own fix) was the only
one. Deleted the dead arm in emit.js's `stringLiteral`, kind.js's
`jsonConstString`, and compile/infer.js's `isStringLiteralRhs`; added an
explicit `typeof === 'string' → null` guard in kind.js's `valTypeOf` ahead
of its NUMBER fallback (the one place removal alone would have changed
behavior — from silent misclassification to a fallthrough default, both
wrong, so the guard fails to null explicitly instead). ast.js's
`literalString` carries the identical arm but has zero callers — left
alone, not a live reader, not this hardening's concern.

Battery: kernel-parity 3/3 (33/33 byte-identical), kernel-oracle 14/14
(619 assertions), FULL SUITE 3606/0/2 (0 fail, 2 pre-existing skips —
same skip count as C5's own landing, total assertion count grew with the
intervening commits between 10b7d3c0 and this branch's base 153bb9ff).

## C4b LANDED (2026-08-22, main ef444bfc)

Merged with the BigInt(v) provenance producer (paramNeedsHostTag, symmetric
with Number(name)) + a second necessary fix it surfaced: module/number.js
`__to_bigint` fell through to hardcoded 0 for a PTR.BIGINT box — identity
arm added (mirrors `__to_num`). types.js both compute 6n via the tag path.
ONE corner regressed loud-on-purpose and is PINNED as specified behavior
(test/inference.js): a CLOSURE-mediated typeof-normalizer param rejects
host BigInt — the local closure is invisible to solveBigintProvenance, and
force-granting evidence was PROVEN silent-wrong (f(5n) → box bits + 1n =
9221823924482868225n). Flip condition named in the pin. QUEUED: the
closure-forwarding slice — extend plan RAW/BOXED edge tracking through
closure call-argument/return flow (closureBoxParams machinery partially
exists). Battery at merge: suite 3609 total, the pin green, 0 fail.

## C4b original state (2026-08-22): redesigned on branch, merge gated

phase-c4b @ a74ae3eb: jz:hostabi descriptor replaces jz:bigintbox
({tag, raw, rest} per export; raw PROVEN architecturally unreachable
today — makeBoundaryData's `uncovered = isExported` forces ANY_BIGINT →
BOXED for every export param — encoded + dispatched anyway, never
guessed from absence); wrapVal decimal-string accident DEAD (typed
throw naming mem.BigInt); rest elements policy-mapped before mem.Array;
5 pins adapted to reachable states; differential battery zero-regression.
MERGE GATE: 3 suite tests (types ×2, inference ×1) relied on the
stringify accident via `BigInt(v)`-normalized dynamic params — the
provenance slice must grant BigInt(v)'s argument position tag-ingress
evidence (the correct crossing for those tests' real bigints), then
merge on a fresh product battery. Also queued from its report:
mem.Object's inline marshal stores plain-bigint property values as raw
unmarked bits (silent-wrong, wrapVal-independent duplicate logic).

## Closure-forwarding slice LANDED (2026-08-22, branch phase-closure-fwd)

The pin flips: `f(v){ let parse = x => typeof x==='bigint' ? x : BigInt(x);
return parse(v)+1n }` now computes `is(f(5n), 6n)` correctly (was: loud
reject). Three parts, none optional — probing showed each alone is either
insufficient or actively wrong:

1. **Ingress**: `paramNeedsHostTag` (solveBigintProvenance) gained a
   closure-forwarding case, symmetric with its existing `Number(name)`/
   `BigInt(name)` producers — a bare-name argument at a position where a
   SAME-BODY local closure's own param is host-tag-eligible (structurally,
   via a new `collectLocalClosures` scan — same construction as
   paramAllUsesNumeric's own closures map, compile/index.js) earns the tag
   too. Alone, this reproduced the PRIOR agent's proof exactly: box bits +
   1n = 9221823924482868225n — confirms the C4b note's warning was accurate
   and the two-halves framing was correct.
2. **Edge tracking**: buildBodyData gained `closureCallNeedsBox` (currentOf/
   emittedCandidate: a call to a local closure whose callee has a bare-
   param return tail — `paramForwardsToReturn`, new — fed a non-excluded
   argument boxes the call result, replacing the unresolved-callee default
   RAW guess) and a narrowed `materializedResult` admission for closures
   (`closureAbiIdentity && closureBoxParams.size > 0` — NOT
   closureAbiIdentity alone, see gap below). Both sides key off the
   identical condition (passthrough tail + non-excluded feed), so caller
   and callee agree by construction rather than by replicated guesswork.
   `semanticOf` also gained a `closureCalleeKind` fallback
   (`valTypeOf(node) ?? closureCalleeKind(node)`) reusing flow-types.js's
   `closureBodyReturnKind` directly — `calleeValType`'s own closure lookup
   (`ctx.closure.valResult`) populates at emission time, strictly after
   buildBodyData already ran, so a same-body closure call's KIND (not just
   its representation) is otherwise unprovable at this analysis point.
3. **Foundational gap, found by probing, fixed at the root**: closures'
   `ctx.func.current` (the uniform call_indirect ABI sig object,
   `closureSig(cb)`) was never a RepresentationPlan lookup key — only the
   closure's own synthesized `repSig` was (mintRepresentationPlan's
   pre-existing `sig`/`sig.params` registration). Every `ctx.func.current`-
   implicit accessor (representationReturnAction,
   representationActiveMaterializedRep, …) therefore silently missed on
   EVERY closure's own body, always — completely dormant, because nothing
   before this slice ever made materializedResult/closureBoxParams
   reachable for a closure at all. mintRepresentationPlan now also
   registers whatever `ctx.func.current` holds at mint time (verified
   `sig === ctx.func.current` for ordinary functions; false for closures).

Gap found and closed mid-slice: `closureAbiIdentity` alone as the
materializedResult admission is too broad — array-methods.js's
`new BigInt64Array(…).map(x => { return x + 1n })` has NO tag-required
param (x's own boundary semantic excludes bigint outright; the mixed
{number,bigint} result semantic comes from the bigint LITERAL operand
alone, not from x), so the ordinary "unproven mixed result → BOXED"
default doesn't apply to it — but `.map()`'s own internal call site
($__typed_set_idx) has a fixed, plan-blind, unboxed calling convention,
and boxing corrupted the store. `closureBoxParams.size > 0` (a REAL,
plan-proven tag-required param) is the precise, narrower gate.

KNOWN-WRONG, found but out of scope (pre-existing, reproduces identically
on an unmodified DIRECT non-closure typeof-guarded normalizer too — not a
closure-forwarding defect): negative-magnitude host BigInt through the
jz:hostabi tagged-ingress lane (mem.BigInt) reads back as magnitude 0.
Pinned in test/inference.js next to the flipped assertion.

FIXED (branch fix/neg-bigint, based on this slice's 95ad2159): root seam
was interop.js's `isBox` — its mask (0x7FF80000) never examined the sign
bit, so a plain negative host BigInt's 64-bit two's-complement sign-
extension (top bits saturated, verified live across -1n..-2^51n) satisfied
the mask and isBox misclassified it as an already-built jz box. i64Arg's
`!isBox(x)` gate and mem.wrapVal's own `isBox(v)` fallback both consult
isBox to tell "raw value, needs mem.BigInt boxing" from "already a box,
pass through" — misclassified, they skipped mem.BigInt's allocation
entirely. The unboxed bits crossed into wasm looking like neither a box
nor a string: `$__ptr_type` read a garbage tag off them (never
PTR.BIGINT), so BigInt(v)'s dispatch (module/number.js __to_bigint) fell
through to its "not a box, not a string" 0n default — the exact magnitude-
0 misread this note originally logged. module/core.js's $__typeof already
gated the identical sign/prefix distinction correctly (its own
`0xFFF0000000000000` mask, "negative-NaN bit patterns... are uniquely
numeric") — same bug class independently confirmed there too (`typeof
(-5n)` misread "number" pre-fix, live A/B probe). Fix: widen isBox's mask
to 0xFFF80000 (sign bit included) — one line, sign-safe for every existing
box (always sign=0 by construction), closes the collision for the entire
negative i64 range (spot-checked i64 MIN). Pins: flipped test/inference.js's
KNOWN-WRONG assertion to is(f(-5n),-4n); added the DIRECT non-closure
normalizer as its own pin (proves the defect was never closure-forwarding-
specific) plus a lossless-past-2^53 negative case; test/data.js gained
negative kind/check/payload cases on the host-ingress test and negative +
lossless-negative cases on the C5 gnorm test (string-parse sibling path,
confirmed already-correct both sides of the fix — different seam);
test/dyn-keys.js's phase-c C4b(5) gained a negative FIXED-param round-trip.
Battery: inference+data+dyn-keys 353/353 (1254 assertions), kernel-oracle+
kernel-parity 14/14 (619 assertions, 33/33 byte-identical WAT O0/O2/O3
unaffected — interop.js is host-bridge only, never compiled into the
kernel), FULL SUITE 3611 total / 3609 pass / 0 fail / 2 skip (20998
assertions, unchanged pre-existing skips) — build (dist/jz.wasm) rebuilt
clean before the kernel legs.

Battery: inference 141/141 (319 assertions), dyn-keys 65/65 (284),
data 146/146 (622), array-methods 144/144+1skip (301), kernel-parity 3/3
(33/33 byte-identical O2/O3 — closure changes did not alter non-bigint
codegen), kernel-oracle 14/14 (619), FULL SUITE 3610 total / 3608 pass /
0 fail / 2 skip. Self-compiled (JZ_TEST_TARGET=jz.wasm) verified
byte-for-byte behavior-identical to native for the flipped pin and its
companion shapes — no divergence (the specific risk flow-types.js's own
closureBodyReturnKind doc flags for a similar-looking prior attempt).

## Shape #6 (2026-08-24, from CI memory64 red — fix/bigint-boundary-ci recon)

Storage-read → reassigned-param → cross-function consumption uses BOX
POINTER BITS as the value (LEB-encodes 0x7ffa800000000430 = the PTR.BIGINT
box pointer itself, heap offset 1072 — watr encode.js i64() shape; minimal
jz-only repro confirmed corrupt INSIDE wasm, no interop involved). Five
layers, 1–4 fixed-and-probe-verified then REVERTED (no partial commits into
this fixpoint), exact seams (representation-plan.js @ 899d6783):
1. currentOf (~:974) + plannedOf (~:1041): recognize the full
   STORAGE_READ_METHODS {get,pop,shift,at} (exprRep :398 already does),
   not just 'get'.
2. edgeMaterializable sourceReady (~:1156): a BOXED→BOXED storage-read
   edge is ready by construction (write side always boxes via
   taggedStoredValue) — say so.
3. Same recognition for plain []/.member reads (memberReceiver shape).
4. Materializable-def gate (~:1158): admit compound assignments
   (NUMERIC_VALUE_OPS already imported :703 and resolves >>= correctly).
5. OPEN ROOT: representationCallArgAction cross-function readiness
   (~:1648) still rejects — callee's materializedNames never contains the
   reassigned param; plan-minting/visibility ordering between caller
   call-site check and callee body materialization
   (mintRepresentationPlan/buildBodyData order). This is the layer that
   keeps the encode wrong; find it before applying 1–4.
Probe evidence trail: each of 1–4 moved edgeAction KEEP→REJECT→KEEP as
gaps closed. CI signature: /test/official/memory64.wast data-segment
offset 9221823924767627208. Sibling note: watr polyfill reject (CI
failure 1) is a dy/watr runner gap (raw BigInt AST leaves → generic
marshaler; box via memory().BigInt before exports.compile) — no jz change.

## Shape #6 LANDED (2026-08-24, branch fix/shape6-storage-read)

Layers 1–4 landed as specified (exact seams above, offsets unchanged —
representation-plan.js had zero commits between 899d6783 and this branch's
base). Layer 5's OPEN ROOT was live-probed and turned out to be A LAYER
DEEPER than the brief's own ordering hypothesis — same lesson C5's own
landing note already recorded ("the landing plan's fixpoint suspicion was
one layer too deep"). Live trace (JZ_SHAPE6_TRACE-style console.error at
buildBodyData's materializedNames loop) showed mintRepresentationPlan/
buildBodyData order is NOT the problem: analyzeFuncs is a complete pass
over ctx.funcs.list before emitFuncs starts (compile/index.js), so a
callee's body plan is always minted before any caller's call-site check
runs — verified directly, callee-before-caller ordering already holds.
The REAL root: a covered callee's boundary param semantic
(makeBoundaryData, !uncovered branch) trusts the legacy whole-program
paramReps census (`rep`) whenever it reports `kindsCoverage: 'closed'` —
but for a storage-read call argument (`g(arr.at(i))`), that census has no
notion of `.at()`/`.get()`/etc. and reports the maximal "any of the 14
kinds, closed" answer (a confident-looking but uninformative default, not
real evidence). buildBodyData's materializedNames fixpoint reads that
closed-ALL semantic, sees the synthetic BOOL member it necessarily
carries, and vetoes materialization permanently — the reassigned param
never enters its OWN callee body's materializedNames, so every caller's
representationCallArgAction sees an empty set forever after, deterministic
not racy.

Fix (representation-plan.js): solveBigintProvenance gains `paramBigintOnly`
— a final pass (after the provenance fixpoint fully settles, avoiding
staleness) that walks every direct call site in the program and asks
exprRep's own STORAGE_READ_METHODS-aware proof of each argument; a
COVERED function's param earns the mark when EVERY call-site argument at
that index is a provably CLOSED bigint (arity gaps and any non-closed-
bigint argument mark it impure, permanently). makeBoundaryData prefers this
proof's KIND set (semKind(VAL.BIGINT), nullish preserved from the legacy
semantic — see regression note below) over the coarse census when present,
for the semantic used by the BOOL-veto specifically.

LAYER 6, found only once validating against the ACTUAL watr CI shape (not
the brief's own repro shape): solveBigintProvenance's `storage` set
propagates provenance BACKWARD (a callee that mutates a storage-bearing
param propagates that back to the caller's bare argument — pre-existing
rule) but never FORWARD. watr's real chain is
`compile.js`'s `i64:` handler doing `n.shift()` on ITS OWN first param,
called as `encode.i64(n.shift(), out)` — a plain array PASS-THROUGH
(`function handle(arr){ return i64(arr.shift()) }`) leaves the callee's
OWN param invisible to exprMay's STORAGE_READ_METHODS branch (which only
ever consults `storage.has(name)` for the read's own receiver name — never
seeded for a param that only ever RECEIVES a storage-tainted argument).
Fix: mirror the backward rule — a caller passing its own storage-tainted
bare-name argument hands the callee the SAME object by reference (Array/
Map are reference types), so the callee's corresponding param inherits
storage-taint too. Sound by the identical argument the backward rule
already relies on.

TWO REGRESSIONS found only by the FULL suite (neither the brief's own
repro nor this fixpoint's own targeted sweep exercised either shape —
recorded here as the reason the full battery is load-bearing, not a
formality):
1. `provenBigintOnly`'s `semKind(VAL.BIGINT)` call defaulted nullish=false,
   silently upgrading a genuinely-nullable param (test/watr.js's
   pre-existing uleb-loop pin: legacy `rep.nullable === true`) to
   "definitely present" — flipping targetRepFor's definiteBigint gate open,
   which combined with currentParamRep's own (pre-existing, nullish-blind)
   RAW-preferring `onlyBigintKind` branch to choose the RAW carrier over
   BOXED for a param whose OTHER consumers (`Number(n)`, found live: raw
   i64 bits reinterpreted as an already-numeric f64, no int→float
   conversion, no unbox) don't yet handle a plan-materialized RAW carrier.
   Fix: `current`/`target` derive from the legacy (rep-based) semantic
   unconditionally now; the override's own job stays scoped to what it
   actually proved (kind purity for the BOOL-veto), never presence or
   carrier choice.
2. `isStorageReadProducer`'s memberReceiver branch matched ANY `[]`/
   `.member` read, not just genuine mutation-tracked storage — found live
   via the FULL suite's array-destructure trio (test/types.js):
   `let [a,b] = [1, BigInt(v)]` desugars to `let d0=[...]; let b=d0[1]`,
   and `d0` is an array-LITERAL temp, never `.push`/`.set`-mutated, so the
   "write side always boxes" physical guarantee this predicate names was
   never established for it. Fix: require the receiver be present in
   solveBigintProvenance's own storage/bigintTyped sets — the exact signal
   exprMay's identical branches already consult, reused rather than
   guessed at a coarser AST-shape level.

RESIDUAL, root-caused and pinned KNOWN-WRONG, NOT fixed (a documented
wall, not a rushed extension into unfamiliar territory):
- `++`/`--` on a covered-function param whose only bigint evidence is
  whole-program provenance (not a directly valTypeOf-provable local fact):
  pre-existing kind.js gap (valTypeOf's own '++'/'--' resolution has no
  OR-fallback the way compoundAssign's val-side check does) — layer 4
  merely made the surrounding pathway reachable enough to discover it.
  Reproduces identically with a bare `g(5n)` literal call site (confirmed
  independent of storage reads). Root fix needs kind.js/narrow.js, not
  representation-plan.js.
- watr's ACTUAL memory64.wast failure is NOT the named-function shape any
  pin in this fixpoint covers: the real chain goes through a DISPATCH
  TABLE / closure call — `instr()` (compile.js) dispatches per-opcode
  encoders via `HANDLER[imm](nodes, ctx, op, out)`, a computed property
  call, never a bare function name; the `i64:` entry is an ARROW FUNCTION
  VALUE stored in that table (never registered in ctx.funcs.map), whose
  body reads `nodes.shift()` on its OWN first param before calling
  `encode.i64(...)` (a second namespace-property call). Reproduced in
  isolation (test/data.js pin) — fails identically at EVERY optimize
  level, box-pointer-bits confirmed (the exact watr-leg corrupt offset,
  9221823924769217936, decodes to 0x7ffa800011115d90 — a PTR.BIGINT
  NaN-box tag over a heap offset, the same corruption class every other
  pin in this fixpoint fixes). Requires representation-plan.js's SEPARATE
  closure-materialization subsystem (closureBoxParams/closureCallNeedsBox/
  mintRepresentationPlan(...,{generic:true}) — built for the closure-
  forwarding slice, own history, own three-part landing precedent for how
  much care it needs) to ALSO prove "a closure param's own storage-read is
  boxed by construction" — a comparably-sized, separate undertaking, not a
  slice of this one.

Battery (final, both regressions fixed): test/data.js 153/153 (777
assertions, incl. the shape #6 minimal repro, the full get/pop/shift/at/
[]/.member × single-function/cross-function sweep, and the two KNOWN-WRONG
residual pins above); test/dyn-keys.js 69/69 (319); test/kernel-parity.js
3/3 (33/33 byte-identical O0/O2/O3); test/kernel-oracle.js 14/14 (605);
test/watr.js (jz's own, includes the uleb-loop regression pin) 37/37 (113);
test/types.js array-destructure trio restored. FULL SUITE (node
test/index.js): 3643 total / 3641 pass / 0 fail / 2 skip (21258
assertions, same pre-existing skip count as prior campaign landings) —
first zero-fail suite for this fixpoint. External watr leg (throwaway
local clone of /Users/div/projects/watr, node_modules/jz symlinked to this
branch, `npm run build:wasm` then `WATR_WASM=1 node test`, mirroring
.github/workflows/watr.yml): 596/626 pass, 8 fail — 7 are the pre-existing,
documented polyfill/runner gap (sibling note above, no jz change), 1 is
the closure-dispatch residual above; STABLE (byte-identical failure set
and identical corrupt offset) across all three fix iterations in this
branch, confirming neither regression fix touched that residual and no
new regression was introduced downstream of it.
## Shape #6 residuals CLOSED (2026-08-24, v1 campaign Slice 2)

Both residuals named above are now ordinary correct-value tests at O0/O2/O3.

1. **Provenance-only `++`/`--`.** `valTypeOf(name)` remains intentionally
   local and may not see a covered reassigned param's whole-program BigInt
   proof. `representationUnaryUpdateAction` reads the active frozen plan,
   requires a definitely-BigInt semantic, and returns the raw-result write
   action for the binding's target. The emitter runtime-unboxes the current
   carrier, performs i64 add/sub, then applies KEEP/BOX. No broader kind
   inference or heuristic was added.
2. **Closure/dispatch-table storage read.** Generic closure planning now builds
   a closure-local storage set from get/pop/shift/at and indexed mutation. A
   local initialized from that storage is BigInt-tainted even though closure
   bodies are outside the named-function whole-program scan. The BOOL veto is
   relaxed only for a flow seeded by a boxed-by-construction storage read whose
   remaining defs are numeric compounds (non-numeric members throw before
   writing, so atom identity cannot be erased). This closes the real
   `HANDLER[key](nodes)` / `nodes.shift()` watr shape, not a direct-call proxy.

The merged Shape #6 pass also exposed a wasm-host-only instability in three
optional-chain expressions inside `paramBigintOnly`; explicit Map/record checks
preserve the same native plan and restore all shape #6 tests under
`JZ_TEST_TARGET=jz.wasm`.

Validation: native suite 3652/3651/0/1 (21,349 assertions); test:wasm
2905/2904/0/1 (13,990); data native 153/153 (780), kernel 153/153 (771);
watr 37/37 (113); parity 3/3 (33); oracle 14/14 (605); ratchet 10/10;
optimizer fixpoint 10/10. No accepted-wrong Shape #6 assertion remains.

## Typed-storage plan authority follow-up (2026-08-24)

Typed constructor provenance is no longer an emitter-side sibling authority.
`typed-provenance.js` owns one three-state expression grammar: constructor,
open, or conflicting. Analysis supplies its phase-specific maps through
`typed-context.js`; after facts settle, every function/start/closure publishes
a sparse TypedStoragePlan. Typed reads, writes, getters, result chains,
`instanceof`, closure argument lattices, and typed loop guards consume that
plan. A structural invariant forbids direct emit-time ctor-map reads.

The conflict state is load-bearing. Watr's v128 i64x2 encoder selects among
four different integer TypedArray ctors in one nested conditional. Treating
that closed disagreement as merely unknown allowed an earlier width to survive
and turned valid BigInt lanes into `BIGINT_UNDEF_MIX`; the dedicated conflict
poisons the stale fact and preserves all 37 watr tests natively and in-kernel.

RepresentationPlan now applies the same authority discipline at emission: in
a BigInt-capable program, an absent active body plan throws an internal
invariant error. It no longer silently substitutes NO_BIGINT, which could turn
a lifecycle bug into an accepted wrong carrier.

## Shape #7 candidate (2026-08-25, watr memory64 CI still red past Shape #6 residuals CLOSED)

Re-verified against current main (post 5bd75ce4, `fix/v1-shape6-residuals`
merged): a throwaway `/Users/div/projects/watr` clone, `dist/watr.wasm` built
fresh via `node cli.js watr.js -O3 --memory 4096 -o dist/watr.wasm`,
`WATR_WASM=1 npm test` — 626 total, 600 pass, 4 fail. One fail
("error on unknown instruction: should throw") is an unrelated case-level
assertion. The other three are the box-pointer-bits signature: `memory64.wast`
(data segment 0 offset 9221823924769379472 = 0x7ffa80001113d490),
`float_memory64.wast` (offset 9221823924662201080 = 0x7ffa80000ab06af8, both
exact CI offsets this fixpoint already names) and `call_indirect64.wast`
("table index is out of bounds" — same corruption class, a table64 index
instead of a data offset). So Shape #6's residual-2 fix (closure/dispatch-
table storage read, CLOSED above) did not close watr's own CI shape; a
VARIANT survives it.

Minimal repro (jz-only, no watr; verified FAIL at O0/O2/O3, pinned KNOWN-WRONG
in test/data.js immediately after the "shape #6 closure close" pin):

```js
function leb(n) { n >>= 7n; return n }
const HANDLER = { i64: (nodes) => leb(nodes.shift()) }
function encode(imm, nodes) { return HANDLER[imm](nodes) }
export let f = () => {
  let nodes = []
  nodes.push(900n)
  return encode("i64", nodes)
}
```

`f()` should return `7n` (900n >> 7n). It returns a plain `Number` instead —
the reassigned param never round-trips as BigInt at all. Decoded against
layout.js's own NaN-box fields (undo the one `>>= 7n` to recover every bit but
the low 7): O0/O2 leak `0x7ffa800000000480`, O3 leaks `0x7ffa800000000500` —
both `(bits >> TAG_SHIFT) & TAG_MASK === 5 === PTR.BIGINT` exactly, aux 0, a
small heap byte offset (~1152/1280) — the box POINTER used as the i64 PAYLOAD,
un-unboxed, the same disease every Shape #6 pin fixes.

**Miss analysis.** The closest landed layer is Shape #6 residual 2 ("Closure/
dispatch-table storage read", CLOSED 2026-08-24, this file above): generic
closure planning builds a closure-LOCAL storage census so that `let n =
nodes.shift(); n >>= 7n; return n` — read, bind, reassign, all inside ONE
closure body — materializes. Real watr never takes that shape. `compile.js`'s
`i64:` HANDLER entry (~1050, reached via `HANDLER[imm](nodes, ctx, op, out)`
computed dispatch) is `(n, c, op, out) => { encode.i64(n.shift(), out) }` —
the storage-read is forwarded INLINE, unbound, straight into a SEPARATE named
function (`encode.js`'s `i64()`, ~118-136) whose OWN LEB128 loop reassigns ITS
OWN param (`n >>= 7n`). No local ever exists for the closure census to mark,
because the value never stops inside the closure at all. Differential
probing (verbatim CLOSED pin passes; changing only "reassign inside the
closure" → "forward inline into a second function that reassigns its own
param" flips it to FAIL at every level) isolates this cleanly. It goes one
step further: even a bare BigInt LITERAL forwarded the identical way (closure
receives it as its own param, forwards to a second function via the same
computed-key dispatch, no storage involved anywhere) fails identically — so
"storage-read" is only one producer of the real gap, which is closure-
PARAMETER materialization not surviving a FORWARDED call across a computed-
dispatch boundary. (Secondary, not this pin: the same inline-forward through
one plain NAMED function, no closure at all, passes at O0/O2 but fails at O3
— an adjacent, narrower optimizer-only gap the closure shape doesn't need to
hit, since the closure shape is wrong at every level unconditionally.) Root
fix needs representation-plan.js's closure-materialization subsystem
(closureBoxParams/closureCallNeedsBox/mintRepresentationPlan(...,{generic:
true})) to prove a closure's OWN param is boxed-by-construction across a
FORWARDED call argument, not only across its own local's storage-read —
comparably sized to residual-2's own fix, not a one-line extension of it.

## Self-host fixpoint divergence — investigation trail (relocated from .work/todo.md, 2026-08-27)


## CLOSED (2026-08-27): selfhost-fixpoint-divergence — traced to fix/shape8-member-callee, not reproducible on main; readI64 hardened as defense-in-depth

Assigned as a P0 self-host miscompile hunt: `let n = 0x7ffa800000000000n;
return n.toString(16)` — native "7ffa800000000000" at every optimize level,
kernel-compiled "6e69666e494e614e" (ASCII "NaNInfin", string-pool bytes near
address 0). Decisive first fact, built fresh at main@92fa1ed1: the kernel
does NOT fail this repro, nor the wider adversarial-value family
(12345n/4n/0xFFFFFFFFFFFFFFFFn/0x8000000000000000n/0x7fffffffffffffffn/0n/
-5n), at O0/O2/O3 — robust across a clean rebuild and re-verified after
landing the fix below.

Bisected against fix/shape8-member-callee (an unmerged, in-progress branch
adding Tier-1/Tier-2 `.`-member-callee BigInt provenance resolution): the
repro already fails at the branch's FIRST commit (17ef8687) and persists
through 31b55655 (which closed a related but distinct 18→9-fail
kernel-target regression). Traced live — four rounds of source-literal
`warn()` instrumentation added to a disposable self-compile probe, each
rebuilt and diffed natively vs in-kernel — every representation-plan.js/
ir.js decision for `n` (materializedNames membership, the write action,
`applyBigintRepresentationAction`'s action, `representationActiveMaterializedRep`'s
verdict, `isPlanTaggedBigint`, even the parsed decimal string
`9221823924482867200`) came back BYTE-IDENTICAL native vs in-kernel — ruling
out that branch's own representation-plan machinery as the site of
corruption for THIS repro. Root cause instead matches that branch's own
prior diagnosis (a69bd910, 2a6a7c1f, wall protocol invoked, not fixed
there): kind.js's Tier-1 `VT['()']` branch reads `ctx.funcs.map.get(fname)
.valResult` — narrow.js's whole-program fixpoint field — with no ordering
guarantee against Tier-1's own late-synthesized `.`-member callees
(prepare's tryFnPropCall, e.g. watr's own `i64.parse = n => {...}`), so the
same call-site AST node answers both `undefined` and the correct kind
depending on which compiler pass asks first DURING THE KERNEL'S OWN
SELF-COMPILE BUILD — baking a wrong representation decision for watr's own
`i64.parse` (WAT-to-wasm's numeric-literal encoder, `m61_encode$i64$parse`
in 2a6a7c1f's own stack trace) permanently into that branch's dist/jz.wasm.
Once tainted, the kernel's own i64.parse misencodes any LATER i64 constant
in ANY program it compiles — including this totally unrelated `hexOf` —
whose parsed bit pattern happens to alias jz's own PTR-tag NaN-boxing
scheme, via the identical "mis-proven UNBOX dereferences a raw value's own
bits as a pointer" mechanism this file's box/unbox pins already document,
just baked into watr's encoder rather than triggered in the user program's
own compiled logic. None of that Tier-1 machinery exists on main, so main
was never exposed.

Landed anyway, independent of reproducibility: `readI64`'s
`isPlanTaggedBigint` arm (ir.js) was the one remaining PLAN-DIRECTED unbox
call site still using the unconditional, unguarded `unboxBigInt` instead of
the `maybeUnboxBigInt` CONSERVATIVE PAIRING `applyBigintRepresentationAction`
and `coerceArg` already use for the identical fixpoint-proof-not-runtime-fact
hazard (the range-boundary BOX/UNBOX OOB fix) — the same order-sensitivity
those two call sites' own doc comments already document can apply anywhere
this fixpoint's verdict gets consumed, not just on fix/shape8-member-callee.
Closing the last unguarded site is defense-in-depth, matching established
practice; it does not by itself change this repro's result (a RAW-proven
value's own bits already alias PTR.BIGINT's box prefix, so even the
runtime-checked pairing can't distinguish it from a real box — only a
correct RAW verdict, which main already computes, keeps this value out of
any unbox path at all). Pinned in test/pointers.js: the exact repro plus the
box-tag-shaped family (prefix, prefix+1, through arithmetic, through array
storage) and an ordinary-value control row, all at O0/O2/O3.

Gates: build clean, kernel-oracle 14/14 (605), kernel-parity 3/3 (33),
native full suite 3710/3709/0/1 (21,602), kernel-target full suite
2962/2961/0/1 (14,229).

## Shape #8 branch: RETIRED (fix/shape8-member-callee @ d7efe7a7)

Decisive fact (fixdiv, 2026-08-27): main's kernel does NOT corrupt box-tag-shaped BigInt literals; the branch's Tier-1/Tier-2 member-callee machinery taints how the kernel compiles watr's own i64.parse at kernel-build time (fails from its first commit 17ef8687), so every later i64 constant whose bits alias a PTR tag misencodes. Independently sound pieces extracted separately: the four i64Hex hazard fixes (0e7887b6, d7efe7a7). Replacement design per the second audit: ONE frozen same-module call-target index computed before any consumer (no pass-order-dependent facts), consumed by plan and emission alike — the ordering race and the kernel taint are both symptoms of ad-hoc per-family resolution.

**Retired 2026-08-28** (fix/shape8-pins, 280 commits behind main at parking): the replacement index landed (call-target-index.js, "Shape #9"/"Shape #7-residual" sections below) and fully supersedes the branch's own Tier-1/Tier-2 machinery — none of `src/compile/representation-plan.js`'s 895-line diff (`collectMemberWriteSites`/`collectMemberCallees`/the branch's own `resolveFnPropCallee`-equivalent) was portable; the file itself no longer exists in that shape on main (split into `src/compile/representation-plan/`). `src/kind.js`'s matching 55-line diff (its own `resolveFnPropCallee` plus the VT['()'] Tier-1 branch the branch itself later ripped back out, self-host root cause) is likewise fully superseded — main's `VT['()']` resolves a `.`-member callee through call-target-index.js's `resolveMember` instead (the "one-authority fix" pins above). Everything else was checked hunk-by-hunk against main (`git diff main...fix/shape8-member-callee`):
- The four i64Hex-not-toString(16) hazard fixes (0e7887b6, d7efe7a7) — confirmed verbatim on main: `src/ir/pointers.js`'s `boxPtrIR` (~line 26) and `extractF64Bits` (~lines 169-204), `src/optimize/specialize-mkptr.js` (~line 136, moved out of `src/optimize/index.js` by main's own later split).
- `readI64`'s `unboxBigInt`→`maybeUnboxBigInt` hardening — already landed above (the CLOSED selfhost-fixpoint-divergence section) as the third of three range-boundary BOX/UNBOX OOB call sites (`applyBigintRepresentationAction`, `coerceArg`, `readI64`).
- `module/typedarray.js`'s BigInt64Array/BigUint64Array element-store path (the `isBigInt` branch of `.typed:[]=`, three call sites) was the one hunk not yet on main: still an unconditional `i64.reinterpret_f64` where its three sibling chokepoints already use the runtime tag-checked `maybeUnboxBigInt`. Could not construct a failing native repro against main's own (call-target-index-based) architecture through any ordinary-program shape tried, mirroring the branch's own described trigger (a box-forcing Number|BigInt union / ternary-with-a-`.`-member-call-arm feeding a BigInt64Array store) — consistent with the branch's own trigger being specific to its now-retired Tier-1/Tier-2 materialization, not to call-target-index.js. **Ported, then reverted**: same reasoning the readI64 hardening above already used ("defense-in-depth, matching established practice") got this landed first, but self-hosting the fixed file into `dist/jz.wasm` and running the full native suite through `JZ_TEST_TARGET=jz.wasm` surfaced 20 UNRELATED failures (test/statements.js's BigInt compound-assign, test/number.js's parseInt, test/pointers.js's box-tag-shaped carrier family — none touch BigInt64Array, several trapping outright with "memory access out of bounds"), confirmed caused by this one change by reverting it alone and re-running clean under the same target. A NEW instance of this section's own kernel-taint disease: the fix's own new box-tag-shaped IR, compiled INTO the kernel by an earlier-stage compiler, bakes a wrong decision into unrelated later BigInt handling somewhere in the self-compile — not diagnosed further (past this task's own scope). Reverted rather than land a worse, self-host-only regression than the leaf bug it would have closed; refactor-oracle's own check --ref confirms the bug is genuinely reachable regardless (bench:watr/watr:watr.js, watr's real WASM encoder, grow measurably whenever the fix is applied — the exact corpus the original branch found this hazard against). Pinned KNOWN-WRONG in test/data.js instead ("BigInt64Array element store misreads a box-forcing Number|BigInt union").
- The four test/data.js pins named in the branch's "shape #8 sibling" family were re-run against MAIN's own architecture (not the branch's) and ported next to the existing shape #8/#9 cluster, each labeled by what actually happens now:
  1. *object-literal property referencing an existing function, both shorthand and explicit key* — FIXED. Covered by prepare's pre-existing static-object-schema constant folding, unrelated to either branch's or main's `.`-member machinery.
  2. *object-literal inline closure reached via STATIC `.`-access, not computed dispatch* — FIXED, but not for the reason the branch's own (retired) Tier-2 resolved it: call-target-index.js does not resolve this callee either (an inline closure literal fails `foldWrite`'s `isFuncRef` gate, same as pin 3 below). Passes because the closure's body never needs reassignment-narrowing — a plain proven-BigInt storage read forwarded through, no `typeof`-guard coercion inside the closure; bisected directly (swapping in the guard reproduces pin 3's exact wrong value).
  3. *object-literal base, property assigned an INLINE CLOSURE* — KNOWN-WRONG, confirmed on main's own architecture. NEW KNOWN-WRONG family (distinct from Shape #9's own residual 1, a bare-name reference to a pre-existing function excluded via `valueUsed`): an inline closure literal is never even ELIGIBLE for call-target-index resolution (`foldWrite`'s `isFuncRef` gate structurally requires a name, not a literal) — poisoned on its first write, permanently — and the closure-forwarding slice has no reassignment-narrowing proof of its own for a Tier-2-resolved closure body.
  4. *nested member `a.b.c(...)`, one level deeper than shape #8's own base.prop* — KNOWN-WRONG, confirmed on main's own architecture. NEW KNOWN-WRONG family (distinct from Shape #9's own residual 2, `directCallBoundary`'s bare-name-only gate): both `collectMemberWrites`'s write-collection and `resolveMember`'s read-side (`call-target-index.js`) require a bare-STRING receiver one level deep — a `.`-chain base is invisible to both, not merely poisoned after consideration.

Battery (fix/shape8-pins worktree, final state — typedarray.js hardening reverted): test/data.js 176/176 (971 assertions), test/index.js 3829/3830 (28411 assertions, 1 pre-existing skip), `npm run build` clean, kernel-parity 33/33, kernel-oracle 14/14, `JZ_TEST_TARGET=jz.wasm node test/index.js` 3005/3006 (14545 assertions, 1 pre-existing skip, 0 fail), refactor-oracle CLEAN — 560/560 identical (no src changes remain; test/data.js and this doc are the only diffs against 5d0dd4ed). Nothing left unlanded; fix/shape8-member-callee is safe to delete.

## watr downstream CI, 4th failure CLOSED (2026-08-27, fix/watr-downstream @ 3905253b base): decodeThrown's live-schema collision — unrelated to Shape #6/7/8

Re-probed all 4 watr CI failures fresh against a clean HEAD-jz build (baseline-confirmed: 600/626, same 4 fails, same signatures this file already names). Three (`memory64.wast`, `float_memory64.wast`, `call_indirect64.wast`) are exactly the Shape #7-residual/#8 `.`-member-callee gap above — unchanged, still KNOWN-WRONG pinned (test/data.js "shape #7 residual"), still CTI's (`feat/call-target-index`) to close, not touched here.

The 4th (`case: error on unknown instruction: should throw`) is a DIFFERENT, disjoint bug — no BigInt, no callee resolution. watr's `err()` (src/util.js) does `throw Error(text)`; the wasm DOES throw at the right site with the right text (confirmed: native watr throws `"Unknown instruction i32.shr"` for the failing case; wasm-watr throws too), but the host-decoded `.message` came back as `""`/`"[object Object]"` — `throws(fn, /i32.shr/)` then fails on the REGEXP-MISMATCH branch of `tst`'s `throws()`, which reports the identical `'should throw'` label as the "never threw" branch, so the test's own failure text was misleading about the actual mechanism.

Root cause: `jz/interop.js`'s `enhance()` reads the `jz:schema` custom section — a POSITIONAL list (compile/index.js's own writer comment: "entry index === schema id") — but merged incoming entries into `mem.schemas` by CONTENT alone (`props.join(',')`). module/schema.js's `ctx.schema.register(props, salt)` deliberately keeps the 7 built-in Error classes as SEPARATE compile-time ids sharing one physical prop list `['message','name']`, distinguished only by a `salt` (the class name) that the write side never serializes. Any program registering 2+ of the 7 (watr's compile.js throws several: at minimum a plain `Error`, likely more) collapsed every one after the first into ONE runtime index, shifting every later sid's position in `mem.schemas` — the exact LIVE-entry sibling of the DEAD-entry collision compile/index.js's jz:schema writer already documents and fixed with a `[String(id)]` placeholder (that fix covers only entries with no salt to lose).

Minimal jz-only repro (no watr): `export let f = (w) => { if (w===0) throw new TypeError('a'); if (w===1) throw new RangeError('b'); throw Error('c') }` — first class (TypeError) decodes fine, RangeError/Error both lose `.message` (`mem.schemas[sid]` resolves to an unrelated, usually-empty schema).

Fix: `interop.js`'s `enhance()` now reads `jz:errcls` (sid→className) before `jz:schema`, and computes the SAME salted dedup key `ctx.schema.register` uses at compile time (`props.length + '\x01' + props.join('\x01') + (salt ? '\x02' + salt : '')`) while merging — a new `mem._schemaKeyToId` map persists that salted key → index binding across enhances (schemas[] itself must stay a plain prop-array list; mem.read's OBJECT case indexes it directly and reads prop names off it, so it can't carry the salt itself). Pinned in test/interop.js (4 built-in classes thrown from one module, O0/O2/O3). watr suite after the fix: 601/626 — the unknown-instruction case is gone, the 3 Shape #7/#8 fails are untouched (same offsets, same signatures).

## Shape #9 found while landing Shape #8, pinned not fixed (2026-08-28)

call-target-index.js lands Shape #8 (`ns.parse`-style points-to) with a full green battery; a second, function-property resolver strategy for watr's real `i64.parse` shape regressed kernel-oracle (crashes) and was reverted, so that deeper shape stays open (watr downstream unchanged at 600/626).
Chasing it surfaced an UNRELATED, pre-existing bug confirmed on unmodified aff67069 with zero `.`-member calls: a reassigned param whose plan-TARGET is BOXED (crosses an export boundary as Number|BigInt) never converts to RAW when passed as a bare-name call argument to a callee expecting RAW — the boxed pointer's own bits cross as-is and misread as a garbage Number.
Pinned KNOWN-WRONG on fix/boxed-param-raw-callee-pin (test/data.js "shape #9"). Root fix: representationCallArgAction / the emitted coerceArg edge for a BOXED-source→RAW-target call argument.

## Shape #9 LANDED (2026-08-28, branch fix/boxed-arg-raw-callee @ fb2dec2e)

Live-traced root cause CORRECTS the pin's own prose: `leb`'s plan-TARGET for
`n` is BOXED, not RAW (`current`/`target` stay pinned to the legacy
whole-program `paramReps` census per the Shape #6 "TWO REGRESSIONS"
invariant, and that census can't see through a bare-name argument that is
itself a reassigned caller local — `exprRep` on a bare local resolves
ANY_BIGINT, open — so it falls back to the coarse closed-ALL-14-kinds
answer, BOOL included). That trips buildBodyData's BOOL-veto, so `leb`'s
`n` never enters `leb`'s OWN materializedNames for ANY caller;
`representationCallArgAction` sees `bodyReady=false` and REJECTs the edge
outright (no coercion at all, not a wrong one) — the caller's still-boxed
pointer bits cross unconverted. Exactly the residual
`solveBigintProvenance`'s own `paramBigintOnly` doc comment already named
and scoped out ("a missed opportunity, not a soundness gap").

Fix: extended the call-site argument proof feeding `paramNeverBool`/
`markNeverBoolArg` (Shape #7's own structurally-weaker "boolean
impossible" bar, not kind purity) — a bare-name argument now also counts
as never-bool when every explicit reaching definition of that name in the
caller's own body (`collectDefs`/`defMapByFunc`) is itself structurally
never-bool (bigint origin, storage read, number/string literal, or a call
whose callee's own return tail is structurally `isBigintOrigin` — pure AST
inspection, no ordering hazard), and the name's own entry semantic, if a
parameter, is also never-bool per the same legacy census. Wired through the
one shared `visitCallSites` call-arg loop Shape #8 already resolves both
bare-name and `.`-member callees through, so both share the identical
proof. Clears the BOOL-veto; `leb`'s `n` materializes BOXED (unchanged
target), the call-arg edge becomes an ordinary BOXED→BOXED KEEP once ready
— no new box/unbox primitive needed, the existing UNBOX/BOX branches in
`representationCallArgAction`/`coerceArg` were already correct.

Two GENUINE, DIFFERENT, separate-scope residuals found and pinned
KNOWN-WRONG while isolating sibling shapes (not fixed here, not this
slice's scope):
1. Once a function's own VALUE is written to a property anywhere (which
   `call-target-index.js` itself needs to resolve ANY `.`-member call —
   e.g. `obj.leb = leb`), narrow.js's whole-program census marks it
   `valueUsed`, flipping `makeBoundaryData`'s `uncovered` true;
   `buildBodyData`'s materializedNames loop deliberately excludes an
   uncovered non-exported param from the fixpoint (`if (params.has(name)
   && boundary.covered !== true && !exportedIdentity) continue`), diverting
   it to the pre-RepresentationPlan legacy sink/generic-closure machinery
   entirely — confirmed independently at emission too:
   `trySchemaClosureCall` dispatches `.`-member calls via a generic
   `ctx.closure.call` and never invokes `representationCallArgAction` at
   all. Needs the closure-materialization subsystem
   (`closureBoxParams`/`mintRepresentationPlan(...,{generic:true})`) to
   prove a value-used function's own param boxed-by-construction across a
   property-dispatched call — the same class Shape #7's own dispatch-table
   residual and the closure-forwarding slice already name.
2. `buildBodyData`'s own `directCallBoundary` (feeding `semanticOf`/
   `currentOf`/`plannedOf`/`walkEdges`) is bare-name-only
   (`ctx.funcs.map.get`, no `resolveMemberCallee` fallback) — unlike
   `solveBigintProvenance`'s own exprMay/exprRep/scan/visitCallSites, which
   Shape #8 already made call-target-index-aware. A caller whose OWN
   bigint-provenance proof for a reassigned local depends on a `.`-member-
   resolved callee (not the RAW-consuming callee itself) still misreads —
   isolated as its own minimal repro, confirmed distinct from residual 1.

Pins: primary flipped to correct at O0/O2/O3; three siblings added — a
non-reassigned BOXED union param (O0/O2 correct, O3 pre-existing
KNOWN-WRONG, confirmed BYTE-IDENTICAL on unmodified fb2dec2e — the same
inliner-splices-before-provenance class the LANDED "shape #7 sibling" pin
already documents, open here for a bare bigint-literal argument instead of
a storage read), the index-resolved `.`-member callee (residual 1, KNOWN-
WRONG), and a RAW→RAW negative control with a WAT-shape assertion (no
`call $__ptr_type`/`call $__alloc` inserted where none is needed).

Battery: native full suite 3714/3713/0/1 (21619 assertions, same
pre-existing skip count), kernel-parity 3/3 (33/33 byte-identical O2/O3),
kernel-oracle 14/14 (605). Watr downstream (fresh `dist/watr.wasm` built
with this branch): 600/626, BYTE-IDENTICAL failure set (same 4 messages,
same exact corrupt offsets) to the pre-existing baseline wasm in the same
worktree — zero change, confirming shape #9 was never watr's own real
`i64.parse` failure (a dispatch-table/computed-property forwarding shape,
matching residual 1's own mechanism, not shape #9's direct-call one).

## Shape #7-residual (named-function-property callee) landed in the index; watr trio still red, now attributed to Shape #9 (2026-08-28, fix/fnprop-call-target @ 8da34240 base)

call-target-index.js's `resolveMember` now also resolves prepare's OTHER `.`-member-write shape: `fn.prop = arrow` attached to a NAMED FUNCTION DECLARATION (watr's real `i64.parse = n => {…}`), not just Shape #8's object-literal `ns.parse`. Two independent gaps, both closed, both required together:

1. **Receiver-safety false positive.** `safeReceiver`'s `nameEscapes` term rejects `i64` as a receiver unconditionally, because `programFacts.nameEscapes`'s `ESCAPE_SKIP` table has no exemption for a call's OWN callee position (`ESCAPE_SKIP['()']` doesn't exist) — so ANY function ever called directly by name anywhere (watr's `encode.i64(...)`, flattened to a bare `m1_encode$i64(...)` call) lands in `nameEscapes`, coarse-but-sound for that set's many other consumers, wrong question for this one. Fixed with a second, narrower gate (`collectValueEscapes`) used only for a function-declaration receiver: does the name appear anywhere OTHER than a call callee or a `.`/`?.`/`[]` receiver. Had to thread "safe position" through `?:`/`&&`/`||`/`??`/`,` too — watr's `compile.js` v128const does `encode[t].parse(...)`, a computed read on a namespace-import (`import * as encode from './encode.js'`) that jz lowers to a ternary-of-equality chain (`t==='i64' ? m1_encode$i64 : …`) BEFORE this scan runs; losing "receiver position" context at the ternary boundary called every branch an escape.
2. **Written-once witness when the write is dropped.** `flattenFuncNamespaces` (plan/scope.js) removes the lift's own `fn.prop = fn$prop` write outright once it proves the property is only ever CALLED, never read as a value — invisible to `collectMemberWrites`'s points-to census by construction. Fallback resolves directly off prepare's own bookkeeping instead: `ctx.funcs.names`/`ctx.funcs.map` for the `${base}$${prop}` lift target, gated on `ctx.funcs.multiProp` being absent for that pair (prepare's own "written more than once" witness — the identical fact `tryFnPropCall`/`bigintMethodTargets`, emit.js, already trust for direct-call emission). For watr's actual `i64.parse`, this branch turned out to be a no-op in practice — `flattenFuncNamespaces` does NOT drop that particular write (i64.parse IS read as a value somewhere in the bundle), so the ordinary census already finds it once (1) stops rejecting the receiver. Kept anyway as the general, watr-independent case the task asked for.

Also added, general (not watr-specific): `releaseLiftedValueUsed`, called right after `buildCallTargetIndex` — a lifted `fn$prop`'s ONLY possible source of `programFacts.valueUsed` membership is its own defining write (the name is compiler-synthesized, provably unique), so once the index re-derives the identical fact, release it from `valueUsed` — `makeBoundaryData`'s `uncovered` (representation-plan.js) stops forcing the conservative closure-shaped materialization path onto a function that's never actually reached indirectly. Confirmed a no-op for watr itself: `collectProgramFacts` deliberately excludes module-init code (where the real write lives, watr being multi-module) from the `valueUsed` walk (its own comment: "a full walkFactsRoot here would… promote init-stored func REFS into valueUsed — a program-wide dispatch behavior change this census repair must not smuggle in"), so `m1_encode$i64$parse` was never in `valueUsed` to begin with. Kept for the general case (an entry-module lift).

**Verified working, in isolation**: a new test/data.js pin (mirroring the Shape #8 `ns.parse` one, "shape #7-residual — FIXED") — `i64.parse` attached to a named function, called both via `.member` and directly elsewhere (`g = () => i64(5n)`, reproducing the exact nameEscapes-false-positive ingredient) — passes at O0/O2/O3. `resolveMember('m1_encode$i64','parse')` confirmed resolving on the real watr build (targeted instrumentation, since removed); all four of representation-plan.js's named provenance consumers (exprMay/exprRep/scan/visitCallSites) pick it up — watr.wasm's OUTPUT SIZE changes (586427 → 587397 bytes), proof the representation fixpoint's answer actually shifts somewhere.

**Watr CI trio still red, byte-identical corrupted offsets, before and after.** Root-cause hypothesis (not fully confirmed — ran out of budget to trace further): `encode.js`'s `i64(n, buffer)` reassigns its OWN param — `if (typeof n === 'string') n = i64.parse(n)` — and once `i64.parse`'s callee resolves (this fix), that reassignment is exactly Shape #9's shape (`function i64(n) { if (typeof n === 'string') n = parseIt(n); return leb(n) }`, THAT pin's own repro, "Found while validating shape #8's own real watr shape (i64.parse attached to a NAMED FUNCTION…)" — same investigation, same commit lineage). Shape #9 is pinned KNOWN-WRONG, unfixed, on this branch's own parent (fix/boxed-param-raw-callee-pin, merged at 8da34240) — a BOXED-representation param crossing a RAW-demanding position, root fix in representationCallArgAction/coerceArg, not call-target-index.js. If this hypothesis is right, the watr trio cannot reach green without Shape #9's own (separately-scoped, "comparably sized" per Shape #7's own note) fix landing first — this session's index work is a precondition, not a substitute.

Battery: test/data.js green (879 assertions incl. the new pin); full `node test/index.js` / kernel build / kernel-parity / kernel-oracle run in progress at hand-off, not yet confirmed.
