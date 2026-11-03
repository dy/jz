// worley.rs – Worley (cellular) noise over a grid, 2-D plus 3-D, the
// hash-noise kernel.
//
// Ports pmndrs/math (MIT, Copyright (c) 2026 Isaac Mason, bench/_lib/pmath/LICENSE)
// as written: noise/permutation.js (createPermutation with its p, GRAD3 and
// GRAD4 tables), noise/worley2d.js and noise/worley3d.js (create, sample), each
// JS module a Rust module. The `{ perm, grad3, grad4 }` record is a struct of
// fixed arrays (the JS's Uint8Array(512) and two Float64Arrays); the samplers
// destructure `Permutation { perm, .. }` in their parameter, as the JS
// destructures `{ perm }`. Grid cells are i32, Math.floor of the coordinates;
// the JS's `cx + 71 & 255` is (cx + 71) & 255 by JS precedence (Rust's too)
// and maps cx = -1 to 255 as ToInt32 does. The coordinates stay non-negative
// and small, so every integer is exact. The samplers use no grad tables, but
// createPermutation builds them, so the port does too (outside the timed
// region).
//
// Reports: median ms across N_RUNS, throughput in samples/µs, FNV-1a checksum
// (checksumF64) over the field.
use std::time::Instant;

const SIDE: usize = 96;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

fn mix(h: u32, x: u32) -> u32 {
    (h ^ x).wrapping_mul(0x0100_0193)
}

// FNV-1a over the low 32 bits of every 128th f64 (matches benchlib checksumF64,
// which strides 256 over the Uint32Array view).
fn checksum_f64(out: &[f64]) -> u32 {
    let mut h = 0x811c_9dc5u32;
    let mut i = 0usize;
    while i < out.len() {
        h = mix(h, out[i].to_bits() as u32);
        i += 128;
    }
    h
}

fn median_us(samples: &mut [f64]) -> u64 {
    for i in 1..samples.len() {
        let v = samples[i];
        let mut j = i;
        while j > 0 && samples[j - 1] > v {
            samples[j] = samples[j - 1];
            j -= 1;
        }
        samples[j] = v;
    }
    (samples[(samples.len() - 1) >> 1] * 1000.0) as u64
}

// pmndrs/math noise/permutation
mod permutation {
    const GRAD3: [[f64; 3]; 12] = [
    [1.0, 1.0, 0.0], [-1.0, 1.0, 0.0], [1.0, -1.0, 0.0], [-1.0, -1.0, 0.0], [1.0, 0.0, 1.0],
    [-1.0, 0.0, 1.0], [1.0, 0.0, -1.0], [-1.0, 0.0, -1.0], [0.0, 1.0, 1.0], [0.0, -1.0, 1.0],
    [0.0, 1.0, -1.0], [0.0, -1.0, -1.0],
    ];

    const GRAD4: [[f64; 4]; 32] = [
    [0.0, 1.0, 1.0, 1.0], [0.0, 1.0, 1.0, -1.0], [0.0, 1.0, -1.0, 1.0], [0.0, 1.0, -1.0, -1.0],
    [0.0, -1.0, 1.0, 1.0], [0.0, -1.0, 1.0, -1.0], [0.0, -1.0, -1.0, 1.0], [0.0, -1.0, -1.0, -1.0],
    [1.0, 0.0, 1.0, 1.0], [1.0, 0.0, 1.0, -1.0], [1.0, 0.0, -1.0, 1.0], [1.0, 0.0, -1.0, -1.0],
    [-1.0, 0.0, 1.0, 1.0], [-1.0, 0.0, 1.0, -1.0], [-1.0, 0.0, -1.0, 1.0], [-1.0, 0.0, -1.0, -1.0],
    [1.0, 1.0, 0.0, 1.0], [1.0, 1.0, 0.0, -1.0], [1.0, -1.0, 0.0, 1.0], [1.0, -1.0, 0.0, -1.0],
    [-1.0, 1.0, 0.0, 1.0], [-1.0, 1.0, 0.0, -1.0], [-1.0, -1.0, 0.0, 1.0], [-1.0, -1.0, 0.0, -1.0],
    [1.0, 1.0, 1.0, 0.0], [1.0, 1.0, -1.0, 0.0], [1.0, -1.0, 1.0, 0.0], [1.0, -1.0, -1.0, 0.0],
    [-1.0, 1.0, 1.0, 0.0], [-1.0, 1.0, -1.0, 0.0], [-1.0, -1.0, 1.0, 0.0], [-1.0, -1.0, -1.0, 0.0],
    ];

    const P: [u8; 256] = [
    151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140, 36, 103, 30, 69,
    142, 8, 99, 37, 240, 21, 10, 23, 190, 6, 148, 247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219,
    203, 117, 35, 11, 32, 57, 177, 33, 88, 237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175,
    74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229, 122, 60, 211, 133, 230,
    220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54, 65, 25, 63, 161, 1, 216, 80, 73, 209, 76,
    132, 187, 208, 89, 18, 169, 200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186,
    3, 64, 52, 217, 226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212, 207, 206, 59,
    227, 47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170, 213, 119, 248, 152, 2, 44, 154, 163, 70,
    221, 153, 101, 155, 167, 43, 172, 9, 129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232, 178,
    185, 112, 104, 218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12, 191, 179, 162, 241, 81,
    51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157, 184, 84, 204, 176, 115,
    121, 50, 45, 127, 4, 150, 254, 138, 236, 205, 93, 222, 114, 67, 29, 24, 72, 243, 141, 128, 195,
    78, 66, 215, 61, 156, 180,
    ];

