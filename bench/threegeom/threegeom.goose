// threegeom.goose: Goose port of threegeom.js (same buffers, passes and
// checksum): BufferAttribute.applyMatrix4, computeBoundingBox/Sphere and
// computeVertexNormals over Float32 position buffers, each vertex read into a
// Vector3, worked on and written back, with the three.js code the case calls
// (Vector3, Matrix4.makeRotationFromEuler and setPosition, Box3, Sphere)
// ported as written. The buffers are f32, read into f64 and stored back as
// f32, as JS reads and writes a Float32Array.

import bench from "../_lib";
import math;

let VERTS = 100000;
let TRIS = 30000;
let PASSES = 4;
let N_RUNS = 21;
let N_WARMUP = 5;
let INFINITY = 1e309;       // past f64's range: +inf, JS's Infinity

struct Vector3 { x: f64, y: f64, z: f64 }
struct Matrix4 { e: f64[16] }
struct Box3 { min: Vector3, max: Vector3 }
struct Sphere { center: Vector3, radius: f64 }

var seed: u32 = 2;
fn rnd() -> f64 { seed = seed * 1664525 + 1013904223; return seed / 4294967296.0; }

fn from_array(v: Vector3&, a: f32[:], offset: i64) { v.x = a[offset]; v.y = a[offset + 1]; v.z = a[offset + 2]; }
fn to_array(v: const Vector3&, a: f32[:], offset: i64) { a[offset] = v.x as f32; a[offset + 1] = v.y as f32; a[offset + 2] = v.z as f32; }

fn apply_matrix4(v: Vector3&, m: const Matrix4&) {
    let x = v.x; let y = v.y; let z = v.z;
    let e .= m.e;
    let w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
    v.x = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
    v.y = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
    v.z = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
}

fn sub_vectors(v: Vector3&, a: const Vector3&, b: const Vector3&) { v.x = a.x - b.x; v.y = a.y - b.y; v.z = a.z - b.z; }

fn cross(v: Vector3&, b: const Vector3&) {                  // crossVectors(this, b)
    let ax = v.x; let ay = v.y; let az = v.z;
    let bx = b.x; let by = b.y; let bz = b.z;
    v.x = ay * bz - az * by;
    v.y = az * bx - ax * bz;
    v.z = ax * by - ay * bx;
}

fn normalize(v: Vector3&) {
    let l = sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    let s = 1 / (if l != 0 { l } else { 1.0 });             // divideScalar(length() || 1)
    v.x *= s; v.y *= s; v.z *= s;
}

fn distance_to_squared(a: const Vector3&, b: const Vector3&) -> f64 {
    let dx = a.x - b.x; let dy = a.y - b.y; let dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
}

// Matrix4.makeRotationFromEuler, order XYZ (Euler's default)
fn make_rotation_from_euler(m: Matrix4&, x: f64, y: f64, z: f64) {
    let a = cos(x); let b = sin(x);
    let c = cos(y); let d = sin(y);
    let e = cos(z); let f = sin(z);
    let ae = a * e; let af = a * f; let be = b * e; let bf = b * f;
    m.e[0] = c * e;
    m.e[4] = -c * f;
    m.e[8] = d;
    m.e[1] = af + be * d;
    m.e[5] = ae - bf * d;
    m.e[9] = -b * c;
    m.e[2] = bf - ae * d;
    m.e[6] = be + af * d;
    m.e[10] = a * c;
    m.e[3] = 0; m.e[7] = 0; m.e[11] = 0;
    m.e[12] = 0; m.e[13] = 0; m.e[14] = 0;
    m.e[15] = 1;
}

fn set_from_array(box: Box3&, a: f32[:]) {
    box.min = Vector3 { x: INFINITY, y: INFINITY, z: INFINITY };     // makeEmpty
    box.max = Vector3 { x: -INFINITY, y: -INFINITY, z: -INFINITY };
    var p = default<Vector3>();
    var i = 0;
    while i < a.len {
        from_array(p, a, i);
        box.min.x = min(box.min.x, p.x); box.min.y = min(box.min.y, p.y); box.min.z = min(box.min.z, p.z);
        box.max.x = max(box.max.x, p.x); box.max.y = max(box.max.y, p.y); box.max.z = max(box.max.z, p.z);
        i += 3;
    }
}

