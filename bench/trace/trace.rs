// trace.rs — square-tracing contour following over a bitmap: the first stage of every
// bitmap→vector pipeline (potrace, font autotracers). Scan for an untraced boundary
// pixel, then walk the contour with the square-tracing rule — standing on ink turn
// left, standing on paper turn right, step forward — emitting a chain code per step
// until the walk returns to its start pose (Jacob's criterion). The profile is what
// autovectorizers never touch: a tight data-dependent state machine, unpredictable
// branches, 2-D indexing, per-pixel bookkeeping — pure scalar codegen quality, branch
// layout, and bounds-check elimination.
//
// Single source compiled by all targets and run directly by the JS engines.
// Subset: const/let + arrows, typed arrays, no class/async/regex.
//
// Reports: median ms across N_RUNS, FNV-1a checksum over chain codes + loop lengths.
use std::time::Instant;

const W: i32 = 512;
const H: i32 = 512;
const N_ITERS: usize = 4;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;
const MAXCODES: usize = 1 << 18;

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

// bitmap: union of deterministic circles (xorshift placement) — islands and punched
// lakes, so the tracer meets outer and inner contours; 1px empty frame guaranteed
fn build_bitmap(bmp: &mut [u8]) {
    let mut s: u32 = 0x51ce7a3;
    let next = |s: &mut u32| -> u32 {
        *s ^= *s << 13;
        *s ^= *s >> 17;
        *s ^= *s << 5;
        *s
    };
    for v in bmp.iter_mut() { *v = 0; }
    for c in 0..42i32 {
        let cx = 44 + (next(&mut s) % (W as u32 - 88)) as i32;
        let cy = 44 + (next(&mut s) % (H as u32 - 88)) as i32;
        let r = 8 + (next(&mut s) % 33) as i32;
        let r2 = r * r;
        let fill: u8 = if c % 5 == 4 { 0 } else { 1 };
        for y in (cy - r)..=(cy + r) {
            let dy = y - cy;
            for x in (cx - r)..=(cx + r) {
                let dx = x - cx;
                if dx * dx + dy * dy <= r2 {
                    bmp[(y * W + x) as usize] = fill;
                }
            }
        }
    }
}

// square tracing from (sx,sy) entering northward: on ink turn left, on paper turn
// right, then step. dx/dy per dir: 0=E 1=S 2=W 3=N. Marks traced ink in `visited`.
fn trace_loop(bmp: &[u8], visited: &mut [u8], codes: &mut [u8], nc_in: usize, sx: i32, sy: i32) -> usize {
    let mut x = sx;
    let mut y = sy;
    let mut dir: i32 = 3;
    let mut steps = 0usize;
    let mut nc = nc_in;
    while steps < MAXCODES {
        let inside = x >= 0 && x < W && y >= 0 && y < H && bmp[(y * W + x) as usize] == 1;
        if inside {
            visited[(y * W + x) as usize] = 1;
            dir = (dir + 3) & 3;
        } else {
            dir = (dir + 1) & 3;
        }
        if nc < MAXCODES {
            codes[nc] = dir as u8;
            nc += 1;
        }
        if dir == 0 { x += 1; }
        else if dir == 1 { y += 1; }
        else if dir == 2 { x -= 1; }
        else { y -= 1; }
        steps += 1;
        if x == sx && y == sy && dir == 3 { break; }
    }
    nc
}

fn trace_all(bmp: &[u8], visited: &mut [u8], codes: &mut [u8]) -> u32 {
    let mut nc = 0usize;
    let mut h: u32 = 0;
    for v in visited.iter_mut() { *v = 0; }
    for y in 1..(H - 1) {
        for x in 1..(W - 1) {
            // boundary start: ink with paper to the west, not already traced
            if bmp[(y * W + x) as usize] == 1 && bmp[(y * W + x - 1) as usize] == 0 && visited[(y * W + x) as usize] == 0 {
                let start = nc;
                nc = trace_loop(bmp, visited, codes, nc, x, y);
                h = mix(h, (nc - start) as u32);
            }
        }
    }
    mix(h, nc as u32)
}

fn run_kernel(bmp: &[u8], visited: &mut [u8], codes: &mut [u8]) -> u32 {
    let mut h: u32 = 0;
    for _ in 0..N_ITERS {
        h = mix(h, trace_all(bmp, visited, codes));
    }
    h
}

fn main() {
    let mut bmp = vec![0u8; (W * H) as usize];
    let mut visited = vec![0u8; (W * H) as usize];
    let mut codes = vec![0u8; MAXCODES];
    build_bitmap(&mut bmp);

    let mut acc: u32 = 0;
    for _ in 0..N_WARMUP {
        acc = mix(acc, run_kernel(&bmp, &mut visited, &mut codes));
    }

    let mut samples = [0.0f64; N_RUNS];
    for s in &mut samples {
        let t0 = Instant::now();
        acc = mix(acc, run_kernel(&bmp, &mut visited, &mut codes));
        *s = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let mut h: u32 = 0x811c_9dc5;
    h = mix(h, acc);
    let mut i = 0usize;
    while i < MAXCODES {
        h = mix(h, codes[i] as u32);
        i += 64;
    }

    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples),
        h,
        (W * H) as usize * N_ITERS,
        1,
        N_RUNS
    );
}
