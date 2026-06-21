#include "../_lib/bench.h"

#define NPIX     (256 * 256)
#define IMG_LEN  (NPIX * 4)
#define CAP      (NPIX * 5 + 64)
#define N_ITERS  10
#define N_RUNS   21
#define N_WARMUP 5

static uint8_t img[IMG_LEN];
static uint8_t ir[64], ig[64], ib[64], ia[64];
static uint8_t comp[CAP];
static uint8_t dec[IMG_LEN];
static double  samples[N_RUNS];

static void mk_image(void) {
  int32_t x = 0x12345678;
  uint8_t r = 128, g = 128, b = 128, a = 255;
  for (int p = 0; p < NPIX; p++) {
    x = (int32_t)((uint32_t)x * 1103515245u + 12345u);
    const uint32_t ux = (uint32_t)x;
    const int roll = (int)((ux >> 28) & 7);
    if (roll < 3) {
      /* keep previous pixel - run-length */
    } else if (roll < 6) {
      r = (uint8_t)((r + (int)(((ux >> 4) & 3) - 1)) & 255);
      g = (uint8_t)((g + (int)(((ux >> 6) & 3) - 1)) & 255);
      b = (uint8_t)((b + (int)(((ux >> 8) & 3) - 1)) & 255);
    } else if (roll == 6) {
      r = (uint8_t)((ux >> 10) & 255);
      g = (uint8_t)((ux >> 16) & 255);
      b = (uint8_t)((ux >> 20) & 255);
    } else {
      a = (uint8_t)((ux >> 12) & 255);
    }
    int o = p << 2;
    img[o] = r; img[o+1] = g; img[o+2] = b; img[o+3] = a;
  }
}

static int encode(void) {
  for (int i = 0; i < 64; i++) { ir[i] = 0; ig[i] = 0; ib[i] = 0; ia[i] = 0; }
  uint8_t pr = 0, pg = 0, pb = 0, pa = 255;
  int run = 0, op = 0;
  for (int p = 0; p < NPIX; p++) {
    int o = p << 2;
    uint8_t r = img[o], g = img[o+1], b = img[o+2], a = img[o+3];
    if (r == pr && g == pg && b == pb && a == pa) {
      run++;
      if (run == 62 || p == NPIX - 1) { comp[op++] = (uint8_t)(0xc0 | (run - 1)); run = 0; }
    } else {
      if (run > 0) { comp[op++] = (uint8_t)(0xc0 | (run - 1)); run = 0; }
      int h = (int)((r * 3 + g * 5 + b * 7 + a * 11) & 63);
      if (ir[h] == r && ig[h] == g && ib[h] == b && ia[h] == a) {
        comp[op++] = (uint8_t)h;
      } else {
        ir[h] = r; ig[h] = g; ib[h] = b; ia[h] = a;
        if (a == pa) {
          int vr = (int8_t)(r - pr);
          int vg = (int8_t)(g - pg);
          int vb = (int8_t)(b - pb);
          int vgr = vr - vg;
          int vgb = vb - vg;
          if (vr >= -2 && vr <= 1 && vg >= -2 && vg <= 1 && vb >= -2 && vb <= 1) {
            comp[op++] = (uint8_t)(0x40 | ((vr + 2) << 4) | ((vg + 2) << 2) | (vb + 2));
          } else if (vgr >= -8 && vgr <= 7 && vg >= -32 && vg <= 31 && vgb >= -8 && vgb <= 7) {
            comp[op++] = (uint8_t)(0x80 | (vg + 32));
            comp[op++] = (uint8_t)(((vgr + 8) << 4) | (vgb + 8));
          } else {
            comp[op++] = 0xfe; comp[op++] = r; comp[op++] = g; comp[op++] = b;
          }
        } else {
          comp[op++] = 0xff; comp[op++] = r; comp[op++] = g; comp[op++] = b; comp[op++] = a;
        }
      }
    }
    pr = r; pg = g; pb = b; pa = a;
  }
  return op;
}

static void decode(int clen) {
  for (int i = 0; i < 64; i++) { ir[i] = 0; ig[i] = 0; ib[i] = 0; ia[i] = 0; }
  uint8_t pr = 0, pg = 0, pb = 0, pa = 255;
  int run = 0, ip = 0;
  for (int p = 0; p < NPIX; p++) {
    if (run > 0) {
      run--;
    } else if (ip < clen) {
      int b0 = comp[ip++];
      if (b0 == 0xfe) { pr = comp[ip++]; pg = comp[ip++]; pb = comp[ip++]; }
      else if (b0 == 0xff) { pr = comp[ip++]; pg = comp[ip++]; pb = comp[ip++]; pa = comp[ip++]; }
      else if ((b0 & 0xc0) == 0x00) { pr = ir[b0]; pg = ig[b0]; pb = ib[b0]; pa = ia[b0]; }
      else if ((b0 & 0xc0) == 0x40) {
        pr = (uint8_t)((pr + ((b0 >> 4) & 3) - 2) & 255);
        pg = (uint8_t)((pg + ((b0 >> 2) & 3) - 2) & 255);
        pb = (uint8_t)((pb + (b0 & 3) - 2) & 255);
      } else if ((b0 & 0xc0) == 0x80) {
        int b1 = comp[ip++];
        int vg = (b0 & 63) - 32;
        pr = (uint8_t)((pr + vg + ((b1 >> 4) & 15) - 8) & 255);
        pg = (uint8_t)((pg + vg) & 255);
        pb = (uint8_t)((pb + vg + (b1 & 15) - 8) & 255);
      } else {
        run = b0 & 63;
      }
      int h = (int)((pr * 3 + pg * 5 + pb * 7 + pa * 11) & 63);
      ir[h] = pr; ig[h] = pg; ib[h] = pb; ia[h] = pa;
    }
    int o = p << 2;
    dec[o] = pr; dec[o+1] = pg; dec[o+2] = pb; dec[o+3] = pa;
  }
}

static uint32_t run_kernel(void) {
  uint32_t h = 0;
  for (int it = 0; it < N_ITERS; it++) {
    int clen = encode();
    decode(clen);
    int ok = 1;
    for (int i = 0; i < IMG_LEN; i++) if (dec[i] != img[i]) ok = 0;
    h = mix_u32(h, (uint32_t)clen);
    for (int i = 0; i < clen; i++) h = mix_u32(h, comp[i]);
    h = mix_u32(h, (uint32_t)ok);
    int j = (it % NPIX) << 2;
    img[j] = (uint8_t)((img[j] + 1) & 255);
  }
  return h;
}

int main(void) {
  mk_image();
  uint32_t cs = 0;
  for (int i = 0; i < N_WARMUP; i++) cs = run_kernel();
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    cs = run_kernel();
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), cs, NPIX * N_ITERS, 1, N_RUNS);
}
