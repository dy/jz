// bezfit.c — least-squares cubic Bézier fitting over digitized point runs: the heart of
// bitmap→vector conversion and font autotracing (Schneider's algorithm, as in potrace /
// FontForge). Per run: chord-length parameterize, estimate end tangents, solve the 2×2
// normal equations for the two inner control points (Bernstein-basis integrals), then one
// Newton–Raphson reparameterization pass and a second solve. Small hot loops over short
// runs, mixed dot products and per-point polynomial evaluation, division and sqrt only —
// every operation exactly rounded, so control points are bit-identical across languages.
//
// Single source compiled by all targets and run directly by the JS engines.
// Subset: const/let + arrows, typed arrays, no class/async/regex.
//
// Reports: median ms across N_RUNS, FNV-1a checksum over fitted control points (f64 bits).
#include "../_lib/bench.h"
#include <math.h>
#include <stdlib.h>

#define RUNS     256
#define K        48
#define N_ITERS  6
#define N_RUNS   21
#define N_WARMUP 5

static uint32_t rnd_next(uint32_t* s) {
  *s ^= *s << 13;
  *s ^= *s >> 17;
  *s ^= *s << 5;
  return *s;
}

// deterministic wobbly strokes: cubic polynomial paths + small xorshift jitter
static void build_runs(double* pts) {
  uint32_t s = 0x9b3f017u;
  for (int r = 0; r < RUNS; r++) {
    double ax = (double)(rnd_next(&s) % 1000u) * 0.1;
    double ay = (double)(rnd_next(&s) % 1000u) * 0.1;
    double bx = ((double)(rnd_next(&s) % 2000u) - 1000.0) * 0.05;
    double by = ((double)(rnd_next(&s) % 2000u) - 1000.0) * 0.05;
    double cx = ((double)(rnd_next(&s) % 2000u) - 1000.0) * 0.003;
    double cy = ((double)(rnd_next(&s) % 2000u) - 1000.0) * 0.003;
    for (int i = 0; i < K; i++) {
      double t = (double)i / (double)(K - 1);
      double j = ((double)(rnd_next(&s) % 100u) - 50.0) * 0.002;
      pts[(r * K + i) * 2] = ax + bx * t * 10.0 + cx * t * t * 100.0 + j;
      pts[(r * K + i) * 2 + 1] = ay + by * t * 10.0 + cy * t * t * t * 100.0 - j;
    }
  }
}

// Bernstein basis
static double b0(double t) { double u = 1.0 - t; return u * u * u; }
static double b1(double t) { double u = 1.0 - t; return 3.0 * t * u * u; }
static double b2(double t) { double u = 1.0 - t; return 3.0 * t * t * u; }
static double b3(double t) { return t * t * t; }

// fit one run [o, o+K) given parameter values u[]; writes 8 control values into ctrl at co
static void fit_once(const double* pts, int o, const double* u, double* ctrl, int co) {
  double x0 = pts[o * 2], y0 = pts[o * 2 + 1];
  double x3 = pts[(o + K - 1) * 2], y3 = pts[(o + K - 1) * 2 + 1];
  // end tangents from first/last chords, normalized
  double t1x = pts[(o + 1) * 2] - x0, t1y = pts[(o + 1) * 2 + 1] - y0;
  double l = sqrt(t1x * t1x + t1y * t1y); if (l < 1e-12) l = 1.0;
  t1x /= l; t1y /= l;
  double t2x = pts[(o + K - 2) * 2] - x3, t2y = pts[(o + K - 2) * 2 + 1] - y3;
  l = sqrt(t2x * t2x + t2y * t2y); if (l < 1e-12) l = 1.0;
  t2x /= l; t2y /= l;
  // normal equations for alpha1, alpha2 (Schneider): A_i = tangent · basis
  double c00 = 0.0, c01 = 0.0, c11 = 0.0, xr1 = 0.0, xr2 = 0.0;
  for (int i = 0; i < K; i++) {
    double t = u[i];
    double a1x = t1x * b1(t), a1y = t1y * b1(t);
    double a2x = t2x * b2(t), a2y = t2y * b2(t);
    double sx = pts[(o + i) * 2] - (x0 * (b0(t) + b1(t)) + x3 * (b2(t) + b3(t)));
    double sy = pts[(o + i) * 2 + 1] - (y0 * (b0(t) + b1(t)) + y3 * (b2(t) + b3(t)));
    c00 += a1x * a1x + a1y * a1y;
    c01 += a1x * a2x + a1y * a2y;
    c11 += a2x * a2x + a2y * a2y;
    xr1 += a1x * sx + a1y * sy;
    xr2 += a2x * sx + a2y * sy;
  }
  double det = c00 * c11 - c01 * c01;
  if (det < 1e-12 && det > -1e-12) det = 1e-12;
  double alpha1 = (xr1 * c11 - xr2 * c01) / det;
  double alpha2 = (xr2 * c00 - xr1 * c01) / det;
  ctrl[co] = x0; ctrl[co + 1] = y0;
  ctrl[co + 2] = x0 + t1x * alpha1; ctrl[co + 3] = y0 + t1y * alpha1;
  ctrl[co + 4] = x3 + t2x * alpha2; ctrl[co + 5] = y3 + t2y * alpha2;
  ctrl[co + 6] = x3; ctrl[co + 7] = y3;
}

