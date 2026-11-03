// threeanim.rs – QuaternionLinearInterpolant's slerp of ten thousand bone
// rotations: every frame each bone's rotation is interpolated between two
// keyframes by three.js's static Quaternion.slerpFlat over flat Float32
// keyframe buffers at an offset, the animation-mixer kernel.
//
// Ports three.js 0.186.1 (node_modules/three, MIT license, the three.js
// authors) as written: Euler (constructor, set) and Quaternion (constructor,
// setFromEuler with all six rotation orders, toArray, the static slerpFlat with
// its slerp and lerp-then-normalize branches). Each class is a struct of f64
// fields with its methods in an impl, chained methods returning `&mut Self`
// as three.js returns `this`. Euler.set keeps the current order (the case
// passes none), and the change callbacks three.js fires are its empty
// defaults, so they are left out. The keyframe buffers are Float32Arrays in
// the JavaScript: Vec<f32> here, read into f64 and stored back rounded, as JS
// reads and writes them.
//
// Reports: median ms across N_RUNS, slerps per run, and FNV-1a over the nine
// sampled values at single precision (checksumF64Near: acos and sin bits
// differ per libm).
use std::time::Instant;

const N: usize = 10000;
const ITERS: usize = 40;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

fn mix(h: u32, x: u32) -> u32 {
    (h ^ x).wrapping_mul(0x0100_0193)
}

// checksumF64Near (benchlib.js): every value hashed at single precision.
fn checksum_f64_near(out: &[f64]) -> u32 {
    let mut h = 0x811c_9dc5u32;
    for &x in out {
        h = mix(h, (x as f32).to_bits());
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

#[allow(dead_code)]
enum EulerOrder { XYZ, YXZ, ZXY, ZYX, YZX, XZY }

struct Euler { x: f64, y: f64, z: f64, order: EulerOrder }

impl Euler {
    fn new(x: f64, y: f64, z: f64) -> Self {
        Euler { x, y, z, order: EulerOrder::XYZ }
    }

    fn set(&mut self, x: f64, y: f64, z: f64) -> &mut Self {
        self.x = x;
        self.y = y;
        self.z = z;
        self
    }
}

struct Quaternion { x: f64, y: f64, z: f64, w: f64 }

impl Quaternion {
    fn new() -> Self {
        Quaternion { x: 0.0, y: 0.0, z: 0.0, w: 1.0 }
    }

    fn slerp_flat(dst: &mut [f32], dst_offset: usize, src0: &[f32], src_offset0: usize,
                  src1: &[f32], src_offset1: usize, mut t: f64) {
        let mut x0 = src0[src_offset0] as f64;
        let mut y0 = src0[src_offset0 + 1] as f64;
        let mut z0 = src0[src_offset0 + 2] as f64;
        let mut w0 = src0[src_offset0 + 3] as f64;

        let mut x1 = src1[src_offset1] as f64;
        let mut y1 = src1[src_offset1 + 1] as f64;
        let mut z1 = src1[src_offset1 + 2] as f64;
        let mut w1 = src1[src_offset1 + 3] as f64;

        if w0 != w1 || x0 != x1 || y0 != y1 || z0 != z1 {
            let mut dot = x0 * x1 + y0 * y1 + z0 * z1 + w0 * w1;

            if dot < 0.0 {
                x1 = -x1;
                y1 = -y1;
                z1 = -z1;
                w1 = -w1;

                dot = -dot;
            }

            let mut s = 1.0 - t;

            if dot < 0.9995 {
                // slerp
                let theta = dot.acos();
                let sin = theta.sin();

                s = (s * theta).sin() / sin;
                t = (t * theta).sin() / sin;

                x0 = x0 * s + x1 * t;
                y0 = y0 * s + y1 * t;
                z0 = z0 * s + z1 * t;
                w0 = w0 * s + w1 * t;
            } else {
                // for small angles, lerp then normalize
                x0 = x0 * s + x1 * t;
                y0 = y0 * s + y1 * t;
                z0 = z0 * s + z1 * t;
                w0 = w0 * s + w1 * t;

                let f = 1.0 / (x0 * x0 + y0 * y0 + z0 * z0 + w0 * w0).sqrt();

                x0 *= f;
                y0 *= f;
                z0 *= f;
                w0 *= f;
            }
        }

        dst[dst_offset] = x0 as f32;
        dst[dst_offset + 1] = y0 as f32;
        dst[dst_offset + 2] = z0 as f32;
        dst[dst_offset + 3] = w0 as f32;
    }

    fn set_from_euler(&mut self, euler: &Euler) -> &mut Self {
        let (x, y, z) = (euler.x, euler.y, euler.z);

        let c1 = (x / 2.0).cos();
        let c2 = (y / 2.0).cos();
        let c3 = (z / 2.0).cos();

        let s1 = (x / 2.0).sin();
        let s2 = (y / 2.0).sin();
        let s3 = (z / 2.0).sin();

        match euler.order {
            EulerOrder::XYZ => {
                self.x = s1 * c2 * c3 + c1 * s2 * s3;
                self.y = c1 * s2 * c3 - s1 * c2 * s3;
                self.z = c1 * c2 * s3 + s1 * s2 * c3;
                self.w = c1 * c2 * c3 - s1 * s2 * s3;
            }
            EulerOrder::YXZ => {
                self.x = s1 * c2 * c3 + c1 * s2 * s3;
                self.y = c1 * s2 * c3 - s1 * c2 * s3;
                self.z = c1 * c2 * s3 - s1 * s2 * c3;
                self.w = c1 * c2 * c3 + s1 * s2 * s3;
            }
            EulerOrder::ZXY => {
                self.x = s1 * c2 * c3 - c1 * s2 * s3;
                self.y = c1 * s2 * c3 + s1 * c2 * s3;
                self.z = c1 * c2 * s3 + s1 * s2 * c3;
                self.w = c1 * c2 * c3 - s1 * s2 * s3;
            }
            EulerOrder::ZYX => {
                self.x = s1 * c2 * c3 - c1 * s2 * s3;
                self.y = c1 * s2 * c3 + s1 * c2 * s3;
                self.z = c1 * c2 * s3 - s1 * s2 * c3;
                self.w = c1 * c2 * c3 + s1 * s2 * s3;
            }
            EulerOrder::YZX => {
                self.x = s1 * c2 * c3 + c1 * s2 * s3;
                self.y = c1 * s2 * c3 + s1 * c2 * s3;
                self.z = c1 * c2 * s3 - s1 * s2 * c3;
                self.w = c1 * c2 * c3 - s1 * s2 * s3;
            }
            EulerOrder::XZY => {
                self.x = s1 * c2 * c3 - c1 * s2 * s3;
                self.y = c1 * s2 * c3 - s1 * c2 * s3;
                self.z = c1 * c2 * s3 + s1 * s2 * c3;
                self.w = c1 * c2 * c3 + s1 * s2 * s3;
            }
        }
        self
    }

    fn to_array<'a>(&self, array: &'a mut [f32], offset: usize) -> &'a mut [f32] {
        array[offset] = self.x as f32;
        array[offset + 1] = self.y as f32;
        array[offset + 2] = self.z as f32;
        array[offset + 3] = self.w as f32;
        array
    }
}

