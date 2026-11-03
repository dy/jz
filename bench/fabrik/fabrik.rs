// fabrik.rs – FABRIK inverse kinematics of a ten-bone chain chasing a moving
// target, the object-graph kernel.
//
// Ports pmndrs/math (MIT, Copyright (c) 2026 Isaac Mason, bench/_lib/pmath/LICENSE)
// as written: ik/fabrik3.js (createJoint3, createChain3, addBone,
// addConsecutiveBone, getBoneDirection, forward, backward, iterate, solve, and
// the private functions they reach: hasDirection, constrainForward,
// constrainBackward, constrainHinge, projectOntoHinge, rotateAboutAxis,
// resolveLocalHinge, basisFromDirection, orthonormalize, normalizeOr,
// saveSolution, restoreSolution), core/vec3.js (copy, subtract, scaleAndAdd,
// distance, squaredLength, normalize, dot, perpendicular, transformMat3,
// signedAngle, rotateTowards) and core/mat3.js create, each JS module a Rust
// module. The case's joints are unconstrained balls, so the constraint switch
// runs per bone but its hinge and rotor branches, the only trigonometry, are
// never taken.
//
// Layout: a vector, a three-element plain array in the JS, is a [f64; 3], a
// mat3 a [f64; 9]; the joint, bone and chain records are structs, each bone
// holding its own joint (addBone's default createJoint3(), passed explicitly);
// the chain's bones and bestSolution arrays are Vecs grown by push, as the JS
// grows them; the TypeScript enums the JS compiles to numbers are Rust enums.
// Safe Rust has no mutable module state, so the module scratch vectors that
// carry values between functions (_pass_direction, _pass_reference,
// _constrain_axis, _constrain_reference, _constrain_basis) are the fields of a
// Scratch struct the caller passes down by &mut, and the two only one function
// uses (_addConsecutive_end, vec3's _rotateTowards_axis) are locals there. The
// functions keep their out-parameters (the `return out` / `return chain` meant
// for chaining is dropped); where the JS passes one array as both out and
// input, the caller copies the input first, which reads what the JS reads.
//
// Reports: median ms across N_RUNS, throughput in solves/µs, FNV-1a checksum
// (checksumF64) of the four results: its stride of 128 values hashes the low
// word of the first, the sum of the K solve distances.
use std::time::Instant;

const BONES: usize = 10;
const K: usize = 60;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

fn mix(h: u32, x: u32) -> u32 {
    (h ^ x).wrapping_mul(0x0100_0193)
}

// FNV-1a over the low 32 bits of every 128th f64 (matches benchlib checksumF64,
// which strides 256 over the Uint32Array view).
fn checksum_f64(out: &[f64]) -> u32 {
    let mut h = 0x811c_9dc5u32;
    let mut i = 0usize;
    while i < out.len() {
        h = mix(h, out[i].to_bits() as u32);
        i += 128;
    }
    h
}

fn median_us(samples: &mut [f64]) -> u64 {
    for i in 1..samples.len() {
        let v = samples[i];
        let mut j = i;
        while j > 0 && samples[j - 1] > v {
            samples[j] = samples[j - 1];
            j -= 1;
        }
        samples[j] = v;
    }
    (samples[(samples.len() - 1) >> 1] * 1000.0) as u64
}

// pmndrs/math core/vec3
pub mod vec3 {
    pub fn copy(out: &mut [f64; 3], a: &[f64; 3]) {
        out[0] = a[0];
        out[1] = a[1];
        out[2] = a[2];
    }

    pub fn subtract(out: &mut [f64; 3], a: &[f64; 3], b: &[f64; 3]) {
        out[0] = a[0] - b[0];
        out[1] = a[1] - b[1];
        out[2] = a[2] - b[2];
    }

