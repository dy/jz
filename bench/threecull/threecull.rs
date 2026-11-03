// threecull.rs – the visibility queries of a frame: WebGLRenderer.projectObject's
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
// degenerate-axis fallbacks, setPosition from a Vector3, invert,
// multiplyMatrices), Plane (constructor, setComponents, normalize,
// distanceToPoint), Frustum (constructor, setFromProjectionMatrix with its
// coordinate-system and reversed-depth branches, intersectsSphere), Sphere
// (constructor) and Ray (constructor, at, the watertight intersectTriangle).
// Each class is a struct with its methods in an impl, chained methods
// returning `&mut Self` as three.js returns `this`; intersectTriangle returns
// Option<&mut Vector3>, None where three.js returns null and the target
// where it returns the target. Matrix4.js's module-scope _x, _y, _z are
// locals of lookAt; the case's module-level objects and buffer are one Scene
// struct whose methods are the two queries, its spheres a Vec of structs and
// its frustum's planes an array of six. The coordinate system is an enum of
// three.js's two constants, matched exhaustively, so the throw on any other
// value cannot arise and is left out. normalize's `length() || 1` keeps JS
// truthiness (0 and NaN are falsy). The triangle buffer is a Float32Array in
// the JavaScript: a Vec<f32> here, read into f64.
//
// Reports: median ms across N_RUNS, sphere tests and triangle tests per run,
// and FNV-1a over the visible count, the hit count and the sum of the hits'
// z at single precision (checksumF64Near: the orbit comes through sin and cos).
use std::time::Instant;

const SPHERES: usize = 10000;
const ORBIT: usize = 40;
const TRIANGLES: usize = 20000;
const RAYS: usize = 10;
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

#[allow(dead_code)]
enum CoordinateSystem { WebGL, WebGPU }

// ── Vector3 ──────────────────────────────────────────────────────────────────

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

    fn copy(&mut self, v: &Vector3) -> &mut Self {
        self.x = v.x;
        self.y = v.y;
        self.z = v.z;
        self
    }

    fn add_scaled_vector(&mut self, v: &Vector3, s: f64) -> &mut Self {
        self.x += v.x * s;
        self.y += v.y * s;
        self.z += v.z * s;
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

    fn cross_vectors(&mut self, a: &Vector3, b: &Vector3) -> &mut Self {
        let (ax, ay, az) = (a.x, a.y, a.z);
        let (bx, by, bz) = (b.x, b.y, b.z);

        self.x = ay * bz - az * by;
        self.y = az * bx - ax * bz;
        self.z = ax * by - ay * bx;

        self
    }

    fn dot(&self, v: &Vector3) -> f64 {
        self.x * v.x + self.y * v.y + self.z * v.z
    }

    fn length_sq(&self) -> f64 {
        self.x * self.x + self.y * self.y + self.z * self.z
    }

    fn length(&self) -> f64 {
        (self.x * self.x + self.y * self.y + self.z * self.z).sqrt()
    }

    fn normalize(&mut self) -> &mut Self {
        let l = self.length();
        self.divide_scalar(if l != 0.0 && !l.is_nan() { l } else { 1.0 })
    }

    fn from_array(&mut self, array: &[f32], offset: usize) -> &mut Self {
        self.x = array[offset] as f64;
        self.y = array[offset + 1] as f64;
        self.z = array[offset + 2] as f64;
        self
    }
}

