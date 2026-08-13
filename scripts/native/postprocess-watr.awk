# Post-process any jz wasm2c output for native-speed lowering:
#   A2a. Remove WABT's FORCE_READ asm barriers.
#   A2b. Hoist linear-memory data into a function-local __restrict__ alias and
#        shadow scalar load/store helpers with macros that use it.
#
# Why: clang's PGO+LTO fails to CSE `instance->w2c_memory.data` across basic blocks
# even when no `memory.grow` could intervene. With `_md` as a function-local
# `const __restrict__` pointer, the compiler hoists the field load above the
# entire function and keeps `_md` in a register — even across joins.
#
# Three transforms:
#   1. Nullify FORCE_READ_INT/FLOAT definitions containing inline asm.
#   2. After the wasm2c DEFINE_STORE block, insert macros that shadow i32_load,
#      f64_load, etc. so each call site uses `_md + addr` directly.
#   3. After the opening `{` of every generated module function whose first
#      parameter is `w2c_<module>* instance`, declare `_md`. Functions that don't access memory
#      keep an unused const local — DCE'd at -O3 with no register cost.

function inject_memory_base() {
  print "  __attribute__((unused)) u8* const __restrict__ _md = instance->w2c_memory.data;"
  functions++
}

BEGIN { injected = 0; saw_simd = 0; simd_injected = 0; functions = 0; pending_function = 0 }

# WABT emits one GNU-asm definition for integers and one architecture-selected
# definition for floats. They force each loaded value through a register and act
# as optimizer barriers in clang; an empty macro preserves the generated calls.
/^#define FORCE_READ_INT\(var\) __asm__/ { print "#define FORCE_READ_INT(var)"; next }
/^#define FORCE_READ_FLOAT\(var\) __asm__/ { print "#define FORCE_READ_FLOAT(var)"; next }
/^#define SIMD_FORCE_READ\(var\) __asm__/ { saw_simd = 1; print "#define SIMD_FORCE_READ(var)"; next }

