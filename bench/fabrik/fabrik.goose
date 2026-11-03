// fabrik.goose: Goose port of fabrik.js (same chain, targets and checksum):
// FABRIK inverse kinematics of a ten-bone chain chasing a moving target, with
// pmndrs/math's ik/fabrik3 and the vec3 code it reaches ported as written,
// joint constraints included. Bones are inline records; a chain holds
// references to its two growable tables (bones, saved solution), which the
// caller owns: Goose's struct of references for several tables. The
// library's module-level scratch vectors are globals.

import bench from "../_lib";
import math;

let BONES = 10;
let K = 60;
let N_RUNS = 21;
let N_WARMUP = 5;
let POSITIVE_INFINITY = 1e309;      // past f64's range: +inf

let DEFAULT_MAX_ITERATIONS = 20;
let DEFAULT_SOLVE_DISTANCE_THRESHOLD = 0.01;
let DEFAULT_MIN_ITERATION_CHANGE = 1e-4;
let DEGENERATE_SQUARED_LENGTH = 1e-24;

struct Joint { kind: i32, rotor: f64, clockwise: f64, anticlockwise: f64, rotation_axis: f64[3], reference_axis: f64[3] }
struct Bone { start: f64[3], end: f64[3], length: f64, joint: Joint }
struct Chain {
    bones: Bone[>..]&, best_solution: f64[>..]&,
    length: f64, base: f64[3], fixed_base: bool,
    basebone_constraint_type: i32, basebone_world_axis: f64[3], basebone_world_reference_axis: f64[3],
    basebone_rotor: f64, basebone_clockwise: f64, basebone_anticlockwise: f64,
    max_iterations: i64, solve_distance_threshold: f64, min_iteration_change: f64, solve_distance: f64,
}

let UP = [0.0, 1.0, 0.0];
var pass_reference = [0.0; 3];
var pass_direction = [0.0; 3];
var constrain_axis = [0.0; 3];
var constrain_reference = [0.0; 3];
var constrain_basis = [0.0; 9];

