// threecull.c – the visibility queries of a frame: WebGLRenderer.projectObject's
// frustum test of ten thousand bounding spheres as a camera orbits (lookAt,
// setPosition, invert, the view-projection product and the frustum's planes),
// then Mesh.raycast's ray against twenty thousand triangles of a Float32
// position buffer, the culling and picking kernel.
//
// Ports three.js 0.186.1 (node_modules/three, MIT license, the three.js
// authors) as written: Vector3 (constructor, set, copy, addScaledVector,
// subVectors, multiplyScalar, divideScalar, crossVectors, dot, length,
// lengthSq, normalize, fromArray), Matrix4 (constructor, set, makePerspective
// with its coordinate-system and reversed-depth branches, lookAt with its
// degenerate-axis fallbacks through Matrix4.js's module-scope _x, _y, _z,
// setPosition from a Vector3, invert, multiplyMatrices), Plane (constructor,
// setComponents, normalize, distanceToPoint), Frustum (constructor,
// setFromProjectionMatrix with its coordinate-system and reversed-depth
// branches, intersectsSphere), Sphere (constructor) and Ray (constructor, at,
// the watertight intersectTriangle). Each class is a struct and each method a
// function taking the receiver by pointer and returning it where three.js
// chains; intersectTriangle returns NULL or its target, as three.js returns
// null or the target. Matrix4.js's module-scope scratch vectors are
// file-scope statics; the case's module-level objects and buffer are one
// Scene struct in static storage, its spheres an array of structs. The
// coordinate system is an enum of three.js's two constants, so
// makePerspective's and setFromProjectionMatrix's throw on any other value
// cannot arise and is left out. normalize's `length() || 1` keeps JS
// truthiness (0 and NaN are falsy). The triangle buffer is a Float32Array in
// the JavaScript: a float array here, read into double.
//
// Reports: median ms across N_RUNS, sphere tests and triangle tests per run,
// and FNV-1a over the visible count, the hit count and the sum of the hits'
// z at single precision (checksumF64Near: the orbit comes through sin and cos).
#include "../_lib/bench.h"
#include <math.h>
#include <stdbool.h>
#include <stddef.h>

#define SPHERES 10000
#define ORBIT 40
#define TRIANGLES 20000
#define RAYS 10
#define N_RUNS 21
#define N_WARMUP 5

typedef enum { WebGLCoordinateSystem = 2000, WebGPUCoordinateSystem = 2001 } CoordinateSystem;

typedef struct { double x, y, z; } Vector3;
typedef struct { double elements[16]; } Matrix4;
typedef struct { Vector3 normal; double constant; } Plane;
typedef struct { Plane planes[6]; } Frustum;
typedef struct { Vector3 center; double radius; } Sphere;
typedef struct { Vector3 origin, direction; } Ray;

// ── Vector3 ──────────────────────────────────────────────────────────────────

static Vector3 vector3_new(double x, double y, double z) { return (Vector3){ x, y, z }; }

static Vector3 *vector3_set(Vector3 *v, double x, double y, double z) {
  v->x = x;
  v->y = y;
  v->z = z;
  return v;
}

static Vector3 *vector3_copy(Vector3 *v, const Vector3 *b) {
  v->x = b->x;
  v->y = b->y;
  v->z = b->z;
  return v;
}

