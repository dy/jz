// cam16.c – rgb to CAM16 (J, M, h) over a batch of colors: color-space's wasm
// batch kernel (github.com/colorjs/color-space, wasm/batch.js) ported from
// cam16.js.
//
// The edges rgb_lrgb, lrgb_xyz and xyz_cam16 and their helpers (spow, sgn,
// srgbDec, copySign, zdiv, hue360, camAdapt, toCam16) are ported as written,
// each a C function; an edge returns its three results as a small struct by
// value, as the JS returns an [a, b, c] array destructured at once. The JS's
// viewing-conditions object becomes a const struct that toCam16 reads through
// a pointer; it holds the fields the forward reads (the library's object also
// carries n, dRi, dGi, dBi, aki and uk for the inverse). copy_sign is the JS's
// Math.sign(b) * Math.abs(a), not libm copysign: it is 0 where b is 0. JS `%`
// on doubles is fmod; PI is Math.PI's double. convert copies the sRGB input
// into the buffer and runs one in-place pass per edge over it, as the JS does
// (the copy is inside the timed region there too). `**` is libm pow, and
// Math.atan2, cos and sqrt are libm's.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over every output value at
// single precision (checksum_f64_near, benchlib's checksumF64Near), which
// tolerates last-bit pow and trig differences between libms.
#include "../_lib/bench.h"
#include <math.h>
#include <stdlib.h>

#define N_COLORS 75000
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

// ---- xyz <-> cam16 (J, M, h) / hct (Li et al. 2017; spaces/cam16.js, spaces/hct.js) ----
// Viewing conditions are the library's environment() values: CAM16 = D65 [0.95047, 1, 1.08883],
// La = 64/π·0.2, Yb = 20, average, no discounting. ak = (1.64 − 0.29^n)^0.73.
typedef struct { double fl, flRoot, z, nbb, ncb, c, nc, aW, dR, dG, dB, ak; } Env;

static const Env CAM16 = { .fl = 0.2731305366732074, .flRoot = 0.7229238694926879, .z = 1.9272135954999579, .nbb = 1.0003040045593807, .ncb = 1.0003040045593807, .c = 0.69, .nc = 1, .aW = 25.51850208110783, .dR = 1.0208410446152913, .dG = 0.9865253929974012, .dB = 0.9350103262350229, .ak = 0.8952178848134279 };

static const double tau = 2 * PI;

// Math.sign: ±1, or the argument itself at ±0
static double sign(double x) { return x > 0 ? 1 : x < 0 ? -1 : x; }
static double copy_sign(double a, double b) { return sign(b) * fabs(a); }
static double zdiv(double a, double b) { return b == 0 ? 0 : a / b; }
static double hue360(double h) { double r = fmod(h, 360); return r < 0 ? r + 360 : r; }
static double cam_adapt(double c, double fl) { double x = spow(fl * fabs(c) * 0.01, 0.42); return (400 * copy_sign(x, c)) / (x + 27.13); }

// XYZ (0-100) → [J, C, h°] under viewing conditions E (toCam16)
static Tri to_cam16(double x, double y, double z, const Env* E) {
  double ra = cam_adapt((0.401288 * x + 0.650173 * y - 0.051461 * z) * E->dR, E->fl);
  double ga = cam_adapt((-0.250268 * x + 1.204414 * y + 0.045854 * z) * E->dG, E->fl);
  double ba = cam_adapt((-0.002079 * x + 0.048952 * y + 0.953127 * z) * E->dB, E->fl);
  double a = ra + (-12 * ga + ba) / 11, b = (ra + ga - 2 * ba) / 9;
  double hRad = fmod(fmod(atan2(b, a), tau) + tau, tau);
  double et = 0.25 * (cos(hRad + 2) + 3.8);
  double t = (5e4 / 13) * E->nc * E->ncb * zdiv(et * sqrt(a * a + b * b), ra + ga + 1.05 * ba + 0.305);
  double alpha = spow(t, 0.9) * E->ak;
  double A = E->nbb * (2 * ra + ga + 0.05 * ba);
  double Jroot = spow(A / E->aW, 0.5 * E->c * E->z);
  return (Tri){ 100 * spow(Jroot, 2), alpha * Jroot, hue360(hRad * (180 / PI)) };
}

static Tri xyz_cam16(double x, double y, double z) { Tri j = to_cam16(x, y, z, &CAM16); return (Tri){ j.a, j.b * CAM16.flRoot, j.c }; }

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
  for (int i = 0; i < n; i++) { int j = 3 * i; Tri t = xyz_cam16(buf[j], buf[j + 1], buf[j + 2]); buf[j] = t.a; buf[j + 1] = t.b; buf[j + 2] = t.c; }
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
