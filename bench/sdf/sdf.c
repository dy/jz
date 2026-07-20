// sdf.c — exact Euclidean distance transform (Felzenszwalb–Huttenlocher) of a glyph-like
// bitmap: the modern text-rendering pipeline's core (SDF atlases) and a staple of
// generative graphics. Two separable passes of the lower-envelope-of-parabolas algorithm:
// per row then per column, each maintaining a hull of parabola vertices in small scratch
// arrays with a data-dependent while-pop — the anti-vectorizer profile: short dependent
// loops, divisions, scratch reuse. All operations (+ − × ÷) are exactly rounded, so the
// squared-distance field is bit-identical across languages.
//
// Single source compiled by all targets and run directly by the JS engines.
// Subset: const/let + arrows, typed arrays, no class/async/regex.
//
// Reports: median ms across N_RUNS, FNV-1a checksum over the d² field (f64 bits).
#include "../_lib/bench.h"
#include <stdlib.h>

#define W        384
#define H        384
#define MAXWH    384   /* max(W, H) */
#define INF      1e20
#define N_ITERS  4
#define N_RUNS   21
#define N_WARMUP 5

static uint32_t rnd_next(uint32_t* s) {
  *s ^= *s << 13;
  *s ^= *s >> 17;
  *s ^= *s << 5;
  return *s;
}

static void build_bitmap(uint8_t* bmp) {
  uint32_t s = 0x77aa123u;
  for (int i = 0; i < W * H; i++) bmp[i] = 0;
  for (int c = 0; c < 30; c++) {
    int cx = 20 + (int)(rnd_next(&s) % (uint32_t)(W - 40));
    int cy = 20 + (int)(rnd_next(&s) % (uint32_t)(H - 40));
    int r = 6 + (int)(rnd_next(&s) % 25u);
    int r2 = r * r;
    int fill = (c % 4 == 3) ? 0 : 1;
    for (int y = cy - r; y <= cy + r; y++) {
      int dy = y - cy;
      for (int x = cx - r; x <= cx + r; x++) {
        int dx = x - cx;
        if (dx * dx + dy * dy <= r2) bmp[y * W + x] = (uint8_t)fill;
      }
    }
  }
}

// 1-D squared-distance transform of f[0..n) into d[0..n), scratch v (hull vertex
// positions, int32) and z (hull boundaries, double of length n+1)
static void edt1d(const double* f, double* d, int32_t* v, double* z, int n) {
  int k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (int q = 1; q < n; q++) {
    double sMid = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2.0 * q - 2.0 * v[k]);
    while (sMid <= z[k]) {
      k--;
      sMid = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2.0 * q - 2.0 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = sMid;
    z[k + 1] = INF;
  }
  k = 0;
  for (int q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    int dq = q - v[k];
    d[q] = (double)(dq * dq) + f[v[k]];
  }
}

static void transform(const uint8_t* bmp, double* dist, double* rowf, double* rowd, int32_t* v, double* z) {
  // seed: 0 on ink, INF on paper
  for (int i = 0; i < W * H; i++) dist[i] = bmp[i] == 1 ? 0.0 : INF;
  // columns
  for (int x = 0; x < W; x++) {
    for (int y = 0; y < H; y++) rowf[y] = dist[y * W + x];
    edt1d(rowf, rowd, v, z, H);
    for (int y = 0; y < H; y++) dist[y * W + x] = rowd[y];
  }
  // rows
  for (int y = 0; y < H; y++) {
    int off = y * W;
    for (int x = 0; x < W; x++) rowf[x] = dist[off + x];
    edt1d(rowf, rowd, v, z, W);
    for (int x = 0; x < W; x++) dist[off + x] = rowd[x];
  }
}

static void run_kernel(const uint8_t* bmp, double* dist, double* rowf, double* rowd, int32_t* v, double* z) {
  for (int it = 0; it < N_ITERS; it++) transform(bmp, dist, rowf, rowd, v, z);
}

int main(void) {
  uint8_t* bmp = malloc((size_t)W * H);
  double* dist = malloc(sizeof(double) * W * H);
  double* rowf = malloc(sizeof(double) * MAXWH);
  double* rowd = malloc(sizeof(double) * MAXWH);
  int32_t* v = malloc(sizeof(int32_t) * MAXWH);
  double* z = malloc(sizeof(double) * (MAXWH + 1));
  double samples[N_RUNS];

  build_bitmap(bmp);

  for (int i = 0; i < N_WARMUP; i++) run_kernel(bmp, dist, rowf, rowd, v, z);

  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    run_kernel(bmp, dist, rowf, rowd, v, z);
    samples[i] = now_ms() - t0;
  }

  print_result(median_us(samples, N_RUNS), checksum_f64(dist, W * H), W * H * N_ITERS, 2, N_RUNS);
  free(bmp);
  free(dist);
  free(rowf);
  free(rowd);
  free(v);
  free(z);
  return 0;
}
