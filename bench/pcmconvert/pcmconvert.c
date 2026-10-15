/* pcmconvert.c — native C reference of bench/pcmconvert/pcmconvert.js: float32
 * interleaved → int16 (scale, round half up, clip) → float64 planar.
 *   clang -O3 -ffp-contract=off -o pcmconvert pcmconvert.c
 * Output: median_us=<int> checksum=<u32> samples=<int> stages=<int> runs=<int> */
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <time.h>

#define N_FRAMES 240000
#define N_CH 2
#define N_RUNS 21
#define N_WARMUP 5
#define LEN (N_FRAMES * N_CH)

static float x_buf[LEN];
static int16_t i16_buf[LEN];
static double out_buf[LEN];
static double samples_buf[N_RUNS], sorted_buf[N_RUNS];

static void mk_input(float *out, int n) {
  uint32_t s = 0x1234abcdu;
  for (int i = 0; i < n; i++) { s ^= s << 13; s ^= s >> 17; s ^= s << 5; out[i] = (float)(((double)s / 4294967296.0) * 2.0 - 1.0); }
}
/* JS Math.round: half toward +infinity */
static double js_round(double v) { return floor(v + 0.5); }
static void map_range(const float *samples, int len, int16_t *out) {
  const double fromMin = -1, toMin = -32768, toMax = 32767, fromSpan = 2, toSpan = 65536;
  for (int i = 0; i < len; i++) {
    double v = (((double)samples[i] - fromMin) / fromSpan) * toSpan + toMin;
    v = js_round(v);
    out[i] = (int16_t)(v < toMin ? toMin : v > toMax ? toMax : v);
  }
}
static void deinterleave(const int16_t *samples, int len, double *out, int ch) {
  int seg = len / ch;
  const double fromMin = -32768, fromSpan = 65536, toSpan = 2, toMin = -1, toMax = 1;
  for (int i = 0; i < len; i++) {
    int si = (i % seg) * ch + (i / seg);
    double v = samples[si];
    v = ((v - fromMin) / fromSpan) * toSpan + toMin;
    if (v < toMin) v = toMin; else if (v > toMax) v = toMax;
    out[i] = v;
  }
}
static uint32_t fnv1a_strided(const double *out, int n_samples) {
  uint32_t h = 0x811c9dc5u; const int stride_words = 256, total_words = n_samples * 2;
  for (int i = 0; i < total_words; i += stride_words) { uint32_t w; memcpy(&w, (const char *)out + i * (int)sizeof(uint32_t), sizeof(w)); h = (uint32_t)((uint64_t)(h ^ w) * 0x01000193u); }
  return h;
}
static double now_ms(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6; }

int main(void) {
  mk_input(x_buf, LEN);
  for (int i = 0; i < N_WARMUP; i++) { map_range(x_buf, LEN, i16_buf); deinterleave(i16_buf, LEN, out_buf, N_CH); }
  for (int i = 0; i < N_RUNS; i++) { double t0 = now_ms(); map_range(x_buf, LEN, i16_buf); deinterleave(i16_buf, LEN, out_buf, N_CH); samples_buf[i] = now_ms() - t0; }
  uint32_t cs = fnv1a_strided(out_buf, LEN);
  for (int i = 0; i < N_RUNS; i++) sorted_buf[i] = samples_buf[i];
  for (int i = 1; i < N_RUNS; i++) { double v = sorted_buf[i]; int j = i - 1; while (j >= 0 && sorted_buf[j] > v) { sorted_buf[j + 1] = sorted_buf[j]; j--; } sorted_buf[j + 1] = v; }
  printf("median_us=%d checksum=%u samples=%d stages=%d runs=%d\n", (int)(sorted_buf[(N_RUNS - 1) >> 1] * 1000.0), cs, N_FRAMES, N_CH, N_RUNS);
  return 0;
}
