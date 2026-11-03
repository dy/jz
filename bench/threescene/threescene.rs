// threescene.rs – Object3D.updateMatrixWorld over a scene of chains: every
// frame each of ten thousand nodes composes its local matrix from its
// position, quaternion and scale, then multiplies it by its parent's world
// matrix (the previous node, or a root every eighth node), the scene-graph
// kernel.
//
// Ports three.js 0.186.1 (node_modules/three, MIT license, the three.js
// authors) as written: Vector3 (constructor), Euler (constructor, set),
// Quaternion (constructor, setFromEuler with all six rotation orders) and
// Matrix4 (constructor, set, makeRotationY, compose, multiplyMatrices). Each
// class is a struct with its methods in an impl, chained methods returning
// `&mut Self` as three.js returns `this`. A Matrix4's `elements` is a plain JS
// Array of sixteen numbers, so a [f64; 16] in column-major order, as three.js
// stores it. The JavaScript's arrays of class instances are Vecs of structs;
// a node's parent is the previous world matrix, borrowed beside the node's
// own through split_at_mut. Euler.set keeps the current order (the case
// passes none), and the change callbacks three.js fires are its empty
// defaults, so they are left out.
//
// Reports: median ms across N_RUNS, node updates per run, and FNV-1a over the
// last world matrix and the per-frame sum of its x translation at single
// precision (checksumF64Near: the rotations come through sin and cos).
use std::time::Instant;

const N: usize = 10000;
const FRAMES: usize = 20;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

fn mix(h: u32, x: u32) -> u32 {
    (h ^ x).wrapping_mul(0x0100_0193)
}

