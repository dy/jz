#include "../_lib/bench.h"

#define N       24576
#define ENC_LEN ((N / 3) * 4)
#define N_ITERS 64
#define N_RUNS  21
#define N_WARMUP 5

static uint8_t src[N];
static uint8_t enc_tab[64];
static uint8_t dec_tab[256];
static uint8_t b64[ENC_LEN];
static uint8_t back[N];
static double  samples[N_RUNS];

static void build_enc(void) {
  int i = 0;
  for (int c = 65; c <= 90; c++)  enc_tab[i++] = (uint8_t)c;  /* A-Z */
  for (int c = 97; c <= 122; c++) enc_tab[i++] = (uint8_t)c;  /* a-z */
  for (int c = 48; c <= 57; c++)  enc_tab[i++] = (uint8_t)c;  /* 0-9 */
  enc_tab[i++] = 43;  /* + */
  enc_tab[i++] = 47;  /* / */
}

static void build_dec(void) {
  for (int i = 0; i < 256; i++) dec_tab[i] = 0;
  for (int i = 0; i < 64; i++)  dec_tab[enc_tab[i]] = (uint8_t)i;
}

static void init_buf(void) {
  int32_t x = (int32_t)0x12345678;
  for (int i = 0; i < N; i++) {
    x = (int32_t)((int32_t)((uint32_t)x * 1103515245u) + 12345);
    src[i] = (uint8_t)(((uint32_t)x >> 16) & 0xffu);
  }
}

static int encode(void) {
  int op = 0;
  for (int i = 0; i + 3 <= N; i += 3) {
    uint8_t a = src[i], b = src[i + 1], c = src[i + 2];
    b64[op]     = enc_tab[a >> 2];
    b64[op + 1] = enc_tab[((a & 3) << 4) | (b >> 4)];
    b64[op + 2] = enc_tab[((b & 15) << 2) | (c >> 6)];
    b64[op + 3] = enc_tab[c & 63];
    op += 4;
  }
  return op;
}

static int decode(void) {
  int op = 0;
  for (int i = 0; i + 4 <= ENC_LEN; i += 4) {
    uint8_t a = dec_tab[b64[i]], b = dec_tab[b64[i + 1]],
            c = dec_tab[b64[i + 2]], d = dec_tab[b64[i + 3]];
    back[op]     = (uint8_t)(((a << 2) | (b >> 4)) & 0xff);
    back[op + 1] = (uint8_t)((((b & 15) << 4) | (c >> 2)) & 0xff);
    back[op + 2] = (uint8_t)((((c & 3) << 6) | d) & 0xff);
    op += 3;
  }
  return op;
}

static uint32_t checksum_u8_local(const uint8_t* xs, int n) {
  uint32_t h = 0x811c9dc5u;
  for (int i = 0; i < n; i++) h = mix_u32(h, xs[i]);
  return h;
}

static uint32_t run_kernel(void) {
  uint32_t h = 0;
  for (int it = 0; it < N_ITERS; it++) {
    encode();
    decode();
    int ok = 1;
    for (int i = 0; i < N; i++) if (back[i] != src[i]) ok = 0;
    uint32_t cs_b64 = checksum_u8_local(b64, ENC_LEN);
    h = mix_u32(mix_u32(h, cs_b64), (uint32_t)ok);
    int j = it % N;
    src[j] = (uint8_t)((src[j] + 1u) & 0xffu);
  }
  return h;
}

int main(void) {
  build_enc();
  build_dec();
  init_buf();
  uint32_t cs = 0;
  for (int i = 0; i < N_WARMUP; i++) cs = run_kernel();
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    cs = run_kernel();
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), cs, N * N_ITERS, 1, N_RUNS);
}
