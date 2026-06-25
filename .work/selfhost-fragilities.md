# Self-host dynamic-access fragility surface

Found while hardening after the AST-migration probe (the int-key dual-key on `ctx.core.emit`
faulted the self-host). Root cause class: **dynamic index/key access on non-array receivers
emits a raw, unbounded indexed `f64.store`/`f64.load`** instead of routing to the hash sidecar
or a clean guard. A raw OOB (silent slot corruption or a `memory access out of bounds` trap with
no diagnostic) is the worst failure mode — these are codegen bugs, so both host-built and
wasm-built programs hit them.

## FIXED

**Root A — `o[i] = v` (numeric / runtime non-static key) on a fixed-shape OBJECT → raw
`f64.store(ptrOffset(o) + i*8)`.** Silent schema-slot corruption at small `i`, OOB trap at
large `i`. This is exactly what broke the self-host when the dispatch table gained integer keys.
- Fix: `src/compile/emit-assign.js` step **7b** — `if (knownArrVT === VAL.OBJECT) return dynSetCall(arr, keyExpr, valueExpr)`, mirroring `emitPropertyAssign`'s OBJECT dot-write path. Covers both the runtime-key-dispatch (step 8) and default (step 9) buggy paths. Byte-identical corpus preserved (`fc9e6bc`).
- Test: `test/objects.js` → "Regression: numeric runtime key write on fixed-shape object preserves schema slots (no OOB)" — pins the safety invariant under host + `test:wasm`.

**Scope of the Root A fix:** it covers receivers whose type is *statically known* to be OBJECT
(`knownArrVT === VAL.OBJECT`) — which includes the self-host dispatch object that faulted. It does
NOT cover an *untyped* receiver that is an OBJECT only at runtime: `let o = {}` (empty literal →
null-typed) + `o[i] = v` takes the polymorphic path (`emitPolymorphicElementStore`), whose
fallback still raw-stores → wrong value at small `i`, **OOB trap at large `i`** (pre-existing; not
introduced by the fix). See Root A′ below — the proper fix is either a runtime `__ptr_type(OBJECT)`
fork in `emitPolymorphicElementStore` (perf cost on every polymorphic store) or analyze-time HASH
promotion when a binding receives dynamic-key writes.

## TRACKED follow-ups — RESOLUTION STATUS (2026 sweep)

Severity: **SAFETY** = memory corruption / heap-read leak; **WRONG** = silent wrong value.

