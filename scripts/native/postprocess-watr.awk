# Post-process wasm2c-generated watr.c for A2b: hoist memory base into a function-local
# __restrict__ alias, and shadow load/store helpers with macros that use it.
#
# Why: clang's PGO+LTO fails to CSE `instance->w2c_memory.data` across basic blocks
# even when no `memory.grow` could intervene. With `_md` as a function-local
# `const __restrict__` pointer, the compiler hoists the field load above the
# entire function and keeps `_md` in a register — even across joins.
#
# Two transforms:
#   1. After the wasm2c DEFINE_STORE block, insert macros that shadow i32_load,
#      f64_load, etc. so each call site uses `_md + addr` directly.
#   2. After the opening `{` of every function whose first parameter is
#      `w2c_jzwatr* instance`, declare `_md`. Functions that don't access memory
#      keep an unused const local — DCE'd at -O3 with no register cost.

BEGIN { injected = 0 }

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

# Inject _md = instance->w2c_memory.data at the body of every function whose first
# parameter is `w2c_jzwatr* instance`. Match definition (line ends with `) {`),
# skip declarations (line ends with `);`).
/^[a-zA-Z][a-zA-Z0-9_ ]* w2c_jzwatr_[a-zA-Z0-9_]*\(w2c_jzwatr\* instance.*\) \{$/ {
  print
  print "  __attribute__((unused)) u8* const __restrict__ _md = instance->w2c_memory.data;"
  next
}
# Same pattern but for static functions (struct return type also possible).
/^static [a-zA-Z][a-zA-Z0-9_ ]* w2c_jzwatr_[a-zA-Z0-9_]*\(w2c_jzwatr\* instance.*\) \{$/ {
  print
  print "  __attribute__((unused)) u8* const __restrict__ _md = instance->w2c_memory.data;"
  next
}
# struct return form: `static struct wasm_multi_xx fname(w2c_jzwatr* instance...) {`
/^static struct [a-zA-Z_0-9]+ w2c_jzwatr_[a-zA-Z0-9_]*\(w2c_jzwatr\* instance.*\) \{$/ {
  print
  print "  __attribute__((unused)) u8* const __restrict__ _md = instance->w2c_memory.data;"
  next
}

{ print }

END {
  if (!injected) {
    print "ERROR: postprocess-watr.awk failed to find DEFINE_STORE block" > "/dev/stderr"
    exit 1
  }
}
