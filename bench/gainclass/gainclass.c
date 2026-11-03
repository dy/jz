// gainclass.c – a chain of eight gain nodes over a 65536-sample f64 signal, an
// audio node graph in small.
//
// Ports gainclass.js as written. The Gain class is a struct holding its output
// buffer (malloc'd, with its length) and its gain; the constructor is
// gain_init and process a function taking the node by pointer, returning the
// node's buffer as the next node's input. mkChain's array of instances is an
// array of Gain structs, allocated once at the chain's length; render walks it
// in order.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over a sparse stride of the
// last node's output (checksum_f64, benchlib's checksumF64).
#include "../_lib/bench.h"
#include <stdlib.h>

#define N_SAMPLES 65536
#define N_NODES 8
#define N_RUNS 21
#define N_WARMUP 5

// XorShift32: deterministic per target. Output is in [-1, 1).
static double* mk_input(int n) {
  double* out = malloc(sizeof(double) * n);
  uint32_t s = 0x1234abcdu;
  for (int i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    out[i] = ((double)s / 4294967296.0) * 2.0 - 1.0;
  }
  return out;
}

typedef struct {
  double* buf;
  int len;
  double gain;
} Gain;

static void gain_init(Gain* g, int n, double gain) {
  g->buf = calloc(n, sizeof(double));
  g->len = n;
  g->gain = gain;
}

static const double* gain_process(Gain* g, const double* input) {
  double* b = g->buf;
  double gn = g->gain;
  for (int i = 0; i < g->len; i++) b[i] = input[i] * gn;
  return b;
}

static Gain* mk_chain(int n, int count) {
  Gain* nodes = malloc(sizeof(Gain) * count);
  for (int k = 0; k < count; k++) gain_init(&nodes[k], n, 0.9 + k * 0.01);
  return nodes;
}

// Hot path: every node scales the previous node's output.
static const double* render(const double* input, Gain* nodes, int count) {
  const double* x = input;
  for (int k = 0; k < count; k++) x = gain_process(&nodes[k], x);
  return x;
}

int main(void) {
  double* input = mk_input(N_SAMPLES);
  Gain* nodes = mk_chain(N_SAMPLES, N_NODES);

  for (int i = 0; i < N_WARMUP; i++) render(input, nodes, N_NODES);

  double samples[N_RUNS];
  const double* out = input;
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    out = render(input, nodes, N_NODES);
    samples[i] = now_ms() - t0;
  }

  print_result(median_us(samples, N_RUNS), checksum_f64(out, N_SAMPLES), N_SAMPLES, N_NODES, N_RUNS);
  for (int k = 0; k < N_NODES; k++) free(nodes[k].buf);
  free(nodes);
  free(input);
}
