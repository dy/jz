// threeanim.c – QuaternionLinearInterpolant's slerp of ten thousand bone
// rotations: every frame each bone's rotation is interpolated between two
// keyframes by three.js's static Quaternion.slerpFlat over flat Float32
// keyframe buffers at an offset, the animation-mixer kernel.
//
// Ports three.js 0.186.1 (node_modules/three, MIT license, the three.js
// authors) as written: Euler (constructor, set) and Quaternion (constructor,
// setFromEuler with all six rotation orders, toArray, the static slerpFlat with
// its slerp and lerp-then-normalize branches). Each class is a struct of f64
// fields and each method a function taking the receiver by pointer and, where
// three.js chains, returning it. Euler.set keeps the current order (the case
// passes none), and the change callbacks three.js fires are its empty
// defaults, so they are left out. The keyframe buffers are Float32Arrays in
// the JavaScript: float arrays here, read into double and stored back
// rounded, as JS reads and writes them.
//
// Reports: median ms across N_RUNS, slerps per run, and FNV-1a over the nine
// sampled values at single precision (checksumF64Near: acos and sin bits
// differ per libm).
#include "../_lib/bench.h"
#include <math.h>
#include <stdlib.h>

#define N 10000
#define ITERS 40
#define N_RUNS 21
#define N_WARMUP 5

typedef enum { XYZ, YXZ, ZXY, ZYX, YZX, XZY } EulerOrder;

typedef struct { double x, y, z; EulerOrder order; } Euler;
typedef struct { double x, y, z, w; } Quaternion;

static Euler euler_new(double x, double y, double z) { return (Euler){ x, y, z, XYZ }; }

static Euler *euler_set(Euler *e, double x, double y, double z) {
  e->x = x;
  e->y = y;
  e->z = z;
  return e;
}

static Quaternion quaternion_new(void) { return (Quaternion){ 0, 0, 0, 1 }; }

static Quaternion *quaternion_set_from_euler(Quaternion *q, const Euler *euler) {
  double x = euler->x, y = euler->y, z = euler->z;

  double c1 = cos(x / 2);
  double c2 = cos(y / 2);
  double c3 = cos(z / 2);

  double s1 = sin(x / 2);
  double s2 = sin(y / 2);
  double s3 = sin(z / 2);

  switch (euler->order) {
    case XYZ:
      q->x = s1 * c2 * c3 + c1 * s2 * s3;
      q->y = c1 * s2 * c3 - s1 * c2 * s3;
      q->z = c1 * c2 * s3 + s1 * s2 * c3;
      q->w = c1 * c2 * c3 - s1 * s2 * s3;
      break;
    case YXZ:
      q->x = s1 * c2 * c3 + c1 * s2 * s3;
      q->y = c1 * s2 * c3 - s1 * c2 * s3;
      q->z = c1 * c2 * s3 - s1 * s2 * c3;
      q->w = c1 * c2 * c3 + s1 * s2 * s3;
      break;
    case ZXY:
      q->x = s1 * c2 * c3 - c1 * s2 * s3;
      q->y = c1 * s2 * c3 + s1 * c2 * s3;
      q->z = c1 * c2 * s3 + s1 * s2 * c3;
      q->w = c1 * c2 * c3 - s1 * s2 * s3;
      break;
    case ZYX:
      q->x = s1 * c2 * c3 - c1 * s2 * s3;
      q->y = c1 * s2 * c3 + s1 * c2 * s3;
      q->z = c1 * c2 * s3 - s1 * s2 * c3;
      q->w = c1 * c2 * c3 + s1 * s2 * s3;
      break;
    case YZX:
      q->x = s1 * c2 * c3 + c1 * s2 * s3;
      q->y = c1 * s2 * c3 + s1 * c2 * s3;
      q->z = c1 * c2 * s3 - s1 * s2 * c3;
      q->w = c1 * c2 * c3 - s1 * s2 * s3;
      break;
    case XZY:
      q->x = s1 * c2 * c3 - c1 * s2 * s3;
      q->y = c1 * s2 * c3 - s1 * c2 * s3;
      q->z = c1 * c2 * s3 + s1 * s2 * c3;
      q->w = c1 * c2 * c3 + s1 * s2 * s3;
      break;
  }
  return q;
}

