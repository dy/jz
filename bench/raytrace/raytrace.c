// raytrace.c — a minimal sphere ray tracer: one primary ray per pixel, a
// closest-hit search over a small sphere scene, then Lambert diffuse + ambient
// shading into an f64 framebuffer. The canonical 3-D rendering kernel — a branchy,
// loop-carried scalar pipeline (ray–sphere quadratic, closest-hit select, normal
// + light dot product) that no target auto-vectorizes, so it is a pure
// scalar-codegen race.
//
// Transcendental-free: only +,-,*,/ and sqrt, all IEEE-754 correctly-rounded, so
// the framebuffer is bit-identical across engines and native targets. Go's arm64
// backend force-fuses a*b+c → FMADDD (no flag to disable), so its checksum is the
// documented `fma` parity class, like fft/synth/biquad — same algorithm, last-ulp
// rounding only.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Float64Array, Math.sqrt, no
// class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in pixels/µs, FNV-1a checksum over
// the rendered framebuffer.
#include "../_lib/bench.h"
#include <math.h>
#include <stdlib.h>

#define W 384
#define H 384
#define NS 8
#define N_RUNS 21
#define N_WARMUP 5

static void build_scene(double* sx, double* sy, double* sz, double* sr,
                        double* cr, double* cg, double* cb) {
  for (int i = 0; i < NS; i++) {
    sx[i] = ((i % 3) - 1) * 2.2;
    sy[i] = (((i / 3)) - 1) * 1.6;
    sz[i] = -5.0 - i * 1.3;
    sr[i] = 0.7 + (i % 4) * 0.18;
    cr[i] = 0.30 + (i % 5) * 0.14;
    cg[i] = 0.25 + (i % 3) * 0.24;
    cb[i] = 0.40 + (i % 7) * 0.08;
  }
}

static void render(double* fb,
                   const double* sx, const double* sy, const double* sz, const double* sr,
                   const double* cr, const double* cg, const double* cb,
                   double lx, double ly, double lz) {
  for (int py = 0; py < H; py++) {
    double sv = 1.0 - (py + 0.5) / H * 2.0;
    for (int px = 0; px < W; px++) {
      double su = (px + 0.5) / W * 2.0 - 1.0;
      double dx = su, dy = sv, dz = -1.0;
      double dinv = 1.0 / sqrt(dx * dx + dy * dy + dz * dz);
      dx = dx * dinv; dy = dy * dinv; dz = dz * dinv;

      double tBest = 1e30;
      int hit = -1;
      for (int s = 0; s < NS; s++) {
        double ox = -sx[s], oy = -sy[s], oz = -sz[s];
        double b = ox * dx + oy * dy + oz * dz;
        double c = ox * ox + oy * oy + oz * oz - sr[s] * sr[s];
        double disc = b * b - c;
        if (disc > 0.0) {
          double t = -b - sqrt(disc);
          if (t > 0.001 && t < tBest) { tBest = t; hit = s; }
        }
      }

      double r = 0.0, g = 0.0, bl = 0.0;
      if (hit >= 0) {
        double hx = dx * tBest, hy = dy * tBest, hz = dz * tBest;
        double nx = hx - sx[hit], ny = hy - sy[hit], nz = hz - sz[hit];
        double ninv = 1.0 / sqrt(nx * nx + ny * ny + nz * nz);
        nx = nx * ninv; ny = ny * ninv; nz = nz * ninv;
        double diff = nx * lx + ny * ly + nz * lz;
        if (diff < 0.0) diff = 0.0;
        double shade = 0.15 + 0.85 * diff;
        r = cr[hit] * shade; g = cg[hit] * shade; bl = cb[hit] * shade;
      }
      int o = (py * W + px) * 3;
      fb[o] = r; fb[o + 1] = g; fb[o + 2] = bl;
    }
  }
}

int main(void) {
  double sx[NS], sy[NS], sz[NS], sr[NS];
  double cr[NS], cg[NS], cb[NS];
  build_scene(sx, sy, sz, sr, cr, cg, cb);

  double* fb = malloc(sizeof(double) * W * H * 3);
  double llen = 1.0 / sqrt(0.6 * 0.6 + 1.0 * 1.0 + 0.5 * 0.5);
  double lx = -0.6 * llen, ly = 1.0 * llen, lz = 0.5 * llen;

  for (int i = 0; i < N_WARMUP; i++) render(fb, sx, sy, sz, sr, cr, cg, cb, lx, ly, lz);

  double samples[N_RUNS];
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    render(fb, sx, sy, sz, sr, cr, cg, cb, lx, ly, lz);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), checksum_f64(fb, W * H * 3), W * H, NS, N_RUNS);
  free(fb);
}