| Root | Pattern | Severity | Status |
|---|---|---|---|
| A′ | `o[i]=v` (numeric/dynamic key) on an **untyped** receiver that is an OBJECT at runtime (e.g. empty `{}`) → `emitPolymorphicElementStore` fallback raw-stores: wrong value at small `i`, **OOB trap at large `i`** | SAFETY | **FIXED.** `emitPolymorphicElementStore` (+ step 8) now fork OBJECT/HASH → `__dyn_set` with a STRING key (`o[3]`≡`o["3"]`, via `__i32_to_str`) — no schema-slot corruption, no OOB. Gated on `rep.notString` (`mayBeObject`) so a typed-array param indexed in a hot loop keeps the lean raw store and never drags in `__dyn_set`/`__i32_to_str` (the doc-anticipated "perf cost on every polymorphic store" — avoided). The lean numeric READ path is unchanged by design (an object with numeric keys reads `undefined`, like an out-of-range typed index; test/perf "skips __is_str_key dispatch" pins the lean read). Pinned: test/objects.js "o[i]=v on an untyped empty-object binding is OOB-safe (Root A′)". Unswitch matcher (`src/optimize/index.js`) hardened to descend through the new fork. |
| B | `o[k]=v` (string runtime key) on schema OBJECT in a single-function module where no other fn sets `anyDynKey` → `__dyn_set` writes sidecar but the schema slot isn't shadowed; later `o.x` reads stale slot | WRONG | **FIXED at root.** `src/wat/assemble.js` `tblConsumed` now includes `__dyn_set`, so the schema table is built whenever a string-key write needs to mirror into a fixed slot (`buildObjectSchemaSetArm`, gated on `$__schema_tbl != 0`). `needsSchemaTbl`'s non-empty-schema guard keeps zero cost for dict-only programs. Pinned: test/objects.js (2 single-function-module cases). |
| C | `ta[-1]` typed-array literal negative index read → `f64.load(payload + (-1<<3))`, reads heap metadata | SAFETY | **NON-ISSUE (verified).** `module/array.js` `ctx.core.emit['[]']` guards literal negatives up front (`intLiteralValue(idx) < 0 → undefExpr()`) before any `__typed_idx`/raw load. Covers literal `-1`/`-2`, typed + plain arrays. (The runtime-VARIABLE negative case is Root F.) |
| D | `a[k]` (string/unknown key) read on an int-array that `promoteIntArrayLiterals` rewrote to `Int32Array` → typed load truncates `NaN→0` → returns `a[0]` instead of `undefined` | WRONG | **FIXED at root.** `src/compile/plan/literals.js` `_disqualifyPromotion` now threads `valTypes` and disqualifies an int-array-literal candidate from TYPED promotion when any `name[k]` read has a non-numeric key (`_isNumericKey`) — mirroring the emit-level `idxNumericName`/`intIndexIR` guard at the planning level (where the unsound rewrite occurs). Pinned: test/optimizer.js (string-literal + unknown-param key). |
| E | `o[k]` read on a closure-**captured** schema object → schema id lost through the closure-cell unbox; propsPtr empty → undefined | WRONG | **NON-ISSUE (verified).** Closure-captured `o[k]` (and direct) read back correct values host + kernel; schema id is preserved. |
| F | typed-array `ta[i]` read/write with a runtime **negative** (or `≥len`) variable index → reads/writes outside the buffer → heap junk / corruption. The `.typed:[]` resolved-ctor fast path (`module/typedarray.js`) is unchecked; the `__typed_idx` helper IS bounds-checked. The plain-ARRAY read path is already safe (inline `i32.lt_u` guard, elided by `inBoundsArrIdx`). | SAFETY | **OPEN — folded into the bench-perf phase.** A blanket bounds check on `.typed:[]` would hit every DSP loop: the bench kernels index `for(i=0;i<n;i++) a[i]` where `n` is a *separate* length var (`a=new T(n)`), which `inBoundsArrIdx` (proves only `i<a.length`) does NOT cover — so the guard would regress the exact cases we're optimizing. The correct fix is to EXTEND the in-bounds proof to `let a=new T(n); for(i<n) a[i]` (length-binding equivalence), eliding the guard for the DSP pattern and applying it only to genuinely-unproven indices. Done in the perf phase where that proof also enables hoisting. |

### Coverage gaps (zero existing assertions) for the above
Numeric-key write on schema OBJECT (Root A — now covered), `o[i]+=v` compound, loop-counter key,
large-`i` trap (all now covered by the new test); single-function string-key schism (B);
typed-array literal negative index (C); string key on populated array / typed array (D);
closure-captured schema dyn read (E); array runtime negative index (F).

Conventions to match when fixing: turn each silent raw-OOB into either correct behavior (route to
the existing `__dyn_set` / `__dyn_get` hash path) or a clean fail-fast via `ensureDynSetAllowed`
(warn in `strict:false`, throw in `strict:true`) — never a silent trap. Pin every fix with a test
that runs under `JZ_TEST_TARGET=jz.wasm` so the self-host boundary is held.

## Second class — self-host *codegen* miscompiles (object construction / scoping)