    pub fn scale_and_add(out: &mut [f64; 3], a: &[f64; 3], b: &[f64; 3], scale: f64) {
        out[0] = a[0] + b[0] * scale;
        out[1] = a[1] + b[1] * scale;
        out[2] = a[2] + b[2] * scale;
    }

    pub fn distance(a: &[f64; 3], b: &[f64; 3]) -> f64 {
        let x = b[0] - a[0];
        let y = b[1] - a[1];
        let z = b[2] - a[2];
        (x * x + y * y + z * z).sqrt()
    }

    pub fn squared_length(a: &[f64; 3]) -> f64 {
        let x = a[0];
        let y = a[1];
        let z = a[2];
        x * x + y * y + z * z
    }

    pub fn normalize(out: &mut [f64; 3], a: &[f64; 3]) {
        let x = a[0];
        let y = a[1];
        let z = a[2];
        let mut len = x * x + y * y + z * z;
        if len > 0.0 {
            len = 1.0 / len.sqrt();
        }
        out[0] = a[0] * len;
        out[1] = a[1] * len;
        out[2] = a[2] * len;
    }

    pub fn dot(a: &[f64; 3], b: &[f64; 3]) -> f64 {
        a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    }

    pub fn perpendicular(out: &mut [f64; 3], a: &[f64; 3]) {
        if a[0].abs() > a[1].abs() {
            let len = (a[0] * a[0] + a[2] * a[2]).sqrt();
            let inv_len = 1.0 / len;
            out[0] = a[2] * inv_len;
            out[1] = 0.0;
            out[2] = -a[0] * inv_len;
        } else {
            let len = (a[1] * a[1] + a[2] * a[2]).sqrt();
            if len == 0.0 {
                out[0] = 1.0;
                out[1] = 0.0;
                out[2] = 0.0;
                return;
            }
            let inv_len = 1.0 / len;
            out[0] = 0.0;
            out[1] = a[2] * inv_len;
            out[2] = -a[1] * inv_len;
        }
    }

    pub fn transform_mat3(out: &mut [f64; 3], a: &[f64; 3], m: &[f64; 9]) {
        let x = a[0];
        let y = a[1];
        let z = a[2];
        out[0] = x * m[0] + y * m[3] + z * m[6];
        out[1] = x * m[1] + y * m[4] + z * m[7];
        out[2] = x * m[2] + y * m[5] + z * m[8];
    }

    pub fn signed_angle(a: &[f64; 3], b: &[f64; 3], axis: &[f64; 3]) -> f64 {
        let nx = axis[0];
        let ny = axis[1];
        let nz = axis[2];
        let ad = a[0] * nx + a[1] * ny + a[2] * nz;
        let ax = a[0] - nx * ad;
        let ay = a[1] - ny * ad;
        let az = a[2] - nz * ad;
        let bd = b[0] * nx + b[1] * ny + b[2] * nz;
        let bx = b[0] - nx * bd;
        let by = b[1] - ny * bd;
        let bz = b[2] - nz * bd;
        let cx = ay * bz - az * by;
        let cy = az * bx - ax * bz;
        let cz = ax * by - ay * bx;
        (cx * nx + cy * ny + cz * nz).atan2(ax * bx + ay * by + az * bz)
    }

