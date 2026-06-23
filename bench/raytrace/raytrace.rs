// raytrace.rs — a minimal sphere ray tracer: one primary ray per pixel, a
// closest-hit search over a small sphere scene, then Lambert diffuse + ambient
// shading into an f64 framebuffer. The canonical 3-D rendering kernel — a branchy,
// loop-carried scalar pipeline (ray–sphere quadratic, closest-hit select, normal
// + light dot product) that no target auto-vectorizes, so it is a pure
// scalar-codegen race.
//
// Transcendental-free: only +,-,*,/ and sqrt, all IEEE-754 correctly-rounded, so
// the framebuffer is bit-identical across engines and native targets. Go's arm64
// backend force-fuses a*b+c → FMADDD (no flag to disable), so its checksum is the
// documented `fma` parity class, like fft/synth/biquad — same algorithm, last-ulp
// rounding only.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Float64Array, Math.sqrt, no
// class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in pixels/µs, FNV-1a checksum over
// the rendered framebuffer.
use std::time::Instant;

const W: usize = 384;
const H: usize = 384;
const NS: usize = 8;
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

fn checksum_f64(fb: &[f64]) -> u32 {
    // Reinterpret f64 slice as u32 pairs (little-endian), stride 256 u32 — matches JS checksumF64.
    // stride=256 u32 => every step moves 128 f64 elements, always landing on u32 index i%2==0
    // (the low 32 bits of each f64), since 256 is even.
    let mut h = 0x811c_9dc5u32;
    let stride_u32 = 256usize; // stride in u32 units
    let n_u32 = fb.len() * 2;
    let mut i = 0usize; // u32 index
    while i < n_u32 {
        let f_idx = i / 2;
        let half = i & 1; // 0 = low 32 bits, 1 = high 32 bits
        let bits = fb[f_idx].to_bits();
        let word = if half == 0 {
            bits as u32           // low 32 bits
        } else {
            (bits >> 32) as u32   // high 32 bits
        };
        h = mix(h, word);
        i += stride_u32;
    }
    h
}

fn build_scene(sx: &mut [f64], sy: &mut [f64], sz: &mut [f64], sr: &mut [f64],
               cr: &mut [f64], cg: &mut [f64], cb: &mut [f64]) {
    for i in 0..NS {
        sx[i] = ((i % 3) as f64 - 1.0) * 2.2;
        sy[i] = (((i / 3) as f64) - 1.0) * 1.6;
        sz[i] = -5.0 - i as f64 * 1.3;
        sr[i] = 0.7 + (i % 4) as f64 * 0.18;
        cr[i] = 0.30 + (i % 5) as f64 * 0.14;
        cg[i] = 0.25 + (i % 3) as f64 * 0.24;
        cb[i] = 0.40 + (i % 7) as f64 * 0.08;
    }
}

fn render(fb: &mut [f64], sx: &[f64], sy: &[f64], sz: &[f64], sr: &[f64],
          cr: &[f64], cg: &[f64], cb: &[f64],
          lx: f64, ly: f64, lz: f64) {
    for py in 0..H {
        let sv = 1.0 - (py as f64 + 0.5) / H as f64 * 2.0;
        for px in 0..W {
            let su = (px as f64 + 0.5) / W as f64 * 2.0 - 1.0;
            let mut dx = su;
            let mut dy = sv;
            let dz_init = -1.0f64;
            let dinv = 1.0 / (dx * dx + dy * dy + dz_init * dz_init).sqrt();
            dx = dx * dinv;
            dy = dy * dinv;
            let dz = dz_init * dinv;

            let mut t_best = 1e30f64;
            let mut hit: i32 = -1;
            for s in 0..NS {
                let ox = -sx[s];
                let oy = -sy[s];
                let oz = -sz[s];
                let b = ox * dx + oy * dy + oz * dz;
                let c = ox * ox + oy * oy + oz * oz - sr[s] * sr[s];
                let disc = b * b - c;
                if disc > 0.0 {
                    let t = -b - disc.sqrt();
                    if t > 0.001 && t < t_best {
                        t_best = t;
                        hit = s as i32;
                    }
                }
            }

            let mut r = 0.0f64;
            let mut g = 0.0f64;
            let mut bl = 0.0f64;
            if hit >= 0 {
                let h_idx = hit as usize;
                let hx = dx * t_best;
                let hy = dy * t_best;
                let hz = dz * t_best;
                let mut nx = hx - sx[h_idx];
                let mut ny = hy - sy[h_idx];
                let mut nz = hz - sz[h_idx];
                let ninv = 1.0 / (nx * nx + ny * ny + nz * nz).sqrt();
                nx = nx * ninv;
                ny = ny * ninv;
                nz = nz * ninv;
                let mut diff = nx * lx + ny * ly + nz * lz;
                if diff < 0.0 { diff = 0.0; }
                let shade = 0.15 + 0.85 * diff;
                r = cr[h_idx] * shade;
                g = cg[h_idx] * shade;
                bl = cb[h_idx] * shade;
            }
            let o = (py * W + px) * 3;
            fb[o] = r;
            fb[o + 1] = g;
            fb[o + 2] = bl;
        }
    }
}

fn main() {
    let mut sx = [0.0f64; NS];
    let mut sy = [0.0f64; NS];
    let mut sz = [0.0f64; NS];
    let mut sr = [0.0f64; NS];
    let mut cr = [0.0f64; NS];
    let mut cg = [0.0f64; NS];
    let mut cb = [0.0f64; NS];
    build_scene(&mut sx, &mut sy, &mut sz, &mut sr, &mut cr, &mut cg, &mut cb);

    let mut fb = vec![0.0f64; W * H * 3];

    let llen = 1.0 / (0.6f64 * 0.6 + 1.0f64 * 1.0 + 0.5f64 * 0.5).sqrt();
    let lx = -0.6 * llen;
    let ly = 1.0 * llen;
    let lz = 0.5 * llen;

    for _ in 0..N_WARMUP {
        render(&mut fb, &sx, &sy, &sz, &sr, &cr, &cg, &cb, lx, ly, lz);
    }

    let mut samples = [0.0f64; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        render(&mut fb, &sx, &sy, &sz, &sr, &cr, &cg, &cb, lx, ly, lz);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }
    let cs = checksum_f64(&fb);

    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples), cs, W * H, NS, N_RUNS
    );
}
