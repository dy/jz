// base64.goose: Goose port of base64.js (same buffer, tables, passes and
// checksum): Base64 encode then decode, table-driven 3 -> 4 byte packing.
// The tables are fixed u8[64] and u8[256] arrays.

import bench from "../_lib";

let N = 24576;              // input bytes (3 * 8192: clean 3 -> 4 packing, no padding)
let ENC_LEN = N / 3 * 4;    // encoded length
let N_ITERS = 64;           // encode + decode passes per kernel run
let N_RUNS = 21;
let N_WARMUP = 5;

// Standard Base64 alphabet (A-Z a-z 0-9 + /) as char codes.
fn build_enc(enc: u8[64]&) {
    var i = 0;
    for c: u8 in 65..91 { enc[i] = c; i++; }    // A-Z
    for c: u8 in 97..123 { enc[i] = c; i++; }   // a-z
    for c: u8 in 48..58 { enc[i] = c; i++; }    // 0-9
    enc[i] = 43; i++;                           // +
    enc[i] = 47;                                // /
}

fn build_dec(enc: u8[64]&, dec: u8[256]&) {
    for i in 256 { dec[i] = 0; }
    for i: u8 in 0..64 { dec[enc[i]] = i; }
}

fn init_buf(buf: u8[:]) {
    var x: u32 = 0x12345678;
    for &b in buf {
        x = x * 1103515245 + 12345;
        b = ((x >> 16) & 0xff) as! u8;
    }
}

fn encode(src: u8[:], n: i64, enc: u8[64]&, out: u8[:]) -> i64 {
    var op = 0;
    var i = 0;
    while i + 3 <= n {
        let a = src[i];
        let b = src[i + 1];
        let c = src[i + 2];
        out[op] = enc[a >> 2];
        out[op + 1] = enc[((a & 3) << 4) | (b >> 4)];
        out[op + 2] = enc[((b & 15) << 2) | (c >> 6)];
        out[op + 3] = enc[c & 63];
        op += 4;
        i += 3;
    }
    return op;
}

fn decode(src: u8[:], n: i64, dec: u8[256]&, out: u8[:]) -> i64 {
    var op = 0;
    var i = 0;
    while i + 4 <= n {
        let a = dec[src[i]];
        let b = dec[src[i + 1]];
        let c = dec[src[i + 2]];
        let d = dec[src[i + 3]];
        out[op] = (a << 2) | (b >> 4);
        out[op + 1] = ((b & 15) << 4) | (c >> 2);
        out[op + 2] = ((c & 3) << 6) | d;
        op += 3;
        i += 4;
    }
    return op;
}

fn run_kernel(src: u8[:], enc: u8[64]&, dec: u8[256]&, b64: u8[:], back: u8[:]) -> u32 {
    var h: u32 = 0;
    for it in N_ITERS {
        encode(src, N, enc, b64);
        decode(b64, ENC_LEN, dec, back);
        var ok: u32 = 1;
        for i in N { if back[i] != src[i] { ok = 0; } }
        h = mix(mix(h, checksum_u8(b64)), ok);
        let j = it % N;
        src[j] += 1;                    // perturb so the codec can't be hoisted out of the loop
    }
    return h;
}

fn main() {
    var src: u8[>..] = [];
    var b64: u8[>..] = [];
    var back: u8[>..] = [];
    src.resize(N, 0);
    b64.resize(ENC_LEN, 0);
    back.resize(N, 0);
    var enc: u8[64] = [0; 64];
    var dec: u8[256] = [0; 256];
    build_enc(enc);
    build_dec(enc, dec);
    init_buf(src);
    var cs: u32 = 0;
    for i in N_WARMUP { cs = run_kernel(src, enc, dec, b64, back); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        let t0 = now_ms();
        cs = run_kernel(src, enc, dec, b64, back);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), cs, N * N_ITERS, 1, N_RUNS);
}