// ── Matrix4 ──────────────────────────────────────────────────────────────────

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

    fn make_perspective(&mut self, left: f64, right: f64, top: f64, bottom: f64, near: f64, far: f64,
                        coordinate_system: CoordinateSystem, reversed_depth: bool) -> &mut Self {
        let te = &mut self.elements;

        let x = 2.0 * near / (right - left);
        let y = 2.0 * near / (top - bottom);

        let a = (right + left) / (right - left);
        let b = (top + bottom) / (top - bottom);

        let (c, d);

        if reversed_depth {
            c = near / (far - near);
            d = (far * near) / (far - near);
        } else {
            match coordinate_system {
                CoordinateSystem::WebGL => {
                    c = -(far + near) / (far - near);
                    d = (-2.0 * far * near) / (far - near);
                }
                CoordinateSystem::WebGPU => {
                    c = -far / (far - near);
                    d = (-far * near) / (far - near);
                }
            }
        }

        te[0] = x;   te[4] = 0.0; te[8] = a;     te[12] = 0.0;
        te[1] = 0.0; te[5] = y;   te[9] = b;     te[13] = 0.0;
        te[2] = 0.0; te[6] = 0.0; te[10] = c;    te[14] = d;
        te[3] = 0.0; te[7] = 0.0; te[11] = -1.0; te[15] = 0.0;

        self
    }

    fn look_at(&mut self, eye: &Vector3, target: &Vector3, up: &Vector3) -> &mut Self {
        // Matrix4.js's module-scope _x, _y, _z
        let mut x = Vector3::new(0.0, 0.0, 0.0);
        let mut y = Vector3::new(0.0, 0.0, 0.0);
        let mut z = Vector3::new(0.0, 0.0, 0.0);

        let te = &mut self.elements;

        z.sub_vectors(eye, target);

        if z.length_sq() == 0.0 {
            // eye and target are in the same position
            z.z = 1.0;
        }

        z.normalize();
        x.cross_vectors(up, &z);

        if x.length_sq() == 0.0 {
            // up and z are parallel
            if up.z.abs() == 1.0 {
                z.x += 0.0001;
            } else {
                z.z += 0.0001;
            }

            z.normalize();
            x.cross_vectors(up, &z);
        }

        x.normalize();
        y.cross_vectors(&z, &x);

        te[0] = x.x; te[4] = y.x; te[8] = z.x;
        te[1] = x.y; te[5] = y.y; te[9] = z.y;
        te[2] = x.z; te[6] = y.z; te[10] = z.z;

        self
    }

    fn set_position(&mut self, x: &Vector3) -> &mut Self {
        let te = &mut self.elements;

        te[12] = x.x;
        te[13] = x.y;
        te[14] = x.z;

        self
    }

    fn invert(&mut self) -> &mut Self {
        // based on https://github.com/toji/gl-matrix
        let te = &mut self.elements;

        let (n11, n21, n31, n41) = (te[0], te[1], te[2], te[3]);
        let (n12, n22, n32, n42) = (te[4], te[5], te[6], te[7]);
        let (n13, n23, n33, n43) = (te[8], te[9], te[10], te[11]);
        let (n14, n24, n34, n44) = (te[12], te[13], te[14], te[15]);

        let t1 = n11 * n22 - n21 * n12;
        let t2 = n11 * n32 - n31 * n12;
        let t3 = n11 * n42 - n41 * n12;
        let t4 = n21 * n32 - n31 * n22;
        let t5 = n21 * n42 - n41 * n22;
        let t6 = n31 * n42 - n41 * n32;
        let t7 = n13 * n24 - n23 * n14;
        let t8 = n13 * n34 - n33 * n14;
        let t9 = n13 * n44 - n43 * n14;
        let t10 = n23 * n34 - n33 * n24;
        let t11 = n23 * n44 - n43 * n24;
        let t12 = n33 * n44 - n43 * n34;

        let det = t1 * t12 - t2 * t11 + t3 * t10 + t4 * t9 - t5 * t8 + t6 * t7;

        if det == 0.0 {
            return self.set(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        }

        let det_inv = 1.0 / det;

        te[0] = (n22 * t12 - n32 * t11 + n42 * t10) * det_inv;
        te[1] = (n31 * t11 - n21 * t12 - n41 * t10) * det_inv;
        te[2] = (n24 * t6 - n34 * t5 + n44 * t4) * det_inv;
        te[3] = (n33 * t5 - n23 * t6 - n43 * t4) * det_inv;

        te[4] = (n32 * t9 - n12 * t12 - n42 * t8) * det_inv;
        te[5] = (n11 * t12 - n31 * t9 + n41 * t8) * det_inv;
        te[6] = (n34 * t3 - n14 * t6 - n44 * t2) * det_inv;
        te[7] = (n13 * t6 - n33 * t3 + n43 * t2) * det_inv;

        te[8] = (n12 * t11 - n22 * t9 + n42 * t7) * det_inv;
        te[9] = (n21 * t9 - n11 * t11 - n41 * t7) * det_inv;
        te[10] = (n14 * t5 - n24 * t3 + n44 * t1) * det_inv;
        te[11] = (n23 * t3 - n13 * t5 - n43 * t1) * det_inv;

        te[12] = (n22 * t8 - n12 * t10 - n32 * t7) * det_inv;
        te[13] = (n11 * t10 - n21 * t8 + n31 * t7) * det_inv;
        te[14] = (n24 * t2 - n14 * t4 - n34 * t1) * det_inv;
        te[15] = (n13 * t4 - n23 * t2 + n33 * t1) * det_inv;

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
}

// ── Plane, Frustum, Sphere, Ray ──────────────────────────────────────────────

struct Plane { normal: Vector3, constant: f64 }

impl Plane {
    fn new() -> Self {
        Plane { normal: Vector3::new(1.0, 0.0, 0.0), constant: 0.0 }
    }

    fn set_components(&mut self, x: f64, y: f64, z: f64, w: f64) -> &mut Self {
        self.normal.set(x, y, z);
        self.constant = w;
        self
    }

    fn normalize(&mut self) -> &mut Self {
        // Note: will lead to a divide by zero if the plane is invalid.
        let inverse_normal_length = 1.0 / self.normal.length();
        self.normal.multiply_scalar(inverse_normal_length);
        self.constant *= inverse_normal_length;
        self
    }

    fn distance_to_point(&self, point: &Vector3) -> f64 {
        self.normal.dot(point) + self.constant
    }
}

struct Frustum { planes: [Plane; 6] }

impl Frustum {
    fn new() -> Self {
        Frustum { planes: [Plane::new(), Plane::new(), Plane::new(), Plane::new(), Plane::new(), Plane::new()] }
    }

    fn set_from_projection_matrix(&mut self, m: &Matrix4, coordinate_system: CoordinateSystem,
                                  reversed_depth: bool) -> &mut Self {
        let planes = &mut self.planes;
        let me = &m.elements;
        let (me0, me1, me2, me3) = (me[0], me[1], me[2], me[3]);
        let (me4, me5, me6, me7) = (me[4], me[5], me[6], me[7]);
        let (me8, me9, me10, me11) = (me[8], me[9], me[10], me[11]);
        let (me12, me13, me14, me15) = (me[12], me[13], me[14], me[15]);

        planes[0].set_components(me3 - me0, me7 - me4, me11 - me8, me15 - me12).normalize();
        planes[1].set_components(me3 + me0, me7 + me4, me11 + me8, me15 + me12).normalize();
        planes[2].set_components(me3 + me1, me7 + me5, me11 + me9, me15 + me13).normalize();
        planes[3].set_components(me3 - me1, me7 - me5, me11 - me9, me15 - me13).normalize();

        if reversed_depth {
            planes[4].set_components(me2, me6, me10, me14).normalize(); // far
            planes[5].set_components(me3 - me2, me7 - me6, me11 - me10, me15 - me14).normalize(); // near
        } else {
            planes[4].set_components(me3 - me2, me7 - me6, me11 - me10, me15 - me14).normalize(); // far

            match coordinate_system {
                CoordinateSystem::WebGL => {
                    planes[5].set_components(me3 + me2, me7 + me6, me11 + me10, me15 + me14).normalize(); // near
                }
                CoordinateSystem::WebGPU => {
                    planes[5].set_components(me2, me6, me10, me14).normalize(); // near
                }
            }
        }

        self
    }

    fn intersects_sphere(&self, sphere: &Sphere) -> bool {
        let center = &sphere.center;
        let neg_radius = -sphere.radius;

        for plane in &self.planes {
            let distance = plane.distance_to_point(center);

            if distance < neg_radius {
                return false;
            }
        }

        true
    }
}

struct Sphere { center: Vector3, radius: f64 }

impl Sphere {
    fn new(center: Vector3, radius: f64) -> Self {
        Sphere { center, radius }
    }
}

struct Ray { origin: Vector3, direction: Vector3 }

impl Ray {
    fn new() -> Self {
        Ray { origin: Vector3::new(0.0, 0.0, 0.0), direction: Vector3::new(0.0, 0.0, -1.0) }
    }

    fn at<'a>(&self, t: f64, target: &'a mut Vector3) -> &'a mut Vector3 {
        target.copy(&self.origin).add_scaled_vector(&self.direction, t)
    }

    fn intersect_triangle<'a>(&self, a: &Vector3, b: &Vector3, c: &Vector3, backface_culling: bool,
                              target: &'a mut Vector3) -> Option<&'a mut Vector3> {
        // Watertight ray/triangle intersection. Reference: Woop, Benthin, Wald,
        // "Watertight Ray/Triangle Intersection", JCGT vol. 2 no. 1 (2013), Appendix A.
        // https://jcgt.org/published/0002/01/05/

        let origin = &self.origin;
        let direction = &self.direction;

        let dx = direction.x;
        let dy = direction.y;
        let dz = direction.z;

        // triangle vertices relative to the ray origin

        let (aox, aoy, aoz) = (a.x - origin.x, a.y - origin.y, a.z - origin.z);
        let (box_, boy, boz) = (b.x - origin.x, b.y - origin.y, b.z - origin.z);
        let (cox, coy, coz) = (c.x - origin.x, c.y - origin.y, c.z - origin.z);

        // Use the dimension where the ray direction is maximal as the projection
        // axis (kz) and read every component already permuted into (kx, ky, kz).
        // kx and ky are swapped when the direction's kz component is negative, to
        // preserve the winding order of triangles.

        let (adx, ady, adz) = (dx.abs(), dy.abs(), dz.abs());

        let (dkx, dky, dkz);
        let (akx, aky, akz, bkx, bky, bkz, ckx, cky, ckz);

        if adx >= ady && adx >= adz {
            dkz = dx; akz = aox; bkz = box_; ckz = cox;

            if dx >= 0.0 {
                dkx = dy; dky = dz;
                akx = aoy; aky = aoz; bkx = boy; bky = boz; ckx = coy; cky = coz;
            } else {
                dkx = dz; dky = dy;
                akx = aoz; aky = aoy; bkx = boz; bky = boy; ckx = coz; cky = coy;
            }
        } else if ady >= adz {
            dkz = dy; akz = aoy; bkz = boy; ckz = coy;

            if dy >= 0.0 {
                dkx = dz; dky = dx;
                akx = aoz; aky = aox; bkx = boz; bky = box_; ckx = coz; cky = cox;
            } else {
                dkx = dx; dky = dz;
                akx = aox; aky = aoz; bkx = box_; bky = boz; ckx = cox; cky = coz;
            }
        } else {
            dkz = dz; akz = aoz; bkz = boz; ckz = coz;

            if dz >= 0.0 {
                dkx = dx; dky = dy;
                akx = aox; aky = aoy; bkx = box_; bky = boy; ckx = cox; cky = coy;
            } else {
                dkx = dy; dky = dx;
                akx = aoy; aky = aox; bkx = boy; bky = box_; ckx = coy; cky = cox;
            }
        }

        // a zero direction has no maximal axis and cannot intersect

        if dkz == 0.0 {
            return None;
        }

        // shear constants that align the ray with the +kz axis

        let (sx, sy, sz) = (dkx / dkz, dky / dkz, 1.0 / dkz);

        // sheared and scaled vertices

        let (ax, ay) = (akx - sx * akz, aky - sy * akz);
        let (bx, by) = (bkx - sx * bkz, bky - sy * bkz);
        let (cx, cy) = (ckx - sx * ckz, cky - sy * ckz);

        // scaled barycentric coordinates (signed edge functions); the shear makes a
        // shared edge evaluate identically for both adjacent triangles, so the ray
        // can never fall between them

        let u = cx * by - cy * bx;
        let v = ax * cy - ay * cx;
        let w = bx * ay - by * ax;

        if backface_culling {
            if u < 0.0 || v < 0.0 || w < 0.0 {
                return None;
            }
        } else if (u < 0.0 || v < 0.0 || w < 0.0) && (u > 0.0 || v > 0.0 || w > 0.0) {
            return None;
        }

        let det = u + v + w;

        // ray is co-planar with the triangle

        if det == 0.0 {
            return None;
        }

        // scaled hit distance; t = tScaled / det must lie in front of the origin

        let t_scaled = sz * (u * akz + v * bkz + w * ckz);

        if if det > 0.0 { t_scaled < 0.0 } else { t_scaled > 0.0 } {
            return None;
        }

        Some(self.at(t_scaled / det, target))
    }
}

