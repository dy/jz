// Host timing only; the JavaScript workload is unchanged.
#include <time.h>
#include <stdlib.h>

double jz_bench_now(void) {
  struct timespec t;
  if (clock_gettime(CLOCK_MONOTONIC, &t)) abort();
  return (double)t.tv_sec * 1000.0 + (double)t.tv_nsec / 1000000.0;
}