fn run(out: &mut [f64; 9], src0: &[f32], src1: &[f32], dst: &mut [f32]) {
    let mut s = 0.0;
    for k in 0..ITERS {
        let t = (k % 100) as f64 / 100.0;
        for i in 0..N {
            Quaternion::slerp_flat(dst, i * 4, src0, i * 4, src1, i * 4, t);
        }
        s += dst[(k * 4) % dst.len()] as f64;
    }
    out[0] = s;
    for k in 0..8 {
        out[k + 1] = dst[k * 4099 % dst.len()] as f64;
    }
}

fn main() {
    let mut seed: u32 = 5;
    let mut rnd = || {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        seed as f64 / 4294967296.0
    };

    let mut src0 = vec![0.0f32; N * 4];
    let mut src1 = vec![0.0f32; N * 4];
    let mut dst = vec![0.0f32; N * 4];
    let mut q = Quaternion::new();
    let mut e = Euler::new(0.0, 0.0, 0.0);
    for i in 0..N {
        q.set_from_euler(e.set(rnd() * 6.0, rnd() * 6.0, rnd() * 6.0)).to_array(&mut src0, i * 4);
        q.set_from_euler(e.set(rnd() * 6.0, rnd() * 6.0, rnd() * 6.0)).to_array(&mut src1, i * 4);
    }

    let mut out = [0.0f64; 9];
    for _ in 0..N_WARMUP {
        run(&mut out, &src0, &src1, &mut dst);
    }

    let mut samples = [0.0; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        run(&mut out, &src0, &src1, &mut dst);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let us = median_us(&mut samples);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        us,
        checksum_f64_near(&out),
        N * ITERS,
        1,
        N_RUNS
    );
}
