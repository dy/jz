// ipt.c – rgb to IPT (Ebner & Fairchild 1998) over a batch of colors:
// color-space's wasm batch kernel (github.com/colorjs/color-space,
// wasm/batch.js) ported from ipt.js.
//
// The edges rgb_lrgb, lrgb_xyz and xyz_ipt and their helpers (spow, sgn,
// srgbDec) are ported as written, each a C function; an edge returns its three
// results as a small struct by value, as the JS returns an [a, b, c] array
// destructured at once. The IPT matrices stay named file-scope constants, one
// per element, as the JS declares them. convert copies the sRGB input into the
// buffer and runs one in-place pass per edge over it, as the JS does (the copy
// is inside the timed region there too). `**` is libm pow.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over every output value at
// single precision (checksum_f64_near, benchlib's checksumF64Near), which
// tolerates last-bit pow differences between libms.
#include "../_lib/bench.h"
#include <math.h>
#include <stdlib.h>

#define N_COLORS 250000
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

// ---- xyz <-> ipt (Ebner & Fairchild 1998) ----
static const double M1_00 = 0.4002, M1_01 = 0.7075, M1_02 = -0.0807, M1_10 = -0.228, M1_11 = 1.15, M1_12 = 0.0612, M1_20 = 0, M1_21 = 0, M1_22 = 0.9184;
static const double M2_00 = 0.4, M2_01 = 0.4, M2_02 = 0.2, M2_10 = 4.455, M2_11 = -4.851, M2_12 = 0.396, M2_20 = 0.8056, M2_21 = 0.3572, M2_22 = -1.1628;

static Tri xyz_ipt(double X, double Y, double Z) {
  double xn = X / 100, yn = Y / 100, zn = Z / 100;
  double lp = spow(M1_00 * xn + M1_01 * yn + M1_02 * zn, 0.43), mp = spow(M1_10 * xn + M1_11 * yn + M1_12 * zn, 0.43), sp = spow(M1_20 * xn + M1_21 * yn + M1_22 * zn, 0.43);
  return (Tri){ M2_00 * lp + M2_01 * mp + M2_02 * sp, M2_10 * lp + M2_11 * mp + M2_12 * sp, M2_20 * lp + M2_21 * mp + M2_22 * sp };
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
  for (int i = 0; i < n; i++) { int j = 3 * i; Tri t = rgb_lrgb(buf[j], buf[j + 1], buf[j + 2]); buf[j] = t.a; buf[j + 1] = t.b; buf[j + 2] = t.c; }
  for (int i = 0; i < n; i++) { int j = 3 * i; Tri t = lrgb_xyz(buf[j], buf[j + 1], buf[j + 2]); buf[j] = t.a; buf[j + 1] = t.b; buf[j + 2] = t.c; }
  for (int i = 0; i < n; i++) { int j = 3 * i; Tri t = xyz_ipt(buf[j], buf[j + 1], buf[j + 2]); buf[j] = t.a; buf[j + 1] = t.b; buf[j + 2] = t.c; }
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
