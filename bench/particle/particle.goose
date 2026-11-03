// particle.goose: Goose port of particle.js (same particles, steps and
// checksum): explicit Euler under gravity over separate f64 arrays per
// component, as the JS keeps them.

import bench from "../_lib";

let N = 1 << 16;            // 65,536 particles
let STEPS = 256;            // frames integrated per run
let DT = 0.015625;          // 1/64 s: exact in f64, keeps the cascade bit-stable
let G = -9.8;               // gravity (units/s²)
let N_RUNS = 21;
let N_WARMUP = 5;

fn seed_state(px: f64[:], py: f64[:], vx: f64[:], vy: f64[:], n: i64) {
    var s: u32 = 0x1234abcd;
    fn r() -> f64 { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return s / 4294967296.0 * 2 - 1; }
    for i in n { px[i] = r(); py[i] = r(); vx[i] = r(); vy[i] = r(); }
}

fn step(px: f64[:], py: f64[:], vx: f64[:], vy: f64[:], n: i64) {
    for i in n {
        let nvy = vy[i] + G * DT;
        px[i] = px[i] + vx[i] * DT;
        py[i] = py[i] + nvy * DT;
        vy[i] = nvy;
    }
}

fn run(px: f64[:], py: f64[:], vx: f64[:], vy: f64[:]) {
    for f in STEPS { step(px, py, vx, vy, N); }
}

fn main() {
    var px: f64[>..] = [];
    var py: f64[>..] = [];
    var vx: f64[>..] = [];
    var vy: f64[>..] = [];
    px.resize(N, 0.0);
    py.resize(N, 0.0);
    vx.resize(N, 0.0);
    vy.resize(N, 0.0);
    for i in N_WARMUP { seed_state(px, py, vx, vy, N); run(px, py, vx, vy); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        seed_state(px, py, vx, vy, N);
        let t0 = now_ms();
        run(px, py, vx, vy);
        t = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(py) ^ checksum_f64(px), N * STEPS, STEPS, N_RUNS);
}
