// trace.c — square-tracing contour following over a bitmap: the first stage of every
// bitmap→vector pipeline (potrace, font autotracers). Scan for an untraced boundary
// pixel, then walk the contour with the square-tracing rule — standing on ink turn
// left, standing on paper turn right, step forward — emitting a chain code per step
// until the walk returns to its start pose (Jacob's criterion). The profile is what
// autovectorizers never touch: a tight data-dependent state machine, unpredictable
// branches, 2-D indexing, per-pixel bookkeeping — pure scalar codegen quality, branch
// layout, and bounds-check elimination.
//
// Single source compiled by all targets and run directly by the JS engines.
// Subset: const/let + arrows, typed arrays, no class/async/regex.
//
// Reports: median ms across N_RUNS, FNV-1a checksum over chain codes + loop lengths.
#include "../_lib/bench.h"
#include <stdlib.h>

#define W        512
#define H        512
#define N_ITERS  4
#define N_RUNS   21
#define N_WARMUP 5
#define MAXCODES (1 << 18)

static uint8_t bmp[W * H];
static uint8_t visited[W * H];
static uint8_t codes[MAXCODES];
static double  samples[N_RUNS];

// bitmap: union of deterministic circles (xorshift placement) — islands and punched
// lakes, so the tracer meets outer and inner contours; 1px empty frame guaranteed
static void build_bitmap(uint8_t* b) {
  uint32_t s = 0x51ce7a3u;
#define NEXT() (s ^= s << 13, s ^= s >> 17, s ^= s << 5, s)
  for (int i = 0; i < W * H; i++) b[i] = 0;
  for (int c = 0; c < 42; c++) {
    int cx = 44 + (int)(NEXT() % (W - 88));
    int cy = 44 + (int)(NEXT() % (H - 88));
    int r  = 8 + (int)(NEXT() % 33);
    int r2 = r * r;
    int fill = (c % 5 == 4) ? 0 : 1;
    for (int y = cy - r; y <= cy + r; y++) {
      int dy = y - cy;
      for (int x = cx - r; x <= cx + r; x++) {
        int dx = x - cx;
        if (dx * dx + dy * dy <= r2) b[y * W + x] = (uint8_t)fill;
      }
    }
  }
#undef NEXT
}

// square tracing from (sx,sy) entering northward: on ink turn left, on paper turn
// right, then step. dx/dy per dir: 0=E 1=S 2=W 3=N. Marks traced ink in `visited`.
static int trace_loop(const uint8_t* bmp, uint8_t* visited, uint8_t* codes, int nc, int sx, int sy) {
  int x = sx, y = sy;
  int dir = 3;                                 // entered heading north
  int steps = 0;
  while (steps < MAXCODES) {
    int inside = x >= 0 && x < W && y >= 0 && y < H && bmp[y * W + x] == 1;
    if (inside) {
      visited[y * W + x] = 1;
      dir = (dir + 3) & 3;                     // turn left
    } else {
      dir = (dir + 1) & 3;                     // turn right
    }
    if (nc < MAXCODES) codes[nc++] = (uint8_t)dir;
    if (dir == 0) x++;
    else if (dir == 1) y++;
    else if (dir == 2) x--;
    else y--;
    steps++;
    if (x == sx && y == sy && dir == 3) break;
  }
  return nc;
}

static uint32_t trace_all(const uint8_t* bmp, uint8_t* visited, uint8_t* codes) {
  int nc = 0;
  uint32_t h = 0;
  for (int i = 0; i < W * H; i++) visited[i] = 0;
  for (int y = 1; y < H - 1; y++) {
    for (int x = 1; x < W - 1; x++) {
      // boundary start: ink with paper to the west, not already traced
      if (bmp[y * W + x] == 1 && bmp[y * W + x - 1] == 0 && visited[y * W + x] == 0) {
        int start = nc;
        nc = trace_loop(bmp, visited, codes, nc, x, y);
        h = mix_u32(h, (uint32_t)(nc - start));
      }
    }
  }
  return mix_u32(h, (uint32_t)nc);
}

static uint32_t run_kernel(const uint8_t* bmp, uint8_t* visited, uint8_t* codes) {
  uint32_t h = 0;
  for (int it = 0; it < N_ITERS; it++) h = mix_u32(h, trace_all(bmp, visited, codes));
  return h;
}

int main(void) {
  build_bitmap(bmp);

  uint32_t acc = 0;
  for (int i = 0; i < N_WARMUP; i++) acc = mix_u32(acc, run_kernel(bmp, visited, codes));

  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    acc = mix_u32(acc, run_kernel(bmp, visited, codes));
    samples[i] = now_ms() - t0;
  }

  uint32_t h = 0x811c9dc5u;
  h = mix_u32(h, acc);
  for (int i = 0; i < MAXCODES; i += 64) h = mix_u32(h, codes[i]);

  print_result(median_us(samples, N_RUNS), h, W * H * N_ITERS, 1, N_RUNS);
  return 0;
}
