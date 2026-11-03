// threegeom.rs – the buffer-geometry passes over Float32 position buffers:
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
// setFromArray, makeEmpty, expandByPoint, isEmpty, getCenter) and Sphere
// (constructor). Each class is a struct with its methods in an impl, chained
// methods returning `&mut Self` as three.js returns `this`; Box3.js's
// module-scope _vector is a local of setFromArray, and cross copies the
// receiver before crossVectors reads it. The case's module-level buffers and
// objects are one Geometry struct whose methods are the three passes (its Box3
// is `bbox`, `box` being reserved in Rust). Math.min and Math.max meet no NaN
// here, so they are plain comparisons, and normalize's `length() || 1` keeps
// JS truthiness (0 and NaN are falsy). The buffers are Float32Arrays in the
// JavaScript: Vec<f32> here, read into f64 and stored back rounded, as JS
// reads and writes them.
//
// Reports: median ms across N_RUNS, vertices and triangle corners touched per
// run, and FNV-1a over the three passes' sums at single precision
// (checksumF64Near: the transform's rotation comes through sin and cos).
use std::time::Instant;

const VERTS: usize = 100000;
const TRIS: usize = 30000;
const PASSES: usize = 4;
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

// Math.min / Math.max of numbers that are never NaN
fn math_min(a: f64, b: f64) -> f64 {
    if a < b { a } else { b }
}
fn math_max(a: f64, b: f64) -> f64 {
    if a > b { a } else { b }
}

// ── Vector3 ──────────────────────────────────────────────────────────────────

#[derive(Clone, Copy)]
struct Vector3 { x: f64, y: f64, z: f64 }

impl Vector3 {
    fn new(x: f64, y: f64, z: f64) -> Self {
        Vector3 { x, y, z }
    }

    fn set(&mut self, x: f64, y: f64, z: f64) -> &mut Self {
        self.x = x;
        self.y = y;
        self.z = z;
        self
    }

    fn add_vectors(&mut self, a: &Vector3, b: &Vector3) -> &mut Self {
        self.x = a.x + b.x;
        self.y = a.y + b.y;
        self.z = a.z + b.z;
        self
    }

    fn sub_vectors(&mut self, a: &Vector3, b: &Vector3) -> &mut Self {
        self.x = a.x - b.x;
        self.y = a.y - b.y;
        self.z = a.z - b.z;
        self
    }

    fn multiply_scalar(&mut self, scalar: f64) -> &mut Self {
        self.x *= scalar;
        self.y *= scalar;
        self.z *= scalar;
        self
    }

    fn divide_scalar(&mut self, scalar: f64) -> &mut Self {
        self.multiply_scalar(1.0 / scalar)
    }

    fn apply_matrix4(&mut self, m: &Matrix4) -> &mut Self {
        let (x, y, z) = (self.x, self.y, self.z);
        let e = &m.elements;

        let w = 1.0 / (e[3] * x + e[7] * y + e[11] * z + e[15]);

        self.x = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
        self.y = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
        self.z = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;

        self
    }

    fn cross(&mut self, v: &Vector3) -> &mut Self {
        let a = *self;
        self.cross_vectors(&a, v)
    }

    fn cross_vectors(&mut self, a: &Vector3, b: &Vector3) -> &mut Self {
        let (ax, ay, az) = (a.x, a.y, a.z);
        let (bx, by, bz) = (b.x, b.y, b.z);

        self.x = ay * bz - az * by;
        self.y = az * bx - ax * bz;
        self.z = ax * by - ay * bx;

        self
    }

    fn length(&self) -> f64 {
        (self.x * self.x + self.y * self.y + self.z * self.z).sqrt()
    }

    fn normalize(&mut self) -> &mut Self {
        let l = self.length();
        self.divide_scalar(if l != 0.0 && !l.is_nan() { l } else { 1.0 })
    }