// pmndrs/math core/vec3
fn squared_length(a: f64[3]) -> f64 { a[0] * a[0] + a[1] * a[1] + a[2] * a[2] }
fn distance(a: f64[3], b: f64[3]) -> f64 {
    let x = b[0] - a[0]; let y = b[1] - a[1]; let z = b[2] - a[2];
    return sqrt(x * x + y * y + z * z);
}
fn normalize(out: f64[3]&, a: f64[3]) {
    var len = a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
    if len > 0 { len = 1 / sqrt(len); }
    out[0] = a[0] * len; out[1] = a[1] * len; out[2] = a[2] * len;
}
fn transform_mat3(out: f64[3]&, a: f64[3], m: f64[9]) {
    let x = a[0]; let y = a[1]; let z = a[2];
    out[0] = x * m[0] + y * m[3] + z * m[6];
    out[1] = x * m[1] + y * m[4] + z * m[7];
    out[2] = x * m[2] + y * m[5] + z * m[8];
}
fn perpendicular(out: f64[3]&, a: f64[3]) {
    if abs(a[0]) > abs(a[1]) {
        let inv_len = 1.0 / sqrt(a[0] * a[0] + a[2] * a[2]);
        out[0] = a[2] * inv_len; out[1] = 0; out[2] = -a[0] * inv_len;
    } else {
        let len = sqrt(a[1] * a[1] + a[2] * a[2]);
        if len == 0 { out[0] = 1; out[1] = 0; out[2] = 0; return; }
        let inv_len = 1.0 / len;
        out[0] = 0; out[1] = a[2] * inv_len; out[2] = -a[1] * inv_len;
    }
}
fn signed_angle(a: f64[3], b: f64[3], axis: f64[3]) -> f64 {
    let nx = axis[0]; let ny = axis[1]; let nz = axis[2];
    let ad = a[0] * nx + a[1] * ny + a[2] * nz;
    let ax = a[0] - nx * ad; let ay = a[1] - ny * ad; let az = a[2] - nz * ad;
    let bd = b[0] * nx + b[1] * ny + b[2] * nz;
    let bx = b[0] - nx * bd; let by = b[1] - ny * bd; let bz = b[2] - nz * bd;
    let cx = ay * bz - az * by; let cy = az * bx - ax * bz; let cz = ax * by - ay * bx;
    return atan2(cx * nx + cy * ny + cz * nz, ax * bx + ay * by + az * bz);
}
fn rotate_towards(out: f64[3]&, from: f64[3], to: f64[3], max_angle: f64) {
    let fx = from[0]; let fy = from[1]; let fz = from[2];
    let tx = to[0]; let ty = to[1]; let tz = to[2];
    let cosine = min(max(fx * tx + fy * ty + fz * tz, -1.0), 1.0);
    let limit = if max_angle > 0 { max_angle } else { 0.0 };
    if acos(cosine) <= limit { out[0] = tx; out[1] = ty; out[2] = tz; return; }
    var axis_x = fy * tz - fz * ty;
    var axis_y = fz * tx - fx * tz;
    var axis_z = fx * ty - fy * tx;
    let axis_length = sqrt(axis_x * axis_x + axis_y * axis_y + axis_z * axis_z);
    if axis_length < 1e-8 {
        var axis = [0.0; 3];
        perpendicular(axis, from);
        axis_x = axis[0]; axis_y = axis[1]; axis_z = axis[2];
    } else {
        let inverse_length = 1 / axis_length;
        axis_x *= inverse_length; axis_y *= inverse_length; axis_z *= inverse_length;
    }
    let c = cos(limit);
    let s = sin(limit);
    let d = (axis_x * fx + axis_y * fy + axis_z * fz) * (1 - c);
    out[0] = fx * c + (axis_y * fz - axis_z * fy) * s + axis_x * d;
    out[1] = fy * c + (axis_z * fx - axis_x * fz) * s + axis_y * d;
    out[2] = fz * c + (axis_x * fy - axis_y * fx) * s + axis_z * d;
}

// pmndrs/math ik/fabrik3
fn has_direction(squared: f64) -> bool { if is_nan(squared) { false } else { squared >= DEGENERATE_SQUARED_LENGTH } }
fn is_finite(x: f64) -> bool { !is_nan(x) && !is_inf(x) }

fn create_joint3() -> Joint {
    Joint { kind: 0, rotor: PI, clockwise: PI, anticlockwise: PI, rotation_axis: [0.0, 0.0, 1.0], reference_axis: [1.0, 0.0, 0.0] }
}

fn add_bone(chain: Chain&, start: f64[3], end: f64[3]) {
    let length = distance(start, end);
    if chain.bones.len == 0 { chain.base = start; }
    chain.bones.push(Bone { start: start, end: end, length: length, joint: create_joint3() });
    chain.length += length;
    for k in 6 { chain.best_solution.push(0.0); }
}

fn add_consecutive_bone(chain: Chain&, direction: f64[3], length: f64) {
    let previous = chain.bones[chain.bones.len - 1].end;
    let end = [previous[0] + direction[0] * length, previous[1] + direction[1] * length, previous[2] + direction[2] * length];
    add_bone(chain, previous, end);
}

fn orthonormalize(out: f64[3]&, a: f64[3], axis: f64[3]) {
    let scale = -(a[0] * axis[0] + a[1] * axis[1] + a[2] * axis[2]);    // scaleAndAdd(out, a, axis, -dot)
    out[0] = a[0] + axis[0] * scale;
    out[1] = a[1] + axis[1] * scale;
    out[2] = a[2] + axis[2] * scale;
    if !has_direction(squared_length(out)) { perpendicular(out, axis); return; }
    normalize(out, out);
}

fn normalize_or(out: f64[3]&, fallback: f64[3]) {
    if !has_direction(squared_length(out)) { out = fallback; return; }
    normalize(out, out);
}

