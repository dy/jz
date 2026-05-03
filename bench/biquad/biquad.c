/* biquad.c — native C reference of bench/biquad/biquad.js.
 *
 * Same algorithm, same constants, same checksum. Compile with -O3:
 *   clang -O3 -ffp-contract=off -o biquad biquad.c
 *   gcc   -O3 -ffp-contract=off -o biquad biquad.c
 *
 * `-ffp-contract=off` is REQUIRED for bit-exact parity with V8/jz: scalar JS
 * does not fuse `b0*v + b1*x1` into FMA (no IEEE 754 spec for it pre-ES2026),
 * but clang/gcc at -O3 do, and a single rounded FMA differs from two rounded
 * scalar ops. The whole cascade then drifts and the FNV checksum diverges.
 *
 * Output line matches the JS targets so bench.mjs parses it identically:
 *   median_us=<int> checksum=<u32> samples=<int> stages=<int> runs=<int>
 *
 * Bit-exact with V8/jz on little-endian platforms (FNV-1a strides over the
 * raw f64 bit pattern via Uint32Array view — same on memcpy'd uint32_t here).
 */

#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define N_SAMPLES 480000
#define N_STAGES  8
#define N_RUNS    21
#define N_WARMUP  5

static double x_buf[N_SAMPLES];
static double coeffs_buf[N_STAGES * 5];
static double state_buf[N_STAGES * 4];
static double out_buf[N_SAMPLES];
static double samples_buf[N_RUNS];
static double sorted_buf[N_RUNS];

static void mk_input(double *out, int n) {
  uint32_t s = 0x1234abcdu;
  for (int i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    out[i] = ((double)s / 4294967296.0) * 2.0 - 1.0;
  }
}

static void mk_coeffs(double *out, int n) {
  for (int i = 0; i < n; i++) {
    out[i * 5 + 0] = 0.10 + i * 0.001;
    out[i * 5 + 1] = 0.20 - i * 0.0005;
    out[i * 5 + 2] = 0.10;
    out[i * 5 + 3] = -1.50 + i * 0.01;
    out[i * 5 + 4] = 0.60 - i * 0.005;
  }
}

static void process_cascade(const double *x, const double *coeffs, double *state, int n_stages, double *out) {
  for (int i = 0; i < N_SAMPLES; i++) {
    double v = x[i];
    for (int s = 0; s < n_stages; s++) {
      int c = s * 5;
      int sb = s * 4;
      double b0 = coeffs[c + 0];
      double b1 = coeffs[c + 1];
      double b2 = coeffs[c + 2];
      double a1 = coeffs[c + 3];
      double a2 = coeffs[c + 4];
      double x1 = state[sb + 0];
      double x2 = state[sb + 1];
      double y1 = state[sb + 2];
      double y2 = state[sb + 3];
      double y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      state[sb + 0] = v;
      state[sb + 1] = x1;
      state[sb + 2] = y;
      state[sb + 3] = y1;
      v = y;
    }
    out[i] = v;
  }
}

/* FNV-1a over a 32-bit-word stride of out's bit pattern. Strict aliasing
 * via memcpy into a local — `(uint32_t *)out` would be UB. */
static uint32_t fnv1a_strided(const double *out, int n_samples) {
  uint32_t h = 0x811c9dc5u;
  const int stride_words = 256;        /* match benchlib checksumF64 u32-stride */
  const int total_words = n_samples * 2;
  for (int i = 0; i < total_words; i += stride_words) {
    int byte_off = i * (int)sizeof(uint32_t);
    uint32_t w;
    memcpy(&w, (const char *)out + byte_off, sizeof(w));
    h = (uint32_t)((uint64_t)(h ^ w) * 0x01000193u);
  }
  return h;
}

static double now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}

static void reset_state(void) {
  for (int i = 0; i < N_STAGES * 4; i++) state_buf[i] = 0.0;
}

int main(void) {
  mk_input(x_buf, N_SAMPLES);
  mk_coeffs(coeffs_buf, N_STAGES);

  for (int i = 0; i < N_WARMUP; i++) {
    reset_state();
    process_cascade(x_buf, coeffs_buf, state_buf, N_STAGES, out_buf);
  }

  for (int i = 0; i < N_RUNS; i++) {
    reset_state();
    double t0 = now_ms();
    process_cascade(x_buf, coeffs_buf, state_buf, N_STAGES, out_buf);
    samples_buf[i] = now_ms() - t0;
  }

  uint32_t cs = fnv1a_strided(out_buf, N_SAMPLES);

  for (int i = 0; i < N_RUNS; i++) sorted_buf[i] = samples_buf[i];
  for (int i = 1; i < N_RUNS; i++) {
    double v = sorted_buf[i];
    int j = i - 1;
    while (j >= 0 && sorted_buf[j] > v) { sorted_buf[j + 1] = sorted_buf[j]; j--; }
    sorted_buf[j + 1] = v;
  }
  double median_ms = sorted_buf[(N_RUNS - 1) >> 1];
  int median_us = (int)(median_ms * 1000.0);

  printf("median_us=%d checksum=%u samples=%d stages=%d runs=%d\n",
         median_us, cs, N_SAMPLES, N_STAGES, N_RUNS);
  return 0;
}
