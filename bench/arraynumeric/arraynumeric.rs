// arraynumeric.rs – a plain array that stays numeric: a quarter million
// integers pushed one by one, then 25 passes that add 1 to every slot, ported
// from arraynumeric.js (Perry's bench_numeric_array_numeric.ts,
// https://github.com/PerryTS/perry, benchmarks/suite, MIT).
//
// The JS array of numbers is a Vec<f64> grown by push; each run builds one and
// drops it, as the JS drops its array.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over every run's result
// and every slot of one more run's array, as the JS folds them.
use std::time::Instant;

const SIZE: usize = 250000;
const ITERATIONS: usize = 25;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 3;

fn mix(h: u32, x: u32) -> u32 {
    (h ^ x).wrapping_mul(0x0100_0193)
}

// x | 0 for the integers these sums hold
fn i32(x: f64) -> u32 {
    x as i32 as u32
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

fn build_numeric_array() -> Vec<f64> {
    let mut arr = Vec::new();
    for i in 0..SIZE {
        arr.push(i as f64);
    }
    arr
}

fn mutate_numeric_array(arr: &mut Vec<f64>) -> f64 {
    let mut checksum = 0.0;

    for _ in 0..ITERATIONS {
        for i in 0..arr.len() {
            arr[i] = arr[i] + 1.0;
        }
        checksum = checksum + arr[0] + arr[arr.len() - 1];
    }

    checksum + arr.len() as f64
}

fn run_numeric_array() -> f64 {
    mutate_numeric_array(&mut build_numeric_array())
}

fn main() {
    for _ in 0..N_WARMUP {
        run_numeric_array();
    }

    let mut h: u32 = 0x811c_9dc5;
    let mut samples = [0.0f64; N_RUNS];
    for s in samples.iter_mut() {
        let t0 = Instant::now();
        let cs = run_numeric_array();
        *s = t0.elapsed().as_secs_f64() * 1000.0;
        h = mix(h, i32(cs));
    }

    let mut arr = build_numeric_array();
    h = mix(h, i32(mutate_numeric_array(&mut arr)));
    for &v in &arr {
        h = mix(h, i32(v));
    }
    println!("median_us={} checksum={} samples={} stages={} runs={}", median_us(&mut samples), h, SIZE, 2, N_RUNS);
}
