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
