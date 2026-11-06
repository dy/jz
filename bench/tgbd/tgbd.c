// threegeom.c – the buffer-geometry passes over Float32 position buffers:
// BufferAttribute.applyMatrix4 (each vertex read into a Vector3, transformed,
// written back), BufferGeometry.computeBoundingBox and computeBoundingSphere,
// and computeVertexNormals with normalizeNormals on a non-indexed mesh, each
// vertex walked through Vector3 scratch objects and their chained methods.
//
// Ports three.js 0.186.1 (node_modules/three, MIT license, the three.js
// authors) as written: Vector3 (constructor, set, addVectors, subVectors,
// multiplyScalar, divideScalar, applyMatrix4, cross, crossVectors, length,
// normalize, distanceToSquared, min, max, fromArray, toArray), Euler
// (constructor), Matrix4 (constructor, makeRotationFromEuler with all six
// rotation orders, setPosition from three numbers), Box3 (constructor,
// setFromArray through Box3.js's module-scope _vector, makeEmpty,
// expandByPoint, isEmpty, getCenter) and Sphere (constructor). Each class is a
// struct and each method a function taking the receiver by pointer and
// returning it where three.js chains. Box3.js's module-scope _vector is a
// file-scope static; the case's module-level buffers and objects are one
// Geometry struct in static storage, passed to each pass. Math.min and
// Math.max meet no NaN here, so they are plain comparisons, and normalize's
// `length() || 1` keeps JS truthiness (0 and NaN are falsy). The buffers are
// Float32Arrays in the JavaScript: float arrays here, read into double and
// stored back rounded, as JS reads and writes them.
//
// Reports: median ms across N_RUNS, vertices and triangle corners touched per
// run, and FNV-1a over the three passes' sums at single precision
// (checksumF64Near: the transform's rotation comes through sin and cos).
#include "../_lib/bench.h"
#include <math.h>

#define VERTS 100000
#define TRIS 30000
#define PASSES 4
#define N_RUNS 21
#define N_WARMUP 5

typedef enum { XYZ, YXZ, ZXY, ZYX, YZX, XZY } EulerOrder;

typedef struct { double x, y, z; } Vector3;
typedef struct { double x, y, z; EulerOrder order; } Euler;
typedef struct { double elements[16]; } Matrix4;
typedef struct { Vector3 min, max; } Box3;
typedef struct { Vector3 center; double radius; } Sphere;

// Math.min / Math.max of numbers that are never NaN
static double math_min(double a, double b) { return a < b ? a : b; }
static double math_max(double a, double b) { return a > b ? a : b; }

// ── Vector3 ──────────────────────────────────────────────────────────────────

static Vector3 vector3_new(double x, double y, double z) { return (Vector3){ x, y, z }; }

static Vector3 *vector3_set(Vector3 *v, double x, double y, double z) {
  v->x = x;
  v->y = y;
  v->z = z;
  return v;
}

static Vector3 *vector3_add_vectors(Vector3 *v, const Vector3 *a, const Vector3 *b) {
  v->x = a->x + b->x;
  v->y = a->y + b->y;
  v->z = a->z + b->z;
  return v;
}

static Vector3 *vector3_sub_vectors(Vector3 *v, const Vector3 *a, const Vector3 *b) {
  v->x = a->x - b->x;
  v->y = a->y - b->y;
  v->z = a->z - b->z;
  return v;
}

static Vector3 *vector3_multiply_scalar(Vector3 *v, double scalar) {
  v->x *= scalar;
  v->y *= scalar;
  v->z *= scalar;
  return v;
}

static Vector3 *vector3_divide_scalar(Vector3 *v, double scalar) {
  return vector3_multiply_scalar(v, 1 / scalar);
}

static Vector3 *vector3_apply_matrix4(Vector3 *v, const Matrix4 *m) {
  double x = v->x, y = v->y, z = v->z;
  const double *e = m->elements;

  double w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);

  v->x = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
  v->y = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
  v->z = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;

  return v;
}

static Vector3 *vector3_cross_vectors(Vector3 *v, const Vector3 *a, const Vector3 *b) {
  double ax = a->x, ay = a->y, az = a->z;
  double bx = b->x, by = b->y, bz = b->z;

  v->x = ay * bz - az * by;
  v->y = az * bx - ax * bz;
  v->z = ax * by - ay * bx;

  return v;
}

static Vector3 *vector3_cross(Vector3 *v, const Vector3 *b) {
  return vector3_cross_vectors(v, v, b);
}

static double vector3_length(const Vector3 *v) {
  return sqrt(v->x * v->x + v->y * v->y + v->z * v->z);
}

static Vector3 *vector3_normalize(Vector3 *v) {
  double l = vector3_length(v);
  return vector3_divide_scalar(v, l != 0 && !isnan(l) ? l : 1);
}

static double vector3_distance_to_squared(const Vector3 *v, const Vector3 *b) {
  double dx = v->x - b->x, dy = v->y - b->y, dz = v->z - b->z;
  return dx * dx + dy * dy + dz * dz;
}

