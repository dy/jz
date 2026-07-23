# jz — TODO

Full working history (hunts, refutations, landing paths, process lessons)
archived in .work/archive-todo-2026-07.md — grep it before re-deriving
anything; every kernel bug class and perf frontier has a banked dissection.

## Status (2026-07-23)

STATUS (re-audit v3 corrected): plan stages 0-5 SUBSTANTIALLY advanced but
NOT complete — open: unified solver (stage 2), LoopPlan (stage 3),
CompileSession/TargetProfile (stage 4), claims enforcement + bench refresh
(stage 5), kernel parity long-tail. Perf: V1 bench wins measured locally
(aggregate jz 1.00× leads every WASM lane: C 1.88× / Rust 1.97× / AS 2.06× /
V8 2.17×; native C 1.11×; strbuild/lz/immutable/glyfparse won). Re-audit
items landed: shared final-optimizer tail (watr-tail.js) + kernel byte-parity
leg · six named O0 flags killing bare optimize-object gates (+ latent
lean-hash O0 fix) · solver caller-ctx copies + throwing convergence caps ·
PR #108 incorporated (snprintf clamp + ASan bench-c leg) · kernel modules-ABI
(finally-scoping fix) · SSO/JSON cluster (reassigned-param val poisoning;
objects/strings/spread cleared from KERNEL_EXCLUDE) · subscript
template-escape fix (local commit) · JSON.parse(undefined) SyntaxError ·
MUTATE_OPS dedup (3 drifted sets fixed) · dyn-keys leg registered.

## Open

* [x] watr 5.7.11 PUBLISHED (user, 2026-07-23); jz dep bumped+locked,
      determinism 5/5 against the LOCKED package (no sibling symlink) —
      audit P0 CLOSED. Battery 3066/0 on published watr.
      Unblocks determinism-from-lockfile (audit P0) + CI determinism leg.
      CONFIRMED on CI @HEAD: test workflow fails ONLY 'determinism:
      warm-process recompile' x2 (published watr lacks the reset); watr
      workflow GREEN. Still to triage: selfhost/bench/test262/pages reds
      (test262 likely pre-existing curated-set drift). selfhost red = warm
      perf gate 1.041x vs 0.99 cap — CI builds the kernel with PUBLISHED
      watr@5.7.10, missing the local watr optimizer work the 0.949x baseline
      was measured with — same watr-publish root as determinism.
* [ ] Bench refresh at HEAD → commit results.json + re-check claims gates
      (was 50 commits stale with 7 red rows predating the perf wave).
