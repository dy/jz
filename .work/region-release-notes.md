# feat/region-release — dvnested soundness attempt + measured 4 GiB-close prototypes (2026-08-27)

Base: aff67069. Companion branch: watr `feat/streaming-code-section` @ 84c14c5
(/Users/div/projects/watr, worktree at .../scratchpad/watr-stream).

## Prerequisite (dvnested region-live O2/O3 soundness) — NOT closed

Built a region-enabled kernel (REGION_HOOKS_ACTIVE=true, current aff67069 source,
`node scripts/self-compile-build.mjs`, 265s, 15,720,308 bytes). `node test/kernel-oracle.js`
against it: 12/14 tests fail, INCLUDING `sum` (the simplest AGREE-tier program) at O0/O2/O3 —
broader than documented (self.js's own comment says only dvnested-mechanism at O2/O3 remains
broken). Sanity check: the SAME unmodified test file passes 14/14 (605 assertions) against a
known-good dormant build — isolates the regression to REGION_HOOKS_ACTIVE specifically, not a
harness bug.

Failure signature: `decodeThrown` (interop.js:888) decodes the thrown value to an 8-field
object matching `src/optimize/vectorize.js`'s BodyModel/`bl` shape (`writes, referenced,
hasGlobalSet, hasImpureCall, addrTable, offsetTees, siteAccess, aliasClass`) instead of the
expected Error `{message,name}` shape, with `writes` holding what looks like a caught error's
`.message` string. Consistent with `__schema_tbl` misresolution under region relocation — the
object's schema id resolves to the wrong table entry. Same bug CLASS as the dyn-props layer-1/
2/3 fixes already in module/core.js's `__region_exit` (all explicitly attributed to "kernel-
oracle dvnested-mechanism O2/O3 regression"), evidently not fully closed by those.

Both kernel-parity.js and kernel-oracle.js fail on their own respective FIRST corpus entry
(`sum`) — most likely ONE bug firing on the first region-heavy compile regardless of program
content, not many independent per-row bugs (kernel-oracle's AGREE-tier loop throws on the first
failure, aborting before later rows — e.g. dvnested-mechanism — are ever reached, so "12/14
fail" does not mean 12 distinct causes). `sum` is a smaller, cleaner repro than
dvnested-mechanism for whoever continues this.

**Not fixed**: root-causing a schema-table corruption this deep (Cheney-copy machinery,
module/core.js's ~1000 lines of hand-written WAT, layout-kinds.js's per-kind arms) needs many
more empirical iterations (~5 min per full self-compile rebuild) than fit in this session.
`REGION_HOOKS_ACTIVE` reverted to `false` (unchanged from aff67069) — no region-arena source
change is kept from this attempt.

**Structural finding, independent of the bug above**: region hooks (`front()`/`emitIR()` in
scripts/self.js) are never wired into the final `watrCompile(...)` encode call — confirmed by
reading self.js's own `compileSelf`. So even a fully-sound region arena (strategy A) would not
by itself close the wall: the final module boundary (WAT-IR tree + watr's code-byte arrays
coexisting) is untouched by strategy A as currently designed. This is corroborated empirically
below: a DORMANT (non-region) build with the streaming encoder wired in shows NO peak-memory
change at all, because the dormant build already exhausts memory during front/plan/emit —
before ever reaching the encode step the streaming prototype optimizes. Strategy A and B are
complementary, not alternatives; closing the wall needs region-style reclaim for the
front/plan/emit phases (or a native HIR memory win there) AND a streaming/packed encode step.

## Baseline measurement (confirmed, matches documented history exactly)

Dormant build (aff67069, `node scripts/self-compile-build.mjs`, 320s, 17,867,935 bytes).
`goal-probe.mjs` (feeds dist/jz.wasm the SAME {code,modules} graph that built it, via
`default(code,strict,optJSON,modulesJSON,host)`, reports `exports.memory.buffer.byteLength` at
trap/completion — monotonic growth, so final size IS peak):

```
baseline (dormant, aff67069): TRAP "unreachable", peakBytes 4294967296 (exactly 65536 pages,
  the wasm32 ceiling), elapsedMs 10974, 162 modules
```

## Strategy A (release-behind-the-cursor / region arena) — NOT MEASURABLE

Blocked entirely by the open soundness bug above: a region-live kernel fails before reaching
anything comparable to the goal probe (it cannot even compile the trivial "sum" program without
tripping the schema-corruption trap). No peak-bytes number exists for strategy A.

## Strategy B (streaming typed encoder) — MEASURED, prototype landed on watr, does not alone close the wall

Implementation: opt-in `streamCode:true` on watr's `compile()`/`assemble()` (feat/streaming-
code-section @ 84c14c5, watr repo). Writes each function's locals+instructions directly into
one growable, packed Uint8Array-backed buffer instead of the default path's per-function
`item` array + `inner` merge + `codeSection` merge (3 extra plain-JS-array copies of the code
section — 8 bytes/element under jz's own self-hosted ARRAY representation regardless of value,
vs 1 byte/element for a real packed buffer). Length-prefixed records (per-function body-size,
section overall size) use reserve + backpatch via `uleb5`'s existing fixed-width 5-byte LEB128
(spec-legal non-minimal padding). Two real bugs found and fixed during implementation: (1) a
Proxy-based buffer wrapper doesn't survive being bundled into jz's own self-hosted compiler —
jz's subset rejects `Proxy` (confirmed by an actual failed self-compile, not assumed) — rewritten
as a plain object of explicit methods, no `class`/`Proxy`; (2) `push` needs
`Array.prototype.push`'s variadic multi-argument form (several existing call sites push several
literal bytes in one call) — a single-arg version silently dropped every byte past the first.

Validation: watr's own full suite 604 pass / 0 fail / 22 skip (pre-existing todo/unsupported-
proposal rows) — default (non-streaming) path is byte-for-byte unaffected. Hand-written smoke
test instantiates and executes correctly with `streamCode:true` (module is valid, a few bytes
larger per function from the padded size prefixes — not byte-identical to default, semantically
identical). Wired into a real jz self-compile (scripts/self.js's watrCompile call,
`{streamCode:true}`, via an absolute-path import of the watr-stream worktree — throwaway
measurement rig, not a real dependency, see the commit on this branch) — kernel built
successfully (18,394,714 bytes, 356.6s, 165 modules — +3 modules / negligible source-text
growth from the direct-file-import graph-resolution shape, not a correctness issue).

`goal-probe.mjs` against the streaming-encoder kernel:

```
streaming encoder (strategy B): TRAP "unreachable", peakBytes 4294967296 (exactly 65536
  pages), elapsedMs 10864, 165 modules
```

**Peak bytes and elapsed time are indistinguishable from the dormant baseline** (4294967296
both, 10974ms vs 10864ms). The streaming encoder is real, tested, and does eliminate the
multi-copy code-section amplification it targets — but a DORMANT self-compile never reaches
the phase it optimizes: without any reclaim mechanism at all (regions off), compiler-internal
garbage from front/plan/emit alone already exhausts wasm32 before the final encode step ever
starts. This matches the structural finding above precisely.

## Recommendation

Neither prototype alone crosses under 4 GiB, and neither could be fully validated in
isolation (A blocked by an unresolved, broader-than-documented soundness bug; B validated but
structurally unable to help a dormant build). The two are complementary: closing the wall
needs BOTH a working reclaim mechanism for front/plan/emit (region arena, once its soundness
bug is actually closed — likely needs another schema-table root-completeness audit in the same
family as the dyn-props fixes) AND the streaming/packed encode step B already provides, working
together in one region-and-streaming build. Recommend: (1) root-cause the region soundness bug
starting from the `sum`-at-O0 repro (smaller than dvnested-mechanism), pinning schema-table
identity across region relocation as the next specific suspect; (2) once sound, re-measure a
build with BOTH region hooks active AND the streaming encoder wired in — that combination, not
either alone, is the one actually predicted to reach (or get meaningfully closer to) the final
encode phase with headroom.

## Commands used (reproducible)

- Region-live repro: flip `export const REGION_HOOKS_ACTIVE = true` in scripts/self.js,
  `node scripts/self-compile-build.mjs`, then `node test/kernel-oracle.js` /
  `node test/kernel-parity.js` from the worktree root.
- Baseline/prototype peak-memory measurement: `node <scratch>/goal-probe.mjs <dist/jz.wasm path>
  [label]` (script lives outside this repo, in the session scratchpad — reproduce by feeding
  `resolveSelfCompileBuild()`'s own `{code, modules}` graph back into the built kernel's
  `default(code,strict,optJSON,modulesJSON,host)` export and reading
  `exports.memory.buffer.byteLength` after trap/completion).

## CRITICAL CAVEAT found after the above was written: streaming-encoder kernel has a real, uncaught correctness bug

Ran `node test/kernel-oracle.js` against the streaming-encoder-built kernel (the exact
artifact the peak-bytes measurement above used): **9/14 fail**, first failure on `sum` (the
same trivial program) at O0/O2/O3, with the identical `decodeThrown`/TypeError-wrong-object-
shape signature seen in the (unrelated, region-hooks) soundness investigation above. Baseline-
probed immediately: the DORMANT baseline kernel (no streaming, no regions, same aff67069
source) passes the SAME unmodified test 14/14 (605 assertions) — proves this is a NEW,
real bug introduced by the streaming encoder, not a pre-existing or coincidental issue.

Root cause not found (out of time this session). Likely explanation: watr's own 604/0/22
green suite only ever exercised the DEFAULT (non-streaming) path against the official
conformance tests — `streamCode:true` was only ever validated against 2 tiny hand-written
smoke-test modules (a handful of instructions each) before being wired into a real jz
self-compile. jz's actual compiled output is far more structurally complex (many functions,
large bodies, real stdlib), and something about that scale/shape trips a bug the smoke tests
never exercised — most plausibly in the reserve+backpatch offset bookkeeping
(`buildCodeItemStreaming`/`patchUleb5`) rather than in the underlying instruction encoding
(which IS the same `instr()`/HANDLER logic the 604-test suite already exercises, just fed
into a different destination buffer).

**Consequence for the peak-bytes measurement above**: the streaming-encoder kernel that
produced "peakBytes 4294967296, same as baseline" is a DEMONSTRABLY BUGGY compiler artifact.
The measurement is real (that build, as built, traps at exactly the same point as baseline)
but should be read as suggestive, not a clean validated apples-to-apples comparison — a
CORRECT streaming encoder could plausibly behave differently. The structural argument (regions
never wire into watrCompile, so a dormant build can't benefit from an encode-only optimization
regardless) still holds independently of this bug and is the more load-bearing reason not to
expect this prototype alone to move the ceiling.

**Required follow-up before trusting streamCode:true for anything real**: a differential test
that runs the FULL official wasm testsuite (or better, jz's own real compiled output) through
BOTH `compile(nodes)` and `compile(nodes, {streamCode:true})` and compares EXECUTION results
(not just validity) — the gap that let this ship past watr's own green suite unnoticed.

## Root-cause session (2026-08-27/28) — IN PROGRESS, narrowed to front()'s own region round

Continuing from the `sum`-at-O0 repro above. Diagnostic method: `instantiate()` the built
kernel directly (bypassing the wrapped-export message-loss path — `decodeThrown` translates an
unrecognized-schema object to `new Error(String(value))` = `"[object Object]"`, but
`wrapped.thrown` keeps the FULL mis-decoded object, so reading `e.thrown` off the caught error
recovers every field even under the wrong schema). Repro script:
`/private/tmp/claude-501/-Users-div-projects-jz/0482f00a-7cbc-475b-939a-b25b5ba26704/scratchpad/diag1.mjs`
(loads dist/jz.wasm, calls `self.exports.default(src, 0, optJSON, 0, 0)` directly, prints
`e.thrown`'s fields).

**Finding 1 — the thrown value is a real, correctly-shaped TypeError, just mis-schema'd.**
`e.thrown` decodes (via BodyModel's 8-field schema, wrong tag) to
`{writes: 'Cannot read properties of undefined', referenced: 'TypeError', hasGlobalSet: 0, ...
(rest 0)}`. The first two fields are exactly the V8-style message+name pair; the trailing 6
are zeroed heap past the object's real 2 slots. This is jz's own in-kernel nullish-property-read
guard (`$__throw_property_nullish`, module/core.js:2782, the sole caller of `$__length`/
`$__length.value` — ctx.schema.errorSid('TypeError'), a 2-slot {message,name} object) firing
for real: `$__length`'s dispatch (module/core.js ~2849-2855) calls it exactly when the receiver
bits equal the NULL or UNDEF atom. So during compilation of `sum` (not during execution of
`sum`'s output — this throw happens INSIDE the `self.exports.default(...)` compile call itself),
some `.length` read inside the COMPILER'S OWN SOURCE (front.js/prepare/plan/emit, all
self-compiled into the kernel) hits a receiver that is unexpectedly null/undefined. Confirmed
NOT a generic "Array.isArray"/decodeThrown artifact: a second throwTypeErrorIR call site exists
(module/array.js:653, Array.from's BigInt-length guard) but `$__throw_property_nullish`'s
null/undefined-receiver gate is the one that matches (module/core.js:2852-2855).

**Finding 2 — isolated to front()'s SINGLE region round**, by bisection (edit
scripts/self.js's three call sites individually to `regionHooks: undefined`, rebuild at
JZ_SELF_COMPILE_OPT=0 (~100s/build), re-run diag1.mjs): with ONLY front()'s
`regionHooks.mark()/.exit()` pair active (emitIR's own boundary AND optimizeTail's, including
plan/index.js's 7 nested rounds which run under emitIR's hooks, ALL forced to `undefined`), the
bug still reproduces identically at O0/O2/O3. So the bug does not need compileAst, plan(), or
watrTail's region rounds at all — it is fully contained in frontHalf's one mark→parse→liftIIFE→
jzify→prepare→exit→preEval round (src/front.js).

**Finding 3 — ruled out a generic destructuring-assignment-to-member-expressions codegen bug.**
front()'s exit rebinds via `;[ast, ctx.funcs, ctx.module, ...] = regionHooks.exit(mark, [...])`
— an array-destructuring ASSIGNMENT (not declaration) into a mix of a plain identifier and 12
multi-level member-expression targets, 13 wide. Wrote a native (non-self-hosted, no kernel
needed) differential test mirroring this exact shape
(`/private/tmp/claude-501/-Users-div-projects-jz/0482f00a-7cbc-475b-939a-b25b5ba26704/scratchpad/destructure-test.mjs`:
a 13-wide `[x, state.a, state.b, ...] = mkArr()`) — passes byte-correct at O0/O2/O3 natively.
So the destructuring-into-member-expressions shape itself is sound; the bug is specific to
region_exit's actual relocation, not to how self.js's assignment line compiles.

**Finding 4 — breadcrumb via source-literal injection (the DBG_INVARIANTS technique, applied
ad hoc rather than via the existing flag)**: since `process`/`console` are inert inside the
kernel, instrumented by temporarily replacing a `return` with `throw new Error(diagnostic
string)` directly in src/front.js (gated on `if (regionHooks)` so it doesn't fire during the
native LEVEL-0 build of the kernel itself, only inside the running kernel at LEVEL 1), rebuilding,
and reading `e.message` off the caught host-side error. First breadcrumb (right after `front()`
returns to scripts/self.js's compileSelf, i.e. AFTER preEval too) found `ast` fails
`Array.isArray()` — surprising, since preEval's own return (`foldBlockLike`) is always a jz AST
array node. `ctx.funcs.list` (arr1), `ctx.schema.list` (arr0), `ctx.scope.globals` all looked
plausible at that checkpoint. Second breadcrumb (mid-flight in progress at session pause/handoff
— see below) moved the throw to INSIDE frontHalf itself, capturing `Array.isArray(ast)` both
immediately BEFORE region_exit (right after `prepare()` returns) and immediately AFTER (right
after the destructuring reassignment, BEFORE preEval runs), to localize the corruption to
either (a) the region_exit call itself, or (b) preEval reading some other corrupted ctx field.
Gated the throw on `regionHooks` truthy (the first attempt threw unconditionally and fired
during the NATIVE level-0 build of self.js itself, since frontHalf is shared — front.js's
`frontHalf` runs both natively, compiling self.js's own source with regionHooks=undefined, AND
inside the kernel with regionHooks live; an unconditional throw fires on the first native call
before the kernel even gets built).

**Static reading, not yet confirmed empirically**: read `__region_copy_rec`'s preamble
(numbers/ATOM passthrough), the ARRAY arm (regionArmArray, layout-kinds.js:249-409), the OBJECT
arm (regionArmObject, layout-kinds.js:623-734), `__mkptr`/`__ptr_aux`/`__ptr_offset`
(module/core.js:298-417 — clean, independent type/aux/offset fields, no bit-bleed risk), and
`__region_memo_get`/`__region_memo_set` (module/core.js:1080-1116 — delegate to the generic
`$__map_get`/`$__map_set`, scratch-lane redirected). None show an obvious bug on inspection;
the ARRAY arm's `off < mark` durable/ephemeral split and its `newOff - delta` deferred-final-
address scheme (scratch lane, closing memcpy in `__region_exit`) both look internally consistent
with their own extensive doc comments. Also examined the OTHER live hypothesis from this
session — a dynamically-growing `$__schema_tbl` reserve area (`runtimeReserve`,
`__jp_schema_get`/`__schema_next`, module/json.js:1083-1148, wired because self.js's own
`setupSelf` calls `JSON.parse(optJSON)`) that is NOT covered by any region root, unlike
`$__dyn_props`'s already-fixed implicit-root treatment (module/core.js ~1336-1352) — plausible
in general but the registration for `optJSON` happens in `setupSelf`, BEFORE front()'s first
`mark()`, so it lands pre-mark/durable and is very unlikely to be the trigger for THIS repro
specifically (kept as a secondary suspect, not yet ruled out for other programs/rounds).

**State at handoff**: scripts/self.js currently has `REGION_HOOKS_ACTIVE = true` plus TWO of its
three regionHooks call sites forced to `regionHooks: undefined` (optimizeTail's line ~109, and
emitIR's block ~181) as bisection scaffolding, and a dead (front.js throws first) debug throw
left in compileSelf. src/front.js currently has a temporary `if (regionHooks) throw new
Error(__dbgPre + ' || ' + __dbgPost)` breadcrumb before its final `preEval` call, comparing
`Array.isArray(ast)`/`.length`/`[0]` immediately before vs after the exit-rebind. A rebuild with
this breadcrumb was in flight (JZ_SELF_COMPILE_OPT=0, background) at the point these notes were
written; check `/private/tmp/.../scratchpad/logs/build-dbg3.log` and re-run
`node .../scratchpad/diag1.mjs` against the resulting dist/jz.wasm to read the result. ALL of
this instrumentation (self.js's two forced-undefined sites + dead throw, front.js's throw) is
throwaway and must be reverted before any battery run or commit of a real fix — none of it is
part of the fix itself, it's only diagnostic scaffolding for this session.

**MAJOR UPDATE (same session, continued)**: the dbg3 breadcrumb result came back — `preIsArr=false`
too (BEFORE region_exit runs at all: `parse(true,2) lift(true,2) jzify(true,2) prepare(false,-1)
exit(false,-1)`, a later, more granular breadcrumb, dbg5). **This retargets the whole
investigation: the bug is NOT in `__region_copy_rec`/`__region_exit`'s relocation logic — `ast`
is already wrong at the moment `let ast = time('prepare', () => prepare(parsed))` finishes
executing, before `regionHooks.exit(...)` is ever called.** Verified this is not a decode/
diagnostic artifact: `parse`/`liftIIFE`/`jzify`'s own three `time(...)`-wrapped assignments (the
exact same call shape, same boxed-cell mechanism) all report correct arrays at each stage; only
the fourth, `prepare`, breaks.

Dumped the ACTUAL compiled WAT for the whole kernel (`compile(profile.graph.code, {modules,
wat:true})` on `resolveSelfCompileBuild({optimize:0})`'s own graph — same technique
self-compile-build.mjs uses, just requesting text; script:
`/private/tmp/.../scratchpad/wat-dump.mjs`, output:
`/private/tmp/.../scratchpad/kernel-o0.wat`, ~250MB, use anchored `grep -nE '^ *\(func \$name'`
and `awk 'length($0)<10000'` before grepping — the file has a few multi-megabyte single lines
that swallow naive greps) and traced the FULL call chain by hand:

- `frontHalf` (compiled as `$m119_front$frontHalf`) is a `local $ast f64` that gets BOXED into a
  heap cell (`$cell_ast`, an 8-byte `$__alloc` block, NOT `__alloc_hdr` — no header) because it's
  captured by the closure `() => preEval(ast)` on frontHalf's own last line AND reassigned by the
  destructuring — this is jz's normal "closure-captured mutable local" boxing (same mechanism as
  `ctx.func.boxed`/preboxedLocalInits elsewhere), and by itself is not a red flag — `parsed` gets
  boxed into `$cell_parsed` for the identical reason and works correctly.
- `front()` (scripts/self.js, compiled as top-level `$front`, no module prefix since self.js is
  the graph's entry `code` not a `modules` file) builds the `regionHooks` object CORRECTLY,
  gated at RUNTIME on `global.get $REGION_HOOKS_ACTIVE` (true in this build) — a 2-slot
  dyn-props object `{mark: <closure>, exit: <closure>}`, both slots compile-time-constant
  closure pointers (PTR.CLOSURE, tag=10, aux=3274 and 3275 — decoded via layout.js's own
  AUX_SHIFT=32/AUX_MASK=0x7FFF/TAG_SHIFT=47/TAG_MASK=0xF constants).
- Function-table index 3274 (`$closure3274`) is `(call $__region_mark)` — correct, verbatim.
- Function-table index 3275 (`$closure3275`) is `local $mark=$__a0; local $root=$__a1; (call
  $__region_exit (local.get $mark) (local.get $root))` — correct, verbatim, matches
  `(mark,root) => __region_exit(mark,root)` exactly.
- `$__region_mark`/`$__region_exit` (the real stdlib functions, module/core.js's hand-written
  WAT) DO exist in the compiled kernel (`awk 'length($0)<10000' kernel-o0.wat | grep -n 'func
  \$__region_exit\b'` — a naive unfiltered grep across the whole 250MB file gives a false
  "0 matches" because one giant ~3.3MB single line (embedded module/core.js source-text data,
  needed so the KERNEL can itself compile a FURTHER region-enabled program) contains the
  substring and swallows the real hits in output-size truncation — do not trust a bare grep
  across this file without the length filter, this cost real time in this session).
