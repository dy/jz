# fix/literal-method-typed-index — findings log

Branch: fix/literal-method-typed-index, worktree scratchpad/lm, base 1b16a09e.
Source snippets for layer 1 came from watr sibling's bisect files at
scratchpad/diff/snippet-bisect{1..10}.js, snippet-bytebuf{,-fixed}.js (see
the watr-stream worktree's uncommitted `streamcode-bug-notes.md` for the original hunt).
My own bisection variants live at scratchpad/lm-repro/*.js (NOT committed,
scratch only — pins go in test/data.js).

## Layer 1 — ROOT CAUSE FOUND, high confidence

Task's given paraphrase (mk/f, no .subarray call) does NOT reproduce — verified
PASS (8, correct) at O0/O1/O2/O3. The real trigger needs a SECOND ingredient
(a `.subarray()` call) that paraphrase omitted. Bisected from
snippet-bisect3.js (confirmed FAIL at 1b16a09e) down to a 2-ingredient minimal:

    export function main() {
      const b = { buf: new Uint8Array(8), n: 0 }
      b.set = (i, v) => { b.buf[i] = v }   // closure attached post-hoc, OWN
                                            // param `i` used as the index
      b.set(3, 7)
      const s = b.buf.subarray(0, 4)       // ANY .subarray() call on b.buf
      return s[3]
    }

Native JS: 7. jz -O0/O1/O2/O3: returns `undefined` (silent wrong value, no
trap, at this minimal size — deterministic across all 4 opt levels). Larger
variants (bisect3, snippet-bytebuf.js, closer to the paraphrase's shape) trap
`unreachable` instead — SAME underlying defect, different surface symptom
depending on surrounding code shape (register/temp allocation). Both are the
same miscompilation.

Bisection results (native → jz, O0 or O3, all from THIS worktree, not trusted
from stale artifacts):
- bisect1 (define all 5 methods incl. set/inc, call NONE): PASS 64
- bisect2 (direct writes, no methods, toBytes+loop): PASS 60
- bisect3 (b.set(i,v) called 3x + toBytes+subarray+loop): **FAIL** (traps)
- bisect4 (ensure()-triggered growth, direct writes): PASS 150005
- bisect5 (b.push(...xs) variadic method + toBytes+loop): PASS 60003
- v_a (bisect3 minus toBytes/subarray, direct b.buf[i] reads instead): PASS 60
- v_b (bisect3 minus multi-call, ONE .set() call + toBytes/loop): FAIL
- v_c (bisect3 minus cap-as-param, literal Uint8Array(64)): FAIL
- v_g (v_a + toBytes() call, read only .length, NOT looping into bytes[i]):
  **FAIL** — proves the loop/index-into-subarray is NOT required, merely
  CALLING .subarray() is enough.
- v_h (v_a + a direct loop reading b.buf[i], NO subarray at all): PASS 60 —
  proves looping isn't the trigger; .subarray() specifically is.
- v_i (NO .set() call at all, direct b.buf[0]=10 write, then .toBytes()):
  PASS 11 — proves a closure METHOD-CALL write is required, not just any
  write before subarray.
- v_j (.set() called, .subarray() INLINE not via a .toBytes() method): FAIL —
  proves toBytes needn't be a method itself; the inline `b.buf.subarray(...)`
  expression alone fails too.
- v_k (.set closure body uses a HARDCODED index, e.g. `b.buf[3]=v`, no
  parameter — called, then .subarray()): **PASS** 7, ZERO compiler warnings.
- v_l (.set closure body uses ITS OWN PARAMETER as index — defined but
  **NEVER CALLED** (dead code) — then .subarray()): **FAIL** (undefined) —
  proves the closure doesn't even need to be invoked. Merely being DEFINED,
  containing a dynamic-index write to a same-named property, is enough.

So the true minimal trigger: a closure exists ANYWHERE in the compiled unit
(called or not) whose body writes `X.buf[<non-literal>] = v` (property name
"buf", non-constant index) — this poisons EVERY later `.subarray()` call on
ANY `something.buf` expression in that function, even a completely
independent, provably-Uint8Array `b.buf`.

### Mechanism (traced via `--wat --names` diff of v_a's `.wat` vs v_j-shape's)

WAT diff for the failing shape shows `b.buf.subarray(...)` compiled as:
  1. `$__dyn_get_expr(receiverBits, "subarray"-as-string-constant)` — a
     DYNAMIC PROPERTY-NAME LOOKUP, exactly the machinery for `obj[dynamicKey]`
     or a genuinely user-defined closure property.
  2. The result is then invoked via `call_indirect` as if it were a closure.

This is `tryDynamicPropCall` (src/compile/emit.js:4461, strategy #11 of the
12-strategy method-call dispatch chain documented at emit.js:4571
`emitMethodCall`). It fires whenever every earlier strategy declined — i.e.
whenever `vt` (the receiver's statically-known kind) is null for the
`.subarray()` call's receiver `b.buf`.

**Layer A (why `vt` is null for `b.buf` even though `new Uint8Array(8)` is
unambiguous):** `src/kind.js` `VT['.']` (~line 942), the object-literal
child-type fold (~line 1000-1022): for a non-literal child value (`new
Uint8Array(8)` isn't `child.literal`), it consults `ctx.schema.slotWriteHazards`
— `hz.props.has(args[1])` where `args[1]` is the property NAME ("buf"). This
census is **keyed by property NAME across the WHOLE compiled unit, not by
receiver/object identity, and not flow/reachability-sensitive** (dead code in
an uncalled closure still populates it — confirmed by v_l). One unresolvable
write to ANY `.buf` anywhere (even on a different, unrelated, or dead-code
receiver) nulls the type-fold for EVERY `.buf` read program-wide. Comment at
kind.js:1021 confirms this is a deliberate "fail-closed" choice ("A named
write to the prop on ANY receiver keeps the veto (fail-closed)") — reasonable
for a conservative STATIC type-fold IF the runtime fallback stays correct.
v_k (literal index inside the closure) doesn't add to this hazard set — only
a non-literal/dynamic index write does (matches emit-assign.js's own
`deopt-dyn-write` warning gating).

**Layer B (the actual bug — where "fail-closed" stops being safe):**
`src/compile/emit.js` `tryRuntimePtrTypeFork` (~line 4206), strategy #8 in
the chain — this is the function that's SUPPOSED to catch exactly this case:
receiver kind statically unknown, dispatch at RUNTIME on the real ptr-tag
(STRING vs TYPED vs generic) instead of guessing. Its guard:

    const strEmitter = ctx.core.emit[`.string:${method}`]
    const typedEmitter = ctx.core.emit[`.typed:${method}`]
    const genEmitter = ctx.core.emit[`.${method}`]        // bare/generic
    if (!vt && genEmitter && (strEmitter || typedEmitter)) { ...runtime ptr-type dispatch... }

It unconditionally REQUIRES `genEmitter` (a generic, non-kind-prefixed
emitter) to exist as a gate, even though the runtime dispatch only actually
NEEDS `strEmitter || typedEmitter`. `.subarray` is registered ONLY as
`ctx.core.emit['.typed:subarray']` (module/typedarray.js:2891) — there is NO
`ctx.core.emit['.subarray']` anywhere in the codebase, because
TypedArray.prototype.subarray has **no Array.prototype analog** (confirmed by
src/kind-traits.js:217's own comment: "`.subarray` returns a typed-array
view (no plain-array analog)" — real JS Array has no `.subarray` either).
So `genEmitter` is always `undefined` for `.subarray`, the `&&` is false,
`tryRuntimePtrTypeFork` DECLINES ENTIRELY, and dispatch falls through
`tryGenericEmitter` (also requires the same absent `ctx.core.emit['.subarray']`)
straight to `tryDynamicPropCall` — which is wrong unconditionally for any
receiver that turns out, at runtime, to actually BE a typed array (its
`.subarray` is a prototype intrinsic, never a hash-stored own property, so
`__dyn_get_expr` can only ever find `undefined` there).

Note `.typed:subarray` itself (module/typedarray.js:2891-2900) ALREADY has a
fully-correct runtime-dispatch fallback internally (`resolveElem(arr)` fails →
calls the `$__subarray` runtime helper, "runtime-dispatched .subarray() for a
receiver whose elem type / view-ness isn't statically known", module/
typedarray.js:359-366) — but that machinery is UNREACHABLE because the
coarser `vt` check upstream (tryRuntimePtrTypeFork's genEmitter gate) never
lets execution reach `.typed:subarray` in the first place when `vt` is null.

**Blast radius check:** `.typed:set` also exists (module/typedarray.js:2153)
with — need to confirm — likely no bare `.set` generic emitter either (Map/Set
collection `.set` is a DIFFERENT namespace, `COLLECTION_METHODS`, handled by
an earlier strategy, not `ctx.core.emit['.set']`). If so, `TypedArray.prototype
.set(...)` on an unknown-vt receiver is the SAME bug, independent of my
snippet — evidence this is a real shape-class, not a one-off. (See TODO below
— did not fully verify before time-box; flag for the fix's own audit.)

### Conceptual fix (not yet applied / verify before committing)

`tryRuntimePtrTypeFork`'s guard should require `(strEmitter || typedEmitter)`
only — `genEmitter` is optional. When `genEmitter` is absent, the "neither
STRING nor TYPED at runtime" fallback arm should defer to the SAME later
strategies that would otherwise have run (`tryDynamicPropCall` /
`externalMethodFallback`), called with the receiver already bound to `t` (the
temp local this function already introduces) instead of re-deriving from
`obj`, to avoid double-evaluating a non-pure receiver expression — mirrors
the pattern already used for the STRING/TYPED cases in this same function
(`callMethod(t, strEmitter)`).

This is NOT a special case for `.subarray` — it fixes the general defect for
ANY typed/string-exclusive method with no generic analog (`.subarray`
confirmed; `.set`/`.setFromHex`/`.toHex` plausible siblings — TypedArray-only
by spec, no Array equivalent).

## Layer 2 — pass-order / index-shift dependent bug

STATUS: not yet started at time of this checkpoint (watchdog restart landed
here). The watr-stream worktree's uncommitted `streamcode-bug-notes.md`
points at bisect7/8/9/10 (all-standalone-functions, no methods) —
bisect7/10 FAIL even at count=0 (nothing but makeByteBuf+bufToBytes on an
EMPTY buffer executes) while bisect8/9 (fewer sibling functions defined,
otherwise same count=0 codepath) PASS — i.e. merely DEFINING extra
never-called sibling functions changes whether `main` itself traps. This
smells like the SAME `.subarray()`-via-tryDynamicPropCall defect (bisect7/10
both call `bufToBytes` which does `b.buf.subarray(...)` — if `hz.props` is
whole-compilation-unit-scoped as Layer 1 proved, adding sibling functions
that ALSO write a same-named dynamic-indexed property elsewhere would trip
the identical hazard-census poisoning). Need to verify whether bisect7's
`.subarray()` call is ALSO going through tryDynamicPropCall, and whether the
"index-shift" framing (call-target ordinal, schema id, string-pool position)
is a red herring vs. this being Layer 1's exact same root cause wearing a
different hat. If genuinely a DIFFERENT (call-target/ordinal) defect, check
feat/call-target-index (scratchpad/cti) before re-diagnosing callee
resolution myself.

TODO next: reproduce bisect7 fresh from this worktree (1b16a09e pin), dump
--wat --names, check whether its trap site is the same __dyn_get_expr→
call_indirect-on-"subarray" pattern or something else entirely.

## UPDATE: Layer 2 is NOT a separate bug — same root cause as Layer 1

Applied the conceptual fix (src/compile/emit.js `tryRuntimePtrTypeFork`: drop
the unconditional `genEmitter` requirement; when absent, fall back to
`tryDynamicPropCall`/`externalMethodFallback` reusing the already-evaluated
receiver temp `t` instead of declining the runtime ptr-type fork outright).

Verified on a clean ORIGINAL (unpatched) 1b16a09e checkout of src/compile/
emit.js (swapped in via `git show 1b16a09e:src/compile/emit.js`, NOT via any
repo-wide git command — single-file content swap in my own worktree, then
restored the patched file byte-identical afterward — confirmed via diff):

  ORIG (unpatched) bisect7  main(0): THREW unreachable (Cannot read
    properties of undefined / RuntimeError: unreachable) — reproduces the
    "fails even at count=0, merely defining sibling functions matters" bug
    from watr-stream's notes, confirmed on 1b16a09e (not just their
    dd3c11f9 branch).
  ORIG (unpatched) bisect10 main(0): THREW unreachable — same.
  FIXED (my tryRuntimePtrTypeFork patch) bisect7  main(0): 0 (matches
    native — PASS).
  FIXED (my tryRuntimePtrTypeFork patch) bisect10 main(0): 0 (PASS).

Mechanism: bisect7/10 both call `bufToBytes(b)` → `b.buf.subarray(0,
b.length)` — the exact same TYPED-only, no-generic-analog method as Layer 1's
minimal repro. bisect7/10 ALSO define bufEnsure/bufPush(2) — standalone
functions containing `b.buf[<dynamic index>] = x` writes — which populate
the SAME whole-program, name-keyed `ctx.schema.slotWriteHazards.props`
census (src/kind.js VT['.'], ~line 1017-1021) that Layer 1's v_l proved is
populated by MERE PRESENCE of such a write anywhere in the compiled unit,
reachable/called or not. bisect8/9 (fewer sibling functions — no bufEnsure/
bufPush at all, just makeByteBuf+bufToBytes) never populate that hazard, so
`.subarray()`'s receiver kind resolves statically and they always passed,
with or without the fix — exactly matching the original "adding never-called
sibling functions changes whether an unrelated path traps" observation,
which is fully explained by this ONE mechanism. There is no evidence of a
genuinely SEPARATE call-target-ordinal / schema-id / string-pool-position
dependent bug here — the "index-shift" framing in the task brief was an
unconfirmed hypothesis; this investigation found a complete, sufficient
explanation via the property-name-keyed hazard census + the
tryRuntimePtrTypeFork genEmitter gap. **Not handing off to feat/
call-target-index** — that sibling's callee-resolution work looks unrelated
to this defect (no call-target ordinal, schema id, or string-pool position
appears anywhere in the traced mechanism — it's a receiver-kind/method-
dispatch defect, not a callee-identity defect). If the call-target-index
sibling independently found a real pass-order callee bug elsewhere, it's
distinct from what's documented here.

Fix applied at src/compile/emit.js (tryRuntimePtrTypeFork, ~line 4206-4213
guard + ~line 4259-4270 genericCall construction). NOT a special case for
any specific snippet — the guard change is general (any method whose only
emitters are `.string:`/`.typed:` with no bare `.method` generic).

Next: confirm bisect8/9 unaffected (expect PASS before and after — sanity),
then run the full battery (test/index.js, kernel-parity, kernel-oracle,
bench size gates) against the fix before deciding real-fix-and-pin-positive
vs revert-to-KNOWN-WRONG-pin.

## FINAL: fix landed, full battery green

Commit 779b6a2f "tryRuntimePtrTypeFork: don't require a generic emitter to
runtime-dispatch typed/string-only methods" (src/compile/emit.js +
test/data.js, 3 new pinned tests replacing the KNOWN-WRONG convention with
positive assertions since the fix landed on this same branch).

Battery (all from this worktree, commit 779b6a2f on top of base 1b16a09e):
- `node test/index.js`: 3714/3715 pass, 1 skip, 0 fail, exit 0.
- kernel build (`node scripts/build-dist.mjs`): succeeded, dist/jz.wasm
  17466.4 kB, "wat-strip parity: 3 probes byte-identical".
- `JZ_TEST_TARGET=jz.wasm node test/index.js`: 2969/2970 pass, 1 skip,
  0 fail, exit 0.
- `node test/kernel-parity.js`: 3/3 tests, 33/33 assertions — matches the
  task's stated 33/33 target exactly.
- `node test/kernel-oracle.js`: 14/14 tests, 605/605 assertions — matches
  the task's stated 14/14 target exactly.
- `node test/bench.js`: 207/221 pass, 14 fail. Every failing assertion
  (grepped `✗ bench:` — the ONLY 4 distinct failing groups, "10 more"
  collapsed in the same families) is a pure SPEED ratchet: fastest-wasm
  delayline/fft/glyfparse (jz 1.09-1.18x a wasm rival, just over the 1.05x
  band) and the examples-corpus per-frame geomean strict-win-count
  (raymarcher 0.96x, percolation 0.79x, ulam 1.00x). Zero failures in any
  SIZE-gate group (`bench: size <name> jz win/tie vs as`, `bench: size
  geomean jz/as ≤ 1.05×`, `bench: <name> jz wasm size ≤ N B (backstop)` —
  all present in the log, none in the fail list) or correctness group.
  `ps` during the run showed 2+ concurrent sibling-agent sessions running
  their OWN full test suites + kernel builds on this same machine
  (scratchpad/cti's `JZ_TEST_TARGET=jz.wasm node test/index.js` +
  `node test/bench.js`, plus an unrelated `npm run test:fuzz --count=5000`)
  — consistent with the task's own pre-authorized "bench speed ratchets
  fail under machine load — only size/correctness gates count." Did not
  re-run bench.js a second time to chase quieter numbers (not required;
  every failure is in the excluded category).
- `bench/bench.svg` came back modified (regenerated chart data from running
  test/bench.js) — left uncommitted; it's a measurement artifact, not a
  source change, and would just churn again on the next (less loaded) run.

Not investigated further / left for a follow-up if anyone cares: the
FULL original snippet-bytebuf.js repro (real push/ensure/growth, called via
writeItem(out,seed) indirection) still returns wrong values (0 for every
count ≥ 1) even with this fix — confirmed pre-existing and NOT caused by
either this fix or the defect it fixes (native count=0 is legitimately 0;
jz-fixed count=0 is also 0 — only count≥1, which needs writeItem's
mutations to propagate back through its `out` parameter, stays wrong).
This matches watr-stream's own "Fix attempt 1: partial" / "second, distinct
issue" writeup exactly — a real, separate, already-partially-diagnosed
defect (object mutated inside a function it's passed into as a parameter
not reliably propagating back), untouched by this branch. Not the
"index-shift/call-target-ordinal" framing either — no call-target index,
schema id, or string-pool position appears anywhere in what was actually
diagnosed here.