Distinct from the dynamic-access class above: here jz.wasm miscompiles its OWN source constructs
(V8 runs the identical JS correctly — so every one is a host↔wasm divergence). Surfaced
root-causing the **poly trap**: jz.wasm crashed, then (once the crash was fixed) emitted *garbage*,
compiling any bimorphic typed-array function (`sum(Float64Array)+sum(Int32Array)`). All three lived
in `specializeBimorphicTyped`'s clone construction; all FIXED by building clones as fresh,
fully-formed object literals with unique loop-var names. Monomorphic typed arrays were always fine.

| Pattern | Self-host failure | Status |
|---|---|---|
| **Single-unknown spread-copy then mutate** — `{ ...r }` (r's schema unknown) then a write to the copy (`c.typedCtor = …`, `c.x = 9`, add a new key) | the copy ALIASED r's backing → the write leaked into the source | **FIXED at root** — `{ ...x }` now emits a true shallow clone (`module/core.js __obj_clone`, keyed off the box schemaId; copies static-segment sources; preserves OBJECT/HASH type). narrow.js's `cloneReps` uses the natural `{...r}` then-mutate form again. Pinned: `test/objects.js` → "spread copy: …" (6 cases, host+kernel). |
| **Multi-prop spread of an OBJECT consumed as an OBJECT** — `{ ...objSrc, k1, k2 }` (e.g. `{ ...func.sig, params, results }`) | NOT the allKnown merge path (instrumentation shows that path is never reached — `shapeOf(func.sig)` returns null). It routes to `emitDynamicSpread`, which ALWAYS builds a **HASH**. But the compiler types sigs as **OBJECT** everywhere else (static slot reads), so the HASH `cloneSig` misdispatches when a later `clone.sig.params` reads it as an OBJECT → OOB in the self-host. The root is the **OBJECT-vs-HASH result-type** of multi-prop spread. | **OPEN — workaround is the right fix.** narrow.js's `cloneSig` builds the OBJECT literal directly (no `...func.sig`), keeping it OBJECT-typed. A general fix (type-preserving multi-prop spread: `__obj_clone(src)` + apply overrides, OBJECT→OBJECT) is entangled with the `...(cond && {...})` pattern (26 sites) whose source can be FALSY and *needs* the HASH/runtime-key path — so it can't unconditionally clone. Disproportionate + risky vs the one narrow trigger; not pursued. |
| **Repeated-name block scoping** — a `for (… of …)` loop var whose name collides with an earlier same-name decl in the function (`combo` ×3, `key` ×2) | the loop var isn't rebound per iteration; it aliases the prior binding → stuck at the last value → every clone got the same (wrong) element ctor | **OPEN** — neutralized by unique loop-var names (narrow.js keeps `cmb`/`dkey`). |

Pinned by `test/types.js` → "bimorphic typed-array param specializes, compiles + runs (self-host
regression)" + `test/objects.js` → "spread copy: …", all through the kernel under `test:wasm`. A
*harmless* instance of the scoping bug remains in `analyzeFuncForEmit` (`for (const [name, vt] of …)`
shadows the outer `name`, but `name` isn't read after — no output impact). `plan/inline.js` documents
the full-override-spread hazard for its rest-param clone.

**ROOT status:** (a) object spread-copy of an unknown source is now **fixed** (`__obj_clone`) — the
single-unknown `{ ...x }` alias was the spread-alias bug; (a′) multi-prop spread's OBJECT-vs-HASH
result type and (b) alpha-renaming of shadowed declarations remain latent, neutralized at their known
triggers (direct OBJECT literal / unique loop-var names). (a′) was investigated to root (it is NOT
the allKnown path — that's never reached) and consciously left to the workaround: a general fix is
entangled with falsy `&&`-guarded spread sources. Durable follow-up: a finer-grained host-vs-wasm
parity gate (bisect which compiler fn diverges) to localize the next one. `test:wasm` gates all tested
behavior paths.

## Third class — self-host *resolveIncludes* auto-dep scan divergence

`resolveIncludes()` (src/ctx.js) pulls a stdlib helper's callees two ways: explicit edges
(`deps()` arrays / direct `inc('__foo')` — plain, kernel-robust) and an AUTO-dep scan that
*realizes* each template and greps the body for `$__foo` calls. The auto-scan is host-only: under
self-host it silently yields nothing for some templates (realizing a function-template factory
diverges; some string scans drop too). A helper reachable ONLY via the auto-scan therefore vanishes
from the kernel module.

| Pattern | Self-host failure | Status |
|---|---|---|
| **`__clamp_idx`** — the shared `[0,len]` relative-index clamp, body-called by six range ops (str/typed `.slice`, `.fill`, `.copyWithin`, `.subarray`) yet listed in ZERO `deps()` array — pulled purely by the auto-scan | dropped from the kernel → `Unknown func $__clamp_idx` on `str.slice` / typed `.fill` (57 kernel failures) | **FIXED at root** — explicit `__clamp_idx` dep edge added to every caller (module/{string,typedarray,array}.js). Invariant pinned: `test/selfhost-includes.js` — no stdlib helper may be reachable only via the auto-scan (every body-ref needs a `deps()` edge or an `inc()`). |

**Convention:** a new stdlib helper that other helpers *call* must earn an explicit edge — never rely
on the auto-scan, which is a host-side safety net the kernel can't run. selfhost-includes.js enforces it.

## Fourth class — self-host *vectorizer* divergence

jz.wasm's lane vectorizer diverges from the in-process one on optimization SHAPE (it mis-compiles
parts of its own `liftExprV`/`tryVectorize`), while staying functionally correct.

| Pattern | Self-host failure | Status |
|---|---|---|
| **null-leak reduction operand** — `liftExprV`'s contract is "null ⟺ ctx.fail"; in the kernel it returns null WITHOUT the flag for an `i32 & K` reduction body, so `tryReduceVectorize` (checking only `ctx.fail`) spliced a literal `null` into `(i32x4.add acc null)` | invalid wasm — "not enough arguments on the stack for i32x4.add" (sieve/dot reductions, 4 kernel failures) | **FIXED** — `tryReduceVectorize` now bails on `liftedExpr == null` too (loop stays scalar on that leg — correct). No-op in-process. |
| **bail-to-scalar parity gap** — for various lane shapes (f32 maps, Uint8 XOR/shl, i16 mul, conditional bitselect, sqrt/min/max, reduceUnroll, offset-dot) the kernel vectorizer *declines* where in-process accepts → correct scalar code, no SIMD | structural codegen-shape assertions fail on the kernel leg (~21) | **NEUTRALIZED** — those structural `ok(/v128…/)` assertions are guarded `if (!onKernel())` (the established simd.js pattern); functional bit-exactness still gates the kernel. ROOT is the durable follow-up below. |

**Parity-investigation findings — ROOT bisected (a Root-E instance).** Built an in-kernel decision
trace (a `warn('vt', …)` surfaced via `compileViaKernel({warnings})`; `--why-not-simd` alone is
useless — the diverging loop is rejected before the why-not emit point). Stepped a basic local-array
f64 map `let a=new Float64Array(n); … o[i]=a[i]*k` (in-process → `f64x2.mul`; kernel → scalar)
through the pipeline:
- `matchBlockLoop` **succeeds** in the kernel (recognition is fine — my earlier "recognition"
  guess was wrong). `tryVectorize` reaches its lift loop, then bails at `lifted.length === 0`.
- Each body stmt's `liftStmt` returns null. Traced into the `local.set tw5 = a[i]*k` lift:
  `getOrAllocLanedLocal` built `r = { laneName: \`${name}__v\`, origName: name }`, and reading
  `r.laneName` **back in the caller returned `undefined`** (kernel) — the template literal itself
  was correct (`interp` showed the right string); the OBJECT lost its schema across the
  Map.set/function-return boundary. **This is Root E** (schema id lost through boxing) on a fresh
  2-field literal, not just closure-captured ones.
- **FIXED (this instance):** `getOrAllocLanedLocal` / `laned` now store and return the bare lane
  NAME string in `newLanedLocals` — strings are immune to the schema-boxing loss. No in-process
  change (only `laneName` was ever read; `origName`/`simdType` were vestigial). suite 2512/0,
  kernel 2241/0.
- **STILL BLOCKED — the `ctx` instance.** With laneName fixed the f64 map STILL doesn't vectorize:
  `liftExprV` reads the SCALAR props of the `ctx` object (`ctx.laneType`, the `ctx.fail` write-back)
  across the `tryVectorize → liftStmt → liftExprV → liftFail` call chain, and those read/propagate
  wrong in the kernel (same Root E). Notably ctx's REFERENCE props read fine (`ctx.localKind.get`,
  `ctx.newLanedLocals.get/set` work) — only scalar/string slots are lost across the boundary.
  `tryPerPixelColor` self-hosts precisely because it hardcodes the lane type and never cross-reads a
  ctx scalar. A bounded fix would thread `laneType` (and a fail flag) as PRIMITIVE args through
  liftExprV instead of via the ctx object — a sizeable, careful refactor of the whole lift chain;
  the real fix is the central Root-E repair (preserve schema ids across the box boundary), which is
  the high-leverage durable follow-up since it would unblock this whole class at once.

