// immutable.c — a particle step in the immutable-update idiom: every step
// replaces each record wholesale instead of mutating fields. The canonical
// functional-state kernel (reducers, persistent game state, event-sourced
// models). C gets the pattern free through value semantics — a compound
// literal assigned by value, zero allocation — the static reference for what
// the fresh-object JS idiom costs. Pure integer bounce physics, so positions
// are bit-identical across every engine and native target.
//
// Reports: median ms across N_RUNS, throughput in particle-steps/µs, FNV-1a
// checksum over the per-pass position folds.
#include "../_lib/bench.h"

#define N        4096            // particles
#define STEPS    32              // steps per pass (one record replacement per particle per step)
#define LIM      1023            // box bound
#define N_RUNS   21
#define N_WARMUP 5

typedef struct { int32_t x, y, vx, vy; } P;

static P      ps[N];
static double samples[N_RUNS];

// Deterministic initial state — XorShift32 positions in [0, LIM], velocities
// in [-8, 8] forced nonzero, identical per target.
static void init_particles(void) {
  int32_t s = (int32_t)0x1234abcd;
  for (int i = 0; i < N; i++) {
    s ^= s << 13;
    s ^= (int32_t)((uint32_t)s >> 17);
    s ^= s << 5;
    int32_t vx = (int32_t)(((uint32_t)s >> 4) & 15u) - 8;
    int32_t vy = (int32_t)(((uint32_t)s >> 8) & 15u) - 8;
    ps[i] = (P){
      (int32_t)(((uint32_t)s >> 12) & LIM),
      (int32_t)(((uint32_t)s >> 20) & LIM),
      vx == 0 ? 1 : vx,
      vy == 0 ? 1 : vy,
    };
  }
}

static uint32_t run_kernel(void) {
  uint32_t h = 0x811c9dc5u;
  for (int it = 0; it < STEPS; it++) {
    int32_t sum = it;
    for (int i = 0; i < N; i++) {
      P p = ps[i];
      int32_t nx = p.x + p.vx, ny = p.y + p.vy;
      int hitX = nx < 0 || nx > LIM, hitY = ny < 0 || ny > LIM;
      int32_t x = hitX ? p.x : nx, y = hitY ? p.y : ny;
      int32_t vx = hitX ? -p.vx : p.vx, vy = hitY ? -p.vy : p.vy;
      ps[i] = (P){ x, y, vx, vy };
      sum = (int32_t)((uint32_t)sum + (uint32_t)x + (uint32_t)y * 31u);
    }
    h = mix_u32(h, (uint32_t)sum);
  }
  return h;
}

int main(void) {
  uint32_t cs = 0;
  // Fresh particle set per run — the kernel mutates the array, so timing runs
  // must not compound each other's motion.
  for (int i = 0; i < N_WARMUP; i++) { init_particles(); cs = run_kernel(); }
  for (int i = 0; i < N_RUNS; i++) {
    init_particles();
    double t0 = now_ms();
    cs = run_kernel();
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), cs, N * STEPS, 1, N_RUNS);
}