// one Newton–Raphson step per point: move u_i toward the curve's closest approach
static void reparam(const double* pts, int o, double* u, const double* ctrl, int co) {
  double p0x = ctrl[co], p0y = ctrl[co + 1], p1x = ctrl[co + 2], p1y = ctrl[co + 3];
  double p2x = ctrl[co + 4], p2y = ctrl[co + 5], p3x = ctrl[co + 6], p3y = ctrl[co + 7];
  for (int i = 1; i < K - 1; i++) {
    double t = u[i];
    double qx = p0x * b0(t) + p1x * b1(t) + p2x * b2(t) + p3x * b3(t);
    double qy = p0y * b0(t) + p1y * b1(t) + p2y * b2(t) + p3y * b3(t);
    double un = 1.0 - t;
    double d1x = 3.0 * (un * un * (p1x - p0x) + 2.0 * un * t * (p2x - p1x) + t * t * (p3x - p2x));
    double d1y = 3.0 * (un * un * (p1y - p0y) + 2.0 * un * t * (p2y - p1y) + t * t * (p3y - p2y));
    double d2x = 6.0 * (un * (p2x - 2.0 * p1x + p0x) + t * (p3x - 2.0 * p2x + p1x));
    double d2y = 6.0 * (un * (p2y - 2.0 * p1y + p0y) + t * (p3y - 2.0 * p2y + p1y));
    double dx = qx - pts[(o + i) * 2], dy = qy - pts[(o + i) * 2 + 1];
    double num = dx * d1x + dy * d1y;
    double den = d1x * d1x + d1y * d1y + dx * d2x + dy * d2y;
    if (den > 1e-12 || den < -1e-12) {
      double nu = t - num / den;
      if (nu < 0.0) nu = 0.0;
      if (nu > 1.0) nu = 1.0;
      u[i] = nu;
    }
  }
}

static void run_kernel(const double* pts, double* u, double* ctrl) {
  for (int it = 0; it < N_ITERS; it++) {
    for (int r = 0; r < RUNS; r++) {
      int o = r * K;
      // chord-length parameterization
      u[0] = 0.0;
      for (int i = 1; i < K; i++) {
        double dx = pts[(o + i) * 2] - pts[(o + i - 1) * 2];
        double dy = pts[(o + i) * 2 + 1] - pts[(o + i - 1) * 2 + 1];
        u[i] = u[i - 1] + sqrt(dx * dx + dy * dy);
      }
      double inv = 1.0 / u[K - 1];
      for (int i = 1; i < K; i++) u[i] *= inv;
      int co = r * 8;
      fit_once(pts, o, u, ctrl, co);
      reparam(pts, o, u, ctrl, co);
      fit_once(pts, o, u, ctrl, co);
    }
  }
}

int main(void) {
  double* pts = malloc(sizeof(double) * RUNS * K * 2);
  double* u = malloc(sizeof(double) * K);
  double* ctrl = malloc(sizeof(double) * RUNS * 8);
  double samples[N_RUNS];

  build_runs(pts);

  for (int i = 0; i < N_WARMUP; i++) run_kernel(pts, u, ctrl);

  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    run_kernel(pts, u, ctrl);
    samples[i] = now_ms() - t0;
  }

  print_result(median_us(samples, N_RUNS), checksum_f64(ctrl, RUNS * 8), RUNS * K * N_ITERS, 3, N_RUNS);
  free(pts);
  free(u);
  free(ctrl);
  return 0;
}
