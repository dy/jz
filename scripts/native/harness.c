// Harness for jz-compiled watr.wasm via wasm2c.
// Usage: ./watr-native <file.wat> [iterations]
#include "watr.h"
#include "wasm-rt-impl.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>

static inline f64 make_ptr(u32 type, u32 aux, u32 offset) {
  union { u64 u; f64 d; } v;
  u32 hi = 0x7FF80000u | ((type & 0xF) << 15) | (aux & 0x7FFF);
  v.u = ((u64)hi << 32) | (u64)offset;
  return v.d;
}
static inline u32 get_offset(f64 p) { union { u64 u; f64 d; } v; v.d = p; return (u32)(v.u & 0xFFFFFFFFu); }
static inline u32 get_type(f64 p)   { union { u64 u; f64 d; } v; v.d = p; return ((u32)(v.u >> 32) >> 15) & 0xF; }

static char* read_file(const char* path, size_t* lenOut) {
  FILE* f = fopen(path, "rb");
  if (!f) { fprintf(stderr, "cannot open %s\n", path); exit(1); }
  fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
  char* buf = (char*)malloc(n + 1);
  size_t got = fread(buf, 1, n, f); (void)got; buf[n] = 0; fclose(f);
  *lenOut = (size_t)n;
  return buf;
}

static double now_sec(void) {
  struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec + ts.tv_nsec * 1e-9;
}

int main(int argc, char** argv) {
  if (argc < 2) { fprintf(stderr, "usage: %s <file.wat> [iterations]\n", argv[0]); return 1; }
  size_t wat_len; char* wat = read_file(argv[1], &wat_len);
  int iters = argc >= 3 ? atoi(argv[2]) : 20;

  wasm_rt_init();
  w2c_jzwatr inst;
  wasm2c_jzwatr_instantiate(&inst, NULL);

  // Warmup + correctness
  wasm_rt_trap_t tcode = (wasm_rt_trap_t)WASM_RT_SETJMP(g_wasm_rt_jmp_buf);
  if (tcode) { fprintf(stderr, "TRAP warmup: %s\n", wasm_rt_strerror(tcode)); return 2; }
  wasm_rt_memory_t* mem = w2c_jzwatr_memory(&inst);

  u32 raw = w2c_jzwatr_0x5Falloc(&inst, (u32)(4 + wat_len));
  uint32_t lenLE = (uint32_t)wat_len;
  memcpy(mem->data + raw, &lenLE, 4);
  memcpy(mem->data + raw + 4, wat, wat_len);
  f64 outPtr = w2c_jzwatr_default(&inst, make_ptr(4, 0, raw + 4));
  u32 outType = get_type(outPtr), outOff = get_offset(outPtr);
  uint32_t outLen = 0;
  if (outType == 2 || outType == 3) memcpy(&outLen, mem->data + outOff - 8, 4);
  else { fprintf(stderr, "unexpected out type=%u\n", outType); return 3; }

  fprintf(stderr, "input=%zu B, output=%u B, type=%u\n", wat_len, outLen, outType);

  // Warmup
  for (int w = 0; w < 3; w++) {
    tcode = (wasm_rt_trap_t)WASM_RT_SETJMP(g_wasm_rt_jmp_buf);
    if (tcode) { fprintf(stderr, "TRAP warmup%d: %s\n", w, wasm_rt_strerror(tcode)); return 4; }
    mem = w2c_jzwatr_memory(&inst);
    u32 r = w2c_jzwatr_0x5Falloc(&inst, (u32)(4 + wat_len));
    memcpy(mem->data + r, &lenLE, 4);
    memcpy(mem->data + r + 4, wat, wat_len);
    (void)w2c_jzwatr_default(&inst, make_ptr(4, 0, r + 4));
  }

  // Collect per-iter timings; take median to be robust to OS-level jitter
  // (page faults, TLB shootdowns). Re-instantiate every `batch` iters to
  // prevent bump-heap accumulation: even with 256MB headroom the working
  // set grows monotonically because watr's bump-allocator never frees,
  // and TLB+L2 pressure makes later iters measurably slower.
  int batch = 5;
  int total = iters * 3;
  double* samples = (double*)malloc(total * sizeof(double));
  int nsamp = 0;
  for (int rep = 0; rep < 3; rep++) {
    for (int i = 0; i < iters; i++) {
      if (i % batch == 0) {
        wasm2c_jzwatr_free(&inst);
        wasm2c_jzwatr_instantiate(&inst, NULL);
      }
      tcode = (wasm_rt_trap_t)WASM_RT_SETJMP(g_wasm_rt_jmp_buf);
      if (tcode) { fprintf(stderr, "TRAP iter=%d: %s\n", i, wasm_rt_strerror(tcode)); return 4; }
      mem = w2c_jzwatr_memory(&inst);
      double t0 = now_sec();
      u32 r2 = w2c_jzwatr_0x5Falloc(&inst, (u32)(4 + wat_len));
      memcpy(mem->data + r2, &lenLE, 4);
      memcpy(mem->data + r2 + 4, wat, wat_len);
      (void)w2c_jzwatr_default(&inst, make_ptr(4, 0, r2 + 4));
      samples[nsamp++] = (now_sec() - t0) * 1000.0;
    }
  }
  // Sort and pick median
  for (int i = 1; i < nsamp; i++) {
    double v = samples[i]; int j = i - 1;
    while (j >= 0 && samples[j] > v) { samples[j+1] = samples[j]; j--; }
    samples[j+1] = v;
  }
  double best = samples[nsamp / 2];
  free(samples);
  printf("%s\t%zu\t%u\t%.3f\n", argv[1], wat_len, outLen, best);

  wasm2c_jzwatr_free(&inst);
  wasm_rt_free();
  free(wat);
  return 0;
}
