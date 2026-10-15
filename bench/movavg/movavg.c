/* movavg.c — native C reference of bench/movavg/movavg.js: running-sum boxcar
 * over a ring of N_WINDOW doubles, the sum refreshed once per lap.
 *   clang -O3 -ffp-contract=off -o movavg movavg.c
 * Output: median_us=<int> checksum=<u32> samples=<int> stages=<int> runs=<int> */
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <time.h>

#define N_SAMPLES 480000
#define N_WINDOW 16
#define N_RUNS 21
#define N_WARMUP 5

static double x_buf[N_SAMPLES], data_buf[N_SAMPLES], mem[N_WINDOW];
static double samples_buf[N_RUNS], sorted_buf[N_RUNS];

static void mk_input(double *out, int n) {
  uint32_t s = 0x1234abcdu;
  for (int i = 0; i < n; i++) { s ^= s << 13; s ^= s >> 17; s ^= s << 5; out[i] = ((double)s / 4294967296.0) * 2.0 - 1.0; }
}
static void moving_average(double *data, int len, double *hist, int m) {
  int ptr = 0; double sum = 0;
  for (int j = 0; j < m; j++) sum += hist[j];
  for (int i = 0; i < len; i++) {
    sum += data[i] - hist[ptr];
    hist[ptr] = data[i];
    ptr = (ptr + 1) % m;
    data[i] = sum / m;
    if (ptr == 0) { sum = 0; for (int j = 0; j < m; j++) sum += hist[j]; }
  }
}
static uint32_t fnv1a_strided(const double *out, int n_samples) {
  uint32_t h = 0x811c9dc5u; const int stride_words = 256, total_words = n_samples * 2;
  for (int i = 0; i < total_words; i += stride_words) { uint32_t w; memcpy(&w, (const char *)out + i * (int)sizeof(uint32_t), sizeof(w)); h = (uint32_t)((uint64_t)(h ^ w) * 0x01000193u); }
  return h;
}
static double now_ms(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6; }

int main(void) {
  mk_input(x_buf, N_SAMPLES);
  for (int i = 0; i < N_WARMUP; i++) { memcpy(data_buf, x_buf, sizeof data_buf); memset(mem, 0, sizeof mem); moving_average(data_buf, N_SAMPLES, mem, N_WINDOW); }
  for (int i = 0; i < N_RUNS; i++) {
    memcpy(data_buf, x_buf, sizeof data_buf); memset(mem, 0, sizeof mem);
    double t0 = now_ms(); moving_average(data_buf, N_SAMPLES, mem, N_WINDOW); samples_buf[i] = now_ms() - t0;
  }
  uint32_t cs = fnv1a_strided(data_buf, N_SAMPLES);
  for (int i = 0; i < N_RUNS; i++) sorted_buf[i] = samples_buf[i];
  for (int i = 1; i < N_RUNS; i++) { double v = sorted_buf[i]; int j = i - 1; while (j >= 0 && sorted_buf[j] > v) { sorted_buf[j + 1] = sorted_buf[j]; j--; } sorted_buf[j + 1] = v; }
  printf("median_us=%d checksum=%u samples=%d stages=%d runs=%d\n", (int)(sorted_buf[(N_RUNS - 1) >> 1] * 1000.0), cs, N_SAMPLES, N_WINDOW, N_RUNS);
  return 0;
}