static float *quaternion_to_array(const Quaternion *q, float *array, int offset) {
  array[offset] = (float)q->x;
  array[offset + 1] = (float)q->y;
  array[offset + 2] = (float)q->z;
  array[offset + 3] = (float)q->w;
  return array;
}

static void quaternion_slerp_flat(float *dst, int dstOffset, const float *src0, int srcOffset0,
                                  const float *src1, int srcOffset1, double t) {
  double x0 = src0[srcOffset0 + 0],
         y0 = src0[srcOffset0 + 1],
         z0 = src0[srcOffset0 + 2],
         w0 = src0[srcOffset0 + 3];

  double x1 = src1[srcOffset1 + 0],
         y1 = src1[srcOffset1 + 1],
         z1 = src1[srcOffset1 + 2],
         w1 = src1[srcOffset1 + 3];

  if (w0 != w1 || x0 != x1 || y0 != y1 || z0 != z1) {
    double dot = x0 * x1 + y0 * y1 + z0 * z1 + w0 * w1;

    if (dot < 0) {
      x1 = -x1;
      y1 = -y1;
      z1 = -z1;
      w1 = -w1;

      dot = -dot;
    }

    double s = 1 - t;

    if (dot < 0.9995) {
      // slerp
      double theta = acos(dot);
      double sn = sin(theta);

      s = sin(s * theta) / sn;
      t = sin(t * theta) / sn;

      x0 = x0 * s + x1 * t;
      y0 = y0 * s + y1 * t;
      z0 = z0 * s + z1 * t;
      w0 = w0 * s + w1 * t;
    } else {
      // for small angles, lerp then normalize
      x0 = x0 * s + x1 * t;
      y0 = y0 * s + y1 * t;
      z0 = z0 * s + z1 * t;
      w0 = w0 * s + w1 * t;

      double f = 1 / sqrt(x0 * x0 + y0 * y0 + z0 * z0 + w0 * w0);

      x0 *= f;
      y0 *= f;
      z0 *= f;
      w0 *= f;
    }
  }

  dst[dstOffset] = (float)x0;
  dst[dstOffset + 1] = (float)y0;
  dst[dstOffset + 2] = (float)z0;
  dst[dstOffset + 3] = (float)w0;
}

static uint32_t seed = 5;
static double rnd(void) {
  seed = seed * 1664525u + 1013904223u;
  return (double)seed / 4294967296.0;
}

static void run(double *out, const float *src0, const float *src1, float *dst) {
  double s = 0;
  for (int k = 0; k < ITERS; k++) {
    double t = (double)(k % 100) / 100;
    for (int i = 0; i < N; i++) quaternion_slerp_flat(dst, i * 4, src0, i * 4, src1, i * 4, t);
    s += dst[(k * 4) % (N * 4)];
  }
  out[0] = s;
  for (int k = 0; k < 8; k++) out[k + 1] = dst[k * 4099 % (N * 4)];
}

int main(void) {
  float *src0 = calloc(N * 4, sizeof(float));
  float *src1 = calloc(N * 4, sizeof(float));
  float *dst = calloc(N * 4, sizeof(float));
  Quaternion q = quaternion_new();
  Euler e = euler_new(0, 0, 0);
  for (int i = 0; i < N; i++) {
    // JS evaluates set()'s arguments left to right; C leaves argument order
    // unspecified, so each draw is its own statement.
    double x = rnd() * 6;
    double y = rnd() * 6;
    double z = rnd() * 6;
    quaternion_to_array(quaternion_set_from_euler(&q, euler_set(&e, x, y, z)), src0, i * 4);
    x = rnd() * 6;
    y = rnd() * 6;
    z = rnd() * 6;
    quaternion_to_array(quaternion_set_from_euler(&q, euler_set(&e, x, y, z)), src1, i * 4);
  }

  double out[9];
  for (int i = 0; i < N_WARMUP; i++) run(out, src0, src1, dst);

  double samples[N_RUNS];
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    run(out, src0, src1, dst);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), checksum_f64_near(out, 9), N * ITERS, 1, N_RUNS);
  free(src0);
  free(src1);
  free(dst);
  return 0;
}