    fn distance_to_squared(&self, v: &Vector3) -> f64 {
        let (dx, dy, dz) = (self.x - v.x, self.y - v.y, self.z - v.z);
        dx * dx + dy * dy + dz * dz
    }

    fn min(&mut self, v: &Vector3) -> &mut Self {
        self.x = math_min(self.x, v.x);
        self.y = math_min(self.y, v.y);
        self.z = math_min(self.z, v.z);
        self
    }

    fn max(&mut self, v: &Vector3) -> &mut Self {
        self.x = math_max(self.x, v.x);
        self.y = math_max(self.y, v.y);
        self.z = math_max(self.z, v.z);
        self
    }

    fn from_array(&mut self, array: &[f32], offset: usize) -> &mut Self {
        self.x = array[offset] as f64;
        self.y = array[offset + 1] as f64;
        self.z = array[offset + 2] as f64;
        self
    }

    fn to_array<'a>(&self, array: &'a mut [f32], offset: usize) -> &'a mut [f32] {
        array[offset] = self.x as f32;
        array[offset + 1] = self.y as f32;
        array[offset + 2] = self.z as f32;
        array
    }
}

// ── Euler, Matrix4 ───────────────────────────────────────────────────────────

#[allow(dead_code)]
#[derive(PartialEq)]
enum EulerOrder { XYZ, YXZ, ZXY, ZYX, YZX, XZY }

struct Euler { x: f64, y: f64, z: f64, order: EulerOrder }

impl Euler {
    fn new(x: f64, y: f64, z: f64) -> Self {
        Euler { x, y, z, order: EulerOrder::XYZ }
    }
}

struct Matrix4 { elements: [f64; 16] }

impl Matrix4 {
    fn new() -> Self {
        Matrix4 { elements: [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0] }
    }

    fn make_rotation_from_euler(&mut self, euler: &Euler) -> &mut Self {
        let te = &mut self.elements;

        let (x, y, z) = (euler.x, euler.y, euler.z);
        let (a, b) = (x.cos(), x.sin());
        let (c, d) = (y.cos(), y.sin());
        let (e, f) = (z.cos(), z.sin());

        if euler.order == EulerOrder::XYZ {
            let (ae, af, be, bf) = (a * e, a * f, b * e, b * f);

            te[0] = c * e;
            te[4] = -c * f;
            te[8] = d;

            te[1] = af + be * d;
            te[5] = ae - bf * d;
            te[9] = -b * c;

            te[2] = bf - ae * d;
            te[6] = be + af * d;
            te[10] = a * c;
        } else if euler.order == EulerOrder::YXZ {
            let (ce, cf, de, df) = (c * e, c * f, d * e, d * f);

            te[0] = ce + df * b;
            te[4] = de * b - cf;
            te[8] = a * d;

            te[1] = a * f;
            te[5] = a * e;
            te[9] = -b;

            te[2] = cf * b - de;
            te[6] = df + ce * b;
            te[10] = a * c;
        } else if euler.order == EulerOrder::ZXY {
            let (ce, cf, de, df) = (c * e, c * f, d * e, d * f);

            te[0] = ce - df * b;
            te[4] = -a * f;
            te[8] = de + cf * b;

            te[1] = cf + de * b;
            te[5] = a * e;
            te[9] = df - ce * b;

            te[2] = -a * d;
            te[6] = b;
            te[10] = a * c;
        } else if euler.order == EulerOrder::ZYX {
            let (ae, af, be, bf) = (a * e, a * f, b * e, b * f);

            te[0] = c * e;
            te[4] = be * d - af;
            te[8] = ae * d + bf;

            te[1] = c * f;
            te[5] = bf * d + ae;
            te[9] = af * d - be;

            te[2] = -d;
            te[6] = b * c;
            te[10] = a * c;
        } else if euler.order == EulerOrder::YZX {
            let (ac, ad, bc, bd) = (a * c, a * d, b * c, b * d);

            te[0] = c * e;
            te[4] = bd - ac * f;
            te[8] = bc * f + ad;

            te[1] = f;
            te[5] = a * e;
            te[9] = -b * e;

            te[2] = -d * e;
            te[6] = ad * f + bc;
            te[10] = ac - bd * f;
        } else if euler.order == EulerOrder::XZY {
            let (ac, ad, bc, bd) = (a * c, a * d, b * c, b * d);

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
        te[3] = 0.0;
        te[7] = 0.0;
        te[11] = 0.0;

        // last column
        te[12] = 0.0;
        te[13] = 0.0;
        te[14] = 0.0;
        te[15] = 1.0;

        self
    }

    fn set_position(&mut self, x: f64, y: f64, z: f64) -> &mut Self {
        let te = &mut self.elements;

        te[12] = x;
        te[13] = y;
        te[14] = z;

        self
    }
}

// ── Box3, Sphere ─────────────────────────────────────────────────────────────

struct Box3 { min: Vector3, max: Vector3 }

impl Box3 {
    fn new() -> Self {
        Box3 {
            min: Vector3::new(f64::INFINITY, f64::INFINITY, f64::INFINITY),
            max: Vector3::new(-f64::INFINITY, -f64::INFINITY, -f64::INFINITY),
        }
    }

