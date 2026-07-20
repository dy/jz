// slices.c — block processing over RUNTIME SUB-VIEWS of one arena: every audio engine's
// inner life (mix busses, voice blocks, delay taps) and every font table walk. Each block
// reads input at arena[inOff + i] and accumulates into a bus at arena[busOff + i], where
// both offsets are runtime values from a schedule — the compiler must hoist the bases out
// of the loop (LLVM does it without blinking). A compiler that re-derives base + i per
// access, or falls off its typed-address fast path because the base is a variable, loses
// this case by an order of magnitude. One-pole smoothing keeps a loop-carried scalar in
// flight so the loop is real DSP, not a memcpy.
//
// Single source compiled by all targets and run directly by the JS engines.
// Subset: const/let + arrows, typed arrays, no class/async/regex.
//
// Reports: median ms across N_RUNS, FNV-1a checksum over the bus (f64 bits).
#include "../_lib/bench.h"
#include <stdlib.h>

#define N        (1 << 18)   /* arena halves: input signal + mix bus */
#define NB       4096        /* scheduled blocks per pass */
#define N_ITERS  3            /* passes per kernel run */
#define N_RUNS   21
#define N_WARMUP 5

static void build_world(double* input, double* bus, int32_t* in_off, int32_t* bus_off, int32_t* len) {
  uint32_t s = 0x2f6e2b1u;
#define NEXT() (s ^= s << 13, s ^= s >> 17, s ^= s << 5, s)
  for (int i = 0; i < N; i++) input[i] = ((double)NEXT() / 4294967296.0) * 2.0 - 1.0;
  for (int i = 0; i < N; i++) bus[i] = 0.0;
  for (int b = 0; b < NB; b++) {
    int l = 64 + (int)(NEXT() % 257);          // 64..320 samples per block
    len[b] = l;
    in_off[b] = (int32_t)(NEXT() % (N - l));
    bus_off[b] = (int32_t)(NEXT() % (N - l));
  }
#undef NEXT
}

// one pass: every block smooths its input view and accumulates into its bus view
static void run_pass(const double* input, double* bus, const int32_t* in_off, const int32_t* bus_off, const int32_t* len, double gain) {
  for (int b = 0; b < NB; b++) {
    int io = in_off[b];
    int bo = bus_off[b];
    int l = len[b];
    double sm = 0.0;
    for (int i = 0; i < l; i++) {
      sm = sm * 0.995 + input[io + i] * 0.005;
      bus[bo + i] = bus[bo + i] + sm * gain;
    }
  }
}

static void run_kernel(const double* input, double* bus, const int32_t* in_off, const int32_t* bus_off, const int32_t* len) {
  for (int it = 0; it < N_ITERS; it++) run_pass(input, bus, in_off, bus_off, len, 0.25 + it * 0.125);
}

int main(void) {
  double* input = malloc(sizeof(double) * N);
  double* bus = malloc(sizeof(double) * N);
  int32_t* in_off = malloc(sizeof(int32_t) * NB);
  int32_t* bus_off = malloc(sizeof(int32_t) * NB);
  int32_t* len = malloc(sizeof(int32_t) * NB);
  double samples[N_RUNS];

  build_world(input, bus, in_off, bus_off, len);

  for (int i = 0; i < N_WARMUP; i++) run_kernel(input, bus, in_off, bus_off, len);

  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    run_kernel(input, bus, in_off, bus_off, len);
    samples[i] = now_ms() - t0;
  }

  print_result(median_us(samples, N_RUNS), checksum_f64(bus, N), NB * N_ITERS, N_ITERS, N_RUNS);
  free(input); free(bus); free(in_off); free(bus_off); free(len);
  return 0;
}