static Vector3 *vector3_add_scaled_vector(Vector3 *v, const Vector3 *b, double s) {
  v->x += b->x * s;
  v->y += b->y * s;
  v->z += b->z * s;
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

static Vector3 *vector3_cross_vectors(Vector3 *v, const Vector3 *a, const Vector3 *b) {
  double ax = a->x, ay = a->y, az = a->z;
  double bx = b->x, by = b->y, bz = b->z;

  v->x = ay * bz - az * by;
  v->y = az * bx - ax * bz;
  v->z = ax * by - ay * bx;

  return v;
}

static double vector3_dot(const Vector3 *v, const Vector3 *b) {
  return v->x * b->x + v->y * b->y + v->z * b->z;
}

static double vector3_length_sq(const Vector3 *v) {
  return v->x * v->x + v->y * v->y + v->z * v->z;
}

static double vector3_length(const Vector3 *v) {
  return sqrt(v->x * v->x + v->y * v->y + v->z * v->z);
}

static Vector3 *vector3_normalize(Vector3 *v) {
  double l = vector3_length(v);
  return vector3_divide_scalar(v, l != 0 && !isnan(l) ? l : 1);
}

static Vector3 *vector3_from_array(Vector3 *v, const float *array, int offset) {
  v->x = array[offset];
  v->y = array[offset + 1];
  v->z = array[offset + 2];
  return v;
}

// ── Matrix4 ──────────────────────────────────────────────────────────────────

static Vector3 matrix4_x, matrix4_y, matrix4_z;  // Matrix4.js's module-scope _x, _y, _z

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

static Matrix4 *matrix4_make_perspective(Matrix4 *m, double left, double right, double top, double bottom,
                                         double near, double far, CoordinateSystem coordinateSystem,
                                         bool reversedDepth) {
  double *te = m->elements;

  double x = 2 * near / (right - left);
  double y = 2 * near / (top - bottom);

  double a = (right + left) / (right - left);
  double b = (top + bottom) / (top - bottom);

  double c, d;

  if (reversedDepth) {
    c = near / (far - near);
    d = (far * near) / (far - near);
  } else if (coordinateSystem == WebGLCoordinateSystem) {
    c = -(far + near) / (far - near);
    d = (-2 * far * near) / (far - near);
  } else {  // WebGPUCoordinateSystem
    c = -far / (far - near);
    d = (-far * near) / (far - near);
  }

  te[0] = x; te[4] = 0; te[8] = a;   te[12] = 0;
  te[1] = 0; te[5] = y; te[9] = b;   te[13] = 0;
  te[2] = 0; te[6] = 0; te[10] = c;  te[14] = d;
  te[3] = 0; te[7] = 0; te[11] = -1; te[15] = 0;

  return m;
}

static Matrix4 *matrix4_look_at(Matrix4 *m, const Vector3 *eye, const Vector3 *target, const Vector3 *up) {
  double *te = m->elements;

  vector3_sub_vectors(&matrix4_z, eye, target);

  if (vector3_length_sq(&matrix4_z) == 0) {
    // eye and target are in the same position
    matrix4_z.z = 1;
  }

  vector3_normalize(&matrix4_z);
  vector3_cross_vectors(&matrix4_x, up, &matrix4_z);

  if (vector3_length_sq(&matrix4_x) == 0) {
    // up and z are parallel
    if (fabs(up->z) == 1) {
      matrix4_z.x += 0.0001;
    } else {
      matrix4_z.z += 0.0001;
    }

    vector3_normalize(&matrix4_z);
    vector3_cross_vectors(&matrix4_x, up, &matrix4_z);
  }

  vector3_normalize(&matrix4_x);
  vector3_cross_vectors(&matrix4_y, &matrix4_z, &matrix4_x);

  te[0] = matrix4_x.x; te[4] = matrix4_y.x; te[8] = matrix4_z.x;
  te[1] = matrix4_x.y; te[5] = matrix4_y.y; te[9] = matrix4_z.y;
  te[2] = matrix4_x.z; te[6] = matrix4_y.z; te[10] = matrix4_z.z;

  return m;
}

static Matrix4 *matrix4_set_position(Matrix4 *m, const Vector3 *x) {
  double *te = m->elements;

  te[12] = x->x;
  te[13] = x->y;
  te[14] = x->z;

  return m;
}

static Matrix4 *matrix4_invert(Matrix4 *m) {
  // based on https://github.com/toji/gl-matrix
  double *te = m->elements;

  double n11 = te[0], n21 = te[1], n31 = te[2], n41 = te[3],
         n12 = te[4], n22 = te[5], n32 = te[6], n42 = te[7],
         n13 = te[8], n23 = te[9], n33 = te[10], n43 = te[11],
         n14 = te[12], n24 = te[13], n34 = te[14], n44 = te[15],

         t1 = n11 * n22 - n21 * n12,
         t2 = n11 * n32 - n31 * n12,
         t3 = n11 * n42 - n41 * n12,
         t4 = n21 * n32 - n31 * n22,
         t5 = n21 * n42 - n41 * n22,
         t6 = n31 * n42 - n41 * n32,
         t7 = n13 * n24 - n23 * n14,
         t8 = n13 * n34 - n33 * n14,
         t9 = n13 * n44 - n43 * n14,
         t10 = n23 * n34 - n33 * n24,
         t11 = n23 * n44 - n43 * n24,
         t12 = n33 * n44 - n43 * n34;

  double det = t1 * t12 - t2 * t11 + t3 * t10 + t4 * t9 - t5 * t8 + t6 * t7;

  if (det == 0) return matrix4_set(m, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

  double detInv = 1 / det;

  te[0] = (n22 * t12 - n32 * t11 + n42 * t10) * detInv;
  te[1] = (n31 * t11 - n21 * t12 - n41 * t10) * detInv;
  te[2] = (n24 * t6 - n34 * t5 + n44 * t4) * detInv;
  te[3] = (n33 * t5 - n23 * t6 - n43 * t4) * detInv;

  te[4] = (n32 * t9 - n12 * t12 - n42 * t8) * detInv;
  te[5] = (n11 * t12 - n31 * t9 + n41 * t8) * detInv;
  te[6] = (n34 * t3 - n14 * t6 - n44 * t2) * detInv;
  te[7] = (n13 * t6 - n33 * t3 + n43 * t2) * detInv;

  te[8] = (n12 * t11 - n22 * t9 + n42 * t7) * detInv;
  te[9] = (n21 * t9 - n11 * t11 - n41 * t7) * detInv;
  te[10] = (n14 * t5 - n24 * t3 + n44 * t1) * detInv;
  te[11] = (n23 * t3 - n13 * t5 - n43 * t1) * detInv;

  te[12] = (n22 * t8 - n12 * t10 - n32 * t7) * detInv;
  te[13] = (n11 * t10 - n21 * t8 + n31 * t7) * detInv;
  te[14] = (n24 * t2 - n14 * t4 - n34 * t1) * detInv;
  te[15] = (n13 * t4 - n23 * t2 + n33 * t1) * detInv;

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

// ── Plane, Frustum, Sphere, Ray ──────────────────────────────────────────────

static Plane plane_new(void) { return (Plane){ { 1, 0, 0 }, 0 }; }

static Plane *plane_set_components(Plane *p, double x, double y, double z, double w) {
  vector3_set(&p->normal, x, y, z);
  p->constant = w;
  return p;
}

static Plane *plane_normalize(Plane *p) {
  // Note: will lead to a divide by zero if the plane is invalid.
  double inverseNormalLength = 1.0 / vector3_length(&p->normal);
  vector3_multiply_scalar(&p->normal, inverseNormalLength);
  p->constant *= inverseNormalLength;
  return p;
}

static double plane_distance_to_point(const Plane *p, const Vector3 *point) {
  return vector3_dot(&p->normal, point) + p->constant;
}

static Frustum frustum_new(void) {
  return (Frustum){ { plane_new(), plane_new(), plane_new(), plane_new(), plane_new(), plane_new() } };
}

static Frustum *frustum_set_from_projection_matrix(Frustum *fr, const Matrix4 *m, CoordinateSystem coordinateSystem,
                                                   bool reversedDepth) {
  Plane *planes = fr->planes;
  const double *me = m->elements;
  double me0 = me[0], me1 = me[1], me2 = me[2], me3 = me[3];
  double me4 = me[4], me5 = me[5], me6 = me[6], me7 = me[7];
  double me8 = me[8], me9 = me[9], me10 = me[10], me11 = me[11];
  double me12 = me[12], me13 = me[13], me14 = me[14], me15 = me[15];

  plane_normalize(plane_set_components(&planes[0], me3 - me0, me7 - me4, me11 - me8, me15 - me12));
  plane_normalize(plane_set_components(&planes[1], me3 + me0, me7 + me4, me11 + me8, me15 + me12));
  plane_normalize(plane_set_components(&planes[2], me3 + me1, me7 + me5, me11 + me9, me15 + me13));
  plane_normalize(plane_set_components(&planes[3], me3 - me1, me7 - me5, me11 - me9, me15 - me13));

  if (reversedDepth) {
    plane_normalize(plane_set_components(&planes[4], me2, me6, me10, me14));  // far
    plane_normalize(plane_set_components(&planes[5], me3 - me2, me7 - me6, me11 - me10, me15 - me14));  // near
  } else {
    plane_normalize(plane_set_components(&planes[4], me3 - me2, me7 - me6, me11 - me10, me15 - me14));  // far

    if (coordinateSystem == WebGLCoordinateSystem) {
      plane_normalize(plane_set_components(&planes[5], me3 + me2, me7 + me6, me11 + me10, me15 + me14));  // near
    } else {  // WebGPUCoordinateSystem
      plane_normalize(plane_set_components(&planes[5], me2, me6, me10, me14));  // near
    }
  }

  return fr;
}

static bool frustum_intersects_sphere(const Frustum *fr, const Sphere *sphere) {
  const Plane *planes = fr->planes;
  const Vector3 *center = &sphere->center;
  double negRadius = -sphere->radius;

  for (int i = 0; i < 6; i++) {
    double distance = plane_distance_to_point(&planes[i], center);

    if (distance < negRadius) {
      return false;
    }
  }

  return true;
}

static Sphere sphere_new(Vector3 center, double radius) { return (Sphere){ center, radius }; }

static Ray ray_new(void) { return (Ray){ { 0, 0, 0 }, { 0, 0, -1 } }; }

static Vector3 *ray_at(const Ray *ray, double t, Vector3 *target) {
  return vector3_add_scaled_vector(vector3_copy(target, &ray->origin), &ray->direction, t);
}

static Vector3 *ray_intersect_triangle(const Ray *ray, const Vector3 *a, const Vector3 *b, const Vector3 *c,
                                       bool backfaceCulling, Vector3 *target) {
  // Watertight ray/triangle intersection. Reference: Woop, Benthin, Wald,
  // "Watertight Ray/Triangle Intersection", JCGT vol. 2 no. 1 (2013), Appendix A.
  // https://jcgt.org/published/0002/01/05/

  const Vector3 *origin = &ray->origin;
  const Vector3 *direction = &ray->direction;

  double dx = direction->x;
  double dy = direction->y;
  double dz = direction->z;

  // triangle vertices relative to the ray origin

  double aox = a->x - origin->x, aoy = a->y - origin->y, aoz = a->z - origin->z;
  double box = b->x - origin->x, boy = b->y - origin->y, boz = b->z - origin->z;
  double cox = c->x - origin->x, coy = c->y - origin->y, coz = c->z - origin->z;

  // Use the dimension where the ray direction is maximal as the projection
  // axis (kz) and read every component already permuted into (kx, ky, kz).
  // kx and ky are swapped when the direction's kz component is negative, to
  // preserve the winding order of triangles.

  double adx = fabs(dx), ady = fabs(dy), adz = fabs(dz);

  double dkx, dky, dkz;
  double akx, aky, akz, bkx, bky, bkz, ckx, cky, ckz;

  if (adx >= ady && adx >= adz) {
    dkz = dx; akz = aox; bkz = box; ckz = cox;

    if (dx >= 0) {
      dkx = dy; dky = dz;
      akx = aoy; aky = aoz; bkx = boy; bky = boz; ckx = coy; cky = coz;
    } else {
      dkx = dz; dky = dy;
      akx = aoz; aky = aoy; bkx = boz; bky = boy; ckx = coz; cky = coy;
    }
  } else if (ady >= adz) {
    dkz = dy; akz = aoy; bkz = boy; ckz = coy;

    if (dy >= 0) {
      dkx = dz; dky = dx;
      akx = aoz; aky = aox; bkx = boz; bky = box; ckx = coz; cky = cox;
    } else {
      dkx = dx; dky = dz;
      akx = aox; aky = aoz; bkx = box; bky = boz; ckx = cox; cky = coz;
    }
  } else {
    dkz = dz; akz = aoz; bkz = boz; ckz = coz;

    if (dz >= 0) {
      dkx = dx; dky = dy;
      akx = aox; aky = aoy; bkx = box; bky = boy; ckx = cox; cky = coy;
    } else {
      dkx = dy; dky = dx;
      akx = aoy; aky = aox; bkx = boy; bky = box; ckx = coy; cky = cox;
    }
  }

  // a zero direction has no maximal axis and cannot intersect

  if (dkz == 0) return NULL;

  // shear constants that align the ray with the +kz axis

  double sx = dkx / dkz, sy = dky / dkz, sz = 1 / dkz;

  // sheared and scaled vertices

  double ax = akx - sx * akz, ay = aky - sy * akz;
  double bx = bkx - sx * bkz, by = bky - sy * bkz;
  double cx = ckx - sx * ckz, cy = cky - sy * ckz;

  // scaled barycentric coordinates (signed edge functions); the shear makes a
  // shared edge evaluate identically for both adjacent triangles, so the ray
  // can never fall between them

  double u = cx * by - cy * bx;
  double v = ax * cy - ay * cx;
  double w = bx * ay - by * ax;

  if (backfaceCulling) {
    if (u < 0 || v < 0 || w < 0) return NULL;
  } else {
    if ((u < 0 || v < 0 || w < 0) && (u > 0 || v > 0 || w > 0)) return NULL;
  }

  double det = u + v + w;

  // ray is co-planar with the triangle

  if (det == 0) return NULL;

  // scaled hit distance; t = tScaled / det must lie in front of the origin

  double tScaled = sz * (u * akz + v * bkz + w * ckz);

  if (det > 0 ? tScaled < 0 : tScaled > 0) return NULL;

  return ray_at(ray, tScaled / det, target);
}

// ── the case ─────────────────────────────────────────────────────────────────

static uint32_t seed = 3;
static double rnd(void) {
  seed = seed * 1664525u + 1013904223u;
  return (double)seed / 4294967296.0;
}

// The case's module-level objects and buffer.
typedef struct {
  Sphere spheres[SPHERES];
  Matrix4 proj, view, pv;
  Frustum fr;
  Vector3 eye, target, up;

  float p[TRIANGLES * 9];
  Ray ray;
  Vector3 a, b, c, hit;
} Scene;

// WebGLRenderer.projectObject
static int cull(Scene *s) {
  int visible = 0;
  for (int k = 0; k < ORBIT; k++) {
    vector3_set(&s->eye, sin(k * 0.01) * 50, 10, cos(k * 0.01) * 50);
    matrix4_invert(matrix4_set_position(matrix4_look_at(&s->view, &s->eye, &s->target, &s->up), &s->eye));
    matrix4_multiply_matrices(&s->pv, &s->proj, &s->view);
    frustum_set_from_projection_matrix(&s->fr, &s->pv, WebGLCoordinateSystem, false);
    for (int i = 0; i < SPHERES; i++) if (frustum_intersects_sphere(&s->fr, &s->spheres[i])) visible++;
  }
  return visible;
}

// Mesh.raycast
static void raycast(Scene *s, double *out) {
  seed = 5;
  int hits = 0;
  double acc = 0;
  for (int k = 0; k < RAYS; k++) {
    vector3_set(&s->ray.origin, 0, 0, -30);
    double dx = rnd() - 0.5;
    double dy = rnd() - 0.5;
    vector3_normalize(vector3_set(&s->ray.direction, dx, dy, 1));
    for (int i = 0; i < TRIANGLES; i++) {
      vector3_from_array(&s->a, s->p, i * 9); vector3_from_array(&s->b, s->p, i * 9 + 3); vector3_from_array(&s->c, s->p, i * 9 + 6);
      if (ray_intersect_triangle(&s->ray, &s->a, &s->b, &s->c, false, &s->hit) != NULL) { hits++; acc += s->hit.z; }
    }
  }
  out[1] = hits;
  out[2] = acc;
}

static void run(Scene *s, double *out) {
  out[0] = cull(s);
}

static Scene scene;  // 1 MB of spheres and triangles: static storage, not the stack

int main(void) {
  Scene *s = &scene;
  for (int i = 0; i < SPHERES; i++) {
    // JS evaluates constructor arguments left to right; C leaves argument
    // order unspecified, so each draw is its own statement.
    double x = rnd() * 200 - 100;
    double y = rnd() * 200 - 100;
    double z = rnd() * 200 - 100;
    double r = rnd() * 5;
    s->spheres[i] = sphere_new(vector3_new(x, y, z), r);
  }
  s->proj = matrix4_new();
  matrix4_make_perspective(&s->proj, -1, 1, 1, -1, 1, 100, WebGLCoordinateSystem, false);
  s->view = matrix4_new();
  s->pv = matrix4_new();
  s->fr = frustum_new();
  s->eye = vector3_new(0, 0, 0);
  s->target = vector3_new(0, 0, 0);
  s->up = vector3_new(0, 1, 0);

  seed = 4;
  for (int i = 0; i < TRIANGLES * 9; i++) s->p[i] = (float)(rnd() * 20 - 10);
  s->ray = ray_new();
  s->a = s->b = s->c = s->hit = vector3_new(0, 0, 0);

  double out[3];
  for (int i = 0; i < N_WARMUP; i++) run(s, out);

  double samples[N_RUNS];
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    run(s, out);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), checksum_f64_near(out, 3), SPHERES * ORBIT + TRIANGLES * RAYS, 2, N_RUNS);
  return 0;
}
