// threecull.goose: Goose port of threecull.js (same scene, orbit, rays and
// checksum): WebGLRenderer.projectObject's frustum test of ten thousand
// bounding spheres as the camera orbits, then Mesh.raycast against twenty
// thousand triangles, with the three.js code the case calls (Vector3,
// Matrix4.makePerspective, lookAt, setPosition, invert, multiplyMatrices,
// Frustum, Plane, Sphere, Ray.intersectTriangle and at) ported as written.
// Records are inline structs; Ray.intersectTriangle's null-or-target is a
// bool with the hit written into the target.

import bench from "../_lib";
import math;

let SPHERES = 10000;
let ORBIT = 40;
let TRIANGLES = 20000;
let RAYS = 10;
let N_RUNS = 21;
let N_WARMUP = 5;

struct Vector3 { x: f64, y: f64, z: f64 }
struct Matrix4 { e: f64[16] }
struct Plane { normal: Vector3, constant: f64 }
struct Frustum { planes: Plane[6] }
struct Sphere { center: Vector3, radius: f64 }
struct Ray { origin: Vector3, direction: Vector3 }

let IDENTITY = Matrix4 { e: [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0] };

var seed: u32 = 3;
fn rnd() -> f64 { seed = seed * 1664525 + 1013904223; return seed / 4294967296.0; }