# Detect end of DEFINE_STORE block (last DEFINE_STORE line). Insert overrides after.
/^DEFINE_STORE\(i64_store32,/ {
  print
  print ""
  print "/* A2b: shadow wasm2c load/store inlines with macros that use the function-local"
  print " * `_md` (== instance->w2c_memory.data, __restrict__). Lets clang hoist the data"
  print " * base above each function and keep it live in a register across CFG joins. */"
  print "#define i32_load(mem, addr)        ({ u32 _r; __builtin_memcpy(&_r, _md + (addr), 4); _r; })"
  print "#define i64_load(mem, addr)        ({ u64 _r; __builtin_memcpy(&_r, _md + (addr), 8); _r; })"
  print "#define f32_load(mem, addr)        ({ f32 _r; __builtin_memcpy(&_r, _md + (addr), 4); _r; })"
  print "#define f64_load(mem, addr)        ({ f64 _r; __builtin_memcpy(&_r, _md + (addr), 8); _r; })"
  print "#define i32_load8_s(mem, addr)     ((u32)(s32)(s8)(_md)[(addr)])"
  print "#define i32_load8_u(mem, addr)     ((u32)(_md)[(addr)])"
  print "#define i64_load8_s(mem, addr)     ((u64)(s64)(s8)(_md)[(addr)])"
  print "#define i64_load8_u(mem, addr)     ((u64)(_md)[(addr)])"
  print "#define i32_load16_s(mem, addr)    ({ u16 _t; __builtin_memcpy(&_t, _md + (addr), 2); (u32)(s32)(s16)_t; })"
  print "#define i32_load16_u(mem, addr)    ({ u16 _t; __builtin_memcpy(&_t, _md + (addr), 2); (u32)_t; })"
  print "#define i64_load16_s(mem, addr)    ({ u16 _t; __builtin_memcpy(&_t, _md + (addr), 2); (u64)(s64)(s16)_t; })"
  print "#define i64_load16_u(mem, addr)    ({ u16 _t; __builtin_memcpy(&_t, _md + (addr), 2); (u64)_t; })"
  print "#define i64_load32_s(mem, addr)    ({ u32 _t; __builtin_memcpy(&_t, _md + (addr), 4); (u64)(s64)(s32)_t; })"
  print "#define i64_load32_u(mem, addr)    ({ u32 _t; __builtin_memcpy(&_t, _md + (addr), 4); (u64)_t; })"
  print "#define i32_store(mem, addr, val)  do { u32 _v = (u32)(val); __builtin_memcpy(_md + (addr), &_v, 4); } while (0)"
  print "#define i64_store(mem, addr, val)  do { u64 _v = (u64)(val); __builtin_memcpy(_md + (addr), &_v, 8); } while (0)"
  print "#define f32_store(mem, addr, val)  do { f32 _v = (f32)(val); __builtin_memcpy(_md + (addr), &_v, 4); } while (0)"
  print "#define f64_store(mem, addr, val)  do { f64 _v = (f64)(val); __builtin_memcpy(_md + (addr), &_v, 8); } while (0)"
  print "#define i32_store8(mem, addr, val) (_md[(addr)] = (u8)(val))"
  print "#define i64_store8(mem, addr, val) (_md[(addr)] = (u8)(val))"
  print "#define i32_store16(mem, addr, val) do { u16 _v = (u16)(val); __builtin_memcpy(_md + (addr), &_v, 2); } while (0)"
  print "#define i64_store16(mem, addr, val) do { u16 _v = (u16)(val); __builtin_memcpy(_md + (addr), &_v, 2); } while (0)"
  print "#define i64_store32(mem, addr, val) do { u32 _v = (u32)(val); __builtin_memcpy(_md + (addr), &_v, 4); } while (0)"
  injected = 1
  next
}

# SIMD helpers are declared later than the scalar DEFINE_LOAD/STORE block, so
# shadow them only after WABT's SIMD definitions and endian aliases finish.
# These are the full-vector/splat/widening forms jz emits; keeping `_md` in the
# call sites removes 3 memory-base reloads per v128 load/store on clang/arm64.
/^\/\/ clang-format on$/ {
  print
  print ""
  print "/* Native SIMD memory access through the same hoisted, stable base. */"
  print "#define v128_load(mem, addr)          simde_wasm_v128_load(_md + (addr))"
  print "#define v128_load8_splat(mem, addr)   simde_wasm_v128_load8_splat(_md + (addr))"
  print "#define v128_load16_splat(mem, addr)  simde_wasm_v128_load16_splat(_md + (addr))"
  print "#define v128_load32_splat(mem, addr)  simde_wasm_v128_load32_splat(_md + (addr))"
  print "#define v128_load64_splat(mem, addr)  simde_wasm_v128_load64_splat(_md + (addr))"
  print "#define i16x8_load8x8(mem, addr)      simde_wasm_i16x8_load8x8(_md + (addr))"
  print "#define u16x8_load8x8(mem, addr)      simde_wasm_u16x8_load8x8(_md + (addr))"
  print "#define i32x4_load16x4(mem, addr)     simde_wasm_i32x4_load16x4(_md + (addr))"
  print "#define u32x4_load16x4(mem, addr)     simde_wasm_u32x4_load16x4(_md + (addr))"
  print "#define i64x2_load32x2(mem, addr)     simde_wasm_i64x2_load32x2(_md + (addr))"
  print "#define u64x2_load32x2(mem, addr)     simde_wasm_u64x2_load32x2(_md + (addr))"
  print "#define v128_load32_zero(mem, addr)   v128_impl_load32_zero(_md + (addr))"
  print "#define v128_load64_zero(mem, addr)   v128_impl_load64_zero(_md + (addr))"
  print "#define v128_store(mem, addr, value)  simde_wasm_v128_store(_md + (addr), (value))"
  simd_injected = 1
  next
}

# Inject only generated `w2c_<module>_<function>` definitions. This excludes
# init_globals/init_memories and public wasm2c_* lifecycle functions, whose
# instance memory may not have been initialized yet. The return type may be a
# scalar, pointer, or `struct wasm_multi_*`.
/^[a-zA-Z].* w2c_[a-zA-Z0-9_]+\(w2c_[a-zA-Z0-9_]+ *\* *instance/ {
  print
  if ($0 ~ /\)[[:space:]]*\{[[:space:]]*$/) inject_memory_base()
  else if ($0 !~ /;[[:space:]]*$/) pending_function = 1
  next
}

# wasm2c wraps long parameter lists. The instance parameter remains on the
# first line; inject only when the eventual definition brace is reached.
pending_function {
  print
  if ($0 ~ /\)[[:space:]]*\{[[:space:]]*$/) {
    inject_memory_base()
    pending_function = 0
  } else if ($0 ~ /;[[:space:]]*$/) pending_function = 0
  next
}

{ print }

END {
  if (!injected) {
    print "ERROR: postprocess-watr.awk failed to find wasm2c DEFINE_STORE block" > "/dev/stderr"
    exit 1
  }
  if (!functions) {
    print "ERROR: postprocess-watr.awk failed to find generated w2c module functions" > "/dev/stderr"
    exit 1
  }
  if (saw_simd && !simd_injected) {
    print "ERROR: postprocess-watr.awk failed to find wasm2c SIMD helper boundary" > "/dev/stderr"
    exit 1
  }
  if (pending_function) {
    print "ERROR: postprocess-watr.awk ended inside a generated function signature" > "/dev/stderr"
    exit 1
  }
}