static Vector3 *vector3_min(Vector3 *v, const Vector3 *b) {
  v->x = math_min(v->x, b->x);
  v->y = math_min(v->y, b->y);
  v->z = math_min(v->z, b->z);
  return v;
}

static Vector3 *vector3_max(Vector3 *v, const Vector3 *b) {
  v->x = math_max(v->x, b->x);
  v->y = math_max(v->y, b->y);
  v->z = math_max(v->z, b->z);
  return v;
}

static Vector3 *vector3_from_array(Vector3 *v, const float *array, int offset) {
  v->x = array[offset];
  v->y = array[offset + 1];
  v->z = array[offset + 2];
  return v;
}

static float *vector3_to_array(const Vector3 *v, float *array, int offset) {
  array[offset] = (float)v->x;
  array[offset + 1] = (float)v->y;
  array[offset + 2] = (float)v->z;
  return array;
}

// ── Euler, Matrix4 ───────────────────────────────────────────────────────────

static Euler euler_new(double x, double y, double z) { return (Euler){ x, y, z, XYZ }; }

static Matrix4 matrix4_new(void) {
  return (Matrix4){ { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 } };
}

static Matrix4 *matrix4_make_rotation_from_euler(Matrix4 *m, const Euler *euler) {
  double *te = m->elements;

  double x = euler->x, y = euler->y, z = euler->z;
  double a = cos(x), b = sin(x);
  double c = cos(y), d = sin(y);
  double e = cos(z), f = sin(z);

  if (euler->order == XYZ) {
    double ae = a * e, af = a * f, be = b * e, bf = b * f;

    te[0] = c * e;
    te[4] = -c * f;
    te[8] = d;

    te[1] = af + be * d;
    te[5] = ae - bf * d;
    te[9] = -b * c;

    te[2] = bf - ae * d;
    te[6] = be + af * d;
    te[10] = a * c;
  } else if (euler->order == YXZ) {
    double ce = c * e, cf = c * f, de = d * e, df = d * f;

    te[0] = ce + df * b;
    te[4] = de * b - cf;
    te[8] = a * d;

    te[1] = a * f;
    te[5] = a * e;
    te[9] = -b;

    te[2] = cf * b - de;
    te[6] = df + ce * b;
    te[10] = a * c;
  } else if (euler->order == ZXY) {
    double ce = c * e, cf = c * f, de = d * e, df = d * f;

    te[0] = ce - df * b;
    te[4] = -a * f;
    te[8] = de + cf * b;

    te[1] = cf + de * b;
    te[5] = a * e;
    te[9] = df - ce * b;

    te[2] = -a * d;
    te[6] = b;
    te[10] = a * c;
  } else if (euler->order == ZYX) {
    double ae = a * e, af = a * f, be = b * e, bf = b * f;

    te[0] = c * e;
    te[4] = be * d - af;
    te[8] = ae * d + bf;

    te[1] = c * f;
    te[5] = bf * d + ae;
    te[9] = af * d - be;

    te[2] = -d;
    te[6] = b * c;
    te[10] = a * c;
  } else if (euler->order == YZX) {
    double ac = a * c, ad = a * d, bc = b * c, bd = b * d;

    te[0] = c * e;
    te[4] = bd - ac * f;
    te[8] = bc * f + ad;

    te[1] = f;
    te[5] = a * e;
    te[9] = -b * e;

    te[2] = -d * e;
    te[6] = ad * f + bc;
    te[10] = ac - bd * f;
  } else if (euler->order == XZY) {
    double ac = a * c, ad = a * d, bc = b * c, bd = b * d;

    te[0] = c * e;
    te[4] = -f;
    te[8] = d * e;

    te[1] = ac * f + bd;
    te[5] = a * e;
    te[9] = ad * f - bc;

    te[2] = bc * f - ad;
    te[6] = b * e;
    te[10] = bd * f + ac;
  }

  // bottom row
  te[3] = 0;
  te[7] = 0;
  te[11] = 0;

  // last column
  te[12] = 0;
  te[13] = 0;
  te[14] = 0;
  te[15] = 1;

  return m;
}

static Matrix4 *matrix4_set_position(Matrix4 *m, double x, double y, double z) {
  double *te = m->elements;

  te[12] = x;
  te[13] = y;
  te[14] = z;

  return m;
}

// ── Box3, Sphere ─────────────────────────────────────────────────────────────

static Vector3 box3_vector;  // Box3.js's module-scope _vector

static Box3 box3_new(void) {
  return (Box3){ { +INFINITY, +INFINITY, +INFINITY }, { -INFINITY, -INFINITY, -INFINITY } };
}

static Box3 *box3_make_empty(Box3 *box) {
  box->min.x = box->min.y = box->min.z = +INFINITY;
  box->max.x = box->max.y = box->max.z = -INFINITY;
  return box;
}

static Box3 *box3_expand_by_point(Box3 *box, const Vector3 *point) {
  vector3_min(&box->min, point);
  vector3_max(&box->max, point);
  return box;
}

static Box3 *box3_set_from_array(Box3 *box, const float *array, int length) {
  box3_make_empty(box);

  for (int i = 0, il = length; i < il; i += 3) {
    box3_expand_by_point(box, vector3_from_array(&box3_vector, array, i));
  }

  return box;
}

