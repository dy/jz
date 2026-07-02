// immutable.rs — a particle step in the immutable-update idiom: every step
// replaces each record wholesale instead of mutating fields. The canonical
// functional-state kernel (reducers, persistent game state, event-sourced
// models). Rust gets the pattern free through value semantics — a Copy struct
// assigned by value, zero allocation — the static reference for what the
// fresh-object JS idiom costs. Pure integer bounce physics, so positions are
// bit-identical across every engine and native target.
//
// Reports: median ms across N_RUNS, throughput in particle-steps/µs, FNV-1a
// checksum over the per-pass position folds.
use std::time::Instant;

const N: usize = 4096;           // particles
const STEPS: usize = 32;         // steps per pass (one record replacement per particle per step)
const LIM: i32 = 1023;           // box bound
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

#[derive(Clone, Copy)]
struct P {
    x: i32,
    y: i32,
    vx: i32,
    vy: i32,
}

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

// Deterministic initial state — XorShift32 positions in [0, LIM], velocities
// in [-8, 8] forced nonzero, identical per target.
fn init_particles() -> Vec<P> {
    let mut ps = Vec::with_capacity(N);
    let mut s: i32 = 0x1234abcd_u32 as i32;
    for _ in 0..N {
        s ^= s << 13;
        s ^= ((s as u32) >> 17) as i32; // >>> 17 (unsigned right shift)
        s ^= s << 5;
        let vx = (((s as u32) >> 4) & 15) as i32 - 8;
        let vy = (((s as u32) >> 8) & 15) as i32 - 8;
        ps.push(P {
            x: (((s as u32) >> 12) & LIM as u32) as i32,
            y: (((s as u32) >> 20) & LIM as u32) as i32,
            vx: if vx == 0 { 1 } else { vx },
            vy: if vy == 0 { 1 } else { vy },
        });
    }
    ps
}

fn run_kernel(ps: &mut [P]) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for it in 0..STEPS {
        let mut sum: i32 = it as i32;
        for i in 0..N {
            let p = ps[i];
            let nx = p.x + p.vx;
            let ny = p.y + p.vy;
            let hit_x = nx < 0 || nx > LIM;
            let hit_y = ny < 0 || ny > LIM;
            let x = if hit_x { p.x } else { nx };
            let y = if hit_y { p.y } else { ny };
            let vx = if hit_x { -p.vx } else { p.vx };
            let vy = if hit_y { -p.vy } else { p.vy };
            ps[i] = P { x, y, vx, vy };
            sum = sum.wrapping_add(x).wrapping_add(y.wrapping_mul(31));
        }
        h = mix(h, sum as u32);
    }
    h
}

fn main() {
    let mut cs = 0u32;
    // Fresh particle set per run — the kernel mutates the array, so timing runs
    // must not compound each other's motion.
    for _ in 0..N_WARMUP {
        let mut ps = init_particles();
        cs = run_kernel(&mut ps);
    }

    let mut samples = [0.0f64; N_RUNS];
    for s in &mut samples {
        let mut ps = init_particles();
        let t0 = Instant::now();
        cs = run_kernel(&mut ps);
        *s = t0.elapsed().as_secs_f64() * 1000.0;
    }

    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples),
        cs,
        N * STEPS,
        1,
        N_RUNS
    );
}