fn length(v: const Vector3&) -> f64 { sqrt(v.x * v.x + v.y * v.y + v.z * v.z) }
fn length_sq(v: const Vector3&) -> f64 { v.x * v.x + v.y * v.y + v.z * v.z }
fn multiply_scalar(v: Vector3&, s: f64) { v.x *= s; v.y *= s; v.z *= s; }
fn normalize(v: Vector3&) {
    let l = length(v);
    multiply_scalar(v, 1 / (if l != 0 { l } else { 1.0 }));         // length() || 1
}
fn cross_vectors(v: Vector3&, a: Vector3, b: Vector3) {
    v = Vector3 { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
fn dot(a: const Vector3&, b: const Vector3&) -> f64 { a.x * b.x + a.y * b.y + a.z * b.z }
fn from_array(v: Vector3&, a: f32[:], offset: i64) { v.x = a[offset]; v.y = a[offset + 1]; v.z = a[offset + 2]; }

fn make_perspective(m: Matrix4&, left: f64, right: f64, top: f64, bottom: f64, near: f64, far: f64) {
    let x = 2 * near / (right - left);
    let y = 2 * near / (top - bottom);
    let a = (right + left) / (right - left);
    let b = (top + bottom) / (top - bottom);
    let c = -(far + near) / (far - near);                 // WebGL coordinate system
    let d = -2 * far * near / (far - near);
    m.e = [x, 0.0, 0.0, 0.0, 0.0, y, 0.0, 0.0, a, b, c, -1.0, 0.0, 0.0, d, 0.0];
}

fn look_at(m: Matrix4&, eye: const Vector3&, target: const Vector3&, up: const Vector3&) {
    var z = Vector3 { x: eye.x - target.x, y: eye.y - target.y, z: eye.z - target.z };
    if length_sq(z) == 0 { z.z = 1; }
    normalize(z);
    var x = default<Vector3>();
    cross_vectors(x, up, z);
    if length_sq(x) == 0 {
        if abs(up.z) == 1 { z.x += 0.0001; } else { z.z += 0.0001; }
        normalize(z);
        cross_vectors(x, up, z);
    }
    normalize(x);
    var y = default<Vector3>();
    cross_vectors(y, z, x);
    m.e[0] = x.x; m.e[4] = y.x; m.e[8] = z.x;
    m.e[1] = x.y; m.e[5] = y.y; m.e[9] = z.y;
    m.e[2] = x.z; m.e[6] = y.z; m.e[10] = z.z;
}

fn set_position(m: Matrix4&, v: const Vector3&) { m.e[12] = v.x; m.e[13] = v.y; m.e[14] = v.z; }

fn invert(m: Matrix4&) {
    let n11 = m.e[0];  let n21 = m.e[1];  let n31 = m.e[2];  let n41 = m.e[3];
    let n12 = m.e[4];  let n22 = m.e[5];  let n32 = m.e[6];  let n42 = m.e[7];
    let n13 = m.e[8];  let n23 = m.e[9];  let n33 = m.e[10]; let n43 = m.e[11];
    let n14 = m.e[12]; let n24 = m.e[13]; let n34 = m.e[14]; let n44 = m.e[15];
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
    if det == 0 { m.e = [0.0; 16]; return; }
    let det_inv = 1 / det;
    m.e[0] = (n22 * t12 - n32 * t11 + n42 * t10) * det_inv;
    m.e[1] = (n31 * t11 - n21 * t12 - n41 * t10) * det_inv;
    m.e[2] = (n24 * t6 - n34 * t5 + n44 * t4) * det_inv;
    m.e[3] = (n33 * t5 - n23 * t6 - n43 * t4) * det_inv;
    m.e[4] = (n32 * t9 - n12 * t12 - n42 * t8) * det_inv;
    m.e[5] = (n11 * t12 - n31 * t9 + n41 * t8) * det_inv;
    m.e[6] = (n34 * t3 - n14 * t6 - n44 * t2) * det_inv;
    m.e[7] = (n13 * t6 - n33 * t3 + n43 * t2) * det_inv;
    m.e[8] = (n12 * t11 - n22 * t9 + n42 * t7) * det_inv;
    m.e[9] = (n21 * t9 - n11 * t11 - n41 * t7) * det_inv;
    m.e[10] = (n14 * t5 - n24 * t3 + n44 * t1) * det_inv;
    m.e[11] = (n23 * t3 - n13 * t5 - n43 * t1) * det_inv;
    m.e[12] = (n22 * t8 - n12 * t10 - n32 * t7) * det_inv;
    m.e[13] = (n11 * t10 - n21 * t8 + n31 * t7) * det_inv;
    m.e[14] = (n24 * t2 - n14 * t4 - n34 * t1) * det_inv;
    m.e[15] = (n13 * t4 - n23 * t2 + n33 * t1) * det_inv;
}

fn multiply_matrices(m: Matrix4&, a: const Matrix4&, b: const Matrix4&) {
    let ae .= a.e;
    let be .= b.e;
    let a11 = ae[0]; let a12 = ae[4]; let a13 = ae[8]; let a14 = ae[12];
    let a21 = ae[1]; let a22 = ae[5]; let a23 = ae[9]; let a24 = ae[13];
    let a31 = ae[2]; let a32 = ae[6]; let a33 = ae[10]; let a34 = ae[14];
    let a41 = ae[3]; let a42 = ae[7]; let a43 = ae[11]; let a44 = ae[15];
    let b11 = be[0]; let b12 = be[4]; let b13 = be[8]; let b14 = be[12];
    let b21 = be[1]; let b22 = be[5]; let b23 = be[9]; let b24 = be[13];
    let b31 = be[2]; let b32 = be[6]; let b33 = be[10]; let b34 = be[14];
    let b41 = be[3]; let b42 = be[7]; let b43 = be[11]; let b44 = be[15];
    m.e[0] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
    m.e[4] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
    m.e[8] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
    m.e[12] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;
    m.e[1] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
    m.e[5] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
    m.e[9] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
    m.e[13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;
    m.e[2] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
    m.e[6] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
    m.e[10] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
    m.e[14] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;
    m.e[3] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;
    m.e[7] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;
    m.e[11] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;
    m.e[15] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;
}

fn set_components(p: Plane&, x: f64, y: f64, z: f64, w: f64) {
    p.normal = Vector3 { x: x, y: y, z: z };
    p.constant = w;
    let inverse_normal_length = 1.0 / length(p.normal);  // Plane.normalize
    multiply_scalar(p.normal, inverse_normal_length);
    p.constant *= inverse_normal_length;
}

fn set_from_projection_matrix(fr: Frustum&, m: const Matrix4&) {
    let me .= m.e;
    set_components(fr.planes[0], me[3] - me[0], me[7] - me[4], me[11] - me[8], me[15] - me[12]);
    set_components(fr.planes[1], me[3] + me[0], me[7] + me[4], me[11] + me[8], me[15] + me[12]);
    set_components(fr.planes[2], me[3] + me[1], me[7] + me[5], me[11] + me[9], me[15] + me[13]);
    set_components(fr.planes[3], me[3] - me[1], me[7] - me[5], me[11] - me[9], me[15] - me[13]);
    set_components(fr.planes[4], me[3] - me[2], me[7] - me[6], me[11] - me[10], me[15] - me[14]);   // far
    set_components(fr.planes[5], me[3] + me[2], me[7] + me[6], me[11] + me[10], me[15] + me[14]);   // near (WebGL)
}

fn intersects_sphere(fr: const Frustum&, sphere: const Sphere&) -> bool {
    let neg_radius = -sphere.radius;
    for i in 6 {
        let distance = dot(fr.planes[i].normal, sphere.center) + fr.planes[i].constant;
        if distance < neg_radius { return false; }
    }
    return true;
}

fn intersect_triangle(ray: const Ray&, a: const Vector3&, b: const Vector3&, c: const Vector3&, backface_culling: bool, target: Vector3&) -> bool {
    let dx = ray.direction.x;
    let dy = ray.direction.y;
    let dz = ray.direction.z;
    let aox = a.x - ray.origin.x; let aoy = a.y - ray.origin.y; let aoz = a.z - ray.origin.z;
    let box = b.x - ray.origin.x; let boy = b.y - ray.origin.y; let boz = b.z - ray.origin.z;
    let cox = c.x - ray.origin.x; let coy = c.y - ray.origin.y; let coz = c.z - ray.origin.z;
    let adx = abs(dx); let ady = abs(dy); let adz = abs(dz);
    var dkx = 0.0; var dky = 0.0; var dkz = 0.0;
    var akx = 0.0; var aky = 0.0; var akz = 0.0;
    var bkx = 0.0; var bky = 0.0; var bkz = 0.0;
    var ckx = 0.0; var cky = 0.0; var ckz = 0.0;
    if adx >= ady && adx >= adz {
        dkz = dx; akz = aox; bkz = box; ckz = cox;
        if dx >= 0 {
            dkx = dy; dky = dz;
            akx = aoy; aky = aoz; bkx = boy; bky = boz; ckx = coy; cky = coz;
        } else {
            dkx = dz; dky = dy;
            akx = aoz; aky = aoy; bkx = boz; bky = boy; ckx = coz; cky = coy;
        }
    } else if ady >= adz {
        dkz = dy; akz = aoy; bkz = boy; ckz = coy;
        if dy >= 0 {
            dkx = dz; dky = dx;
            akx = aoz; aky = aox; bkx = boz; bky = box; ckx = coz; cky = cox;
        } else {
            dkx = dx; dky = dz;
            akx = aox; aky = aoz; bkx = box; bky = boz; ckx = cox; cky = coz;
        }
    } else {
        dkz = dz; akz = aoz; bkz = boz; ckz = coz;
        if dz >= 0 {
            dkx = dx; dky = dy;
            akx = aox; aky = aoy; bkx = box; bky = boy; ckx = cox; cky = coy;
        } else {
            dkx = dy; dky = dx;
            akx = aoy; aky = aox; bkx = boy; bky = box; ckx = coy; cky = cox;
        }
    }
    if dkz == 0 { return false; }
    let sx = dkx / dkz;
    let sy = dky / dkz;
    let sz = 1 / dkz;
    let ax = akx - sx * akz; let ay = aky - sy * akz;
    let bx = bkx - sx * bkz; let by = bky - sy * bkz;
    let cx = ckx - sx * ckz; let cy = cky - sy * ckz;
    let u = cx * by - cy * bx;
    let v = ax * cy - ay * cx;
    let w = bx * ay - by * ax;
    if backface_culling {
        if u < 0 || v < 0 || w < 0 { return false; }
    } else {
        if (u < 0 || v < 0 || w < 0) && (u > 0 || v > 0 || w > 0) { return false; }
    }
    let det = u + v + w;
    if det == 0 { return false; }
    let t_scaled = sz * (u * akz + v * bkz + w * ckz);
    if (if det > 0 { t_scaled < 0 } else { t_scaled > 0 }) { return false; }
    let t = t_scaled / det;                                 // Ray.at
    target = Vector3 { x: ray.origin.x + ray.direction.x * t, y: ray.origin.y + ray.direction.y * t,
                       z: ray.origin.z + ray.direction.z * t };
    return true;
}

struct World { spheres: Sphere[SPHERES], proj: Matrix4, view: Matrix4, pv: Matrix4, fr: Frustum,
               eye: Vector3, target: Vector3, up: Vector3, p: f32[TRIANGLES * 9],
               ray: Ray, a: Vector3, b: Vector3, c: Vector3, hit: Vector3 }

fn cull(w: World&) -> i64 {
    var visible = 0;
    for k in ORBIT {
        w.eye = Vector3 { x: sin(k * 0.01) * 50, y: 10.0, z: cos(k * 0.01) * 50 };
        look_at(w.view, w.eye, w.target, w.up);
        set_position(w.view, w.eye);
        invert(w.view);
        multiply_matrices(w.pv, w.proj, w.view);
        set_from_projection_matrix(w.fr, w.pv);
        for i in SPHERES { if intersects_sphere(w.fr, w.spheres[i]) { visible++; } }
    }
    return visible;
}

fn raycast(w: World&, out: f64[3]&) {
    seed = 5;
    var hits = 0;
    var acc = 0.0;
    for k in RAYS {
        w.ray.origin = Vector3 { x: 0.0, y: 0.0, z: -30.0 };
        let dx = rnd() - 0.5;
        let dy = rnd() - 0.5;
        w.ray.direction = Vector3 { x: dx, y: dy, z: 1.0 };
        normalize(w.ray.direction);
        for i in TRIANGLES {
            from_array(w.a, w.p, i * 9); from_array(w.b, w.p, i * 9 + 3); from_array(w.c, w.p, i * 9 + 6);
            if intersect_triangle(w.ray, w.a, w.b, w.c, false, w.hit) { hits++; acc += w.hit.z; }
        }
    }
    out[1] = hits;
    out[2] = acc;
}

fn run(w: World&, out: f64[3]&) {
    out[0] = cull(w);
    raycast(w, out);
}

var world: World;

fn main() {
    for &s in world.spheres {
        let x = rnd() * 200 - 100; let y = rnd() * 200 - 100; let z = rnd() * 200 - 100;
        s = Sphere { center: Vector3 { x: x, y: y, z: z }, radius: rnd() * 5 };
    }
    world.proj = IDENTITY;
    make_perspective(world.proj, -1, 1, 1, -1, 1, 100);
    world.view = IDENTITY;
    world.pv = IDENTITY;
    for &pl in world.fr.planes { pl = Plane { normal: Vector3 { x: 1.0, y: 0.0, z: 0.0 }, constant: 0.0 }; }
    world.up = Vector3 { x: 0.0, y: 1.0, z: 0.0 };
    seed = 4;
    for &v in world.p { v = (rnd() * 20 - 10) as f32; }
    var out = [0.0; 3];
    for i in N_WARMUP { run(world, out); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        run(world, out);
        t = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64_near(out), SPHERES * ORBIT + TRIANGLES * RAYS, 2, N_RUNS);
}
