// fftplan.c – cached-plan FFT: forward and inverse radix-2 transforms of an
// audio frame (N = 2048) through a plan built once per size, the way DSP
// libraries ship FFT.
//
// Ports fftplan.js as written. A plan is a struct holding its size, its
// bit-reversal table (uint32_t, the JS Uint32Array) and three packed per-stage
// twiddle tables (the shared cosines, the forward and the inverse sines), each
// a malloc'd buffer. makePlan builds the tables from a transcendental-free base
// table (an in-source Taylor sin/cos of 2π/n and a complex recurrence) that it
// frees once the packed tables are filled. Plans live in a singly linked list
// searched by size, the cache the JS keeps in a Map, and get_plan answers a
// repeated size from a file-scope last-plan memo first, as the JS does. The
// kernel receives the plan's buffers as pointer parameters; its butterflies
// are +/−/× in the JS's order, so the output is bit-identical everywhere.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over the final frame's real
// part (checksum_f64, benchlib's checksumF64), with the per-frame accumulator
// folded into re[0] so no frame is dead code.
#include "../_lib/bench.h"
#include <stdlib.h>

#define N 2048          // transform size: an audio frame (pvoc hop grain)
#define LOG2N 11
#define FRAMES 64       // fwd + inv round trips per timed sample
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

typedef struct Plan {
  int n;
  uint32_t* perm;
  double* tw_re;
  double* tw_fwd;
  double* tw_inv;
  struct Plan* next;
} Plan;

static Plan* cache = NULL;
static int last_n = 0;
static Plan* last_plan = NULL;

static Plan* make_plan(int n) {
  int bits = 0;
  for (int m = n; m > 1; m >>= 1) bits++;
  uint32_t* perm = malloc(sizeof(uint32_t) * n);
  for (int i = 0; i < n; i++) {
    uint32_t rev = 0, v = (uint32_t)i;
    for (int j = 0; j < bits; j++) { rev = (rev << 1) | (v & 1); v >>= 1; }
    perm[i] = rev;
  }
  // base table: cos/sin of 2π k/n for k in [0, n/2) via recurrence from 2π/n
  int half = n >> 1;
  double* base_c = malloc(sizeof(double) * half);
  double* base_s = malloc(sizeof(double) * half);
  double dt = 6.283185307179586 / n;
  double c1 = cos_poly(dt), s1 = sin_poly(dt);
  double cr = 1.0, ci = 0.0;
  for (int k = 0; k < half; k++) {
    base_c[k] = cr;
    base_s[k] = ci;
    double nr = cr * c1 - ci * s1;
    double ni = cr * s1 + ci * c1;
    cr = nr;
    ci = ni;
  }
  // packed per-stage tables: stage len keeps its half twiddles at [ti, ti+half);
  // entry j is the base entry j·(n/len)
  double* tw_re = malloc(sizeof(double) * n);
  double* tw_fwd = malloc(sizeof(double) * n);
  double* tw_inv = malloc(sizeof(double) * n);
  int ti = 0;
  for (int len = 2; len <= n; len <<= 1) {
    int h = len >> 1;
    int stride = n / len;
    for (int j = 0; j < h; j++) {
      double c = base_c[j * stride], s = base_s[j * stride];
      tw_re[ti] = c;
      tw_fwd[ti] = -s;
      tw_inv[ti] = s;
      ti++;
    }
  }
  free(base_c);
  free(base_s);
  Plan* p = malloc(sizeof(Plan));
  p->n = n;
  p->perm = perm;
  p->tw_re = tw_re;
  p->tw_fwd = tw_fwd;
  p->tw_inv = tw_inv;
  p->next = NULL;
  return p;
}

static Plan* get_plan(int n) {
  if (n == last_n) return last_plan;
  Plan* p = cache;
  while (p != NULL && p->n != n) p = p->next;
  if (p == NULL) {
    p = make_plan(n);
    p->next = cache;
    cache = p;
  }
  last_n = n;
  last_plan = p;
  return p;
}

static void free_plans(void) {
  while (cache != NULL) {
    Plan* next = cache->next;
    free(cache->perm); free(cache->tw_re); free(cache->tw_fwd); free(cache->tw_inv);
    free(cache);
    cache = next;
  }
  last_n = 0;
  last_plan = NULL;
}

// hot kernel: the tables arrive as parameters from the plan
static void transform(double* re, double* im, const uint32_t* perm, const double* tw_re, const double* tw_im, int n) {
  for (int i = 0; i < n; i++) {
    int j = (int)perm[i];
    if (i < j) {
      double tr = re[i]; re[i] = re[j]; re[j] = tr;
      double t2 = im[i]; im[i] = im[j]; im[j] = t2;
    }
  }
  int ti = 0;
  for (int len = 2; len <= n; len <<= 1) {
    int half = len >> 1;
    for (int i = 0; i < n; i += len) {
      for (int j = 0; j < half; j++) {
        double wr = tw_re[ti + j], wi = tw_im[ti + j];
        int a = i + j, b = a + half;
        double xr = re[b], xi = im[b];
        double tr = wr * xr - wi * xi;
        double t2 = wr * xi + wi * xr;
        re[b] = re[a] - tr;
        im[b] = im[a] - t2;
        re[a] = re[a] + tr;
        im[a] = im[a] + t2;
      }
    }
    ti += half;
  }
}

static void cfft(double* re, double* im, int n) {
  const Plan* plan = get_plan(n);
  transform(re, im, plan->perm, plan->tw_re, plan->tw_fwd, n);
}

static void cifft(double* re, double* im, int n) {
  const Plan* plan = get_plan(n);
  transform(re, im, plan->perm, plan->tw_re, plan->tw_inv, n);
  double inv = 1.0 / n;
  for (int i = 0; i < n; i++) { re[i] *= inv; im[i] *= inv; }
}

// Deterministic real input in [-1, 1): XorShift32, bit-identical per target.
static void mk_signal(double* out, int n) {
  uint32_t s = 0x1234abcdu;
  for (int i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    out[i] = ((double)s / 4294967296.0) * 2.0 - 1.0;
  }
}

static double frames(double* re, double* im, const double* sig) {
  double acc = 0.0;
  for (int f = 0; f < FRAMES; f++) {
    for (int i = 0; i < N; i++) { re[i] = sig[i]; im[i] = 0.0; }
    cfft(re, im, N);
    cifft(re, im, N);
    acc += re[f & (N - 1)];
  }
  return acc;
}

int main(void) {
  double* sig = malloc(sizeof(double) * N);
  double* re = malloc(sizeof(double) * N);
  double* im = malloc(sizeof(double) * N);
  double samples[N_RUNS];
  mk_signal(sig, N);

  for (int w = 0; w < N_WARMUP; w++) frames(re, im, sig);

  double acc = 0.0;
  for (int r = 0; r < N_RUNS; r++) {
    double t0 = now_ms();
    acc = frames(re, im, sig);
    samples[r] = now_ms() - t0;
  }
  re[0] = acc;  // fold the per-frame accumulator in: no frame is dead code
  print_result(median_us(samples, N_RUNS), checksum_f64(re, N), FRAMES * 2 * ((N * LOG2N) >> 1), LOG2N, N_RUNS);
  free(sig); free(re); free(im);
  free_plans();
}
