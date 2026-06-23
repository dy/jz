// radixsort.rs — least-significant-digit radix sort (4 × 8-bit counting passes)
// over a u32 key array. The canonical non-comparison integer sort (databases,
// GPU/CPU key sorting, particle binning): histogram → prefix-sum → scatter,
// ping-ponging between two buffers. Its gather/scatter memory pattern is distinct
// from the suite's compare-swap heapsort, and it is pure 32-bit integer
// throughout, so the sorted output is bit-identical across every engine and
// native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Uint32Array/Int32Array, no
// class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in keys/µs, FNV-1a checksum over
// the sorted key array.
use std::time::Instant;

const N: usize = 1 << 14;      // 16384 keys
const RADIX: usize = 256;      // 8-bit digit
const PASSES: usize = 4;       // 32-bit keys / 8-bit digits
const N_ITERS: usize = 40;     // sorts per kernel run
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

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

fn checksum_u32(out: &[u32]) -> u32 {
    let stride = 128usize;
    let mut h = 0x811c9dc5u32;
    let mut i = 0;
    while i < out.len() {
        h = (h ^ out[i]).wrapping_mul(0x0100_0193);
        i += stride;
    }
    h
}

fn fill(out: &mut [u32]) {
    let mut s = 0x1234abcdu32;
    for i in 0..N {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        out[i] = s;
    }
}

fn radix_sort(src: &mut Vec<u32>, tmp: &mut Vec<u32>, count: &mut [i32]) {
    // We use indices to track which buffer is a/b
    // a starts as src, b starts as tmp; ping-pong via swap
    for pass in 0..PASSES {
        let shift = pass * 8;
        // zero count
        for i in 0..RADIX { count[i] = 0; }
        // histogram
        for i in 0..N { count[((src[i] >> shift) & 0xff) as usize] += 1; }
        // prefix sum
        let mut sum = 0i32;
        for i in 0..RADIX {
            let c = count[i];
            count[i] = sum;
            sum += c;
        }
        // scatter
        for i in 0..N {
            let d = ((src[i] >> shift) & 0xff) as usize;
            tmp[count[d] as usize] = src[i];
            count[d] += 1;
        }
        // ping-pong
        std::mem::swap(src, tmp);
    }
}

fn run_kernel(a: &mut Vec<u32>, base: &[u32], tmp: &mut Vec<u32>, count: &mut [i32]) {
    for it in 0..N_ITERS {
        for i in 0..N {
            a[i] = base[i].wrapping_add(it as u32);
        }
        radix_sort(a, tmp, count);
    }
}

fn main() {
    let mut base = vec![0u32; N];
    let mut a = vec![0u32; N];
    let mut tmp = vec![0u32; N];
    let mut count = vec![0i32; RADIX];

    fill(&mut base);

    for _ in 0..N_WARMUP {
        run_kernel(&mut a, &base, &mut tmp, &mut count);
    }

    let mut samples = [0.0f64; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        run_kernel(&mut a, &base, &mut tmp, &mut count);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let cs = checksum_u32(&a);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples), cs, N * N_ITERS, PASSES, N_RUNS
    );
}
