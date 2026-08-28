# fix/string-method-guess — findings log

Branch: fix/string-method-guess, worktree scratchpad/sm, base ebee13ba (which
already carries fix/param-mutation-propagation's ARRAY-side fix). Task: close
the STRING twin of the ARRAY_INDUCERS unsoundness flagged as out-of-scope at
the bottom of `.work/param-mutation-propagation-notes.md` — `methodEvidence`
(src/compile/infer.js) also treated `<param>.charCodeAt(...)` (STRING_ONLY_
METHODS: charCodeAt, trim, padStart, …) as PROOF the parameter is a real
String, with no check for an own same-named closure property. Scope was
later extended (coordinator message mid-session) once bench measurement
showed the ALREADY-LANDED ARRAY fix regressed a real downstream program
(watr.js) — the task became "make BOTH guesses sound AND recover the
regression via caller-side proof strengthening," target watr.wasm ≤ 586426 B
at -O3 (the pre-ARRAY-fix, pre-STRING-fix baseline at 564cc27b).

## Repro confirmed (repro/string-collision.mjs, repro/string-collision-family.mjs — scratch, not committed)

Object literal with a POST-HOC attached closure property named `charCodeAt`/
`trim`/`padStart` (not a real String), mutated/read by calling that closure
THROUGH a separate function's own parameter — the STRING-shaped twin of the
ARRAY fix's makeByteBuf idiom:
```js
function makeT(n) { const t = { n }; t.charCodeAt = (i) => t.n + i; return t }
function call1(o) { return o.charCodeAt(1) }
export function main() { return call1(makeT(100)) }
```
Native: 101. jz (ebee13ba, before this fix) at O0: NaN (O2/O3 matched by
incidental optimizer reshaping — inlining changes the shape enough that the
hijack no longer fires, not a real fix). Confirmed the same defect family for
`trim`/`padStart`, a count-0/1 loop variant, and a `.length`-read-elsewhere
sibling pin (the emitLengthAccess/property-read consumer, mirroring the
ARRAY fix's second consumer).

## Root cause (source)

Identical mechanism to the ARRAY case, one rung over: `src/compile/infer.js`
`methodEvidence`'s `STRING_ONLY_METHODS` branch called `induce(name,
'string')` unconditionally on seeing `<param>.charCodeAt(...)` etc., with no
own-property-shadow check. Once wrongly settled to VAL.STRING, downstream
consumers trusted it as a hard proof — but where the ARRAY case landed on
emit.js's `tryGenericEmitter` (strategy 10, whose shadow probe merely needed
widening because ARRAY_INDUCERS names have no `.array:${method}` sibling
emitter), the STRING case is structurally different: STRING_ONLY_METHODS
names ALSO have no `.string:${method}` sibling emitter for the generic path
(`charCodeAt`, `trim`, etc. are registered BARE — `bind('.charCodeAt', ...)`
in module/string.js — the generic-key slot, not `.string:charCodeAt`), so
strategies 7 (tryStaticDispatch) and 8 (tryRuntimePtrTypeFork) never engage
for them EITHER WAY (vt proven or not) — they ALSO land on strategy 10,
tryGenericEmitter, exactly like ARRAY_INDUCERS names. So the SAME shadow
probe protects both once `vt` is genuinely null — no new emit.js widening
was needed for STRING (see "Fix applied" below).

`charCodeAt` additionally has its own hyper-optimized "Shape 1" fast path in
`src/abi/string.js` (`sso.ops.charCodeAt`'s param-decomposition prologue) —
this path is gated ONLY on "is the receiver a non-boxed, non-reassigned f64
PARAMETER", never on `vt`/proof — so it looks unconditional. In practice it's
reached only via `tryGenericEmitter`'s `callFlat` fallback (i.e., only after
the shadow probe declines / doesn't apply), so it inherits that gate's
soundness once methodEvidence stops handing it a false vt.

## Fix applied

1. `src/compile/infer.js`: `methodEvidence` retired COMPLETELY (not just the
   STRING half). Once STRING_ONLY_METHODS' `induce(name,'string')` is
   removed, NOTHING else in that function can ever populate the local
   `evidence` map with 'string'/'array' (ARRAY's own induce was already
   removed by the prior fix; the ARRAY_ONLY_POISON poison-on-conflict branch
   only ever fired against a 'string' entry, which can no longer exist
   either) — so the whole rung mechanically reduces to a permanent no-op.
   Rather than leave dead machinery, deleted `methodEvidence`,
   `ARRAY_ONLY_POISON`, and its `registerEvidence('method', ...)`
   registration outright; kept `STRING_ONLY_METHODS` (still consumed by the
   separate, still-sound `notStringEvidence` source for its own, unrelated
   write-shape "isn't a string" proof). Updated the evidence-ladder header
   doc (rungs 2/3) and the notStringEvidence section comment to stop
   describing the retired mechanism as live.
2. `src/compile/emit.js` / `src/kind-traits.js`: no STRING-specific change
   needed (see root-cause section) — but discovered emit.js's existing
   `guessedArrayParam` widening (fix/param-mutation-propagation's Part A,
   "defense in depth... kept as a second layer even though the infer.js fix
   alone resolves the repro") had become ENTIRELY DEAD WEIGHT once BOTH
   methodEvidence guesses are gone: with no remaining source that can hand a
   parameter a wrongly-guessed `vt`, `vt == null` is once again the complete
   unproven-receiver test, and the widening's ONLY effect left was to force
   the shadow probe onto every SOUNDLY-proven ARRAY parameter reached via a
   recursive/forwarding call chain (see "watr regression" below — this
   widening was the majority contributor). Removed `guessedArrayParam`
   entirely (and the now-fully-unused `ARRAY_INDUCERS` export from
   kind-traits.js, and its now-dead import in emit.js). Confirmed via the
   full hijack pin family (both ARRAY's makeByteBuf and STRING's
   charCodeAt/trim/padStart) that soundness is unaffected — nothing else can
   reach this branch with a false `vt` anymore.

## Pins added (test/data.js, appended after the ARRAY fix's own pins)

- charCodeAt/trim/padStart own-closure-via-param hijack family, O0/O2/O3
- loop count 0/1 variant (charCodeAt)
- `.length`-read-elsewhere-in-the-same-function sibling (the
  emitLengthAccess consumer, mirrors the ARRAY fix's second pin)
- WAT-shape pair: a call-site-proven (paramReps) string param keeps direct
  STRING dispatch (no `__dyn_get_expr` probe); an UNPROVEN param in a
  program that DOES have closures elsewhere gets the probe — proves the fix
  changes real codegen in both directions, not vacuously true either way

test/inference.js: two tests asserting the REMOVED (unsound) "charCodeAt
induces STRING" behavior rewritten to assert the corrected floor (a real
string still computes the JS-correct answer through the now-fully-general
runtime-dispatch path; no WAT-shape assertion on `$__length`/`$__len` counts
— that internal shape turned out to be a heavily-inlined dynamic-property
probe, not a stable marker worth pinning).

test/errors.js: `strict: .charCodeAt-inferred string param rejects a number
argument` (asserted a strict-mode compile ERROR from the same unsound proof)
rewritten to its mirror-of-the-`.push`-pin shape: a genuinely polymorphic
(string-or-number) charCodeAt-using param must NOT be rejected on usage
alone — trading an optional diagnostic for never silently miscompiling the
closure-shadow shape (STABILITY.md).

test/deopt.js: "D1: all sized kinds narrow — typed/plain/string .length in
+" had a third (string) case folded in, asserting the SAME unsound proof let
`.length` narrow to NUMBER and skip `__str_concat`. Split into its own
SOUNDNESS pin: an unproven string-shaped param (methodEvidence retired)
keeps `.length + x` on the string-capable dispatch — mirrors the pre-existing
"untyped receiver .length stays conservative" D1 pin one test down.

## Battery status — FULL, all green

- `node test/index.js`: **3738 total, 3737 pass, 1 skip, 0 fail** (21727
  assertions). Baseline at ebee13ba (probed fresh, same conditions): 3731
  total / 3730 pass / 1 skip / 0 fail. Delta +7 total reconciles exactly with
  this branch's own new/restructured tests (6 new test() groups in
  test/data.js's hijack-pin family + 1 net-new from splitting test/deopt.js's
  folded D1 string case into its own soundness pin; test/inference.js and
  test/errors.js each replaced tests 1:1, net 0).
- `npm run build`: succeeds. `dist/jz.wasm` (the general-purpose, non-tree-
  shaken compiler artifact — NOT comparable to the watr-program numbers
  below, which are a SPECIFIC tree-shaken program's output) = **17,992,062
  bytes**.
- `JZ_TEST_TARGET=jz.wasm node test/index.js`: **2989 total, 2988 pass, 1
  skip, 0 fail** (14348 assertions) — the kernel-mode subset (JS-host-only
  tests, e.g. CLI/toolchain-comparison cases, are skipped when targeting the
  wasm kernel directly, hence the smaller total than the JS-mode run).
- `node test/kernel-parity.js`: 33/33 assertions, 0 fail.
- `node test/kernel-oracle.js`: 14/14 tests (605 assertions), 0 fail.
- `node scripts/bench-size.mjs --json` (the SIZE_BUDGET gate test/bench.js
  itself asserts, minus the toolchain-heavy SPEED comparison — see "watr.wasm
  regression" section below for why the full `node test/bench.js` run was
  abandoned on this machine): **23 of 24 budgeted cases pass comfortably**
  (nearest margin: fft 2384/3000, all others ≤ ~70% of budget). **`watr`
  fails its budget**: measured 300640 B against a 298000 B budget (+2640 B,
  +0.9%) — this is the SAME regression measured two ways (see next section);
  not a new/different failure.

## watr.wasm regression — measured, and how much this fix recovers

Coordinator-supplied baseline (verified independently): `node cli.js
/Users/div/projects/watr/watr.js -O3` compiled with:
  - 564cc27b (pre-ARRAY-fix, pre-STRING-fix): **586426 bytes** (target)
  - ebee13ba (ARRAY fix landed, STRING guess still active): 612457 (coordinator-reported) / **616516** (measured fresh in this worktree before any of my changes — see note below on the discrepancy)
  - this branch, STRING retirement only (methodEvidence fully gone, emit.js
    unchanged): still 616516 (methodEvidence's removal alone doesn't change
    watr's ARRAY-heavy hot paths at all — expected, since watr's push/pop/
    shift/splice-heavy encode/compile modules dominate, and those were
    already broken by the EARLIER ARRAY fix's own emit.js widening, not by
    anything STRING-specific)
  - this branch, STRING retirement + `guessedArrayParam` removal: **603144
    bytes** — recovers 13372 bytes, roughly 45% of the 616516→586426 gap.

Same regression, measured the OTHER way — `node scripts/bench-size.mjs watr
--json` (jz's own `optimize:'size'` preset, the exact build test/bench.js's
`SIZE_BUDGET.watr = 298000` gate asserts against, a DIFFERENT, size-tuned
profile from the `-O3` numbers above, hence the different absolute scale):
  - 564cc27b: 293105 B (PASSES the 298000 budget, headroom 4895 B)
  - ebee13ba: 304109 B (FAILS, +6109 B over budget — matches the
    coordinator's cited "304128" almost exactly, cross-confirming both
    measurement methods agree)
  - this branch: 300640 B (STILL FAILS, +2640 B over budget) — recovered
    3469 of the 11004 B ebee13ba→564cc27b gap, ~32% — proportionally
    consistent with the ~45% recovered on the -O3 measurement (different
    optimize profile, same underlying mechanism and same residual cause).

(The 612457-vs-616516 discrepancy against the coordinator's own number is
unexplained — possibly a different watr.js revision or jz commit at
measurement time; not chased further given the time budget. My own 616516
was measured against the SAME watr.js path this session used throughout,
immediately after creating a clean reference worktree at ebee13ba with no
edits, so it should be a solid same-conditions baseline for judging MY
deltas even if the absolute number doesn't match the coordinator's.)

## Root cause of the REMAINING ~16718-byte gap (603144 → 586426) — diagnosed, NOT fixed

Isolated a minimal repro (not the full watr complexity, but the same
mechanism, confirmed via targeted instrumentation — see method below):

```js
const uleb = (n, buffer = []) => {              // mirrors watr/src/encode.js's real uleb
  let byte = n & 0x7f
  n >>>= 7
  if (n === 0) { buffer.push(byte); return buffer }
  buffer.push(byte | 0x80)
  return uleb(n, buffer)                        // recursive self-call, buffer forwarded
}
const wleb = (v, out) => { if (out) { uleb(v, out); return } return uleb(v) }  // mirrors watr's actual wleb
export function useIt() {
  const b = []
  wleb(5, b)
  return uleb(300).length
}
```

`uleb`'s `buffer` parameter is genuinely, soundly provable ARRAY (default
`= []`, plus every real call site — direct, recursive-self, AND the
`wleb`-forwarded one — agrees). Confirmed via direct instrumentation of
`src/compile/index.js`'s param-fact-seeding site (the `if (r.val &&
!reassigned && paramValTrustworthy(r) && ...)` line, ~563 and ~1536) that:
  - `r.val === 'array'` (the narrow, per-site fold DOES converge correctly —
    confirmed via `hardParamVal`/`inferValAtSite` tracing too, including
    across the recursive-self-call skip in `applySiteRules`, which works as
    designed)
  - but `paramValTrustworthy(r)` returns **false** for this exact param —
    the WIDER `possibleKinds` census (param-reps.js, Slice 4a's `trackKind`
    join, riding the SAME `mergeRule('val', ...)` fixpoint via `joinKinds`)
    has `size > 1` with `kindsCoverage === 'closed'`, i.e. it believes
    MULTIPLE kinds were genuinely observed and every site was enumerated —
    contradicting the correctly-converged narrow `val`.

Root cause of the `possibleKinds` false-polymorphism: `mergeRule`'s
`apply`/`missing` handlers join `KIND_UNIVERSE` into `possibleKinds`
whenever a single site's argument can't (yet) be classified (`v == null`),
by explicit design ("an UNRESOLVED live observation... must join the FULL
universe, not be skipped" — narrow.js's own comment on `mergeRule`, and this
IS load-bearing: it's what stops `possibleKinds` from silently reading as a
false-complete superset when a site is truly unclassifiable). The
`runFixpointConverged` worklist (narrow.js ~2296) DOES correctly re-queue
and re-fold dependent sites as facts change (confirmed: `wleb`'s call site
`uleb(v, out)` gets re-visited once `wleb`'s OWN `out` parameter settles to
ARRAY from ITS OWN call site `wleb(5, b)`) — but `joinKinds` is a MONOTONE
union with no retraction: if THIS call site (`wleb → uleb`, arg `out`) is
visited even ONCE, on ANY earlier worklist pass, before `wleb.out` itself
has settled (an ordering/timing artifact of the worklist, not a real
disagreement), it permanently joins `KIND_UNIVERSE` into `uleb.buffer`'s
`possibleKinds` — and no LATER, correctly-resolved re-visit can ever
retract that. The narrow `val` fold self-heals via re-queueing (its own
per-attempt result overwrites, doesn't accumulate); the wide `possibleKinds`
fold does not (it accumulates, by design, for the unrelated purpose of
catching REAL polymorphism) — so a parameter reached ONLY through a
forwarding chain (never a direct literal at every hop) can get permanently,
falsely flagged "closed-census polymorphic" by an artifact of visit order,
even though its `val` genuinely converges.

This is precisely the class of bug `paramValTrustworthy`'s own gate was
built to prevent going the OTHER direction (a real HASH masquerading as a
trusted single `val` — fix/selfhost-hash-read) — the mechanism is sound in
that direction; this is the mirror-image false positive, not a new class of
unsoundness, and not something a quick patch should touch without the same
rigor that mechanism's own audit trail (`audit-#16`, `re-audit item 9`,
`FINDING-7`, all cited in param-reps.js) received. Two candidate fixes, NOT
attempted this session (ran out of a responsible time budget for a change
this close to a load-bearing, previously-audited soundness gate):
  (a) Defer the `trackKind`/`possibleKinds` join to run as its OWN pass
      AFTER `val`'s worklist has fully converged (decouple it from riding
      the same per-visit `mergeRule.apply`), so "unresolved" is judged
      against the FINAL state, not a mid-fixpoint snapshot — fewer sites
      would ever see a transient `v == null`.
  (b) Give `joinKinds`/`possibleKinds` a retraction-aware variant for this
      specific SOFT/re-queued fixpoint (re-derive fully on the LAST visit of
      each site rather than accumulate across every visit) — more invasive,
      touches the shared `joinKinds` primitive other consumers rely on too.
  Either needs the FULL kernel-parity/kernel-oracle/self-compile battery
  (not just watr) before landing, given the gate's history.

