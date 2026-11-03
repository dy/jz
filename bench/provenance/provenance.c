// provenance.c – one radix-2 FFT kernel (N = 2048) run over four bit-identical
// twiddle tables that differ only in how they reach it.
//
// Ports provenance.js as written. The four provenances are where the table
// pointers come from:
//   ret    mk_tw_re / mk_tw_im each return a malloc'd buffer
//   field  mk_tw_pair returns a TwPair struct by value; the kernel reads its
//          fields
//   map    get_cached returns a TwPair cached by size in a singly linked list
//          searched by n, the cache the JS keeps in a Map
//   memo   get_memo returns a file-scope TwPair that it replaces when the size
//          changes, the JS's module-global last-plan memo
// Each maker builds both tables, as the JS does, and frees the one it does not
// return. The tables come from an in-source Taylor sin/cos of the base angle
// and a complex recurrence (no libm), and the butterflies are +/−/× in the JS's
// order, so the output is bit-identical everywhere. The JS's edge and runAll
// closures are functions that take the buffers they capture as parameters.
//
// Reports: median µs across N_RUNS, an FNV-1a hash of re[7] (scaled by 2^20,
// truncated to int32) after every transform of every edge.
#include "../_lib/bench.h"
#include <stdlib.h>

#define N 2048
#define LOG2N 11
#define FRAMES 24       // transforms per edge per timed sample
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

// Fill wre/wim with W_k = exp(-i·2πk/N) for k in [0, N/2): recurrence, no libm.
static void fill_tw(double* wre, double* wim, int n) {
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

// --- the four provenance edges (identical table content) --------------------
typedef struct { double* wre; double* wim; } TwPair;

static double* mk_tw_re(int n) {
  double* wre = malloc(sizeof(double) * (n >> 1));
  double* wim = malloc(sizeof(double) * (n >> 1));
  fill_tw(wre, wim, n);
  free(wim);
  return wre;
}

static double* mk_tw_im(int n) {
  double* wre = malloc(sizeof(double) * (n >> 1));
  double* wim = malloc(sizeof(double) * (n >> 1));
  fill_tw(wre, wim, n);
  free(wre);
  return wim;
}

static TwPair mk_tw_pair(int n) {
  TwPair p = { malloc(sizeof(double) * (n >> 1)), malloc(sizeof(double) * (n >> 1)) };
  fill_tw(p.wre, p.wim, n);
  return p;
}

typedef struct Cached { int n; TwPair pair; struct Cached* next; } Cached;
static Cached* cache = NULL;

static const TwPair* get_cached(int n) {
  Cached* c = cache;
  while (c != NULL && c->n != n) c = c->next;
  if (c == NULL) {
    c = malloc(sizeof(Cached));
    c->n = n;
    c->pair = mk_tw_pair(n);
    c->next = cache;
    cache = c;
  }
  return &c->pair;
}

static int last_n = 0;
static TwPair last_plan = { NULL, NULL };

static const TwPair* get_memo(int n) {
  if (n == last_n) return &last_plan;
  free(last_plan.wre);
  free(last_plan.wim);
  last_plan = mk_tw_pair(n);
  last_n = n;
  return &last_plan;
}

// --- hot kernel: same butterflies as the fft case ---------------------------
static void transform(double* re, double* im, const double* wre, const double* wim, int n) {
  for (int i = 1, j = 0; i < n; i++) {
    int bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      double tr = re[i]; re[i] = re[j]; re[j] = tr;
      double t2 = im[i]; im[i] = im[j]; im[j] = t2;
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
        double t2 = wr * xi + wi * xr;
        re[b] = re[a] - tr;
        im[b] = im[a] - t2;
        re[a] = re[a] + tr;
        im[a] = im[a] + t2;
      }
    }
  }
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

static uint32_t edge(double* re, double* im, const double* sig, const double* wre, const double* wim, uint32_t h) {
  for (int f = 0; f < FRAMES; f++) {
    for (int i = 0; i < N; i++) { re[i] = sig[i]; im[i] = 0.0; }
    transform(re, im, wre, wim, N);
    h = mix_u32(h, (uint32_t)(int32_t)(re[7] * 1048576.0));
  }
  return h;
}

static uint32_t run_all(double* re, double* im, const double* sig,
                        const double* wre_ret, const double* wim_ret,
                        TwPair pair, const TwPair* cached, const TwPair* memo) {
  uint32_t h = 0x811c9dc5u;
  h = edge(re, im, sig, wre_ret, wim_ret, h);
  h = edge(re, im, sig, pair.wre, pair.wim, h);
  h = edge(re, im, sig, cached->wre, cached->wim, h);
  h = edge(re, im, sig, memo->wre, memo->wim, h);
  return h;
}

int main(void) {
  double* sig = malloc(sizeof(double) * N);
  double* re = malloc(sizeof(double) * N);
  double* im = malloc(sizeof(double) * N);
  double samples[N_RUNS];
  mk_signal(sig, N);

  // edge 1: direct returns
  double* wre_ret = mk_tw_re(N);
  double* wim_ret = mk_tw_im(N);
  // edge 2: returned-struct fields
  TwPair pair = mk_tw_pair(N);
  // edge 3: cached-plan fields
  const TwPair* cached = get_cached(N);
  // edge 4: file-scope memo fields
  const TwPair* memo = get_memo(N);

  uint32_t cs = 0;
  for (int w = 0; w < N_WARMUP; w++) cs = run_all(re, im, sig, wre_ret, wim_ret, pair, cached, memo);

  for (int r = 0; r < N_RUNS; r++) {
    double t0 = now_ms();
    cs = run_all(re, im, sig, wre_ret, wim_ret, pair, cached, memo);
    samples[r] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), cs, 4 * FRAMES * ((N * LOG2N) >> 1), 4, N_RUNS);

  free(sig); free(re); free(im);
  free(wre_ret); free(wim_ret);
  free(pair.wre); free(pair.wim);
  while (cache != NULL) {
    Cached* next = cache->next;
    free(cache->pair.wre); free(cache->pair.wim);
    free(cache);
    cache = next;
  }
  free(last_plan.wre); free(last_plan.wim);
}
