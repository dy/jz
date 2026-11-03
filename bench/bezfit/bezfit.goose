// bezfit.goose: Goose port of bezfit.js (same strokes, passes and checksum):
// least-squares cubic Bézier fitting (Schneider) of digitized strokes, with
// one Newton reparameterization between two fits. Points are interleaved
// x, y pairs in one f64 array, as the JS keeps them.

import bench from "../_lib";
import math;

let RUNS = 256;             // digitized strokes
let K = 48;                 // points per stroke
let N_ITERS = 6;
let N_RUNS = 21;
let N_WARMUP = 5;

fn build_runs(pts: f64[:]) {
    var s: u32 = 0x9b3f017;
    fn rnd() -> u32 { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return s; }
    fn centered(m: u32, c: i64) -> i64 { rnd() % m - c }
    for r in RUNS {
        let ax = (rnd() % 1000) * 0.1;
        let ay = (rnd() % 1000) * 0.1;
        let bx = centered(2000, 1000) * 0.05;
        let by = centered(2000, 1000) * 0.05;
        let cx = centered(2000, 1000) * 0.003;
        let cy = centered(2000, 1000) * 0.003;
        for i in K {
            let t = i / (K - 1.0);
            let j = centered(100, 50) * 0.002;
            pts[(r * K + i) * 2] = ax + bx * t * 10.0 + cx * t * t * 100.0 + j;
            pts[(r * K + i) * 2 + 1] = ay + by * t * 10.0 + cy * t * t * t * 100.0 - j;
        }
    }
}

fn b0(t: f64) -> f64 { let u = 1.0 - t; return u * u * u; }
fn b1(t: f64) -> f64 { let u = 1.0 - t; return 3.0 * t * u * u; }
fn b2(t: f64) -> f64 { let u = 1.0 - t; return 3.0 * t * t * u; }
fn b3(t: f64) -> f64 { t * t * t }

fn fit_once(pts: f64[:], o: i64, u: f64[:], ctrl: f64[:], co: i64) {
    let x0 = pts[o * 2];
    let y0 = pts[o * 2 + 1];
    let x3 = pts[(o + K - 1) * 2];
    let y3 = pts[(o + K - 1) * 2 + 1];
    var t1x = pts[(o + 1) * 2] - x0;
    var t1y = pts[(o + 1) * 2 + 1] - y0;
    var l = sqrt(t1x * t1x + t1y * t1y);
    if l < 1e-12 { l = 1.0; }
    t1x /= l; t1y /= l;
    var t2x = pts[(o + K - 2) * 2] - x3;
    var t2y = pts[(o + K - 2) * 2 + 1] - y3;
    l = sqrt(t2x * t2x + t2y * t2y);
    if l < 1e-12 { l = 1.0; }
    t2x /= l; t2y /= l;
    var c00 = 0.0;
    var c01 = 0.0;
    var c11 = 0.0;
    var xr1 = 0.0;
    var xr2 = 0.0;
    for i in K {
        let t = u[i];
        let a1x = t1x * b1(t);
        let a1y = t1y * b1(t);
        let a2x = t2x * b2(t);
        let a2y = t2y * b2(t);
        let sx = pts[(o + i) * 2] - (x0 * (b0(t) + b1(t)) + x3 * (b2(t) + b3(t)));
        let sy = pts[(o + i) * 2 + 1] - (y0 * (b0(t) + b1(t)) + y3 * (b2(t) + b3(t)));
        c00 += a1x * a1x + a1y * a1y;
        c01 += a1x * a2x + a1y * a2y;
        c11 += a2x * a2x + a2y * a2y;
        xr1 += a1x * sx + a1y * sy;
        xr2 += a2x * sx + a2y * sy;
    }
    var det = c00 * c11 - c01 * c01;
    if det < 1e-12 && det > -1e-12 { det = 1e-12; }
    let alpha1 = (xr1 * c11 - xr2 * c01) / det;
    let alpha2 = (xr2 * c00 - xr1 * c01) / det;
    ctrl[co] = x0; ctrl[co + 1] = y0;
    ctrl[co + 2] = x0 + t1x * alpha1; ctrl[co + 3] = y0 + t1y * alpha1;
    ctrl[co + 4] = x3 + t2x * alpha2; ctrl[co + 5] = y3 + t2y * alpha2;
    ctrl[co + 6] = x3; ctrl[co + 7] = y3;
}

fn reparam(pts: f64[:], o: i64, u: f64[:], ctrl: f64[:], co: i64) {
    let p0x = ctrl[co];
    let p0y = ctrl[co + 1];
    let p1x = ctrl[co + 2];
    let p1y = ctrl[co + 3];
    let p2x = ctrl[co + 4];
    let p2y = ctrl[co + 5];
    let p3x = ctrl[co + 6];
    let p3y = ctrl[co + 7];
    for i in 1..K - 1 {
        let t = u[i];
        let qx = p0x * b0(t) + p1x * b1(t) + p2x * b2(t) + p3x * b3(t);
        let qy = p0y * b0(t) + p1y * b1(t) + p2y * b2(t) + p3y * b3(t);
        let un = 1.0 - t;
        let d1x = 3.0 * (un * un * (p1x - p0x) + 2.0 * un * t * (p2x - p1x) + t * t * (p3x - p2x));
        let d1y = 3.0 * (un * un * (p1y - p0y) + 2.0 * un * t * (p2y - p1y) + t * t * (p3y - p2y));
        let d2x = 6.0 * (un * (p2x - 2.0 * p1x + p0x) + t * (p3x - 2.0 * p2x + p1x));
        let d2y = 6.0 * (un * (p2y - 2.0 * p1y + p0y) + t * (p3y - 2.0 * p2y + p1y));
        let dx = qx - pts[(o + i) * 2];
        let dy = qy - pts[(o + i) * 2 + 1];
        let num = dx * d1x + dy * d1y;
        let den = d1x * d1x + d1y * d1y + dx * d2x + dy * d2y;
        if den > 1e-12 || den < -1e-12 {
            var nu = t - num / den;
            if nu < 0.0 { nu = 0.0; }
            if nu > 1.0 { nu = 1.0; }
            u[i] = nu;
        }
    }
}

fn run_kernel(pts: f64[:], u: f64[:], ctrl: f64[:]) {
    for it in N_ITERS {
        for r in RUNS {
            let o = r * K;
            u[0] = 0.0;
            for i in 1..K {
                let dx = pts[(o + i) * 2] - pts[(o + i - 1) * 2];
                let dy = pts[(o + i) * 2 + 1] - pts[(o + i - 1) * 2 + 1];
                u[i] = u[i - 1] + sqrt(dx * dx + dy * dy);
            }
            let inv = 1.0 / u[K - 1];
            for i in 1..K { u[i] *= inv; }
            let co = r * 8;
            fit_once(pts, o, u, ctrl, co);
            reparam(pts, o, u, ctrl, co);
            fit_once(pts, o, u, ctrl, co);
        }
    }
}

fn main() {
    var pts: f64[>..] = [];
    var u: f64[>..] = [];
    var ctrl: f64[>..] = [];
    pts.resize(RUNS * K * 2, 0.0);
    u.resize(K, 0.0);
    ctrl.resize(RUNS * 8, 0.0);
    build_runs(pts);
    for i in N_WARMUP { run_kernel(pts, u, ctrl); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        run_kernel(pts, u, ctrl);
        t = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(ctrl), RUNS * K * N_ITERS, 3, N_RUNS);
}
