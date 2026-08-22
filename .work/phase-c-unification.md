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

## C4b state (2026-08-22): redesigned on branch, merge gated

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
