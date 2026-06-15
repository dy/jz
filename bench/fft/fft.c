#include "../_lib/bench.h"
#include <stdlib.h>

#define N (1 << 16)
#define LOG2N 16
#define N_RUNS 21
#define N_WARMUP 5

static double sin_poly(double x) {
  double x2 = x * x;
  return x * (1.0 + x2 * (-0.16666666666666666 + x2 * (0.008333333333333333 + x2 * (-0.0001984126984126984 + x2 * (2.7557319223985893e-06 + x2 * -2.505210838544172e-08)))));
}
static double cos_poly(double x) {
  double x2 = x * x;
  return 1.0 + x2 * (-0.5 + x2 * (0.041666666666666664 + x2 * (-0.001388888888888889 + x2 * (2.48015873015873e-05 + x2 * -2.7557319223985894e-07))));
}

static void build_twiddles(double* wre, double* wim, int n) {
  double dt = -6.283185307179586 / n;
  double c1 = cos_poly(dt), s1 = sin_poly(dt);
  double cr = 1.0, ci = 0.0;
  int half = n >> 1;
  for (int k = 0; k < half; k++) {
    wre[k] = cr;
    wim[k] = ci;
    double nr = cr * c1 - ci * s1;
    double ni = cr * s1 + ci * c1;
    cr = nr;
    ci = ni;
  }
}

static void fft(double* re, double* im, const double* wre, const double* wim, int n) {
  for (int i = 1, j = 0; i < n; i++) {
    int bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      double tr = re[i]; re[i] = re[j]; re[j] = tr;
      double ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (int len = 2; len <= n; len <<= 1) {
    int half = len >> 1;
    int step = n / len;
    for (int i = 0; i < n; i += len) {
      for (int j = 0, k = 0; j < half; j++, k += step) {
        double wr = wre[k], wi = wim[k];
        int a = i + j, b = a + half;
        double xr = re[b], xi = im[b];
        double tr = wr * xr - wi * xi;
        double ti = wr * xi + wi * xr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] = re[a] + tr;
        im[a] = im[a] + ti;
      }
    }
  }
}

static void mk_signal(double* out, int n) {
  uint32_t s = 0x1234abcdu;
  for (int i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    out[i] = ((double)s / 4294967296.0) * 2.0 - 1.0;
  }
}

int main(void) {
  double* sig = malloc(sizeof(double) * N);
  double* re = malloc(sizeof(double) * N);
  double* im = malloc(sizeof(double) * N);
  double* wre = malloc(sizeof(double) * (N >> 1));
  double* wim = malloc(sizeof(double) * (N >> 1));
  double samples[N_RUNS];
  mk_signal(sig, N);
  build_twiddles(wre, wim, N);

  for (int w = 0; w < N_WARMUP; w++) {
    for (int i = 0; i < N; i++) { re[i] = sig[i]; im[i] = 0.0; }
    fft(re, im, wre, wim, N);
  }
  for (int r = 0; r < N_RUNS; r++) {
    for (int i = 0; i < N; i++) { re[i] = sig[i]; im[i] = 0.0; }
    double t0 = now_ms();
    fft(re, im, wre, wim, N);
    samples[r] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), checksum_f64(re, N), (N * LOG2N) >> 1, LOG2N, N_RUNS);
  free(sig); free(re); free(im); free(wre); free(wim);
}
