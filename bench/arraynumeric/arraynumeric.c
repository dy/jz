// arraynumeric.c – a plain array that stays numeric: a quarter million
// integers pushed one by one, then 25 passes that add 1 to every slot, ported
// from arraynumeric.js (Perry's bench_numeric_array_numeric.ts,
// https://github.com/PerryTS/perry, benchmarks/suite, MIT).
//
// The JS array of numbers is a growable buffer of doubles, its capacity
// doubled by realloc as push fills it; each run builds one and frees it, as the
// JS drops its array.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over every run's result
// and every slot of one more run's array, as the JS folds them.
#include "../_lib/bench.h"
#include <stdlib.h>

#define SIZE       250000
#define ITERATIONS 25
#define N_RUNS     21
#define N_WARMUP   3

typedef struct { double *at; size_t len, cap; } Array;

static void push(Array *a, double x) {
  if (a->len == a->cap) {
    a->cap = a->cap ? a->cap * 2 : 4;
    a->at = realloc(a->at, a->cap * sizeof *a->at);
    if (!a->at) { perror("realloc"); exit(1); }
  }
  a->at[a->len++] = x;
}

static Array build_numeric_array(void) {
  Array arr = { 0 };
  for (int i = 0; i < SIZE; i++) {
    push(&arr, i);
  }
  return arr;
}

static double mutate_numeric_array(Array *arr) {
  double checksum = 0;

  for (int iter = 0; iter < ITERATIONS; iter++) {
    for (size_t i = 0; i < arr->len; i++) {
      arr->at[i] = arr->at[i] + 1;
    }
    checksum = checksum + arr->at[0] + arr->at[arr->len - 1];
  }

  return checksum + (double)arr->len;
}

static double run_numeric_array(void) {
  Array arr = build_numeric_array();
  double cs = mutate_numeric_array(&arr);
  free(arr.at);
  return cs;
}

// x | 0 for the integers these sums hold
static uint32_t i32(double x) { return (uint32_t)(int32_t)x; }

int main(void) {
  for (int i = 0; i < N_WARMUP; i++) run_numeric_array();

  uint32_t h = 0x811c9dc5u;
  double samples[N_RUNS];
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    double cs = run_numeric_array();
    samples[i] = now_ms() - t0;
    h = mix_u32(h, i32(cs));
  }

  Array arr = build_numeric_array();
  h = mix_u32(h, i32(mutate_numeric_array(&arr)));
  for (size_t i = 0; i < arr.len; i++) h = mix_u32(h, i32(arr.at[i]));
  print_result(median_us(samples, N_RUNS), h, SIZE, 2, N_RUNS);

  free(arr.at);
  return 0;
}
