#!/usr/bin/env bash
# End-to-end PGO build of jz-compiled watr to a native binary.
#
#   jz(watr/src/compile.js) -> $BUILD_DIR/jz-watr.wasm
#   wasm-opt -O3              -> $BUILD_DIR/jz-watr-opt.wasm     (~10% win on parser-heavy paths)
#   wasm2c                    -> $BUILD_DIR/watr.c
#   clang -O3 + PGO           -> $BUILD_DIR/watr-native
#
# Why PGO: closes the last ~5% gap on the hottest paths (f230 parser, bump alloc).
# Why wasm-opt: raw wasm has redundant locals / unhoisted loads; binaryen -O3 cleans
#   them up before wasm2c's structured output forces clang to re-derive them.
#
# Requirements (override with env vars):
#   WABT_DIR   — wabt repo (uses bin/wasm2c, wasm2c/ headers). Default: /Users/div/projects/wabt
#   WASM_OPT   — Binaryen wasm-opt. Default: $(which wasm-opt)
#   CC         — clang with LTO+PGO support. Default: clang
#   BUILD_DIR  — transient outputs. Default: /tmp/jz-c
#
# Usage:
#   ./build.sh            # full build
#   ./build.sh clean      # wipe BUILD_DIR
set -e

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${BUILD_DIR:-/tmp/jz-c}"
WABT_DIR="${WABT_DIR:-/Users/div/projects/wabt}"
WASM_OPT="${WASM_OPT:-$(command -v wasm-opt || echo wasm-opt)}"
CC="${CC:-clang}"

if [ "${1:-}" = "clean" ]; then rm -rf "$BUILD_DIR"; exit 0; fi

mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

