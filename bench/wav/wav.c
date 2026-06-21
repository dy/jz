#include "../_lib/bench.h"
#include <stdlib.h>

#define N       131072
#define SR      44100
#define HDR     44
#define BYTES   (HDR + N * 2)
#define N_ITERS 16
#define N_RUNS  21
#define N_WARMUP 5

static double  samples_f64[N];
static uint8_t out_buf[BYTES];
static double  timing[N_RUNS];

static void mk_samples(double* s) {
  int32_t x = 0x1234abcd;
  for (int i = 0; i < N; i++) {
    x ^= x << 13;
    x ^= (int32_t)((uint32_t)x >> 17);
    x ^= x << 5;
    s[i] = (((uint32_t)x / 4294967296.0) * 2.0 - 1.0) * 1.2;
  }
}

static void write_u32(uint8_t* b, int off, uint32_t v) {
  b[off]     = (uint8_t)(v & 0xff);
  b[off + 1] = (uint8_t)((v >> 8)  & 0xff);
  b[off + 2] = (uint8_t)((v >> 16) & 0xff);
  b[off + 3] = (uint8_t)((v >> 24) & 0xff);
}

static void write_u16(uint8_t* b, int off, uint32_t v) {
  b[off]     = (uint8_t)(v & 0xff);
  b[off + 1] = (uint8_t)((v >> 8) & 0xff);
}

static void encode(const double* s, int n, uint8_t* out) {
  uint32_t data_bytes = (uint32_t)(n * 2);
  out[0] = 82; out[1] = 73; out[2] = 70; out[3] = 70;       /* RIFF */
  write_u32(out, 4, 36 + data_bytes);
  out[8] = 87; out[9] = 65; out[10] = 86; out[11] = 69;     /* WAVE */
  out[12] = 102; out[13] = 109; out[14] = 116; out[15] = 32; /* fmt  */
  write_u32(out, 16, 16);
  write_u16(out, 20, 1);
  write_u16(out, 22, 1);
  write_u32(out, 24, SR);
  write_u32(out, 28, SR * 2);
  write_u16(out, 32, 2);
  write_u16(out, 34, 16);
  out[36] = 100; out[37] = 97; out[38] = 116; out[39] = 97; /* data */
  write_u32(out, 40, data_bytes);
  int op = HDR;
  for (int i = 0; i < n; i++) {
    double v = s[i] * 32767.0;
    if      (v >  32767.0) v =  32767.0;
    else if (v < -32768.0) v = -32768.0;
    uint32_t u = (uint32_t)((int32_t)v & 0xffff);
    out[op]     = (uint8_t)(u & 0xff);
    out[op + 1] = (uint8_t)((u >> 8) & 0xff);
    op += 2;
  }
}

static uint32_t run_kernel(double* s, uint8_t* out) {
  uint32_t h = 0;
  for (int it = 0; it < N_ITERS; it++) {
    encode(s, N, out);
    h = mix_u32(h, checksum_u8(out, BYTES));
    int j = it % N;
    s[j] = -s[j];
  }
  return h;
}

int main(void) {
  mk_samples(samples_f64);
  uint32_t cs = 0;
  for (int i = 0; i < N_WARMUP; i++) cs = run_kernel(samples_f64, out_buf);
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    cs = run_kernel(samples_f64, out_buf);
    timing[i] = now_ms() - t0;
  }
  print_result(median_us(timing, N_RUNS), cs, N * N_ITERS, 1, N_RUNS);
}
