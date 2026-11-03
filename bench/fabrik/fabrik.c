// fabrik.c – FABRIK inverse kinematics of a ten-bone chain chasing a moving
// target, the object-graph kernel.
//
// Ports pmndrs/math (MIT, Copyright (c) 2026 Isaac Mason, bench/_lib/pmath/LICENSE)
// as written: ik/fabrik3.js (createJoint3, createChain3, addBone,
// addConsecutiveBone, getBoneDirection, forward, backward, iterate, solve, and
// the private functions they reach: hasDirection, constrainForward,
// constrainBackward, constrainHinge, projectOntoHinge, rotateAboutAxis,
// resolveLocalHinge, basisFromDirection, orthonormalize, normalizeOr,
// saveSolution, restoreSolution) and core/vec3.js (copy, subtract,
// scaleAndAdd, distance, squaredLength, normalize, dot, perpendicular,
// transformMat3, signedAngle, rotateTowards). The case's joints are
// unconstrained balls, so the constraint switch runs per bone but its hinge and
// rotor branches, the only trigonometry, are never taken.
//
// Layout: a vector, a three-element plain array in the JS, is a fixed
// double[3] (vec3), a mat3 a double[9]; the joint, bone and chain records are
// structs, each bone holding its own joint (addBone's default createJoint3(),
// passed explicitly); the chain's bones and bestSolution arrays are growable
// buffers (malloc/realloc with capacity) grown by push, as the JS grows them;
// the module scratch vectors (_pass_direction, _pass_reference, _constrain_*,
// _addConsecutive_end, vec3's _rotateTowards_axis) are file-scope statics; the
// TypeScript enums the JS compiles to numbers are C enums. The functions keep
// their out-parameters; the `return out` / `return chain` meant for chaining is
// dropped.
//
// Reports: median ms across N_RUNS, throughput in solves/µs, FNV-1a checksum
// (checksum_f64) of the four results: its stride of 128 values hashes the low
// word of the first, the sum of the K solve distances.
#include "../_lib/bench.h"
#include <math.h>
#include <stdbool.h>
#include <stdlib.h>

#define BONES    10
#define K        60
#define N_RUNS   21
#define N_WARMUP 5

#define PI 3.141592653589793  // Math.PI

typedef double vec3[3];
typedef double mat3[9];

// grows a buffer of `size`-byte elements to hold n of them, doubling its capacity
static void *grow(void *buf, int *cap, int n, size_t size) {
  if (n <= *cap) return buf;
  int c = *cap > 0 ? *cap : 8;
  while (c < n) c *= 2;
  void *p = realloc(buf, (size_t)c * size);
  if (!p) abort();
  *cap = c;
  return p;
}

// pmndrs/math core/vec3
static vec3 rotate_towards_axis;

static void vec3_copy(vec3 out, const vec3 a) {
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
}

static void vec3_subtract(vec3 out, const vec3 a, const vec3 b) {
  out[0] = a[0] - b[0];
  out[1] = a[1] - b[1];
  out[2] = a[2] - b[2];
}

static void vec3_scale_and_add(vec3 out, const vec3 a, const vec3 b, double scale) {
  out[0] = a[0] + b[0] * scale;
  out[1] = a[1] + b[1] * scale;
  out[2] = a[2] + b[2] * scale;
}

static double vec3_distance(const vec3 a, const vec3 b) {
  double x = b[0] - a[0];
  double y = b[1] - a[1];
  double z = b[2] - a[2];
  return sqrt(x * x + y * y + z * z);
}

static double vec3_squared_length(const vec3 a) {
  double x = a[0];
  double y = a[1];
  double z = a[2];
  return x * x + y * y + z * z;
}

static void vec3_normalize(vec3 out, const vec3 a) {
  double x = a[0];
  double y = a[1];
  double z = a[2];
  double len = x * x + y * y + z * z;
  if (len > 0) {
    len = 1 / sqrt(len);
  }
  out[0] = a[0] * len;
  out[1] = a[1] * len;
  out[2] = a[2] * len;
}

