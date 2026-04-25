# jz → native binary

Compile a jz JavaScript source to a standalone native executable. The pipeline
self-hosts watr's WAT compiler at the time of writing and serves as the
reference target for "how fast can a jz-produced wasm get if you really care."

```
  watr/src/compile.js
        │
   jz (NaN-boxed f64 ABI, JZ-aware)
        │
        ▼
  jz-watr.wasm
        │
   wasm-opt -O3 (Binaryen)
        │
        ▼
  jz-watr-opt.wasm
        │
   wasm2c --enable-exceptions
        │
        ▼
  watr.c (post-processed: A2a nullify barriers + A2b hoist memory base)
        │
   clang -O3 -flto -fprofile-instr-generate          ──► profraw
   clang -O3 -flto -fprofile-instr-use=watr.profdata ──► watr-native
```

## Quick start

```bash
./scripts/native/build.sh           # full PGO pipeline → /tmp/jz-c/watr-native
./scripts/native/build.sh clean     # wipe BUILD_DIR

BIN=/tmp/jz-c/watr-native node scripts/bench-native.mjs   # regression gate
```

Env overrides:

| Variable    | Default                      | Notes                                      |
|-------------|------------------------------|--------------------------------------------|
| `BUILD_DIR` | `/tmp/jz-c`                  | All transient artefacts land here.         |
| `WABT_DIR`  | `/Users/div/projects/wabt`   | Provides `bin/wasm2c` and `wasm2c/*`.      |
| `WASM_OPT`  | `$(which wasm-opt)`          | Binaryen.                                  |
| `CC`        | `clang`                      | Needs LTO + PGO.                           |

## Files

| Path                              | Role                                                                        |
|-----------------------------------|-----------------------------------------------------------------------------|
| `build.sh`                        | Three-stage PGO build orchestrator.                                          |
| `gen-watr-wasm.mjs`               | jz-compiles `watr/src/compile.js`, runs `wasm-opt -O3` → `jz-watr-opt.wasm`. |
| `postprocess-watr.awk`            | A2b: hoist `instance->w2c_memory.data` per function + macro-shadow load/store. |
| `harness.c`                       | Median-of-90 bench harness; re-instantiates every 5 iters to bound bump-heap.|
| `env-stubs.c`                     | Empty `__ext_*` import stubs.                                               |
| `wasm-rt-exceptions-stub.c`       | Trap-only EH (watr has 5 throws, 0 catches).                                 |

## Why each stage matters

**wasm-opt -O3** trims wasm2c's input by ~10% on parser-heavy paths. Raw jz
output has redundant locals and unhoisted loads that wasm2c can't undo once
it's serialized to C.

**PGO** closes the last ~5% on the hottest inner loops (parser identifier walk,
uleb encode, bump alloc) by giving clang accurate branch frequencies and
inlining decisions. Profile is collected from a weighted sample of
`watr/test/example/*.wat` — heavy iters on raycast/maze/containers/snake/etc.,
light pass over the rest.

**A1** (`-fno-exceptions` + trap-only EH stub) removes `throw_with_stack`
machinery. watr has 5 throws and 0 catches — we're never propagating, so the
runtime only needs `wasm_rt_trap`.

**A2a** (sed nullifies `FORCE_READ_INT`/`FORCE_READ_FLOAT`) is the biggest single
win. wasm2c emits `__asm__("" ::"r"(var))` after every load to "force the value
into a register," but clang's PGO+LTO treats those as side-effecting barriers
that defeat CSE of `instance->w2c_memory.data`. Killing them unlocks the
.data hoist on parser hot loops:

```
f5 inner loop, before:        12 insts/iter, .data reloaded 4×
f5 inner loop, after A2a:      4 insts/iter, .data hoisted above the loop
```

644M-call function on the PGO trace; ~8% on parser-heavy workloads.

**A2b** (`postprocess-watr.awk`) goes further. Even with A2a, clang refuses to
CSE `instance->w2c_memory.data` across CFG joins inside a single function — f6
still reloaded it 5 times. The awk pass injects, at the top of every function
that takes `(w2c_jzwatr* instance, ...)`:

```c
__attribute__((unused)) u8* const __restrict__ _md = instance->w2c_memory.data;
```

…and shadows the wasm2c load/store inlines with macros that reference `_md`
directly. The `__restrict__` plus const-locality plus PGO is what finally lets
clang keep the base in a register across the entire function. f6: 5 reloads → 1.

**A3** removes C++ EH tables (`-fno-exceptions -fno-unwind-tables
-fno-asynchronous-unwind-tables`), the stack protector (no untrusted input),
and merges constants. Smaller `.text` and `.rodata` → better i-cache /
constant-pool behaviour.

**`WASM_RT_MEMCHECK_GUARD_PAGES`** moves bounds checks from inline branches to
OS-level guard pages. **`WASM_RT_NONCONFORMING_UNCHECKED_STACK_EXHAUSTION`**
turns `FUNC_PROLOGUE` into a no-op (no `++wasm_rt_call_stack_depth` per call).

## Regression gate

`scripts/bench-native.mjs` walks `watr/test/example/*.wat`, runs each through
both the native binary and a steady-state V8 baseline (200 iters or 200ms of
warmup, whichever is longer; fresh `node` process per run to avoid in-process
tier-up bias), and asserts that native is faster than V8 on every example.

Each side is invoked `RUNS` times (default 3) and we take the min; this is
robust against macOS scheduler jitter without burying real regressions.

```
ITERS=30  RUNS=3  MARGIN=1.0   # defaults
```

Current result on M4 Max (range across runs):

```
19/21 wins (1.04× – 4.0×)
 2/21 ties (raycast.wat, containers.wat — 0.97×–1.01×, within noise floor)
```

raycast and containers exercise the same identifier-resolution path that V8's
TurboFan also optimises near-optimally; we've matched V8 to within
measurement noise but not consistently beaten it. Tier B will close that gap
through watr-source-level changes (the bottleneck is the structure of the
JS, not the codegen).