    pub fn rotate_towards(out: &mut [f64; 3], from: &[f64; 3], to: &[f64; 3], max_angle: f64) {
        let fx = from[0];
        let fy = from[1];
        let fz = from[2];
        let tx = to[0];
        let ty = to[1];
        let tz = to[2];
        // Math.min(Math.max(dot, -1), 1); clamp passes a NaN through as the JS does
        let cosine = (fx * tx + fy * ty + fz * tz).clamp(-1.0, 1.0);
        let limit = if max_angle > 0.0 { max_angle } else { 0.0 };
        if cosine.acos() <= limit {
            out[0] = tx;
            out[1] = ty;
            out[2] = tz;
            return;
        }
        let mut axis_x = fy * tz - fz * ty;
        let mut axis_y = fz * tx - fx * tz;
        let mut axis_z = fx * ty - fy * tx;
        let axis_length = (axis_x * axis_x + axis_y * axis_y + axis_z * axis_z).sqrt();
        if axis_length < 1e-8 {
            let mut axis = [0.0; 3];
            perpendicular(&mut axis, from);
            axis_x = axis[0];
            axis_y = axis[1];
            axis_z = axis[2];
        } else {
            let inverse_length = 1.0 / axis_length;
            axis_x *= inverse_length;
            axis_y *= inverse_length;
            axis_z *= inverse_length;
        }
        let c = limit.cos();
        let s = limit.sin();
        let d = (axis_x * fx + axis_y * fy + axis_z * fz) * (1.0 - c);
        out[0] = fx * c + (axis_y * fz - axis_z * fy) * s + axis_x * d;
        out[1] = fy * c + (axis_z * fx - axis_x * fz) * s + axis_y * d;
        out[2] = fz * c + (axis_x * fy - axis_y * fx) * s + axis_z * d;
    }
}

// pmndrs/math core/mat3
pub mod mat3 {
    pub fn create() -> [f64; 9] {
        [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
    }
}

// pmndrs/math ik/fabrik3
pub mod fabrik3 {
    use super::{mat3, vec3};
    use std::f64::consts::PI;

    #[derive(Clone, Copy, PartialEq)]
    pub enum JointType {
        Ball,
        GlobalHinge,
        LocalHinge,
    }

    #[derive(Clone, Copy, PartialEq)]
    pub enum BaseboneConstraintType {
        None,
        GlobalRotor,
        LocalRotor,
        GlobalHinge,
        LocalHinge,
    }

    const DEFAULT_MAX_ITERATIONS: usize = 20;
    const DEFAULT_SOLVE_DISTANCE_THRESHOLD: f64 = 0.01;
    const DEFAULT_MIN_ITERATION_CHANGE: f64 = 1e-4;
    const DEGENERATE_SQUARED_LENGTH: f64 = 1e-24;

    pub struct Joint3 {
        pub kind: JointType,
        pub rotor: f64,
        pub clockwise: f64,
        pub anticlockwise: f64,
        pub rotation_axis: [f64; 3],
        pub reference_axis: [f64; 3],
    }

    pub struct Bone3 {
        pub start: [f64; 3],
        pub end: [f64; 3],
        pub length: f64,
        pub joint: Joint3,
    }

    pub struct Chain3 {
        pub bones: Vec<Bone3>,
        pub length: f64,
        pub base: [f64; 3],
        pub fixed_base: bool,
        pub basebone_constraint_type: BaseboneConstraintType,
        pub basebone_axis: [f64; 3],
        pub basebone_reference_axis: [f64; 3],
        pub basebone_world_axis: [f64; 3],
        pub basebone_world_reference_axis: [f64; 3],
        pub basebone_rotor: f64,
        pub basebone_clockwise: f64,
        pub basebone_anticlockwise: f64,
        pub embedded_target: [f64; 3],
        pub use_embedded_target: bool,
        pub max_iterations: usize,
        pub solve_distance_threshold: f64,
        pub min_iteration_change: f64,
        pub solve_distance: f64,
        pub best_solution: Vec<f64>,
    }

    // the module's scratch vectors
    pub struct Scratch {
        pass_reference: [f64; 3],
        pass_direction: [f64; 3],
        constrain_axis: [f64; 3],
        constrain_reference: [f64; 3],
        constrain_basis: [f64; 9],
    }

    impl Scratch {
        pub fn new() -> Scratch {
            Scratch {
                pass_reference: [0.0; 3],
                pass_direction: [0.0; 3],
                constrain_axis: [0.0; 3],
                constrain_reference: [0.0; 3],
                constrain_basis: mat3::create(),
            }
        }
    }

    const UP: [f64; 3] = [0.0, 1.0, 0.0];

