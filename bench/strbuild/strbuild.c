// strbuild.c — per-record string formatting: render each integer record as a
// CSV-ish line (`id,name,value\n`), fold its chars, discard. The canonical
// serialization inner loop (loggers, exporters, code generators, row writers).
// C formats into a stack buffer with sprintf — the value-semantics mirror of
// the JS per-row string temporaries. Pure ASCII and integer data, so the
// folded chars are bit-identical across every engine and native target.
//
// Reports: median ms across N_RUNS, throughput in rows/µs, FNV-1a checksum
// over every formatted line's characters.
#include "../_lib/bench.h"

#define N        4096            // rows per pass
#define N_ITERS  4               // passes per kernel run
#define N_RUNS   21
#define N_WARMUP 5

static const char* NAMES[16] = { "alpha", "bravo", "carol", "delta", "echo", "fox", "golf", "hotel",
  "india", "jazz", "kilo", "lima", "mike", "nova", "oscar", "papa" };

static int32_t code[N];
static int32_t vals[N];
static double  samples[N_RUNS];

// Deterministic row stream — XorShift32, identical per target; low bits pick
// the name, the rest is the (signed) value column.
static void fill(int32_t* c, int32_t* v) {
  int32_t s = (int32_t)0x1234abcd;
  for (int i = 0; i < N; i++) {
    s ^= s << 13;
    s ^= (int32_t)((uint32_t)s >> 17);
    s ^= s << 5;
    c[i] = s & 15;
    v[i] = s >> 4;
  }
}

static uint32_t run_kernel(const int32_t* c, const int32_t* v) {
  uint32_t h = 0x811c9dc5u;
  char line[64];
  for (int it = 0; it < N_ITERS; it++) {
    for (int i = 0; i < N; i++) {
      int len = snprintf(line, sizeof(line), "%d,%s,%d\n", i, NAMES[c[i]], (int)(v[i] + it));
      for (int j = 0; j < len; j++) h = mix_u32(h, (uint32_t)(uint8_t)line[j]);
    }
  }
  return h;
}

int main(void) {
  fill(code, vals);
  uint32_t cs = 0;
  for (int i = 0; i < N_WARMUP; i++) cs = run_kernel(code, vals);
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    cs = run_kernel(code, vals);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), cs, N * N_ITERS, 3, N_RUNS);
}
