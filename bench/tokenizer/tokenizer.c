#include "../_lib/bench.h"
#include <stdlib.h>

#define N_REPEAT 512
#define N_RUNS 21
#define N_WARMUP 5

static const char* BASE = "let alpha_12 = beta + 12345; if (alpha_12 >= 99) { total = total + alpha_12; }\n";

static char* make_source(int* len) {
  int base_len = (int)strlen(BASE);
  *len = base_len * N_REPEAT;
  char* src = malloc((size_t)*len + 1);
  for (int i = 0; i < N_REPEAT; i++) memcpy(src + i * base_len, BASE, (size_t)base_len);
  src[*len] = 0;
  return src;
}

static int is_alpha(int c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95;
}

static uint32_t scan(const char* src, int len) {
  uint32_t h = 0x811c9dc5u;
  int number = 0, in_number = 0, in_ident = 0, tokens = 0;
  for (int i = 0; i < len; i++) {
    int c = (unsigned char)src[i];
    if (c >= 48 && c <= 57) {
      number = number * 10 + c - 48;
      in_number = 1;
    } else {
      if (in_number) { h = mix_u32(h, (uint32_t)number); tokens++; number = 0; in_number = 0; }
      if (is_alpha(c)) {
        if (!in_ident) { h = mix_u32(h, (uint32_t)c); tokens++; }
        in_ident = 1;
      } else {
        if (c > 32) { h = mix_u32(h, (uint32_t)c); tokens++; }
        in_ident = 0;
      }
    }
  }
  if (in_number) { h = mix_u32(h, (uint32_t)number); tokens++; }
  return mix_u32(h, (uint32_t)tokens);
}

int main(void) {
  int len = 0;
  char* src = make_source(&len);
  double samples[N_RUNS];
  uint32_t cs = 0;
  for (int i = 0; i < N_WARMUP; i++) cs = scan(src, len);
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    cs = scan(src, len);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), cs, len, 5, N_RUNS);
  free(src);
}