    fn has_direction(squared_length: f64) -> bool {
        if squared_length.is_nan() {
            return false;
        }
        squared_length >= DEGENERATE_SQUARED_LENGTH
    }

    pub fn create_joint3() -> Joint3 {
        Joint3 {
            kind: JointType::Ball,
            rotor: PI,
            clockwise: PI,
            anticlockwise: PI,
            rotation_axis: [0.0, 0.0, 1.0],
            reference_axis: [1.0, 0.0, 0.0],
        }
    }

    pub fn create_chain3() -> Chain3 {
        Chain3 {
            bones: Vec::new(),
            length: 0.0,
            base: [0.0, 0.0, 0.0],
            fixed_base: true,
            basebone_constraint_type: BaseboneConstraintType::None,
            basebone_axis: [0.0, 1.0, 0.0],
            basebone_reference_axis: [1.0, 0.0, 0.0],
            basebone_world_axis: [0.0, 1.0, 0.0],
            basebone_world_reference_axis: [1.0, 0.0, 0.0],
            basebone_rotor: PI,
            basebone_clockwise: PI,
            basebone_anticlockwise: PI,
            embedded_target: [0.0, 0.0, 0.0],
            use_embedded_target: false,
            max_iterations: DEFAULT_MAX_ITERATIONS,
            solve_distance_threshold: DEFAULT_SOLVE_DISTANCE_THRESHOLD,
            min_iteration_change: DEFAULT_MIN_ITERATION_CHANGE,
            solve_distance: f64::INFINITY,
            best_solution: Vec::new(),
        }
    }

    pub fn add_bone(chain: &mut Chain3, start: &[f64; 3], end: &[f64; 3], joint: Joint3) {
        let bone = Bone3 {
            start: [start[0], start[1], start[2]],
            end: [end[0], end[1], end[2]],
            length: vec3::distance(start, end),
            joint,
        };
        if chain.bones.is_empty() {
            chain.base[0] = start[0];
            chain.base[1] = start[1];
            chain.base[2] = start[2];
        }
        let length = bone.length;
        chain.bones.push(bone);
        chain.length += length;
        chain.best_solution.extend([0.0; 6]);
    }

    pub fn add_consecutive_bone(chain: &mut Chain3, direction: &[f64; 3], length: f64, joint: Joint3) {
        let previous_end = chain.bones[chain.bones.len() - 1].end;
        let end = [
            previous_end[0] + direction[0] * length,
            previous_end[1] + direction[1] * length,
            previous_end[2] + direction[2] * length,
        ];
        add_bone(chain, &previous_end, &end, joint);
    }

    fn orthonormalize(out: &mut [f64; 3], a: &[f64; 3], axis: &[f64; 3]) {
        vec3::scale_and_add(out, a, axis, -vec3::dot(a, axis));
        if !has_direction(vec3::squared_length(out)) {
            vec3::perpendicular(out, axis);
            return;
        }
        let a = *out;
        vec3::normalize(out, &a);
    }

    fn normalize_or(out: &mut [f64; 3], fallback: &[f64; 3]) {
        if !has_direction(vec3::squared_length(out)) {
            vec3::copy(out, fallback);
            return;
        }
        let a = *out;
        vec3::normalize(out, &a);
    }

    pub fn get_bone_direction(out: &mut [f64; 3], chain: &Chain3, index: usize) {
        let bone = &chain.bones[index];
        vec3::subtract(out, &bone.end, &bone.start);
        normalize_or(out, &UP);
    }

    fn project_onto_hinge(out: &mut [f64; 3], x: f64, y: f64, z: f64, axis: &[f64; 3], reference_axis: &[f64; 3]) {
        let d = x * axis[0] + y * axis[1] + z * axis[2];
        out[0] = x - axis[0] * d;
        out[1] = y - axis[1] * d;
        out[2] = z - axis[2] * d;
        if !has_direction(vec3::squared_length(out)) {
            vec3::copy(out, reference_axis);
            return;
        }
        let a = *out;
        vec3::normalize(out, &a);
    }

