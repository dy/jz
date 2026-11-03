// lorenz.goose: Goose port of lorenz.js (same start, step and checksum): the
// Lorenz system integrated with classic RK4, one point recorded per 16 steps.

import bench from "../_lib";

let N_SAMPLES = 1 << 16;    // 65,536 points recorded along the trajectory
let SUBSTEPS = 16;          // integration steps between recorded samples
let DT = 0.002;
let SIGMA = 10.0;
let RHO = 28.0;
let BETA = 8.0 / 3.0;
let N_RUNS = 21;
let N_WARMUP = 5;

fn integrate(xs: f64[:]) {
    let h = DT * 0.5;
    let s6 = DT / 6;
    var x = 0.1;
    var y = 0.0;
    var z = 0.0;
    for s in N_SAMPLES {
        for i in SUBSTEPS {
            let k1x = SIGMA * (y - x);   let k1y = x * (RHO - z) - y;    let k1z = x * y - BETA * z;
            let ax = x + k1x * h;        let ay = y + k1y * h;           let az = z + k1z * h;
            let k2x = SIGMA * (ay - ax); let k2y = ax * (RHO - az) - ay; let k2z = ax * ay - BETA * az;
            let bx = x + k2x * h;        let by = y + k2y * h;           let bz = z + k2z * h;
            let k3x = SIGMA * (by - bx); let k3y = bx * (RHO - bz) - by; let k3z = bx * by - BETA * bz;
            let cx = x + k3x * DT;       let cy = y + k3y * DT;          let cz = z + k3z * DT;
            let k4x = SIGMA * (cy - cx); let k4y = cx * (RHO - cz) - cy; let k4z = cx * cy - BETA * cz;
            x = x + s6 * (k1x + 2 * k2x + 2 * k3x + k4x);
            y = y + s6 * (k1y + 2 * k2y + 2 * k3y + k4y);
            z = z + s6 * (k1z + 2 * k2z + 2 * k3z + k4z);
        }
        xs[s] = x + y + z;
    }
}

fn main() {
    var xs: f64[>..] = [];
    xs.resize(N_SAMPLES, 0.0);
    for i in N_WARMUP { integrate(xs); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        integrate(xs);
        t = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(xs), N_SAMPLES * SUBSTEPS, SUBSTEPS, N_RUNS);
}