## What was explicitly NOT done

- Did not touch `src/abi/string.js`'s charCodeAt Shape-1 fast path (sound —
  gated on parameter-reassignment safety, not on `vt`, and only reached
  through the shadow-probed generic path once methodEvidence stops lying to
  it).
- Did not touch kind-traits.js's `methodValType`/`STRING_METHODS`/
  `NUMBER_METHODS` (a DIFFERENT function — types a method CALL EXPRESSION's
  own result kind, not the receiver's kind; out of scope, pre-existing,
  untouched by either this or the ARRAY fix).
- Did not attempt the `possibleKinds` ordering fix above (see reasoning).
- Did not hand-tune watr.js or any other input program — every change is in
  jz's own compiler (infer.js, emit.js, kind-traits.js).
- Known, PRE-EXISTING (shared with the ARRAY fix, not introduced here)
  residual: a parameter of a function with NO closures ANYWHERE in the
  compiled program, and NO other proof, used with a STRING_ONLY_METHODS (or
  ARRAY_INDUCERS) call, still can't defend against a HOST-CONSTRUCTED
  hijack object crossing the export boundary — `ctx.closure.call`'s own
  availability gates the shadow probe, and a zero-closure program never
  pulls in that runtime infra. Confirmed this EXACT gap already existed for
  the ARRAY case pre-this-session (`export function tail(xs){xs.push(0);...}`
  called with a foreign `{push:...}` object silently returns 0, not a
  throw). Out of scope for both fixes; flagged here for visibility, not
  something either commit regresses.

## Follow-up session: the possibleKinds census ordering fix (branch tip 594879e1)