    fn rotate_about_axis(out: &mut [f64; 3], a: &[f64; 3], axis: &[f64; 3], radians: f64) {
        let ax = a[0];
        let ay = a[1];
        let az = a[2];
        let kx = axis[0];
        let ky = axis[1];
        let kz = axis[2];
        let c = radians.cos();
        let s = radians.sin();
        let d = (kx * ax + ky * ay + kz * az) * (1.0 - c);
        out[0] = ax * c + (ky * az - kz * ay) * s + kx * d;
        out[1] = ay * c + (kz * ax - kx * az) * s + ky * d;
        out[2] = az * c + (kx * ay - ky * ax) * s + kz * d;
    }

    // writes the module's _pass_direction, passed in as `pass_direction`
    fn constrain_hinge(
        pass_direction: &mut [f64; 3],
        x: f64,
        y: f64,
        z: f64,
        axis: &[f64; 3],
        reference_axis: &[f64; 3],
        clockwise: f64,
        anticlockwise: f64,
    ) {
        project_onto_hinge(pass_direction, x, y, z, axis, reference_axis);
        if clockwise >= PI && anticlockwise >= PI {
            return;
        }
        let signed = vec3::signed_angle(reference_axis, pass_direction, axis);
        if signed > anticlockwise {
            rotate_about_axis(pass_direction, reference_axis, axis, anticlockwise);
        } else if signed < -clockwise {
            rotate_about_axis(pass_direction, reference_axis, axis, -clockwise);
        }
    }

    fn basis_from_direction(out: &mut [f64; 9], direction: &[f64; 3]) {
        let x = direction[0];
        let y = direction[1];
        let z = direction[2];
        if z < -0.9999999 {
            out[0] = 0.0;
            out[1] = -1.0;
            out[2] = 0.0;
            out[3] = -1.0;
            out[4] = 0.0;
            out[5] = 0.0;
            out[6] = x;
            out[7] = y;
            out[8] = z;
            return;
        }
        let a = 1.0 / (1.0 + z);
        let b = -x * y * a;
        out[0] = 1.0 - x * x * a;
        out[1] = b;
        out[2] = -x;
        out[3] = b;
        out[4] = 1.0 - y * y * a;
        out[5] = -y;
        out[6] = x;
        out[7] = y;
        out[8] = z;
    }

    fn resolve_local_hinge(chain: &Chain3, index: usize, joint: &Joint3, s: &mut Scratch) {
        get_bone_direction(&mut s.constrain_axis, chain, index - 1);
        basis_from_direction(&mut s.constrain_basis, &s.constrain_axis);
        vec3::transform_mat3(&mut s.constrain_axis, &joint.rotation_axis, &s.constrain_basis);
        let a = s.constrain_axis;
        vec3::normalize(&mut s.constrain_axis, &a);
        vec3::transform_mat3(&mut s.constrain_reference, &joint.reference_axis, &s.constrain_basis);
        let r = s.constrain_reference;
        orthonormalize(&mut s.constrain_reference, &r, &s.constrain_axis);
    }

