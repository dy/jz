# jz — TODO archive (2026-08)

Working history archived from .work/todo.md (audit-#11 architectural-bank
item 6, ledger trim — todo.md had grown to 643KB). Covers Status entries
from 2026-08-05 (§14 point 4) back through 2026-07-28 (re-audit #3
reconciled) — everything already landed and reflected in commits at the
time each entry was written. Grep this file before re-deriving anything;
every kernel bug class, perf frontier, and audit finding in this window has
a banked dissection here. Older history (through 2026-07-25) is in
.work/archive-todo-2026-07.md. Still-open items and current goals stay live
in .work/todo.md's own "## Goals"/"## Open" sections — this file is
historical narrative only, not a tracker.

## Status (2026-08-05, §14 point 4 landed — JOINT runtime-domain dispatch for
## binary BigInt⊕Number mixing; full design writeup
## .work/represented-maybe-undefined-design.md §19)

Closed audit #10's own last named item: `bigintMixReject`/the old per-op
gates are OPERAND-LOCAL, unable to jointly tell "both absent" (Number NaN,
no throw) from "one absent + one real BigInt" (throw) from "a proven BigInt
paired with a real dynamic Number" (throw) — three different ES2024
13.15.3 outcomes for the identical static shape. `m.get('x') + 1` (5n
present, `+1` literal) silently gave garbage NUMBER instead of TypeError;
`let x = BigInt(v); return x - w` (w a plain dynamic param) silently gave a
wrong bigint instead of TypeError; the 9-op census-BigInt sub-case
(`-*/%&|^<<>>` on two present-key BigInt census reads) stayed NUMBER instead
of the real BigInt result.

**Mechanism**: `emit.js`'s new `bigIntDomain`/`bigIntDomainsCanMix`/
`bigIntJointDispatch` — evaluate both operands ONCE, classify each side's
REAL runtime domain (present-vs-absent for a census claim via `isUndef`; the
same subnormal-magnitude heuristic `typeof x==='bigint'` already uses for a
genuinely unresolved operand), joint-dispatch: both Number → the plain op;
both BigInt → i64 arithmetic; mismatch → TypeError. Wired at all 9 binary
arithmetic/bitwise ops. `kind.js`'s VT/`censusBigintSentinelKind` and
`compile/index.js`'s `_resultNumeric` generalized in lockstep so the export
lane agrees with the WASM computation.

**Two self-host regressions found and fixed** (native tests alone did NOT
catch these — only rebuilding `dist/jz.wasm` and running `test/selfhost.js`
did): the runtime magnitude heuristic is only reliable for SMALL values, so
applying it unscoped to (1) a REASSIGNED local that can legitimately hold
ANY 64-bit magnitude (watr's own self-hosted i64 LEB128 encoder,
`node_modules/watr/src/encode.js`) and (2) a never-reassigned param of a
NON-exported internal helper (layout.js's `i64Hex`, whose argument has no
host-boundary size assurance) both produced false-positive throws that broke
the self-hosted kernel build outright. Fixed by restricting the heuristic-
eligible ('null'-domain) classification to a never-reassigned parameter of a
function that is ITSELF a WASM export (`ctx.func.exported`, new, threaded
through `enterFunc`) — f1c1256b's own named repro (`export let f = (v, w) =>
{ let x = BigInt(v); return x - w }`) still qualifies (exported, `w` never
reassigned). A related `type.js` bitwise-narrowing regression (an
over-broadened structural census check killed a PRNG kernel's vectorization,
12→0 v128 ops) was found and fixed alongside it — re-gated the broad,
imprecise fallback behind its exact original `vt==null` condition, kept only
the PRECISE census checks unconditional.

**Documented, permanent, accepted residual** (not a bug, same class the
codebase already tolerates for a `0n`-literal mix elsewhere): the bitwise
family's (`&|^<<>>`) "both operands census-BigInt and both absent" cell
decodes as `0n` (bigint) instead of JS's real `0` (number) — ToInt32(NaN)=0
on both sides, and 0's raw carrier bits are IDENTICAL for a genuine BigInt
0n and a genuine Number 0, an inherent, unfixable-without-boxing collision.
Pinned explicitly as a documented gap, not silently wrong.

**Gates**: full ~92-file battery (foreground chunks of 6) green; dyn-keys.js
55/55 (270 assertions) both legs; watr.js 35/35; kernel-parity 33/33
byte-identical; kernel-oracle 11/11 (2^62-boundary pins green); perf-ratchet
10/10 at +0 (proven-domain fast paths byte-identical — verified via WAT diff,
not just ratchet counts); selfhost.js 21/21 (fresh kernel rebuild); fuzz
2000×4 (seeds 1-8000) zero divergence; size sweep 1.042× unchanged; fresh
build ×2 byte-identical (`dist/jz.js` sha256 `412df510…`, `dist/jz.wasm`
sha256 `fc6d006d…`, `dist/interop.js` sha256 `fcda069b…`).

Files: src/compile/emit.js, src/kind.js, src/type.js, src/compile/narrow.js,
src/compile/index.js, interop.js, test/dyn-keys.js. Full detail:
.work/represented-maybe-undefined-design.md §19.

## Status (2026-08-04, audit-#10 kind-specific table closed — member access
## and calls on a genuinely-undefined receiver now throw a real, catchable
## TypeError instead of trapping/reading garbage/host-dispatch-erroring; full
## design writeup in .work/represented-maybe-undefined-design.md §17)

Closed the five `KNOWN-FAIL (audit #10, future work)` rows §14 of the
maybeUndefined design named: `m.get('missing').length` (ARRAY/STRING
census), `m.get('missing')()` (CLOSURE census), `m.get('missing').slice()`
(STRING census), `m.get('missing').toFixed(2)` (NUMBER census) — was a wasm
bounds/table trap, a garbage default value, or jz's own internal host-
dispatch `Error`; now a real ES `TypeError`, catchable in-wasm
(`instanceof TypeError` true via the Error model's tag+schema arm) and
decodable at an uncaught host boundary to a real host `TypeError`
(interop.js's existing `decodeThrown`, zero new decode machinery).

**Mechanism**: upgraded FIVE existing "unresolved-receiver" runtime arms
(module/core.js `emitLengthAccess`; emit.js `tryRuntimeStringFork`/
`tryRuntimeNumberMethod`/`externalMethodFallback`/`emitGenericClosureCall`)
with one `isNullish` branch each, throwing a REAL constructed TypeError
object (`src/ir.js` `throwTypeErrorIR`, new — built inline, same shape as
`new TypeError(...)`'s own construction path, no module/string.js
dependency) instead of falling through to the old trap/garbage/host-dispatch
behavior. No new dispatch pass — every arm already ran on every unresolved-
kind receiver.

**The one real fight**: an early draft gated all five arms on "receiver's
static kind is unresolved" (a literal reading of the task's own brief).
Gate run caught it: ordinary POLYMORPHIC-but-never-nullish parameters
(bench/poly.js's `sum(arr)`, called with both a Float64Array and an
Int32Array — no single provable kind, never actually undefined) paid the
full guard tax too, regressing the 49-case size-sweep geomean from 1.0418×
to 1.111× (49/49 cases, ~+100B flat each). Fixed by gating on
`censusMaybeUndefined` (kind.js, EXISTING, narrower "genuinely might carry
real undefined" predicate this whole design already built) instead of "kind
unresolved" — restored the geomean to 1.0418×, 0/49 cases differ from HEAD.
Also found, in the process, two SEPARATE pre-existing self-host/module-
autoload landmines (`__mkptr(...)`'s literal-offset folding,
`.call`/`.apply`/`.bind` static lowering's thisArg side effect — both
confirmed at clean HEAD 1d083ba9 via a disposable worktree) and a third,
genuinely pre-existing kernel-parity divergence in `$__dyn_get_t_h`'s schema
arm that the vt-unresolved draft transiently exposed and the
`censusMaybeUndefined` narrowing independently un-exposed (dict returns to
byte-identical, `PARITY_TODO` stays empty) — none fixed, all out of scope,
all documented (§17).

**Gates**: full ~90-file battery, every chunk green; dyn-keys.js 50/50 (188
assertions); kernel-parity 33/33 byte-identical; kernel-oracle 11/11;
perf-ratchet 10/10 at +0; minimal-output green; selfhost.js 21/21; fuzz
2000×4 (seeds 1-8000) zero divergence; size sweep 1.0418× (baseline,
unchanged); fresh build ×2 byte-identical (`dist/jz.js` sha256 `8a8fb7be…`,
`dist/jz.wasm` sha256 `58848b4f…`, `dist/interop.js` sha256 `396500b4…`).

## Status (2026-08-04, SIZE goal recovered below the 1.05 cap — bisected the
## un-bisected soundness-guard tax named in the "SIZE: par-or-smaller" entry
## below, landed one proof-driven elision lever, geomean 1.055x -> 1.0418x)

**Method**: disposable `git worktree add /tmp/jz-wt-2aaeaa19 2aaeaa19` (node_modules
symlinked, package.json deps unchanged across the range — confirmed via `git
diff 2aaeaa19 HEAD -- package.json`, empty). Ran `scripts/bench-size.mjs --json`
at both revisions over the full 49-case corpus that has both a jz and an `as`
row (the scope `.work/todo.md`'s own tracked "1.0550" figure and
`test/bench-claims.js`'s size test use — WIDER than `test/bench.js`'s formal
`SIZE_GEOMEAN_MAX` assertion, which only gates the 13 `win`/`tie`-pinned
cases and was never actually red, 0.879x throughout; the 1.055x/1.05 cap
tension is real but lives one level up, in the informal-but-tracked 49-case
number both the ledger and bench-claims.js treat as the health metric).
Confirmed the endpoints exactly: 2aaeaa19 geomean **1.0163x** (matches "1.016x"
prose), HEAD (917feacc) geomean **1.0550x** (matches "1.055x" prose) — the
25/49-smaller count also matched (25/49). Ranked all 49 cases by
`ln(newRatio/oldRatio)` — each case's exact contribution to the geomean's
log-shift, not raw bytes (a fair per-case attribution for a geometric mean).

**Attribution table** (top contributors to the 1.0163->1.0550 shift; `dLog`
sums to 1.8345 over 49 cases = the measured shift):

| case | 2aaeaa19 jz (B) | HEAD jz (B), pre-fix | delta (B) | dLog | share of total shift |
|---|---|---|---|---|---|
| lz | 1899 | 3023 | +1124 | 0.4649 | 25.3% |
| glyfparse | 2873 | 4012 | +1139 | 0.3339 | 18.2% |
| base64 | 1634 | 1776 | +142 | 0.0833 | 4.5% |
| radixsort | 1388 | 1496 | +108 | 0.0749 | 4.1% |
| levenshtein | 1266 | 1341 | +75 | 0.0576 | 3.1% |
| bytebeat | 932 | 981 | +49 | 0.0512 | 2.8% |
| conv2d | 1456 | 1522 | +66 | 0.0443 | 2.4% |
| dotprod | 1019 | 1059 | +40 | 0.0385 | 2.1% |
| hash | 1094 | 1134 | +40 | 0.0359 | 2.0% |
| matmul, sort, delayline, tokenizer, ... | — | — | +40..50 each | ~0.02-0.03 each | ~1-1.5% each |
| ~40 other cases (mandelbrot, poly, crc32, dict, vm, wav, trace, sieve, spmv, particle, resample, shapes, qoi, nqueens, mat4, nbody, lorenz, immutable, heat, hashjoin, fft, dispatch, biquad, bitwise, colorpq, aos, bezfit, callback, synth, sdf, raytrace, slices, wordcount, alpha, strbuild, noise, ...) | — | — | flat **+26 B each** (blur -6, noise +16 — the two non-conforming rows) | ~0.01-0.02 each | remainder |

**lz/glyfparse are 43.5% of the total shift from 2 of 49 cases** — the clear
priority. WAT-diffed both (`compile(code, {optimize:'size', wat:true})` at
each revision): HEAD's compiled output for BOTH pulls in stdlib helpers
absent at 2aaeaa19 — `$__eq`, `$__eq_strict`, `$__is_nullish`, `$__char_at`,
`$__str_byteLen`, `$__out0`..`$__out5` — despite **neither bench source using
a single string** (lz.js/glyfparse.js are pure Uint8Array codecs). Bisected
(binary search over the 75-commit 2aaeaa19..f704a077 range, disposable
worktree, probe = "does lz's compiled WAT declare `$__eq`") to **5c437df5**
("maybeUndefined Slices 3-5"), whose own message names the exact mechanism:
*"emitLooseEq/emitStrictEq's raw f64.eq fast path (equality between two
independently-maybe-undefined operands read false instead of true — also
closes the same leak for array/typed-array OOB reads, not just census)"* —
a genuine, necessary correctness fix (`src[j+len] === src[ip+len]` on two
checked-OOB Uint8Array reads used to silently read `false` for
`undefined === undefined`, JS-wrong). The fix routes that shape through the
**fully generic** `$__eq`/`$__eq_strict` (string-content + pointer-kind
dispatch: `__str_eq`/`__is_str_key`/`__char_at`/`__str_byteLen`), even though
a NUMBER-typed nullable slot's only two possible runtime shapes are "a real
number" or a nullish sentinel — never a string/object/bigint.

**Guard-class attribution**:
- **lz/glyfparse's +1124/+1139 B**: `emitLooseEq`/`emitStrictEq`'s
  both-nullable-`VAL.NUMBER` fallback (checked typed-array OOB-read
  equality) — over-generalized to the full dynamic dispatch. RECOVERED this
  session, lever (b) below.
- **~40 cases' flat +26 B each**: `__jz_last_err_bits` (global + export),
  `ensureThrowRuntime`/`pruneUnusedThrowRuntime` in `src/compile/index.js`.
  INVESTIGATED, NOT recoverable: already gated on `ctx.runtime.throws`
  (fires for any module with an internal throw site, which
  checked-by-default typed indexing makes nearly universal) — the code's own
  comment names why stripping it is wrong: *"it is the ONLY signal that
  survives an `unreachable` trap to the host boundary... Stripping this
  global (the old behavior) made host decode of ordinary runtime errors
  unreachable by construction (audit #7 P1)"*. Removing or narrowing this
  would reopen audit #7 P1. Declined — matches this task's own "NEVER:
  removing a guard where the semantics require it" instruction.
- **base64/radixsort/levenshtein/bytebeat/conv2d/dotprod/hash/matmul/sort/
  delayline/tokenizer's +40-140 B each**: NOT bisected — WAT-diffed (func
  inventory identical at both revisions, no new stdlib helper pulled in
  unlike lz/glyfparse), so the growth is inline per-site widening within
  EXISTING functions, not a new dispatch class. Consistent with the
  i32-storage-widening / fits-gate-demotion candidate classes named in this
  task's brief. Left unattributed — the two landed cases already clear the
  1.05 cap with margin; chasing single-digit-byte residuals further would be
  gold-plating past the stated target.

**Lever landed — (b) Proof-driven elision** (`src/compile/emit.js`,
`emitLooseEq`, ~35 lines): when both operands are proven `VAL.NUMBER` but
neither is individually "safe" (both nullable — exactly the maybeUndefined
gap 5c437df5 closed generically), the only two runtime shapes are "a real
number" or a nullish sentinel. Added a narrower branch ahead of the
`REF_EQ_KINDS`/`STRING` dispatch: `f64.eq(a,b) OR (both-nullish, matched to
loose/strict semantics)`. Uses `isUndef`/`isNull`/`isNullish` (ir.js) — the
EXACT reserved-sentinel-bit checks, reused verbatim, not reinvented.

**A real bug caught before landing, not assumed away**: the first draft used
blind i64 bit-equality (`bits(a) === bits(b)`) as the "both nullish" check
instead of the exact sentinel test. Differential-probed against a real
`Float64Array` holding a literal `NaN` (`arr[1] = NaN`) crossed with every
other slot, all four of `===`/`==`/`!==`/`!=`, all index combinations
(-1..5 x -1..5): **1 mismatch** — `x === y` with both reading the stored
`NaN` returned `true` (bit-identical NaN payloads), JS says `false`
(`NaN === NaN` is JS-false; only the specific UNDEF_NAN/NULL_NAN sentinel
bit patterns are "equal to themselves" under this representation). Fixed by
switching to `isUndef`/`isNull`/`isNullish`, which test the EXACT reserved
sentinel, not "any matching NaN payload" — re-probed, 0/49 mismatches.
Loose vs strict handled correctly: loose folds any null/undefined
combination together (`null == undefined` is JS-true, `isNullish(a) &&
isNullish(b)`); strict needs the SAME exact atom on both sides (`null ===
undefined` is JS-false, `(isUndef(a)&&isUndef(b)) || (isNull(a)&&isNull(b))`).
Verified against dict/Map `.get()` absent-key shapes too (the census
producer of this exact class) — present-vs-absent and absent-vs-absent both
match JS.

**Per-lever geomean trajectory**: 1.0550x (HEAD, pre-fix) -> **1.0418x**
(post-fix) — under the 1.05 cap with ~0.8% margin. Byte-identical everywhere
except the two bisected cases: lz 3023->2109 B (-914), glyfparse
4012->3098 B (-914); confirmed via a full before/after diff of all 58
`bench-size.mjs` rows — zero other cases moved by even 1 byte. win/tie(13)
formal `test/bench.js` scope: 0.8791x unchanged (was already comfortably
green, untouched by this fix — neither win/tie case exercises the fixed
shape).

**Gates, all green** (fresh full run, this session, on `917feacc` + the
uncommitted `emit.js` change): full 88-file battery, 13 foreground chunks of
4-7 (`node test/index.js <files>`) — **3330 total / 0 fail** (skips
unchanged shape from baseline); kernel-parity **33/33 byte-identical**
(O0/O2/O3, part of the kernel-parity+kernel-oracle+headline+examples chunk);
kernel-oracle 11/11 groups; perf-ratchet **10/10 at +0** every category
(int/float/mixed/cond/buf/nest/slice/ring/condref/fgather — the fixed shape
doesn't appear in `scripts/perf-corpus.mjs`'s generators); optimizer green
(part of the objects/dyn-keys/interop/abi/external/watr/optimizer chunk,
460 tests/4538 assertions, includes the pre-existing "dict: strict/loose
equality between two independently-maybe-undefined reads (Slice 5 LEAK A)"
pin — still green, confirms the new branch doesn't regress 5c437df5's own
fix); dyn-keys/data/errors run explicitly at `JZ_TEST_OPTIMIZE=0` and `=3`
(306 tests each, 0 fail) in addition to the default-level battery pass;
selfhost.js **21/21 (206 assertions)**; selfhost-perf.js 5/5 informational
(warm geomean 0.990x vs 1.03x cap, fresh geomean 0.784x vs 0.99x cap); fuzz
**2000x4** (seeds 1-8000, four independent foreground runs) — **zero
divergence** (30173/30672/30572/30466 inputs compared per run, identical
counts to the last certified run — deterministic seeded corpus); fresh
`npm run build` x2 — dist/jz.js, dist/jz.wasm, dist/interop.js sha256
byte-identical both times (`d04fc28b…`/`981a33a3…`/`396500b4…`); full size
sweep (`scripts/bench-size.mjs`) re-confirmed post-gates: 49-case geomean
**1.0418x**, win/tie(13) **0.8791x**.

**Residual, not chased (target already cleared with margin)**: the ~40-case
flat +26 B `__jz_last_err_bits` tax (investigated, confirmed unrecoverable —
see above); the base64/radixsort/levenshtein/bytebeat/conv2d/dotprod/hash/
matmul/sort/delayline/tokenizer inline per-site growth (~+40-140 B each, not
bisected — no new stdlib helper pulled in, so the growth is dispersed across
many small individually-justified sites rather than one lever-shaped root).
If the 1.05 cap needs more headroom later, these are the next dig, in that
order (base64/radixsort/levenshtein are the largest of the unbisected set).

**Files touched**: `src/compile/emit.js` (`emitLooseEq`, one new branch,
~35 lines, comment-heavy per this codebase's convention); `.work/todo.md`
(this entry). No test file changes — the existing `test/index.js` "dict:
strict/loose equality between two independently-maybe-undefined reads
(Slice 5 LEAK A)" pins already cover the fixed shape's value correctness
and stayed green throughout.

## Status (2026-08-04, CLEAN-WORKTREE CERTIFICATION f1c1256b — stack
## 976433c1..f1c1256b, 15 local commits, push-readiness review)

Protocol per the binding rule (72cc7fd1 lesson, first applied 4b149108):
`git worktree add <tmp> f1c1256b` + `npm ci` (prepare hook ran the build) +
explicit `npm run build` re-run — dist byte-identical both times
(jz.js/jz.wasm/interop.js sha256 match). All counts below are from that
clean worktree, not the dirty main tree.

**Full 88-file battery** (native leg, default env, 13 foreground chunks of
7 [last chunk 4], each its own `node test/index.js <files>` — no chunk
failed): **3330 total / 3324 pass / 0 fail / 6 skip** (pre-existing skips,
unchanged shape from HEAD's own landing gates).

**JZ_DEBUG_INVARIANTS leg** (battery.mjs's `dbg` definition: same 13 chunks,
`JZ_TEST_OPTIMIZE=3 JZ_DEBUG_INVARIANTS=1`): identical **3330/3324/0/6** —
byte-for-byte the same shape as the native leg (the invariants.js file
picks up one extra dbg-only assertion, canceled by rounding elsewhere;
net assertion-count wash). No invariant fired that shouldn't have.

**Named gates, isolated for exact counts**: kernel-parity **3/3 (33/33
assertions)** — matches precedent's tracked count exactly; kernel-oracle
**11/11 (451 assertions)**; optimizer **214/214 (3949 assertions)**;
perf-ratchet **10/10, +0 delta every category** (int/float/mixed/cond/buf/
nest/slice/ring/condref/fgather all exact-match baseline); selfhost.js
**21/21 (206 assertions)**; selfhost-perf **5/5** informational (warm
geomean 1.001× vs 1.03× cap: mat4 0.93 fft 1.00 biquad 1.05 sort 1.02
crc32 1.03 mandelbrot 0.99; fresh geomean 0.801× vs 0.99× cap: mat4 0.78
fft 0.80 biquad 0.80 sort 0.81 crc32 0.84 mandelbrot 0.79). fuzz **2000×4,
seeds 1-8000, four foreground runs, zero divergence** (30173/30672/30572/
30466 inputs compared per run, 0 non-numeric mismatches). Size sweep
(scripts/bench-size.mjs, live-measured on this machine, NOT the frozen
snapshot): **geomean jz/AS = 1.055×** — matches the 1.0550 target exactly.

**`npm run test:claims` — 2 pass / 9 fail / 11 total (24 assertions), ALL
9 REDS PRE-EXISTING, NONE NEW**: bench/results.json's `meta.commit` is
`f704a077`; 18 compiler-source commits postdate it (both freshness tests
fail on that count — reference evidence AND .work/memcheck-results.csv).
That staleness is NOT something this stack introduced: f704a077 already
predates origin/main's own tip (976433c1) by 3 commits (af08bead,
c8700daa, 4b20e4c6 — the documented "RECOVERY WAVE" that already landed
upstream before this local stack started), so the FRESH gate was already
red at origin/main before any of these 15 commits existed. The 7 remaining
reds (strict wasm-rival leadership 17 cases/8 true-red, wasm-rival band 8
red, V8-family strict 7/6 red, V8-family band, bun/jsc strict 11/10 red,
bun/jsc band, size-vs-AS-snapshot 1.057× > 1.05×) are ALL downstream of the
SAME static, unmeasured bench/results.json — test/bench-claims.js reads
committed JSON, it does not re-run rivals, so these numbers are the
f704a077 snapshot's numbers verbatim, carrying zero information about this
stack's actual runtime behavior. Exactly the ".work/todo.md 'REFRESHED AT
HEAD 2026-08-03'" pending-re-measure condition, documented before this
stack's first commit (cc78bf56). Coverage-floor axis (11/11 rivals ≥ 0.7
corpus) and the tight-integer-loop exception (vm/dict/crc32 vs bun/jsc,
0 exceeded 1.5×) both GREEN — the only two claims axes that don't depend
on stale leadership numbers. VERDICT: zero NEW reds; the claims gate stays
red for the same pre-existing reason it already was, unrelated to this
stack's changes (all of which are BigInt/maybeUndefined/error-model
correctness fixes, none touching the benched hot paths beyond what's
already reflected in perf-ratchet's +0 and selfhost-perf's informational
numbers staying inside cap).

**PUSH-READINESS: CERTIFIED.** Every gate this stack can affect is green
in a clean worktree of the exact commit; the sole red (test:claims) is a
structural staleness condition that predates the stack and requires a
reference-bench re-measure (a separate, already-scoped task), not a code
fix. Recommend push. (Note: task brief said "17 commits ahead"; measured
`git log --oneline origin/main..HEAD` gives 15 — reported as measured.)

## Status (2026-08-04, represented-maybe-undefined Slice 7 landed — "widen
## the consumer chokepoints", .work/represented-maybe-undefined-design.md §16
## — most named acceptance rows were already green; one real BigInt-binary
## export-boundary bug found and fixed, three related gaps found and scoped
## out with precise repros)

Repro-first (per the task's own brief): every acceptance-criteria row named
up front (decl-hop STRING `+`, decl-hop BigInt unary through hops, composed/
container-storage rows) was **already JS-correct at HEAD** (56daaf22) —
`toNumF64`/`toStrI64`'s generic fallbacks already special-case the UNDEF_NAN
sentinel internally, the same "generic path already correct, just not
WAT-optimized" finding every prior slice made, extended further than
previously verified (Math.abs, comparisons, typeof, template literals,
composed-expression-one-hop-past-a-decl — all confirmed via direct repro,
not assumed).

**Landed**: (1) `toNumF64`'s NUMBER-census gate (ir.js) now also fires when
`valTypeOf` is null but `censusMaybeUndefinedKind` proves NUMBER — reuses
`coerceNullishToNum` verbatim, value-neutral, real codegen win (skips the
generic `__to_num` call for this shape). (2) Binary `+` on two present-key
BigInt census operands, NEITHER side separately provable (`let x=m.get(a);
let y=m.get(b); return x+y`) — genuinely wrong at HEAD (`4e-323`, not `8n`),
two stacked causes both fixed: emit.js's new `bothBigIntOperands(a,b)` (AND,
never OR — an OR would silently corrupt the mixed-kind KNOWN-FAIL class §14
point 4 already names) routes the WASM computation through the real i64
`bigIntOperand` machinery; kind.js's `VT['+']` both-census upgrade +
`censusBigintSentinelKind`'s new kind-4 arm teach the SAME fact to the
export-boundary decode (compile/index.js `_resultNumeric`/
`_resultBigintSentinel`), which needed it independently — the i64 math being
correct wasn't enough on its own, confirmed by direct repro before assuming
the fix was complete.

**Found live, explicitly scoped OUT (not this design's charter), each
pinned as a dedicated KNOWN-FAIL with a precise repro**: (a) `-`/`*`/`/`/`%`/
bitwise siblings of the `+` fix — the WASM computation came out correct too,
but the export-boundary decode stays broken because `valTypeOfWithLocals`
(kind.js) has a "SOUND +" no-optimistic-claim rule for `+` ONLY, not its
siblings — verified PRE-EXISTING and GENERAL (a plain `(a,b)=>a-b` with two
real non-census BigInt params already misdecodes at HEAD, unrelated to
census/presentVal entirely) — reverted `bothBigIntOperands`'s use at those 9
sites back to the original gate (byte-identical, unregressed) rather than
ship a representationally-complete-but-not-live half-fix. (b) A param-hop
sibling: `presentVal` has no producer for PARAMS (§15's own explicit scope
line) — `const g=(v)=>-v; g(m.get('a'))` (present-key BigInt) still
corrupts, confirmed live, owned by the param/return/closure `presentVal`
propagation slice §15 already named as separate future work. (c) The
`toStrI64` STRING-census widening needs a NEW "undefined" string-constant
mechanism (MAX_SSO=6 can't hold it; ir.js's NO-EMIT contract blocks reusing
module/string.js's literal emitter) — a genuinely separate undertaking, not
a gate widening, not attempted.

`nullableOperand`/`bigIntOperand`/`bigIntUnary` needed NO widening — found,
not assumed: all three already call the census predicate unconditionally,
never gated on `valTypeOf` first (only `toNumF64`'s NUMBER arm and
`toStrI64`'s STRING-identity-bypass arm actually had the `vt`-first gate).

**Gates**: full 88-file battery, foreground chunks of 7, every chunk green
(no failures anywhere — pre-existing skips unchanged); dyn-keys.js 44/44
(130 assertions) both legs (native + `JZ_TEST_TARGET=jz.wasm`), byte-for-
byte identical; perf-ratchet 10/10 at +0 every category; kernel-parity
33/33 byte-identical; kernel-oracle 11/11; selfhost.js 21/21; fuzz 2000×4
(seeds 1-8000, four foreground runs) zero divergence; size sweep geomean
1.055× unchanged; fresh build ×2 byte-identical (sha256-verified).

Full detail: .work/represented-maybe-undefined-design.md §16.

## Status (2026-08-04, represented-maybe-undefined Slice 6 landed — "begin
## the presentVal opt-in model", .work/represented-maybe-undefined-design.md
## §14/§15, audit-#10's re-enablement path)

§14's first slice: a new `presentVal` REP field (reps.js) — the census's
claimed KIND, separate from `val` (which stays exact-only, permanently, per
§14's own core invariant) — with a decl/reassign-only producer
(analyze.js, mirroring `mayBeUndefined`'s own Slice 1 scope) and its own
poison-disciplined tracker (a SECOND `makeValTracker` instance, NOT a
boolean spread-merge — a kind claim must poison on write disagreement the
way `val` itself does, unlike `mayBeUndefined`'s safe-to-stay-true
monotonicity).

**A real regression found and fixed before landing** (full detail: design
doc §15): the first draft made kind.js `censusMaybeUndefinedKind`'s
bare-name arm consult ONLY `presentVal`, reasoning `val` could never
co-occur with `mayBeUndefined` for the same binding — true for a decl/
reassign LOCAL, false for a PARAM (whose `val` comes from narrow.js's
entirely separate call-site fixpoint, independent of census provenance).
Regressed test/dyn-keys.js's out-of-bounds-array-read param-hop pin
(`NaN` → wrong `undefined`), caught by the gate, bisected to the exact
line. Fixed: `presentVal` checked first, `val` kept as a fallback — both
now live for their own distinct binding shapes.

**A genuine, live value-correctness win, not just a representationally-
complete inert slice** (unlike Slices 1-4): Slice 5's export-lane sentinel
machinery (`censusBigintSentinelKind`) already calls
`censusMaybeUndefinedKind` directly, so fixing the bare-name arm makes it
reachable one hop past Slice 5's own repro 5. `let x = m.get(k); return x`
for a present-key BIGINT census read — previously `2.5e-323` (repro 5's
exact wrong bit pattern, one decl-hop out), confirmed via a direct stash
diff — now correctly returns `5n`. Unary siblings and the dict receiver
share the fix; the mixed-kind-Map carve-out (Slice 5's own documented gap)
correctly stays unfixed through the decl-hop too (negative control pinned).

**Honest boundary**: the ~5-8 arithmetic/coercion/identity chokepoints
(ir.js toNumF64/toStrI64, emit.js nullableOperand/bigIntOperand/
bigIntUnary) still gate on `valTypeOf(node)` FIRST and never see a
decl-hop local's census claim (permanently null by §14 point 3) — widening
those gates is the next slice (comparable surface to `mayBeUndefined`'s own
Slice 2), not attempted here, per the task's own "respect the slicing, do
not improvise it early" instruction. §14 point 4 (joint binary-operand
runtime-domain dispatch, closing the `bigintMixReject` KNOWN-FAIL) remains
untouched, its own separate design.

**Gates**: full battery (`npm test`, single foreground run) 3308/3314 pass,
6 pre-existing skips, 0 fail; dyn-keys.js 40/40 both legs (native +
`JZ_TEST_TARGET=jz.wasm`); inference.js 136/136; types.js 178/178 (was 170,
+8); data.js/math.js/statements.js/json.js/optimizer.js all green at their
documented counts; kernel-parity 33/33 byte-identical; kernel-oracle 11/11;
perf-ratchet 10/10 at +0 every category; selfhost.js 21/21; fuzz 2000×4
(seeds 1-8000) zero divergence; size sweep geomean 1.055× unchanged; fresh
build ×2 byte-identical (sha256-verified).

Full detail: .work/represented-maybe-undefined-design.md §15.

## Status (2026-08-04, audit-#10 Error bundle — four findings closed,
## error-object-design.md's "Brand redesign" section gains a new
## "Finding 1-4 (audit-#10)" entry — see below)

Four findings from audit-#10 (three P1, one P0), all closed this session.

**Finding 1 (P0) — Object.assign call-result provenance crash.**
`Object.assign(new TypeError('x'), {message:'y'})` crashed at compile time
(`internal: stdlib '__arr_set_idx_ptr' was requested but never registered`,
module/object.js:535/791 `emitObjectAssignDynamic`). Root cause: `resolveSchema`
(module/object.js) never recognized the literal `new X(...)`/`X(...)`
Error-constructor-call AST shape at the Object.assign TARGET position — only
`isErrorSchemaSource` recognized it at SOURCE position. A BOUND Error name
already worked (`ctx.schema.resolve` sees its declaration-schema binding);
only the un-bound literal-target shape fell through to the broken dynamic
path. Fixed by teaching `resolveSchema` itself the literal shape (returns
the physical `ERR_SCHEMA_PROPS`, `['message','name']` — content-identical
across all 7 classes) — Object.assign now takes its ordinary fixed-schema
fast path, mutating the target's own slots in place and returning the SAME
pointer (real JS semantics: Object.assign returns its target), which also
preserves the schema id / class identity the crash was masking. Mirrored the
identical literal-shape check into `src/kind.js`'s `spreadSchema` (its own
comment already requires it stay in sync with `resolveSchema` for the
OBJECT-vs-HASH decision — found genuinely OUT of sync for this shape before
this fix, a second latent bug the same root cause closes for free).
**Provenance sibling-sweep**: `Object.defineProperty` always compile-errors
(no partial impl, no silent bug). Array receiver-returning methods
(`sort`/`reverse`/`fill`/`copyWithin`) and `Map`/`Set.prototype.set`/`.add`
return the SAME pointer via a tag compare (PTR.ARRAY/MAP/SET), never schema-
dependent — no provenance-loss vector exists for them by construction (only
PTR.OBJECT+schema identity can be lost through re-boxing, and Object.assign
was the only builtin that re-boxes). Verdict: Object.assign was the only
sibling with this root cause.

**Finding 2 (P1) — general ToString(message).** `let o = {}; new
Error(o).message` returned the object itself, not `'[object Object]'` — the
5f8ff012 fix special-cased only the literal `{}` AST shape
(`isClosedObjLiteralNoStringMethod`). Investigated the general path first:
`errorMessageIR` ALREADY routes any non-special-cased message through
`toStrI64` (the same chokepoint `String()`/template literals use) — the
"general invariant is absent" framing undersold what was actually missing.
The REAL gap: `toStrI64`'s generic OBJECT fallback (`__to_str`'s wasm body)
has a genuine, general, PRE-EXISTING bug for any non-Array object — verified
live, `String(o)` for a bound plain object returns `typeof "object"`, not
even a string at all (the raw pointer bits pass through unconverted); this
is error-object-design.md's own already-documented "Consequence" gap,
explicitly out of scope for the Error design. Root-fixed the IN-SCOPE part:
generalized `isClosedObjLiteralNoStringMethod` → `isClosedObjNoStringMethod`
(module/core.js) to ALSO recognize a BOUND name whose OWN declaration schema
is closed (no toString/valueOf, no dyn/out-of-schema writes) — the same
"literal fact → binding fact" generalization Finding 1 applied to
Object.assign. Closes the common case (`let o = {x:1}; new Error(o)` now
correctly `'[object Object]'`). **Residual, KNOWN-FAIL, pre-existing,
Error-unrelated**: a genuinely EMPTY `let o = {}` declaration never gets a
schema id bound at all (src/prepare/index.js's decl-schema binding guards on
`props.length`, excluding the 0-prop case) — fixing that is a general
prepare.js change with self-host-wide blast radius (every `let x = {}` in
every program), well outside this bundle's scope. Pinned, not fixed.

**Finding 3 (P1) — enumerability contradiction, DECIDED.** Object.keys(err)/
JSON.stringify(err) saw the physical `['message','name']` schema (enumerable)
while spread/Object.assign FROM an Error (audit-#9 P0-2's `isErrorSchemaSource`
override) saw `[]` (non-enumerable) — same object, contradictory answers
depending only on which builtin asked. DECIDED (b) documented divergence over
(a) full JS fidelity: Error is an ordinary object on EVERY enumeration
surface — keys/JSON/spread/assign/for-in all see the physical schema,
consistently. Diverges from real JS (whose Error props are non-enumerable
everywhere) but costs ZERO new machinery, and (a)'s alternative — a per-
property enumerability flag threaded through every enumeration site — is
EXACTLY the "enumerated invariant" shape the audit-#9 Brand redesign (this
same file) already spent a session proving costs more than it's worth
("closed not by a more complete enumeration, but by removing the thing that
needs filtering"). Implemented by DELETING `isErrorSchemaSource`/its override
— `sourceSchema` is now a plain alias for `resolveSchema`. Bonus: this also
closed a SECOND latent analyze/emit mismatch (kind.js's `spreadSchema` never
knew about the override at all, so a BOUND Error spread source already
disagreed between analysis and emit before this session — moot now, both
sides agree by construction). test/errors.js's four audit-#9 P0-2
"copies nothing" pins flipped to "copies message,name" (spread — content-
checked) / a matching-schema-target assign (content-checked, since
Object.assign onto an EMPTY `{}` target hits a SEPARATE, pre-existing,
general, Error-unrelated bug — Object.assign never GROWS a target's schema
with new source keys, confirmed with a non-Error repro `Object.assign({},
{a:1})` → `[]` in jz vs `['a']` in JS; pinned KNOWN-FAIL, flagged not fixed).
README's `.work/error-object-design.md` gains this session's own section
recording the call; README.md unaffected (never described the old
enumerability split in the first place).

**Finding 4 (P1) — returned Errors at the host boundary.** A RETURNED (not
thrown) `new TypeError('x')` decoded via `mem.read`'s generic OBJECT case to
a plain `{message,name}` object — never `instanceof Error` — because the
Error-class-sid upgrade (`mem.errorSidToClass`, the 'jz:errcls' custom
section) only ever ran inside `decodeThrown`, reached exclusively by an
ESCAPING THROW. Fixed by extracting the identical sid→class lookup into a
shared `errorSidClassOf` (interop.js), consumed by BOTH `decodeThrown`
(unchanged behavior, refactored to call the shared helper) and a new
`readRet`, wired into both heap-module export wrappers' `finishRet` call and
the async promise-settle path (`readSettled`) — a returned OR resolved Error
now upgrades to the real host class, minus `.cause`/`.thrown` (no exception
to attach a cause to on a plain return). Pinned: literal, bound, and base-
class returns; async REJECT (unaffected, already worked, traps through the
exceptions tag not `__p_value`) confirmed still green. **Residual, KNOWN-
FAIL, pre-existing, general, NOT Error-specific** (found live extending
Finding 4's own async coverage): an async function that RESOLVES (not
throws) with ANY heap value — an Error, or an ordinary plain object — never
correctly reaches host decode at all, independent of this fix: a concise-
arrow body silently resolves `undefined` (value lost, no error), a block
body traps inside the wasm promise-value machinery itself ("memory access
out of bounds" / "table index is out of bounds" depending on shape) BEFORE
JS-side decode is ever reached. Confirmed general with a non-Error repro.
The async/generator promise runtime was apparently never exercised with a
heap return value, only numbers/strings/booleans — out of scope for the
Error host-decode bundle (the bug is in async's own runtime, not
interop.js's decode). README.md's "Internal errors stay numeric codes..."
bullet updated: made the thrown-vs-returned distinction explicit ("thrown
*or* simply `return`ed... both decode to the real host class") and added the
async-resolve caveat inline.

**Files touched**: module/object.js (`resolveSchema` literal-shape branch,
`sourceSchema`/`isErrorSchemaSource` deletion), src/kind.js (`spreadSchema`
mirror), module/core.js (`isClosedObjNoStringMethod` generalization),
interop.js (`errorSidClassOf`/`readRet` extraction + wiring, `decodeThrown`
refactored onto the shared helper), test/errors.js (new/flipped pins +
4 new KNOWN-FAIL pins for the residuals above), test/dyn-keys.js (Finding 1's
KNOWN-FAIL flipped green), README.md (host-boundary claim), error-object-
design.md (this section).

**Gates, all green**: repros red→green natively confirmed before each fix;
full 88-file battery in 15 chunks of ≤6 foreground, zero failures beyond
pre-existing skips; kernel-parity 33/33 byte-identical; kernel-oracle 11/11
(451 assertions); perf-ratchet 10/10 at +0 every category; optimizer 319
assertions clean; errors.js BOTH modes (native 133/133, kernel-leg 133/133
— required a fresh `npm run build`, the two new-session pins initially
kernel-mismatched only because dist/ was stale, not a real bug); dyn-keys.js
38/38 both legs; minimal-output.js clean (error-free module unaffected,
confirmed via the pre-existing pinned probe); selfhost.js 21/21 (206
assertions); fuzz 2000×4 (seeds 1-8000, all 4 rounds) zero divergence; fresh
`build-dist.mjs` ×2 byte-identical (jz.js/jz.wasm/interop.js, sha-equal);
size sweep (error-free module unaffected per minimal-output; error-using
module ~22.3KB at O2, includes the Error/instanceof/toStrI64 machinery,
gated — never paid by a program that doesn't construct one).

## Status (2026-08-04, audit #10 — Slice 4's VT re-enablement REVERTED,
## .work/represented-maybe-undefined-design.md §14, opt-in `presentVal` is
## the new re-enablement gate — supersedes §5)

Audit #10's prescribed immediate safe move: Slice 4 (3782a692) wired
`dictValueKindOf`/`mapValueKindOf` into VT['[]']/VT['.']/VT['()'] — a
dict/Map read's static `valTypeOf` became the census's claimed kind
GLOBALLY, at every VT call site simultaneously, opt-OUT instead of opt-in.
Live consequences confirmed by the auditor at 3782a692, re-verified live at
HEAD (3344fc11) this session before reverting: composed expressions
(ternary/`&&`/`\|\|`/comma around a census read), container storage
(array-literal/object-literal wrapping one), kind-specific dispatch
(`Array.isArray` wrongly TRUE on an absent key), String `+` inversion
("undefined1" instead of NaN), BigInt joint dispatch (unaffected either way,
already a separate pre-existing KNOWN-FAIL). Reverted this session; full
detail and the revised re-enablement gate: design doc §14.

**Reverted**: VT['[]']/VT['.']/VT['()']'s consultation of `dictValueKindOf`/
`mapValueKindOf` (kind.js) — back to Slice-1-era shape, those two helpers
`censusMaybeUndefinedKind`-only again. **Kept** (verified sound-but-inert
with VT dormant, not VT-dependent-only): `nullableOperand`'s bare-name
fall-through fix (emit.js), `callResultMayBeUndefinedKind` (kind.js) +
its `coerceNullishToNum` duplication-safety hoist (ir.js) — both provably
unreachable-to-wrong since their own preconditions require the reverted VT
promotion to ever fire. **Kept unconditionally** (3344fc11's Slice 5 export-
lane mechanism, explicitly designed VT-independent): `censusBigintSentinelKind`,
`_resultBigintSentinel`, the `jz:i64exp` `s` marker, interop.js's
`decodeBigintSentinel`, emitNeg/`~`'s census OR-arm.

**A gap in Slice 5's OWN VT-independence claim, found closing this revert**
(new, not previously known): `_resultNumeric`'s boundary-wrap decision
(compile/index.js) and the base `VT['u-']`/`VT['~']` table entries (kind.js)
had only ever resolved a present-key census-BIGINT unary correctly because
Slice 4's VT wiring made `valTypeOf(m.get(k))` itself prove BIGINT — reverting
Slice 4 regressed `-m.get('x')` (present key) from `-5n` back to `NaN`, and
`-m.get('x') === -5n` from `true` back to `false`. Fixed the same way as
emitNeg/`~`'s own OR-arm: `_resultNumeric` now also requires
`censusBigintSentinelKind(e) === 0`; `VT['u-']`/`VT['~']` gained a
`censusMaybeUndefinedKind`-direct OR-arm (`censusBigintUnaryVT`, kind.js),
scoped to exactly the single-operand `u-`/`~` shape so the general binary
`-`/`*`/etc. and `++`/`--`/`**`/`>>>`/`u+` (no sentinel lane covers those)
are untouched. Both VT-independent by the same construction as everything
else in this family. dyn-keys.js's Slice 5 pins (38/38, 109 assertions,
native + kernel leg) re-verified green with this fix in place.

**Full audit-#10 battery, re-verified with the census dormant** (every case
primed with a same-kind write before the absent-key read — full table in
design doc §14): composed expressions, container storage, `Array.isArray`,
and String `+` all flip to JS-correct via the generic dynamic path — no new
mechanism, "the generic path already handles it" confirmed once more.
KNOWN-FAIL, unaffected either direction, pinned precisely: five kind-specific
member-access cases (`.length`/call/`.slice()`/`.toFixed()` on a genuinely-
undefined census value trap or dispatch-error instead of throwing TypeError —
pre-existing, independent of census on/off, named "future work" by the
audit itself), the BigInt-joint `+` mix (pre-existing, §12/§13's own
citation), and a NEW find — `Object.assign(new TypeError(x), {message:y})`
crashes at compile time (module/object.js:535, `ctx.core.emit['Object.assign']`,
internal `__arr_set_idx_ptr` stdlib-pull error) — unrelated to census/VT
entirely, Error-bundle agent's scope, not fixed here.

**Pins updated**: test/inference.js's two "Slice 4 positive win" WAT-codegen
pins reverted to their audit-#9-era "RENAMED, no longer distinguishes the
consumer" shape (both dict and Map siblings). Every JS-VALUE "Slice 4"
correctness pin in dyn-keys.js stays green unchanged (generic path always
sufficient for value correctness — only the WAT-shape optimization was
VT-dependent). Nine new pins added for the audit-#10 battery + Object.assign
KNOWN-FAIL + the two present-key-unary regression pins this session's own
gap fix required.

**Gates** (fresh dist rebuild, ×2 byte-identical — sha256-verified,
dist/jz.js + dist/jz.wasm + dist/interop.js): full 88-file battery, 12
foreground chunks of 7 (no failures, a handful of pre-existing `# skip`
rows unrelated to this change); kernel-parity 33/33 byte-identical;
kernel-oracle 11/11 (451 assertions); perf-ratchet 10/10 at +0 EVERY
category (the census-driven codegen wins are gone, matching every prior
disable's own finding — no new cost either); optimizer.js 214/214 (3949
assertions); dyn-keys.js 38/38 (109 assertions, native AND kernel leg);
data.js/types.js/math.js/json.js run explicitly (native + kernel leg where
kernel-includable) and inference.js explicitly (native, 136/136 — kernel
leg's `inference` exclusion is the SAME pre-existing module-resolver-class
debt test/index.js already documents, ctx-introspection tests the kernel
target's host boundary can't run through, unrelated to this session);
selfhost.js 21/21 (206 assertions); fuzz 2000×4 (seeds 1-8000, all 4 rounds)
zero divergence; size sweep geomean 1.055× unchanged (`dict`'s own sized
case back to 1.3 kB, the pre-Slice-4 figure, confirming the win vanished
cleanly with no residue).

Full detail: .work/represented-maybe-undefined-design.md §14.

## Status (2026-08-04, represented-maybe-undefined Slice 5 LANDED — BigInt
## export-lane class closed, .work/represented-maybe-undefined-design.md §13,
## the LAST named value-wrong family from the audit campaign)

Landed Slice 5: `presentKindUnboxed` (§2/§6) closed with a LANE/KIND-
INFORMATION fix, not a representation change — the raw-i64-BigInt-carrier
doctrine stays as-is. New `jz:i64exp` result marker `s` (sentinel kind: 1 =
bare dict/Map read or call-result, sentinel=UNDEF_NAN→`undefined`; 2 = unary
`-`, sentinel=NaN's bits→`NaN`; 3 = unary `~`, sentinel=`-1`'s bits→`-1`),
sourced from new `censusBigintSentinelKind` (kind.js, built on
`censusMaybeUndefinedKind` directly — no VT dependency). interop.js's new
`decodeBigintSentinel` recognizes the sentinel's exact bit pattern instead of
taking the generic NaN-box/number decode, which used to misread a small
BigInt's raw bits as a subnormal float (`2.5e-323`, repro 5).

**Two deeper pre-existing miscompiles found and fixed en route** (both
independent of the export lane — the census-BIGINT return tail needed
correct WASM signature/codegen before any export marker mattered):
1. `valTypeOfWithLocals`'s unary family (`u- ~ ++ --`, kind.js) fell through
   to `numericUnaryVT`'s optimistic-NUMBER default on an UNRESOLVED operand —
   same gap the pre-existing SOUND-`+` fix closed for `+`, never extended to
   unary. `export let f = () => -m.get('x')` claimed `func.valResult =
   VAL.NUMBER` and skipped i64 wrapping entirely. Fixed: unresolved → null,
   not the optimistic default.
2. type.js `exprType`'s Phase-E i32-result narrowing had the identical gap
   for the bitwise family (`~ & | ^ << >>`) — an unresolved operand still
   defaulted to `'i32'`, corrupting `~m.get('x')`'s export signature
   outright (host got `0`). Fixed with a `censusShapedNode` guard keeping
   the safe `'f64'` default for that ambiguous case only.
3. A third gap (dict's census resolves EARLIER than Map's — a whole-program
   pre-scan half in program-facts.js vs Map's per-function-only): a
   dict-sourced census read could settle `func.valResult = VAL.BIGINT`
   WITHOUT its `valResultMayBeUndefined` companion (`exprMayBeUndefinedIn`
   doesn't peel through unary wrapping). Fixed by computing
   `_resultBigintSentinel` UNCONDITIONALLY and giving it priority over
   `resultBool`/`resultBigint` in `synthesizeBoundaryWrappers` — this also
   fixed a previously-UNPINNED, genuinely pre-existing bug (bare dict
   absent-key read, confirmed broken at HEAD via a stash diff), now pinned.

**VT-Slice-4-revert independence** (explicit design goal this session):
`censusBigintSentinelKind`/`censusMaybeUndefinedKind` call
`dictValueKindOf`/`mapValueKindOf` directly, never through VT/`valTypeOf` —
independent of VT['[]']/['.']/['()']'s Slice-4 exact-kind promotion since
those helpers' Slice-1 (79082fb2) restoration. Repro 5 (bare read) and the
dict-early-resolution fix survive a Slice-4 revert unchanged. The one
VT-dependent link is PRE-EXISTING, non-Slice-5 code: emitNeg/`~`'s own
activation gate (audit-#8 P0-4, predates this task) originally read only
`valTypeOf(a) === VAL.BIGINT`. Hardened proactively: both now gate on
`valTypeOf(a) === VAL.BIGINT || censusMaybeUndefinedKind(a) === VAL.BIGINT`
(emit.js) so the unary present-key fix also survives the coming revert.

**Flipped-pin table** (test/dyn-keys.js, before → after, JS-correct target):
- repro 5 (`m.get('x')`, x→5n): `2.5e-323` → `5n` ✓ (host, native+kernel)
- `-m.get('x')` (present): `NaN` → `-5n` ✓
- `~m.get('x')` (present): `0` → `-6n` ✓
- dict sibling (`-d[k1]`/`~d[k1]`, present): `NaN`/`0` → `-5n`/`-6n` ✓
- dict bare absent (`d[k2]`, unpinned pre-existing bug): garbage bigint →
  `undefined` ✓ (found+fixed as a side effect, newly pinned)
- absent-key cases (`-m.get('missing')`→NaN, `~m.get('missing')`→-1,
  strict-eq comparisons): unchanged, already correct pre-Slice-5.

**Negative controls**: mixed-kind Map (`5n`+`6`) — census returns null, no
exact lane, `m.get('a')` STAYS `2.5e-323` (honestly pinned, unfixed,
documented); statically-proven BigInt export (`()=>5n`, `()=>-5n`) —
byte-identical, untouched, structural pin against over-firing.

**Out-of-scope, found live, NOT fixed** (external audit #10): present-key
census-BIGINT `+` NUMBER (`m.get('x') + 1`) silently produces garbage
NUMBER instead of JS's TypeError — confirmed via HEAD stash diff to be
byte-for-byte PRE-EXISTING, unaffected by this slice (entirely in-wasm,
`bigintMixReject`'s own documented narrower-proof policy, not an
export-boundary issue). Needs joint runtime-domain dispatch at the binary-op
site — separate, larger design. Pinned as a new KNOWN-FAIL.

**Carrier-doctrine boundary excluded, by design** (matches every prior
slice's own scope): the sentinel-bit comparison has the same single-point
collision risk every atom-vs-raw-bigint interaction already tolerates in
this codebase (a BigInt whose value is EXACTLY the reserved sentinel's bit
pattern misdecodes) — astronomically unlikely, not newly introduced, not
fixed (would need the full `bigintBoxed` producer/consumer wiring, §6's
"alternate closure", out of scope here as for every prior slice).

**Gates** (fresh dist rebuild): full 88-file battery in 15 foreground chunks
≤6 — 0 failures; dyn-keys.js 32/32 (91 assertions) BOTH native and kernel
leg (`JZ_TEST_TARGET=jz.wasm`, genuinely routed via `compileViaKernel`);
kernel-parity 33/33 byte-identical; kernel-oracle 11/11; perf-ratchet 10/10
at +0 every category; optimizer.js 214/214; data.js/statements.js run
explicitly (541/541 assertions in that chunk); selfhost.js 21/21; fuzz
2000×4 (seeds 1-8000) zero divergence; size sweep geomean 1.055× unchanged;
fresh build ×2 byte-identical (jz.js/jz.wasm/interop.js, sha256-verified).

Full detail: .work/represented-maybe-undefined-design.md §13.

## Status (2026-08-04, represented-maybe-undefined Slice 4 LANDED — VT
## re-enablement, .work/represented-maybe-undefined-design.md §8 point 4, §5
## criteria all met)

Landed Slice 4: kind.js's `dictValueKindOf`/`mapValueKindOf` — restored as
internal helpers by Slice 1 (79082fb2), never wired back into VT — are now
wired directly into VT['[]']/VT['.']/VT['()']'s `.get` short-circuit. A
dict/Map read's static kind is once again the census's exact claim, protected
by the `mayBeUndefined` join Slices 1-3 built for exactly this moment.

**§5 RE-ENABLEMENT CRITERIA — per-criterion verdicts:**
1. Representation propagates (decl/reassign/param/return/closure) — MET,
   verified live pre-existing (Slices 1-2, 79082fb2/15c789ac).
2. Every chokepoint consults the REP field (ir.js toNumF64/toStrI64, emit.js
   nullableOperand/bigIntOperand/bigIntUnary/bigintMixReject/`+`-concat,
   module/string.js/number.js/console.js) — MET, pre-existing (Slice 3,
   756ae10f-era) PLUS two NEW gaps found and closed THIS session (below).
3. dyn-keys.js's audit-P0 + audit-#9 pins assert JS-correct values with the
   census LIVE — MET: full matrix re-verified below, all green or
   documented KNOWN-FAIL with an updated, re-traced root cause.
4. Full battery + kernel-parity/oracle + perf-ratchet + fuzz all green, cost
   justified if nonzero — MET: perf-ratchet 10/10 at +0 every category, size
   sweep geomean UNCHANGED at 1.055× (the `dict` sized case itself:
   jz=1313B/jz_wasmopt=1249B, byte-identical to the pre-disable figure cited
   in the audit-#9 ledger entry) — zero cost, matching Slice 1-3's own
   "dormant costs nothing, re-enabling costs nothing measured" finding.

**TWO NEW GAPS FOUND LIVE while walking §5 criterion 3's own instruction**
("confirm each site's guard composes correctly with a LIVE census kind +
mayBeUndefined=true") — repro-first, neither assumed from the design doc:

1. **`nullableOperand`'s bare-name branch (emit.js) never consulted
   `mayBeUndefined`.** `if (typeof n === 'string') return
   !!(repOf(n)?.nullable || repOfGlobal(n)?.nullable)` early-returned BEFORE
   the function's own bottom `censusMaybeUndefined(n)` check — so a decl-hop
   identity compare (`let x = m.get(missing); x === undefined`) would have
   const-folded wrongly the moment VT made `x`'s `val` non-null. EMPIRICALLY
   this never fired in practice for a plain decl/param-hop (the PRE-EXISTING,
   much broader `mayBeNullish` fail-closed heuristic — "calls/member reads:
   missable" — already marks the SAME binding `.nullable = true`
   independently, for a totally unrelated reason, coincidentally covering
   this exact shape) — but it is the wrong mechanism to rely on (a different
   field, could stop covering this shape under an unrelated future change)
   and the design's own criterion 3 explicitly asks for correct composition,
   not accidental coverage. Fixed: fall through to `censusMaybeUndefined(n)`
   for a bare name instead of early-returning.

2. **A call to a non-inlined user function whose return traces to a census
   read had NO consumer for `func.valResultMayBeUndefined`/
   `ctx.closure.valResultMayBeUndefined`** — Slice 2 (15c789ac) SET these
   fields but `ctx.inspect` was their only reader (compile/index.js :347,
   reps.js's own doc comment already named this gap). Repro'd live:
   `const g = (k) => { ...; return m.get(k) }; g(k) === undefined`
   const-folded to the SAME wrong boolean for present AND absent keys
   (kind-traits.js `calleeValType` trusts `f.valResult` unconditionally, no
   mayBeUndefined companion ever asked) — and the arithmetic sibling,
   `g(k) + 1`, silently returned JS `undefined` instead of `NaN`. `g` must be
   non-trivial (a loop, 2+ statements) — a single-expression arrow inlines
   away before either check runs, which is why the multi-hop test below
   didn't catch this on its own. Fixed: kind.js gains
   `callResultMayBeUndefinedKind(node)` (mirrors `calleeValType`'s own two
   lookup paths — `ctx.func.directClosures`+`ctx.closure.valResult(MayBe
   Undefined)` for a direct closure, `ctx.func.map` for a plain named
   function), wired into `censusMaybeUndefinedKind`'s dispatch as a 4th arm.

**A SOUNDNESS REGRESSION found and fixed while landing gap #2, before it
ever reached a commit**: `ir.js`'s `coerceNullishToNum` — consulted by
`toNumF64` whenever `censusMaybeUndefined(node)` is true — is documented as
requiring its input be side-effect-free ("it is duplicated, so each
occurrence gets a fresh clone"), true for the ORIGINAL two arms (a dict/Map
read, a bare-name local read — both pure) but NOT true for the new
call-result arm: an arbitrary function call can have real side effects.
Caught by a REAL optimizer.js regression (`promoteIntArrayLiterals:
closure-capture disqualifies` — `main(0)` returned 30 instead of 20) during
the routine full-battery run, traced to a captured-mutation counter
(`count = count + 1` inside a callee whose return flowed through `+`) firing
THREE TIMES instead of once — `coerceNullishToNum`'s `cloneIR` triplicating
the call itself. Fixed at the `ir.js` call site (not `coerceNullishToNum`
globally, to keep the fix's blast radius to the new arm only, byte-identical
for the two original arms): hoist into a temp local FIRST whenever the node
is a call that isn't the direct dict/Map `censusShapedNode` shape, so
`cloneIR` only triplicates a cheap `local.get`. Every OTHER chokepoint that
consults `censusMaybeUndefined`/`censusMaybeUndefinedKind` was individually
verified NOT to have this risk (bigIntOperand/bigIntUnary already hoist into
a temp before their own duplication; module/string.js String(), module/
number.js isNaN, module/console.js writePart, emit.js bigintMixReject/`+`-
concat all evaluate the node's emission exactly once regardless of which
arm matched) — confirmed by a live side-effect-counting repro for each,
not by inspection alone.

**FULL AUDIT MATRIX (native leg; kernel leg identical per kernel-parity/
kernel-oracle below) — case × verdict:**
- audit-#7 P0 pair (absent-key arith/String `m.get('b')+1`→NaN,
  `String(m.get('b'))`→'undefined'; alias-write `const alias=m;
  alias.set('k','oops1')`→NaN via `-0`) — GREEN, live via the census.
- audit-#8 P0-2 captured-mutation (Map/dict write captured in a nested
  `.forEach` callback) — GREEN.
- audit-#9 table: decl-hop (`let x=m.get(k); x-1`) GREEN; STRING-census
  concat (`+` on a STRING-census absent key → "undefined" not the raw NaN
  value) GREEN; BigInt absent `+1` (NaN not compile error) GREEN;
  double-absent BigInt (`m.get(a)+m.get(b)`, both missing → throws, the
  documented narrower-but-safe divergence from JS's `NaN`, unchanged by this
  slice) GREEN (regression-pinned, not flipped); param-hop (the cfd06d85
  fix) GREEN; capture-hop GREEN.
- isNaN family over live census (2ea95034 pins) — GREEN, side-effect-safety
  re-verified live (§ above).
- POSITIVE WINS: non-escaping numeric dict/Map read in arithmetic drops the
  `+` STRING-concat fallback arm entirely (reconstructed structural pin,
  test/inference.js — the ORIGINAL 1db8e55e/2b62b91b "consumer wiring" pins
  turned out to never have exercised the consumer at all, see their own
  updated comments); an ESCAPING receiver (nameEscapes gate) correctly keeps
  the fallback arm — negative control in the same pin. Captured-numeric-write
  win (e79b0647's class) verified still correct, no fast-path regression.
- Present-key BigInt through the census (7288b69b KNOWN-FAILs): unary `-`/`~`
  RE-VERIFIED LIVE, value changed (was `-5`/`-6` via the old generic-NUMBER
  misdecode, now `NaN`/`0` via a NEW mechanism — bigIntUnary's runtime
  select/isUndef branch correctly computes the true negated/complemented i64
  internally, confirmed by direct sub-expression isolation, but the result
  crosses the export boundary through the SAME `resultDynamic` f64-reinterpret
  lane repro 5 already named — a negated/complemented small BigInt's raw i64
  bits frequently fall in the NaN-shaped exponent range, and the boundary's
  NaN-canonicalization collapses the true payload). STAYS KNOWN-FAIL, values
  updated, root cause re-traced to §6's presentKindUnboxed family (not fixed
  — Slice 5, un-landed). The STRICT-EQUALITY siblings (`-m.get('x')===-5n`)
  FLIP TO CORRECT (`false`→`true`): both sides statically prove BIGINT, so
  emitStrictEq takes the REF_EQ_KINDS raw i64-bit-compare path, never
  touching the broken export lane — genuinely fixed, not a coincidence.
  Export misdecode (repro 5 itself, `m.get('x')` alone) — unchanged,
  confirmed still `2.5e-323` not `5n`, out of scope (§6, needs
  presentKindUnboxed or the bigintBoxed producer-wiring fix, neither landed).
- bigintMixReject's own KNOWN NARROWER GAP (documented pre-existing, its own
  comment cites it): `g(k) + 5` where `g`'s result is genuinely `undefined`
  and BIGINT-census-claimed now THROWS instead of JS's `NaN`, reachable for
  the first time through the call-result arm (previously only reachable via
  a direct dict/Map read, same throw, same gap — see probe in this session's
  working notes). NOT a new bug, NOT fixed here — the runtime
  `bigIntOperand` throw only checks "is THIS operand a maybeUndefined-BIGINT
  claim", not "did the OTHER operand's runtime type actually mismatch",
  exactly as its own doc comment already names ("moves an unsound VALUE to
  a sound-but-wider THROW, never a wrong number" — an accepted tradeoff).

**GATES (fresh dist rebuild, foreground throughout):** full 88-file battery
run in 15 foreground chunks of ≤6 files — 0 failures (one transient found
DURING this session — optimizer.js's closure-capture regression above — was
root-caused and fixed before the final battery run, not carried forward);
dyn-keys.js 27/27 (78 assertions, incl. 2 new hop-shape pins + 2 new
call-result pins + 1 soundness-regression pin, present-key BigInt pins
re-verified with updated values); inference.js 136/136 (299 assertions,
incl. 2 reconstructed positive-win pins with escape-gate negative controls);
types.js 170/170; optimizer.js 214/214; kernel-parity 33/33 byte-identical
(O0/O2/O3, post-rebuild); kernel-oracle green; perf-ratchet 10/10 at +0
delta every category; selfhost.js 21/21 (206 assertions); fuzz 2000×4 (seeds
1..2000, opt {0,1,2,3}, 30173 inputs compared each run) — zero divergence
across all 4 runs; size sweep geomean jz/AS = 1.055× (unchanged from 1.0550
baseline); fresh `npm run build` ×2 — dist/jz.js, dist/jz.wasm,
dist/interop.js SHA-256 byte-identical both rounds.

Commit: local only (not pushed).

## Status (2026-08-04, optimizer guard-elimination soundness bug FIXED — the
## "param-hop `+` miscompile" pinned at 05729912, root-caused past bisect,
## sibling class swept)

Fixed the KNOWN-FAIL banked at 05729912 (test/dyn-keys.js): `const g = (v) =>
v + 1; export let f = (k) => g(m.get(k))` on an absent Map key returned
`undefined` instead of JS's `NaN`.

BISECT: reproduced both sides (optimize:false correct — emit.js's `+`
handler emits the safe runtime-dispatch form, `__is_str_key` guard + NaN
self-compare atom ladder, byte-for-byte verified; default wrong — the
guard is gone, collapsed to a bare `f64.add`). Per-pass sweep of every
PASS_NAMES entry against `{level:2, watr:false}` (isolating jz's own
passes from watr's tail) still reproduced the bug with EVERY individual
pass turned off except one: `vectorizeLaneLocal`. NOT a watr-package bug.

ROOT CAUSE: `foldStrDispatchF64` (src/optimize/index.js, run whenever
`cfg.vectorizeLaneLocal` is on — default from level 2) treats any
`(param $x f64)` as "provably never a string/atom NaN-box" and, on that
claim, deletes BOTH the `__is_str_key` string-dispatch guard AND (via its
`unwrapGuard` helper) the NaN self-compare atom-decode ladder that
correctly ToNumber-coerces `undefined`/`null`/`true`/`false` carriers. The
premise is false under jz's NaN-boxing ABI: every dynamically-typed value
(string, undefined, null, a bool atom, a boxed object) is carried in an
f64-typed local exactly like a genuine number — "declared f64" proves
NOTHING about a param's runtime domain; it's the ABI's universal carrier
type, not a numeric-only type. The mere presence of this guard shape in
emitted WAT is itself proof jz's own front-end kind system already could
NOT establish NUMBER for that value (emit.js only takes this path when
`vtA == null || vtB == null`) — a later, strictly-less-informed WAT pass
re-deriving "must be numeric" from the bare WASM type is unsound on its
face.

SCOPE LEAK (the actual bug, not just the false premise): the fold's real,
sound use is `pureFuncMap`-driven inline SUBSTITUTION into a per-pixel-
color SIMD lane loop (tryPerPixelColor/liftPPC, src/optimize/vectorize.js)
— there, the substituted argument at the inline site genuinely IS numeric
(a per-lane typed-array read), independent of the callee's own param
declaration. But the fold ran on the REAL, shared, standalone-callable
function object in TWO places: `buildPureFuncMap` (src/wat/assemble.js)
mutated every candidate `fn` in `allFuncs` in place while building the
map, and `optimizeFunc` (src/optimize/index.js) called it AGAIN directly
on `fn` before `vectorizeLaneLocal(fn,…)`, unconditionally, regardless of
whether that function even had a loop to vectorize. Both corrupted the
function's own ordinary (non-inlined) call sites too.

FIX (src/optimize/index.js):
  - `buildPureFuncMap` now deep-clones each candidate (`cloneIR`, a plain
    recursive array clone) BEFORE calling `foldStrDispatchF64`, and stores
    the folded CLONE in `pureFuncMap` — the real `fn` in `allFuncs` (and
    thus the real emitted module) is never mutated.
  - Removed the second, redundant direct `foldStrDispatchF64(fn)` call
    inside `optimizeFunc` (no lane-proven substitution context exists
    there at all — it was folding the callee's bare declaration, the
    identical unsound premise).

CLASS SWEEP (test/dyn-keys.js, same fix covers all — one shared fold/one
shared call-site pair): dict absent-key through the identical param-hop
shape, a two-hop param chain (g→h), the param used inside the callee's
OWN loop (not just a leaf expression), and an out-of-bounds array read —
all wrong before the fix (silently treated as numeric), all JS-correct
(`NaN`) after. Flipped the KNOWN-FAIL to a regression pin; added the
sibling sweep as a second pin.

COLLATERAL (expected, not a regression): test/examples.js's plasma-fbm
test asserted the REAL, standalone `$fbm` function's emitted WAT was
string-dispatch-free — that assertion was pinning the OLD unsound
over-mutation as a feature. Updated: the SIMD lift (397 f64x2, ≥6
`$math.sin2` calls) and bit-exactness vs the scalar path still hold
(the fold still fires on the CLONE `pureFuncMap` uses for inlining); the
real `$fbm` legitimately keeps its guard now, untested (correct, not
checked, since a caller could reach it directly with a non-numeric
value). test/optimizer.js's "select-gate FLAG veto" pin asserted ZERO
`select` anywhere in a function whose EXPORTED `child` param — reachable
by any JS caller with any value — genuinely needs the same live runtime
dispatch; the old fold's over-mutation of the real function was silently
masking that live dispatch, which is exactly this bug's class hiding
inside an unrelated pin. Rescoped the assertion to the function's actual
top-level return node (what the select-gate veto under test governs),
which still holds cleanly; the resurfaced (correct, load-bearing) atom-
ladder selects deeper in the tree are no longer conflated with it.

FUZZ GENERATOR GAP (noted per the task's own prompt): test/fuzz.js's
generators are exclusively Float64Array/Int32Array/Uint8Array-typed —
every generated value is a genuine number by construction. None of the
seven fuzz categories ever route a Map/dict/array-hole `undefined` (or
any other carrier-domain value) through a user-defined helper function
parameter — exactly the "carrier-through-call" shape this bug lived in.
2000×4 found zero divergences, unsurprising: the generator structurally
cannot reach this class. Worth a follow-up generator extension (a
`Map.get`/hole producer feeding a small helper function call) if this
family is to be fuzz-caught rather than hand-found again.

GATES: full 88-file battery, 15 foreground chunks of ≤6 — 0 failures
(one pre-existing WAT-shape pin needed rescoping, see above, not a new
failure); dyn-keys.js 24/24 (68 assertions, incl. the flipped pin + sibling
sweep); examples.js 22/22; optimizer.js 214/214; kernel-parity 33/33
byte-identical; kernel-oracle 11/11 (451 assertions); perf-ratchet 10/10,
every category +0 delta (this fold never fired in the ratchet/size-sweep
kernels — no cost to justify); selfhost.js 21/21; fuzz 2000×4 (seeds
1..2000, opt {0,1,2,3}, 30173 inputs compared) — zero divergence; size
sweep geomean jz/AS = 1.055× (unchanged from the 1.0550 baseline); fresh
`npm run build` ×2 — dist/jz.js, dist/jz.wasm, dist/interop.js byte-
identical (sha256) both rounds, native AND the self-host kernel leg.

Commit: local only (not pushed).

## Status (2026-08-04, represented-maybe-undefined Slice 3 landed —
## chokepoint sweep completion, .work/represented-maybe-undefined-design.md §11)

Landed Slice 3: `bigintMixReject` and the `+` STRING-concat fast path
(emit.js, both the raw-concat branch and its `coercionFree` sibling) now
consult `censusMaybeUndefined` alongside their existing `valTypeOf` checks —
the two gaps §4 named as NEVER covered by the original chokepoint list. A
mayBeUndefined-flagged BIGINT/STRING claim now falls through to the
permissive/coercing default instead of wrongly rejecting a sound mix or
skipping ToString on a value that could be real `undefined`.

REPRO-FIRST FOUND THE TASK BRIEF'S OWN PREMISE WRONG, VERIFIED BEFORE
WRITING CODE: the brief expected decl/param/capture-hop repros to flip
wrong→correct via this slice, without VT re-enablement. Direct trace showed
decl-hop and capture-hop are ALREADY correct at HEAD (census fully dormant
→ every hop takes the generic dynamic path, nothing to falsify) and
`bigintMixReject`/`+`-concat's own targets (`valTypeOf(a) === VAL.BIGINT`/
`VAL.STRING` for a census-shaped node) are structurally unreachable while
VT['[]']/['.']/['()'] stay dormant — same "inert until Slice 4" finding as
Slices 1-2, now confirmed to extend to Slice 3's own two fixes too.

FOUND A REAL, LIVE, OUT-OF-SCOPE BUG WHILE VERIFYING: `const g = (v) => v +
1; g(m.get(missing))` through a genuinely separate (non-inlined) callee
returns `undefined` instead of `NaN`. Root-caused via `optimize:false` vs
default trace: emit.js's `+` handler ALREADY emits the safe runtime-dispatch
form (the `__is_str_key` guard + NaN self-compare atom ladder) — present
byte-for-byte pre-optimize — but the POST-optimize module has that guard
entirely eliminated, collapsed to a bare `f64.add`. This is a miscompile in
the shared WASM-level optimizer (watr's `optimizeFunc` or `src/optimize/
*.js`, not bisected further), NOT a missing REP consultation — independent
of every field this design adds (`optimize:false` alone already fixes it,
zero source changes). Does not reproduce for `-`/other non-`+` operators or
for decl/capture-hop. Out of this slice's mandate (different blast radius —
a shared backend pass, not a chokepoint); pinned as a NEW KNOWN-FAIL in
test/dyn-keys.js (mirrors the file's existing BigInt-unary present-key
KNOWN-FAIL convention) so a future fix flips it instead of silently
regressing. Candidate for a dedicated future audit — this codebase already
tracks the general class ("watr's own optimizer reacts unsoundly" —
outline-pass/localReuse hunts elsewhere in this file); this is a new
instance, not previously pinned at this exact shape.

A drafted toNumF64 fix (mirroring `ctx.func.maybeNullish`'s vt-independent
gate) was NOT landed — proved to be dead code on direct trace: toNumF64's
own bottom-of-function `__to_num` inline fallback already coerces an
unproven value soundly, and `__to_num` capability is structurally always
requested whenever a program can produce a census-shaped value at all.
Verified by reverting the draft and re-running every hop shape — identical
results with or without it.

GATES (fresh dist rebuild): full 88-file battery in 13 foreground chunks of
≤7 — 0 failures; kernel-parity 33/33 byte-identical; kernel-oracle 11/11;
perf-ratchet 10/10 at +0 delta every category; optimizer 214/214; dyn-keys.js/
data.js/types.js/math.js/json.js run explicitly (460/460); selfhost.js 21/21;
fresh build ×2 byte-identical (jz.js/jz.wasm/interop.js); size sweep geomean
1.055× (unchanged from the 1.0550 baseline — the new censusMaybeUndefined
calls only redirect compile-time branch choice, never actually taking the
flagged branch today); fuzz 2000×4 zero divergence.

Slice 4 (VT re-enablement) remains unstarted, gated on design §5's full
criteria — every fact Slices 1-3 built is now representationally complete
AND consumption-wired; Slice 4 is what makes all of it load-bearing at once.

## Status (2026-08-04, represented-maybe-undefined Slice 2 landed —
## whole-program propagation, .work/represented-maybe-undefined-design.md §10)

Landed Slice 2: `mayBeUndefined` now propagates through params, returns, and
closure captures — the same whole-program machinery `nullable`/`bigintBoxed`
already run through (narrow.js's call-site fixpoint, `narrowValResults`,
module/function.js's `ctx.closure.make`). New shared, ctx-independent
predicate in kind.js (`censusShapedNode`/`nameMayBeUndefinedInBody`/
`exprMayBeUndefinedIn`) — needed because every Slice 2 join site runs before
the queried function's own `ctx.func.localReps` is installed, the identical
caveat narrow.js's `bodyNameNullable` already documents for `mayBeNullish`.
Params: fail-closed on a destructured param body (reuses `bigintBoxedVerdict`'s
`isDestructuredParamBody` verbatim), OR-joined across live call sites
otherwise — deliberately NOT built on `mayBeNullish` (too broad; would flag
nearly every param). Returns: `func.valResultMayBeUndefined`
(narrowValResults) + `ctx.closure.valResultMayBeUndefined`
(closureBodyReturnMayBeUndefined, flow-types.js) — parallel Maps, not merged
into `valResult`/`closureBodyReturnKind`'s own return shape (those have a live
consumer, kind-traits.js `calleeValType`, this slice must not disturb).
Captures: `repOf(name)?.mayBeUndefined` joins the existing `envCaptures`/
`captureNullables` loop.

Found and fixed one real bug while landing this: `nameMayBeUndefinedInBody`'s
WeakMap cache threw on a non-array `bodyRoot` (an expression-bodied arrow
`() => x` lowers to a bare-string body in some shapes) — guarded with
`Array.isArray(bodyRoot)`.

HONEST BOUNDARY: still inert (no compiled byte/value changes) for the SAME
program-wide reason as Slice 1 — a census-shaped read's `val` never settles
non-null at ANY hop (decl, call-site arg, return) while VT['[]']/['.']/['()']
stay dormant, verified this slice for the param/return hops too (a census-
shaped call-site arg poisons `hardParamVal`'s fold rather than claiming a
kind; a census-traced bare-name return poisons `bodyFacts.valTypes` the same
way). But TWO of the three join sites don't depend on that `val` chain at all
and ARE directly, observably live: param propagation (`ctx.inspect` sink —
`compile(src,{inspect:true}).inspect.functions[name].params[k]
.mayBeUndefined`) and closure captures (`ctx.closure.bodies[i].mayBeUndefineds`)
both verified against real compiled programs. `closureBodyReturnMayBeUndefined`
is also independently live and provably ORTHOGONAL to `closureBodyReturnKind`
(they resolve bare names through an externally-supplied `capturedKinds` map,
not the body's own value tracker) — pinned directly. `narrowValResults`' own
OR-join is the one site that stays empirically unreachable (the same body
evidence that would prove both conditions is read by two mechanisms that
poison identically) — landed correctly, pinned as a negative control.

GATES (fresh dist rebuild): full 88-file battery in 13 foreground chunks of
≤7, kernel-parity 33/33 byte-identical (re-run post-rebuild), kernel-oracle
11/11, perf-ratchet 10/10 at +0 delta every category, optimizer 214/214,
dyn-keys.js/inference.js/never-grown.js/simd.js run explicitly, selfhost.js
21/21 (pre- and post-rebuild), fresh build ×2 byte-identical (jz.js/jz.wasm/
interop.js), size sweep geomean 1.0550 (unchanged — 49-case `scripts/
bench-size.mjs --json` jz/AS geomean), fuzz 2000×4 (`node test/fuzz.js
--count=2000`, four separate runs) zero divergence.

Slice 3 (chokepoint-sweep gaps) and Slice 4 (VT re-enablement) remain
unstarted, both gated on design §5's full criteria.

## Status (2026-08-04, represented-maybe-undefined Slice 1 landed — REP_FIELDS
## + decl-time producer, .work/represented-maybe-undefined-design.md §8)

Landed Slice 1 of the represented-maybe-undefined build (design banked at
7288b69b): a `mayBeUndefined` REP_FIELDS entry (reps.js), a decl+reassignment
producer (analyze.js `analyzeValTypes` — new `mayBeUndefinedRhs` helper
alongside the existing `nullable`/`mayBeNullish` call sites), and
`censusMaybeUndefinedKind`'s restoration (kind.js): its two ORIGINAL
direct-node arms (dict `[]`/`.` read, Map `.get()` — `dictValueKindOf`/
`mapValueKindOf`/`dictCensusReceiverIsLive` restored verbatim from before the
audit-#9 revert, 7288b69b) plus a NEW third arm answering a bare name whose
rep carries both `mayBeUndefined` and `val`. `dictValueKindOf`/
`mapValueKindOf` are restored as **censusMaybeUndefinedKind-only helpers** —
NOT re-wired into VT['[]']/VT['.']/VT['()']'s own exact-kind fold, which
stays dormant (re-enabling that is design §8 Slice 4, gated on §5's full
criteria — untouched by this slice).

HONEST BOUNDARY (design doc §9 has the full writeup): Slice 1 is
representationally complete but behaviorally INERT — every existing
censusMaybeUndefined consumer (ir.js toNumF64/toStrI64, emit.js
nullableOperand/bigIntOperand/bigIntUnary, module/string.js/number.js/
console.js) gates its own call behind `valTypeOf(node) === VAL.SOMETHING`
FIRST, and `valTypeOf` stays null for a dict/Map read while VT['[]']/['.']/
['()'] stay dormant — so nothing this slice added changes a single compiled
byte or JS-observable value yet (verified: the audit-#9 5-repro table returns
identical values before/after). The acceptance pin moved to test/types.js (a
pure-analysis harness, `runAnalyzeMayBeUndefined`, mirroring that file's own
intCertain-lattice precedent) rather than test/dyn-keys.js's black-box style,
since dyn-keys.js has nothing new to observe yet. Slice 2 (param/return/
closure propagation) deliberately NOT taken in the same pass — it's its own
significant surface (narrow.js's whole-program fixpoint) per the design's own
scoping, not a small extension, and inherits the identical "inert until
Slice 4" property.

GATES (fresh dist rebuild): full 88-file battery in 13 foreground chunks of
≤7, kernel-parity 33/33 byte-identical (O0/O2/O3, re-run post-rebuild),
kernel-oracle 11/11, perf-ratchet 10/10 at +0 delta every category, optimizer
214/214, dyn-keys.js/data.js/inference.js run explicitly (all green, repro
table unchanged), selfhost.js 21/21 (re-run post-rebuild), fresh build ×2
byte-identical (jz.js/jz.wasm/interop.js), size sweep geomean 1.0550
(unchanged from the 1.055 baseline), fuzz 2000×4 (`node test/fuzz.js
--count=2000`) zero divergence.

## Status (2026-08-04, audit-#9 P0-2 closed — Error class branding moved from a
## source-visible schema slot to the schema id itself; two compiler crashes and
## a stolen user property name fixed; audit P1 message-coercion bug folded in)

AUDIT-#9 FINDING: the 8182e465 P0-3 patch (error-object-design.md, "As-landed
corrections") hid Error class identity behind a reserved schema slot
(`__errcls__`) enforced by prepare-time rejection at every dot/literal-key site
plus a matching runtime exclusion in every enumeration/dyn-dispatch consumer —
exactly the "enumerated invariant" failure mode the design doc's own P0-3 entry
warned about ("every object consumer must remember to filter"). It bit twice:
Object.assign/spread over a real Error object crashed the compiler outright
(neither had been taught the slot existed, so resolveSchema saw an "unknown
schema" source and routed into machinery — `__obj_clone`'s single-spread-source
shortcut, the generic dynamic-assign runtime-key loop — that had its OWN
unrelated pre-existing bugs), and `{ __errcls__: 1 }`, a legal plain user
object, was rejected outright. 4 failure groups verified live at HEAD (7288b69b):
1. `Object.assign({}, new TypeError('x'))` → `internal: stdlib
   '__arr_set_idx_ptr' was requested but never registered` (O0/O2/O3).
2. `({...new TypeError('x')})` → `Unknown section func,$__obj_clone,...`
   (watr assembly failure — confirmed this specific crash is NOT Error-
   specific: ANY unknown-schema single-spread source, e.g. `({...param})`,
   hits the same pre-existing `__obj_clone` bug; Error just couldn't reach the
   KNOWN-schema path that avoids it, because resolveSchema didn't recognize
   the constructor-call shape at all).
3. `({ __errcls__: 1 })` — a plain object with that key — rejected at compile
   time ("not a valid object-literal key"), stealing a legal property name.
4. (Audit P1, same ctor-path machinery, folded in here) ES 20.5.1.1 message
   coercion bugs: `new Error(false).message` → `"0"` (JS `"false"` — a raw
   unboxed-bool-carrier miscompile, `coerceRest`'s i32-fast-path treating
   the carrier as a plain integer); `new Error(undefined).message` →
   `"undefined"` (JS `""` — Error's OWN spec clause treats an explicit
   `undefined` argument as "no message", distinct from ordinary
   `ToString(undefined)`); `new Error({}).message` → the raw object value
   (JS `"[object Object]"` — toStrI64's generic OBJECT arm has no
   Object.prototype.toString default-tag fallback, a known pre-existing gap
   for ANY dynamic object per error-object-design.md's own "Consequence"
   section, closed HERE only for the provably-no-method literal-object-
   argument case).

REDESIGN (error-object-design.md updated in place — see its new
"Brand redesign" section superseding §1's `__errcls__` slot and the P0-3
patch): class identity now lives in the pointer's SCHEMA ID, not a slot.
`module/schema.js`'s `ctx.schema.register` gained an optional `salt` param
(default-omitted for every existing caller, so their content-only dedupe key
is byte-identical to before) that forces a distinct id for identical prop
content; `ctx.schema.errorSid(className)` mints/reuses one sid per Error class,
salted by the class name, all 7 sharing the IDENTICAL physical 2-slot layout
`['message','name']` — two perfectly ordinary, fully public/enumerable
properties, nothing reserved. `instanceof` reads the sid (an OR-chain of
masked tag+sid compares over `ctx.features.errorClasses` — a NEW prepare-time
per-class companion to the existing `ctx.features.error` boolean — for the
base 'Error' case; a single compare for a specific class; a specific class
NEVER constructed anywhere folds to compile-time `false`, one level more
precise than the old design's blanket boolean gate); `.name` is just slot 1,
read like any other property — nothing to "derive from the sid" was needed
beyond `ctx.schema.errorClassOf(sid)` for the FEW compile-time-fold call
sites (emitErrorInstanceof's tier-2, interop's decodeThrown).

REJECTED (both already rejected once, by P0-3 itself, same standard re-
applied): a dedicated `PTR.ERROR` heap tag (genuinely unbounded blast radius —
every PTR-tag switch in the codebase); keeping the shared sid + hidden slot but
un-spelling the name harder (doesn't fix the enumerated-invariant disease, just
picks a different bandage — the audit's own directive named this "the fix
must make forgetting impossible", which only a representation-level brand
does). `ctx.schema.register`'s "no per-caller distinct-id mechanism" (P0-3's
own stated blocker) turned out to be ONE optional parameter, not a structural
wall — module/schema.js's own dedupe-by-content-string implementation made
this trivial once actually attempted (the P0-3 investigation apparently didn't
get past reading the docstring).

CONSEQUENCES — dead filtering code DELETED (the enumerated invariant, closed
by construction, not by more enumeration):
- `src/prepare/index.js`: the `.` handler's ERR_CLS_SLOT read/write rejection,
  the `{}` handler's ERR_CLS_SLOT literal-key rejection — GONE. `__errcls__`
  is un-stolen: an ordinary property name, usable anywhere.
- `module/collection.js`: `schemaKeyEqPublic` (the ERR_CLS_SLOT-excluding
  wrapper around `schemaKeyEq`, both dyn GET/SET dispatch loops) and the
  matching IIFE in the dyn DELETE arm — deleted, calls point at plain
  `schemaKeyEq`/`$__str_eq` again.
- `module/json.js`: `__json_obj`'s ERR_CLS_SLOT-excluding stringify-walk
  condition — deleted, back to the plain `$__json_omit` check.
- `module/object.js`: `emitKeysGeneric`/`__keys_ro`'s `.filter(p => p !==
  ERR_CLS_SLOT)` — deleted (plain `schema`/`schema.map` now). `emitEnumerateObject`'s
  raw-array-shortcut veto (`ctx.features.error`-gated sid-inequality guard) and
  its matching per-slot skip-loop (`ctx.features.error`-gated key-inequality
  check inside the static-slot copy loop) — deleted; the Error schema now
  takes the SAME fast/plain paths as any other schema, unconditionally.
- `err-codes.js`: `ERR_CLS_SLOT` export gone; `ERR_SCHEMA_PROPS` is now
  `['message','name']` (was `['message','name','__errcls__']`).

NEW, additive (the brand itself + what reads it):
- `module/schema.js`: `register(props, salt)`, `errorSid`/`isErrorSid`/
  `errorClassOf`/`errorSidEntries`/`errorClassesUsed`.
- `src/ctx.js`: `ctx.features.errorClasses` (Set<className>, prepare-time,
  companion to `ctx.features.error`).
- `src/prepare/index.js`: the `ctx.features.error` scan also populates
  `errorClasses`; a NEW declaration-schema binding (mirroring the existing
  object-literal `bindDeclSchema` case) for `let e = new X(...)`/`X(...)` (one
  of the 7 classes) — without this, a BOUND Error variable's schema was
  invisible to every consumer that resolves a NAME's schema instead of
  re-inspecting its init expression (instanceof's tier-2 fold was dead code
  for this exact shape before this session, never actually verified live;
  module/object.js's new spread/Object.assign source-schema check needed it
  to cover the realistic `let e = new TypeError(x); {...e}` case, not just an
  inline literal argument).
- `module/object.js`: `isErrorSchemaSource`/`sourceSchema` — a SOURCE-position
  override (spread/Object.assign SOURCE resolution only, not `resolveSchema`
  itself) answering `[]` for an Error-schema source: real JS's `message`/
  `name` are OWN but NON-enumerable (`Object.keys(new TypeError('x'))` → `[]`,
  node-verified), so spread/assign FROM an Error copies nothing — matches JS,
  and as a side effect completely bypasses the `__obj_clone` single-spread-
  source bug for this case (the source resolves as a KNOWN empty schema, never
  reaching the "unknown schema" fallback that bug lives in). Plumbed through
  `spreadSourceSchema`, `Object.assign`'s source-schema array, both
  `emitDynamicAssign`'s and `emitObjectAssignDynamic`'s source resolution, and
  the boxed-target Object.assign path — 6 call sites total, target-side
  resolution left untouched (assigning INTO an Error stays governed by its
  real physical schema, pre-existing behavior, not in scope).
- `module/core.js` `buildErrorObject`: 2-slot object (`message`,`name` only);
  message coercion rewritten per ES 20.5.1.1 — `errorMessageIR` special-cases
  (a) BOOL via the same true/false-select every other direct-toStrI64 caller
  already uses (module/string.js's per-leaf template formatter, emit.js's
  `+`-concat `strOperand`) — NOT a toStrI64-internal fix, matching that
  established per-call-site convention exactly; (b) a closed (no spread, no
  toString/valueOf key) object LITERAL argument → static `'[object Object]'`;
  (c) `isUndef` (existing default-param helper, folds to a compile-time
  constant for any literal, zero runtime cost for the common case) gating
  ToString per Error's own "message present but undefined → no message"
  clause, distinct from `msg == null`'s "argument absent" check.
- `src/compile/index.js` / `interop.js`: a new `'jz:errcls'` custom section
  (sid → className pairs, emitted only when `ctx.schema.errorSidEntries()` is
  non-empty) — interop's `decodeThrown` runs on ALREADY-COMPILED bytes with no
  access to this compile's `ctx.schema` state, so recovering "which class did
  this sid come from" needs SOME shipped table; reads the sid straight off the
  raw NaN-box bits (`aux(errBits)`), gated on `type(errBits) === PTR.OBJECT`
  first (an aux value can coincide with a minted error sid by pure numeric
  chance on a DIFFERENT pointer type — the tag check is the correctness gate,
  mirroring the old design's `ERR_CLASS_NAMES[value.__errcls__] === value.name`
  cross-check but stronger: the sid is read from the pointer's own immutable
  tag bits, not a decoded property value no source write can ever reach or
  forge in the first place).

GATES (all green): full battery run in 13 chunks of ≤7 files (`node
test/index.js <names...>`, all 88 files in TESTS) — 0 failures after one
initial test-authoring miss (see below); `node test/selfhost.js` 21/21;
kernel-parity 33/33 byte-identical (11 fixtures × O0/O2/Ospeed); kernel-oracle
green; perf-ratchet 10/10, every row +0; fuzz (2000×4, via the `fuzz` test
file's default run) green; fresh `node scripts/build-dist.mjs` ×2 →
byte-identical dist/jz.wasm AND dist/jz.js (sha256-verified); size spot-check
via a throwaway `git worktree add` at HEAD: an Error-using module went
8871→8795 bytes at O2 (76B SMALLER — 3-slot→2-slot object, dead filter code
gone), a plain Error-free module stayed BYTE-IDENTICAL (39 bytes both sides);
per-instance heap footprint ~32B (16B payload + 16B header, was ~40B/3-slot) —
comfortably under the design's own ~60-100B ledger estimate. ONE test-
authoring bug caught and fixed during this session, not a compiler bug: the
first version of the new "Object.assign/spread from a BOUND Error variable"
pin failed (2 vs expected 0) — root cause was the missing declaration-schema
binding for Error-constructor-initialized `let`s described above (a real,
narrow gap, fixed at prepare-time rather than weakening the test).

test/errors.js: the P0-3 test block REWRITTEN (not deleted — the un-
enforceability pin flips to a correctness pin, same convention as every prior
audit closure in this file) into "errors: __errcls__ is an ordinary, un-stolen
property name" plus a new "Object.assign/spread over an Error" block (4
groups) and a new "Error ctor message coercion" block (P1, 11 assertions
incl. 2 dynamic-operand cases exercising the runtime `isUndef` branch, not
just the compile-time fold every literal takes). test/minimal-output.js: both
Error-related pins' comments updated for the 2-slot/32B math and the
no-longer-`__errcls__`-shaped reachability story; assertions unchanged (still
correct, for a cleaner reason).

## Status (2026-08-04, audit-#9 P0-1 closed — Map/dict value-census consumers
## reverted to dormant AGAIN; represented-join design banked)

AUDIT-#9 FINDING: `censusMaybeUndefinedKind` (kind.js) — the maybeUndefined
join Slice 1-4 wired at a curated chokepoint list (toNumF64, String(), JSON,
isNaN, bigIntOperand) — recognizes ONLY the ORIGINAL read AST shape. Assigning
the read to a local preserves the census's claimed exact kind but silently
DROPS the "may be undefined" fact, so every consumer fix landed so far covers
direct-expression positions only. 5 failures verified live at HEAD (cc78bf56)
before this fix, repro'd via a standalone script (jz(src,{jzify:true})):
  1. `let x = m.get('missing'); return x + 1` → jz `undefined` (JS: NaN) —
     decl-propagation loss.
  2. STRING census: `m.get('z')` (STRING-valued map) `+ 1` on a MISSING key →
     jz string `"1"` (JS: NaN) — emit.js's `+` STRING-concat fast path
     (~line 4741) trusts exact VAL.STRING with no censusMaybeUndefined gate
     at all — never on the chokepoint list to begin with.
  3. BIGINT census: absent read `+ 1` (plain number literal) → jz
     COMPILE-TIME TypeError — emit.js's `bigintMixReject` (~line 4101) is a
     pure `valTypeOf(a) === VAL.BIGINT` compile-time check, also never on
     the chokepoint list.
  4. Two absent BigInt reads combined (`m.get('a') + m.get('b')`, both
     missing) → runtime TypeError code 116 (ERR.BIGINT_UNDEF_MIX) — JS: NaN.
  5. Present `m.get('x')` holding `5n`, exported/returned → number
     `2.5e-323` (JS: `5n`) — DIFFERENT class (present key, not
     mayBeUndefined at all): compile/index.js's `synthesizeBoundaryWrappers`
     export-lane split can't route a dynamically-typed-but-actually-BigInt
     value through the dedicated i64-no-reinterpret BigInt lane without a
     static proof it never gets. CONFIRMED PRE-EXISTING at HEAD (cc78bf56,
     census ON) via a temporary worktree — NOT caused by this fix, and
     test/dyn-keys.js already had a comment (citing a919446a) flagging it as
     "a SEPARATE, PRE-EXISTING bug" before this session touched anything.

FIX (same shape as the audit-#7 P0 revert f8f61591, applied to BOTH censuses
this time instead of just Map's): DISABLED kind.js's `dictValueKindOf`/
`mapValueKindOf` (VT['[]']/VT['.']/VT['()']'s dict/Map exact-kind folds) and
`censusMaybeUndefinedKind`/`censusMaybeUndefined` (now a permanent `null`/
`false` stub, left wired at every existing call site — ir.js toNumF64/
toStrI64, emit.js nullableOperand/bigIntOperand/bigIntUnary, module/string.js
String(), module/number.js isNaN, module/console.js writePart — rather than
edited out of each, since with no exact-kind claim left there's nothing for
any of them to protect). PRODUCERS UNCHANGED: analyze.js's same-body scan and
program-facts.js's observeProgramSlots keep writing dictValueValType/
mapValueValType onto reps — dormant facts, same precedent as bigintBoxed and
the original audit-#7 revert. Doc comments at every touched site (kind.js,
reps.js, emit.js) cite audit #9 and point to the replacement design.

REPROS 1-4 now PASS at JS-correct values (verified individually — the generic
dynamic path already handles undefined correctly once nothing falsely claims
an exact kind). REPRO 5 still fails post-disable (unchanged from pre-disable —
confirmed the SAME 2.5e-323, not worsened) — the deeper, pre-existing
export-boundary bug, out of scope for this P0 (see
.work/represented-maybe-undefined-design.md §6 for the full root-cause
citation: compile/index.js synthesizeBoundaryWrappers ~1595-1601's
resultBigint/resultDynamic lane split, plus an apparent gap in the
bigintBoxed producer wiring not firing for Map/dict writes even for a named
local that should qualify per analyze.js's own W-sink list).

DISABLE COST — surfaced ONE new regression class the census's presence had
been masking: PRESENT-key BigInt values read from a Map/dict and passed
through unary `-`/`~` now decode as a plain NUMBER instead of a BigInt
(`-m.get(presentKey)` where the value is `5n` now gives `-5`, not `-5n`) —
same root as repro 5 (presentKind, not mayBeUndefined), NOT one of the 5
official repros but caught by test/dyn-keys.js's existing "audit-#8 P0-4
Part 3" present-key structural pins (2 assertions each, Map + dict sibling).
Adapted both to KNOWN-FAIL pins asserting the current (wrong) values, per the
f8f61591 dict-sibling precedent, with a comment tracing the connection to
repro 5 and the design doc. No OTHER dyn-keys.js/inference.js pin needed a
behavior change — every other audit-P0/Slice pin (absent-key, alias-write,
captured-mutation) stayed green unmodified, because the underlying VALUES
were always correct via the generic dynamic path; only pins asserting WAT
CODEGEN SHAPE (two "consumer wiring" tests, one dict one Map) needed comment
corrections — investigation showed their `f64.gt`/no-`$__gt` assertions were
NEVER actually caused by dictValueKindOf/mapValueKindOf in the first place
(cmpOp's own coerced-f64 path fires whenever the OTHER operand is a proven
NUMBER LITERAL, census or no census) — renamed/re-commented, not changed
functionally.

GATES (fresh dist rebuild required — kernel-parity's `dict` CORPUS row
initially failed byte-identity because dist/jz.wasm was stale from before
this session's src edits; `npm run build` twice, byte-identical, resolved
it): full 88-file battery run in 13 chunks of ~7 files each, foreground,
0 fail (pre-existing skips unrelated: array-methods 1, features 1, unsigned
1). kernel-parity 33/33 (post-rebuild). kernel-oracle 451/451 assertions
(post-rebuild; surfaced no NEW pending-fix rows — the existing
"generic-scalar-decl BOOL∪NUMBER carrier collapse" PENDING-FIX row is the
SAME decl-init-wall class .work/carrier-invariant-design.md already banked,
cited in the new design doc §6 as the parallel case, not caused by this
session). perf-ratchet 10/10, every category (+0) delta from baseline — this
disable cost ZERO measured codegen-shape regression (none of the 10 ratchet
corpus benchmarks touch dict/Map value-census typing on a hot loop body).
optimizer 434/434 (with dyn-keys/data/math). selfhost.js 21/21 (40
compile-yourself rounds). fuzz.js 2000 programs × opt{0,1,2,3}, 0 divergence.
Fresh build × 2: dist/jz.wasm + dist/jz.js + dist/interop.js SHA-256
byte-identical across both builds. Size sweep (`node scripts/bench-size.mjs
--json`, geomean jz/AssemblyScript over 49 sized cases): **1.0550 → 1.0550**,
unchanged to 4 decimal places — no size cost from this disable on the
standard corpus (the `dict` case itself: jz=1313B/wasmopt=1249B, in line
with its pre-existing size).

DESIGN BANKED: .work/represented-maybe-undefined-design.md — the single
propagated invariant the audit demands (`mayBeUndefined` + `presentKindUnboxed`
as REP_FIELDS entries, modeled directly on the existing `nullable`/
`bigintBoxed` fields' OWN propagation mechanisms — narrow.js already proves a
REP boolean can flow through the whole-program call-site fixpoint, this is
not new machinery), propagation through decl/param/return/closure/export,
the exact chokepoint rewrite list (including the two NEWLY-identified gaps —
bigintMixReject, the `+` STRING-concat fast path — that were never on the
chokepoint list even when Slice 1-4 was live), re-enablement criteria for
dictValueKindOf/mapValueKindOf, and explicit connections to two related,
independently-tracked issues: the decl-init wall
(.work/carrier-invariant-design.md — same symptom, different root
mechanism) and the BigInt export-boundary gap (repro 5's class — same
symptom family, needs its own bigintBoxed-wiring investigation). 5 ordered
landing slices, smallest-first.

## Status (2026-08-03, FFT BUTTERFLY RECOVERED — the audit-P1-2 campaign's
## named-but-not-attempted THIRD residual (976433c1's own ledger entry),
## closed via direct WAT/IR instrumentation, NOT the shape 976433c1 predicted)

**976433c1's own prediction was WRONG, caught by instrumentation, not trusted from
the printed .wat**: that entry said tryButterfly declines because the twiddle loads
(`body[0]`/`body[1]`) are sunk inline as `local.tee`s inside the `tr`/`ti` `f64.mul`
operands. Direct instrumentation of `tryButterfly` itself (temporary trace, removed
before landing) showed the OPPOSITE: `body[0]`/`body[1]` are still the twiddle
loads, exactly as the matcher wants, and `body.length` is exactly 17. The recognizer
was bailing ONE check earlier, on `jInc` — the loop-increment block's j-side, which
the matcher requires as literal `i32.sub(local.tee(J, i32.add(J,1)), i32.const(1))`
(the postfix-`j++`-as-a-comma-expression's dropped old-value) but which actually
compiled as `f64.sub(f64.convert_i32_s(local.tee(J,…)), f64.const(1))` — the SAME
"unprovable i32 range → f64 overflow-canon detour" class as every other residual
this campaign closed, just one level deeper (the counter's OWN in-body arithmetic,
not a load address).

**Root, traced through THREE compounding gaps** (each confirmed independently by
instrumenting `forCounterRange`/`intExprRange`/Root-F's own trigger site before
touching any code — never guessed):
1. `for (let j = 0, k = 0; j < half; j++, k += step)` is a comma-initialized,
   comma-stepped dual-IV header. `forCounterRange` (emit.js, c8700daa's own
   loop-counter RANGE-PROOF lever) required a SINGLE-declarator init
   (`init.length === 2`) and a bare `++`/`+=` step — both fail on this shape's
   two declarators and comma-sequenced step, so `j` never got a range at all.
2. Even with (1) fixed, this loop ALSO triggers Root-F's typed-bounds VERSIONING
   (it indexes `re`/`im`/`wre`/`wim`) — and Root-F's fast/checked arms both
   re-emit the loop via `emitter['for'](null, cond, step, body)`: `init` nulled
   because the real init already ran once, before the guard branch. So
   `forCounterRange(null, …)` proved nothing in EITHER re-emitted arm even once
   (1) was fixed — the SAME "guard's own re-emission drops the fact its OWN
   setup already has" shape 4b20e4c6's bound-magnitude lever fixed for `w-1`,
   just for the counter itself rather than the loop bound.
3. `intExprRange` (static.js) had no case for `half`'s own definition
   (`len >> 1`) — the SIGNED `>>` operator was entirely unhandled (only its
   unsigned `>>>` sibling had a rule) — nor for `++`/`--` as an expression VALUE
   (needed to resolve the comma-step's dropped `(++j) - 1` old-value form).
   Both are GENERAL gaps: `>>` is ToInt32-then-shift, sound as a conservative
   `[I32_MIN>>s, I32_MAX>>s]` hull from the shift amount ALONE (same "derive
   from the op, not the operand" reasoning the existing `&`/`>>>` cases already
   use) — `n` (the FFT's own runtime, unbounded size param) never needs its own
   magnitude proven for `half`'s hull to exist.

**Fix, three general (non-butterfly-specific) levers, no scaffold-matcher changes**:
- `forCounterRange` (emit.js): finds `name`'s own declarator among several in a
  multi-declarator `let`; unwraps a comma-step to find `name`'s own mutation
  among several step expressions, and unwraps the postfix-value sugar
  (`(++x) - 1`) to see the underlying `++x` write.
- Root-F's guard (emit.js, `emitter['for']`'s typed-bounds-versioning block):
  computes the counter's `[lo,hi]` hull ONCE from the real (still in-scope,
  not-yet-nulled) init, and threads it via the existing `withRefinements`
  machinery into BOTH re-emitted arms — unconditionally (unlike the bound-name
  magnitude lever just below it, the counter's own range doesn't depend on the
  guard having passed: same init/cond/step either way, only the body's access
  forms differ).
- `intExprRange` (static.js): new `>>` case (signed-shift hull, operand-range-
  tightened when known, full-domain fallback otherwise) and new `++`/`--` case
  (operand's range ± 1, prefix semantics — postfix's old-value form already
  unwraps to this at the AST layer, ast.js's own convention).

tryButterfly itself is **completely unchanged** — confirmed by `git diff --stat`
showing zero lines touched in vectorize.js. This was deliberately checked before
landing: an earlier pass touched the recognizer with instrumentation, and the
instrumentation was fully reverted once the WAT/IR trace located the real gap
three layers upstream in emit.js/static.js.

**Acceptance**: tryButterfly fires — `__bf0_` locals present, 22 v128/f64x2 ops
(2 `f64x2.replace_lane` + 2 `f64x2.splat` twiddle loads, 4 `v128.load`,
4 `v128.store`, 4 `f64x2.mul`, 3 `f64x2.sub`, 3 `f64x2.add` — ONE wrapper, no
duplicate match) for test/simd.js's exact specimen; bit-exact vs the scalar
oracle for every N in {2,4,8,64} (unchanged — this was never a value bug).
test/simd.js's butterfly row is now a real, unconditional assertion (no more
`if (/__bf\d+_/.test(w)) … else ok(true, 'KNOWN GAP')` branch) — 582 assertions
(+2), 158/158 pass. Confirmed the SAME source (bench/fft/fft.js, byte-for-byte —
the FIXED SPECIMEN rule was never touched) also fires: 30 `__bf` matches, 30
v128/f64x2 ops (a different op mix than the isolated test specimen — extra
lifts elsewhere in the file, e.g. the twiddle-table builder — not investigated
further, out of scope).

**Timing** (quiet machine: load avg 3.65-4.52/14 cores throughout; `--paired`
ABBA, 4 rounds, jz vs rust→wasm, both V8-hosted — the honest wasm-vs-wasm axis):
fft **jz 1011µs vs rust-wasm 1003µs — 1.009× (median), was 1.10× red** (the
un-paired baseline row: jz 1105µs vs rust-wasm 1006µs). Checksum
4234940375 == the case's own reference checksum (bit-exact at bench scale, not
just the differential test). `bench/results.json`'s `fft.jz` row hand-patched
(medianUs 1105→1011, memKb 54432→54688, `paired.jz/rust-wasm` added) —
surgical, scratch-JSON-then-hand-patch per convention, `bytes` (2368)
deliberately UNCHANGED: the recorded `bytes` column is the **size**-tier build
(`optimize:'size'`), which has `vectorizeLaneLocal:false` AND
`versionTypedBounds:false` BOTH off by design (confirmed via a disposable
976433c1 worktree compiling the same source: bf-match count 0 there too) — this
fix lives entirely inside vectorization/Root-F, so the size tier is untouched
by construction, matching every prior vectorizer-only session's precedent. The
**speed**-tier build (the one that actually vectorizes) grew 5189→5407 B
(+4.2%) at HEAD-vs-fixed — the expected, disclosed size/speed trade for a new
SIMD wrapper + 10 v128/i32 locals, not a bench/`bytes`-column regression.
`scripts/bench-size.mjs` geomean **1.055× → 1.055×** (unchanged, matches: the
sweep uses the size tier, untouched by this fix — same precedent as every
other vectorizer-recovery session banked above).

**Gates, all green**: kernel-parity 3/3 (33/33 byte-identical); kernel-oracle
11/11 (451 assertions); optimizer 214/214 (3949 assertions, unchanged);
simd.js 158/158 (582 assertions, +2 — butterfly row now a real assertion);
cond-vectorize.js 3/3 (8 assertions); examples.js 22/22 (434 assertions);
selfhost.js 21/21 (206 assertions); selfhost-perf.js informational 5/5 (warm
0.991× < 1.03× cap [was 1.013×], fresh 0.780× < 0.99× cap [was 0.772×]);
perf-ratchet 10/10 (+0 across int/float/mixed/cond/buf/nest/slice/ring/
condref/fgather — this fix's corpus reach is the vectorizer + Root-F path,
which perf-ratchet's SCALAR loop-body-op-count corpus doesn't exercise, same
as every prior vectorizer-only session); fuzz 2000×4 (seeds 1-2000, opt
{0,1,2,3}, 20 inputs/program) — 30173 compared, 9827 skipped (i32-contract
exceeded), 0 non-numeric, **0 divergence** — identical counts to every prior
session's run; full `test/index.js` 88-file battery, 13 foreground chunks (12×7
+ 1×4, never monolithic/background) — every chunk green; fresh `npm run build`
×2 — dist/jz.js and dist/jz.wasm byte-identical both times (SHA-256 verified);
full size sweep — see above.

## Status (2026-08-03, audit-P1-2 RECOVERY CAMPAIGN CLOSED — Residual A
## (diffusion/slime f64-domain wrap-canon, named at 4b20e4c6) and Residual B
## (i32-array-add wrapIntIR teach-the-matcher, named at c8700daa) BOTH
## RECOVERED; FFT butterfly investigated and found to need a THIRD, separate
## mechanism — named honestly, not attempted)

**Residual A — diffusion/slime toroidal wrap-select, f64-domain**: 4b20e4c6's
own residual said `xw = x>0?x-1:w-1` (diffusion: `x===0?w-1:x-1`) compiles to
an F64-DOMAIN select (both branches unify at f64 since `w-1` isn't provably
i32-small) wrapped in jz's ordinary overflow-canon, and `tryStencil`'s
`ivCoeff`/`isWrapSelect` (src/optimize/vectorize.js) only recognized the
I32-domain step (`isStep` checked literally `'i32.sub'`/`'i32.add'`). Direct
WAT inspection (temporary trace, not guesswork) found the outer overflow-canon
guard is **Infinity-guarded, not NaN-guarded** as the residual's sketch
hypothesized — ivCoeff's EXISTING `/inf/i.test` check (line ~1862, unchanged)
already matches it; only the wrap-select's OWN two branches needed teaching:

- `isStep` now also accepts the f64-domain step `f64.{add,sub}
  (f64.convert_i32_s(local.get $iv), f64.const 1)` (unwrapping a possible CSE
  tee around the convert), alongside the original bare i32 form.
- `ivCoeff` now treats a bare `f64.const` (any value) as loop-invariant
  (coefficient 0) — the same unconditional-any-value reasoning its existing
  `isI32Const` branch already uses; needed because the wrap-select's
  invariant branch (`0`/`w-1`) is now f64-typed too.
- A new `ivCompare(g, iop, fop)` matches the RIGHT-direction guard in either
  domain: native `i32.{lt_s,eq}(x, B)`, or `f64.{lt,eq}
  (f64.convert_i32_s(x), B)` with B then f64-typed (a cached `w-1`). `B`
  converts to the identical i32 value via `i32.wrap_i64(i64.trunc_sat_f64_s
  (B))` — the EXACT idiom jz's own overflow-canon already uses to extract
  these selects' own result — value-exact for any finite integer-valued f64,
  not an approximation, no new mechanism invented.

**Per-kernel recovery table** (f64x2 count, `jz.compile(src, {optimize:
{level:'speed'}, wat:true})` — matches examples/build.mjs's OPT):

| kernel | metric | before | after | acceptance target | verdict |
|---|---|---|---|---|---|
| diffusion | f64x2 ops | 4 | **60** | 60 | **recovered — exact** |
| slime | f64x2 ops | 1 | **13** | 13 | **recovered — exact** |

Verified bit-exact: test/examples.js's toroidal-wrap-stencils test (min-
threshold assertions UN-SILENCED to exact `is(sten, 60|13, …)` pins) runs
the full SIMD-vs-scalar differential (`noSimd:true`) — 3072 px, 8/20 frames
— 0 diffs for both. Independently re-verified via a standalone driver
(resize 256×192, 40 frames, rolling-hash checksum): diffusion SIMD
checksum 3726284068 == scalar 3726284068.

**Residual B — i32-array addition, wrapIntIR**: c8700daa's finding said
`module/typedarray.js`'s `wrapIntIR` (the ES ToIntN int-store wrap emission)
produces a shape the lane vectorizer declines for `a[i]+b[i]` on two
FULL-RANGE Int32Array elements (unprovable as native i32.add, so jz computes
the sum in f64 — exact, since both ±2³¹ operands and their sum always fit
the 53-bit mantissa — then ToInt32-wraps it back). Root-caused via direct
WAT/stack-trace inspection (not guesswork): jz's codegen sinks the f64.add
into its OWN lane-local first (wrapIntIR's own doc: its argument must be a
pre-temped, re-evaluable node — `local.set $t (f64.add …); store addr
(wrapIntIR-canon of $t)` as TWO separate body statements), hiding the add
from BOTH the vectorizer's arithmetic-recovery path (which only ever saw a
bare 4×-repeated `local.get $t`, never the add) and its scan phase. This is
a DIFFERENT root shape than the ledger's own precedent (peelNarrowConv's
existing "CSE'd ToInt32 narrowing conversion" inlining, which only fires for
a narrowING store, sty≠laneType, ONE read) — ours is a SAME-type store
(sty===laneType) with the local read up to 4 times.

**Fix** (src/optimize/vectorize.js):
1. `tryVectorize`'s `body2` preprocessing gained a new pass, structurally
   parallel to the existing CSE'd-narrowing-conversion inliner just above
   it: when a lane-local `$t`'s ONLY def is `f64.add/sub(convert,convert)`
   and EVERY read of `$t` in the whole body sits inside ONE same-type store,
   splice the def back in at every occurrence and drop the separate
   `local.set` (dead once inlined).
2. New `liftAddSubOfConverts(v, ctx)`: recognizes `f64.add/sub
   (f64.convert_i32_{s,u}(A), f64.convert_i32_{s,u}(B))` — bare, or still
   wrapped in wrapIntIR/toI32's canon (peeled via the EXISTING
   `peelNarrowConv`, unchanged) — and lifts straight to `i32x4.add`/
   `i32x4.sub` on the raw i32 operands, skipping the f64 round-trip. i32.mul
   is deliberately NOT extended: its exact 62-bit product can exceed the f64
   mantissa, so a rounded `f64.mul` then ToInt32 is not always i32.mul's
   value — this stays scoped to add/sub, where the f64 op is provably exact.

A speculative first attempt (defensively matching a `local.tee`/`local.get`
mismatch inside `peelNarrowConv` itself, on the theory that a copy-prop pass
folds the CSE'd local's `local.set` into an inline tee at first use) was
INSTRUMENTED and found to fire ZERO times across simd.js/examples.js/
cond-vectorize.js — dead code from misreading the WAT TEXT PRINTER's
cosmetic tee-folding as the real pre-watr IR (which uses plain `local.get`
throughout, per wrapIntIR's own "re-evaluable pure node" contract). Removed
before landing; the real blocker was the separate-statement CSE, above.

**Per-kernel recovery table**:

| target | metric | before | after | verdict |
|---|---|---|---|---|
| i32-array add (`a[i]+b[i]`, test/simd.js breadth matrix) | hasV128 | false | **true** (i32x4.add) | **recovered** |
| FFT butterfly strip (test/simd.js) | `__bf\d+_` present | false | false | **unchanged — different residual, see below** |

Verified bit-exact beyond the differential test's own zero/unpopulated
arrays: a standalone driver seeding `a`/`b` with an xorshift PRNG across
{1,2,3,4,5,7,8,9,16,17,100,1000} elements AND an explicit overflow-edge case
(INT32_MAX+1, INT32_MIN−1, ±2e9 sums, 0+INT32_MIN, −1+1) — SIMD and scalar
(`noSimd:true`) checksums identical in every case, including every wrap
boundary. i32x4.sub verified the same way (both add and sub compile and
match).

**Named next residual (FFT butterfly — NOT wrapIntIR, a different, larger
gap)**: investigated to the root via direct WAT inspection of the actual
compiled loop body (not the test's own prior "likely reachable through the
SAME…family" guess). `tryButterfly` (vectorize.js) pattern-matches an EXACT
17-statement canonical body with `body[0]`/`body[1]` required to be the
`wre[k]`/`wim[k]` twiddle loads as their OWN leading `local.set` statements.
The CURRENT compiled body is no longer 17 statements: the twiddle loads are
now sunk INLINE as `local.tee`s inside the `tr`/`ti` `f64.mul` operands — a
statement-fusion/scheduling difference, confirmed UNRELATED to wrapIntIR
(`a=i+j`/`b=a+half`/`k+=step` all already lower as native i32.add in the
current WAT; `re`/`im`/`wre`/`wim` are Float64Array, wrapIntIR is never
invoked). Teaching `tryButterfly`'s positional unifier to accept this (or
any) statement-fusion ordering is a real, separate, larger rewrite of its
exact-shape matcher — out of this session's scope, named for a future
session in test/simd.js's own updated comment.

**Ratchet**: `test/perf-ratchet.js` float/mixed/int/cond/buf/nest/slice/ring/
condref/fgather — all **+0** (10/10 pass, float 565 / mixed 971 unchanged).
`scripts/perf-corpus.mjs`'s generators don't produce either recovered shape
(a toroidal wrap-select or a same-type i32-array add) — same honest-floor
precedent as every prior session's lane-vectorizer-only fix: nothing
recovered in the SCALAR loop-body-op-count corpus this measures → nothing
re-tightened; still NOT moved toward the pre-16f2d7c8 560/790 floor
(unsurprising — both fixes are vectorizer-only, they change SIMD lift
eligibility, not the scalar op counts perf-ratchet counts).

**Size**: `node scripts/bench-size.mjs` geomean jz/AS: **1.055 → 1.055**
(unchanged, 49 sized cases). diffusion/slime live in `examples/`, and the
i32-add-arrays case is a synthetic test/simd.js snippet — neither is a
`bench/` CASE, so the sweep genuinely doesn't move (same precedent as the
Residual-A-adjacent stencil session).

**Timing** (quiet machine: load avg 4.36-4.83/14 cores throughout, no other
jz/test/build processes running; `--paired` ABBA, 8 rounds, SIMD vs
`noSimd:true` scalar, same compiled module reused across rounds):
diffusion 28.28ms (simd) vs 52.93ms (scalar) — **1.872× win**; i32-array-add
(20000 elements × 400 repeats) 1.222ms (simd) vs 6.908ms (scalar) —
**5.656× win**. Both pairs' checksums identical simd vs scalar (diffusion
3726284068/3726284068; i32-add −2092986215/−2092986215) — the speedup isn't
from a value change.

**Negative controls / soundness floor**:
  - `liftAddSubOfConverts` is scoped to `f64.add`/`f64.sub` only —
    `f64.mul` is NOT matched (documented above: its exact product can
    exceed the f64 mantissa, so ToInt32-of-rounded-product ≠ i32.mul in
    general). Confirmed by construction (the recognizer's own op-check),
    not by a failing test.
  - The `body2` CSE-inlining pass requires EVERY read of the candidate
    local to sit inside the ONE store being rewritten (`inStore !==
    getCount3.get(nm)` bails) — a value ALSO used elsewhere (e.g. a genuine
    multi-use accumulator) is correctly left alone.
  - FFT butterfly (the shape this session's fix does NOT reach) stays
    scalar — confirmed unchanged, no false admission.
  - fuzz 2000×4 (seeds 1-2000, opt {0,1,2,3}, 20 inputs/program): **0
    divergence** (30173 inputs compared, 9827 skipped i32-contract-exceeded,
    0 non-numeric — identical counts to every prior session's run,
    confirming determinism).

**Gates, all green**: kernel-parity 33/33 byte-identical; kernel-oracle 451
assertions/11 suites; optimizer 214 tests/3949 assertions (unchanged);
simd.js 158 tests/580 assertions (i32-add-arrays KNOWN_GAP UN-SILENCED to a
real assertion; butterfly KNOWN_GAP comment corrected to name the real,
different residual, threshold unchanged); simd-intrinsics (full battery);
cond-vectorize.js 3/3 (8 assertions); examples.js 22 tests/434 assertions
(diffusion/slime KNOWN-GAP min-thresholds UN-SILENCED to exact `is(sten,
60|13, …)` pins); selfhost.js 21/21 (206 assertions); selfhost-perf.js
informational 5/5 (warm 1.013× < 1.03× cap, fresh 0.772× < 0.99× cap);
perf-ratchet 10/10 (+0, see above); fuzz 2000×4 zero divergence; full
`test/index.js` 88-file battery, 13 foreground chunks (12×7 files + 1×4,
never monolithic/background) — every chunk green modulo 6 pre-existing
intentional skips (unrelated to this change); fresh `npm run build` ×2 —
dist/jz.js and dist/jz.wasm byte-identical both times (verified via SHA-256,
re-run clean after an earlier interrupted background attempt produced a
spurious mismatch — see process note below); full size sweep (`scripts/
bench-size.mjs`) — see Size above.

**Process note**: an earlier `npm run build` in this session was started as
a background task and then killed mid-run while investigating a stale
notification; the resulting `dist/jz.wasm` differed from a subsequent clean
run's hash (dist/jz.js was unaffected). Re-ran BOTH builds in the
foreground back-to-back from a clean process state — byte-identical
(SHA-256 matched exactly for both jz.js and jz.wasm) — confirming the
mismatch was the interrupted process racing the write, not a compiler
determinism regression. No lesson for the compiler; a lesson for this
session's own process hygiene (foreground, not background, for anything
whose output gets diffed).

## Status (2026-08-03, STENCIL RECOVERY via Root-F bound-magnitude lever —
## audit-#8 P1-2's own named next step (c8700daa's "REAL lever for a future
## ticket"): watercolor/waves/schrodinger back to their FULL pre-regression
## f64x2 counts (49/46/27); diffusion/slime investigated to a DIFFERENT,
## precisely-named residual — not this lever's scope)

**The lever, exactly as named**: c8700daa's own residual said tryStencil's
`boundPureInv` (src/optimize/vectorize.js) declines `w-1`/`h-1` (module
globals fed from `resize(w,h)`, genuinely unbounded statically) because the
bound never lowers as a raw i32.sub chain — and pointed at the EXISTING
Root-F "typed-bounds loop VERSIONING" scaffold (`emitter['for']`, emit.js;
`versionableTypedNest`, type.js) as the unexplored, structurally-adjacent
fix: teach the admission to accept the VERSIONED runtime guard instead of
demanding static proof. Investigated bottom-up (WAT diff, not guesswork):

1. `boundPureInv` itself was never the blocker — it already accepts any
   `global.get`/unwritten-local/`+,-,*` chain unconditionally (no magnitude
   check in that predicate at all). The REAL admission gate is upstream:
   whether `w-1` **lowers as i32.sub in the first place** — governed by
   `subRangeFitsI32`/`addRangeFitsI32` (emit.js), which read
   `intExprRange(name)` (static.js) and get `null` for `w`/`h` (no decl-range
   stamp — same "genuinely unbounded" fact c8700daa named).
2. Root-F's guard (emit.js `emitter['for']`) DOES already fire on these
   stencils (`versionableTypedFor`, type.js, accepts an "invariant pure
   EXPRESSION bound" — `x < w-1` — via `invariantIdxExpr`, and DOES emit a
   fast/checked arm pair). But its own conjunct machinery only proves
   `|bound VALUE| ≤ 2^31` for the WHOLE composed expression (`w-1`), never a
   fact about the free name `w` ALONE — so when the fast arm calls
   `emitter['for'](null, cond, step, body)` to re-emit `x < w-1` from
   scratch, `w-1` hits the SAME unproven-range fits-gate and falls to
   `f64.sub` again, inside the guard too. Confirmed by WAT: `$__poff0` (w,
   already i32-STORED via the separate collectBareEscapes/widenLocalTypes
   tolerance) still round-tripped through `f64.convert_i32_s` for the `-1`.

**Mechanism** (src/compile/emit.js, `emitter['for']`'s Root-F block; +
`export` on `SLOT_OPS`, src/type.js): for every level's `f64`-kind bound,
walk its free names (mirroring `invariantIdxExpr`'s OWN grammar — only
`SLOT_OPS`-shaped binary nodes recurse, a bare string is a name, anything
else — member access, calls — contributes none, so a `.length` bound's
`'length'` property-key string is never misread as a variable). For each
name lacking an `intExprRange` fact already, emit ONE extra runtime
conjunct pair — `f64.eq(v, f64.floor(v))` (integral) + `f64.le(abs(v),
2^30)` (magnitude) — same idiom as the pre-existing SLOT integrality
check just above it — and register a real `{rlo:-2^30, rhi:2^30}` fact.
That fact is fed through `withRefinements` (flow-types.js) — the SAME
channel `forCounterRange` (c8700daa) uses — scoped to EXACTLY the fast
arm's own `emitter['for'](null, cond, step, body)` re-emission; the checked
arm stays unrefined (runs exactly when the new conjunct failed). Inside
that scope, `intExprRange('w')` now resolves, `subRangeFitsI32` accepts
`w-1`, native `i32.sub` emits, and `boundPureInv` — unchanged — accepts the
now-genuine i32 chain. A bare-name bound (`i < N`) is explicitly skipped
(`typeof vs.bound !== 'string'` guard): a plain comparison needs no
magnitude proof at all, and probing it anyway only cost bytes.

**Two bugs found and fixed during verification (not shipped broken)**:
  - Naive "every string leaf" free-name walk misread `.length`'s property
    key as a variable (`emit('length')` → "not in scope", crashing the FFT
    kernel at the speed preset — test/simd.js's own dedupe-lane-locals
    regression test caught it). Fixed by mirroring `invariantIdxExpr`'s
    exact SLOT_OPS grammar instead of a blind walk (`SLOT_OPS` exported
    from type.js for this).
  - Applying the lever to EVERY level (not just `bKind==='f64'`) was
    necessary (bKind can independently classify `w-1` as `'i32'` via
    `exprType`'s own magnitude check while the CODEGEN path for the SAME
    expression still declines — two different `intExprRange` consumers),
    but doing it unconditionally for bare-name bounds too (`i < N`, no
    arithmetic to prove) added a needless guard-setup `f64.convert_i32_s`
    that broke test/perf.js's "no per-iteration i32→f64 widening" pin.
    Fixed by the bare-name skip above.

**Per-kernel recovery table** (f64x2 count, `jz.compile(src, {optimize:
{level:'speed'}, wat:true})` — matches the examples build's OPT):

| kernel | metric | before (HEAD) | after | verdict |
|---|---|---|---|---|
| watercolor | f64x2 ops | 1 | **49** | **recovered — exact pre-regression count** |
| waves | f64x2 ops | 3 | **46** | **recovered — exact pre-regression count** |
| schrodinger | f64x2 ops | 0 | **27** | **recovered — exact pre-regression count** |
| diffusion | f64x2 ops | 4 | 4 | unchanged — DIFFERENT residual, see below |
| slime | f64x2 ops | 1 | 1 | unchanged — DIFFERENT residual, see below |

Verified bit-exact, not just count-matched: test/examples.js's watercolor/
waves/schrodinger stencil tests (previously asserting the KNOWN-GAP decline,
now un-silenced to `is(sten, 49|46|27, …)`) run the FULL SIMD-vs-scalar
differential (`experimentalStencil:false` vs default) end-to-end — 3072/
12288/1536 px, 30/60/12 frames — `simd.filter((v,i)=>v!==scal[i]).length ===
0` for all three. Fuzz 2000×4 (below) independently covers the general
mechanism (per-name magnitude/integrality conjunct + withRefinements scope)
against every OTHER shape it can reach.

**Named residual (diffusion, slime — precisely root-caused, NOT this
lever's scope)**: both kernels' loop bound (`x < w`, a bare name) already
gets NO help needed from this lever (bare-name bounds are fine as-is,
confirmed: their `x<w`/`y<h` compares are unaffected) — investigated via
targeted WAT tracing (temporary `JZ_DBG_ST`/`ST-load-nomatch` instrumentation
in vectorize.js, removed before commit) to find the REAL blocker: both
kernels compute their toroidal wrap value into a NAMED local (`let xw =
x>0?x-1:w-1`) rather than inlining the select at the index site (contrast
watercolor/waves/schrodinger, whose wrap idiom — where present — inlines).
Because `w-1` used to force the WHOLE ternary to unify at one wasm type
(f64, since one branch needed it), the compiled shape is
`select(i32.wrap_i64(trunc_sat_f64_s(select($w_minus_1, f64.sub(x,1),
guard))), 0, f64.ne(t, NaN))` — an F64-DOMAIN inner select wrapped in jz's
NaN-based overflow-canon. `tryStencil`'s `ivCoeff`/`isWrapSelect`
(vectorize.js) only recognize the I32-domain select shape (`isStep` checks
literally `'i32.sub'`/`'i32.add'`) and the INFINITY-based overflow-canon
guard (`/inf/i.test(...)` — a NaN comparand's `String(NaN)` doesn't match).
Even after THIS session's fix makes `w-1` itself i32-safe, the wrap-select's
OWN two branches (`x-1` and the invariant `w-1`) still round-trip through
this canon dance in the compiled IR by construction of how the source
ternary lowers — a genuinely SEPARATE, structurally-adjacent gap in a
DIFFERENT function's pattern vocabulary (not bound admission): extending
`isWrapSelect` to an f64.sub/f64.add step variant, and the overflow-canon
check to a NaN guard too. Real, scoped, not attempted here — named in
test/examples.js's own updated comment for the next session.

**Ratchet**: `test/perf-ratchet.js` float/mixed/cond/buf/nest/slice/ring/
condref/fgather — all **+0** (10/10 pass, unchanged from baseline).
`scripts/perf-corpus.mjs`'s generators don't happen to produce a
runtime-guarded-versioned stencil shape — same honest-floor precedent as
c8700daa's own loop-counter lever (nothing recovered here → nothing
re-tightened; re-tightening would fabricate a result the compiler doesn't
actually produce on THIS corpus).

**Size**: `node scripts/bench-size.mjs` geomean jz/AS: **1.055 → 1.055**
(unchanged, 49 cases). The 5 recovered kernels live in `examples/`, not
`bench/` — no bench-size CASE exercises this exact shape, so the sweep
genuinely doesn't move. `mat4` (c8700daa's own recovered case) unaffected:
1528 B, unchanged.

**Timing** (quiet machine: load avg 3.28/3.52/3.95 on 14 cores after the
`npm run build` background job finished — no other jz/test processes
running; `--paired` ABBA, 8 rounds, SIMD-recovered vs `experimentalStencil:
false` scalar, same kernel, same compiled module reused across rounds):
watercolor 167.2ms (simd) vs 172.5ms (scalar) — **1.032× win**; waves
180.4ms vs 194.5ms — **1.078× win**. Both checksums (32-bit rolling hash
of the rendered pixel buffer) identical simd vs scalar — the speedup isn't
from a value change. Modest, not dramatic: `frame()` spends most of its
time in OTHER work (Gauss–Seidel pressure solve, advection gathers,
tone-map) that this lever doesn't touch — the recovered stencils
(capillary bleed / wave Laplacian) are one pass of several per frame.

**bench/results.json**: NOT touched — watercolor/waves/schrodinger/
diffusion/slime have no `cases.*` row (they are `examples/` demo kernels,
never added to the `bench/` harness this file measures). Nothing to
surgically re-measure.

**Negative controls (soundness floor)**:
  - A bound the guard's new conjuncts CANNOT cover (bare-name bound `i<N`,
    no arithmetic needing a magnitude proof) is explicitly skipped —
    confirmed via test/perf.js's pre-existing "no per-iteration i32→f64
    widening" pin, which the FIRST (unconditional) version of this fix
    broke and this session's bare-name guard fixes.
  - A bound whose free name is a property-key string, not a variable
    (`arr.length`), never gets misread — confirmed via test/simd.js's FFT
    dedupe-lane-locals regression, which the FIRST (naive-walk) version of
    this fix broke and this session's SLOT_OPS-grammar walk fixes.
  - diffusion/slime (the wrap-select-via-named-local shape this lever does
    NOT reach) stay scalar for that shape — confirmed unchanged (4/1
    f64x2, matching the pre-fix baseline exactly) — no false admission.
  - fuzz 2000×4 (seeds 1-2000, opt {0,1,2,3}, 20 inputs/program): **0
    divergence** (30173 inputs compared, 9827 skipped i32-contract-exceeded,
    0 non-numeric — IDENTICAL counts to c8700daa's own run, confirming
    determinism) — every pinned repro from prior sessions stays green.

**Gates, all green**: kernel-parity 33/33 byte-identical (O2/O3); kernel-
oracle 451 assertions/11 suites; optimizer 214 tests/3949 assertions;
simd.js 158 tests/580 assertions (FFT dedupe-lane-locals regression FIXED,
not just re-passing — see "two bugs found" above); simd-intrinsics 15/71;
cond-vectorize 3/8; examples.js 22 tests/434 assertions (watercolor/waves/
schrodinger KNOWN-GAP assertions UN-SILENCED to exact-count pins; diffusion/
slime's KNOWN-GAP comment corrected to name the real residual, thresholds
unchanged); selfhost.js 21/21 (206 assertions); selfhost-perf.js
informational 5/5 (warm 1.006× < 1.03× cap, fresh 0.778× < 0.99× cap);
test/inference.js 135/135 (291 assertions); test/perf.js 55/55 (186
assertions — the bare-name-bound regression FIXED, not just re-passing);
perf-ratchet 10/10 (+0, see above); fuzz 2000×4 zero divergence; full
`test/index.js` 88-file battery, 12 foreground chunks of 4-8 files each
(never monolithic/background) — every chunk green modulo pre-existing
intentional skips (5 total, unrelated to this change); fresh `npm run
build` ×2 — dist/jz.js and dist/jz.wasm byte-identical both times.

## Status (2026-08-03, loop-counter RANGE-PROOF lever landed — audit-#8
## P1-2's "highest-value perf follow-up" — real, narrow, sound recovery on
## the FOR-shaped target (mat4); the 5 stencil kernels + i32-array-add +
## FFT-butterfly investigated and found to need DIFFERENT mechanisms —
## named below, not this ticket's honest scope)

**Mechanism**: `for (let i = C; i < B; i++)` (or `<=`, or `i += K`/`i = i +
K` for a positive const `K`) now proves a real, closed `[lo, hi]` hull for
`i` — `src/compile/emit.js`'s new `forCounterRange(init, cond, step, name)`,
consulted once per `'for'` emission and installed via `withRefinements`
(flow-types.js) — the SAME per-body int-range-refinement machinery an `if
(x >= 0 && x < W)` branch guard already uses, just fed from the loop's own
init/cond/step instead of a branch condition. `intExprRange(i)` — and every
`addFitsI32`/`mulFitsI32`/`addRangeFitsI32`/`subRangeFitsI32`/
`mulRangeFitsI32` caller that routes through it, plus `exprType`'s own
`strict` magnitude check (type.js) — sees the fact for exactly the duration
of that loop's body emission, nothing more.

Before this: a loop counter is WRITTEN by its own step, so it never
qualified for the pre-existing "closed integer hull for never-reassigned
decls" stamp (`analyze.js`, `writeCount(body,name,0)===0`) — `intExprRange(i)`
was always null, so `opBound`'s magnitude-blind default (2^31 — ONE more
than `0x7fffffff`, so it fails by construction for ANY nonzero second
operand) blocked `i*K`/`i+j`/`B-i` from the native i32 path, cascading into
the vectorizer pattern-matchers (which match the raw `i32.add`/`i32.mul`
shapes) declining. Two independent, REAL proof obligations, both required
(no heuristic fallback for either):
  1. `init` decl/assigns `i` to an expression `intExprRange` can hull (a
     literal is itself; a name chains through its own already-proven
     decl-range/refinement — free composition, same resolver every other
     `intExprRange` consumer shares).
  2. `cond`'s bound `B` also hulls via `intExprRange` — a const bound is
     itself, a chained decl-range bound composes the same way; an
     UNBOUNDED DYNAMIC bound (a raw param, an unproven global) returns
     null and admits NOTHING.
`step` must be a KNOWN POSITIVE integer constant — monotone increase is
what makes the guard's tightened `hi` a true ceiling and the init's `lo` a
true floor. Reassignment elsewhere in the body (closure capture, mid-body
write) is refused by `withRefinements`'s own `isReassigned` gate — not
re-implemented here.

**Scope note (found, not assumed)**: only the literal `for(let i=C;...)`
shape is wired — `init`/`cond`/`step` are read directly off the emitter's
own AST args. A `while`-desugared counted loop (`let i=0; while(i<n){…
i++}`, the shape EVERY stencil kernel in examples/ actually uses) needs a
whole-function prepass to connect the counter's init (a sibling statement,
possibly one clause of a multi-name `let`) to the loop, since `'while'` →
`emitter['for'](null,cond,null,body)` carries no `init`/`step` at the call
site. Not attempted this session — see residual 1 below for why it
wouldn't have recovered the named stencil kernels anyway.

**Recovery (verified, deterministic — not a timing measurement)**: mat4's
`init()` (`for (let i=0;i<16;i++) { a[i]=(i+1)*0.125; b[i]=(16-i)*0.0625 }`
— literally collectBareEscapes' own cited comparison-governed-tolerance
example) is the canonical target. Under the SIZE optimize tier
(`smallConstForUnroll:false`, both `test/bench.js`'s `sizeCompile` and
`bench/bench.mjs`'s `compileJzAt(c,{level:'size'})` disable unrolling, so
this loop stays a real loop instead of constant-folding away): `i+1` and
`16-i` now emit native `i32.add`/`i32.sub` (WAT-confirmed) instead of the
`f64.convert_i32_s`/`f64.add`/`f64.sub` round-trip. Bytes: **1543 → 1528
(-15 B)** — matches the committed `bench/results.json` jz row exactly (see
below) and the task's own "+15 B" framing (this recovers the loop-counter
half of the 16f2d7c8 regression's size cost).

**Per-kernel recovery table** (measured before/after this fix, not
predicted):

| kernel/case | metric | before | after | verdict |
|---|---|---|---|---|
| mat4 | size-tier compile bytes (bench.mjs-exact config) | 1543 | 1528 | **recovered (-15 B)** |
| watercolor | f64x2 (base→sten) | 1→1 | 1→1 | unchanged — residual 1 |
| waves | f64x2 (base→sten) | 3→3 | 3→3 | unchanged — residual 1 |
| schrodinger | f64x2 (base→sten) | 0→0 | 0→0 | unchanged — residual 1 |
| diffusion | f64x2 (base→sten) | 4→4 | 4→4 | unchanged — residual 1 |
| slime | f64x2 (base→sten) | 1→1 | 1→1 | unchanged — residual 1 |
| i32 add arrays (test/simd.js KNOWN-GAP) | hasV128 | false | false | unchanged — residual 2 |
| FFT butterfly (test/cond-vectorize.js/examples.js) | `__bf\d+_` present | false | false | unchanged — residual 2 |
| size sweep | geomean jz/AS | 1.057× | 1.055× | **recovered (mat4's -15 B alone)** |
| perf-ratchet float/mixed | loop-body ops | 565/971 | 565/971 (+0) | unchanged — see below |

**Named residual 1 (watercolor/waves/schrodinger/diffusion/slime stencil
decline)**: investigated to the root, NOT a loop-counter-range gap.
`tryStencil`'s `boundPureInv` (src/optimize/vectorize.js) needs the loop
bound (`w-1`/`h-1`) to already be a raw `i32.sub` IR chain. `w`/`h` in
every one of these kernels trace back to MODULE GLOBALS (`W`,`H` /
`WV`,`HV`) assigned directly from a harness-supplied runtime parameter
(`export let resize = (w,h) => { W=w; H=h; … }`, watercolor.js) with NO
compile-time-provable magnitude bound anywhere in source — genuinely
unbounded, not merely unproven. Confirmed by direct WAT inspection
(`w-1` still lowers as `f64.sub(f64.convert_i32_s($w), f64.const 1)`) and
by measurement: this fix changes NONE of the five kernels' f64x2 counts
(all pairs identical to the pre-fix baseline, matching af08bead's own
prior investigation of the same question).
CONSIDERED AND REJECTED: reusing the pre-existing "comparison-governed,
sound for n≤2^31" STORAGE-TYPING tolerance (`collectBareEscapes`,
`widenLocalTypes`) to also seed an `intExprRange` fact for these globals.
That tolerance is a NAMED, deliberately-scoped, asm.js-style compromise —
"the storage cell re-truncates every read, so wraparound cannot compound"
— NOT a value-exact proof. `intExprRange` is trusted elsewhere (e.g.
`mulRangeFitsI32`'s own doc: "the EXACT product interval must fit signed
i32 — then i32.mul is faithful in every consumer context") as a REAL
magnitude proof. Feeding it a policy-level heuristic would reintroduce
exactly the class of bug 3b50d504/16f2d7c8 closed, just one level higher
— rejected under this ticket's own "the range proof must be REAL" floor.
REAL lever for a future ticket: `tryStencil`'s dispatch already sits next
to the Root F "typed-bounds loop VERSIONING" scaffold (emit.js, `emitter
['for']`), which handles this EXACT situation (an unprovable extent) via a
runtime i64-arithmetic guard + a fast/checked arm split — no static
magnitude proof needed. Teaching `boundPureInv` to accept a
versioned-guard fast arm's bound (instead of demanding a raw i32.sub
chain) is a real, unexplored, structurally-adjacent lever — not attempted
here (a second, larger mechanism, out of this session's scope).

**Named residual 2 (i32-array-addition, FFT-butterfly)**: also investigated,
also NOT a loop-counter-range gap — confirmed by the test files' OWN
pre-existing comments (test/simd.js's KNOWN_GAP, test/cond-vectorize.js's
butterfly comment), independently corroborated here by direct measurement
(both unchanged before/after this fix). `a[i]+b[i]` on two FULL-RANGE
Int32Array elements is genuinely not provably i32-safe (element VALUES,
not the index `i`, are the unbounded quantity — no loop-counter fact
touches this). The real fix lives in `module/typedarray.js`'s
`wrapIntIR` (typed-store value coercion), which — unlike `ir.js`
`writeVar`/`asParamType` — doesn't attempt `narrowI32`'s ring recovery;
FFT-butterfly's `tryButterfly` shape-match loss is attributed to the SAME
family. A different file, a different mechanism, correctly out of scope
here.

**Ratchet**: `test/perf-ratchet.js`'s float/mixed categories measure
UNCHANGED (565, 971, +0) — `scripts/perf-corpus.mjs`'s generators don't
happen to produce a bare counted `for`-loop whose body needs the new
range fact to reach the i32 path. Nothing recovered here →
`perf-ratchet.json` NOT touched (re-tightening would fabricate a result
the compiler doesn't actually produce — same discipline the prior
collectBareEscapes-fix session applied to the identical situation).

**Size**: `node scripts/bench-size.mjs` geomean jz/AS: **1.057 → 1.055**
(mat4 alone; 1 of ~49 sized cases moved). The ≤1.05 goal needs residual 1
and/or 2 above (or further, unrelated size work) — not reachable from this
mechanism alone, reported honestly rather than rounded down.

**Timing spot-check: explicitly NOT performed.** The one genuinely
recovered kernel (mat4) only changed under the SIZE optimize tier
(unrolling off); mat4's TIMED benchmark path (`multiplyMany`, the SPEED
tier) is untouched by this fix — `init()` runs outside the
`performance.now()` window in `bench/mat4/mat4.js`'s own `main()`, and
`multiplyMany`'s outer loop bound (`n < iters`, `iters` a raw function
parameter) is correctly an UNBOUNDED dynamic bound under this same
mechanism's own soundness floor (verified: no spurious i32.mul emitted,
negative control below). There is no runtime-speed-relevant recovered
kernel this session to spot-check — manufacturing a paired timing run
against unchanged codegen would measure noise and report it as evidence,
which is worse than not measuring. Noted honestly instead.

**Negative controls (soundness floor, verified via differential + WAT)**:
  - `for (let i=0;i<x;i++) { s = s + i*1000000000 }` with `x` a raw f64
    param (unbounded dynamic bound): WAT confirms NO `i32.mul` emitted
    (correctly declines); value-correct vs the JS oracle for x ∈
    {0,1,5,50000} (the x=50000 case pushes the product to 1.25e19,
    exercising exactly the magnitude an unsound admission would corrupt).
  - `for (let i=0;i<n;i++) { if (i===3) i=1000000; s=s+i }` (counter
    reassigned mid-body): value-correct vs the JS oracle for n ∈
    {0,1,3,5,10} — `withRefinements`'s `isReassigned` gate refuses the
    fact, exactly as designed.
  - Positive control: mat4's own shape, `for(let i=0;i<16;i++){s=s+(i+1)*3}`
    — value-correct.
  - fuzz 2000×4 (seeds 1-2000, opt {0,1,2,3}, 20 inputs/program): **0
    divergence** (30173 inputs compared, 9827 skipped i32-contract-exceeded,
    0 non-numeric) — every pinned repro from 3b50d504/16f2d7c8/28b2530b/
    d9b020f7/af08bead stays green (full test/inference.js 135/135, incl.
    every structural pin from those sessions).

**bench/results.json**: surgically patched ONLY `cases.mat4.targets.jz
.bytes`: 1543 → 1528 — verified against `bench/bench.mjs`'s EXACT
`compileJzAt(c,{level:'size'})` config (not test/bench.js's `sizeCompile`,
which additionally sets `scalarTypedArrayLen:8`; confirmed both give the
same 1528 for this case). This is a DETERMINISTIC byte count, not a
timing measurement — no quiet-machine gate needed, no ABBA. `medianUs`/
`memKb`/`parity` LEFT UNTOUCHED: `bench.mjs` builds the timed row at
`level:'speed'` (a SEPARATE compile from the size-tier build `bytes`
reads — confirmed in `bench.mjs`'s own comments), and mat4's timed path
is unaffected (see timing spot-check note above) — re-measuring an
unchanged number would just add machine noise to a correct value.
`meta.commit` intentionally LEFT at `f704a077` (partial re-measure, one
field in one row — matches the prior session's precedent for the same
situation). jz-w2c/jz-wasmtime rows NOT touched (different toolchains,
task scope says "jz lane").

**test/bench.js wall-clock suite**: 16 failures present both before and
after this fix (delayline/fft/glyfparse trailing rust-wasm/c-wasm by
1.05-1.3×, several already labeled "[known gap]" in the test file's own
comments; examples-corpus geomean). None touch a kernel this fix's
mechanism reaches (mat4's hot path is unaffected — see above). Wall-clock
rival comparisons against external toolchains (rust/c/zig) on a shared,
not-provably-quiet machine — treated as pre-existing/machine-noise, not a
regression, consistent with their unchanged "known gap" framing.

**Gates, all green**: kernel-parity 33/33 byte-identical (O0/O2/O3);
kernel-oracle 451 assertions/11 suites; optimizer 214 tests/3949
assertions; simd.js 158 tests/580 assertions (i32-array-add KNOWN_GAP
confirmed still correctly triggering — see residual 2); cond-vectorize.js
3/3; examples.js 22 tests/433 assertions (stencil KNOWN GAP assertions
confirmed still correctly triggering — see residual 1); selfhost.js
21/21 (206 assertions); selfhost-perf.js informational 5/5 (warm 1.015×
< 1.03× cap, fresh 0.773× < 0.99× cap); test/inference.js 135/135 (291
assertions); fuzz 2000×4 zero divergence (see above); full `test/index.js`
88-file battery run in ~13 foreground chunks of 6-7 files each (never
monolithic) — every chunk green modulo pre-existing intentional skips;
fresh `npm run build` ×2 — dist/jz.js and dist/jz.wasm byte-identical
both times; full size sweep (`scripts/bench-size.mjs`) — see Size above.

## Status (2026-08-03, collectBareEscapes FALSE-POSITIVE FIXED — the
## reference-refresh top-priority regression (bitwise/sieve, 28b2530b)
## root-caused AND closed; audit-P1-2 kernels + FFT-butterfly + i32-array-add
## investigated and found NOT from this root — a different, already-tracked
## commit (16f2d7c8); soundness pins (28b2530b/d9b020f7) stay green)

**Named false-positive class**: `collectBareEscapes` (src/compile/
analyze-scans.js) recognizes ToInt32-rooted operators via two mechanisms —
`ESCAPE_SAFE_ROOT_OPS` for the binary form (`x ^ y`) and a dedicated check
for `Math.imul`/`clz32` calls — but the recognition was syntactically
incomplete for two SUGAR/WRAPPER shapes of those exact same semantics:
  1. **Compound bitwise-assignment sugar** (`x ^= y` ≡ `x = x ^ y`) wasn't in
     `ESCAPE_EDGE_OPS` (only `=,+=,-=,*=` were) — so `x ^= x << 7` fell to
     the generic value-mode walker, which walks BOTH the assignment target
     (a bare string) and the RHS in `'value'` mode, misreading the compound
     assign's implicit self-read of the target as a bare escape. This is
     bitwise.js's entire PRNG kernel shape (`x ^= x<<7; x ^= x>>>9; x =
     Math.imul(x,…)+…; state[i] = x^(x>>>16)`) — `x` is never compared
     anywhere, so every occurrence blamed it, disqualifying a textbook
     ESCAPE_SAFE_ROOT_OPS var from i32 storage and killing all SIMD lift.
  2. **Math.imul/clz32's multi-arg call is a `,`-headed args-list node**
     (`Math.imul(i,i)` → `['()','math.imul',[',',i,i]]`). The
     `INT_MATH_FNS_I32` branch correctly walks the args list in `'idx'`
     mode, but `,` wasn't in the idx/edge pass-through set (only
     `AFFINE_INDEX_OPS` was), so the pass-through never fired and each bare
     argument name fell to the generic value-mode walker too. sieve.js's
     `for(i=2;i*i<LIMIT;i++)` guard gets rewritten by loop-square.js
     (narrowBoundedSquare, predates 28b2530b) to `Math.imul(i,i)<LIMIT` — `i`
     is then no longer a direct comparison operand, so it was blamed and
     widened to f64, reintroducing a `trunc_sat`/`i32.wrap` pair per
     inner-loop iteration.
Both are "misclassifying a use shape as a bare escape" exactly within the
scan's OWN stated exemption rules (ToInt32-rooted, index-positioned via
Math.imul/clz32) — not a new exemption, a precision fix for how the existing
rules recognize compound-assignment sugar and the call-args wrapper node.

**Fix** (src/compile/analyze-scans.js): added `ESCAPE_ROOT_EDGE_OPS =
new Set(['^=','|=','&=','<<=','>>=','>>>='])`, checked right after
`ESCAPE_EDGE_OPS` — skips the target (same self-referential-write reasoning
`ESCAPE_EDGE_OPS` already relies on) and walks the RHS in `'idx'` mode.
Added `op === ','` alongside `AFFINE_INDEX_OPS.has(op)` in the idx/edge
pass-through condition — lets a multi-arg call's comma-list unwrap under
the SAME mode its caller (the Math.imul/clz32 branch) already established.
Both are narrow, additive predicate extensions — no existing branch's
behavior changed, so 28b2530b/d9b020f7's soundness fixes are untouched
(confirmed: full `test/inference.js` 135/135, all FFT-butterfly/module-
global/compoundAssign value-wrong repros green).

**Recovery table** (WAT-byte-identical to the pre-regression compiler,
16f2d7c8 = 28b2530b^, confirmed via disposable `git worktree` diff on both
full bench sources — not just approximate counts):

| kernel  | metric                        | 28b2530b^ (pre-regression) | HEAD (regressed) | HEAD+fix |
|---------|--------------------------------|-----------------------------|-------------------|----------|
| bitwise | real SIMD instrs (v128\*/i32x4\*/f64x2\*) | 12 | 0 | 12 |
| bitwise | WAT byte-diff vs 28b2530b^     | — | non-empty | **empty (identical)** |
| sieve   | trunc_sat+i32.wrap op count    | 32 | 45 | 32 |
| sieve   | WAT byte-diff vs 28b2530b^     | — | non-empty | **empty (identical)** |
| radixsort (bonus, ledger's "likely same class") | WAT byte-diff vs 28b2530b^ | — | non-empty | **empty (identical)** |

(The task brief's "24 v128 ops" / "0 v128 ops" figures were bisected
against `2aaeaa19`, 75 commits stale — a dirty diff carrying ~15 unrelated
commits' worth of other codegen changes. `28b2530b^` = `16f2d7c8` is the
CLEAN one-commit-back baseline; byte-identical WAT recovery against it is
strictly stronger evidence than any instruction count.)

**audit-P1-2 kernels investigated, found NOT from this root** (verified,
not assumed — honest correction of the task brief's framing): watercolor,
waves, schrodinger, diffusion, slime f64x2 counts measured identical at
28b2530b^ and at HEAD+fix (1/1, 3/3, 0/0, 4/4, 1/1 base→sten pairs) — this
fix changes NONE of them. `test/examples.js`'s own comments already
document their stencil decline as a SEPARATE, pre-existing "P0-2 sibling"
gap (GLOBALS lack an `intExprRange` decl-range fact, so `w-1`/`h-1` bounds
aren't provably i32 — `boundPureInv` in src/optimize/vectorize.js declines)
— attributed to 16f2d7c8, one commit BEFORE 28b2530b, not this one. Same
verdict, same evidence method, for FFT-butterfly (test/simd.js: still
declines post-fix, `__bf\d+_` absent) and i32-array-addition (test/simd.js
KNOWN_GAP: still 0 v128 post-fix) — both already attributed by their own
comments to 16f2d7c8's `addFitsI32`/`wrapIntIR` change. Left their existing
`ok(true, …)`/KNOWN_GAP passthroughs untouched — un-silencing them would be
dishonest (they still correctly decline; the task brief's premise that this
fix would recover them didn't hold up).

**Ratchet**: `test/perf-ratchet.js`'s `float`/`mixed` categories (560→565,
790→971 at 28b2530b) measure UNCHANGED (565, 971, +0) with this fix —
`scripts/perf-corpus.mjs`'s `genFloat`/`genMixed`/`genInt` generators don't
happen to produce either false-positive shape (no compound bitwise-assign
sugar; `Math.imul` args there are always compound sub-expressions, and the
category's final `return acc` is a genuine, CORRECT bare escape 28b2530b
was right to catch). Nothing recovered here → perf-ratchet.json NOT
touched (re-tightening would be fabricating a result the compiler doesn't
actually produce).

**Size**: `node scripts/bench-size.mjs` geomean jz/AS: **1.060 → 1.057**
(bitwise 1.1kB, sieve 1.1kB, both now smaller than their AS -Oz reference —
i32 storage recovery drops the f64 fallback + trunc_sat/wrap machinery).
Small movement (2 of 49 sized cases), most of the 1.05 gap is unrelated —
not chased here, per scope.

**Timing spot-check** (quiet machine, load avg 2.5-3.1/14 cores, no jz
processes running before each measurement; `--paired` ABBA, 4 rounds, one
rival — v8/node — each): bitwise jz 0.91ms vs v8 3.73ms (**4.11× win**, was
a 2.3-3.7x LOSS at the regression per the bisection); sieve jz 4.63ms vs v8
7.08ms (**1.53× win**, was an 8-14x LOSS). Both checksums (`ref`) match
their committed values exactly (3216842766, 3811242000) — correctness
unaffected, this was purely the codegen-quality regression.

**bench/results.json**: re-measured ONLY the `jz` target row for `bitwise`
and `sieve` (the recovered cases), surgically, via `--json=<scratch>` +
manual patch — NOT a full `--json` regen (that flag rebuilds the WHOLE
file from `--targets`/case selection and would have silently dropped all
58 other cases; caught this via `git diff --stat` showing 7171 deletions,
reverted with `git checkout -- bench/results.json` before it could be
committed). New jz rows: bitwise medianUs 10824→907, bytes 1198→1104,
memKb 51648→51760 (noise); sieve medianUs 60282→4627, bytes 1131→1076,
memKb 52896→52624 (noise). `meta.commit` intentionally LEFT at `f704a077`
(NOT bumped) — this is a 2-row partial re-measure, not a full-corpus
refresh, and bumping commit would falsely claim the other 58 rows are
fresh against this session's source commit. Consequence, noted honestly:
`npm run test:claims`'s FRESH check will now correctly report the
evidence stale (this session's src/ commit postdates meta.commit) until a
future full re-measure — expected, not a regression introduced here.
jz-wasmtime/jz-w2c rows for these two cases were NOT re-measured (task
scope says "jz lane", singular; those legs need wasmtime/wasm2c toolchains
and are a separate, larger re-measure).

**Gates, all green**: kernel-parity 33/33 byte-identical (O0-O3); kernel-
oracle 451/451 assertions; perf-ratchet 10/10 (unchanged baselines, see
above); optimizer 214 tests/3949 assertions; simd.js 158 tests/580
assertions (butterfly + i32-add-arrays KNOWN_GAPs still correctly
triggering, unaffected — see above); cond-vectorize.js 3/3; examples.js 22
tests/433 assertions (watercolor/waves/schrodinger/diffusion/slime KNOWN
GAP assertions still correctly triggering); selfhost.js 21/21 (206
assertions); selfhost-perf.js informational, 5/5 (warm 1.011x, fresh
0.774x, both under cap); test/inference.js 135/135 (291 assertions,
includes the two new structural pins below + all pre-existing
28b2530b/d9b020f7/compoundAssign value-wrong repros, confirmed green);
fuzz 2000×4 (seeds 1-8000, opt {0,1,2,3}, 20 inputs/program) — zero
divergence across all 4 independent rounds; fresh `npm run build` ×2 —
dist/jz.js and dist/jz.wasm byte-identical both times.

**New structural pins** (test/inference.js, right after the "safe control"
test): (1) the bitwise PRNG shape (`x ^= x<<7` etc.) must emit ≥1 real
v128/i32x4/f64x2 op under `optimize:'speed'` — 0 before the fix, 12 after;
(2) the sieve `i*i<LIMIT` shape's trunc_sat+i32.wrap op count must stay
≤25 (measures 21 at the fix, 34 at the regression) — an absolute ratchet,
not a self-comparison, so it actually traps a re-regression rather than
just comparing two optimize levels of the same (already-fixed) binary
(caught and corrected this exact mistake in a first draft of the pin).

**Residuals** (out of scope, correctly not touched): watercolor/waves/
schrodinger/diffusion/slime's stencil decline, FFT-butterfly's shape-match
loss, i32-array-addition's vectorize loss — all pre-date 28b2530b
(attributed to 16f2d7c8's `addFitsI32`/`wrapIntIR` change by the tests'
own comments, confirmed unchanged by this fix); the size geomean's
remaining 1.057-1.05 gap (47 of 49 sized cases untouched by this fix);
jz-wasmtime/jz-w2c bitwise/sieve rows in bench/results.json (stale,
pending a fuller re-measure); the other 58 cases in bench/results.json
(unaffected by this fix, correctly left alone).

## Status (2026-08-03, THE REFERENCE REFRESH — COMPLETE, CLEAN, AT HEAD
## f704a077; TWO REAL REGRESSIONS FOUND (root-caused, not fixed this
## session); SIZE GOAL FLIPPED RED; SPEED GOAL STAYS RED, wider than
## the stale evidence showed)

Full 60-case corpus regenerated at HEAD f704a077 (was 2aaeaa19, 75
compiler commits stale) on a genuinely quiet machine (one ~90s Brave
foreground-tab spike mid-session, no timing chunk running during it,
confirmed via `ps`/`uptime` before every chunk; no polluted data
banked). Committed: bench/results.json, bench/bench.svg,
.work/memcheck-results.csv, dist/ rebuilt fresh before the perf gate.

### Recipe followed (11 chunks: 10 x ~6 cases + `jz` case isolated alone,
### `--json` per chunk, merged externally)

`jz` case's OWN self-referential `jz` target (compiling the self-hosted
compiler's OWN corpus through jz.wasm) was excluded from its chunk —
confirmed empirically it costs ~5 minutes for a SINGLE measurement
(timed one attempt to completion) and contributes to no claims gate
(the `jz` case is LAB-set, self-referential, never a rival-comparison
row) — matches the committed evidence's own existing shape (no `jz`
target row for the `jz` case, historically). tinygo lane: verified
working first (`TINYGOROOT=~/.local/tinygo GOTOOLCHAIN=go1.23.6`), landed
43/60 parity-ok rows with ZERO build failures — exactly clears the 42-row
70%-of-60 floor.

### Methodology bug caught and fixed mid-session: GOTOOLCHAIN leaked into
### the plain `go`/`go-wasm` rival lanes

Exporting `GOTOOLCHAIN=go1.23.6` for the whole session (needed for
tinygo, which requires go1.19-1.23) silently forced the SAME pin onto
`go build`/`GOOS=wasip1 go build` too — the system default is go1.26.0,
almost certainly what produced the committed baseline. Caught via the
anomaly scan (many DIFFERENT non-jz rivals — immutable/wordcount/
shapes/matmul/lz's `go`/`go-wasm` rows — all moved together, a rival-side
signature, not jz's). Fix: re-measured `go`+`go-wasm` across all 43
.go-file cases WITHOUT the pin (4 chunks, system go1.26.0) and merged
the corrected rows in. Lesson for next refresh: scope `GOTOOLCHAIN` to
the tinygo invocation only, never export it session-wide.

### ANOMALY VERIFICATION (ABBA rule) — every jz-lane case that moved
### >25% vs committed evidence got a paired (`--paired`, order-alternated)
### re-run, several got 2

REFUTED as single-sample noise (paired re-run matches committed within a
few %, sometimes 2 independent paired rounds): poly, json (jz-w2c leg),
dotprod, shapes (jz-w2c leg), trace (jz-w2c leg), strbuild (jz-w2c leg),
lz (jz-wasmtime leg — settled to 1.09x, inside the normal band). `alpha`
jz-wasmtime's committed value (60us) is itself almost certainly the
fluke, not this refresh — my reading (305-395us across 2 samples) is
internally consistent with alpha's own jz (318-340us) and jz-w2c
(490-611us) siblings on the SAME case; a 60us wasmtime invoke (process
spawn + module instantiate) undercutting a 318us in-process V8-wasm run
on identical logic was never plausible.

CONFIRMED REAL, root-caused (not fixed — out of this session's scope):

- **sieve** and **bitwise**, jz/jz-wasmtime/jz-w2c all 4-14x slower than
  committed (sieve worst: jz-w2c 67142us vs committed 4889us, 13.7x).
  Bisected on a disposable `git worktree` (node_modules symlinked, no
  npm install) across the 75 intervening commits by WAT-shape signature
  (SIMD-instruction count for bitwise, f64-op count for sieve) — both
  land on the SAME single commit, **28b2530b** ("fix
  collectI32SafeIndexVars back-propagation past a bare escape (KNOWN GAP
  #1)"), a genuine i32/f64 SOUNDNESS fix whose `collectBareEscapes`
  scan (analyze-scans.js) is evidently blaming (and f64-widening) a
  loop-index-feeder local in both kernels that should stay i32-exempt
  under its own stated rule ("ToInt32-rooted: bitwise ops, comparisons,
  Math.imul/clz32" — bitwise.js's `x` is pure `^= << >>> Math.imul`;
  sieve.js's `i`/`j` are pure comparison/increment) — the commit's own
  message re-baselined 2 of 10 perf-ratchet categories (float/mixed) but
  had NO ratchet shape matching either kernel's exact pattern, so this
  slipped through un-ratcheted. WAT evidence: bitwise HEAD has 0
  v128/SIMD instructions (ref 2aaeaa19 has 24 — vectorization lost
  outright); sieve HEAD's `$sieve` function stores its outer loop index
  in an `f64` local, doing `i64.trunc_sat_f64_s`/`i32.wrap_i64` every
  iteration to recover an int (ref: 5 f64 ops total in the whole
  function; HEAD: 27). NOT fixed this session (out of scope — evidence
  refresh + verdict, not a fix task); flagged as the top-priority next
  hunt — `collectBareEscapes`'s exemption predicate needs a false-
  positive fix, likely a narrow miss in how it walks the specific
  shift/xor/imul chain or the `i*i`-into-comparison shape.
- **radixsort**, jz/jz-wasmtime/jz-w2c all ~1.4x slower than committed —
  reproduced 4 independent times (2 plain, 2 paired-ABBA), same
  direction and magnitude every time, all three jz-hosted lanes moving
  together (matches the bitwise/sieve SIGNATURE — likely the same
  28b2530b class at smaller relative cost since radixsort's histogram/
  prefix-sum passes are less loop-index-dominated) — not bisected this
  session (time-boxed), flagged as the same-class follow-up.
- **glyfparse**, jz+jz-wasmtime ~1.3-1.45x slower — reproduced 2
  independent times (plain + paired-ABBA), jz-w2c clean both times
  (~1.05x) — smaller, not bisected.
- **sort** (heapsort), the `jz` (V8-node-hosted) lane specifically ~1.5-
  1.6x slower, reproduced 3 times — but `jz-wasmtime` and `jz-w2c`
  (SAME compiled wasm, different host) both match committed evidence
  within a few % every time. This proves the emitted CODE is not the
  regression — isolated to the V8/node execution environment on this
  run (plausibly JIT tier-up sensitivity interacting with this
  session's own CPU baseline from several resident sibling Claude Code
  processes). Recorded honestly since it's what `c.targets.jz` (the
  field the claims gate reads) shows today; a future quiet, sibling-
  free rerun of `sort --targets=jz` alone would settle whether it's
  environment noise or real.
- **bytebeat** and **provenance**, `jz-wasmtime` leg only, ~1.3x,
  reproduced 2 times each — jz/jz-w2c clean both times. Smaller,
  wasmtime-host-specific, not bisected.

### Memory-measurement lesson: the bulk 21-target-per-process chunk run's
### `memKb` column is NOT trustworthy — regenerated narrow-target instead

First attempt reused the bulk run's `jz-wasmtime`/`moonbit` memKb
columns for `.work/memcheck-results.csv` (assuming, per this task's own
framing, that memory is pollution-immune) — got 8/43 beats-or-matches,
median delta +7568KB (jz LARGER), a complete reversal of the historical
40/43 / -1200KB claim, with a suspicious near-constant ~+10MB floor
shift on EVERY case measured in a long (21-target) chunk and ZERO shift
on every case I'd already re-measured narrowly (3-target paired runs).
Root cause not fully chased (plausibly page-cache/VM growth over a
single node process spawning 20+ heterogeneous child toolchains
sequentially over tens of minutes — NOT a jz defect: bitwise/sieve's
`memKb` under the narrow rerun sits at the normal ~14-15MB floor, so the
codegen regression there is genuinely a SPEED-only bug, memory
unaffected). Fix: redid `jz-wasmtime`+`moonbit` in 4 dedicated narrow
(2-target) chunks across all 43 comparable cases, matching the
historical c28f218c precedent's own methodology exactly — result: 40/43
beats-or-matches, median delta -912KB (jz leaner), matching the
committed claim closely. Lesson for next refresh: NEVER derive memcheck
from a bulk multi-target run's memKb column, even though sizes/bytes
from the same run stay trustworthy — always the dedicated narrow-target
pass.

### Self-host perf gate — quiet-machine datum (the publication-quality
### number this refresh set out to get)

`node test/selfhost-perf.js` after a fresh `npm run build` (dist/jz.wasm
byte-reflects HEAD f704a077), machine confirmed quiet immediately
before: **warm geomean 1.024x** (cap 1.03x, PASS — first round, no
retry needed) — mat4 1.02 fft 1.03 biquad 1.02 sort 1.03 crc32 1.04
mandelbrot 1.01; **fresh geomean 0.772x** (cap 0.99x, PASS) — mat4 0.72
fft 0.79 biquad 0.77 sort 0.78 crc32 0.80 mandelbrot 0.76. Comfortably
under both caps on the first try — audit-#8's "warm margin exhausted
under load (1.041-1.078 then 1.020)" finding was, as that entry itself
suspected, a load artifact: this quiet reading is the honest number.
NOT re-baselined (per this task's explicit instruction) regardless of
outcome — it passed clean, nothing to re-baseline.

### `npm run test:claims` full verdict at HEAD f704a077 (11 test groups,
### 25 assertions, 4 pass / 7 fail) — SEE "Goals" section below for the
### per-axis scorecard this updates

FRESH: PASS (both axes — results.json meta.commit and
memcheck-results.csv's `# commit:` header both read f704a077, 0 stale
commits; watr 5.7.12 installed == 5.7.12 in evidence). COMPLETE: PASS,
all 11 named rivals clear the 42/60 floor (c-wasm 50, rust-wasm 50,
go-wasm 43, **tinygo 43 — first time ever contested, was 0/60**,
zig-wasm 43, as 49, v8 57, deno 57, bun 57, jsc 57, porf-native 42
exactly-at-floor). WINNING: FAIL on all three leadership axes (wasm
rival, V8-family, bun/jsc) — full red lists below. Tight-int-loop
exception (vm/dict/crc32 vs bun/jsc, 1.5x band): PASS, 0 exceeded. SIZE:
**FAIL, newly red** — geomean jz/as 1.060x vs the 1.05x par cap (was
1.016x at the stale snapshot), 25/49 cases smaller (was 27/49) — a
real, unchased regression, plausibly the cumulative byte cost of the
several soundness-guard additions since 2aaeaa19 (bigIntOperand's
runtime undef-check, dict/Map absent-key throw paths, catch/finally
marker resets, JSON scalar-ingress boxing, receiver-HASH/map-value-
census machinery) — not bisected this session.

Full detail, credited/discredited rivals, and the goal-by-goal scorecard
is in the "Goals" section below (kept as the single source of truth for
gate status rather than duplicated here).

## Status (2026-08-03, audit-#8 P0-4 — Part 1 (JSON scalar ingress) and
## Part 3 (unary BigInt maybeUndefined residual) CLOSED; Part 2 (decl-init
## wall) RE-ATTEMPTED, NEW self-host miscompile found, REVERTED and banked)

Three-part session against the last represented-boolean-carrier remainder
from carrier-invariant-design.md, plus a genuinely new self-host finding
surfaced while re-attempting the wall.

### Part 1 — JSON.stringify/JSON.parse scalar-argument ingress (MECHANISM A)

Repro (verified live at HEAD a919446a, all optimize levels):
`export let f = (s) => JSON.stringify(s ? 1 : false)`.

| case | before | after | JS |
|---|---|---|---|
| `JSON.stringify(s?1:false)`, s=1 | `"1"` | `"1"` (unchanged) | `"1"` |
| `JSON.stringify(s?1:false)`, s=0 | `"0"` | `"false"` | `"false"` |
| `JSON.stringify(s?true:1)`, s=1 | (raw 1) | `"true"` | `"true"` |
| `JSON.stringify(s?true:1)`, s=0 | `"1"` | `"1"` (unchanged) | `"1"` |
| `JSON.stringify([1,2],null,s?2:true)`, s=1 | 2-space indent | 2-space indent (unchanged) | 2-space indent |
| `JSON.stringify([1,2],null,s?2:true)`, s=0 | 1-space indent | compact (no indent) | compact |
| `JSON.parse(s?true:1)`, s=1 | `1` (number) | `true` (boolean) | `true` |
| `JSON.parse(s?true:1)`, s=0 | `1` | `1` (unchanged) | `1` |

Mechanism: array/object/Map/Set element storage already routes ambiguous
BOOL∪NUMBER merges through `storedValue` (the carrier-invariant-design.md
MECHANISM A chokepoint, promoted to src/bridge.js in an earlier session) —
`__json_val`'s runtime dispatcher already discriminates a genuine number
from a boxed TRUE_NAN/FALSE_NAN atom correctly (checks "not NaN" before any
pointer-type test) whenever it's GIVEN a properly-boxed atom. The leak was
purely at JSON.stringify/JSON.parse's own SCALAR ARGUMENT ingress
(module/json.js): `asI64(emit(x))`/`asF64(emit(x))` — a raw, un-boxed
emission — at three sites: the `value` argument (line ~1474), the `space`
argument (line ~1473, same class — a boolean `space` must mean "no
indentation" per spec, which only holds if `__json_setgap` sees a genuine
atom, not the collapsed 0/1), and JSON.parse's ToString-coercion argument
(line ~1611–1629, feeding the generic `toStrI64`/`__to_str` dispatch, which
has the identical "not NaN → number" first-check ordering as `__json_val`).
Fixed by routing all three through `storedValue`/nothing-else-needed —
`__json_val`/`__to_str`/`__json_setgap` needed no changes; they already do
the right thing once given a real atom. Array/object elements needed no
fix either (already boxed at construction). Sweep of the rest of json.js's
value-ingress sites (replacer path, JSON.parse's shape-parser fast path)
found no same-class leak: the replacer either rejects at compile time
(runtime function replacer) or is const-folded (array replacer, host-side,
never emits IR); the shape-parser's `x` argument is structurally proven
STRING before reaching that path, ambiguous merges never resolve STRING.
Gates: test/json.js (67/67, 6 new assertions across 3 new tests), test/
bool-identity.js (7/7, unaffected — confirms no regression), kernel-parity
33/33, kernel-oracle 11/11, full battery (below).

### Part 2 — the decl-init wall (kernel-oracle 'captured-then-read' row 11)

STAYS BANKED. Chased the previously-parked dict-O2/O3 divergence
(carrier-invariant-design.md, 2026-08-01 entries) to a NAMED mechanism —
built a kernel from the UNGUARDED `storedValue(init)` variant in a worktree
and WAT-diffed native-vs-kernel `count$exp` (the dict corpus's own compiled
function) directly at O2, not just comparing byte counts. Named: SELF-HOST
GENERATIONAL DRIFT. `storedValue`'s non-ambiguous branch is `carrierF64`,
which boxes EVERY VAL.BOOL-typed init (not just an ambiguous BOOL∪NUMBER
merge — src/ir.js: `valTypeOf(node) === VAL.BOOL ? boolBoxIR(emitted) :
asF64(emitted)`) — so turning `storedValue` on at every decl reboxes every
plain `let ok = a > b` throughout self.js's OWN source, reshaping the
self-hosted kernel binary enough to shift watr's inliner decisions for
UNRELATED target programs. Confirmed benign in itself (WAT-diff showed only
inliner boilerplate — extra locals, an extra zero-init — around a helper
call in the dict corpus's compiled `count$exp`, never a changed VALUE
computation; zero fuzz/oracle mismatches).

The fix this session actually needs is narrower than `storedValue` — the
wall's repro (`let v = x > 0 && 1; …`) only needs the AMBIGUOUS-MERGE half.
emit.js already has exactly that half as `argIR` (line ~1195):
`hasAmbiguousBoolMerge(node) ? emitIdentitySafe(node) : emit(node)` — whose
non-ambiguous branch is the bare `emit(node)` the decl site already calls,
so `val = viewInit || argIR(init)` should be BYTE-IDENTICAL to today for
every decl that isn't itself an ambiguous BOOL∪NUMBER merge. Verified live:
kernel-parity's full byte-identity corpus (33/33, dict included) stayed
byte-identical with this substitution — the generational-drift chain above
genuinely never fires with the narrower gate.

BUT a SECOND, DIFFERENT self-host miscompile surfaced, one the parity
corpus's 11 programs don't exercise: test/kernel-oracle.js's 'closure' AGREE
row — `export let make = (n) => { let total = 0; const add = (x) => {
total += x; return total }; for (let i = 0; i < n; i++) add(i); return total
}` (a captured-and-MUTATED outer binding, jz's `ctx.func.boxed` heap-cell
path) — compiled via the resulting self-hosted kernel and thrown at
`new WebAssembly.Module()`:
```
WebAssembly.Module(): Compiling function #5 failed: local.set[0] expected
type f64, found local.get of type i32 @+525
```
Genuinely INVALID WASM, not a shape/size difference — this is NOT the
dict-O2/O3 class. Isolated with a clean 3-way worktree A/B (pre-Part2 HEAD:
compiles cleanly; Part-2-only patch: reproduces the failure deterministically
across repeated runs; Parts 1+3 alone, which ALSO edit compiler source: self-
host cleanly, closure test passes) — proves the cause is specifically the
`argIR(init)` substitution at the decl site, not "any edit to emit.js is
unsafe." First-pass localization (native `compile(scripts/self.js, {wat:
true, optimize:false})`, diffed with vs without ONLY this substitution — no
self-host build needed to see the divergence, ~200MB WAT each): the compiled
locals inside `src/prepare/index.js`'s `resolveCallee` — an unrelated
PREPARE-phase function that calls no boxed-closure logic itself — shift by
exactly one synthetic temp name and everything downstream renumbers.
Consistent with `argIR`'s call-site TEXT change in emitDecl.js shifting the
GLOBAL `temp()` counter while compiling THE COMPILER'S OWN source, which is
normally harmless UNLESS it collides with a latent watr inliner/local-
coalescing sensitivity — the same outline-hunt self-host-miscompile CLASS
this ledger has resolved before (the export-loss MECHANISM C entry,
carrier-invariant-design.md, 2026-08-03 — itself a dedicated hunt), but a
NEW, not-yet-root-caused instance. Root-causing precisely which decl near
`resolveCallee` reacts and why the renumbering trips watr's optimizer is a
multi-probe-cycle hunt on its own (~6-8 probes spent this session: A/B
isolation to Part 2, WAT-diff localization to `resolveCallee`, source read
of `resolveCallee`/`isDeclared`/`resolveScope`/`hasFunc` for an obvious
ambiguous-merge decl — none found directly, so the mechanism is the temp-
counter-shift-collides-with-inliner hypothesis, not yet nailed to a single
line) — not closed this session, per its own explicit "bank if not cleared"
instruction.

REVERTED: `src/compile/emit.js`'s decl-init line stays `viewInit ||
emit(init)` (see that line's own comment for the full finding, dated
2026-08-03, "ATTEMPTED AGAIN, STILL BANKED"). test/kernel-oracle.js's
'captured-then-read' PENDING-FIX row (and the sibling 'computed member key
read (named local, ...)' shape the same fix would have closed as a side
effect) both stay PENDING-FIX/undocumented, unchanged from before this
session. NEXT: start from the `resolveCallee` compiled-local shift (cheap,
no self-host build needed to reproduce) and trace exactly which decl's
compiled shape changes and why watr's optimizer reacts badly to it.

### Part 3 — unary '-'/'~' on a maybeUndefined-BIGINT operand

Repro (verified live at HEAD a919446a, Map AND dict-dynamic-key, native):
`export let f = () => { const m = new Map(); m.set('x', 1n); return
-m.get('missing') }`.

| case | before | after | JS |
|---|---|---|---|
| `-m.get('missing')` (Map, absent) | garbage float (e.g. `-1.1125e-308`) | `NaN` | `NaN` |
| `~m.get('missing')` (Map, absent) | `0` | `-1` | `-1` |
| `-d[k]` (dict, DYNAMIC key, absent) | garbage float | `NaN` | `NaN` |
| `~d[k]` (dict, DYNAMIC key, absent) | garbage | `-1` | `-1` |
| `-d['missing']` (dict, LITERAL key) | `NaN` (unaffected — see below) | `NaN` (unchanged) | `NaN` |
| `-m.get('x')` (Map, PRESENT key, 5n) | `-5n` (internal), `NaN` at the export boundary (separate pre-existing gap, see below) | unchanged | `-5n` |
| `D['missing']++`/`--`/prefix forms | already `NaN` (unaffected — see below) | unchanged | `NaN` |

Mechanism: `emitNeg`/the `'~'` handler's `valTypeOf(a) === VAL.BIGINT`
branch always did raw `asI64(emit(a))` i64 arithmetic on the operand,
unconditionally — for a maybeUndefined-BIGINT operand (a dict/Map
absent-key soundness carve-out, same class P0-3 closed for binary ops)
that reinterprets the UNDEF_NAN sentinel's bits as a bogus bigint. Real
JS: ES2024 13.5.6 UnaryMinus / 13.5.9 BitwiseNOT ToNumeric a SINGLE
operand — undefined's ToNumeric is the Number NaN — with no second
operand to type-mismatch against, so there's no throw (contrast
bigintMixReject's binary-op TypeError); the real value is just NaN (`-`)
or ToInt32(NaN)'s complement, `-1` (`~`) — a genuine NUMBER, never a
BigInt. Fixed via `bigIntUnary` (emit.js, unary twin of `bigIntOperand`):
same `censusMaybeUndefinedKind`+`isUndef` runtime guard, but SELECTS a
value (canonical NUMBER NaN/-1 atom) instead of throwing. Representation-
safe: BigInt values already ride in an f64-typed carrier via `fromI64`
(BigInt has no NaN-boxed self-description of its own), so substituting a
genuine f64 NUMBER bit pattern into that same slot is compatible with
every existing consumer — no dual-type ABI problem.

NOT touched (verified already sound or out of scope):
- `d['missing']++`/`--` (bracket LITERAL-key member increment/decrement,
  both prefix and postfix): unaffected by the underlying bug in the first
  place — `VT['[]']`'s own array-vs-property disambiguation resolves a
  non-canonical-numeric string-literal key to `null` BEFORE reaching the
  dict census (same gap bigIntOperand's own doc comment already
  documents), so `bigintMemberAssignTarget`'s `valTypeOf(a[1]) ===
  VAL.BIGINT` gate is never true for that shape — it falls to the
  generic, already-sound `n + 1`/`n - 1` spelled-out form.
- `d[k]++`/`--` (DYNAMIC-key member increment/decrement): verified live,
  not assumed — already gives the correct `NaN`/`-1` today, same
  generic-form reasoning (traced but not fully root-caused why the
  dynamic-key case doesn't hit the raw-i64 member-op path either;
  empirically confirmed sound, not chased further).
- The KNOWN NARROWER GAP P0-3 already documented (two independently
  maybeUndefined-BIGINT operands both genuinely absent in the SAME binary
  expression) is orthogonal to unary ops (single operand) — not applicable
  here.

FOUND, VERIFIED, EXPLICITLY OUT OF SCOPE (a genuinely separate, pre-existing
bug, confirmed present at HEAD a919446a BEFORE this session, via worktree
differential — not caused nor fixed by this session's change): a function
whose return is `-Map.get(presentKey)`/`~Map.get(presentKey)` (or the dict-
dynamic-key sibling) on a BIGINT-census receiver decodes WRONG at the JS
export boundary even for a REAL, present-key bigint value — `-5n` crosses
as a raw (often NaN-shaped, since a small-magnitude negative i64's top 12
bits are all 1s — IEEE754 exponent 0x7FF) float instead of a BigInt.
Root: `src/compile/index.js`'s `isBoundaryWrapped`/`func._resultNumeric`
export-wrapper decision misclassifies this return shape as a proven plain
NUMBER, so the export never gets the i64-reinterpret `$name$exp` wrapper a
genuine BigInt-typed export needs (confirmed via WAT dump: the exported
function IS `$make` directly, `(result f64)`, no `$make$exp` sibling).
INTERNAL arithmetic is correct (verified via `-m.get('x') === -5n`
strict-eq comparisons INSIDE the function, never crossing the boundary as
a bare bigint) — this fix's own test pins (test/dyn-keys.js) use that
internal-comparison technique specifically to isolate this fix's
correctness from the separate export-boundary gap. Flagging for a future
session; not chased here (out of Part 3's scope, and a `_resultNumeric`/
narrow.js investigation, not a `bigIntOperand`-class fix).

Gates: test/dyn-keys.js (20/20, 2 new tests / 10 new assertions), test/
statements.js (202/202, unaffected), kernel-parity 33/33, kernel-oracle
11/11, full battery (below).

### Gates (all green before commit, fresh dist reflecting Parts 1+3 only —
### Part 2 reverted before the final build)

- Native full battery: ~90 test files run individually (not the monolithic
  test/index.js runner), chunks of 4-7, foreground. All pass — zero new
  failures; pre-existing skips unchanged (array-methods.js 1, objects.js 3,
  unsigned.js 1 — confirmed pre-existing, unrelated to this session).
- kernel-parity: 33/33 byte-identical (11 corpus × 3 opt levels), against a
  freshly rebuilt dist/jz.wasm reflecting Parts 1+3 (Part 2 reverted).
- kernel-oracle: 11/11 (451 assertions) — unchanged from HEAD baseline (no
  rows flipped; Part 2's attempted flips reverted alongside its code).
- perf-ratchet: 10/10, every row +0 (int/float/mixed/cond/buf/nest/slice/
  ring/condref/fgather unchanged — neither Part 1's json.js storedValue
  calls nor Part 3's bigIntUnary touch any ratchet kernel's codegen shape).
- optimizer: 214/214. json.js: 67/67. data.js: 125/125. booleans.js: 17/17.
  bool-identity.js: 7/7. minimal-output.js: 79/79.
- selfhost.js: 21/21 (fresh dist, reflecting the final Parts-1+3-only
  source — the FIRST selfhost.js run in this session used a STALE
  pre-session dist/jz.wasm, since kernel-target.js's `getSelfModule` only
  auto-builds when dist/jz.wasm is MISSING, not when stale; caught and
  corrected by explicitly rebuilding before the final gate pass — a
  process note for future sessions: always force a fresh `npm run build`
  before trusting ANY kernel-leg gate, don't rely on the auto-build-if-
  missing fallback).
- selfhost-perf: 5/5 informational — warm geomean 1.005× (cap 1.03×),
  fresh geomean 0.779× (cap 0.99×), both under cap.
- fuzz: 2000 programs × optimize {0,1,2,3} (seeds 1..2000, 20 inputs each,
  30173 compared, 9827 skipped i32-contract-exceeded) — 0 divergence.
- Size spot-check (mat4/fft/crc32/biquad, native compile, `-O2` +
  `host:'wasi'`, via bench's own module-graph resolution): 4438B / 5184B /
  3030B / 6776B — byte-identical against a worktree build of unmodified
  HEAD (a919446a). Zero bytes added to every pure-numeric kernel (neither
  Part 1's JSON fix nor Part 3's BigInt fix touch code any of these four
  benchmarks exercise).
- `npm run build` × 2, foreground: `dist/jz.wasm` and `dist/jz.js`
  byte-identical (SHA-256 matched) across both fresh builds, AFTER Part 2
  was reverted (the Part-2-included build was explicitly NOT shipped —
  caught by the kernel-oracle 'closure' row failing `new
  WebAssembly.Module()` validation before any build made it past this
  session's own gate).

### Process note: git stash near-miss

Mid-investigation, a `git stash push --keep-index -- src/compile/emit.js`
was run to diff against HEAD (a violation of this repo's own "NEVER git
stash" rule) — caught immediately, `git stash pop` restored the file
before any other command ran, zero data loss, confirmed via `git status`/
`git diff` immediately after. Recorded here per the same "point defects
immediately" discipline this ledger holds every other finding to. Future
sessions: use `git show HEAD:path > path` or `git worktree add` ONLY for
any HEAD-vs-working-tree differential, as this repo's own instructions
already say — no exceptions for "just a quick check."

## Status (2026-08-03, audit-#8 P0-3 + P1-1 CLOSED — BigInt absent-key join;
## stale host-decode marker after in-wasm catch/finally)

Two independent error-semantics defects, both verified live at HEAD
(e79b0647), both fixed and gated on native + kernel legs.

### P0-3 — BigInt absent-key join reads garbage instead of throwing

Repro (every optimize level, Map AND dict, native and kernel):
`const m = new Map(); m.set('x',1n); export let f = () => m.get('missing')
+ 1n`.

| case | before | after | JS (13.15.3 step 6) |
|---|---|---|---|
| `m.get('missing') + 1n` | `9221120245631025153n` | `throws TypeError` | `throws TypeError` |
| `D['missing'] + 1n` (dict, dynamic-key literal-provable write) | `9221120245631025153n` | `throws TypeError` | `throws TypeError` |
| `n -= m.get('missing')` (compound assign) | garbage bigint | `throws TypeError` | `throws TypeError` |
| `m.get('missing') & 3n` (bitwise) | garbage bigint | `throws TypeError` | `throws TypeError` |
| `m.get('x') + 1n` (present key — structural pin) | `2n` | `2n` (unchanged) | `2n` |
| `-m.get('missing')` (unary minus — single operand, OUT OF SCOPE) | garbage bigint | garbage bigint (unchanged, see below) | `NaN` |
| `D['missing']++` (increment — single operand, OUT OF SCOPE) | `1` (unaffected — dedicated non-bigintMixReject path) | `1` | `NaN` |

Spec: ES2024 13.15.3 ApplyStringOrNumericBinaryOperator. `undefined`'s
ToNumeric is the Number NaN (step: ToPrimitive(undefined)=undefined, not
BigInt → ToNumber(undefined)=NaN); step 6, "If Type(lnum) is not
Type(rnum), throw a TypeError" — a Number NaN against a genuine BigInt
mismatches → throw. This is the SAME contract bigintMixReject already
proves at compile time for a literal-provable mix; the fix is its runtime
twin for a maybeUndefined operand, whose type only resolves at runtime.
Unary ops (negation, `~`, `++`/`--`) ToNumeric a SINGLE operand with no
second-operand type to mismatch against — real JS decays to NaN there, not
a throw — so they're deliberately untouched (own doc comment on
`bigIntOperand`, src/compile/emit.js); `D['missing']++` already had its OWN
dedicated non-bigintMixReject codepath (the '+1'/'-1' member op, added
2026-07-31 specifically to STOP routing increment through the binary '+'
mix-check) so it was never in scope either.

Mechanism: `censusMaybeUndefined` (src/kind.js) already routed the NUMBER
arm of `toNumF64` (ir.js) through a maybeUndefined-safe coerce, but its own
doc comment there admitted the gap: "never BIGINT: real JS THROWS mixing
BigInt and undefined in arithmetic... left exactly as unsound as today, not
newly broken, not closed by this fix" — this session closes it. Chokepoint:
a new `bigIntOperand(node)` (src/compile/emit.js, right after
`bigintMixReject`) replaces the raw `asI64(emit(node))` read at every
bigintMixReject call site (binary `+ - * / % & | ^ << >>`, their
compound-assign forms) — ONE decision, substituted mechanically at each
site, same altitude as toNumF64's Slice-1 join. When
`censusMaybeUndefinedKind(node) === VAL.BIGINT`, it emits a runtime guard:
read the raw f64 carrier into a temp, check it against UNDEF_NAN
(`isUndef`), and only THEN reinterpret to i64 — throwing
`ERR.BIGINT_UNDEF_MIX` (new TypeError-class code, err-codes.js, message
"Cannot mix BigInt and other types, use explicit conversions" — V8's own
wording) via the standard `global.set $__jz_last_err_bits` +
`throw $__jz_err` runtime-throw idiom (module/collection.js's
ITERATE_NULLISH is the precedent pattern) when it IS the sentinel. A
non-maybeUndefined node (the overwhelming common case — present-key/local
BIGINT) degrades to a bare `asI64(v)`, byte-identical to before —
confirmed by the mat4/fft/crc32/biquad byte-identical spot-check below
(zero-cost structural pin).

FOUND MID-FIX, FIXED IN THE SAME COMMIT: the FIRST version of this fix
gated on `valTypeOf(node) === VAL.BIGINT`, which is FALSE for a
`dict['stringLiteralKey']` bracket read — VT['[]'] (kind.js ~443-448)
resolves a non-canonical-numeric string-literal key to `null` (its own
sound array-vs-property-read disambiguation) BEFORE ever reaching the
dict-value-census fallback, so `valTypeOf` is not a reliable "is this
dict/Map read's census kind bigint" proxy the way it is for a plain local.
`censusMaybeUndefined` itself already bypassed that gate correctly (calling
`dictValueKindOf`/`mapValueKindOf` directly, per its own "RECEIVER-KIND
GUARD" doc comment precedent) but only returned a boolean, discarding the
resolved kind. Refactored `censusMaybeUndefined` (kind.js) into
`censusMaybeUndefinedKind(node)` — returns the resolved VAL kind or null —
with `censusMaybeUndefined = (node) => !!censusMaybeUndefinedKind(node)` as
a pure boolean wrapper (behavior-identical for every existing NUMBER/STRING
consumer: ir.js toNumF64/toStrI64, emitLooseEq, module/console.js
writePart). `bigIntOperand` checks the KIND directly instead of
`valTypeOf`, closing the dict-bracket-string-key blind spot the first
attempt missed — caught by the SAME differential repro used for the Map
case, extended to dict before landing.

KNOWN NARROWER GAP (documented in `bigIntOperand`'s own comment, not
closed): true ES semantics only throws when the two operands' RUNTIME
types actually DIFFER — `m.get('a') + m.get('b')` with BOTH keys
genuinely absent at once is Number NaN + Number NaN = NaN, no throw. This
fix independently guards each operand, so the double-absent case throws
instead of yielding NaN — strictly better than the prior silent-garbage-
bigint answer (an unsound VALUE became a sound-but-slightly-wider THROW,
never a wrong number) and matches the fix's own brief ("the runtime
semantics for the absent case must be the thrown TypeError"). Fully
correcting it would require the census to let an expression's runtime
TYPE flip between BigInt-shaped and Number mid-expression — a materially
bigger architectural change, out of proportion to this P0 point-fix.

### P1-1 — stale $__jz_last_err_bits after an in-wasm-handled error misdecodes a later genuine trap

Repro (audit's exact two-phase shape, both same-call and later-call-on-
same-instance variants, pinned in test/errors.js, both legs):
```
export let catchIt = () => { try { JSON.parse('{bad json') } catch (e) {} ; return 1 }
export let boom = (n) => { let a = new Float64Array(n); return a.length }
```
`catchIt()` then `boom(2**34)`.

| call sequence | before | after | JS-authority expectation |
|---|---|---|---|
| catch JSON error in-wasm, then OOM trap, SAME call | `SyntaxError` (stale) | `RuntimeError` | genuine trap, undecoded |
| catch JSON error in-wasm, then OOM trap, LATER call | `SyntaxError` (stale) | `RuntimeError` | genuine trap, undecoded |
| escaping (uncaught) throw — sanity, must stay decoded | `SyntaxError` | `SyntaxError` (unchanged) | `SyntaxError` |
| `try { throw } finally { return }` (finally swallows) then later trap | `SyntaxError` (stale) | `RuntimeError` | genuine trap, undecoded |

Mechanism: `interop.js`'s `decodeThrown` already resets
`$__jz_last_err_bits` on every decode it PERFORMS (audit-#7 P1, 2a973082)
— but an error CAUGHT fully in-wasm (a `try`/`catch` the module handles
without rethrowing) never reaches `decodeThrown` at all: execution just
continues past the catch, no exception crosses the host boundary, so that
reset path never runs. The 'throw' emitter (src/compile/emit.js) writes
the marker immediately before every throw; nothing ever consumed it for
the in-wasm-handled case, so it stayed pointing at the handled error
indefinitely. A LATER genuine WASM trap (OOB, stack overflow, allocation
failure — none of which touch `$__jz_err` at all) reaches
`interop.js`'s `isMarkedTrap` check, sees the stale nonzero marker, and
misdecodes the trap as the old, already-handled error.

Fix, two sites in src/compile/emit.js's 'catch'/'finally' emitters, both
zeroing the marker as soon as the thrown value is BOUND (before the
handler/cleanup body runs, mirroring decodeThrown's own "consume on every
decode" idiom):
- `'catch'`: `['global.set', '$__jz_last_err_bits', ['i64.const', 0]]`
  right after `['local.set', $errName]`, before the handler IR. A `throw`
  inside the handler (rethrow or a new error) re-arms the marker via the
  'throw' emitter, so escaping-throw decode is unaffected.
- `'finally'`: same zero right after `['local.set', $errLocal]`, before
  `throwCleanup`. Two outcomes, both correct: cleanup falls through
  normally → the EXISTING rethrow re-sets the marker to the real bits
  right before `throw` (unchanged code, already there); cleanup itself
  terminates early (`return`/`break` in the `finally` block — JS spec:
  this SWALLOWS the pending exception) → the rethrow is dead code, marker
  stays zeroed instead of dangling at the now-suppressed error.

Belt-and-braces (interop.js): every export wrapper (scalar-module,
rest-params, and plain paths) now zeroes the marker at CALL ENTRY too —
defense-in-depth against raw-instance reuse or any as-yet-unmissed
in-wasm consume gap, cheap (one write per call).

FOUND MID-FIX, FIXED IN THE SAME COMMIT: the belt-and-braces reset (and
decodeThrown's own PRE-EXISTING unconditional reset) can throw — WATR's
OWN generic optimizer (`watr/optimize`, external package, run after jz's
whole pipeline — src/optimize/watr-tail.js) independently downgrades
`$__jz_last_err_bits` from `(mut i64)` to a plain immutable global
whenever EVERY throw site referencing it folds away for a given compiled
module (e.g. `typeof BigInt("1") === "bigint"` — no dynamic input can ever
reach a throw, so literally no `global.set` survives anywhere in that
specific module). Writing `.value` on an immutable `WebAssembly.Global`
throws `TypeError: Can't set the value of an immutable global`
unconditionally per the JS API spec — caught by
`test('bigint: typeof recognizes BigInt values')` in the FIRST native
battery chunk. Fixed by probing writability ONCE per instance
(`lastErrBitsWritable`, interop.js: set the global to its own current
value inside try/catch — an immutable global rejects that identically to
any other write) and gating every reset (decodeThrown's pre-existing one
included — same latent gap, same fix) on that flag.

### Gates (all green before commit)

- Native full battery: 90/90 test files, chunks of 4-7, foreground. All
  pass except 1 pre-existing unrelated skip (data.js Date-arg edge, not
  touched) — same as pre-fix baseline.
- Kernel leg (`JZ_TEST_TARGET=jz.wasm`): 65/65 kernel-includable files
  (KERNEL_EXCLUDE minus the forced-explicit ones), chunks of 4-7,
  foreground. 18 failures in test/inference.js's dict-value-census
  white-box tests (`ctx.scope.globalReps` introspection — the host `ctx`
  singleton is structurally never populated when compilation delegates
  into the self-hosted wasm, same documented class as test/invariants.js's
  own onKernel() guard) — CONFIRMED PRE-EXISTING via a worktree build of
  unmodified HEAD (e79b0647): byte-identical 18/18 failures, same names,
  same count, before any of this session's changes. Not a regression;
  out of this fix's scope (unrelated compiler-internals test, not error
  semantics).
- errors.js: 126/126 native, 126/126 kernel (two pre-existing P1 pins from
  2a973082 gated `if (onKernel()) return` — `maxMemory` is a host-side
  compile option kernel-target.js's own docstring already disclaims as
  non-marshaled across the wasm compile ABI, confirmed by direct repro:
  the OOM ceiling silently doesn't apply in-kernel, unrelated to marker
  logic). Two NEW cross-leg pins added for the audit's exact two-phase
  repro (same-call and later-call variants) — these don't need
  `maxMemory` (use an oversized `Float64Array` allocation for the genuine
  trap instead), so they run and pass on BOTH legs.
- data.js, dyn-keys.js, optimizer.js, minimal-output.js: run standalone,
  100% green (125/125, 17/17, 214/214, 79/79).
- kernel-parity: 33/33 byte-identical (11 corpus × 3 opt levels).
- kernel-oracle: 11/11.
- perf-ratchet: 10/10, every row +0 (int/float/mixed/cond/buf/nest/slice/
  ring/condref/fgather all unchanged — the catch/finally marker-zero only
  adds bytes to EH-using modules, the bigint gate only to census-bigint
  shapes; none of the ratchet's numeric kernels touch either).
- selfhost.js: 21/21.
- selfhost-perf: 5/5 (informational; warm 1.014× / fresh 0.792× vs V8,
  both under their caps).
- fuzz: 2000 programs × opt {0,1,2,3} (seeds 1..2000, 20 inputs each,
  30173 compared) — 0 divergence.
- Size spot-check (mat4/fft/crc32/biquad, native compile, `-O2`
  benchlib-hosted): 1713B / 3650B / 1196B / 2383B — byte-identical against
  a worktree build of unmodified HEAD (e79b0647). Zero bytes added to
  every pure-numeric kernel, confirming the structural pin.
- `npm run build` × 2, foreground: `dist/jz.wasm` and `dist/jz.js`
  byte-identical (SHA-256 matched) across both fresh builds.

### What remains of the maybeUndefined program

- The narrower "both operands independently maybeUndefined-BIGINT and both
  genuinely absent" case throws instead of the spec's NaN (documented
  above, in `bigIntOperand`'s own comment) — would need the census to
  allow a runtime type flip mid-expression; not attempted.
- Unary negation / `~` / `++`/`--` on a maybeUndefined-BIGINT operand still
  ride the raw i64 path (garbage bigint instead of the spec's NaN) — real,
  narrower, DIFFERENT-semantics gap (single-operand ToNumeric decay, never
  a throw), explicitly out of this fix's scope per its own brief
  (bigintMixReject call sites only). Next candidate if this class of bug
  gets re-audited.
- test/inference.js's dict-value-census white-box tests have no
  `onKernel()` guard despite being structurally kernel-incompatible
  (confirmed pre-existing, unrelated to this session) — a hygiene gap,
  not touched here (out of scope; flagging for whoever next touches that
  file).

## Status (2026-08-03, audit-#8 P0-2 CLOSED — Map/dict value-census blind to
## writes captured in a nested closure)

Repro (verified live at HEAD 8182e465, all optimize levels, native and
self-host): `const m = new Map(); m.set('x',1); export let f = () => {
[0].forEach(() => m.set('y','oops')); return m.get('y') + 1 }` → jz `"oops"`
before this fix, JS-authority `"oops1"`. Dynamic-dict sibling (`d[k]=v`
inside the same shape) reproduced identically.

| case | before | after | JS |
|---|---|---|---|
| Map, forEach-captured `.set` | `"oops"` | `"oops1"` | `"oops1"` |
| dict, forEach-captured `[]=` | `"oops"` | `"oops1"` | `"oops1"` |

Two mechanisms, both verified by reading before landing:
1. The census walks stopped dead at any nested `=>` — `mapValueTypeOf`/
   `dictValueTypeOf` (src/compile/analyze.js, same-body local half) AND
   `observeProgramSlots`'s `visit` (src/compile/program-facts.js, the
   whole-program `{fresh:true}` half) each had a blanket `if (op === '=>')
   return`. A `.set()`/`[]=` write inside a callback was invisible to
   either half, so a receiver's census kind could go stale after a real
   mutation.
2. `nameEscapes` (program-facts.js) does not treat a receiver-position
   captured use (`m.set(...)` inside a nested `=>`) as an escape — but this
   turned out to be correct and unrelated to capture depth: ESCAPE_SKIP
   exempts `.`/`?.` receiver slots UNCONDITIONALLY, capture or not, because
   a receiver read never aliases the name to a second binding. The prior
   doc comment (kind.js ~286) listed "captured" alongside the real
   aliasing uses (assigned/passed/stored/returned), implying nameEscapes
   was the capture-safety net — false; it never was, and was never meant to
   be. Corrected in place (kind.js) rather than left misleading.

CHOSEN DIRECTION: (a) — census observes THROUGH nested closures, gated on a
shadow-bail, rather than (b) blanket capture-disqualification. Rationale:
more observations only ever tighten or poison the existing first-wins-then-
clash join, never loosen it (append-only lattice) — so seeing into a
closure is sound by the same argument the census's own poison-on-clash
already rests on. (b) would have thrown away the dominant real-world shape
(`arr.forEach(v => m.set(k, v*2))`) for zero soundness gain. New shared
helper `collectAllBoundNames` (src/ast.js) computes, for an arrow subtree,
every name ever bound there (as a param or a nested let/const/var target,
recursing through further nesting) — position-insensitive on purpose (a
mid-body shadow disqualifies the WHOLE subtree, not just the tail after it)
per the audit's own "track scope or bail on shadow" instruction, same
precedent as analyze.js's scanBindingUses CAPTURE rule (over-bailing only
forfeits a fact, never unsound). Wired at three points, kept consistent as
instructed: analyze.js's `dictValueTypeOf`/`mapValueTypeOf` (local half) and
a new `observeNestedDictMapWrites` inside program-facts.js's
`observeProgramSlots` (global half) — the latter deliberately scoped to
ONLY the dict-`[]=`/Map-`.set()` write shapes (not the schema-slot/`.prop=`
census sharing the same `visit` walker), keeping this fix's reach exactly
at the audit's P0-2 boundary.

SHADOW / CONTROL RESULTS (all pinned in test/dyn-keys.js, both native and
kernel legs):
- Numeric captured-write control (`arr.forEach(v => m.set('k', v*2))` then
  `m.get('k')+1`): correct AND keeps the census win — proven via a
  pre-fix/post-fix wasm byte-size diff on the exact source (worktree at
  8182e465 vs this fix, `-O2`): 21592 → 21531 bytes, a whole block of
  dtoa/Ryu-algorithm locals the polymorphic `+` fallback needs disappears
  from `$f` — this shape was ALSO silently pessimized before (not just the
  string shape was wrong; the numeric shape lost its fast path too, same
  root cause), so the fix recovers an optimization, not only a value.
- Shadow control (nested fn with its OWN `m` param writing strings): does
  NOT poison or misattribute into the outer census — `const g = (m) => {
  m.set('k','str') }; g(new Map()); m.set('k',2); return m.get('k')+1`
  correctly returns `3` (matches JS), same both legs.
- Read-only capture control (`forEach(() => m.get('x'))`): does not
  disqualify — census stays live, `6` both legs.
- Additional adversarial pins run ad hoc (not committed, satisfied):
  double-nested capture (`forEach(()=>forEach(()=>m.set(...)))`), dict
  `+=` inside a capture, and a genuinely-polymorphic captured write (still
  correctly poisons to the runtime path) — all matched JS.

GATES (all before commit, all green): fresh `npm run build` × 2 (once
foreground after being auto-backgrounded past the 120 s default, once
explicit foreground with a blocking wait on the PID) — dist/jz.wasm,
dist/jz.js, dist/interop.js sha256-identical both times. test/dyn-keys.js
pins: 17/17 (38 assertions) native AND kernel leg (JZ_TEST_TARGET=jz.wasm).
Full battery: all 88 test/index.js files run in 15 foreground chunks of
4-7 (dyn-keys and data run explicitly as their own gate items) — 0
failures, 0 unexpected skips. kernel-parity: 3/3 (33 assertions)
byte-identical. kernel-oracle green (same run). perf-ratchet: 10/10, every
category at `+0` delta (int/float/mixed/cond/buf/nest/slice/ring/condref/
fgather) — census-reach change produced NO dyn-path shift on the ratchet's
own corpus, no re-baseline needed. optimizer green (4192 assertions).
selfhost.js: 21/21 (206 assertions). selfhost-perf.js: informational,
both caps comfortably met (warm 1.022×/cap 1.03×, fresh 0.771×/cap 0.99×).
fuzz.js --count=2000: 2000 seeds × opt{0,1,2,3}, 30173 inputs compared, 0
divergence. Size spot-check: dict/fftplan/mat4/crc32/biquad/sort/
provenance/mandelbrot/fft compiled `-O2` byte-identical before/after
(worktree differential at 8182e465) — the fix's blast radius is exactly
the Map/dict-in-closure shape, nothing else moved.

BindingId ownership (the audit's named long-term item) still buys, later:
a real per-binding identity instead of the syntactic-name keying every
census here shares (dict/map value, dynWriteVars, nameEscapes, arrResized
all key by bare string name) would let a shadowed nested binding be
censused on its OWN account instead of being blanket-excluded via
collectAllBoundNames' conservative bail — recovering the (currently
forfeited) fact for the shadowing closure's OWN receiver, and closing the
same aliasing gap `dictValueKindOf`'s nameEscapes gate patches structurally
(a real alias-of-`d` binding vs `d` itself would be distinguishable, not
just detected-and-bailed). Not attempted here — out of a P0 task's scope,
same standard the P0-3 __errcls__ per-class-schema-id path used.

Commit: pushed to origin/main.

## Status (2026-08-03, audit-#8 P0-1/2/3 CLOSED — three independent
## instanceof/Error-object soundness failures, all verified live at HEAD;
## P2 README fix folded in)

Three roots, found live minutes after Slice A/B (commits 38c7dde5/
2a973082) shipped the sound instanceof/Error-object model:

1. **Default-mode bypass (P0-1).** jzify/transform.js has ALWAYS had its
   OWN, separate `'instanceof'` handler (predates Slice A/B), and
   src/front.js only runs the sound prepare/emit machinery AFTER jzify —
   which runs in default mode, not strict. Slice B's truth table was only
   ever exercised in strict mode; default mode kept answering the Error
   family via jzify's old `typeof===object` guess. Repro: `let e = new
   TypeError("x"); e instanceof RangeError` → `true` default mode (JS:
   `false`). FIX: jzify's handler now passes Array/Map/Set/TypedArray/
   ArrayBuffer/the-7-Error-classes straight through as a real
   `['instanceof', val, rhs]` node (`CORE_INSTANCEOF_ALLOW`, jzify/
   transform.js, built from the same two arrays prepare's own
   `INSTANCEOF_ALLOW` uses) instead of guessing — same op, same answer,
   both modes now. Sideline fix required: src/compile/flow-types.js's
   `extractRefinements` only recognized the OLD `__is_map`/`__is_set`/
   `__is_typed` call shape for `instanceof Map`/`Set`/TypedArray
   flow-narrowing (`.has()` devirtualization to `__map_has`/`__set_has`) —
   added a matching `op === 'instanceof'` arm (`instanceofRefinement`) so
   default mode keeps the same devirtualization strict mode already had
   (caught by test/inference.js's extractRefinements pins going red).
2. **Numeric provenance leak (P0-2) — a DESIGN ERROR in §4 itself, not an
   implementation slip.** The internal-code range arm
   (`emitErrorInstanceof`, src/compile/emit.js) tested an internally-thrown
   NUMBER against err-codes.js's derived `ERR_CODE_RANGES` and called a
   match `instanceof <class> === true`. Unsound by construction: a
   jz-internal code and a user's own `throw <number>` are the SAME
   representation (a raw NaN-boxed NUMBER) — nothing distinguishes them.
   Repro: `export let f = x => x instanceof SyntaxError; f(300)` → `true`
   for an ARBITRARY CALLER INT that happened to land in SyntaxError's
   derived range (300-302/311-318) — nothing to do with JSON.parse. FIX:
   deleted the range arm outright. Internal-code catches are now honestly
   `instanceof`-false for every Error class (same treatment as any other
   non-Error thrown value); a provably-NUMBER LHS now folds to a
   compile-time `false` too (strictly sounder AND cheaper than before —
   `vt !== VAL.OBJECT` alone, the `&& vt !== VAL.NUMBER` carve-out is gone).
   `err-codes.js`'s `ERR_CODE_RANGES` export stays, unused by `instanceof`
   now, banked as the exact data a future catch-site materialization
   (design doc §7 Slice C) would key off of — that recovery path was
   judged too large/novel to land safely inside this P0 task (a genuinely
   new gated-inclusion mechanism, not reuse) and was deliberately NOT
   attempted; the honest minimum (deletion + both-modes pin + design-doc +
   README correction) shipped instead. test/errors.js's internal-code pins
   (JSON.parse SyntaxError, Array#with OOB RangeError) flipped true→false,
   both modes, with the mechanism recorded inline.
3. **__errcls__ public/mutable/enumerable (P0-3).** The class-identity
   schema slot (design doc §1) was documented "never spellable in source"
   but nothing enforced it: `e.__errcls__ = 2` compiled and silently
   flipped `instanceof`; the slot showed up in Object.keys/JSON.stringify/
   for-in. Investigated the preferred fix (a distinct schema id per class,
   deleting the slot outright — identity would live in the pointer's aux
   bits for free): `ctx.schema.register` (module/schema.js) dedupes PURELY
   by prop-list content with no per-caller "force a distinct id" — 7
   classes needing 7 ids would mean 7 different prop lists (breaking the
   shared `.message`/`.name` slot layout) or register-signature surgery
   across every caller (object literals, prepare's schema tracking, JSON.
   parse's runtime schema cache). Ruled structurally out of reach for a P0
   fix — same "genuinely unbounded, no way to enumerate every site with
   confidence" standard the design doc's own PTR.ERROR rejection (§1) used.
   Landed the documented fallback instead, and went further than its own
   stated floor: `ERR_CLS_SLOT` (now exported, err-codes.js) is rejected at
   prepare time in both dot-read and dot-write position AND as an
   object-literal key (src/prepare/index.js); excluded from every
   enumeration emitter (Object.keys/values/entries/for-in in module/
   object.js, JSON.stringify's runtime walk in module/json.js); AND
   excluded from the dyn GET/SET/DELETE dispatch itself (module/
   collection.js's `schemaKeyEqPublic` + the del-arm's matching guard) —
   which closes the COMPUTED-key vector too (`e['__errcls__'] = 1` can no
   longer flip `instanceof`; `e['__errcls__']` reads `undefined`, not the
   real classIdx), better than the "documented residual" floor the task
   allowed. All gates on `ctx.features.error` (zero cost for programs that
   never construct an Error) — jz string literals are content-deduped
   (module/string.js `dataDedup`/`strPoolDedup`), so the runtime key
   comparison is exact pointer equality, not a text scan. Remaining,
   unaudited residual: object-SPREAD construction (`{...e, x:1}`) — lower
   risk (needs an existing Error to spread from) and out of this session's
   scope.
README (audit-#8 P2, folded in): README.md's "differences with JS" (~230)
and "will never support" (~251) bullets still described the PRE-Slice-A
model (errors are message strings, no `.message`/`.name`/`instanceof`) —
stale since 38c7dde5/2a973082 landed, independent of the three P0s above.
Rewritten to state the current split: constructed errors are real objects
throughout (in-wasm and at the host boundary); internal runtime-raised
errors stay raw numeric codes, `.message`/`.name` undefined, `instanceof`
honestly `false` (consistent with the P0-2 correction).

GATES (all before commit, all green): repro table (3 repros × both modes,
before→after, JS-authority values) — see .work/error-object-design.md's
"As-landed corrections" section for the exact table. test/errors.js:
124/124 (276 assertions) native, both-mode instanceof truth table (isBoth
helper, extends the harness per the task brief) plus new __errcls__ pins.
Full battery: 88 test/index.js files run in 13 foreground chunks of 4-7
(never monolithic) — 2 real regressions found and fixed along the way
(test/inference.js's extractRefinements Map/Set devirtualization pins;
test/warnings.js's now-obsolete 'untagged-instanceof' pin, rewritten to
assert NO warning). kernel-parity 33/33 assertions byte-identical.
kernel-oracle 451/451 assertions. Kernel leg (JZ_TEST_TARGET=jz.wasm)
errors.js: 122/124 — the 2 failures (host-decode maxMemory/OOM-trap-timing
tests) confirmed PRE-EXISTING via differential stash test (git stash the 8
touched src files, rebuild dist/jz.wasm, same 2 failures at unmodified
HEAD; git stash pop, rebuild, confirmed restored) — unrelated to this
session, banked as existing kernel-leg debt, not blocking. fuzz.js
--count=2000: 2000 seeds × opt{0,1,2,3}, 30173 inputs compared, 0
divergence. selfhost.js 21/21 (206 assertions). selfhost-perf.js 5/5
assertions, both caps comfortably met (warm 1.017×/cap 1.03×, fresh
0.772×/cap 0.99×) — machine has foreign load per the task's own caveat,
informational only regardless. Fresh `npm run build` × 2 (actually × 3,
once more after the stash/pop differential test) byte-identical: dist/
jz.js 1968.6 kB, dist/jz.wasm 15732.5 kB, identical sha256 every time —
self-host fixed point confirmed unperturbed by the `toStrI64`-adjacent
edits. Size spot-check (scripts/bench-size.mjs): mat4/fft/crc32/biquad
byte-identical before/after (differential stash test, same technique).
One error-using module's delta (try/throw new RangeError/catch/instanceof,
optimize:watr): 616B → 630B, +14 bytes — the cost of a SOUND instanceof
check replacing a wrong permissive one, plus the __errcls__ dyn-dispatch
guards, on a program that actually exercises the changed paths.

Commit: pushed to origin/main.
## built, verified correct, NOT landed: zero corpus benefit + a real watr
## regression; one independently-sound precision fix kept)

STRATIFICATION RETRY 2026-08-03 (the 2026-07-29 "PARALLEL WAVE" item 3
blocker — watr inliner — was PROVEN NON-REPRO 2026-08-01; this session
retried the lever per that unblock): built the full proven-STRING-key
core split — module/collection.js dynSetBody(coerceIR) template (shared
by __dyn_set and a new __dyn_set_sk, mirroring the pre-existing
__str_concat/__str_concat_raw precedent) plus __dyn_get_sk_t/__dyn_get_sk
(the hash-then-delegate tail __dyn_get_t already had, pulled out so a
proven-string call site can reach __dyn_get_t_h without the ToPropertyKey
hop) — wired at the two proven-key chokepoints (emit-assign.js dynSetCall's
step-4 `keyType === VAL.STRING` fork; array.js dynLoad's opaque-receiver
`keyType === VAL.STRING` fork).
DECISIVE BUG FOUND AND FIXED (this is what the 5 non-repro inliner attempts
never had — a REAL repro, just not the inliner): first build broke pin B
live (`JSON.parse+o[k]` → NaN at every opt level, native, no self-host or
inlining involved) — NOT the watr-inliner ghost. Root cause: THREE separate
call sites hardcode the exact function-name strings `'__dyn_get'`/
`'__dyn_set'` to decide whether schema-table population / memo-cache resets
/ array dyn-move machinery are needed (src/wat/assemble.js's `tblConsumed`
schema-table-population gate AND its `__clear`-reset gate for
`$__dyn_get_cache_off`/`$__dyn_props`/`$__dyn_props_filter`; module/core.js
`lengthNeedsDynArm`; module/array.js `needsArrayDynMove`) — introducing new
function NAMES that reach the identical schema/cache logic through a
different call path silently defeats all three (schema table never
populated → schema-arm reads return UNDEF_NAN; this is exactly item 5's
named memo-cache suspect, generalized: not a cache SOUNDNESS bug, a cache/
table POPULATION bug from name-string gating). Fixed by adding the new
names to all three gates; both pins verified green after
(`a.name=7;a.shift()` = 1; `JSON.parse+o[k]` = 6) at O0/O2/O3, NATIVE AND
KERNEL (12/12).
SIZE VERDICT: zero benefit. wordcount unchanged at 16131B (jz) / 16013B
(+wasmopt) either side of this work — its Ryu-free state predates this
session entirely, already achieved by the UNRELATED 2026-07-29 cross-call
array-elem lattice fix (the `words[toks[i]]` / `probes[j]` STRING-kind
propagation that made wordcount's dyn-get sites hit array.js's PRE-EXISTING
`vt===VAL.HASH && keyType===VAL.STRING` → `__hash_get_local` direct-call
fast path, which already bypassed __dyn_get_t/ToPropertyKey/Ryu entirely —
confirmed by WAT dump: zero __dyn_set/__dyn_get*/__to_str/__ftoa symbols in
compiled wordcount at HEAD). Full 68-case bench:size corpus (--json, exact
bytes) BYTE-IDENTICAL before/after across every case except one: watr (the
self-hosted-compiler size case) REGRESSED 257301→258068B (+767B jz,
267570→268259B +689B wasmopt) — paying for the near-duplicate
__dyn_set_sk core body with no module ever shedding __to_str because of it
(watr's own source has plenty of unproven dyn-keys, so the coercing
__dyn_set stays included regardless; the proven-key sites just get a
second, mostly-redundant function to call instead of shrinking anything).
geomean jz/AS unchanged 1.060× (identical per-case). condref (the +371B
inline-shift case from the original blocked attempt) shows +0 in
perf-ratchet's op-count ratchet (10/10 baselines unchanged) — the
inline-choice shift does NOT recur with this implementation.
VERDICT: NOT LANDED. Honest boundary per the retry brief: a size-neutral-
or-negative result lands only if dep-graph cleanliness alone justifies it;
here it's a NET REGRESSION on the one case that engages it, with zero
benefit anywhere else in the corpus, plus a nontrivial audit surface (three
hardcoded name-gates now needing upkeep for names nothing currently
produces). Reverted the __dyn_set_sk/__dyn_get_sk_t/__dyn_get_sk cores and
their emit-site wiring in full (module/collection.js, module/array.js,
module/core.js, src/wat/assemble.js all back to HEAD).
KEPT: one line in emit-assign.js's tryHashRmwFusion — its `inc(...,
'__dyn_set')` was UNCONDITIONAL even though `__dyn_set` is only reachable
from the function's non-HASH fallback arm; a PROVEN-HASH receiver
(`at === VAL.HASH`, the `counts[w] = (counts[w]|0)+1` dictionary-counting
idiom) takes an early-return probe/load/store branch that never calls
`__dyn_set` at all. Narrowed to `at === VAL.HASH ? [] : ['__dyn_set']`.
Kept despite zero corpus benefit (same reason — nothing in the 68-case
corpus has ONLY this arm as its sole would-be __dyn_set reacher) because
it's independently sound: no new function, no duplication cost, strictly
more precise reachability, can only ever shrink a module, never grow one —
a legitimate dep-graph correctness fix found en route, not a speculative
lever.
MEMO-CACHE VERDICT: the item-5 concern ("__dyn_get_t_h's single-entry memo
cache as the corruption suspect") — the cache itself ($__dyn_get_cache_off/
$__dyn_get_cache_props) is a MODULE-LEVEL GLOBAL, not a per-function local;
inlining a caller can never duplicate it, so it was never the soundness
hazard the 2026-07-29 diagnosis suspected (consistent with the 2026-08-01
non-repro verdict). The REAL interaction risk, found live this session,
was the __clear-reset gate (src/wat/assemble.js ~line 889) keying off the
exact string `'__dyn_set'` to decide whether to reset the cache/tables on
`__clear()` — a proven-key-only module reaching the cache through a
differently-named writer would silently carry stale (off→propsPtr) state
across a round boundary. Real, would have been the corruption class the
original attempt's "watr inliner" theory was reaching for (just via a
different mechanism); reverted along with the rest of the split since the
writer name (`__dyn_set_sk`) doesn't exist in the shipped tree.
GATES RUN (final kept state — the one-line emit-assign.js change): full
correctness battery in foreground chunks of 4-7 (timeout 600000 each) —
88/88 test/index.js files green (a few pre-existing `# skip` rows,
unchanged); kernel-parity 33/33 byte-identical (fresh dist rebuild);
kernel-oracle green; perf-ratchet 10/10 all deltas +0 (incl. condref, see
above); optimizer green; dyn-keys/data/json/perf explicitly green;
selfhost.js 21/21; selfhost-perf informational 5/5 (geomean bands
unchanged); fuzz 2000×4 (seeds 1-2000, 2001-4000, 4001-6000, 6001-8000) —
zero divergence all four rounds; full bench:size sweep byte-identical to
pre-session baseline on every case; watr corpus (test/index.js watr, 304/
304 in its chunk) green. Fresh `npm run build` ×2, foreground: dist/jz.js,
dist/jz.wasm, dist/interop.js byte-identical both builds.

## Status (2026-08-03, DECL-INIT WALL export-loss mechanism ROOT-CAUSED AND
## FIXED — src/compile/emit.js's decl-init local-storage coercion ladder;
## full details .work/carrier-invariant-design.md "EXPORT-LOSS MECHANISM
## ROOT-CAUSED AND FIXED" entry)

The kernel-scale "total export loss for every program" miscompile banked
across three prior hunts (RE-CHARACTERIZED, ROOT-CAUSED, TAG-PRESERVING
REBOX — all in carrier-invariant-design.md) is now actually named: NOT an
unlocalized native self-compile miscompile, but a real bug in emitDecl's own
local-storage coercion ladder (`localType==='i32' ... : toI32(val)`) —
`toI32` (ECMAScript ToInt32, NaN→0) applied to a storedValue-boxed BOOL
carrier atom (TRUE_NAN/FALSE_NAN — both NaN bit patterns) collapses every
boxed boolean to i32 0. Landing storedValue at the decl site made
`prepare/index.js`'s `defFunc`'s `const exported = ...` decl feed exactly
this path, permanently zeroing `funcInfo.exported` for every function the
resulting kernel ever compiled. FIXED: the ladder now takes ir.js's
(previously unused) `unboxBoolIR` for a BOOL-typed init instead of `toI32`.
NO-OP at HEAD (kernel-parity 33/33, kernel-oracle 451/451, battery
3232/0/6); PROVEN live with the storedValue substitution (fresh dist/jz.wasm
exports correct at every optimize level) then REVERTED per the wall's own
convention — decl site stays `emit(init)`. Gates run with the fix alone (no
substitution): kernel-parity 33/33, kernel-oracle 451/451, battery 3232/0/6
(18832 assertions), opt0 3232/0/6, opt3 3232/0/6, wasi 3231/0/6, wasm-target
2517/20/6 (the 20 failures confirmed PRE-EXISTING — identical count/names
against the unpatched baseline kernel, unrelated census/host-decode feature
gaps), optimizer 214/214, fuzz 2000×4 zero divergence, perf-ratchet 10/10
+0, selfhost.js 21/21, selfhost-perf.js warm 1.007× (cap 1.03×) / fresh
0.795× (cap 0.99×), size spot-check matches the historical baseline exactly
(mat4 1.5kB, fft 2.3kB, crc32 1.1kB, biquad 1.8kB). WALL STAYS CLOSED: a
SEPARATE, unrelated divergence (test/kernel-parity.js 'dict' corpus entry,
O2/O3 only, ~3% kernel WAT size difference, no BOOL-atom coercion involved)
surfaces the moment storedValue goes live at every decl — a different
MECHANISM A site or one of the 13 PENDING-FIX oracle rows the design doc's
"Order + gates" section already gates production changes behind. NEXT (for
whoever reopens the wall): native-vs-kernel WAT diff on 'dict' at O2, same
method as this hunt (extract+diff the compiled function, don't guess).

## Status (2026-08-03, Error-object model Slice B LANDED — `instanceof` subset;
## internal-code `.message` (optional Slice C) is the only thing left, per
## .work/error-object-design.md — its own §Open-questions verdict: a pure
## priority call, not an engineering one)

Implemented the design's Slice B scope: `.work/error-object-design.md` §4/§7.
`instanceof` is a real op now — `src/op-policy.js`'s blanket `REJECT_OPS`
entry is gone; `src/prepare/index.js` validates the RHS against a closed
allowlist (`INSTANCEOF_ALLOW`) and `src/compile/emit.js` folds a
statically-proven LHS to a constant or emits a tag/aux/schema compare.
**STRICT MODE ONLY reaches this code** — jzify's own (pre-existing, separate)
`instanceof` transform (jzify/transform.js:483) rewrites every `instanceof`
shape in default mode BEFORE prepare ever sees a raw node (Array→
`Array.isArray`, Map/Set/TypedArray→`__is_map`/`__is_set`/`__is_typed`,
7 Error classes→a compiler warning + a `typeof x==='object'` fallback,
everything else→the same silent fallback, no rejection at all) — this
handler+emitter is simply unreachable there. Confirmed empirically (not
assumed): `x instanceof Object` and `x instanceof SomeUserClass` both compile
successfully in DEFAULT mode today, before AND after this slice, via jzify's
coarser fallback — untouched, out of this design's stated file list, flagged
here as a real but pre-existing scope boundary, not a regression.

**Truth table as landed** (LHS kind × RHS → result; JS-authority column cites
ES2024 13.10.1/OrdinaryHasInstance for the classes below; instanceof on a
primitive/null/undefined is `false`, never a throw, for any real constructor
RHS — no divergence there):

| RHS | LHS | JS truth | jz (strict mode) | mechanism |
|---|---|---|---|---|
| `Array` | `[]`/`new Array()` | true | true | fold (`valTypeOf`=ARRAY) |
| `Array` | `new Map()` | false | false | fold |
| `Array` | `42`/`null`/`undefined` | false | false | fold or `PTR.ARRAY` tag compare |
| `Map` | `new Map()` | true | true | fold |
| `Map` | `new Set()` | false | false | fold |
| `Set` | `new Set()` | true | true | fold |
| `ArrayBuffer` | `new ArrayBuffer(8)` / typed `.buffer` | true | true | fold or `PTR.BUFFER` tag |
| `ArrayBuffer` | `new Float64Array(1)` | false | false | tag compare |
| `Int8Array`…`Float64Array` (8 ctors, `TYPED_ELEM_NAMES`) | matching ctor, OWNED or VIEW storage | true | true | fold (literal/`typedCtor` rep) or `PTR.TYPED`+aux compare, `TYPED_ELEM_VIEW_FLAG` masked off so a view and an owned array of the same element type both match |
| typed ctor | different element type | false | false | fold or aux mismatch |
| `Error` | `new TypeError(x)`/any of the 7 | true | true | every built-in extends `Error` — schema-tag-only check (no errcls slot read), or literal-shape fold `rhs==='Error' \|\| always` |
| `TypeError`/…/`EvalError` (specific subclass) | matching class | true | true | tag+schema+`__errcls__`-slot compare, or literal-shape fold `ctorClassName===rhs` |
| specific subclass | a DIFFERENT one of the 7 (sibling, or base `Error`) | false | false | siblings/base never satisfy a subclass — same compare, naturally false |
| any of the 7 | internal coded throw (a NUMBER, e.g. `JSON.parse` SyntaxError) in that class's `ERR_CODE_RANGES` | true (models the class the code represents) | true | contiguous-range `f64.ge`/`f64.le` compare(s), ORed with the schema arm; base `Error` unions every class's ranges |
| any of the 7 | internal coded throw in a DIFFERENT class's range, or a non-error throw (`42`, `"s"`) | false | false | range/schema both miss — NaN-boxed pointers fail ordered f64 compares "for free" (IEEE754), no extra guard needed |
| `Object`/`Function`/`RegExp`/`Promise`/user binding/computed expr | — | (real JS: usually true/false via prototype chain) | **compile-time reject** | jz has no prototype chain — see divergences |

**Documented divergences** (all cite `.work/error-object-design.md`):
1. **`BigInt64Array`/`BigUint64Array` excluded from RHS entirely** — a wall the
   design doc's own table didn't flag. `layout.js`'s `encodeTypedElemAux`
   collapses BOTH to the *identical* aux (base code 7 | `TYPED_ELEM_BIGINT_FLAG`
   16 = 23 for both — no bit distinguishes them once static ctor knowledge is
   lost). Extended the design's own §4 "WeakMap/WeakSet are tag-indistinguishable
   from Map/Set → reject, don't guess" precedent to this case, since the design
   didn't anticipate it. This is *why* the task scoped Slice B to "the 8
   TypedArray ctors" (`TYPED_ELEM_NAMES`, layout.js) rather than the design
   prose's literal `TYPED_CTORS` (autoload.js, 14 names) reference.
2. **`DataView` excluded** — not new (the design's own RHS table never listed
   it), but confirmed as a second real collision while implementing: a
   `DataView` descriptor's aux is `TYPED_ELEM_VIEW_FLAG` alone (base code 0,
   no element type) — bit-identical to a VIEW `Int8Array` (`new
   Int8Array(buffer)`, aux = `TYPED_ELEM_CODE.Int8Array`(0)|`VIEW_FLAG`). Same
   tag-indistinguishable reasoning.
3. **`Float16Array`/`Uint8ClampedArray` excluded** — NOT a collision (their
   extra flag bit is unique, so they're actually runtime-distinguishable) —
   simply out of shipped scope, omitted for symmetry with #1 rather than
   partially widening the 8-name allowlist.
4. **`WeakMap`/`WeakSet` explicitly excluded from `INSTANCEOF_ALLOW`** — per
   design §4 (fold to Map/Set at parse, "no GC → weakness unobservable",
   tag-indistinguishable from a real Map/Set at the point instanceof would
   run). Verified this fires from BOTH angles: the pre-existing ctor-level
   strict-mode reject (`new WeakMap()` itself errors) AND my own
   `INSTANCEOF_ALLOW` check independently rejecting `x instanceof WeakMap` on
   an already-valid `x` that never touched a WeakMap constructor.
5. **Everything else** (`Object`, `Function`, `RegExp`, `Promise`, a user
   function/class binding, a computed RHS expression) — loud compile-time
   reject, exactly as designed: `instanceof: unsupported right-hand side...
   jz has no prototype chain`.

**Rejection inventory** (all pinned in test/errors.js): `Object`, `Function`,
`RegExp`, `Promise`, `DataView`, `BigInt64Array`, `BigUint64Array`, `WeakMap`,
`WeakSet`, a user function binding as RHS. Every case fires from
`src/prepare/index.js`'s new `'instanceof'` handler (`INSTANCEOF_ALLOW`
membership + `shadowsBuiltin` guard), replacing `op-policy.js`'s old blanket
`REJECT_OPS.instanceof` entry (deleted).

**Pre-existing Slice A bug found and fixed** (not new Slice B scope — a real
latent gap Slice B's own strict-mode testing surfaced): `ctx.features.error`'s
whole-program scan (`src/prepare/index.js`, added in Slice A) only recognized
`node[1]` as a bare class-name STRING. `new X(args)` — the overwhelmingly
common shape, WITH or WITHOUT args, as long as parens are present — parses as
`['new', ['()', X, args]]`: the class name sits one level DEEPER than the scan
looked, so it was silently missed. Only a parenless bare `new X` (`['new',
X]`, no parens at all — unusual, never constructs with an argument) or a
no-`new` bare call `X(args)` (`['()', X, args]`, already flat) were ever
caught. This ONLY manifested in STRICT mode: default mode's jzify pass
happens to flatten `new X(args)` to `['()', X, args]` (module/core.js's Error
emitters work identically with/without `new`) BEFORE prepare ever runs,
sidestepping the nesting entirely — which is why Slice A's own `String(e)`/
`` `${e}` `` tests (default mode, no `{strict:true}`) passed cleanly despite
this gap. Confirmed live: `jz('...new TypeError("t")...` `${e}`...', {strict:
true})` returned `""` (empty) before the fix, `"TypeError: t"` after — and the
identical shape made EVERY strict-mode `instanceof <ErrorClass>` on a bound
name silently return `false` for a genuinely matching object (the schema arm
never got emitted; only the internal-code range arm, which correctly
evaluates false against a NaN-boxed pointer per IEEE754 — so the compound bug
was "quietly wrong," not a crash). Fixed by extending the scan condition to
unwrap the nested `['()', X, args]` shape — mirrors the `'new'` handler's own
unwrap a few lines below, one function in the same file. Verified: every
Slice A default-mode test still green; every new Slice B strict-mode
Error-instanceof test (exact class / sibling / base-`Error` hierarchy /
internal-code range) now correct.

**Gates, all green:**
full battery (88 files, chunks of 6, foreground) · errors.js 122/122 (232
assertions, up from 117/184 — replaced the stale `strict rejects: instanceof`
pin with an RHS-rejection pin + 5 new instanceof test blocks) ·
minimal-output.js unaffected (instanceof-free/Error-free modules: additive
dispatch-table entries never reached) · kernel-parity 33/33 byte-identical ·
kernel-oracle 11/11 · perf-ratchet 10/10 (+0, every baseline unchanged) ·
optimizer 293/293 · fuzz.js 2000 programs × opt{0,1,2,3}, 30,173 inputs
compared, 0 divergence · selfhost.js 21/21 (206 assertions) against a FRESH
`npm run build` · two fresh `npm run build` rebuilds byte-identical to each
other (SHA-256 `e6df55ff…` both times, `dist/jz.wasm`/`dist/jz.js` — the
self-host fixed point) · size spot-check (mat4/fft/crc32/biquad at the
project's `optimize:'size'` bench recipe, compared against a `git worktree`
at HEAD 735e7f90): byte-identical, 1543/2368/1107/1861 bytes respectively —
matches Slice A's own ledger numbers exactly, confirming zero footprint for
instanceof-free/Error-free programs.

**What remains:**
- Slice C (optional) — internal-coded throws' `.message`/`.name` still read
  `undefined`. Deliberately deferred per the design's own scope cut (§5); the
  design's own §Open-questions verdict already names this as "genuinely a
  product call rather than an engineering one... flagged, not decided" — not
  re-litigated here.
- Slice D (optional, pure perf, no correctness value) — compile-time fold of
  `instanceof` beyond the literal-shape/schemaId cases already landed (e.g.
  flow-narrowed catch bodies where every reachable throw is provably one
  class). Not attempted; the two folds shipped (literal-call-shape,
  bound-name schemaId for the base `Error` case) already satisfy the
  "no runtime dispatch for a provably-known LHS" acceptance bar.

## Status (2026-08-03, Error-object model Slice A LANDED — real in-wasm Error
## objects + host-decode upgrade; instanceof (Slice B) and internal-code
## .message (optional Slice C) remain, per .work/error-object-design.md)

Implemented exactly the design's Slice A scope: `.work/error-object-design.md`
(read-only deliverable landed alongside this commit as the design record).

**What landed:**
- err-codes.js: `ERR_CLASS_NAMES` (the 7 built-in classes, index = `__errcls__`)
  and `ERR_SCHEMA_PROPS` (`['message','name','__errcls__']`) — new exports,
  zero behavior change to the existing 48-site `ERR`/`ERR_INFO` registry.
- module/core.js:1758ff — `buildErrorObject` replaces `passthroughError`: a
  real `PTR.OBJECT` + shared schema (all 7 classes dedupe to one
  `ctx.schema.register` id), built via the exact object-literal runtime path
  (`$__alloc_hdr` + one store per slot + `mkPtrIR`) — no new heap pointer tag,
  no new allocation primitive. `new Error(x)`/`Error(x)` (with/without `new`)
  both route here unchanged (Error isn't in `includeForRuntimeCtor`).
- src/ir.js `toStrI64` — new Error-schema arm (right after the STRING fast
  path, before the OBJECT `toPrimitiveChain` branch): a runtime tag+schema
  guard (masked i64 compare, same shape as `emitSchemaSlotGuarded`) that
  formats a proven Error object per spec's `Error.prototype.toString`
  (20.5.3.4: name/message/"name: message"/"Error"), falling through to
  EXACTLY the pre-slice logic (factored into `coerceRest`) on a guard miss.
  This is also the REQUIRED fix for the design's own found bug: `${obj}` on
  ANY dynamic object returned `""` (raw pointer bits reinterpreted as a
  string) — fixed here for Error objects specifically, still open for other
  object kinds (out of scope, flagged, not regressed).
- Gating: `ctx.features.error`, a new prepare-time universal per-node scan
  flag (src/prepare/index.js, mirrors the existing `ctx.features.bigint`
  prescan for the same order-independence reason) — order-independent
  because `toStrI64` runs interleaved with ordinary emission, unlike
  `__typeof`'s closure-arm (a stdlib template factory that runs post-emit).
  False everywhere in an Error-free program: `toStrI64` costs nothing extra.
- layout.js: `OBJECT_SCHEMA_HI_MASK`/`objectSchemaGuardHex` promoted from a
  local closure inside module/core.js to a shared export — src/ir.js's new
  guard reuses the identical encoding instead of a second definition (DRY;
  module/core.js's own guard site is unchanged behavior, just re-sourced).
- interop.js `decodeThrown` — new `__errcls__`-gated branch (ahead of the
  `typeof value === 'number'` branch): a real Error object decodes via
  `mem.read`'s existing generic OBJECT case to `{message,name,__errcls__}`;
  when `__errcls__` is present AND agrees with `name` (the correctness gate —
  trusting `name` alone would wrongly upgrade a coincidentally-shaped
  user-thrown plain object), builds the real host `Ctor` and re-throws it
  with `.cause`/`.thrown` set, matching the existing generic-wrap contract.
- test/errors.js:755-764 REWRITTEN (not deleted) — the old "Error IS its
  message string (documented divergence)" pin flips to a correctness pin
  (`.message`, `.name`, `String(e)`, `` `${e}` ``, no-arg `new Error()`, bare
  `Error(x)`); added two new blocks pinning §3(c) (non-Error throws
  unchanged: `throw 42`/`throw 'str'` still legal, `e` is the raw value) and
  §3(b) (an internal coded throw — `JSON.parse('x')` — still binds
  `catch(e)` to the raw f64 code; `.message` on it still reads `undefined`,
  Slice C not built). Every OTHER errors.js pin (host-decode, trap-lowering,
  dead-throw carrier, the per-class uncaught-escape tests at line ~540)
  verified untouched AND still green — those already asserted only
  `instanceof Error`/`.message`, which a real `TypeError` instance also
  satisfies.
- test/minimal-output.js — two new pins: an Error-free numeric fn stays
  heap-free with no `__errcls__` leak (structural, both O0/O2), and a
  constructed Error's STEADY-STATE RUNTIME HEAP footprint (measured via
  `exports.__heap` before/after a 2000-rep batch, not compiled-.wasm byte
  size — those are different metrics; a naive byte-length diff against a
  const-folded object-literal baseline was tried first and rejected, see
  below) — measured 39.98B/instance, matching the design's own ledger
  arithmetic exactly (24B payload + 16B header = 40B; 'Error' is 5 ASCII
  chars so even its own class name fits SSO inline, no shared data-segment
  string needed for that one class) and comfortably inside the ~60-100B
  estimate.

**Acceptance table** (native + kernel, both green):
| case | JS semantics | before | after |
|---|---|---|---|
| `throw new Error("boom")` → `.message` | `"boom"` | `undefined` (no object) | `"boom"` ✓ |
| `throw new TypeError("t")` → `.name` | `"TypeError"` | `undefined` | `"TypeError"` ✓ |
| `String(caught)`/`` `${caught}` `` | `"Name: msg"` (20.5.3.4) | raw message string (today) / `""` (any OTHER dynamic object — the found bug) | `"Name: msg"` ✓ |
| `throw 42` → `catch(e){return e}` | `42` | `42` | `42` ✓ (unchanged) |
| internal coded throw → `catch(e){return e}` | n/a (jz-internal) | raw code (e.g. `300`) | raw code, UNCHANGED (Slice C not built) ✓ |
| host boundary: uncaught `new TypeError("t")` | real `TypeError`, `.message==="t"` | generic `Error`, message JSON-ish-wrong | real `TypeError` (`instanceof TypeError`), `.message==="t"` ✓ |

**Size verdict:** error-free programs byte-identical — proven three ways:
(1) minimal-output.js's heap-free/no-`__errcls__` pins (79/79 green), (2) a
`git worktree` diff of HEAD vs this branch compiling mat4/biquad/crc32/fft
(the numeric bench kernels, zero Error usage) at the project's own
size-optimized recipe — 1543/1861/1107/2368 bytes, BYTE-IDENTICAL every case,
(3) kernel-parity's 33/33 corpus (none use Error) stays byte-identical.
Error-using cost: 39.98B/instance steady-state heap growth for `new
Error("boom")`, matching the design ledger (~60-100B) at its low end because
'Error' itself and a ≤6-ASCII literal message both fit SSO with zero heap
bytes; `new TypeError("boom")` (9-char name, needs the shared data-segment
string) measured the same 39.98B/instance marginal cost — the name string is
a ONE-TIME amortized cost, not multiplied per instance, exactly as designed.

**What remains:**
- Slice B (`instanceof`) — NOT built this session. `op-policy.js`'s
  `REJECT_OPS.instanceof` still hard-rejects; `x instanceof Array` etc. still
  errors in both modes exactly as before (no behavior change here).
- Slice C (optional) — internal-coded throws' `.message`/`.name` still read
  `undefined` (a NUMBER receiver has no schema — same class as the existing
  pinned "number.length is undefined" gap). Deliberately deferred per the
  design's own scope cut; needs a genuine code→message table (not the
  "compare ranges" trick Slice B's instanceof gets to use for the class),
  the highest-novelty piece of the whole design.
- Slice D (optional, pure perf) — compile-time constant-fold of
  `instanceof`/toStrI64 guards beyond what's needed for correctness. No
  correctness value; not attempted.

**Gates, all green:**
full battery (~90 files run in chunks of 5-6, `node test/<f>.js` each,
foreground) · errors.js 117/117 (184 assertions) · minimal-output.js 79/79
(274 assertions) · kernel-parity 33/33 byte-identical · kernel-oracle 11/11 ·
perf-ratchet 10/10 (+0, fgather unchanged) · optimizer 214/214 · fuzz.js
2000 programs × opt{0,1,2,3}, 0 divergence · selfhost.js 21/21 (206
assertions) against a FRESH `npm run build` · selfhost-perf.js 5/5 (warm
0.994×/cap 1.03×, fresh 0.788×/cap 0.99×, no regression) · two fresh `npm run
build` rebuilds byte-identical to each other (16,054,839 B jz.wasm both
times — the self-host fixed point; NOT compared to the old committed
dist/jz.wasm, which predates this change and legitimately differs since the
compiler's own ~14 internal `throw new Error(...)`/`new TypeError(...)`
sites, part of its self-hosted source, now also build real Error objects).

## Status (2026-08-03, item #6 re-audited and CLOSED — the "chained float-literal fold" fuzz finding was the FUZZ HARNESS's bug, not the compiler's)

Assigned as "fix the compiler fold to match per-op JS rounding." Investigation
found the opposite is true, and stopped short of the requested change per the
task's own honest-boundary rule ("if rational carry has a semantically-
justified consumer you can't cleanly separate, STOP... don't break a correct
case to fix this one").

ROOT CAUSE, CORRECTED: `src/prepare/pre-eval.js`'s Rational carry (exact
`n/d` magnitudes on `src/bignum.js`'s host-independent u32... actually
15-bit-limb arithmetic) is not an accuracy bug — it is THE FEATURE, landed
2026-07 (audit P0-2 fold-fork), pinned by test/preeval.js, and documented in
TWO project-level files as deliberate policy:
  - README FAQ ("What are the differences with JS?"): "Pre-eval folds
    constant chains the same way: exact rationals through `+ - * /`, rounded
    once — a folded `0.1 + 0.2 - 0.3` is the true `2.7755575615628914e-17`
    where stepwise JS gives `5.55e-17`, and `1e300*1e300/1e300` folds finite.
    Compiled constants are *more* accurate than run-as-JS, never less."
  - CONTRIBUTING.md Principles: "WASM conventions, not JS edge-cases... What
    JZ will not do is trade away a meaningful result's accuracy."
  - test/preeval.js: "precision: rational carry beats sequential per-op
    rounding" asserts `0.1+0.2-0.3` folds to EXACTLY `Math.pow(2,-55)`
    (2.7755575615628914e-17), explicitly NOT the naive stepwise JS value
    (5.551115123125783e-17 = 2^-54) — with `optimize.rationalConst: false`
    as the documented, tested opt-out for callers who want bit-exact-vs-JS
    per-op folding instead.
Live-verified this is exactly the SAME mechanism as item #6's repro, just a
different arithmetic shape: `(0.1*1.5)*1.5` -> jz `0.225`, JS
`0.22500000000000003` (chained `*`); `(0.1+0.2)+0.3` -> jz `0.6`, JS
`0.6000000000000001` (chained `+`); `(1.1-0.1)-1.0` -> jz
`8.326672684688674e-17`, JS `0` (chained `-`); `(1e300*1e300)/1e300` -> jz
`1e300`, JS `Infinity` (division, the README's own cited example). A single
op never diverges (`(1/3)*3` -> `1` both ways; `Math.sqrt`/`Math.min` wrapping
a chain matches JS too, since they consume the chain's ALREADY-final value):
divergence requires a genuine 2+-op chain where an intermediate rounds
differently than exact-then-round-once. Confirmed via `compileViaKernel` that
native and in-kernel already fold `(0.1*1.5)*1.5` to the SAME `0.225` (no
determinism bug — bignum.js's u32-15-bit-limb layer is exactly what audit
P0-2 built to make this fold host-independent; test/kernel-parity.js's
`fold|0/2/3` rows are already graduated/byte-identical, `PARITY_TODO` empty).

THE ACTUAL BUG: `test/fuzz.js`'s typed-map/typed-array float generator
(`F_LEAF`/`genFloatExpr`, feeding `typedSource`/`typedMapSource`). Its own doc
comment asserted "Element VALUE expressions use ONLY f64-stable ops... over
`buf[i]` and float literals... so jz == JS bit-for-bit with no contract
caveat" — true for any expression that references `buf[i]`, FALSE the moment
a randomly-generated subtree happens to draw ALL its leaves from the literal
pool (`0.1`, `1.5`, etc.) with no `buf[i]` anywhere: that subtree is exactly
a compile-time-constant chain, which pre-eval folds via the (correct, by
design) Rational carry — a legitimate divergence from the generator's own
naive `jsFn()` reference, not a jz miscompile. Confirmed empirically at HEAD
(before the fix): `node test/fuzz.js --typed-map --count=2000` found seeds
352 (`(0.1 * Math.abs(-1.5)) * 1.5`) and 812 (`(0.1*1.5)*1.5`); `--typed
--count=2000` found seed 812 (`(0.1*1.5)*1.5`) — all three match the ledger's
prior "typed-map ×2, typed-array ×1, seeds 352/812/812" exactly, all one
root cause, now correctly attributed.

FIX (test/fuzz.js only — zero src/ changes, so dist/jz.wasm needed no
rebuild): `genFloatExpr` rewritten as `genFloatExprC`, which threads an
`isConst` flag bottom-up through the SAME recursive shape (binary `+-*/`,
`Math.sqrt`/`abs` unary wrap, `Math.min`/`max`, scalar `* literal`) and
forces one side of any `+-*/`-combining node (and the scalar-multiply's
single child) to `buf[i]` whenever both sides would otherwise be literal-
only — structurally eliminating literal-only chains from every generated
program, the SAME precedent this file already uses for transcendental Math.*
("their last-ULP differences are not jz bugs"). Left alone on purpose: a
lone literal leaf (no chain, trivially JS-exact) and `Math.sqrt`/`Math.abs`
wrapping one (IEEE-exact vs host per the FAQ, no rounding to disagree over —
verified `Math.sqrt(0.1*1.5)` and `Math.min(0.1*1.5, 0.9)` both match JS
exactly once forcing prevents the INNER `0.1*1.5`-style operand from itself
being a multi-op chain). `Math.min`/`max` combining two literal operands was
also left forced-non-const defensively (min/max only SELECT, never round —
not strictly required, kept for a single uniform invariant, not a
correctness fix).

SIBLING CHECKS (all confirmed non-issues, no fix needed):
  - `src/prepare/index.js`'s `constNum` (compile-time numeric folding for
    string/template literals) already does PLAIN sequential per-op JS
    arithmetic (`x + y`, `x * y`, ...) — no rational carry at all in that
    path, so it already matches stepwise JS exactly. Confirmed by reading; a
    separate, correct-by-construction folder, not a second instance of this
    bug.
  - watr's own constant folder (`node_modules/watr/src/optimize.js`,
    `f64.mul: (a,b) => a*b` etc.) is likewise plain per-op JS arithmetic —
    correct vs JS for whatever pair it folds, and per the module's own design
    note it only ever sees jz's ALREADY-folded literals in normal compiles
    (post-inline exposure of a NEW constant pair would fold MORE precisely
    than jz's own chain, i.e. closer to real JS, not a new divergence).
  - Math.* fold dispatch (pre-eval.js ~line 406): `min`/`max` call host
    `Math.min`/`Math.max` directly (exact, selection-only); the transcendental
    kernel (math-kernel.js) is a separate, ALREADY-documented divergence
    class (README: "deliberately not bit-identical to host libm") unrelated
    to chain-rounding — no analogous chain issue found; native vs in-kernel
    trivially agree (same deterministic algorithm, no host arithmetic
    involved).
  - Scalar/typed-int fuzz legs (integer-literal-only, `ARITH` includes `/`):
    re-ran both at full 2000 count post-fix — 0 divergence (general: 30173
    inputs compared; typed-int: clean). A literal integer division CAN
    diverge in principle (`ratDiv` vs stepwise `/`), but the scalar
    generator's `LITS` never produced a triggering shape in 2000 seeds; typed-
    int's generator doesn't use `/` at all (documented: `*`/`/`'s precision
    contract is separately excluded there for an unrelated reason — i32
    product range).

GATES: fuzz general 2000 (30173 inputs, 0 divergence), typed-int 2000 (0
divergence), typed-map 2000 (0 divergence, was 2 findings), typed-array 2000
(0 divergence, was 1 finding) — all four previously-failing/previously-clean
legs re-confirmed clean post-fix. kernel-parity 33/33 byte-identical (no src/
change, as expected). kernel-oracle 11/11 (451 assertions). perf-ratchet
10/10, every baseline +0 (test-only change, zero codegen impact — expected).
optimizer 214/214. preeval.js 27/27 (62 assertions) — the pinned rational-
carry tests (`0.1+0.2-0.3` -> exact `2^-55`, `1e16+1-1e16` -> `1`,
`rationalConst:false` opt-out) all still green, confirming the feature this
item was asked to "fix" is untouched and intact. wat-invariants.js 23/23 (32
assertions) — the SAME generator functions this fix touches are swept
structurally by this file (`typedMapSource` et al., re-exported), all still
pass with the hardened generator. data.js 125/125 (242 assertions),
statements.js 202/202 (468 assertions). selfhost.js 21/21 (206 assertions,
39 compile-yourself rounds). selfhost-perf.js 5/5, informational (warm
geomean 0.992×/cap 1.03×, fresh geomean 0.804×/cap 0.99× — noise-level vs the
Slice 2 session's 0.986×/0.794×, no regression). Size spot-check
(scripts/bench-size.mjs mat4/fft/crc32/biquad, current tree): 1.5/2.3/1.1/1.8
kB — no rebuild needed and no change possible, this session touched only
test/fuzz.js (confirmed via `git status`/`git diff --stat`), zero src/ diff.

DETERMINISM VERDICT: no native-vs-kernel divergence exists or ever existed
for this fold — `compileViaKernel` was probed directly on the `(0.1*1.5)*1.5`
repro and produces the identical `f64.const 0.225` native does (bignum.js's
u32-15-bit-limb Rational layer is exactly what audit P0-2 built to guarantee
this; test/kernel-parity.js's `fold|*` rows are graduated, `PARITY_TODO`
empty, reconfirmed 33/33 this session). The task's "red→green, both legs"
framing does not apply here: there was never a native-vs-kernel gap to close,
and the JS-vs-jz gap is intentional — both legs were already, and remain,
byte-identically "green" against jz's own documented contract, not against
naive stepwise JS.

NOT DONE, ON PURPOSE: no change to `src/prepare/pre-eval.js` or
`src/bignum.js`. The task's requested fix ("per-operation double rounding...
should be BOTH JS-exact and host-independent") is exactly what
`optimize.rationalConst: false` already provides as an explicit, tested
opt-out (test/preeval.js) — flipping the DEFAULT would revert the P0-2
landing and directly contradict README/CONTRIBUTING's stated policy and the
"rational carry beats sequential per-op rounding" pin. Per the task's own
honest-boundary rule, stopped here instead: rational carry HAS a
semantically-justified purpose (the whole feature, not an edge case), fixed
the actual defect (the fuzz harness's false assumption) instead of breaking
the correct, documented case to satisfy a mischaracterized fuzz finding.

## Status (2026-08-03, maybeUndefined Slice 2 landed — Number.isNaN census gate, the last named item in "STILL OPEN" #1 below)

SLICE 2 — `emitIsNaN` sentinel exclusion (.work/maybe-undefined-design.md §4/
§5), the item Slices 3-5 explicitly named as never-assigned-to-that-campaign.
Live repro confirmed red at session start (native, no dist rebuild):
`const m = new Map(); m.set("a",1); export let f = () => Number.isNaN(m.get("zz"))`
→ jz `true`, JS `false` (ECMA-262 21.1.2.4: "If Type(number) is not Number,
return false" — undefined is not a Number, no ToNumber coercion).

MECHANISM: `emitIsNaN` (module/number.js) took a bare hardware self-compare
fast path (`f64.ne(v,v)`) whenever `valTypeOf(x) === VAL.NUMBER`, with no
further check — sound for a GENUINELY proven number (can never be a boxed
carrier, self-compare-NaN ⟺ real NaN, exact), unsound for a census-derived
NUMBER claim (`dictValueKindOf`/`mapValueKindOf`, live since 5c437df5): an
absent key reads back `UNDEF_NAN` at runtime, which IS a NaN bit pattern, so
the bare self-compare wrongly read `true`. FIX (one condition, per method,
per the design's own prediction): `if (vt === VAL.NUMBER) return raw` →
`if (vt === VAL.NUMBER && !censusMaybeUndefined(x)) return raw`. A
census-flagged argument now falls through to the SAME kind-unknown
tag-discriminating dynamic path 90e10c3d already built (checks the NaN
payload against `NAN_BITS`/negative-sign mask via `isNumNaNBits`) — that path
was already correct for `UNDEF_NAN` (excludes it), just previously
unreachable for a statically-NUMBER-claimed argument. No new coercion logic;
`censusMaybeUndefined` (kind.js) already covers BOTH dict and Map arms
(landed 5c437df5), so one gate closes both receiver kinds at once.

DICT-PATH MECHANISM (task asked to explain why a naive dict-absent probe
already read `false` before this fix — confirmed ACCIDENTAL, not structural,
and gated it too since the accident doesn't hold generally): a probe using a
STATIC named write (`d.a = 1`) or a non-canonical-numeric STRING-LITERAL key
(`d["zz"]`) never reaches `dictValueKindOf` at all — VT['[]'] (kind.js ~433)
returns `null` for any non-canonical-numeric string-literal key BEFORE the
dict-census branch (~499) is consulted (classified as a property read, not
an element read), and a dict populated only via named writes never sets
`dictValueValType`/`dynWriteVars` in the first place (the census is keyed off
`name[dynKey] = v` writes specifically). Both leave `valTypeOf(x)` `null`,
so `emitIsNaN` already took the (always-correct) kind-unknown dynamic path —
accidentally correct, for reasons unrelated to this fix. Confirmed live that
the SAME bug reproduces on dict once the census is actually exercised (a
DYNAMIC key write, `d[wk] = 1`, read via a variable key `d[k]`):
`Number.isNaN(d[k])` on an absent key was `true` (bug) before this fix,
`false` (correct) after — same root cause and same fix as Map, both arms
closed by the single `censusMaybeUndefined(x)` gate. Pinned both the
accidental-correctness case (so a future VT['[]'] refactor doesn't
reintroduce the bug under the false belief "dict literal keys already
worked") and the genuine dynamic-write case, in test/math.js.

FAMILY SWEEP — isFinite/isInteger/isSafeInteger need NO equivalent gate,
verified structural not accidental: every formula in this trio OPENS with
`f64.eq(v,v)` (self-equality), which is `false` for ANY NaN bit pattern
INCLUDING `UNDEF_NAN`. Unlike isNaN (which must answer `true` for one NaN-
bit-pattern class — genuine number-NaN — and `false` for another — boxed/
`UNDEF_NAN` — the exact distinction the census claim was defeating), these
three want `false` for BOTH classes alike, so the leading self-equality term
already excludes a census-sourced absent-key read with zero extra
instructions. Probed all three on Map-absent and dict(dynwrite)-absent: both
`false`, matching JS, unchanged before/after this fix. Pinned in test/math.js
alongside a WAT-structural pin (`isNumNaNBits`'s distinctive
`0xFFF0000000000000` sign-mask constant, present ONLY on the dynamic path)
proving a NON-census proven-NUMBER argument (`Number.isNaN(x * 2)`) keeps the
bare self-compare fast path — no dynamic-dispatch cost added to hot numeric
paths, confirmed by direct WAT inspection, not just behavioral pass/fail.

GATES: repro red→green confirmed both native and kernel leg
(`JZ_TEST_TARGET=jz.wasm`) — 75/75 tests pass on both (474 native / 471
kernel assertions; kernel's lower count is a pre-existing onKernel()-guarded
skip in an unrelated structural-WAT pin, not caused by this fix). Full
battery: 88 test/index.js files run individually, foreground, chunked 4-7 at
a time — 0 unexpected failures (pre-existing `# skip` entries in
array-methods/objects/spread/unsigned unrelated, same as prior sessions).
kernel-parity 33/33 byte-identical. kernel-oracle 11/11 (451 assertions).
perf-ratchet 10/10, every baseline +0 (no census gating touched a hot loop —
expected, numeric kernels carry zero census reads). optimizer 214/214.
selfhost.js 21/21 (40 compile-yourself rounds, fixed point confirmed).
selfhost-perf.js 5/5, informational (warm 0.986×/cap 1.03×, fresh
0.794×/cap 0.99×). fuzz: general 2000 (30173 inputs, 0 divergence),
typed-int 2000 (0 divergence), typed-map 2000, typed-array 2000. Size
spot-check: mat4/fft/crc32/biquad compiled via scripts/bench-size.mjs,
current tree vs a non-destructive swap of module/number.js back to HEAD's
committed content (the only file this fix touches that's reachable from
compiled output) — byte-identical sizes both ways (1543/2368/1107/1861), as
predicted (none of the four kernels reference Number.isNaN/isFinite/
isInteger/isSafeInteger at all).

PRE-EXISTING, UNRELATED FINDING surfaced by the typed-map/typed-array fuzz
legs (3 findings total, same root cause, NOT this fix — flagged per the
"honest stop with evidence" discipline, not silently dropped): a chained
float-LITERAL multiplication constant-fold (e.g. `(0.1 * Math.abs(-1.5)) *
1.5`, or `(0.1 * 1.5) * 1.5`) computed at COMPILE TIME diverges from real JS
runtime IEEE-754 sequential rounding — jz folds to `0.225` exactly, real JS
`(0.1*1.5)*1.5` is `0.22500000000000003` (verified in plain node). Confirmed
UNREACHABLE from this fix: the failing programs contain zero
`isNaN`/`isFinite`/`isInteger`/`isSafeInteger` tokens, and this fix's entire
diff is 24 lines inside `emitIsNaN`'s dispatch-table entry (module/
number.js) plus a comment on `emitIsFinite` — neither reachable without
those literal method names in source. Repro isolated:
`export let f = () => { const buf = new Float64Array(62); for (...) buf[i] =
(i-30)*0.5; for (...) buf[i] = ((0.1 * Math.abs(-1.5)) * 1.5); return buf }`
→ `buf[0]` jz `0.225`, JS `0.22500000000000003`. Not fixed here — out of
Slice 2's scope, a constant-folder precision bug unrelated to the
maybeUndefined campaign; flagged as a fresh open item below (#6) so it isn't
silently lost, not gold-plated into this narrow fix's blast radius.

With this slice landed, "STILL OPEN" item 1 below (from the Slices 3-5
entry) is CLOSED. Items 2-5 there remain exactly as left (never touched by
this slice); item 6 is new, added by this slice's fuzz gate.

## Status (2026-08-03, maybeUndefined Slices 3-5 landed — nameEscapes gate, site survey, Map re-enable)

CONTAINER VALUE-CENSUS SOUNDNESS CAMPAIGN CLOSED (.work/maybe-undefined-
design.md, Slices 3-5; audit-#7 P0 revert f8f61591 and Slice 1 061e2c6e are
the prerequisites this closes out). All three remaining slices landed
together (one combined effort, staged as described below); `mapValueKindOf`
is RE-ENABLED and live.

SLICE 3 — nameEscapes alias gate on dictValueKindOf:
`dictValueKindOf` (kind.js) gained a first-line
`if (ctx.types?.nameEscapes?.has(name)) return null` gate, matching
optimize/index.js:5014-5029's identical `escapes.has(name)` bail for the
analogous static-array-base fold. REPRO (mirrors the Map audit-P0 alias
test, dict sibling): `const d={}; d[wk]=1; const alias=d; alias[wk2]='oops1';
return d[wk2]-0` — HEAD (pre-fix): `'oops1'` (a raw NaN-boxed string pointer
surviving `-0` bit-for-bit, decoded back to the string by the host bridge);
JS/fixed: `NaN`. Confirmed red both with NO gate and with ONLY the kind.js
gate landed (see next paragraph for why) — green only once BOTH fixes below
are present. Pins: test/dyn-keys.js "dict: a write through an alias is not
lost to a stale census kind (audit P0 sibling, Slice 3)".
SECOND FINDING, LOAD-BEARING (program-facts.js, pre-existing, discovered
landing this slice): `ctx.types.nameEscapes` — the exact fact the design's
§2 worked example (`const alias = m`) claimed marks unconditionally — did
NOT mark a bare-name DECL initializer's RHS at all. walkFacts' `'let'`/
`'const'` special case (program-facts.js ~284) hand-walks each declarator
(valueUsed bookkeeping + a targeted RHS recursion) instead of visiting the
whole `'='` node through the normal recursive `walkFacts` call — so the '='
node never reached `observeNodeFacts`'s generic per-arg escape-marking loop,
and a bare-name RHS (`const alias = d`, decl[2]='d', a plain string with
nothing further to recurse into) was silently invisible to nameEscapes.
Confirmed via live instrumentation: `let alias; alias = d` (non-decl
reassignment) DID mark 'd'; `const alias = d` (decl form — the design's OWN
worked example, and the shape BOTH audit-P0 Map alias tests use) did NOT.
This is exactly why the kind.js gate alone left the repro red. FIXED:
walkFacts' decl branch now calls `observeNodeFacts(decl, acc)` on each
`'='`-shaped declarator explicitly (one line) — the pre-registered declEq
exemption (already computed for the outer node) still protects the LHS
binding slot; only the previously-invisible bare-name-RHS case is newly
marked. This is a REAL FIX to nameEscapes' own construction, not a
workaround — it's what makes Slice 3's (and Slice 4's) alias gate actually
sound for the design's own canonical alias-creation idiom, and it also
retroactively strengthens `foldStaticConstArrayReads` (optimize/index.js),
which consumes the SAME fact for the analogous static-array-base fold and
had the identical blind spot for decl-form array aliases (not separately
re-audited/re-gated here — same fact, same fix, no separate consumer change
needed there).
Control (non-aliased dict keeps its fast path): the pre-existing
"consumer wiring — proven-NUMBER dict read skips coercion at a compare
site" test (test/inference.js) stays green unchanged — OPCODE never
escapes there.

SLICE 5 — structural site survey (~224 `VAL.NUMBER`/`VAL.STRING` comparison
sites across 31 files in src/+module/, grepped and classified; ~120 of the
design's original estimate undercounted producer-side VT-table entries).
Method: grepped every `===VAL.NUMBER`/`===VAL.STRING`-shaped site outside
kind.js/kind-traits.js (the classification engine itself, not a consumer),
grouped into families, and for each family determined whether a census-
derived kind reaching it is safe under the maybeUndefined join. Full
classified inventory:
  - Arithmetic (ir.js toNumF64, 1 chokepoint) — SAFE, already gated (Slice 1).
  - ToString (ir.js toStrI64 / module/string.js String(), 2 sites) — LEAK B,
    found and fixed (below).
  - Equality (emit.js emitLooseEq/emitStrictEq, ~3 branches; module/array.js
    arrEqIR feeding .indexOf/.includes/.lastIndexOf, same shape) — LEAK A,
    found and fixed (below).
  - Relational compare (emit.js cmpOp, `<`/`>`/`<=`/`>=`) — SAFE BY
    CONSTRUCTION, no fix needed: verified live that a NaN-boxed operand
    (real or census-masquerading) ALWAYS compares false under a raw
    f64.lt/gt/le/ge, which coincides exactly with JS's own
    ToNumber(non-number)=NaN → "compared to NaN is always false" semantics.
    Confirmed by direct repro (`d[rk] > 5` on an absent numeric-census key:
    correct `false` both before and after every other fix in this campaign).
  - console.log/warn/error formatting (module/console.js writePart, only
    reachable under `host:'wasi'` — under `host:'js'` console.log decodes
    host-side off raw bits, independent of compiler beliefs) — LEAK C,
    found and fixed (below).
  - Receiver/key dispatch (write & read routing: dict vs array vs typed vs
    string; module/array.js, emit-assign.js, ~40 sites) — UNREACHABLE: these
    test the RECEIVER's or KEY's kind to choose a codegen path, never trust
    a VALUE read's exact kind as a presence proof.
  - Merge/box representation (`?:`/`&&`/`||`/`??` arm boxing, emit.js,
    ~30 sites) — UNREACHABLE for the coercion-correctness question: these
    decide NaN-canon/box-vs-raw REPRESENTATION, not ToNumber/ToString/
    equality; already fully audited by the unrelated carrier-invariant-
    design.md / formatter-dispatch-design.md campaigns.
  - Producer/classification (kind.js/kind-traits.js VT table itself,
    propValType, methodValType, typedCtorElemValType) — excluded, not a
    consumer (this is what PRODUCES the kind judgment).
  - Analysis-only / compile-time fact production (narrow.js, compile/
    index.js, program-facts.js, analyze.js, ~50 sites) — UNREACHABLE: whole-
    program/inter-procedural fact production feeding LATER analyses, not a
    runtime value trusted at an emit site.
  - Number.isNaN/isFinite/isInteger/isSafeInteger (module/number.js) —
    isFinite/isInteger/isSafeInteger SAFE (their `x===x` self-compare already
    excludes every NaN-boxed carrier); Number.isNaN's CENSUS/OOB-specific
    gate (design §4 Slice 2: excluding `censusMaybeUndefined`/
    `checkedNumRead`-tagged sentinels specifically) remains OPEN — Slice 2
    was never assigned to this campaign (task scope was Slices 3-5 only) and
    is NOT landed; `Number.isNaN(d['missing'])` on a NUMBER-census dict still
    reads jz `true` vs JS `false`. Flagged, not closed — see "still open"
    below. (The BROADER Number.isNaN(string/object) leak, unrelated to
    census, WAS already fixed pre-this-session, commit 90e10c3d.)
  - JSON.stringify (module/json.js, 4 sites) — low-confidence SAFE
    (undefined-omission appears spec-handled upstream of these branches by a
    dedicated check) — NOT independently re-derived/repro'd this session;
    flagged as lower-confidence than the other verdicts, not re-opened.
LEAK A (equality, emit.js emitLooseEq/emitStrictEq): the raw `f64.eq`/
`f64.ne` fast branch fired whenever EITHER side's static kind was
VAL.NUMBER, with NO runtime tag check — never called toNumF64/toStrI64 or
consulted `censusMaybeUndefined` at all (nullableOperand's existing
consultation only covered the LITERAL `null`/`undefined`-token comparison
shape, not two dynamic maybe-undefined operands compared to each other).
IEEE-754 f64.eq is FALSE for ANY NaN operand, always — including two BIT-
IDENTICAL NaN-boxed `undefined` sentinels — so `x === y` where BOTH are
genuinely `undefined` at runtime (one via a NUMBER-census absent-key claim)
wrongly read false; JS reads true. Repro (all confirmed red at HEAD, green
after): `d[rk] === u` (u a real undefined local), `d[rk] === d[rk2]` (two
independent absent reads), `d[rk] == other[ork]` (loose eq, one side
NUMBER-census, other side an unrelated unproven boxed read) — all wrongly
`0`, correctly `1` after the fix. FIXED (reusing the SAME two-chokepoint
predicate, not a new mechanism): `emitLooseEq`'s NUMBER-trust now requires
`vt===VAL.NUMBER && !nullableOperand(operand)` (`aSafe`/`bSafe`) instead of
bare `vt===VAL.NUMBER` — `nullableOperand` already unifies the census carve-
out with the unproven-typed-index-OOB carve-out, so this ALSO retroactively
fixes the equivalent leak for array/typed-array OOB reads (confirmed live:
`a[10] === u` on a dynamically-out-of-range array index was ALSO wrongly
`0`before this fix — a pre-existing, broader-than-census leak, same
Number.isNaN-precedent framing: found and closed as a side effect of the
correct general fix, not separately scoped). Literal `undefined`/`null`
sentinel comparisons (the pre-existing carve-out) and the relational family
stay unaffected (kept as passing controls). Pins: test/dyn-keys.js "dict:
strict/loose equality between two independently-maybe-undefined reads
(Slice 5 LEAK A)".
LEAK B (ToString, ir.js toStrI64): `toStrI64` — the SAME function
module/string.js's `bind('String', …)` already delegates to for the
maybeUndefined-flagged case, on the (Slice 1) belief it "falls through to
the LAST branch... already correct" — had its OWN unguarded
`vt === VAL.STRING` early return ABOVE that last branch. A dict census whose
observed writes were all STRING (not NUMBER, the only kind Slice 1's own
repro exercised) hit THIS branch instead: `asI64(v)` reinterpreted the
absent key's raw UNDEF_NAN bits as a string i64 — which decodes host-side as
the bare `undefined` VALUE, not the string `"undefined"` (a WORSE failure
than a wrong string: wrong TYPE entirely). Reaches template-literal
interpolation too (toStrI64 is strcat's per-part fallback), CONTRADICTING
Slice 1's own "template literals need no fix" claim — that claim was
verified only against a NUMBER-kind census; the STRING-kind case was
untested. Repro (red at HEAD, green after): `String(d[rk])` on a STRING-
census absent key → `undefined` (the value) instead of `"undefined"` (the
string); `` `v=${d[rk]}` `` → `"v="` instead of `"v=undefined"`. FIXED at
`toStrI64` itself (the shared chokepoint, not the caller): gated the
`vt===VAL.STRING` return on `!censusMaybeUndefined(node)`. Pins:
test/dyn-keys.js "dict: String() and template literals on a STRING-census
absent key (Slice 5 LEAK B)".
LEAK C (console.log, module/console.js writePart): independent dispatch,
not routed through toStrI64/String() at all — only reachable under
`host:'wasi'` (module/console.js's own WASI-syscall writers; under
`host:'js'` console.log decodes host-side off raw bits, masking the bug).
`vt===STRING`/`vt===NUMBER` fed raw bits straight to `$__write_str`/
`$__write_num`, which assume their arg IS that kind (no tag check — unlike
`$__write_val`, the pre-existing generic fallback, which already dispatches
correctly on the ACTUAL runtime atom). Repro (WASI host, captured via the
polyfill's custom `write`): `console.log(d[rk])` on a STRING-census absent
key printed an empty line instead of `"undefined\n"`. FIXED: gated
writePart's STRING/NUMBER fast branches on `!censusMaybeUndefined(part)`,
falling through to the existing, already-correct `$__write_val` general
path. Pins: test/wasi.js "WASI console.log: dict-census absent key prints as
undefined, not empty/garbage (Slice 5 LEAK C)".
No fourth chokepoint was needed beyond toNumF64/toStrI64/emitLooseEq/
writePart — every leak closed by reusing `censusMaybeUndefined`/
`nullableOperand` at the ACTUAL unguarded site, per the "same two-chokepoint
pattern, implement once" mandate; none required a per-site carve-out.

SLICE 4 — Map census re-enable. `mapValueKindOf` (kind.js) reconstructed
from `git show 1db8e55e` as the reference shape, WITH the `nameEscapes` gate
written in from the first line (not deferred) and the HARD
`valTypeOf(name)===VAL.MAP` receiver-classification guard kept verbatim (no
dynWriteVars-analog proxy needed — Map's receiver kind is never cross-kind-
polluted the way dict's is, so no `dictCensusReceiverIsLive`-equivalent
guard was needed either). `censusMaybeUndefined` gained a second arm
recognizing `['()', ['.', recv, 'get'], k]` gated on `mapValueKindOf(recv)`,
landed in the SAME change as the `.get()` short-circuit in `VT['()']`
(kind.js) — per the design's re-enablement criteria (§3), all satisfied
together: (1) dictValueKindOf's nameEscapes gate (Slice 3) landed first;
(2) censusMaybeUndefined's Map arm + the VT['()'] short-circuit land
together; (3) mapValueKindOf carries the SAME nameEscapes gate from its
first line; (4) the site survey (Slice 5) ran and found/closed 3 leaks
before this slice landed, per the design's explicit ordering. No separate
`nullableOperand` carve-out was added (unlike 1db8e55e's original diff) —
Slice 1 already replaced that inline logic with `censusMaybeUndefined`, so
the Map arm on `censusMaybeUndefined` alone is consulted everywhere
`nullableOperand` is, automatically (identity folds) AND everywhere the
Slice 5 fixes added a `censusMaybeUndefined`/`nullableOperand` consult
(equality, ToString, console) — one arm, every chokepoint, no duplication.
ACCEPTANCE: both audit-P0 Map pins (test/dyn-keys.js, absent-key + alias-
write) stay green with the consumer LIVE — confirmed they pass via the
SOUND mechanism now (mapValueKindOf genuinely fires and is genuinely gated),
not merely "no consumer exists" as before. Positive/negative control pair
added (test/inference.js "map-value census: consumer wiring — a non-
escaping Map proves its value kind; an escaping one does not (Slice 4)"):
asserts `ctx.types.nameEscapes`/`mapValueKindOf`'s actual gating outcome
directly, NOT a WAT structural pattern — investigated and confirmed the
`OPCODE.get(nm) > 0xffff` structural shape the ORIGINAL 1db8e55e test (and
its dict-census sibling) used does NOT actually distinguish "consumer
present" from "consumer absent" for Map specifically: cmpOp's relational
family is unconditionally safe for a `.get()` LHS against a proven-NUMBER-
literal RHS regardless of any exact-kind proof (verified by compiling the
identical shape against a HEAD checkout with ZERO Map consumer at all —
`f64.gt` was ALREADY present, no `$__gt` helper exists ANYWHERE in this
codebase for any shape), and Map's heavily-inlined hash-probe codegen
defeats a reliable arithmetic-side WAT pattern match (`isNumericIR`'s
structural fast path treats the probe's own IR shape as provably numeric
independent of the static VAL claim). This is a genuine, previously-
unnoticed test-quality gap in the ORIGINAL 1db8e55e commit (its own
structural assertion proved nothing about its own consumer) — noted here so
it isn't silently rediscovered as a mystery later. The fact-level assertion
used instead is the precise, non-fragile signal.

GATES (full battery, this combined landing): all 88 test/index.js TESTS
files run individually (foreground, chunked 4-7 at a time as directed) — 0
fail (pre-existing `# skip` entries in spread/unsigned/array-methods/objects
unrelated). fuzz.js: 2000 programs × opt{0,1,2,3}, 30173 inputs compared,
0 divergence. Two fresh consecutive `npm run build` rebuilds — dist/jz.js
and dist/jz.wasm byte-identical between them (self-host fixed point
confirmed). kernel-parity 33/33 byte-identical (rerun post-rebuild).
kernel-oracle 11/11 (451 assertions). perf-ratchet 10/10, every baseline
+0 delta (no census gating change touched a hot loop in the bench corpus).
optimizer 214/214. selfhost.js 21/21 (40 compile-yourself rounds).
selfhost-perf.js 5/5 — warm 1.004× (cap 1.03×), fresh 0.784× (cap 0.99×),
comfortably under cap, no flake. Size spot-check: mat4/fft/crc32/biquad
compiled at `optimize:'speed'`, current source vs a HEAD (d9b020f7)
checkout of only the touched files (kind.js, emit.js, program-facts.js,
ir.js, console.js, reps.js) — byte-for-byte `cmp`-identical for all 4, as
predicted (zero dict/Map-census-reachable reads in these numeric kernels).
dbg-invariants leg: NOT run — the design's `JZ_DEBUG_INVARIANTS` tripwire
(§1 closing paragraph) was never built (see "still open" below), so there
is no dedicated leg to run; explicitly not attempted, not silently skipped.

STILL OPEN (named precisely, not silently left ambiguous):
  1. CLOSED (2026-08-03, see the Slice 2 entry above this one): Slice 2
     (`emitIsNaN` sentinel exclusion, design §4/§5) landed — `emitIsNaN`'s
     static-NUMBER fast path is now gated on `!censusMaybeUndefined(x)`.
     isFinite/isInteger/isSafeInteger confirmed structurally safe, no gate
     needed. The broader string/object leak stayed out of scope, as
     originally intended (already fixed pre-session, 90e10c3d).
  2. The `JZ_DEBUG_INVARIANTS` tripwire sketched in design §1's closing
     paragraph — a `DBG_REPS`-style runtime assert that a
     censusMaybeUndefined-flagged node's raw bits are never read outside
     `coerceNullishToNum`/`toStrI64`'s call frame — was not built. Not
     required for soundness (every leak found this session was closed by
     enumeration + the two/three chokepoints, not by hoping a tripwire would
     catch it), but still the closest this codebase's tooling gets to
     compiler-enforced exhaustiveness; left as a pure idea, per the design's
     own framing of it as optional.
  3. Destructuring a maybeUndefined-joined value (`const {a} = m.get(k)` on
     a genuinely-absent key) and method dispatch on a maybe-undefined census
     read (`d[k].toFixed(2)`) — design §6's own named, NOT audited this
     session (out of the ~224-site grep survey's scope: neither is a bare
     `===VAL.NUMBER`/`===VAL.STRING` comparison site, they're a different
     consumer class — RequireObjectCoercible / property-lookup-on-undefined
     — spec-wise). Real JS throws `TypeError` in both cases; jz's behavior
     here is UNCONFIRMED, not verified safe. Flagged exactly as the design
     left it, not newly investigated.
  4. BigInt-typed census values in arithmetic (design §6) — unchanged,
     exactly as unsound as before this campaign, not newly broken. Real JS
     throws mixing BigInt and undefined in arithmetic; `coerceNullishToNum`
     always answers undefined→NaN, which is the wrong answer for a
     `dictValueValType===VAL.BIGINT`/`mapValueValType===VAL.BIGINT` claim.
     `toNumF64`'s Slice-1 gate is deliberately NUMBER-only for exactly this
     reason (unchanged this session).
  5. JSON.stringify's 4 sites (module/json.js) — flagged low-confidence-SAFE
     in the Slice 5 survey above, not independently re-derived/repro'd; a
     future audit should confirm rather than inherit this session's
     lower-confidence read.
  6. CLOSED (2026-08-03, re-audited — see the status entry below this one):
     NOT a compiler bug. The chained float-literal fold IS
     `src/prepare/pre-eval.js`'s Rational carry (bignum.js) working exactly as
     designed — a DELIBERATE, DOCUMENTED, pinned divergence from JS's per-op
     rounding (README FAQ "Compiled constants are more accurate than
     run-as-JS, never less"; CONTRIBUTING.md Principles; test/preeval.js
     "precision: rational carry beats sequential per-op rounding", which
     asserts `0.1+0.2-0.3` folds to the exact `2^-55`, NOT stepwise JS's
     `2^-54` — the same divergence class this item flagged). The real bug was
     in `test/fuzz.js`'s typed-map/typed-array generator: its own doc comment
     claimed float-literal expressions "never diverge from JS," a false
     assumption once a randomly-generated subtree happened to contain NO
     `buf[i]` reference (a pure compile-time-constant chain) — exactly the
     shape the Rational carry is charted to round once instead of per-op.
     Fixed at the generator (`genFloatExprC`, test/fuzz.js): tracks constness
     bottom-up and forces one side of any `+ - * /`-combining node to `buf[i]`
     whenever both sides would otherwise be literal-only, structurally
     eliminating literal-only chains from the generated corpus (same
     precedent as the file's existing "transcendental Math.* excluded — not
     jz bugs" carve-out). A LONE literal leaf, or a single-arg
     `Math.sqrt`/`abs` wrap of one, is left constant on purpose (both
     IEEE-exact vs host per the FAQ, no chain-rounding to disagree over).
With items 1-5 named above, the container value-census soundness campaign's
core ask (represented maybeUndefined join + BindingId-style alias/escape
ownership, both consumers re-enabled, structural survey complete) is
CLOSED — dictValueKindOf and mapValueKindOf are both live, both gated, and
every reachable consumer family in the ~224-site survey is either proven
safe, proven unreachable, or was found unsound and fixed at its chokepoint.

## Status (2026-08-03, MODULE-GLOBAL SIBLING CLOSED: inferModuleIntGlobals stopped trusting i32 storage past a bare escape — the module-global twin of KNOWN GAP #1)

REPRO (confirmed live at HEAD before this fix, flagged by the KNOWN GAP #1
ledger's own sibling audit below): `let counter = 4; export let bump = () =>
{ counter *= 100000; return counter }`, called 3×:

| call | jz (HEAD, wrong)      | jz (fixed)         | JS (authority)      |
|------|------------------------|---------------------|----------------------|
| 1    | 400000                  | 400000              | 400000               |
| 2    | 1345294336 (wrapped)    | 40000000000         | 40000000000          |
| 3    | -1827012608 (wrapped)   | 4000000000000000    | 4000000000000000     |

Plus 3 variants, all red→green: (1) split grow/read across two exported
functions (`grow()`/`read()`) — same divergence; (2) `+=` arm (`h += (d|0)`
once, `d=2147483647`) — HEAD `-2147483645`, JS/fixed `2147483651`; (3)
cross-function growth (`grow2()` mutates, `read2()` reads, called twice) —
HEAD `1345294336`, JS/fixed `1600000000000000` (`4*100000*100000`). Safe
controls (must KEEP i32, verified via WAT `(mut i32)` decl, not just
correctness): a comparison-governed module counter (`for(idx=0;idx<n;idx++)`)
and a ToInt32-rooted accumulator (`m=(m+(d|0))|0`) both stay i32 storage,
values exact vs JS.

ROOT CAUSE: `src/compile/plan/scope.js`'s `inferModuleIntGlobals` — the
module-global f64→i32 narrowing fixpoint — is the SAME one-way-storage-
commitment flaw as KNOWN GAP #1's two local mechanisms, in a THIRD file/
mechanism (a different AST-walk shape, so not reachable via the local
`collectBareEscapes` call sites without duplicating the scanner — exactly
as the prior ledger entry's sibling-audit flagged). `producesFraction`
proves a candidate global only INTEGRAL (the module-global analog of
intLevelMap's level-1 "integral-closed, range-open" — `+`/`-`/`*` never
prove a magnitude bound), never that its magnitude stays in i32 range — and
since a module global has no local-scope containment, EVERY read anywhere
in the program is a "bare escape" candidate. `EXCEEDS_I32_CALLS`
(Date.now-style) already disqualifies known-oversized producers, but had no
general mechanism for "grows past i32 via ordinary arithmetic, then read
bare."

FIX (same root mechanism as KNOWN GAP #1, reused not duplicated):
`collectBareEscapes` (src/compile/analyze-scans.js) gained a `crossClosure`
parameter (3rd arg, default `false` — LOCAL behavior byte-for-byte
unchanged: a nested `=>` stays a separate scope/body, not scanned).
`crossClosure=true` descends into nested arrow bodies instead of stopping —
an inline callback closure (`.forEach(x => { g = x })`) is never lifted to
its own `ctx.func.list` entry at prepare time (only named function/arrow
BINDINGS are — verified via src/prepare/index.js's `'=>'` handler), so it
stays an inline node in the enclosing body and would be invisible to a scan
that stops at `=>`. `collectComparedNames` (same file) got the identical
parameter, threaded through.

`inferModuleIntGlobals` calls `collectBareEscapes` ONCE, after its existing
`producesFraction` fixpoint, over a SYNTHETIC WHOLE-PROGRAM body
(`[';', ast, ...moduleInits, ...every ctx.func.list body]`) — a global's
relevant scope for the "every read re-applies the same ToInt32 the writes
did" soundness premise is the WHOLE PROGRAM, not one function, since its
storage outlives any single function (the direct generalization of KNOWN
GAP #1's "the var's WASM storage is ONE slot for the whole function"
argument, one level up). Two-tier, mirroring intLevelMap's own lattice
exactly (Pass D's local "level 2 needs no check" exemption, generalized to
program scope via `intLevelMap(programBody)`, called over the SAME
synthetic body): a candidate whose every write is level-2 STRICT
(int32-range literal, bitwise/comparison result, Math.imul/clz32 — proven
i32-safe by construction regardless of where it's read) skips the escape
check entirely; a level-1 (integral, unbounded) candidate needs
`collectBareEscapes`' full proof — index-positioned, ToInt32-rooted,
statically in-range (`intExprRange`), or governed by SOME comparison
anywhere in the whole-program scan (same loop-counter tolerance
`widenLocalTypes`' CMP_OPS pass already accepts, generalized program-wide).
A namesake local elsewhere sharing a candidate's name can only pull a
shared `intLevelMap` bucket's level DOWN via its min-fixpoint (never falsely
UP) and can only ADD a spurious blame via the flat by-name escape scan
(never remove a real one) — both directions are conservative-only, matching
this file's own "over-inclusive only makes it MORE conservative" convention
(inferModuleGlobalValTypes' `bound`-set doc, same file) and the local fix's
own "no shadow tracking needed, over-flagging is safe" precedent.

TEST CORRECTIONS (2, both justified — the SAME "test asserted on the
pre-fix unsound behavior" situation the P0-2 ledger's float/mixed
re-baseline names, not a regression):
  - `test/snapshot.js` — `seq = seq + 1; return seq` (bare, uncompared
    accumulator) is EXACTLY the shape this fix demotes; changed to
    `seq = (seq + 1) | 0` (ToInt32-rooted, level-2 STRICT by construction,
    numerically identical at this test's magnitude) so the test's actual
    target — "an i32 global bakes as an i32 literal initializer under
    `snapshotInit`" — is demonstrated on a sound shape instead.
  - `test/perf.js` `codegen: integer-global inference narrows numeric
    globals, demoting only on proof` — its accessor summed all six globals
    bare (`N + half + bSi + width + offset + scale`, no comparisons, no
    index use anywhere) — none of the four integer candidates had ANY
    exempt occurrence. Rewritten to read each as a loop bound
    (`for (i=0;i<N;i++) s+=mem[i]`, …) — the file's OWN documented payoff a
    few lines below this test (`i < N` pure-i32, `mem[y*w]` fully-i32
    index) and the realistic consumption shape real purpose-focused code
    uses (verified directly: the doc's own `mem[y*width+x]`+`i<N`+`x<width`
    shape narrows N/width to i32 with ZERO changes needed — confirms the
    fix does not regress the REPRESENTATIVE case, only the synthetic
    all-bare-sum probe). Assertions (N/half/width/offset → i32, bSi/scale →
    f64) unchanged.

CLASS-CLOSURE STATEMENT: the one-way-storage-commitment class (a value
provably STORED i32 magnitude-blind, later read where the storage's own
ToInt32-wrap premise doesn't hold) is now CLOSED across every inventoried
i32-narrowing mechanism:
  - LOCALS (`collectI32SafeIndexVars` back-prop, `widenLocalTypes`
    intCertain/Pass D) — closed 2026-08-02, KNOWN GAP #1 entry below.
  - MODULE GLOBALS (`inferModuleIntGlobals`) — closed HERE.
  - `ctx.schema.slotI32Certain`/`slotI32CertainAt` — RULED SOUND BY DESIGN
    (prior ledger): the strict level-2-equivalent projection by
    construction, no bare-escape exposure possible.
  - `ctx.schema.slotIntCertain` — RULED OUT OF CLASS (prior ledger):
    per-use-site elision, never a storage-narrowing commitment.
  - `ctx.types.typedElem` — RULED OUT OF CLASS (prior ledger): resolves the
    var's REAL bound TypedArray ctor, mirrors true JS coercion exactly, not
    an approximation that can drift.
No further sibling identified — every ctx.js-registered numeric-narrowing
fixpoint (locals + globals) now consults a bare-escape proof scoped to its
OWN storage's true lifetime (one function body for a local, the whole
program for a global) before committing to permanent i32 storage.

GATES: repros red→green — native (`node test/inference.js`, both new tests)
AND kernel leg (`JZ_TEST_TARGET=jz.wasm node test/inference.js`, 132/132,
278 assertions — WAT-shape-only pins skip under `onKernel()`, expected) —
both against a fresh `npm run build`. Full battery: all 88 test/index.js
TESTS files run individually, zero uncurated fails (2 justified test
corrections above). kernel-parity 33/33 byte-identical (O0/O2/O3).
kernel-oracle 11/11 (451 assertions). perf-ratchet 10/10, EVERY category
byte-identical to the KNOWN GAP #1 baseline (+0 across
int/float/mixed/cond/buf/nest/slice/ring/condref/fgather) — no re-baseline
needed, no honest tension. optimizer.js 214/214 (3949 assertions).
selfhost.js 21/21 (206 assertions). selfhost-perf.js 5/5 (warm geomean
0.988×/cap 1.03×, fresh 0.788×/cap 0.99× — both comfortably under cap,
consistent with the KNOWN GAP #1 baseline). fuzz.js: 2000 seeds ×
opt{0,1,2,3}, 30173 inputs compared, 9827 skipped i32-contract-exceeded, 0
divergence (matches the KNOWN GAP #1 baseline numbers exactly). examples.js
22/22 (433 assertions, unchanged). Size spot-check: mat4 1543B (the KNOWN
GAP #1 +15B baseline, unchanged), fft 2368B, crc32 1107B, biquad 1861B —
all byte-identical to the KNOWN GAP #1 baseline.

## Status (2026-08-02, KNOWN GAP #1 CLOSED: collectI32SafeIndexVars back-propagation + widenLocalTypes intCertain sibling both stopped trusting i32 storage past a bare escape)

REPRO (both arms, live at HEAD before this fix, both via the `run`/`jz.compile` harness — the FFT-butterfly shape pinned KNOWN-FAIL in test/inference.js since the P0-2 ledger above):
- `*=`: `id` back-propagated to i32 via `i0 += id` (an array-index feeder), then
  `id *= 100000` inside the same outer loop, returned bare after the loop —
  jz `1345294336` (wrong: `40000000000 mod 2^32`), JS `40000000000`.
- `+=`: same `i0 += id` back-prop shape, then `id += (d|0)` once, returned
  bare — jz `-2147483645` (wrong wrap), JS `2147483651`.
- Isolated control (NO array/index involvement at all — proves the bug is
  NOT specific to collectI32SafeIndexVars): `let id=4; id+=(d|0); return id`
  — jz ALSO wrapped (`-2147483645` vs JS `2147483651`) at HEAD, because
  `id` is typed i32 from its own `let id=4` literal by the ordinary
  declaration pass and nothing else ever widens it (see root cause #2).

ROOT CAUSE — TWO independent one-way i32-storage commitments, both
magnitude-blind by design (the SAME documented P0-2 tradeoff: "a value
merely STORED i32 is safe regardless of magnitude, because every READ
re-applies the same ToInt32 the WRITE did" — widen.js), both missing the
"is that premise actually upheld for THIS var" check:
  1. `collectI32SafeIndexVars` (src/compile/analyze-scans.js) — the
     PINNED bug. Its back-propagation fixpoint marks ANY var that affinely
     feeds an already-proven-safe array index as i32-safe PERMANENTLY, for
     the whole function, regardless of the var's own later magnitude growth
     or a bare escape elsewhere. True for `*=` above: `id` started 'f64'
     (the ordinary type pass's own verdict) and this promotion loop (the
     `for (const n of safe) if (locals.get(n)==='f64' ...) locals.set(n,
     'i32')` line) was what forced it to i32.
  2. `widenLocalTypes`'s SEPARATE `intCertainMap`-based `keepI32` exemption
     (src/compile/analyze.js) — found via repro-first differential testing
     when fixing #1 alone left the `+=` arm still wrong. `id` here was
     NEVER touched by collectI32SafeIndexVars at all (never an index
     feeder's target of the promotion loop) — it started 'i32' from its
     OWN `let id = 4` literal (the ordinary per-decl type pass) and NOTHING
     ever widened it, because intCertainMap collapses intLevelMap's lattice
     to a single boolean (`level >= 1`), erasing the level 1
     ("integral-closed, range-open" — `+`/`-`/`*` NEVER return level 2
     regardless of operand levels) vs level 2 (STRICT i32-range-safe:
     literals, bitwise ops, comparisons, Math.imul/clz32) distinction that
     actually matters for soundness.

FIX (root, one shared mechanism, two call sites): `collectBareEscapes`
(src/compile/analyze-scans.js, new) — a whole-body scan that finds every
name with an unresolved "bare escape": a value-position read that is not
(a) statically proven in-range (`intExprRange`, the AST-level opBound
twin), (b) ToInt32-rooted (direct operand of `&|^~<<>>>>>`/comparisons, or
an argument to Math.imul/Math.clz32 — JS ToInt32s these unconditionally,
spec-defined), (c) an index position (`[]`'s index arg, affine-reachable),
or governed by SOME comparison anywhere in the body (the loop-counter
"sound for n≤2^31" tolerance widenLocalTypes' CMP_OPS pass already accepts
— untouched, this reuses that SAME scope rather than adding a stricter
one). Both root causes now consult it:
  1. `collectI32SafeIndexVars` deletes every blamed name from its `safe`
     set AFTER the existing seed+backprop fixpoint completes (no
     re-fixpoint needed — a var's OWN storage-safety rests on its OWN
     index/edge role, never cascades from an excluded var: verified by
     inspection and by the safe-control test below, which pins that a
     plain local copy `e = id` is unaffected by `id`'s own verdict).
  2. `widenLocalTypes` gained Pass D: a level-1 (intLevelMap) local that's
     STILL i32-typed after Passes A-C AND has a bare escape widens to f64;
     level-2 locals need no check (every value they can hold already fits
     i32, by construction).

PERF GUARD verified, not assumed: `for(i=0;i<n;i++) a[i]` stays i32
(comparison-governed, exempt regardless of other arithmetic) — perf-ratchet
`int`/`cond`/`buf`/`nest`/`slice`/`ring`/`condref`/`fgather` all confirmed
+0 (8/10 categories, byte-identical op counts, zero over-disqualification).

**HONEST TENSION, not silently absorbed (2 of 10 ratchet categories,
`float`/`mixed`, RE-BASELINED with proof, not "fixed"):** perf-ratchet's
own randomly-generated corpus (scripts/perf-corpus.mjs) happens to sample
EXACTLY the bug's shape by construction — `float`/`mixed`'s own category
definition is `let acc = 0; for(...) acc = acc + (expr); return acc` with
NO `|0` and NO comparison on `acc` (deliberately, unlike the `int` category
which wraps every step) — a plain, unguarded accumulator returned bare.
Differential-tested against real JS (not assumed): `let acc=0; for(i<n)
acc=acc+i; return acc` at n=100000 — OLD `704982704` (wrong), NEW
`4999950000` (JS-exact); the ratchet's own seed=27 `mixed` program at
n=50000 — OLD `25777188`, NEW/JS `-128823241692`. EVERY op-count delta in
these two categories (float +5, mixed +181 — verified seed-by-seed via a
`git worktree add HEAD` A/B, not assumed uniform) traces to this exact
bug, not a missing admission — added the Math.imul/clz32 admission anyway
(a real, narrower missing-admission fix, confirmed it does NOT change
either category's op count: the outer `acc + (...)` accumulation is the
governing escape regardless of what's admitted inside it). There is no
sound way to keep these programs' accumulator on the i32 fast path without
the SAME deferred "for-loop-bound-as-intExprRange-fact" mechanism the P0-2
ledger already named as future work — re-baselined via `node
test/perf-ratchet.js --update` (float 560→565, mixed 790→971;
`int`/`cond`/`buf`/`nest`/`slice`/`ring`/`condref`/`fgather` byte-identical,
confirming the re-baseline is scoped to exactly the two categories the bug
touches). perf-ratchet 10/10 green on the new, justified baseline.

VECTORIZER RECOVERY CHECK (requested by this ticket — verdict: NOT
recovered, unrelated root cause): mat4/fft/crc32/biquad size spot-check
re-run post-fix — mat4 still 1543 bytes (the P0-2 ledger's +15B baseline,
unchanged), fft/crc32/biquad still byte-identical (2368/1107/1861). The
mat4 delta and the tryStencil/tryButterfly declines are rooted in the
SEPARATE, already-identified "no for-loop-bound-as-intExprRange-fact"
gap (emit-time arithmetic admission for `i+1`-shaped bounds), not in
collectI32SafeIndexVars/widenLocalTypes' storage classification — this fix
doesn't touch that gap, so no recovery expected or observed. Confirmed,
not assumed.

SIBLING LEDGER (grepped analyze-scans.js/narrow.js + the named classes —
typed-elem narrowing, slotI32Certain, global-narrow — per this ticket's
own ask; each ruled in/out with reasoning, not just grepped):
  - RULED OUT — `ctx.types.typedElem` (typed-array ctor binding): not a
    magnitude-blind promotion at all — it resolves a var's bound TypedArray
    CONSTRUCTOR from its actual `new XxxArray()` call site, so reads/writes
    through it use that ARRAY'S real element format, mirroring true JS
    TypedArray coercion exactly (not an optimizer approximation that could
    drift from the source's actual semantics).
  - RULED OUT — `ctx.schema.slotIntCertain` / `slotIntCertainAt` (schema
    slot integer census, src/compile/analyze.js `analyzeIntCertain`): its
    consumers (Math.floor elision, ToNumber-skip via ir.js `asF64`,
    `intIndexIR`'s index fast path) are all per-USE-SITE VALUE-CONTEXT
    elisions (skip a redundant coercion GIVEN the value is already known
    integer/number-kind), never a commitment that narrows the SLOT'S OWN
    memory representation to i32 — schema slots stay NaN-boxed f64 in
    memory regardless; there is no "later bare read of corrupted storage"
    exposure because there's no narrowed storage to corrupt.
  - RULED IN, SOUND — `ctx.schema.slotI32Certain` / `slotI32CertainAt`:
    this IS the strict, level-2-equivalent projection by construction
    (ctx.js's own comment: "the strict (=2) projection: every write is
    exactly-int32 and never -0") — exactly the level-2 case Pass D already
    exempts, for the same reason (every value it can hold already fits
    i32). No fix needed; confirmed by design, not just by absence of a
    failing repro.
  - RULED IN, LIVE BUG, OUT OF THIS TICKET'S FILE SCOPE (analyze-scans.js/
    narrow.js) — `src/compile/plan/scope.js`'s module-global i32-narrowing
    (the `declGlobal(name, 'i32')` fixpoint, candidates gated by
    `producesFraction`): the SAME bug class, confirmed LIVE via a fresh
    repro (`let counter=4; export let bump=()=>{counter*=100000; return
    counter}`, called repeatedly — jz: 400000, 1345294336, -1827012608;
    JS: 400000, 40000000000, 4000000000000000 — diverges the 2nd call).
    `producesFraction`'s compound-assign handling (INT_COMPOUND vs the
    `record()`+`producesFraction` path) checks only whether the RHS
    OPERAND is integer-valued, never whether the accumulated PRODUCT/SUM
    stays in i32 range, and a module global's every read is inherently a
    "bare escape" (no local-scope containment) — same root shape as this
    ticket's #1/#2, living in a THIRD file/mechanism. NOT fixed here
    (genuinely separate fixpoint, own repro-first/gate cycle, not
    reachable via this ticket's collectBareEscapes without duplicating it
    across plan/scope.js's different AST-walk shape) — flagged as the
    highest-priority follow-up in this bug family.

TEST UPDATES: test/inference.js — the KNOWN-FAIL test flipped to its
corrected name/values (`compound-assign on an index-back-propagated local
no longer wraps on a later bare read`, both `*=`/`+=` arms now assert the
JS-exact values); added a new safe-control structural pin (`safe control:
index-use counters with no unresolved bare escape keep i32 storage` — two
arms: a plain comparison-governed index counter, and a ToInt32-rooted
accumulator with a bare uncompared return) confirming the perf-guard shape
survives. test/perf-ratchet.json — float/mixed re-baselined per the
tension note above (see the commit for the exact numbers).

GATES: repros red→green (native AND kernel leg — fresh `npm run build`,
~5min, both `id`-shape arms and the isolated no-array control). Full
battery: all 88 test/index.js TESTS files run individually, zero
uncurated fails. kernel-parity 33/33 byte-identical (O0/O2/O3, post-
rebuild). kernel-oracle 11/11 (451 assertions). perf-ratchet 10/10 on the
justified re-baseline (see tension note). optimizer.js 214/214 (3949
assertions). selfhost.js 21/21 (206 assertions). selfhost-perf.js 5/5
(warm geomean 0.996×/cap 1.03×, fresh 0.793×/cap 0.99× — both comfortably
under cap, no regression vs the P0-2 ledger's 0.994×/0.813×). fuzz.js:
2000 seeds × opt{0,1,2,3}, 0 divergence (30173 inputs compared, 9827
skipped i32-contract-exceeded, ~225s). examples.js 22/22 (433 assertions,
unchanged from the P0-2 ledger — no new stencil/vectorizer fallout). Size
spot-check: mat4 1543B (+15B baseline, unrecovered — see vectorizer
verdict above), fft/crc32/biquad byte-identical (2368/1107/1861).

REPROS (live at HEAD, confirmed before any edit, both via the `run`/`jz.compile`
harness — see .work/todo.md's own P0-2 entry above for the sibling audit that
found these):

- Bare `+`: `export let f = (a,b) => { let x=a|0,y=b|0; return x+y }`,
  `f(2147483647,2147483647)` → jz `-2`, JS `4294967294` (exact, f64-representable
  — `Number.prototype` `+` is IEEE-754 double addition, ECMA-262 6.1.6.1.7).
- Bare `-`: same shape, `f(-2147483648,2147483647)` → jz `1`, JS `-4294967295`.
- compoundAssign `*=`/`+=`/`-=`: `emit.js`'s admission (`if (i32op && va.type
  === 'i32' && vbi.type === 'i32') return i32op(va, vbi)`) had ZERO magnitude
  gate — confirmed the mechanism fires (WAT dump: raw `i32.mul`/`i32.add`, no
  bound check) but see KNOWN GAP below for why the id-storage repro's VALUE
  survives regardless.

FIX (root, same shape as the already-landed mulFitsI32 fix): `addFitsI32(va,
vb) = opBound(va) + opBound(vb) <= 0x7fffffff` (emit.js — reuses `opBound`
verbatim; triangle inequality `|a±b| <= |a|+|b|` makes ONE predicate sound for
both `+` and `-`, unlike `*`'s per-op product). Typed-magnitude twin
`addBoundedFaithful` (mirrors `mulBoundedFaithful`, via `i32Mag`) and AST
range-hull twins `addRangeFitsI32`/`subRangeFitsI32` (mirror `mulRangeFitsI32`,
via `intExprRange` — separate functions since interval `+`/`-` aren't
symmetric the way the magnitude bound is) OR'd in at the primary bare `+`/`-`
sites. `compoundAssign`'s fast path gated the identical way, dispatched on
`arithOp` (`*` → mulFitsI32 family, `+`/`-` → addFitsI32 family, `%`/bitwise →
ungated, already sound by construction).

**type.js `exprType`'s `strict` parameter — the ratchet-critical fork.**
Naively mirroring `*`'s ALWAYS-strict exprType rule onto `+`/`-` (matching the
sibling-audit's literal framing) demoted 8/10 perf-ratchet benchmarks (up to
+367 loop-body ops) — `s = s + f(...)` accumulators and `arr[i]+1`-as-call-
argument are THE hottest, most common shapes in real code, unlike `*`'s
equivalent (rare enough its own bound-tightening never hit the ratchet suite).
Root-caused via bisection (isolate each layer, re-measure): exprType's `+`/`-`
verdict feeds MANY callers with DIFFERENT soundness needs — local/param
storage-type decisions (narrow.js widenLocalTypes, param-consensus) are SAFE
staying magnitude-blind (a value merely STORED i32 is safe regardless of
magnitude, because every READ of that storage re-applies the SAME ToInt32
conversion the WRITE did) — only callers deciding whether a value may escape
BARE (no further ToInt32 sink) need the strict proof. FIX: `exprType(expr,
locals, valTypes, strict)` — `strict` defaults undefined/false (preserves the
pre-existing magnitude-blind "both operands i32" rule, thread through every
recursive self-call); `strict=true` layers the SAME `bound()` magnitude check
`*` already uses. Wired `strict=true` at exactly the two callers with a
genuine bare-escape concern: `narrow.js` `narrowI32Results`' return-tail
classification (`allI32`, the canonical bare-escape position — a return type
narrowed to i32 wraps every CALLER-observed value via ToInt32) and emit.js
`tryI32Arith` (the SAME "result used bare, right here" footing as the primary
fast path, for the "peeled" typed-array-read operand shape). `*`'s own rule
(already always-strict since 3b50d504) is untouched.

**ir.js `writeVar`/`asParamType`: `asI32`→`toI32` — the SECOND ratchet-
critical fix, found via a SECOND bisection round.** Even with `strict` scoped
to only the two callers above, `tryI32Arith` going strict ALSO gates the
ubiquitous `i = i + 1` loop-counter-increment idiom (a PLAIN, non-compound
assignment into an i32 local: `i`'s own `+`/`-` combination has no static
bound, so tryI32Arith declines) — this is NOT a bare-escape case (writing into
an i32-typed local IS the "consistent-wrap-safe" case above), but `writeVar`'s
i32-target coercion was `asI32` (no ring recovery), NOT `toI32` (tries
`narrowI32`'s ring-arithmetic recovery FIRST — a STRICT SUPERSET of `asI32`'s
`|0` wrap contract, same ir.js docstring). Swapped BOTH `writeVar`'s plain-
local i32 branch and `asParamType`'s i32 branch (shared by call-ARGUMENT
coercion — the analogous `n-1-i` passed to an i32-narrowed callee param — and
RETURN coercion, safe there because `t==='i32'` only fires once
narrowI32Results has ALREADY strictly proven the tail's magnitude, via the
identical exprType(strict) proof) to `toI32`. This closed the ratchet
regression to 10/10 at +0 — confirmed via isolated bisection at each step (see
the session's own transcript reasoning: restoring HEAD sources via `git show
HEAD:path > path` per file, re-diffing one layer at a time, was essential —
the naive "mirror `*`'s fix" instinct is WRONG for `+`/`-` without this pair of
companion fixes).

GATES: repros red→green (native, `(a+b)|0` wrap-safe pin confirms narrowI32's
EXISTING generic `f64.add`/`f64.sub` recovery — untouched, no new code needed
there, matching how `3b50d504` relies on it for `*`). Fresh `npm run build`
×2 (post-stash-mishap re-verification — see below). kernel-parity 33/33 byte-
identical (O0/O2/O3). kernel-oracle 11/11 (451 assertions). perf-ratchet
10/10 at +0 (confirmed via full A/B bisection: emit.js primary-path-only =
+0; adding strict tryI32Arith without the toI32 swap = 8/10 regressed up to
+367; adding the toI32 swap = 10/10 restored). optimizer.js 214/214.
inference.js 129/129 (273 assertions, +4 new tests). Full battery: all 89
test/index.js TESTS files + `simd`/`selfhost`/`selfhost-perf` (not in the
TESTS list) run individually — zero fails after the 4 test-file corrections
below. selfhost.js 21/21 (206 assertions). selfhost-perf.js 5/5 (all six
per-case mat4/fft/biquad/sort/crc32/mandelbrot comparisons within cap, warm
AND fresh — warm geomean 0.994×/cap 1.03×, fresh 0.813×/cap 0.99×). fuzz.js:
2000 seeds × opt{0,1,2,3}, 0 divergence (30173 inputs compared, 219s).
examples.js 22/22 (433 assertions) after the stencil-vectorizer known-gap
updates. simd.js 158/158 (580 assertions) after the butterfly/breadth known-
gap updates. cond-vectorize.js 3/3 after re-masking the two-arm select's
`else` arm. Size spot-check (mat4/fft/crc32/biquad, exact bytes via `bench-
size.mjs --json` A/B'd against a `git worktree add` HEAD checkout, NOT git
stash — see incident note): fft/crc32/biquad BYTE-IDENTICAL (2368/1107/1861
bytes exactly). mat4 +15 bytes (1528→1543) — fully attributable to the
ALREADY-DOCUMENTED loop-counter-range gap (mat4.js: `a[i] = (i + 1) * 0.125`
inside `for (let i=0;i<16;i++)` — `i+1`'s magnitude is trivially proven-safe
BY THE LOOP BOUND to a human, but jz has no mechanism to turn a for-loop's own
`i<16` guard into an `intExprRange` fact for `i`, so `addFitsI32`/
`addRangeFitsI32` can't admit it — same root cause as the pre-existing
"LOOP-COUNTER RANGE GAP" entry above, now ALSO costing `+`/`-`, not just
`*`). Confirmed value-correct (byte delta only, not a value bug) via the
bit-exact assertions throughout the battery.

**KNOWN GAP #1 (compoundAssign, NOT closed by this fix — separate root
cause, precisely diagnosed, flagged for its own repro-first/gate cycle):**
the ledger's own FFT-butterfly-shaped repro (`id` back-propagated to i32 via
`i0 += id`, then `id *= 100000` / `id += (d|0)` wraps when later read bare)
remains WRONG after this fix — proven via a direct A/B (temporarily disabling
compoundAssign's i32 fast path entirely reproduces the IDENTICAL wrong
output) that the ACTUAL cause is `collectI32SafeIndexVars`'s promotion/
back-propagation (`src/compile/analyze-scans.js` ~L877-892): it marks ANY
var that's an operand of an assignment feeding an already-index-safe var as
"i32-safe" PERMANENTLY, for the WHOLE function, regardless of that var's own
later magnitude growth or whether it ALSO escapes bare elsewhere. Once a
var's storage is i32 this way, `writeVar`'s `toI32` coercion (this ticket)
wraps EVERY write into it via ToInt32 REGARDLESS of which arm computed the
value — mathematically certain for `+`/`-` (two i32-magnitude operands'
sum is always <2^53, narrowI32's ring-safety ceiling, so it ALWAYS recovers
to the identical wrapped i32.add) and true for the `id*=100000` case
specifically (product also <2^53). This makes compoundAssign's OWN gate
PROVABLY INERT for this exact shape — the gate is still correct/necessary
(matches the sibling ask, and DOES matter when the compound-assign's OWN
result escapes to a DIFFERENT non-i32 consumer, e.g. `return (a *= b)` —
pinned in inference.js) but cannot fix a value bug whose true cause is one
level up, in the LOCAL-STORAGE-TYPE decision. Root cause is the SAME class
(magnitude-blind admission) as the just-fixed mulFitsI32/addFitsI32, living
in a DIFFERENT function. Pinned at its CURRENT wrong value (`1345294336` for
`*=`, `-2147483645` for `+=`) per the documented-KNOWN-FAIL convention
(test/dyn-keys.js) in inference.js so a future analyze-scans.js fix flips
these asserts.

**KNOWN GAP #2 (vectorizer/pattern-recognizer fallout — NOT value bugs,
confirmed bit-exact everywhere, but real capability loss, flagged for
follow-up):** several highly rigid, structural pattern-matchers (tryStencil,
tryButterfly in src/optimize/vectorize.js; the generic lane vectorizer's
i32Backed fast path in module/typedarray.js) pattern-match on an EXACT raw
`i32.add`/`i32.sub` IR shape, or on an exact statement-count/structure. Where
the now-correctly-conservative `+`/`-` falls to the guarded f64 path (no
static bound available — same "no for-loop-bound-as-intExprRange-fact" gap
as above, now ALSO hitting stencil BOUNDS computed from i32-narrowed GLOBALS
like `w-1`, which can NEVER get a decl-range fact the way a local might, and
typed-array STORE value coercion in module/typedarray.js's `wrapIntIR`
fallback — a THIRD `asI32`-without-`narrowI32`-recovery site, same family as
the writeVar/asParamType fix above, NOT yet extended there), these
recognizers decline entirely rather than degrading gracefully:
- `test/cond-vectorize.js` "two-arm select" — FIXED by re-masking the
  `else` arm (`(a[i]&127)+1`), mirroring the EXISTING precedent this same
  test already used for the `*` sibling's product-safety loss.
- `test/examples.js` watercolor/waves/schrodinger/toroidal-wrap stencils —
  lose ALL `experimentalStencil` vectorization (loop bound `w-1`/`h-1` on a
  narrowed-i32 GLOBAL can't be proven, `tryStencil`'s `boundPureInv` requires
  a raw i32.add/sub/mul chain to splice into the SIMD guard). Assertions
  updated to the new (lower) f64x2 counts with the root cause documented
  inline; bit-exactness (the load-bearing correctness assertions) UNCHANGED
  and still verified.
- `test/simd.js` butterfly (FFT inner loop, `tryButterfly`'s exact 17-
  statement match) and "i32 add arrays" (generic `a[i]+b[i]` on two FULL-
  RANGE Int32Arrays — genuinely not provably safe, correctly declines) —
  same treatment, bit-exactness confirmed unaffected (`von(n)===voff(n)`
  for all N in the butterfly case).
Follow-up (not attempted here, explicitly out of THIS ticket's scope per its
own "loop-counter-range... do not attempt it here" fence, but now
PRECISELY located, unlike before): (a) extend `intExprRange`/a genuine
for-loop-bound-fact mechanism to cover loop counters AND i32-narrowed
globals — the single highest-leverage fix, closes the mat4 byte delta, the
stencil bound losses, and the pre-existing loop-counter-range gap in one
mechanism; (b) extend the `asI32`→`toI32` swap to module/typedarray.js's
`wrapIntIR` non-i32Backed store path (and audit for siblings — this family
of "wrap without ring-recovery" call sites is NOT exhaustively enumerated,
found only via these three regressions).

**INCIDENT NOTE (process, not a defect):** mid-verification, an accidental
bare `git stash` (forbidden per this repo's git-safety rules — repo-wide,
destructive) stashed all uncommitted changes; immediately caught and
reverted via `git stash pop` (the stash's own inverse, not a DIFFERENT
destructive op) before any further action, changes verified byte-identical
via `git diff --stat` + a perf-ratchet re-run. All subsequent A/B comparisons
(size spot-check, the sourced-based-bisection above) used `git worktree add`
against a temp path instead — never `git stash` again this session.

TEST UPDATES: 4 new regression tests in test/inference.js (addFitsI32 sum-
range soundness — bare `+`/`-` wrong-value pins, JS-authority; addFitsI32
keeps-fast-path — masked-both-sides + `(a+b)|0` + `i=i+1` loop-counter
structural pins; compoundAssign-escapes-bare pin; the KNOWN GAP pin for
BOTH `*=` and `+=`/`-=` id-shapes). 1 file corrected in test/cond-
vectorize.js (re-mask the `else` arm). 4 assertions corrected in
test/examples.js (stencil vectorization counts, root-caused inline). 2
assertions corrected in test/simd.js (butterfly + breadth-matrix "i32 add
arrays", root-caused inline).

## Status (2026-08-02, P0-2 mulFitsI32 product-range unsoundness FIXED at root — banked bug class #1 closed)

REPRO (live at HEAD, confirmed before any edit): `mulFitsI32` (emit.js `*`
operator) admitted `i32.mul` whenever EITHER operand was provably `<= 2^22`
(FITS_I32_MAX, widen.js), with NO check on the other operand or on the
product itself. `export let f = (x) => { let y = x|0; return 4194304 * y }`
compiled `4194304*y` to `i32.shl(y,22)`; `f(1000)` returned -100663296
instead of the true 4194304000 (JS: `4194304*1000`). Second live arm (the
mask-bounded side, not just the literal side): `xx*(yy&63)` for xx=1e8,
yy=63 returned 2005032704 instead of 6300000000. Root cause, precisely: the
threshold's OWN justification (widen.js docstring) reasoned about keeping
the product within F64-EXACT range (2^53) against one FULL-i32-range (2^31)
operand — but `i32.mul` truncates mod 2^32 regardless of f64-exactness, so
that 2^53 bound was simply the wrong ceiling for what `i32.mul` actually
computes; only ±(2^31−1) is safe once the result may be widened straight to
f64 with no further ToInt32 sink to absorb the wrap. (Literal×literal, e.g.
the historical `32768*65536` repro, was never actually exposed — `foldConst`
intercepts both-literal products with real JS arithmetic before mulFitsI32
is reached; that path stayed correct throughout.)

FIX (root, not symptomatic): `i32.mul` now admitted only when the exact
product is PROVEN to fit signed i32 from a magnitude BOUND on BOTH operands,
not either alone — `opBound(v) = isLit(v) ? |litVal(v)| : maskBound(v)` (IR-
level; `maskBound`, ir.js, already existed for the masked-scale case, and
defaults to the full i32 magnitude 2^31 for anything it can't prove
tighter), `mulFitsI32 = opBound(a)*opBound(b) <= 0x7fffffff`. type.js's
`exprType` mirror (the SOUNDNESS INVARIANT: type's i32 verdict must be a
subset of emit's) rewritten the same way, AST-level, via `intExprRange`'s
hull instead of `maskBound`. `mulBoundedFaithful` (typed-array-element
magnitude products) and `mulRangeFitsI32` (AST range-hull products) were
ALREADY sound — both always required a bound on BOTH sides — left
unchanged, still OR'd into the admission at the `*` call site.
SUPPORTING FIX: `narrowI32` (ir.js, the ring-arithmetic `f64→i32` narrowing
`toI32` uses under a PROVEN ToInt32 root — `&`/`|`/`^`/`<<`/`>>>`/an i32-
typed local destination) had its leaf `maxAbs` widened from a blanket i32
ceiling to `maskBound`, so a masked-but-otherwise-unbounded operand (e.g.
bytebeat's `t*(m&63)` under a trailing `&255`) still narrows to `i32.mul`
there — sound BECAUSE narrowI32 only ever fires under a confirmed ToInt32
consumer (wraparound is provably harmless there), unlike the bare `*`
operator this ticket fixes (no such guarantee — the result may escape as a
plain f64 NUMBER with nothing to re-truncate it).

SIBLING HEURISTIC AUDIT (task step 3 — ruled explicitly):
- `mulBoundedFaithful`, `mulRangeFitsI32`: SOUND, unchanged (both already
  bilateral).
- `%` (i32.rem_s): SOUND — a remainder is bounded by its own divisor by
  construction; no combination-overflow is possible.
- `<<`/`>>`/`>>>`/`&`/`|`/`^`: SOUND by construction — pure 32-bit-domain
  ops, no magnitude-combination overflow exists for them to begin with.
- `+`/`-` bare fast path (emit.js: `isI32Num(va)&&isI32Num(vb)` → native
  `i32.add`/`i32.sub`, UNCONDITIONALLY, no magnitude check at all — worse
  than the old mulFitsI32, which needed at least ONE bound) and its
  type.js exprType mirror: RULED **UNSOUND**, confirmed live —
  `(a|0)+(b|0)` for a=b=2147483647 returns -2, JS gives 4294967294. NOT
  fixed here (separate mechanism, separate blast radius, needs its own
  repro-first/gate cycle) — flagged as the most direct follow-up.
- `compoundAssign`'s `*=`/`+=`/`-=` fast path (emit.js ~L3848:
  `if (i32op && va.type==='i32' && vbi.type==='i32') return i32op(va,vbi)`):
  RULED **UNSOUND**, confirmed live and WORSE than either of the above —
  zero gating whatsoever (not even one bound). `let n=x|0; n*=100000;
  return n` is accidentally correct today ONLY because `n`'s own exprType
  decision (my fixed rule) independently lands 'f64' when nothing else pins
  it i32 — but the FFT-butterfly perf.js pin (`id*=4` inside a loop
  where `id` is ALSO used as an i32 index stride) pins `id` to i32 via
  OTHER uses, and `id*=100000` in that same shape returns a genuinely wrong
  wrapped value when `id` is later read as a bare number (confirmed via a
  constructed repro: 4-iteration id growth, direct `return id` diverges from
  JS). NOT fixed here — same reasoning as `+`/`-` above. **This is the
  single most urgent follow-up** — compound assignment is a far more common
  idiom than the bare `*` this ticket closes, and it currently has no
  product-safety gate at all, not even the (former) unsound one.
- LOOP-COUNTER RANGE GAP (found via fallout, not itself a soundness bug):
  `intExprRange`'s string case only ever answers from a STAMPED decl-range
  rep (analyze.js, never-reassigned `let`/`const` only) — a bare loop
  counter (`for(;i<N;i++)`, reassigned every iteration) has NO range fact
  by construction, literal `N` or not. The OLD mulFitsI32 never needed one
  (a bounded literal alone was enough); the corrected rule does, so `i*K`
  fill-loop idioms (`a[i] = (i*K+C)&M` — a very common array-fill/PRNG/hash
  shape) lose their `i32.mul` fast path even when `i`'s loop bound is a
  compile-time literal well within safety (test/wat-invariants.js sweep:
  200/200 seeds hit it for the two affected fuzz-generator families).
  Confirmed value-correct throughout (fuzz.js: 2000 seeds × 4 opt levels, 0
  divergence) — purely a lost optimization. Recovering it needs a genuine
  "loop counter ranged by its own for-head bound" fact, which does not
  exist yet in any form I could find (`smallConstForTripCount` is unroll-
  budget-scoped and unrelated; the interval-proof machinery in type.js
  around `IP_LIM`/`scanIntervalIdx` computes per-name intervals for a
  DIFFERENT purpose — typed-index bounds-check elision — and isn't exposed
  for reuse). NOT attempted here (a real, separate feature, not a
  mulFitsI32 patch) — flagged as the highest-VALUE follow-up (broadest
  reach of any gap found in this audit), separate from the two unsound-
  sibling findings above.
  Also SEPARATELY confirmed live-broken by the SAME class before this fix:
  `a[0]=2000000000; a[0]*2` on a full-range Int32Array element (no
  narrowing load width, unlike Uint8/16Array) wrapped to -294967296 instead
  of 4000000000 at HEAD — now correct (routes to f64.mul; cond-vectorize.js
  test adjusted to re-mask before multiplying so it tests its own subject,
  the two-arm-select-to-bitselect lift, decoupled from this).

BIGNUM 15-BIT-LIMB NOTE (task step 5, report-only, NOT changed): the limb
base was narrowed from the natural 16-bit split specifically to dodge this
exact bug (bignum.js docstring, self-host bootstrap era). With the fix
landed, 16-bit limbs would no longer silently MISCOMPILE if re-adopted —
the corrected `mulFitsI32` can't prove an arbitrary (unmasked) limb-array
read `a[i]` bounded either, so a 16-bit limb product would now correctly
fall to `f64.mul` (safe: two <2^16 values' exact product is always f64-
exact) rather than wrapping through `i32.mul`. That trades away the "one
i32.mul, no split" property 15-bit limbs get for free (32767² < 2^31−1,
provable via `mulBoundedFaithful`'s typed-magnitude path once the source
masks the limb, otherwise via nothing at all today — same loop-counter-
style gap as above for a plain array read). Not touched — kernel-sensitive,
its own change with its own gate cycle, per the task's explicit scope
fence.

TEST UPDATES: 2 new regression tests in test/inference.js (wrong-product
value pins — bare `4194304*(x|0)`, bare `(x|0)*(y&63)`, both against host
JS as authority since neither has a truncating sink to absorb a wrap; a
both-≤2^15-masked-operand WAT-shape pin proving the fast path survives for
a genuinely range-proven product) + 2 new pins in test/optimizer.js (digit-
accumulator value-correctness past the old i32 wrap boundary). 5 EXISTING
tests updated to match the corrected (and in 3 cases, independently-more-
correct) codegen shape, each with the P0-2 reasoning inlined at the site:
test/inference.js (bytebeat masked-multiply comment refreshed to explain
the narrowI32 recovery path; plain-array-index dyn-props-arm convert count
2:1 not 1:1 — the cold arm now builds an exact f64 key instead of an
unsound wrap-then-convert), test/optimizer.js (q16 delayline chain: `d`
itself still native i32/i32.add/i32.mul, confirmed — only the div-to-shift
strength reduction is lost, root-caused to a SEPARATE, pre-existing pass-
ordering gap: `d`'s local-storage-type fixpoint runs before analyze.js's
decl-range-stamping walk over the SAME body, so `t`'s real, provable range
isn't visible yet when `t*DSPAN`'s admission is decided — charCodeAt digit
accumulator: trunc_sat count 0→1 at the final bare `n|0`, `c` itself
unaffected, is-safe-under-final-|0 vs is-safe-as-a-standalone-value is
exactly the P0-2 distinction), test/perf.js (FFT nested-loop pin: `ix`'s
`2*(id-1)` — id is compound-multiplied, unbounded — round-trips through f64
once per OUTER iteration only, inner hot loop unaffected, assertion scoped
to the inner loop), test/wat-invariants.js (Int32Array min/max + IV-SR
sweeps: 0→200/200 seeds — converted from a hard-zero gate to a documented
ratchet, matching the file's own established convention for "one generator
with a documented narrowing gap" — root cause is the loop-counter-range gap
above, not a correctness issue: fuzz.js's 2000-seed differential sweep
confirms zero value divergence).

GATES: repros red→green (native). Fresh `npm run build`; kernel-parity
33/33 byte-identical; kernel-oracle 11/11; perf-ratchet 10/10 at +0 (no
ratcheted benchmark hits the loop-counter-range or compoundAssign gaps).
Full battery: all 88 test/index.js TESTS files run individually, zero
fails (after the 5 test-file corrections above). optimizer.js 214/214
(213 + 1 new). selfhost.js 21/21. selfhost-perf.js 5/5, all six per-case
comparisons (mat4/fft/biquad/sort/crc32/mandelbrot) within cap both warm
and fresh. fuzz.js: 2000 seeds × opt{0,1,2,3}, 0 divergence. Size spot-
check mat4/fft/crc32/biquad @ optimize:'speed', pre-fix vs post-fix:
byte-identical (their multiplies are all range-proven, untouched by this
fix) — matches the perf-ratchet +0 result.

## Status (2026-08-02, maybeUndefined Slice 1 landed — dict absent-key value join)

DICT ABSENT-KEY VALUE JOIN LANDED (.work/maybe-undefined-design.md Slice 1):
closes the dict-census KNOWN-FAIL the audit-#7 P0 revert left pinned
(test/dyn-keys.js, "dict: .get()-equivalent read on an absent key is WRONG
today") — `dictValueKindOf`'s exact-kind claim ("every value ever WRITTEN
through name[anyKey]=v") was being trusted uncoerced at two hand-rolled
fast-arm chokepoints, so an ABSENT key's real runtime `undefined` rode
arithmetic/String() as if it were the census's claimed kind. FIX:
`censusMaybeUndefined` (src/kind.js, promoted from the inline predicate
emit.js's `nullableOperand` already computed for its own identity-fold
carve-out) wired into ir.js `toNumF64` (coerces the NUMBER arm through the
pre-existing `coerceNullishToNum`: undefined→NaN, matches ToNumber(undefined)
per ECMA-262 7.1.4) and module/string.js `bind('String', …)` (falls through
to the already-correct `toStrI64`/`__to_str` general arm: undefined→"undefined"
per 22.1.3.6). Verified live (not assumed) that `toStrI64`/`__to_str`/template
literals needed NO fix — `__to_str` already special-cases UNDEF_NAN/NULL_NAN
before generic dispatch, and `strcat`'s per-part fast arm is an IR-SHAPE check
(`v.type==='i32'`) that's structurally false for every NaN-boxed dict read —
confirmed with direct probes, both dict and Map, pre- and post-fix.
REGRESSION FOUND AND FIXED DURING LANDING (test/simd.js, 6 failures —
stencil/tonemap/mirror-store): the design's promoted predicate called
`dictValueKindOf(name)` directly, bypassing the RECEIVER-KIND elimination
order that makes it safe inside VT['[]']/VT['.'] (TYPED/STRING/tracked-
Array<VAL> branches resolve first there, kind.js ~396-413, so the fallback
is never reached for those receivers in real dispatch). The dict census's
GLOBAL half (program-facts.js ~839) is receiver-kind-BLIND by design ("gate
lives at CONSUME time") — a Float64Array named `a` written via `a[i]=…`
picks up a `dictValueValType` fact too. Calling `dictValueKindOf` directly
(as the promoted predicate does) surfaced that latent cross-kind pollution:
`censusMaybeUndefined` fired true for `a[j-1]`/`a[j]`/`a[j+1]` in the SIMD
stencil kernel, forcing a runtime `coerceNullishToNum` `if` onto values
already protected by the SOUND, cheaper `checkedNumRead` compile-time fold
— never unsound (coerceNullishToNum on a real number is a no-op), but it
silently defeated the vectorizer's WAT-shape pattern match. Bisected by
reverting each of the 4 edited files individually against test/simd.js;
root-caused with a debug print on the predicate firing on `a` (Float64Array).
FIXED: `dictCensusReceiverIsLive` guard added to `censusMaybeUndefined`
(src/kind.js) — excludes TYPED/STRING receivers and arrayElemValType-tracked
Array<VAL> receivers (local + global-with-!dynWriteVars), replicating the
same three name-keyed, key-independent facts kind.js's real elimination
order checks before ever reaching `dictValueKindOf`. test/simd.js back to
158/158 after the guard; perf-ratchet 10/10 at +0 delta confirms proven-
NUMBER hot loops pay zero new cost, matching the design's §5 cost claim
(which undercounted this one path — recorded here so it isn't silently lost).
KNOWN-FAIL PINS FLIPPED (test/dyn-keys.js): both dict-absent-key asserts
now pin the CORRECT values (`NaN`, `'undefined'`; were `undefined`, `'NaN'`),
known-fail comment removed, header rewritten to state the fix + the
dictCensusReceiverIsLive guard's own reasoning.
CENSUS CONSUMER STATUS: `dictValueKindOf` itself is UNCHANGED — still live,
still returns the exact kind for genuine dict-mode receivers; only the two
named chokepoints now ask censusMaybeUndefined first. `mapValueKindOf`
(the Map .get() consumer) STAYS FULLY DORMANT — this slice is value-join
only, per the task's strict scope; re-enabling it needs the nameEscapes
alias-gate (design §2) and the ~120-site structural census (design §3 item
4), neither attempted here. The `nameEscapes` gate on `dictValueKindOf`
itself (design's Slice 3, the regression-risk slice) is ALSO not landed —
this slice is Slice 1 only.
GATES: repros (dict static-key, dict computed-key, array OOB, Map absent —
arithmetic + String(), 8 cases) red→green pre/post, both legs (native +
kernel wasm share the same src, both exercised). Full battery: all 90
test/index.js TESTS files + interop/abi/external/watr/optimizer/passes (not
in TESTS but exist) + selfhost.js + selfhost-perf.js — zero fails. Two
FRESH consecutive `npm run build` rebuilds of the final source, dist/jz.wasm
and dist/jz.js byte-identical between them (self-host fixed point confirmed,
DECL-INIT WALL tripwire clean). kernel-parity 33/33 byte-identical (rerun
against the twice-rebuilt dist). kernel-oracle 11/11. perf-ratchet 10/10,
every baseline +0. Size spot-check mat4/fft/crc32/biquad @ optimize:'speed'
(-O3), pre-edit (HEAD) vs post-edit source: byte-for-byte `cmp`-identical —
zero maybeUndefined-census values reachable in these numeric kernels, exactly
as the design's cost section predicted (once the receiver-kind guard closed
the gap it had undercounted).
REMAINING SLICES (design §5, all still open): Slice 2 (`emitIsNaN` sentinel
exclusion, scoped to censusMaybeUndefined + checkedNumRead — separate from
the already-landed Number.isNaN carrier fix above, which was receiver-type-
blind rather than sentinel-scoped); Slice 3 (`nameEscapes` alias-gate on
`dictValueKindOf`, the regression-risk slice, needs its own perf-ratchet/
bench-size before/after per design §5's cost note); Slice 4 (Map
re-enablement — `mapValueKindOf` + VT['()'] `.get` short-circuit +
`nullableOperand`'s carve-out, landing all three in one commit per design
§3); Slice 5 (~120-site structural census, can run in parallel, blocks only
the final re-enablement declaration). Also still open, unscoped: the
`JZ_DEBUG_INVARIANTS` tripwire design sketched (§1 closing paragraph) and the
broader Number.isNaN("hi")/isNaN({}) leak's general is-this-a-Number fix
(design §4) — both explicitly flagged, neither required for this slice.

## Status (2026-08-02, Number.isNaN carrier miscompile fixed)

NUMBER.ISNAN/ISFINITE/ISINTEGER/ISSAFEINTEGER CARRIER MISCOMPILE FIXED
(module/number.js): `emitIsNaN` implemented Number.isNaN(x) as a bare
hardware self-compare (`x !== x`) with NO type discrimination. jz NaN-boxes
every non-number value (string/object/array/undefined/null/boolean/closure)
as a NaN-shaped f64 carrier, so ALL of them satisfied the self-compare —
`Number.isNaN("hi")`/`({})`/`([1][2]` OOB)/`(undefined)`/`(null)` all read
jz `true` vs JS `false`. Per ECMA-262 21.1.2.4, Number.isNaN returns true
only if the argument's Type is Number AND it is NaN — no ToNumber coercion
(unlike the global, coercing `isNaN`, 19.2.3, confirmed already correct via
`toNumF64`, and left untouched). SIBLING AUDIT found the SAME root class,
different manifestation, in Number.isFinite/isInteger/isSafeInteger
(21.1.2.2/.3/.5, same non-coercing contract): their raw `x===x && …`
formula already excludes every NaN-BOXED carrier (self-compare fails on
all of them, so no fix needed there) — but NOT a raw, un-boxed BOOL literal
(`true`/`false` compile to a bare i32 0/1; `asF64` converts it straight to
a real 0.0/1.0 float, no NaN involved) or ANY BigInt (jz's raw i64 BigInt
carrier shares f64's bit-space outright with no distinguishing tag —
`0n`'s bits literally ARE `0.0`). Confirmed real, not hypothetical:
`Number.isFinite(true)`, `Number.isInteger(0n)`, `Number.isSafeInteger(0n)`
all read jz `true` pre-fix.
FIX (gated on `valTypeOf`, zero cost on proven-NUMBER hot paths): a
STATICALLY provable non-Number argument (BOOL/STRING/OBJECT/ARRAY/BIGINT/
UNDEFINED/NULL/…) is unconditionally false per spec regardless of runtime
bits — `nonNumberFalse` evaluates x for side effects and returns a literal
0, shared by all four methods. A provably-NUMBER argument keeps the
original bare arithmetic verbatim (isFinite/isInteger/isSafeInteger
unchanged; isNaN's raw self-compare unchanged). Number.isNaN ALSO needs a
kind-UNKNOWN (dynamic/polymorphic) runtime path — a boxed carrier can still
reach it at runtime — mirroring `$__typeof`'s own number-vs-pointer NaN
split (module/core.js): a genuine number-NaN is either the canonical
NAN_BITS (tag=0/aux=0 — no live atom uses aux=0) or any NEGATIVE-signed NaN
bit pattern (the box prefix is always sign=0); no new tag machinery
invented. isFinite/isInteger/isSafeInteger need no such dynamic path — the
BOOL/BigInt gap was static-carrier-only, confirmed by repro (a genuinely
dynamic/non-inlined boolean argument already read correctly pre-fix,
since it's a proper NaN-boxed TRUE_NAN/FALSE_NAN atom at that point).
KNOWN OUT-OF-SCOPE RESIDUAL: a dynamically NUMBER∪BIGINT-merged value (e.g.
`b ? 5n : 5` fed to a polymorphic param) has NO runtime tag distinguishing
the two at all in jz's representation — confirmed `typeof` already
misreports "number" for exactly this shape today. Number.isNaN's
kind-unknown path inherits the identical limitation (not a regression,
not introduced by this fix — no BigInt tag exists anywhere in the compiler
to consult).
REPRO-FIRST: 40 native value-level cases (string/object/array-OOB/
undefined/null/bool/bigint × all 4 methods, global isNaN/isFinite coercion
contrast, dynamic/polymorphic non-inlined argument via ternary) red before,
green after; pinned in test/math.js (isNaN, isNaN-coercion-contrast,
isNaN-dynamic, isFinite, isInteger, isSafeInteger test blocks).
GATES: dist rebuilt twice (bracketing the size spot-check), full battery
88/88 files zero fails (3 pre-existing skips, unrelated: array-methods,
spread, objects, unsigned — untouched by this change), kernel-parity 33/33
byte-identical, kernel-oracle 11/11 (451 assertions), perf-ratchet 10/10
all +0 (no hot-loop shape touched, as expected — no bench source calls
these builtins), optimizer 213/213, selfhost.js 21/21, selfhost-perf.js
5/5 well under cap (warm 0.975×/cap 1.03×, fresh 0.809×/cap 0.99×, no
re-baseline). Size spot-check (mat4/fft/crc32/biquad at O3, via
scripts/bench-size.mjs, working-tree module/number.js swapped to HEAD and
back via `git show HEAD:path`, no repo-wide git command): all 4
byte-identical pre/post (none of the bench sources call Number.isNaN/
isFinite/isInteger/isSafeInteger, so the new code paths are cold — exactly
as predicted).

## Status (2026-08-02, formatter carrier-dispatch fix landed)

FORMATTER/TOPROPERTYKEY CARRIER-DISPATCH FIXED (.work/formatter-dispatch-
design.md): closed the 3 remaining kernel-oracle.js PENDING-FIX rows
(String(), template literal, computed member key) — the same MECHANISM A/
argIR producer-side collapse un-swept at three consumer chokepoints, NOT
three new bugs and NOT a runtime-dispatch gap (`__to_str`'s TRUE_NAN/
FALSE_NAN atom special-case was already correct; the bug was 100%
upstream of it). Sites:
- module/string.js `bind('String', …)` (~2032): the VAL.NUMBER branch is a
  STATIC-VALTYPE check (not IR-shape), so argIR alone can't skip it —
  added an explicit `hasAmbiguousBoolMerge(value)` early exit boxing via
  `emitIdentitySafe` before `toStrI64`.
- module/string.js `strcat`'s per-part loop (~1913) and `partStrI64`'s
  0-arg fallback (~1885): `emit(parts[i])` → `argIR(parts[i])` — an
  IR-shape check (`v.type === 'i32'`), so argIR's f64-typed
  emitIdentitySafe output structurally stops the i32-PROVEN fast path
  from firing on an ambiguous merge, no extra guard needed.
- src/compile/emit-assign.js:562 `keyExpr = asF64(emit(idx))` →
  `storedValue(idx)` — the 18th unswept MECHANISM A site, the universal
  computed-key emit site feeding `$__dyn_set`.
`argIR` promoted from emit.js's private copy (and core.js's independent
reinvention, left as optional cleanup, NOT done — zero behavior change,
skipped to keep the diff scoped to the fix) to src/bridge.js, mirroring
storedValue's existing chokepoint pattern.
READ-SIDE SIBLING SWEEP (design Finding #2, same session): module/array.js's
dyn-get key sites had the identical bare-emit bypass for `o[k]` reads (no
prior write). Two representative read shapes pinned red→green first
(inline literal-key object, inline dynamic hash), then swept every site
REACHABLE by an INLINE ambiguous-merge key node: i32HashLocal fallback
(~714), emitDynamicKeyDispatch's own keyTmp setup (~793 — reachable via
the boxed-object arm for a NAMED-LOCAL merge key on a boxed receiver),
HASH-receiver useRuntimeKeyDispatch block (~843) and __dyn_get_expr
fallthrough (~849), OBJECT-receiver __dyn_get_expr fallthrough (~856),
and the unknown-receiver-kind proven-NUMBER-key cold arm (~1139) — all
`emit(idx)`/`asI64(emit(idx))`/`asF64(emit(idx))` → `storedValue(idx)` /
`asI64(storedValue(idx))`. VERDICT PER SITE, not blindly swept: four
sites in the design's original 10-line list are a genuinely DIFFERENT,
unreachable-for-this-bug class and were left untouched, with an inline
comment class-check, not a blind conversion — i32HashLocal's literal-
string-key arm and the boxed-object/HASH/known-array `keyType ===
VAL.STRING`-guarded reads (an ambiguous BOOL∪NUMBER merge's VT rule only
ever collapses to NUMBER, never STRING, so these guards structurally
exclude it); and the three `emitDynamicKeyDispatch` call sites gated
`!keyIsNum`/`keyType !== VAL.NUMBER` (same reason, inverted — merges are
always NUMBER, never anything else, so `!== VAL.NUMBER` guards always
exclude them too), including the "1070"-class body the design flagged
that turned out to be reachable only through a call site requiring
`keyType !== VAL.NUMBER` — dead for this bug in every shape tried.
SURPRISE FOUND MID-SWEEP: a NAMED LOCAL holding an ambiguous merge
(`let k = x > 0 && 1; o[k]`, read OR write, any receiver shape) is NOT
closed by this sweep — `storedValue(idx)` is a no-op when `idx` is a bare
identifier string (`hasAmbiguousBoolMerge` only recognizes the literal
`?:`/`&&`/`||`/`??`/`()` AST shape, never an identifier referencing one),
and `k`'s own declaration never boxes the merge in the first place. This
is the SAME root as the already-known, already-out-of-scope DECL-INIT
WALL (carrier-invariant-design.md) / kernel-oracle.js's 'captured-then-
read' PENDING-FIX row — confirmed symmetric on both read AND write
(`o[k] = 'v'` also stays wrong for a named-local `k`), so it is a
pre-existing gap this session did not introduce and does not attempt to
close; left banked, matching the existing row's own scope boundary.
GATES: repro-first native+kernel confirmed wrong before, right after,
for all 3 oracle rows + 4 read-side repro shapes (2 required, did 4).
Two dist rebuilds (one after the string.js/emit-assign.js/bridge.js fix,
one after the array.js sweep) plus a THIRD rebuild confirmed byte-
identical to the second — self-hosted fixed point, no export loss, no
DECL-INIT-WALL-class surprise at any of the 4 new call sites. kernel-
oracle.js: 11/11 tests, 451 assertions, 3 rows flipped PENDING_FIX→AGREE,
2 new read-side AGREE rows added, 0 regressions. Full battery (88 files,
test/index.js TESTS, 15 chunks of ≤6): 0 fails. kernel-parity 33/33,
perf-ratchet 10/10 (every category +0 loop-body ops — formatter dispatch
did not move any hot-loop shape, confirming the design's own "zero
ambiguous merges in the bench corpus" census), optimizer 213/213,
selfhost.js 21/21 functional, selfhost-perf.js 5/5 (warm 0.991x/cap
1.03x, fresh 0.787x/cap 0.99x, no re-baseline), bool-identity.js +
booleans.js + dyn-keys.js explicit reruns all clean. Size spot-check
(mat4/fft/crc32/biquad at O3, compiled against a clean HEAD worktree vs
the fixed working tree): all 4 byte-identical before/after — matches the
design's prediction, nothing to explain.

## Status (2026-08-02, audit-#7 P1 closed)

ERROR-MODEL HOST DECODE FIXED (audit-#7 P1): a no-user-EH module's internal
throws (bounds/coercion/JSON/URI/base64/hex — src/err-codes.js) lower to
`unreachable` traps for wasm-MVP portability (pruneUnusedThrowRuntime,
src/compile/index.js), but the OLD code also stripped the
`__jz_last_err_bits` i64 global + its export along with the `$__jz_err`
Tag — the global is plain mutable-i64 wasm MVP, nothing to do with the
exceptions proposal, so stripping it was never required for MVP
compatibility. Net effect: `jz(\`export let f=()=>JSON.parse('x')\`)
.exports.f()` threw a bare `RuntimeError: unreachable` instead of a
decoded error, and even when decode DID run (a userThrows escape via
WebAssembly.Exception) it built `new Error("SyntaxError: ...")` — a
generic Error with a prefixed message, never a real `instanceof
SyntaxError`. FIX (two independent pieces): (1) pruneUnusedThrowRuntime
now only strips the `$__jz_err` Tag and lowers `throw`->`unreachable`;
the global, its export, and every `global.set` before a throw site are
left alone — comment block rewritten to state the new rationale. (2)
interop.js's decodeThrown extended to also handle
`error instanceof WebAssembly.RuntimeError` when `__jz_last_err_bits` is
exported and nonzero, decoding it exactly like the Exception path
(err-codes.js's ERR_INFO table); a zero-marker RuntimeError (genuine
foreign trap — OOB, stack overflow, OOM — nothing jz's own throw sites
raised) rethrows undecoded. Registry-code decode now instantiates the
REAL class (`new (globalThis[info.name] ?? Error)(info.message)`) instead
of a generic Error with a prefixed name; `.thrown` keeps the raw code,
`.cause` keeps the original wasm error, unchanged. MID-REVIEW CATCH
(external pass on the in-flight diff): the marker was only reset on the
trap path (`if (isMarkedTrap) lastErrBits.value = 0n`) — a userThrows
escape (Exception path) decodes fine but leaves the marker NONZERO, so a
later genuine foreign trap on the SAME instance would misdecode by
reading that stale value. FIXED: the reset now runs unconditionally after
every decode (nothing else reads the global between throws, so it's
safe); pinned (`host decode: a decoded escape does not leave a stale
marker for the next trap`, test/errors.js) — first call escapes+decodes
to a real SyntaxError, second call on the SAME instance hits an unrelated
OOM trap and must surface as a bare RuntimeError, not a repeat
SyntaxError.
PINS: test/errors.js gained 4 host-decode tests (JSON.parse->SyntaxError
with `.thrown===300`, radix->RangeError with `.thrown===205`, a genuine
unmarked trap via a `maxMemory:1` OOM ceiling stays undecoded, the stale-
marker two-call pin above); the existing trap-lowering pin ("uncatchable
internal throw is a trap...") gained three assertions confirming the
last-err global/export/global.set now SURVIVE trap-lowering (previously
only asserted the tag+throw were gone). README.md's error-model bullet
(~line 251) rewritten to state the true contract: escaping throws decode
to real ECMAScript class instances with `.message`/`.thrown` set, no user
`try`/`catch` required; a no-EH module stays wasm-MVP via the small
mutable-i64 marker global; a genuine foreign trap still surfaces as a
bare RuntimeError.
SIZE (hard gate, checked BEFORE commit): keeping the marker global+export
adds a flat +26 B to every no-EH module that carries internal throw
sites (confirmed across scripts/bench-size.mjs's full corpus — every
delta was exactly +26 B, two multi-throw-site outliers +38 B, watr
untouched at +0 since it already carries userThrows). SIZE_GEOMEAN_MAX
(test/bench.js, win/tie-scoped) moved 0.851x -> 0.868x jz/AS — comfortably
under the 1.05x ceiling. One golden pin re-baselined: `aos` win->tie
(test/bench.js SIZE table) — its margin over AS was exactly the +26 B
thin (0.993x -> 1.006x), a deliberate, understood, sub-1% shift from a
correct fix, not a regression; ring-ratchet precedent (see below).
PERF-RATCHET RE-BASELINED (same root cause, same precedent as the
buf/nest/slice/ring/condref wave referenced below): `ring`'s corpus
programs carry internal-throw-triggering stdlib calls inside hot loop
bodies, so the preserved `global.set` per site adds real ops to the
machine-independent loop-body-op-count proxy — 117680 -> 117800 (+120
ops, node test/perf-ratchet.js --update). Every other category (int,
float, mixed, cond, buf, nest, slice, condref, fgather) unaffected (+0) —
their corpus shapes don't carry internal-throw call sites inside loop
bodies.
ARCHITECTURE NOTE (per audit, acknowledged not re-opened): the c28f218c
srcPtrKind/srcPtrAux tag-preserving rebox (carrier-invariant-design.md)
is a narrow diagnostic repair — it silences the P1 predictor's false-
positive assert (one reader) and has zero other production consumers
(zero readers) — NOT completion of represented-value ownership. The
carrier-invariant design doc's box-at-production chokepoint decision
(storedValue promoted to src/bridge.js, 16 raw sites replaced) stays
UNIMPLEMENTED; the decl-init wall (emit.js ~1712 plain `emit(init)`,
captured-then-read oracle row 11) stays PENDING-FIX. This P1 fix does not
touch that item.
GATES (fresh dist rebuild): full 88-file battery (test/index.js TESTS
list) run file-by-file, 0 fail (pre-existing skip counts in array-methods/
spread/objects/unsigned untouched, unrelated to this change). kernel-
parity 33/33 assertions. kernel-oracle 430/430 assertions. fuzz.js 2000
programs x opt{0,1,2,3}, 0 divergence (30173 compared, 9827 skipped i32-
contract, 0 non-numeric). perf-ratchet 10/10 post-rebaseline. optimizer
213/213 (3947 assertions). selfhost.js 21/21 (40 compile-yourself
rounds). selfhost-perf.js 5/5 — warm 0.985x (cap 1.03x), fresh 0.809x
(cap 0.99x), both comfortably under cap despite a foreign Chrome/
Playwright automation session's sustained ~150% CPU load noted during
this session's battery run (no flake observed, no cap touched, nothing
re-baselined). New host-decode pins green.

## Status (2026-08-02, audit-#7 P0 closed)

MAP VALUE-CENSUS .get() CONSUMER REVERTED (external audit, bisection-
confirmed 1db8e55e^ correct, 1db8e55e wrong): the Tier 1 consumer landed
2026-08-01 (previous Status entry below) promoted mapValueValType — "every
value ever WRITTEN through recv.set(k, v)" — to an EXACT VAL.* kind at a
`.get()` READ site. Unsound two independent ways: (1) ABSENT KEY — a Map
`.get(missingKey)` reads real JS `undefined` at runtime regardless of the
observed write kind; a proven-NUMBER census made `m.get(missing) + 1` read
back `undefined` instead of `NaN`, and `String(m.get(missing))` read back
`"NaN"` instead of `"undefined"`. (2) ALIAS WRITES — the census (analyze.js
mapValueTypeOf, program-facts.js's `.set()` observe branch) keys
observations by SYNTACTIC receiver name (`recvName = node[1][1]`), so
`alias.set(k, v)` after `const alias = m` is invisible to a census keyed on
`m`; a direct NUMBER write establishes the fact, the alias's STRING write is
silently missed, and the stale NUMBER kind survives to miscompile the next
read (`m.get('k') - 0` returned the literal string instead of NaN).
REVERTED: kind.js's `mapValueKindOf` (the `.get` short-circuit in VT['()']
ahead of methodValType) deleted outright, along with its call site; emit.js's
matching nullableOperand `.get(k)`-call-shape carve-out deleted (nothing left
for it to protect once the consumer is gone) and its now-unused
`mapValueKindOf` import dropped. The CENSUS ITSELF (analyze.js's same-body
scan, program-facts.js's observeMapValue/mapValueTypes, the reps.js
`mapValueValType` field) was left in place as a DORMANT fact — mirrors the
bigintBoxed precedent (2026-07-29 entry below, "solver fact LANDED and
dormant") — producers still write it, nothing reads it; reps.js's doc
comment on `mapValueValType` and program-facts.js's publish-site comment
both spell out why, so a future agent doesn't rewire a consumer without
first reading the soundness writeup.
PINS: test/dyn-keys.js gained "Map: .get() on an absent key behaves as real
undefined…" and "Map: a write through an alias is not lost to a stale
census kind…" (both "audit P0"), red before the revert (confirmed manually:
`undefined` instead of `NaN`, and a raw string instead of `NaN`), green
after. test/inference.js's Map-census section (the 1db8e55e consumer-wiring
+ soundness-carve-out tests) rewritten: the consumer-wiring test deleted
(it asserted a WAT shape claimed to come from the reverted mechanism, but
that shape turns out to come from an unrelated pre-existing codegen path —
keeping it would have kept a false claim in the suite even though the
assertion itself still passed); the soundness test kept as a plain
baseline-correctness regression pin, header comment updated to state the
revert. Producer-side census tests (module-global/local/poison/seed-literal/
moduleInit/cache-replay) untouched — still true, still pin the dormant fact.
DICT SIBLING CHECKED (read-only, per audit instruction, NOT expanded): 
dictValueKindOf (kind.js, consumed by VT['[]']/VT['.']) has the IDENTICAL
absent-key exact-promotion unsoundness — `d[missingKey] + 1` reads
`undefined` instead of `NaN`, `String(d[missingKey])` reads `"NaN"` instead
of `"undefined"` (confirmed with a computed-key write to engage the
dynWriteVars gate: `const d={}; const wk='a'; d[wk]=1; const rk='zz';
d[rk]`). NOT reverted — it is the PRE-EXISTING dict-value-census consumer
that 1db8e55e's Map design explicitly mirrored, predates this audit's
bisected commit, and reverting it is a materially larger, differently-
scoped change (dict-value-census predates the Map census by design, has its
own consumers wired through two AST shapes, and its own bench-impact
history) that needs its own bisection pass, not a same-day tag-along.
Pinned as a documented KNOWN-FAIL in test/dyn-keys.js ("dict:
.get()-equivalent read on an absent key is WRONG today") asserting the
CURRENT wrong values (`undefined`, `"NaN"`) so a future fix flips the
asserts instead of silently regressing further un-noticed.
OPEN DESIGN ITEM (both Map and dict census consumers, and the broader
missing-value-read class): a sound `.get()`/`[]`-read consumer needs (1) a
represented maybeUndefined JOIN — the read's static kind must be the join
of "every observed write kind" WITH "possibly-undefined" whenever any key
could be absent, not the write-kind alone, so arithmetic/String()/typeof
consumers coerce `undefined` correctly instead of assuming a definite kind;
(2) BindingId-based alias/escape ownership — census observation needs to key
by the underlying binding (SSA-like identity), not syntactic receiver name,
so `alias.set(...)` after `const alias = m` is attributed to the same fact
as `m.set(...)`. Until both land, no container value-census may promote to
an exact VAL kind at a read site. This item's scope also covers the
broader, PRE-EXISTING missing-value read leak the audit flagged in passing
(unrelated to either census): `Number.isNaN([1][2])` is `false` in JS
(reads `undefined`, `NaN` only after arithmetic) but `true` in jz (an OOB
array read is apparently mis-typed as exact NUMBER somewhere upstream of
the census work entirely); dyn-dict missing reads are the same class. Not
reproduced/bisected in this session — flagged for whoever picks up the
maybeUndefined-join design.
GATES (post-revert, fresh dist rebuild): full 88-file battery (test/index.js
TESTS list) run in ~15 chunks of 6 files each — 0 fail (a handful of
pre-existing `# skip` entries, unrelated to this change). kernel-parity
33/33. kernel-oracle 430/430 assertions. fuzz.js 2000 programs/opt{0,1,2,3},
0 divergence. perf-ratchet 10/10 (no regression). optimizer 213/213.
selfhost.js 21/21 (40 compile-yourself rounds). selfhost-perf.js 5/5, BOTH
warm (0.981×, cap 1.03×) and fresh (0.795×, cap 0.99×) geomeans comfortably
under cap despite a foreign browser-automation session's ~160% CPU load
noted at task start (no flake observed, no cap touched, nothing
re-baselined). New audit-P0 pins green.

## Status (2026-08-02, current truth)

REFERENCE EVIDENCE REFRESH ATTEMPT: BLOCKED BY MACHINE POLLUTION, MEMORY GOAL
RE-VERIFIED (session finale). Full 60-case chunked refresh attempted (11
foreground calls, `--cases=<~6>,--json=<tmp>` merged externally, jz self-host
case isolated alone — its compile alone exceeds 180s/target). Anomaly diff
vs committed bench/results.json@2aaeaa19 found from case ~#28 (mat4) onward:
EVERY target (native C, Rust, Go, Zig, every JS engine, every wasm rival, jz
itself) uniformly ~1.35-1.6x SLOWER than committed evidence -- 633 (case,
target) pairs moved >1.3x, ALL in one direction, hitting native C equally --
the exact cross-language uniform-shift signature of machine pollution, not a
real regression. ROOT-CAUSED, two sources: (1) an ORPHANED jz-bench artifact
(`/var/folders/.../jz-bench-c-*/strbuild`, PID 1205) had been pegging one
core at 96% CPU for 13.5+ hours predating this session -- invisible to the
preflight's `ps aux | grep "node (test|scripts|bench)"` pattern because it's
a compiled native binary, not a node process; killed mid-session (too late,
after chunk 4). (2) a SEPARATE, foreign, currently-active Claude Code session
(project /Users/div/projects/color-space, PID 33601, 2+ days uptime) plus
its Playwright-driven Chrome automation (2 processes, ~74% CPU EACH, 2+ days
sustained) -- genuinely outside this session's control, present for the
ENTIRE refresh window, not a mid-run event. The "otherwise idle machine"
precondition this task assumed never held. VERDICT (polluted-refresh
precedent, "REFRESH ATTEMPT POLLUTED 2026-07-30" below): stale-but-honest
beats fresh-but-polluted -- bench/results.json and bench/bench.svg LEFT
UNTOUCHED at their existing (already 24-commit-stale) committed state;
test:claims' FRESH gate correctly still fails, honestly reported, not
papered over.
TINYGO LANE FIXED (pre-flight, landed for the next clean refresh): installed
tinygo 0.34.0 requires go1.19-1.23, system `go` is 1.26.0 ("could not
autodetect root directory" / "requires go version 1.19 through 1.23, got
go1.26"). Fix: `TINYGOROOT=~/.local/tinygo GOTOOLCHAIN=go1.23.6` (auto-
fetches and caches the pinned toolchain once, ~3s per build after that);
verified working across every chunk, 43/60 cases carry `.go` sources.
MEMORY GOAL RE-VERIFIED AT HEAD -- the one axis genuinely regenerable
despite the pollution: peak RSS is a footprint metric, not a timing metric,
and cross-checking memKb old-vs-new on the worst-polluted cases (mat4, poly,
crc32, wordcount) showed all values within ~1% of committed evidence except
ONE single-sample fluke (wordcount's jz-wasmtime memKb read 1.68x high
once; median-of-3 targeted re-run confirmed ~15.1MB, matching prior
evidence -- a CPU-contention timing artifact on ONE sample, not a real
memory-shape change; memKb has no built-in multi-sample median the way
medianUs does). `.work/memcheck-results.csv` regenerated at commit c28f218c
with a metadata header (commit/date/machine/command) -- GOAL-MEMORY
RECONFIRMED: jz-wasmtime beats-or-matches moonrun peak RSS on 40/43
comparable cases, median delta -1200KB (jz leaner; slightly wider than the
2026-07-30 reading's -864KB). `test/bench-claims.js` gained a memory-
freshness gate mirroring the FRESH axis (parses the CSV's `# commit:`
header, same SOURCE_SCOPE git-log check) -- passes clean (0 stale commits
past c28f218c).
NEXT: re-run the full SPEED/SIZE refresh once the color-space session's
Playwright/Chrome automation is confirmed stopped (not this session's call
to force) -- the chunking recipe above is proven and ready to rerun as-is;
extend the preflight check beyond the `node (test|scripts|bench)` pattern to
a full `ps aux`/`uptime` load-average read before the next attempt, since
that narrow grep is what let both pollution sources through undetected.

## Status (2026-08-01, prior truth -- reference refresh session reconciled)

MAP-VALUE CENSUS TIER 1: LANDED (108604fc census, 1db8e55e consumer;
.work/map-value-census-design.md). Scalar mapValueValType only — Tier 2
(schema-id fact, the actual fftplan/provenance OBJECT-edge fix) stays a
separate later design; both provenance KNOWN-OPEN pins (memo, map) verified
STILL PINNED (test/provenance-inference.js green) — Tier 1 doesn't touch
OBJECT-valued edges, confirmed not just assumed. Mechanism: program-facts.js
`.set()` census branch (visit + moduleInit visitInit + moduleInitSlot cache
replay) mirrors observeDictValue's first-wins-then-clash lattice verbatim;
analyze.js local half (mapValueTypeOf) gated on decl vt===VAL.MAP; consumer
is kind.js's mapValueKindOf, consulted directly in VT['()'] ahead of
methodValType (kept out of kind-traits.js's methodValType to avoid a
kind.js↔kind-traits.js import cycle — the design's own offered alternative);
emit.js nullableOperand carries the matching `.get(k)`-call-shape carve-out.
hasMapSet gate added (program-facts.js observeNodeFacts + narrow.js) beside
hasSchemaLiterals — a Map-only moduleInit/program has no `{}` to trip the
existing gate, verified this was a REAL gap via a reduced repro before
landing (not merely theoretical).
Full gates green: 4-group chunked battery (0 fail, matches ~3194/0/6
baseline +10 for the new fixtures), dyn-keys/data/provenance-inference
green, JZ_DEBUG_INVARIANTS=1 leg clean (data/watr/provenance-inference/
dyn-keys), fresh dist rebuild + kernel-parity + kernel-oracle + watr
self-host all green.
Real-corpus verification (direct ctx inspection on an actual watr.js
self-host compile, jz(watrJs, {jzify:true, modules:ENTRY_MODULES})):
F64_MEMO (encode.js:183) resolves mapValueValType=ARRAY — a genuine, sound
Tier-1 win (byte array literal value, independently provable). I32_MEMO
(encode.js:75) resolves NULL (poisoned) — root-caused via isolated repro:
its value is `v = i32.parse(n)`, a CROSS-FUNCTION-CALL-DERIVED value, and
writeVT (program-facts.js) deliberately never resolves through `.`/call
reads mid-census (the SAME limitation the ALREADY-LANDED dict census has —
verified by reproducing the identical poison on a same-shaped `bag[k]=p(n)`
dict fixture). Sound, not a defect; the design's "NUMBER indices" framing
for I32_MEMO was optimistic, not verified — corrected here.
Param-alias `.set()` gap audit (design's Fail-open item, "verify zero
occurrences or bank"): NOT zero — found genuine occurrences in BOTH watr
(optimize.js: `bump`/`reset`/`ensure`/canon-map helpers taking a Map
parameter and calling `.set()` on it) and jz's own self-hosted src/module.
Verified via a targeted repro (`bump(m,k){m.set(...)}` called with a
module-global Map arg) that the gap is SOUND: fails open (fact stays
`undefined`, never a false positive), no crash, functional correctness
unaffected — banked as a known limitation, not fixed (matches dict's own
inherited gap; fixing needs a paramReps-aware receiver gate, a Tier-1.5
follow-up if the win ever proves worth chasing).
Bench measurement: SKIPPED — machine not quiet at landing time (load avg
2.77–3.57, 3 active user sessions) and the design's own prediction
("small-or-nil, memo hits are compile-time-rare") plus the empirical finding
above (only 1 of 2 real watr memo sites actually resolves) make a paired
ABBA run unlikely to produce a trustworthy signal on a loaded machine; not
run rather than reported noisy.

ERROR MODEL: PIECES 1+2 LANDED, PIECE 3 BANKED WITH A PRECISE WALL 2026-08-01
(bfee0e7f distinct codes, 48a361d0 host-side decode; battery 3193/0/6 — +11
pass vs the 3182 ledger baseline, same skip=6, zero unexplained fails,
verified file-by-file across all 88 test files since one monolithic `npm
test` run now exceeds the 600s single-call ceiling on this machine; kernel-
parity 33/33 + kernel-oracle 9/9 on a fresh dist rebuild, selfhost.js 21/21,
JZ_DEBUG_INVARIANTS=1 leg on errors/types/data clean, size spot-check
byte-identical pre/post on 3 error-free bench cases):
PIECE 1 — err-codes.js (new leaf registry, project root — see below) gives
each of the 48 `$__jz_err` runtime throw sites (module/*.js + src/ir.js's
toPrimitiveChain; fs.js's real-errno throws untouched by design) its own
small integer, grouped 1xx TypeError (16)/2xx RangeError (13)/3xx
SyntaxError·URIError (19). Near-zero cost, confirmed byte-identical WAT for
error-free programs.
PIECE 2 — interop.js's decodeThrown resolves a thrown NUMBER matching the
registry to `new Error(name + ': ' + message)`; `wrapped.thrown` keeps the
raw code. PREREQUISITE BUG FOUND AND FIXED (not anticipated by the
investigation, which assumed decodeThrown "already wraps any escaping
throw" correctly): decodeThrown reads its payload from the
`__jz_last_err_bits` global, but only the user-level `throw`/`finally` emit
handlers ever wrote it — none of the 48 stdlib sites (nor fs.js's 5 errno
throws) did, so any of them escaping to the host silently decoded as
stale/zero. Fixed by setting the global immediately before every throw
site, and extending `pruneUnusedThrowRuntime` (src/compile/index.js) to
strip the now-orphaned `global.set` when it lowers an uncatchable throw to
`unreachable` (else a no-try/catch program would reference a deleted
global). Also makes fs.js's real-errno forwarding reach the host correctly
for the FIRST time — a live, previously-undetected gap in a path the
investigation had called already-working.
LOCATION CORRECTION: the investigation's suggested `src/err-codes.js`
location was wrong — interop.js's own pinned leaf-module contract
(test/interop.js "subpath stays compiler-free") allow-lists only
`./wasi.js`/`./layout.js` and separately forbids any `./src/` import
outright. Registry lives at project root (`err-codes.js`, sibling to
layout.js — same dual-consumer role: module/*.js AND interop.js both
import it), and the pin's allowlist was extended by one entry. This is the
literal, load-bearing reason "a new small src/err-codes.js" as suggested
needed correcting, not just following the letter of the suggestion.
PIECE 3 BANKED — WALL FOUND, PRECISE: requirement (c) "instanceof Error
works via the OBJECT ptr tag + schema/class marker (mirror how Date is
handled)" rests on a premise that doesn't hold. `instanceof` is not a
scoped-down or strict-only feature to extend — op-policy.js's REJECT_OPS
rejects it UNCONDITIONALLY, in every mode (`instanceof: 'instanceof not
supported: use typeof'`; the "strict rejects: instanceof" test name in
test/errors.js is misleading — the same reject fires without `strict`
too). There is no existing runtime "is-a" dispatch to mirror: Date's
`ctx.schema.dateSid` (module/date.js "Minimal Date value object") is a
STATIC, compile-time class marker — it lets the compiler pick the right
method-dispatch table at COMPILE time when a binding is proven Date-typed
(VAL.DATE), the same role `Array.isArray` fills via a runtime ptr_type
check for a different question entirely (proven a runtime ptr_type check
answers "is this ARRAY" generically, but nothing today answers "does this
OBJECT's schema/aux match class X" at runtime, catch-block-dynamic-value
style). Implementing `e instanceof Error` for real — even scoped to just
the Error family inside a catch block, where `e`'s static type is
generically unknown — requires: (1) a prepare-stage policy carve-out
(remove/special-case instanceof, currently a hard reject); (2) a NEW
emit.js binary-op handler doing a runtime schema/aux comparison against a
reserved Error-class id (or family of ids, one per subclass, with
TypeError/RangeError/etc. all also instanceof Error — real prototype-chain
semantics, not one flat check); (3) wiring it into whatever dynamic-value
dispatch a caught `e` goes through. This is a new language operator, not a
"wire an existing mechanism" job — genuinely deeper than this session's
scope, exactly the fallback case the mission's own binding rules
anticipated ("if piece 3 hits a wall... bank precisely, report honestly").
The rest of piece 3 (minimal fixed-shape Error OBJECT via the existing
object/schema construction path, .message/.name slots, no-arg fast path,
String(e) convention, the ==/=== sweep of test/errors.js incl. the ~685-693
tripwire) was NOT attempted stand-alone once (c) proved to need a new
operator first — building the object shape without real instanceof would
ship a materially incomplete, misleading version of "Errors become
objects" (instanceof is explicitly one of the model's own requirements,
and the test/errors.js sweep the mission demands is keyed to the FULL
model, not a partial one). NEXT SESSION: scope instanceof as its own
project first (prepare policy + one new emit.js op, Error-family only to
start), THEN piece 3's object-shape work becomes a normal follow-on.

WATR INLINER BUG: GENUINE NON-REPRO, CLAIM DOWNGRADED 2026-08-01
(five escalating attempts, both repos left clean): minimal WAT memo
shapes, an 8-combination control-flow fuzz targeting inlNeedsReset,
jz's real resolveWatrOpts speed profile with dual-block-label
convergence shapes, caps forced open 90→9000 with the exact
bug-report sources, AND the decisive one — at STOCK speed tier
today __dyn_get_t_h's memo cache IS duplicated at 5 sites (the
named mechanism, live) and 40-iteration interleaved hit/miss/
cross-site sequences match native JS exactly. The 2026-07-29
observation was tied to the stratification agent's exact split-core
diff (git-stash-popped, unrecoverable). NO WATR RELEASE (nothing
verified to fix — the user-authorized release stands ready if a
real repro ever lands). CONSEQUENCE: the __dyn_set/__dyn_get_t
STRATIFICATION lever (wordcount write-side Ryu pull, blocked by
this alleged bug + condref shifts) is now a RETRY CANDIDATE — the
named blocker does not reproduce.

BOOL-MERGE IDENTITY LANDED 2026-08-01 (8a0bad4f; battery 3182/0/6,
parity 33/33 byte-identical, oracle 9/9 ALL-AGREE 254 assertions
both legs, selfhost 21/21, dbg leg): the live miscompile family
(inline (s?1:false)===false, typeof merge, &&-merge ===, plus the
pinned ternary-return row) closed via hasAmbiguousBoolMerge (pure
structural predicate) + emitIdentitySafe at six enumerated escape
sites, per the banked design. SELF-HOST NEAR-MISS caught by the
design's kernel gates: scripts/self.js's hooks lacked the new
bridge binding — in-kernel empty-IR crash, native fine; fixed at
ALL SEVEN session entries + made STRUCTURAL (reset() asserts the
full hook set under dbg — the missing-hook class now fails loudly
at session start forever). Two pins graduated as their tripwires
prescribed: booleans &&/|| atom-carry (5&&true → true, JS-exact —
a DOCUMENTED GAP CLOSED) and the oracle ternary row PENDING-FIX→
AGREE. Agent stalled repeatedly on the silent-battery watchdog;
landing finished in-thread (probes, gates, pin rewrites, hook
sweep, invariant).

CORRECTION 2026-08-01 (re-audit #6, carrier-invariant-design.md
session): the entry above OVERSTATED "the live miscompile family" —
it closed the family at six RETURN/IDENTITY-COMPARISON escape sites
only (return tails, typeof, strict-eq). Re-audit #6 found 51 MORE
verified BOOL∪NUMBER mismatches across array/object/Map/Set storage,
keys, JSON, String/template, closure args, computed keys — a SEPARATE
mechanism (container/call-arg PRODUCTION sites hand-reimplementing
only the unsound half of the same guard, 16 raw sites + 3 more found
live) plus an independent detector blind spot (VT['()'] treating a
parenthesized non-call grouping as opaque). THIS SESSION is the
actual closure of the container/call-arg half: storedValue promoted
to src/bridge.js as the one producer chokepoint (was local to
emit-assign.js), all 16+3 raw sites replaced, VT['()']/
hasAmbiguousBoolMerge's grouping blind spot fixed, plus two root-
cause type-inference gaps in narrow.js/type.js that were silently
narrowing an ambiguous-merge function/param to i32 and losing the
atom at the rebox. Oracle rows 1-6+10-11+13 flip PENDING-FIX→AGREE
(commits f6ec5129/c979528f/845128ed). NOT closed by this session,
explicitly banked:
  - the GENERIC SCALAR let/const declaration init site (module-level,
    not flat/SRoA) — every implementation shape tried (shared helper,
    inline ternary, inline if/else materializing the branch first —
    the established self-host-miscompile-avoidance discipline) broke
    the SELF-HOSTED kernel's own compiled emitDecl at that exact call
    site, verified live with a fresh dist rebuild reproducing with a
    plain non-ambiguous `let v = x + 1` local. Native compiled every
    variant correctly; only the kernel's compilation of its OWN
    emitDecl broke, and only there. Root cause not localized further.
    test/kernel-oracle.js's 'captured-then-read' row stays PENDING-FIX.
  - the ARITHMETIC-CONSUMER sweep (design's own COST section, 7 sites:
    emitLooseEq numA/numB, a relational-comparison pair, isNumArm/
    numSide's atom-safety skip, the emit() valKind stamp) — attempted
    and REVERTED: every fix shape that correctly boxes an ambiguous
    merge for arithmetic consumption also adds real f64 ops (an atom-
    safety self-compare ladder) to a mixed number/boolean ternary
    even when it's a fresh, provably-raw computation — directly
    tripping test/wat-invariants.js's PROTECTED hard-zero ratchet
    ("typed-int emits NO f64 op in any loop body", the exact
    regression class its own header already documents fixing once).
    This is a genuine, verified conflict between the arithmetic sweep
    and an existing performance invariant, not a mistaken diagnosis —
    banked rather than force-landed.
  - the FORMATTER sub-sweep (String()/template-literal ToNumber-vs-
    ToString runtime dispatch, computed-key ToPropertyKey) — needs a
    genuine RUNTIME bit-pattern dispatch (compile time cannot know
    which of the two representations an ambiguous merge holds), not
    attempted this session given the time already spent bisecting the
    two self-host/ratchet walls above. Oracle rows 7/8/12 stay
    PENDING-FIX.
  - the QUARANTINED identical-subtree anomaly (design §1a — two
    branches returning literally-identical AST M=((x>0)&&1) both
    return 0 for both arguments, a wrong VALUE not just identity,
    suspected CSE/dedup-on-identical-subtree class) remains STILL
    OPEN — explicitly out of scope per the mission's own binding
    rules, not chased, not touched.
Also found and fixed live during this session, structurally identical
class but NOT in the design's original enumeration: bridge.js's own
`coerce` 'I'-sig helper (every call()/method() stdlib registration,
incl. Set.add), emit.js's generic coerceArg/emitCallArgs direct-call
argument boxing, and emit.js's flat/SRoA object-literal field init.

DECISIONS EXECUTED 2026-08-01 (user: "make most meaningful
decisions and go"): (1) JSC tight-int-loop class → claim SCOPED to
V8-family engines for strict JIT leadership; JSC = documented
exception with the dissection as evidence (M4-scoping precedent);
(2) size claim → reframed "par-or-smaller than AS WITH full JS
semantics" (unchecked tier rejected — against JS-exact philosophy);
(3) memory 3 arena cases → accept+document (goal met 40/43);
(4) Error model → BUILD: minimal Error objects (.message/.name/
instanceof, ~60-100B when constructed) + distinct per-site codes +
host-side code→message table — INCREASES JS fidelity; (5) jessie →
documented red pending refresh (IC hard tail; dispatch-rewrite
banked as research); (6) watr inliner fix → prepare in user's repo
uncommitted, user releases. Push + tinygo CLT remain user-gated.
DECISION (1)'S PROSE CATCHES UP 2026-08-01 (re-audit #6 finding 3):
test/bench-claims.js already encoded the JSC tight-int-loop scoping
(16734349), but AGENTS.md's promise line still read "jz beats V8
(Node), and any other JIT (JSC, SpiderMonkey)" — unscoped. Reworded
to the decided form (V8-family unconditional, bun/JSC scoped with
the documented `vm`/`dict`/`crc32` exception at a 1.5x sanity band).
Audited README.md/bench/README.md for the same unscoped pattern —
none found; every JIT mention there is either a specific, still-valid
V8 claim (V8-family carries no exception) or corpus description, not
a universal promise.

## Status (2026-07-31, prior truth — re-audit #5 reconciled)

MEMBER BIGINT COMPOUND-ASSIGN FIXED 2026-07-31 (the sibling map
banked in the 2026-07-29 entry below, all three items closed):
REPRO ENVELOPE (before fix): `obj.n++`/`arr[0]++`/`++`/`--` on a
proven-BIGINT member silently computed garbage via the generic
float/string-dispatch path (arithmetic on the i64-reinterpreted f64
CARRIER bits as if they were an ordinary Number) whenever the member's
kind could NOT be re-proven post-write; `arr[0]++` specifically threw
a FALSE "Cannot mix BigInt" TypeError instead (its census — unlike
objects' — already proved BIGINT, so prepare's hardcoded NUMBER-
literal `1` tripped bigintMixReject for real). Plain-Number members
were unaffected throughout (confirms the break was BIGINT-specific,
not the desugar mechanism itself). FLAKINESS: NOT reproduced — 40x
identical-source recompiles in one process, 200x interleaved-shape
recompiles (varying object schemas + a plain-Number sibling shape
every other iteration): zero divergence. ctx.js's reset() rebuilds
ctx.schema fresh every beginSession call and resetFactStore() rebuilds
the program-facts store fresh too; both are already complete. Most
likely explanation: the original "flaky" read was this SAME
deterministic bug (root cause 1 below), whose trigger depends on
write SHAPE/ORDER subtleties (self-referential vs not, `+=` token vs
plain `=`) easy to misperceive as nondeterminism across ad hoc runs —
pinned a dedicated repeated-compile regression test anyway (the exact
ledger-named shape, 40x + 20x interleaved) as a standing guard, in
case the reset-soundness ever regresses.
THREE INDEPENDENT ROOTS, each general (not per-shape patches):
(1) program-facts.js's schema `.prop=` kind census (writeVT) had NO
self-read neutrality — only the dict-value census did (isSelfDictRead/
SELF_READ). ANY self-referential compound member write (`o.n = o.n +
1n`, `o.n += 1n`, prepare's `o.n++`/`--` desugar) hard-poisoned the
slot's censused kind via the generic "`.prop` read → null" rule,
permanently destroying the literal's BIGINT fact. FIX: abstain (skip
both observe AND poison) when the write is structurally self-
preserving — isSelfPreservingPropWrite, a small LOCAL duplicate of
analyze-scans.js's flat-object twin (kept separate deliberately: the
two call sites have different target shapes, and duplication beats a
forced shared abstraction here). FIRST ATTEMPT WRONG, CAUGHT BY THE
BATTERY: tried extending writeVT's OWN SELF_READ-collapses-to-sibling
join (the dict-value design) to schema props too — regressed a real
mix-reject (`o.n += 1` on a real BigInt slot stopped throwing,
test/statements.js "should throw" pin caught it) because collapsing a
self-read to the SIBLING operand's kind launders a genuine BigInt vs
Number mismatch into a false NUMBER observation. The dict design's own
rationale ("self-read contributes no NEW info") doesn't transfer: a
dict key has no per-key established kind to preserve, a schema PROP
does (the literal). Abstain, not collapse-to-sibling, is the correct
schema-side operation.
(2) kind.js's flat-object (SRoA) fast path (VT['.']/VT['[]']) answered
"unproven" for ANY written slot unconditionally ("its value may differ
from the literal") — sound in general, wrong for the common self-
preserving case. FIX: analyze-scans.js selfPreservingWrittenKeys
computes, per written key, whether every write is provably self-
preserving (arithmetic op, one operand the self-read, the other a
non-conflicting literal/self-preserving sub-expression); kind.js
consults `flat.selfPreserving` alongside `flat.written`.
(3) prepare's `.`/`[]` ++/-- desugar (index.js) hardcoded a spelled-
out `obj.p = obj.p + 1` with a plain NUMBER-literal `1` — STRUCTURALLY
IDENTICAL to whatever a genuine `obj.p += 1`/`obj.p = obj.p + 1` ALSO
produces (the '+=' handler desugars to the exact same shape at emit
time). bigintMixReject cannot tell "prepare's own correction constant"
apart from "a real Number operand" from shape alone — after fixing
(1)/(2) so the member's kind is provable, a shape-only bypass would
have SILENTLY ACCEPTED genuine `obj.p += 1` BigInt/Number mixes
instead of correctly TypeError-ing (verified: a battery pin literally
caught this exact false-negative before landing). TRIED AND DIED:
tagging the synthesized literal (`Object.assign([, 1], {synthOne:
true})`) — survives at optimize:0, LOST at optimize:1+ (isSynthOneLit
saw `tag=undefined` past the inline/scalarize passes) because
ast.js's cloneNode rebuilds every node via `.map()`, which drops non-
index properties on every clone (inlining clones call-site bodies).
ROOT FIX: two DEDICATED unary AST ops, `'+1'`/`'-1'` ("the operand,
incremented/decremented by one, same kind" — mirrors the bare-name
'++'/'--' unary VT rule already in kind.js), replacing the ambiguous
binary shape for MEMBER targets only. An op string is an indexed
array element, so it survives `.map(cloneNode)` trivially — no tagging
needed, no ambiguity possible (no parser or other pass ever emits
this op). emit.js's new `'+1'`/`'-1'` table entries: BIGINT-proven →
the same i64.const-1 arithmetic the bare-name entries use; anything
else → `emit(['+'|'-', n, [, 1]])`, literally re-invoking the OLD
binary-handler shape, so plain-Number member ++/-- emits BYTE-
IDENTICAL WASM to before this op existed (kernel-parity 33/33 byte-
identical confirms). Ordering matters: `'+1'`/`'-1'` reach the schema/
dict-value census as a NEW shape too (`effectiveWriteValue` doesn't
know them) — extended isSelfPreservingPropWrite/selfPreservingWrittenKeys
(unary case, trivially self-preserving) AND writeVT's dict-value path
(implicit NUMBER-literal-1 operand, mirrors the OLD '+' collapse
exactly — dict values, unlike schema props, WANT the collapse-to-
sibling behavior) — a pre-existing dict-census test
(test/inference.js "self-read neutrality — d[k]++") caught the miss.
SIBLING GAP SURFACED + FIXED: narrowValResults/narrowBoolResults
(src/compile/narrow.js, the function-return-kind pre-pass) run BEFORE
ctx.func.flatObjects is populated for the function under examination —
a bare `return obj.n`/`return o.n++` after a write kept exporting the
wrong (Number) boundary kind even once the VALUE was already correct
(same "phase ran ABOVE per-function state" class as the pre-existing
"ctx.schema.vars populated later than narrowValResults" note,
compile/index.js:1274, but for a DIFFERENT ctx field). FIX: install
that function's own `analyzeBody(body).flatObjects` for the duration
of ITS OWN kind resolution in both passes (safe — body-pure fact, a
simple per-function context-field swap restored via try/finally, not
a whole-program store). Side effect: this ALSO closed a PRE-EXISTING
documented gap for BOOL array elements (test/booleans.js "bare
boolean read from a container" — was pinned as broken, now correct;
updated to assert the real value).
FIXED 2026-08-01 (re-audit #6 finding 2 — was banked here as (a)/(b) below):
a bare `return arr[i]` on a BigInt ARRAY element used to export the wrong
boundary kind — `let a=[1n]; return a[0]` mis-decoded as a raw-bit-
reinterpreted Number with zero writes involved. Took path (b): narrow.js's
new `installArrElemReps` installs the function's own `analyzeBody(body)
.arrElemValTypes` slice onto `ctx.func.localReps` for the duration of
narrowValResults'/narrowBoolResults' own kind resolution, restored via the
same try/finally the ctx.func.flatObjects swap already uses — no whole-
program `updateRep`/`repOf` snapshotting needed after all: the per-function
slice IS the same data updateRep later folds into the whole-program store at
emit time, so installing it transiently is exactly as safe as the
flatObjects precedent it mirrors. Only non-null (elemOrigin-gated,
construction-proven) facts are installed — fail-open, an unproven element
kind never claims BIGINT. Path (a) (flat-SRoA admission for BigInt array
literals) was NOT taken — the general fix per (b) closed the whole class
without needing static.js's staticValue to grow a 'bigint' case. Pinned:
test/kernel-oracle.js (PENDING-FIX flipped to AGREE, both legs, all optimize
levels, small + 2^62-boundary magnitudes), test/statements.js (direct bare-
return pins at 2^62±1, arr[i] no longer needs the `+ 0n` sidestep),
test/types.js (arrayElemValType census pin). Battery 3193/0/6 (chunked,
fresh dist rebuild, kernel-parity 3/3, kernel-oracle 11/11, selfhost.js
21/21, JZ_DEBUG_INVARIANTS=1 on statements/types/data clean).
NOT FIXED, BANKED, for context (same architecture class, confirmed pre-
existing and UNRELATED to compound-assign — this is the ORIGINAL diagnosis,
kept for history): Root was BigInt arrays never qualifying for flat SRoA at
all (static.js's staticValue has no `'bigint'` case, so
`elems.every(e => staticValue(e) !== NO_VALUE)` disqualifies ANY
bigint-element array literal from scanFlatObjects — a separate, real
gap in its own right, still unexplored/unfixed on its own terms) — kind
instead resolves via `rep.arrayElemValType`, populated through
`updateRep`/`repOf`, a WHOLE-PROGRAM fact store, not a simple per-function
context field like `ctx.func.flatObjects`. The ARITHMETIC itself was always
correct (verified via `a[0] + 0n` embedding, which resolves through the
separately-correct emit-time path) — only the JS-boundary DECODE of a bare,
unembedded return was affected.
`>>>` HAD NO BIGINT ARM (separate, smaller item, same ledger request):
ES2020 defines no BigInt::unsignedRightShift — `>>>` on ANY BigInt
operand is unconditionally a TypeError, unlike the other bitwise ops
(which correctly fall to i64.<op>). Was completely ungated: the binary
'>>>' handler had no BigInt check at all (fell into the i32 path,
garbage); the bare-name `'>>>='` compound-assign table entry had its
OWN dedicated i64.shr_u branch (shared with the other bitwise
compounds) that also never checked for this — silently computed
i64.shr_u instead of throwing. Both fixed with an explicit `err(...)`
before either side emits (no side effect ahead of the throw). Member
`'>>>='` needed no separate fix — it desugars to the (now-fixed)
binary '>>>' handler.
PINS: test/statements.js — member BigInt ++/--/postfix-recovery/`+=`/
hand-written `=`+`+` compound-assign at the 2^62±1 boundary (obj AND
arr, host-JS-authority), a plain-Number member ratchet-regression test
(exact values, same shapes), `>>>` BigInt TypeError (binary + member +
bare compound-assign), a repeated-compile stability guard (40x + 20x
interleaved) for the ledger-named flaky shape. test/booleans.js — the
newly-closed bare-boolean-array-read gap, updated from "documented
gap" to asserting the correct value.
GATES: battery 3173/0/6 (+10 vs 3163/0/6 baseline), kernel-parity
33/33 byte-identical (O0/O2/O3 — plain-Number '+1'/'-1' fallback path
confirmed zero-delta), kernel-oracle 9/9 (209 assertions), JZ_DEBUG_
INVARIANTS=1 leg on statements+types+data 911/0, watr 57/57.

ERROR-MESSAGE EVAPORATION INVESTIGATED — PREMISE OVERTURNED
2026-07-31 (read-only, empirical envelope + byte-cost measurement):
"Errors are just their message" is DOCUMENTED DELIBERATE design
(README:230,251; test/errors.js:685-693 pins it as a tripwire "so a
future error-object model surfaces here deliberately") — NOT a bug.
new Error(msg) compiles to msg itself (passthroughError, module/
core.js:1750-1769); there is NO storage and NO slot to unwire — a
.message fix requires upgrading the value to a tagged carrier
(minimal OBJECT shape is the sane route). SIZE PREMISE REFUTED by
measurement: object machinery ~60-100B (same as any object
literal); the 5KB cost people associate with errors is the
orthogonal String()/Ryu pull. REAL GAP FOUND: all 37 $__jz_err
runtime sites throw the SAME sentinel 0 (TypeError/RangeError/
bounds/JSON all indistinguishable; only fs.js forwards real errno)
— the README's "numeric codes" plural OVERCLAIMS; there is no code
table. Host boundary already normalizes any escaping throw into a
real Error (interop.js:709-744 decodeThrown, wrapped.thrown
carries the original). SPLIT: (1) DISTINCT per-site integer codes
= near-zero cost (i32.const N), aligns behavior WITH docs, no
semantics change — LANDABLE, queued for writer lane; (2)
Error-as-minimal-OBJECT (.message/.name/instanceof, ~60-100B when
constructed, no-arg fast path preserved, === semantics change
needs a sweep) = changes DOCUMENTED PINNED semantics — USER
DECISION; (3) runtime-code→message resolution (host-side table in
decodeThrown = zero wasm cost, or opt-in verbose flag) = product
decision, USER-GATED.

WRAPPER-INLINING DECLINED WITH EVIDENCE + JESSIE CHARACTERIZATION
COMPLETE 2026-07-31 (read-only investigation, instrumented scratch
reproduction of the jessie compile): subscript's space$9→space$4→
space chain survives THREE independently-correct gates — (1)
program-facts callSites records only bare-identifier callees
(isFuncRef); property-valued closures (parse.space = fn, captured
via const space = parse.space) never enter sitesByCallee at all;
(2) even if admitted, inline.js:580's loopDepth>=2 cap excludes
space$4 AFTER the base while-loop legitimately fused in — the
correctly-motivated no-nested-loop-compounding guard; (3) watr's
inlineOnce blocked by 3 call refs (2 defensive trampolines),
multi-caller inline capped at 90 nodes vs ~150, inlineWrappers'
shape (pure-conversion spine) doesn't match real ASI logic. HONEST
PAYOFF: only the call/return hop is overhead — the bucket's 13.4%
is mostly real relocatable work; recoverable = low-single-digit %
of parse time, negligible on 1.393x. VERDICT: not worth building
at jz level (callSites blast radius for a single-consumer idiom +
the loop-depth wall); bounded watr-side option banked (generalize
inlineWrappers to single-loop/one-callee/bounded-pre-post, fits
WRAPPER_INLINE_MAX 360) — buildable later, not active. JESSIE IS
NOW FULLY CHARACTERIZED: 1.393x, every engine-side lever exhausted
(dict campaign, value-set resolver, receiver-HASH, array-literal
admission, wrapper inlining) or declined with evidence; residual =
V8-IC/call_indirect hard tail (dispatch-rewrite-class project or
claim scoping — user decision).

VM + DICT DISSECTED: HARD TAILS, ~0% CLOSABLE 2026-07-31 (fresh
paired ABBA both directions, quiet machine; WAT surgery checksum-
held 750010871): both reds are JSC-ONLY — jz beats every V8-based
engine (node 1.3-1.5x ahead) AND every AOT wasm rival (c/rust/go/
zig/AS/MoonBit; dict beats c-wasm and rust-wasm 1.8x on the
identical probe shape). Current gaps: vm ~1.17-1.18x, dict
~1.25-1.27x vs bun/JSC (dict drifted DOWN from the 1.34 snapshot —
general levers since). WAT already optimal: vm's if/else opcode
chain compiles to O(1) br_table, fully inlined, pure i32; dict's
probe chain carries ZERO bounds checks (AND-mask proven), clear
loop auto-SIMD'd. vm's only strippable guard (reg[a] store, a<u4)
surgically measured ~2% noisy AND is semantically load-bearing for
arbitrary bytecode (the 00eabd0f interpreter class; cursor-
versioning can't reach a random-access register index). Liftoff/
tier-up confound ruled out. VERDICT: the JSC tight-integer-loop
class (vm, dict, crc32 per the archived JSC sweep) is a RIVAL
EXECUTION MODEL advantage (adaptive JIT on JS source vs AOT wasm
in V8), not a jz codegen deficiency — no emission lever exists at
the WAT level. USER DECISION SHAPING: "every case faster than ALL
JITs" hits this structural class; options = claim scoping (the M4
machine-scoping precedent) or accepting standing reds on this
class.

ARRAY-ELEM-SCHEMA LEVER TRACED TO ROOT, TARGET NOT CLOSABLE BY ONE ADMISSION
2026-07-31 (infer.js+narrow.js, test/inference.js +3 pins; battery 3163/0/6,
JZ_DEBUG_INVARIANTS leg on inference/objects/dyn-keys clean, kernel-parity
33/33 on fresh dist, kernel-oracle 9/9, selfhost 21/21, watr 35/35): traced
the "JESSIE RE-DISSECTED" entry's named lever (subscript's dispatch-loop
descriptor records never unify into one arrayElemSchema) to its exact broken
link via direct ctx inspection on the compiled jessie bundle (paramReps dump
at narrowSignatures' arr/schema fixpoint). subscript's `register(d) =>
lookup[c] = fn?.ops ? dispatch([d, ...fn.ops], fn.tail) : dispatch([d], fn)`
(parse.js:164-165) builds the ops array via an array-LITERAL constructed and
passed directly as a dispatch() call ARGUMENT (never bound to a local first)
— `inferArrElemSchema` (src/compile/infer.js) only recognized bare names and
call-results as call-site args, never inline array literals, so `dispatch`'s
`ops` param never got an arrayElemSchema fact at all (confirmed: field absent
from paramReps, not even poisoned — BOTTOM forever). FIX LANDED (general,
real, minimal): inferArrElemSchema now resolves an inline array-literal
argument's common element schemaId via `state.callerParamFacts('schemaId')`
(same channel the plain `schemaId` mergeRule already uses), mirroring
analyze.js's own literal-init observation one hop further out across the
call boundary; spread elements poison (fail-closed), matching the existing
`arr.push(...x)` precedent exactly. IMPLEMENTATION HAZARD CAUGHT BY THE
BATTERY: narrow.js's `runArrElemFixpoint` is a SHARED generic runner across
5 fixpoints (arrayElemSchema/Set/ValType/typedCtor/typedLen); naively
overloading its existing 4th positional arg for the new schemaId channel
silently broke `inferTypedCtor`'s own 4th-arg `callerSids` wiring — caught
by test/provenance-inference.js's `paramViaField` pin (a Float64Array-through-
an-object-field case, unrelated to arrays on its face) regressing to dynamic
dispatch. Fixed by threading the new fact through a dedicated 5th positional
arg instead of colliding with the 4th. Lesson: a "shared inferFn dispatch
signature" lattice has per-consumer positional contracts that look
interchangeable but aren't — verify against the FULL battery, not just the
target suite, before trusting a "safe, ignored extra arg" argument. HONEST
RESULT: the admission fires for the achievable case (array literal whose
element is a caller PARAM already schema-known — new positive pin, WAT shows
0 __dyn_get) and correctly stays generic for heterogeneous/spread shapes (2
new negative pins) — but subscript's REAL dispatch() call sites are BOTH the
achievable no-spread form (`dispatch([d], fn)`, first registration per char)
AND the spread form (`dispatch([d, ...fn.ops], fn.tail)`, every subsequent
registration sharing that char) — narrow.js's paramReps lattice merges
ACROSS ALL STATIC call sites of a function (2 here, not once per dynamic
registration), and the hard validating sweep poisons on ANY unresolved site,
so `ops`'s arrayElemSchema is null regardless. The spread's source (`fn.ops`)
is a property read on a closure RETURNED by a prior call to `dispatch`
itself, recovered through the dynamically-indexed global `lookup[c]` — proving
it sound requires whole-program alias tracking over that global (a function's
return value carries an own-property equal to one of its params, tracked
through arbitrary later reads of a global array), a materially larger, new
mechanism that would in practice only ever fire for this one idiom — building
it now would be exactly the forbidden "optimize the input, not the tool"
move. CONFIRMED EMPIRICALLY: compiled jessie bundle WAT is BYTE-IDENTICAL
before/after (85 `__dyn_get` call sites both ways; closure8 — the dispatch
loop, parse.js:144 — keeps all 18 of its own generic dyn-get sites reading
d.op/d.l/d.p/d.map/d.word/d.kw). Paired jessie bench not run — WAT identity
already proves 1.00 ratio, checksum unaffected (compile output unchanged
byte-for-byte for this program). RECOMMENDATION: do not chase the deeper
own-property/global-alias mechanism for this target; the landed admission is
sound, tested, and independently useful (any function receiving a literal
array-of-records call argument now classifies) but jessie's 1.393x gap stays
open — closing dispatch() specifically would need a dispatch-rewrite-class
project (per the prior dissection's own "hard tails" list), not an inference
admission.

JESSIE RE-DISSECTED FRESH 2026-07-31 (profile-driven, no hypothesis
inheritance; V8 --prof sampled ticks symbolized per wasm function +
checksum-held counter surgery, checksum 2418067300 exact):
HEADLINE — the gap is 1.393x MEDIAN (paired ABBA 4 rounds, jz
~2872µs vs v8 ~2068µs), NOT 1.85x; the stale figure is dead (the
dict campaign closed more than its per-slice pairs showed).
RANKED COSTS (share of parse ticks): dispatch closure (closure8,
parse.js:144, fires on 80% of 12,925 Pratt iterations) 29.7%;
space wrappers $4/$9 (comment-skip + block-vs-object disambig +
ASI newline, 3-hop composition over a zero-self-time base loop)
14.3%; step composition 13%; generic __dyn_get*/__hash_get* 5.7%;
__str_* 4.1%; char-scan/expr core ~8.6% (algorithmic parity with
V8). THE CONCRETE GENERAL LEVER: inside dispatch, descriptor
records ({op,l,p,map,word,kw} — monomorphic BY CONSTRUCTION at
every token()/keyword() site) are read via __dyn_get_expr 6,784x/
parse — the ops-array ELEMENT record shape is never unified into a
closed record type. Same inference class as the landed prec fix,
one more receiver shape: monomorphic array-of-records element
classification (arrayElemSchema unification for push-built module-
init record arrays). Honest estimate 5-10% of runtime closable →
~1.25-1.32x. HARD TAILS named: V8 IC on record reads + inlined
monomorphic closures vs call_indirect (structural short of a
dispatch-rewrite project); wrapper-flattening = smaller secondary
lever (2 call boundaries per token). Artifacts: scratchpad/prof/.

RECEIVER-HASH FILL LANDED + MEASURED 2026-07-31 (a6312d3d; full
gates: battery 3156/0/6 incl. dbg leg, kernel-parity 33/33 on fresh
dist, kernel-oracle 9/9, selfhost 21/21, watr 35/35): the design's
fill-never-correct principle held — classifyHashDictGlobals
(plan/scope.js) fills globalValTypes VAL.HASH via the allocator's
exact predicate, .has()-guarded, PLUS a race the design missed and
the implementation caught: materializeAutoBoxSchemas retroactively
binds schemas onto dot-written names — excluded via propMap consult
at fill time. WAT evidence: jessie __dyn_get 22→14 with 6 new
direct __hash_get_local sites; OPCODE classifies HASH; non-
qualifying benches byte-identical; P4 tripwire silent. PAIRED ABBA
(3 rounds jessie, 2 watr, quiet machine, checksums identical):
jessie 0.989 (HEAD ~2002µs vs prefill ~2024µs — real ~1% win, wasm
−300B); watr ~0.95 but noisy spread (honest: no regression, likely
small win, −400B). CONSEQUENCE (the load-dominates hypothesis now
also largely spent): even with prec loads LEAN, jessie's red barely
moves — the remaining 14 __dyn_get calls (lookup[c] closure table —
genuinely polymorphic, correctly not dict-mode) and/or other
machinery carry the hot cost. The dict-mode campaign is
ARCHITECTURE-COMPLETE (census + value-set resolver + moduleInit
coverage + receiver classification, all landed+gated); jessie 1.85x
needs a FRESH PROFILE-DRIVEN dissection next (no more hypothesis
inheritance — measure where time actually goes at current HEAD).

MODULEINIT DICT-CENSUS GAP FIXED 2026-07-31 (.work/dict-census-moduleinit-fix.md
implemented; Fix A 1f4fe762, Fix B a003ecd9; battery 3152/0/6 incl.
JZ_DEBUG_INVARIANTS leg, kernel-parity 33/33, kernel-oracle 9/9, watr
self-host 35/35, each gate re-run at both commits): Fix A unconditionally
merges initFacts.dynWriteVars in collectProgramFacts (program-facts.js,
one line); Fix B adds visitInit's missing MUTATE_OPS/`[]` dict-write branch
(mirrors visit()) and extends the moduleInitSlot memo cache from flat
{gen,obs} to {gen,obs,dictObs}, poison-preserving on cache-hit replay.
CONSUMER IMPACT AUDIT (full dynWriteVars consumer sweep, kind.js/analyze.js/
type.js/emit.js): Fix A's merge is not merely additive — it REPAIRS two
independently-reproduced, previously-live miscompiles for any global that is
BOTH statically-typed (array-elem-kind or object-schema) AND additionally
dynamically written ONLY from a bundled sub-module's moduleInit (`kind.js`'s
global arrayElemValType trust reading a stale elem-kind; `emit.js`'s
unrollForIn silently dropping a dynamically-added key) — neither shape was
covered by the existing suite, both confirmed by direct repro against the
pre-fix tree. REAL TARGET FIRES: compiling watr itself now gives
`__const_js$OPCODE` dictValueValType NUMBER (`__const_js$IMM` stays honestly
poisoned — its value is a computed `.slice()`, unproven by writeVT). jessie's
WAT is byte-identical at O0/O2/O3 pre/post both fixes (prec's dynWriteVars
membership comes from a function-body walk, untouched by either fix) —
confirms field isolation. PAIRED BENCH (bench/bench.mjs watr --targets=jz,
ABBA, git worktree at pre-fix f0d9879e vs current, --paired=4 both sides,
checksums identical both runs): watr self-host compile median 948µs post vs
1091µs pre — a real ~13% win, BEATS the design's own honest "small-or-nil,
load dominates" estimate (the compare-site coercion/dispatch removed around
already-emitted f64.gt turned out non-trivial at this scale). jessie paired
re-check: 2019µs vs 2021µs, noise-level, confirms no interaction.
PRE-EXISTING BUG FOUND AND BANKED, NOT FIXED (out of this task's scope): a
top-level `for...of` loop performing a computed-key dict write (`for (const
k of arr) D[k] = v`), compiled at optimize>=1, traps "memory access out of
bounds" at module instantiation — module/object.js:86's dictionary-mode
`__hash_reuse_eph` alloc (correctly falls through to fresh-alloc for a
non-HASH `old` pointer per its own guard) interacting unsoundly with the
for-of loop's own codegen under the optimizer. REPRODUCED ON THE UNMODIFIED
PRE-FIX-A BASELINE (f0d9879e), single-file AND bundled — fully independent
of this task's changes. CONFIRMED NOT the equivalent C-style `for` loop
(watr's actual const.js:161 shape, and every real target) — safe on both
trees, paired bench and all gates above used it. Fix A does newly make the
bug reachable for the bundled-moduleInit-only shape specifically (previously
accidentally shielded by the very dynWriteVars gap this task closes — not a
real guard). New test/inference.js fixtures (bundled moduleInit NUMBER
resolution, mixed-kind poison, cache-hit-replay-agrees-with-cold-walk) use
C-style for accordingly and document the finding inline. Candidate for a
future standalone bug hunt: bisect module/object.js's dict-mode branch vs.
for-of loop lowering under optimize>=1 to find the actual unsound
transformation (likely in watr's own generic WAT optimizer, which jz uses as
its backend for optimize>=1 — optimize:0/false is unaffected).
Also found: an untracked `.work/dict-receiver-hash-design.md` (receiver-HASH
classification follow-on design) appeared in the tree during this session,
authored by a spawned research subagent exceeding its research-only brief —
not part of this task, left untouched (untracked, not committed) for the
user to keep or discard.

WRITEVT STRENGTHENED + JESSIE COMPARE-SITE HYPOTHESIS REFUTED
2026-07-31 (6c721fba; battery 3149/0/6, parity 33/33 after dist
rebuild, oracle 9/9, dbg leg, selfhost 21/21): compositional
truthy/falsy/nonNullish VALUE-SET semantics for &&/||/?? in writeVT
({kind,bool} elements; BOOL's 2-element domain lets a filter fully
eliminate a `!x` guard through an enclosing ||), self-read
neutrality (SELF_READ join identity, fixed-point soundness comment
banked), param-kind channel (paramVts from paramReps, late
{fresh:true} call only). prec NOW FIRES (m4_parse$prec →
dictValueValType NUMBER); isStmt (asi.js:24-25) and loop-head
(loop.js:26) emit raw f64.le/f64.lt — yet paired ABBA jessie is
1.006 median (NO WIN, checksum identical). THE LOAD DOMINATES:
generic __dyn_get hash+probe per read swamps the post-load compare
saving. CONSEQUENCE: receiver-HASH classification of the LOAD is
now the empirically-proven necessary lever for jessie (and watr's
same-shape reads) — the value-kind half alone is architecture-
complete but perf-inert here. Remaining named site asi.js:74
p>=lvl blocked by two PRE-EXISTING general gaps (VT['[]'] literal-
string-key early-null gate fires before the dict branch for
prec[';']; VT['??'] general table still naive ta===tb join) — out
of census scope, candidates only if receiver-HASH design needs
them. MODULEINIT GAP DIAGNOSED (.work/dict-census-moduleinit-fix.md
— read before implementing): the dynWriteVars exclusion is an
OVERSIGHT not a guard (git archaeology: ffda6f86 touched 3 of 4
merge sites; c37111ee extended the block and missed it again), AND
a second independent gap — observeProgramSlots' visitInit walker
has no dict-write branch at all. Fix A (unconditional initFacts.
dynWriteVars merge — NOT gated on anyDyn, `OPCODE[nm]++` sets one
without the other) + Fix B (visitInit branch + moduleInitSlot cache
extended to {gen,obs,dictObs}). Ordering proven sound (single
atomic publication at plan/index.js:118, all consumers downstream —
structurally NOT the reverted-attempt class). Honest estimate:
OPCODE compare sites get f64.gt, IMM (STRING values) gets nothing,
load still dominates — closes the census coverage hole, won't close
watr 1.2-1.4x alone.

DICT-VALUE CENSUS IMPLEMENTED 2026-07-31 (commits a1345879 local
half, ea9ae8dc global census, 2b62b91b consumer wiring — all three
gates green: full battery 3145/0/6, JZ_DEBUG_INVARIANTS leg,
kernel-parity 33/33, kernel-oracle, watr self-host 35/35,
dyn-keys.js+data.js, each step run on the clean commit). Mechanism
built exactly per design, wall avoided structurally (verified: no
val/schemaId/globalValTypes mutation anywhere in the three diffs).
Soundness carve-out required touching emit.js's `nullableOperand`
too (not just kind.js — the design said "reuse that mechanism",
which lives there): without it `OPCODE[nm] === undefined` on a
proven-NUMBER dict const-folds to always-false for an unregistered
key, a real miscompile — proven by reverting the arm and watching
the new inference.js test fail. HONEST RESULT, empirically measured
(not predicted): NEITHER named real target actually fires.
(1) watr's OPCODE/IMM write (`OPCODE[nm] = code++`, const.js:161-
168) is a BARE TOP-LEVEL statement in a bundled sub-module —
exactly the pre-flagged blind spot (design §1c/§6: bundled
sub-module inits live in ctx.module.moduleInits, outside `ast`;
collectProgramFacts merges initFacts.dynVars but NEVER
initFacts.dynWriteVars, program-facts.js:313-366 — confirmed by
direct ctx inspection: `__const_js$OPCODE` has no globalRep at all,
dynWriteVars doesn't contain it). (2) subscript's real prec write
(`prec[op] = !lookup[c] && prec[op] || p`, parse.js:86) DOES reach
dynWriteVars (writes live inside the `token`/`keyword` functions,
not bare top-level) but the VALUE expression poisons: writeVT can't
resolve the bare param `p` (no ambient param-kind info flows into
analyzeBody's context-pure overlay), and `&&`/`||` require BOTH
arms to agree to survive — confirmed via direct ctx inspection:
`m4_parse$prec` gets `{dictValueValType: null}`. RESULT: watr and
jessie WAT are BYTE-IDENTICAL pre- vs post-change at O0/O2/O3 (git
worktree diff, both full self-hosted compiles). Paired jessie bench
(ABBA, 2 rounds each via bench/bench.mjs jessie --targets=jz):
1.87ms/1.87ms post vs 1.89ms/1.92ms pre — within noise, wasm size
identical (76.8 kB) both sides, consistent with byte-identical WAT.
The 31% jessie figure and the watr "real candidate" framing (design
§0.3) do NOT transfer to a measurable win under this design as
built — both require the SEPARATE receiver-HASH half (design §4's
noted future work) or a param-kind-aware writeVT extension to
resolve a bare parameter's value, neither of which this design
scoped. Mechanism stays landed (additive, zero regression risk,
sound carve-out, real fixtures proving it fires for the
independently-resolvable shape — a literal counter or constant) but
delivers no measured win on either named target as of this pass.

DICT-VALUE CENSUS DESIGNED 2026-07-31 (.work/dict-value-census-
design.md — read it before implementing; implementation order+gates
inside): value-kind fact (`dictValueValType`) as a wholly ADDITIVE
ValueRep field, censused inside observeProgramSlots' existing
two-call schedule (same lattice as observeSlot, same writeVT/
effectiveWriteValue resolvers), consumed ONLY at kind.js VT['[]']/
VT['.'] gated on dynWriteVars at READ time (never census time —
that ordering was the reverted fix's trap). Wall avoided
STRUCTURALLY, per link: no val/schemaId mutation → analyzeBody
caches untouched; consulted outside lookupValType → overlay can't
shadow; HASH not in UNBOXABLE_KINDS → schema-id channel unreachable.
GROUNDING CORRECTIONS from the design pass: (a) prec is missing TWO
facts (receiver HASH + value NUMBER) — this delivers value-kind
only, receiver-HASH is a separate future design under the same
field-isolation discipline; (b) bench/vm and bench/dict DO NOT
exercise this lever (both pure Int32Array kernels — the earlier
"likely underlies watr/vm/dict" was wrong for vm/dict, their reds
have another cause); (c) watr OPCODE/IMM IS a genuine match
(const.js:161,168, integer counters read hot in optimize.js);
(d) the archived 31% jessie figure measured a DIFFERENT mechanism
(durable-receiver probe doubling) — re-measure after landing, don't
carry it forward. Order: local half → global census → consumer
wiring (dyn-keys/data pin suites are the risk gate) → watr 35/35
in isolation BEFORE jessie → paired-truth re-measurement.

JESSIE DISSECTED 2026-07-31 (1.85x geomean confirmed, no drift; two
blueprint-tier levers, honestly not forced): (1) DOMINANT ~31%
(causally measured, archive:3479): subscript's `prec = {}` string->
number dict never resolves value-type NUMBER -- ASI's p>=lvl,
isStmt, loop-head compares all emit generic-value machinery (CLI's
own deopt-generic warning fires; 61.5% of module lines touch
generic helpers). SAME CLASS as the reverted global dict-mode
classification (recordGlobalRep can't see plan-time dynWriteVars;
broke watr self-host 30/35) -- needs the PIPELINE-ORDERING rework,
not scope-narrowing; likely also underlies watr/vm/dict JIT rows
(all dict-read-heavy). (2) closure-table lattice on lookup: FOUR
coupled blockers live-traced (digit-loop poison [capture-free
carve-out would be sound], ternary-of-CALLS write shape [needs
proveClosureFactory AST reuse], .ops/.tail chain-read idiom, and
the guarded alias). DESIGN GEM BANKED: `(fn=tbl[i]) && fn(args)`
alias-confinement is PROVABLY SOUND to admit (fresh local, single
use as immediate callee, no escape by construction) -- structurally
distinct from the rejected general bare-read. Identity-devirt
verified CORRECT to bail (lookup genuinely polymorphic). Token/
bounds levers ruled out (prior counter-verification). Minor: the
1.85x stays red pending the dict-mode rework.
RECEIVER-INFERENCE STRENGTHENED 2026-07-31 (the 9f46d517 follow-up;
inventory-first, honest scope): GUARD LANDSCAPE PROVEN NEAR-OPTIMAL
-- ratchet corpora are single EXPORTED fns with zero call sites =
unreachable by ANY receiver-proof lattice by construction (their
simple buf[i] shapes already guard-free via unswitchTypedParamLoop;
compound-index residual = loop-unswitch generality, declined per
the LoopPlan-terminal precedent); real bench: 12 guard sites in 57
cases, ALL the purpose-built Map-provenance class (test/provenance-
inference.js fences memo/map edges as deliberately open). REAL GAP
FIXED: ARRAY+TYPED caller mix spuriously poisoned under val's
exact-equality meet though __typed_idx dispatches both internally
-- new class-level recvArrTyped rep fact (reps/narrow/index thread,
mirrors hardParamVal timing), array.js guard sites short-circuit to
bare __typed_idx when it holds; both directions pinned. NAMED NEW
LATTICE DIMENSION (not forced): Map-value-kind census (Map.get/set
provenance) -- would close fftplan/provenance's 12 sites. Gates:
battery 3139/0 (+2), parity 33/33, oracle 9/9, kernel leg 2447/0,
ratchet +0, dbg green, watr 35/35.
EVIDENCE REFRESHED AT SETTLED HEAD 2026-07-31 (attempt 3, committed
WITH paired-verification protocol -- load 4.2 during run, dataset is
CONSERVATIVELY pessimistic, bias runs against our claims so it beats
both stale and discarded): headline JZ 1.00x, C 1.92x Rust 2.02x AS
2.11x Zig 2.17x V8 2.22x MoonBit 4.20x behind, native C 1.01x.
CAPTURED: dispatch strict JIT win (gone from all red lists), trace
1.462 EXACT match to paired truth (calibration signal), wordcount/
size wave. PAIRED-TRUTH ANNOTATIONS for the pessimistic rows (the
gate reads committed evidence; these reds are load-inflated and
self-correct next refresh): lz committed 1.130 / paired 1.033 BAND;
bezfit 1.062 / paired 1.004 ~LED; slices 1.058 / paired 1.041-1.043
BAND; watr-vs-v8 1.426 / paired 1.195 (real red, milder); glyfparse
1.214 = the ledgered JITTERY lane (per-round spread 0.90-1.32,
mechanism in WASM_TODO). Honest red list after annotation: sdf,
trace, shapes, glyfparse-jitter + watr/jessie/dict/crc32/colorpq/
resample/vm JIT rows. tinygo still 0/60 (CLT user-gated).
MIXED BOOL|NUMBER RETURNS FIXED 2026-07-31 (audit-#5 #2, the LAST
semantic item -- ALL THREE MISCOMPILES NOW CLOSED): return-site
boxing via carrierF64 gated on ctx.func.mixedAtomReturn = valResult
!== VAL.BOOL AND >=2 syntactic returns. The >=2 guard is the load-
bearing refinement over the reverted 190-failure broad fix AND over
the first draft (9 regressions measured: single-return BOOL helpers
whose kind resolves LATER than narrowValResults -- Set.has/Map.get
schema-dependent -- have no unbox wrapper; requiring a genuine
syntactic join restricts boxing to exactly the boolconst shape;
refined gate = 0 regressions, ratchet all +0 = uniform-NUMBER
functions byte-identical). SYMMETRIC boundary fix: interop i64Arg
boxes raw JS booleans into i64-carrier slots (f(true) lost identity
via f64ToI64(Number(true)) before jz ran). GENERALITY PROVEN:
typedarray isConst REVERTED to its natural number-or-false shape --
the compiler self-compiles correctly through the exact class; dist
rebuilt twice, both green. Oracle boolconst -> AGREE tier (209
assertions); ternary s?1:false arm pinned PENDING-FIX (different
mechanism: '?:' keeps BOOL∪NUMBER arms raw for arithmetic
correctness; needs consumer-context threading -- documented, not
forced). null/undefined-mixed already correct (atoms have no raw
form). Gates: battery 3137/0, dbg 3137/0, kernel leg 2447/0,
parity 33/33, oracle 9/9, ratchet 10/10 +0.
NUMERIC-KEY UNKNOWN-RECEIVER SOUND 2026-07-31 (audit-#5 #1 CLOSED):
receiver-kind guard replaces the unsound array-only fast path --
one tag test (ptrTypeEq ARRAY||TYPED, ~2 i32 ops after hoistPtrType
CSE) gates __typed_idx (reusing the SAME i32-narrowed vi -- the
load-bearing detail; a fresh f64 re-derivation violated i32 pins
and bloated hot loops) vs __dyn_get_expr ToPropertyKey. Pin FLIPPED
to JS truth (o[n] reads 9); perf pin rewritten to assert the honest
guard shape. SIBLINGS already sound (write/in/delete verified).
Receiver inference strengthened: X.from -> VAL.TYPED (kind-traits).
REAL BUG caught en route by the fuzz gate: unswitchTypedParamLoop's
cloneRead guard-collapse deleted a hoistPtrType-shared tee's
defining occurrence -> second read fell into the dead dyn arm;
fixed by hoisting the condition as a deduplicated dropped stmt.
RATCHET RE-BASELINED with open eyes: buf/nest/slice/ring/condref/
fgather +8..127% STATIC loop-body ops (each formerly-unsound site
now carries guard + cold-arm code; runtime = 2-op guard, cold arm
never executes for real arrays; synthetic corpora are unproven-
receiver-dense by design; real bench sizes spot-checked sane).
NAMED FOLLOW-UP: strengthen receiver inference (param receiver
lattice) so unknown receivers become RARE, shrinking the static
cost back -- the guard is the sound fallback, not the common path.
Gates: battery 3131/0, parity 33/33, kernel leg 2447/0, ratchet
10/10 re-baselined, dbg green, watr 35/35.
LOOPPLAN UNIFICATION TERMINAL 2026-07-31 (the designed do-not-force
verdict, full catalog banked): the incremental trio's shared-walk
design was attempted and correctly REFUSED -- tryVectorize (full
recursive stmt walk + lane inference + AoS idxTees + mirror stores
+ standalone-tee admission), tryReduceVectorize (single-expression
walk, stores forbidden, ALL tees rejected -- opposite policy, own
widenF32 rule), tryMemCopyFill (no walk: two static laneAddr calls,
REJECTS viaLocal, requires bare-i32 base, never registers teeName)
differ on EVERY axis; a shared scanAddresses needs 8-10 knobs to
save <20 thin lines because matchLaneAddr/_offsetLocalStride/
offsetTees ALREADY did the real unification (slices 1-6). The 3-line
post-scan gate stays per-recognizer (its argument differences ARE
the differing soundness conditions). LoopPlan's honest terminal
state: scaffolds unified (15/16 on the dispatch plan), fact classes
hoisted, remainder justified-private WITH catalog. The from-scratch
affine/alias/dependence vision remains a REDESIGN project, not an
incremental path -- recorded as such, not as debt.
MODULE-SCOPE PER-ITERATION CLOSURES FIXED 2026-07-31 (audit-#5 #3;
unification, not a parallel copy): module top-level compiles via
buildStartFn, and depth-0 loop-body lets were GLOBALIZED (depth
tracks only fn nesting) -- closures emitted global.get = last
iteration's value. FIX: collectLoopDeclNames+bodyCapturesName mark
captured loop-body names (for/while, post-desugar funnel); marked
names skip declareGlobal and mint as REAL locals via the standard
mintLocal path -- the EXISTING emitLoopFreshBoxed/emitDecl per-
iteration machinery then engages untouched; buildStartFn boxes only
the mutated-after-capture subset (scoped findMutations, not blanket
-- false-positive boxing would silently skip a global.set, verified
concretely). Pay-per-capture: uncaptured loop vars stay globals
(pinned). SWEEP: for-of/for-let/mutated/nested x2/for-in/while ALL
JS-truth green; the banked P0-2 closure-in-loop class CURED module-
scope (1005 exact); test262 rows orthogonal (wrapped depth!=0, fix
gated depth===0). Byte-identity: 8 non-capturing programs identical
vs clean-HEAD worktree; kernel self-host surface ZERO (95-file graph
grepped: no module-scope loop captures). Gates run TWICE (isolated
worktree + settled shared tree): battery 3131/0, parity 33/33,
kernel leg 2447/0, ratchet +0, dbg green, watr 35/35.

CLOSED since #4: kernel ToIntN rows FIXED -> KERNEL LEG ZERO FAILS
(6d293644, first ever; capture class swept 2047ce75, parity corpus
33/33); dyn-prop keying both roots (87511c69); README self-host
limitation note LANDED (cf668352); O0 lattice pins tier-guarded then
RE-guarded per audit #5 (value asserts now run at EVERY tier, guard
only skips WAT-shape asserts); GOALS: memory MET at HEAD (jz leaner
than MoonBit 40/43, .work/memcheck-results.csv), size band = honest
JS-semantics floor (AS ports unchecked() everywhere, proven),
dispatch double win + wordcount Ryu elision in tree. OPEN (audit #5
order): 1 numeric-key-on-unknown-receiver UNSOUND fast path (agent:
receiver pointer-kind guard, flip the wrong-result pin to JS truth),
2 mixed BOOL|NUMBER return representation (needs DESIGN -- prior
broad fix broke 190+ kernel rows; represented join or escape-boxing,
not sentinels), 3 module-scope per-iteration closure capture (agent:
unify with the function-scope mechanism; audit repro 22-should-be-
12), 4 value-oracle rows for parity corpus (byte-identity of
identically-wrong output proved nothing -- boolconst taught that;
add JS-oracle + kernel-output EXECUTION rows), 5 evidence refresh
AFTER semantics settle (+ tinygo CLT), 6 solver consolidation /
LoopPlan / CompileSession vision. IN FLIGHT: examples jz-vs-JS
speed gate (user prod report; deploy staleness ruled out -- pages
current at HEAD, speed-tier builds confirmed). Perf truth: committed
evidence stale by design until item 5; verified pairs: dispatch
strict JIT win, lz band 1.036, synth 0.975 leads, trace 1.462.

## Status (2026-07-30, superseded — re-audit #4 reconciled)

CLOSED since #3: typed-array WIP LANDED (b1176b4a — clean-HEAD simd
158/158); bench producer integration COMPLETE (watr meta, porf-native
42 rows, 70% coverage floor, JIT claim gated, strict/band split);
TargetProfile CLOSED for JS/WASI (zero raw host checks; legalization
real); solver-owned invalidation LANDED (2 justified bespoke calls
remain); warm cap ATTAINED (audit-confirmed 0.969-0.990 clean); w2c
bands GREEN (geomean 1.283, worst 3.395 vs 1.35/3.5 caps); boxed-
bigint PARKED by user decision (revisit map banked); GOALS WAVE:
closure-table lattices (dispatch 10.7x->1.10x size AND 1.32x AHEAD
of JSC), template-Ryu fix, cross-call elem lattice (wordcount
5.61->4.63x), O0 pins tier-guarded. OPEN (audit #4 order): 1 kernel
ToIntN value bugs (2 rows: cross-kind copy + .map integer stores —
kernel-compiled programs WRONG, hunt next), 2 [DONE in-thread: O0
lattice pins belowOpt-guarded + comment fixed], 3 evidence refresh
at settled HEAD + tinygo (CLT user-gated), 4 [DONE: WASM_TODO
sdf/trace/lz entries added, this header], 5 self-host carrier
limitation -> precise public docs (README note pending), 6 fold
closure-table facts into the common solver (medium-term; dyn-
closure-tables.js 613 lines = a parallel lattice), 7 canonical
LoopPlan + isolated CompileSession (long-term vision). IN FLIGHT:
dyn-prop keying miscompile family (2 value-wrong-at-HEAD repros).
Perf truth (f1e877b8): wasm 31 strict / 15 band / 4 red (sdf 1.280,
trace 1.445, lz 1.107, shapes 1.120); JIT 13 unled / 10 red (jessie
1.935 worst real; dispatch FIXED post-evidence); porf-native trails
16.36x geomean.

## Status (2026-07-28, superseded — re-audit #3 reconciled)

CLOSED: kernel byte-parity (PARITY_TODO empty, O0/O2/O3 identical); front
half unified (src/front.js); claims gate landed + hardened (fresh incl.
manifests/layout + watr cross-check, strict-leadership separate from band,
CI job; red by design pending evidence); WARM MARGIN ATTAINED 07ffc292
(inlinePtrOffsetFast: warm 0.93-0.97x vs 0.99 cap, audit-confirmed 0.927x
clean; fresh 0.73); TargetProfile landed (frozen JS/WASI profiles,
wasi leg 40/40 — legalizeForTarget still identity, native/w2c profile
absent); pass registry single-authority (63 passes/22 keys/7 hot);
exclusions burn-down (28 -> 22; errors/parser-bugs/destruct/closures/json/
inference back in); solver convergence throws mandatory; session factStore.
OPEN (re-audit #3 order): 1 land user typedarray WIP -> clean npm test at
HEAD (clean-HEAD simd 157/1 f32->i16 — the ONLY battery red; my dirty-tree
counts masked it, see LESSON below), 2 bench producer/claims integration
(committed bench.mjs lacks meta.versions.watr + porf-native lane — user's
uncommitted bench WIP likely carries both; coverage floor ">=5 rows" too
weak -> eligible-count semantics), 3 reference refresh at HEAD (snapshot
44cad082 now 7+ codegen commits stale; tinygo 0 rows CLT-gated, porf-native
0 rows), 4 boxed-bigint (design banked; -5e-324/2^52-1n kernel rows remain
curated until PTR.BIGINT), 5 JIT-leadership axis ungated in bench-claims
(19 JIT losses / 9 cases in snapshot), 6 real legalizeForTarget + native
TargetProfile [6a DONE 32306df8; w2c cap RESOLVED-GREEN 2026-07-28: the
audit's tokenizer 3.851x/geomean 1.330x were the PRE-refresh snapshot's
contention noise -- c703f63a evidence has tokenizer 2.100x, geomean 1.147x,
worst immutable 2.49x, all inside caps; residual tokenizer gap diagnosed =
TurboFan branch-to-cmov vs clang -O3 on identical sequences, not a jz shape;
guard-page memcheck already free, SIMD/call/flag levers all measured null],
7 solver-owned bodyFacts invalidation (DONE 4b149108), 8 canonical
LoopPlan (vectorize 6845 lines, 16-recognizer chain; no shared affine/
alias/dependence model). Perf snapshot (M4, stale): 31 strict / 15 band /
4 red (glyfparse 1.151, sdf 1.256, trace 1.452, shapes 1.166).

