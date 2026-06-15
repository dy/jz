#include "../_lib/bench.h"
#include <stdlib.h>
#include <math.h>

#define SR 44100
#define N_NOTES 64
#define NOTE_LEN 8192
#define N (N_NOTES * NOTE_LEN)
#define N_RUNS 21
#define N_WARMUP 5

#define ATTACK 400
#define DECAY 1600
#define RELEASE 2400
#define SUSTAIN 0.6

#define B0 0.0675
#define B1 0.135
#define B2 0.0675
#define A1 (-1.143)
#define A2 0.412

static const double FREQS[8] = {261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88, 523.25};

static double sin_tau(double ph) {
  double q = ph * 4.0;
  double m = floor(q + 0.5);
  double phi = (q - m) * 1.5707963267948966;
  double p2 = phi * phi;
  double sp = phi * (1.0 + p2 * (-0.16666666666666666 + p2 * (0.008333333333333333 + p2 * (-0.0001984126984126984 + p2 * (2.7557319223985893e-06 + p2 * -2.505210838544172e-08)))));
  double cp = 1.0 + p2 * (-0.5 + p2 * (0.041666666666666664 + p2 * (-0.001388888888888889 + p2 * (2.48015873015873e-05 + p2 * -2.7557319223985894e-07))));
  int r = ((int)m) & 3;
  return r == 0 ? sp : r == 1 ? cp : r == 2 ? -sp : -cp;
}

static void render(double* out) {
  double x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (int note = 0; note < N_NOTES; note++) {
    double freq = FREQS[(note * 3 + 1) & 7] * (((note >> 2) & 1) ? 2.0 : 1.0);
    double dph = freq / SR;
    double ph = 0;
    int off = note * NOTE_LEN;
    for (int t = 0; t < NOTE_LEN; t++) {
      double tf = (double)t;
      double env = tf < ATTACK ? tf / ATTACK
        : tf < ATTACK + DECAY ? 1.0 - (1.0 - SUSTAIN) * (tf - ATTACK) / DECAY
        : tf < NOTE_LEN - RELEASE ? SUSTAIN
        : (NOTE_LEN - tf) / RELEASE * SUSTAIN;
      double s = sin_tau(ph) * env;
      ph += dph;
      if (ph >= 1.0) ph -= 1.0;
      double y = B0 * s + B1 * x1 + B2 * x2 - A1 * y1 - A2 * y2;
      x2 = x1; x1 = s; y2 = y1; y1 = y;
      out[off + t] = y;
    }
  }
}

int main(void) {
  double* out = malloc(sizeof(double) * N);
  double samples[N_RUNS];
  for (int i = 0; i < N_WARMUP; i++) render(out);
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    render(out);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), checksum_f64(out, N), N, N_NOTES, N_RUNS);
  free(out);
}
