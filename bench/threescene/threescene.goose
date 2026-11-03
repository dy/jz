// threescene.goose: Goose port of threescene.js (same nodes, frames and
// checksum): Object3D.updateMatrixWorld over ten thousand chained nodes,
// three.js's Matrix4.compose from a position, a quaternion and a scale, then
// multiplyMatrices by the parent's world matrix, with the Vector3, Quaternion,
// Euler and Matrix4 code the case calls ported as written. Each node's parts
// are inline records in grow-only arrays.

import bench from "../_lib";
import math;

let N = 10000;
let FRAMES = 20;
let N_RUNS = 21;
let N_WARMUP = 5;

struct Vector3 { x: f64, y: f64, z: f64 }
struct Quaternion { x: f64, y: f64, z: f64, w: f64 }
struct Matrix4 { e: f64[16] }

let IDENTITY = Matrix4 { e: [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0] };

// Quaternion.setFromEuler, order XYZ (Euler's default)
fn from_euler(x: f64, y: f64, z: f64) -> Quaternion {
    let c1 = cos(x / 2);
    let c2 = cos(y / 2);
    let c3 = cos(z / 2);
    let s1 = sin(x / 2);
    let s2 = sin(y / 2);
    let s3 = sin(z / 2);
    return Quaternion { x: s1 * c2 * c3 + c1 * s2 * s3, y: c1 * s2 * c3 - s1 * c2 * s3,
                        z: c1 * c2 * s3 + s1 * s2 * c3, w: c1 * c2 * c3 - s1 * s2 * s3 };
}

// Matrix4.makeRotationY, through set's row-major arguments
fn make_rotation_y(theta: f64) -> Matrix4 {
    let c = cos(theta);
    let s = sin(theta);
    return Matrix4 { e: [c, 0.0, -s, 0.0, 0.0, 1.0, 0.0, 0.0, s, 0.0, c, 0.0, 0.0, 0.0, 0.0, 1.0] };
}

fn compose(m: Matrix4&, position: const Vector3&, quaternion: const Quaternion&, scale: const Vector3&) {
    let x = quaternion.x; let y = quaternion.y; let z = quaternion.z; let w = quaternion.w;
    let x2 = x + x; let y2 = y + y; let z2 = z + z;
    let xx = x * x2; let xy = x * y2; let xz = x * z2;
    let yy = y * y2; let yz = y * z2; let zz = z * z2;
    let wx = w * x2; let wy = w * y2; let wz = w * z2;
    let sx = scale.x; let sy = scale.y; let sz = scale.z;
    m.e[0] = (1 - (yy + zz)) * sx;
    m.e[1] = (xy + wz) * sx;
    m.e[2] = (xz - wy) * sx;
    m.e[3] = 0;
    m.e[4] = (xy - wz) * sy;
    m.e[5] = (1 - (xx + zz)) * sy;
    m.e[6] = (yz + wx) * sy;
    m.e[7] = 0;
    m.e[8] = (xz + wy) * sz;
    m.e[9] = (yz - wx) * sz;
    m.e[10] = (1 - (xx + yy)) * sz;
    m.e[11] = 0;
    m.e[12] = position.x;
    m.e[13] = position.y;
    m.e[14] = position.z;
    m.e[15] = 1;
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

fn run(out: f64[17]&, pos: Vector3[:], quat: Quaternion[:], scl: Vector3[:], local: Matrix4[:], world: Matrix4[:], root: const Matrix4&) {
    var sum = 0.0;
    for f in FRAMES {
        for i in N {
            pos[i].x += 0.01;
            compose(local[i], pos[i], quat[i], scl[i]);
            if i & 7 == 0 { multiply_matrices(world[i], root, local[i]); }
            else { multiply_matrices(world[i], world[i - 1], local[i]); }
        }
        sum += world[N - 1].e[12];
    }
    for k in 16 { out[k] = world[N - 1].e[k]; }
    out[16] = sum;
}

fn main() {
    var seed: u32 = 1;
    fn rnd() -> f64 { seed = seed * 1664525 + 1013904223; return seed / 4294967296.0; }
    var pos: Vector3[>..] = [];
    var quat: Quaternion[>..] = [];
    var scl: Vector3[>..] = [];
    var local: Matrix4[>..] = [];
    var world: Matrix4[>..] = [];
    for i in N {
        let px = rnd() * 100 - 50; let py = rnd() * 100 - 50; let pz = rnd() * 100 - 50;
        pos.push(Vector3 { x: px, y: py, z: pz });
        let ex = rnd() * 6; let ey = rnd() * 6; let ez = rnd() * 6;
        quat.push(from_euler(ex, ey, ez));
        let sx = 1 + rnd(); let sy = 1 + rnd(); let sz = 1 + rnd();
        scl.push(Vector3 { x: sx, y: sy, z: sz });
        local.push(IDENTITY);
        world.push(IDENTITY);
    }
    let root = make_rotation_y(0.3);
    var out = [0.0; 17];
    for i in N_WARMUP { run(out, pos, quat, scl, local, world, root); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        run(out, pos, quat, scl, local, world, root);
        t = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64_near(out), N * FRAMES, 2, N_RUNS);
}
