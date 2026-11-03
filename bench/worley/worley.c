// worley.c – Worley (cellular) noise over a grid, 2-D plus 3-D, the
// hash-noise kernel.
//
// Ports pmndrs/math (MIT, Copyright (c) 2026 Isaac Mason, bench/_lib/pmath/LICENSE)
// as written: noise/permutation.js (createPermutation with its p, GRAD3 and
// GRAD4 tables), noise/worley2d.js and noise/worley3d.js (create, sample). The
// `{ perm, grad3, grad4 }` record is a struct of fixed arrays (the JS's
// Uint8Array(512) and two Float64Arrays); the samplers take a pointer to it and
// read its perm, as the JS destructures `{ perm }`. Grid cells are int32_t,
// Math.floor of the coordinates; the JS's `cx + 71 & 255` is (cx + 71) & 255
// by JS precedence, parenthesized here, and maps cx = -1 to 255 as ToInt32
// does. The coordinates stay non-negative and small, so every integer is
// exact.
// The samplers use no grad tables, but createPermutation builds them, so the
// port does too (outside the timed region).
//
// Reports: median ms across N_RUNS, throughput in samples/µs, FNV-1a checksum
// (checksum_f64) over the field.
#include "../_lib/bench.h"
#include <math.h>

#define SIDE     96
#define N_RUNS   21
#define N_WARMUP 5

// pmndrs/math noise/permutation
static const double GRAD3[12][3] = {
  { 1, 1, 0 }, { -1, 1, 0 }, { 1, -1, 0 }, { -1, -1, 0 }, { 1, 0, 1 },
  { -1, 0, 1 }, { 1, 0, -1 }, { -1, 0, -1 }, { 0, 1, 1 }, { 0, -1, 1 },
  { 0, 1, -1 }, { 0, -1, -1 }
};

static const double GRAD4[32][4] = {
  { 0, 1, 1, 1 }, { 0, 1, 1, -1 }, { 0, 1, -1, 1 }, { 0, 1, -1, -1 },
  { 0, -1, 1, 1 }, { 0, -1, 1, -1 }, { 0, -1, -1, 1 }, { 0, -1, -1, -1 },
  { 1, 0, 1, 1 }, { 1, 0, 1, -1 }, { 1, 0, -1, 1 }, { 1, 0, -1, -1 },
  { -1, 0, 1, 1 }, { -1, 0, 1, -1 }, { -1, 0, -1, 1 }, { -1, 0, -1, -1 },
  { 1, 1, 0, 1 }, { 1, 1, 0, -1 }, { 1, -1, 0, 1 }, { 1, -1, 0, -1 },
  { -1, 1, 0, 1 }, { -1, 1, 0, -1 }, { -1, -1, 0, 1 }, { -1, -1, 0, -1 },
  { 1, 1, 1, 0 }, { 1, 1, -1, 0 }, { 1, -1, 1, 0 }, { 1, -1, -1, 0 },
  { -1, 1, 1, 0 }, { -1, 1, -1, 0 }, { -1, -1, 1, 0 }, { -1, -1, -1, 0 }
};

static const uint8_t p[256] = {
  151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140,
  36, 103, 30, 69, 142, 8, 99, 37, 240, 21, 10, 23, 190, 6, 148, 247, 120, 234,
  75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32, 57, 177, 33, 88, 237,
  149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175, 74, 165, 71, 134, 139, 48,
  27, 166, 77, 146, 158, 231, 83, 111, 229, 122, 60, 211, 133, 230, 220, 105,
  92, 41, 55, 46, 245, 40, 244, 102, 143, 54, 65, 25, 63, 161, 1, 216, 80, 73,
  209, 76, 132, 187, 208, 89, 18, 169, 200, 196, 135, 130, 116, 188, 159, 86,
  164, 100, 109, 198, 173, 186, 3, 64, 52, 217, 226, 250, 124, 123, 5, 202, 38,
  147, 118, 126, 255, 82, 85, 212, 207, 206, 59, 227, 47, 16, 58, 17, 182, 189,
  28, 42, 223, 183, 170, 213, 119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101,
  155, 167, 43, 172, 9, 129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232,
  178, 185, 112, 104, 218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12,
  191, 179, 162, 241, 81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31,
  181, 199, 106, 157, 184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150, 254,
  138, 236, 205, 93, 222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215,
  61, 156, 180
};

