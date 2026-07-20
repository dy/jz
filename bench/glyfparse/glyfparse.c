// glyfparse.c — TrueType `glyf`-style outline decoding: flag runs with REPEAT counts,
// then variable-length coordinate deltas (short-unsigned-with-sign bit or long-16-bit or
// same-as-previous), accumulated to absolute positions — the byte-grammar every font
// stack (HarfBuzz, FreeType, fonttools) hot-loops over. The profile: unpredictable
// per-byte branches, variable-length records, bit tests, running accumulators — parser
// codegen without dragging in a whole compiler. Pure integer, bit-identical everywhere.
//
// The stream is synthesized once (deterministic xorshift) by the same rules, so parsing
// is validated by construction: the checksum covers decoded absolute coordinates and
// per-glyph point counts.
//
// Single source compiled by all targets and run directly by the JS engines.
// Subset: const/let + arrows, typed arrays, no class/async/regex.
//
// Reports: median ms across N_RUNS, FNV-1a checksum over decoded coordinates.
#include "../_lib/bench.h"
#include <stdlib.h>

#define NG         600               // glyphs
#define MAXPTS     120
#define STREAM_CAP (1 << 19)
#define N_ITERS    12
#define N_RUNS     21
#define N_WARMUP   5

static uint8_t stream[STREAM_CAP];
static int32_t glyphOff[NG];
static int32_t glyphPts[NG];
static uint8_t flagBuf[MAXPTS];
static double  samples[N_RUNS];

// flag bits (TrueType): 0x01 on-curve · 0x02 x-short · 0x04 y-short · 0x08 repeat ·
// 0x10 x-same/positive · 0x20 y-same/positive
static void build_stream(uint8_t* strm, int32_t* gOff, int32_t* gPts) {
  uint32_t s = 0x8e1d3a5u;
#define NEXT() (s ^= s << 13, s ^= s >> 17, s ^= s << 5, s)
  int w = 0;
  uint8_t flags[MAXPTS];
  for (int g = 0; g < NG; g++) {
    gOff[g] = w;
    int np = 20 + (int)(NEXT() % (MAXPTS - 20 + 1));
    gPts[g] = np;
    // decide per-point flags first
    for (int p = 0; p < np; p++) {
      int dxKind = (int)(NEXT() % 3);
      int dyKind = (int)(NEXT() % 3);
      int f = (int)(NEXT() & 1);               // on-curve
      if (dxKind == 0) f |= 0x02 | ((int)(NEXT() & 1) << 4);
      else if (dxKind == 2) f |= 0x10;
      if (dyKind == 0) f |= 0x04 | ((int)(NEXT() & 1) << 5);
      else if (dyKind == 2) f |= 0x20;
      flags[p] = (uint8_t)f;
    }
    // write flags with REPEAT compression
    int p = 0;
    while (p < np) {
      int run = 1;
      while (p + run < np && flags[p + run] == flags[p] && run < 255) run++;
      if (run > 1) {
        strm[w++] = flags[p] | 0x08;
        strm[w++] = (uint8_t)(run - 1);
      } else {
        strm[w++] = flags[p];
      }
      p += run;
    }
    // x deltas
    for (int p2 = 0; p2 < np; p2++) {
      uint8_t f = flags[p2];
      if (f & 0x02) {
        strm[w++] = (uint8_t)(NEXT() % 256);
      } else if (!(f & 0x10)) {
        uint32_t d = NEXT() & 0xffffu;
        strm[w++] = (uint8_t)(d >> 8);
        strm[w++] = (uint8_t)(d & 255);
      }
    }
    // y deltas
    for (int p2 = 0; p2 < np; p2++) {
      uint8_t f = flags[p2];
      if (f & 0x04) {
        strm[w++] = (uint8_t)(NEXT() % 256);
      } else if (!(f & 0x20)) {
        uint32_t d = NEXT() & 0xffffu;
        strm[w++] = (uint8_t)(d >> 8);
        strm[w++] = (uint8_t)(d & 255);
      }
    }
  }
#undef NEXT
}

// decode every glyph: flags (expanding repeats), then x accumulation, then y
static uint32_t parse_all(const uint8_t* strm, const int32_t* gOff, const int32_t* gPts, uint8_t* fbuf) {
  uint32_t h = 0x811c9dc5u;
  for (int g = 0; g < NG; g++) {
    int r = gOff[g];
    int np = gPts[g];
    int p = 0;
    while (p < np) {
      uint8_t f = strm[r++];
      fbuf[p++] = f;
      if (f & 0x08) {
        int rep = strm[r++];
        while (rep > 0) { fbuf[p++] = f; rep--; }
      }
    }
    int32_t x = 0;
    int onCount = 0;
    for (int i = 0; i < np; i++) {
      uint8_t f = fbuf[i];
      if (f & 0x02) {
        int d = strm[r++];
        x = (f & 0x10) ? x + d : x - d;
      } else if (!(f & 0x10)) {
        int16_t raw = (int16_t)(((uint32_t)strm[r] << 8) | (uint32_t)strm[r + 1]);
        x = x + raw;
        r += 2;
      }
      h = mix_u32(h, (uint32_t)x);
      onCount += f & 1;
    }
    int32_t y = 0;
    for (int i = 0; i < np; i++) {
      uint8_t f = fbuf[i];
      if (f & 0x04) {
        int d = strm[r++];
        y = (f & 0x20) ? y + d : y - d;
      } else if (!(f & 0x20)) {
        int16_t raw = (int16_t)(((uint32_t)strm[r] << 8) | (uint32_t)strm[r + 1]);
        y = y + raw;
        r += 2;
      }
      h = mix_u32(h, (uint32_t)y);
    }
    h = mix_u32(h, (uint32_t)onCount);
  }
  return h;
}

static uint32_t run_kernel(const uint8_t* strm, const int32_t* gOff, const int32_t* gPts, uint8_t* fbuf) {
  uint32_t h = 0;
  for (int it = 0; it < N_ITERS; it++) h = mix_u32(h, parse_all(strm, gOff, gPts, fbuf));
  return h;
}

int main(void) {
  build_stream(stream, glyphOff, glyphPts);

  uint32_t acc = 0;
  for (int i = 0; i < N_WARMUP; i++) acc = mix_u32(acc, run_kernel(stream, glyphOff, glyphPts, flagBuf));

  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    acc = mix_u32(acc, run_kernel(stream, glyphOff, glyphPts, flagBuf));
    samples[i] = now_ms() - t0;
  }

  print_result(median_us(samples, N_RUNS), acc, NG * N_ITERS, 1, N_RUNS);
  return 0;
}