* [ ] Kernel long-tail (each characterized in the archive):
  * shaped-parser: LOCALIZED (BC14 + host-side pass bisect): the throw is
    a jz-RUNTIME error code (raw 0) firing inside WATR-IN-KERNEL during
    watOptimize, and needs stripmut+globals BOTH enabled (disabling either
    rescues; all-off ok) — a jz miscompile of the stripmut→globals const-
    fold interaction executing in-kernel. NARROWED FURTHER: native watr on
    the KERNEL'S OWN pre-watr tree is fine (pure execution miscompile);
    only the shape module trips pair-only (sum/math/str/constg clean);
    the trigger global is __schema_tbl (the module's ONLY never-written
    global — stripmut immutabilizes it, globals' pricing then clones its
    read anchors and runs watr fold() on them IN-KERNEL; suspect fold's
    i64/BigInt arithmetic hitting the kernel bigint carrier gap — would
    UNIFY this with the bigint-kernel family). NEXT: extract __schema_tbl
    read anchors: i64.load/store over __schema_tbl addr math (2 sites).
    HARNESS REFUTATION (2026-07-23): a jz-compiled watr micro-kernel
    (.work/watr-harness-entry.js graph, compiled at BOTH level:2 AND the
    kernel's exact speed profile) runs pair-only on the SAME 84KB WAT
    CLEAN — the miscompile does not reproduce outside the full kernel.
    Conclusion: context-dependent (arena state/layout at 12MB bundle
    scale, or warm-instance memory pressure when watOptimize runs after
    compileAst in the same instance) — NOT input shape, NOT pass logic,
    NOT tier alone. Costliest hunt class; deprioritized behind concrete
    wins. Probes: scratchpad/{wbisect3,wpair,wnative,wglob2,wanchor,
    watr-harness.mjs,wrun}.mjs + .work/watr-harness-entry.js.
    RELATED NATIVE FINDINGS: Error.message unwired (String(e) works,
    e.message undefined even unthrown); jz runtime errors throw raw numeric
    codes (JSON.parse('nope') throws number) — the message-evaporation
    mechanism.
  * bigint family (statements 2 + data 1): both-bigint bitwise ops falsely
    mix-rejected in-kernel (subnormal-carrier typeof heuristic).
  * speculate CLEARED 2026-07-23 (narrowed-param versioning-guard fix:
    len64Of box-decoded the raw i32 offset of a TYPED-narrowed receiver —
    native+kernel OOB; now uses the offset directly; kernel leg 6/0,
    KERNEL_EXCLUDE shrunk). preeval 2 (rational carry) ·
    pow-fold 3 / fifthroot 2 (memory OOB) · async 1 (wasi-warning channel).
  * kernel-parity TODO rows (dict|2, dict|3, sum|3, arr|3): in-kernel
    vectorizer/unroller bails where native fires (O3 output smaller).
  * test:self WARM PERF REGRESSION CONFIRMED REAL (2026-07-23): sequential
    3-round verdict landed (strict cap 0.99 unchanged; fail only when ALL
    rounds exceed — kills boundary flakiness) and under it the gate fails
    consistently: 1.035/1.046/1.007 (best per-case mat4 0.98, fft 1.01,
    biquad 1.01, sort 1.02, crc32 1.00, mandelbrot 1.01) vs the 0.94-0.98
    baseline. Margin loss accumulated over today's waves (kernel source
    grew: declared-guard Set ops in hot analyze walks, MUTATE_OPS spreads,
    watr-tail — each small, sum visible). RECOVERED 2026-07-23: root was the
    named-flag conversion itself — 19 hot per-node `cfg?.flag` PROPERTY
    PROBES on the spread-built ~84-key resolved cfg (slot-cheap on V8,
    HASH-priced in-kernel; the asymmetry moved the ratio). FIX: OPTF/
    optFlagsOf (ctx.js, cycle-free) — hot flags flattened to ONE i32
    bitmask on ctx.transform.optFlags at setup; sites mask-test a fixed
    slot. Warm gate 0.966x first round (from 1.007-1.046 all-rounds);
    fresh 0.768x. Battery 3069/0.
* [ ] Audit big-ticket (5–6): canonical LoopPlan (vectorizer consumes
      loop-model.js; 16 first-match recognizers → class dispatch);
      CompileSession + TargetProfile (59 ctx importers).
* [ ] V2-class perf tails: qoi (LLVM branch sched), shapes record layout
      byte-stride follow-up, sdf research-tier, ulam/raymarcher parity noise.


TYPED-INDEX KERNEL MISCOMPILE FIXED (2026-07-23): `t[p[i]]` (typed read
indexed by typed read) loaded with the INNER array's opcode in-kernel
(f64 array read as i32.load+convert → garbage) — the deferred `loadOf`
closure re-read captured `r` AFTER the nested `idx(i)` emit (the
closure-capture-after-nested-emit self-host class). FIX: eager load-IR
construction before the index emission (byte-neutral natively) in all
three unproven '.typed:[]' forms. Kernel probes green (7/28); native
357 green. Store path (elemStoreIR after emit(val)) shares the exposure —
NOT yet hardened (no observed failure; watch class).