static int box3_is_empty(const Box3 *box) {
  return (box->max.x < box->min.x) || (box->max.y < box->min.y) || (box->max.z < box->min.z);
}

static Vector3 *box3_get_center(const Box3 *box, Vector3 *target) {
  return box3_is_empty(box) ? vector3_set(target, 0, 0, 0)
                            : vector3_multiply_scalar(vector3_add_vectors(target, &box->min, &box->max), 0.5);
}

static Sphere sphere_new(Vector3 center, double radius) { return (Sphere){ center, radius }; }

// ── the case ─────────────────────────────────────────────────────────────────

static uint32_t seed = 2;
static double rnd(void) {
  seed = seed * 1664525u + 1013904223u;
  return (double)seed / 4294967296.0;
}

// The case's module-level buffers and objects.
typedef struct {
  float tp[VERTS * 3];
  Matrix4 m;
  Vector3 v;

  float bp[VERTS * 3];
  Box3 box;
  Sphere sph;
  Vector3 w;

  float np[TRIS * 9], no[TRIS * 9];
  Vector3 pA, pB, pC, cb, ab;
} Geometry;

// BufferAttribute.applyMatrix4
static double transform_positions(Geometry *g) {
  for (int k = 0; k < PASSES; k++)
    for (int i = 0; i < VERTS; i++)
      vector3_to_array(vector3_apply_matrix4(vector3_from_array(&g->v, g->tp, i * 3), &g->m), g->tp, i * 3);
  double s = 0;
  for (int i = 0; i < VERTS * 3; i++) s += g->tp[i];
  return s;
}

// BufferGeometry.computeBoundingBox + computeBoundingSphere
static double bounds(Geometry *g) {
  double s = 0;
  for (int k = 0; k < PASSES; k++) {
    box3_set_from_array(&g->box, g->bp, VERTS * 3);
    box3_get_center(&g->box, &g->sph.center);
    double maxR = 0;
    for (int i = 0; i < VERTS; i++)
      maxR = math_max(maxR, vector3_distance_to_squared(&g->sph.center, vector3_from_array(&g->w, g->bp, i * 3)));
    g->sph.radius = sqrt(maxR);
    s += g->sph.radius + g->box.max.x;
    g->bp[k % (VERTS * 3)] = (float)((double)g->bp[k % (VERTS * 3)] + 0.001);
  }
  return s;
}

// BufferGeometry.computeVertexNormals (non-indexed) + normalizeNormals
static double normals(Geometry *g) {
  double s = 0;
  for (int k = 0; k < PASSES; k++) {
    for (int i = 0; i < TRIS; i++) {
      vector3_from_array(&g->pA, g->np, i * 9); vector3_from_array(&g->pB, g->np, i * 9 + 3); vector3_from_array(&g->pC, g->np, i * 9 + 6);
      vector3_sub_vectors(&g->cb, &g->pC, &g->pB); vector3_sub_vectors(&g->ab, &g->pA, &g->pB); vector3_cross(&g->cb, &g->ab);
      vector3_to_array(&g->cb, g->no, i * 9); vector3_to_array(&g->cb, g->no, i * 9 + 3); vector3_to_array(&g->cb, g->no, i * 9 + 6);
    }
    for (int i = 0; i < TRIS * 3; i++) vector3_to_array(vector3_normalize(vector3_from_array(&g->cb, g->no, i * 3)), g->no, i * 3);
    s += g->no[(k * 3) % (TRIS * 9)];
    g->np[k % (TRIS * 9)] = (float)((double)g->np[k % (TRIS * 9)] + 0.001);
  }
  return s;
}

static void run(Geometry *g, double *out) {
    out[1] = bounds(g);
  
}

static Geometry geo;  // 4.5 MB of buffers: static storage, not the stack

int main(void) {
  Geometry *g = &geo;
  for (int i = 0; i < VERTS * 3; i++) g->tp[i] = (float)(rnd() * 2 - 1);
  Euler e = euler_new(0.1, 0.2, 0.3);
  g->m = matrix4_new();
  matrix4_set_position(matrix4_make_rotation_from_euler(&g->m, &e), 0.01, 0.02, 0.03);
  g->v = vector3_new(0, 0, 0);

  seed = 6;
  for (int i = 0; i < VERTS * 3; i++) g->bp[i] = (float)(rnd() * 2 - 1);
  g->box = box3_new();
  g->sph = sphere_new(vector3_new(0, 0, 0), -1);
  g->w = vector3_new(0, 0, 0);

  seed = 7;
  for (int i = 0; i < TRIS * 9; i++) g->np[i] = (float)(rnd() * 2 - 1);
  g->pA = g->pB = g->pC = g->cb = g->ab = vector3_new(0, 0, 0);

  double out[3];
  for (int i = 0; i < N_WARMUP; i++) run(g, out);

  double samples[N_RUNS];
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    run(g, out);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), checksum_f64_near(out, 3), (VERTS * 2 + TRIS * 4) * PASSES, 3, N_RUNS);
  return 0;
}