    pub struct Permutation {
        pub perm: [u8; 512],
        pub grad3: [f64; 512 * 3],
        pub grad4: [f64; 512 * 4],
    }

    pub fn create_permutation(mut seed: f64) -> Permutation {
        if seed > 0.0 && seed < 1.0 {
            seed *= 65536.0;
        }
        // every later use of the seed is ToInt32 (|, &, >>), a plain
        // conversion for the case's seed of 42
        let mut s = seed.floor() as i32;
        if s < 256 {
            s |= s << 8;
        }
        let mut pt = Permutation { perm: [0; 512], grad3: [0.0; 512 * 3], grad4: [0.0; 512 * 4] };
        for i in 0..256 {
            let v = (if i & 1 != 0 { P[i] as i32 ^ s & 255 } else { P[i] as i32 ^ s >> 8 & 255 }) as usize;
            pt.perm[i] = v as u8;
            pt.perm[i + 256] = v as u8;
            let g3 = &GRAD3[v % 12];
            let g4 = &GRAD4[v % 32];
            for k in 0..3 {
                pt.grad3[i * 3 + k] = g3[k];
                pt.grad3[(i + 256) * 3 + k] = g3[k];
            }
            for k in 0..4 {
                pt.grad4[i * 4 + k] = g4[k];
                pt.grad4[(i + 256) * 4 + k] = g4[k];
            }
        }
        pt
    }
}

// pmndrs/math noise/worley2d
mod worley2d {
    use super::permutation::{create_permutation, Permutation};

    pub fn create(seed: f64) -> Permutation {
        create_permutation(seed)
    }

    pub fn sample(Permutation { perm, .. }: &Permutation, x: f64, y: f64) -> f64 {
        let ix = x.floor() as i32;
        let iy = y.floor() as i32;
        let mut f1 = f64::INFINITY;
        for gy in -1..=1 {
            let cy = iy + gy;
            let py = perm[(cy & 255) as usize] as usize;
            let qy = perm[(cy + 37 & 255) as usize] as usize;
            for gx in -1..=1 {
                let cx = ix + gx;
                let rx = perm[(cx & 255) as usize + py] as f64 / 256.0;
                let ry = perm[(cx + 71 & 255) as usize + qy] as f64 / 256.0;
                let dx = cx as f64 + rx - x;
                let dy = cy as f64 + ry - y;
                let d2 = dx * dx + dy * dy;
                if d2 < f1 {
                    f1 = d2;
                }
            }
        }
        f1.sqrt()
    }
}

// pmndrs/math noise/worley3d
mod worley3d {
    use super::permutation::{create_permutation, Permutation};

    pub fn create(seed: f64) -> Permutation {
        create_permutation(seed)
    }

    pub fn sample(Permutation { perm, .. }: &Permutation, x: f64, y: f64, z: f64) -> f64 {
        let ix = x.floor() as i32;
        let iy = y.floor() as i32;
        let iz = z.floor() as i32;
        let mut f1 = f64::INFINITY;
        for gz in -1..=1 {
            let cz = iz + gz;
            let pz = perm[(cz & 255) as usize] as usize;
            let qz = perm[(cz + 13 & 255) as usize] as usize;
            let sz = perm[(cz + 97 & 255) as usize] as usize;
            for gy in -1..=1 {
                let cy = iy + gy;
                let py = perm[(cy & 255) as usize + pz] as usize;
                let qy = perm[(cy + 37 & 255) as usize + qz] as usize;
                let sy = perm[(cy + 53 & 255) as usize + sz] as usize;
                for gx in -1..=1 {
                    let cx = ix + gx;
                    let rx = perm[(cx & 255) as usize + py] as f64 / 256.0;
                    let ry = perm[(cx + 71 & 255) as usize + qy] as f64 / 256.0;
                    let rz = perm[(cx + 23 & 255) as usize + sy] as f64 / 256.0;
                    let dx = cx as f64 + rx - x;
                    let dy = cy as f64 + ry - y;
                    let dz = cz as f64 + rz - z;
                    let d2 = dx * dx + dy * dy + dz * dz;
                    if d2 < f1 {
                        f1 = d2;
                    }
                }
            }
        }
        f1.sqrt()
    }
}

use permutation::Permutation;

fn run(out: &mut [f64], w2: &Permutation, w3: &Permutation) {
    let mut k = 0;
    for y in 0..SIDE {
        for x in 0..SIDE {
            let fx = x as f64 * 0.11;
            let fy = y as f64 * 0.13;
            out[k] = worley2d::sample(w2, fx, fy) + worley3d::sample(w3, fx, fy, (x + y) as f64 * 0.07);
            k += 1;
        }
    }
}

fn main() {
    let w2 = worley2d::create(42.0);
    let w3 = worley3d::create(42.0);

    let mut out = vec![0.0f64; SIDE * SIDE];
    for _ in 0..N_WARMUP {
        run(&mut out, &w2, &w3);
    }

    let mut samples = [0.0; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        run(&mut out, &w2, &w3);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let us = median_us(&mut samples);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        us,
        checksum_f64(&out),
        SIDE * SIDE,
        2,
        N_RUNS
    );
}
