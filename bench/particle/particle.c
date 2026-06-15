/* particle.c — fixed-timestep particle integrator (gaming physics step).
 * Bit-identical to particle.js: same XorShift32 seed, same semi-implicit Euler,
 * same FNV-1a-over-f64-bytes checksum. Built with -ffp-contract=off so the
 * `a + b*c` integration matches the scalar f64 reference (no FMA fusion). */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#define N (1 << 16)
#define STEPS 256
#define DT 0.015625
#define G (-9.8)
#define N_RUNS 21
#define N_WARMUP 5

static double px[N], py[N], vx[N], vy[N];

static uint32_t mix(uint32_t h, uint32_t x) { return (uint32_t)((uint64_t)(h ^ x) * 0x01000193u); }

static uint32_t checksum_f64(const double *out, int n) {
  uint32_t h = 0x811c9dc5u;
  int total_words = n * 2;
  for (int i = 0; i < total_words; i += 256) {
    int byte_off = i * (int)sizeof(uint32_t);
    uint32_t w;
    memcpy(&w, (const char *)out + byte_off, sizeof(w));
    h = mix(h, w);
  }
  return h;
}

static void seed_state(void) {
  uint32_t s = 0x1234abcd;
  for (int i = 0; i < N; i++) {
    s ^= s << 13; s ^= s >> 17; s ^= s << 5;
    px[i] = (double)s / 4294967296.0 * 2.0 - 1.0;
    s ^= s << 13; s ^= s >> 17; s ^= s << 5;
    py[i] = (double)s / 4294967296.0 * 2.0 - 1.0;
    s ^= s << 13; s ^= s >> 17; s ^= s << 5;
    vx[i] = (double)s / 4294967296.0 * 2.0 - 1.0;
    s ^= s << 13; s ^= s >> 17; s ^= s << 5;
    vy[i] = (double)s / 4294967296.0 * 2.0 - 1.0;
  }
}

static void step(void) {
  for (int i = 0; i < N; i++) {
    double nvy = vy[i] + G * DT;
    px[i] = px[i] + vx[i] * DT;
    py[i] = py[i] + nvy * DT;
    vy[i] = nvy;
  }
}

static void run(void) { for (int f = 0; f < STEPS; f++) step(); }

static double now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}

static uint64_t median_us(double *s, int n) {
  for (int i = 1; i < n; i++) {
    double v = s[i]; int j = i - 1;
    while (j >= 0 && s[j] > v) { s[j + 1] = s[j]; j--; }
    s[j + 1] = v;
  }
  return (uint64_t)(s[(n - 1) >> 1] * 1000.0);
}

int main(void) {
  for (int i = 0; i < N_WARMUP; i++) { seed_state(); run(); }
  double samples[N_RUNS];
  for (int i = 0; i < N_RUNS; i++) {
    seed_state();
    double t0 = now_ms();
    run();
    samples[i] = now_ms() - t0;
  }
  uint32_t cs = checksum_f64(py, N) ^ checksum_f64(px, N);
  printf("median_us=%llu checksum=%u samples=%d stages=%d runs=%d\n",
         (unsigned long long)median_us(samples, N_RUNS), cs, N * STEPS, STEPS, N_RUNS);
  return 0;
}