    fn constrain_forward(chain: &Chain3, index: usize, x: f64, y: f64, z: f64, has_reference: bool, s: &mut Scratch) {
        s.pass_direction[0] = x;
        s.pass_direction[1] = y;
        s.pass_direction[2] = z;
        if index == 0 {
            let kind = chain.basebone_constraint_type;
            if kind == BaseboneConstraintType::GlobalHinge || kind == BaseboneConstraintType::LocalHinge {
                project_onto_hinge(
                    &mut s.pass_direction,
                    x,
                    y,
                    z,
                    &chain.basebone_world_axis,
                    &chain.basebone_world_reference_axis,
                );
                return;
            }
        } else {
            let joint = &chain.bones[index].joint;
            if joint.kind == JointType::GlobalHinge {
                project_onto_hinge(&mut s.pass_direction, x, y, z, &joint.rotation_axis, &joint.reference_axis);
                return;
            }
            if joint.kind == JointType::LocalHinge {
                resolve_local_hinge(chain, index, joint, s);
                project_onto_hinge(&mut s.pass_direction, x, y, z, &s.constrain_axis, &s.constrain_reference);
                return;
            }
        }
        if !has_reference {
            return;
        }
        let outer = &chain.bones[index + 1].joint;
        if outer.kind != JointType::Ball || outer.rotor >= PI {
            return;
        }
        s.pass_direction[0] = x;
        s.pass_direction[1] = y;
        s.pass_direction[2] = z;
        let to = s.pass_direction;
        vec3::rotate_towards(&mut s.pass_direction, &s.pass_reference, &to, outer.rotor);
    }

    fn constrain_backward(chain: &Chain3, index: usize, x: f64, y: f64, z: f64, has_reference: bool, s: &mut Scratch) {
        s.pass_direction[0] = x;
        s.pass_direction[1] = y;
        s.pass_direction[2] = z;
        if index == 0 {
            match chain.basebone_constraint_type {
                BaseboneConstraintType::GlobalRotor | BaseboneConstraintType::LocalRotor => {
                    if chain.basebone_rotor >= PI {
                        return;
                    }
                    let to = s.pass_direction;
                    vec3::rotate_towards(&mut s.pass_direction, &chain.basebone_world_axis, &to, chain.basebone_rotor);
                    return;
                }
                BaseboneConstraintType::GlobalHinge | BaseboneConstraintType::LocalHinge => {
                    constrain_hinge(
                        &mut s.pass_direction,
                        x,
                        y,
                        z,
                        &chain.basebone_world_axis,
                        &chain.basebone_world_reference_axis,
                        chain.basebone_clockwise,
                        chain.basebone_anticlockwise,
                    );
                    return;
                }
                BaseboneConstraintType::None => return,
            }
        }
        let joint = &chain.bones[index].joint;
        match joint.kind {
            JointType::Ball => {
                if !has_reference || joint.rotor >= PI {
                    return;
                }
                let to = s.pass_direction;
                vec3::rotate_towards(&mut s.pass_direction, &s.pass_reference, &to, joint.rotor);
            }
            JointType::GlobalHinge => {
                constrain_hinge(
                    &mut s.pass_direction,
                    x,
                    y,
                    z,
                    &joint.rotation_axis,
                    &joint.reference_axis,
                    joint.clockwise,
                    joint.anticlockwise,
                );
            }
            JointType::LocalHinge => {
                resolve_local_hinge(chain, index, joint, s);
                constrain_hinge(
                    &mut s.pass_direction,
                    x,
                    y,
                    z,
                    &s.constrain_axis,
                    &s.constrain_reference,
                    joint.clockwise,
                    joint.anticlockwise,
                );
            }
        }
    }