fn project_onto_hinge(out: f64[3]&, x: f64, y: f64, z: f64, axis: f64[3], reference_axis: f64[3]) {
    let d = x * axis[0] + y * axis[1] + z * axis[2];
    out[0] = x - axis[0] * d;
    out[1] = y - axis[1] * d;
    out[2] = z - axis[2] * d;
    if !has_direction(squared_length(out)) { out = reference_axis; return; }
    normalize(out, out);
}

fn rotate_about_axis(out: f64[3]&, a: f64[3], axis: f64[3], radians: f64) {
    let ax = a[0]; let ay = a[1]; let az = a[2];
    let kx = axis[0]; let ky = axis[1]; let kz = axis[2];
    let c = cos(radians);
    let s = sin(radians);
    let d = (kx * ax + ky * ay + kz * az) * (1 - c);
    out[0] = ax * c + (ky * az - kz * ay) * s + kx * d;
    out[1] = ay * c + (kz * ax - kx * az) * s + ky * d;
    out[2] = az * c + (kx * ay - ky * ax) * s + kz * d;
}

fn constrain_hinge(x: f64, y: f64, z: f64, axis: f64[3], reference_axis: f64[3], clockwise: f64, anticlockwise: f64) {
    project_onto_hinge(pass_direction, x, y, z, axis, reference_axis);
    if clockwise >= PI && anticlockwise >= PI { return; }
    let signed = signed_angle(reference_axis, pass_direction, axis);
    if signed > anticlockwise { rotate_about_axis(pass_direction, reference_axis, axis, anticlockwise); }
    else if signed < -clockwise { rotate_about_axis(pass_direction, reference_axis, axis, -clockwise); }
}

fn basis_from_direction(out: f64[9]&, direction: f64[3]) {
    let x = direction[0]; let y = direction[1]; let z = direction[2];
    if z < -0.9999999 { out = [0.0, -1.0, 0.0, -1.0, 0.0, 0.0, x, y, z]; return; }
    let a = 1 / (1 + z);
    let b = -x * y * a;
    out = [1 - x * x * a, b, -x, b, 1 - y * y * a, -y, x, y, z];
}

fn get_bone_direction(out: f64[3]&, chain: Chain&, index: i64) {
    let bone .= chain.bones[index];
    out[0] = bone.end[0] - bone.start[0];
    out[1] = bone.end[1] - bone.start[1];
    out[2] = bone.end[2] - bone.start[2];
    normalize_or(out, UP);
}

fn resolve_local_hinge(chain: Chain&, index: i64, joint: Joint) {
    get_bone_direction(constrain_axis, chain, index - 1);
    basis_from_direction(constrain_basis, constrain_axis);
    transform_mat3(constrain_axis, joint.rotation_axis, constrain_basis);
    normalize(constrain_axis, constrain_axis);
    transform_mat3(constrain_reference, joint.reference_axis, constrain_basis);
    orthonormalize(constrain_reference, constrain_reference, constrain_axis);
}

fn constrain_forward(chain: Chain&, index: i64, x: f64, y: f64, z: f64, has_reference: bool) {
    pass_direction = [x, y, z];
    if index == 0 {
        let kind = chain.basebone_constraint_type;
        if kind == 3 || kind == 4 {
            project_onto_hinge(pass_direction, x, y, z, chain.basebone_world_axis, chain.basebone_world_reference_axis);
            return;
        }
    } else {
        let joint = chain.bones[index].joint;
        if joint.kind == 1 { project_onto_hinge(pass_direction, x, y, z, joint.rotation_axis, joint.reference_axis); return; }
        if joint.kind == 2 {
            resolve_local_hinge(chain, index, joint);
            project_onto_hinge(pass_direction, x, y, z, constrain_axis, constrain_reference);
            return;
        }
    }
    if !has_reference { return; }
    let outer = chain.bones[index + 1].joint;
    if outer.kind != 0 || outer.rotor >= PI { return; }
    pass_direction = [x, y, z];
    rotate_towards(pass_direction, pass_reference, pass_direction, outer.rotor);
}