typedef struct {
  uint8_t perm[512];
  double grad3[512 * 3];
  double grad4[512 * 4];
} Permutation;

static Permutation create_permutation(double seed) {
  if (seed > 0 && seed < 1) {
    seed *= 65536;
  }
  // every later use of the seed is ToInt32 (|, &, >>), a plain conversion for
  // the case's seed of 42
  int32_t s = (int32_t)floor(seed);
  if (s < 256) {
    s |= s << 8;
  }
  Permutation pt;
  for (int i = 0; i < 256; i++) {
    int v;
    if (i & 1) {
      v = p[i] ^ (s & 255);
    } else {
      v = p[i] ^ ((s >> 8) & 255);
    }
    pt.perm[i] = pt.perm[i + 256] = (uint8_t)v;
    const double *g3 = GRAD3[v % 12];
    const double *g4 = GRAD4[v % 32];
    for (int k = 0; k < 3; k++) {
      pt.grad3[i * 3 + k] = pt.grad3[(i + 256) * 3 + k] = g3[k];
    }
    for (int k = 0; k < 4; k++) {
      pt.grad4[i * 4 + k] = pt.grad4[(i + 256) * 4 + k] = g4[k];
    }
  }
  return pt;
}

// pmndrs/math noise/worley2d
static Permutation worley2d_create(double seed) {
  return create_permutation(seed);
}

static double worley2d_sample(const Permutation *noise, double x, double y) {
  const uint8_t *perm = noise->perm;
  int32_t ix = (int32_t)floor(x);
  int32_t iy = (int32_t)floor(y);
  double f1 = INFINITY;
  for (int32_t gy = -1; gy <= 1; gy++) {
    int32_t cy = iy + gy;
    int py = perm[cy & 255];
    int qy = perm[(cy + 37) & 255];
    for (int32_t gx = -1; gx <= 1; gx++) {
      int32_t cx = ix + gx;
      double rx = perm[(cx & 255) + py] / 256.0;
      double ry = perm[((cx + 71) & 255) + qy] / 256.0;
      double dx = cx + rx - x;
      double dy = cy + ry - y;
      double d2 = dx * dx + dy * dy;
      if (d2 < f1) f1 = d2;
    }
  }
  return sqrt(f1);
}

// pmndrs/math noise/worley3d
static Permutation worley3d_create(double seed) {
  return create_permutation(seed);
}

static double worley3d_sample(const Permutation *noise, double x, double y, double z) {
  const uint8_t *perm = noise->perm;
  int32_t ix = (int32_t)floor(x);
  int32_t iy = (int32_t)floor(y);
  int32_t iz = (int32_t)floor(z);
  double f1 = INFINITY;
  for (int32_t gz = -1; gz <= 1; gz++) {
    int32_t cz = iz + gz;
    int pz = perm[cz & 255];
    int qz = perm[(cz + 13) & 255];
    int sz = perm[(cz + 97) & 255];
    for (int32_t gy = -1; gy <= 1; gy++) {
      int32_t cy = iy + gy;
      int py = perm[(cy & 255) + pz];
      int qy = perm[((cy + 37) & 255) + qz];
      int sy = perm[((cy + 53) & 255) + sz];
      for (int32_t gx = -1; gx <= 1; gx++) {
        int32_t cx = ix + gx;
        double rx = perm[(cx & 255) + py] / 256.0;
        double ry = perm[((cx + 71) & 255) + qy] / 256.0;
        double rz = perm[((cx + 23) & 255) + sy] / 256.0;
        double dx = cx + rx - x;
        double dy = cy + ry - y;
        double dz = cz + rz - z;
        double d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < f1) f1 = d2;
      }
    }
  }
  return sqrt(f1);
}

static Permutation w2, w3;

static void run(double *out) {
  int k = 0;
  for (int y = 0; y < SIDE; y++) {
    for (int x = 0; x < SIDE; x++) {
      double fx = x * 0.11, fy = y * 0.13;
      out[k++] = worley2d_sample(&w2, fx, fy) + worley3d_sample(&w3, fx, fy, (x + y) * 0.07);
    }
  }
}

int main(void) {
  w2 = worley2d_create(42);
  w3 = worley3d_create(42);

  static double out[SIDE * SIDE];
  for (int i = 0; i < N_WARMUP; i++) run(out);

  double samples[N_RUNS];
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    run(out);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), checksum_f64(out, SIDE * SIDE), SIDE * SIDE, 2, N_RUNS);
}
