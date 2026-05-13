use std::time::Instant;

const N: usize = 8192;
const N_ITERS: usize = 24;
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
    let mut h = 0x811c_9dc5u32;
    for i in (0..xs.len() * 2).step_by(256) {
        let bits = xs[i >> 1].to_bits();
        let x = if i & 1 == 0 { bits as u32 } else { (bits >> 32) as u32 };
        h = mix(h, x);
    }
    h
}

fn fill(xs: &mut [f64]) {
    let mut s = 0x9e37_79b9u32;
    for x in xs {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        *x = s as f64 / 4294967296.0;
    }
}

fn heapsort(a: &mut [f64]) {
    let n = a.len();
    for root in (0..(n >> 1)).rev() {
        let mut i = root;
        let mut child = 2 * i + 1;
        while child < n {
            if child + 1 < n && a[child] < a[child + 1] { child += 1; }
            if a[i] >= a[child] { break; }
            a.swap(i, child);
            i = child;
            child = 2 * i + 1;
        }
    }
    for end in (1..n).rev() {
        a.swap(0, end);
        let mut i = 0;
        let mut child = 1;
        while child < end {
            if child + 1 < end && a[child] < a[child + 1] { child += 1; }
            if a[i] >= a[child] { break; }
            a.swap(i, child);
            i = child;
            child = 2 * i + 1;
        }
    }
}

fn run_kernel(a: &mut [f64], src: &[f64]) {
    for it in 0..N_ITERS {
        let f = it as f64;
        for i in 0..a.len() {
            a[i] = src[i] + f;
        }
        heapsort(a);
    }
}

fn main() {
    let mut src = vec![0.0; N];
    let mut a = vec![0.0; N];
    fill(&mut src);
    for _ in 0..N_WARMUP {
        run_kernel(&mut a, &src);
    }
    let mut samples = [0.0; N_RUNS];
    for s in &mut samples {
        let t0 = Instant::now();
        run_kernel(&mut a, &src);
        *s = t0.elapsed().as_secs_f64() * 1000.0;
    }
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples),
        checksum_f64(&a),
        N * N_ITERS,
        2,
        N_RUNS
    );
}
