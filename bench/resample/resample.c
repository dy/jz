// resample.c — fractional-rate audio resampling with 4-point Hermite (Catmull–Rom)
// interpolation: the workhorse of samplers, time-stretchers and every audio graph that
// meets two clocks. Per output sample: truncate the running phase to an integer tap,
// gather four neighbours at a COMPUTED index, evaluate the cubic, advance phase by an
// irrational-ish step. Two stages (upsample then downsample) exercise both directions.
// The profile: float-derived gather indices + a fractional accumulator — the pattern
// that decides whether a compiler keeps typed loads on the fast path when the index
// comes from float math. Pure + − × ÷, so output is bit-identical across languages.
//
// Single source compiled by all targets and run directly by the JS engines.
// Subset: const/let + arrows, typed arrays, no class/async/regex.
//
// Reports: median ms across N_RUNS, FNV-1a checksum over both stage outputs (f64 bits).
#include "../_lib/bench.h"
#include <stdlib.h>

#define N        (1 << 16)   /* input samples */
#define M_UP     89000       /* fixed output counts (fit within phase range) */
#define M_DN     49000
#define N_ITERS  5
#define N_RUNS   21
#define N_WARMUP 5

static const double STEP_UP = 0.7317314443021356;   // rate < 1: output longer (upsample)
static const double STEP_DN = 1.3186248722190522;   // rate > 1: output shorter (downsample)

static void build_input(double* input) {
  uint32_t s = 0x6d2f4b1u;
  for (int i = 0; i < N; i++) {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    input[i] = ((double)s / 4294967296.0) * 2.0 - 1.0;
  }
}

// 4-point, 3rd-order Hermite (Catmull–Rom): y(f) around x1 with neighbours x0..x3
static void resample_pass(const double* input, double* out, int m, double step) {
  double phase = 1.0;
  for (int k = 0; k < m; k++) {
    int idx = (int)phase;                    // exact truncation — phase stays well below 2^31
    double f = phase - idx;
    double x0 = input[idx - 1];
    double x1 = input[idx];
    double x2 = input[idx + 1];
    double x3 = input[idx + 2];
    double c0 = x1;
    double c1 = 0.5 * (x2 - x0);
    double c2 = x0 - 2.5 * x1 + 2.0 * x2 - 0.5 * x3;
    double c3 = 0.5 * (x3 - x0) + 1.5 * (x1 - x2);
    out[k] = ((c3 * f + c2) * f + c1) * f + c0;
    phase += step;
  }
}

static void run_kernel(const double* input, double* up, double* dn) {
  for (int it = 0; it < N_ITERS; it++) {
    resample_pass(input, up, M_UP, STEP_UP);
    resample_pass(up, dn, M_DN, STEP_DN);
  }
}

int main(void) {
  double* input = malloc(sizeof(double) * N);
  double* up = malloc(sizeof(double) * M_UP);
  double* dn = malloc(sizeof(double) * M_DN);
  double samples[N_RUNS];

  build_input(input);

  for (int i = 0; i < N_WARMUP; i++) run_kernel(input, up, dn);

  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    run_kernel(input, up, dn);
    samples[i] = now_ms() - t0;
  }

  uint32_t cs = checksum_f64(up, M_UP) ^ checksum_f64(dn, M_DN);
  print_result(median_us(samples, N_RUNS), cs, (M_UP + M_DN) * N_ITERS, 2, N_RUNS);
  free(input); free(up); free(dn);
  return 0;
}
