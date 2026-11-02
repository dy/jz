// hash.goose: Goose port of hash.js (same buffer, seed, passes and checksum):
// MurmurHash3 x86_32 over a byte buffer, body only (N is a multiple of 4).

import bench from "../_lib";

let N = 16384;              // buffer length in bytes (multiple of 4: no murmur tail)
let N_ITERS = 700;          // hash passes over the whole buffer per kernel run
let N_RUNS = 21;
let N_WARMUP = 5;

let C1: u32 = 0xcc9e2d51;
let C2: u32 = 0x1b873593;

fn init_buf(buf: u8[:]) {
    var x: u32 = 0x12345678;
    for &b in buf {
        x = x * 1103515245 + 12345;
        b = ((x >> 16) & 0xff) as! u8;
    }
}

fn murmur3(buf: u8[:], n: i64, seed: u32) -> u32 {
    var h = seed;
    var i = 0;
    while i + 4 <= n {
        var k: u32 = buf[i] | buf[i + 1] as u32 << 8 | buf[i + 2] as u32 << 16 | buf[i + 3] as u32 << 24;
        k = k * C1;
        k = (k << 15) | (k >> 17);
        k = k * C2;
        h ^= k;
        h = (h << 13) | (h >> 19);
        h = h * 5 + 0xe6546b64;
        i += 4;
    }
    h ^= n as u32;
    h ^= h >> 16;
    h = h * 0x85ebca6b;
    h ^= h >> 13;
    h = h * 0xc2b2ae35;
    h ^= h >> 16;
    return h;
}

fn run_kernel(buf: u8[:]) -> u32 {
    var h: u32 = 0;
    for it in N_ITERS {
        h = mix(h, murmur3(buf, N, 0x9747b28c));
        let j = it % N;
        buf[j] += 1;          // perturb so the hash can't be hoisted out of the loop
    }
    return h;
}

fn main() {
    var buf: u8[>..] = [];
    buf.resize(N, 0);
    init_buf(buf);
    var cs: u32 = 0;
    for i in N_WARMUP { cs = run_kernel(buf); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        let t0 = now_ms();
        cs = run_kernel(buf);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), cs, N * N_ITERS, 1, N_RUNS);
}
