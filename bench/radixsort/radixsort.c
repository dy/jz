// radixsort.c — least-significant-digit radix sort (4 × 8-bit counting passes)
// over a u32 key array. The canonical non-comparison integer sort (databases,
// GPU/CPU key sorting, particle binning): histogram → prefix-sum → scatter,
// ping-ponging between two buffers. Its gather/scatter memory pattern is distinct
// from the suite's compare-swap heapsort, and it is pure 32-bit integer
// throughout, so the sorted output is bit-identical across every engine and
// native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Uint32Array/Int32Array, no
// class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in keys/µs, FNV-1a checksum over
// the sorted key array.
#include "../_lib/bench.h"
#include <stdlib.h>

#define N        (1 << 14)   // 16384 keys
#define RADIX    256         // 8-bit digit
#define PASSES   4           // 32-bit keys / 8-bit digits
#define N_ITERS  40          // sorts per kernel run
#define N_RUNS   21
#define N_WARMUP 5

// Deterministic u32 keys — XorShift32, identical per target.
static void fill(uint32_t* out) {
  uint32_t s = 0x1234abcdu;
  for (int i = 0; i < N; i++) {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    out[i] = s;
  }
}

// LSD radix sort: 4 stable counting-sort passes over 8-bit digits, ping-ponging
// a → b. PASSES is even, so the sorted result lands back in `src`.
static void radix_sort(uint32_t* src, uint32_t* tmp, int32_t* count) {
  uint32_t* a = src;
  uint32_t* b = tmp;
  for (int shift = 0; shift < 32; shift += 8) {
    for (int i = 0; i < RADIX; i++) count[i] = 0;
    for (int i = 0; i < N; i++) count[(a[i] >> shift) & 0xff]++;
    int32_t sum = 0;
    for (int i = 0; i < RADIX; i++) { int32_t c = count[i]; count[i] = sum; sum += c; }
    for (int i = 0; i < N; i++) {
      int d = (a[i] >> shift) & 0xff;
      b[count[d]] = a[i];
      count[d]++;
    }
    uint32_t* t = a; a = b; b = t;
  }
}

static void run_kernel(uint32_t* a, const uint32_t* base, uint32_t* tmp, int32_t* count) {
  for (int it = 0; it < N_ITERS; it++) {
    for (int i = 0; i < N; i++) a[i] = base[i] + (uint32_t)it;
    radix_sort(a, tmp, count);
  }
}

int main(void) {
  uint32_t* base  = malloc(sizeof(uint32_t) * N);
  uint32_t* a     = malloc(sizeof(uint32_t) * N);
  uint32_t* tmp   = malloc(sizeof(uint32_t) * N);
  int32_t*  count = malloc(sizeof(int32_t)  * RADIX);
  double    samples[N_RUNS];

  fill(base);
  for (int i = 0; i < N_WARMUP; i++) run_kernel(a, base, tmp, count);

  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    run_kernel(a, base, tmp, count);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), checksum_u32(a, N), N * N_ITERS, PASSES, N_RUNS);

  free(base); free(a); free(tmp); free(count);
}