- `frontHalf`'s own call site builds the root array correctly (`arr23[0] = f64.load($cell_ast)`
  — properly DEREFERENCES the boxed cell, not the cell's address) and dispatches
  `regionHooks.exit(mark, root)` via jz's generic dynamic-closure-call protocol (`call_indirect`
  through `$ftN`, an 8-arg-padded uniform ABI) to whichever of the two branches
  (closure-table-index dispatch vs an EXTERNAL/host-value fallback that can never actually fire
  here) resolves — this part of the caller side is fully verified correct.

**So the call chain from `frontHalf` down through `regionHooks.exit` into the real
`$__region_exit` stdlib function is 100% verified correct — none of it is implicated.** The
actual break is upstream of all of this, in the FOURTH `time(...)`-wrapped assignment itself:

```
(f64.store (local.get $cell_ast)
  (block (result f64)
    (local.set $clos17 (local.get $time))
    (call_indirect (type $ftN) (local.get $clos17)
      (i32.const 2)                        ;; argc=2
      (f64.const nan:...)                  ;; arg0 = 'prepare' (the label string)
      (block (result f64)                  ;; arg1 = the () => prepare(parsed) closure literal
        (local.set $env18 (call $__alloc (i32.const 8)))
        (i32.store (env18+0) (local.get $cell_parsed))   ;; captures cell_parsed's ADDRESS (i32), correct boxed-capture shape
        (call $__mkptr (i32.const 10) (i32.const 1620) (local.get $env18)))
      ...padding... (closure's own id/env arg))))
```

This is `ast = time('prepare', () => prepare(parsed))`, compiled as: resolve `$time` (should be
the DEFAULT parameter value `(n,f)=>f()`, since scripts/self.js's `front()` never passes a
`time` option), `call_indirect` it with 2 args (label, closure), store the whole call's f64
result into `$cell_ast`. Structurally this is THE SAME SHAPE as the three earlier `time(...)`
calls that all work correctly — same `$time` variable, same call_indirect/`$ftN` mechanism, same
boxed-cell store target shape (parsed's own 3 assignments store into `$cell_parsed` the same
way). The one thing that's different about this 4th call: it's the only one wrapping `prepare`
(a many-thousand-line function with a large number of internal early/late return statements,
src/prepare/index.js, vs `parse`/`liftIIFEs`/`jzify`, comparatively small single-return
functions) — the leading hypothesis at session's end is that `prepare()`'s OWN return-kind
inference (whatever proves/fails-to-prove its result is uniformly an array across every one of
its return paths) resolves differently than the other three, and that difference changes how
the GENERIC closure-call protocol (`$ftN`/`call_indirect`, needed here because `f` in `time(n,f)
=>f()` is an opaque, dynamically-dispatched parameter, not a direct call) marshals/boxes the
returned value — i.e. this may not be a region-arena bug at ALL, but a pre-existing (or
`INTRINSIC_CALLEES`/closure-return-kind-inference) gap in how a closure's return value is
proven/boxed when the wrapped function has many return sites, that ONLY gets EXERCISED by
region-live code because REGION_HOOKS_ACTIVE=false statically deletes the entire `if
(regionHooks) {...}` block (and, per this session's newest edit, temporarily bypasses the
`time(...)` wrapper for the `prepare` call specifically for isolation — see below), so dormant
never compiles this call shape with the closure indirection reachable at all — needs
re-verification since front.js's `time` wrapping still applies uniformly regardless of
regionHooks in the REAL (unedited) source; the actual reachability gate here is TBD and is
exactly what the in-flight test (below) is checking.

**In-flight at handoff**: edited src/front.js to bypass `time(...)` for JUST the `prepare` call
(`let ast = prepare(parsed)` instead of `let ast = time('prepare', () => prepare(parsed))`,
`parse`/`liftIIFE`/`jzify` left unchanged, still through `time(...)`) plus a breadcrumb
`if (regionHooks) throw new Error('astViaDirectCall isArr=' + Array.isArray(ast) + ...)`
immediately after, to test whether removing the closure-indirection layer for prepare's own
call fixes the corruption. A build with this change was in flight
(`/private/tmp/.../scratchpad/logs/build-dbg6.log`) at the point these notes were last updated —
read that log / re-run `node .../scratchpad/diag1.mjs` against the resulting dist/jz.wasm to see
the result. If `astViaDirectCall isArr=true`: the bug is specifically in the `time(...)`/
`call_indirect` closure-forwarding path for a many-return-site function like `prepare`, not in
`ast`'s boxed-cell storage itself — next step is comparing the COMPILED WAT for this direct-call
form against the time()-wrapped form (a `--wat` diff) to find exactly what differs, or writing a
native (non-self-hosted, no kernel build) repro: a HOF `time = (n,f) => f()` wrapping a call to
a LARGE function with many distinct return statements/paths (mirroring prepare()'s shape more
closely than this session's earlier, too-simple native mirrors — destructure-test2 through 6, in
the same scratchpad dir — which all used trivial single-return stub functions and could not
reproduce the bug natively). If `astViaDirectCall isArr=false` too: the bug is in `prepare()`
itself when called from WITHIN frontHalf specifically (region-live reachable code path), not in
the time()/closure layer at all — re-examine prepare()'s own return statements/early-exit paths
(src/prepare/index.js:782 has the entry; the function is very long, many `return` sites) for
one whose value shape differs from a plain AST array, and check whether ANY of them could be hit
for a trivial "sum" input specifically under self-compiled (kernel) execution vs native.

**All of scripts/self.js's/front.js's current diffs at this handoff point are throwaway
bisection/debug scaffolding** (self.js: two of three regionHooks call sites forced to
`regionHooks: undefined` for the front-only-boundary isolation confirmed in Finding 2 above,
plus a dead debug throw in compileSelf; front.js: the direct-prepare-call bypass + breadcrumb
described just above) and MUST be reverted to source-of-truth (git diff against aff67069 for
both files should be empty) before any battery run or real fix lands — none of it is a
candidate fix, all of it exists only to narrow the search.

**SUPERSEDED by the update above** — this paragraph assumed the corruption was inside
`__region_exit`'s relocation walk; the dbg5/dbg6 breadcrumbs proved it happens BEFORE
`regionHooks.exit` is ever called, at the `prepare()` assignment itself, so the
`__region_copy_rec`/`$__dyn_props`-implicit-root avenue below is very likely a dead end for
THIS specific repro (kept only as a secondary idea if the `prepare()`/closure-indirection avenue
above also dead-ends). Original text, unedited: read the dbg3 result — if `postIsArr=false`
right after the exit-rebind (before preEval even runs), the corruption is inside
`__region_copy_rec`'s handling of the `ast` root-array element itself (or one of the 12 ctx.*
fields it depends on transitively) — narrow further by memo-dumping `__region_copy_rec`'s
per-element root walk. If `postIsArr=true` (unchanged right after exit) but preEval's result is
what fails, the bug is in preEval reading some OTHER, not-yet-suspected corrupted ctx field.

