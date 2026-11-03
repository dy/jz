// polytri.c – ear-clipping triangulation of a comb and a convex polygon and
// the quick convex decomposition of a gear, the runtime-built-array kernel.
//
// Ports pmndrs/math (MIT, Copyright (c) 2026 Isaac Mason, bench/_lib/pmath/LICENSE)
// as written: geometry/polygon2-triangulate.js (triangulatePolygon2 with
// nextIdx, prevIdx, area2, collinear, intersectProp, between, intersectSeg, vX,
// vY, diagonalie, inCone, diagonal), geometry/polygon2-decompose.js
// (decomposePolygon2Quick with triArea, lineIntersection, segmentsIntersect,
// appendRange, toCCW, canSeeSegment) and shapes/polygon2.js (signedArea,
// isReflexVertex, reverse).
//
// Layout: a polygon is a flat x, y array of doubles. Each JS array the code
// grows is a growable buffer (malloc/realloc with capacity, a push helper):
// the polygons decomposePolygon2Quick builds by push, its stack, levels and
// result list, and triangulatePolygon2's out, which the JS writes past its
// length (an index at the length appends, as a JS array grows). The index
// array, `new Array(n)` per call, is a malloc'd uint32_t[n] per call, its
// EAR_FLAG bit the JS's int32 sign bit. What the JS allocates per call is freed
// per call: the index array, every polygon the decomposition drops, and the
// returned list once the case has its length. The input polygons are fixed
// arrays; lineIntersection's module scratch _decompIsect is a file-scope
// static.
//
// Reports: median ms across N_RUNS, throughput in polygons/µs, FNV-1a checksum
// (checksum_f64) of the counts and the last triangulation: its stride of 128
// values hashes the low word of the first, the triangle count.
#include "../_lib/bench.h"
#include <float.h>
#include <math.h>
#include <stdbool.h>
#include <stdlib.h>

#define N_ITERS  40
#define N_RUNS   21
#define N_WARMUP 5
#define CONVEX_N 32
#define SPIKES   12

#define PI 3.141592653589793  // Math.PI

// Growable buffers: JS arrays that push (and a write at their length) extend.
typedef struct { double *data; int len, cap; } Poly;          // flat x, y
typedef struct { Poly *data; int len, cap; } PolyList;
typedef struct { int *data; int len, cap; } IntList;
typedef struct { uint32_t *data; int len, cap; } IndexList;

static void *grow(void *data, int *cap, size_t size) {
  *cap = *cap > 0 ? *cap * 2 : 8;
  void *p = realloc(data, (size_t)*cap * size);
  if (!p) abort();
  return p;
}

static void poly_push(Poly *a, double v) {
  if (a->len == a->cap) a->data = grow(a->data, &a->cap, sizeof *a->data);
  a->data[a->len++] = v;
}

// a[i] = v on a JS array, i at most its length: at the length it appends
static void poly_set(Poly *a, int i, double v) {
  if (i < a->len) {
    a->data[i] = v;
    return;
  }
  poly_push(a, v);
}

static void poly_list_push(PolyList *a, Poly v) {
  if (a->len == a->cap) a->data = grow(a->data, &a->cap, sizeof *a->data);
  a->data[a->len++] = v;
}

static void poly_list_free(PolyList *a) {
  for (int i = 0; i < a->len; i++) free(a->data[i].data);
  free(a->data);
}

static void int_list_push(IntList *a, int v) {
  if (a->len == a->cap) a->data = grow(a->data, &a->cap, sizeof *a->data);
  a->data[a->len++] = v;
}

static void index_list_set(IndexList *a, int i, uint32_t v) {
  if (i < a->len) {
    a->data[i] = v;
    return;
  }
  if (a->len == a->cap) a->data = grow(a->data, &a->cap, sizeof *a->data);
  a->data[a->len++] = v;
}

// pmndrs/math shapes/polygon2
static double signed_area(const double *vertices, int n) {
  double area = 0;
  for (int i = 0, j = n - 1; i < n; j = i++) {
    double xi = vertices[i * 2];
    double yi = vertices[i * 2 + 1];
    double xj = vertices[j * 2];
    double yj = vertices[j * 2 + 1];
    area += xj * yi - xi * yj;
  }
  return area / 2;
}

