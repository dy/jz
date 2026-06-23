// noise.c — 2-D Perlin gradient noise summed over several octaves (fractal
// Brownian motion), the canonical procedural-generation kernel (terrain heights,
// textures, clouds, displacement). A permutation-table hash feeds gradient dot
// products blended by a quintic smoothstep — integer table lookups interleaved
// with loop-carried f64 interpolation, an ALU/memory mix distinct from the
// suite's other loops.
//
// Transcendental-free (+,-,*; no trig/pow), and the sample coordinates stay
// non-negative so Math.floor never straddles zero, so the field is bit-identical
// across engines and native targets. Go's arm64 auto-FMA of the lerp chains gives
// the documented `fma` parity class, like fft/synth.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Float64Array/Int32Array,
// Math.floor, no class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in samples/µs, FNV-1a checksum over
// the generated field.
#include "../_lib/bench.h"
#include <math.h>
#include <stdlib.h>

#define W       256
#define H       256
#define OCT     5
#define N_RUNS  21
#define N_WARMUP 5

static void build_perm(int32_t* perm) {
  for (int i = 0; i < 256; i++) perm[i] = i;
  uint32_t s = 0x1234abcdu;
  for (int i = 255; i > 0; i--) {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    int j = (int)(s % (uint32_t)(i + 1));
    int32_t t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
  for (int i = 0; i < 256; i++) perm[256 + i] = perm[i];
}

static double fade(double t) {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

static double lerp(double a, double b, double t) {
  return a + t * (b - a);
}

static double grad(int32_t hash, double x, double y) {
  int h = hash & 3;
  double u = (h & 1) == 0 ? x : -x;
  double v = (h & 2) == 0 ? y : -y;
  return u + v;
}

static double perlin(const int32_t* perm, double x, double y) {
  int xi = (int)floor(x);
  int yi = (int)floor(y);
  double xf = x - xi;
  double yf = y - yi;
  int X = xi & 255;
  int Y = yi & 255;
  double u = fade(xf);
  double v = fade(yf);
  int32_t aa = perm[perm[X]     + Y];
  int32_t ab = perm[perm[X]     + Y + 1];
  int32_t ba = perm[perm[X + 1] + Y];
  int32_t bb = perm[perm[X + 1] + Y + 1];
  double x1 = lerp(grad(aa, xf,        yf),       grad(ba, xf - 1.0, yf),       u);
  double x2 = lerp(grad(ab, xf,        yf - 1.0), grad(bb, xf - 1.0, yf - 1.0), u);
  return lerp(x1, x2, v);
}

static double fbm(const int32_t* perm, double x, double y) {
  double sum = 0.0, amp = 0.5, freq = 1.0;
  for (int o = 0; o < OCT; o++) {
    sum = sum + amp * perlin(perm, x * freq, y * freq);
    freq = freq * 2.0;
    amp  = amp  * 0.5;
  }
  return sum;
}

static void render(const int32_t* perm, double* field) {
  for (int py = 0; py < H; py++) {
    double y = py * 0.03125;
    for (int px = 0; px < W; px++) {
      double x = px * 0.03125;
      field[py * W + px] = fbm(perm, x, y);
    }
  }
}

int main(void) {
  int32_t* perm  = malloc(sizeof(int32_t) * 512);
  double*  field = malloc(sizeof(double)  * W * H);
  double   samples[N_RUNS];

  build_perm(perm);

  for (int i = 0; i < N_WARMUP; i++) render(perm, field);

  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    render(perm, field);
    samples[i] = now_ms() - t0;
  }

  print_result(median_us(samples, N_RUNS), checksum_f64(field, W * H), W * H, OCT, N_RUNS);
  free(perm);
  free(field);
}