// ── the case ─────────────────────────────────────────────────────────────────

fn rnd(seed: &mut u32) -> f64 {
    *seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
    *seed as f64 / 4294967296.0
}

// The case's module-level objects and buffer, and its PRNG state.
struct Scene {
    seed: u32,

    spheres: Vec<Sphere>,
    proj: Matrix4,
    view: Matrix4,
    pv: Matrix4,
    fr: Frustum,
    eye: Vector3,
    target: Vector3,
    up: Vector3,

    p: Vec<f32>,
    ray: Ray,
    a: Vector3,
    b: Vector3,
    c: Vector3,
    hit: Vector3,
}

impl Scene {
    // WebGLRenderer.projectObject
    fn cull(&mut self) -> u32 {
        let mut visible = 0;
        for k in 0..ORBIT {
            self.eye.set((k as f64 * 0.01).sin() * 50.0, 10.0, (k as f64 * 0.01).cos() * 50.0);
            self.view.look_at(&self.eye, &self.target, &self.up).set_position(&self.eye).invert();
            self.pv.multiply_matrices(&self.proj, &self.view);
            self.fr.set_from_projection_matrix(&self.pv, CoordinateSystem::WebGL, false);
            for i in 0..SPHERES {
                if self.fr.intersects_sphere(&self.spheres[i]) {
                    visible += 1;
                }
            }
        }
        visible
    }