    pub fn forward(chain: &mut Chain3, target: &[f64; 3], s: &mut Scratch) {
        let count = chain.bones.len();
        if count == 0 {
            return;
        }
        if !target[0].is_finite() || !target[1].is_finite() || !target[2].is_finite() {
            return;
        }
        let effector = &mut chain.bones[count - 1];
        effector.end[0] = target[0];
        effector.end[1] = target[1];
        effector.end[2] = target[2];
        let mut has_reference = false;
        for i in (0..count).rev() {
            let bone = &chain.bones[i];
            let start = &bone.start;
            let end = &bone.end;
            let mut dx = start[0] - end[0];
            let mut dy = start[1] - end[1];
            let mut dz = start[2] - end[2];
            let squared_length = dx * dx + dy * dy + dz * dz;
            if !has_direction(squared_length) {
                dx = if has_reference { s.pass_reference[0] } else { UP[0] };
                dy = if has_reference { s.pass_reference[1] } else { UP[1] };
                dz = if has_reference { s.pass_reference[2] } else { UP[2] };
            } else {
                let inverse_length = 1.0 / squared_length.sqrt();
                dx *= inverse_length;
                dy *= inverse_length;
                dz *= inverse_length;
            }
            constrain_forward(chain, i, dx, dy, dz, has_reference, s);
            dx = s.pass_direction[0];
            dy = s.pass_direction[1];
            dz = s.pass_direction[2];
            let bone = &mut chain.bones[i];
            let x = bone.end[0] + dx * bone.length;
            let y = bone.end[1] + dy * bone.length;
            let z = bone.end[2] + dz * bone.length;
            bone.start[0] = x;
            bone.start[1] = y;
            bone.start[2] = z;
            if i > 0 {
                let previous_end = &mut chain.bones[i - 1].end;
                previous_end[0] = x;
                previous_end[1] = y;
                previous_end[2] = z;
            }
            s.pass_reference[0] = dx;
            s.pass_reference[1] = dy;
            s.pass_reference[2] = dz;
            has_reference = true;
        }
    }

    pub fn backward(chain: &mut Chain3, base: &[f64; 3], s: &mut Scratch) {
        let count = chain.bones.len();
        if count == 0 {
            return;
        }
        if !base[0].is_finite() || !base[1].is_finite() || !base[2].is_finite() {
            return;
        }
        if chain.fixed_base {
            let start = &mut chain.bones[0].start;
            start[0] = base[0];
            start[1] = base[1];
            start[2] = base[2];
        }
        let mut has_reference = false;
        for i in 0..count {
            let bone = &chain.bones[i];
            let start = &bone.start;
            let end = &bone.end;
            let mut dx = end[0] - start[0];
            let mut dy = end[1] - start[1];
            let mut dz = end[2] - start[2];
            let squared_length = dx * dx + dy * dy + dz * dz;
            if !has_direction(squared_length) {
                dx = if has_reference { s.pass_reference[0] } else { UP[0] };
                dy = if has_reference { s.pass_reference[1] } else { UP[1] };
                dz = if has_reference { s.pass_reference[2] } else { UP[2] };
            } else {
                let inverse_length = 1.0 / squared_length.sqrt();
                dx *= inverse_length;
                dy *= inverse_length;
                dz *= inverse_length;
            }
            constrain_backward(chain, i, dx, dy, dz, has_reference, s);
            dx = s.pass_direction[0];
            dy = s.pass_direction[1];
            dz = s.pass_direction[2];
            let fixed_base = chain.fixed_base;
            let bone = &mut chain.bones[i];
            if i == 0 && !fixed_base {
                bone.start[0] = bone.end[0] - dx * bone.length;
                bone.start[1] = bone.end[1] - dy * bone.length;
                bone.start[2] = bone.end[2] - dz * bone.length;
            }
            let x = bone.start[0] + dx * bone.length;
            let y = bone.start[1] + dy * bone.length;
            let z = bone.start[2] + dz * bone.length;
            bone.end[0] = x;
            bone.end[1] = y;
            bone.end[2] = z;
            if i < count - 1 {
                let next_start = &mut chain.bones[i + 1].start;
                next_start[0] = x;
                next_start[1] = y;
                next_start[2] = z;
            }
            s.pass_reference[0] = dx;
            s.pass_reference[1] = dy;
            s.pass_reference[2] = dz;
            has_reference = true;
        }
    }

    pub fn iterate(chain: &mut Chain3, target: &[f64; 3], s: &mut Scratch) -> f64 {
        if chain.bones.is_empty() {
            return f64::INFINITY;
        }
        forward(chain, target, s);
        let base = chain.base;
        backward(chain, &base, s);
        vec3::distance(&chain.bones[chain.bones.len() - 1].end, target)
    }

