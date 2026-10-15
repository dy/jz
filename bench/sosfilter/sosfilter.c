/* sosfilter.c — native C reference of bench/sosfilter/sosfilter.js.
 * Same algorithm, constants and checksum. The records become structs, the
 * state pairs a struct array; the filter is Direct Form II Transposed.
 *   clang -O3 -ffp-contract=off -o sosfilter sosfilter.c
 * Output: median_us=<int> checksum=<u32> samples=<int> stages=<int> runs=<int> */
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <time.h>

#define N_SAMPLES 480000
#define N_STAGES 8
#define N_RUNS 21
#define N_WARMUP 5

typedef struct { double b0, b1, b2, a1, a2; } Sos;
typedef struct { double z[2]; } State;

static double x_buf[N_SAMPLES], data_buf[N_SAMPLES];
static Sos coefs[N_STAGES];
static State state[N_STAGES];
static double samples_buf[N_RUNS], sorted_buf[N_RUNS];

static void mk_input(double *out, int n) {
  uint32_t s = 0x1234abcdu;
  for (int i = 0; i < n; i++) { s ^= s << 13; s ^= s >> 17; s ^= s << 5; out[i] = ((double)s / 4294967296.0) * 2.0 - 1.0; }
}
static Sos norm(double b0, double b1, double b2, double a0, double a1, double a2) {
  Sos s = { b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0 }; return s;
}
static void design(Sos *out, int n) {
  for (int i = 0; i < n; i++) out[i] = norm(0.10 + i * 0.001, 0.20 - i * 0.0005, 0.10, 1.0, -1.50 + i * 0.01, 0.60 - i * 0.005);
}
static void filter(double *data, int len, const Sos *c, State *st, int n) {
  for (int i = 0; i < len; i++) {
    double x = data[i];
    for (int j = 0; j < n; j++) {
      double y = c[j].b0 * x + st[j].z[0];
      st[j].z[0] = c[j].b1 * x - c[j].a1 * y + st[j].z[1];
      st[j].z[1] = c[j].b2 * x - c[j].a2 * y;
      x = y;
    }
    data[i] = x;
  }
}
static uint32_t fnv1a_strided(const double *out, int n_samples) {
  uint32_t h = 0x811c9dc5u; const int stride_words = 256, total_words = n_samples * 2;
  for (int i = 0; i < total_words; i += stride_words) { uint32_t w; memcpy(&w, (const char *)out + i * (int)sizeof(uint32_t), sizeof(w)); h = (uint32_t)((uint64_t)(h ^ w) * 0x01000193u); }
  return h;
}
static double now_ms(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6; }

int main(void) {
  mk_input(x_buf, N_SAMPLES); design(coefs, N_STAGES);
  for (int i = 0; i < N_WARMUP; i++) { memcpy(data_buf, x_buf, sizeof data_buf); memset(state, 0, sizeof state); filter(data_buf, N_SAMPLES, coefs, state, N_STAGES); }
  for (int i = 0; i < N_RUNS; i++) {
    memcpy(data_buf, x_buf, sizeof data_buf); memset(state, 0, sizeof state);
    double t0 = now_ms(); filter(data_buf, N_SAMPLES, coefs, state, N_STAGES); samples_buf[i] = now_ms() - t0;
  }
  uint32_t cs = fnv1a_strided(data_buf, N_SAMPLES);
  for (int i = 0; i < N_RUNS; i++) sorted_buf[i] = samples_buf[i];
  for (int i = 1; i < N_RUNS; i++) { double v = sorted_buf[i]; int j = i - 1; while (j >= 0 && sorted_buf[j] > v) { sorted_buf[j + 1] = sorted_buf[j]; j--; } sorted_buf[j + 1] = v; }
  printf("median_us=%d checksum=%u samples=%d stages=%d runs=%d\n", (int)(sorted_buf[(N_RUNS - 1) >> 1] * 1000.0), cs, N_SAMPLES, N_STAGES, N_RUNS);
  return 0;
}
