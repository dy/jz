// jzczhz.c – rgb to JzCzhz over a batch of colors: color-space's wasm batch
// kernel (github.com/colorjs/color-space, wasm/batch.js) ported from jzczhz.js.
//
// The edges rgb_lrgb, lrgb_xyz, xyz_jzazbz and polar_fwd and their helpers
// (spow, sgn, srgbDec) are ported as written, each a C function; an edge
// returns its three results as a small struct by value, as the JS returns an
// [a, b, c] array destructured at once. The Jzazbz constants stay named
// file-scope constants as the JS declares them (the inverse's ninv and pinv,
// which the forward never reads, are left out); PI is Math.PI's double.
// convert copies the sRGB input into the buffer and runs one in-place pass per
// edge over it, as the JS does (the copy is inside the timed region there
// too). `**` is libm pow, Math.atan2 libm atan2.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over every output value at
// single precision (checksum_f64_near, benchlib's checksumF64Near), which
// tolerates last-bit pow and atan2 differences between libms.
#include "../_lib/bench.h"
#include <math.h>
#include <stdlib.h>

#define N_COLORS 120000
#define N_RUNS   11
#define N_WARMUP 2

// an edge's three results ([a, b, c] in the JS)
typedef struct { double a, b, c; } Tri;

#define PI 3.141592653589793 // Math.PI

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

// ---- generic cartesian <-> cylindrical (serves every LCh-family space) ----
static Tri polar_fwd(double l, double a, double b) {
  double c = sqrt(a * a + b * b);
  double hr = atan2(b, a) * 180 / PI;
  return (Tri){ l, c, c < 1e-8 ? 0 : (hr < 0 ? hr + 360 : hr) };
}

// ---- xyz <-> jzazbz (HDR; modified ST 2084 PQ, p = 1.7·m2) ----
static const double Yw_jz = 203, b_param = 1.15, g_param = 0.66, d = -0.56, d0 = 1.6295499532821566e-11;

static const double n_val = 2610.0 / 16384, c1 = 3424.0 / 4096, c2 = 2413.0 / 128, c3 = 2392.0 / 128;

static const double p = 1.7 * 2523 / 32;

static const double xc00 = 0.41478972, xc01 = 0.579999, xc02 = 0.0146480, xc10 = -0.2015100, xc11 = 1.120649, xc12 = 0.0531008, xc20 = -0.0166008, xc21 = 0.264800, xc22 = 0.6684799;

static const double ci00 = 0.5, ci01 = 0.5, ci02 = 0, ci10 = 3.524000, ci11 = -4.066708, ci12 = 0.542708, ci20 = 0.199076, ci21 = 1.096799, ci22 = -1.295875;

static Tri xyz_jzazbz(double X, double Y, double Z) {
  double Xa = X / 100 * Yw_jz, Ya = Y / 100 * Yw_jz, Za = Z / 100 * Yw_jz;
  double Xm = b_param * Xa - (b_param - 1) * Za, Ym = g_param * Ya - (g_param - 1) * Xa;
  double L = xc00 * Xm + xc01 * Ym + xc02 * Za, M = xc10 * Xm + xc11 * Ym + xc12 * Za, S = xc20 * Xm + xc21 * Ym + xc22 * Za;
  double PL = spow((c1 + c2 * spow(L / 10000, n_val)) / (1 + c3 * spow(L / 10000, n_val)), p);
  double PM = spow((c1 + c2 * spow(M / 10000, n_val)) / (1 + c3 * spow(M / 10000, n_val)), p);
  double PS = spow((c1 + c2 * spow(S / 10000, n_val)) / (1 + c3 * spow(S / 10000, n_val)), p);
  double Iz = ci00 * PL + ci01 * PM + ci02 * PS;
  return (Tri){ ((1 + d) * Iz) / (1 + d * Iz) - d0, ci10 * PL + ci11 * PM + ci12 * PS, ci20 * PL + ci21 * PM + ci22 * PS };
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
  for (int i = 0; i < n; i++) { int j = 3 * i; Tri t = xyz_jzazbz(buf[j], buf[j + 1], buf[j + 2]); buf[j] = t.a; buf[j + 1] = t.b; buf[j + 2] = t.c; }
  for (int i = 0; i < n; i++) { int j = 3 * i; Tri t = polar_fwd(buf[j], buf[j + 1], buf[j + 2]); buf[j] = t.a; buf[j + 1] = t.b; buf[j + 2] = t.c; }
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
