// stdlib-ddot.c – BLAS level-1 ddot (the dot product of two strided vectors)
// swept over 4096 calls through @stdlib/blas/base/ddot from stdlib 0.4.1
// (Apache-2.0; Copyright (c) The Stdlib Authors).
//
// Ported as written from the bundle stdlib-ddot.js holds: the strided entry
// point (lib/ddot.js), which turns each stride into a starting offset through
// @stdlib/strided/base/stride2offset, and the kernel it calls (lib/ndarray.js)
// with its offsets, its strides and its unit-stride path unrolled by M = 5
// after a clean-up loop over N % M, under the names stdlib's own C gives them
// (c_ddot, c_ddot_ndarray, stdlib_strided_stride2offset). Lengths, strides and
// offsets are int32_t, stdlib's default CBLAS_INT.
//
// The sweep follows the package's benchmark: two vectors of 1024 values uniform
// in [-100, 100] (XorShift32 from 0x1234abcd and 0x9e3779b9) floored to
// integers, so every product and sum is exact in any order; 4096 calls per run
// at unit strides, the length cycling from 1024 down to 1017; 5 warmup runs,
// the median of 21 timed. Checksum: benchlib checksumF64 over the 4096 dot
// products.
#include "../_lib/bench.h"
#include <math.h>
#include <stdlib.h>

#define N_IN     1024
#define N_EVAL   (1 << 12)
#define N_RUNS   21
#define N_WARMUP 5

// @stdlib/strided/base/stride2offset
static int32_t stdlib_strided_stride2offset(int32_t N, int32_t stride) {
  if (stride > 0) {
    return 0;
  }
  return (1 - N) * stride;
}

// @stdlib/blas/base/ddot: lib/ndarray.js
static const int32_t M = 5;

static double c_ddot_ndarray(int32_t N, const double *x, int32_t strideX, int32_t offsetX,
                             const double *y, int32_t strideY, int32_t offsetY) {
  double dot;
  int32_t ix;
  int32_t iy;
  int32_t m;
  int32_t i;
  dot = 0.0;
  if (N <= 0) {
    return dot;
  }
  ix = offsetX;
  iy = offsetY;
  if (strideX == 1 && strideY == 1) {
    m = N % M;
    if (m > 0) {
      for (i = 0; i < m; i++) {
        dot += x[ix] * y[iy];
        ix += 1;
        iy += 1;
      }
    }
    if (N < M) {
      return dot;
    }
    for (i = m; i < N; i += M) {
      dot += x[ix] * y[iy] + x[ix + 1] * y[iy + 1] + x[ix + 2] * y[iy + 2] + x[ix + 3] * y[iy + 3] + x[ix + 4] * y[iy + 4];
      ix += M;
      iy += M;
    }
    return dot;
  }
  for (i = 0; i < N; i++) {
    dot += x[ix] * y[iy];
    ix += strideX;
    iy += strideY;
  }
  return dot;
}

// @stdlib/blas/base/ddot: lib/ddot.js
static double c_ddot(int32_t N, const double *x, int32_t strideX, const double *y, int32_t strideY) {
  int32_t ix;
  int32_t iy;
  if (N <= 0) {
    return 0.0;
  }
  ix = stdlib_strided_stride2offset(N, strideX);
  iy = stdlib_strided_stride2offset(N, strideY);
  return c_ddot_ndarray(N, x, strideX, ix, y, strideY, iy);
}

// XorShift32, uniform in [lo, hi): deterministic per target.
static void uniform(double *out, int n, double lo, double hi, uint32_t seed) {
  uint32_t s = seed;
  for (int i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    out[i] = lo + ((double)s / 4294967296.0) * (hi - lo);
  }
}

static void sweep(const double *x, const double *y, double *out) {
  for (int i = 0; i < N_EVAL; i++) out[i] = c_ddot(N_IN - (i & 7), x, 1, y, 1);
}

int main(void) {
  double *x = malloc(sizeof(double) * N_IN);
  double *y = malloc(sizeof(double) * N_IN);
  double *out = malloc(sizeof(double) * N_EVAL);
  double samples[N_RUNS];

  uniform(x, N_IN, -100.0, 100.0, 0x1234abcdu);
  uniform(y, N_IN, -100.0, 100.0, 0x9e3779b9u);
  // exact products and sums, whatever the lane order
  for (int i = 0; i < N_IN; i++) { x[i] = floor(x[i]); y[i] = floor(y[i]); }

  for (int i = 0; i < N_WARMUP; i++) sweep(x, y, out);

  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    sweep(x, y, out);
    samples[i] = now_ms() - t0;
  }

  print_result(median_us(samples, N_RUNS), checksum_f64(out, N_EVAL), N_EVAL, 1, N_RUNS);
  free(x);
  free(y);
  free(out);
}
