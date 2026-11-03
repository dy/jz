// threescene.c – Object3D.updateMatrixWorld over a scene of chains: every
// frame each of ten thousand nodes composes its local matrix from its
// position, quaternion and scale, then multiplies it by its parent's world
// matrix (the previous node, or a root every eighth node), the scene-graph
// kernel.
//
// Ports three.js 0.186.1 (node_modules/three, MIT license, the three.js
// authors) as written: Vector3 (constructor), Euler (constructor, set),
// Quaternion (constructor, setFromEuler with all six rotation orders) and
// Matrix4 (constructor, set, makeRotationY, compose, multiplyMatrices). Each
// class is a struct and each method a function taking the receiver by pointer
// and returning it where three.js chains. A Matrix4's `elements` is a plain JS
// Array of sixteen numbers, so a double[16] in column-major order, as three.js
// stores it. The JavaScript's arrays of class instances (positions,
// quaternions, scales, local and world matrices) are arrays of structs.
// Euler.set keeps the current order (the case passes none), and the change
// callbacks three.js fires are its empty defaults, so they are left out.
//
// Reports: median ms across N_RUNS, node updates per run, and FNV-1a over the
// last world matrix and the per-frame sum of its x translation at single
// precision (checksumF64Near: the rotations come through sin and cos).
#include "../_lib/bench.h"
#include <math.h>
#include <stdlib.h>

#define N 10000
#define FRAMES 20
#define N_RUNS 21
#define N_WARMUP 5

typedef enum { XYZ, YXZ, ZXY, ZYX, YZX, XZY } EulerOrder;

typedef struct { double x, y, z; } Vector3;
typedef struct { double x, y, z; EulerOrder order; } Euler;
typedef struct { double x, y, z, w; } Quaternion;
typedef struct { double elements[16]; } Matrix4;

static Vector3 vector3_new(double x, double y, double z) { return (Vector3){ x, y, z }; }

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

static Matrix4 matrix4_new(void) {
  return (Matrix4){ { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 } };
}

static Matrix4 *matrix4_set(Matrix4 *m, double n11, double n12, double n13, double n14,
                            double n21, double n22, double n23, double n24,
                            double n31, double n32, double n33, double n34,
                            double n41, double n42, double n43, double n44) {
  double *te = m->elements;

  te[0] = n11; te[4] = n12; te[8] = n13; te[12] = n14;
  te[1] = n21; te[5] = n22; te[9] = n23; te[13] = n24;
  te[2] = n31; te[6] = n32; te[10] = n33; te[14] = n34;
  te[3] = n41; te[7] = n42; te[11] = n43; te[15] = n44;

  return m;
}

static Matrix4 *matrix4_make_rotation_y(Matrix4 *m, double theta) {
  double c = cos(theta), s = sin(theta);

  matrix4_set(m,
     c, 0, s, 0,
     0, 1, 0, 0,
    -s, 0, c, 0,
     0, 0, 0, 1);

  return m;
}

