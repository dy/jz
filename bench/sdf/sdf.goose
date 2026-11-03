// sdf.goose: Goose port of sdf.js (same bitmap, passes and checksum): exact
// Euclidean distance transform (Felzenszwalb), a 1-D lower-envelope pass over
// every column, then every row.

import bench from "../_lib";

let W = 384;
let H = 384;
let INF = 1e20;
let N_ITERS = 4;
let N_RUNS = 21;
let N_WARMUP = 5;
let MAXWH = if W > H { W } else { H };

fn build_bitmap(bmp: u8[:]) {
    var s: u32 = 0x77aa123;
    fn rnd() -> u32 { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return s; }
    for i in W * H { bmp[i] = 0; }
    for c in 30 {
        let cx: i64 = 20 + rnd() % (W - 40);
        let cy: i64 = 20 + rnd() % (H - 40);
        let r: i64 = 6 + rnd() % 25;
        let r2 = r * r;
        let fill: u8 = if c % 4 == 3 { 0 } else { 1 };
        for y in cy - r..cy + r + 1 {
            let dy = y - cy;
            for x in cx - r..cx + r + 1 {
                let dx = x - cx;
                if dx * dx + dy * dy <= r2 { bmp[y * W + x] = fill; }
            }
        }
    }
}

fn edt1d(f: f64[:], d: f64[:], v: i32[:], z: f64[:], n: i64) {
    var k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for q in 1..n {
        var s_mid = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2.0 * q - 2.0 * v[k]);
        while s_mid <= z[k] {
            k--;
            s_mid = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2.0 * q - 2.0 * v[k]);
        }
        k++;
        v[k] = q as i32;
        z[k] = s_mid;
        z[k + 1] = INF;
    }
    k = 0;
    for q in n {
        while z[k + 1] < q { k++; }
        let dq = q - v[k];
        d[q] = dq * dq + f[v[k]];
    }
}

fn transform(bmp: u8[:], dist: f64[:], rowf: f64[:], rowd: f64[:], v: i32[:], z: f64[:]) {
    for i in W * H { dist[i] = if bmp[i] == 1 { 0.0 } else { INF }; }
    for x in W {
        for y in H { rowf[y] = dist[y * W + x]; }
        edt1d(rowf, rowd, v, z, H);
        for y in H { dist[y * W + x] = rowd[y]; }
    }
    for y in H {
        let off = y * W;
        for x in W { rowf[x] = dist[off + x]; }
        edt1d(rowf, rowd, v, z, W);
        for x in W { dist[off + x] = rowd[x]; }
    }
}

fn run_kernel(bmp: u8[:], dist: f64[:], rowf: f64[:], rowd: f64[:], v: i32[:], z: f64[:]) {
    for it in N_ITERS { transform(bmp, dist, rowf, rowd, v, z); }
}

fn main() {
    var bmp: u8[>..] = [];
    var dist: f64[>..] = [];
    var rowf: f64[>..] = [];
    var rowd: f64[>..] = [];
    var v: i32[>..] = [];
    var z: f64[>..] = [];
    bmp.resize(W * H, 0);
    dist.resize(W * H, 0.0);
    rowf.resize(MAXWH, 0.0);
    rowd.resize(MAXWH, 0.0);
    v.resize(MAXWH, 0);
    z.resize(MAXWH + 1, 0.0);
    build_bitmap(bmp);
    for i in N_WARMUP { run_kernel(bmp, dist, rowf, rowd, v, z); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        run_kernel(bmp, dist, rowf, rowd, v, z);
        t = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(dist), W * H * N_ITERS, 2, N_RUNS);
}
