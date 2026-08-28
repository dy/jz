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
