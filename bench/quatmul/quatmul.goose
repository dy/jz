// quatmul.goose: Goose port of quatmul.js (same quaternions, passes and
// checksum): products, normalizations and inverses over two arrays of
// quaternions, with pmndrs/math's quat functions and mulberry32 generator
// ported as written. A quaternion is a fixed f64[4], an array of them one
// grow-only array.

import bench from "../_lib";
import math;

let N = 4096;
let N_RUNS = 21;
let N_WARMUP = 5;

// pmndrs/math random/mulberry32
struct Mulberry32 { a: u32 }

fn next(state: Mulberry32&) -> u32 {
    state.a = state.a + 0x6d2b79f5;
    var t = state.a;
    t = (t ^ t >> 15) * (t | 1);
    t ^= t + (t ^ t >> 7) * (t | 61);
    return t ^ t >> 14;
}

fn sample(state: Mulberry32&) -> f64 { next(state) / 4294967296.0 }

// pmndrs/math core/quat (normalize is vec4's)
fn multiply(out: f64[4]&, a: f64[4], b: f64[4]) {
    let ax = a[0]; let ay = a[1]; let az = a[2]; let aw = a[3];
    let bx = b[0]; let by = b[1]; let bz = b[2]; let bw = b[3];
    out[0] = ax * bw + aw * bx + ay * bz - az * by;
    out[1] = ay * bw + aw * by + az * bx - ax * bz;
    out[2] = az * bw + aw * bz + ax * by - ay * bx;
    out[3] = aw * bw - ax * bx - ay * by - az * bz;
}

fn normalize(out: f64[4]&, a: f64[4]) {
    let x = a[0]; let y = a[1]; let z = a[2]; let w = a[3];
    var len = x * x + y * y + z * z + w * w;
    if len > 0 { len = 1 / sqrt(len); }
    out[0] = x * len;
    out[1] = y * len;
    out[2] = z * len;
    out[3] = w * len;
}

fn invert(out: f64[4]&, a: f64[4]) {
    let a0 = a[0]; let a1 = a[1]; let a2 = a[2]; let a3 = a[3];
    let dot = a0 * a0 + a1 * a1 + a2 * a2 + a3 * a3;
    if dot == 0 {
        out = [0.0; 4];
        return;
    }
    let inv_dot = 1.0 / dot;
    out[0] = -a0 * inv_dot;
    out[1] = -a1 * inv_dot;
    out[2] = -a2 * inv_dot;
    out[3] = a3 * inv_dot;
}

fn make_quats(seed: u32) -> f64[4][>..] {
    var rand = Mulberry32 { a: seed };
    var quats: f64[4][>..] = [];
    for i in N {
        var q = [0.0; 4];
        q[0] = sample(rand) - 0.5;
        q[1] = sample(rand) - 0.5;
        q[2] = sample(rand) - 0.5;
        q[3] = sample(rand) + 0.5;
        normalize(q, q);
        quats.push(q);
    }
    return quats;
}

fn run(acc: f64[6]&, a: f64[4][:], b: f64[4][:], out: f64[4]&, inv: f64[4]&) {
    var sm = 0.0;
    var si = 0.0;
    for i in N {
        multiply(out, a[i], b[i]);
        normalize(out, out);
        sm += out[0] + out[3];
        invert(inv, a[i]);
        multiply(out, inv, b[i]);
        si += out[1] + out[2];
    }
    acc[0] = sm;
    acc[1] = si;
    acc[2] = out[0];
    acc[3] = out[1];
    acc[4] = out[2];
    acc[5] = out[3];
}

fn main() {
    let a = make_quats(1);
    let b = make_quats(2);
    var out: f64[4] = [0.0, 0.0, 0.0, 1.0];
    var inv: f64[4] = [0.0, 0.0, 0.0, 1.0];
    var acc = [0.0; 6];
    for i in N_WARMUP { run(acc, a, b, out, inv); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        run(acc, a, b, out, inv);
        t = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(acc), N * 2, 2, N_RUNS);
}
