// nqueens.c — bitmask N-Queens solver, counting all solutions for a range of
// board sizes. The canonical backtracking / constraint-search kernel (the shape
// behind SAT solvers, puzzle search, combinatorial enumeration): deep recursion
// with a per-node branch over the available-columns bitmask, no array state. It
// stresses call/recursion codegen and branch prediction — a profile the suite's
// flat loops do not. Pure 32-bit integer, so the solution counts are
// bit-identical across every engine and native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, recursion, bitwise ops, no
// class/async/regex.
//
// The board sizes are drawn from a runtime XorShift32 array rather than a literal
// loop bound: with literal sizes the whole recursion is a compile-time constant
// that clang/zig fold away (0 µs), making the native lane meaningless. Sourcing
// the size from runtime data is bit-identical across targets but forces every
// engine to actually run the search.
//
// Reports: median ms across N_RUNS, throughput in solutions/µs, FNV-1a checksum
// over the per-query solution counts.
#include "../_lib/bench.h"

#define NMIN     8
#define NSPAN    4
#define NQ       20
#define N_RUNS   21
#define N_WARMUP 5

static double samples[N_RUNS];
static int32_t sizes[NQ];

// Deterministic per-query board sizes — XorShift32, identical per target.
static void fill_sizes(int32_t* out) {
  uint32_t s = 0x1234abcdu;
  for (int q = 0; q < NQ; q++) {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    out[q] = (int32_t)(NMIN + s % (uint32_t)NSPAN);
  }
}

// Count placements that complete the board. `cols/d1/d2` are occupied-column and
// the two diagonal masks; `avail` isolates the legal squares of the current row,
// `b = avail & -avail` walks them lowest-bit first.
static uint32_t solve(uint32_t all, uint32_t cols, uint32_t d1, uint32_t d2) {
  if (cols == all) return 1;
  uint32_t cnt = 0;
  uint32_t avail = all & ~(cols | d1 | d2);
  while (avail != 0) {
    uint32_t b = avail & (uint32_t)(-(int32_t)avail);
    avail = avail - b;
    cnt = cnt + solve(all, cols | b, (d1 | b) << 1, (d2 | b) >> 1);
  }
  return cnt;
}

static uint32_t count_n(int n) {
  return solve((1u << n) - 1u, 0, 0, 0);
}

static uint32_t run_kernel(const int32_t* sz) {
  int32_t h = (int32_t)0x811c9dc5u;
  for (int q = 0; q < NQ; q++) {
    int32_t x = (int32_t)count_n(sz[q]);
    h = (int32_t)((uint32_t)(h ^ x) * 0x01000193u);
  }
  return (uint32_t)h;
}

int main(void) {
  fill_sizes(sizes);

  uint32_t total = 0;
  for (int q = 0; q < NQ; q++) total += count_n(sizes[q]);

  uint32_t cs = 0;
  for (int i = 0; i < N_WARMUP; i++) cs = run_kernel(sizes);

  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    cs = run_kernel(sizes);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), cs, (int)total, NMIN + NSPAN - 1, N_RUNS);
}
