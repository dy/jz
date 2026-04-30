#ifndef JZ_BENCH_KERNELS_BENCH_H
#define JZ_BENCH_KERNELS_BENCH_H

#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

static double now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1000000.0;
}

static uint32_t mix_u32(uint32_t h, uint32_t x) {
  return (uint32_t)((h ^ x) * 0x01000193u);
}

static uint32_t checksum_f64(const double* xs, int n) {
  uint32_t h = 0x811c9dc5u;
  for (int i = 0; i < n * 2; i += 256) {
    uint32_t x;
    memcpy(&x, ((const uint8_t*)xs) + i * 4, 4);
    h = mix_u32(h, x);
  }
  return h;
}

static uint32_t checksum_u32(const uint32_t* xs, int n) {
  uint32_t h = 0x811c9dc5u;
  for (int i = 0; i < n; i += 128) h = mix_u32(h, xs[i]);
  return h;
}

static int median_us(double* samples, int n) {
  for (int i = 1; i < n; i++) {
    double v = samples[i];
    int j = i - 1;
    while (j >= 0 && samples[j] > v) { samples[j + 1] = samples[j]; j--; }
    samples[j + 1] = v;
  }
  return (int)(samples[(n - 1) >> 1] * 1000.0);
}

static void print_result(int median, uint32_t checksum, int samples, int stages, int runs) {
  printf("median_us=%d checksum=%u samples=%d stages=%d runs=%d\n",
         median, checksum, samples, stages, runs);
}

#endif