// checksumF64Near (benchlib.js): every value hashed at single precision.
fn checksum_f64_near(out: &[f64]) -> u32 {
    let mut h = 0x811c_9dc5u32;
    for &x in out {
        h = mix(h, (x as f32).to_bits());
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

struct Vector3 { x: f64, y: f64, z: f64 }

impl Vector3 {
    fn new(x: f64, y: f64, z: f64) -> Self {
        Vector3 { x, y, z }
    }
}

#[allow(dead_code)]
enum EulerOrder { XYZ, YXZ, ZXY, ZYX, YZX, XZY }

struct Euler { x: f64, y: f64, z: f64, order: EulerOrder }

impl Euler {
    fn new(x: f64, y: f64, z: f64) -> Self {
        Euler { x, y, z, order: EulerOrder::XYZ }
    }

    fn set(&mut self, x: f64, y: f64, z: f64) -> &mut Self {
        self.x = x;
        self.y = y;
        self.z = z;
        self
    }
}

struct Quaternion { x: f64, y: f64, z: f64, w: f64 }

impl Quaternion {
    fn new() -> Self {
        Quaternion { x: 0.0, y: 0.0, z: 0.0, w: 1.0 }
    }

    fn set_from_euler(&mut self, euler: &Euler) -> &mut Self {
        let (x, y, z) = (euler.x, euler.y, euler.z);

        let c1 = (x / 2.0).cos();
        let c2 = (y / 2.0).cos();
        let c3 = (z / 2.0).cos();

        let s1 = (x / 2.0).sin();
        let s2 = (y / 2.0).sin();
        let s3 = (z / 2.0).sin();

        match euler.order {
            EulerOrder::XYZ => {
                self.x = s1 * c2 * c3 + c1 * s2 * s3;
                self.y = c1 * s2 * c3 - s1 * c2 * s3;
                self.z = c1 * c2 * s3 + s1 * s2 * c3;
                self.w = c1 * c2 * c3 - s1 * s2 * s3;
            }
            EulerOrder::YXZ => {
                self.x = s1 * c2 * c3 + c1 * s2 * s3;
                self.y = c1 * s2 * c3 - s1 * c2 * s3;
                self.z = c1 * c2 * s3 - s1 * s2 * c3;
                self.w = c1 * c2 * c3 + s1 * s2 * s3;
            }
            EulerOrder::ZXY => {
                self.x = s1 * c2 * c3 - c1 * s2 * s3;
                self.y = c1 * s2 * c3 + s1 * c2 * s3;
                self.z = c1 * c2 * s3 + s1 * s2 * c3;
                self.w = c1 * c2 * c3 - s1 * s2 * s3;
            }
            EulerOrder::ZYX => {
                self.x = s1 * c2 * c3 - c1 * s2 * s3;
                self.y = c1 * s2 * c3 + s1 * c2 * s3;
                self.z = c1 * c2 * s3 - s1 * s2 * c3;
                self.w = c1 * c2 * c3 + s1 * s2 * s3;
            }
            EulerOrder::YZX => {
                self.x = s1 * c2 * c3 + c1 * s2 * s3;
                self.y = c1 * s2 * c3 + s1 * c2 * s3;
                self.z = c1 * c2 * s3 - s1 * s2 * c3;
                self.w = c1 * c2 * c3 - s1 * s2 * s3;
            }
            EulerOrder::XZY => {
                self.x = s1 * c2 * c3 - c1 * s2 * s3;
                self.y = c1 * s2 * c3 - s1 * c2 * s3;
                self.z = c1 * c2 * s3 + s1 * s2 * c3;
                self.w = c1 * c2 * c3 + s1 * s2 * s3;
            }
        }
        self
    }
}

struct Matrix4 { elements: [f64; 16] }

impl Matrix4 {
    fn new() -> Self {
        Matrix4 { elements: [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0] }
    }

    fn set(&mut self, n11: f64, n12: f64, n13: f64, n14: f64, n21: f64, n22: f64, n23: f64, n24: f64,
           n31: f64, n32: f64, n33: f64, n34: f64, n41: f64, n42: f64, n43: f64, n44: f64) -> &mut Self {
        let te = &mut self.elements;

        te[0] = n11; te[4] = n12; te[8] = n13; te[12] = n14;
        te[1] = n21; te[5] = n22; te[9] = n23; te[13] = n24;
        te[2] = n31; te[6] = n32; te[10] = n33; te[14] = n34;
        te[3] = n41; te[7] = n42; te[11] = n43; te[15] = n44;

        self
    }

    fn make_rotation_y(&mut self, theta: f64) -> &mut Self {
        let (c, s) = (theta.cos(), theta.sin());

        self.set(
             c, 0.0, s, 0.0,
             0.0, 1.0, 0.0, 0.0,
            -s, 0.0, c, 0.0,
             0.0, 0.0, 0.0, 1.0,
        );

        self
    }

    fn multiply_matrices(&mut self, a: &Matrix4, b: &Matrix4) -> &mut Self {
        let ae = &a.elements;
        let be = &b.elements;
        let te = &mut self.elements;

        let (a11, a12, a13, a14) = (ae[0], ae[4], ae[8], ae[12]);
        let (a21, a22, a23, a24) = (ae[1], ae[5], ae[9], ae[13]);
        let (a31, a32, a33, a34) = (ae[2], ae[6], ae[10], ae[14]);
        let (a41, a42, a43, a44) = (ae[3], ae[7], ae[11], ae[15]);

        let (b11, b12, b13, b14) = (be[0], be[4], be[8], be[12]);
        let (b21, b22, b23, b24) = (be[1], be[5], be[9], be[13]);
        let (b31, b32, b33, b34) = (be[2], be[6], be[10], be[14]);
        let (b41, b42, b43, b44) = (be[3], be[7], be[11], be[15]);

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

        self
    }

    fn compose(&mut self, position: &Vector3, quaternion: &Quaternion, scale: &Vector3) -> &mut Self {
        let te = &mut self.elements;

        let (x, y, z, w) = (quaternion.x, quaternion.y, quaternion.z, quaternion.w);
        let (x2, y2, z2) = (x + x, y + y, z + z);
        let (xx, xy, xz) = (x * x2, x * y2, x * z2);
        let (yy, yz, zz) = (y * y2, y * z2, z * z2);
        let (wx, wy, wz) = (w * x2, w * y2, w * z2);

        let (sx, sy, sz) = (scale.x, scale.y, scale.z);

        te[0] = (1.0 - (yy + zz)) * sx;
        te[1] = (xy + wz) * sx;
        te[2] = (xz - wy) * sx;
        te[3] = 0.0;

        te[4] = (xy - wz) * sy;
        te[5] = (1.0 - (xx + zz)) * sy;
        te[6] = (yz + wx) * sy;
        te[7] = 0.0;

        te[8] = (xz + wy) * sz;
        te[9] = (yz - wx) * sz;
        te[10] = (1.0 - (xx + yy)) * sz;
        te[11] = 0.0;

        te[12] = position.x;
        te[13] = position.y;
        te[14] = position.z;
        te[15] = 1.0;

        self
    }
}

fn run(out: &mut [f64; 17], pos: &mut [Vector3], quat: &[Quaternion], scl: &[Vector3],
       local: &mut [Matrix4], world: &mut [Matrix4], root: &Matrix4) {
    let mut sum = 0.0;
    for _ in 0..FRAMES {
        for i in 0..N {
            pos[i].x += 0.01;
            local[i].compose(&pos[i], &quat[i], &scl[i]);
            let (prev, rest) = world.split_at_mut(i);
            let parent = if i & 7 == 0 { root } else { &prev[i - 1] };
            rest[0].multiply_matrices(parent, &local[i]);
        }
        sum += world[N - 1].elements[12];
    }
    let m = &world[N - 1].elements;
    out[..16].copy_from_slice(m);
    out[16] = sum;
}

fn main() {
    let mut seed: u32 = 1;
    let mut rnd = || {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        seed as f64 / 4294967296.0
    };

    let mut pos = Vec::new();
    let mut quat = Vec::new();
    let mut scl = Vec::new();
    let mut local = Vec::new();
    let mut world = Vec::new();
    let mut e = Euler::new(0.0, 0.0, 0.0);
    for _ in 0..N {
        pos.push(Vector3::new(rnd() * 100.0 - 50.0, rnd() * 100.0 - 50.0, rnd() * 100.0 - 50.0));
        let mut q = Quaternion::new();
        q.set_from_euler(e.set(rnd() * 6.0, rnd() * 6.0, rnd() * 6.0));
        quat.push(q);
        scl.push(Vector3::new(1.0 + rnd(), 1.0 + rnd(), 1.0 + rnd()));
        local.push(Matrix4::new());
        world.push(Matrix4::new());
    }
    let mut root = Matrix4::new();
    root.make_rotation_y(0.3);

    let mut out = [0.0f64; 17];
    for _ in 0..N_WARMUP {
        run(&mut out, &mut pos, &quat, &scl, &mut local, &mut world, &root);
    }

    let mut samples = [0.0; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        run(&mut out, &mut pos, &quat, &scl, &mut local, &mut world, &root);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let us = median_us(&mut samples);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        us,
        checksum_f64_near(&out),
        N * FRAMES,
        2,
        N_RUNS
    );
}