fn constrain_backward(chain: Chain&, index: i64, x: f64, y: f64, z: f64, has_reference: bool) {
    pass_direction = [x, y, z];
    if index == 0 {
        match chain.basebone_constraint_type {
            1, 2 => {
                if chain.basebone_rotor >= PI { return; }
                rotate_towards(pass_direction, chain.basebone_world_axis, pass_direction, chain.basebone_rotor);
                return;
            },
            3, 4 => {
                constrain_hinge(x, y, z, chain.basebone_world_axis, chain.basebone_world_reference_axis,
                                chain.basebone_clockwise, chain.basebone_anticlockwise);
                return;
            },
            _ => { return; },
        }
    }
    let joint = chain.bones[index].joint;
    match joint.kind {
        0 => {
            if !has_reference || joint.rotor >= PI { return; }
            rotate_towards(pass_direction, pass_reference, pass_direction, joint.rotor);
        },
        1 => { constrain_hinge(x, y, z, joint.rotation_axis, joint.reference_axis, joint.clockwise, joint.anticlockwise); },
        2 => {
            resolve_local_hinge(chain, index, joint);
            constrain_hinge(x, y, z, constrain_axis, constrain_reference, joint.clockwise, joint.anticlockwise);
        },
        _ => {},
    }
}

fn forward(chain: Chain&, target: f64[3]) {
    let count = chain.bones.len;
    if count == 0 { return; }
    if !is_finite(target[0]) || !is_finite(target[1]) || !is_finite(target[2]) { return; }
    chain.bones[count - 1].end = target;
    var has_reference = false;
    var i = count - 1;
    while i >= 0 {
        let bone .= chain.bones[i];
        var dx = bone.start[0] - bone.end[0];
        var dy = bone.start[1] - bone.end[1];
        var dz = bone.start[2] - bone.end[2];
        let squared = dx * dx + dy * dy + dz * dz;
        if !has_direction(squared) {
            dx = if has_reference { pass_reference[0] } else { UP[0] };
            dy = if has_reference { pass_reference[1] } else { UP[1] };
            dz = if has_reference { pass_reference[2] } else { UP[2] };
        } else {
            let inverse_length = 1 / sqrt(squared);
            dx *= inverse_length; dy *= inverse_length; dz *= inverse_length;
        }
        constrain_forward(chain, i, dx, dy, dz, has_reference);
        dx = pass_direction[0]; dy = pass_direction[1]; dz = pass_direction[2];
        let x = bone.end[0] + dx * bone.length;
        let y = bone.end[1] + dy * bone.length;
        let z = bone.end[2] + dz * bone.length;
        bone.start = [x, y, z];
        if i > 0 { chain.bones[i - 1].end = [x, y, z]; }
        pass_reference = [dx, dy, dz];
        has_reference = true;
        i--;
    }
}

fn backward(chain: Chain&, base: f64[3]) {
    let count = chain.bones.len;
    if count == 0 { return; }
    if !is_finite(base[0]) || !is_finite(base[1]) || !is_finite(base[2]) { return; }
    if chain.fixed_base { chain.bones[0].start = base; }
    var has_reference = false;
    for i in count {
        let bone .= chain.bones[i];
        var dx = bone.end[0] - bone.start[0];
        var dy = bone.end[1] - bone.start[1];
        var dz = bone.end[2] - bone.start[2];
        let squared = dx * dx + dy * dy + dz * dz;
        if !has_direction(squared) {
            dx = if has_reference { pass_reference[0] } else { UP[0] };
            dy = if has_reference { pass_reference[1] } else { UP[1] };
            dz = if has_reference { pass_reference[2] } else { UP[2] };
        } else {
            let inverse_length = 1 / sqrt(squared);
            dx *= inverse_length; dy *= inverse_length; dz *= inverse_length;
        }
        constrain_backward(chain, i, dx, dy, dz, has_reference);
        dx = pass_direction[0]; dy = pass_direction[1]; dz = pass_direction[2];
        if i == 0 && !chain.fixed_base {
            bone.start = [bone.end[0] - dx * bone.length, bone.end[1] - dy * bone.length, bone.end[2] - dz * bone.length];
        }
        let x = bone.start[0] + dx * bone.length;
        let y = bone.start[1] + dy * bone.length;
        let z = bone.start[2] + dz * bone.length;
        bone.end = [x, y, z];
        if i < count - 1 { chain.bones[i + 1].start = [x, y, z]; }
        pass_reference = [dx, dy, dz];
        has_reference = true;
    }
}

