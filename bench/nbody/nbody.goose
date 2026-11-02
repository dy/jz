// nbody.goose: Goose port of nbody.js (same bodies, steps and checksum):
// direct-summation N-body with softened gravity over separate f64 arrays per
// component, as the JS, C and Rust versions keep them.

import bench from "../_lib";
import math;

let N = 1024;               // bodies
let STEPS = 8;              // integration steps per run
let DT = 0.01;
let EPS2 = 0.05;            // softening², avoids the i == j singularity (self-force = 0)
let N_RUNS = 21;
let N_WARMUP = 5;

var px = [0.0; N];
var py = [0.0; N];
var pz = [0.0; N];
var vx = [0.0; N];
var vy = [0.0; N];
var vz = [0.0; N];
var m = [0.0; N];

// Deterministic initial state: XorShift32 in [-1, 1); masses in [0.5, 2.5).
fn seed_state() {
    var s: u32 = 0x1234abcd;
    fn r() -> f64 { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return s / 4294967296.0 * 2 - 1; }
    for i in N {
        px[i] = r(); py[i] = r(); pz[i] = r();
        vx[i] = r() * 0.1; vy[i] = r() * 0.1; vz[i] = r() * 0.1;
        m[i] = r() + 1.5;
    }
}

// One step: accumulate the acceleration on every body from every other, kick
// the velocities, then drift the positions.
fn step() {
    for i in N {
        let xi = px[i];
        let yi = py[i];
        let zi = pz[i];
        var ax = 0.0;
        var ay = 0.0;
        var az = 0.0;
        for j in N {
            let dx = px[j] - xi;
            let dy = py[j] - yi;
            let dz = pz[j] - zi;
            let r2 = dx * dx + dy * dy + dz * dz + EPS2;
            let inv = 1 / (r2 * sqrt(r2));        // r2^-1.5
            let f = m[j] * inv;
            ax += dx * f; ay += dy * f; az += dz * f;
        }
        vx[i] += ax * DT; vy[i] += ay * DT; vz[i] += az * DT;
    }
    for i in N { px[i] += vx[i] * DT; py[i] += vy[i] * DT; pz[i] += vz[i] * DT; }
}

fn run_all() { for s in STEPS { step(); } }

fn main() {
    for i in N_WARMUP { seed_state(); run_all(); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        seed_state();
        let t0 = now_ms();
        run_all();
        s = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(px) ^ checksum_f64(vx), N * N * STEPS, STEPS, N_RUNS);
}
