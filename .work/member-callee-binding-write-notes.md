# Progress notes — fix/member-callee-binding-write

Worktree: /private/tmp/claude-501/-Users-div-projects-jz/0482f00a-7cbc-475b-939a-b25b5ba26704/scratchpad/mc
Branch: fix/member-callee-binding-write, base 21bcfc57. NOT yet committed.

## Done: the mechanical "one authority" widening

Edited src/compile/representation-plan.js. All bare-name-only callee gates
(`typeof node[1] === 'string'`) that resolve a call's callee for BigInt
provenance/materialization now also accept an index-resolved `.`-member
callee via the SAME `resolveMemberCallee` (call-target-index.js), reused
verbatim, never re-derived:

1. `solveBigintProvenance`'s return now exposes `resolveMemberCallee` (was
   already used internally by exprMay/exprRep/scan/visitCallSites — added to
   the returned object so buildBodyData/representationActiveMaterializedRep
   can reuse the SAME instance instead of re-deriving).
2. `structurallyNeverBoolExpr` (Shape #9's own paramNeverBool machinery,
   ~line 855-872): now resolves `.`-member callees too (resolveMemberCallee
   already in lexical scope, no threading needed).
3. `buildBodyData` gained a local `calleeNameOf(node)` helper (right after
   `localClosures`): `typeof node[1]==='string' ? node[1] :
   provenance?.resolveMemberCallee(node[1])?.name ?? null`. All 4
   `directCallBoundary`-gated consumers now use it: `semanticOf`, `currentOf`
   (incl. its embedded duplicate `ctx.funcs.map.get(node[1])` lookup),
   `plannedOf`, `walkEdges`'s call-arg loop.
4. `emittedCandidate` (buildBodyData-local, feeds the JOIN_OPS materialize
   fixpoint): same `calleeNameOf` widening. `closureCallNeedsBox` stays
   bare-name-only by construction (documented inline: a local closure can
   never be a `.`-member call target — call-target-index's own census never
   descends into any function body).