    fn save_solution(chain: &mut Chain3) {
        let solution = &mut chain.best_solution;
        for (i, bone) in chain.bones.iter().enumerate() {
            let offset = i * 6;
            solution[offset] = bone.start[0];
            solution[offset + 1] = bone.start[1];
            solution[offset + 2] = bone.start[2];
            solution[offset + 3] = bone.end[0];
            solution[offset + 4] = bone.end[1];
            solution[offset + 5] = bone.end[2];
        }
    }

    fn restore_solution(chain: &mut Chain3) {
        let solution = &chain.best_solution;
        for (i, bone) in chain.bones.iter_mut().enumerate() {
            let offset = i * 6;
            bone.start[0] = solution[offset];
            bone.start[1] = solution[offset + 1];
            bone.start[2] = solution[offset + 2];
            bone.end[0] = solution[offset + 3];
            bone.end[1] = solution[offset + 4];
            bone.end[2] = solution[offset + 5];
        }
    }

    pub fn solve(chain: &mut Chain3, target: &[f64; 3], s: &mut Scratch) -> f64 {
        let count = chain.bones.len();
        if count == 0 {
            chain.solve_distance = f64::INFINITY;
            return chain.solve_distance;
        }
        if chain.best_solution.len() < count * 6 {
            chain.best_solution.resize(count * 6, 0.0);
            chain.best_solution.fill(0.0);
        }
        let mut best = f64::INFINITY;
        let mut previous = f64::INFINITY;
        for _ in 0..chain.max_iterations {
            let distance = iterate(chain, target, s);
            if distance < best {
                best = distance;
                save_solution(chain);
                if distance <= chain.solve_distance_threshold {
                    break;
                }
            } else if (distance - previous).abs() < chain.min_iteration_change {
                break;
            }
            previous = distance;
        }
        if best != f64::INFINITY {
            restore_solution(chain);
        }
        chain.solve_distance = best;
        best
    }
}

// A target wandering the reach: a quadratic pseudo-orbit, no transcendentals.
fn advance(target: &mut [f64; 3], step: &mut i32) {
    *step = (*step + 1) % 1000;
    let t = *step as f64 * 0.001;
    let u = 1.0 - t;
    target[0] = (t * t - u * u) * BONES as f64 * 0.6;
    target[1] = (2.0 * t * u - 0.3) * BONES as f64 * 0.6;
    target[2] = (t - 0.5) * BONES as f64 * 0.3;
}

fn run(out: &mut [f64; 4], chain: &mut fabrik3::Chain3, scratch: &mut fabrik3::Scratch, target: &mut [f64; 3], step: &mut i32) {
    let mut acc = 0.0;
    for _ in 0..K {
        advance(target, step);
        acc += fabrik3::solve(chain, target, scratch);
    }
    let effector = &chain.bones[BONES - 1].end;
    out[0] = acc;
    out[1] = effector[0];
    out[2] = effector[1];
    out[3] = effector[2];
}

fn main() {
    let mut chain = fabrik3::create_chain3();
    fabrik3::add_bone(&mut chain, &[0.0, 0.0, 0.0], &[0.0, 1.0, 0.0], fabrik3::create_joint3());
    for _ in 1..BONES {
        fabrik3::add_consecutive_bone(&mut chain, &[0.0, 1.0, 0.0], 1.0, fabrik3::create_joint3());
    }
    let mut scratch = fabrik3::Scratch::new();
    let mut target = [0.0f64; 3];
    let mut step = 0i32;

    let mut out = [0.0f64; 4];
    for _ in 0..N_WARMUP {
        run(&mut out, &mut chain, &mut scratch, &mut target, &mut step);
    }

    let mut samples = [0.0; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        run(&mut out, &mut chain, &mut scratch, &mut target, &mut step);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let us = median_us(&mut samples);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        us,
        checksum_f64(&out),
        K,
        1,
        N_RUNS
    );
}
