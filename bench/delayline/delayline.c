// delayline.c — modulated feedback comb (flanger/chorus core) through a power-of-two
// ring buffer: the delay-line pattern under every reverb, echo and physical model. Per
// sample: an integer-LFO (triangle from a wrapping phase accumulator) sets a fractional
// delay; two taps are read at (head − d) & MASK and linearly interpolated; the feedback
// sum is written back at head & MASK. The profile: wrap-masked indexing the compiler
// must strength-reduce, a genuine loop-carried feedback (unsoftenable — it IS the
// filter), and integer→float fraction splits. The LFO fraction is q16 (÷65536), so
// every operation is exactly rounded and output is bit-identical across languages.
//
// Single source compiled by all targets and run directly by the JS engines.
// Subset: const/let + arrows, typed arrays, no class/async/regex.
//
// Reports: median ms across N_RUNS, FNV-1a checksum over the wet output (f64 bits).
#include "../_lib/bench.h"
#include <stdlib.h>

#define N        (1 << 17)   /* samples per pass */
#define RB       (1 << 14)   /* ring size */
#define MASK     (RB - 1)
#define DMIN     96           /* delay range, samples */
#define DSPAN    2000
#define N_ITERS  4
#define N_RUNS   21
#define N_WARMUP 5

static void build_input(double* input) {
  uint32_t s = 0x3c91e57u;
  for (int i = 0; i < N; i++) {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    input[i] = ((double)s / 4294967296.0) * 2.0 - 1.0;
  }
}

static void run_pass(const double* input, double* out, double* ring, double fb, uint32_t lfo_step) {
  for (int i = 0; i < RB; i++) ring[i] = 0.0;
  uint32_t head = 0;
  uint32_t lfo = 0;
  for (int i = 0; i < N; i++) {
    lfo = (lfo + lfo_step) & 0xffffffffu;
    uint32_t raw = lfo & 0x1ffffu;                          // 17-bit phase
    uint32_t tri = raw < 0x10000u ? raw : 0x20000u - raw;    // triangle 0..0x10000
    uint32_t dq = DMIN * 65536u + tri * DSPAN;               // delay in q16 samples
    uint32_t dInt = dq / 65536u;
    double dFrac = (double)(dq - dInt * 65536u) / 65536.0;   // exact: ÷2^16
    uint32_t i0 = (head - dInt) & MASK;
    uint32_t i1 = (head - dInt - 1u) & MASK;
    double tap = ring[i0] + (ring[i1] - ring[i0]) * dFrac;
    double y = input[i] + tap * fb;
    ring[head & MASK] = y;
    head = head + 1u;
    out[i] = y;
  }
}

static void run_kernel(const double* input, double* out, double* ring) {
  for (int it = 0; it < N_ITERS; it++) run_pass(input, out, ring, 0.6 + it * 0.05, 977u + (uint32_t)it * 131u);
}

int main(void) {
  double* input = malloc(sizeof(double) * N);
  double* out = malloc(sizeof(double) * N);
  double* ring = malloc(sizeof(double) * RB);
  double samples[N_RUNS];

  build_input(input);

  for (int i = 0; i < N_WARMUP; i++) run_kernel(input, out, ring);

  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    run_kernel(input, out, ring);
    samples[i] = now_ms() - t0;
  }

  print_result(median_us(samples, N_RUNS), checksum_f64(out, N), N * N_ITERS, N_ITERS, N_RUNS);
  free(input); free(out); free(ring);
  return 0;
}
