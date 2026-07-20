// sdf.rs — exact Euclidean distance transform (Felzenszwalb–Huttenlocher) of a glyph-like
// bitmap: the modern text-rendering pipeline's core (SDF atlases) and a staple of
// generative graphics. Two separable passes of the lower-envelope-of-parabolas algorithm:
// per row then per column, each maintaining a hull of parabola vertices in small scratch
// arrays with a data-dependent while-pop — the anti-vectorizer profile: short dependent
// loops, divisions, scratch reuse. All operations (+ − × ÷) are exactly rounded, so the
// squared-distance field is bit-identical across languages.
use std::time::Instant;

const W: usize = 384;
const H: usize = 384;
const INF: f64 = 1e20;
const N_ITERS: usize = 4;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

fn mix(h: u32, x: u32) -> u32 {
    (h ^ x).wrapping_mul(0x0100_0193)
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

fn checksum_f64(xs: &[f64]) -> u32 {
    // Uint32Array view of the f64 buffer (little-endian words: word 2i = low bits of
    // xs[i], word 2i+1 = high bits), stride 256 — matches benchlib.js checksumF64.
    let mut h: u32 = 0x811c_9dc5;
    let n_u32 = xs.len() * 2;
    let mut i = 0usize;
    while i < n_u32 {
        let bits = xs[i >> 1].to_bits();
        let word = if i & 1 == 0 { bits as u32 } else { (bits >> 32) as u32 };
        h = mix(h, word);
        i += 256;
    }
    h
}

struct Rng {
    s: u32,
}
impl Rng {
    fn next(&mut self) -> u32 {
        self.s ^= self.s << 13;
        self.s ^= self.s >> 17;
        self.s ^= self.s << 5;
        self.s
    }
}

fn build_bitmap(bmp: &mut [u8]) {
    let mut rng = Rng { s: 0x77aa123 };
    for i in 0..W * H {
        bmp[i] = 0;
    }
    let w = W as i32;
    for c in 0..30 {
        let cx = 20 + (rng.next() % (W as u32 - 40)) as i32;
        let cy = 20 + (rng.next() % (H as u32 - 40)) as i32;
        let r = 6 + (rng.next() % 25) as i32;
        let r2 = r * r;
        let fill: u8 = if c % 4 == 3 { 0 } else { 1 };
        for y in (cy - r)..=(cy + r) {
            let dy = y - cy;
            for x in (cx - r)..=(cx + r) {
                let dx = x - cx;
                if dx * dx + dy * dy <= r2 {
                    bmp[(y * w + x) as usize] = fill;
                }
            }
        }
    }
}

// 1-D squared-distance transform of f[0..n) into d[0..n), scratch v (hull vertex
// positions, i32) and z (hull boundaries, f64 of length n+1)
fn edt1d(f: &[f64], d: &mut [f64], v: &mut [i32], z: &mut [f64], n: usize) {
    let mut k: usize = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for q in 1..n {
        let qi = q as i32;
        let mut s_mid = ((f[q] + (qi * qi) as f64) - (f[v[k] as usize] + (v[k] * v[k]) as f64))
            / (2.0 * q as f64 - 2.0 * v[k] as f64);
        while s_mid <= z[k] {
            k -= 1;
            s_mid = ((f[q] + (qi * qi) as f64) - (f[v[k] as usize] + (v[k] * v[k]) as f64))
                / (2.0 * q as f64 - 2.0 * v[k] as f64);
        }
        k += 1;
        v[k] = qi;
        z[k] = s_mid;
        z[k + 1] = INF;
    }
    k = 0;
    for q in 0..n {
        while z[k + 1] < q as f64 {
            k += 1;
        }
        let dq = q as i32 - v[k];
        d[q] = (dq * dq) as f64 + f[v[k] as usize];
    }
}

fn transform(bmp: &[u8], dist: &mut [f64], rowf: &mut [f64], rowd: &mut [f64], v: &mut [i32], z: &mut [f64]) {
    // seed: 0 on ink, INF on paper
    for i in 0..W * H {
        dist[i] = if bmp[i] == 1 { 0.0 } else { INF };
    }
    // columns
    for x in 0..W {
        for y in 0..H {
            rowf[y] = dist[y * W + x];
        }
        edt1d(rowf, rowd, v, z, H);
        for y in 0..H {
            dist[y * W + x] = rowd[y];
        }
    }
    // rows
    for y in 0..H {
        let off = y * W;
        for x in 0..W {
            rowf[x] = dist[off + x];
        }
        edt1d(rowf, rowd, v, z, W);
        for x in 0..W {
            dist[off + x] = rowd[x];
        }
    }
}

fn run_kernel(bmp: &[u8], dist: &mut [f64], rowf: &mut [f64], rowd: &mut [f64], v: &mut [i32], z: &mut [f64]) {
    for _ in 0..N_ITERS {
        transform(bmp, dist, rowf, rowd, v, z);
    }
}

fn main() {
    let mut bmp = vec![0u8; W * H];
    let mut dist = vec![0.0f64; W * H];
    let maxwh = if W > H { W } else { H };
    let mut rowf = vec![0.0f64; maxwh];
    let mut rowd = vec![0.0f64; maxwh];
    let mut v = vec![0i32; maxwh];
    let mut z = vec![0.0f64; maxwh + 1];
    build_bitmap(&mut bmp);

    for _ in 0..N_WARMUP {
        run_kernel(&bmp, &mut dist, &mut rowf, &mut rowd, &mut v, &mut z);
    }

    let mut samples = [0.0f64; N_RUNS];
    for s in &mut samples {
        let t0 = Instant::now();
        run_kernel(&bmp, &mut dist, &mut rowf, &mut rowd, &mut v, &mut z);
        *s = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let cs = checksum_f64(&dist);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples),
        cs,
        W * H * N_ITERS,
        2,
        N_RUNS
    );
}
