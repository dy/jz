// lz.goose: Goose port of lz.js (same input, format, passes and checksum):
// LZSS compress and inflate round trip, a greedy nearest-first longest-match
// search over a sliding window.

import bench from "../_lib";

let N = 4096;               // input bytes
let WINDOW = 1024;          // max match distance (distance - 1 fits 10 of 12 bits)
let MIN_MATCH = 3;
let MAX_MATCH = 18;         // length - MIN_MATCH fits 4 bits (0..15)
let CAP = N * 2 + 64;       // compressed buffer headroom (incompressible worst case)
let N_ITERS = 5;            // compress + inflate passes per kernel run
let N_RUNS = 21;
let N_WARMUP = 5;

fn init_buf(buf: u8[:]) {
    var x: u32 = 0x12345678;
    for i in N {
        x = x * 1103515245 + 12345;
        if i > 64 && x & 0x70 == 0 { buf[i] = buf[i - 1 - ((x >> 8) & 63)]; }
        else { buf[i] = ((x >> 16) & 0xff) as! u8; }
    }
}

fn compress(src: u8[:], n: i64, out: u8[:]) -> i64 {
    var op = 0;
    var ip = 0;
    while ip < n {
        let ctrl_pos = op;
        op++;
        var ctrl: u8 = 0;
        var b = 0;
        while b < 8 && ip < n {
            var start = ip - WINDOW;
            if start < 0 { start = 0; }
            var max_len = n - ip;
            if max_len > MAX_MATCH { max_len = MAX_MATCH; }
            var best_len = 0;
            var best_dist = 0;
            // Scan nearest first (j descending) so the first match of a given
            // length wins, the smallest distance: ties are deterministic.
            var j = ip - 1;
            while j >= start {
                var len = 0;
                while len < max_len && src[j + len] == src[ip + len] { len++; }
                if len > best_len {
                    best_len = len;
                    best_dist = ip - j;
                    if len >= max_len { break; }
                }
                j--;
            }
            if best_len >= MIN_MATCH {
                ctrl |= 1 << b;
                let code = ((best_dist - 1) << 4) | (best_len - MIN_MATCH);
                out[op] = ((code >> 8) & 0xff) as! u8;
                out[op + 1] = (code & 0xff) as! u8;
                op += 2;
                ip += best_len;
            } else {
                out[op] = src[ip];
                op++;
                ip++;
            }
            b++;
        }
        out[ctrl_pos] = ctrl;
    }
    return op;
}

fn inflate(inp: u8[:], clen: i64, dst: u8[:]) -> i64 {
    var ip = 0;
    var op = 0;
    while ip < clen {
        let ctrl = inp[ip];
        ip++;
        var b = 0;
        while b < 8 && ip < clen {
            if ctrl & (1 << b) != 0 {
                let code = inp[ip] as i64 << 8 | inp[ip + 1];
                ip += 2;
                let dist = (code >> 4) + 1;
                let len = (code & 0x0f) + MIN_MATCH;
                for k in len {
                    dst[op] = dst[op - dist];       // byte by byte so overlapping (run) matches work
                    op++;
                }
            } else {
                dst[op] = inp[ip];
                op++;
                ip++;
            }
            b++;
        }
    }
    return op;
}

fn run_kernel(src: u8[:], comp: u8[:], dec: u8[:]) -> u32 {
    var h: u32 = 0;
    for it in N_ITERS {
        let clen = compress(src, N, comp);
        let dlen = inflate(comp, clen, dec);
        var ok: u32 = if dlen == N { 1 } else { 0 };
        for i in N { if dec[i] != src[i] { ok = 0; } }
        h = mix(h, clen as! u32);
        for i in clen { h = mix(h, comp[i]); }
        h = mix(h, ok);
        let j = it % N;
        src[j] += 1;                // perturb so the compress can't be hoisted out of the loop
    }
    return h;
}

fn main() {
    var src: u8[>..] = [];
    var comp: u8[>..] = [];
    var dec: u8[>..] = [];
    src.resize(N, 0);
    comp.resize(CAP, 0);
    dec.resize(N, 0);
    init_buf(src);
    var cs: u32 = 0;
    for i in N_WARMUP { cs = run_kernel(src, comp, dec); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        let t0 = now_ms();
        cs = run_kernel(src, comp, dec);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), cs, N * N_ITERS, 1, N_RUNS);
}
