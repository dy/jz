// hwb.c – rgb to HWB over a batch of colors: color-space's wasm batch kernel
// (github.com/colorjs/color-space, wasm/batch.js) ported from hwb.js.
//
// The edge rgb_hwb and its helpers rgbHueDeg and rgbHue are ported as written,
// each a C function (rgb_hwb rescales to 0-255 for rgbHueDeg, which divides
// again, as the JS does); the edge returns its three results as a small struct
// by value, as the JS returns an [a, b, c] array destructured at once. convert
// copies the sRGB input into the buffer and runs one in-place pass of the edge
// over it, as the JS does (the copy is inside the timed region there too).
// Math.min and Math.max become plain comparisons: no value is ever NaN.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over every output value at
// single precision (checksum_f64_near, benchlib's checksumF64Near).
#include "../_lib/bench.h"
#include <stdlib.h>

#define N_COLORS 1500000
#define N_RUNS   11
#define N_WARMUP 2

// an edge's three results ([a, b, c] in the JS)
typedef struct { double a, b, c; } Tri;

static double min2(double a, double b) { return a < b ? a : b; }
static double max2(double a, double b) { return a > b ? a : b; }

// hue of an rgb triple (0-1), shared by rgb→hsl and rgb→hsv
static double rgb_hue(double r, double g, double b, double min, double max, double delta) {
  double h = 0;
  if (max == min) h = 0;
  else if (r == max) h = (g - b) / delta;
  else if (g == max) h = 2 + (b - r) / delta;
  else if (b == max) h = 4 + (r - g) / delta;
  h = min2(h / 6, 1);
  return h < 0 ? h + 1 : h;
}

// rgb→hsl's hue in degrees, for rgb→hwb
static double rgb_hue_deg(double r0, double g0, double b0) {
  double r = r0 / 255, g = g0 / 255, b = b0 / 255, min = min2(min2(r, g), b), max = max2(max2(r, g), b);
  return rgb_hue(r, g, b, min, max, max - min) * 360;
}

static Tri rgb_hwb(double r0, double g0, double b0) {
  double r = r0 / 255, g = g0 / 255, b = b0 / 255;
  return (Tri){ rgb_hue_deg(r * 255, g * 255, b * 255), min2(r, min2(g, b)) * 100, (1 - max2(r, max2(g, b))) * 100 };
}

// deterministic sRGB 0-255 (XorShift32), as the batch API takes it
static void mk_input(double* out, int n) {
  uint32_t s = 0x1234abcdu;
  for (int i = 0; i < n * 3; i++) {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    out[i] = 255 * ((double)s / 4294967296.0);
  }
}

static void convert(const double* src, double* buf, int n) {
  memcpy(buf, src, sizeof(double) * 3 * n);
  for (int i = 0; i < n; i++) { int j = 3 * i; Tri t = rgb_hwb(buf[j], buf[j + 1], buf[j + 2]); buf[j] = t.a; buf[j + 1] = t.b; buf[j + 2] = t.c; }
}

int main(void) {
  double* src = malloc(sizeof(double) * 3 * N_COLORS);
  double* dst = malloc(sizeof(double) * 3 * N_COLORS);
  double samples[N_RUNS];
  mk_input(src, N_COLORS);

  for (int i = 0; i < N_WARMUP; i++) convert(src, dst, N_COLORS);

  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    convert(src, dst, N_COLORS);
    samples[i] = now_ms() - t0;
  }

  print_result(median_us(samples, N_RUNS), checksum_f64_near(dst, 3 * N_COLORS), N_COLORS, 1, N_RUNS);
  free(src);
  free(dst);
  return 0;
}