    // Mesh.raycast
    fn raycast(&mut self, out: &mut [f64; 3]) {
        self.seed = 5;
        let mut hits = 0u32;
        let mut acc = 0.0;
        for _ in 0..RAYS {
            self.ray.origin.set(0.0, 0.0, -30.0);
            self.ray.direction.set(rnd(&mut self.seed) - 0.5, rnd(&mut self.seed) - 0.5, 1.0).normalize();
            for i in 0..TRIANGLES {
                self.a.from_array(&self.p, i * 9);
                self.b.from_array(&self.p, i * 9 + 3);
                self.c.from_array(&self.p, i * 9 + 6);
                if self.ray.intersect_triangle(&self.a, &self.b, &self.c, false, &mut self.hit).is_some() {
                    hits += 1;
                    acc += self.hit.z;
                }
            }
        }
        out[1] = hits as f64;
        out[2] = acc;
    }

    fn run(&mut self, out: &mut [f64; 3]) {
        out[0] = self.cull() as f64;
        self.raycast(out);
    }
}

fn main() {
    let mut seed: u32 = 3;
    let mut spheres = Vec::new();
    for _ in 0..SPHERES {
        spheres.push(Sphere::new(
            Vector3::new(rnd(&mut seed) * 200.0 - 100.0, rnd(&mut seed) * 200.0 - 100.0, rnd(&mut seed) * 200.0 - 100.0),
            rnd(&mut seed) * 5.0,
        ));
    }
    let mut proj = Matrix4::new();
    proj.make_perspective(-1.0, 1.0, 1.0, -1.0, 1.0, 100.0, CoordinateSystem::WebGL, false);

    seed = 4;
    let mut p = vec![0.0f32; TRIANGLES * 9];
    for x in p.iter_mut() {
        *x = (rnd(&mut seed) * 20.0 - 10.0) as f32;
    }

    let mut scene = Scene {
        seed,
        spheres,
        proj,
        view: Matrix4::new(),
        pv: Matrix4::new(),
        fr: Frustum::new(),
        eye: Vector3::new(0.0, 0.0, 0.0),
        target: Vector3::new(0.0, 0.0, 0.0),
        up: Vector3::new(0.0, 1.0, 0.0),
        p,
        ray: Ray::new(),
        a: Vector3::new(0.0, 0.0, 0.0),
        b: Vector3::new(0.0, 0.0, 0.0),
        c: Vector3::new(0.0, 0.0, 0.0),
        hit: Vector3::new(0.0, 0.0, 0.0),
    };

    let mut out = [0.0f64; 3];
    for _ in 0..N_WARMUP {
        scene.run(&mut out);
    }

    let mut samples = [0.0; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        scene.run(&mut out);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let us = median_us(&mut samples);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        us,
        checksum_f64_near(&out),
        SPHERES * ORBIT + TRIANGLES * RAYS,
        2,
        N_RUNS
    );
}
