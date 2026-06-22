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

## Second class — self-host *codegen* miscompiles (object construction)

Distinct from the dynamic-access class above: jz.wasm miscompiles its OWN source constructs (V8 runs
the identical JS correctly, so each is a host↔wasm divergence — running the same compiler fn on host
vs through jz.wasm and diffing the values is how you find these fast). Surfaced root-causing the
**poly trap**: jz.wasm crashed, then (crash fixed) emitted *garbage*, compiling any bimorphic
typed-array function (`sum(Float64Array)+sum(Int32Array)`). Monomorphic typed arrays were always fine.

**1. Object spread aliased instead of copying — the real root, FIXED at the codegen root.**
`emitObjectSpread` (module/object.js) had a deliberate "single unknown-schema spread `{...x}` → return
the source by reference" fast path. Unsound: `let c = {...src}; c.k = …` then mutated `src`. **General
— host AND wasm** (not self-host-only). It was the poly *garbage*: cloneReps did `m.set(k, {...r})`
then mutated the result, so every clone aliased the same rep and got the last ctor. FIXED by removing
the alias (always copy via the dynamic-merge path); the corpus checksum was unchanged, so nothing read-
only relied on it. Pinned by the spread-copy tests in `test/objects.js`. Minimal `{...local}`,
`{...o,k:v}` override, and array `[...a]` always copied — only pure `{...nonLocalExpr}` aliased.

**2. Bimorphic clone *sig* construction faulted — separate bug, worked around.**
Building the clone sig as `{ ...func.sig, params, results }` then post-mutating the `{...p}` param
copies to ADD ptrKind/ptrAux faults in the self-host (a later `sig.params` read goes OOB) — the poly
*crash*. Constructing cloneSig directly (each param a literal with the pointer ABI baked in) sidesteps
it; verified NOT subsumed by the #1 root fix (reverting only this re-crashes). `plan/inline.js` builds
its rest-param clone sig the same way.

**3. "Repeated-name loop-var collision" — claim WITHDRAWN (red herring).** A minimal 3-way
`for (const c of …)` collision rebinds correctly. A *destructuring* `for (const [name, vt] of …)` does
leave the outer `name` holding the last key *after* the loop (a real but harmless scoping quirk — the
per-iteration value inside the loop is correct), so it only matters where the outer is read after the
loop. The `combo`/`key` rename added while chasing this was unnecessary and was reverted; the poly
garbage was #1, not this.

Pinned by `test/objects.js` (spread copy semantics) + `test/types.js` (bimorphic specialization), both
run through the kernel under `test:wasm`. Remaining latent: the bimorphic-sig fault (#2, worked around
not root-fixed) and the destructuring-for-of quirk (#3, harmless). Durable follow-up: a self-host
*conformance* suite exercising object construction/spread through jz.wasm, and a finer host-vs-wasm
parity gate that bisects which compiler fn diverges. `test:wasm` gates all currently-tested paths.
