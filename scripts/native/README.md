# jz → native binary

## Any program

`compile.mjs` builds a standalone executable from a jz program: jz
`--host wasi --no-tail-call` → wasm2c → C compiler, linked with `wasi.c`, a
WASI Preview 1 shim for exactly the imports jz emits (`fd_read`, `fd_write`,
`path_open`, `fd_close`, `fd_filestat_get`, `clock_time_get`, `random_get`).

```bash
node scripts/native/compile.mjs host.js -o host     # jz options may follow: -O3, -D K=V, --no-simd

jz host.js --host wasi -o host.wasm                 # or a module you already built
node scripts/native/compile.mjs host.wasm -o host
```

Built from the `.js`, the module has no tail calls (`--no-tail-call`). A `.wasm`
of your own may keep them: wasm2c translates most, but WABT 1.0.39-1.0.41 emit
invalid C for a tail call that passes several values. The script says so when
that happens; rebuild the module with `--no-tail-call`.

It needs WABT (wasm2c and its runtime: `brew install wabt` or a
[release](https://github.com/WebAssembly/wabt/releases)) and clang or another C
compiler. WABT is found through `WABT_DIR` (a checkout or install prefix),
`WABT_W2C_DIR` (its runtime directory, `share/wabt/wasm2c`), the `wasm2c` on
PATH, or the Homebrew, `/usr/local` and `/usr` prefixes; `CC` (`CC="zig cc"`
too) and `CFLAGS` choose the compiler and add flags; a clang profile-guided
build is `CFLAGS=-fprofile-instr-generate`, a run, `llvm-profdata merge`, then
`CFLAGS=-fprofile-instr-use=<profdata>`. A program that vectorizes needs the SIMDe
headers (`brew install simde`, `apt install libsimde-dev`, or `SIMDE_DIR`), or
`--no-simd`.

What the executable does:

- it calls `_initialize` (top-level code), then `_start`, where exported, as
  wasmtime does;
- `fd_read` and `fd_write` are blocking `readv`/`writev` on the process's
  descriptors, partial counts as the OS returns them and 0 at EOF, so a byte
  protocol over `fs.readSync`/`fs.writeSync` (a Chrome Native Messaging host)
  answers as under Node; a closed reader is `EPIPE` (64), not `SIGPIPE`; a
  descriptor another process left non-blocking still blocks, where wasmtime 25
  and Node fail with `EAGAIN`;
- fd 3, the preopen `fs.read`/`fs.write` resolve against, is the working
  directory (wasmtime needs `--dir .` for it);
- a failing call returns its WASI errno, which jz throws as a number; try/catch
  works through wasm2c's exception runtime;
- a trap prints `wasm trap: <reason>` and exits 134.

`test/native-lowering.js` builds a Native Messaging echo host and compares its
output byte for byte with `node` and `wasmtime`, a 1 MiB message included. The
bench's `jz-w2c` lane builds through the same `wasm2native()` with its speed
flags and the postprocess below.

## watr PGO pipeline

Compile a jz JavaScript source to a standalone native executable. The pipeline
self-compiles watr's WAT compiler at the time of writing and serves as the
reference target for "how fast can a jz-produced wasm get if you really care."

```
  watr/src/compile.js
        │
   jz (NaN-boxed f64 ABI, JZ-aware)
        │
        ▼
  jz-watr.wasm
        │
   wasm2c --enable-exceptions
        │
        ▼
  watr.c (post-processed: remove barriers + hoist stable memory base)
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
| `SIMDE_DIR` | `$WABT_DIR/third_party/simde`| SIMD compatibility headers used by wasm2c. |
| `CC`        | `clang`                      | Needs LTO + PGO.                           |

## Files

| Path                              | Role                                                                        |
|-----------------------------------|-----------------------------------------------------------------------------|
| `compile.mjs`                     | Any program → executable; toolchain discovery shared with the bench.         |
| `wasi.c`                          | WASI Preview 1 shim and entry for `compile.mjs` and the bench's `jz-w2c`.    |
| `build.sh`                        | Three-stage PGO build orchestrator.                                          |
| `gen-watr-wasm.mjs`               | jz-compiles `watr/src/compile.js` directly to validated `jz-watr.wasm`.      |
| `postprocess-watr.awk`            | Remove wasm2c barriers; hoist memory base; lower scalar/SIMD memory access.   |
| `harness.c`                       | Median-of-90 bench harness; re-instantiates every 5 iters to bound bump-heap.|
| `env-stubs.c`                     | Empty `__ext_*` import stubs.                                               |
| `wasm-rt-exceptions-stub.c`       | Trap-only EH (watr has 5 throws, 0 catches).                                 |

## Why each stage matters

**watr optimization is the only WASM optimizer.** JZ already runs watr's speed
profile at `-O3`; its condition-dominating constant propagation removes the
scratch locals previously left for Binaryen. The native path consumes that
module directly, so Binaryen is neither installed nor silently required.

**PGO** closes the last ~5% on the hottest inner loops (parser identifier walk,
uleb encode, bump alloc) by giving clang accurate branch frequencies and
inlining decisions. Profile is collected from a weighted sample of
`watr/test/example/*.wat` — heavy iters on raycast/maze/containers/snake/etc.,
light pass over the rest.

**A1** (`-fno-exceptions` + trap-only EH stub) removes `throw_with_stack`
machinery. watr has 5 throws and 0 catches — we're never propagating, so the
runtime only needs `wasm_rt_trap`.

**A2a** (the postprocessor nullifies `FORCE_READ_INT`/`FORCE_READ_FLOAT` and
`SIMD_FORCE_READ`) is the biggest single
win. wasm2c emits `__asm__("" ::"r"(var))` after every load to "force the value
into a register," but clang's PGO+LTO treats those as side-effecting barriers
that defeat CSE of `instance->w2c_memory.data`. Killing them unlocks the
.data hoist on parser hot loops:

```
f5 inner loop, before:        12 insts/iter, .data reloaded 4×
f5 inner loop, after A2a:      4 insts/iter, .data hoisted above the loop
```

644M-call function on the PGO trace; ~8% on parser-heavy workloads.

**A2b** (the same fail-closed postprocessor) goes further. Even with A2a, clang refuses to
CSE `instance->w2c_memory.data` across CFG joins inside a single function — f6
still reloaded it 5 times. The awk pass injects, at the top of every function
that takes `(w2c_jzwatr* instance, ...)`:

```c
__attribute__((unused)) u8* const __restrict__ _md = instance->w2c_memory.data;
```

…and shadows the wasm2c load/store inlines with macros that reference `_md`
directly, including full-vector, splat, widening-load, and vector-store forms.
The `__restrict__` plus const-locality plus PGO is what finally lets clang keep
the base in a register across the entire function. f6: 5 reloads → 1.

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

Current result on M4 Max after removing Binaryen:

```
21/21 wins (1.48× – 9.13×)
```
