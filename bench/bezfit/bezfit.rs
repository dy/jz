// bezfit.rs — least-squares cubic Bézier fitting over digitized point runs: the heart of
// bitmap→vector conversion and font autotracing (Schneider's algorithm, as in potrace /
// FontForge). Per run: chord-length parameterize, estimate end tangents, solve the 2×2
// normal equations for the two inner control points (Bernstein-basis integrals), then one
// Newton–Raphson reparameterization pass and a second solve. Small hot loops over short
// runs, mixed dot products and per-point polynomial evaluation, division and sqrt only —
// every operation exactly rounded, so control points are bit-identical across languages.
use std::time::Instant;

const RUNS: usize = 256; // digitized strokes
const K: usize = 48;     // points per stroke
const N_ITERS: usize = 6;
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

// deterministic wobbly strokes: cubic polynomial paths + small xorshift jitter
fn build_runs(pts: &mut [f64]) {
    let mut rng = Rng { s: 0x9b3f017 };
    for r in 0..RUNS {
        let ax = (rng.next() % 1000) as f64 * 0.1;
        let ay = (rng.next() % 1000) as f64 * 0.1;
        let bx = ((rng.next() % 2000) as f64 - 1000.0) * 0.05;
        let by = ((rng.next() % 2000) as f64 - 1000.0) * 0.05;
        let cx = ((rng.next() % 2000) as f64 - 1000.0) * 0.003;
        let cy = ((rng.next() % 2000) as f64 - 1000.0) * 0.003;
        for i in 0..K {
            let t = i as f64 / (K - 1) as f64;
            let j = ((rng.next() % 100) as f64 - 50.0) * 0.002;
            pts[(r * K + i) * 2] = ax + bx * t * 10.0 + cx * t * t * 100.0 + j;
            pts[(r * K + i) * 2 + 1] = ay + by * t * 10.0 + cy * t * t * t * 100.0 - j;
        }
    }
}

// Bernstein basis
fn b0(t: f64) -> f64 {
    let u = 1.0 - t;
    u * u * u
}
fn b1(t: f64) -> f64 {
    let u = 1.0 - t;
    3.0 * t * u * u
}
fn b2(t: f64) -> f64 {
    let u = 1.0 - t;
    3.0 * t * t * u
}
fn b3(t: f64) -> f64 {
    t * t * t
}

// fit one run [o, o+K) given parameter values u[]; writes 8 control values into ctrl at co
fn fit_once(pts: &[f64], o: usize, u: &[f64], ctrl: &mut [f64], co: usize) {
    let x0 = pts[o * 2];
    let y0 = pts[o * 2 + 1];
    let x3 = pts[(o + K - 1) * 2];
    let y3 = pts[(o + K - 1) * 2 + 1];
    // end tangents from first/last chords, normalized
    let mut t1x = pts[(o + 1) * 2] - x0;
    let mut t1y = pts[(o + 1) * 2 + 1] - y0;
    let mut l = (t1x * t1x + t1y * t1y).sqrt();
    if l < 1e-12 {
        l = 1.0;
    }
    t1x /= l;
    t1y /= l;
    let mut t2x = pts[(o + K - 2) * 2] - x3;
    let mut t2y = pts[(o + K - 2) * 2 + 1] - y3;
    l = (t2x * t2x + t2y * t2y).sqrt();
    if l < 1e-12 {
        l = 1.0;
    }
    t2x /= l;
    t2y /= l;
    // normal equations for alpha1, alpha2 (Schneider): A_i = tangent · basis
    let mut c00 = 0.0;
    let mut c01 = 0.0;
    let mut c11 = 0.0;
    let mut xr1 = 0.0;
    let mut xr2 = 0.0;
    for i in 0..K {
        let t = u[i];
        let a1x = t1x * b1(t);
        let a1y = t1y * b1(t);
        let a2x = t2x * b2(t);
        let a2y = t2y * b2(t);
        let sx = pts[(o + i) * 2] - (x0 * (b0(t) + b1(t)) + x3 * (b2(t) + b3(t)));
        let sy = pts[(o + i) * 2 + 1] - (y0 * (b0(t) + b1(t)) + y3 * (b2(t) + b3(t)));
        c00 += a1x * a1x + a1y * a1y;
        c01 += a1x * a2x + a1y * a2y;
        c11 += a2x * a2x + a2y * a2y;
        xr1 += a1x * sx + a1y * sy;
        xr2 += a2x * sx + a2y * sy;
    }
    let mut det = c00 * c11 - c01 * c01;
    if det < 1e-12 && det > -1e-12 {
        det = 1e-12;
    }
    let alpha1 = (xr1 * c11 - xr2 * c01) / det;
    let alpha2 = (xr2 * c00 - xr1 * c01) / det;
    ctrl[co] = x0;
    ctrl[co + 1] = y0;
    ctrl[co + 2] = x0 + t1x * alpha1;
    ctrl[co + 3] = y0 + t1y * alpha1;
    ctrl[co + 4] = x3 + t2x * alpha2;
    ctrl[co + 5] = y3 + t2y * alpha2;
    ctrl[co + 6] = x3;
    ctrl[co + 7] = y3;
}

