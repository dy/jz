// threeanim.goose: Goose port of threeanim.js (same keyframes, passes and
// checksum): QuaternionLinearInterpolant's slerp of ten thousand bone
// rotations, three.js's Quaternion.slerpFlat over Float32 keyframe buffers at
// an offset, with the Euler and Quaternion code the case calls (set,
// setFromEuler, toArray) ported as written. The buffers are f32, read into
// f64 and stored back as f32, as JS reads and writes a Float32Array.

import bench from "../_lib";
import math;

let N = 10000;
let ITERS = 40;
let N_RUNS = 21;
let N_WARMUP = 5;

enum Order { XYZ, YXZ, ZXY, ZYX, YZX, XZY }
struct Euler { x: f64, y: f64, z: f64, order: Order }
struct Quaternion { x: f64, y: f64, z: f64, w: f64 }

fn set_from_euler(q: Quaternion&, e: Euler) {
    let c1 = cos(e.x / 2);
    let c2 = cos(e.y / 2);
    let c3 = cos(e.z / 2);
    let s1 = sin(e.x / 2);
    let s2 = sin(e.y / 2);
    let s3 = sin(e.z / 2);
    q = match e.order {
        XYZ => Quaternion { x: s1 * c2 * c3 + c1 * s2 * s3, y: c1 * s2 * c3 - s1 * c2 * s3,
                            z: c1 * c2 * s3 + s1 * s2 * c3, w: c1 * c2 * c3 - s1 * s2 * s3 },
        YXZ => Quaternion { x: s1 * c2 * c3 + c1 * s2 * s3, y: c1 * s2 * c3 - s1 * c2 * s3,
                            z: c1 * c2 * s3 - s1 * s2 * c3, w: c1 * c2 * c3 + s1 * s2 * s3 },
        ZXY => Quaternion { x: s1 * c2 * c3 - c1 * s2 * s3, y: c1 * s2 * c3 + s1 * c2 * s3,
                            z: c1 * c2 * s3 + s1 * s2 * c3, w: c1 * c2 * c3 - s1 * s2 * s3 },
        ZYX => Quaternion { x: s1 * c2 * c3 - c1 * s2 * s3, y: c1 * s2 * c3 + s1 * c2 * s3,
                            z: c1 * c2 * s3 - s1 * s2 * c3, w: c1 * c2 * c3 + s1 * s2 * s3 },
        YZX => Quaternion { x: s1 * c2 * c3 + c1 * s2 * s3, y: c1 * s2 * c3 + s1 * c2 * s3,
                            z: c1 * c2 * s3 - s1 * s2 * c3, w: c1 * c2 * c3 - s1 * s2 * s3 },
        XZY => Quaternion { x: s1 * c2 * c3 - c1 * s2 * s3, y: c1 * s2 * c3 - s1 * c2 * s3,
                            z: c1 * c2 * s3 + s1 * s2 * c3, w: c1 * c2 * c3 + s1 * s2 * s3 },
    };
}

fn to_array(q: Quaternion, a: f32[:], offset: i64) {
    a[offset] = q.x as f32;
    a[offset + 1] = q.y as f32;
    a[offset + 2] = q.z as f32;
    a[offset + 3] = q.w as f32;
}

fn slerp_flat(dst: f32[:], dst_offset: i64, src0: f32[:], src_offset0: i64, src1: f32[:], src_offset1: i64, t0: f64) {
    var t = t0;
    var x0: f64 = src0[src_offset0];
    var y0: f64 = src0[src_offset0 + 1];
    var z0: f64 = src0[src_offset0 + 2];
    var w0: f64 = src0[src_offset0 + 3];
    var x1: f64 = src1[src_offset1];
    var y1: f64 = src1[src_offset1 + 1];
    var z1: f64 = src1[src_offset1 + 2];
    var w1: f64 = src1[src_offset1 + 3];
    if w0 != w1 || x0 != x1 || y0 != y1 || z0 != z1 {
        var dot = x0 * x1 + y0 * y1 + z0 * z1 + w0 * w1;
        if dot < 0 {
            x1 = -x1;
            y1 = -y1;
            z1 = -z1;
            w1 = -w1;
            dot = -dot;
        }
        var s = 1 - t;
        if dot < 0.9995 {
            let theta = acos(dot);
            let sn = sin(theta);
            s = sin(s * theta) / sn;
            t = sin(t * theta) / sn;
            x0 = x0 * s + x1 * t;
            y0 = y0 * s + y1 * t;
            z0 = z0 * s + z1 * t;
            w0 = w0 * s + w1 * t;
        } else {
            x0 = x0 * s + x1 * t;
            y0 = y0 * s + y1 * t;
            z0 = z0 * s + z1 * t;
            w0 = w0 * s + w1 * t;
            let f = 1 / sqrt(x0 * x0 + y0 * y0 + z0 * z0 + w0 * w0);
            x0 *= f;
            y0 *= f;
            z0 *= f;
            w0 *= f;
        }
    }
    dst[dst_offset] = x0 as f32;
    dst[dst_offset + 1] = y0 as f32;
    dst[dst_offset + 2] = z0 as f32;
    dst[dst_offset + 3] = w0 as f32;
}

fn run(out: f64[9]&, src0: f32[:], src1: f32[:], dst: f32[:]) {
    var s = 0.0;
    for k in ITERS {
        let t = (k % 100) / 100.0;
        for i in N { slerp_flat(dst, i * 4, src0, i * 4, src1, i * 4, t); }
        s += dst[(k * 4) % dst.len];
    }
    out[0] = s;
    for k in 8 { out[k + 1] = dst[k * 4099 % dst.len]; }
}

fn main() {
    var seed: u32 = 5;
    fn rnd() -> f64 { seed = seed * 1664525 + 1013904223; return seed / 4294967296.0; }
    var src0: f32[>..] = [];
    var src1: f32[>..] = [];
    var dst: f32[>..] = [];
    src0.resize(N * 4, 0.0);
    src1.resize(N * 4, 0.0);
    dst.resize(N * 4, 0.0);
    var q = Quaternion { x: 0.0, y: 0.0, z: 0.0, w: 1.0 };
    for i in N {
        var e = Euler { x: rnd() * 6, y: 0.0, z: 0.0, order: Order.XYZ };
        e.y = rnd() * 6;
        e.z = rnd() * 6;
        set_from_euler(q, e);
        to_array(q, src0, i * 4);
        e.x = rnd() * 6;
        e.y = rnd() * 6;
        e.z = rnd() * 6;
        set_from_euler(q, e);
        to_array(q, src1, i * 4);
    }
    var out = [0.0; 9];
    for i in N_WARMUP { run(out, src0, src1, dst); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        run(out, src0, src1, dst);
        t = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64_near(out), N * ITERS, 1, N_RUNS);
}
