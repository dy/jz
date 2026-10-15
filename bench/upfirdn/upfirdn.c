/* upfirdn.c — native C reference of bench/upfirdn/upfirdn.js: the same gcd,
 * taps, upfirdn gather and trim, in doubles where the JS computes doubles
 * (`%` is fmod on doubles there; the factors here are the ints they are).
 *   clang -O3 -ffp-contract=off -o upfirdn upfirdn.c
 * Output: median_us=<int> checksum=<u32> samples=<int> stages=<int> runs=<int> */
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>

#define N_SAMPLES 96000
#define UP 6
#define DOWN 4
#define N_RUNS 21
#define N_WARMUP 5

static double x_buf[N_SAMPLES];
static double *out_buf; static int out_len;
static double samples_buf[N_RUNS], sorted_buf[N_RUNS];

static void mk_input(double *out, int n) {
  uint32_t s = 0x1234abcdu;
  for (int i = 0; i < n; i++) { s ^= s << 13; s ^= s >> 17; s ^= s << 5; out[i] = ((double)s / 4294967296.0) * 2.0 - 1.0; }
}
static void taps(double *h, int n) {
  double c = (n - 1) / 2.0, sum = 0;
  for (int k = 0; k < n; k++) { double d = k - c; h[k] = (1 - fabs(d) / (c + 1)) * (d == 0 ? 1 : (k & 1 ? -0.25 : 0.5) / (1 + fabs(d))); sum += h[k]; }
  for (int k = 0; k < n; k++) h[k] /= sum;
}
static int gcd(int a, int b) { a = abs(a); b = abs(b); while (b) { int t = b; b = a % b; a = t; } return a; }
static double *upfirdn(const double *data, int xLen, const double *h, int hLen, int up, int down, int *outLenOut) {
  int outLen = (int)floor(((double)(xLen - 1) * up + hLen + down - 1) / down);
  double *out = calloc(outLen, sizeof(double));
  for (int n = 0; n < outLen; n++) {
    double sum = 0; int upIdx = n * down;
    for (int k = 0; k < hLen; k++) {
      int srcIdx = upIdx - k;
      if (srcIdx >= 0 && srcIdx % up == 0) { int xi = srcIdx / up; if (xi < xLen) sum += h[k] * data[xi]; }
    }
    out[n] = sum;
  }
  *outLenOut = outLen; return out;
}
static double *resample(const double *data, int len, int p, int q, int *resLen) {
  int g = gcd(p, q); p /= g; q /= g;
  int numtaps = 10 * (p > q ? p : q) + 1; if (numtaps % 2 == 0) numtaps++;
  double *h = malloc(numtaps * sizeof(double)); taps(h, numtaps);
  for (int i = 0; i < numtaps; i++) h[i] *= p;
  int hLen = numtaps; double delay = (numtaps - 1) / 2.0;
  int prePad = (int)fmod(q - fmod(delay, q), q);
  if (prePad) { double *hp = calloc(prePad + hLen, sizeof(double)); memcpy(hp + prePad, h, hLen * sizeof(double)); free(h); h = hp; hLen += prePad; delay += prePad; }
  int outLen; double *out = upfirdn(data, len, h, hLen, p, q, &outLen);
  int expected = (int)ceil((double)len * p / q);
  double startIdx = delay / q;
  double *result = malloc(expected * sizeof(double));
  for (int i = 0; i < expected; i++) { double idx = startIdx + i; result[i] = idx < outLen ? out[(int)idx] : 0; }
  free(h); free(out); *resLen = expected; return result;
}
static uint32_t fnv1a_strided(const double *out, int n_samples) {
  uint32_t h = 0x811c9dc5u; const int stride_words = 256, total_words = n_samples * 2;
  for (int i = 0; i < total_words; i += stride_words) { uint32_t w; memcpy(&w, (const char *)out + i * (int)sizeof(uint32_t), sizeof(w)); h = (uint32_t)((uint64_t)(h ^ w) * 0x01000193u); }
  return h;
}
static double now_ms(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6; }

int main(void) {
  mk_input(x_buf, N_SAMPLES);
  for (int i = 0; i < N_WARMUP; i++) { free(out_buf); out_buf = resample(x_buf, N_SAMPLES, UP, DOWN, &out_len); }
  for (int i = 0; i < N_RUNS; i++) { free(out_buf); double t0 = now_ms(); out_buf = resample(x_buf, N_SAMPLES, UP, DOWN, &out_len); samples_buf[i] = now_ms() - t0; }
  uint32_t cs = fnv1a_strided(out_buf, out_len);
  for (int i = 0; i < N_RUNS; i++) sorted_buf[i] = samples_buf[i];
  for (int i = 1; i < N_RUNS; i++) { double v = sorted_buf[i]; int j = i - 1; while (j >= 0 && sorted_buf[j] > v) { sorted_buf[j + 1] = sorted_buf[j]; j--; } sorted_buf[j + 1] = v; }
  printf("median_us=%d checksum=%u samples=%d stages=%d runs=%d\n", (int)(sorted_buf[(N_RUNS - 1) >> 1] * 1000.0), cs, out_len, UP, N_RUNS);
  return 0;
}