static bool is_reflex_vertex(const double *vertices, int n, int i) {
  int p = (i - 1 + n) % n * 2;
  int c = i * 2;
  int q = (i + 1) % n * 2;
  double ax = vertices[c] - vertices[p];
  double ay = vertices[c + 1] - vertices[p + 1];
  double bx = vertices[q] - vertices[c];
  double by = vertices[q + 1] - vertices[c + 1];
  return ax * by - ay * bx < 0;
}

static void reverse(double *out, const double *vertices, int n) {
  for (int lo = 0, hi = n - 1; lo < hi; lo++, hi--) {
    double x = vertices[lo * 2];
    double y = vertices[lo * 2 + 1];
    out[lo * 2] = vertices[hi * 2];
    out[lo * 2 + 1] = vertices[hi * 2 + 1];
    out[hi * 2] = x;
    out[hi * 2 + 1] = y;
  }
  if (out != vertices && n % 2 == 1) {
    int mid = (n >> 1) * 2;
    out[mid] = vertices[mid];
    out[mid + 1] = vertices[mid + 1];
  }
}

// pmndrs/math geometry/polygon2-triangulate
#define IDX_MASK 0x0fffffffu
#define EAR_FLAG 0x80000000u

static int next_idx(int i, int n) { return i + 1 < n ? i + 1 : 0; }
static int prev_idx(int i, int n) { return i - 1 >= 0 ? i - 1 : n - 1; }

