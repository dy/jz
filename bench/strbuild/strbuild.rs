// strbuild.rs — per-record string formatting: render each integer record as a
// CSV-ish line (`id,name,value\n`), fold its chars, discard. The canonical
// serialization inner loop (loggers, exporters, code generators, row writers).
// Rust formats a fresh String per row with format! — the idiomatic mirror of
// the JS per-row string temporaries. Pure ASCII and integer data, so the
// folded chars are bit-identical across every engine and native target.
//
// Reports: median ms across N_RUNS, throughput in rows/µs, FNV-1a checksum
// over every formatted line's characters.
use std::time::Instant;

const N: usize = 4096;           // rows per pass
const N_ITERS: usize = 4;        // passes per kernel run
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

const NAMES: [&str; 16] = ["alpha", "bravo", "carol", "delta", "echo", "fox", "golf", "hotel",
    "india", "jazz", "kilo", "lima", "mike", "nova", "oscar", "papa"];

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

// Deterministic row stream — XorShift32, identical per target; low bits pick
// the name, the rest is the (signed) value column.
fn fill(code: &mut [i32], vals: &mut [i32]) {
    let mut s: i32 = 0x1234abcd_u32 as i32;
    for i in 0..N {
        s ^= s << 13;
        s ^= ((s as u32) >> 17) as i32; // >>> 17 (unsigned right shift)
        s ^= s << 5;
        code[i] = s & 15;
        vals[i] = s >> 4;
    }
}

fn run_kernel(code: &[i32], vals: &[i32]) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for it in 0..N_ITERS {
        for i in 0..N {
            let line = format!("{},{},{}\n", i, NAMES[code[i] as usize], vals[i].wrapping_add(it as i32));
            for b in line.bytes() {
                h = mix(h, b as u32);
            }
        }
    }
    h
}

fn main() {
    let mut code = vec![0i32; N];
    let mut vals = vec![0i32; N];
    fill(&mut code, &mut vals);

    let mut cs = 0u32;
    for _ in 0..N_WARMUP {
        cs = run_kernel(&code, &vals);
    }

    let mut samples = [0.0f64; N_RUNS];
    for s in &mut samples {
        let t0 = Instant::now();
        cs = run_kernel(&code, &vals);
        *s = t0.elapsed().as_secs_f64() * 1000.0;
    }

    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples),
        cs,
        N * N_ITERS,
        3,
        N_RUNS
    );
}