// one Newton–Raphson step per point: move u_i toward the curve's closest approach
fn reparam(pts: &[f64], o: usize, u: &mut [f64], ctrl: &[f64], co: usize) {
    let p0x = ctrl[co];
    let p0y = ctrl[co + 1];
    let p1x = ctrl[co + 2];
    let p1y = ctrl[co + 3];
    let p2x = ctrl[co + 4];
    let p2y = ctrl[co + 5];
    let p3x = ctrl[co + 6];
    let p3y = ctrl[co + 7];
    for i in 1..K - 1 {
        let t = u[i];
        let qx = p0x * b0(t) + p1x * b1(t) + p2x * b2(t) + p3x * b3(t);
        let qy = p0y * b0(t) + p1y * b1(t) + p2y * b2(t) + p3y * b3(t);
        let un = 1.0 - t;
        let d1x = 3.0 * (un * un * (p1x - p0x) + 2.0 * un * t * (p2x - p1x) + t * t * (p3x - p2x));
        let d1y = 3.0 * (un * un * (p1y - p0y) + 2.0 * un * t * (p2y - p1y) + t * t * (p3y - p2y));
        let d2x = 6.0 * (un * (p2x - 2.0 * p1x + p0x) + t * (p3x - 2.0 * p2x + p1x));
        let d2y = 6.0 * (un * (p2y - 2.0 * p1y + p0y) + t * (p3y - 2.0 * p2y + p1y));
        let dx = qx - pts[(o + i) * 2];
        let dy = qy - pts[(o + i) * 2 + 1];
        let num = dx * d1x + dy * d1y;
        let den = d1x * d1x + d1y * d1y + dx * d2x + dy * d2y;
        if den > 1e-12 || den < -1e-12 {
            let mut nu = t - num / den;
            if nu < 0.0 {
                nu = 0.0;
            }
            if nu > 1.0 {
                nu = 1.0;
            }
            u[i] = nu;
        }
    }
}

fn run_kernel(pts: &[f64], u: &mut [f64], ctrl: &mut [f64]) {
    for _ in 0..N_ITERS {
        for r in 0..RUNS {
            let o = r * K;
            // chord-length parameterization
            u[0] = 0.0;
            for i in 1..K {
                let dx = pts[(o + i) * 2] - pts[(o + i - 1) * 2];
                let dy = pts[(o + i) * 2 + 1] - pts[(o + i - 1) * 2 + 1];
                u[i] = u[i - 1] + (dx * dx + dy * dy).sqrt();
            }
            let inv = 1.0 / u[K - 1];
            for i in 1..K {
                u[i] *= inv;
            }
            let co = r * 8;
            fit_once(pts, o, u, ctrl, co);
            reparam(pts, o, u, ctrl, co);
            fit_once(pts, o, u, ctrl, co);
        }
    }
}

fn main() {
    let mut pts = vec![0.0f64; RUNS * K * 2];
    let mut u = vec![0.0f64; K];
    let mut ctrl = vec![0.0f64; RUNS * 8];
    build_runs(&mut pts);

    for _ in 0..N_WARMUP {
        run_kernel(&pts, &mut u, &mut ctrl);
    }

    let mut samples = [0.0f64; N_RUNS];
    for s in &mut samples {
        let t0 = Instant::now();
        run_kernel(&pts, &mut u, &mut ctrl);
        *s = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let cs = checksum_f64(&ctrl);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples),
        cs,
        RUNS * K * N_ITERS,
        3,
        N_RUNS
    );
}
