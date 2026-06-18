// matmul.rs — dense matrix multiply C = A·Bᵀ, the kernel every linear-algebra and
// neural-net library lives on. B is stored transposed (Bt[j][k] = B[k][j]) so the
// inner k-loop reads row i of A and row j of Bᵀ contiguously — each output C[i][j]
// is a dot product, which jz lifts to multi-accumulator f64x2 SIMD (the dotprod
// shape, in a 2-D loop). Small-integer data keeps every product-sum exact in f64,
// so the result is bit-identical across every engine and native target.
use std::time::Instant;

const N: usize = 256;
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
    let mut h: u32 = 0x811c_9dc5;
    let n = xs.len();
    // for i in (0..n*2).step_by(256): read u32 at byte offset i*4
    let mut i: usize = 0;
    while i < n * 2 {
        let byte_offset = i * 4;
        let x = unsafe {
            let ptr = (xs.as_ptr() as *const u8).add(byte_offset);
            u32::from_le_bytes([*ptr, *ptr.add(1), *ptr.add(2), *ptr.add(3)])
        };
        h = mix(h, x);
        i += 256;
    }
    h
}

fn init(a: &mut [f64], bt: &mut [f64]) {
    for i in 0..N * N {
        a[i] = (i % 13) as f64 - 6.0;
        bt[i] = ((i * 7) % 11) as f64 - 5.0;
    }
}

fn matmul(a: &[f64], bt: &[f64], c: &mut [f64]) {
    for i in 0..N {
        let ai = i * N;
        for j in 0..N {
            let bj = j * N;
            let mut s = 0.0f64;
            for k in 0..N {
                s += a[ai + k] * bt[bj + k];
            }
            c[ai + j] = s;
        }
    }
}

fn main() {
    let mut a = vec![0.0f64; N * N];
    let mut bt = vec![0.0f64; N * N];
    let mut c = vec![0.0f64; N * N];
    init(&mut a, &mut bt);
    for _ in 0..N_WARMUP {
        matmul(&a, &bt, &mut c);
    }

    let mut samples = [0.0f64; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        matmul(&a, &bt, &mut c);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let cs = checksum_f64(&c);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples), cs, N * N * N, 2, N_RUNS
    );
}
