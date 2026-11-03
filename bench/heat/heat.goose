// heat.goose: Goose port of heat.js (same field, coefficient, steps and
// checksum): explicit 2-D heat diffusion, a 5-point stencil ping-ponged
// between two f64 fields with a fixed border.

import bench from "../_lib";

let W = 258;                // 256×256 interior + a 1-cell fixed (Dirichlet) border
let H = 258;
let K = 0.125;              // diffusion coefficient (≤ ¼: stable); 1/8 is exact in f64
let STEPS = 100;            // even: after the ping-pong the field lands back in `a`
let N_RUNS = 21;
let N_WARMUP = 5;

fn seed(a: f64[:]) {
    var s: u32 = 0x1234abcd;
    for &v in a {
        s ^= s << 13; s ^= s >> 17; s ^= s << 5;
        v = s & 255;
    }
}

fn step(src: f64[:], dst: f64[:], w: i64, h: i64) {
    for y in 1..h - 1 {
        let row = y * w;
        for x in 1..w - 1 {
            let c = row + x;
            dst[c] = src[c] + K * (src[c - 1] + src[c + 1] + src[c - w] + src[c + w] - 4 * src[c]);
        }
    }
}

fn run(a: f64[:], b: f64[:]) {
    var s = 0;
    while s < STEPS {
        step(a, b, W, H);
        step(b, a, W, H);
        s += 2;
    }
}

fn main() {
    var a: f64[>..] = [];
    var b: f64[>..] = [];
    a.resize(W * H, 0.0);
    b.resize(W * H, 0.0);
    for i in N_WARMUP { seed(a); seed(b); run(a, b); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        seed(a); seed(b);           // borders identical in both buffers; re-seed per run
        let t0 = now_ms();
        run(a, b);
        t = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(a), (W - 2) * (H - 2) * STEPS, 6, N_RUNS);
}