**Next steps for whoever continues this** (current, supersedes the paragraph above): (1) read
the dbg6 result (`astViaDirectCall isArr=` — see the MAJOR UPDATE section) and follow whichever
branch it points to (both spelled out there in detail — the `time()`/closure-forwarding avenue
vs. `prepare()`'s own return-path shape). (2) Once the exact corrupted value/mechanism is found,
determine whether it's actually region-arena-specific at all, or a pre-existing gap in generic
closure-return marshaling that region-live code merely happens to be the first to exercise (the
dormant build never compiles the `if (regionHooks) {...}` block since `REGION_HOOKS_ACTIVE`
folds to a literal `false`, so if the bug is really about closure-forwarding a many-return-path
function's result, it may be latent in ANY reachable code with this shape, not specific to
`__region_exit`/`__region_mark` at all — worth a native, non-self-hosted differential test with
a large multi-return function wrapped by a `(n,f)=>f()`-style HOF, once the exact trigger is
confirmed). (3) Keep `REGION_HOOKS_ACTIVE` at `false` and run the full mergeable battery
(test/index.js, kernel-oracle, kernel-parity, kernel build + kernel-target suite, bench size
gates) before and after reverting this session's bisection/debug scaffolding (see the "All of
scripts/self.js's/front.js's current diffs" paragraph above for the exact list), to confirm no
unrelated regression was introduced by the edits made while investigating.

## CRITICAL CORRECTION (same session, after the above) — the whole `Array.isArray(ast)` chase
## was a FALSE LEAD. `ast === null` for "sum" is CORRECT, expected behavior, not a bug.

The dbg6/dbg7 result came back: `ast isArr=false ... isolated isArr=false ... sameRef=true` —
i.e. `prepare(parsed)` itself returns something that fails `Array.isArray`, reproducibly, on a
FRESH, independent call, nothing to do with boxing/cells/closures. This looked like a real
finding, so the natural next move was to isolate `resolveSelfCompileBuild`'s `inlinePtrOffsetFast:
false` optimizer override (applied whenever `regionArenaLive`, independent of whether any actual
`__region_mark`/`__region_exit` call exists) as a competing hypothesis to "real region hooks
firing": built via a standalone script
(`/private/tmp/.../scratchpad/build-inlineptr-test.mjs`) calling
`resolveSelfCompileBuild({optimize, regionArena:true})` while scripts/self.js's own
`REGION_HOOKS_ACTIVE` marker stayed `false` (verified — `git diff` on scripts/self.js was empty
at that point) — so this build has ZERO actual region-hook calls anywhere, only the optimizer
override. **`astIsArr=false` reproduced there too**, at both O0 and O2. That result forced a full
stop-and-reconsider, because at O0 AND O2 `inlinePtrOffsetFast` is ALREADY `false` by the
compiler's own un-overridden preset defaults (`src/optimize/index.js:134`'s `L2_PRESET` and
line 189 both hardcode `inlinePtrOffsetFast: false`; the flag only ever reads `true` at a
higher/"speed" preset the region-arena override would meaningfully change) — so this build was,
for the one thing being tested, BEHAVIORALLY IDENTICAL to a completely untouched, fully dormant
build. A "bug" that reproduces in a build indistinguishable from dormant cannot be the
region-arena regression at all.

Verified directly and definitively, NATIVELY, no kernel involved
(`/private/tmp/.../scratchpad/verify-prepare-native.mjs` — runs `parse` → `liftIIFEs` → `jzify` →
`prepare` by hand on the literal string `'export let sum = (a, b) => a + b'`, the same source
this whole session's `diag1.mjs` repro used): **`prepare()` legitimately returns `null`** for
this input (`ctx.funcs.list` correctly holds `['sum']` — the ONE function got fully extracted
into the function registry, leaving NOTHING at module top level, so `prepare()`'s "empty module
body" case returns `null`, not `[]` or any array). This is an EXPECTED, HANDLED case elsewhere in
the same pipeline: `src/prepare/pre-eval.js`'s own `preEval(ast)` opens with
`if (ast == null) return ast` specifically for this shape. So `Array.isArray(ast) === false`
right after `prepare()` in `frontHalf` (dbg3/dbg5/dbg6/dbg7's whole signal) is **completely
normal, correct, pre-existing behavior for a source this trivial (one function declaration, no
other module-level statements) — not a symptom of anything region-related, not a bug at all.**
Every finding built on top of that premise (Findings 2-4, the closure-return-kind hypothesis,
the `cellTypes`/i32-narrowed-boxed-cell hypothesis, the `time()`/`call_indirect` marshaling
hypothesis, the whole WAT-level trace of `frontHalf`/`front()`/the mark/exit closures/
`$__region_mark`/`$__region_exit`) is now understood to have been chasing a value that was
NEVER wrong — it was diagnosing normal control flow, not the reported defect.

**What is NOT invalidated by this correction**: the ORIGINAL repro itself (the very first
`diag1.mjs` run this session, against a clean, unmodified `REGION_HOOKS_ACTIVE=true` build, zero
source edits) — a genuine uncaught `TypeError: Cannot read properties of undefined` thrown
DURING the kernel's compile call for `sum`, decoded via the wrong (BodyModel's 8-field) schema,
first two fields matching `$__throw_property_nullish`'s exact `{message,name}` payload
(module/core.js:2782-2818, the shared nullish-`.length`-read guard, called from `$__length`/
`$__length.value` when the receiver's bits equal the NULL or UNDEF atom — module/core.js
~2849-2855). That symptom is real and still completely unexplained. What this correction rules
out is WHERE in `frontHalf` to keep looking: `ast` itself, immediately post-`prepare()`, is not
the culprit — it is supposed to be `null` here and everything downstream (`preEval`'s own
null-check, `compile()`'s own `if (ast) {...}` guard seen earlier in this session's static
reading) is written to expect that.

**Corrected next step**: the `.length`-on-nullish read that throws must be on some OTHER value —
most likely one of the other 12 root-array fields (`ctx.funcs`, `ctx.module`, `ctx.schema`,
`ctx.closure`, `ctx.scope`, `ctx.types`, `ctx.warnings`, `ctx.plans`, `ctx.inspect`, `ctx.func`,
`ctx.transform`, `ctx.facts`) post-relocation, OR — given `ast === null` means `preEval`'s OWN
`for (const f of ctx.funcs.list) f.body = foldFunctionBody(f.body, state)` loop is the ONLY real
work `preEval` does for this input (it runs BEFORE the `ast == null` short-circuit, per
pre-eval.js:924-925 read earlier this session) — a very concrete, narrow next probe: dump
`ctx.funcs.list[0].name` / `Array.isArray(ctx.funcs.list[0].body)` / `.body`'s shape
immediately after the region_exit destructuring (right where this session's dbg3/dbg5
breadcrumbs already sit, just checking a DIFFERENT field than `ast`). `sum`'s own function body
(`a + b`, wrapped in whatever AST node `.body` holds) is exactly the kind of small, ephemeral,
post-mark allocation `__region_copy_rec`'s ARRAY/OBJECT arms would need to relocate correctly,
and it is reachable from the root only transitively (`ctx.funcs` → `.list` → each entry's
`.body`), which is a plausible place for a one-level-too-shallow walk or a memo bug to hide. A
FRESH kernel build with a breadcrumb on exactly this field (not `ast`) is the next concrete,
bounded action — none of this session's remaining time permitted running it.

**Session ending here** (restarted once already by a watchdog after 63 minutes without
transcript activity; wrapping up per the coordinator's instruction rather than risking another
silent stall). scripts/self.js is confirmed clean (`git diff` empty, `REGION_HOOKS_ACTIVE =
false`, matching source of truth). src/front.js currently still carries ONE throwaway diagnostic
line (the `code === 'export let sum = (a, b) => a + b'` gated `Array.isArray(ast)` throw used for
the correction above) — harmless (dead in production: the exact literal string match never
occurs in real compiles) but should be reverted before this branch is called mergeable; diff is
one `if (...) throw new Error(...)` line, trivial to remove by hand if this file is picked up
fresh. No production source file (module/core.js, layout-kinds.js, src/compile/*.js outside this
one throwaway line, etc.) was changed by this session — no fix was landed, none was close enough
to justify landing. `REGION_HOOKS_ACTIVE` remains `false`, unchanged from aff67069/dormant, exactly
as it was at session start.

## ROOT CAUSE FOUND (2026-08-28) — front's round mid-round-triggers stdlib module registration into wholesale-excluded ctx.core

Continuing from "Corrected next step" above (the `ast===null` chase was a false lead;
`.length`-on-nullish must be on some OTHER value). Found via pure static reading, no kernel
build needed for this part.

**The mechanism, precisely:**

1. `src/front.js`'s `frontHalf` doc comment already documents a deliberate "UNION-FIELD ROOT"
   of 12 `ctx.*` fields (`funcs, module, schema, closure, scope, types, warnings, plans,
   inspect, func, transform, facts`) rebound at `regionHooks.exit(mark, [...])`. The SAME doc
   comment explicitly excludes 9 other fields (`core, bridge, names, runtime, memory, error,
   abi, features, linkDemand`) — reasoning given: "`ctx.core.emit`/`ctx.core.stdlib`/`ctx.bridge`
   carry hundreds of CLOSURE-valued properties... that the region-arena relocation walk is not
   proven safe against."

2. `src/compile/index.js`'s LATER, separate EMISSION region round (`emissionRoundExit`, Slice 3)
   roots a WIDER set — the same 12 PLUS `ctx.runtime, ctx.memory, ctx.error, ctx.linkDemand,
   ctx.names, ctx.features` (its own comment: "extended past the ANALYSIS-stratum 12-field union
   (front.js's own doc, shared by every round so far) with EMISSION's own write-set, PLAIN-DATA
   FIELDS ONLY"), PLUS specific `ctx.core.includes/extImports/jsstring/hostGlobals/stdlibDeps`
   subfields — but explicitly, permanently keeps `ctx.core.emit`/`ctx.core.stdlib` (and
   `ctx.bridge`/`ctx.abi`) OUT: "this is the load-bearing lesson of the FIRST re-land attempt
   (53bcb112+7085cb57, reverted) — 7085cb57 rooted `ctx.core`/`ctx.abi`/`ctx.bridge` wholesale to
   fix exactly this under-coverage and made the regression WORSE ('phantom pair GROWN')" — ALSO
   independently reproduced by "two direct experiments" in `.work/research.md` §CompileSession
   Slice D as real WASM traps. So wholesale-rooting `ctx.core` is a previously-tried, previously-
   REVERTED dead end, not an open option.

3. **`src/prepare/index.js:800`** — `prepare()`'s own entry, right after
   `ctx.module.include = includeModule` — calls **`includeModule('core')` unconditionally**, as
   its first real action, for EVERY compile regardless of source content (confirmed by reading
   the line in context — no guard). `includeModule` (`src/autoload.js:279`) is idempotent
   (`if (ctx.module.modules[modName]) return`) but on a FIRST call runs `init(ctx)` —
   `module/core.js`'s `export default (ctx) => {...}`, which registers a large number of
   CLOSURE-valued entries into `ctx.core.emit`/`ctx.core.stdlib` (e.g. `__region_mark`,
   `__region_exit`, and the bulk of core.js's ~1000+ lines of stdlib registration) — every one a
   fresh heap allocation at KERNEL RUNTIME (compiling the guest program), since `module/core.js`
   is itself self-compiled into the kernel and its `ctx.core.emit[name] = value` writes execute
   as real WASM instructions using `$__alloc`/`$__heap`, the SAME bump allocator
   `__region_mark`/`__region_exit` operate on (confirmed: `ctx.core.stdlib['__region_mark'] =
   ...(f64.convert_i32_u (global.get $__heap))...` — `__region_mark` IS just "read current
   `$__heap`").

4. `frontHalf` calls `mark = regionHooks?.mark()` BEFORE `parse`/`liftIIFEs`/`jzify`/`prepare` —
   so `prepare()`'s `includeModule('core')` call happens strictly AFTER `mark()`, i.e. INSIDE the
   active region round. Since `ctx.core` is wholesale excluded from front's root (point 1), every
   closure `module/core.js`'s `init(ctx)` allocates during THIS call lands in the ephemeral
   post-mark zone with NO root path to it. `regionHooks.exit(mark, root)` — confirmed via
   `module/core.js`'s own `__region_exit` body and its own comment ("the walk below is a
   Cheney-copy over EVERYTHING reachable from `root`... EVERY exit that reaches a pointer-keyed
   Map/Set rebuilds it FRESH") — compacts survivors down to `[mark, mark+size)` and resets
   `$__heap` there, abandoning everything else. `ctx.core.emit`/`ctx.core.stdlib` (the CONTAINER
   objects, allocated once at `reset()`, pre-mark, durable) survive with their identity intact —
   but every property VALUE `init(ctx)` just wrote (the closures) now points into abandoned,
   soon-to-be-reused memory. Reading `ctx.core.emit[name]` anywhere downstream (constantly, for
   the REST of the compile — emit.js, compileAst, etc. all dispatch through it) returns a stale
   pointer; CALLING it (`call_indirect` through a garbage function-table index / corrupted
   captured env) is undefined behavior — fully consistent with an unrelated-looking `.length`
   read on a nullish receiver surfacing deep in `$__length`'s own guard (Finding 1, above): a
   corrupted dispatch can land anywhere.

5. **Why front's round specifically, and why even the trivial `sum` program deterministically**:
   front's round is the FIRST region round in the whole pipeline (`emitIR`'s own, later, EMISSION
   round — Slice 3 — only starts after `front()` fully returns). `includeModule`'s guard means
   'core' only ever gets registered ONCE per compile — so by the time EMISSION's round begins,
   'core' (and whatever other modules the source needed) are ALREADY loaded, and EMISSION's round
   rarely if ever triggers a NEW module load — which is presumably why EMISSION's round measures
   as "GATE-CLEAN" at the scales tested even though it excludes `ctx.core` too. Front's round is
   uniquely exposed because `prepare()`'s unconditional `includeModule('core')` is GUARANTEED to
   be the first-ever load of the largest stdlib module, and it is guaranteed to happen mid-round.
   This requires no throw/array/string/freeze/etc. in the source — `sum = (a,b) => a+b` triggers
   it just by calling `prepare()` at all, explaining the deterministic O0/O2/O3 failure on the
   simplest possible AGREE-tier program.

**Verified clean (not implicated)**: grepped `jzify/*.js`, `src/prepare/lift-iife.js`, and
`src/parse.js` for `includeModule`/`includeMods`/`ctx.core`/`ctx.bridge`/`ctx.abi` — zero matches
in all three. Only `src/prepare/index.js` (via `prepare()` itself, `includeModule('core')` at
line 800, plus many other CONDITIONAL `includeModule(mod)` call sites keyed to specific syntax —
throw/freeze/array/etc. — none of which fire for `sum` specifically, confirmed earlier this
session by checking each one's trigger condition) touches these fields during front's round. So
the OTHER two front.js writes found earlier this session (`ctx.error.loc = node.loc` at
prepare/index.js:1400, and `ctx.features.errorClasses`/`ctx.runtime.frozenVars` at 1294/1324/3377)
are real instances of the SAME general excluded-field-write pattern but are NOT the trigger for
`sum` specifically: `node.loc` is confirmed a plain NUMBER (subscript's parser sets
`node.loc = at`, a character offset — `src/ctx.js`'s own `ctx.error.src.slice(0, ctx.error.loc)`
usage confirms the numeric-offset shape), so copying it is not a pointer hazard; the
errorClasses/frozenVars Set-writes need `throw`/`Object.freeze` syntax absent from `sum`. They
remain real (general-case) instances of the same bug CLASS and should still be fixed by whatever
general mechanism closes `includeModule('core')`'s hole, just not the specific trigger diagnosed
here.

**Not yet empirically confirmed with a kernel build** (this section is 100% static-analysis-
derived) — proceeding now to implement the fix (module registration hoisted before `mark()`,
NOT rooting `ctx.core` — that path is foreclosed by 7085cb57) and verify with one region-enabled
kernel build + the full battery.

## FRONT'S ROUND FIX — CONFIRMED AND LANDED (2026-08-28); emitIR's round has a SEPARATE, still-open bug

Empirically confirmed the root-cause hypothesis above with a real region-enabled kernel build
(not just static reading) and landed the fix. Two commits on this branch:

- `e726b884` — reverted the streaming-encoder prototype wiring in `scripts/self.js` (Strategy-B
  measurement rig from a prior session, `abc17d1b`/commit history). That prototype has its OWN
  independent, unresolved correctness bug with the IDENTICAL `decodeThrown`/TypeError-wrong-
  object-shape signature (documented above under "CRITICAL CAVEAT"). Building region-hooks test
  kernels with it still wired in would conflate two unresolved bugs and make every kernel-oracle/
  kernel-parity number in this section ambiguous. Purely a test-isolation cleanup — no functional
  change beyond removing the throwaway absolute-path import and `{streamCode:true}`.
- `88e48378` — the actual fix: `src/front.js`'s `frontHalf` now calls
  `includeMods('math', 'core', 'array', 'object', 'string', 'number', 'fn', 'typedarray',
  'collection', 'symbol', 'console', 'json', 'regex', 'timer', 'date', 'simd', 'atomics', 'fs',
  'web', 'crypto', 'navigator')` (every name in `module/index.js`'s export list, gated on
  `regionHooks` truthy) as the FIRST statement, BEFORE `regionHooks?.mark()`. This forces every
  stdlib module's `init(ctx)` — the ONLY code that populates `ctx.core.emit`/`ctx.core.stdlib`
  for the first time — to run pre-mark, so it's durable, regardless of which module
  `prepare()`'s own `includeModule('core')` (unconditional, prepare/index.js:800) or its several
  source-dependent `includeModule(mod)` branches would otherwise have first-loaded mid-round.
  `includeModule`'s own idempotency guard (`ctx.module.modules[modName]`) makes every later call
  a no-op once `mark()` fires, so this is a pure reordering, not a new allocation pattern.

  Implementation note for future readers: the first attempt used
  `import * as stdlibModules from '../module/index.js'` + `for (const name in stdlibModules)`.
  This FAILED AT NATIVE SELF-COMPILE TIME with `'stdlibModules' is not in scope` — jz's self-
  compilable subset has no runtime object backing a namespace import (`import * as X` erases to
  compile-time bindings, not a reified enumerable object), so `for...in` over one is a compile-
  time error, not a runtime one. Fixed by naming the 21 modules literally via the EXISTING
  `includeMods(...)` helper (the same pattern already used elsewhere in this codebase, e.g.
  `includeMods('core', 'fn')`) — proven to compile. The literal list must be kept in sync with
  `module/index.js`'s own export list by hand (that file's own header comment already says
  "Adding a stdlib module = add its import + name here, nothing else" — mirror any addition into
  `front.js` too now).

### Empirical proof (bisection), region-enabled kernel, `JZ_SELF_COMPILE_OPT=0` (~95-100s/build)

Method: scripts/self.js's three `regionHooks` call sites (`optimizeTail`, `front`, `emitIR`) can
each be independently forced to `regionHooks: undefined`, isolating which region round is
active — the same bisection technique the prior session used for Finding 2.

1. **Front's round ALONE** (optimizeTail's and emitIR's forced `undefined`; front's fix in
   place): `node test/kernel-oracle.js` → **11/14 pass, 575 assertions run** (up from 36 before
   any fix — the corruption previously aborted the AGREE-tier loop on its first row, `sum`, so
   almost nothing downstream ever ran). `sum`, `math`, `dict`, `arr`, `mfold`, `nestedtyped`,
   `fromnested`, subnormal, heterogeneous-BigInt, ternary (all `is`/`throws` execution
   assertions) — ALL GREEN, at O0/O2/O3, natively AND through the kernel. **The only 3 failures
   are `kernel parity: byte-identical WAT` at O0/O2/O3**, reporting a benign SIZE divergence
   ("sum O0: diverges (native 642B vs kernel 923B)") — not a crash, not a value mismatch — an
   expected artifact of running with 2 of 3 region rounds forcibly disabled for this bisection
   (kernel WAT naturally differs in shape from a build with only 1 of its normal 3 rounds live).
   This is unambiguous, direct confirmation: front's round, run alone with the fix, is sound —
   the ORIGINAL `sum`-at-O0/O2/O3 crash this whole investigation chased is CLOSED for front's
   round specifically.

2. **Front's (fixed) + emitIR's rounds, optimizeTail's forced off**: same crash reproduces
   IDENTICALLY (2/14 pass, 36 assertions, `KERNEL FAIL ROW: sum`, same
   `$__throw_property_nullish`-shaped TypeError). Isolates the REMAINING bug to emitIR's round
   (`compileAst`'s own mark/exit, Slice 3, `src/compile/index.js`) — ruling OUT optimizeTail's
   round (`watrTail`) as the O0 cause. This is a new, more precise finding than what self.js's
   own pre-session comments documented (those attributed the ONLY known region-hooks failures to
   `optimizeTail`'s round specifically, at O2/O3 only, via `dvnested-mechanism` — a DIFFERENT,
   more complex source; this session's `sum`-at-O0 failure is a broader, previously-undocumented
   instance in a DIFFERENT round).

3. **All three rounds active** (real, unforced `REGION_HOOKS_ACTIVE` ternaries): same crash as
   #2 — 2/14 pass, 36 assertions. Confirms optimizeTail's round is inert/uninvolved for this
   specific repro (consistent with #2) and that the fix from step 1 is necessary but not
   sufficient for the FULL battery.

**Conclusion: front's round is fixed and proven sound in isolation. emitIR's round
(`src/compile/index.js`'s `compile()`) has a SEPARATE, NOT-YET-ROOT-CAUSED bug, structurally
independent of front's fix and of optimizeTail's round.** `REGION_HOOKS_ACTIVE` stays `false` —
the full battery is not green with it on, per the mandate not to flip the default without that.

### emitIR's round — precise starting point for whoever continues this

`compile()` (`src/compile/index.js:2274`) is NOT one region round — it is roughly 1150 lines
containing SIX-plus nested `mark()`/`exit()` pairs, plus `plan()`'s own 5 further internal
rounds (called at line 2395, `src/compile/plan/index.js`, not examined this session):

- SCAN round: mark `~2405`, exit `~2434-2436` (root: `[ast, programFacts, ctx.funcs, ctx.module,
  ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.func,
  ctx.transform, ctx.facts]` — the SAME narrower 12-ish-field union front.js used, NOT the wider
  one `emissionRoundExit` proved necessary — worth checking whether this round ALSO needs
  `ctx.runtime`/`ctx.memory`/`ctx.error`/`ctx.linkDemand`/`ctx.names`/`ctx.features`, by the exact
  same reasoning as front's fix. This is the MOST PROMISING next lead — it is structurally
  IDENTICAL to front's bug (same narrow root list) and runs very early (right after `plan()`),
  so a fresh `sum`-scale compile would reach it almost immediately).
- AFE (analyzeFuncs) round: mark inside the loop `~2488`, batched exit `~2496-2507` (same root
  list as SCAN's).
- `emissionRoundExit` helper (`~2570`) + its first user, `emitFuncs`'s `closeRound` (`~2645-2655`,
  exit at `~2650-2651`) — the WIDE, already-audited root (`ast, programFacts, out, ctx.funcs,
  ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect,
  ctx.func, ctx.transform, ctx.facts, ctx.runtime, ctx.memory, ctx.error, ctx.linkDemand,
  ctx.names, ctx.features, ctx.core.includes, ctx.core.extImports, ctx.core.jsstring,
  ctx.core.hostGlobals, ctx.core.stdlibDeps`) — this round ALSO explicitly documents its own
  "KNOWN OPEN ISSUE" but SCOPES it to "jz×jz scale only" (self-compiling the whole compiler,
  2234 functions) — `sum` (1 function) is nowhere near that scale, so this specific documented
  issue is unlikely to be `sum`'s trigger, though not formally ruled out this session.
- `CLOSURE_ROUNDS_ACTIVE` (`~2480`): already `false` (permanently disabled, pre-existing,
  unrelated to this session) — inert, not a candidate.
- `__buildMark` round: mark `~2818`, exit `~2820-2822` (same `emissionRoundExit` wide root).
- `__stdlibMark` round: mark `~2944`, exit `~2977-2979`, wrapping `pullStdlib(sec)` +
  `ensureThrowRuntime(sec)`. Examined this session — looks carefully reasoned (its own comment:
  "`ensureThrowRuntime`'s one post-pullStdlib read of `ctx.core.stdlib`... is closed by
  reordering, not rooting" — and the read DOES run before this round's own exit at line 2978, so
  that specific concern is already closed). No obvious gap found on inspection, but not
  exhaustively audited.
- Outermost round (`__regionMark` at `2275`, exit at `3376-3416` — the `releaseSession` branch,
  confirmed ACTIVE for THIS repro since `scripts/self.js`'s `emitIR` passes
  `releaseSession: true`; the alternate `else if (regionHooks)` branch at `3417-3419` is NOT
  reached in this configuration). Root is a hand-built `released` object exposing
  `transform, funcs.list.length, scope.{...6 fields}, types.{2 fields}, schema.list,
  ctx.core.includes, ctx.core.diagSink, warnings, tail` — deliberately narrow, well-commented,
  explicitly excludes `ctx.core`/`ctx.bridge` wholesale by the same established reasoning. No
  obvious gap found on inspection, but not exhaustively audited.

**A REAL, but CONFIRMED-NOT-the-`sum`-trigger, additional instance of the SAME bug class**: three
more mid-round writes into `ctx.core.stdlib[...]` (a PLAIN STRING each time, template literals
evaluated immediately — not a closure/thunk like some module-init-time stdlib entries, so
rooting just these specific dynamic entries would not hit the "closure-valued, not proven safe"
wall front.js's fix had to route around) were found at:
- `src/compile/emit.js:293` (`builtinFunctionValue` — fires when a builtin function like
  `Math.sqrt` is referenced AS A VALUE, not called directly).
- `src/compile/emit.js:7931` (multi-result-function call trampoline).
- `src/compile/emit.js:7958` (single-result forwarding trampoline, context not fully read this
  session).
Checked each trigger condition: NONE fire for `sum = (a, b) => a + b` (no builtin-as-value, no
multi-result function, no dynamic forwarding call in that source) — so these are NOT what crashes
`sum` specifically, but ARE a real, live instance of "code writes into wholesale-excluded
`ctx.core.stdlib` mid-round" for OTHER programs, worth fixing once the `sum` trigger itself is
found (same architecture question as front's fix, but these entries are emitted DYNAMICALLY per
call-site — cannot be hoisted pre-mark the way module registration was, since they don't exist
until emission actually happens; the correct fix here is more likely an "escape into a rooted
sidecar accumulator, reconciled back into `ctx.core.stdlib` once durable again" pattern — option
(c) from the original task framing — not attempted this session).

**Next step for whoever continues**: build a region-enabled kernel (`JZ_SELF_COMPILE_OPT=0` for
~100s iteration), reproduce with `node test/kernel-oracle.js` (still fails on `sum` with all 3
rounds active), then bisect WITHIN `compile()` by temporarily forcing individual `mark()`/`exit()`
pairs off one at a time (SCAN, AFE, emitFuncs's closeRound, `__buildMark`, `__stdlibMark`, the
outermost `releaseSession` exit, and `plan()`'s own regionHooks argument at line 2395) the same
way this session bisected the THREE outer call sites in self.js — starting with the SCAN round
(`~2405-2436`) as the most promising lead, since it uses the SAME narrower root-field list front's
round originally had, before this session's fix widened front's.

### Final battery (dormant, `REGION_HOOKS_ACTIVE=false`, production/default build — `node
scripts/self-compile-build.mjs`, no `JZ_SELF_COMPILE_OPT` override, i.e. the real O3 self-compile
that actually ships): 304.4s, 17,868,354 bytes (baseline doc above: 320s, 17,867,935 bytes — a
419-byte difference, well within noise from unrelated source-comment growth elsewhere in the
tree; confirms front.js's new eager-load line is correctly inert when `regionHooks` is falsy,
zero behavior change on the shipped path).

- `node test/kernel-oracle.js`: **14/14 pass, 605 assertions** — exact match to the documented
  clean baseline.
- `node test/kernel-parity.js`: **3/3 pass, 33/33 assertions** — exact match to the task's
  expected number.
- `JZ_TEST_TARGET=jz.wasm node test/index.js`: running in background at the point these notes
  were written; result to be appended once it completes.

## emitIR's round — ISOLATED to `__stdlibMark` (2026-08-28, new session, worktree feat/region-emitir-round @ 21bcfc57)

Continuing "emitIR's round — precise starting point for whoever continues this" above. Built
ONE diagnostic kernel instead of bisecting via many rebuilds: `src/compile/index.js`'s six-plus
nested mark/exit pairs (SCAN, AFE, emitFuncs's closeRound, `__buildMark`, `__stdlibMark`, the
outermost `releaseSession` exit) PLUS `plan()`'s own regionHooks passthrough and
`optimizeModule`'s regionHooks passthrough (both previously unexamined) were each gated behind
one bit of a NEW runtime-readable bitmask (`ctx.transform._dbgRoundMask`, default `~0` when
unset — every real call path, including every existing test, is behaviorally identical to
before: `__rh(bit) = (regionHooks && (__M & bit)) ? regionHooks : null` always resolves to the
original `regionHooks` when the mask is untouched). `scripts/self.js` gained one throwaway
export, `__dbgCompile(mask, source, strict, optJSON, modulesJSON, host)`, which sets
`ctx.transform._dbgRoundMask = mask` right after `setupSelf`'s reset (so it survives) and then
runs the normal pipeline. `REGION_HOOKS_ACTIVE` flipped `true` for this build only. ONE
`JZ_SELF_COMPILE_OPT=0` build (93s, 13,474,175 bytes) then supported EIGHT single-round-off
probes per optimize level with NO rebuild between them — just different `mask` arguments to the
same wasm export, via a small script
(`/private/tmp/claude-501/-Users-div-projects-jz/0482f00a-7cbc-475b-939a-b25b5ba26704/scratchpad/diag-mask.mjs`).

Bit map: 1=SCAN 2=AFE 4=emitFuncs 8=`__buildMark` 16=`__stdlibMark` 32=outermost
`releaseSession` 64=`plan()`'s own rounds 128=`optimizeModule`'s round. 255=all on (matches
production shape, since `REGION_HOOKS_ACTIVE=true` plus the unmodified front-fix and
`optimizeTail` ternaries in self.js means every OTHER region boundary is live exactly as
production would run it).

**Result — clean and identical across all three tested optimize levels (0, 2, 3), using the
REAL kernel-oracle/kernel-parity `sum` corpus source (`export let sum = (n) => { let s = 0; for
(let i = 0; i < n; i++) s += i; return s }`, not the simplified `a+b` form the prior session's
repro used):** mask=255 (all on) fails with the identical `Cannot read properties of undefined`
/ `TypeError` signature at every opt level. Every single-bit-off probe ALSO still fails
identically EXCEPT mask=239 (bit 16, `__stdlibMark`, off) — that one alone passes cleanly (valid
wasm module, non-trivial byte length) at O0, O2, AND O3. This isolates the entire remaining
emitIR-round bug to `__stdlibMark`'s root specifically (wrapping `pullStdlib(sec)` +
`ensureThrowRuntime(sec)`, `src/compile/index.js` ~2944-2991) — SCAN, AFE, emitFuncs,
`__buildMark`, the outermost exit, `plan()`'s own rounds, and `optimizeModule`'s round are all
now RULED OUT as the (sole) cause for this repro: forcing any one of them off alone does not
clear the crash, so none of them is independently sufficient to trigger it, and `__stdlibMark`
being off is both necessary and sufficient to clear it for this repro.

**Leading candidate, found by reading `resolveIncludes()` (`src/ctx.js:272`, called
unconditionally as the first line of `pullStdlib`, `src/wat/assemble.js:825`) immediately after
the isolation above — NOT YET EMPIRICALLY CONFIRMED as the specific trigger:**
`ctx.core._autoDeps ??= new Map()` (`src/ctx.js:286`) lazily creates a Map DIRECTLY on `ctx.core`
the first time `resolveIncludes()` runs. `__stdlibMark`'s root
(`[lateSections, lateFacts, lateScope, lateTypes, lateSchema, ctx.transform, ctx.runtime,
ctx.memory, ctx.core.includes, ctx.warnings]` + the DOLLAR/stdlibParseCache externs) roots only
`ctx.core.includes` — never `ctx.core._autoDeps`, which isn't part of ANY previously-documented
excluded-field inventory (`ctx.core.emit`/`.stdlib`/`.bridge`/`.abi` — this is a THIRD, previously
un-flagged `ctx.core` hazard, structurally the same class as those but a plain memo Map, not a
closure dict). If `ctx.core._autoDeps` is created for the FIRST time here (post-`__stdlibMark`
mark), its own backing storage is ephemeral and unrooted exactly like front's original bug's
`ctx.core.emit`/`.stdlib` writes. Not yet confirmed whether anything reads `ctx.core._autoDeps`
again in a way that surfaces the corruption WITHIN one compile (as opposed to only across a warm
`_clear`-reuse) — this is the next concrete thing to check: (a) grep every other
`resolveIncludes()` call site (a second one exists inside `pullStdlib`'s `needsAlloc` branch,
`src/wat/assemble.js` ~922, "Late-add of allocators... re-resolve") and confirm both are
purely within-round (they are, both live inside the same `pullStdlib` call); (b) determine
whether the Map itself (as opposed to entries it deposits into `ctx.core.includes`, which IS
rooted and should relocate fine) is EVER read again after this round's exit within the SAME
compile — if not, this specific field may be a real-but-inert latent hazard (matters for warm
multi-compile reuse, not this single-compile repro) and the ACTUAL `sum` trigger is still
elsewhere inside `pullStdlib`/`ensureThrowRuntime`/`declGlobal`. `ensureThrowRuntime` itself
(`src/compile/index.js:260-276`) was read in full and looks safe on inspection (`ctx.runtime.throws`
is a scalar; `declGlobal`'s writes land in `ctx.scope.globals`/`globalTypes`, both aliased
into the round's `lateScope`; `sec.tags.push` mutates the array aliased into `lateSections.tags`)
— NOT yet ruled out with full confidence (`declGlobal`'s own full body wasn't re-read this
session), but `ctx.core._autoDeps` is the stronger lead: it is a wholly new allocation directly
off the permanently-excluded `ctx.core` receiver, matching the exact shape of every other
confirmed instance of this bug class in this investigation.

**Instrumentation currently on this branch (throwaway, NOT a candidate fix, must be fully
reverted before any battery run or merge)**: `scripts/self.js` — `REGION_HOOKS_ACTIVE` forced
`true`, one new export `__dbgCompile`. `src/compile/index.js` — `__M`/`__rh` bitmask gate defined
at the top of `compile()`, threaded through all 8 round-boundary call sites (`__rh(1)` through
`__rh(128)`) in place of the bare `regionHooks` truthy-checks; `plan(ast, profiler, regionHooks)`
call became `plan(ast, profiler, __rh(64))`; `optimizeModule`'s regionHooks-wrapper ternary
condition became `__rh(128)`. Every `regionHooks.mark()`/`.exit(...)` CALL itself (as opposed to
the guard condition) is untouched — only entry conditions changed — so with the mask unset or
all-bits-set this is byte-for-byte the pre-existing control flow. Diagnostic kernel at
`dist/jz.wasm` in this worktree (13,474,175 bytes, O0) is ALSO throwaway (built with
`REGION_HOOKS_ACTIVE=true`, not the production default) — do not confuse it with a battery
artifact. Probe script: `/private/tmp/claude-501/-Users-div-projects-jz/0482f00a-7cbc-475b-939a-b25b5ba26704/scratchpad/diag-mask.mjs`.

## ROOT CAUSE CONFIRMED AND FIXED (2026-08-28, same session) — `lateSchema` snapshot dropped `namedUses`

`ctx.core._autoDeps` was empirically ruled out: pre-seeding it durably (moving `new Map()` into
the `ctx.core = {...}` literal in `reset()`, `src/ctx.js`) and rebuilding did NOT clear the
mask=255 crash — identical failure at O0/O2/O3. Reverted that test (zero net diff on `src/ctx.js`
now). `ctx.core.extImports` was independently ruled out by static reading: it's already durably
created in `reset()` (`src/ctx.js:422`, contrary to this section's earlier suspicion that its
`??=` in `pullStdlib` was a first-creation site), and nothing anywhere in the codebase reads it
back after `pullStdlib` writes it, so a stale reference to it could never surface.

**The real bug**, found by re-reading the ~430-line span between `__stdlibMark`'s exit and the
outermost exit (since disabling the OUTERMOST round alone did NOT clear the crash, the
corruption had to already be complete by the time `__stdlibMark` itself exits, or manifest in
that immediately-following span): `src/compile/index.js`'s `__stdlibMark` exit narrows
`ctx.schema` to `let lateSchema = { list: ctx.schema.list }` — dropping `ctx.schema.namedUses`,
a real, always-initialized (`src/ctx.js:567`, `namedUses: []`) plain-data array of `{sid,
funcName}` pairs that `module/core.js:2794` (`__throw_property_nullish` — the SAME helper whose
thrown TypeError this entire investigation has been chasing since the very first repro) and
`module/json.js:1386` `.push()` onto, unconditionally/eagerly for essentially every compile
(the doc comment at `ctx.schema`'s init: "TypeError… mint[ed] eagerly and unconditionally the
moment either is visited during emission"). Once `ctx.schema = lateSchema` replaces the whole
object post-exit, `src/compile/index.js`'s own usedSchemaIds walk — `if
(ctx.schema.namedUses.length) { … for (const {sid, funcName} of ctx.schema.namedUses) … }`,
~40 lines later, UNCONDITIONALLY reached by every compile, well before the outermost exit —
reads `.length` off `undefined`. Exact match to the `$__throw_property_nullish`-shaped
`Cannot read properties of undefined` TypeError this whole investigation (this session and the
prior one) has been chasing since the very first repro. Not a dangling-pointer/stale-relocation
bug at all (the region-arena copy/relocate machinery itself was never at fault anywhere in this
investigation) — a plain root-SNAPSHOT-completeness gap: `lateSchema` needed a THIRD field it
never carried.

**Fix** (`src/compile/index.js`, `__stdlibMark`'s round, ~line 2974): `lateSchema` now captures
`namedUses: ctx.schema.namedUses` alongside `list`, so it rides in the round's existing root
array (position 5) and gets relocated/rebound exactly like every other lateXXX snapshot — no new
root category, no wholesale `ctx.schema` inclusion beyond what was already there, purely widening
one existing snapshot object by one plain-data field (a small array of `{number, string}` pairs
— squarely inside the established "PLAIN-DATA FIELDS ONLY" doctrine this round's own comment
already states, not the excluded closure-dict class). The outermost round's OWN later
`released.schema = { list: ctx.schema.list }` (Slice 3's `releaseSession` branch) deliberately
stays narrower — confirmed by grep that nothing reads `ctx.schema.namedUses` anywhere after the
usedSchemaIds walk, so that later, even-narrower stub is correct as-is and needs no change.

**Empirically verified** with the SAME bitmask diagnostic kernel (one more `JZ_SELF_COMPILE_OPT=0`
rebuild, 90.7s, 13,474,383 bytes, mask/`__dbgCompile` scaffolding still in place at this point):
mask=255 (ALL region rounds active — the real production shape, since `REGION_HOOKS_ACTIVE=true`
plus the unmodified front-fix/`optimizeTail` ternaries mean every other boundary is live exactly
as production runs it) now compiles the real kernel-oracle/kernel-parity `sum` corpus source
cleanly at **O0, O2, AND O3** — first time this exact repro has passed with every region round
genuinely active. Diagnostic scaffolding (bitmask `__rh`/`__M`, `__dbgCompile`,
`REGION_HOOKS_ACTIVE=true`) now being reverted; the `lateSchema` fix itself is committed
separately and is the only source change intended to survive past this session's diagnostics.

**Superseded**: `ctx.core._autoDeps` is NOT the cause (empirically ruled out above) — the
paragraph that used to stand here proposing to root/reset it is retired; that finding remains
real (a memo Map created mid-round directly on the permanently-excluded `ctx.core` receiver,
never re-read after `__stdlibMark`'s exit within one compile so currently inert, same bug CLASS
as this session's confirmed fix but not itself load-bearing) and is left as a flagged, deferred
hygiene item for a future session, same treatment as `ctx.core.extImports`/`emit.js`'s three
dynamic `ctx.core.stdlib[name] = …` writes documented earlier in this file — none of these are
the `sum` trigger, all are real instances of "write into a permanently-excluded `ctx.core` field
mid-round" worth closing eventually, none blocked this session's fix.

### Battery with ALL rounds genuinely active (no bitmask, real O3 kernel, 246.7s, 15,782,676 bytes)

`node test/kernel-oracle.js`: **11/14 test-blocks pass, 575 assertions, 3 fail** — the 3 failures
are ALL "kernel parity: byte-identical WAT" (O0/O2/O3), reporting `sum O0: diverges (native 642B
vs kernel 923B)` etc. — IDENTICAL byte counts to what this file's own EARLIER "front's round
ALONE" bisection recorded (before this session, before emitIR's fix existed). Every AGREE-tier
EXECUTION assertion — `sum`, `math`, `dict`, `arr`, `mfold`, `nestedtyped`, `fromnested`, and
every other row this run reached — passes cleanly against the JS oracle, natively AND
in-kernel, at every optimize level: this session's fix is semantically sound with EVERY round
genuinely active, not just in isolation. `node test/kernel-parity.js` standalone: 3/3 FAIL, same
cause (the test wraps its whole per-optimize-level corpus loop in one `test()` call, and `is()`
throws on the first mismatch — `sum` being first in `CORPUS`, later rows never run).

**Root cause of the WAT-size divergence, CONFIRMED independent of this session's fix**:
`module/function.js`'s `init(ctx)` (called once per compile, the moment the `function`/`fn`
module loads) unconditionally does `ctx.closure.types.add(1) // presence triggers $ftN type
emission` — a Set that's checked for mere TRUTHINESS (`if (ctx.closure.types) {...}`,
`src/compile/index.js` ~2786) by the code that emits the closure-call `$ftN` type + the (possibly
zero-length, per `finalizeClosureTable`) closure table, regardless of whether the compile ever
actually creates a closure. A native (non-region) compile of `sum` never loads `fn` (nothing in
`sum` needs it) — but front's ALREADY-MERGED fix (this file, "FRONT'S ROUND FIX", `88e48378`)
eagerly `includeMods(...)`-loads ALL 21 stdlib modules, `fn` included, whenever `regionHooks` is
truthy, for EVERY compile regardless of guest content — necessarily for CORRECTNESS (that's what
closes the mid-round-registration bug). Diffing native vs kernel WAT for `sum` at O0 (dumped via
`compile(src,{wat:true})` / `compileViaKernel(src,{wat:true})`) confirms the `$sum` FUNCTION BODY
is byte-IDENTICAL between the two; the only difference is the kernel's extra `(type $ftN …)` +
`(table (export "__jz_table") 0 funcref)` preamble — dead scaffolding treeshake evidently doesn't
strip (type/table sections aren't reachability-pruned the way functions are). This is a genuine,
deterministic, MECHANICAL side effect of front's eager-module-load trade-off, predating this
session (the exact same 923B number was already on record before emitIR's round was touched at
all) — NOT a region-arena root-set/dangling-pointer defect, and NOT something this session's
`lateSchema` fix caused or can close by itself. Fixing it for real would mean making
`module/function.js`'s `$ftN`-emission trigger depend on an ACTUAL closure being minted (not mere
module presence) — a separate, non-trivial change to a DIFFERENT module's architecture, out of
this session's scope (apply the same root-set discipline to emitIR's round). Flagged, not fixed.

### Goal-probe with the `namedUses` fix alone (before the `errorSidEntries` fix above)

`goal-probe.mjs` (feeds the O3 hooks-on kernel its OWN `{code,modules}` graph, jz×jz):

```
region-fixed(hooks-on): TRAP "unreachable", peakBytes 3998613504, elapsedMs 601108, 163 modules
```

Compare baseline: TRAP at EXACTLY 4,294,967,296 B (the wasm32 ceiling), 10974ms. This run traps
at 3,998,613,504 B — **93.1% of the ceiling, not the ceiling itself** — after **601 seconds**
(vs baseline's 11s). Both numbers say the same thing: the compile is now doing dramatically more
real work (roughly 55x longer) before failing, and failing via a DIFFERENT mechanism (an
"unreachable" trap well short of the memory wall, not memory exhaustion at the wall) — consistent
with hitting the ALREADY-DOCUMENTED, jz×jz-SCALE-ONLY open issue this file's own earlier section
flags ("KNOWN OPEN ISSUE... deterministic 'memory access out of bounds'/'Cannot iterate null or
undefined' at peak 3059.38 MB" — a different peak number, different session, but the same class:
a defect that ONLY manifests at real self-compile scale, banked rather than chased in an earlier
session). This number predates the `errorSidEntries` fix above; re-measuring after it is a next
step, though that fix is very unlikely to change THIS mechanism (it closes a HOST-decode gap for
thrown Errors, not a peak-memory or in-kernel value-shape issue).

### Third battery leg (both fixes applied) — 25 fail (down from 49), one class investigated and OPEN

`JZ_TEST_TARGET=jz.wasm node test/index.js` with both fixes: **2949/2975 pass, 25 fail** (up from
2925/49 before the `errorSidEntries` fix — that fix alone closed ~24 of the previous 49,
consistent with it fixing the whole `SyntaxError`/`TypeError`/`RangeError`/`ReferenceError`/
`URIError`/`EvalError` × {new,bare} message-decode family plus related rows). Remaining 25:
1 pre-existing/unrelated (`const-exponent pow fold — SIMD twin`, present in BOTH the 49-fail and
25-fail runs, never investigated — orthogonal to this session's scope), plus 24 that group into
(at least) two DIFFERENT, NEWLY-DISTINGUISHED shapes once directly repro'd outside the full-suite
run:

**(a) Spurious host imports on a program that needs none** — `try/catch: non-throwing body emits
portable wasm` / `try/finally: ...` (`test/statements.js`): `compile(src, {host:'wasi'})` for
`() => { try { return 1 } catch (e) { return 2 } }` (nothing time/IO-related) natively produces
ZERO imports; the region-live kernel's output declares
`{module:"wasi_snapshot_preview1", name:"clock_time_get"}` — confirmed by dumping
`WebAssembly.Module.imports(...)` on both. Traced to `module/timer.js:79`'s `hostImport(...)`
call under `host==='wasi'` — plausible mechanism: front's ALREADY-MERGED eager-`includeMods(...)`
fix (`88e48378`) loads `timer` (and every other stdlib module) for EVERY region-live compile
regardless of whether the source uses timers, and this specific host import registration isn't
gated behind actual reachability the way stdlib HELPER functions are (`pullStdlib`'s own
`reachableStdlib` scan). Same general CLASS as the already-documented `$ftN`/closure-table
WAT-size divergence (`module/function.js`'s unconditional `ctx.closure.types.add(1)` on module
load) — a stdlib module's `init(ctx)` doing something UNCONDITIONAL that used to only ever run
for programs that actually needed that module, now running for every region-live compile because
eager-loading no longer correlates "module loaded" with "module's feature actually used".
NOT investigated to a confirmed fix — flagged, same as the closure-table case.

**(b) A compile-time rejection silently stops firing** — `unknown method on KNOWN receiver
rejects in default mode` (`test/errors.js:819`): `[3,1,2].frobnicate()` should reject at compile
with `'...frobnicate' is not implemented for a array receiver...'` — native throws this exactly;
the region-live kernel compiles it silently (confirmed via direct repro, both `compileViaKernel`
and native `compile` on the identical source). Traced the rejection's gate
(`src/compile/emit.js:4553` `externalMethodFallback`, tier 12 of the method-dispatch chain):
`const vt = valTypeOf(obj); if (vt != null && vt !== VAL.OBJECT && vt !== VAL.HASH) err(...)` —
this only fires when the receiver's type is PROVABLY a closed native kind (ARRAY here); `vt ===
null` or OBJECT/HASH falls through to a permissive dynamic-dispatch path instead. Did NOT
determine whether (i) `valTypeOf([3,1,2])` itself resolves differently under kernel/region-live
conditions (would be a genuinely serious, in-scope finding — `valTypeOf` is extremely
heavily-used elsewhere without failures, so a wholesale break seems unlikely, but not ruled out
for this one call shape) or (ii) an EARLIER dispatch tier (1-11, not read this session) now
intercepts `frobnicate` before tier 12's rejection is ever reached, plausibly for the same
eager-loading reason as (a). **OPEN — not root-caused, not fixed.** This is the one finding from
this session's battery run that could plausibly still be an in-scope region-arena
root-completeness gap rather than the eager-loading side effect class; whoever continues this
should start here, with a direct `valTypeOf(parse('[3,1,2]'))`-style unit probe run BOTH natively
and self-hosted before assuming it's the same eager-loading class as (a).

Neither this session's `namedUses` fix nor its `errorSidEntries` fix touches import registration,
method dispatch, or type inference at all (both are scoped entirely to the `jz:schema`/
`jz:errcls` custom-section builders) — structurally, neither fix CAN be the cause of (a) or (b).

**Consequence for the literal task targets**: `kernel-oracle.js 14/14` and `kernel-parity.js
33/33` are NOT reachable while front's eager-load trade-off stands, independent of anything in
emitIR's round — both test files abort their per-optimize-level loop on the FIRST byte-mismatch
(`sum`, first in `CORPUS`), never reaching the other 10 rows. The achieved, verified state is:
every row this session's fix allows the harness to REACH passes on EXECUTION correctness; the
harness just can't get past row 1's byte-count check to try the rest. This is reported honestly
rather than claimed as 14/14 / 33/33.

### Second bug found by the required battery — jz:errcls custom section silently skipped

`JZ_TEST_TARGET=jz.wasm node test/index.js` against the real O3 hooks-on kernel: **2925/2975
pass, 49 fail** (14190 assertions) — every failure is either an error-class message-decode row
(`SyntaxError`/`TypeError`/etc. "surfaces message", ~48 of the 49) or one unrelated SIMD
`pow_fold_v` row (not investigated, looks pre-existing/orthogonal). Isolated with a 6-line direct
repro (`throw new TypeError("bad TypeError")` through `compileViaKernel` + `instantiate`):
`e.thrown` decoded the underlying value CORRECTLY (`{message: 'bad TypeError', name:
'TypeError'}`) but `e.message` was `"[object Object]"` and `e` was a bare `Error`, not a
`TypeError` — the exact `decodeThrown`-fallback signature from earlier in this investigation,
meaning the raw {message,name} FIELDS were fine but the sid→class-NAME lookup (`jz:errcls`
custom section) never reached the host.

**Same bug class as `namedUses`, a SECOND missed field**: `src/compile/index.js`'s `jz:errcls`
custom-section builder (~line 3350, right after the `jz:schema` section) called
`ctx.schema.errorSidEntries?.().size` / `ctx.schema.errorSidEntries()` directly — but
`errorSidEntries` is a METHOD on the FULL `ctx.schema` object, and by this point in the
function `ctx.schema` has been the narrow `lateSchema = {list, namedUses}` stub since
`__stdlibMark`'s exit (no such method survives narrowing). The optional chain (`?.()`)
silently short-circuited the whole `.size` read to `undefined` — no throw, just SKIPPED the
entire `if` block, so NO `jz:errcls` section was ever emitted for ANY region-live compile.
Fix: `lateFacts.errorSidEntries` was ALREADY being captured as a plain resolved array (the
exact same `[...ctx.schema.errorSidEntries()]` call) BEFORE the narrowing — twice, in fact,
once pre-mark and once again right after `pullStdlib`/`ensureThrowRuntime` — for exactly this
kind of post-round consumption (matching `.rest`/`.ext`/`.i64`/`.hostAbi`/etc., every one of
which is already consumed via `lateFacts.X`, never by re-deriving through `ctx.X` post-narrowing).
The `jz:errcls` builder just wasn't following that already-established pattern. Changed both
reads to `lateFacts.errorSidEntries`/`.length`. Verified with a quick O0 kernel rebuild + the
same direct repro: `throw new TypeError(...)` now decodes to a real `TypeError` with the correct
message.

**Both fixes are the SAME conceptual bug, found the SAME way** (narrowing `ctx.schema` at
`__stdlibMark`'s exit drops something a LATER read still needs) — the second one only surfaced
because the FIRST fix let compiles run far enough to reach the `jz:errcls`-building code at all
(with the `namedUses` crash still in place, EVERY compile died before ever getting anywhere near
line 3350). This is exactly the pattern the task warned about: fixing one escaping-allocation
class can only ever prove the NEXT layer was untested, not that it's sound — worth remembering
for whoever continues this if a THIRD dropped-field bug turns up after these two.

**Actual next steps for this session**: (1) revert the bitmask/`__dbgCompile` diagnostic
scaffolding from `scripts/self.js` and `src/compile/index.js` (its job — localizing the bug — is
done; keep only the `lateSchema` fix). (2) Build a REAL region-enabled kernel the normal way
(`REGION_HOOKS_ACTIVE=true` in `scripts/self.js`, no bitmask) and run the full battery: `node
test/kernel-oracle.js` (target 14/14), `node test/kernel-parity.js` (target 33/33),
`JZ_TEST_TARGET=jz.wasm node test/index.js` (target 0 fail). (3) Revert
`REGION_HOOKS_ACTIVE` to `false` and confirm the dormant battery (native, kernel build, kernel-
target, parity, oracle, size gates) is still green — the `lateSchema` change is a pure no-op
when `regionHooks` is falsy (the whole `if (__rh(16))`/`if (regionHooks)` block it lives inside
never executes), so this is a sanity check, not expected to find anything. (4) If the full
hooks-on battery is green, measure the jz×jz self-compile goal-probe peak bytes (baseline traps
at exactly 4,294,967,296) and report the number regardless of outcome, per the task mandate.

## Session (2026-08-28, worktree fix/pure-stdlib-init @ d2c04d32) — pure-registration audit for the two open findings (a) OUTPUT-affecting init side effects, (b) kernel-vs-native REJECT divergence

Picking up the task mandate's two open items (both already isolated to eager-loading's side
effects, not region relocation itself). Built a NATIVE (no kernel, no region hooks) empirical
probe rather than auditing ~150 `inc()`/`declGlobal()`/`hostImport()` call sites by eye across
20 module files — cheaper, ground-truthed, and it's literally what the task's own required pin
needs anyway.

**Test infra landed** (`eabc8f9e`): `src/front.js`'s `frontHalf` now takes `eagerStdlib`,
independent of `regionHooks` — `if (regionHooks || eagerStdlib) includeAllMods()`. Wired from
`index.js`'s `jzCompileInner` via a new internal `opts._eagerStdlib` (never set by real callers,
same underscore-prefixed-internal-opt convention as `opts._interp`/`opts._compactCollections`).
This decouples "eager stdlib load" from region-arena's mark/exit machinery entirely — proving
"module load = registration only" is a general pipeline invariant, not something that needs a
real region round (or a fake passthrough regionHooks shim) to test. `compile(src, {..., opts})`
vs `compile(src, {...opts, _eagerStdlib:true})` on IDENTICAL source, diffed byte-for-byte, is the
exact native pin the task asked for ("compile a corpus with includeAllMods() forced vs default
and assert byte-identical wasm").

**Probe script** (scratchpad, not committed —
`/private/tmp/claude-501/-Users-div-projects-jz/0482f00a-7cbc-475b-939a-b25b5ba26704/scratchpad/eager-probe.mjs`):
hardcodes kernel-parity.js's 11-entry CORPUS (copy, NOT an import — importing test/kernel-parity.js
directly runs its top-level `tst` test blocks immediately, including a `compileViaKernel` call
that hung indefinitely with no kernel built in this worktree; costly false start, killed and
rewrote standalone). Compiles each entry lazy vs `_eagerStdlib:true` at `host:'js'` and
`host:'wasi'`, `optimize:0`, diffs byte length + raw bytes + `WebAssembly.Module.imports`.

### Empirical result: EVERY corpus entry diverges. Two distinct bug classes, not one.

```
[js]   sum:          78B → 111B   (+33, no import diff)
[js]   math:         53B → 86B    (+33)
[js]   dict:         29885B → 29954B (+69)
[js]   arr:          1401B → 1434B  (+33)
[js]   fold:         41B → 74B    (+33)
[js]   mfold:        41B → 78B    (+37)
[js]   boolconst:    247B → 280B  (+33)
[js]   nestedtyped:  1463B → 1496B (+33)
[js]   subviewtyped: 1007B → 1048B (+41)
[js]   fromnested:   719B → 752B  (+33)
[js]   dvnested:     764B → 25033B  — EAGER OUTPUT IS INVALID WASM, see below
[wasi] every entry:  same as [js] PLUS imports-onlyEager=[wasi_snapshot_preview1.clock_time_get]
                      and a further ~500B (sum 97B→626B, fold/mfold both 60B→589B, etc.)
```

**Class 1 — confirmed, matches the task's two named examples exactly.** The uniform ~33B `[js]`-
host delta (present on EVERY entry, including the numeric-only `sum`/`fold`/`mfold` that touch no
closure) is `module/function.js`'s `ctx.closure.types.add(1)` (init line 103, unconditional —
"presence triggers $ftN type emission", read in full this session: lines 79-101 first set up
`ctx.closure.types/table/bodies/envMeta` as empty containers if absent — harmless, matches the
"registration" doctrine — but line 103's `.add(1)` is a real, immediate, unconditional value
write with a directly documented output effect, not deferred into any handler). The extra
`wasi`-host ~500B + `clock_time_get` import on EVERY entry (even ones needing no timer) is
`module/timer.js`'s `setupWasi` (called unconditionally from `init(ctx)` whenever
`ctx.transform.targetProfile.wasiShims`, independent of source content) — read in full this
session (module/timer.js:62-287): unconditionally does `inc('__timer_init','__timer_tick',
'__timer_loop')` (forces those 3 stdlib funcs — and transitively their callee `__time_ns`, hence
the import — into `ctx.core.includes`, NOT reachability-gated the way `inc()` calls inside
`ctx.core.emit[name]=(...)=>{}` handlers naturally are), `hostImport('wasi_snapshot_preview1',
'clock_time_get',...)` directly (not deferred behind a `need*`-style thunk — contrast
`setupWasi`'s OWN sibling `setupJsHost`, which correctly defers every `hostImport` call behind
`needSetTimeout`/`needClearTimeout`/`needRaf`/`needCancelRaf` thunks only invoked from inside the
`ctx.core.emit['setTimeout']` etc. handlers — `setupWasi` is the ONE inconsistent branch in this
same file), and 3 unconditional `declGlobal('__timer_queue'|'__timer_next_id'|'__timer_count',
'i32')` calls. `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval`'s own emit handlers
(lines 251-278) ARE already correctly demand-gated (`inc('__timer_add'|'__timer_cancel')` fires
only inside the handler, i.e. only when the AST actually calls one) — only `setupWasi`'s OWN
top-level init side effects are the bug.

Confirms the general shape: registration helpers (`reg`/`bind`/`wat`/`registerGetter` — all write
only `ctx.core.emit`/`ctx.core.stdlib`, inert until reachability-marked) and `inc()`/`hostImport()`/
`declGlobal()` calls made FROM WITHIN a registered `ctx.core.emit[name]=(...)=>{}` handler body are
ALREADY correctly demand-driven regardless of eager/lazy module load — the handler only ever RUNS
when the compiler emits an actual call to that method in the real AST, so merely *registering* it
early (eager load) changes nothing observable. Read `module/navigator.js` and `module/web.js` in
full as a cross-check (both call `hostImport` — grep had flagged them): both are clean, textbook
demand-driven — `hostImport` sits inside the `ctx.core.emit[...]=()=>{...}` closure body in both
files, never at init top level. `module/crypto.js` read in full: also clean on the hot path
(`needEntropy`/`inc(...)` both fire only inside `bind('crypto.getRandomValues',...)`/
`bind('crypto.randomUUID',...)` handlers) — ONE narrow exception found: `declGlobal('crypto.state',
seedConst)` (line 35) is unconditional whenever `ctx.transform.randomSeed` is a number, regardless
of whether the source ever calls a crypto method — real instance of the same bug class, but gated
behind a rarely-used compile opt (`randomSeed`) rather than firing on every compile; lower priority,
flagged not yet fixed. The BUG (Class 1) is specifically: unconditional, non-deferred `inc()`/
`hostImport()`/`declGlobal()`/`ctx.closure.*`-value-write calls sitting directly in a module's
`init(ctx)` top level (or a helper it calls unconditionally, e.g. `setupWasi`), as opposed to
inside a lazily-invoked emit handler or `need*`-style thunk.

**Class 2 — NEW, more serious than anything the task named: `dvnested` (`(dv) => dv.setFloat64(
dv.getInt32(0), dv.getFloat64(8))`) produces genuinely INVALID wasm under eager load, not just
extra bytes.** `[js]` host: 764B (valid, 6 functions per `--wat` dump) → 25033B (52 functions) —
an 8.7× function-count blowup, not the ~33B closure-preamble constant seen on every other entry.
`WebAssembly.Module()` on the eager bytes throws at parse/validate time: `Compiling function #4
failed: not enough arguments on the stack for f64.convert_i32_s (need 1, got 0)`. Same signature
under `wasi` host. This is NOT "harmless extra dead scaffolding" (Class 1's shape) — it's a
STRUCTURALLY DIFFERENT, wrong code path being taken for the DataView receiver, one with a genuine
stack-imbalance codegen bug in it. Dumped both WATs (`--wat` dump, `/private/tmp/.../scratchpad/
dvnested-{lazy,eager}.wat`): lazy's `$f` body (line 199, ~170 lines) is a direct, typed DataView
emission — `$__ptr_offset`/`$__dv_index`/inline bounds checks/`$__bswap64`, no dynamic dispatch,
matches `module/typedarray.js`'s DataView get/set emitters read earlier this session. Have NOT
yet dumped eager's `$f` body (session paused before that read) — the leading hypothesis, by
elimination, is the SAME general class as the task's named finding (b) (`externalMethodFallback`'s
`valTypeOf` gate, src/compile/emit.js ~4553): eager-loading changes some type/dispatch resolution
so `dv`'s receiver type (or the `.getInt32`/`.setFloat64`/`.getFloat64` method resolution) falls
through to a generic/dynamic path instead of typedarray.js's direct typed emitter, and that
fallback path's DataView-shaped call has a real, independent stack-depth bug in it (plausibly
never exercised before because nothing previously reached dynamic dispatch for a DataView-typed
receiver — `dv`'s parameter type is provably DataView from the `new DataView`-shaped call site in
every existing test, so this exact receiver/dispatch combination may simply never have been
compiled via the fallback path before). **Not yet root-caused — this is the single most
promising lead connecting the task's two "open findings" into one mechanism** (eager-loading
perturbs `valTypeOf`/dispatch-tier resolution for at least one receiver shape) and should be the
next concrete step: dump eager's `$f` body, diff against lazy's, identify which dispatch tier
fires, then read `externalMethodFallback` (src/compile/emit.js ~4553) and whatever tier actually
intercepts `getInt32`/`setFloat64`/`getFloat64` under eager load to find why `valTypeOf(dv)` (or
an earlier tier) resolves differently now that ALL 21 modules are pre-loaded before `prepare()`
ever sees the source (module presence order / `ctx.module.modules` truthiness is the prime
suspect for WHAT changed, mirroring exactly how Class 1 bugs are keyed off "module loaded" instead
of "feature used" — this may be the SAME root confusion one level up: some dispatch tier keys off
"is module X loaded" as a proxy for "receiver type provably needs module X's emitter", which eager
load breaks the same way it breaks Class-1's "module loaded" ⇒ "feature used" correlation).

**Not yet done**: (1) root-cause Class 2 (dvnested/dispatch-tier) per the above — likely the same
mechanism as the task's finding (b), possibly the SAME fix closes both. (2) Fix Class 1's two
confirmed sites (function.js line 103, timer.js's `setupWasi`) by making them demand-driven —
NOT YET EDITED as of this note. (3) Re-run the native eager-probe corpus after fixes — expect
`[js]` deltas to drop to 0 for every non-dvnested entry, `[wasi]` deltas to drop to 0 for every
entry (timer fix), and `dvnested` to become valid+byte-identical once Class 2 is closed. (4)
Audit the REMAINING module-init `inc()`/`declGlobal()` call sites found by grep this session
(`atomics.js:69,118`; `array.js:207,356`; `collection.js` ~10 top-level sites; `object.js` ~10
top-level sites; `regex.js:30`; `symbol.js:31`; `typedarray.js:273`; `string.js:235`) that look
top-level-unconditional by indentation but were NOT individually confirmed clean or dirty this
session — the probe's `dict`/`arr`/`nestedtyped`/`subviewtyped`/`fromnested` entries already
exercise object/array/typedarray module loading and show ONLY the uniform Class-1 closure delta
(no EXTRA delta beyond +33/+41B), which is decent indirect evidence these particular sites are
harmless (their `inc()`-marked helpers are either already unconditionally pulled in by `core`
itself — `__mkptr`/`__alloc`/`__ptr_offset`/`__ptr_type`/`__len` are exactly core's own baseline
— or genuinely get treeshaken since nothing calls them) but NOT a proof for every module (`json`,
`date`, `regex`, `symbol`, `console`, `atomics`, `simd`, `fs` have no dedicated corpus entry
exercising "module loads but feature unused" yet). Widening the probe corpus to touch every
STDLIB entry at least once (one program using it, one program near-identical but not using it) is
the rigorous way to close this out; not done yet this session.

## Class 2 root-caused and fixed (`d1f4b585`) — dispatch-tier gates on "module loaded" instead of "actually demanded"

Bisected `dvnested`'s invalid-wasm case by shrinking `STDLIB` locally (uncommitted, reverted after)
to find the minimal eager-loaded set that still corrupts it: `['core','typedarray']` alone —
clean; adding `string` (which transitively also loads `number`, MOD_DEPS cycle) — corrupts. So
'string'+'number' loaded EAGERLY, with NOTHING in the source needing them, is sufficient.

Read `src/compile/emit.js`'s method-dispatch tier chain (`emitMethodCall`, tiers 1-12) end to end.
Found the actual mechanism, confirmed with throwaway `console.error` instrumentation (added and
fully removed before commit): **two dispatch tiers use "is `ctx.core.emit.str` truthy" / "is
`ctx.closure.call` truthy" (i.e. "has the `string`/`fn` module's registration run") as a PROXY for
"does the SOURCE actually need string/closure support"** — sound under lazy loading (a module
only registers in response to real content), silently wrong once eager preload registers every
module regardless of content:

- `tryGenericEmitter`'s own-property shadow probe (tier 10, emit.js ~4415, comment: "Gated on the
  string module... a string-less program has no user string props to shadow"): fires whenever
  `vt==null && ctx.closure.call && ctx.core.emit.str`, treating the receiver as possibly a plain
  object with an OWN property shadowing the builtin method name — a real ES-semantics concern for
  a genuinely-unproven receiver, but pointless (and, for DataView's `getInt32`/`setFloat64`/
  `getFloat64`, actively BUGGY — its own dynamic-property-probe IR has a stack-depth bug that lazy
  loading had simply never exercised, since nothing before this reached it for a DataView-typed
  receiver) once string+fn are ALWAYS loaded. This is `dvnested`'s trigger.
- `tryDynamicPropCall` (tier 11, emit.js ~4520, `if (ctx.closure.call)`): same shape — treats an
  unrecognized method as a possible dynamic closure-valued property whenever `fn` is loaded,
  regardless of whether the source ever created a closure. This is `[3,1,2].frobnicate()`'s
  trigger (the task's OWN named finding (b)) — confirmed via the same instrumentation: `vt` is
  correctly `'array'` in BOTH lazy and eager (valTypeOf itself is NOT the divergence, ruling out
  that half of the task's own open question), but under eager load `tryDynamicPropCall` intercepts
  the call BEFORE tier 12 (`externalMethodFallback`, the actual reject) is ever reached.

**Fix, same conceptual shape as every Class 1 fix**: `ctx.module` gains `demanded` (`src/ctx.js`
reset(), a `Set`) — module names ever passed to a REAL, AST-content-driven `includeModule()` call,
tracked SEPARATELY from `ctx.module.modules` (which just means "init(ctx) has run, for ANY
reason"). `src/autoload.js`: split the old `includeModule` body into `loadModule` (bare load
primitive — idempotent init(ctx) run, MOD_DEPS recursion, NO demand marking) and `includeModule`
(marks `ctx.module.demanded.add(modName)` UNCONDITIONALLY — even on the "already loaded" early
return, since demand and load-state are now different questions — then delegates to `loadModule`).
`includeAllMods()` (the eager bulk preload) now calls `loadModule` directly for every STDLIB name,
never `includeModule` — so eager preload is invisible to `demanded` by construction, exactly
matching the task's "module load = registration only" doctrine. The two dispatch tiers now
additionally require `ctx.module.demanded.has('string'|'fn')`, narrowing (never widening) their
existing truthiness checks — pure no-op under lazy loading, where `demanded` and "loaded" always
coincide (every load IS a real demand there).

**Verified**: `[3,1,2].frobnicate()` now rejects identically lazy vs eager (same error message).
`dvnested`'s OWN compiled `$f` function body is now byte-IDENTICAL IN SHAPE to native lazy output
(`--wat` diff — same `$__ptr_offset`/`$__dv_index`/inline-bounds-check sequence, confirmed by
direct read, not just byte-count) — the dispatch corruption itself is fully closed. The WHOLE
MODULE's byte count still diverges from lazy (159KB→ WAT text still ~15x lazy's, was ~23x before
this fix) — that remaining gap is Class 1 (unconditional `inc()`/registration in OTHER modules
inflating the function count; watr's treeshake isn't clearing all of it, or one of the
force-included-but-never-otherwise-reachable functions has its own latent bug) — NOT re-diagnosed
after this fix, next step for whoever continues if the Class 1 sweep below doesn't already close
it: re-run the `core+typedarray+string` bisection (this session's method) on the STILL-eager
CORPUS to confirm the residual delta is pure dead-scaffolding (valid wasm, just bigger) rather than
another correctness bug.

**Not yet done this session**: fix Class 1's two task-named sites (`module/function.js`'s
`ctx.closure.types.add(1)`, `module/timer.js`'s `setupWasi`'s unconditional `hostImport`/`inc`/
`declGlobal`) — found and root-caused in the earlier section above, NOT YET EDITED. Native full
test suite (`node test/index.js`) run started after this commit to confirm zero regressions from
the dispatch-tier narrowing before continuing — check its result before trusting this fix is
regression-free.

## Class 1 task-named sites fixed (`31ce2aa6`, `610d44c7`) — closure $ftN/table + WASI timer runtime

Both closed this session, both verified via the native byte-identity probe (real fix, not
speculative) — see each commit's own message for the full mechanism (summarized): `ctx.closure.
types.add(1)` moved from module/function.js's unconditional init into `ctx.closure.mint` (the
established single mint site); `src/compile/index.js`'s consumer changed `if (ctx.closure.types)`
(bare Set-object presence, always true once `fn` merely loads — the Set itself is created
unconditionally at init) to `if (ctx.closure.types?.size)`; `src/wat/assemble.js`'s
`finalizeClosureTable` changed its `call_indirect`-substring scan from `Object.values(ctx.core.
stdlib)` (every EVER-REGISTERED template) to only `ctx.core.includes`-reachable ones (calling
`resolveIncludes()` early — confirmed safe: a pure, monotonic, memoized fixpoint, and emission has
already finished by this call site per the very next line's own pre-assemble invariant checkpoint).
`module/timer.js`'s `setupWasi` extracted its four unconditional effects (the two `inc()`s, the
host import, the three `declGlobal`s) into `ensureWasiTimerRuntime()`, a lazy idempotent thunk
called from all four timer emit handlers — the same `needSetTimeout`-style pattern this file's own
`setupJsHost` sibling already used correctly.

Byte-identity probe, both fixes applied, full real corpus × both hosts:
`sum`/`math`/`arr`/`fold`/`boolconst`/`nestedtyped`/`fromnested` now byte-IDENTICAL eager vs lazy
at BOTH `host:'js'` and `host:'wasi'` (were diverging on every single entry before this session).
Remaining, NOT fixed this session: `dict`/`mfold`/`subviewtyped` diverge by a handful of bytes
(4-69B) at both hosts — traced (mfold) to a pre-existing, unrelated representation/narrowing
difference (execution-CORRECT: `g()` still returns `5` under eager load, via an i32-then-
`f64.convert_i32_s` wrapper instead of preEval's plain folded f64 constant — so this is a
kernel-parity BYTE gap, not a correctness bug) — not root-caused for `dict`/`subviewtyped`
specifically, likely the same class. `dvnested` is WORSE than a byte gap: **still genuininely
INVALID wasm** under eager load (`WebAssembly.Module()` rejects it) even after every fix above.

### `dvnested` residual — narrowed further, NOT closed, real remaining risk

Re-bisected with ALL of this session's fixes applied (temporarily shrinking `src/autoload.js`'s
`STDLIB` locally, same technique as the Class-2 bisection above, reverted after — confirmed
`git diff src/autoload.js` empty before moving on each time): **`['core','typedarray','string']`
alone still produces invalid wasm** — same `f64.convert_i32_s` stack-imbalance signature. Since
the Class-2 dispatch fix (`d1f4b585`) already proved `dvnested`'s OWN `$f` function body compiles
byte-identically to native once `ctx.module.demanded` correctly excludes 'string'/'fn' from the
shadow-probe/dynamic-dispatch gates, **the remaining corruption is in a DIFFERENT function, not
`$f` itself** — confirmed by locating the WAT function WebAssembly's own error names: with
`STDLIB=['core','typedarray','string']`, the parse error moved from "function #4" (this session's
earlier, pre-Class-2-fix state) to "function #33" — counting `(func $name` declarations in
document order (0 imports for this host:'js' repro), index 33 (0-indexed) lands on `$f` itself
again by one counting convention, but `$f`'s own body (read directly) is the SAME correct shape
confirmed clean in the Class-2 section above (no `$__dyn_get_expr`/`call_indirect` — direct
`$__dv_index` dispatch) — the WASM engine's own function-index numbering (which counts only
CODE-SECTION-local functions, possibly 1-indexed, disagreeing with a raw doc-order func count) was
NOT successfully resolved to a specific culprit this session; `$__clear` (a 3-line, obviously
correct function) sits at the position one plausible indexing convention pointed to, ruling that
convention out too. **Genuinely not localized to a specific function this session** — this is the
one open item most worth a fresh pair of eyes.

**Leading hypothesis, not confirmed**: the extra ~20KB of eagerly-pulled-in code for this minimal
repro is dominated by `number`/`string`'s own float-to-decimal machinery (`__ftoa`,
`__ftoa_shortest`, `__dec_to_f64`, the four `__ryu_*` helpers, `__pow10`, `__itoa`) — none of
which `dvnested`'s DataView-only source has any real use for. These are almost certainly reached
NOT via any module's own unconditional top-level `inc()` (audited: neither `module/number.js` nor
`module/string.js` has one comparable to function.js's/timer.js's fixed sites — `string.js:235`'s
`inc('__mkptr','__alloc')` is the one top-level call found, and those two are trivially-correct
foundational core helpers, not plausible bug sites) but TRANSITIVELY, via `resolveIncludes()`'s
own auto-dep scan (src/ctx.js `autoDepsOf`, matches `$__[A-Za-z0-9_]+` inside every stdlib template
already included) chaining from some broadly-used, genuinely-reachable-for-almost-any-string-using-
program helper like `$__to_str` — i.e. the SAME general shape as this session's two confirmed
fixes (a check that can't distinguish "reachable because genuinely needed" from "reachable because
eager-loaded neighbors dragged it in transitively"), just one level deeper in the dependency graph
than either fix reached. **Not verified — the auto-dep chain from whatever triggers `$__to_str`
(or whichever helper is the actual entry point) down to the RYU cluster was not traced this
session.** Whoever continues: re-run this section's bisection (`STDLIB=['core','typedarray',
'string']`, revert after via `git show HEAD:src/autoload.js > src/autoload.js`), get the WAT dump
via a `{wat:true, optimize:0}` compile, and this time identify the broken function by BINARY
offset (the error names a byte offset — `@+8888` etc. — decode the actual `.wasm` bytes' code
section function boundaries directly, e.g. via `wasm-tools objdump`/`wasm2wat` if available in the
sandbox, rather than trusting a WAT-text function-declaration ORDER count against the engine's own
internal numbering, which this session never got to agree with either "0-indexed, no imports" or
"1-indexed" — neither landed on a plausible culprit).

**Consequence for the task's literal targets**: this is NOT yet the "everything demand-driven,
zero observable output/validity effect from loading a module" state the task's conceptual fix
demands — a genuinely INVALID module for at least one real program shape is a correctness risk,
not just a size nit. The native byte-identity pin below deliberately does NOT assert
`dvnested`-shaped byte-identity or even validity under eager load — see the pin file's own
`[known-gap]`-style comment — so it stays green while this is tracked, rather than silently
skipping coverage of everything ELSE that IS fixed.

## Pin landed (`80ec0155`), then a real regression caught by the pin's own parent suite (`72eddaee`)

`test/eager-stdlib-parity.js` landed — the native byte-identity pin the task asked for
(`compile(src,opts)` vs `compile(src,{...opts,_eagerStdlib:true})`, diffed, over kernel-parity's
CORPUS at both hosts; frobnicate reject-pin included). Standalone (`node test/index.js
eager-stdlib-parity`) was green in isolation (20/20, 54 assertions).

Running the FULL native suite (`node test/index.js`, no filter) immediately caught a real
regression the standalone run couldn't see: **71 failures**, all `'ftN' is not in scope` — a
genuine break in NATIVE (lazy) compiles, not just an eager-load byte gap. Root cause: the
`ctx.closure.types.add(1)`→`ctx.closure.mint` relocation (`31ce2aa6`) was built on a wrong premise
— `$ftN` (the closure `call_indirect` type) is needed whenever ANYTHING emits `call_indirect
(type $ftN)`, which includes the GENERIC dynamic-dispatch fallback (`tryGenericEmitter`'s shadow
probe, `tryDynamicPropCall`) and timer's `__invoke_closure`/`__invoke_closure1` trampolines —
NEITHER of which literally mints a closure via `ctx.closure.mint`. Gating on `.size` (mint-count)
undercounted every one of those. Reverted `module/function.js`/`src/compile/index.js` to their
EXACT pre-session shape (bare `ctx.closure.types` truthy, `.add(1)` back at module init) — that
premise was never actually broken: natively, EVERY real trigger for `fn` loading (literal
closures, generic dispatch, `includeForTimerRuntime`'s own `includeModule('fn')` for timer
callbacks) already implies `$ftN` might be needed, so "fn loaded" already correctly tracked "might
need `$ftN`" before this session touched anything — eager preload is the ONLY thing that breaks
that correlation, and the fix belongs downstream, in the consumer that has the actual ground truth.

That downstream fix (kept, `31ce2aa6`'s other change): `finalizeClosureTable`
(src/wat/assemble.js) already scans the ACTUALLY-COMPILED output for real `call_indirect` usage
(this branch's earlier, correctly-scoped-to-`ctx.core.includes` fix) — restructured to compute
that scan (`callIndirectSeen`) UNCONDITIONALLY, never seeded by `ctx.transform.targetProfile.
preserveClosureTable` (host:'wasi's "keep the table alive for an external embedder" flag) the way
the OLD `indirectUsed` was. Reasoning: an embedder calling `exports.__jz_table.get(i)(...)` from
OUTSIDE the module never touches this module's OWN `call_indirect` instruction, so preserving the
table for that reason never implies the `$ftN` TYPE must exist — only an IN-MODULE call_indirect
does. `$ftN`'s presence in `sec.types` is now driven by `callIndirectSeen` alone, applied
unconditionally at the end of the function, independent of the (unchanged) `indirectUsed = 
callIndirectSeen || preserveClosureTable` decision that still correctly gates table/elem/
per-closure-ABI-shrink preservation. This closes a SECOND regression the reverted `compile/
index.js` change reintroduced: with the push back to bare-truthy (fires for EVERY compile once
`fn` eager-loads) and `preserveClosureTable` short-circuiting `finalizeClosureTable`'s old
`indirectUsed` before it ever reached the stripping branch, EVERY host:'wasi' corpus entry (not
just zero-closure ones) picked up a phantom `$ftN` type under eager preload — caught by re-running
the byte-identity probe immediately after the first revert (wasi went from 7/11-identical back to
0/11, `sum` alone: 97B→106B, a bare 9-byte `(type $ftN ...)` with no matching table).

**Verified**: byte-identity probe back to 7/11 identical per host (both js and wasi, matching the
pre-regression state); `eager-stdlib-parity` pin green standalone. Full native suite (`node
test/index.js`, no filter) re-launched after this fix — result to be recorded once it completes.
Region-enabled kernel (`REGION_HOOKS_ACTIVE=true` in `scripts/self.js`, uncommitted — flip is
provisional pending the full hooks-on battery) rebuilt a second time with this corrected source
(first build, 246.9s/15,788,742B, was against the REGRESSED `.size`-gated source and is now
stale — do not trust any kernel-oracle/kernel-parity/kernel-target number measured against it;
rebuild in flight, see below for the result once available).

**Lesson for whoever continues past this session**: a standalone pin-file run is not sufficient
evidence a fix is regression-free — this session's OWN new pin passed cleanly in isolation while
the fix it was pinning had just broken 71 unrelated tests elsewhere in the suite. Always run the
FULL suite (or at minimum the neighboring files most likely to share the touched code path) before
trusting a "the pin is green" signal.

## `dvnested` residual, FULLY LOCALIZED (not fixed) — a watr-optimizer dead-code reliability gap, NOT a module-purity bug

Continuing the earlier "narrowed further, NOT closed" section: found `wasm2wat` (wabt,
`/Users/div/projects/wabt/bin/wasm2wat`) available in the sandbox — a far better tool than
counting `(func $name` lines in WAT-text-order (this session's earlier failed attempt) for
matching V8's own function-index error report. `--no-check` disassembles the invalid module
without refusing to emit output; the raw instruction stream (not watr's own S-expr printer, which
folds nested exprs and can visually hide a shape like this) makes the bug obvious immediately.

**Function `(;33;)` (0-indexed, confirmed against V8's own "Compiling function #33" — wasm2wat's
synthetic numeric names ARE the wasm function-index space directly, no imports to offset by) IS
`$f` itself** — this session's EARLIER conclusion ("the corruption is in a DIFFERENT function, not
`$f`") was wrong, an artifact of miscounting via the wrong tool. Reading its raw instructions: the
whole function body is ONE `block` (no `(result ...)` — i.e. it's a STATEMENT/void block) whose
LAST inner instruction is `f64.store` (address+value in, nothing out — a genuinely void op), and
the function's VERY LAST instruction, textually AFTER that block's implicit `end`, is a bare
`f64.convert_i32_s` with nothing left on the stack — exactly V8's "need 1, got 0". This is NOT a
dispatch-tier issue (Class 2 is confirmed fully closed — `$f`'s dispatch shape, and now its full
raw instruction stream, matches native's own DataView-direct emission byte-for-byte in every way
that matters) and NOT a stdlib-registration-purity issue (Class 1's territory) — it is a
**dead-instruction-elimination gap**: `$f = (dv) => dv.setFloat64(...)` — `setFloat64` returns
`undefined` in real JS (a void method), so the emitter's own IR for `.setFloat64` is legitimately
void-shaped (a `f64.store`), and the SURROUNDING "coerce this arrow's implicit-return expression
to the function's f64 return slot" wrapper (`f64.convert_i32_s`, expecting an i32-shaped
"undefined" sentinel to convert) is DEAD — its result is never consumed by anything real, since
this whole expression is a STATEMENT in return position, not a value flowing anywhere.

**Native (lazy) `dvnested` — the exact same "wrapping f64.convert_i32_s around a void block" shape
is present in watr's own pre-encode IR** (confirmed by re-reading this session's EARLIER
`dvnested-lazy.wat` dump, captured via `compile({wat:true})` i.e. watr's OWN printer, before ANY
of this session's fixes — literally `(f64.convert_i32_s (block (local.set ...) (f64.store ...)))`
at the function's top level) — and it compiles to VALID wasm (764B, passes the existing
kernel-parity/kernel-oracle `dvnested` row today). So watr's own DCE/simplify pass (index.js's own
doc: "watOptimize — the SOLE, FINAL optimizer... Runs ONCE, as a fixpoint") DOES eliminate this
exact dead-wrapper shape — SOMETIMES. Under eager load, the SAME source, producing a STRUCTURALLY
IDENTICAL `$f` (confirmed: no dispatch-tier or type-inference difference reaches this function
anymore, per every fix landed this session), ends up with 5-8× more OTHER functions sharing the
module (33-52 vs 6, from eagerly-registered-but-never-actually-needed stdlib helpers — Class 1's
territory, genuinely still-open for other modules beyond function.js/timer.js, see the earlier
audit-not-exhaustive note) — and AT THAT SCALE, watr's elimination of `$f`'s own dead wrapper
fails to fire. This is consistent with the "KNOWN OPEN ISSUE... deterministic... at [jz×jz] scale
only" pattern flagged elsewhere in this file's history (a different bug, same GENERAL shape: an
optimizer correctness/completeness property that holds at small scale and silently stops holding
at a larger one) — plausibly a genuine watr bug (iteration budget, working-set size, or a
threshold in its own fixpoint/CSE/inline pass), NOT anything in jz's own module-loading code.

**Out of this session's scope to fix**: this lives in watr (a separate package/repo — see the
environment's own `/Users/div/projects/watr` working directory), not in jz's stdlib modules or
compile pipeline, and is a genuinely different bug CLASS (optimizer reliability at scale) from
everything else in this task (module-init purity / dispatch-tier demand-gating). It is real, and
it is a correctness risk independent of region-arena or eager-loading specifically — ANY
sufficiently large/complex native jz program could in principle trip the same "watr fails to strip
a dead wrapper once enough OTHER code is around it" gap; eager-loading is simply the easiest,
smallest known repro that happens to trigger it (5-8× function-count inflation from otherwise-tiny
`dvnested`). Flagged, not fixed, not pinned as an expected-invalid-forever case — the
`test/eager-stdlib-parity.js` known-gap test for it says exactly this and points here.
**Concrete next step for whoever picks this up**: reproduce NATIVELY without eager-loading at all
(no region-arena, no `_eagerStdlib`) — write or find a plain jz program whose `--wat` dump shows
the same `f64.convert_i32_s`-wrapping-a-void-block shape AND is large/complex enough that watr's
DCE doesn't collapse it; if that reproduces, this is a watr bug independent of jz's eager-loading
work entirely and belongs in that repo, not this one.

## Second real regression, caught the same way (`4b37da79`) — `ctx.closure.floor` cannot be lazy

Re-ran the FULL native suite (not just the pin) after `72eddaee`'s ftN fix — clean (see below),
BUT: **7 new failures, all `Command failed: wasmtime .../jz_timer_test.wasm`** (`test/timers.js`,
which compiles with `{nativeTimers:true, host:'wasi'}` and actually EXECUTES the result via a real
`wasmtime` subprocess — the ONE test file in the whole suite that does this, which is exactly why
neither the standalone pin nor kernel-oracle/kernel-parity's byte/JS-oracle checks could have
caught it). Reproduced directly: `wasmtime` rejects the compiled module — `Invalid input
WebAssembly code: type mismatch: expected i32, found f64`. Root cause: `610d44c7` moved ALL FOUR
of `setupWasi`'s unconditional effects into the lazy `ensureWasiTimerRuntime()` thunk, but
`ctx.closure.floor = MAX_CLOSURE_ARITY` is not like the other three (inc/hostImport/declGlobal,
all genuinely about REACHABILITY/INCLUSION) — it is a WIDTH-POLICY decision shared by the whole
compile's closure ABI (`$ftN`'s param list), and it must be set BEFORE any closure literal in the
program is compiled, since a closure's param-list width is fixed at MINT time. Deferring it to
"whenever `setTimeout`'s own handler happens to run" is too late the moment ANYTHING else in the
program's emission order doesn't cooperate. Fix: moved `ctx.closure.floor` back to `setupWasi`'s
own unconditional top level (module init time — where it was pre-session, and where it needs to
stay), keeping only the other three in the lazy thunk. Verified this does NOT reopen the
byte-identity gap `610d44c7` closed: `72eddaee`'s `finalizeClosureTable` fix already means `$ftN`
never gets emitted at all for a program with no reachable `call_indirect`, so this width value is
inert dead data exactly whenever it would otherwise cost bytes — byte-identity probe unchanged
(7/11 per host, same as immediately before this fix). All 5 `test/timers.js` assertions (fires
callback, callback executes code, clearTimeout cancels, setInterval repeats, multiple timers all
fire) now pass via a real `wasmtime` execution, not just a compile-succeeds check.

**Second lesson, same shape as the first**: this regression was ALSO invisible to the standalone
pin (`eager-stdlib-parity.js` never sets `nativeTimers` or shells out to `wasmtime`) and would have
shipped past kernel-oracle/kernel-parity too (neither exercises real `wasmtime` execution either).
The FULL native suite is the only thing in this whole battery that actually caught it. Two
regressions in one session, both from this exact same category of gap — worth naming explicitly:
**"demand-gate this effect" is not a safe default move for EVERY unconditional module-init
side-effect; some (WIDTH/ABI-shape policies, in general) are inherently module-load-time-scoped and
must stay that way — only REACHABILITY/INCLUSION effects (inc/hostImport/declGlobal, the ones the
task named) are safe to defer.** Audit each candidate against "does moving this to demand-time
change what an EARLIER-compiled sibling observes", not just "does this cost bytes when unused".

### Battery status at this point (before the final full-suite re-run below)

- `node test/kernel-oracle.js` (against the `72eddaee`-era kernel, built BEFORE `4b37da79`'s
  closure.floor fix — irrelevant to it, floor's native-timers repro is a `host:'wasi'` +
  `nativeTimers` shape kernel-oracle's own corpus doesn't use): **11/14 test-blocks, 581
  assertions, 3 fail — all `dict` byte-parity** (same known gap as native). Every EXECUTION
  assertion passes at O0/O2/O3, matching the task's own stated bar for that file exactly.
- `node test/kernel-parity.js` (same kernel): **sum/math byte-identical at every level (O0/O2/O3)
  — the ORIGINAL bug this whole investigation chased ("sum O0: native 642B vs kernel 923B") is
  CLOSED** — aborts at `dict` (3rd corpus entry, `is()` throws on first mismatch) with the same
  known byte-parity gap; `arr`/`fold`/`mfold`/`boolconst`/`nestedtyped`/`subviewtyped`/`dvnested`/
  `fromnested` not individually re-checked past that abort point this run (kernel-oracle's own
  non-aborting per-row structure already covers most of them at the EXECUTION level).
- `node test/index.js` (native, full, no filter): 71-fail ftN regression → fixed (`72eddaee`) →
  7-fail closure.floor/wasmtime regression → fixed (`4b37da79`) → re-running now for a clean final
  count (see below once available).
- `goal-probe` (hooks-on, this session's fixes, against the `72eddaee`-era kernel — the
  `4b37da79` closure.floor fix is `host:'wasi'`+`nativeTimers`-specific and this probe compiles
  jz's own source via `compileSelf`, host:'js'-shaped, so it was never expected to be affected by
  that fix specifically): **`TRAP "unreachable", peakBytes 3999662080, elapsedMs 684846, 163
  modules`** — 93.1% of the wasm32 ceiling (4,294,967,296), essentially IDENTICAL in shape to the
  prior session's own hooks-on measurement recorded above (`peakBytes 3998613504, elapsedMs
  601108`) — same trap kind ("unreachable", not a clean OOM at exactly the ceiling), same ~93%
  peak, same 163 modules. This session's fixes (module-init purity, dispatch-tier demand-gating)
  did NOT change this number in any material way — expected and correct: this is the
  ALREADY-DOCUMENTED, SEPARATE "KNOWN OPEN ISSUE... deterministic... at jz×jz scale only" defect
  this file's own much earlier section banked rather than chased (a genuinely different bug class
  from everything this session touched — this session never claimed to move this number, only to
  close the module-purity/dispatch-tier gaps blocking a clean hooks-on kernel-oracle/kernel-parity
  battery). elapsedMs is ~14% higher than the prior measurement (685s vs 601s) — plausibly just
  this session's own fixes making the compile do marginally more real work before failing (more
  demand-driven registration bookkeeping), or heavy concurrent multi-agent load on the shared
  machine this measurement ran on; not further isolated.
- `JZ_TEST_TARGET=jz.wasm node test/index.js`: running in background (long, ~20+ min under heavy
  shared-machine multi-agent load today), result pending.
- `node test/index.js` (native, full, no filter), re-run after the `4b37da79` closure.floor fix:
  **COMPLETE — 3737/3741 pass, 3 fail, 1 skip (21664 assertions).** The 3 failures are exactly the
  ALREADY-KNOWN `dict` kernel-parity byte divergence (O0/O2/O3, native-vs-kernel, execution-correct,
  pre-existing representation/narrowing gap unrelated to module purity or dispatch — same class as
  `mfold`/`subviewtyped`) — nothing else. **Both regressions found and fixed earlier in this
  session (71-fail `ftN` → `72eddaee`; 7-fail wasmtime/`closure.floor` → `4b37da79`) are confirmed
  fully closed — zero new regressions from any fix landed this session.** (One operational note:
  this run needed 2 attempts — the first background launch got killed after appearing stuck at
  `bench-c.js`'s ASan-sanitized `strbuild` test, which turned out to be that test's own
  ALREADY-DOCUMENTED "macOS ASan runtime busy-loops without reaching main" case, with a real 60s
  `execFileSync` timeout and automatic non-sanitized fallback already built into the test — not a
  bug, just slower than the earlier glance suggested; the second attempt ran the same section
  through to completion without intervention once given the full 60s.)

## Session end state — `REGION_HOOKS_ACTIVE` reverted to `false`, `JZ_TEST_TARGET=jz.wasm` leg still running at handoff

**`REGION_HOOKS_ACTIVE` reverted to `false`** (`scripts/self.js`, matches HEAD/d2c04d32, zero diff)
per the task's own mandate — the hooks-on battery is NOT fully green: the `dict` kernel-parity byte
gap remains open (native suite 3737/3741, kernel-oracle 11/14 blocks, kernel-parity aborts at
`dict`), and the `JZ_TEST_TARGET=jz.wasm node test/index.js` leg had not finished by session end
(see below). Flipping the default was correctly foreclosed by the mandate's own condition.

**`JZ_TEST_TARGET=jz.wasm node test/index.js` (the kernel-target battery leg) was STILL RUNNING,
unfinished, at session end** — launched against the `72eddaee`-era region-enabled kernel (built
AFTER the `d1f4b585`/`31ce2aa6`/`72eddaee` fixes, BEFORE the `4b37da79` closure.floor fix — that
fix is `host:'wasi'`+`nativeTimers`-specific and `timers` is itself in `test/index.js`'s own
`KERNEL_EXCLUDE` set, so it can't affect this leg regardless of kernel staleness). Ran 38+ minutes
continuously (confirmed healthy throughout via repeated `ps` CPU-time-delta checks — steadily
accumulating, never stalled) without producing output (piped through `tail -100`, so nothing
prints until the whole run finishes) under exceptionally heavy shared-machine load (3-4 concurrent
unrelated agent sessions' own full test/build runs observed competing for CPU throughout this
session — confirmed via `lsof`-verified `cwd` on every `node test/index.js` process in the process
table, not just guessed). A direct, isolated sanity check (`JZ_TEST_TARGET=jz.wasm node -e
"compile('export let f=(a,b)=>a+b',{})"`) confirmed the kernel-target PATH itself works correctly
and instantly against this exact kernel — the long run is scale (a large corpus, each case a
real wasm-kernel compile call, slower per-call than native) plus today's contention, not a hang.

**Task ID / how to pick this back up**: the background command is `Bash` task id `b19o81x7o`
(prompt: "Run the kernel-target test battery against the region-enabled kernel"), output file
`/private/tmp/claude-501/-Users-div-projects-jz/0482f00a-7cbc-475b-939a-b25b5ba26704/tasks/
b19o81x7o.output`, backing process PID 75735 (cwd this worktree). If it completed after this
session ended, read that file directly for the result. If the WORKTREE has since been torn down
and the process is gone, re-run `JZ_TEST_TARGET=jz.wasm node test/index.js` fresh against a
rebuilt kernel (rebuild first — `dist/jz.wasm` is gitignored, not part of any commit) once
`REGION_HOOKS_ACTIVE` is flipped back to `true` for that purpose; expect the SAME `dict`-class
gap to surface there too (native-vs-kernel byte parity, not execution), consistent with every
other leg this session measured, and otherwise a clean run — every fix landed this session was
independently verified via the OTHER four battery legs (native full suite, kernel-oracle,
kernel-parity, goal-probe) before this leg was even launched.

### Summary of everything independently confirmed clean this session (i.e., NOT blocked on the
### still-running kernel-target leg)

1. Native full suite (`node test/index.js`, no filter, no `JZ_TEST_TARGET`): **3737/3741 pass, 3
   fail (all `dict` kernel-parity, pre-existing, execution-correct), 1 skip.**
2. `node test/kernel-oracle.js` against the region-enabled kernel: **11/14 blocks, 581 assertions
   — every EXECUTION assertion passes at O0/O2/O3; the only 3 failures are `dict`'s WAT-byte-parity
   check.**
3. `node test/kernel-parity.js` against the same kernel: **`sum`/`math` byte-IDENTICAL at O0/O2/O3
   — the task's own originally-cited repro ("sum O0: native 642B vs kernel 923B") is closed.**
   Aborts at `dict` (3rd corpus entry) per the file's own first-mismatch-throws design.
4. `test/eager-stdlib-parity.js` (this session's own new pin): **20/20 pass standalone** — 7/11
   corpus entries byte-identical eager-vs-lazy per host (up from 0/11 at session start), the
   `dict`/`mfold`/`subviewtyped`/`dvnested` known-gaps tracked explicitly rather than silently
   uncovered, frobnicate reject-parity pinned directly.
5. Goal-probe (hooks-on, this session's full fix set): `TRAP "unreachable", peakBytes 3999662080,
   elapsedMs 684846, 163 modules` — 93.1% of the wasm32 ceiling, same trap mechanism and scale as
   the prior session's own measurement, confirming this session's fixes didn't regress (or
   materially change) the separate, already-banked jz×jz-scale memory-wall issue.

### The task's two named findings — both closed

- **(a) Module-init purity (Class 1)**: `module/function.js`'s `ctx.closure.types.add(1)` and
  `module/timer.js`'s `setupWasi`'s unconditional `hostImport`/`inc`/`declGlobal` were the two
  task-named examples — both fixed (`31ce2aa6`→corrected in `72eddaee`; `610d44c7`→corrected in
  `4b37da79`), plus a THIRD related site found and fixed in the same investigation
  (`src/wat/assemble.js`'s `finalizeClosureTable` scanning EVERY ever-registered stdlib template
  instead of only reachable ones, `31ce2aa6`). The broader "audit every module" ask was addressed
  by BUILDING AND USING the byte-identity probe as the audit instrument (empirically confirmed
  object/array/typedarray/string/collection module loading is already harmless via the corpus'
  `dict`/`arr`/`nestedtyped`/`subviewtyped`/`fromnested`/`boolconst` rows) rather than manually
  re-deriving "does treeshake cover this" for every one of ~150 `inc()`/`declGlobal()` call sites
  by hand — spot-checked (atomics.js, symbol.js, navigator.js, web.js, crypto.js) all clean, one
  narrow exception flagged not fixed (crypto.js's `declGlobal('crypto.state',...)` under the
  `randomSeed` opt specifically, low priority, likely also treeshake-covered but not verified).
- **(b) Kernel-vs-native REJECT divergence**: root-caused precisely — NOT a `valTypeOf` regression
  (confirmed `vt` stays `'array'` identically eager vs lazy); it was `tryDynamicPropCall`'s `if
  (ctx.closure.call)` gate treating "is `fn` LOADED" as a proxy for "could this receiver hold a
  closure", which eager preload breaks. Fixed by adding `ctx.module.demanded` (src/ctx.js) — a
  ledger of REAL, AST-content-driven module requests, separate from "has init(ctx) run for any
  reason" — and gating both `tryDynamicPropCall` and `tryGenericEmitter`'s shadow probe on it.
  Also closed an EXTRA, unplanned discovery of the identical mechanism (`dvnested`'s DataView
  dispatch), and, while investigating THAT one to full closure, found and fully localized (though
  did not fix — separate bug class, separate repo) a watr optimizer dead-code-elimination
  reliability gap at scale.

### Commits, in order (branch `fix/pure-stdlib-init`, base `d2c04d32`)

`eabc8f9e` (test hook) → `57b9afc1` (notes) → `d1f4b585` (Class 2 fix) → `c3c95182` (notes) →
`31ce2aa6` (Class 1 fix, closure table — later found to need correction) → `610d44c7` (Class 1
fix, timer wasi runtime — later found to need correction) → `1ae0168b` (notes) → `80ec0155` (pin)
→ `72eddaee` (fixes the `31ce2aa6` regression) → `e569712d`/`4ae76b18` (notes) → `4b37da79` (fixes
the `610d44c7` regression) → this commit (final notes). All source commits left `git diff` against
`d2c04d32` showing ONLY the intended files; `scripts/self.js`'s `REGION_HOOKS_ACTIVE` stayed
`false` in every commit (only ever flipped locally, uncommitted, for measurement, and reverted
before each commit boundary).

## `JZ_TEST_TARGET=jz.wasm node test/index.js` COMPLETED after this file's last entry — 2971/2995 pass, 23 fail, all traced to a PRE-EXISTING region-arena defect, NOT this session's changes

The leg finished (task `b19o81x7o`, ~46 min wall-clock under heavy shared-machine contention —
CPU-time delta confirmed continuously active the whole time, never stalled). **2971/2995 pass, 23
fail, 1 skip (14281 assertions), exit code 0.** Two distinct failure groups, both investigated to
root cause before writing this:

**Group 1 — `test/pointers.js`'s `nan-box: ARRAY/BUFFER/TYPED/large offset` rows (≥4 of the 23,
likely more of the "19 more" collapsed in the summary — the full per-row list was lost to this
run's own `tail -100` truncation; re-ran `test/pointers.js` alone against the same kernel to
confirm 7 of its own rows fail).** Root-caused with a minimal native-vs-kernel differential probe
(`/private/tmp/.../scratchpad/mkptr-repro{2,3,4,5}.mjs`, all standalone, no test-file changes):
`__mkptr(TYPE, aux, offset)` → `__ptr_offset(...)` is supposed to be a pure bit round-trip for a
FRESH, never-relocated pointer — `__ptr_offset` (layout.js `followForwardingWat`, module/core.js)
only chases a "forwarding" indirection for pointer TAGS in `FORWARDING_MASK` (ARRAY/SET/MAP/HASH —
types whose backing store can be reallocated on growth), and even then only after confirming a
real sentinel (`mem32[off-4] === -1`) at the target address.

Empirically: **TYPE=0 (ATOM, never forwarding-eligible) round-trips correctly in BOTH native and
kernel output. TYPE=1 (ARRAY) and TYPE=6 (OBJECT — NOT supposed to be forwarding-eligible at all)
both incorrectly "forward" in the KERNEL-compiled output only**, for offsets as far apart as 2048
and 999999 (nowhere near any real allocation — confirmed via a raw memory dump: both addresses are
zero-filled in both native and kernel output, ruling out "coincidental collision with real data").
OBJECT (type=6) forwarding at all is the smoking gun: it proves the KERNEL's own compiled
`__ptr_offset` is testing pointer tags against a **wrong `FORWARDING_MASK` bit pattern** — a
constant baked in when `layout.js`/`module/core.js` were self-compiled INTO this kernel, not
anything about the specific offset value or memory contents. This is a compile-time constant/
codegen corruption specific to the region-enabled self-compile, structurally the SAME CLASS of
defect ("schema-table"/constant corruption under region relocation) that EVERY prior session in
this file's history flagged as open and never fully closed — **not a new bug, and definitively not
caused by this session's work**: `git diff d2c04d32 HEAD --stat` shows this session touched
`index.js`, `module/timer.js`, `src/autoload.js`, `src/compile/emit.js`, `src/compile/index.js`,
`src/ctx.js`, `src/front.js`, `src/wat/assemble.js`, and test files only — `layout.js`,
`module/core.js`, and `FORWARDING_MASK`'s own definition were never touched.

**Group 2 — `fuzz: no new miscompiles in seeds 1..200 × opt {0,1,2,3}`, ONE seed
(seed=84, opt=3): `Maximum call stack size exceeded` during `kind=jz-compile`** (a JS-level stack
overflow inside the KERNEL's own compile call for a deeply-nested fuzz-generated program — not an
execution-time divergence). `test/fuzz.js`'s own `KNOWN_OPEN` ratchet is `new Set([])` — EMPTY, by
design ("All known clusters fixed — the ratchet is now empty, so ANY divergence fails CI") — so
this test is written to fail loudly on ANYTHING, and its own header comment already documents that
the FULL 200×4 fuzz gate through the wasm kernel is normally SKIPPED in CI ("exceeds GitHub's
6-hour job limit") and only the native legs run it at full scale. This strongly suggests the
region-enabled kernel had never been fuzzed at this scale before (by ANY prior session in this
investigation — the task's own mandate treats `JZ_TEST_TARGET=jz.wasm node test/index.js (0 fail)`
as a not-yet-achieved target, consistent with this leg never having been run to completion before).
Not root-caused to the same depth as Group 1 (would need reproducing seed=84 in isolation, which
this session did not have time to do), but the self-hosted-compiler-stack-depth explanation is
plausible on its face (a self-hosted AST-walking pass recursing on a deeply-nested fuzz program
consumes real V8 stack per logical recursion level, the same way `errors`/`parser-bugs`/
`transform` are ALREADY excluded from kernel-target for a documented HANG reason in
`test/index.js`'s own `KERNEL-LEG DEBT` comment) — flagged, not fixed, not confidently attributed
either way to region-arena specifically vs. a general self-hosted-recursion-depth limit.

**Consequence**: `REGION_HOOKS_ACTIVE` correctly stays `false` (already committed) — this result
is FURTHER, stronger confirmation the hooks-on battery is not green, on top of the already-known
`dict` kernel-parity gap. Neither of these two new findings blocks or contradicts this session's
own fixes (Class 1 module-init purity, Class 2 dispatch-tier demand-gating) — both are verified
independently clean via kernel-oracle (11/14, execution-clean), kernel-parity (`sum`/`math`
byte-identical), and the full native suite (3737/3741, only the known `dict` gap). They ARE two
new, concrete, reproducible data points for whoever continues the region-arena soundness work:
Group 1 gives a clean, minimal, three-line repro (`__mkptr`/`__ptr_offset` round-trip, TYPE=6)
that's dramatically easier to bisect than `dvnested-mechanism` or the earlier `sum`-at-O0 chase —
worth trying FIRST.

## Group 1 root-cause session (2026-08-28, worktree fix/region-forwarding-const @ 63fe910d) — FORWARDING_MASK hypothesis DISPROVEN; real bug isolated to a literal-argument miscompile with a clean v<77/v>=77 threshold

Built a region-enabled kernel (`REGION_HOOKS_ACTIVE=true`, `JZ_SELF_COMPILE_OPT=0`, 93.1s,
13,484,208 bytes) at current HEAD (63fe910d, i.e. with every landed fix: front's eager
`includeMods`, `lateSchema.namedUses`, `lateFacts.errorSidEntries`, Class-1/Class-2 module-purity
fixes). Diagnostic method: `compile(src,{wat:true,optimize:0})` (native) vs
`compileViaKernel(src,{wat:true,optimize:0})` (kernel) on the exact `test/pointers.js` nan-box
sources, diffing the emitted WAT function-by-function — no breadcrumbs/rebuilds needed, since the
mismatch is a compile-TIME text difference, directly visible in `--wat` output.

**`$__mkptr`, `$__ptr_offset`, and `$__ptr_offset_fwd` are BYTE-IDENTICAL between native and
kernel output**, including `(i32.const 898)` for the `FORWARDING_MASK` bit-test inside
`$__ptr_offset` (898 = `(1<<PTR.ARRAY)|(1<<PTR.HASH)|(1<<PTR.SET)|(1<<PTR.MAP)`, the correct
value). **This DISPROVES the prior session's leading hypothesis** ("the kernel's self-compiled
`__ptr_offset` has a wrong `FORWARDING_MASK` bit pattern baked in") — the stdlib helper functions
themselves, as compiled into the kernel, are correct and identical to native, at the WAT-text
level, not just "semantically equivalent."

**The real divergence is in the CALLER's compiled code** — diffing `$f`'s own body (the guest
function under test) shows the KERNEL emits a WRONG THIRD ARGUMENT to `$__mkptr`:
native emits `(call $__mkptr (i32.const 1) (i32.const 100) (i32.const 2048))` for
`__mkptr(1, 100, 2048)`; the kernel emits `(call $__mkptr (i32.const 1) (i32.const 100) (i32.const
1971))` — the literal `2048` from the GUEST SOURCE gets replaced by `1971` during the KERNEL's
own compilation of the guest program. `2048 - 1971 = 77`.

**Swept the offset literal across many values (0, 1, 8, 50, 76, 77, 78, 100, 200, 500, 1000, 2000,
2048, 5000, 10000, 65536, 100000, 999999, 1048576), reading the kernel's emitted `i32.const` for
`$__mkptr`'s 3rd arg directly out of `--wat` output** (fresh kernel instance per compile, same
93.1s O0 kernel throughout, no rebuilds): **v ≤ 76 emits `v` unchanged (correct). v ≥ 77 emits
EXACTLY `v − 77`, for every tested magnitude from 78 to 1,048,576** — not proportional, not
modular, a flat constant offset of 77 the instant the literal reaches 77, with zero exceptions
across 3 orders of magnitude. This is a clean, deterministic, value-independent-once-past-
threshold corruption — consistent with a small-integer INTERNING/POOL table of exactly 77 entries
(plausibly indices 0..76) where entries ≥ 77 go through a different, buggy path that returns
something that happens to equal the intended value minus the pool's own size, rather than the
value itself (e.g. a value/index confusion for whatever backs literals past the inline table).

**Narrowed further (position vs. downstream-use): NOT confirmed which theory is right — the two
comparison tests run so far (2048 in `__mkptr`'s 1st arg followed by `__ptr_type(p)`: correct;
2048 in the 2nd arg followed by `__ptr_aux(p)`: correct; 2048 in the 3rd arg followed by
`__ptr_offset(p)`: WRONG) are confounded — they vary BOTH the argument position AND which
accessor is called afterward simultaneously.** Next concrete step (not yet run): put a ≥77
literal in the 3rd arg (offset) position WITHOUT calling `__ptr_offset` afterward (e.g. call
`__ptr_type(p)` instead, or just discard `p`) to isolate "is `__mkptr`'s offset PARAMETER always
special-cased" vs. "does the corruption only fire when the compiler also sees a later
`__ptr_offset` call and tries to fold the `__mkptr`→`__ptr_offset` round-trip pattern at compile
time" (the latter would implicate a peephole/algebraic-simplification pass — plausibly the same
one `src/optimize/index.js:4125`'s `['i32.const', FORWARDING_MASK]` literal belongs to, which is
a DIFFERENT code path than `inlinePtrOffsetFast`, src/passes.js:48, already ruled out by the prior
session's "CRITICAL CORRECTION" section since that flag is force-`false` at O0/O2 regardless of
region-arena). Both native and kernel run the SAME optimizer source, so if this is a peephole
fold, the bug must be in how the fold's OWN constant computation behaves differently when the fold
itself is executing self-hosted (inside the kernel, at L1) vs natively — e.g. a lookup into a
region-arena-relocated table (schema/constant-pool) that's stale specifically past a 77-entry
inline threshold. Whoever continues: (1) run the position-vs-use isolation test above; (2) if it
implicates a fold, grep `src/optimize/index.js` and `src/compile/emit.js`/`narrow.js` for a
constant-pool or "first N literals inline, rest overflow" shaped table with something like a
77-ish fixed capacity, or any structure whose SIZE happens to be 77 for this particular kernel
build (e.g. count of distinct small-int literals used by the compiler's OWN source, baked in at L0
build time — would make "77" a build-specific accident, not a universal constant, worth
re-checking against a fresh O3 production build to see if the threshold moves); (3) once the
table/fold is found, apply the fix per the header doctrine in `src/compile/index.js` (widen the
owning round's root/snapshot, or hoist the table's creation before `mark()` — never root
`ctx.core` wholesale).

Diagnostic scripts (not committed, scratchpad only): `fwdmask-wat-diff.mjs` (native-vs-kernel WAT
diff for the 3 helper functions — proved them identical), `fwdmask-exec-diff.mjs` (executes both
and compares — first showed the always-77 delta), `fwdmask-sweep.mjs` (the value sweep + the
confounded position/accessor comparison above) — all three read
`.../scratchpad/rf/index.js`/`test/kernel-target.js`/`interop.js` directly, no test-file edits.
Kernel used throughout: `/private/tmp/claude-501/-Users-div-projects-jz/0482f00a-7cbc-475b-939a-b25b5ba26704/scratchpad/rf/dist/jz.wasm`
(gitignored, O0, region-hooks-on, built from this worktree's `scripts/self.js` with
`REGION_HOOKS_ACTIVE` locally flipped `true` — uncommitted, matches every prior session's
convention of never committing that flip).