static double vec3_dot(const vec3 a, const vec3 b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

static void vec3_perpendicular(vec3 out, const vec3 a) {
  if (fabs(a[0]) > fabs(a[1])) {
    double len = sqrt(a[0] * a[0] + a[2] * a[2]);
    double inv_len = 1.0 / len;
    out[0] = a[2] * inv_len;
    out[1] = 0;
    out[2] = -a[0] * inv_len;
  } else {
    double len = sqrt(a[1] * a[1] + a[2] * a[2]);
    if (len == 0) {
      out[0] = 1;
      out[1] = 0;
      out[2] = 0;
      return;
    }
    double inv_len = 1.0 / len;
    out[0] = 0;
    out[1] = a[2] * inv_len;
    out[2] = -a[1] * inv_len;
  }
}

static void vec3_transform_mat3(vec3 out, const vec3 a, const mat3 m) {
  double x = a[0];
  double y = a[1];
  double z = a[2];
  out[0] = x * m[0] + y * m[3] + z * m[6];
  out[1] = x * m[1] + y * m[4] + z * m[7];
  out[2] = x * m[2] + y * m[5] + z * m[8];
}

static double vec3_signed_angle(const vec3 a, const vec3 b, const vec3 axis) {
  double nx = axis[0];
  double ny = axis[1];
  double nz = axis[2];
  double ad = a[0] * nx + a[1] * ny + a[2] * nz;
  double ax = a[0] - nx * ad;
  double ay = a[1] - ny * ad;
  double az = a[2] - nz * ad;
  double bd = b[0] * nx + b[1] * ny + b[2] * nz;
  double bx = b[0] - nx * bd;
  double by = b[1] - ny * bd;
  double bz = b[2] - nz * bd;
  double cx = ay * bz - az * by;
  double cy = az * bx - ax * bz;
  double cz = ax * by - ay * bx;
  return atan2(cx * nx + cy * ny + cz * nz, ax * bx + ay * by + az * bz);
}

static void vec3_rotate_towards(vec3 out, const vec3 from, const vec3 to, double max_angle) {
  double fx = from[0];
  double fy = from[1];
  double fz = from[2];
  double tx = to[0];
  double ty = to[1];
  double tz = to[2];
  // Math.min(Math.max(dot, -1), 1), a NaN passing through as in the JS
  double dot = fx * tx + fy * ty + fz * tz;
  double cosine = dot < -1 ? -1 : dot > 1 ? 1 : dot;
  double limit = max_angle > 0 ? max_angle : 0;
  if (acos(cosine) <= limit) {
    out[0] = tx;
    out[1] = ty;
    out[2] = tz;
    return;
  }
  double axis_x = fy * tz - fz * ty;
  double axis_y = fz * tx - fx * tz;
  double axis_z = fx * ty - fy * tx;
  double axis_length = sqrt(axis_x * axis_x + axis_y * axis_y + axis_z * axis_z);
  if (axis_length < 1e-8) {
    vec3_perpendicular(rotate_towards_axis, from);
    axis_x = rotate_towards_axis[0];
    axis_y = rotate_towards_axis[1];
    axis_z = rotate_towards_axis[2];
  } else {
    double inverse_length = 1 / axis_length;
    axis_x *= inverse_length;
    axis_y *= inverse_length;
    axis_z *= inverse_length;
  }
  double c = cos(limit);
  double s = sin(limit);
  double d = (axis_x * fx + axis_y * fy + axis_z * fz) * (1 - c);
  out[0] = fx * c + (axis_y * fz - axis_z * fy) * s + axis_x * d;
  out[1] = fy * c + (axis_z * fx - axis_x * fz) * s + axis_y * d;
  out[2] = fz * c + (axis_x * fy - axis_y * fx) * s + axis_z * d;
}

// pmndrs/math ik/fabrik3
typedef enum { JOINT_BALL, JOINT_GLOBAL_HINGE, JOINT_LOCAL_HINGE } JointType;

typedef enum {
  BASEBONE_NONE,
  BASEBONE_GLOBAL_ROTOR,
  BASEBONE_LOCAL_ROTOR,
  BASEBONE_GLOBAL_HINGE,
  BASEBONE_LOCAL_HINGE
} BaseboneConstraintType;

#define DEFAULT_MAX_ITERATIONS 20
#define DEFAULT_SOLVE_DISTANCE_THRESHOLD 0.01
#define DEFAULT_MIN_ITERATION_CHANGE 1e-4
#define DEGENERATE_SQUARED_LENGTH 1e-24

typedef struct {
  JointType type;
  double rotor;
  double clockwise;
  double anticlockwise;
  vec3 rotation_axis;
  vec3 reference_axis;
} Joint3;

typedef struct {
  vec3 start;
  vec3 end;
  double length;
  Joint3 joint;
} Bone3;

typedef struct {
  Bone3 *bones;
  int bones_len, bones_cap;
  double length;
  vec3 base;
  bool fixed_base;
  BaseboneConstraintType basebone_constraint_type;
  vec3 basebone_axis;
  vec3 basebone_reference_axis;
  vec3 basebone_world_axis;
  vec3 basebone_world_reference_axis;
  double basebone_rotor;
  double basebone_clockwise;
  double basebone_anticlockwise;
  vec3 embedded_target;
  bool use_embedded_target;
  int max_iterations;
  double solve_distance_threshold;
  double min_iteration_change;
  double solve_distance;
  double *best_solution;
  int best_solution_len, best_solution_cap;
} Chain3;

static const vec3 UP = { 0, 1, 0 };
static vec3 add_consecutive_end;
static vec3 pass_reference;
static vec3 pass_direction;
static vec3 constrain_axis;
static vec3 constrain_reference;
static mat3 constrain_basis = { 1, 0, 0, 0, 1, 0, 0, 0, 1 };  // mat3.create()

static bool has_direction(double squared_length) {
  if (isnan(squared_length)) return false;
  return squared_length >= DEGENERATE_SQUARED_LENGTH;
}

static Joint3 create_joint3(void) {
  Joint3 joint = {
    .type = JOINT_BALL,
    .rotor = PI,
    .clockwise = PI,
    .anticlockwise = PI,
    .rotation_axis = { 0, 0, 1 },
    .reference_axis = { 1, 0, 0 },
  };
  return joint;
}

static Chain3 create_chain3(void) {
  Chain3 chain = {
    .bones = NULL,
    .length = 0,
    .base = { 0, 0, 0 },
    .fixed_base = true,
    .basebone_constraint_type = BASEBONE_NONE,
    .basebone_axis = { 0, 1, 0 },
    .basebone_reference_axis = { 1, 0, 0 },
    .basebone_world_axis = { 0, 1, 0 },
    .basebone_world_reference_axis = { 1, 0, 0 },
    .basebone_rotor = PI,
    .basebone_clockwise = PI,
    .basebone_anticlockwise = PI,
    .embedded_target = { 0, 0, 0 },
    .use_embedded_target = false,
    .max_iterations = DEFAULT_MAX_ITERATIONS,
    .solve_distance_threshold = DEFAULT_SOLVE_DISTANCE_THRESHOLD,
    .min_iteration_change = DEFAULT_MIN_ITERATION_CHANGE,
    .solve_distance = INFINITY,
    .best_solution = NULL,
  };
  return chain;
}

static void add_bone(Chain3 *chain, const vec3 start, const vec3 end, Joint3 joint) {
  Bone3 bone = {
    .start = { start[0], start[1], start[2] },
    .end = { end[0], end[1], end[2] },
    .length = vec3_distance(start, end),
    .joint = joint,
  };
  if (chain->bones_len == 0) {
    chain->base[0] = start[0];
    chain->base[1] = start[1];
    chain->base[2] = start[2];
  }
  chain->bones = grow(chain->bones, &chain->bones_cap, chain->bones_len + 1, sizeof(Bone3));
  chain->bones[chain->bones_len++] = bone;
  chain->length += bone.length;
  chain->best_solution = grow(chain->best_solution, &chain->best_solution_cap,
                              chain->best_solution_len + 6, sizeof(double));
  for (int k = 0; k < 6; k++) chain->best_solution[chain->best_solution_len++] = 0;
}

static void add_consecutive_bone(Chain3 *chain, const vec3 direction, double length, Joint3 joint) {
  const Bone3 *previous = &chain->bones[chain->bones_len - 1];
  add_consecutive_end[0] = previous->end[0] + direction[0] * length;
  add_consecutive_end[1] = previous->end[1] + direction[1] * length;
  add_consecutive_end[2] = previous->end[2] + direction[2] * length;
  // add_bone copies previous->end before it grows the bones buffer
  add_bone(chain, previous->end, add_consecutive_end, joint);
}

static void orthonormalize(vec3 out, const vec3 a, const vec3 axis) {
  vec3_scale_and_add(out, a, axis, -vec3_dot(a, axis));
  if (!has_direction(vec3_squared_length(out))) {
    vec3_perpendicular(out, axis);
    return;
  }
  vec3_normalize(out, out);
}

static void normalize_or(vec3 out, const vec3 fallback) {
  if (!has_direction(vec3_squared_length(out))) {
    vec3_copy(out, fallback);
    return;
  }
  vec3_normalize(out, out);
}

static void get_bone_direction(vec3 out, const Chain3 *chain, int index) {
  const Bone3 *bone = &chain->bones[index];
  vec3_subtract(out, bone->end, bone->start);
  normalize_or(out, UP);
}

static void project_onto_hinge(vec3 out, double x, double y, double z, const vec3 axis,
                               const vec3 reference_axis) {
  double d = x * axis[0] + y * axis[1] + z * axis[2];
  out[0] = x - axis[0] * d;
  out[1] = y - axis[1] * d;
  out[2] = z - axis[2] * d;
  if (!has_direction(vec3_squared_length(out))) {
    vec3_copy(out, reference_axis);
    return;
  }
  vec3_normalize(out, out);
}

static void rotate_about_axis(vec3 out, const vec3 a, const vec3 axis, double radians) {
  double ax = a[0];
  double ay = a[1];
  double az = a[2];
  double kx = axis[0];
  double ky = axis[1];
  double kz = axis[2];
  double c = cos(radians);
  double s = sin(radians);
  double d = (kx * ax + ky * ay + kz * az) * (1 - c);
  out[0] = ax * c + (ky * az - kz * ay) * s + kx * d;
  out[1] = ay * c + (kz * ax - kx * az) * s + ky * d;
  out[2] = az * c + (kx * ay - ky * ax) * s + kz * d;
}

static void constrain_hinge(double x, double y, double z, const vec3 axis, const vec3 reference_axis,
                            double clockwise, double anticlockwise) {
  project_onto_hinge(pass_direction, x, y, z, axis, reference_axis);
  if (clockwise >= PI && anticlockwise >= PI) return;
  double signed_angle = vec3_signed_angle(reference_axis, pass_direction, axis);
  if (signed_angle > anticlockwise) {
    rotate_about_axis(pass_direction, reference_axis, axis, anticlockwise);
  } else if (signed_angle < -clockwise) {
    rotate_about_axis(pass_direction, reference_axis, axis, -clockwise);
  }
}

static void basis_from_direction(mat3 out, const vec3 direction) {
  double x = direction[0];
  double y = direction[1];
  double z = direction[2];
  if (z < -0.9999999) {
    out[0] = 0;
    out[1] = -1;
    out[2] = 0;
    out[3] = -1;
    out[4] = 0;
    out[5] = 0;
    out[6] = x;
    out[7] = y;
    out[8] = z;
    return;
  }
  double a = 1 / (1 + z);
  double b = -x * y * a;
  out[0] = 1 - x * x * a;
  out[1] = b;
  out[2] = -x;
  out[3] = b;
  out[4] = 1 - y * y * a;
  out[5] = -y;
  out[6] = x;
  out[7] = y;
  out[8] = z;
}

static void resolve_local_hinge(const Chain3 *chain, int index, const Joint3 *joint) {
  get_bone_direction(constrain_axis, chain, index - 1);
  basis_from_direction(constrain_basis, constrain_axis);
  vec3_transform_mat3(constrain_axis, joint->rotation_axis, constrain_basis);
  vec3_normalize(constrain_axis, constrain_axis);
  vec3_transform_mat3(constrain_reference, joint->reference_axis, constrain_basis);
  orthonormalize(constrain_reference, constrain_reference, constrain_axis);
}

static void constrain_forward(const Chain3 *chain, int index, double x, double y, double z,
                              bool has_reference) {
  pass_direction[0] = x;
  pass_direction[1] = y;
  pass_direction[2] = z;
  if (index == 0) {
    BaseboneConstraintType type = chain->basebone_constraint_type;
    if (type == BASEBONE_GLOBAL_HINGE || type == BASEBONE_LOCAL_HINGE) {
      project_onto_hinge(pass_direction, x, y, z, chain->basebone_world_axis,
                         chain->basebone_world_reference_axis);
      return;
    }
  } else {
    const Joint3 *joint = &chain->bones[index].joint;
    if (joint->type == JOINT_GLOBAL_HINGE) {
      project_onto_hinge(pass_direction, x, y, z, joint->rotation_axis, joint->reference_axis);
      return;
    }
    if (joint->type == JOINT_LOCAL_HINGE) {
      resolve_local_hinge(chain, index, joint);
      project_onto_hinge(pass_direction, x, y, z, constrain_axis, constrain_reference);
      return;
    }
  }
  if (!has_reference) return;
  const Joint3 *outer = &chain->bones[index + 1].joint;
  if (outer->type != JOINT_BALL || outer->rotor >= PI) return;
  pass_direction[0] = x;
  pass_direction[1] = y;
  pass_direction[2] = z;
  vec3_rotate_towards(pass_direction, pass_reference, pass_direction, outer->rotor);
}

static void constrain_backward(const Chain3 *chain, int index, double x, double y, double z,
                               bool has_reference) {
  pass_direction[0] = x;
  pass_direction[1] = y;
  pass_direction[2] = z;
  if (index == 0) {
    switch (chain->basebone_constraint_type) {
    case BASEBONE_GLOBAL_ROTOR:
    case BASEBONE_LOCAL_ROTOR:
      if (chain->basebone_rotor >= PI) return;
      vec3_rotate_towards(pass_direction, chain->basebone_world_axis, pass_direction, chain->basebone_rotor);
      return;
    case BASEBONE_GLOBAL_HINGE:
    case BASEBONE_LOCAL_HINGE:
      constrain_hinge(x, y, z, chain->basebone_world_axis, chain->basebone_world_reference_axis,
                      chain->basebone_clockwise, chain->basebone_anticlockwise);
      return;
    default:
      return;
    }
  }
  const Joint3 *joint = &chain->bones[index].joint;
  switch (joint->type) {
  case JOINT_BALL:
    if (!has_reference || joint->rotor >= PI) return;
    vec3_rotate_towards(pass_direction, pass_reference, pass_direction, joint->rotor);
    return;
  case JOINT_GLOBAL_HINGE:
    constrain_hinge(x, y, z, joint->rotation_axis, joint->reference_axis, joint->clockwise,
                    joint->anticlockwise);
    return;
  case JOINT_LOCAL_HINGE:
    resolve_local_hinge(chain, index, joint);
    constrain_hinge(x, y, z, constrain_axis, constrain_reference, joint->clockwise, joint->anticlockwise);
    return;
  default:
    return;
  }
}

static void forward(Chain3 *chain, const vec3 target) {
  Bone3 *bones = chain->bones;
  int count = chain->bones_len;
  if (count == 0) return;
  if (!isfinite(target[0]) || !isfinite(target[1]) || !isfinite(target[2])) return;
  Bone3 *effector = &bones[count - 1];
  effector->end[0] = target[0];
  effector->end[1] = target[1];
  effector->end[2] = target[2];
  bool has_reference = false;
  for (int i = count - 1; i >= 0; i--) {
    Bone3 *bone = &bones[i];
    double *start = bone->start;
    double *end = bone->end;
    double dx = start[0] - end[0];
    double dy = start[1] - end[1];
    double dz = start[2] - end[2];
    double squared_length = dx * dx + dy * dy + dz * dz;
    if (!has_direction(squared_length)) {
      dx = has_reference ? pass_reference[0] : UP[0];
      dy = has_reference ? pass_reference[1] : UP[1];
      dz = has_reference ? pass_reference[2] : UP[2];
    } else {
      double inverse_length = 1 / sqrt(squared_length);
      dx *= inverse_length;
      dy *= inverse_length;
      dz *= inverse_length;
    }
    constrain_forward(chain, i, dx, dy, dz, has_reference);
    dx = pass_direction[0];
    dy = pass_direction[1];
    dz = pass_direction[2];
    double x = end[0] + dx * bone->length;
    double y = end[1] + dy * bone->length;
    double z = end[2] + dz * bone->length;
    start[0] = x;
    start[1] = y;
    start[2] = z;
    if (i > 0) {
      double *previous_end = bones[i - 1].end;
      previous_end[0] = x;
      previous_end[1] = y;
      previous_end[2] = z;
    }
    pass_reference[0] = dx;
    pass_reference[1] = dy;
    pass_reference[2] = dz;
    has_reference = true;
  }
}

static void backward(Chain3 *chain, const vec3 base) {
  Bone3 *bones = chain->bones;
  int count = chain->bones_len;
  if (count == 0) return;
  if (!isfinite(base[0]) || !isfinite(base[1]) || !isfinite(base[2])) return;
  if (chain->fixed_base) {
    double *start = bones[0].start;
    start[0] = base[0];
    start[1] = base[1];
    start[2] = base[2];
  }
  bool has_reference = false;
  for (int i = 0; i < count; i++) {
    Bone3 *bone = &bones[i];
    double *start = bone->start;
    double *end = bone->end;
    double dx = end[0] - start[0];
    double dy = end[1] - start[1];
    double dz = end[2] - start[2];
    double squared_length = dx * dx + dy * dy + dz * dz;
    if (!has_direction(squared_length)) {
      dx = has_reference ? pass_reference[0] : UP[0];
      dy = has_reference ? pass_reference[1] : UP[1];
      dz = has_reference ? pass_reference[2] : UP[2];
    } else {
      double inverse_length = 1 / sqrt(squared_length);
      dx *= inverse_length;
      dy *= inverse_length;
      dz *= inverse_length;
    }
    constrain_backward(chain, i, dx, dy, dz, has_reference);
    dx = pass_direction[0];
    dy = pass_direction[1];
    dz = pass_direction[2];
    if (i == 0 && !chain->fixed_base) {
      start[0] = end[0] - dx * bone->length;
      start[1] = end[1] - dy * bone->length;
      start[2] = end[2] - dz * bone->length;
    }
    double x = start[0] + dx * bone->length;
    double y = start[1] + dy * bone->length;
    double z = start[2] + dz * bone->length;
    end[0] = x;
    end[1] = y;
    end[2] = z;
    if (i < count - 1) {
      double *next_start = bones[i + 1].start;
      next_start[0] = x;
      next_start[1] = y;
      next_start[2] = z;
    }
    pass_reference[0] = dx;
    pass_reference[1] = dy;
    pass_reference[2] = dz;
    has_reference = true;
  }
}

static double iterate(Chain3 *chain, const vec3 target) {
  if (chain->bones_len == 0) return INFINITY;
  forward(chain, target);
  backward(chain, chain->base);
  return vec3_distance(chain->bones[chain->bones_len - 1].end, target);
}

static void save_solution(Chain3 *chain) {
  const Bone3 *bones = chain->bones;
  double *solution = chain->best_solution;
  for (int i = 0; i < chain->bones_len; i++) {
    const Bone3 *bone = &bones[i];
    int offset = i * 6;
    solution[offset] = bone->start[0];
    solution[offset + 1] = bone->start[1];
    solution[offset + 2] = bone->start[2];
    solution[offset + 3] = bone->end[0];
    solution[offset + 4] = bone->end[1];
    solution[offset + 5] = bone->end[2];
  }
}

static void restore_solution(Chain3 *chain) {
  Bone3 *bones = chain->bones;
  const double *solution = chain->best_solution;
  for (int i = 0; i < chain->bones_len; i++) {
    Bone3 *bone = &bones[i];
    int offset = i * 6;
    bone->start[0] = solution[offset];
    bone->start[1] = solution[offset + 1];
    bone->start[2] = solution[offset + 2];
    bone->end[0] = solution[offset + 3];
    bone->end[1] = solution[offset + 4];
    bone->end[2] = solution[offset + 5];
  }
}

static double solve(Chain3 *chain, const vec3 target) {
  int count = chain->bones_len;
  if (count == 0) {
    chain->solve_distance = INFINITY;
    return chain->solve_distance;
  }
  if (chain->best_solution_len < count * 6) {
    chain->best_solution = grow(chain->best_solution, &chain->best_solution_cap, count * 6, sizeof(double));
    chain->best_solution_len = count * 6;
    for (int i = 0; i < chain->best_solution_len; i++) chain->best_solution[i] = 0;
  }
  double best = INFINITY;
  double previous = INFINITY;
  for (int i = 0; i < chain->max_iterations; i++) {
    double distance = iterate(chain, target);
    if (distance < best) {
      best = distance;
      save_solution(chain);
      if (distance <= chain->solve_distance_threshold) break;
    } else if (fabs(distance - previous) < chain->min_iteration_change) {
      break;
    }
    previous = distance;
  }
  if (best != INFINITY) {
    restore_solution(chain);
  }
  chain->solve_distance = best;
  return best;
}

static Chain3 chain;
static vec3 target;
static int step = 0;

// A target wandering the reach: a quadratic pseudo-orbit, no transcendentals.
static const double *advance(void) {
  step = (step + 1) % 1000;
  double t = step * 0.001, u = 1 - t;
  target[0] = (t * t - u * u) * BONES * 0.6;
  target[1] = (2 * t * u - 0.3) * BONES * 0.6;
  target[2] = (t - 0.5) * BONES * 0.3;
  return target;
}

static void run(double *out) {
  double acc = 0;
  for (int i = 0; i < K; i++) acc += solve(&chain, advance());
  const double *effector = chain.bones[BONES - 1].end;
  out[0] = acc;
  out[1] = effector[0];
  out[2] = effector[1];
  out[3] = effector[2];
}

int main(void) {
  chain = create_chain3();
  add_bone(&chain, (vec3){ 0, 0, 0 }, (vec3){ 0, 1, 0 }, create_joint3());
  for (int i = 1; i < BONES; i++) add_consecutive_bone(&chain, (vec3){ 0, 1, 0 }, 1, create_joint3());

  double out[4] = { 0 };
  for (int i = 0; i < N_WARMUP; i++) run(out);

  double samples[N_RUNS];
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    run(out);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), checksum_f64(out, 4), K, 1, N_RUNS);
  free(chain.bones);
  free(chain.best_solution);
}
