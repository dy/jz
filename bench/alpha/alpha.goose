// alpha.goose: Goose port of alpha.js (same images, opacity and checksum):
// constant-alpha blend of two RGBA8 images, a u32 multiply-add per byte.

import bench from "../_lib";

let W = 512;
let H = 512;
let N = W * H * 4;          // RGBA8
let A = 160;                // source opacity, 0..255
let IA = 255 - A;           // dest weight
let N_RUNS = 21;
let N_WARMUP = 5;

fn mk_image(n: i64, seed: u32) -> u8[>..] {
    var out: u8[>..] = [];
    var s = seed;
    for i in n {
        s ^= s << 13; s ^= s >> 17; s ^= s << 5;
        out.push((s & 255) as! u8);
    }
    return out;
}

fn blend(src: u8[:], dst: u8[:], out: u8[:], n: i64) {
    for i in n { out[i] = ((src[i] as u32 * A + dst[i] as u32 * IA + 127) >> 8) as! u8; }
}

fn main() {
    let src = mk_image(N, 0x1234abcd);
    let dst = mk_image(N, 0x7e1f93b5);
    var out: u8[>..] = [];
    out.resize(N, 0);
    for i in N_WARMUP { blend(src, dst, out, N); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        let t0 = now_ms();
        blend(src, dst, out, N);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_u8(out), N, 1, N_RUNS);
}
