// radixsort.goose: Goose port of radixsort.js (same keys, passes and
// checksum): LSD radix sort, four stable counting-sort passes over 8-bit
// digits, ping-ponging between two buffers. The views swap, not the data.

import bench from "../_lib";

let N = 1 << 14;            // 16384 keys
let RADIX = 256;            // 8-bit digit
let PASSES = 4;             // 32-bit keys / 8-bit digits
let N_ITERS = 40;           // sorts per kernel run
let N_RUNS = 21;
let N_WARMUP = 5;

// Deterministic u32 keys: XorShift32, identical per target.
fn fill(out: u32[:]) {
    var s: u32 = 0x1234abcd;
    for &k in out {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        k = s;
    }
}

// PASSES is even, so the sorted result lands back in `src`.
fn radix_sort(src: u32[:], tmp: u32[:], count: i32[RADIX]&) {
    var a = src;
    var b = tmp;
    var shift = 0;
    while shift < 32 {
        for &c in count { c = 0; }
        for k in a { count[(k >> shift) & 0xff]++; }
        var sum: i32 = 0;
        for &c in count {
            let n = c;
            c = sum;
            sum += n;
        }
        for k in a {
            let d = (k >> shift) & 0xff;
            b[count[d]] = k;
            count[d]++;
        }
        let t = a;
        a = b;
        b = t;
        shift += 8;
    }
}

fn run_kernel(a: u32[:], base: u32[:], tmp: u32[:], count: i32[RADIX]&) {
    for it in N_ITERS {
        for i in N { a[i] = base[i] + it as u32; }
        radix_sort(a, tmp, count);
    }
}

fn main() {
    var base: u32[>..] = [];
    var a: u32[>..] = [];
    var tmp: u32[>..] = [];
    base.resize(N, 0);
    a.resize(N, 0);
    tmp.resize(N, 0);
    var count: i32[RADIX] = [0; RADIX];
    fill(base);
    for i in N_WARMUP { run_kernel(a, base, tmp, count); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        let t0 = now_ms();
        run_kernel(a, base, tmp, count);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_u32(a), N * N_ITERS, PASSES, N_RUNS);
}