5. `representationActiveMaterializedRep` (exported, emission-time, outside
   buildBodyData/solveBigintProvenance's closures): reaches the same
   resolver via `programPlanRecord(ctx)?.provenance?.resolveMemberCallee`.
   `ir.js`'s `isPlanTaggedBigint`/`readI64` consume this function already —
   no ir.js edit needed, they inherit the fix for free.

Explicitly reviewed and left bare-name-only (documented why, not a gap):
- `isBigintOrigin`'s `node[1]==='BigInt'||node[1].startsWith('BigInt.')` and
  semanticOf's identical arm: builtin-name literal detectors, categorically
  not a same-module callee resolution question.
- `ir.js` `tcoTailRewrite`: tail-call codegen, unrelated to BigInt rep.
- `ir.js` `isSchemaSlotBigintPossible`/`slotIntCertainAt` checks: `.`-member
  READS (property access), not calls — different, already-correct channel
  (slotBigintProvenAt/slotBigintBoxedAt).
- `param-reps.js`: zero BigInt references at all, not a sibling gap.
- Various `typeof node[1]==='string'` on ASSIGN_OPS/collectDefs: these test
  an assignment's LHS target name, not a callee — unrelated.

`node --check` passes. Have NOT yet run the full battery.

## IN PROGRESS: real bug found, not yet fixed

Empirical probe (scratch script, jz() compiled directly, not via test file):

Task's exact repro (`i64.parse` lifted from a named function):
```
function i64(n) { if (typeof n === 'string') n = i64.parse(n); return leb(n) }
i64.parse = n => { n = n.replaceAll('_', ''); return BigInt(n) }
function leb(n) { n >>= 7n; return n }
export let f = () => i64("900")
```
Baseline (pre-fix, 21bcfc57): f() = 3.5e-323 (Number, box-bits-as-payload —
matches task's own description).
With my fix: f() = 72045052733429808n (bigint tag now correct at the
boundary — the fix DID move something — but the VALUE is still wrong, a
different wrongness).

Bisection (see scratchpad/probe2.mjs) isolated it further: even the
SIMPLEST case — `i64.parse("900")` alone, no `leb` at all —
`function i64(n) { if (typeof n==='string') n = i64.parse(n); return n }`
returns pre-fix: 4.447e-321 (Number, wrong); post-fix: "900" (STRING,
unchanged — meaning the reassignment appears to have NO EFFECT on what's
read back).

WAT inspection (O0, see scratchpad/probe1.wat) of $i64 with my fix reveals
the actual mechanism — NOT what I expected:

```wat
(func $i64
  (param $n f64) (result f64)
  (local $0 f64) (local $bbig1 i32)
  (if (i32.and (f64.ne (local.tee $0 (local.get $n)) (local.get $0))
               (i32.eq (call $__ptr_type (i64.reinterpret_f64 (local.get $0))) (i32.const 4)))
    (then
      (local.set $n
        (call $i64$parse
          (block (result f64)
            (local.set $bbig1 (call $__alloc (i32.const 8)))
            (i64.store (local.get $bbig1) (i64.reinterpret_f64 (local.get $n)))
            (call $__mkptr (i32.const 5) (i32.const 0) (local.get $bbig1)))))))
  (return (local.get $n)))
```

The `typeof n==='string'` guard is correct. But the ARGUMENT passed to
`$i64$parse` is WRONG: instead of passing `n` (the string) through
unchanged, it allocates 8 bytes, stores n's OWN NaN-boxed STRING bits into
it, and wraps that pointer as a PTR.BIGINT box (`__mkptr(5, 0, ptr)` — tag 5
= PTR.BIGINT) — i.e. it's applying BOX-BIGINT coercion to a value that is
structurally a STRING at this exact call site (before the reassignment
takes effect). `i64$parse` then receives a fake "BigInt box" whose payload
is actually the string's own tag bits, not 900.

Control (A/B, same probe file): the ALREADY-LANDED, ALREADY-WORKING
bare-name sibling (`n = parseIt(n)` instead of `n = i64.parse(n)`, otherwise
byte-identical `i64` body) compiles `(call $parseIt (local.get $n))` — a
PLAIN pass-through, no coercion at all, and returns the correct 7n through
`leb`. So this wrong-boxing is specific to the `.`-member-resolved shape,
newly reachable through my fix.

## Hypothesis (NOT YET CONFIRMED — next step)

This whole representation-plan analysis is explicitly, deliberately
FLOW-INSENSITIVE per-name (documented repeatedly in the file: "collectDefs
is flow-INSENSITIVE"): `currentNames`/`targetNames`/`semanticNames` hold ONE
value per NAME for the entire function body, not per occurrence. `i64`'s own
`n` is a union across the whole function (string at entry, bigint after the
reassignment via `n = i64.parse(n)` — now correctly seen thanks to my fix).
If that union now MATERIALIZES `n` (enters `materializedNames`, gets a
BOXED target), then EVERY read of `n` — including the read used as
`i64.parse(n)`'s own ARGUMENT, which happens BEFORE the reassignment, while
`n` is structurally still a string — gets coerced via that same blanket
target. That would explain the wrong box.

Open question I was mid-instrumentation on when interrupted: does the
ALREADY-WORKING bare-name sibling (`parseIt`) actually leave `n` OUT of
`materializedNames` (so it never hits this hazard), while my fix newly pulls
`n` INTO `materializedNames` for the member-resolved shape specifically? Or
is `n` materialized in BOTH shapes and the real difference is in
`i64$parse`'s vs `parseIt`'s OWN proven param-0 target (i.e. the LIFTED
arrow `i64$parse` gets a wrong/different signature analysis than a plain
declared function)? Need one bounded instrumentation round (temporary
console.error in buildBodyData around the materializedNames fixpoint and
around representationCallArgAction, gated on an env var, removed after) to
tell these apart before attempting a fix. Do NOT guess-fix without this.

Candidate fix directions once the mechanism is confirmed:
- If this is a genuine PRE-EXISTING flow-insensitivity hazard for the
  `n = f(n)` self-rebinding shape in general (not specific to `.`-member),
  the fix likely belongs in whatever emits the call-argument coercion for a
  SELF-REASSIGNMENT call shape specifically — i.e. recognize `n = CALLEE(n)`
  as a shape where the ARGUMENT occurrence of `n` must use its PRE-write
  representation (current/entry), never the post-fixpoint blanket target.
  This would be a real, narrow, load-bearing fix, not scope creep — but
  needs confirming it doesn't already have a carve-out I'm missing.
- If instead this is specific to the lifted-arrow `i64$parse`'s own
  (wrongly-analyzed) param semantic, the fix is elsewhere (prepare's lift,
  or how a lifted function's signature is seeded into paramReps/provenance).

## RESOLVED: root cause and fix (2026-08-28)

Confirmed via bounded instrumentation (added, used once, fully removed —
zero trace scaffolding left in the diff, matching this codebase's own
precedent): the wrong BOX coercion traced to a SECOND, narrower gap beyond
the mechanical directCallBoundary widening — `edgeMaterializable`'s
BOX/UNBOX safety check (guards buildBodyData's materializedNames/
materializedResult fixpoints against boxing a value not actually proven
bigint) trusted ONLY `valTypeOf(node) === VAL.BIGINT`. kind.js's valTypeOf
has Tier-1 bare-name call resolution (narrow.js's whole-program valResult
census) but deliberately no `.`-member equivalent (the shelved
fix/shape8-member-callee branch's own kernel-taint lesson). Once
calleeNameOf/directCallBoundary could resolve `i64.parse` as a callee, this
became the live blocker: `i64`'s own `n` never entered materializedNames
because `valTypeOf(i64.parse(n))` is null (not VAL.BIGINT), even though
`currentOf` now correctly proves the SAME call node is RAW_BIGINT.

Fix: `calleeProvenBigintResult(node)` — a resolved callee's own proven body
result (materializedResult, falling back to the boundary-level current when
the callee's body hasn't settled yet at this caller's analysis time — same
callee-before-caller ordering fallback currentOf's own Shape #7 comment
already documents) is exactly as sound a BOX/UNBOX admission as
`valTypeOf`'s bare-name proof. Wired as `valTypeOf(node) === VAL.BIGINT ||
calleeProvenBigintResult(node)` — deliberately NOT a broader "trust any
closed source" relaxation, since `currentOf` also reaches closed bits
through the NUMERIC_VALUE_OPS+canBeBigint heuristic branch, which still
needs valTypeOf's stricter gate.

Verified: task's own repro now returns 7n correctly at O0/O2/O3 (was: a
3.5e-323-class Number pre-fix, then a wrong-but-differently-wrong bigint
mid-fix before this second gap was found). Bare-name sibling unaffected
(still 7n). Negative/control probes unaffected.

Known, deliberately out-of-scope residual found during bisection: the
DIRECT-return variant (`function i64(n) { if (typeof n==='string') n =
i64.parse(n); return n }`, no leb call at all — i.e. i64 itself is the
export's own direct callee and returns the reassigned union param
immediately) still misreads (a Number, same wrongness as baseline,
unaffected by this fix either way — checked via A/B). This is NOT the
task's own repro shape (which always forwards through `leb`, matching
watr's real chain) and matches the pre-existing "EXPORT-BOUNDARY RESULT
DECODE" gap class already named in phase-c-unification.md's C1/C2 sections
and the C5b "DIRECT-return union expression" residual — a different
consumer (the function's OWN result/export-boundary materializedResult
path when the function's SOLE body is the reassignment+immediate-return,
never a leb-style forwarding call). Did not chase further: out of this
task's scope, not exercised by the actual watr trio.

Committed: e8d9a851 "route .-member callees through the call-target index
in buildBodyData" (src/compile/representation-plan.js + test/data.js).

## Test pin decision (IMPORTANT — corrects the task brief's own framing)

The task brief said "the KNOWN-WRONG pin 'shape #9 sibling — index-resolved
`.`-member callee' in test/data.js... is this exact residual" (referring to
the directCallBoundary gap). Empirically this is WRONG: that EXISTING pin
uses `const obj = {}; obj.leb = leb` (an object-literal receiver whose
value-write marks `leb` valueUsed, forcing `uncovered`, categorically
excluding it from the materializedNames fixpoint AND routing emission
through trySchemaClosureCall's generic closure dispatch — never
representationCallArgAction at all) — confirmed via direct A/B (before vs
after this fix) to be BYTE-IDENTICAL, completely unaffected by this fix.
That pin's OWN code comment already correctly named this as a separate,
closure-materialization-subsystem-sized gap — I did NOT flip it (flipping
it would just make it fail; verified).

Instead: added a NEW pin right after it, using the task's own exact repro
(`i64.parse` as a lifted NAMED-FUNCTION property — watr's real shape,
matching the "shape #7-residual" pin — feeding a caller-side BINDING WRITE,
consumed via a bare-name `leb`), titled to make the distinction from its
neighbor explicit. This is genuinely what this fix resolves.

## Battery status

data.js: 169/169 pass (896 assertions), including the new pin. Verified
clean (no JZ_PROBE/instrumentation residue — grep confirms 0 hits).

Battery so far:
- native full suite (`node test/index.js`): 3725/3724/0 fail/1 skip (21670
  assertions). PASS, gate met.
- kernel build (`npm run build`): clean, dist/jz.wasm 17527.3 kB.
- kernel-parity: 3/3 (33/33 byte-identical O2/O3). PASS.
- kernel-oracle: 14/14 (605 assertions). PASS.
- `JZ_TEST_TARGET=jz.wasm node test/index.js` (my-fix-built kernel): 2976
  total / 2955 pass / **20 FAIL** / 1 skip. NOT yet a clean gate.

## URGENT: kernel-target 20 failures — baseline A/B IN PROGRESS

The 20 failing kernel-target suites (extracted via inline `×` failure
markers in pretty-format output — TAP format crashes on a BigInt
`JSON.stringify`, a pre-existing tst formatter bug, unrelated, abandoned
that path):
1. statements: compound-assign on BigInt uses i64 arithmetic, not f64
   (memory access out of bounds — a CRASH)
2-13. carrier: bare RAW local whose literal aliases PTR.BIGINT's own box
   prefix / box-tag-shaped family (prefix+1, +arithmetic, +array storage)
   — toString(16), at O0/O2/O3 (4 shapes × 3 opt levels = 12)
14. RepresentationPlan: covered reassigned params use tagged typeof
15. RepresentationPlan: Map storage preserves dynamic BigInt keys/values
16. RepresentationPlan: array mutators preserve dynamic BigInt values
17. RepresentationPlan: JSON.stringify throws on dynamic BigInt
18. bigint: storage-read box-pointer-bits leak through a reassigned param
    across a call (shape #6 — was corrupt) — "unreachable" (a CRASH)
19. bigint: ++/-- on a covered-function param uses RepresentationPlan
    provenance (shape #6)
20. Number: parseInt whitespace / radix / numeric-arg spec edges (memory
    access out of bounds — a CRASH)

WHY THIS IS SERIOUS: nearly every one of these names matches, almost
verbatim, the exact test family the EARLIER "Self-host fixpoint divergence"
investigation (phase-c-unification.md, CLOSED 2026-08-27) traced and
supposedly ruled out for main — "PTR.BIGINT box-tag-aliasing values,
self-host/kernel-target-only divergence". That investigation's own
conclusion was reassuring ONLY because the culprit branch's kind.js Tier-1
`.`-member valResult changes don't exist on main. My fix does NOT touch
kind.js (deliberately, to avoid exactly that hazard) — but it DOES add new
`.`-member-callee-aware paths to representation-plan.js's OWN analysis, so
it is NOT automatically exonerated by that prior investigation's reasoning
— must verify empirically, not assume.

Action in progress: swapped src/compile/representation-plan.js back to the
EXACT 21bcfc57 baseline content (`git show 21bcfc57:... > path`, NOT a git
checkout — plain file overwrite, easy to reverse), rebuilding dist/jz.wasm
from that baseline NOW (backgrounded, task bqf55fvyc, log
/private/tmp/claude-501/-Users-div-projects-jz/0482f00a-7cbc-475b-939a-b25b5ba26704/tasks/bqf55fvyc.output).
Once built, will run the SAME 20 suites via
`TST_GREP='carrier: |compound-assign on BigInt|RepresentationPlan: covered reassigned|RepresentationPlan: Map storage|RepresentationPlan: array mutators|RepresentationPlan: JSON.stringify|storage-read box-pointer-bits|param uses RepresentationPlan provenance|parseInt whitespace' JZ_TEST_TARGET=jz.wasm node test/index.js`
against the BASELINE kernel to see whether these 20 ALSO fail there
(pre-existing, unrelated) or are NEW (a real regression needing a fix or a
revert-and-rethink).

CONFIRMED via A/B: baseline kernel (representation-plan.js reverted to
21bcfc57, rebuilt) passes ALL 20 suspect suites cleanly (53/53 assertions,
0 fail, via TST_GREP-scoped run). This is a GENUINE REGRESSION from my fix,
not pre-existing. RESTORED my fix afterward (`cp /tmp/
representation-plan.MYFIX2.js src/compile/representation-plan.js`,
confirmed `git diff` empty against commit e8d9a851 — worktree source is
back to my fix). Backup copies: /tmp/representation-plan.MYFIX2.js (my fix)
and the baseline dump was transient (not kept separately, recoverable via
`git show 21bcfc57:...` any time).

## Working hypothesis: kernel-instance heap corruption cascade, not 20 independent bugs

`JZ_TEST_TARGET=jz.wasm` compiles EVERY test program THROUGH one single,
long-lived kernel wasm instance (dist/jz.wasm) — the compiler itself is
self-hosted and reused across the whole suite run, unlike each test's own
OUTPUT module (which does get a fresh instance). If the KERNEL's OWN
COMPILATION (not the compiled program's later execution) of one adversarial
program corrupts the kernel's OWN compile-time heap/pointer state (e.g. by
treating a BigInt literal's raw bits, which alias a real PTR.BIGINT box's
tag pattern, as an actual heap pointer and dereferencing/writing through
it), that corruption would persist and explain "memory access out of
bounds" crashes in LATER, textually-unrelated tests (Number: parseInt,
statements: compound-assign) that happen to run afterward in the same
process — not 20 independent regressions, quite possibly ONE root cause
with a corruption cascade downstream of it.

This mirrors the earlier "Self-host fixpoint divergence" investigation's
own confirmed mechanism almost exactly (a kernel that miscompiles ONE
internal BigInt-literal-adjacent shape during ITS OWN self-build, then
misencodes every LATER BigInt constant it touches) — except THIS time
during a later kernel invocation compiling test programs, not during the
kernel's OWN bootstrap build. Grepped jz's own src/ for a watr-i64.parse-
shaped `OBJ.PROP = arrow` pattern near bigint/i64 logic as the likely
self-application trigger — found nothing resembling it (VT.bigint/
jessieParse.space are unrelated). Hypothesis not yet narrowed to a specific
line; next step (kernel rebuilt with my fix restored, task bce48ty31) is to
test the CASCADE hypothesis directly: run ONLY the "Number: parseInt"
suite in isolation (TST_GREP scoped to exclude every carrier/bigint test)
against the my-fix kernel — if it passes ALONE, that confirms cascade
(fix the root "carrier" cause only); if it STILL fails alone, it is a
genuinely separate, third mechanism.

If narrowed to the "carrier" family specifically: the likely next diagnostic
is the SAME technique the earlier investigation used — temporary
console.warn/error instrumentation INSIDE representation-plan.js (which
gets compiled INTO the kernel, so the prints surface from kernel execution
too) around isPlanTaggedBigint/materializedNames/the write action for a
disposable single-file self-compile probe — expensive (each round needs a
kernel rebuild, several minutes), so batch multiple checks per instrumented
round rather than one-at-a-time.

Do NOT report this task done or hand back a green battery until this
regression is root-caused and fixed, or conclusively shown to need a
narrower, documented carve-out. The mechanical `.`-member routing itself
(the 7 sites + calleeProvenBigintResult) is very likely correct in
substance — natively verified thoroughly — but something about it, self-
hosted, corrupts kernel state for this specific adversarial BigInt-literal
family.

## ROOT CAUSE FOUND (2026-08-28) — methodology error in my own bisection, then a real fix

First bisection round was INVALID: my standalone scripts set `JZ_TEST_TARGET=jz.wasm`
as an env var but never called `_setCompileTarget(compileViaKernel)` (test/
kernel-target.js) — that wiring lives in test/index.js itself, not in index.js's
jz(). So my "12 cases all pass individually" and "54-prefix replay doesn't
crash" results were BOTH silently running the NATIVE compiler the whole
time, not the kernel — worthless data. Redid it properly
(scratchpad/bisect_parseint2.mjs, explicitly importing and calling
_setCompileTarget(compileViaKernel) before touching jz()) and it reproduced
immediately and cheaply — no need for the cumulative/GC/cross-instance
theories (confirmed irrelevant: test/kernel-target.js gives every compile a
FRESH 512MB instance, zero cross-compile memory sharing by design).

Isolated to ONE specific sub-case: `parseInt(1e-7)` alone (not the other 11
in that test) throws "memory access out of bounds" through the kernel.

Root cause: `calleeProvenBigintResult` (my new helper, feeding
edgeMaterializable's BOX/UNBOX safety gate) computes `calleeNameOf(node)`,
which — correctly, for its OTHER 6 use sites (semanticOf/currentOf/
plannedOf/walkEdges/emittedCandidate/structurallyNeverBoolExpr) — returns
node[1] directly for a bare-name call. But calleeProvenBigintResult is a
BRAND NEW function, not a modification of an existing bare-name-aware call
site — so accepting bare names too made it a SECOND, independent path to
"proven bigint" for EVERY bare-name call in the ENTIRE codebase (not just
the new `.`-member case), including calls inside jz's OWN runtime-library
internals (parseInt/Ryū number-to-string, module/number.js) that the
self-hosted kernel ALSO has to compile. My own doc-comment claimed
valTypeOf's bare-name proof and this new callee-body proof "always agree"
for bare names — untested assumption, and wrong for at least this one
internal shape: the kernel-compiled version disagrees with valTypeOf badly
enough to corrupt something (materialize/box a value that safety valTypeOf
was correctly withholding from that treatment).

Fix: added `|| typeof node[1] === 'string'` to calleeProvenBigintResult's
bail-out — now STRICTLY additive for the `.`-member shape only, exactly
matching the task's own scope; bare-name calls are governed by valTypeOf
alone, unchanged from baseline, byte-for-byte.

Kernel rebuild with the narrowed fix completed — STILL FAILS
(parseInt(1e-7) still "memory access out of bounds"). Narrowing
calleeProvenBigintResult to `.`-member-only did NOT fix it — my hypothesis
that it was purely about bare-name over-reach was WRONG (or incomplete).
Native re-verification stayed clean throughout (task repro 7n, data.js
169/169) — the regression is confirmed isolated to the kernel-target leg
only, narrowing didn't hurt anything, just didn't (alone) fix it either.

New hypothesis, not yet confirmed: `calleeNameOf`'s widening now runs
`resolveMemberCallee` for EVERY `.`-member call node these 6-7 sites see —
including ordinary METHOD calls (`arr.push(x)`, `n.replaceAll(...)`,
`n.toString(16)`) that pre-fix NEVER reached the directCallBoundary-style
branch at all (its old gate was `typeof node[1]==='string'`, always false
for a `.`-member node, unconditionally falling through to the
memberReceiver/callMember handling further down in the SAME dispatch
chain). Now `calleeNameOf`/`resolveMemberCallee` gets a first look at EVERY
such node, before that fallback. `resolveMemberCallee`'s own shape gate
(`calleeNode[0]==='.' && string receiver && string prop`) matches `.push`/
`.replaceAll`/`.toString` receivers too — for an ordinary LOCAL variable
receiver this should safely resolve to null (shadowed → safeReceiver
false) has NOT been verified as airtight for every receiver shape jz's own
runtime-library internals use (module/number.js's Ryū implementation is
the prime suspect, not yet located: my grep for a literal `OBJ.PROP =`
top-level write pattern found nothing there, but that only rules out the
WRITE side, not a coincidental resolve via the LIFTED-function-property
fallback branch of resolveMember, e.g. if some receiver name inside
module/number.js happens to literally be a function name with NO write at
all, going straight to the `ctx.funcs.map.get(`${objName}$${prop}`)`
fallback — worth checking next if the current bisection round (disabling
calleeProvenBigintResult entirely, task b0b8fmvq2, to isolate whether the
bug is in THAT function specifically vs. the other 6 calleeNameOf sites)
points there).

CONFIRMED via bisection: disabling calleeProvenBigintResult entirely
(`false && calleeProvenBigintResult(node)`) makes parseInt(1e-7) pass
through the kernel (-> 1, correct). The bug is definitively isolated to
THIS function's `.`-member path specifically (already excluded bare names)
— NOT the other 6 calleeNameOf sites (semanticOf/currentOf/plannedOf/
walkEdges/emittedCandidate/structurallyNeverBoolExpr), which are
structurally simpler (pure name substitution, always were reached for the
`.`-member shape via the SAME resolveMemberCallee this function also
calls) — so the bug is specific to calleeProvenBigintResult's OWN
additional logic (the directCallBoundary/materializedResult/resultTarget
lookup chain it does AFTER resolving the name), not to resolveMemberCallee
itself misresolving.

console.warn probe result: it NEVER FIRED for the parseInt(1e-7) crash
(confirmed the probe mechanism itself works — it DID fire correctly for
the task's own i64.parse repro, run through the properly-routed kernel,
which ALSO still correctly returns 7n self-hosted, good independent
confirmation). This means the crash is triggered by calleeProvenBigintResult
being CALLED AT ALL (even hitting only its early-return paths before ever
reaching a resolved calleeName) — not by it resolving anything wrong. So
the hazard is in the RE-DERIVATION machinery itself (calleeNameOf →
resolveMemberCallee → resolveMember, self-hosted), not in any verdict it
produces.

## REAL FIX APPLIED: stop re-deriving, reuse the already-computed `source`

Replaced calleeProvenBigintResult entirely with `calleeSourceProvenBigint
(node, source)` — no callee re-resolution at all. Insight: `edgeMaterializable`
already RECEIVES `source` as its first argument, and at every one of its 5
call sites (verified all 5: the materializedNames loop, the JOIN_OPS
fixpoint's two arms, the later widening pass, and the materializedResult
check) `source` is already either `currentOf(node)` directly or
`emittedCandidate(node).rep` (which itself bottoms out at currentOf(node)
for anything not specially handled) — currentOf's own `.`-member branch
(the FIRST of my 7 original fixes) already computed the exact fact needed.
Trusting `source` directly needs zero extra resolution calls. Scoped to
`node[0] === '()'` so the unrelated NUMERIC_VALUE_OPS+canBeBigint heuristic
branch in currentOf (a genuine, different, still-valTypeOf-gated risk)
structurally cannot reach this arm — mutually exclusive node shapes.

Removed the console.warn probe. First rebuild of calleeSourceProvenBigint
(the "reuse source, no re-derivation" version) STILL CRASHED on
parseInt(1e-7) — surprising given the soundness argument. Root cause of
THAT: when rewriting calleeProvenBigintResult into calleeSourceProvenBigint
I DROPPED the `typeof node[1] === 'string'` bare-name exclusion I had
already proven necessary in the FIRST narrowing round (same file, same
session, same lesson — just re-lost during the rewrite). Confirmed via a
quick native disable test that the function IS structurally load-bearing
(disabling it entirely regresses the task repro back to the wrong bigint
72045052733429808n) — so it can't simply be deleted. Re-added the
exclusion (`typeof node[1] !== 'string'` in the guard). Native re-check:
task repro 7n at O0/O2/O3, still correct. Kernel rebuild #4 in progress
(task bflachyv0) to verify this actually clears parseInt(1e-7)
self-hosted. If it does, that closes the loop: the true, isolated
necessary-and-sufficient condition was "reuse-of-source (not
re-derivation) AND `.`-member-only (not bare-name)" — BOTH changes
together, neither alone was sufter enough on its own in my testing so far
(re-derivation+narrowed still crashed per the very first narrowing round;
reuse+un-narrowed also crashed). If THIS ALSO still crashes, the
regression is not about EITHER axis and needs a completely different
diagnosis — would be the point to seriously consider reporting blocked
rather than continuing to guess.

## Test pin reconnaissance (relevant, already done)

The EXISTING "shape #9 sibling — index-resolved `.`-member callee" pin in
test/data.js (~line 2452) uses `const obj = {}; obj.leb = leb` — an
OBJECT-LITERAL receiver, NOT the named-function-property lift shape my fix
targets. Confirmed via probe (scratchpad/probe1.mjs) that this pin's
behavior is COMPLETELY UNCHANGED by my fix (still `typeof e.f() === 'number'`
at O0/O2/O3, same wrongness as baseline) — consistent with its own code
comment's root cause (a function's value written to a plain object property
marks it `valueUsed`, forcing `uncovered`, which categorically excludes it
from buildBodyData's materializedNames fixpoint AND routes emission through
`trySchemaClosureCall`'s generic closure dispatch, never
`representationCallArgAction` at all) — a genuinely separate,
closure-materialization-subsystem-sized gap, explicitly out of scope per
that pin's own comment. This pin should almost certainly stay KNOWN-WRONG
as-is; it does NOT test the same residual my fix addresses. The task brief's
claim that this specific pin "is this exact residual" appears to be
imprecise — the REAL repro for the residual I'm fixing is the task's own
`i64.parse` arrow-lift example, which has no test/data.js pin yet (need to
add one once the value bug above is resolved, likely right next to the
existing "shape #9 — FIXED" pin, describing it as the genuine
directCallBoundary/buildBodyData residual, and leave the existing
`obj.leb = leb` pin untouched as its own, separate, still-open residual).

## Files touched so far
- src/compile/representation-plan.js — committed at aa61e9d9 (on top of e8d9a851)
- test/data.js — committed at e8d9a851

## Scratch files (not part of the repo, in scratchpad/, safe to ignore/delete)
- probe1.mjs, probe2.mjs, probe1.wat, probe3.wat, representation-plan.MYFIX.js (backup copy)
- bisect_parseint.mjs (INVALID — didn't actually route through the kernel, kept only as a
  cautionary example of the methodology trap), bisect_parseint2.mjs (the CORRECT version),
  bisect_cumulative.mjs (also invalid, same trap), number_prefix_cases.json

## FINAL STATE (end of session, see the fuller writeup inserted above this
section for the complete residual 1/residual 2 findings and battery
numbers)

Branch fix/member-callee-binding-write, base 21bcfc57, commits e8d9a851 +
aa61e9d9. Watr's own named trio (call_indirect64/float_memory64/memory64)
is fixed: 601/626 -> 603/626 on a fresh watr.wasm build via this branch's
cli.js. Two new, narrower, NOT-root-caused residuals were found while
landing this (self-host-only parseInt(1e-7) crash under
JZ_TEST_TARGET=jz.wasm; a large-value watr hex-literal case,
i64-hex-sep1) — both documented in the code and here, neither pinned
(ran out of budget to minimally isolate either in jz-only terms). Native
battery is fully clean (full suite 0 fail, kernel-parity 3/3, kernel-oracle
14/14, data.js 169/169 incl. the new positive pin). The kernel-target gate
(JZ_TEST_TARGET=jz.wasm node test/index.js, required at 0 fail per the task
brief) is NOT met — 20 failures, all traced to residual 1's single crash
cascading within one test file's own run. bench.js size gates: check
/private/tmp/claude-501/-Users-div-projects-jz/0482f00a-7cbc-475b-939a-b25b5ba26704/tasks/br38jeu38.output
for the result (was still running at last check).

Recommendation: do not merge as-is. The core fix (route every
directCallBoundary consumer plus the BOX/UNBOX safety gate through the same
call-target-index resolveMemberCallee, one authority, matching the task's
own explicit ask) is sound and thoroughly verified where it could be
checked directly (native, the actual watr product proof). The two residuals
read as genuinely separate, deeper layers this fix's own correctness newly
exposes — matching this campaign's own repeated historical pattern
(Shape #6's "two regressions found only by the full suite", Shape #9's own
"residual 1"/"residual 2" split) — not evidence the approach itself is
wrong, but real, unresolved gaps nonetheless.

## SESSION 2 (2026-08-28): residual 1 — ROOT CAUSE FOUND, FIX APPLIED, BUT
## THE FIX ITSELF HAS A NEW, UNRESOLVED REGRESSION. NOT MERGEABLE YET.

New agent, continuing from the FINAL STATE above. Worked ONLY in this
worktree, base 21bcfc57, on top of e8d9a851 + aa61e9d9 (uncommitted at
session start: only bench/bench.svg, pre-existing/unrelated).

### Residual 1 root cause (int_literals.wast `i64-hex-sep1`, 0n instead of
### 3078696982321561n)

Minimal native repro (magnitude-only, no `.replaceAll` needed — confirmed
the earlier session's `neg`/`body`-extraction variants were hitting an
UNRELATED pre-existing gap, not this one; a plain `i64.parse = n =>
BigInt(n)` is enough):
```js
function i64(n) { if (typeof n === 'string') n = i64.parse(n); return leb(n) }
i64.parse = n => BigInt(n)
function leb(n) { n >>= 7n; return n }
export let f = () => i64("3078696982321561")
```
Pre-fix: `0n` (wrong) at O0/O2/O3. Bare-name sibling (`parseIt` instead of
`i64.parse`): `24052320174387n` (correct) at all levels — confirms the
divergence is `.`-member-specific, not a general BigInt(string) bug (also
directly verified: `BigInt("0xaf00f00009999")`/`BigInt("3078696982321561")`
called with NO wrapper at all are both correct — jz's own BigInt(string)
runtime conversion is fine).

Magnitude sweep (decimal, real leb-forwarding shape): every power of two
2^16..2^53 is CORRECT via the `.`-member path. Only `3078696982321561`
(and neighboring non-power-of-two values in that range) failed. This
looked magnitude-correlated but isn't cleanly a magnitude threshold —
it's a specific-VALUE-vs-tag-collision thing (below).

WAT root cause (O0, `i64.parse = n => BigInt(n)`, no replaceAll):
`$i64$parse`'s body is `(return_call $__to_bigint (i64.reinterpret_f64
(local.get $n)))` — a RAW i64-disguised-as-f64 result (this is
`__to_bigint`'s own established return convention; the BARE-NAME sibling's
`$parseIt` has the byte-identical body). The two callers diverge:
- BARE-NAME caller (`$i64` calling `$parseIt`): boxes the raw result
  explicitly at the call site — `__alloc(8)` + `i64.store` + `__mkptr(5,
  0, ptr)` — before assigning into `$n`.
- MEMBER caller (`$i64` calling `$i64$parse`): `(local.set $n (call
  $i64$parse (local.get $n)))` — NO boxing. The raw i64-in-f64-disguise
  value flows into `$n` UNBOXED.

Downstream, `$leb` does `(i32.eq (call $__ptr_type (reinterpret n))
(i32.const 5)) (then i64.load through the pointer) (else reinterpret n
directly)` — i.e. it tag-checks `$n` to decide box-vs-raw. For an
UNBOXED raw i64 value, this is only safe if the value's OWN top bits never
alias tag=5 (PTR.BIGINT) by coincidence. `3078696982321561`'s 64-bit
pattern is `0x000af00f00009999`; `(bits >> LAYOUT.TAG_SHIFT=47) &
LAYOUT.TAG_MASK=0xF` = 5 — an exact, confirmed alias. `$leb` wrongly
dereferences it as a pointer (`__ptr_offset` + `i64.load` from a bogus
address), reading `0n` in this run (could as easily be a trap elsewhere —
this IS the "box-tag-shaped i64 constants" hazard class named in this
file's own KNOWN-OPEN comment and in phase-c-unification.md).

**The actual gap**: `ir.js`'s `applyBigintRepresentationAction(ir, node,
action)` (the function that ACTUALLY emits the `boxBigInt`/`maybeUnboxBigInt`
calls for every BOX/UNBOX edge in the whole compiler — assignment RHS,
return, ternary arms, call args, ~15 call sites in emit.js/index.js) has
its OWN, SEPARATE, un-widened admission gate: `if (valTypeOf(node) !==
VAL.BIGINT) return ir` — i.e. it re-derives "is this really a BigInt" via
`valTypeOf` (kind.js) BEFORE trusting the `action` a caller already computed.
`valTypeOf` has the exact same Tier-1-bare-name-only blind spot documented
at length for `edgeMaterializable`'s `calleeSourceProvenBigint` — but
THIS site was never touched by the original 7-site fix (it's in ir.js, not
representation-plan.js, and it's a genuinely separate function, not one of
the `directCallBoundary` consumers). So even though the FIXED upstream
logic now correctly computes `action = REP_EDGE_BOX` for `n = i64.parse(n)`,
this gate silently discards it (`return ir` unchanged) because `valTypeOf(the
i64.parse(n) call node)` is null for a `.`-member call — this IS the 8th
site, and it's why the box never happens.

**Fix applied** (`src/ir.js`, ~line 538-548): added a narrow
`memberCalleeResultProvenBigint(node)` helper reusing
`representationActiveMaterializedRep(ctx, node)` — the SAME already-`.`-
member-aware resolver `isPlanTaggedBigint`/`readI64` already trust for
reads (no new resolver invented; per its own `()` branch it goes through
`programPlanRecord(ctx)?.provenance?.resolveMemberCallee`, i.e. the frozen
call-target index, at emission time — NOT inside any buildBodyData
fixpoint, so it does not carry the reentrancy-flavored hazard the
`calleeNameOf`/`resolveMemberCallee` re-derivation had when called from
INSIDE the analysis fixpoint in the self-host investigation below).
`applyBigintRepresentationAction`'s gate became `valTypeOf(node) ===
VAL.BIGINT || memberCalleeResultProvenBigint(node)`. Verified: the minimal
repro above now returns `24052320174387n` correctly at O0/O2/O3, matching
the bare-name sibling exactly. `node --check` passes.

**Verified against the REAL watr pipeline** (not just the reduction):
built `dist/watr.wasm` via this worktree's `cli.js` against
`/Users/div/projects/watr/watr.js` (-O3 --memory 4096), ran `WATR_WASM=1
node test/index.js` in the watrchk worktree
(`/private/tmp/claude-501/-Users-div-projects-jz/0482f00a-7cbc-475b-939a-b25b5ba26704/scratchpad/watrchk`).
`int_literals.wast` now fully passes (the one assertion that was failing,
`i64-hex-sep1`, is fixed) — residual 1's OWN reported symptom is
conclusively resolved.

### NEW REGRESSION found by the same watr run — NOT YET RESOLVED

Full watr downstream went from baseline 603/626 (1 fail: int_literals) to
**600/626 (4 fail)** with this fix: `compile: simd const`,
`float_memory.wast`, `float_memory0.wast`, `float_memory64.wast` — all
newly broken; int_literals newly fixed. Net regression, confirmed
reproducible (rebuilt twice, same result) and confirmed NOT a
cross-test/shared-instance corruption artifact: `TST_GREP='float_memory'
WATR_WASM=1 node test/index.js` (watrchk's `tst`-based runner, same
`TST_GREP` mechanism jz's own tests use) fails the SAME way in complete
isolation (only float_memory* files execute in that process — nothing
upstream to have corrupted anything).

Exact failure: `assert_return: invoke i64.load() === 9219994337134247936`
(`0x7ff4000000000000`, the bit pattern of `f64.const nan:0x4000000000000`
— float_memory.wast's own literal). Actual value returned:
`9221823924512697384n` = `0x7ffa800001c72c28`. Decoded against jz's OWN
NaN-boxing layout (`layout.js`: TAG_SHIFT=47, TAG_MASK=0xF, AUX_SHIFT=32,
PTR.BIGINT=5): tag=**5**, aux=0, low32=`0x1c72c28`. **This is a
well-formed jz-internal NaN-boxed PTR.BIGINT pointer** (a real `__mkptr(5,
0, someHeapOffset)` value) **leaking out as if it were the raw payload** —
i.e. the same hazard class as residual 1's own root cause, but pointed the
OPPOSITE direction: here a BOXED value is being used where RAW bits were
required, instead of a RAW value being mistaken for boxed.

WAT diff (baseline ir.js vs fixed ir.js, both compiling the full
`watr.js`, `compile(src, {wat:true, optimize:3, memory:4096})` via
`cli.js --wat`) confirms the change is 100% confined to ONE function,
`$m1_encode$i64` (encode.js's `i64()` LEB encoder — the same function
residual 1's fix targets), plus a harmless reordering of the shared
`__mkptr_5_0_d` helper. No other function (in particular `$m1_encode$f64`,
which is where the actually-broken behavior manifests) differs by a
single byte between the two builds. So the regression is NOT a separate
edit reaching into f64's own encoding — it's a consequence of the SAME
gate change, reached through a DIFFERENT call site of `i64.parse`.

Source of that other call site (`src/encode.js`, watr, ~line 244):
`f64()`'s NaN-payload parser —
```js
value = (tail === 'canonical' || tail === 'arithmetic') ? F64_QUIET : i64.parse(tail)
value |= F64_NAN
if (input[0] === '-') value |= F64_SIGN
_i64[0] = value
```
`i64.parse(tail)` here is ONE ARM of a ternary whose OTHER arm is a plain
closed BigInt constant (`F64_QUIET`); the ternary's result then feeds a
BigInt `|=` (arithmetic — needs RAW), possibly a second `|=`, then a
`BigInt64Array` element write. Reduced this exact shape standalone
(`scratchpad/probe-ternary2.mjs`) — **did NOT reproduce**: the reduction's
`.`-member ternary arm is ALSO wrong at baseline (pre-fix) `ir.js`,
byte-identical wrong value with or without the fix — i.e. that reduction
hits a different, pre-existing, unrelated ternary/`.`-member/bigint-op gap,
not this regression. The real regression needs `i64.parse`'s specific
multi-call-site shape (see hypothesis below) that a from-scratch reduction
didn't capture; did not chase a faithful standalone reduction further
before time ran out on this round.

**Leading hypothesis, NOT confirmed**: `representationActiveMaterializedRep`'s
`()` branch (representation-plan.js ~line 2213-2226, the resolver my fix
reuses) reads `calleeRecord.body.resultTarget` — ONE fact stored on the
CALLEE's OWN function record (`ctx.funcs.map.get('i64.parse')`), not
per-call-site. `i64.parse` is called from at least two places with
different downstream needs: `i64()`'s own body (`n = i64.parse(n)`, needs
the caller to BOX — residual 1's own fix) and `f64()`'s NaN-payload
ternary (`i64.parse(tail)`, needs the result to stay RAW for the
immediately-following `|=`). If the fixpoint's single, shared
`resultTarget` for `i64.parse` gets pulled toward BOXED (to satisfy the
`i64()` call site, or some other aggregate reason), EVERY caller now
inherits that same verdict through my new gate — including the `f64()`
ternary arm, which structurally needs RAW. Tested narrowing my fix to
BOX-only admission (excluding UNBOX) as a cheap differential — **made no
difference** (600/626, same 4 fails) — so the wrong verdict is being
produced (and now acted on) specifically as `action === REP_EDGE_BOX` for
this ternary-arm call node; this isn't an admitted-UNBOX problem. Whether
the true bug is (a) the shared/global `resultTarget` fact itself being
too coarse across call sites of the same callee, or (b) a separate,
missing UNBOX at the `|=` operand-coercion site that only became
reachable/consequential once BOX started actually firing here (matching
`ir.js`'s own documented "BOX is unaffected — a box-side mis-proof
double-boxes a garbage payload... out of this fix's scope" caveat) is NOT
yet distinguished. Next step for whoever continues: instrument (temporary,
env-gated, removed after — same discipline as this campaign's prior
rounds) `representationActiveMaterializedRep`'s `()` branch and
`representationBindingWriteAction`/whatever computes the ternary arm's
`action` specifically for `ctx.funcs.map.get('i64.parse')`, compiling ONLY
`src/encode.js`'s `f64`+`i64`+`i64.parse` (need `cleanInt`/`sepRE`/`intRE`
too, or a stand-in) through `cli.js`, to see the actual resultTarget/action
values chosen and which call site drives them.

### Current state / disposition

`src/ir.js` carries the BOTH-direction fix (BOX and UNBOX admission both
widened via `memberCalleeResultProvenBigint`) — kept over the BOX-only
variant since narrowing bought nothing and the symmetric form matches
`edgeMaterializable`'s own established BOX/UNBOX-together precedent.
**NOT mergeable as-is**: trades int_literals.wast (1 fix) for
float_memory/float_memory0/float_memory64.wast + `compile: simd const`
(net -3 on the watr downstream: 603->600). Did not reach residual 2
(self-host `parseInt(1e-7)` crash) this round — ran out of budget
isolating the new regression first, since shipping a fix that regresses
3 previously-green tests to fix 1 is not a defensible trade either way,
and residual 2's own investigation (kernel-parity WAT diffing) is a
separate, substantial effort per the original task brief's own framing.

Did NOT run the full native battery / kernel build / kernel-parity /
kernel-oracle / bench-size this round given the confirmed watr-downstream
regression already disqualifies merging — no point spending a kernel
rebuild cycle (minutes) on a fix known to need more work. `node
test/index.js` (jz's own native suite) was NOT re-run this round either;
should be the first step of any continuation, before further watr/kernel
cycles.

Scratch files this round (scratchpad/, safe to ignore/delete):
probe-hexlit.mjs..probe-hexlit6.mjs, probe-wat1.mjs/probe-wat2.mjs
(+ their .wat outputs), probe-i64enc.mjs/probe-i64enc2.mjs,
probe-ternary2.mjs, dump-watr-wat.mjs.

### Post-commit follow-up: native suite confirmed clean

`node test/index.js` (full native suite, dadce8ce's `src/ir.js`) completed
with **exit code 0, zero `✗`/`×` failure markers** in its output — includes
the "watr metacircular: jz-built watr.wasm produces byte-identical output"
block (22/22 assertions, all wat fixtures byte-identical) and reaches
jz's own pinned "watr-regression: f64.const large hex integer rounds
correctly" test (this exact bug class) with no failure before exit. So the
`ir.js` gate widening is native-clean; the ONLY confirmed-broken surface
remains the watr-downstream regression (float_memory family +
`compile: simd const`, 603->600/626) documented above. Did not additionally
run kernel build/kernel-parity/kernel-oracle/bench-size this session —
correctly gated on resolving the watr regression first per this file's own
"NOT mergeable as-is" disposition.

## SESSION 3 (2026-08-28): ONE AUTHORITY — kind.js valTypeOf itself resolves
## `.`-member callees. Per-site widenings removed. Watr 604/626, 0 fail.

New agent, continuing from dadce8ce (session 2's WIP: ir.js's
`memberCalleeResultProvenBigint`, regressing watr float_memory family to
600/626). Task brief redirected the approach: instead of one more per-site
widening, make kind.js's `valTypeOf` (the kind oracle EVERY consumer
already trusts) itself resolve a `.`-member callee via the frozen
call-target index — so every existing AND future consumer inherits the fix
for free, and the per-site widenings become removable.

### Ordering audit (done first, per the brief's own caution)

Confirmed via reading plan/index.js: `buildCallTargetIndex` runs at line
230, published on `ctx.types.callTargets` (the SAME object also on
`programFacts.callTargets`) — AFTER every early-plan AST-mutating pass but
BEFORE `narrowSignatures`/`solveRepresentationBoundaries` (both callers
further down the same function). kind.js's `valTypeOf` is queried at many
points across the whole pipeline (infer.js during prepare-adjacent passes,
narrow.js throughout its own fixpoint, representation-plan.js, ir.js at
emission) — some BEFORE the index exists, most after. Confirmed this is
SAFE, not the ordering hazard that sank the shelved fix/shape8-member-callee
branch: (1) `valTypeOf` itself has no memoization/cache — it recomputes
fresh from the AST + `ctx` every call, so an early "no index yet" query
never poisons a later one; (2) narrow.js's own comment
(line 2376: "during the first D pass have stale (null) valTypeOf(call)
results") confirms this whole pipeline is ALREADY designed as a converging,
multi-pass fixpoint that tolerates valTypeOf returning a coarser answer
early and a better one later — this is the established pattern, not a new
risk; (3) crucially, the shelved branch's OWN hazard was that its
member-callee resolution was pass-order-dependent (re-derived from
"prepare's tryFnPropCall", itself still-mutating) — call-target-index.js
was specifically built to replace exactly that with ONE frozen, computed-
once-before-any-consumer index (its own header comment says so). Once
`ctx.types.callTargets` exists it is Object.freeze'd and never mutated
again; only the RESOLVED FUNCTION's OWN fields (e.g. `.valResult`) keep
converging afterward — identical in kind and timing to what bare-name
`calleeValType` already tolerates (`ctx.funcs.map.get(callee).valResult`,
kind-traits.js:153-154). Also found a DIRECT, ALREADY-ON-MAIN precedent for
the exact pattern (`ctx.types.callTargets?.resolveMember(expr,
method)?.valResult`) already in emit.js's `bigintMethodTargets` (line
4467) — proof this shape is already trusted in production.

### The fix (src/kind.js, VT['()']'s `.`-member branch)

Added, BEFORE the existing `methodValType` builtin-method dispatch (a
same-module function resolution is a strictly stronger proof than a
name-only builtin-method-name guess):
```js
const resolved = ctx.types.callTargets?.resolveMember(obj, method)
if (resolved?.valResult) return resolved.valResult
```
Mirrors `calleeValType`'s own bare-name tail exactly (same field, same
tier). `resolveMember` already unifies BOTH Shape #8 (object-literal
`ns.parse`) and Shape #7-residual (lifted function-property `fn.prop =
arrow`) cases — one call covers both, satisfying the task's "(and
prepare-lifted function-property) callees" clause with no extra code.

### Per-site widenings: removed two, kept two (with reasons)

**Removed** (src/compile/representation-plan.js's `edgeMaterializable`
BOX/UNBOX gate, `calleeSourceProvenBigint`; src/ir.js's
`applyBigintRepresentationAction` gate, `memberCalleeResultProvenBigint`):
both were literally standing in for `valTypeOf(node) === VAL.BIGINT` /
`!== VAL.BIGINT` — the EXACT question valTypeOf answers — so once valTypeOf
itself resolves `.`-member calls, both gates revert byte-for-byte to their
21bcfc57 baseline form (`return valTypeOf(node) === VAL.BIGINT`; `if
(valTypeOf(node) !== VAL.BIGINT) return ir`) and inherit the fix for free.
`ir.js`'s now-unused `BIGINT_REP_RAW` import reverted too. This ALSO
retired the dadce8ce mechanism that had regressed watr: it reused
`representationActiveMaterializedRep`'s CARRIER verdict (a call-site-
insensitive `resultTarget` fact) as a stand-in for "is this proven BigInt"
— a mismatched abstraction (carrier-choice fact used as a semantic-kind
proof). Confirmed empirically that removing it and routing straight
through fixed valTypeOf does NOT by itself reproduce that mismatch (the
regression's real cause turned out to be one layer deeper — see below).

**Kept** (buildBodyData's `calleeNameOf` helper feeding
`directCallBoundary`-gated `semanticOf`/`currentOf`/`plannedOf`/
`walkEdges`/`emittedCandidate`; `structurallyNeverBoolExpr`'s own
`.`-member resolution; `representationActiveMaterializedRep`'s own `()`
branch, consumed by `isPlanTaggedBigint`/`readI64`) — each needs something
valTypeOf structurally cannot express:
- `directCallBoundary` returns a callee's FULL representation-plan
  boundary record (per-param BOXED/RAW carrier targets, `.result.current`/
  `.target`, not just `.semantic`) — a representation-plan-internal
  carrier/materialization concept entirely outside kind.js's VAL-kind
  vocabulary. `calleeNameOf` only resolves a NAME so this record can be
  looked up; valTypeOf answers a different question (what KIND, not what
  CARRIER).
- `structurallyNeverBoolExpr` recursively walks a callee's OWN return
  tails to prove "never produces a boolean across every path" — a
  whole-body structural walk, not a single-expression kind query.
- `representationActiveMaterializedRep` resolves a callee's own
  `resultTarget`/`materializedResult` — again a carrier fact, not a kind.

Net diff vs 21bcfc57 baseline shrank from 152 changed lines (dadce8ce) to
108 (this session's end state) — the branch got smaller as the task asked,
even after adding two new (unrelated, see below) upgrades.

### Blast-radius check (done early, per the brief's explicit instruction)

`node test/index.js` (full native suite) run early after the kind.js
change — **PASS, exit 0** (background job confirmed, see below for the
exact count once the current run finishes). No unrelated call site
regressed from touching kind.js this session — unlike the earlier shelved
branch, because this fix routes through the frozen index rather than
re-deriving anything pass-order-dependent.

### A SEPARATE, deeper bug found and fixed: plannedOf/semanticOf's own
### boundary-vs-materialized-body asymmetry (NOT `.`-member-specific)

Rebuilding watr.wasm with ONLY the kind.js fix + the two widenings removed
still reproduced the EXACT SAME regression dadce8ce had (600/626, same 4
fails) — proof the mismatched-abstraction theory above wasn't the whole
story. Root-caused via WAT inspection + targeted, temporary (added and
fully removed this session, never committed) console.error instrumentation
in `plannedOf`, `representationJoinArmAction`, and the per-name
`targetNames` computation loop:

1. `plannedOf`'s call-node branch used ONLY
   `directCallBoundary(ctx, calleeName).result.target` — the callee's
   coarse, PRE-BODY boundary guess — with NO upgrade to the callee's own
   settled `calleeBody.resultTarget` once materialized, UNLIKE `currentOf`
   (which already has this exact upgrade, Shape #7's own documented
   pattern). This asymmetry is PRE-EXISTING on baseline too (a bare-name
   callee hits it identically) — merely newly REACHABLE once a `.`-member
   callee's call node starts flowing through `plannedOf`'s call-node branch
   at all. Fixed: mirrored currentOf's exact upgrade.
2. `semanticOf`'s call-node branch had the IDENTICAL gap for
   `.result.semantic` vs a settled `calleeBody.resultSemantic` (the latter
   already stored on the body record, verified present:
   `resultSemantic: bodyResultSemantic` at buildBodyData's own packing
   step) — required because `targetRepFor`'s `definiteBigint(sem)` gate
   needs the PRECISE semantic to ever prefer a closed-RAW `current` over
   the BOXED default. Fixed the same way.

Verified via WAT diff (scratchpad/dump-wat2.mjs + scratchpad/
probe-faithful3.mjs, a hand-written reduction using the REAL aliased-
ArrayBuffer/BigInt64Array `i64.parse` shape watr actually uses — a naive
`i64.parse = n => BigInt(n)` reduction, tried first, does NOT reproduce
the regression at all, matching session 2's own finding): before this fix
the ternary's two arms emitted ASYMMETRICALLY (F64_QUIET stayed raw,
`i64.parse(tail)`'s call result got independently, incorrectly boxed
right at the call site via `__alloc`+`i64.store`+`__mkptr`); after, the
ternary is symmetric (both arms raw, boxed exactly once after the
if/then/else picks one) — a real, confirmed improvement in the emitted
shape, though NOT by itself sufficient to fix the reduction's own final
value (see below — a third, deeper issue).

### Third layer found in the SAME reduction, NOT fixed, but NOT product-
### blocking either (confirmed via the real watr build — see next section)

Continuing to trace why the reduction's OWN final byte sequence stayed
wrong even after fix #1/#2 above: `representationJoinArmAction` REJECTS
this ternary outright (`materializedJoins.has(join)` is false) because the
JOIN_OPS materialization fixpoint (buildBodyData, ~line 1899) only ever
admits a join whose OWN `target === BOXED_BIGINT` — a RAW-target join
(which fix #1/#2 above correctly produce once `value`'s semantic proves
definiteBigint) is structurally never a materialization candidate, so
emission falls through to a DIFFERENT, representation-plan-unaware,
purely-`valTypeOf`-driven generic ternary merge path in emit.js. Traced
one level further (per-name trace on `targetNames` computation): `value`'s
OWN semantic never actually reaches `definiteBigint` in the isolated
reduction — `semanticOf`'s `NUMERIC_VALUE_OPS` branch, for the
self-referential compound-reassignment `value |= F64_NAN`, computes
`operands = [semanticOf('value'), semanticOf('F64_NAN')]`; on any
fixpoint round where `value`'s OWN self-reference hasn't yet converged to
definiteBigint, `anyBig && !allBig` unions in a spurious `VAL.NUMBER` kind
bit (`packSemantic(BIGINT_KIND_BIT | bitOfKind(VAL.NUMBER), ...)`) as a
conservative "might not be all-bigint yet" hedge — and because the outer
semantic fixpoint only ever WIDENS (`joinSem`, never narrows), that
NUMBER bit is now PERMANENT even once later rounds correctly prove
`value` is always BigInt. This is a genuine, general, PRE-EXISTING
fixpoint-imprecision (self-referential compound-assign kind inference),
not a `.`-member-specific gap — confirmed decoded via trace:
`{ sem: 115713, kinds: 1025 (= BIGINT_KIND_BIT|1), definiteBigint: false,
cur: RAW(closed), target: BOXED }`. Separately, and independently needed
either way: typedarray.js's BigInt64Array/BigUint64Array element-WRITE
emitter (`.typed:[]=`'s `isBigInt` branch) has NO defense at all against a
genuinely-BOXED source (`i64.reinterpret_f64` with no tag check) — TRIED
wrapping it in `maybeUnboxBigInt` (ir.js's own established "conservative
pairing" for exactly this kind of fixpoint-uncertain read), REVERTED: it
is UNSOUND for this specific receiver domain — confirmed via the real watr
build, `compile: float literals`/`float_literals.wast` crashed ("memory
access out of bounds") because a NaN-payload's arbitrary 52-bit user
payload can legitimately alias the PTR.BIGINT tag pattern by pure
coincidence (the exact "box-tag-shaped i64 constants" hazard class this
whole file already documents at length), causing a false-positive unbox
that dereferences garbage memory. Neither layer fixed — documented as a
residual, not guessed at further, per this campaign's own discipline
around foundational-fixpoint changes under time pressure.

### THE REAL WATR PRODUCT-LEVEL PROOF IS GREEN — the isolated reduction's
### residual does NOT reach the actual watr.wasm build

Built fresh `dist/watr.wasm` via this worktree's `cli.js` against
`/Users/div/projects/watr/watr.js` (-O3 --memory 4096, 587237 bytes), ran
`WATR_WASM=1 node test/index.js` in the watrchk worktree TWICE (byte- and
result-identical both times):

```
# total 626
# pass 604
# skip 22
```

**Zero fail markers, 604/626 — exactly the task brief's own target.**
Confirmed via grep that `compile: float literals`, `compile: simd const`,
`float_memory.wast`, `float_memory0.wast`, `float_memory64.wast`,
`int_literals.wast` all appear with no `✗` anywhere in the full log — the
memory64 trio, int_literals, float_memory*, and simd-const are ALL green,
and the previously-tracked "unknown instruction" `.message` case is absent
too (already closed by an earlier, unrelated session per phase-c-
unification.md). The isolated reduction's own third-layer residual (self-
referential compound-assign NUMBER-poisoning) evidently does NOT reproduce
in the real, richer watr.js program — plausibly because `i64.parse` is
ALSO called directly from `i64()`'s own body (`n = i64.parse(n)`), giving
the fixpoint a second, independent path to prove `i64.parse`'s result
kind before the narrower NUMBER-poisoning window in the isolated
single-call-site reduction ever opens. The reduction is real (a genuine,
reproducible, narrower bug — worth a jz-only pin for a FUTURE session) but
is not blocking THIS task's own explicit product-level gate, which is met.

Kept: the `plannedOf`/`semanticOf` boundary-vs-materialized upgrades
(sound, precedented, measurably improve emitted shape, no known
regression — pending the full battery below). Did NOT keep: the
`maybeUnboxBigInt` typedarray.js attempt (reverted, unsound for this
domain, confirmed via the real build's own float-literal crash).

Commits this session: 038d523b (kind.js valTypeOf fix + widening
removals), 45ea3581 (plannedOf/semanticOf upgrade).

### Battery status (in progress)

- Task repro (i64.parse+leb, O0/O2/O3): 7n, correct.
- Residual 1 (hex-sep magnitude 3078696982321561, O0/O2/O3): 24052320174387n, correct.
- Bare-name sibling control: unaffected, correct.
- Direct-return variant (documented pre-existing gap): unaffected.
- watr downstream: 604/626, 0 fail (see above) — TARGET MET.
- `node test/index.js` (native full suite): running in background this
  round, result pending — will append once available.
- kernel build / kernel-parity / kernel-oracle / bench-size: not yet run
  this round — next steps.
- Residual 2 (self-host `parseInt(1e-7)` OOB, kernel-parity byte-diff
  method): not yet started this round.
