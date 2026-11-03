// worley.goose: Goose port of worley.js (same seed, field and checksum):
// 2-D plus 3-D Worley (cellular) noise over a grid, with pmndrs/math's
// worley2d, worley3d and permutation code ported as written. The noise state
// is one record of fixed tables: the byte permutation and the gradient tables
// the library builds beside it.

import bench from "../_lib";
import math;

let SIDE = 96;
let N_RUNS = 21;
let N_WARMUP = 5;
let INFINITY = 1e309;       // past f64's range: +inf, JS's Infinity

// pmndrs/math noise/permutation
let GRAD3 = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1],
             [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]];
let GRAD4 = [[0, 1, 1, 1], [0, 1, 1, -1], [0, 1, -1, 1], [0, 1, -1, -1], [0, -1, 1, 1], [0, -1, 1, -1],
             [0, -1, -1, 1], [0, -1, -1, -1], [1, 0, 1, 1], [1, 0, 1, -1], [1, 0, -1, 1], [1, 0, -1, -1],
             [-1, 0, 1, 1], [-1, 0, 1, -1], [-1, 0, -1, 1], [-1, 0, -1, -1], [1, 1, 0, 1], [1, 1, 0, -1],
             [1, -1, 0, 1], [1, -1, 0, -1], [-1, 1, 0, 1], [-1, 1, 0, -1], [-1, -1, 0, 1], [-1, -1, 0, -1],
             [1, 1, 1, 0], [1, 1, -1, 0], [1, -1, 1, 0], [1, -1, -1, 0], [-1, 1, 1, 0], [-1, 1, -1, 0],
             [-1, -1, 1, 0], [-1, -1, -1, 0]];
let P = [151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140, 36, 103, 30, 69, 142,
         8, 99, 37, 240, 21, 10, 23, 190, 6, 148, 247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117,
         35, 11, 32, 57, 177, 33, 88, 237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175, 74, 165, 71,
         134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229, 122, 60, 211, 133, 230, 220, 105, 92, 41,
         55, 46, 245, 40, 244, 102, 143, 54, 65, 25, 63, 161, 1, 216, 80, 73, 209, 76, 132, 187, 208, 89,
         18, 169, 200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186, 3, 64, 52, 217, 226,
         250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212, 207, 206, 59, 227, 47, 16, 58, 17, 182,
         189, 28, 42, 223, 183, 170, 213, 119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43,
         172, 9, 129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232, 178, 185, 112, 104, 218, 246, 97,
         228, 251, 34, 242, 193, 238, 210, 144, 12, 191, 179, 162, 241, 81, 51, 145, 235, 249, 14, 239,
         107, 49, 192, 214, 31, 181, 199, 106, 157, 184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150, 254,
         138, 236, 205, 93, 222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215, 61, 156, 180];

struct Permutation { perm: u8[512], grad3: f64[512 * 3], grad4: f64[512 * 4] }

fn create_permutation(seed0: f64) -> Permutation {
    var seed = seed0;
    if seed > 0 && seed < 1 { seed *= 65536; }
    var s = floor(seed) as i64;
    if s < 256 { s |= s << 8; }
    var pt = default<Permutation>();
    for i in 256 {
        let v = if i & 1 != 0 { P[i] ^ s & 255 } else { P[i] ^ s >> 8 & 255 };
        pt.perm[i] = v as u8;
        pt.perm[i + 256] = v as u8;
        let g3 = GRAD3[v % 12];
        let g4 = GRAD4[v % 32];
        for k in 3 { pt.grad3[i * 3 + k] = g3[k]; pt.grad3[(i + 256) * 3 + k] = g3[k]; }
        for k in 4 { pt.grad4[i * 4 + k] = g4[k]; pt.grad4[(i + 256) * 4 + k] = g4[k]; }
    }
    return pt;
}

// pmndrs/math noise/worley2d
fn sample2d(pt: Permutation&, x: f64, y: f64) -> f64 {
    let perm .= pt.perm;
    let ix = floor(x) as i64;
    let iy = floor(y) as i64;
    var f1 = INFINITY;
    for gy in -1..2 {
        let cy = iy + gy;
        let py = perm[cy & 255];
        let qy = perm[cy + 37 & 255];
        for gx in -1..2 {
            let cx = ix + gx;
            let rx = perm[(cx & 255) + py] / 256.0;
            let ry = perm[(cx + 71 & 255) + qy] / 256.0;
            let dx = cx + rx - x;
            let dy = cy + ry - y;
            let d2 = dx * dx + dy * dy;
            if d2 < f1 { f1 = d2; }
        }
    }
    return sqrt(f1);
}

// pmndrs/math noise/worley3d
fn sample3d(pt: Permutation&, x: f64, y: f64, z: f64) -> f64 {
    let perm .= pt.perm;
    let ix = floor(x) as i64;
    let iy = floor(y) as i64;
    let iz = floor(z) as i64;
    var f1 = INFINITY;
    for gz in -1..2 {
        let cz = iz + gz;
        let pz = perm[cz & 255];
        let qz = perm[cz + 13 & 255];
        let sz = perm[cz + 97 & 255];
        for gy in -1..2 {
            let cy = iy + gy;
            let py = perm[(cy & 255) + pz];
            let qy = perm[(cy + 37 & 255) + qz];
            let sy = perm[(cy + 53 & 255) + sz];
            for gx in -1..2 {
                let cx = ix + gx;
                let rx = perm[(cx & 255) + py] / 256.0;
                let ry = perm[(cx + 71 & 255) + qy] / 256.0;
                let rz = perm[(cx + 23 & 255) + sy] / 256.0;
                let dx = cx + rx - x;
                let dy = cy + ry - y;
                let dz = cz + rz - z;
                let d2 = dx * dx + dy * dy + dz * dz;
                if d2 < f1 { f1 = d2; }
            }
        }
    }
    return sqrt(f1);
}

fn run(out: f64[:], w2: Permutation&, w3: Permutation&) {
    var k = 0;
    for y in SIDE {
        for x in SIDE {
            let fx = x * 0.11;
            let fy = y * 0.13;
            out[k] = sample2d(w2, fx, fy) + sample3d(w3, fx, fy, (x + y) * 0.07);
            k++;
        }
    }
}

fn main() {
    var w2 = create_permutation(42);
    var w3 = create_permutation(42);
    var out: f64[>..] = [];
    out.resize(SIDE * SIDE, 0.0);
    for i in N_WARMUP { run(out, w2, w3); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        run(out, w2, w3);
        t = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(out), SIDE * SIDE, 2, N_RUNS);
}