- **DEEPER BISECTION (corrects the line above).** Instrumented the actual lift loop via `warn` (note:
  `warn` dedupes by `code:fn:line`, so debug warns need a unique `meta.fn` counter or they collapse to
  one entry — this masks loop traces). Findings on the f64 map `o[i]=a[i]*2+1` (in-process `f64x2=4`,
  kernel `f64x2=0`):
  - `liftStmt` returns null for BOTH body stmts with `ctx.fail=false, reason=null` in the kernel — i.e.
    it falls through to no-lift, NOT a `liftFail`. The guards are byte-identical to in-process
    (`STORE_OPS[op]`, `localKind.get` all correct).
  - ROOT: in the `local.set $tw5` lane branch, **`getOrAllocLanedLocal` returns `"f64"` (= `ctx.laneType`)
    instead of `"$tw5__v"`** — `ctx.newLanedLocals.get(name)` returns `"f64"` even on the FIRST call when
    the Map is empty (should be `undefined`). So the doc's claim above that "ctx's REFERENCE props read
    fine / `newLanedLocals.get` works" is **WRONG** — the *reference* prop `newLanedLocals` reads back a
    DIFFERENT slot's value (`laneType`) at call-depth 2. `instanceof Map` on the same prop reads TRUE,
    but `.get()` returns the wrong slot — the SAME property yields different values in different
    syntactic contexts (a slot-offset miscompile, not scalar-vs-reference).
  - `liftExprV` ALSO fails independently in that branch (`vNull=true, fail=true` deep) on its own ctx
    reads — so the bug hits MULTIPLE deep ctx reads, not one site.
  - Tested fixes that do NOT work: destructuring `const nll = ctx.newLanedLocals; nll.get()` (still
    wrong). RESISTS isolated reproduction: the exact 12-field ctx shape + access path + populated
    `fnLocals` (slot 6, a name→type Map whose `.get($tw5)='f64'`, the suspected adjacent slot) all pass
    in a standalone program. The trigger needs the real compiled vectorizer context.
  - CONSEQUENCE: the "thread laneType/fail as primitives" bounded fix is INSUFFICIENT (the failing reads
    include a Map ref + multiple sites). Real fix is either (a) the deep object-read codegen repair at
    its root — blocked on an isolable repro — or (b) thread EVERY ctx field used in the lift chain
    (`laneType`, `newLanedLocals`, `localKind`, fail-as-return) as explicit params through
    liftStmt/liftExprV/getOrAllocLanedLocal/liftCanon/narrowStore — a large, careful refactor that must
    keep the in-process vectorizer bit-identical (full suite + bench + test:wasm gate). PERF-ONLY: the
    kernel emits correct SCALAR code (bit-exact), so this is a jz.wasm output-quality gap, not a defect.