static Matrix4 *matrix4_multiply_matrices(Matrix4 *m, const Matrix4 *a, const Matrix4 *b) {
  const double *ae = a->elements;
  const double *be = b->elements;
  double *te = m->elements;

  double a11 = ae[0], a12 = ae[4], a13 = ae[8], a14 = ae[12];
  double a21 = ae[1], a22 = ae[5], a23 = ae[9], a24 = ae[13];
  double a31 = ae[2], a32 = ae[6], a33 = ae[10], a34 = ae[14];
  double a41 = ae[3], a42 = ae[7], a43 = ae[11], a44 = ae[15];

  double b11 = be[0], b12 = be[4], b13 = be[8], b14 = be[12];
  double b21 = be[1], b22 = be[5], b23 = be[9], b24 = be[13];
  double b31 = be[2], b32 = be[6], b33 = be[10], b34 = be[14];
  double b41 = be[3], b42 = be[7], b43 = be[11], b44 = be[15];

  te[0] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
  te[4] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
  te[8] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
  te[12] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;

  te[1] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
  te[5] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
  te[9] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
  te[13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;

  te[2] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
  te[6] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
  te[10] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
  te[14] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;

  te[3] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;
  te[7] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;
  te[11] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;
  te[15] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;

  return m;
}

static Matrix4 *matrix4_compose(Matrix4 *m, const Vector3 *position, const Quaternion *quaternion,
                                const Vector3 *scale) {
  double *te = m->elements;

  double x = quaternion->x, y = quaternion->y, z = quaternion->z, w = quaternion->w;
  double x2 = x + x, y2 = y + y, z2 = z + z;
  double xx = x * x2, xy = x * y2, xz = x * z2;
  double yy = y * y2, yz = y * z2, zz = z * z2;
  double wx = w * x2, wy = w * y2, wz = w * z2;

  double sx = scale->x, sy = scale->y, sz = scale->z;

  te[0] = (1 - (yy + zz)) * sx;
  te[1] = (xy + wz) * sx;
  te[2] = (xz - wy) * sx;
  te[3] = 0;

  te[4] = (xy - wz) * sy;
  te[5] = (1 - (xx + zz)) * sy;
  te[6] = (yz + wx) * sy;
  te[7] = 0;

  te[8] = (xz + wy) * sz;
  te[9] = (yz - wx) * sz;
  te[10] = (1 - (xx + yy)) * sz;
  te[11] = 0;

  te[12] = position->x;
  te[13] = position->y;
  te[14] = position->z;
  te[15] = 1;

  return m;
}

static uint32_t seed = 1;
static double rnd(void) {
  seed = seed * 1664525u + 1013904223u;
  return (double)seed / 4294967296.0;
}

static void run(double *out, Vector3 *pos, const Quaternion *quat, const Vector3 *scl,
                Matrix4 *local, Matrix4 *world, const Matrix4 *root) {
  double sum = 0;
  for (int f = 0; f < FRAMES; f++) {
    for (int i = 0; i < N; i++) {
      pos[i].x += 0.01;
      matrix4_compose(&local[i], &pos[i], &quat[i], &scl[i]);
      const Matrix4 *parent = (i & 7) == 0 ? root : &world[i - 1];
      matrix4_multiply_matrices(&world[i], parent, &local[i]);
    }
    sum += world[N - 1].elements[12];
  }
  const double *m = world[N - 1].elements;
  for (int k = 0; k < 16; k++) out[k] = m[k];
  out[16] = sum;
}

int main(void) {
  Vector3 *pos = malloc(N * sizeof(Vector3));
  Quaternion *quat = malloc(N * sizeof(Quaternion));
  Vector3 *scl = malloc(N * sizeof(Vector3));
  Matrix4 *local = malloc(N * sizeof(Matrix4));
  Matrix4 *world = malloc(N * sizeof(Matrix4));
  Euler e = euler_new(0, 0, 0);
  for (int i = 0; i < N; i++) {
    // JS evaluates constructor and set() arguments left to right; C leaves
    // argument order unspecified, so each draw is its own statement.
    double x = rnd() * 100 - 50;
    double y = rnd() * 100 - 50;
    double z = rnd() * 100 - 50;
    pos[i] = vector3_new(x, y, z);
    x = rnd() * 6;
    y = rnd() * 6;
    z = rnd() * 6;
    quat[i] = quaternion_new();
    quaternion_set_from_euler(&quat[i], euler_set(&e, x, y, z));
    x = 1 + rnd();
    y = 1 + rnd();
    z = 1 + rnd();
    scl[i] = vector3_new(x, y, z);
    local[i] = matrix4_new();
    world[i] = matrix4_new();
  }
  Matrix4 root = matrix4_new();
  matrix4_make_rotation_y(&root, 0.3);

  double out[17];
  for (int i = 0; i < N_WARMUP; i++) run(out, pos, quat, scl, local, world, &root);

  double samples[N_RUNS];
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    run(out, pos, quat, scl, local, world, &root);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), checksum_f64_near(out, 17), N * FRAMES, 2, N_RUNS);
  free(pos);
  free(quat);
  free(scl);
  free(local);
  free(world);
  return 0;
}
