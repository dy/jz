// aos.goose: Goose port of aos.js (same rows, passes and checksum): an array
// of {x, y, z} records copied into three f64 arrays. The rows are inline
// records in one grow-only array.

import bench from "../_lib";

let N = 16384;
let N_ITERS = 64;
let N_RUNS = 21;
let N_WARMUP = 5;

struct Row { x: f64, y: f64, z: f64 }

fn init_rows() -> Row[>..] {
    var rows: Row[>..] = [];
    for i in N { rows.push(Row { x: i * 0.5, y: i + 1, z: (i & 7) - 3 }); }
    return rows;
}

fn run_kernel(rows: Row[:], xs: f64[:], ys: f64[:], zs: f64[:]) {
    for r in N_ITERS {
        for p, i in rows {
            xs[i] = p.x + p.y * 0.25 + r;
            ys[i] = p.y - p.z * 0.5;
            zs[i] = p.z + p.x * 0.125;
        }
    }
}

fn main() {
    let rows = init_rows();
    var xs: f64[>..] = [];
    var ys: f64[>..] = [];
    var zs: f64[>..] = [];
    xs.resize(N, 0.0);
    ys.resize(N, 0.0);
    zs.resize(N, 0.0);
    for i in N_WARMUP { run_kernel(rows, xs, ys, zs); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        let t0 = now_ms();
        run_kernel(rows, xs, ys, zs);
        s = now_ms() - t0;
    }
    let cs = checksum_f64(xs) ^ checksum_f64(ys) ^ checksum_f64(zs);
    print_result(median_us(samples), cs, N * N_ITERS, 3, N_RUNS);
}