- **✅ RESOLVED AT TRUE ROOT (module-global workaround removed).** The earlier diagnosis ("deep
  arg-passed object read miscompiled / schema lost across the boundary") was a SYMPTOM, not the root.
  The real cause: **two of the five lift-ctx object literals had INCONSISTENT shapes.** `tryRampMap`
  and `tryToneMap` built an 11-field ctx (missing `fnLocals`), while `tryVectorize`/`tryStencil`/
  `tryReduceVectorize` built the 12-field ctx. jz infers ONE monomorphic struct layout per shared
  callee param; since `liftStmt`/`liftExprV`/`getOrAllocLanedLocal` are called from BOTH, the inferred
  arg layout collapsed to the 11-field schema. Reading a 12-field object through an 11-field schema
  shifts every slot from index 6 (`fnLocals`) onward by −1, so `ctx.newLanedLocals` (slot 7) read
  `fnLocals` (slot 6) — exactly the "wrong slot" symptom. V8 tolerated it (real objects read missing
  fields as `undefined`); the NaN-box schema model did not. **Fix: add `fnLocals: null` to the two
  short literals so all five ctx shapes are identical, then DELETE the entire `_liftCtx` module-global
  workaround** (7 `ctx = _liftCtx` rebinds, 5 `_liftCtx = ctx` assignments, the `let _liftCtx`).
  `getOrAllocLanedLocal` now takes `newLanedLocals` directly (no depth-2 ctx read at all). In-process
  output is bit-identical (the workaround was a no-op there); the kernel vectorizes EVERY shape at full
  parity — verified `in-process f64x2 == kernel f64x2`. The 23 un-guarded shape assertions in
  test/simd.js pin it. Full suite 2519/0, test:wasm 2249/0, fuzz 0 divergences (5000 seeds × opt0-3).
  **Convention (enforce):** any object literal flowing into a shared callee param must keep an IDENTICAL
  field SET + ORDER across every construction site — a missing/reordered field silently mis-slots in the
  kernel. `tryToneMap`'s comment already warned this; the invariant was violated when `fnLocals` was
  added to the other ctxs without updating these two.

## Fifth class — self-host *property-getter dispatch* (closure-tag fragility)

Surfaced by the bench-selfhost parity gate (re-enabled after the `blur` harness fix below): the kernel
miscompiled typed-array PROPERTY reads `.byteOffset` / `.buffer` / `.byteLength`, collection `.size`,
and the regex getters — they fell through to a runtime `__dyn_get` (→ `undefined`) instead of resolving
statically. Root of the `fft`/`synth`/`json` parity DIFFs (benchlib `checksumF64` builds a
`new Uint32Array(out.buffer, out.byteOffset, …)` view).

| Pattern | Self-host failure | Status |
|---|---|---|
| `a.byteOffset` / `a.buffer` / `a.byteLength` / `s.size` / `re.flags` — dispatched only when `ctx.core.emit['.PROP'].getter` is truthy | The getter-ness was tagged on the emitter CLOSURE (`getter = fn => (fn.getter = true, fn)`, src/ctx.js). The kernel cannot reliably read a dynamic property off a closure returned via a dynamic-key lookup (`ctx.core.emit[propKey]?.getter`), so every getter read `undefined` → fell to `__dyn_get` → wrong value. (Resists isolation — closure-prop, sequence-expr, dyn-key-read of a closure-with-dynprop ALL work standalone; only the real compiler diverges.) | **FIXED at root.** New `ctx.core.getters` (a plain Set on ctx.core, placed LAST to avoid slot-shift) + `registerGetter(key, fn)` (src/ctx.js) populates it alongside `ctx.core.emit[key]`. The 4 dispatch checks in module/core.js now authorize via `ctx.core.getters.has(propKey)` — a plain Set key-lookup is immune to the closure-tag loss (the `.${vt}:${method}` method dispatch already proved dynamic-key reads of the emit table are kernel-safe). Registration sites in module/{typedarray,collection,regex}.js switched to `registerGetter`. Pinned: test/buffer.js "typed-array property getters resolve statically (self-host parity)" — runs on the `JZ_TEST_TARGET=jz.wasm` leg. |

## Sixth class — self-host *float-literal parsing* precision (correctly-rounded strtod)

After the getter fix, `fft`/`synth` STILL DIFF: the kernel parses some f64 literals 1 ULP off from V8.
jz.js parses source number literals via V8's `Number()` (correctly rounded); jz.wasm runs jz's own
`__to_num`/`__parseFloat` (module/number.js), which accumulates ≤18 significant digits into an i64
`$mant` then scales by `mant * __pow10(decExp)` (`POW10_SCALE`). That product is NOT correctly-rounded
for `|decExp| > 22` (e.g. 10^23 = 2^23·5^23, 5^23 > 2^53 — `__pow10` is inexact + the mul/div rounds),
so a 16-17 sig-digit constant like `-2.505210838544172e-8` lands 1 ULP off. Confirmed: that constant's
compiled bytes DIFFER jz.js vs jz.wasm; most constants match. This breaks the bit-exactness `fft`/`synth`
are designed for when compiled by the kernel. **FIXED.** `__dec_to_f64` (module/number.js) is a
correctly-rounded Eisel-Lemire decimal→f64: normalize the i64 significand to 64 bits, multiply by a
128-bit power-of-ten table entry, round the 64-bit product. `__to_num`/`__parseFloat` call it and fall
back to the old `POW10_SCALE` only when it returns the NaN sentinel. **The power-of-ten table is TRIMMED
to exp10 ∈ [-65, 65]** (131 entries, 2096 bytes) — the realistic source/JSON constant span (fft/synth's
coefficients are ~10^-23). exp10 outside that range returns the sentinel → POW10_SCALE fallback (1 ULP
for moderate exponents; at the f64 limits, the pre-EL behavior — no real literal reaches them; the
`Number.MIN_VALUE`/`MAX_VALUE` *constants* are exact f64.const, not parsed). A full -342..308 table would
add ~10 KB to **every** program that does an untyped numeric coercion (`x*2` pulls `__to_num`); the trim
keeps it ~2 KB. Verified: 3000 random realistic constants compile byte-identical jz.js vs kernel; `fft`
and `synth` bench:self parity = `ok`. Pinned: test/number.js (the mul64-carry hard case `2505210838544172e-23`,
exp10 -23, inside the table) — runs on the kernel leg. Lazy-linked: `src/wat/assemble.js` appends the
table only when `__dec_to_f64` survives DCE.

**`json` bench:self DIFF is BENIGN (not a correctness bug).** After getter + EL fixes, `json` still shows
a byte DIFF, isolated to jz's own JSON-parser codegen (`$jpws` whitespace-skip shape) — same functions,
behaviorally IDENTICAL output (verified: object/array/nested/whitespace/integer-value walks all match
jz.js, kernel checksum == jz.js checksum; test:wasm's JSON.parse coverage is green). It is a codegen-SHAPE
divergence in self-compiling module/json.js, not a value divergence; chasing byte-identity there is low
value since behavior is proven equal.

## Harness (NOT a compiler bug) — bench-selfhost arena exhaustion

`scripts/bench-selfhost.mjs` reused ONE wasm instance for all 26 timed compiles (WARM+RUNS) of each
program. The kernel bump-allocates per compile and never resets its arena (cross-compile caches assume
an immortal arena), so a large program (`blur`) exhausted the 8192-page memory on its ~4th compile —
"memory access out of bounds". This was MISDIAGNOSED earlier as a Root-A′ codegen bug. **FIXED** in the
harness: `timeMinWasm` instantiates a FRESH instance per timed iteration (instantiation excluded from
the timed region). bench:self now runs all 22 cases.
