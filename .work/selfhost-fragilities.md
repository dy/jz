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

## TRACKED follow-ups (sweep findings, not yet fixed)

Severity: **SAFETY** = memory corruption / heap-read leak; **WRONG** = silent wrong value.

| Root | Pattern | Severity | Note |
|---|---|---|---|
| A′ | `o[i]=v` (numeric/dynamic key) on an **untyped** receiver that is an OBJECT at runtime (e.g. empty `{}`) → `emitPolymorphicElementStore` fallback raw-stores: wrong value at small `i`, **OOB trap at large `i`** | SAFETY | The static-OBJECT variant is fixed (step 7b); this is the polymorphic variant. Fix: runtime `__ptr_type(OBJECT) → __dyn_set` fork in `emitPolymorphicElementStore`, or analyze-time HASH promotion for dyn-keyed bindings. |
| B | `o[k]=v` (string runtime key) on schema OBJECT in a single-function module where no other fn sets `anyDynKey` → `__dyn_set` writes sidecar but the schema slot isn't shadowed; later `o.x` reads stale slot | WRONG | Shadow-write analysis in `analyze.js` (`anyDynKey` must be module-wide for the binding). Existing string-key regression passes only because its module incidentally sets `anyDynKey=true`. |
| C | `ta[-1]` typed-array literal negative index read → `f64.load(payload + (-1<<3))`, reads heap metadata | SAFETY | Likely already neutralized by `arrayIndexKey` rejecting negatives — **verify**; if reachable, fold negative literals → undefined. |
| D | `a[k]` (string runtime key) read on a populated array `[1,2,3]` → no `__is_str_key` dispatch; string NaN-coerces to 0 → returns `a[0]` | WRONG | Array element-**read** path (emit.js / read path) needs the same runtime-key fork the write path (step 7) has. Empty-array path is correct. |
| E | `o[k]` read on a closure-**captured** schema object → schema id lost through the closure-cell unbox; propsPtr empty → undefined | WRONG | `__dyn_get` OBJECT-schema arm needs the schema id preserved across closure-cell boxing, or schema slots mirrored at alloc. |
| F | `a[i]` array read with a runtime **negative** variable index → reads before payload → heap junk (literal `-1` is constant-folded correctly; only the runtime-variable case leaks) | SAFETY | Read path / `__arr_get_idx` needs an `i < 0 → undefined` guard. |

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