NEW NATIVE BUG (first-order, untested shape, 2026-07-23): module-global
typed array passed AS PARAM to a storing callee TRAPS OOB NATIVELY:
`const out = new Float64Array(64); const k = (o,n) => {o[i]=i...};
k(out,n)` — $k's checked-store BOUND decodes the already-ptr-NARROWED i32
param as an f64 NaN-box (`i64.reinterpret_f64 (f64.convert_i32_s $o)`) →
garbage address. Native AND kernel identically (bytes equal). The
speculate kernel-leg red (PLAN_SRC) is THIS class (its `out` global via
param), NOT a kernel divergence. Repro: scratchpad/spec7-10.mjs. MECHANISM REFINED: the guard's LEN path re-emits the receiver
(second emit(arr) inside lenIR/typedBase) and that second emission
returns the narrowed i32 offset NUMERICALLY coerced to f64
(f64.convert_i32_s) — typedBase then takes its box-decode arm on a
plain number → garbage base. First emission (store address) is correct.
FIX: make the second emission preserve ptrKind (or reuse the first
emission's local) so typedBase takes the direct arm; grep every
typedBase(emit(arr)) / __len-on-narrowed site for the same
double-emit pattern.

AUDIT-v3 QUICK WINS LANDED THIS WAVE: resetNameUids now a REQUIRED named
import (5.7.11 locked — capability regression fails loudly); typed-ctor
16-round fixpoint (narrow.js) errs under invariants on exhaustion;
kernel-parity divergences represented as REAL test.todo entries +
tripwires (not passes mistakable for parity).

TEST262 GATE — 14 IN-SCOPE FAILURES (2026-07-23, pre-existing; the workflow
red persists after the unexpected-pass prune; local run confirms exit-fail
with 'a miscompile. Pass-count gating alone would miss this'):
  async-gen dstr dflt-ary-ptrn-elision-step-err x3 (expr/named/stmt) ·
  comma S11.14_A2.1_T2 (ReferenceError not thrown) ·
  instanceof S11.8.6_A2.1_T1 (({}) instanceof Object) ·
  yield formal-parameters-after-reassignment-strict (memory OOB!) —
    PARTIALLY FIXED: generators/async/async* now share lowerArguments
    (jzify/transform.js argsLowered at 7 sites, gated on usesArguments —
    ungated broke async+2600 test262: functionBodyBlock rewrap disturbs
    unrelated bodies). Simple nested repro passes; MINIMAL REPRO (y262k.mjs): inside
    `export let _run = () => {...}` with a fn-prop assert harness:
    `function* g(a,b,c,d){ arguments[0]=32; ...; yield a; yield b }
     var iter = g(23,45,33); var result; result = iter.next()` → OOB.
    Necessary elements: UNSPECIFIED 4th param (3 args to 4 params) AND
    var-result reassignment (chained iter.next().value passes; 2-param
    passes). ROOT FIXED 2026-07-23: usesArguments/
    renameArguments stopped at 'function' but walked THROUGH 'function*' —
    the OUTER function got the rest-param lowering and the generator's
    arguments aliased the outer empty rest array (visible in transform
    output: generator body wrote arg0 = _run's own rest param). Boundary
    now includes function*. test262 14→13; pinned in test/generators.js. ·
  switch-case/dflt-decl-onlystrict x2 (undefined) ·
  break/continue line-terminators x2 (CR between keyword and label) ·
  for-in scope-body-lex-close/open/var-none x3 — TRIAGED 2026-07-23:
    destructured `let [x, _ = fn-default]` for-in HEADS with escaping
    closures capturing the per-iteration binding; deep lexical-environment
    corner (per-iteration env + head destructuring + default-initializer
    closures). Decide: implement per-iteration for-in lex envs, or curate
    as documented divergence if jz's loop-let model is single-slot. Check
    first whether plain `for (let x of xs) push(() => x)` per-iteration
    capture works — if yes, the gap is only the head-destructuring form. ·
  function S13_A15_T4 (arguments-object semantics → undefined).
Each needs triage: some are documented-divergence candidates (curate with
reasons: line-terminator ASI edges, arguments semantics), some REAL
miscompiles (the yield-reassignment OOB; for-in lex scoping). Burn down or
curate; the gate stays red until the list is empty either way.