fn get_center(box: const Box3&, target: Vector3&) {
    let empty = box.max.x < box.min.x || box.max.y < box.min.y || box.max.z < box.min.z;
    if empty { target = Vector3 { x: 0.0, y: 0.0, z: 0.0 }; return; }
    target = Vector3 { x: (box.min.x + box.max.x) * 0.5, y: (box.min.y + box.max.y) * 0.5, z: (box.min.z + box.max.z) * 0.5 };
}

struct Geometry { tp: f32[VERTS * 3], m: Matrix4, v: Vector3, bp: f32[VERTS * 3], box: Box3, sph: Sphere, w: Vector3,
                  np: f32[TRIS * 9], no: f32[TRIS * 9], pa: Vector3, pb: Vector3, pc: Vector3, cb: Vector3, ab: Vector3 }

fn transform_positions(g: Geometry&) -> f64 {
    for k in PASSES {
        for i in VERTS {
            from_array(g.v, g.tp, i * 3);
            apply_matrix4(g.v, g.m);
            to_array(g.v, g.tp, i * 3);
        }
    }
    var s = 0.0;
    for x in g.tp { s += x; }
    return s;
}

fn bounds(g: Geometry&) -> f64 {
    var s = 0.0;
    for k in PASSES {
        set_from_array(g.box, g.bp);
        get_center(g.box, g.sph.center);
        var max_r = 0.0;
        for i in VERTS {
            from_array(g.w, g.bp, i * 3);
            max_r = max(max_r, distance_to_squared(g.sph.center, g.w));
        }
        g.sph.radius = sqrt(max_r);
        s += g.sph.radius + g.box.max.x;
        let j = k % g.bp.len;
        let x: f64 = g.bp[j];                 // the add in f64, then stored as f32, as JS does
        g.bp[j] = (x + 0.001) as f32;
    }
    return s;
}

fn normals(g: Geometry&) -> f64 {
    var s = 0.0;
    for k in PASSES {
        for i in TRIS {
            from_array(g.pa, g.np, i * 9); from_array(g.pb, g.np, i * 9 + 3); from_array(g.pc, g.np, i * 9 + 6);
            sub_vectors(g.cb, g.pc, g.pb);
            sub_vectors(g.ab, g.pa, g.pb);
            cross(g.cb, g.ab);
            to_array(g.cb, g.no, i * 9); to_array(g.cb, g.no, i * 9 + 3); to_array(g.cb, g.no, i * 9 + 6);
        }
        for i in TRIS * 3 {
            from_array(g.cb, g.no, i * 3);
            normalize(g.cb);
            to_array(g.cb, g.no, i * 3);
        }
        s += g.no[(k * 3) % g.no.len];
        let j = k % g.np.len;
        let x: f64 = g.np[j];                 // the add in f64, then stored as f32, as JS does
        g.np[j] = (x + 0.001) as f32;
    }
    return s;
}

fn run(g: Geometry&, out: f64[3]&) {
    out[0] = transform_positions(g);
    out[1] = bounds(g);
    out[2] = normals(g);
}

var geo: Geometry;

fn main() {
    for &x in geo.tp { x = (rnd() * 2 - 1) as f32; }
    make_rotation_from_euler(geo.m, 0.1, 0.2, 0.3);
    geo.m.e[12] = 0.01; geo.m.e[13] = 0.02; geo.m.e[14] = 0.03;      // setPosition
    seed = 6;
    for &x in geo.bp { x = (rnd() * 2 - 1) as f32; }
    geo.box = Box3 { min: Vector3 { x: INFINITY, y: INFINITY, z: INFINITY }, max: Vector3 { x: -INFINITY, y: -INFINITY, z: -INFINITY } };
    geo.sph = Sphere { center: Vector3 { x: 0.0, y: 0.0, z: 0.0 }, radius: -1.0 };
    seed = 7;
    for &x in geo.np { x = (rnd() * 2 - 1) as f32; }
    var out = [0.0; 3];
    for i in N_WARMUP { run(geo, out); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        run(geo, out);
        t = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64_near(out), (VERTS * 2 + TRIS * 4) * PASSES, 3, N_RUNS);
}