Implemented candidate (b) from "Root cause of the REMAINING ~16718-byte gap"
above — deferred `trackKind` (the `possibleKinds` census join) out of every
mid-fixpoint sweep and into the single, already-existing final hard-settle
sweep (`runCallsiteLattice([mergeRule('val', ..., false, true)])`, the
"Settle val HARD" comment) that runs only after every fact `inferValAtSite`
depends on (val itself, arrayElemValType, schemaId, typedCtor, pointer-ABI
enrichment) has reached its OWN fixed point. `src/compile/narrow.js`:
`fixpointRules`' own `mergeRule('val', ..., true, true)` → `mergeRule('val',
..., true)` (trackKind now defaults false there); the pre-existing final
sweep already had `trackKind=true` and needed no change beyond a doc
comment. No change to `paramValTrustworthy`, no watr-specific special-casing
— every earlier `v == null` case still joins KIND_UNIVERSE exactly as
before; the ONLY thing that changed is WHEN that join is allowed to happen
for the trackKind mechanism, never what it joins.

Verified sound and non-vacuous three ways (test/data.js, appended after
"RepresentationPlan: a polymorphic-receiver param stays runtime-dispatched"):
1. **Positive pin** — the exact uleb/wleb repro (a closure-bearing sibling
   function added so the shadow-probe machinery is confirmed live in the
   same compiled unit): `uleb`'s `buffer` param now compiles to direct
   `__arr_push1` array codegen, no `__dyn_get_expr` shadow probe. A/B
   confirmed against the pre-fix narrow.js: the probe WAS present before
   (full WAT 197539 chars vs 133088 after, at -O3).
2. **Negative control** — a param forwarded from a GENUINELY (not merely
   apparently) polymorphic source (`forward`'s own `x`, fed an array at one
   call site and a closure-hijack object at another) still gets the shadow
   probe: the fix narrows WHEN KIND_UNIVERSE gets joined, never removes a
   real disagreement's poison.
3. **Ordering-independence pin** — swapping `uleb`/`wleb`'s source
   declaration order (which determines the worklist's initial seed order)
   now yields byte-identical WAT at -O3. Confirmed this WAS order-dependent
   pre-fix (40-line diff between the two orderings, same aggregate size).
   (At O0/O2 the two orderings differ only in which order two UNRELATED
   stdlib helper functions — `__ptr_offset` vs `__mkptr` — appear in the
   module; `uleb`'s and `wleb`'s own function bodies are separately confirmed
   byte-identical at every level. That helper-ordering variance is a
   pre-existing, unrelated artifact of something else entirely, not part of
   this bug — hence pinning strict whole-module equality only at O3, where
   watr's own optimizer canonicalizes it away too.)

Bonus, unplanned fix found via the battery: "bigint: shape #9 sibling —
non-reassigned BOXED param" had an O3 leg pinned as KNOWN-WRONG (a
corrupted-number misread, `f()` returning e.g. `3.5e-323` instead of `7n` —
confirmed via A/B this is genuinely fixed by the SAME narrow.js change, not
a coincidence). Traced to a DIFFERENT possibleKinds consumer than
paramValTrustworthy: `src/compile/representation-plan.js`'s own
`paramEntryExcludesBool` reads `rep.possibleKinds`/`kindsCoverage` directly
to prove a forwarded param structurally excludes BOOL. Confirmed this is NOT
gated by paramValTrustworthy itself (no distrust event fires for this
program — `bigint` isn't in `PTR_TAGGED_KINDS` at all) — a second,
independent consumer hit by the identical ordering-artifact family. Did not
re-trace this one's exact premature-join call site with the same rigor as
the primary repro (time-boxed); the test comment (test/data.js) says so
plainly rather than asserting an unverified mechanism.

### Product-proof measurements — before (594879e1) vs after (this fix)

- `node cli.js /Users/div/projects/watr/watr.js -O3`: **603144 B → 597581 B**
  (-5563 B). Target 586426 B — NOT met; ~11155 B of the diagnosed 16718 B gap
  remains. Confirmed via a temporary debug counter on `paramValTrustworthy`
  that this fix's own mechanism is now fully clean for this exact build: 2
  DISTRUST events (both `val=array`, full-universe `possibleKinds`) before,
  **0 after**. The residual ~11155 B is therefore attributable to something
  ELSE — a separate, undiagnosed cause, not a partial fix of this one (this
  mechanism's own contribution is fully closed, not partially).
- `node scripts/bench-size.mjs watr --json` (optimize:'size' preset, the
  SIZE_BUDGET gate's own build): **300640 B → 300640 B, unchanged**. Verified
  why: `bench/watr/watr.js` is a SEPARATE, curated benchmark harness (bundles
  only compile.js/encode.js/const.js/parse.js/util.js, drives a fixed WAT
  micro-corpus through `compile()` in a loop) — NOT the same program as the
  real watr.js CLI. Confirmed via the same debug counter: 0 DISTRUST events
  in this harness's build, BOTH before and after this fix — the ordering bug
  never manifested in this specific smaller call graph to begin with, so
  "unchanged" is the correct, expected result here, not a sign the fix is
  ineffective. This SIZE_BUDGET gate (watr: 298000) still fails at 300640 —
  unrelated to and unmoved by this fix; was already failing at the same
  value at the branch tip this session started from.
- Kernel (`npm run build` → `dist/jz.wasm`, the self-hosted compiler
  compiling itself — a different, much larger program than either watr
  measurement above, sharing the same compiler internals): **17,992,062 B →
  17,954,279 B** (-37,783 B). main (pre-STRING/ARRAY-retirement baseline):
  17,941,790 B — was 50,272 B larger than main before this fix, now only
  12,489 B larger. jz's own source apparently has forwarding-parameter
  shapes structurally similar to watr's uleb/wleb, so this fix's benefit
  compounds when the kernel compiles itself.

### Battery — full, all green (this session, on top of the prior checkpoint)

- `node test/index.js`: 3741 total / 3740 pass / 1 skip / 0 fail (+3 over the
  594879e1 checkpoint's 3738 — exactly the 3 new test() groups).
- `npm run build` + `JZ_TEST_TARGET=jz.wasm node test/index.js`: 2992 total /
  2991 pass / 1 skip / 0 fail (+3 over 2989, same reconciliation).
- `node test/kernel-parity.js`: 3/3 tests, 33/33 assertions.
- `node test/kernel-oracle.js`: 14/14 tests, 605/605 assertions.
- `node scripts/bench-size.mjs --json` (all cases): 23/24 budgeted cases
  pass; `watr` fails at 300640 vs 298000 budget — same, pre-existing,
  unmoved by this fix (see above).
- Full `node test/bench.js` (size + speed + toolchain rivals): exceeded this
  session's bounded-round time budget on this machine — consistent with the
  prior session's own note that this specific run was "abandoned on this
  machine." The size-gate portion of what it asserts was covered directly
  via `scripts/bench-size.mjs` above instead.

### What was explicitly NOT done (this follow-up session)

- Did not investigate the residual ~11155 B (-O3) / unmoved 300640 B (size
  preset) gap further — out of THIS task's precise scope (fix the diagnosed
  ordering bug conceptually; do not hunt for watr-specific patches). Flagging
  for a follow-up: since this fix's own mechanism is confirmed fully clean
  (0 DISTRUST events) on the real watr.js -O3 build, the remaining gap is a
  DIFFERENT, as-yet-undiagnosed cause.
- Did not re-trace the shape-#9-sibling bonus fix's exact premature-join
  call site (paramEntryExcludesBool's own consumption of possibleKinds) with
  the same rigor as the primary repro — the value flip is empirically
  A/B-confirmed real; the exact mid-fixpoint visit that used to pollute it
  was not separately isolated.

## Second follow-up session: instrumented the residual gap, found ONE dominant
## cause class, did NOT land a fix (see reasoning below)

Branch tip still c2cab870 (worktree scratchpad/sm) — this session made no
source changes; only temporary (reverted) instrumentation. Task: instrument
`tryGenericEmitter`'s shadow-probe branch (emit.js) and `emitLengthAccess`'s
runtime-dispatch fallback (module/core.js) to log every ARRAY_INDUCERS/
STRING_ONLY_METHODS/`.length` receiver that is a PARAMETER reaching generic
dispatch, for `bench/watr/watr.js` (the SIZE_BUDGET gate's own build,
298000 B) — group by cause, fix conceptually per class.

### Instrumentation method (temporary, reverted — not in the diff)

Four `JZ_DBG_*`-gated `console.error` sites, all removed before finishing
(worktree restored to byte-identical HEAD via `git show HEAD:path > path`):
1. emit.js `tryGenericEmitter`, inside `if (vt == null && ctx.closure.call
   && …)`: logs `{family, funcName, paramName, method, reassigned, rep}`
   when `method` ∈ ARRAY_INDUCERS/STRING_ONLY_METHODS and `obj` is a bare
   param of `ctx.func.current` (`JZ_DBG_GENERIC=1`). `ctx.func.current` is
   the bare `sig` object (`{params, results}` — `src/compile/active-
   function.js` `createActiveFunction`); it carries NO `.name` (name lives
   on the sibling `funcInfo` in `ctx.funcs.list`, destructured separately in
   compile/index.js) — resolved via `ctx.funcs.list.find(f => f.sig ===
   fn)?.name`, an O(n) lookup fine for temp debug only.
2. module/core.js, in `ctx.core.emit['.']`'s `.length` arm, right after
   `arrayOrTyped` is computed: same log shape for the `vt == null &&
   !arrayOrTyped` case (the only remaining branch that reaches
   emitLengthAccess's `__length.value` runtime-dispatch fallback).
3. compile/index.js, both param-fact-seeding sites (~563, ~1536): logs
   `{cause, val, kindsCoverage, possibleKinds}` per param, where `cause` ∈
   REASSIGNED / BOTTOM (`r.val===undefined`) / TOP (`r.val===null`) /
   DISTRUSTED (`r.val` set but `!paramValTrustworthy(r)`) / PROVEN
   (`JZ_DBG_PARAMVAL=1`).
4. narrow.js `mergeRule`'s `apply`/`missing`: logs every site's raw
   `(callee, k, callerFunc, arg, v)` for one target callee
   (`JZ_DBG_CALLEE=<funcName>`), gated `field==='val'` — the ground-truth
   per-site trace.

### Cause-class table (bench/watr/watr.js, 66 dispatch-site log lines → 31
### distinct (function, param, method) tuples; STRING family excluded below
### — see "already sound" note)

| cause class                                              | count | fixable this session? |
|-----------------------------------------------------------|-------|------------------------|
| body-reassigned param (STRING family's 3, + 2 ARRAY: `assemble`'s `nodes`, `normalize`'s `nodes`) | 5 | NO — correctly declined by design (§ below), not a proof gap |
| **dynamic/computed-dispatch-table forwarding** (`HANDLER[imm](…)` / `SIZE_HANDLER[k](…)` in watr's compile.js) | **~23 of the remaining ~26** | NO — diagnosed precisely, fix is a real feature (design sketched below), not attempted |
| unexplained / not individually re-traced (LENGTH-family entries in `checksumF64/U32/U8`, `str`) | ~3 | downstream symptom of the SAME cause (see cascade note) — not independent |

The STRING family (`cleanInt`'s `v`, `f64$parse`'s `input`, `uleb`'s `n` —
all `replaceAll`) is **already correctly handled**: all 3 are
`reassigned=true` (the function's own body writes the param after reading
it, e.g. `uleb`: `n = /[_x]/i.test(n) ? BigInt(n.replaceAll('_','')) :
i32.parse(n)`), and the JSDoc confirms genuine call-site polymorphism
(`@param {number|bigint|string|null} n`). Declining to seed a hardcoded
entry-time `val` here is correct — not a proof gap to close.

### Root cause: `HANDLER[imm](nodes, ctx, op, out)` — computed member call,
### invisible to the call-site census

watr's `compile.js` encodes each WAT immediate through a closed dispatch
table: `const HANDLER = { reversed: (n,c)=>…, block: (n,c,op,out)=>…,
call_indirect: (n,c,op,out)=>…, memarg: (n,c,op,out)=>…, … }`, invoked ONLY
as `HANDLER[imm](nodes, ctx, op, out)` (`imm` a runtime string from a lookup
table). Several members forward their 4th param `out` into `uleb(x, out)` /
`memargEnc(x, y, z, out)`. Traced with instrumentation (3) below:

- `program-facts.js`'s call-site walker (`walkFacts`, ~line 300) ONLY
  registers a call site when `op === '()' && isFuncRef(args[0],
  ctx.funcs.names)` — i.e. the callee position must be a literal bare name.
  `HANDLER[imm](…)` is `['()', ['[]', 'HANDLER', 'imm'], …]` — `args[0]` is
  a computed-member node, `isFuncRef` is false, NO call site is ever
  recorded for ANY of `HANDLER`'s member functions.
- Consequence: `call_indirect`/`memarg`/`memarg_order`/`block`'s OWN `out`
  (and `n`) params get **zero observations ever** in `paramReps` — BOTTOM,
  not TOP, not "genuinely polymorphic."
- `uleb`'s `buffer` param (default `= []`) IS soundly proven ARRAY by the
  SOFT mid-fixpoint sweep (every direct/default-arg site agrees — traced
  via instrumentation (4), `JZ_DBG_CALLEE=__encode_js\$uleb`: dozens of
  `missing→v=array` sites, one direct `instr`'s `out` → `v=array`). But the
  handful of `HANDLER`-forwarded sites (`memargEnc`'s `out`, `wleb`'s
  `out`, two more) resolve to `v=null` (their own source parameter is
  BOTTOM, and `inferValAtSite` can't distinguish "forward-reference to a
  permanently-unobserved param" from "genuinely unclassifiable
  expression"). Under the SOFT rule (`mergeRule('val', …, soft=true)`,
  narrow.js fixpointRules) a null observation is correctly skipped (stays
  BOTTOM, doesn't disturb the ARRAY consensus) — but the **final "Settle val
  HARD" sweep** (narrow.js ~2697: `runCallsiteLattice([mergeRule('val', …,
  false, true)])`, `soft=false` by design — "a site left BOTTOM =
  genuinely untyped" per its own doc comment) re-visits the SAME sites and
  this time HARD-POISONS `r.val = null` (sticky) on the first null
  observation. This is the documented, intentional contract of that sweep
  (param-reps.js header: "`val` runs SOFT… A signature-mutating consumer…
  re-folds the sites HARD… a final hard sweep settles val") — NOT a bug in
  the sweep itself, and NOT the same mechanism the prior session's
  `trackKind`-ordering fix touched (that was about `possibleKinds`/
  `joinKinds`; this is `val`'s own `mergeParamFact` hard-poison path).
- Traced the ROOT of the chain: `instr(nodes, ctx)` (compile.js, the real
  caller reached via `assemble`) declares `let out = []` — a genuine
  literal — and calls `HANDLER[imm](nodes, ctx, op, out)`. The runtime
  value is monomorphically an array at EVERY invocation; the census simply
  cannot see through the one dynamic-dispatch hop to know that.
- Confirmed the SAME cause cascades into `assemble`'s own return kind (→
  `compile`'s → `checksumBytes`'s `buf` param in bench/watr/watr.js itself)
  and into the `argsf198_0`/`m0_compile$memarg`(standalone, different
  function from `HANDLER.memarg`) chain one hop further — i.e. this is one
  root cause with a fan-out of symptoms, not several independent ones.

### Is this the same class the task's brief anticipated?

Adjacent to, but distinct from, the four candidate classes listed in the
task brief (default-initialized params, literal/typed-ctor/slice-map/
String() call arguments, closure-forwarded params, exported-function host
boundary). It is closest in spirit to "forwarded from another unproven
param... external/escaped callee" but the callee here is neither external
nor exported — it's a same-module, fully closed dispatch table that the
census's callee-resolution (`isFuncRef` on a bare name only) was never
taught to look through.

### Why not fixed this session

Checked for an existing, narrower mechanism first (the responsible move
before building anything new) — found `src/compile/dyn-closure-tables.js`,
a mature three-phase proof (`scanDynClosureTableCandidates` /
`scanClosureTableLatticeCandidates` / `resolveDynFnTables`) for EXACTLY
this shape ("`table[idx](args)` where table is a closed dispatch table of
arrows"), already handling both a literal-array table (`devirtConstFnArrayCalls`)
and an imperatively-built one (subscript's `lookup[c] = fn` idiom). Two
reasons it does not already cover `HANDLER[imm](…)`:
1. It is scoped to ARRAY-shaped tables (`isEmptyArrayLit`/`isArrowArrayLit`
   both require `rhs[0] === '['`/`'[]'`), numeric-indexed. `HANDLER` is a
   plain OBJECT literal (`{}`), string-keyed. Extending the scan family to
   object literals is plausible (the same closedness/no-alias/no-escape
   proof applies structurally) but untested territory for this file.
2. More fundamentally, this mechanism feeds a DIFFERENT lattice —
   emit.js's own closure-call param-type table (`tryDirectClosureCall`'s
   paramTypes/paramTypedCtors, for CLOSURE devirtualization + call codegen)
   — NOT `program-facts.js`'s `callSites`/`sitesByCallee`, which is what
   `paramReps`/`narrowSignatures`'s `val` census (the mechanism actually
   poisoning `uleb.buffer`) reads. Even a full object-literal extension of
   dyn-closure-tables.js would not, by itself, fix this bug — the missing
   piece is specifically teaching `program-facts.js`'s `walkFacts` (`op ===
   '()'`, ~line 300) to recognize a computed-member callee against a
   proven-closed table and register ONE SYNTHETIC CALL SITE PER TABLE
   MEMBER (same `argList`), which is new machinery, not a call into the
   existing one.

Building that soundly — proving `HANDLER` is closed/non-escaping/never
aliased (the same rigor call-target-index.js's `safeReceiver` already
applies for the literal-property-name case, generalized to "every own
property, not just one"), synthesizing N call sites from 1 AST node without
breaking any consumer that assumes a 1:1 node↔callee relationship
(`variant.js`'s `retarget` mutates `site.node[1]`/`site.callee` in place —
a synthetic site sharing one `node` across N callees needs its own
retarget-safety argument), and verifying against the FULL battery
(kernel-parity/kernel-oracle/self-compile, per this exact codebase's own
established practice for changes this close to `paramReps`/callSites) is a
real feature addition, not a bounded bug fix — assessed as irresponsible to
rush in a single time-boxed, short-round session, especially one resuming
after a watchdog restart. Flagging precisely for a dedicated follow-up
session rather than landing a partial/unverified version.

### What was explicitly NOT done (this session)

- No source fix landed. No pins added (nothing to pin — reverting the
  instrumentation left the worktree byte-identical to c2cab870).
- Did not attempt the object-literal extension to dyn-closure-tables.js's
  scan family, nor the new callSites-synthesis machinery in
  program-facts.js sketched above — see reasoning.
- Did not separately re-verify the `checksumF64`/`checksumU32`/`checksumU8`/
  `str` LENGTH-family entries beyond confirming they cascade from the same
  compile.js-internal HANDLER-dispatch poisoning (via `assemble`'s/
  `compile`'s own unprovable return kind) — treated as the same cause
  class, not re-traced site-by-site.
- Did not repeat this instrumentation pass against the real
  `/Users/div/projects/watr/watr.js` CLI target (`-O3`, 597581 B) — high
  confidence (same `compile.js`, same `HANDLER` table) it is the dominant
  contributor there too, plus whatever print.js/template.js add, but not
  independently confirmed this session.
- Sizes/battery are UNCHANGED from the 594879e1-follow-up checkpoint above
  (this session made no source edits): `bench-size.mjs watr` = 300640 B
  (budget 298000, still failing), watr.js -O3 = 597581 B (target 586426 B),
  kernel = 17,954,279 B (main 17,941,790 B). Battery not re-run this
  session (no source changed since it was last confirmed green).

## Third follow-up session: corrected the mechanism — HANDLER's members are
## INLINE ARROWS, not nameable functions; resolveComputed alone is not enough

Branch tip still 77cf6f69 (worktree scratchpad/sm) — no source changes this
round either; empirical verification only (temporary instrumentation in
plan/index.js, reverted via `git show HEAD:src/compile/plan/index.js >
src/compile/plan/index.js` — confirmed byte-identical to HEAD afterward).

### The assumption the task brief's item (1)/(2) rests on does NOT hold

The brief frames the fix as: `resolveComputed(objName) → [funcEntry...]`,
then "synthesize one call site per member function" — treating each HANDLER
property as if it already had a `ctx.funcs.list`-shaped identity, exactly
like `resolveMember`'s existing `ns.parse = parseNum` case (test/data.js
"shape #8" pin), where the property's VALUE is a bare-name reference to an
**already-declared top-level function**.

Verified against real watr (`/Users/div/projects/watr/src/compile.js:971`,
`const HANDLER = { reversed: (n,c) => {...}, block: (n,c,op,out) => {...},
... }`) that this is **not that shape**: every one of HANDLER's ~30
properties is an **inline arrow literal**, not a reference to a declared
function. Built a minimal repro (`repro/handler-table.mjs`, scratch, not
committed) with the same shape and instrumented `plan/index.js` right after
`programFacts = facts()` (line 211) to dump `ctx.funcs.names` and
`buildCallTargetIndex(...).resolveMember('HANDLER','block')`:
```
ALL funcs.names: [ 'instr', 'useIt' ]
resolveMember(HANDLER,block): null
```
`ctx.funcs.list`/`.names`/`.map` (populated by prepare.js, fixed before
plan() ever runs) contains only genuinely top-level `function`/`const-arrow`
DECLARATIONS — an arrow embedded as an object-literal property value is
never registered there. There is no "prepare-lifted function properties"
mechanism for this shape (that phrase in the task brief does not correspond
to anything in the current code — `call-target-index.js`'s own header
comment doesn't use it either; likely a mischaracterization by whoever
drafted the brief, possibly conflating it with the `ns.parse = parseNum`
bare-name-reference case, which needs no lifting because the referenced
function already exists). Confirmed also that `foldWrite`
(call-target-index.js) already POISONS any object-literal property whose
value isn't `isFuncRef` — i.e. it already looks at HANDLER's inline arrows
and gives up on every one of them today, for `resolveMember` too, not just
for the missing `resolveComputed`.

Consequence: a `resolveComputed` built naively on top of the EXISTING
`collectMemberWrites`/`foldWrite` table (my original plan, before this
verification) would see zero non-poisoned properties for `HANDLER` and
return `null` unconditionally — a correct-but-inert no-op against the actual
target program. This would pass every pin I could write against a
`ns.parse`-shaped table but do nothing for watr's bench-size numbers, i.e.
exactly the kind of "looking-done" gap CLAUDE.md warns against — flagging
before building the wrong thing further.

### Re-derived the actual poison mechanism with this correction in hand

Re-read the "Root cause" section above (`uleb`'s `buffer`,
`memargEnc`'s `out`, `wleb`'s `out` all resolve `v=null` at their
"HANDLER-forwarded" call sites) against the real call graph
(`/Users/div/projects/watr/src/{compile,encode}.js`):

```
const instr = (nodes, ctx) => {
  let out = [], meta = []
  ...
  const b = HANDLER[imm](nodes, ctx, op, out)   // instr's own out: a real `let out = []` literal
  ...
}
const HANDLER = {
  memarg: (n, c, op, out) => memargEnc(n, op, <computed>, out),   // inline arrow; out is ITS OWN 4th param
  labelidx: (n, c, op, out) => wleb(blockid(n.shift(), c.block), out),
  ...
}
```

`memargEnc`/`wleb`/`uleb` ARE real top-level `const`-declared functions
(confirmed: `grep '^const memargEnc\|^export const uleb'` in watr src) —
they DO have real `paramReps` entries, and `narrowSignatures` DOES already
try to narrow them. Traced why their `out`/`buffer` params still see a null
observation, precisely:

- `HANDLER[imm](nodes, ctx, op, out)` (the OUTER computed call, inside
  `instr`) is indeed invisible to `walkFacts`'s `op==='()' &&
  isFuncRef(args[0],...)` gate, exactly as the root-cause section says.
- But `memargEnc(n, op, ..., out)` (the INNER call, inside `HANDLER.memarg`'s
  OWN arrow body) is a call to a literal bare name — `isFuncRef` succeeds —
  so `walkFacts` DOES register a call site for it today, already, with no
  fix needed to see the call itself. Confirmed by hand-tracing `walkFacts`'s
  `'let'/'const'` branch → generic fallback → `'=>'` branch: `HANDLER`'s
  decl is TRUE module-top-level, so walking into its property values reaches
  `HANDLER.memarg`'s arrow body with `caller` still `null` (module scope,
  never reassigned across the `=>` boundary) — the walker already descends
  into inline arrow bodies and finds calls made from inside them.
- The actual gap: at THIS site, the argument is the bare name `out` —
  `memarg`'s OWN 4th parameter, not a module global and not a param of any
  named function. `inferValAtSite('out', state)` (narrow.js ~1953) tries (in
  order) `inferValType` against `state.callerValTypes` (= module globals,
  since `state.callerFunc === null` here) → miss; the array-element/typed
  branches (arg isn't `[]`-shaped) → skip; `state.callerParamFacts('val')`
  → `paramFactsOf(paramReps, null, 'val')` → `null` immediately
  (`paramFactsOf`'s own `if (!callerFunc) return null`, param-reps.js:32) —
  there is no "caller" to have param facts, because the true caller
  (`memarg`, the arrow) has no identity in this system at all; `def =
  state.callerFunc?.defaults?.[arg]` → `null?.defaults` → undefined. Returns
  `null`. This is the site the notes above call "HANDLER-forwarded";
  confirmed it's null for exactly this structural reason, not because the
  call site is missing.

So the fix target is real (uleb/memargEnc/wleb's `paramReps` entries), and
the walker already sees the INNER call — what's missing is a way to resolve
`out` at that inner site to what it actually, always is: `instr`'s own
`out`. That requires reaching back through TWO hops (inner call ← arrow's
own param ← outer dispatch call's argument), not one.

### Revised design (not yet implemented — next round)

Two sub-mechanisms, both still living in call-target-index.js +
program-facts.js ("one authority", per the brief) but shaped by the above:

(A) **`resolveComputed` returns member ARROWS, not just named funcEntries.**
    `foldWrite`'s poison-on-non-funcRef is right for `resolveMember` (whose
    contract is "the resolved function's `ctx.funcs.list` entry" — must stay
    exactly as strict, nothing here should change `resolveMember`'s own
    behavior or its existing pins) but too strict for the new call. Track a
    second table (or a tagged value: `{kind:'named', fn}` vs
    `{kind:'arrow', node}`) so a same-module inline arrow property is a
    legitimate "known member" too, under the identical closedness rules
    (`safeReceiver` — shadowed/rebound/escapes/dynWriteVars — unchanged).
    `resolveComputed(objName)` succeeds only when EVERY property folds to
    one or the other (no POISON at all) — "all members known" stays literal.

(B) **program-facts.js's walker, when it resolves a computed dispatch call
    to a set of arrow members, does NOT try to give the arrows themselves a
    call site** (there is nowhere in the paramReps/narrow.js model to put
    one — that whole machinery is funcName-keyed). Instead, for each
    resolved arrow member and each real, outer call site of
    `TABLE[key](args)`: walk the arrow's OWN body only (stop at any nested
    `=>`, same discipline as every other closure-scoped walk in this
    codebase — collectDispatchTableClosures/collectMemberWrites/
    collectNestedBoundNames all already draw this exact line), find every
    call to a literal bare-name (real, named) function, and synthesize ONE
    call site per (outer call site × arrow member × inner call): `{callee:
    innerCalleeName, argList: <arrow's own body argList, with any bare-name
    arg that is literally one of the arrow's OWN param names substituted by
    the OUTER site's corresponding argument expression — plain positional
    substitution, one hop, no recursion>, callerFunc: outerSite.callerFunc,
    node: innerCallNode}`. This is what actually gets `memargEnc`'s/`wleb`'s
    `out` to resolve: at the synthesized site, the argument is no longer the
    bare name `out` (unresolvable, no caller) but `instr`'s own `out`
    expression (a literal `[]`), evaluated with `callerFunc = instr` (a
    REAL function whose `callerParamFacts`/defaults do resolve it).

    A member whose value IS already a plain named-function reference (the
    `ns.parse` shape, `kind:'named'` from (A)) needs no substitution —
    synthesize directly with the outer site's own `argList`, matching the
    task brief's original, simpler description for that sub-case.

Explicitly NOT part of (A)/(B): a member arrow's OWN direct (non-forwarded)
use of its own param — e.g. HANDLER's `block: (n,c,op,out) => { ...; if
(out) { for (...) out.push(b[i]); return } ...}`, where `out.push` happens
INSIDE the arrow, no named-function forwarding at all. That path never
reaches paramReps/narrow.js regardless of (A)/(B) — the codegen for a
closure body's OWN param reads is governed by a wholly separate mechanism
(emit.js's closure-call param lattice; for TABLE-dispatched closures
specifically, `dyn-closure-tables.js`'s `scanClosureTableLatticeCandidates`,
currently scoped to array-literal tables only). The task brief's own item
(3) asks to "consider whether dyn-closure-tables.js should now be fed from
the index too" — tentatively: NOT a clean feed-from-the-index replacement
(different question — "one funcIdx always" vs "one of N known members" —
and a different consumer, emit-time per-closure paramTypes vs plan-time
paramReps), but extending ITS OWN candidate scan
(`scanClosureTableLatticeCandidates`/`everyUseIsIndexedCall`) from array
literals to object literals looks like the right, structurally-analogous
move for THIS residual (member's own direct param usage) — separate work
from (A)/(B) above, only worth attempting after (A)/(B) are landed and
measured, to see how much of the ~23-count class each half actually closes.

### What was explicitly NOT done (this session)

- No source fix landed (reverted the one temporary debug edit). This session
  was spent correcting a wrong assumption before building on it — see
  CLAUDE.md's "optimize the tool, never the input" / "don't leave half-done"
  read together with "beware optimizing a proxy... name the substitution":
  the proxy here would have been "ship a resolveComputed that type-checks
  and has green pins" while the real goal (move the watr byte count) stayed
  unmet, because the pins I'd have reached for naturally (a `ns.parse`-
  shaped closed table) don't exercise the inline-arrow shape that's actually
  in watr.
- Did not implement (A)/(B) above — next round.
- Sizes/battery unchanged from the 594879e1 checkpoint (no source edits this
  session): `bench-size.mjs watr` = 300640 B (budget 298000), watr.js -O3 =
  597581 B (target 586426 B), kernel = 17,954,279 B (main 17,941,790 B).

## Fourth session: landed (A)/(B) above, plus two shared-primitive precision
## fixes the real watr shape needed that neither prior session anticipated

Branch tip: 6c099324 (from 77cf6f69 at session start). Four commits, in
order: `0b9166c6` (resolveComputed + synthesis + retarget/setCallArgs
guards), `8a56815f` (drop the pre-existing raw/poisoning twin of a
synthesized inner call), `fa801c07` (nameEscapes precision — see below),
`6c099324` (three pins).

### What actually shipped

1. **`src/compile/call-target-index.js`**: `foldWrite` now resolves EITHER
   shape a table property's value can be — a same-module named-function
   reference (`resolveMember`'s existing, unchanged contract) OR an inline
   arrow literal (the `['=>', params, body]` node itself — watr's real
   `HANDLER` shape; see "Third follow-up session" above for why this was
   necessary before anything else could work). New `resolveComputed(objName)`
   reuses `resolveMember`'s exact `safeReceiver` eligibility
   (shadowed/rebound/escapes/dynWriteVars) and returns the full, closed
   member set (mixed funcInfo/arrow-node array) or `null` on ANY
   unresolved/poisoned property — never partial, matching the file's
   existing all-or-nothing discipline.
2. **`src/compile/program-facts.js`**:
   - The call-site walker now also stashes `TABLE[key](args)` candidates
     (`programFacts.computedCallSites`) during the SAME walk that builds
     `callSites` — cheap, no resolution attempted yet (the index doesn't
     exist during this walk).
   - New `synthesizeComputedDispatchCallSites(programFacts)`, called from
     plan/index.js right after `buildCallTargetIndex`: resolves each
     candidate via `resolveComputed`. A named-function member synthesizes
     directly (outer site's own `argList`, unchanged — a real paramReps
     identity to feed). An arrow member has NO paramReps identity of its
     own (prepare.js never lifts an object-literal property's arrow into a
     `ctx.funcs.list` entry — confirmed empirically, see "Third follow-up
     session"), so this walks the arrow's OWN direct body (never
     descending into a nested `=>`) for calls to real named functions,
     SUBSTITUTES the arrow's formal params with the outer call's actual
     argument expressions wherever they occur (a pure, referentially-
     transparent AST rewrite — sound regardless of side effects, since
     nothing is evaluated), and synthesizes one call site per such inner
     call — but ONLY when every argument, post-substitution, is free of
     every name the arrow itself binds (checked via `collectAllBoundNames`,
     the same shadow-bail primitive call-target-index.js already uses).
     Failing that for one argument declines the WHOLE inner call rather
     than guess.
   - Critical correctness fix found via a targeted repro + temporary
     `narrow.js` tracing (reverted, not in the diff): the ORDINARY call-site
     walker had ALREADY been descending into HANDLER's inline arrow bodies
     all along (nothing to do with this session's new code) and registering
     any named-function call it found there with `callerFunc: null` and the
     arrow's own UNSUBSTITUTED param names as args — permanently
     unresolvable (no caller to resolve an arrow-local name against), and
     WORSE than simply absent: narrow.js's final hard-settle sweep poisons
     on the first null it sees, so this raw, always-null twin was
     UNDOING the correctly-substituted synthetic observation for the exact
     same call, every time. `synthesizeComputedDispatchCallSites` now
     tracks every inner-call node it visits and drops that node's raw
     (non-synthetic) twin from `programFacts.callSites` after synthesis —
     the single change that took the isolated repro from a silent no-op to
     a real, measured WAT-shape change (uleb's forwarded `buffer` param:
     `__dyn_get_expr` probe present → absent, O0 WAT 315730→246129 chars).
3. **`src/compile/variant.js` / `src/compile/plan/inline.js`**: every
   synthesized site is tagged `synthetic: true`. The two places anywhere in
   the compiler that WRITE through a call site's own `.node`
   (`materializeVariant`'s retarget — `site.node[1] = cloneName` — and
   `specializeFixedRestCalls`'s `setCallArgs`) now skip `synthetic` sites:
   a synthesized site may share its node with a sibling synthesized site
   (an inner call reached from more than one outer table caller) or, for a
   named-function member, with the OUTER computed-dispatch call itself
   (whose `node[1]` is a COMPUTED member expression, not a plain callee
   string — retargeting it would silently collapse a genuine runtime
   dispatch into one hardcoded target). These sites exist only to feed the
   read-only census; nothing may ever rewrite through them.
4. **`src/compile/program-facts.js`'s `ESCAPE_SKIP`/`nameEscapes`
   population** (commit `fa801c07`) — the fix that actually unblocked the
   REAL watr.js, found only after (1)-(3) above worked perfectly on an
   isolated repro but moved the real program's size by ZERO bytes. Traced
   (targeted tracing again, reverted) to `programFacts.nameEscapes.has(
   'HANDLER')` being `true` on the real program even though `HANDLER`
   itself is only ever read through a `[]`-receiver position (already
   exempt) — root cause: watr's `SIZE_HANDLER` builder,
   `for (const k in HANDLER) SIZE_HANDLER[k] = (n,c,op) => HANDLER[k](n,c,op).length`
   — jz's OWN `prepare/index.js` unconditionally LOWERS every non-strict
   `for...in` into a null-guarded call to an intrinsic BEFORE program-facts.js
   ever walks it: `['?', ['==', src, [null,null]], ['[]', null],
   ['()', '__keys_ro', src]]`. Two DIFFERENT positions in that lowered
   shape read `HANDLER` as a bare name outside any previously-exempt slot:
   the null-guard comparison (`HANDLER == null`) and `__keys_ro`'s own call
   argument. Neither actually aliases/exposes the reference (a nullish
   comparison and a read-only key-enumeration call both only ever "query,
   not expose" — the exact same shape `ESCAPE_SKIP`'s existing `'in': new
   Set([1])` entry already documents for the binary `in` operator's RHS).
   Added two narrow, generally-justified exemptions to the SAME generic
   escape-marking loop (not a new mechanism): `__keys_ro`'s sole call
   argument, and a bare-name operand of `==`/`===`/`!=`/`!==` against a
   statically-nullish literal (reused the already-imported `nullishArm`
   from kind.js rather than reinventing nullish-literal detection). NOTE:
   a per-op `ESCAPE_SKIP['for-in']` entry was tried FIRST and found to be
   dead code — `strict` mode ERRORS on `for...in` before this walk ever
   runs, and non-strict mode has ALWAYS already lowered it away by the time
   program-facts.js sees it, so the `'for-in'` op itself never reaches this
   code — reverted before committing (confirmed via `git diff` showing zero
   residual change to that entry).

### Why this needed care: `nameEscapes` is a shared, whole-program primitive

`ctx.types.nameEscapes` also gates `kind.js`'s dict-value/map-value census
(dictValueKindSet/mapValueKindSet, "the census keys observations by
SYNTACTIC receiver name... nameEscapes is... the set of names that COULD
have been aliased"). Checked before touching it: neither exemption can
ever be wrong for THAT consumer's own contract either — a `for-in`-lowered
null-guard comparison and a read-only key-enumeration call are exactly as
incapable of producing an ALIAS (a new binding to the same reference,
through which a later write would be invisible to a name-keyed census) as
they are of invalidating call-target-index.js's closedness proof. Confirmed
via the full battery (below) that widening this shared, over-conservative
primitive regressed nothing.

### Product-proof measurements — before (77cf6f69) vs after (this session)

- `node cli.js /Users/div/projects/watr/watr.js -O3`: **597581 B → 595859 B**
  (-1722 B). Target 586426 B — still not met; ~9433 B of gap remains.
  `$m1_encode$uleb`'s own body still carries ONE `__dyn_get_expr` probe
  (down from more before — not independently counted pre-fix), while
  `$m0_compile$memargEnc` and `$m0_compile$wleb` — the exact two functions
  the root-cause diagnosis named — now carry ZERO: fully specialized,
  direct array codegen, no shadow probe, confirmed via direct WAT
  extraction (`node cli.js ... -o out.wat`, `grep`/slice on the function
  body). uleb's residual probe is very likely for its OWN, PRE-EXISTING,
  correctly-conservative `n` parameter (JSDoc'd
  `@param {number|bigint|string|null} n`, genuinely call-site-polymorphic,
  reassigned in its own body — see the cause-class table's own "already
  correctly handled" STRING-family note above), not `buffer` — not
  independently re-confirmed this session (time-boxed).
- `node scripts/bench-size.mjs --json` (the SAME invocation
  test/bench.js's own SIZE_BUDGET gate uses — confirmed by reading
  test/bench.js itself, `execFileSync('node', [SIZE_SCRIPT, '--json'])`;
  a bare `node scripts/bench-size.mjs watr` single-case invocation gives a
  DIFFERENT, NOT-authoritative number for this exact case — 292.6 kB vs
  299635 B in `--json` mode, same tree, same instant — almost certainly
  some cross-case state (schema/id counters or a cache) not fully reset
  between compiles in the SAME process when many cases run back-to-back;
  not chased further, but flag this discrepancy for whoever next touches
  bench-size.mjs, and always use `--json` when comparing against
  SIZE_BUDGET): `bench/watr/watr.js` (the curated, SEPARATE harness — see
  the second-session note on why it differs in absolute scale from the
  real CLI numbers above) went **300640 B → 299635 B** (-1005 B). SIZE_BUDGET.watr
  = 298000 — still fails, by 1635 B (down from 2640 B before this session).
- Kernel (`npm run build` → `dist/jz.wasm`): **17,954,279 B → 17,971,075 B**
  (+16,796 B) — grew, expected: this branch's new machinery
  (`resolveComputed`, `synthesizeComputedDispatchCallSites`, the
  substitute/mentionsAny helpers, the two nameEscapes exemptions) is itself
  new compiler source that gets compiled INTO the self-hosted kernel,
  regardless of what it does for OTHER programs — the same shape the
  possibleKinds-ordering fix's own kernel delta showed two sessions ago.
  Now 29,285 B larger than main (17,941,790 B); was 12,489 B larger at the
  session-start checkpoint.

### Battery — full, all green

- `node test/index.js`: **3743 total / 3742 pass / 1 skip / 0 fail** (21742
  assertions) — +2 over the 3741 checkpoint (this session's own 3 new
  test() groups in test/data.js; the +2-vs-+3 arithmetic wasn't
  reconciled exactly, but 0 fail / exit 0 is what was actually checked).
- `npm run build`: succeeds (`dist/jz.wasm` = 17,971,075 B, above). `JZ_TEST_TARGET=jz.wasm
  node test/index.js`: **2994 total / 2993 pass / 1 skip / 0 fail** (14363
  assertions).
- `node test/kernel-parity.js`: **3/3 tests, 33/33 assertions, 0 fail** — THE
  gate (this session's changes are exactly the call-site-facts class this
  gate exists to catch).
- `node test/kernel-oracle.js`: **14/14 tests, 605/605 assertions, 0 fail**.
- `node scripts/bench-size.mjs --json`: 23/24 budgeted cases pass; `watr`
  still fails (299635 vs 298000, see above) — the only budget miss, same
  as every prior checkpoint on this branch.

### What was explicitly NOT done this session

- Did not close the remaining ~9433 B (-O3) / 1635 B (size-preset budget)
  gap. Diagnosed enough to say with reasonable confidence it is NOT the
  same mechanism this session fixed (memargEnc/wleb are clean; uleb's one
  residual probe looks like its own pre-existing, correctly-declined `n`
  polymorphism, not `buffer`) — the SYNTH/DECLINE counts traced this
  session (temporary, reverted instrumentation) showed real decline
  volume for `id`/`isIdx`/`reftype`/`blockid` and a genuine partial
  (24 synth / 36 decline) split for `uleb` itself, meaning EITHER (a)
  some of HANDLER's members forward to these helpers with argument shapes
  this session's substitution correctly declines (a complex expression
  mentioning an arrow-local name, not a bare param — see design doc in
  synthesizeComputedDispatchCallSites), and/or (b) the members' OWN DIRECT
  param usage (dyn-closure-tables.js's territory, e.g. `block`'s
  `out.push(...)` with no named-function forwarding at all) is a separate,
  untouched contributor. Did not separately re-verify which.
- Did not extend `dyn-closure-tables.js`'s `scanClosureTableLatticeCandidates`
  family to object literals (the task brief's own "consider... do it if
  clean, otherwise leave it and note why" item) — assessed as NOT a clean
  index-feed replacement (see "Third follow-up session"'s design doc,
  still accurate): different question (funcIdx identity vs a resolvable
  member SET), different consumer (emit-time closure paramTypes vs
  plan-time paramReps), different candidate shape (array-literal tables,
  often imperatively built, vs this session's object-literal
  `resolveComputed`). Extending its OWN scan family to object literals,
  independently, to close the "member's own direct param usage" residual
  above, is flagged as the most promising next-round target — not
  attempted this session (time-boxed after the two shared-primitive
  investigations above).
- Did not investigate the bench-size.mjs single-case-vs-`--json` size
  discrepancy (292.6 kB vs 299635 B for the identical `watr` case, same
  tree) — flagged above for visibility; used `--json` throughout for
  every reported number since that's what the real gate runs.

## Fifth session: class (A) ceiling measured small; class (B)'s real bug found
## (all-or-nothing decline throws away resolvable sibling args) — fix designed,
## NOT YET IMPLEMENTED when a watchdog restart interrupted this round

Branch tip at session start: 39c8ecff (unchanged from session 4's end). Baseline
reconfirmed byte-identical to the task brief: `bench-size.mjs --json` watr =
299635 B (budget 298000), `cli.js .../watr.js -O3` = 595859 B (target 586426).

### Class (A) — HANDLER members' own DIRECT param usage — ceiling is SMALL, and
### the existing closure-table param lattice can't express ARRAY at all yet

Traced the full mechanism the task brief pointed at:
- `module/array.js` (~line 913-920): a module-scope const array-of-arrows
  literal, when every element folds to a static closure, tags
  `ptr.fnElements = vals.map(v => ({idx: v.closureFuncIdx, name:
  v.closureBodyName}))`. `module/object.js`'s parallel `ctx.core.emit['{}']`
  handler (its own static-data-segment branch, ~line 210-241, structurally
  identical gate: module-scope const, `neverWritten`, `!shadow`, every value
  foldable) has **no equivalent tagging today** — confirmed by an exhaustive
  repo-wide grep for `fnElements`: the only producer is array.js, the only
  consumers are emit.js's two `val.fnElements` reads (gated on
  `ctx.scope.closureTableLatticeCandidates`) — object literals never reach
  either.
- `dyn-closure-tables.js`'s `scanClosureTableLatticeCandidates` (the const-
  array-of-arrows scan) and `scanImperativeClosureTableLatticeCandidates`
  (the empty-array-then-`table[k]=fn` scan) are BOTH gated on
  `isArrowArrayLit`/`isEmptyArrayLit` — an object literal (`{}`) fails both
  shape checks trivially (checks `rhs[0] === '['`). `everyUseIsIndexedCall`/
  `everyUseIsIndexedCallOrLiteralWrite` themselves are receiver-shape-generic
  (`['[]', name, idx]` AST shape — true for both `arr[i]` and `obj[key]`), so
  ONLY the two initial-declaration-shape checks would need widening to admit
  `{}` — structurally cheap, confirming the task brief's premise that this
  part is a small change.
- **BUT**: traced `emitGenericClosureCall`'s `recordClosureTableCallSite` →
  `resolveClosureTableParamLattice` → `seedClosureFrame`'s consumption
  (compile/index.js ~1941-1953) all the way through, and the lattice ONLY
  ever sets `val: VAL.NUMBER` (from `ptRow[i]===true`, itself only ever set
  by `recordClosureTableCallSite`'s `valTypeOf(arg) === VAL.NUMBER` check) or
  `val: VAL.TYPED` (from `tcRow`, gated on `valTypeOf(arg) === VAL.TYPED`).
  **Nothing in this lattice can ever express plain VAL.ARRAY** — it was
  purpose-built for the dispatch-bench's loop-carried-numeric shape (the
  module doc says so explicitly: "letting arg evidence at the NEXT
  iteration's call site prove numeric too"), not as a general per-position
  kind census. So even a full, correct object-literal extension of
  dyn-closure-tables.js's scan family would NOT, by itself, prove `out` is
  ARRAY inside `HANDLER.block`'s own body — `recordClosureTableCallSite`
  would need a THIRD row (e.g. `arrRow`, mirroring `numRow`/`tcRow`, checking
  `valTypeOf(arg) === VAL.ARRAY`) AND `seedClosureFrame` would need a new
  `if (arrRow[i]) updateRep(cb.params[i], { val: VAL.ARRAY })` branch. This
  is a real, well-scoped extension, not a blocker — but it's MORE than "just
  feed object literals into the existing mechanism," so its cost was
  under-estimated in the brief.
- Read watr's actual `HANDLER` (`/Users/div/projects/watr/src/compile.js`
  971-1122, ~44 properties) line by line for every member's OWN use of its
  4th param `out`. Only **two** members ever touch `out` directly (not via
  forwarding to a named function): `block` (`for (...) out.push(b[i])`) and
  `memarg_order` (`out.push(ord)`, alongside three OTHER positions in the
  same body that DO forward to `uleb`, i.e. it's a mixed case). Every other
  `out`-taking member (`call_indirect`, `memarg`, `opt_memory`, `labelidx`,
  `laneidx`(no — laneidx also direct-pushes, see correction below)... — full
  re-check: `laneidx: (n,c,op,out) => { const v = parseUint(n.shift(),0xff);
  if (out) { out.push(v); return } return [v] }` is ALSO a direct `out.push`
  — three members, not two: `block`, `memarg_order`, `laneidx`. The rest
  (`funcidx`, `typeidx`, `tableidx`, `memoryidx`, `globalidx`, `localidx`,
  `dataidx`, `elemidx`, `tagidx`, `'memoryidx?'`, `stringidx`, `i32`, `i64`,
  `f64`, `opt_memory`) purely forward `out` to one named-function call
  (`wleb`/`encode.i32`/`encode.i64`/`encode.f64`) — class (B) territory, not
  (A). **Class (A)'s real ceiling in this program is 3 closure bodies' worth
  of codegen (`block`, `memarg_order`, `laneidx`), not the ~20+ members that
  forward — class (B) is the dominant remaining class.** Given class (A)
  additionally needs the lattice's own ARRAY-row extension (above) before it
  buys anything, and its ceiling is small, it is NOT the next move — see
  class (B) below, which is bigger AND the fix is already fully designed.

### Class (B) — helper-forwarding declines — instrumented on REAL watr.js, and
### the actual bug is different from what session 4 guessed

Added temporary env-gated instrumentation (`JZ_DBG_SYNTH2=1`) inside
`synthesizeComputedDispatchCallSites`'s `walkInner` (program-facts.js), right
at the existing `innerArgList.every(a => !mentionsAny(a, bound))` gate —
logs `{ok, objName, arrowParams, inner: <callee>, raw: <pre-substitution
args>, subst: <param→outer-arg map>, out: <post-substitution args>, flagged:
<positions that still mentionAny>}` as one JSON line per inner-call
candidate. **Committed as WIP** (commit `57a9f774`,
`src/compile/program-facts.js` — 8 lines, env-var gated, zero behavior
change when unset) so it survives a restart; MUST be reverted before this
branch is considered done (matches every prior session's discipline for
temporary instrumentation — see e.g. session 3/4's `git show HEAD:path >
path` reverts).

Ran `JZ_DBG_SYNTH2=1 node cli.js /Users/div/projects/watr/watr.js -O3 -o
/tmp/watr-instr.wasm 2>/tmp/synth-log.txt`: **169 inner-call candidates, 105
SYNTH / 64 DECLINE**. Wrote a throwaway node script (not committed) to
classify the 64 declines:

- **32 are single-arg or every-position-flagged** — e.g. `HANDLER.reversed`'s
  `uleb(id(e, c.elem))` where `e = n.shift()` (a genuinely-mutating,
  unprovable destructure of the receiver array — correctly declined, no
  evaluation-free substitution can resolve it) — and this decline is
  provably HARMLESS: `uleb`'s only touched param here is `n` (deliberately
  polymorphic/reassigned per the existing "already correctly handled STRING
  family" note above), and `buffer` isn't even passed at this call (uses its
  own `= []` default, which is ALREADY separately proven via the unrelated
  `missing()`-arg default-substitution path in narrow.js's mergeRule,
  regardless of whether this specific site synthesizes). Same story for the
  other 31 in this bucket (each traced back to a body-local from `n.shift()`
  / destructuring feeding the ONE param position this call touches, with the
  param(s) we actually care about either absent from the call or the
  arg the decline poisons is not one the census needs).
- **32 are multi-arg calls with ≥1 CLEANLY-substituted position AND ≥1
  FLAGGED position — the real, fixable bug.** Breakdown by (callee,
  clean-position, flagged-position):
  - `id(nm, list)` — 17×, position 0 (`nm`) flagged (a body-local like
    `idx`/`t`/`e` from `n.shift()`/destructuring), position 1 (`list`, e.g.
    `c.type`/`c.table`/`c.elem`/`c.memory`) CLEAN. `id`'s `list` param is
    read via `list[nm]` / `list.length` / `n in list` — proving its kind
    would let `id` skip generic dynamic dispatch, a real win never
    attempted before this trace.
  - `blockid(nm, block)` — 5×, same shape, position 1 (`c.block`) clean.
  - `uleb(n, buffer)` — 5×, position 1 (`buffer`, the forwarded `out`) CLEAN
    — this is the ORIGINAL target parameter session 4 was chasing. Matches
    session 4's own closing note: "`$m1_encode$uleb`'s own body still
    carries ONE `__dyn_get_expr` probe."
  - `reftype(t, ctx)` — 2×, position 1 (`ctx`, i.e. `c`) clean.
  - `memargEnc(nodes, op, memIdx, out)` called with only 3 args (from
    `memlane`'s `memargEnc(n, op, memIdx)`, no `out` at this call) — 1×,
    positions 0,1 (`nodes`,`op`) clean, position 2 (`memIdx`, a body-local
    ternary result) flagged.
  - `wleb(v, out)` — 1×, position 1 (`out`) clean, position 0 flagged. Traced
    to `HANDLER.stringidx`: `let s = n.shift(), key = s.valueOf(), idx =
    c.strings.findIndex(...); if (idx < 0) idx = c.strings.push(s) - 1;
    return wleb(idx, out)` — `idx` is a genuinely runtime-computed
    body-local (correctly unprovable), `out` is the clean param.

**Root cause, precisely**: `synthesizeComputedDispatchCallSites`'s decline
rule is ALL-OR-NOTHING per call (`innerArgList.every(...)` — one bad
position poisons the whole site), but `narrow.js`'s consumer
(`applySiteRules`/`mergeRule.apply`, called once per PARAMETER POSITION `k`
independently) never needed that — a per-position `v == null` at one
position already can't corrupt a SIBLING position's own fold (confirmed by
re-reading `applySiteRules`, narrow.js ~1921-1937: the loop is `for (let k
= 0; k < func.sig.params.length; k++) { ... rule.apply(r, arg, k, state) }`,
one independent call per `k`). The synthesis-time all-or-nothing gate is
therefore STRICTLY MORE CONSERVATIVE than what the consumer actually needs —
it exists (session 4's own comment) to avoid a DIFFERENT hazard: leaving an
arrow-local name unsubstituted in a position narrow.js WILL try to resolve
against the wrong scope (`site.callerFunc`, not the arrow) risks a
same-spelled-different-binding misattribution.

**Key fact discovered that de-risks a per-position fix**: this codebase's
AST is ALREADY alpha-renamed program-wide before program-facts.js ever runs
— every binding gets a globally-unique suffixed name (confirmed directly in
the instrumentation dump: `n`→`nf113_0` / `nf114_0` / `nf117_0`... — a
DIFFERENT suffix per lexical declaration site, HANDLER's own `(n,c,op,out)`
params included). This means a *leftover, unsubstituted* arrow-local name
(e.g. `idxf143_6`, `HANDLER.stringidx`'s own `idx`) can **never** collide
with any other real binding anywhere in the program — `state.
callerValTypes.get('idxf143_6')` / `state.callerParamFacts('val')?.get(
'idxf143_6')` against the SYNTHESIZED site's `callerFunc` (e.g. `instr`)
will always cleanly miss (that name was never declared in `instr`'s scope)
and fall through `inferValAtSite` to `null` — a safe "unclassifiable"
observation for exactly that one position, nothing fabricated. **NOT YET
independently re-verified**: that this alpha-renaming is a true, DOCUMENTED,
whole-pipeline invariant (not an accident of this one program) — grep
`prepare/index.js` for the renaming pass and confirm it runs unconditionally
before `program-facts.js`'s walk, on every build, before relying on it. This
is the one load-bearing fact the fix below depends on; verify FIRST in the
next round before writing the fix.

### Fix designed, NOT YET IMPLEMENTED (interrupted by a watchdog restart)

Change `synthesizeComputedDispatchCallSites`'s inner-call synthesis from
whole-call all-or-nothing to a call that is ALWAYS synthesized once the
callee itself resolves (`isFuncRef` true), keeping each argument POSITION's
own substituted value even when a SIBLING position still mentions an
arrow-bound name — i.e. delete the `if (innerArgList.every(a =>
!mentionsAny(a, bound)))` gate around the whole `programFacts.callSites.push`
and push unconditionally, relying on (a) the alpha-renaming uniqueness fact
above to make a leftover arrow-local name a safe, collision-free "always
resolves to null" observation at its own position, and (b) narrow.js's
existing per-position independence (`applySiteRules`) to keep that null from
poisoning sibling positions. Needs, before landing:
1. Verify the alpha-renaming invariant (above) in prepare/index.js.
2. Re-derive whether `mentionsAny`/the `flagged` computation is even still
   needed for anything ELSE after this change (the instrumentation's `ok`
   field becomes vacuous if the gate is deleted outright — check no OTHER
   consumer of `synthesizeComputedDispatchCallSites`'s output implicitly
   relied on "a declined call means NO site was pushed" for some unrelated
   soundness reason, e.g. `claimedNodes` — re-read the "drop the raw twin"
   logic (session 4, commit `8a56815f`) to confirm it still applies
   correctly when EVERY inner call now always gets a synthetic twin: the
   raw/always-poisoning twin must still be dropped for every claimed node,
   regardless of whether the synthetic replacement is "fully clean" or
   "partially null" — re-read `claimedNodes.add(n)` (called BEFORE the old
   gate, so this is already unconditional today — should be unaffected, but
   confirm).
3. Revert the temporary `JZ_DBG_SYNTH2` instrumentation (commit 57a9f774)
   once the real fix's own pins are in place — or fold its measurement
   into a smaller, permanent-style debug hook ONLY if the codebase
   convention elsewhere keeps such hooks (check — session 2's cause-class
   instrumentation was fully reverted, not kept; match that).
4. Rebuild watr (`bench-size.mjs --json` AND the real CLI `-O3`), diff WAT
   for `$m1_encode$uleb`/`$m0_compile$id`/`$m0_compile$blockid`/
   `$m0_compile$reftype` to confirm the shadow probe actually drops (not
   just that a callSite got synthesized — the census downstream still needs
   `paramValTrustworthy`/the hard-settle sweep to actually accept it).
5. Full battery + kernel bytes vs main, per the task's mergeable gate.
6. Add pins: positive WAT-shape (the exact partial-forward repro: a helper
   whose ONE param is proven via a partially-declined multi-arg forwarding
   call, e.g. mirroring `id(idx, c.type)`/`out` shape) gets direct codegen;
   negative control (a GENUINELY polymorphic forwarded position stays
   runtime-dispatched); ordering-independence if plausible for this change
   (likely N/A — this isn't a fixpoint-ordering fix like session 2's, it's a
   one-shot synthesis pass, but check whether iterating `computedCallSites`
   in a different order could matter — should not, since each site's
   synthesis is independent, but confirm via the existing watr
   declaration-order pin idiom if a cheap repro exists).

### What was explicitly NOT done this session (interrupted)

- Did not verify the alpha-renaming invariant independently in
  prepare/index.js (item 1 above) — next action.
- Did not implement the fix (the `every(...)` gate deletion above).
- Did not re-run the battery or bench-size after any source change (none
  made yet beyond the temporary, committed-as-WIP instrumentation).
- Did not extend dyn-closure-tables.js / module/object.js for class (A) —
  deprioritized in favor of class (B) per the ceiling analysis above; may
  still be worth a follow-up round once (B) is landed and measured, to see
  what's left.
- Sizes/battery UNCHANGED from session 4's checkpoint: `bench-size.mjs
  --json` watr = 299635 B (budget 298000), `cli.js .../watr.js -O3` =
  595859 B (target 586426 B), kernel = 17,971,075 B (main 17,941,790 B).

## Sixth session: landed the class (B) per-position synthesis fix designed
## above — SOUND, verified with real WAT-shape pins, but NET ZERO bytes on
## watr specifically (a second, deeper, out-of-scope limitation blocks the
## payoff) — three watchdog restarts this round, checkpointed each time

Branch tip: (see `git log` in this worktree — commits from `57a9f774`
through `d23ed495`, several labeled WIP mid-round per the restart protocol,
final state is what this entry describes). Three watchdog restarts hit
during this session (each after ~16-17 min with a running build/trace and
no transcript activity) — each was handled per protocol: commit whatever's
uncommitted by exact path, write findings, resume in shorter rounds. All
work is landed; nothing was lost across a restart.

### What shipped: `src/compile/program-facts.js`,
### `synthesizeComputedDispatchCallSites` only

Implemented the design from the previous ("Fifth session") entry above,
corrected TWICE after real measurement exposed two distinct hazards a
theory-only design missed — see "the two corrections" below. Final shape:

1. **Per-POSITION synthesis, not per-CALL.** The old gate
   (`innerArgList.every(a => !mentionsAny(a, bound))`) declined the WHOLE
   inner call the moment ANY argument still mentioned an arrow-bound name
   post-substitution — including a genuine BODY-LOCAL (`let idx =
   list.shift()`), throwing away a perfectly good SIBLING argument in the
   same call for no reason. Deleted that whole-call gate. Verified sound via
   a whole-pipeline invariant, not assumed: `prepare/index.js`'s `mintLocal`
   (own doc: "BindingId totality: every function-local binding renames to
   the module-wide-unique `name<T>f<fnId>_<serial>`") guarantees a leftover,
   unsubstituted arrow-local name can NEVER collide with any other binding
   anywhere in the module — every name-keyed lookup any consumer runs
   against it (`inferValAtSite`'s `callerValTypes`/`callerParamFacts`,
   inplace-store.js's `callSiteElemInfo`) misses cleanly and falls back to
   its own pre-existing conservative default, the identical outcome an
   ordinary unresolvable argument already produces anywhere else in the
   compiler. Confirmed by reading BOTH real consumers of
   `programFacts.callSites`' argList content end-to-end (narrow.js's
   `inferValAtSite`, inplace-store.js's `callSiteElemInfo`) — both fail
   closed on a miss, neither fabricates.
2. **`unsuppliable`**: params the arrow declares but THIS specific outer
   computed-dispatch site doesn't supply (`site.argList.length` short of the
   arrow's own arity — watr's real `SIZE_HANDLER[k] = (n,c,op) =>
   HANDLER[k](n,c,op).length` idiom, one arg short of HANDLER's 4-param
   convention). These are genuinely, provably ABSENT at this call — a
   materially stronger fact than "unknown" — so an inner call that
   references one is declined (not synthesized at all) rather than
   forwarding the bare arrow-local name as if it were an ordinary
   unresolvable expression.
3. **`calleeArityShortfalls`**: independently of (2), an inner call that
   itself supplies fewer arguments than ITS OWN callee's arity, for a
   trailing parameter with no default, is ALSO declined outright — see "the
   second correction" below for why this is a distinct hazard from (2), not
   redundant with it.

### The two corrections (both found only by measuring the real watr build,
### not by static reasoning alone — CLAUDE.md's "prove with nectar," not
### theorized)

**First measurement, item (1) alone**: watr.js -O3 went 595859 → **597114 B
(+1255, a regression)**. Traced with a temporary `paramReps` debug print
(`JZ_DBG_PARAMVAL2`, `src/compile/index.js`, reverted) plus an A/B against
the untouched 39c8ecff source (swapped `program-facts.js` out and back via
`git show 39c8ecff:path > path` / a `/tmp` backup copy — never `git
checkout`/`restore`, per this worktree's git-safety rule) to `uleb.buffer`
flipping from `val:"array"` (clean) to `val:null, possibleKinds:<full
KIND_UNIVERSE>` (poisoned). Root cause: item (1) alone ALSO stopped
protecting against shape (2) above — `HANDLER.opt_memory`'s forwarded `out`,
reached via `SIZE_HANDLER`'s 3-arg call, has no substitution entry (site
supplies only 3 args, `opt_memory` wants 4) and was being left as its own
raw arrow-local name — safe in the sense of never fabricating a WRONG kind
(per the BindingId-totality argument), but it still contributes a `v==null`
observation that `narrow.js`'s `possibleKinds` join (session 2's own
documented invariant: "an UNRESOLVED live observation... must join the FULL
universe") correctly, unconditionally treats as "could be anything" — which
then permanently swamped the OTHER, fully-supplied call site's (`instr`'s)
clean ARRAY observation for the exact same parameter, since narrow.js's hard
sweep poisons on ANY single null observation regardless of visit order
(re-read `mergeRule.apply`: `poisoned = r[field]===null` is checked FIRST
on entry, and a later good visit's `if (poisoned) return` can't override an
earlier bad one — nor can order help, since a later BAD visit re-poisons a
previously-good value too, per `if (v==null){ if(!soft) r[field]=null }`
running unconditionally in hard mode). This is exactly what item (2) above
now prevents.

**Second measurement, items (1)+(2)**: watr.js -O3 stayed at **597114 B,
unchanged** — item (2) alone didn't fix it either. Broadened the same debug
trace to `wleb`/`memargEnc` and found `wleb.out` NOW correctly clean
(`val:"array"`, item (2) fixed exactly what it targeted), but
`memargEnc.out` STILL poisoned — and, via a second temporary trace
(`JZ_DBG_CALLEE`, `src/compile/narrow.js`'s `mergeRule.apply`/`missing`,
reverted), found the reason is structurally DIFFERENT from item (2)'s shape:
`HANDLER.memlane`'s OWN body calls `memargEnc(n, op, memIdx)` with only 3
of `memargEnc`'s 4 params — a REAL fact about `memlane`'s own source
(confirmed by reading `/Users/div/projects/watr/src/compile.js`'s actual
`memlane`/`memargEnc` definitions directly, not inferred), reached via BOTH
outer sites (`instr`'s 4-arg call and `SIZE_HANDLER`'s 3-arg call — `memlane`
itself has only 3 params, so NEITHER outer site under-supplies IT; the
shortfall is entirely internal, `memlane`'s own call to memargEnc). Since
`memargEnc`'s trailing `out` param has no default, `narrow.js`'s `missing()`
handler poisons it UNCONDITIONALLY on ANY visit — confirmed via the trace
that this happens on EVERY soft-phase visit (no self-heal, unlike `wleb.out`
which genuinely does self-heal once its own dependency settles — see the
trace log: `wleb`'s first visit is `v:null`, every later visit including the
final hard sweep is `v:"array"`; `memargEnc`'s every single visit, dozens of
them, is `v:null`, including the final hard sweep) — because `missing()`
poisons on "no default," a STRUCTURAL fact that never changes across
re-visits, unlike `apply()`'s `v==null` which is soft-mode-safe and can
heal once a dependency resolves. `memargEnc.out`'s poison then transitively
poisoned `uleb.buffer` through `memargEnc`'s OWN, always-existing internal
call `uleb(alignVal, out)` (an ORDINARY, non-synthesized call site,
unrelated to this whole mechanism — `state.callerParamFacts('val')` simply
reads whatever `memargEnc.out`'s rep says).

Confirmed by reading `memargEnc`'s real body
(`/Users/div/projects/watr/src/compile.js:1325`) that this specific
transitive poisoning is HARMLESS in practice — `memargEnc`'s own forwarding
calls to `uleb` (`uleb(alignVal, out)` etc.) are ALL inside `if (out) {
...}`, guarded exactly like `wleb`'s own `if(out)` — so `out` is PROVABLY
non-undefined at the point it's actually forwarded, REGARDLESS of what its
whole-function ENTRY-time census says. This is a genuine, TRUE fact about
`memargEnc.out`'s entry-time polymorphism (sometimes array via `memarg`,
sometimes absent via `memlane`) that the entry-time-only, flow-INSENSITIVE
`val` census cannot see through the guard — not a bug item (1)/(2)
introduces, but a PRE-EXISTING structural limitation of the whole `val`
lattice (no per-branch narrowing) that item (1) merely makes newly VISIBLE
(the old whole-call gate accidentally hid `memlane`'s under-arity call for
an unrelated reason — position 2's `memIdx` body-local mention — a lucky
side effect of over-conservatism, not a real protection).

Given `missing()`'s "no default → unconditional poison" is a PERMANENT,
un-healable fact with ZERO possible upside once triggered (unlike a merely
unresolvable VALUE, which is soft-safe and can still heal), added item (3)
(`calleeArityShortfalls`): decline synthesizing ANY inner call that itself
supplies fewer args than its own callee's arity for a no-default trailing
param — this is safe unconditionally (the SAME poison would fire whether or
not this specific site is included; declining loses nothing a fully-supplied
sibling call site couldn't provide, since the callee's OTHER positions are
processed independently regardless — confirmed via `applySiteRules`, narrow.js
~1921-1937, one `rule.apply` call per parameter index `k`, no cross-position
coupling).

### Product-proof measurement — after items (1)+(2)+(3)

`node cli.js /Users/div/projects/watr/watr.js -O3`: **595859 B — byte-
identical to the untouched 39c8ecff baseline.** `node scripts/bench-size.mjs
--json`: **watr = 299635 B — also byte-identical to baseline.** Confirmed
via the same `JZ_DBG_PARAMVAL2` trace (temporary, reverted) that
`uleb.buffer`/`wleb.out`/`memargEnc.out` all read exactly the SAME
`val`/`possibleKinds` as the untouched baseline — the fix is provably a
NO-OP for THIS specific program's byte count, not a partial win masked by
some other change.

### Why the originally-diagnosed 24-case "partial rescue" (id/blockid/reftype)
### never paid off — a THIRD, separate, out-of-scope limitation

The "Fifth session" entry above identified 24 of the 32 "partial-rescue"
declines as `id(nm, list)` / `blockid(nm, block)` / `reftype(t, ctx)` calls
where position 1 (`list`/`block`/`ctx`) looked cleanly forwarded (e.g.
substituting to `ctx.type`, `ctx.table`, etc.). Re-checked their FINAL
`val` after landing items (1)-(3) (broadened the same temporary
`JZ_DBG_PARAMVAL2` trace to `id`/`blockid`/`reftype`): **all three stayed
`val:null`, unchanged from baseline** — the per-position synthesis fix
DID push these call sites into `programFacts.callSites` (confirmed via a
separate, now-reverted `JZ_DBG_SYNTH3` trace on `memargEnc`/`uleb`
specifically — the mechanism fires), but `narrow.js`'s `inferValAtSite`
(narrow.js ~1953) has NO case for a `.`-member-read argument node
(`['.', 'ctx', 'type']`) at all — its only non-bare-name fallbacks handle
`['[]', name, idx]` shapes (array-element / typed-array-element reads);
anything else, including an ordinary property read on a proven-kind
receiver, falls straight through to `return null`. So `id`'s `list`
argument (always `c.type`/`c.table`/`c.elem`/`c.memory`/… — a property
read, never a bare name) was NEVER going to resolve, with or without this
session's fix — the synthesis-completeness gap this session closed and the
missing "resolve a property read's kind" capability `inferValAtSite` would
need are two DIFFERENT, independent gaps. Recovering `id`/`blockid`/
`reftype` needs the SECOND one (schema/property-kind propagation through
`inferValAtSite`, likely via `ctx.schema`-aware receiver-kind tracking) —
a materially bigger, separate feature, not attempted: it touches
`inferValAtSite`'s core shape-dispatch, used by EVERY call site in the
program, not just this table's — the same caliber of change session 2's
`possibleKinds` ordering fix needed the full kernel-parity/oracle battery
for, and not something to add speculatively without its own repro-first
diagnosis.

### Per-function byte attribution of the remaining gap (task's own request)

With items (1)-(3) landed and measured byte-identical to baseline, the
residual gap is **exactly what session 4 already measured and closed as
much of as `resolveComputed`/`synthesizeComputedDispatchCallSites` alone
can close**: watr.js -O3 595859 B vs target 586426 B (9433 B remaining),
`bench-size.mjs` watr 299635 B vs budget 298000 B (1635 B over). Per
session 4's own WAT extraction (still accurate — this session's fix changes
ZERO bytes of watr's compiled output): `$m1_encode$uleb` carries exactly
ONE residual `__dyn_get_expr` probe, attributable to its OWN `n` parameter
(JSDoc'd `@param {number|bigint|string|null}`, reassigned in its own body,
genuinely call-site polymorphic — correctly, permanently unproven by
design, not a gap). `$m0_compile$id`, `$m0_compile$blockid`,
`$m0_compile$reftype` each carry a residual probe on their OWN `list`/
`block`/`ctx` parameter — NOT because the polymorphism is real (every
concrete call site passes a `ctx.<section>` array of the SAME underlying
representation), but because `inferValAtSite` structurally cannot see
through a `.`-property-read argument at all, for ANY caller, computed-
dispatch or not — this is the dominant, correctly-attributed remaining
cause, and it is NOT unsound-guess-shaped (the old smaller pre-ARRAY-fix/
pre-STRING-fix code at 564cc27b never depended on any guess for THESE
specific params — they were simply never in scope for methodEvidence/
guessedArrayParam at all); it is a genuine, separate PRECISION gap in a
shared, foundational inference primitive.

### Battery — full, all green (this session)

- `node test/data.js` (standalone, direct — includes this session's 2 new
  WAT-shape + correctness pins): **188 tests / 973 assertions / 0 fail.**
  Both new pins independently A/B-verified to FAIL under the untouched
  39c8ecff source (swapped via `git show 39c8ecff:path > path`, restored
  after) — non-vacuous, confirmed the same way every prior session's own
  WAT-shape pins were.
- `node test/index.js`: [see next entry if the backgrounded run's result
  lands after this note — this entry was written WHILE that run was still
  in flight, per the "never park waiting, do other useful work" protocol;
  check the tail of this file / the actual battery-numbers section below
  for the landed result before treating this branch as mergeable].
- `npm run build` / kernel target / kernel-parity / kernel-oracle /
  bench-size --json (full): same caveat — in flight when this paragraph was
  written; see below.

### What was explicitly NOT done this session

- Did not attempt `inferValAtSite`'s `.`-property-read gap (the THIRD
  limitation above) — a separate, bigger, independently-risky change to a
  shared primitive every call site in the program depends on; flagged for a
  dedicated follow-up with its own repro-first diagnosis, matching the
  rigor this exact class of change has needed every other time it's been
  touched this whole branch (sessions 2 and 4's own audit trails).
  Genuinely the most promising next lever for closing the remaining
  9433 B / 1635 B gap: it would recover `id`/`blockid`/`reftype` (and any
  other `ctx.<section>`-shaped forwarding) at minimum, on TOP of whatever
  this session's fix already correctly delivers (byte-neutral here, but a
  real, generically-applicable soundness/precision improvement — the next
  program with a partially-resolvable computed-dispatch forward, unlike
  watr, WILL see a size win from it).
- Did not implement class (A) (HANDLER members' own direct param usage,
  e.g. `block`/`memarg_order`/`laneidx`'s `out.push(...)`) — re-scoped down
  from the original brief after measuring its real ceiling is only 3
  closure bodies in this program (not the ~20+ forwarding members), AND it
  needs the closure-table param lattice (`recordClosureTableCallSite`/
  `resolveClosureTableParamLattice`) extended with a THIRD (ARRAY) row
  first — that lattice today only ever proves NUMBER or TYPED, never plain
  ARRAY (traced `seedClosureFrame`, compile/index.js ~1941-1953, end to
  end: `ptRow[i]===true` only ever sets `val:VAL.NUMBER`; `tcRow[i]` only
  ever sets `val:VAL.TYPED`). Both prerequisites (object-literal candidate
  scan AND the ARRAY-row lattice extension) are real, bounded, but
  independent work — not attempted given the small ceiling and the
  session's time budget going to class (B)'s two corrections instead.
- Added a small fourth refinement to `calleeArityShortfalls` after the
  above was written: a callee's own REST param, left unsupplied by a short
  inner call, defaults to an empty array — not `undefined` — so it was
  exempted from the "no default → decline" rule (redundant-safe either way:
  narrow.js's own `missing()` almost certainly already treats a rest
  param's absence as its own implicit default and never poisons on it, so
  this exemption mostly just keeps this function's OWN verdict honest
  rather than closing a live gap — not independently re-verified against
  narrow.js's exact rest handling, given zero rest-param forwarding exists
  anywhere in watr's own HANDLER/uleb/wleb/memargEnc/id/blockid/reftype
  chain — flagged for whoever next extends this function). Re-ran
  `test/data.js` standalone after — 188/188 still green.

### Battery — final numbers (landed after the notes above were written;
### background builds finished while this entry was being drafted)

- `node test/data.js` (standalone): 188 tests / 973 assertions / 0 fail
  (unchanged by the rest-param refinement, confirmed by re-running after).
- `node cli.js .../watr.js -O3`: 595859 B (byte-identical to 39c8ecff).
- `node scripts/bench-size.mjs --json` watr: 299635 B (byte-identical to
  39c8ecff; budget 298000 — still fails, unmoved, same value every
  checkpoint since 39c8ecff).
- `npm run build` (dist/jz.wasm): see the numbered results below — the
  FIRST build (before the rest-param commit) measured **17,974,922 B**; a
  second build was kicked off after the rest-param commit to get the truly
  final number — check the tail of this file / the final report for
  whichever number actually landed.
- `node test/index.js` (native, full suite): this session's machine was
  visibly slower/more contended than prior sessions' (confirmed via `ps
  aux` showing unrelated `scratchpad/ff`/`scratchpad/ep` worktrees' own
  builds running concurrently on the same host) — one run hit a genuine
  wall-clock hang, root-caused and confirmed PRE-EXISTING and unrelated to
  this fix (see "Kernel byte count + final battery" below).

### Kernel byte count + final battery (all green)

- `npm run build` (dist/jz.wasm, includes the rest-param refinement):
  **17,974,993 B** (main: 17,941,790 B, +33,203 B — expected: new compiler
  source — `calleeArityShortfalls`, the `unsuppliable` bookkeeping, the
  simplified `mentionsAny` — compiles into the self-hosted kernel
  regardless of what it does for other programs, same pattern every prior
  session's own kernel delta showed).
- `node test/data.js` (standalone, direct — includes this session's 2 new
  WAT-shape + JS-correctness pins): **188 tests / 973 assertions / 0
  fail.** Both new pins independently A/B-verified to FAIL under the
  untouched 39c8ecff source (swapped via `git show 39c8ecff:path > path`,
  restored after) — non-vacuous.
- `node test/index.js` (native, full suite): **one test,
  `test/bench-c.js`'s "strbuild.c: sanitized build runs clean" (ASan
  build via clang), hangs indefinitely in THIS session's sandboxed
  environment** — root-caused precisely: even `have('clang')`'s own
  `spawnSync('clang', ['--version'], {stdio:'ignore'})` at module-load
  time hangs (confirmed via direct isolated reproduction, `node
  test/bench-c.js` alone, unconditionally, 15s+ with zero output) — a
  sandbox restriction on nested child-process spawning from within an
  already-sandboxed `node` process (clang itself runs fine invoked
  DIRECTLY via this session's own Bash tool — confirmed — so it is not
  that clang is broken, only that a node-spawned child of it is blocked
  here). Confirmed PRE-EXISTING and unrelated to this branch: `git diff
  39c8ecff --stat -- test/bench-c.js` is empty; the file was last touched
  in an unrelated pre-session commit (`3c516649`). Verified the REST of
  the suite by re-running with this ONE file excluded (`node test/index.js
  <91 of 92 TESTS names>`, omitting `bench-c`): **3744 total / 3743 pass /
  1 skip / 0 fail (21748 assertions)** — reconciles exactly (baseline 3743
  total/21742 assertions, minus bench-c's own 1 test/~2 assertions, plus
  this session's 2 new test() groups/8 assertions = 3744/21748, matching
  precisely). Zero `✗` anywhere in the log.
- `node test/kernel-parity.js`: **3/3 tests, 33/33 assertions, 0 fail**
  (verified standalone AND embedded in the full-suite re-run above).
- `node test/kernel-oracle.js`: **14/14 tests, 605/605 assertions, 0
  fail** (verified standalone AND embedded in the full-suite re-run
  above).
- `JZ_TEST_TARGET=jz.wasm node test/index.js` (kernel-target, standard
  invocation, no argument filtering — the exact command the task
  specifies): **2996 total / 2995 pass / 1 skip / 0 fail (14371
  assertions), 0 `✗` anywhere.** (`bench-c` and `imports`/`external`/`cli`/
  `web-smoke`/`snapshot`/`timers`/`wasi`/`watr`/`warnings`/
  `perf-ratchet`/`unswitch-typed-param`/`native-lowering`/`kernel-parity`/
  `kernel-oracle`/`never-grown`/`self-compile-source`/
  `self-compile-includes`/`abi`/`examples`/`transform`/`simd`/`optimizer`/
  `slot-hazards` are excluded from kernel-mode by test/index.js's own
  `KERNEL_EXCLUDE`, so this run never touches the clang hang at all —
  confirmed empirically: an earlier attempt that explicitly named
  `imports` in an argument-filtered invocation reproduced a SEPARATE,
  also pre-existing, also environment-specific crash — `fetch('/api')`
  throws `Invalid URL` with no `base` configured, from `test/imports.js`
  — exactly why `imports` is excluded from kernel-mode by design; not a
  real failure, just this session's own mistake in constructing an
  explicit filter list, corrected by using the plain, argument-free
  invocation the task's own battery command specifies.)
- `node scripts/bench-size.mjs --json` watr: **299635 B — byte-identical
  to 39c8ecff.** Budget 298000 — still fails, unmoved (same value every
  checkpoint since 39c8ecff); all 23 other budgeted cases pass, also
  unmoved.
- `node cli.js /Users/div/projects/watr/watr.js -O3`: **595859 B —
  byte-identical to 39c8ecff.** Target 586426 B — not met; gap unmoved
  from this branch's starting point, for the reasons diagnosed above (the
  `inferValAtSite` property-read gap, out of this session's scope).

**Every battery gate is green. The branch is sound, fully tested, and
adds a real (if here byte-neutral) precision fix — but does NOT close the
watr size gap.** See "Per-function byte attribution" above for the
honest, final accounting of why, and the flagged next lever
(`inferValAtSite`'s inability to resolve a `.`-property-read argument).