    fn set_from_array(&mut self, array: &[f32]) -> &mut Self {
        let mut vector = Vector3::new(0.0, 0.0, 0.0); // Box3.js's module-scope _vector

        self.make_empty();

        let il = array.len();
        let mut i = 0;
        while i < il {
            self.expand_by_point(vector.from_array(array, i));
            i += 3;
        }

        self
    }

    fn make_empty(&mut self) -> &mut Self {
        self.min.x = f64::INFINITY;
        self.min.y = f64::INFINITY;
        self.min.z = f64::INFINITY;
        self.max.x = -f64::INFINITY;
        self.max.y = -f64::INFINITY;
        self.max.z = -f64::INFINITY;
        self
    }

    fn is_empty(&self) -> bool {
        (self.max.x < self.min.x) || (self.max.y < self.min.y) || (self.max.z < self.min.z)
    }

    fn get_center<'a>(&self, target: &'a mut Vector3) -> &'a mut Vector3 {
        if self.is_empty() {
            target.set(0.0, 0.0, 0.0)
        } else {
            target.add_vectors(&self.min, &self.max).multiply_scalar(0.5)
        }
    }

    fn expand_by_point(&mut self, point: &Vector3) -> &mut Self {
        self.min.min(point);
        self.max.max(point);
        self
    }
}

struct Sphere { center: Vector3, radius: f64 }

impl Sphere {
    fn new(center: Vector3, radius: f64) -> Self {
        Sphere { center, radius }
    }
}

// ── the case ─────────────────────────────────────────────────────────────────

fn rnd(seed: &mut u32) -> f64 {
    *seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
    *seed as f64 / 4294967296.0
}

// The case's module-level buffers and objects.
struct Geometry {
    tp: Vec<f32>,
    m: Matrix4,
    v: Vector3,

    bp: Vec<f32>,
    bbox: Box3,
    sph: Sphere,
    w: Vector3,

    np: Vec<f32>,
    no: Vec<f32>,
    p_a: Vector3,
    p_b: Vector3,
    p_c: Vector3,
    cb: Vector3,
    ab: Vector3,
}

impl Geometry {
    // BufferAttribute.applyMatrix4
    fn transform_positions(&mut self) -> f64 {
        for _ in 0..PASSES {
            for i in 0..VERTS {
                self.v.from_array(&self.tp, i * 3).apply_matrix4(&self.m).to_array(&mut self.tp, i * 3);
            }
        }
        let mut s = 0.0;
        for &x in &self.tp {
            s += x as f64;
        }
        s
    }