static double area2(double ax, double ay, double bx, double by, double cx, double cy) {
  return (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
}

static bool collinear(double ax, double ay, double bx, double by, double cx, double cy) {
  return area2(ax, ay, bx, by, cx, cy) == 0;
}

static bool intersect_prop(double ax, double ay, double bx, double by, double cx, double cy,
                           double dx, double dy) {
  if (collinear(ax, ay, bx, by, cx, cy) || collinear(ax, ay, bx, by, dx, dy) ||
      collinear(cx, cy, dx, dy, ax, ay) || collinear(cx, cy, dx, dy, bx, by)) {
    return false;
  }
  bool l1 = area2(ax, ay, bx, by, cx, cy) < 0;
  bool l2 = area2(ax, ay, bx, by, dx, dy) < 0;
  bool l3 = area2(cx, cy, dx, dy, ax, ay) < 0;
  bool l4 = area2(cx, cy, dx, dy, bx, by) < 0;
  return l1 != l2 && l3 != l4;
}

static bool between(double ax, double ay, double bx, double by, double cx, double cy) {
  if (!collinear(ax, ay, bx, by, cx, cy)) return false;
  if (ax != bx) return (ax <= cx && cx <= bx) || (ax >= cx && cx >= bx);
  return (ay <= cy && cy <= by) || (ay >= cy && cy >= by);
}

static bool intersect_seg(double ax, double ay, double bx, double by, double cx, double cy,
                          double dx, double dy) {
  if (intersect_prop(ax, ay, bx, by, cx, cy, dx, dy)) return true;
  return between(ax, ay, bx, by, cx, cy) || between(ax, ay, bx, by, dx, dy) ||
         between(cx, cy, dx, dy, ax, ay) || between(cx, cy, dx, dy, bx, by);
}

static double v_x(const double *vertices, const uint32_t *indices, int s) {
  return vertices[(indices[s] & IDX_MASK) * 2];
}

static double v_y(const double *vertices, const uint32_t *indices, int s) {
  return vertices[(indices[s] & IDX_MASK) * 2 + 1];
}

static bool diagonalie(int i, int j, int n, const double *vertices, const uint32_t *indices, bool loose) {
  double d0x = v_x(vertices, indices, i);
  double d0y = v_y(vertices, indices, i);
  double d1x = v_x(vertices, indices, j);
  double d1y = v_y(vertices, indices, j);
  for (int k = 0; k < n; k++) {
    int k1 = next_idx(k, n);
    if (k == i || k1 == i || k == j || k1 == j) continue;
    double e0x = v_x(vertices, indices, k);
    double e0y = v_y(vertices, indices, k);
    double e1x = v_x(vertices, indices, k1);
    double e1y = v_y(vertices, indices, k1);
    if ((d0x == e0x && d0y == e0y) || (d1x == e0x && d1y == e0y) || (d0x == e1x && d0y == e1y) ||
        (d1x == e1x && d1y == e1y)) {
      continue;
    }
    bool hit = loose ? intersect_prop(d0x, d0y, d1x, d1y, e0x, e0y, e1x, e1y)
                     : intersect_seg(d0x, d0y, d1x, d1y, e0x, e0y, e1x, e1y);
    if (hit) return false;
  }
  return true;
}

static bool in_cone(int i, int j, int n, const double *vertices, const uint32_t *indices, bool loose) {
  double ax = v_x(vertices, indices, i);
  double ay = v_y(vertices, indices, i);
  double bx = v_x(vertices, indices, j);
  double by = v_y(vertices, indices, j);
  int ni = next_idx(i, n);
  int pi = prev_idx(i, n);
  double nx = v_x(vertices, indices, ni);
  double ny = v_y(vertices, indices, ni);
  double px = v_x(vertices, indices, pi);
  double py = v_y(vertices, indices, pi);
  if (area2(px, py, ax, ay, nx, ny) <= 0) {
    double c1 = area2(ax, ay, bx, by, px, py);
    double c2 = area2(bx, by, ax, ay, nx, ny);
    return loose ? c1 <= 0 && c2 <= 0 : c1 < 0 && c2 < 0;
  }
  return !(area2(ax, ay, bx, by, nx, ny) <= 0 && area2(bx, by, ax, ay, px, py) <= 0);
}

static bool diagonal(int i, int j, int n, const double *vertices, const uint32_t *indices, bool loose) {
  return in_cone(i, j, n, vertices, indices, loose) && diagonalie(i, j, n, vertices, indices, loose);
}

static int triangulate_polygon2(IndexList *out, const double *vertices, int n) {
  if (n < 3) return 0;
  bool ccw = signed_area(vertices, n) >= 0;
  uint32_t *indices = malloc((size_t)n * sizeof *indices);
  if (!indices) abort();
  for (int i = 0; i < n; i++) indices[i] = (uint32_t)(ccw ? n - 1 - i : i);
  int ntris = 0;
  int dst = 0;
  for (int i = 0; i < n; i++) {
    int i1 = next_idx(i, n);
    if (diagonal(i, next_idx(i1, n), n, vertices, indices, false)) indices[i1] |= EAR_FLAG;
  }
  int nv = n;
  while (nv > 3) {
    double min_len = -1;
    int mini = -1;
    for (int i = 0; i < nv; i++) {
      int i1 = next_idx(i, nv);
      if (indices[i1] & EAR_FLAG) {
        uint32_t p0 = indices[i] & IDX_MASK;
        uint32_t p2 = indices[next_idx(i1, nv)] & IDX_MASK;
        double dx = vertices[p2 * 2] - vertices[p0 * 2];
        double dy = vertices[p2 * 2 + 1] - vertices[p0 * 2 + 1];
        double len = dx * dx + dy * dy;
        if (min_len < 0 || len < min_len) {
          min_len = len;
          mini = i;
        }
      }
    }
    if (mini == -1) {
      for (int i = 0; i < nv; i++) {
        int i1 = next_idx(i, nv);
        int i2 = next_idx(i1, nv);
        if (diagonal(i, i2, nv, vertices, indices, true)) {
          uint32_t p0 = indices[i] & IDX_MASK;
          uint32_t p2 = indices[next_idx(i2, nv)] & IDX_MASK;
          double dx = vertices[p2 * 2] - vertices[p0 * 2];
          double dy = vertices[p2 * 2 + 1] - vertices[p0 * 2 + 1];
          double len = dx * dx + dy * dy;
          if (min_len < 0 || len < min_len) {
            min_len = len;
            mini = i;
          }
        }
      }
      if (mini == -1) {
        free(indices);
        return ntris;
      }
    }
    int i = mini;
    int i1 = next_idx(i, nv);
    int i2 = next_idx(i1, nv);
    index_list_set(out, dst++, indices[i] & IDX_MASK);
    index_list_set(out, dst++, indices[i1] & IDX_MASK);
    index_list_set(out, dst++, indices[i2] & IDX_MASK);
    ntris++;
    nv--;
    for (int k = i1; k < nv; k++) indices[k] = indices[k + 1];
    if (i1 >= nv) i1 = 0;
    int i_prev = prev_idx(i1, nv);
    if (diagonal(prev_idx(i_prev, nv), i1, nv, vertices, indices, false)) indices[i_prev] |= EAR_FLAG;
    else indices[i_prev] &= IDX_MASK;
    if (diagonal(i_prev, next_idx(i1, nv), nv, vertices, indices, false)) indices[i1] |= EAR_FLAG;
    else indices[i1] &= IDX_MASK;
  }
  index_list_set(out, dst++, indices[0] & IDX_MASK);
  index_list_set(out, dst++, indices[1] & IDX_MASK);
  index_list_set(out, dst++, indices[2] & IDX_MASK);
  ntris++;
  free(indices);
  return ntris;
}

// pmndrs/math geometry/polygon2-decompose
static double decomp_isect[2];

static double tri_area(double ax, double ay, double bx, double by, double cx, double cy) {
  return (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
}

static double sq_dist(double ax, double ay, double bx, double by) {
  double dx = bx - ax;
  double dy = by - ay;
  return dx * dx + dy * dy;
}

static void line_intersection(double *out, double p1x, double p1y, double p2x, double p2y, double q1x,
                              double q1y, double q2x, double q2y) {
  double a1 = p2y - p1y;
  double b1 = p1x - p2x;
  double c1 = a1 * p1x + b1 * p1y;
  double a2 = q2y - q1y;
  double b2 = q1x - q2x;
  double c2 = a2 * q1x + b2 * q1y;
  double det = a1 * b2 - a2 * b1;
  if (det != 0) {
    out[0] = (b2 * c1 - b1 * c2) / det;
    out[1] = (a1 * c2 - a2 * c1) / det;
  } else {
    out[0] = 0;
    out[1] = 0;
  }
}

static bool segments_intersect(double p1x, double p1y, double p2x, double p2y, double q1x, double q1y,
                               double q2x, double q2y) {
  double rx = p2x - p1x;
  double ry = p2y - p1y;
  double ex = q2x - q1x;
  double ey = q2y - q1y;
  double denom = rx * ey - ry * ex;
  if (denom == 0) return false;
  double wx = q1x - p1x;
  double wy = q1y - p1y;
  double num_u = wx * ey - wy * ex;
  double num_v = wx * ry - wy * rx;
  if (denom < 0) {
    denom = -denom;
    num_u = -num_u;
    num_v = -num_v;
  }
  return num_u >= 0 && num_u <= denom && num_v >= 0 && num_v <= denom;
}

static void append_range(Poly *dst, const Poly *src, int from, int to) {
  for (int k = from; k < to; k++) {
    poly_push(dst, src->data[k * 2]);
    poly_push(dst, src->data[k * 2 + 1]);
  }
}

static void to_ccw(Poly *out, const double *vertices, int n) {
  for (int k = 0; k < n * 2; k++) poly_set(out, k, vertices[k]);
  if (signed_area(out->data, n) < 0) reverse(out->data, out->data, n);
}

#define QUICK_DECOMP_MAX_LEVEL 100

static bool can_see_segment(const Poly *poly, int a, int b) {
  int s = poly->len >> 1;
  const double *p = poly->data;
  double ax = p[a * 2];
  double ay = p[a * 2 + 1];
  double bx = p[b * 2];
  double by = p[b * 2 + 1];
  for (int i = 0; i < s; i++) {
    int i1 = i + 1 == s ? 0 : i + 1;
    if (i == a || i == b || i1 == a || i1 == b) continue;
    if (segments_intersect(ax, ay, bx, by, p[i * 2], p[i * 2 + 1], p[i1 * 2], p[i1 * 2 + 1])) {
      return false;
    }
  }
  return true;
}

static PolyList decompose_polygon2_quick(const double *vertices, int n) {
  PolyList out = { 0 };
  if (n < 3) return out;
  PolyList stack = { 0 };
  IntList levels = { 0 };
  Poly first = { 0 };
  to_ccw(&first, vertices, n);
  poly_list_push(&stack, first);
  int_list_push(&levels, 0);
  while (stack.len > 0) {
    Poly poly = stack.data[--stack.len];
    int level = levels.data[--levels.len];
    const double *p = poly.data;
    int s = poly.len >> 1;
    if (s < 3) {
      free(poly.data);
      continue;
    }
    if (level > QUICK_DECOMP_MAX_LEVEL) {
      poly_list_push(&out, poly);
      continue;
    }
    bool handled = false;
    for (int i = 0; i < s; i++) {
      if (!is_reflex_vertex(p, s, i)) continue;
      int ip = i == 0 ? s - 1 : i - 1;
      int i_n = i + 1 == s ? 0 : i + 1;
      double i_prev_x = p[ip * 2];
      double i_prev_y = p[ip * 2 + 1];
      double i_cur_x = p[i * 2];
      double i_cur_y = p[i * 2 + 1];
      double i_next_x = p[i_n * 2];
      double i_next_y = p[i_n * 2 + 1];
      double lower_dist = DBL_MAX;
      double upper_dist = DBL_MAX;
      double lower_int_x = 0;
      double lower_int_y = 0;
      double upper_int_x = 0;
      double upper_int_y = 0;
      int lower_index = 0;
      int upper_index = 0;
      for (int j = 0; j < s; j++) {
        double jx = p[j * 2];
        double jy = p[j * 2 + 1];
        if (tri_area(i_prev_x, i_prev_y, i_cur_x, i_cur_y, jx, jy) > 0) {
          int jm = j == 0 ? s - 1 : j - 1;
          double jmx = p[jm * 2];
          double jmy = p[jm * 2 + 1];
          if (tri_area(i_prev_x, i_prev_y, i_cur_x, i_cur_y, jmx, jmy) <= 0) {
            line_intersection(decomp_isect, i_prev_x, i_prev_y, i_cur_x, i_cur_y, jx, jy, jmx, jmy);
            double px = decomp_isect[0];
            double py = decomp_isect[1];
            if (tri_area(i_next_x, i_next_y, i_cur_x, i_cur_y, px, py) < 0) {
              double d = sq_dist(i_cur_x, i_cur_y, px, py);
              if (d < lower_dist) {
                lower_dist = d;
                lower_int_x = px;
                lower_int_y = py;
                lower_index = j;
              }
            }
          }
        }
        if (tri_area(i_next_x, i_next_y, i_cur_x, i_cur_y, jx, jy) <= 0) {
          int jp = j + 1 == s ? 0 : j + 1;
          double jpx = p[jp * 2];
          double jpy = p[jp * 2 + 1];
          if (tri_area(i_next_x, i_next_y, i_cur_x, i_cur_y, jpx, jpy) > 0) {
            line_intersection(decomp_isect, i_next_x, i_next_y, i_cur_x, i_cur_y, jx, jy, jpx, jpy);
            double px = decomp_isect[0];
            double py = decomp_isect[1];
            if (tri_area(i_prev_x, i_prev_y, i_cur_x, i_cur_y, px, py) > 0) {
              double d = sq_dist(i_cur_x, i_cur_y, px, py);
              if (d < upper_dist) {
                upper_dist = d;
                upper_int_x = px;
                upper_int_y = py;
                upper_index = j;
              }
            }
          }
        }
      }
      Poly lower_poly = { 0 };
      Poly upper_poly = { 0 };
      if (lower_index == (upper_index + 1) % s) {
        double px = (lower_int_x + upper_int_x) / 2;
        double py = (lower_int_y + upper_int_y) / 2;
        if (i < upper_index) {
          append_range(&lower_poly, &poly, i, upper_index + 1);
          poly_push(&lower_poly, px);
          poly_push(&lower_poly, py);
          poly_push(&upper_poly, px);
          poly_push(&upper_poly, py);
          if (lower_index != 0) append_range(&upper_poly, &poly, lower_index, s);
          append_range(&upper_poly, &poly, 0, i + 1);
        } else {
          if (i != 0) append_range(&lower_poly, &poly, i, s);
          append_range(&lower_poly, &poly, 0, upper_index + 1);
          poly_push(&lower_poly, px);
          poly_push(&lower_poly, py);
          poly_push(&upper_poly, px);
          poly_push(&upper_poly, py);
          append_range(&upper_poly, &poly, lower_index, i + 1);
        }
      } else {
        if (lower_index > upper_index) upper_index += s;
        if (upper_index < lower_index) {
          handled = true;
          break;
        }
        double closest_dist = DBL_MAX;
        int closest_index = 0;
        for (int j = lower_index; j <= upper_index; j++) {
          int jj = j >= s ? j - s : j;
          double jx = p[jj * 2];
          double jy = p[jj * 2 + 1];
          if (tri_area(i_prev_x, i_prev_y, i_cur_x, i_cur_y, jx, jy) >= 0 &&
              tri_area(i_next_x, i_next_y, i_cur_x, i_cur_y, jx, jy) <= 0) {
            double d = sq_dist(i_cur_x, i_cur_y, jx, jy);
            if (d < closest_dist && can_see_segment(&poly, i, jj)) {
              closest_dist = d;
              closest_index = jj;
            }
          }
        }
        if (i < closest_index) {
          append_range(&lower_poly, &poly, i, closest_index + 1);
          if (closest_index != 0) append_range(&upper_poly, &poly, closest_index, s);
          append_range(&upper_poly, &poly, 0, i + 1);
        } else {
          if (i != 0) append_range(&lower_poly, &poly, i, s);
          append_range(&lower_poly, &poly, 0, closest_index + 1);
          append_range(&upper_poly, &poly, closest_index, i + 1);
        }
      }
      if (lower_poly.len < upper_poly.len) {
        poly_list_push(&stack, upper_poly);
        poly_list_push(&stack, lower_poly);
      } else {
        poly_list_push(&stack, lower_poly);
        poly_list_push(&stack, upper_poly);
      }
      int_list_push(&levels, level + 1);
      int_list_push(&levels, level + 1);
      handled = true;
      break;
    }
    if (!handled) poly_list_push(&out, poly);
    else free(poly.data);  // the JS drops the split polygon
  }
  free(stack.data);
  free(levels.data);
  return out;
}

static const double comb[] = { 0, 0, 6, 0, 6, 3, 5, 3, 5, 1, 4, 1, 4, 3, 3, 3, 3, 1, 2, 1, 2, 3, 1, 3, 1, 1, 0, 1 };
#define COMB_N ((int)(sizeof comb / sizeof comb[0]) / 2)

static double convex[CONVEX_N * 2];
static double gear[SPIKES * 2 * 2];
static IndexList out;

static void run(double *acc, int iters) {
  int tris = 0, parts = 0;
  for (int i = 0; i < iters; i++) {
    tris += triangulate_polygon2(&out, comb, COMB_N);
    tris += triangulate_polygon2(&out, convex, CONVEX_N);
    PolyList pieces = decompose_polygon2_quick(gear, SPIKES * 2);
    parts += pieces.len;
    poly_list_free(&pieces);
  }
  acc[0] = tris;
  acc[1] = parts;
  for (int k = 0; k < 3 * (CONVEX_N - 2); k++) acc[2 + k] = out.data[k];
}

int main(void) {
  for (int i = 0; i < CONVEX_N; i++) {
    double a = ((double)i / CONVEX_N) * PI * 2;
    convex[i * 2] = cos(a) * 5;
    convex[i * 2 + 1] = sin(a) * 5;
  }
  for (int i = 0; i < SPIKES * 2; i++) {
    double a = ((double)i / (SPIKES * 2)) * PI * 2;
    double r = i % 2 == 0 ? 5 : 2.5;
    gear[i * 2] = cos(a) * r;
    gear[i * 2 + 1] = sin(a) * r;
  }

  double acc[2 + 3 * (CONVEX_N - 2)] = { 0 };
  for (int i = 0; i < N_WARMUP; i++) run(acc, N_ITERS);

  double samples[N_RUNS];
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    run(acc, N_ITERS);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), checksum_f64(acc, 2 + 3 * (CONVEX_N - 2)), N_ITERS * 3, 3, N_RUNS);
  free(out.data);
}
