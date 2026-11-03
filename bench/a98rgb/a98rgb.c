// a98rgb.c – rgb to Adobe RGB (1998) over a batch of colors: color-space's wasm
// batch kernel (github.com/colorjs/color-space, wasm/batch.js) ported from
// a98rgb.js.
//
// The edges rgb_lrgb, lrgb_xyz and xyz_a98rgb (with xyz_a98rgblinear) and
// their helpers (spow, sgn, srgbDec) are ported as written, each a C function;
// an edge returns its three results as a small struct by value, as the JS
// returns an [a, b, c] array destructured at once. The matrices stay inline
// literals, as the JS writes them. convert copies the sRGB input into the
// buffer and runs one in-place pass per edge over it, as the JS does (the copy
// is inside the timed region there too). `**` is libm pow.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over every output value at
// single precision (checksum_f64_near, benchlib's checksumF64Near), which
// tolerates last-bit pow differences between libms.
#include "../_lib/bench.h"
#include <math.h>
#include <stdlib.h>

#define N_COLORS 300000
#define N_RUNS   11
#define N_WARMUP 2

// an edge's three results ([a, b, c] in the JS)
typedef struct { double a, b, c; } Tri;

// sign-extended power (shared by jzazbz, ipt, a98rgb, cam16); out-of-gamut safe
static double spow(double a, double e) { double s = a < 0 ? -1 : 1, av = a < 0 ? -a : a; return s * pow(av, e); }

static double sgn(double v) { return v < 0 ? -1 : 1; }

// sRGB / IEC 61966-2-1 (also Display P3)
static double srgb_dec(double v) { double a = fabs(v); return sgn(v) * (a > 0.04045 ? pow((a + 0.055) / 1.055, 2.4) : a / 12.92); }

// ---- rgb / lrgb / xyz / oklab / oklrab (hub: lrgb, xyz) ----

static Tri rgb_lrgb(double r, double g, double b) { return (Tri){ srgb_dec(r / 255), srgb_dec(g / 255), srgb_dec(b / 255) }; }

static Tri lrgb_xyz(double r, double g, double b) {
  return (Tri){
    100 * (0.41239079926595 * r + 0.35758433938387 * g + 0.18048078840183 * b),
    100 * (0.21263900587151 * r + 0.71516867876775 * g + 0.072192315360733 * b),
    100 * (0.019330818715591 * r + 0.11919477979462 * g + 0.95053215224966 * b)
  };
}

static Tri xyz_a98rgblinear(double x0, double y0, double z0) {
  double x = x0 / 100, y = y0 / 100, z = z0 / 100;
  return (Tri){
    2.0415879038107465 * x - 0.5650069742788597 * y - 0.34473135077832956 * z,
    -0.9692436362808796 * x + 1.8759675015077202 * y + 0.04155505740717559 * z,
    0.013444280632031149 * x - 0.11836239223101837 * y + 1.0151749943912054 * z
  };
}

static Tri xyz_a98rgb(double x, double y, double z) { Tri l = xyz_a98rgblinear(x, y, z); return (Tri){ spow(l.a, 256.0 / 563), spow(l.b, 256.0 / 563), spow(l.c, 256.0 / 563) }; }

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
  for (int i = 0; i < n; i++) { int j = 3 * i; Tri t = rgb_lrgb(buf[j], buf[j + 1], buf[j + 2]); buf[j] = t.a; buf[j + 1] = t.b; buf[j + 2] = t.c; }
  for (int i = 0; i < n; i++) { int j = 3 * i; Tri t = lrgb_xyz(buf[j], buf[j + 1], buf[j + 2]); buf[j] = t.a; buf[j + 1] = t.b; buf[j + 2] = t.c; }
  for (int i = 0; i < n; i++) { int j = 3 * i; Tri t = xyz_a98rgb(buf[j], buf[j + 1], buf[j + 2]); buf[j] = t.a; buf[j + 1] = t.b; buf[j + 2] = t.c; }
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