# Reproducibility: copy authored sources into BUILD_DIR so the tree is self-contained.
cp "$SRC_DIR/harness.c" "$SRC_DIR/env-stubs.c" "$SRC_DIR/wasm-rt-exceptions-stub.c" .
cp "$WABT_DIR/wasm2c"/*.{c,h,inc} . 2>/dev/null || true

COMMON="-I. -I$WABT_DIR/wasm2c -DWASM_RT_MEMCHECK_GUARD_PAGES -DWASM_RT_USE_MMAP=1 -DWASM_RT_NONCONFORMING_UNCHECKED_STACK_EXHAUSTION=1"
# A3: drop C++ EH (we use setjmp/longjmp), unwind tables (no introspection),
# stack protector (no untrusted input), merge constants (smaller .rodata, better cache).
EXTRA="-fno-exceptions -fno-unwind-tables -fno-asynchronous-unwind-tables -fmerge-all-constants -fno-stack-protector"

# Stage 0: regenerate watr.wasm via jz + wasm-opt if missing or stale.
if [ ! -f jz-watr-opt.wasm ] || [ "$SRC_DIR/gen-watr-wasm.mjs" -nt jz-watr-opt.wasm ]; then
  echo "=== Stage 0: regen watr.wasm via jz + wasm-opt ==="
  BUILD_DIR="$BUILD_DIR" WASM_OPT="$WASM_OPT" node "$SRC_DIR/gen-watr-wasm.mjs" > /dev/null
fi
if [ ! -f watr.c ] || [ jz-watr-opt.wasm -nt watr.c ]; then
  "$WABT_DIR/bin/wasm2c" --enable-exceptions -n jzwatr -o watr.c jz-watr-opt.wasm
  # A2a: nullify wasm2c's FORCE_READ_INT/FLOAT asm barriers. They're no-clobber
  # asm("" :: "r"(var)) hints meant to force-realize a value into a register, but
  # clang treats them as barriers that defeat CSE of `instance->w2c_memory.data`
  # in hot inner loops. With them off, clang hoists `data` above the loop —
  # 12 insts/iter → 4 insts/iter on the parser's hottest function (f5, 644M calls
  # in the PGO trace). Net ~8% on parser-heavy workloads (raycast/maze/containers).
  sed -i.bak -E '
    s|^#define FORCE_READ_INT\(var\) __asm__.*$|#define FORCE_READ_INT(var)|
    s|^#define FORCE_READ_FLOAT\(var\) __asm__.*$|#define FORCE_READ_FLOAT(var)|
  ' watr.c
  rm -f watr.c.bak
  # A2b: hoist `instance->w2c_memory.data` into a function-local `__restrict__`
  # alias and shadow load/store inlines with macros that reference it. clang's
  # PGO+LTO fails to CSE the field-load across CFG joins; an explicit local
  # const-restrict alias gives it the proof it needs to keep the base in a
  # register across the entire function. f6 (206M calls): 5 reloads/iter → 1.
  awk -f "$SRC_DIR/postprocess-watr.awk" watr.c > watr.c.tmp && mv watr.c.tmp watr.c
fi

# Stage 1: instrumented build (collect PGO profile).
echo "=== Stage 1: instrumented build ==="
CFLAGS1="-O3 -march=native -flto -fomit-frame-pointer -fprofile-instr-generate $EXTRA $COMMON"
$CC $CFLAGS1 -c watr.c -o watr.o
$CC $CFLAGS1 -c harness.c -o harness.o
$CC $CFLAGS1 -c env-stubs.c -o env-stubs.o
$CC $CFLAGS1 -c wasm-rt-impl.c -o wasm-rt-impl.o
$CC $CFLAGS1 -c wasm-rt-mem-impl.c -o wasm-rt-mem-impl.o
$CC $CFLAGS1 -c wasm-rt-exceptions-stub.c -o wasm-rt-exceptions-impl.o
$CC -flto -fprofile-instr-generate -o watr-native-instr \
    watr.o harness.o env-stubs.o wasm-rt-impl.o wasm-rt-mem-impl.o wasm-rt-exceptions-impl.o \
    -lm -lpthread

# Stage 2: collect profile. Bias training toward parser-heavy workloads.
echo "=== Stage 2: collect profile ==="
rm -f default_*.profraw
EX="${EX:-/Users/div/projects/watr/test/example}"
# Heavy weight on hot parser workloads (raycast is 6ms/call; 30× = ~180ms of training).
for f in raycast.wat raytrace.wat containers.wat maze.wat snake.wat malloc.wat dino.wat; do
  LLVM_PROFILE_FILE="$(pwd)/default_%m_%p.profraw" ./watr-native-instr "$EX/$f" 30 > /dev/null
done
# Light pass over the rest for unique code-path coverage.
for f in "$EX"/*.wat; do
  LLVM_PROFILE_FILE="$(pwd)/default_%m_%p.profraw" ./watr-native-instr "$f" 3 > /dev/null
done
xcrun llvm-profdata merge -output=watr.profdata default_*.profraw
echo "profile size: $(ls -la watr.profdata | awk '{print $5}')"

# Stage 3: PGO-optimized build.
echo "=== Stage 3: PGO-optimized build ==="
CFLAGS3="-O3 -march=native -flto -fomit-frame-pointer -fprofile-instr-use=watr.profdata -mllvm -inline-threshold=10000 $EXTRA $COMMON"
$CC $CFLAGS3 -c watr.c -o watr.o 2>&1 | tail -5
$CC $CFLAGS3 -c harness.c -o harness.o
$CC $CFLAGS3 -c env-stubs.c -o env-stubs.o
$CC $CFLAGS3 -c wasm-rt-impl.c -o wasm-rt-impl.o
$CC $CFLAGS3 -c wasm-rt-mem-impl.c -o wasm-rt-mem-impl.o
$CC $CFLAGS3 -c wasm-rt-exceptions-stub.c -o wasm-rt-exceptions-impl.o
$CC -flto -fprofile-instr-use=watr.profdata -o watr-native \
    watr.o harness.o env-stubs.o wasm-rt-impl.o wasm-rt-mem-impl.o wasm-rt-exceptions-impl.o \
    -lm -lpthread
echo "Built: $(ls -la watr-native)"