    // BufferGeometry.computeBoundingBox + computeBoundingSphere
    fn bounds(&mut self) -> f64 {
        let mut s = 0.0;
        for k in 0..PASSES {
            self.bbox.set_from_array(&self.bp);
            self.bbox.get_center(&mut self.sph.center);
            let mut max_r = 0.0;
            for i in 0..VERTS {
                max_r = math_max(max_r, self.sph.center.distance_to_squared(self.w.from_array(&self.bp, i * 3)));
            }
            self.sph.radius = max_r.sqrt();
            s += self.sph.radius + self.bbox.max.x;
            let j = k % self.bp.len();
            self.bp[j] = (self.bp[j] as f64 + 0.001) as f32;
        }
        s
    }

    // BufferGeometry.computeVertexNormals (non-indexed) + normalizeNormals
    fn normals(&mut self) -> f64 {
        let mut s = 0.0;
        for k in 0..PASSES {
            for i in 0..TRIS {
                self.p_a.from_array(&self.np, i * 9);
                self.p_b.from_array(&self.np, i * 9 + 3);
                self.p_c.from_array(&self.np, i * 9 + 6);
                self.cb.sub_vectors(&self.p_c, &self.p_b);
                self.ab.sub_vectors(&self.p_a, &self.p_b);
                self.cb.cross(&self.ab);
                self.cb.to_array(&mut self.no, i * 9);
                self.cb.to_array(&mut self.no, i * 9 + 3);
                self.cb.to_array(&mut self.no, i * 9 + 6);
            }
            for i in 0..TRIS * 3 {
                self.cb.from_array(&self.no, i * 3).normalize().to_array(&mut self.no, i * 3);
            }
            s += self.no[(k * 3) % self.no.len()] as f64;
            let j = k % self.np.len();
            self.np[j] = (self.np[j] as f64 + 0.001) as f32;
        }
        s
    }

    fn run(&mut self, out: &mut [f64; 3]) {
        out[0] = self.transform_positions();
        out[1] = self.bounds();
        out[2] = self.normals();
    }
}

fn main() {
    let mut seed: u32 = 2;
    let mut tp = vec![0.0f32; VERTS * 3];
    for x in tp.iter_mut() {
        *x = (rnd(&mut seed) * 2.0 - 1.0) as f32;
    }
    let mut m = Matrix4::new();
    m.make_rotation_from_euler(&Euler::new(0.1, 0.2, 0.3)).set_position(0.01, 0.02, 0.03);

    seed = 6;
    let mut bp = vec![0.0f32; VERTS * 3];
    for x in bp.iter_mut() {
        *x = (rnd(&mut seed) * 2.0 - 1.0) as f32;
    }

    seed = 7;
    let mut np = vec![0.0f32; TRIS * 9];
    for x in np.iter_mut() {
        *x = (rnd(&mut seed) * 2.0 - 1.0) as f32;
    }

    let mut g = Geometry {
        tp,
        m,
        v: Vector3::new(0.0, 0.0, 0.0),
        bp,
        bbox: Box3::new(),
        sph: Sphere::new(Vector3::new(0.0, 0.0, 0.0), -1.0),
        w: Vector3::new(0.0, 0.0, 0.0),
        np,
        no: vec![0.0f32; TRIS * 9],
        p_a: Vector3::new(0.0, 0.0, 0.0),
        p_b: Vector3::new(0.0, 0.0, 0.0),
        p_c: Vector3::new(0.0, 0.0, 0.0),
        cb: Vector3::new(0.0, 0.0, 0.0),
        ab: Vector3::new(0.0, 0.0, 0.0),
    };

    let mut out = [0.0f64; 3];
    for _ in 0..N_WARMUP {
        g.run(&mut out);
    }

    let mut samples = [0.0; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        g.run(&mut out);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let us = median_us(&mut samples);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        us,
        checksum_f64_near(&out),
        (VERTS * 2 + TRIS * 4) * PASSES,
        3,
        N_RUNS
    );
}