fn iterate(chain: Chain&, target: f64[3]) -> f64 {
    if chain.bones.len == 0 { return POSITIVE_INFINITY; }
    forward(chain, target);
    backward(chain, chain.base);
    return distance(chain.bones[chain.bones.len - 1].end, target);
}

fn save_solution(chain: Chain&) {
    for bone, i in chain.bones {
        let offset = i * 6;
        for k in 3 { chain.best_solution[offset + k] = bone.start[k]; chain.best_solution[offset + 3 + k] = bone.end[k]; }
    }
}

fn restore_solution(chain: Chain&) {
    for &bone, i in chain.bones {
        let offset = i * 6;
        for k in 3 { bone.start[k] = chain.best_solution[offset + k]; bone.end[k] = chain.best_solution[offset + 3 + k]; }
    }
}

fn solve(chain: Chain&, target: f64[3]) -> f64 {
    let count = chain.bones.len;
    if count == 0 { chain.solve_distance = POSITIVE_INFINITY; return chain.solve_distance; }
    if chain.best_solution.len < count * 6 {
        chain.best_solution.resize(count * 6, 0.0);
        for &v in chain.best_solution { v = 0.0; }
    }
    var best = POSITIVE_INFINITY;
    var previous = POSITIVE_INFINITY;
    for i in chain.max_iterations {
        let distance = iterate(chain, target);
        if distance < best {
            best = distance;
            save_solution(chain);
            if distance <= chain.solve_distance_threshold { break; }
        } else if abs(distance - previous) < chain.min_iteration_change {
            break;
        }
        previous = distance;
    }
    if best != POSITIVE_INFINITY { restore_solution(chain); }
    chain.solve_distance = best;
    return best;
}

fn main() {
    var bones: Bone[>..] = [];
    var best_solution: f64[>..] = [];
    var chain = Chain {                                     // createChain3
        bones: bones, best_solution: best_solution,
        length: 0.0, base: [0.0, 0.0, 0.0], fixed_base: true,
        basebone_constraint_type: 0, basebone_world_axis: [0.0, 1.0, 0.0], basebone_world_reference_axis: [1.0, 0.0, 0.0],
        basebone_rotor: PI, basebone_clockwise: PI, basebone_anticlockwise: PI,
        max_iterations: DEFAULT_MAX_ITERATIONS, solve_distance_threshold: DEFAULT_SOLVE_DISTANCE_THRESHOLD,
        min_iteration_change: DEFAULT_MIN_ITERATION_CHANGE, solve_distance: POSITIVE_INFINITY,
    };
    add_bone(chain, [0.0, 0.0, 0.0], [0.0, 1.0, 0.0]);
    for i in 1..BONES { add_consecutive_bone(chain, [0.0, 1.0, 0.0], 1); }
    var target = [0.0; 3];
    var step = 0;
    fn advance() -> f64[3] {
        step = (step + 1) % 1000;
        let t = step * 0.001;
        let u = 1 - t;
        target[0] = (t * t - u * u) * BONES * 0.6;
        target[1] = (2 * t * u - 0.3) * BONES * 0.6;
        target[2] = (t - 0.5) * BONES * 0.3;
        return target;
    }
    fn run(out: f64[4]&) {
        var acc = 0.0;
        for i in K { acc += solve(chain, advance()); }
        let effector = chain.bones[BONES - 1].end;
        out[0] = acc;
        out[1] = effector[0];
        out[2] = effector[1];
        out[3] = effector[2];
    }
    var out = [0.0; 4];
    for i in N_WARMUP { run(out); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        run(out);
        t = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(out), K, 1, N_RUNS);
}
